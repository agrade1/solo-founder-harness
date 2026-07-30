#!/usr/bin/env node
/**
 * V3 M4b — exclusive resource class · deterministic scheduler · run writer lock offline acceptance.
 *
 * 네트워크·LLM·provider·TTY·git write 없이 임시 workspace 하나에서만 돈다.
 * `npm run build` 산출물(dist/exec/*)을 그대로 소비하며, 실패 시 exit 1이다.
 *
 * 시나리오(로드맵 M4 "완료" 항목의 배타 자원 class/scheduler 부분 = 대장 `B-3`/`B-4`):
 *   같은 class를 요구하는 ready 두 개 + 자원 없는 ready 하나 → 결정론적 schedule은 하나만 시작 →
 *   자원 없는 task는 같은 batch에서 함께 시작 → 재시작 후 점유·결정 동일 →
 *   holder 완료 시 class 해제 → 같은 revision의 두 kernel에서 lost update 없음 →
 *   보유 중인 writer lock은 mutation을 전이 0으로 거부.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
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

const RUN_ID = "m4b-acceptance";
const MILESTONE = "m4b";
const CLASS = "suite-lock";

const HEADINGS = {
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

const body = (type) => HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");

function makeClock() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 27, 0, 0, n++));
}

/**
 * M4c부터 run은 §8 승인 manifest에 bind된다. 이 시나리오가 만드는(또는 거부를 확인하려는)
 * root task를 전부 명시 승인해 둔다 — 승인 누락이 stale_writer·run_lock_held 판정을 가리지 않게 한다.
 */
const MANIFEST = {
  milestoneId: MILESTONE,
  approvedCommit: "b".repeat(40),
  writableRoots: ["src"],
  ownershipByTask: Object.fromEntries(
    ["a-stress", "b-live", "c-docs", "d-first", "e-second", "f-third", "g-blocked", "g-unblocked"].map((id) => [id, ["src"]]),
  ),
  allowedCommands: ["npm test"],
  allowedDependencies: [],
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

function seed(taskId, roleId, resourceClasses = []) {
  return {
    taskId,
    roleId,
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: [`src/${taskId}`],
    resourceClasses,
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
  };
}

/** run 디렉터리 전체의 파일별 hash — "전이 0" 단정용. */
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

const ids = (tasks) => tasks.map((t) => t.taskId);

let workspace = null;
try {
  const { createOrchestrationRun, openOrchestrationRun } = await import(join(DIST, "orchestrationKernel.js"));
  const { runPaths, acquireRunWriterLock, releaseRunWriterLock } = await import(join(DIST, "orchestrationStore.js"));

  workspace = mkdtempSync(join(tmpdir(), "m4b-acceptance-"));
  const paths = runPaths(workspace, RUN_ID);

  console.log("== M4b: 1) 같은 배타 class를 요구하는 ready 두 개 + 자원 없는 ready 하나 ==");
  let kernel = createOrchestrationRun({
    workspaceRoot: workspace,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: MANIFEST,
    clock: makeClock(),
  });
  kernel.createRootTask(seed("a-stress", "qa-security", [CLASS]));
  kernel.createRootTask(seed("b-live", "qa-security", [CLASS]));
  kernel.createRootTask(seed("c-docs", "pm"));
  check("ready 3건", JSON.stringify(ids(kernel.listReady())) === JSON.stringify(["a-stress", "b-live", "c-docs"]));
  check("a-stress가 class 선언", JSON.stringify(kernel.getTask("a-stress").resourceClasses) === JSON.stringify([CLASS]));
  check("b-live가 같은 class 선언", JSON.stringify(kernel.getTask("b-live").resourceClasses) === JSON.stringify([CLASS]));
  check("c-docs는 자원 요구 없음(병렬 안전)", JSON.stringify(kernel.getTask("c-docs").resourceClasses) === JSON.stringify([]));
  check(
    "state 파일에 선언이 durable하게 남음",
    readFileSync(paths.stateFile, "utf8").includes(`"${CLASS}"`),
  );
  check(
    "snapshot에 자원 선언이 보임",
    readFileSync(paths.snapshotFile, "utf8").includes(`- resourceClasses: ${CLASS}`),
  );

  console.log("");
  console.log("== M4b: 2~3) 결정론적 schedule은 같은 class 중 하나만 + 자원 없는 task는 같은 batch ==");
  const planned = ids(kernel.scheduleReady());
  check("schedule = [a-stress, c-docs]", JSON.stringify(planned) === JSON.stringify(["a-stress", "c-docs"]), String(planned));
  check("schedule 재호출도 동일(결정론)", JSON.stringify(ids(kernel.scheduleReady())) === JSON.stringify(planned));

  const revBeforeBatch = kernel.getState().revision;
  const started = ids(kernel.startScheduledBatch());
  check("batch가 두 task를 시작", JSON.stringify(started) === JSON.stringify(["a-stress", "c-docs"]), String(started));
  check("batch는 커밋 1회(revision +1)", kernel.getState().revision === revBeforeBatch + 1);
  check("a-stress running", kernel.getTask("a-stress").state === "running");
  check("c-docs running(자원 없는 task는 병렬 가능)", kernel.getTask("c-docs").state === "running");
  check("b-live는 ready로 유예(동시 실행 0)", kernel.getTask("b-live").state === "ready", kernel.getTask("b-live").state);
  check("점유 중에는 더 고를 것이 없다", JSON.stringify(ids(kernel.scheduleReady())) === JSON.stringify([]));
  check("직접 startTask도 같은 규칙(resource_conflict)", codeOf(() => kernel.startTask("b-live")) === "resource_conflict");
  check("거부 후에도 b-live ready", kernel.getTask("b-live").state === "ready");

  console.log("");
  console.log("== M4b: 4) 재시작 — durable state만으로 같은 점유·같은 schedule 결정 ==");
  const beforeRestart = kernel.getState();
  kernel = null;
  const reopened = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("state 복원 동일", JSON.stringify(reopened.getState()) === JSON.stringify(beforeRestart));
  check("점유 유지(a-stress running)", reopened.getTask("a-stress").state === "running");
  check("class 선언 유지", JSON.stringify(reopened.getTask("a-stress").resourceClasses) === JSON.stringify([CLASS]));
  check("재시작 후 schedule 결정 동일(빈 목록)", JSON.stringify(ids(reopened.scheduleReady())) === JSON.stringify([]));
  check("재시작 후에도 충돌 거부", codeOf(() => reopened.startTask("b-live")) === "resource_conflict");

  console.log("");
  console.log("== M4b: 5) holder 완료 → class 해제 → 대기 task가 schedulable ==");
  reopened.submitResult({
    envelope: {
      schemaVersion: "1",
      messageId: "res-a-stress",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "a-stress",
      parentTaskId: null,
      sender: "qa-security",
      recipient: "orchestrator",
      type: "result",
      createdAt: "2026-07-27T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
    },
    body: body("result"),
    summary: `a-stress 완료 — ${CLASS} 해제`,
  });
  check("a-stress completed", reopened.getTask("a-stress").state === "completed");
  check("해제 후 b-live가 schedulable", JSON.stringify(ids(reopened.scheduleReady())) === JSON.stringify(["b-live"]));
  check("b-live 시작 성공", ids(reopened.startScheduledBatch()).join(",") === "b-live");
  check("b-live running", reopened.getTask("b-live").state === "running");

  console.log("");
  console.log("== M4b: 6) 같은 revision에서 열린 두 kernel — lost update 없음 ==");
  const writerA = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  const writerB = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("두 kernel이 같은 revision에서 열림", writerA.getState().revision === writerB.getState().revision);

  writerA.createRootTask(seed("d-first", "dev-lead"));
  const afterFirst = fingerprint(paths.dir);
  check("첫 writer 커밋 성공", writerA.getTask("d-first") !== null);

  const staleCode = codeOf(() => writerB.createRootTask(seed("e-second", "dev-lead")));
  check("낡은 기준의 두 번째 커밋 거부(stale_writer)", staleCode === "stale_writer", staleCode);
  check("stale writer가 파일을 바꾸지 않음", fingerprint(paths.dir) === afterFirst);

  const afterStale = openOrchestrationRun({ workspaceRoot: workspace, runId: RUN_ID, clock: makeClock() });
  check("첫 writer 결과 온전", afterStale.getTask("d-first") !== null);
  check("stale writer의 task는 없음", afterStale.getTask("e-second") === null);
  check("다시 열면 정상 커밋 가능", afterStale.createRootTask(seed("f-third", "dev-lead")).taskId === "f-third");

  console.log("");
  console.log("== M4b: 7) 보유 중인 writer lock은 mutation을 전이 0으로 거부 ==");
  const held = acquireRunWriterLock(paths);
  const revBeforeLock = afterStale.getState().revision;
  const filesBeforeLock = fingerprint(paths.dir);
  const lockCode = codeOf(() => afterStale.createRootTask(seed("g-blocked", "dev-lead")));
  check("lock 보유 중 mutation 거부(run_lock_held)", lockCode === "run_lock_held", lockCode);
  check("두 번째 acquire도 대기 없이 거부", codeOf(() => acquireRunWriterLock(paths)) === "run_lock_held");
  check("revision 전이 0", afterStale.getState().revision === revBeforeLock);
  check("state/event/body 파일 전이 0", fingerprint(paths.dir) === filesBeforeLock);
  check("거부된 task는 만들어지지 않음", afterStale.getTask("g-blocked") === null);
  check(
    "남의 lock은 정리하지 않는다(run_lock_owner_mismatch)",
    codeOf(() => releaseRunWriterLock(paths, { file: paths.lockFile, nonce: "f".repeat(32) })) === "run_lock_owner_mismatch",
  );
  check("거부 후에도 lock 파일 보존", existsSync(paths.lockFile));

  releaseRunWriterLock(paths, held);
  check("해제 후 lock 파일 없음", !existsSync(paths.lockFile));
  check("해제 후 mutation 성공", afterStale.createRootTask(seed("g-unblocked", "dev-lead")).taskId === "g-unblocked");
  check("정상 커밋은 lock을 남기지 않는다", !existsSync(paths.lockFile));
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
console.log(` M4b offline acceptance: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
