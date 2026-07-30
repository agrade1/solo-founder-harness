/**
 * V3 M5c — **typed 실행 계획의 닫힌 validator + controller 소유 권위 해석·집행**(대장 `B-10`의 집행면).
 *
 * 이 모듈이 존재하는 이유는 하나다: **worker가 고를 수 있는 것은 `authorityId` 하나뿐**이고, 그것이
 * 무엇을 뜻하는지는 사람이 승인한 `manifest.operationAuthorityByTask`가 정한다는 계약을 *실제로 집행*하는
 * 코드가 필요하기 때문이다(M5b까지는 선언에 대한 화면만 있었다 — 대장 `B-10`).
 *
 * 이 모듈이 하는 것:
 * 1. `validateTypedExecutionPlan()` — 계획 1건의 **닫힌** 검증·입양·동결. 모든 property를 **정확히 한 번**
 *    읽고, 미상 key·symbol key·계약 밖 prototype·getter/proxy trap·함수·순환을 전부 거부한다.
 * 2. `resolveWriteFileAuthority()`/`applyWriteFile()` — 승인 레코드 대조 후 **실제 파일 쓰기**(원자적).
 * 3. `resolveProcessLaunchSpec()` — 승인 레코드에서만 나오는 **데이터 전용** 실행 명세. **spawn하지 않는다.**
 *
 * 이 모듈이 **하지 않는** 것: 프로세스 spawn · shell · PATH 조회 · 환경 상속 · git · 네트워크 ·
 * dependency 설치 · provider 호출 · 디렉터리 생성 · symlink 추적. 표현할 타입도 통로도 없다.
 *
 * **오류·영수증에 내용은 담지 않는다.** 계획 본문 · 파일 내용 · prompt · stdout/stderr · argv · secret ·
 * 핸들은 오류 메시지에도 영수증에도 로그에도 들어가지 않는다 — 필드 이름과 규칙만 적는다.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  ARTIFACT_ROLES,
  LIMITS,
  OrchestrationError,
  SHA256_PATTERN,
  SLUG_PATTERN,
  TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
  type ApprovedOperation,
  type ArtifactRole,
  type MilestoneApprovalManifest,
  type OperationReceipt,
  assertText,
  isSlug,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { pathWithin, approvedOperationFor } from "./approvalManifest.js";
import { sha256Hex } from "./orchestrationStore.js";
import { MAX_PLAN_OPERATIONS, type TypedExecutionPlan, type TypedOperation } from "./autopilotTypes.js";

/** `write_file` operation 하나(닫힌 union의 한 갈래). */
export type TypedWriteFileOperation = Extract<TypedOperation, { kind: "write_file" }>;
/** `run_process` operation 하나(닫힌 union의 다른 갈래). */
export type TypedRunProcessOperation = Extract<TypedOperation, { kind: "run_process" }>;

/**
 * 이 모듈이 낼 수 있는 **안정 오류 코드 전부**(닫힌 목록 — 대장 `C-33`과 같은 취지).
 * 호출자(worker·계획 작성자)가 **고를 수 없다**: getter/proxy가 던진 `OrchestrationError`까지 전부
 * `plan_invalid`로 접는다(대장 `C-38`을 이 seam에서 닫는다).
 */
export const TYPED_EXECUTION_CODES = [
  /** 계획이 계약 밖이다(미상 key · 타입 · 상한 · binding 불일치 · getter/proxy trap 포함). */
  "plan_invalid",
  /** 이 task의 이 authorityId가 승인되지 않았거나 kind가 승인 레코드와 다르다(deny-by-default). */
  "operation_denied",
  /** 승인은 있으나 dispatch 시점의 durable task ownership 밖이다. */
  "operation_not_owned",
  /** 승인은 있으나 `manifest.writableRoots` 밖이다. */
  "operation_outside_writable_root",
  /** 본문이 `min(승인 maxBytes, LIMITS.maxWriteBytes)`를 넘는다. */
  "write_bytes_exceeded",
  /** 기존 경로 구성요소 또는 대상이 symlink다(따라가지 않는다). */
  "write_path_symlink",
  /** 대상이 일반 파일이 아니다(디렉터리·소켓·FIFO 등). */
  "write_target_not_regular",
  /** 그 밖의 집행 실패(부모 디렉터리 부재 · I/O · 신원 불일치). 내용은 담지 않는다. */
  "write_failed",
] as const;
export type TypedExecutionCode = (typeof TYPED_EXECUTION_CODES)[number];

// ── 계획 계약(닫힌 key 집합 — JSON Schema와 동치) ─────────────────────────────

export const TYPED_PLAN_KEYS = ["schemaVersion", "runId", "taskId", "attemptId", "turnId", "operations", "result"] as const;
export const TYPED_PLAN_RESULT_KEYS = ["summary", "outputs"] as const;
export const TYPED_PLAN_OUTPUT_KEYS = ["path", "role"] as const;
export const WRITE_FILE_OPERATION_KEYS = [
  "operationId",
  "kind",
  "authorityId",
  "path",
  "content",
  "expectedBeforeSha256",
] as const;
export const RUN_PROCESS_OPERATION_KEYS = ["operationId", "kind", "authorityId"] as const;

/**
 * **이미 정규화된** workspace-relative 경로의 정규형(JSON Schema와 공유하는 정본).
 * segment는 비어 있지 않고 `.`/`..`가 아니며 `\`·NUL을 포함하지 않는다. 선행·후행·중복 `/`도 없다.
 * 런타임 판정은 `normalizeWorkspacePath(v) === v`이며 두 판정의 동치는 focused 테스트가 표로 강제한다.
 * (드라이브 접두사 `C:`는 이 regex로 표현되지 않으므로 schema는 `not`으로, 런타임은
 * `normalizeWorkspacePath`가 따로 거부한다.)
 */
export const NORMALIZED_WORKSPACE_PATH_PATTERN = "^(?!\\.\\.?(?:/|$))[^/\\\\\\u0000]+(?:/(?!\\.\\.?(?:/|$))[^/\\\\\\u0000]+)*$";
/** 드라이브 접두사 거부(schema `not` 절과 같은 정본). */
export const WINDOWS_DRIVE_PATTERN = "^[A-Za-z]:";

/** 계획이 반드시 실려야 하는 **controller 소유** 실행 신원. worker가 고르는 값이 아니다. */
export interface PlanBinding {
  runId: string;
  taskId: string;
  attemptId: string;
  turnId: string;
}

function planInvalid(what: string): OrchestrationError {
  return new OrchestrationError("plan_invalid", `계획이 계약 밖이다: ${what}`);
}

/** 입양 중 만난 계약 위반 신호(밖으로 나가지 않는다 — 전부 `plan_invalid`로 접힌다). */
class AdoptionRejected extends Error {}

function reject(): never {
  throw new AdoptionRejected();
}

/**
 * **닫힌 key 집합을 정확히 한 번 읽는다.** 미상 key · symbol key · 계약 밖 prototype · 배열 · 함수는
 * 거부하고, getter/proxy가 던진 것은 **무엇이든**(caller가 만든 `OrchestrationError` 포함) 같은
 * 안정 코드로 접는다 — 거부 taxonomy를 호출자가 고르는 통로를 남기지 않는다(대장 `C-38`).
 */
function closedRead(raw: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) reject();
    const proto = Reflect.getPrototypeOf(raw as object);
    if (proto !== Object.prototype && proto !== null) reject();
    const own = Reflect.ownKeys(raw as object);
    if (own.length !== allowed.length) reject();
    for (const k of own) {
      if (typeof k !== "string" || !allowed.includes(k)) reject();
    }
    const read: Record<string, unknown> = Object.create(null);
    // ← 각 property를 읽는 **유일한** 지점. 이후 원본 객체는 다시 읽지 않는다(교대 getter 무력화).
    for (const k of allowed) read[k] = (raw as Record<string, unknown>)[k];
    return read;
  } catch {
    throw planInvalid(`${what}는 닫힌 key 집합의 순수 데이터 객체여야 한다`);
  }
}

/** 객체의 own string key 집합(값은 읽지 않는다). trap·symbol·계약 밖 prototype은 접어서 거부한다. */
function ownStringKeys(raw: unknown, what: string): string[] {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) reject();
    const proto = Reflect.getPrototypeOf(raw as object);
    if (proto !== Object.prototype && proto !== null) reject();
    const own = Reflect.ownKeys(raw as object);
    const keys: string[] = [];
    for (const k of own) {
      if (typeof k !== "string") reject();
      keys.push(k);
    }
    return keys;
  } catch {
    throw planInvalid(`${what}의 key 집합을 읽을 수 없다`);
  }
}

function isSameKeySet(keys: readonly string[], allowed: readonly string[]): boolean {
  return keys.length === allowed.length && keys.every((k) => allowed.includes(k));
}

/** 배열 길이를 한 번만 읽는다(여분 property·symbol이 붙은 배열은 거부). */
function closedLength(raw: unknown, what: string): number {
  try {
    if (!Array.isArray(raw)) reject();
    if (Reflect.getPrototypeOf(raw) !== Array.prototype) reject();
    const n = (raw as unknown[]).length;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) reject();
    if (Reflect.ownKeys(raw).length !== n + 1) reject(); // 인덱스 n개 + "length"
    return n;
  } catch {
    throw planInvalid(`${what}는 여분 property 없는 배열이어야 한다`);
  }
}

/** 항목을 한 번씩만 읽어 새 배열로 옮긴다(입양 후 원본을 바꿔도 결과가 바뀌지 않는다). */
function closedItems(raw: unknown, n: number, what: string): unknown[] {
  try {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push((raw as unknown[])[i]);
    return out;
  } catch {
    throw planInvalid(`${what}의 항목을 읽을 수 없다`);
  }
}

function planSlug(v: unknown, what: string): string {
  if (!isSlug(v)) throw planInvalid(`${what}는 slug(${SLUG_PATTERN})여야 한다`);
  return v;
}

const SHA256_RE = new RegExp(SHA256_PATTERN);

function planSha256OrNull(v: unknown, what: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !SHA256_RE.test(v)) throw planInvalid(`${what}는 소문자 hex SHA-256 또는 null이어야 한다`);
  return v;
}

/**
 * **이미 정규화된** workspace 경로만 받는다. 정규화가 값을 바꾸면 거부다 — 같은 파일을 가리키는 두 표기가
 * 계획에 남으면 "승인된 경로와 정확히 같은가"를 문자열 동치로 판정할 수 없기 때문이다.
 */
function planPath(v: unknown, what: string): string {
  let normalized: string;
  try {
    normalized = normalizeWorkspacePath(v, what);
  } catch {
    throw planInvalid(`${what}는 정규화된 workspace-relative 경로여야 한다`);
  }
  if (normalized !== v) throw planInvalid(`${what}는 이미 정규화된 형태여야 한다`);
  return normalized;
}

/**
 * 파일 본문. **바이트**로 상한을 본다(`Buffer.byteLength`) — schema `maxLength`는 코드 포인트라
 * 상한 값은 같아도 의미가 다르며, 이 방향(런타임이 더 엄격)이 fail closed다.
 * 왕복이 깨지는 문자열(고립 surrogate)은 쓰기 바이트가 의도와 조용히 달라지므로 거부한다.
 */
function planContent(v: unknown, what: string): string {
  if (typeof v !== "string") throw planInvalid(`${what}는 문자열이어야 한다`);
  const bytes = Buffer.byteLength(v, "utf8");
  if (bytes > LIMITS.maxWriteBytes) throw planInvalid(`${what}가 ${LIMITS.maxWriteBytes} 바이트 상한을 넘는다`);
  if (Buffer.from(v, "utf8").toString("utf8") !== v) throw planInvalid(`${what}는 UTF-8 왕복이 보존되는 문자열이어야 한다`);
  return v;
}

/**
 * operation 1건. **kind는 key 집합이 정한다** — key 집합을 먼저 보고 그것에 맞는 닫힌 읽기를 한 번 하며,
 * 읽은 `kind` 값이 그 집합과 다르면 거부한다(교대 getter가 kind를 바꿔 다른 갈래로 새는 통로가 없다).
 */
function planOperation(raw: unknown, index: number): TypedOperation {
  const what = `operations[${index}]`;
  const keys = ownStringKeys(raw, what);
  if (isSameKeySet(keys, WRITE_FILE_OPERATION_KEYS)) {
    const read = closedRead(raw, WRITE_FILE_OPERATION_KEYS, what);
    if (read.kind !== "write_file") throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
    return Object.freeze({
      operationId: planSlug(read.operationId, `${what}.operationId`),
      kind: "write_file" as const,
      authorityId: planSlug(read.authorityId, `${what}.authorityId`),
      path: planPath(read.path, `${what}.path`),
      content: planContent(read.content, `${what}.content`),
      expectedBeforeSha256: planSha256OrNull(read.expectedBeforeSha256, `${what}.expectedBeforeSha256`),
    });
  }
  if (isSameKeySet(keys, RUN_PROCESS_OPERATION_KEYS)) {
    const read = closedRead(raw, RUN_PROCESS_OPERATION_KEYS, what);
    if (read.kind !== "run_process") throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
    return Object.freeze({
      operationId: planSlug(read.operationId, `${what}.operationId`),
      kind: "run_process" as const,
      authorityId: planSlug(read.authorityId, `${what}.authorityId`),
    });
  }
  throw planInvalid(`${what}는 write_file|run_process의 닫힌 key 집합이어야 한다`);
}

function planOutput(raw: unknown, index: number): { path: string; role: ArtifactRole } {
  const what = `result.outputs[${index}]`;
  const read = closedRead(raw, TYPED_PLAN_OUTPUT_KEYS, what);
  if (!(ARTIFACT_ROLES as readonly unknown[]).includes(read.role)) {
    throw planInvalid(`${what}.role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
  }
  return Object.freeze({ path: planPath(read.path, `${what}.path`), role: read.role as ArtifactRole });
}

/**
 * **계획 1건을 입양한다.** 통과하면 깊이 동결된 새 객체이고, 원본을 이후에 바꿔도 이 값은 바뀌지 않는다.
 *
 * `binding`은 **controller가 소유한** 실행 신원이다: 계획이 다른 run/task/attempt/turn을 자칭하면 거부한다
 * (worker가 남의 attempt에 결과를 밀어 넣는 통로를 남기지 않는다).
 */
export function validateTypedExecutionPlan(raw: unknown, binding: PlanBinding): TypedExecutionPlan {
  const bound: PlanBinding = {
    runId: planSlug(binding?.runId, "binding.runId"),
    taskId: planSlug(binding?.taskId, "binding.taskId"),
    attemptId: planSlug(binding?.attemptId, "binding.attemptId"),
    turnId: planSlug(binding?.turnId, "binding.turnId"),
  };

  const read = closedRead(raw, TYPED_PLAN_KEYS, "plan");
  if (read.schemaVersion !== TYPED_EXECUTION_PLAN_SCHEMA_VERSION) {
    throw planInvalid(`plan.schemaVersion은 "${TYPED_EXECUTION_PLAN_SCHEMA_VERSION}"이어야 한다`);
  }
  for (const key of ["runId", "taskId", "attemptId", "turnId"] as const) {
    if (planSlug(read[key], `plan.${key}`) !== bound[key]) {
      throw planInvalid(`plan.${key}가 controller가 준 실행 신원과 다르다`);
    }
  }

  const opCount = closedLength(read.operations, "plan.operations");
  if (opCount > MAX_PLAN_OPERATIONS) throw planInvalid(`plan.operations는 ${MAX_PLAN_OPERATIONS}건 이하여야 한다`);
  const rawOps = closedItems(read.operations, opCount, "plan.operations");
  const operations: TypedOperation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawOps.length; i++) {
    const op = planOperation(rawOps[i], i);
    if (seen.has(op.operationId)) throw planInvalid("plan.operations에 중복 operationId가 있다");
    seen.add(op.operationId);
    operations.push(op);
  }

  const resultRead = closedRead(read.result, TYPED_PLAN_RESULT_KEYS, "plan.result");
  let summary: string;
  try {
    summary = assertText(resultRead.summary, "plan.result.summary", LIMITS.maxSummaryLength);
  } catch {
    throw planInvalid(`plan.result.summary는 1..${LIMITS.maxSummaryLength}자 문자열이어야 한다`);
  }
  const outCount = closedLength(resultRead.outputs, "plan.result.outputs");
  if (outCount > LIMITS.maxArtifactRefs) throw planInvalid(`plan.result.outputs는 ${LIMITS.maxArtifactRefs}건 이하여야 한다`);
  const rawOutputs = closedItems(resultRead.outputs, outCount, "plan.result.outputs");
  const outputs = rawOutputs.map((o, i) => planOutput(o, i));

  return Object.freeze({
    schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
    runId: bound.runId,
    taskId: bound.taskId,
    attemptId: bound.attemptId,
    turnId: bound.turnId,
    operations: Object.freeze(operations) as TypedOperation[],
    result: Object.freeze({ summary, outputs: Object.freeze(outputs) as Array<{ path: string; role: ArtifactRole }> }),
  });
}

// ── controller 소유 권위 해석 ────────────────────────────────────────────────

/** 집행 문맥. **controller가 소유한 값만** 들어온다 — worker가 만들 수 있는 필드가 하나도 없다. */
export interface OperationDispatchContext {
  /** 절대 workspace 경로. 모든 쓰기는 이 아래의 승인된 경로에서만 일어난다. */
  workspaceRoot: string;
  /** run에 bind된 durable 승인 manifest. */
  manifest: MilestoneApprovalManifest;
  /** 이 operation을 요청한 task. */
  taskId: string;
  /**
   * **dispatch 시점의 durable task ownership.** manifest는 child task의 ownership을 모르므로
   * (child는 parent 부분집합을 위임받는다) 소유 판정은 이 값으로 한다.
   */
  ownership: readonly string[];
  /** 영수증 시각. durable 기록 시 kernel이 커밋 시각으로 덮어쓴다. */
  nowIso: string;
}

function denied(what: string): OrchestrationError {
  return new OrchestrationError("operation_denied", `승인되지 않은 typed operation이다: ${what}`);
}

/**
 * **deny-by-default 권위 해석.** durable manifest의 `approvedOperationFor(taskId, authorityId)` 하나만
 * 본다 — 부재·다른 task·kind 불일치는 전부 거부다. "부재가 곧 허용"이 되는 경로는 없다.
 *
 * mutation seam(비공허성 · 대장 `C-34`): 아래 `null` 검사를 지우고 합성 authority를 돌려주면
 * focused 테스트 "[M5c] MUTATION-GUARD: 권위 대조를 건너뛰면 거부가 사라진다"가 반드시 실패해야 한다.
 */
function resolveApprovedOperation(op: TypedOperation, ctx: OperationDispatchContext): ApprovedOperation {
  const approved = approvedOperationFor(ctx.manifest, ctx.taskId, op.authorityId);
  if (approved === null) throw denied("이 task에 승인된 authorityId가 아니다");
  if (approved.kind !== op.kind) throw denied("승인 레코드의 kind와 다르다");
  return approved;
}

/**
 * `write_file` 권위 해석(순수 — 파일 시스템을 만지지 않는다).
 * 정확히 같은 정규화 경로 · dispatch 시점 ownership · `writableRoots`를 **전부** 다시 본다.
 */
export function resolveWriteFileAuthority(
  op: TypedWriteFileOperation,
  ctx: OperationDispatchContext,
): Extract<ApprovedOperation, { kind: "write_file" }> {
  const approved = resolveApprovedOperation(op, ctx);
  if (approved.kind !== "write_file") throw denied("승인 레코드의 kind와 다르다");
  if (op.path !== approved.path) throw denied("승인된 경로와 정확히 같지 않다");
  if (!ctx.ownership.some((own) => pathWithin(op.path, own))) {
    throw new OrchestrationError("operation_not_owned", "경로가 이 task의 durable ownership 밖이다");
  }
  if (!ctx.manifest.writableRoots.some((root) => pathWithin(op.path, root))) {
    throw new OrchestrationError("operation_outside_writable_root", "경로가 승인된 writableRoots 밖이다");
  }
  return approved;
}

/**
 * **데이터 전용 실행 명세**(V3 M5c). 승인 레코드에서만 나오고 **동결**된다.
 * callback · 환경 · cwd · shell · 파일 시스템 객체 · provider 핸들이 **없다**: 이 타입으로는
 * "승인된 Node 실행 파일을 승인된 인자 배열로, 승인된 timeout 안에서" 외의 것을 표현할 수 없다.
 * 실제 launcher는 managed process slice가 되며 **이 모듈은 아무것도 spawn하지 않는다.**
 */
export interface ProcessLaunchSpec {
  readonly operationId: string;
  readonly authorityId: string;
  /** 승인된 절대 경로(= `executionAuthority.node.path`). 런타임 선택 통로가 없다. */
  readonly executable: string;
  /** spawn 직전 재검증에 쓰는 승인 digest(`executionBoundary.verifyApprovedExecutable`). */
  readonly sha256: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** `run_process` 권위 해석. **spawn하지 않는다** — 동결된 명세 데이터만 돌려준다. */
export function resolveProcessLaunchSpec(op: TypedRunProcessOperation, ctx: OperationDispatchContext): ProcessLaunchSpec {
  const approved = resolveApprovedOperation(op, ctx);
  if (approved.kind !== "run_process") throw denied("승인 레코드의 kind와 다르다");
  // manifest 검증이 이미 강제하지만 dispatch 시점에도 다시 본다 — 승인 문서가 어떤 경로로 바뀌어 들어와도
  // 실행 대상은 승인된 node 하나뿐이다(git·codex·임의 실행 파일은 typed operation이 아니다).
  if (approved.executable !== ctx.manifest.executionAuthority.node.path) {
    throw denied("승인된 node 실행 파일과 다르다");
  }
  return Object.freeze({
    operationId: op.operationId,
    authorityId: op.authorityId,
    executable: approved.executable,
    sha256: ctx.manifest.executionAuthority.node.sha256,
    args: Object.freeze([...approved.args]),
    timeoutMs: approved.timeoutMs,
  });
}

// ── write_file 집행 ─────────────────────────────────────────────────────────

/** digest 계산 chunk(고정 64 KiB — 큰 preimage도 메모리 상한 안에서 읽는다). */
const HASH_CHUNK_BYTES = 65_536;

/**
 * preimage 판정을 위해 읽을 수 있는 최대 바이트.
 * ponytail: 상한을 넘는 대상은 판정 불가 = `write_conflict`(fail closed)로 접는다. 스트리밍 상한을
 * 올려야 할 만큼 큰 승인 대상이 생기면 그때 값을 올린다.
 */
const MAX_PREIMAGE_BYTES = 64 * 1024 * 1024;

const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

function writeFailed(what: string): OrchestrationError {
  return new OrchestrationError("write_failed", `typed 쓰기를 집행할 수 없다: ${what}`);
}

/** preimage가 상한을 넘어 **판정 자체가 불가능**하다는 내부 신호(밖으로 나가지 않는다). */
class PreimageUnreadable extends Error {}

/** 열린 fd 하나에서 내용 digest를 읽는다(경로 재오픈 없음 → 판정과 대상이 갈라지지 않는다). */
function digestOfFd(fd: number, size: number): string {
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)));
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - off), off);
    if (n <= 0) throw writeFailed("preimage를 끝까지 읽지 못했다");
    h.update(buf.subarray(0, n));
    off += n;
  }
  return h.digest("hex");
}

/**
 * 현재 대상의 내용 digest. 없으면 `null`.
 * symlink·비일반 파일은 **digest가 없다** — 그 자리에서 거부다(따라가지 않는다).
 */
function currentDigest(target: string): string | null {
  let fd: number;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new OrchestrationError("write_path_symlink", "대상이 symlink다(따라가지 않는다)");
    throw writeFailed("대상을 열 수 없다");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new OrchestrationError("write_target_not_regular", "대상이 일반 파일이 아니다");
    if (st.size > MAX_PREIMAGE_BYTES) throw new PreimageUnreadable();
    return digestOfFd(fd, st.size);
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd 정리 실패가 판정 결과를 가리지 않는다 */
    }
  }
}

/** 기존 경로 구성요소를 **하나도 따라가지 않고** 확인한다. 부모는 전부 실재하는 디렉터리여야 한다. */
function resolveTargetPath(workspaceRoot: string, relPath: string): string {
  if (!isAbsolute(workspaceRoot)) throw writeFailed("workspaceRoot가 절대 경로가 아니다");
  let cur: string;
  try {
    cur = realpathSync(workspaceRoot);
  } catch {
    throw writeFailed("workspaceRoot를 확인할 수 없다");
  }
  const segments = relPath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    cur = join(cur, segments[i]);
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (!st) throw writeFailed("경로 구성요소가 없다(디렉터리를 만들지 않는다)");
    if (st.isSymbolicLink()) throw new OrchestrationError("write_path_symlink", "경로 구성요소가 symlink다");
    if (!st.isDirectory()) throw writeFailed("경로 구성요소가 디렉터리가 아니다");
  }
  const target = join(cur, segments[segments.length - 1]);
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st) {
    if (st.isSymbolicLink()) throw new OrchestrationError("write_path_symlink", "대상이 symlink다");
    if (!st.isFile()) throw new OrchestrationError("write_target_not_regular", "대상이 일반 파일이 아니다");
  }
  return target;
}

function receipt(
  op: TypedOperation,
  marker: OperationReceipt["marker"],
  path: string | null,
  resultSha256: string | null,
  at: string,
): OperationReceipt {
  return Object.freeze({
    operationId: op.operationId,
    kind: op.kind,
    authorityId: op.authorityId,
    path,
    resultSha256,
    exitCode: null,
    marker,
    at,
  });
}

/**
 * **승인된 typed 파일 쓰기 1건을 집행한다.**
 *
 * 순서가 계약이다:
 * 1. 권위 해석(deny-by-default) → 정확한 경로 · dispatch 시점 ownership · writableRoots.
 * 2. 바이트 상한 = `min(승인 maxBytes, LIMITS.maxWriteBytes)`.
 * 3. 기존 경로 구성요소·대상의 symlink/비일반 파일 거부(따라가지 않는다).
 * 4. **크래시 창 멱등**: 현재 내용 digest가 의도한 내용 digest와 같으면 영수증이 durable하지 않았어도
 *    `already_applied`다(같은 바이트를 두 번 쓰지 않는다).
 * 5. 그 밖의 preimage 불일치는 **쓰지 않고** `write_conflict`.
 * 6. 같은 디렉터리의 **배타 생성된 우리 temp**에 쓰고 → 정확한 바이트·digest 재확인 → `rename`.
 *    이 호출이 만든 temp 외에는 아무것도 지우지 않는다.
 *
 * 돌려주는 것은 닫힌 `OperationReceipt` 모양의 동결 값뿐이다 — **내용은 담지 않는다.**
 */
export function applyWriteFile(op: TypedWriteFileOperation, ctx: OperationDispatchContext): OperationReceipt {
  const approved = resolveWriteFileAuthority(op, ctx);

  const bytes = Buffer.from(op.content, "utf8");
  const bound = Math.min(approved.maxBytes, LIMITS.maxWriteBytes);
  if (bytes.byteLength > bound) {
    throw new OrchestrationError("write_bytes_exceeded", "본문이 승인된 바이트 상한을 넘는다");
  }

  const target = resolveTargetPath(ctx.workspaceRoot, op.path);
  const intended = sha256Hex(bytes);

  let before: string | null;
  try {
    before = currentDigest(target);
  } catch (e) {
    // preimage를 판정할 수 없는 경우(상한 초과)는 충돌로 접는다 — 조용히 덮어쓰지 않는다.
    if (e instanceof PreimageUnreadable) return receipt(op, "write_conflict", op.path, null, ctx.nowIso);
    throw e;
  }

  // 4. 크래시 창: 이미 의도한 바이트가 있다 → 다시 쓰지 않는다.
  if (before === intended) return receipt(op, "already_applied", op.path, intended, ctx.nowIso);
  // 5. 기대한 preimage가 아니다 → 쓰지 않는다.
  if (op.expectedBeforeSha256 === null ? before !== null : before !== op.expectedBeforeSha256) {
    return receipt(op, "write_conflict", op.path, null, ctx.nowIso);
  }

  writeThroughOwnedTemp(target, bytes, intended);
  return receipt(op, "applied", op.path, intended, ctx.nowIso);
}

/**
 * 같은 디렉터리의 **배타 생성 temp**에 쓰고 원자적으로 이름을 바꾼다.
 *
 * ponytail: `rename(2)`는 **경로 이름**을 받으므로 "증명한 fd를 그대로 rename"할 수는 없다(대장 `C-5`와
 * 같은 종류의 잔여 창). 대신 ⓐ temp를 `O_EXCL`로 **우리가** 만들고 ⓑ 같은 fd로 바이트·digest를 다시 읽어
 * 확인하고 ⓒ rename 직전에 temp 경로가 여전히 우리 inode인지 보고 ⓓ rename 뒤 대상 inode가 우리 것인지
 * 확인한다. 어긋나면 `write_failed`이고, 우리가 만든 temp만 정리한다(남의 파일은 건드리지 않는다).
 */
function writeThroughOwnedTemp(target: string, bytes: Buffer, intended: string): void {
  const temp = join(dirname(target), `.m5c-write-${randomBytes(12).toString("hex")}.tmp`);
  let fd: number;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
  } catch {
    throw writeFailed("배타 temp를 만들 수 없다");
  }
  const opened = fstatSync(fd);
  const ours = { dev: opened.dev, ino: opened.ino };
  try {
    let off = 0;
    while (off < bytes.byteLength) {
      const n = writeSync(fd, bytes, off, bytes.byteLength - off, off);
      if (n <= 0) throw writeFailed("temp에 끝까지 쓰지 못했다");
      off += n;
    }
    fsyncSync(fd);
    if (fstatSync(fd).size !== bytes.byteLength) throw writeFailed("temp 크기가 의도와 다르다");
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      /* 무시 */
    }
    removeOwnedTemp(temp, ours);
    throw e instanceof OrchestrationError ? e : writeFailed("temp에 쓰지 못했다");
  }
  try {
    closeSync(fd);
  } catch {
    /* fd 정리 실패는 아래 재검증을 가리지 않는다 */
  }

  try {
    const verifyFd = openSync(temp, fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      const st = fstatSync(verifyFd);
      if (st.dev !== ours.dev || st.ino !== ours.ino) throw writeFailed("temp가 다른 inode로 바뀌었다");
      if (st.size !== bytes.byteLength || digestOfFd(verifyFd, st.size) !== intended) {
        throw writeFailed("temp 내용이 의도와 다르다");
      }
    } finally {
      try {
        closeSync(verifyFd);
      } catch {
        /* 무시 */
      }
    }
    renameSync(temp, target);
  } catch (e) {
    removeOwnedTemp(temp, ours);
    if (e instanceof OrchestrationError) throw e;
    throw writeFailed("temp를 대상 이름으로 바꾸지 못했다");
  }

  // rename은 inode를 보존한다 → 대상이 **우리 바이트**인지 신원으로 확인한다.
  const after = lstatSync(target, { throwIfNoEntry: false });
  if (!after || after.isSymbolicLink() || !after.isFile() || after.dev !== ours.dev || after.ino !== ours.ino) {
    throw writeFailed("발행된 대상이 이 호출이 만든 파일이 아니다");
  }
}

/** **이 호출이 만든 temp만** 지운다(신원이 다르면 남의 파일이므로 건드리지 않는다). */
function removeOwnedTemp(temp: string, ours: { dev: number; ino: number }): void {
  try {
    const st = lstatSync(temp, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink() && st.isFile() && st.dev === ours.dev && st.ino === ours.ino) unlinkSync(temp);
  } catch {
    /* 정리 실패는 집행 판정을 바꾸지 않는다(대장 `C-39`와 같은 종류) */
  }
}
