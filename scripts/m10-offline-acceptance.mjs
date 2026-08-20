/**
 * V3 M10 T1·T2 offline acceptance — resume/crash recovery + 통합 시나리오 (acceptance Test 22).
 *
 * ## 무엇을 증명하는가
 * - ① **관측된 정리는 확인으로 적는다**: 실제 프로세스가 deadline으로 죽어도 `superviseProcess`가 그룹
 *   소멸을 **관측했으면** `confirmCleanup`이 맞다 → task는 복구 가능한 `paused`로 착지한다.
 *   (T1 적대적 리뷰 A1: 이것을 미관측으로 오판하면 정상 timeout·취소가 run을 영구 격리시킨다.)
 * - ② **관측하지 못한 정리는 확인으로 적지 않는다**: 영수증 커밋 **뒤**·종료 기록 **전**에 controller를
 *   실제 SIGKILL하면, 재시작한 controller는 프로세스 kind의 `outcome_unknown`을 보고 **격리**한다 —
 *   durable에 `cleanup_confirmed`(= survivors 0)를 적지 않는다.
 * - ③ **죽은 writer의 lock이 재시작을 막지 않는다**(`C-8`·`C-4` 보강): 커밋 도중 SIGKILL이면 lock이
 *   남지만, 다음 열기가 **소유자 사망을 관측하고** 회수해 journal 규칙대로 정리한다.
 * - ④ **크래시 잔재가 정착하고 재개된다**(`C-55` 잔여): `running`+lease 잔재가 `controller_lost`로
 *   기록되고 정리 확인 뒤 새 attempt로 완주한다. 중복 결과·중복 artifact가 없다.
 * - ⑤ **부분 물질화가 벽돌이 아니다**(`C-76`): 같은 문서로 이어받아 완성되고, 다른 문서는 여전히 거부된다.
 * - ⑥ **T2 통합 시나리오**: 사람 결정 gate(red→green 왕복) · context rotation 등가 · 의존성 실패의
 *   하류 표시와 loop 정지 · 실행 사이 원문 변조의 fail-closed 거부. 한 run에서 순서대로 일어난다.
 *
 * ## 증명하지 않는다 (정직하게 적는다)
 * - **live LLM 0회.** worker는 offline plan 백엔드다.
 * - **좌초 프로세스를 실제로 찾아 거두는 것**: 이 아키텍처에는 lease marker로 프로세스를 찾는 관측자가
 *   없다(durable에 PID/PGID가 없고 `MANAGED_PROCESS_ENV`도 닫혀 있다). ②가 증명하는 것은 "찾지 못하면
 *   확인했다고 적지 않는다"이며, **격리된 run은 사람이 판단해야 한다**.
 * - **`process_cleanup_unconfirmed`(supervisor가 그룹 소멸 관측에 실패하는 경로) 자체**는 자손을
 *   유예 안에서 죽지 않게 만들어야 재현되므로 이 스크립트가 만들지 않는다 — 그 분기의 판정은 focused
 *   테스트가 durable 증거로 고정한다(`src/commands/autopilot.test.ts` M10 절).
 * - **동시 controller 2대**(살아 있는 controller의 잔재를 크래시로 오판하는 경로)는 범위 밖이다 — 대장에 등록했다.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { OrchestrationKernel, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runPaths } = await import(join(REPO_ROOT, "src/exec/orchestrationStore.ts"));
const { REQUIRED_BODY_HEADINGS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));
const { materializeTaskDag } = await import(join(REPO_ROOT, "src/exec/taskDagMaterialize.ts"));
const { runAutopilot } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const dirs = [];
function makeDir(prefix) {
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

const RUN_ID = "m10-run";
const MILESTONE = "m10";
const T0 = Date.parse("2026-08-19T00:00:00.000Z");
const ASSIGNMENT_BODY = REQUIRED_BODY_HEADINGS.task_assignment.map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function baseManifest(over = {}) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask: { root: ["docs", "src"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: "/opt/harness/controller.js", sha256: "b".repeat(64) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 600_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...over,
  };
}

function seedRoot(kernel, taskId = "root") {
  kernel.createRootTask({
    taskId,
    roleId: "tech-lead",
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: ["docs", "src"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: ASSIGNMENT_BODY,
  });
}

function clockFrom(startMs, stepMs = 1000) {
  let n = 0;
  return () => new Date(startMs + stepMs * n++);
}

function writePlan(planDir, taskId, plan) {
  writeFileSync(
    join(planDir, `${taskId}.json`),
    JSON.stringify({ operations: plan.operations ?? [], result: plan.result ?? { summary: `${taskId} 완료`, outputs: [] } }),
  );
}

function eventLog(ws) {
  const file = runPaths(ws, RUN_ID).eventsFile;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function taskOf(ws, taskId, clock) {
  return openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clock ?? clockFrom(T0 + 900_000) }).getTask(taskId);
}

/**
 * **실제 프로세스를 띄우는 run_process 승인**을 갖춘 run 하나. entrypoint는 우리가 쓴 스크립트이고
 * digest가 승인 레코드에 박히므로 다른 프로그램을 실행할 통로가 없다(action은 닫힌 enum이다).
 */
function bootWithRealProcess({ sleepMs, timeoutMs }) {
  const ws = makeDir("m10-proc-ws-");
  const planDir = makeDir("m10-proc-plans-");
  mkdirSync(join(ws, "docs"), { recursive: true });
  const entrypoint = join(makeDir("m10-proc-bin-"), "controller.mjs");
  // `validate-plan` action이 받는 인자는 승인 레코드의 planPath 하나다(argv를 고를 통로가 없다).
  writeFileSync(entrypoint, `setTimeout(() => process.exit(0), ${sleepMs});\n`);
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({
      executionAuthority: {
        ...baseManifest().executionAuthority,
        node: { path: process.execPath, sha256: sha256Of(process.execPath) },
        controllerEntrypoint: { path: entrypoint, sha256: sha256Of(entrypoint) },
      },
      operationAuthorityByTask: {
        root: [{ authorityId: "proc-1", kind: "run_process", action: "validate-plan", data: { planPath: "docs/plan.json" }, timeoutMs }],
      },
    }),
    clock: clockFrom(T0),
  });
  seedRoot(kernel);
  writePlan(planDir, "root", {
    // 계획의 operation key 집합은 `{operationId, kind, authorityId}` 셋뿐이다 — action·경로·argv는
    // **승인 레코드**에서만 나온다(계획이 실행 대상을 고를 통로가 없다).
    operations: [{ operationId: "op-1", kind: "run_process", authorityId: "proc-1" }],
    result: { summary: "프로세스를 돌린다", outputs: [] },
  });
  return { ws, planDir, entrypoint };
}

console.log("① 관측된 정리는 확인으로 적는다 — 실제 프로세스 deadline은 run을 격리하지 않는다 (리뷰 A1)");
{
  // 5초 자는 프로세스에 150ms deadline → supervisor가 SIGTERM/KILL로 거두고 **그룹 소멸을 관측**한 뒤
  // `process_deadline_exceeded`로 던진다. 영수증은 `outcome_unknown`(효과를 모른다)이지만 **정리는 관측됐다**.
  const f = bootWithRealProcess({ sleepMs: 5_000, timeoutMs: 150 });
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 1,
  });
  const task = taskOf(f.ws, "root");
  const receipts = task.execution.operationReceipts.map((r) => `${r.kind}:${r.marker}`);
  check("실제 프로세스가 deadline으로 종료됐다(효과 미확정 영수증)", receipts.join(",") === "run_process:outcome_unknown", receipts.join(","));
  check("정리를 관측했으므로 확인으로 적는다", task.execution.cleanupStatus === "confirmed", task.execution.cleanupStatus);
  check("정상 timeout이 run을 격리하지 않는다(복구 가능한 paused)", task.state === "paused", `${task.state}/${report.stoppedBecause}`);
  check("loop 정지 사유가 관측 불가가 아니다", report.stoppedBecause !== "cleanup_unobservable", report.stoppedBecause);
  check("사람이 그대로 재개할 수 있다", openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) }).resumeTask({ taskId: "root", actionId: "act.resume" }).state === "ready");
}

console.log("\n② 관측하지 못한 정리는 확인으로 적지 않는다 — 영수증 뒤·종료 기록 전 SIGKILL");
const CRASH_AUTOPILOT_CHILD = `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const [root, ws, planDir, runId] = process.argv.slice(2);
const url = (rel) => pathToFileURL(join(root, rel)).href;
const store = await import(url("src/exec/orchestrationStore.ts"));
const { runAutopilot } = await import(url("src/commands/autopilot.ts"));
const stateFile = store.runPaths(ws, runId).stateFile;
// **영수증이 durable에 착지한 뒤 첫 state 발행에서 죽는다** = 종료 기록(recordTerminal) 커밋이다.
// 판정 근거는 디스크의 현재 state뿐이다(그 시점에 새 state는 아직 tmp에 있다).
store.setCommitFaultHook((stage) => {
  if (stage !== "state:rename") return;
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const landed = state.tasks.some((t) => t.execution.operationReceipts.length > 0);
  if (landed) process.kill(process.pid, "SIGKILL");
});
await runAutopilot({
  workspaceRoot: ws,
  runId,
  milestoneId: ${JSON.stringify(MILESTONE)},
  planDir,
  clock: (() => { let n = 0; return () => new Date(${T0} + 60000 + 1000 * n++); })(),
  maxIterations: 1,
});
process.exit(0);
`;
{
  const f = bootWithRealProcess({ sleepMs: 20, timeoutMs: 5_000 });
  const childFile = join(makeDir("m10-crash-child-"), "crash.mjs");
  writeFileSync(childFile, CRASH_AUTOPILOT_CHILD);
  const tsx = join(REPO_ROOT, "node_modules/.bin/tsx");
  const child = spawnSync(tsx, [childFile, REPO_ROOT, f.ws, f.planDir, RUN_ID], { encoding: "utf8", timeout: 120_000 });
  // tsx는 래퍼라 안쪽 node의 SIGKILL이 `137`로 올라온다 — 둘 다 "신호로 죽었다"는 같은 사실이다.
  check("controller가 실제로 SIGKILL로 죽었다", child.signal === "SIGKILL" || child.status === 137, `status=${child.status} signal=${child.signal} ${child.stderr ?? ""}`);
  const paths = runPaths(f.ws, RUN_ID);
  check("커밋 도중 죽어 writer lock이 남았다(전제)", existsSync(paths.lockFile));

  const before = eventLog(f.ws).length;
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: clockFrom(T0 + 300_000),
    maxIterations: 1,
  });
  const added = eventLog(f.ws).slice(before).map((e) => e.type);
  const task = taskOf(f.ws, "root");
  check("③ 죽은 writer의 lock을 회수해 재시작이 열린다", task !== null && !existsSync(paths.lockFile));
  check("관측하지 못한 정리를 확인으로 적지 않는다", !added.includes("cleanup_confirmed"), added.join(","));
  check("관측 실패를 durable에 적는다(cleanup_failed)", added.includes("cleanup_failed"), added.join(","));
  check("자원을 놓지 않고 격리한다(cleaning 유지)", task.state === "cleaning", task.state);
  check("loop가 조용히 진행하지 않고 멈춘다", report.stoppedBecause === "cleanup_unobservable", report.stoppedBecause);
}

console.log("\n④ 크래시 잔재가 정착하고 새 attempt로 재개된다 (C-55 잔여)");
{
  const ws = makeDir("m10-resume-ws-");
  const planDir = makeDir("m10-resume-plans-");
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs/out.md"), "# 산출물\n");
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest(),
    clock: clockFrom(T0),
  });
  seedRoot(kernel);
  writePlan(planDir, "root", { result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } });

  // turn 시작 뒤 시계를 되돌린다 → 다음 kernel 호출이 거부되고 task는 lease를 쥔 채 남는다(크래시 등가).
  let started = false;
  let ticks = 0;
  const first = await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    clock: () => {
      ticks += 1;
      return started ? new Date(T0 - 3_600_000) : new Date(T0 + 60_000 + ticks * 1000);
    },
    onEvent: (e) => {
      if (e.kind === "task_started") started = true;
    },
  });
  const stranded = taskOf(ws, "root");
  check("크래시 등가 잔재가 lease를 쥐고 남았다(전제)", first.stoppedBecause === "turn_aborted" && stranded.execution.processLeaseMarker !== null, `${first.stoppedBecause}/${stranded.state}`);
  const deadAttempt = stranded.execution.attemptId;

  const events = [];
  const second = await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    clock: clockFrom(T0 + 120_000),
    onEvent: (e) => events.push(e),
  });
  const done = taskOf(ws, "root");
  check("관측한 사실을 그대로 적는다(controller_lost)", events.some((e) => e.marker === "controller_lost" && String(e.detail).startsWith("crash_settled")), JSON.stringify(events.map((e) => e.detail)));
  check("새 attempt로 재개해 완주한다", done.state === "completed" && done.execution.attemptId !== deadAttempt, `${done.state}/${second.stoppedBecause}`);
  const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  check("결과·artifact가 중복 발행되지 않았다", k.getState().messages.filter((m) => m.taskId === "root" && m.type === "result").length === 1 && k.getState().artifacts.length === 1);
  check("결정이 유실되지 않았다(정리 확인·재시도 예약이 감사 로그에 있다)", eventLog(ws).some((e) => e.type === "cleanup_confirmed") && eventLog(ws).some((e) => e.type === "retry_scheduled"));
}

console.log("\n⑤ 부분 물질화는 벽돌이 아니다 — 같은 문서로 이어받고 다른 문서는 거부한다 (C-76)");
{
  const ws = makeDir("m10-dag-ws-");
  const doc = {
    schemaVersion: "1",
    tasks: [
      { taskId: "impl-a", roleId: "dev-lead", title: "A 구현", scope: "src/a 안에서만", ownership: ["src/a"], dependsOn: [], provides: ["src/a/i.ts"] },
      { taskId: "impl-b", roleId: "dev-lead", title: "B 구현", scope: "src/b 안에서만", ownership: ["src/b"], dependsOn: [], provides: ["src/b/i.ts"] },
    ],
  };
  let n = 0;
  let ref = null;
  let frozen = false;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({ writableRoots: ["src"], ownershipByTask: { "impl-a": ["src/a"], "impl-b": ["src/b"] } }),
    clock: () => (!frozen && ref !== null && ref.getState().tasks.length >= 1 ? new Date(T0 - 3_600_000) : new Date(T0 + n++)),
  });
  ref = kernel;
  let partialCode = "no-error";
  try {
    materializeTaskDag(kernel, doc);
  } catch (e) {
    partialCode = e?.code ?? "unknown";
  }
  frozen = true;
  check("mid-loop 거부가 부분 물질화를 남긴다(전제)", partialCode === "clock_invalid" && kernel.getState().tasks.length === 1, `${partialCode}/${kernel.getState().tasks.length}`);

  const out = materializeTaskDag(kernel, doc);
  check("같은 문서로 이어받아 완성한다", kernel.getState().tasks.length === 2 && out.createdOrder.join(",") === "impl-b", out.createdOrder.join(","));
  check("이미 만든 task를 만들었다고 적지 않는다", !out.createdOrder.includes("impl-a"));
  check("멱등이다(다시 불러도 아무것도 만들지 않는다)", materializeTaskDag(kernel, doc).createdOrder.length === 0);

  const drifted = JSON.parse(JSON.stringify(doc));
  drifted.tasks.find((t) => t.taskId === "impl-a").provides = ["src/a/i.ts", "src/a/extra.ts"];
  let driftCode = "no-error";
  try {
    materializeTaskDag(kernel, drifted);
  } catch (e) {
    driftCode = e?.code ?? "unknown";
  }
  check("state 축 밖 필드만 바뀐 문서도 거부한다(assignment 본문 대조)", driftCode === "dag_materialize_run_not_empty", driftCode);
}

console.log("\n⑥ T2 통합 시나리오 — 사람 gate · 의존성 실패 · 변조 fail-closed (red-path 먼저)");
{
  const ws = makeDir("m10-t2-ws-");
  const planDir = makeDir("m10-t2-plans-");
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs/out.md"), "# 산출물\n");
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({ ownershipByTask: { up: ["docs", "src"], down: ["docs", "src"], tail: ["docs", "src"] } }),
    clock: clockFrom(T0),
  });
  seedRoot(kernel, "up");
  kernel.createDependentTask({
    taskId: "down",
    roleId: "tech-lead",
    title: "down 제목",
    scope: "down bounded scope",
    ownership: ["docs", "src"],
    assignmentMessageId: "asg-down",
    assignmentBody: ASSIGNMENT_BODY,
    dependsOn: ["up"],
  });
  // `down`의 하류를 하나 더 둔다 — 그래야 차단 **전파**(`dependency_blocked`)를 실제로 관측한다.
  kernel.createDependentTask({
    taskId: "tail",
    roleId: "tech-lead",
    title: "tail 제목",
    scope: "tail bounded scope",
    ownership: ["docs", "src"],
    assignmentMessageId: "asg-tail",
    assignmentBody: ASSIGNMENT_BODY,
    dependsOn: ["down"],
  });

  // ── 권한 요청: 답이 없으면 완료로 못 간다 ──
  writeFileSync(
    join(planDir, "up.json"),
    JSON.stringify({
      operations: [],
      requests: [{ kind: "request_decision", question: "계약을 바꿔야 하는가?", safeDefault: "현행 유지" }],
      result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] },
    }),
  );
  const asked = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock: clockFrom(T0 + 60_000), maxIterations: 1 });
  const askedTask = taskOf(ws, "up");
  check("결정 없이는 결과를 발행하지 못한다(사람 gate 우회 없음)", askedTask.state === "paused" && asked.tasks[0]?.marker === "decision_pending", `${askedTask.state}/${asked.tasks[0]?.marker}`);
  check("사람에게 물은 기록이 durable에 남는다", openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 90_000) }).getState().messages.filter((m) => m.type === "decision_request").length === 1);
  check("결정 대기 turn이 artifact를 발행하지 않았다", openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 90_000) }).getState().artifacts.length === 0);

  // 사람이 답한다 — **중앙 API로만** 가능하다(요청 union에 답 갈래가 없다).
  const answering = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 120_000) });
  answering.recordDecision({
    envelope: {
      schemaVersion: "1",
      messageId: "dec-up",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "up",
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
  answering.resumeTask({ taskId: "up", actionId: "act.resume" });
  writeFileSync(join(planDir, "up.json"), JSON.stringify({ operations: [], result: { summary: "완료", outputs: [{ path: "docs/out.md", role: "output" }] } }));

  // ── context rotation: 재열기가 같은 문맥을 낸다 ──
  const beforeBundle = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 150_000) }).contextBundle("down");
  const afterBundle = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 700_000, 13) }).contextBundle("down");
  check("회전(재열기)이 같은 context bundle을 낸다 — 시각이 섞이지 않는다", beforeBundle === afterBundle);

  const answered = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock: clockFrom(T0 + 200_000), maxIterations: 1 });
  check("결정 뒤에만 재개된다", answered.tasks.some((t) => t.taskId === "up" && t.state === "completed"), JSON.stringify(answered.tasks));

  // ── 의존성 실패: 상류가 막히면 하류에 이유가 남고 loop가 멈춘다 ──
  const lease = `lease.${"c".repeat(32)}`;
  const blocking = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 300_000) });
  const batch = blocking.planRunnableBatch();
  blocking.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: "act.pf2",
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared", attemptId: `att2.${t.taskId}` })),
  });
  blocking.startPreparedTask({ taskId: "down", actionId: "act.start2", leaseMarker: lease });
  blocking.recordTerminal({ taskId: "down", actionId: "act.term2", marker: "worker_failed" });
  blocking.confirmCleanup({ taskId: "down", actionId: "act.clean2", leaseMarker: lease });
  blocking.submitBlocker({
    envelope: {
      schemaVersion: "1",
      messageId: "blk-down",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "down",
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
    summary: "계약이 정해지지 않았다",
  });
  check("차단은 종료 상태다(autopilot이 스스로 되살리지 않는다)", taskOf(ws, "down").state === "blocked", taskOf(ws, "down").state);
  const tailBlocked = eventLog(ws)
    .filter((e) => e.type === "task_state_changed" && e.taskId === "tail" && e.toState === "blocked")
    .map((e) => e.reason);
  check(
    "차단이 의존 하류로 전파되고 **이유가 감사 로그에 남는다**",
    taskOf(ws, "tail").state === "blocked" && tailBlocked.join(",") === "dependency_blocked",
    `${taskOf(ws, "tail").state}/${tailBlocked.join(",")}`,
  );
  check(
    "종료 상태는 되살아나지 않는다(resumeTask 거부)",
    (() => {
      try {
        openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 350_000) }).resumeTask({ taskId: "down", actionId: "act.un" });
        return false;
      } catch (e) {
        return e?.code === "invalid_transition";
      }
    })(),
  );
  writeFileSync(join(planDir, "down.json"), JSON.stringify({ operations: [], result: { summary: "완료", outputs: [] } }));
  const stopped = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock: clockFrom(T0 + 400_000), maxIterations: 2 });
  check("막힌 그래프에서 loop가 조용히 진행하지 않는다", stopped.stoppedBecause === "no_runnable_tasks" && stopped.tasks.length === 0, `${stopped.stoppedBecause}/${stopped.tasks.length}`);

  // ── 요약 변질: 실행 사이 원문이 바뀌면 시작조차 못 한다 ──
  const entry = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 500_000) }).getState().messages.find((m) => m.type === "result");
  const bodyFile = join(runPaths(ws, RUN_ID).dir, entry.bodyPath);
  writeFileSync(bodyFile, `${readFileSync(bodyFile, "utf8")}\n위조된 한 줄.\n`);
  const tampered = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock: clockFrom(T0 + 600_000), maxIterations: 1 });
  check(
    "변조된 run은 task를 하나도 건드리지 않고 거부된다(fail closed)",
    tampered.blocked === "run_unavailable" && tampered.tasks.length === 0 && tampered.stoppedBecause === "message_body_hash_mismatch",
    `${tampered.blocked}/${tampered.stoppedBecause}`,
  );
}

console.log(
  "\n이 스크립트가 증명하지 않는 것: live LLM 0회 · 좌초 프로세스 탐색(관측자 없음) · supervisor 관측 실패 경로 · " +
    "동시 controller 2대 · **문서 누락 red는 통합 경로에서 표현 불가**(autopilot이 result 본문을 직접 만든다 — kernel 층이 전 타입 전수 커버) · " +
    "v1 `runWorkflow`의 헤더 검사는 여전히 경고 수준이다(대장 C-70)",
);
console.log("\n===================================");
console.log(` M10 T1·T2 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
