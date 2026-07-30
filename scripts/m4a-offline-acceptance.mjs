#!/usr/bin/env node
/**
 * V3 M4a — durable orchestration kernel offline acceptance.
 *
 * 네트워크·LLM·provider·TTY·git write 없이 임시 workspace 하나에서만 돈다.
 * `npm run build` 산출물(dist/exec/*)을 그대로 소비하며, 실패 시 exit 1이다.
 *
 * 시나리오(로드맵 M4 "완료" 항목의 M4a 부분):
 *   parent 생성/실행 → spawn_request로 child 생성 → dependent 추가 → 재시작 복원 →
 *   child 실행 → artifact 등록 + result 제출 → parent/dependent 상태 전파 →
 *   재시작 후 동일 ready/revision/포인터/snapshot → raw 본문 미유출 확인.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist", "exec");

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

const RUN_ID = "m4a-acceptance";
const MILESTONE = "m4a";
const MARKER = "RAW-ARTIFACT-BODY-MUST-NOT-BE-COPIED-4c17";

const REQUIRED_HEADINGS = {
  task_assignment: [
    "Objective",
    "Scope / Ownership",
    "Out of Scope / Forbidden",
    "Inputs and Contracts",
    "Dependencies",
    "Definition of Done",
    "Budget and Permission Envelope",
    "Expected Deliverables",
  ],
  spawn_request: [
    "Why Split Is Needed",
    "Requested Specialty",
    "Child Scope",
    "Required Inputs",
    "Expected Deliverables",
    "Dependency and Budget Impact",
  ],
  result: [
    "Result Summary",
    "Work Performed",
    "Decisions and Assumptions",
    "Deliverables",
    "Tests and Evidence",
    "Risks / Known Limitations",
    "Unresolved Questions",
    "Recommended Next Action",
  ],
};

const body = (type) => REQUIRED_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");

function makeClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 27, 0, 0, n++));
}

/**
 * M4c부터 run은 §8 승인 manifest에 bind된다(기본값 = 조용한 자동 승인이므로 필수 인자다).
 * M4a 시나리오가 만드는 root/dependent task만 명시 승인한다 — child는 parent 위임으로 검사된다.
 */
const MANIFEST = {
  milestoneId: MILESTONE,
  approvedCommit: "a".repeat(40),
  writableRoots: ["docs", "src"],
  ownershipByTask: { parent: ["src/exec"], dependent: ["docs/qa"] },
  allowedCommands: ["npm test"],
  allowedDependencies: [{ name: "typescript", version: "5.7.2" }],
  executionAuthority: {
    codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
    git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
  },
  allowedNetworkDomains: [],
  maxSessions: 4,
  maxTokens: null,
  maxElapsedMs: 3_600_000,
  localMergeAllowed: false,
  expiresAt: "2026-12-31T00:00:00.000Z",
};

function envelope(type, taskId, roleId, over = {}) {
  const agentSent = type !== "task_assignment";
  return {
    schemaVersion: "1",
    messageId: `msg-${taskId}-${type}`,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    taskId,
    parentTaskId: null,
    sender: agentSent ? roleId : "orchestrator",
    recipient: agentSent ? "orchestrator" : roleId,
    type,
    createdAt: "2026-07-27T00:00:00.000Z",
    dependsOn: [],
    artifactRefs: [],
    supersedes: null,
    ...over,
  };
}

let workspace = null;
try {
  const { createOrchestrationRun, openOrchestrationRun } = await import(join(DIST, "orchestrationKernel.js"));
  const { runPaths } = await import(join(DIST, "orchestrationStore.js"));

  workspace = mkdtempSync(join(tmpdir(), "m4a-acceptance-"));
  const paths = runPaths(workspace, RUN_ID);

  console.log("== M4a: 1~2) parent 생성·실행 → spawn_request로 child 생성 ==");
  let kernel = createOrchestrationRun({
    workspaceRoot: workspace,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: MANIFEST,
    clock: makeClock(),
  });
  kernel.createRootTask({
    taskId: "parent",
    roleId: "tech-lead",
    title: "M4a 수직 슬라이스 parent",
    scope: "orchestration kernel 수직 경로 확인",
    ownership: ["src/exec"],
    assignmentMessageId: "asg-parent",
    assignmentBody: body("task_assignment"),
  });
  kernel.startTask("parent");
  check("parent running", kernel.getTask("parent").state === "running", kernel.getTask("parent").state);

  kernel.requestSpawn({
    envelope: envelope("spawn_request", "parent", "tech-lead", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    child: {
      taskId: "child",
      roleId: "dev-lead",
      title: "child 구현",
      scope: "bounded child scope",
      ownership: ["src/exec/child"],
      assignmentMessageId: "asg-child",
      assignmentBody: body("task_assignment"),
    },
  });
  check("child 생성됨", kernel.getTask("child") !== null);

  console.log("");
  console.log("== M4a: 3~4) parent=waiting_children · child=ready · dependent=pending ==");
  check("parent waiting_children", kernel.getTask("parent").state === "waiting_children", kernel.getTask("parent").state);
  check("child ready", kernel.getTask("child").state === "ready", kernel.getTask("child").state);

  kernel.createDependentTask({
    taskId: "dependent",
    roleId: "qa-security",
    title: "child 결과 검증",
    scope: "child 산출물 검증",
    ownership: ["docs/qa"],
    dependsOn: ["child"],
    assignmentMessageId: "asg-dependent",
    assignmentBody: body("task_assignment"),
  });
  check("dependent pending", kernel.getTask("dependent").state === "pending", kernel.getTask("dependent").state);
  check(
    "ready 목록은 child 하나",
    JSON.stringify(kernel.listReady().map((t) => t.taskId)) === JSON.stringify(["child"]),
  );

  console.log("");
  console.log("== M4a: 5) kernel 인스턴스를 버리고 같은 run을 새로 연다 ==");
  const beforeRestart = kernel.getState();
  kernel = null;
  const reopened = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("state 복원 동일", JSON.stringify(reopened.getState()) === JSON.stringify(beforeRestart));
  check("복원 후 ready 동일", JSON.stringify(reopened.listReady().map((t) => t.taskId)) === JSON.stringify(["child"]));

  console.log("");
  console.log("== M4a: 6~7) child 실행 → artifact 등록 → result(summary + 포인터) 제출 ==");
  reopened.startTask("child");
  check("child running", reopened.getTask("child").state === "running", reopened.getTask("child").state);

  // M5b부터 `registerArtifact`가 **task 소유권을 집행**하므로 child는 자기 소유 경로(`src/exec/child`)에
  // 산출물을 낸다(이전 판의 `docs/child-output.md`는 child 소유 밖이었다 — `artifact_not_owned`).
  mkdirSync(join(workspace, "src", "exec", "child"), { recursive: true });
  writeFileSync(join(workspace, "src", "exec", "child", "child-output.md"), `# child 산출물\n${MARKER}\n`);
  const pointer = reopened.registerArtifact({ taskId: "child", path: "src/exec/child/child-output.md", role: "output" });
  check("artifact revision 1", pointer.revision === 1, String(pointer.revision));
  check("artifact sha256 기록", /^[0-9a-f]{64}$/.test(pointer.sha256));
  check("artifact producer 기록", pointer.producerTaskId === "child");

  reopened.submitResult({
    envelope: envelope("result", "child", "dev-lead", {
      messageId: "res-child",
      parentTaskId: "parent",
      artifactRefs: [pointer],
    }),
    body: body("result"),
    summary: "child 산출물 1건을 만들었고 검증은 dependent가 이어받는다.",
  });

  console.log("");
  console.log("== M4a: 8) child=completed · parent=ready · dependent=ready ==");
  check("child completed", reopened.getTask("child").state === "completed", reopened.getTask("child").state);
  check("parent ready", reopened.getTask("parent").state === "ready", reopened.getTask("parent").state);
  check("dependent ready", reopened.getTask("dependent").state === "ready", reopened.getTask("dependent").state);

  console.log("");
  console.log("== M4a: 9) 재시작 후 동일 ready 목록 · revision · artifact 포인터 · deterministic snapshot ==");
  const finalState = reopened.getState();
  const finalReady = reopened.listReady().map((t) => t.taskId);
  const finalSnapshot = reopened.rebuildSnapshot();

  const restarted = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("revision 동일", restarted.getState().revision === finalState.revision);
  check("state 전체 동일", JSON.stringify(restarted.getState()) === JSON.stringify(finalState));
  check("ready 목록 동일", JSON.stringify(restarted.listReady().map((t) => t.taskId)) === JSON.stringify(finalReady));
  check(
    "artifact 포인터 동일",
    JSON.stringify(restarted.getTask("child").artifactRefs) === JSON.stringify([pointer]),
  );
  check("snapshot 재생성 바이트 동일", restarted.rebuildSnapshot() === finalSnapshot);
  check("디스크 snapshot.md 동일", readFileSync(paths.snapshotFile, "utf8") === finalSnapshot);

  console.log("");
  console.log("== M4a: 10) raw artifact 본문·transcript가 state/snapshot/message index에 없음 ==");
  const stateText = readFileSync(paths.stateFile, "utf8");
  const artifactText = readFileSync(join(workspace, "src", "exec", "child", "child-output.md"), "utf8");
  check("artifact 본문에 marker 존재(대조군)", artifactText.includes(MARKER));
  check("run_state.json에 raw 본문 없음", !stateText.includes(MARKER));
  check("snapshot.md에 raw 본문 없음", !finalSnapshot.includes(MARKER));
  check("message index에 raw 본문 없음", !JSON.stringify(finalState.messages).includes(MARKER));
  check("state에 transcript 필드 없음", !/transcript/i.test(stateText));
  check("snapshot에 artifact 포인터 있음", finalSnapshot.includes("src/exec/child/child-output.md@1"));
  check(
    "snapshot에 bounded summary 있음",
    finalSnapshot.includes("child 산출물 1건을 만들었고 검증은 dependent가 이어받는다."),
  );
  check(
    "message body 전문은 messages/*.md에만 있음",
    readFileSync(join(paths.dir, "messages", "res-child.md"), "utf8").includes("## Work Performed") &&
      !stateText.includes("## Work Performed"),
  );

  console.log("");
  console.log("== M4a: 11) 문법적으로 유효한 run_state.json 편집은 kernel 우회에 실패한다(P0-1) ==");
  const forged = JSON.parse(stateText);
  const dependentIdx = forged.tasks.findIndex((t) => t.taskId === "dependent");
  forged.tasks[dependentIdx].state = "completed";
  forged.tasks[dependentIdx].resultSummary = "forged";
  writeFileSync(paths.stateFile, JSON.stringify(forged, null, 2));
  let forgeCode = "(수락됨)";
  try {
    openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID });
  } catch (e) {
    forgeCode = e && e.code ? e.code : String(e);
  }
  check("위조 state 거부(state_event_binding_mismatch)", forgeCode === "state_event_binding_mismatch", forgeCode);
  writeFileSync(paths.stateFile, stateText);
  check(
    "원상 복구 후 다시 열림",
    openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID }).getTask("dependent").state === "ready",
  );
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
console.log(` M4a offline acceptance: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
