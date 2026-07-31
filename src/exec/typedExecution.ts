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
 * 2. `applyWriteFile()` — 승인된 typed 쓰기의 **판정과 정합화**. 3A 3차 리비전 A4에서 **발행(신규 파일
 *    생성)은 fail closed**가 됐다: Node 18/macOS에는 디스크립터 상대 no-replace 발행 primitive
 *    (`linkat`/`renameat2`)가 없어 최종 pathname syscall이 **교체된 부모를 통해 승인 범위 밖으로**
 *    발행될 수 있고, 그 창은 사후 검증·재확인·lock 파일로 닫히지 않기 때문이다. 남은 것은 **바이트를
 *    만들지 않는** 경로뿐이다: 이미 의도한 내용이면 `already_applied`(부모 fsync 확인 뒤) · preimage
 *    불일치면 `write_conflict` · 기존 대상 교체는 `write_replace_unsupported` · 신규 발행은
 *    `write_publish_unsupported`.
 * 3. `resolveProcessLaunchCapability()` — 승인 레코드에서만 나오는 **opaque 일회용 실행 권능**.
 *    **spawn하지 않고**, 실행 대상·argv·digest를 밖으로 드러내지도 않는다(3A 3차 리비전 B2).
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
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { LIMITS, OrchestrationError, type ApprovedOperation, type ControllerAction } from "./orchestrationTypes.js";
import { pathWithin, approvedOperationFor } from "./approvalManifest.js";
import { sha256Hex } from "./orchestrationStore.js";
import {
  DISPATCH_AUTHORITY_CODES,
  executeUnderGrant,
  readDispatchAuthority,
  type DispatchAuthority,
  type OperationOutcome,
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
export type {
  DispatchAuthority,
  OperationDispatchPermit,
  OperationExecutionGrant,
  OperationOutcome,
} from "./orchestrationKernel.js";

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
   * **기존 경로 교체는 예방 안전하게 만들 수 없어 거부한다**(3A 2차 리비전 A3).
   * Node 18에는 디스크립터 상대 compare-and-publish(`renameat2`/`RENAME_EXCHANGE`)가 없어 최종 pathname
   * `rename(2)` 직전 창을 0으로 만들 수 없다 → 경쟁자 바이트 파괴·승인 부모 밖 발행이 **가능하다**.
   * 그래서 **판정 단계에서** 거부한다.
   */
  "write_replace_unsupported",
  /**
   * **신규 파일 발행도 예방 안전하게 만들 수 없어 거부한다**(3A 3차 리비전 A4).
   *
   * `link(2)`는 두 **pathname**을 받는다. 최종 부모 신원 확인과 syscall 사이에 같은 사용자 권한의 경쟁자가
   * 승인된 부모를 rename하고 그 이름을 다른 디렉터리·symlink로 바꾸면, 커널은 **그 교체본을 통해** 경로를
   * 해석해 승인 범위 **밖으로** 바이트를 발행한다. 발행된 inode는 우리 temp와 같으므로 사후 inode 검증은
   * 통과하고, fsync는 **엉뚱한 디렉터리 fd**에 걸린다 → 사후 검증·재확인·lock 파일·토큰 화면 어느 것도
   * 이 창을 닫지 못한다.
   *
   * Node 18/macOS 내장에는 디스크립터 상대 no-replace 발행(`linkat(AT_FDCWD 대체)`)이 없고, 이 세션은
   * 신규 런타임 의존성·네이티브 helper·자식 프로세스를 만들 수 없다. 그래서 **fail closed**다:
   * 안전하게 증명할 수 없는 발행 경로는 **시도하지 않는다**(temp도 만들지 않는다).
   * 남는 안전 경로는 바이트를 만들지 않는 판정·정합화뿐이다.
   */
  "write_publish_unsupported",
  /**
   * 바이트는 발행됐지만 **요구된 durability를 확인하지 못했다**(디렉터리 fsync 실패).
   * `applied` 영수증을 주지 않는다. 재시도는 **부모 fsync에 성공해야만** `already_applied`가 되고,
   * fsync가 계속 실패하면 계속 이 코드다(3A 2차 리비전 A4 — "재시도가 durability를 증명한다"는 거짓 성공 차단).
   */
  "write_durability_unconfirmed",
  /**
   * 발행·판정 자체는 끝났지만 **fd 반납 또는 소유 temp 정리를 확인하지 못했다**(3A 2차 리비전 B1).
   * 성공 영수증을 주지 않는다 — 정리 실패를 성공으로 삼키는 경로가 없다. durable pending operation 레코드가
   * 정합화 신원이며, 남을 수 있는 temp는 **0바이트로 절단된** `.m5c-op-<opTag>-*.tmp`뿐이다(내용 노출 없음).
   */
  "write_cleanup_unconfirmed",
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
 * **opaque 일회용 실행 권능**(3A 3차 리비전 B2로 `B-10`의 launch 면을 닫는다).
 *
 * 이전 판은 `ProcessLaunchSpec`이라는 **공개 구조적 인터페이스**였다: 실행 파일 경로 · digest ·
 * 파생 argv가 전부 필드로 노출됐고, 그래서 ⓐ 호출자가 같은 모양의 객체를 **직접 만들 수** 있었으며
 * ⓑ 한 번 받은 명세를 취소·만료·attempt 교체 **이후에 재생**할 수 있었다. 미래 launcher가 그 명세를
 * 그대로 믿으면 그 둘이 곧 로컬 실행 권위가 된다.
 *
 * 지금 돌려주는 값은 **감사용 신원만** 담은 동결 객체이고, 실행 대상(node 경로·entrypoint·digest·
 * timeout·action data)은 **이 모듈 사설 레코드에만** 있다. 권위는 등록부 연결에서만 나오므로 전개
 * 사본(`{...cap}`)·수제 객체·`Proxy`는 아무것도 얻지 못한다.
 *
 * **이 세션은 launcher를 만들지 않는다(spawn 0).** 미래 launcher가 지켜야 하는 계약은 명시적이다:
 * ① 이 권능을 **한 번** 소비하고 ② 소비 시점에 **현재 durable 상태를 다시 읽고**
 * ③ spawn 직전에 node·entrypoint **두 파일의 digest를 모두** 재검증한다
 * (`executionBoundary.verifyApprovedExecutable`). 그 소비 함수는 launcher 슬라이스가 소유한다 —
 * 여기서 미리 열지 않는다(열어 두는 순간 그것이 곧 공개 실행 권위다).
 */
export interface ProcessLaunchCapability {
  readonly operationId: string;
  readonly authorityId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly turnId: string;
}

/** 권능 뒤에 숨은 실제 실행 명세(모듈 사설 — 밖으로 나가는 통로가 없다). */
interface LaunchRecord {
  executable: string;
  sha256: string;
  entrypoint: string;
  entrypointSha256: string;
  action: ControllerAction;
  planPath: string;
  timeoutMs: number;
  spent: boolean;
}

const GENUINE_LAUNCH_CAPABILITIES = new WeakMap<object, LaunchRecord>();

/**
 * `run_process` 권위 해석. **spawn하지 않고 grant도 소비하지 않는다**(3A 3차 리비전 A2):
 * 아무것도 실행하지 않는 계획 단계가 "집행했다"는 상태를 만들면 그것만으로 성공 영수증이 나왔다.
 * 지금 이 함수는 **순수 판정**이며(`readDispatchAuthority`), 그래서 `run_process` pending은
 * 실제 launcher가 생기기 전까지 `failOperation(denied|failed)`으로만 닫힌다 — **성공을 만들 통로가 없다.**
 */
export function resolveProcessLaunchCapability(op: TypedRunProcessOperation, handle: unknown): ProcessLaunchCapability {
  const auth = readDispatchAuthority(handle, op);
  const approved = resolveApprovedOperation(op, auth);
  if (approved.kind !== "run_process") throw denied("승인 레코드의 kind와 다르다");
  const node = auth.manifest.executionAuthority.node;
  const entry = auth.manifest.executionAuthority.controllerEntrypoint;
  const capability: ProcessLaunchCapability = Object.freeze({
    operationId: op.operationId,
    authorityId: op.authorityId,
    runId: auth.runId,
    taskId: auth.taskId,
    attemptId: auth.attemptId,
    turnId: auth.turnId,
  });
  GENUINE_LAUNCH_CAPABILITIES.set(capability, {
    executable: node.path,
    sha256: node.sha256,
    entrypoint: entry.path,
    entrypointSha256: entry.sha256,
    action: approved.action,
    planPath: approved.data.planPath,
    timeoutMs: approved.timeoutMs,
    spent: false,
  });
  return capability;
}

/** 이 모듈이 발급한 진짜 실행 권능인가(테스트·감사용 판정 — 실행 명세는 돌려주지 않는다). */
export function isGenuineLaunchCapability(v: unknown): boolean {
  return typeof v === "object" && v !== null && GENUINE_LAUNCH_CAPABILITIES.has(v);
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
 * (`readDispatchAuthority` → 승인 레코드 대조)은 **모든 seam보다 먼저** 끝나고, 판정 직전 신원 확인은
 * seam **뒤에** 다시 돈다. 즉 seam으로 할 수 있는 것은 "파일 시스템을 흔들거나 던지는 것"뿐이고,
 * 그때 이 모듈은 반드시 안정 코드로 거부하며 fd를 남기지 않는다 — 그것이 테스트가 증명하는 것이다.
 * ponytail: 결정론적 경쟁 재현에는 이 방법밖에 없다. 실제 병렬 프로세스로 바꿀 이유가 생기면 그때 바꾼다.
 *
 * 3A 3차 리비전 A4로 발행 경로가 사라지면서 temp 관련 seam(`tempCreate`/`tempWrite`/`tempVerify`/
 * `postVerify`)도 함께 사라졌다 — 그 단계가 **존재하지 않는다**는 것이 지금의 계약이다.
 */
export type PublicationSeam = "parentWalk" | "targetOpen" | "publish" | "dirFsync";

let SEAMS: Partial<Record<PublicationSeam, () => void>> = {};

/** 테스트 전용. 돌려주는 함수를 부르면 원상복구된다(테스트 사이에 상태가 새지 않는다). */
export function __setPublicationSeamsForTest(seams: Partial<Record<PublicationSeam, () => void>>): () => void {
  const previous = SEAMS;
  SEAMS = seams;
  return () => {
    SEAMS = previous;
  };
}

/**
 * hook이 던진 것은 **무엇이든** `write_failed`로 정규화한다(3A 2차 리뷰 `C1`).
 * 이전에는 hook이 던진 `OrchestrationError`가 그대로 밖으로 나가 **호출자가 production 오류 taxonomy를
 * 고를 수 있었다**. 지금 seam으로 할 수 있는 것은 "파일 시스템을 흔들거나 실패시키는 것"뿐이다.
 */
function seam(name: PublicationSeam): void {
  const hook = SEAMS[name];
  if (hook === undefined) return;
  try {
    hook();
  } catch {
    throw writeFailed("발행 seam이 실패를 주입했다");
  }
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

type EffectMarker = "applied" | "already_applied" | "write_conflict" | "denied" | "failed";

interface EffectResult {
  marker: EffectMarker;
  path: string | null;
  resultSha256: string | null;
  exitCode: number | null;
}

/** 집행기가 낸 결과 1건(내용은 담지 않는다 — marker·경로·결과 hash만). */
function outcome(marker: EffectMarker, path: string | null, resultSha256: string | null): EffectResult {
  return { marker, path, resultSha256, exitCode: null };
}

/**
 * **승인된 typed 파일 쓰기 1건을 판정·정합화한다.**
 *
 * 순서가 계약이다:
 * 1. **일회용 execution grant → 현재 durable 권위**(만료·토큰·**과금된 turn**·예산 deadline·attempt wall·
 *    no-progress·lifecycle·attempt/turn·claim된 계획·preflight·manifest 정본). grant는 여기서 **소진된다**.
 * 2. 권위 해석(deny-by-default) → 정확한 경로 · dispatch 시점 ownership · writableRoots.
 * 3. 바이트 상한 = `min(승인 maxBytes, LIMITS.maxWriteBytes)`.
 * 4. no-follow 경로 walk(symlink·비일반 파일 거부) + 부모 디렉터리 신원을 **열린 fd로 고정**.
 * 5. 대상 preimage를 **열어 둔 fd 하나로** 확정(경로 재오픈 없음) → 판정 직전 부모 신원 **재확인**.
 * 6. **크래시 창 멱등**: 현재 내용이 의도한 내용과 같으면 `already_applied`(**부모 fsync 성공 뒤에만** — A4).
 * 7. preimage 불일치는 **쓰지 않고** `write_conflict`.
 * 8. 대상이 있고 내용이 다르면 `write_replace_unsupported`(3A 2차 A3).
 * 9. **대상이 없으면 `write_publish_unsupported`**(3A 3차 A4) — 예방 안전한 발행 primitive가 없어 아예
 *    시도하지 않는다. temp를 만들지 않으므로 고아 plaintext·unlink durability 문제도 함께 **사라진다**.
 *
 * **왜 발행이 사라졌는가(정직)**: `link(2)`/`rename(2)`는 pathname을 받고, 최종 부모 확인과 syscall 사이에
 * 같은 사용자 경쟁자가 승인된 부모 **이름**을 교체하면 커널이 그 교체본을 통해 경로를 해석한다 →
 * 승인 범위 밖 발행 + 엉뚱한 디렉터리 fsync. 발행된 inode는 우리 temp와 같으므로 **사후 검증은 통과한다**.
 * Node 18/macOS 내장에는 디스크립터 상대 no-replace 발행(`linkat`)이 없다.
 * `process.chdir(parent)` + basename `link`로 cwd를 디렉터리 참조처럼 쓰는 방법은 **평가했고 채택하지
 * 않았다**: 프로세스 전역 상태이며 worker thread에서 던지고, managed launcher가 자식을 띄우는 순간 자식
 * cwd까지 오염시킨다. 승인된 helper·의존성·자식 프로세스 없이 안전을 **증명할 수 없으므로 fail closed**다.
 *
 * 돌려주는 것은 kernel이 봉인한 **opaque outcome handle**이다 — 호출자가 marker·경로·hash를 바꿔 넣을 수 없다.
 */
export function applyWriteFile(op: TypedWriteFileOperation, grant: unknown): Readonly<OperationOutcome> {
  return executeUnderGrant(grant, op, (auth) => {
    const approved = resolveWriteAuthority(op, auth);
    const bytes = Buffer.from(op.content, "utf8");
    const bound = Math.min(approved.maxBytes, LIMITS.maxWriteBytes);
    if (bytes.byteLength > bound) {
      throw new OrchestrationError("write_bytes_exceeded", "본문이 승인된 바이트 상한을 넘는다");
    }
    requireNoFollow();
    // 정리 상태는 `finally`가 마지막에 적으므로 **호출자 쪽 holder**로 받는다 —
    // `finally` 안에서 반환값을 바꾸면 원래 예외를 삼키게 되기 때문이다.
    const status = { cleanupFailed: false };
    let result: EffectResult;
    try {
      result = judge(auth, op, sha256Hex(bytes), status);
    } catch (e) {
      // **1차 오류가 정리 미확인을 가리지 않는다**(3A 3차 리비전 B1): 둘 다 있으면 정리 미확인이 이기고
      // 1차 안정 **코드**만 메시지에 싣는다(경로·내용은 담지 않는다).
      if (status.cleanupFailed) throw cleanupUnconfirmed(e instanceof OrchestrationError ? e.code : "non_orchestration");
      throw e;
    }
    if (status.cleanupFailed) throw cleanupUnconfirmed(null);
    return result;
  });
}

function cleanupUnconfirmed(primaryCode: string | null): OrchestrationError {
  return new OrchestrationError(
    "write_cleanup_unconfirmed",
    primaryCode === null
      ? "판정은 끝났지만 fd 반납을 확인하지 못했다(성공 영수증을 내지 않는다)"
      : `판정이 ${primaryCode}로 실패했고 fd 반납도 확인하지 못했다(정리 미확인이 우선한다)`,
  );
}

/**
 * 판정 트랜잭션 하나. **바이트를 만들지 않는다** — 여는 것은 부모 디렉터리 fd와 (있으면) 대상 fd뿐이고
 * 모든 자원 반납은 `finally` 하나에 모여 있다. OS 오류는 전부 안정 코드로 접으며 경로·내용을 담지 않는다.
 *
 * **정리(= fd 반납) 실패는 성공이 되지 않는다**(3A 2차·3차 리비전 B1). temp를 만드는 경로가 사라졌으므로
 * **소유 잔재도 0**이다 — unlink durability · 고아 plaintext · truncate 폴백 문제는 남길 파일이 없어 성립하지 않는다.
 */
function judge(
  auth: DispatchAuthority,
  op: TypedWriteFileOperation,
  intended: string,
  status: { cleanupFailed: boolean },
): EffectResult {
  const fds: number[] = [];
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
    let targetExists = false;
    const seen = lstatOrNull(walk.target);
    if (seen !== null) {
      targetExists = true;
      if (seen.isSymbolicLink()) throw symlinkRefused("대상이 symlink다(따라가지 않는다)");
      if (!seen.isFile()) throw notRegular("대상이 일반 파일이 아니다");
      let targetFd: number;
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
        return outcome("write_conflict", op.path, null);
      }
      before = digestOfFd(targetFd, st.size);
    }

    // **판정을 내기 직전에 부모 신원을 다시 본다**(3A 3차 리비전 A4). 대상 조회는 pathname을 지나므로,
    // 이 재확인이 없으면 "승인된 부모 안에서 봤다"는 판정 자체가 교체된 디렉터리에 대한 것일 수 있다.
    seam("publish");
    const again = walkParents(auth.workspaceRoot, op.path);
    if (again.parent !== walk.parent || !sameIdent(again.parentIdent, walk.parentIdent)) {
      throw writeFailed("부모 디렉터리가 판정 중에 교체됐다");
    }
    if (!sameIdent(identOf(fstatSync(dirFd)), walk.parentIdent)) {
      throw writeFailed("부모 디렉터리 신원이 판정 중에 바뀌었다");
    }

    // 크래시 창: 이미 의도한 바이트가 있다 → 다시 쓰지 않는다(DECISIONS 2026-07-30 결정 1).
    // **단 부모 fsync에 성공해야 `already_applied`다**(3A 2차 리비전 A4): 앞선 시도가 fsync에서 실패했다면
    // 디렉터리 엔트리는 아직 durable하지 않고, "다시 보니 있더라"는 durability의 증거가 아니다.
    if (before === intended) {
      confirmDirDurability(dirFd);
      return outcome("already_applied", op.path, intended);
    }
    // 기대한 preimage가 아니다 → 한 바이트도 쓰지 않는다.
    if (op.expectedBeforeSha256 === null ? before !== null : before !== op.expectedBeforeSha256) {
      return outcome("write_conflict", op.path, null);
    }
    // **교체는 여기서 끝난다**(3A 2차 리비전 A3): 최종 pathname `rename(2)` 직전 창을 0으로 만들 수 없다.
    if (targetExists) {
      throw new OrchestrationError(
        "write_replace_unsupported",
        "기존 경로 교체는 예방 안전한 원자성을 보장할 수 없어 거부한다",
      );
    }
    // **신규 발행도 여기서 끝난다**(3A 3차 리비전 A4): 최종 `link(2)`도 pathname이므로 부모 교체 경쟁을
    // 예방할 수 없고, 사후 inode 검증은 그 창을 닫지 못한다(발행된 inode는 우리 것이 맞기 때문이다).
    // temp를 만들기 **전에** 끝나므로 파일 시스템 부작용이 **0**이다 — 테스트가 그것을 단정한다.
    throw new OrchestrationError(
      "write_publish_unsupported",
      "부재 대상 발행은 디스크립터 상대 no-replace primitive 없이 예방 안전하게 만들 수 없어 거부한다",
    );

    // ── 우리 temp를 배타 생성해 정확한 바이트를 쓴다.
  } catch (e) {
    // OS·seam 오류는 **닫힌 안정 코드**로 접는다(경로·내용을 담지 않는다).
    throw e instanceof OrchestrationError ? e : writeFailed("집행 중 파일 시스템 오류가 났다");
  } finally {
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        // **정리 실패도 실패다**(활성 계약 ⑥ · 3A 2차 리비전 B1): 반납하지 못한 fd를 성공으로 삼키지 않는다.
        status.cleanupFailed = true;
      }
    }
  }
}

/**
 * 발행된 이름의 **디렉터리 durability를 확인**한다. 실패는 `write_durability_unconfirmed`이고,
 * 재시도가 이 확인을 다시 지나지 못하면 계속 같은 코드다("다시 보니 있더라"는 durability가 아니다).
 */
function confirmDirDurability(dirFd: number): void {
  try {
    seam("dirFsync");
    fsyncSync(dirFd);
  } catch {
    throw new OrchestrationError(
      "write_durability_unconfirmed",
      "디렉터리 durability를 확인하지 못했다(재시도도 fsync에 성공해야 already_applied가 된다)",
    );
  }
}
