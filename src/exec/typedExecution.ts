/**
 * V3 M5c — **controller 소유 typed operation 권위 집행**(대장 `B-10`의 집행면).
 *
 * 이 모듈이 존재하는 이유는 하나다: **worker가 고를 수 있는 것은 `authorityId` 하나뿐**이고, 그것이
 * 무엇을 뜻하는지는 사람이 승인한 `manifest.operationAuthorityByTask`가 정한다는 계약을 *실제로 집행*하는
 * 코드가 필요하기 때문이다(M5b까지는 선언에 대한 화면만 있었다 — 대장 `B-10`).
 *
 * **권위의 출처는 kernel 하나다(3A 리비전 A2).** 1차 판은 `OperationDispatchContext`라는 **평범한 구조적
 * 객체**를 받았다 → 위조한 manifest·ownership·workspaceRoot를 담은 객체 하나로 `../victim` 쓰기와 프로세스
 * 명세를 얻을 수 있었고, 만료·예산 deadline·task lifecycle·attempt 신원은 아예 보지 않았다. 지금은
 * **kernel이 발급한 봉인 permit**만 받고, 효과·명세 발급 **직전마다**
 * `orchestrationKernel.readDispatchAuthority()`로 **현재 durable 상태**를 다시 읽는다.
 *
 * 이 모듈이 하는 것:
 * 1. `resolveWriteFileAuthority()` — 승인 레코드 대조(deny-by-default · 파일 시스템 무접촉).
 * 2. `applyWriteFile()` — 승인된 **실제 파일 쓰기**(원자적 · 부재 대상은 **덮어쓰지 않는** `link(2)` 발행 ·
 *    교체는 preimage 신원·내용 재확인 후 `rename(2)` · 디렉터리 fsync까지 확인한 뒤에만 `applied`).
 * 3. `resolveProcessLaunchSpec()` — 승인 레코드에서만 나오는 **데이터 전용** 실행 명세. **spawn하지 않는다.**
 *
 * 계획의 닫힌 validator와 계약 상수는 `typedPlan.ts`에 있다(순수 모듈 — offline worker가 파일 시스템
 * 권위를 transitive하게 끌어오지 않도록 갈라 두었다). 호환을 위해 여기서 그대로 재수출한다.
 *
 * 이 모듈이 **하지 않는** 것: 프로세스 spawn · shell · PATH 조회 · 환경 상속 · git · 네트워크 ·
 * dependency 설치 · provider 호출 · 디렉터리 생성 · symlink 추적. 표현할 타입도 통로도 없다.
 *
 * **오류·영수증에 내용은 담지 않는다.** 계획 본문 · 파일 내용 · prompt · stdout/stderr · argv · secret ·
 * 핸들 · 절대 경로는 오류 메시지에도 영수증에도 로그에도 들어가지 않는다 — 필드 이름과 규칙만 적는다.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  LIMITS,
  OrchestrationError,
  type ApprovedOperation,
  type OperationReceipt,
} from "./orchestrationTypes.js";
import { pathWithin, approvedOperationFor } from "./approvalManifest.js";
import { sha256Hex } from "./orchestrationStore.js";
import {
  DISPATCH_AUTHORITY_CODES,
  readDispatchAuthority,
  type DispatchAuthority,
} from "./orchestrationKernel.js";
import type { TypedWriteFileOperation, TypedRunProcessOperation } from "./typedPlan.js";

// 계획 계약은 순수 모듈이 정본이다. 기존 호출부·테스트 호환을 위해 같은 이름으로 재수출한다.
export {
  LONE_SURROGATE_PATTERN,
  NORMALIZED_WORKSPACE_PATH_PATTERN,
  RUN_PROCESS_OPERATION_KEYS,
  TYPED_PLAN_BINDING_KEYS,
  TYPED_PLAN_KEYS,
  TYPED_PLAN_OUTPUT_KEYS,
  TYPED_PLAN_RESULT_KEYS,
  WINDOWS_DRIVE_PATTERN,
  WRITE_FILE_OPERATION_KEYS,
  readOwnArray,
  readOwnData,
  validateTypedExecutionPlan,
} from "./typedPlan.js";
export type { PlanBinding, TypedRunProcessOperation, TypedWriteFileOperation } from "./typedPlan.js";
export type { DispatchAuthority, OperationDispatchPermit } from "./orchestrationKernel.js";

/**
 * 이 모듈이 낼 수 있는 **안정 오류 코드 전부**(닫힌 목록 — 대장 `C-33`과 같은 취지).
 * 호출자(worker·계획 작성자)가 **고를 수 없다**: getter/proxy가 던진 `OrchestrationError`까지 전부
 * `plan_invalid`로 접힌다(`typedPlan.ts` — 대장 `C-38`을 그 seam에서 닫는다).
 * permit 검증 단계의 코드는 `orchestrationKernel.DISPATCH_AUTHORITY_CODES`가 정본이다.
 */
export const TYPED_EXECUTION_CODES = [
  /** 계획이 계약 밖이다(미상 key · 타입 · 상한 · binding 불일치 · accessor/proxy 포함). */
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
  /** 그 밖의 집행 실패(부모 디렉터리 부재 · I/O · 신원 불일치 · 발행 경쟁). 내용은 담지 않는다. */
  "write_failed",
  /**
   * 바이트는 발행됐지만 **요구된 durability를 확인하지 못했다**(디렉터리 fsync 실패).
   * `applied` 영수증을 주지 않는다 — 재시도는 현재 내용 hash가 의도와 같으므로 `already_applied`로 수렴한다.
   */
  "write_durability_unconfirmed",
  ...DISPATCH_AUTHORITY_CODES,
] as const;
export type TypedExecutionCode = (typeof TYPED_EXECUTION_CODES)[number];

// ── 권위 해석 (deny-by-default · 부수 효과 0) ─────────────────────────────────

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
function resolveApprovedOperation(
  op: TypedWriteFileOperation | TypedRunProcessOperation,
  auth: DispatchAuthority,
): ApprovedOperation {
  const approved = approvedOperationFor(auth.manifest, auth.taskId, op.authorityId);
  if (approved === null) throw denied("이 task에 승인된 authorityId가 아니다");
  if (approved.kind !== op.kind) throw denied("승인 레코드의 kind와 다르다");
  return approved;
}

/**
 * `write_file` 권위 해석. 정확히 같은 정규화 경로 · **dispatch 시점** ownership · `writableRoots`를
 * 전부 다시 본다. 파일 시스템은 만지지 않는다.
 */
function resolveWriteAuthority(
  op: TypedWriteFileOperation,
  auth: DispatchAuthority,
): Extract<ApprovedOperation, { kind: "write_file" }> {
  const approved = resolveApprovedOperation(op, auth);
  if (approved.kind !== "write_file") throw denied("승인 레코드의 kind와 다르다");
  if (op.path !== approved.path) throw denied("승인된 경로와 정확히 같지 않다");
  if (!auth.ownership.some((own) => pathWithin(op.path, own))) {
    throw new OrchestrationError("operation_not_owned", "경로가 이 task의 durable ownership 밖이다");
  }
  if (!auth.manifest.writableRoots.some((root) => pathWithin(op.path, root))) {
    throw new OrchestrationError("operation_outside_writable_root", "경로가 승인된 writableRoots 밖이다");
  }
  return approved;
}

/**
 * `write_file` 권위 해석(공개 진입점 — **봉인 permit이 필요하다**).
 * 순수 판정만 하고 파일 시스템을 만지지 않는다. 평범한 구조적 객체로는 아무것도 얻지 못한다.
 */
export function resolveWriteFileAuthority(
  op: TypedWriteFileOperation,
  permit: unknown,
): Extract<ApprovedOperation, { kind: "write_file" }> {
  return resolveWriteAuthority(op, readDispatchAuthority(permit, op));
}

/**
 * **데이터 전용 실행 명세**(V3 M5c). 승인 레코드 + **현재 durable 실행 신원**에서만 나오고 **동결**된다.
 * callback · 환경 · cwd · shell · 파일 시스템 객체 · provider 핸들이 **없다**: 이 타입으로는
 * "승인된 Node 실행 파일을 승인된 인자 배열로, 승인된 timeout 안에서" 외의 것을 표현할 수 없다.
 * 실행 신원(run/task/attempt/turn)을 함께 담으므로 미래 launcher가 명세를 **다른 attempt에 재사용할 수 없다**.
 * 실제 launcher는 managed process slice가 되며 **이 모듈은 아무것도 spawn하지 않는다.**
 */
export interface ProcessLaunchSpec {
  readonly operationId: string;
  readonly authorityId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly turnId: string;
  /** 승인된 절대 경로(= `executionAuthority.node.path`). 런타임 선택 통로가 없다. */
  readonly executable: string;
  /** spawn 직전 재검증에 쓰는 승인 digest(`executionBoundary.verifyApprovedExecutable`). */
  readonly sha256: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/**
 * `run_process` 권위 해석. **spawn하지 않는다** — 동결된 명세 데이터만 돌려준다.
 * 명세 발급도 효과이므로 **직전에 현재 durable 권위를 다시 읽는다**(만료·예산·lifecycle·attempt 포함).
 */
export function resolveProcessLaunchSpec(op: TypedRunProcessOperation, permit: unknown): ProcessLaunchSpec {
  const auth = readDispatchAuthority(permit, op);
  const approved = resolveApprovedOperation(op, auth);
  if (approved.kind !== "run_process") throw denied("승인 레코드의 kind와 다르다");
  // manifest 검증이 이미 강제하지만 dispatch 시점에도 다시 본다 — 승인 문서가 어떤 경로로 바뀌어 들어와도
  // 실행 대상은 승인된 node 하나뿐이다(git·codex·임의 실행 파일은 typed operation이 아니다).
  if (approved.executable !== auth.manifest.executionAuthority.node.path) {
    throw denied("승인된 node 실행 파일과 다르다");
  }
  return Object.freeze({
    operationId: op.operationId,
    authorityId: op.authorityId,
    runId: auth.runId,
    taskId: auth.taskId,
    attemptId: auth.attemptId,
    turnId: auth.turnId,
    executable: approved.executable,
    sha256: auth.manifest.executionAuthority.node.sha256,
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

const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;

function writeFailed(what: string): OrchestrationError {
  return new OrchestrationError("write_failed", `typed 쓰기를 집행할 수 없다: ${what}`);
}

function symlinkRefused(what: string): OrchestrationError {
  return new OrchestrationError("write_path_symlink", what);
}

function notRegular(what: string): OrchestrationError {
  return new OrchestrationError("write_target_not_regular", what);
}

/**
 * **no-follow 보장이 없으면 아무것도 쓰지 않는다.** 이전 판은 `O_NOFOLLOW`가 없을 때 조용히 `0`으로
 * 떨어뜨렸다 → symlink 거부가 그 플랫폼에서 흉내가 됐다. 지금은 fail closed다.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

function requireNoFollow(): void {
  if (typeof O_NOFOLLOW !== "number" || O_NOFOLLOW === 0) {
    throw writeFailed("이 플랫폼에 O_NOFOLLOW 보장이 없다(조용히 따라가지 않는다)");
  }
}

/**
 * **결정론적 race·fault 테스트 seam**(모듈 사설 · 테스트 전용).
 *
 * 이것이 **권위가 될 수 없는 이유**: 콜백은 **인자를 받지 않고 반환값도 무시된다**. 권위 판정
 * (`readDispatchAuthority` → 승인 레코드 대조)은 **모든 seam보다 먼저** 끝나고, 발행 직전 신원 확인은
 * seam **뒤에** 다시 돈다. 즉 seam으로 할 수 있는 것은 "파일 시스템을 흔들거나 던지는 것"뿐이고,
 * 그때 이 모듈은 반드시 안정 코드로 거부하며 fd·temp를 남기지 않는다 — 그것이 테스트가 증명하는 것이다.
 * ponytail: 결정론적 경쟁 재현에는 이 방법밖에 없다. 실제 병렬 프로세스로 바꿀 이유가 생기면 그때 바꾼다.
 */
export type PublicationSeam =
  | "parentWalk"
  | "targetOpen"
  | "tempCreate"
  | "tempWrite"
  | "tempVerify"
  | "publish"
  | "postVerify"
  | "dirFsync";

let SEAMS: Partial<Record<PublicationSeam, () => void>> = {};

/** 테스트 전용. 돌려주는 함수를 부르면 원상복구된다(테스트 사이에 상태가 새지 않는다). */
export function __setPublicationSeamsForTest(seams: Partial<Record<PublicationSeam, () => void>>): () => void {
  const previous = SEAMS;
  SEAMS = seams;
  return () => {
    SEAMS = previous;
  };
}

function seam(name: PublicationSeam): void {
  const hook = SEAMS[name];
  if (hook !== undefined) hook();
}

/** 파일 신원(같은 파일인가) — 경로 이름이 아니라 inode로 본다. */
interface Ident {
  dev: number;
  ino: number;
}

function identOf(st: Stats): Ident {
  return { dev: st.dev, ino: st.ino };
}

function sameIdent(a: Ident, b: Ident): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

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

interface ParentWalk {
  /** 최종 부모 디렉터리의 절대 경로. */
  parent: string;
  /** 대상 파일의 절대 경로. */
  target: string;
  /** 최종 부모 디렉터리의 신원. */
  parentIdent: Ident;
}

/**
 * 기존 경로 구성요소를 **하나도 따라가지 않고** 확인한다. 부모는 전부 실재하는 디렉터리여야 한다.
 * workspace 봉쇄는 `realpath(workspaceRoot)`에서 시작해 segment마다 `lstat`로 symlink를 거부하는 것으로
 * 성립한다. **발행 직전에 한 번 더 부른다** — 그 사이에 부모가 symlink로 교체되면 신원이 달라진다.
 */
function walkParents(workspaceRoot: string, relPath: string): ParentWalk {
  if (!isAbsolute(workspaceRoot)) throw writeFailed("workspaceRoot가 절대 경로가 아니다");
  let cur: string;
  try {
    cur = realpathSync(workspaceRoot);
  } catch {
    throw writeFailed("workspaceRoot를 확인할 수 없다");
  }
  const segments = relPath.split("/");
  let parentIdent: Ident;
  {
    const rootSt = lstatOrNull(cur);
    if (!rootSt || !rootSt.isDirectory()) throw writeFailed("workspaceRoot가 디렉터리가 아니다");
    parentIdent = identOf(rootSt);
  }
  for (let i = 0; i < segments.length - 1; i++) {
    cur = join(cur, segments[i]);
    const st = lstatOrNull(cur);
    if (!st) throw writeFailed("경로 구성요소가 없다(디렉터리를 만들지 않는다)");
    if (st.isSymbolicLink()) throw symlinkRefused("경로 구성요소가 symlink다");
    if (!st.isDirectory()) throw writeFailed("경로 구성요소가 디렉터리가 아니다");
    parentIdent = identOf(st);
  }
  return { parent: cur, target: join(cur, segments[segments.length - 1]), parentIdent };
}

function receipt(
  op: TypedWriteFileOperation | TypedRunProcessOperation,
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
 * 1. **봉인 permit → 현재 durable 권위**(만료·예산 deadline·lifecycle·attempt/turn·preflight·manifest 정본).
 * 2. 권위 해석(deny-by-default) → 정확한 경로 · dispatch 시점 ownership · writableRoots.
 * 3. 바이트 상한 = `min(승인 maxBytes, LIMITS.maxWriteBytes)`.
 * 4. no-follow 경로 walk(symlink·비일반 파일 거부) + 부모 디렉터리 신원 고정.
 * 5. **크래시 창 멱등**: 현재 내용 digest가 의도한 내용 digest와 같으면 영수증이 durable하지 않았어도
 *    `already_applied`다(같은 바이트를 두 번 쓰지 않는다).
 * 6. 그 밖의 preimage 불일치는 **쓰지 않고** `write_conflict`.
 * 7. 같은 디렉터리의 **배타 생성된 우리 temp**에 쓰고 → 같은 fd로 바이트·digest 재확인 → 발행 직전
 *    부모·temp·대상 신원 **재확인** → 부재 대상은 `link(2)`(**덮어쓰지 않는다**) · 교체는 `rename(2)`.
 * 8. 발행 후 대상 신원 확인 → **디렉터리 fsync** 성공까지 확인한 뒤에만 `applied`.
 *
 * 돌려주는 것은 닫힌 `OperationReceipt` 모양의 동결 값뿐이다 — **내용은 담지 않는다.**
 */
export function applyWriteFile(op: TypedWriteFileOperation, permit: unknown): OperationReceipt {
  const auth = readDispatchAuthority(permit, op);
  const approved = resolveWriteAuthority(op, auth);

  const bytes = Buffer.from(op.content, "utf8");
  const bound = Math.min(approved.maxBytes, LIMITS.maxWriteBytes);
  if (bytes.byteLength > bound) {
    throw new OrchestrationError("write_bytes_exceeded", "본문이 승인된 바이트 상한을 넘는다");
  }
  requireNoFollow();
  return publish(auth, op, bytes, sha256Hex(bytes));
}

/**
 * 발행 트랜잭션 하나. **모든 자원 정리는 `finally` 하나에 모여 있다** — 어떤 단계가 실패해도
 * 열린 fd는 전부 닫히고 **이 호출이 만든 temp만** 사라진다(남의 파일은 신원이 다르므로 건드리지 않는다).
 * OS 오류는 전부 안정 코드로 접으며 경로·내용을 메시지에 담지 않는다.
 */
function publish(auth: DispatchAuthority, op: TypedWriteFileOperation, bytes: Buffer, intended: string): OperationReceipt {
  const fds: number[] = [];
  let temp: string | null = null;
  let tempIdent: Ident | null = null;
  try {
    seam("parentWalk");
    const walk = walkParents(auth.workspaceRoot, op.path);

    const dirFd = openSync(walk.parent, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    fds.push(dirFd);
    const dirSt = fstatSync(dirFd);
    if (!dirSt.isDirectory()) throw writeFailed("부모가 디렉터리가 아니다");
    if (!sameIdent(identOf(dirSt), walk.parentIdent)) throw writeFailed("부모 디렉터리 신원이 확인 사이에 바뀌었다");

    // ── 대상 preimage: 열어 둔 fd로 신원과 내용을 함께 확정한다(경로 재오픈 없음).
    seam("targetOpen");
    let before: string | null = null;
    let targetFd: number | null = null;
    let targetIdent: Ident | null = null;
    let targetSize = 0;
    const seen = lstatOrNull(walk.target);
    if (seen !== null) {
      if (seen.isSymbolicLink()) throw symlinkRefused("대상이 symlink다(따라가지 않는다)");
      if (!seen.isFile()) throw notRegular("대상이 일반 파일이 아니다");
      try {
        targetFd = openSync(walk.target, fsConstants.O_RDONLY | O_NOFOLLOW);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw symlinkRefused("대상이 symlink다(따라가지 않는다)");
        if (code === "ENOENT") throw writeFailed("대상이 판정 중에 사라졌다");
        throw writeFailed("대상을 열 수 없다");
      }
      fds.push(targetFd);
      const st = fstatSync(targetFd);
      if (!st.isFile()) throw notRegular("대상이 일반 파일이 아니다");
      if (!sameIdent(identOf(st), identOf(seen))) throw writeFailed("대상이 판정 중에 다른 파일로 바뀌었다");
      if (st.size > MAX_PREIMAGE_BYTES) {
        // preimage를 판정할 수 없다 → 조용히 덮어쓰지 않는다(fail closed).
        return receipt(op, "write_conflict", op.path, null, auth.nowIso);
      }
      targetIdent = identOf(st);
      targetSize = st.size;
      before = digestOfFd(targetFd, targetSize);
    }

    // 크래시 창: 이미 의도한 바이트가 있다 → 다시 쓰지 않는다(DECISIONS 2026-07-30 결정 1).
    if (before === intended) return receipt(op, "already_applied", op.path, intended, auth.nowIso);
    // 기대한 preimage가 아니다 → 한 바이트도 쓰지 않는다.
    if (op.expectedBeforeSha256 === null ? before !== null : before !== op.expectedBeforeSha256) {
      return receipt(op, "write_conflict", op.path, null, auth.nowIso);
    }

    // ── 우리 temp를 배타 생성해 정확한 바이트를 쓴다.
    seam("tempCreate");
    const candidate = join(walk.parent, `.m5c-write-${randomBytes(12).toString("hex")}.tmp`);
    let tempFd: number;
    try {
      // `O_RDWR` — **같은 fd로 쓰고 그 fd로 다시 읽어 확인한다**(경로 재오픈 없음 → 확인한 inode와
      // 발행되는 inode가 갈라지지 않는다). 그래서 읽기 권한이 필요하다.
      tempFd = openSync(candidate, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    } catch {
      throw writeFailed("배타 temp를 만들 수 없다");
    }
    fds.push(tempFd);
    temp = candidate;
    tempIdent = identOf(fstatSync(tempFd));

    seam("tempWrite");
    let off = 0;
    while (off < bytes.byteLength) {
      const n = writeSync(tempFd, bytes, off, bytes.byteLength - off, off);
      if (n <= 0) throw writeFailed("temp에 끝까지 쓰지 못했다");
      off += n;
    }
    fsyncSync(tempFd);

    seam("tempVerify");
    const wrote = fstatSync(tempFd);
    if (wrote.size !== bytes.byteLength) throw writeFailed("temp 크기가 의도와 다르다");
    if (!sameIdent(identOf(wrote), tempIdent)) throw writeFailed("temp fd가 다른 파일을 가리킨다");
    // **확인 fd를 닫지 않고** 발행까지 들고 간다 — 확인한 inode와 발행되는 inode가 갈라지지 않는다.
    if (digestOfFd(tempFd, wrote.size) !== intended) throw writeFailed("temp 내용이 의도와 다르다");

    // ── 발행 직전 재확인. 여기까지의 모든 판정은 **이름이 아니라 신원**으로 다시 본다.
    seam("publish");
    const again = walkParents(auth.workspaceRoot, op.path);
    if (again.parent !== walk.parent || !sameIdent(again.parentIdent, walk.parentIdent)) {
      throw writeFailed("부모 디렉터리가 발행 직전에 교체됐다");
    }
    if (!sameIdent(identOf(fstatSync(dirFd)), walk.parentIdent)) {
      throw writeFailed("부모 디렉터리 신원이 발행 직전에 바뀌었다");
    }
    const tempNow = lstatOrNull(temp);
    if (tempNow === null || tempNow.isSymbolicLink() || !tempNow.isFile() || !sameIdent(identOf(tempNow), tempIdent)) {
      throw writeFailed("temp 경로가 이 호출이 만든 파일을 더 이상 가리키지 않는다");
    }

    if (targetFd === null) {
      // **부재 대상은 덮어쓰지 않는 원자적 발행**: `link(2)`는 대상이 있으면 `EEXIST`다(Node 18+).
      // 그래서 경쟁적으로 만들어진 파일을 이 경로가 삼키는 일이 없다.
      try {
        linkSync(temp, walk.target);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw writeFailed("발행 직전에 대상이 생겼다(덮어쓰지 않는다)");
        throw writeFailed("대상 이름을 만들 수 없다");
      }
      // temp 이름은 방금 발행한 **같은 inode**이므로 이름 하나만 지운다(내용은 대상에 남는다).
      const created = temp;
      const ours = tempIdent;
      temp = null;
      removeOwnedTemp(created, ours);
    } else {
      // **교체는 preimage 신원·내용을 발행 직전에 다시 확인한 뒤에만** 한다.
      const st = fstatSync(targetFd);
      if (!st.isFile() || !sameIdent(identOf(st), targetIdent!) || st.size !== targetSize) {
        throw writeFailed("대상이 발행 직전에 바뀌었다(덮어쓰지 않는다)");
      }
      if (digestOfFd(targetFd, st.size) !== before) {
        throw writeFailed("대상 내용이 발행 직전에 바뀌었다(덮어쓰지 않는다)");
      }
      const named = lstatOrNull(walk.target);
      if (named === null || named.isSymbolicLink() || !named.isFile() || !sameIdent(identOf(named), targetIdent!)) {
        throw writeFailed("대상 경로가 확인한 파일을 더 이상 가리키지 않는다(덮어쓰지 않는다)");
      }
      // ponytail: `rename(2)`은 **경로 이름**을 받으므로 위 확인과 이 호출 사이의 좁은 syscall 창은 0이
      // 아니다(대장 `C-5`). Node 18에는 `renameat2`·디스크립터 상대 발행이 없어 이 창을 없앨 수 없다 —
      // 네이티브 의존성을 만들지 않고, 없앴다고 주장하지도 않는다.
      renameSync(temp, walk.target);
      temp = null;
    }

    seam("postVerify");
    const after = lstatOrNull(walk.target);
    if (after === null || after.isSymbolicLink() || !after.isFile() || !sameIdent(identOf(after), tempIdent)) {
      throw writeFailed("발행된 대상이 이 호출이 만든 파일이 아니다");
    }

    // **디렉터리 fsync까지 성공해야 `applied`다.** 실패하면 바이트는 발행됐지만 durability를 확인하지
    // 못했으므로 영수증을 주지 않는다 — 재시도는 현재 내용 hash가 의도와 같아 `already_applied`가 된다.
    try {
      seam("dirFsync");
      fsyncSync(dirFd);
    } catch {
      throw new OrchestrationError(
        "write_durability_unconfirmed",
        "바이트는 발행됐지만 디렉터리 durability를 확인하지 못했다(재시도는 already_applied로 수렴한다)",
      );
    }
    return receipt(op, "applied", op.path, intended, auth.nowIso);
  } catch (e) {
    // OS·seam 오류는 **닫힌 안정 코드**로 접는다(경로·내용을 담지 않는다).
    throw e instanceof OrchestrationError ? e : writeFailed("집행 중 파일 시스템 오류가 났다");
  } finally {
    if (temp !== null && tempIdent !== null) removeOwnedTemp(temp, tempIdent);
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        /* 닫기 실패는 판정을 바꾸지 않는다 — 바이트 durability는 이미 fsync로 확정됐다 */
      }
    }
  }
}

/**
 * **이 호출이 만든 temp만** 지운다(신원이 다르면 남의 파일이므로 건드리지 않는다).
 *
 * ponytail: 정리도 **경로 이름**으로만 할 수 있다(Node 18에는 `unlinkat`이 없다). 그래서 발행 도중
 * **부모 디렉터리 이름 자체가 교체된** 적대적 경우에는 이 경로가 더 이상 우리 temp를 가리키지 않고,
 * 그때는 **아무것도 지우지 않는다** — 남의 파일을 지우는 것보다 우리 temp 하나가 진짜 디렉터리에
 * 남는 편이 안전하다(그 파일은 0600 · 미참조 · 발행되지 않았다). 대장 `C-5`/`C-39`와 같은 계열의
 * 잔여 한계이며, 디스크립터 상대 API를 채택하면 그때 닫는다.
 */
function removeOwnedTemp(temp: string, ours: Ident): void {
  try {
    const st = lstatOrNull(temp);
    if (st && !st.isSymbolicLink() && st.isFile() && sameIdent(identOf(st), ours)) unlinkSync(temp);
  } catch {
    /* 정리 실패는 집행 판정을 바꾸지 않는다(대장 `C-39`와 같은 종류) */
  }
}
