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
];
/**
 * **배타 자원과 세션 예산을 점유하는 상태**(V3 M5c — 대장 `B-11`/`B-13`).
 * `prepared`는 이미 attempt·worktree·권한을 배정받았고 `cleaning`은 자손 프로세스가 남아 있을 수 있으므로
 * 둘 다 점유한다. 이 목록 하나가 scheduler·커밋 불변식·load 검증의 공통 정본이다.
 */
export const RESOURCE_HOLDING_STATES = ["prepared", "running", "cleaning"];
export function holdsResources(state) {
    return RESOURCE_HOLDING_STATES.includes(state);
}
/** 종료(terminal) 상태 — 여기서는 새 작업이 시작되지 않는다. */
export const TERMINAL_TASK_STATES = ["completed", "blocked", "cancelled"];
export function isTerminalTaskState(state) {
    return TERMINAL_TASK_STATES.includes(state);
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
];
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
];
/**
 * bounded summary를 **반드시** 갖는 타입(= true)과 **반드시 null**인 타입(= false).
 * 중앙 state로 옮기는 서술은 이 summary뿐이고 raw 본문·transcript는 어떤 타입도 옮기지 않는다.
 */
export const SUMMARY_REQUIRED = {
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
export const ARTIFACT_ROLES = ["input", "contract", "output", "evidence", "diff", "test"];
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
];
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
];
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
];
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
];
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
    "worker_failed",
    "plan_invalid",
    "operation_denied",
    "process_failed",
    "cleanup_unconfirmed",
    "stream_invalid",
    "delivery_failed",
    "review_invalid",
];
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
];
/** 전달 시도 1건의 닫힌 결과 marker. */
export const DELIVERY_MARKERS = ["delivered", "send_failed", "turn_failed", "deadline_exceeded", "attempts_exhausted"];
/** cleanup 진행 상태. `confirmed`만 다음 상태로 나갈 자격이 된다. */
export const CLEANUP_STATUSES = ["none", "required", "confirmed", "failed"];
/** typed operation 종류 — 닫힌 union(shell 문자열·wildcard·런타임 실행 파일 선택은 없다). */
export const APPROVED_OPERATION_KINDS = ["write_file", "run_process"];
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
};
/**
 * **문자열 길이를 Unicode 코드 포인트로 센다**(V3 M5c — 대장 `C-40`).
 *
 * JavaScript `.length`는 UTF-16 code unit 수이고 JSON Schema draft-07 `maxLength`는 **코드 포인트 수**다.
 * 그래서 `/` + 😀 256개는 코드 포인트 257개·UTF-16 513 unit이 되어 **schema는 통과시키고 runtime은
 * 거부했다**(같은 승인 문서에 대해 두 판정이 갈렸다). 경로 길이 상한은 이제 이 함수 하나로 판정한다.
 * (문자열 iterator는 surrogate pair를 하나로 센다. 고립 surrogate는 1로 세며 draft-07과 같다.)
 */
export function codePointLength(s) {
    let n = 0;
    for (const _ of s)
        n += 1;
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
export function hasLoneSurrogate(s) {
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
export const REQUIRED_BODY_HEADINGS = {
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
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.name = "OrchestrationError";
        this.code = code;
    }
}
/** 새 task의 초기 실행 메타데이터(모든 필드가 durable 계약이라 항상 존재한다). */
export function emptyTaskExecution() {
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
/**
 * **고정 controller entrypoint가 받아들이는 닫힌 action 집합**(3A 2차 리비전 B2 · 대장 `B-10`).
 * 여기 없는 문자열은 승인 문서에 담길 수 없고, 이 목록에 항목을 더하는 것 자체가 사람의 승인 대상이다.
 * M5c에서 실제로 필요한 것은 offline 계획 검증 하나뿐이라 그 하나만 있다(없는 action을 미리 열지 않는다).
 */
export const CONTROLLER_ACTIONS = ["validate-plan"];
/** action별 `data` key 집합(닫혀 있다 — 여기 없는 key는 승인 문서에 담길 수 없다). */
export const CONTROLLER_ACTION_DATA_KEYS = {
    "validate-plan": ["planPath"],
};
export function emptyMessageDelivery() {
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
});
/** Date → 계약 타임스탬프 문자열. */
export function formatTimestamp(d) {
    const iso = d.toISOString();
    if (!TIMESTAMP_RE.test(iso)) {
        throw new OrchestrationError("clock_invalid", `clock이 계약 밖 타임스탬프를 냈다: ${iso}`);
    }
    return iso;
}
export function isSlug(v) {
    return typeof v === "string" && SLUG_RE.test(v);
}
export function assertSlug(v, what) {
    if (!isSlug(v)) {
        throw new OrchestrationError("invalid_id", `${what}는 slug(${SLUG_PATTERN})여야 한다`);
    }
    return v;
}
export function assertTimestamp(v, what) {
    if (typeof v !== "string" || !TIMESTAMP_RE.test(v)) {
        throw new OrchestrationError("invalid_timestamp", `${what}는 UTC ISO-8601(밀리초 3자리)여야 한다`);
    }
    return v;
}
export function assertSha256(v, what) {
    if (typeof v !== "string" || !SHA256_RE.test(v)) {
        throw new OrchestrationError("invalid_sha256", `${what}는 소문자 hex SHA-256이어야 한다`);
    }
    return v;
}
export function assertText(v, what, max) {
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
export function normalizeWorkspacePath(raw, what) {
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
    const out = [];
    const segments = raw.split("/");
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        if (s === ".")
            continue;
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
 * 배타 자원 class 배열 정규화 — slug 검증 · 중복 거부 · 사전순 고정(결정성).
 * **빈 배열은 유효하다**(자원 요구 없음 = 병렬 안전). class 이름은 자유 문자열이 아니라 slug다:
 * 정규화되지 않은 이름 두 개가 같은 자원을 뜻하면 직렬화 계약이 조용히 깨지기 때문이다.
 */
export function normalizeResourceClasses(raw, what) {
    if (!Array.isArray(raw)) {
        throw new OrchestrationError("invalid_resource_class", `${what}는 배열이어야 한다`);
    }
    if (raw.length > LIMITS.maxResourceClasses) {
        throw new OrchestrationError("resource_class_too_many", `${what}는 ${LIMITS.maxResourceClasses}개 이하여야 한다`);
    }
    const seen = new Set();
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
export function normalizeOwnership(raw, what) {
    if (!Array.isArray(raw)) {
        throw new OrchestrationError("invalid_ownership", `${what}는 배열이어야 한다`);
    }
    if (raw.length === 0) {
        throw new OrchestrationError("invalid_ownership", `${what}는 최소 1개 경로가 필요하다`);
    }
    if (raw.length > LIMITS.maxOwnershipPaths) {
        throw new OrchestrationError("ownership_too_many", `${what}는 ${LIMITS.maxOwnershipPaths}개 이하여야 한다`);
    }
    const seen = new Set();
    for (const p of raw) {
        const n = normalizeWorkspacePath(p, `${what} 항목`);
        if (seen.has(n)) {
            throw new OrchestrationError("ownership_duplicate", `${what}에 중복 경로가 있다: ${n}`);
        }
        seen.add(n);
    }
    return [...seen].sort();
}
