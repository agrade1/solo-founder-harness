#!/usr/bin/env node
/**
 * V3 M4c — sibling/reviewer 라우팅 · 메시지 10종 · milestone approval manifest ·
 * 7 specialist registry의 offline acceptance.
 *
 * 네트워크·LLM·provider·TTY·git write 없이 임시 workspace 하나에서만 돈다. 실패 시 exit 1이다.
 *
 * **V3 M5c: 소비 대상이 `dist/exec/*` → `src/exec/*`로 바뀌었다**(tracked dist는 M5b 계약에 머물러 있고
 * 그 갱신은 M5 handoff의 build 단계다 — dist를 소비하면 이 acceptance가 낡은 계약을 검사하며 green이
 * 된다). 호출 방식은 그대로다(`node scripts/m4c-offline-acceptance.mjs`).
 *
 * 시나리오:
 *   ① 닫힌 유효 manifest + registry가 durable하고 재시작 안정적 →
 *   ② 범위 밖 ownership · pin되지 않은 dependency · 미상 command/domain · 만료 · maxSessions 초과가
 *      안정적인 code로 거부되고 durable 전이가 0 →
 *   ③ child → 중앙 → 정당한 sibling 전달(bounded summary + artifact 포인터, 결정론적 inbox,
 *      무관·모호 수신자 거부, state/snapshot에 raw 본문 없음) →
 *   ④ 중앙 review_request → reviewer, review_result → 중앙, revision_request → 수정 worker →
 *   ⑤ decision_request → 중앙 → decision →
 *   ⑥ 재시작이 manifest·route·다음 전달을 그대로 복원 →
 *   ⑦ 메시지 10종이 runtime과 schema 양쪽에서 정렬.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src", "exec");

// src/*.ts를 직접 소비하므로 tsx 로더가 필요하다 — 로더 없이 들어왔으면 tsx로 정확히 한 번 재실행한다.
if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

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

const RUN_ID = "m4c-acceptance";
const MILESTONE = "m4c";
const MARKER = "RAW-ARTIFACT-BODY-MUST-NOT-BE-COPIED-m4c-7b31";

// tick은 **프로세스 전역으로 단조**다(V3 M5c 3A 4차 리비전 A1): 커밋 시각이 durable `updatedAt`보다
// 이르면 모든 mutation이 `clock_invalid`이므로, kernel을 다시 열 때 시각이 0으로 되돌아가면 안 된다.
let clockTick = 0;
function makeClock() {
  return () => new Date(Date.UTC(2026, 6, 27, 0, 0, clockTick++));
}

function manifest(over = {}) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "c".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask: {
      planner: ["src"],
      unrelated: ["docs/unrelated"],
      reviewer: ["docs/review"],
      fixer: ["src/worker-a"],
    },
    allowedCommands: ["npm run build", "npm test"],
    allowedDependencies: [{ name: "typescript", version: "5.7.2" }],
    // M5c(v2) — node·processObserver 필수 · autopilotPolicy·operationAuthorityByTask 명시 필수.
    executionAuthority: {
      codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
      // M5c 3A 2차 리비전(`B-10`) — typed `run_process`의 고정 entrypoint(여기서는 승인 operation 0건).
      controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 60_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    allowedNetworkDomains: ["registry.npmjs.org"],
    maxSessions: 4,
    maxTokens: 200000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

/**
 * **M5c 시작·완료·전달 프로토콜 헬퍼**. 시작은 `planRunnableBatch` → `commitPreflightBatch` →
 * `startPreparedTask`뿐(대장 `B-11`), 완료는 확인된 zero-survivor 정리 뒤에만(`B-13`),
 * 수령은 durable 전달 시도가 있어야만 가능하다(`C-12→B`).
 */
let seq = 0;
const nextId = (prefix) => `${prefix}.${++seq}`;
const nextLease = () => `lease.${(++seq).toString(16).padStart(32, "0")}`;
const leaseOf = new Map();

function startVia(kernel, taskId) {
  const batch = kernel.planRunnableBatch();
  kernel.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) =>
      t.taskId === taskId
        ? { taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") }
        : { taskId: t.taskId, outcome: "deferred" },
    ),
  });
  const leaseMarker = nextLease();
  leaseOf.set(taskId, leaseMarker);
  kernel.startPreparedTask({ taskId, actionId: nextId("act"), leaseMarker });
}

function cleanVia(kernel, taskId, marker = "turn_completed") {
  kernel.recordTerminal({
    taskId,
    actionId: nextId("act"),
    marker,
    pendingResult: marker === "turn_completed" ? { summary: "ok", outputs: [] } : null,
  });
  kernel.confirmCleanup({ taskId, actionId: nextId("act"), leaseMarker: leaseOf.get(taskId) });
}

function ackVia(kernel, taskId, messageId) {
  kernel.beginDeliveryAttempt({ taskId, messageId, actionId: nextId("act"), attemptId: nextId("att") });
  return kernel.acknowledgeDelivery({ taskId, messageId, actionId: nextId("act") });
}

/** run 디렉터리 전체의 파일별 hash — "durable 전이 0" 단정용. */
function fingerprint(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return out.join("\n");
}

function codeOf(fn) {
  try {
    fn();
  } catch (e) {
    return e && e.code ? e.code : `(코드 없는 예외: ${String(e)})`;
  }
  return "(거부되지 않았다)";
}

const ids = (xs) => xs.map((x) => x.messageId ?? x.taskId);

let workspace = null;
try {
  const { createOrchestrationRun, openOrchestrationRun } = await import(join(SRC, "orchestrationKernel.ts"));
  const { runPaths } = await import(join(SRC, "orchestrationStore.ts"));
  const { AGENT_MESSAGE_TYPES, CENTRAL_MESSAGE_TYPES, EVENT_TYPES, REQUIRED_BODY_HEADINGS, SUMMARY_REQUIRED } = await import(
    join(SRC, "orchestrationTypes.ts")
  );
  const { SPECIALIST_ROLES, commandAllowed, dependencyAllowed, networkDomainAllowed, validateApprovalManifest } = await import(
    join(SRC, "approvalManifest.ts")
  );

  const body = (type) => REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
  const envelope = (type, taskId, roleId, over = {}) => {
    const central = CENTRAL_MESSAGE_TYPES.includes(type);
    return {
      schemaVersion: "1",
      messageId: `msg-${taskId}-${type}`,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId,
      parentTaskId: null,
      sender: central ? "orchestrator" : roleId,
      recipient: central ? roleId : "orchestrator",
      type,
      createdAt: "2026-07-27T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
      ...over,
    };
  };
  const kid = (type, taskId, roleId, over = {}) => envelope(type, taskId, roleId, { parentTaskId: "planner", ...over });
  const seed = (taskId, roleId, ownership, over = {}) => ({
    taskId,
    roleId,
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership,
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
    ...over,
  });

  workspace = mkdtempSync(join(tmpdir(), "m4c-acceptance-"));
  const paths = runPaths(workspace, RUN_ID);

  console.log("== M4c: 1) 닫힌 유효 manifest + 7 specialist registry가 durable하다 ==");
  let kernel = createOrchestrationRun({
    workspaceRoot: workspace,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(),
    clock: makeClock(),
  });
  check("manifest가 run에 bind됨", kernel.getManifest().approvedCommit === "c".repeat(40));
  check("state 파일에 manifest durable", readFileSync(paths.stateFile, "utf8").includes('"approvedCommit"'));
  check(
    "snapshot에 승인 요약(bounded·비밀 아님)",
    readFileSync(paths.snapshotFile, "utf8").includes("## Milestone Approval"),
  );
  check(
    "snapshot에 7 specialist registry",
    SPECIALIST_ROLES.length === 7 &&
      SPECIALIST_ROLES.every((r) => readFileSync(paths.snapshotFile, "utf8").includes(`- ${r.roleId} — ${r.title}`)),
  );
  check(
    "registry role 목록 고정",
    JSON.stringify(SPECIALIST_ROLES.map((r) => r.roleId)) ===
      JSON.stringify(["research", "pm", "ux", "design", "tech-lead", "dev-lead", "qa-security"]),
  );

  console.log("");
  console.log("== M4c: 2) 승인 밖 요청은 안정적인 code로 거부되고 durable 전이가 0이다 ==");
  kernel.createRootTask(seed("planner", "tech-lead", ["src"]));
  const revBefore = kernel.getState().revision;
  const filesBefore = fingerprint(paths.dir);

  check(
    "미승인 root task ownership 거부(ownership_not_approved)",
    codeOf(() => kernel.createRootTask(seed("rogue", "pm", ["src/rogue"]))) === "ownership_not_approved",
  );
  check(
    "writableRoots 밖 거부(ownership_outside_writable_root)",
    codeOf(() => kernel.createRootTask(seed("infra", "pm", ["infra/deploy.sh"]))) === "ownership_outside_writable_root",
  );
  check(
    "registry 밖 role 거부(unknown_role)",
    codeOf(() => kernel.createRootTask(seed("unrelated", "growth-hacker", ["docs/unrelated"]))) === "unknown_role",
  );
  check(
    "pin되지 않은 dependency 거부(dependency_not_pinned)",
    codeOf(() => validateApprovalManifest(manifest({ allowedDependencies: [{ name: "typescript", version: "latest" }] }))) ===
      "dependency_not_pinned",
  );
  check(
    "범위 버전도 거부",
    codeOf(() => validateApprovalManifest(manifest({ allowedDependencies: [{ name: "typescript", version: "^5.7.2" }] }))) ===
      "dependency_not_pinned",
  );
  check("승인된 정확한 pin만 조회 통과", dependencyAllowed(kernel.getManifest(), "typescript", "5.7.2") === true);
  check("다른 버전은 deny", dependencyAllowed(kernel.getManifest(), "typescript", "5.7.3") === false);
  check("미상 command deny", commandAllowed(kernel.getManifest(), "rm -rf /") === false);
  check("승인된 command만 allow", commandAllowed(kernel.getManifest(), "npm test") === true);
  check("미상 domain deny", networkDomainAllowed(kernel.getManifest(), "evil.example.com") === false);
  check("하위 domain 자동 허용 없음", networkDomainAllowed(kernel.getManifest(), "a.registry.npmjs.org") === false);
  check("revision 전이 0", kernel.getState().revision === revBefore);
  check("state/event/body 파일 전이 0", fingerprint(paths.dir) === filesBefore);

  // 만료 · maxSessions는 별도 run에서 확인한다(같은 workspace, 다른 run id).
  let expiredTick = 0;
  const expiredRun = createOrchestrationRun({
    workspaceRoot: workspace,
    runId: "m4c-expiry",
    milestoneId: MILESTONE,
    manifest: manifest({ expiresAt: "2026-07-27T00:00:05.000Z", ownershipByTask: { planner: ["src"], later: ["src"] } }),
    clock: () => new Date(Date.UTC(2026, 6, 27, 0, 0, expiredTick++)),
  });
  expiredRun.createRootTask(seed("planner", "tech-lead", ["src"]));
  const expiryPaths = runPaths(workspace, "m4c-expiry");
  const expiryFiles = fingerprint(expiryPaths.dir);
  const expiryRev = expiredRun.getState().revision;
  expiredTick = 60; // 만료 이후
  check(
    "만료된 manifest는 변경을 거부(manifest_expired)",
    codeOf(() => expiredRun.createRootTask(seed("later", "pm", ["src/later"]))) === "manifest_expired",
  );
  // 만료 후에는 **전진 작업**이 닫힌다: 단일 시작 경로의 preflight 커밋도 거부된다(DECISIONS 2026-07-30).
  const expiredBatch = expiredRun.planRunnableBatch();
  check(
    "만료 후 preflight 커밋도 거부(manifest_expired)",
    codeOf(() =>
      expiredRun.commitPreflightBatch({
        baseRevision: expiredBatch.revision,
        actionId: nextId("act"),
        decisions: expiredBatch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") })),
      }),
    ) === "manifest_expired",
  );
  check("legacy start 진입점은 닫혀 있다", codeOf(() => expiredRun.startTask("planner")) === "preflight_required");
  check("만료 거부는 전이 0", expiredRun.getState().revision === expiryRev && fingerprint(expiryPaths.dir) === expiryFiles);
  check("만료 후에도 읽기는 가능", expiredRun.getTask("planner").state === "ready");

  const sessionRun = createOrchestrationRun({
    workspaceRoot: workspace,
    runId: "m4c-sessions",
    milestoneId: MILESTONE,
    manifest: manifest({ maxSessions: 1, ownershipByTask: { s1: ["src"], s2: ["src"] } }),
    clock: makeClock(),
  });
  sessionRun.createRootTask(seed("s1", "dev-lead", ["src/s1"]));
  sessionRun.createRootTask(seed("s2", "dev-lead", ["src/s2"]));
  const sessionPaths = runPaths(workspace, "m4c-sessions");
  check("scheduler가 승인 세션 예산을 지킴", JSON.stringify(ids(sessionRun.scheduleReady())) === JSON.stringify(["s1"]));
  startVia(sessionRun, "s1");
  const sessionRev = sessionRun.getState().revision;
  const sessionFiles = fingerprint(sessionPaths.dir);
  // 예산이 다 찼으므로 s2는 batch에 없고, 그래서 s2를 prepared로 만드는 결정 자체가 거부된다.
  const sessionBatch = sessionRun.planRunnableBatch();
  check("승인 예산이 찬 뒤 batch는 비어 있다", JSON.stringify(ids(sessionBatch.items)) === JSON.stringify([]));
  check(
    "maxSessions 초과 시작 경로 없음(preflight_batch_mismatch)",
    codeOf(() =>
      sessionRun.commitPreflightBatch({
        baseRevision: sessionBatch.revision,
        actionId: nextId("act"),
        decisions: [{ taskId: "s2", outcome: "prepared", attemptId: nextId("att") }],
      }),
    ) === "preflight_batch_mismatch",
  );
  // durable 불변식 자체는 그대로다: 손으로 running 둘을 만든 state는 max_sessions_exceeded로 거부된다.
  const { validateRunState } = await import(join(SRC, "orchestrationStore.ts"));
  const forgedSessions = JSON.parse(readFileSync(sessionPaths.stateFile, "utf8"));
  const forgedS2 = forgedSessions.tasks.find((t) => t.taskId === "s2");
  forgedS2.state = "running";
  forgedS2.execution.attemptNo = 1;
  forgedS2.execution.attemptId = "att.forged";
  check(
    "점유 둘인 state는 load에서 거부(max_sessions_exceeded)",
    codeOf(() => validateRunState(forgedSessions)) === "max_sessions_exceeded",
  );
  check(
    "세션 초과 거부는 전이 0",
    sessionRun.getState().revision === sessionRev && fingerprint(sessionPaths.dir) === sessionFiles,
  );

  console.log("");
  console.log("== M4c: 3) child → 중앙 → 정당한 sibling 전달 ==");
  kernel.createRootTask(seed("unrelated", "research", ["docs/unrelated"]));
  startVia(kernel, "planner");
  for (const w of ["worker-a", "worker-b"]) {
    kernel.requestSpawn({
      envelope: envelope("spawn_request", "planner", "tech-lead", { messageId: `spawn-${w}` }),
      body: body("spawn_request"),
      child: seed(w, "dev-lead", [`src/${w}`]),
    });
  }
  kernel.createDependentTask({ ...seed("reviewer", "qa-security", ["docs/review"]), dependsOn: ["worker-a"] });
  kernel.createDependentTask({ ...seed("fixer", "dev-lead.fix", ["src/worker-a"]), dependsOn: ["worker-a"] });
  startVia(kernel, "worker-a");
  startVia(kernel, "worker-b");
  check("sibling 둘이 running", kernel.getTask("worker-a").state === "running" && kernel.getTask("worker-b").state === "running");

  mkdirSync(join(workspace, "src", "worker-a"), { recursive: true });
  const artifactFile = join(workspace, "src", "worker-a", "out.md");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(artifactFile, `# worker-a 산출물\n${MARKER}\n`);
  const pointer = kernel.registerArtifact({ taskId: "worker-a", path: "src/worker-a/out.md", role: "output" });

  const delivered = kernel.submitStatusUpdate({
    envelope: kid("status_update", "worker-a", "dev-lead", { messageId: "su-1", artifactRefs: [pointer] }),
    body: body("status_update"),
    summary: "worker-a 계약 초안 공유 — worker-b가 이어받는다",
    deliverTo: "worker-b",
  });
  check("중앙이 sibling inbox로 route", delivered.routeToTaskId === "worker-b", String(delivered.routeToTaskId));
  check("발신은 여전히 중앙 앞으로(직접 mailbox 쓰기 없음)", delivered.recipient === "orchestrator");
  check("bounded summary 전달", delivered.summary === "worker-a 계약 초안 공유 — worker-b가 이어받는다");
  check("검증된 artifact 포인터 전달", JSON.stringify(delivered.artifactRefs) === JSON.stringify([pointer]));
  check("수신 inbox에 1건", JSON.stringify(ids(kernel.listPendingInbox("worker-b"))) === JSON.stringify(["su-1"]));
  check("발신자 inbox는 비어 있음", kernel.listPendingInbox("worker-a").length === 0);
  check("전달은 상태 전이가 아니다", kernel.getTask("worker-b").state === "running");

  const beforeReject = fingerprint(paths.dir);
  const revBeforeReject = kernel.getState().revision;
  const deliver = (to, messageId = "su-bad") =>
    codeOf(() =>
      kernel.submitStatusUpdate({
        envelope: kid("status_update", "worker-a", "dev-lead", { messageId }),
        body: body("status_update"),
        summary: "전달 시도",
        deliverTo: to,
      }),
    );
  check("무관한 task로는 전달 거부(route_not_related)", deliver("unrelated") === "route_not_related");
  check("모호한 수신자 거부(ambiguous_recipient)", deliver("dev-lead") === "ambiguous_recipient");
  check("미상 수신자 거부(unknown_recipient)", deliver("ghost") === "unknown_recipient");
  check("자기 자신 거부(route_self)", deliver("worker-a") === "route_self");
  check("orchestrator는 전달 대상 아님(invalid_recipient)", deliver("orchestrator") === "invalid_recipient");
  check(
    "거부는 전이 0",
    kernel.getState().revision === revBeforeReject && fingerprint(paths.dir) === beforeReject,
  );

  const stateText = readFileSync(paths.stateFile, "utf8");
  const snapText = readFileSync(paths.snapshotFile, "utf8");
  check("artifact 본문에 marker 존재(대조군)", readFileSync(artifactFile, "utf8").includes(MARKER));
  check("run_state.json에 raw 본문 없음", !stateText.includes(MARKER));
  check("snapshot.md에 raw 본문 없음", !snapText.includes(MARKER));
  check("state에 message body 전문 없음", !stateText.includes("## Progress Since Last Update"));
  check("state에 transcript 필드 없음", !/transcript/i.test(stateText));
  check("snapshot에 route 표시", snapText.includes("routedTo: worker-b ack=(pending)"));

  console.log("");
  console.log("== M4c: 4) reviewer 왕복 — review_request → review_result → revision_request ==");
  cleanVia(kernel, "worker-a"); // 완료는 확인된 zero-survivor 정리 뒤에만 수락된다(대장 `B-13`)
  kernel.submitResult({
    envelope: kid("result", "worker-a", "dev-lead", { messageId: "res-worker-a", artifactRefs: [pointer] }),
    body: body("result"),
    summary: "worker-a 완료",
  });
  check("worker-a completed", kernel.getTask("worker-a").state === "completed");
  check("reviewer ready(fresh)", kernel.getTask("reviewer").state === "ready");

  const reviewReq = kernel.requestReview({
    envelope: envelope("review_request", "reviewer", "qa-security", { messageId: "rev-req", dependsOn: ["worker-a"] }),
    body: body("review_request"),
    summary: "worker-a 산출물 독립 검토",
    subjectTaskId: "worker-a",
  });
  check("중앙 → fresh reviewer inbox", reviewReq.routeToTaskId === "reviewer" && reviewReq.sender === "orchestrator");
  check("reviewer inbox에 검토 요청", JSON.stringify(ids(kernel.listPendingInbox("reviewer"))) === JSON.stringify(["rev-req"]));
  check(
    "대상에 의존하지 않는 task에는 검토 지시 없음(route_not_related)",
    codeOf(() =>
      kernel.requestReview({
        envelope: envelope("review_request", "planner", "tech-lead", { messageId: "rev-bad" }),
        body: body("review_request"),
        summary: "무관한 task에 검토 지시",
        subjectTaskId: "worker-a",
      }),
    ) === "route_not_related",
  );

  // 전달 시도·수령은 **running turn 안에서** 일어난다(M5c 전달 계약 — 시도 없는 ack는 없다).
  startVia(kernel, "reviewer");
  ackVia(kernel, "reviewer", "rev-req");
  check(
    "이미 일을 시작한 reviewer에게는 새 검토 지시 없음(task_not_fresh)",
    codeOf(() =>
      kernel.requestReview({
        envelope: envelope("review_request", "reviewer", "qa-security", { messageId: "rev-req2", dependsOn: ["worker-a"] }),
        body: body("review_request"),
        summary: "fresh하지 않은 reviewer에 재지시",
        subjectTaskId: "worker-a",
      }),
    ) === "task_not_fresh",
  );
  check(
    "review_request 없이 낸 review_result 거부(review_request_missing)",
    codeOf(() =>
      kernel.submitReviewResult({
        envelope: envelope("review_result", "worker-b", "dev-lead", { messageId: "rev-rogue", parentTaskId: "planner" }),
        body: body("review_result"),
        summary: "무단 리뷰 결과",
      }),
    ) === "review_request_missing",
  );
  const reviewRes = kernel.submitReviewResult({
    envelope: envelope("review_result", "reviewer", "qa-security", { messageId: "rev-res" }),
    body: body("review_result"),
    summary: "P1 1건 — verdict: revise",
  });
  check("reviewer → 중앙(전달 대상 없음)", reviewRes.routeToTaskId === null && reviewRes.recipient === "orchestrator");

  const revisionReq = kernel.requestRevision({
    envelope: envelope("revision_request", "fixer", "dev-lead.fix", { messageId: "fix-req", dependsOn: ["worker-a"] }),
    body: body("revision_request"),
    summary: "P1 1건 수정 후 재검증",
    subjectTaskId: "worker-a",
  });
  check("중앙 → 수정 worker inbox", revisionReq.routeToTaskId === "fixer");
  check("수정 worker inbox 확인", JSON.stringify(ids(kernel.listPendingInbox("fixer"))) === JSON.stringify(["fix-req"]));

  console.log("");
  console.log("== M4c: 5) decision_request → 중앙 → decision ==");
  const decisionReq = kernel.submitDecisionRequest({
    envelope: kid("decision_request", "worker-b", "dev-lead", { messageId: "dreq-1" }),
    body: body("decision_request"),
    summary: "계약 변경 승인 필요",
  });
  check("요청은 중앙에서 끝난다", decisionReq.routeToTaskId === null);
  const decision = kernel.recordDecision({
    envelope: kid("decision", "worker-b", "dev-lead", { messageId: "dec-1" }),
    body: body("decision"),
    summary: "현행 계약 유지",
  });
  check("중앙 → 요청 task로 회신", decision.routeToTaskId === "worker-b" && decision.sender === "orchestrator");
  check(
    "요청 없는 결정은 거부(decision_request_missing)",
    codeOf(() =>
      kernel.recordDecision({
        envelope: kid("decision", "worker-b", "dev-lead", { messageId: "dec-2" }),
        body: body("decision"),
        summary: "중복 결정",
      }),
    ) === "decision_request_missing",
  );

  console.log("");
  console.log("== M4c: 6) 재시작 — manifest·route·다음 전달이 그대로 복원된다 ==");
  const beforeRestart = kernel.getState();
  const inboxBefore = ids(kernel.listPendingInbox("worker-b"));
  const nextBefore = kernel.nextPendingDelivery().messageId;
  const snapshotBefore = kernel.rebuildSnapshot();
  kernel = null;

  const reopened = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("state 전체 복원 동일", JSON.stringify(reopened.getState()) === JSON.stringify(beforeRestart));
  check("manifest 복원 동일", JSON.stringify(reopened.getManifest()) === JSON.stringify(beforeRestart.manifest));
  check("inbox 순서 동일", JSON.stringify(ids(reopened.listPendingInbox("worker-b"))) === JSON.stringify(inboxBefore));
  check("다음 전달 동일", reopened.nextPendingDelivery().messageId === nextBefore, nextBefore);
  check("snapshot 바이트 동일", reopened.rebuildSnapshot() === snapshotBefore);

  const ackTarget = reopened.nextPendingDelivery().messageId;
  ackVia(reopened, reopened.nextPendingDelivery().routeToTaskId, ackTarget);
  check(
    "ack는 durable event를 남긴다(delivery_acknowledged)",
    readFileSync(paths.eventsFile, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l)).pop().type ===
      "delivery_acknowledged",
  );
  const afterAck = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("재시작 후에도 수령 상태 유지", afterAck.listPendingInbox("worker-b").every((m) => m.messageId !== ackTarget));
  check(
    "이미 수령한 전달 재수령 거부",
    codeOf(() => afterAck.acknowledgeDelivery({ taskId: "worker-b", messageId: ackTarget })) ===
      "delivery_already_acknowledged",
  );

  console.log("");
  console.log("== M4c: 7) 메시지 10종이 runtime·schema 양쪽에서 정렬 ==");
  const messageSchema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "agent_message.schema.json"), "utf8"));
  const stateSchema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas", "orchestration_run_state.schema.json"), "utf8"));
  const manifestSchema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schemas", "milestone_approval_manifest.schema.json"), "utf8"),
  );
  check("runtime 타입 10종", AGENT_MESSAGE_TYPES.length === 10);
  check(
    "agent_message.schema.json enum 동치",
    JSON.stringify(messageSchema.properties.type.enum) === JSON.stringify([...AGENT_MESSAGE_TYPES]),
  );
  check(
    "run_state.schema.json messageType 동치",
    JSON.stringify(stateSchema.definitions.messageType.enum) === JSON.stringify([...AGENT_MESSAGE_TYPES]),
  );
  check(
    "타입별 heading 계약 동치",
    AGENT_MESSAGE_TYPES.every(
      (t) =>
        JSON.stringify(messageSchema.definitions.messageBodyHeadings.properties[t].const) ===
        JSON.stringify([...REQUIRED_BODY_HEADINGS[t]]),
    ),
  );
  check("summary 계약이 10종 전부에 정의됨", AGENT_MESSAGE_TYPES.every((t) => typeof SUMMARY_REQUIRED[t] === "boolean"));
  check(
    "event 타입에 delivery_acknowledged 포함(schema 동치)",
    EVENT_TYPES.includes("delivery_acknowledged") &&
      JSON.stringify(stateSchema.definitions.event.properties.type.enum) === JSON.stringify([...EVENT_TYPES]),
  );
  check("run_state가 manifest를 required로 요구", stateSchema.required.includes("manifest"));
  check("manifest schema가 run_state에서 참조됨", stateSchema.properties.manifest.$ref === manifestSchema.$id);
  check(
    "manifest schema registry 동치",
    JSON.stringify(manifestSchema.definitions.specialistRegistry.const) ===
      JSON.stringify(SPECIALIST_ROLES.map((r) => r.roleId)),
  );

  // pre-M4c state는 자동 승인하지 않고 fail closed다.
  const currentState = readFileSync(paths.stateFile, "utf8");
  const preM4c = JSON.parse(currentState);
  delete preM4c.manifest;
  writeFileSync(paths.stateFile, JSON.stringify(preM4c, null, 2));
  check(
    "pre-M4c state 거부(state_pre_m4c_unsupported)",
    codeOf(() => openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID })) === "state_pre_m4c_unsupported",
  );
  writeFileSync(paths.stateFile, currentState);
  check("원상 복구 후 다시 열림", openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID }).getTask("planner") !== null);
} catch (e) {
  fail += 1;
  console.log(`  FAIL 예외 발생 — ${e && e.stack ? e.stack : String(e)}`);
} finally {
  if (workspace) {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* 임시 workspace 정리 실패는 판정을 바꾸지 않는다 */
    }
  }
}

console.log("");
console.log("===================================");
console.log(` M4c offline acceptance: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
