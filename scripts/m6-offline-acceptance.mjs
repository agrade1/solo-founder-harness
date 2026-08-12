#!/usr/bin/env node
/**
 * V3 M6 — **hierarchical orchestrator + fresh context rotation acceptance**.
 *
 * 네트워크·LLM·provider·TTY·git write·프로세스 spawn 없이 임시 workspace 하나에서만 돈다. 실패 시 exit 1.
 * `src/*.ts`를 직접 소비한다(tracked `dist/`를 소비하면 낡은 계약을 검사하며 green이 된다).
 *
 * ## 무엇을 증명하는가 (그리고 무엇을 증명하지 않는가 — 정직하게)
 *
 * **증명한다**(로드맵 M6 완료 조건 ①②③):
 * - ① agent 출력의 `spawn_child`·`deliver_status` 요청이 **autopilot 경유로** kernel 게이트를 지나
 *   parent→child→parent(결과가 parent inbox로) · child→중앙→sibling(전달이 sibling inbox로) 배선된다.
 * - ② child는 **요청만** 한다: 요청 union에 state 변경 갈래가 없고, registry 밖 role·depth 초과·관계 없는
 *   수신자는 kernel이 거부하며, 거부된 요청은 durable에 흔적을 남기지 않는다.
 * - ③ coordinator를 교체(프로세스 종료 → 재기동)해도 `snapshotDigest()` 세 해시가 전부 같고, 교체 후
 *   이어 돌린 run이 **무교체 대조 run과 같은 최종 다이제스트**에 도달한다.
 *
 * **증명하지 않는다(정직하게 적는다)**:
 * - **live 추론 0** — worker는 사람이 authoring한 offline 계획을 읽는 in-memory 데이터 어댑터다.
 *   "실제 LLM이 spawn을 요청한다"는 이 스크립트의 범위 밖이다(계약의 모양만 증명한다).
 * - **프로세스 spawn 0** — 여기서 도는 것은 typed operation이 없는 turn뿐이다. 자손 정리는 Test 17이 덮는다.
 * - **inbox 소비 없음** — autopilot은 여전히 전달을 ack하지 않는다(`B-17` 미소비). 그래서 ①이 증명하는
 *   것은 **route가 durable하게 남는 것**까지이고, 수신 task가 그 내용을 읽어 행동을 바꾸는 것은 아니다.
 * - **context bundle은 autopilot에 주입되지 않는다** — offline plan worker에 프롬프트 채널이 없다.
 *   여기서 검증하는 것은 bundle의 **결정성과 내용**이며, 프롬프트 소비는 live backend 슬라이스의 몫이다.
 * - **attempt 신원 재사용 차단은 직전 한 칸까지다**(대장 `C-68`) — 두 attempt 이전 값의 재사용은 막지 못한다.
 * - **`decisionHash`의 run 사이 동일성은 주장하지 않는다** — `messageId`가 난수 신원이라 서로 다른 두 run은
 *   반드시 다르다. 교체 전후(같은 run)의 동일성만 주장하고, 교체 run vs 대조 run은 **신원을 뺀 결정 내용**을
 *   비교한다(시나리오 ⑦).
 *
 * 시나리오:
 *   ① spawn 배선 — 계획의 요청이 child를 만들고 parent는 위임(`waiting_children`)으로 착지한다 →
 *   ② 결과 라우팅 — child 결과가 parent inbox로 route되고 parent가 다음 attempt에서 완주한다 →
 *   ③ sibling 전달 — child→중앙→sibling 전달이 sibling inbox에 도착한다 →
 *   ④ 요청 union — state 변경 갈래가 없고 권능 필드도 없다(schema 정본에서 확인) →
 *   ⑤ kernel 거부 — registry 밖 role · 관계 없는 수신자는 거부되고 durable 흔적이 없다 →
 *   ⑥ context bundle — durable state만으로 재구성되고 두 번 만들면 byte-identical이다 →
 *   ⑦ rotation 등가성 — 교체 전후 세 해시가 같고, 교체 후 완주한 run이 무교체 run과 같은 다이제스트다.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// workspace의 docs/는 산출물을 놓기 위해 필요하다(승인된 writableRoots).
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// src/*.ts를 직접 소비하므로 tsx 로더가 필요하다 — 로더 없이 들어왔으면 tsx로 정확히 한 번 재실행한다.
if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { createOrchestrationRun, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runAutopilot } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));
const { REQUIRED_BODY_HEADINGS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));

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

const MILESTONE = "m6";
const T0 = Date.now();
let tick = 0;
const clock = () => new Date(T0 + tick++);

const dirs = [];
function makeDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const body = (type) => REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");

function manifest(taskIds) {
  const ownershipByTask = {};
  for (const id of taskIds) ownershipByTask[id] = ["docs"];
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs"],
    ownershipByTask,
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 3,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 900_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    maxSessions: 8,
    maxTokens: 10_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}

const seed = (taskId) => ({
  taskId,
  roleId: "tech-lead",
  title: `${taskId} 제목`,
  scope: `${taskId} bounded scope`,
  ownership: ["docs"],
  assignmentMessageId: `asg-${taskId}`,
  assignmentBody: body("task_assignment"),
});

/** 계획 문서. `requests`는 준 경우에만 key로 실린다(생략 = 빈 배열 경로를 그대로 쓴다). */
function writePlan(planDir, taskId, plan) {
  writeFileSync(
    join(planDir, `${taskId}.json`),
    JSON.stringify({
      operations: [],
      ...(plan.requests === undefined ? {} : { requests: plan.requests }),
      result: plan.result ?? { summary: `${taskId} 완료`, outputs: [] },
    }),
  );
}

const spawnReq = (childTaskId, roleId = "qa-security") => ({
  kind: "spawn_child",
  childTaskId,
  roleId,
  title: `${childTaskId} 제목`,
  scope: `${childTaskId} bounded scope`,
  dependsOn: [],
  reason: "전문 분야가 달라 쪼갠다",
});
const deliverReq = (deliverTo, note = "진행 상황 공유") => ({ kind: "deliver_status", deliverTo, note });

/** run + root task + 빈 plan 디렉터리. */
function boot(runId, taskIds = ["root"]) {
  const ws = makeDir("m6-acc-ws-");
  mkdirSync(join(ws, "docs"), { recursive: true });
  const planDir = makeDir("m6-acc-plans-");
  const k = createOrchestrationRun({ workspaceRoot: ws, runId, milestoneId: MILESTONE, manifest: manifest(taskIds), clock });
  for (const id of taskIds) k.createRootTask(seed(id));
  return { ws, planDir, runId };
}

const reopen = (f) => openOrchestrationRun({ workspaceRoot: f.ws, runId: f.runId, clock });
const pilot = (f) => runAutopilot({ workspaceRoot: f.ws, runId: f.runId, milestoneId: MILESTONE, planDir: f.planDir, clock });

try {
  // ── ① spawn 배선 ──────────────────────────────────────────────────────────
  console.log("");
  console.log("-- ① spawn 배선: 계획의 요청이 kernel 경유로 child를 만든다 --");
  const f1 = boot("m6-spawn");
  writePlan(f1.planDir, "root", { requests: [spawnReq("child1")] });
  const r1 = await pilot(f1);
  const k1 = reopen(f1);
  const root1 = k1.getTask("root");
  const child1 = k1.getTask("child1");
  check("parent가 결과 대신 위임으로 착지한다(waiting_children)", root1.state === "waiting_children", root1.state);
  check("위임 turn은 결과를 발행하지 않는다", root1.resultSummary === null);
  check("정리 확인 뒤 위임이므로 lease가 남지 않는다", root1.execution.processLeaseMarker === null);
  check("kernel이 child를 만들었다(depth·parent는 kernel 계산값)", child1 !== null && child1.depth === 1 && child1.parentTaskId === "root");
  check("child role이 registry 값으로 들어갔다", child1 !== null && child1.roleId === "qa-security");
  check("spawn_request 메시지가 durable하게 남았다", k1.getState().messages.some((m) => m.type === "spawn_request"));
  check("autopilot이 위임을 관측 가능한 결과로 보고한다", r1.tasks.some((t) => t.taskId === "root" && t.state === "waiting_children"));

  // ── ② 결과 라우팅 (parent→child→parent) ──────────────────────────────────
  console.log("");
  console.log("-- ② 결과 라우팅: child 결과가 parent inbox로 route된다 --");
  writeFileSync(join(f1.ws, "docs/child.md"), "# child 산출물\n");
  writePlan(f1.planDir, "child1", { result: { summary: "child1 완료", outputs: [{ path: "docs/child.md", role: "output" }] } });
  writePlan(f1.planDir, "root", { result: { summary: "root 통합 완료", outputs: [] } });
  await pilot(f1);
  const k2 = reopen(f1);
  const childResult = k2.getState().messages.find((m) => m.type === "result" && m.taskId === "child1");
  check("child가 완료됐다", k2.getTask("child1").state === "completed");
  check("child 결과가 parent inbox로 route됐다", childResult !== undefined && childResult.routeToTaskId === "root");
  check(
    "parent inbox에 그 전달이 미확인으로 남아 있다",
    k2.listPendingInbox("root").some((m) => m.messageId === childResult.messageId),
  );
  check("child 완료 뒤 parent가 같은 실행에서 완주했다", k2.getTask("root").state === "completed");
  check("parent 결과가 durable에 있다", k2.getTask("root").resultSummary === "root 통합 완료");

  // ── ③ sibling 전달 (child→중앙→sibling) ──────────────────────────────────
  console.log("");
  console.log("-- ③ sibling 전달: 중앙이 sibling inbox로 route한다 --");
  const f2 = boot("m6-sibling");
  writePlan(f2.planDir, "root", { requests: [spawnReq("c1"), spawnReq("c2", "dev-lead")] });
  await pilot(f2);
  writePlan(f2.planDir, "c1", { requests: [deliverReq("c2", "c1이 계약을 확정했다")] });
  await pilot(f2);
  const k3 = reopen(f2);
  const status = k3.getState().messages.find((m) => m.type === "status_update");
  check("status_update가 durable하게 수락됐다", status !== undefined);
  check("발신은 중앙에게이고 route는 중앙이 정했다", status !== undefined && status.recipient === "orchestrator" && status.routeToTaskId === "c2");
  check("중앙이 sibling inbox로 route했다", k3.listPendingInbox("c2").some((m) => m.type === "status_update"));
  check("전달한 task 자신은 그 turn을 정상 완료한다", k3.getTask("c1").state === "completed");

  // ── ④ 요청 union에 state 변경 갈래가 없다 ────────────────────────────────
  console.log("");
  console.log("-- ④ child는 요청만 한다: 요청 union에 state·권능 필드가 없다 --");
  const planSchema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/typed_execution_plan.schema.json"), "utf8"));
  const requestDefs = Object.keys(planSchema.definitions).filter((k) => k.endsWith("Request"));
  check("요청 갈래는 spawn_child·deliver_status 둘뿐이다", requestDefs.sort().join(",") === "deliverStatusRequest,spawnChildRequest", requestDefs.join(","));
  const forbidden = ["state", "ownership", "writableRoots", "authorityId", "path", "content", "budget", "maxTokens", "expiresAt"];
  const leaked = requestDefs.flatMap((d) => Object.keys(planSchema.definitions[d].properties).filter((k) => forbidden.includes(k)));
  check("요청에 상태·권능·경로·예산 필드가 없다", leaked.length === 0, leaked.join(","));

  // ── ⑤ kernel 거부 — 요청은 승인이 아니다 ─────────────────────────────────
  console.log("");
  console.log("-- ⑤ 승인은 kernel이 한다: 요청만으로는 아무것도 생기지 않는다 --");
  const f3 = boot("m6-denied");
  writePlan(f3.planDir, "root", { requests: [spawnReq("bad-child", "ceo")] });
  const r3 = await pilot(f3);
  const k4 = reopen(f3);
  check("registry 밖 role의 spawn 요청은 unknown_role로 거부된다", r3.tasks[0].marker === "unknown_role", r3.tasks[0].marker);
  check("거부된 spawn 요청은 child를 만들지 않는다", k4.getTask("bad-child") === null);
  check("거부된 요청은 parent의 child 목록도 건드리지 않는다", k4.getTask("root").childTaskIds.length === 0);
  check("거부된 turn은 복구 가능한 paused로 착지한다(hang 없음)", k4.getTask("root").state === "paused");

  const f4 = boot("m6-unrelated", ["root", "lone"]);
  writePlan(f4.planDir, "root", { requests: [deliverReq("lone")] });
  writePlan(f4.planDir, "lone", {});
  const r4 = await pilot(f4);
  const k5 = reopen(f4);
  const rootOutcome = r4.tasks.find((t) => t.taskId === "root");
  check("관계 없는 수신자로의 전달은 route_not_related로 거부된다", rootOutcome.marker === "delivery_failed", rootOutcome.marker);
  check("거부된 전달은 durable 메시지를 남기지 않는다", k5.getState().messages.every((m) => m.type !== "status_update"));
  check("거부된 전달 turn은 결과를 발행하지 않는다", k5.getTask("root").resultSummary === null);

  // spawn turn은 위임이므로 결과를 발행하지 않는다 → 산출물을 주장하면 조용히 유실된다.
  const f7 = boot("m6-outputs");
  writeFileSync(join(f7.ws, "docs/out.md"), "# 산출물\n");
  writePlan(f7.planDir, "root", {
    requests: [spawnReq("never")],
    result: { summary: "root 완료", outputs: [{ path: "docs/out.md", role: "output" }] },
  });
  const r7 = await pilot(f7);
  const k7 = reopen(f7);
  check("spawn turn이 산출물을 주장하면 plan_invalid다(조용한 유실 없음)", r7.tasks[0].marker === "plan_invalid", r7.tasks[0].marker);
  check("그 turn은 child도 artifact도 만들지 않는다", k7.getTask("never") === null && k7.getState().artifacts.length === 0);

  // ── ⑥ context bundle — durable state만으로 재구성된다 ────────────────────
  console.log("");
  console.log("-- ⑥ context bundle: durable state만으로 재구성되고 결정론적이다 --");
  const k6 = reopen(f1);
  const bundleA = k6.contextBundle("root");
  const bundleB = reopen(f1).contextBundle("root");
  check("같은 revision에서 두 번 만들면 byte-identical이다", bundleA === bundleB);
  check("bundle에 시각이 들어가지 않는다", !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(bundleA));
  check("child 진행이 들어간다", bundleA.includes("- child1 [completed]"));
  check("미확인 inbox route가 들어간다", bundleA.includes(childResult.messageId));
  check("artifact는 포인터만 담고 본문은 담지 않는다", bundleA.includes("sha256=") && !bundleA.includes("# child 산출물"));
  const beforeBundle = k6.getState().revision;
  k6.contextBundle("root");
  check("bundle 생성은 state를 바꾸지 않는다(파생물)", k6.getState().revision === beforeBundle);

  // ── ⑦ rotation 등가성 ────────────────────────────────────────────────────
  console.log("");
  console.log("-- ⑦ coordinator 교체 전후 task graph·결정·artifact hash가 같다 --");
  const f5 = boot("m6-rotate");
  writePlan(f5.planDir, "root", { requests: [spawnReq("r1")] });
  await pilot(f5);
  // 교체: 이 시점의 다이제스트를 기록하고 kernel 인스턴스를 버린다(= coordinator 프로세스 종료).
  const beforeRotation = reopen(f5).snapshotDigest();
  const afterRotation = reopen(f5).snapshotDigest();
  check(
    "교체 전후 graph·decision·artifact hash가 전부 같다",
    beforeRotation.graphHash === afterRotation.graphHash &&
      beforeRotation.decisionHash === afterRotation.decisionHash &&
      beforeRotation.artifactHash === afterRotation.artifactHash,
  );
  check(
    "다이제스트가 세 값 모두 실제 hex hash이고 서로 다르다(빈 run의 상수 비교가 아니다)",
    [beforeRotation.graphHash, beforeRotation.decisionHash, beforeRotation.artifactHash].every((h) => /^[0-9a-f]{64}$/.test(h)) &&
      new Set(Object.values(beforeRotation)).size === 3,
  );
  // 교체 후 끝까지 진행 → 무교체 대조 run과 최종 다이제스트가 같아야 한다.
  writeFileSync(join(f5.ws, "docs/r1.md"), "# r1 산출물\n");
  writePlan(f5.planDir, "r1", { result: { summary: "r1 완료", outputs: [{ path: "docs/r1.md", role: "output" }] } });
  writePlan(f5.planDir, "root", { result: { summary: "root 통합 완료", outputs: [] } });
  await pilot(f5);
  const rotatedFinal = reopen(f5).snapshotDigest();

  // 대조군: **교체 없이** 같은 계획으로 처음부터 끝까지 한 번에 돈다.
  const f6 = boot("m6-control");
  writeFileSync(join(f6.ws, "docs/r1.md"), "# r1 산출물\n");
  writePlan(f6.planDir, "root", { requests: [spawnReq("r1")] });
  await pilot(f6);
  writePlan(f6.planDir, "r1", { result: { summary: "r1 완료", outputs: [{ path: "docs/r1.md", role: "output" }] } });
  writePlan(f6.planDir, "root", { result: { summary: "root 통합 완료", outputs: [] } });
  await pilot(f6);
  const controlFinal = reopen(f6).snapshotDigest();
  check("교체 후 완주한 run이 무교체 대조 run과 같은 graph 다이제스트에 도달한다", rotatedFinal.graphHash === controlFinal.graphHash, `${rotatedFinal.graphHash} vs ${controlFinal.graphHash}`);
  check("artifact 다이제스트도 대조 run과 같다", rotatedFinal.artifactHash === controlFinal.artifactHash);
  // **`decisionHash`는 run 사이에서 같을 수 없다(정직하게 적는다)**: `messageId`가 durable 신원이고
  // autopilot이 turn마다 난수로 발급하므로 서로 다른 두 run은 messageId가 다르다. 그래서 교체 전후
  // (같은 run)에서는 같지만 **교체 run vs 대조 run에서는 다르다**. 대신 신원을 뺀 **결정 내용**이 같은지를
  // 본다 — 그것이 "같은 계획이 같은 결정으로 이어졌다"의 실제 주장이다.
  check("서로 다른 run의 decisionHash는 다르다(messageId가 난수 신원이므로 — 과대주장 방지)", rotatedFinal.decisionHash !== controlFinal.decisionHash);
  const contentOf = (f) =>
    JSON.stringify(
      reopen(f)
        .getState()
        .messages.map((m) => [m.type, m.taskId, m.routeToTaskId, m.summary])
        .sort(),
    );
  check("신원(messageId)을 뺀 결정 내용은 교체 run과 대조 run이 같다", contentOf(f5) === contentOf(f6), `${contentOf(f5)} vs ${contentOf(f6)}`);
  check("대조 run도 실제로 완주했다(공허한 비교가 아니다)", reopen(f6).getTask("root").state === "completed");

  // **시각 둔감성을 직접 본다**: 위 "교체 전후 동일"은 재개해도 durable `updatedAt`이 그대로여서
  // 시각이 섞여도 green으로 남는다(mutation으로 실측했다). 그래서 시각 필드만 바꾼 state 사본으로
  // 다이제스트가 움직이지 않는지 따로 확인한다 — 이것이 없으면 ③은 시각에 눈이 먼 체크가 된다.
  const { computeSnapshotDigest: digestOfState } = await import(join(REPO_ROOT, "src/exec/contextBundle.ts"));
  const timeShifted = JSON.parse(JSON.stringify(reopen(f6).getState()));
  timeShifted.updatedAt = "2099-01-01T00:00:00.000Z";
  timeShifted.revision += 7;
  timeShifted.lastEventId += 7;
  for (const t of timeShifted.tasks) {
    t.updatedAt = "2099-01-01T00:00:00.000Z";
    t.createdAt = "2099-01-01T00:00:00.000Z";
  }
  const shifted = digestOfState(timeShifted);
  check(
    "시각·revision만 바뀐 state는 세 다이제스트가 전부 그대로다(교체 전후가 같을 수 있는 이유)",
    shifted.graphHash === controlFinal.graphHash &&
      shifted.decisionHash === controlFinal.decisionHash &&
      shifted.artifactHash === controlFinal.artifactHash,
  );

  // 위조 감지: 다이제스트가 내용에 실제로 반응하는가.
  const forged = JSON.parse(JSON.stringify(reopen(f6).getState()));
  forged.tasks.find((t) => t.taskId === "r1").state = "blocked";
  check("task 하나를 위조하면 graph 다이제스트가 갈린다", digestOfState(forged).graphHash !== controlFinal.graphHash);

  // ── 닫힌 게이트 확인 ──────────────────────────────────────────────────────
  console.log("");
  console.log("-- 닫힌 게이트: 이 acceptance가 소비하지 않은 것 --");
  check("프로세스 spawn 0회 — 자손 정리 증명 아님(Test 17이 덮는다)", true);
  check("live 추론 0회 — 계획은 사람이 authoring한 offline 문서다", true);
  check("inbox 소비 없음 — route가 durable하게 남는 것까지만 증명한다(B-17 미소비)", k2.listPendingInbox("root").length > 0);
} finally {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 임시 디렉터리 정리 실패는 판정을 바꾸지 않는다 */
    }
  }
}

console.log("");
console.log("===================================");
console.log(` M6 hierarchical orchestration acceptance: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
