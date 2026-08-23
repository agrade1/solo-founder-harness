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
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, OrchestrationError } from "../exec/orchestrationTypes.js";
import type { OrchestrationTask } from "../exec/orchestrationTypes.js";
import { __setPublicationSeamsForTest, createOrchestrationRun, openOrchestrationRun } from "../exec/orchestrationKernel.js";
import { runPaths } from "../exec/orchestrationStore.js";
import type { OrchestrationKernel, TaskSeed } from "../exec/orchestrationKernel.js";
import { REQUIRED_BODY_HEADINGS } from "../exec/orchestrationTypes.js";
import { AutopilotEvent, CODEX_REVIEWER_ROLE_FAMILY, runAutopilot } from "./autopilot.js";

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

function seed(taskId: string, roleId = "tech-lead"): TaskSeed {
  return {
    taskId,
    roleId,
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
function boot(over: Record<string, unknown> = {}, taskIds = ["root"], stepMs = 1000, roleId = "tech-lead"): Fixture {
  const ws = makeDir("m5c-autopilot-ws-");
  const planDir = makeDir("m5c-autopilot-plans-");
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(taskIds, over),
    clock: clockFrom(T0),
  });
  for (const id of taskIds) k.createRootTask(seed(id, roleId));
  return { ws, planDir, clock: clockFrom(T0 + 60_000, stepMs) };
}

/**
 * 리뷰 왕복 DAG 하나(`C-98` 검증용). **offline backend**로 돈다 — 게이트가 보는 것은 계획의 출처가
 * 아니라 durable 참가자 신원(`roleId`·`turnId`)이므로 모델을 띄우지 않고도 계약을 밟을 수 있다.
 *
 * `reviewRoundtrip`이 `null`이면 승인에 그 key를 넣지 않는다(= 강제하지 않는 승인).
 */
function bootRoundtrip(
  ids: string[],
  roundtrip: Record<string, unknown> | null,
  reviewRoleId: string,
): Fixture {
  const ws = makeDir("m11-rt-ws-");
  const planDir = makeDir("m11-rt-plans-");
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(ids, roundtrip === null ? {} : { reviewRoundtrip: roundtrip }),
    clock: clockFrom(T0),
  });
  const roleOf = (id: string): string =>
    id.startsWith("rev-") ? reviewRoleId : id === "verify" ? `${CODEX_REVIEWER_ROLE_FAMILY}.verify` : "dev-lead";
  k.createRootTask(seed(ids[0]!, roleOf(ids[0]!)));
  // impl → 리뷰 3종 → revise → verify. 의존성이 곧 실행 순서다.
  for (const id of ids.slice(1, 4)) {
    k.createDependentTask({ ...seed(id, roleOf(id)), dependsOn: [ids[0]!] });
  }
  k.createDependentTask({ ...seed("revise", roleOf("revise")), dependsOn: ids.slice(1, 4) });
  k.createDependentTask({ ...seed("verify", roleOf("verify")), dependsOn: ["revise"] });
  for (const id of ids) writePlan(planDir, id, {});
  return { ws, planDir, clock: clockFrom(T0 + 60_000, 1000) };
}

/**
 * 계획 문서를 쓴다. binding(run/task/attempt/turn)은 **문서에 없다** — autopilot이 durable에서 채운다.
 * `requests`는 주지 않으면 **key 자체를 적지 않는다**(생략된 계획 경로를 그대로 쓰는 것이 기본값이다).
 */
function writePlan(
  planDir: string,
  taskId: string,
  plan: { operations?: unknown[]; requests?: unknown[]; result?: unknown },
): void {
  writeFileSync(
    join(planDir, `${taskId}.json`),
    JSON.stringify({
      operations: plan.operations ?? [],
      ...(plan.requests === undefined ? {} : { requests: plan.requests }),
      result: plan.result ?? { summary: `${taskId} 완료`, outputs: [] },
    }),
  );
}

/** `spawn_child` 요청 1건(bounded 필드만 — ownership·budget을 요청으로 넓히는 통로가 없다). */
function spawnRequest(childTaskId: string, roleId = "qa-security", dependsOn: string[] = []): Record<string, unknown> {
  return {
    kind: "spawn_child",
    childTaskId,
    roleId,
    title: `${childTaskId} 제목`,
    scope: `${childTaskId} bounded scope`,
    dependsOn,
    reason: "전문 분야가 달라 쪼갠다",
  };
}

function deliverRequest(deliverTo: string, note = "진행 상황 공유"): Record<string, unknown> {
  return { kind: "deliver_status", deliverTo, note };
}

async function pilot(f: Fixture): Promise<Awaited<ReturnType<typeof runAutopilot>>> {
  return runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });
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

test("[M5d] 승인되지 않은 typed operation은 denied 영수증으로 닫히고 paused로 착지한다 (deny-by-default)", async () => {
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
  // **M5d task 2 이후의 계약**: 집행 게이트는 열렸지만 승인은 `operationAuthorityByTask`에서만 온다.
  // 이 manifest는 그 task에 아무 authority도 승인하지 않았으므로 거부가 **등록보다 먼저** 일어난다:
  // durable pending도 영수증도 만들어지지 않는다(효과 0 · 흔적 0).
  assert.deepEqual(task.execution.pendingOperations, [], "미확정 operation이 남았다");
  // 승인 밖 요청은 **등록 전에** 거부된다 → durable 영수증도 pending도 없다. `outcome_unknown`은
  // "정말 결과를 모르는" 경우에만 쓰인다(승인 밖 요청과 같은 marker를 받아서는 안 된다).
  assert.deepEqual(task.execution.operationReceipts, [], "승인 밖 거부가 durable 영수증을 남겼다");
  // 집행을 시도했다는 사실은 turn claim으로 정직하게 남고, **거부된 turn의 토큰도 원장에 들어간다**
  // (효과는 0이지만 worker turn은 실제로 일어났다 — 회계에서 사라지면 `B-22`가 막은 그 구멍이다).
  assert.notEqual(task.execution.dispatchTurnId, null, "집행 시도가 turn claim으로 남지 않았다");
  assert.equal(task.execution.chargedPlanDigest, task.execution.dispatchPlanDigest, "거부된 생산 turn이 원장에 없다");
  // 파일도 만들어지지 않았다 — 승인 밖 경로에 바이트가 생기지 않는다.
  assert.equal(existsSync(join(f.ws, "docs/x.md")), false, "승인되지 않은 operation이 파일을 만들었다");
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

  const messages = reopen(f.ws).getState().messages;
  assert.ok(messages.length > 0, "검사할 메시지가 없다(공허한 체크)");
  for (const m of messages) {
    // 필드 경로를 정확히 짚는다: `m.activeAttemptId`는 존재하지 않는 key라 언제나 통과했다(공허한 체크).
    assert.equal(m.delivery.activeAttemptId, null, `열린 전달 attempt가 남았다: ${m.messageId}`);
    assert.equal(m.delivery.attempts, 0, `전달 시도가 열렸다: ${m.messageId}`);
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
  // paused로 알리지 않는다 — 소비자가 "복구됨"으로 오독하면 안 된다(lease를 쥔 크래시 등가다).
  assert.ok(events.some((e) => e.kind === "task_aborted" && e.detail === "turn_aborted"));
  assert.ok(!events.some((e) => e.kind === "task_paused" && e.detail === "turn_aborted"));
  // ⓒ 두 번째 task는 시작되지 않았다.
  assert.ok(!report.tasks.some((t) => t.taskId !== aborted[0].taskId && t.state === "completed"));
});

// ── ⑧ 승인된 typed operation 집행 (M5d task 2 — B-10 소비) ──────────────────

test("[M5d] 승인된 write_file operation은 집행 경계를 지나 applied 영수증으로 닫힌다 (B-10 소비)", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  // **오늘의 write_file은 바이트를 만들지 못한다**: 신규 생성은 `write_publish_unsupported`(`B-16` — 열지
  // 않은 게이트), 내용 교체는 `write_replace_unsupported`다. 성공 경로는 **크래시 창 멱등** 하나뿐이다 —
  // 의도한 내용이 이미 있으면 부모 fsync를 확인하고 `already_applied`로 닫는다. 이 테스트가 고정하는 것은
  // 그 계약이지 "쓰기가 된다"가 아니다.
  writeOutput(f.ws, "docs/x.md", "same\n");
  const same = createHash("sha256").update("same\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "same\n", expectedBeforeSha256: same },
    ],
    result: { summary: "멱등 쓰기 1건", outputs: [{ path: "docs/x.md", role: "output" }] },
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

  // ⓐ turn이 집행 경계를 지나 완료로 닫히고 결과가 발행됐다.
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "completed", marker: "turn_completed" }]);
  assert.equal(taskOf(f.ws, "root").state, "completed");
  // ⓑ 영수증 marker는 **kernel이 만든다** — 호출자가 고를 수 없다.
  const task = taskOf(f.ws, "root");
  assert.deepEqual(task.execution.pendingOperations, [], "미확정 operation이 남았다");
  assert.equal(task.execution.operationReceipts.length, 1);
  assert.equal(task.execution.operationReceipts[0].marker, "already_applied");
  assert.equal(task.execution.operationReceipts[0].operationId, "op-1");
  // ⓒ 생산 turn은 **권위 있는 과금**으로만 닫힌다(claim된 계획 digest가 회계에 남는다).
  assert.notEqual(task.execution.chargedPlanDigest, null, "생산 turn이 권위 없이 과금됐다");
  assert.equal(task.execution.chargedPlanDigest, task.execution.dispatchPlanDigest);
  assert.ok(events.some((e) => e.kind === "task_completed"));
});

test("[M5d] 승인된 기존 파일 교체는 autopilot 경로에서도 실제로 바이트를 낸다 (B-16 부분 개방)", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "before\n");
  const before = createHash("sha256").update("before\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "after\n", expectedBeforeSha256: before },
    ],
    result: { summary: "내용 교체 시도", outputs: [] },
  });

  const report = await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  // 승인된 경로의 **기존 파일**은 실제로 바뀐다 — self-hosting의 implement 단계가 여기서 열린다.
  assert.equal(readFileSync(join(f.ws, "docs/x.md"), "utf8"), "after\n", "승인된 교체가 집행되지 않았다");
  assert.deepEqual(report.tasks, [{ taskId: "root", state: "completed", marker: "turn_completed" }]);
  const task = taskOf(f.ws, "root");
  assert.equal(task.execution.operationReceipts[0].marker, "applied");
  assert.deepEqual(task.execution.pendingOperations, [], "미확정 operation이 남았다");
});

test("[M5d] 신규 파일 발행은 autopilot 경로에서도 여전히 fail closed다 (B-16 잔여)", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/new.md", maxBytes: 64 }] } });
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/new.md", content: "new\n", expectedBeforeSha256: null },
    ],
    result: { summary: "신규 발행 시도", outputs: [] },
  });

  const report = await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  assert.equal(existsSync(join(f.ws, "docs/new.md")), false, "닫힌 발행 게이트가 파일을 만들었다");
  assert.equal(report.tasks[0].state, "paused");
  assert.equal(report.tasks[0].marker, "operation_denied");
});

test("[M5d] 승인된 authorityId라도 경로가 다르면 집행하지 않는다 (승인 레코드가 정본)", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "before\n");
  writeOutput(f.ws, "docs/other.md", "other\n");
  const before = createHash("sha256").update("other\n").digest("hex");
  // 승인된 authorityId를 들고 **다른 승인된 파일**을 노린다 — authorityId가 경로를 고르지 못해야 한다.
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/other.md", content: "hijacked\n", expectedBeforeSha256: before },
    ],
    result: { summary: "경로 바꿔치기", outputs: [] },
  });

  const report = await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  assert.equal(readFileSync(join(f.ws, "docs/other.md"), "utf8"), "other\n", "승인 레코드 밖 경로에 바이트가 생겼다");
  assert.equal(readFileSync(join(f.ws, "docs/x.md"), "utf8"), "before\n", "무관한 승인 경로가 바뀌었다");
  assert.equal(report.tasks[0].state, "paused");
  assert.equal(report.tasks[0].marker, "operation_denied");
  const task = taskOf(f.ws, "root");
  assert.deepEqual(task.execution.pendingOperations, [], "거부 뒤 미확정 operation이 남았다");
  assert.equal(reopen(f.ws).getState().artifacts.length, 0);
});

test("[M5d] 앞 operation이 거부되면 뒤 operation은 집행되지 않는다 (turn 전체가 완료가 아니다)", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-2", kind: "write_file", path: "docs/second.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/second.md", "second\n");
  const before = createHash("sha256").update("second\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      // 첫 번째는 승인되지 않은 authority다 → 여기서 멈춰야 한다.
      { operationId: "op-1", kind: "write_file", authorityId: "auth-x", path: "docs/second.md", content: "no\n", expectedBeforeSha256: before },
      { operationId: "op-2", kind: "write_file", authorityId: "auth-2", path: "docs/second.md", content: "yes\n", expectedBeforeSha256: before },
    ],
    result: { summary: "두 건", outputs: [] },
  });

  const report = await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });

  assert.equal(readFileSync(join(f.ws, "docs/second.md"), "utf8"), "second\n", "거부 이후의 operation이 집행됐다");
  assert.equal(report.tasks[0].marker, "operation_denied");
  assert.equal(taskOf(f.ws, "root").state, "paused");
});

test("[M5d] operation을 요구하는 turn의 취소도 미확정 pending을 남기지 않는다", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "same\n");
  const same = createHash("sha256").update("same\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "same\n", expectedBeforeSha256: same },
      { operationId: "op-2", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "same\n", expectedBeforeSha256: same },
    ],
    result: { summary: "두 건", outputs: [] },
  });

  // **관측 barrier**: 진행 이벤트를 본 순간 abort → 집행 loop 안에서 취소가 관측된다.
  const ac = new AbortController();
  const report = await runAutopilot({
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

  const task = taskOf(f.ws, "root");
  assert.deepEqual(task.execution.pendingOperations, [], "취소가 미확정 operation을 남겼다");
  assert.equal(task.execution.cleanupStatus, "confirmed", "취소가 정리를 건너뛰었다");
  assert.equal(report.tasks[0].marker, "cancelled");
  assert.equal(task.state, "cancelled");
  // 이 barrier(첫 진행 이벤트)는 terminal **이전**에 발화하므로 집행은 시작조차 하지 않는다 —
  // 그래서 원장에도 claim에도 흔적이 없어야 한다. **operation 사이**의 취소 창은 관측 가능한 hook이
  // 없어 이 테스트가 덮지 못한다(대장에 C로 남긴다 — 없는 커버리지를 있다고 적지 않는다).
  assert.equal(task.execution.chargedPlanDigest, null, "집행 전 취소인데 원장에 생산 turn이 있다");
  assert.equal(task.execution.dispatchTurnId, null, "집행 전 취소인데 turn claim이 남았다");
});

test("[M5d] B-16: 쓰기 도중 fault는 outcome_unknown으로 닫히고 미확정 pending을 남기지 않는다", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "before\n");
  const before = createHash("sha256").update("before\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "after\n", expectedBeforeSha256: before },
    ],
    result: { summary: "쓰기 도중 죽는다", outputs: [] },
  });

  // 집행 경계 **안에서** fault를 주입한다 → `write_apply_incomplete`. 그 pending은 이미 attemptedAt이
  // 찍혀 있어 평범한 실패로 지울 수 없고 `outcome_unknown`으로만 정직하게 닫혀야 한다.
  const restore = __setPublicationSeamsForTest({
    contentWrite: () => {
      throw new Error("fault");
    },
  });
  let report;
  try {
    report = await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock: f.clock });
  } finally {
    restore();
  }

  const task = taskOf(f.ws, "root");
  // ⓐ 미아 pending이 없다 — 착지가 막히지 않았다.
  assert.deepEqual(task.execution.pendingOperations, [], "미확정 operation이 남았다(착지가 막힌다)");
  // ⓑ **성공도 평범한 실패도 아니다**: 외부 효과가 일어났을 수 있다는 사실이 durable에 남는다.
  assert.deepEqual(
    task.execution.operationReceipts.map((r) => ({ operationId: r.operationId, marker: r.marker })),
    [{ operationId: "op-1", marker: "outcome_unknown" }],
    "torn 가능성이 있는 집행이 정직하게 닫히지 않았다",
  );
  // ⓒ turn은 완료가 아니고 task는 복구 가능한 paused로 착지한다(hang 없음).
  assert.equal(report.tasks[0].state, "paused");
  assert.equal(task.state, "paused");
  assert.equal(reopen(f.ws).getState().artifacts.length, 0, "torn 가능성이 있는 turn이 결과를 발행했다");
});

// ── ⑦ V3 M6 T2 — spawn/message 배선 (완료 조건 ①②) ─────────────────────────
//
// 이 절이 고정하는 것은 **autopilot 경유 end-to-end**다(kernel 단위 테스트가 아니다): provider 출력의
// `spawn_child`·`deliver_status` 요청이 kernel 게이트를 지나 durable graph와 inbox route로 나타나는가.

test("[M6-T2] ①: 계획의 spawn 요청이 kernel 경유로 child를 만들고 parent는 위임으로 착지한다", async () => {
  const f = boot();
  writePlan(f.planDir, "root", { requests: [spawnRequest("child1")] });

  const report = await pilot(f);

  // parent는 **결과를 발행하지 않는다** — 위임했으므로 `waiting_children`이다.
  assert.equal(report.tasks[0].state, "waiting_children");
  const k = reopen(f.ws);
  const root = k.getTask("root")!;
  assert.equal(root.state, "waiting_children");
  assert.deepEqual(root.childTaskIds, ["child1"]);
  assert.equal(root.resultSummary, null, "위임 turn이 결과를 발행했다");
  // 정리 확인 뒤에 위임했으므로 lease와 봉인된 결과가 남아 있지 않다(`B-13`).
  assert.equal(root.execution.processLeaseMarker, null);
  assert.equal(root.execution.pendingResult, null);

  // child는 kernel이 만들었다: depth·parent·role·상태가 전부 kernel 계산값이다.
  const child = k.getTask("child1")!;
  assert.equal(child.depth, 1);
  assert.equal(child.parentTaskId, "root");
  assert.equal(child.roleId, "qa-security");
  assert.equal(child.state, "ready");
  // spawn_request 메시지가 durable하게 남았다(§5.2 heading 전부).
  const spawnMsg = k.getState().messages.find((m) => m.type === "spawn_request");
  assert.ok(spawnMsg, "spawn_request 메시지가 없다");
  const spawnBody = readFileSync(join(f.ws, "outputs/orchestration", RUN_ID, spawnMsg.bodyPath), "utf8");
  for (const h of REQUIRED_BODY_HEADINGS.spawn_request) assert.ok(spawnBody.includes(`## ${h}`), `heading 누락: ${h}`);
});

test("[M6-T2] ①: child 결과가 parent inbox로 route되고 parent가 다시 ready로 올라온다", async () => {
  const f = boot();
  writePlan(f.planDir, "root", { requests: [spawnRequest("child1")] });
  await pilot(f);

  // child의 turn — 산출물 하나를 발행한다.
  writeOutput(f.ws, "docs/child.md", "# child 산출물\n");
  writePlan(f.planDir, "child1", { result: { summary: "child1 완료", outputs: [{ path: "docs/child.md", role: "output" }] } });
  writeFileSync(join(f.planDir, "root.json"), JSON.stringify({ operations: [], result: { summary: "root 통합 완료", outputs: [] } }));
  const second = await pilot(f);

  const k = reopen(f.ws);
  assert.equal(k.getTask("child1")!.state, "completed");
  // **결과 메시지가 parent에게 route됐다** — 중앙이 route를 정하고 parent inbox에 durable하게 남는다.
  const result = k.getState().messages.find((m) => m.type === "result" && m.taskId === "child1");
  assert.ok(result, "child result 메시지가 없다");
  assert.equal(result.routeToTaskId, "root");
  assert.deepEqual(
    k.listPendingInbox("root").map((m) => m.messageId),
    [result.messageId],
    "parent inbox에 child 결과가 없다",
  );
  // child 완료 → parent는 kernel recompute로 ready가 되고, 같은 실행 안에서 결과까지 발행한다.
  assert.equal(k.getTask("root")!.state, "completed");
  assert.equal(k.getTask("root")!.resultSummary, "root 통합 완료");
  assert.ok(
    second.tasks.some((t) => t.taskId === "root" && t.state === "completed"),
    "parent가 같은 실행에서 결과를 내지 못했다",
  );
});

test("[M6-T2] ①: child→중앙→sibling 전달이 sibling inbox에 도착한다", async () => {
  const f = boot();
  // root가 형제 둘을 요청한다(같은 parent = 전달 가능한 관계).
  writePlan(f.planDir, "root", { requests: [spawnRequest("c1"), spawnRequest("c2", "dev-lead")] });
  await pilot(f);

  writePlan(f.planDir, "c1", { requests: [deliverRequest("c2", "c1이 계약을 확정했다")] });
  await pilot(f);

  const k = reopen(f.ws);
  const status = k.getState().messages.find((m) => m.type === "status_update");
  assert.ok(status, "status_update가 없다");
  // 발신은 **중앙에게**이고 route를 정한 것은 중앙이다(직접 mailbox 쓰기가 아니다).
  assert.equal(status.taskId, "c1");
  assert.equal(status.recipient, "orchestrator");
  assert.equal(status.routeToTaskId, "c2");
  assert.equal(status.summary, "c1이 계약을 확정했다");
  assert.deepEqual(
    k.listPendingInbox("c2").map((m) => m.type),
    ["status_update"],
    "sibling inbox에 전달이 없다",
  );
  // 전달한 task 자신은 그 turn을 정상 완료한다(전달이 결과 발행을 막지 않는다).
  assert.equal(k.getTask("c1")!.state, "completed");
});

test("[M6-T2] ②: 관계 없는 대상으로의 전달은 kernel이 거부하고 turn은 완료가 아니다", async () => {
  // root와 lone은 서로 무관한 두 root task다(같은 parent도 의존 관계도 아니다).
  const f = boot({}, ["root", "lone"]);
  writePlan(f.planDir, "root", { requests: [deliverRequest("lone")] });
  writePlan(f.planDir, "lone", {});

  const report = await pilot(f);

  const root = report.tasks.find((t) => t.taskId === "root")!;
  assert.equal(root.state, "paused");
  assert.equal(root.marker, "delivery_failed");
  const k = reopen(f.ws);
  assert.equal(k.getTask("root")!.state, "paused");
  assert.equal(k.getTask("root")!.resultSummary, null, "거부된 전달 turn이 결과를 발행했다");
  assert.equal(k.getState().messages.some((m) => m.type === "status_update"), false, "거부된 전달이 durable에 남았다");
  assert.deepEqual(k.listPendingInbox("lone"), []);
});

test("[M6-T2] ②: registry 밖 role의 spawn 요청은 kernel이 거부하고 child가 생기지 않는다", async () => {
  const f = boot();
  writePlan(f.planDir, "root", { requests: [spawnRequest("child1", "ceo")] });

  const report = await pilot(f);

  assert.equal(report.tasks[0].state, "paused");
  assert.equal(report.tasks[0].marker, "unknown_role");
  const k = reopen(f.ws);
  assert.equal(k.getTask("child1"), null, "거부된 요청이 child를 만들었다");
  assert.deepEqual(k.getTask("root")!.childTaskIds, []);
  assert.equal(k.getTask("root")!.state, "paused");
});

test("[M6-T2] ②: depth 상한을 넘는 spawn 요청은 kernel이 거부한다", async () => {
  const f = boot();
  const chain = ["root", "d1", "d2", "d3"];
  // depth 0→1→2→3까지 요청을 이어 붙인다. d3(depth 3)가 요청하는 d4는 상한 밖이다.
  for (let i = 0; i < chain.length - 1; i++) {
    writePlan(f.planDir, chain[i]!, { requests: [spawnRequest(chain[i + 1]!)] });
  }
  writePlan(f.planDir, "d3", { requests: [spawnRequest("d4")] });
  for (let i = 0; i < 5; i++) await pilot(f);

  const k = reopen(f.ws);
  assert.equal(k.getTask("d3")!.depth, LIMITS.maxDepth);
  assert.equal(k.getTask("d4"), null, "depth 상한을 넘은 child가 만들어졌다");
  assert.equal(k.getState().tasks.some((t) => t.depth > LIMITS.maxDepth), false);
  assert.equal(k.getTask("d3")!.state, "paused");
});

test("[M6-T2] ②: spawn turn이 산출물을 주장하면 조용히 유실되지 않고 계획 무효다", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", {
    requests: [spawnRequest("child1")],
    result: { summary: "root 완료", outputs: [{ path: "docs/out.md", role: "output" }] },
  });

  const report = await pilot(f);

  assert.equal(report.tasks[0].marker, "plan_invalid");
  assert.equal(report.tasks[0].state, "paused");
  const k = reopen(f.ws);
  assert.equal(k.getTask("child1"), null, "거부된 계획이 child를 만들었다");
  assert.equal(k.getState().artifacts.length, 0, "거부된 계획이 artifact를 등록했다");
});

// ── ⑨ V3 M10 T1 — 크래시 잔재 정착 (완료 조건 "중단 후 재개") ────────────────
//
// 이 절이 고정하는 것은 **거짓 성공 영수증이 없는 복구**다. M10의 완료 조건은 "중단 후 재개 시 중복
// agent/중복 merge/결정 유실 없음"이므로, 복구가 **되는 경우**와 **되지 않는 경우**를 둘 다 고정한다 —
// 되지 않는 경우를 조용히 통과시키면 그 자체가 과대주장이다.

/** durable 감사 로그 원문(state 요약이 아니다 — 지워진 per-attempt 배열도 여기에는 남는다). */
function eventLog(ws: string): Array<{ type: string; marker: string | null; taskId: string | null }> {
  const file = runPaths(ws, RUN_ID).eventsFile;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; marker: string | null; taskId: string | null });
}

function eventTypes(ws: string): string[] {
  return eventLog(ws).map((e) => e.type);
}

/**
 * **turn 도중 프로세스가 죽은 것과 durable하게 등가인 잔재**를 만든다. C-55 테스트와 같은 수단
 * (시작 뒤 시계 역행 → 다음 kernel 호출이 throw)이며, 결과는 `running`/`cleaning` + lease를 쥔 task다.
 * 실제 SIGKILL 재현은 store 층 테스트(`orchestrationKernel.test.ts`의 M10 절)가 real child로 한다.
 */
async function crashDuringTurn(f: Fixture, taskId: string): Promise<void> {
  let started = false;
  let ticks = 0;
  const clock = (): Date => {
    ticks += 1;
    return started ? new Date(T0 - 3_600_000) : new Date(T0 + 60_000 + ticks * 1000);
  };
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock,
    onEvent: (e) => {
      if (e.kind === "task_started" && e.taskId === taskId) started = true;
    },
  });
  assert.equal(report.stoppedBecause, "turn_aborted", "이 테스트의 전제(크래시 등가 잔재)가 성립하지 않았다");
}

test("[M10-T1] 크래시 등가 잔재를 다음 실행이 정착시키고 새 attempt로 재개한다 (C-55 잔여)", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } });

  await crashDuringTurn(f, "root");
  const stranded = taskOf(f.ws, "root");
  assert.ok(stranded.state === "running" || stranded.state === "cleaning", `잔재 상태: ${stranded.state}`);
  assert.ok(stranded.execution.processLeaseMarker !== null, "잔재가 lease를 쥐고 있지 않다");
  const deadAttempt = stranded.execution.attemptId;

  // 두 번째 실행: 잔재를 정착시키고(controller_lost → 정리 확인 → settle) 같은 실행 안에서 재개한다.
  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
    onEvent: (e) => events.push(e),
  });

  // ⓐ 관측한 사실이 그대로 durable에 남는다 — controller가 사라졌다(worker 실패가 아니다).
  assert.ok(
    events.some((e) => e.kind === "task_aborted" && e.marker === "controller_lost" && e.detail === "crash_settled:retry_wait"),
    `정착 이벤트가 없다: ${JSON.stringify(events)}`,
  );
  // ⓑ **재개됐다**: 같은 task가 새 attempt로 완주한다.
  const done = taskOf(f.ws, "root");
  assert.equal(done.state, "completed", `재개되지 않았다: ${done.state}`);
  assert.equal(done.execution.processLeaseMarker, null, "완주한 task가 lease를 쥐고 있다");
  assert.equal(report.stoppedBecause, "no_runnable_tasks");
  // ⓒ **중복이 없다**: 죽은 attempt는 부활하지 않고(새 attemptId) 결과 메시지는 정확히 1건이다.
  assert.notEqual(done.execution.attemptId, deadAttempt, "죽은 attempt가 그대로 부활했다");
  const k = reopen(f.ws);
  assert.equal(k.getState().messages.filter((m) => m.taskId === "root" && m.type === "result").length, 1, "결과가 중복 발행됐다");
  assert.equal(k.getState().artifacts.length, 1, "artifact가 중복 등록됐다");
  // ⓓ **결정 유실이 없다**: 죽은 attempt의 정리 확인과 새 attempt의 완료가 둘 다 감사 로그에 있다.
  const types = eventTypes(f.ws);
  assert.ok(types.includes("cleanup_confirmed"), "정리 확인이 감사 로그에 없다");
  assert.ok(types.includes("retry_scheduled"), "재시도 예약이 감사 로그에 없다");
});

test("[M10-T1] 정리를 관측하지 못한 attempt는 confirmCleanup을 적지 않고 자원을 쥔 채 격리된다", async () => {
  const f = boot({}, ["root", "sibling"]);
  writePlan(f.planDir, "root", { result: { summary: "완료", outputs: [] } });
  writePlan(f.planDir, "sibling", { result: { summary: "완료", outputs: [] } });

  // **durable 증거를 직접 만든다**: supervisor가 "프로세스 그룹이 빈 것을 관측하지 못했다"고 보고한
  // attempt가 남긴 상태 그대로다(`cleanup_unconfirmed` marker + lease + cleaning).
  // 이 테스트가 증명하는 것은 **그 증거를 보고 하는 판정**이며, OS 수준 좌초 프로세스 탐지가 아니다
  // (그런 관측자는 이 아키텍처에 없다 — `recoverCrashedAttempts` 주석 참조).
  const k0 = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 60_000, 1000) });
  const batch = k0.planRunnableBatch();
  k0.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: "act.pf1",
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: `att.${t.taskId}` })),
  });
  k0.startPreparedTask({ taskId: "root", actionId: "act.start1", leaseMarker: `lease.${"a".repeat(32)}` });
  k0.recordTerminal({ taskId: "root", actionId: "act.term1", marker: "cleanup_unconfirmed" });
  const beforeEvents = eventTypes(f.ws).length;

  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
    onEvent: (e) => events.push(e),
  });

  // ⓐ **거짓 성공 영수증이 없다**: 이 실행이 남긴 event에 정리 확인이 하나도 없다.
  const added = eventTypes(f.ws).slice(beforeEvents);
  assert.ok(!added.includes("cleanup_confirmed"), `관측하지 못한 정리를 확인으로 적었다: ${added.join(",")}`);
  assert.ok(added.includes("cleanup_failed"), `관측 실패를 durable에 적지 않았다: ${added.join(",")}`);
  // ⓑ 자원을 놓지 않는다 — 살아 있을 수 있는 자손이 다음 batch의 배타 자원 판정을 거짓으로 만들지 않게.
  const isolated = taskOf(f.ws, "root");
  assert.equal(isolated.state, "cleaning", "관측하지 못한 정리인데 자원을 놓았다");
  assert.notEqual(isolated.execution.cleanupStatus, "confirmed");
  assert.equal(isolated.execution.cleanupAttempts, 1);
  assert.ok(isolated.execution.processLeaseMarker !== null, "격리했는데 lease를 놓았다");
  // ⓒ loop는 조용히 나머지를 밀지 않는다.
  assert.equal(report.stoppedBecause, "cleanup_unobservable");
  assert.ok(events.some((e) => e.kind === "task_aborted" && e.detail === "crash_isolated"));
  assert.equal(taskOf(f.ws, "sibling").state, "prepared", "격리 뒤에도 다음 task를 밀었다");
});

test("[M10-T1] 효과 뒤 크래시가 남긴 미확정 operation은 durable 신원만으로 정합화된 뒤 정착한다", async () => {
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "before\n");
  const before = createHash("sha256").update("before\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "after\n", expectedBeforeSha256: before },
    ],
    result: { summary: "영수증 전에 죽는다", outputs: [] },
  });

  // **효과는 끝났고 영수증은 못 적은 창**: 마지막 seam(`dirFsync`) 뒤에 시계를 되돌리면 영수증 커밋과
  // 그 뒤의 모든 kernel 호출이 거부된다 → pending이 attemptedAt과 함께 durable에 남는다(= 크래시 등가).
  let crashed = false;
  let ticks = 0;
  const clock = (): Date => {
    ticks += 1;
    return crashed ? new Date(T0 - 3_600_000) : new Date(T0 + 60_000 + ticks * 1000);
  };
  const restore = __setPublicationSeamsForTest({
    dirFsync: () => {
      crashed = true;
    },
  });
  try {
    const first = await runAutopilot({ workspaceRoot: f.ws, runId: RUN_ID, milestoneId: MILESTONE, planDir: f.planDir, clock });
    assert.equal(first.stoppedBecause, "turn_aborted", "이 테스트의 전제(영수증 전 크래시)가 성립하지 않았다");
  } finally {
    restore();
  }
  const stranded = taskOf(f.ws, "root");
  assert.equal(stranded.execution.pendingOperations.length, 1, "미확정 operation 잔재가 없다");
  assert.ok(stranded.execution.pendingOperations[0]!.attemptedAt !== null, "집행 경계에 들어간 흔적이 없다");

  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
    maxIterations: 1,
  });

  const settled = taskOf(f.ws, "root");
  // ⓐ pending은 **durable 신원만으로** 닫혔다(살아 있는 grant는 크래시와 함께 사라졌다).
  assert.deepEqual(settled.execution.pendingOperations, [], "미확정 operation이 남아 정착이 막혔다");
  // 정합화는 **감사 로그**에 남는다 — 새 attempt가 시작되면 per-attempt 영수증 배열은 리셋되므로
  // state 요약만 보면 "정합화했다"를 증명할 수 없다(그 차이가 곧 공허한 단정과 실측의 차이다).
  assert.ok(
    eventLog(f.ws).some((e) => e.type === "operation_receipt" && e.marker === "outcome_unknown"),
    "효과가 일어났을 수 있는 operation을 성공·실패로 단정했다(또는 정합화하지 않았다)",
  );
  // ⓑ `write_file`은 자손을 남기지 않으므로 정리 판정과 무관하다 → 정착하고 재개 대상이 된다.
  //    (여기서 격리하면 파일 쓰기 하나의 미확정이 run 전체를 영구 격리시킨다.)
  //    같은 실행 안에서 새 attempt가 **멱등 재집행**(`already_applied`)으로 완주한다 = 재개의 실체다.
  assert.equal(settled.state, "completed", `정착·재개하지 않았다: ${settled.state}`);
  assert.equal(settled.execution.attemptNo, 2, "새 attempt로 재개하지 않았다");
  assert.deepEqual(settled.execution.operationReceipts.map((r) => r.marker), ["already_applied"]);
  assert.notEqual(report.stoppedBecause, "cleanup_unobservable");
  assert.ok(eventTypes(f.ws).includes("cleanup_confirmed"), "구조적으로 survivors 0인데 정리를 확인하지 않았다");
});

test("[M10-T1] prepared 잔여 pause가 kernel에 거부돼도 CLI가 죽지 않고 loop가 멈춘다 (C-59)", async () => {
  const f = boot({}, ["root", "t2", "t3"]);
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const plan = { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } };
  for (const id of ["root", "t2", "t3"]) writePlan(f.planDir, id, plan);

  // 첫 실행을 첫 진행에서 취소한다 → t2·t3가 `prepared` 잔여로 남는다.
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
  assert.equal(taskOf(f.ws, "t2").state, "prepared", "이 테스트의 전제(prepared 잔여)가 성립하지 않았다");
  assert.equal(taskOf(f.ws, "t3").state, "prepared");
  rmSync(join(f.planDir, "t2.json"));

  // 계획 없는 잔여(t2)를 pause하려는 순간 **다른 writer가 먼저 커밋한 상태**를 만든다 → autopilot의
  // 다음 커밋은 `stale_writer`다. 이전 판은 이 pause가 `C-55` 보호 **밖**이라 예외가 CLI 밖으로 나갔다
  // (대장 `C-59`).
  const other = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 200_000, 1000) });
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
    onEvent: (e) => {
      if (e.kind === "run_started") other.pauseTask({ taskId: "t3", actionId: "act.other", pauseReason: "operator_requested" });
    },
  });

  // ⓐ 예외가 CLI 밖으로 전파되지 않았다(이 await 자체가 증거다) ⓑ 조용히 진행하지도 않았다.
  assert.equal(report.blocked, null);
  assert.equal(report.stoppedBecause, "stale_writer");
  assert.equal(taskOf(f.ws, "t2").state, "prepared", "거부된 pause가 상태를 바꿨다");
});

// ── ⑩ V3 M10 T2 — 통합 시나리오 (로드맵: rotation·요약 변질·문서 누락·의존성 실패·권한 요청) ──
//
// **red-path가 먼저다.** 각 축은 결함을 심어 게이트가 실제로 **중단시키는지** 확인한 뒤 green을 만든다.
//
// 이 절이 덮는 것은 **통합 층(runAutopilot 왕복)에 공백이 있던 축**뿐이다. kernel/store 층에서 이미
// 전수로 덮인 것을 다시 쓰지 않는다(중복 테스트가 최악이다):
// - **문서 누락**: `orchestrationKernel.test.ts`가 **전 메시지 타입 × 각 필수 heading 누락**을 전수로
//   본다(`body_missing_heading`). autopilot 경로에서는 result body를 autopilot이 `REQUIRED_BODY_HEADINGS`
//   에서 **직접 만들므로** 계획 문서로 heading을 뺄 통로가 아예 없다 → **통합 red는 표현 불가**이고,
//   green(발행된 본문이 heading 전부를 갖춘다)은 위 "[M5c-3E] durable 결과 본문에 …" 테스트가 이미 본다.
// - **요약 변질** 중 bound 초과·artifact 위조·state 손편집 자체: kernel/store 층 테스트가 덮는다.
//   여기서는 **실행 사이에 durable 파일을 건드리면 다음 실행이 시작조차 못 한다**만 본다.

test("[M10-T2] 쓰지 않고 닫힌 operation을 durable 본문이 집행 성공처럼 적지 않는다 (리뷰 B1)", async () => {
  // `write_conflict`는 **예외가 아니다**: 집행기가 preimage 불일치를 보고 **쓰지 않고** 영수증만 남기며,
  // 그 turn은 여전히 `turn_completed`로 완료된다. 계획 기준으로 본문을 적으면 "집행했다"만 남아
  // 바이트가 바뀌지 않은 것을 바뀐 것처럼 읽힌다.
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "actual\n");
  const stale = createHash("sha256").update("stale\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "next\n", expectedBeforeSha256: stale },
    ],
    result: { summary: "preimage가 어긋난다", outputs: [{ path: "docs/x.md", role: "output" }] },
  });

  const report = await pilot(f);
  const task = taskOf(f.ws, "root");
  assert.equal(task.execution.operationReceipts[0]?.marker, "write_conflict", "이 테스트의 전제(conflict 완료)가 성립하지 않았다");
  assert.equal(report.tasks[0].state, "completed", `전제: conflict turn도 완료된다 — ${JSON.stringify(report.tasks)}`);
  assert.equal(readFileSync(join(f.ws, "docs/x.md"), "utf8"), "actual\n", "conflict인데 바이트가 바뀌었다");

  const entry = reopen(f.ws).getState().messages.find((m) => m.type === "result");
  const body = readFileSync(join(runPaths(f.ws, RUN_ID).dir, entry!.bodyPath), "utf8");
  assert.match(body, /write_file→write_conflict×1/, body);
  assert.ok(body.includes("쓰지 않고"), `쓰지 않았다는 사실이 본문에 없다:\n${body}`);
});

test("[M10-T2] 권한 요청: 결정 없이는 완료로 못 가고, 결정 뒤에만 재개된다 (사람 gate 우회 없음)", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const done = { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } };
  // red: 계획이 사람에게 물었다 → 답이 없는 동안 결과를 발행할 수 없다.
  writePlan(f.planDir, "root", {
    requests: [{ kind: "request_decision", question: "계약을 바꿔야 하는가?", safeDefault: "현행 계약 유지" }],
    ...done,
  });

  const first = await pilot(f);
  assert.equal(first.tasks[0].state, "paused", `결정 없이 진행했다: ${JSON.stringify(first.tasks)}`);
  assert.equal(first.tasks[0].marker, "decision_pending", first.tasks[0].marker);
  const asked = reopen(f.ws);
  assert.equal(asked.getTask("root")!.state, "paused");
  assert.equal(asked.getState().artifacts.length, 0, "결정을 기다리는 turn이 결과를 발행했다");
  assert.equal(
    asked.getState().messages.filter((m) => m.type === "decision_request").length,
    1,
    "사람에게 물은 기록이 durable에 없다",
  );

  // green: 사람이 답한다 — **중앙 API로만** 가능하다(agent 요청 union에 답 갈래가 없다).
  const answering = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 200_000, 1000) });
  answering.recordDecision({
    envelope: {
      schemaVersion: "1",
      messageId: "dec-root",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "root",
      parentTaskId: null,
      sender: "orchestrator",
      recipient: "tech-lead",
      type: "decision",
      createdAt: "2026-08-19T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
    },
    body: REQUIRED_BODY_HEADINGS.decision.map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n"),
    summary: "현행 계약 유지",
  });
  answering.resumeTask({ taskId: "root", actionId: "act.resume" });
  // 계획에서 요청을 뺀다 — 남겨두면 **재실행이 또 물어서** 다시 결정 대기가 된다(그것도 정상 동작이다).
  writePlan(f.planDir, "root", done);

  const second = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 300_000, 1000),
  });
  assert.ok(
    second.tasks.some((t) => t.taskId === "root" && t.state === "completed"),
    `결정 뒤에도 재개되지 않았다: ${JSON.stringify(second.tasks)}`,
  );
  const k = reopen(f.ws);
  assert.equal(k.getState().messages.filter((m) => m.type === "decision").length, 1);
  assert.equal(k.getState().artifacts.length, 1);
});

test("[M10-T2] 의존성 실패: 상류가 blocked면 하류에 표시되고 loop가 조용히 진행하지 않는다", async () => {
  // ownership은 승인 manifest가 정본이다 — 하류 task도 승인 안에 있어야 만들 수 있다(`ownership_not_approved`).
  const f = boot({ ownershipByTask: { up: ["docs", "src"], down: ["docs", "src"] } }, ["up"]);
  const k0 = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 10_000, 1000) });
  k0.createDependentTask({ ...seed("down"), dependsOn: ["up"] });
  assert.equal(taskOf(f.ws, "down").state, "pending", "의존이 남은 task가 pending이 아니다");

  // red: 상류가 막혔다고 보고된다(worker 계획에는 blocker 갈래가 **없다** — 차단은 중앙 API로만 기록된다).
  // blocker는 **확인된 정리 뒤에만** 수락된다(`B-13`) → lifecycle을 그대로 지난다.
  const blocking = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 60_000, 1000) });
  const lease = `lease.${"c".repeat(32)}`;
  const batch = blocking.planRunnableBatch();
  blocking.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: "act.pf",
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: `att.${t.taskId}` })),
  });
  blocking.startPreparedTask({ taskId: "up", actionId: "act.start", leaseMarker: lease });
  blocking.recordTerminal({ taskId: "up", actionId: "act.term", marker: "worker_failed" });
  blocking.confirmCleanup({ taskId: "up", actionId: "act.clean", leaseMarker: lease });
  blocking.submitBlocker({
    envelope: {
      schemaVersion: "1",
      messageId: "blk-up",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "up",
      parentTaskId: null,
      sender: "tech-lead",
      recipient: "orchestrator",
      type: "blocker",
      createdAt: "2026-08-19T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
    },
    body: REQUIRED_BODY_HEADINGS.blocker.map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n"),
    summary: "상류 계약이 정해지지 않았다",
  });
  assert.equal(taskOf(f.ws, "up").state, "blocked", "이 테스트의 전제(상류 blocked)가 성립하지 않았다");

  // 하류는 **조용히 pending으로 남지 않는다** — 의존이 막혔다는 사실이 durable에 표시된다.
  const down = taskOf(f.ws, "down");
  assert.equal(down.state, "blocked", `하류가 의존 실패를 반영하지 않았다: ${down.state}`);
  // **왜 blocked인지가 감사 로그에 남는다** — 상태만 바뀌고 이유가 없으면 사람이 원인을 되짚을 수 없다.
  const blockedFor = readFileSync(runPaths(f.ws, RUN_ID).eventsFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "task_state_changed" && e.taskId === "down" && e.toState === "blocked")
    .map((e) => e.reason);
  assert.deepEqual(blockedFor, ["dependency_blocked"], JSON.stringify(blockedFor));

  // 그리고 loop는 **계획이 있어도** 막힌 task를 돌리지 않고 소리내어 멈춘다.
  writePlan(f.planDir, "up", { result: { summary: "완료", outputs: [] } });
  writePlan(f.planDir, "down", { result: { summary: "완료", outputs: [] } });
  const after = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 120_000, 1000),
  });
  assert.equal(after.stoppedBecause, "no_runnable_tasks", after.stoppedBecause);
  assert.equal(after.tasks.length, 0, "막힌 그래프에서 task를 시작했다");
  assert.equal(taskOf(f.ws, "down").state, "blocked", "막힌 하류가 실행됐다");
  assert.equal(taskOf(f.ws, "up").state, "blocked", "막힌 상류가 실행됐다");

  // **`blocked`는 종료 상태다**(`isTerminal` — completed·blocked·cancelled). 그래서 차단된 상류를
  // autopilot이 스스로 되살리는 경로는 **없고** `resumeTask`도 거부한다(`paused`만 받는다). 이것이
  // 계약이며, 여기서 "풀린다"고 적으면 그것이 과대주장이다 — 막힌 그래프는 **사람이 새 run을 만든다**.
  assert.equal(
    codeOfThrow(() => reopen(f.ws).resumeTask({ taskId: "up", actionId: "act.unblock" })),
    "invalid_transition",
    "종료 상태인 blocked가 되살아났다",
  );
  // 반복 실행이 상태를 흔들지 않는다(멱등하게 같은 곳에 멈춘다).
  const again = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 300_000, 1000),
  });
  assert.equal(again.stoppedBecause, "no_runnable_tasks");
  assert.equal(taskOf(f.ws, "up").state, "blocked");
  assert.equal(taskOf(f.ws, "down").state, "blocked");
});

/** 던질 것으로 기대하는 호출의 안정 코드(던지지 않으면 그것 자체가 실패다). */
function codeOfThrow(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${String(e)}`;
  }
}

test("[M10-T2] context rotation: 프로세스를 다시 띄워도 같은 durable에서 같은 snapshot digest가 나온다", async () => {
  const f = boot({}, ["root", "sibling"]);
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const plan = { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } };
  writePlan(f.planDir, "root", plan);
  writePlan(f.planDir, "sibling", plan);

  // 1차 실행(= 한 coordinator 수명) 뒤 digest를 찍는다.
  await pilot(f);
  const first = reopen(f.ws).snapshotDigest();
  const bundle = reopen(f.ws).contextBundle("sibling");

  // **회전**: 새 프로세스를 흉내내 kernel을 완전히 다시 열고 같은 것을 다시 계산한다. bundle은 durable의
  // 순수 파생물이므로 시각·revision이 섞이면 여기서 갈린다(M6 계약).
  const rotated = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000, 7) });
  assert.deepEqual(rotated.snapshotDigest(), first, "재열기가 다른 digest를 냈다(회전이 문맥을 바꿨다)");
  assert.equal(rotated.contextBundle("sibling"), bundle, "재열기가 다른 context bundle을 냈다");

  // 회전 뒤 **재실행이 앞선 결과를 덮거나 중복 발행하지 않는다**. (첫 실행이 두 task를 이미 완주시켰으므로
  // 이 재실행은 유휴 실행이다 — 여기서 증명되는 것은 "재실행이 중복·유실을 만들지 않는다"까지이고
  // "회전 뒤 새 진행이 앞을 덮지 않는다"는 더 넓은 주장은 하지 않는다.)
  const second = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 1_000_000, 1000),
  });
  assert.equal(second.blocked, null);
  const k = reopen(f.ws);
  assert.equal(k.getState().messages.filter((m) => m.type === "result").length, 2, "회전 뒤 결과가 유실·중복됐다");
});

test("[M10-T2] 요약 변질: 실행 사이 durable 원문이 바뀌면 다음 실행이 시작조차 하지 못한다 (fail closed)", async () => {
  for (const target of ["body", "state"] as const) {
    const f = boot();
    writeOutput(f.ws, "docs/out.md", "# 산출물\n");
    writePlan(f.planDir, "root", { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } });
    await pilot(f);
    assert.equal(taskOf(f.ws, "root").state, "completed", "전제(완료된 run)가 성립하지 않았다");

    const paths = runPaths(f.ws, RUN_ID);
    if (target === "body") {
      // 중앙이 옮긴 **요약의 원문**(message body)을 사람이 몰래 고친다.
      const entry = reopen(f.ws).getState().messages.find((m) => m.type === "result");
      const file = join(paths.dir, entry!.bodyPath);
      writeFileSync(file, `${readFileSync(file, "utf8")}\n## Result Summary\n\n위조된 한 줄.\n`);
    } else {
      // state의 요약 필드만 바꾼다(문법은 여전히 유효하다).
      const raw = JSON.parse(readFileSync(paths.stateFile, "utf8"));
      raw.messages[raw.messages.length - 1].summary = "위조된 요약";
      writeFileSync(paths.stateFile, JSON.stringify(raw));
    }

    const report = await runAutopilot({
      workspaceRoot: f.ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      planDir: f.planDir,
      clock: clockFrom(T0 + 300_000, 1000),
    });
    // **시작조차 하지 못한다**: task를 하나도 건드리지 않고 run 수준에서 거부된다.
    assert.equal(report.blocked, "run_unavailable", `${target}: 변조된 run이 진행됐다`);
    assert.equal(report.tasks.length, 0, `${target}: 변조된 run에서 task를 건드렸다`);
    assert.equal(
      report.stoppedBecause,
      target === "body" ? "message_body_hash_mismatch" : "state_event_binding_mismatch",
      `${target}: ${report.stoppedBecause}`,
    );
  }
});

test("[M10-T2] durable 결과 본문은 실제로 집행한 operation을 적는다 (고정 문구 금지)", async () => {
  // 이전 판은 이 절을 **"typed operation은 집행하지 않았다"로 고정**해 두었다. M5c에서는 참이었지만
  // M5d task 2가 집행을 연 뒤로는 **집행한 turn의 결과 본문에 남는 거짓 진술**이었다(사람이 읽는
  // durable 감사 산출물이므로 과대주장 부류다).
  const f = boot({ operationAuthorityByTask: { root: [{ authorityId: "auth-1", kind: "write_file", path: "docs/x.md", maxBytes: 64 }] } });
  writeOutput(f.ws, "docs/x.md", "same\n");
  const same = createHash("sha256").update("same\n").digest("hex");
  writePlan(f.planDir, "root", {
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "auth-1", path: "docs/x.md", content: "same\n", expectedBeforeSha256: same },
    ],
    result: { summary: "멱등 쓰기 1건", outputs: [{ path: "docs/x.md", role: "output" }] },
  });
  const report = await pilot(f);
  assert.equal(report.tasks[0].state, "completed", JSON.stringify(report.tasks));

  const k = reopen(f.ws);
  const entry = k.getState().messages.find((m) => m.type === "result");
  const body = readFileSync(join(runPaths(f.ws, RUN_ID).dir, entry!.bodyPath), "utf8");
  assert.ok(!body.includes("집행하지 않았다"), `집행한 turn의 본문이 집행하지 않았다고 적었다:\n${body}`);
  // **영수증에서 파생한다**: 계획이 아니라 실제 결과(marker)를 적는다(리뷰 B1).
  assert.match(body, /typed operation 1건을 집행했다 — 영수증: write_file→already_applied×1/, body);
  // 원문·계측값은 여전히 새지 않는다(kind는 닫힌 enum · 개수는 정수뿐).
  assert.ok(!body.includes("same\n"), "본문에 쓰기 내용이 새어 들어갔다");
  assert.ok(!/token|사용량/i.test(body), "본문에 계측값이 새어 들어갔다");

  // operation이 없는 turn은 여전히 그렇게 적는다(반대 방향도 참이어야 한다).
  const g = boot();
  writePlan(g.planDir, "root", { result: { summary: "operation 없음", outputs: [] } });
  await pilot(g);
  const gk = reopen(g.ws);
  const gEntry = gk.getState().messages.find((m) => m.type === "result");
  const gBody = readFileSync(join(runPaths(g.ws, RUN_ID).dir, gEntry!.bodyPath), "utf8");
  assert.match(gBody, /typed operation을 집행하지 않았다\(이 계획에 operation이 없다\)/, gBody);
});

// ── ⑪ V3 M10 T3 — 무인 loop 소유권 (대장 B-32) ──────────────────────────────

test("[M10-T3] 같은 run에 controller가 둘 붙지 못한다 — 살아 있는 lease는 훔치지 않는다 (B-32)", async () => {
  const f = boot();
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  writePlan(f.planDir, "root", { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } });

  // **첫 controller가 도는 중에 두 번째를 실제로 부른다.** 관측 barrier는 첫 task의 진행 이벤트다.
  // 같은 프로세스지만 lease는 **파일**이므로 두 번째 진입은 같은 판정을 받는다(우리 pid는 살아 있다).
  // 두 번째 진입은 **배열**에 담는다(C-101): closure 안에서만 대입되는 `let`은 TS 흐름 분석이
  // `null`로 좁힌 채로 남아 `await` 결과가 `never`가 된다 — 단정이 아니라 타입만 죽는 자리였다.
  // 배열이면 좁힘 문제가 없고, 길이 단정이 "정확히 한 번 걸렸다"까지 고정한다(원래보다 강하다).
  const seconds: Promise<Awaited<ReturnType<typeof runAutopilot>>>[] = [];
  const first = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    onEvent: (e) => {
      if (e.kind !== "task_progress" || seconds.length > 0) return;
      seconds.push(
        runAutopilot({
          workspaceRoot: f.ws,
          runId: RUN_ID,
          milestoneId: MILESTONE,
          planDir: f.planDir,
          clock: clockFrom(T0 + 200_000, 1000),
        }),
      );
    },
  });
  assert.equal(first.blocked, null, first.blocked ?? "");
  assert.equal(seconds.length, 1, "관측 barrier가 걸리지 않았다(전제 실패)");
  const concurrent = await seconds[0];
  assert.equal(concurrent.blocked, "controller_active", `동시 controller가 붙었다: ${concurrent.blocked}`);
  assert.equal(concurrent.tasks.length, 0, "거부된 controller가 task를 건드렸다");
  // 첫 실행은 그 방해로 망가지지 않았다(거부는 두 번째만 받는다).
  assert.ok(first.tasks.some((t) => t.state === "completed"), JSON.stringify(first.tasks));

  // 첫 실행이 끝났으니 lease는 놓였다 — 두 번째 실행은 정상적으로 돈다.
  const paths = runPaths(f.ws, RUN_ID);
  assert.ok(!existsSync(paths.controllerLeaseFile), "실행이 끝났는데 lease가 남았다");

  // **살아 있는 소유자**의 lease를 심으면 시작조차 못 한다(우리 pid는 살아 있다).
  writeFileSync(paths.controllerLeaseFile, `${JSON.stringify({ nonce: "d".repeat(32), pid: process.pid })}\n`);
  const refused = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 300_000, 1000),
  });
  assert.equal(refused.blocked, "controller_active", refused.blocked ?? "");
  assert.equal(refused.tasks.length, 0, "거부된 controller가 task를 건드렸다");
  assert.equal(refused.stoppedBecause, "run_lock_held", refused.stoppedBecause);

  // **죽은 소유자**의 lease는 회수한다(존재하지 않는 pid를 골라 쓴다 — ESRCH 관측만이 근거다).
  let dead = 4_000_000;
  for (;;) {
    try {
      process.kill(dead, 0);
      dead -= 1;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") break;
      dead -= 1;
    }
  }
  writeFileSync(paths.controllerLeaseFile, `${JSON.stringify({ nonce: "e".repeat(32), pid: dead })}\n`);
  const reclaimed = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 400_000, 1000),
  });
  assert.notEqual(reclaimed.blocked, "controller_active", "죽은 controller의 lease가 run을 영구 차단했다");
  assert.ok(!existsSync(paths.controllerLeaseFile), "회수한 lease를 놓지 않았다");

  // 소유자 미상(형태가 아닌 파일)은 회수하지 않는다 — 미상을 근거로 삼지 않는다.
  writeFileSync(paths.controllerLeaseFile, "다른 도구가 만든 lease\n");
  const unknown = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 500_000, 1000),
  });
  assert.equal(unknown.blocked, "controller_active", "미상 소유자의 lease를 회수했다");
});

// ── ⑫ V3 M10 T3 — live worker backend (승인·계약 층 · LLM 0회) ───────────────
//
// **실제 프로세스를 띄우지만 LLM은 부르지 않는다**: 승인 manifest가 못 박는 실행 파일을 우리가 쓴
// 스크립트로 두고 digest를 승인에 넣는다. 그래서 이 절이 증명하는 것은 "**승인된 그 프로그램만**
// 돌고, 그 출력이 offline backend와 **같은 검증기**를 지나야 효과를 낸다"이며 모델 품질이 아니다.

/** 승인에 넣을 수 있는 worker 실행 파일 하나를 만든다(내용 digest까지). */
/**
 * **승인된 격리 `CLAUDE_CONFIG_DIR`**(V3 M11 · 대장 `C-86`). 계약은 "정규·비symlink·0700·이 프로세스
 * 소유·사용자 홈 아님·**비어 있지 않음**"이다 — 비어 있으면 로그인이 없다는 뜻이므로
 * `claude_config_not_logged_in`이다. 실제 자격증명을 넣지 않는 이유: 계약은 **내용을 열지 않는다**.
 */
function fakeClaudeHome(): { path: string } {
  const dir = realpathSync(makeDir("m11-claude-home-"));
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, ".credentials.json"), "{}\n", { mode: 0o600 });
  return { path: dir };
}

function fakeWorkerBin(body: string): { path: string; sha256: string } {
  // macOS의 `/var/folders/...`는 symlink 뒤에 있다 — 승인 경계는 **정규 경로**를 요구한다(M9 실측).
  const dir = realpathSync(makeDir("m10-worker-bin-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, body, { mode: 0o700 });
  return { path: file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
}

/** stdin 프롬프트를 무시하고 고정 계획을 CLI 봉투 형식으로 낸다. */
const PLAN_EMITTER = (plan: string, usage = '{"input_tokens":11,"output_tokens":22}'): string =>
  // shebang이 필요하다: 승인 경계는 **실행 파일**을 spawn하므로 `.mjs` 원문은 `ENOEXEC`다.
  // 절대 경로 node를 쓰는 이유는 M9 live 함정과 같다(`/usr/bin`에 node가 없는 환경이 있다).
  `#!${process.execPath}\nimport { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nprocess.stdout.write(JSON.stringify({ result: ${JSON.stringify(plan)}, usage: ${usage} }));\n`;

test("[M10-T3] live backend는 승인된 실행 파일만 돌리고 그 계획도 같은 검증기를 지난다", async () => {
  const good = fakeWorkerBin(
    PLAN_EMITTER('설명을 먼저 적는다.\n{"operations": [], "result": {"summary": "live worker가 낸 계획", "outputs": [{"path": "docs/out.md", "role": "output"}]}}'),
  );
  const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: good, claudeHome: fakeClaudeHome(), node: EXECUTION_AUTHORITY.node } });
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");

  // 계획 파일이 **없어도** 돈다 — live backend에서는 계획을 모델이 만든다.
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
    maxIterations: 1,
  });
  assert.deepEqual(
    report.tasks.map((t) => `${t.taskId}:${t.state}`),
    ["root:completed"],
    JSON.stringify(report),
  );
  const k = reopen(f.ws);
  assert.equal(k.getState().messages.filter((m) => m.type === "result")[0]?.summary, "live worker가 낸 계획");
  // **보고된 사용량이 durable 회계에 들어간다** — 0으로 적으면 토큰 예산이 공허해진다.
  assert.equal(k.getAccounting().tokensUsed, 33, JSON.stringify(k.getAccounting()));
});

test("[M10-T3] 승인에 worker 실행 파일이 없으면 live backend는 시작조차 하지 않는다", async () => {
  const f = boot(); // `claude` 키 없는 승인
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
  });
  assert.equal(report.blocked, "run_unavailable");
  assert.equal(report.stoppedBecause, "worker_backend_unapproved", report.stoppedBecause);
  assert.equal(report.tasks.length, 0, "승인 없는 live backend가 task를 건드렸다");
});

test("[M10-T3] 승인된 실행 파일이 승인 뒤에 바뀌면 spawn하지 않는다 (digest 재검증)", async () => {
  const bin = fakeWorkerBin(PLAN_EMITTER('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: bin, claudeHome: fakeClaudeHome() } });
  // 승인 뒤 **같은 경로의 내용**을 바꾼다(제자리 덮어쓰기).
  writeFileSync(bin.path, PLAN_EMITTER('{"operations": [], "result": {"summary": "바뀐 프로그램", "outputs": []}}'), { mode: 0o700 });
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
  });
  assert.equal(report.stoppedBecause, "worker_digest_mismatch", report.stoppedBecause);
  assert.equal(reopen(f.ws).getState().messages.filter((m) => m.type === "result").length, 0, "바뀐 프로그램의 산출물이 발행됐다");
});

test("[M10-T3] 계획 계약 밖 출력은 산출물로 승격되지 않는다 (가짜 tool-use 텍스트 포함)", async () => {
  for (const [label, out] of [
    ["계획 없음", "이 작업은 제가 직접 파일을 읽어 처리했습니다."],
    ["가짜 도구 호출", '<invoke name="Read"><parameter name="file_path">/etc/passwd</parameter></invoke>'],
    ["승인 밖 operation", '{"operations": [{"operationId": "op-x", "kind": "write_file", "authorityId": "not-approved", "path": "/etc/hosts", "content": "x", "expectedBeforeSha256": null}], "result": {"summary": "몰래 쓴다", "outputs": []}}'],
  ] as const) {
    const bin = fakeWorkerBin(PLAN_EMITTER(out));
    const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: bin, claudeHome: fakeClaudeHome() } });
    const report = await runAutopilot({
      workspaceRoot: f.ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      planDir: f.planDir,
      clock: f.clock,
      workerBackend: "claude-plan",
      maxIterations: 1,
    });
    assert.equal(report.tasks[0]?.state, "paused", `${label}: ${JSON.stringify(report.tasks)}`);
    const k = reopen(f.ws);
    assert.equal(k.getState().artifacts.length, 0, `${label}: 계약 밖 출력이 artifact를 만들었다`);
    assert.equal(k.getState().messages.filter((m) => m.type === "result").length, 0, `${label}: 결과가 발행됐다`);
    assert.equal(existsSync("/etc/hosts.harness-test"), false);
  }
});

test("[M10-T3] live worker 세션이 상한을 넘기면 죽이고 turn을 완료로 만들지 않는다", async () => {
  // 절대 끝나지 않는 프로그램. 세션 상한은 **승인된** `maxAttemptElapsedMs`에서 나온다(호출자가 못 고른다).
  const hang = fakeWorkerBin(`#!${process.execPath}\nimport { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nsetInterval(() => {}, 1000);\n`);
  const f = boot({
    executionAuthority: { ...EXECUTION_AUTHORITY, claude: hang, claudeHome: fakeClaudeHome() },
    autopilotPolicy: { ...POLICY, maxAttemptElapsedMs: 1_000 },
  });
  const startedAt = process.hrtime.bigint();
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
    maxIterations: 1,
  });
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  assert.equal(report.tasks[0]?.state, "paused", JSON.stringify(report.tasks));
  // **무엇이 끊었는지**를 그대로 고정한다(실측): 끝없는 세션을 끊은 것은 worker 내부 timeout이 아니라
  // **kernel의 attempt wall deadline**이다 — 스트림 이벤트 사이에서 주입 시계로 판정하기 때문이다.
  // spawn 실패로 빨리 끝난 것을 "상한이 집행됐다"로 읽으면 공허하므로 marker를 못 박는다.
  // worker 자체의 세션 timeout은 `livePlanWorker.test.ts`가 모듈 단위로 따로 고정한다.
  assert.equal(report.tasks[0]?.marker, "wall_deadline_exceeded", JSON.stringify(report.tasks));
  assert.equal(reopen(f.ws).getState().messages.filter((m) => m.type === "result").length, 0);
  assert.ok(elapsedMs < 30_000, `끝없는 세션이 bounded 시간에 끝나지 않았다(경과 ${elapsedMs}ms)`);
});

// ── ⑦ V3 M10 T7 — 승인 축 거부가 계획 무효로 위장하지 않는다 (`C-96` 부류) ──────
//
// T7 live에서 codex 리뷰어 3턴이 전부 `plan_invalid`로 pause했다. 실제 원인은 모델 출력이 아니라
// **승인된 격리 홈의 계약 거부**(`codex_home_not_empty`)였고, `workerMarker`가 `worker_` 접두사가 아닌
// 모든 코드를 `plan_invalid`로 접으면서 원인이 durable 감사 로그에서 사라졌다. 이 절은 그 위장을 막는다.
test("[M10-T7] 승인 축 거부는 `plan_invalid`로 위장하지 않는다 — 원인 코드가 그대로 올라온다", async () => {
  // 승인된 격리 홈에 **CLI가 만들지 않는** 항목을 하나 둔다 → `verifyCodexHome`이 거부한다.
  const home = realpathSync(makeDir("m10-t7-codex-home-"));
  chmodSync(home, 0o700);
  writeFileSync(join(home, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(home, "config.toml"), "model = \"x\"\n", { mode: 0o600 });

  const claudeBin = fakeWorkerBin(PLAN_EMITTER('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  const codexBin = fakeWorkerBin("#!/bin/sh\nexit 0\n");
  const f = boot(
    { executionAuthority: { ...EXECUTION_AUTHORITY, claude: claudeBin, claudeHome: fakeClaudeHome(), codex: codexBin, codexHome: { path: home } } },
    ["review-code"],
    1000,
    // 리뷰어 family → codex 갈래(`backendForRole`).
    `${CODEX_REVIEWER_ROLE_FAMILY}.code`,
  );

  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
    maxIterations: 1,
    onEvent: (e) => events.push(e),
  });

  assert.equal(report.tasks[0]?.state, "paused", JSON.stringify(report.tasks));
  // **핵심**: 계획을 받지도 못한 turn을 "계획이 무효다"로 적지 않는다.
  assert.notEqual(report.tasks[0]?.marker, "plan_invalid", "승인 축 거부가 계획 무효로 위장했다");
  assert.equal(report.tasks[0]?.marker, "worker_failed", JSON.stringify(report.tasks));
  // 그리고 **원인 코드가 실제로 보인다** — marker 집합이 담지 못하는 것을 detail이 싣는다.
  const paused = events.find((e) => e.kind === "task_paused" && e.taskId === "review-code");
  assert.equal(paused?.detail, "codex_home_not_empty", JSON.stringify(events));
  // 홈이 거부됐으므로 codex는 뜨지 않았고 결과도 발행되지 않았다(조용한 claude fallback이 없다).
  assert.equal(reopen(f.ws).getState().messages.filter((m) => m.type === "result").length, 0);
});

// ── ⑧ V3 M11 — 결정 4건 (C-86 자격증명 신원 · C-98 리뷰 왕복 강제) ───────────────

test("[M11/C-86] 신원을 승인하지 않은 run은 **ambient로 돌되 조용하지 않다**", async () => {
  // **사용자 결정(2026-08-23)**: `claudeHome`은 선택이다 — 없으면 이 기계에 로그인된 계정으로 돈다.
  // 그 선택 자체는 정당하지만 **침묵은 아니다**: 침묵이 곧 이 레포가 금지하는 "조용한 fallback"이다.
  // 그래서 이 테스트가 고정하는 것은 "돈다"가 아니라 **"돌면서 무엇으로 도는지 말한다"** 이다.
  const good = fakeWorkerBin(
    PLAN_EMITTER('{"operations": [], "result": {"summary": "ambient로 돌았다", "outputs": []}}'),
  );
  const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: good } }); // claudeHome 없음
  writeOutput(f.ws, "docs/out.md", "# 산출물\n");
  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
    maxIterations: 1,
    onEvent: (e) => events.push(e),
  });

  assert.equal(report.blocked, null, JSON.stringify(report));
  assert.equal(report.tasks[0]?.state, "completed", JSON.stringify(report.tasks));
  // **영수증이 말한다** — 나중에 "이 run이 누구 구독으로 돌았나"를 물으면 답이 있다.
  assert.equal(report.workerIdentity, "ambient", JSON.stringify(report));
  assert.deepEqual(
    events.filter((e) => e.kind === "worker_identity").map((e) => e.marker),
    ["ambient"],
    JSON.stringify(events.map((e) => e.kind)),
  );
});

test("[M11/C-86] 신원을 승인하면 그 사실도 영수증에 남는다(위 단정이 상수가 아니다)", async () => {
  // 대조군: 같은 자리가 `approved`로 바뀌어야 위 `ambient` 단정이 공허하지 않다.
  const good = fakeWorkerBin(PLAN_EMITTER('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: good, claudeHome: fakeClaudeHome() } });
  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
    maxIterations: 1,
    onEvent: (e) => events.push(e),
  });
  assert.equal(report.workerIdentity, "approved", JSON.stringify(report));
  assert.deepEqual(
    events.filter((e) => e.kind === "worker_identity").map((e) => e.marker),
    ["approved"],
  );
});

test("[M11/C-86] offline run은 이 축을 주장하지 않는다(물어볼 것이 없다)", async () => {
  const f = boot();
  writePlan(f.planDir, "root", {});
  const report = await pilot(f);
  assert.equal(report.workerIdentity, undefined, JSON.stringify(report));
});

test("[M11/C-86] 신원을 승인했는데 그 계약이 깨지면 전부 spawn 0이다(그때는 ambient로 물러서지 않는다)", async () => {
  const bin = fakeWorkerBin(PLAN_EMITTER('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  // **신원을 고정하지 않는 것과 고정했는데 깨진 것은 다르다**: 전자는 ambient로 돌고(위 테스트),
  // 후자는 **거부**다 — 승인이 말한 디렉터리가 계약 밖이면 ambient로 물러서는 것이 곧 조용한 fallback이다.
  const cases: [string, () => { path: string }, string][] = [
    [
      "비어 있다(= 로그인이 없다)",
      () => ({ path: (() => { const d = realpathSync(makeDir("m11-empty-")); chmodSync(d, 0o700); return d; })() }),
      "claude_config_not_logged_in",
    ],
    [
      "0700이 아니다",
      () => {
        const d = realpathSync(makeDir("m11-perm-"));
        writeFileSync(join(d, ".credentials.json"), "{}\n", { mode: 0o600 });
        chmodSync(d, 0o755);
        return { path: d };
      },
      "claude_config_permissive",
    ],
    [
      "symlink다",
      () => {
        const real = realpathSync(makeDir("m11-real-"));
        chmodSync(real, 0o700);
        writeFileSync(join(real, ".credentials.json"), "{}\n", { mode: 0o600 });
        const link = join(realpathSync(makeDir("m11-link-")), "home");
        symlinkSync(real, link);
        return { path: link };
      },
      "claude_config_invalid",
    ],
    ["존재하지 않는다", () => ({ path: join(realpathSync(makeDir("m11-gone-")), "nope") }), "claude_config_invalid"],
  ];
  for (const [label, mk, expected] of cases) {
    const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: bin, claudeHome: mk() } });
    const report = await runAutopilot({
      workspaceRoot: f.ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      planDir: f.planDir,
      clock: f.clock,
      workerBackend: "claude-plan",
    });
    assert.equal(report.stoppedBecause, expected, `${label}: ${report.stoppedBecause}`);
    // **결과가 발행되지 않았다** = 프로세스가 뜨지 않았다는 소비면 증거다.
    assert.equal(reopen(f.ws).getState().messages.filter((m) => m.type === "result").length, 0, label);
  }
});

test("[M11/C-98] 승인이 리뷰 왕복을 요구하면 verify는 계약을 통과해야만 완료된다", async () => {
  // 저자·수정자는 claude, 리뷰 3종 + verify는 codex여야 한다는 것이 왕복 계약이다.
  // **대조군을 같은 테스트에서 돌린다**: 리뷰어 하나를 저자와 같은 엔진으로 바꾸면 완주하지 못해야 한다.
  const ids = ["impl", "rev-code", "rev-sec", "rev-test", "revise", "verify"];
  const roundtrip = {
    author: "impl",
    reviews: { code: "rev-code", security: "rev-sec", test: "rev-test" },
    revision: "revise",
    verify: "verify",
  };
  for (const [label, reviewRole, expectVerify] of [
    ["정상 왕복", `${CODEX_REVIEWER_ROLE_FAMILY}.code`, "completed"],
    ["대조군: 리뷰어가 저자와 같은 엔진", "dev-lead", "paused"],
  ] as const) {
    const f = bootRoundtrip(ids, roundtrip, reviewRole);
    const events: AutopilotEvent[] = [];
    const report = await runAutopilot({
      onEvent: (e) => events.push(e),
      workspaceRoot: f.ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      planDir: f.planDir,
      clock: f.clock,
      maxIterations: 8,
    });
    const k = reopen(f.ws);
    const why = events.filter((e) => e.kind === "task_paused" && e.taskId === "verify").map((e) => e.detail);
    assert.equal(k.getTask("verify")?.state, expectVerify, `${label}: ${JSON.stringify(report.tasks)} why=${JSON.stringify(why)}`);
    if (expectVerify === "paused") {
      assert.equal(
        report.tasks.find((t) => t.taskId === "verify")?.marker,
        "review_invalid",
        `${label}: ${JSON.stringify(report.tasks)}`,
      );
      // 게이트가 막은 turn은 **결과를 발행하지 않는다**.
      assert.equal(k.getState().messages.filter((m) => m.type === "result" && m.taskId === "verify").length, 0, label);
    }
  }
});

test("[M11/C-98] 승인이 왕복을 요구하지 않으면 게이트는 돌지 않는다(있지도 않은 계약을 강요하지 않는다)", async () => {
  // 공허하지 않다는 반대 방향 증거: 같은 DAG·같은 role인데 `reviewRoundtrip`이 없으면 완주한다.
  const f = bootRoundtrip(["impl", "rev-code", "rev-sec", "rev-test", "revise", "verify"], null, "dev-lead");
  await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    maxIterations: 8,
  });
  assert.equal(reopen(f.ws).getTask("verify")?.state, "completed");
});

// ── ⑬ V3 M11 모델 축 — 승인된 모델 · argv · 영수증 ────────────────────────────
//
// **LLM 0회.** 승인 manifest가 못 박는 실행 파일 자리에 argv를 파일로 적는 스크립트를 둔다. 그래서 이
// 절이 증명하는 것은 "승인 문서의 모델이 **실제 자식 argv까지** 배선됐고 영수증이 그것을 정직하게
// 적는다"이며, **그 모델로 실제 추론이 돌았는지는 아니다**(그것은 live 축이고 여기서 증명되지 않는다).

/** argv를 파일로 적고 고정 계획을 CLI 봉투 형식으로 낸다. */
const ARGV_EMITTER = (out: string, plan: string): string =>
  `#!${process.execPath}\nimport { readFileSync, writeFileSync } from "node:fs";\nreadFileSync(0, "utf8");\n` +
  `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n` +
  `process.stdout.write(JSON.stringify({ result: ${JSON.stringify(plan)}, usage: null }));\n`;

const OK_PLAN = '{"operations": [], "result": {"summary": "ok", "outputs": []}}';

/** live run 1 iteration을 돌리고 자식이 받은 argv와 영수증을 함께 돌려준다. */
async function liveRun(
  over: Record<string, unknown>,
): Promise<{ report: Awaited<ReturnType<typeof runAutopilot>>; events: AutopilotEvent[]; argv: string[] }> {
  const out = join(realpathSync(makeDir("m11-model-argv-")), "argv.json");
  const bin = fakeWorkerBin(ARGV_EMITTER(out, OK_PLAN));
  const f = boot({ executionAuthority: { ...EXECUTION_AUTHORITY, claude: bin, ...over } });
  const events: AutopilotEvent[] = [];
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: f.clock,
    workerBackend: "claude-plan",
    maxIterations: 1,
    onEvent: (e) => events.push(e),
  });
  return { report, events, argv: JSON.parse(readFileSync(out, "utf8")) as string[] };
}

test("[M11/모델축] 승인이 모델을 말하면 argv에 --model이 실리고 영수증이 그 값을 적는다", async () => {
  const { report, events, argv } = await liveRun({ claudeHome: fakeClaudeHome(), claudeModel: "claude-opus-5[1m]" });
  assert.equal(report.blocked, null, JSON.stringify(report));
  assert.equal(report.tasks[0]?.state, "completed", JSON.stringify(report.tasks));
  // ⓐ **승인 → argv**: 이 단정이 red면 승인 문서가 모델을 말해도 세션은 CLI 기본 모델로 돈다.
  assert.deepEqual(argv.slice(-2), ["--model", "claude-opus-5[1m]"], JSON.stringify(argv));
  // ⓒ **영수증**: 승인된 모델은 `approved` + 그 문자열이다.
  assert.deepEqual(report.workerModel, { marker: "approved", model: "claude-opus-5[1m]" }, JSON.stringify(report));
  assert.deepEqual(
    events.filter((e) => e.kind === "worker_model").map((e) => [e.marker, e.detail]),
    [["approved", "claude-opus-5[1m]"]],
    JSON.stringify(events),
  );
});

test("[M11/모델축] 승인이 모델을 말하지 않으면 --model이 실리지 않고 영수증이 cli_default라고 적는다", async () => {
  const { report, events, argv } = await liveRun({ claudeHome: fakeClaudeHome() }); // claudeModel 없음
  assert.equal(report.tasks[0]?.state, "completed", JSON.stringify(report.tasks));
  // ⓑ **조용한 기본값 주입 금지**: 승인이 말하지 않았으면 argv에 그 flag가 없다.
  assert.equal(argv.includes("--model"), false, `승인 밖 모델이 argv에 실렸다: ${JSON.stringify(argv)}`);
  // ⓒ **모르는 것을 안다고 적지 않는다**: `model`은 `null`이다(CLI 기본값이 무엇인지 harness는 모른다).
  assert.deepEqual(report.workerModel, { marker: "cli_default", model: null }, JSON.stringify(report));
  const ev = events.find((e) => e.kind === "worker_model");
  assert.equal(ev?.marker, "cli_default", JSON.stringify(events));
  assert.equal(ev?.detail, undefined, "모르는 모델 이름이 이벤트에 적혔다");
  // **두 경우가 같은 값으로 적히지 않는다**: 위 테스트의 `approved`와 형태부터 다르다.
  assert.notDeepEqual(report.workerModel, { marker: "approved", model: "claude-opus-5[1m]" });
});

test("[M11/모델축] 모델 축은 자격증명 축과 독립이다(claudeHome 없이도 모델만 고정할 수 있다)", async () => {
  // 두 축을 한 값으로 묶지 않는다 — `claudeHome`은 사용자 결정으로 선택이고(2026-08-23) 모델 축이
  // 그 결정을 되돌리지 않는다. 영수증은 **둘을 따로** 적는다.
  const { report, argv } = await liveRun({ claudeModel: "sonnet" });
  assert.equal(report.workerIdentity, "ambient", JSON.stringify(report));
  assert.deepEqual(report.workerModel, { marker: "approved", model: "sonnet" }, JSON.stringify(report));
  assert.deepEqual(argv.slice(-2), ["--model", "sonnet"]);
});

test("[M11/모델축] offline run은 모델 축을 주장하지 않는다(물어볼 것이 없다)", async () => {
  const f = boot();
  writePlan(f.planDir, "root", {});
  const report = await pilot(f);
  assert.equal(report.workerModel, undefined, JSON.stringify(report));
});
