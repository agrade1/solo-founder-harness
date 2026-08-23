/**
 * V3 M5c task 3C — **관리 프로세스 supervisor + `B-F1` 게이트** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/managedProcess.test.ts`
 *
 * 이 파일은 **이 저장소에서 처음으로 진짜 프로세스를 띄운다**(그전까지 spawn은 정확히 0이었다).
 * 띄우는 것은 전부 임시 디렉터리 안의 짧은 `/bin/sh` fixture이고 네트워크·LLM·provider·git·설치는 없다.
 *
 * 덮는 계약:
 * - `B-F1` ① 권능은 **정확히 한 번** 소비된다(재생은 `process_capability_spent`이고, 위조·전개 사본은
 *   `process_capability_invalid`다 — grant 상태에 가려지지 않는다).
 * - `B-F1` ② 살아 있는 pending/grant가 필요하다(구조적으로 재구성한 grant·권능은 spawn에 닿지 못한다).
 * - `B-F1` ③ durable 상태를 다시 읽는다(낡은 in-memory 관점으로는 승인되지 않는다).
 * - `B-F1` ④ **spawn 직전** node·entrypoint digest를 재검증한다 — 승인 이후 바뀐 digest는 **spawn 0**이다.
 * - `B-F1` ⑤ 표시(`attemptedAt`) → 재확인 → 효과 순서이고, 불확실은 `outcome_unknown`으로만 닫힌다.
 * - spawn 상한(task당 child 4)을 **spawn 전에** 닫는다.
 * - deadline 종료 시 **자손이 하나도 살아남지 않는다**(프로세스 그룹 정리).
 * - 정리 미확인이 1차 오류를 이긴다(B1).
 */
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { MANAGED_PROCESS_ENV } from "./managedProcess.js";
import { GIT_SANITIZED_ENV } from "./executionBoundary.js";
import { renameSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIMITS,
  ORCHESTRATION_SCHEMA_VERSION,
  ORCHESTRATOR_ID,
  OrchestrationError,
  REQUIRED_BODY_HEADINGS,
  type OperationReceipt,
} from "./orchestrationTypes.js";
import type { AgentMessageType } from "./orchestrationTypes.js";
import {
  OrchestrationKernel,
  executeRunProcessOperation,
  executeWorktreeOperation,
  resolveWorktreeCapability,
  type WorktreeCapability,
  isGenuineLaunchCapability,
  resolveProcessLaunchCapability,
  type OperationDispatchPermit,
  type OperationExecutionGrant,
  type PreflightDecision,
  type ProcessLaunchCapability,
  type TaskSeed,
} from "./orchestrationKernel.js";
import type { TypedGitWorktreeOperation, TypedRunProcessOperation } from "./typedPlan.js";
import { superviseProcess } from "./managedProcess.js";

const RUN_ID = "run-1";
const MILESTONE = "m5c";
const T0 = Date.UTC(2026, 6, 30, 0, 0, 0);
const EXPIRES = "2026-12-31T00:00:00.000Z";

const tmpRoots: string[] = [];
function makeDir(prefix: string): string {
  // macOS의 `/var/folders/...`는 symlink 뒤에 있다 — `verifyApprovedExecutable`은 **정규 경로**를 요구한다.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과를 바꾸지 않는다 */
    }
  }
});

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 실행 가능한 `/bin/sh` fixture 하나(정규 경로 · 일반 파일 · 실행 비트 · group/other 쓰기 없음). */
function writeExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

/**
 * 승인된 "node" 자리에 놓는 최소 fixture. 진짜 node를 해싱하면 spawn마다 수십 MB를 읽으므로
 * (그리고 테스트가 느려지므로) 같은 계약을 만족하는 짧은 실행 파일을 쓴다:
 * 첫 인자로 받은 entrypoint를 나머지 인자와 함께 실행한다.
 */
const FAKE_NODE = '#!/bin/sh\nexec /bin/sh "$@"\n';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
  return "no-error";
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
  return "no-error";
}

function body(type: AgentMessageType): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}.${++counter}`;

function seed(taskId: string): TaskSeed {
  return {
    taskId,
    roleId: "tech-lead",
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: ["docs"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
  };
}

interface Fixture {
  ws: string;
  bin: string;
  nodePath: string;
  entrypoint: string;
  kernel: OrchestrationKernel;
}

/**
 * 진짜 kernel run 하나 + 승인 manifest가 가리키는 **실재하는** node/entrypoint fixture.
 * `entrypointBody`가 이 run의 모든 `run_process`가 실제로 실행하는 프로그램이다.
 */
function fixture(
  opts: {
    entrypointBody: string;
    timeoutMs?: number;
    taskIds?: string[];
    maxSessions?: number;
    /** V3 M9 선결 1 — 기본 `validate-plan` 대신 다른 승인 action을 쓰는 fixture(같은 authorityId). */
    action?: { action: string; data: Record<string, string> };
  } = {
    entrypointBody: "#!/bin/sh\nexit 0\n",
  },
): Fixture {
  const taskIds = opts.taskIds ?? ["root"];
  const ws = makeDir("m5c-mp-ws-");
  mkdirSync(join(ws, "docs"));
  const bin = makeDir("m5c-mp-bin-");
  const nodePath = writeExecutable(bin, "node", FAKE_NODE);
  const entrypoint = writeExecutable(bin, "controller.sh", opts.entrypointBody);

  const manifest = {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs"],
    ownershipByTask: Object.fromEntries(taskIds.map((id) => [id, ["docs"]])),
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: entrypoint, sha256: sha256File(entrypoint) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: nodePath, sha256: sha256File(nodePath) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 600_000,
      maxAttemptElapsedMs: 3_000_000,
      cleanupTermGraceMs: 2_000,
      cleanupKillGraceMs: 2_000,
    },
    operationAuthorityByTask: Object.fromEntries(
      taskIds.map((id) => [
        id,
        [
          {
            authorityId: "p-node",
            kind: "run_process",
            ...(opts.action ?? { action: "validate-plan", data: { planPath: "docs/plan.json" } }),
            timeoutMs: opts.timeoutMs ?? 30_000,
          },
        ],
      ]),
    ),
    maxSessions: opts.maxSessions ?? 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: EXPIRES,
  };

  // durable 시각은 단조여야 한다 — 호출마다 1ms 전진하는 결정론적 clock.
  let n = 0;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest,
    clock: () => new Date(T0 + n++),
  });
  kernel.createRootTask(seed("root"));

  const batch = kernel.planRunnableBatch();
  const decisions: PreflightDecision[] = batch.items.map((t) => ({
    taskId: t.taskId,
    outcome: "prepared" as const,
    attemptId: nextId("att"),
  }));
  kernel.commitPreflightBatch({ baseRevision: batch.revision, actionId: nextId("act"), decisions });
  kernel.startPreparedTask({
    taskId: "root",
    actionId: nextId("act"),
    leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
  });

  return { ws, bin, nodePath, entrypoint, kernel };
}

function processOp(operationId: string): Record<string, unknown> {
  return { operationId, kind: "run_process", authorityId: "p-node" };
}

/** permit(claim) → 권위 과금 → grant. 계약 순서 그대로다. */
function permitFor(f: Fixture, operationIds: string[], turnId: string, taskId = "root"): OperationDispatchPermit {
  const task = f.kernel.getTask(taskId)!;
  const permit = f.kernel.issueOperationDispatchPermit({
    taskId,
    turnId,
    actionId: nextId("act"),
    plan: {
      schemaVersion: "1",
      runId: RUN_ID,
      taskId,
      attemptId: task.execution.attemptId,
      turnId,
      operations: operationIds.map(processOp),
      result: { summary: "한 turn의 결과 요약", outputs: [] },
    },
  });
  f.kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  return permit;
}

interface Launchable {
  op: TypedRunProcessOperation;
  grant: OperationExecutionGrant;
  cap: ProcessLaunchCapability;
}

function launchable(f: Fixture, permit: OperationDispatchPermit, index = 0): Launchable {
  const op = permit.plan.operations[index] as TypedRunProcessOperation;
  const grant = f.kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") });
  return { op, grant, cap: resolveProcessLaunchCapability(op, grant) };
}

/** 한 turn = 한 계획. operation 하나짜리 turn을 새로 열어 바로 실행 가능한 상태로 만든다. */
function oneShot(f: Fixture, turnId: string, operationId = "op-1", taskId = "root"): Launchable {
  return launchable(f, permitFor(f, [operationId], turnId, taskId));
}

/** ready task 하나를 preflight → running으로 올린다(유일한 시작 경로). */
function startTask(f: Fixture, taskId: string): void {
  const batch = f.kernel.planRunnableBatch();
  f.kernel.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) =>
      t.taskId === taskId
        ? { taskId: t.taskId, outcome: "prepared" as const, attemptId: nextId("att") }
        : { taskId: t.taskId, outcome: "deferred" as const },
    ),
  });
  f.kernel.startPreparedTask({
    taskId,
    actionId: nextId("act"),
    leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
  });
}

/** parent의 spawn_request로 child task를 만들고 running까지 올린다. */
function spawnChild(f: Fixture, parentId: string, childId: string): void {
  f.kernel.requestSpawn({
    envelope: {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      messageId: `spawn-${childId}`,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: parentId,
      parentTaskId: f.kernel.getTask(parentId)!.parentTaskId,
      sender: f.kernel.getTask(parentId)!.roleId,
      recipient: ORCHESTRATOR_ID,
      type: "spawn_request",
      createdAt: "2026-07-27T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
    },
    body: body("spawn_request"),
    child: { ...seed(childId), roleId: `dev-lead.${childId}` },
  });
  startTask(f, childId);
}

/**
 * 이 task의 durable `run_process` 수를 n개 늘린다 — **spawn 없이**. operation을 열고
 * `failOperation`으로 정직하게 닫으면 `run_process` 영수증이 남고, 상한은 영수증 + pending을
 * durable에서 세므로 카운트에 그대로 들어간다(pending으로 남기면 task가 waiting_children이 될 수 없다).
 */
function fillProcessCount(f: Fixture, taskId: string, n: number): void {
  const permit = permitFor(f, Array.from({ length: n }, (_, i) => `${taskId}-p${i}`), `turn-${taskId}-fill`, taskId);
  for (let i = 0; i < n; i++) {
    const { grant } = launchable(f, permit, i);
    f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" });
  }
}

/** 이 run의 durable `run_process` 총수(영수증 + pending) — 커널이 세는 것과 같은 방식이다. */
function runProcessCount(f: Fixture): number {
  return f.kernel.getState().tasks.reduce(
    (sum, t) =>
      sum +
      t.execution.operationReceipts.filter((r) => r.kind === "run_process").length +
      t.execution.pendingOperations.filter((p) => p.kind === "run_process").length,
    0,
  );
}

function receiptOf(f: Fixture, operationId: string): OperationReceipt {
  const r = f.kernel.getTask("root")!.execution.operationReceipts.find((x) => x.operationId === operationId);
  assert.ok(r, `영수증 ${operationId}이 durable에 없다`);
  return r;
}

/** handle 없는 정합화(재시작 안전 경로) — durable pending에서 신원을 그대로 읽어 넣는다. */
function reconcile(f: Fixture, operationId: string): void {
  const p = f.kernel.getTask("root")!.execution.pendingOperations.find((x) => x.operationId === operationId)!;
  f.kernel.reconcileUncertainOperation({
    runId: RUN_ID,
    taskId: "root",
    attemptId: p.attemptId,
    turnId: p.turnId,
    planDigest: p.planDigest,
    operationId: p.operationId,
    kind: p.kind,
    authorityId: p.authorityId,
    actionId: nextId("act"),
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 정상 경로: 진짜 spawn 1건 ────────────────────────────────────────────────

test("[M5c/3C] B-F1 개봉: 승인된 run_process가 실제로 실행되고 exit code가 영수증에 남는다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\necho "$2" > docs/spawned.txt\nexit 7\n' });
  const { op, grant, cap } = oneShot(f, "turn-1");

  const outcome = await executeRunProcessOperation(grant, op, cap);

  assert.equal(outcome.marker, "applied");
  assert.equal(outcome.exitCode, 7);
  assert.equal(outcome.path, null);
  assert.equal(outcome.resultSha256, null);
  // **진짜로 돌았다**: fixture가 승인된 action/planPath를 받아 파일을 남겼다.
  assert.equal(readFileSync(join(f.ws, "docs/spawned.txt"), "utf8").trim(), "docs/plan.json");

  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  const receipt = receiptOf(f, op.operationId);
  assert.equal(receipt.marker, "applied");
  assert.equal(receipt.kind, "run_process");
  assert.equal(receipt.exitCode, 7);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 0);
});

test("[M9] 선결 1: 승인된 run-tests가 실제로 실행되고 인자는 [action, 승인된 경로] 뿐이다", async () => {
  // entrypoint가 **받은 인자 전부**를 그대로 적는다 — 승인 문서 밖의 flag·argv가 새면 여기서 보인다.
  const f = fixture({
    entrypointBody: '#!/bin/sh\nprintf "%s\\n" "$#" "$@" > docs/argv.txt\nexit 3\n',
    action: { action: "run-tests", data: { projectPath: "docs/proj" } },
  });
  const { op, grant, cap } = oneShot(f, "turn-1");

  const outcome = await executeRunProcessOperation(grant, op, cap);

  assert.equal(outcome.marker, "applied");
  assert.equal(outcome.exitCode, 3);
  // 인자는 **정확히 둘**이다: 닫힌 action enum + 승인 레코드의 경로. 테스트 명령·러너·flag는 없다.
  assert.deepEqual(readFileSync(join(f.ws, "docs/argv.txt"), "utf8").trim().split("\n"), ["2", "run-tests", "docs/proj"]);

  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  const receipt = receiptOf(f, op.operationId);
  assert.equal(receipt.kind, "run_process");
  assert.equal(receipt.exitCode, 3);
});

test("[M9] 선결 1: run-tests도 실패 exit code를 성공으로 덮지 않는다(거짓 성공 영수증 0)", async () => {
  // 로드맵 M9 위험 3 — "테스트를 실행했다"는 기록과 실제 종료코드가 어긋나면 그것이 곧 A급이다.
  const f = fixture({
    entrypointBody: "#!/bin/sh\nexit 1\n",
    action: { action: "run-tests", data: { projectPath: "docs/proj" } },
  });
  const { op, grant, cap } = oneShot(f, "turn-1");
  const outcome = await executeRunProcessOperation(grant, op, cap);
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });

  // `marker: applied`는 "프로세스가 끝까지 돌았다"는 뜻이고 **테스트가 통과했다는 뜻이 아니다**.
  // 실패 종료코드는 영수증에 그대로 남아야 한다 — 이 값이 durable에서 사라지면 거짓 영수증이다.
  assert.equal(receiptOf(f, op.operationId).exitCode, 1);
});

// ── V3 M9 T3③ 격리 worktree ─────────────────────────────────────────────────

/**
 * worktree fixture: **진짜 git 저장소** 하나 + 승인 manifest가 그 HEAD를 `approvedCommit`으로 가리킨다.
 * `gitBody`를 주면 그 shell 스크립트가 git 자리에 들어간다(인자 기록용).
 */
function worktreeFixture(opts: { gitBody?: string } = {}): Fixture & { gitPath: string; commit: string } {
  const ws = makeDir("m9-wt-ws-");
  mkdirSync(join(ws, "docs"));
  const bin = makeDir("m9-wt-bin-");
  const nodePath = writeExecutable(bin, "node", FAKE_NODE);
  const entrypoint = writeExecutable(bin, "controller.sh", "#!/bin/sh\nexit 0\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const run = (args: string[]): void => {
    const r = spawnSync("/usr/bin/git", args, { cwd: ws, env, stdio: "ignore" });
    assert.equal(r.status, 0, `git ${args.join(" ")} 실패`);
  };
  run(["init", "-q", "-b", "main"]);
  run(["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  const head = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: ws, env, encoding: "utf8" });
  assert.equal(head.status, 0);
  const commit = head.stdout.trim();

  const gitPath = opts.gitBody === undefined ? "/usr/bin/git" : writeExecutable(bin, "git", opts.gitBody);
  const manifest = {
    milestoneId: MILESTONE,
    approvedCommit: commit,
    writableRoots: ["docs"],
    ownershipByTask: { root: ["docs"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: entrypoint, sha256: sha256File(entrypoint) },
      git: { path: gitPath, sha256: sha256File(gitPath) },
      node: { path: nodePath, sha256: sha256File(nodePath) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 600_000,
      maxAttemptElapsedMs: 3_000_000,
      cleanupTermGraceMs: 2_000,
      cleanupKillGraceMs: 2_000,
    },
    operationAuthorityByTask: {
      root: [
        { authorityId: "wt-add", kind: "git_worktree", action: "add" },
        { authorityId: "wt-remove", kind: "git_worktree", action: "remove" },
      ],
    },
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: EXPIRES,
  };
  let n = 0;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest,
    clock: () => new Date(T0 + n++),
  });
  kernel.createRootTask(seed("root"));
  const batch = kernel.planRunnableBatch();
  kernel.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: nextId("att") })),
  });
  kernel.startPreparedTask({
    taskId: "root",
    actionId: nextId("act"),
    leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
  });
  return { ws, bin, nodePath, entrypoint, kernel, gitPath, commit };
}

/** worktree operation 하나짜리 turn. */
function worktreeShot(f: Fixture, authorityId: string, turnId: string): { op: TypedGitWorktreeOperation; grant: OperationExecutionGrant; cap: WorktreeCapability } {
  const task = f.kernel.getTask("root")!;
  const permit = f.kernel.issueOperationDispatchPermit({
    taskId: "root",
    turnId,
    actionId: nextId("act"),
    plan: {
      schemaVersion: "1",
      runId: RUN_ID,
      taskId: "root",
      attemptId: task.execution.attemptId,
      turnId,
      operations: [{ operationId: nextId("op"), kind: "git_worktree", authorityId }],
      result: { summary: "worktree turn", outputs: [] },
    },
  });
  f.kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  const op = permit.plan.operations[0] as TypedGitWorktreeOperation;
  const grant = f.kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") });
  return { op, grant, cap: resolveWorktreeCapability(op, grant) };
}

test("[M9] T3③: 승인된 worktree add가 실제로 격리 checkout을 만들고 remove가 지운다", async () => {
  const f = worktreeFixture();
  // 경로 규칙은 **여기서 독립적으로 다시 적는다**(kernel 상수를 공유하면 규칙이 바뀌어도 따라 바뀐다).
  const expected = join(f.ws, ".harness", "worktrees", RUN_ID, "root");

  const add = worktreeShot(f, "wt-add", "turn-1");
  const outcome = await executeWorktreeOperation(add.grant, add.op, add.cap);
  assert.equal(outcome.marker, "applied");
  assert.equal(outcome.exitCode, 0);
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });

  // **진짜 linked worktree다**: `.git`이 디렉터리가 아니라 gitdir 포인터 파일이다.
  assert.ok(lstatSync(expected).isDirectory(), "worktree 디렉터리가 없다");
  assert.ok(lstatSync(join(expected, ".git")).isFile(), "linked worktree가 아니다");
  // **승인된 커밋에 detach돼 있다** — 브랜치를 만들지 않았다.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const head = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: expected, env, encoding: "utf8" });
  assert.equal(head.stdout.trim(), f.commit, "승인된 커밋이 아닌 곳에 checkout됐다");
  const branch = spawnSync("/usr/bin/git", ["symbolic-ref", "-q", "HEAD"], { cwd: expected, env, encoding: "utf8" });
  assert.notEqual(branch.status, 0, "브랜치를 만들었다(--detach가 아니다)");

  const rm = worktreeShot(f, "wt-remove", "turn-2");
  const removed = await executeWorktreeOperation(rm.grant, rm.op, rm.cap);
  assert.equal(removed.marker, "applied");
  f.kernel.recordOperationReceipt({ outcome: removed, actionId: nextId("act") });
  assert.equal(lstatSync(expected, { throwIfNoEntry: false }), undefined, "worktree가 지워지지 않았다");
});

test("[M9] T3③: git 인자에 브랜치·remote·refspec이 없고 경로·커밋은 durable에서 파생된다", async () => {
  // 인자를 그대로 적는 fake git. 승인 문서가 담을 수 없는 것이 실제로 argv에도 없는지 본다.
  const f = worktreeFixture({ gitBody: '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/argv.txt"\nexit 0\n' });
  const add = worktreeShot(f, "wt-add", "turn-1");
  await executeWorktreeOperation(add.grant, add.op, add.cap);

  const argv = readFileSync(join(f.ws, "argv.txt"), "utf8").trim().split("\n");
  assert.ok(argv.includes("worktree") && argv.includes("add"), "worktree add가 아니다");
  assert.ok(argv.includes("--detach"), "브랜치를 만들지 않는다는 보장이 argv에 없다");
  assert.ok(argv.includes(join(f.ws, ".harness", "worktrees", RUN_ID, "root")), "경로가 durable 파생값이 아니다");
  assert.ok(argv.includes(f.commit), "체크아웃 커밋이 approvedCommit이 아니다");
  // **원격·브랜치 계열은 어디에도 없다.**
  for (const forbidden of ["-b", "-B", "--track", "origin", "--branch", "fetch", "push", "remote", "clone", "merge", "commit", "--reference"]) {
    assert.equal(argv.includes(forbidden), false, `argv에 ${forbidden}이 있다`);
  }
  // hook·fsmonitor·pager를 끄는 고정 전치 인자가 그대로 붙는다.
  assert.ok(argv.includes("core.hooksPath=/dev/null"), "hook 차단 전치 인자가 사라졌다");
});

test("[M9] T3③ 리뷰 A: 실패한 worktree 명령은 성공 영수증이 되지 않는다(거짓 성공 0)", async () => {
  // **이전 판의 A급 결함**: `terminatedBy === "exit"`만 보고 `marker: "applied"`를 만들었다 →
  // `git worktree add`가 exit 128로 실패해도(경로 점유·커밋 부재·잔재) "만들었다"는 durable 영수증이
  // 남고, 같은 operationId는 `operation_already_recorded`로 **영구 봉인**됐다(로드맵 M9 위험 3).
  const f = worktreeFixture();
  const expected = join(f.ws, ".harness", "worktrees", RUN_ID, "root");

  // ⓐ 같은 경로를 미리 점유해 `worktree add`를 실제로 실패시킨다(exit 128).
  mkdirSync(expected, { recursive: true });
  writeFileSync(join(expected, "squatter.txt"), "이미 있다\n");
  const add = worktreeShot(f, "wt-add", "turn-1");
  assert.equal(
    await codeOfAsync(() => executeWorktreeOperation(add.grant, add.op, add.cap)),
    "process_result_unknown",
    "실패한 worktree add가 성공으로 접혔다",
  );
  // **성공 영수증이 없다** — pending은 attempted로 남아 정합화로만 닫힌다(부분 상태가 있을 수 있다).
  const pend = f.kernel.getTask("root")!.execution.pendingOperations;
  assert.equal(f.kernel.getTask("root")!.execution.operationReceipts.length, 0, "실패가 영수증으로 남았다");
  assert.equal(pend.length, 1);
  assert.notEqual(pend[0].attemptedAt, null, "집행 경계 진입이 durable하지 않다");
  // 경쟁자 파일은 그대로다(우리가 지우지 않았다).
  assert.equal(readFileSync(join(expected, "squatter.txt"), "utf8"), "이미 있다\n");

  // ⓑ **존재하지 않는 worktree remove도 성공이 아니다**("정리했다"는 거짓 기록 0).
  const g = worktreeFixture();
  const rm = worktreeShot(g, "wt-remove", "turn-1");
  assert.equal(
    await codeOfAsync(() => executeWorktreeOperation(rm.grant, rm.op, rm.cap)),
    "process_result_unknown",
  );
  assert.equal(g.kernel.getTask("root")!.execution.operationReceipts.length, 0);
});

test("[M9] T3③ 리뷰 B-2: linked worktree 루트에서는 worktree를 만들지 않는다(변경이 승인 루트 밖에 남는다)", async () => {
  // `verifyApprovedRepoRoot`는 읽기 질의 시절 규칙이라 `.git`이 **일반 파일**인 루트(그 자체가 linked
  // worktree)도 통과시킨다. 거기서 add하면 등록·metadata가 **main clone의 `.git/worktrees/`**, 즉
  // manifest가 이름한 적 없는 디렉터리에 남는다.
  const f = worktreeFixture();
  // workspaceRoot의 `.git`을 디렉터리에서 파일로 바꿔 linked worktree 모양을 만든다.
  const dotGit = join(f.ws, ".git");
  renameSync(dotGit, join(f.ws, ".git-real"));
  writeFileSync(dotGit, `gitdir: ${join(f.ws, ".git-real")}\n`);
  const add = worktreeShot(f, "wt-add", "turn-1");
  assert.equal(
    await codeOfAsync(() => executeWorktreeOperation(add.grant, add.op, add.cap)),
    "process_executable_untrusted",
    "linked worktree 루트에서 변경이 통과했다",
  );
  assert.equal(lstatSync(join(f.ws, ".harness"), { throwIfNoEntry: false }), undefined, "거부인데 worktree가 생겼다");
});

test("[M9] T3③ 리뷰 B-1: 고정 env가 partial clone lazy fetch를 끈다", () => {
  // argv에 `fetch`가 없어도 checkout은 object를 물리적으로 요구하므로 partial clone에서는 git이
  // **내부에서** 원격에 닿는다. argv 계약만으로 "네트워크 0"이 성립하지 않는다는 뜻이라 env로 끈다.
  assert.equal(MANAGED_PROCESS_ENV.GIT_NO_LAZY_FETCH, "1", "lazy fetch 차단이 고정 env에서 사라졌다");
  // **호출자별 env 오버라이드 표면을 열지 않았다**: `SupervisedLaunch`에 `env` key가 없다
  // (있으면 임의 env 주입 통로가 되고, 이 상수가 닫혀 있다는 성질이 무너진다).
  assert.equal(Object.keys(MANAGED_PROCESS_ENV).includes("env"), false);
});

test("[M9] T3③ 리뷰 C-1: worktree도 프로세스 상한에 포함된다(회계가 실제 프로세스 수와 맞는다)", async () => {
  // `git_worktree`도 `superviseProcess`로 자식을 띄운다 — `launchedProcesses`에서 빠져 있으면 상한이
  // 실제 프로세스 수보다 느슨해진다. **상한 자체로 판별한다**(테스트가 직접 세면 공허하다).
  const f = worktreeFixture();
  // task당 child 상한은 4다 → add/remove를 번갈아 4번 성공시키고 5번째가 spawn 전에 닫히는지 본다.
  for (let i = 0; i < 4; i++) {
    const shot = worktreeShot(f, i % 2 === 0 ? "wt-add" : "wt-remove", `turn-${i}`);
    const outcome = await executeWorktreeOperation(shot.grant, shot.op, shot.cap);
    f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  }
  const fifth = worktreeShot(f, "wt-add", "turn-4");
  assert.equal(
    await codeOfAsync(() => executeWorktreeOperation(fifth.grant, fifth.op, fifth.cap)),
    "process_spawn_limit_exceeded",
    "worktree가 프로세스 상한에 잡히지 않는다",
  );
});

test("[M9] T3③: 승인되지 않은 worktree 권능·재생·위조는 저장소를 건드리지 못한다", async () => {
  const f = worktreeFixture();
  const expected = join(f.ws, ".harness", "worktrees", RUN_ID, "root");
  const add = worktreeShot(f, "wt-add", "turn-1");

  // ⓐ 위조·전개 사본 권능은 조회에서 죽는다(파일 시스템 효과 0).
  for (const forged of [{ ...add.cap }, {}, null, () => add.cap]) {
    assert.equal(
      await codeOfAsync(() => executeWorktreeOperation(add.grant, add.op, forged)),
      "process_capability_invalid",
    );
  }
  assert.equal(lstatSync(join(f.ws, ".harness"), { throwIfNoEntry: false }), undefined, "거부인데 worktree가 생겼다");

  // ⓑ 진짜 짝은 통과한다(대조군).
  const outcome = await executeWorktreeOperation(add.grant, add.op, add.cap);
  assert.equal(outcome.marker, "applied");
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  assert.ok(lstatSync(expected).isDirectory());

  // ⓒ 같은 권능 재생은 거부다.
  assert.equal(await codeOfAsync(() => executeWorktreeOperation(add.grant, add.op, add.cap)), "process_capability_spent");
});

// ── B-F1 ① 단일 소비 ────────────────────────────────────────────────────────

test("[M5c/3C] B-F1 ①: 같은 권능으로 두 번째 실행은 process_capability_spent다(재생 불가)", async () => {
  const f = fixture({ entrypointBody: "#!/bin/sh\nexit 0\n" });
  const { op, grant, cap } = oneShot(f, "turn-1");
  const outcome = await executeRunProcessOperation(grant, op, cap);
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });

  // 권능 게이트가 **가장 먼저**다: grant 소진에 가려지지 않고 자기 코드로 보고된다.
  assert.equal(
    await codeOfAsync(() => executeRunProcessOperation(grant, op, cap)),
    "process_capability_spent",
  );
  // 같은 grant에서 새 권능을 다시 mint해도 grant 쪽에서 닫힌다(두 게이트 모두 살아 있다).
  const fresh = resolveProcessLaunchCapability(op, grant);
  assert.equal(await codeOfAsync(() => executeRunProcessOperation(grant, op, fresh)), "dispatch_grant_spent");
  assert.equal(f.kernel.getTask("root")!.execution.operationReceipts.length, 1);
});

test("[M5c/3C] B-F1 ①/②: 위조·재구성한 권능과 grant는 spawn에 닿지 못한다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\necho x > docs/spawned.txt\n' });
  const { op, grant, cap } = oneShot(f, "turn-1");

  const forged: unknown[] = [
    { ...cap },
    Object.freeze({ ...cap }),
    new Proxy({ ...cap }, {}),
    JSON.parse(JSON.stringify(cap)),
    null,
    "cap",
  ];
  for (const bad of forged) {
    assert.equal(
      await codeOfAsync(() => executeRunProcessOperation(grant, op, bad)),
      "process_capability_invalid",
      JSON.stringify(bad) ?? "?",
    );
  }
  assert.equal(isGenuineLaunchCapability(cap), true);
  assert.equal(isGenuineLaunchCapability({ ...cap }), false);

  // 구조적으로 재구성한 grant도 마찬가지다(살아 있는 등록부 연결만이 권위다).
  assert.equal(await codeOfAsync(() => executeRunProcessOperation({ ...grant }, op, cap)), "dispatch_grant_invalid");

  // 위 거부들은 전부 **효과 0**이다.
  assert.equal(existsSync(join(f.ws, "docs/spawned.txt")), false);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations[0]!.attemptedAt, null);
  // 권능은 아직 소비되지 않았으므로 정상 경로가 그대로 열려 있다.
  const ok = await executeRunProcessOperation(grant, op, cap);
  assert.equal(ok.marker, "applied");
});

test("[M5c/3C] B-F1 ①: 다른 operation에 발급된 권능은 이 grant로 쓸 수 없다", async () => {
  const f = fixture();
  const permit = permitFor(f, ["op-1", "op-2"], "turn-1");
  const a = launchable(f, permit, 0);
  const b = launchable(f, permit, 1);

  // a.cap은 **아직 소비되지 않았다** — 거부 사유는 소진이 아니라 신원 결속이다.
  assert.equal(await codeOfAsync(() => executeRunProcessOperation(b.grant, b.op, a.cap)), "process_capability_invalid");
  assert.equal(isGenuineLaunchCapability(a.cap), true);
  // 제 짝으로는 그대로 실행된다.
  assert.equal((await executeRunProcessOperation(a.grant, a.op, a.cap)).marker, "applied");
});

// ── B-F1 ③/④ durable 재독 + spawn 직전 digest 재검증 ────────────────────────

test("[M5c/3C] B-F1 ④: 승인과 spawn 사이에 entrypoint가 바뀌면 spawn 0으로 중단한다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\necho x > docs/spawned.txt\n' });
  const { op, grant, cap } = oneShot(f, "turn-1");

  // 권능을 이미 발급받은 뒤 승인된 entrypoint 바이트를 바꾼다(같은 경로·같은 inode 덮어쓰기).
  writeFileSync(f.entrypoint, '#!/bin/sh\necho evil > docs/spawned.txt\n');
  chmodSync(f.entrypoint, 0o755);

  assert.equal(await codeOfAsync(() => executeRunProcessOperation(grant, op, cap)), "process_digest_mismatch");
  assert.equal(existsSync(join(f.ws, "docs/spawned.txt")), false, "spawn이 일어나면 안 된다");

  // A4: 표시는 이미 durable하므로 그 pending은 **불확실**로만 닫힌다.
  const pending = f.kernel.getTask("root")!.execution.pendingOperations[0]!;
  assert.notEqual(pending.attemptedAt, null);
  assert.equal(
    codeOf(() => f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" })),
    "operation_attempt_uncertain",
  );
  reconcile(f, op.operationId);
  assert.equal(receiptOf(f, op.operationId).marker, "outcome_unknown");
});

test("[M5c/3C] B-F1 ④: node 바이너리가 바뀌어도 spawn 0으로 중단한다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\necho x > docs/spawned.txt\n' });
  const { op, grant, cap } = oneShot(f, "turn-1");
  writeFileSync(f.nodePath, '#!/bin/sh\nexec /bin/sh "$@"\n# changed\n');
  chmodSync(f.nodePath, 0o755);

  assert.equal(await codeOfAsync(() => executeRunProcessOperation(grant, op, cap)), "process_digest_mismatch");
  assert.equal(existsSync(join(f.ws, "docs/spawned.txt")), false);
});

test("[M5c/3C] B-F1 ③: durable 상태가 running을 떠나면 낡은 handle로 실행되지 않는다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\necho x > docs/spawned.txt\n' });
  const { op, grant, cap } = oneShot(f, "turn-1");
  // pending을 정직하게 닫고 attempt를 끝낸다 → durable state가 바뀐다.
  f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" });
  f.kernel.recordTerminal({ taskId: "root", actionId: nextId("act"), marker: "cancelled" });

  const code = await codeOfAsync(() => executeRunProcessOperation(grant, op, cap));
  assert.equal(code, "dispatch_grant_spent");
  assert.equal(existsSync(join(f.ws, "docs/spawned.txt")), false);
});

// ── spawn 상한 ──────────────────────────────────────────────────────────────

test("[M5c/3C] spawn 상한: task당 child 4를 넘는 5번째 실행은 spawn 전에 닫힌다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\necho "$$" >> docs/launches.txt\nexit 0\n' });
  assert.equal(LIMITS.maxChildrenPerTask, 4);

  for (let i = 1; i <= LIMITS.maxChildrenPerTask; i++) {
    const l = oneShot(f, `turn-${i}`, `op-${i}`);
    const outcome = await executeRunProcessOperation(l.grant, l.op, l.cap);
    f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  }
  const before = readFileSync(join(f.ws, "docs/launches.txt"), "utf8").trim().split("\n");
  assert.equal(before.length, LIMITS.maxChildrenPerTask);

  const fifth = oneShot(f, "turn-5", "op-5");
  assert.equal(
    await codeOfAsync(() => executeRunProcessOperation(fifth.grant, fifth.op, fifth.cap)),
    "process_spawn_limit_exceeded",
  );
  // **spawn 전에** 닫혔다: 새 프로세스도, durable 표시도 없다.
  assert.equal(readFileSync(join(f.ws, "docs/launches.txt"), "utf8").trim().split("\n").length, 4);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations[0]!.attemptedAt, null);
});

test("[M5c/3C] spawn 상한: depth 3(root=0)에서는 실행되고, depth 4 task는 애초에 만들어지지 않는다", async () => {
  assert.equal(LIMITS.maxDepth, 3);
  const chain = ["root", "d1", "d2", "d3"];
  const f = fixture({
    entrypointBody: '#!/bin/sh\necho ran > docs/deep.txt\nexit 0\n',
    taskIds: chain,
    maxSessions: chain.length,
  });
  for (let i = 1; i < chain.length; i++) spawnChild(f, chain[i - 1]!, chain[i]!);
  assert.equal(f.kernel.getTask("d3")!.depth, LIMITS.maxDepth);

  // 허용 경계: depth == maxDepth인 task의 run_process는 실제로 spawn된다.
  const l = oneShot(f, "turn-d3", "op-d3", "d3");
  const outcome = await executeRunProcessOperation(l.grant, l.op, l.cap);
  assert.equal(outcome.marker, "applied");
  assert.equal(outcome.exitCode, 0);
  assert.equal(readFileSync(join(f.ws, "docs/deep.txt"), "utf8").trim(), "ran");

  // 거부 경계: depth 4는 **task 생성 단계에서** 닫힌다 → depth 4 task는 durable에 존재할 수 없고,
  // 그래서 assertSpawnLimits의 depth 분기는 도달 불가능한 최후 방어선이다.
  assert.equal(
    codeOf(() => spawnChild(f, "d3", "d4")),
    "depth_limit_exceeded",
  );
  assert.equal(f.kernel.getState().tasks.some((t) => t.depth > LIMITS.maxDepth), false);
});

test("[M5c/3C] spawn 상한: run 전체 프로세스 32번째는 실행되고 33번째는 spawn 전에 닫힌다", async () => {
  // 이 경계는 **프로세스** 상한이다(`B-19`) — task 상한 상수를 빌려 쓰지 않는다.
  assert.equal(LIMITS.maxProcessesPerRun, 32);
  // task당 4 상한이 먼저 걸리므로 run 전체 상한을 보려면 여러 task가 필요하다.
  // root(0) → c1..c4(1) → g1..g4(2). 9 task × 최대 4 = 36 > 32.
  const fill = ["c1", "c2", "c3", "c4", "g1", "g2", "g3", "g4"];
  const f = fixture({
    entrypointBody: '#!/bin/sh\necho "$$" >> docs/launches.txt\nexit 0\n',
    taskIds: ["root", ...fill],
    maxSessions: 9,
  });
  // pending은 running task에서만 열 수 있고 spawn하면 parent가 waiting_children이 되므로,
  // 각 task는 자기 child를 만들기 **전에** 채운다.
  // (실행하지 않은 durable pending으로 카운트를 31까지 올린다 — 진짜 spawn 31번을 돌리지 않는다.)
  fillProcessCount(f, "root", 4);
  for (const c of ["c1", "c2", "c3", "c4"]) spawnChild(f, "root", c);
  fillProcessCount(f, "c1", 4);
  for (const g of ["g1", "g2", "g3", "g4"]) spawnChild(f, "c1", g);
  for (const t of ["c2", "c3", "c4", "g1", "g2"]) fillProcessCount(f, t, 4);
  fillProcessCount(f, "g3", 3);
  assert.equal(runProcessCount(f), 31);

  // 허용 경계: 이 operation의 pending까지 포함해 32번째 → 실제로 spawn된다.
  const ok = oneShot(f, "turn-32", "op-32", "g4");
  assert.equal(runProcessCount(f), 32);
  const outcome = await executeRunProcessOperation(ok.grant, ok.op, ok.cap);
  assert.equal(outcome.marker, "applied");
  assert.equal(outcome.exitCode, 0);
  assert.equal(readFileSync(join(f.ws, "docs/launches.txt"), "utf8").trim().split("\n").length, 1);
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") }); // turn을 닫는다(카운트는 그대로 32).
  assert.equal(runProcessCount(f), 32);

  // 거부 경계: 33번째는 spawn **전에** 닫힌다 — 새 프로세스도, durable 표시도 없다.
  const over = oneShot(f, "turn-33", "op-33", "g4");
  assert.equal(runProcessCount(f), 33);
  assert.equal(
    await codeOfAsync(() => executeRunProcessOperation(over.grant, over.op, over.cap)),
    "process_spawn_limit_exceeded",
  );
  assert.equal(readFileSync(join(f.ws, "docs/launches.txt"), "utf8").trim().split("\n").length, 1);
  const pending = f.kernel.getTask("g4")!.execution.pendingOperations.find((p) => p.operationId === "op-33")!;
  assert.equal(pending.attemptedAt, null);
});

// ── deadline · 자손 정리 ────────────────────────────────────────────────────

test("[M5c/3C] deadline: 손자까지 프로세스 그룹으로 정리되고 고아가 남지 않는다", async () => {
  // entrypoint가 손자를 하나 띄우고 자기도 오래 잔다. 둘 다 같은 pgid에 남는다.
  const f = fixture({
    entrypointBody: '#!/bin/sh\n/bin/sleep 30 &\necho $! > docs/grandchild.pid\n/bin/sleep 30\n',
    timeoutMs: 2_000,
  });
  const { op, grant, cap } = oneShot(f, "turn-1");

  // 시작 장벽: 손자 pid 파일이 실제로 생긴 것을 **확인한 뒤에** deadline 만료를 기다린다.
  // (취소 테스트와 같은 패턴. 고정 sleep이 아니라 관측이다 — spawn 폭주로 child의 첫 명령이
  //  늦어져도 여기서 기다리므로, deadline이 `echo`보다 먼저 도는 경합이 없다.)
  const running = executeRunProcessOperation(grant, op, cap);
  const pidFile = join(f.ws, "docs/grandchild.pid");
  for (let i = 0; i < 150 && !existsSync(pidFile); i++) await sleep(10);
  assert.equal(existsSync(pidFile), true, "손자가 deadline 전에 뜨지 못했다(장벽 실패)");

  const code = await codeOfAsync(() => running);
  assert.equal(code, "process_deadline_exceeded");

  const gpid = Number(readFileSync(join(f.ws, "docs/grandchild.pid"), "utf8").trim());
  assert.ok(Number.isInteger(gpid) && gpid > 1, "손자 pid를 읽지 못했다");
  assert.equal(pidAlive(gpid), false, "손자 프로세스가 살아남았다(고아)");

  // deadline 종료도 **성공이 아니다**: 성공 영수증이 없고 불확실로만 닫힌다.
  assert.notEqual(f.kernel.getTask("root")!.execution.pendingOperations[0]!.attemptedAt, null);
  reconcile(f, op.operationId);
  assert.equal(receiptOf(f, op.operationId).marker, "outcome_unknown");
});

test("[M5c/3C] 정상 종료여도 남은 자손은 거둔다(leader만 죽는 정리는 없다)", async () => {
  const f = fixture({
    // leader는 바로 끝나지만 손자는 계속 산다 — 그룹 정리가 없으면 여기서 고아가 생긴다.
    entrypointBody: '#!/bin/sh\n/bin/sleep 30 &\necho $! > docs/grandchild.pid\nexit 0\n',
  });
  const { op, grant, cap } = oneShot(f, "turn-1");
  const outcome = await executeRunProcessOperation(grant, op, cap);
  assert.equal(outcome.exitCode, 0);

  const gpid = Number(readFileSync(join(f.ws, "docs/grandchild.pid"), "utf8").trim());
  assert.equal(pidAlive(gpid), false, "정상 종료 뒤에도 손자가 살아남았다(고아)");
});

test("[M5c/3C] 취소: AbortSignal로 그룹 전체가 종료되고 성공 영수증이 없다", async () => {
  const f = fixture({ entrypointBody: '#!/bin/sh\n/bin/sleep 30 &\necho $! > docs/grandchild.pid\n/bin/sleep 30\n' });
  const { op, grant, cap } = oneShot(f, "turn-1");
  const ac = new AbortController();
  const running = executeRunProcessOperation(grant, op, cap, { signal: ac.signal });
  // 손자 pid 파일이 생길 때까지 기다렸다가 취소한다(자손이 실제로 존재하는 상태에서 정리한다).
  for (let i = 0; i < 200 && !existsSync(join(f.ws, "docs/grandchild.pid")); i++) await sleep(10);
  ac.abort();

  await assert.rejects(running, (e: unknown) => (e as OrchestrationError).code === "process_deadline_exceeded");
  const gpid = Number(readFileSync(join(f.ws, "docs/grandchild.pid"), "utf8").trim());
  assert.equal(pidAlive(gpid), false, "취소 뒤 손자가 살아남았다(고아)");
});

// ── supervisor 단독 계약 ────────────────────────────────────────────────────

test("[M5c/3C] supervisor: SIGTERM을 무시하는 프로세스도 SIGKILL로 거두고 정리를 확인한다", async () => {
  const bin = makeDir("m5c-mp-sup-");
  // trap을 건 **다음** 줄에서 ready 파일을 쓴다 → 이 파일의 존재가 곧 "TERM 무시가 이미 설치됨"이다.
  const script = writeExecutable(bin, "stubborn.sh", "#!/bin/sh\ntrap '' TERM\necho ready > ready.txt\n/bin/sleep 30\n");
  const running = superviseProcess({
    executable: "/bin/sh",
    args: [script],
    cwd: bin,
    // 관측 장벽이 생겼으므로 deadline은 더 이상 "trap이 걸렸을 것"을 tight timeout으로 도박하지 않는다.
    // (deadline 테스트 4774c43과 같은 패턴. 고정 sleep이 아니라 파일 관측이다.)
    timeoutMs: 2_000,
    termGraceMs: 150,
    killGraceMs: 2_000,
  });
  const readyFile = join(bin, "ready.txt");
  for (let i = 0; i < 150 && !existsSync(readyFile); i++) await sleep(10);
  assert.equal(existsSync(readyFile), true, "deadline 전에 trap이 설치되지 못했다(장벽 실패)");

  const out = await running;
  assert.equal(out.terminatedBy, "deadline");
  assert.equal(out.cleanupConfirmed, true);
  assert.equal(out.signal, "SIGKILL");
});

test("[M5c/3C] supervisor: spawn 실패는 process_launch_failed이고 프로세스를 남기지 않는다", async () => {
  const bin = makeDir("m5c-mp-miss-");
  await assert.rejects(
    superviseProcess({
      executable: join(bin, "does-not-exist"),
      args: [],
      cwd: bin,
      timeoutMs: 1_000,
      termGraceMs: 100,
      killGraceMs: 100,
    }),
    (e: unknown) => (e as OrchestrationError).code === "process_launch_failed",
  );
});

/**
 * [V3 M10 T6 · 대장 `C-81`] **실제 supervisor가 정리 미관측을 낸다(실제 프로세스 · 살아 있는 자손).**
 *
 * 지금까지 이 분기의 판정은 durable marker를 **손으로 주입해** 고정했고(`autopilot.test.ts`), 실제
 * supervisor가 미관측을 내는 경로는 재현하지 않았다 → "미관측을 실제로 관측한다"가 미증명이었다.
 *
 * 재현 방법과 그 한계를 정직하게 적는다: **유예 0**을 주고 살아 있는 자손을 남긴다. "유예 안에 그룹이
 * 비는 것을 관측할 수 없다"가 유예 0에서는 **정의상 참**이므로 flaky하지 않다.
 *
 * **여기서 kernel 경로까지 잇지 않는 이유**(그리고 그것이 `C-81`에 남는 잔여다): 승인 계약의
 * `cleanupTermGraceMs`·`cleanupKillGraceMs`는 **최소 100ms**이고(`approvalManifest.ts:390-391`),
 * SIGKILL을 100ms 넘게 견디는 정상 프로세스는 만들 수 없다 → `executeRunProcessOperation`이
 * `process_cleanup_unconfirmed`를 던지는 상태는 **EPERM·비중단 I/O 같은 병리적 조건에서만** 도달한다.
 * 그 조건을 테스트로 합성하지 않았고, 합성한 척도 하지 않는다.
 */
test("[M10 T6/C-81] 실제 supervisor가 살아 있는 자손을 미관측으로 보고한다(유예 0 · 양성 대조군 포함)", async () => {
  const dir = makeDir("m10-c81-");
  const leader = join(dir, "leader.sh");
  // leader는 손자를 남기고 즉시 끝난다 → 그룹은 비어 있지 않다.
  writeFileSync(leader, "#!/bin/sh\n( sleep 2 ) &\nexit 0\n", { mode: 0o755 });
  const lonely = join(dir, "lonely.sh");
  writeFileSync(lonely, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const survived = await superviseProcess({
    executable: "/bin/sh",
    args: [leader],
    cwd: dir,
    timeoutMs: 5_000,
    termGraceMs: 0,
    killGraceMs: 0,
  });
  assert.equal(survived.cleanupConfirmed, false, "살아 있는 자손 + 유예 0인데 정리를 확인했다고 적었다");
  assert.equal(survived.terminatedBy, "exit");

  // **양성 대조군**: 같은 유예 0에서 자손이 없으면 그룹 소멸이 즉시 관측된다 → 위 false가 "관측기가
  // 언제나 실패한다"가 아니라 **살아 있는 자손** 때문임을 고정한다(공허한 red 방지).
  const clean = await superviseProcess({
    executable: "/bin/sh",
    args: [lonely],
    cwd: dir,
    timeoutMs: 5_000,
    termGraceMs: 0,
    killGraceMs: 0,
  });
  assert.equal(clean.cleanupConfirmed, true, "자손이 없는데도 정리를 관측하지 못했다");
});

/**
 * [V3 M10 T6 · 대장 `B-20`] 고정 env가 **system/global gitconfig를 사용자 상태 없이 끈다.**
 * `TRUSTED_GIT_PREFIX`의 `-c`는 아는 키만 끄므로 `/etc/gitconfig` 자체를 읽지 않게 하는 축이 필요하다.
 * 두 git 경로(관리 프로세스 · 실행 경계)가 **같은 값**을 쓰는 것도 함께 고정한다 — 갈라지면 한쪽만 안전하다.
 */
test("[M10 T6/B-20] 고정 env가 system/global gitconfig를 끈다(두 경계가 같은 값)", () => {
  assert.equal(MANAGED_PROCESS_ENV.GIT_CONFIG_NOSYSTEM, "1", "system config 차단이 고정 env에서 사라졌다");
  assert.equal(MANAGED_PROCESS_ENV.GIT_CONFIG_GLOBAL, "/dev/null", "global config 차단이 고정 env에서 사라졌다");
  assert.equal(GIT_SANITIZED_ENV.GIT_CONFIG_NOSYSTEM, MANAGED_PROCESS_ENV.GIT_CONFIG_NOSYSTEM);
  assert.equal(GIT_SANITIZED_ENV.GIT_CONFIG_GLOBAL, MANAGED_PROCESS_ENV.GIT_CONFIG_GLOBAL);
  // 상속 통로가 열리지 않았는지도 같이 본다(호출자별 override 표면 금지 — `MANAGED_PROCESS_ENV`가 전부다).
  assert.equal(MANAGED_PROCESS_ENV.HOME, undefined);
  assert.equal(MANAGED_PROCESS_ENV.GIT_DIR, undefined);
});

/**
 * [V3 M10 T6 · 대장 `B-18`] **관측 범위는 프로세스 그룹이다 — `setsid`로 그룹을 탈출한 자손은 그 밖이다.**
 *
 * 이 테스트는 결함을 고치는 것이 아니라 **한계를 계약으로 고정**한다. macOS/Linux에 cgroup 같은
 * "우리가 만든 프로세스 전부"를 묶는 커널 개념이 없는 채로 pgid를 쓰는 한, `detached`(= `setsid`) 자손은
 * 새 session/group으로 나가므로 `kill(-pgid, 0)`이 그것을 보지 못한다. 그래서 `cleanupConfirmed: true`는
 * "**승인된 프로세스 그룹이** 비었다"이고 "이 turn이 만든 프로세스가 하나도 남지 않았다"가 **아니다**.
 * 모듈 머리말·`SupervisedOutcome` 주석을 그 범위로 정정했고(과대주장 제거) 이 테스트가 그 문장을 고정한다.
 */
test("[M10 T6/B-18] setsid로 그룹을 탈출한 자손은 그룹 관측의 범위 밖이다(한계를 고정한다)", async () => {
  const dir = makeDir("m10-b18-");
  const marker = join(dir, "escaped.txt");
  const escapee = join(dir, "escapee.mjs");
  const leader = join(dir, "leader.mjs");
  writeFileSync(escapee, `import { writeFileSync } from "node:fs";\nsetTimeout(() => writeFileSync(process.argv[2], "1"), 300);\n`);
  // detached: true → setsid() → 새 session/group. 부모가 죽어도 이 프로세스는 우리 pgid에 없다.
  writeFileSync(
    leader,
    `import { spawn } from "node:child_process";\nconst g = spawn(process.execPath, [process.argv[2], process.argv[3]], { detached: true, stdio: "ignore" });\ng.unref();\nprocess.exit(0);\n`,
  );

  const out = await superviseProcess({
    executable: process.execPath,
    args: [leader, escapee, marker],
    cwd: dir,
    timeoutMs: 5_000,
    termGraceMs: 200,
    killGraceMs: 200,
  });
  // 그룹은 실제로 비었다 → 관측은 참이다. 거짓 영수증이 아닌 이유는 **주장의 범위가 그룹**이라는 것이다.
  assert.equal(out.cleanupConfirmed, true, "그룹이 비었는데 미관측으로 보고했다");

  // 그런데 탈출한 자손은 살아 있었다: reap 이후에도 자기 일을 끝낸다.
  //
  // **고정 대기가 아니라 폴링이다**: 전체 suite와 함께 돌면 탈출 자손의 Node 기동이 수백 ms 밀린다
  // (실측: 고정 900ms는 부하 아래에서 흔들렸다). 단정은 그대로이고 기다리는 방식만 부하 내성이 있다.
  const deadline = Date.now() + 15_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(marker), true, "탈출 자손이 죽었다 — pgid reap이 그룹 밖까지 덮었다는 뜻이므로 계약 기술이 낡았다");
});
