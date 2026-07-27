/**
 * V3 M5a — `codex exec` 어댑터 (로드맵 §7.1의 `CodexCliProvider`).
 *
 * 기존 `ExecutionProvider` 계약을 그대로 구현한다 — **두 번째 오케스트레이터·상태 시스템을 만들지 않는다.**
 * 세션 수명 모델은 `ClaudeCliProvider`와 같다(호출당 프로세스 1개, 후속 turn은 resume).
 *
 * 확정 계약(2026-07-27 fresh Codex 리뷰 반영):
 * - **실행 파일은 신뢰된 명시 절대경로 하나뿐이다.** 이 모듈은 `process.env`를 **읽지 않는다** —
 *   PATH·`HARNESS_CODEX_BIN` 같은 상속 환경으로 실행 대상을 고르지 않는다(임의 실행 파일 seam 제거).
 *   spawn 직전에 그 경로가 **symlink 아닌 일반 실행 파일**이고 group/other 쓰기가 없음을 확인한다.
 *   경로를 고르는 책임은 **controller(호출자)** 에 있고, 여기서는 검증만 한다.
 * - argv는 **배열로 컴파일**하고 shell을 경유하지 않는다. 프롬프트는 **stdin**으로만 넣는다(`-`).
 * - **sandbox는 `read-only` 고정**(M5a hard deny — `workspace-write`도 거부).
 * - **strict empty MCP는 ambient 설정에 의존하지 않는다**: 검증된 격리 `CODEX_HOME`(비어 있는 0700
 *   정규 디렉터리) + `--config mcp_servers={}` + `--strict-config` + `--ignore-user-config` +
 *   `--ignore-rules`, 자식 env는 **`CODEX_HOME` 하나뿐**(PATH조차 상속하지 않는다).
 *   auth 파일·자격증명은 **복사하지도 저장하지도 않는다**. 스트림에서 MCP 호출이 보이면 비가역 실패다(파서).
 * - 프로세스를 띄우기 **직전마다** `verifyExecutionBoundary` → `revalidateSync()`로 승인 커밋과
 *   디렉터리 신원을 대조한다(대장 `B-5`). cwd는 **경계가 확인한 `targetRoot`만** 쓴다.
 * - resume은 파서가 검증한 **정규 UUID 하나**로만 하고 `--last`는 쓰지 않는다.
 *
 * argv 배치 근거(supervisor 실측, codex-cli **0.146.0-alpha.3**, parse-only — 추론 미실행):
 *   fresh `exec`  : --config · --strict-config · --model · --sandbox · --cd · --ephemeral ·
 *                   --ignore-user-config · --ignore-rules · --output-schema · --json · stdin `-`
 *   `exec resume` : --config · --strict-config · --model · --ignore-user-config · --ignore-rules ·
 *                   --output-schema · --json  (**subcommand-local `--sandbox`/`--cd`는 없다**)
 *   → resume에서는 `--sandbox`/`--cd`를 **`resume` 앞(부모 위치)** 에 둔다.
 *     `exec resume <uuid> --sandbox … --cd …`는 실제로 거부되고 `exec --sandbox … --cd … resume …`는 파싱된다.
 * 이벤트 payload 필드명은 provider live 경로로 확인하지 않았다(M5b 게이트).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { CODEX_SESSION_ID_RE, CodexJsonlParser } from "./codexStreamParser.js";
import { verifyExecutionBoundary } from "./executionBoundary.js";
import { OrchestrationError } from "./orchestrationTypes.js";
/** 프롬프트 상한(문자). 넘으면 stdin에 쓰지 않고 거부한다. */
export const MAX_PROMPT_CHARS = 262_144;
/** stderr 버퍼 상한(문자) — 요약 전에도 무제한으로 쌓지 않는다. */
const MAX_STDERR_BUFFER = 8_192;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORTS = ["low", "medium", "high", "xhigh"];
/** 리뷰 기본값 — 로드맵 §6 모델 정책·§7.1 실행 계약. sandbox는 M5a에서 이 값 외에 없다. */
export const CODEX_REVIEW_DEFAULTS = { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "read-only" };
function fail(code, message) {
    throw new OrchestrationError(code, message);
}
function requireAbsolute(v, what) {
    if (typeof v !== "string" || v.length === 0 || v.includes("\0") || !isAbsolute(v)) {
        fail("codex_config_invalid", `${what}는 NUL 없는 절대경로여야 한다`);
    }
    return v;
}
/**
 * 실행 파일 신원 검증. **symlink 아닌 일반 파일**·실행 비트 있음·group/other 쓰기 없음·정규 경로.
 * spawn 직전마다 다시 부른다(검사와 사용 사이의 창을 줄인다 — Node에 fexecve가 없어 0은 아니다).
 */
export function assertTrustedExecutable(path) {
    const p = requireAbsolute(path, "executablePath");
    let real;
    try {
        real = realpathSync(p);
    }
    catch {
        fail("codex_executable_invalid", "executablePath의 realpath를 확인할 수 없다");
    }
    if (real !== p)
        fail("codex_executable_invalid", "executablePath는 정규 경로여야 한다(symlink 미해석)");
    let st;
    try {
        st = lstatSync(p);
    }
    catch {
        fail("codex_executable_invalid", "executablePath의 상태를 확인할 수 없다");
    }
    if (st.isSymbolicLink() || !st.isFile())
        fail("codex_executable_invalid", "executablePath는 symlink 아닌 일반 파일이어야 한다");
    if ((st.mode & 0o111) === 0)
        fail("codex_executable_invalid", "executablePath에 실행 비트가 없다");
    if ((st.mode & 0o022) !== 0)
        fail("codex_executable_invalid", "executablePath가 group/other 쓰기 가능이다");
    return p;
}
/**
 * 격리 `CODEX_HOME` 검증: 절대·정규·비-symlink 디렉터리 · 0700(그룹/기타 권한 0) · **비어 있음**.
 * 비어 있음을 요구하는 이유는 M5a에서 ambient config·auth·MCP 정의가 하나도 없어야 하기 때문이다.
 * 사용자 홈(및 그 `.codex`)은 절대 쓰지 않는다. **auth를 복사하지 않는다** — live 인증은 대장 `B-7`.
 */
export function assertIsolatedCodexHome(path) {
    const p = requireAbsolute(path, "spec.codex.codexHome");
    let real;
    try {
        real = realpathSync(p);
    }
    catch {
        fail("codex_home_invalid", "codexHome의 realpath를 확인할 수 없다");
    }
    if (real !== p)
        fail("codex_home_invalid", "codexHome은 정규 경로여야 한다(symlink 금지)");
    let userHome = "";
    try {
        userHome = realpathSync(homedir());
    }
    catch {
        userHome = "";
    }
    if (userHome && (p === userHome || p === join(userHome, ".codex"))) {
        fail("codex_home_ambient", "codexHome으로 사용자 홈(또는 ~/.codex)을 쓸 수 없다");
    }
    let st;
    try {
        st = lstatSync(p);
    }
    catch {
        fail("codex_home_invalid", "codexHome의 상태를 확인할 수 없다");
    }
    if (st.isSymbolicLink() || !st.isDirectory())
        fail("codex_home_invalid", "codexHome은 symlink 아닌 디렉터리여야 한다");
    if ((st.mode & 0o077) !== 0)
        fail("codex_home_permissive", "codexHome은 0700(소유자 전용)이어야 한다");
    let entries;
    try {
        entries = readdirSync(p);
    }
    catch {
        fail("codex_home_invalid", "codexHome을 읽을 수 없다");
    }
    if (entries.length > 0) {
        // 개수만 알린다 — 파일 이름은 오류 문자열에 싣지 않는다.
        fail("codex_home_not_empty", `codexHome에 기존 설정/자격증명 항목이 있다(${entries.length}건)`);
    }
    return p;
}
/** spec의 codex 옵션을 fail-closed로 정규화한다. 계약 밖 값은 기본값으로 눙치지 않고 거부한다. */
export function resolveCodexOptions(spec) {
    const o = spec.codex;
    if (!o || typeof o !== "object") {
        fail("codex_config_isolation_required", "spec.codex(격리된 codexHome 포함)가 필요하다");
    }
    const model = spec.model ?? CODEX_REVIEW_DEFAULTS.model;
    if (!MODEL_RE.test(model))
        fail("codex_config_invalid", "spec.model이 모델 이름 형식이 아니다");
    const reasoningEffort = o.reasoningEffort ?? CODEX_REVIEW_DEFAULTS.reasoningEffort;
    if (!EFFORTS.includes(reasoningEffort))
        fail("codex_config_invalid", `reasoningEffort는 ${EFFORTS.join("|")} 중 하나여야 한다`);
    // M5a hard deny: read-only 외의 모든 sandbox(= workspace-write·bypass 계열)를 거부한다.
    const sandbox = o.sandbox ?? CODEX_REVIEW_DEFAULTS.sandbox;
    if (sandbox !== "read-only") {
        fail("codex_sandbox_forbidden", "M5a의 Codex 세션은 read-only 전용이다(workspace-write는 승인된 권한 계층이 생긴 뒤에만)");
    }
    const codexHome = requireAbsolute(o.codexHome, "spec.codex.codexHome");
    const outputSchemaPath = o.outputSchemaPath === undefined ? undefined : requireAbsolute(o.outputSchemaPath, "spec.codex.outputSchemaPath");
    requireAbsolute(spec.cwd, "spec.cwd");
    return { model, reasoningEffort, sandbox, codexHome, outputSchemaPath, ephemeral: o.ephemeral ?? true };
}
/** fresh·resume 공통 설정 플래그(둘 다 지원하는 것만). */
function sharedFlags(o) {
    const args = ["--json", "--model", o.model];
    args.push("--config", `model_reasoning_effort="${o.reasoningEffort}"`);
    // ambient 사용자 MCP 서버를 명시적으로 비운다(CODEX_HOME 격리와 이중 방어).
    args.push("--config", "mcp_servers={}");
    args.push("--strict-config", "--ignore-user-config", "--ignore-rules");
    if (o.outputSchemaPath)
        args.push("--output-schema", o.outputSchemaPath);
    return args;
}
/**
 * argv 컴파일. `resumeSessionId`가 있으면 **resume 배치**를 쓴다:
 * `--sandbox`/`--cd`는 `resume` **앞**(부모 위치)에 두고, resume-local 지원 플래그만 뒤에 둔다.
 * resume id는 **정규 UUID**여야 한다 — 검증되지 않은 텍스트로 인자를 만들지 않는다(`--last` 금지).
 * 순수 함수 — 테스트가 argv를 정확히 고정한다.
 */
export function compileCodexArgs(spec, cwd, resumeSessionId) {
    const o = resolveCodexOptions(spec);
    requireAbsolute(cwd, "실행 cwd");
    const sandboxAndCd = ["--sandbox", o.sandbox, "--cd", cwd];
    if (resumeSessionId !== undefined) {
        if (typeof resumeSessionId !== "string" || !CODEX_SESSION_ID_RE.test(resumeSessionId)) {
            fail("codex_resume_id_invalid", "resume 대상은 정규 codex session UUID여야 한다");
        }
        // 실측: subcommand-local --sandbox/--cd가 없으므로 부모 위치에 둔다. --ephemeral도 resume에는 없다.
        return ["exec", ...sandboxAndCd, "resume", resumeSessionId, ...sharedFlags(o), "-"];
    }
    const args = ["exec", ...sharedFlags(o), ...sandboxAndCd];
    if (o.ephemeral)
        args.push("--ephemeral");
    args.push("-"); // 프롬프트는 stdin
    return args;
}
/**
 * 자식 env. **`CODEX_HOME` 하나뿐**이다 — PATH조차 상속하지 않는다(env 유래 production 동작 0).
 * 그래서 사용자 토큰·자격증명·설정 경로가 자식에게 전달될 통로가 없다.
 */
export function compileCodexEnv(codexHome) {
    return { CODEX_HOME: codexHome };
}
export class CodexCliProvider {
    opts;
    id = "codex-cli";
    sessions = new Map();
    spawnFn;
    constructor(opts) {
        this.opts = opts;
        this.spawnFn = opts.spawn ?? nodeSpawn;
    }
    async start(spec, initialPrompt) {
        if (typeof spec?.sessionId !== "string" || spec.sessionId.length === 0) {
            fail("codex_config_invalid", "spec.sessionId가 필요하다");
        }
        if (this.sessions.has(spec.sessionId))
            fail("codex_session_exists", `harness 세션 id가 이미 있다: ${spec.sessionId}`);
        const o = resolveCodexOptions(spec); // 설정 거부는 상태를 만들기 전에 일어난다
        const state = {
            spec,
            queue: new AsyncEventQueue(),
            child: null,
            status: "idle",
            settled: Promise.resolve(),
            codexSessionId: "",
            ephemeral: o.ephemeral,
            poisoned: "",
        };
        this.sessions.set(spec.sessionId, state);
        try {
            await this.invoke(state, undefined, initialPrompt);
        }
        catch (err) {
            this.sessions.delete(spec.sessionId); // 실패한 start는 상태를 남기지 않는다
            throw err;
        }
        return { sessionId: spec.sessionId, spec };
    }
    /** 후속 지시 = `codex exec … resume <관측된 UUID>`. 관측 전·ephemeral·실행 중·오염 세션은 거부한다. */
    async send(handle, message) {
        const state = this.requireState(handle);
        if (state.poisoned)
            fail(state.poisoned, "세션이 프로토콜 위반으로 닫혔다");
        if (state.status === "running")
            fail("codex_send_overlap", "이전 invocation이 아직 실행 중이다");
        if (state.status === "stopped")
            fail("codex_session_stopped", "중지된 세션에는 보낼 수 없다");
        if (state.ephemeral) {
            fail("codex_resume_unavailable", "ephemeral 세션은 resume할 수 없다(resume이 필요하면 ephemeral:false로 시작한다)");
        }
        if (!CODEX_SESSION_ID_RE.test(state.codexSessionId)) {
            fail("codex_resume_unavailable", "정규 codex session UUID를 관측하지 못했다(--last는 쓰지 않는다)");
        }
        await this.invoke(state, state.codexSessionId, message);
    }
    events(handle) {
        return this.requireState(handle).queue;
    }
    /**
     * 세션 중지. **종료 결과가 정착하기 전에 큐를 닫거나 상태를 지우지 않는다.**
     * 프로세스 그룹·TERM→유예→KILL·자손 정리는 이 범위가 아니다(대장 `C-18`, M5c).
     * ponytail: 여기서는 SIGTERM 1회 + settle 대기까지만 — 강제 종료 사다리는 M5c에서 붙인다.
     */
    async stop(handle, _reason) {
        const state = this.sessions.get(handle.sessionId);
        if (!state)
            return;
        if (state.status === "running") {
            state.child?.kill("SIGTERM");
            await state.settled; // 종료 result 1건이 큐에 들어간 뒤에만 정리한다
        }
        state.status = "stopped";
        state.queue.close();
        this.sessions.delete(handle.sessionId);
    }
    requireState(handle) {
        const state = handle && typeof handle.sessionId === "string" ? this.sessions.get(handle.sessionId) : undefined;
        if (!state)
            fail("codex_unknown_session", "없는 세션이다");
        return state;
    }
    /**
     * 한 invocation. 순서는 **전체 검증 → 경계 확인 → 큐 발행 → 신원 재확인 → spawn**이다.
     * 검증 단계에서 실패하면 기존 큐·상태는 그대로다(오염된 열린 큐를 남기지 않는다).
     */
    async invoke(state, resumeSessionId, prompt) {
        if (typeof prompt !== "string" || prompt.length === 0)
            fail("codex_prompt_invalid", "프롬프트가 비어 있다");
        if (prompt.length > MAX_PROMPT_CHARS)
            fail("codex_prompt_too_long", `프롬프트는 ${MAX_PROMPT_CHARS}자 이하여야 한다`);
        const o = resolveCodexOptions(state.spec);
        const codexHome = assertIsolatedCodexHome(o.codexHome);
        const bin = assertTrustedExecutable(this.opts.executablePath);
        // 대장 `B-5`: 승인된 커밋이 controller/실행 checkout HEAD와 정확히 같을 때만 프로세스를 띄운다.
        const boundary = await verifyExecutionBoundary({
            manifest: this.opts.manifest,
            controllerRepoRoot: this.opts.controllerRepoRoot,
            targetWorktree: state.spec.cwd,
            nowMs: this.opts.nowMs?.(),
        });
        // cwd는 경계가 확인한 targetRoot만 쓴다(호출자 문자열 재사용 금지 — argv와 native cwd 모두).
        const cwd = boundary.targetRoot;
        const args = compileCodexArgs(state.spec, cwd, resumeSessionId);
        const parser = new CodexJsonlParser({ model: o.model, cwd, sandbox: o.sandbox });
        // 여기부터가 "발행" 구간이다 — 검증은 모두 끝났다.
        const queue = new AsyncEventQueue();
        let resolveSettled = () => undefined;
        const settledPromise = new Promise((res) => (resolveSettled = res));
        let settled = false;
        const settle = (exit) => {
            if (settled)
                return;
            settled = true;
            for (const e of parser.finish(exit))
                queue.push(e);
            queue.close();
            state.child = null;
            state.status = state.status === "stopped" ? "stopped" : "idle";
            resolveSettled();
        };
        state.queue = queue;
        state.settled = settledPromise;
        state.status = "running";
        // 마지막 경계 연산: 디렉터리 신원 + HEAD 동기 재확인 → 바로 다음 문장이 spawn이다.
        try {
            boundary.revalidateSync();
        }
        catch (err) {
            settle({ code: null, signal: null, stderr: "", spawnError: true });
            throw err;
        }
        let child;
        try {
            child = this.spawnFn(bin, args, { cwd, env: compileCodexEnv(codexHome), stdio: ["pipe", "pipe", "pipe"] });
        }
        catch (err) {
            // 동기 spawn 예외: 큐를 열어둔 채 두지 않고 종료 결과 1건으로 닫는다.
            settle({ code: null, signal: null, stderr: err?.message ?? "", spawnError: true });
            fail("codex_spawn_failed", "codex 실행을 시작하지 못했다");
        }
        state.child = child;
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            for (const e of parser.push(chunk)) {
                if (e.kind === "init")
                    this.bindSessionIdentity(state, parser, e.sessionId, queue);
                queue.push(e);
            }
        });
        // stderr는 요약·redaction 후에만 쓰인다(원문은 큐·상태로 나가지 않는다).
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (d) => {
            if (stderr.length < MAX_STDERR_BUFFER)
                stderr += d;
        });
        // stdin EPIPE 등은 프로세스 종료 경로로 수렴시킨다(여기서 던지면 unhandled가 된다).
        child.stdin?.on("error", () => parser.protocolFail("stdin_error"));
        child.on("error", (err) => settle({ code: null, signal: null, stderr: err.message, spawnError: true }));
        child.on("close", (code, signal) => settle({ code, signal, stderr }));
        try {
            child.stdin?.write(prompt);
            child.stdin?.end();
        }
        catch {
            parser.protocolFail("stdin_error");
        }
    }
    /**
     * 세션 신원 고정: 첫 정규 UUID만 채택하고, 이후 invocation이 다른 id를 내면 **비가역 실패**다
     * (파서가 스트림 내부 위반을 보고 여기서는 invocation 간 위반을 본다).
     */
    bindSessionIdentity(state, parser, observed, queue) {
        if (!CODEX_SESSION_ID_RE.test(observed))
            return; // 파서가 이미 프로토콜 실패로 잡는다
        if (!state.codexSessionId) {
            state.codexSessionId = observed;
            return;
        }
        if (state.codexSessionId !== observed) {
            state.poisoned = "codex_session_identity_conflict";
            parser.protocolFail("session_identity_conflict");
            queue.push({
                kind: "unknown",
                type: "session_identity_conflict",
                sessionId: state.codexSessionId,
                raw: { type: "codex_event", codexType: "session_identity_conflict" },
            });
            state.child?.kill("SIGTERM");
        }
    }
}
