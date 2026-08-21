/**
 * V3 M5c — autopilot **런타임 계약**(durable state에 들어가지 않는 것들).
 *
 * durable 계약(state·manifest·event 필드)은 `orchestrationTypes.ts`에 있다. 여기 있는 것은
 * worker ↔ controller ↔ 프로세스 감독자 사이의 **메모리 안 계약**뿐이다:
 *
 * - `TypedExecutionPlan` — worker가 낼 수 있는 **유일한** 산출물. 데이터이고, callback·핸들·권위가 아니다.
 * - `WorkerEvent` — 진행/종료 프로토콜(`started → 진행 1건 이상 → 종료 정확히 1건 → 스트림 정상 종료`).
 * - `CleanupReceipt` — zero-survivor 확인 영수증(닫힌 형태).
 *
 * **여기 있는 어떤 타입도 파일 시스템·프로세스·git·provider·네트워크·환경을 표현하지 않는다.**
 * worker가 무엇을 할 수 있는지는 `authorityId` 하나를 고르는 것뿐이고, 그 id가 무엇을 뜻하는지는
 * 사람이 승인한 `manifest.operationAuthorityByTask`가 정한다(`orchestrationTypes.ApprovedOperation`).
 */
import { LIMITS, } from "./orchestrationTypes.js";
/** typed operation의 종류를 읽는 단일 지점(닫힌 union의 판별자). */
export function operationKind(op) {
    return op.kind;
}
/** turn 하나가 낼 수 있는 오케스트레이션 요청 수 상한. */
export const MAX_PLAN_REQUESTS = 8;
/** turn 하나에서 소비할 worker 이벤트 상한. */
export const MAX_WORKER_EVENTS = 1_024;
/** `progress` step 라벨 상한(코드 포인트) — 이 값은 durable state에 들어가지 않는다. */
export const MAX_PROGRESS_STEP_CHARS = 120;
export function isCleanupConfirmed(o) {
    return o.marker === "cleanup_confirmed" && o.survivors === 0;
}
/** operation 수 상한을 계획 검증과 controller가 같은 값으로 본다. */
export const MAX_PLAN_OPERATIONS = LIMITS.maxOperationsPerTurn;
