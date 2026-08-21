import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { writeMcpConfig, McpConfigError } from "../providers/claudeCodeMcpAdapter.js";
import { redactSecrets, collectSecretValues } from "./redact.js";
import { checkComponentsJson, shadcnDiscoveryProfile, SHADCN_PACKAGE, SHADCN_SERVER } from "./shadcnPilot.js";
/**
 * [V3 M3c-1] shadcn MCP **tools/list schema discovery** (offline scaffold).
 *
 * shadcn 전용의 좁은 stdio JSON-RPC probe. shadcn MCP 서버(`npx --yes shadcn@4.13.1 mcp`)와 직접
 * `initialize → notifications/initialized → tools/list`까지만 대화해 7개 도구의 schema를 수집한다.
 *
 * 경계:
 *  - **tools/call 코드 경로가 없다**(도구 실행 불가가 구조적으로 보장). 결과 operationSummary.toolCalls는 항상 0.
 *  - 범용 MCP client가 아니다. 실행 명령은 **항상** `npx --yes shadcn@4.13.1 mcp`(env override seam 없음).
 *  - profile 등록·registry 변경·handoff 연결·권한 분류를 하지 않는다. annotations는 **untrusted hint**이며
 *    권한 판정 근거로 쓰지 않는다.
 *
 * 산출물 `mcp-schema-discovery.json`(mode:"schema-discovery"·usableForHandoff:false)은 raw JSON-RPC
 * payload가 아니라 추출 schema만 담는다.
 */
// MCP 프로토콜: 요청 버전 + 이전 revision negotiation allowlist. (공식 spec revision 목록.)
export const MCP_PROTOCOL_VERSION = "2025-11-25";
const ALLOWED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
// M3c-0에서 실측 확정된 7개 도구명(host-namespaced, 정렬).
export const EXPECTED_SHADCN_TOOLS = [
    "mcp__shadcn__get_add_command_for_items",
    "mcp__shadcn__get_audit_checklist",
    "mcp__shadcn__get_item_examples_from_registries",
    "mcp__shadcn__get_project_registries",
    "mcp__shadcn__list_items_in_registries",
    "mcp__shadcn__search_items_in_registries",
    "mcp__shadcn__view_items_in_registries",
].sort();
export const MAX_TOOLS = 64;
const MAX_PAGES = 8;
const MAX_SCHEMA_DEPTH = 16;
const MAX_OBJECT_KEYS = 256;
const MAX_STRING_BYTES = 8 * 1024;
const MAX_TOOL_BYTES = 64 * 1024;
export const MAX_SCHEMA_SNAPSHOT_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 2_000; // stdin 종료 후 child close 대기
const KILL_GRACE_MS = 2_000; // SIGKILL 후 close 대기
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"];
// annotations의 알려진 boolean hint 필드(untrusted — 권한 판정 근거 아님).
const ANNOTATION_BOOL_FIELDS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
export class ShadcnSchemaProbeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ShadcnSchemaProbeError";
        this.code = code;
    }
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
/**
 * schema 값의 깊이·객체 키 수·문자열 크기 상한을 재귀 검증하고, **객체 key가 scrub 대상이면**
 * (secret 값/credential 형태 포함) 이름을 변형하지 않고 `secret_in_schema_key`로 fail-closed 한다.
 * 오류 메시지에 원 key 평문을 담지 않는다.
 */
function assertSchemaSafe(v, depth, scrub) {
    if (depth > MAX_SCHEMA_DEPTH)
        throw new ShadcnSchemaProbeError("bad_schema", `schema 깊이 ${MAX_SCHEMA_DEPTH} 초과`);
    if (typeof v === "string") {
        if (Buffer.byteLength(v, "utf8") > MAX_STRING_BYTES)
            throw new ShadcnSchemaProbeError("bad_schema", `schema 문자열 ${MAX_STRING_BYTES} byte 초과`);
        return;
    }
    if (Array.isArray(v)) {
        if (v.length > MAX_OBJECT_KEYS)
            throw new ShadcnSchemaProbeError("bad_schema", `schema 배열 길이 ${MAX_OBJECT_KEYS} 초과`);
        for (const x of v)
            assertSchemaSafe(x, depth + 1, scrub);
        return;
    }
    if (isPlainObject(v)) {
        const keys = Object.keys(v);
        if (keys.length > MAX_OBJECT_KEYS)
            throw new ShadcnSchemaProbeError("bad_schema", `schema 객체 키 수 ${MAX_OBJECT_KEYS} 초과`);
        for (const k of keys) {
            if (Buffer.byteLength(k, "utf8") > MAX_STRING_BYTES)
                throw new ShadcnSchemaProbeError("bad_schema", "schema 키 크기 초과");
            // key는 scrub으로 마스킹할 수 없다(schema 왜곡) → scrub 대상이면 fail-closed(원 key 미노출).
            if (scrub(k) !== k)
                throw new ShadcnSchemaProbeError("secret_in_schema_key", "schema object key가 secret/credential 형태로 감지됨 (key는 표시하지 않음)");
            assertSchemaSafe(v[k], depth + 1, scrub);
        }
    }
}
/** 문자열 leaf를 재귀 scrub(구조·key 보존 — key는 이미 clean 검증됨). */
function deepScrub(v, scrub) {
    if (typeof v === "string")
        return scrub(v);
    if (Array.isArray(v))
        return v.map((x) => deepScrub(x, scrub));
    if (isPlainObject(v)) {
        const out = {};
        for (const [k, val] of Object.entries(v))
            out[k] = deepScrub(val, scrub);
        return out;
    }
    return v;
}
/** root type:"object" 강제 + 상한/키 검증. */
function assertObjectSchema(v, label, scrub) {
    if (!isPlainObject(v))
        throw new ShadcnSchemaProbeError("tool_missing_field", `${label}(객체) 누락`);
    if (v.type !== "object")
        throw new ShadcnSchemaProbeError("bad_schema", `${label} root type이 "object"가 아님`);
    assertSchemaSafe(v, 0, scrub);
    return v;
}
/** tool 객체 하나를 공식 계약대로 검증·추출한다(bare name; raw envelope 아님). */
function extractTool(raw, scrub) {
    if (!isPlainObject(raw))
        throw new ShadcnSchemaProbeError("tool_missing_field", "tool이 객체가 아님");
    const name = raw.name;
    if (typeof name !== "string" || name.length === 0)
        throw new ShadcnSchemaProbeError("tool_missing_field", "tool.name 누락");
    if (Buffer.byteLength(name, "utf8") > MAX_STRING_BYTES)
        throw new ShadcnSchemaProbeError("bad_schema", "tool.name 크기 초과");
    const tool = { name, inputSchema: assertObjectSchema(raw.inputSchema, `tool '${name}': inputSchema`, scrub) };
    if (raw.title !== undefined) {
        if (typeof raw.title !== "string")
            throw new ShadcnSchemaProbeError("bad_schema", `tool '${name}': title이 문자열 아님`);
        tool.title = raw.title;
    }
    if (raw.description !== undefined) {
        if (typeof raw.description !== "string")
            throw new ShadcnSchemaProbeError("bad_schema", `tool '${name}': description이 문자열 아님`);
        tool.description = raw.description;
    }
    if (raw.outputSchema !== undefined) {
        tool.outputSchema = assertObjectSchema(raw.outputSchema, `tool '${name}': outputSchema`, scrub);
    }
    if (raw.annotations !== undefined) {
        if (!isPlainObject(raw.annotations))
            throw new ShadcnSchemaProbeError("bad_schema", `tool '${name}': annotations가 plain object 아님`);
        assertSchemaSafe(raw.annotations, 0, scrub);
        for (const f of ANNOTATION_BOOL_FIELDS) {
            if (raw.annotations[f] !== undefined && typeof raw.annotations[f] !== "boolean") {
                throw new ShadcnSchemaProbeError("bad_schema", `tool '${name}': annotations.${f}가 boolean 아님`);
            }
        }
        if (raw.annotations.title !== undefined && typeof raw.annotations.title !== "string") {
            throw new ShadcnSchemaProbeError("bad_schema", `tool '${name}': annotations.title이 문자열 아님`);
        }
        tool.annotations = raw.annotations; // untrusted hint (권한 판정 근거 아님)
    }
    if (Buffer.byteLength(JSON.stringify(tool), "utf8") > MAX_TOOL_BYTES)
        throw new ShadcnSchemaProbeError("bad_schema", `tool '${name}' 크기 ${MAX_TOOL_BYTES} byte 초과`);
    return tool;
}
export async function runShadcnSchemaProbe(opts) {
    const { serviceCwd, runtimeDir, now } = opts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const secretValues = collectSecretValues(opts.redactNames ?? []); // scrub 전용(child 미전달)
    const scrub = (s) => redactSecrets(s, secretValues);
    const norm = (code, message) => new ShadcnSchemaProbeError(code, scrub(message));
    // 0) 표준 registry 검사 — config/spawn 이전. 실패 시 runtimeDir·config·spawn 없음.
    const reg = checkComponentsJson(serviceCwd);
    if (!reg.ok)
        throw norm(`registry_${reg.code}`, `components.json 표준 registry 검사 실패 (${reg.code})`);
    // 1) 단일 shadcn strict config 생성(pin 강제). command/args는 여기서만 얻는다 — env override seam 없음.
    let configHash;
    let command;
    let args;
    try {
        const written = writeMcpConfig(shadcnDiscoveryProfile(), runtimeDir);
        const entry = written.config.mcpServers[SHADCN_SERVER];
        if (!entry || !("command" in entry))
            throw norm("config_server", "shadcn stdio 서버 엔트리가 없음");
        command = entry.command;
        args = entry.args;
        if (command !== "npx" || JSON.stringify(args) !== JSON.stringify(["--yes", SHADCN_PACKAGE, "mcp"])) {
            throw norm("config_command", "실행 명령이 정확히 `npx --yes shadcn@4.13.1 mcp`가 아님");
        }
        configHash = written.configHash;
    }
    catch (e) {
        if (e instanceof ShadcnSchemaProbeError)
            throw new ShadcnSchemaProbeError(e.code, scrub(e.message));
        if (e instanceof McpConfigError)
            throw norm(`config_${e.code}`, e.message);
        throw norm("config", e.message);
    }
    const collected = await new Promise((resolveP, reject) => {
        let settled = false;
        let intentionalKill = false;
        const decoder = new StringDecoder("utf8");
        let stdoutBuf = "";
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stderr = "";
        let phase = "init";
        let nextId = 1;
        let pendingId = 1;
        let toolsListPagesSent = 0;
        const cursorsSeen = new Set();
        const tools = [];
        const names = new Set();
        let protocolVersion = "";
        let serverInfo = { name: "", version: "" };
        let done = null;
        let mainTimer;
        let closeTimer;
        let killTimer;
        const clearAll = () => {
            clearTimeout(mainTimer);
            if (closeTimer)
                clearTimeout(closeTimer);
            if (killTimer)
                clearTimeout(killTimer);
        };
        const child = spawn(command, args, { cwd: serviceCwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.on("error", () => { });
        const send = (msg) => {
            if (!child.stdin.writable)
                return;
            child.stdin.write(JSON.stringify(msg) + "\n");
        };
        // 허용된 3개 메서드만. tools/call 메시지를 만드는 코드 경로가 없다.
        const sendInitialize = () => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "harness-shadcn-schema-probe", version: "0" } } });
        const sendInitialized = () => send({ jsonrpc: "2.0", method: "notifications/initialized" });
        const sendToolsList = (cursor) => {
            pendingId = ++nextId;
            toolsListPagesSent++;
            send(cursor === undefined ? { jsonrpc: "2.0", id: pendingId, method: "tools/list", params: {} } : { jsonrpc: "2.0", id: pendingId, method: "tools/list", params: { cursor } });
        };
        const fail = (code, msg) => {
            if (settled)
                return;
            settled = true;
            clearAll();
            intentionalKill = true;
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* ignore */
            }
            reject(norm(code, msg));
        };
        // schema 수집 성공 → stdin 닫고 child close를 bounded-wait. close 확인 전에는 resolve/저장 없음.
        const beginShutdown = () => {
            clearTimeout(mainTimer);
            intentionalKill = true;
            try {
                child.stdin.end();
            }
            catch {
                /* ignore */
            }
            closeTimer = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    /* ignore */
                }
                killTimer = setTimeout(() => fail("child_did_not_close", "child가 grace 내 종료되지 않음(잔존 가능)"), KILL_GRACE_MS);
            }, CLOSE_GRACE_MS);
        };
        const finishOk = () => {
            const sorted = [...names].sort();
            if (JSON.stringify(sorted) !== JSON.stringify(EXPECTED_SHADCN_TOOLS)) {
                throw new ShadcnSchemaProbeError("tool_name_mismatch", `도구 이름 집합 불일치 — 기대 ${EXPECTED_SHADCN_TOOLS.length}개, 실제 ${sorted.length}개`);
            }
            tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            done = { protocolVersion, serverInfo, tools, toolsListPages: toolsListPagesSent };
            beginShutdown();
        };
        const handleMessage = (msg) => {
            if (msg.jsonrpc !== "2.0")
                throw new ShadcnSchemaProbeError("jsonrpc_version", "jsonrpc가 '2.0'이 아님");
            if (!("id" in msg) || msg.id === undefined)
                return; // 서버 notification → 무시
            if (msg.id !== pendingId)
                throw new ShadcnSchemaProbeError("jsonrpc_id_mismatch", "응답 id가 요청 id와 불일치");
            if (msg.error !== undefined)
                throw new ShadcnSchemaProbeError(phase === "init" ? "init_error" : "tools_error", `${phase} JSON-RPC error 응답`);
            const result = msg.result;
            if (!isPlainObject(result))
                throw new ShadcnSchemaProbeError(phase === "init" ? "init_error" : "tools_error", `${phase} result 누락`);
            if (phase === "init") {
                const pv = result.protocolVersion;
                if (typeof pv !== "string" || !ALLOWED_PROTOCOL_VERSIONS.has(pv)) {
                    throw new ShadcnSchemaProbeError("protocol_version", "초기화 protocolVersion 미negotiation/미허용");
                }
                if (!isPlainObject(result.capabilities))
                    throw new ShadcnSchemaProbeError("capabilities", "capabilities가 plain object 아님");
                if (!("tools" in result.capabilities))
                    throw new ShadcnSchemaProbeError("capabilities", "capabilities.tools 부재");
                const si = result.serverInfo;
                if (!isPlainObject(si) || typeof si.name !== "string" || si.name.length === 0 || typeof si.version !== "string" || si.version.length === 0) {
                    throw new ShadcnSchemaProbeError("server_info", "serverInfo.name/version(non-empty string) 누락");
                }
                protocolVersion = pv;
                serverInfo = { name: si.name, version: si.version };
                phase = "tools";
                sendInitialized();
                sendToolsList();
                return;
            }
            // phase === "tools"
            const list = result.tools;
            if (!Array.isArray(list))
                throw new ShadcnSchemaProbeError("tools_error", "tools/list result.tools가 배열이 아님");
            for (const raw of list) {
                const tool = extractTool(raw, scrub);
                const fullName = `mcp__${SHADCN_SERVER}__${tool.name}`; // 직접 서버는 bare 이름 → host namespacing
                if (names.has(fullName))
                    throw new ShadcnSchemaProbeError("duplicate_tool", "중복 도구");
                names.add(fullName);
                tool.name = fullName;
                tools.push(tool);
                if (names.size > MAX_TOOLS)
                    throw new ShadcnSchemaProbeError("too_many_tools", `도구 수 ${MAX_TOOLS} 초과`);
            }
            const nextCursor = result.nextCursor;
            if (nextCursor !== undefined && nextCursor !== null) {
                if (typeof nextCursor !== "string" || nextCursor.length === 0)
                    throw new ShadcnSchemaProbeError("tools_error", "nextCursor가 유효 문자열 아님");
                if (cursorsSeen.has(nextCursor))
                    throw new ShadcnSchemaProbeError("repeat_cursor", "반복 cursor(페이지네이션 루프)");
                cursorsSeen.add(nextCursor);
                if (toolsListPagesSent >= MAX_PAGES)
                    throw new ShadcnSchemaProbeError("too_many_pages", `tools/list 페이지 ${MAX_PAGES} 초과`);
                sendToolsList(nextCursor);
                return;
            }
            finishOk();
        };
        const onLine = (line) => {
            const t = line.trim();
            if (t.length === 0)
                return;
            let msg;
            try {
                msg = JSON.parse(t);
            }
            catch {
                throw new ShadcnSchemaProbeError("malformed_line", "stdout에 유효하지 않은 JSON 라인");
            }
            if (!isPlainObject(msg))
                throw new ShadcnSchemaProbeError("malformed_line", "JSON-RPC 메시지가 객체가 아님");
            handleMessage(msg);
        };
        mainTimer = setTimeout(() => {
            intentionalKill = true;
            try {
                child.kill("SIGKILL");
            }
            catch {
                /* ignore */
            }
            fail("timeout", `schema probe 타임아웃 (${timeoutMs}ms)`);
        }, timeoutMs);
        child.stdout.on("data", (d) => {
            if (settled || done)
                return; // 수집 완료 후 라인은 무시
            stdoutBytes += d.length; // raw byte 상한 (UTF-8 손상 없이)
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                intentionalKill = true;
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    /* ignore */
                }
                return fail("stdout_too_large", `stdout ${MAX_STDOUT_BYTES} byte 초과`);
            }
            stdoutBuf += decoder.write(d); // chunk 경계 UTF-8 보존
            try {
                let idx;
                while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
                    const line = stdoutBuf.slice(0, idx);
                    stdoutBuf = stdoutBuf.slice(idx + 1);
                    if (settled || done)
                        return;
                    onLine(line);
                    if (settled || done)
                        return;
                }
            }
            catch (e) {
                fail(e.code ?? "verify", e.message);
            }
        });
        child.stderr.on("data", (d) => {
            if (settled)
                return;
            stderrBytes += d.length;
            if (stderrBytes > MAX_STDERR_BYTES) {
                intentionalKill = true;
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    /* ignore */
                }
                return fail("stderr_too_large", `stderr ${MAX_STDERR_BYTES} byte 초과`);
            }
            stderr += d.toString();
        });
        child.on("error", (e) => fail("spawn", `MCP 서버 실행 실패: ${e.message}`));
        child.on("close", (code) => {
            if (settled)
                return;
            clearAll();
            if (done) {
                settled = true;
                resolveP(done); // 수집 성공 + close 확인 후에만 resolve
                return;
            }
            if (code !== 0)
                fail("nonzero_exit", `MCP 서버 비정상 종료 (code ${code}): ${stderr.trim() || "(stderr 없음)"}`);
            else
                fail(phase === "init" ? "no_init" : "no_tools", `tools/list 완료 전 종료 (code ${code})`);
        });
        void intentionalKill;
        sendInitialize();
    });
    // 2) snapshot — 추출 schema만, 문자열 value deep-scrub(key는 이미 clean). 반환==저장 deepEqual.
    const snapshot = {
        mode: "schema-discovery",
        usableForHandoff: false,
        package: scrub(SHADCN_PACKAGE),
        server: scrub(SHADCN_SERVER),
        protocolVersion: scrub(collected.protocolVersion),
        serverInfo: { name: scrub(collected.serverInfo.name), version: scrub(collected.serverInfo.version) },
        tools: collected.tools.map((t) => deepScrub(t, scrub)),
        configHash,
        timestamp: scrub(now()),
    };
    const serialized = JSON.stringify(snapshot, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_SNAPSHOT_BYTES) {
        throw norm("snapshot_too_large", `schema snapshot이 ${MAX_SCHEMA_SNAPSHOT_BYTES} byte 초과`);
    }
    const snapshotPath = join(runtimeDir, "mcp-schema-discovery.json");
    try {
        mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
        writeFileSync(snapshotPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    catch (e) {
        throw norm("persist", `schema snapshot 기록 실패 (기존 파일/symlink?): ${e.message}`);
    }
    const operationSummary = { initialize: 1, initialized: 1, toolsListPages: collected.toolsListPages, toolCalls: 0 };
    return { schemaDiscovery: true, snapshotPath, snapshot, operationSummary };
}
function childEnv() {
    const env = {};
    for (const k of ENV_ALLOWLIST) {
        const v = process.env[k];
        if (v !== undefined)
            env[k] = v;
    }
    return env;
}
