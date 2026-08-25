/**
 * V3 M4a/M4b/M4c — durable orchestration kernel의 타입 · 상한 · 원시 검증자.
 *
 * 로드맵 §3.1/§4/§5/§8 기준. 이 계층은 **state-only/offline**이다: provider도 LLM도 실행하지 않고,
 * 향후 provider가 소비할 결정론적 task DAG · 상태 · 메시지 · artifact 포인터만 다룬다.
 * 기존 `types.ts`의 `ExecutionProvider`나 `runWorkflow`의 `run_state.json`과는 별개 계약이며
 * 둘 중 어느 것도 대체·복제하지 않는다.
 *
 * M4b가 더한 것: task별 **exclusive resource class 선언**(durable), 결정론적 scheduler,
 * run 단위 writer lock + stale writer 거부(`orchestrationStore.ts` / `orchestrationKernel.ts`).
 *
 * M4c가 더한 것: §5.1 메시지 타입 **10종 전부**, 중앙 경유 sibling/reviewer 라우팅의 durable
 * route 메타데이터(message index), §8 **milestone approval manifest**(run에 bind), 7 specialist
 * registry(`approvalManifest.ts`). envelope 필드 집합은 **무변경**이다 — route·권한은 envelope가
 * 아니라 중앙 state가 들고 있다(agent가 자기 권한·경로를 만들 수 없다).
 *
 * M5c가 더한 것 — **durable autopilot lifecycle**: `prepared`/`cleaning`/`retry_wait`/`paused`/`cancelled`
 * 상태, run 단위 **durable 토큰·경과 회계**(`accounting`), task 단위 **실행 lifecycle 메타데이터**
 * (`task.execution`), 메시지 단위 **전달 재시도 메타데이터**(`message.delivery`), 그리고 typed
 * operation 권위(`manifest.operationAuthorityByTask`)·autopilot 정책(`manifest.autopilotPolicy`).
 * **state·manifest schema 버전은 2로 올라가고 마이그레이션은 없다**(fail closed) — envelope는 1 그대로다.
 *
 * 여전히 범위 밖(의도적 미구현): 범용 queue/priority/fairness, schema 마이그레이션 도구,
 * live provider 추론, M6 context rotation, M9 병렬 구현.
 */

/**
 * **schema 버전은 계약별로 분리한다**(V3 M5c). 이전에는 상수 하나가 state와 envelope를 함께 가리켰으므로
 * state 계약이 바뀌면 **아무 것도 바뀌지 않은 message envelope**까지 버전이 올라갔다(그 반대도 같다).
 */
/** message envelope 계약 — M5c에서 **바뀌지 않았다**. */
export const AGENT_MESSAGE_SCHEMA_VERSION = "1";
/** `run_state.json` 계약 — M5c가 durable lifecycle/회계를 더해 **2**다. v1은 마이그레이션 없이 거부한다. */
export const RUN_STATE_SCHEMA_VERSION = "2";
/** 승인 manifest 계약 — M5c가 typed operation 권위·autopilot 정책을 더해 **2**다. */
export const APPROVAL_MANIFEST_SCHEMA_VERSION = "2";
/** worker가 내는 typed 실행 계획 계약(M5c 신규). */
export const TYPED_EXECUTION_PLAN_SCHEMA_VERSION = "1";
/** 구조화 리뷰 결과 계약(M5c 신규 — 대장 `C-19`/`C-35`). */
export const REVIEW_RESULT_SCHEMA_VERSION = "1";

/**
 * @deprecated 계약별 상수를 쓴다. envelope 계약을 뜻하는 옛 이름이며 값은 `AGENT_MESSAGE_SCHEMA_VERSION`이다.
 */
export const ORCHESTRATION_SCHEMA_VERSION = AGENT_MESSAGE_SCHEMA_VERSION;

/**
 * task 상태 전부. **이 11개 외의 상태는 존재하지 않는다.**
 *
 * M5c가 더한 5개(`prepared`·`cleaning`·`retry_wait`·`paused`·`cancelled`)의 요점:
 * - `prepared` — preflight(권한·예산·계획 digest·attempt 배정)가 **durable하게 수락됐고** 아직 아무
 *   프로세스도 뜨지 않은 상태. 자원을 점유한다(그래서 batch preflight 실패가 남을 running으로 새지 않는다).
 * - `cleaning` — 종료·오류·취소·deadline·재시작이 관측됐고 **결과는 미정**이며 자원은 격리 상태다.
 *   zero-survivor가 확인될 때까지 여기서 나가지 못한다.
 * - `retry_wait` — cleanup이 확인됐고 bounded 재시도가 예약된 상태(자원 점유 없음).
 * - `paused` — 살아 있는 프로세스가 없고 사람의 조치나 새 run이 필요한 상태(비대화 승인 부재도 여기다).
 * - `cancelled` — 취소가 요청되고 cleanup이 확인된 종료 상태.
 */
export const TASK_STATES = [
  "pending",
  "ready",
  "prepared",
  "running",
  "cleaning",
  "retry_wait",
  "paused",
  "waiting_children",
  "completed",
  "blocked",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * **배타 자원과 세션 예산을 점유하는 상태**(V3 M5c — 대장 `B-11`/`B-13`).
 * `prepared`는 이미 attempt·worktree·권한을 배정받았고 `cleaning`은 자손 프로세스가 남아 있을 수 있으므로
 * 둘 다 점유한다. 이 목록 하나가 scheduler·커밋 불변식·load 검증의 공통 정본이다.
 */
export const RESOURCE_HOLDING_STATES = ["prepared", "running", "cleaning"] as const;
export type ResourceHoldingState = (typeof RESOURCE_HOLDING_STATES)[number];

export function holdsResources(state: TaskState): boolean {
  return (RESOURCE_HOLDING_STATES as readonly string[]).includes(state);
}

/** 종료(terminal) 상태 — 여기서는 새 작업이 시작되지 않는다. */
export const TERMINAL_TASK_STATES = ["completed", "blocked", "cancelled"] as const;

export function isTerminalTaskState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/** 로드맵 §5.1 메시지 타입 **10종 전부**(M4c에서 4종 → 10종으로 닫았다). */
export const AGENT_MESSAGE_TYPES = [
  "task_assignment",
  "spawn_request",
  "status_update",
  "result",
  "review_request",
  "review_result",
  "revision_request",
  "blocker",
  "decision_request",
  "decision",
] as const;
export type AgentMessageType = (typeof AGENT_MESSAGE_TYPES)[number];

/**
 * 중앙(orchestrator) → agent 방향으로만 존재하는 타입. 나머지는 agent → 중앙뿐이다(§5.3).
 * sibling 전달도 예외가 아니다 — 발신 agent는 **중앙에 제출**하고, 중앙이 관계를 검증한 뒤
 * 수신 task의 inbox에 route를 남긴다(직접 mailbox 쓰기 없음).
 */
export const CENTRAL_MESSAGE_TYPES = [
  "task_assignment",
  "review_request",
  "revision_request",
  "decision",
] as const satisfies readonly AgentMessageType[];

/**
 * bounded summary를 **반드시** 갖는 타입(= true)과 **반드시 null**인 타입(= false).
 * 중앙 state로 옮기는 서술은 이 summary뿐이고 raw 본문·transcript는 어떤 타입도 옮기지 않는다.
 */
export const SUMMARY_REQUIRED: Record<AgentMessageType, boolean> = {
  task_assignment: false,
  spawn_request: false,
  status_update: true,
  result: true,
  review_request: true,
  review_result: true,
  revision_request: true,
  blocker: true,
  decision_request: true,
  decision: true,
};

/** 로드맵 §5.1 artifactRefs[].role. */
export const ARTIFACT_ROLES = ["input", "contract", "output", "evidence", "diff", "test"] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

/**
 * append-only event log의 이벤트 종류. M5c가 lifecycle·회계·전달·정리·typed operation 감사 이벤트를
 * 더했다. **자유 형식 payload는 없다** — 아래 닫힌 nullable 필드 집합만 쓴다.
 */
export const EVENT_TYPES = [
  "run_created",
  "task_created",
  "message_accepted",
  "artifact_registered",
  "task_state_changed",
  /** M4c — 수신 task가 자기 inbox의 전달을 수령했다(상태 전이 없음). */
  "delivery_acknowledged",
  // ── M5c autopilot lifecycle ──
  /** preflight batch가 **원자적으로** 수락됐다(task별 결정 포함). */
  "preflight_committed",
  /** worker가 인정되는 진행 신호를 냈다(no-progress 시계를 되돌리는 유일한 신호). */
  "progress_recorded",
  /** turn 하나의 토큰·경과를 durable 회계에 반영했다(turnId 단위 idempotent). */
  "usage_charged",
  "delivery_attempted",
  "delivery_failed",
  "retry_scheduled",
  "task_paused",
  "task_resumed",
  "cancel_requested",
  "cleanup_started",
  "cleanup_confirmed",
  "cleanup_failed",
  /** controller가 집행한 typed operation 1건의 영수증(내용은 담지 않는다). */
  "operation_receipt",
  /**
   * M5c 3A 2차 리비전 — 이 attempt가 **정확히 하나의 (turn, 계획 digest)** 를 durable하게 claim했다.
   * 크래시 뒤 "어떤 계획/turn이 그 효과를 승인했는가"를 event log만으로 답할 수 있게 하는 근거다.
   */
  "dispatch_claimed",
  /** M5c 3A 2차 리비전 — operation 1건이 **집행 직전에** durable하게 등록됐다(영수증 커밋으로 닫힌다). */
  "operation_began",
  /**
   * M5c 3A 4차 리비전 A2 — operation 1건이 **일회용 집행 경계에 들어갔다**(외부 효과가 일어났을 수 있다).
   * 이 표시 뒤에는 새 grant를 발급하지 않는다: 재집행이 아니라 **정직한 정합화**만 남는다.
   */
  "operation_attempted",
] as const;
export type OrchestrationEventType = (typeof EVENT_TYPES)[number];

/** 상태 전이 사유 — 감사 이력이 "왜 바뀌었는지"를 자유 문자열 없이 남긴다. */
export const TRANSITION_REASONS = [
  "created",
  "spawn_requested",
  "started",
  "result_accepted",
  "blocker_accepted",
  "children_completed",
  "dependencies_completed",
  "child_blocked",
  "dependency_blocked",
  // ── M5c ──
  /** ready → prepared: 이 task의 preflight가 durable하게 수락됐다. */
  "preflight_accepted",
  /** running → cleaning: 종료·오류·취소·deadline·재시작이 관측됐다. */
  "cleanup_required",
  /** cleaning → (completed|retry_wait|paused|blocked|cancelled): zero-survivor가 확인됐다. */
  "cleanup_confirmed",
  "retry_scheduled",
  /** retry_wait → ready: 예약 시각이 됐다. */
  "retry_due",
  "paused",
  /** paused → ready: 같은 유효 승인 아래 사람이 재개했다. */
  "resumed",
  "cancel_requested",
  "cancelled",
  /** attempt 상한을 다 썼다 → blocked. */
  "attempts_exhausted",
  /** 되돌릴 수 없는 정책·무결성 위반 → blocked. */
  "policy_blocked",
  "deadline_exceeded",
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

/**
 * **만료·run deadline 이후에도 허용되는 safety-only reducer의 전이 사유**(V3 M5c — DECISIONS 2026-07-30).
 * 이 목록은 닫혀 있고, 여기에 없는 사유의 전이는 만료 후 전부 거부된다.
 * 이 사유들은 **작업을 시작하지 않고**(`started`가 없다) **완료하지 않고**(`result_accepted`가 없다)
 * 실패한 전달을 수령하지 않고 artifact를 등록하지 않는다.
 */
export const SAFETY_ONLY_REASONS = [
  "cleanup_required",
  "cleanup_confirmed",
  "paused",
  "cancel_requested",
  "cancelled",
  "retry_scheduled",
  "deadline_exceeded",
  /**
   * 확인된 정리 뒤 attempt 여유가 없을 때의 **fail-closed 착지**(`blocked`). 새 작업을 시작하지 않고
   * 결과를 발행하지도 않으므로 safety 범주다 — 만료 뒤에도 자원을 회수할 수 있어야 한다.
   * 반면 preflight의 `policy_blocked`는 전진 결정이므로 **이 목록에 없다**.
   */
  "attempts_exhausted",
] as const;

/**
 * safety-only reducer가 남길 수 있는 event 종류(전이 없는 회계·정리 이벤트 포함).
 * `artifact_registered`·`delivery_acknowledged`·`message_accepted`는 **없다**.
 */
export const SAFETY_ONLY_EVENT_TYPES = [
  "task_state_changed",
  "usage_charged",
  "cancel_requested",
  "cleanup_started",
  "cleanup_confirmed",
  "cleanup_failed",
  "task_paused",
  "retry_scheduled",
  "operation_receipt",
  /**
   * "효과가 일어났을 수 있다"를 durable에 적는 일은 **막으면 안 된다**(3A 4차 리비전 A2): 만료·deadline이
   * 그 기록을 막으면 불확실 구간이 durable에 남지 않아 정합화 자체가 불가능해진다.
   */
  "operation_attempted",
] as const;

/**
 * autopilot의 **닫힌 결과 marker 집합**(대장 `C-33` — 손으로 관리하는 문자열 목록을 하나로 모은다).
 * durable state(`task.execution.terminalMarker`)와 controller outcome이 같은 이 목록을 쓴다.
 */
export const AUTOPILOT_MARKERS = [
  /** turn이 프로토콜을 지키고 정상 종료했다(완료 자체는 cleanup 확인 뒤에 결정된다). */
  "turn_completed",
  /** 진행 이벤트 없이 최종 결과만 온 스트림 — 허용하지 않는다(로드맵 M5 완료 조건). */
  "silent_session",
  "no_progress_timeout",
  "wall_deadline_exceeded",
  "cancelled",
  /**
   * worker turn이 완료되지 못했다. **worker가 프로토콜을 어긴 경우만이 아니다**(V3 M10 T7):
   * 승인 축 거부(`worker_backend_unapproved`·`worker_digest_mismatch`·`codex_home_*` — 프로세스가
   * 뜨지도 않은 경우)도 여기로 온다. marker 집합은 durable schema라 원인마다 값을 늘리지 않고,
   * **원본 안정 코드는 pause 이벤트의 `detail`로** 올린다(`autopilot.workerMarker` 주석이 정본).
   */
  "worker_failed",
  /** **계획 계약 위반만** 이 값이다 — `validateTypedExecutionPlan`이 낸 `plan_invalid` 하나에서만 온다. */
  "plan_invalid",
  "operation_denied",
  "process_failed",
  "cleanup_unconfirmed",
  "stream_invalid",
  "delivery_failed",
  "review_invalid",
  /**
   * **V3 M10 T1 — 이 attempt를 소유했던 controller가 사라졌다**(SIGKILL·전원 단절·프로세스 강제 종료).
   * 재시작한 controller가 durable 잔재(`running`/`cleaning` + `processLeaseMarker`)를 보고 **관측한 사실**
   * 그대로 기록하는 marker다.
   *
   * 기존 marker를 재사용하지 않은 이유: `worker_failed`는 worker가 프로토콜을 어겼다는 주장이고
   * `cleanup_unconfirmed`는 정리를 시도했으나 관측하지 못했다는 주장이다. 크래시는 둘 다 아니다 —
   * 어느 쪽으로 적어도 durable 감사 로그에 **일어나지 않은 일**이 남는다.
   */
  "controller_lost",
] as const;
export type AutopilotMarker = (typeof AUTOPILOT_MARKERS)[number];

/** `paused`의 닫힌 사유 집합. */
export const PAUSE_REASONS = [
  /** 비대화 모드에서 승인이 필요하다 — **stdin을 기다리지 않고** 여기로 내려앉는다. */
  "approval_required",
  "attempts_exhausted",
  "delivery_deadline_exceeded",
  "budget_tokens_exhausted",
  "budget_elapsed_exhausted",
  "manifest_expired",
  "clock_invalid",
  /** 프로세스가 살아 있는 중에 controller가 사라졌다(재시작 복구 경로). */
  "interrupted",
  "cleanup_unconfirmed",
  "operator_requested",
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** 전달 시도 1건의 닫힌 결과 marker. */
export const DELIVERY_MARKERS = ["delivered", "send_failed", "turn_failed", "deadline_exceeded", "attempts_exhausted"] as const;
export type DeliveryMarker = (typeof DELIVERY_MARKERS)[number];

/** cleanup 진행 상태. `confirmed`만 다음 상태로 나갈 자격이 된다. */
export const CLEANUP_STATUSES = ["none", "required", "confirmed", "failed"] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/** typed operation 종류 — 닫힌 union(shell 문자열·wildcard·런타임 실행 파일 선택은 없다). */
export const APPROVED_OPERATION_KINDS = ["write_file", "run_process", "git_worktree"] as const;
export type ApprovedOperationKind = (typeof APPROVED_OPERATION_KINDS)[number];

/**
 * **`superviseProcess`로 자식 프로세스 그룹을 여는 kind**(V3 M10 T1 — 이전에는 kernel의 spawn 상한과
 * autopilot의 정리 판정이 이 목록을 **각자 수기로** 들고 있었다). 새 kind가 프로세스를 여는데 한쪽에서
 * 빠지면 ⓐ spawn 상한이 실제 프로세스 수와 어긋나고 ⓑ 정리 판정이 거짓 confirm을 낸다 → 단일 출처로 둔다.
 */
export const PROCESS_LAUNCHING_KINDS = ["run_process", "git_worktree"] as const;

/** 이 kind가 자식 프로세스 그룹을 여는가. `write_file`은 순수 파일 시스템 연산이라 자손이 없다. */
export function opensProcess(kind: string): boolean {
  return (PROCESS_LAUNCHING_KINDS as readonly string[]).includes(kind);
}

/**
 * bounded 상한. spawn 상한 3종은 M4a 필수 요건이고 나머지는 state·메시지가 무제한으로
 * 커지지 않게 하는 방어선이다. schema(JSON)와 runtime validator가 같은 값을 쓴다.
 */
export const LIMITS = {
  /** task 하나가 요청할 수 있는 child 수. */
  maxChildrenPerTask: 4,
  /** root task depth=0 기준, child depth가 이 값을 넘으면 거부. */
  maxDepth: 3,
  /** run 하나의 총 task 수. */
  maxTasksPerRun: 32,
  /**
   * run 하나가 열 수 있는 총 `run_process` 수. **task 상한과 별개 개념이다**(`B-19`) —
   * 값이 우연히 같아도 같은 상수를 빌려 쓰지 않는다. task fan-out 때문에 `maxTasksPerRun`을
   * 조정해도 프로세스 상한은 따라 움직이지 않는다.
   */
  maxProcessesPerRun: 32,
  /** slug(runId/taskId/messageId/roleId/…) 최대 길이. */
  maxIdLength: 64,
  /** title/scope 등 짧은 텍스트 필드. */
  maxTextLength: 500,
  /** result/blocker bounded summary — 중앙 state로 옮기는 유일한 서술 필드. */
  maxSummaryLength: 1000,
  /** Markdown body 최대 바이트(UTF-8). */
  maxBodyBytes: 16384,
  /** workspace-relative path 최대 길이. */
  maxPathLength: 512,
  maxOwnershipPaths: 16,
  maxArtifactRefs: 16,
  maxDependsOn: 16,
  /** task 하나가 선언할 수 있는 배타 자원 class 수(0개 = 병렬 안전). */
  maxResourceClasses: 4,
  /** scheduler가 한 커밋으로 시작할 수 있는 task 수. */
  maxScheduleBatch: 8,

  // ── M4c: milestone approval manifest 상한 (로드맵 §8) ──
  /** manifest가 승인할 수 있는 writable root 수. */
  maxWritableRoots: 8,
  /** manifest `allowedCommands` 항목 수. */
  maxAllowedCommands: 16,
  /** manifest `allowedDependencies` 항목 수(전부 정확히 pin된 버전). */
  maxAllowedDependencies: 16,
  /** manifest `allowedNetworkDomains` 항목 수. */
  maxAllowedNetworkDomains: 8,
  /** 승인 가능한 동시 세션(= 동시에 running일 수 있는 task) 상한의 상한. */
  maxManifestSessions: 16,
  /** allowedCommands 항목 1개의 길이. */
  maxCommandLength: 80,
  /** 도메인 이름 길이(RFC 1035 상한). */
  maxDomainLength: 253,
  /** manifest `maxTokens` 상한(있을 때). */
  maxManifestTokens: 100_000_000,
  /** manifest `maxElapsedMs` 상한 = 24h. */
  maxManifestElapsedMs: 86_400_000,

  // ── M5c: autopilot lifecycle 상한 (계획 §3) ──
  /** task 하나의 총 attempt 수(1..4). */
  maxTaskAttempts: 4,
  /** 메시지 하나의 전달 시도 수(1..4). */
  maxDeliveryAttempts: 4,
  /** turn 하나가 낼 수 있는 typed operation 수. */
  maxOperationsPerTurn: 64,
  /** attempt 하나가 남기는 progress 이벤트 수. */
  maxProgressEvents: 256,
  /** attempt 하나가 남기는 operation 영수증 수. */
  maxOperationReceipts: 64,
  /** typed `write_file` 본문 바이트 상한 = 1 MiB. */
  maxWriteBytes: 1_048_576,
  /** stable quarantine 전 cleanup 재시도 수. */
  maxCleanupAttempts: 2,
  /** idempotent 과금을 위해 기억하는 turnId 수. */
  maxChargedTurnIds: 512,
  /** durable `tokensUsed` 상한(manifest 상한과 같은 자리). */
  maxAccountedTokens: 100_000_000,
  /** durable `elapsedMsUsed` 상한 = 24h. */
  maxAccountedElapsedMs: 86_400_000,
  /** task 하나에 승인할 수 있는 typed operation 권위 수. */
  maxOperationAuthorities: 32,
  /** `run_process` 권위 하나의 **데이터 인자** 개수(코드 인자는 표현할 타입이 없다 — `B-10`). */
  maxOperationArgs: 16,
  /** 데이터 인자 1개의 길이(코드 포인트). */
  maxOperationArgLength: 256,
  /** attempt 하나가 동시에 열어 둘 수 있는 **미확정 operation** 수(전부 정합화해야 turn을 닫는다). */
  maxPendingOperations: 8,
} as const;

/**
 * **문자열 길이를 Unicode 코드 포인트로 센다**(V3 M5c — 대장 `C-40`).
 *
 * JavaScript `.length`는 UTF-16 code unit 수이고 JSON Schema draft-07 `maxLength`는 **코드 포인트 수**다.
 * 그래서 `/` + 😀 256개는 코드 포인트 257개·UTF-16 513 unit이 되어 **schema는 통과시키고 runtime은
 * 거부했다**(같은 승인 문서에 대해 두 판정이 갈렸다). 경로 길이 상한은 이제 이 함수 하나로 판정한다.
 * (문자열 iterator는 surrogate pair를 하나로 센다. 고립 surrogate는 1로 세며 draft-07과 같다.)
 */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/**
 * **고립 UTF-16 surrogate 판정**(V3 M5c 3A 리비전 A4 — 승인된 경로 신원).
 *
 * JavaScript 문자열은 UTF-16 code unit 배열이므로 짝이 맞지 않는 surrogate 하나를 담을 수 있지만
 * **UTF-8에는 그런 바이트열이 없다.** Node가 그 문자열을 파일 시스템 경계로 넘기면 U+FFFD로 바뀌므로
 * 승인된 `docs/\uD800.md`가 실제로는 **다른 경로** `docs/�.md`를 가리킨다 → "승인된 경로와 정확히
 * 같은가"를 문자열 동치로 판정하는 계약이 그 자리에서 무의미해진다(경로 aliasing).
 *
 * 그래서 승인·계획·산출물 경로는 **UTF-8 왕복이 정확히 보존되는 문자열만** 받는다.
 * `\p{Surrogate}`(General_Category=Cs)는 `u` 모드에서 **짝이 맞지 않는 surrogate만** code point로
 * 노출되므로(올바른 pair는 astral code point 하나가 된다) 이 한 줄이 정확한 판정이다.
 * 유효한 astral 문자와 **리터럴 U+FFFD는 그대로 통과한다** — 왕복이 깨지지 않기 때문이다.
 */
const LONE_SURROGATE_RE = /\p{Surrogate}/u;

export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE_RE.test(s);
}

/** slug 규칙: 소문자·숫자로 시작하고 `[a-z0-9._-]`만 허용, 1..64자. */
export const SLUG_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
const SLUG_RE = new RegExp(SLUG_PATTERN);

/** UTC ISO-8601, 밀리초 3자리 고정. clock 주입으로 테스트 결정성을 확보한다. */
export const TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
const TIMESTAMP_RE = new RegExp(TIMESTAMP_PATTERN);

/** SHA-256 소문자 hex. */
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
const SHA256_RE = new RegExp(SHA256_PATTERN);

/** event chain의 genesis prevHash (이벤트 0개일 때의 lastEventHash). */
export const GENESIS_HASH = "0".repeat(64);

/** 중앙 kernel이 유일한 상태 전이 주체임을 나타내는 고정 recipient/sender. */
export const ORCHESTRATOR_ID = "orchestrator";

/**
 * 타입별 Markdown body 필수 heading.
 * validator는 이 목록의 `## <heading>`이 **전부** 있고, 이 목록 **밖의 h2가 없고**,
 * 중복이 없을 것을 요구한다(closed set — schema의 additionalProperties:false와 같은 취지).
 *
 * `task_assignment` · `spawn_request` · `result` · `review_result` · `blocker`/`decision_request`는
 * **로드맵 §5.2가 지정한 heading 그대로**다(공유 blocker/decision_request 포함).
 * 나머지 4종(`status_update` · `review_request` · `revision_request` · `decision`)은 §5.2가 지정하지
 * 않았으므로 **M4c가 정한 최소 closed set**이며 각 3개다 — 라우팅 판단에 필요한 최소 항목만 두고,
 * 자유 서술은 body 안에 남기되 h2는 늘리지 않는다(늘리면 계약이 아니라 템플릿이 된다).
 */
export const REQUIRED_BODY_HEADINGS: Record<AgentMessageType, readonly string[]> = {
  task_assignment: [
    "Objective",
    "Scope / Ownership",
    "Out of Scope / Forbidden",
    "Inputs and Contracts",
    "Dependencies",
    "Definition of Done",
    "Budget and Permission Envelope",
    "Expected Deliverables",
  ],
  spawn_request: [
    "Why Split Is Needed",
    "Requested Specialty",
    "Child Scope",
    "Required Inputs",
    "Expected Deliverables",
    "Dependency and Budget Impact",
  ],
  result: [
    "Result Summary",
    "Work Performed",
    "Decisions and Assumptions",
    "Deliverables",
    "Tests and Evidence",
    "Risks / Known Limitations",
    "Unresolved Questions",
    "Recommended Next Action",
  ],
  blocker: [
    "Blocking Condition",
    "Evidence",
    "Options and Trade-offs",
    "Required Authority",
    "Safe Default While Waiting",
  ],
  // §5.2가 blocker와 **같은 section**을 지정한 타입.
  decision_request: [
    "Blocking Condition",
    "Evidence",
    "Options and Trade-offs",
    "Required Authority",
    "Safe Default While Waiting",
  ],
  review_result: [
    "Reviewed Revision and Hash",
    "Findings (P0/P1/P2)",
    "Reproduction or Evidence",
    "Missing Tests",
    "Contract Deviations",
    "Verdict: pass | revise | block",
  ],
  // 아래 4종은 M4c가 정한 최소 closed set(§5.2 미지정).
  status_update: ["Current Status", "Progress Since Last Update", "Next Step"],
  review_request: ["Review Target and Hash", "Review Scope", "Required Checks"],
  revision_request: ["Findings to Address", "Required Changes", "Verification Required"],
  decision: ["Decision", "Rationale", "Scope of Effect"],
};

/** 모든 거부는 안정적인 `code`를 가진 이 오류로 올린다(테스트가 code로 단정). */
export class OrchestrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "OrchestrationError";
    this.code = code;
  }
}

/** 로드맵 §5.1 envelope. 필드 집합은 로드맵 그대로 유지한다. */
export interface AgentMessageEnvelope {
  schemaVersion: string;
  messageId: string;
  runId: string;
  milestoneId: string;
  taskId: string;
  parentTaskId: string | null;
  sender: string;
  recipient: string;
  type: AgentMessageType;
  createdAt: string;
  dependsOn: string[];
  artifactRefs: ArtifactPointer[];
  supersedes: string | null;
}

/**
 * 검증된 artifact 포인터. 중앙 snapshot이 운반하는 것은 **이것과 bounded summary뿐**이며
 * artifact 본문은 절대 복사하지 않는다(로드맵 §3.2).
 */
export interface ArtifactPointer {
  /** workspace-relative 정규화 경로. */
  path: string;
  sha256: string;
  revision: number;
  producerTaskId: string;
  role: ArtifactRole;
}

/** artifact registry 레코드 — 조용한 덮어쓰기 없이 revision/supersedes를 남긴다. */
export interface ArtifactRecord extends ArtifactPointer {
  /** `<path>@<revision>` — registry 안에서 유일. */
  artifactId: string;
  registeredAt: string;
  /** 직전 revision의 artifactId. 최초 등록이면 null. */
  supersedes: string | null;
}

/**
 * **집행한 typed operation 1건의 영수증**(V3 M5c). 내용(파일 본문·stdout·argv)은 **담지 않는다** —
 * operation 신원 · 경로 · 결과 hash · 안정 marker만 durable하다. 같은 `operationId`가 다시 오면
 * 이 영수증이 idempotent 판정의 근거가 된다(크래시 뒤 재시도가 두 번 쓰지 않는다).
 */
export interface OperationReceipt {
  operationId: string;
  kind: ApprovedOperationKind;
  authorityId: string;
  /**
   * **이 영수증이 닫은 pending 레코드의 실행 신원**(3A 3차 리비전 A2). 이전 판은 pending이 사라지고 dispatch
   * claim이 닫히면 "어떤 attempt·turn·계획이 이 효과를 승인했는가"를 durable에서 **재구성할 수 없었다**.
   */
  attemptId: string;
  turnId: string;
  /** 그 turn이 durable하게 claim한 계획의 canonical digest. */
  planDigest: string;
  /** `write_file`이면 정규화된 workspace-relative 경로, `run_process`면 null. */
  path: string | null;
  /** `write_file`이면 결과 내용 sha256, `run_process`면 null. */
  resultSha256: string | null;
  /** `run_process`의 종료 코드(정상 종료만). 그 밖은 null. */
  exitCode: number | null;
  /**
   * `outcome_unknown`은 **3A 4차 리비전 A3**가 더한 fail-safe 종결이다: 일회용 집행 경계에 들어간 뒤
   * (`PendingOperation.attemptedAt !== null`) 결과를 잃어버린 operation은 "실패했다"고 단정할 수 없다 —
   * 외부 효과가 일어났을 수도 있다. 성공도 실패도 아닌 이 marker만 그 pending을 정직하게 닫는다.
   */
  marker: "applied" | "already_applied" | "write_conflict" | "denied" | "failed" | "outcome_unknown";
  at: string;
}

/**
 * **집행 직전에 durable하게 등록된 operation 1건**(V3 M5c 3A 2차 리비전 A2).
 *
 * 이 레코드가 존재한다는 것은 "이 attempt의 이 turn의 이 계획에서 이 operation을 집행하려 했다"는 뜻이고,
 * 영수증이 커밋되면 사라진다. 그래서 **효과가 일어났는데 결과가 없는 구간**이 durable에 남고, 재시작한
 * controller는 그 구간을 정확히 하나의 방법으로 정합화한다(같은 operation을 다시 열어 멱등 재집행 →
 * 영수증 커밋). 미확정 레코드가 하나라도 있으면 turn을 닫을 수도, task를 완료·차단할 수도 없다.
 */
export interface PendingOperation {
  operationId: string;
  kind: ApprovedOperationKind;
  authorityId: string;
  /** 등록 시점의 durable attempt/turn 신원 — 낡은 attempt·다른 turn의 영수증을 거부하는 근거다. */
  attemptId: string;
  turnId: string;
  /** 이 attempt가 durable하게 claim한 계획의 canonical digest. */
  planDigest: string;
  beganAt: string;
  /**
   * **일회용 집행 경계에 들어간 시각**(3A 4차 리비전 A2). `null`이면 아직 아무 효과도 시도되지 않았다 →
   * 새 grant를 발급해 다시 집행할 수 있고 `failOperation(denied|failed)`으로 정직하게 닫을 수 있다.
   * `null`이 아니면 **외부 효과가 일어났을 수 있다** → 새 grant를 발급하지 않고(`operation_attempt_uncertain`)
   * 살아 있는 grant의 결과 영수증 또는 재시작 안전한 safety-only 정합화(`outcome_unknown`)로만 닫힌다.
   */
  attemptedAt: string | null;
}

/** 아직 durable 완료 커밋 전인 결과(cleanup 확인을 기다리는 동안 보관한다). */
export interface PendingTaskResult {
  summary: string;
  outputs: Array<{ path: string; role: ArtifactRole }>;
}

/**
 * **task 하나의 실행 lifecycle 메타데이터**(V3 M5c — 대장 `B-11`/`B-12`/`B-13`/`C-18`).
 * 전부 durable이다: 재시작한 controller는 이 필드만 보고 "무엇이 떠 있었고 무엇을 정리해야 하는가"를 안다.
 * **raw는 하나도 없다** — PID/PGID/argv/env/session handle/transcript가 아니라 `processLeaseMarker`
 * (충돌 저항 난수 문자열)만 남는다.
 */
export interface TaskExecution {
  /** 1..maxTaskAttempts. 0은 "아직 시작 안 함"이다. */
  attemptNo: number;
  attemptId: string | null;
  turnId: string | null;
  /**
   * **지금 열려 있는 dispatch turn**(3A 2차 리비전 A1). `issueOperationDispatchPermit()`이 커밋으로
   * claim한다. 이것이 null이 아니면 **다른 turn은 permit을 받을 수 없다** — "durable turn이 null인 동안
   * 두 turn이 각각 permit을 받아 둘 다 집행"이 불가능해진다.
   *
   * **과금은 이 claim을 지우지 않는다**(3A 3차 리비전 A1 — 순서가 과금 → grant → 효과이므로 과금 시점에
   * 닫으면 바로 그 계획의 grant가 죽는다). 닫기는 **지연**된다: 끝난 claim(= 그 turn이 과금됐고 미확정
   * operation이 0)만 **다음 turn의 permit 요청이 교체**한다(lazy replacement). 아직 과금되지 않았거나
   * 미확정 operation이 남은 claim은 계속 다른 turn을 막는다.
   */
  dispatchTurnId: string | null;
  /** claim한 turn의 계획 canonical digest. 같은 turn에 **다른 계획**이 오면 fail closed다. */
  dispatchPlanDigest: string | null;
  /**
   * **생산 turn 과금 권위의 canonical 증거**(3A 4차 리비전 A1). `chargeDispatchTurnUsage()`가
   * **kernel 발급 permit**으로 과금할 때만 채워지며, 값은 그 permit에 묶인 계획의 canonical digest다.
   * 효과 게이트는 `turnId`(= 마지막 과금 turn) + 이 값 + claim된 `dispatchTurnId`/`dispatchPlanDigest`/
   * `attemptId`를 함께 보므로 **run/task/attempt/turn/계획 전부에 묶인 과금**만 효과를 승인한다.
   *
   * 권위 없는 `chargeTurnUsage()`(만료 뒤 재시작 회계 · claim 없는 turn)는 이 값을 **채우지 않는다** →
   * 회계는 잃지 않으면서 "bare run-global turn ID로 남의 효과를 승인"하는 경로가 존재하지 않는다.
   */
  chargedPlanDigest: string | null;
  /** preflight가 봉인한 결정의 digest — 시작 직전에 다시 계산해 대조한다. */
  preflightDigest: string | null;
  phaseStartedAt: string | null;
  wallDeadlineAt: string | null;
  lastProgressAt: string | null;
  progressCount: number;
  /** 살아 있을 수 있는 supervisor를 찾는 **유일한** durable 단서. PID가 아니다. */
  processLeaseMarker: string | null;
  terminalMarker: AutopilotMarker | null;
  cleanupStatus: CleanupStatus;
  cleanupAttempts: number;
  cancelRequestedAt: string | null;
  pauseReason: PauseReason | null;
  retryAt: string | null;
  retryDeadlineAt: string | null;
  pendingResult: PendingTaskResult | null;
  /** 등록됐지만 아직 영수증이 커밋되지 않은 operation(operationId 정렬 · 중복 없음). */
  pendingOperations: PendingOperation[];
  operationReceipts: OperationReceipt[];
}

/** 새 task의 초기 실행 메타데이터(모든 필드가 durable 계약이라 항상 존재한다). */
export function emptyTaskExecution(): TaskExecution {
  return {
    attemptNo: 0,
    attemptId: null,
    turnId: null,
    dispatchTurnId: null,
    dispatchPlanDigest: null,
    chargedPlanDigest: null,
    preflightDigest: null,
    phaseStartedAt: null,
    wallDeadlineAt: null,
    lastProgressAt: null,
    progressCount: 0,
    processLeaseMarker: null,
    terminalMarker: null,
    cleanupStatus: "none",
    cleanupAttempts: 0,
    cancelRequestedAt: null,
    pauseReason: null,
    retryAt: null,
    retryDeadlineAt: null,
    pendingResult: null,
    pendingOperations: [],
    operationReceipts: [],
  };
}

/** task 1건. ownership은 M4a에서 **기록·검증 메타데이터**일 뿐 실제 파일 권한이 아니다. */
export interface OrchestrationTask {
  taskId: string;
  /** opaque role 식별자 — 향후 7개 상위 specialist와 하위 specialist를 그대로 수용한다. */
  roleId: string;
  title: string;
  scope: string;
  ownership: string[];
  /**
   * 이 task가 요구하는 **배타 자원 class**(정규화·정렬·중복 없음, 0..4개). 빈 배열은 병렬 안전이다.
   * 점유는 task가 `running`인 동안에만 유효하고 `waiting_children`은 중단 상태라 점유하지 않는다
   * (M4b 결정 — DECISIONS 참조). 같은 class를 요구하는 두 task는 동시에 running이 될 수 없다.
   */
  resourceClasses: string[];
  /**
   * **지시(task_assignment)가 이 task에 실어 보낸 승인 operation의 authorityId 집합**
   * (V3 M11 — 대장 `B-38`/`C-111`). 사전순·중복 없음.
   *
   * 이것은 **권위가 아니라 지시 축**이다. 권위 정본은 그대로 `manifest.operationAuthorityByTask`이고
   * (`approvedOperationFor` deny-by-default), 이 배열은 그 위에 얹는 **두 번째 게이트**다:
   * turn의 계획이 낸 operation은 이 집합 **안**이어야 한다(`issueOperationDispatchPermit`).
   * 그래서 여기 없는 authorityId를 적어도 새 권능이 생기지 않는다 — 좁히기만 한다.
   *
   * - `[]` — **지시가 operation 축을 선언했고 그 집합이 비었다** → 이 task는 어떤 operation도 낼 수 없다.
   * - `null` — **지시가 operation 축을 선언한 적이 없다**(kernel API로 직접 만든 task · `requestSpawn`
   *   child). 그때는 manifest 게이트 하나만 적용된다 — `B-38` 이전과 **같은 판정**이다.
   *
   * 두 값을 구분하는 이유: 하나로 합치면 "선언했는데 비었다"와 "선언한 적이 없다"가 같은 바이트가 되고,
   * 그러면 `materializeTaskDag`가 만든 task의 deny(= `[]`)를 나중에 누가 "축이 없는 것"으로 오독한다.
   * **`materializeTaskDag`는 `null`을 만들지 않는다** — DAG로 만든 task는 전부 bind된다.
   */
  assignedOperations: string[] | null;
  parentTaskId: string | null;
  childTaskIds: string[];
  dependsOn: string[];
  state: TaskState;
  depth: number;
  createdAt: string;
  updatedAt: string;
  resultSummary: string | null;
  blockerSummary: string | null;
  artifactRefs: ArtifactPointer[];
  /**
   * M5c — 실행 lifecycle 메타데이터(필수). 이 필드가 없는 pre-M5c state는 마이그레이션하지 않고
   * `state_pre_m5c_unsupported`로 거부한다.
   */
  execution: TaskExecution;
}

/** manifest가 승인한 dependency 1건 — 버전은 **정확히 pin된 값**만 유효하다(범위·tag·latest 거부). */
export interface ApprovedDependency {
  name: string;
  version: string;
}

/**
 * **승인된 실행 파일 1건**(V3 M5b 6차 독립 리뷰 A1). 실행 권위의 trust root는 이 record이고,
 * 런타임 호출자가 주는 경로가 아니다: 승인 manifest는 run 생성 시 durable state에 들어가
 * `stateContentDigest` → state↔event binding으로 봉인되므로, "무엇을 codex/git으로 실행하는가"는
 * 사람이 승인한 그 바이트에서만 나온다.
 *
 * `path`는 **정규 절대경로**이고 `sha256`은 **그 파일 내용의 정확한 digest**다 —
 * 같은 inode를 제자리에서 덮어써도 digest가 달라지므로 fail closed다.
 */
export interface ApprovedExecutable {
  path: string;
  sha256: string;
}

/**
 * **승인된 디렉터리 1건**(V3 M5c — 대장 `B-7ⓐ`). 실행 파일과 달리 내용 digest가 없다: 디렉터리 안에는
 * 사람이 1회 `codex login`으로 만든 **자격증명**이 들어 있고, harness는 그 내용을 **읽지도 해싱하지도
 * 기록하지도 않는다**(digest를 남기는 순간 그것이 곧 자격증명 유출 경로다). 승인이 고정하는 것은
 * **경로 하나**이고, 그 경로가 만족해야 할 신원·권한 계약은 `verifyCodexHome`이 spawn 직전에 집행한다.
 */
export interface ApprovedDirectory {
  path: string;
}

/**
 * **승인된 typed operation 1건**(V3 M5c — 대장 `B-10`). 이 union이 닫혀 있다는 것이 이 계층의 전부다:
 * shell 문자열 · 인자 wildcard · 런타임 실행 파일 선택 · 네트워크 · dependency 설치 · 원격 git ·
 * deploy · billing · PR merge 변종은 **존재하지 않는다**(표현할 타입이 없으므로 승인될 수도 없다).
 *
 * worker는 `authorityId`만 고를 수 있다 — 경로·바이트 상한·실행 파일·인자는 **사람이 승인한 이 레코드**에서
 * 나온다. 그래서 "모델이 만든 명령"이라는 것이 애초에 성립하지 않는다.
 *
 * **`B-10` 집행(3A 2차 리비전 B2)**: `run_process`는 더 이상 argv를 담지 않는다. 승인 문서가 고를 수 있는
 * 것은 **닫힌 action enum 하나 + 데이터 전용 인자**뿐이고, 실행 대상은 `executionAuthority.node` +
 * `executionAuthority.controllerEntrypoint`로 **manifest 전체에 하나로 고정**된다(digest는 실행 경계에서
 * 다시 확인한다). `--eval`·`--require`·임의 script/module 경로·shell·env·cwd는 **표현할 필드가 없다**.
 */
export type ApprovedOperation =
  | { authorityId: string; kind: "write_file"; path: string; maxBytes: number }
  | { authorityId: string; kind: "run_process"; action: "validate-plan"; data: ValidatePlanData; timeoutMs: number }
  | { authorityId: string; kind: "run_process"; action: "run-tests"; data: RunTestsData; timeoutMs: number }
  | { authorityId: string; kind: "git_worktree"; action: GitWorktreeAction };

/**
 * **격리 worktree 조작 1건의 닫힌 action 집합**(V3 M9 T3③ — 로드맵 §7 병렬 계약 2 "worker마다 격리된
 * git worktree 1개").
 *
 * 이것이 **kernel이 저장소를 바꾸는 유일한 면**이다. 그래서 열린 만큼 정확히 닫아 두었다:
 *
 * - **호출자·모델이 담을 수 있는 필드가 하나도 없다.** worktree 경로는 `runId`+`taskId`에서, 체크아웃할
 *   커밋은 승인 manifest의 `approvedCommit`에서 **kernel이 파생한다**(`gitWorktreeArgs`). 승인 레코드가
 *   고르는 것은 `add`/`remove` 둘 중 하나뿐이다.
 * - **브랜치를 만들지 않는다**(`--detach`). 브랜치명을 담을 필드가 없어야 하고, M9에서 worker의 산출물은
 *   worktree가 아니라 **kernel typed-write 채널**로 발행되므로 브랜치가 필요하지 않다.
 * - `fetch`/`pull`/`push`/`remote`/`clone`/`merge`/`rebase`/`commit`/`tag`는 **표현할 타입이 없다**
 *   (원격 **쓰기** hard deny — §8). **"네트워크에 닿지 않는다"와 같은 말이 아니다**: partial clone
 *   (`--filter=blob:none`)에서 checkout은 argv에 `fetch`가 없어도 lazy fetch를 일으킬 수 있어
 *   집행기가 `GIT_NO_LAZY_FETCH=1`로 따로 끈다(T3③ 적대적 리뷰 B-1 실측).
 * - 승인은 task별이다(`operationAuthorityByTask`) → 아무 task나 worktree를 만들 수 없다.
 * - **`prune`은 검토하고 기각했다**(대장 `B-31` · 2026-08-23 git 2.50.1 실측 — 증거는
 *   `worktree.test.ts`의 `[B-31]` 테스트 둘). deadline kill 잔재를 되돌릴 지렛대로 제안됐지만 재보면
 *   그 일을 하지 못한다: ⓐ "등록만 남고 디렉터리는 사라진" 모양은 **이미 있는 `remove --force`가
 *   되돌린다**(그 뒤 재시도 `add`가 성공한다) ⓑ 실제 kill이 남기는 모양은 "파일이 든 디렉터리 + 등록
 *   없음"인데(git 자신의 TERM 핸들러가 metadata를 먼저 지운다) `prune`은 **작업 파일을 절대 지우지
 *   않으므로** 재시도 `add`는 그대로 `exit 128`이다. ⓒ 등록이 반쯤 쓰인 모양(`gitdir` 파일 부재)은
 *   애초에 재시도를 **막지 않는다** — git이 `<name>1`로 새 등록을 잡는다. 남는 것은 회수되지 않는
 *   metadata 항목뿐이고 진행은 계속된다(즉 `prune`만이 지울 수 있는 잔재는 **막는 잔재가 아니다**).
 *   게다가 `prune`은 **경로 인자를 받지 않아**
 *   argv 수준에서 이 run의 worktree로 좁힐 방법이 없고, 디렉터리가 일시적으로 안 보이는 **다른**
 *   worktree의 HEAD·refs까지 지운다(그 worktree에만 있던 커밋이 unreachable이 된다 — 실측).
 *   얻는 것이 0이고 여는 것이 데이터 손실 축이라 닫힌 집합을 늘리지 않았다.
 */
export const GIT_WORKTREE_ACTIONS = ["add", "remove"] as const;
/**
 * **M11 적대적 리뷰가 더한 한정 — 크래시 산(産) `locked` 변종은 위 판정 밖이다.**
 *
 * 위 `prune` 기각은 **supervisor의 deadline kill**이 남기는 모양을 잰 것이고, 그 축에서는 TERM-first가
 * 전 경로에서 성립한다(`managedProcess.stop()` — TERM · 유예 · KILL). 그러나 **호스트 수준 사건**
 * (전원 손실 · OOM killer · 머신 크래시 · 그룹 전체 `kill -9`)은 git을 TERM 없이 끊을 수 있고, 그때는
 * 등록이 **`locked`** 로 남을 수 있다. 그 변종은 `add`도 `remove --force`도 `prune`도 되돌리지 못하고
 * `remove -f -f`(force 두 번)만 가능한데 **그 argv는 닫힌 집합에 없다** → 사람이 손으로 치운다.
 *
 * 이것은 `prune` 기각을 **강화한다**(prune은 이 모양도 못 고친다). 여기 적는 이유는 크래시 복구 때
 * 사람이 "닫힌 action으로 정리된다"고 잘못 읽지 않게 하려는 것이다. 대장 `B-37`.
 */
export type GitWorktreeAction = (typeof GIT_WORKTREE_ACTIONS)[number];

/**
 * **고정 controller entrypoint가 받아들이는 닫힌 action 집합**(3A 2차 리비전 B2 · 대장 `B-10`).
 * 여기 없는 문자열은 승인 문서에 담길 수 없고, 이 목록에 항목을 더하는 것 자체가 사람의 승인 대상이다.
 * M5c에서 실제로 필요한 것은 offline 계획 검증 하나뿐이라 그 하나만 있었다(없는 action을 미리 열지 않는다).
 *
 * **V3 M9 선결 1 — `run-tests` 추가**(로드맵 M9 절 "하드 게이트"). "fresh Codex test review"가 성립하려면
 * **테스트를 실행할 타입**이 있어야 하는데 `validate-plan` 하나로는 그것을 표현할 수 없었다. 확장하면서도
 * 열지 **않은** 것이 이 항목의 핵심이다: argv·shell 문자열·실행 파일·env·cwd는 여전히 **표현할 필드가 없고**,
 * 실행 대상은 manifest의 `executionAuthority.node` + `controllerEntrypoint` 하나로 고정된 채다. worker가
 * 고를 수 있는 것은 `authorityId`뿐이고 action·data·timeout은 **사람이 승인한 레코드**에서 나온다.
 */
export const CONTROLLER_ACTIONS = ["validate-plan", "run-tests"] as const;
export type ControllerAction = (typeof CONTROLLER_ACTIONS)[number];

/**
 * **`validate-plan`의 action 전용 입력**(3A 3차 리비전 B2 · 대장 `B-10`).
 *
 * 이전 판은 `data: string[]`(0..16 임의 문자열)이었다 → arity·의미·경로 범위·읽기 권한을 **미래 controller가
 * 지어내야 했고**, 그래서 그 인터페이스는 과승인이거나 폐기 대상이었다. 지금은 action마다 **정확한 key 집합**이
 * 있고 값의 의미가 계약에 적혀 있다.
 *
 * `planPath`는 **정규화된 workspace-relative 경로**이고 승인 시점에 ⓐ `writableRoots` 안 ⓑ 그 task의 승인
 * ownership 안(manifest에 있으면)임을 함께 본다. 이 action은 그 파일을 **읽기만** 한다 — 별도의 readableRoots를
 * 새로 만들지 않고 **이미 승인된 쓰기 범위 안쪽으로 읽기도 좁힌다**(더 좁은 쪽이 fail closed다).
 */
export interface ValidatePlanData {
  /** 검증할 계획 파일의 정규화된 workspace-relative 경로(읽기 전용 · 승인 범위 안). */
  planPath: string;
}

/**
 * **`run-tests`의 action 전용 입력**(V3 M9 선결 1). `validate-plan`과 **같은 형태**다 — 정확한 key 하나이고
 * 값의 의미가 계약에 적혀 있으며 승인 시점에 `writableRoots`·ownership 안임을 함께 본다.
 *
 * **테스트 명령이 여기 없는 것이 설계다.** 무엇을 어떻게 실행할지는 고정된 controller entrypoint가 정하고,
 * 승인 레코드가 고르는 것은 **어느 프로젝트 디렉터리에서** 그것을 돌릴지 하나뿐이다. 명령·인자·러너를
 * 데이터로 실으면 M5c가 삭제한 "모델이 고르는 명령" 통로가 되살아난다(로드맵 M9 위험 2).
 */
export interface RunTestsData {
  /** 테스트를 돌릴 프로젝트의 정규화된 workspace-relative 디렉터리(승인 범위 안). */
  projectPath: string;
}

/** action별 `data` key 집합(닫혀 있다 — 여기 없는 key는 승인 문서에 담길 수 없다). */
export const CONTROLLER_ACTION_DATA_KEYS: Record<ControllerAction, readonly string[]> = {
  "validate-plan": ["planPath"],
  "run-tests": ["projectPath"],
};

/**
 * autopilot 실행 정책(V3 M5c). 전부 bounded이고 **조용한 기본값이 없다** — manifest에 없으면 거부다.
 * 사람이 승인하는 것은 "얼마나 오래·몇 번·얼마나 기다릴 수 있는가"이며 이 값들이 deadline·재시도의 정본이다.
 */
export interface AutopilotPolicy {
  /** 1..4 */
  maxTaskAttempts: number;
  /** 1..4 */
  maxDeliveryAttempts: number;
  /** 0..60_000 */
  retryBackoffMs: number;
  /** 1_000..3_600_000 */
  deliveryDeadlineMs: number;
  /** 1_000..900_000 — 인정되는 진행 신호 없이 지날 수 있는 최대 시간. */
  maxNoProgressMs: number;
  /** 1_000..3_600_000 이고 `maxElapsedMs` 이하 — attempt 하나의 wall deadline. */
  maxAttemptElapsedMs: number;
  /** 100..30_000 — TERM 후 KILL까지의 유예. */
  cleanupTermGraceMs: number;
  /** 100..30_000 — KILL 후 zero-survivor 확인까지의 유예. */
  cleanupKillGraceMs: number;
}

/**
 * 로드맵 §8 milestone approval manifest. run 생성 시 **반드시** bind되고 durable state에 들어간다
 * (=> `stateContentDigest` → state↔event binding으로 손편집이 거부된다).
 *
 * 이 계약이 다루는 것은 **state 관련 권한**뿐이다: ownership 승인 · writable root · 동시 세션 ·
 * 만료. `allowedCommands`/`allowedDependencies`/`allowedNetworkDomains`/`maxTokens`/`maxElapsedMs`/
 * `localMergeAllowed`는 **기록·조회 전용**이며 M4c는 아무것도 실행하지 않는다(M5 executor가 순수
 * 조회 API로 물어본다 — `approvalManifest.ts`). repo의 hard deny는 manifest보다 항상 강하다.
 */
export interface MilestoneApprovalManifest {
  milestoneId: string;
  /** 승인 시점의 구체적인 commit hash(40자 소문자 hex). */
  approvedCommit: string;
  /** 쓰기가 허용된 workspace-relative root(정규화·사전순·중복 없음). */
  writableRoots: string[];
  /** taskId → 명시적으로 승인된 ownership 경로. 없는 taskId의 root/dependent task는 만들 수 없다. */
  ownershipByTask: Record<string, string[]>;
  allowedCommands: string[];
  allowedDependencies: ApprovedDependency[];
  allowedNetworkDomains: string[];
  /**
   * **승인된 실행 권위**(6차 독립 리뷰 A1) — 이 manifest가 유일한 trust root다.
   * provider·controller·실행 경계는 여기 적힌 경로만 열고 여기 적힌 digest와 정확히 같은 내용만
   * 실행한다. 호출자가 다른 경로를 지정할 통로는 없다(옵션 자체가 없다).
   * 없으면 **조용한 기본값 없이 거부**한다(`invalid_manifest`).
   */
  /**
   * M5c: `node`·`processObserver`가 더해졌고 `codex`는 **null 허용**이다 — offline manifest가 "live 추론이
   * 가능한 척" 하지 않게 한다(M5c는 Codex를 인스턴스화하지 않는다). 넷 다 정규 절대경로 + 내용 digest다.
   */
  executionAuthority: {
    /**
     * **V3 M10 T3 — worker 세션 실행 파일**(선택). 무인 loop의 live worker backend가 실행할 수 있는
     * **유일한** 프로그램이고, digest는 실행 경계에서 다시 확인한다. 이 키가 없는 승인에서는 live worker가
     * **표현 불가**다(backend 선택 자체가 거부된다 — 조용한 fallback이 아니다).
     */
    claude?: ApprovedExecutable;
    codex: ApprovedExecutable | null;
    /**
     * **대장 `B-7ⓐ` — 승인된 격리 `CODEX_HOME`**(선택). 사람이 **1회** `codex login`으로 자격증명을 넣어 둔
     * 전용 디렉터리이며, harness는 로그인을 대행·자동화하지도, auth 파일을 복사·영속화하지도 않는다.
     * **선택인 이유**: 이 키가 없는 승인은 "live 인증이 승인되지 않았다"를 뜻하고, 그 경우 홈은 기존 계약
     * 그대로 **완전히 비어 있어야** 한다(자식 env는 `CODEX_HOME` 하나뿐이므로 ambient 자격증명이 도달할
     * 통로가 애초에 없다 → 인증 없이 fail closed다). 있으면 `spec.codex.codexHome`은 **이 경로와 정확히
     * 같아야** 하고(다르면 spawn 0), 그때만 홈에 승인된 자격증명 파일이 있는 것이 허용된다.
     */
    codexHome?: ApprovedDirectory;
    /**
     * **claude worker 세션의 격리 `CLAUDE_CONFIG_DIR`**(V3 M11 · 대장 `C-86`). `codexHome`과 같은 자리·
     * 같은 의미다: "이 세션이 **누구의 자격증명**으로 도는가"를 승인 문서가 고정한다.
     *
     * **선택이다 — `claude`를 승인한 manifest에서도 그렇다**(V3 M11② · 사용자 결정 2026-08-23).
     * 있으면 `approvedWorkerExecutable()`이 경로·권한·소유권·신원 + "비어 있지 않음"을 구속하고,
     * 없으면 **ambient로 돈다**(`configDir: null`). 조용하지는 않다 — `runAutopilot`이 그것을
     * `report.workerIdentity`(`approved`/`ambient`)와 `worker_identity` 이벤트로 **명시**한다.
     *
     * (2026-08-23 정정: 이 주석은 한때 "`claude`를 승인하면 **필수**이므로 실행 파일만 승인하고 신원은
     * ambient로 두는 조합을 **표현 불가**로 만든다"라고 적었다. **M11②가 그 필수화를 되돌린 뒤에도
     * 주석만 남아** 없는 보안 성질을 주장했다 — `orchestrationKernel.approvedWorkerExecutable()`은
     * `claudeHome`이 없으면 `configDir: null`로 **통과시킨다**. 되돌린 이유는 그 조임이 `C-86` 자신의
     * 트리거("여러 계정·CI에서 무인 loop를 돌리는 첫 마일스톤 전")보다 일렀고 대가가 "이 harness를 쓰는
     * 모든 사람의 추가 로그인"이었기 때문이다. 잔여는 대장 `B-35`다.)
     */
    claudeHome?: ApprovedDirectory;
    /**
     * **claude worker 세션이 도는 모델**(V3 M11 · 모델 축 · 선택). `claudeHome`이 "**누구의** 자격증명으로
     * 도는가"를 고정하는 자리라면 이 키는 "**어느 모델로** 도는가"를 고정한다.
     *
     * ## 왜 이 축이 필요했나
     *
     * M11까지 실행 **파일**은 digest로, 자격증명 **신원**은 `claudeHome`으로 고정됐지만 **모델은 승인
     * 문서 어디에도 없었다**: `LIVE_WORKER_ARGS`에 `--model`이 없어 CLI 기본 모델로 돌았고 그 사실이
     * 영수증에도 남지 않았다 — `C-86`("누구의 구독인가가 승인 축 밖")과 **같은 부류의 구멍**이었다.
     *
     * ## 선택 축이다 (`claudeHome`과 같은 규율)
     *
     * 없으면 CLI 기본 모델로 돈다. 다만 **조용하지 않다**: `runAutopilot` 영수증
     * (`report.workerModel` · `worker_model` 이벤트)이 `cli_default`라고 적고, 그때 harness는 그 기본값이
     * **무엇인지 모른다고** 적는다(모르는 것을 안다고 적으면 그 자체가 거짓 영수증이다).
     *
     * ## 값은 닫힌 enum이 아니라 **닫힌 형태**다
     *
     * 정본은 `approvalManifest.CLAUDE_MODEL_PATTERN` 하나다. 모델 id 목록을 이 레포에 박는 안을 먼저
     * 검토하고 **기각했다** — 모델 id는 harness 밖에서 늘어나므로 enum은 곧 **만족 불가능한 계약**이
     * 되고(codex 0.145→0.146에서 이미 겪은 부류), 지금 그 집합을 실측할 방법도 없다(live 호출 금지 →
     * 기억으로 지어 쓴 allowlist는 재보지 않은 계약이다). 대신 **형태**를 좁혀 이 문자열이 argv에서
     * 두 번째 flag로 읽힐 수 없게 한다(선행 `-` 금지 · 공백 금지 · bounded charset). 모델은 권능 축이
     * 아니라 비용·품질 축이라는 점도 함께 판단했다 — 도구·MCP·설정은 이미 0이므로 잘못된 모델이 여는
     * 권한은 없고, 무엇으로 돌았는지는 영수증이 문자열 그대로 남긴다.
     *
     * 승인 문서 **밖에서** 이 값을 고를 통로는 없다(호출자 인자가 없다 — `LIVE_WORKER_ENV` 주석과 같은
     * 규율이다).
     */
    claudeModel?: string;
    /**
     * M5c 3A 2차 리비전 B2 — **모든 typed `run_process`가 실행하는 유일한 script**. digest는 실행 경계에서
     * 다시 확인한다. 승인 문서의 operation 레코드는 이 값을 바꾸거나 다른 경로를 고를 수 없다.
     */
    controllerEntrypoint: ApprovedExecutable;
    git: ApprovedExecutable;
    /** managed process supervisor를 띄우는 승인된 Node 실행 파일. */
    node: ApprovedExecutable;
    /** 자손 프로세스 관측(zero-survivor 확인)에 쓰는 승인된 실행 파일. */
    processObserver: ApprovedExecutable;
  };
  /** M5c — autopilot deadline·재시도 정책(필수). */
  autopilotPolicy: AutopilotPolicy;
  /**
   * M5c — taskId → 그 task가 요청할 수 있는 typed operation 권위 목록.
   * 목록에 없는 task는 **어떤 write·process도** 할 수 없다(빈 목록이 기본이고 부재는 hard deny다).
   */
  operationAuthorityByTask: Record<string, ApprovedOperation[]>;
  /** 동시에 running일 수 있는 task 수의 상한. */
  maxSessions: number;
  /** 선택 예산. 없으면 null(키는 durable 계약이라 항상 존재한다). */
  maxTokens: number | null;
  maxElapsedMs: number;
  /** **기록·조회 전용** — 이 값이 true여도 kernel은 git 조작을 하지 않는다. */
  localMergeAllowed: boolean;
  /**
   * **리뷰 왕복을 무인 loop의 하드 게이트로 쓴다는 선언**(V3 M11 · 대장 `C-98`). 값은 참가자 **taskId**
   * 뿐이다 — provider·세션·sandbox는 승인 문서가 고르는 값이 아니라 durable에서 파생한다(그래야 승인이
   * "리뷰어가 codex였다"고 **주장**할 수 없다).
   *
   * 선택인 이유는 호환이 아니라 의미다: 리뷰 왕복을 요구하지 않는 승인도 정당하며, 그 경우 loop는
   * 이 게이트를 돌리지 않는다. 있으면 `verify` task는 계약을 통과해야만 완료된다.
   */
  reviewRoundtrip?: {
    author: string;
    reviews: { code: string; security: string; test: string };
    revision: string;
    verify: string;
  };
  expiresAt: string;
}

/** message index 항목. Markdown body 전문은 `messages/<id>.md`에만 있고 여기엔 hash만 둔다. */
export interface MessageIndexEntry {
  messageId: string;
  type: AgentMessageType;
  taskId: string;
  parentTaskId: string | null;
  sender: string;
  recipient: string;
  createdAt: string;
  dependsOn: string[];
  artifactRefs: ArtifactPointer[];
  supersedes: string | null;
  /** run 디렉터리 상대 경로. */
  bodyPath: string;
  bodySha256: string;
  /** `SUMMARY_REQUIRED`가 true인 타입의 bounded summary. 나머지 타입은 null. */
  summary: string | null;
  /**
   * M4c — 중앙이 이 메시지를 **어느 task의 inbox로 전달했는지**(durable route 메타데이터).
   * null이면 중앙에서 끝나는 메시지다(예: reviewer → orchestrator `review_result`).
   * envelope에는 이 필드가 없다 — route는 agent가 아니라 **중앙 state**가 정한다.
   */
  routeToTaskId: string | null;
  /** 수신 task가 수령한 시각. 전달 대상이 아니거나 미수령이면 null. */
  acknowledgedAt: string | null;
  /**
   * M5c — **전달 재시도 메타데이터**(대장 `C-12→B`). `acknowledgedAt`은 완전하고 검증된 전달 turn이
   * 성공한 뒤에만 채워진다 — 실패는 여기에 재시도 정보만 원자적으로 남기고 **수령하지 않는다**.
   */
  delivery: MessageDelivery;
}

/** 전달 시도 이력(bounded). 전달 대상이 없는 메시지는 전부 초기값이다. */
export interface MessageDelivery {
  attempts: number;
  activeAttemptId: string | null;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  deadlineAt: string | null;
  lastMarker: DeliveryMarker | null;
}

export function emptyMessageDelivery(): MessageDelivery {
  return {
    attempts: 0,
    activeAttemptId: null,
    firstAttemptAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    deadlineAt: null,
    lastMarker: null,
  };
}

/** append-only event log 1줄. */
export interface OrchestrationEvent {
  eventId: number;
  prevHash: string;
  /**
   * 이 이벤트로 끝나는 커밋이 남긴 state 내용의 SHA-256 (커밋의 **마지막** 이벤트만 값을 갖고
   * 나머지는 null). state의 `lastEventId`/`lastEventHash`를 제외한 내용만 해싱하므로 순환하지 않는다:
   * state → event(digest) → chain hash → state.lastEventHash.
   * load는 이 값으로 "허용된 필드만 고친 state"가 kernel 커밋의 산물인지 확인한다.
   */
  stateDigest: string | null;
  at: string;
  type: OrchestrationEventType;
  /** 이 이벤트가 반영된 state revision. */
  revision: number;
  taskId: string | null;
  messageId: string | null;
  fromState: TaskState | null;
  toState: TaskState | null;
  reason: TransitionReason | null;
  artifactId: string | null;
  /**
   * M5c — **닫힌 nullable 감사 필드**(자유 형식 payload는 없다).
   * `actionId`는 호출자가 준 멱등 action 신원이다: 커밋 결과가 애매한 실패(대장 `C-37`)에서 재시작한
   * controller가 "내 요청이 durable해졌는가"를 event log에서 정확히 판정하는 근거다.
   */
  actionId: string | null;
  attemptId: string | null;
  turnId: string | null;
  operationId: string | null;
  /**
   * M5c 3A 3차 리비전 — dispatch/operation event가 **어떤 계획**에 묶였는지(canonical digest).
   * claim이 닫히고 pending이 사라진 뒤에도 감사 로그만으로 영수증↔계획 binding을 재구성할 수 있다.
   */
  planDigest: string | null;
  marker: string | null;
  tokenDelta: number | null;
  elapsedMs: number | null;
}

/** M5c 이전 event에는 없던 필드의 기본값(신규 event를 만들 때 쓰는 닫힌 초기값). */
export const EMPTY_EVENT_AUDIT = Object.freeze({
  actionId: null,
  attemptId: null,
  turnId: null,
  operationId: null,
  planDigest: null,
  marker: null,
  tokenDelta: null,
  elapsedMs: null,
} as const);

/**
 * **run 하나의 durable 예산 회계**(V3 M5c — 대장 `B-12`).
 *
 * 이전 판은 controller의 `#private` 필드에만 있었으므로 **재시작이 토큰·경과 예산을 리셋**했다 →
 * 무인 autopilot이 재시작을 반복하는 것만으로 승인된 상한을 무한히 넘길 수 있었다.
 * 지금 예산의 진실은 이 durable 레코드이고 controller는 여기서 읽어 여기에 더한다.
 */
export interface RunAccounting {
  /** 이 회계가 묶여 있는 승인의 canonical digest — 승인이 바뀌면 회계도 같이 못 쓴다(fail closed). */
  approvalDigest: string;
  budgetStartedAt: string;
  /** `min(budgetStartedAt + manifest.maxElapsedMs, manifest.expiresAt)` — 재시작해도 이 값이 정본이다. */
  budgetDeadlineAt: string;
  tokensUsed: number;
  /** monotonic(감소하지 않는다). */
  elapsedMsUsed: number;
  /** 이미 과금한 turnId(정렬·중복 없음, bounded) — 같은 turn을 두 번 과금하지 않는다. */
  chargedTurnIds: string[];
}

/** `outputs/orchestration/<run-id>/run_state.json` — orchestration 실행 상태의 SoR. */
export interface OrchestrationRunState {
  schemaVersion: string;
  runId: string;
  milestoneId: string;
  /**
   * M4c — 이 run에 bind된 승인 envelope(§8). run 생성 시 정해지고 이후 바뀌지 않는다.
   * 이 필드가 없는 pre-M4c state는 마이그레이션하지 않고 `state_pre_m4c_unsupported`로 거부한다.
   */
  manifest: MilestoneApprovalManifest;
  /**
   * M5c — **durable 토큰·경과 회계**(대장 `B-12`). 재시작은 예산을 새로 만들지 않고 이 값을 이어 쓴다.
   * 이 필드가 없는 pre-M5c state는 `state_pre_m5c_unsupported`로 거부한다(마이그레이션 없음).
   */
  accounting: RunAccounting;
  /** 성공한 kernel 변경 1회당 +1 (monotonic). */
  revision: number;
  /** events.jsonl의 줄 수 (monotonic). */
  lastEventId: number;
  /** events.jsonl 마지막 줄의 sha256. 이벤트 0개면 GENESIS_HASH. */
  lastEventHash: string;
  createdAt: string;
  updatedAt: string;
  /** taskId 오름차순 고정 — ready 목록·snapshot 결정성의 근거. */
  tasks: OrchestrationTask[];
  /** messageId 오름차순 고정. */
  messages: MessageIndexEntry[];
  /** artifactId 오름차순 고정. */
  artifacts: ArtifactRecord[];
}

/** 주입 가능한 clock (테스트 결정성). */
export type Clock = () => Date;

/** Date → 계약 타임스탬프 문자열. */
export function formatTimestamp(d: Date): string {
  const iso = d.toISOString();
  if (!TIMESTAMP_RE.test(iso)) {
    throw new OrchestrationError("clock_invalid", `clock이 계약 밖 타임스탬프를 냈다: ${iso}`);
  }
  return iso;
}

export function isSlug(v: unknown): v is string {
  return typeof v === "string" && SLUG_RE.test(v);
}

export function assertSlug(v: unknown, what: string): string {
  if (!isSlug(v)) {
    throw new OrchestrationError("invalid_id", `${what}는 slug(${SLUG_PATTERN})여야 한다`);
  }
  return v;
}

export function assertTimestamp(v: unknown, what: string): string {
  if (typeof v !== "string" || !TIMESTAMP_RE.test(v)) {
    throw new OrchestrationError("invalid_timestamp", `${what}는 UTC ISO-8601(밀리초 3자리)여야 한다`);
  }
  return v;
}

export function assertSha256(v: unknown, what: string): string {
  if (typeof v !== "string" || !SHA256_RE.test(v)) {
    throw new OrchestrationError("invalid_sha256", `${what}는 소문자 hex SHA-256이어야 한다`);
  }
  return v;
}

export function assertText(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new OrchestrationError("invalid_text", `${what}는 비어 있지 않은 문자열이어야 한다`);
  }
  if (v.length > max) {
    throw new OrchestrationError("text_too_long", `${what}는 ${max}자 이하여야 한다`);
  }
  if (v.includes("\0")) {
    throw new OrchestrationError("invalid_text", `${what}에 NUL 바이트가 있다`);
  }
  return v;
}

/**
 * workspace-relative 경로 정규화. absolute path · `..` · 빈 경로 · 빈 segment ·
 * backslash · NUL을 거부하고 `.` segment만 접는다. 실제 workspace 탈출(상위 symlink 포함)은
 * 파일 접근 시점에 realpath로 한 번 더 막는다(orchestrationStore.verifyArtifactFile).
 */
export function normalizeWorkspacePath(raw: unknown, what: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new OrchestrationError("path_empty", `${what}는 비어 있을 수 없다`);
  }
  // 길이는 **코드 포인트**로 센다 — schema `maxLength`와 같은 의미여야 한다(대장 `C-40`).
  if (codePointLength(raw) > LIMITS.maxPathLength) {
    throw new OrchestrationError("path_too_long", `${what}는 ${LIMITS.maxPathLength} 코드 포인트 이하여야 한다`);
  }
  if (raw.includes("\0")) {
    throw new OrchestrationError("path_nul", `${what}에 NUL 바이트가 있다`);
  }
  // **UTF-8 왕복이 깨지는 경로는 신원이 없다**(V3 M5c 3A 리비전 A4). 고립 surrogate는 파일 시스템
  // 경계에서 U+FFFD로 바뀌므로 승인된 문자열과 실제로 접근되는 경로가 갈린다.
  if (hasLoneSurrogate(raw)) {
    throw new OrchestrationError("path_not_utf8", `${what}에 고립 UTF-16 surrogate가 있다(UTF-8 왕복 불가)`);
  }
  if (raw.includes("\\")) {
    throw new OrchestrationError("path_backslash", `${what}는 POSIX 구분자(/)만 쓴다`);
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new OrchestrationError("path_absolute", `${what}는 workspace-relative여야 한다`);
  }
  const out: string[] = [];
  const segments = raw.split("/");
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s === ".") continue;
    if (s === "") {
      throw new OrchestrationError("path_empty_segment", `${what}에 빈 경로 segment가 있다`);
    }
    if (s === "..") {
      throw new OrchestrationError("path_parent_segment", `${what}는 '..'를 포함할 수 없다`);
    }
    out.push(s);
  }
  if (out.length === 0) {
    throw new OrchestrationError("path_empty", `${what}가 정규화 후 비었다`);
  }
  return out.join("/");
}

/**
 * **지시가 실은 operation authorityId 집합의 정규화**(V3 M11 — `B-38`/`C-111`).
 * `null`(= 지시 축 없음)과 배열을 구분해 그대로 돌려주고, 배열은 slug 검증 · 중복 거부 · 사전순 고정한다.
 *
 * kernel(`addTask`)과 store(`validateTask`)가 **같은 함수 하나**를 쓴다 — 두 곳이 갈라지면 "만들 때
 * 통과한 값이 다시 읽을 때 거부되는" 부류가 생긴다(`resourceClasses`가 M4b에서 정확히 그 이유로
 * 같은 함수를 공유하게 됐다). 상한은 승인 쪽과 같은 `maxOperationAuthorities`다: 지시는 승인을
 * **좁히기만** 하므로 승인이 담을 수 있는 수보다 많을 이유가 없다.
 */
export function normalizeAssignedOperations(raw: unknown, what: string): string[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new OrchestrationError("invalid_assigned_operations", `${what}는 배열 또는 null이어야 한다`);
  }
  if (raw.length > LIMITS.maxOperationAuthorities) {
    throw new OrchestrationError("invalid_assigned_operations", `${what}는 ${LIMITS.maxOperationAuthorities}개 이하여야 한다`);
  }
  const seen = new Set<string>();
  for (const a of raw) {
    if (!isSlug(a)) {
      throw new OrchestrationError("invalid_assigned_operations", `${what} 항목은 slug(${SLUG_PATTERN})여야 한다`);
    }
    if (seen.has(a)) {
      throw new OrchestrationError("invalid_assigned_operations", `${what}에 중복 authorityId가 있다: ${a}`);
    }
    seen.add(a);
  }
  return [...seen].sort();
}

/**
 * 배타 자원 class 배열 정규화 — slug 검증 · 중복 거부 · 사전순 고정(결정성).
 * **빈 배열은 유효하다**(자원 요구 없음 = 병렬 안전). class 이름은 자유 문자열이 아니라 slug다:
 * 정규화되지 않은 이름 두 개가 같은 자원을 뜻하면 직렬화 계약이 조용히 깨지기 때문이다.
 */
export function normalizeResourceClasses(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw)) {
    throw new OrchestrationError("invalid_resource_class", `${what}는 배열이어야 한다`);
  }
  if (raw.length > LIMITS.maxResourceClasses) {
    throw new OrchestrationError("resource_class_too_many", `${what}는 ${LIMITS.maxResourceClasses}개 이하여야 한다`);
  }
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isSlug(r)) {
      throw new OrchestrationError("invalid_resource_class", `${what} 항목은 slug(${SLUG_PATTERN})여야 한다`);
    }
    if (seen.has(r)) {
      throw new OrchestrationError("resource_class_duplicate", `${what}에 중복 class가 있다: ${r}`);
    }
    seen.add(r);
  }
  return [...seen].sort();
}

/** ownership 배열 정규화 — 중복 거부 후 사전순 고정(결정성). */
export function normalizeOwnership(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw)) {
    throw new OrchestrationError("invalid_ownership", `${what}는 배열이어야 한다`);
  }
  if (raw.length === 0) {
    throw new OrchestrationError("invalid_ownership", `${what}는 최소 1개 경로가 필요하다`);
  }
  if (raw.length > LIMITS.maxOwnershipPaths) {
    throw new OrchestrationError("ownership_too_many", `${what}는 ${LIMITS.maxOwnershipPaths}개 이하여야 한다`);
  }
  const seen = new Set<string>();
  for (const p of raw) {
    const n = normalizeWorkspacePath(p, `${what} 항목`);
    if (seen.has(n)) {
      throw new OrchestrationError("ownership_duplicate", `${what}에 중복 경로가 있다: ${n}`);
    }
    seen.add(n);
  }
  return [...seen].sort();
}
