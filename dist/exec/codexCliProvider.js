/**
 * V3 M5a — `codex exec` 어댑터 (로드맵 §7.1의 `CodexCliProvider`).
 *
 * 기존 `ExecutionProvider` 계약을 그대로 구현한다 — **두 번째 오케스트레이터·상태 시스템을 만들지 않는다.**
 * 세션 수명 모델은 `ClaudeCliProvider`와 같다(호출당 프로세스 1개, 후속 turn은 resume).
 *
 * 확정 계약(2026-07-27 fresh Codex 리뷰 · 2·3·4·5차 리비전 반영):
 * - **핸들은 세션 인스턴스에 묶인다(5차 리비전 · A/P1).** 이전 판은 `send`/`events`/`stop`이 `sessionId`
 *   **하나로만** 상태를 찾았다 → H1을 stop하고 같은 id로 H2를 start하면 **낡은 H1이 H2의 이벤트를 읽고,
 *   H2에 지시를 보내고, H2를 중지·삭제**할 수 있었다(4차의 교체 테스트는 내부 정리만 봤고 이미 반환된
 *   공개 핸들은 보지 않았다). 이제 세션 인스턴스마다 **내용 없는 frozen 신원 객체**를 만들어 `start`가
 *   반환하는 핸들에 붙이고(`SessionHandle.providerBinding`), 모든 진입점이 **참조 동일성**으로 대조한다:
 *   낡은·위조 핸들의 `send`/`events`는 **읽기·발행·spawn·변경·삭제 없이** `codex_stale_handle`로 닫히고,
 *   `stop`은 **무해·멱등**이다(교체 세션에 signal·close·삭제를 하지 않는다). 신원은 `sessionId`나
 *   가변 `spec` 내용이 아니라 **오직 그 객체 참조**이며, 비밀 material이 아니라 로그·문서에 남길 것이 없다.
 * - **실행 권위는 `start()`가 포착한 값뿐이다(5차 리비전 · A/P1 — `C-23`의 마지막 구멍).** 이전 판은
 *   봉인에 `nowMs`·`manifest`가 없어서 **매 invocation `this.opts`를 다시 읽었다** → 첫 turn 뒤에
 *   호출자가 `opts.nowMs`를 만료 전 시각을 말하는 시계로 갈아끼우면 **경계 진입·spawn 직전 두 만료
 *   검사가 모두 통과**해 실제로는 만료된 승인으로 resume이 떴고, `opts.manifest`도 같은 방식으로
 *   경계 판정에 끼어들 수 있었다. 이제 **시각 권위(clock)와 검증된 manifest 사본을 봉인**하고
 *   경계에는 **봉인값만** 넘긴다. 봉인된 clock은 **매번 다시 호출**하므로 시간은 자연스럽게 흐르고
 *   (시각을 얼리지 않는다), `opts.nowMs`의 교체·제거·추가는 **드리프트**로 잡혀 fail closed다.
 * - **start 이후의 모든 드리프트 marker는 `codex_spec_mutated` 하나다(5차 리비전 · A/문서 불일치).**
 *   이전 판은 그렇게 문서화해 놓고 드리프트 비교가 `sealCodexSpec`을 먼저 불러 **재해석 단계의 native
 *   오류**(`codex_sandbox_forbidden` 등)를 그대로 던졌다(테스트도 그 값을 기대해 문서와 어긋났다).
 *   이제 **초기 `start`는 정확한 native 코드를 그대로 유지**하고, **start 이후** 봉인값이 바뀌거나
 *   **무효가 되는** 경우는 값·경로를 싣지 않은 `codex_spec_mutated` 하나로 닫는다.
 * - **invocation 소유권은 첫 await 전에 동기로 claim한다(4차 리비전 · A/P1).** 이전 판은 `send`가 상태를
 *   본 뒤 `invoke`가 **비동기 경계 검증이 끝난 다음에야** 세션을 점유했다 → 겹친 두 `send`가 둘 다 통과해
 *   같은 UUID·`CODEX_HOME`으로 **중복 resume 프로세스**를 띄우고 큐·child를 서로 덮어쓸 수 있었고,
 *   그 창에서 `stop`이 세션을 지워도 뒤늦게 `running`을 발행하며 **추적되지 않는 프로세스**가 뜰 수 있었다.
 *   이제 ⓐ `starting` 상태 + **단조 증가 generation 토큰**을 동기로 발급하고 ⓑ 겹친 호출은 spawn·발행
 *   없이 `codex_send_overlap`으로 즉시 거부되며 ⓒ **모든 await 뒤와 spawn 직전 동기 게이트에서** 세션 존재 ·
 *   같은 state 객체 · 같은 generation · 미취소를 다시 확인하고 ⓓ `stop`은 **child가 없어도** claim을 취소한다.
 *   낡은 invocation의 정리는 **교체 세션을 지우거나 바꾸지 못한다**(소유권 확인 후에만 상태를 만진다).
 * - **큐·`running` 발행은 동기 게이트 뒤다(4차 리비전).** 발행 전 실패는 이전 invocation의 완료된 큐·
 *   `child`·세션 신원을 **하나도 건드리지 않는다**(거부는 rejected promise로만 나간다).
 * - **유효 실행 옵션은 `start()`에서 봉인한다(재개된 `C-23`).** 호출자 `spec`/`opts`는 매 invocation
 *   동기 진입과 spawn 직전 게이트에서 **필드 단위로 대조**만 되고, 드리프트는 `codex_spec_mutated`
 *   하나로 fail closed다. turn 사이 변조가 **새 baseline이 되지 않는다**.
 *   봉인 대상은 argv·env·경계 입력에 쓰이는 값 **전부**다: 실행 옵션 · 경로 · **시각 권위** ·
 *   **승인 manifest 정규 사본과 그 canonical digest**(대장 `C-28` — 권한 필드까지 turn 사이에 고정된다).
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
import { validateApprovalManifest } from "./approvalManifest.js";
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
 * **대조(===) 대상 필드 전부.** 새 유효 옵션을 더하면 이 목록에도 넣는다.
 * `manifest`만 여기에 없다 — 매 검증이 **새 사본**을 만들어 참조 비교가 불가능하기 때문이고,
 * 그 내용은 `manifestDigest`가 **한 필드도 빠짐없이** 대조한다.
 */
const SEALED_KEYS = [
    "sessionId",
    "model",
    "reasoningEffort",
    "sandbox",
    "codexHome",
    "outputSchemaPath",
    "ephemeral",
    "cwd",
    "executablePath",
    "gitExecutablePath",
    "controllerRepoRoot",
    "milestoneId",
    "approvedCommit",
    "expiresAt",
    "maxSessions",
    "maxTokens",
    "maxElapsedMs",
    "clock",
    "manifestDigest",
];
/**
 * 시각 권위 해석. 함수면 그 참조를 그대로 쓰고(호출은 만료 검사 시점마다), 미지정이면 `Date.now`다.
 * 그 외 타입은 거부한다 — 시각을 읽을 수 없는 상태로 승인 만료를 판정하지 않는다(fail closed).
 * **미지정과 `Date.now` 명시는 같은 값으로 봉인되고, 나중에 함수를 끼워 넣으면 드리프트가 된다.**
 */
function resolveClock(nowMs) {
    if (nowMs === undefined)
        return Date.now;
    if (typeof nowMs !== "function")
        fail("codex_config_invalid", "opts.nowMs는 시각(ms)을 돌려주는 함수여야 한다");
    return nowMs;
}
/**
 * 정규화된 manifest의 **결정론적 digest**. `validateApprovalManifest`가 배열을 정렬·중복 제거하고
 * 키 순서가 고정된 객체를 만들므로 같은 승인은 항상 같은 문자열이 된다.
 * (오류 메시지에는 이 값을 싣지 않는다 — 키 이름만 알린다.)
 */
function manifestDigestOf(m) {
    return JSON.stringify(m);
}
/**
 * 현재 외부에서 도달 가능한 값들로 봉인 스냅샷을 만든다(freeze — 내부에서 다시 바뀌지 않는다).
 * 계약 자체를 어기는 값은 여기서 **먼저** 거부된다(`resolveCodexOptions` · manifest closed 검증 ·
 * 시각 권위 타입). **초기 `start`에서는 그 native 코드가 그대로 호출자에게 간다** —
 * 드리프트 경로에서만 단일 marker로 접힌다(`assertNoSpecDrift`).
 */
function sealCodexSpec(spec, opts) {
    const o = resolveCodexOptions(spec);
    const m = validateApprovalManifest(opts.manifest);
    return Object.freeze({
        ...o,
        sessionId: spec.sessionId,
        cwd: spec.cwd,
        // 실행 파일·git·controller 경로는 여기서 검증하지 않는다(각자의 신뢰 검증이 자기 코드로 보고한다).
        // 봉인은 "turn 사이에 바뀌었는가"만 판정한다.
        executablePath: opts.executablePath,
        gitExecutablePath: opts.gitExecutablePath,
        controllerRepoRoot: opts.controllerRepoRoot,
        milestoneId: m.milestoneId,
        approvedCommit: m.approvedCommit,
        expiresAt: m.expiresAt,
        maxSessions: m.maxSessions,
        maxTokens: m.maxTokens,
        maxElapsedMs: m.maxElapsedMs,
        clock: resolveClock(opts.nowMs),
        manifest: m,
        manifestDigest: manifestDigestOf(m),
    });
}
/**
 * 봉인값 대조. **모든 invocation의 동기 진입**(turn 간 변조)과 **spawn 직전 동기 게이트**
 * (같은 invocation 안의 변조)에서 각각 부른다.
 *
 * **start 이후의 드리프트 marker는 `codex_spec_mutated` 하나다(5차 리비전).** 값이 *바뀐* 경우뿐
 * 아니라 start 시점에 유효했던 값이 *무효가 된* 경우(예: `sandbox`를 `workspace-write`로 바꿔
 * 재해석이 `codex_sandbox_forbidden`을 던지는 경우)도 여기서 같은 marker로 접는다 — 이전 판은
 * 문서로는 단일 marker를 약속하고 실제로는 native 오류를 흘려 **문서와 증거가 어긋났다**.
 * 초기 `start`의 정밀 코드는 영향을 받지 않는다(그 경로는 `sealCodexSpec`을 직접 부른다).
 * 어느 쪽이든 **필드 이름만** 알리고 변조된 값·경로는 오류에 싣지 않는다.
 */
function assertNoSpecDrift(sealed, spec, opts) {
    let now;
    try {
        now = sealCodexSpec(spec, opts);
    }
    catch {
        fail("codex_spec_mutated", "봉인된 실행 옵션이 start 이후 무효가 됐다");
    }
    for (const k of SEALED_KEYS) {
        if (now[k] !== sealed[k])
            fail("codex_spec_mutated", `봉인된 실행 옵션이 start 이후 바뀌었다: ${k}`);
    }
}
/**
 * argv 컴파일. `resumeSessionId`가 있으면 **resume 배치**를 쓴다:
 * `--sandbox`/`--cd`는 `resume` **앞**(부모 위치)에 두고, resume-local 지원 플래그만 뒤에 둔다.
 * resume id는 **정규 UUID**여야 한다 — 검증되지 않은 텍스트로 인자를 만들지 않는다(`--last` 금지).
 * 순수 함수 — 테스트가 argv를 정확히 고정한다.
 */
export function compileCodexArgs(spec, cwd, resumeSessionId) {
    return compileResolvedArgs(resolveCodexOptions(spec), cwd, resumeSessionId);
}
/** provider 내부 경로: **봉인된 해석값**으로만 argv를 만든다(호출자 객체를 다시 읽지 않는다). */
function compileResolvedArgs(o, cwd, resumeSessionId) {
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
/**
 * 이 핸들이 **정확히 이 세션 인스턴스**에 발급된 것인가(5차 리비전).
 * 판정은 **불투명 신원 객체의 참조 동일성 하나**다 — `sessionId`(교체 세션과 같다)나 가변 `spec`
 * 내용(호출자가 언제든 바꾼다)은 근거가 되지 못한다. provider가 발급하지 않은 핸들은 신원이 없으므로
 * 항상 false다(fail closed).
 */
function isBoundTo(handle, state) {
    return !!handle && handle.providerBinding === state.binding;
}
export class CodexCliProvider {
    opts;
    id = "codex-cli";
    sessions = new Map();
    spawnFn;
    /** invocation generation 발급기 — 단조 증가하며 재사용되지 않는다. */
    nextGen = 1;
    constructor(opts) {
        this.opts = opts;
        // spawn seam은 **여기서 한 번** 포착한다 — 이후 `opts.spawn`을 바꿔도 실행 대상은 바뀌지 않는다.
        this.spawnFn = opts.spawn ?? nodeSpawn;
    }
    async start(spec, initialPrompt) {
        if (typeof spec?.sessionId !== "string" || spec.sessionId.length === 0) {
            fail("codex_config_invalid", "spec.sessionId가 필요하다");
        }
        if (this.sessions.has(spec.sessionId))
            fail("codex_session_exists", `harness 세션 id가 이미 있다: ${spec.sessionId}`);
        // 설정·승인 거부는 상태를 만들기 전에 일어난다. 통과하면 그 해석값이 이 세션의 **봉인 baseline**이다.
        const sealed = sealCodexSpec(spec, this.opts);
        const state = {
            sessionId: spec.sessionId,
            binding: Object.freeze({}),
            sealed,
            spec,
            queue: new AsyncEventQueue(),
            child: null,
            status: "idle",
            settled: Promise.resolve(),
            gen: 0,
            cancelled: false,
            codexSessionId: "",
            homeId: null,
            poisoned: "",
        };
        this.sessions.set(state.sessionId, state);
        try {
            await this.invoke(state, undefined, initialPrompt);
        }
        catch (err) {
            // 실패한 start는 상태를 남기지 않는다 — 단 **내 세션일 때만** 지운다.
            // stop 뒤에 같은 id로 만들어진 교체 세션을 낡은 invocation의 정리가 지우면 안 된다.
            if (this.sessions.get(state.sessionId) === state)
                this.sessions.delete(state.sessionId);
            throw err;
        }
        // 핸들은 **이 인스턴스에만** 유효하다. `providerBinding`을 들고 있는 쪽만 이 세션을 조종한다.
        return Object.freeze({ sessionId: state.sessionId, spec, providerBinding: state.binding });
    }
    /**
     * 후속 지시 = `codex exec … resume <관측된 UUID>`. 관측 전·ephemeral·실행 중·오염 세션은 거부한다.
     * **핸들 신원이 먼저다**: 낡은·위조 핸들은 대상 세션을 읽지도 건드리지도 않고 `codex_stale_handle`이다.
     */
    async send(handle, message) {
        const state = this.requireState(handle);
        if (state.poisoned)
            fail(state.poisoned, "세션이 프로토콜 위반으로 닫혔다");
        // `starting`(claim 후 spawn 전)도 실행 중으로 본다 — 겹친 send는 **동기로** 거부되고 spawn 0이다.
        if (state.status === "starting" || state.status === "running") {
            fail("codex_send_overlap", "이전 invocation이 아직 실행 중이다");
        }
        if (state.status === "stopped")
            fail("codex_session_stopped", "중지된 세션에는 보낼 수 없다");
        if (state.sealed.ephemeral) {
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
     * **child가 아직 없는 claim(`starting`)도 여기서 취소된다** — 그 invocation은 경계 작업이 끝나도
     * 발행·spawn을 하지 못하고 거부된다(예전에는 그 창에서 추적되지 않는 프로세스가 뜰 수 있었다).
     * **낡은 핸들의 `stop`은 무해·멱등이다(5차 리비전)**: 같은 id에 이미 **교체 세션**이 있으면
     * signal·close·상태 변경·삭제를 **하나도** 하지 않고 조용히 돌아온다(없는 세션 stop과 같은 취급).
     * 프로세스 그룹·TERM→유예→KILL·자손 정리는 이 범위가 아니다(대장 `C-18`, M5c).
     * ponytail: 여기서는 SIGTERM 1회 + settle 대기까지만 — 강제 종료 사다리는 M5c에서 붙인다.
     */
    async stop(handle, _reason) {
        const state = this.lookup(handle);
        if (!state || !isBoundTo(handle, state))
            return; // 멱등 + 교체 세션 보호(낡은 핸들은 아무것도 하지 않는다)
        state.cancelled = true; // child가 없어도 진행 중 claim을 무효화한다
        if (state.status === "running") {
            state.child?.kill("SIGTERM");
            await state.settled; // 종료 result 1건이 큐에 들어간 뒤에만 정리한다
        }
        state.status = "stopped";
        state.queue.close();
        // 그 사이 같은 id로 만들어진 **교체 세션은 지우지 않는다**(stop 멱등 + 교체 안전).
        if (this.sessions.get(state.sessionId) === state)
            this.sessions.delete(state.sessionId);
    }
    /** 핸들이 가리키는 id의 **현재** 세션(있으면). 신원 대조는 하지 않는다 — 그건 호출부의 몫이다. */
    lookup(handle) {
        return handle && typeof handle.sessionId === "string" ? this.sessions.get(handle.sessionId) : undefined;
    }
    /**
     * 상태 조회 + **핸들 신원 대조**. 두 거부를 구분한다:
     * - 그 id에 세션이 없다 → `codex_unknown_session`(기존 semantics 그대로).
     * - 세션은 있는데 **이 핸들이 발급된 인스턴스가 아니다**(stop 후 같은 id로 만들어진 교체 세션 ·
     *   위조·복제 핸들) → `codex_stale_handle`. **읽기·발행·spawn·변경·삭제 없이** 즉시 닫는다.
     */
    requireState(handle) {
        const state = this.lookup(handle);
        if (!state)
            fail("codex_unknown_session", "없는 세션이다");
        if (!isBoundTo(handle, state))
            fail("codex_stale_handle", "이 핸들은 현재 세션 인스턴스의 것이 아니다");
        return state;
    }
    /**
     * **첫 await 전 동기 소유권 claim.** generation을 발급하고 상태를 `starting`으로 올린다 →
     * 이 순간부터 겹친 start/send는 `codex_send_overlap`으로 즉시 거부되고(spawn 0, 큐·child 교체 없음),
     * `stop`은 child가 없어도 이 claim을 취소할 수 있다.
     */
    claim(state) {
        if (state.status !== "idle")
            fail("codex_send_overlap", "이 세션에는 이미 진행 중인 invocation이 있다");
        state.cancelled = false;
        state.gen = this.nextGen++;
        state.status = "starting";
        return state.gen;
    }
    /** 아직 이 invocation이 소유자인가: 세션 존재 · **같은 state 객체** · 같은 generation · 미취소 · 미중지. */
    owns(state, gen) {
        return (this.sessions.get(state.sessionId) === state && state.gen === gen && !state.cancelled && state.status !== "stopped");
    }
    assertOwned(state, gen) {
        if (!this.owns(state, gen))
            fail("codex_invocation_cancelled", "이 invocation은 무효화됐다(stop 또는 세션 교체)");
    }
    /**
     * 한 invocation. **소유권 claim이 첫 문장이고, 발행은 마지막이다**:
     * `동기 claim → 동기 사전 검증 → 비동기 경계 확인 → 동기 pre-spawn 게이트 → 큐/running 발행 → spawn`.
     *
     * 발행을 게이트 뒤로 옮긴 이유(독립 리뷰 A/P1): 예전 판은 게이트 **전에** 새 큐와 `running`을
     * 발행했으므로 검증 실패가 **이전 invocation의 완료된 큐를 교체**하고 가짜 종료 결과를 하나 더 냈다
     * (주석은 "기존 큐·상태는 그대로"라고 말했다 — 구현과 문서가 어긋났다). 이제 발행 전 실패는
     * 큐·`child`·세션 신원을 **하나도 건드리지 않고** claim만 되돌린다(호출자는 rejected promise로 받는다).
     * 발행 이후의 실패(동기 spawn 예외)만 그 invocation의 **bounded 스트림**을 종료 결과 1건으로 닫는다.
     */
    async invoke(state, resumeSessionId, prompt) {
        // 프롬프트 계약 위반은 claim 전에 거부한다(세션 상태를 건드리지 않는다).
        if (typeof prompt !== "string" || prompt.length === 0)
            fail("codex_prompt_invalid", "프롬프트가 비어 있다");
        if (prompt.length > MAX_PROMPT_CHARS)
            fail("codex_prompt_too_long", `프롬프트는 ${MAX_PROMPT_CHARS}자 이하여야 한다`);
        const gen = this.claim(state); // 첫 await 전 동기 claim — 겹친 호출은 여기서 갈린다
        try {
            await this.runInvocation(state, gen, resumeSessionId, prompt);
        }
        catch (err) {
            // 발행 전 실패는 **내 claim만** 되돌린다. 발행 뒤라면 `settle`이 이미 상태를 정리했고,
            // 세션이 교체됐다면(`owns` false) 아무것도 건드리지 않는다.
            if (state.status === "starting" && this.owns(state, gen))
                state.status = "idle";
            throw err;
        }
    }
    /**
     * claim된 invocation 본체. 사전 검증은 계약 위반을 **비동기 작업 전에** 걸러내기 위한 것이고,
     * **신뢰 판정의 근거는 게이트다**: 소유권·봉인 spec·홈·실행 파일·git·승인 커밋·만료를
     * **await가 하나도 남지 않은 상태에서** 한 번에 다시 본다.
     */
    async runInvocation(state, gen, resumeSessionId, prompt) {
        const s = state.sealed; // 권위는 봉인값이다 — 아래 어디서도 `state.spec`의 값으로 실행하지 않는다
        // ── 사전 검증(빠른 거부 + 신원 고정) ──────────────────────────────────
        // turn 사이 변조는 여기서 먼저 걸린다(`C-23`): 호출자 객체가 새 baseline이 되지 못한다.
        assertNoSpecDrift(s, state.spec, this.opts);
        const homeExpect = state.homeId
            ? { identity: state.homeId } // resume: 소유 홈(상태 있음이 정상)
            : { requireEmpty: true }; // 첫 invocation: 빈 홈
        const preHome = verifyCodexHome(s.codexHome, homeExpect);
        const preBin = verifyCodexExecutable(s.executablePath);
        // 대장 `B-5`: 승인된 커밋이 controller/실행 checkout HEAD와 정확히 같을 때만 프로세스를 띄운다.
        const boundary = await verifyExecutionBoundary({
            // **봉인된 승인 사본**이다(`this.opts.manifest`를 다시 읽지 않는다 — 갈아끼운 승인이 경계 판정에
            // 끼어들 통로를 없앤다). 경계는 이 사본을 자기 규칙으로 다시 검증한다.
            manifest: s.manifest,
            controllerRepoRoot: s.controllerRepoRoot,
            targetWorktree: s.cwd,
            gitExecutablePath: s.gitExecutablePath,
            // **봉인된 시각 권위**를 함수로 넘긴다 — 경계는 진입과 spawn 직전 재검증에서 이 함수를 각각
            // 다시 호출한다(시간은 흐르고, 나중에 교체된 `opts.nowMs`는 여기 오지 못한다).
            nowMs: s.clock,
        });
        // await 직후 첫 문장: 그 사이 `stop`·세션 교체가 있었으면 발행·spawn 없이 끝난다.
        this.assertOwned(state, gen);
        // cwd는 경계가 확인한 targetRoot만 쓴다(호출자 문자열 재사용 금지 — argv와 native cwd 모두).
        const cwd = boundary.targetRoot;
        // 파서에 **기대 세션 신원**을 준다: resume 스트림이 다른 thread를 내면 init·본문이 나가기 전에 봉인된다.
        const parser = new CodexJsonlParser({ model: s.model, cwd, sandbox: s.sandbox, expectedSessionId: resumeSessionId });
        // ── spawn 직전 동기 게이트 ────────────────────────────────────────────
        // 여기부터 spawn까지 **await가 없다.** 비동기 경계 작업 중에 바뀔 수 있는 모든 신뢰 자산을
        // 순서대로 다시 확인한다: ⓪ 소유권(stop·세션 교체) ① 봉인 spec 대조(호출자 객체 변조)
        // ② 승인 만료·git 신원·checkout 신원·HEAD ③ `CODEX_HOME`(정규·비symlink·0700·사용자 홈 아님 +
        // 고정 신원, 첫 invocation은 여전히 비어 있음) ④ codex 실행 파일(신뢰 조건 + 고정 신원 —
        // 같은 권한의 다른 실행 파일 교체까지 거부).
        // 남는 창은 syscall 몇 개 규모다(Node에 `fexecve`·디렉터리 fd 상대 실행이 없다) — 0이라고 주장하지 않는다.
        this.assertOwned(state, gen);
        assertNoSpecDrift(s, state.spec, this.opts);
        boundary.revalidateSync();
        const home = verifyCodexHome(s.codexHome, { ...homeExpect, identity: preHome.id });
        const bin = verifyCodexExecutable(s.executablePath, preBin.id);
        // argv는 **봉인값**으로 컴파일한다(중간에 바뀐 호출자 객체로 인자를 만들지 않는다).
        const args = compileResolvedArgs(s, cwd, resumeSessionId);
        // ── 발행: 검증과 동기 게이트가 전부 끝난 뒤에만 큐/`running`을 바꾼다 ──
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
            // **내 generation일 때만** state를 건드린다 — 교체 세션·다음 invocation을 오염시키지 않는다.
            if (this.sessions.get(state.sessionId) === state && state.gen === gen) {
                state.child = null;
                if (state.status !== "stopped")
                    state.status = "idle";
            }
            resolveSettled();
        };
        this.assertOwned(state, gen); // 발행·spawn 직전 마지막 확인(여기서 spawn까지 await 없음)
        state.queue = queue;
        state.settled = settledPromise;
        state.status = "running";
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
