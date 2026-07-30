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
 * - 발행은 **경쟁을 예방한다**(3A 리비전 A3): 부재 대상은 `link(2)`로 덮어쓰지 않고, 교체는 preimage
 *   신원·내용을 발행 직전에 다시 확인하며, 부모·temp 경로가 교체되면 거부한다. 남의 바이트는 안 바뀐다.
 * - 실패 경로는 fd·temp를 남기지 않고 안정 코드로 접히며, `applied`는 **디렉터리 fsync 뒤에만** 나온다.
 * - 프로세스는 **명세만** 나온다(spawn 0) — 실행 파일·argv·timeout은 승인 레코드에서만 온다.
 * - JSON Schema와 런타임이 **동치**다(draft-07 maxLength = 코드 포인트 · 고립 surrogate 거부).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  unlinkSync,
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
} from "./orchestrationTypes.js";
import type { AgentMessageType } from "./orchestrationTypes.js";
import { OPERATION_RECEIPT_KEYS } from "./orchestrationStore.js";
import { RUN_PROCESS_AUTHORITY_KEYS, WRITE_FILE_AUTHORITY_KEYS, validateApprovalManifest } from "./approvalManifest.js";
import {
  DISPATCH_AUTHORITY_CODES,
  OrchestrationKernel,
  type OperationDispatchPermit,
  type OperationExecutionGrant,
  type PreflightDecision,
  type TaskSeed,
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
  __setPublicationSeamsForTest,
  applyWriteFile,
  resolveProcessLaunchSpec,
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
    { authorityId: "p-node", kind: "run_process", action: "validate-plan", data: ["docs/plan.json"], timeoutMs: 5_000 },
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

/** 진짜 시작 경로 전부를 지난다(ready → prepared → running). lease marker를 돌려준다. */
function startNow(k: OrchestrationKernel, taskId: string): string {
  preflight(k, [taskId]);
  const leaseMarker = `lease.${(++counter).toString(16).padStart(32, "0")}`;
  k.startPreparedTask({ taskId, actionId: nextId("act"), leaseMarker });
  return leaseMarker;
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

/** kernel이 발급한 봉인 permit. **집행에 쓸 operation은 `permit.plan.operations`에서 꺼낸다.** */
function permitFor(k: OrchestrationKernel, taskId: string, operations: unknown[], turnId = "turn-1"): OperationDispatchPermit {
  return k.issueOperationDispatchPermit({ taskId, turnId, actionId: nextId("act"), plan: planFor(k, taskId, operations, turnId) });
}

/**
 * 집행 직전 durable 등록을 지나 **일회용 execution grant**를 받는다(3A 2차 리비전 A2).
 * 효과 진입점(`applyWriteFile`/`resolveProcessLaunchSpec`)은 permit이 아니라 이 grant를 요구한다.
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

/** 임시 파일 잔재(operation 신원에서 파생된 접두사). 어떤 경로에서도 0이어야 한다. */
function orphanTemps(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(".m5c-op-"));
}

/** 구조적 영수증 하나(호출자가 만들 수 있는 모양 그대로 — 그래서 위조 시도를 그대로 재현한다). */
function rec(
  op: TypedWriteFileOperation | TypedRunProcessOperation,
  marker: OperationReceipt["marker"],
  path: string | null = null,
  resultSha256: string | null = null,
): OperationReceipt {
  return { operationId: op.operationId, kind: op.kind, authorityId: op.authorityId, path, resultSha256, exitCode: null, marker, at: "2026-07-30T00:00:00.000Z" };
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
            root: [{ authorityId: "p-x", kind: "run_process", action: "validate-plan", data: [`tag=${HIGH}`], timeoutMs: 1000 }],
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
    assert.equal(codeOf(() => resolveProcessLaunchSpec(pop, bad)), "dispatch_grant_invalid");
    // 순수 판정은 permit도 받으므로 위조는 `dispatch_permit_invalid`다.
    assert.equal(codeOf(() => resolveWriteFileAuthority(op, bad)), "dispatch_permit_invalid");
  }
  // **진짜 permit이라도 grant 없이는 효과가 없다**(집행 전 durable 등록 강제 — 3A 2차 리비전 A2).
  assert.equal(codeOf(() => applyWriteFile(op, permit)), "dispatch_grant_invalid");
  assert.equal(codeOf(() => resolveProcessLaunchSpec(pop, permit)), "dispatch_grant_invalid");
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
  const permitA = permitFor(f.kernel, "root", [writeOp()]);
  const permitB = permitFor(f.kernel, "sibling", [writeOp({ operationId: "op-b", authorityId: "w-sib", path: "docs/sib.md" })]);
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
  // 위 거부는 grant를 소진하지 않는다 — 진짜 짝은 그대로 집행된다.
  assert.equal(applyWriteFile(opA, grantA).marker, "applied");
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
  // 같은 (turn, 계획)의 재발급은 멱등이다(재시작한 controller가 정합화할 수 있어야 한다).
  const rev = f.kernel.getState().revision;
  f.kernel.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan: good });
  assert.equal(f.kernel.getState().tasks.find((t) => t.taskId === "root")!.execution.dispatchTurnId, "turn-1");
  assert.equal(f.kernel.getState().revision, rev + 1, "재발급도 claim 커밋을 남긴다(값은 그대로)");
});

test("[M5c] A1: durable turn이 null인 동안에도 두 turn/계획이 함께 살아남지 못한다", () => {
  // 1차 판의 실패 경로 그대로: durable turn이 `null`인 상태에서 turn-1·turn-2 permit을 각각 받아
  // **둘 다** 집행할 수 있었다. 지금은 **먼저 claim한 것 하나만** 존재하고 나머지는 fail closed다.
  const f = fixture();
  assert.equal(f.kernel.getTask("root")!.execution.turnId, null, "durable turn이 null인 상태에서 시작한다");
  assert.equal(f.kernel.getTask("root")!.execution.dispatchTurnId, null);

  const permit1 = permitFor(f.kernel, "root", [writeOp()], "turn-1");
  // ⓐ 다른 turn은 permit을 받지 못한다.
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
  // ⓓ claim된 계획만 집행된다.
  const op1 = permit1.plan.operations[0] as TypedWriteFileOperation;
  assert.equal(applyWriteFile(op1, grantFor(f.kernel, permit1, op1.operationId)).marker, "applied");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), ["out.md"]);
  // ⓔ claim된 turn 말고 다른 turn을 과금할 수 없다(durable turn 신원 갈아끼우기 차단).
  assert.equal(
    codeOf(() =>
      f.kernel.chargeTurnUsage({ taskId: "root", actionId: nextId("act"), turnId: "turn-2", inputTokens: 1, outputTokens: 1, elapsedMs: 1 }),
    ),
    "turn_conflict",
  );
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
    const permit = permitFor(f.kernel, "sibling", [writeOp({ authorityId: "w-sib", path: "docs/sib.md" })]);
    const op = permit.plan.operations[0] as TypedWriteFileOperation;
    const grant = grantFor(f.kernel, permit, op.operationId);
    const firstAttempt = permit.attemptId;

    f.kernel.recordTerminal({ taskId: "sibling", actionId: nextId("act"), marker: "worker_failed" });
    f.kernel.confirmCleanup({ taskId: "sibling", actionId: nextId("act"), leaseMarker: lease });
    f.kernel.settleCleanedAttempt({ taskId: "sibling", actionId: nextId("act") });
    assert.equal(f.kernel.getTask("sibling")!.state, "retry_wait");
    startNow(f.kernel, "sibling");
    assert.equal(f.kernel.getTask("sibling")!.state, "running");
    assert.notEqual(f.kernel.getTask("sibling")!.execution.attemptId, firstAttempt);

    assert.equal(codeOf(() => applyWriteFile(op, grant)), "dispatch_identity_stale");
    // 낡은 attempt의 영수증 재생(replay)도 닫힌다: 집행 게이트를 지나지 못한 grant는 성공 marker를
    // 만들 수 없고(`invalid_receipt`), 실패 marker로도 낡은 attempt에는 커밋되지 않는다.
    assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: rec(op, "applied", "docs/sib.md", sha256("hello")) })), "invalid_receipt");
    assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: rec(op, "failed") })), "dispatch_identity_stale");
    assert.equal(lstatSync(join(f.ws, "docs/sib.md"), { throwIfNoEntry: false }), undefined);
  }
  // ⓒ **claim된 turn이 과금으로 닫히면** 그 turn의 permit·grant는 그 자리에서 죽는다.
  //    (1차 판은 `chargeTurnUsage`가 아무 turn이나 durable `turnId`에 밀어 넣을 수 있었다 — 3A 2차 A1.)
  {
    const f = fixture();
    const permit = permitFor(f.kernel, "root", [writeOp()]); // turn-1 claim
    const op = permit.plan.operations[0] as TypedWriteFileOperation;
    const grant = grantFor(f.kernel, permit, op.operationId);
    // 미확정 operation이 남아 있으면 turn을 닫을 수 없다(효과 누락 은폐 차단).
    assert.equal(
      codeOf(() =>
        f.kernel.chargeTurnUsage({ taskId: "root", actionId: nextId("act"), turnId: "turn-1", inputTokens: 1, outputTokens: 1, elapsedMs: 10 }),
      ),
      "operation_pending_unreconciled",
    );
    const receipt = applyWriteFile(op, grant);
    assert.equal(receipt.marker, "applied");
    f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt });
    f.kernel.chargeTurnUsage({
      taskId: "root",
      actionId: nextId("act"),
      turnId: "turn-1",
      inputTokens: 1,
      outputTokens: 1,
      elapsedMs: 10,
    });
    const exec = f.kernel.getTask("root")!.execution;
    assert.equal(exec.turnId, "turn-1");
    assert.equal(exec.dispatchTurnId, null, "과금이 dispatch turn을 닫지 않았다");
    // 닫힌 turn은 다시 claim되지 않는다.
    assert.equal(
      codeOf(() => permitFor(f.kernel, "root", [writeOp({ operationId: "op-again" })], "turn-1")),
      "turn_already_charged",
    );
    // 다음 turn은 정상적으로 열린다(같은 attempt 안에서 turn이 이어진다).
    const permit2 = permitFor(f.kernel, "root", [writeOp({ operationId: "op-t2", path: "docs/small.md", authorityId: "w-small", content: "x" })], "turn-2");
    const op2 = permit2.plan.operations[0] as TypedWriteFileOperation;
    assert.equal(applyWriteFile(op2, grantFor(f.kernel, permit2, op2.operationId)).marker, "applied");
  }
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
    assert.equal(codeOf(() => resolveProcessLaunchSpec(pop, pgrant)), "no-error", "만료 1ms 전은 통과해야 한다");
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
  // ⓐ **토큰 예산 등호**: `tokensUsed === maxTokens`면 더 이상 효과가 없다(1차 판은 아예 보지 않았다).
  {
    const f = fixture({ manifestOver: { maxTokens: 10 } });
    const [op, grant] = writePermit(f);
    const permitTurn = f.kernel.getTask("root")!.execution.dispatchTurnId!;
    // 이 turn의 미확정 operation을 먼저 닫아야 turn을 과금할 수 있다(성공 누락 게이트).
    f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: rec(op, "failed") });
    f.kernel.chargeTurnUsage({ taskId: "root", actionId: nextId("act"), turnId: permitTurn, inputTokens: 6, outputTokens: 4, elapsedMs: 1 });
    assert.equal(f.kernel.getAccounting().tokensUsed, 10, "정확히 상한만큼 태웠다(등호)");
    // 다음 turn은 열 수는 있지만 **효과 게이트**가 토큰 등호에서 막는다.
    const permit2 = permitFor(f.kernel, "root", [writeOp({ operationId: "op-after" })], "turn-2");
    const op2 = permit2.plan.operations[0] as TypedWriteFileOperation;
    assert.equal(codeOf(() => grantFor(f.kernel, permit2, op2.operationId)), "budget_tokens_exhausted");
    assert.equal(codeOf(() => applyWriteFile(op2, grantFor(f.kernel, permit2, op2.operationId))), "budget_tokens_exhausted");
    assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
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
    // 인정되는 진행 신호가 시계를 되돌린다 → 다시 집행 가능.
    f.kernel.recordProgress({ taskId: "root", actionId: nextId("act") });
    assert.equal(applyWriteFile(op, grant).marker, "applied");
  }
  for (const code of ["budget_tokens_exhausted", "attempt_wall_exhausted", "no_progress_exhausted"] as const) {
    assert.ok(DISPATCH_AUTHORITY_CODES.includes(code), code);
  }
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
  assert.equal(codeOf(() => resolveProcessLaunchSpec(kindOp as TypedRunProcessOperation, g(kindOp))), "operation_denied");
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
  const receipt = applyWriteFile(childOk, grantFor(f.kernel, childPermit, childOk.operationId));
  assert.equal(receipt.marker, "applied");
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

test("[M5c] A3: 부재 대상은 원자적으로 발행되고 기존 경로 교체는 손대기 전에 거부된다", () => {
  const f = fixture();
  const [[op1, g1], [op2, g2]] = writeGrants(f, [
    { content: "첫 내용\n" },
    { content: "둘째 내용\n", expectedBeforeSha256: sha256("첫 내용\n") },
  ]);
  const first = applyWriteFile(op1, g1);
  assert.equal(first.marker, "applied");
  assert.equal(first.path, "docs/out.md");
  assert.equal(first.resultSha256, sha256("첫 내용\n"));
  assert.equal(first.exitCode, null);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(Object.keys(first).sort(), [...OPERATION_RECEIPT_KEYS].sort());
  assert.equal(readFileSync(join(f.ws, "docs/out.md"), "utf8"), "첫 내용\n");

  // **교체는 예방 안전하게 만들 수 없다**(3A 2차 리비전 A3): Node 18에는 디스크립터 상대
  // compare-and-publish가 없어 최종 pathname `rename(2)` 직전 창을 0으로 만들 수 없다.
  // 그래서 사후 탐지가 아니라 **temp를 만들기도 전에** 안정 코드로 거부한다.
  assert.equal(codeOf(() => applyWriteFile(op2, g2)), "write_replace_unsupported");
  assert.equal(readFileSync(join(f.ws, "docs/out.md"), "utf8"), "첫 내용\n", "거부인데 바이트가 바뀌었다");
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), [], "거부 전에 temp가 만들어졌다");
  assert.deepEqual(readdirSync(join(f.ws, "docs")), ["out.md"]);
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

test("[M5c] 영수증에는 내용이 들어가지 않는다", () => {
  const f = fixture();
  const SENTINEL = "SENTINEL-SECRET-CONTENT-9f2a";
  const receipt = applyWriteFile(...writePermit(f, { content: `${SENTINEL}\n` }));
  assert.equal(JSON.stringify(receipt).includes(SENTINEL), false, "영수증에 파일 내용이 들어갔다");
  assert.deepEqual(Object.keys(receipt).sort(), [...OPERATION_RECEIPT_KEYS].sort());
  // 거부 경로의 오류 메시지에도 내용·절대 경로가 없다.
  try {
    applyWriteFile(...writePermit(f, { authorityId: "w-unknown", content: `${SENTINEL}\n` }));
    assert.fail("거부되지 않았다");
  } catch (e) {
    const message = String((e as Error).message);
    assert.equal(message.includes(SENTINEL), false, "오류 메시지에 파일 내용이 들어갔다");
    assert.equal(message.includes(f.ws), false, "오류 메시지에 절대 경로가 들어갔다");
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

test("[M5c] 부재 대상은 경쟁적으로 생긴 파일을 덮어쓰지 않는다(원자적 no-replace 발행)", () => {
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  const [op, permit] = writePermit(f, { content: "우리 내용", expectedBeforeSha256: null });

  // 발행 **직전에** 경쟁자가 같은 이름을 만든다 → `link(2)`는 EEXIST다.
  const code = withSeams({ publish: () => writeFileSync(target, "경쟁자 내용") }, () => codeOf(() => applyWriteFile(op, permit)));
  assert.equal(code, "write_failed");
  assert.equal(readFileSync(target, "utf8"), "경쟁자 내용", "경쟁자의 바이트를 덮어썼다");
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), [], "temp 잔재가 남았다");
});

test("[M5c] A3: 기존 대상 교체는 temp를 만들기 전에 거부되고 경쟁자 바이트는 그대로다", () => {
  // **예방**이 계약이다: 1차 판은 temp를 쓰고 `rename(2)` 직전 검사에 기대 사후 탐지를 했다 — 그 검사와
  // syscall 사이의 창에서 경쟁자 바이트가 파괴될 수 있었다. 지금은 그 창에 도달하지 않는다.
  const f = fixture();
  const target = join(f.ws, "docs/out.md");
  writeFileSync(target, "원래 내용");
  const [op, grant] = writePermit(f, { content: "우리 내용", expectedBeforeSha256: sha256("원래 내용") });
  const inoBefore = lstatSync(target).ino;

  // 발행 단계 seam이 **아예 실행되지 않는다** — 거부가 그보다 앞이기 때문이다.
  let publishSeamRan = false;
  let tempSeamRan = false;
  const code = withSeams(
    { tempCreate: () => { tempSeamRan = true; }, publish: () => { publishSeamRan = true; } },
    () => codeOf(() => applyWriteFile(op, grant)),
  );
  assert.equal(code, "write_replace_unsupported");
  assert.equal(tempSeamRan, false, "거부 전에 temp 생성 단계에 도달했다");
  assert.equal(publishSeamRan, false, "거부 전에 발행 단계에 도달했다");
  assert.equal(readFileSync(target, "utf8"), "원래 내용", "경쟁자/기존 바이트가 바뀌었다");
  assert.equal(lstatSync(target).ino, inoBefore);
  assert.deepEqual(orphanTemps(join(f.ws, "docs")), [], "temp 잔재가 남았다");
  assert.ok(TYPED_EXECUTION_CODES.includes("write_replace_unsupported"));
});

test("[M5c] 부모 디렉터리가 symlink로 교체되면 발행하지 않는다(workspace 밖으로 쓰지 않는다)", () => {
  const outside = mkdtempSync(join(tmpdir(), "m5c-outside-"));
  workspaces.push(outside);
  const f = fixture();
  const docs = join(f.ws, "docs");
  const [op, permit] = writePermit(f, { content: "우리 내용" });

  const code = withSeams(
    {
      publish: () => {
        // temp는 이미 진짜 docs/ 안에 있다. 이제 부모 **이름**을 밖을 가리키는 symlink로 바꾼다.
        rmSync(join(f.ws, "docs-real"), { recursive: true, force: true });
        renameSync(docs, join(f.ws, "docs-real"));
        symlinkSync(outside, docs);
      },
    },
    () => codeOf(() => applyWriteFile(op, permit)),
  );
  assert.equal(code, "write_path_symlink");
  assert.deepEqual(readdirSync(outside), [], "workspace 밖에 파일이 생겼다");
  assert.equal(lstatSync(join(f.ws, "docs-real/out.md"), { throwIfNoEntry: false }), undefined, "대상이 발행됐다");
  // **B1: 승인된 내용이 고아 plaintext temp로 남지 않는다.** 정리도 경로 이름으로만 할 수 있으므로
  // (Node 18에 `unlinkat` 없음) 부모 **이름**이 교체된 이 경우에는 우리 temp를 지울 수 없다 — 남의 파일을
  // 지우지 않는 쪽이 맞다. 대신 **우리가 들고 있는 fd로 `ftruncate(0)`** 해서 남는 파일이 비게 만든다.
  const left = orphanTemps(join(f.ws, "docs-real"));
  assert.equal(left.length, 1, "temp 처리 계약이 바뀌었다");
  const leftPath = join(f.ws, "docs-real", left[0]);
  assert.equal(readFileSync(leftPath, "utf8"), "", "승인된 내용이 고아 temp로 노출됐다");
  assert.equal(lstatSync(leftPath).size, 0);
  assert.equal(lstatSync(leftPath).mode & 0o777, 0o600);
  // 이름이 operation 신원에서 파생돼 **안전하게 귀속**된다(정합화 sweep이 대조할 수 있다).
  assert.match(left[0], /^\.m5c-op-[0-9a-f]{16}-[0-9a-f]{24}\.tmp$/);
});

test("[M5c] temp 경로가 다른 파일로 교체되면 발행하지 않는다", () => {
  const f = fixture();
  const docs = join(f.ws, "docs");
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  // 경쟁자가 소유한 temp 이름(우리 것과 신원이 다르다) — 발행 직전에 우리 temp 이름을 가로챈다.
  let hijacked = false;
  const code = withSeams(
    {
      publish: () => {
        const ours = orphanTemps(docs)[0];
        if (ours === undefined) return;
        unlinkSync(join(docs, ours));
        writeFileSync(join(docs, ours), "경쟁자 temp");
        hijacked = true;
      },
    },
    () => codeOf(() => applyWriteFile(op, grant)),
  );
  assert.equal(hijacked, true, "temp 가로채기가 실제로 일어나지 않았다");
  assert.equal(code, "write_failed");
  assert.equal(lstatSync(join(f.ws, "docs/out.md"), { throwIfNoEntry: false }), undefined, "대상이 발행됐다");
  // **남의 temp는 지우지 않는다** — 신원이 우리 것이 아니기 때문이다.
  const left = orphanTemps(docs);
  assert.equal(left.length, 1);
  assert.equal(readFileSync(join(docs, left[0]), "utf8"), "경쟁자 temp", "남의 temp를 지웠다");
});

test("[M5c] 모든 실패 경계가 안정 코드로 접히고 fd·temp를 남기지 않는다", () => {
  const seams: PublicationSeam[] = ["parentWalk", "targetOpen", "tempCreate", "tempWrite", "tempVerify", "publish", "postVerify"];
  for (const name of seams) {
    const f = fixture();
    const [op, permit] = writePermit(f, { content: "우리 내용" });
    const code = withSeams(
      {
        [name]: () => {
          throw new Error(`주입 실패: ${name}`);
        },
      },
      () => codeOf(() => applyWriteFile(op, permit)),
    );
    assert.equal(code, "write_failed", name);
    assert.deepEqual(orphanTemps(join(f.ws, "docs")), [], `${name}에서 temp가 남았다`);
    // `postVerify`는 발행 뒤 단계이므로 대상이 남아 있을 수 있다 — 그 밖의 단계는 대상 자체가 없다.
    const target = lstatSync(join(f.ws, "docs/out.md"), { throwIfNoEntry: false });
    if (name !== "postVerify") assert.equal(target, undefined, `${name}에서 대상이 발행됐다`);
  }
  // **호출자 hook이 production taxonomy를 고를 수 없다**(3A 2차 리뷰 `C1`).
  // 이전에는 hook이 던진 `OrchestrationError`가 그대로 밖으로 나가 어떤 코드든 고를 수 있었다.
  const f = fixture();
  const [op, grant] = writePermit(f);
  const code = withSeams(
    {
      tempWrite: () => {
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
  const target = join(f.ws, "docs/out.md");
  const [[op1, g1], [op2, g2], [op3, g3]] = writeGrants(f, [
    { content: "우리 내용" },
    { content: "우리 내용" },
    { content: "우리 내용" },
  ]);
  const failFsync = { dirFsync: () => { throw new Error("fsync 실패"); } };

  assert.equal(withSeams(failFsync, () => codeOf(() => applyWriteFile(op1, g1))), "write_durability_unconfirmed");
  // 바이트는 발행됐다(계약대로).
  assert.equal(readFileSync(target, "utf8"), "우리 내용");

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

test("[M5c] B1: 실제 close/unlink 실패는 성공이 되지 않고 안정 코드로 올라온다", () => {
  // ⓐ **진짜 unlink 실패**: 부모 디렉터리에서 쓰기 권한을 뺀다(주입 seam이 아니라 OS 오류다).
  {
    const f = fixture();
    const docs = join(f.ws, "docs");
    const [op, grant] = writePermit(f, { content: "우리 내용" });
    let mode = 0;
    const code = withSeams(
      { postVerify: () => { mode = lstatSync(docs).mode & 0o777; chmodSync(docs, 0o500); } },
      () => codeOf(() => applyWriteFile(op, grant)),
    );
    chmodSync(docs, mode);
    assert.equal(code, "write_cleanup_unconfirmed", "정리 실패가 성공으로 삼켜졌다");
    // 발행된 바이트는 그대로다(정리만 미확인) → 재시도는 already_applied로 수렴한다.
    assert.equal(readFileSync(join(docs, "out.md"), "utf8"), "우리 내용");
    assert.ok(TYPED_EXECUTION_CODES.includes("write_cleanup_unconfirmed"));
  }
  // ⓑ **진짜 close 실패**: 집행기가 들고 있는 temp fd를 밖에서 먼저 닫으면 반납이 EBADF다.
  //    fd는 번호로 찍는 것이 아니라 **(dev,ino)가 방금 발행된 파일과 같은 디스크립터**로 찾는다
  //    (`link(2)` 뒤 temp와 대상은 같은 inode다). durability는 정상 확인되므로 **정리 실패만** 남는다.
  {
    const f = fixture();
    const docs = join(f.ws, "docs");
    const [op, grant] = writePermit(f, { content: "우리 내용" });
    let closed = 0;
    const code = withSeams(
      {
        postVerify: () => {
          const published = lstatSync(join(docs, "out.md"));
          for (let fd = 3; fd < 256; fd++) {
            try {
              const st = fstatSync(fd);
              if (st.isFile() && st.dev === published.dev && st.ino === published.ino) {
                closeSync(fd);
                closed++;
              }
            } catch { /* 우리 것이 아니거나 이미 닫혔다 */ }
          }
        },
      },
      () => codeOf(() => applyWriteFile(op, grant)),
    );
    assert.equal(closed, 1, "집행기의 temp fd를 찾지 못했다(테스트 전제가 깨졌다)");
    assert.equal(code, "write_cleanup_unconfirmed", "close 실패가 성공으로 삼켜졌다");
    // 발행된 바이트는 그대로다 — 정리만 미확인이다.
    assert.equal(readFileSync(join(docs, "out.md"), "utf8"), "우리 내용");
  }
});

// ── 7b. 영수증 provenance와 재시작 정합화 (3A 2차 리비전 A2) ─────────────────

test("[M5c] A2: 위조·재생·치환·재사용 영수증과 '효과 없는 성공'이 전부 fail closed다", () => {
  const f = fixture();
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  const receipt = applyWriteFile(op, grant);
  assert.equal(receipt.marker, "applied");

  // ⓐ **구조적 위조**: grant 없이 영수증만 만들어 낼 통로가 없다.
  for (const forged of [null, undefined, {}, { ...grant }, Object.freeze({ ...grant }), new Proxy(grant, {})]) {
    assert.equal(
      codeOf(() => f.kernel.recordOperationReceipt({ grant: forged, actionId: nextId("act"), receipt })),
      "dispatch_grant_invalid",
    );
  }
  // ⓑ **operation 치환**: grant에 묶인 operation과 다른 신원의 영수증은 거부다.
  for (const swap of [{ operationId: "op-other" }, { authorityId: "w-small" }, { kind: "run_process" as const }]) {
    assert.equal(
      codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: { ...receipt, ...swap } })),
      "invalid_receipt",
    );
  }
  // ⓒ 진짜 짝은 정확히 한 번 커밋된다.
  const task = f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt });
  assert.equal(task.execution.operationReceipts.length, 1);
  assert.equal(task.execution.operationReceipts[0].marker, "applied");
  assert.equal(task.execution.pendingOperations.length, 0, "영수증이 pending을 닫지 않았다");
  // 커밋 시각은 **kernel clock**이다(호출자 시각을 durable로 쓰지 않는다).
  assert.notEqual(task.execution.operationReceipts[0].at, receipt.at);

  // ⓓ **grant 재사용**: 같은 grant로 두 번 커밋할 수 없다.
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt })), "dispatch_grant_spent");
  // ⓔ **중복 집행**: 소진된 grant로는 효과도 낼 수 없다.
  assert.equal(codeOf(() => applyWriteFile(op, grant)), "dispatch_grant_spent");
  // ⓕ 이미 기록된 operation은 다시 열 수 없다.
  const permit = f.kernel.getTask("root")!.execution.dispatchTurnId;
  assert.equal(permit, "turn-1");
  assert.equal(readFileSync(join(f.ws, "docs/out.md"), "utf8"), "우리 내용");
});

test("[M5c] A2: 영수증이 커밋된 뒤에는 살아 있던 두 번째 grant로도 다시 집행할 수 없다", () => {
  // 이 테스트가 감시하는 seam은 효과 게이트의 **durable pending 레코드 확인**이다(`requirePendingOperation`).
  // 그 확인을 지우면 permit·attempt·turn이 전부 유효한 채로 **같은 operation을 두 번 집행**할 수 있다.
  const f = fixture();
  const permit = permitFor(f.kernel, "root", [writeOp({ content: "우리 내용" })]);
  const op = permit.plan.operations[0] as TypedWriteFileOperation;
  const g1 = grantFor(f.kernel, permit, op.operationId);
  const g2 = grantFor(f.kernel, permit, op.operationId); // 정합화용 두 번째 grant(같은 pending 레코드)
  assert.notEqual(g1, g2);
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 1, "pending이 중복 등록됐다");

  const receipt = applyWriteFile(op, g1);
  assert.equal(receipt.marker, "applied");
  f.kernel.recordOperationReceipt({ grant: g1, actionId: nextId("act"), receipt });
  assert.equal(f.kernel.getTask("root")!.execution.pendingOperations.length, 0);

  // **아직 소진되지 않은** g2다: permit·attempt·turn·계획이 전부 유효하다. 막는 것은 pending 확인뿐이다.
  assert.equal(codeOf(() => applyWriteFile(op, g2)), "dispatch_operation_unregistered");
  assert.equal(codeOf(() => f.kernel.recordOperationReceipt({ grant: g2, actionId: nextId("act"), receipt })), "invalid_receipt");
  assert.deepEqual(f.kernel.getTask("root")!.execution.operationReceipts.map((r) => r.operationId), ["op-1"]);
});

test("[M5c] A2: 집행 게이트를 지나지 않은 grant는 성공 marker를 만들어낼 수 없다", () => {
  const f = fixture();
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  // 효과를 **한 번도 시도하지 않은** grant로 `applied`를 주장한다 → 거부.
  for (const marker of ["applied", "already_applied", "write_conflict"] as const) {
    assert.equal(
      codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: rec(op, marker, "docs/out.md", sha256("우리 내용")) })),
      "invalid_receipt",
      marker,
    );
  }
  assert.equal(lstatSync(join(f.ws, "docs/out.md"), { throwIfNoEntry: false }), undefined, "거부 경로가 파일을 만들었다");
  // 실패 marker로는 닫을 수 있다(집행을 포기한 operation의 정합화 경로).
  const task = f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: rec(op, "denied") });
  assert.equal(task.execution.pendingOperations.length, 0);
  assert.equal(task.execution.operationReceipts[0].marker, "denied");
});

test("[M5c] A2: 효과가 났는데 결과 전이가 없으면 turn도 task도 닫히지 않는다", () => {
  const f = fixture();
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  assert.equal(applyWriteFile(op, grant).marker, "applied");
  const pending = f.kernel.getTask("root")!.execution.pendingOperations;
  assert.equal(pending.length, 1, "집행 전 durable 등록이 없다");
  assert.deepEqual(
    { operationId: pending[0].operationId, kind: pending[0].kind, turnId: pending[0].turnId, attemptId: pending[0].attemptId },
    { operationId: "op-1", kind: "write_file", turnId: "turn-1", attemptId: f.kernel.getTask("root")!.execution.attemptId },
  );
  // turn을 닫을 수 없다.
  assert.equal(
    codeOf(() => f.kernel.chargeTurnUsage({ taskId: "root", actionId: nextId("act"), turnId: "turn-1", inputTokens: 1, outputTokens: 0, elapsedMs: 1 })),
    "operation_pending_unreconciled",
  );
  // task를 완료로 올릴 수도 없다(정리를 확인해도).
  const lease = f.kernel.getTask("root")!.execution.processLeaseMarker!;
  f.kernel.recordTerminal({
    taskId: "root",
    actionId: nextId("act"),
    marker: "turn_completed",
    pendingResult: { summary: "요약", outputs: [{ path: "docs/out.md", role: "output" }] },
  });
  f.kernel.confirmCleanup({ taskId: "root", actionId: nextId("act"), leaseMarker: lease });
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
});

test("[M5c] A2: 등록·발행·영수증 사이에서 재시작해도 중복 손상 없이 하나로 수렴한다", () => {
  const ws = makeWorkspace();
  const open = () => OrchestrationKernel.open({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0) });
  const k0 = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestObject(),
    clock: clockFrom(T0),
  });
  k0.createRootTask(seed("root", ["docs", "src"]));
  startNow(k0, "root");
  const plan = planFor(k0, "root", [writeOp({ content: "우리 내용" })]);

  // ① 등록만 하고 죽는다(효과 전).
  const p0 = k0.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
  k0.beginOperation({ permit: p0, operationId: "op-1", actionId: nextId("act") });
  assert.equal(lstatSync(join(ws, "docs/out.md"), { throwIfNoEntry: false }), undefined);

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
  assert.equal(r1.marker, "applied");
  const ino = lstatSync(join(ws, "docs/out.md")).ino;

  // ③ 영수증 커밋 **직전에** 다시 죽는다 → 또 재시작해 같은 operation을 다시 연다.
  const k2 = open();
  assert.deepEqual(k2.getTask("root")!.execution.pendingOperations.map((p) => p.operationId), ["op-1"]);
  const p2 = k2.issueOperationDispatchPermit({ taskId: "root", turnId: "turn-1", actionId: nextId("act"), plan });
  const g2 = k2.beginOperation({ permit: p2, operationId: "op-1", actionId: nextId("act") });
  const r2 = applyWriteFile(p2.plan.operations[0] as TypedWriteFileOperation, g2);
  // **중복 손상 없음**: 같은 바이트를 다시 쓰지 않았다(inode 불변).
  assert.equal(r2.marker, "already_applied");
  assert.equal(lstatSync(join(ws, "docs/out.md")).ino, ino);
  const task = k2.recordOperationReceipt({ grant: g2, actionId: nextId("act"), receipt: r2 });

  // ④ 정확히 하나의 결과로 수렴한다.
  assert.equal(task.execution.pendingOperations.length, 0);
  assert.deepEqual(task.execution.operationReceipts.map((r) => r.operationId), ["op-1"]);
  assert.equal(task.execution.operationReceipts[0].marker, "already_applied");
  // ⑤ 그리고 이제 turn을 닫을 수 있다.
  k2.chargeTurnUsage({ taskId: "root", actionId: nextId("act"), turnId: "turn-1", inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  assert.equal(k2.getTask("root")!.execution.dispatchTurnId, null);
  // ⑥ 재시작한 kernel이 다시 열어도 durable 사실은 같다(거짓 성공 없음).
  assert.deepEqual(open().getTask("root")!.execution.operationReceipts.map((r) => r.marker), ["already_applied"]);
  assert.deepEqual(orphanTemps(join(ws, "docs")), []);
});

test("[M5c] 적대적 객체·proxy·accessor는 lifecycle을 우회하거나 오류 taxonomy를 고를 수 없다", () => {
  const f = fixture();
  const [op, grant] = writePermit(f, { content: "우리 내용" });
  const throwing = { get operationId(): string { throw new OrchestrationError("already_applied", "내가 고른 코드"); } };
  // ⓐ 던지는 getter가 taxonomy를 고르지 못한다.
  assert.equal(
    codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: throwing as unknown as OperationReceipt })),
    "invalid_artifact_ref",
  );
  // ⓑ `ownKeys` trap을 쓰는 Proxy도 마찬가지다.
  const trapped = new Proxy({} as Record<string, unknown>, {
    ownKeys() {
      throw new OrchestrationError("applied", "내가 고른 코드");
    },
  });
  assert.equal(
    codeOf(() => f.kernel.recordOperationReceipt({ grant, actionId: nextId("act"), receipt: trapped as unknown as OperationReceipt })),
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

test("[M5c] 프로세스 실행 명세는 승인 레코드·durable 신원에서만 나오고 동결되며 아무것도 띄우지 않는다", () => {
  const f = fixture();
  const [op, grant] = processPermit(f);
  const spec = resolveProcessLaunchSpec(op, grant);
  assert.deepEqual({ ...spec, args: [...spec.args] }, {
    operationId: "op-2",
    authorityId: "p-node",
    runId: RUN_ID,
    taskId: "root",
    attemptId: grant.attemptId,
    turnId: "turn-1",
    executable: NODE_PATH,
    sha256: "e".repeat(64),
    entrypoint: ENTRYPOINT_PATH,
    entrypointSha256: "9".repeat(64),
    action: "validate-plan",
    // **argv는 파생된다**: [고정 entrypoint, 닫힌 action, ...데이터]. 승인 문서에 argv 필드가 없다.
    args: [ENTRYPOINT_PATH, "validate-plan", "docs/plan.json"],
    timeoutMs: 5_000,
  });
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.args), true);
  // 명세에는 callback·환경·cwd·shell이 **없다**(있으면 그 자체가 권한이다).
  assert.deepEqual(Object.keys(spec).sort(), [
    "action",
    "args",
    "attemptId",
    "authorityId",
    "entrypoint",
    "entrypointSha256",
    "executable",
    "operationId",
    "runId",
    "sha256",
    "taskId",
    "timeoutMs",
    "turnId",
  ]);
  for (const v of Object.values(spec)) assert.notEqual(typeof v, "function");
  // 승인된 node·entrypoint 경로는 이 테스트 환경에 **존재하지 않는다** — 그래도 성공한다 = spawn이 없다.
  assert.equal(lstatSync(NODE_PATH, { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(ENTRYPOINT_PATH, { throwIfNoEntry: false }), undefined);
  assert.deepEqual(readdirSync(join(f.ws, "docs")), []);
});

test("[M5c] B-10: run_process는 --eval·--require·임의 script/module·action 주입을 표현할 수 없다", () => {
  const bad = (over: Record<string, unknown>): string =>
    codeOf(() =>
      validateApprovalManifest(
        manifestObject({
          operationAuthorityByTask: { root: [{ authorityId: "p-x", kind: "run_process", action: "validate-plan", data: [], timeoutMs: 1000, ...over }] },
        }),
      ),
    );

  // ⓐ **코드 권위 인자는 데이터 자리에 들어갈 수 없다**(`-`로 시작하는 항목은 데이터가 아니다).
  for (const arg of ["--eval", "-e", "--require", "-r", "--input-type=module", "--experimental-vm-modules", "--import"]) {
    assert.equal(bad({ data: [arg] }), "operation_data_not_approved", arg);
  }
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
  // ⓓ NUL·고립 surrogate·상한 초과 데이터도 거부다(정확한 바이트 왕복 보존).
  assert.equal(bad({ data: ["a\0b"] }), "operation_data_not_approved");
  assert.equal(bad({ data: ["\ud800"] }), "operation_data_not_approved");
  assert.equal(bad({ data: ["x".repeat(257)] }), "operation_data_not_approved");
  assert.equal(bad({ data: Array.from({ length: 17 }, (_, i) => `d${i}`) }), "invalid_manifest");
  // ⓔ **고정 entrypoint는 manifest 하나에서만 온다**: 없으면 v1로 보고 fail closed다.
  const { controllerEntrypoint: _drop, ...noEntry } = EXECUTION_AUTHORITY;
  assert.equal(
    codeOf(() => validateApprovalManifest(manifestObject({ executionAuthority: noEntry }))),
    "manifest_pre_m5c_unsupported",
  );
  // ⓕ digest는 실행 경계가 다시 확인할 수 있도록 명세에 실린다(경로 drift = 다른 digest).
  const f = fixture();
  const [op, grant] = processPermit(f);
  const spec = resolveProcessLaunchSpec(op, grant);
  assert.equal(spec.entrypointSha256, EXECUTION_AUTHORITY.controllerEntrypoint.sha256);
  assert.equal(spec.sha256, EXECUTION_AUTHORITY.node.sha256);
  // ⓖ **이 리비전 전체의 spawn 수는 0이다**: 승인된 실행 파일이 존재하지도 않는데 명세가 나온다.
  assert.equal(lstatSync(spec.executable, { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(spec.entrypoint, { throwIfNoEntry: false }), undefined);
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

test("[M5c] typed_execution_plan.schema.json이 런타임 계약과 동치다", () => {
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
