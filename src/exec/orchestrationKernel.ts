/**
 * V3 M4a/M4b — deterministic durable orchestration kernel (로드맵 §3.1/§3.4/§4/§5).
 *
 * **중앙 kernel만이 상태 전이 주체다.** agent(호출자)는 메시지를 제출할 뿐이고 다른 task의
 * 상태·의존성·완료를 직접 바꾸는 API는 존재하지 않는다. 읽기 API는 전부 깊은 사본을 돌려주므로
 * 반환값을 수정해도 내부 state는 바뀌지 않는다.
 *
 * 이 커널은 **state-only/offline**이다: provider도 LLM도 프로세스도 띄우지 않는다.
 * 실제 agent 실행·provider bridge·autopilot은 M5 범위이고 여기서는 하지 않는다.
 *
 * M4c가 더한 것 — **중앙 경유 라우팅과 승인 envelope**:
 * - §5.1 메시지 10종 전부. 새 6종은 타입마다 **좁은 진입점 하나씩**이며 공용 API가 아니다.
 * - sibling/reviewer 전달은 전부 중앙을 지난다. 발신자는 자기 task에 대해서만 제출할 수 있고,
 *   수신자는 **중앙이** 관계(같은 parent · 의존)와 상태를 검증한 뒤 message index의 route로 남긴다 →
 *   **다른 task의 상태를 바꾸거나 남의 mailbox에 직접 쓰는 API는 여전히 없다.**
 * - run 생성 시 §8 승인 manifest를 bind한다. ownership 승인 · writable root · child 위임 ·
 *   `maxSessions` · 만료는 **커밋 경로 공용 불변식**으로 강제되므로 어떤 전이 경로도 우회할 수 없다.
 * - `roleId`는 7 specialist registry(+ 하위 role 한 겹) 안에서만 유효하다.
 *
 * M4b가 더한 것 — **배타 자원 class와 결정론적 scheduler**(두 번째 오케스트레이터를 만들지 않고
 * 이 커널 안에 좁은 API 2개만 추가했다):
 * - `scheduleReady()` — 시작 가능한 ready task를 taskId 순으로 고른다(state 변경 없음).
 * - `startScheduledBatch()` — 그 batch를 **한 커밋으로** running으로 올린다.
 * - `startTask()`도 같은 충돌 규칙을 적용하므로 scheduler를 우회할 수 없다.
 * queue·retry·priority·fairness·실제 동시 실행은 범위 밖이다.
 *
 * M5b가 더한 것 — **원자적 완료 트랜잭션 1개**(`completeTaskWithArtifacts`):
 * 산출물 전체 등록 + result 수락 + `completed` 전이를 **한 커밋**으로 처리한다. 부분 적용(앞 artifact만
 * durable에 남고 task는 미완료)이 생기지 않는다. 기존 `registerArtifact`/`submitResult`는 호환을 위해
 * 그대로 두고, 소유권·writableRoots·파일 신원 집행은 **같은 헬퍼 하나**(`addArtifact`)를 공유한다.
 *
 * M5b 4차 독립 리뷰가 더한 것:
 * - **발급 증명**(A2): 이 인스턴스는 `create`/`open`만 만들 수 있고(모듈 사설 토큰), own property가 0이며
 *   생성 시 freeze된다. `attestOrchestrationKernel`만 밖으로 나가고, 구조적으로 비슷한 delegate·proxy·
 *   subclass·override는 **완료 권위가 되지 못한다** → controller의 성공은 durable commit 없이는 발급되지 않는다.
 * - **호출자 소유 산출물의 단일 읽기 입양**(A4): `{path, role}`을 정확히 한 번 읽어 불변값으로 굳힌다.
 * - 발행의 복구 규칙은 `orchestrationStore.commitRun`/`recoverPendingCommit`에 있다(A3).
 *
 * 불변식:
 * - 유효하지 않은 입력은 state revision을 올리지 않고 영속 파일도 건드리지 않는다(검증 → 커밋 순서).
 * - `listReady()`·`scheduleReady()`·snapshot은 taskId 정렬로 결정론적이다.
 * - 같은 배타 자원 class를 요구하는 두 task는 **동시에 running이 되지 않는다**(커밋·load 양쪽 검사).
 * - 중앙이 운반하는 것은 bounded summary와 **검증된 artifact 포인터**뿐 — raw 본문·transcript 없음.
 */
import {
  AGENT_MESSAGE_SCHEMA_VERSION,
  type AgentMessageEnvelope,
  type AgentMessageType,
  type ArtifactPointer,
  type ArtifactRecord,
  type ArtifactRole,
  ARTIFACT_ROLES,
  type AutopilotMarker,
  AUTOPILOT_MARKERS,
  CENTRAL_MESSAGE_TYPES,
  type Clock,
  type DeliveryMarker,
  DELIVERY_MARKERS,
  EMPTY_EVENT_AUDIT,
  LIMITS,
  type MessageIndexEntry,
  type MilestoneApprovalManifest,
  ORCHESTRATOR_ID,
  type OperationReceipt,
  type OrchestrationEvent,
  OrchestrationError,
  type OrchestrationRunState,
  type OrchestrationTask,
  type PauseReason,
  PAUSE_REASONS,
  type PendingTaskResult,
  RUN_STATE_SCHEMA_VERSION,
  type RunAccounting,
  SAFETY_ONLY_EVENT_TYPES,
  SAFETY_ONLY_REASONS,
  SUMMARY_REQUIRED,
  type TaskState,
  type TransitionReason,
  assertSlug,
  assertText,
  assertTimestamp,
  emptyMessageDelivery,
  emptyTaskExecution,
  formatTimestamp,
  holdsResources,
  normalizeOwnership,
  normalizeResourceClasses,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { validateEnvelope, validateMessageBody } from "./agentMessage.js";
import { assertRegistryRoleId, pathWithin, validateApprovalManifest } from "./approvalManifest.js";
import type { TypedExecutionPlan, TypedOperation } from "./autopilotTypes.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";
import {
  OPERATION_RECEIPT_MARKERS,
  type RunPaths,
  assertReferentialIntegrity,
  commitRun,
  ensureRunDir,
  loadRun,
  manifestDigest,
  pendingDeliveries,
  runExists,
  runPaths,
  sha256Hex,
  verifyArtifactFile,
  writeSnapshot,
} from "./orchestrationStore.js";

/** 새 task를 만들 때 공통으로 필요한 입력. */
export interface TaskSeed {
  taskId: string;
  /** opaque role 식별자 (예: `tech_lead`, `qa.security`). registry 등록은 M4a 범위가 아니다. */
  roleId: string;
  title: string;
  /** bounded scope 서술. */
  scope: string;
  /** workspace-relative 소유 경로. M4a에서는 기록·검증 메타데이터일 뿐 실제 권한이 아니다. */
  ownership: string[];
  /**
   * 이 task가 요구하는 배타 자원 class(0..4개, slug). **생략·빈 배열 = 자원 요구 없음 = 병렬 안전**이며
   * durable state에는 항상 정규화된 배열로 기록된다. agent가 envelope로 스스로 선언하는 값이 아니라
   * task를 만드는 쪽(중앙)이 정하는 선언이다.
   */
  resourceClasses?: string[];
  /** 이 task의 task_assignment 메시지 id. */
  assignmentMessageId: string;
  /** 이 task의 task_assignment Markdown body. */
  assignmentBody: string;
}

export interface DependentTaskSeed extends TaskSeed {
  dependsOn: string[];
}

export interface ChildTaskSeed extends TaskSeed {
  dependsOn?: string[];
}

export interface SpawnInput {
  /** parent가 제출한 spawn_request envelope. */
  envelope: unknown;
  body: string;
  child: ChildTaskSeed;
}

export interface SubmitInput {
  envelope: unknown;
  body: string;
  /** 중앙 state로 옮기는 유일한 서술 필드 — Markdown body 전문은 옮기지 않는다. */
  summary: string;
}

/** sibling 전달을 요청하는 `status_update`. 생략하면 중앙에서 끝난다(전달 없음). */
export interface StatusUpdateInput extends SubmitInput {
  /**
   * 전달 대상. **taskId 또는 유일하게 식별되는 roleId**만 받는다. 같은 roleId를 가진 task가 둘 이상이면
   * `ambiguous_recipient`로 거부한다 — 중앙이 "누구에게"를 추측하지 않는다.
   */
  deliverTo?: string;
}

/** review/revision 요청 — 중앙이 대상 task(reviewer/revision worker)에게 보낸다. */
export interface SubjectInput extends SubmitInput {
  /** 검토·수정 대상 task. 요청을 받는 task(envelope.taskId)와 달라야 한다. */
  subjectTaskId: string;
}

export interface RegisterArtifactInput {
  taskId: string;
  /** workspace-relative 경로. */
  path: string;
  role: ArtifactRole;
}

/** 이 트랜잭션이 등록할 산출물 1건. */
export interface TaskOutput {
  /** workspace-relative 경로. */
  path: string;
  role: ArtifactRole;
}

/**
 * **산출물 등록 + result 수락 + 완료를 한 커밋으로** 처리하는 입력(V3 M5b 3차 독립 리뷰 A3).
 * `envelope.artifactRefs`는 **비어 있어야 한다** — 포인터(revision·sha256)는 이 트랜잭션이 등록하며
 * 만들고 envelope·task에 그 순서로 채운다. 호출자가 등록 전에 알 수 없는 값을 미리 주장하지 못한다.
 */
export interface CompleteTaskInput extends SubmitInput {
  outputs?: ReadonlyArray<TaskOutput>;
}

/** `completeTaskWithArtifacts`의 결과 — 완료된 task와 등록 순서 그대로의 포인터. */
export interface CompletedTask {
  task: OrchestrationTask;
  artifacts: ArtifactPointer[];
}

interface Mutation {
  events: Array<Omit<OrchestrationEvent, "prevHash" | "eventId" | "stateDigest">>;
  bodies: Array<{ messageId: string; body: string }>;
}

/** 감사 필드를 채우지 않은 이벤트에 닫힌 기본값을 붙인다(자유 payload 없음). */
type NewEvent = Partial<Omit<OrchestrationEvent, "prevHash" | "eventId" | "stateDigest">> & {
  at: string;
  type: OrchestrationEvent["type"];
  revision: number;
};

function event(e: NewEvent): Omit<OrchestrationEvent, "prevHash" | "eventId" | "stateDigest"> {
  return {
    taskId: null,
    messageId: null,
    fromState: null,
    toState: null,
    reason: null,
    artifactId: null,
    ...EMPTY_EVENT_AUDIT,
    ...e,
  };
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * **진짜 kernel 발급 등록부**(V3 M5b 4차 독립 리뷰 A2). 이 `WeakSet`은 모듈 밖으로 나가지 않고,
 * 들어오는 유일한 경로는 아래 생성자다. 밖으로 나가는 것은 판정 함수(`attestOrchestrationKernel`)뿐이며
 * "임의 객체를 진짜로 만들어 주는" 발급기·토큰·factory는 **하나도 export하지 않는다**.
 *
 * 이것이 필요한 이유: `StableController`가 `completeTaskWithArtifacts()`의 **반환값**으로 성공
 * (`completed`/`result_accepted`)을 발급한다. 이전 판의 controller는 메서드 모양과 `paths.workspaceRoot`만
 * 봤으므로, 스케줄링은 진짜 kernel에 위임하고 완료만 그럴듯한 값으로 위조하는 delegate가
 * **디스크 변화 0으로 성공을 만들 수 있었다**.
 */
const GENUINE_KERNELS = new WeakSet<object>();

/**
 * 모듈 사설 생성 토큰. `private constructor`는 TS 검사일 뿐 emitted JS에서는 호출 가능하므로,
 * 토큰 없이 `Reflect.construct`로 직접 만든 인스턴스는 등록부에 들어오지 못한다.
 */
const ISSUER_TOKEN: unique symbol = Symbol("orchestration-kernel-issuer");

/** controller가 실제로 부르는 kernel 메서드는 이 판정 함수가 **정확히 한 번씩** 읽어 넘긴다. */
export interface AttestedKernel {
  workspaceRoot: string;
  methods: Readonly<Record<string, unknown>>;
}

/**
 * **이 모듈이 발급한 진짜 `OrchestrationKernel`인가.** 통과하면 요청한 메서드를 정확히 한 번씩 읽은
 * 값과 `workspaceRoot`를 돌려주고, 아니면 `null`이다(fail closed).
 *
 * 거부되는 것: 평범한 구조적 객체, 진짜 kernel에 위임하는 delegate, `Proxy` wrapper, subclass,
 * prototype 교체·위조, 인스턴스 own property로 만든 메서드 override(`defineProperty` 포함),
 * 메서드 함수만 복사한 객체, 토큰 없이 생성자를 직접 부른 인스턴스.
 *
 * **주장하는 범위**: 같은 프로세스에서 *공개 API만으로는* 위조한 완료 권위를 controller에 넣을 수 없다.
 * **주장하지 않는 범위**: 모듈 내부를 직접 패치할 수 있는 코드(디버거·로더 조작)는 여전히 프로세스 안에 있다.
 */
export function attestOrchestrationKernel(kernel: unknown, methods: readonly string[]): Readonly<AttestedKernel> | null {
  if (typeof kernel !== "object" || kernel === null) return null;
  if (!GENUINE_KERNELS.has(kernel)) return null;
  if (Object.getPrototypeOf(kernel) !== OrchestrationKernel.prototype) return null;
  // 진짜 인스턴스의 상태는 전부 `#private`이므로 own property는 **하나도 없어야 한다** →
  // 생성 뒤 `defineProperty`로 만든 메서드 override·권위 교체가 여기서 전부 걸린다.
  if (Object.getOwnPropertyNames(kernel).length > 0 || Object.getOwnPropertySymbols(kernel).length > 0) return null;
  const proto = OrchestrationKernel.prototype as unknown as Record<string, unknown>;
  const captured: Record<string, unknown> = {};
  for (const m of methods) {
    const fn = (kernel as Record<string, unknown>)[m]; // ← 이 property를 읽는 유일한 지점
    if (typeof fn !== "function" || fn !== proto[m]) return null;
    captured[m] = fn;
  }
  const workspaceRoot = (kernel as OrchestrationKernel).paths.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) return null;
  return Object.freeze({ workspaceRoot, methods: Object.freeze(captured) });
}

// ── typed operation dispatch 권위 (V3 M5c 3A 리비전 A2) ──────────────────────

/**
 * **kernel이 발급한 진짜 dispatch permit 등록부.** 위 `GENUINE_KERNELS`와 같은 패턴이며 이 `WeakMap`은
 * 모듈 밖으로 나가지 않는다. 들어오는 유일한 경로는 `issueOperationDispatchPermit()`이고, 밖으로 나가는
 * 것은 판정 함수 `readDispatchAuthority()`뿐이다 — **임의 데이터를 권위로 만들어 주는 토큰·factory·
 * 등록 함수는 하나도 export하지 않는다.**
 *
 * 이것이 필요한 이유(3A 1차 판의 결함): 집행기가 `OperationDispatchContext`라는 **평범한 구조적 객체**를
 * 받았으므로, 위조한 manifest·ownership·workspaceRoot를 담은 객체 하나로 `../victim` 쓰기와 프로세스
 * 실행 명세를 얻을 수 있었고, 만료·예산 deadline·task lifecycle·attempt 신원은 아예 보지 않았다.
 */
const GENUINE_PERMITS = new WeakMap<object, PermitRecord>();

interface PermitRecord {
  /** **현재** durable state를 다시 읽는다(낡은 호출자 snapshot을 쓰지 않는다). */
  readState: () => OrchestrationRunState;
  /** kernel이 주입받은 clock — 호출자가 시각을 고를 수 없다. */
  now: () => string;
  workspaceRoot: string;
  /** 이 permit에 **묶인** 검증·동결된 계획. operation은 이 배열의 항목 그 자체여야 한다. */
  plan: TypedExecutionPlan;
  /** 발급 시점의 봉인된 preflight digest. dispatch 직전에 현재 state로 다시 계산해 대조한다. */
  preflightDigest: string;
  attemptNo: number;
}

/**
 * **봉인된 dispatch permit**. 여기 담긴 값은 **감사·집행 입력**이고 그 자체가 권위는 아니다 —
 * 권위는 등록부 안의 kernel 연결에서만 나오므로 같은 필드를 가진 평범한 객체는 아무것도 얻지 못한다.
 *
 * `plan`은 **kernel이 durable 신원에 대고 검증하고 깊이 동결한** 계획이다. 집행기는 이 배열의 항목
 * **그 자체**만 집행할 수 있으므로(신원 비교), 호출자가 들고 있던 원본 계획을 몰래 바꿔치기할 수 없다.
 */
export interface OperationDispatchPermit {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly plan: TypedExecutionPlan;
}

/**
 * dispatch 직전에 **현재 durable 상태에서 새로 읽은** 집행 권위. 동결된 값이며 호출자가 만들 수 없다.
 */
export interface DispatchAuthority {
  readonly workspaceRoot: string;
  /** 현재 durable state의 승인 manifest 정본(호출자 사본이 아니다). */
  readonly manifest: MilestoneApprovalManifest;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly turnId: string;
  /** **현재** durable task ownership(manifest에 없는 child 위임도 여기서 나온다). */
  readonly ownership: readonly string[];
  /** kernel clock이 정한 집행 시각. */
  readonly nowIso: string;
}

/** `readDispatchAuthority`가 낼 수 있는 **안정 거부 코드 전부**(닫힌 목록). */
export const DISPATCH_AUTHORITY_CODES = [
  /** permit이 이 kernel 모듈이 발급한 것이 아니다(평범한/위조 객체 · 재구성 · proxy). */
  "dispatch_permit_invalid",
  /** operation이 그 permit에 묶인 검증된 계획의 항목이 아니다(위조·변조·다른 계획). */
  "dispatch_operation_unbound",
  /** task가 지금 `running`이 아니다(prepared·cleaning·completed·cancelled·…). */
  "dispatch_task_not_running",
  /** durable attempt/turn 신원이 permit과 다르다(낡은 attempt · 다른 turn). */
  "dispatch_identity_stale",
  /** 승인·예산·ownership·자원·권위가 preflight 봉인 이후에 바뀌었다. */
  "preflight_drift",
  /** `now >= manifest.expiresAt`(경계 포함 — 로드맵 §8.1). */
  "manifest_expired",
  /** `now >= accounting.budgetDeadlineAt`(경계 포함). */
  "budget_elapsed_exhausted",
  /** 시계 역행 등 판정 자체가 불가능하다. */
  "clock_invalid",
] as const;
export type DispatchAuthorityCode = (typeof DISPATCH_AUTHORITY_CODES)[number];

function dispatchDenied(code: DispatchAuthorityCode, message: string): OrchestrationError {
  return new OrchestrationError(code, message);
}

/**
 * **이 operation을 지금 집행해도 되는가.** 통과하면 현재 durable 상태에서 새로 읽은 동결 권위를 돌려주고,
 * 아니면 던진다(fail closed · 부수 효과 0). 집행기는 **모든 효과·명세 발급 직전에 이것을 다시 부른다.**
 *
 * 확인하는 것(전부 **현재** durable state에서):
 * 1. permit이 이 모듈 발급인가(등록부 조회 — 구조적 위조 불가).
 * 2. operation이 그 permit에 묶인 **검증된 계획의 항목 그 자체**인가(신원 비교 — 변조·합성 거부).
 * 3. 시계가 정상이고 `now < expiresAt`이며 `now < accounting.budgetDeadlineAt`인가(**등호는 거부**).
 * 4. run/task 신원이 맞고 task가 **지금 `running`** 인가.
 * 5. durable attempt/turn 신원이 permit과 같은가(낡은 attempt·다른 turn 거부).
 * 6. 봉인된 preflight digest가 **현재 state로 다시 계산해도** 같은가 → 승인 canonical digest · 예산
 *    deadline · attempt 번호 · ownership · 배타 자원 · **승인된 operation 권위**가 그대로라는 뜻이다.
 * 7. manifest canonical digest가 durable `accounting.approvalDigest`와 같은가.
 */
export function readDispatchAuthority(permit: unknown, op: TypedOperation): Readonly<DispatchAuthority> {
  if (typeof permit !== "object" || permit === null) {
    throw dispatchDenied("dispatch_permit_invalid", "dispatch permit이 kernel 발급 값이 아니다");
  }
  const record = GENUINE_PERMITS.get(permit);
  if (record === undefined) {
    throw dispatchDenied("dispatch_permit_invalid", "dispatch permit이 kernel 발급 값이 아니다");
  }
  const bound = permit as OperationDispatchPermit;
  if (!record.plan.operations.some((candidate) => candidate === op)) {
    throw dispatchDenied("dispatch_operation_unbound", "operation이 이 permit에 묶인 검증된 계획의 항목이 아니다");
  }

  const state = record.readState();
  const now = record.now();
  if (now < state.createdAt || now < state.accounting.budgetStartedAt) {
    throw dispatchDenied("clock_invalid", "집행 시각이 run 시작보다 이르다");
  }
  // **경계 포함으로 닫는다**(로드맵 §8.1 — 전진 작업은 `now >= expiresAt`에서 전부 거부).
  if (now >= state.manifest.expiresAt) {
    throw dispatchDenied("manifest_expired", "승인 manifest가 만료됐다(전진 작업 금지)");
  }
  if (now >= state.accounting.budgetDeadlineAt) {
    throw dispatchDenied("budget_elapsed_exhausted", "승인된 경과 예산 deadline을 넘었다");
  }
  if (state.runId !== bound.runId) {
    throw dispatchDenied("dispatch_identity_stale", "permit의 run 신원이 현재 durable run과 다르다");
  }
  const task = state.tasks.find((t) => t.taskId === bound.taskId);
  if (task === undefined) {
    throw dispatchDenied("dispatch_identity_stale", "permit의 task가 현재 durable state에 없다");
  }
  if (task.state !== "running") {
    throw dispatchDenied("dispatch_task_not_running", `typed operation은 running task만 집행할 수 있다 (현재 ${task.state})`);
  }
  if (task.execution.attemptId !== bound.attemptId || task.execution.attemptNo !== record.attemptNo) {
    throw dispatchDenied("dispatch_identity_stale", "durable attempt 신원이 permit과 다르다");
  }
  // `turnId`는 usage 과금 시점에 durable해진다 — 아직 없으면(`null`) permit의 turn이 유일한 후보이고,
  // 이미 있으면 **정확히 같아야** 한다(다른 turn의 계획을 이 attempt에 밀어 넣을 수 없다).
  if (task.execution.turnId !== null && task.execution.turnId !== bound.turnId) {
    throw dispatchDenied("dispatch_identity_stale", "durable turn 신원이 permit과 다르다");
  }
  if (task.execution.preflightDigest !== record.preflightDigest || preflightDigest(state, task) !== record.preflightDigest) {
    throw dispatchDenied("preflight_drift", "승인·예산·ownership·자원·권위가 preflight 봉인 이후에 바뀌었다");
  }
  if (manifestDigest(state.manifest) !== state.accounting.approvalDigest) {
    throw dispatchDenied("preflight_drift", "현재 manifest가 durable 승인 digest와 다르다");
  }

  return Object.freeze({
    workspaceRoot: record.workspaceRoot,
    manifest: state.manifest,
    runId: state.runId,
    taskId: task.taskId,
    attemptId: bound.attemptId,
    turnId: bound.turnId,
    ownership: Object.freeze([...task.ownership]),
    nowIso: now,
  });
}

export class OrchestrationKernel {
  /** 발급 시점에 freeze한 경로 묶음. **own property가 아니라 prototype getter**로만 읽힌다(A2). */
  readonly #paths: RunPaths;
  #state: OrchestrationRunState;
  readonly #clock: Clock;

  private constructor(token: symbol, paths: RunPaths, state: OrchestrationRunState, clock: Clock) {
    if (token !== ISSUER_TOKEN) {
      throw new OrchestrationError("kernel_issuer_required", "OrchestrationKernel은 create/open으로만 만들 수 있다");
    }
    this.#paths = Object.freeze({ ...paths });
    this.#state = state;
    this.#clock = clock;
    // own property가 하나도 없는 인스턴스를 **얼린다** → 밖에서 `defineProperty`로 메서드·권위를
    // 덧붙일 수 없다(`#private` 필드는 property가 아니므로 내부 상태 전이는 그대로 된다).
    Object.freeze(this);
    GENUINE_KERNELS.add(this);
  }

  /** 이 run의 경로 묶음(**freeze된 값** — 반환값을 고쳐도 kernel 권위는 바뀌지 않는다). */
  get paths(): RunPaths {
    return this.#paths;
  }

  /**
   * 새 run 생성. 이미 있으면 거부한다(조용한 덮어쓰기 금지).
   * **manifest는 필수다** — 기본값을 두면 그것이 곧 조용한 자동 승인이다.
   */
  static create(opts: {
    workspaceRoot: string;
    runId: string;
    milestoneId: string;
    manifest: unknown;
    clock?: Clock;
  }): OrchestrationKernel {
    const paths = runPaths(opts.workspaceRoot, opts.runId);
    if (runExists(paths)) {
      throw new OrchestrationError("run_already_exists", `이미 존재하는 run이다: ${opts.runId}`);
    }
    const clock = opts.clock ?? (() => new Date());
    const now = formatTimestamp(clock());
    const milestoneId = assertSlug(opts.milestoneId, "milestoneId");
    const manifest = validateApprovalManifest(opts.manifest);
    if (manifest.milestoneId !== milestoneId) {
      throw new OrchestrationError(
        "manifest_milestone_mismatch",
        `manifest.milestoneId(${manifest.milestoneId})가 run(${milestoneId})과 다르다`,
      );
    }
    assertNotExpired(manifest, now);
    const seed: OrchestrationRunState = {
      schemaVersion: RUN_STATE_SCHEMA_VERSION,
      runId: paths.runId,
      milestoneId,
      manifest,
      // **durable 예산은 run 생성 시 한 번 정해지고 재시작이 새로 만들지 않는다**(대장 `B-12`).
      accounting: seedAccounting(manifest, now),
      revision: 1,
      lastEventId: 0,
      lastEventHash: "0".repeat(64),
      createdAt: now,
      updatedAt: now,
      tasks: [],
      messages: [],
      artifacts: [],
    };
    ensureRunDir(paths);
    const committed = commitRun(paths, {
      state: seed,
      events: [event({ at: now, type: "run_created", revision: 1 })],
      bodies: [],
      // 최초 커밋 — lock 안에서 "state 파일이 아직 없다"를 다시 확인한다(두 프로세스 동시 create 방지).
      base: null,
    });
    return new OrchestrationKernel(ISSUER_TOKEN, paths, committed, clock);
  }

  /** 기존 run 적재. state/event/message/artifact 검증에 실패하면 던진다(fail-closed). */
  static open(opts: { workspaceRoot: string; runId: string; clock?: Clock }): OrchestrationKernel {
    const paths = runPaths(opts.workspaceRoot, opts.runId);
    const { state } = loadRun(paths);
    return new OrchestrationKernel(ISSUER_TOKEN, paths, state, opts.clock ?? (() => new Date()));
  }

  // ── 읽기 (전부 깊은 사본) ────────────────────────────────────────────────

  getState(): OrchestrationRunState {
    return clone(this.#state);
  }

  /**
   * 이 run에 bind된 승인 envelope(깊은 사본). M5 executor는 이 값과
   * `approvalManifest.ts`의 순수 술어(`commandAllowed`/`dependencyAllowed`/`networkDomainAllowed`)로
   * 권한을 **조회만** 한다 — kernel은 명령·설치·네트워크·merge를 실행하지 않는다.
   */
  getManifest(): MilestoneApprovalManifest {
    return clone(this.#state.manifest);
  }

  /**
   * 이 task의 inbox에서 아직 수령하지 않은 전달(순서 고정). durable state만 보므로 재시작 후에도 동일하다.
   */
  listPendingInbox(taskId: string): MessageIndexEntry[] {
    return pendingDeliveries(this.#state, assertSlug(taskId, "taskId")).map(clone);
  }

  /** run 전체에서 다음에 전달할 메시지 1건(없으면 null). 같은 state면 항상 같은 답이다. */
  nextPendingDelivery(): MessageIndexEntry | null {
    const next = pendingDeliveries(this.#state)[0];
    return next ? clone(next) : null;
  }

  getTask(taskId: string): OrchestrationTask | null {
    const t = this.#state.tasks.find((x) => x.taskId === taskId);
    return t ? clone(t) : null;
  }

  /** ready task 목록 — taskId 오름차순 고정(결정론적). */
  listReady(): OrchestrationTask[] {
    return this.#state.tasks.filter((t) => t.state === "ready").map(clone);
  }

  /**
   * 다음에 시작할 수 있는 task를 **결정론적으로** 고른다(state·파일 변경 없음 — 읽기 전용).
   *
   * taskId 오름차순으로 훑으며 ① 이미 자원을 점유한 task(`prepared`/`running`/`cleaning`)의 class와
   * ② 같은 batch에서 앞서 고른 task의 class를 모두 피한다. `retry_wait`은 `retryAt`이 **된 것만** 고른다
   * (두 번째 scheduler를 만들지 않는다 — 재시도도 이 scheduler 하나가 고른다).
   *
   * @deprecated `planRunnableBatch()`를 쓴다. 이 이름은 M4b 호출부 호환을 위해 남아 있다.
   */
  scheduleReady(limit: number = LIMITS.maxScheduleBatch): OrchestrationTask[] {
    return this.planRunnableBatch(limit).items;
  }

  /**
   * **M5c 단일 scheduler 진입점**(대장 `B-11`). `revision`을 함께 돌려주는 이유: preflight 결정은
   * **이 batch를 고른 그 state**에 대한 것이어야 하므로, 커밋이 `baseRevision`을 대조해 낡은 결정을 거부한다.
   */
  planRunnableBatch(limit: number = LIMITS.maxScheduleBatch): { revision: number; items: OrchestrationTask[] } {
    const now = formatTimestamp(this.#clock());
    return {
      revision: this.#state.revision,
      items: selectSchedulable(this.#state, assertBatchLimit(limit), now).map(clone),
    };
  }

  /**
   * **원자적 preflight 커밋**(대장 `B-11`). `planRunnableBatch()`가 고른 **정확히 그 batch**에 대한 결정을
   * 받아 각 task를 `prepared`/`paused`/`retry_wait`/`blocked`로 **한 커밋에** 옮긴다.
   *
   * 이전 판(M5b)은 batch 전체를 먼저 `running`으로 올리고 **그 다음에** task별 게이트를 봤다 →
   * 예산이 batch 중간에 소진되면 남은 task가 provider 호출 0으로 `running`에 남아 자원을 붙잡았다.
   * 지금은 **아무 프로세스도 뜨지 않은 `prepared`** 까지만 원자적으로 가고, 실제 시작은
   * `startPreparedTask()`가 task 하나씩 한다 → batch preflight 실패가 남을 running으로 새지 않는다.
   *
   * 결정 목록은 batch와 **정확히 같은 taskId 집합**이어야 한다(누락·추가·중복 전부 거부).
   */
  commitPreflightBatch(input: PreflightBatchInput): PreflightBatchResult {
    const baseRevision = input?.baseRevision;
    if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision)) {
      throw new OrchestrationError("invalid_preflight", "baseRevision은 정수여야 한다");
    }
    if (baseRevision !== this.#state.revision) {
      throw new OrchestrationError(
        "preflight_stale_batch",
        `preflight 결정이 다른 revision(${baseRevision} ≠ ${this.#state.revision})의 batch에 대한 것이다`,
      );
    }
    const actionId = assertSlug(input.actionId, "actionId");
    const decisions = adoptDecisions(input.decisions);
    const outcomes: PreflightOutcome[] = [];
    this.#mutate((draft, now) => {
      const planned = selectSchedulable(draft, LIMITS.maxScheduleBatch, now).map((t) => t.taskId);
      const decided = decisions.map((d) => d.taskId);
      if (planned.join(",") !== [...decided].sort().join(",")) {
        throw new OrchestrationError(
          "preflight_batch_mismatch",
          "preflight 결정 집합이 scheduler가 고른 batch와 정확히 같지 않다(누락·추가·중복 거부)",
        );
      }
      const mutation: Mutation = { events: [], bodies: [] };
      for (const id of planned) {
        const d = decisions.find((x) => x.taskId === id)!;
        const task = requireTask(draft, id);
        const from = task.state;
        switch (d.outcome) {
          case "prepared": {
            if (task.execution.attemptNo >= draft.manifest.autopilotPolicy.maxTaskAttempts) {
              throw new OrchestrationError("attempt_limit_exceeded", `task ${id}의 attempt 상한을 넘었다`);
            }
            task.execution = {
              ...emptyTaskExecution(),
              attemptNo: task.execution.attemptNo + 1,
              attemptId: d.attemptId,
              operationReceipts: [],
            };
            task.execution.preflightDigest = preflightDigest(draft, task);
            setState(draft, now, mutation, task, "prepared", "preflight_accepted", { actionId, attemptId: d.attemptId });
            break;
          }
          case "paused":
            task.execution = { ...task.execution, pauseReason: d.pauseReason, retryAt: null, retryDeadlineAt: null };
            setState(draft, now, mutation, task, "paused", "paused", { actionId, marker: d.pauseReason });
            mutation.events.push(
              event({ at: now, type: "task_paused", revision: draft.revision, taskId: id, actionId, marker: d.pauseReason }),
            );
            break;
          case "retry_wait": {
            const policy = draft.manifest.autopilotPolicy;
            task.execution = {
              ...task.execution,
              retryAt: addMs(now, policy.retryBackoffMs),
              retryDeadlineAt: draft.accounting.budgetDeadlineAt,
              pauseReason: null,
            };
            setState(draft, now, mutation, task, "retry_wait", "retry_scheduled", { actionId });
            mutation.events.push(
              event({ at: now, type: "retry_scheduled", revision: draft.revision, taskId: id, actionId }),
            );
            break;
          }
          case "blocked":
            task.blockerSummary = `[preflight] ${d.blockedReason}`;
            task.execution = { ...task.execution, pauseReason: null };
            setState(draft, now, mutation, task, "blocked", "policy_blocked", { actionId, marker: d.blockedReason });
            break;
          case "deferred":
            // 이번 회차에는 시작하지 않는다. 상태·attempt·자원을 **하나도** 건드리지 않는다.
            break;
        }
        outcomes.push({ taskId: id, from, to: task.state });
      }
      // preflight batch 하나가 남기는 단일 요약 이벤트(감사에서 "이 batch가 원자적이었다"를 읽는 근거).
      mutation.events.push(event({ at: now, type: "preflight_committed", revision: draft.revision, actionId }));
      recompute(draft, now, mutation);
      return mutation;
    });
    return { revision: this.#state.revision, outcomes: outcomes.map(clone) };
  }

  /**
   * **prepared → running.** 이 메서드가 실제 실행 직전에 불리는 유일한 시작 지점이다.
   *
   * 봉인된 preflight를 **다시 계산해 대조**하므로(`preflight_drift`) 준비 이후에 ownership·자원·승인·
   * 예산 deadline이 바뀌었으면 시작하지 않는다. attempt wall deadline은
   * `min(now + maxAttemptElapsedMs, budgetDeadlineAt, expiresAt)`이며 **kernel이 계산한다**(호출자 값 아님).
   */
  startPreparedTask(input: { taskId: string; actionId: string; leaseMarker: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    const leaseMarker = assertLease(input.leaseMarker);
    this.#mutate((draft, now) => {
      const task = requireTask(draft, taskId);
      if (task.state !== "prepared") {
        throw new OrchestrationError("preflight_required", `startPreparedTask는 prepared task만 가능하다 (현재 ${task.state})`);
      }
      if (task.execution.preflightDigest !== preflightDigest(draft, task)) {
        throw new OrchestrationError("preflight_drift", `task ${taskId}의 봉인된 preflight가 준비 이후에 바뀌었다`);
      }
      const mutation: Mutation = { events: [], bodies: [] };
      task.execution = {
        ...task.execution,
        phaseStartedAt: now,
        wallDeadlineAt: earliest([
          addMs(now, draft.manifest.autopilotPolicy.maxAttemptElapsedMs),
          draft.accounting.budgetDeadlineAt,
          draft.manifest.expiresAt,
        ]),
        lastProgressAt: null,
        progressCount: 0,
        processLeaseMarker: leaseMarker,
        terminalMarker: null,
        cleanupStatus: "required",
      };
      setState(draft, now, mutation, task, "running", "started", { actionId, attemptId: task.execution.attemptId });
      return mutation;
    });
    return clone(requireTask(this.#state, taskId));
  }

  getMessage(messageId: string): MessageIndexEntry | null {
    const m = this.#state.messages.find((x) => x.messageId === messageId);
    return m ? clone(m) : null;
  }

  getArtifact(artifactId: string): ArtifactRecord | null {
    const a = this.#state.artifacts.find((x) => x.artifactId === artifactId);
    return a ? clone(a) : null;
  }

  /** state에서 snapshot.md를 결정론적으로 재생성한다(파생물 — state/event 변경 없음). */
  rebuildSnapshot(): string {
    return writeSnapshot(this.paths, this.#state);
  }

  // ── 변경 (전부 kernel 경유) ─────────────────────────────────────────────

  createRootTask(seed: TaskSeed): OrchestrationTask {
    return this.#createTask({ ...seed, dependsOn: [] }, null);
  }

  createDependentTask(seed: DependentTaskSeed): OrchestrationTask {
    return this.#createTask(seed, null);
  }

  /**
   * parent가 제출한 `spawn_request`를 검증하고 child task를 만든다.
   * child도 같은 API로 자기 child를 요청할 수 있다(depth/개수 상한 안에서).
   */
  requestSpawn(input: SpawnInput): OrchestrationTask {
    let created: OrchestrationTask | null = null;
    this.#mutate((draft, now) => {
      const envelope = validateEnvelope(input.envelope);
      if (envelope.type !== "spawn_request") {
        throw new OrchestrationError("message_type_mismatch", "requestSpawn에는 spawn_request만 제출할 수 있다");
      }
      const parent = requireTask(draft, envelope.taskId);
      // 이미 한 번 spawn해서 waiting_children인 parent도 상한 안에서 child를 더 요청할 수 있다.
      if (parent.state !== "running" && parent.state !== "waiting_children") {
        throw new OrchestrationError(
          "invalid_transition",
          `spawn_request는 running/waiting_children task만 제출할 수 있다 (현재 ${parent.state})`,
        );
      }
      if (parent.childTaskIds.length >= LIMITS.maxChildrenPerTask) {
        throw new OrchestrationError("child_limit_exceeded", `task당 child는 ${LIMITS.maxChildrenPerTask}개까지다`);
      }
      const depth = parent.depth + 1;
      if (depth > LIMITS.maxDepth) {
        throw new OrchestrationError("depth_limit_exceeded", `child depth 상한은 ${LIMITS.maxDepth}이다 (요청 ${depth})`);
      }

      const mutation: Mutation = { events: [], bodies: [] };
      const child = addTask(draft, now, mutation, { ...input.child, dependsOn: input.child.dependsOn ?? [] }, parent.taskId, depth);
      parent.childTaskIds.push(child.taskId);
      parent.childTaskIds.sort();
      setState(draft, now, mutation, parent, "waiting_children", "spawn_requested");

      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, null);
      recompute(draft, now, mutation);
      created = child;
      return mutation;
    });
    return clone(created!);
  }

  /**
   * **폐기됨 — ready → running 직접 전이는 M5c에서 존재하지 않는다**(대장 `B-11`).
   *
   * 남겨 둔 이유는 "우회로가 없다"를 **안정 코드로 단정할 수 있게** 하는 것이다: 제거하면 `TypeError`가
   * 나서 taxonomy가 없고, 남기면 어떤 호출자도 `preflight_required`를 받는다. 커밋을 시도하지 않으므로
   * 전이 0·디스크 변화 0이다. 시작 경로는 `planRunnableBatch` → `commitPreflightBatch` → `startPreparedTask`뿐이다.
   */
  startTask(_taskId: string): OrchestrationTask {
    throw new OrchestrationError(
      "preflight_required",
      "ready→running 직접 전이는 없다: planRunnableBatch → commitPreflightBatch → startPreparedTask를 쓴다",
    );
  }

  /** **폐기됨** — batch를 running으로 올리는 경로는 없다(같은 이유로 `preflight_required`다). */
  startScheduledBatch(_limit?: number): OrchestrationTask[] {
    throw new OrchestrationError(
      "preflight_required",
      "batch를 바로 running으로 올리지 않는다: commitPreflightBatch로 prepared까지만 간다",
    );
  }

  /**
   * workspace 안 실제 파일을 artifact로 등록한다. 조용히 덮어쓰지 않고 revision을 올리며
   * 직전 revision을 `supersedes`로 남긴다. symlink/missing/비일반 파일/workspace 탈출은 fail-closed.
   */
  registerArtifact(input: RegisterArtifactInput): ArtifactPointer {
    let pointer: ArtifactPointer | null = null;
    this.#mutate((draft, now) => {
      const mutation: Mutation = { events: [], bodies: [] };
      // 호출자 소유 입력은 각 property를 **한 번만** 읽어 입양한다(A4 — 두 등록 경로가 같은 규칙이다).
      const read = readClosedOnce(input, REGISTER_KEYS, "artifact 등록 입력");
      const out = adoptedOutput(read.path, read.role);
      const task = requireRunningTask(draft, read.taskId, "artifact 등록");
      pointer = addArtifact(draft, now, mutation, this.paths, task, out, new Set());
      return mutation;
    });
    return clone(pointer!);
  }

  /**
   * **한 커밋 = 산출물 전체 등록 + result 수락 + task 완료**(V3 M5b 3차 독립 리뷰 A3).
   *
   * 이전 판의 controller는 `registerArtifact`를 산출물마다 **따로 durable commit**한 뒤 별도로
   * `submitResult`를 불렀다 → 두 번째 이후 산출물이 없거나 무효거나, 경로가 겹치거나, envelope/body
   * 검증이 실패하면 **앞선 artifact record·event·revision만 durable에 남고** task는 running/failed로
   * 남았다. 재시도는 같은 경로의 revision을 계속 올려 찌꺼기를 쌓았다.
   *
   * 지금은 **검증 → 커밋 순서의 단일 트랜잭션**이다: envelope·summary·body·task 전이 가능 여부를 먼저
   * 닫아서 보고, 산출물 전체를 (소유권 · writableRoots · 파일/hash/symlink · role · 개수 상한 ·
   * 경로 중복) 검증하며 등록하고, 그 포인터로 envelope를 채워 `acceptMessage`가 다시 대조한 뒤,
   * artifact record + event + result 메시지 + `completed` 전이를 **`#mutate` 하나**로 반영한다.
   * 검증 단계에서 실패하면 draft가 버려지므로 artifacts·events·messages·revision·task 상태가
   * **진입 전과 완전히 같다**(부분 적용 없음).
   *
   * **물리 발행의 보장 범위는 여기까지다(4차 독립 리뷰 A3, 정확히 적는다)**: 검증 통과 뒤의 디스크
   * 발행은 `orchestrationStore.commitRun`의 journal 프로토콜이 담당하며, 발행 도중 I/O가 실패하면
   * 관찰 결과는 **① 가시적 전이 0**(state 바이트 발행 전 실패는 전부 roll back이다 — 6차 리뷰 A3에서
   * roll forward를 폐기했다) 또는 **② 목표 state 바이트가 이미 durable해진 뒤라 다음 열기가 body 발행·
   * 정리만 마무리한 완료 상태** 중 하나다(둘 다 일관되고 재시도·전진이 가능하다).
   * "언제나 전이 0"이라고 주장하지 않으며, ②에서 **호출자가 본 실패와 durable 진실이 갈릴 수 있다**는
   * 사실도 그대로 남는다(대장 `C-37` **open** — 7차 리뷰 확인, M5c outcome marker 처리 전).
   *
   * 호출자 소유 `outputs`는 **각 항목을 정확히 한 번 읽어 입양**한다(4차 독립 리뷰 A4) — 교대 getter가
   * "검증한 role"과 "저장하는 role"을 가르지 못한다.
   */
  completeTaskWithArtifacts(input: CompleteTaskInput): CompletedTask {
    let done: CompletedTask | null = null;
    this.#mutate((draft, now) => {
      const envelope = validateEnvelope(input.envelope);
      if (envelope.type !== "result") {
        throw new OrchestrationError("message_type_mismatch", "completeTaskWithArtifacts에는 result만 제출할 수 있다");
      }
      if (envelope.artifactRefs.length !== 0) {
        throw new OrchestrationError(
          "artifact_ref_unexpected",
          "이 트랜잭션이 포인터를 등록하며 채운다 — envelope.artifactRefs는 비어 있어야 한다",
        );
      }
      const summary = assertText(input.summary, "result summary", LIMITS.maxSummaryLength);
      // **완료는 확인된 정리 뒤에만 가능하다**(V3 M5c · 대장 `B-13`): 생존자 0을 모르는 채로 자원을 놓고
      // 결과를 발행하는 경로가 없다. artifact 등록·result 수락·완료 전이는 여전히 **한 커밋**이다.
      const task = requireCleanedTask(draft, envelope.taskId, "result");

      const mutation: Mutation = { events: [], bodies: [] };
      const pointers = addArtifacts(draft, now, mutation, this.paths, task, input.outputs);
      // 채워 넣은 포인터는 `acceptMessage`가 registry·디스크에 대고 **다시** 검증한다(같은 커밋 안).
      acceptMessage(draft, now, mutation, this.paths, { ...envelope, artifactRefs: pointers }, input.body, summary);
      task.artifactRefs = pointers.map(clone);
      task.resultSummary = summary;
      // 완료 커밋은 attempt 자원을 **같은 커밋에서** 놓는다: lease와 미확정 결과가 남아 있으면
      // 재시작한 controller가 "정리해야 할 프로세스가 있다"고 읽는다.
      task.execution = { ...task.execution, processLeaseMarker: null, pendingResult: null };
      setState(draft, now, mutation, task, "completed", "result_accepted");
      recompute(draft, now, mutation);
      done = { task, artifacts: pointers };
      return mutation;
    });
    return { task: clone(done!.task), artifacts: done!.artifacts.map(clone) };
  }

  /**
   * `result` 수락 → task completed. 중앙으로 옮기는 것은 bounded summary와 **재검증된 포인터**뿐이다.
   * 수락 직전 모든 artifact를 등록 revision/hash와 현재 디스크 상태로 다시 확인한다(tamper fail-closed).
   */
  submitResult(input: SubmitInput): OrchestrationTask {
    let done: OrchestrationTask | null = null;
    this.#mutate((draft, now) => {
      const envelope = validateEnvelope(input.envelope);
      if (envelope.type !== "result") {
        throw new OrchestrationError("message_type_mismatch", "submitResult에는 result만 제출할 수 있다");
      }
      const summary = assertText(input.summary, "result summary", LIMITS.maxSummaryLength);
      const task = requireCleanedTask(draft, envelope.taskId, "result");
      const mutation: Mutation = { events: [], bodies: [] };
      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary);
      task.artifactRefs = envelope.artifactRefs.map(clone);
      task.resultSummary = summary;
      task.execution = { ...task.execution, processLeaseMarker: null, pendingResult: null };
      setState(draft, now, mutation, task, "completed", "result_accepted");
      recompute(draft, now, mutation);
      done = task;
      return mutation;
    });
    return clone(done!);
  }

  /** `blocker` 수락 → task blocked. 영향받는 parent(조상)와 dependent도 kernel이 blocked로 갱신한다. */
  submitBlocker(input: SubmitInput): OrchestrationTask {
    let blocked: OrchestrationTask | null = null;
    this.#mutate((draft, now) => {
      const envelope = validateEnvelope(input.envelope);
      if (envelope.type !== "blocker") {
        throw new OrchestrationError("message_type_mismatch", "submitBlocker에는 blocker만 제출할 수 있다");
      }
      const summary = assertText(input.summary, "blocker summary", LIMITS.maxSummaryLength);
      // `blocked`도 자원을 놓는 종료 상태다 → 완료와 **같은 규칙**을 받는다(확인된 정리 뒤에만).
      const task = requireCleanedTask(draft, envelope.taskId, "blocker");
      const mutation: Mutation = { events: [], bodies: [] };
      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary);
      task.blockerSummary = summary;
      task.execution = { ...task.execution, processLeaseMarker: null, pendingResult: null };
      setState(draft, now, mutation, task, "blocked", "blocker_accepted");
      recompute(draft, now, mutation);
      blocked = task;
      return mutation;
    });
    return clone(blocked!);
  }

  // ── M4c: 나머지 6개 메시지 타입과 중앙 경유 라우팅 ─────────────────────────

  /**
   * agent → 중앙 진행 보고. `deliverTo`를 주면 **중앙이** 관계를 검증한 뒤 그 sibling의 inbox로
   * route를 남긴다(직접 mailbox 쓰기 아님). 관계는 **같은 parent**이거나 **둘 사이의 의존**뿐이고,
   * 자기 자신·미상·모호(같은 roleId 다수)·종료된 수신자는 거부한다. task 상태는 바꾸지 않는다.
   */
  submitStatusUpdate(input: StatusUpdateInput): MessageIndexEntry {
    return this.#acceptRouted("status_update", input, (draft, sender) => {
      assertActive(sender, "status_update");
      if (input.deliverTo === undefined) return null;
      const recipient = resolveRecipientTask(draft, input.deliverTo, sender);
      if (!isRelated(sender, recipient)) {
        throw new OrchestrationError(
          "route_not_related",
          `${sender.taskId} → ${recipient.taskId}는 같은 parent도 의존 관계도 아니다 — 중앙은 임의 전달을 하지 않는다`,
        );
      }
      return recipient.taskId;
    });
  }

  /**
   * 중앙 → **fresh reviewer** task. reviewer는 검토 대상(`subjectTaskId`)에 의존해야 하고,
   * 아직 아무 결과도 내지 않은 상태여야 한다(저자와 분리된 새 세션 — §3.3).
   * 검토 대상은 이미 `completed`(result가 수락된 산출물)여야 한다.
   */
  requestReview(input: SubjectInput): MessageIndexEntry {
    return this.#acceptRouted("review_request", input, (draft, reviewer) => {
      const subject = requireSubject(draft, input.subjectTaskId, reviewer);
      if (subject.state !== "completed") {
        throw new OrchestrationError("subject_not_completed", `검토 대상 ${subject.taskId}가 completed가 아니다 (${subject.state})`);
      }
      assertDependsOnSubject(reviewer, subject, "reviewer");
      assertFresh(reviewer, "reviewer");
      return reviewer.taskId;
    });
  }

  /** reviewer → 중앙. 받은 `review_request`가 있어야 하고, 중앙에서 끝난다(전달 대상 없음). */
  submitReviewResult(input: SubmitInput): MessageIndexEntry {
    return this.#acceptRouted("review_result", input, (draft, reviewer) => {
      assertActive(reviewer, "review_result");
      if (!draft.messages.some((m) => m.type === "review_request" && m.taskId === reviewer.taskId)) {
        throw new OrchestrationError("review_request_missing", `${reviewer.taskId}는 review_request를 받은 적이 없다`);
      }
      return null;
    });
  }

  /**
   * 중앙 → **fresh revision worker**. 검토 대상에 대한 `review_result`가 이미 수락되어 있어야 한다 —
   * 리뷰 없이 수정 지시를 만들어 내는 경로를 막는다.
   */
  requestRevision(input: SubjectInput): MessageIndexEntry {
    return this.#acceptRouted("revision_request", input, (draft, worker) => {
      const subject = requireSubject(draft, input.subjectTaskId, worker);
      const reviewed = draft.messages.some((m) => {
        if (m.type !== "review_result") return false;
        const reviewer = draft.tasks.find((t) => t.taskId === m.taskId);
        return reviewer !== undefined && reviewer.dependsOn.includes(subject.taskId);
      });
      if (!reviewed) {
        throw new OrchestrationError("review_result_missing", `${subject.taskId}에 대한 review_result가 없다`);
      }
      assertDependsOnSubject(worker, subject, "revision worker");
      assertFresh(worker, "revision worker");
      return worker.taskId;
    });
  }

  /** agent → 중앙 결정 요청. 상태는 바꾸지 않는다(§5.2 body의 "Safe Default While Waiting" 계약). */
  submitDecisionRequest(input: SubmitInput): MessageIndexEntry {
    return this.#acceptRouted("decision_request", input, (_draft, task) => {
      assertActive(task, "decision_request");
      return null;
    });
  }

  /** 중앙 → 요청한 task로 결정 회신. 미응답 `decision_request`가 있을 때만 가능하다. */
  recordDecision(input: SubmitInput): MessageIndexEntry {
    return this.#acceptRouted("decision", input, (draft, task) => {
      const requested = draft.messages.filter((m) => m.type === "decision_request" && m.taskId === task.taskId).length;
      const answered = draft.messages.filter((m) => m.type === "decision" && m.taskId === task.taskId).length;
      if (answered >= requested) {
        throw new OrchestrationError("decision_request_missing", `${task.taskId}에 응답할 decision_request가 없다`);
      }
      return task.taskId;
    });
  }

  /**
   * 전달 수령. 좁은 중앙 전이 하나이며 durable event(`delivery_acknowledged`)를 남긴다.
   * task 상태는 바꾸지 않고, 남의 inbox 항목은 수령할 수 없다. 범용 queue/retry는 만들지 않는다.
   */
  acknowledgeDelivery(input: { taskId: string; messageId: string; actionId?: string }): MessageIndexEntry {
    const messageId = assertSlug(input.messageId, "messageId");
    this.#mutate((draft, now) => {
      const task = requireTask(draft, assertSlug(input.taskId, "taskId"));
      assertActive(task, "acknowledgeDelivery", true);
      const entry = draft.messages.find((m) => m.messageId === messageId);
      if (!entry) throw new OrchestrationError("unknown_message", `미상 messageId: ${messageId}`);
      if (entry.routeToTaskId !== task.taskId) {
        throw new OrchestrationError("delivery_not_addressed", `${messageId}는 ${task.taskId}에게 전달된 메시지가 아니다`);
      }
      if (entry.acknowledgedAt !== null) {
        throw new OrchestrationError("delivery_already_acknowledged", `이미 수령한 전달이다: ${messageId}`);
      }
      // **수령은 시도가 시작된 뒤에만 가능하다**(대장 `C-12→B`): 시도 기록 없이 ack하면 "실패한 전달을
      // 성공으로 적는" 경로가 다시 열린다. 시도는 `beginDeliveryAttempt`가 durable하게 남긴다.
      if (entry.delivery.attempts === 0 || entry.delivery.activeAttemptId === null) {
        throw new OrchestrationError("delivery_attempt_missing", `${messageId}는 진행 중인 전달 시도가 없다`);
      }
      entry.acknowledgedAt = now;
      entry.delivery.lastAttemptAt = now;
      entry.delivery.lastMarker = "delivered";
      entry.delivery.activeAttemptId = null;
      entry.delivery.nextAttemptAt = null;
      return {
        events: [
          event({
            at: now,
            type: "delivery_acknowledged",
            revision: draft.revision,
            taskId: task.taskId,
            messageId,
            actionId: input.actionId === undefined ? null : assertSlug(input.actionId, "actionId"),
            marker: "delivered",
          }),
        ],
        bodies: [],
      };
    });
    return clone(this.#state.messages.find((m) => m.messageId === messageId)!);
  }

  // ── M5c: durable 실행 lifecycle ────────────────────────────────────────────

  /**
   * **turn 하나의 토큰·경과를 durable 회계에 반영한다**(대장 `B-12`). safety-only reducer이므로 만료·run
   * deadline 뒤에도 지난다 — 이미 태운 자원을 적는 일을 막으면 만료가 곧 회계 누락이 된다.
   *
   * **같은 `turnId`는 정확히 한 번만 과금된다**: 재시도·크래시 복구가 같은 turn을 두 번 세지 않는다.
   * 회계는 **증가만** 한다(리셋·감소 경로가 없다).
   */
  chargeTurnUsage(input: {
    taskId: string;
    turnId: string;
    actionId: string;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  }): RunAccounting {
    const taskId = assertSlug(input.taskId, "taskId");
    const turnId = assertSlug(input.turnId, "turnId");
    const actionId = assertSlug(input.actionId, "actionId");
    const delta = boundedCount(input.inputTokens, "inputTokens") + boundedCount(input.outputTokens, "outputTokens");
    const elapsedMs = boundedCount(input.elapsedMs, "elapsedMs");
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        const acc = draft.accounting;
        if (acc.chargedTurnIds.includes(turnId)) {
          throw new OrchestrationError("turn_already_charged", `이미 과금한 turn이다: ${turnId}`);
        }
        if (acc.chargedTurnIds.length >= LIMITS.maxChargedTurnIds) {
          throw new OrchestrationError("charged_turns_exhausted", "과금 기록 상한을 넘었다(새 run이 필요하다)");
        }
        acc.tokensUsed = Math.min(LIMITS.maxAccountedTokens, acc.tokensUsed + delta);
        acc.elapsedMsUsed = Math.min(LIMITS.maxAccountedElapsedMs, Math.max(acc.elapsedMsUsed, elapsedMs));
        acc.chargedTurnIds = [...acc.chargedTurnIds, turnId].sort();
        task.execution = { ...task.execution, turnId };
        return {
          events: [
            event({
              at: now,
              type: "usage_charged",
              revision: draft.revision,
              taskId,
              actionId,
              turnId,
              attemptId: task.execution.attemptId,
              tokenDelta: delta,
              elapsedMs,
            }),
          ],
          bodies: [],
        };
      },
      { safetyOnly: true },
    );
    return clone(this.#state.accounting);
  }

  /**
   * **인정되는 진행 신호 1건.** no-progress deadline을 되돌리는 **유일한** 경로다(heartbeat·미상 이벤트는
   * 여기 오지 않는다). 진행이 한 번도 없으면 종료 결과가 와도 `silent_session`이 된다.
   */
  recordProgress(input: { taskId: string; actionId: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    this.#mutate((draft, now) => {
      const task = requireTask(draft, taskId);
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `진행 기록은 running task만 가능하다 (현재 ${task.state})`);
      }
      if (task.execution.progressCount >= LIMITS.maxProgressEvents) {
        throw new OrchestrationError("progress_limit_exceeded", `attempt당 진행 이벤트는 ${LIMITS.maxProgressEvents}건까지다`);
      }
      task.execution = { ...task.execution, lastProgressAt: now, progressCount: task.execution.progressCount + 1 };
      return {
        events: [
          event({
            at: now,
            type: "progress_recorded",
            revision: draft.revision,
            taskId,
            actionId,
            attemptId: task.execution.attemptId,
          }),
        ],
        bodies: [],
      };
    });
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **running → cleaning.** 종료·오류·취소·deadline·재시작이 관측된 그 자리에서 부른다. 결과는 아직
   * 확정되지 않으며 자원은 계속 격리 상태다(대장 `B-13`). safety-only이므로 만료 뒤에도 지난다.
   *
   * 성공한 turn이면 `pendingResult`를 함께 봉인한다 — cleanup이 확인된 뒤에만 durable 완료로 승격된다.
   */
  recordTerminal(input: {
    taskId: string;
    actionId: string;
    marker: AutopilotMarker;
    pendingResult?: PendingTaskResult | null;
  }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    const marker = enumOf(input.marker, AUTOPILOT_MARKERS, "marker");
    const pending = input.pendingResult == null ? null : adoptPendingResult(input.pendingResult);
    if (marker === "turn_completed" && pending === null) {
      throw new OrchestrationError("invalid_terminal", "turn_completed는 봉인할 결과가 있어야 한다");
    }
    if (marker !== "turn_completed" && pending !== null) {
      throw new OrchestrationError("invalid_terminal", "실패 marker는 결과를 봉인하지 않는다");
    }
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        if (task.state !== "running") {
          throw new OrchestrationError("invalid_transition", `종료 기록은 running task만 가능하다 (현재 ${task.state})`);
        }
        if (task.execution.terminalMarker !== null) {
          throw new OrchestrationError("terminal_already_recorded", `이 attempt는 이미 종료가 기록됐다: ${taskId}`);
        }
        const mutation: Mutation = { events: [], bodies: [] };
        task.execution = { ...task.execution, terminalMarker: marker, pendingResult: pending, cleanupStatus: "required" };
        setState(draft, now, mutation, task, "cleaning", "cleanup_required", {
          actionId,
          attemptId: task.execution.attemptId,
          marker,
        });
        mutation.events.push(
          event({
            at: now,
            type: "cleanup_started",
            revision: draft.revision,
            taskId,
            actionId,
            attemptId: task.execution.attemptId,
            marker,
          }),
        );
        return mutation;
      },
      { safetyOnly: true },
    );
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **취소 요청 기록.** safety-only다 — 취소는 전진이 아니므로 만료 뒤에도 가능해야 한다.
   * `running`이면 같은 커밋에서 `cleaning`으로 내려간다(자원은 계속 붙잡는다).
   */
  requestCancel(input: { taskId: string; actionId: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        if (isTerminal(task.state)) {
          throw new OrchestrationError("invalid_transition", `종료된 task는 취소할 수 없다 (현재 ${task.state})`);
        }
        const mutation: Mutation = { events: [], bodies: [] };
        task.execution = { ...task.execution, cancelRequestedAt: task.execution.cancelRequestedAt ?? now };
        mutation.events.push(
          event({ at: now, type: "cancel_requested", revision: draft.revision, taskId, actionId, marker: "cancelled" }),
        );
        if (task.state === "running") {
          task.execution = { ...task.execution, terminalMarker: task.execution.terminalMarker ?? "cancelled", cleanupStatus: "required" };
          setState(draft, now, mutation, task, "cleaning", "cancel_requested", { actionId, marker: "cancelled" });
          mutation.events.push(
            event({ at: now, type: "cleanup_started", revision: draft.revision, taskId, actionId, marker: "cancelled" }),
          );
        }
        return mutation;
      },
      { safetyOnly: true },
    );
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **zero-survivor 확인.** `cleaning` task가 다음 상태로 나갈 **유일한** 자격이다. 영수증은 controller가
   * 프로세스 감독자에게서 받은 것이며 kernel은 그 형태(`survivors === 0`)만 다시 확인한다.
   * 확인 뒤에도 상태는 `cleaning`에 남는다 — 다음 상태는 호출자가 결과에 맞춰 별도 reducer로 정한다.
   */
  confirmCleanup(input: { taskId: string; actionId: string; leaseMarker: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    const leaseMarker = assertLease(input.leaseMarker);
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        if (task.state !== "cleaning") {
          throw new OrchestrationError("invalid_transition", `cleanup 확인은 cleaning task만 가능하다 (현재 ${task.state})`);
        }
        if (task.execution.processLeaseMarker !== leaseMarker) {
          throw new OrchestrationError("cleanup_lease_mismatch", "정리 영수증이 이 attempt의 lease와 다르다");
        }
        task.execution = { ...task.execution, cleanupStatus: "confirmed" };
        return {
          events: [
            event({
              at: now,
              type: "cleanup_confirmed",
              revision: draft.revision,
              taskId,
              actionId,
              attemptId: task.execution.attemptId,
              marker: "cleanup_confirmed",
            }),
          ],
          bodies: [],
        };
      },
      { safetyOnly: true },
    );
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **정리 실패(또는 관측 불확실).** task는 `cleaning`에 남고 자원도 계속 붙잡는다 — 이것이 계약이다
   * (대장 `B-13`/`C-18`). 시도 상한을 넘으면 `cleanupStatus: "failed"`로 **안정 격리** 상태가 된다.
   */
  failCleanup(input: { taskId: string; actionId: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        if (task.state !== "cleaning") {
          throw new OrchestrationError("invalid_transition", `cleanup 실패 기록은 cleaning task만 가능하다 (현재 ${task.state})`);
        }
        const attempts = Math.min(LIMITS.maxCleanupAttempts, task.execution.cleanupAttempts + 1);
        task.execution = {
          ...task.execution,
          cleanupAttempts: attempts,
          cleanupStatus: attempts >= LIMITS.maxCleanupAttempts ? "failed" : "required",
        };
        return {
          events: [
            event({
              at: now,
              type: "cleanup_failed",
              revision: draft.revision,
              taskId,
              actionId,
              attemptId: task.execution.attemptId,
              marker: "cleanup_unconfirmed",
            }),
          ],
          bodies: [],
        };
      },
      { safetyOnly: true },
    );
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **cleaning → paused.** 실패·중단·비대화 승인 부재·시계 이상의 fail-closed 착지점이다. safety-only다.
   * cleanup이 확인되지 않았으면 거부한다 — 자원을 놓기 전에 프로세스가 0임을 알아야 한다.
   */
  pauseTask(input: { taskId: string; actionId: string; pauseReason: PauseReason }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    const reason = enumOf(input.pauseReason, PAUSE_REASONS, "pauseReason");
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        if (isTerminal(task.state)) {
          throw new OrchestrationError("invalid_transition", `종료된 task는 pause할 수 없다 (현재 ${task.state})`);
        }
        if (holdsResources(task.state) && task.execution.cleanupStatus === "required") {
          throw new OrchestrationError("cleanup_unconfirmed", `cleanup이 확인되지 않아 pause할 수 없다: ${taskId}`);
        }
        const mutation: Mutation = { events: [], bodies: [] };
        task.execution = { ...task.execution, pauseReason: reason, processLeaseMarker: null, pendingResult: null };
        setState(draft, now, mutation, task, "paused", "paused", { actionId, marker: reason });
        mutation.events.push(
          event({ at: now, type: "task_paused", revision: draft.revision, taskId, actionId, marker: reason }),
        );
        return mutation;
      },
      { safetyOnly: true },
    );
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **paused → ready**(같은 유효 승인 아래에서만). 전진 작업이므로 만료·run deadline 뒤에는 거부된다.
   * 범위를 넓히는 재개는 없다 — 그것은 새 run이다.
   */
  resumeTask(input: { taskId: string; actionId: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    this.#mutate((draft, now) => {
      const task = requireTask(draft, taskId);
      if (task.state !== "paused") {
        throw new OrchestrationError("invalid_transition", `resumeTask는 paused task만 가능하다 (현재 ${task.state})`);
      }
      if (task.execution.attemptNo >= draft.manifest.autopilotPolicy.maxTaskAttempts) {
        throw new OrchestrationError("attempt_limit_exceeded", `task ${taskId}의 attempt 상한을 넘었다 — 새 run이 필요하다`);
      }
      const mutation: Mutation = { events: [], bodies: [] };
      task.execution = { ...emptyTaskExecution(), attemptNo: task.execution.attemptNo };
      setState(draft, now, mutation, task, "ready", "resumed", { actionId });
      mutation.events.push(event({ at: now, type: "task_resumed", revision: draft.revision, taskId, actionId }));
      recompute(draft, now, mutation);
      return mutation;
    });
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **cleaning → retry_wait / blocked / cancelled.** 확인된 정리 뒤의 착지점을 정한다.
   * ⓐ 취소가 요청됐으면 `cancelled` ⓑ attempt 여유가 있으면 `retry_wait` ⓒ 없으면 `blocked`다.
   * safety-only다(작업을 시작하지 않고 결과를 발행하지 않는다).
   */
  settleCleanedAttempt(input: { taskId: string; actionId: string }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    this.#mutate(
      (draft, now) => {
        const task = requireTask(draft, taskId);
        if (task.state !== "cleaning") {
          throw new OrchestrationError("invalid_transition", `settle은 cleaning task만 가능하다 (현재 ${task.state})`);
        }
        if (task.execution.cleanupStatus !== "confirmed") {
          throw new OrchestrationError("cleanup_unconfirmed", `cleanup이 확인되지 않았다: ${taskId}`);
        }
        const mutation: Mutation = { events: [], bodies: [] };
        const policy = draft.manifest.autopilotPolicy;
        task.execution = { ...task.execution, processLeaseMarker: null, pendingResult: null };
        if (task.execution.cancelRequestedAt !== null) {
          setState(draft, now, mutation, task, "cancelled", "cancelled", { actionId, marker: "cancelled" });
        } else if (task.execution.attemptNo < policy.maxTaskAttempts) {
          task.execution = {
            ...task.execution,
            retryAt: addMs(now, policy.retryBackoffMs),
            retryDeadlineAt: draft.accounting.budgetDeadlineAt,
          };
          setState(draft, now, mutation, task, "retry_wait", "retry_scheduled", { actionId });
          mutation.events.push(event({ at: now, type: "retry_scheduled", revision: draft.revision, taskId, actionId }));
        } else {
          task.blockerSummary = `[autopilot] ${task.execution.terminalMarker ?? "attempts_exhausted"}`;
          setState(draft, now, mutation, task, "blocked", "attempts_exhausted", { actionId });
        }
        recompute(draft, now, mutation);
        return mutation;
      },
      { safetyOnly: true },
    );
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **봉인된 typed operation dispatch permit을 발급한다**(V3 M5c 3A 리비전 A2 · 대장 `B-10` 집행면).
   *
   * 계획을 **kernel이** 검증한다: binding(run/task/attempt/turn)은 호출자가 주는 값이 아니라 **현재
   * durable state에서 나온다**. 그래서 통과한 permit은 "이 run의 이 running task의 이 attempt가 이 turn에
   * 요청한, 완전히 검증된 계획"이라는 뜻이고, 그 밖의 어떤 조합도 permit이 되지 못한다.
   *
   * **state를 바꾸지 않는다**(커밋 0 · 이벤트 0 · revision 그대로) — 발급은 순수 판정이다. 실제 집행은
   * `typedExecution.ts`가 하며 효과 직전에 `readDispatchAuthority()`로 **현재** 상태를 다시 본다.
   *
   * lifecycle은 그대로다: `prepared`가 아니면 `startPreparedTask()`를 지나야 하고, ready→running 직접
   * 경로는 여전히 없다(`startTask()`는 `preflight_required`).
   */
  issueOperationDispatchPermit(input: { taskId: string; turnId: string; plan: unknown }): OperationDispatchPermit {
    const taskId = assertSlug(input?.taskId, "taskId");
    const turnId = assertSlug(input?.turnId, "turnId");
    const state = this.#state;
    const now = formatTimestamp(this.#clock());
    // 전진 작업 게이트와 **정확히 같은** 판정을 쓴다(만료·예산 deadline 경계 포함 · 시계 역행).
    assertForwardWorkAllowed(state, now);
    const task = requireTask(state, taskId);
    if (task.state !== "running") {
      throw new OrchestrationError(
        "dispatch_task_not_running",
        `typed operation permit은 running task만 받을 수 있다 (현재 ${task.state})`,
      );
    }
    const attemptId = task.execution.attemptId;
    if (attemptId === null || task.execution.preflightDigest === null) {
      throw new OrchestrationError("dispatch_identity_stale", `task ${taskId}에 durable attempt 신원이 없다`);
    }
    if (task.execution.turnId !== null && task.execution.turnId !== turnId) {
      throw new OrchestrationError("dispatch_identity_stale", `task ${taskId}의 durable turn 신원과 다르다`);
    }
    if (task.execution.preflightDigest !== preflightDigest(state, task)) {
      throw new OrchestrationError("preflight_drift", `task ${taskId}의 봉인된 preflight가 준비 이후에 바뀌었다`);
    }
    // binding은 **durable state에서 나온다** — 호출자가 신원을 고르는 통로가 없다.
    const plan = validateTypedExecutionPlan(input?.plan, { runId: state.runId, taskId, attemptId, turnId });
    const permit: OperationDispatchPermit = Object.freeze({ runId: state.runId, taskId, attemptId, turnId, plan });
    GENUINE_PERMITS.set(permit, {
      readState: () => this.getState(),
      now: () => formatTimestamp(this.#clock()),
      workspaceRoot: this.#paths.workspaceRoot,
      plan,
      preflightDigest: task.execution.preflightDigest,
      attemptNo: task.execution.attemptNo,
    });
    return permit;
  }

  /** **집행한 typed operation 1건의 영수증**을 durable에 남긴다(내용은 담지 않는다). */
  recordOperationReceipt(input: { taskId: string; actionId: string; receipt: OperationReceipt }): OrchestrationTask {
    const taskId = assertSlug(input.taskId, "taskId");
    const actionId = assertSlug(input.actionId, "actionId");
    const receipt = adoptReceipt(input.receipt);
    this.#mutate((draft, now) => {
      const task = requireTask(draft, taskId);
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `영수증은 running task만 남길 수 있다 (현재 ${task.state})`);
      }
      if (task.execution.operationReceipts.some((r) => r.operationId === receipt.operationId)) {
        throw new OrchestrationError("operation_already_recorded", `이미 기록된 operation이다: ${receipt.operationId}`);
      }
      if (task.execution.operationReceipts.length >= LIMITS.maxOperationReceipts) {
        throw new OrchestrationError("operation_limit_exceeded", `attempt당 영수증은 ${LIMITS.maxOperationReceipts}건까지다`);
      }
      task.execution = { ...task.execution, operationReceipts: [...task.execution.operationReceipts, { ...receipt, at: now }] };
      return {
        events: [
          event({
            at: now,
            type: "operation_receipt",
            revision: draft.revision,
            taskId,
            actionId,
            attemptId: task.execution.attemptId,
            operationId: receipt.operationId,
            marker: receipt.marker,
          }),
        ],
        bodies: [],
      };
    });
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * **전달 시도 시작 기록**(대장 `C-12→B`). `acknowledgedAt`은 건드리지 않는다 — 수령은 그 turn이
   * 완전하고 검증된 성공을 낸 뒤 `acknowledgeDelivery()`가 한다(조기 ack 경로가 없다).
   */
  beginDeliveryAttempt(input: { taskId: string; messageId: string; actionId: string; attemptId: string }): MessageIndexEntry {
    const taskId = assertSlug(input.taskId, "taskId");
    const messageId = assertSlug(input.messageId, "messageId");
    const actionId = assertSlug(input.actionId, "actionId");
    const attemptId = assertSlug(input.attemptId, "attemptId");
    this.#mutate((draft, now) => {
      const task = requireTask(draft, taskId);
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `전달 시도는 running task만 가능하다 (현재 ${task.state})`);
      }
      const entry = requireRoutedTo(draft, messageId, taskId);
      const policy = draft.manifest.autopilotPolicy;
      const d = entry.delivery;
      if (d.attempts >= policy.maxDeliveryAttempts) {
        throw new OrchestrationError("delivery_attempts_exhausted", `${messageId}의 전달 시도 상한을 넘었다`);
      }
      const deadlineAt = d.deadlineAt ?? addMs(now, policy.deliveryDeadlineMs);
      if (now >= deadlineAt) {
        throw new OrchestrationError("delivery_deadline_exceeded", `${messageId}의 전달 deadline을 넘었다`);
      }
      entry.delivery = {
        attempts: d.attempts + 1,
        activeAttemptId: attemptId,
        firstAttemptAt: d.firstAttemptAt ?? now,
        lastAttemptAt: now,
        nextAttemptAt: null,
        deadlineAt,
        lastMarker: d.lastMarker,
      };
      return {
        events: [
          event({
            at: now,
            type: "delivery_attempted",
            revision: draft.revision,
            taskId,
            messageId,
            actionId,
            attemptId,
          }),
        ],
        bodies: [],
      };
    });
    return clone(this.#state.messages.find((m) => m.messageId === messageId)!);
  }

  /**
   * **전달 실패를 원자적으로 기록한다 — 수령하지 않는다.** 재시도 여유가 있으면 `nextAttemptAt`을 남기고,
   * 없으면 marker가 `attempts_exhausted`가 되어 호출자가 task를 pause한다. safety-only가 **아니다**:
   * 실패 기록은 다음 시도를 예약하는 전진 작업이다.
   */
  failDeliveryAttempt(input: { taskId: string; messageId: string; actionId: string; marker: DeliveryMarker }): MessageIndexEntry {
    const taskId = assertSlug(input.taskId, "taskId");
    const messageId = assertSlug(input.messageId, "messageId");
    const actionId = assertSlug(input.actionId, "actionId");
    const wanted = enumOf(input.marker, DELIVERY_MARKERS, "marker");
    if (wanted === "delivered") {
      throw new OrchestrationError("invalid_delivery_marker", "실패 기록에 delivered를 쓸 수 없다");
    }
    this.#mutate((draft, now) => {
      const entry = requireRoutedTo(draft, messageId, taskId);
      if (entry.acknowledgedAt !== null) {
        throw new OrchestrationError("delivery_already_acknowledged", `이미 수령한 전달이다: ${messageId}`);
      }
      const policy = draft.manifest.autopilotPolicy;
      const d = entry.delivery;
      const exhausted = d.attempts >= policy.maxDeliveryAttempts;
      const deadlinePassed = d.deadlineAt !== null && now >= d.deadlineAt;
      const marker: DeliveryMarker = exhausted ? "attempts_exhausted" : deadlinePassed ? "deadline_exceeded" : wanted;
      entry.delivery = {
        ...d,
        activeAttemptId: null,
        lastAttemptAt: now,
        nextAttemptAt: marker === "attempts_exhausted" || marker === "deadline_exceeded" ? null : addMs(now, policy.retryBackoffMs),
        lastMarker: marker,
      };
      return {
        events: [
          event({ at: now, type: "delivery_failed", revision: draft.revision, taskId, messageId, actionId, marker }),
        ],
        bodies: [],
      };
    });
    return clone(this.#state.messages.find((m) => m.messageId === messageId)!);
  }

  /**
   * **action 정합화**(대장 `C-37`). 커밋 호출이 애매하게 실패했을 때(디스크 I/O) 재시작한 controller가
   * "내 요청이 durable해졌는가"를 event log에서 정확히 판정한다 — 같은 부작용을 두 번 만들지 않는 근거다.
   * 읽기 전용이다.
   */
  hasCommittedAction(actionId: string): boolean {
    const id = assertSlug(actionId, "actionId");
    return loadRun(this.paths).events.some((e) => e.actionId === id);
  }

  /** durable 회계(깊은 사본). 재시작 뒤에도 이 값이 예산의 진실이다. */
  getAccounting(): RunAccounting {
    return clone(this.#state.accounting);
  }

  /** 남은 토큰(무제한이면 `null`)과 남은 경과 시간 — 전부 durable state에서 계산한다. */
  remainingBudget(nowIso?: string): { tokens: number | null; elapsedMs: number } {
    const now = nowIso === undefined ? formatTimestamp(this.#clock()) : assertTimestamp(nowIso, "now");
    const acc = this.#state.accounting;
    const maxTokens = this.#state.manifest.maxTokens;
    return {
      tokens: maxTokens === null ? null : Math.max(0, maxTokens - acc.tokensUsed),
      elapsedMs: Math.max(0, Date.parse(acc.budgetDeadlineAt) - Date.parse(now)),
    };
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  /**
   * M4c 메시지 6종의 공통 골격: envelope 검증 → 타입 대조 → summary 검증 → 발신/수신 task 확인 →
   * **타입별 규칙**(`check`)이 route 대상을 정한다 → 수락. 검증이 하나라도 실패하면 전이 0이다.
   * `check`는 draft를 읽기만 하고 route할 taskId(또는 null)를 돌려준다.
   */
  #acceptRouted(
    type: AgentMessageType,
    input: SubmitInput,
    check: (draft: OrchestrationRunState, task: OrchestrationTask) => string | null,
  ): MessageIndexEntry {
    let messageId = "";
    this.#mutate((draft, now) => {
      const envelope = validateEnvelope(input.envelope);
      if (envelope.type !== type) {
        throw new OrchestrationError("message_type_mismatch", `이 진입점에는 ${type}만 제출할 수 있다`);
      }
      const summary = assertText(input.summary, `${type} summary`, LIMITS.maxSummaryLength);
      const task = requireTask(draft, envelope.taskId);
      const routeToTaskId = check(draft, task);
      const mutation: Mutation = { events: [], bodies: [] };
      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary, routeToTaskId);
      messageId = envelope.messageId;
      return mutation;
    });
    return clone(this.#state.messages.find((m) => m.messageId === messageId)!);
  }

  #createTask(seed: DependentTaskSeed, parentTaskId: string | null): OrchestrationTask {
    let created: OrchestrationTask | null = null;
    this.#mutate((draft, now) => {
      const mutation: Mutation = { events: [], bodies: [] };
      created = addTask(draft, now, mutation, seed, parentTaskId, 0);
      recompute(draft, now, mutation);
      return mutation;
    });
    return clone(created!);
  }

  /**
   * 검증 → 커밋. fn이 던지면 `this.#state`도 디스크도 그대로다(전이 0).
   * fn은 draft(사본)만 만지고 이벤트/보디를 돌려준다.
   *
   * 커밋 기준(`base`)은 이 인스턴스가 들고 있던 **직전 state**의 revision/event tail이다. 같은 run을
   * 두 kernel이 같은 revision에서 열었으면 늦은 쪽 커밋은 `stale_writer`로 거부된다(lost update 없음).
   */
  #mutate(fn: (draft: OrchestrationRunState, now: string) => Mutation, opts?: { safetyOnly?: boolean }): void {
    const now = formatTimestamp(this.#clock());
    // **전진 작업은 만료·run deadline에서 닫힌다. safety-only reducer만 그 뒤에도 지난다**
    // (V3 M5c — DECISIONS 2026-07-30 · 로드맵 §8.1). `C-17`: 경계 **포함**(`>=`)이다.
    if (opts?.safetyOnly === true) {
      assertClockSane(this.#state, now);
    } else {
      assertForwardWorkAllowed(this.#state, now);
    }
    const base = {
      revision: this.#state.revision,
      lastEventId: this.#state.lastEventId,
      lastEventHash: this.#state.lastEventHash,
    };
    const draft = clone(this.#state);
    draft.revision += 1;
    draft.updatedAt = now;
    const mutation = fn(draft, now);

    draft.tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    draft.messages.sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
    draft.artifacts.sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
    // safety-only 커밋은 **닫힌 event·사유 집합만** 낼 수 있다: 작업 시작·수락·발행·완료가 섞이면 거부한다.
    if (opts?.safetyOnly === true) assertSafetyOnlyMutation(mutation);
    assertReferentialIntegrity(draft);

    this.#state = commitRun(this.paths, { state: draft, events: mutation.events, bodies: mutation.bodies, base });
  }
}

// ── M4b/M5c scheduler (순수 함수 — state만 본다) ────────────────────────────

/**
 * **자원 점유 상태**(`prepared`/`running`/`cleaning`) task가 잡고 있는 class 집합.
 * `waiting_children`은 중단 상태라 점유하지 않는다. 목록의 정본은 `RESOURCE_HOLDING_STATES`다.
 */
function heldResourceClasses(state: OrchestrationRunState): Set<string> {
  const held = new Set<string>();
  for (const t of state.tasks) {
    if (!holdsResources(t.state)) continue;
    for (const r of t.resourceClasses) held.add(r);
  }
  return held;
}

/**
 * 결정론적 선택: `state.tasks`는 taskId 오름차순 불변식이므로 같은 state면 항상 같은 목록이 나온다.
 * 이미 점유된 class와 **이 batch에서 앞서 고른** class를 모두 피하므로 batch 내부도 충돌이 없다.
 *
 * 고르는 대상은 ⓐ `ready` 전부와 ⓑ **`retryAt`이 된** `retry_wait`이다 — 재시도도 이 scheduler 하나가
 * 고르므로 두 번째 scheduler가 생기지 않는다(대장 `C-12→B`). 남은 세션 여유
 * (`maxSessions` − 현재 점유 수)도 상한이라 batch가 승인 범위를 넘지 않는다.
 */
function selectSchedulable(state: OrchestrationRunState, limit: number, now: string): OrchestrationTask[] {
  const held = heldResourceClasses(state);
  const holders = state.tasks.filter((t) => holdsResources(t.state)).length;
  const budget = Math.min(limit, Math.max(0, state.manifest.maxSessions - holders));
  const picked: OrchestrationTask[] = [];
  for (const t of state.tasks) {
    if (picked.length >= budget) break;
    if (!isSchedulableNow(t, now)) continue;
    if (t.resourceClasses.some((r) => held.has(r))) continue;
    for (const r of t.resourceClasses) held.add(r);
    picked.push(t);
  }
  return picked;
}

function isSchedulableNow(t: OrchestrationTask, now: string): boolean {
  if (t.state === "ready") return true;
  // 예약 시각이 되지 않은 재시도는 고르지 않는다. deadline을 이미 넘긴 재시도도 고르지 않는다
  // (그 task는 pause 대상이며 조용히 다시 시작하지 않는다).
  if (t.state !== "retry_wait") return false;
  const at = t.execution.retryAt;
  const deadline = t.execution.retryDeadlineAt;
  return at !== null && now >= at && (deadline === null || now < deadline);
}

// ── M5c preflight 계약 ──────────────────────────────────────────────────────

/**
 * preflight 결정 1건. 닫힌 union이므로 "결정하지 않음"이라는 상태가 없다.
 *
 * `deferred`는 **계획(§2)의 네 결과에 더한 다섯 번째**이며 의도적이다: batch가 `maxSessions`·자원 여유로
 * 여러 task를 고르지만 controller가 이번 회차에 **일부만** 시작하기로 할 수 있다. 그때 남은 task를
 * `paused`/`retry_wait`로 만들면 **아무 일도 없었는데 상태가 오염**된다(사람의 재개가 필요해진다).
 * `deferred`는 그 task를 `ready`에 그대로 두고 attempt도 자원도 잡지 않는다 — 네 결과보다 **엄격히 적게**
 * 하므로 B-11의 원자성(모든 batch 항목이 결정을 받는다)은 그대로다.
 */
export type PreflightDecision =
  | { taskId: string; outcome: "prepared"; attemptId: string }
  | { taskId: string; outcome: "paused"; pauseReason: PauseReason }
  | { taskId: string; outcome: "retry_wait" }
  | { taskId: string; outcome: "blocked"; blockedReason: PauseReason }
  | { taskId: string; outcome: "deferred" };

export interface PreflightBatchInput {
  /** `planRunnableBatch()`가 준 revision. 다르면 `preflight_stale_batch`다. */
  baseRevision: number;
  /** 이 커밋의 멱등 신원(대장 `C-37`). */
  actionId: string;
  decisions: ReadonlyArray<PreflightDecision>;
}

export interface PreflightOutcome {
  taskId: string;
  from: TaskState;
  to: TaskState;
}

export interface PreflightBatchResult {
  revision: number;
  outcomes: PreflightOutcome[];
}

const DECISION_KEYS_BY_OUTCOME: Record<string, readonly string[]> = {
  prepared: ["taskId", "outcome", "attemptId"],
  paused: ["taskId", "outcome", "pauseReason"],
  retry_wait: ["taskId", "outcome"],
  blocked: ["taskId", "outcome", "blockedReason"],
  deferred: ["taskId", "outcome"],
};

/**
 * 호출자 소유 결정 목록을 **각 property를 정확히 한 번 읽어 입양**한다(M5b 4차 리뷰 A4와 같은 규칙).
 * 교대 getter가 "검증한 결정"과 "적용하는 결정"을 다르게 만들 창이 없다.
 */
function adoptDecisions(raw: unknown): PreflightDecision[] {
  if (!Array.isArray(raw)) throw new OrchestrationError("invalid_preflight", "decisions는 배열이어야 한다");
  const length = raw.length; // ← 길이를 읽는 유일한 지점
  if (length > LIMITS.maxScheduleBatch) {
    throw new OrchestrationError("invalid_preflight", `decisions는 ${LIMITS.maxScheduleBatch}건 이하여야 한다`);
  }
  const out: PreflightDecision[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== "object") {
      throw new OrchestrationError("invalid_preflight", `decisions[${i}]는 객체여야 한다`);
    }
    let outcome: unknown;
    let keys: string[];
    try {
      outcome = (item as Record<string, unknown>).outcome;
      keys = Reflect.ownKeys(item).filter((k): k is string => typeof k === "string");
      if (keys.length !== Reflect.ownKeys(item).length) {
        throw new OrchestrationError("invalid_preflight", `decisions[${i}]에 symbol key가 있다`);
      }
    } catch (e) {
      if (e instanceof OrchestrationError) throw e;
      throw new OrchestrationError("invalid_preflight", `decisions[${i}]를 읽을 수 없다(getter/proxy가 던졌다)`);
    }
    if (typeof outcome !== "string" || !(outcome in DECISION_KEYS_BY_OUTCOME)) {
      throw new OrchestrationError("invalid_preflight", `decisions[${i}].outcome이 닫힌 집합 밖이다`);
    }
    const allowed = DECISION_KEYS_BY_OUTCOME[outcome];
    for (const k of keys) {
      if (!allowed.includes(k)) throw new OrchestrationError("invalid_preflight", `decisions[${i}]에 허용되지 않은 필드: ${k}`);
    }
    for (const k of allowed) {
      if (!keys.includes(k)) throw new OrchestrationError("invalid_preflight", `decisions[${i}]에 필수 필드 없음: ${k}`);
    }
    const o = item as Record<string, unknown>;
    const taskId = assertSlug(o.taskId, `decisions[${i}].taskId`);
    if (seen.has(taskId)) throw new OrchestrationError("invalid_preflight", `decisions에 중복 taskId가 있다: ${taskId}`);
    seen.add(taskId);
    switch (outcome) {
      case "prepared":
        out.push({ taskId, outcome, attemptId: assertSlug(o.attemptId, `decisions[${i}].attemptId`) });
        break;
      case "paused":
        out.push({ taskId, outcome, pauseReason: enumOf(o.pauseReason, PAUSE_REASONS, `decisions[${i}].pauseReason`) });
        break;
      case "retry_wait":
      case "deferred":
        out.push({ taskId, outcome });
        break;
      default:
        out.push({ taskId, outcome: "blocked", blockedReason: enumOf(o.blockedReason, PAUSE_REASONS, `decisions[${i}].blockedReason`) });
    }
  }
  return out;
}

/**
 * **preflight 봉인 digest.** kernel이 계산하므로 호출자가 위조할 수 없고, `startPreparedTask()`가
 * 시작 직전에 **다시 계산해 대조**한다. 담는 것은 시작 자격을 결정하는 durable 사실 전부다:
 * 승인 canonical digest · 예산 deadline · 이 attempt 번호 · ownership · 배타 자원 · 승인된 operation 권위.
 */
function preflightDigest(state: OrchestrationRunState, task: OrchestrationTask): string {
  const authorities = Object.prototype.hasOwnProperty.call(state.manifest.operationAuthorityByTask, task.taskId)
    ? state.manifest.operationAuthorityByTask[task.taskId]
    : [];
  return sha256Hex(
    JSON.stringify({
      runId: state.runId,
      taskId: task.taskId,
      approvalDigest: state.accounting.approvalDigest,
      budgetDeadlineAt: state.accounting.budgetDeadlineAt,
      attemptNo: task.execution.attemptNo,
      attemptId: task.execution.attemptId,
      ownership: task.ownership,
      resourceClasses: task.resourceClasses,
      dependsOn: task.dependsOn,
      authorities,
    }),
  );
}

/** run 생성 시 한 번 정해지는 durable 예산. `min(start + maxElapsedMs, expiresAt)`이 deadline이다. */
function seedAccounting(manifest: MilestoneApprovalManifest, now: string): RunAccounting {
  const byElapsed = addMs(now, manifest.maxElapsedMs);
  const deadline = byElapsed < manifest.expiresAt ? byElapsed : manifest.expiresAt;
  if (deadline <= now) {
    throw new OrchestrationError("budget_window_empty", "승인된 예산 창이 비어 있다(만료가 이미 지났거나 maxElapsedMs가 0이다)");
  }
  return {
    approvalDigest: manifestDigest(manifest),
    budgetStartedAt: now,
    budgetDeadlineAt: deadline,
    tokensUsed: 0,
    elapsedMsUsed: 0,
    chargedTurnIds: [],
  };
}

/** 계약 타임스탬프에 ms를 더한다(고정 폭 UTC 문자열로 되돌린다). */
function addMs(now: string, ms: number): string {
  return formatTimestamp(new Date(Date.parse(now) + ms));
}

/** 여러 계약 타임스탬프 중 가장 이른 것(고정 폭 UTC라 문자열 비교로 충분하다). */
function earliest(times: string[]): string {
  return times.reduce((a, b) => (a < b ? a : b));
}

function boundedCount(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
    throw new OrchestrationError("invalid_usage", `${what}는 0 이상 정수여야 한다`);
  }
  return Math.min(v, LIMITS.maxAccountedTokens);
}

function enumOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new OrchestrationError("invalid_enum", `${what}는 ${allowed.join("|")} 중 하나여야 한다`);
  }
  return v as T;
}

function assertLease(v: unknown): string {
  if (typeof v !== "string" || !/^lease\.[0-9a-f]{32}$/.test(v)) {
    throw new OrchestrationError("invalid_lease_marker", "leaseMarker는 `lease.<32 hex>` 형태여야 한다");
  }
  return v;
}

const RECEIPT_KEYS = ["operationId", "kind", "authorityId", "path", "resultSha256", "exitCode", "marker"] as const;

/** 호출자 소유 영수증을 **한 번 읽어** 불변값으로 굳힌다(내용·argv·stdout은 애초에 필드가 없다). */
function adoptReceipt(raw: unknown): OperationReceipt {
  const read = readClosedOnce(raw, RECEIPT_KEYS, "operation 영수증");
  const kind = enumOf(read.kind, ["write_file", "run_process"] as const, "receipt.kind");
  return Object.freeze({
    operationId: assertSlug(read.operationId, "receipt.operationId"),
    kind,
    authorityId: assertSlug(read.authorityId, "receipt.authorityId"),
    path: read.path == null ? null : normalizeWorkspacePath(read.path, "receipt.path"),
    resultSha256: read.resultSha256 == null ? null : assertSha256Local(read.resultSha256),
    exitCode: read.exitCode == null ? null : boundedExit(read.exitCode),
    marker: enumOf(read.marker, OPERATION_RECEIPT_MARKERS, "receipt.marker"),
    at: "1970-01-01T00:00:00.000Z", // 커밋 시각으로 덮어쓴다(호출자 시각을 durable로 쓰지 않는다)
  });
}

function assertSha256Local(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) {
    throw new OrchestrationError("invalid_sha256", "receipt.resultSha256은 소문자 hex SHA-256이어야 한다");
  }
  return v;
}

function boundedExit(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < -255 || v > 255) {
    throw new OrchestrationError("invalid_receipt", "receipt.exitCode는 -255..255 정수여야 한다");
  }
  return v;
}

const PENDING_KEYS = ["summary", "outputs"] as const;

/** 봉인할 미확정 결과를 한 번 읽어 굳힌다(산출물은 아직 등록 전이므로 포인터가 아니다). */
function adoptPendingResult(raw: unknown): PendingTaskResult {
  const read = readClosedOnce(raw, PENDING_KEYS, "미확정 결과");
  const outputs = adoptOutputs(read.outputs as ReadonlyArray<TaskOutput> | undefined);
  return Object.freeze({
    summary: assertText(read.summary, "pendingResult.summary", LIMITS.maxSummaryLength),
    outputs: outputs.map((o) => ({ path: o.path, role: o.role })),
  });
}

/** 전달 대상이 이 task인 메시지 index 항목. */
function requireRoutedTo(state: OrchestrationRunState, messageId: string, taskId: string): MessageIndexEntry {
  const entry = state.messages.find((m) => m.messageId === messageId);
  if (!entry) throw new OrchestrationError("unknown_message", `미상 messageId: ${messageId}`);
  if (entry.routeToTaskId !== taskId) {
    throw new OrchestrationError("delivery_not_addressed", `${messageId}는 ${taskId}에게 전달된 메시지가 아니다`);
  }
  return entry;
}

function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "blocked" || state === "cancelled";
}

/**
 * **safety-only 커밋의 내용 검사**(DECISIONS 2026-07-30). 만료 뒤에 지나갈 수 있는 것은 회계·정리·
 * 취소·pause뿐이다: 작업 시작(`started`)·결과 수락(`result_accepted`)·메시지 수락·artifact 등록·
 * 전달 수령이 섞인 mutation은 여기서 거부된다(전이 0).
 */
function assertSafetyOnlyMutation(mutation: Mutation): void {
  if (mutation.bodies.length > 0) {
    throw new OrchestrationError("safety_only_violation", "safety-only 커밋은 메시지 본문을 발행할 수 없다");
  }
  for (const e of mutation.events) {
    if (!(SAFETY_ONLY_EVENT_TYPES as readonly string[]).includes(e.type)) {
      throw new OrchestrationError("safety_only_violation", `safety-only 커밋이 허용되지 않은 event를 낸다: ${e.type}`);
    }
    if (e.reason !== null && !(SAFETY_ONLY_REASONS as readonly string[]).includes(e.reason)) {
      throw new OrchestrationError("safety_only_violation", `safety-only 커밋이 허용되지 않은 전이 사유를 낸다: ${e.reason}`);
    }
    if (e.toState === "completed" || e.toState === "running") {
      throw new OrchestrationError("safety_only_violation", `safety-only 커밋은 ${e.toState}로 전이할 수 없다`);
    }
  }
}

function assertBatchLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxScheduleBatch) {
    throw new OrchestrationError("invalid_batch_limit", `batch 상한은 1..${LIMITS.maxScheduleBatch} 정수여야 한다`);
  }
  return limit;
}

// ── 순수 헬퍼 (draft 조작) ──────────────────────────────────────────────────

function requireTask(state: OrchestrationRunState, taskId: string): OrchestrationTask {
  const t = state.tasks.find((x) => x.taskId === taskId);
  if (!t) throw new OrchestrationError("unknown_task", `미상 task: ${taskId}`);
  return t;
}

/** 산출물 등록이 가능한 running task. */
function requireRunningTask(state: OrchestrationRunState, taskId: unknown, what: string): OrchestrationTask {
  const task = requireTask(state, assertSlug(taskId, "taskId"));
  if (task.state !== "running") {
    throw new OrchestrationError("invalid_transition", `${what}는 running task만 가능하다 (현재 ${task.state})`);
  }
  return task;
}

/**
 * **결과·차단을 수락할 수 있는 task**(V3 M5c · 대장 `B-13`): `cleaning`이고 **zero-survivor가 확인된**
 * 상태여야 한다. 자원을 놓는 종료 전이(`completed`/`blocked`)는 전부 이 규칙 하나를 지난다 —
 * 새 진입점이 추가돼도 우회로가 생기지 않는다.
 */
function requireCleanedTask(state: OrchestrationRunState, taskId: unknown, what: string): OrchestrationTask {
  const task = requireTask(state, assertSlug(taskId, "taskId"));
  if (task.state !== "cleaning") {
    throw new OrchestrationError(
      "invalid_transition",
      `${what}는 cleaning task만 수락된다 (현재 ${task.state}) — recordTerminal로 정리 단계에 먼저 들어간다`,
    );
  }
  if (task.execution.cleanupStatus !== "confirmed") {
    throw new OrchestrationError("cleanup_unconfirmed", `${what}: 자손 프로세스 0이 확인되지 않았다 (${task.taskId})`);
  }
  return task;
}

const OUTPUT_KEYS = ["path", "role"] as const;
const REGISTER_KEYS = ["taskId", "path", "role"] as const;

/**
 * **호출자 소유 객체를 닫아 단 한 번 읽는다**(V3 M5b 4차 독립 리뷰 A4).
 *
 * key 집합을 닫고(string 외 key·미상 key 거부) 허용된 property를 **각각 정확히 한 번** 읽어 평범한
 * 사본으로 만든다. 읽는 순간 던지는 getter/proxy(`ownKeys` trap 포함)도 여기서 안정 taxonomy로 접힌다 —
 * 경계 밖 오류가 자기 코드를 고르지 못한다.
 */
function readClosedOnce(raw: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") {
    throw new OrchestrationError("invalid_artifact_ref", `${what}는 객체여야 한다`);
  }
  const read: Record<string, unknown> = {};
  try {
    for (const k of Reflect.ownKeys(raw)) {
      if (typeof k !== "string" || !allowed.includes(k)) {
        throw new OrchestrationError("invalid_artifact_ref", `${what}에 허용되지 않은 필드가 있다(허용: ${allowed.join(", ")})`);
      }
    }
    for (const k of allowed) read[k] = (raw as Record<string, unknown>)[k]; // ← 각 property를 읽는 유일한 지점
  } catch (e) {
    if (e instanceof OrchestrationError) throw e;
    throw new OrchestrationError("invalid_artifact_ref", `${what}를 읽을 수 없다(getter/proxy가 던졌다)`);
  }
  return read;
}

/**
 * 이미 한 번 읽은 값으로 **불변 산출물**을 굳힌다. 이전 판은 `out.role`을 검증하고 **다시 읽어**
 * 기록했으므로, 첫 읽기에 `"output"`을 주고 두 번째 읽기에 계약 밖 role을 주는 교대 getter가 record와
 * result 포인터를 함께 오염시킬 수 있었다(커밋은 성공하고 reopen만 실패했다).
 * cyclic·깊은 payload는 path/role이 문자열이 아니므로 같은 자리에서 걸린다.
 */
function adoptedOutput(path: unknown, role: unknown): TaskOutput {
  if (!(ARTIFACT_ROLES as readonly string[]).includes(role as string)) {
    throw new OrchestrationError("invalid_artifact_ref", `role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
  }
  return Object.freeze({ path: normalizeWorkspacePath(path, "artifact path"), role: role as ArtifactRole });
}

/** 호출자 소유 `{path, role}` 1건을 입양한다. 이후 원본 객체는 다시 읽지 않는다. */
function adoptOutput(raw: unknown): TaskOutput {
  const read = readClosedOnce(raw, OUTPUT_KEYS, "산출물");
  return adoptedOutput(read.path, read.role);
}

/**
 * 호출자 소유 산출물 **목록**을 한 번에 입양한다. 길이도 한 번만 읽고 각 항목도 한 번만 읽으므로,
 * 입양 뒤 원본 배열·항목을 바꿔도 등록되는 값은 바뀌지 않는다.
 */
function adoptOutputs(outputs: ReadonlyArray<TaskOutput> | undefined): ReadonlyArray<TaskOutput> {
  if (outputs === undefined) return [];
  if (!Array.isArray(outputs)) throw new OrchestrationError("invalid_artifact_ref", "outputs는 배열이어야 한다");
  const length = outputs.length; // ← 길이를 읽는 유일한 지점
  if (length > LIMITS.maxArtifactRefs) {
    throw new OrchestrationError("artifact_refs_too_many", `한 결과의 산출물은 ${LIMITS.maxArtifactRefs}건까지다`);
  }
  const adopted: TaskOutput[] = [];
  for (let i = 0; i < length; i++) adopted.push(adoptOutput(outputs[i]));
  return Object.freeze(adopted);
}

/**
 * 산출물 목록 전체를 **한 트랜잭션 안에서** 등록한다. 개수 상한과 경로 중복은 여기서만 판정한다
 * (한 결과가 같은 경로를 두 번 등록하면 revision 두 개가 생겨 포인터가 서로 모순된다).
 */
function addArtifacts(
  draft: OrchestrationRunState,
  now: string,
  mutation: Mutation,
  paths: RunPaths,
  task: OrchestrationTask,
  outputs: ReadonlyArray<TaskOutput> | undefined,
): ArtifactPointer[] {
  const adopted = adoptOutputs(outputs);
  const seen = new Set<string>();
  return adopted.map((out) => addArtifact(draft, now, mutation, paths, task, out, seen));
}

/**
 * artifact 1건 등록 — **소유권·writableRoots·파일 신원 집행의 유일한 지점**(V3 M5b 독립 리뷰 A2).
 * 조용히 덮어쓰지 않고 revision을 올리며 직전 revision을 `supersedes`로 남긴다.
 * symlink/missing/비일반 파일/workspace 탈출은 fail-closed다.
 *
 * `out`은 **이미 입양된 불변 값**이다(A4) — 이 함수는 호출자 소유 객체를 읽지 않는다.
 */
function addArtifact(
  draft: OrchestrationRunState,
  now: string,
  mutation: Mutation,
  paths: RunPaths,
  task: OrchestrationTask,
  out: TaskOutput,
  seen: Set<string>,
): ArtifactPointer {
  const { path, role } = out;
  if (seen.has(path)) {
    throw new OrchestrationError("artifact_path_duplicate", `한 결과가 같은 경로를 두 번 등록할 수 없다: ${path}`);
  }
  seen.add(path);
  // workspace 탈출·symlink는 **가장 먼저** 걸린다(더 근본적인 위반이므로 코드도 그쪽이 이긴다).
  const sha256 = verifyArtifactFile(paths.workspaceRoot, path, null);
  // 이전 판은 "running task + 파일 존재"만 봤으므로 task A가 task B의 소유 경로를 자기 산출물로
  // 등록할 수 있었다(교차 task 오염). 등록 경로가 둘(단건·트랜잭션)이어도 불변식은 이 함수 하나다.
  if (!task.ownership.some((own) => pathWithin(path, own))) {
    throw new OrchestrationError("artifact_not_owned", `artifact ${path}는 task ${task.taskId}의 소유 경로 밖이다`);
  }
  if (!draft.manifest.writableRoots.some((root) => pathWithin(path, root))) {
    throw new OrchestrationError("artifact_outside_writable_root", `artifact ${path}는 승인된 writableRoots 밖이다`);
  }

  const prior = draft.artifacts.filter((a) => a.path === path).sort((a, b) => a.revision - b.revision).pop() ?? null;
  const revision = prior === null ? 1 : prior.revision + 1;
  const record: ArtifactRecord = {
    artifactId: `${path}@${revision}`,
    path,
    sha256,
    revision,
    producerTaskId: task.taskId,
    role,
    registeredAt: now,
    supersedes: prior === null ? null : prior.artifactId,
  };
  draft.artifacts.push(record);
  mutation.events.push(
    event({ at: now, type: "artifact_registered", revision: draft.revision, taskId: task.taskId, artifactId: record.artifactId }),
  );
  return { path, sha256, revision, producerTaskId: task.taskId, role };
}

/**
 * 승인 만료 확인. 타임스탬프는 고정 폭 UTC라 문자열 비교로 충분하다.
 * **경계 포함이다(`>=`)** — 대장 `C-17`: 이전 판의 `>`는 만료 밀리초에 전이 하나를 통과시켰고
 * 실행 경계(`executionBoundary`)는 이미 `>=`였으므로 두 계층의 판정이 갈렸다.
 */
function assertNotExpired(manifest: MilestoneApprovalManifest, now: string): void {
  if (now >= manifest.expiresAt) {
    throw new OrchestrationError(
      "manifest_expired",
      `승인 manifest가 만료됐다(expiresAt ${manifest.expiresAt}, now ${now}) — 재승인 없이는 전진하지 않는다`,
    );
  }
}

/**
 * **전진 작업 게이트**(V3 M5c). 만료와 **durable run deadline** 둘 다 본다 — 재시작이 예산 창을 새로
 * 만들지 못하므로 deadline은 재시작을 넘어 유효하다(대장 `B-12`).
 */
function assertForwardWorkAllowed(state: OrchestrationRunState, now: string): void {
  assertClockSane(state, now);
  assertNotExpired(state.manifest, now);
  if (now >= state.accounting.budgetDeadlineAt) {
    throw new OrchestrationError(
      "budget_elapsed_exhausted",
      `승인된 경과 예산을 넘었다(deadline ${state.accounting.budgetDeadlineAt}, now ${now})`,
    );
  }
}

/**
 * **시계 역행·이상은 fail closed다.** 커밋 시각이 run 생성 시각보다 이르면 durable 회계·deadline 판정이
 * 전부 무의미해지므로 safety-only 경로에서도 거부한다(그 경우 호출자는 `paused/clock_invalid`로 내려간다 —
 * 다만 그 pause 자체도 이 게이트를 지나야 하므로, 시계가 정상으로 돌아온 뒤에만 durable해진다).
 */
function assertClockSane(state: OrchestrationRunState, now: string): void {
  if (now < state.createdAt || now < state.accounting.budgetStartedAt) {
    throw new OrchestrationError("clock_invalid", `커밋 시각이 run 시작보다 이르다(now ${now})`);
  }
}

/** 메시지를 제출·수신할 수 있는 활성 task인가. 종료 상태(completed/blocked)는 거부한다. */
function assertActive(task: OrchestrationTask, what: string, allowIdle = false): void {
  const ok = allowIdle
    ? task.state !== "completed" && task.state !== "blocked"
    : task.state === "running" || task.state === "waiting_children";
  if (!ok) {
    throw new OrchestrationError("invalid_transition", `${what}는 이 상태의 task가 할 수 없다 (현재 ${task.state})`);
  }
}

/**
 * 전달 대상 해석: taskId 우선, 없으면 roleId로 찾되 **유일할 때만** 인정한다.
 * 자기 자신·미상·모호는 전부 거부하고, 종료된 task도 수신자가 될 수 없다.
 *
 * **taskId ↔ roleId 교차 namespace 모호성도 거부한다(대장 `C-16`, M5b).** 어떤 task의 `taskId`가
 * **다른 task의 `roleId`** 와 같으면 이전 판은 taskId를 조용히 먼저 골랐다 — 실제 inbox 소비가 생긴
 * 지금은 그 선택 하나로 bounded summary·artifact 포인터가 **엉뚱한 관련 task**로 갈 수 있다.
 * 중앙은 "누구에게"를 추측하지 않으므로 두 해석이 갈리면 `ambiguous_recipient`다(전이 0).
 * 같은 task가 자기 taskId와 roleId를 같게 가진 경우는 해석이 하나이므로 충돌이 아니다.
 */
function resolveRecipientTask(state: OrchestrationRunState, raw: string, sender: OrchestrationTask): OrchestrationTask {
  const id = assertSlug(raw, "deliverTo");
  if (id === ORCHESTRATOR_ID) {
    throw new OrchestrationError("invalid_recipient", "orchestrator는 전달 대상 task가 아니다(중앙은 이미 수신자다)");
  }
  const byTaskId = state.tasks.find((t) => t.taskId === id);
  const byRoleId = state.tasks.filter((t) => t.roleId === id);
  if (byTaskId && byRoleId.some((t) => t.taskId !== byTaskId.taskId)) {
    throw new OrchestrationError(
      "ambiguous_recipient",
      `전달 대상 ${id}가 어떤 task의 taskId이면서 다른 task의 roleId다 — taskId를 추측해 고르지 않는다`,
    );
  }
  const matches = byTaskId ? [byTaskId] : byRoleId;
  if (matches.length === 0) throw new OrchestrationError("unknown_recipient", `미상 전달 대상: ${id}`);
  if (matches.length > 1) {
    throw new OrchestrationError("ambiguous_recipient", `전달 대상 ${id}가 task 여럿과 맞는다 — taskId로 지정해야 한다`);
  }
  const recipient = matches[0];
  if (recipient.taskId === sender.taskId) {
    throw new OrchestrationError("route_self", "자기 자신에게 전달할 수 없다");
  }
  if (recipient.state === "completed" || recipient.state === "blocked") {
    throw new OrchestrationError("recipient_unavailable", `수신 task가 종료 상태다: ${recipient.taskId} (${recipient.state})`);
  }
  return recipient;
}

/** 중앙이 인정하는 sibling 관계: 같은 parent(둘 다 root가 아님) 또는 둘 사이의 직접 의존. */
function isRelated(a: OrchestrationTask, b: OrchestrationTask): boolean {
  if (a.parentTaskId !== null && a.parentTaskId === b.parentTaskId) return true;
  return a.dependsOn.includes(b.taskId) || b.dependsOn.includes(a.taskId);
}

function requireSubject(state: OrchestrationRunState, rawId: string, target: OrchestrationTask): OrchestrationTask {
  const subject = requireTask(state, assertSlug(rawId, "subjectTaskId"));
  if (subject.taskId === target.taskId) {
    throw new OrchestrationError("route_self", "검토·수정 대상과 수신 task가 같을 수 없다");
  }
  return subject;
}

function assertDependsOnSubject(target: OrchestrationTask, subject: OrchestrationTask, what: string): void {
  if (!target.dependsOn.includes(subject.taskId)) {
    throw new OrchestrationError(
      "route_not_related",
      `${what} ${target.taskId}가 대상 ${subject.taskId}에 의존하지 않는다 — 임의 task에 지시하지 않는다`,
    );
  }
}

/** fresh 세션 계약(§3.3): 아직 아무 산출물·결과도 내지 않은 task만 reviewer/revision worker가 된다. */
function assertFresh(task: OrchestrationTask, what: string): void {
  const fresh =
    (task.state === "pending" || task.state === "ready") &&
    task.resultSummary === null &&
    task.blockerSummary === null &&
    task.artifactRefs.length === 0;
  if (!fresh) {
    throw new OrchestrationError("task_not_fresh", `${what} ${task.taskId}가 fresh하지 않다 (상태 ${task.state})`);
  }
}

function setState(
  draft: OrchestrationRunState,
  now: string,
  mutation: Mutation,
  task: OrchestrationTask,
  to: TaskState,
  reason: TransitionReason,
  audit?: { actionId?: string | null; attemptId?: string | null; marker?: string | null },
): void {
  if (task.state === to) return;
  mutation.events.push(
    event({
      at: now,
      type: "task_state_changed",
      revision: draft.revision,
      taskId: task.taskId,
      fromState: task.state,
      toState: to,
      reason,
      actionId: audit?.actionId ?? null,
      attemptId: audit?.attemptId ?? null,
      marker: audit?.marker ?? null,
    }),
  );
  task.state = to;
  task.updatedAt = now;
}

function addTask(
  draft: OrchestrationRunState,
  now: string,
  mutation: Mutation,
  seed: DependentTaskSeed,
  parentTaskId: string | null,
  depth: number,
): OrchestrationTask {
  if (draft.tasks.length >= LIMITS.maxTasksPerRun) {
    throw new OrchestrationError("task_limit_exceeded", `run당 task는 ${LIMITS.maxTasksPerRun}개까지다`);
  }
  const taskId = assertSlug(seed.taskId, "taskId");
  if (draft.tasks.some((t) => t.taskId === taskId)) {
    throw new OrchestrationError("duplicate_task_id", `이미 존재하는 taskId: ${taskId}`);
  }
  if (!Array.isArray(seed.dependsOn)) {
    throw new OrchestrationError("invalid_dependency", "dependsOn은 배열이어야 한다");
  }
  if (seed.dependsOn.length > LIMITS.maxDependsOn) {
    throw new OrchestrationError("depends_on_too_many", `dependsOn은 ${LIMITS.maxDependsOn}개 이하여야 한다`);
  }
  const dependsOn: string[] = [];
  for (const d of seed.dependsOn) {
    const id = assertSlug(d, "dependsOn 항목");
    if (id === taskId) throw new OrchestrationError("self_dependency", `task가 자기 자신에 의존할 수 없다: ${taskId}`);
    if (!draft.tasks.some((t) => t.taskId === id)) {
      throw new OrchestrationError("unknown_dependency", `미상 dependsOn: ${id}`);
    }
    if (dependsOn.includes(id)) throw new OrchestrationError("depends_on_duplicate", `dependsOn 중복: ${id}`);
    dependsOn.push(id);
  }

  const task: OrchestrationTask = {
    taskId,
    // 중앙만 task를 만들고, role은 registry 안에서만 고를 수 있다(agent의 self-grant 경로 없음).
    roleId: assertRegistryRoleId(seed.roleId, "roleId"),
    title: assertText(seed.title, "title", LIMITS.maxTextLength),
    scope: assertText(seed.scope, "scope", LIMITS.maxTextLength),
    ownership: normalizeOwnership(seed.ownership, "ownership"),
    resourceClasses: normalizeResourceClasses(seed.resourceClasses ?? [], "resourceClasses"),
    parentTaskId,
    childTaskIds: [],
    dependsOn,
    state: "pending",
    depth,
    createdAt: now,
    updatedAt: now,
    resultSummary: null,
    blockerSummary: null,
    artifactRefs: [],
    execution: emptyTaskExecution(),
  };
  draft.tasks.push(task);
  mutation.events.push(
    event({ at: now, type: "task_created", revision: draft.revision, taskId, toState: "pending", reason: "created" }),
  );
  if (dependsOn.length === 0) setState(draft, now, mutation, task, "ready", "created");

  // task_assignment는 중앙 kernel이 보낸다 (sender=orchestrator, recipient=task role).
  const envelope: AgentMessageEnvelope = {
    schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION,
    messageId: assertSlug(seed.assignmentMessageId, "assignmentMessageId"),
    runId: draft.runId,
    milestoneId: draft.milestoneId,
    taskId,
    parentTaskId,
    sender: ORCHESTRATOR_ID,
    recipient: task.roleId,
    type: "task_assignment",
    createdAt: now,
    dependsOn,
    artifactRefs: [],
    supersedes: null,
  };
  acceptMessage(draft, now, mutation, null, envelope, seed.assignmentBody, null);
  return task;
}

/**
 * 메시지 검증 + index 등록. envelope↔state 대조(run/milestone/task/parent/방향), messageId 중복,
 * unknown dependsOn/message, artifact 포인터의 registry·디스크 재검증까지 여기서 fail-closed로 처리한다.
 * `paths`가 null이면 artifact 재검증 대상이 없는 kernel 내부 발신 메시지다.
 */
function acceptMessage(
  draft: OrchestrationRunState,
  now: string,
  mutation: Mutation,
  paths: RunPaths | null,
  rawEnvelope: AgentMessageEnvelope,
  rawBody: unknown,
  summary: string | null,
  routeToTaskId: string | null = null,
): void {
  const envelope = rawEnvelope;
  const body = validateMessageBody(envelope.type, rawBody);
  if (SUMMARY_REQUIRED[envelope.type] !== (summary !== null)) {
    throw new OrchestrationError(
      "invalid_summary",
      `${envelope.type}의 bounded summary 계약이 어긋났다(필수=${SUMMARY_REQUIRED[envelope.type]})`,
    );
  }

  if (draft.messages.some((m) => m.messageId === envelope.messageId)) {
    throw new OrchestrationError("duplicate_message_id", `이미 존재하는 messageId: ${envelope.messageId}`);
  }
  if (envelope.runId !== draft.runId) {
    throw new OrchestrationError("run_id_mismatch", `envelope.runId가 run과 다르다: ${envelope.runId}`);
  }
  if (envelope.milestoneId !== draft.milestoneId) {
    throw new OrchestrationError("milestone_mismatch", `envelope.milestoneId가 run과 다르다: ${envelope.milestoneId}`);
  }
  const task = requireTask(draft, envelope.taskId);
  if (envelope.parentTaskId !== task.parentTaskId) {
    throw new OrchestrationError("parent_mismatch", `envelope.parentTaskId가 task와 다르다: ${String(envelope.parentTaskId)}`);
  }
  assertDirection(envelope, task);

  for (const d of envelope.dependsOn) {
    const known = draft.tasks.some((t) => t.taskId === d) || draft.messages.some((m) => m.messageId === d);
    if (!known) throw new OrchestrationError("unknown_dependency", `미상 dependsOn: ${d}`);
  }
  if (envelope.supersedes !== null && !draft.messages.some((m) => m.messageId === envelope.supersedes)) {
    throw new OrchestrationError("unknown_message", `미상 supersedes: ${envelope.supersedes}`);
  }

  for (const ref of envelope.artifactRefs) {
    const record = draft.artifacts.find((a) => a.artifactId === `${ref.path}@${ref.revision}`);
    if (!record) {
      throw new OrchestrationError("unknown_artifact", `미등록 artifact: ${ref.path}@${ref.revision}`);
    }
    if (record.sha256 !== ref.sha256 || record.producerTaskId !== ref.producerTaskId || record.role !== ref.role) {
      throw new OrchestrationError("artifact_ref_mismatch", `artifact 포인터가 등록 내용과 다르다: ${record.artifactId}`);
    }
    if (paths === null) {
      throw new OrchestrationError("artifact_ref_unexpected", "이 메시지는 artifact 포인터를 가질 수 없다");
    }
    // 수락 직전 재검증 — 등록 이후 파일이 바뀌었거나 symlink로 바뀌었으면 거부한다.
    verifyArtifactFile(paths.workspaceRoot, record.path, record.sha256);
  }

  const entry: MessageIndexEntry = {
    messageId: envelope.messageId,
    type: envelope.type,
    taskId: envelope.taskId,
    parentTaskId: envelope.parentTaskId,
    sender: envelope.sender,
    recipient: envelope.recipient,
    createdAt: envelope.createdAt,
    dependsOn: [...envelope.dependsOn],
    artifactRefs: envelope.artifactRefs.map(clone),
    supersedes: envelope.supersedes,
    bodyPath: `messages/${envelope.messageId}.md`,
    bodySha256: sha256Hex(body),
    summary,
    routeToTaskId,
    acknowledgedAt: null,
    delivery: emptyMessageDelivery(),
  };
  draft.messages.push(entry);
  mutation.bodies.push({ messageId: envelope.messageId, body });
  mutation.events.push(
    event({
      at: now,
      type: "message_accepted",
      revision: draft.revision,
      taskId: envelope.taskId,
      messageId: envelope.messageId,
    }),
  );
}

/**
 * 통신 방향 계약(§5.3): `CENTRAL_MESSAGE_TYPES`는 중앙→agent, 나머지는 agent→중앙뿐이다.
 * sibling 전달도 이 규칙 안에 있다 — 발신 agent는 **중앙에게** 보내고 route는 중앙이 정한다.
 */
function assertDirection(envelope: AgentMessageEnvelope, task: OrchestrationTask): void {
  const central: readonly AgentMessageType[] = CENTRAL_MESSAGE_TYPES;
  if (central.includes(envelope.type)) {
    if (envelope.sender !== ORCHESTRATOR_ID || envelope.recipient !== task.roleId) {
      throw new OrchestrationError("invalid_direction", `${envelope.type}은 orchestrator → ${task.roleId} 방향이어야 한다`);
    }
    return;
  }
  if (envelope.sender !== task.roleId || envelope.recipient !== ORCHESTRATOR_ID) {
    throw new OrchestrationError("invalid_direction", `${envelope.type}은 ${task.roleId} → orchestrator 방향이어야 한다`);
  }
}

/**
 * 상태 재계산 fixpoint. 결정론적: 매 pass마다 taskId 오름차순으로 훑는다.
 * - child나 dependency가 blocked면 그 task도 blocked (조상·dependent로 전파).
 * - pending인데 dependsOn이 전부 completed면 ready.
 * - waiting_children인데 child가 전부 completed면 ready.
 * completed task는 절대 되돌리지 않는다.
 */
function recompute(draft: OrchestrationRunState, now: string, mutation: Mutation): void {
  const ordered = [...draft.tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const byId = new Map(draft.tasks.map((t) => [t.taskId, t]));
  const stateOf = (id: string): TaskState => {
    const t = byId.get(id);
    if (!t) throw new OrchestrationError("unknown_task", `미상 task: ${id}`);
    return t.state;
  };

  let changed = true;
  let guard = 0;
  while (changed) {
    if (guard++ > LIMITS.maxTasksPerRun + 2) {
      throw new OrchestrationError("recompute_not_converging", "상태 재계산이 수렴하지 않았다");
    }
    changed = false;
    for (const t of ordered) {
      if (t.state === "completed" || t.state === "blocked") continue;
      if (t.childTaskIds.some((c) => stateOf(c) === "blocked")) {
        setState(draft, now, mutation, t, "blocked", "child_blocked");
        changed = true;
        continue;
      }
      if (t.dependsOn.some((d) => stateOf(d) === "blocked")) {
        setState(draft, now, mutation, t, "blocked", "dependency_blocked");
        changed = true;
        continue;
      }
      if (t.state === "pending" && t.dependsOn.every((d) => stateOf(d) === "completed")) {
        setState(draft, now, mutation, t, "ready", "dependencies_completed");
        changed = true;
        continue;
      }
      if (
        t.state === "waiting_children" &&
        t.childTaskIds.length > 0 &&
        t.childTaskIds.every((c) => stateOf(c) === "completed")
      ) {
        setState(draft, now, mutation, t, "ready", "children_completed");
        changed = true;
      }
    }
  }
}

// prototype을 얼린다 — 메서드 monkey-patch(모든 인스턴스에 영향)를 닫는다(A2).
Object.freeze(OrchestrationKernel.prototype);

/** 편의 진입점 — production 기본 root는 `<workspace>/outputs/orchestration`이다. */
export function createOrchestrationRun(opts: {
  workspaceRoot: string;
  runId: string;
  milestoneId: string;
  manifest: unknown;
  clock?: Clock;
}): OrchestrationKernel {
  return OrchestrationKernel.create(opts);
}

export function openOrchestrationRun(opts: { workspaceRoot: string; runId: string; clock?: Clock }): OrchestrationKernel {
  return OrchestrationKernel.open(opts);
}
