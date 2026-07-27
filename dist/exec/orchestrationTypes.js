/**
 * V3 M4a/M4b — durable orchestration kernel의 타입 · 상한 · 원시 검증자.
 *
 * 로드맵 §3.1/§4/§5 기준. 이 계층은 **state-only/offline**이다: provider도 LLM도 실행하지 않고,
 * 향후 provider가 소비할 결정론적 task DAG · 상태 · 메시지 · artifact 포인터만 다룬다.
 * 기존 `types.ts`의 `ExecutionProvider`나 `runWorkflow`의 `run_state.json`과는 별개 계약이며
 * 둘 중 어느 것도 대체·복제하지 않는다.
 *
 * M4b가 더한 것: task별 **exclusive resource class 선언**(durable), 결정론적 scheduler,
 * run 단위 writer lock + stale writer 거부(`orchestrationStore.ts` / `orchestrationKernel.ts`).
 *
 * 여전히 범위 밖(의도적 미구현): 실제 agent spawn, 7 specialist registry 등록,
 * sibling/reviewer 라우팅과 나머지 6개 메시지 타입, milestone approval manifest 전체,
 * 범용 queue/retry/priority/fairness, 크래시 복구·stale lock 회수.
 */
/** state 파일과 message envelope 공통 schema 버전. */
export const ORCHESTRATION_SCHEMA_VERSION = "1";
/** M4a가 쓰는 task 상태 전부. 이 6개 외의 상태는 존재하지 않는다. */
export const TASK_STATES = [
    "pending",
    "ready",
    "running",
    "waiting_children",
    "completed",
    "blocked",
];
/**
 * M4a가 구현하는 메시지 타입 4종.
 * 로드맵 §5.1의 전체 10종 union 중 나머지(status_update / review_request / review_result /
 * revision_request / decision_request / decision)는 M4a 범위가 아니며 runtime·schema 모두 거부한다.
 */
export const AGENT_MESSAGE_TYPES = ["task_assignment", "spawn_request", "result", "blocker"];
/** 로드맵 §5.1 artifactRefs[].role. */
export const ARTIFACT_ROLES = ["input", "contract", "output", "evidence", "diff", "test"];
/** append-only event log의 이벤트 종류. */
export const EVENT_TYPES = [
    "run_created",
    "task_created",
    "message_accepted",
    "artifact_registered",
    "task_state_changed",
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
];
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
};
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
 * 타입별 Markdown body 필수 heading (로드맵 §5.2 그대로).
 * validator는 이 목록의 `## <heading>`이 **전부** 있고, 이 목록 **밖의 h2가 없고**,
 * 중복이 없을 것을 요구한다(closed set — schema의 additionalProperties:false와 같은 취지).
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
    if (raw.length > LIMITS.maxPathLength) {
        throw new OrchestrationError("path_too_long", `${what}는 ${LIMITS.maxPathLength}자 이하여야 한다`);
    }
    if (raw.includes("\0")) {
        throw new OrchestrationError("path_nul", `${what}에 NUL 바이트가 있다`);
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
