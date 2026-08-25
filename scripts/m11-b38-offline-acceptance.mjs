#!/usr/bin/env node
/**
 * V3 M11 — **지시→계획→집행→산출물→완료를 한 줄로 잇는다**(offline · **live LLM 0회 · 무과금**).
 * 대장 **`B-38`**(지시에 operation을 싣는 통로가 없다) + **`C-111`**(kernel이 지시-계획 bind를 강제하지
 * 않는다)를 함께 밟는다 — 대장이 "함께"를 요구한다.
 *
 * ## 왜 이 스크립트가 필요한가
 *
 * 판정 ⑥ ⓔ의 실측: `materializeTaskDag`가 만든 지시에는 operation 객체가 없어서 모델은 `operations: []`를
 * 내고, `provides`를 선언한 task는 `artifact_missing`으로 pause했다. 산출물 바이트를 낸 live run이 **한 번도
 * 없었다**(T7의 artifact는 fixture다). 여기서 그 다섯 단계를 **DAG 문서 한 장에서 시작해** 끝까지 잇는다.
 *
 * ## 증명하는 것
 *
 * ① DAG의 `operations` 축 → assignment 본문의 operation 객체 → 그것을 **그대로 복사한** 계획 →
 *    typed write가 **디스크에 없던 파일을 만들고** → `addArtifact`가 검증하고 → task가 `completed`
 * ② 승인 밖 operation을 실은 DAG는 **물질화에서** 거부되고 durable에 아무것도 남지 않는다(+ 대조군)
 * ③ 지시 밖 operation을 낸 계획은 **kernel bind에서** 거부된다 — 파일 0 · 영수증 0 · 미완료(+ 대조군)
 * ④ `operations` 없는 DAG의 지시 본문은 `B-38` 이전과 **바이트 동일**하고, 그 task는 아무 operation도 못 낸다
 *
 * ## 증명하지 않는 것 (같은 무게로)
 *
 * - **모델이 실제로 그 객체를 복사해 내는가** — 여기서 "복사"는 스크립트가 본문에서 JSON을 꺼내 계획에
 *   넣는 것이다. live 왕복은 오케스트레이터가 닫는다(구현 세션 live 금지).
 * - live worker · 네트워크 · 실제 추론 0회. backend는 `offline-plan` 하나다.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { createOrchestrationRun, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { materializeTaskDag, assignmentBodyFor } = await import(join(REPO_ROOT, "src/exec/taskDagMaterialize.ts"));
const { TASK_DAG_SCHEMA_VERSION } = await import(join(REPO_ROOT, "src/exec/taskDag.ts"));
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
const codeOf = (fn) => {
  try {
    fn();
    return "(통과)";
  } catch (e) {
    return e?.code ?? String(e);
  }
};

const RUN_ID = "m11-b38";
const MILESTONE = "m11-b38";
const T0 = Date.parse("2026-08-25T00:00:00.000Z");
const PLAN_PATH = "docs/PLAN.md";
const PLAN_TEXT = "# 기획\n\n- 이 바이트는 typed write가 만들었다.\n";

function clockFrom(startMs, stepMs = 1000) {
  let n = 0;
  return () => new Date(startMs + stepMs * n++);
}

function manifest(over = {}) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs"],
    ownershipByTask: { "plan-doc": ["docs"] },
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
    operationAuthorityByTask: {
      "plan-doc": [{ authorityId: "auth-plan", kind: "write_file", path: PLAN_PATH, maxBytes: 4096 }],
    },
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...over,
  };
}

/** `operations` 축이 든 DAG 문서 1장 — 운영자가 authoring하는 실물 모양이다. */
function dagDocument(over = {}) {
  return {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [
      {
        taskId: "plan-doc",
        roleId: "pm",
        title: "기획 문서 작성",
        scope: "docs 안에서만 작업한다",
        ownership: ["docs"],
        dependsOn: [],
        provides: [PLAN_PATH],
        operations: ["auth-plan"],
        ...over,
      },
    ],
  };
}

function bootRun(manifestOver = {}) {
  const ws = makeDir("m11-b38-ws-");
  // typed write는 파일을 만들지만 **부모 디렉터리를 만들지 않는다**(승인은 경로 하나를 정할 뿐이다).
  mkdirSync(join(ws, "docs"), { recursive: true });
  const kernel = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(manifestOver),
    clock: clockFrom(T0),
  });
  return { ws, kernel };
}

/**
 * **모델이 하는 일의 offline 대역**: 지시 본문에서 operation 객체를 그대로 꺼내 `content`만 채운다.
 * 본문을 파싱해 계획을 만드는 이 동작이 곧 "복사-붙여넣기만 하면 통과한다"의 검증이다 —
 * 스크립트가 객체를 **직접 지어내면** 이 절 전체가 공허해진다.
 */
function copyOperationsFromAssignment(body, content) {
  const found = [...body.matchAll(/^\{"operationId".*\}$/gm)].map((m) => JSON.parse(m[0]));
  return found.map((op) => (op.kind === "write_file" ? { ...op, content } : op));
}

function writePlan(planDir, taskId, plan) {
  writeFileSync(join(planDir, `${taskId}.json`), JSON.stringify(plan));
}

console.log("① 정본 경로 — DAG의 operations 축이 산출물 바이트까지 이어진다 (B-38)");
{
  const { ws, kernel } = bootRun();
  const out = materializeTaskDag(kernel, dagDocument());
  check("DAG 문서가 task로 물질화됐다", out.createdOrder.join(",") === "plan-doc", out.createdOrder.join(","));

  const body = kernel.messageBody("asg-plan-doc");
  const copied = copyOperationsFromAssignment(body, PLAN_TEXT);
  check(
    "지시 본문에서 operation 객체를 **그대로** 꺼낼 수 있다(모델이 복사할 대상이 실재한다)",
    copied.length === 1 && copied[0].authorityId === "auth-plan" && copied[0].path === PLAN_PATH,
    JSON.stringify(copied),
  );
  check(
    "durable task에 지시 축이 굳었다(kernel bind의 입력)",
    JSON.stringify(kernel.getTask("plan-doc").assignedOperations) === '["auth-plan"]',
    JSON.stringify(kernel.getTask("plan-doc").assignedOperations),
  );

  const planDir = makeDir("m11-b38-plans-");
  writePlan(planDir, "plan-doc", {
    operations: copied,
    result: { summary: "기획 문서를 발행했다", outputs: [{ path: PLAN_PATH, role: "output" }] },
  });

  const file = join(ws, PLAN_PATH);
  check("집행 전에는 산출물 파일이 **없다**(fixture를 깔지 않았다)", !existsSync(file));

  const events = [];
  const report = await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 4,
    onEvent: (e) => events.push(e),
  });

  check(
    "typed write가 **디스크에 없던 파일을 실제로 만들었다**",
    existsSync(file) && readFileSync(file, "utf8") === PLAN_TEXT,
    existsSync(file) ? JSON.stringify(readFileSync(file, "utf8")) : "(파일 없음)",
  );

  const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  const task = k.getTask("plan-doc");
  const receipts = task.execution.operationReceipts;
  check(
    "operation이 승인 경계를 지나 영수증으로 닫혔다",
    receipts.length === 1 && receipts[0].kind === "write_file" && receipts[0].authorityId === "auth-plan",
    JSON.stringify(receipts.map((r) => `${r.kind}:${r.marker}`)),
  );
  check(
    "영수증의 결과 hash가 디스크 바이트와 같다(영수증이 실제 효과를 가리킨다)",
    receipts[0]?.resultSha256 === createHash("sha256").update(readFileSync(file)).digest("hex"),
    String(receipts[0]?.resultSha256),
  );
  check(
    "산출물이 **검증된 artifact 포인터**로 등록됐다(addArtifact가 디스크 실재·hash를 본다)",
    k.getState().artifacts.length === 1 && k.getState().artifacts[0].path === PLAN_PATH,
    JSON.stringify(k.getState().artifacts.map((a) => a.path)),
  );
  check("task가 completed로 착지했다", task.state === "completed", task.state);
  check(
    "artifact_missing pause가 없다(판정 ⑥이 실측한 그 pause가 사라졌다)",
    !events.some((e) => e.kind === "task_paused"),
    JSON.stringify(events.filter((e) => e.kind === "task_paused")),
  );
  check("loop가 사람 개입 없이 끝났다", report.blocked === null && report.stoppedBecause === "no_runnable_tasks", `${report.blocked}/${report.stoppedBecause}`);
}

console.log("\n② 승인 밖 operation을 실은 DAG는 **물질화에서** 거부된다 (B-38 — 지시는 권위를 만들지 못한다)");
{
  // ⓐ 승인에 없는 authorityId.
  const a = bootRun();
  const ghost = dagDocument({ operations: ["auth-ghost"] });
  check("승인에 없는 authorityId는 거부된다", codeOf(() => materializeTaskDag(a.kernel, ghost)) === "dag_materialize_seed_rejected");
  check("거부됐으므로 durable에 task가 하나도 없다", a.kernel.getState().tasks.length === 0, String(a.kernel.getState().tasks.length));

  // ⓑ 승인 자체가 비어 있는 run(판정 ⑥의 L1 run이 이 모양이었다).
  const b = bootRun({ operationAuthorityByTask: {} });
  check("그 task에 아무 권위도 승인되지 않았으면 거부된다", codeOf(() => materializeTaskDag(b.kernel, dagDocument())) === "dag_materialize_seed_rejected");
  check("역시 durable 잔류 0", b.kernel.getState().tasks.length === 0, String(b.kernel.getState().tasks.length));

  // ⓒ **대조군** — 같은 문서라도 승인 안이면 통과한다(위 거부가 공허하지 않다).
  const c = bootRun();
  check("대조군: 승인 안의 id는 그대로 물질화된다", materializeTaskDag(c.kernel, dagDocument()).createdOrder.join(",") === "plan-doc");
}

console.log("\n③ 지시 밖 operation을 낸 계획은 **kernel bind에서** 거부된다 (C-111)");
{
  // 승인에는 write 권위가 **둘** 있지만 지시는 하나만 열었다. `B-38` 이전에는 이 조합이 통과했다 —
  // 대조가 manifest 권위뿐이었기 때문이다(그것이 `C-111`이 이름한 구멍이다).
  const twoAuthorities = {
    operationAuthorityByTask: {
      "plan-doc": [
        { authorityId: "auth-plan", kind: "write_file", path: PLAN_PATH, maxBytes: 4096 },
        { authorityId: "auth-side", kind: "write_file", path: "docs/SIDE.md", maxBytes: 4096 },
      ],
    },
  };
  const { ws, kernel } = bootRun(twoAuthorities);
  materializeTaskDag(kernel, dagDocument());
  const planDir = makeDir("m11-b38-plans-bind-");
  writePlan(planDir, "plan-doc", {
    // 지시가 연 것은 `auth-plan` 하나다. `auth-side`는 승인 안이지만 **지시 밖**이다.
    operations: [
      { operationId: "op-side", kind: "write_file", authorityId: "auth-side", path: "docs/SIDE.md", content: "샛길\n", expectedBeforeSha256: null },
    ],
    result: { summary: "샛길 파일을 만들려 했다", outputs: [{ path: "docs/SIDE.md", role: "output" }] },
  });

  const events = [];
  await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 4,
    onEvent: (e) => events.push(e),
  });

  const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  const task = k.getTask("plan-doc");
  check("지시 밖 operation은 파일을 만들지 못했다", !existsSync(join(ws, "docs/SIDE.md")));
  check("영수증이 하나도 남지 않았다(효과 자체가 열리지 않았다)", task.execution.operationReceipts.length === 0, JSON.stringify(task.execution.operationReceipts));
  check("미확정 pending도 없다(거부는 커밋 밖이다)", task.execution.pendingOperations.length === 0, JSON.stringify(task.execution.pendingOperations));
  check("task가 completed가 아니다(거부가 완료로 세어지지 않는다)", task.state !== "completed", task.state);
  check("artifact도 등록되지 않았다", k.getState().artifacts.length === 0, String(k.getState().artifacts.length));
  check(
    "loop가 그 사실을 marker로 드러냈다(조용한 무시가 아니다)",
    events.some((e) => e.marker === "operation_denied"),
    JSON.stringify(events.map((e) => e.marker).filter(Boolean)),
  );

  // **대조군** — 같은 run·같은 승인에서 **지시 안**의 operation은 발행까지 간다.
  const ok = bootRun(twoAuthorities);
  materializeTaskDag(ok.kernel, dagDocument());
  const okPlanDir = makeDir("m11-b38-plans-bind-ok-");
  writePlan(okPlanDir, "plan-doc", {
    operations: copyOperationsFromAssignment(ok.kernel.messageBody("asg-plan-doc"), PLAN_TEXT),
    result: { summary: "기획 문서를 발행했다", outputs: [{ path: PLAN_PATH, role: "output" }] },
  });
  await runAutopilot({
    workspaceRoot: ok.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: okPlanDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 4,
  });
  const okK = openOrchestrationRun({ workspaceRoot: ok.ws, runId: RUN_ID, clock: clockFrom(T0 + 900_000) });
  check(
    "대조군: 지시 안의 operation은 같은 승인에서 파일을 만들고 completed로 간다",
    existsSync(join(ok.ws, PLAN_PATH)) && okK.getTask("plan-doc").state === "completed",
    okK.getTask("plan-doc").state,
  );
}

console.log("\n④ operations 없는 DAG는 이전과 바이트 동일하고, 그 task는 아무 operation도 낼 수 없다");
{
  // ⓐ **바이트 동일** — 이어받기가 `assignment.bodySha256`을 대조하므로 한 바이트도 달라지면 안 된다.
  //    아래 sha256은 이 slice **이전 코드**가 같은 node에서 낸 값이다.
  const node = {
    taskId: "plan-doc",
    roleId: "pm",
    title: "기획 문서",
    scope: "docs 안에서만",
    ownership: ["docs"],
    dependsOn: [],
    provides: [PLAN_PATH],
    consumes: [],
    resourceClasses: [],
    operations: [],
    // **L2a에서 `briefing` 축이 생겼다.** 정규화된 "부재" 값은 `""`이며, 아래 골든 hash가 그대로라는
    // 것이 곧 "briefing 없는 지시는 바이트가 움직이지 않았다"의 증거다.
    briefing: "",
  };
  check(
    "operations 없는 지시 본문은 B-38 이전과 바이트 동일하다",
    createHash("sha256").update(assignmentBodyFor(node), "utf8").digest("hex") ===
      "55f5b87d14e06c5a27461351cc22f3ef8175b986d04ed0c3495426ca8d0602f3",
  );

  // ⓑ 선언하지 않은 task는 **승인이 있어도** operation을 낼 수 없다(`[]` = "선언했고 비었다").
  const { ws, kernel } = bootRun();
  materializeTaskDag(kernel, dagDocument({ operations: [] }));
  check("선언이 없으면 durable 지시 축이 빈 배열이다(null이 아니다)", JSON.stringify(kernel.getTask("plan-doc").assignedOperations) === "[]", JSON.stringify(kernel.getTask("plan-doc").assignedOperations));
  const planDir = makeDir("m11-b38-plans-empty-");
  writePlan(planDir, "plan-doc", {
    operations: [{ operationId: "op-1", kind: "write_file", authorityId: "auth-plan", path: PLAN_PATH, content: PLAN_TEXT, expectedBeforeSha256: null }],
    result: { summary: "승인만 보고 냈다", outputs: [{ path: PLAN_PATH, role: "output" }] },
  });
  await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    clock: clockFrom(T0 + 60_000),
    maxIterations: 4,
  });
  check("승인 안이지만 지시가 열지 않은 operation은 파일을 만들지 못한다", !existsSync(join(ws, PLAN_PATH)));
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
