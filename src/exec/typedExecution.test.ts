/**
 * V3 M5c — **typed 실행 계획 validator + controller 소유 권위 해석·집행** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/typedExecution.test.ts`
 * 네트워크·LLM·provider·프로세스 spawn 없이 임시 workspace에서만 돈다(무과금).
 *
 * 이 파일이 덮는 계약:
 * - 계획은 **닫힌 데이터**다: 미상/누락/중첩 여분 key · getter/proxy/throw/순환/함수/symbol · 중복 id ·
 *   binding 불일치 · 버전 · 상한 · Unicode/경로/바이트 경계가 전부 `plan_invalid`다.
 * - 권위는 **deny-by-default**다: 부재 · 다른 task · kind 불일치 · sibling 소유 · writableRoots 탈출 ·
 *   traversal · 부모/대상 symlink · 비일반 파일 · 바이트 초과.
 * - 쓰기는 **원자적**이고 크래시 창에서 멱등하며(`already_applied`) 충돌은 바이트를 바꾸지 않는다.
 * - 프로세스는 **명세만** 나온다(spawn 0) — 실행 파일·argv·timeout은 승인 레코드에서만 온다.
 * - JSON Schema와 런타임이 **동치**다(draft-07 maxLength = 코드 포인트 — 대장 `C-40`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARTIFACT_ROLES,
  LIMITS,
  OrchestrationError,
  SHA256_PATTERN,
  SLUG_PATTERN,
  TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
  type MilestoneApprovalManifest,
} from "./orchestrationTypes.js";
import { OPERATION_RECEIPT_KEYS } from "./orchestrationStore.js";
import { RUN_PROCESS_AUTHORITY_KEYS, WRITE_FILE_AUTHORITY_KEYS, validateApprovalManifest } from "./approvalManifest.js";
import {
  NORMALIZED_WORKSPACE_PATH_PATTERN,
  RUN_PROCESS_OPERATION_KEYS,
  TYPED_PLAN_KEYS,
  TYPED_PLAN_OUTPUT_KEYS,
  TYPED_PLAN_RESULT_KEYS,
  WINDOWS_DRIVE_PATTERN,
  WRITE_FILE_OPERATION_KEYS,
  applyWriteFile,
  resolveProcessLaunchSpec,
  resolveWriteFileAuthority,
  validateTypedExecutionPlan,
  type OperationDispatchContext,
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

const NOW = "2026-07-30T00:00:00.000Z";
const NODE_PATH = "/opt/harness/node";
const BINDING = { runId: "run-1", taskId: "root", attemptId: "att-1", turnId: "turn-1" };

const EXECUTION_AUTHORITY = {
  codex: null,
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
    { authorityId: "p-node", kind: "run_process", executable: NODE_PATH, args: ["--version"], timeoutMs: 5_000 },
  ],
  sibling: [{ authorityId: "w-sib", kind: "write_file", path: "docs/sib.md", maxBytes: 1024 }],
  // manifest.ownershipByTask에 **없는** child — 소유 판정은 dispatch 시점 durable ownership이 한다.
  "root.child": [{ authorityId: "w-child", kind: "write_file", path: "docs/child.md", maxBytes: 1024 }],
};

function approvedManifest(over: Record<string, unknown> = {}): MilestoneApprovalManifest {
  return validateApprovalManifest({
    milestoneId: "m5c",
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
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...over,
  });
}

function ctxFor(
  workspaceRoot: string,
  over: Partial<OperationDispatchContext> = {},
): OperationDispatchContext {
  return {
    workspaceRoot,
    manifest: approvedManifest(),
    taskId: "root",
    ownership: ["docs", "src"],
    nowIso: NOW,
    ...over,
  };
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

/** 계획 안의 operation 하나를 typed 값으로 꺼낸다(테스트가 dispatch에 넘길 입력). */
function adoptedWrite(over: Record<string, unknown> = {}): TypedWriteFileOperation {
  const plan = validateTypedExecutionPlan(planObject({ operations: [writeOp(over)] }), BINDING);
  return plan.operations[0] as TypedWriteFileOperation;
}

function adoptedProcess(over: Record<string, unknown> = {}): TypedRunProcessOperation {
  const plan = validateTypedExecutionPlan(planObject({ operations: [processOp(over)] }), BINDING);
  return plan.operations[0] as TypedRunProcessOperation;
}

/** `.m5c-write-*` 임시 파일 잔재. 어떤 경로에서도 0이어야 한다. */
function orphanTemps(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(".m5c-write-"));
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

test("[M5c] getter·proxy·throw·순환·함수·symbol·이질 prototype은 권위를 밀반입할 수 없다", () => {
  // ⓐ property는 **정확히 한 번** 읽힌다 — 교대 getter는 두 번째 값을 반영하지 못한다.
  let reads = 0;
  const alternating = {
    ...writeOp(),
    get path() {
      reads += 1;
      return reads === 1 ? "docs/out.md" : "docs/evil.md";
    },
  };
  const adopted = validateTypedExecutionPlan(planObject({ operations: [alternating] }), BINDING);
  assert.equal(reads, 1, "path를 두 번 이상 읽었다");
  assert.equal((adopted.operations[0] as TypedWriteFileOperation).path, "docs/out.md");

  // ⓑ 교대 getter가 kind를 바꿔 다른 갈래로 새지 못한다 — 갈래는 **key 집합**이 정하고 `kind` 값도
  //    정확히 한 번만 읽히므로, 두 번째 값("run_process")은 어디에도 반영되지 않는다.
  let kindReads = 0;
  const kindSwap = {
    ...writeOp(),
    get kind() {
      kindReads += 1;
      return kindReads === 1 ? "write_file" : "run_process";
    },
  };
  const swapped = validateTypedExecutionPlan(planObject({ operations: [kindSwap] }), BINDING);
  assert.equal(kindReads, 1, "kind를 두 번 이상 읽었다");
  assert.equal(swapped.operations[0].kind, "write_file");
  assert.deepEqual(Object.keys(swapped.operations[0]).sort(), [...WRITE_FILE_OPERATION_KEYS].sort());
  // 반대로 **key 집합과 값이 어긋나면** 거부다(run_process key 집합에 write_file kind).
  assert.equal(
    codeOf(() => validateTypedExecutionPlan(planObject({ operations: [processOp({ kind: "write_file" })] }), BINDING)),
    "plan_invalid",
  );

  // ⓒ 던지는 getter는 **호출자가 고른 코드**가 아니라 안정 코드로 접힌다(대장 `C-38`).
  const hostileGetter = {
    ...writeOp(),
    get content(): string {
      throw new OrchestrationError("artifact_missing", "호출자가 고른 코드");
    },
  };
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject({ operations: [hostileGetter] }), BINDING)), "plan_invalid");

  // ⓓ 모든 접근을 가로채는 proxy.
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

  // ⓔ 함수·symbol key·이질 prototype·순환.
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
  // controller가 준 binding 자체가 계약 밖이면 그것도 거부다.
  assert.equal(codeOf(() => validateTypedExecutionPlan(planObject(), { ...BINDING, turnId: "" })), "plan_invalid");
});

test("[M5c] 중복 operationId는 거부한다", () => {
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

// ── 4. 권위 해석 (deny-by-default) ──────────────────────────────────────────

test("[M5c] 승인이 없거나 task·kind가 다르면 거부한다(deny-by-default)", () => {
  const ws = makeWorkspace();
  const op = adoptedWrite();

  // 없는 authorityId.
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite({ authorityId: "w-unknown" }), ctxFor(ws))), "operation_denied");
  // 다른 task의 authorityId(형제 소유 권위를 빌릴 수 없다).
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite({ authorityId: "w-sib" }), ctxFor(ws))), "operation_denied");
  // 권위 목록에 아예 없는 task.
  assert.equal(codeOf(() => applyWriteFile(op, ctxFor(ws, { taskId: "unlisted" }))), "operation_denied");
  // kind 불일치: write authority를 process로 쓰려 한다(그 반대도).
  assert.equal(codeOf(() => resolveProcessLaunchSpec(adoptedProcess({ authorityId: "w-doc" }), ctxFor(ws))), "operation_denied");
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite({ authorityId: "p-node" }), ctxFor(ws))), "operation_denied");
  // 어떤 거부 경로도 파일을 만들지 않는다.
  assert.deepEqual(readdirSync(join(ws, "docs")), []);
});

test("[M5c] MUTATION-GUARD: 권위 대조를 건너뛰면 거부가 사라진다", () => {
  // 이 테스트가 감시하는 seam은 `typedExecution.resolveApprovedOperation`의 `null` 검사다.
  // mutation(그 검사를 지우고 합성 authority 반환)을 넣으면 아래 두 단정이 반드시 깨져야 한다.
  const ws = makeWorkspace();
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite({ authorityId: "w-unknown" }), ctxFor(ws))), "operation_denied");
  assert.equal(codeOf(() => resolveWriteFileAuthority(adoptedWrite({ authorityId: "w-unknown" }), ctxFor(ws))), "operation_denied");
  assert.equal(readdirSync(join(ws, "docs")).length, 0, "거부된 operation이 파일을 남겼다");
});

test("[M5c] 소유와 writableRoots는 dispatch 시점에 다시 본다", () => {
  const ws = makeWorkspace();
  // ⓐ 승인은 있지만 durable ownership이 좁아졌다(형제 경로 침범 방지).
  assert.equal(
    codeOf(() => applyWriteFile(adoptedWrite(), ctxFor(ws, { ownership: ["docs/other"] }))),
    "operation_not_owned",
  );
  // ⓑ child durable ownership은 manifest ownershipByTask에 없어도 존중된다.
  const childOp = adoptedWrite({ operationId: "op-c", authorityId: "w-child", path: "docs/child.md" });
  const receipt = applyWriteFile(childOp, ctxFor(ws, { taskId: "root.child", ownership: ["docs/child.md"] }));
  assert.equal(receipt.marker, "applied");
  assert.equal(readFileSync(join(ws, "docs/child.md"), "utf8"), "hello");
  // ⓒ writableRoots 탈출은 승인 문서가 그렇게 말해도 거부다(손으로 만든 manifest로 재검사면을 증명한다).
  const forged = {
    ...approvedManifest(),
    writableRoots: ["src"],
  } as MilestoneApprovalManifest;
  assert.equal(
    codeOf(() => applyWriteFile(adoptedWrite(), ctxFor(ws, { manifest: forged }))),
    "operation_outside_writable_root",
  );
  // ⓓ 승인된 경로와 **정확히** 같지 않으면 거부다.
  const shifted = {
    ...approvedManifest(),
    operationAuthorityByTask: {
      ...approvedManifest().operationAuthorityByTask,
      root: [{ authorityId: "w-doc", kind: "write_file" as const, path: "docs/other.md", maxBytes: 1024 }],
    },
  } as MilestoneApprovalManifest;
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite(), ctxFor(ws, { manifest: shifted }))), "operation_denied");
  assert.deepEqual(orphanTemps(join(ws, "docs")), []);
});

// ── 5. write_file 집행 ──────────────────────────────────────────────────────

test("[M5c] 성공적인 원자적 쓰기와 교체", () => {
  const ws = makeWorkspace();
  const first = applyWriteFile(adoptedWrite({ content: "첫 내용\n" }), ctxFor(ws));
  assert.equal(first.marker, "applied");
  assert.equal(first.path, "docs/out.md");
  assert.equal(first.resultSha256, sha256("첫 내용\n"));
  assert.equal(first.exitCode, null);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(Object.keys(first).sort(), [...OPERATION_RECEIPT_KEYS].sort());
  assert.equal(readFileSync(join(ws, "docs/out.md"), "utf8"), "첫 내용\n");

  // 교체 — 기대 preimage를 정확히 주면 통과한다.
  const second = applyWriteFile(
    adoptedWrite({ operationId: "op-2", content: "둘째 내용\n", expectedBeforeSha256: sha256("첫 내용\n") }),
    ctxFor(ws),
  );
  assert.equal(second.marker, "applied");
  assert.equal(readFileSync(join(ws, "docs/out.md"), "utf8"), "둘째 내용\n");
  assert.deepEqual(orphanTemps(join(ws, "docs")), []);
});

test("[M5c] 크래시 창 멱등: 이미 의도한 내용이면 already_applied이고 다시 쓰지 않는다", () => {
  const ws = makeWorkspace();
  const target = join(ws, "docs/out.md");
  // 영수증이 durable해지기 **전에** 죽은 상황을 재현한다: 바이트는 이미 발행됐다.
  writeFileSync(target, "hello");
  const inoBefore = lstatSync(target).ino;

  const again = applyWriteFile(adoptedWrite({ content: "hello" }), ctxFor(ws));
  assert.equal(again.marker, "already_applied");
  assert.equal(again.resultSha256, sha256("hello"));
  assert.equal(lstatSync(target).ino, inoBefore, "같은 바이트를 다시 써서 inode가 바뀌었다");
  assert.deepEqual(orphanTemps(join(ws, "docs")), []);
});

test("[M5c] preimage 불일치는 쓰지 않고 write_conflict다", () => {
  const ws = makeWorkspace();
  const target = join(ws, "docs/out.md");

  // ⓐ 없어야 한다고 했는데 있다.
  writeFileSync(target, "남의 내용");
  const inoBefore = lstatSync(target).ino;
  const conflict = applyWriteFile(adoptedWrite({ content: "새 내용", expectedBeforeSha256: null }), ctxFor(ws));
  assert.equal(conflict.marker, "write_conflict");
  assert.equal(conflict.resultSha256, null);
  assert.equal(readFileSync(target, "utf8"), "남의 내용", "충돌인데 바이트가 바뀌었다");
  assert.equal(lstatSync(target).ino, inoBefore);

  // ⓑ 기대한 preimage와 다르다.
  const mismatch = applyWriteFile(
    adoptedWrite({ operationId: "op-2", content: "새 내용", expectedBeforeSha256: sha256("다른 preimage") }),
    ctxFor(ws),
  );
  assert.equal(mismatch.marker, "write_conflict");
  assert.equal(readFileSync(target, "utf8"), "남의 내용");

  // ⓒ 있어야 한다고 했는데 없다.
  const absent = applyWriteFile(
    adoptedWrite({ operationId: "op-3", authorityId: "w-small", path: "docs/small.md", content: "x", expectedBeforeSha256: sha256("무엇") }),
    ctxFor(ws),
  );
  assert.equal(absent.marker, "write_conflict");
  assert.equal(lstatSync(join(ws, "docs/small.md"), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(orphanTemps(join(ws, "docs")), []);
});

test("[M5c] symlink·비일반 파일·바이트 초과는 집행하지 않는다", () => {
  const ws = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "m5c-outside-"));
  workspaces.push(outside);
  writeFileSync(join(outside, "target.md"), "밖의 파일");

  // ⓐ 대상이 symlink다(workspace 밖을 가리킨다).
  symlinkSync(join(outside, "target.md"), join(ws, "docs/out.md"));
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite(), ctxFor(ws))), "write_path_symlink");
  assert.equal(readFileSync(join(outside, "target.md"), "utf8"), "밖의 파일", "symlink를 따라가 밖을 덮어썼다");

  // ⓑ 부모 구성요소가 symlink다.
  const ws2 = makeWorkspace();
  mkdirSync(join(ws2, "real"));
  symlinkSync(join(ws2, "real"), join(ws2, "src/linked"));
  const linkedManifest = {
    ...approvedManifest(),
    operationAuthorityByTask: {
      root: [{ authorityId: "w-doc", kind: "write_file" as const, path: "src/linked/a.md", maxBytes: 1024 }],
    },
  } as MilestoneApprovalManifest;
  assert.equal(
    codeOf(() => applyWriteFile(adoptedWrite({ path: "src/linked/a.md" }), ctxFor(ws2, { manifest: linkedManifest }))),
    "write_path_symlink",
  );
  assert.deepEqual(readdirSync(join(ws2, "real")), []);

  // ⓒ 대상이 디렉터리다.
  const ws3 = makeWorkspace();
  mkdirSync(join(ws3, "docs/out.md"));
  assert.equal(codeOf(() => applyWriteFile(adoptedWrite(), ctxFor(ws3))), "write_target_not_regular");

  // ⓓ 부모 디렉터리가 없다(디렉터리를 만들지 않는다).
  const ws4 = makeWorkspace();
  const deepManifest = {
    ...approvedManifest(),
    operationAuthorityByTask: {
      root: [{ authorityId: "w-doc", kind: "write_file" as const, path: "docs/nested/a.md", maxBytes: 1024 }],
    },
  } as MilestoneApprovalManifest;
  assert.equal(
    codeOf(() => applyWriteFile(adoptedWrite({ path: "docs/nested/a.md" }), ctxFor(ws4, { manifest: deepManifest }))),
    "write_failed",
  );
  assert.equal(lstatSync(join(ws4, "docs/nested"), { throwIfNoEntry: false }), undefined);

  // ⓔ 승인된 바이트 상한(8)을 넘는 본문.
  const ws5 = makeWorkspace();
  assert.equal(
    codeOf(() =>
      applyWriteFile(adoptedWrite({ authorityId: "w-small", path: "docs/small.md", content: "0123456789" }), ctxFor(ws5)),
    ),
    "write_bytes_exceeded",
  );
  assert.equal(lstatSync(join(ws5, "docs/small.md"), { throwIfNoEntry: false }), undefined);
  for (const dir of [join(ws, "docs"), join(ws2, "src"), join(ws3, "docs"), join(ws4, "docs"), join(ws5, "docs")]) {
    assert.deepEqual(orphanTemps(dir), [], dir);
  }
});

test("[M5c] 영수증에는 내용이 들어가지 않는다", () => {
  const ws = makeWorkspace();
  const SENTINEL = "SENTINEL-SECRET-CONTENT-9f2a";
  const receipt = applyWriteFile(adoptedWrite({ content: `${SENTINEL}\n` }), ctxFor(ws));
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(SENTINEL), false, "영수증에 파일 내용이 들어갔다");
  assert.deepEqual(Object.keys(receipt).sort(), [...OPERATION_RECEIPT_KEYS].sort());
  // 거부 경로의 오류 메시지에도 내용이 없다.
  try {
    applyWriteFile(adoptedWrite({ authorityId: "w-unknown", content: `${SENTINEL}\n` }), ctxFor(ws));
    assert.fail("거부되지 않았다");
  } catch (e) {
    assert.equal(String((e as Error).message).includes(SENTINEL), false, "오류 메시지에 파일 내용이 들어갔다");
  }
});

// ── 6. run_process 명세 (spawn 0) ───────────────────────────────────────────

test("[M5c] 프로세스 실행 명세는 승인 레코드에서만 나오고 동결되며 아무것도 띄우지 않는다", () => {
  const ws = makeWorkspace();
  const spec = resolveProcessLaunchSpec(adoptedProcess(), ctxFor(ws));
  assert.deepEqual({ ...spec, args: [...spec.args] }, {
    operationId: "op-2",
    authorityId: "p-node",
    executable: NODE_PATH,
    sha256: "e".repeat(64),
    args: ["--version"],
    timeoutMs: 5_000,
  });
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.args), true);
  // 명세에는 callback·환경·cwd·shell이 **없다**(있으면 그 자체가 권한이다).
  assert.deepEqual(Object.keys(spec).sort(), ["args", "authorityId", "executable", "operationId", "sha256", "timeoutMs"]);
  for (const v of Object.values(spec)) assert.notEqual(typeof v, "function");
  // 승인된 node 경로는 이 테스트 환경에 **존재하지 않는다** — 그래도 성공한다 = spawn이 없다는 증거다.
  assert.equal(lstatSync(NODE_PATH, { throwIfNoEntry: false }), undefined);
  assert.deepEqual(readdirSync(join(ws, "docs")), []);
});

test("[M5c] git·codex·임의 실행 파일·shell·env·추가 인자는 표현할 수도 고를 수도 없다", () => {
  const ws = makeWorkspace();
  // ⓐ 승인 문서 자체가 node 아닌 실행 파일을 typed operation으로 담을 수 없다.
  for (const executable of ["/opt/harness/git", "/opt/harness/codex", "/bin/sh", "/usr/bin/env"]) {
    assert.equal(
      codeOf(() =>
        approvedManifest({
          operationAuthorityByTask: {
            root: [{ authorityId: "p-x", kind: "run_process", executable, args: [], timeoutMs: 1000 }],
          },
        }),
      ),
      "operation_executable_not_approved",
      executable,
    );
  }
  // ⓑ 승인 레코드의 key 집합에 shell·env·cwd·wildcard가 없다.
  for (const forbidden of ["shell", "env", "cwd", "argsPattern", "network", "remote"]) {
    assert.equal(RUN_PROCESS_AUTHORITY_KEYS.includes(forbidden as never), false, forbidden);
    assert.equal(WRITE_FILE_AUTHORITY_KEYS.includes(forbidden as never), false, forbidden);
  }
  // ⓒ 손으로 만든 manifest가 node 아닌 실행 파일을 담아도 dispatch가 거부한다(재검사면).
  const drifted = {
    ...approvedManifest(),
    operationAuthorityByTask: {
      root: [{ authorityId: "p-node", kind: "run_process" as const, executable: "/opt/harness/git", args: ["push"], timeoutMs: 1000 }],
    },
  } as MilestoneApprovalManifest;
  assert.equal(codeOf(() => resolveProcessLaunchSpec(adoptedProcess(), ctxFor(ws, { manifest: drifted }))), "operation_denied");
});

// ── 7. schema ↔ runtime 동치 ────────────────────────────────────────────────

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
    if (k === "not" || k === "properties" || k === "definitions" || k === "items" || k === "oneOf") {
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

  // 경로 — pattern·length 정본이 하나이고 draft-07 maxLength는 **코드 포인트**다(대장 `C-40`).
  const p = s.definitions.normalizedWorkspacePath;
  assert.equal(p.pattern, NORMALIZED_WORKSPACE_PATH_PATTERN);
  assert.equal(p.not.pattern, WINDOWS_DRIVE_PATTERN);
  assert.equal(p.maxLength, LIMITS.maxPathLength);
  assert.equal(p.minLength, 1);

  assertClosedEverywhere(s, "plan");
});

test("[M5c] schema 경로 pattern과 런타임 판정이 같은 표를 낸다", () => {
  const s = readSchema("typed_execution_plan.schema.json");
  const pathRe = new RegExp(s.definitions.normalizedWorkspacePath.pattern);
  const driveRe = new RegExp(s.definitions.normalizedWorkspacePath.not.pattern);
  const schemaAccepts = (v: string) =>
    pathRe.test(v) && !driveRe.test(v) && [...v].length >= 1 && [...v].length <= s.definitions.normalizedWorkspacePath.maxLength;
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
  for (const op of json.operations) {
    const def = op.kind === "write_file" ? s.definitions.writeFileOperation : s.definitions.runProcessOperation;
    assert.deepEqual(Object.keys(op).sort(), [...def.required].sort());
  }
  for (const out of json.result.outputs) assert.ok(s.definitions.artifactRole.enum.includes(out.role));
});
