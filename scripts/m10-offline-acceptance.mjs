/**
 * V3 M10 T1·T2·T3 offline acceptance — 크래시 복구 + 통합 시나리오 + 무인 loop end-to-end (Test 22).
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
 * - ⑦ **T3 end-to-end**: 기획→디자인→개발 세 단계가 **한 번의 `runAutopilot`** 안에서 의존 순서대로
 *   돈다. 계획 파일은 **0개**이고(계획을 worker가 만든다) 각 단계는 자기 지시·문맥·role을 프롬프트로
 *   받는다(셋 중 하나라도 빠지면 worker가 계약 밖 텍스트를 내므로 이 검사는 공허하지 않다).
 *   개발 단계는 승인된 typed operation을 실제로 집행하고 영수증으로 닫는다. **사람 개입 0건.**
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  // **정규 경로로 돌려준다**(V3 M10 T6). macOS `TMPDIR`은 `/var/folders/...`이고 `/var`는 `/private/var`
  // symlink다 → 정규화하지 않은 경로를 승인 manifest에 넣으면 `verifyApprovedExecutable`이
  // "정규 경로여야 한다"로 거부하고 **프로세스가 아예 뜨지 않는다**. 그 상태에서도 marker는
  // `process_failed`/`outcome_unknown`이라 아래 단정들이 그대로 통과했다 = 공허한 green이었다.
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
    JSON.stringify({
      operations: plan.operations ?? [],
      result: plan.result ?? { summary: `${taskId} 완료`, outputs: [] },
      // `requests`는 **있을 때만** 싣는다: 닫힌 key 집합이 두 갈래이므로 빈 배열을 항상 넣으면 요청 없는
      // 계획이 다른 집합으로 판정된다(T6에서 이 누락이 우회 테스트를 공허하게 만들고 있었다).
      ...(plan.requests === undefined ? {} : { requests: plan.requests }),
    }),
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
  // **부수 효과 파일**을 남긴다: "실제 프로세스를 띄웠다"를 단정할 수 있는 유일한 관측점이다
  // (supervisor는 `stdio: "ignore"`이고 게이트에서 막혀도 marker가 같아 구분되지 않는다 — M10 T6).
  const spawnedMarker = join(ws, "docs", "spawned.txt");
  // **실행 비트가 있어야 승인된 실행 파일이다**(`verifyApprovedExecutable`). 0644로 쓰면 spawn이
  // `process_executable_untrusted`로 막히고 marker는 여전히 `outcome_unknown`이라 구분되지 않는다
  // (M10 T6에서 이 조합이 섹션 ①②를 공허하게 만들고 있었다 — 위 부수 효과 단정이 그것을 잡았다).
  writeFileSync(
    entrypoint,
    `import { writeFileSync as w } from "node:fs";\nw(${JSON.stringify(spawnedMarker)}, "1");\nsetTimeout(() => process.exit(0), ${sleepMs});\n`,
    { mode: 0o755 },
  );
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
  return { ws, planDir, entrypoint, spawnedMarker };
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
  // **자식이 실제로 떴는지를 먼저 단정한다**: 승인 게이트에서 막혀도 marker는 같으므로(둘 다
  // `outcome_unknown`) 이 단정이 없으면 "실제 프로세스" 주장이 공허해진다(M10 T6에서 실측으로 발견).
  check("자식 프로세스가 실제로 떴다(부수 효과 파일)", existsSync(f.spawnedMarker));
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
  // **deadline으로 끊기는 실제 프로세스**를 쓴다(섹션 ①과 같은 조합): 그래야 영수증이
  // `outcome_unknown`이고, 종료 기록 커밋 직전에 controller가 죽었을 때 판정 ③("기록이 끊긴 창")이
  // 실제로 성립한다. 이전 판은 `sleepMs: 20`(정상 종료 → `applied` 영수증)이었는데, 그 조합에서는
  // 복구가 **정당하게** 정리를 확인하고 완료한다 → 섹션이 아무것도 증명하지 못한다(M10 T6 실측:
  // 그때 spawn 자체가 게이트에서 막혀 `outcome_unknown`이 나오고 있었고, 그것이 green을 만들고 있었다).
  const f = bootWithRealProcess({ sleepMs: 5_000, timeoutMs: 150 });
  const childFile = join(makeDir("m10-crash-child-"), "crash.mjs");
  writeFileSync(childFile, CRASH_AUTOPILOT_CHILD);
  const tsx = join(REPO_ROOT, "node_modules/.bin/tsx");
  const child = spawnSync(tsx, [childFile, REPO_ROOT, f.ws, f.planDir, RUN_ID], { encoding: "utf8", timeout: 120_000 });
  // tsx는 래퍼라 안쪽 node의 SIGKILL이 `137`로 올라온다 — 둘 다 "신호로 죽었다"는 같은 사실이다.
  check("controller가 실제로 SIGKILL로 죽었다", child.signal === "SIGKILL" || child.status === 137, `status=${child.status} signal=${child.signal} ${child.stderr ?? ""}`);
  const paths = runPaths(f.ws, RUN_ID);
  check("자식 프로세스가 실제로 떴다(부수 효과 파일)", existsSync(f.spawnedMarker));
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

console.log("\n⑦ T3 end-to-end — 기획→디자인→개발을 **한 번의 runAutopilot**이 의존 순서대로 돈다 (LLM 0회)");
{
  const ws = makeDir("m10-e2e-ws-");
  mkdirSync(join(ws, "docs"), { recursive: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  // 각 단계의 산출물은 미리 있다(모델은 도구가 끊겨 파일을 쓰지 못한다 — 쓰기는 kernel typed-write만 한다).
  writeFileSync(join(ws, "docs/PLAN.md"), "# 기획\n");
  writeFileSync(join(ws, "docs/DESIGN.md"), "# 디자인\n");
  writeFileSync(join(ws, "src/app.ts"), "export const app = 1;\n");
  const appSha = createHash("sha256").update(readFileSync(join(ws, "src/app.ts"))).digest("hex");

  /**
   * **worker는 프롬프트를 읽어 자기가 어느 task인지 알아낸다.** 이것이 이 검사를 공허하지 않게 만든다:
   * 프롬프트가 durable 지시·문맥을 담지 않으면 이 worker는 단계를 구분할 수 없어 계약 밖 출력을 낸다.
   */
  const workerBin = (() => {
    const dir = realpathSync(makeDir("m10-e2e-bin-"));
    const file = join(dir, "worker.mjs");
    const plans = {
      "role은 `pm`": '{"operations": [], "result": {"summary": "기획 완료", "outputs": [{"path": "docs/PLAN.md", "role": "output"}]}}',
      "role은 `design`": '{"operations": [], "result": {"summary": "디자인 완료", "outputs": [{"path": "docs/DESIGN.md", "role": "output"}]}}',
      // `write_file`의 닫힌 key 집합 전부. 내용이 이미 같으므로 **멱등 경로**(`already_applied`)다 —
      // 이 절이 증명하는 것은 "계획의 operation이 승인 경계를 지나 영수증으로 닫힌다"이고 쓰기 성능이 아니다.
      "role은 `dev-lead`": `{"operations": [{"operationId": "op-app", "kind": "write_file", "authorityId": "auth-app", "path": "src/app.ts", "content": "export const app = 1;\\n", "expectedBeforeSha256": "${appSha}"}], "result": {"summary": "구현 완료", "outputs": [{"path": "src/app.ts", "role": "output"}]}}`,
    };
    writeFileSync(
      file,
      `#!${process.execPath}\n` +
        `import { readFileSync } from "node:fs";\n` +
        `const prompt = readFileSync(0, "utf8");\n` +
        `const plans = ${JSON.stringify(plans)};\n` +
        // **프롬프트에 셋 다 있어야** 계획을 낸다: ⓐ 중앙이 발행한 assignment 본문(필수 heading)
        // ⓑ durable에서 파생한 context bundle 머리말 ⓒ 이 task의 role. 하나라도 빠지면 계약 밖 텍스트를
        // 내므로 **프롬프트가 무엇을 담는지**가 이 검사의 실질이 된다(빼면 red다 — mutation으로 확인).
        `const hasAssignment = prompt.includes("## Objective") && prompt.includes("## Definition of Done");\n` +
        `const hasBundle = prompt.includes("# Context Bundle") && prompt.includes("- revision:");\n` +
        `const hit = Object.keys(plans).find((k) => prompt.includes(k));\n` +
        `const ok = hasAssignment && hasBundle && hit;\n` +
        `process.stdout.write(JSON.stringify({ result: ok ? plans[hit] : "프롬프트에 지시·문맥·role 중 빠진 것이 있다", usage: { input_tokens: 3, output_tokens: 5 } }));\n`,
      { mode: 0o700 },
    );
    return { path: file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  })();

  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({
      ownershipByTask: { "plan-pm": ["docs"], "design-ui": ["docs"], "dev-impl": ["src"] },
      executionAuthority: { ...baseManifest().executionAuthority, claude: workerBin },
      operationAuthorityByTask: { "dev-impl": [{ authorityId: "auth-app", kind: "write_file", path: "src/app.ts", maxBytes: 256 }] },
    }),
    clock: clockFrom(T0),
  });
  const stage = (taskId, roleId, title, dependsOn) => ({
    taskId,
    roleId,
    title,
    scope: `${taskId} bounded scope`,
    ownership: taskId === "dev-impl" ? ["src"] : ["docs"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: ASSIGNMENT_BODY,
    ...(dependsOn ? { dependsOn } : {}),
  });
  kernel.createRootTask(stage("plan-pm", "pm", "기획"));
  kernel.createDependentTask(stage("design-ui", "design", "디자인", ["plan-pm"]));
  kernel.createDependentTask(stage("dev-impl", "dev-lead", "개발", ["design-ui"]));

  const events = [];
  const report = await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: makeDir("m10-e2e-plans-"), // **비어 있다** — live backend는 계획을 모델이 만든다
    clock: clockFrom(T0 + 60_000),
    workerBackend: "claude-plan",
    onEvent: (e) => events.push(e),
  });

  const landed = report.tasks.map((t) => `${t.taskId}:${t.state}`).join(" → ");
  check("한 번의 실행이 세 단계를 **의존 순서대로** 완주한다", landed === "plan-pm:completed → design-ui:completed → dev-impl:completed", landed);
  check("계획 파일 0개로 돌았다(계획을 모델이 만들었다)", report.blocked === null && report.stoppedBecause === "no_runnable_tasks", `${report.blocked}/${report.stoppedBecause}`);
  const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  check("세 단계의 결과가 각각 1건씩 발행됐다", k.getState().messages.filter((m) => m.type === "result").length === 3, String(k.getState().messages.filter((m) => m.type === "result").length));
  check(
    "프롬프트가 지시 본문·문맥·**role**을 담았다(단계 구분은 role 축이다 — 세 task의 assignment 본문은 같은 상수다)",
    ["기획 완료", "디자인 완료", "구현 완료"].every((want) =>
      k.getState().messages.some((m) => m.type === "result" && m.summary === want),
    ),
    k.getState().messages.filter((m) => m.type === "result").map((m) => m.summary).join("|"),
  );
  check("개발 단계의 typed operation이 승인 경계를 지나 영수증으로 닫혔다", k.getTask("dev-impl").execution.operationReceipts.map((r) => `${r.kind}:${r.marker}`).join(",") === "write_file:already_applied", JSON.stringify(k.getTask("dev-impl").execution.operationReceipts.map((r) => r.marker)));
  check("산출물이 검증된 포인터로 등록됐다", k.getState().artifacts.length === 3, String(k.getState().artifacts.length));
  check("보고된 사용량이 durable 회계에 누적됐다(turn 3회 × 8)", k.getAccounting().tokensUsed === 24, String(k.getAccounting().tokensUsed));
  check("controller lease를 끝나고 놓았다(실행 중 보유는 관측하지 않는다)", !existsSync(runPaths(ws, RUN_ID).controllerLeaseFile));
  check("무인 loop가 사람 개입 없이 돌았다(pause 0건)", !events.some((e) => e.kind === "task_paused"), JSON.stringify(events.filter((e) => e.kind === "task_paused")));
}

console.log("\n⑨ 승인된 controller entrypoint가 in-loop 테스트를 실제로 돌린다 (C-90) + red 테스트가 완료를 막는다 (C-45 소비면)");
{
  // **실제 소스 entrypoint**를 kernel의 launch 경로로 띄운다(dist를 소비하지 않는다 — 낡은 계약 검사 방지).
  // `node` 자리에는 **tsx를 exec하는 wrapper**를 digest로 고정해 넣는다(.ts를 node가 직접 못 읽으므로).
  // production에서는 이 자리에 실제 `node`와 `dist/exec/controllerEntrypoint.js`가 온다.
  const bin = makeDir("m10-c90-bin-");
  const nodeWrapper = join(bin, "node-tsx.sh");
  writeFileSync(
    nodeWrapper,
    `#!/bin/sh\nexec "${process.execPath}" --import "${join(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  // 승인된 실행 파일은 **실행 비트**가 있어야 한다(`node <entry>`로 뜨는 경우에도 같은 계약이다) →
  // `src/exec/controllerEntrypoint.ts`는 레포에 **0755로 커밋**돼 있다(dist에서는 `npm run build`가 준다).
  // 사본을 만들지 않는다: 이 파일은 `./typedPlan.js`를 import하므로 트리 밖으로 옮기면 해석되지 않는다.
  const entrypoint = join(REPO_ROOT, "src/exec/controllerEntrypoint.ts");

  const bootTests = (dirName, body) => {
    const ws = makeDir("m10-c90-ws-");
    const planDir = makeDir("m10-c90-plans-");
    mkdirSync(join(ws, "src", dirName), { recursive: true });
    mkdirSync(join(ws, "docs"), { recursive: true });
    writeFileSync(
      join(ws, "src", dirName, "a.test.mjs"),
      `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("t", () => ${body});\n`,
    );
    const kernel = OrchestrationKernel.create({
      workspaceRoot: ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      manifest: baseManifest({
        executionAuthority: {
          ...baseManifest().executionAuthority,
          node: { path: nodeWrapper, sha256: sha256Of(nodeWrapper) },
          controllerEntrypoint: { path: entrypoint, sha256: sha256Of(entrypoint) },
        },
        operationAuthorityByTask: {
          root: [
            { authorityId: "tests-1", kind: "run_process", action: "run-tests", data: { projectPath: `src/${dirName}` }, timeoutMs: 120_000 },
          ],
        },
      }),
      clock: clockFrom(T0),
    });
    seedRoot(kernel);
    writePlan(planDir, "root", {
      operations: [{ operationId: "op-1", kind: "run_process", authorityId: "tests-1" }],
      result: { summary: "테스트를 돌렸다", outputs: [] },
    });
    return { ws, planDir };
  };

  // ⓐ 통과하는 테스트: 승인된 entrypoint가 `node --test`로 실제 실행하고 loop는 완료로 착지한다.
  const green = bootTests("green", "assert.equal(1, 1)");
  await runAutopilot({
    workspaceRoot: green.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: green.planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 2,
  });
  const gk = openOrchestrationRun({ workspaceRoot: green.ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  const gr = gk.getTask("root").execution.operationReceipts;
  check(
    "통과하는 in-loop 테스트: 승인된 entrypoint가 실제로 돌고 exitCode 0 영수증이 남는다",
    gr.length === 1 && gr[0].kind === "run_process" && gr[0].exitCode === 0 && gr[0].marker === "applied",
    JSON.stringify(gr.map((r) => ({ marker: r.marker, exitCode: r.exitCode }))),
  );
  check("통과하면 task가 completed로 착지한다", gk.getTask("root").state === "completed", gk.getTask("root").state);

  // ⓑ 실패하는 테스트: 같은 경로가 exitCode 1을 내고 loop는 **완료하지 않는다**(red가 통과로 세이지 않는다).
  const red = bootTests("red", "assert.equal(1, 2)");
  await runAutopilot({
    workspaceRoot: red.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: red.planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 2,
  });
  const rk = openOrchestrationRun({ workspaceRoot: red.ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  const rr = rk.getTask("root").execution.operationReceipts;
  check(
    "실패하는 in-loop 테스트: exitCode 1이 영수증에 남는다(kernel은 exitCode를 산출물로 남긴다)",
    rr.some((r) => r.kind === "run_process" && r.exitCode === 1),
    JSON.stringify(rr.map((r) => ({ marker: r.marker, exitCode: r.exitCode }))),
  );
  check("red 테스트는 완료를 막는다(loop 정책 — completed가 아니다)", rk.getTask("root").state !== "completed", rk.getTask("root").state);
  check(
    "결과 메시지도 발행되지 않았다(red를 성공 영수증으로 세지 않는다)",
    rk.getState().messages.filter((m) => m.type === "result").length === 0,
    String(rk.getState().messages.filter((m) => m.type === "result").length),
  );

  // ⓒ **spawn 갈래로 게이트를 우회하지 못한다**(T6 적대적 리뷰 A2). 계획은 `operations`(red 테스트)와
  // `spawn_child` 요청을 **함께** 담을 수 있다 → 게이트가 spawn 처리 뒤에 있으면 red 영수증을 남긴 채
  // `waiting_children`으로 빠져나가고 자식이 끝난 다음 attempt에서 완료된다. 게이트는 그보다 앞이어야 한다.
  const redSpawn = bootTests("redspawn", "assert.equal(1, 2)");
  writePlan(redSpawn.planDir, "root", {
    operations: [{ operationId: "op-1", kind: "run_process", authorityId: "tests-1" }],
    result: { summary: "테스트를 돌리고 자식을 만든다", outputs: [] },
    requests: [
      {
        kind: "spawn_child",
        childTaskId: "child-1",
        roleId: "dev-lead",
        title: "자식 task",
        scope: "src 안에서만",
        dependsOn: [],
        reason: "게이트 우회 시도(red 영수증을 남긴 채 waiting_children으로 나간다)",
      },
    ],
  });
  await runAutopilot({
    workspaceRoot: redSpawn.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: redSpawn.planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 2,
  });
  const sk = openOrchestrationRun({ workspaceRoot: redSpawn.ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  const sroot = sk.getTask("root");
  check(
    "red + spawn 요청을 함께 낸 계획도 게이트를 지나지 못한다(waiting_children이 아니다)",
    sroot.state !== "waiting_children" && sroot.state !== "completed",
    sroot.state,
  );
  check("우회 시도에서 자식 task가 만들어지지 않았다", sk.getState().tasks.length === 1, JSON.stringify(sk.getState().tasks.map((t) => t.taskId)));
}

console.log(
  "\n이 스크립트가 증명하지 않는 것: live LLM 0회 · 좌초 프로세스 탐색(관측자 없음) · supervisor 관측 실패 경로 · " +
    "동시 controller 2대 · **문서 누락 red는 통합 경로에서 표현 불가**(autopilot이 result 본문을 직접 만든다 — kernel 층이 전 타입 전수 커버) · " +
    "v1 `runWorkflow`의 헤더 검사는 여전히 경고 수준이다(대장 C-70)",
);
console.log("\n===================================");
console.log(` M10 T1·T2·T3 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
