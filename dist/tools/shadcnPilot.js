import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { NdjsonParser } from "../exec/streamParser.js";
import { writeMcpConfig, McpConfigError } from "../providers/claudeCodeMcpAdapter.js";
import { redactSecrets, collectSecretValues } from "./redact.js";
/**
 * [V3 M3c-0] shadcn MCP **discovery-only** 기반 (offline hardening).
 *
 * 목적: 실제 shadcn MCP 도구명(browse/search/…)을 아직 **모르는** 상태에서, headless
 * `claude -p` + `system/init` 스냅샷으로 **도구명을 발견**하는 별도 경로만 제공한다.
 *
 * 경계(이 모듈이 하지 않는 것):
 *  - registry/tool_profiles.json에 shadcn profile을 등록하지 않는다.
 *  - browse/search/install/add 등 expected 도구를 코드에 넣지 않는다(발견 대상이므로).
 *  - interactive handoff에 연결하지 않는다. MCP 도구를 실제 호출하지 않는다.
 *  - runPreflight의 exact-profile 검증을 완화하지 않는다 — **별도 API**로 분리한다.
 *
 * 보안 경계는 **핵심 API(runShadcnDiscovery)** 안에 있다(runner의 사전 검사는 보조):
 *  - 표준 registry 검사를 config/spawn보다 먼저 강제(custom/private/malformed/symlink/oversized면 spawn·산출물 없음).
 *  - package는 무조건 SHADCN_PACKAGE(다른 package 주입 불가).
 *  - 빈 도구 discovery(no_tools) 거부. 성공은 1~64개.
 *  - 모든 오류·성공 반환/저장 문자열을 scrub(redactNames scrub 전용, child env 미전달).
 */
export const SHADCN_PACKAGE = "shadcn@4.13.1"; // 고정 pin (@latest/무버전/범위는 기존 규칙대로 거부)
export const SHADCN_SERVER = "shadcn";
// discovery 제한.
export const MAX_DISCOVERY_TOOLS = 64;
export const MAX_TOOL_NAME_BYTES = 256;
export const MAX_DISCOVERY_SNAPSHOT_BYTES = 64 * 1024;
const MAX_COMPONENTS_JSON_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024; // 1MiB — 무개행 stdout으로 파서 buffer 무한 증가 방지
const MAX_STDERR_BYTES = 64 * 1024; // 64KiB — stderr 무제한 누적 방지
const DEFAULT_TIMEOUT_MS = 60_000;
// preflight와 동일한 최소 안전 env allowlist(별도 유지 — discovery는 secretRefs가 비어 있다).
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];
// testEnv가 덮어쓸 수 없는 강제 env(격리 보장).
const FORCED_ENV = {
    MCP_CONNECTION_NONBLOCKING: "0",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};
// ── 1) shadcn 파일럿 정책 (in-code, registry 미등록, package 고정) ────────────
/**
 * discovery용 shadcn ToolProfile. tools는 **빈 배열**(발견 대상이라 expected 없음).
 * server 실행 선언 = `npx --yes shadcn@4.13.1 mcp`. package는 **항상 SHADCN_PACKAGE**(우회 인자 없음).
 * pin 검증은 buildMcpConfig(compileServer)가 강제한다.
 */
export function shadcnDiscoveryProfile() {
    return {
        id: "shadcn-discovery",
        capabilities: ["component_registry_read"],
        bindings: { component_registry_read: { kind: "mcp", server: SHADCN_SERVER, tools: [] } },
        servers: [{ name: SHADCN_SERVER, command: "npx", args: ["--yes", SHADCN_PACKAGE, "mcp"] }],
        preapprovedTools: [],
        deniedTools: [],
        permissionMode: "read_only",
        allowedDomains: [],
        limits: { maxCallsPerStep: 0, maxResultChars: 0, maxElapsedMsPerCall: 0 },
        secretRefs: [],
    };
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/**
 * serviceCwd/components.json이 표준(shadcn) registry만 쓰는지 검사한다 (TOCTOU 방지).
 * O_NOFOLLOW로 fd를 열고 **같은 fd**로 fstat/read 한다(경로 재오픈 없음, symlink 미추적).
 *  - 없음(ENOENT): 표준 registry 사용 → ok
 *  - registries 없음 또는 빈 plain object: ok
 *  - registries에 항목 있음(또는 plain object 아님): custom_registry_forbidden
 *  - malformed JSON, root 비객체(배열 포함), symlink(ELOOP)·일반 파일 아님, 64KiB 초과: fail-closed
 *
 * 오류에 파일 내용·credential 값을 담지 않는다(코드만). .env·환경 secret은 읽지 않는다.
 * 읽는 동안 파일이 커져도 64KiB+1 byte를 넘겨 읽지 않는다.
 */
export function checkComponentsJson(serviceCwd) {
    const p = join(serviceCwd, "components.json");
    let fd;
    try {
        fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (e) {
        const code = e.code;
        if (code === "ENOENT")
            return { ok: true }; // 파일 없음 → 허용
        if (code === "ELOOP")
            return { ok: false, code: "not_regular_file" }; // symlink (O_NOFOLLOW 거부)
        return { ok: false, code: "read_error" };
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile())
            return { ok: false, code: "not_regular_file" };
        if (st.size > MAX_COMPONENTS_JSON_BYTES)
            return { ok: false, code: "too_large" };
        const cap = MAX_COMPONENTS_JSON_BYTES + 1; // 상한 초과 감지용 1 byte 여유
        const buf = Buffer.allocUnsafe(cap);
        let total = 0;
        while (total < cap) {
            const n = readSync(fd, buf, total, cap - total, total);
            if (n === 0)
                break;
            total += n;
        }
        if (total > MAX_COMPONENTS_JSON_BYTES)
            return { ok: false, code: "too_large" };
        let parsed;
        try {
            parsed = JSON.parse(buf.subarray(0, total).toString("utf8"));
        }
        catch {
            return { ok: false, code: "malformed" };
        }
        if (!isPlainObject(parsed))
            return { ok: false, code: "malformed" }; // 배열/비객체 root
        const reg = parsed.registries;
        if (reg === undefined)
            return { ok: true };
        if (isPlainObject(reg) && Object.keys(reg).length === 0)
            return { ok: true };
        return { ok: false, code: "custom_registry_forbidden" };
    }
    catch {
        return { ok: false, code: "read_error" };
    }
    finally {
        try {
            closeSync(fd);
        }
        catch {
            /* best-effort */
        }
    }
}
// ── 3) 전용 MCP discovery (runPreflight와 분리) ───────────────────────────────
/** discovery 실패(typed). code는 보존, message는 항상 scrub된 상태로만 만든다. */
export class ShadcnDiscoveryError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ShadcnDiscoveryError";
        this.code = code;
    }
}
function buildChildEnv(testEnv) {
    const env = {};
    for (const k of ENV_ALLOWLIST) {
        const v = process.env[k];
        if (v !== undefined)
            env[k] = v;
    }
    if (testEnv)
        for (const [k, v] of Object.entries(testEnv))
            env[k] = v;
    // 강제 env는 **마지막에** 병합 — testEnv/allowlist가 격리 변수를 덮어쓸 수 없다.
    for (const [k, v] of Object.entries(FORCED_ENV))
        env[k] = v;
    return env;
}
/** init.mcpServers가 정확히 [shadcn]이고 connected인지 검증(중복 서버 거부). */
function verifyServers(init) {
    const byName = new Map();
    for (const s of init.mcpServers) {
        if (byName.has(s.name))
            throw new ShadcnDiscoveryError("duplicate_server", `중복 서버: '${s.name}'`);
        byName.set(s.name, s);
    }
    const actual = [...byName.keys()].sort();
    if (JSON.stringify(actual) !== JSON.stringify([SHADCN_SERVER])) {
        throw new ShadcnDiscoveryError("server_mismatch", `서버 목록이 [${SHADCN_SERVER}] 아님 — 실제: [${actual.join(", ")}]`);
    }
    const s = byName.get(SHADCN_SERVER);
    if (!s.connected)
        throw new ShadcnDiscoveryError("server_not_connected", `shadcn 서버 미연결 (status=${s.status})`);
    return s.status;
}
/** init.tools에서 mcp__shadcn__* 도구를 수집·검증한다. 다른 prefix/중복/빈이름/과대/과다/0개 거부. */
function collectShadcnTools(tools) {
    const prefix = `mcp__${SHADCN_SERVER}__`;
    const seen = new Set();
    const out = [];
    for (const t of tools) {
        if (!t.startsWith("mcp__"))
            continue; // 내장/비-MCP 도구는 무시
        if (!t.startsWith(prefix))
            throw new ShadcnDiscoveryError("foreign_tool", "shadcn 외 서버 prefix의 MCP 도구가 노출됨");
        if (t.length === prefix.length)
            throw new ShadcnDiscoveryError("empty_tool", "빈 도구명(prefix만)");
        if (Buffer.byteLength(t, "utf8") > MAX_TOOL_NAME_BYTES)
            throw new ShadcnDiscoveryError("tool_name_too_long", `도구명이 ${MAX_TOOL_NAME_BYTES} byte 초과`);
        if (seen.has(t))
            throw new ShadcnDiscoveryError("duplicate_tool", `중복 도구 감지`);
        seen.add(t);
        out.push(t);
    }
    if (out.length === 0)
        throw new ShadcnDiscoveryError("no_tools", "shadcn MCP 도구가 0개 — discovery 실패");
    if (out.length > MAX_DISCOVERY_TOOLS)
        throw new ShadcnDiscoveryError("too_many_tools", `MCP 도구 수가 ${MAX_DISCOVERY_TOOLS} 초과`);
    return out.sort();
}
/**
 * shadcn MCP discovery를 1회 실행한다. 표준 registry 검사 → 단일 shadcn strict config →
 * headless `claude -p --output-format stream-json`으로 system/init 도구명 수집.
 * 검증 실패 시 성공 결과·산출물 없이 typed·scrub된 ShadcnDiscoveryError로 fail-closed.
 */
export async function runShadcnDiscovery(opts) {
    const { serviceCwd, runtimeDir, now } = opts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const secretValues = collectSecretValues(opts.redactNames ?? []); // scrub 전용 (child 미전달)
    const scrub = (s) => redactSecrets(s, secretValues);
    // typed error를 code 보존 + message scrub으로 정규화 (전 경로 공통).
    const norm = (code, message) => new ShadcnDiscoveryError(code, scrub(message));
    const renorm = (e, fallback) => e instanceof ShadcnDiscoveryError ? new ShadcnDiscoveryError(e.code, scrub(e.message)) : norm(fallback, e?.message ?? String(e));
    // 0) 표준 registry 검사 — config/spawn/산출물보다 **먼저**. 실패 시 spawn·runtimeDir·config·snapshot 없음.
    const reg = checkComponentsJson(serviceCwd);
    if (!reg.ok)
        throw norm(`registry_${reg.code}`, `components.json 표준 registry 검사 실패 (${reg.code})`);
    // 1) 단일 shadcn 서버 strict config 생성(pin/transport/secret/credential은 buildMcpConfig가 강제).
    let configHash;
    try {
        const written = writeMcpConfig(shadcnDiscoveryProfile(), runtimeDir);
        if (JSON.stringify(written.expectedServers) !== JSON.stringify([SHADCN_SERVER])) {
            throw norm("config_server", "discovery config에 shadcn 단일 서버만 있어야 함");
        }
        configHash = written.configHash;
    }
    catch (e) {
        if (e instanceof ShadcnDiscoveryError)
            throw new ShadcnDiscoveryError(e.code, scrub(e.message));
        if (e instanceof McpConfigError)
            throw norm(`config_${e.code}`, e.message);
        throw norm("config", e.message);
    }
    const configPath = join(runtimeDir, "mcp-config.json");
    const bin = opts.claudeBin ?? process.env.HARNESS_CLAUDE_BIN ?? "claude";
    const argv = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--mcp-config",
        configPath,
        "--tools",
        "",
        "--permission-mode",
        "plan",
    ];
    const built = await new Promise((resolveP, reject) => {
        const parser = new NdjsonParser();
        let settled = false;
        let intentionalKill = false;
        let stderr = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const child = spawn(bin, argv, { cwd: serviceCwd, env: buildChildEnv(opts.testEnv), stdio: ["pipe", "pipe", "pipe"] });
        const finishOk = (init) => {
            if (settled)
                return;
            try {
                const status = verifyServers(init);
                const tools = collectShadcnTools(init.tools); // 0개면 no_tools throw
                settled = true;
                clearTimeout(timer);
                intentionalKill = true;
                child.kill("SIGKILL"); // init 수집 완료 → 의도적 종료 (도구 호출 없음)
                resolveP({ status, tools });
            }
            catch (e) {
                settled = true;
                clearTimeout(timer);
                intentionalKill = true;
                child.kill("SIGKILL");
                reject(renorm(e, "verify"));
            }
        };
        const fail = (code, msg) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(norm(code, msg));
        };
        const timer = setTimeout(() => {
            intentionalKill = true;
            child.kill("SIGKILL");
            fail("timeout", `discovery 타임아웃 (${timeoutMs}ms) — system/init 미수신`);
        }, timeoutMs);
        const handle = (events) => {
            for (const e of events)
                if (e.kind === "init")
                    return finishOk(e);
        };
        child.stdout.on("data", (d) => {
            if (settled)
                return;
            const s = d.toString();
            stdoutBytes += Buffer.byteLength(s, "utf8");
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                intentionalKill = true;
                child.kill("SIGKILL");
                return fail("stdout_too_large", `stdout ${MAX_STDOUT_BYTES} byte 초과`);
            }
            handle(parser.push(s));
        });
        child.stderr.on("data", (d) => {
            if (settled)
                return;
            const s = d.toString();
            stderrBytes += Buffer.byteLength(s, "utf8");
            if (stderrBytes > MAX_STDERR_BYTES) {
                intentionalKill = true;
                child.kill("SIGKILL");
                return fail("stderr_too_large", `stderr ${MAX_STDERR_BYTES} byte 초과`);
            }
            stderr += s;
        });
        child.on("error", (e) => fail("spawn", `claude 실행 실패: ${e.message}`));
        child.on("close", (code) => {
            if (settled)
                return; // init 수집 후 의도적 종료는 실패 아님
            handle(parser.flush());
            if (settled)
                return;
            if (code !== 0)
                fail("nonzero_exit", `claude 비정상 종료 (code ${code}): ${stderr.trim() || "(stderr 없음)"}`);
            else
                fail("no_init", `system/init 이벤트 없이 종료 (code ${code})`);
        });
        child.stdin.end("discovery");
        void intentionalKill;
    });
    // 2) discovery snapshot — 외부 문자열도 scrub 후 반환·저장(반환==저장 deepEqual). raw init 미저장.
    const snapshot = {
        mode: "discovery",
        usableForHandoff: false,
        package: scrub(SHADCN_PACKAGE),
        server: scrub(SHADCN_SERVER),
        status: scrub(built.status),
        tools: built.tools.map((t) => scrub(t)),
        configHash,
        timestamp: scrub(now()),
    };
    const serialized = JSON.stringify(snapshot, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_DISCOVERY_SNAPSHOT_BYTES) {
        throw norm("snapshot_too_large", `discovery snapshot이 ${MAX_DISCOVERY_SNAPSHOT_BYTES} byte 초과`);
    }
    const snapshotPath = join(runtimeDir, "mcp-discovery.json");
    try {
        mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
        // exclusive-create(wx): 기존 mcp-discovery.json·symlink를 조용히 덮어쓰지 않는다.
        writeFileSync(snapshotPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    catch (e) {
        throw norm("persist", `discovery snapshot 기록 실패 (기존 파일/symlink?): ${e.message}`);
    }
    return { discovery: true, snapshotPath, snapshot };
}
