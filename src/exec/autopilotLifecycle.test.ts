/**
 * V3 M5c — **durable autopilot lifecycle / 회계 / v2 schema** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/autopilotLifecycle.test.ts`
 * 네트워크·LLM·provider·프로세스 없이 임시 workspace에서만 돈다(무과금).
 *
 * 이 파일이 덮는 계약:
 * - state/manifest v2 **fail closed**(마이그레이션·기본값 0) · message envelope는 v1 그대로.
 * - `planRunnableBatch` → `commitPreflightBatch`(원자적) → `startPreparedTask`. **ready→running 직접 전이 없음**(`B-11`).
 * - `prepared`/`running`/`cleaning`이 **자원·세션 예산을 점유**한다(`B-11`/`B-13`).
 * - **확인된 zero-survivor cleanup 뒤에만** 완료·차단이 가능하다(`B-13`).
 * - durable 토큰·경과 회계가 **재시작을 넘어 유지**되고 같은 turn은 한 번만 과금된다(`B-12`).
 * - 전달 실패는 **수령하지 않고** bounded 재시도만 남긴다(`C-12→B`).
 * - 만료 뒤 **safety-only reducer만** 통과한다(DECISIONS 2026-07-30 · `C-17` 경계 포함).
 * - 승인 경로 길이가 **코드 포인트**로 판정된다(`C-40` astral 경계).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_MESSAGE_SCHEMA_VERSION,
  APPROVAL_MANIFEST_SCHEMA_VERSION,
  LIMITS,
  ORCHESTRATOR_ID,
  OrchestrationError,
  RESOURCE_HOLDING_STATES,
  RUN_STATE_SCHEMA_VERSION,
  REQUIRED_BODY_HEADINGS,
  SAFETY_ONLY_REASONS,
  TASK_STATES,
  codePointLength,
  hasLoneSurrogate,
  holdsResources,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import type { AgentMessageType } from "./orchestrationTypes.js";
import { APPROVED_PATH_PATTERN, approvedOperationFor, validateApprovalManifest } from "./approvalManifest.js";
import { manifestDigest, runPaths, validateRunState } from "./orchestrationStore.js";
import { OrchestrationKernel, createOrchestrationRun, openOrchestrationRun } from "./orchestrationKernel.js";
import type { PreflightDecision, TaskSeed, WorkerProgressChannel } from "./orchestrationKernel.js";
import type { AutopilotMarker } from "./orchestrationTypes.js";

const RUN_ID = "m5c-run";
const MILESTONE = "m5c";

const workspaces: string[] = [];
function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "m5c-lifecycle-"));
  workspaces.push(ws);
  return ws;
}
process.on("exit", () => {
  for (const ws of workspaces) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과를 바꾸지 않는다 */
    }
  }
});

/** 결정론적 clock — 호출마다 1초 전진. 시작 시각을 주면 그 지점부터 센다. */
function clockFrom(startMs: number): () => Date {
  let n = 0;
  return () => new Date(startMs + 1000 * n++);
}

const T0 = Date.UTC(2026, 6, 30, 0, 0, 0);

function body(type: AgentMessageType): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

const EXECUTION_AUTHORITY = {
  codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
  // M5c 3A 2차 리비전(`B-10`) — typed `run_process`가 실행하는 **유일한** 고정 entrypoint.
  controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
  git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
  node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
  processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
};

const POLICY = {
  maxTaskAttempts: 2,
  maxDeliveryAttempts: 2,
  retryBackoffMs: 0,
  deliveryDeadlineMs: 600_000,
  maxNoProgressMs: 60_000,
  maxAttemptElapsedMs: 600_000,
  cleanupTermGraceMs: 500,
  cleanupKillGraceMs: 500,
};

function manifestFor(taskIds: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const ownershipByTask: Record<string, string[]> = {};
  for (const id of taskIds) ownershipByTask[id] = ["docs", "src"];
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask,
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: EXECUTION_AUTHORITY,
    autopilotPolicy: POLICY,
    operationAuthorityByTask: {},
    maxSessions: 8,
    maxTokens: 1000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

function seed(taskId: string, over: Record<string, unknown> = {}): TaskSeed {
  return {
    taskId,
    roleId: "tech-lead",
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: ["docs", "src"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
    ...over,
  };
}

function envelope(type: AgentMessageType, taskId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION,
    messageId: `msg-${taskId}-${type}`,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    taskId,
    parentTaskId: null,
    sender: "tech-lead",
    recipient: ORCHESTRATOR_ID,
    type,
    createdAt: "2026-07-30T00:00:00.000Z",
    dependsOn: [],
    artifactRefs: [],
    supersedes: null,
    ...over,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(e)}`);
    return (e as OrchestrationError).code;
  }
  throw new Error("거부될 것으로 기대했지만 통과했다");
}

let counter = 0;
const nextAction = (): string => `act.${++counter}`;
const nextAttempt = (): string => `att.${++counter}`;
const nextLease = (): string => `lease.${(++counter).toString(16).padStart(32, "0")}`;

/** batch 전체에 결정을 주되 `wanted`만 prepared로 올린다(나머지는 `deferred` — 상태 무변화). */
function preflight(k: OrchestrationKernel, wanted: string[]): void {
  const batch = k.planRunnableBatch();
  const decisions: PreflightDecision[] = batch.items.map((t) =>
    wanted.includes(t.taskId)
      ? { taskId: t.taskId, outcome: "prepared", attemptId: nextAttempt() }
      : { taskId: t.taskId, outcome: "deferred" },
  );
  k.commitPreflightBatch({ baseRevision: batch.revision, actionId: nextAction(), decisions });
}

/**
 * 진짜 시작 경로 전부를 지난다(ready → prepared → running). lease marker를 돌려준다.
 *
 * 3A 4차 리비전 A1 — 진행 채널은 **`startPreparedTask()`가 시작을 커밋한 그 순간에만** 발급되므로
 * (durable lease를 베껴 되만들 수 없다) 여기서 받아 lease 기준으로 보관한다.
 */
const CHANNELS = new Map<string, WorkerProgressChannel>();
function startNow(k: OrchestrationKernel, taskId: string): string {
  preflight(k, [taskId]);
  const leaseMarker = nextLease();
  const started = k.startPreparedTask({ taskId, actionId: nextAction(), leaseMarker });
  CHANNELS.set(leaseMarker, started.progress);
  return leaseMarker;
}

/**
 * 인정되는 진행 신호 1건. 3A 4차 리비전 A1로 **kernel 발급 worker 채널 + 단조 seq + worker `progress`
 * 이벤트**가 필수다(복사한 lease·구조 사본·heartbeat·재생은 no-progress 시계를 되돌리지 못한다).
 */
function progress(k: OrchestrationKernel, taskId: string, leaseMarker: string, seq = 1): void {
  const channel = CHANNELS.get(leaseMarker);
  assert.ok(channel, `${taskId}의 진행 채널이 없다`);
  k.recordProgress({ channel, actionId: nextAction(), event: { kind: "progress", seq, step: "step" } });
}

/** running → cleaning → cleanup 확인. 완료·차단 수락 자격을 만든다. */
function cleanTo(k: OrchestrationKernel, taskId: string, leaseMarker: string, marker: AutopilotMarker = "turn_completed"): void {
  progress(k, taskId, leaseMarker);
  k.recordTerminal({
    taskId,
    actionId: nextAction(),
    marker,
    pendingResult: marker === "turn_completed" ? { summary: "ok", outputs: [] } : null,
  });
  k.confirmCleanup({ taskId, actionId: nextAction(), leaseMarker });
}

function bootRoot(extra: string[] = [], over: Record<string, unknown> = {}): { ws: string; k: OrchestrationKernel } {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root", ...extra], over),
    clock: clockFrom(T0),
  });
  k.createRootTask(seed("root"));
  return { ws, k };
}

// ── ① schema 버전 분리와 v2 fail-closed ────────────────────────────────────

test("[M5c] schema 버전이 계약별로 분리되어 있다 — envelope는 1, state·manifest는 2", () => {
  assert.equal(AGENT_MESSAGE_SCHEMA_VERSION, "1");
  assert.equal(RUN_STATE_SCHEMA_VERSION, "2");
  assert.equal(APPROVAL_MANIFEST_SCHEMA_VERSION, "2");
  const { k } = bootRoot();
  assert.equal(k.getState().schemaVersion, "2", "state는 v2여야 한다");
  // envelope 계약은 **바뀌지 않았다** — v1 envelope가 그대로 수락된다.
  const started = startNow(k, "root");
  cleanTo(k, "root", started);
  const done = k.completeTaskWithArtifacts({
    envelope: envelope("result", "root"),
    body: body("result"),
    summary: "완료",
  });
  assert.equal(done.task.state, "completed");
  assert.equal(k.getState().messages.find((m) => m.type === "result")!.messageId, "msg-root-result");
});

test("[M5c] v1 manifest는 마이그레이션 없이 거부된다(manifest_pre_m5c_unsupported)", () => {
  const v2 = manifestFor(["root"]);
  // autopilotPolicy / operationAuthorityByTask 부재
  const noPolicy = { ...v2 };
  delete (noPolicy as Record<string, unknown>).autopilotPolicy;
  assert.equal(codeOf(() => validateApprovalManifest(noPolicy)), "manifest_pre_m5c_unsupported");
  const noOps = { ...v2 };
  delete (noOps as Record<string, unknown>).operationAuthorityByTask;
  assert.equal(codeOf(() => validateApprovalManifest(noOps)), "manifest_pre_m5c_unsupported");
  // executionAuthority v1(codex+git만)도 같은 코드로 닫힌다 — 기본값을 채우지 않는다.
  const v1Authority = manifestFor(["root"], {
    executionAuthority: { codex: EXECUTION_AUTHORITY.codex, git: EXECUTION_AUTHORITY.git },
  });
  assert.equal(codeOf(() => validateApprovalManifest(v1Authority)), "manifest_pre_m5c_unsupported");
});

test("[M5c] v1 state 바이트는 state_pre_m5c_unsupported로 닫힌다(회계·lifecycle 기본값 없음)", () => {
  const { k } = bootRoot();
  const state = k.getState() as unknown as Record<string, unknown>;
  const noAccounting = { ...state };
  delete noAccounting.accounting;
  assert.equal(codeOf(() => validateRunState(noAccounting)), "state_pre_m5c_unsupported");

  const v1Version = { ...state, schemaVersion: "1" };
  assert.equal(codeOf(() => validateRunState(v1Version)), "state_pre_m5c_unsupported");

  const noExecution = JSON.parse(JSON.stringify(state)) as { tasks: Array<Record<string, unknown>> };
  delete noExecution.tasks[0].execution;
  assert.equal(codeOf(() => validateRunState(noExecution)), "state_pre_m5c_unsupported");

  const noDelivery = JSON.parse(JSON.stringify(state)) as { messages: Array<Record<string, unknown>> };
  delete noDelivery.messages[0].delivery;
  assert.equal(codeOf(() => validateRunState(noDelivery)), "state_pre_m5c_unsupported");
});

test("[M5c] durable 회계는 그 승인에 묶여 있다 — 승인이 바뀌면 예산 이력을 이어 쓰지 않는다", () => {
  const { k } = bootRoot();
  const state = JSON.parse(JSON.stringify(k.getState())) as Record<string, unknown>;
  (state.accounting as Record<string, unknown>).approvalDigest = "0".repeat(64);
  assert.equal(codeOf(() => validateRunState(state)), "accounting_approval_mismatch");
  // 정상 값은 manifest canonical digest와 같다.
  assert.equal(k.getAccounting().approvalDigest, manifestDigest(k.getManifest()));
});

// ── ② preflight lifecycle (B-11) ───────────────────────────────────────────

test("[M5c] ready→running 직접 전이는 없다 — 두 legacy API가 preflight_required로 닫힌다", () => {
  const { k } = bootRoot();
  assert.equal(codeOf(() => k.startTask("root")), "preflight_required");
  assert.equal(codeOf(() => k.startScheduledBatch()), "preflight_required");
  // 거부는 전이 0이다(디스크·revision 무변화).
  const before = k.getState().revision;
  assert.equal(k.getTask("root")!.state, "ready");
  assert.equal(k.getState().revision, before);
});

test("[M5c] prepared는 자원·세션 예산을 점유한다 — 프로세스는 아직 없다", () => {
  assert.deepEqual([...RESOURCE_HOLDING_STATES], ["prepared", "running", "cleaning"]);
  for (const s of TASK_STATES) {
    assert.equal(holdsResources(s), (["prepared", "running", "cleaning"] as string[]).includes(s), `holdsResources(${s})`);
  }
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    // maxSessions 1 + 같은 배타 자원 → 두 번째는 애초에 scheduler가 고르지 않는다.
    manifest: manifestFor(["a-task", "b-task"], { maxSessions: 1 }),
    clock: clockFrom(T0),
  });
  k.createRootTask(seed("a-task", { resourceClasses: ["repo"] }));
  k.createRootTask(seed("b-task", { resourceClasses: ["repo"] }));
  preflight(k, ["a-task"]);
  assert.equal(k.getTask("a-task")!.state, "prepared");
  assert.equal(k.getTask("b-task")!.state, "ready", "deferred 결정은 상태를 건드리지 않는다");
  // prepared가 점유하므로 다음 batch는 비어 있다(이전 판은 running만 셌다 → 여기서 b-task를 골랐다).
  assert.deepEqual(k.planRunnableBatch().items.map((t) => t.taskId), []);
});

test("[M5c] preflight 결정 집합은 batch와 정확히 같아야 한다(누락·추가·중복·낡은 revision 거부)", () => {
  const { k } = bootRoot(["second"]);
  k.createRootTask(seed("second"));
  const batch = k.planRunnableBatch();
  assert.deepEqual(batch.items.map((t) => t.taskId), ["root", "second"]);

  // 누락
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: [{ taskId: "root", outcome: "deferred" }],
      }),
    ),
    "preflight_batch_mismatch",
  );
  // 추가(batch 밖 task)
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: [
          { taskId: "root", outcome: "deferred" },
          { taskId: "second", outcome: "deferred" },
          { taskId: "ghost", outcome: "deferred" },
        ],
      }),
    ),
    "preflight_batch_mismatch",
  );
  // 중복
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: [
          { taskId: "root", outcome: "deferred" },
          { taskId: "root", outcome: "deferred" },
        ],
      }),
    ),
    "invalid_preflight",
  );
  // 낡은 revision
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision - 1,
        actionId: nextAction(),
        decisions: [
          { taskId: "root", outcome: "deferred" },
          { taskId: "second", outcome: "deferred" },
        ],
      }),
    ),
    "preflight_stale_batch",
  );
  // 전부 전이 0
  assert.equal(k.getTask("root")!.state, "ready");
  assert.equal(k.getTask("second")!.state, "ready");
});

test("[M5c] preflight는 원자적이다 — 한 건이 거부되면 batch 전체가 전이 0이다", () => {
  const { k } = bootRoot(["second"]);
  k.createRootTask(seed("second"));
  const batch = k.planRunnableBatch();
  // 두 번째 결정의 pauseReason이 닫힌 집합 밖 → 커밋 시도 자체가 실패한다.
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: [
          { taskId: "root", outcome: "prepared", attemptId: nextAttempt() },
          { taskId: "second", outcome: "paused", pauseReason: "not_a_reason" as never },
        ],
      }),
    ),
    "invalid_enum",
  );
  assert.equal(k.getTask("root")!.state, "ready", "앞선 task도 prepared가 되지 않아야 한다");
  assert.equal(k.getTask("second")!.state, "ready");
});

test("[M5c] prepared 이후 봉인된 preflight가 바뀌면 시작하지 않는다(preflight_drift)", () => {
  const { k } = bootRoot();
  preflight(k, ["root"]);
  const stored = k.getTask("root")!.execution.preflightDigest;
  assert.ok(stored !== null && /^[0-9a-f]{64}$/.test(stored));
  // 같은 preflight면 시작된다.
  k.startPreparedTask({ taskId: "root", actionId: nextAction(), leaseMarker: nextLease() });
  assert.equal(k.getTask("root")!.state, "running");
  // wall deadline은 kernel이 계산한다(호출자 값이 아니다).
  const exec = k.getTask("root")!.execution;
  assert.ok(exec.wallDeadlineAt !== null && exec.wallDeadlineAt <= k.getAccounting().budgetDeadlineAt);
  assert.equal(exec.cleanupStatus, "required", "시작 순간부터 정리가 필요하다고 기록된다");
});

test("[M5c] startPreparedTask는 prepared만 받는다(ready·running 거부)", () => {
  const { k } = bootRoot();
  assert.equal(
    codeOf(() => k.startPreparedTask({ taskId: "root", actionId: nextAction(), leaseMarker: nextLease() })),
    "preflight_required",
  );
  const lease = startNow(k, "root");
  assert.equal(
    codeOf(() => k.startPreparedTask({ taskId: "root", actionId: nextAction(), leaseMarker: lease })),
    "preflight_required",
  );
});

// ── ③ cleanup 뒤에만 완료 (B-13) ───────────────────────────────────────────

test("[M5c] running task는 완료·차단될 수 없다 — recordTerminal로 cleaning에 먼저 들어간다", () => {
  const { k } = bootRoot();
  startNow(k, "root");
  assert.equal(
    codeOf(() => k.completeTaskWithArtifacts({ envelope: envelope("result", "root"), body: body("result"), summary: "s" })),
    "invalid_transition",
  );
  assert.equal(
    codeOf(() => k.submitBlocker({ envelope: envelope("blocker", "root"), body: body("blocker"), summary: "s" })),
    "invalid_transition",
  );
  assert.equal(k.getTask("root")!.state, "running");
});

test("[M5c] cleanup 미확인 상태에서는 완료가 거부된다(cleanup_unconfirmed) — 자원도 계속 붙잡는다", () => {
  const { k } = bootRoot();
  const lease = startNow(k, "root");
  progress(k, "root", lease);
  k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "turn_completed", pendingResult: { summary: "ok", outputs: [] } });
  assert.equal(k.getTask("root")!.state, "cleaning");
  assert.ok(holdsResources(k.getTask("root")!.state), "cleaning은 자원을 붙잡는다");
  assert.equal(
    codeOf(() => k.completeTaskWithArtifacts({ envelope: envelope("result", "root"), body: body("result"), summary: "s" })),
    "cleanup_unconfirmed",
  );
  // 정리 실패는 cleaning에 남긴다(상태·자원 유지).
  k.failCleanup({ taskId: "root", actionId: nextAction() });
  assert.equal(k.getTask("root")!.state, "cleaning");
  assert.equal(
    codeOf(() => k.completeTaskWithArtifacts({ envelope: envelope("result", "root"), body: body("result"), summary: "s" })),
    "cleanup_unconfirmed",
  );
  // 시도 상한을 넘으면 안정 격리(`failed`)이며 여전히 완료할 수 없다.
  k.failCleanup({ taskId: "root", actionId: nextAction() });
  assert.equal(k.getTask("root")!.execution.cleanupStatus, "failed");
  assert.equal(k.getTask("root")!.state, "cleaning");
  // 확인되면 비로소 완료된다.
  k.confirmCleanup({ taskId: "root", actionId: nextAction(), leaseMarker: lease });
  const done = k.completeTaskWithArtifacts({ envelope: envelope("result", "root"), body: body("result"), summary: "s" });
  assert.equal(done.task.state, "completed");
});

test("[M5c] 정리 영수증은 그 attempt의 lease와 일치해야 한다(cleanup_lease_mismatch)", () => {
  const { k } = bootRoot();
  const lease = startNow(k, "root");
  progress(k, "root", lease);
  k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "process_failed" });
  assert.equal(
    codeOf(() => k.confirmCleanup({ taskId: "root", actionId: nextAction(), leaseMarker: nextLease() })),
    "cleanup_lease_mismatch",
  );
  assert.equal(k.getTask("root")!.execution.cleanupStatus, "required");
});

test("[M5c] 종료는 attempt당 한 번만 기록된다 · 실패 marker는 결과를 봉인하지 않는다", () => {
  const { k } = bootRoot();
  startNow(k, "root");
  assert.equal(
    codeOf(() => k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "turn_completed" })),
    "invalid_terminal",
  );
  assert.equal(
    codeOf(() =>
      k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "silent_session", pendingResult: { summary: "x", outputs: [] } }),
    ),
    "invalid_terminal",
  );
  k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "silent_session" });
  assert.equal(
    codeOf(() => k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "silent_session" })),
    "invalid_transition",
  );
});

test("[M5c] settleCleanedAttempt: 여유가 있으면 retry_wait, 없으면 blocked, 취소면 cancelled", () => {
  // ⓐ 재시도 여유 있음(policy.maxTaskAttempts = 2)
  const a = bootRoot().k;
  const lease1 = startNow(a, "root");
  cleanTo(a, "root", lease1, "process_failed");
  a.settleCleanedAttempt({ taskId: "root", actionId: nextAction() });
  assert.equal(a.getTask("root")!.state, "retry_wait");
  assert.ok(!holdsResources("retry_wait"), "retry_wait은 자원을 놓는다");

  // 예약 시각이 됐으므로 같은 scheduler가 다시 고른다(두 번째 scheduler 없음).
  assert.deepEqual(a.planRunnableBatch().items.map((t) => t.taskId), ["root"]);
  const lease2 = startNow(a, "root");
  assert.equal(a.getTask("root")!.execution.attemptNo, 2);
  cleanTo(a, "root", lease2, "process_failed");
  a.settleCleanedAttempt({ taskId: "root", actionId: nextAction() });
  assert.equal(a.getTask("root")!.state, "blocked", "attempt 상한을 다 쓰면 blocked다");
  assert.match(a.getTask("root")!.blockerSummary!, /^\[autopilot\] process_failed$/);

  // ⓑ 취소가 요청됐으면 cancelled
  const b = bootRoot().k;
  const lease3 = startNow(b, "root");
  b.requestCancel({ taskId: "root", actionId: nextAction() });
  assert.equal(b.getTask("root")!.state, "cleaning", "취소 요청은 running을 cleaning으로 내린다");
  b.confirmCleanup({ taskId: "root", actionId: nextAction(), leaseMarker: lease3 });
  b.settleCleanedAttempt({ taskId: "root", actionId: nextAction() });
  assert.equal(b.getTask("root")!.state, "cancelled");
});

test("[M5c] cleanup 미확인 상태에서는 pause도 거부된다(자원을 놓기 전에 프로세스 0을 안다)", () => {
  const { k } = bootRoot();
  const lease = startNow(k, "root");
  k.recordTerminal({ taskId: "root", actionId: nextAction(), marker: "no_progress_timeout" });
  assert.equal(
    codeOf(() => k.pauseTask({ taskId: "root", actionId: nextAction(), pauseReason: "interrupted" })),
    "cleanup_unconfirmed",
  );
  k.confirmCleanup({ taskId: "root", actionId: nextAction(), leaseMarker: lease });
  const paused = k.pauseTask({ taskId: "root", actionId: nextAction(), pauseReason: "interrupted" });
  assert.equal(paused.state, "paused");
  assert.equal(paused.execution.pauseReason, "interrupted");
  assert.equal(paused.execution.processLeaseMarker, null, "pause는 lease를 놓는다");
  // 재개는 같은 승인 아래에서만이고 ready로 돌아간다.
  const resumed = k.resumeTask({ taskId: "root", actionId: nextAction() });
  assert.equal(resumed.state, "ready");
});

// ── ④ durable 회계 (B-12) ──────────────────────────────────────────────────

test("[M5c] 토큰·경과 회계는 durable이고 재시작이 리셋하지 않는다", () => {
  const { ws, k } = bootRoot();
  const lease = startNow(k, "root");
  k.chargeTurnUsage({ taskId: "root", turnId: "turn.a", actionId: nextAction(), inputTokens: 100, outputTokens: 40, elapsedMs: 5_000 });
  assert.equal(k.getAccounting().tokensUsed, 140);
  assert.equal(k.remainingBudget("2026-07-30T00:10:00.000Z").tokens, 860);

  // **재시작**: 같은 run을 다시 열어도 회계가 그대로다(이전 판은 controller 메모리에만 있었다).
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 60_000) });
  assert.equal(reopened.getAccounting().tokensUsed, 140);
  assert.deepEqual(reopened.getAccounting().chargedTurnIds, ["turn.a"]);
  assert.equal(reopened.getAccounting().budgetStartedAt, k.getAccounting().budgetStartedAt, "예산 창을 새로 만들지 않는다");
  assert.equal(reopened.getAccounting().budgetDeadlineAt, k.getAccounting().budgetDeadlineAt);

  // 같은 turn을 두 번 과금할 수 없다(멱등).
  assert.equal(
    codeOf(() =>
      reopened.chargeTurnUsage({ taskId: "root", turnId: "turn.a", actionId: nextAction(), inputTokens: 1, outputTokens: 1, elapsedMs: 1 }),
    ),
    "turn_already_charged",
  );
  assert.equal(reopened.getAccounting().tokensUsed, 140);
  // 다른 turn은 누적된다.
  reopened.chargeTurnUsage({ taskId: "root", turnId: "turn.b", actionId: nextAction(), inputTokens: 10, outputTokens: 0, elapsedMs: 9_000 });
  assert.equal(reopened.getAccounting().tokensUsed, 150);
  assert.equal(reopened.getAccounting().elapsedMsUsed, 9_000, "경과는 monotonic이다");
  assert.deepEqual(reopened.getAccounting().chargedTurnIds, ["turn.a", "turn.b"]);
  assert.ok(lease.startsWith("lease."));
});

test("[M5c] 회계는 손으로 되돌릴 수 없다 — state↔event binding이 거부한다", () => {
  const { ws, k } = bootRoot();
  startNow(k, "root");
  k.chargeTurnUsage({ taskId: "root", turnId: "turn.a", actionId: nextAction(), inputTokens: 500, outputTokens: 0, elapsedMs: 1_000 });
  const paths = runPaths(ws, RUN_ID);
  const raw = JSON.parse(readFileSync(paths.stateFile, "utf8")) as Record<string, unknown>;
  (raw.accounting as Record<string, unknown>).tokensUsed = 0;
  writeFileSync(paths.stateFile, JSON.stringify(raw, null, 2), "utf8");
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "state_event_binding_mismatch");
});

test("[M5c] 예산 창이 비면 run을 만들지 않는다(budget_window_empty)", () => {
  const ws = makeWorkspace();
  assert.equal(
    codeOf(() =>
      createOrchestrationRun({
        workspaceRoot: ws,
        runId: RUN_ID,
        milestoneId: MILESTONE,
        // 만료가 clock보다 이르다 → 승인 자체가 만료다
        manifest: manifestFor(["root"], { expiresAt: "2026-01-01T00:00:00.000Z" }),
        clock: clockFrom(T0),
      }),
    ),
    "manifest_expired",
  );
});

// ── ⑤ 전달 재시도 (C-12→B) ────────────────────────────────────────────────

/**
 * 전달 테스트용 sibling 두 개(같은 parent). 중앙이 인정하는 관계는 **같은 parent** 또는 **직접 의존**뿐이고,
 * 의존은 스케줄을 막으므로 sibling으로 만든다(기존 spawn API만 쓴다 — 새 경로를 만들지 않는다).
 */
function bootSiblings(): OrchestrationKernel {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["parent"]),
    clock: clockFrom(T0),
  });
  k.createRootTask(seed("parent"));
  startNow(k, "parent");
  for (const child of ["sender", "receiver"]) {
    k.requestSpawn({
      envelope: envelope("spawn_request", "parent", { messageId: `msg-spawn-${child}` }),
      body: body("spawn_request"),
      child: seed(child, { assignmentMessageId: `asg-${child}` }),
    });
  }
  startNow(k, "sender");
  startNow(k, "receiver");
  return k;
}

test("[M5c] 전달 실패는 수령하지 않고 bounded 재시도만 남긴다", () => {
  const k = bootSiblings();
  k.submitStatusUpdate({
    envelope: envelope("status_update", "sender", { messageId: "msg-note", parentTaskId: "parent" }),
    body: body("status_update"),
    summary: "진행",
    deliverTo: "receiver",
  });
  const mid = "msg-note";

  // 시도 없이 수령하려 하면 거부다(실패한 전달이 성공으로 적히는 경로가 없다).
  assert.equal(codeOf(() => k.acknowledgeDelivery({ taskId: "receiver", messageId: mid })), "delivery_attempt_missing");

  // 1차 시도 → 실패. **ack되지 않고** 다음 시도만 예약된다.
  k.beginDeliveryAttempt({ taskId: "receiver", messageId: mid, actionId: nextAction(), attemptId: nextAttempt() });
  let entry = k.failDeliveryAttempt({ taskId: "receiver", messageId: mid, actionId: nextAction(), marker: "turn_failed" });
  assert.equal(entry.acknowledgedAt, null, "실패한 전달은 수령되지 않는다");
  assert.equal(entry.delivery.attempts, 1);
  assert.equal(entry.delivery.lastMarker, "turn_failed");
  assert.ok(entry.delivery.nextAttemptAt !== null, "재시도가 예약된다");

  // 2차 시도 → 실패. 상한(2)을 다 썼으므로 marker가 attempts_exhausted이고 재시도 예약이 없다.
  k.beginDeliveryAttempt({ taskId: "receiver", messageId: mid, actionId: nextAction(), attemptId: nextAttempt() });
  entry = k.failDeliveryAttempt({ taskId: "receiver", messageId: mid, actionId: nextAction(), marker: "send_failed" });
  assert.equal(entry.delivery.attempts, 2);
  assert.equal(entry.delivery.lastMarker, "attempts_exhausted");
  assert.equal(entry.delivery.nextAttemptAt, null);
  assert.equal(entry.acknowledgedAt, null);

  // 상한을 넘는 세 번째 시도는 시작되지 않는다.
  assert.equal(
    codeOf(() => k.beginDeliveryAttempt({ taskId: "receiver", messageId: mid, actionId: nextAction(), attemptId: nextAttempt() })),
    "delivery_attempts_exhausted",
  );
  // 실패로 끝난 전달은 여전히 pending이다(조용히 사라지지 않는다).
  assert.equal(k.listPendingInbox("receiver").length, 1);
  assert.equal(codeOf(() => k.failDeliveryAttempt({ taskId: "receiver", messageId: mid, actionId: nextAction(), marker: "delivered" })), "invalid_delivery_marker");
});

test("[M5c] 성공한 전달만 수령되고 durable marker가 delivered로 남는다", () => {
  const k = bootSiblings();
  k.submitStatusUpdate({
    envelope: envelope("status_update", "sender", { messageId: "msg-note", parentTaskId: "parent" }),
    body: body("status_update"),
    summary: "진행",
    deliverTo: "receiver",
  });
  k.beginDeliveryAttempt({ taskId: "receiver", messageId: "msg-note", actionId: nextAction(), attemptId: nextAttempt() });
  const acked = k.acknowledgeDelivery({ taskId: "receiver", messageId: "msg-note", actionId: nextAction() });
  assert.ok(acked.acknowledgedAt !== null);
  assert.equal(acked.delivery.lastMarker, "delivered");
  assert.equal(k.listPendingInbox("receiver").length, 0);
});

// ── ⑥ 만료 후 safety-only reducer (DECISIONS 2026-07-30 · C-17) ────────────

test("[M5c] 만료는 경계 포함이다(C-17) — 정확히 expiresAt 밀리초에 전진이 거부된다", () => {
  const expiresAt = "2026-07-30T00:10:00.000Z";
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root"], { expiresAt }),
    clock: clockFrom(T0),
  });
  k.createRootTask(seed("root"));
  // 만료 **직전** 1ms: 전진 가능.
  const atEdge = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: () => new Date(Date.parse(expiresAt) - 1) });
  const batch = atEdge.planRunnableBatch();
  atEdge.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextAction(),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "deferred" as const })),
  });
  // 만료 **그 밀리초**: 거부(이전 판의 `>`는 여기를 통과시켰다).
  const at = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: () => new Date(Date.parse(expiresAt)) });
  const b2 = at.planRunnableBatch();
  assert.equal(
    codeOf(() =>
      at.commitPreflightBatch({
        baseRevision: b2.revision,
        actionId: nextAction(),
        decisions: b2.items.map((t) => ({ taskId: t.taskId, outcome: "deferred" as const })),
      }),
    ),
    "manifest_expired",
  );
});

test("[M5c] 만료 후: 전진은 닫히고 safety-only reducer만 통과한다(회계·취소·정리·pause)", () => {
  const expiresAt = "2026-07-30T00:10:00.000Z";
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root"], { expiresAt }),
    clock: clockFrom(T0),
  });
  k.createRootTask(seed("root"));
  const lease = startNow(k, "root");

  // 만료 이후 시각으로 같은 run을 연다(프로세스가 살아 있는 채로 승인이 만료된 상황).
  const after = Date.parse(expiresAt) + 60_000;
  const expired = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(after) });

  // ── 전진은 전부 거부된다 ──
  // 진행 채널은 이 attempt를 시작한 kernel 인스턴스가 발급한 것이고 durable state를 다시 읽으므로,
  // 재시작한 `expired` 인스턴스에 넘겨도 만료 게이트가 먼저 닫는다(3A 4차 리비전 A1).
  assert.equal(
    codeOf(() =>
      expired.recordProgress({
        channel: CHANNELS.get(lease),
        actionId: nextAction(),
        event: { kind: "progress", seq: 1, step: "step" },
      }),
    ),
    "manifest_expired",
  );
  assert.equal(codeOf(() => expired.resumeTask({ taskId: "root", actionId: nextAction() })), "manifest_expired");
  assert.equal(
    codeOf(() => expired.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" })),
    "manifest_expired",
  );

  // ── safety-only reducer는 통과한다 ──
  // ① 이미 태운 토큰의 회계
  expired.chargeTurnUsage({ taskId: "root", turnId: "turn.x", actionId: nextAction(), inputTokens: 7, outputTokens: 3, elapsedMs: 100 });
  assert.equal(expired.getAccounting().tokensUsed, 10);
  // ② 취소 요청(같은 커밋에서 cleaning으로)
  expired.requestCancel({ taskId: "root", actionId: nextAction() });
  assert.equal(expired.getTask("root")!.state, "cleaning");
  // ③ 정리 확인
  expired.confirmCleanup({ taskId: "root", actionId: nextAction(), leaseMarker: lease });
  assert.equal(expired.getTask("root")!.execution.cleanupStatus, "confirmed");
  // ④ fail-closed 착지
  const settled = expired.settleCleanedAttempt({ taskId: "root", actionId: nextAction() });
  assert.equal(settled.state, "cancelled");

  // ── 만료 뒤에 **성공·발행·수령**은 하나도 만들어지지 않는다 ──
  assert.equal(expired.getState().artifacts.length, 0);
  assert.ok(expired.getState().tasks.every((t) => t.state !== "completed"));
});

test("[M5c] safety-only 전이 사유 목록에는 started·result_accepted가 없다", () => {
  const reasons: readonly string[] = SAFETY_ONLY_REASONS;
  assert.ok(!reasons.includes("started"), "safety-only가 작업을 시작할 수 없어야 한다");
  assert.ok(!reasons.includes("result_accepted"), "safety-only가 완료할 수 없어야 한다");
  assert.ok(!reasons.includes("resumed"));
  assert.ok(reasons.includes("cleanup_confirmed") && reasons.includes("paused") && reasons.includes("cancelled"));
});

// ── ⑦ C-40: 승인 경로 길이는 코드 포인트로 판정한다 ────────────────────────

test("[M5c] C-40: 승인 경로 길이가 schema(draft-07 maxLength)와 같은 코드 포인트 의미다", () => {
  const re = new RegExp(APPROVED_PATH_PATTERN);
  // 8차 리뷰가 제시한 정확한 사례: `/` + 😀 256개 = 코드 포인트 257, UTF-16 unit 513.
  const astral256 = `/${"😀".repeat(256)}`;
  assert.equal(codePointLength(astral256), 257);
  assert.equal(astral256.length, 513, "UTF-16 unit 수는 상한을 넘는다(이전 판이 여기서 거부했다)");
  assert.ok(re.test(astral256), "공유 패턴은 통과시킨다");
  const okManifest = manifestFor(["root"], {
    executionAuthority: { ...EXECUTION_AUTHORITY, node: { path: astral256, sha256: "e".repeat(64) } },
  });
  assert.equal(validateApprovalManifest(okManifest).executionAuthority.node.path, astral256, "schema와 runtime이 같이 수락한다");

  // 정확히 512 코드 포인트: 수락.
  const exactly512 = `/${"😀".repeat(511)}`;
  assert.equal(codePointLength(exactly512), 512);
  const at512 = manifestFor(["root"], {
    executionAuthority: { ...EXECUTION_AUTHORITY, node: { path: exactly512, sha256: "e".repeat(64) } },
  });
  assert.equal(validateApprovalManifest(at512).executionAuthority.node.path, exactly512);

  // 513 코드 포인트: 거부.
  const over513 = `/${"😀".repeat(512)}`;
  assert.equal(codePointLength(over513), 513);
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], { executionAuthority: { ...EXECUTION_AUTHORITY, node: { path: over513, sha256: "e".repeat(64) } } }),
      ),
    ),
    "invalid_manifest",
  );
  // workspace 경로도 같은 의미다.
  assert.equal(codePointLength("a"), 1);
  assert.equal(codePointLength("😀"), 1);
});

// ── ⑦b 3A 리비전 A4: 승인·durable 경로는 UTF-8 왕복이 보존돼야 한다 ─────────

test("[M5c] 공유 정규화 계약이 고립 UTF-16 surrogate 경로를 거부한다(astral·U+FFFD는 통과)", () => {
  const HIGH = "\uD800";
  const LOW = "\uDC00";

  // ⓐ 공유 정규화 함수가 정본이다 — 승인·계획·산출물 경로가 전부 이 함수를 지난다.
  for (const lone of [HIGH, LOW, `docs/${HIGH}.md`, `docs/${LOW}.md`, `docs/a${HIGH}b/c.md`, `${LOW}${HIGH}`, `docs/\uD83D${LOW}${LOW}.md`]) {
    assert.equal(hasLoneSurrogate(lone), true, JSON.stringify(lone));
    assert.equal(codeOf(() => normalizeWorkspacePath(lone, "경로")), "path_not_utf8", JSON.stringify(lone));
  }
  // ⓑ 유효한 astral pair와 **리터럴 U+FFFD**는 그대로 통과한다(왕복이 깨지지 않는다).
  for (const ok of ["docs/😀.md", "docs/�.md", "😀", "docs/��/a.md"]) {
    assert.equal(hasLoneSurrogate(ok), false, JSON.stringify(ok));
    assert.equal(normalizeWorkspacePath(ok, "경로"), ok);
    // 왕복 검증: JS 문자열 → UTF-8 → JS 문자열이 정확히 같다.
    assert.equal(Buffer.from(ok, "utf8").toString("utf8"), ok);
  }
  // 반대로 고립 surrogate는 UTF-8 왕복에서 U+FFFD로 바뀐다 = 다른 경로가 된다(이 규칙의 이유).
  assert.notEqual(Buffer.from(`docs/${HIGH}.md`, "utf8").toString("utf8"), `docs/${HIGH}.md`);

  // ⓒ manifest의 모든 경로 자리(writableRoots · ownership · 승인 operation 경로)가 같은 규칙이다.
  assert.equal(codeOf(() => validateApprovalManifest(manifestFor(["root"], { writableRoots: [`docs${HIGH}`, "src"] }))), "path_not_utf8");
  assert.equal(
    codeOf(() => validateApprovalManifest(manifestFor(["root"], { ownershipByTask: { root: [`src/${LOW}`] } }))),
    "path_not_utf8",
  );
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], {
          operationAuthorityByTask: { root: [{ authorityId: "w", kind: "write_file", path: `src/${HIGH}.txt`, maxBytes: 8 }] },
        }),
      ),
    ),
    "path_not_utf8",
  );
  // ⓓ 승인된 실행 파일 절대 경로와 argv도 정확한 바이트여야 한다.
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], { executionAuthority: { ...EXECUTION_AUTHORITY, node: { path: `/opt/${HIGH}/node`, sha256: "e".repeat(64) } } }),
      ),
    ),
    "invalid_manifest",
  );
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], {
          operationAuthorityByTask: {
            root: [
              { authorityId: "p", kind: "run_process", action: "validate-plan", data: { planPath: `src/${LOW}.json` }, timeoutMs: 1_000 },
            ],
          },
        }),
      ),
    ),
    "operation_data_not_approved",
  );
  // ⓔ durable task ownership(kernel 경유)도 같은 규칙이다 — 승인 표만이 아니라 state 진입점도 막는다.
  const ws = makeWorkspace();
  const k = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root"]),
    clock: clockFrom(T0),
  });
  assert.equal(codeOf(() => k.createRootTask(seed("root", { ownership: [`docs/${HIGH}`] }))), "path_not_utf8");
  assert.equal(k.getTask("root"), null, "거부된 task가 durable에 남았다");
});

// ── ⑧ typed operation 권위는 deny-by-default다 (B-10 계약면) ───────────────

test("[M5c] operation 권위는 승인에 있을 때만 존재한다(부재 = hard deny)", () => {
  const m = validateApprovalManifest(
    manifestFor(["root"], {
      operationAuthorityByTask: {
        root: [
          { authorityId: "w1", kind: "write_file", path: "src/out.txt", maxBytes: 1024 },
          { authorityId: "p1", kind: "run_process", action: "validate-plan", data: { planPath: "src/plan.json" }, timeoutMs: 5_000 },
        ],
      },
    }),
  );
  assert.equal(approvedOperationFor(m, "root", "w1")!.kind, "write_file");
  assert.equal(approvedOperationFor(m, "root", "p1")!.kind, "run_process");
  assert.equal(approvedOperationFor(m, "root", "nope"), null, "미상 authorityId는 null(= deny)이다");
  assert.equal(approvedOperationFor(m, "other", "w1"), null, "다른 task의 권위를 빌릴 수 없다");
  assert.equal(approvedOperationFor(m, "root", 1 as never), null);
});

test("[M5c] typed operation 권위는 승인 범위·승인된 실행 파일 밖을 표현할 수 없다", () => {
  const bad = (ops: unknown): string =>
    codeOf(() => validateApprovalManifest(manifestFor(["root"], { operationAuthorityByTask: { root: ops } })));

  // writableRoots 밖
  assert.equal(bad([{ authorityId: "w", kind: "write_file", path: "etc/passwd", maxBytes: 8 }]), "operation_outside_writable_root");
  // ownership 밖(승인 표에 있는 task는 그 범위도 본다)
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], {
          ownershipByTask: { root: ["src"] },
          operationAuthorityByTask: { root: [{ authorityId: "w", kind: "write_file", path: "docs/x.md", maxBytes: 8 }] },
        }),
      ),
    ),
    "operation_not_owned",
  );
  // **실행 대상을 고르는 필드 자체가 없다**(3A 2차 리비전 `B-10`): git·codex·shell·임의 경로는
  // 물론이고 승인된 node 경로조차 승인 문서에 적을 수 없다 — 실행 대상은 executionAuthority 고정이다.
  assert.equal(
    bad([{ authorityId: "p", kind: "run_process", executable: EXECUTION_AUTHORITY.git.path, args: ["push"], timeoutMs: 1_000 }]),
    "invalid_manifest",
  );
  assert.equal(
    bad([{ authorityId: "p", kind: "run_process", executable: "/bin/sh", args: ["-c", "x"], timeoutMs: 1_000 }]),
    "invalid_manifest",
  );
  // shell 문자열·미상 key는 표현할 수 없다(닫힌 key 집합)
  assert.equal(
    bad([
      { authorityId: "p", kind: "run_process", action: "validate-plan", data: { planPath: "src/p.json" }, timeoutMs: 1_000, shell: true },
    ]),
    "invalid_manifest",
  );
  // **3A 3차 리비전 B2 — action별 입력 계약**: `data`는 이제 임의 문자열 배열이 아니라 정확한 key 집합의
  // 객체다. 배열·여분 key·누락·비경로 값은 전부 승인될 수 없고, 코드 권위 인자(`--eval`)는 애초에
  // 담을 자리가 없다(그것을 `planPath`에 넣어도 정규화된 workspace 경로가 아니라 거부된다).
  const withData = (data: unknown): string =>
    bad([{ authorityId: "p", kind: "run_process", action: "validate-plan", data, timeoutMs: 1_000 }]);
  assert.equal(withData(["src/p.json"]), "invalid_manifest", "배열 data가 아직 통과한다");
  assert.equal(withData({}), "invalid_manifest", "필수 planPath 누락이 통과한다");
  assert.equal(withData({ planPath: "src/p.json", extra: "x" }), "invalid_manifest", "여분 key가 통과한다");
  // `--eval`은 이제 **경로 값**으로만 표현될 수 있고, 그러면 승인 범위 판정에서 걸린다(argv 자리가 없다).
  assert.equal(withData({ planPath: "--eval" }), "operation_outside_writable_root");
  assert.equal(withData({ planPath: "/etc/passwd" }), "operation_data_not_approved", "절대 경로가 통과한다");
  assert.equal(withData({ planPath: "../escape.json" }), "operation_data_not_approved", "traversal이 통과한다");
  assert.equal(withData({ planPath: "src/./p.json" }), "operation_data_not_approved", "미정규화 경로가 통과한다");
  assert.equal(withData({ planPath: "etc/p.json" }), "operation_outside_writable_root", "승인 범위 밖 읽기가 통과한다");
  // ownership을 좁히면 읽기 경로도 그 범위 안이어야 한다(읽기를 승인된 쓰기 범위 안쪽으로 좁힌다).
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], {
          ownershipByTask: { root: ["src"] },
          operationAuthorityByTask: {
            root: [{ authorityId: "p", kind: "run_process", action: "validate-plan", data: { planPath: "docs/p.json" }, timeoutMs: 1_000 }],
          },
        }),
      ),
    ),
    "operation_not_owned",
  );
  // 정확히 하나의 정규화된 소유 경로만 승인되고, 입양된 값은 그 경로 그대로다(공허하지 않다는 증거).
  const okOps = validateApprovalManifest(
    manifestFor(["root"], {
      operationAuthorityByTask: {
        root: [{ authorityId: "p", kind: "run_process", action: "validate-plan", data: { planPath: "src/p.json" }, timeoutMs: 1_000 }],
      },
    }),
  ).operationAuthorityByTask.root[0];
  assert.deepEqual(okOps, {
    authorityId: "p",
    kind: "run_process",
    action: "validate-plan",
    data: { planPath: "src/p.json" },
    timeoutMs: 1_000,
  });
  assert.equal(bad([{ authorityId: "x", kind: "network_fetch", url: "https://example.com" }]), "invalid_manifest");
  // 바이트 상한을 넘는 승인은 없다
  assert.equal(
    bad([{ authorityId: "w", kind: "write_file", path: "src/a.txt", maxBytes: LIMITS.maxWriteBytes + 1 }]),
    "invalid_manifest",
  );
});
