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
 * 여전히 범위 밖(의도적 미구현): 실제 agent spawn·동시 실행, provider bridge/autopilot(M5),
 * 범용 queue/retry/priority/fairness, 크래시 복구·stale lock 회수, schema 마이그레이션 도구.
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
] as const;
export type TaskState = (typeof TASK_STATES)[number];

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

/** append-only event log의 이벤트 종류. */
export const EVENT_TYPES = [
  "run_created",
  "task_created",
  "message_accepted",
  "artifact_registered",
  "task_state_changed",
  /** M4c — 수신 task가 자기 inbox의 전달을 수령했다(상태 전이 없음). */
  "delivery_acknowledged",
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
] as const;
export type TransitionReason = (typeof TRANSITION_REASONS)[number];

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
} as const;

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
  executionAuthority: { codex: ApprovedExecutable; git: ApprovedExecutable };
  /** 동시에 running일 수 있는 task 수의 상한. */
  maxSessions: number;
  /** 선택 예산. 없으면 null(키는 durable 계약이라 항상 존재한다). */
  maxTokens: number | null;
  maxElapsedMs: number;
  /** **기록·조회 전용** — 이 값이 true여도 kernel은 git 조작을 하지 않는다. */
  localMergeAllowed: boolean;
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
