/**
 * V3 M5c — **`harness autopilot`**: M5c 오케스트레이션 loop의 운영자 진입점.
 *
 * 이 명령이 하는 일은 한 문장이다: **승인 manifest 하나로 gate된 durable run을, 사람이 프롬프트를
 * 한 번도 복사하지 않고, offline plan worker로 전진시킨다.** 두 번째 scheduler·상태 파일·상태 기계를
 * 만들지 않는다 — `OrchestrationKernel`이 여전히 유일한 SoR이고 이 모듈은 좁은 API 호출과
 * **관측 가능한 진행 출력**뿐이다.
 *
 * ## 열려 있는 게이트에 대한 입장 (이 slice가 **소비하지 않은** 것들)
 *
 * - **`B-11`(무인 advance 전 per-task preflight)** — 소비하지 않는다. kernel이 이미 닫은 경로만 쓴다:
 *   `planRunnableBatch` → `commitPreflightBatch`(batch 전체가 결정을 받고 **아무 프로세스도 뜨지 않는**
 *   `prepared`까지만) → **turn 직전에 task 하나씩** `startPreparedTask`. 계획 입력이 없는 task는
 *   `deferred`다 — `ready`에 그대로 두고 attempt·자원·상태를 **하나도** 건드리지 않는다.
 * - **`B-12`(재시작 시 예산 리셋)** — 소비하지 않는다. 이 loop는 **controller in-memory 카운터를
 *   쓰지 않는다**: 예산의 진실은 durable `state.accounting`이고(`remainingBudget()` · `budgetDeadlineAt`),
 *   turn마다 `chargeTurnUsage`로 durable하게 적는다. 그래서 프로세스를 다시 띄워도 같은 승인 아래
 *   예산이 새로 생기지 않는다. **`--resume` 같은 재예산 플래그를 만들지 않았다.**
 * - **`B-13`(정리 확인보다 durable 완료가 먼저)** / **`B-18`·`B-20`·`C-18`** — 소비하지 않는다.
 *   kernel의 순서 계약을 그대로 지난다: `recordTerminal`(→`cleaning`) → 정리 판정 → 완료/pause.
 *
 *   **정정(V3 M10 T1 — 이전 판의 과대주장).** 이전 판은 "이 loop는 프로세스를 하나도 띄우지 않는다 →
 *   자손이 구조적으로 0이다"라고 적고 그 근거로 `confirmCleanup`을 **무조건** 불렀다. 그 주장은 M5d
 *   task 2(typed operation 집행)와 M9 T3③(`git_worktree`)이 열린 뒤로 **거짓이다** — `run_process`·
 *   `git_worktree`는 `superviseProcess`로 실제 프로세스 그룹을 띄운다. 그래서 supervisor가 그룹이 빈 것을
 *   **관측하지 못한 turn**(`process_cleanup_unconfirmed` → marker `cleanup_unconfirmed`)에도 durable에
 *   `cleanup_confirmed`(= survivors 0)를 적고 있었다 = **거짓 성공 영수증**. 지금은 관측하지 못한 정리를
 *   `failCleanup`으로 적고 자원을 놓지 않는다(§ "정리 착지" 참조).
 * - **`B-17`(실패한 전달이 `activeAttemptId`를 남긴다)** — 소비하지 않는다. 이 loop는
 *   `beginDeliveryAttempt`를 **부르지 않는다**(inbox 전달은 provider 세션 계약이며 이 slice 밖이다) →
 *   열린 채 남을 attempt가 생기지 않는다. inbox가 있는 task도 여기서는 그냥 pause될 뿐이다.
 * - **`B-10`(타입 있는 edit 가능 실행 집행)** — **M5d task 2에서 소비한다**(사용자 승인:
 *   "offline typed execution 소비 게이트를 연다"). `issueOperationDispatchPermit` → `beginOperation` →
 *   고정 집행기 → `recordOperationReceipt`를 계획 순서대로 부른다. **권위는 하나도 이 파일에 없다**:
 *   승인 레코드 대조·소유권·`writableRoots`·digest 재검증·spawn 상한·deadline·멱등 pending은 전부
 *   kernel 안에서 일어나고, autopilot이 고를 수 있는 것은 **계획에 이미 있는 operationId의 순서**뿐이다.
 *   승인되지 않은 operation은 여전히 `operation_denied`로 닫히고 task는 `paused`로 착지한다.
 * - **`B-16`(real typed-write 산출물 발행)** — **완전 개방**(M9 선결 2). 신규 파일 생성도 바이트를
 *   낸다(`O_CREAT|O_EXCL` 빈 파일 → 부모 경로 재해석 검증 → inode 도달성 검증 → 고정한 fd 전용 쓰기).
 *   artifact로 발행되는 것은 그 task가 소유한 파일뿐이며 kernel이 소유권·`writableRoots`·hash를 집행한다.
 *
 *   **정정(V3 M11 판정 ⑥ · 2026-08-24)**: 위 문단은 한때 "부분 개방(M5d) — **신규 파일 생성은 여전히
 *   fail closed**(`write_publish_unsupported`)"라고 적었고 **M9 선결 2 이후에도 남아 거짓이었다**.
 *   같은 코드베이스의 `typedExecution.ts`는 "`write_publish_unsupported`는 더 이상 발생하지 않는다"고
 *   적고 있었으므로 **두 주석이 서로를 반박하고 있었다**. 실제 잔여는 다른 곳이다 — 대장 **`B-38`**:
 *   task_assignment 본문에 operation 객체를 싣는 코드가 없어 **live task가 이 능력에 닿을 통로가 없다**.
 * - **`B-7`/`B-9`(live)** — 소비하지 않는다. 유일한 backend는 `offline-plan`이고 `claude`·`codex`는
 *   worker가 hard reject한다. 네트워크 호출 0 · 추론 0 · spawn 0.
 *
 *   **정정(V3 M11 — 위 문단은 M5c 시점의 기록이며 지금은 거짓이다).** M10 T3/T7이 `claude-plan`·
 *   `codex-plan` worker를 열었고 M11에서 그 선택이 CLI(`--worker-backend`)로 노출됐다. 그래서
 *   "유일한 backend"도 "네트워크 0 · 추론 0 · spawn 0"도 **이 모듈 전체의 성질이 아니다** —
 *   `offline-plan` 갈래에서만 참이다. live 갈래는 승인 manifest의 `executionAuthority.claude`
 *   (리뷰어 family는 `codex`)가 없으면 시작조차 못 하지만, 있으면 실제 프로세스를 띄우고 구독 한도를
 *   소모한다. 이 문단을 지우지 않고 정정으로 남기는 이유: 위 게이트 목록이 "무엇을 소비했는가"의
 *   역사 기록이고, 소비 시점을 지우면 그 근거를 되짚을 수 없다.
 *
 * ## 이 slice가 하지 않는 것
 *
 * inbox 전달 · typed operation 집행 · worktree 자동화 · live provider. 그 각각은 위 게이트를 여는
 * 별도 승인 slice다.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  LIMITS,
  ORCHESTRATOR_ID,
  OrchestrationError,
  REQUIRED_BODY_HEADINGS,
  TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
  assertSlug,
  formatTimestamp,
  opensProcess,
} from "../exec/orchestrationTypes.js";
import type { AgentMessageEnvelope, AutopilotMarker, OrchestrationTask, PauseReason } from "../exec/orchestrationTypes.js";
import { ORCHESTRATION_SCHEMA_VERSION } from "../exec/orchestrationTypes.js";
import { MAX_PLAN_JSON_BYTES, OFFLINE_PLAN_BACKEND, startOfflinePlanTurn } from "../exec/offlinePlanWorker.js";
import { LIVE_PLAN_BACKEND, planContractPrompt, startLivePlanTurn } from "../exec/livePlanWorker.js";
import { CODEX_PLAN_BACKEND, startCodexPlanTurn } from "../exec/codexPlanWorker.js";
import { assertCodeReviewRoundtrip, DesignRoundtripError, type RoundtripParticipant } from "../exec/designReviewRoundtrip.js";
import { autopilotProgressBridge } from "../exec/autopilotProgress.js";
import { createProgressReporter } from "./progress.js";
import type { TypedExecutionPlan, WorkerEvent } from "../exec/autopilotTypes.js";
import { validateTypedExecutionPlan } from "../exec/typedPlan.js";
import { applyAgentRequests, requestsOfKind, type AgentRequestOutcome } from "../exec/spawnRouting.js";
import { openOrchestrationRun } from "../exec/orchestrationKernel.js";
import { acquireOwnedLock, releaseOwnedLock, runPaths } from "../exec/orchestrationStore.js";
import type {
  OperationDispatchPermit,
  OperationExecutionGrant,
  OrchestrationKernel,
  WorkerProgressChannel,
} from "../exec/orchestrationKernel.js";
// **집행 진입점은 facade 하나만 쓴다** — kernel 사설 집행기에 직접 닿는 통로를 만들지 않는다.
import {
  applyWriteFile,
  executeRunProcessOperation,
  executeWorktreeOperation,
  resolveProcessLaunchCapability,
  resolveWorktreeCapability,
  resolveWriteFileAuthority,
} from "../exec/typedExecution.js";

/** 한 번의 `autopilot` 실행이 도는 iteration 상한(무인 loop는 언제나 bounded다). */
export const DEFAULT_MAX_ITERATIONS = 16;

/** 관측 가능한 진행 이벤트 — **durable state에 들어가지 않는다**(운영자 화면 전용). */
export interface AutopilotEvent {
  kind:
    | "run_started"
    | "batch_planned"
    | "task_deferred"
    | "task_started"
    | "task_progress"
    | "task_paused"
    /** 계획의 `spawn_child` 요청이 kernel 게이트를 통과해 child가 만들어졌다(V3 M6 T2). */
    | "task_spawned"
    /** turn 중간 kernel throw(`C-55`) — **paused가 아니다**: lease를 쥔 크래시 등가 상태다. */
    | "task_aborted"
    /**
     * **worker 세션이 어느 자격증명으로 도는가**(V3 M11 · 대장 `C-86`). live backend에서 시작 직후 한 번
     * 나온다. `marker`는 `approved`(승인 문서가 `claudeHome`으로 고정) 또는 `ambient`(고정하지 않았다 —
     * 이 기계에 로그인된 계정으로 돈다)다. **없으면 조용히 ambient로 도는 것이 이 레포가 금지하는
     * "조용한 fallback"이므로, 값이 무엇이든 이 이벤트가 나온다.**
     */
    | "worker_identity"
    /**
     * **worker 세션이 어느 모델로 도는가**(V3 M11 모델 축). live backend에서 시작 직후 한 번 나온다.
     * `marker`가 `approved`면 승인 문서(`executionAuthority.claudeModel`)가 고정했고 **`detail`이 그
     * 문자열**이다. `cli_default`면 승인이 모델을 말하지 않아 `--model`이 실리지 않았다는 뜻이고
     * **`detail`이 없다** — harness는 CLI 기본 모델이 무엇인지 모르며, 모르는 값을 지어 적는 것이
     * 곧 거짓 영수증이다.
     */
    | "worker_model"
    | "task_completed"
    | "task_cancelled"
    | "run_finished";
  taskId?: string;
  /** 안정 marker/사유 코드. 자유 서술이 아니다. */
  marker?: string;
  detail?: string;
}

export interface AutopilotTaskOutcome {
  taskId: string;
  /**
   * `completed` · `paused` · `cancelled` · `deferred` · `aborted`(turn 중간 kernel throw — `C-55`) ·
   * `waiting_children`(계획이 child를 요청해 결과 발행 대신 위임으로 착지했다 — V3 M6 T2).
   */
  state: string;
  marker: string;
  /**
   * `B-22`: 이 turn의 usage가 durable 회계에 **들어가지 못했다**(거부 코드). 값이 있으면 이후 판정은
   * 낡은 총량 위에서 이뤄지므로 loop가 계속 돌아서는 안 된다.
   */
  chargeFailed?: string;
}

export interface AutopilotReport {
  /** run 수준 거부 코드(있으면 task를 하나도 건드리지 않았다). */
  blocked: string | null;
  /**
   * controller lease 해제가 실패한 코드(V3 M10 T3 리뷰 C1). 값이 있으면 **같은 프로세스**의 다음
   * 실행은 자기 pid lease를 살아 있는 소유자로 보고 `controller_active`로 거부된다(다른 프로세스는
   * 사망 관측으로 회수한다). 성공하면 이 key 자체가 없다.
   */
  leaseReleaseFailed?: string;
  iterations: number;
  tasks: AutopilotTaskOutcome[];
  /** loop가 멈춘 안정 사유. */
  stoppedBecause: string;
  /**
   * **worker 세션의 자격증명 신원이 승인 문서 안에 있었는가**(V3 M11 · 대장 `C-86`).
   * `approved` = `executionAuthority.claudeHome`이 고정했다 · `ambient` = 고정하지 않았고 이 기계에
   * 로그인된 계정으로 돌았다. live backend가 아니면 key 자체가 없다(물어볼 것이 없다).
   *
   * **이 필드가 `C-86`을 "조용한 fallback"과 가른다**: 신원을 고정하지 않는 선택은 정당하지만
   * **그 사실이 영수증에 남는다** — 나중에 "이 run이 누구 구독으로 돌았나"를 물으면 답이 있다.
   */
  workerIdentity?: "approved" | "ambient";
  /**
   * **worker 세션이 어느 모델로 돌도록 요청됐는가**(V3 M11 모델 축). live backend가 아니면 key 자체가
   * 없다(물어볼 것이 없다).
   *
   * - `{ marker: "approved", model: "<승인된 값>" }` — 승인 문서가 고정했고 그 문자열이 `--model`로 실렸다.
   * - `{ marker: "cli_default", model: null }` — 승인이 모델을 말하지 않았다. `--model`은 **실리지 않았고**
   *   세션은 CLI 기본 모델로 돌았다. `model`이 `null`인 것은 **harness가 그 기본값이 무엇인지 모른다**는
   *   뜻이다 — 여기에 추측한 모델 이름(예: 지금 유행하는 모델)을 적으면 그 자체가 거짓 영수증이다.
   *   그래서 두 경우는 **같은 값으로 적힐 수 없는 형태**로 갈라 둔다.
   *
   * **이 필드가 주장하는 범위**: harness가 관측한 것은 **argv**까지다("승인이 이 모델을 말했고 `--model`로
   * 실었다"). CLI 응답 봉투의 모델 필드는 읽지 않는다 — 그 필드의 실재·이름을 이 slice에서 실측하지
   * 못했다(live 금지). 따라서 "요청한 모델로 **실제로** 돌았다"는 여기서 증명되지 않는다.
   */
  workerModel?: { marker: "approved"; model: string } | { marker: "cli_default"; model: null };
}

/**
 * 무인 loop가 아는 **worker backend 전부**(닫힌 집합). 호출자가 실행 파일·인자·프롬프트를 고르는 통로가
 * 아니라 **두 값 중 하나**다: `offline-plan`은 운영자가 authoring한 계획 파일을 읽고, `claude-plan`은
 * 승인 manifest가 못 박은 실행 파일로 실제 모델 세션을 돌린다(승인에 그 키가 없으면 표현 불가).
 */
export const AUTOPILOT_WORKER_BACKENDS = [OFFLINE_PLAN_BACKEND, LIVE_PLAN_BACKEND] as const;

/**
 * **리뷰어 role family**(V3 M10 T7 · 대장 `C-97`). 이 family의 task는 live 실행에서 **codex 리뷰어
 * 세션**으로 돈다 — 왕복 계약이 리뷰어를 fresh Codex read-only로 못박기 때문이다
 * (`designReviewRoundtrip.assertCodeReviewRoundtrip`).
 *
 * **닫힌 상수이고 승인 문서가 고르는 값이 아니다.** role은 durable(`task.roleId`)이므로 이 판정은
 * 재시작 뒤에도 같다. 하위 role(`qa-security.code` 등)은 한 겹까지 registry가 허용하므로 top-level
 * family로 자른다. codex 권위가 승인에 없으면 `approvedCodexWorker()`가 `worker_backend_unapproved`로
 * 거부한다(조용한 claude fallback이 없다 — 그것이 있으면 "리뷰어가 저자와 같은 엔진"이 조용히 성립한다).
 */
export const CODEX_REVIEWER_ROLE_FAMILY = "qa-security";

/** 이 task를 어느 backend로 돌릴 것인가. live 실행에서만 갈라진다(offline은 한 갈래다). */
export function backendForRole(backend: AutopilotWorkerBackend, roleId: string): AutopilotWorkerBackend | "codex-plan" {
  if (backend !== LIVE_PLAN_BACKEND) return backend;
  return roleId.split(".")[0] === CODEX_REVIEWER_ROLE_FAMILY ? CODEX_PLAN_BACKEND : LIVE_PLAN_BACKEND;
}
export type AutopilotWorkerBackend = (typeof AUTOPILOT_WORKER_BACKENDS)[number];

export interface AutopilotOptions {
  workspaceRoot: string;
  runId: string;
  /** 운영자가 "이 승인 아래 돈다"고 명시하는 milestone. durable run과 다르면 시작하지 않는다. */
  milestoneId: string;
  /**
   * task별 offline 계획 JSON 디렉터리(`<planDir>/<taskId>.json`).
   *
   * **`offline-plan` backend에서만 읽힌다** — live backend는 계획을 모델이 만들므로 이 값을 한 번도
   * 보지 않는다(아래 `LIVE_PLACEHOLDER` 갈래). 그래서 타입도 선택이다. 없는 채로 offline을 요청하면
   * **fail closed**다(`plan_dir_required`): 빈 디렉터리로 취급하면 모든 task가 `plan_missing`으로
   * `deferred`되어 "계획을 안 준 것"과 "계획 자리를 안 준 것"이 같은 결과로 보인다 = 조용한 fallback.
   */
  planDir?: string;
  maxIterations?: number;
  /** 시각 권위(테스트 주입용). */
  clock?: () => Date;
  /** 취소 신호 — 관측되면 진행 중 attempt를 정리하고 멈춘다. */
  signal?: AbortSignal;
  /**
   * worker backend(기본 `offline-plan`). `claude-plan`은 **실제 모델 세션을 돌린다** — 구독 한도를
   * 소모하므로 기본값이 아니고, 승인 manifest의 `executionAuthority.claude`가 없으면 시작하지 않는다.
   */
  workerBackend?: AutopilotWorkerBackend;
  onEvent?: (e: AutopilotEvent) => void;
}

/** 이 모듈이 낼 수 있는 run 수준 거부 코드(닫힌 집합). */
export const AUTOPILOT_BLOCKED_CODES = [
  "approval_milestone_mismatch",
  "manifest_expired",
  "budget_elapsed_exhausted",
  "budget_tokens_exhausted",
  "run_unavailable",
  /** 같은 run에 이미 살아 있는 controller가 붙어 있다(V3 M10 T3 — 대장 `B-32`). */
  "controller_active",
] as const;

// ── 진입점 ──────────────────────────────────────────────────────────────────

export async function runAutopilot(opts: AutopilotOptions): Promise<AutopilotReport> {
  const emit = opts.onEvent ?? (() => undefined);
  const clock = opts.clock ?? (() => new Date());
  const tasks: AutopilotTaskOutcome[] = [];

  // **run을 먼저 연다**: 없는 run에 lease 파일을 만들면 그것이 곧 durable 부작용이다(디렉터리 생성).
  let kernel: OrchestrationKernel;
  try {
    kernel = openOrchestrationRun({ workspaceRoot: opts.workspaceRoot, runId: opts.runId, clock });
  } catch (err) {
    return { blocked: "run_unavailable", iterations: 0, tasks, stoppedBecause: codeOf(err) };
  }

  // **한 run에 controller 하나**(대장 `B-32`). 크래시 복구 pass는 "iteration 시작에 `running`+lease가
  // 보이면 이전 프로세스가 죽었다"를 전제하는데, 두 번째 controller가 붙으면 그 전제가 거짓이 되어
  // **살아 있는 attempt를 크래시로 오판**하고 같은 task의 agent가 잠시 둘 돈다. 그래서 복구 pass를
  // 고치는 대신 **동시 controller 자체를 표현 불가로** 만든다 — writer lock과 **같은 기계**이므로
  // 죽은 controller의 lease는 사망을 **관측했을 때만** 회수되고(pid 재사용은 회수하지 않는다 = 안전한
  // 방향), 살아 있으면 두 번째는 시작조차 못 한다. 읽기(위 open)는 막지 않는다.
  const paths = runPaths(opts.workspaceRoot, opts.runId);
  let lease: { file: string; nonce: string };
  try {
    lease = acquireOwnedLock(paths.controllerLeaseFile, `run ${opts.runId}에 이미 controller가 붙어 있다`);
  } catch (err) {
    return { blocked: "controller_active", iterations: 0, tasks, stoppedBecause: codeOf(err) };
  }
  let report: AutopilotReport = { blocked: null, iterations: 0, tasks, stoppedBecause: "unknown" };
  try {
    report = await runAutopilotUnderLease(opts, kernel, { emit, clock, tasks });
  } finally {
    // 해제 실패를 삼키지 않는다. **report에도 남긴다**(리뷰 C1): 사람 모드 렌더러는 event의 marker·
    // detail을 버리므로 emit만으로는 운영자가 이 사실을 볼 수 없고, 그러면 **같은 프로세스**가 다음에
    // 부를 때 자기 pid의 lease를 "살아 있는 소유자"로 보고 `controller_active`로 거부되는 이유를
    // 되짚을 수 없다(다른 프로세스는 사망 관측으로 회수하므로 자가 치유된다).
    try {
      releaseOwnedLock(lease);
    } catch (err) {
      const code = codeOf(err);
      emit({ kind: "run_finished", marker: code, detail: "controller_lease_release_failed" });
      report = { ...report, leaseReleaseFailed: code };
    }
  }
  return report;
}

/** lease를 쥔 상태의 본체. lease 획득·해제는 위 진입점 하나에만 있다. */
async function runAutopilotUnderLease(
  opts: AutopilotOptions,
  kernel: OrchestrationKernel,
  ctx: { emit: (e: AutopilotEvent) => void; clock: () => Date; tasks: AutopilotTaskOutcome[] },
): Promise<AutopilotReport> {
  const { emit, clock, tasks } = ctx;

  // **승인 게이트**: 운영자가 지목한 승인과 durable run의 승인이 같아야 한다. 다르면 아무것도 하지 않는다.
  const state = kernel.getState();
  if (state.milestoneId !== opts.milestoneId) {
    return { blocked: "approval_milestone_mismatch", iterations: 0, tasks, stoppedBecause: "approval_milestone_mismatch" };
  }
  const entry = budgetGate(kernel, clock);
  if (entry) return { blocked: entry, iterations: 0, tasks, stoppedBecause: entry };

  emit({ kind: "run_started", detail: `${state.runId}@${state.milestoneId}` });

  // backend는 실행 하나에 **하나로 고정**된다. 닫힌 집합 밖 값은 조용히 offline으로 강등하지 않는다 —
  // 강등이 곧 "live를 요청했는데 offline이 돌았다"는 거짓 성공이다.
  const backend: AutopilotWorkerBackend = opts.workerBackend ?? OFFLINE_PLAN_BACKEND;
  if (!(AUTOPILOT_WORKER_BACKENDS as readonly string[]).includes(backend)) {
    return { blocked: "run_unavailable", iterations: 0, tasks, stoppedBecause: "worker_backend_unsupported" };
  }
  // live backend는 **시작 전에** 승인을 본다(첫 turn에서 알게 되면 그때까지 상태를 바꿨을 수 있다).
  let workerIdentity: "approved" | "ambient" | undefined;
  let workerModel: AutopilotReport["workerModel"];
  if (backend === LIVE_PLAN_BACKEND) {
    try {
      const approvedWorker = kernel.approvedWorkerExecutable();
      workerIdentity = approvedWorker.configDir === null ? "ambient" : "approved";
      // **모델 축도 같은 자리에서 읽는다**(V3 M11). 승인이 모델을 말하지 않으면 `cli_default`이고
      // `model`은 `null`이다 — harness는 CLI 기본값이 **무엇인지 모르므로** 이름을 적지 않는다.
      workerModel = approvedWorker.model === null ? { marker: "cli_default", model: null } : { marker: "approved", model: approvedWorker.model };
    } catch (err) {
      return { blocked: "run_unavailable", iterations: 0, tasks, stoppedBecause: codeOf(err) };
    }
    // **무엇으로 도는지를 말하고 시작한다**(`C-86`). `ambient`도 정당한 선택이지만 조용해서는 안 된다 —
    // 그 침묵이 곧 이 레포가 금지하는 "조용한 fallback"이다.
    emit({ kind: "worker_identity", marker: workerIdentity });
    // 모델 축도 같은 규율이다. `detail`은 **승인이 값을 말했을 때만** 실린다(모르는 값을 적지 않는다).
    emit({ kind: "worker_model", marker: workerModel.marker, ...(workerModel.model === null ? {} : { detail: workerModel.model }) });
  }
  // **리뷰 왕복을 요구한 승인은 그 참가자가 실재할 때만 시작한다**(V3 M11 적대적 리뷰 A-1).
  //
  // 게이트(`reviewRoundtripGate`)는 `spec.verify`인 turn에서만 돈다 → **verify가 DAG에 없으면 게이트가
  // 한 번도 돌지 않고 run이 조용히 완주한다.** 나머지 다섯은 부재 시 `roundtrip_participant_missing`으로
  // fail closed인데 verify만 fail open이었다(오타 하나로 강제가 사라진다). 비대칭을 여기서 없앤다 —
  // **시작 전에** 여섯 개 전부의 실재를 요구하고, 하나라도 없으면 아무 상태도 건드리지 않고 거부한다.
  {
    const spec = kernel.getManifest().reviewRoundtrip;
    if (spec !== undefined) {
      const declared = [spec.author, spec.reviews.code, spec.reviews.security, spec.reviews.test, spec.revision, spec.verify];
      if (declared.some((id) => kernel.getTask(id) === null)) {
        return { blocked: "run_unavailable", iterations: 0, tasks, stoppedBecause: "roundtrip_participant_missing" };
      }
    }
  }

  /**
   * **무인 전진의 자격**(`B-11`)은 backend마다 다르다:
   * - `offline-plan`: 운영자가 authoring한 계획 파일이 **실제로 있는가**. 없으면 `deferred`다.
   * - `claude-plan`: 계획을 **모델이 만든다** → 파일 자격이 존재하지 않는다. 그 자리의 자격은 위에서
   *   이미 본 **승인**(`executionAuthority.claude`)이고, 그것이 없으면 여기까지 오지 못한다.
   *   파일 자격을 그대로 요구하면 live backend는 영원히 `no_plans_available`이다(공허한 게이트).
   */
  const LIVE_PLACEHOLDER: PlanDocument = { operations: undefined, requests: undefined, result: undefined };
  // **offline 갈래에서 계획 디렉터리는 필수다**(V3 M11). 이 판정을 CLI가 아니라 여기 두는 이유:
  // `runAutopilot`을 부르는 통로가 CLI 하나가 아니다(acceptance·live 스크립트도 부른다) → CLI에만
  // 두면 다른 호출자는 `planDir` 없이 offline을 요청해 **전 task가 `plan_missing`으로 조용히 defer**된다.
  //
  // `null`은 "live라서 이 축이 없다", `undefined`는 "offline인데 주지 않았다"다 — 두 뜻이 같은 값으로
  // 표현되지 않으므로 아래 갈래에 도달 불가 분기가 남지 않는다.
  const offlinePlanDir: string | null | undefined = backend === LIVE_PLAN_BACKEND ? null : opts.planDir;
  if (offlinePlanDir === undefined) {
    return { blocked: "run_unavailable", iterations: 0, tasks, stoppedBecause: "plan_dir_required" };
  }
  const planFor = (taskId: string): PlanDocument | null =>
    offlinePlanDir === null ? LIVE_PLACEHOLDER : readPlanDocument(offlinePlanDir, taskId);

  const maxIterations = boundedIterations(opts.maxIterations);
  let iterations = 0;
  let stoppedBecause = "iteration_limit";
  for (; iterations < maxIterations; iterations++) {
    if (opts.signal?.aborted) {
      stoppedBecause = "cancelled";
      break;
    }
    const gate = budgetGate(kernel, clock);
    if (gate) {
      stoppedBecause = gate;
      break;
    }
    // **V3 M10 T1 — 크래시 잔재를 먼저 정착시킨다.** `prepared`보다 먼저 보는 이유: `running`/`cleaning`
    // 잔재는 lease를 쥐고 있어 같은 task를 다시 시작하면 **중복 agent**가 되고, 정착시키지 못하는 잔재는
    // loop를 아예 멈춰야 하기 때문이다(정착 실패를 지나쳐 batch를 계획하면 그것이 조용한 진행이다).
    const residue = recoverCrashedAttempts(kernel, emit, tasks);
    if (residue !== null) {
      stoppedBecause = residue;
      break;
    }
    // **`B-21`: 중단된 batch가 남긴 `prepared`를 먼저 되찾는다.** `prepared`는 자원 점유 상태
    // (`RESOURCE_HOLDING_STATES`)인데 `selectSchedulable`은 `ready`/`retry_wait`만 고르므로, 되찾지
    // 않으면 그 task가 배타 class와 `maxSessions` 자리를 영구히 붙잡아 **이후 모든 batch가 조용히
    // 줄어든다**. 되찾기는 `startPreparedTask`가 봉인된 preflight를 다시 대조하므로(`preflight_drift`)
    // 안전하고 **새 attempt를 태우지 않는다**(`commitPreflightBatch`를 다시 지나지 않는다).
    // 계획이 없는 잔여는 `paused`로 접어 자원을 놓아준다 — 조용히 붙잡는 것보다 사람이 보는 편이 낫다.
    const reclaimed = new Map<string, PlanDocument>();
    for (const task of kernel.getState().tasks) {
      if (task.state !== "prepared") continue;
      const doc = planFor(task.taskId);
      if (doc) {
        reclaimed.set(task.taskId, doc);
        continue;
      }
      // `C-59`: 이 pause는 `C-55` catch **밖**이었다 → 동시 writer의 `stale_writer`가 CLI를 죽였다.
      const failed = safePause(kernel, task.taskId, "approval_required");
      if (failed !== null) {
        stoppedBecause = failed;
        break;
      }
      emit({ kind: "task_paused", taskId: task.taskId, marker: "plan_missing", detail: "prepared_reclaimed" });
      tasks.push({ taskId: task.taskId, state: "paused", marker: "plan_missing" });
    }
    if (stoppedBecause !== "iteration_limit") break;

    const batch = kernel.planRunnableBatch();
    if (batch.items.length === 0 && reclaimed.size === 0) {
      stoppedBecause = "no_runnable_tasks";
      break;
    }
    emit({ kind: "batch_planned", detail: batch.items.map((t) => t.taskId).join(",") });

    // **무인 전진의 자격은 "offline 계획이 실제로 있는가" 하나다**(`B-11`). 없으면 `deferred` —
    // 상태·attempt·자원을 건드리지 않으므로 사람이 계획을 넣고 다시 부르면 그대로 이어진다.
    // 되찾은 `prepared`가 먼저 들어가 있다(같은 turn loop 하나가 둘을 함께 진행한다).
    const plans = new Map<string, PlanDocument>(reclaimed);
    for (const task of batch.items) {
      const doc = planFor(task.taskId);
      if (doc) plans.set(task.taskId, doc);
    }
    // batch가 비어 있어도(되찾은 `prepared`만 있을 때) preflight를 부르지 않는다 — 빈 batch에
    // 결정을 커밋하는 것은 아무 의미 없는 revision 증가일 뿐이다.
    if (batch.items.length > 0) {
      kernel.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: id("pf"),
        decisions: batch.items.map((t) =>
          plans.has(t.taskId)
            ? ({ taskId: t.taskId, outcome: "prepared", attemptId: id("att") } as const)
            : ({ taskId: t.taskId, outcome: "deferred" } as const),
        ),
      });
    }
    for (const task of batch.items) {
      if (!plans.has(task.taskId)) {
        emit({ kind: "task_deferred", taskId: task.taskId, marker: "plan_missing" });
        tasks.push({ taskId: task.taskId, state: "deferred", marker: "plan_missing" });
      }
    }
    if (plans.size === 0) {
      stoppedBecause = "no_plans_available";
      break;
    }

    for (const [taskId, planDoc] of plans) {
      // 예산·만료는 **task마다 다시** 본다. 소진을 알게 된 뒤에는 남은 task를 시작하지 않는다
      // (`prepared`에 남으므로 프로세스도 lease도 잡지 않는다).
      const perTask = budgetGate(kernel, clock);
      if (perTask) {
        stoppedBecause = perTask;
        break;
      }
      // **`C-55`**: turn 중간에 kernel이 예기치 않게 throw하면(시계 역행 · durable 쓰기 오류) 지금까지는
      // CLI 프로세스가 그대로 죽어 task가 `running`/`cleaning`에 durable lease를 쥔 채 남았다. 여기서
      // 잡아 **loop를 소리나게 멈추고** 남은 task를 시작하지 않는다. 그 task 자체는 여전히 크래시 등가라
      // durable `processLeaseMarker`로 복구한다 — 이 catch가 정리를 대신 해줄 수는 없다(lease는
      // `runTaskTurn` 안에 있다). 바뀌는 것은 **나머지 batch를 조용히 계속 밀지 않는다**는 점이다.
      let outcome: AutopilotTaskOutcome;
      try {
        outcome = await runTaskTurn({ kernel, taskId, planDoc, backend, workspaceRoot: opts.workspaceRoot, clock, signal: opts.signal, emit });
      } catch (err) {
        const marker = codeOf(err);
        emit({ kind: "task_aborted", taskId, marker, detail: "turn_aborted" });
        tasks.push({ taskId, state: "aborted", marker });
        stoppedBecause = "turn_aborted";
        break;
      }
      tasks.push(outcome);
      // 시작이 거부된 잔여(`preflight_drift` 등)를 `prepared`에 두면 그것이 곧 `B-21`을 다시 만든다 —
      // 자원을 놓아주고 사람이 보게 한다. attempt는 이미 소모된 뒤이므로 여기서 더 태우지 않는다.
      if (outcome.state === "prepared") {
        // `C-59`: 위와 같은 이유로 보호 안에서 부른다.
        const failed = safePause(kernel, taskId, "approval_required");
        if (failed !== null) {
          stoppedBecause = failed;
          break;
        }
        emit({ kind: "task_paused", taskId, marker: outcome.marker, detail: "start_rejected" });
        outcome.state = "paused";
      }
      // **정리를 관측하지 못한 turn**(위 A급 수정)은 자원을 쥔 채 `cleaning`에 남는다 — 사람이 본다.
      if (outcome.state === "cleaning") {
        stoppedBecause = "cleanup_unobservable";
        break;
      }
      // `B-22`: 원장에 들어가지 않은 turn이 있으면 이후 예산 판정은 낡은 총량을 본다 → 멈춘다.
      // 이미 지난 task는 `paused`로 착지해 있으므로 사람이 회계를 맞춘 뒤 그대로 이어서 부를 수 있다.
      if (outcome.chargeFailed !== undefined) {
        stoppedBecause = "usage_unaccounted";
        break;
      }
      if (opts.signal?.aborted) {
        stoppedBecause = "cancelled";
        break;
      }
    }
    if (stoppedBecause !== "iteration_limit") break;
  }

  emit({ kind: "run_finished", marker: stoppedBecause });
  // `C-86`: live run의 영수증에는 **무엇으로 돌았는지**가 함께 남는다(offline이면 key 자체가 없다).
  // V3 M11: 같은 자리에 **어느 모델을 요청했는지**도 남는다(`workerModel` — 승인이 말하지 않으면
  // `cli_default` · 그때 모델 이름은 적지 않는다).
  return {
    blocked: null,
    iterations,
    tasks,
    stoppedBecause,
    ...(workerIdentity === undefined ? {} : { workerIdentity }),
    ...(workerModel === undefined ? {} : { workerModel }),
  };
}

// ── 크래시 잔재 정착 (V3 M10 T1) ────────────────────────────────────────────

/**
 * **정리가 관측 불가인 이유**(있으면 그 코드, 없으면 `null`) — `confirmCleanup`을 부를 자격의 **단일 판정**.
 * turn 착지(`runTaskTurn`)와 크래시 복구 pass가 **같은 이 함수**를 쓴다.
 *
 * 판정은 **durable 증거만** 본다. 재시작한 controller에는 이전 attempt의 pgid가 없고(`TaskExecution`은
 * PID/PGID를 의도적으로 담지 않는다) 같은 프로세스 안에서도 supervisor가 이미 "관측하지 못했다"고 보고한
 * 뒤이므로, 어느 쪽에서도 **다시 관측할 방법은 없다**.
 *
 * 그래서 여기서 `null`이 나온다는 것은 "프로세스가 죽은 것을 확인했다"가 **아니라** "이 attempt가 프로세스를
 * 띄우는 집행 경계에 **들어간 적이 없거나 들어간 것이 전부 관측된 채로 닫혔다**"는 뜻이다 — 그때만
 * survivors 0이 구조적으로 참이다. 그 밖에는 확인할 수단이 없으므로 확인했다고 적지 않는다.
 *
 * **survivors 0의 범위(대장 `B-18` · V3 M10 T6)**: supervisor의 관측 단위는 **승인된 프로세스 그룹**이다.
 * 자손이 스스로 `setsid`해 그룹을 나가면 그 관측 밖이므로, 여기서 승격되는 "survivors 0"도 **그룹 범위의
 * 주장**이다. 그룹 밖까지 보장하려면 cgroup·jail이 필요하고 darwin에는 없다 — 없는 보장을 적지 않는다.
 *
 * **turn 착지에서 marker 하나만 보지 않는 이유**: turn의 최종 marker는 마지막 실패만 담는다. 앞선
 * `run_process`가 `outcome_unknown`으로 닫힌 뒤 다음 operation이 `operation_denied`로 끝나면 marker는
 * `operation_denied`이지만 **프로세스는 여전히 살아 있을 수 있다** → marker가 아니라 영수증을 본다.
 */
function cleanupUnobservableReason(task: OrchestrationTask): string | null {
  const exec = task.execution;
  // ① supervisor가 그룹이 빈 것을 관측하지 못했다고 **이미 durable에 적혀 있다**(`process_cleanup_unconfirmed`
  //    → 이 marker). 이것이 "미관측"의 정본 증거다.
  if (exec.terminalMarker === "cleanup_unconfirmed") return "cleanup_unconfirmed";
  // ② 프로세스를 여는 operation이 **집행 경계 안에서** 미확정으로 남아 있다(`attemptedAt !== null`) →
  //    supervisor가 돌아오지 못했다 = 자손을 거둔 관측이 없다.
  if (exec.pendingOperations.some((p) => p.attemptedAt !== null && opensProcess(p.kind))) {
    return "operation_effect_uncertain";
  }
  // ③ **turn이 자기 종료를 적지 못한 채**(`terminalMarker === null`) 프로세스 kind의 `outcome_unknown`
  //    영수증이 남아 있다 → 영수증과 종료 기록 **사이**에서 죽었으므로 관측 여부를 알 수 없다.
  //
  //    `terminalMarker !== null`이면 이 판정을 하지 않는다. **중요**: `outcome_unknown` 영수증은
  //    미관측의 증거가 아니다 — deadline·취소·비정상 종료는 `superviseProcess`가 그룹 소멸을 **관측한
  //    뒤**(`orchestrationKernel.ts:1212` 통과) `process_deadline_exceeded`로 던지고, 그 pending도
  //    `outcome_unknown`으로 닫힌다. 그 경우까지 미관측으로 보면 **정상 취소·timeout이 run을 영구
  //    격리시키고**, 관측했는데 못 했다고 적는 반대 방향의 거짓 기록이 durable에 남는다
  //    (T1 적대적 리뷰 A1). 그래서 ①이 정본이고 ③은 **기록이 끊긴 창**만 덮는다.
  if (exec.terminalMarker === null) {
    for (const r of exec.operationReceipts) {
      if (r.attemptId !== exec.attemptId) continue;
      if (r.marker === "outcome_unknown" && opensProcess(r.kind)) return "process_outcome_unknown";
    }
  }
  return null;
}

/**
 * **이 attempt를 소유했던 controller가 사라진 잔재를 정착시킨다**(대장 `C-55` 잔여 · `C-4` 운영면).
 *
 * `running`/`cleaning` + `processLeaseMarker`는 크래시 등가 상태다: 한 `runAutopilot` 실행 안에서는
 * `runTaskTurn`이 언제나 task를 착지시키므로, **iteration 시작에 그 상태가 보인다는 것 자체가** 이전
 * 프로세스가 turn 도중 죽었다는 durable 증거다(또는 이전 실행이 관측 불가로 격리해 둔 것이다).
 *
 * 처분은 두 갈래이고 **둘 중 하나를 고르는 근거는 durable 증거뿐이다**:
 *
 * 1. **정착(settle)** — 프로세스를 띄우는 집행 경계에 들어간 적이 없다는 것이 durable에 남아 있으면
 *    survivors 0이 구조적으로 참이다 → `confirmCleanup` → `settleCleanedAttempt`(attempt 여유가 있으면
 *    `retry_wait`, 없으면 `blocked`, 취소 요청이 있었으면 `cancelled`). 자원이 풀리고 **다음 iteration이
 *    새 attempt로 이어 간다** — 이것이 "중단 후 재개"의 실체다. 새 attempt는 새 `attemptId`를 받으므로
 *    죽은 attempt의 결과가 부활할 수 없다(중복 결과 없음).
 * 2. **격리(isolate)** — 그 밖에는 **정리를 확인했다고 적지 않는다**. `failCleanup`으로 관측 실패를
 *    durable에 적고 task를 `cleaning`(자원 점유)에 남긴 뒤 loop를 멈춘다. 좌초 프로세스가 살아 있을 수
 *    있는데 자원을 놓으면 다음 batch의 배타 자원 판정이 거짓이 된다(`B-13`/`C-18`).
 *
 * **여기서 하지 않는 것**: 프로세스 탐색·`ps` 스캔·pgid 추측. lease marker는 durable하지만 그것을 들고
 * 있는 프로세스를 찾는 관측자는 **존재하지 않는다**(`MANAGED_PROCESS_ENV`는 닫혀 있고 argv에도 lease가
 * 없다) → "lease로 좌초 프로세스를 찾아 거둔다"는 것은 지금 이 아키텍처에서 **표현 불가**이며, 그렇다고
 * 적는 대신 격리한다.
 *
 * @returns loop를 멈출 안정 사유(격리했거나 kernel이 거부했다) 또는 `null`(잔재 없음/전부 정착).
 */
function recoverCrashedAttempts(
  kernel: OrchestrationKernel,
  emit: (e: AutopilotEvent) => void,
  tasks: AutopilotTaskOutcome[],
): string | null {
  for (const found of kernel.getState().tasks) {
    if (found.state !== "running" && found.state !== "cleaning") continue;
    if (found.execution.processLeaseMarker === null) continue;
    const taskId = found.taskId;
    const lease = found.execution.processLeaseMarker;
    // **판정은 이 pass가 무엇을 적기 전에 한다.** 아래 ①이 `terminalMarker`를 채우고 ②가 pending을
    // 영수증으로 바꾸므로, 나중에 판정하면 **이 pass 자신의 기록** 때문에 증거가 사라진다
    // (`cleanupUnobservableReason` ③의 "기록이 끊긴 창" 조건이 우리 기록으로 닫혀 버린다).
    const unobservable = cleanupUnobservableReason(found);
    try {
      // ① 관측한 사실을 그대로 적는다 — 이 attempt의 controller가 사라졌다.
      if (found.state === "running") {
        kernel.recordTerminal({ taskId, actionId: id("term"), marker: "controller_lost" });
      }
      // ② 미확정 operation은 **durable 신원으로만** 닫는다(살아 있던 grant는 크래시와 함께 사라졌다).
      //    marker는 kernel이 durable `attemptedAt`에서 파생하므로 여기서 결과를 지어낼 수 없다.
      for (const p of kernel.getTask(taskId)?.execution.pendingOperations ?? []) {
        kernel.reconcileUncertainOperation({
          runId: kernel.getState().runId,
          taskId,
          attemptId: p.attemptId,
          turnId: p.turnId,
          planDigest: p.planDigest,
          operationId: p.operationId,
          kind: p.kind,
          authorityId: p.authorityId,
          actionId: id("recon"),
        });
      }
      if (unobservable !== null) {
        // 관측하지 못한 정리는 **적지 않는다**. 두 번째 관측 실패로 `cleanupStatus`가 `failed`(안정 격리)가
        // 되면 사람이 `pauseTask`→`resumeTask`로 복구할 수 있다 — autopilot이 대신 놓아주지는 않는다.
        kernel.failCleanup({ taskId, actionId: id("failclean") });
        emit({ kind: "task_aborted", taskId, marker: unobservable, detail: "crash_isolated" });
        tasks.push({ taskId, state: "cleaning", marker: unobservable });
        return "cleanup_unobservable";
      }
      kernel.confirmCleanup({ taskId, actionId: id("clean"), leaseMarker: lease });
      const landed = kernel.settleCleanedAttempt({ taskId, actionId: id("settle") });
      emit({ kind: "task_aborted", taskId, marker: "controller_lost", detail: `crash_settled:${landed.state}` });
      tasks.push({ taskId, state: landed.state, marker: "controller_lost" });
    } catch (err) {
      // 정착 자체가 거부되면(동시 writer·시계·상한) **조용히 넘기지 않는다** — 잔재는 그대로 남아 있고
      // 다음 실행이 같은 판정을 다시 한다(이 pass는 멱등이다).
      emit({ kind: "task_aborted", taskId, marker: codeOf(err), detail: "crash_recovery_rejected" });
      tasks.push({ taskId, state: found.state, marker: codeOf(err) });
      return "crash_recovery_rejected";
    }
  }
  return null;
}

/**
 * `C-59`: kernel 거부(동시 writer의 `stale_writer` 등)로 CLI가 죽지 않게 하는 pause. 실패는 삼키지 않고
 * **안정 코드로 올려** 호출자가 loop를 멈추게 한다 — task는 그대로 남으므로 다음 실행이 다시 본다.
 */
function safePause(kernel: OrchestrationKernel, taskId: string, reason: PauseReason): string | null {
  try {
    kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: reason });
    return null;
  } catch (err) {
    return codeOf(err);
  }
}

// ── task turn 하나 ──────────────────────────────────────────────────────────

interface TurnCtx {
  kernel: OrchestrationKernel;
  taskId: string;
  /** `offline-plan` backend의 입력. live backend에서는 쓰이지 않는다(계획을 모델이 만든다). */
  planDoc: PlanDocument;
  backend: AutopilotWorkerBackend;
  /** codex 리뷰어 세션의 cwd(= 승인된 workspace 루트). live 갈래에서만 쓰인다. */
  workspaceRoot: string;
  clock: () => Date;
  signal?: AbortSignal;
  emit: (e: AutopilotEvent) => void;
}

/**
 * `prepared → running → cleaning → (completed | paused | cancelled)`.
 *
 * **hang이 구조적으로 불가능하다**: worker 스트림은 bounded in-memory iterable이고, 모든 실패·거부·
 * deadline·취소는 `recordTerminal` → `confirmCleanup` → 착지로 접힌다. 어떤 경로에서도 task를
 * `running`에 남겨두지 않는다.
 */
async function runTaskTurn(ctx: TurnCtx): Promise<AutopilotTaskOutcome> {
  const { kernel, taskId, clock, emit } = ctx;
  const leaseMarker = `lease.${randomBytes(16).toString("hex")}`;
  const turnId = id("turn");
  const startedMs = clock().getTime();

  let started: { task: OrchestrationTask; progress: WorkerProgressChannel };
  try {
    started = kernel.startPreparedTask({ taskId, actionId: id("start"), leaseMarker });
  } catch (err) {
    // 시작 자체가 거부되면 attempt도 lease도 없다 — 상태는 `prepared` 그대로다(정리할 것이 없다).
    emit({ kind: "task_deferred", taskId, marker: codeOf(err) });
    return { taskId, state: "prepared", marker: codeOf(err) };
  }
  emit({ kind: "task_started", taskId, marker: turnId });

  const attemptId = started.task.execution.attemptId ?? "";
  // **role이 backend를 고른다**(T7). turn 시작 전에 한 번 정하고 **결과 본문도 같은 값을 쓴다**
  // (V3 M11 — 아래 `resultBody` 참조: durable 영수증이 `offline-plan`을 하드코딩하고 있었다).
  const effectiveBackend = backendForRole(ctx.backend, started.task.roleId);
  let plan: TypedExecutionPlan | null = null;
  let dispatchCharged = false;
  let dispatchChargeFailed: string | null = null;
  let marker: AutopilotMarker = "worker_failed";
  /** turn 예외의 **원본 안정 코드**. marker가 담지 못하는 원인을 pause 이벤트로 올린다(위 `workerMarker`). */
  let workerFailureCode: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const binding = { runId: kernel.getState().runId, taskId, attemptId, turnId };
    // **role이 backend를 고른다**(T7): 리뷰어 family는 codex 세션, 나머지는 claude 세션.
    const effective = effectiveBackend;
    const stream =
      effective === CODEX_PLAN_BACKEND
        ? (() => {
            const cx = kernel.approvedCodexWorker();
            return startCodexPlanTurn({
              executable: cx.path,
              codexHome: cx.codexHome,
              cwd: ctx.workspaceRoot,
              prompt: workerPrompt(kernel, taskId),
              binding,
              timeoutMs: kernel.getManifest().autopilotPolicy.maxAttemptElapsedMs,
              signal: ctx.signal,
            });
          })()
        : effective === LIVE_PLAN_BACKEND
        ? (() => {
            // 실행 파일과 **자격증명 신원(`configDir`)**, 그리고 **모델**(V3 M11) 셋 다 **kernel이 지금
            // 검증해 준 값**이다(turn마다 다시 본다 — 캐시하면 그 재검증이 사라진다). autopilot에는
            // 그것을 바꿀 인자가 없고, 모델이 `null`이면 `--model`이 실리지 않는다.
            const cw = kernel.approvedWorkerExecutable();
            return startLivePlanTurn({
            executable: cw.path,
            configDir: cw.configDir,
            configDirIdentity: cw.configDirIdentity,
            model: cw.model,
            prompt: workerPrompt(kernel, taskId),
            binding,
            // 세션 상한은 **승인된 attempt 상한**에서 나온다(호출자가 고르는 값이 아니다).
            timeoutMs: kernel.getManifest().autopilotPolicy.maxAttemptElapsedMs,
            signal: ctx.signal,
            });
          })()
        : startOfflinePlanTurn({
            backend: OFFLINE_PLAN_BACKEND,
            planJson: encodePlan(ctx.planDoc, binding),
            binding,
          });
    let seq = 0;
    for await (const ev of stream) {
      const deadline = attemptDeadline(kernel, taskId, clock);
      if (deadline) {
        marker = deadline;
        plan = null;
        break;
      }
      if (ctx.signal?.aborted) {
        marker = "cancelled";
        plan = null;
        break;
      }
      const applied = applyWorkerEvent(kernel, started.progress, ev, ++seq);
      if (applied.progress) emit({ kind: "task_progress", taskId, detail: applied.step });
      if (ev.kind === "terminal") {
        usage = boundedUsage(ev.usage);
        plan = validateTypedExecutionPlan(ev.plan, { runId: kernel.getState().runId, taskId, attemptId, turnId });
        // **M5d task 2 — `B-10` 소비면.** operation이 있으면 승인 경계 안에서 **집행한다**.
        // 하나라도 닫히지 않으면 `turn_completed`가 아니며, 그 turn은 결과를 발행하지 않는다.
        if (plan.operations.length > 0) {
          const dispatched = await dispatchOperations({
            kernel,
            taskId,
            turnId,
            plan,
            usage,
            elapsedMs: Math.max(0, clock().getTime() - startedMs),
            signal: ctx.signal,
          });
          marker = dispatched.marker;
          // 생산 turn은 **집행보다 먼저** 권위 있게 과금된다 → 여기서 다시 적지 않는다.
          dispatchCharged = dispatched.charged;
          dispatchChargeFailed = dispatched.chargeFailed;
          if (marker !== "turn_completed") plan = null;
        } else {
          marker = "turn_completed";
        }
        // **M6 T2 — 오케스트레이션 요청 배선.** 전달은 sender가 아직 살아 있어야 kernel이 수락하므로
        // (`assertActive`) **turn 안에서** 부른다. spawn은 정리 확인 뒤에 부른다(아래 착지 직전) —
        // 정리되지 않은 attempt를 남긴 채 위임으로 넘어가지 않는다(`B-13`).
        if (marker === "turn_completed" && plan !== null) {
          const gate = routeRequestsInTurn(kernel, taskId, turnId, plan, clock, emit);
          if (gate !== null) {
            marker = gate;
            plan = null;
          }
        }
        // **리뷰 왕복 계약을 loop 안에서 강제한다**(V3 M11 · 대장 `C-98`). 승인 문서가
        // `reviewRoundtrip`으로 참가자 task를 지목한 경우에만 돌고, 지목하지 않으면 아무 일도 없다.
        if (marker === "turn_completed" && plan !== null) {
          const rt = reviewRoundtripGate(kernel, taskId, turnId);
          if (rt !== null) {
            marker = "review_invalid";
            // **왜 거부됐는지를 올린다**(오늘 `workerMarker`에서 고친 `C-96` 부류와 같은 규율):
            // marker 하나로는 "렌즈 집합이 틀렸다"와 "리뷰어가 저자와 같은 엔진이다"를 구분할 수 없다.
            workerFailureCode = rt;
            plan = null;
          }
        }
      }
    }
  } catch (err) {
    // marker는 닫힌 집합이라 원인을 다 담지 못한다 → **원본 코드를 따로 들고** pause 이벤트에 싣는다.
    workerFailureCode = codeOf(err);
    marker = workerMarker(err);
    plan = null;
  }

  // **실패한 turn의 usage도 durable하게 적는다** — 그래야 다음 판정이 최신 총량을 본다(`B-12`).
  let chargeFailed: string | null = null;
  try {
    // 생산 turn은 `dispatchOperations`가 이미 권위 있게 적었다(순서가 계약이다). 그 경우 여기서 다시
    // 적으면 `turn_already_charged`다 — 같은 turn은 정확히 한 번만 원장에 들어간다.
    if (dispatchCharged) throw new SkipCharge();
    kernel.chargeTurnUsage({
      taskId,
      turnId,
      actionId: id("charge"),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      elapsedMs: Math.max(0, clock().getTime() - startedMs),
    });
  } catch (err) {
    // `B-22`: 정리는 여전히 막지 않는다(아래 recordTerminal → confirmCleanup은 그대로 지난다). 다만
    // **삼키지 않는다**: 이 turn의 토큰이 durable 회계에 없으므로 다음 `budgetGate`는 낡은 총량을 보고
    // 통과한다 = live backend에서 계량되지 않은 지출이다. 정리를 지난 뒤 pause + loop 정지로 접는다.
    //
    // "예산 소진" 실패와 그 외를 나누지 않는 이유: `chargeTurnUsage`에는 소진 실패 모드가 **없다**
    // (총량은 상한으로 clamp되고 소진 판정은 `budgetGate`가 나중에 한다). 거부 코드는 전부 신원·중복·
    // 기록 상한(`turn_already_charged` · `turn_conflict` · `dispatch_identity_stale` ·
    // `dispatch_plan_conflict` · `charged_turns_exhausted`)이며, 어느 쪽이든 결과는 하나 —
    // **이 turn의 토큰이 원장에 없다**. 그래서 같은 처분을 받는다.
    chargeFailed = err instanceof SkipCharge ? null : codeOf(err);
  }
  if (dispatchChargeFailed !== null) chargeFailed = dispatchChargeFailed;

  const sealed = marker === "turn_completed" && plan !== null ? { summary: plan.result.summary, outputs: [...plan.result.outputs] } : null;
  kernel.recordTerminal({ taskId, actionId: id("term"), marker, pendingResult: sealed });
  // **정리는 관측된 사실만 적는다**(V3 M10 T1 — A급 수정). 판정은 크래시 복구 pass와 **같은 함수**가
  // 같은 durable 증거를 보고 한다(`cleanupUnobservableReason`) — 두 자리에 두 규칙을 두면 한쪽만
  // 정직해진다. 이전 판은 여기서 `confirmCleanup`을 **무조건** 불러 supervisor가 그룹이 빈 것을
  // 관측하지 못한 turn에도 durable에 survivors 0을 적었다.
  const unobservable = cleanupUnobservableReason(kernel.getTask(taskId)!);
  if (unobservable !== null) {
    kernel.failCleanup({ taskId, actionId: id("failclean") });
    emit({ kind: "task_aborted", taskId, marker: unobservable, detail: "cleanup_unobservable" });
    return { taskId, state: "cleaning", marker: unobservable, ...(chargeFailed ? { chargeFailed } : {}) };
  }
  kernel.confirmCleanup({ taskId, actionId: id("clean"), leaseMarker });

  if (marker === "cancelled") {
    kernel.requestCancel({ taskId, actionId: id("cancel") });
    kernel.settleCleanedAttempt({ taskId, actionId: id("settle") });
    emit({ kind: "task_cancelled", taskId, marker });
    return { taskId, state: "cancelled", marker, ...(chargeFailed ? { chargeFailed } : {}) };
  }
  // `B-22`: 회계 실패는 turn 자체의 marker보다 **먼저** 착지를 결정한다. 정리는 이미 확인됐고(위),
  // pause는 kernel이 cleanup 확인을 요구하므로 B1(cleanup_unconfirmed 우선)은 그대로 산다.
  if (chargeFailed !== null) {
    kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: "approval_required" });
    emit({ kind: "task_paused", taskId, marker: chargeFailed, detail: "usage_unaccounted" });
    return { taskId, state: "paused", marker: chargeFailed, chargeFailed };
  }
  if (marker !== "turn_completed" || plan === null) {
    const reason = pauseReasonFor(marker);
    kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: reason });
    // `pauseReason`은 durable task 상태에 이미 있다 → 이벤트 `detail`은 **원인 코드**에 쓴다(있을 때).
    emit({ kind: "task_paused", taskId, marker, detail: workerFailureCode ?? reason });
    return { taskId, state: "paused", marker };
  }

  // **집행한 프로세스가 0이 아닌 코드로 끝났으면 전진하지 않는다**(V3 M10 T6 · 대장 `C-45` 소비면).
  //
  // kernel은 `run_process`의 exitCode를 **산출물**로 남기는 계약을 유지한다(0이 아니어도 marker는
  // `applied`다 — 그것이 의도된 계약이고 여기서 바꾸지 않는다). 그런데 닫힌 action 집합
  // (`validate-plan`·`run-tests`)은 둘 다 **술어**다: 0이 아니면 "계획이 유효하지 않다" 또는 "테스트가
  // 실패했다"는 뜻이다. 그 turn을 전진시키면 **무인 loop에서 red 테스트가 통과로 세어진다** → 해석은
  // loop 정책으로 여기서 한다.
  //
  // **위치가 계약이다**(T6 적대적 리뷰 A2): spawn 처리(`waiting_children` 조기 반환)와 결과 발행보다
  // **먼저** 본다. 계획은 `operations`와 `spawn_child` 요청을 **함께** 담을 수 있고 operations는 이미
  // 집행됐으므로, 게이트가 spawn 뒤에 있으면 red 영수증을 남긴 채 `waiting_children`으로 빠져나가고
  // 자식이 끝난 **다음 attempt**에서 완료된다.
  //
  // **판정 범위도 attempt가 아니라 authority별 최신 영수증이다**(같은 리뷰): attempt로 좁히면 위 경로의
  // 이전 attempt 영수증이 보이지 않는다. authority마다 **마지막** 영수증만 보므로 red 뒤에 같은 권위로
  // 다시 돌려 green을 내면 전진할 수 있다(막다른 골목이 아니다).
  {
    const receipts = kernel.getTask(taskId)?.execution.operationReceipts ?? [];
    const latestByAuthority = new Map<string, { exitCode: number | null; kind: string }>();
    for (const r of receipts) {
      if (r.kind !== "run_process") continue;
      latestByAuthority.set(r.authorityId, { exitCode: r.exitCode, kind: r.kind });
    }
    const failed = [...latestByAuthority.entries()].find(([, r]) => r.exitCode !== null && r.exitCode !== 0);
    if (failed !== undefined) {
      kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: "approval_required" });
      emit({ kind: "task_paused", taskId, marker, detail: `process_exit_${failed[1].exitCode}` });
      return { taskId, state: "paused", marker };
    }
  }

  // **M6 T2 — spawn 배선.** 정리가 확인된 지금이 위임의 자리다: `requestSpawn`이 parent를
  // `waiting_children`으로 내리며 lease와 봉인된 결과를 놓는다. child가 전부 completed되면 kernel의
  // `recompute`가 parent를 다시 `ready`로 올리므로 **결과는 다음 attempt에서** 발행된다.
  const spawns = requestsOfKind(plan.requests, "spawn_child");
  if (spawns.length > 0) {
    const outcomes = applyAgentRequests({ kernel, taskId, turnId, requests: spawns, nextId: id, clock });
    const failed = outcomes.find((o) => o.code !== null);
    if (failed === undefined) {
      emit({ kind: "task_spawned", taskId, marker, detail: outcomes.map((o) => o.target).join(",") });
      return { taskId, state: "waiting_children", marker };
    }
    // **부분 적용은 조용히 넘기지 않는다**: 앞선 요청으로 만들어진 child는 durable에 실재하고 parent는
    // 이미 `waiting_children`이라 pause할 수도 없다 → `C-55` 경로로 loop를 멈추고 사람이 본다.
    if (outcomes.some((o) => o.code === null)) {
      throw new OrchestrationError(failed.code!, `spawn 요청이 부분 적용된 뒤 거부됐다: ${failed.target}`);
    }
    // 아무것도 적용되지 않았다 — task는 여전히 정리 확인된 `cleaning`이므로 평범하게 pause한다.
    kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: "approval_required" });
    emit({ kind: "task_paused", taskId, marker: failed.code!, detail: "spawn_denied" });
    return { taskId, state: "paused", marker: failed.code! };
  }

  try {
    kernel.completeTaskWithArtifacts({
      envelope: resultEnvelope(kernel, started.task),
      body: resultBody(taskId, plan, kernel.getTask(taskId)?.execution.operationReceipts ?? [], turnId, effectiveBackend),
      summary: plan.result.summary,
      outputs: [...plan.result.outputs],
    });
  } catch (err) {
    // 발행이 거부되면(소유권·hash·경로) 결과를 만들지 않고 **복구 가능한 pause**로 착지한다.
    kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: "approval_required" });
    emit({ kind: "task_paused", taskId, marker: codeOf(err), detail: "publish_rejected" });
    return { taskId, state: "paused", marker: codeOf(err) };
  }
  emit({ kind: "task_completed", taskId, marker });
  return { taskId, state: "completed", marker };
}

/**
 * **live worker에게 주는 프롬프트.** 전부 **durable에서만** 나온다: 이 task의 assignment 본문(중앙이
 * 발행한 지시)과 `contextBundle`(M6의 "새 coordinator가 맥락을 이어받는" 그 값 — 포인터·inbox·bounded
 * 요약뿐이고 원문은 없다) + 계획 계약(검증기 상수에서 파생).
 *
 * 그래서 프롬프트에 들어가지 않는 것: 다른 task의 원문 · 프롬프트 이력 · 자격증명 · 파일 내용.
 * inbox가 여기 실리므로 **전달받은 메시지가 그 task의 행동을 바꾼다**(대장 `B-17` 잔여의 관측면).
 */
/**
 * **리뷰 왕복 계약을 loop 안에서 강제한다**(V3 M11 · 대장 `C-98`).
 *
 * M10 T7까지 `assertCodeReviewRoundtrip`을 부르는 것은 **live 스크립트**뿐이었다 → 리뷰 task를 지우거나
 * 저자와 같은 엔진으로 돌려도 loop 자체는 완주하고 결과를 발행했다. 그때 참인 명제는 "이번 실행의
 * 참가자 집합이 계약을 통과했다"였지 **"loop가 계약을 강제한다"** 가 아니었다. 이 함수가 그 차이를 닫는다.
 *
 * ## 어디서 무엇을 막는가 (범위를 정확히)
 *
 * 승인 문서의 `reviewRoundtrip.verify`로 지목된 task가 **완료되기 직전**에 한 번 돈다. 통과하지 못하면
 * `review_invalid`이므로 그 task는 완료되지 않고 결과도 발행되지 않는다 → **리뷰 왕복이 성립하지 않으면
 * run이 완주하지 못한다.** 지목된 여섯 참가자가 durable에 실재한다는 것은 `runAutopilot` 진입에서
 * 이미 요구했다(없으면 시작조차 하지 않는다 — 그 검사가 없으면 verify 오타 하나로 이 게이트가 통째로
 * 사라진다: M11 적대적 리뷰 A-1).
 *
 * **이 게이트는 `dispatchOperations`·`routeRequestsInTurn` 뒤에 있다**(적대적 리뷰 C-2): 계약을 어긴
 * verify turn이라도 그 turn이 **승인 경계 안에서 집행한 write·run_process 영수증은 durable에 남는다**.
 * 막는 것은 **완료와 결과 발행**이지 이미 승인된 효과의 되돌림이 아니다(되돌림은 이 계층에 없다).
 *
 * **막지 못하는 것(정직하게 · `C-98` 잔여)**: 앞선 참가자(저자·리뷰어·수정자)의 **개별 결과는 이미
 * 발행된 뒤**다. 개별 발행까지 막으려면 참가자 신원을 durable schema에 넣고 kernel이 발행을 거부해야
 * 하는데 그것은 state 마이그레이션(`C-9`)이 딸린 별도 승인 범위다. 지금 계약은 **run 완주 게이트**다.
 *
 * ## 참가자 신원을 어디서 가져오는가
 *
 * durable만 본다: `roleId`가 provider를(리뷰어 family → codex) `execution.turnId`가 세션을 표현한다.
 * **`fresh: true`는 구조적으로 참이다** — worker는 turn마다 새 프로세스를 띄우고 resume하지 않는다.
 * 다만 그래서 계약의 freshness 축은 이 배선에서 **동어반복**이고(늘 참), 실제로 판정되는 것은
 * provider 분업 · sandbox · 세션 재사용 없음 · 렌즈 집합이다. 그 한정은 `C-86`/`C-98`에 적혀 있다.
 */
function reviewRoundtripGate(kernel: OrchestrationKernel, taskId: string, currentTurnId: string): string | null {
  const spec = kernel.getManifest().reviewRoundtrip;
  if (spec === undefined || spec.verify !== taskId) return null;
  const participant = (id: string): RoundtripParticipant | null => {
    const t = kernel.getTask(id);
    if (t === null) return null;
    const codex = t.roleId.split(".")[0] === CODEX_REVIEWER_ROLE_FAMILY;
    return {
      taskId: id,
      roleId: t.roleId,
      provider: codex ? "codex" : "claude",
      // **진행 중인 turn은 durable에 아직 없다**: `execution.turnId`는 이 turn이 착지한 뒤에 적히므로
      // 게이트가 도는 시점(결과 봉인 직전)에는 비어 있다. 그 자리에는 지금 이 turn의 신원을 쓴다 —
      // 지어낸 값이 아니라 **이 세션의 실제 id**이고, 다른 참가자와 겹치지 않는다는 검사도 그대로 받는다.
      sessionId: id === taskId ? currentTurnId : t.execution.turnId ?? "",
      ...(codex ? { sandbox: "read-only" } : {}),
      fresh: true,
    };
  };
  const author = participant(spec.author);
  const code = participant(spec.reviews.code);
  const security = participant(spec.reviews.security);
  const test = participant(spec.reviews.test);
  const revision = participant(spec.revision);
  const verify = participant(spec.verify);
  // 승인이 지목한 task가 durable에 없으면 **통과시키지 않는다**(없는 참가자를 빈 값으로 채우면 그것이
  // 곧 공허한 게이트다).
  if (author === null || code === null || security === null || test === null || revision === null || verify === null) {
    return "roundtrip_participant_missing";
  }
  try {
    assertCodeReviewRoundtrip({ author, reviews: { code, security, test }, revision, verify, testLens: "test" });
  } catch (err) {
    // `DesignRoundtripError.code`는 닫힌 안정 slug다(경로·내용이 실리지 않는다).
    return err instanceof DesignRoundtripError ? err.code : "roundtrip_check_failed";
  }
  return null;
}

function workerPrompt(kernel: OrchestrationKernel, taskId: string): string {
  const task = kernel.getTask(taskId);
  const assignment = kernel.getState().messages.find((m) => m.taskId === taskId && m.type === "task_assignment");
  const body = assignment === undefined ? "(지시 없음)" : kernel.messageBody(assignment.messageId);
  return [
    "너는 이 harness의 worker다. 아래 지시와 문맥만 근거로 **계획 문서 하나**를 낸다.",
    "",
    "## 지시(중앙이 발행한 task assignment)",
    body,
    "",
    "## 문맥(durable에서 파생 — 포인터와 요약뿐이다)",
    kernel.contextBundle(taskId),
    "",
    "## 출력 계약",
    planContractPrompt(),
    "",
    `이 task의 role은 \`${task?.roleId ?? "unknown"}\`이다.`,
    // 계약을 **마지막에 한 번 더** 적는다: 모델은 끝부분 지시에 더 크게 반응하고, 첫 live 시도에서
    // 실제로 계약 밖 산문이 나왔다(그 turn은 산출물로 승격되지 않았다 — 검증기가 막았다).
    "",
    "다시: 응답 전체가 JSON 객체 하나여야 한다.",
  ].join("\n");
}

// ── 오케스트레이션 요청 배선 (V3 M6 T2) ────────────────────────────────────

/**
 * **turn 안에서 처리할 요청**(전달)과 **spawn turn의 사전 조건**을 본다. 통과하면 `null`, 아니면
 * 이 turn을 완료로 접지 않는 marker를 돌려준다.
 *
 * spawn turn에 `result.outputs`가 있으면 거부하는 이유: spawn은 결과 발행이 아니라 **위임**이고
 * (`requestSpawn`이 봉인된 결과를 놓는다) 그래서 그 turn의 artifact를 등록할 커밋이 없다. 그대로 두면
 * 계획이 산출물을 주장했는데 아무 데도 등록되지 않는 **조용한 유실**이 된다 → 계획 단계에서 닫는다.
 */
function routeRequestsInTurn(
  kernel: OrchestrationKernel,
  taskId: string,
  turnId: string,
  plan: TypedExecutionPlan,
  clock: () => Date,
  emit: (e: AutopilotEvent) => void,
): AutopilotMarker | null {
  if (requestsOfKind(plan.requests, "spawn_child").length > 0 && plan.result.outputs.length > 0) {
    emit({ kind: "task_progress", taskId, detail: "spawn_turn_outputs_rejected" });
    return "plan_invalid";
  }
  // [M7 T6] 전달과 사람 결정 요청은 **같은 자리**에서 처리한다(둘 다 sender가 active일 때만 수락된다).
  // 결정 요청을 여기서 빠뜨리면 계획이 사람에게 물었는데 아무 데도 남지 않는 조용한 유실이 된다.
  const deliveries = [
    ...requestsOfKind(plan.requests, "deliver_status"),
    ...requestsOfKind(plan.requests, "request_decision"),
  ];
  if (deliveries.length === 0) return null;
  const outcomes: AgentRequestOutcome[] = applyAgentRequests({
    kernel,
    taskId,
    turnId,
    requests: deliveries,
    nextId: id,
    clock,
  });
  const failed = outcomes.find((o) => o.code !== null);
  if (failed === undefined) return null;
  // 전달 거부는 **삼키지 않는다**: 이 turn은 완료가 아니고 결과도 발행되지 않는다(pause로 착지).
  emit({ kind: "task_progress", taskId, detail: `deliver_denied:${failed.code}` });
  return "delivery_failed";
}

// ── typed operation 집행 (M5d task 2 — `B-10` 소비면) ───────────────────────

/**
 * **승인된 typed operation을 계획 순서대로 집행한다.**
 *
 * 이 함수가 여는 것은 **집행 하나뿐**이다 — 권위는 전부 kernel이 쥐고 있고 여기에는 판정이 없다:
 * 승인 레코드 대조 · 소유권 · `writableRoots` · digest 재검증 · spawn 상한 · deadline · 멱등 pending은
 * 전부 `beginOperation`/집행기 안에서 일어난다. autopilot이 고를 수 있는 것은 **계획에 이미 있는
 * operationId의 순서**뿐이고, 실행 대상·argv·경로·바이트를 고르는 통로는 존재하지 않는다.
 *
 * **하나라도 닫히지 않으면 turn이 완료가 아니다.** 실패한 operation은 열린 pending으로 남지 않는다:
 * 집행 경계에 들어가지 않았으면 `failOperation`, 들어갔으면(외부 효과가 있었을 수 있다)
 * `reconcileUncertainOperation`의 `outcome_unknown`으로 **정직하게** 닫는다.
 *
 * 둘 다 실패해 pending이 남으면 **`chargeTurnUsage`가 아니라** 착지 전이가 막는다(이 turn은 이미 권위
 * 있게 과금돼 있어 뒤쪽 과금은 건너뛴다): `recordTerminal`/`pauseTask`의 `assertNoPendingOperations`가
 * `operation_pending_unreconciled`로 던지고, 그 throw는 `C-55` catch가 `turn_aborted`로 받아 loop를
 * 멈춘다. 어느 쪽이든 **조용한 진행은 없다** — 다만 정지 경로는 `B-22`가 아니라 이쪽이다.
 *
 * live·네트워크는 이 경로로도 열리지 않는다 — `run_process`가 실행하는 것은 승인 manifest가 digest로
 * 고정한 `node <controllerEntrypoint>`뿐이고 action은 닫힌 enum이다.
 */
async function dispatchOperations(ctx: {
  kernel: OrchestrationKernel;
  taskId: string;
  turnId: string;
  plan: TypedExecutionPlan;
  usage: { inputTokens: number; outputTokens: number };
  elapsedMs: number;
  signal?: AbortSignal;
}): Promise<DispatchResult> {
  const { kernel, taskId, turnId, plan, signal } = ctx;
  let permit: OperationDispatchPermit;
  try {
    permit = kernel.issueOperationDispatchPermit({ taskId, turnId, actionId: id("permit"), plan });
  } catch (err) {
    // permit이 없으면 claim도 없다 — 이 turn은 평범한 과금으로 닫힌다.
    return { marker: operationMarker(err), charged: false, chargeFailed: null };
  }

  // **순서가 계약이다: 권위 과금 → grant → 효과.** kernel은 "이 계획의 turn을 kernel 발급 권위로
  // 과금했는가"를 효과 게이트에서 본다(`budget_turn_unaccounted`) — 효과를 승인하는 것은 **과금된
  // 생산 turn**이지 호출자의 선언이 아니다. 그래서 여기서 먼저 적는다.
  try {
    kernel.chargeDispatchTurnUsage({
      permit,
      actionId: id("charge"),
      inputTokens: ctx.usage.inputTokens,
      outputTokens: ctx.usage.outputTokens,
      elapsedMs: ctx.elapsedMs,
    });
  } catch (err) {
    // `B-22`와 같은 처분: 원장에 없는 turn으로는 효과를 승인하지 않는다(operation 0건 · pending 0건).
    return { marker: operationMarker(err), charged: false, chargeFailed: codeOf(err) };
  }

  // **operation은 permit이 쥔 계획에서 꺼낸다.** kernel이 계획을 다시 검증하면서 자기 사본을 만들므로,
  // 호출자가 들고 있던 객체를 그대로 넘기면 grant 결박 검사에서 `dispatch_operation_unbound`다.
  // (이 결박이 곧 "계획 밖 operation·치환된 operation은 표현할 수 없다"는 계약이다.)
  for (const op of permit.plan.operations) {
    if (signal?.aborted) return { marker: "cancelled", charged: true, chargeFailed: null };
    // **승인 여부는 등록보다 먼저 본다.** facade의 권위 해석은 순수 판정이고(파일 시스템 무접촉 ·
    // grant 미소비) 집행기는 durable pending을 `attemptedAt`으로 먼저 찍은 **뒤에** 승인을 다시 읽는다.
    // 그래서 이 사전 판정이 없으면 **한 번도 효과가 없었던 거부**가 `outcome_unknown`으로 기록된다 —
    // 승인 밖 요청과 "정말 결과를 모르는" 요청이 같은 marker를 받아서는 안 된다.
    try {
      if (op.kind === "write_file") resolveWriteFileAuthority(op, permit);
      else if (op.kind === "run_process") resolveProcessLaunchCapability(op, permit);
      // V3 M9 T3③ — 격리 worktree. 사전 판정도 다른 kind와 **같은 자리**를 지난다(순수 판정 · 효과 0).
      else resolveWorktreeCapability(op, permit);
    } catch (err) {
      return { marker: operationMarker(err), charged: true, chargeFailed: null };
    }
    let grant: OperationExecutionGrant;
    try {
      grant = kernel.beginOperation({ permit, operationId: op.operationId, actionId: id("op") });
    } catch (err) {
      // 등록 자체가 거부되면 durable pending도 효과도 없다 — 닫을 것이 없다.
      return { marker: operationMarker(err), charged: true, chargeFailed: null };
    }
    try {
      const outcome =
        op.kind === "write_file"
          ? applyWriteFile(op, grant)
          : op.kind === "run_process"
            ? await executeRunProcessOperation(grant, op, resolveProcessLaunchCapability(op, grant), { signal })
            : await executeWorktreeOperation(grant, op, resolveWorktreeCapability(op, grant), { signal });
      kernel.recordOperationReceipt({ outcome, actionId: id("rcpt") });
    } catch (err) {
      closePendingOperation(kernel, grant, taskId, op.operationId, err);
      return { marker: operationMarker(err), charged: true, chargeFailed: null };
    }
  }
  return { marker: "turn_completed", charged: true, chargeFailed: null };
}

/** 집행 결과 + **이 turn이 원장에 들어갔는가**. 과금은 집행보다 먼저 일어나므로 여기서 함께 보고한다. */
interface DispatchResult {
  marker: AutopilotMarker;
  /** `true`면 `chargeDispatchTurnUsage`가 이미 성공했다 — 뒤에서 다시 과금하지 않는다. */
  charged: boolean;
  /** 권위 과금이 거부된 코드(`B-22` 처분 대상). */
  chargeFailed: string | null;
}

/**
 * 실패한 operation의 durable pending을 닫는다. **성공을 만들 수 없는 두 경로뿐이다.**
 *
 * `failOperation`은 집행 경계에 들어가지 않은 pending만 받는다(들어간 것을 평범한 실패로 지우면 부분
 * 외부 효과가 기록에서 사라진다). 그래서 거부되면 durable 신원으로 `reconcileUncertainOperation`을 부른다 —
 * marker는 호출자 입력이 아니라 durable 진실에서 파생되므로 여기서 결과를 지어낼 수 없다.
 * 둘 다 실패하면 **삼키지 않는다**: pending이 남아 turn을 닫을 수 없고 loop가 멈춘다.
 */
function closePendingOperation(
  kernel: OrchestrationKernel,
  grant: OperationExecutionGrant,
  taskId: string,
  operationId: string,
  cause: unknown,
): void {
  try {
    kernel.failOperation({ grant, actionId: id("failop"), marker: isDenial(cause) ? "denied" : "failed" });
    return;
  } catch {
    /* 집행 경계에 들어간 pending이다 — 아래 정합화로만 정직하게 닫힌다. */
  }
  const task = kernel.getTask(taskId);
  const exec = task?.execution;
  if (!task || exec?.attemptId == null || exec.dispatchTurnId == null || exec.dispatchPlanDigest == null) return;
  const op = task.execution.pendingOperations.find((p) => p.operationId === operationId);
  if (op === undefined) return;
  try {
    kernel.reconcileUncertainOperation({
      runId: kernel.getState().runId,
      taskId,
      attemptId: exec.attemptId,
      turnId: exec.dispatchTurnId,
      planDigest: exec.dispatchPlanDigest,
      operationId,
      kind: op.kind,
      authorityId: op.authorityId,
      actionId: id("recon"),
    });
  } catch {
    /* 남은 pending은 착지 전이(`assertNoPendingOperations`)가 막는다 → `C-55` 경로로 loop가 멈춘다. */
  }
}

/** 이미 권위 있게 과금된 turn을 두 번 적지 않기 위한 내부 신호(오류가 아니다). */
class SkipCharge extends Error {}

/** 거부(승인 밖·권위 위반)와 집행 실패를 나눈다 — 전자만 `denied` 영수증을 받는다. */
function isDenial(err: unknown): boolean {
  const code = codeOf(err);
  return code.startsWith("dispatch_") || code.startsWith("operation_") || code === "plan_invalid";
}

/** 집행 단계 오류 → 닫힌 `AutopilotMarker`. 데이터가 marker를 고르지 못한다. */
function operationMarker(err: unknown): AutopilotMarker {
  const code = codeOf(err);
  if (code === "process_cleanup_unconfirmed") return "cleanup_unconfirmed";
  if (code.startsWith("process_")) return "process_failed";
  if (code === "plan_invalid") return "plan_invalid";
  return "operation_denied";
}

/**
 * worker 이벤트 1건을 durable 진행으로 반영한다. `progress`만 no-progress 시계를 되돌린다
 * (`heartbeat`·`started`·`terminal`은 kernel이 거부하므로 아예 보내지 않는다).
 */
function applyWorkerEvent(
  kernel: OrchestrationKernel,
  channel: WorkerProgressChannel,
  ev: WorkerEvent,
  seq: number,
): { progress: boolean; step?: string } {
  if (ev.kind !== "progress") return { progress: false };
  kernel.recordProgress({ channel, actionId: id("prog"), event: { kind: "progress", seq, step: ev.step } });
  return { progress: true, step: ev.step };
}

// ── 게이트 ──────────────────────────────────────────────────────────────────

/**
 * **run 수준 deadline·예산.** 전부 **durable** 값에서 나온다(`accounting.budgetDeadlineAt` ·
 * `manifest.expiresAt` · `remainingBudget()`) → 프로세스를 다시 띄워도 예산이 새로 생기지 않는다(`B-12`).
 */
function budgetGate(kernel: OrchestrationKernel, clock: () => Date): string | null {
  const now = formatTimestamp(clock());
  const manifest = kernel.getManifest();
  if (now >= manifest.expiresAt) return "manifest_expired";
  const remaining = kernel.remainingBudget(now);
  if (remaining.elapsedMs <= 0) return "budget_elapsed_exhausted";
  if (remaining.tokens !== null && remaining.tokens <= 0) return "budget_tokens_exhausted";
  return null;
}

/**
 * **attempt 수준 deadline**: wall-clock(`execution.wallDeadlineAt` — kernel이 계산한 값)과
 * no-progress(`lastProgressAt ?? phaseStartedAt` + `autopilotPolicy.maxNoProgressMs`).
 * 등호 경계는 kernel의 효과 게이트와 같은 `>=`다.
 *
 * ponytail: 타이머 race가 아니라 **이벤트 사이의 시각 판정**이다 — 이 slice의 유일한 backend가
 * blocking하지 않는 in-memory 스트림이라 그것으로 bounded가 보장된다(스트림 길이도 상한이 있다).
 * blocking backend를 붙이는 slice가 타이머를 가져와야 한다.
 */
function attemptDeadline(kernel: OrchestrationKernel, taskId: string, clock: () => Date): AutopilotMarker | null {
  const task = kernel.getTask(taskId);
  if (!task) return "worker_failed";
  const now = formatTimestamp(clock());
  const exec = task.execution;
  if (exec.wallDeadlineAt !== null && now >= exec.wallDeadlineAt) return "wall_deadline_exceeded";
  const base = exec.lastProgressAt ?? exec.phaseStartedAt;
  if (base !== null) {
    const limit = Date.parse(base) + kernel.getManifest().autopilotPolicy.maxNoProgressMs;
    if (Date.parse(now) >= limit) return "no_progress_timeout";
  }
  return null;
}

/** 실패 marker → 닫힌 `PauseReason`. 모르는 marker는 사람 판단이 필요하다는 뜻이다. */
function pauseReasonFor(marker: AutopilotMarker): PauseReason {
  switch (marker) {
    case "wall_deadline_exceeded":
    case "no_progress_timeout":
      return "budget_elapsed_exhausted";
    case "cancelled":
      return "interrupted";
    default:
      return "approval_required";
  }
}

// ── 순수 helper ─────────────────────────────────────────────────────────────

/**
 * 운영자가 authoring하는 **계획 문서**: `{operations, result}` 둘뿐이다.
 *
 * **binding(run/task/attempt/turn)은 문서에 없다** — 그 값은 durable state에서만 나오며 turn 직전에
 * autopilot이 채운다. 그래서 어떤 계획 파일도 "다른 run·다른 attempt의 계획"을 주장할 수 없고,
 * 재사용된 파일이 낡은 attempt를 부활시키지도 못한다.
 */
interface PlanDocument {
  operations: unknown;
  /** 오케스트레이션 요청(V3 M6 T2). key가 없는 문서는 `undefined`로 남아 계획에도 실리지 않는다. */
  requests: unknown;
  result: unknown;
}

/** `<planDir>/<taskId>.json`. taskId는 kernel이 검증한 slug이므로 경로 탈출이 표현되지 않는다. */
function readPlanDocument(planDir: string, taskId: string): PlanDocument | null {
  try {
    const file = join(planDir, `${assertSlug(taskId, "taskId")}.json`);
    const bytes = readFileSync(file);
    if (bytes.byteLength > MAX_PLAN_JSON_BYTES) return null;
    // `JSON.parse`의 결과는 평범한 데이터다(accessor·proxy·함수가 없다). 형태 판정은 전부 worker의
    // 닫힌 validator가 한다 — 여기서는 두 field를 옮기기만 한다.
    const doc = JSON.parse(bytes.toString("utf8")) as unknown;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
    const read = doc as PlanDocument;
    return { operations: read.operations, requests: read.requests, result: read.result };
  } catch {
    return null;
  }
}

/** 계획 문서 + durable binding → worker 입력 바이트. 검증은 worker가 정확히 한 번 한다. */
function encodePlan(doc: PlanDocument, binding: { runId: string; taskId: string; attemptId: string; turnId: string }): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
      ...binding,
      operations: doc.operations,
      // 요청이 없는 문서는 `requests` key **자체를 싣지 않는다** — 생략과 빈 배열을 계획 계약이 같게 본다.
      ...(doc.requests === undefined ? {} : { requests: doc.requests }),
      result: doc.result,
    }),
  );
}

function boundedIterations(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return DEFAULT_MAX_ITERATIONS;
  return Math.min(Math.floor(v), DEFAULT_MAX_ITERATIONS);
}

function boundedUsage(raw: { inputTokens: number; outputTokens: number }): { inputTokens: number; outputTokens: number } {
  const clamp = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return { inputTokens: clamp(raw?.inputTokens), outputTokens: clamp(raw?.outputTokens) };
}

/** worker·계획 검증 오류를 닫힌 marker로 접는다(호출자·데이터가 marker를 고르지 못한다). */
/**
 * turn 예외 → **닫힌 durable marker**(V3 M10 T7 · `C-96` 부류 수정).
 *
 * 이전 판은 `worker_` 접두사가 **아닌 모든 코드**를 `plan_invalid`로 접었다. 그래서 승인 축의 거부
 * (`codex_home_not_empty`·`codex_home_not_owned`·`codex_home_permissive`·`codex_home_identity_changed`
 * 처럼 접두사가 다른 코드들)가 durable 감사 로그에 **"모델이 잘못된 계획을 냈다"** 로 남았다 —
 * 일어나지 않은 일이다. T7 live에서 리뷰어 3턴이 전부 그 거짓 marker 뒤에 숨었고(실제 원인은
 * `codex_home_not_empty`) 원인을 좁히는 데 세션 하나가 들었다.
 *
 * 이제 **계획 계약 위반만** `plan_invalid`다: `validateTypedExecutionPlan`은 모든 위반(미상 key·타입·
 * 상한·binding·accessor/proxy)을 그 코드 **하나로** 접으므로(`TYPED_EXECUTION_CODES`) 이 대조 하나면
 * 충분하다. 그 밖은 전부 `worker_failed`이고, **원본 코드는 pause 이벤트의 `detail`로 올린다**
 * (marker 집합은 durable schema라 여기서 넓히지 않는다).
 *
 * 기각한 대안: 코드 이름이 우연히 marker 집합에 있으면 그대로 쓰는 것(`stream_invalid` 등). 이름
 * 일치를 계약으로 삼으면 무관한 코드가 조용히 marker가 된다 — 지금 고치는 것과 같은 종류의 거짓이다.
 */
function workerMarker(err: unknown): AutopilotMarker {
  return codeOf(err) === "plan_invalid" ? "plan_invalid" : "worker_failed";
}

function codeOf(err: unknown): string {
  return err instanceof OrchestrationError ? err.code : "autopilot_internal_error";
}

function id(kind: string): string {
  return `${kind}.${randomBytes(8).toString("hex")}`;
}

function resultEnvelope(kernel: OrchestrationKernel, task: OrchestrationTask): AgentMessageEnvelope {
  const state = kernel.getState();
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    messageId: `res.${task.taskId}`,
    runId: state.runId,
    milestoneId: state.milestoneId,
    taskId: task.taskId,
    parentTaskId: task.parentTaskId,
    sender: task.roleId,
    recipient: ORCHESTRATOR_ID,
    type: "result",
    createdAt: formatTimestamp(new Date()),
    dependsOn: [],
    artifactRefs: [],
    supersedes: null,
  };
}

/**
 * §5.2 `result` 필수 heading 전부 + **bounded 안정 서술만**. raw 출력·프롬프트·토큰 카운터는 들어가지
 * 않는다. heading 목록을 상수에서 **파생**하므로 계약이 바뀌면 자동으로 따라간다(하드코딩 사본 없음).
 */
/**
 * 이 turn의 typed operation을 **durable 영수증에서** kind·marker별로 적는다.
 *
 * **계획에서 파생하지 않는 이유**(T2 적대적 리뷰 B1): 계획은 "무엇을 하려 했는가"이고 영수증은
 * "무엇이 일어났는가"다. 둘이 갈리는 완료 경로가 실재한다 — `write_file`의 preimage가 어긋나면
 * 집행기가 **쓰지 않고** `write_conflict` 영수증을 내는데, 그 turn은 여전히 `turn_completed`로
 * 완료된다(fail closed는 영수증에 남지만 예외를 던지지 않는다). 계획 기준으로 적으면 그 본문에
 * "집행했다"만 남아 **바이트가 바뀌지 않은 것을 바뀐 것처럼** 읽힌다.
 *
 * 담는 것은 닫힌 값뿐이다: kind(닫힌 union 3종) · marker(닫힌 6종) · 개수(정수). 경로·내용·계측값은
 * 담지 않는다(경로는 Deliverables 절이 검증된 산출물로만 적는다).
 */
function operationsPerformed(plan: TypedExecutionPlan, receipts: readonly { kind: string; marker: string; turnId: string }[], turnId: string): string {
  if (plan.operations.length === 0) {
    return "- typed operation을 집행하지 않았다(이 계획에 operation이 없다).";
  }
  const mine = receipts.filter((r) => r.turnId === turnId);
  if (mine.length === 0) {
    // 계획에 operation이 있는데 이 turn의 영수증이 없다 = 완료 경로가 아니다(도달 불가). 지어내지 않는다.
    return `- 이 turn의 typed operation 영수증이 durable에 없다(계획 ${plan.operations.length}건).`;
  }
  const counts = new Map<string, number>();
  for (const r of mine) {
    const key = `${r.kind}→${r.marker}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, n]) => `${key}×${n}`)
    .join(" · ");
  return `- 승인 경계 안에서 typed operation ${mine.length}건을 집행했다 — 영수증: ${summary}. (\`write_conflict\`는 **쓰지 않고** 닫힌 것이다.)`;
}

function resultBody(
  taskId: string,
  plan: TypedExecutionPlan,
  receipts: readonly { kind: string; marker: string; turnId: string }[],
  turnId: string,
  /**
   * 이 turn이 **실제로 돈** backend(`backendForRole` 결과 — role에 따라 `codex-plan`일 수 있다).
   *
   * **V3 M11 — A급 거짓 영수증 수정.** 이전 판은 이 자리에 `OFFLINE_PLAN_BACKEND`를 **하드코딩**하고
   * "offline plan turn 1회를 진행했다"를 고정 문장으로 적었다. M5c에서는 backend가 하나였으니 참이었지만
   * M10 T3/T7이 live worker를 연 뒤로 **live turn의 durable 결과 본문이 "offline"이라고 주장**했다 —
   * 사람이 읽는 감사 산출물의 거짓 진술이고, M11에서 `--worker-backend`가 CLI에 노출되면 그 거짓이
   * 운영 경로의 기본 산출물이 된다. 담는 것은 닫힌 backend 식별자 하나뿐이다(원문·계측값 없음).
   */
  backend: AutopilotWorkerBackend | "codex-plan",
): string {
  const deliverables = plan.result.outputs.length === 0 ? "- (없음)" : plan.result.outputs.map((o) => `- ${o.path} (${o.role})`).join("\n");
  const filled: Record<string, string> = {
    "Result Summary": `- task: ${taskId}\n- backend: ${backend}`,
    "Work Performed": `- autopilot이 승인 경계 안에서 \`${backend}\` worker turn 1회를 진행했다.`,
    // **durable 본문은 실제로 일어난 일만 적는다**(V3 M10 T2 — A급 수정). 이전 판은 이 줄을
    // `"typed operation은 집행하지 않았다(계획에 operation이 없는 turn만 발행된다)"`로 **고정**해
    // 두었다. M5c에서는 참이었지만 **M5d task 2가 typed operation 집행을 연 뒤로 거짓**이다 —
    // operation을 실제로 집행하고 완료한 turn의 결과 본문에 "집행하지 않았다"가 남았다.
    // 사람이 읽는 durable 감사 산출물의 거짓 진술이므로 계획에서 파생한다(kind는 닫힌 enum이고
    // 개수는 정수라 원문·계측값이 새지 않는다).
    "Decisions and Assumptions": operationsPerformed(plan, receipts, turnId),
    Deliverables: deliverables,
    "Tests and Evidence": `- 검증된 산출물 ${plan.result.outputs.length}건 · kernel이 소유권·hash를 재확인했다.`,
    "Risks / Known Limitations": "- 중앙은 bounded 요약과 검증된 포인터만 옮긴다 — 원문·계측값은 durable에 남기지 않는다.",
    "Unresolved Questions": "- (없음)",
    "Recommended Next Action": "- 다음 ready batch를 진행한다.",
  };
  return REQUIRED_BODY_HEADINGS.result.map((h) => `## ${h}\n\n${filled[h] ?? "- (없음)"}`).join("\n\n");
}

// ── CLI 배선 ────────────────────────────────────────────────────────────────

export interface AutopilotCliOptions {
  workspace?: string;
  run: string;
  milestone: string;
  /** `offline-plan`에서만 필수다(아래 arity 판정). live backend는 읽지 않는다. */
  planDir?: string;
  /** `AUTOPILOT_WORKER_BACKENDS` 안의 값. 미지정은 `offline-plan`이다(기본값의 유일한 자리). */
  workerBackend?: string;
  maxIterations?: string;
  json: boolean;
}

/** `harness autopilot` 명령 본체. 출력은 stdout, run 수준 거부는 exit 2다. */
export async function runAutopilotCommand(opts: AutopilotCliOptions): Promise<void> {
  const workspaceRoot = resolve(opts.workspace ?? process.cwd());
  /**
   * **backend 기본값의 유일한 자리**(V3 M11). `claude-plan`은 구독 한도를 소모하므로 사람이 **명시**해야
   * 한다 — 기본값을 live로 만드는 것은 승인 없이 돈을 쓰는 경로다.
   *
   * 닫힌 집합 검사를 여기서 하는 이유: `runAutopilot`도 같은 검사를 갖고 있지만(프로그램 호출자 방어)
   * 그 검사는 **run을 열고 controller lease를 잡은 뒤**에 돈다 → 오타 하나로 durable 자리(lease 파일)를
   * 건드린다. 인자 검증은 아무것도 건드리기 전에 끝나야 한다.
   *
   * **기각한 대안**: commander `Option.choices()`. 거부가 parse 단계로 올라가 더 이르지만, 거부 경로가
   * commander의 exit(1)·stderr 계약에 묶여 이 함수를 직접 부르는 테스트가 그것을 밟을 수 없다.
   * 같은 판정을 두 곳에 두지 않고 **여기 하나**로 둔다(`--help`가 집합을 그대로 적는다).
   */
  const backend = opts.workerBackend ?? OFFLINE_PLAN_BACKEND;
  if (!(AUTOPILOT_WORKER_BACKENDS as readonly string[]).includes(backend)) {
    process.stdout.write(
      `[autopilot] 거부: --worker-backend는 ${AUTOPILOT_WORKER_BACKENDS.join(" | ")} 중 하나여야 한다(받은 값: ${backend})\n`,
    );
    process.exitCode = 2;
    return;
  }
  /**
   * **`--plan-dir` arity는 backend가 정한다.** 이전 판은 `requiredOption`이어서 live 실행에도 **읽히지
   * 않는 인자**를 강제했다(`LIVE_PLACEHOLDER` 갈래는 그 값을 한 번도 보지 않는다).
   *
   * - offline: 여전히 **필수**다. 없으면 거부한다 — 빈 디렉터리로 취급하면 전 task가 `plan_missing`으로
   *   defer되어 "계획이 없다"와 "계획 자리를 안 줬다"가 같은 결과로 보인다(조용한 fallback).
   * - live: 주면 **거부**한다. 조용히 무시하면 운영자는 그 디렉터리의 계획이 쓰였다고 믿는다 — 읽지
   *   않는 인자를 받아 주는 것이 곧 그 오해를 만드는 자리다.
   *
   * 이 두 판정 중 offline 쪽은 `runAutopilot`에도 있다(CLI 아닌 호출자 방어). live 쪽은 CLI에만 둔다:
   * `runAutopilot`은 계획 디렉터리를 **무해하게 무시**하는 것이 계약이고(기존 live 스크립트들이 그렇게
   * 부른다) 오해가 생기는 지점은 사람이 argv를 치는 자리다.
   */
  // **빈 문자열은 "주지 않은 것"과 같이 취급한다**(M11 적대적 리뷰 C-3). `--plan-dir ""`은 `undefined`
  // 검사를 지나 `resolve("")` = cwd가 되어 **운영자가 의도하지 않은 디렉터리**를 계획 자리로 삼는다.
  // 관측 가능하긴 하나(전 task `plan_missing` defer) arity 판정의 구멍이므로 여기서 닫는다.
  if (backend === OFFLINE_PLAN_BACKEND && (opts.planDir === undefined || opts.planDir.trim() === "")) {
    process.stdout.write(`[autopilot] 거부: --worker-backend ${OFFLINE_PLAN_BACKEND}에는 --plan-dir이 필요하다\n`);
    process.exitCode = 2;
    return;
  }
  if (backend !== OFFLINE_PLAN_BACKEND && opts.planDir !== undefined && opts.planDir.trim() !== "") {
    process.stdout.write(`[autopilot] 거부: --worker-backend ${backend}는 --plan-dir을 읽지 않는다(계획은 모델이 만든다)\n`);
    process.exitCode = 2;
    return;
  }
  const planDir = opts.planDir === undefined ? undefined : isAbsolute(opts.planDir) ? opts.planDir : resolve(opts.planDir);
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.on("SIGINT", onSigint);
  try {
    const report = await runAutopilot({
      workspaceRoot,
      runId: opts.run,
      milestoneId: opts.milestone,
      planDir,
      workerBackend: backend as AutopilotWorkerBackend,
      maxIterations: opts.maxIterations === undefined ? undefined : Number(opts.maxIterations),
      signal: ac.signal,
      // **V3 M9 선결 4(F2)**: 사람이 보는 경로는 v1 F2 렌더러를 재사용한다(스피너·경과시간·비-TTY
      // 자동 강등 — 새 렌더러·새 의존성 0). `--json`은 **기계 계약**이므로 원본 event를 그대로 흘린다.
      onEvent: opts.json
        ? (e): void => {
            process.stdout.write(`${JSON.stringify(e)}\n`);
          }
        : autopilotProgressBridge(createProgressReporter()),
    });
    process.stdout.write(
      opts.json
        ? `${JSON.stringify(report)}\n`
        : `[autopilot] 종료: ${report.stoppedBecause} · iterations=${report.iterations} · tasks=${report.tasks.length}\n`,
    );
    if (report.blocked !== null) {
      process.stdout.write(`[autopilot] 실행 거부: ${report.blocked}\n`);
      process.exitCode = 2;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/** 상한 상수를 테스트가 계약으로 단정할 수 있게 내보낸다. */
export const AUTOPILOT_LIMITS = Object.freeze({ maxIterations: DEFAULT_MAX_ITERATIONS, maxSummaryLength: LIMITS.maxSummaryLength });
