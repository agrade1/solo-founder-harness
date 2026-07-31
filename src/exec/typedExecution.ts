/**
 * V3 M5c — **controller 소유 typed operation 권위 집행의 공개 facade**(대장 `B-10`의 집행면).
 *
 * 이 모듈이 존재하는 이유는 하나다: **worker가 고를 수 있는 것은 `authorityId` 하나뿐**이고, 그것이
 * 무엇을 뜻하는지는 사람이 승인한 `manifest.operationAuthorityByTask`가 정한다는 계약을 *실제로 집행*하는
 * 코드가 필요하기 때문이다(M5b까지는 선언에 대한 화면만 있었다 — 대장 `B-10`).
 *
 * **권위의 출처는 kernel 하나다(3A 리비전 A2).** 1차 판은 `OperationDispatchContext`라는 **평범한 구조적
 * 객체**를 받았다 → 위조한 manifest·ownership·workspaceRoot를 담은 객체 하나로 `../victim` 쓰기와 프로세스
 * 명세를 얻을 수 있었고, 만료·예산 deadline·task lifecycle·attempt 신원은 아예 보지 않았다. 지금은
 * **kernel이 발급한 봉인 permit/grant**만 받고, 효과·명세 발급 **직전마다**
 * `orchestrationKernel.readDispatchAuthority()`로 **현재 durable 상태**를 다시 읽는다.
 *
 * **집행기는 고정이고 kernel 모듈 안에 있다(3A 4차 리비전 A2 · 5차 리비전 A3).** 4차 판은 파일 시스템
 * 판정을 별도 `src/exec/writeFileEffect.ts`에 두고 `judgeWriteFile(auth, op)`를 **export**했으므로,
 * 그 모듈을 직접 import하면 **위조한 구조적 `DispatchAuthority`** 하나로 파일을 열어 hash하고 디렉터리를
 * fsync하고 성공 marker까지 받을 수 있었다(진짜 permit·과금·현재 durable 상태 확인 0). 그래서 그 파일을
 * **없앴다**: 효과 함수는 이제 grant 등록부와 같은 모듈의 **사설 함수**이고, 유일한 진입점은 진짜 grant를
 * 요구하는 `orchestrationKernel.executeWriteFileOperation`이다.
 * **임의 콜백을 받는 공개 API도, 위조 authority로 도달하는 집행기도 존재하지 않는다.**
 *
 * 이 모듈이 하는 것:
 * 1. `resolveWriteFileAuthority()` — 승인 레코드 대조(deny-by-default · 파일 시스템 무접촉).
 * 2. `applyWriteFile()` — kernel 고정 진입점에 대한 **얇은 이름**(계획·계약 그대로). 발행(신규 파일 생성)은
 *    3A 3차 리비전 A4에서 **fail closed**가 됐고(대장 `B-16`), 남은 것은 바이트를 만들지 않는 판정뿐이다.
 * 3. `resolveProcessLaunchCapability()` — 승인 레코드에서만 나오는 **opaque 일회용 실행 권능**.
 *    **spawn하지 않고**, 실행 대상·argv·digest를 밖으로 드러내지도 않는다(3A 3차 리비전 B2).
 *
 * 계획의 닫힌 validator와 계약 상수는 `typedPlan.ts`에 있고, `write_file`의 파일 시스템 판정과 순수 권위
 * 해석은 `orchestrationKernel.ts`에 있다. 호환을 위해 둘 다 여기서 그대로 재수출한다.
 *
 * 이 모듈이 **하지 않는** 것: 프로세스 spawn · shell · PATH 조회 · 환경 상속 · git · 네트워크 ·
 * dependency 설치 · provider 호출 · 디렉터리 생성 · symlink 추적. 표현할 타입도 통로도 없다.
 *
 * **오류·영수증에 내용은 담지 않는다.** 계획 본문 · 파일 내용 · prompt · stdout/stderr · argv · secret ·
 * 핸들 · 절대 경로는 오류 메시지에도 영수증에도 로그에도 들어가지 않는다 — 필드 이름과 규칙만 적는다.
 */
import { type ControllerAction, OrchestrationError } from "./orchestrationTypes.js";
import {
  DISPATCH_AUTHORITY_CODES,
  WRITE_EFFECT_CODES,
  executeWriteFileOperation,
  readDispatchAuthority,
  resolveApprovedOperation,
  resolveWriteAuthority,
  type OperationOutcome,
} from "./orchestrationKernel.js";
import type { TypedWriteFileOperation, TypedRunProcessOperation } from "./typedPlan.js";
import type { ApprovedOperation } from "./orchestrationTypes.js";

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
// 파일 시스템 판정의 테스트 seam은 kernel 모듈이 정본이다(같은 이름으로 재수출한다).
export { __setPublicationSeamsForTest } from "./orchestrationKernel.js";
export type { PublicationSeam } from "./orchestrationKernel.js";
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
 * permit 검증 단계의 코드는 `orchestrationKernel.DISPATCH_AUTHORITY_CODES`가 정본이고,
 * `write_file` 집행 단계의 코드는 `orchestrationKernel.WRITE_EFFECT_CODES`가 정본이다.
 */
export const TYPED_EXECUTION_CODES = [
  /** 계획이 계약 밖이다(미상 key · 타입 · 상한 · binding 불일치 · accessor/proxy 포함). */
  "plan_invalid",
  /**
   * 집행 단계의 닫힌 코드(정본은 `orchestrationKernel.ts`):
   * - `operation_denied` — 이 task의 이 authorityId가 승인되지 않았거나 kind가 승인 레코드와 다르다.
   * - `operation_not_owned` / `operation_outside_writable_root` — 승인은 있으나 durable 범위 밖이다.
   * - `write_bytes_exceeded` — 본문이 `min(승인 maxBytes, LIMITS.maxWriteBytes)`를 넘는다.
   * - `write_path_symlink` / `write_target_not_regular` — symlink는 따라가지 않고 비일반 파일은 쓰지 않는다.
   * - `write_failed` — 그 밖의 집행 실패(부모 부재 · I/O · 신원 불일치). 내용은 담지 않는다.
   * - `write_replace_unsupported` / `write_publish_unsupported` — 예방 안전한 발행 primitive가 없어
   *   **판정 단계에서** 거부한다(3A 2차 A3 · 3차 A4 · 대장 `B-16`).
   * - `write_durability_unconfirmed` — 디렉터리 fsync를 확인하지 못했다(성공 영수증 없음).
   * - `write_cleanup_unconfirmed` — fd 반납을 확인하지 못했다(1차 오류에 가려지지 않는다).
   */
  ...WRITE_EFFECT_CODES,
  ...DISPATCH_AUTHORITY_CODES,
] as const;
export type TypedExecutionCode = (typeof TYPED_EXECUTION_CODES)[number];

// ── 권위 해석 (deny-by-default · 부수 효과 0) ─────────────────────────────────

function denied(what: string): OrchestrationError {
  return new OrchestrationError("operation_denied", `승인되지 않은 typed operation이다: ${what}`);
}

/**
 * `write_file` 권위 해석(공개 진입점 — **봉인 permit/grant가 필요하다**).
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
 * **이 세션은 launcher를 만들지 않는다(spawn 0).** 미래 launcher가 지켜야 하는 계약은 명시적이다
 * (대장 `B-F1` — 첫 managed-launcher 소비자 전에 필수): ① 이 권능을 **한 번** 소비하고
 * ② 소비 시점에 **현재 durable 상태를 다시 읽고**(살아 있는 pending/grant 확인)
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
 * 지금 이 함수는 **순수 판정**이며(`readDispatchAuthority`), `run_process`에는 **성공 집행기가 아예
 * 없다** — kernel에 `executeRunProcessOperation` 같은 진입점이 존재하지 않으므로 pending은
 * `failOperation(denied|failed)` 또는 safety-only 정합화로만 닫힌다. **성공을 만들 통로가 없다.**
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

// ── write_file 집행 (kernel 고정 진입점에 대한 얇은 이름) ─────────────────────

/**
 * **승인된 typed 파일 쓰기 1건을 집행한다.**
 *
 * 실제 순서·게이트·durable 표시는 전부 kernel의 `executeWriteFileOperation()`에 있다(3A 4차 리비전 A2 —
 * grant를 소비하는 코드는 **kernel 소유 고정 진입점**뿐이어야 하기 때문이다). 여기서는 이름만 유지한다:
 * 1. 일회용 grant → 현재 durable 권위 재확인(만료·토큰·**권위로 과금된 생산 turn**·예산 deadline·
 *    attempt wall·no-progress·lifecycle·attempt/turn·claim된 계획·preflight·manifest 정본).
 * 2. **durable pending을 `attemptedAt`으로 표시**(외부 효과가 일어났을 수 있다는 사실을 먼저 적는다).
 * 3. **표시 커밋 이후에 권위를 다시 전수 확인한다**(3A 5차 리비전 A4 — 그 커밋은 safety-only라 deadline을
 *    보지 않으므로, 커밋 도중 만료·예산·wall·no-progress 경계를 지났으면 여기서 fail closed다).
 * 4. kernel 사설 고정 집행기를 **정확히 한 번** 부른다(직접 import로 도달할 통로가 없다 — 5차 A3).
 * 5. 정상 반환값만 canonical 결과로 굳혀 **opaque outcome handle**을 돌려준다 —
 *    호출자가 marker·경로·hash를 바꿔 넣을 수 없다.
 */
export function applyWriteFile(op: TypedWriteFileOperation, grant: unknown): Readonly<OperationOutcome> {
  return executeWriteFileOperation(grant, op);
}
