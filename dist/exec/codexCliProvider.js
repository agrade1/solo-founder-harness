/**
 * V3 M5a — `codex exec` 어댑터 (로드맵 §7.1의 `CodexCliProvider`).
 *
 * 기존 `ExecutionProvider` 계약을 그대로 구현한다 — **두 번째 오케스트레이터·상태 시스템을 만들지 않는다.**
 * 세션 수명 모델은 `ClaudeCliProvider`와 같다(호출당 프로세스 1개, 후속 turn은 resume).
 *
 * 확정 계약(2026-07-27 fresh Codex 리뷰 · 2·3차 리비전 반영):
 * - **실행 파일은 신뢰된 명시 절대경로 하나뿐이다.** 이 모듈은 `process.env`를 **읽지 않는다** —
 *   PATH·`HARNESS_CODEX_BIN` 같은 상속 환경으로 실행 대상을 고르지 않는다(임의 실행 파일 seam 제거).
 *   경로를 고르는 책임은 **controller(호출자)** 에 있고, 여기서는 검증만 한다.
 * - **spawn 직전 동기 게이트가 신뢰 판정의 근거다(3차 리비전 · A/P0).** 이전 판은 홈·실행 파일을
 *   **비동기 경계 작업 전에** 검사하고 그 뒤에는 경계 재검증만 했다 → 그 창에서 홈·실행 파일이 교체·
 *   symlink화·권한 완화되면 spawn까지 도달할 수 있었다. 이제 **await가 하나도 남지 않은 상태에서**
 *   ① spec 스냅샷 ② 승인 만료·git 신원·checkout 신원·HEAD ③ `CODEX_HOME`(+고정 신원, 첫 invocation은
 *   여전히 비어 있음) ④ codex 실행 파일(+**고정 신원** — 같은 권한의 다른 실행 파일 교체도 거부)을
 *   순서대로 다시 확인하고, **바로 다음 문장이 spawn**이다. 남는 창은 syscall 몇 개 규모이며
 *   `fexecve`가 없는 Node에서 **0이라고 주장하지 않는다**.
 * - argv는 **배열로 컴파일**하고 shell을 경유하지 않는다. 프롬프트는 **stdin**으로만 넣는다(`-`).
 * - **sandbox는 `read-only` 고정**(M5a hard deny — `workspace-write`도 거부).
 * - **strict empty MCP는 ambient 설정에 의존하지 않는다**: 검증된 격리 `CODEX_HOME` +
 *   `--config mcp_servers={}` + `--strict-config` + `--ignore-user-config` + `--ignore-rules`,
 *   자식 env는 **`CODEX_HOME` 하나뿐**(PATH조차 상속하지 않는다).
 *   auth 파일·자격증명은 **복사하지도 저장하지도 않는다**. 스트림에서 MCP 호출이 보이면 비가역 실패이고
 *   (파서) 그 세션은 닫힌다 — 오염된 thread를 resume으로 이어가지 않는다.
 * - **`CODEX_HOME`은 provider가 소유하는 수명이다**: 첫 invocation은 **비어 있는** 0700 정규 디렉터리를
 *   요구해 ambient config·auth·MCP를 0으로 만들고, 그때 확보한 **신원(dev+ino)** 을 고정한다. resume은
 *   codex가 그 홈에 남긴 세션 상태를 필요로 하므로 **같은 신원일 때만** 비어 있지 않은 홈을 허용한다
 *   (교체·symlink화·권한 완화·소유하지 않은 기존 상태는 거부 → spawn 0). strict 플래그는 resume에도 그대로다.
 * - 프로세스를 띄우기 **직전마다** `verifyExecutionBoundary` → 동기 게이트의 `revalidateSync()`로 승인 커밋과
 *   디렉터리 신원을 대조한다(대장 `B-5`). cwd는 **경계가 확인한 `targetRoot`만** 쓴다.
 *   경계가 쓰는 **git 실행 파일도 신뢰된 절대경로 + 상속 없는 env**다(ambient `PATH`/`GIT_*` 우회 차단).
 * - resume은 파서가 검증한 **정규 UUID 하나**로만 하고 `--last`는 쓰지 않는다. 파서에 **기대 UUID**를 넘겨
 *   다른 thread의 init·본문이 나가기 전에 봉인하고, 그 세션은 닫아 후속 `send`가 spawn 0이 되게 한다.
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
import { verifyExecutionBoundary, verifyTrustedExecutable, } from "./executionBoundary.js";
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
const CODEX_BIN_CODES = {
    path: "codex_config_invalid",
    invalid: "codex_executable_invalid",
    identity: "codex_executable_identity_changed",
};
/**
 * codex 실행 파일 신원 검증(경계와 **같은 구현**을 쓴다): 정규 · symlink 아님 · 일반 파일 ·
 * 실행 비트 · group/other 쓰기 없음, 그리고 `pinned`를 주면 **신원(dev+ino)** 까지 같아야 한다.
 * 사전 검증에서 신원을 고정하고 **spawn 직전 동기 게이트에서 다시** 부른다 — 같은 권한의 다른 실행 파일로
 * 교체되는 창까지 막는다(Node에 `fexecve`가 없어 창은 0이 아니고 syscall 몇 개로 줄인 것이다).
 */
export function verifyCodexExecutable(path, pinned) {
    return verifyTrustedExecutable(path, "executablePath", CODEX_BIN_CODES, pinned);
}
/** 경로만 필요한 호출자용 shim(신원 고정이 필요하면 `verifyCodexExecutable`을 쓴다). */
export function assertTrustedExecutable(path) {
    return verifyCodexExecutable(path).path;
}
/**
 * 격리 `CODEX_HOME` 검증 — **provider 소유 수명**이다.
 *
 * - **첫 invocation**: 절대·정규·비-symlink 디렉터리 · 0700 · **비어 있음** · 사용자 홈 아님.
 *   비어 있음을 요구하는 이유는 첫 프로세스가 ambient config·auth·MCP 정의를 하나도 못 보게 하려는 것이다.
 *   여기서 확보한 신원(dev+ino)이 그 홈에 대한 provider의 **소유권**이고, **spawn 직전 동기 게이트에서
 *   같은 신원 + 여전히 비어 있음**을 다시 확인한다(비동기 경계 작업 중 교체·오염을 막는다).
 * - **resume**: 경로 계약·권한·사용자 홈 금지는 **그대로** 요구하고 **소유 신원이 같아야** 한다.
 *   같을 때만 **codex가 남긴 세션 상태를 허용**한다(resume은 그 상태를 필요로 한다). 홈이 교체·symlink화·
 *   권한 완화되면 거부하고, provider가 소유하지 않은 기존 상태로는 resume하지 않는다
 *   (그 경로는 첫 검증에서 `codex_home_not_empty`로 막힌다).
 *
 * 어느 경우에도 `--strict-config`·`--ignore-user-config`·`--ignore-rules`·`mcp_servers={}`는 유지되므로
 * 홈에 무엇이 생기든 ambient MCP·사용자 설정을 상속하지 않는다. **auth를 복사하지 않는다** — live 인증은 `B-7`.
 * 같은 uid로 동작하는 공격자를 막지는 못한다(소유자 자신은 언제든 홈을 쓸 수 있다) — 막는 것은 **경로 교체·
 * 권한 완화·소유하지 않은 상태로의 resume**이다.
 */
export function verifyCodexHome(path, expect = {}) {
    const owned = expect.identity;
    const requireEmpty = expect.requireEmpty ?? owned === undefined;
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
    const id = { dev: st.dev, ino: st.ino };
    if (owned && (id.dev !== owned.dev || id.ino !== owned.ino)) {
        fail("codex_home_identity_changed", "codexHome의 디렉터리 신원이 검증 이후 바뀌었다");
    }
    if (!requireEmpty)
        return { path: p, id };
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
    return { path: p, id };
}
/** 최초 상태(비어 있어야 하는) 검증만 필요한 호출자용 shim. */
export function assertIsolatedCodexHome(path) {
    return verifyCodexHome(path).path;
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
            homeId: null,
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
     * 한 invocation. 순서는 **사전 검증 → 비동기 경계 확인 → 큐 발행 → 동기 pre-spawn 게이트 → spawn**이다.
     * 검증 단계에서 실패하면 기존 큐·상태는 그대로다(오염된 열린 큐를 남기지 않는다).
     *
     * 사전 검증은 계약 위반을 **비동기 작업 전에** 걸러내기 위한 것이고, **신뢰 판정의 근거는 게이트다**:
     * 홈·실행 파일·git·승인 커밋·만료·spec 스냅샷을 **await가 하나도 남지 않은 상태에서** 한 번에 다시 본다.
     */
    async invoke(state, resumeSessionId, prompt) {
        if (typeof prompt !== "string" || prompt.length === 0)
            fail("codex_prompt_invalid", "프롬프트가 비어 있다");
        if (prompt.length > MAX_PROMPT_CHARS)
            fail("codex_prompt_too_long", `프롬프트는 ${MAX_PROMPT_CHARS}자 이하여야 한다`);
        // ── 사전 검증(빠른 거부 + 신원 고정) ──────────────────────────────────
        const o = resolveCodexOptions(state.spec);
        const homeExpect = state.homeId
            ? { identity: state.homeId } // resume: 소유 홈(상태 있음이 정상)
            : { requireEmpty: true }; // 첫 invocation: 빈 홈
        const preHome = verifyCodexHome(o.codexHome, homeExpect);
        const preBin = verifyCodexExecutable(this.opts.executablePath);
        // cwd 자체는 경계가 확인한 `targetRoot`만 쓰지만, 스냅샷에 넣어 변조를 조용히 넘기지 않는다.
        const specCwd = state.spec.cwd;
        // 대장 `B-5`: 승인된 커밋이 controller/실행 checkout HEAD와 정확히 같을 때만 프로세스를 띄운다.
        const boundary = await verifyExecutionBoundary({
            manifest: this.opts.manifest,
            controllerRepoRoot: this.opts.controllerRepoRoot,
            targetWorktree: state.spec.cwd,
            gitExecutablePath: this.opts.gitExecutablePath,
            // clock을 **함수로** 넘긴다 — 경계는 spawn 직전 재검증에서 만료를 다시 본다.
            nowMs: this.opts.nowMs,
        });
        // cwd는 경계가 확인한 targetRoot만 쓴다(호출자 문자열 재사용 금지 — argv와 native cwd 모두).
        const cwd = boundary.targetRoot;
        // 파서에 **기대 세션 신원**을 준다: resume 스트림이 다른 thread를 내면 init·본문이 나가기 전에 봉인된다.
        const parser = new CodexJsonlParser({ model: o.model, cwd, sandbox: o.sandbox, expectedSessionId: resumeSessionId });
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
        // ── spawn 직전 동기 게이트 ────────────────────────────────────────────
        // 여기부터 spawn까지 **await가 없다.** 비동기 경계 작업 중에 바뀔 수 있는 모든 신뢰 자산을
        // 순서대로 다시 확인한다: ① spec 스냅샷(호출자 객체 변조) ② 승인 만료·git 신원·checkout 신원·HEAD
        // ③ `CODEX_HOME`(정규·비symlink·0700·사용자 홈 아님 + 고정 신원, 첫 invocation은 여전히 비어 있음)
        // ④ codex 실행 파일(신뢰 조건 + 고정 신원 — 같은 권한의 다른 실행 파일 교체까지 거부).
        // 남는 창은 syscall 몇 개 규모다(Node에 `fexecve`·디렉터리 fd 상대 실행이 없다) — 0이라고 주장하지 않는다.
        let home;
        let bin;
        let args;
        try {
            const now = resolveCodexOptions(state.spec);
            if (JSON.stringify(now) !== JSON.stringify(o) || state.spec.cwd !== specCwd) {
                fail("codex_spec_mutated", "spec 해석값이 검증 이후 바뀌었다(호출자 객체 변조)");
            }
            boundary.revalidateSync();
            home = verifyCodexHome(o.codexHome, { ...homeExpect, identity: preHome.id });
            bin = verifyCodexExecutable(this.opts.executablePath, preBin.id);
            // argv는 스냅샷이 확인된 뒤에 컴파일한다(중간에 바뀐 spec으로 인자를 만들지 않는다).
            args = compileCodexArgs(state.spec, cwd, resumeSessionId);
        }
        catch (err) {
            settle({ code: null, signal: null, stderr: "", spawnError: true });
            throw err;
        }
        let child;
        try {
            child = this.spawnFn(bin.path, args, { cwd, env: compileCodexEnv(home.path), stdio: ["pipe", "pipe", "pipe"] });
        }
        catch (err) {
            // 동기 spawn 예외: 큐를 열어둔 채 두지 않고 종료 결과 1건으로 닫는다.
            settle({ code: null, signal: null, stderr: err?.message ?? "", spawnError: true });
            fail("codex_spawn_failed", "codex 실행을 시작하지 못했다");
        }
        // 프로세스를 띄운 뒤부터 그 홈은 provider 소유다 — 이후 invocation은 신원이 같은 홈만 쓴다.
        state.homeId = home.id;
        state.child = child;
        let stderr = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            for (const e of parser.push(chunk)) {
                if (e.kind === "init")
                    this.bindSessionIdentity(state, parser, e.sessionId, queue);
                // strict empty MCP 위반을 본 thread는 **다시 이어가지 않는다**(비가역 실패를 resume으로 우회 금지).
                else if (e.kind === "unknown" && e.type === "mcp_call_observed")
                    state.poisoned = "codex_mcp_observed";
                // 파서가 기대 신원과 다른 thread를 봤다(init·본문은 이미 봉인돼 나오지 않는다) → 세션을 닫는다.
                else if (e.kind === "unknown" && e.type === "session_identity_conflict") {
                    state.poisoned = "codex_session_identity_conflict";
                    state.child?.kill("SIGTERM");
                }
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
