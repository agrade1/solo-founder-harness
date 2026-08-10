/**
 * V3 M5c — **`harness autopilot` CLI** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/commands/autopilot.test.ts`
 * 네트워크·LLM·provider·**프로세스 0**. 임시 workspace에서만 돈다(무과금).
 *
 * 이 파일이 고정하는 계약:
 * - **승인 manifest가 run을 gate한다** — milestone이 다르면 durable state를 **한 바이트도** 바꾸지 않는다.
 * - **hang 대신 pause** — 무인으로 승인할 수 없는 turn(typed operation 요구 · worker 실패 · 계획 무효)은
 *   `recordTerminal → confirmCleanup → paused`로 착지하고 복구 가능하다. `running`에 남는 경로가 없다.
 * - **deadline 집행** — attempt wall-clock과 no-progress를 `>=` 경계로 강제하고, run 수준 만료·예산은
 *   **durable** 값에서 판정한다(`B-12`: 재시작해도 예산이 새로 생기지 않는다).
 * - **진행 관측** — 최종 결과만 있는 조용한 세션이 없다(progress 이벤트가 durable하게 남는다).
 * - **취소 정리** — 취소는 `cleaning → confirmCleanup → cancelled`로 닫히고 lease를 놓는다. spawn 0이므로
 *   생존 자손도 0이다.
 * - **소비하지 않은 게이트** — typed operation dispatch 0(`B-10`/`B-16`) · 전달 attempt 0(`B-17`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "../exec/orchestrationTypes.js";
import type { OrchestrationTask } from "../exec/orchestrationTypes.js";
import { createOrchestrationRun, openOrchestrationRun } from "../exec/orchestrationKernel.js";
import type { OrchestrationKernel, TaskSeed } from "../exec/orchestrationKernel.js";
import { REQUIRED_BODY_HEADINGS } from "../exec/orchestrationTypes.js";
import { AutopilotEvent, runAutopilot } from "./autopilot.js";

const RUN_ID = "m5c-run";
const MILESTONE = "m5c";
const T0 = Date.UTC(2026, 6, 30, 0, 0, 0);

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 결과를 바꾸지 않는다 */
    }
  }
});

/** 결정론적 clock — 호출마다 `stepMs` 전진한다. 고정 sleep을 쓰지 않는 이유가 이것이다. */
function clockFrom(startMs: number, stepMs = 1000): () => Date {
  let n = 0;
  return () => new Date(startMs + stepMs * n++);
}

const EXECUTION_AUTHORITY = {
  codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
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
  maxNoProgressMs: 900_000,
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

function body(type: "task_assignment"): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

function seed(taskId: string): TaskSeed {
  return {
    taskId,
    roleId: "tech-lead",
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: ["docs", "src"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
  };
}

interface Fixture {
  ws: string;
  planDir: string;
  clock: () => Date;
}

/** run + root task + 빈 plan 디렉터리. 계획 파일은 각 테스트가 필요한 것만 넣는다. */
function boot(over: Record<string, unknown> = {}, taskIds = ["root"], stepMs = 1000): Fixture {
  const ws = makeDir("m5c-autopilot-ws-");
  const planDir = makeDir("m5c-autopilot-plans-");
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(taskIds, over),
    clock: clockFrom(T0),
  });
  for (const id of taskIds) k.createRootTask(seed(id));
  return { ws, planDir, clock: clockFrom(T0 + 60_000, stepMs) };
}

/** 계획 문서를 쓴다. binding(run/task/attempt/turn)은 **문서에 없다** — autopilot이 durable에서 채운다. */
function writePlan(planDir: string, taskId: string, plan: { operations?: unknown[]; result?: unknown }): void {
  writeFileSync(
    join(planDir, `${taskId}.json`),
    JSON.stringify({
      operations: plan.operations ?? [],
      result: plan.result ?? { summary: `${taskId} 완료`, outputs: [] },
    }),
  );
}

/** workspace 안에 산출물 파일을 만든다(typed write가 아니라 **이미 있는 파일**이다 — `B-16` 무관). */
function writeOutput(ws: string, rel: string, content: string): void {
  const abs = join(ws, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function reopen(ws: string): OrchestrationKernel {
  return openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 3_600_00) });
}

function taskOf(ws: string, taskId: string): OrchestrationTask {
  const t = reopen(ws).getTask(taskId);
  assert.ok(t, `${taskId}가 없다`);
  return t;
}

/** 지금 이 프로세스의 자식 pid 집합(관측 시점의 `ps` 자신도 포함된다). */
function childPids(): Set<number> {
  const out = execFileSync("/bin/ps", ["-Ao", "ppid=,pid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m && Number(m[1]) === process.pid) pids.add(Number(m[2]));
  }
  return pids;
}

/**
 * **생존 자손 0** — 이 loop는 프로세스를 하나도 띄우지 않는다.
 *
 * 고정 sleep이 아니라 **관측 barrier 두 개**로 판정한다:
 * ⓐ `baseline`은 autopilot을 부르기 **전**의 자식 집합이다 → 테스트 러너 자신의 자식
 *    (tsx/esbuild transform 프로세스 등)이 결과에 섞이지 않는다. 이것을 빼지 않으면 **소스를 고친 직후
 *    첫 실행만 빨개지는** false red가 된다(실제로 관측했다).
 * ⓑ 관측을 두 번 해 **둘 다에 있는 pid**만 생존자로 센다 → 관측 도구(`ps`) 자신은 매번 pid가 달라 빠진다.
 */
function assertNoDescendants(baseline: Set<number>): void {
  const first = childPids();
  const survivors = [...childPids()].filter((pid) => first.has(pid) && !baseline.has(pid));
  assert.deepEqual(survivors, [], `생존 자손이 있다: ${survivors.join(",")}`);
}

// ── ① 승인 manifest 게이트 ──────────────────────────────────────────────────

test("[M5c-3E] 승인 milestone이 다르면 run을 시작하지 않고 durable state를 바꾸지 않는다", async () => {
  const f = boot();
  writePlan(f.planDir, "root", {});
  const before = reopen(f.ws).getState();

  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: "다른-마일스톤",
    planDir: f.planDir,
    clock: f.clock,
  });

  assert.equal(report.blocked, "approval_milestone_mismatch");
  assert.deepEqual(report.tasks, []);
  assert.equal(report.iterations, 0);
  const after = reopen(f.ws).getState();
  assert.equal(after.revision, before.revision, "거부된 run이 revision을 올렸다");
  assert.equal(taskOf(f.ws, "root").state, "ready");
});

test("[M5c-3E] 만료된 승인 아래에서는 시작하지 않는다", async () => {
  const f = boot({ expiresAt: "2026-07-30T00:10:00.000Z" });
  writePlan(f.planDir, "root", {});
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    // 만료 이후 시각
    clock: clockFrom(Date.UTC(2026, 6, 30, 1, 0, 0)),
  });
  assert.equal(report.blocked, "manifest_expired");
  assert.equal(taskOf(f.ws, "root").state, "ready");
});

test("[M5c-3E] 없는 run은 durable 부작용 없이 거부된다", async () => {
  const report = await runAutopilot({
    workspaceRoot: makeDir("m5c-empty-"),
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: makeDir("m5c-empty-plans-"),
    clock: clockFrom(T0),
  });
  assert.equal(report.blocked, "run_unavailable");
});

// ── ② 정상 전진: 진행 관측 + 완료 ───────────────────────────────────────────

test("[M5c-3E] operation이 없는 계획은 진행 이벤트를 남기고 completed로 발행된다", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", { result: { summary: "root 완료", outputs: [{ path: "docs/out.md", role: "output" }] } });

  const events: AutopilotEvent[] = [];
  const baseline = childPids();
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    onEvent: (e) => events.push(e),
  });

  assert.equal(report.blocked, null);
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "completed", marker: "turn_completed" }]);

  const task = taskOf(f.ws, "root");
  assert.equal(task.state, "completed");
  assert.equal(task.artifactRefs.length, 1);
  assert.equal(task.artifactRefs[0]!.path, "docs/out.md");
  // 정리가 확인된 뒤에만 완료된다(`B-13` 순서 계약) — lease는 완료 커밋에서 풀린다.
  assert.equal(task.execution.processLeaseMarker, null);
  assert.equal(task.execution.cleanupStatus, "confirmed");

  // **조용한 세션이 아니다**: 진행이 화면에도, durable에도 남는다.
  assert.ok(events.some((e) => e.kind === "task_progress"), "progress 이벤트가 관측되지 않았다");
  assert.ok(task.execution.progressCount >= 1, "durable progressCount가 0이다");
  assert.ok(events.some((e) => e.kind === "task_completed" && e.taskId === "root"));
  assertNoDescendants(baseline);
});

test("[M5c-3E] 실패한 turn의 usage도 durable 회계에 남고 재시작이 예산을 리셋하지 않는다 (B-12)", async () => {
  const f = boot({}, ["root", "second"]);
  writeOutput(f.ws, "docs/a.md", "a\n");
  writePlan(f.planDir, "root", { result: { summary: "root 완료", outputs: [{ path: "docs/a.md", role: "output" }] } });

  await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });
  const first = reopen(f.ws).getAccounting();
  assert.ok(first.elapsedMsUsed >= 0);
  assert.equal(first.chargedTurnIds.length, 1, "turn이 정확히 한 번 과금되지 않았다");

  // **다른 프로세스가 다시 여는 것과 같은 경로**: 새 kernel 인스턴스가 같은 durable 회계를 이어받는다.
  writeOutput(f.ws, "docs/b.md", "b\n");
  writePlan(f.planDir, "second", { result: { summary: "second 완료", outputs: [{ path: "docs/b.md", role: "output" }] } });
  await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  const second = reopen(f.ws).getAccounting();
  assert.equal(second.chargedTurnIds.length, 2, "재시작이 회계를 리셋했다");
  assert.ok(second.elapsedMsUsed >= first.elapsedMsUsed, "durable 경과 회계가 줄었다");
  assert.equal(second.budgetStartedAt, first.budgetStartedAt, "재시작이 예산 창을 새로 열었다");
  assert.equal(second.budgetDeadlineAt, first.budgetDeadlineAt, "재시작이 run deadline을 밀었다");
});

// ── ③ hang 대신 pause ───────────────────────────────────────────────────────

test("[M5c-3E] typed operation을 요구하는 계획은 집행하지 않고 paused로 착지한다 (B-10/B-16 미소비)", async () => {
  const f = boot();
  writePlan(f.planDir, "root", {
    operations: [{ operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "x", expectedBeforeSha256: null }],
    result: { summary: "쓰기를 요구한다", outputs: [] },
  });

  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    onEvent: (e) => events.push(e),
  });

  assert.deepEqual(report.tasks, [{ taskId: "root", state: "paused", marker: "operation_denied" }]);
  const task = taskOf(f.ws, "root");
  assert.equal(task.state, "paused", "hang하거나 running에 남았다");
  assert.equal(task.execution.pauseReason, "approval_required");
  // **집행 흔적이 0이다** — permit·grant·영수증·미확정 operation 어느 것도 만들지 않았다.
  assert.deepEqual(task.execution.pendingOperations, []);
  assert.deepEqual(task.execution.operationReceipts, []);
  assert.equal(task.execution.dispatchTurnId, null);
  assert.equal(task.execution.chargedPlanDigest, null);
  // 파일도 만들어지지 않았다.
  assert.equal(reopen(f.ws).getState().artifacts.length, 0);
  assert.ok(events.some((e) => e.kind === "task_paused" && e.marker === "operation_denied"));

  // **복구 가능하다**: 같은 승인 아래 resume하면 다시 ready가 된다.
  const k = reopen(f.ws);
  assert.equal(k.resumeTask({ taskId: "root", actionId: "act.resume" }).state, "ready");
});

test("[M5c-3E] 무효한 계획도 hang 없이 paused로 접힌다", async () => {
  const f = boot();
  writeFileSync(join(f.planDir, "root.json"), JSON.stringify({ operations: [], result: { summary: "", outputs: "배열이 아니다" } }));
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
  });
  assert.equal(report.tasks.length, 1);
  assert.equal(report.tasks[0]!.state, "paused");
  const task = taskOf(f.ws, "root");
  assert.equal(task.state, "paused");
  assert.equal(task.execution.cleanupStatus, "confirmed", "정리를 지나지 않고 pause했다");
});

test("[M5c-3E] usage 과금이 거부되면 정리를 지난 뒤 paused로 착지하고 loop가 멈춘다 (B-22)", async () => {
  const f = boot({}, ["root", "sibling"]);
  writePlan(f.planDir, "root", {});
  writePlan(f.planDir, "sibling", {});

  // 과금 기록을 durable 상한까지 채운다 → autopilot의 다음 charge는 `charged_turns_exhausted`로 거부된다.
  // (토큰·경과 0이므로 예산 게이트는 그대로 통과한다 — 실패하는 것은 **회계 기록** 하나뿐이다.)
  const filler = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 30_000, 0) });
  for (let i = 0; i < LIMITS.maxChargedTurnIds; i++) {
    filler.chargeTurnUsage({ taskId: "root", turnId: `fill-${i}`, actionId: `fill-act-${i}`, inputTokens: 0, outputTokens: 0, elapsedMs: 0 });
  }

  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    onEvent: (e) => events.push(e),
  });

  // ⓐ 삼키지 않는다: 계획 자체는 완주 가능했지만(operation 0) 회계가 없으므로 완료로 발행하지 않는다.
  assert.equal(report.tasks.length, 1, "회계 실패 뒤에는 다음 task를 시작하지 않는다");
  assert.deepEqual(report.tasks[0], {
    taskId: "root",
    state: "paused",
    marker: "charged_turns_exhausted",
    chargeFailed: "charged_turns_exhausted",
  });
  // ⓑ loop는 낡은 총량 위에서 계속 돌지 않는다.
  assert.equal(report.stoppedBecause, "usage_unaccounted");
  assert.equal(report.blocked, null);
  // ⓒ 정리는 그대로 지났다(recordTerminal → confirmCleanup 순서 보존).
  const task = taskOf(f.ws, "root");
  assert.equal(task.execution.cleanupStatus, "confirmed", "회계 실패가 정리를 건너뛰게 만들었다");
  assert.equal(task.state, "paused", "hang하거나 running에 남았다");
  assert.equal(task.execution.pauseReason, "approval_required");
  // ⓓ 산출물은 발행되지 않았다 — 회계 없는 turn이 결과를 남기지 않는다.
  assert.equal(reopen(f.ws).getState().artifacts.length, 0);
  assert.ok(events.some((e) => e.kind === "task_paused" && e.marker === "charged_turns_exhausted" && e.detail === "usage_unaccounted"));
  // ⓔ 사라지지도 않는다: 사람이 회계를 맞춘 뒤 그대로 이어갈 수 있다.
  assert.equal(reopen(f.ws).resumeTask({ taskId: "root", actionId: "act.resume" }).state, "ready");
  // ⓕ 두 번째 task는 손대지 않았다(attempt·lease 없음).
  assert.equal(taskOf(f.ws, "sibling").state, "prepared");
});

test("[M5c-3E] 발행이 거부되는 산출물(디스크에 없음)도 paused로 착지한다", async () => {
  const f = boot();
  writePlan(f.planDir, "root", { result: { summary: "없는 파일", outputs: [{ path: "docs/missing.md", role: "output" }] } });
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
  });
  assert.equal(report.tasks[0]!.state, "paused");
  assert.equal(taskOf(f.ws, "root").state, "paused");
  assert.equal(reopen(f.ws).getState().artifacts.length, 0);
});

test("[M5c-3E] 계획이 없는 task는 deferred다 — 상태·attempt·자원을 건드리지 않는다 (B-11)", async () => {
  const f = boot();
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
  });
  assert.equal(report.stoppedBecause, "no_plans_available");
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "deferred", marker: "plan_missing" }]);
  const task = taskOf(f.ws, "root");
  assert.equal(task.state, "ready", "계획 없는 task가 자원을 잡았다");
  assert.equal(task.execution.attemptNo, 0);
  assert.equal(task.execution.processLeaseMarker, null);
});

// ── ④ deadline 집행 ─────────────────────────────────────────────────────────

test("[M5c-3E] attempt wall deadline을 넘긴 turn은 wall_deadline_exceeded로 닫히고 paused가 된다", async () => {
  // clock이 호출마다 5초 전진한다 → attempt wall(1초)은 첫 이벤트 판정에서 이미 지나 있다.
  const f = boot({ autopilotPolicy: { ...POLICY, maxAttemptElapsedMs: 1000 } }, ["root"], 5000);
  writePlan(f.planDir, "root", {});
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
  });
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "paused", marker: "wall_deadline_exceeded" }]);
  const task = taskOf(f.ws, "root");
  assert.equal(task.state, "paused");
  assert.equal(task.execution.pauseReason, "budget_elapsed_exhausted");
  assert.equal(task.execution.terminalMarker, "wall_deadline_exceeded");
});

test("[M5c-3E] no-progress deadline을 넘긴 turn은 no_progress_timeout으로 닫힌다", async () => {
  const f = boot({ autopilotPolicy: { ...POLICY, maxNoProgressMs: 1000, maxAttemptElapsedMs: 600_000 } }, ["root"], 5000);
  writePlan(f.planDir, "root", {});
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
  });
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "paused", marker: "no_progress_timeout" }]);
  assert.equal(taskOf(f.ws, "root").execution.terminalMarker, "no_progress_timeout");
});

test("[M5c-3E] durable run deadline이 소진되면 새 task를 시작하지 않는다", async () => {
  // budgetDeadlineAt = budgetStartedAt + 600s. 그 뒤 시각으로 부르면 durable run deadline이 이미 소진이다.
  const f = boot({ maxElapsedMs: 600_000 });
  writePlan(f.planDir, "root", {});
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 700_000),
  });
  assert.equal(report.blocked, "budget_elapsed_exhausted");
  assert.equal(taskOf(f.ws, "root").state, "ready");
});

test("[M5c-3E] loop iteration은 언제나 bounded다", async () => {
  const f = boot();
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    maxIterations: 10_000,
  });
  assert.ok(report.iterations <= 16, `iteration 상한을 넘었다: ${report.iterations}`);
});

// ── ⑤ 취소 정리 ────────────────────────────────────────────────────────────

test("[M5c-3E] turn 중 취소는 정리를 확인하고 cancelled로 닫는다 (생존 자손 0)", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", { result: { summary: "root 완료", outputs: [{ path: "docs/out.md", role: "output" }] } });

  // **관측 barrier**: 고정 sleep이 아니라 "첫 진행 이벤트를 실제로 봤을 때" abort한다.
  const ac = new AbortController();
  const events: AutopilotEvent[] = [];
  const baseline = childPids();
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    signal: ac.signal,
    onEvent: (e) => {
      events.push(e);
      if (e.kind === "task_progress") ac.abort();
    },
  });

  assert.equal(report.stoppedBecause, "cancelled");
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "cancelled", marker: "cancelled" }]);
  const task = taskOf(f.ws, "root");
  assert.equal(task.state, "cancelled");
  assert.equal(task.execution.cleanupStatus, "confirmed", "정리 확인 없이 취소가 닫혔다");
  assert.equal(task.execution.processLeaseMarker, null, "취소가 lease를 놓지 않았다");
  assert.equal(reopen(f.ws).getState().artifacts.length, 0, "취소된 turn이 결과를 발행했다");
  assertNoDescendants(baseline);
});

test("[M5c-3E] 시작 전에 이미 취소됐으면 task를 하나도 시작하지 않는다", async () => {
  const f = boot();
  writePlan(f.planDir, "root", {});
  const ac = new AbortController();
  ac.abort();
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    signal: ac.signal,
  });
  assert.equal(report.stoppedBecause, "cancelled");
  assert.deepEqual(report.tasks, []);
  assert.equal(taskOf(f.ws, "root").state, "ready");
});

// ── ⑥ 소비하지 않은 게이트의 부재 증명 ──────────────────────────────────────

test("[M5c-3E] 전달 attempt를 열지 않는다 — 열린 채 남는 activeAttemptId가 없다 (B-17)", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", { result: { summary: "root 완료", outputs: [{ path: "docs/out.md", role: "output" }] } });
  await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  for (const m of reopen(f.ws).getState().messages) {
    assert.equal(m.activeAttemptId ?? null, null, `열린 전달 attempt가 남았다: ${m.messageId}`);
  }
});

test("[M5c-3E] durable 결과 본문에 raw·토큰 카운터가 없고 §5.2 heading을 전부 갖춘다", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", { result: { summary: "root 완료", outputs: [{ path: "docs/out.md", role: "output" }] } });
  await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  const k = reopen(f.ws);
  const msg = k.getState().messages.find((m) => m.type === "result");
  assert.ok(msg, "result 메시지가 없다");
  const durable = readFileSync(join(k.paths.dir, msg.bodyPath), "utf8");
  for (const heading of REQUIRED_BODY_HEADINGS.result) {
    assert.ok(durable.includes(`## ${heading}`), `§5.2 heading 누락: ${heading}`);
  }
  // raw·프롬프트·토큰 카운터는 durable 산출물에 들어가지 않는다.
  assert.ok(!/usage|token|프롬프트/i.test(durable), "durable 본문에 raw·토큰 흔적이 있다");
  assert.ok((k.getTask("root")?.resultSummary ?? "").length <= LIMITS.maxSummaryLength);
});

// ── ⑦ 중단된 batch의 잔여 복구 (B-21 · C-55) ────────────────────────────────

test("[M5c] 중단된 batch가 남긴 prepared task를 다음 실행이 되찾아 완주시킨다 (B-21)", async () => {
  const f = boot({}, ["root", "sibling"]);
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const plan = { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } };
  writePlan(f.planDir, "root", plan);
  writePlan(f.planDir, "sibling", plan);

  // ⓐ 첫 실행: 첫 task의 진행을 본 순간 취소한다 → 두 번째는 `prepared`에 남는다(자원 점유 상태).
  const ac = new AbortController();
  const first = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    signal: ac.signal,
    onEvent: (e) => {
      if (e.kind === "task_progress") ac.abort();
    },
  });
  assert.equal(first.stoppedBecause, "cancelled");
  const leftover = taskOf(f.ws, "sibling");
  assert.equal(leftover.state, "prepared", "이 테스트의 전제(잔여 prepared)가 성립하지 않았다");
  const attemptNo = leftover.execution.attemptNo;

  // ⓑ 두 번째 실행: scheduler는 `prepared`를 고르지 않으므로(ready/retry_wait만) 되찾기가 없으면
  //    이 task는 영원히 자원을 붙잡는다. 되찾아 완주시켜야 한다 — **새 attempt를 태우지 않고**.
  const events: AutopilotEvent[] = [];
  const second = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
    onEvent: (e) => events.push(e),
  });

  assert.ok(
    second.tasks.some((t) => t.taskId === "sibling" && t.state === "completed"),
    `되찾지 못했다: ${JSON.stringify(second.tasks)}`,
  );
  const recovered = taskOf(f.ws, "sibling");
  assert.equal(recovered.state, "completed");
  assert.equal(recovered.execution.attemptNo, attemptNo, "되찾기가 attempt를 새로 태웠다");
  assert.equal(recovered.execution.cleanupStatus, "confirmed");
  assert.equal(recovered.execution.processLeaseMarker, null, "되찾은 turn이 lease를 놓지 않았다");
});

test("[M5c] 계획이 없는 잔여 prepared는 자원을 붙잡지 않고 paused로 접힌다 (B-21)", async () => {
  const f = boot({}, ["root", "sibling"]);
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const plan = { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } };
  writePlan(f.planDir, "root", plan);
  writePlan(f.planDir, "sibling", plan);

  const ac = new AbortController();
  await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    signal: ac.signal,
    onEvent: (e) => {
      if (e.kind === "task_progress") ac.abort();
    },
  });
  assert.equal(taskOf(f.ws, "sibling").state, "prepared");

  // 사람이 계획을 치웠다 = 무인 전진 자격이 없다. 그렇다고 `prepared`로 두면 자원을 영구히 잡는다.
  rmSync(join(f.planDir, "sibling.json"));
  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
    onEvent: (e) => events.push(e),
  });

  assert.ok(report.tasks.some((t) => t.taskId === "sibling" && t.state === "paused" && t.marker === "plan_missing"));
  const task = taskOf(f.ws, "sibling");
  assert.equal(task.state, "paused", "잔여가 여전히 자원 점유 상태다");
  assert.equal(task.execution.pauseReason, "approval_required");
  assert.ok(events.some((e) => e.kind === "task_paused" && e.detail === "prepared_reclaimed"));
  // 사라지지 않는다: 사람이 계획을 되돌려 놓고 resume하면 그대로 이어간다.
  assert.equal(reopen(f.ws).resumeTask({ taskId: "sibling", actionId: "act.resume" }).state, "ready");
});

test("[M5c] turn 중간 kernel throw는 CLI를 죽이지 않고 loop를 멈춘다 (C-55)", async () => {
  const f = boot({}, ["root", "sibling"]);
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const plan = { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } };
  writePlan(f.planDir, "root", plan);
  writePlan(f.planDir, "sibling", plan);

  // **관측 barrier**: task가 실제로 시작된 뒤에만 시계를 되돌린다 → 다음 kernel 호출이 시계 sanity로
  // throw한다. `startPreparedTask` 이후 turn 중간의 예기치 않은 throw를 결정론적으로 재현한다(`C-55`).
  let ticks = 0;
  let started = false;
  const clock = (): Date => {
    ticks += 1;
    return started ? new Date(T0 - 3_600_000) : new Date(T0 + 60_000 + ticks * 1000);
  };

  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock,
    onEvent: (e) => {
      events.push(e);
      if (e.kind === "task_started") started = true;
    },
  });

  // ⓐ 예외가 CLI 밖으로 전파되지 않았다(이 await 자체가 그 증거다).
  // ⓑ loop는 나머지 batch를 조용히 계속 밀지 않는다.
  assert.equal(report.stoppedBecause, "turn_aborted");
  assert.equal(report.blocked, null);
  const aborted = report.tasks.filter((t) => t.state === "aborted");
  assert.equal(aborted.length, 1, `aborted 착지가 정확히 1건이 아니다: ${JSON.stringify(report.tasks)}`);
  assert.ok(events.some((e) => e.kind === "task_paused" && e.detail === "turn_aborted"));
  // ⓒ 두 번째 task는 시작되지 않았다.
  assert.ok(!report.tasks.some((t) => t.taskId !== aborted[0].taskId && t.state === "completed"));
});
