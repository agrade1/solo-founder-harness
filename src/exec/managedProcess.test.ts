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
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  isGenuineLaunchCapability,
  resolveProcessLaunchCapability,
  type OperationDispatchPermit,
  type OperationExecutionGrant,
  type PreflightDecision,
  type ProcessLaunchCapability,
  type TaskSeed,
} from "./orchestrationKernel.js";
import type { TypedRunProcessOperation } from "./typedPlan.js";
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
  opts: { entrypointBody: string; timeoutMs?: number; taskIds?: string[]; maxSessions?: number } = {
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
            action: "validate-plan",
            data: { planPath: "docs/plan.json" },
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

test("[M5c/3C] spawn 상한: run 전체 child 32번째는 실행되고 33번째는 spawn 전에 닫힌다", async () => {
  assert.equal(LIMITS.maxTasksPerRun, 32);
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
