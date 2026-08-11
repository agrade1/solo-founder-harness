/**
 * V3 M5c — **typed 실행 계획 validator + kernel 발급 권위로만 일어나는 집행** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/typedExecution.test.ts`
 * 네트워크·LLM·provider·프로세스 spawn 없이 임시 workspace에서만 돈다(무과금).
 *
 * 이 파일이 덮는 계약:
 * - 계획은 **닫힌 데이터**다: 미상/누락/중첩 여분 key · **accessor(성공하든 던지든)** · proxy · 순환 ·
 *   함수 · symbol · 중복 id · binding 불일치 · 버전 · 상한 · Unicode/경로/바이트 경계가 전부 `plan_invalid`다.
 * - **집행은 kernel이 발급한 봉인 permit으로만 일어난다**(3A 리비전 A2): 평범한/위조 permit · 묶이지 않은
 *   operation · 잘못된 lifecycle · 낡은 attempt · 다른 turn · preflight drift · 만료·예산 **경계 등호** ·
 *   durable 상태 변화는 전부 **효과 0**으로 거부된다.
 * - 권위는 **deny-by-default**다: 부재 · 다른 task · kind 불일치 · sibling 소유 · ownership 밖 · 부모/대상
 *   symlink · 비일반 파일 · 바이트 초과.
 * - **발행은 예방 불가라서 존재하지 않는다**(3A 3차 리비전 A4): 신규 파일 발행은 `write_publish_unsupported`
 *   이고 **파일 시스템 부작용이 0**이다(temp도 만들지 않는다). 기존 대상 교체는 `write_replace_unsupported`.
 *   남는 것은 바이트를 만들지 않는 판정뿐이며 `already_applied`는 **디렉터리 fsync 뒤에만** 나온다.
 * - 실패 경로는 fd를 남기지 않고 안정 코드로 접히며, 정리 미확인은 1차 오류에 **가려지지 않는다**.
 * - 프로세스는 **opaque 일회용 권능만** 나온다(spawn 0) — 실행 파일·argv·digest는 노출되지 않는다.
 * - JSON Schema와 런타임 계약이 **어긋나지 않는다**(구조 대조 — draft-07 구현은 실행하지 않는다).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_ROLES,
  CONTROLLER_ACTIONS,
  LIMITS,
  OrchestrationError,
  REQUIRED_BODY_HEADINGS,
  SHA256_PATTERN,
  SLUG_PATTERN,
  TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
  AGENT_MESSAGE_SCHEMA_VERSION,
  ORCHESTRATOR_ID,
  hasLoneSurrogate,
  type OperationReceipt,
  type PendingOperation,
} from "./orchestrationTypes.js";
import type { AgentMessageType } from "./orchestrationTypes.js";
import { OPERATION_RECEIPT_KEYS, validateRunState } from "./orchestrationStore.js";
import { RUN_PROCESS_AUTHORITY_KEYS, WRITE_FILE_AUTHORITY_KEYS, validateApprovalManifest } from "./approvalManifest.js";
import {
  DISPATCH_AUTHORITY_CODES,
  OrchestrationKernel,
  __setPublicationSeamsForTest,
  type OperationDispatchPermit,
  type OperationExecutionGrant,
  type PreflightDecision,
  type TaskSeed,
  type WorkerProgressChannel,
} from "./orchestrationKernel.js";
import type { TypedOperation } from "./autopilotTypes.js";
import {
  LONE_SURROGATE_PATTERN,
  NORMALIZED_WORKSPACE_PATH_PATTERN,
  RUN_PROCESS_OPERATION_KEYS,
  TYPED_EXECUTION_CODES,
  TYPED_PLAN_KEYS,
  TYPED_PLAN_OUTPUT_KEYS,
  TYPED_PLAN_RESULT_KEYS,
  WINDOWS_DRIVE_PATTERN,
  WRITE_FILE_OPERATION_KEYS,
  applyWriteFile,
  isGenuineLaunchCapability,
  resolveProcessLaunchCapability,
  resolveWriteFileAuthority,
  validateTypedExecutionPlan,
  type PublicationSeam,
  type TypedRunProcessOperation,
  type TypedWriteFileOperation,
} from "./typedExecution.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const workspaces: string[] = [];
function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "m5c-typed-"));
  mkdirSync(join(ws, "docs"));
  mkdirSync(join(ws, "src"));
  workspaces.push(ws);
  return ws;
}
process.on("exit", () => {
  for (const ws of workspaces) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과를 바꾸지 않는다 */
    }
  }
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
  return "no-error";
}

function sha256(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

const RUN_ID = "run-1";
const MILESTONE = "m5c";
const NODE_PATH = "/opt/harness/node";
const T0 = Date.UTC(2026, 6, 30, 0, 0, 0);
const EXPIRES = "2026-12-31T00:00:00.000Z";

/** 결정론적 clock — 호출마다 1초 전진. */
function clockFrom(startMs: number): () => Date {
  let n = 0;
  return () => new Date(startMs + 1000 * n++);
}

/**
 * 시각을 **정확히 고정**할 수 있는 clock. deadline 경계 등호를 태우기 위해 루프로 시간을 소모하는 대신
 * 정확히 그 밀리초로 옮긴다(3A 2차 리비전 — 등호 판정이 우연이 아니라 단정이 되게 한다).
 */
function steppableClock(startMs: number): { clock: () => Date; set: (ms: number) => void } {
  let at = startMs;
  return { clock: () => new Date(at), set: (ms: number) => { at = ms; } };
}

const ENTRYPOINT_PATH = "/opt/harness/controller.mjs";
const EXECUTION_AUTHORITY = {
  codex: null,
  controllerEntrypoint: { path: ENTRYPOINT_PATH, sha256: "9".repeat(64) },
  git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
  node: { path: NODE_PATH, sha256: "e".repeat(64) },
  processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
};

const POLICY = {
  maxTaskAttempts: 2,
  maxDeliveryAttempts: 2,
  retryBackoffMs: 0,
  deliveryDeadlineMs: 600_000,
  maxNoProgressMs: 60_000,
  maxAttemptElapsedMs: 600_000,
  cleanupTermGraceMs: 500,
  cleanupKillGraceMs: 500,
};

const OPERATION_AUTHORITY = {
  root: [
    { authorityId: "w-doc", kind: "write_file", path: "docs/out.md", maxBytes: 1024 },
    { authorityId: "w-small", kind: "write_file", path: "docs/small.md", maxBytes: 8 },
    { authorityId: "w-nested", kind: "write_file", path: "docs/nested/a.md", maxBytes: 1024 },
    { authorityId: "w-linked", kind: "write_file", path: "src/linked/a.md", maxBytes: 1024 },
    { authorityId: "p-node", kind: "run_process", action: "validate-plan", data: { planPath: "docs/plan.json" }, timeoutMs: 5_000 },
  ],
  sibling: [{ authorityId: "w-sib", kind: "write_file", path: "docs/sib.md", maxBytes: 1024 }],
  // manifest.ownershipByTask에 **없는** child — 소유 판정은 dispatch 시점 durable ownership이 한다.
  "root.child": [
    { authorityId: "w-child", kind: "write_file", path: "docs/child.md", maxBytes: 1024 },
    { authorityId: "w-outside", kind: "write_file", path: "docs/out.md", maxBytes: 1024 },
  ],
};

function manifestObject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask: { root: ["docs", "src"], sibling: ["docs"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: EXECUTION_AUTHORITY,
    autopilotPolicy: POLICY,
    operationAuthorityByTask: OPERATION_AUTHORITY,
    maxSessions: 4,
    maxTokens: 1000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: EXPIRES,
    ...over,
  };
}

function body(type: AgentMessageType): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

function seed(taskId: string, ownership: string[]): TaskSeed {
  return {
    taskId,
    roleId: "tech-lead",
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership,
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
  };
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}.${++counter}`;

/** batch 전체에 결정을 주되 `wanted`만 prepared로 올린다(나머지는 `deferred` — 상태 무변화). */
function preflight(k: OrchestrationKernel, wanted: string[]): void {
  const batch = k.planRunnableBatch();
  const decisions: PreflightDecision[] = batch.items.map((t) =>
    wanted.includes(t.taskId)
      ? { taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") }
      : { taskId: t.taskId, outcome: "deferred" },
  );
  k.commitPreflightBatch({ baseRevision: batch.revision, actionId: nextId("act"), decisions });
}

/**
 * 진짜 시작 경로 전부를 지난다(ready → prepared → running). lease marker를 돌려준다.
 *
 * 3A 4차 리비전 A1 — 진행 채널은 **`startPreparedTask()`가 시작을 커밋한 그 순간에만** 발급되므로
 * (durable lease를 베껴 되만들 수 없다) 여기서 받아 lease 기준으로 보관한다. 채널을 되만들 수 없다는
 * 사실 자체는 별도 테스트가 단정한다.
 */
const CHANNELS = new Map<string, WorkerProgressChannel>();
function startNow(k: OrchestrationKernel, taskId: string): string {
  preflight(k, [taskId]);
  const leaseMarker = `lease.${(++counter).toString(16).padStart(32, "0")}`;
  const started = k.startPreparedTask({ taskId, actionId: nextId("act"), leaseMarker });
  CHANNELS.set(leaseMarker, started.progress);
  return leaseMarker;
}

/** 이 attempt를 시작한 주체가 받은 진행 채널(테스트 편의 — 공개 API로는 되만들 수 없다). */
function channelFor(k: OrchestrationKernel, taskId: string): WorkerProgressChannel {
  const lease = k.getTask(taskId)!.execution.processLeaseMarker!;
  const chan = CHANNELS.get(lease);
  assert.ok(chan, `${taskId}의 진행 채널이 없다`);
  return chan;
}

interface Fixture {
  ws: string;
  kernel: OrchestrationKernel;
}

/**
 * **진짜 kernel run 하나.** `root`와 `sibling`이 있고 `root`는 preflight→running을 실제로 지난다
 * (ready→running 직접 경로는 존재하지 않는다 — `startTask()`는 `preflight_required`다).
 */
function fixture(opts: { manifestOver?: Record<string, unknown>; clock?: () => Date; startRoot?: boolean } = {}): Fixture {
  const ws = makeWorkspace();
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestObject(opts.manifestOver),
    clock: opts.clock ?? clockFrom(T0),
  });
  kernel.createRootTask(seed("root", ["docs", "src"]));
  kernel.createRootTask(seed("sibling", ["docs"]));
  if (opts.startRoot !== false) startNow(kernel, "root");
  return { ws, kernel };
}

function writeOp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: "op-1",
    kind: "write_file",
    authorityId: "w-doc",
    path: "docs/out.md",
    content: "hello",
    expectedBeforeSha256: null,
    ...over,
  };
}

function processOp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { operationId: "op-2", kind: "run_process", authorityId: "p-node", ...over };
}

/** 이 task의 **durable 신원**에 묶인 계획 객체(테스트가 kernel에 넘기는 입력). */
function planFor(
  k: OrchestrationKernel,
  taskId: string,
  operations: unknown[],
  turnId = "turn-1",
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const task = k.getTask(taskId);
  assert.ok(task, `task ${taskId}가 없다`);
  return {
    schemaVersion: "1",
    runId: RUN_ID,
    taskId,
    attemptId: task.execution.attemptId,
    turnId,
    operations,
    result: { summary: "한 turn의 결과 요약", outputs: [{ path: "docs/out.md", role: "output" }] },
    ...over,
  };
}

/**
 * kernel이 발급한 봉인 permit. **집행에 쓸 operation은 `permit.plan.operations`에서 꺼낸다.**
 *
 * 3A 3차 리비전 A1 — 계약 순서가 **permit(claim) → 과금 → grant → 효과**이므로, 이 헬퍼가 claim 직후
 * 그 turn을 과금한다(기본 0 토큰). 과금하지 않으면 grant·효과가 `budget_turn_unaccounted`로 막힌다는
 * 것을 별도 테스트가 단정한다 — 여기서는 그 순서를 **정상 경로로** 밟는다.
 *
 * 3A 4차 리비전 A1 — 생산 turn 과금은 **kernel 발급 permit**으로만 효과를 승인한다
 * (`chargeDispatchTurnUsage`). 권위 없는 `chargeTurnUsage`로는 남의 bare turn ID를 과금해도 효과가
 * 열리지 않는다는 것 역시 별도 테스트가 단정한다.
 */
function permitFor(
  k: OrchestrationKernel,
  taskId: string,
  operations: unknown[],
  turnId = "turn-1",
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
): OperationDispatchPermit {
  const permit = k.issueOperationDispatchPermit({
    taskId,
    turnId,
    actionId: nextId("act"),
    plan: planFor(k, taskId, operations, turnId),
  });
  k.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), elapsedMs: 1, ...usage });
  return permit;
}

/**
 * 집행 직전 durable 등록을 지나 **일회용 execution grant**를 받는다(3A 2차 리비전 A2).
 * 효과 진입점(`applyWriteFile`/`resolveProcessLaunchCapability`)은 permit이 아니라 이 grant를 요구한다.
 */
function grantFor(k: OrchestrationKernel, permit: OperationDispatchPermit, operationId: string): OperationExecutionGrant {
  return k.beginOperation({ permit, operationId, actionId: nextId("act") });
}

function writePermit(
  f: Fixture,
  over: Record<string, unknown> = {},
  taskId = "root",
): [TypedWriteFileOperation, OperationExecutionGrant] {
  const permit = permitFor(f.kernel, taskId, [writeOp(over)]);
  const op = permit.plan.operations[0] as TypedWriteFileOperation;
  return [op, grantFor(f.kernel, permit, op.operationId)];
}

function processPermit(f: Fixture, over: Record<string, unknown> = {}): [TypedRunProcessOperation, OperationExecutionGrant] {
  const permit = permitFor(f.kernel, "root", [processOp(over)]);
  const op = permit.plan.operations[0] as TypedRunProcessOperation;
  return [op, grantFor(f.kernel, permit, op.operationId)];
}

/**
 * **한 turn = 한 계획**이므로(3A 2차 리비전 A1) 여러 operation을 보려면 같은 계획에 담아야 한다.
 * 각 operation의 grant를 순서대로 돌려준다.
 */
function writeGrants(f: Fixture, overs: Record<string, unknown>[], taskId = "root"): Array<[TypedWriteFileOperation, OperationExecutionGrant]> {
  const permit = permitFor(f.kernel, taskId, overs.map((o, i) => writeOp({ operationId: `op-${i + 1}`, ...o })));
  return permit.plan.operations.map((op) => [op as TypedWriteFileOperation, grantFor(f.kernel, permit, op.operationId)]);
}

/**
 * 한 turn에 write + run_process를 **같은 계획**으로 담는다. turn 하나에 계획은 하나뿐이므로
 * (3A 2차 리비전 A1) 둘을 각각 발급하면 `dispatch_plan_conflict`가 맞다.
 */
function bothPermit(f: Fixture): [TypedWriteFileOperation, OperationExecutionGrant, TypedRunProcessOperation, OperationExecutionGrant] {
  const permit = permitFor(f.kernel, "root", [writeOp(), processOp()]);
  const w = permit.plan.operations[0] as TypedWriteFileOperation;
  const p = permit.plan.operations[1] as TypedRunProcessOperation;
  return [w, grantFor(f.kernel, permit, w.operationId), p, grantFor(f.kernel, permit, p.operationId)];
}

/**
 * 임시 파일 잔재. 3A 3차 리비전 A4로 **집행기가 temp를 만드는 경로 자체가 사라졌으므로** 이 값은
 * 어떤 경로에서도 0이다(이전에는 "정리했다"를 확인하는 값이었고 지금은 "만들지 않았다"를 확인한다).
 */
function orphanTemps(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(".m5c-op-"));
}

/** durable 영수증 1건을 durable state에서 읽는다(집행기 반환값이 아니라 **기록된 값**을 본다). */
function receiptOf(k: OrchestrationKernel, taskId: string, operationId: string): OperationReceipt {
  const r = k.getTask(taskId)!.execution.operationReceipts.find((x) => x.operationId === operationId);
  assert.ok(r, `영수증 ${operationId}이 durable에 없다`);
  return r;
}

/** 순수 계획 검증용 binding(집행 권위가 아니다). */
const BINDING = { runId: RUN_ID, taskId: "root", attemptId: "att-1", turnId: "turn-1" };

function planObject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    ...BINDING,
    operations: [writeOp(), processOp()],
    result: { summary: "한 turn의 결과 요약", outputs: [{ path: "docs/out.md", role: "output" }] },
    ...over,
  };
}

function adopt(over: Record<string, unknown> = {}) {
  return validateTypedExecutionPlan(planObject(over), BINDING);
}

// ── 1. 계획 입양과 깊은 불변성 ──────────────────────────────────────────────

test("[M5c] 혼합 계획을 입양하고 깊이 동결한다", () => {
  const source = planObject();
  const plan = validateTypedExecutionPlan(source, BINDING);

  assert.equal(plan.schemaVersion, TYPED_EXECUTION_PLAN_SCHEMA_VERSION);
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.operations[0].kind, "write_file");
  assert.equal(plan.operations[1].kind, "run_process");
  assert.deepEqual(Object.keys(plan.operations[0]).sort(), [...WRITE_FILE_OPERATION_KEYS].sort());
  assert.deepEqual(Object.keys(plan.operations[1]).sort(), [...RUN_PROCESS_OPERATION_KEYS].sort());

  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.operations), true);
  assert.equal(Object.isFrozen(plan.operations[0]), true);
  assert.equal(Object.isFrozen(plan.operations[1]), true);
  assert.equal(Object.isFrozen(plan.result), true);
  assert.equal(Object.isFrozen(plan.result.outputs), true);
  assert.equal(Object.isFrozen(plan.result.outputs[0]), true);

  // 입양 후 원본을 바꿔도 채택된 값은 바뀌지 않는다.
  (source.operations as Array<Record<string, unknown>>)[0].path = "docs/evil.md";
  (source.operations as Array<Record<string, unknown>>).push(writeOp({ operationId: "op-9" }));
  (source.result as Record<string, unknown>).summary = "바뀐 요약";
  assert.equal((plan.operations[0] as TypedWriteFileOperation).path, "docs/out.md");
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.result.summary, "한 turn의 결과 요약");
});

test("[M5c] operation 0건과 output 0건도 유효하다(빈 turn은 계약 안이다)", () => {
  const plan = validateTypedExecutionPlan(
    planObject({ operations: [], result: { summary: "아무것도 하지 않았다", outputs: [] } }),
    BINDING,
  );
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.result.outputs.length, 0);
});

// ── 2. 닫힌 key 집합 ────────────────────────────────────────────────────────

test("[M5c] 미상·누락·중첩 여분 key는 전부 plan_invalid다", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["top-level 여분 key", planObject({ extra: 1 })],
    ["top-level 누락 key", (() => { const p = planObject(); delete p.turnId; return p; })()],
    ["result 여분 key", planObject({ result: { summary: "s", outputs: [], extra: 1 } })],
    ["result 누락 key", planObject({ result: { summary: "s" } })],
    ["output 여분 key", planObject({ result: { summary: "s", outputs: [{ path: "docs/a.md", role: "output", extra: 1 }] } })],
    ["output 누락 key", planObject({ result: { summary: "s", outputs: [{ path: "docs/a.md" }] } })],
    ["write_file 여분 key", planObject({ operations: [writeOp({ mode: "0777" })] })],
    ["write_file 누락 key", planObject({ operations: [(() => { const o = writeOp(); delete o.content; return o; })()] })],
    ["run_process 여분 key(argv 주입 시도)", planObject({ operations: [processOp({ args: ["--eval", "x"] })] })],
    ["run_process 여분 key(실행 파일 선택 시도)", planObject({ operations: [processOp({ executable: "/bin/sh" })] })],
    ["run_process 여분 key(env 주입 시도)", planObject({ operations: [processOp({ env: { PATH: "/tmp" } })] })],
    ["run_process 여분 key(shell 요청)", planObject({ operations: [processOp({ shell: true })] })],
    ["kind 없음", planObject({ operations: [{ operationId: "op-1", authorityId: "w-doc" }] })],
    ["kind가 계약 밖", planObject({ operations: [processOp({ kind: "run_shell" })] })],
    ["write key 집합인데 kind가 run_process", planObject({ operations: [writeOp({ kind: "run_process" })] })],
    ["run key 집합인데 kind가 write_file", planObject({ operations: [processOp({ kind: "write_file" })] })],
  ];
  for (const [label, p] of cases) {
    assert.equal(codeOf(() => validateTypedExecutionPlan(p, BINDING)), "plan_invalid", label);
  }
});

test("[M5c] accessor는 성공해도 데이터가 아니다(실행조차 되지 않는다)", () => {
  // ⓐ **성공하는 getter도 거부**다(3A 리비전 A1). 그리고 애초에 **호출되지 않는다** —
  //    descriptor의 `value`만 읽으므로 호출자 코드가 실행될 통로가 없다.
  let reads = 0;
  const alternating = {
    ...writeOp(),
    get path() {
      reads += 1;
      return reads === 1 ? "docs/out.md" : "docs/evil.md";
    },
  };
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: [alternating] }), BINDING)), "plan_invalid");
  assert.equal(reads, 0, "accessor가 실행됐다");

  // ⓑ 최상위·result·output·binding 어디에 있어도 같다.
  const topGetter: Record<string, unknown> = planObject();
  Object.defineProperty(topGetter, "taskId", { get: () => "root", enumerable: true, configurable: true });
  assert.equal(codeOf(() => validateTypedExecutionPlan(topGetter, BINDING)), "plan_invalid");
  assert.equal(
    codeOf(() =>
      validateTypedExecutionPlan(planObject({ result: { get summary() { return "s"; }, outputs: [] } }), BINDING),
    ),
    "plan_invalid",
  );
  assert.equal(
    codeOf(() =>
      validateTypedExecutionPlan(planObject({ result: { summary: "s", outputs: [{ get path() { return "docs/a.md"; }, role: "output" }] } }), BINDING),
    ),
    "plan_invalid",
  );
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject(), { ...BINDING, get turnId() { return "turn-1"; } })), "plan_invalid");

  // ⓒ 배열 인덱스 accessor도 같다.
  const opArray: unknown[] = [];
  Object.defineProperty(opArray, 0, { get: () => writeOp(), enumerable: true, configurable: true });
  Object.defineProperty(opArray, "length", { value: 1, writable: true });
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: opArray }), BINDING)), "plan_invalid");

  // ⓓ 던지는 getter도 **호출자가 고른 코드**를 낼 수 없다(대장 `C-38`).
  const hostileGetter = {
    ...writeOp(),
    get content(): string {
      throw new OrchestrationError("artifact_missing", "호출자가 고른 코드");
    },
  };
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: [hostileGetter] }), BINDING)), "plan_invalid");
  // binding의 던지는 getter도 같다 — 직접 진입점의 taxonomy seam이 닫혔다(`C-38`).
  assert.equal(
    codeOf(() =>
      validateTypedExecutionPlan(planObject(), {
        ...BINDING,
        get runId(): string {
          throw new OrchestrationError("manifest_expired", "호출자가 고른 코드");
        },
      }),
    ),
    "plan_invalid",
  );
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject(), null)), "plan_invalid");
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject(), { ...BINDING, extra: 1 })), "plan_invalid");
});

test("[M5c] Proxy·함수·symbol·순환·이질 prototype은 권위를 밀반입할 수 없다", () => {
  // ⓐ trap이 **깔끔한 데이터를 돌려주는** proxy도 거부다: 성공한 호출자 코드는 데이터가 아니다.
  const politeProxy = new Proxy(writeOp(), {});
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: [politeProxy] }), BINDING)), "plan_invalid");
  assert.equal(codeOf(() => validateTypedExecutionPlan(new Proxy(planObject(), {}), BINDING)), "plan_invalid");
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject(), new Proxy({ ...BINDING }, {}))), "plan_invalid");
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: new Proxy([writeOp()], {}) }), BINDING)), "plan_invalid");

  // ⓑ 모든 접근을 가로채는 proxy.
  const hostileProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
      ownKeys() {
        return [...WRITE_FILE_OPERATION_KEYS];
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true, value: undefined };
      },
    },
  );
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: [hostileProxy] }), BINDING)), "plan_invalid");
  assert.equal(codeOf(() => validateTypedExecutionPlan(hostileProxy, BINDING)), "plan_invalid");

  // ⓒ 함수·symbol key·이질 prototype·순환.
  const withSymbol: Record<string | symbol, unknown> = writeOp();
  withSymbol[Symbol("smuggle")] = () => "authority";
  class NotPlain {
    schemaVersion = "1";
  }
  const cyclic: Record<string, unknown> = planObject();
  cyclic.result = cyclic;
  const cyclicOp: Record<string, unknown> = writeOp();
  cyclicOp.content = cyclicOp;
  for (const [label, raw] of [
    ["symbol key", planObject({ operations: [withSymbol] })],
    ["함수 값", planObject({ operations: [writeOp({ content: () => "x" })] })],
    ["operation이 함수", planObject({ operations: [() => "op"] })],
    ["plan이 함수", () => "plan"],
    ["이질 prototype", new NotPlain()],
    ["operation이 이질 prototype", planObject({ operations: [Object.assign(Object.create({ evil: 1 }), writeOp())] })],
    ["순환 plan", cyclic],
    ["순환 operation", planObject({ operations: [cyclicOp] })],
    ["operations가 배열이 아니다", planObject({ operations: { length: 1, 0: writeOp() } })],
    ["operations 배열에 여분 property", planObject({ operations: Object.assign([writeOp()], { evil: 1 }) })],
  ] as Array<[string, unknown]>) {
    assert.equal(codeOf(() => validateTypedExecutionPlan(raw, BINDING)), "plan_invalid", label);
  }
});

// ── 3. 신원·버전·중복·상한 ──────────────────────────────────────────────────

test("[M5c] binding과 버전은 정확히 일치해야 한다", () => {
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ schemaVersion: "2" }), BINDING)), "plan_invalid");
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ schemaVersion: 1 }), BINDING)), "plan_invalid");
  for (const key of ["runId", "taskId", "attemptId", "turnId"] as const) {
    assert.equal(
      codeOf(() => validateTypedExecutionPlan(planObject({ [key]: "other-id" }), BINDING)),
      "plan_invalid",
      `${key} 불일치를 통과시켰다`,
    );
    assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ [key]: "NOT A SLUG" }), BINDING)), "plan_invalid");
  }
  // kernel이 준 binding 자체가 계약 밖이면 그것도 거부다.
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject(), { ...BINDING, turnId: "" })), "plan_invalid");
});

test("[M5c] 중복 operationId는 거부한다(schema가 표현할 수 없는 런타임 전용 불변식)", () => {
  const dup = planObject({ operations: [writeOp({ operationId: "same" }), processOp({ operationId: "same" })] });
  assert.equal(codeOf(() => validateTypedExecutionPlan(dup, BINDING)), "plan_invalid");
});

test("[M5c] operation·output·summary·본문 상한", () => {
  const many = Array.from({ length: LIMITS.maxOperationsPerTurn }, (_, i) => processOp({ operationId: `op-${i}` }));
  assert.equal(validateTypedExecutionPlan(planObject({ operations: many }), BINDING).operations.length, LIMITS.maxOperationsPerTurn);
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [...many, processOp({ operationId: "op-over" })] }), BINDING)),
    "plan_invalid",
  );

  const outputs = Array.from({ length: LIMITS.maxArtifactRefs }, (_, i) => ({ path: `docs/o${i}.md`, role: "output" }));
  assert.equal(
    validateTypedExecutionPlan(planObject({ result: { summary: "s", outputs } }), BINDING).result.outputs.length,
    LIMITS.maxArtifactRefs,
  );
  assert.equal(
    codeOf(() =>
      validateTypedExecutionPlan(
        planObject({ result: { summary: "s", outputs: [...outputs, { path: "docs/over.md", role: "output" }] } }),
        BINDING,
      ),
    ),
    "plan_invalid",
  );

  assert.equal(
    validateTypedExecutionPlan(planObject({ result: { summary: "s".repeat(LIMITS.maxSummaryLength), outputs: [] } }), BINDING)
      .result.summary.length,
    LIMITS.maxSummaryLength,
  );
  for (const bad of ["", "s".repeat(LIMITS.maxSummaryLength + 1), "\0", 1, null]) {
    assert.equal(
      codeOf(() => validateTypedExecutionPlan(planObject({ result: { summary: bad, outputs: [] } }), BINDING)),
      "plan_invalid",
      `summary=${JSON.stringify(bad)}`,
    );
  }
  for (const role of ARTIFACT_ROLES) {
    assert.equal(
      validateTypedExecutionPlan(planObject({ result: { summary: "s", outputs: [{ path: "docs/a.md", role }] } }), BINDING)
        .result.outputs[0].role,
      role,
    );
  }
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ result: { summary: "s", outputs: [{ path: "docs/a.md", role: "secret" }] } }), BINDING)),
    "plan_invalid",
  );
});

test("[M5c] 본문 바이트 상한은 UTF-16 길이가 아니라 UTF-8 바이트로 센다", () => {
  const okBytes = "a".repeat(LIMITS.maxWriteBytes);
  assert.equal(
    (validateTypedExecutionPlan(planObject({ operations: [writeOp({ content: okBytes })] }), BINDING).operations[0] as TypedWriteFileOperation)
      .content.length,
    LIMITS.maxWriteBytes,
  );
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ content: `${okBytes}a` })] }), BINDING)),
    "plan_invalid",
  );
  // 코드 포인트로는 상한 안이지만 UTF-8 바이트로는 넘는다 → 런타임이 더 엄격한 쪽이다(fail closed).
  const astral = "😀".repeat(LIMITS.maxWriteBytes / 4 + 1);
  assert.equal(Buffer.byteLength(astral, "utf8") > LIMITS.maxWriteBytes, true);
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ content: astral })] }), BINDING)), "plan_invalid");
  // 고립 surrogate는 쓰기 바이트가 의도와 조용히 달라지므로 거부한다.
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ content: "\uD800" })] }), BINDING)),
    "plan_invalid",
  );
  // 빈 본문(0바이트 파일)은 유효하다.
  assert.equal(
    (validateTypedExecutionPlan(planObject({ operations: [writeOp({ content: "" })] }), BINDING).operations[0] as TypedWriteFileOperation)
      .content,
    "",
  );
});

test("[M5c] expectedBeforeSha256은 소문자 hex 64자 또는 null이다", () => {
  assert.equal(
    (validateTypedExecutionPlan(planObject({ operations: [writeOp({ expectedBeforeSha256: "a".repeat(64) })] }), BINDING)
      .operations[0] as TypedWriteFileOperation).expectedBeforeSha256,
    "a".repeat(64),
  );
  for (const bad of ["A".repeat(64), "a".repeat(63), "", 0, undefined, { }]) {
    assert.equal(
      codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ expectedBeforeSha256: bad })] }), BINDING)),
      "plan_invalid",
      JSON.stringify(bad),
    );
  }
});

test("[M5c] 경로는 이미 정규화된 workspace-relative여야 한다(C-40 astral 경계 포함)", () => {
  const NUL = String.fromCharCode(0);
  const good = ["docs/out.md", "a", "a/b/c", "a.b/..c/d...", "docs/a b.md", "docs/.hidden"];
  const bad = [
    "",
    "/docs/a.md",
    "C:/docs/a.md",
    "docs//a.md",
    "docs/./a.md",
    "docs/../a.md",
    "../a.md",
    "docs/",
    "./a.md",
    "..",
    ".",
    `docs/a${NUL}.md`,
    "docs\\a.md",
  ];
  for (const p of good) {
    assert.equal(
      (validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: p })] }), BINDING).operations[0] as TypedWriteFileOperation).path,
      p,
      `정규 경로를 거부한다: ${JSON.stringify(p)}`,
    );
  }
  for (const p of bad) {
    assert.equal(
      codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: p })] }), BINDING)),
      "plan_invalid",
      `비정규 경로를 통과시킨다: ${JSON.stringify(p)}`,
    );
  }
  // C-40: 길이는 **코드 포인트**로 센다 — 😀 512개(UTF-16 1024 unit)는 통과, 513개는 거부.
  const astral512 = "😀".repeat(LIMITS.maxPathLength);
  assert.equal(astral512.length, LIMITS.maxPathLength * 2);
  assert.equal(
    (validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: astral512 })] }), BINDING).operations[0] as TypedWriteFileOperation)
      .path,
    astral512,
  );
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: `${astral512}😀` })] }), BINDING)),
    "plan_invalid",
  );
  assert.equal(
    (validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: "a".repeat(LIMITS.maxPathLength) })] }), BINDING)
      .operations[0] as TypedWriteFileOperation).path.length,
    LIMITS.maxPathLength,
  );
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: "a".repeat(LIMITS.maxPathLength + 1) })] }), BINDING)),
    "plan_invalid",
  );
});

// ── 3b. 고립 surrogate 경로 신원 (3A 리비전 A4) ──────────────────────────────

test("[M5c] 고립 UTF-16 surrogate 경로는 operation·output 어디서든 거부한다(astral·U+FFFD는 통과)", () => {
  const HIGH = "\uD800";
  const LOW = "\uDC00";
  for (const lone of [HIGH, LOW, `docs/${HIGH}.md`, `docs/${LOW}.md`, `docs/a${HIGH}b/c.md`, `${LOW}${HIGH}`]) {
    assert.equal(
      codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: lone })] }), BINDING)),
      "plan_invalid",
      `operation 경로: ${JSON.stringify(lone)}`,
    );
    assert.equal(
      codeOf(() =>
        validateTypedExecutionPlan(planObject({ result: { summary: "s", outputs: [{ path: lone, role: "output" }] } }), BINDING),
      ),
      "plan_invalid",
      `output 경로: ${JSON.stringify(lone)}`,
    );
  }
  // **유효한 astral pair와 리터럴 U+FFFD는 통과한다** — 왕복이 깨지지 않는다.
  for (const ok of ["docs/😀.md", "docs/\uFFFD.md", "😀/\uFFFD", "docs/\uD83D\uDE00.md"]) {
    assert.equal(hasLoneSurrogate(ok), false, ok);
    assert.equal(
      (validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: ok })] }), BINDING).operations[0] as TypedWriteFileOperation).path,
      ok,
      `왕복 가능한 경로를 거부한다: ${JSON.stringify(ok)}`,
    );
    assert.equal(
      validateTypedExecutionPlan(planObject({ result: { summary: "s", outputs: [{ path: ok, role: "output" }] } }), BINDING)
        .result.outputs[0].path,
      ok,
    );
  }
  // 승인 문서(manifest)의 경로 계약도 같다 — writableRoots·ownership·승인 operation 경로 전부.
  assert.equal(codeOf(() => validateApprovalManifest(manifestObject({ writableRoots: [`docs${HIGH}`] }))), "path_not_utf8");
  assert.equal(
    codeOf(() => validateApprovalManifest(manifestObject({ ownershipByTask: { root: [`docs/${LOW}`] } }))),
    "path_not_utf8",
  );
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestObject({
          operationAuthorityByTask: { root: [{ authorityId: "w-x", kind: "write_file", path: `docs/${HIGH}.md`, maxBytes: 8 }] },
        }),
      ),
    ),
    "path_not_utf8",
  );
  // 승인된 실행 파일 절대 경로와 argv도 같은 이유로 왕복이 보존돼야 한다.
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestObject({ executionAuthority: { ...EXECUTION_AUTHORITY, node: { path: `/opt/${HIGH}/node`, sha256: "e".repeat(64) } } }),
      ),
    ),
    "invalid_manifest",
  );
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestObject({
          operationAuthorityByTask: {
            root: [
              { authorityId: "p-x", kind: "run_process", action: "validate-plan", data: { planPath: `docs/${HIGH}.json` }, timeoutMs: 1000 },
            ],
          },
        }),
      ),
    ),
    "operation_data_not_approved",
  );
});

// ── 4. permit·grant가 없으면 아무 일도 일어나지 않는다 (3A 리비전 A2) ────────

test("[M5c] 평범한/위조 permit·grant로는 쓰기도 프로세스 명세도 얻지 못한다(효과 0)", () => {
  const f = fixture();
  const permit = permitFor(f.kernel, "root", [writeOp(), processOp()]);
  const op = permit.plan.operations[0] as TypedWriteFileOperation;
  const pop = permit.plan.operations[1] as TypedRunProcessOperation;
  const grant = grantFor(f.kernel, permit, op.operationId);

  const forged: unknown[] = [
    null,
    undefined,
    "permit",
    42,
    {},
    { ...permit },                                         // 같은 필드를 가진 평범한 사본
    { runId: RUN_ID, taskId: "root", attemptId: "att.1", turnId: "turn-1", plan: permit.plan },
    Object.freeze({ ...permit }),
    Object.create(permit),                                 // prototype 상속
    new Proxy(permit, {}),                                 // proxy wrapper
    { ...grant },                                          // grant 모양의 평범한 사본
    Object.freeze({ ...grant }),
    new Proxy(grant, {}),
  ];
  for (const bad of forged) {
    // 효과 진입점은 **grant**를 요구하므로 위조·permit-만으로는 `dispatch_grant_invalid`다.
    assert.equal(codeOf(() => applyWriteFile(op, bad)), "dispatch_grant_invalid", JSON.stringify(bad) ?? "?");
    // 순수 판정(권능 발급 포함)은 permit도 받으므로 위조는 `dispatch_permit_invalid`다.
    assert.equal(codeOf(() => resolveProcessLaunchCapability(pop, bad)), "dispatch_permit_invalid");
    assert.equal(codeOf(() => resolveWriteFileAuthority(op, bad)), "dispatch_permit_invalid");
  }
  // **진짜 permit이라도 grant 없이는 효과가 없다**(집행 전 durable 등록 강제 — 3A 2차 리비전 A2).
  assert.equal(codeOf(() => applyWriteFile(op, permit)), "dispatch_grant_invalid");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), [], "거부 경로가 파일을 남겼다");
  // permit·grant 발급기·factory는 export되지 않는다: 진짜 값은 kernel 인스턴스에서만 나온다.
  assert.equal(typeof (permit as { plan?: unknown }).plan, "object");
  assert.equal(Object.isFrozen(permit), true);
  assert.equal(Object.isFrozen(permit.plan), true);
  assert.equal(Object.isFrozen(grant), true);
});

test("[M5c] permit·grant에 묶이지 않은 operation은 집행되지 않는다(변조·합성·다른 계획)", () => {
  const f = fixture();
  startNow(f.kernel, "sibling");
  // turnId는 **run 전체에서 유일**하다(`accounting.chargedTurnIds`가 run 단위다) → task마다 다른 turn.
  const permitA = permitFor(f.kernel, "root", [writeOp()], "turn-a");
  const permitB = permitFor(f.kernel, "sibling", [writeOp({ operationId: "op-b", authorityId: "w-sib", path: "docs/sib.md" })], "turn-b");
  const opA = permitA.plan.operations[0] as TypedWriteFileOperation;
  const opB = permitB.plan.operations[0] as TypedWriteFileOperation;
  const grantA = grantFor(f.kernel, permitA, opA.operationId);
  const grantB = grantFor(f.kernel, permitB, opB.operationId);

  // 다른 permit/grant의 operation.
  assert.equal(codeOf(() => applyWriteFile(opA, grantB)), "dispatch_operation_unbound");
  assert.equal(codeOf(() => applyWriteFile(opB, grantA)), "dispatch_operation_unbound");
  // 구조적으로 똑같이 만든 합성 operation(신원이 다르다) — **operation 치환**이 여기서 닫힌다.
  const synthetic = Object.freeze({ ...opA }) as TypedWriteFileOperation;
  assert.notEqual(synthetic, opA);
  assert.deepEqual({ ...synthetic }, { ...opA });
  assert.equal(codeOf(() => applyWriteFile(synthetic, grantA)), "dispatch_operation_unbound");
  // 순수 validator로 따로 입양한 계획의 operation도 묶이지 않았다.
  const loose = adopt().operations[0] as TypedWriteFileOperation;
  assert.equal(codeOf(() => applyWriteFile(loose, grantA)), "dispatch_operation_unbound");
  // 계획에 없는 operationId로는 grant 자체가 나오지 않는다.
  assert.equal(codeOf(() => f.kernel.beginOperation({ permit: permitA, operationId: "op-ghost", actionId: nextId("act") })), "dispatch_operation_unbound");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  // 위 거부는 grant를 소진하지 않는다 — 진짜 짝은 그대로 집행 게이트를 지난다(발행은 A4로 fail closed).
  assert.equal(codeOf(() => applyWriteFile(opA, grantA)), "write_publish_unsupported");
});

test("[M5c] permit 발급은 durable 신원·lifecycle을 요구한다(계획이 자칭하는 신원은 무의미하다)", () => {
  const f = fixture({ startRoot: false });
  // ⓐ running이 아닌 task는 permit을 받지 못한다(ready).
  assert.equal(
    codeOf(() => f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", plan: planFor(f.kernel, "root", []) })),
    "dispatch_task_not_running",
  );
  // ⓑ ready→running 직접 경로는 여전히 없다.
  assert.equal(codeOf(() => f.kernel.startTask("root")), "preflight_required");
  assert.equal(codeOf(() => f.kernel.startScheduledBatch()), "preflight_required");
  // ⓒ prepared도 아직 아니다.
  preflight(f.kernel, ["root"]);
  assert.equal(f.kernel.getTask("root")!.state, "prepared");
  assert.equal(
    codeOf(() => f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", plan: planFor(f.kernel, "root", []) })),
    "dispatch_task_not_running",
  );
  f.kernel.startPreparedTask({ taskId: "root", actionId: nextId("act"), leaseMarker: `lease.${"0".repeat(32)}` });

  // ⓓ 계획이 다른 run/task/attempt/turn을 자칭하면 발급 자체가 거부다(binding은 durable state에서 온다).
  const good = planFor(f.kernel, "root", [writeOp()]);
  for (const [key, value] of [
    ["runId", "other-run"],
    ["taskId", "sibling"],
    ["attemptId", "att-forged"],
    ["turnId", "turn-forged"],
  ] as const) {
    assert.equal(
      codeOf(() => f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", plan: { ...good, [key]: value } })),
      "plan_invalid",
      key,
    );
  }
  // ⓔ 없는 task·계약 밖 id.
  assert.equal(
    codeOf(() => f.kernel.issueOperationDispatchPermit({ taskId: "ghost", turnId: "turn-1", plan: good })),
    "unknown_task",
  );
  assert.equal(codeOf(() => f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "", plan: good })), "invalid_id");
  // ⓕ **무효 입력은 revision을 올리지 않는다**(검증 → 커밋 순서). 유효한 발급은 turn/계획을 durable하게
  //    claim하는 **커밋**이다(3A 2차 리비전 A1 — 1차 판은 state를 바꾸지 않아 경쟁 turn을 막지 못했다).
  const before = f.kernel.getState();
  assert.equal(before.tasks.find((t) => t.taskId === "root")!.execution.dispatchTurnId, null);
  f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan: good });
  const after = f.kernel.getState();
  assert.equal(after.revision, before.revision + 1);
  const claimed = after.tasks.find((t) => t.taskId === "root")!.execution;
  assert.equal(claimed.dispatchTurnId, "turn-1");
  assert.equal(typeof claimed.dispatchPlanDigest, "string");
  // **정확히 같은 (turn, 계획)의 재발급은 durable 커밋 없이 멱등이다**(3A 3차 리비전 `C1`).
  // 이전 판은 문서만 "멱등"이라 적고 매번 `dispatch_claimed`를 커밋했다 → 재시작 정합화 loop가 bounded
  // revision·event 용량을 소모했다. 그 assertion(`rev + 1`)이 결함을 고정하고 있었으므로 **교체**했다.
  const rev = f.kernel.getState().revision;
  const events = () => readFileSync(f.kernel.paths.eventsFile, "utf8").trimEnd().split("\n").length;
  const eventsBefore = events();
  const again = f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan: good });
  assert.equal(f.kernel.getState().tasks.find((t) => t.taskId === "root")!.execution.dispatchTurnId, "turn-1");
  assert.equal(f.kernel.getState().revision, rev, "정확히 같은 claim의 재발급이 revision을 올렸다");
  assert.equal(events(), eventsBefore, "정확히 같은 claim의 재발급이 dispatch_claimed를 또 남겼다");
  // 그래도 **새로 봉인된 permit**이 나온다(재시작한 controller가 정합화에 쓸 수 있어야 한다).
  assert.equal(again.turnId, "turn-1");
  assert.equal(again.attemptId, f.kernel.getTask("root")!.execution.attemptId);
  // 반복해도 durable 사실은 그대로다(정합화 loop가 감사 로그를 채우지 않는다).
  for (let i = 0; i < 3; i++) f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", plan: good });
  assert.equal(f.kernel.getState().revision, rev);
  assert.equal(events(), eventsBefore);
});

test("[M5c] A1: durable turn이 null인 동안에도 두 turn/계획이 함께 살아남지 못한다", () => {
  // 1차 판의 실패 경로 그대로: durable turn이 `null`인 상태에서 turn-1·turn-2 permit을 각각 받아
  // **둘 다** 집행할 수 있었다. 지금은 **먼저 claim한 것 하나만** 존재하고 나머지는 fail closed다.
  const f = fixture();
  assert.equal(f.kernel.getTask("root")!.execution.turnId, null, "durable turn이 null인 상태에서 시작한다");
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, null);

  // **아직 과금되지 않은 claim**(= 끝나지 않은 turn)을 잡는다.
  const plan1 = planFor(f.kernel, "root", [writeOp()], "turn-1");
  const permit1 = f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan: plan1 });
  // ⓐ 끝나지 않은 claim이 있는 동안 다른 turn은 permit을 받지 못한다.
  assert.equal(
    codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-2" })], "turn-2")),
    "dispatch_identity_stale",
  );
  // ⓑ 같은 turn이라도 **다른 계획**이면 거부다(경쟁 계획).
  assert.equal(
    codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-3", content: "다른 계획" })], "turn-1")),
    "dispatch_plan_conflict",
  );
  // ⓒ durable claim은 정확히 하나다.
  const exec = f.kernel.getTask("root")!.execution;
  assert.equal(exec.dispatchTurnId, "turn-1");
  // ⓓ' 과금됐지만 **미확정 operation이 남은** claim도 다른 turn을 막는다(정합화가 먼저다).
  f.kernel.chargeDispatchTurnUsage({ permit: permit1, actionId: nextId("act"), inputTokens: 1, outputTokens: 0, elapsedMs: 1 });
  const held = f.kernel.beginOperation({ permit: permit1, operationId: "op-1", actionId: nextId("act") });
  assert.equal(
    codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-4" })], "turn-3")),
    "dispatch_identity_stale",
  );
  // ⓔ claim된 turn 말고 다른 turn을 과금할 수 없다(durable turn 신원 갈아끼우기 차단).
  assert.equal(
    codeOf(() =>
      f.kernel.chargeTurnUsage({ taskId: "root", actionId: nextId("act"), turnId: "turn-2", inputTokens: 1, outputTokens: 1, elapsedMs: 1 }),
    ),
    "turn_conflict",
  );
  // ⓕ **끝난 claim**(과금 + 미확정 0)만 다음 turn에게 자리를 내준다.
  f.kernel.failOperation({ grant: held, actionId: nextId("act"), marker: "denied" });
  const permit2 = permitFor(f.kernel, "root", [writeOp({ operationId: "op-5" })], "turn-4");
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-4");
  // 그리고 낡은 claim의 grant·permit은 그 자리에서 죽는다.
  assert.equal(codeOf(() => f.kernel.beginOperation({ permit: permit1, operationId: "op-1", actionId: nextId("act") })), "dispatch_identity_stale");
  const op5 = permit2.plan.operations[0] as TypedWriteFileOperation;
  assert.equal(codeOf(() => applyWriteFile(op5, grantFor(f.kernel, permit2, op5.operationId))), "write_publish_unsupported");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
});

test("[M5c] A1: 공개 getState()를 monkey-patch해도 취소·정리된 task를 되살릴 수 없다", () => {
  const f = fixture();
  const [op, grant] = writePermit(f);
  const live = f.kernel.getState(); // 아직 running인 스냅샷을 잡아 둔다
  assert.equal(live.tasks.find((t) => t.taskId === "root")!.state, "running");

  f.kernel.requestCancel({ taskId: "root", actionId: nextId("act") });
  assert.equal(f.kernel.getTask("root")!.state, "cleaning");

  // **공개 메서드를 옛 running 스냅샷으로 바꾸려는 시도 전부가 막힌다.**
  const proto = Object.getPrototypeOf(f.kernel) as { getState: () => unknown };
  const patched = () => live;
  // ⓐ 인스턴스에 own property를 심을 수 없다(생성 시 freeze).
  assert.throws(() => Object.defineProperty(f.kernel, "getState", { value: patched, configurable: true }), TypeError);
  assert.throws(() => {
    (f.kernel as unknown as { getState: unknown }).getState = patched;
  }, TypeError);
  // ⓑ prototype도 frozen이라 교체·재정의가 불가능하다.
  assert.equal(Object.isFrozen(proto), true, "prototype이 더 이상 frozen이 아니다");
  assert.throws(() => Object.defineProperty(proto, "getState", { value: patched, configurable: true }), TypeError);
  // ⓒ **그리고 게이트는 애초에 공개 메서드를 지나지 않는다**: permit 레코드가 `#state`를 직접 읽으므로
  //    호출자가 붙잡아 둔 옛 running 스냅샷은 어떤 경로로도 판정에 들어가지 못한다.
  //    (`live`를 돌려주는 대역 kernel을 만들어도 그 인스턴스는 이 permit의 발급자가 아니다.)
  const impostor = { getState: patched, paths: f.kernel.paths } as unknown;
  assert.equal(codeOf(() => resolveWriteFileAuthority(op, impostor)), "dispatch_permit_invalid");
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "dispatch_task_not_running");
  assert.equal(codeOf(() => resolveWriteFileAuthority(op, grant)), "dispatch_task_not_running");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), [], "취소된 task가 효과를 만들었다");
});

test("[M5c] lifecycle·attempt·turn이 어긋나면 발급된 permit도 효과 0으로 거부된다", () => {
  // ⓐ permit 발급 뒤 task가 running을 벗어나면 집행되지 않는다(취소 → cleaning).
  {
    const f = fixture();
    const [op, permit] = writePermit(f);
    f.kernel.requestCancel({ taskId: "root", actionId: nextId("act") });
    assert.equal(f.kernel.getTask("root")!.state, "cleaning");
    assert.equal(codeOf(() => applyWriteFile(op, permit)), "dispatch_task_not_running");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  }
  // ⓑ **낡은 attempt**: 다음 attempt가 시작되면 이전 attempt의 permit·grant는 죽는다.
  {
    const f = fixture();
    const lease = startNow(f.kernel, "sibling"); // sibling으로 attempt 순환을 만든다
    const permit = permitFor(f.kernel, "sibling", [writeOp({ authorityId: "w-sib", path: "docs/sib.md" })], "turn-s1");
    const op = permit.plan.operations[0] as TypedWriteFileOperation;
    const grant = grantFor(f.kernel, permit, op.operationId);
    const firstAttempt = permit.attemptId;

    f.kernel.recordTerminal({ taskId: "sibling", actionId: nextId("act"), marker: "worker_failed" });
    f.kernel.confirmCleanup({ taskId: "sibling", actionId: nextId("act"), leaseMarker: lease });
    // **A3: 미확정 operation을 남긴 채 attempt를 떠날 수 없다** — 먼저 정합화한다(cleaning에서도 가능).
    assert.equal(codeOf(() => f.kernel.settleCleanedAttempt({ taskId: "sibling", actionId: nextId("act") })), "operation_pending_unreconciled");
    f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" });
    f.kernel.settleCleanedAttempt({ taskId: "sibling", actionId: nextId("act") });
    assert.equal(f.kernel.getTask("sibling")!.state, "retry_wait");
    startNow(f.kernel, "sibling");
    assert.equal(f.kernel.getTask("sibling")!.state, "running");
    assert.notEqual(f.kernel.getTask("sibling")!.execution.attemptId, firstAttempt);

    // 낡은 attempt의 permit·grant·영수증 재생(replay)은 전부 닫힌다.
    assert.equal(codeOf(() => resolveWriteFileAuthority(op, permit)), "dispatch_identity_stale");
    assert.equal(codeOf(() => f.kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") })), "dispatch_identity_stale");
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "dispatch_grant_spent");
    assert.equal(
      codeOf(() => f.kernel.recordOperationReceipt({ outcome: { ...grant, marker: "applied" }, actionId: nextId("act") })),
      "invalid_receipt",
    );
    assert.equal(lstatSync(join(f.ws, "docs/sib.md"), { throwIfNoEntry: false }), undefined);
  }
  // ⓒ **과금은 turn을 닫지 않는다 — 미확정 operation이 0이 될 때 닫힌다**(3A 3차 리비전 A1).
  //    이전 판은 "과금 = turn 닫기"였고 미확정이 있으면 아예 거부했으므로 계획을 만든 turn은 효과가 끝난
  //    뒤에야 과금될 수 있었다 → 효과 게이트의 토큰 판정이 항상 한 turn 뒤처진 값을 봤다.
  {
    const f = fixture();
    const permit = permitFor(f.kernel, "root", [writeOp()], "turn-1", { inputTokens: 1, outputTokens: 1 }); // claim + 과금
    const op = permit.plan.operations[0] as TypedWriteFileOperation;
    assert.deepEqual(f.kernel.getAccounting().chargedTurnIds, ["turn-1"], "grant 전에 그 turn이 과금돼 있어야 한다");
    const grant = grantFor(f.kernel, permit, op.operationId);
    // 미확정 operation이 남아 있는 동안 claim은 **열려 있다**(그 계획의 정합화 경로가 살아 있어야 한다).
    assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-1");
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "write_publish_unsupported");
    // 집행 경계에 들어갔으므로 평범한 실패로 닫을 수 없다 → 정직한 불확실 종결로 닫는다(3A 4차 A2/A3).
    const p = f.kernel.getTask("root")!.execution.pendingOperations[0];
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
    const exec = f.kernel.getTask("root")!.execution;
    assert.equal(exec.turnId, "turn-1");
    // claim은 **다음 turn이 요청할 때** 교체된다(지연 해제 — 그래야 정합화 경로가 죽지 않는다).
    assert.equal(exec.dispatchTurnId, "turn-1");
    // 과금이 끝난 turn을 **다른 계획으로 다시 열 수는 없다**.
    assert.equal(
      codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-again" })], "turn-1")),
      "turn_already_charged",
    );
    // 다음 turn은 정상적으로 열린다(같은 attempt 안에서 turn이 이어진다).
    const permit2 = permitFor(f.kernel, "root", [writeOp({ operationId: "op-t2", path: "docs/small.md", authorityId: "w-small", content: "x" })], "turn-2");
    const op2 = permit2.plan.operations[0] as TypedWriteFileOperation;
    assert.equal(codeOf(() => applyWriteFile(op2, grantFor(f.kernel, permit2, op2.operationId))), "write_publish_unsupported");
  }
  // ⓓ **과금하지 않은 turn은 grant도 효과도 얻지 못한다**(3A 3차 리비전 A1 — stale 예산 판정 차단).
  {
    const f = fixture();
    const plan = planFor(f.kernel, "root", [writeOp()], "turn-1");
    const permit = f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
    assert.deepEqual(f.kernel.getAccounting().chargedTurnIds, []);
    assert.equal(
      codeOf(() => f.kernel.beginOperation({ permit, operationId: "op-1", actionId: nextId("act") })),
      "budget_turn_unaccounted",
    );
    assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 0, "미과금 turn이 pending을 남겼다");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
    // **권위 있는 과금**만 그 자리를 연다(3A 4차 리비전 A1).
    f.kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 0, elapsedMs: 1 });
    const grant = f.kernel.beginOperation({ permit, operationId: "op-1", actionId: nextId("act") });
    assert.equal(codeOf(() => applyWriteFile(permit.plan.operations[0] as TypedWriteFileOperation, grant)), "write_publish_unsupported");
  }
  assert.ok(DISPATCH_AUTHORITY_CODES.includes("budget_turn_unaccounted"));
});

test("[M5c] A1: bare 회계는 남이 claim한 생산 turn을 선점·정산할 수 없다(회계 부패·거짓 정산 차단)", () => {
  // **4차 판의 진짜 결함**(독립 리뷰 A-1): `chargeTurnUsage`가 caller-selected `{taskId, turnId}`를 받고
  // 중복 namespace가 run 전역이었으므로, claim이 없는 sibling이 **생산 task가 claim한 turn ID**를 0 토큰으로
  // 과금할 수 있었다. `chargedPlanDigest` 덕분에 효과가 직접 승인되지는 않았지만 두 가지가 부패했다:
  //   ① 생산 task의 **진짜 사용량이 영구히 과금 불가**가 된다(`turn_already_charged`) → 예산 집행이 그
  //      turn을 아예 세지 못한다.
  //   ② `dispatchTurnSettled`가 run 전역 turn ID를 정산 권위로 봤으므로, 그 **거짓 정산** 위에서 다음
  //      turn이 claim을 교체할 수 있었다.
  // **직전 판의 assertion(ⓐ 통과 · ⓒ "남의 과금은 DoS일 뿐 우회가 아니다")은 바로 그 부패를 정상 동작으로
  // 고정하고 있었으므로 교체했다**(완화가 아니라 강화 — 전수 기록은 WORKLOG).
  const f = fixture();
  startNow(f.kernel, "sibling");
  const plan = planFor(f.kernel, "root", [writeOp()], "turn-1");
  const permit = f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
  const accBefore = f.kernel.getAccounting();
  const revBefore = f.kernel.getState().revision;
  const bare = (taskId: string, turnId: string): string =>
    codeOf(() =>
      f.kernel.chargeTurnUsage({ taskId, turnId, actionId: nextId("act"), inputTokens: 0, outputTokens: 0, elapsedMs: 0 }),
    );

  // ⓐ **선점 공격은 커밋 전에 거부된다**: 남이 claim한 turn은 bare 회계 대상이 아니다(자기 이름이든
  //    생산 task 이름이든 같다).
  assert.equal(bare("sibling", "turn-1"), "turn_conflict", "sibling이 남의 claim된 turn을 선점했다");
  assert.equal(bare("root", "turn-1"), "turn_conflict");
  assert.deepEqual(f.kernel.getAccounting(), accBefore, "거부된 bare 회계가 durable 회계를 바꿨다");
  assert.equal(f.kernel.getState().revision, revBefore, "거부된 bare 회계가 커밋됐다");
  assert.deepEqual(f.kernel.getAccounting().chargedTurnIds, [], "bare 회계가 turn ID를 예약했다");

  // ⓑ **거짓 정산도 성립하지 않는다**: 이 task의 진짜 과금 증거가 없으면 claim은 교체되지 않는다
  //    (정산 권위가 run 전역 turn ID 집합이 아니라 task-local 증거이기 때문이다).
  assert.equal(f.kernel.getTask("root")!.execution.chargedPlanDigest, null);
  assert.equal(
    codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-t2" })], "turn-2")),
    "dispatch_identity_stale",
  );
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-1", "claim이 거짓 정산으로 교체됐다");

  // ⓒ **진짜 생산자의 과금은 그대로 성공한다**(선점당하지 않았으므로 멱등 규칙에 걸리지 않는다).
  f.kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 7, outputTokens: 5, elapsedMs: 3 });
  assert.equal(f.kernel.getAccounting().tokensUsed, 12, "생산 turn의 진짜 사용량이 회계에 없다");
  {
    const exec = f.kernel.getTask("root")!.execution;
    assert.equal(exec.turnId, "turn-1");
    assert.equal(exec.chargedPlanDigest, exec.dispatchPlanDigest, "권위 증거가 claim된 계획과 다르다");
  }
  // 그리고 이제 효과 경로가 열린다(위 거부들이 생산자를 막지 않았다는 대조군).
  const grant = f.kernel.beginOperation({ permit, operationId: "op-1", actionId: nextId("act") });

  // ⓓ **미확정 operation이 0이 될 때까지 claim은 교체되지 않는다**(과금만으로는 정산이 아니다).
  assert.equal(
    codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-t3" })], "turn-3")),
    "dispatch_identity_stale",
  );
  f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" });
  // 진짜 과금 + 미확정 0 → 이제 다음 turn이 claim을 교체한다.
  const next = permitFor(
    f.kernel,
    "root",
    [writeOp({ operationId: "op-t3", path: "docs/small.md", authorityId: "w-small", content: "x" })],
    "turn-3",
  );
  assert.equal(next.turnId, "turn-3");
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-3");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);

  // ⓔ **claim이 없는 turn의 bare 회계는 그대로 가능하다**(대장 `B-12` — 만료·재시작 뒤 이미 태운 자원
  //    기록을 막지 않는다). sibling은 자기 turn을 자유롭게 과금한다.
  f.kernel.chargeTurnUsage({
    taskId: "sibling",
    turnId: "turn-sib",
    actionId: nextId("act"),
    inputTokens: 4,
    outputTokens: 0,
    elapsedMs: 1,
  });
  assert.ok(f.kernel.getAccounting().chargedTurnIds.includes("turn-sib"));
  assert.equal(f.kernel.getTask("sibling")!.execution.chargedPlanDigest, null, "권위 없는 과금이 증거를 남겼다");

  // ⓕ 위조·평범한 객체 permit으로는 권위 과금 자체가 불가능하다.
  for (const forged of [null, undefined, {}, { ...permit }, new Proxy(permit, {})]) {
    assert.equal(
      codeOf(() => f.kernel.chargeDispatchTurnUsage({ permit: forged, actionId: nextId("act"), inputTokens: 1, outputTokens: 0, elapsedMs: 1 })),
      "dispatch_permit_invalid",
    );
  }
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);

  // ⓖ **claim 위에서 권위 없는 과금**은 turn이 아직 안 태워졌어도 불가능하다(permit을 요구한다).
  {
    const g = fixture();
    const p = g.kernel.issueOperationDispatchPermit({
      taskId: "root",
      turnId: "turn-1",
      actionId: nextId("act"),
      plan: planFor(g.kernel, "root", [writeOp()]),
    });
    assert.equal(
      codeOf(() =>
        g.kernel.chargeTurnUsage({
          taskId: "root",
          turnId: "turn-1",
          actionId: nextId("act"),
          inputTokens: 1,
          outputTokens: 1,
          elapsedMs: 1,
        }),
      ),
      "turn_conflict",
    );
    assert.deepEqual(g.kernel.getAccounting().chargedTurnIds, [], "거부된 과금이 회계를 바꿨다");
    // 권위 있는 과금만 증거를 남기고, 그때 효과가 열린다.
    g.kernel.chargeDispatchTurnUsage({ permit: p, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
    const exec = g.kernel.getTask("root")!.execution;
    assert.equal(exec.turnId, "turn-1");
    assert.equal(exec.chargedPlanDigest, exec.dispatchPlanDigest, "권위 증거가 claim된 계획과 다르다");
    assert.ok(g.kernel.beginOperation({ permit: p, operationId: "op-1", actionId: nextId("act") }));
  }
});

test("[M5c] A1(6차): 두 task가 같은 turn ID를 claim할 수 없다(과금 namespace = claim namespace)", () => {
  // **5차 판의 남은 결함**(독립 리뷰 6차 A1): `issueOperationDispatchPermit()`이 대상 task의 claim과 run
  // 전역 `chargedTurnIds`만 봤다 → 두 running task가 **둘 다 genuine permit으로** 같은 turn ID를 claim할 수
  // 있었다. B가 먼저 과금하면 A의 진짜 과금은 `turn_already_charged`로 영구히 막히고, A는 task-local 과금
  // 증거를 얻지 못해 claim을 정산도 교체도 하지 못한다 → A는 그 attempt 안에서 영구 교착이다.
  // 5차 A1 테스트는 bare 회계 공격만 봤고 **두 genuine claim의 충돌**은 보지 않았다.
  const f = fixture();
  startNow(f.kernel, "sibling");
  const permit = f.kernel.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-1",
    actionId: nextId("act"),
    plan: planFor(f.kernel, "root", [writeOp()], "turn-1"),
  });
  const accBefore = f.kernel.getAccounting();
  const revBefore = f.kernel.getState().revision;
  const eventsBefore = readFileSync(f.kernel.paths.eventsFile, "utf8");

  // ⓐ **두 번째 genuine claim은 커밋 전에 거부된다.**
  assert.equal(
    codeOf(() =>
      f.kernel.issueOperationDispatchPermit({
        taskId: "sibling",
        turnId: "turn-1",
        actionId: nextId("act"),
        plan: planFor(f.kernel, "sibling", [writeOp({ authorityId: "w-sib", path: "docs/sib.md" })], "turn-1"),
      }),
    ),
    "turn_conflict",
  );
  assert.equal(f.kernel.getState().revision, revBefore, "거부된 claim이 커밋됐다");
  assert.deepEqual(f.kernel.getAccounting(), accBefore, "거부된 claim이 회계를 바꿨다");
  assert.equal(readFileSync(f.kernel.paths.eventsFile, "utf8"), eventsBefore, "거부된 claim이 event를 남겼다");
  assert.equal(f.kernel.getTask("sibling")!.execution.dispatchTurnId, null, "sibling이 남의 turn을 claim했다");
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-1");

  // ⓑ **정확히 같은 (turn, 계획)의 재발급은 그대로 멱등이다**(revision·event 0).
  const again = f.kernel.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-1",
    actionId: nextId("act"),
    plan: planFor(f.kernel, "root", [writeOp()], "turn-1"),
  });
  assert.equal(again.turnId, "turn-1");
  assert.equal(f.kernel.getState().revision, revBefore, "멱등 재발급이 커밋됐다");
  assert.equal(readFileSync(f.kernel.paths.eventsFile, "utf8"), eventsBefore);

  // ⓒ **대조군**: 진짜 claim 보유자의 과금·집행·정산은 전부 정상 진행된다(거부가 생산자를 막지 않는다).
  f.kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 3, outputTokens: 2, elapsedMs: 1 });
  assert.equal(f.kernel.getAccounting().tokensUsed, 5);
  const grant = f.kernel.beginOperation({ permit, operationId: "op-1", actionId: nextId("act") });
  f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" });
  // 정산된 claim은 다음 turn이 교체하고, 그제서야 그 turn ID가 풀린다(그러나 turn-1은 이미 과금돼 닫혔다).
  const next = permitFor(
    f.kernel,
    "root",
    [writeOp({ operationId: "op-t2", path: "docs/small.md", authorityId: "w-small", content: "x" })],
    "turn-2",
  );
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-2");
  // sibling은 **자기 turn**을 자유롭게 claim한다(막는 것은 충돌뿐이다).
  assert.ok(
    f.kernel.issueOperationDispatchPermit({
      taskId: "sibling",
      turnId: "turn-sib",
      actionId: nextId("act"),
      plan: planFor(f.kernel, "sibling", [writeOp({ authorityId: "w-sib", path: "docs/sib.md" })], "turn-sib"),
    }),
  );
  // 그리고 root의 turn-2도 sibling에게 뺏기지 않는다.
  assert.equal(
    codeOf(() =>
      f.kernel.issueOperationDispatchPermit({
        taskId: "sibling",
        turnId: next.turnId,
        actionId: nextId("act"),
        plan: planFor(f.kernel, "sibling", [writeOp({ authorityId: "w-sib", path: "docs/sib.md" })], next.turnId),
      }),
    ),
    "turn_conflict",
  );
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
});

test("[M5c] A1(6차): 손으로 만든 중복 live claim state는 load에서 거부된다", () => {
  const f = fixture();
  startNow(f.kernel, "sibling");
  f.kernel.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-1",
    actionId: nextId("act"),
    plan: planFor(f.kernel, "root", [writeOp()], "turn-1"),
  });
  const raw = JSON.parse(readFileSync(f.kernel.paths.stateFile, "utf8")) as {
    tasks: Array<{ taskId: string; execution: Record<string, unknown> }>;
  };
  const root = raw.tasks.find((t) => t.taskId === "root")!;
  const sibling = raw.tasks.find((t) => t.taskId === "sibling")!;
  assert.equal(root.execution.dispatchTurnId, "turn-1");
  sibling.execution.dispatchTurnId = root.execution.dispatchTurnId;
  sibling.execution.dispatchPlanDigest = root.execution.dispatchPlanDigest;
  // 교차 불변식 자체가 이 state를 거부한다(digest 체인에 가려지지 않는 직접 단정).
  assert.equal(codeOf(() => validateRunState(raw)), "invalid_state");
  writeFileSync(f.kernel.paths.stateFile, JSON.stringify(raw, null, 2), "utf8");
  // 커밋과 load가 같은 불변식 하나를 지난다 → 편집된 state는 열리지 않는다.
  const code = codeOf(() => OrchestrationKernel.open({ workspaceRoot: f.ws, runId: RUN_ID }));
  assert.ok(["state_event_binding_mismatch", "invalid_state"].includes(code), `예상 밖 코드: ${code}`);
});

test("[M5c] A1: 손으로 심은 chargedPlanDigest는 load에서 거부된다(state 편집으로 효과를 승인할 수 없다)", () => {
  const f = fixture();
  const raw = JSON.parse(readFileSync(f.kernel.paths.stateFile, "utf8")) as {
    tasks: Array<{ taskId: string; execution: Record<string, unknown> }>;
  };
  const root = raw.tasks.find((t) => t.taskId === "root")!;
  assert.equal(root.execution.chargedPlanDigest, null, "권위 증거가 durable 계약에 없다");
  assert.equal(root.execution.turnId, null);
  root.execution.chargedPlanDigest = "b".repeat(64);
  writeFileSync(f.kernel.paths.stateFile, JSON.stringify(raw, null, 2), "utf8");
  // state↔event binding이 먼저 잡거나(내용 digest 변화) 교차 불변식이 잡거나 — **어느 쪽이든 fail closed**다.
  const code = codeOf(() => OrchestrationKernel.open({ workspaceRoot: f.ws, runId: RUN_ID }));
  assert.ok(["state_event_binding_mismatch", "invalid_state"].includes(code), `예상 밖 코드: ${code}`);
});

test("[M5c] 만료·예산 deadline은 경계 등호에서 거부한다(로드맵 §8.1)", () => {
  // 만료 경계: `expiresAt`과 **정확히 같은** 시각의 집행은 거부다(루프로 태우지 않고 정확히 옮긴다).
  {
    const expiresAt = "2026-07-30T00:10:00.000Z";
    const t = steppableClock(T0);
    // no-progress·attempt wall이 먼저 걸리지 않도록 만료보다 넉넉하게 둔다(여기서 보는 것은 만료 등호다).
    const f = fixture({ manifestOver: { expiresAt, autopilotPolicy: { ...POLICY, maxNoProgressMs: 900_000 } }, clock: t.clock });
    const [op, grant, pop, pgrant] = bothPermit(f);
    assert.equal(f.kernel.getState().manifest.expiresAt, expiresAt);
    t.set(Date.parse(expiresAt) - 1);
    assert.equal(codeOf(() => resolveProcessLaunchCapability(pop, pgrant)), "no-error", "만료 1ms 전은 통과해야 한다");
    t.set(Date.parse(expiresAt)); // **등호**
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "manifest_expired");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  }
  // 예산 deadline 경계: `budgetDeadlineAt`과 정확히 같은 시각도 거부다.
  {
    const t = steppableClock(T0);
    const f = fixture({
      manifestOver: {
        maxElapsedMs: 60_000,
        autopilotPolicy: { ...POLICY, maxAttemptElapsedMs: 60_000, maxNoProgressMs: 900_000 },
      },
      clock: t.clock,
    });
    const deadline = f.kernel.getState().accounting.budgetDeadlineAt;
    assert.equal(deadline < EXPIRES, true, "예산 deadline이 만료보다 이르지 않다");
    const [op, grant] = writePermit(f);
    t.set(Date.parse(deadline)); // **등호**
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "budget_elapsed_exhausted");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  }
  assert.ok(DISPATCH_AUTHORITY_CODES.includes("manifest_expired"));
  assert.ok(DISPATCH_AUTHORITY_CODES.includes("budget_elapsed_exhausted"));
});

test("[M5c] A1: 토큰 등호·attempt wall 등호·no-progress 등호가 각각 효과를 막는다(파일 효과 0)", () => {
  // ⓐ **토큰 예산 등호 + 생산 turn의 사용량이 효과보다 먼저 반영된다**(3A 3차 리비전 A1).
  //    이전 판은 그 turn을 과금하려면 먼저 pending을 닫아야 했으므로 **효과가 stale 총량으로 판정**됐다.
  {
    const f = fixture({ manifestOver: { maxTokens: 10 } });
    // 이 turn이 상한을 정확히 다 태웠다 → claim은 살아 있지만 효과는 나가지 않는다.
    const permit = permitFor(f.kernel, "root", [writeOp()], "turn-1", { inputTokens: 6, outputTokens: 4 });
    const op = permit.plan.operations[0] as TypedWriteFileOperation;
    assert.equal(f.kernel.getAccounting().tokensUsed, 10, "정확히 상한만큼 태웠다(등호)");
    assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, "turn-1", "과금이 claim을 조기에 닫았다");
    assert.equal(codeOf(() => grantFor(f.kernel, permit, op.operationId)), "budget_tokens_exhausted");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
    // 1 토큰이 남아 있으면 같은 자리가 열린다(게이트가 공허하지 않다는 대조군).
    const g = fixture({ manifestOver: { maxTokens: 10 } });
    const p2 = permitFor(g.kernel, "root", [writeOp()], "turn-1", { inputTokens: 6, outputTokens: 3 });
    assert.equal(g.kernel.getAccounting().tokensUsed, 9);
    const op2 = p2.plan.operations[0] as TypedWriteFileOperation;
    assert.equal(codeOf(() => applyWriteFile(op2, grantFor(g.kernel, p2, op2.operationId))), "write_publish_unsupported");
  }
  // ⓑ **attempt wall deadline 등호**.
  {
    const t = steppableClock(T0);
    const f = fixture({ manifestOver: { autopilotPolicy: { ...POLICY, maxAttemptElapsedMs: 30_000 } }, clock: t.clock });
    const [op, grant] = writePermit(f);
    const wall = f.kernel.getTask("root")!.execution.wallDeadlineAt!;
    t.set(Date.parse(wall) - 1);
    assert.equal(codeOf(() => resolveWriteFileAuthority(op, grant)), "no-error", "wall 1ms 전은 통과해야 한다");
    t.set(Date.parse(wall)); // **등호**
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "attempt_wall_exhausted");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  }
  // ⓒ **no-progress deadline 등호**(진행 신호가 되돌리는 유일한 시계).
  {
    const t = steppableClock(T0);
    const f = fixture({ manifestOver: { autopilotPolicy: { ...POLICY, maxNoProgressMs: 5_000 } }, clock: t.clock });
    const [op, grant] = writePermit(f);
    const started = f.kernel.getTask("root")!.execution.phaseStartedAt!;
    t.set(Date.parse(started) + 5_000 - 1);
    assert.equal(codeOf(() => resolveWriteFileAuthority(op, grant)), "no-error", "no-progress 1ms 전은 통과해야 한다");
    t.set(Date.parse(started) + 5_000); // **등호**
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "no_progress_exhausted");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
    // **소진된 attempt는 늦은 진행으로 되살아나지 않는다**(3A 3차 리비전 A1). 이전 assertion은 정확히
    // 그 부활을 **정상 동작으로 고정**하고 있었으므로 교체했다(완화가 아니라 강화 — WORKLOG에 전수 기록).
    const channel = channelFor(f.kernel, "root");
    const late = () =>
      f.kernel.recordProgress({ channel, actionId: nextId("act"), event: { kind: "progress", seq: 2, step: "늦은 진행" } });
    assert.equal(codeOf(late), "no_progress_exhausted", "늦은 진행이 소진된 창을 되살렸다");
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "no_progress_exhausted");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  }
  // ⓓ **경계 안의 진행만 시계를 되돌린다**(대조군 — 위 규칙이 공허하지 않다는 증거).
  {
    const t = steppableClock(T0);
    const f = fixture({ manifestOver: { autopilotPolicy: { ...POLICY, maxNoProgressMs: 5_000 } }, clock: t.clock });
    const [op, grant] = writePermit(f);
    const channel = channelFor(f.kernel, "root");
    const started = f.kernel.getTask("root")!.execution.phaseStartedAt!;
    t.set(Date.parse(started) + 5_000 - 1); // 경계 **직전**
    f.kernel.recordProgress({ channel, actionId: nextId("act"), event: { kind: "progress", seq: 1, step: "진행" } });
    t.set(Date.parse(started) + 9_000); // 새 창 안(직전 진행 + 5s 미만)
    assert.equal(codeOf(() => applyWriteFile(op, grant)), "write_publish_unsupported", "인정된 진행이 창을 되돌리지 못했다");
  }
  // ⓔ **진행 신호에도 provenance가 필요하다**: heartbeat·구조 없는 이벤트는 시계를 못 만진다.
  {
    const f = fixture();
    const channel = channelFor(f.kernel, "root");
    const ok = { kind: "progress", seq: 1, step: "진행" };
    const bad = (over: { event: unknown; channel?: unknown }): string =>
      codeOf(() => f.kernel.recordProgress({ channel, actionId: nextId("act"), ...over }));
    assert.equal(bad({ event: { kind: "heartbeat", seq: 1, step: "x" } }), "invalid_progress_event");
    assert.equal(bad({ event: { kind: "progress", seq: 1 } }), "invalid_progress_event", "step 없는 이벤트가 통과했다");
    assert.equal(bad({ event: { kind: "progress", seq: 1, step: "x", extra: 1 } }), "invalid_artifact_ref", "닫힌 key 집합이 아니다");
    assert.equal(bad({ event: { kind: "progress", seq: -1, step: "x" } }), "invalid_progress_event");
    assert.equal(bad({ event: { kind: "progress", seq: 1, step: "" } }), "invalid_progress_event");
    assert.equal(bad({ event: null }), "invalid_artifact_ref");
    // 진짜 채널 + 진짜 progress 이벤트만 통과한다.
    assert.equal(f.kernel.recordProgress({ channel, actionId: nextId("act"), event: ok }).execution.progressCount, 1);
  }
  for (const code of ["budget_tokens_exhausted", "attempt_wall_exhausted", "no_progress_exhausted"] as const) {
    assert.ok(DISPATCH_AUTHORITY_CODES.includes(code), code);
  }
});

test("[M5c] A1: 시계 역행은 safety-only 커밋에서도 거부된다 — 소진된 창이 다시 열리지 않는다", () => {
  // **이전 판의 진짜 결함**(독립 리뷰 A-1): 공용 시계 검사(`assertClockSane`)가 `state.updatedAt`을 보지
  // 않았고 `#mutate`는 `draft.updatedAt = now`로 **덮어썼다** → safety-only 커밋(회계·취소·정리·pause)
  // 하나로 `updatedAt`을 뒤로 돌릴 수 있었다. 효과 게이트의 단조 판정이 `updatedAt`을 상한으로 쓰므로,
  // 그 순간 과거 시각이 게이트를 통과하고 wall·no-progress 창이 **다시 열렸다**.
  const t = steppableClock(T0);
  const f = fixture({ manifestOver: { autopilotPolicy: { ...POLICY, maxNoProgressMs: 5_000 } }, clock: t.clock });
  startNow(f.kernel, "sibling");
  const channel = channelFor(f.kernel, "root");
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  const started = f.kernel.getTask("root")!.execution.phaseStartedAt!;

  // 창 안에서 진행 1건을 커밋해 durable 시각을 전진시킨다.
  t.set(Date.parse(started) + 4_000);
  f.kernel.recordProgress({ channel, actionId: nextId("act"), event: { kind: "progress", seq: 1, step: "진행" } });
  const advanced = f.kernel.getState().updatedAt;
  const revision = f.kernel.getState().revision;
  assert.equal(f.kernel.getTask("root")!.execution.lastProgressAt, advanced);

  // ── 시계를 되돌린다: **전진 커밋도 safety-only 커밋도 전부** 거부된다 ──
  t.set(Date.parse(started) + 1_000);
  const rolledBack: Array<[string, () => unknown]> = [
    ["requestCancel(safety-only)", () => f.kernel.requestCancel({ taskId: "sibling", actionId: nextId("act") })],
    [
      "chargeTurnUsage(safety-only)",
      () =>
        f.kernel.chargeTurnUsage({
          taskId: "sibling",
          turnId: "turn-z",
          actionId: nextId("act"),
          inputTokens: 1,
          outputTokens: 1,
          elapsedMs: 1,
        }),
    ],
    [
      "failCleanup(safety-only)",
      () => f.kernel.failCleanup({ taskId: "root", actionId: nextId("act") }),
    ],
    [
      "recordProgress(전진)",
      () => f.kernel.recordProgress({ channel, actionId: nextId("act"), event: { kind: "progress", seq: 2, step: "진행" } }),
    ],
  ];
  for (const [label, run] of rolledBack) {
    assert.equal(codeOf(run), "clock_invalid", label);
  }
  assert.equal(f.kernel.getState().updatedAt, advanced, "역행 커밋이 durable 시각을 되돌렸다");
  assert.equal(f.kernel.getState().revision, revision, "거부된 역행 커밋이 revision을 올렸다");
  // 효과 게이트도 같은 규칙이다(과거 시각으로 창을 되살릴 수 없다).
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "clock_invalid");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);

  // ── 그리고 no-progress 창은 **그대로 소진된다**(역행이 창을 되열지 못했다) ──
  t.set(Date.parse(advanced) + 5_000); // 등호
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "no_progress_exhausted");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
});

test("[M5c] A1: 진행은 brand된 단조 worker 채널로만 들어온다(복사한 lease·구조 사본·재생·sibling 거부)", () => {
  // **이전 판의 진짜 결함**(독립 리뷰 A-1): 진행 provenance가 durable `processLeaseMarker` 하나였고
  // 그 값은 `getTask()`가 그대로 돌려준다 → state를 읽을 수 있는 코드는 누구든 lease를 베껴 no-progress
  // 시계를 되돌릴 수 있었다. `seq`도 모양만 봤으므로 같은 이벤트를 무한 재생할 수 있었다.
  const t = steppableClock(T0);
  const f = fixture({ manifestOver: { autopilotPolicy: { ...POLICY, maxNoProgressMs: 5_000 } }, clock: t.clock });
  const channel = channelFor(f.kernel, "root");
  const started = f.kernel.getTask("root")!.execution.phaseStartedAt!;
  const lease = f.kernel.getTask("root")!.execution.processLeaseMarker!;
  const ev = (seq: number) => ({ kind: "progress", seq, step: "진행" });
  const send = (chan: unknown, seq: number): string =>
    codeOf(() => f.kernel.recordProgress({ channel: chan, actionId: nextId("act"), event: ev(seq) }));

  // ⓐ **durable lease를 베껴도 채널이 되지 않는다** — 공개 API에 lease → 채널 통로가 없다.
  assert.match(lease, /^lease\.[0-9a-f]{32}$/, "lease는 getTask로 그대로 읽힌다(비밀이 아니다)");
  assert.equal(send({ ...channel, leaseMarker: lease }, 1), "invalid_progress_channel");
  // ⓑ **구조 사본·freeze·Proxy·평범한 객체**도 전부 등록부 조회에서 걸린다.
  for (const forged of [null, undefined, {}, { ...channel }, Object.freeze({ ...channel }), new Proxy(channel, {}), lease]) {
    assert.equal(send(forged, 1), "invalid_progress_channel");
  }
  // ⓒ **sibling 채널로 남의 시계를 되돌릴 수 없다**(채널은 자기 task에 묶여 있다).
  startNow(f.kernel, "sibling");
  const sibChannel = channelFor(f.kernel, "sibling");
  t.set(Date.parse(started) + 4_000);
  f.kernel.recordProgress({ channel: sibChannel, actionId: nextId("act"), event: ev(1) });
  assert.equal(f.kernel.getTask("root")!.execution.lastProgressAt, null, "sibling 진행이 root 시계를 만졌다");
  assert.equal(f.kernel.getTask("sibling")!.execution.progressCount, 1);

  // ⓓ **단조 sequence**: 진짜 채널이라도 재생·역순·같은 seq는 시계를 되돌리지 못한다.
  f.kernel.recordProgress({ channel, actionId: nextId("act"), event: ev(5) });
  const at5 = f.kernel.getTask("root")!.execution.lastProgressAt!;
  t.set(Date.parse(started) + 4_500);
  assert.equal(send(channel, 5), "invalid_progress_event", "같은 seq 재생이 통과했다");
  assert.equal(send(channel, 4), "invalid_progress_event", "역순 seq가 통과했다");
  assert.equal(f.kernel.getTask("root")!.execution.lastProgressAt, at5, "거부된 진행이 시계를 움직였다");
  assert.equal(f.kernel.getTask("root")!.execution.progressCount, 1);
  // 다음 seq는 **창이 살아 있는 동안** 정상 전진한다(게이트가 공허하지 않다는 대조군).
  f.kernel.recordProgress({ channel, actionId: nextId("act"), event: ev(6) });
  assert.equal(f.kernel.getTask("root")!.execution.progressCount, 2);

  // ⓔ **소진된 창은 진짜 다음 seq로도 되살아나지 않는다**(늦은 진행이 만료를 부활시키지 못한다).
  t.set(Date.parse(f.kernel.getTask("root")!.execution.lastProgressAt!) + 5_000); // 등호
  assert.equal(send(channel, 7), "no_progress_exhausted");

  // ⓕ **attempt가 바뀌면 옛 채널은 죽는다**(lease·attemptId 재대조).
  const g = fixture();
  const oldChannel = channelFor(g.kernel, "root");
  const oldLease = g.kernel.getTask("root")!.execution.processLeaseMarker!;
  g.kernel.recordTerminal({ taskId: "root", actionId: nextId("act"), marker: "worker_failed" });
  g.kernel.confirmCleanup({ taskId: "root", actionId: nextId("act"), leaseMarker: oldLease });
  g.kernel.settleCleanedAttempt({ taskId: "root", actionId: nextId("act") });
  startNow(g.kernel, "root");
  assert.notEqual(g.kernel.getTask("root")!.execution.processLeaseMarker, oldLease);
  assert.equal(
    codeOf(() => g.kernel.recordProgress({ channel: oldChannel, actionId: nextId("act"), event: ev(1) })),
    "cleanup_lease_mismatch",
  );
});

// ── 5. 권위 해석 (deny-by-default) ──────────────────────────────────────────

test("[M5c] 승인이 없거나 task·kind가 다르면 거부한다(deny-by-default)", () => {
  const f = fixture();
  // 한 turn = 한 계획이므로 네 경우를 같은 계획에 담는다.
  const permit = permitFor(f.kernel, "root", [
    writeOp({ operationId: "op-unknown", authorityId: "w-unknown" }),
    writeOp({ operationId: "op-sib", authorityId: "w-sib", path: "docs/sib.md" }),
    processOp({ operationId: "op-kind", authorityId: "w-doc" }),
    writeOp({ operationId: "op-proc", authorityId: "p-node" }),
  ]);
  const [unknownOp, sibOp, kindOp, procOp] = permit.plan.operations;
  const g = (op: TypedOperation) => grantFor(f.kernel, permit, op.operationId);
  // 없는 authorityId.
  assert.equal(codeOf(() => applyWriteFile(unknownOp as TypedWriteFileOperation, g(unknownOp))), "operation_denied");
  // 다른 task의 authorityId(형제 소유 권위를 빌릴 수 없다).
  assert.equal(codeOf(() => applyWriteFile(sibOp as TypedWriteFileOperation, g(sibOp))), "operation_denied");
  // kind 불일치: write authority를 process로 쓰려 한다(그 반대도).
  assert.equal(codeOf(() => resolveProcessLaunchCapability(kindOp as TypedRunProcessOperation, g(kindOp))), "operation_denied");
  assert.equal(codeOf(() => applyWriteFile(procOp as TypedWriteFileOperation, g(procOp))), "operation_denied");
  // 어떤 거부 경로도 파일을 만들지 않는다.
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
});

test("[M5c] MUTATION-GUARD: 권위 대조를 건너뛰면 거부가 사라진다", () => {
  // 이 테스트가 감시하는 seam은 `typedExecution.resolveApprovedOperation`의 `null` 검사다.
  // mutation(그 검사를 지우고 합성 authority 반환)을 넣으면 아래 두 단정이 반드시 깨져야 한다.
  const f = fixture();
  const [[op, grant]] = writeGrants(f, [{ authorityId: "w-unknown" }]);
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "operation_denied");
  assert.equal(codeOf(() => resolveWriteFileAuthority(op, grant)), "operation_denied");
  assert.equal(readdirSync(join(f.ws, "docs")).length, 0, "거부된 operation이 파일을 남겼다");
});

test("[M5c] 소유와 writableRoots는 dispatch 시점 durable 상태로 본다", () => {
  // ⓐ child durable ownership은 manifest ownershipByTask에 없어도 존중된다.
  const f = fixture();
  f.kernel.requestSpawn({
    envelope: {
      schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION,
      messageId: "msg-spawn",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "root",
      parentTaskId: null,
      sender: "tech-lead",
      recipient: ORCHESTRATOR_ID,
      type: "spawn_request",
      createdAt: "2026-07-30T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
    },
    body: body("spawn_request"),
    child: seed("root.child", ["docs/child.md"]),
  });
  startNow(f.kernel, "root.child");
  const childPermit = permitFor(f.kernel, "root.child", [
    writeOp({ operationId: "op-c", authorityId: "w-child", path: "docs/child.md" }),
    writeOp({ operationId: "op-o", authorityId: "w-outside", path: "docs/out.md" }),
  ]);
  const childOk = childPermit.plan.operations[0] as TypedWriteFileOperation;
  const childBad = childPermit.plan.operations[1] as TypedWriteFileOperation;
  writeFileSync(join(f.ws, "docs/child.md"), "hello");
  const outcome = applyWriteFile(childOk, grantFor(f.kernel, childPermit, childOk.operationId));
  assert.equal(outcome.marker, "already_applied");
  assert.equal(readFileSync(join(f.ws, "docs/child.md"), "utf8"), "hello");
  // ⓑ 승인은 있지만 child의 durable ownership 밖이면 거부다(형제 경로 침범 방지).
  assert.equal(
    codeOf(() => applyWriteFile(childBad, grantFor(f.kernel, childPermit, childBad.operationId))),
    "operation_not_owned",
  );
  assert.equal(lstatSync(join(f.ws, "docs/out.md"), { throwIfNoEntry: false }), undefined);
  // ⓒ 승인된 경로와 **정확히** 같지 않으면 거부다(계획 경로 ≠ 승인 레코드 경로).
  //    root는 위에서 spawn을 요청해 `waiting_children`이므로 별도 run에서 본다.
  const g = fixture();
  assert.equal(codeOf(() => applyWriteFile(...writePermit(g, { path: "docs/small.md" }))), "operation_denied");
  // ⓓ writableRoots 밖 경로는 **승인 문서에 담길 수조차 없다**(재검사면은 dispatch에도 남아 있다).
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestObject({
          writableRoots: ["src"],
          ownershipByTask: { root: ["src"] },
          operationAuthorityByTask: { root: [{ authorityId: "w-doc", kind: "write_file", path: "docs/out.md", maxBytes: 8 }] },
        }),
      ),
    ),
    "operation_outside_writable_root",
  );
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
});

// ── 6. write_file 집행 ──────────────────────────────────────────────────────

test("[M5c] A4: 신규 발행 경로는 도달하지 않는다(예방 — 파일 시스템 부작용 0)", () => {
  // **이전 판은 `link(2)`로 발행했고 그것이 3A 3차 리뷰 A4다**: 최종 부모 확인과 syscall 사이에 경쟁자가
  // 승인된 부모 **이름**을 교체하면 커널이 그 교체본을 통해 경로를 해석해 **승인 범위 밖으로** 발행하고,
  // 발행된 inode는 우리 temp와 같으므로 사후 검증은 통과하며 fsync는 엉뚱한 디렉터리에 걸렸다.
  // Node 18/macOS에 디스크립터 상대 no-replace 발행이 없으므로 **경로 자체를 없앴다**(fail closed).
  const f = fixture();
  const [[op1, g1], [op2, g2]] = writeGrants(f, [
    { content: "첫 내용\n" },
    { authorityId: "w-small", path: "docs/small.md", content: "x" },
  ]);
  assert.equal(codeOf(() => applyWriteFile(op1, g1)), "write_publish_unsupported");
  // **부작용 0**: 대상도 temp도 만들어지지 않는다(사후 탐지가 아니라 예방이라는 뜻이다).
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
  // 경쟁자가 그 사이 무엇을 하든 우리가 만드는 바이트는 0이다.
  const target = join(f.ws, "docs/out.md");
  const code = withSeams({ publish: () => writeFileSync(target, "경쟁자 내용") }, () => codeOf(() => applyWriteFile(op2, g2)));
  assert.equal(code, "write_publish_unsupported");
  assert.equal(readFileSync(target, "utf8"), "경쟁자 내용", "경쟁자 바이트를 건드렸다");
  assert.equal(lstatSync(join(f.ws, "docs/small.md"), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
  assert.ok(TYPED_EXECUTION_CODES.includes("write_publish_unsupported"));
});

test("[M5c] A3: 기존 대상 교체도 손대기 전에 거부되고 경쟁자 바이트는 그대로다", () => {
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  writeFileSync(target, "원래 내용");
  const [op, grant] = writePermit(f, { content: "우리 내용", expectedBeforeSha256: sha256("원래 내용") });
  const inoBefore = lstatSync(target).ino;
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "write_replace_unsupported");
  assert.equal(readFileSync(target, "utf8"), "원래 내용", "거부인데 바이트가 바뀌었다");
  assert.equal(lstatSync(target).ino, inoBefore);
  assert.deepEqual(readdirSync(join(f.ws, "docs")), ["out.md"]);
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
  assert.ok(TYPED_EXECUTION_CODES.includes("write_replace_unsupported"));
});

test("[M5c] 크래시 창 멱등: 이미 의도한 내용이면 already_applied이고 다시 쓰지 않는다", () => {
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  // 영수증이 durable해지기 **전에** 죽은 상황을 재현한다: 바이트는 이미 발행됐다.
  writeFileSync(target, "hello");
  const inoBefore = lstatSync(target).ino;

  const again = applyWriteFile(...writePermit(f, { content: "hello" }));
  assert.equal(again.marker, "already_applied");
  assert.equal(again.resultSha256, sha256("hello"));
  assert.equal(again.path, "docs/out.md");
  assert.equal(again.exitCode, null);
  assert.equal(Object.isFrozen(again), true, "outcome handle이 얼지 않았다");
  assert.equal(lstatSync(target).ino, inoBefore, "같은 바이트를 다시 써서 inode가 바뀌었다");
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
});

test("[M5c] preimage 불일치는 쓰지 않고 write_conflict다", () => {
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  writeFileSync(target, "남의 내용");
  const inoBefore = lstatSync(target).ino;
  const [[opA, gA], [opB, gB], [opC, gC]] = writeGrants(f, [
    { content: "새 내용", expectedBeforeSha256: null },
    { content: "새 내용", expectedBeforeSha256: sha256("다른 preimage") },
    { authorityId: "w-small", path: "docs/small.md", content: "x", expectedBeforeSha256: sha256("무엇") },
  ]);

  // ⓐ 없어야 한다고 했는데 있다.
  const conflict = applyWriteFile(opA, gA);
  assert.equal(conflict.marker, "write_conflict");
  assert.equal(conflict.resultSha256, null);
  assert.equal(readFileSync(target, "utf8"), "남의 내용", "충돌인데 바이트가 바뀌었다");
  assert.equal(lstatSync(target).ino, inoBefore);

  // ⓑ 기대한 preimage와 다르다.
  const mismatch = applyWriteFile(opB, gB);
  assert.equal(mismatch.marker, "write_conflict");
  assert.equal(readFileSync(target, "utf8"), "남의 내용");

  // ⓒ 있어야 한다고 했는데 없다.
  const absent = applyWriteFile(opC, gC);
  assert.equal(absent.marker, "write_conflict");
  assert.equal(lstatSync(join(f.ws, "docs/small.md"), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
});

test("[M5c] symlink·비일반 파일·바이트 초과·부모 부재는 집행하지 않는다", () => {
  const outside = mkdtempSync(join(tmpdir(), "m5c-outside-"));
  workspaces.push(outside);
  writeFileSync(join(outside, "target.md"), "밖의 파일");

  // ⓐ 대상이 symlink다(workspace 밖을 가리킨다).
  const f1 = fixture();
  symlinkSync(join(outside, "target.md"), join(f1.ws, "docs/out.md"));
  assert.equal(codeOf(() => applyWriteFile(...writePermit(f1))), "write_path_symlink");
  assert.equal(readFileSync(join(outside, "target.md"), "utf8"), "밖의 파일", "symlink를 따라가 밖을 덮어썼다");

  // ⓑ 부모 구성요소가 symlink다.
  const f2 = fixture();
  mkdirSync(join(f2.ws, "real"));
  symlinkSync(join(f2.ws, "real"), join(f2.ws, "src/linked"));
  assert.equal(
    codeOf(() => applyWriteFile(...writePermit(f2, { authorityId: "w-linked", path: "src/linked/a.md" }))),
    "write_path_symlink",
  );
  assert.deepEqual(readdirSync(join(f2.ws, "real")), []);

  // ⓒ 대상이 디렉터리다.
  const f3 = fixture();
  mkdirSync(join(f3.ws, "docs/out.md"));
  assert.equal(codeOf(() => applyWriteFile(...writePermit(f3))), "write_target_not_regular");

  // ⓓ 부모 디렉터리가 없다(디렉터리를 만들지 않는다).
  const f4 = fixture();
  assert.equal(
    codeOf(() => applyWriteFile(...writePermit(f4, { authorityId: "w-nested", path: "docs/nested/a.md" }))),
    "write_failed",
  );
  assert.equal(lstatSync(join(f4.ws, "docs/nested"), { throwIfNoEntry: false }), undefined);

  // ⓔ 승인된 바이트 상한(8)을 넘는 본문.
  const f5 = fixture();
  assert.equal(
    codeOf(() => applyWriteFile(...writePermit(f5, { authorityId: "w-small", path: "docs/small.md", content: "0123456789" }))),
    "write_bytes_exceeded",
  );
  assert.equal(lstatSync(join(f5.ws, "docs/small.md"), { throwIfNoEntry: false }), undefined);
  for (const dir of [join(f1.ws, "docs"), join(f2.ws, "src"), join(f3.ws, "docs"), join(f4.ws, "docs"), join(f5.ws, "docs")]) {
    assert.deepEqual(orphanTemps(dir), [], dir);
  }
});

test("[M5c] 영수증에는 내용이 들어가지 않고 실행 신원은 durable pending에서만 온다", () => {
  const f = fixture();
  const SENTINEL = "SENTINEL-SECRET-CONTENT-9f2a";
  writeFileSync(join(f.ws, "docs/out.md"), `${SENTINEL}\n`);
  const permit = permitFor(f.kernel, "root", [writeOp({ content: `${SENTINEL}\n` })]);
  const op = permit.plan.operations[0] as TypedWriteFileOperation;
  const grant = grantFor(f.kernel, permit, op.operationId);
  const outcome = applyWriteFile(op, grant);
  assert.equal(outcome.marker, "already_applied");
  assert.equal(JSON.stringify(outcome).includes(SENTINEL), false, "outcome handle에 파일 내용이 들어갔다");

  // **durable 영수증은 집행기 canonical 결과 + pending 신원**으로만 만들어진다(3A 3차 리비전 A2).
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  const receipt = receiptOf(f.kernel, "root", "op-1");
  assert.deepEqual(Object.keys(receipt).sort(), [...OPERATION_RECEIPT_KEYS].sort());
  assert.equal(JSON.stringify(receipt).includes(SENTINEL), false, "영수증에 파일 내용이 들어갔다");
  assert.equal(receipt.attemptId, f.kernel.getTask("root")!.execution.attemptId);
  assert.equal(receipt.turnId, "turn-1");
  assert.match(receipt.planDigest, /^[0-9a-f]{64}$/);
  assert.equal(receipt.marker, "already_applied");
  assert.equal(receipt.resultSha256, sha256(`${SENTINEL}\n`));

  // 거부 경로의 오류 메시지에도 내용·절대 경로가 없다.
  const g = fixture();
  try {
    applyWriteFile(...writePermit(g, { authorityId: "w-unknown", content: `${SENTINEL}\n` }));
    assert.fail("거부되지 않았다");
  } catch (e) {
    const message = String((e as Error).message);
    assert.equal(message.includes(SENTINEL), false, "오류 메시지에 파일 내용이 들어갔다");
    assert.equal(message.includes(g.ws), false, "오류 메시지에 절대 경로가 들어갔다");
  }
});

// ── 7. 발행 경쟁 예방과 durability (3A 리비전 A3 + 인접 B) ───────────────────

/** 발행 직전 seam 하나만 심고 그 안에서 경쟁자 역할을 한다. */
function withSeams<T>(seams: Partial<Record<PublicationSeam, () => void>>, fn: () => T): T {
  const restore = __setPublicationSeamsForTest(seams);
  try {
    return fn();
  } finally {
    restore();
  }
}

test("[M5d] C-1: 발행 seam은 production import 경로에서 등록할 수 없다", async () => {
  // ⓐ production facade에는 setter 런타임 export가 없다(타입만 남는다).
  const facade = (await import("./typedExecution.js")) as unknown as Record<string, unknown>;
  assert.equal("__setPublicationSeamsForTest" in facade, false, "facade가 seam setter를 다시 노출했다");

  // ⓑ kernel의 setter는 호출자 프레임이 `*.test.ts`가 아니면 등록하지 않고 던진다.
  //    `new Function` 본문 프레임은 `<anonymous>`라서 `dist/`의 production 프레임과 같은 위치에 선다.
  const fromNonTestFrame = new Function("set", "return set({});") as (set: unknown) => unknown;
  assert.throws(
    () => fromNonTestFrame(__setPublicationSeamsForTest),
    // 등록 거부는 **집행 오류 코드를 빌리지 않는다** — 쓰기 실패 진단과 섞이면 안 된다.
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === undefined,
    "테스트 파일 밖에서 seam 등록이 통과했거나 집행 taxonomy를 빌렸다",
  );

  // 거부가 기존 seam 상태를 건드리지 않았는지도 본다(실패 경로가 상태를 오염시키면 안 된다).
  const observed: string[] = [];
  withSeams({ parentWalk: () => observed.push("parentWalk") }, () => {
    assert.throws(() => fromNonTestFrame(__setPublicationSeamsForTest));
  });
  assert.deepEqual(observed, [], "거부 경로가 seam을 실행했다");
});

test("[M5c] A4: 부모 이름이 교체돼도 승인 범위 밖으로 나가지 않는다(판정 단계 재확인)", () => {
  const outside = mkdtempSync(join(tmpdir(), "m5c-outside-"));
  workspaces.push(outside);
  const f = fixture();
  const docs = join(f.ws, "docs");
  const [op, grant] = writePermit(f, { content: "우리 내용" });

  // 판정 재확인 **직전에** 부모 이름을 밖을 가리키는 symlink로 교체한다.
  const code = withSeams(
    {
      publish: () => {
        rmSync(join(f.ws, "docs-real"), { recursive: true, force: true });
        renameSync(docs, join(f.ws, "docs-real"));
        symlinkSync(outside, docs);
      },
    },
    () => codeOf(() => applyWriteFile(op, grant)),
  );
  assert.equal(code, "write_path_symlink");
  assert.deepEqual(readdirSync(outside), [], "workspace 밖에 파일이 생겼다");
  assert.equal(lstatSync(join(f.ws, "docs-real/out.md"), { throwIfNoEntry: false }), undefined, "대상이 발행됐다");
  // **고아 plaintext temp 문제가 사라졌다**(3A 3차 리비전 A4/B1): 만들 temp가 애초에 없으므로
  // "부모 이름이 바뀌어 우리 temp를 지울 수 없다"는 상황 자체가 성립하지 않는다.
  assert.deepEqual(orphanTemps(join(f.ws, "docs-real")), [], "집행기가 temp를 만들었다");
});

test("[M5c] 모든 실패 경계가 안정 코드로 접히고 fd·부작용을 남기지 않는다", () => {
  const seams: PublicationSeam[] = ["parentWalk", "targetOpen", "publish"];
  for (const name of seams) {
    const f = fixture();
    const [op, grant] = writePermit(f, { content: "우리 내용" });
    const code = withSeams(
      {
        [name]: () => {
          throw new Error(`주입 실패: ${name}`);
        },
      },
      () => codeOf(() => applyWriteFile(op, grant)),
    );
    assert.equal(code, "write_failed", name);
    assert.deepEqual(readdirSync(join(f.ws, "docs")), [], `${name}에서 부작용이 남았다`);
  }
  // **호출자 hook이 production taxonomy를 고를 수 없다**(3A 2차 리뷰 `C1`).
  const f = fixture();
  const [op, grant] = writePermit(f);
  const code = withSeams(
    {
      targetOpen: () => {
        throw new OrchestrationError("already_applied", "호출자가 고른 코드");
      },
    },
    () => codeOf(() => applyWriteFile(op, grant)),
  );
  assert.equal(code, "write_failed", "seam이 던진 코드가 그대로 새어 나왔다");
});

test("[M5c] A4: fsync 실패 뒤 재시도는 fsync를 다시 시도하고, 계속 실패하면 성공하지 않는다", () => {
  // 1차 판은 재시도가 **fsync 없이** `already_applied`를 돌려줬다 → controller가 durable하지 않은
  // 디렉터리 엔트리를 "성공"으로 기록할 수 있었다(크래시 시 산출물 소실).
  const f = fixture();
  writeFileSync(join(f.ws, "docs/out.md"), "우리 내용");
  const [[op1, g1], [op2, g2], [op3, g3]] = writeGrants(f, [
    { content: "우리 내용" },
    { content: "우리 내용", operationId: "op-2" },
    { content: "우리 내용", operationId: "op-3" },
  ]);
  const failFsync = { dirFsync: () => { throw new Error("fsync 실패"); } };
  assert.equal(withSeams(failFsync, () => codeOf(() => applyWriteFile(op1, g1))), "write_durability_unconfirmed");

  // **재시도는 fsync를 다시 지나야 한다**: 여전히 실패하면 성공이 아니다.
  let retryFsyncAttempts = 0;
  const stillFailing = { dirFsync: () => { retryFsyncAttempts++; throw new Error("fsync 여전히 실패"); } };
  assert.equal(withSeams(stillFailing, () => codeOf(() => applyWriteFile(op2, g2))), "write_durability_unconfirmed");
  assert.equal(retryFsyncAttempts, 1, "재시도가 fsync를 다시 시도하지 않았다");

  // fsync가 성공해야 비로소 `already_applied`다.
  const ok = applyWriteFile(op3, g3);
  assert.equal(ok.marker, "already_applied");
  assert.equal(ok.resultSha256, sha256("우리 내용"));
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), []);
});

/** 지금 열려 있는 fd 중 이 파일(dev,ino)을 가리키는 것을 밖에서 닫는다(진짜 EBADF를 만든다). */
function closeForeignFdsFor(path: string): number {
  const st = lstatSync(path);
  let closed = 0;
  for (let fd = 3; fd < 256; fd++) {
    try {
      const cur = fstatSync(fd);
      if (cur.dev === st.dev && cur.ino === st.ino) {
        closeSync(fd);
        closed++;
      }
    } catch { /* 우리 것이 아니거나 이미 닫혔다 */ }
  }
  return closed;
}

test("[M5c] B1: 정리(fd 반납) 실패는 성공이 되지 않고, 1차 오류에 가려지지도 않는다", () => {
  // ⓐ **판정은 성공인데 정리가 실패**한다 → 성공 영수증을 내지 않는다.
  {
    const f = fixture();
    const target = join(f.ws, "docs/out.md");
    writeFileSync(target, "우리 내용");
    const [op, grant] = writePermit(f, { content: "우리 내용" });
    let closed = 0;
    const code = withSeams(
      { dirFsync: () => { closed = closeForeignFdsFor(target); } },
      () => codeOf(() => applyWriteFile(op, grant)),
    );
    assert.equal(closed, 1, "집행기의 대상 fd를 찾지 못했다(테스트 전제가 깨졌다)");
    assert.equal(code, "write_cleanup_unconfirmed", "정리 실패가 성공으로 삼켜졌다");
    assert.equal(readFileSync(target, "utf8"), "우리 내용", "판정이 바이트를 건드렸다");
    assert.ok(TYPED_EXECUTION_CODES.includes("write_cleanup_unconfirmed"));
  }
  // ⓑ **1차 오류 + 정리 실패가 동시에** 나면 정리 미확인이 이기고 1차 코드를 메시지에 싣는다
  //    (3A 3차 리비전 B1 — 이전 판은 1차 예외가 정리 실패를 완전히 가렸다).
  {
    const f = fixture();
    const target = join(f.ws, "docs/out.md");
    writeFileSync(target, "우리 내용");
    const [op, grant] = writePermit(f, { content: "우리 내용" });
    let message = "";
    const code = withSeams(
      {
        dirFsync: () => {
          closeForeignFdsFor(target);
          throw new Error("fsync 실패");
        },
      },
      () => {
        try {
          applyWriteFile(op, grant);
          return "no-error";
        } catch (e) {
          message = String((e as Error).message);
          return (e as OrchestrationError).code;
        }
      },
    );
    assert.equal(code, "write_cleanup_unconfirmed", "1차 오류가 정리 미확인을 가렸다");
    assert.match(message, /write_durability_unconfirmed/, "1차 안정 코드를 잃어버렸다");
    assert.equal(message.includes(f.ws), false, "메시지에 절대 경로가 들어갔다");
  }
});

// ── 7b. 영수증 provenance와 재시작 정합화 (3A 2차 리비전 A2) ─────────────────

test("[M5c] A2: 위조·재생·치환·재사용 영수증과 '효과 없는 성공'이 전부 fail closed다", () => {
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  writeFileSync(target, "우리 내용");
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  const outcome = applyWriteFile(op, grant);
  assert.equal(outcome.marker, "already_applied");

  // ⓐ **구조적 위조**: 집행기가 낸 handle이 아니면 영수증이 되지 않는다(3A 3차 리비전 A2 — 이전 판은
  //    호출자가 만든 영수증 객체를 그대로 받았다). 전개 사본·freeze·proxy도 등록부 조회에서 걸린다.
  for (const forged of [null, undefined, {}, { ...outcome }, Object.freeze({ ...outcome }), new Proxy(outcome, {}), grant]) {
    assert.equal(
      codeOf(() => f.kernel.recordOperationReceipt({ outcome: forged, actionId: nextId("act") })),
      "invalid_receipt",
    );
  }
  // ⓑ **결과 치환**: handle의 필드를 바꿔 넣을 통로가 없다 — 값은 얼어 있고 사본은 등록부 밖이다.
  assert.throws(() => {
    (outcome as unknown as { marker: string }).marker = "applied";
  }, TypeError);
  assert.equal(outcome.marker, "already_applied");

  // ⓒ 진짜 handle은 정확히 한 번 커밋되고, durable 값은 **집행기 canonical 결과 + pending 신원**이다.
  const task = f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  assert.equal(task.execution.operationReceipts.length, 1);
  assert.equal(task.execution.operationReceipts[0].marker, "already_applied");
  assert.equal(task.execution.operationReceipts[0].resultSha256, sha256("우리 내용"));
  assert.equal(task.execution.pendingOperations.length, 0, "영수증이 pending을 닫지 않았다");
  // 커밋 시각은 **kernel clock**이다(호출자 시각을 durable로 쓰는 필드가 애초에 없다).
  assert.match(task.execution.operationReceipts[0].at, /^2026-/);

  // ⓓ **재사용**: 같은 handle로 두 번 커밋할 수 없다.
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") })), "dispatch_grant_spent");
  // ⓔ **중복 집행**: 소진된 grant로는 효과도 실패 종결도 낼 수 없다.
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "dispatch_grant_spent");
  assert.equal(codeOf(() => f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" })), "dispatch_grant_spent");
  assert.equal(readFileSync(target, "utf8"), "우리 내용");
});

test("[M5c] A2: 같은 pending 신원에는 살아 있는 grant가 하나뿐이다(live/live 중복 집행 차단)", () => {
  // **이전 판의 진짜 결함**: 같은 pending operation을 다시 열면 **독립적으로 살아 있는** grant가 또 나왔고
  // 둘 다 소진할 수 있었다(비멱등 프로세스 효과라면 두 번 실행). 이전 테스트는 첫 영수증을 커밋한
  // **뒤에** 두 번째 grant를 썼기 때문에 그 live/live 경쟁을 재현하지 못했다 — 그래서 교체했다.
  const f = fixture();
  writeFileSync(join(f.ws, "docs/out.md"), "우리 내용");
  const permit = permitFor(f.kernel, "root", [writeOp({ content: "우리 내용" })]);
  const op = permit.plan.operations[0] as TypedWriteFileOperation;
  const g1 = grantFor(f.kernel, permit, op.operationId);
  const g2 = grantFor(f.kernel, permit, op.operationId); // 재시작 정합화가 같은 operation을 다시 연다
  assert.notEqual(g1, g2);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 1, "pending이 중복 등록됐다");

  // **영수증 커밋 전에** 둘 다 쓰려고 해 본다 — g1은 발급 시점에 폐기됐고 g2만 살아 있다.
  assert.equal(codeOf(() => applyWriteFile(op, g1)), "dispatch_grant_spent", "폐기된 grant가 아직 집행된다");
  assert.equal(codeOf(() => f.kernel.failOperation({ grant: g1, actionId: nextId("act"), marker: "failed" })), "dispatch_grant_spent");
  const outcome = applyWriteFile(op, g2);
  assert.equal(outcome.marker, "already_applied");
  f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  assert.deepEqual(f.kernel.getTask("root")!.execution.operationReceipts.map((r) => r.operationId), ["op-1"]);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 0);
  // 영수증 뒤에는 어떤 경로로도 다시 열리지 않는다.
  assert.equal(
    codeOf(() => f.kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") })),
    "operation_already_recorded",
  );
});

test("[M5c] A2: 집행 게이트를 지나지 않은 grant는 성공 marker를 만들어낼 수 없다", () => {
  const f = fixture();
  const [, grant] = writePermit(f, { content: "우리 내용" });
  // 효과를 **한 번도 시도하지 않은** grant에는 outcome handle이 아예 없다 → 성공을 주장할 통로가 없다.
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ outcome: grant, actionId: nextId("act") })), "invalid_receipt");
  assert.equal(lstatSync(join(f.ws, "docs/out.md"), { throwIfNoEntry: false }), undefined, "거부 경로가 파일을 만들었다");
  // 실패 종결로도 성공 marker를 만들 수 없다(닫힌 enum).
  assert.equal(
    codeOf(() => f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "already_applied" as never })),
    "invalid_enum",
  );
  const task = f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "denied" });
  assert.equal(task.execution.pendingOperations.length, 0);
  assert.equal(task.execution.operationReceipts[0].marker, "denied");
  assert.equal(task.execution.operationReceipts[0].turnId, "turn-1");
  assert.equal(task.execution.operationReceipts[0].resultSha256, null);
});

test("[M5c] A2: 집행이 던진 grant는 성공으로도 '평범한 실패'로도 닫히지 않는다(불확실은 불확실로 남는다)", () => {
  // **이전 판의 진짜 결함**(독립 리뷰 A-2): 집행 콜백이 **부분 외부 효과를 낸 뒤** 던져도
  // `failOperation(failed)`이 그 pending을 평범한 실패로 **지워 버렸다** → durable 기록이 "아무 일도
  // 없었다"고 거짓말한다. 이전 assertion이 정확히 그 동작을 정상으로 고정하고 있었으므로 **교체**했다
  // (완화가 아니라 강화 — WORKLOG에 전수 기록).
  const f = fixture();
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  // 집행이 예외로 끝났다(발행 fail-closed) → outcome handle이 만들어지지 않았다.
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "write_publish_unsupported");
  // 그러나 **집행 경계 진입은 이미 durable하다**(효과보다 먼저 적는다).
  const pending = f.kernel.getTask("root")!.execution.pendingOperations;
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0].attemptedAt, null, "집행 경계 진입이 durable하지 않다");
  // 같은 grant로 다시 들어갈 수 없다.
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "dispatch_grant_spent");
  // **평범한 실패 종결은 거부된다** — 외부 효과가 일어나지 않았다고 단정할 수 없기 때문이다.
  for (const marker of ["failed", "denied"] as const) {
    assert.equal(codeOf(() => f.kernel.failOperation({ grant, actionId: nextId("act"), marker })), "operation_attempt_uncertain");
  }
  // **재발급도 없다**: `effect(g1) → 재발급 → effect(g2)`로 두 번째 효과를 낼 수 없다.
  const permit2 = f.kernel.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-1",
    actionId: nextId("act"),
    plan: planFor(f.kernel, "root", [writeOp({ content: "우리 내용" })]),
  });
  assert.equal(
    codeOf(() => f.kernel.beginOperation({ permit: permit2, operationId: "op-1", actionId: nextId("act") })),
    "operation_attempt_uncertain",
  );
  // 남은 정합화 경로는 **정직한 불확실 종결** 하나뿐이다.
  const p = pending[0];
  const task = f.kernel.reconcileUncertainOperation({
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
  assert.equal(task.execution.operationReceipts[0].marker, "outcome_unknown");
  assert.equal(task.execution.operationReceipts[0].path, null, "정합화가 경로를 주장했다");
  assert.equal(task.execution.operationReceipts[0].resultSha256, null, "정합화가 결과 hash를 주장했다");
  assert.equal(task.execution.pendingOperations.length, 0);
});

test("[M5c] A2: effect(g1) → 재발급 → effect(g2)로 두 번째 효과를 낼 수 없다(성공 경로에서도)", () => {
  // 위 테스트는 **던진** 집행 뒤를 본다. 여기서는 **정상 반환**한 집행 뒤에도 같은 pending이 다시
  // 열리지 않는다는 것을 본다(리뷰가 지목한 정확한 순서: `effect(g1) → reissue → effect(g2)`).
  const f = fixture();
  writeFileSync(join(f.ws, "docs/out.md"), "우리 내용");
  const permit = permitFor(f.kernel, "root", [writeOp({ content: "우리 내용" })]);
  const op = permit.plan.operations[0] as TypedWriteFileOperation;
  const g1 = grantFor(f.kernel, permit, op.operationId);
  const outcome = applyWriteFile(op, g1);
  assert.equal(outcome.marker, "already_applied");
  // **여기서 재발급을 시도한다** — 영수증 커밋 전이므로 이전 판에서는 새 grant가 나왔다.
  assert.equal(
    codeOf(() => f.kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") })),
    "operation_attempt_uncertain",
  );
  // 살아 있는 진짜 결과 handle은 그대로 정확히 한 번 커밋된다(정상 경로는 막히지 않는다).
  const task = f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  assert.deepEqual(task.execution.operationReceipts.map((r) => r.marker), ["already_applied"]);
  assert.equal(task.execution.pendingOperations.length, 0);
});

test("[M5c] A2/A3: 효과가 났는데 결과 전이가 없으면 attempt를 떠날 수 없다", () => {
  const f = fixture();
  writeFileSync(join(f.ws, "docs/out.md"), "우리 내용");
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  assert.equal(applyWriteFile(op, grant).marker, "already_applied");
  const pending = f.kernel.getTask("root")!.execution.pendingOperations;
  assert.equal(pending.length, 1, "집행 전 durable 등록이 없다");
  assert.deepEqual(
    { operationId: pending[0].operationId, kind: pending[0].kind, turnId: pending[0].turnId, attemptId: pending[0].attemptId },
    { operationId: "op-1", kind: "write_file", turnId: "turn-1", attemptId: f.kernel.getTask("root")!.execution.attemptId },
  );
  // 다음 turn을 열 수 없다(끝나지 않은 claim이 살아 있다).
  assert.equal(
    codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-next" })], "turn-2")),
    "dispatch_identity_stale",
  );
  // ── A3: attempt를 **떠나거나 리셋하는** 전이가 전부 막힌다(그 전이들이 pending을 지운다) ──
  const lease = f.kernel.getTask("root")!.execution.processLeaseMarker!;
  f.kernel.recordTerminal({
    taskId: "root",
    actionId: nextId("act"),
    marker: "turn_completed",
    pendingResult: { summary: "요약", outputs: [{ path: "docs/out.md", role: "output" }] },
  });
  f.kernel.confirmCleanup({ taskId: "root", actionId: nextId("act"), leaseMarker: lease });
  assert.equal(codeOf(() => f.kernel.settleCleanedAttempt({ taskId: "root", actionId: nextId("act") })), "operation_pending_unreconciled");
  assert.equal(
    codeOf(() => f.kernel.pauseTask({ taskId: "root", actionId: nextId("act"), pauseReason: "operator_requested" })),
    "operation_pending_unreconciled",
  );
  assert.equal(
    codeOf(() =>
      f.kernel.completeTaskWithArtifacts({
        envelope: {
          schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION,
          messageId: "msg-done",
          runId: RUN_ID,
          milestoneId: MILESTONE,
          taskId: "root",
          parentTaskId: null,
          sender: "tech-lead",
          recipient: ORCHESTRATOR_ID,
          type: "result",
          createdAt: "2026-07-30T00:00:00.000Z",
          dependsOn: [],
          artifactRefs: [],
          supersedes: null,
        },
        body: body("result"),
        summary: "요약",
        outputs: [{ path: "docs/out.md", role: "output" }],
      }),
    ),
    "operation_pending_unreconciled",
  );
  assert.equal(f.kernel.getTask("root")!.state, "cleaning");
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 1, "막힌 전이가 pending을 지웠다");
});

test("[M5c] A3: 영수증 정합화는 만료·deadline·cleaning 뒤에도 가능하다(safety-only)", () => {
  // **이전 판의 결함**: 영수증 커밋이 전진 게이트(`requireDispatchableTask`)를 지났으므로 만료·예산·
  // wall·no-progress를 넘기거나 `cleaning`으로 내려간 뒤에는 **정합화 자체가 불가능**했다 →
  // 그 pending은 어떤 전이로도 닫히지 않는 미아가 되고 다음 preflight·resume이 조용히 지웠다.
  const expiresAt = "2026-07-30T00:10:00.000Z";
  const t = steppableClock(T0);
  const f = fixture({ manifestOver: { expiresAt, autopilotPolicy: { ...POLICY, maxNoProgressMs: 900_000 } }, clock: t.clock });
  writeFileSync(join(f.ws, "docs/out.md"), "우리 내용");
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  const outcome = applyWriteFile(op, grant);
  assert.equal(outcome.marker, "already_applied");

  // ⓐ `cleaning`으로 내려간다(취소는 safety-only라 만료 뒤에도 지난다).
  const lease = f.kernel.getTask("root")!.execution.processLeaseMarker!;
  f.kernel.requestCancel({ taskId: "root", actionId: nextId("act") });
  assert.equal(f.kernel.getTask("root")!.state, "cleaning");
  // ⓑ 만료 이후로 시계를 옮긴다 — 전진 작업은 전부 닫힌다.
  t.set(Date.parse(expiresAt) + 60_000);
  assert.equal(codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-x" })], "turn-2")), "manifest_expired");
  // ⓒ **그래도 영수증은 커밋된다**(그것이 A3의 요구다).
  const task = f.kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  assert.equal(task.execution.pendingOperations.length, 0, "만료·cleaning에서 정합화가 막혔다");
  assert.equal(task.execution.operationReceipts[0].marker, "already_applied");
  assert.equal(task.execution.operationReceipts[0].turnId, "turn-1");
  // ⓓ 정합화가 끝났으므로 이제 attempt를 떠날 수 있다.
  f.kernel.confirmCleanup({ taskId: "root", actionId: nextId("act"), leaseMarker: lease });
  f.kernel.settleCleanedAttempt({ taskId: "root", actionId: nextId("act") });
  assert.equal(f.kernel.getTask("root")!.state, "cancelled");
  // ⓔ 재시작해도 durable 사실은 같다(fail-closed load 검증을 지난다).
  const reopened = OrchestrationKernel.open({ workspaceRoot: f.ws, runId: RUN_ID, clock: t.clock });
  assert.deepEqual(reopened.getTask("root")!.execution.operationReceipts.map((r) => r.marker), ["already_applied"]);
});

// ── 7c. 재시작 안전한 정합화 (3A 4차 리비전 A3) ──────────────────────────────

/**
 * **진짜 재시작 fixture**: durable pending을 남긴 뒤 **옛 WeakMap handle이 하나도 없는** 새 kernel을 연다.
 * `permit`/`grant`/`outcome`은 전부 프로세스 메모리이므로, 여기서부터는 durable 신원만으로 닫아야 한다.
 */
function restartWithAttemptedPending(opts: { expiresAt?: string; toCleaning: boolean }): {
  ws: string;
  fresh: OrchestrationKernel;
  clock: () => Date;
  set: (ms: number) => void;
  lease: string;
} {
  const t = steppableClock(T0);
  const f = fixture({
    manifestOver: {
      ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }),
      autopilotPolicy: { ...POLICY, maxNoProgressMs: 900_000 },
    },
    clock: t.clock,
  });
  const lease = f.kernel.getTask("root")!.execution.processLeaseMarker!;
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  // 집행 경계에 들어갔고 결과를 잃었다(발행은 A4로 fail closed이므로 던진다).
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "write_publish_unsupported");
  assert.notEqual(f.kernel.getTask("root")!.execution.pendingOperations[0].attemptedAt, null);
  if (opts.toCleaning) {
    f.kernel.recordTerminal({ taskId: "root", actionId: nextId("act"), marker: "worker_failed" });
    assert.equal(f.kernel.getTask("root")!.state, "cleaning");
  }
  // **새 kernel** — 옛 permit/grant/outcome handle과 연결이 전혀 없다.
  const fresh = OrchestrationKernel.open({ workspaceRoot: f.ws, runId: RUN_ID, clock: t.clock });
  return { ws: f.ws, fresh, clock: t.clock, set: t.set, lease };
}

test("[M5c] A3: 재시작 뒤 cleaning pending을 durable 신원만으로 정합화하고 settle까지 간다", () => {
  // **이전 판의 진짜 결함**(독립 리뷰 A-3): permit·grant·outcome이 전부 프로세스 메모리 WeakMap이었다 →
  // 재시작하면 `cleaning` pending은 새 permit을 받을 수 없고(발급은 running을 요구한다) 옛 handle도 없어
  // `recordOperationReceipt`·`failOperation` 어느 쪽도 부를 수 없었다 → **영구 미아**가 되고 attempt를
  // 떠나는 모든 전이가 무한히 막혔다.
  const r = restartWithAttemptedPending({ toCleaning: true });
  const p = r.fresh.getTask("root")!.execution.pendingOperations[0];
  assert.equal(r.fresh.getTask("root")!.state, "cleaning");
  const ident = {
    runId: RUN_ID,
    taskId: "root",
    attemptId: p.attemptId,
    turnId: p.turnId,
    planDigest: p.planDigest,
    operationId: p.operationId,
    kind: p.kind,
    authorityId: p.authorityId,
  };
  // ⓐ cleaning task는 새 permit을 받지 못한다(이 경로가 없으면 미아가 된다).
  assert.equal(
    codeOf(() =>
      r.fresh.issueOperationDispatchPermit({
        taskId: "root",
        turnId: "turn-1",
        actionId: nextId("act"),
        plan: planFor(r.fresh, "root", [writeOp({ content: "우리 내용" })]),
      }),
    ),
    "dispatch_task_not_running",
  );
  // ⓑ **어긋난 신원은 전부 거부**된다(위조·낡음·치환).
  const wrong: Array<[string, Record<string, string>]> = [
    ["runId", { runId: "other-run" }],
    ["taskId", { taskId: "sibling" }],
    ["attemptId", { attemptId: "att-forged" }],
    ["turnId", { turnId: "turn-forged" }],
    ["planDigest", { planDigest: "c".repeat(64) }],
    ["operationId", { operationId: "op-forged" }],
    ["kind", { kind: "run_process" }],
    ["authorityId", { authorityId: "w-small" }],
  ];
  for (const [label, over] of wrong) {
    const code = codeOf(() => r.fresh.reconcileUncertainOperation({ ...ident, ...over, actionId: nextId("act") }));
    assert.notEqual(code, "no-error", `${label} 불일치가 통과했다`);
    assert.equal(r.fresh.getTask("root")!.execution.pendingOperations.length, 1, `${label}: 거부가 pending을 지웠다`);
    assert.equal(r.fresh.getTask("root")!.execution.operationReceipts.length, 0, `${label}: 거부가 영수증을 남겼다`);
  }
  // ⓒ **성공을 만들 입력이 없다**: marker/path/hash/exitCode를 넣을 필드 자체가 시그니처에 없고,
  //    durable 진실이 "시도됐다"이므로 결과는 `outcome_unknown`으로 파생된다.
  const task = r.fresh.reconcileUncertainOperation({ ...ident, actionId: nextId("act") });
  const receipt = task.execution.operationReceipts[0];
  assert.equal(receipt.marker, "outcome_unknown");
  assert.deepEqual([receipt.path, receipt.resultSha256, receipt.exitCode], [null, null, null]);
  assert.deepEqual([receipt.attemptId, receipt.turnId, receipt.planDigest], [p.attemptId, p.turnId, p.planDigest]);
  assert.equal(task.execution.pendingOperations.length, 0);
  // ⓓ 두 번 닫히지 않는다.
  assert.equal(
    codeOf(() => r.fresh.reconcileUncertainOperation({ ...ident, actionId: nextId("act") })),
    "dispatch_operation_unregistered",
  );
  // ⓔ 정합화가 끝났으므로 cleanup·settle이 정상 진행된다(미아 stall 해소).
  r.fresh.confirmCleanup({ taskId: "root", actionId: nextId("act"), leaseMarker: r.lease });
  r.fresh.settleCleanedAttempt({ taskId: "root", actionId: nextId("act") });
  assert.equal(r.fresh.getTask("root")!.state, "retry_wait");
  // ⓕ 또 재시작해도 durable 사실은 같다(거짓 성공 0).
  const again = OrchestrationKernel.open({ workspaceRoot: r.ws, runId: RUN_ID, clock: r.clock });
  assert.deepEqual(again.getTask("root")!.execution.operationReceipts.map((x) => x.marker), ["outcome_unknown"]);
  assert.deepEqual(orphanTemps(join(r.ws, "docs")), []);
});

test("[M5c] A3: 만료·deadline을 넘긴 running pending도 재시작 뒤 정합화된다(safety-only)", () => {
  const expiresAt = "2026-07-30T00:10:00.000Z";
  const r = restartWithAttemptedPending({ expiresAt, toCleaning: false });
  // 만료 이후로 시계를 옮긴다 → 전진 작업은 전부 닫히고 새 permit도 나오지 않는다.
  r.set(Date.parse(expiresAt) + 60_000);
  assert.equal(r.fresh.getTask("root")!.state, "running");
  assert.equal(
    codeOf(() =>
      r.fresh.issueOperationDispatchPermit({
        taskId: "root",
        turnId: "turn-9",
        actionId: nextId("act"),
        plan: planFor(r.fresh, "root", [], "turn-9"),
      }),
    ),
    "manifest_expired",
  );
  const p = r.fresh.getTask("root")!.execution.pendingOperations[0];
  const task = r.fresh.reconcileUncertainOperation({
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
  assert.equal(task.execution.operationReceipts[0].marker, "outcome_unknown");
  assert.equal(task.execution.pendingOperations.length, 0);
  // 만료 뒤에도 성공·발행·산출물은 하나도 생기지 않았다.
  assert.equal(task.execution.operationReceipts[0].resultSha256, null);
  assert.equal(r.fresh.getState().artifacts.length, 0);
  assert.deepEqual(readdirSync(join(r.ws, "docs")), []);
});

test("[M5c] A3: 집행 경계에 들어가지 않은 pending은 재시작 뒤 failed로 닫힌다(성공은 여전히 불가능)", () => {
  const ws = makeWorkspace();
  const clock = clockFrom(T0);
  const k0 = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestObject(),
    clock,
  });
  k0.createRootTask(seed("root", ["docs", "src"]));
  startNow(k0, "root");
  const permit = permitFor(k0, "root", [writeOp()]);
  k0.beginOperation({ permit, operationId: "op-1", actionId: nextId("act") });
  const fresh = OrchestrationKernel.open({ workspaceRoot: ws, runId: RUN_ID, clock });
  const p = fresh.getTask("root")!.execution.pendingOperations[0];
  assert.equal(p.attemptedAt, null);
  const task = fresh.reconcileUncertainOperation({
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
  // 시도조차 되지 않았으므로 `failed`가 정직하다 — 그래도 **성공은 어떤 입력으로도 만들 수 없다**.
  assert.equal(task.execution.operationReceipts[0].marker, "failed");
  assert.deepEqual(readdirSync(join(ws, "docs")), []);
});

test("[M5c] A2: 임의 콜백으로 성공을 만드는 공개 표면이 존재하지 않는다", async () => {
  // **이전 판의 진짜 결함**(독립 리뷰 A-2): `executeUnderGrant(grant, op, 임의콜백)`이 export돼 있었고
  // 콜백의 반환값을 canonical 성공으로 굳혔다 → **아무 효과도 내지 않는 콜백**이 진짜 `applied` 영수증을
  // 만들 수 있었다. 지금은 그 export 자체가 없고, grant를 소비하는 진입점은 kind별로 고정돼 있다.
  const kernelModule = (await import("./orchestrationKernel.js")) as unknown as Record<string, unknown>;
  const typedModule = (await import("./typedExecution.js")) as unknown as Record<string, unknown>;
  for (const mod of [kernelModule, typedModule]) {
    assert.equal("executeUnderGrant" in mod, false, "임의 콜백 집행 표면이 다시 export됐다");
    // 임의 함수를 3번째 인자로 받는 export가 하나도 없어야 한다(이름을 바꾼 재도입 차단).
    // class는 제외한다(생성자는 grant를 소비하지 않는다 — ES class는 `prototype`이 non-writable이다).
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      if (Object.getOwnPropertyDescriptor(value, "prototype")?.writable === false) continue;
      // **M5c task 3C(대장 `B-F1` 개봉)**: `executeRunProcessOperation(grant, op, capability, options?)`만
      // 인자가 2개를 넘는다. 그 3번째는 **콜백이 아니라 kernel 발급 권능**이며, 아래에서 "함수를 넣으면
      // 거부된다"를 **실제로 실행해** 단정한다(arity 규칙보다 강한 확인이다). 그 밖의 export는 그대로다.
      if (name === "executeRunProcessOperation") continue;
      assert.ok(value.length <= 2, `${name}은 인자 ${value.length}개를 받는다 — 콜백 표면이 아닌지 확인해야 한다`);
    }
  }
  assert.equal(typeof kernelModule.executeWriteFileOperation, "function");
  assert.equal((kernelModule.executeWriteFileOperation as (...a: unknown[]) => unknown).length, 2);

  // `run_process` 집행기는 **task 3C에서 열렸다**(그전까지 spawn 0). 열렸어도 콜백 표면은 아니다:
  // 권능 자리에 임의 함수를 넣으면 **spawn도 영수증도 없이** 거부된다.
  assert.equal(typeof kernelModule.executeRunProcessOperation, "function");
  assert.equal(typeof typedModule.executeRunProcessOperation, "function");
  const f = fixture();
  const [pop, pgrant] = processPermit(f);
  for (const callback of [() => ({ marker: "applied", path: null, resultSha256: null, exitCode: 0 }), () => undefined]) {
    await assert.rejects(
      (kernelModule.executeRunProcessOperation as (...a: unknown[]) => Promise<unknown>)(pgrant, pop, callback),
      (e: unknown) => (e as OrchestrationError).code === "process_capability_invalid",
    );
  }
  assert.equal(f.kernel.getTask("root")!.execution.operationReceipts.length, 0);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations[0].attemptedAt, null);
});

// ── 7d. 직접 import 우회 · 발급 인스턴스 격리 (3A 5차 리비전 A3/A2) ────────────

/**
 * **위조한 구조적 `DispatchAuthority`**. 4차 판의 `writeFileEffect.judgeWriteFile(auth, op)`가 정확히 이
 * 모양을 받았으므로, 그 모듈을 직접 import하면 진짜 permit·과금·durable 상태 확인 **없이** 파일을 열어
 * hash하고 디렉터리를 fsync하고 성공 marker까지 받을 수 있었다(독립 리뷰 A-3).
 */
function forgedAuthority(ws: string): Record<string, unknown> {
  return {
    workspaceRoot: ws,
    manifest: validateApprovalManifest(manifestObject()),
    runId: RUN_ID,
    taskId: "root",
    attemptId: "att-forged",
    turnId: "turn-forged",
    ownership: ["docs", "src"],
    nowIso: "2026-07-30T00:00:00.000Z",
  };
}

test("[M5c] A3: 위조 authority로 파일 시스템 효과에 도달하는 import 표면이 없다(집행기 모듈 자체가 없다)", async () => {
  // **4차 판의 진짜 결함**: 집행기가 별도 파일에서 export돼 있었고 `DispatchAuthority`는 평범한 구조적
  // interface였다. 패키지는 `dist` 전체를 exports map 없이 배포하므로 "내부 파일"·이름·주석·barrel 누락·
  // TypeScript 가시성은 경계가 아니었다. 그래서 **파일을 없앴다**(이름 변경·`@internal`이 아니다).
  // 정적 specifier로 쓰면 **타입 검사가 먼저** 실패하므로(모듈이 없다) 런타임 판정을 하지 못한다 →
  // 여기서 보는 것은 "그 경로가 런타임에도 해석되지 않는다"이므로 specifier를 `string`으로 넓힌다.
  const helperPath: string = "./writeFileEffect.js";
  await assert.rejects(
    () => import(helperPath),
    (e: NodeJS.ErrnoException) => e.code === "ERR_MODULE_NOT_FOUND",
    "집행기 helper 모듈이 다시 import 가능해졌다",
  );

  // 남은 두 모듈의 **모든 함수 export**를 위조 authority로 두 인자 순서 모두 호출해도
  // ⓐ 성공 marker가 나오지 않고 ⓑ 파일 시스템이 바뀌지 않는다.
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  // 우회가 성공했다면 **`already_applied` + 디렉터리 fsync**가 나올 조건을 만들어 둔다(공허하지 않은 관문).
  writeFileSync(target, "hello");
  const before = { ino: lstatSync(target).ino, bytes: readFileSync(target, "utf8"), dir: readdirSync(join(f.ws, "docs")) };
  const forged = forgedAuthority(f.ws);
  const op = { ...writeOp(), content: "hello" } as unknown as TypedWriteFileOperation;
  const kernelModule = (await import("./orchestrationKernel.js")) as unknown as Record<string, unknown>;
  const typedModule = (await import("./typedExecution.js")) as unknown as Record<string, unknown>;
  const successMarkers = ["applied", "already_applied", "write_conflict"];
  // seam setter도 sweep 대상이므로 호출 뒤 반드시 원복한다(테스트 사이에 상태가 새지 않는다).
  const restoreSeams = __setPublicationSeamsForTest({});
  try {
    for (const [modName, mod] of [["kernel", kernelModule], ["facade", typedModule]] as const) {
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        if (Object.getOwnPropertyDescriptor(value, "prototype")?.writable === false) continue; // class 제외
        for (const args of [[forged, op], [op, forged]]) {
          let out: unknown;
          try {
            out = (value as (...a: unknown[]) => unknown)(...args);
            // **비동기 집행기도 같은 관문을 지난다**(M5c task 3C — `executeRunProcessOperation`이 열렸다).
            // 거부를 promise로 미루는 것으로 이 sweep을 빠져나갈 수 없다.
            if (typeof (out as { then?: unknown })?.then === "function") out = await out;
          } catch {
            continue; // fail closed = 정답
          }
          const marker = typeof out === "object" && out !== null ? (out as Record<string, unknown>).marker : undefined;
          assert.equal(
            typeof marker === "string" && successMarkers.includes(marker),
            false,
            `${modName}.${name}이 위조 authority로 집행 결과를 냈다`,
          );
        }
      }
    }
  } finally {
    restoreSeams();
  }
  assert.equal(lstatSync(target).ino, before.ino, "위조 authority가 대상 파일을 바꿨다");
  assert.equal(readFileSync(target, "utf8"), before.bytes);
  assert.deepEqual(readdirSync(join(f.ws, "docs")), before.dir, "위조 authority가 디렉터리를 바꿨다");
  // 진짜 경로는 그대로 열려 있다(대조군): 같은 내용이므로 `already_applied`가 나온다.
  const [realOp, grant] = writePermit(f, { content: "hello" });
  assert.equal(applyWriteFile(realOp, grant).marker, "already_applied");
});

/**
 * **durable ID가 바이트 단위로 같은 두 번째 workspace**(3A 5차 리비전 A2). run/task/attempt/turn/plan/
 * operation id를 전부 고정하므로, 발급 인스턴스에 묶이지 않은 handle이라면 서로 통해 버린다.
 */
function twinRun(): { ws: string; kernel: OrchestrationKernel; progress: WorkerProgressChannel; clock: () => Date } {
  const ws = makeWorkspace();
  const clock = clockFrom(T0);
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestObject(),
    clock,
  });
  kernel.createRootTask(seed("root", ["docs", "src"]));
  const batch = kernel.planRunnableBatch();
  kernel.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: "act-twin-preflight",
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: "att-twin" })),
  });
  const started = kernel.startPreparedTask({
    taskId: "root",
    actionId: "act-twin-start",
    leaseMarker: `lease.${"a".repeat(32)}`,
  });
  return { ws, kernel, progress: started.progress, clock };
}

/** 고정 turn/plan으로 claim → 권위 과금 → pending 등록까지 지난 twin 하나. */
function twinPermit(t: { kernel: OrchestrationKernel }): {
  permit: OperationDispatchPermit;
  op: TypedWriteFileOperation;
  grant: OperationExecutionGrant;
} {
  const permit = t.kernel.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-twin",
    actionId: "act-twin-claim",
    plan: planFor(t.kernel, "root", [writeOp({ content: "쌍둥이 내용" })], "turn-twin"),
  });
  t.kernel.chargeDispatchTurnUsage({ permit, actionId: "act-twin-charge", inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  const grant = t.kernel.beginOperation({ permit, operationId: "op-1", actionId: "act-twin-begin" });
  return { permit, op: permit.plan.operations[0] as TypedWriteFileOperation, grant };
}

test("[M5c] A2: 진짜 handle은 발급 kernel 인스턴스에만 통한다(같은 durable ID의 두 workspace 교차 공격)", () => {
  // **4차 판의 진짜 결함**(독립 리뷰 A-2): permit/grant/outcome/채널 등록부가 모듈 전역이고 수신 메서드는
  // "이 모듈이 발급했는가"만 봤다 → durable ID가 같은 두 workspace가 서로 과금·pending 등록·attempted
  // 표시·영수증 커밋을 하고 live grant key까지 서로 죽일 수 있었다. 평범한 durable 문자열 ID는 발급자
  // 신원이 아니다.
  const A = twinRun();
  const B = twinRun();
  const a = twinPermit(A);
  const b = twinPermit(B);
  // 전제: 두 run의 durable 신원이 **바이트 단위로 같다**(공격이 성립할 조건 자체를 단정한다).
  assert.deepEqual(
    [a.permit.runId, a.permit.taskId, a.permit.attemptId, a.permit.turnId, a.op.operationId],
    [b.permit.runId, b.permit.taskId, b.permit.attemptId, b.permit.turnId, b.op.operationId],
  );
  assert.equal(
    A.kernel.getTask("root")!.execution.dispatchPlanDigest,
    B.kernel.getTask("root")!.execution.dispatchPlanDigest,
    "두 workspace의 계획 digest가 다르면 이 테스트는 공격을 재현하지 못한다",
  );
  assert.notEqual(A.ws, B.ws);

  // ⓐ **교차 과금 거부**(B의 회계는 A의 permit으로 움직이지 않는다).
  const accB = B.kernel.getAccounting();
  assert.equal(
    codeOf(() =>
      B.kernel.chargeDispatchTurnUsage({ permit: a.permit, actionId: nextId("act"), inputTokens: 99, outputTokens: 99, elapsedMs: 9 }),
    ),
    "dispatch_permit_invalid",
  );
  assert.deepEqual(B.kernel.getAccounting(), accB, "형제 kernel의 permit이 회계를 움직였다");

  // ⓑ **교차 pending 등록 거부**.
  assert.equal(
    codeOf(() => B.kernel.beginOperation({ permit: a.permit, operationId: "op-2", actionId: nextId("act") })),
    "dispatch_permit_invalid",
  );
  assert.deepEqual(B.kernel.getTask("root")!.execution.pendingOperations.map((p) => p.operationId), ["op-1"]);

  // ⓒ **교차 실패 종결 거부**.
  assert.equal(codeOf(() => B.kernel.failOperation({ grant: a.grant, actionId: nextId("act"), marker: "failed" })), "dispatch_grant_invalid");

  // ⓓ **live key 충돌 없음**: B의 grant 발급이 A의 살아 있는 grant를 소비하지 못한다(같은 pendingKey).
  //    (4차 판은 모듈 전역 `Map`이라 B가 A의 grant를 `consumed`로 만들었다 → 여기서 `dispatch_grant_spent`.)
  writeFileSync(join(A.ws, "docs/out.md"), "쌍둥이 내용");
  const outcomeA = applyWriteFile(a.op, a.grant);
  assert.equal(outcomeA.marker, "already_applied");

  // ⓔ **집행 클로저는 발급 kernel의 state만 만진다**: A의 pending만 attempted가 됐다.
  assert.notEqual(A.kernel.getTask("root")!.execution.pendingOperations[0].attemptedAt, null);
  assert.equal(B.kernel.getTask("root")!.execution.pendingOperations[0].attemptedAt, null, "형제 kernel의 pending이 표시됐다");

  // ⓕ **교차 영수증 커밋 거부** → 그리고 발급 kernel에서는 정상 커밋된다(같은 handle · 같은 durable 신원).
  assert.equal(codeOf(() => B.kernel.recordOperationReceipt({ outcome: outcomeA, actionId: nextId("act") })), "invalid_receipt");
  assert.equal(B.kernel.getTask("root")!.execution.operationReceipts.length, 0, "형제 kernel에 영수증이 생겼다");
  const committed = A.kernel.recordOperationReceipt({ outcome: outcomeA, actionId: nextId("act") });
  assert.deepEqual(committed.execution.operationReceipts.map((r) => r.marker), ["already_applied"]);

  // ⓖ **교차 진행 채널 거부** → 발급 kernel에서는 정상 기록된다.
  const progressEvent = { kind: "progress", seq: 1, step: "진행" };
  assert.equal(
    codeOf(() => B.kernel.recordProgress({ channel: A.progress, actionId: nextId("act"), event: progressEvent })),
    "invalid_progress_channel",
  );
  assert.equal(B.kernel.getTask("root")!.execution.progressCount, 0, "형제 채널이 남의 시계를 되돌렸다");
  assert.equal(
    A.kernel.recordProgress({ channel: A.progress, actionId: nextId("act"), event: progressEvent }).execution.progressCount,
    1,
  );

  // ⓗ B의 pending은 **자기 handle로만** 닫힌다(교차 거부가 B를 미아로 만들지 않았다).
  assert.equal(B.kernel.failOperation({ grant: b.grant, actionId: nextId("act"), marker: "failed" }).execution.pendingOperations.length, 0);
  assert.deepEqual(readdirSync(join(B.ws, "docs")), [], "B에서 파일 효과가 났다");
});

test("[M5c] A2: 같은 workspace의 두 번째 인스턴스도 남이다 — 권위는 durable 경로로만 넘어간다", () => {
  // **명시적 결정**(DECISIONS 2026-07-31): 프로세스 메모리 handle은 kernel 인스턴스 경계를 조용히 넘지
  // 않는다. 재열기의 정합화는 durable 경로 둘로만 한다 — `attemptedAt === null`이면 같은 (turn, 계획)의
  // **커밋 없는 permit 재발급**, 그 밖이면 handle을 요구하지 않는 `reconcileUncertainOperation()`이다.
  const A = twinRun();
  const a = twinPermit(A);
  const second = OrchestrationKernel.open({ workspaceRoot: A.ws, runId: RUN_ID, clock: A.clock });

  // ⓐ 첫 인스턴스의 handle은 두 번째 인스턴스에서 전부 거부된다.
  assert.equal(
    codeOf(() => second.chargeDispatchTurnUsage({ permit: a.permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 0, elapsedMs: 1 })),
    "dispatch_permit_invalid",
  );
  assert.equal(
    codeOf(() => second.beginOperation({ permit: a.permit, operationId: "op-1", actionId: nextId("act") })),
    "dispatch_permit_invalid",
  );
  assert.equal(codeOf(() => second.failOperation({ grant: a.grant, actionId: nextId("act"), marker: "failed" })), "dispatch_grant_invalid");
  assert.equal(
    codeOf(() => second.recordProgress({ channel: A.progress, actionId: nextId("act"), event: { kind: "progress", seq: 1, step: "x" } })),
    "invalid_progress_channel",
  );
  assert.equal(A.kernel.getTask("root")!.execution.pendingOperations[0].attemptedAt, null, "거부가 durable 상태를 바꿨다");

  // ⓑ **durable 경로는 열려 있다**: 아직 집행 경계에 들어가지 않았으므로 두 번째 인스턴스가 같은
  //    (turn, 계획)의 permit을 **커밋 없이** 다시 받아 자기 grant로 진행한다(미아가 되지 않는다).
  const rev = second.getState().revision;
  const reissued = second.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-twin",
    actionId: nextId("act"),
    plan: planFor(second, "root", [writeOp({ content: "쌍둥이 내용" })], "turn-twin"),
  });
  assert.equal(second.getState().revision, rev, "정확한 재발급이 커밋을 만들었다");
  const ownGrant = second.beginOperation({ permit: reissued, operationId: "op-1", actionId: nextId("act") });
  assert.equal(second.failOperation({ grant: ownGrant, actionId: nextId("act"), marker: "failed" }).execution.pendingOperations.length, 0);
  assert.deepEqual(readdirSync(join(A.ws, "docs")), []);
});

// ── 7e. 표시 이후 권위 재확인 (3A 5차 리비전 A4) ──────────────────────────────

/**
 * `attemptedAt` 커밋 **도중** 경계를 넘는 시계. 표시가 durable해진 뒤부터 `crossed`를 돌려주므로
 * 첫 판정과 표시 커밋은 `base`에서 통과하고, **집행기 진입 직전의 두 번째 판정**만 경계에서 판정된다.
 */
function crossingClock(base: number, at: { crossed: number | null; attempted: () => boolean }): () => Date {
  return () => new Date(at.crossed !== null && at.attempted() ? at.crossed : base);
}

test("[M5c] A4: 표시 커밋 도중 deadline을 넘으면 집행기에 들어가지 않는다(등호 4종 · 파일 효과 0)", () => {
  // **4차 판의 진짜 결함**(독립 리뷰 A-4): `executeWriteFileOperation`은 권위를 한 번 읽고, 그 사이에
  // **deadline을 의도적으로 보지 않는** safety-only `attemptedAt` 커밋을 하고, 그 **옛 판정**으로 집행기에
  // 들어갔다 → 첫 시계 읽기에서 유효했던 deadline이 커밋 도중 지나도 효과가 그대로 나갔다. 이전 테스트는
  // **정지한 시계**로 등호를 봤을 뿐이라 두 판정 사이의 통과를 재현하지 못했다.
  const cases = [
    {
      label: "manifest 만료",
      code: "manifest_expired",
      manifestOver: {
        expiresAt: new Date(T0 + 600_000).toISOString(),
        autopilotPolicy: { ...POLICY, maxNoProgressMs: 900_000, maxAttemptElapsedMs: 900_000 },
      },
      deadlineOf: (k: OrchestrationKernel) => Date.parse(k.getState().manifest.expiresAt),
    },
    {
      label: "예산 deadline",
      code: "budget_elapsed_exhausted",
      // `maxAttemptElapsedMs <= maxElapsedMs`가 manifest 불변식이므로 셋을 같은 값으로 둔다 →
      // 세 deadline이 같은 밀리초에 겹치고, 판정 순서(만료 → 예산 → … → wall → no-progress)에 따라
      // **예산 deadline**이 그 자리를 잡는다.
      manifestOver: {
        maxElapsedMs: 120_000,
        autopilotPolicy: { ...POLICY, maxNoProgressMs: 120_000, maxAttemptElapsedMs: 120_000 },
      },
      deadlineOf: (k: OrchestrationKernel) => Date.parse(k.getState().accounting.budgetDeadlineAt),
    },
    {
      label: "attempt wall deadline",
      code: "attempt_wall_exhausted",
      manifestOver: { autopilotPolicy: { ...POLICY, maxAttemptElapsedMs: 30_000, maxNoProgressMs: 900_000 } },
      deadlineOf: (k: OrchestrationKernel) => Date.parse(k.getTask("root")!.execution.wallDeadlineAt!),
    },
    {
      label: "no-progress deadline",
      code: "no_progress_exhausted",
      manifestOver: { autopilotPolicy: { ...POLICY, maxNoProgressMs: 5_000, maxAttemptElapsedMs: 600_000 } },
      deadlineOf: (k: OrchestrationKernel) => Date.parse(k.getTask("root")!.execution.phaseStartedAt!) + 5_000,
    },
  ] as const;

  for (const c of cases) {
    // `offset === -1`은 대조군(경계 1ms 전 → 집행 성공), `0`은 **등호**(→ 효과 0).
    for (const offset of [-1, 0]) {
      const at: { crossed: number | null; attempted: () => boolean } = { crossed: null, attempted: () => false };
      const f = fixture({ manifestOver: { ...c.manifestOver }, clock: crossingClock(T0, at) });
      at.attempted = () => f.kernel.getTask("root")!.execution.pendingOperations.some((p) => p.attemptedAt !== null);
      // 우회가 성공했다면 **진짜 성공(`already_applied`)** 이 나올 조건을 만든다(공허하지 않은 관문).
      writeFileSync(join(f.ws, "docs/out.md"), "우리 내용");
      const [op, grant] = writePermit(f, { content: "우리 내용" });
      at.crossed = c.deadlineOf(f.kernel) + offset;
      const label = `${c.label} offset=${offset}`;

      if (offset === -1) {
        assert.equal(applyWriteFile(op, grant).marker, "already_applied", `${label}: 경계 1ms 전이 막혔다`);
        continue;
      }
      // **등호**: 표시는 durable해졌지만 집행기에는 들어가지 않는다.
      assert.equal(codeOf(() => applyWriteFile(op, grant)), c.code, label);
      const exec = f.kernel.getTask("root")!.execution;
      assert.equal(exec.operationReceipts.length, 0, `${label}: 거짓 성공 영수증이 생겼다`);
      const pending = exec.pendingOperations[0];
      assert.notEqual(pending.attemptedAt, null, `${label}: 불확실 구간이 durable하지 않다`);
      // 보수적으로 "시도됐을 수 있다"로 남는다 → 평범한 실패·재발급으로 닫히지 않는다.
      assert.equal(
        codeOf(() => f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" })),
        "operation_attempt_uncertain",
        label,
      );
      // 아래 두 확인은 **deadline과 무관한 이유**로 닫혀 있음을 본다 → 경계를 되돌린다. 시각을 뒤로 미는
      // 것이 아니다: 표시 커밋은 `attempted()`가 아직 false일 때 일어났으므로 durable `updatedAt`은
      // `base` 그대로다(시계 단조 게이트를 위반하지 않는다).
      at.crossed = null;
      const permit2 = f.kernel.issueOperationDispatchPermit({
        taskId: "root",
        turnId: "turn-1",
        actionId: nextId("act"),
        plan: planFor(f.kernel, "root", [writeOp({ content: "우리 내용" })], "turn-1"),
      });
      assert.equal(
        codeOf(() => f.kernel.beginOperation({ permit: permit2, operationId: "op-1", actionId: nextId("act") })),
        "operation_attempt_uncertain",
        `${label}: 표시된 pending이 다시 열렸다`,
      );
      // 정직한 나중 정합화만 남는다.
      const task = f.kernel.reconcileUncertainOperation({
        runId: RUN_ID,
        taskId: "root",
        attemptId: pending.attemptId,
        turnId: pending.turnId,
        planDigest: pending.planDigest,
        operationId: pending.operationId,
        kind: pending.kind,
        authorityId: pending.authorityId,
        actionId: nextId("act"),
      });
      const receipt = task.execution.operationReceipts[0];
      assert.equal(receipt.marker, "outcome_unknown", label);
      assert.deepEqual([receipt.path, receipt.resultSha256, receipt.exitCode], [null, null, null], label);
      // 파일은 그대로다(효과 0 — 바이트도 목록도 바뀌지 않았다).
      assert.equal(readFileSync(join(f.ws, "docs/out.md"), "utf8"), "우리 내용", label);
      assert.deepEqual(readdirSync(join(f.ws, "docs")), ["out.md"], label);
    }
  }
});

// ── 7f. 영수증 용량 예약 (3A 5차 리비전 A5) ───────────────────────────────────

test("[M5c] A5: 영수증 용량을 먼저 예약한다 — 닫을 수 없는 pending은 열리지 않는다(다중 turn 경계)", () => {
  // **4차 판의 진짜 결함**(독립 리뷰 A-5): operation은 turn 단위(64), 영수증은 attempt 단위(64) 상한인데
  // `beginOperation`은 **동시 pending 용량만** 봤다 → 같은 attempt의 뒤 turn이 영수증 64건 위에서 65번째
  // operation을 열 수 있었고, 영수증 커밋도 handle-free 정합화도 상한에서 거부되는데 attempt 이탈 전이는
  // 전부 pending 0을 요구하므로 그 pending은 **어떤 경로로도 닫히지 않는 영구 미아**였다.
  const cap = LIMITS.maxOperationReceipts;
  // 이 테스트는 durable 커밋을 128건 넘게 쌓으므로 **정지한 시계**를 쓴다(1초씩 전진하는 시계라면
  // no-progress·wall deadline이 먼저 걸려서 보려는 경계에 도달하지 못한다).
  const f = fixture({ clock: steppableClock(T0).clock });
  // ── turn-1: 영수증을 `cap - 1`건까지 채운다(한 자리 남긴다).
  const permit1 = permitFor(
    f.kernel,
    "root",
    Array.from({ length: cap }, (_, i) => writeOp({ operationId: `op-a${i}` })),
    "turn-1",
  );
  for (let i = 0; i < cap - 1; i++) {
    const grant = f.kernel.beginOperation({ permit: permit1, operationId: `op-a${i}`, actionId: nextId("act") });
    f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "failed" });
  }
  assert.equal(f.kernel.getTask("root")!.execution.operationReceipts.length, cap - 1);

  // ── ⓐ **`cap - 1`건 + pending 1건은 여전히 정합화된다**(마지막 자리는 예약돼 있다).
  f.kernel.beginOperation({ permit: permit1, operationId: `op-a${cap - 1}`, actionId: nextId("act") });
  const p = f.kernel.getTask("root")!.execution.pendingOperations[0];
  const reconciled = f.kernel.reconcileUncertainOperation({
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
  assert.equal(reconciled.execution.operationReceipts.length, cap);
  assert.equal(reconciled.execution.pendingOperations.length, 0);

  // ── ⓑ **다음 turn의 operation 65는 열리지 않는다** — pending·event·revision **전부 변화 0**으로 거부된다.
  const permit2 = permitFor(f.kernel, "root", [writeOp({ operationId: "op-over" })], "turn-2");
  const revBefore = f.kernel.getState().revision;
  const eventsBefore = readFileSync(f.kernel.paths.eventsFile, "utf8").length;
  assert.equal(
    codeOf(() => f.kernel.beginOperation({ permit: permit2, operationId: "op-over", actionId: nextId("act") })),
    "operation_limit_exceeded",
  );
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 0, "거부가 pending을 남겼다");
  assert.equal(f.kernel.getState().revision, revBefore, "거부가 revision을 올렸다");
  assert.equal(readFileSync(f.kernel.paths.eventsFile, "utf8").length, eventsBefore, "거부가 event를 남겼다");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), [], "거부 경로가 파일 효과를 냈다");

  // ── ⓒ 미아가 없으므로 attempt를 정상적으로 떠난다(cleanup → settle).
  const lease = f.kernel.getTask("root")!.execution.processLeaseMarker!;
  f.kernel.recordTerminal({ taskId: "root", actionId: nextId("act"), marker: "worker_failed" });
  f.kernel.confirmCleanup({ taskId: "root", actionId: nextId("act"), leaseMarker: lease });
  assert.equal(f.kernel.settleCleanedAttempt({ taskId: "root", actionId: nextId("act") }).state, "retry_wait");
});

test("[M5c] A5: 상한을 넘긴 pending+영수증 조합은 load에서 거부된다(손으로 만든 미아 금지)", () => {
  const f = fixture();
  const permit = permitFor(f.kernel, "root", [writeOp()], "turn-1");
  f.kernel.beginOperation({ permit, operationId: "op-1", actionId: nextId("act") });
  const raw = JSON.parse(readFileSync(f.kernel.paths.stateFile, "utf8")) as {
    tasks: Array<{ taskId: string; execution: { pendingOperations: PendingOperation[]; operationReceipts: unknown[] } }>;
  };
  const root = raw.tasks.find((t) => t.taskId === "root")!;
  const p = root.execution.pendingOperations[0];
  // pending 1건 + 영수증 `cap`건 = 상한 초과 → 그 pending은 어떤 경로로도 닫히지 않는다.
  root.execution.operationReceipts = Array.from({ length: LIMITS.maxOperationReceipts }, (_, i) => ({
    operationId: `op-r${i}`,
    kind: p.kind,
    authorityId: p.authorityId,
    attemptId: p.attemptId,
    turnId: p.turnId,
    planDigest: p.planDigest,
    path: null,
    resultSha256: null,
    exitCode: null,
    marker: "failed",
    at: p.beganAt,
  }));
  writeFileSync(f.kernel.paths.stateFile, JSON.stringify(raw, null, 2), "utf8");
  // state 검증이 event binding보다 **먼저** 돌므로 판정은 결정론적이다.
  assert.equal(codeOf(() => OrchestrationKernel.open({ workspaceRoot: f.ws, runId: RUN_ID })), "invalid_state");
});

test("[M5c] A2: 등록·발행·영수증 사이에서 재시작해도 중복 손상 없이 하나로 수렴한다", () => {
  const ws = makeWorkspace();
  // 재시작해도 **시계는 단조**여야 한다(3A 3차 리비전 A1의 시계 역행 게이트) → 하나의 clock을 공유한다.
  const clock = clockFrom(T0);
  const open = () => OrchestrationKernel.open({ workspaceRoot: ws, runId: RUN_ID, clock });
  const k0 = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestObject(),
    clock,
  });
  k0.createRootTask(seed("root", ["docs", "src"]));
  startNow(k0, "root");
  const plan = planFor(k0, "root", [writeOp({ content: "우리 내용" })]);
  // 크래시 창의 전제: 바이트는 이미 발행돼 있고 영수증만 없다(발행 자체는 A4로 fail closed다).
  writeFileSync(join(ws, "docs/out.md"), "우리 내용");
  const ino0 = lstatSync(join(ws, "docs/out.md")).ino;

  // ① 등록만 하고 죽는다(정합화 전 · 집행 경계 진입 전).
  const p0 = k0.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
  k0.chargeDispatchTurnUsage({ permit: p0, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  k0.beginOperation({ permit: p0, operationId: "op-1", actionId: nextId("act") });
  assert.equal(k0.getTask("root")!.execution.pendingOperations[0].attemptedAt, null, "등록만으로 시도가 기록됐다");
  assert.equal(lstatSync(join(ws, "docs/out.md")).ino, ino0);

  // ② 재시작: durable pending이 그대로 보인다 → 같은 (turn, 계획)을 다시 열어 정합화한다.
  const k1 = open();
  assert.deepEqual(
    k1.getTask("root")!.execution.pendingOperations.map((p) => p.operationId),
    ["op-1"],
    "재시작이 미확정 operation을 잃었다",
  );
  const p1 = k1.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
  const g1 = k1.beginOperation({ permit: p1, operationId: "op-1", actionId: nextId("act") });
  assert.equal(k1.getTask("root")!.execution.pendingOperations.length, 1, "정합화가 pending을 중복 등록했다");
  const r1 = applyWriteFile(p1.plan.operations[0] as TypedWriteFileOperation, g1);
  assert.equal(r1.marker, "already_applied");
  const ino = lstatSync(join(ws, "docs/out.md")).ino;
  assert.notEqual(k1.getTask("root")!.execution.pendingOperations[0].attemptedAt, null, "집행 경계 진입이 durable하지 않다");

  // ③ 영수증 커밋 **직전에** 다시 죽는다. 이번에는 pending이 **집행 경계에 들어간 상태**이므로 재집행
  //    경로가 열리지 않는다(3A 4차 리비전 A2 — 이전 판은 여기서 grant를 또 발급해 같은 operation을 다시
  //    집행할 수 있었고, 그 assertion이 정확히 그 동작을 정상으로 고정하고 있었으므로 **교체**했다).
  const k2 = open();
  assert.deepEqual(k2.getTask("root")!.execution.pendingOperations.map((p) => p.operationId), ["op-1"]);
  const p2 = k2.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
  assert.equal(
    codeOf(() => k2.beginOperation({ permit: p2, operationId: "op-1", actionId: nextId("act") })),
    "operation_attempt_uncertain",
  );
  // 재시작한 kernel은 옛 handle이 하나도 없다 → durable 신원만으로 **정직하게** 닫는다.
  const p = k2.getTask("root")!.execution.pendingOperations[0];
  const task = k2.reconcileUncertainOperation({
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
  // **중복 손상 없음**: 바이트를 다시 쓰지 않았다(inode 불변).
  assert.equal(lstatSync(join(ws, "docs/out.md")).ino, ino);

  // ④ 정확히 하나의 결과로 수렴한다(성공이 아니라 **정직한 불확실**로).
  assert.equal(task.execution.pendingOperations.length, 0);
  assert.deepEqual(task.execution.operationReceipts.map((r) => r.operationId), ["op-1"]);
  assert.equal(task.execution.operationReceipts[0].marker, "outcome_unknown");
  // ⑤ 그리고 이제 다음 turn이 열린다(끝난 claim이 교체된다 — 과금은 이미 turn 시작 때 끝났다).
  const p3 = k2.issueOperationDispatchPermit({
    taskId: "root",
    turnId: "turn-2",
    actionId: nextId("act"),
    plan: { ...plan, turnId: "turn-2", operations: [] },
  });
  assert.equal(p3.turnId, "turn-2");
  assert.equal(k2.getTask("root")!.execution.dispatchTurnId, "turn-2");
  // ⑥ 재시작한 kernel이 다시 열어도 durable 사실은 같다(거짓 성공 없음).
  assert.deepEqual(open().getTask("root")!.execution.operationReceipts.map((r) => r.marker), ["outcome_unknown"]);
  assert.deepEqual(orphanTemps(join(ws, "docs")), []);
});

test("[M5c] 적대적 객체·proxy·accessor는 lifecycle을 우회하거나 오류 taxonomy를 고를 수 없다", () => {
  const f = fixture();
  const [op] = writePermit(f, { content: "우리 내용" });
  // ⓐ 던지는 getter를 **영수증 자리에 넣을 통로 자체가 없다**(3A 3차 리비전 A2): outcome handle은
  //    등록부 조회 하나로 판정되고 호출자 property를 읽지 않으므로 taxonomy를 고를 수 없다.
  const throwing = { get marker(): string { throw new OrchestrationError("already_applied", "내가 고른 코드"); } };
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ outcome: throwing, actionId: nextId("act") })), "invalid_receipt");
  // ⓑ `ownKeys` trap을 쓰는 Proxy도 마찬가지다.
  const trapped = new Proxy({} as Record<string, unknown>, {
    ownKeys() {
      throw new OrchestrationError("applied", "내가 고른 코드");
    },
  });
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ outcome: trapped, actionId: nextId("act") })), "invalid_receipt");
  // 진행 신호 자리의 적대적 이벤트도 안정 코드로 접힌다(같은 규칙의 다른 진입점).
  const channel = channelFor(f.kernel, "root");
  const throwingEvent = new Proxy({} as Record<string, unknown>, {
    ownKeys() {
      throw new OrchestrationError("no_progress_exhausted", "내가 고른 코드");
    },
  });
  assert.equal(
    codeOf(() => f.kernel.recordProgress({ channel, actionId: nextId("act"), event: throwingEvent })),
    "invalid_artifact_ref",
  );
  // ⓒ permit/grant 자리에 넣은 적대적 객체도 lifecycle을 열지 못한다.
  const hostilePermit = new Proxy({} as Record<string, unknown>, {
    get() {
      throw new OrchestrationError("dispatch_permit_invalid", "내가 고른 코드");
    },
  });
  assert.equal(
    codeOf(() => f.kernel.beginOperation({ permit: hostilePermit, operationId: "op-1", actionId: nextId("act") })),
    "dispatch_permit_invalid",
  );
  assert.equal(codeOf(() => applyWriteFile(op, hostilePermit)), "dispatch_grant_invalid");
  // ⓓ 적대적 계획 입력도 같은 자리에서 접힌다.
  assert.equal(
    codeOf(() =>
      f.kernel.issueOperationDispatchPermit({
        taskId: "root",
        turnId: "turn-9",
        actionId: nextId("act"),
        plan: new Proxy({}, { ownKeys() { throw new Error("x"); } }),
      }),
    ),
    "plan_invalid",
  );
  assert.deepEqual(readdirSync(join(f.ws, "docs")), [], "적대적 입력이 파일을 만들었다");
});

// ── 8. run_process 명세 (spawn 0) ───────────────────────────────────────────

test("[M5c] B2: 실행 권능은 opaque·일회용이고 실행 대상을 노출하지 않으며 아무것도 띄우지 않는다", () => {
  // **이전 판은 공개 구조적 `ProcessLaunchSpec`이었다**(3A 3차 리뷰 B2): 실행 파일 경로·digest·파생
  // argv가 전부 필드로 노출돼 ⓐ 호출자가 같은 모양의 객체를 **직접 만들 수** 있었고 ⓑ 취소·만료·attempt
  // 교체 **이후에 재생**할 수 있었다. 지금 돌려주는 것은 감사용 신원뿐인 등록부 연결 값이다.
  const f = fixture();
  const [op, grant] = processPermit(f);
  const cap = resolveProcessLaunchCapability(op, grant);
  assert.deepEqual({ ...cap }, {
    operationId: "op-2",
    authorityId: "p-node",
    runId: RUN_ID,
    taskId: "root",
    attemptId: f.kernel.getTask("root")!.execution.attemptId,
    turnId: "turn-1",
  });
  assert.equal(Object.isFrozen(cap), true);
  // **실행 대상·argv·digest·timeout은 표면에 없다** — 미래 launcher만 모듈 사설 레코드로 소비한다.
  for (const key of ["executable", "sha256", "entrypoint", "entrypointSha256", "action", "args", "timeoutMs", "data", "planPath"]) {
    assert.equal(key in cap, false, `실행 명세가 다시 노출됐다: ${key}`);
  }
  for (const v of Object.values(cap)) assert.notEqual(typeof v, "function");
  // 권위는 **등록부 연결**에서만 나온다: 전개 사본·수제 객체·proxy는 진짜 권능이 아니다.
  assert.equal(isGenuineLaunchCapability(cap), true);
  for (const forged of [{ ...cap }, Object.freeze({ ...cap }), new Proxy(cap, {}), {}, null]) {
    assert.equal(isGenuineLaunchCapability(forged), false, JSON.stringify(forged) ?? "?");
  }
  // 승인된 node·entrypoint 경로는 이 테스트 환경에 **존재하지 않는다** — 그래도 성공한다 = spawn이 없다.
  assert.equal(lstatSync(NODE_PATH, { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(ENTRYPOINT_PATH, { throwIfNoEntry: false }), undefined);
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
});

test("[M5c] B2: 권능 발급은 효과가 아니다 — run_process pending은 성공으로 닫히지 않는다", () => {
  // **3A 3차 리뷰 A2의 정확한 지적**: 이전 판은 아무것도 spawn하지 않으면서 grant를 `executing`으로
  // 올렸고, 그것만으로 호출자가 만든 `applied` 영수증이 수락됐다. 지금 권능 발급은 **순수 판정**이므로
  // grant는 손대지 않고, launcher가 없는 이 슬라이스에서 `run_process`는 실패로만 닫힌다.
  const f = fixture();
  const [op, grant] = processPermit(f);
  resolveProcessLaunchCapability(op, grant); // grant를 소진하지 않는다
  resolveProcessLaunchCapability(op, grant); // 몇 번이든 순수 판정이다
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 1);
  // 성공을 만들 통로가 없다.
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ outcome: grant, actionId: nextId("act") })), "invalid_receipt");
  const task = f.kernel.failOperation({ grant, actionId: nextId("act"), marker: "denied" });
  assert.equal(task.execution.operationReceipts[0].kind, "run_process");
  assert.equal(task.execution.operationReceipts[0].marker, "denied");
  assert.equal(task.execution.operationReceipts[0].exitCode, null);
  // lifecycle이 죽으면 권능도 나오지 않는다(재생 차단 — 권능은 발급 시점 durable 상태에 묶인다).
  const g = fixture();
  const [op2, grant2] = processPermit(g);
  g.kernel.requestCancel({ taskId: "root", actionId: nextId("act") });
  assert.equal(codeOf(() => resolveProcessLaunchCapability(op2, grant2)), "dispatch_task_not_running");
});

test("[M5c] B-10: run_process는 --eval·--require·임의 script/module·action 주입을 표현할 수 없다", () => {
  const bad = (over: Record<string, unknown>): string =>
    codeOf(() =>
      validateApprovalManifest(
        manifestObject({
          operationAuthorityByTask: {
            root: [{ authorityId: "p-x", kind: "run_process", action: "validate-plan", data: { planPath: "docs/p.json" }, timeoutMs: 1000, ...over }],
          },
        }),
      ),
    );

  // ⓐ **코드 권위 인자는 데이터 자리에 들어갈 수 없다**: `data`는 이제 임의 문자열 배열이 아니라
  //    `{planPath}` 하나이고, 옵션 문자열은 승인된 경로 범위 밖이라 거부된다(3A 3차 리비전 B2).
  for (const arg of ["--eval", "-e", "--require", "-r", "--input-type=module", "--experimental-vm-modules", "--import"]) {
    assert.equal(bad({ data: { planPath: arg } }), "operation_outside_writable_root", arg);
  }
  assert.equal(bad({ data: ["docs/p.json"] }), "invalid_manifest", "배열 data가 아직 통과한다");
  assert.equal(bad({ data: { planPath: "docs/p.json", extra: "x" } }), "invalid_manifest");
  assert.equal(bad({ data: {} }), "invalid_manifest");
  // ⓑ 임의 script/module 경로도 실행 대상이 되지 못한다: 실행 대상 필드 자체가 없다.
  for (const key of ["executable", "args", "entrypoint", "module", "script", "shell", "env", "cwd", "network", "remote"]) {
    assert.equal(RUN_PROCESS_AUTHORITY_KEYS.includes(key as never), false, key);
    assert.equal(WRITE_FILE_AUTHORITY_KEYS.includes(key as never), false, key);
    assert.equal(bad({ [key]: "/tmp/evil.js" }), "invalid_manifest", key);
  }
  // ⓒ action은 닫힌 enum이다(주입·미상 action 거부).
  for (const action of ["exec", "eval", "validate-plan; rm -rf /", "VALIDATE-PLAN", "", "../validate-plan", 1, null]) {
    assert.equal(bad({ action }), "operation_action_not_approved", String(action));
  }
  assert.deepEqual([...CONTROLLER_ACTIONS], ["validate-plan"], "action 목록이 승인 없이 늘었다");
  // ⓓ NUL·고립 surrogate·절대 경로·traversal·미정규화도 거부다(정확한 바이트 왕복 + 승인 범위).
  assert.equal(bad({ data: { planPath: "a\0b" } }), "operation_data_not_approved");
  assert.equal(bad({ data: { planPath: "docs/\ud800.json" } }), "operation_data_not_approved");
  assert.equal(bad({ data: { planPath: "/etc/passwd" } }), "operation_data_not_approved");
  assert.equal(bad({ data: { planPath: "../evil.json" } }), "operation_data_not_approved");
  assert.equal(bad({ data: { planPath: "docs/./p.json" } }), "operation_data_not_approved");
  assert.equal(bad({ data: { planPath: "x".repeat(600) } }), "operation_data_not_approved");
  // ⓔ **고정 entrypoint는 manifest 하나에서만 온다**: 없으면 v1로 보고 fail closed다.
  const { controllerEntrypoint: _drop, ...noEntry } = EXECUTION_AUTHORITY;
  assert.equal(
    codeOf(() => validateApprovalManifest(manifestObject({ executionAuthority: noEntry }))),
    "manifest_pre_m5c_unsupported",
  );
  // ⓕ 승인된 digest는 manifest에만 있고 **권능 표면에는 없다**(미래 launcher가 spawn 직전에 재검증한다).
  const m = validateApprovalManifest(manifestObject());
  assert.equal(m.executionAuthority.controllerEntrypoint.sha256, EXECUTION_AUTHORITY.controllerEntrypoint.sha256);
  assert.equal(m.executionAuthority.node.sha256, EXECUTION_AUTHORITY.node.sha256);
  // ⓖ **이 리비전 전체의 spawn 수는 0이다**: 승인된 실행 파일이 존재하지도 않는데 권능이 나온다.
  const f2 = fixture();
  const [pop, pgrant] = processPermit(f2);
  assert.equal(isGenuineLaunchCapability(resolveProcessLaunchCapability(pop, pgrant)), true);
  assert.equal(lstatSync(m.executionAuthority.node.path, { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(m.executionAuthority.controllerEntrypoint.path, { throwIfNoEntry: false }), undefined);
});

// ── 9. schema ↔ runtime 동치 ────────────────────────────────────────────────

function readSchema(name: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", name), "utf8"));
}

/** object 타입 하위 schema는 **전부** 닫혀 있어야 한다. */
function assertClosedEverywhere(node: any, path: string): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertClosedEverywhere(n, `${path}[${i}]`));
    return;
  }
  if (node.type === "object" || (node.properties !== undefined && node.type !== "array")) {
    assert.equal(node.additionalProperties, false, `${path}가 닫혀 있지 않다`);
    assert.notEqual(node.required, undefined, `${path}에 required가 없다`);
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "not" || k === "properties" || k === "definitions" || k === "items" || k === "oneOf" || k === "anyOf") {
      assertClosedEverywhere(v, `${path}.${k}`);
    }
  }
}

// **정직한 이름**(3A 4차 리비전 C-1): 아래 테스트들은 draft-07 validator를 **실행하지 않는다**.
// schema의 key 집합·enum·상한을 런타임 상수와 **구조적으로 대조**할 뿐이다(런타임 전용 불변식은
// 각 정의의 description에 적어 두었다). 실제 draft-07 구현은 이 레포에 추가하지 않았다.
test("[M5c] typed_execution_plan.schema.json의 key·enum·상한이 런타임 상수와 구조적으로 일치한다", () => {
  const s = readSchema("typed_execution_plan.schema.json");
  assert.equal(s.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(s.properties.schemaVersion.const, TYPED_EXECUTION_PLAN_SCHEMA_VERSION);
  assert.deepEqual(s.required, [...TYPED_PLAN_KEYS]);
  assert.deepEqual(Object.keys(s.properties).sort(), [...TYPED_PLAN_KEYS].sort());
  assert.equal(s.additionalProperties, false);

  // result / outputs.
  assert.deepEqual(s.properties.result.required, [...TYPED_PLAN_RESULT_KEYS]);
  assert.deepEqual(Object.keys(s.properties.result.properties).sort(), [...TYPED_PLAN_RESULT_KEYS].sort());
  assert.equal(s.properties.result.properties.summary.maxLength, LIMITS.maxSummaryLength);
  assert.equal(s.properties.result.properties.summary.minLength, 1);
  assert.equal(s.properties.result.properties.outputs.maxItems, LIMITS.maxArtifactRefs);
  const output = s.properties.result.properties.outputs.items;
  assert.deepEqual(output.required, [...TYPED_PLAN_OUTPUT_KEYS]);
  assert.deepEqual(Object.keys(output.properties).sort(), [...TYPED_PLAN_OUTPUT_KEYS].sort());
  assert.deepEqual(s.definitions.artifactRole.enum, [...ARTIFACT_ROLES]);

  // operations — 닫힌 2갈래 union.
  assert.equal(s.properties.operations.maxItems, LIMITS.maxOperationsPerTurn);
  assert.deepEqual(
    s.properties.operations.items.oneOf.map((x: any) => x.$ref),
    ["#/definitions/writeFileOperation", "#/definitions/runProcessOperation"],
  );
  const w = s.definitions.writeFileOperation;
  const r = s.definitions.runProcessOperation;
  assert.deepEqual(w.required, [...WRITE_FILE_OPERATION_KEYS]);
  assert.deepEqual(Object.keys(w.properties).sort(), [...WRITE_FILE_OPERATION_KEYS].sort());
  assert.deepEqual(r.required, [...RUN_PROCESS_OPERATION_KEYS]);
  assert.deepEqual(Object.keys(r.properties).sort(), [...RUN_PROCESS_OPERATION_KEYS].sort());
  assert.equal(w.properties.kind.const, "write_file");
  assert.equal(r.properties.kind.const, "run_process");
  assert.equal(w.properties.content.maxLength, LIMITS.maxWriteBytes);
  assert.deepEqual(w.properties.expectedBeforeSha256.oneOf.map((x: any) => x.$ref ?? x.type), [
    "#/definitions/sha256",
    "null",
  ]);
  assert.equal(s.definitions.sha256.pattern, SHA256_PATTERN);
  assert.equal(s.definitions.slug.pattern, SLUG_PATTERN);
  assert.equal(s.definitions.slug.maxLength, LIMITS.maxIdLength);

  // 경로 — pattern·length·surrogate 정본이 하나이고 draft-07 maxLength는 **코드 포인트**다(대장 `C-40`).
  const p = s.definitions.normalizedWorkspacePath;
  assert.equal(p.pattern, NORMALIZED_WORKSPACE_PATH_PATTERN);
  assert.deepEqual(
    p.not.anyOf.map((x: any) => x.pattern),
    [WINDOWS_DRIVE_PATTERN, LONE_SURROGATE_PATTERN],
  );
  assert.equal(p.maxLength, LIMITS.maxPathLength);
  assert.equal(p.minLength, 1);

  // **schema가 표현할 수 없는 런타임 전용 불변식을 문서가 정직하게 적는다**(과대주장 금지).
  for (const claim of ["operationId", "NUL", "런타임 전용"]) {
    assert.ok(s.description.includes(claim), `schema description에 ${claim} 설명이 없다`);
  }
  assert.ok(s.properties.operations.description.includes("draft-07은 그 불변식을 표현할 수 없다"));

  assertClosedEverywhere(s, "plan");
});

test("[M5c] schema 경로 pattern과 런타임 판정이 같은 표를 낸다(고립 surrogate 포함)", () => {
  const s = readSchema("typed_execution_plan.schema.json");
  const def = s.definitions.normalizedWorkspacePath;
  const pathRe = new RegExp(def.pattern);
  const excludeRes = def.not.anyOf.map((x: any) => new RegExp(x.pattern));
  const schemaAccepts = (v: string) =>
    pathRe.test(v) &&
    !excludeRes.some((re: RegExp) => re.test(v)) &&
    [...v].length >= 1 &&
    [...v].length <= def.maxLength;
  const runtimeAccepts = (v: string) =>
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [writeOp({ path: v })] }), BINDING)) === "no-error";

  const NUL = String.fromCharCode(0);
  const table = [
    "docs/out.md",
    "a",
    "a/b/c",
    "a.b/..c/d...",
    "docs/.hidden",
    "docs/a b.md",
    "😀/😀",
    "docs/\uFFFD.md",
    "docs/\uD83D\uDE00.md",
    "\uD800",
    "\uDC00",
    "docs/\uD800.md",
    "docs/\uDC00.md",
    "docs/a\uD800b/c.md",
    "\uDC00\uD800",
    "😀\uDE00",
    "",
    "/docs/a.md",
    "C:/a.md",
    "c:/a.md",
    "docs//a.md",
    "docs/./a.md",
    "docs/../a.md",
    "../a.md",
    "docs/",
    "./a",
    ".",
    "..",
    "a/..",
    "a/.",
    `a${NUL}b`,
    "a\\b",
    "😀".repeat(LIMITS.maxPathLength),
    "😀".repeat(LIMITS.maxPathLength + 1),
    "a".repeat(LIMITS.maxPathLength),
    "a".repeat(LIMITS.maxPathLength + 1),
  ];
  for (const v of table) {
    assert.equal(schemaAccepts(v), runtimeAccepts(v), `schema와 런타임 판정이 갈린다: ${JSON.stringify(v.slice(0, 40))}`);
  }
});

test("[M5c] 실제로 입양된 계획이 schema의 required·enum 범위 안에 있다", () => {
  const s = readSchema("typed_execution_plan.schema.json");
  const plan = adopt();
  const json = JSON.parse(JSON.stringify(plan));
  for (const key of s.required) assert.ok(key in json, `required 누락: ${key}`);
  assert.deepEqual(Object.keys(json).sort(), [...TYPED_PLAN_KEYS].sort());
  assert.equal(json.schemaVersion, s.properties.schemaVersion.const);
  for (const op of json.operations as TypedOperation[]) {
    const def = op.kind === "write_file" ? s.definitions.writeFileOperation : s.definitions.runProcessOperation;
    assert.deepEqual(Object.keys(op).sort(), [...def.required].sort());
  }
  for (const out of json.result.outputs) assert.ok(s.definitions.artifactRole.enum.includes(out.role));
});
