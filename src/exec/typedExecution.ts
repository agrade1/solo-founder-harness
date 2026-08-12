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
 * 호출자 콜백의 **반환값을 canonical 결과로 채택하는 집행 API**도, 위조 authority로 도달하는 집행기도
 * 존재하지 않는다. 단, kernel이 재수출하는 shipped 테스트 seam은 임의 closure를 받으며 ambient 파일
 * 권한 코드가 canonical 판정을 유도할 수 있다(대장 `C-1` — 진짜 grant·승인 경로/내용은 계속 필요).
 *
 * 이 모듈이 하는 것:
 * 1. `resolveWriteFileAuthority()` — 승인 레코드 대조(deny-by-default · 파일 시스템 무접촉).
 * 2. `applyWriteFile()` — kernel 고정 진입점에 대한 **얇은 이름**(계획·계약 그대로). **M5d에서 `B-16`이
 *    부분 개방됐다**: 승인된 **기존 파일 교체**는 고정한 대상 fd에 직접 써서 실제 바이트를 낸다(원자성은
 *    없고 torn은 fail closed로 표면화된다). **신규 파일 생성은 여전히 fail closed**다.
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
import { OrchestrationError } from "./orchestrationTypes.js";
import {
  DISPATCH_AUTHORITY_CODES,
  PROCESS_EFFECT_CODES,
  WRITE_EFFECT_CODES,
  executeWriteFileOperation,
  readDispatchAuthority,
  resolveWriteAuthority,
  type OperationOutcome,
} from "./orchestrationKernel.js";
import type { TypedWriteFileOperation } from "./typedPlan.js";
import type { ApprovedOperation } from "./orchestrationTypes.js";

// 계획 계약은 순수 모듈이 정본이다. 기존 호출부·테스트 호환을 위해 같은 이름으로 재수출한다.
export {
  DELIVER_STATUS_REQUEST_KEYS,
  LONE_SURROGATE_PATTERN,
  NORMALIZED_WORKSPACE_PATH_PATTERN,
  RUN_PROCESS_OPERATION_KEYS,
  SPAWN_CHILD_REQUEST_KEYS,
  TYPED_PLAN_BINDING_KEYS,
  TYPED_PLAN_KEYS,
  TYPED_PLAN_KEYS_WITH_REQUESTS,
  TYPED_PLAN_OUTPUT_KEYS,
  TYPED_PLAN_RESULT_KEYS,
  WINDOWS_DRIVE_PATTERN,
  WRITE_FILE_OPERATION_KEYS,
  readOwnArray,
  readOwnData,
  validateTypedExecutionPlan,
} from "./typedPlan.js";
export type { PlanBinding, TypedRunProcessOperation, TypedWriteFileOperation } from "./typedPlan.js";
// 파일 시스템 판정의 테스트 seam **setter는 이 production facade에서 재수출하지 않는다**(대장 `C-1`).
// 타입만 남긴다 — 타입은 런타임 표면이 아니다. 등록 함수는 kernel 모듈에만 있고, 거기서 다시
// "호출자가 `*.test.ts`" 조건으로 막힌다(자세한 근거는 orchestrationKernel.ts의 seam 주석).
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
   * - `write_publish_unsupported` — **부재 대상 발행**은 여전히 fail closed다(3A 3차 A4 · 대장 `B-16`
   *   잔여): 고정할 fd가 없어 최종 `link(2)`가 pathname을 지나야 하고 그 창을 예방할 수 없다.
   * - `write_apply_incomplete` — **M5d `B-16` 부분 개방**: 고정한 대상 fd에 쓰는 도중 실패했다.
   *   내용이 torn일 수 있고 재시도는 preimage 불일치로 막힌다(사람이 개입할 때까지 fail closed).
   * - `write_replace_unsupported` — **더 이상 발생하지 않는다**(M5d 이전 계약의 잔존 코드).
   *   기존 대상 교체는 이제 고정한 fd에 직접 써서 집행한다 — 발행 경로에 pathname이 없다.
   * - `write_durability_unconfirmed` — 디렉터리 fsync를 확인하지 못했다(성공 영수증 없음).
   * - `write_cleanup_unconfirmed` — fd 반납을 확인하지 못했다(1차 오류에 가려지지 않는다).
   */
  ...WRITE_EFFECT_CODES,
  /**
   * `run_process` 집행 단계의 닫힌 코드(정본은 `orchestrationKernel.PROCESS_EFFECT_CODES` — 대장 `B-F1`):
   * `process_capability_invalid` / `process_capability_spent` / `process_spawn_limit_exceeded` /
   * `process_executable_untrusted` / `process_digest_mismatch` / `process_launch_failed` /
   * `process_deadline_exceeded` / `process_cleanup_unconfirmed`.
   */
  ...PROCESS_EFFECT_CODES,
  ...DISPATCH_AUTHORITY_CODES,
] as const;
export type TypedExecutionCode = (typeof TYPED_EXECUTION_CODES)[number];

// ── 권위 해석 (deny-by-default · 부수 효과 0) ─────────────────────────────────

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
 * ⓑ 한 번 받은 명세를 취소·만료·attempt 교체 **이후에 재생**할 수 있었다.
 *
 * **M5c task 3C에서 등록부·발급·소비가 전부 `orchestrationKernel.ts`로 갔다**(대장 `B-F1` 개봉).
 * 이유는 A3가 `writeFileEffect.ts`를 없앤 것과 같다: 소비자(진짜 spawn)가 kernel 밖에 있으면 그 함수는
 * **권능을 인자로 받는 공개 함수**가 되고, 위조한 구조적 권능 하나가 곧 로컬 실행 권위가 된다.
 * 여기서는 계획·호출부 호환을 위해 **이름만** 재수출한다.
 */
export {
  executeRunProcessOperation,
  isGenuineLaunchCapability,
  resolveProcessLaunchCapability,
} from "./orchestrationKernel.js";
export type { ProcessLaunchCapability } from "./orchestrationKernel.js";

/**
 * **trusted Git**(task 3D · 대장 `C-26`) — 등록부·집행기는 launch 권능과 **같은 이유로** kernel 안에 있고
 * 여기서는 이름만 재수출한다. 호출자가 고를 수 있는 것은 닫힌 enum 하나뿐이며 argv는 동결된 상수다:
 * remote · refspec · branch · 경로 · 커밋 메시지를 담을 필드가 존재하지 않으므로 push·PR/merge·네트워크
 * git은 **표현할 수 없다**(hard deny를 호출 규율이 아니라 타입으로 닫는다).
 */
export {
  TRUSTED_GIT_CODES,
  TRUSTED_GIT_QUERIES,
  executeTrustedGitQuery,
  isGenuineTrustedGitCapability,
} from "./orchestrationKernel.js";
export type { TrustedGitCapability, TrustedGitCode, TrustedGitQuery, TrustedGitResult } from "./orchestrationKernel.js";

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
