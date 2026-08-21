/**
 * V3 M5a — `codex exec` 어댑터 (로드맵 §7.1의 `CodexCliProvider`).
 *
 * 기존 `ExecutionProvider` 계약을 그대로 구현한다 — **두 번째 오케스트레이터·상태 시스템을 만들지 않는다.**
 * 세션 수명 모델은 `ClaudeCliProvider`와 같다(호출당 프로세스 1개, 후속 turn은 resume).
 *
 * 확정 계약(2026-07-27 fresh Codex 리뷰 · 2·3·4·5차 리비전 + M5b controller 배선 전 정리 반영):
 * - **프로토콜 실패로 끝난 turn 뒤에는 resume이 없다(M5b · 대장 `C-21`).** 파서가 비가역 실패를 기록한
 *   invocation이 닫히면 세션도 `codex_protocol_failed`로 닫는다 → 후속 `send`는 **spawn 0**이다.
 *   판정을 호출자의 `result.isError` 확인에만 맡기지 않는다(`B-8`과 같은 방향의 fail-open 제거).
 * - **`stop()`은 취소된 invocation이 정착한 뒤에 반환한다(M5b · 대장 `C-27`).** 호출자에게 준 promise를
 *   취소 신호와 race시키고 그 결과에 항상 handler를 붙이므로, **`stop` 하나만 await해도** 나중에 뜨는
 *   unhandled rejection이 없고 `stop`이 진행 중 git 조회에 매달리지도 않는다.
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
 * - **증명은 메서드가 아니라 "설정 신원"까지 본다(5차 리비전 · A1/P1).** 이전 판은 executor가 진짜
 *   `spawn`이기만 하면 **숨은 설정과 무관하게** 증명했으므로, 사용자 소유 0700 스크립트를
 *   `executablePath`로 준 인스턴스도(`/bin/echo`·`/bin/true` 포함) read-only bridge를 지날 수 있었다 —
 *   argv를 무시하고 쓰기·네트워크·hard deny 작업을 하는 native 코드가 승인 경계 안에서 돌 수 있었다.
 *   지금 production 분기는 생성 시점에 **codex 실행 파일 · git 실행 파일 · controller checkout ·
 *   승인 canonical digest · 시각 권위**를 런타임 검증해 **불변 스냅샷**으로 고정하고(검증 불가면 생성
 *   자체가 실패한다), `attestReadOnlyCodexProvider(provider, expected)`는 **호출자가 스스로 검증해 온
 *   기대 권위와의 대조 결과만** 알려 준다. 신원 객체는 밖으로 나가지 않으므로 "임의 실행 파일을 든
 *   provider"에 대해 승인처럼 읽히는 답이 없다. 실행 파일·git 신원은 **매 invocation 그 스냅샷으로**
 *   다시 확인하므로 첫 invocation이 새 baseline을 세우지 않는다.
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
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { validateApprovalManifest } from "./approvalManifest.js";
import { CODEX_SESSION_ID_RE, CodexJsonlParser } from "./codexStreamParser.js";
import {
  verifyApprovedExecutable,
  verifyExecutionBoundary,
  type FileIdentity,
  type TrustedExecutable,
  type VerifiedExecutionBoundary,
} from "./executionBoundary.js";
import { OrchestrationError, type ApprovedExecutable, type MilestoneApprovalManifest } from "./orchestrationTypes.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";

/** 프롬프트 상한(문자). 넘으면 stdin에 쓰지 않고 거부한다. */
export const MAX_PROMPT_CHARS = 262_144;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** 리뷰 기본값 — 로드맵 §6 모델 정책·§7.1 실행 계약. sandbox는 M5a에서 이 값 외에 없다. */
export const CODEX_REVIEW_DEFAULTS = { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "read-only" } as const;

/** `child_process.spawn` 시그니처의 최소 부분집합 (테스트 주입용 in-process seam). */
export type SpawnFn = (
  command: string,
  args: string[],
  /** `B-7ⓑ`: stdio[2]는 **타입 수준에서** `"ignore"`다 — 자식 stderr를 pipe로 받는 코드는 컴파일되지 않는다. */
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "ignore"] },
) => ChildProcess;

/**
 * **production executor — 모듈 적재 시점에 한 번 포착한 진짜 `node:child_process.spawn` binding**
 * (2026-07-28 3차 독립 리뷰 A1). 모듈 사설 `const`이므로 밖에서 재대입·`defineProperty`로 바꿀 수 없고,
 * CJS builtin exports 객체를 나중에 변조해도 여기 값은 바뀌지 않는다. 증명된(attested) 인스턴스는
 * **오직 이 값만** 실행한다.
 */
const PRODUCTION_SPAWN: SpawnFn = nodeSpawn as unknown as SpawnFn;

export interface CodexCliProviderOpts {
  /** 승인 manifest(원본). 프로세스 시작 직전마다 다시 검증된다. */
  manifest: unknown;
  /** 판정 계약을 들고 있는 controller checkout 절대·정규 경로. */
  controllerRepoRoot: string;
  /**
   * **실행 파일 경로 옵션은 없다(6차 리뷰 A1).** codex·git 실행 파일의 정규 경로와 내용 digest는
   * `manifest.executionAuthority`에서만 오고, 그 manifest는 run 생성 시 승인돼 durable state에
   * 봉인된 값이다 → 호출자가 실행 대상을 고를 통로가 존재하지 않는다.
   */
  /**
   * **하위 계층 provider 단위 테스트 전용 in-process seam.** production 진입점은 지정하지 않는다.
   *
   * **이 필드를 준 인스턴스는 어떤 경우에도 read-only 증명을 받지 못한다**(2026-07-28 3차 독립 리뷰 A1).
   * 이전 판은 `opts.spawn ?? nodeSpawn`을 포착한 **모든** 인스턴스를 증명 등록부에 넣었으므로,
   * argv·env를 무시하고 임의 쓰기·명령·네트워크를 하는 callback을 주입한 provider가 read-only bridge를
   * 그대로 지날 수 있었다(= 공개 API만으로 증명 위조). 지금 이 seam이 있는 인스턴스는 **untrusted**이며
   * `attestReadOnlyCodexProvider`가 `null`을 돌려준다 → `StableController`가 생성 자체를 거부한다.
   * 함수가 아닌 값은 `codex_config_invalid`다.
   */
  spawn?: SpawnFn;
  /**
   * 만료 판정용 시각(ms) 주입. 미지정 시 `Date.now`.
   * **`start()`에서 봉인된다(5차 리비전)** — 모든 만료 검사는 그때 포착한 함수를 **매번 다시 호출**하고,
   * 이후 이 필드를 교체·제거·추가하면 `codex_spec_mutated`로 fail closed다. 갈아끼운 시계로 만료된
   * 승인을 되살릴 수 없다. 함수가 아닌 값은 `codex_config_invalid`로 거부한다.
   */
  nowMs?: () => number;
}

function fail(code: string, message: string): never {
  throw new OrchestrationError(code, message);
}

function requireAbsolute(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.includes("\0") || !isAbsolute(v)) {
    fail("codex_config_invalid", `${what}는 NUL 없는 절대경로여야 한다`);
  }
  return v as string;
}

const CODEX_BIN_CODES = {
  path: "codex_config_invalid",
  invalid: "codex_executable_invalid",
  identity: "codex_executable_identity_changed",
  /** 승인된 내용과 다르다(같은 inode 제자리 덮어쓰기 포함 — 6차 리뷰 A1). */
  digest: "codex_executable_digest_mismatch",
} as const;

/** 경계가 쓰는 git 실행 파일을 **provider 생성 시점에도** 같은 규칙으로 검증한다(신원 고정용). */
const GIT_BIN_CODES = {
  path: "codex_config_invalid",
  invalid: "codex_git_executable_invalid",
  identity: "codex_git_executable_identity_changed",
  digest: "codex_git_executable_digest_mismatch",
} as const;

/**
 * codex 실행 파일 신원 검증(경계와 **같은 구현**을 쓴다): 정규 · symlink 아님 · 일반 파일 ·
 * 실행 비트 · group/other 쓰기 없음, 그리고 `pinned`를 주면 **신원(dev+ino)** 까지 같아야 한다.
 * 사전 검증에서 신원을 고정하고 **spawn 직전 동기 게이트에서 다시** 부른다 — 같은 권한의 다른 실행 파일로
 * 교체되는 창까지 막는다(Node에 `fexecve`가 없어 창은 0이 아니고 syscall 몇 개로 줄인 것이다).
 */
export function verifyCodexExecutable(approved: ApprovedExecutable | null, pinned?: FileIdentity): TrustedExecutable {
  // **승인이 codex를 담지 않았으면 fail closed다**(V3 M5c): M5c offline manifest는 `codex: null`로
  // "live 추론은 승인되지 않았다"를 정직하게 표현한다. 그 승인으로는 provider가 만들어지지 않는다.
  if (approved === null) {
    throw new OrchestrationError("codex_not_approved", "이 승인 manifest는 codex 실행 권위를 담지 않는다(live 추론 미승인)");
  }
  return verifyApprovedExecutable(approved, "승인된 codex 실행 파일", CODEX_BIN_CODES, pinned);
}

/** provider가 소유한 `CODEX_HOME`의 신원 — 경로 문자열이 아니라 이것으로 "같은 홈인가"를 판정한다. */
export interface CodexHomeIdentity {
  dev: number;
  ino: number;
}

/**
 * **승인된 격리 `CODEX_HOME`에서 허용되는 유일한 항목**(대장 `B-7ⓐ`). 사람이 1회 `codex login`으로
 * 만드는 자격증명 파일 이름이며, harness는 **존재·타입·권한·소유자만** 본다(열지 않는다).
 * 목록에 없는 항목이 하나라도 있으면 첫 invocation은 여전히 `codex_home_not_empty`다 —
 * `config.toml`·MCP 정의·AGENTS 파일이 자격증명 뒤에 묻어 들어올 통로를 열지 않는다.
 */
export const CODEX_CREDENTIAL_FILES = ["auth.json"] as const;

/**
 * **승인된 격리 홈의 최상위에서 허용되는 codex 런타임 디렉터리**(대장 `B-23` 실측, 2026-08-11).
 *
 * `codex login`(v0.146.0-alpha.3) 실측 결과 홈에 생기는 것은 `auth.json` 하나가 아니었다:
 * `log/`(+`log/codex-login.log`) · `tmp/`(+`tmp/arg0`)가 함께 만들어지고, 이후 실행마다 **내용이 자란다**.
 * 그래서 계약을 "파일 하나 허용"에서 **"최상위 이름 allowlist"** 로 넓히되 성질은 그대로 유지한다:
 *
 * - **내용을 재귀 검사하지 않는다** — 이 두 디렉터리 안은 codex가 소유하는 런타임 산출물이고 harness가
 *   의미를 알지 못한다. 열지도 해싱하지도 않는다.
 * - **넓힌 것은 이름 2개뿐이다.** `config.toml` · `AGENTS.md` · MCP 정의처럼 **동작을 바꾸는 항목**은
 *   최상위에서 여전히 거부된다 — 그것이 이 게이트의 존재 이유이고 실측으로도 그 이름들은 생기지 않았다.
 * - 실측에서 두 디렉터리는 **0755**였다. 홈 자체가 0700이라 다른 uid는 홈을 통과하지 못하므로 여기서
 *   0700을 강제하지 않는다(강제하면 정상 codex 사용이 매번 거부될 뿐 얻는 것이 없다).
 */
export const CODEX_RUNTIME_DIRS = ["log", "tmp"] as const;

/** `verifyCodexHome`에 넘기는 기대치. 세 축이 **독립**이다: 신원 일치 / 비어 있음 / 승인된 홈. */
export interface CodexHomeExpectation {
  /**
   * 승인 manifest가 고정한 홈(`executionAuthority.codexHome`). 주면 ⓐ 경로가 **정확히 같아야** 하고
   * ⓑ 소유자가 이 프로세스여야 하며 ⓒ "비어 있음"이 **"승인된 자격증명 파일 외에는 비어 있음"** 으로
   * 좁혀지고 그 자격증명이 **반드시 있어야** 한다. 주지 않으면(=승인이 live 인증을 담지 않았다)
   * 기존 계약 그대로 **완전히 비어 있어야** 한다. 어느 쪽도 `~/.codex`·ambient env로 내려가지 않는다.
   */
  approved?: { path: string } | null;
  /** 이 신원과 같아야 한다(사전 검증에서 확보한 신원 또는 이미 소유한 홈). */
  identity?: CodexHomeIdentity;
  /**
   * 비어 있어야 하는가. 기본값은 "`identity`가 없으면 요구"다 —
   * **첫 invocation은 사전·spawn 직전 두 번 모두 빈 홈을 요구**하고(그때 `identity`도 함께 준다),
   * resume은 소유 신원만 요구한다(codex가 남긴 상태가 있어야 정상이다).
   */
  requireEmpty?: boolean;
}

/**
 * 격리 `CODEX_HOME` 검증 — **provider 소유 수명**이다.
 *
 * - **첫 invocation**: 절대·정규·비-symlink 디렉터리 · 0700 · **비어 있음** · 사용자 홈 아님.
 *   비어 있음을 요구하는 이유는 첫 프로세스가 ambient config·auth·MCP 정의를 하나도 못 보게 하려는 것이다.
 *   **`B-7ⓐ`(live 인증)**: 승인 manifest가 `executionAuthority.codexHome`으로 홈을 고정한 경우에만
 *   "비어 있음"이 **"승인된 자격증명 파일(`auth.json`) 외에는 비어 있음"** 으로 좁혀진다. 이때
 *   ⓐ 경로가 승인된 홈과 **정확히 같아야** 하고 ⓑ 홈·자격증명 모두 **이 프로세스 소유**여야 하며
 *   ⓒ 자격증명은 정규 파일·비symlink·group/other 비트 0이어야 하고 ⓓ **없으면 거부**한다
 *   (`codex_home_credentials_missing` — 인증 없이 프로세스를 띄우지 않는다). 그 밖의 항목이 하나라도
 *   있으면 여전히 `codex_home_not_empty`이므로 `config.toml`·MCP 정의·AGENTS 파일이 자격증명 뒤에
 *   묻어 들어오지 못한다. 승인이 홈을 담지 않았으면 **완전히 비어 있어야** 한다(자식 env는 `CODEX_HOME`
 *   하나뿐이라 ambient 자격증명이 도달할 통로가 없다 → 인증 없이 fail closed이고, `~/.codex`로의
 *   fallback은 어느 경로에도 존재하지 않는다). 자격증명은 **열지 않는다** — 존재·타입·권한·소유자만 본다.
 *   여기서 확보한 신원(dev+ino)이 그 홈에 대한 provider의 **소유권**이고, **spawn 직전 동기 게이트에서
 *   같은 신원 + 여전히 비어 있음**을 다시 확인한다(비동기 경계 작업 중 교체·오염을 막는다).
 * - **resume**: 경로 계약·권한·사용자 홈 금지는 **그대로** 요구하고 **소유 신원이 같아야** 한다.
 *   같을 때만 **codex가 남긴 세션 상태를 허용**한다(resume은 그 상태를 필요로 한다). 홈이 교체·symlink화·
 *   권한 완화되면 거부하고, provider가 소유하지 않은 기존 상태로는 resume하지 않는다
 *   (그 경로는 첫 검증에서 `codex_home_not_empty`로 막힌다).
 *
 * 어느 경우에도 `--strict-config`·`--ignore-user-config`·`--ignore-rules`·`mcp_servers={}`는 유지되므로
 * 홈에 무엇이 생기든 ambient MCP·사용자 설정을 상속하지 않는다. **auth를 복사·영속화·해싱·기록하지 않는다**
 * — live 인증(`B-7ⓐ`)은 사람이 승인된 홈에 **1회** 로그인해 두는 방식이고 harness는 그 로그인을 대행·
 * 자동화·프록시하지 않는다.
 * 같은 uid로 동작하는 공격자를 막지는 못한다(소유자 자신은 언제든 홈을 쓸 수 있다) — 막는 것은 **경로 교체·
 * 권한 완화·소유하지 않은 상태로의 resume**이다.
 */
export function verifyCodexHome(path: unknown, expect: CodexHomeExpectation = {}): { path: string; id: CodexHomeIdentity } {
  const owned = expect.identity;
  const approved = expect.approved ?? null;
  const requireEmpty = expect.requireEmpty ?? owned === undefined;
  const p = requireAbsolute(path, "spec.codex.codexHome");
  // `B-7ⓐ`: 승인이 홈을 고정했으면 **그 경로 하나뿐**이다. 다른 홈으로의 fallback이 없다
  // (경로만 대조하고 값은 오류에 싣지 않는다). 승인이 홈을 담지 않았으면 자격증명도 허용되지 않는다.
  if (approved && p !== approved.path) {
    fail("codex_home_not_approved", "codexHome이 승인 manifest가 고정한 격리 홈이 아니다");
  }
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    fail("codex_home_invalid", "codexHome의 realpath를 확인할 수 없다");
  }
  if (real !== p) fail("codex_home_invalid", "codexHome은 정규 경로여야 한다(symlink 금지)");

  let userHome = "";
  try {
    userHome = realpathSync(homedir());
  } catch {
    userHome = "";
  }
  if (userHome && (p === userHome || p === join(userHome, ".codex"))) {
    fail("codex_home_ambient", "codexHome으로 사용자 홈(또는 ~/.codex)을 쓸 수 없다");
  }

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    fail("codex_home_invalid", "codexHome의 상태를 확인할 수 없다");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail("codex_home_invalid", "codexHome은 symlink 아닌 디렉터리여야 한다");
  if ((st.mode & 0o077) !== 0) fail("codex_home_permissive", "codexHome은 0700(소유자 전용)이어야 한다");
  // 승인된(=자격증명이 들어 있는) 홈은 **이 프로세스 소유**여야 한다. 다른 uid가 만든 홈을 승인 경로에
  // 갖다 놓는 형태의 hijack을 막는다(비승인 홈에는 기존 계약을 그대로 두어 관측 가능한 변화가 없다).
  if (approved) assertOwnedByThisUser(st.uid, "codexHome");

  const id: CodexHomeIdentity = { dev: st.dev, ino: st.ino };
  if (owned && (id.dev !== owned.dev || id.ino !== owned.ino)) {
    fail("codex_home_identity_changed", "codexHome의 디렉터리 신원이 검증 이후 바뀌었다");
  }
  if (!requireEmpty) return { path: p, id };

  let entries: string[];
  try {
    entries = readdirSync(p);
  } catch {
    fail("codex_home_invalid", "codexHome을 읽을 수 없다");
  }
  // 승인이 홈을 고정하지 않았다 = live 인증 미승인 → **완전히 비어 있어야** 한다(기존 계약 그대로).
  // 승인된 홈이면 자격증명 + codex 런타임 디렉터리(`B-23` 실측)만 허용한다.
  const allowed: readonly string[] = approved ? [...CODEX_CREDENTIAL_FILES, ...CODEX_RUNTIME_DIRS] : [];
  const extra = entries.filter((e) => !allowed.includes(e)).length;
  if (extra > 0) {
    // 개수만 알린다 — 파일 이름은 오류 문자열에 싣지 않는다.
    fail("codex_home_not_empty", `codexHome에 승인되지 않은 설정/자격증명 항목이 있다(${extra}건)`);
  }
  // 승인된 홈은 **자격증명이 실제로 있어야** 한다: 없으면 인증 없이 프로세스를 띄우지 않는다(fail closed).
  // 런타임 디렉터리는 **있어도 되고 없어도 된다**(첫 로그인 전에는 없다) — 있으면 타입만 본다.
  if (approved) {
    for (const name of CODEX_CREDENTIAL_FILES) verifyCredentialFile(join(p, name));
    for (const name of CODEX_RUNTIME_DIRS) verifyRuntimeDir(join(p, name));
  }
  return { path: p, id };
}

/**
 * 허용된 codex 런타임 디렉터리 1건(`B-23`). **없으면 통과**(첫 로그인 전에는 존재하지 않는다).
 * 있으면 ⓐ symlink가 아닌 디렉터리이고 ⓑ 이 프로세스 소유여야 한다 — 다른 uid가 만든 디렉터리를
 * 승인된 홈에 갖다 놓는 형태를 막는다. **내용은 열지도 세지도 않는다**(codex 소유 산출물이다).
 */
function verifyRuntimeDir(dir: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return; // 아직 없다 — 정상이다.
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail("codex_home_invalid", "codex 런타임 항목은 symlink 아닌 디렉터리여야 한다");
  assertOwnedByThisUser(st.uid, "codex 런타임 디렉터리");
}

/** 현재 프로세스 uid 소유가 아니면 거부. uid를 노출하지 않는다(대상 이름만 알린다). */
function assertOwnedByThisUser(uid: number, what: string): void {
  const self = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (self === undefined || uid !== self) fail("codex_home_not_owned", `${what}은 이 프로세스 소유여야 한다`);
}

/**
 * 승인된 자격증명 파일 1건(대장 `B-7ⓐ`). **내용은 절대 열지 않는다** — `lstat` 한 번으로 존재 · 정규 파일 ·
 * symlink 아님 · group/other 비트 0 · 소유자만 본다. 내용을 읽거나 해싱하면 그 순간 digest·로그·기록이
 * 자격증명 유출 경로가 되므로(`B-7ⓑ`가 stderr에서 막은 것과 같은 종류) 이 함수는 fd를 열지 않는다.
 */
function verifyCredentialFile(file: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    fail("codex_home_credentials_missing", "승인된 격리 홈에 자격증명이 없다(사람이 1회 `codex login`을 해야 한다)");
  }
  if (st.isSymbolicLink() || !st.isFile()) fail("codex_home_invalid", "자격증명은 symlink 아닌 정규 파일이어야 한다");
  if ((st.mode & 0o077) !== 0) fail("codex_home_permissive", "자격증명 파일에 group/other 권한이 있으면 안 된다");
  assertOwnedByThisUser(st.uid, "자격증명 파일");
}

/** 최초 상태(비어 있어야 하는) 검증만 필요한 호출자용 shim. */
export function assertIsolatedCodexHome(path: unknown): string {
  return verifyCodexHome(path).path;
}

export interface ResolvedCodexOptions {
  model: string;
  reasoningEffort: (typeof EFFORTS)[number];
  sandbox: "read-only";
  codexHome: string;
  outputSchemaPath?: string;
  ephemeral: boolean;
}

/** spec의 codex 옵션을 fail-closed로 정규화한다. 계약 밖 값은 기본값으로 눙치지 않고 거부한다. */
export function resolveCodexOptions(spec: SessionSpec): ResolvedCodexOptions {
  const o = spec.codex;
  if (!o || typeof o !== "object") {
    fail("codex_config_isolation_required", "spec.codex(격리된 codexHome 포함)가 필요하다");
  }
  const model = spec.model ?? CODEX_REVIEW_DEFAULTS.model;
  if (!MODEL_RE.test(model)) fail("codex_config_invalid", "spec.model이 모델 이름 형식이 아니다");

  const reasoningEffort = o.reasoningEffort ?? CODEX_REVIEW_DEFAULTS.reasoningEffort;
  if (!EFFORTS.includes(reasoningEffort)) fail("codex_config_invalid", `reasoningEffort는 ${EFFORTS.join("|")} 중 하나여야 한다`);

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
function sharedFlags(o: ResolvedCodexOptions): string[] {
  const args = ["--json", "--model", o.model];
  args.push("--config", `model_reasoning_effort="${o.reasoningEffort}"`);
  // ambient 사용자 MCP 서버를 명시적으로 비운다(CODEX_HOME 격리와 이중 방어).
  args.push("--config", "mcp_servers={}");
  args.push("--strict-config", "--ignore-user-config", "--ignore-rules");
  if (o.outputSchemaPath) args.push("--output-schema", o.outputSchemaPath);
  return args;
}

/**
 * `start()`에서 **봉인**하는 유효 실행 옵션 스냅샷 (대장 `C-23` — 재개 후 최종 해소).
 *
 * 이전 판은 호출자 소유 `spec`을 그대로 들고 있다가 **매 turn `resolveCodexOptions(state.spec)`을 다시**
 * 해석했다 → 첫 turn이 끝난 뒤 `send` 전에 호출자가 객체를 바꾸면 그 값이 **새 baseline**이 됐고
 * (같은 invocation 안의 변조만 스냅샷과 대조됐다) model·`--output-schema`·cwd·홈·실행 파일이
 * 승인된 계약 밖에서 정해질 수 있었다. 이제 provider의 권위는 **이 봉인값 하나**이고, 호출자가 계속
 * 들고 있는 `spec`/`opts` 객체는 **매 invocation 동기 진입 + spawn 직전 동기 게이트에서 필드 단위로
 * 대조**만 된다. 어긋나면 항상 같은 marker인 **`codex_spec_mutated`** 로 fail closed다
 * (필드 이름만 알리고 경로·내용은 오류에 싣지 않는다 — 기존 sanitize 정책 그대로).
 *
 * 비교는 **명시 필드 목록**으로 한다(`JSON.stringify` 키 순서에 의존하지 않는다).
 */
export interface SealedCodexSpec extends ResolvedCodexOptions {
  /** 봉인된 harness 세션 id — map 키·소유권 판정의 근거다. */
  sessionId: string;
  cwd: string;
  controllerRepoRoot: string;
  /** 승인 manifest의 신원 · TTL · 상한. 승인 자체가 turn 사이에 바뀌면 프로세스를 띄우지 않는다. */
  milestoneId: string;
  approvedCommit: string;
  expiresAt: string;
  maxSessions: number;
  maxTokens: number | null;
  maxElapsedMs: number;
  /**
   * 봉인된 **시각 권위**(5차 리비전 · `C-23` 잔여 구멍). `opts.nowMs`(없으면 `Date.now`)를 start에서
   * **한 번 포착한 함수 참조**이며 실행 경계에는 이 함수만 넘긴다. 매 만료 검사에서 **다시 호출**하므로
   * 시간은 자연스럽게 흐른다(시각을 얼리지 않는다). 호출자가 `opts.nowMs`를 나중에 바꾸면 여기 값과
   * 참조가 달라져 **드리프트로 잡힌다** — 갈아끼운 시계가 만료를 되돌리지 못한다.
   */
  clock: () => number;
  /**
   * 검증·정규화된 승인 manifest **사본**(`validateApprovalManifest`가 새 객체를 준다 — 호출자 객체와
   * alias되지 않는다). 실행 경계에는 `this.opts.manifest`가 아니라 **이 값**을 넘긴다: 경계 판정의
   * 근거가 turn 사이·invocation 도중에 갈아끼워질 통로를 없앤다.
   * 참조 비교는 불가능하므로(매 검증이 새 사본을 만든다) 대조는 아래 `manifestDigest`로 한다.
   */
  manifest: MilestoneApprovalManifest;
  /**
   * 위 manifest의 **canonical digest**(정규화 결과의 결정론적 JSON). 승인의 **모든** 필드를 대조 범위에
   * 넣는다 — 신원·TTL·상한뿐 아니라 `writableRoots`·`ownershipByTask`·`allowedCommands`·
   * `allowedDependencies`·`allowedNetworkDomains`·`localMergeAllowed`까지다(대장 `C-28`).
   * 드리프트 오류에는 **키 이름만** 싣는다(digest 내용은 싣지 않는다).
   */
  manifestDigest: string;
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
  "controllerRepoRoot",
  "milestoneId",
  "approvedCommit",
  "expiresAt",
  "maxSessions",
  "maxTokens",
  "maxElapsedMs",
  "clock",
  "manifestDigest",
] as const;

/**
 * 시각 권위 해석. 함수면 그 참조를 그대로 쓰고(호출은 만료 검사 시점마다), 미지정이면 `Date.now`다.
 * 그 외 타입은 거부한다 — 시각을 읽을 수 없는 상태로 승인 만료를 판정하지 않는다(fail closed).
 * **미지정과 `Date.now` 명시는 같은 값으로 봉인되고, 나중에 함수를 끼워 넣으면 드리프트가 된다.**
 */
function resolveClock(nowMs: CodexCliProviderOpts["nowMs"]): () => number {
  if (nowMs === undefined) return Date.now;
  if (typeof nowMs !== "function") fail("codex_config_invalid", "opts.nowMs는 시각(ms)을 돌려주는 함수여야 한다");
  return nowMs;
}

/**
 * 정규화된 manifest의 **결정론적 digest**. `validateApprovalManifest`가 배열을 정렬·중복 제거하고
 * 키 순서가 고정된 객체를 만들므로 같은 승인은 항상 같은 문자열이 된다.
 * (오류 메시지에는 이 값을 싣지 않는다 — 키 이름만 알린다.)
 */
function manifestDigestOf(m: MilestoneApprovalManifest): string {
  return JSON.stringify(m);
}

/**
 * 현재 외부에서 도달 가능한 값들로 봉인 스냅샷을 만든다(freeze — 내부에서 다시 바뀌지 않는다).
 * 계약 자체를 어기는 값은 여기서 **먼저** 거부된다(`resolveCodexOptions` · manifest closed 검증 ·
 * 시각 권위 타입). **초기 `start`에서는 그 native 코드가 그대로 호출자에게 간다** —
 * 드리프트 경로에서만 단일 marker로 접힌다(`assertNoSpecDrift`).
 */
function sealCodexSpec(spec: SessionSpec, opts: CapturedProviderConfig): SealedCodexSpec {
  const o = resolveCodexOptions(spec);
  const m = validateApprovalManifest(opts.manifest);
  return Object.freeze({
    ...o,
    sessionId: spec.sessionId,
    cwd: spec.cwd,
    // 실행 파일 경로는 봉인 대상이 아니다 — **승인 manifest 안에** 있고 `manifestDigest`가 한 필드도
    // 빠짐없이 대조한다(6차 리뷰 A1: 호출자 경로 자체가 없어졌다).
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
function assertNoSpecDrift(sealed: SealedCodexSpec, spec: SessionSpec, opts: CapturedProviderConfig): void {
  let now: SealedCodexSpec;
  try {
    now = sealCodexSpec(spec, opts);
  } catch {
    fail("codex_spec_mutated", "봉인된 실행 옵션이 start 이후 무효가 됐다");
  }
  for (const k of SEALED_KEYS) {
    if (now[k] !== sealed[k]) fail("codex_spec_mutated", `봉인된 실행 옵션이 start 이후 바뀌었다: ${k}`);
  }
}

/**
 * argv 컴파일. `resumeSessionId`가 있으면 **resume 배치**를 쓴다:
 * `--sandbox`/`--cd`는 `resume` **앞**(부모 위치)에 두고, resume-local 지원 플래그만 뒤에 둔다.
 * resume id는 **정규 UUID**여야 한다 — 검증되지 않은 텍스트로 인자를 만들지 않는다(`--last` 금지).
 * 순수 함수 — 테스트가 argv를 정확히 고정한다.
 */
export function compileCodexArgs(spec: SessionSpec, cwd: string, resumeSessionId?: string): string[] {
  return compileResolvedArgs(resolveCodexOptions(spec), cwd, resumeSessionId);
}

/** provider 내부 경로: **봉인된 해석값**으로만 argv를 만든다(호출자 객체를 다시 읽지 않는다). */
function compileResolvedArgs(o: ResolvedCodexOptions, cwd: string, resumeSessionId?: string): string[] {
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
  if (o.ephemeral) args.push("--ephemeral");
  args.push("-"); // 프롬프트는 stdin
  return args;
}

/**
 * 자식 env. **`CODEX_HOME` 하나뿐**이다 — PATH조차 상속하지 않는다(env 유래 production 동작 0).
 * 그래서 사용자 토큰·자격증명·설정 경로가 자식에게 전달될 통로가 없다.
 */
export function compileCodexEnv(codexHome: string): NodeJS.ProcessEnv {
  return { CODEX_HOME: codexHome };
}

/**
 * invocation 수명 상태.
 * - `starting`: **소유권을 claim했고 아직 spawn 전**이다(첫 await 전에 동기로 들어온다).
 *   이 상태에서도 겹친 send·중복 start는 거부되고, `stop`은 child가 없어도 claim을 취소할 수 있다.
 * - `running`: 프로세스가 떴고 큐가 발행됐다.
 */
type SessionStatus = "idle" | "starting" | "running" | "stopped";

interface CodexState {
  /** 봉인된 harness 세션 id. map 키·소유권 판정은 호출자 객체가 아니라 이 값으로 한다. */
  readonly sessionId: string;
  /**
   * 이 **세션 인스턴스**의 불투명 신원(5차 리비전). `start`가 반환한 핸들에만 붙고,
   * 이후 모든 진입점이 참조 동일성으로 대조한다 → 같은 id로 만들어진 **교체 세션**을
   * 낡은 핸들이 조종할 수 없다. 내용이 없는 frozen 객체이므로 새어도 잃을 비밀이 없다.
   */
  readonly binding: object;
  /** **provider의 유일한 권위**(`C-23`). 호출자 `spec`/`opts`는 대조 대상일 뿐이다. */
  readonly sealed: SealedCodexSpec;
  /** 호출자가 준 spec 참조 — **대조 전용**이다. 이 객체의 값으로 실행하지 않는다. */
  readonly spec: SessionSpec;
  queue: AsyncEventQueue<SessionEvent>;
  child: ChildProcess | null;
  status: SessionStatus;
  /** 현재 invocation이 종료 결과를 낼 때까지의 promise(멱등 settle). */
  settled: Promise<void>;
  /**
   * 현재 invocation을 소유한 generation(provider 전역 **단조 증가**, 재사용 없음. 0 = 소유자 없음).
   * `start`/`send`는 **첫 await 전에 동기로** 이 토큰을 발급받고, 이후 **모든 await 뒤와 spawn 직전
   * 동기 게이트에서** "아직 내 것인가"를 다시 확인한다 → 겹친 호출은 spawn 0으로 거부되고,
   * `stop`·세션 교체 뒤의 낡은 invocation은 발행·spawn을 하지 못한다.
   */
  gen: number;
  /** `stop`이 claim을 무효화했다. child가 아직 없어도 발행·spawn을 막는다. */
  cancelled: boolean;
  /**
   * 진행 중 invocation의 **취소 통보 + 정착 대기** 핸들(대장 `C-27`, M5b).
   *
   * 이전 판의 `stop()`은 `starting`(claim 후 spawn 전)에서 **즉시 반환**했고, 취소된 `start`/`send`는
   * 진행 중인 비동기 경계 작업이 끝난 **뒤에야** `codex_invocation_cancelled`로 reject됐다 → 호출자가
   * 그 promise를 잡아두지 않으면 **stop 반환 뒤에 unhandled rejection**이 떴다(배선 계약이 코드·문서에만
   * 있었다). 현행: `invoke`가 ⓐ 호출자에게 주는 promise를 **취소 신호와 race**시키고 ⓑ 그 race 결과에
   * **항상 handler를 붙인 그림자**(`settled`)를 남긴다 → `stop`은 `cancel()`로 즉시 정착시키고
   * `settled`를 await한 뒤 반환하므로, **stop 하나만 await해도** 나중에 뜨는 rejection이 없다.
   * 진행 중 경계 작업(git 조회)을 기다리지 않으므로 `stop`이 매달리지도 않는다.
   */
  inflight: { settled: Promise<void>; cancel: (err: unknown) => void } | null;
  codexSessionId: string;
  /** 첫 프로세스를 띄운 뒤 고정되는 `CODEX_HOME` 소유 신원. 이후 invocation은 같은 홈만 쓴다. */
  homeId: CodexHomeIdentity | null;
  /** 비가역 세션 오염(세션 신원 충돌 등) — 이후 send를 받지 않는다. */
  poisoned: string;
}

/**
 * 이 핸들이 **정확히 이 세션 인스턴스**에 발급된 것인가(5차 리비전).
 * 판정은 **불투명 신원 객체의 참조 동일성 하나**다 — `sessionId`(교체 세션과 같다)나 가변 `spec`
 * 내용(호출자가 언제든 바꾼다)은 근거가 되지 못한다. provider가 발급하지 않은 핸들은 신원이 없으므로
 * 항상 false다(fail closed).
 */
function isBoundTo(handle: SessionHandle, state: CodexState): boolean {
  return !!handle && handle.providerBinding === state.binding;
}

/**
 * **read-only 실행 권위 등록부**(M5b 2차 리비전 A2 · 3차 리비전 A1 · **5차 리비전 A1**). 이 `WeakMap`은
 * **이 모듈 밖으로 나가지 않고**, 여기에 들어오는 유일한 경로는 아래 `CodexCliProvider` 생성자의
 * **`opts.spawn`이 없는 분기**다. 발급기(issuer)·토큰·"임의 provider를 증명해 주는 factory"는
 * **내보내지 않는다** — 밖으로 나가는 것은 판정 함수 하나뿐이다.
 *
 * 이전 판은 `types.ts`가 brand 심볼을 **공개 export** 했으므로 같은 프로세스의 아무 provider나
 * 그것을 import해 자기에게 달 수 있었다(= 공개 API만으로 위조 가능). 그 다음 판은 심볼을 없앴지만
 * **`opts.spawn`으로 임의 executor를 주입한 인스턴스도 그대로 등록**했으므로 증명이 여전히 위조 가능했다.
 * 그 다음 판(4차)은 executor가 `PRODUCTION_SPAWN`인 인스턴스만 등록했지만 **숨은 설정은 증명 대상이
 * 아니었다**: 사용자 소유 0700 스크립트를 `executablePath`로 준 인스턴스도, 다른 git 실행 파일·다른 승인
 * manifest·다른 checkout을 든 인스턴스도 그대로 증명됐다(`/bin/echo`·`/bin/true`가 증명을 통과했다).
 *
 * 지금 등록되는 값은 **불변 정규 설정·신원 스냅샷**이고 판정 함수가 그것을 함께 돌려준다 →
 * `StableController`가 자기 소유 기대 신원과 **대조**할 수 있다(어긋나면 생성 자체가 거부된다).
 */
const ATTESTED_IDENTITY = new WeakMap<object, AttestedCodexIdentity>();

/**
 * **증명된 provider의 불변·정규·런타임 검증된 설정 신원**(5차 리뷰 A1). 메서드 신원만으로는
 * "무엇을 실행하는 provider인가"를 말할 수 없으므로, 증명은 이 스냅샷을 대조 대상으로 삼는다.
 * 값은 전부 생성 시점에 **한 번** 검증·고정되며 매 invocation이 이 값을 다시 쓴다(새 baseline 없음).
 * 모듈 밖으로 내보내지 않는다 — 밖으로 나가는 것은 "기대값과 같은가"라는 판정뿐이다.
 */
interface AttestedCodexIdentity {
  /** 검증된 codex 실행 파일 — 정규 경로 + 생성 시점 **dev+ino**. */
  executable: TrustedExecutable;
  /** 검증된 git 실행 파일(실행 경계가 승인 커밋을 증명할 때 쓴다) — 정규 경로 + dev+ino. */
  git: TrustedExecutable;
  /** 판정 계약을 들고 있는 controller checkout 절대경로. */
  controllerRepoRoot: string;
  /** 승인 manifest의 canonical digest(정규화 결과의 결정론적 JSON). */
  manifestDigest: string;
  /** 이 provider의 시각 권위(`opts.nowMs` 미지정이면 `Date.now`). */
  clock: () => number;
}

/**
 * 생성 시점 1회 검증. **실패하면 증명 가능한 provider가 아니므로 생성 자체가 실패한다**(fail closed) —
 * "일단 만들고 실행할 때 거부"는 controller가 대조할 신원을 주지 못한다.
 */
function captureIdentity(config: CapturedProviderConfig): AttestedCodexIdentity {
  // 승인이 곧 실행 권위다(6차 리뷰 A1): 경로·내용 digest 모두 이 manifest에서만 나온다.
  const manifest = validateApprovalManifest(config.manifest);
  return Object.freeze({
    executable: Object.freeze(verifyCodexExecutable(manifest.executionAuthority.codex)),
    git: Object.freeze(verifyApprovedExecutable(manifest.executionAuthority.git, "승인된 git 실행 파일", GIT_BIN_CODES)),
    controllerRepoRoot: requireAbsolute(config.controllerRepoRoot, "controllerRepoRoot"),
    manifestDigest: manifestDigestOf(manifest),
    clock: resolveClock(config.nowMs),
  });
}

/** read-only bridge가 실제로 호출하는 메서드. 이 네 개의 **함수 신원**까지 증명 대상이다. */
const ATTESTED_METHODS = ["start", "send", "events", "stop"] as const;
export type AttestedMethod = (typeof ATTESTED_METHODS)[number];

/**
 * **생성 권위 증명 + 메서드 단일 읽기.** 통과하면 `start`·`send`·`events`·`stop`을 **정확히 한 번씩**
 * 읽은 그 값을 돌려주고, 아니면 `null`이다. 호출자(=`StableController`)는 **돌려받은 이 값만** bind해
 * 실행하므로 "검증한 함수"와 "실행하는 함수"가 갈릴 창이 없다(교대 getter·proxy 대응 — A1).
 *
 * 거부되는 것: 심볼·property 복사본, prototype 위조(`Object.setPrototypeOf`), subclass,
 * 인스턴스 메서드 override, 임의 scripted provider, 진짜 provider를 감싼 `Proxy`,
 * 그리고 **`opts.spawn`으로 임의 executor를 주입한 인스턴스**(3차 리뷰 A1 — 생성자를 지나도 증명 없음).
 *
 * **주장하는 범위**: 같은 프로세스에서 **공개 API만으로는** read-only bridge에 들어올 수 없다.
 * **주장하지 않는 범위**: OS 수준 샌드박스 격리가 아니다. 이 모듈의 내부를 직접 조작할 수 있는 코드
 * (프로토타입 오염 이전 단계·모듈 패치·디버거)는 여전히 프로세스 안에 있다.
 */
export function attestReadOnlyCodexProvider(
  provider: unknown,
  expected: ExpectedCodexAuthority,
): Readonly<{ methods: Readonly<Record<AttestedMethod, unknown>>; authorityMatches: boolean }> | null {
  if (typeof provider !== "object" || provider === null) return null;
  const identity = ATTESTED_IDENTITY.get(provider); // 생성자를 지나지 않았다(복사본·proxy·위조 prototype)
  if (identity === undefined) return null;
  if (Object.getPrototypeOf(provider) !== CodexCliProvider.prototype) return null; // subclass·prototype 교체
  // 증명된 인스턴스의 상태·설정은 전부 `#private`이므로 own property는 **0이어야** 한다(4차 리뷰 A1) →
  // 생성 뒤 `defineProperty`로 만든 어떤 own property(메서드 override·`id` 교체 포함)도 여기서 걸린다.
  if (Object.getOwnPropertyNames(provider).length > 0 || Object.getOwnPropertySymbols(provider).length > 0) return null;
  const proto = CodexCliProvider.prototype as unknown as Record<string, unknown>;
  const methods = {} as Record<AttestedMethod, unknown>;
  for (const m of ATTESTED_METHODS) {
    const fn = (provider as Record<string, unknown>)[m]; // ← 이 property를 읽는 유일한 지점
    if (fn !== proto[m]) return null; // 인스턴스 override(own property)
    methods[m] = fn;
  }
  return Object.freeze({ methods: Object.freeze(methods), authorityMatches: authorityMatches(identity, expected) });
}

/**
 * **호출자(controller)가 스스로 검증해 온 기대 실행 권위.** 증명은 이 값과의 대조 결과만 알려 준다 —
 * 즉 "임의 실행 파일을 든 provider"에 대해 승인처럼 읽히는 답이 나올 수 없다(5차 리뷰 A1).
 */
export interface ExpectedCodexAuthority {
  /** controller가 **명시로 지정하고 직접 검증한** codex 실행 파일(정규 경로 + dev/ino). */
  executable: TrustedExecutable;
  /** controller가 직접 검증한 git 실행 파일(정규 경로 + dev/ino). */
  git: TrustedExecutable;
  controllerRepoRoot: string;
  /** canonical 승인 digest(정규화된 manifest의 결정론적 JSON). */
  manifestDigest: string;
  /** controller의 시각 권위. */
  clock: () => number;
}

/**
 * 증명된 설정이 기대 권위와 같은가. **하나라도** 다르면 false다(값·경로는 아무 데도 싣지 않는다).
 *
 * 시각 권위는 **controller와 같은 함수이거나 진짜 시스템 시계(`Date.now`)** 만 인정한다: 호출자가 고른
 * 다른 시계를 든 provider는 controller가 만료로 보는 시점에 "아직 유효하다"고 판정할 수 있고,
 * 반대로 `Date.now`는 호출자가 거짓말시키도록 고를 수 있는 값이 아니다(fail-safe 방향).
 *
 * 기대값 자체가 계약 밖이면(부분 객체·잘못된 타입) **false**다 — 예외를 던져 판정을 회피하지 않는다.
 */
function authorityMatches(identity: AttestedCodexIdentity, expected: ExpectedCodexAuthority): boolean {
  const sameFile = (a: TrustedExecutable, b: unknown): boolean =>
    typeof b === "object" &&
    b !== null &&
    a.path === (b as TrustedExecutable).path &&
    typeof (b as TrustedExecutable).id === "object" &&
    (b as TrustedExecutable).id !== null &&
    a.id.dev === (b as TrustedExecutable).id.dev &&
    a.id.ino === (b as TrustedExecutable).id.ino;
  if (typeof expected !== "object" || expected === null) return false;
  return (
    sameFile(identity.executable, expected.executable) &&
    sameFile(identity.git, expected.git) &&
    identity.controllerRepoRoot === expected.controllerRepoRoot &&
    identity.manifestDigest === expected.manifestDigest &&
    (identity.clock === expected.clock || identity.clock === Date.now)
  );
}

/**
 * **생성 시점에 한 번 포착한 실행 설정**(2026-07-28 4차 독립 리뷰 A1). 증명된 provider의 실행 권위는
 * 전부 이 값이며 **호출자 `opts` 객체를 실행마다 권위로 다시 읽지 않는다** — 이전 판은 TS `private opts`
 * (= emitted JS의 public writable own field)를 매 invocation 다시 읽었으므로, 증명을 받은 뒤에
 * `provider.opts`를 갈아끼우거나 그 객체의 executable·manifest·git·controller 경로·시계를 바꾸면
 * 그 값이 실제 실행 설정이 됐다.
 *
 * `manifest`는 **입양된 사본**이다(구조적 복제 — 호출자가 나중에 그 객체의 내용을 바꿔도 여기 값은
 * 안 바뀐다). 승인 정규화·검증은 `start()`의 봉인 시점에 이 사본에 대고 한다(계약 위반은 그때
 * 자기 native 코드로 보고된다).
 */
interface CapturedProviderConfig {
  manifest: unknown;
  controllerRepoRoot: string;
  nowMs?: () => number;
}

/** 호출자 manifest를 **한 번 읽어** 평범한 사본으로 입양한다(getter·proxy·cycle은 여기서 닫힌다). */
function adoptManifestInput(raw: unknown): unknown {
  try {
    return structuredClone(raw);
  } catch {
    fail("codex_config_invalid", "opts.manifest는 직렬화 가능한 평범한 데이터여야 한다");
  }
}

export class CodexCliProvider implements ExecutionProvider {
  /**
   * **prototype getter**다(4차 리뷰 A1). own field로 두면 `provider.id = …`·`defineProperty`로 바꿀 수
   * 있는 값이 하나 남고, 증명된 인스턴스의 own property는 **0이어야** 한다는 불변식이 깨진다.
   */
  get id(): string {
    return "codex-cli";
  }
  /**
   * 세션 상태. **ECMAScript `#private`** 이므로 밖에서 대입·`defineProperty`로 갈아끼울 수 없다
   * (TS `private`은 emitted JS에서 그냥 public own field였고, 증명된 인스턴스의 내부 상태를 테스트가
   * 교체하는 통로였다 — 3차 리뷰 A1의 같은 뿌리다).
   */
  readonly #sessions = new Map<string, CodexState>();
  /**
   * 이 인스턴스가 실행할 executor. `#private`이므로 **생성 이후 어떤 외부 코드도 바꿀 수 없다**
   * (`provider.spawnFn = evil` · `Object.defineProperty(provider, …)` 전부 무효).
   * 증명된 인스턴스에서는 항상 `PRODUCTION_SPAWN`이다.
   */
  readonly #spawn: SpawnFn;
  /**
   * **실행 권위**: 생성 시점에 각 property를 정확히 한 번 읽어 굳힌 설정. `#private`이므로 밖에서
   * 보이지도 바뀌지도 않고, 실행 경로는 이 값만 쓴다(A1).
   */
  readonly #config: Readonly<CapturedProviderConfig>;
  /**
   * **드리프트 tripwire 전용** 호출자 객체 참조. 실행 입력으로 읽지 않는다 — `assertNoSpecDrift`가
   * "호출자가 봉인 뒤에 자기 객체를 바꿨는가"를 판정할 때만 쓴다(바뀌면 `codex_spec_mutated`).
   */
  readonly #optsRef: CodexCliProviderOpts;
  /**
   * **증명된 설정·신원 스냅샷**(5차 리뷰 A1). production 분기에서만 만들어지며(주입 executor는 증명
   * 대상이 아니다) 실행 파일·git 신원은 **매 invocation 이 값으로 대조**한다 — 첫 invocation이 새
   * baseline을 세우지 않는다.
   */
  readonly #identity: AttestedCodexIdentity | null;
  /** invocation generation 발급기 — 단조 증가하며 재사용되지 않는다. */
  #nextGen = 1;

  constructor(opts: CodexCliProviderOpts) {
    // 호출자 소유 property는 **여기서 정확히 한 번씩만** 읽는다 — 아래 `#config`가 유일한 실행 권위다.
    const injected = opts.spawn; // ← 이 property를 읽는 유일한 지점
    this.#optsRef = opts;
    this.#config = Object.freeze({
      manifest: adoptManifestInput(opts.manifest),
      controllerRepoRoot: opts.controllerRepoRoot,
      nowMs: opts.nowMs,
    });
    if (injected === undefined) {
      this.#spawn = PRODUCTION_SPAWN;
      // **read-only 실행 권위는 여기서만 발급된다**(A2 · 3차 리뷰 A1 · 5차 리뷰 A1). 이 구현이 sandbox
      // `read-only`(`codex_sandbox_forbidden`)와 strict empty MCP를 격리 홈·`--strict-config`로 실제
      // 집행하고, **실행 대상이 진짜 `node:child_process.spawn`일 때만** bridge를 지날 자격이 있다.
      // 등록되는 것은 메서드가 아니라 **런타임 검증된 설정 신원**이다: 실행 파일·git·checkout·승인
      // digest·시각 권위가 여기서 고정되고, controller가 자기 기대값과 대조한다.
      this.#identity = captureIdentity(this.#config);
      ATTESTED_IDENTITY.set(this, this.#identity);
    } else if (typeof injected === "function") {
      // 하위 계층 단위 테스트용 seam. **증명하지 않는다** — 임의 executor를 가진 인스턴스는 untrusted다.
      // 설정 검증도 여기서 하지 않는다(계약 위반은 그대로 `start`의 정확한 native 코드로 보고된다).
      this.#spawn = injected;
      this.#identity = null;
    } else {
      fail("codex_config_invalid", "opts.spawn은 함수여야 한다");
    }
    // own property가 하나도 없는 인스턴스를 얼린다(A1) → `defineProperty`로 메서드·설정을 덧붙일 수
    // 없고, `attestReadOnlyCodexProvider`의 "own property 0" 불변식이 성립한다.
    // (TS `private` 메서드는 prototype에 있고 prototype도 얼려 있다. 밖에서 부를 수는 있지만
    //  실행 설정은 `#config`에 봉인되어 있고 드리프트 대조가 위조 seal을 거부하므로 `start`보다
    //  넓은 권한이 생기지 않는다.)
    Object.freeze(this);
  }

  /**
   * 호출자에게 주는 promise에 **항상 handler를 하나 붙인다**(대장 `C-27`). 반환값은 그대로 호출자
   * 것이고 오류도 그대로 전달된다 — 그림자는 **unhandled rejection만** 막는다(오류를 삼키지 않는다).
   * 이게 있어야 "취소된 invocation은 `stop` 하나만 await해도 조용히 정착한다"가 성립한다.
   */
  private tracked<T>(p: Promise<T>): Promise<T> {
    void p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  start(spec: SessionSpec, initialPrompt: string): Promise<SessionHandle> {
    return this.tracked(this.startSession(spec, initialPrompt));
  }

  private async startSession(spec: SessionSpec, initialPrompt: string): Promise<SessionHandle> {
    if (typeof spec?.sessionId !== "string" || spec.sessionId.length === 0) {
      fail("codex_config_invalid", "spec.sessionId가 필요하다");
    }
    if (this.#sessions.has(spec.sessionId)) fail("codex_session_exists", `harness 세션 id가 이미 있다: ${spec.sessionId}`);
    // 설정·승인 거부는 상태를 만들기 전에 일어난다. 통과하면 그 해석값이 이 세션의 **봉인 baseline**이다.
    const sealed = sealCodexSpec(spec, this.#config);
    const state: CodexState = {
      sessionId: spec.sessionId,
      binding: Object.freeze({}),
      sealed,
      spec,
      queue: new AsyncEventQueue<SessionEvent>(),
      child: null,
      status: "idle",
      settled: Promise.resolve(),
      gen: 0,
      cancelled: false,
      inflight: null,
      codexSessionId: "",
      homeId: null,
      poisoned: "",
    };
    this.#sessions.set(state.sessionId, state);
    try {
      await this.invoke(state, undefined, initialPrompt);
    } catch (err) {
      // 실패한 start는 상태를 남기지 않는다 — 단 **내 세션일 때만** 지운다.
      // stop 뒤에 같은 id로 만들어진 교체 세션을 낡은 invocation의 정리가 지우면 안 된다.
      if (this.#sessions.get(state.sessionId) === state) this.#sessions.delete(state.sessionId);
      throw err;
    }
    // 핸들은 **이 인스턴스에만** 유효하다. `providerBinding`을 들고 있는 쪽만 이 세션을 조종한다.
    return Object.freeze({ sessionId: state.sessionId, spec, providerBinding: state.binding });
  }

  /**
   * 후속 지시 = `codex exec … resume <관측된 UUID>`. 관측 전·ephemeral·실행 중·오염 세션은 거부한다.
   * **핸들 신원이 먼저다**: 낡은·위조 핸들은 대상 세션을 읽지도 건드리지도 않고 `codex_stale_handle`이다.
   */
  send(handle: SessionHandle, message: string): Promise<void> {
    return this.tracked(this.sendMessage(handle, message));
  }

  private async sendMessage(handle: SessionHandle, message: string): Promise<void> {
    const state = this.requireState(handle);
    // 프로토콜 실패로 닫힌 세션은 이어가지 않는다(`codex_mcp_observed` ·
    // `codex_session_identity_conflict` · **`codex_protocol_failed`** — 대장 `C-21`).
    if (state.poisoned) fail(state.poisoned, "세션이 프로토콜 위반으로 닫혔다");
    // `starting`(claim 후 spawn 전)도 실행 중으로 본다 — 겹친 send는 **동기로** 거부되고 spawn 0이다.
    if (state.status === "starting" || state.status === "running") {
      fail("codex_send_overlap", "이전 invocation이 아직 실행 중이다");
    }
    if (state.status === "stopped") fail("codex_session_stopped", "중지된 세션에는 보낼 수 없다");
    if (state.sealed.ephemeral) {
      fail("codex_resume_unavailable", "ephemeral 세션은 resume할 수 없다(resume이 필요하면 ephemeral:false로 시작한다)");
    }
    if (!CODEX_SESSION_ID_RE.test(state.codexSessionId)) {
      fail("codex_resume_unavailable", "정규 codex session UUID를 관측하지 못했다(--last는 쓰지 않는다)");
    }
    await this.invoke(state, state.codexSessionId, message);
  }

  events(handle: SessionHandle): AsyncIterable<SessionEvent> {
    return this.requireState(handle).queue;
  }

  /**
   * 세션 중지. **종료 결과가 정착하기 전에 큐를 닫거나 상태를 지우지 않는다.**
   * **child가 아직 없는 claim(`starting`)도 여기서 취소된다** — 그 invocation은 경계 작업이 끝나도
   * 발행·spawn을 하지 못하고 거부된다(예전에는 그 창에서 추적되지 않는 프로세스가 뜰 수 있었다).
   * **낡은 핸들의 `stop`은 무해·멱등이다(5차 리비전)**: 같은 id에 이미 **교체 세션**이 있으면
   * signal·close·상태 변경·삭제를 **하나도** 하지 않고 조용히 돌아온다(없는 세션 stop과 같은 취급).
   *
   * **`starting`에서도 진행 중 invocation이 정착한 뒤에 반환한다(대장 `C-27`, M5b).** 취소 신호로
   * 호출자 promise를 **즉시** `codex_invocation_cancelled`로 정착시키고(진행 중 git 조회를 기다리지
   * 않으므로 매달리지 않는다) 그 결과를 await한다 → **`stop` 하나만 await한 호출자에게도** 나중에 뜨는
   * unhandled rejection이 없다. 뒤늦게 끝난 경계 작업은 소유권 검사에서 걸려 발행·spawn 0이다.
   * 프로세스 그룹·TERM→유예→KILL·자손 정리는 이 범위가 아니다(대장 `C-18`, M5c).
   * ponytail: 여기서는 SIGTERM 1회 + settle 대기까지만 — 강제 종료 사다리는 M5c에서 붙인다.
   */
  async stop(handle: SessionHandle, _reason: string): Promise<void> {
    const state = this.lookup(handle);
    if (!state || !isBoundTo(handle, state)) return; // 멱등 + 교체 세션 보호(낡은 핸들은 아무것도 하지 않는다)
    state.cancelled = true; // child가 없어도 진행 중 claim을 무효화한다
    const inflight = state.inflight;
    if (state.status === "running") {
      state.child?.kill("SIGTERM");
      await state.settled; // 종료 result 1건이 큐에 들어간 뒤에만 정리한다
    }
    if (inflight) {
      // 이미 정착한 invocation에는 무해하다(race의 첫 정착만 유효). `settled`는 reject하지 않는다.
      inflight.cancel(new OrchestrationError("codex_invocation_cancelled", "이 invocation은 stop으로 취소됐다"));
      await inflight.settled;
    }
    state.status = "stopped";
    state.queue.close();
    // 그 사이 같은 id로 만들어진 **교체 세션은 지우지 않는다**(stop 멱등 + 교체 안전).
    if (this.#sessions.get(state.sessionId) === state) this.#sessions.delete(state.sessionId);
  }

  /** 핸들이 가리키는 id의 **현재** 세션(있으면). 신원 대조는 하지 않는다 — 그건 호출부의 몫이다. */
  private lookup(handle: SessionHandle): CodexState | undefined {
    return handle && typeof handle.sessionId === "string" ? this.#sessions.get(handle.sessionId) : undefined;
  }

  /**
   * 상태 조회 + **핸들 신원 대조**. 두 거부를 구분한다:
   * - 그 id에 세션이 없다 → `codex_unknown_session`(기존 semantics 그대로).
   * - 세션은 있는데 **이 핸들이 발급된 인스턴스가 아니다**(stop 후 같은 id로 만들어진 교체 세션 ·
   *   위조·복제 핸들) → `codex_stale_handle`. **읽기·발행·spawn·변경·삭제 없이** 즉시 닫는다.
   */
  private requireState(handle: SessionHandle): CodexState {
    const state = this.lookup(handle);
    if (!state) fail("codex_unknown_session", "없는 세션이다");
    if (!isBoundTo(handle, state)) fail("codex_stale_handle", "이 핸들은 현재 세션 인스턴스의 것이 아니다");
    return state;
  }

  /**
   * **첫 await 전 동기 소유권 claim.** generation을 발급하고 상태를 `starting`으로 올린다 →
   * 이 순간부터 겹친 start/send는 `codex_send_overlap`으로 즉시 거부되고(spawn 0, 큐·child 교체 없음),
   * `stop`은 child가 없어도 이 claim을 취소할 수 있다.
   */
  private claim(state: CodexState): number {
    if (state.status !== "idle") fail("codex_send_overlap", "이 세션에는 이미 진행 중인 invocation이 있다");
    state.cancelled = false;
    state.gen = this.#nextGen++;
    state.status = "starting";
    return state.gen;
  }

  /** 아직 이 invocation이 소유자인가: 세션 존재 · **같은 state 객체** · 같은 generation · 미취소 · 미중지. */
  private owns(state: CodexState, gen: number): boolean {
    return (
      this.#sessions.get(state.sessionId) === state && state.gen === gen && !state.cancelled && state.status !== "stopped"
    );
  }

  private assertOwned(state: CodexState, gen: number): void {
    if (!this.owns(state, gen)) fail("codex_invocation_cancelled", "이 invocation은 무효화됐다(stop 또는 세션 교체)");
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
  private async invoke(state: CodexState, resumeSessionId: string | undefined, prompt: string): Promise<void> {
    // 프롬프트 계약 위반은 claim 전에 거부한다(세션 상태를 건드리지 않는다).
    if (typeof prompt !== "string" || prompt.length === 0) fail("codex_prompt_invalid", "프롬프트가 비어 있다");
    if (prompt.length > MAX_PROMPT_CHARS) fail("codex_prompt_too_long", `프롬프트는 ${MAX_PROMPT_CHARS}자 이하여야 한다`);

    const gen = this.claim(state); // 첫 await 전 동기 claim — 겹친 호출은 여기서 갈린다
    const inner = (async () => {
      try {
        await this.runInvocation(state, gen, resumeSessionId, prompt);
      } catch (err) {
        // 발행 전 실패는 **내 claim만** 되돌린다. 발행 뒤라면 `settle`이 이미 상태를 정리했고,
        // 세션이 교체됐다면(`owns` false) 아무것도 건드리지 않는다.
        if (state.status === "starting" && this.owns(state, gen)) state.status = "idle";
        throw err;
      }
    })();
    // `C-27`: 취소 신호와 race시켜 `stop`이 이 promise를 **즉시** 정착시킬 수 있게 하고, 그 결과에
    // **항상 handler를 붙인 그림자**를 남긴다 → 호출자가 promise를 버려도 unhandled rejection이 없고
    // `stop`은 그림자를 await해 "정착 후 반환"을 지킨다. 취소가 늦으면(이미 정착) 무해하다.
    let cancel: (err: unknown) => void = () => undefined;
    const cancelled = new Promise<never>((_res, rej) => (cancel = rej));
    const raced = Promise.race([inner, cancelled]);
    // 이 대입은 첫 await 이전(동기 구간)에 끝난다 — `stop`이 볼 때 항상 채워져 있다.
    state.inflight = { settled: raced.then(() => undefined, () => undefined), cancel };
    return raced;
  }

  /**
   * claim된 invocation 본체. 사전 검증은 계약 위반을 **비동기 작업 전에** 걸러내기 위한 것이고,
   * **신뢰 판정의 근거는 게이트다**: 소유권·봉인 spec·홈·실행 파일·git·승인 커밋·만료를
   * **await가 하나도 남지 않은 상태에서** 한 번에 다시 본다.
   */
  private async runInvocation(
    state: CodexState,
    gen: number,
    resumeSessionId: string | undefined,
    prompt: string,
  ): Promise<void> {
    const s = state.sealed; // 권위는 봉인값이다 — 아래 어디서도 `state.spec`의 값으로 실행하지 않는다
    // ── 사전 검증(빠른 거부 + 신원 고정) ──────────────────────────────────
    // turn 사이 변조는 여기서 먼저 걸린다(`C-23`): 호출자 객체가 새 baseline이 되지 못한다.
    assertNoSpecDrift(s, state.spec, this.#optsRef);
    // `B-7ⓐ`: 승인된 격리 홈은 **봉인된 manifest**에서만 온다(ambient env·호출자 옵션 통로가 없다).
    // manifestDigest가 봉인 대상이므로 turn 사이에 승인된 홈을 갈아끼우면 `codex_spec_mutated`다.
    const approvedHome = s.manifest.executionAuthority.codexHome ?? null;
    const homeExpect: CodexHomeExpectation = state.homeId
      ? { identity: state.homeId, approved: approvedHome } // resume: 소유 홈(상태 있음이 정상)
      : { requireEmpty: true, approved: approvedHome }; // 첫 invocation: 승인된 자격증명 외에는 빈 홈
    const preHome = verifyCodexHome(s.codexHome, homeExpect);
    // **생성 시점에 고정된 실행 파일 신원**으로 대조한다(5차 리뷰 A1) — 첫 invocation이 새 baseline을
    // 세우지 않으므로, 증명 이후 같은 경로가 다른 실행 파일로 교체되면 여기서 fail closed다.
    const pinnedBin = this.#identity?.executable.id;
    const preBin = verifyCodexExecutable(s.manifest.executionAuthority.codex, pinnedBin);

    // 대장 `B-5`: 승인된 커밋이 controller/실행 checkout HEAD와 정확히 같을 때만 프로세스를 띄운다.
    const boundary: VerifiedExecutionBoundary = await verifyExecutionBoundary({
      // **봉인된 승인 사본**이다(`this.opts.manifest`를 다시 읽지 않는다 — 갈아끼운 승인이 경계 판정에
      // 끼어들 통로를 없앤다). 경계는 이 사본을 자기 규칙으로 다시 검증한다.
      manifest: s.manifest,
      controllerRepoRoot: s.controllerRepoRoot,
      targetWorktree: s.cwd,
      // git 실행 파일 경로·digest는 경계가 이 manifest에서 읽는다(6차 리뷰 A1 — 호출자 경로 없음).
      // 신원도 **생성 시점 값**에 묶는다(5차 리뷰 A1) — 증명 이후 교체된 git으로는 승인 커밋을 증명하지 못한다.
      gitIdentity: this.#identity?.git.id,
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
    assertNoSpecDrift(s, state.spec, this.#optsRef);
    boundary.revalidateSync();
    const home = verifyCodexHome(s.codexHome, { ...homeExpect, identity: preHome.id });
    const bin = verifyCodexExecutable(s.manifest.executionAuthority.codex, pinnedBin ?? preBin.id);
    // argv는 **봉인값**으로 컴파일한다(중간에 바뀐 호출자 객체로 인자를 만들지 않는다).
    const args = compileResolvedArgs(s, cwd, resumeSessionId);

    // ── 발행: 검증과 동기 게이트가 전부 끝난 뒤에만 큐/`running`을 바꾼다 ──
    const queue = new AsyncEventQueue<SessionEvent>();
    let resolveSettled: () => void = () => undefined;
    const settledPromise = new Promise<void>((res) => (resolveSettled = res));
    let settled = false;
    const settle = (exit: Parameters<CodexJsonlParser["finish"]>[0]): void => {
      if (settled) return;
      settled = true;
      for (const e of parser.finish(exit)) queue.push(e);
      queue.close();
      // **내 generation일 때만** state를 건드린다 — 교체 세션·다음 invocation을 오염시키지 않는다.
      if (this.#sessions.get(state.sessionId) === state && state.gen === gen) {
        state.child = null;
        // 대장 `C-21`: **비가역 프로토콜 실패로 끝난 turn 뒤에는 resume하지 않는다.** malformed·과대 줄·
        // 중복/모순 종료·상한 초과·신원 위반은 파서가 되돌릴 수 없는 실패로 기록하는데, 이전 판은
        // MCP 위반·세션 신원 충돌만 세션을 닫아서 **실패한 turn이 다음 turn의 깨끗한 baseline**이 됐다
        // (판정이 호출자의 `result.isError` 확인에만 달려 있었다 — `B-8`과 같은 방향의 fail-open).
        // 이미 더 구체적인 사유로 닫힌 세션은 그 코드를 유지한다.
        if (parser.protocolFailed && !state.poisoned) state.poisoned = "codex_protocol_failed";
        if (state.status !== "stopped") state.status = "idle";
      }
      resolveSettled();
    };

    this.assertOwned(state, gen); // 발행·spawn 직전 마지막 확인(여기서 spawn까지 await 없음)
    state.queue = queue;
    state.settled = settledPromise;
    state.status = "running";

    let child: ChildProcess;
    try {
      // `B-7ⓑ`: stderr는 **fd 단계에서 버린다**(`"ignore"`). 아래 settle이 stderr를 절대 싣지 않는 것과
      // 합쳐, 자식이 무엇을 찍든 이 프로세스의 메모리에 들어오지 않는다 — redaction 패턴이 그 토큰을
      // 아는지 여부에 의존하지 않는 구조적 차단이다(패턴은 "대개" 맞을 뿐이고 이 게이트는 그것을 거부한다).
      child = this.#spawn(bin.path, args, { cwd, env: compileCodexEnv(home.path), stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      // 동기 spawn 예외: 큐를 열어둔 채 두지 않고 종료 결과 1건으로 닫는다.
      // 오류 메시지도 싣지 않는다 — 경로·argv가 섞일 수 있고 `spawn_error` 코드로 진단은 충분하다.
      void err;
      settle({ code: null, signal: null, spawnError: true });
      fail("codex_spawn_failed", "codex 실행을 시작하지 못했다");
    }
    // 프로세스를 띄운 뒤부터 그 홈은 provider 소유다 — 이후 invocation은 신원이 같은 홈만 쓴다.
    state.homeId = home.id;
    state.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const e of parser.push(chunk)) {
        if (e.kind === "init") this.bindSessionIdentity(state, parser, e.sessionId, queue);
        // strict empty MCP 위반을 본 thread는 **다시 이어가지 않는다**(비가역 실패를 resume으로 우회 금지).
        else if (e.kind === "unknown" && e.type === "mcp_call_observed") state.poisoned = "codex_mcp_observed";
        // 파서가 기대 신원과 다른 thread를 봤다(init·본문은 이미 봉인돼 나오지 않는다) → 세션을 닫는다.
        else if (e.kind === "unknown" && e.type === "session_identity_conflict") {
          state.poisoned = "codex_session_identity_conflict";
          state.child?.kill("SIGTERM");
        }
        queue.push(e);
      }
    });
    // stderr는 읽지 않는다(`stdio[2] = "ignore"`). 주입된 spawn이 stdio를 무시하고 stream을 주더라도
    // 여기서 구독하지 않으므로 내용이 어디에도 축적되지 않는다. 상한·redaction은 더 이상 방어선이 아니다.
    // stdin EPIPE 등은 프로세스 종료 경로로 수렴시킨다(여기서 던지면 unhandled가 된다).
    child.stdin?.on("error", () => parser.protocolFail("stdin_error"));

    child.on("error", () => settle({ code: null, signal: null, spawnError: true }));
    child.on("close", (code, signal) => settle({ code, signal }));

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      parser.protocolFail("stdin_error");
    }
  }

  /**
   * 세션 신원 고정: 첫 정규 UUID만 채택하고, 이후 invocation이 다른 id를 내면 **비가역 실패**다
   * (파서가 스트림 내부 위반을 보고 여기서는 invocation 간 위반을 본다).
   */
  private bindSessionIdentity(state: CodexState, parser: CodexJsonlParser, observed: string, queue: AsyncEventQueue<SessionEvent>): void {
    if (!CODEX_SESSION_ID_RE.test(observed)) return; // 파서가 이미 프로토콜 실패로 잡는다
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

// prototype을 얼려 둔다: 증명이 "메서드가 prototype의 그 함수와 같은가"이므로, prototype 자체가
// 바뀌면 모든 인스턴스가 함께 오염된다(A2). 확장할 계획이 없는 클래스이므로 비용이 0이다.
Object.freeze(CodexCliProvider.prototype);
