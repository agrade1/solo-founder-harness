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
import {
  type ApprovedOperationKind,
  type ArtifactRole,
  type AutopilotMarker,
  LIMITS,
  TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
} from "./orchestrationTypes.js";

/**
 * worker가 요청하는 typed operation 1건. **`authorityId`만 worker가 고른다** — 경로·본문·실행 파일·argv는
 * 승인 레코드에서 나오거나(실행 파일·argv) 승인 레코드에 대고 정확히 대조된다(경로·바이트 상한).
 */
export type TypedOperation =
  | {
      operationId: string;
      kind: "write_file";
      authorityId: string;
      /** 승인된 경로와 **정확히 같아야** 한다(정규화 후 문자열 동치). */
      path: string;
      /** 쓸 내용. 바이트 상한은 승인 레코드의 `maxBytes`와 `LIMITS.maxWriteBytes` 중 작은 쪽이다. */
      content: string;
      /**
       * 쓰기 직전 파일의 기대 내용 sha256. 파일이 없어야 하면 `null`.
       * 실제 preimage가 다르면 `write_conflict`이며 쓰지 않는다(조용한 덮어쓰기 금지).
       */
      expectedBeforeSha256: string | null;
    }
  | {
      operationId: string;
      kind: "run_process";
      authorityId: string;
    };

/** typed operation의 종류를 읽는 단일 지점(닫힌 union의 판별자). */
export function operationKind(op: TypedOperation): ApprovedOperationKind {
  return op.kind;
}

/**
 * agent가 **요청만** 할 수 있는 오케스트레이션 행위 1건(V3 M6 T2 — 로드맵 M6 완료 조건 ②).
 *
 * 여기 있는 것은 요청이지 권위가 아니다. 승인·생성·전달은 전부 orchestrator가 kernel API(`requestSpawn` ·
 * `submitStatusUpdate`)를 통과시켜야 일어나며, depth/개수 상한 · registry role · 전달 관계 검증은 kernel
 * 안에 그대로 있다. **child가 state를 직접 바꾸는 kind는 존재하지 않는다** — 이 union이 그 계약의 모양이다.
 */
export type AgentRequest =
  | {
      kind: "spawn_child";
      /** 만들어 달라는 child의 taskId. 실제 생성은 kernel `requestSpawn`이 상한 안에서 한다. */
      childTaskId: string;
      /** registry role(`SPECIALIST_ROLES`). 밖의 값은 kernel이 거부한다. */
      roleId: string;
      title: string;
      scope: string;
      /** child가 기다려야 하는 기존 task. */
      dependsOn: string[];
      /** 왜 쪼개야 하는가 — `spawn_request` body의 bounded 서술이 된다. */
      reason: string;
    }
  | {
      kind: "deliver_status";
      /** 전달 대상 taskId 또는 **유일하게 식별되는** roleId. 관계 검증은 kernel이 한다. */
      deliverTo: string;
      /** 옮길 bounded 서술. 원문·프롬프트·계측값은 담지 않는다. */
      note: string;
    }
  | {
      /**
       * [V3 M7 T6] 사람에게 결정을 **요청**한다(로드맵 §6 — Founder 판단이 최종 승인 게이트다).
       * 이 갈래는 `decision_request`만 만든다. **`decision`을 만드는 갈래는 이 union에 없다** —
       * 답은 사람이 중앙 API(`recordDecision`)로만 넣을 수 있고, 답 없는 요청을 남긴 task는
       * `completeTaskWithArtifacts`/`submitResult`가 `decision_pending`으로 거부한다.
       */
      kind: "request_decision";
      /** 무엇이 막혔는가(bounded 서술). */
      question: string;
      /** 답을 기다리는 동안의 안전 기본값 — §5.2 body의 필수 heading이다. */
      safeDefault: string;
    };

/** turn 하나가 낼 수 있는 오케스트레이션 요청 수 상한. */
export const MAX_PLAN_REQUESTS = 8;

/**
 * worker가 turn 하나에서 내는 **전부**. 이 객체 밖으로 나가는 통로가 없으므로 "무엇을 할 수 있는가"가
 * 이 타입의 모양으로 bounded된다. 미상 key·getter·proxy·함수는 `typedExecution.ts`의 닫힌 validator가 거부한다.
 */
export interface TypedExecutionPlan {
  schemaVersion: typeof TYPED_EXECUTION_PLAN_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  attemptId: string;
  turnId: string;
  operations: TypedOperation[];
  /**
   * 오케스트레이션 요청. 계획에 없으면 **빈 배열**로 입양된다(생략된 계획과 `requests: []`는 같은 뜻이다).
   * 이 배열은 kernel이 계산하는 계획 digest에 그대로 들어간다 — claim 뒤에 요청을 갈아끼울 수 없다.
   */
  requests: AgentRequest[];
  result: {
    summary: string;
    outputs: Array<{ path: string; role: ArtifactRole }>;
  };
}

/**
 * worker 진행/종료 이벤트. **최종 결과만 있는 스트림은 거부다**(`silent_session` — 로드맵 M5 완료 조건).
 * `heartbeat`는 no-progress 시계를 되돌리지 **않는다**(살아 있음과 진행은 다르다).
 */
export type WorkerEvent =
  | { kind: "started"; seq: number }
  | { kind: "progress"; seq: number; step: string }
  | { kind: "heartbeat"; seq: number }
  | { kind: "terminal"; seq: number; plan: unknown; usage: { inputTokens: number; outputTokens: number } };

/** worker 한 turn의 bounded 이벤트 스트림. 이 iterable을 **turn마다 새로** 얻는다. */
export type WorkerStream = AsyncIterable<WorkerEvent>;

/** turn 하나에서 소비할 worker 이벤트 상한. */
export const MAX_WORKER_EVENTS = 1_024;

/** `progress` step 라벨 상한(코드 포인트) — 이 값은 durable state에 들어가지 않는다. */
export const MAX_PROGRESS_STEP_CHARS = 120;

/**
 * **zero-survivor 확인 영수증**(V3 M5c — 대장 `B-13`/`C-18`/`C-31`).
 * `survivors`는 `0`만 가능한 타입이다 — "하나 남았지만 확인됐다"는 값이 존재하지 않는다.
 * 확인에 실패했거나 관측 자체가 불확실하면 영수증이 아니라 `CleanupFailure`가 나온다.
 */
export interface CleanupReceipt {
  marker: "cleanup_confirmed";
  leaseMarker: string;
  termSent: boolean;
  killSent: boolean;
  survivors: 0;
  confirmedAt: string;
}

/** 정리 실패(또는 관측 불확실). task는 `cleaning`에 남고 자원도 계속 붙잡는다. */
export interface CleanupFailure {
  marker: "cleanup_unconfirmed";
  leaseMarker: string;
  termSent: boolean;
  killSent: boolean;
  /** 관측된 생존자 수. 관측 자체가 실패했으면 `null`(불확실 = 실패다). */
  survivors: number | null;
  at: string;
}

export type CleanupOutcome = CleanupReceipt | CleanupFailure;

export function isCleanupConfirmed(o: CleanupOutcome): o is CleanupReceipt {
  return o.marker === "cleanup_confirmed" && o.survivors === 0;
}

/** turn 하나의 결과 요약 — controller 내부 전달용(durable로 나가지 않는 bounded 값). */
export interface TurnOutcome {
  marker: AutopilotMarker;
  turnId: string;
  progressCount: number;
  usage: { inputTokens: number; outputTokens: number };
  /** 검증을 통과한 계획. 실패했으면 null. */
  plan: TypedExecutionPlan | null;
}

/** operation 수 상한을 계획 검증과 controller가 같은 값으로 본다. */
export const MAX_PLAN_OPERATIONS = LIMITS.maxOperationsPerTurn;
