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
 *   이 loop는 **프로세스를 하나도 띄우지 않는다**(worker는 in-memory 데이터 어댑터다) → 자손이
 *   구조적으로 0이고, 그럼에도 kernel의 순서 계약을 그대로 지난다:
 *   `recordTerminal`(→`cleaning`) → `confirmCleanup` → 완료/pause.
 * - **`B-17`(실패한 전달이 `activeAttemptId`를 남긴다)** — 소비하지 않는다. 이 loop는
 *   `beginDeliveryAttempt`를 **부르지 않는다**(inbox 전달은 provider 세션 계약이며 이 slice 밖이다) →
 *   열린 채 남을 attempt가 생기지 않는다. inbox가 있는 task도 여기서는 그냥 pause될 뿐이다.
 * - **`B-10`(타입 있는 edit 가능 실행 집행)** / **`B-16`(real typed-write 산출물 발행)** — 소비하지 않는다.
 *   **typed operation을 하나도 dispatch하지 않는다**: `issueOperationDispatchPermit`·`beginOperation`·
 *   `executeWriteFileOperation`·`executeRunProcessOperation`을 부르는 코드가 이 파일에 없다.
 *   worker 계획에 operation이 **1건이라도** 있으면 그 turn은 집행 대신 `operation_denied`로 닫히고
 *   task는 `paused(approval_required)`로 착지한다(hang 없음 · 복구 가능). 발행되는 artifact는
 *   **이미 디스크에 있고 그 task가 소유한 파일**뿐이며 kernel이 소유권·`writableRoots`·hash를 집행한다.
 * - **`B-7`/`B-9`(live)** — 소비하지 않는다. 유일한 backend는 `offline-plan`이고 `claude`·`codex`는
 *   worker가 hard reject한다. 네트워크 호출 0 · 추론 0 · spawn 0.
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
} from "../exec/orchestrationTypes.js";
import type { AgentMessageEnvelope, AutopilotMarker, OrchestrationTask, PauseReason } from "../exec/orchestrationTypes.js";
import { ORCHESTRATION_SCHEMA_VERSION } from "../exec/orchestrationTypes.js";
import { MAX_PLAN_JSON_BYTES, OFFLINE_PLAN_BACKEND, startOfflinePlanTurn } from "../exec/offlinePlanWorker.js";
import type { TypedExecutionPlan, WorkerEvent } from "../exec/autopilotTypes.js";
import { validateTypedExecutionPlan } from "../exec/typedPlan.js";
import { openOrchestrationRun } from "../exec/orchestrationKernel.js";
import type { OrchestrationKernel, WorkerProgressChannel } from "../exec/orchestrationKernel.js";

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
  /** `completed` · `paused` · `cancelled` · `deferred`. */
  state: string;
  marker: string;
}

export interface AutopilotReport {
  /** run 수준 거부 코드(있으면 task를 하나도 건드리지 않았다). */
  blocked: string | null;
  iterations: number;
  tasks: AutopilotTaskOutcome[];
  /** loop가 멈춘 안정 사유. */
  stoppedBecause: string;
}

export interface AutopilotOptions {
  workspaceRoot: string;
  runId: string;
  /** 운영자가 "이 승인 아래 돈다"고 명시하는 milestone. durable run과 다르면 시작하지 않는다. */
  milestoneId: string;
  /** task별 offline 계획 JSON 디렉터리(`<planDir>/<taskId>.json`). */
  planDir: string;
  maxIterations?: number;
  /** 시각 권위(테스트 주입용). */
  clock?: () => Date;
  /** 취소 신호 — 관측되면 진행 중 attempt를 정리하고 멈춘다. */
  signal?: AbortSignal;
  onEvent?: (e: AutopilotEvent) => void;
}

/** 이 모듈이 낼 수 있는 run 수준 거부 코드(닫힌 집합). */
export const AUTOPILOT_BLOCKED_CODES = [
  "approval_milestone_mismatch",
  "manifest_expired",
  "budget_elapsed_exhausted",
  "budget_tokens_exhausted",
  "run_unavailable",
] as const;

// ── 진입점 ──────────────────────────────────────────────────────────────────

export async function runAutopilot(opts: AutopilotOptions): Promise<AutopilotReport> {
  const emit = opts.onEvent ?? (() => undefined);
  const clock = opts.clock ?? (() => new Date());
  const tasks: AutopilotTaskOutcome[] = [];

  let kernel: OrchestrationKernel;
  try {
    kernel = openOrchestrationRun({ workspaceRoot: opts.workspaceRoot, runId: opts.runId, clock });
  } catch (err) {
    return { blocked: "run_unavailable", iterations: 0, tasks, stoppedBecause: codeOf(err) };
  }

  // **승인 게이트**: 운영자가 지목한 승인과 durable run의 승인이 같아야 한다. 다르면 아무것도 하지 않는다.
  const state = kernel.getState();
  if (state.milestoneId !== opts.milestoneId) {
    return { blocked: "approval_milestone_mismatch", iterations: 0, tasks, stoppedBecause: "approval_milestone_mismatch" };
  }
  const entry = budgetGate(kernel, clock);
  if (entry) return { blocked: entry, iterations: 0, tasks, stoppedBecause: entry };

  emit({ kind: "run_started", detail: `${state.runId}@${state.milestoneId}` });

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
    const batch = kernel.planRunnableBatch();
    if (batch.items.length === 0) {
      stoppedBecause = "no_runnable_tasks";
      break;
    }
    emit({ kind: "batch_planned", detail: batch.items.map((t) => t.taskId).join(",") });

    // **무인 전진의 자격은 "offline 계획이 실제로 있는가" 하나다**(`B-11`). 없으면 `deferred` —
    // 상태·attempt·자원을 건드리지 않으므로 사람이 계획을 넣고 다시 부르면 그대로 이어진다.
    const plans = new Map<string, PlanDocument>();
    for (const task of batch.items) {
      const doc = readPlanDocument(opts.planDir, task.taskId);
      if (doc) plans.set(task.taskId, doc);
    }
    kernel.commitPreflightBatch({
      baseRevision: batch.revision,
      actionId: id("pf"),
      decisions: batch.items.map((t) =>
        plans.has(t.taskId)
          ? ({ taskId: t.taskId, outcome: "prepared", attemptId: id("att") } as const)
          : ({ taskId: t.taskId, outcome: "deferred" } as const),
      ),
    });
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
      tasks.push(await runTaskTurn({ kernel, taskId, planDoc, clock, signal: opts.signal, emit }));
      if (opts.signal?.aborted) {
        stoppedBecause = "cancelled";
        break;
      }
    }
    if (stoppedBecause !== "iteration_limit") break;
  }

  emit({ kind: "run_finished", marker: stoppedBecause });
  return { blocked: null, iterations, tasks, stoppedBecause };
}

// ── task turn 하나 ──────────────────────────────────────────────────────────

interface TurnCtx {
  kernel: OrchestrationKernel;
  taskId: string;
  planDoc: PlanDocument;
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
  let plan: TypedExecutionPlan | null = null;
  let marker: AutopilotMarker = "worker_failed";
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const stream = startOfflinePlanTurn({
      backend: OFFLINE_PLAN_BACKEND,
      planJson: encodePlan(ctx.planDoc, { runId: kernel.getState().runId, taskId, attemptId, turnId }),
      binding: { runId: kernel.getState().runId, taskId, attemptId, turnId },
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
        marker = plan.operations.length > 0 ? "operation_denied" : "turn_completed";
      }
    }
  } catch (err) {
    marker = workerMarker(err);
    plan = null;
  }

  // **실패한 turn의 usage도 durable하게 적는다** — 그래야 다음 판정이 최신 총량을 본다(`B-12`).
  try {
    kernel.chargeTurnUsage({
      taskId,
      turnId,
      actionId: id("charge"),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      elapsedMs: Math.max(0, clock().getTime() - startedMs),
    });
  } catch {
    /* 회계 거부가 정리를 막지 않는다 — 정리는 언제나 진행된다. */
  }

  const sealed = marker === "turn_completed" && plan !== null ? { summary: plan.result.summary, outputs: [...plan.result.outputs] } : null;
  kernel.recordTerminal({ taskId, actionId: id("term"), marker, pendingResult: sealed });
  // 이 loop는 프로세스를 띄우지 않으므로 생존 자손이 **구조적으로 0**이다 → 정리는 언제나 확인된다.
  kernel.confirmCleanup({ taskId, actionId: id("clean"), leaseMarker });

  if (marker === "cancelled") {
    kernel.requestCancel({ taskId, actionId: id("cancel") });
    kernel.settleCleanedAttempt({ taskId, actionId: id("settle") });
    emit({ kind: "task_cancelled", taskId, marker });
    return { taskId, state: "cancelled", marker };
  }
  if (marker !== "turn_completed" || plan === null) {
    const reason = pauseReasonFor(marker);
    kernel.pauseTask({ taskId, actionId: id("pause"), pauseReason: reason });
    emit({ kind: "task_paused", taskId, marker, detail: reason });
    return { taskId, state: "paused", marker };
  }

  try {
    kernel.completeTaskWithArtifacts({
      envelope: resultEnvelope(kernel, started.task),
      body: resultBody(taskId, plan),
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
    return { operations: (doc as PlanDocument).operations, result: (doc as PlanDocument).result };
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
function workerMarker(err: unknown): AutopilotMarker {
  const code = codeOf(err);
  return code.startsWith("worker_") ? "worker_failed" : "plan_invalid";
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
function resultBody(taskId: string, plan: TypedExecutionPlan): string {
  const deliverables = plan.result.outputs.length === 0 ? "- (없음)" : plan.result.outputs.map((o) => `- ${o.path} (${o.role})`).join("\n");
  const filled: Record<string, string> = {
    "Result Summary": `- task: ${taskId}\n- backend: ${OFFLINE_PLAN_BACKEND}`,
    "Work Performed": "- autopilot이 승인 경계 안에서 offline plan turn 1회를 진행했다.",
    "Decisions and Assumptions": "- typed operation은 집행하지 않았다(계획에 operation이 없는 turn만 발행된다).",
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
  planDir: string;
  maxIterations?: string;
  json: boolean;
}

/** `harness autopilot` 명령 본체. 출력은 stdout, run 수준 거부는 exit 2다. */
export async function runAutopilotCommand(opts: AutopilotCliOptions): Promise<void> {
  const workspaceRoot = resolve(opts.workspace ?? process.cwd());
  const planDir = isAbsolute(opts.planDir) ? opts.planDir : resolve(opts.planDir);
  const ac = new AbortController();
  const onSigint = (): void => ac.abort();
  process.on("SIGINT", onSigint);
  try {
    const report = await runAutopilot({
      workspaceRoot,
      runId: opts.run,
      milestoneId: opts.milestone,
      planDir,
      maxIterations: opts.maxIterations === undefined ? undefined : Number(opts.maxIterations),
      signal: ac.signal,
      onEvent: (e) => {
        process.stdout.write(
          opts.json
            ? `${JSON.stringify(e)}\n`
            : `[autopilot] ${e.kind}${e.taskId ? ` ${e.taskId}` : ""}${e.marker ? ` ${e.marker}` : ""}${e.detail ? ` (${e.detail})` : ""}\n`,
        );
      },
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
