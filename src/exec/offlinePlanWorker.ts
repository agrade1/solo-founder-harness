/**
 * V3 M5c — **offline plan worker**: M5c의 유일한 worker backend이며 **데이터 어댑터**다.
 *
 * 이 파일이 지키는 계약은 한 문장으로 요약된다: **worker는 데이터만 받고 데이터만 낸다.**
 *
 * - 입력은 닫힌 key 집합의 순수 데이터 객체 하나뿐이다: backend 이름 · bounded UTF-8 JSON 바이트 ·
 *   controller가 소유한 실행 신원(binding). **파일 시스템 · 프로세스 · git · provider · 네트워크 ·
 *   환경 객체 · callback seam은 입력에 존재하지 않는다**(표현할 key가 없으므로 전달될 수도 없다).
 * - JSON은 **정확히 한 번** 파싱하고 `typedExecution.validateTypedExecutionPlan`(같은 닫힌 validator)로
 *   검증한 뒤 동결한다. 미상 key · getter/proxy · 함수 · symbol · 순환은 그 validator가 거부한다.
 * - 출력은 turn마다 **새로 만드는** bounded 이벤트 스트림뿐이다:
 *   `started → 인정되는 progress 1건 이상 → terminal 정확히 1건 → 정상 종료`.
 *   **최종 결과만 있는 스트림은 만들 수 없다**(`silent_session`이 구조적으로 불가능하다).
 * - `claude`·`codex`를 포함한 **미상 backend는 안정 hard reject**다. 실제 추론은 M5c에 없다.
 *
 * operation을 **집행하는 것은 worker가 아니라 controller**다(`typedExecution.ts`). 이 모듈은
 * 아무것도 쓰지 않고 아무것도 띄우지 않는다.
 */
import { LIMITS, OrchestrationError } from "./orchestrationTypes.js";
import { type TypedExecutionPlan, type WorkerEvent, type WorkerStream } from "./autopilotTypes.js";
import { validateTypedExecutionPlan, type PlanBinding } from "./typedExecution.js";

/** M5c가 아는 **유일한** backend 이름. */
export const OFFLINE_PLAN_BACKEND = "offline-plan";

/**
 * worker 입력 JSON의 바이트 상한.
 * ponytail: 승인 상한(operation 64건 × 1 MiB)을 곧이곧대로 더하면 64 MiB가 되므로, 그 대신 turn 하나의
 * 계획 문서를 4 MiB로 자른다. 더 큰 계획이 실제로 필요해지면 그때 값을 올린다(지금 올리는 것은 추측이다).
 */
export const MAX_PLAN_JSON_BYTES = 4 * 1024 * 1024;

export const OFFLINE_WORKER_INPUT_KEYS = ["backend", "planJson", "binding"] as const;
export const WORKER_BINDING_KEYS = ["runId", "taskId", "attemptId", "turnId"] as const;

/**
 * 이 모듈이 낼 수 있는 **안정 오류 코드 전부**. 호출자가 고를 수 없다(getter/proxy가 던진 것도 접는다).
 */
export const OFFLINE_WORKER_CODES = [
  /** 입력이 닫힌 데이터 계약 밖이다(미상 key · 타입 · symbol · getter/proxy trap · callback 시도 포함). */
  "worker_input_invalid",
  /** `offline-plan`이 아닌 backend. `claude`·`codex` 같은 live 선택은 여기서 끝난다. */
  "worker_backend_unsupported",
  "worker_plan_too_large",
  "worker_plan_not_utf8",
  "worker_plan_unparsable",
] as const;
export type OfflineWorkerCode = (typeof OFFLINE_WORKER_CODES)[number];

function inputInvalid(what: string): OrchestrationError {
  return new OrchestrationError("worker_input_invalid", `worker 입력이 계약 밖이다: ${what}`);
}

/**
 * 닫힌 key 집합을 **정확히 한 번** 읽는다. `typedExecution`의 같은 이름 helper와 같은 규칙이며
 * 코드만 worker 계약의 것을 쓴다(입력 거부 taxonomy를 호출자가 고르지 못하게 전부 접는다).
 */
function closedRead(raw: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    const proto = Reflect.getPrototypeOf(raw as object);
    if (proto !== Object.prototype && proto !== null) throw new Error();
    const own = Reflect.ownKeys(raw as object);
    if (own.length !== allowed.length) throw new Error();
    for (const k of own) {
      if (typeof k !== "string" || !allowed.includes(k)) throw new Error();
    }
    const read: Record<string, unknown> = Object.create(null);
    for (const k of allowed) read[k] = (raw as Record<string, unknown>)[k]; // ← 읽는 유일한 지점
    return read;
  } catch {
    throw inputInvalid(`${what}는 닫힌 key 집합의 순수 데이터 객체여야 한다`);
  }
}

/** JSON 바이트를 **한 번** UTF-8 문자열로 만든다. 문자열로 받았으면 바이트 상한만 본다. */
function decodePlanJson(raw: unknown): string {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_PLAN_JSON_BYTES) {
      throw new OrchestrationError("worker_plan_too_large", `계획 JSON은 ${MAX_PLAN_JSON_BYTES} 바이트 이하여야 한다`);
    }
    return raw;
  }
  if (!(raw instanceof Uint8Array)) throw inputInvalid("planJson은 문자열 또는 Uint8Array여야 한다");
  // 길이를 한 번만 읽고 그 값으로 복사한다(입양 뒤 원본을 바꿔도 파싱 대상은 바뀌지 않는다).
  const bytes = Uint8Array.prototype.slice.call(raw);
  if (bytes.byteLength > MAX_PLAN_JSON_BYTES) {
    throw new OrchestrationError("worker_plan_too_large", `계획 JSON은 ${MAX_PLAN_JSON_BYTES} 바이트 이하여야 한다`);
  }
  try {
    // `fatal: true` — 잘못된 UTF-8을 U+FFFD로 조용히 바꾸지 않는다(바이트와 문자열이 갈라지지 않게).
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new OrchestrationError("worker_plan_not_utf8", "계획 JSON이 올바른 UTF-8이 아니다");
  }
}

/** 입력 하나를 입양해 **동결된 계획**으로 만든다(파싱·검증은 여기서 정확히 한 번 일어난다). */
function adoptPlan(rawInput: unknown): TypedExecutionPlan {
  const input = closedRead(rawInput, OFFLINE_WORKER_INPUT_KEYS, "worker 입력");
  if (input.backend !== OFFLINE_PLAN_BACKEND) {
    // 값을 오류 메시지에 싣지 않는다 — 호출자가 진단 문자열을 고르는 통로를 남기지 않는다.
    throw new OrchestrationError(
      "worker_backend_unsupported",
      `M5c의 backend는 "${OFFLINE_PLAN_BACKEND}" 하나뿐이다(live claude/codex 추론은 없다)`,
    );
  }
  const b = closedRead(input.binding, WORKER_BINDING_KEYS, "worker 입력 binding");
  const binding: PlanBinding = {
    runId: b.runId as string,
    taskId: b.taskId as string,
    attemptId: b.attemptId as string,
    turnId: b.turnId as string,
  };

  const text = decodePlanJson(input.planJson);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OrchestrationError("worker_plan_unparsable", "계획 JSON을 파싱할 수 없다");
  }
  // JSON.parse 결과는 데이터뿐이지만(함수·getter·proxy가 생길 수 없다) **같은 닫힌 validator**를 지난다 —
  // 계획 계약의 판정 지점을 두 개로 늘리지 않는다.
  return validateTypedExecutionPlan(parsed, binding);
}

/** turn 하나의 이벤트를 만든다. **호출마다 새 generator**라 소비 상태가 turn 사이에 새지 않는다. */
async function* planEvents(plan: TypedExecutionPlan): AsyncGenerator<WorkerEvent> {
  let seq = 0;
  yield Object.freeze({ kind: "started" as const, seq: seq++ });
  // **최소 1건의 인정되는 progress** — 이 backend는 최종 결과만 있는 스트림을 만들 수 없다.
  yield Object.freeze({ kind: "progress" as const, seq: seq++, step: "plan_adopted" });
  for (let i = 0; i < plan.operations.length; i++) {
    // 라벨은 고정 형식이다 — 경로·본문·argv 같은 계획 내용을 진행 신호에 싣지 않는다.
    yield Object.freeze({ kind: "progress" as const, seq: seq++, step: `operation_${i + 1}` });
  }
  yield Object.freeze({
    kind: "terminal" as const,
    seq: seq++,
    plan,
    usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
  });
  // generator가 여기서 반환한다 = 스트림 정상 종료. terminal 뒤 이벤트는 존재하지 않는다.
}

/** 이 backend가 turn 하나에 낼 수 있는 이벤트 수의 상한(구조적 — `MAX_WORKER_EVENTS` 안이다). */
export const MAX_OFFLINE_PLAN_EVENTS = 3 + LIMITS.maxOperationsPerTurn;

/**
 * **offline plan turn 하나를 시작한다.** 계획 파싱·검증·동결은 이 호출에서 정확히 한 번 일어나고,
 * 돌려주는 iterable은 소비할 때마다 **새 이벤트 스트림**을 만든다(turn 사이에 상태가 남지 않는다).
 *
 * 실제 파일 쓰기·프로세스 실행은 **controller**가 `typedExecution.ts`로 한다. 이 함수는 아무것도
 * 쓰지 않고 아무것도 띄우지 않는다.
 */
export function startOfflinePlanTurn(rawInput: unknown): WorkerStream {
  const plan = adoptPlan(rawInput);
  return Object.freeze({ [Symbol.asyncIterator]: () => planEvents(plan) });
}
