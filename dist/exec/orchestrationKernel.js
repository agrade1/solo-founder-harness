/**
 * V3 M4a/M4b — deterministic durable orchestration kernel (로드맵 §3.1/§3.4/§4/§5).
 *
 * **중앙 kernel만이 상태 전이 주체다.** agent(호출자)는 메시지를 제출할 뿐이고 다른 task의
 * 상태·의존성·완료를 직접 바꾸는 API는 존재하지 않는다. 읽기 API는 전부 깊은 사본을 돌려주므로
 * 반환값을 수정해도 내부 state는 바뀌지 않는다.
 *
 * 이 커널은 **state-only/offline**이다: provider도 LLM도 프로세스도 띄우지 않는다.
 * 실제 agent 실행·7 specialist registry·sibling/reviewer 라우팅·approval manifest는 아직 범위 밖이며,
 * roleId는 그것들을 나중에 그대로 수용하도록 **opaque slug 계약**으로 둔다.
 *
 * M4b가 더한 것 — **배타 자원 class와 결정론적 scheduler**(두 번째 오케스트레이터를 만들지 않고
 * 이 커널 안에 좁은 API 2개만 추가했다):
 * - `scheduleReady()` — 시작 가능한 ready task를 taskId 순으로 고른다(state 변경 없음).
 * - `startScheduledBatch()` — 그 batch를 **한 커밋으로** running으로 올린다.
 * - `startTask()`도 같은 충돌 규칙을 적용하므로 scheduler를 우회할 수 없다.
 * queue·retry·priority·fairness·실제 동시 실행은 범위 밖이다.
 *
 * 불변식:
 * - 유효하지 않은 입력은 state revision을 올리지 않고 영속 파일도 건드리지 않는다(검증 → 커밋 순서).
 * - `listReady()`·`scheduleReady()`·snapshot은 taskId 정렬로 결정론적이다.
 * - 같은 배타 자원 class를 요구하는 두 task는 **동시에 running이 되지 않는다**(커밋·load 양쪽 검사).
 * - 중앙이 운반하는 것은 bounded summary와 **검증된 artifact 포인터**뿐 — raw 본문·transcript 없음.
 */
import { ARTIFACT_ROLES, LIMITS, ORCHESTRATION_SCHEMA_VERSION, ORCHESTRATOR_ID, OrchestrationError, assertSlug, assertText, formatTimestamp, normalizeOwnership, normalizeResourceClasses, normalizeWorkspacePath, } from "./orchestrationTypes.js";
import { validateEnvelope, validateMessageBody } from "./agentMessage.js";
import { assertReferentialIntegrity, commitRun, ensureRunDir, loadRun, runExists, runPaths, sha256Hex, verifyArtifactFile, writeSnapshot, } from "./orchestrationStore.js";
const clone = (v) => structuredClone(v);
export class OrchestrationKernel {
    paths;
    #state;
    #clock;
    constructor(paths, state, clock) {
        this.paths = paths;
        this.#state = state;
        this.#clock = clock;
    }
    /** 새 run 생성. 이미 있으면 거부한다(조용한 덮어쓰기 금지). */
    static create(opts) {
        const paths = runPaths(opts.workspaceRoot, opts.runId);
        if (runExists(paths)) {
            throw new OrchestrationError("run_already_exists", `이미 존재하는 run이다: ${opts.runId}`);
        }
        const clock = opts.clock ?? (() => new Date());
        const now = formatTimestamp(clock());
        const milestoneId = assertSlug(opts.milestoneId, "milestoneId");
        const seed = {
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
            // 최초 커밋 — lock 안에서 "state 파일이 아직 없다"를 다시 확인한다(두 프로세스 동시 create 방지).
            base: null,
        });
        return new OrchestrationKernel(paths, committed, clock);
    }
    /** 기존 run 적재. state/event/message/artifact 검증에 실패하면 던진다(fail-closed). */
    static open(opts) {
        const paths = runPaths(opts.workspaceRoot, opts.runId);
        const { state } = loadRun(paths);
        return new OrchestrationKernel(paths, state, opts.clock ?? (() => new Date()));
    }
    // ── 읽기 (전부 깊은 사본) ────────────────────────────────────────────────
    getState() {
        return clone(this.#state);
    }
    getTask(taskId) {
        const t = this.#state.tasks.find((x) => x.taskId === taskId);
        return t ? clone(t) : null;
    }
    /** ready task 목록 — taskId 오름차순 고정(결정론적). */
    listReady() {
        return this.#state.tasks.filter((t) => t.state === "ready").map(clone);
    }
    /**
     * 다음에 시작할 수 있는 ready task를 **결정론적으로** 고른다(state·파일 변경 없음).
     * taskId 오름차순으로 훑으며 ① 이미 running인 task가 점유한 class와 ② 같은 batch에서 앞서 고른
     * task의 class를 모두 피한다. 자원을 요구하지 않는 task는 항상 병렬 안전이다.
     * durable state만 보므로 재시작 뒤에도 같은 답을 낸다.
     */
    scheduleReady(limit = LIMITS.maxScheduleBatch) {
        return selectSchedulable(this.#state, assertBatchLimit(limit)).map(clone);
    }
    /**
     * `scheduleReady()`가 고른 batch를 **한 커밋으로** running으로 올린다(부분 적용 없음 — 커밋
     * 하나가 실패하면 batch 전체가 전이 0이다). 고를 게 없으면 빈 배열이며 커밋하지 않는다.
     */
    startScheduledBatch(limit = LIMITS.maxScheduleBatch) {
        const ids = selectSchedulable(this.#state, assertBatchLimit(limit)).map((t) => t.taskId);
        if (ids.length === 0)
            return [];
        this.#mutate((draft, now) => {
            const mutation = { events: [], bodies: [] };
            for (const id of ids)
                setState(draft, now, mutation, requireTask(draft, id), "running", "started");
            return mutation;
        });
        return ids.map((id) => clone(requireTask(this.#state, id)));
    }
    getMessage(messageId) {
        const m = this.#state.messages.find((x) => x.messageId === messageId);
        return m ? clone(m) : null;
    }
    getArtifact(artifactId) {
        const a = this.#state.artifacts.find((x) => x.artifactId === artifactId);
        return a ? clone(a) : null;
    }
    /** state에서 snapshot.md를 결정론적으로 재생성한다(파생물 — state/event 변경 없음). */
    rebuildSnapshot() {
        return writeSnapshot(this.paths, this.#state);
    }
    // ── 변경 (전부 kernel 경유) ─────────────────────────────────────────────
    createRootTask(seed) {
        return this.#createTask({ ...seed, dependsOn: [] }, null);
    }
    createDependentTask(seed) {
        return this.#createTask(seed, null);
    }
    /**
     * parent가 제출한 `spawn_request`를 검증하고 child task를 만든다.
     * child도 같은 API로 자기 child를 요청할 수 있다(depth/개수 상한 안에서).
     */
    requestSpawn(input) {
        let created = null;
        this.#mutate((draft, now) => {
            const envelope = validateEnvelope(input.envelope);
            if (envelope.type !== "spawn_request") {
                throw new OrchestrationError("message_type_mismatch", "requestSpawn에는 spawn_request만 제출할 수 있다");
            }
            const parent = requireTask(draft, envelope.taskId);
            // 이미 한 번 spawn해서 waiting_children인 parent도 상한 안에서 child를 더 요청할 수 있다.
            if (parent.state !== "running" && parent.state !== "waiting_children") {
                throw new OrchestrationError("invalid_transition", `spawn_request는 running/waiting_children task만 제출할 수 있다 (현재 ${parent.state})`);
            }
            if (parent.childTaskIds.length >= LIMITS.maxChildrenPerTask) {
                throw new OrchestrationError("child_limit_exceeded", `task당 child는 ${LIMITS.maxChildrenPerTask}개까지다`);
            }
            const depth = parent.depth + 1;
            if (depth > LIMITS.maxDepth) {
                throw new OrchestrationError("depth_limit_exceeded", `child depth 상한은 ${LIMITS.maxDepth}이다 (요청 ${depth})`);
            }
            const mutation = { events: [], bodies: [] };
            const child = addTask(draft, now, mutation, { ...input.child, dependsOn: input.child.dependsOn ?? [] }, parent.taskId, depth);
            parent.childTaskIds.push(child.taskId);
            parent.childTaskIds.sort();
            setState(draft, now, mutation, parent, "waiting_children", "spawn_requested");
            acceptMessage(draft, now, mutation, this.paths, envelope, input.body, null);
            recompute(draft, now, mutation);
            created = child;
            return mutation;
        });
        return clone(created);
    }
    /**
     * ready → running. scheduler를 거치지 않는 직접 호출도 **같은 배타 자원 충돌 규칙**을 받는다:
     * 커밋 경로의 공용 불변식(`assertExclusiveResourceClaims`)이 running 두 개의 class 충돌을 거부하므로
     * 이 메서드에도, 앞으로 추가되는 어떤 전이 경로에도 우회로가 없다(`resource_conflict`, 전이 0).
     */
    startTask(taskId) {
        this.#mutate((draft, now) => {
            const t = requireTask(draft, assertSlug(taskId, "taskId"));
            if (t.state !== "ready") {
                throw new OrchestrationError("invalid_transition", `startTask는 ready task만 가능하다 (현재 ${t.state})`);
            }
            const mutation = { events: [], bodies: [] };
            setState(draft, now, mutation, t, "running", "started");
            return mutation;
        });
        return clone(requireTask(this.#state, taskId));
    }
    /**
     * workspace 안 실제 파일을 artifact로 등록한다. 조용히 덮어쓰지 않고 revision을 올리며
     * 직전 revision을 `supersedes`로 남긴다. symlink/missing/비일반 파일/workspace 탈출은 fail-closed.
     */
    registerArtifact(input) {
        let pointer = null;
        this.#mutate((draft, now) => {
            const task = requireTask(draft, assertSlug(input.taskId, "taskId"));
            if (task.state !== "running") {
                throw new OrchestrationError("invalid_transition", `artifact 등록은 running task만 가능하다 (현재 ${task.state})`);
            }
            if (!ARTIFACT_ROLES.includes(input.role)) {
                throw new OrchestrationError("invalid_artifact_ref", `role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
            }
            const path = normalizeWorkspacePath(input.path, "artifact path");
            const sha256 = verifyArtifactFile(this.paths.workspaceRoot, path, null);
            const prior = draft.artifacts.filter((a) => a.path === path).sort((a, b) => a.revision - b.revision).pop() ?? null;
            const revision = prior === null ? 1 : prior.revision + 1;
            const record = {
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
        return clone(pointer);
    }
    /**
     * `result` 수락 → task completed. 중앙으로 옮기는 것은 bounded summary와 **재검증된 포인터**뿐이다.
     * 수락 직전 모든 artifact를 등록 revision/hash와 현재 디스크 상태로 다시 확인한다(tamper fail-closed).
     */
    submitResult(input) {
        let done = null;
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
            const mutation = { events: [], bodies: [] };
            acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary);
            task.artifactRefs = envelope.artifactRefs.map(clone);
            task.resultSummary = summary;
            setState(draft, now, mutation, task, "completed", "result_accepted");
            recompute(draft, now, mutation);
            done = task;
            return mutation;
        });
        return clone(done);
    }
    /** `blocker` 수락 → task blocked. 영향받는 parent(조상)와 dependent도 kernel이 blocked로 갱신한다. */
    submitBlocker(input) {
        let blocked = null;
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
            const mutation = { events: [], bodies: [] };
            acceptMessage(draft, now, mutation, this.paths, envelope, input.body, summary);
            task.blockerSummary = summary;
            setState(draft, now, mutation, task, "blocked", "blocker_accepted");
            recompute(draft, now, mutation);
            blocked = task;
            return mutation;
        });
        return clone(blocked);
    }
    // ── 내부 ────────────────────────────────────────────────────────────────
    #createTask(seed, parentTaskId) {
        let created = null;
        this.#mutate((draft, now) => {
            const mutation = { events: [], bodies: [] };
            created = addTask(draft, now, mutation, seed, parentTaskId, 0);
            recompute(draft, now, mutation);
            return mutation;
        });
        return clone(created);
    }
    /**
     * 검증 → 커밋. fn이 던지면 `this.#state`도 디스크도 그대로다(전이 0).
     * fn은 draft(사본)만 만지고 이벤트/보디를 돌려준다.
     *
     * 커밋 기준(`base`)은 이 인스턴스가 들고 있던 **직전 state**의 revision/event tail이다. 같은 run을
     * 두 kernel이 같은 revision에서 열었으면 늦은 쪽 커밋은 `stale_writer`로 거부된다(lost update 없음).
     */
    #mutate(fn) {
        const now = formatTimestamp(this.#clock());
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
        assertReferentialIntegrity(draft);
        this.#state = commitRun(this.paths, { state: draft, events: mutation.events, bodies: mutation.bodies, base });
    }
}
// ── M4b scheduler (순수 함수 — state만 본다) ────────────────────────────────
/** `running` task가 점유 중인 class 집합. `waiting_children`은 중단 상태라 점유하지 않는다. */
function heldResourceClasses(state) {
    const held = new Set();
    for (const t of state.tasks) {
        if (t.state !== "running")
            continue;
        for (const r of t.resourceClasses)
            held.add(r);
    }
    return held;
}
/**
 * 결정론적 선택: `state.tasks`는 taskId 오름차순 불변식이므로 같은 state면 항상 같은 목록이 나온다.
 * 이미 점유된 class와 **이 batch에서 앞서 고른** class를 모두 피하므로 batch 내부도 충돌이 없다.
 */
function selectSchedulable(state, limit) {
    const held = heldResourceClasses(state);
    const picked = [];
    for (const t of state.tasks) {
        if (picked.length >= limit)
            break;
        if (t.state !== "ready")
            continue;
        if (t.resourceClasses.some((r) => held.has(r)))
            continue;
        for (const r of t.resourceClasses)
            held.add(r);
        picked.push(t);
    }
    return picked;
}
function assertBatchLimit(limit) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxScheduleBatch) {
        throw new OrchestrationError("invalid_batch_limit", `batch 상한은 1..${LIMITS.maxScheduleBatch} 정수여야 한다`);
    }
    return limit;
}
// ── 순수 헬퍼 (draft 조작) ──────────────────────────────────────────────────
function requireTask(state, taskId) {
    const t = state.tasks.find((x) => x.taskId === taskId);
    if (!t)
        throw new OrchestrationError("unknown_task", `미상 task: ${taskId}`);
    return t;
}
function setState(draft, now, mutation, task, to, reason) {
    if (task.state === to)
        return;
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
function addTask(draft, now, mutation, seed, parentTaskId, depth) {
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
    const dependsOn = [];
    for (const d of seed.dependsOn) {
        const id = assertSlug(d, "dependsOn 항목");
        if (id === taskId)
            throw new OrchestrationError("self_dependency", `task가 자기 자신에 의존할 수 없다: ${taskId}`);
        if (!draft.tasks.some((t) => t.taskId === id)) {
            throw new OrchestrationError("unknown_dependency", `미상 dependsOn: ${id}`);
        }
        if (dependsOn.includes(id))
            throw new OrchestrationError("depends_on_duplicate", `dependsOn 중복: ${id}`);
        dependsOn.push(id);
    }
    const task = {
        taskId,
        roleId: assertSlug(seed.roleId, "roleId"),
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
    if (dependsOn.length === 0)
        setState(draft, now, mutation, task, "ready", "created");
    // task_assignment는 중앙 kernel이 보낸다 (sender=orchestrator, recipient=task role).
    const envelope = {
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
function acceptMessage(draft, now, mutation, paths, rawEnvelope, rawBody, summary) {
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
        if (!known)
            throw new OrchestrationError("unknown_dependency", `미상 dependsOn: ${d}`);
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
    const entry = {
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
function assertDirection(envelope, task) {
    const central = ["task_assignment"];
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
function recompute(draft, now, mutation) {
    const ordered = [...draft.tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    const byId = new Map(draft.tasks.map((t) => [t.taskId, t]));
    const stateOf = (id) => {
        const t = byId.get(id);
        if (!t)
            throw new OrchestrationError("unknown_task", `미상 task: ${id}`);
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
            if (t.state === "completed" || t.state === "blocked")
                continue;
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
            if (t.state === "waiting_children" &&
                t.childTaskIds.length > 0 &&
                t.childTaskIds.every((c) => stateOf(c) === "completed")) {
                setState(draft, now, mutation, t, "ready", "children_completed");
                changed = true;
            }
        }
    }
}
/** 편의 진입점 — production 기본 root는 `<workspace>/outputs/orchestration`이다. */
export function createOrchestrationRun(opts) {
    return OrchestrationKernel.create(opts);
}
export function openOrchestrationRun(opts) {
    return OrchestrationKernel.open(opts);
}
