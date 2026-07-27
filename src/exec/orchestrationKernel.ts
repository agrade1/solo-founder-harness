/**
 * V3 M4a — deterministic durable orchestration kernel (로드맵 §3.1/§3.4/§4/§5).
 *
 * **중앙 kernel만이 상태 전이 주체다.** agent(호출자)는 메시지를 제출할 뿐이고 다른 task의
 * 상태·의존성·완료를 직접 바꾸는 API는 존재하지 않는다. 읽기 API는 전부 깊은 사본을 돌려주므로
 * 반환값을 수정해도 내부 state는 바뀌지 않는다.
 *
 * 이 커널은 **state-only/offline**이다: provider도 LLM도 프로세스도 띄우지 않는다.
 * 실제 agent 실행·7 specialist registry·scheduler·exclusive resource class·approval manifest는
 * M4a 범위 밖이며, roleId는 그것들을 나중에 그대로 수용하도록 **opaque slug 계약**으로 둔다.
 *
 * 불변식:
 * - 유효하지 않은 입력은 state revision을 올리지 않고 영속 파일도 건드리지 않는다(검증 → 커밋 순서).
 * - `listReady()`와 snapshot은 taskId 정렬로 결정론적이다.
 * - 중앙이 운반하는 것은 bounded summary와 **검증된 artifact 포인터**뿐 — raw 본문·transcript 없음.
 */
import {
  type AgentMessageEnvelope,
  type AgentMessageType,
  type ArtifactPointer,
  type ArtifactRecord,
  type ArtifactRole,
  ARTIFACT_ROLES,
  type Clock,
  LIMITS,
  type MessageIndexEntry,
  ORCHESTRATION_SCHEMA_VERSION,
  ORCHESTRATOR_ID,
  type OrchestrationEvent,
  OrchestrationError,
  type OrchestrationRunState,
  type OrchestrationTask,
  type TaskState,
  type TransitionReason,
  assertSlug,
  assertText,
  formatTimestamp,
  normalizeOwnership,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { validateEnvelope, validateMessageBody } from "./agentMessage.js";
import {
  type RunPaths,
  assertReferentialIntegrity,
  commitRun,
  ensureRunDir,
  loadRun,
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

export interface RegisterArtifactInput {
  taskId: string;
  /** workspace-relative 경로. */
  path: string;
  role: ArtifactRole;
}

interface Mutation {
  events: Array<Omit<OrchestrationEvent, "prevHash" | "eventId" | "stateDigest">>;
  bodies: Array<{ messageId: string; body: string }>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class OrchestrationKernel {
  readonly paths: RunPaths;
  #state: OrchestrationRunState;
  readonly #clock: Clock;

  private constructor(paths: RunPaths, state: OrchestrationRunState, clock: Clock) {
    this.paths = paths;
    this.#state = state;
    this.#clock = clock;
  }

  /** 새 run 생성. 이미 있으면 거부한다(조용한 덮어쓰기 금지). */
  static create(opts: { workspaceRoot: string; runId: string; milestoneId: string; clock?: Clock }): OrchestrationKernel {
    const paths = runPaths(opts.workspaceRoot, opts.runId);
    if (runExists(paths)) {
      throw new OrchestrationError("run_already_exists", `이미 존재하는 run이다: ${opts.runId}`);
    }
    const clock = opts.clock ?? (() => new Date());
    const now = formatTimestamp(clock());
    const milestoneId = assertSlug(opts.milestoneId, "milestoneId");
    const seed: OrchestrationRunState = {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      runId: paths.runId,
      milestoneId,
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
      events: [
        {
          at: now,
          type: "run_created",
          revision: 1,
          taskId: null,
          messageId: null,
          fromState: null,
          toState: null,
          reason: null,
          artifactId: null,
        },
      ],
      bodies: [],
    });
    return new OrchestrationKernel(paths, committed, clock);
  }

  /** 기존 run 적재. state/event/message/artifact 검증에 실패하면 던진다(fail-closed). */
  static open(opts: { workspaceRoot: string; runId: string; clock?: Clock }): OrchestrationKernel {
    const paths = runPaths(opts.workspaceRoot, opts.runId);
    const { state } = loadRun(paths);
    return new OrchestrationKernel(paths, state, opts.clock ?? (() => new Date()));
  }

  // ── 읽기 (전부 깊은 사본) ────────────────────────────────────────────────

  getState(): OrchestrationRunState {
    return clone(this.#state);
  }

  getTask(taskId: string): OrchestrationTask | null {
    const t = this.#state.tasks.find((x) => x.taskId === taskId);
    return t ? clone(t) : null;
  }

  /** ready task 목록 — taskId 오름차순 고정(결정론적). */
  listReady(): OrchestrationTask[] {
    return this.#state.tasks.filter((t) => t.state === "ready").map(clone);
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

  /** ready → running. */
  startTask(taskId: string): OrchestrationTask {
    this.#mutate((draft, now) => {
      const t = requireTask(draft, assertSlug(taskId, "taskId"));
      if (t.state !== "ready") {
        throw new OrchestrationError("invalid_transition", `startTask는 ready task만 가능하다 (현재 ${t.state})`);
      }
      const mutation: Mutation = { events: [], bodies: [] };
      setState(draft, now, mutation, t, "running", "started");
      return mutation;
    });
    return clone(requireTask(this.#state, taskId));
  }

  /**
   * workspace 안 실제 파일을 artifact로 등록한다. 조용히 덮어쓰지 않고 revision을 올리며
   * 직전 revision을 `supersedes`로 남긴다. symlink/missing/비일반 파일/workspace 탈출은 fail-closed.
   */
  registerArtifact(input: RegisterArtifactInput): ArtifactPointer {
    let pointer: ArtifactPointer | null = null;
    this.#mutate((draft, now) => {
      const task = requireTask(draft, assertSlug(input.taskId, "taskId"));
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `artifact 등록은 running task만 가능하다 (현재 ${task.state})`);
      }
      if (!(ARTIFACT_ROLES as readonly string[]).includes(input.role)) {
        throw new OrchestrationError("invalid_artifact_ref", `role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
      }
      const path = normalizeWorkspacePath(input.path, "artifact path");
      const sha256 = verifyArtifactFile(this.paths.workspaceRoot, path, null);

      const prior = draft.artifacts.filter((a) => a.path === path).sort((a, b) => a.revision - b.revision).pop() ?? null;
      const revision = prior === null ? 1 : prior.revision + 1;
      const record: ArtifactRecord = {
        artifactId: `${path}@${revision}`,
        path,
        sha256,
        revision,
        producerTaskId: task.taskId,
        role: input.role,
        registeredAt: now,
        supersedes: prior === null ? null : prior.artifactId,
      };
      draft.artifacts.push(record);
      pointer = { path, sha256, revision, producerTaskId: task.taskId, role: input.role };
      return {
        events: [
          {
            at: now,
            type: "artifact_registered",
            revision: draft.revision,
            taskId: task.taskId,
            messageId: null,
            fromState: null,
            toState: null,
            reason: null,
            artifactId: record.artifactId,
          },
        ],
        bodies: [],
      };
    });
    return clone(pointer!);
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
      const task = requireTask(draft, envelope.taskId);
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `result는 running task만 제출할 수 있다 (현재 ${task.state})`);
      }
      const mutation: Mutation = { events: [], bodies: [] };
      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary);
      task.artifactRefs = envelope.artifactRefs.map(clone);
      task.resultSummary = summary;
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
      const task = requireTask(draft, envelope.taskId);
      if (task.state !== "running") {
        throw new OrchestrationError("invalid_transition", `blocker는 running task만 제출할 수 있다 (현재 ${task.state})`);
      }
      const mutation: Mutation = { events: [], bodies: [] };
      acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary);
      task.blockerSummary = summary;
      setState(draft, now, mutation, task, "blocked", "blocker_accepted");
      recompute(draft, now, mutation);
      blocked = task;
      return mutation;
    });
    return clone(blocked!);
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

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
   */
  #mutate(fn: (draft: OrchestrationRunState, now: string) => Mutation): void {
    const now = formatTimestamp(this.#clock());
    const draft = clone(this.#state);
    draft.revision += 1;
    draft.updatedAt = now;
    const mutation = fn(draft, now);

    draft.tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    draft.messages.sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
    draft.artifacts.sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
    assertReferentialIntegrity(draft);

    this.#state = commitRun(this.paths, { state: draft, events: mutation.events, bodies: mutation.bodies });
  }
}

// ── 순수 헬퍼 (draft 조작) ──────────────────────────────────────────────────

function requireTask(state: OrchestrationRunState, taskId: string): OrchestrationTask {
  const t = state.tasks.find((x) => x.taskId === taskId);
  if (!t) throw new OrchestrationError("unknown_task", `미상 task: ${taskId}`);
  return t;
}

function setState(
  draft: OrchestrationRunState,
  now: string,
  mutation: Mutation,
  task: OrchestrationTask,
  to: TaskState,
  reason: TransitionReason,
): void {
  if (task.state === to) return;
  mutation.events.push({
    at: now,
    type: "task_state_changed",
    revision: draft.revision,
    taskId: task.taskId,
    messageId: null,
    fromState: task.state,
    toState: to,
    reason,
    artifactId: null,
  });
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
    roleId: assertSlug(seed.roleId, "roleId"),
    title: assertText(seed.title, "title", LIMITS.maxTextLength),
    scope: assertText(seed.scope, "scope", LIMITS.maxTextLength),
    ownership: normalizeOwnership(seed.ownership, "ownership"),
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
  };
  draft.tasks.push(task);
  mutation.events.push({
    at: now,
    type: "task_created",
    revision: draft.revision,
    taskId,
    messageId: null,
    fromState: null,
    toState: "pending",
    reason: "created",
    artifactId: null,
  });
  if (dependsOn.length === 0) setState(draft, now, mutation, task, "ready", "created");

  // task_assignment는 중앙 kernel이 보낸다 (sender=orchestrator, recipient=task role).
  const envelope: AgentMessageEnvelope = {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
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
): void {
  const envelope = rawEnvelope;
  const body = validateMessageBody(envelope.type, rawBody);

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
  };
  draft.messages.push(entry);
  mutation.bodies.push({ messageId: envelope.messageId, body });
  mutation.events.push({
    at: now,
    type: "message_accepted",
    revision: draft.revision,
    taskId: envelope.taskId,
    messageId: envelope.messageId,
    fromState: null,
    toState: null,
    reason: null,
    artifactId: null,
  });
}

/** 통신 방향 계약(§5.3): task_assignment는 중앙→agent, 나머지 3종은 agent→중앙뿐이다. */
function assertDirection(envelope: AgentMessageEnvelope, task: OrchestrationTask): void {
  const central: AgentMessageType[] = ["task_assignment"];
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

/** 편의 진입점 — production 기본 root는 `<workspace>/outputs/orchestration`이다. */
export function createOrchestrationRun(opts: {
  workspaceRoot: string;
  runId: string;
  milestoneId: string;
  clock?: Clock;
}): OrchestrationKernel {
  return OrchestrationKernel.create(opts);
}

export function openOrchestrationRun(opts: { workspaceRoot: string; runId: string; clock?: Clock }): OrchestrationKernel {
  return OrchestrationKernel.open(opts);
}
