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
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join as joinPath } from "node:path";
import {
  AGENT_MESSAGE_SCHEMA_VERSION,
  type AgentMessageEnvelope,
  type AgentMessageType,
  APPROVED_OPERATION_KINDS,
  type ApprovedOperation,
  type ArtifactPointer,
  type ArtifactRecord,
  type ArtifactRole,
  ARTIFACT_ROLES,
  type AutopilotMarker,
  AUTOPILOT_MARKERS,
  CENTRAL_MESSAGE_TYPES,
  type Clock,
  type ControllerAction,
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
  type PendingOperation,
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
  codePointLength,
  emptyMessageDelivery,
  emptyTaskExecution,
  formatTimestamp,
  holdsResources,
  normalizeOwnership,
  normalizeResourceClasses,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { validateEnvelope, validateMessageBody } from "./agentMessage.js";
import { approvedOperationFor, assertRegistryRoleId, pathWithin, validateApprovalManifest } from "./approvalManifest.js";
import { MAX_PROGRESS_STEP_CHARS, MAX_WORKER_EVENTS, type TypedExecutionPlan, type TypedOperation } from "./autopilotTypes.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";
import { verifyApprovedExecutable } from "./executionBoundary.js";
import { superviseProcess } from "./managedProcess.js";
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
import type { TypedRunProcessOperation, TypedWriteFileOperation } from "./typedPlan.js";
import { buildContextBundle, computeSnapshotDigest } from "./contextBundle.js";
import type { SnapshotDigest } from "./contextBundle.js";

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

/**
 * **발급 kernel 신원**(3A 5차 리비전 A2). 4차 판의 등록부는 모듈 전역이고 수신 메서드는 "이 모듈이
 * 발급했는가"만 봤다 → 서로 다른 workspace의 두 kernel이 **평범한 durable ID를 우연히/의도적으로 같게**
 * 가지면, A가 발급한 permit으로 B에서 과금·pending 등록·attempted 표시·영수증 커밋을 할 수 있었고
 * live grant key도 서로를 죽였다(독립 리뷰 A-2).
 *
 * 그래서 발급된 모든 handle(permit · grant · outcome · 진행 채널)은 **발급 인스턴스 자체**를 들고 있고,
 * 수신 메서드는 `this`와 **동일 객체인지**(`===`) 본다. 평범한 durable 문자열 ID는 발급자 신원이 아니다.
 *
 * **같은 workspace의 두 번째 인스턴스도 남이다**(명시적 결정 · DECISIONS 2026-07-31): 프로세스 메모리
 * handle은 인스턴스 경계를 **조용히 넘지 않는다**. 재시작·재열기의 정합화는 durable 경로로만 한다 —
 * `attemptedAt === null`이면 같은 (turn, 계획)의 **커밋 없는 permit 재발급**, 그 밖이면 handle을 요구하지
 * 않는 `reconcileUncertainOperation()`이다.
 */
type KernelIssuer = OrchestrationKernel;

/**
 * **kernel이 발급한 진짜 일회용 execution grant 등록부**(3A 2차 리비전 A2).
 * permit은 "이 계획을 이 turn에 집행해도 된다"는 **범위**이고, grant는 "이 operation 1건을 **지금 한 번**
 * 집행한다"는 **일회용 권능**이다. grant는 `beginOperation()`이 durable pending 레코드를 커밋한 뒤에만
 * 나오고, 효과 게이트가 정확히 한 번 소진하며, 영수증 커밋이 정확히 한 번 소비한다.
 */
const GENUINE_GRANTS = new WeakMap<object, GrantRecord>();

interface PermitRecord {
  /** 이 permit을 발급한 kernel 인스턴스 자체(A2 — 다른 인스턴스의 수신 메서드는 이것으로 거부한다). */
  issuer: KernelIssuer;
  /**
   * **현재** durable state를 다시 읽는다. `getState()` 같은 **공개·override 가능** 메서드가 아니라
   * `#state` private 필드를 직접 읽는다(3A 2차 리뷰 A1: 공개 메서드를 monkey-patch해 옛 `running`
   * 스냅샷을 돌려주면 취소·정리 전이를 우회할 수 있었다).
   */
  readState: () => OrchestrationRunState;
  /** kernel이 주입받은 clock — 호출자가 시각을 고를 수 없다. */
  now: () => string;
  workspaceRoot: string;
  /** 이 permit에 **묶인** 검증·동결된 계획. operation은 이 배열의 항목 그 자체여야 한다. */
  plan: TypedExecutionPlan;
  /** 이 계획의 canonical digest — durable claim(`execution.dispatchPlanDigest`)과 대조한다. */
  planDigest: string;
  /** 발급 시점의 봉인된 preflight digest. dispatch 직전에 현재 state로 다시 계산해 대조한다. */
  preflightDigest: string;
  attemptNo: number;
}

/**
 * grant 1건의 생애(3A 3차 리비전 A2):
 * `issued` → (`executeUnderGrant` 진입, **일회용**) → `attempted`(집행기가 결과를 냈다) | `errored`(집행이 던졌다)
 * → `consumed`(영수증 커밋 · 실패 종결 · 또는 같은 pending 신원의 새 grant에 의해 **폐기**).
 *
 * `attempted`에서만 성공 marker 영수증이 나올 수 있고, 그 영수증의 내용은 **집행기가 낸 결과 그대로**
 * (`outcome`)이며 호출자가 바꿔 넣을 필드가 없다.
 */
type GrantState = "issued" | "attempted" | "errored" | "consumed";

interface GrantRecord {
  /** 이 grant를 발급한 kernel 인스턴스 자체(A2). live key도 이 신원으로 격리된다. */
  issuer: KernelIssuer;
  permit: OperationDispatchPermit;
  op: TypedOperation;
  state: GrantState;
  /** durable pending 신원 key — **이 발급 인스턴스 안에서** 이 key당 살아 있는 grant는 최대 하나다. */
  pendingKey: string;
  /** 집행기가 실제로 낸 canonical 결과. 영수증은 **이 값만** 쓴다(호출자 필드를 채택하지 않는다). */
  outcome: EffectOutcome | null;
  /**
   * **일회용 집행 경계 진입을 durable pending에 먼저 적는다**(3A 4차 리비전 A2 — 발급한 kernel에 묶인
   * 클로저다. 호출자가 만들 수 없고 다른 run/task를 가리킬 수도 없다). 멱등이다.
   */
  markAttempted: () => void;
}

/**
 * **집행기가 낸 결과 1건**(닫힌 값 — 호출자가 만들 수 없다). 이 값은 `executeUnderGrant`의 effect가
 * **정상 반환**했을 때만 만들어지고, 그 순간 grant 레코드 안에 canonical하게 저장된다.
 */
interface EffectOutcome {
  marker: OperationReceipt["marker"];
  path: string | null;
  resultSha256: string | null;
  exitCode: number | null;
}

/**
 * **집행 결과 handle**(3A 3차 리비전 A2). 담긴 필드는 **감사·표시용**이고 권위는 아니다 —
 * 권위는 아래 `GENUINE_OUTCOMES` 등록부 연결에서만 나오므로, 같은 모양의 구조적 객체나 전개 사본
 * (`{...outcome}`)은 영수증을 만들지 못한다. 영수증에 저장되는 값은 handle의 필드가 아니라
 * **grant 안에 저장된 canonical 결과**다.
 */
export interface OperationOutcome extends EffectOutcome {
  readonly operationId: string;
  readonly kind: TypedOperation["kind"];
  readonly authorityId: string;
}

const GENUINE_OUTCOMES = new WeakMap<object, GrantRecord>();

/**
 * **durable pending 신원당 살아 있는 grant는 최대 하나**(3A 3차 리비전 A2).
 *
 * 이전 판은 같은 pending operation을 다시 열 때마다 **독립적으로 살아 있는 grant**를 새로 줬다 →
 * `g1`·`g2`를 **둘 다 소진**해 같은 operation을 두 번 집행할 수 있었다(비멱등 프로세스 효과라면 두 번 실행).
 * 지금은 새 grant 발급이 같은 key의 이전 grant를 **그 자리에서 폐기**하므로 재시작 정합화(같은 operation을
 * 다시 여는 것)는 그대로 되면서 live/live 중복은 존재할 수 없다.
 *
 * **key는 발급 인스턴스별로 격리된다**(3A 5차 리비전 A2). 4차 판은 모듈 전역 `Map`에 durable ID만으로
 * 키를 만들었으므로, 두 workspace가 같은 run/task/attempt/turn/plan/operation ID를 쓰면 한쪽의 grant 발급이
 * **다른 workspace의 살아 있는 grant를 소비**했다. 발급자별 `Map`이면 그 충돌이 성립하지 않고, 죽은 kernel의
 * 항목도 함께 수거된다.
 */
const LIVE_GRANTS = new WeakMap<KernelIssuer, Map<string, GrantRecord>>();

function liveGrantsOf(issuer: KernelIssuer): Map<string, GrantRecord> {
  let live = LIVE_GRANTS.get(issuer);
  if (live === undefined) {
    live = new Map();
    LIVE_GRANTS.set(issuer, live);
  }
  return live;
}

function pendingKeyOf(permit: OperationDispatchPermit, planDigest: string, operationId: string): string {
  return JSON.stringify([permit.runId, permit.taskId, permit.attemptId, permit.turnId, planDigest, operationId]);
}

// ── worker 진행 채널 (V3 M5c 3A 4차 리비전 A1) ────────────────────────────────

/**
 * **kernel이 발급한 진짜 worker 진행 채널 등록부**(위 permit/grant와 같은 패턴 — 밖으로 나가지 않는다).
 *
 * 이것이 필요한 이유(3차 판의 결함): 진행 신호의 provenance가 **durable `processLeaseMarker` 하나**였고
 * 그 값은 `getTask()`가 그대로 돌려준다 → state를 읽을 수 있는 코드는 누구든 lease를 베껴 no-progress
 * 시계를 되돌릴 수 있었다. 게다가 `seq`는 **모양만** 검사했으므로 같은 이벤트를 무한히 재생하거나
 * 역순으로 넣어도 통과했다(독립 리뷰 A-1). 지금 채널은 **`startPreparedTask()`가 시작을 커밋한 그 순간
 * 딱 한 번** 발급된다 — durable 값에서 되만들 수 있는 공개 통로가 없고, 채널마다 **단조 sequence**를
 * 들고 있으며, 사용할 때마다 현재 durable run/task/attempt/lease와 다시 대조한다.
 */
const GENUINE_PROGRESS_CHANNELS = new WeakMap<object, ProgressChannelRecord>();

interface ProgressChannelRecord {
  /** 이 채널을 발급한 kernel 인스턴스 자체(A2 — 다른 인스턴스는 이 채널로 진행을 기록할 수 없다). */
  issuer: KernelIssuer;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseMarker: string;
  /** **커밋에 성공한** 마지막 seq. 재생·역순·같은 seq는 전부 거부된다(엄격 증가). */
  lastSeq: number;
}

/**
 * **worker 진행 채널**(봉인 handle). 담긴 필드는 감사용이고 권위는 등록부 연결에서만 나오므로
 * 전개 사본(`{...channel}`)·수제 객체·`Proxy`는 진행을 기록하지 못한다.
 * 이 attempt가 끝나면(새 attempt·새 lease) 같은 handle은 durable 대조에서 죽는다.
 */
export interface WorkerProgressChannel {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
}

/** `startPreparedTask()`의 결과 — 시작된 task와 그 attempt에 **한 번만** 발급되는 진행 채널. */
export interface StartedTask {
  task: OrchestrationTask;
  progress: WorkerProgressChannel;
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
 * **일회용 execution grant**(3A 2차 리비전 A2). `beginOperation()`이 durable pending 레코드를 커밋한 뒤에만
 * 나온다. 담긴 필드는 감사용이고 권위는 등록부 연결에서만 나오므로 **같은 모양의 구조적 객체는 아무것도
 * 얻지 못한다** — 위조 영수증·재생 영수증·operation 치환·중복 집행이 전부 여기서 닫힌다.
 */
export interface OperationExecutionGrant {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly turnId: string;
  readonly operationId: string;
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
  /** 효과 게이트에 permit만 왔거나 grant가 이 모듈 발급이 아니다(구조적 위조 · 재구성 · proxy). */
  "dispatch_grant_invalid",
  /** 이미 소진된 grant를 다시 쓰려 했다(중복 집행 · 재사용). */
  "dispatch_grant_spent",
  /** operation이 그 permit에 묶인 검증된 계획의 항목이 아니다(위조·변조·다른 계획). */
  "dispatch_operation_unbound",
  /** durable pending 레코드가 없거나 이 grant/attempt/turn/계획에 묶여 있지 않다. */
  "dispatch_operation_unregistered",
  /** task가 지금 `running`이 아니다(prepared·cleaning·completed·cancelled·…). */
  "dispatch_task_not_running",
  /** durable attempt/turn 신원이 permit과 다르다(낡은 attempt · 다른 turn · claim되지 않은 turn). */
  "dispatch_identity_stale",
  /** 같은 turn에 **다른 계획**이 왔다(경쟁 계획 — 하나만 durable하게 claim된다). */
  "dispatch_plan_conflict",
  /** 승인·예산·ownership·자원·권위가 preflight 봉인 이후에 바뀌었다. */
  "preflight_drift",
  /** `now >= manifest.expiresAt`(경계 포함 — 로드맵 §8.1). */
  "manifest_expired",
  /** `now >= accounting.budgetDeadlineAt`(경계 포함). */
  "budget_elapsed_exhausted",
  /** `accounting.tokensUsed >= manifest.maxTokens`(**등호 포함** — 3A 2차 리비전 A1). */
  "budget_tokens_exhausted",
  /**
   * **이 turn을 만든 provider turn의 사용량이 아직 durable 회계에 반영되지 않았다**(3A 3차 리비전 A1).
   * 계획을 만든 turn을 과금하기 **전에** 효과를 내면 예산 판정이 항상 한 turn 뒤처진 값(stale)으로 이뤄져
   * 승인된 상한을 넘겨 쓸 수 있다. 순서는 계약이다: permit(claim) → `chargeTurnUsage` → grant → 효과.
   */
  "budget_turn_unaccounted",
  /** `now >= task.execution.wallDeadlineAt`(**등호 포함**). */
  "attempt_wall_exhausted",
  /** `now >= (lastProgressAt ?? phaseStartedAt) + maxNoProgressMs`(**등호 포함**). */
  "no_progress_exhausted",
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
export function readDispatchAuthority(handle: unknown, op: TypedOperation): Readonly<DispatchAuthority> {
  return dispatchFrom(handle, op).authority;
}

/**
 * `readDispatchAuthority`와 **같은 판정**이되 발급자 신원(`permitRecord.issuer`)까지 돌려주는 사설 형태.
 * 순수 판정에는 permit도 grant도 쓸 수 있다(grant는 **소진하지 않는다** — 효과가 아니기 때문이다).
 */
function dispatchFrom(
  handle: unknown,
  op: TypedOperation,
): { authority: Readonly<DispatchAuthority>; task: OrchestrationTask; permitRecord: PermitRecord } {
  const asGrant = typeof handle === "object" && handle !== null ? GENUINE_GRANTS.get(handle) : undefined;
  if (asGrant !== undefined) {
    if (asGrant.op !== op) {
      throw dispatchDenied("dispatch_operation_unbound", "execution grant가 이 operation에 묶여 있지 않다");
    }
    return authorityFromPermit(asGrant.permit, op);
  }
  return authorityFromPermit(handle, op);
}

/**
 * **`write_file` operation 1건의 고정 집행 진입점**(3A 4차 리비전 A2).
 *
 * 이전 판(`executeUnderGrant(grant, op, 임의콜백)`)은 **호출자가 넘긴 아무 함수**의 반환값을 canonical
 * 성공으로 굳혔다 → **아무 효과도 내지 않는 콜백 하나로 진짜 `applied` 영수증**을 만들 수 있었다
 * (독립 리뷰 A-2). 그래서 임의 콜백 표면을 **삭제**했다: grant를 소비하는 함수는 operation kind마다
 * 고정돼 있고, 그 안에서 부르는 집행기도 정적으로 고정된 `judgeWriteFile` 하나다.
 * `run_process`에는 이런 진입점이 **없다**(성공을 만들 통로가 아예 없다 — 대장 `B-10`/`B-F1`).
 *
 * 순서가 계약이다:
 * 1. grant가 이 모듈 발급이고 아직 쓰이지 않았는가(중복 집행·재사용 차단) + **바로 이 operation**인가.
 * 2. `readDispatchAuthority`의 모든 확인(현재 durable state) + **durable pending 레코드** 확인.
 * 3. **`attemptedAt`을 durable하게 먼저 적는다** — 외부 효과가 일어났을 수 있다는 사실이 효과보다 먼저
 *    영속돼야 재시작이 그 구간을 정직하게 정합화할 수 있다(A-2/A-3). 이 표시 뒤에는 새 grant가
 *    발급되지 않고 `failOperation`도 거부된다(평범한 실패로 불확실성을 지울 수 없다).
 * 4. **표시가 durable해진 뒤 권위를 다시 전수 확인한다**(3A 5차 리비전 A4). 4차 판은 ③의 커밋을
 *    사이에 두고 ②의 판정 결과를 그대로 들고 집행기에 들어갔다 — `#markOperationAttempted`는
 *    safety-only라 만료·예산·wall·no-progress deadline을 **의도적으로 보지 않으므로**, 첫 시계 읽기에서
 *    유효했던 deadline이 그 커밋 도중 지나가도 효과가 그대로 나갔다. 지금은 **집행기에 들어가기 직전의
 *    권위**만 쓴다. 여기서 거부되면 파일 시스템 효과는 **0**이고, pending은 보수적으로 "시도됐을 수
 *    있다"로 남아 정합화(`outcome_unknown`)로만 닫힌다.
 * 5. 고정 집행기를 **정확히 한 번** 부른다. 정상 반환값만 canonical 결과로 굳혀 opaque handle을 준다.
 *    던지면 grant는 `errored`로 남고 pending은 **불확실**로 남는다 → `reconcileUncertainOperation()`의
 *    `outcome_unknown`으로만 닫힌다.
 */
export function executeWriteFileOperation(grant: unknown, op: TypedWriteFileOperation): Readonly<OperationOutcome> {
  const rec = genuineGrant(grant);
  if (rec.state !== "issued") {
    throw dispatchDenied("dispatch_grant_spent", "이미 소진된 execution grant다(중복 집행·재사용 금지)");
  }
  if ((rec.op as TypedOperation) !== (op as unknown as TypedOperation)) {
    throw dispatchDenied("dispatch_operation_unbound", "execution grant가 이 operation에 묶여 있지 않다");
  }
  if (rec.op.kind !== "write_file") {
    throw dispatchDenied("dispatch_operation_unbound", "이 진입점은 write_file operation 전용이다");
  }
  // ② 진입 자격 — 여기서 거부되면 durable 표시조차 남지 않는다(거짓 불확실 0).
  authorityFromPermit(rec.permit, rec.op);
  // ③ **효과보다 먼저 durable에 적는다**: 여기서 실패하면 아직 아무 효과도 시도되지 않았다.
  rec.markAttempted();
  // **진입은 여기서 한 번뿐이다**: 아래에서 무엇이 일어나든 이 grant로 다시 들어올 수 없다.
  rec.state = "errored";
  // ④ **표시 커밋 이후의 권위로만 집행한다**(A4). 커밋 도중 만료·예산·wall·no-progress 경계를 지나갔으면
  //    바로 여기서 던진다 → 파일 시스템 효과 0 · 영수증 0 · 거짓 성공 0.
  const { authority } = authorityFromPermit(rec.permit, rec.op);
  const produced = judgeWriteFile(authority, op);
  rec.outcome = Object.freeze({
    marker: enumOf(produced.marker, OPERATION_RECEIPT_MARKERS, "effect outcome marker"),
    path: produced.path === null ? null : normalizeWorkspacePath(produced.path, "effect outcome path"),
    resultSha256: produced.resultSha256 === null ? null : assertSha256Local(produced.resultSha256),
    exitCode: produced.exitCode === null ? null : boundedExit(produced.exitCode),
  });
  rec.state = "attempted";
  const handle: OperationOutcome = Object.freeze({
    operationId: rec.op.operationId,
    kind: rec.op.kind,
    authorityId: rec.op.authorityId,
    ...rec.outcome,
  });
  GENUINE_OUTCOMES.set(handle, rec);
  return handle;
}

// ── run_process 실행 권능 + 고정 집행기 (V3 M5c task 3C · 대장 `B-F1` 개봉) ───

/**
 * **이 등록부가 kernel 모듈 안에 있는 이유**(A2/A3와 같은 이유). 권능을 `typedExecution.ts`에 두면
 * 그것을 소비하는 집행기는 **권능을 인자로 받는 공개 함수**가 될 수밖에 없고, 그 순간 위조한 구조적
 * 권능 하나가 곧 로컬 실행 권위가 된다(4차 판이 `writeFileEffect.ts`로 겪은 바로 그 결함이다).
 * 지금은 grant 등록부(`GENUINE_GRANTS`)와 **같은 모듈의 `WeakMap`**이므로, 권능의 실체에 닿는 방법은
 * 이 모듈이 발급한 **바로 그 객체 참조**를 들고 있는 것뿐이다 — 전개 사본 · 수제 객체 · `Proxy` ·
 * durable 문자열에서 재구성한 값은 전부 조회 자체가 실패한다. `typedExecution.ts`는 이름만 재수출한다.
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
  /** 이 권능을 발급한 kernel 인스턴스 자체(A2 — 다른 인스턴스는 이 권능으로 spawn할 수 없다). */
  issuer: KernelIssuer;
  executable: string;
  sha256: string;
  entrypoint: string;
  entrypointSha256: string;
  action: ControllerAction;
  planPath: string;
  timeoutMs: number;
  /** **정확히 한 번**만 false → true가 된다. 되돌리는 통로가 없다(재생 불가). */
  spent: boolean;
}

const GENUINE_LAUNCH_CAPABILITIES = new WeakMap<object, LaunchRecord>();

/**
 * `run_process` 권위 해석. **spawn하지 않고 grant도 소비하지 않는다**(3A 3차 리비전 A2) — 순수 minting이며
 * 몇 번을 불러도 상태를 만들지 않는다. 실제 실행은 `executeRunProcessOperation()` 하나뿐이고, 그것이
 * 여기서 발급한 권능을 **정확히 한 번** 소비한다(`B-F1` ①).
 */
export function resolveProcessLaunchCapability(op: TypedRunProcessOperation, handle: unknown): ProcessLaunchCapability {
  const { authority: auth, permitRecord } = dispatchFrom(handle, op);
  const approved = resolveApprovedOperation(op, auth);
  if (approved.kind !== "run_process") throw operationDenied("승인 레코드의 kind와 다르다");
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
    issuer: permitRecord.issuer,
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

/** `run_process` 집행 단계가 낼 수 있는 **안정 오류 코드 전부**(닫힌 목록 — 대장 `B-F1`). */
export const PROCESS_EFFECT_CODES = [
  /** 권능이 이 모듈 발급이 아니거나(구조적 위조·재구성·proxy) 이 grant/operation에 묶여 있지 않다. */
  "process_capability_invalid",
  /** 이미 소비된 권능을 다시 쓰려 했다(재생 — 되돌릴 통로가 없다). */
  "process_capability_spent",
  /** spawn 상한(task당 child 4 · depth 3 · run당 32)을 넘었다. **spawn 전에** 닫힌다. */
  "process_spawn_limit_exceeded",
  /** node·entrypoint가 spawn 직전 재검증에서 신뢰 조건을 잃었다(부재·symlink·권한·비일반 파일). */
  "process_executable_untrusted",
  /** **승인 시점과 spawn 시점 사이에 digest가 달라졌다**(교체된 바이너리·entrypoint). spawn 0. */
  "process_digest_mismatch",
  /** spawn 자체가 실패했다(플랫폼·exec). */
  "process_launch_failed",
  /** deadline·취소로 종료됐다 — 외부 효과는 일어났을 수 있으므로 성공 영수증이 없다. */
  "process_deadline_exceeded",
  /** **자손이 사라진 것을 확인하지 못했다.** 1차 오류에 가려지지 않는다(B1 계약). */
  "process_cleanup_unconfirmed",
] as const;
export type ProcessEffectCode = (typeof PROCESS_EFFECT_CODES)[number];

function processDenied(code: ProcessEffectCode, what: string): OrchestrationError {
  return new OrchestrationError(code, what);
}

/** 이 task가 지금까지 **연 `run_process` 수**(영수증 + 미확정 pending — durable에서만 센다). */
function launchedProcesses(task: OrchestrationTask): number {
  return (
    task.execution.operationReceipts.filter((r) => r.kind === "run_process").length +
    task.execution.pendingOperations.filter((p) => p.kind === "run_process").length
  );
}

/**
 * **spawn 상한을 spawn 전에 닫는다**(로드맵 §5: task당 child 4 · child depth 최대 3(root=0) ·
 * run당 프로세스 `maxProcessesPerRun`). 세는 근거는 **현재 durable state**뿐이라 재시작해도 상한이
 * 다시 열리지 않는다(in-memory 카운터를 만들지 않는 이유다). 지금 집행하려는 operation의 pending은
 * 이미 커밋돼 있으므로 이 수에 포함되고, 그래서 비교는 `>`다(4번째까지 허용, 5번째 거부).
 *
 * 아래 두 분기는 **도달 불가능한 최후 방어선**이다(`C-44`) — production 변경이나 hash chain 위조 없이는
 * red로 만들 수 없다. depth 4 task도, `maxTasksPerRun` 초과 state도 durable에 존재할 수 없다:
 * `requestSpawn`이 유일한 생성 경로이고 거기서 `depth_limit_exceeded`/`task_limit_exceeded`로 막으며,
 * `addTask`는 private이고 `open()`이 schema로 재검증한다. 실제로 집행되는 경계 검사는 그 아래
 * **task당 child**와 **run당 프로세스** 둘이며, 각각 자기 상수의 mutation으로 red가 확인됐다.
 */
function assertSpawnLimits(state: OrchestrationRunState, task: OrchestrationTask): void {
  if (task.depth > LIMITS.maxDepth) {
    throw processDenied("process_spawn_limit_exceeded", `child depth 상한은 ${LIMITS.maxDepth}이다`);
  }
  if (state.tasks.length > LIMITS.maxTasksPerRun) {
    throw processDenied("process_spawn_limit_exceeded", `run당 task는 ${LIMITS.maxTasksPerRun}개까지다`);
  }
  if (launchedProcesses(task) > LIMITS.maxChildrenPerTask) {
    throw processDenied("process_spawn_limit_exceeded", `task당 child는 ${LIMITS.maxChildrenPerTask}개까지다`);
  }
  let runTotal = 0;
  for (const t of state.tasks) runTotal += launchedProcesses(t);
  if (runTotal > LIMITS.maxProcessesPerRun) {
    throw processDenied("process_spawn_limit_exceeded", `run당 프로세스는 ${LIMITS.maxProcessesPerRun}개까지다`);
  }
}

/**
 * **spawn 직전 digest 재검증**(`B-F1` ④). 승인 시점이 아니라 **지금** node·entrypoint 두 파일을 각각
 * 한 번만 열어 정규 경로·비symlink·일반 파일·실행 비트·타인 쓰기 없음·**승인 digest 일치**를 본다
 * (`verifyApprovedExecutable`). 비교 대상은 **현재 durable manifest**이고, 권능 발급 시점에 적어 둔
 * digest와도 대조한다 → 승인과 spawn 사이에 manifest가 바뀌었든 파일이 바뀌었든 여기서 멈춘다.
 */
function verifyLaunchTargets(auth: DispatchAuthority, launch: LaunchRecord): { node: string; entrypoint: string } {
  const codes = {
    path: "process_executable_untrusted",
    invalid: "process_executable_untrusted",
    identity: "process_executable_untrusted",
    digest: "process_digest_mismatch",
  };
  const node = auth.manifest.executionAuthority.node;
  const entry = auth.manifest.executionAuthority.controllerEntrypoint;
  if (node.path !== launch.executable || node.sha256 !== launch.sha256) {
    throw processDenied("process_digest_mismatch", "승인된 node가 권능 발급 이후에 바뀌었다");
  }
  if (entry.path !== launch.entrypoint || entry.sha256 !== launch.entrypointSha256) {
    throw processDenied("process_digest_mismatch", "승인된 controller entrypoint가 권능 발급 이후에 바뀌었다");
  }
  verifyApprovedExecutable(node, "executionAuthority.node", codes);
  verifyApprovedExecutable(entry, "executionAuthority.controllerEntrypoint", codes);
  return { node: node.path, entrypoint: entry.path };
}

/**
 * **`run_process` operation 1건의 고정 집행 진입점 — 이 시스템의 첫 진짜 spawn**(대장 `B-F1` 개봉).
 *
 * `executeWriteFileOperation`과 **같은 순서**이고, 그 위에 프로세스에만 필요한 게이트가 얹힌다:
 *
 * 1. **권능을 정확히 한 번 소비한다**(`B-F1` ①). 살아 있는 `WeakMap` 조회이므로 위조·재구성·전개 사본은
 *    조회에서 죽고, `spent`는 되돌릴 통로가 없어 **재생으로 복구되지 않는다**. 발급 인스턴스(`issuer`)와
 *    grant의 발급 인스턴스를 `===`로 대조하고, 권능이 담은 run/task/attempt/turn/operation 신원이
 *    grant의 것과 전부 같아야 한다 → 다른 turn·다른 attempt의 권능을 끌어다 쓸 수 없다.
 * 2. 살아 있는 grant인가 · 아직 소진되지 않았는가 · **바로 이 operation**인가(`B-F1` ②).
 * 3. `authorityFromPermit`로 **현재 durable 상태를 다시 읽는다**(`B-F1` ③) — in-memory 스냅샷은
 *    권위가 아니다. 그 state로 spawn 상한을 닫는다(`process_spawn_limit_exceeded` — **효과 0 · 표시 0**).
 * 4. **`attemptedAt`을 durable하게 먼저 적고**(A4) grant를 다시 못 쓰게 막은 뒤,
 * 5. **표시 커밋 이후의 권위로만** 진행한다: durable state 재독 → node·entrypoint **digest 재검증**
 *    (`B-F1` ④) → 그 다음에야 spawn한다. 여기서 거부되면 **spawn 0 · 성공 영수증 0**이고, pending은
 *    보수적으로 attempted로 남아 `reconcileUncertainOperation()`의 `outcome_unknown`으로만 닫힌다.
 * 6. 정리 판정이 1차 오류를 이긴다(B1): 자손이 사라진 것을 **관측하지 못하면**
 *    `process_cleanup_unconfirmed`이며, deadline 오류보다 **먼저** 던진다.
 */
export async function executeRunProcessOperation(
  grant: unknown,
  op: TypedRunProcessOperation,
  capability: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<Readonly<OperationOutcome>> {
  // ① **권능 게이트가 가장 먼저다**: 재생 시도는 grant 상태에 가려지지 않고 자기 코드로 보고된다.
  const launch =
    typeof capability === "object" && capability !== null ? GENUINE_LAUNCH_CAPABILITIES.get(capability) : undefined;
  if (launch === undefined) {
    throw processDenied("process_capability_invalid", "실행 권능이 kernel 발급 값이 아니다");
  }
  if (launch.spent) {
    throw processDenied("process_capability_spent", "이미 소비된 실행 권능이다(재생 금지)");
  }

  // ② grant — write 경로와 같은 계약.
  const rec = genuineGrant(grant);
  if (rec.state !== "issued") {
    throw dispatchDenied("dispatch_grant_spent", "이미 소진된 execution grant다(중복 집행·재사용 금지)");
  }
  if ((rec.op as TypedOperation) !== (op as unknown as TypedOperation)) {
    throw dispatchDenied("dispatch_operation_unbound", "execution grant가 이 operation에 묶여 있지 않다");
  }
  if (rec.op.kind !== "run_process") {
    throw dispatchDenied("dispatch_operation_unbound", "이 진입점은 run_process operation 전용이다");
  }
  const cap = capability as ProcessLaunchCapability;
  if (
    launch.issuer !== rec.issuer ||
    cap.operationId !== op.operationId ||
    cap.authorityId !== op.authorityId ||
    cap.runId !== rec.permit.runId ||
    cap.taskId !== rec.permit.taskId ||
    cap.attemptId !== rec.permit.attemptId ||
    cap.turnId !== rec.permit.turnId
  ) {
    throw processDenied("process_capability_invalid", "실행 권능이 이 grant의 신원에 묶여 있지 않다");
  }

  // ③ 진입 자격 + durable state 재독. 여기서 거부되면 durable 표시조차 남지 않는다(거짓 불확실 0).
  {
    const entry = authorityFromPermit(rec.permit, rec.op);
    assertSpawnLimits(entry.permitRecord.readState(), entry.task);
  }

  // ④ **효과보다 먼저** 권능을 태우고 durable에 적는다. 순서가 계약이다.
  launch.spent = true;
  rec.markAttempted();
  rec.state = "errored";

  // ⑤ 표시 커밋 **이후의** 권위로만 집행한다(A4) — durable 재독이 여기서 한 번 더 일어난다.
  const { authority } = authorityFromPermit(rec.permit, rec.op);
  const approved = resolveApprovedOperation(op, authority);
  if (approved.kind !== "run_process") throw operationDenied("승인 레코드의 kind와 다르다");
  // spawn **직전** digest 재검증.
  const target = verifyLaunchTargets(authority, launch);
  const policy = authority.manifest.autopilotPolicy;

  const supervised = await superviseProcess({
    executable: target.node,
    args: [target.entrypoint, approved.action, approved.data.planPath],
    cwd: authority.workspaceRoot,
    timeoutMs: approved.timeoutMs,
    termGraceMs: policy.cleanupTermGraceMs,
    killGraceMs: policy.cleanupKillGraceMs,
    signal: options.signal,
  });

  // ⑥ **정리 미확인이 1차 오류를 이긴다**(B1).
  if (!supervised.cleanupConfirmed) {
    throw processDenied("process_cleanup_unconfirmed", "관리 프로세스의 자손이 사라진 것을 확인하지 못했다");
  }
  if (supervised.terminatedBy !== "exit") {
    throw processDenied("process_deadline_exceeded", `관리 프로세스를 ${supervised.terminatedBy}로 종료했다`);
  }

  rec.outcome = Object.freeze({
    marker: "applied" as const,
    path: null,
    resultSha256: null,
    exitCode: supervised.exitCode === null ? null : boundedExit(supervised.exitCode),
  });
  rec.state = "attempted";
  const handle: OperationOutcome = Object.freeze({
    operationId: rec.op.operationId,
    kind: rec.op.kind,
    authorityId: rec.op.authorityId,
    ...rec.outcome,
  });
  GENUINE_OUTCOMES.set(handle, rec);
  return handle;
}

// ── trusted Git (V3 M5c task 3D · 대장 `C-26`) ────────────────────────────────

/**
 * **하드 deny가 절대적이라는 것이 이 절의 설계를 전부 정한다.**
 * `AGENTS.md`의 hard deny(원격 저장소 직접 쓰기 · push · PR/merge 자동화 · production deploy ·
 * live billing)는 "부르지 않는다"가 아니라 **표현할 수 없다**여야 한다. 그래서 trusted Git은
 * `PROCESS_EFFECT_CODES`·`CONTROLLER_ACTIONS`와 같은 **닫힌 집합** 규율을 그대로 쓴다:
 *
 * - 호출자가 고를 수 있는 것은 `TRUSTED_GIT_QUERIES`의 **enum 값 하나**뿐이다.
 * - 그 enum이 가리키는 **argv 배열은 동결된 상수**다. 브랜치·경로·메시지·remote·refspec을
 *   담을 **필드가 존재하지 않으므로** 인자 주입도 원격 조작도 표현할 수 없다.
 * - 집행기는 spawn 직전에 `spec.mutates`가 false임을 **다시 단정**한다. 변경 계열 git을 이 표에
 *   추가하는 것만으로는 실행되지 않는다 — durable pending(A4 mark) 계약을 먼저 갖춰야 한다.
 *
 * **왜 등록부와 집행기가 kernel 모듈 안에 있는가**: Task 3C 선례(`DECISIONS.md` 2026-08-04) 그대로다.
 * 소비자가 kernel 밖에 살면 권능은 **공개 함수의 인자**가 되고, 그 형태가 A3가 삭제한
 * `writeFileEffect.ts` 구멍이다. 두 번째 패턴을 만들지 않는다.
 *
 * **왜 stdout을 읽지 않는가**: 실제 spawn은 `managedProcess.superviseProcess` 하나뿐이고(두 번째 spawn
 * 경로를 만들지 않는다 — 자손 정리·deadline·취소가 거기 붙어 있다) 그 감독자는 `stdio: "ignore"`다.
 * 그래서 닫힌 집합은 **종료 코드로 답하는 술어 질의**만 담는다. 종료 코드 → 판정도 질의마다 닫혀 있고,
 * 표에 없는 코드는 성공이 아니라 `git_result_unknown`이다(결과를 지어내지 않는다).
 */
export const TRUSTED_GIT_QUERIES = ["repo_has_head", "worktree_tracked_clean", "index_clean"] as const;
export type TrustedGitQuery = (typeof TRUSTED_GIT_QUERIES)[number];

interface TrustedGitSpec {
  /** **동결된 argv 상수.** 호출자 문자열이 여기에 들어오는 통로가 없다(shell도 보간도 없다). */
  readonly args: readonly string[];
  /** 저장소를 바꾸는가. 닫힌 집합은 **전부 false**이고 집행기가 spawn 직전에 다시 단정한다. */
  readonly mutates: boolean;
  /** 종료 코드 → 판정. **여기 없는 코드는 성공이 아니다.** */
  readonly verdicts: Readonly<Record<number, boolean>>;
}

/**
 * 모든 질의에 붙는 고정 전치 인자. 사용자·시스템 config가 **프로그램을 실행하게 만드는 축**을 끈다
 * (fsmonitor hook · hooksPath · external diff · textconv). `HOME`은 `MANAGED_PROCESS_ENV`에 없으므로
 * `~/.gitconfig`는 애초에 읽히지 않고, `GIT_DIR`/`GIT_WORK_TREE` 등 `GIT_*`도 상속되지 않는다.
 */
const TRUSTED_GIT_PREFIX: readonly string[] = Object.freeze([
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "--no-optional-locks",
  "--no-pager",
]);

const CLEAN_VERDICTS: Readonly<Record<number, boolean>> = Object.freeze({ 0: true, 1: false });

/**
 * **허용된 git 호출 전부**(닫힌 allow-list — 여기 없는 것은 `git_query_unsupported`로 거부된다).
 * 셋 다 **로컬 · 읽기 전용 · 네트워크 0**이다: 원격을 이름으로도 refspec으로도 담을 수 없고,
 * `fetch`/`pull`/`push`/`remote`/`submodule`/`clone`/`merge`/`rebase`/`commit`/`tag`는 표에 없다.
 */
const TRUSTED_GIT_SPECS: Readonly<Record<TrustedGitQuery, TrustedGitSpec>> = Object.freeze({
  /** HEAD가 실제 커밋으로 풀리는가(0) / unborn 브랜치인가(1). */
  repo_has_head: Object.freeze({
    args: Object.freeze([...TRUSTED_GIT_PREFIX, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    mutates: false,
    verdicts: CLEAN_VERDICTS,
  }),
  /** 추적 파일이 HEAD와 같은가(0 = clean) / 다른가(1). */
  worktree_tracked_clean: Object.freeze({
    args: Object.freeze([...TRUSTED_GIT_PREFIX, "diff", "--no-ext-diff", "--no-textconv", "--quiet", "HEAD", "--"]),
    mutates: false,
    verdicts: CLEAN_VERDICTS,
  }),
  /** index가 HEAD와 같은가(0 = staged 변경 없음) / 다른가(1). */
  index_clean: Object.freeze({
    args: Object.freeze([
      ...TRUSTED_GIT_PREFIX,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--quiet",
      "--cached",
      "HEAD",
      "--",
    ]),
    mutates: false,
    verdicts: CLEAN_VERDICTS,
  }),
});

/** git 질의 1건의 wall deadline. 승인 정책이 고를 값이 아니다(질의는 상수 작업량이다). */
const TRUSTED_GIT_TIMEOUT_MS = 30_000;

/** trusted Git이 낼 수 있는 **안정 오류 코드 전부**(닫힌 목록). */
export const TRUSTED_GIT_CODES = [
  /** 권능이 kernel 발급 값이 아니거나(구조적 위조·전개 사본·proxy) 발급 인스턴스에서 이미 회수됐다. */
  "git_capability_invalid",
  /** 이미 소비된 권능을 다시 쓰려 했다(재생 — 되돌릴 통로가 없다). */
  "git_capability_spent",
  /** 닫힌 allow-list 밖의 질의다. */
  "git_query_unsupported",
  /** 변경 계열 git이다 — durable pending(A4) 계약 없이는 **구조적으로** 실행되지 않는다. */
  "git_mutation_unsupported",
  /** task가 지금 `running`이 아니다. */
  "git_task_not_running",
  /** 권능 발급 이후 durable 신원·승인이 바뀌었다(attempt 교체 · manifest digest drift · 만료 · 시계). */
  "git_authority_stale",
  /** 승인된 git 실행 파일이 spawn 직전 재검증에서 신뢰 조건을 잃었다(부재·symlink·권한·비일반 파일). */
  "git_executable_untrusted",
  /** 승인 시점과 spawn 시점 사이에 git 바이너리 digest가 달라졌다. spawn 0. */
  "git_digest_mismatch",
  /** 대상 디렉터리가 **승인된 저장소 루트 그 자체**임을 확인하지 못했다(상위 repo · symlink 탈출 · 비 repo). */
  "git_repo_identity_mismatch",
  /** spawn 자체가 실패했다. */
  "git_launch_failed",
  /** deadline·취소로 종료됐다 — 판정을 만들지 않는다. */
  "git_deadline_exceeded",
  /** **자손이 사라진 것을 확인하지 못했다.** 1차 오류에 가려지지 않는다(B1 계약). */
  "git_cleanup_unconfirmed",
  /** 닫힌 판정표에 없는 종료 코드다(비정상 종료 포함). 성공으로 접지 않는다. */
  "git_result_unknown",
] as const;
export type TrustedGitCode = (typeof TRUSTED_GIT_CODES)[number];

function gitDenied(code: TrustedGitCode, what: string): OrchestrationError {
  return new OrchestrationError(code, what);
}

/**
 * **봉인된 일회용 git 권능.** 담긴 필드는 감사용이고 권위는 등록부 연결에서만 나온다 —
 * 전개 사본 · 수제 객체 · `Proxy` · durable 문자열에서 재구성한 값은 조회 자체가 실패한다.
 */
export interface TrustedGitCapability {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly query: TrustedGitQuery;
}

/** 권능 뒤의 실제 실행 명세(모듈 사설 — 밖으로 나가는 통로가 없다). */
interface TrustedGitRecord {
  /** 발급 kernel 인스턴스 자체(A2 — 다른 인스턴스는 이 권능으로 git을 돌릴 수 없다). */
  issuer: KernelIssuer;
  /** **현재** durable state를 읽는다(공개·override 가능 메서드가 아니라 `#state`를 직접 읽는 클로저). */
  readState: () => OrchestrationRunState;
  now: () => string;
  repoRoot: string;
  runId: string;
  taskId: string;
  attemptId: string;
  /** 발급 시점 승인 manifest의 canonical digest. */
  approvalDigest: string;
  query: TrustedGitQuery;
  executable: string;
  sha256: string;
  termGraceMs: number;
  killGraceMs: number;
  /** **정확히 한 번**만 false → true가 된다. 되돌리는 통로가 없다. */
  spent: boolean;
}

const GENUINE_GIT_CAPABILITIES = new WeakMap<object, TrustedGitRecord>();

/**
 * **살아 있는 권능 등록부**(`LIVE_GRANTS`와 같은 모양). 발급 인스턴스별로 갈라져 있으므로
 * 같은 workspace를 두 번 열어도 첫 인스턴스가 발급한 권능은 두 번째에서 **소비되지 않는다**.
 */
const LIVE_GIT_CAPABILITIES = new WeakMap<KernelIssuer, Set<TrustedGitRecord>>();

function liveGitOf(issuer: KernelIssuer): Set<TrustedGitRecord> {
  let live = LIVE_GIT_CAPABILITIES.get(issuer);
  if (live === undefined) {
    live = new Set();
    LIVE_GIT_CAPABILITIES.set(issuer, live);
  }
  return live;
}

/**
 * **대상이 승인된 저장소 루트 그 자체인가.** 상위 저장소의 하위 디렉터리 · symlink 탈출 · 저장소가
 * 아닌 디렉터리를 전부 거부한다. git에게 물어보지 않는다(그러려면 stdout이 필요하고, 무엇보다 판정을
 * **spawn 이전에** 끝내야 한다).
 *
 * - `realpath`가 경로 그대로여야 한다 → 어떤 구성요소도 symlink가 아니다.
 * - 그 자리에 `.git`이 있어야 한다 → **상위 repo의 하위 디렉터리는 여기서 죽는다**(하위 디렉터리에는
 *   `.git`이 없다). 디렉터리(주 checkout)이거나 일반 파일(linked worktree의 gitdir 포인터)이면 되고
 *   **symlink면 거부**한다.
 */
function verifyApprovedRepoRoot(root: string): void {
  if (!isAbsolute(root) || root.includes("\0")) {
    throw gitDenied("git_repo_identity_mismatch", "승인된 저장소 루트가 NUL 없는 절대경로가 아니다");
  }
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw gitDenied("git_repo_identity_mismatch", "저장소 루트의 realpath를 확인할 수 없다");
  }
  if (real !== root) {
    throw gitDenied("git_repo_identity_mismatch", "저장소 루트가 정규 경로가 아니다(symlink 탈출)");
  }
  let rootStat: Stats;
  let dotGit: Stats;
  try {
    rootStat = lstatSync(root);
    dotGit = lstatSync(joinPath(root, ".git"));
  } catch {
    throw gitDenied("git_repo_identity_mismatch", "저장소 루트에 .git이 없다(상위 저장소의 하위 디렉터리일 수 있다)");
  }
  if (!rootStat.isDirectory()) {
    throw gitDenied("git_repo_identity_mismatch", "저장소 루트가 디렉터리가 아니다");
  }
  if (!dotGit.isDirectory() && !dotGit.isFile()) {
    throw gitDenied("git_repo_identity_mismatch", ".git이 디렉터리도 일반 파일도 아니다");
  }
}

/**
 * 권능 소비 시점의 **현재 durable 권위**를 다시 읽는다(스냅샷은 권위가 아니다).
 * 표시 이전과 이후에 **같은 함수**로 두 번 부른다(A4).
 */
function readTrustedGitAuthority(rec: TrustedGitRecord): MilestoneApprovalManifest {
  const state = rec.readState();
  const now = rec.now();
  if (state.runId !== rec.runId) throw gitDenied("git_authority_stale", "run 신원이 권능과 다르다");
  if (now < state.createdAt || now < state.updatedAt) {
    throw gitDenied("git_authority_stale", "시계가 durable 기록보다 이르다");
  }
  if (now >= state.manifest.expiresAt) throw gitDenied("git_authority_stale", "승인 manifest가 만료됐다");
  if (manifestDigest(state.manifest) !== state.accounting.approvalDigest) {
    throw gitDenied("git_authority_stale", "승인 manifest digest가 durable 회계와 다르다");
  }
  if (state.accounting.approvalDigest !== rec.approvalDigest) {
    throw gitDenied("git_authority_stale", "권능 발급 이후 승인이 바뀌었다");
  }
  const task = state.tasks.find((t) => t.taskId === rec.taskId);
  if (task === undefined) throw gitDenied("git_authority_stale", "권능의 task가 durable state에 없다");
  if (task.state !== "running") throw gitDenied("git_task_not_running", "task가 running이 아니다");
  if (task.execution.attemptId !== rec.attemptId) {
    throw gitDenied("git_authority_stale", "durable attempt 신원이 권능과 다르다");
  }
  return state.manifest;
}

/** trusted Git 질의 1건의 결과(불투명 · 동결 · 호출자가 만들 수 없다). */
export interface TrustedGitResult {
  readonly query: TrustedGitQuery;
  /** 닫힌 판정표가 이 종료 코드에 부여한 답. */
  readonly verdict: boolean;
  readonly exitCode: number;
}

/**
 * **승인된 로컬 git 질의 1건의 고정 집행 진입점**(대장 `C-26`).
 *
 * `executeRunProcessOperation`과 **같은 순서**다:
 * 1. 권능이 kernel 발급이고 **발급 인스턴스에서 아직 살아 있는가** · 아직 소비되지 않았는가.
 * 2. **현재 durable 상태를 다시 읽어** 만료·승인 digest·task lifecycle·attempt 신원을 확인한다
 *    (여기서 거부되면 권능은 아직 소비되지 않았다 — 거짓 소진 0).
 * 3. 닫힌 allow-list 조회 + **`mutates === false` 단정**.
 * 4. **효과보다 먼저 권능을 태운다**(1회 소비). 되돌릴 통로가 없다.
 * 5. **소진 이후에 권위를 다시 전수 확인한다**(A4 mark-then-re-verify) → 그 다음에야
 *    **spawn 직전** git 바이너리 digest 재검증 + 저장소 신원 재검증 → spawn.
 * 6. 정리 미확인이 1차 오류를 이긴다(B1). deadline·취소·표 밖 종료 코드는 **판정을 만들지 않는다**.
 *
 * durable pending(A4의 `attemptedAt` 표시)이 없는 이유는 정직하게 하나다: **닫힌 집합의 모든 질의가
 * 외부 효과 0**이라 "일어났는지 모르는 효과"가 존재하지 않는다. 그래서 미확정 구간을 durable에 남길
 * 것이 없고, 실패는 전부 그냥 거부다. 변경 계열을 열려면 durable pending 계약이 **먼저** 필요하며,
 * 그것을 잊지 못하도록 ③의 `mutates` 단정이 spawn 앞을 막고 있다.
 */
export async function executeTrustedGitQuery(
  capability: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<Readonly<TrustedGitResult>> {
  // ① 권능 게이트.
  const rec =
    typeof capability === "object" && capability !== null ? GENUINE_GIT_CAPABILITIES.get(capability) : undefined;
  if (rec === undefined) throw gitDenied("git_capability_invalid", "git 권능이 kernel 발급 값이 아니다");
  if (rec.spent) throw gitDenied("git_capability_spent", "이미 소비된 git 권능이다(재생 금지)");
  if (!liveGitOf(rec.issuer).has(rec)) {
    throw gitDenied("git_capability_invalid", "이 권능은 발급 인스턴스에서 더 이상 살아 있지 않다");
  }

  // ② 진입 자격 — durable 재독.
  readTrustedGitAuthority(rec);

  // ③ 닫힌 allow-list + 변경 금지 단정.
  const spec = Object.prototype.hasOwnProperty.call(TRUSTED_GIT_SPECS, rec.query)
    ? TRUSTED_GIT_SPECS[rec.query]
    : undefined;
  if (spec === undefined) throw gitDenied("git_query_unsupported", "닫힌 allow-list 밖의 git 질의다");
  if (spec.mutates) {
    throw gitDenied("git_mutation_unsupported", "변경 계열 git은 durable pending 계약 없이 집행하지 않는다");
  }

  // ④ **효과보다 먼저** 권능을 태운다.
  rec.spent = true;
  liveGitOf(rec.issuer).delete(rec);

  // ⑤ 소진 **이후의** 권위로만 집행한다(A4).
  const manifest = readTrustedGitAuthority(rec);
  const approved = manifest.executionAuthority.git;
  if (approved.path !== rec.executable || approved.sha256 !== rec.sha256) {
    throw gitDenied("git_digest_mismatch", "승인된 git이 권능 발급 이후에 바뀌었다");
  }
  // spawn **직전** 바이너리 재검증 + 저장소 신원 재검증.
  verifyApprovedExecutable(approved, "executionAuthority.git", {
    path: "git_executable_untrusted",
    invalid: "git_executable_untrusted",
    identity: "git_executable_untrusted",
    digest: "git_digest_mismatch",
  });
  verifyApprovedRepoRoot(rec.repoRoot);

  let supervised;
  try {
    supervised = await superviseProcess({
      executable: approved.path,
      // **argv 상수 그대로**다 — 호출자 문자열도 shell도 보간도 없다.
      args: spec.args,
      cwd: rec.repoRoot,
      timeoutMs: TRUSTED_GIT_TIMEOUT_MS,
      termGraceMs: rec.termGraceMs,
      killGraceMs: rec.killGraceMs,
      signal: options.signal,
    });
  } catch {
    throw gitDenied("git_launch_failed", "git 프로세스를 시작할 수 없다");
  }

  // ⑥ 정리 미확인이 1차 오류를 이긴다(B1).
  if (!supervised.cleanupConfirmed) {
    throw gitDenied("git_cleanup_unconfirmed", "git 프로세스의 자손이 사라진 것을 확인하지 못했다");
  }
  if (supervised.terminatedBy !== "exit") {
    throw gitDenied("git_deadline_exceeded", `git 프로세스를 ${supervised.terminatedBy}로 종료했다`);
  }
  const exitCode = supervised.exitCode;
  if (exitCode === null || !Object.prototype.hasOwnProperty.call(spec.verdicts, exitCode)) {
    throw gitDenied("git_result_unknown", "닫힌 판정표에 없는 종료 코드다");
  }
  return Object.freeze({ query: rec.query, verdict: spec.verdicts[exitCode]!, exitCode });
}

/** 이 모듈이 발급한 진짜 git 권능인가(테스트·감사용 판정 — 실행 명세는 돌려주지 않는다). */
export function isGenuineTrustedGitCapability(v: unknown): boolean {
  return typeof v === "object" && v !== null && GENUINE_GIT_CAPABILITIES.has(v);
}

/**
 * 새 일회용 grant 하나(등록부에만 권위가 있다 — 담긴 필드는 감사용이다).
 * 같은 durable pending 신원의 **이전 grant는 그 자리에서 폐기**된다(A2 — live/live 중복 금지).
 */
function newGrant(
  issuer: KernelIssuer,
  permit: OperationDispatchPermit,
  op: TypedOperation,
  operationId: string,
  planDigest: string,
  markAttempted: () => void,
): OperationExecutionGrant {
  const pendingKey = pendingKeyOf(permit, planDigest, operationId);
  const live = liveGrantsOf(issuer);
  const previous = live.get(pendingKey);
  if (previous !== undefined) previous.state = "consumed";
  const grant: OperationExecutionGrant = Object.freeze({
    runId: permit.runId,
    taskId: permit.taskId,
    attemptId: permit.attemptId,
    turnId: permit.turnId,
    operationId,
  });
  const record: GrantRecord = { issuer, permit, op, state: "issued", pendingKey, outcome: null, markAttempted };
  GENUINE_GRANTS.set(grant, record);
  live.set(pendingKey, record);
  return grant;
}

/**
 * durable pending 신원 하나에 살아 있는 grant가 있으면 그 자리에서 폐기한다(정합화 뒤 재사용 차단).
 * **발급 인스턴스 안에서만** 찾는다 — 같은 durable ID를 쓰는 다른 workspace의 grant는 건드리지 않는다(A2).
 */
function killLiveGrant(issuer: KernelIssuer, pendingKey: string): void {
  const live = liveGrantsOf(issuer);
  const rec = live.get(pendingKey);
  if (rec === undefined) return;
  rec.state = "consumed";
  live.delete(pendingKey);
}

/** grant를 최종 소비한다(영수증·실패 종결 뒤 — 같은 key가 무한히 쌓이지 않게 등록부에서도 뺀다). */
function consumeGrant(rec: GrantRecord): void {
  rec.state = "consumed";
  const live = liveGrantsOf(rec.issuer);
  if (live.get(rec.pendingKey) === rec) live.delete(rec.pendingKey);
}

/**
 * 이 모듈이 발급한 진짜 permit인가(구조적 위조·재구성·proxy 거부).
 * `issuer`를 주면 **그 인스턴스가 발급한 것인지도** 본다(A2 — 형제 kernel/두 번째 workspace 거부).
 */
function genuinePermit(permit: unknown, issuer?: KernelIssuer): { permit: OperationDispatchPermit; record: PermitRecord } {
  if (typeof permit !== "object" || permit === null) {
    throw new OrchestrationError("dispatch_permit_invalid", "dispatch permit이 kernel 발급 값이 아니다");
  }
  const record = GENUINE_PERMITS.get(permit);
  if (record === undefined) {
    throw new OrchestrationError("dispatch_permit_invalid", "dispatch permit이 kernel 발급 값이 아니다");
  }
  if (issuer !== undefined && record.issuer !== issuer) {
    throw new OrchestrationError("dispatch_permit_invalid", "dispatch permit이 이 kernel 인스턴스의 발급 값이 아니다");
  }
  return { permit: permit as OperationDispatchPermit, record };
}

/** 같은 규칙의 grant 판정. `issuer`를 주면 발급 인스턴스까지 대조한다(A2). */
function genuineGrant(grant: unknown, issuer?: KernelIssuer): GrantRecord {
  if (typeof grant !== "object" || grant === null) {
    throw dispatchDenied("dispatch_grant_invalid", "execution grant가 kernel 발급 값이 아니다");
  }
  const rec = GENUINE_GRANTS.get(grant);
  if (rec === undefined) {
    throw dispatchDenied("dispatch_grant_invalid", "execution grant가 kernel 발급 값이 아니다");
  }
  if (issuer !== undefined && rec.issuer !== issuer) {
    throw dispatchDenied("dispatch_grant_invalid", "execution grant가 이 kernel 인스턴스의 발급 값이 아니다");
  }
  return rec;
}

/**
 * **영수증 정합화가 가능한 task**(3A 3차 리비전 A3 — safety-only).
 *
 * 효과 게이트(`requireDispatchableTask`)와 달리 만료·예산·wall·no-progress·preflight drift를 보지 **않는다**:
 * 이미 일어난 효과를 durable에 적는 일을 그런 이유로 막으면, 그 pending은 어떤 전이로도 닫히지 않는
 * **미아**가 되고 이후 preflight·resume이 그것을 조용히 지운다. 대신 **신원은 전수 확인**하고 상태는
 * `running`|`cleaning`만 허용한다(그 밖의 상태로 가는 전이는 애초에 pending을 남기지 못한다).
 */
function requireReconcilableTask(state: OrchestrationRunState, bound: OperationDispatchPermit): OrchestrationTask {
  if (state.runId !== bound.runId) {
    throw dispatchDenied("dispatch_identity_stale", "permit의 run 신원이 현재 durable run과 다르다");
  }
  const task = state.tasks.find((t) => t.taskId === bound.taskId);
  if (task === undefined) {
    throw dispatchDenied("dispatch_identity_stale", "permit의 task가 현재 durable state에 없다");
  }
  if (task.state !== "running" && task.state !== "cleaning") {
    throw dispatchDenied("dispatch_task_not_running", `영수증 정합화는 running|cleaning task만 가능하다 (현재 ${task.state})`);
  }
  if (task.execution.attemptId !== bound.attemptId) {
    throw dispatchDenied("dispatch_identity_stale", "durable attempt 신원이 permit과 다르다");
  }
  return task;
}

/**
 * **미확정 operation을 남긴 채 attempt를 떠나거나 리셋하지 않는다**(3A 3차 리비전 A3).
 * 이 하나를 attempt를 떠나는 전이 전부(preflight·pause·resume·settle)가 지나므로 우회로가 없다.
 */
function assertNoPendingOperations(task: OrchestrationTask, what: string): void {
  if (task.execution.pendingOperations.length > 0) {
    throw new OrchestrationError(
      "operation_pending_unreconciled",
      `${what}: 정합화되지 않은 typed operation이 남아 있다 (${task.taskId}) — 영수증을 먼저 커밋해야 한다`,
    );
  }
}

/**
 * **열린 dispatch claim이 끝났는가**(3A 3차 리비전 A1) = 그 turn이 durable하게 **과금됐고** 미확정
 * operation이 **하나도 없다**.
 *
 * 이전 판은 "과금 = turn 닫기"였다. 그런데 A1이 요구하는 순서는 **과금 → grant → 효과**이므로 과금 시점에
 * 닫으면 바로 그 계획의 grant가 죽는다. 그래서 닫기를 **지연**한다: claim은 살아 있고, **다음 turn이
 * permit을 요청할 때** 이 판정으로 교체된다. 아직 과금되지 않았거나 미확정 operation이 남은 claim은
 * 여전히 다른 turn을 막는다(경쟁 turn 차단은 그대로다).
 *
 * 이 방식이라면 operation 0건인 turn도, 계획의 일부만 집행한 turn도 교착되지 않는다 — "무엇을 몇 건
 * 집행할 것인가"를 durable에 미리 적어 둘 필요가 없다.
 *
 * **정산 권위는 이 task 자신의 진짜 과금 증거다**(3A 5차 리비전 A1). 4차 판은 run 전역
 * `accounting.chargedTurnIds`에 그 turn ID가 **있기만 하면** 정산된 것으로 봤다 → claim이 없는 sibling이
 * 생산 task의 claim된 turn ID를 0 토큰으로 과금하면 ⓐ 생산 task의 **진짜 사용량은 영구히 과금되지 못하고**
 * (`turn_already_charged`) ⓑ 그 거짓 정산 위에서 **다음 turn이 claim을 교체**할 수 있었다(독립 리뷰 A-1).
 * 지금 보는 것은 `execution.turnId`(이 task가 마지막으로 과금한 turn) + `execution.chargedPlanDigest`
 * (**kernel 발급 permit으로** 과금했다는 canonical 증거)이며, 둘 다 claim된 turn·계획과 일치해야 한다 →
 * 정산은 **정확히 이 run/task/attempt/turn/계획**의 진짜 과금에서만 나온다.
 */
function dispatchTurnSettled(task: OrchestrationTask): boolean {
  const open = task.execution.dispatchTurnId;
  if (open === null) return true;
  return (
    task.execution.turnId === open &&
    task.execution.chargedPlanDigest !== null &&
    task.execution.chargedPlanDigest === task.execution.dispatchPlanDigest &&
    !task.execution.pendingOperations.some((p) => p.turnId === open)
  );
}

/**
 * **turn ID는 run 전역에서 한 task만 claim한다**(3A 6차 리비전 A1).
 *
 * 5차 판은 대상 task의 claim과 run 전역 `accounting.chargedTurnIds`만 봤다 → task A가 turn X를 claim한
 * 상태에서 task B도 같은 X를 genuine permit으로 claim할 수 있었고(둘 다 진짜 permit), B가 먼저 과금하면
 * A의 진짜 과금이 `turn_already_charged`로 막혀 A는 task-local 과금 증거를 영영 얻지 못한다 →
 * `dispatchTurnSettled(A)`는 영구히 false, A의 claim은 교체도 정산도 되지 않는다(task·run 교착).
 * 과금 namespace가 run 전역이므로 **claim namespace도 run 전역**이어야 한다. 여기서 fail closed한다.
 *
 * (끝난 남의 claim은 여기 오기 전에 `turn_already_charged`로 걸린다 — 정산은 과금을 뜻하기 때문이다.)
 */
function assertTurnClaimableBy(state: OrchestrationRunState, taskId: string, turnId: string): void {
  const other = state.tasks.find((t) => t.taskId !== taskId && t.execution.dispatchTurnId === turnId);
  if (other !== undefined) {
    throw new OrchestrationError(
      "turn_conflict",
      `turn ${turnId}은 이미 task ${other.taskId}가 durable하게 claim했다 — 두 task가 같은 turn을 claim할 수 없다`,
    );
  }
}

/** durable pending 레코드가 이 grant의 신원과 정확히 맞는가(낡은 attempt·다른 turn·다른 계획 거부). */
function requirePendingOperation(
  task: OrchestrationTask,
  permit: OperationDispatchPermit,
  planDigest: string,
  operationId: string,
): PendingOperation {
  const pending = task.execution.pendingOperations.find((p) => p.operationId === operationId);
  if (pending === undefined) {
    throw dispatchDenied("dispatch_operation_unregistered", "집행 전 durable pending 레코드가 없다");
  }
  if (pending.attemptId !== permit.attemptId || pending.turnId !== permit.turnId || pending.planDigest !== planDigest) {
    throw dispatchDenied("dispatch_operation_unregistered", "durable pending 레코드가 이 attempt/turn/계획의 것이 아니다");
  }
  return pending;
}

/**
 * **집행 경계에 들어간 pending은 다시 열리지도, 평범한 실패로 닫히지도 않는다**(3A 4차 리비전 A2).
 * 외부 효과가 일어났을 수 있으므로 "일어나지 않았다"고 단정하는 종결을 허용하면 durable 기록이 거짓이 된다.
 */
function assertNotAttempted(pending: PendingOperation): void {
  if (pending.attemptedAt !== null) {
    throw new OrchestrationError(
      "operation_attempt_uncertain",
      `operation ${pending.operationId}은 이미 집행 경계에 들어갔다 — 재발급·평범한 실패 종결이 아니라 정합화(outcome_unknown)로만 닫힌다`,
    );
  }
}

/**
 * permit 하나에서 **현재 durable 상태**를 다시 읽어 집행 권위를 만든다(부수 효과 0).
 * 반환하는 `task`는 kernel 내부 state의 참조이므로 **읽기에만** 쓴다(밖으로 나가는 것은 동결 사본이다).
 */
function authorityFromPermit(
  permit: unknown,
  op: TypedOperation,
): { authority: Readonly<DispatchAuthority>; task: OrchestrationTask; permitRecord: PermitRecord } {
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
  const task = requireDispatchableTask(state, bound, record, now);

  return {
    authority: Object.freeze({
      workspaceRoot: record.workspaceRoot,
      // **현재 durable state의 manifest 사본.** 내부 참조를 그대로 내보내면 집행기가 kernel state를
      // 만질 수 있게 되므로 여기서 자른다(읽기는 `#state`에서, 반환은 사본에서).
      manifest: clone(state.manifest),
      runId: state.runId,
      taskId: task.taskId,
      attemptId: bound.attemptId,
      turnId: bound.turnId,
      ownership: Object.freeze([...task.ownership]),
      nowIso: now,
    }),
    task,
    permitRecord: record,
  };
}

/**
 * **집행 자격 판정 전부**(3A 2차 리비전 A1). 여기서 보는 것은 전부 **현재 durable state**다 —
 * `readState()`는 `#state` private 필드를 직접 읽으므로 공개 메서드를 monkey-patch해도 옛 스냅샷을
 * 되살릴 수 없다.
 */
function requireDispatchableTask(
  state: OrchestrationRunState,
  bound: OperationDispatchPermit,
  record: PermitRecord,
  now: string,
): OrchestrationTask {
  // **시계는 durable 진실에 대해 단조여야 한다**(3A 3차 리비전 A1). run 시작만 보면 시작 이후 어느
  // 시점으로든 되돌릴 수 있어 attempt wall·no-progress 창이 다시 열린다 — `updatedAt`은 마지막 커밋
  // 시각이므로 `phaseStartedAt`·`lastProgressAt`을 포함한 **모든 durable 시각의 상한**이다.
  if (now < state.createdAt || now < state.accounting.budgetStartedAt || now < state.updatedAt) {
    throw dispatchDenied("clock_invalid", "집행 시각이 durable 기록보다 이르다(시계 역행)");
  }
  // **경계 포함으로 닫는다**(로드맵 §8.1 — 전진 작업은 `now >= expiresAt`에서 전부 거부).
  if (now >= state.manifest.expiresAt) {
    throw dispatchDenied("manifest_expired", "승인 manifest가 만료됐다(전진 작업 금지)");
  }
  if (now >= state.accounting.budgetDeadlineAt) {
    throw dispatchDenied("budget_elapsed_exhausted", "승인된 경과 예산 deadline을 넘었다");
  }
  // **토큰 예산도 등호에서 닫는다**: 이미 승인 상한을 다 쓴 run은 더 이상 효과를 내지 않는다.
  if (state.manifest.maxTokens !== null && state.accounting.tokensUsed >= state.manifest.maxTokens) {
    throw dispatchDenied("budget_tokens_exhausted", "승인된 토큰 예산을 다 썼다");
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
  // **turn은 durable하게 claim된 것 하나뿐이다**(A1): permit 발급이 커밋으로 claim했으므로 여기서는
  // "지금도 그 turn이 열려 있는가"만 본다. null(닫힘)·다른 turn은 전부 거부다.
  if (task.execution.dispatchTurnId !== bound.turnId) {
    throw dispatchDenied("dispatch_identity_stale", "durable하게 claim된 dispatch turn이 permit과 다르다");
  }
  if (task.execution.dispatchPlanDigest !== record.planDigest) {
    throw dispatchDenied("dispatch_plan_conflict", "이 turn에 durable하게 claim된 계획이 아니다");
  }
  // **계획을 만든 turn이 먼저 durable하게 과금돼 있어야 한다**(3A 3차 리비전 A1). 이 확인이 없으면 위
  // 토큰 판정이 **항상 한 turn 뒤처진 값**을 보므로, 상한 직전에서 그 turn이 얼마를 태웠든 효과가 나간다.
  //
  // **증거는 이 task 자신의 것이어야 한다**(3A 4차 리비전 A1). 이전 판은 run 전역
  // `accounting.chargedTurnIds`에 그 turn ID가 **있기만 하면** 통과시켰다 → claim이 없는 sibling task가
  // 생산 task의 bare turn ID를 0 토큰으로 과금해 남의 효과를 승인할 수 있었다. 지금 보는 것은
  // ⓐ `execution.turnId`(= 이 task가 마지막으로 과금한 turn)와 ⓑ `execution.chargedPlanDigest`
  // (= **kernel 발급 permit으로** 과금했다는 canonical 증거)다. 위에서 attempt·claim된 turn·계획 digest를
  // 이미 확인했으므로, 이 둘이 맞으면 과금은 **정확히 이 run/task/attempt/turn/계획**에 묶여 있다.
  if (task.execution.turnId !== bound.turnId || task.execution.chargedPlanDigest !== record.planDigest) {
    throw dispatchDenied(
      "budget_turn_unaccounted",
      "이 task가 이 계획의 turn을 kernel 발급 권위로 과금하지 않았다(권위 과금 → grant → 효과 순서다)",
    );
  }
  // **attempt wall deadline과 no-progress deadline도 효과 직전마다 본다**(경계 포함).
  if (task.execution.wallDeadlineAt !== null && now >= task.execution.wallDeadlineAt) {
    throw dispatchDenied("attempt_wall_exhausted", "이 attempt의 wall deadline을 넘었다");
  }
  const progressBase = task.execution.lastProgressAt ?? task.execution.phaseStartedAt;
  if (progressBase !== null && now >= addMs(progressBase, state.manifest.autopilotPolicy.maxNoProgressMs)) {
    throw dispatchDenied("no_progress_exhausted", "인정되는 진행 없이 no-progress deadline을 넘었다");
  }
  if (task.execution.preflightDigest !== record.preflightDigest || preflightDigest(state, task) !== record.preflightDigest) {
    throw dispatchDenied("preflight_drift", "승인·예산·ownership·자원·권위가 preflight 봉인 이후에 바뀌었다");
  }
  if (manifestDigest(state.manifest) !== state.accounting.approvalDigest) {
    throw dispatchDenied("preflight_drift", "현재 manifest가 durable 승인 digest와 다르다");
  }
  return task;
}

// ── write_file 고정 집행기 (V3 M5c 3A 5차 리비전 A3) ─────────────────────────

/**
 * **파일 시스템 효과는 이 모듈 안에만 있다**(3A 5차 리비전 A3).
 *
 * 4차 판은 이 코드를 별도 `src/exec/writeFileEffect.ts`에 두고 `judgeWriteFile(auth, op)`를 **export**했다.
 * `DispatchAuthority`는 평범한 구조적 interface이므로 그 모듈을 **직접 import**하면 위조한
 * `{workspaceRoot, manifest, ownership, …}` 하나로 파일을 열어 hash하고 디렉터리를 fsync할 수 있었고,
 * 성공 marker(`already_applied`)까지 돌려받았다 — 진짜 permit·과금·현재 durable 상태 확인이 **하나도**
 * 없는 채로다(독립 리뷰 A-3). 패키지는 `dist` 전체를 exports map 없이 배포하므로 "내부 파일"·이름·주석·
 * barrel 누락·TypeScript 가시성은 경계가 아니었다.
 *
 * 그래서 파일을 **없앴다**(이름을 바꾸거나 `@internal`을 붙인 것이 아니다): 효과 함수는 이제 grant 등록부
 * (`GENUINE_GRANTS`)와 **같은 모듈의 사설 함수**이고, 유일한 진입점은 진짜 grant를 요구하는
 * `executeWriteFileOperation()`이다. 남아 있는 export는 부수 효과가 **0**인 순수 권위 판정
 * (`resolveApprovedOperation`/`resolveWriteAuthority` — 호출자가 준 값을 되비추기만 한다),
 * 안정 코드 목록, 그리고 테스트 seam뿐이다.
 *
 * 런타임 순환은 생기지 않는다: 이 모듈은 `typedExecution.ts`를 import하지 않고 그 반대만 있다.
 *
 * **바이트를 만들지 않는다**(3A 3차 리비전 A4): 신규 발행도 기존 교체도 fail closed이므로, 여기서 하는
 * 일은 "이미 의도한 내용인가"를 판정하고 정합화하는 것뿐이다. temp를 만들지 않으므로 고아 plaintext ·
 * unlink durability 문제도 성립하지 않는다(3A 2차·3차 리비전 B1).
 *
 * **오류에 내용은 담지 않는다**: 파일 내용 · 절대 경로 · argv · secret은 메시지에도 영수증에도 없다.
 */

/** `write_file` 집행 단계가 낼 수 있는 안정 오류 코드(문서는 `typedExecution.TYPED_EXECUTION_CODES`가 정본이다). */
export const WRITE_EFFECT_CODES = [
  "operation_denied",
  "operation_not_owned",
  "operation_outside_writable_root",
  "write_bytes_exceeded",
  "write_path_symlink",
  "write_target_not_regular",
  "write_failed",
  "write_replace_unsupported",
  "write_publish_unsupported",
  /**
   * **M5d `B-16` 부분 개방** — 고정한 대상 fd에 바이트를 쓰는 도중 실패했다. 내용이 **torn일 수 있다**:
   * 이 코드가 뜻하는 것은 "대상이 의도한 내용도 원래 내용도 아닐 수 있다"이며, 재시도는 preimage
   * 불일치로 `write_conflict`가 되어 **사람이 개입할 때까지 fail closed**다. 조용한 오염이 아니다.
   */
  "write_apply_incomplete",
  "write_durability_unconfirmed",
  "write_cleanup_unconfirmed",
] as const;

/** 집행기가 낼 수 있는 결과 marker(성공 marker는 **여기서만** 나온다 — 호출자가 고를 수 없다). */
export type WriteEffectMarker = "applied" | "already_applied" | "write_conflict";

/** 고정 집행기 1회의 canonical 결과(내용은 담지 않는다 — marker·경로·결과 hash만). */
export interface WriteEffectOutcome {
  marker: WriteEffectMarker;
  path: string | null;
  resultSha256: string | null;
  exitCode: null;
}

function operationDenied(what: string): OrchestrationError {
  return new OrchestrationError("operation_denied", `승인되지 않은 typed operation이다: ${what}`);
}

/**
 * **deny-by-default 권위 해석.** durable manifest의 `approvedOperationFor(taskId, authorityId)` 하나만
 * 본다 — 부재·다른 task·kind 불일치는 전부 거부다. "부재가 곧 허용"이 되는 경로는 없다.
 *
 * **부수 효과가 0인 순수 판정**이므로 export해도 파일 시스템 권위가 되지 않는다: 위조 authority를 넣으면
 * **호출자가 스스로 만든 manifest를 되비춘 값**만 돌아오고, 파일도 열리지 않고 성공 marker도 없다.
 *
 * mutation seam(비공허성 · 대장 `C-34`): 아래 `null` 검사를 지우고 합성 authority를 돌려주면
 * focused 테스트 "[M5c] MUTATION-GUARD: 권위 대조를 건너뛰면 거부가 사라진다"가 반드시 실패해야 한다.
 */
export function resolveApprovedOperation(
  op: TypedWriteFileOperation | TypedRunProcessOperation,
  auth: DispatchAuthority,
): ApprovedOperation {
  const approved = approvedOperationFor(auth.manifest, auth.taskId, op.authorityId);
  if (approved === null) throw operationDenied("이 task에 승인된 authorityId가 아니다");
  if (approved.kind !== op.kind) throw operationDenied("승인 레코드의 kind와 다르다");
  return approved;
}

/**
 * `write_file` 권위 해석. 정확히 같은 정규화 경로 · **dispatch 시점** ownership · `writableRoots`를
 * 전부 다시 본다. 파일 시스템은 만지지 않는다(위 함수와 같은 이유로 순수하다).
 */
export function resolveWriteAuthority(
  op: TypedWriteFileOperation,
  auth: DispatchAuthority,
): Extract<ApprovedOperation, { kind: "write_file" }> {
  const approved = resolveApprovedOperation(op, auth);
  if (approved.kind !== "write_file") throw operationDenied("승인 레코드의 kind와 다르다");
  if (op.path !== approved.path) throw operationDenied("승인된 경로와 정확히 같지 않다");
  if (!auth.ownership.some((own) => pathWithin(op.path, own))) {
    throw new OrchestrationError("operation_not_owned", "경로가 이 task의 durable ownership 밖이다");
  }
  if (!auth.manifest.writableRoots.some((root) => pathWithin(op.path, root))) {
    throw new OrchestrationError("operation_outside_writable_root", "경로가 승인된 writableRoots 밖이다");
  }
  return approved;
}

/** digest 계산 chunk(고정 64 KiB — 큰 preimage도 메모리 상한 안에서 읽는다). */
const HASH_CHUNK_BYTES = 65_536;

/**
 * preimage 판정을 위해 읽을 수 있는 최대 바이트.
 * ponytail: 상한을 넘는 대상은 판정 불가 = `write_conflict`(fail closed)로 접는다. 스트리밍 상한을
 * 올려야 할 만큼 큰 승인 대상이 생기면 그때 값을 올린다.
 */
const MAX_PREIMAGE_BYTES = 64 * 1024 * 1024;

const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;

function writeFailed(what: string): OrchestrationError {
  return new OrchestrationError("write_failed", `typed 쓰기를 집행할 수 없다: ${what}`);
}

function symlinkRefused(what: string): OrchestrationError {
  return new OrchestrationError("write_path_symlink", what);
}

function notRegular(what: string): OrchestrationError {
  return new OrchestrationError("write_target_not_regular", what);
}

/**
 * **no-follow 보장이 없으면 아무것도 쓰지 않는다.** 이전 판은 `O_NOFOLLOW`가 없을 때 조용히 `0`으로
 * 떨어뜨렸다 → symlink 거부가 그 플랫폼에서 흉내가 됐다. 지금은 fail closed다.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW;

function requireNoFollow(): void {
  if (typeof O_NOFOLLOW !== "number" || O_NOFOLLOW === 0) {
    throw writeFailed("이 플랫폼에 O_NOFOLLOW 보장이 없다(조용히 따라가지 않는다)");
  }
}

/**
 * **결정론적 race·fault 테스트 seam**(테스트 전용).
 *
 * 이것이 **새 권위를 만들 수 없는 이유**: 콜백은 **인자를 받지 않고 반환값도 무시된다**. 권위 판정
 * (`readDispatchAuthority` → 승인 레코드 대조)은 **모든 seam보다 먼저** 끝나고, 판정 직전 신원 확인은
 * seam **뒤에** 다시 돈다. 다만 같은 프로세스에서 이미 ambient 파일 시스템 권한을 가진 코드는 hook
 * 안에서 승인 대상을 의도한 바이트로 만들 수 있고, 뒤따르는 hash 판정이 canonical `already_applied`를
 * 낼 수 있다. 그래도 진짜 grant와 승인된 경로·내용은 계속 필요하므로 위조 권위 우회는 아니다.
 * ponytail: 결정론적 경쟁 재현에는 이 방법밖에 없다. 실제 병렬 프로세스로 바꿀 이유가 생기면 그때 바꾼다.
 *
 * **왜 production에서 도달 불가인가**(대장 `C-1` 마감): 등록은 두 겹으로 막힌다. ⓐ 이 setter는
 * production facade(`typedExecution.ts`)에서 **재수출되지 않는다** — 제품 코드가 보는 표면에 없다.
 * ⓑ 등록 시점에 **직접 호출자의 스택 프레임이 `*.test.ts` 파일**임을 요구한다. 배포 산출물은
 * `tsconfig.json`의 exclude가 모든 `.test.ts`를 build에서 빼므로 `dist/`에는 `.test.ts` 파일이 **하나도
 * 없다** — 배포된 CLI에서는 이 조건을 만족하는 프레임을 만들 수 없고, 따라서 hook을 심을 수 없다.
 * 조건이 깨지면 seam은 등록되지 않고 던진다(조용히 무시하지 않는다).
 * ponytail: 결정론적 경쟁 재현에는 이 방법밖에 없다. 실제 병렬 프로세스로 바꿀 이유가 생기면 그때 바꾼다.
 *
 * **남아 있는 표면(정직 — 없앴다고 주장하지 않는다)**: ⓐ TypeScript 소스 체크아웃을 `tsx`로 돌리는
 * 개발 환경에서는 `.test.ts` 파일을 새로 만들어 등록할 수 있다(배포 산출물에는 해당 없음).
 * ⓑ 같은 프로세스에서 `Error.prepareStackTrace`나 `Error.captureStackTrace`를 이미 바꿀 수 있는
 * 코드는 프레임 문자열을 위조할 수 있다 — 그 정도 권한이면 모듈 자체를 갈아끼울 수 있으므로 새로운
 * 권한 상승은 아니다. ⓒ hook이 할 수 있는 일의 상한은 위 문단 그대로다(DoS + ambient 권한 canonical).
 */
export type PublicationSeam = "parentWalk" | "targetOpen" | "publish" | "contentWrite" | "contentFsync" | "dirFsync";

let SEAMS: Partial<Record<PublicationSeam, () => void>> = {};

/** 스택에서 이 모듈 자신의 프레임을 걷어내고 남는 **첫 호출자** 프레임이 `*.test.ts`인지 본다. */
function callerIsTestFile(stack: string | undefined): boolean {
  const frames = (stack ?? "").split("\n").filter((line) => /^\s*at\s/.test(line));
  const caller = frames.find((line) => !line.includes("orchestrationKernel.ts"));
  if (caller === undefined) return false;
  // 경로 끝이 `...test.ts` 또는 `...test.ts:line:col`인 프레임만 통과시킨다.
  return /\.test\.ts(:\d+:\d+)?\)?\s*$/.test(caller);
}

/**
 * 테스트 전용. 돌려주는 함수를 부르면 원상복구된다(테스트 사이에 상태가 새지 않는다).
 *
 * **동기 호출만 통과한다**: 스택에서 호출자를 보므로 `setTimeout`·`queueMicrotask` 같은 비동기 경계
 * **안에서** 부르면 `.test.ts` 프레임이 남아 있지 않아 정당한 테스트도 거부된다. 보안이 아니라 사용
 * 제약이다 — 등록은 테스트 본문에서 동기적으로 하고, hook 안에서 비동기를 쓰는 것은 자유다.
 */
export function __setPublicationSeamsForTest(seams: Partial<Record<PublicationSeam, () => void>>): () => void {
  if (!callerIsTestFile(new Error().stack)) {
    // **집행 taxonomy를 빌리지 않는다**: 이것은 typed 쓰기의 실패가 아니라 **등록 거부**다.
    // `write_failed`를 쓰면 진짜 쓰기 실패 로그와 섞여 진단이 흐려진다(대장 `C-1` 리뷰 C-a).
    throw new Error("발행 seam은 테스트 파일에서 동기적으로만 등록할 수 있다");
  }
  const previous = SEAMS;
  SEAMS = seams;
  return () => {
    SEAMS = previous;
  };
}

/**
 * hook이 던진 것은 **무엇이든** `write_failed`로 정규화한다(3A 2차 리뷰 `C1`).
 * 이전에는 hook이 던진 `OrchestrationError`가 그대로 밖으로 나가 **호출자가 production 오류 taxonomy를
 * 고를 수 있었다**. 지금 seam으로 할 수 있는 것은 "파일 시스템을 흔들거나 실패시키는 것"뿐이다.
 */
function seam(name: PublicationSeam): void {
  const hook = SEAMS[name];
  if (hook === undefined) return;
  try {
    hook();
  } catch {
    throw writeFailed("발행 seam이 실패를 주입했다");
  }
}

/** 파일 신원(같은 파일인가) — 경로 이름이 아니라 inode로 본다. */
interface Ident {
  dev: number;
  ino: number;
}

function identOf(st: Stats): Ident {
  return { dev: st.dev, ino: st.ino };
}

function sameIdent(a: Ident, b: Ident): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

/** 열린 fd 하나에서 내용 digest를 읽는다(경로 재오픈 없음 → 판정과 대상이 갈라지지 않는다). */
function digestOfFd(fd: number, size: number): string {
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)));
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - off), off);
    if (n <= 0) throw writeFailed("preimage를 끝까지 읽지 못했다");
    h.update(buf.subarray(0, n));
    off += n;
  }
  return h.digest("hex");
}

interface ParentWalk {
  /** 최종 부모 디렉터리의 절대 경로. */
  parent: string;
  /** 대상 파일의 절대 경로. */
  target: string;
  /** 최종 부모 디렉터리의 신원. */
  parentIdent: Ident;
}

/**
 * 기존 경로 구성요소를 **하나도 따라가지 않고** 확인한다. 부모는 전부 실재하는 디렉터리여야 한다.
 * workspace 봉쇄는 `realpath(workspaceRoot)`에서 시작해 segment마다 `lstat`로 symlink를 거부하는 것으로
 * 성립한다. **발행 직전에 한 번 더 부른다** — 그 사이에 부모가 symlink로 교체되면 신원이 달라진다.
 */
function walkParents(workspaceRoot: string, relPath: string): ParentWalk {
  if (!isAbsolute(workspaceRoot)) throw writeFailed("workspaceRoot가 절대 경로가 아니다");
  let cur: string;
  try {
    cur = realpathSync(workspaceRoot);
  } catch {
    throw writeFailed("workspaceRoot를 확인할 수 없다");
  }
  const segments = relPath.split("/");
  let parentIdent: Ident;
  {
    const rootSt = lstatOrNull(cur);
    if (!rootSt || !rootSt.isDirectory()) throw writeFailed("workspaceRoot가 디렉터리가 아니다");
    parentIdent = identOf(rootSt);
  }
  for (let i = 0; i < segments.length - 1; i++) {
    cur = joinPath(cur, segments[i]);
    const st = lstatOrNull(cur);
    if (!st) throw writeFailed("경로 구성요소가 없다(디렉터리를 만들지 않는다)");
    if (st.isSymbolicLink()) throw symlinkRefused("경로 구성요소가 symlink다");
    if (!st.isDirectory()) throw writeFailed("경로 구성요소가 디렉터리가 아니다");
    parentIdent = identOf(st);
  }
  return { parent: cur, target: joinPath(cur, segments[segments.length - 1]), parentIdent };
}

/** 집행기가 낸 결과 1건(내용은 담지 않는다 — marker·경로·결과 hash만). */
function writeOutcome(marker: WriteEffectMarker, path: string | null, resultSha256: string | null): WriteEffectOutcome {
  return { marker, path, resultSha256, exitCode: null };
}

/**
 * **승인된 typed 파일 쓰기 1건을 판정·정합화하는 고정 집행기**(모듈 사설 — export되지 않는다).
 *
 * `executeWriteFileOperation()`이 **진짜 grant를 소비한 뒤에만** 이 함수를 부른다. 직접 import로 도달할
 * 통로는 존재하지 않는다(3A 5차 리비전 A3 — 이전 판은 이 함수가 export돼 있어서 위조 authority로
 * 파일을 열고 fsync할 수 있었다).
 *
 * 순서가 계약이다:
 * 1. 권위 해석(deny-by-default) → 정확한 경로 · dispatch 시점 ownership · writableRoots.
 * 2. 바이트 상한 = `min(승인 maxBytes, LIMITS.maxWriteBytes)`.
 * 3. no-follow 경로 walk(symlink·비일반 파일 거부) + 부모 디렉터리 신원을 **열린 fd로 고정**.
 * 4. 대상 preimage를 **열어 둔 fd 하나로** 확정(경로 재오픈 없음) → 판정 직전 부모 신원 **재확인**.
 * 5. **크래시 창 멱등**: 현재 내용이 의도한 내용과 같으면 `already_applied` — **내용 fsync와 부모 fsync가
 *    모두 성공한 뒤에만**(M5d에서 내용 fsync를 추가해 기준을 높였다).
 * 6. preimage 불일치는 **쓰지 않고** `write_conflict`.
 * 7. **대상이 있고 내용이 다르면 교체한다**(M5d — 대장 `B-16` 부분 개방). 3A 2차 리비전 A3이 이 분기를
 *    닫은 이유는 "temp → 최종 pathname `rename(2)`" 형태에서 **부모 이름 교체 경쟁**을 예방할 수 없다는
 *    것이었다. 그 이유는 지금 형태에 **성립하지 않는다**: rename하지 않고 4에서 신원까지 확정한 **바로
 *    그 fd**에 쓴다 → 발행 syscall(`write`/`ftruncate`/`fsync`)에 pathname이 **하나도 없다**.
 *    잃은 것은 **원자성**이다(`applyToFixedTarget` 주석에 무엇이 남는지 적어 두었다).
 * 8. **대상이 없으면 `write_publish_unsupported`**(3A 3차 A4 · 대장 `B-16` **잔여**) — 부재 대상에는
 *    고정할 fd가 없으므로 최종 `link(2)`가 pathname을 지나야 하고, 그 창은 여전히 예방할 수 없다.
 *    Node 18/macOS 내장에 디스크립터 상대 no-replace 발행(`linkat`)이 없다. `process.chdir(parent)` +
 *    basename `link`는 평가 후 기각했다(프로세스 전역 상태 · worker thread에서 throw · managed launcher가
 *    자식 cwd까지 오염). temp를 만들지 않으므로 이 거부의 파일 시스템 부작용은 **0**이다.
 *
 * **관측 가능한 회귀 하나(정직)**: 4의 대상 open이 `O_RDWR`이므로 **쓰기 권한이 없는 대상**(예: 0444)은
 * 교체는 물론 `already_applied`·`write_conflict` 판정조차 `write_failed`가 된다. fail closed 방향이지만
 * 크래시 복구 멱등 판정의 범위가 좁아졌다(대장 `C-64`).
 */
function judgeWriteFile(auth: DispatchAuthority, op: TypedWriteFileOperation): WriteEffectOutcome {
  const approved = resolveWriteAuthority(op, auth);
  const bytes = Buffer.from(op.content, "utf8");
  const bound = Math.min(approved.maxBytes, LIMITS.maxWriteBytes);
  if (bytes.byteLength > bound) {
    throw new OrchestrationError("write_bytes_exceeded", "본문이 승인된 바이트 상한을 넘는다");
  }
  requireNoFollow();
  // 정리 상태는 `finally`가 마지막에 적으므로 **호출자 쪽 holder**로 받는다 —
  // `finally` 안에서 반환값을 바꾸면 원래 예외를 삼키게 되기 때문이다.
  const status = { cleanupFailed: false };
  let result: WriteEffectOutcome;
  try {
    result = judgeWriteTransaction(auth, op, bytes, sha256Hex(bytes), status);
  } catch (e) {
    // **1차 오류가 정리 미확인을 가리지 않는다**(3A 3차 리비전 B1): 둘 다 있으면 정리 미확인이 이기고
    // 1차 안정 **코드**만 메시지에 싣는다(경로·내용은 담지 않는다).
    if (status.cleanupFailed) throw cleanupUnconfirmed(e instanceof OrchestrationError ? e.code : "non_orchestration");
    throw e;
  }
  if (status.cleanupFailed) throw cleanupUnconfirmed(null);
  return result;
}

function cleanupUnconfirmed(primaryCode: string | null): OrchestrationError {
  return new OrchestrationError(
    "write_cleanup_unconfirmed",
    primaryCode === null
      ? "판정은 끝났지만 fd 반납을 확인하지 못했다(성공 영수증을 내지 않는다)"
      : `판정이 ${primaryCode}로 실패했고 fd 반납도 확인하지 못했다(정리 미확인이 우선한다)`,
  );
}

/**
 * 판정 트랜잭션 하나. **바이트를 만들지 않는다** — 여는 것은 부모 디렉터리 fd와 (있으면) 대상 fd뿐이고
 * 모든 자원 반납은 `finally` 하나에 모여 있다. OS 오류는 전부 안정 코드로 접으며 경로·내용을 담지 않는다.
 *
 * **정리(= fd 반납) 실패는 성공이 되지 않는다**(3A 2차·3차 리비전 B1). temp를 만드는 경로가 사라졌으므로
 * **소유 잔재도 0**이다 — unlink durability · 고아 plaintext · truncate 폴백 문제는 남길 파일이 없어 성립하지 않는다.
 */
function judgeWriteTransaction(
  auth: DispatchAuthority,
  op: TypedWriteFileOperation,
  bytes: Buffer,
  intended: string,
  status: { cleanupFailed: boolean },
): WriteEffectOutcome {
  const fds: number[] = [];
  try {
    seam("parentWalk");
    const walk = walkParents(auth.workspaceRoot, op.path);

    const dirFd = openSync(walk.parent, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    fds.push(dirFd);
    const dirSt = fstatSync(dirFd);
    if (!dirSt.isDirectory()) throw writeFailed("부모가 디렉터리가 아니다");
    if (!sameIdent(identOf(dirSt), walk.parentIdent)) throw writeFailed("부모 디렉터리 신원이 확인 사이에 바뀌었다");

    // ── 대상 preimage: 열어 둔 fd로 신원과 내용을 함께 확정한다(경로 재오픈 없음).
    seam("targetOpen");
    let before: string | null = null;
    let targetExists = false;
    /** 신원·preimage를 확정한 대상 fd. **발행은 이 fd로만** 한다(경로 재해석 0). */
    let targetFdRef: number | null = null;
    const seen = lstatOrNull(walk.target);
    if (seen !== null) {
      targetExists = true;
      if (seen.isSymbolicLink()) throw symlinkRefused("대상이 symlink다(따라가지 않는다)");
      if (!seen.isFile()) throw notRegular("대상이 일반 파일이 아니다");
      let targetFd: number;
      try {
        // **M5d `B-16`**: 교체가 가능해졌으므로 대상은 `O_RDWR`로 연다. 이 fd 하나가 preimage 판정과
        // 발행에 **모두** 쓰이며, 발행 syscall에 pathname이 등장하지 않는 이유가 바로 이것이다.
        // 쓰기 능력은 §"교체" 분기 밖에서는 **한 번도 사용되지 않는다**(`already_applied`·`write_conflict`
        // 경로는 읽기만 한다) — 분기 실수를 테스트가 mutation으로 지킨다.
        targetFd = openSync(walk.target, fsConstants.O_RDWR | O_NOFOLLOW);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ELOOP") throw symlinkRefused("대상이 symlink다(따라가지 않는다)");
        if (code === "ENOENT") throw writeFailed("대상이 판정 중에 사라졌다");
        throw writeFailed("대상을 열 수 없다");
      }
      fds.push(targetFd);
      targetFdRef = targetFd;
      const st = fstatSync(targetFd);
      if (!st.isFile()) throw notRegular("대상이 일반 파일이 아니다");
      if (!sameIdent(identOf(st), identOf(seen))) throw writeFailed("대상이 판정 중에 다른 파일로 바뀌었다");
      if (st.size > MAX_PREIMAGE_BYTES) {
        // preimage를 판정할 수 없다 → 조용히 덮어쓰지 않는다(fail closed).
        return writeOutcome("write_conflict", op.path, null);
      }
      before = digestOfFd(targetFd, st.size);
    }

    // **판정을 내기 직전에 부모 신원을 다시 본다**(3A 3차 리비전 A4). 대상 조회는 pathname을 지나므로,
    // 이 재확인이 없으면 "승인된 부모 안에서 봤다"는 판정 자체가 교체된 디렉터리에 대한 것일 수 있다.
    seam("publish");
    const again = walkParents(auth.workspaceRoot, op.path);
    if (again.parent !== walk.parent || !sameIdent(again.parentIdent, walk.parentIdent)) {
      throw writeFailed("부모 디렉터리가 판정 중에 교체됐다");
    }
    if (!sameIdent(identOf(fstatSync(dirFd)), walk.parentIdent)) {
      throw writeFailed("부모 디렉터리 신원이 판정 중에 바뀌었다");
    }

    // 크래시 창: 이미 의도한 바이트가 있다 → 다시 쓰지 않는다(DECISIONS 2026-07-30 결정 1).
    // **단 부모 fsync에 성공해야 `already_applied`다**(3A 2차 리비전 A4): 앞선 시도가 fsync에서 실패했다면
    // 디렉터리 엔트리는 아직 durable하지 않고, "다시 보니 있더라"는 durability의 증거가 아니다.
    if (before === intended) {
      // **내용 fsync도 요구한다**(M5d): 앞선 시도가 바이트를 다 쓰고 `fsync` 전에 죽었을 수 있다 —
      // "다시 보니 의도한 내용이더라"는 durability의 증거가 아니다. 부모 fsync만 보던 기존 기준을
      // 낮추지 않고 **높인다**(대상 fd가 이미 열려 있으므로 추가 비용은 syscall 하나다).
      if (targetFdRef !== null) confirmContentDurability(targetFdRef);
      confirmDirDurability(dirFd);
      return writeOutcome("already_applied", op.path, intended);
    }
    // 기대한 preimage가 아니다 → 한 바이트도 쓰지 않는다.
    if (op.expectedBeforeSha256 === null ? before !== null : before !== op.expectedBeforeSha256) {
      return writeOutcome("write_conflict", op.path, null);
    }
    // **교체는 여기서 일어난다**(M5d — 대장 `B-16` 부분 개방). 3A 2차 리비전 A3이 이 분기를 닫은
    // 이유는 "temp → 최종 pathname `rename(2)`" 형태의 발행에서 **부모 이름 교체 경쟁**을 예방할 수
    // 없다는 것이었다. 그 이유는 **여기에 더는 적용되지 않는다**: 우리는 rename하지 않고, 이미 신원과
    // preimage를 확정해 둔 **바로 그 fd**에 쓴다 → 발행 경로에 pathname이 **하나도 없다**.
    if (targetExists && targetFdRef !== null) {
      return applyToFixedTarget(targetFdRef, dirFd, bytes, intended, op.path);
    }
    // **신규 발행도 여기서 끝난다**(3A 3차 리비전 A4): 최종 `link(2)`도 pathname이므로 부모 교체 경쟁을
    // 예방할 수 없고, 사후 inode 검증은 그 창을 닫지 못한다(발행된 inode는 우리 것이 맞기 때문이다).
    // temp를 만들기 **전에** 끝나므로 파일 시스템 부작용이 **0**이다 — 테스트가 그것을 단정한다.
    throw new OrchestrationError(
      "write_publish_unsupported",
      "부재 대상 발행은 디스크립터 상대 no-replace primitive 없이 예방 안전하게 만들 수 없어 거부한다",
    );
  } catch (e) {
    // OS·seam 오류는 **닫힌 안정 코드**로 접는다(경로·내용을 담지 않는다).
    throw e instanceof OrchestrationError ? e : writeFailed("집행 중 파일 시스템 오류가 났다");
  } finally {
    for (const fd of fds) {
      try {
        closeSync(fd);
      } catch {
        // **정리 실패도 실패다**(활성 계약 ⑥ · 3A 2차 리비전 B1): 반납하지 못한 fd를 성공으로 삼키지 않는다.
        status.cleanupFailed = true;
      }
    }
  }
}

/**
 * 발행된 이름의 **디렉터리 durability를 확인**한다. 실패는 `write_durability_unconfirmed`이고,
 * 재시도가 이 확인을 다시 지나지 못하면 계속 같은 코드다("다시 보니 있더라"는 durability가 아니다).
 */
/**
 * **고정한 대상 fd에 승인된 바이트를 발행한다**(M5d — 대장 `B-16` 부분 개방).
 *
 * **무엇에 대해 안전한가(정확히)**: 발행 syscall이 `write`/`ftruncate`/`fsync`뿐이고 **전부 fd를 받는다**.
 * 경로 문자열이 커널에 다시 들어가지 않으므로, 판정 이후 부모나 대상의 **이름**이 무엇으로 바뀌든
 * 바이트는 우리가 신원(dev+ino)까지 확인한 **그 inode에만** 간다. 3A 2차 리비전이 교체를 닫은 이유
 * ("최종 pathname `rename(2)` 직전 창")는 이 형태에 성립하지 않는다.
 *
 * **무엇이 남는가(정직 — 없앴다고 주장하지 않는다)**:
 * 1. **원자성이 없다.** `write`가 절반만 나간 채로 죽으면 대상은 torn이다. 그 상태는 다음 시도에서
 *    preimage 불일치(`write_conflict`)로 **fail closed**가 되고 자동 복구되지 않는다 — 사람이 본다.
 *    성공 영수증은 fsync까지 확인한 뒤에만 나오므로 **거짓 성공은 없다**.
 * 2. **같은 uid 경쟁자**는 여전히 막지 못한다(`verifyCodexHome`과 같은 선언된 threat model). 다만 막는
 *    것이 있다: 바이트가 **다른 파일·다른 디렉터리로 새는 일**은 예방된다. 같은 uid가 그 inode의
 *    도달 경로(이름)를 바꾸는 것은 막지 못한다.
 * 3. **durability는 기존 전제와 같은 수준**이다 — macOS의 `fsync` vs `F_FULLFSYNC` 논쟁은 이 slice가
 *    바꾸지 않는다(기존 디렉터리 fsync도 같은 전제 위에 있다). 더 강하다고 주장하지 않는다.
 *
 * 순서: 내용 write → 남은 꼬리 절단(`ftruncate`) → 내용 fsync → 부모 fsync. 어느 단계든 실패하면
 * 성공 영수증이 없다.
 */
function applyToFixedTarget(
  targetFd: number,
  dirFd: number,
  bytes: Buffer,
  intended: string,
  path: string,
): WriteEffectOutcome {
  let written = 0;
  try {
    while (written < bytes.byteLength) {
      const n = writeSync(targetFd, bytes, written, bytes.byteLength - written, written);
      if (n <= 0) throw new Error("short write");
      written += n;
      seam("contentWrite");
    }
    // 새 내용이 이전보다 짧으면 꼬리가 남는다 → 절단까지 해야 "의도한 내용"이다.
    ftruncateSync(targetFd, bytes.byteLength);
  } catch {
    // **torn일 수 있다**고 정직하게 말한다. 성공도 아니고 "아무 일 없었다"도 아니다.
    throw new OrchestrationError(
      "write_apply_incomplete",
      "승인된 바이트를 끝까지 쓰지 못했다(대상 내용이 확정되지 않았다 — 재시도는 preimage 불일치로 막힌다)",
    );
  }
  confirmContentDurability(targetFd);
  // 디렉터리 엔트리 자체는 바뀌지 않았지만(같은 inode·같은 이름), 부모 fsync는 기존 `already_applied`
  // 계약과 **같은 기준**을 유지하기 위해 그대로 지난다 — 성공 판정의 durability 기준을 낮추지 않는다.
  confirmDirDurability(dirFd);
  return writeOutcome("applied", path, intended);
}

/** 내용 durability. 실패하면 바이트는 나갔을 수 있어도 **성공 영수증을 내지 않는다**. */
function confirmContentDurability(targetFd: number): void {
  try {
    seam("contentFsync");
    fsyncSync(targetFd);
  } catch {
    throw new OrchestrationError(
      "write_durability_unconfirmed",
      "내용 durability를 확인하지 못했다(재시도도 fsync에 성공해야 성공 영수증이 된다)",
    );
  }
}

function confirmDirDurability(dirFd: number): void {
  try {
    seam("dirFsync");
    fsyncSync(dirFd);
  } catch {
    throw new OrchestrationError(
      "write_durability_unconfirmed",
      "디렉터리 durability를 확인하지 못했다(재시도도 fsync에 성공해야 already_applied가 된다)",
    );
  }
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
            // **attempt 신원을 재사용할 수 없다**(V3 M6 T5 — fresh-session 강제의 kernel 측면).
            // `attemptId`는 호출자가 주는 slug인데 이전 판은 **직전 attempt와 같은 값도 받았다**. 같은
            // 값이면 attempt가 바뀌었는데도 `dispatch_identity_stale` 판정이 통과해 앞선 attempt에서
            // 발급된 permit/grant가 다음 attempt의 신원과 맞아떨어진다. 효과 자체는 durable
            // `chargedTurnIds`가 한 번 더 막지만(같은 turn은 두 번 과금되지 않는다 →
            // `budget_turn_unaccounted`로 효과 게이트가 닫힌다), **감사 기록에서 두 attempt가 구분되지
            // 않는 것**은 그것과 별개의 손해다. 여기서 닫는다.
            //
            // **닫는 범위를 정확히 적는다**: 막는 것은 *직전* attempt와 같은 값이다. 두 attempt 이전의
            // 값을 다시 쓰는 것은 durable state가 과거 attemptId를 보관하지 않아 이 자리에서 볼 수 없다
            // (event log는 state 밖 파일이다). 그 잔여는 대장 `C-68`에 남겼다.
            if (task.execution.attemptId !== null && d.attemptId === task.execution.attemptId) {
              throw new OrchestrationError(
                "attempt_id_reused",
                `task ${id}의 새 attempt가 직전 attempt와 같은 attemptId를 쓴다: ${d.attemptId}`,
              );
            }
            // **미확정 operation을 지우면서 새 attempt를 시작하지 않는다**(3A 3차 리비전 A3):
            // 이 자리가 `emptyTaskExecution()`으로 실행 상태를 갈아끼우는 지점이다.
            assertNoPendingOperations(task, "preflight");
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
   *
   * **이 attempt의 worker 진행 채널을 여기서 딱 한 번 발급한다**(3A 4차 리비전 A1). 진행 신호의 권위를
   * durable `processLeaseMarker`에 두면 `getTask()`로 베낄 수 있으므로, 채널은 **시작을 커밋한 호출자에게만**
   * 이 순간 건네진다 — durable 값에서 채널을 되만드는 공개 통로는 존재하지 않는다.
   */
  startPreparedTask(input: { taskId: string; actionId: string; leaseMarker: string }): StartedTask {
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
    const started = requireTask(this.#state, taskId);
    const progress: WorkerProgressChannel = Object.freeze({
      runId: this.#state.runId,
      taskId,
      attemptId: started.execution.attemptId!,
    });
    GENUINE_PROGRESS_CHANNELS.set(progress, {
      issuer: this,
      runId: this.#state.runId,
      taskId,
      attemptId: started.execution.attemptId!,
      leaseMarker,
      lastSeq: -1,
    });
    return { task: clone(started), progress };
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

  /**
   * **task 하나의 context bundle**(V3 M6 T3 — 파생물이며 state/event/디스크를 바꾸지 않는다).
   *
   * `rebuildSnapshot`과 같은 지위다: 입력은 **현재 durable state뿐**이라 프로세스를 교체해도 같은
   * revision이면 같은 바이트가 나온다. 이것이 coordinator rotation(M6 ③)에서 "새 coordinator가 맥락을
   * 이어받을 수 있다"의 근거이며, 이 값을 어디에도 저장하지 않는 이유이기도 하다(파생물은 SoR이 아니다).
   */
  contextBundle(taskId: string): string {
    return buildContextBundle(this.#state, assertSlug(taskId, "taskId"));
  }

  /**
   * **coordinator 교체 등가성 다이제스트**(V3 M6 T4 — 로드맵 M6 완료 조건 ③).
   *
   * "교체 전후가 같다"를 사람 눈이 아니라 **세 해시**로 판정한다. 읽기 전용이며 state·event·디스크를
   * 바꾸지 않는다(`rebuildSnapshot`·`contextBundle`과 같은 지위다).
   *
   * - `graphHash` — task 그래프의 모양: `[taskId, state, dependsOn, depth, parentTaskId]` **taskId 오름차순**.
   * - `decisionHash` — 중앙이 내린 결정의 기록: message index를 `[messageId, type, taskId, routeToTaskId,
   *   summary, bodySha256]`로 정규화해 **messageId 오름차순**.
   * - `artifactHash` — 검증된 산출물 포인터: `[path, revision, sha256]` **artifactId 오름차순**.
   *
   * **시각 필드를 한 개도 넣지 않는다.** 넣으면 교체 전후가 구조적으로 절대 같을 수 없어 이 다이제스트가
   * 곧 공허한 체크가 된다(M5에서 그 부류로 A급을 세 번 맞았다). 같은 이유로 revision·lastEventId도 넣지
   * 않는다 — 그 둘은 "어떻게 여기 왔는가"이지 "지금 무엇인가"가 아니다. 진행 여부는 호출자가 revision을
   * 따로 보고 판단한다.
   */
  snapshotDigest(): SnapshotDigest {
    return computeSnapshotDigest(this.#state);
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
      //
      // **`cleaning`도 받는다(V3 M6 T2)** — 다만 `requireCleanedTask`와 같은 조건에서만이다: turn을
      // `recordTerminal`로 닫고 **자손 0을 확인한 뒤**(`confirmCleanup`) 미확정 operation이 없는 상태.
      // 이 갈래가 필요한 이유는 autopilot turn의 lifecycle과 spawn 전이가 M5c까지 합성되지 않았기
      // 때문이다: worker가 turn 안에서 spawn을 요청하면 parent는 `running`에서 곧바로
      // `waiting_children`으로 가버려 그 attempt를 `recordTerminal`로 닫을 수 없었고(그 API는 `running`만
      // 받는다), 반대로 turn을 먼저 닫으면 `cleaning`이라 spawn을 받을 수 없었다. 그래서 **정리 확인이
      // 먼저**인 순서를 택했다 — `B-13`(확인된 정리 뒤에만 자원을 놓는다)을 spawn 경로에서도 지킨다.
      // 이 갈래는 attempt 자원(lease·봉인된 결과)을 같은 커밋에서 놓는다.
      const fromCleaning = parent.state === "cleaning";
      if (fromCleaning) {
        requireCleanedTask(draft, parent.taskId, "spawn_request");
      } else if (parent.state !== "running" && parent.state !== "waiting_children") {
        throw new OrchestrationError(
          "invalid_transition",
          `spawn_request는 running/waiting_children/정리 확인된 cleaning task만 제출할 수 있다 (현재 ${parent.state})`,
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
      // 정리 확인된 attempt를 떠나는 갈래는 lease와 봉인된 결과를 **같은 커밋에서** 놓는다 — 남겨 두면
      // 재시작한 controller가 "정리해야 할 프로세스가 있다"고 읽는다(완료 커밋과 같은 규칙).
      if (fromCleaning) {
        parent.execution = { ...parent.execution, processLeaseMarker: null, pendingResult: null };
      }
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
      // **child의 결과는 parent inbox로 route된다**(V3 M6 T2 — 완료 조건 ①의 parent→child→parent 반쪽).
      // 여전히 중앙 경유다: 발신은 orchestrator에게이고 route를 정하는 것은 이 커밋(중앙)이며, parent가
      // 직접 child의 mailbox를 읽거나 쓰는 통로는 없다. route는 durable하므로 재시작해도 남는다.
      acceptMessage(draft, now, mutation, this.paths, { ...envelope, artifactRefs: pointers }, input.body, summary, task.parentTaskId);
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
      // 산출물 없는 결과도 같은 규칙으로 parent inbox에 route된다(위 트랜잭션과 한 표를 쓴다).
      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary, task.parentTaskId);
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
   *
   * **과금은 효과보다 먼저다**(3A 3차 리비전 A1). 이전 판은 "과금 = turn 닫기"였고 미확정 operation이
   * 있으면 아예 거부했으므로, 계획을 만든 turn은 **효과가 끝난 뒤에야** 과금될 수 있었다 → 효과 게이트의
   * 토큰 판정이 항상 한 turn 뒤처진 값을 봤다(승인 상한 우회). 지금은 **회계와 turn 닫기를 분리**한다:
   * - 회계는 **미확정 operation이 있어도 반영된다**(그래야 grant·효과가 최신 총량으로 판정된다).
   *   과금해도 **dispatch claim은 그대로 살아 있다** → 그 계획의 grant·영수증 경로가 무효화되지 않는다.
   * - **claim 교체는 지연된다**: 끝난 claim(과금 + 미확정 0)만 다음 turn의 permit 요청이 교체한다.
   * - 닫힌 turn은 `chargedTurnIds`에 남아 **다시 claim되지 않는다**.
   *
   * **이 진입점은 효과를 승인하지 않는다**(3A 4차 리비전 A1). 여기서는 dispatch claim이 **없는** turn만
   * 과금할 수 있고(claim이 있으면 `turn_conflict` — `chargeDispatchTurnUsage()`를 써야 한다),
   * 생산 turn 과금 권위의 canonical 증거인 `execution.chargedPlanDigest`를 **채우지 않는다**.
   * 그래서 "sibling이 남의 bare turn ID를 0 토큰으로 과금해 남의 효과를 승인"하는 경로가 존재하지 않으면서도,
   * **만료·재시작 뒤에 이미 태운 자원을 적는 일**(대장 `B-12`)은 그대로 가능하다.
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
    return this.#chargeTurn({
      taskId,
      turnId,
      actionId: assertSlug(input.actionId, "actionId"),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      elapsedMs: input.elapsedMs,
      authority: null,
    });
  }

  /**
   * **kernel 발급 permit으로 생산 turn을 과금한다**(3A 4차 리비전 A1 — 효과를 승인하는 **유일한** 과금).
   *
   * 이전 판의 결함: 효과 게이트가 run 전역 `accounting.chargedTurnIds`에 그 turn ID가 **있기만 하면**
   * 통과시켰고, `chargeTurnUsage`는 `{taskId, turnId, 카운트}`를 호출자가 전부 고를 수 있었다 →
   * **claim이 없는 sibling task**가 생산 task의 bare turn ID를 0 토큰으로 과금해 그 효과를 승인할 수
   * 있었다(독립 리뷰 A-1).
   *
   * 지금 신원은 **호출자가 아니라 permit**에서 나온다(`run/task/attempt/turn` + 묶인 계획 digest).
   * 성공하면 `execution.turnId`와 `execution.chargedPlanDigest`를 함께 적고, 효과 게이트는 그 둘을
   * claim된 `dispatchTurnId`/`dispatchPlanDigest`/`attemptId`와 **함께** 본다.
   *
   * safety-only 커밋이므로 만료·deadline 뒤에도 지난다 — 이미 태운 자원을 적는 일이기 때문이다.
   * (permit 자체는 전진 게이트를 지나야 나오므로 만료 후 새로 만들 수는 없다.)
   */
  chargeDispatchTurnUsage(input: {
    permit: unknown;
    actionId: string;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  }): RunAccounting {
    // **발급 인스턴스까지 대조한다**(3A 5차 리비전 A2) — 형제 kernel·두 번째 workspace의 permit은 거부다.
    const { permit, record } = genuinePermit(input?.permit, this);
    return this.#chargeTurn({
      taskId: permit.taskId,
      turnId: permit.turnId,
      actionId: assertSlug(input.actionId, "actionId"),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      elapsedMs: input.elapsedMs,
      authority: { attemptId: permit.attemptId, planDigest: record.planDigest },
    });
  }

  /** 과금 커밋 하나(권위 있는 것과 없는 것의 **유일한** 차이는 `authority`다). */
  #chargeTurn(input: {
    taskId: string;
    turnId: string;
    actionId: string;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
    authority: { attemptId: string; planDigest: string } | null;
  }): RunAccounting {
    const { taskId, turnId, actionId, authority } = input;
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
        if (authority === null) {
          // 권위 없는 회계는 **claim이 없는 turn에만** 허용된다. claim이 열려 있으면 그 turn은 효과를
          // 승인하는 생산 turn이므로 permit을 요구한다(`chargeDispatchTurnUsage`).
          if (task.execution.dispatchTurnId !== null) {
            throw new OrchestrationError(
              "turn_conflict",
              `task ${taskId}는 turn ${task.execution.dispatchTurnId}을 durable하게 claim했다 — 권위 없는 과금은 할 수 없다`,
            );
          }
          // **남이 claim한 turn을 선점하지 않는다**(3A 5차 리비전 A1). 4차 판은 이 검사가 없어
          // claim 없는 sibling이 생산 task의 claim된 turn ID를 0 토큰으로 과금할 수 있었고, 그것이
          // ⓐ 생산 task의 진짜 과금을 영구히 막고(`turn_already_charged`) ⓑ 거짓 정산으로 claim 교체를
          // 열었다. run 전역 중복 namespace를 쓰는 한 이 검사는 **커밋 안에서** 있어야 한다.
          const claimant = draft.tasks.find((t) => t.execution.dispatchTurnId === turnId);
          if (claimant !== undefined) {
            throw new OrchestrationError(
              "turn_conflict",
              `turn ${turnId}은 task ${claimant.taskId}가 durable하게 claim한 생산 turn이다 — 권위 없는 과금 대상이 아니다`,
            );
          }
        } else {
          // permit이 발급된 뒤 durable claim이 바뀌었으면 과금 권위도 무효다(낡은 attempt·교체된 claim).
          if (task.execution.attemptId !== authority.attemptId) {
            throw new OrchestrationError("dispatch_identity_stale", `task ${taskId}의 durable attempt 신원이 바뀌었다`);
          }
          if (task.execution.dispatchTurnId !== turnId) {
            throw new OrchestrationError("turn_conflict", `task ${taskId}가 durable하게 claim한 turn이 아니다: ${turnId}`);
          }
          if (task.execution.dispatchPlanDigest !== authority.planDigest) {
            throw new OrchestrationError("dispatch_plan_conflict", `task ${taskId}의 이 turn에는 다른 계획이 claim돼 있다`);
          }
        }
        acc.tokensUsed = Math.min(LIMITS.maxAccountedTokens, acc.tokensUsed + delta);
        acc.elapsedMsUsed = Math.min(LIMITS.maxAccountedElapsedMs, Math.max(acc.elapsedMsUsed, elapsedMs));
        acc.chargedTurnIds = [...acc.chargedTurnIds, turnId].sort();
        // **claim은 여기서 닫지 않는다**(3A 3차 리비전 A1): 순서가 과금 → grant → 효과이므로 지금 닫으면
        // 바로 그 계획의 grant가 죽는다. 끝난 claim은 다음 turn의 permit 요청이 교체한다.
        task.execution = {
          ...task.execution,
          turnId,
          // 권위 없는 회계는 효과 승인 증거를 남기지 않는다(A1의 핵심).
          chargedPlanDigest: authority === null ? null : authority.planDigest,
        };
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
              planDigest: authority === null ? null : authority.planDigest,
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
   * **인정되는 진행 신호 1건.** no-progress deadline을 되돌리는 **유일한** 경로다.
   *
   * 3A 3차 리비전 A1 — 이전 판은 ⓐ `{taskId, actionId}`만 있으면 누구나 부를 수 있었고 ⓑ **이미 소진된**
   * no-progress·wall 창을 되살릴 수 있었다(deadline을 넘긴 뒤 부르면 그대로 앞으로 밀렸다). 지금은:
   *
   * - **이미 소진된 attempt는 진행으로 되살아나지 않는다.** 효과 게이트와 **같은 등호 규칙**으로
   *   `no_progress_exhausted` · `attempt_wall_exhausted`를 먼저 본다(늦은 진행 = 거부).
   * - **provenance**: 진행은 **kernel이 `startPreparedTask()`에서 발급한 worker 채널**로만 들어온다
   *   (3A 4차 리비전 A1). 3차 판은 durable `processLeaseMarker` 하나를 자격으로 삼았는데 그 값은
   *   `getTask()`가 그대로 돌려주므로, state를 읽을 수 있는 코드는 누구든 **lease를 베껴** 시계를 되돌릴
   *   수 있었다. 채널은 durable 값에서 되만들 수 없고, 사용할 때마다 **현재** run/task/attempt/lease와
   *   다시 대조하므로 sibling 권위·낡은 attempt·교체된 lease는 전부 거부된다.
   * - **단조 sequence**: `seq`는 그 채널의 마지막 **성공 커밋**보다 엄격히 커야 한다 → 같은 이벤트 재생 ·
   *   역순 · 반복 주입이 시계를 되돌리지 못한다. 진행 이벤트는 여전히 worker 스트림의
   *   `{kind:"progress", seq, step}` 닫힌 형태여야 한다(`heartbeat`·미상 이벤트·구조 없는 호출은 거부).
   *
   * **정직한 범위**: 진짜 채널을 쥔 같은 프로세스의 코드는 진행을 낼 수 있다 — 그 코드가 바로 이 attempt를
   * 시작한 주체다. 밖에서 오는 구조적 사본·재생·lease 복사·sibling 주입은 여기서 전부 닫힌다.
   */
  recordProgress(input: { channel: unknown; actionId: string; event: unknown }): OrchestrationTask {
    const actionId = assertSlug(input?.actionId, "actionId");
    const channel = input?.channel;
    const chan = typeof channel === "object" && channel !== null ? GENUINE_PROGRESS_CHANNELS.get(channel) : undefined;
    if (chan === undefined) {
      throw new OrchestrationError("invalid_progress_channel", "진행 신호가 kernel 발급 worker 채널로 오지 않았다");
    }
    // **발급 인스턴스까지 대조한다**(3A 5차 리비전 A2): 같은 durable ID를 쓰는 다른 workspace/인스턴스의
    // 채널로 이 run의 no-progress 시계를 되돌릴 수 없다.
    if (chan.issuer !== this) {
      throw new OrchestrationError("invalid_progress_channel", "진행 채널이 이 kernel 인스턴스의 발급 값이 아니다");
    }
    const seq = adoptProgressEvent(input.event);
    // **재생·역순은 커밋 전에 거부한다**(채널 상태는 성공한 커밋에서만 전진한다).
    if (seq <= chan.lastSeq) {
      throw new OrchestrationError("invalid_progress_event", "진행 seq가 단조 증가하지 않는다(재생·역순 금지)");
    }
    const taskId = chan.taskId;
    this.#mutate((draft, now) => {
      if (draft.runId !== chan.runId) {
        throw new OrchestrationError("invalid_progress_channel", "진행 채널의 run 신원이 현재 durable run과 다르다");
      }
      const task = requireTask(draft, taskId);
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `진행 기록은 running task만 가능하다 (현재 ${task.state})`);
      }
      // attempt·lease가 하나라도 어긋나면 이 채널은 죽은 attempt의 것이다(늦은 진행이 부활시키지 못한다).
      if (task.execution.attemptId !== chan.attemptId || task.execution.processLeaseMarker !== chan.leaseMarker) {
        throw new OrchestrationError("cleanup_lease_mismatch", "진행 채널이 이 attempt의 lease와 다르다");
      }
      if (task.execution.wallDeadlineAt !== null && now >= task.execution.wallDeadlineAt) {
        throw new OrchestrationError("attempt_wall_exhausted", "이 attempt의 wall deadline을 넘었다(늦은 진행은 되살리지 않는다)");
      }
      const base = task.execution.lastProgressAt ?? task.execution.phaseStartedAt;
      if (base !== null && now >= addMs(base, draft.manifest.autopilotPolicy.maxNoProgressMs)) {
        throw new OrchestrationError("no_progress_exhausted", "no-progress deadline을 이미 넘었다(늦은 진행은 되살리지 않는다)");
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
    chan.lastSeq = seq;
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
        // pause는 attempt를 떠나는 전이다(`resumeTask`가 실행 상태를 리셋한다) → 미확정 operation을
        // 남긴 채 떠날 수 없다(3A 3차 리비전 A3).
        assertNoPendingOperations(task, "pause");
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
      // 실행 상태를 통째로 리셋하는 지점이다 → 미확정 operation을 여기서 지울 수 없다(3A 3차 리비전 A3).
      assertNoPendingOperations(task, "resume");
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
        // settle은 attempt를 **떠나는** 전이다(retry_wait/blocked/cancelled). 미확정 operation을 남긴 채
        // 떠나면 그 다음 preflight·resume이 그 기록을 지운다(3A 3차 리비전 A3).
        assertNoPendingOperations(task, "settle");
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
   * **turn/계획을 durable하게 claim하는 커밋이다**(3A 2차 리비전 A1). 1차 판은 state를 바꾸지 않았고
   * durable `turnId`가 `null`인 동안 **서로 다른 turn의 permit을 몇 개든** 발급했다 → 둘 다 집행되어
   * 승인·per-turn 회계·예산이 함께 무너졌고, 크래시 뒤에는 "어떤 계획/turn이 그 효과를 승인했는가"에
   * 대한 durable 기록이 아예 없었다. 지금은 **정확히 하나의 (turn, 계획 digest)** 가 커밋으로 claim되고,
   * 다른 turn은 `dispatch_identity_stale`, 같은 turn의 다른 계획은 `dispatch_plan_conflict`다.
   * 이미 과금이 끝난 turn을 다시 열 수도 없다(`turn_already_charged`).
   *
   * 같은 (turn, 계획)을 다시 요청하는 것은 **진짜로 멱등**이다(3A 3차 리비전 `C1`): durable 값이 이미
   * 그 값이면 **커밋하지 않고** 새 봉인 permit만 돌려준다 — revision도 `dispatch_claimed` event도 늘지
   * 않는다(이전 판은 "멱등"이라 적어 두고 매번 커밋해 재시작 정합화 loop가 감사 로그를 채웠다).
   * 그래서 **이미 과금된 turn이라도 claim이 아직 열려 있으면** 정합화용 permit을 다시 받을 수 있다.
   *
   * lifecycle은 그대로다: `prepared`가 아니면 `startPreparedTask()`를 지나야 하고, ready→running 직접
   * 경로는 여전히 없다(`startTask()`는 `preflight_required`).
   */
  /**
   * **일회용 trusted Git 권능 1건 발급**(task 3D · 대장 `C-26`). spawn하지 않고 durable state도 바꾸지
   * 않는다 — 실제 실행은 `executeTrustedGitQuery()` 하나뿐이고 그것이 이 권능을 **정확히 한 번** 소비한다.
   *
   * 권위 결박은 Task 3C의 launch 권능과 같다: 발급 인스턴스 자체(`issuer: this`) · `#state`를 직접 읽는
   * 재독 클로저 · 발급 시점 승인 digest · durable attempt 신원. **호출자가 고를 수 있는 것은 taskId와
   * 닫힌 enum 하나뿐**이고 실행 대상은 `manifest.executionAuthority.git`, 작업 디렉터리는 이 run의
   * `workspaceRoot`로 고정된다(둘 다 호출자가 지정할 필드가 없다).
   */
  resolveTrustedGitCapability(input: { taskId: string; query: TrustedGitQuery }): TrustedGitCapability {
    const taskId = assertSlug(input?.taskId, "taskId");
    const query = input?.query;
    if (!Object.prototype.hasOwnProperty.call(TRUSTED_GIT_SPECS, query as string)) {
      throw gitDenied("git_query_unsupported", `git 질의는 ${TRUSTED_GIT_QUERIES.join("|")} 중 하나여야 한다`);
    }
    const state = this.#state;
    const now = formatTimestamp(this.#clock());
    assertClockSane(state, now);
    assertNotExpired(state.manifest, now);
    const task = requireTask(state, taskId);
    if (task.state !== "running") throw gitDenied("git_task_not_running", "task가 running이 아니다");
    const attemptId = task.execution.attemptId;
    if (attemptId === null) throw gitDenied("git_authority_stale", "durable attempt 신원이 없다");
    const approved = state.manifest.executionAuthority.git;
    const repoRoot = this.#paths.workspaceRoot;
    // 발급 시점에도 저장소 신원을 본다(집행기가 spawn 직전에 **다시** 본다).
    verifyApprovedRepoRoot(repoRoot);
    const capability: TrustedGitCapability = Object.freeze({
      runId: state.runId,
      taskId,
      attemptId,
      query: query as TrustedGitQuery,
    });
    const record: TrustedGitRecord = {
      issuer: this,
      readState: () => this.#state,
      now: () => formatTimestamp(this.#clock()),
      repoRoot,
      runId: state.runId,
      taskId,
      attemptId,
      approvalDigest: state.accounting.approvalDigest,
      query: query as TrustedGitQuery,
      executable: approved.path,
      sha256: approved.sha256,
      termGraceMs: state.manifest.autopilotPolicy.cleanupTermGraceMs,
      killGraceMs: state.manifest.autopilotPolicy.cleanupKillGraceMs,
      spent: false,
    };
    GENUINE_GIT_CAPABILITIES.set(capability, record);
    liveGitOf(this).add(record);
    return capability;
  }

  issueOperationDispatchPermit(input: { taskId: string; turnId: string; actionId?: string; plan: unknown }): OperationDispatchPermit {
    const taskId = assertSlug(input?.taskId, "taskId");
    const turnId = assertSlug(input?.turnId, "turnId");
    const actionId = input?.actionId === undefined ? null : assertSlug(input.actionId, "actionId");
    {
      // 계획 검증은 **커밋 밖**에서 먼저 한다(무효 계획이 revision을 올리지 않는다).
      const state = this.#state;
      const now = formatTimestamp(this.#clock());
      assertForwardWorkAllowed(state, now);
      const probe = requireTask(state, taskId);
      if (probe.state !== "running") {
        throw new OrchestrationError(
          "dispatch_task_not_running",
          `typed operation permit은 running task만 받을 수 있다 (현재 ${probe.state})`,
        );
      }
      if (probe.execution.attemptId === null || probe.execution.preflightDigest === null) {
        throw new OrchestrationError("dispatch_identity_stale", `task ${taskId}에 durable attempt 신원이 없다`);
      }
    }
    const pre = requireTask(this.#state, taskId);
    const attemptId = pre.execution.attemptId!;
    // binding은 **durable state에서 나온다** — 호출자가 신원을 고르는 통로가 없다.
    const plan = validateTypedExecutionPlan(input?.plan, { runId: this.#state.runId, taskId, attemptId, turnId });
    const planDigest = sha256Hex(JSON.stringify(plan));

    // **정확히 같은 (turn, 계획)의 재발급은 durable 커밋 없이 멱등이다**(3A 3차 리비전 `C1`).
    // 이전 판은 문서만 "멱등"이라 적고 매번 `dispatch_claimed`를 커밋했다 → 재시작 정합화 loop가
    // 같은 claim을 반복 기록해 bounded revision·event 용량을 소모했다. 값이 이미 그 값이면 커밋할 것이 없다.
    const reissue = pre.execution.dispatchTurnId === turnId && pre.execution.dispatchPlanDigest === planDigest;
    // **다른 task가 이 turn을 claim했으면 재발급도 fail closed다**(3A 6차 리비전 A1).
    assertTurnClaimableBy(this.#state, taskId, turnId);
    if (!reissue) {
      this.#mutate((draft, now) => {
        const task = requireTask(draft, taskId);
        if (task.state !== "running") {
          throw new OrchestrationError(
            "dispatch_task_not_running",
            `typed operation permit은 running task만 받을 수 있다 (현재 ${task.state})`,
          );
        }
        if (task.execution.attemptId !== attemptId) {
          throw new OrchestrationError("dispatch_identity_stale", `task ${taskId}의 durable attempt 신원이 바뀌었다`);
        }
        // `execution.turnId`(= 마지막으로 과금된 turn)는 다음 turn을 막지 않는다 — 같은 attempt 안에서
        // turn은 이어진다. 막는 것은 **활성 claim**과 **이미 닫힌 turn** 둘뿐이다.
        if (draft.accounting.chargedTurnIds.includes(turnId)) {
          throw new OrchestrationError("turn_already_charged", `이미 과금이 끝난 turn은 다시 열 수 없다: ${turnId}`);
        }
        if (task.execution.preflightDigest !== preflightDigest(draft, task)) {
          throw new OrchestrationError("preflight_drift", `task ${taskId}의 봉인된 preflight가 준비 이후에 바뀌었다`);
        }
        // **claim namespace = 과금 namespace**(3A 6차 리비전 A1): 커밋 직전 draft에서 다시 본다.
        assertTurnClaimableBy(draft, taskId, turnId);
        // **경쟁 turn·경쟁 계획은 fail closed다.** 다른 turn으로 넘어가는 것은 **끝난 claim**
        // (= 과금됐고 미확정 operation 0)일 때만 허용된다 — 그때 이 커밋이 claim을 교체한다(A1).
        if (task.execution.dispatchTurnId !== null && task.execution.dispatchTurnId !== turnId) {
          if (!dispatchTurnSettled(task)) {
            throw new OrchestrationError(
              "dispatch_identity_stale",
              `task ${taskId}는 아직 끝나지 않은 turn(${task.execution.dispatchTurnId})을 durable하게 claim하고 있다`,
            );
          }
        } else if (task.execution.dispatchPlanDigest !== null && task.execution.dispatchPlanDigest !== planDigest) {
          // 같은 turn에 **다른 계획**은 언제나 거부다(경쟁 계획).
          throw new OrchestrationError("dispatch_plan_conflict", `task ${taskId}의 이 turn에는 다른 계획이 claim돼 있다`);
        }
        task.execution = { ...task.execution, dispatchTurnId: turnId, dispatchPlanDigest: planDigest };
        return {
          events: [
            event({
              at: now,
              type: "dispatch_claimed",
              revision: draft.revision,
              taskId,
              actionId,
              attemptId,
              turnId,
              planDigest,
            }),
          ],
          bodies: [],
        };
      });
    }

    const claimed = requireTask(this.#state, taskId);
    const permit: OperationDispatchPermit = Object.freeze({ runId: this.#state.runId, taskId, attemptId, turnId, plan });
    GENUINE_PERMITS.set(permit, {
      issuer: this,
      // **공개 `getState()`가 아니라 private `#state`를 읽는다**(3A 2차 리뷰 A1): 공개 메서드는
      // 밖에서 교체할 수 있고, 그러면 취소·정리된 task의 옛 `running` 스냅샷으로 게이트를 지날 수 있었다.
      readState: () => this.#state,
      now: () => formatTimestamp(this.#clock()),
      workspaceRoot: this.#paths.workspaceRoot,
      plan,
      planDigest,
      preflightDigest: claimed.execution.preflightDigest!,
      attemptNo: claimed.execution.attemptNo,
    });
    return permit;
  }

  /**
   * **집행 직전 durable 등록 + 일회용 execution grant 발급**(3A 2차 리비전 A2).
   *
   * 이 단계가 없으면 "효과는 일어났는데 durable에 흔적이 없다"와 "효과 없이 영수증만 있다"가 둘 다
   * 가능했다. 지금은 순서가 계약이다: **pending 커밋 → 효과 → 영수증 커밋**. 미확정 pending이 하나라도
   * 있으면 turn을 닫을 수도(`chargeTurnUsage`), task를 완료·차단할 수도 없다.
   *
   * **재시작 정합화**: **아직 집행 경계에 들어가지 않은**(`attemptedAt === null`) operation만 다시 열어
   * 새 grant를 받는다 — 멱등 재집행 후 영수증을 커밋하면 정확히 하나의 결과로 수렴한다.
   * 이미 집행 경계에 들어간 pending은 **다시 열리지 않는다**(3A 4차 리비전 A2: `effect(g1)` → 재발급 →
   * `effect(g2)`가 두 번째 효과를 내는 경로를 닫는다). 그런 pending은 살아 있는 grant의 결과 영수증 또는
   * `reconcileUncertainOperation()`의 `outcome_unknown`으로만 정직하게 닫힌다.
   */
  beginOperation(input: { permit: unknown; operationId: string; actionId: string }): OperationExecutionGrant {
    const operationId = assertSlug(input?.operationId, "operationId");
    const actionId = assertSlug(input?.actionId, "actionId");
    const { permit, record } = genuinePermit(input?.permit, this);
    const op = record.plan.operations.find((o) => o.operationId === operationId);
    if (op === undefined) {
      throw new OrchestrationError("dispatch_operation_unbound", `operation ${operationId}는 이 permit의 계획에 없다`);
    }
    // 등록도 효과의 일부이므로 **집행 게이트와 같은 판정**을 먼저 지난다(만료·토큰·wall·no-progress 포함).
    const current = requireDispatchableTask(this.#state, permit, record, formatTimestamp(this.#clock()));
    if (current.execution.operationReceipts.some((r) => r.operationId === operationId)) {
      throw new OrchestrationError("operation_already_recorded", `이미 기록된 operation이다: ${operationId}`);
    }
    // **재시작·재시도 정합화**: 같은 (operation, attempt, turn, 계획)이 이미 열려 있으면 새 커밋 없이
    // grant만 다시 준다 — 재집행은 멱등이고 영수증 커밋이 정확히 하나로 수렴한다.
    const already = current.execution.pendingOperations.find((p) => p.operationId === operationId);
    if (already !== undefined) {
      const pending = requirePendingOperation(current, permit, record.planDigest, operationId);
      assertNotAttempted(pending);
      return this.#issueGrant(permit, op, operationId, record.planDigest);
    }

    this.#mutate((draft, now) => {
      const task = requireDispatchableTask(draft, permit, record, now);
      if (task.execution.operationReceipts.some((r) => r.operationId === operationId)) {
        throw new OrchestrationError("operation_already_recorded", `이미 기록된 operation이다: ${operationId}`);
      }
      if (task.execution.pendingOperations.some((p) => p.operationId === operationId)) {
        throw new OrchestrationError("dispatch_operation_unregistered", `operation ${operationId}이 이미 열려 있다`);
      }
      if (task.execution.pendingOperations.length >= LIMITS.maxPendingOperations) {
        throw new OrchestrationError(
          "operation_limit_exceeded",
          `정합화되지 않은 operation은 ${LIMITS.maxPendingOperations}건까지다`,
        );
      }
      // **영수증 자리를 먼저 예약한다**(3A 5차 리비전 A5). 4차 판은 **동시 pending 용량만** 봤으므로
      // 같은 attempt의 뒤 turn이 영수증 64건 위에서 65번째 operation을 열 수 있었다 → 영수증 커밋도
      // handle-free 정합화도 상한에서 거부되는데 attempt를 떠나는 전이는 전부 pending 0을 요구하므로
      // 그 pending은 **어떤 경로로도 닫히지 않는 영구 미아**였다. 예약 불변식은
      // `operationReceipts.length + pendingOperations.length <= maxOperationReceipts`이고 store load도 본다.
      if (task.execution.operationReceipts.length + task.execution.pendingOperations.length >= LIMITS.maxOperationReceipts) {
        throw new OrchestrationError(
          "operation_limit_exceeded",
          `attempt당 영수증 용량(${LIMITS.maxOperationReceipts}건)을 예약할 수 없다 — 닫을 수 없는 operation은 열지 않는다`,
        );
      }
      const pending: PendingOperation = {
        operationId,
        kind: op.kind,
        authorityId: op.authorityId,
        attemptId: permit.attemptId,
        turnId: permit.turnId,
        planDigest: record.planDigest,
        beganAt: now,
        // 아직 아무 효과도 시도되지 않았다 — 집행 경계 진입은 `#markOperationAttempted`가 따로 적는다.
        attemptedAt: null,
      };
      task.execution = {
        ...task.execution,
        pendingOperations: [...task.execution.pendingOperations, pending].sort((a, b) =>
          a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
        ),
      };
      return {
        events: [
          event({
            at: now,
            type: "operation_began",
            revision: draft.revision,
            taskId: permit.taskId,
            actionId,
            attemptId: permit.attemptId,
            turnId: permit.turnId,
            operationId,
            planDigest: record.planDigest,
          }),
        ],
        bodies: [],
      };
    });

    return this.#issueGrant(permit, op, operationId, record.planDigest);
  }

  /**
   * 일회용 grant 하나를 발급하고, 그 grant에 **이 kernel에 묶인** `markAttempted` 클로저를 심는다
   * (3A 4차 리비전 A2 — 집행 경계 진입을 durable에 먼저 적는 유일한 통로다).
   */
  #issueGrant(
    permit: OperationDispatchPermit,
    op: TypedOperation,
    operationId: string,
    planDigest: string,
  ): OperationExecutionGrant {
    // `markAttempted`는 **이 인스턴스의** private 전이를 부르는 클로저다 → grant 실행은 발급 kernel의
    // state로만 작용하고, 다른 kernel을 이 클로저로 바꿀 통로가 없다(A2).
    return newGrant(this, permit, op, operationId, planDigest, () =>
      this.#markOperationAttempted(permit, planDigest, operationId),
    );
  }

  /**
   * **"외부 효과가 일어났을 수 있다"를 durable pending에 먼저 적는다**(3A 4차 리비전 A2).
   *
   * safety-only 커밋이다: 만료·예산 deadline·`cleaning`이 이 기록을 막으면 불확실 구간 자체가 durable에
   * 남지 않아 정합화가 불가능해진다(그것이 A-3의 미아 pending이다). 이미 표시돼 있으면 아무것도 하지 않는다.
   */
  #markOperationAttempted(permit: OperationDispatchPermit, planDigest: string, operationId: string): void {
    {
      const task = requireReconcilableTask(this.#state, permit);
      const pending = requirePendingOperation(task, permit, planDigest, operationId);
      if (pending.attemptedAt !== null) return; // 멱등
    }
    this.#mutate(
      (draft, now) => {
        const task = requireReconcilableTask(draft, permit);
        const pending = requirePendingOperation(task, permit, planDigest, operationId);
        task.execution = {
          ...task.execution,
          pendingOperations: task.execution.pendingOperations.map((p) =>
            p.operationId === operationId ? { ...p, attemptedAt: now } : p,
          ),
        };
        return {
          events: [
            event({
              at: now,
              type: "operation_attempted",
              revision: draft.revision,
              taskId: permit.taskId,
              attemptId: pending.attemptId,
              turnId: pending.turnId,
              operationId,
              planDigest: pending.planDigest,
            }),
          ],
          bodies: [],
        };
      },
      { safetyOnly: true },
    );
  }

  /**
   * **집행한 typed operation 1건의 결과를 durable에 남긴다**(내용은 담지 않는다).
   *
   * 3A 3차 리비전 A2 — 이 메서드는 **호출자가 만든 영수증을 받지 않는다.** 받는 것은
   * `executeUnderGrant()`가 돌려준 **opaque outcome handle** 하나뿐이고, durable에 적히는
   * marker·path·resultSha256·exitCode는 **집행기가 낸 canonical 값**(grant 안에 저장된 것)이다 —
   * handle의 필드를 고쳐 넣거나 전개 사본을 만들어도 소용이 없다(등록부 조회로 거부된다).
   *
   * 3A 3차 리비전 A3 — 영수증 커밋은 **safety-only 정합화 전이**다. 만료·예산 deadline·attempt wall·
   * no-progress를 넘긴 뒤에도, `cleaning`으로 내려간 뒤에도 **반드시 가능해야 한다**: 그러지 않으면
   * "효과는 일어났는데 durable에 기록할 방법이 없는" pending이 생기고, 그 pending은 아무 전이로도
   * 빠져나갈 수 없다. 대신 **신원은 그대로 전수 확인**한다(run·task·attempt·turn·계획·operation·kind·
   * authority). 전진 작업은 하나도 하지 않으므로 만료 뒤에 새로 생기는 권한·산출물·성공은 0이다.
   */
  recordOperationReceipt(input: { outcome: unknown; actionId: string }): OrchestrationTask {
    const actionId = assertSlug(input?.actionId, "actionId");
    const handle = input?.outcome;
    const rec = typeof handle === "object" && handle !== null ? GENUINE_OUTCOMES.get(handle) : undefined;
    if (rec === undefined) {
      throw new OrchestrationError("invalid_receipt", "집행 결과가 kernel 발급 outcome handle이 아니다(구조적 영수증 금지)");
    }
    // **발급 인스턴스까지 대조한다**(3A 5차 리비전 A2): 형제 kernel의 진짜 outcome을 이 run의 durable
    // 성공으로 커밋할 수 없다(같은 durable ID를 쓰는 두 번째 workspace 포함).
    if (rec.issuer !== this) {
      throw new OrchestrationError("invalid_receipt", "집행 결과가 이 kernel 인스턴스의 발급 값이 아니다");
    }
    if (rec.state !== "attempted" || rec.outcome === null) {
      throw new OrchestrationError("dispatch_grant_spent", "이미 소비된 집행 결과다(영수증은 한 번만 커밋된다)");
    }
    return this.#commitOperationOutcome(rec, rec.outcome, actionId);
  }

  /**
   * **집행을 시도하지 않은 operation을 닫는다**(3A 3차 리비전 A2 · 4차 리비전 A2로 좁혔다).
   * `denied`/`failed`만 가능하다 — 성공 marker를 만들 수 있는 통로는 operation kind별 고정 집행기뿐이다.
   *
   * **집행 경계에 들어간 pending은 여기서 닫히지 않는다**(4차 리비전 A2): 부분 외부 효과 뒤에 예외가 나면
   * 이전 판은 그것을 평범한 `failed` 영수증으로 **지울 수 있었다**. 그런 pending은 불확실로 남고
   * `reconcileUncertainOperation()`의 `outcome_unknown`으로만 정직하게 닫힌다.
   */
  failOperation(input: { grant: unknown; actionId: string; marker: "denied" | "failed" }): OrchestrationTask {
    const actionId = assertSlug(input?.actionId, "actionId");
    const marker = enumOf(input?.marker, ["denied", "failed"] as const, "marker");
    const rec = genuineGrant(input?.grant, this);
    if (rec.state === "consumed") {
      throw new OrchestrationError("dispatch_grant_spent", "이미 소비된 execution grant다");
    }
    if (rec.state === "attempted") {
      throw new OrchestrationError(
        "invalid_receipt",
        "집행 결과가 있는 grant는 그 결과로 닫아야 한다(recordOperationReceipt)",
      );
    }
    {
      // durable 진실이 "시도됐을 수 있다"면 평범한 실패로 닫을 수 없다(예외가 부분 효과를 지우는 경로 차단).
      const planDigest = GENUINE_PERMITS.get(rec.permit)!.planDigest;
      const task = requireReconcilableTask(this.#state, rec.permit);
      assertNotAttempted(requirePendingOperation(task, rec.permit, planDigest, rec.op.operationId));
    }
    return this.#commitOperationOutcome(rec, { marker, path: null, resultSha256: null, exitCode: null }, actionId);
  }

  /**
   * **재시작 안전한 safety-only 정합화**(3A 4차 리비전 A3 — 독립 리뷰가 요구한 durable pending-keyed 경로).
   *
   * 이전 판의 결함: permit·grant·outcome handle은 전부 **프로세스 메모리 `WeakMap`**이었다. 재시작하면
   * `cleaning` pending은 새 permit을 받을 수 없고(`issueOperationDispatchPermit`은 `running`을 요구한다),
   * 만료·deadline을 넘긴 `running`도 마찬가지이며, 옛 handle이 없으니 `recordOperationReceipt`도
   * `failOperation`도 부를 수 없었다 → 그 pending은 **영구 미아**가 되고 attempt를 떠나는 모든 전이가
   * 무한히 막혔다.
   *
   * 이 경로는 handle을 **하나도** 요구하지 않는다. 대신 호출자가 durable 신원 전부
   * (`run/task/attempt/turn/plan/operation/kind/authority`)를 **정확히** 제시해야 하고, 저장된 pending
   * 레코드와 전수 대조해 하나라도 어긋나면 거부한다.
   *
   * **성공은 만들 수 없다.** marker는 호출자 입력이 아니라 **durable 진실에서 파생**된다:
   * 집행 경계에 들어간 pending(`attemptedAt !== null`)은 `outcome_unknown`, 들어가지 않은 것은 `failed`다.
   * 경로·hash·exit code는 전부 `null`이며 "외부 효과가 일어나지 않았다"고 단정하지 않는다.
   *
   * safety-only이므로 만료·예산 deadline·attempt wall·no-progress를 넘긴 뒤에도, `cleaning`으로 내려간
   * 뒤에도 지난다. 정합화가 끝나면 pending이 사라지므로 cleanup·settle이 정상 진행된다.
   */
  reconcileUncertainOperation(input: {
    runId: string;
    taskId: string;
    attemptId: string;
    turnId: string;
    planDigest: string;
    operationId: string;
    kind: string;
    authorityId: string;
    actionId: string;
  }): OrchestrationTask {
    const runId = assertSlug(input?.runId, "runId");
    const taskId = assertSlug(input?.taskId, "taskId");
    const attemptId = assertSlug(input?.attemptId, "attemptId");
    const turnId = assertSlug(input?.turnId, "turnId");
    const planDigest = assertSha256Local(input?.planDigest);
    const operationId = assertSlug(input?.operationId, "operationId");
    const kind = enumOf(input?.kind, APPROVED_OPERATION_KINDS, "kind");
    const authorityId = assertSlug(input?.authorityId, "authorityId");
    const actionId = assertSlug(input?.actionId, "actionId");
    // 신원 묶음은 permit과 **같은 모양**이지만 권위가 아니다 — 여기서 하는 일은 대조뿐이고 결과는
    // 성공이 될 수 없다(그래서 kernel 발급 handle 없이도 안전하다).
    const identity = { runId, taskId, attemptId, turnId } as OperationDispatchPermit;
    let pendingKey = "";
    this.#mutate(
      (draft, now) => {
        const task = requireReconcilableTask(draft, identity);
        const pending = requirePendingOperation(task, identity, planDigest, operationId);
        if (pending.kind !== kind || pending.authorityId !== authorityId) {
          throw new OrchestrationError("invalid_receipt", "durable pending 레코드의 kind·authority가 제시한 신원과 다르다");
        }
        if (task.execution.operationReceipts.length >= LIMITS.maxOperationReceipts) {
          throw new OrchestrationError("operation_limit_exceeded", `attempt당 영수증은 ${LIMITS.maxOperationReceipts}건까지다`);
        }
        pendingKey = JSON.stringify([runId, taskId, attemptId, turnId, planDigest, operationId]);
        // **marker는 durable 진실에서 파생된다**(호출자가 고를 수 없다 — 성공도 불가능하다).
        const marker: OperationReceipt["marker"] = pending.attemptedAt === null ? "failed" : "outcome_unknown";
        const receipt: OperationReceipt = {
          operationId: pending.operationId,
          kind: pending.kind,
          authorityId: pending.authorityId,
          attemptId: pending.attemptId,
          turnId: pending.turnId,
          planDigest: pending.planDigest,
          path: null,
          resultSha256: null,
          exitCode: null,
          marker,
          at: now,
        };
        task.execution = {
          ...task.execution,
          pendingOperations: task.execution.pendingOperations.filter((p) => p.operationId !== operationId),
          operationReceipts: [...task.execution.operationReceipts, receipt],
        };
        return {
          events: [
            event({
              at: now,
              type: "operation_receipt",
              revision: draft.revision,
              taskId,
              actionId,
              attemptId: pending.attemptId,
              turnId: pending.turnId,
              operationId,
              planDigest: pending.planDigest,
              marker,
            }),
          ],
          bodies: [],
        };
      },
      { safetyOnly: true },
    );
    // 이 인스턴스에 아직 살아 있는 grant가 있었다면 그 자리에서 죽인다(정합화 뒤 영수증 재발행 차단).
    killLiveGrant(this, pendingKey);
    return clone(requireTask(this.#state, taskId));
  }

  /** 영수증 커밋 하나(성공·실패 공통). **safety-only**이므로 만료·deadline·cleaning 뒤에도 지난다. */
  #commitOperationOutcome(rec: GrantRecord, outcome: EffectOutcome, actionId: string): OrchestrationTask {
    const permit = rec.permit;
    const planDigest = GENUINE_PERMITS.get(permit)!.planDigest;
    this.#mutate(
      (draft, now) => {
        const task = requireReconcilableTask(draft, permit);
        const pending = requirePendingOperation(task, permit, planDigest, rec.op.operationId);
        // pending 레코드가 이 operation의 kind·authority와 다르면 정합화 대상이 아니다(치환 금지).
        if (pending.kind !== rec.op.kind || pending.authorityId !== rec.op.authorityId) {
          throw new OrchestrationError("invalid_receipt", "durable pending 레코드의 kind·authority가 이 operation과 다르다");
        }
        if (task.execution.operationReceipts.length >= LIMITS.maxOperationReceipts) {
          throw new OrchestrationError("operation_limit_exceeded", `attempt당 영수증은 ${LIMITS.maxOperationReceipts}건까지다`);
        }
        const receipt: OperationReceipt = {
          operationId: pending.operationId,
          kind: pending.kind,
          authorityId: pending.authorityId,
          attemptId: pending.attemptId,
          turnId: pending.turnId,
          planDigest: pending.planDigest,
          path: outcome.path,
          resultSha256: outcome.resultSha256,
          exitCode: outcome.exitCode,
          marker: outcome.marker,
          at: now,
        };
        task.execution = {
          ...task.execution,
          pendingOperations: task.execution.pendingOperations.filter((p) => p.operationId !== receipt.operationId),
          operationReceipts: [...task.execution.operationReceipts, receipt],
        };
        return {
          events: [
            event({
              at: now,
              type: "operation_receipt",
              revision: draft.revision,
              taskId: permit.taskId,
              actionId,
              attemptId: pending.attemptId,
              turnId: pending.turnId,
              operationId: receipt.operationId,
              planDigest: pending.planDigest,
              marker: receipt.marker,
            }),
          ],
          bodies: [],
        };
      },
      { safetyOnly: true },
    );
    // 커밋이 성공한 뒤에만 소비 처리한다(실패하면 같은 결과로 다시 시도할 수 있어야 한다).
    consumeGrant(rec);
    return clone(requireTask(this.#state, permit.taskId));
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

/**
 * **인정되는 진행 신호의 닫힌 모양**(3A 3차 리비전 A1). worker 스트림의 `progress` 이벤트만 no-progress
 * 시계를 되돌린다 — `heartbeat`·미상 이벤트·구조 없는 호출은 여기서 거부된다(`autopilotTypes.WorkerEvent`).
 * `step` 라벨은 **durable state에 들어가지 않는다**(내용 비유출) — 형태만 본다.
 */
const PROGRESS_EVENT_KEYS = ["kind", "seq", "step"] as const;

function adoptProgressEvent(raw: unknown): number {
  const read = readClosedOnce(raw, PROGRESS_EVENT_KEYS, "진행 이벤트");
  if (read.kind !== "progress") {
    throw new OrchestrationError("invalid_progress_event", "progress 이벤트만 no-progress 시계를 되돌린다");
  }
  if (typeof read.seq !== "number" || !Number.isInteger(read.seq) || read.seq < 0 || read.seq > MAX_WORKER_EVENTS) {
    throw new OrchestrationError("invalid_progress_event", `progress.seq는 0..${MAX_WORKER_EVENTS} 정수여야 한다`);
  }
  if (typeof read.step !== "string" || read.step.length === 0 || codePointLength(read.step) > MAX_PROGRESS_STEP_CHARS) {
    throw new OrchestrationError("invalid_progress_event", `progress.step은 1..${MAX_PROGRESS_STEP_CHARS} 코드 포인트여야 한다`);
  }
  return read.seq;
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
  // **미확정 operation이 남은 채로 종료 상태에 가지 않는다**(3A 2차 리비전 A2): 효과를 냈는데 결과 전이가
  // 없는 구간이 "완료"나 "차단"으로 덮이면 durable 기록이 곧 거짓이 된다.
  if (task.execution.pendingOperations.length > 0) {
    throw new OrchestrationError(
      "operation_pending_unreconciled",
      `${what}: 정합화되지 않은 typed operation이 남아 있다 (${task.taskId})`,
    );
  }
  // **[V3 M7 T6] 사람 gate**: 답 없는 `decision_request`를 남긴 채 **완료**할 수 없다(로드맵 §6 —
  // "Founder 판단은 최종 사람 승인 게이트이고 모델 출력은 조언·요약이며 사람 권한을 대체하지 않는다").
  // `decision`은 중앙 API(`recordDecision`)로만 생기고 agent 요청 union에는 그 갈래가 없다 → 결정을
  // 기다리는 task가 스스로 완료로 넘어가는 경로를 여기서 닫으면 **사람 없이 진행하는 길이 없다.**
  // `blocker`는 막지 않는다 — 차단은 진행이 아니라 정지이고, 결정 대기를 사람에게 드러내는 정상 경로다.
  if (what === "result") {
    const asked = state.messages.filter((m) => m.type === "decision_request" && m.taskId === task.taskId).length;
    const answered = state.messages.filter((m) => m.type === "decision" && m.taskId === task.taskId).length;
    if (answered < asked) {
      throw new OrchestrationError(
        "decision_pending",
        `${what}: 답 없는 decision_request가 남아 있다 (${task.taskId}) — 사람 결정 없이 완료할 수 없다`,
      );
    }
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
  // **호출자가 던진 것은 종류를 가리지 않고 접는다**(3A 2차 리비전 — 대장 `C-38`의 kernel 행).
  // 이전에는 `catch`가 `OrchestrationError`를 그대로 다시 던져, 던지는 getter/`ownKeys` trap이
  // **production 오류 코드를 고를 수 있었다**. 지금은 우리 오류만 `try` 밖에서 던진다.
  const hostile = (): OrchestrationError =>
    new OrchestrationError("invalid_artifact_ref", `${what}를 읽을 수 없다(getter/proxy가 던졌다)`);
  let ownKeys: Array<string | symbol>;
  try {
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    throw hostile();
  }
  for (const k of ownKeys) {
    if (typeof k !== "string" || !allowed.includes(k)) {
      throw new OrchestrationError("invalid_artifact_ref", `${what}에 허용되지 않은 필드가 있다(허용: ${allowed.join(", ")})`);
    }
  }
  const read: Record<string, unknown> = {};
  for (const k of allowed) {
    try {
      read[k] = (raw as Record<string, unknown>)[k]; // ← 각 property를 읽는 유일한 지점
    } catch {
      throw hostile();
    }
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
 *
 * **`state.updatedAt`도 함께 본다**(3A 4차 리비전 A1). 3차 판은 여기서 run 시작 시각 두 개만 봤고
 * `#mutate`는 `draft.updatedAt = now`로 **덮어썼다** → safety-only 커밋(회계·정리·취소·pause) 하나로
 * `updatedAt`을 **뒤로 돌릴** 수 있었고, 그러면 `updatedAt`을 상한으로 쓰는 효과 게이트의 시계 단조
 * 판정이 무력해져 attempt wall·no-progress 창이 다시 열렸다. `updatedAt`은 마지막 커밋 시각이므로
 * `phaseStartedAt`·`lastProgressAt`을 포함한 **모든 durable 시각의 상한**이다 — 여기서 한 번 막으면
 * 모든 mutation 경로(전진·safety-only)가 같은 규칙을 지난다.
 */
function assertClockSane(state: OrchestrationRunState, now: string): void {
  if (now < state.createdAt || now < state.accounting.budgetStartedAt || now < state.updatedAt) {
    throw new OrchestrationError("clock_invalid", `커밋 시각이 durable 기록보다 이르다(now ${now})`);
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
