/**
 * V3 M4a/M4b — orchestration durable state의 저장·적재 계층 (로드맵 §4).
 *
 * ```text
 * outputs/orchestration/<run-id>/run_state.json   # SoR (실행 상태)
 * outputs/orchestration/<run-id>/events.jsonl     # append-only 감사 이력(해시 체인)
 * outputs/orchestration/<run-id>/messages/<id>.md # 검증된 Markdown body
 * outputs/orchestration/<run-id>/snapshot.md      # state에서 결정론적으로 재생성한 파생물
 * outputs/orchestration/<run-id>/run_state.lock   # M4b — run 단위 배타 writer lock(커밋 동안만 존재)
 * ```
 *
 * 계약:
 * - state 저장은 **같은 디렉터리 임시 파일 → rename**으로 교체한다. 과도한 fsync/crash hardening은
 *   M4a/M4b 범위가 아니다(로드맵 M10 hardening 대상).
 * - **커밋은 run 단위 배타 writer lock 안에서만 일어나고**(M4b), lock 안에서 디스크 state의
 *   revision·event tail이 호출자의 커밋 기준과 같은지 확인한다. 다르면 `stale_writer`로 거부하며
 *   **먼저 쓴 writer의 결과를 덮지 않는다**. lock 경합은 대기 없이 `run_lock_held`로 fail-closed다.
 * - load는 fail-closed다: state runtime schema · event linkage · message body hash · artifact hash
 *   중 하나라도 어긋나면 던진다. **실패를 null이나 빈 run으로 바꾸지 않는다.**
 * - `artifacts/` 디렉터리는 만들지 않는다 — M4a의 artifact는 workspace 안 실제 파일이고
 *   중앙이 보관하는 것은 포인터뿐이다(§3.2).
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AGENT_MESSAGE_TYPES, EVENT_TYPES, GENESIS_HASH, LIMITS, ORCHESTRATION_SCHEMA_VERSION, OrchestrationError, TASK_STATES, TRANSITION_REASONS, assertSha256, assertSlug, assertText, assertTimestamp, normalizeOwnership, normalizeResourceClasses, normalizeWorkspacePath, } from "./orchestrationTypes.js";
import { validateArtifactPointer } from "./agentMessage.js";
/** production 기본 root: `<workspace>/outputs/orchestration`. */
export const ORCHESTRATION_ROOT = "outputs/orchestration";
export function runPaths(workspaceRoot, runId) {
    if (!isAbsolute(workspaceRoot)) {
        throw new OrchestrationError("workspace_not_absolute", "workspaceRoot는 절대경로여야 한다");
    }
    assertSlug(runId, "runId");
    const dir = join(workspaceRoot, ORCHESTRATION_ROOT, runId);
    return {
        workspaceRoot,
        runId,
        dir,
        stateFile: join(dir, "run_state.json"),
        eventsFile: join(dir, "events.jsonl"),
        messagesDir: join(dir, "messages"),
        snapshotFile: join(dir, "snapshot.md"),
        lockFile: join(dir, "run_state.lock"),
    };
}
export function sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
/**
 * artifact 파일 재검증. symlink · missing · 비일반 파일 · workspace 탈출 · hash 불일치는 fail-closed.
 * 상위 디렉터리 symlink로 workspace를 벗어나는 경우까지 realpath 비교로 막는다.
 */
export function verifyArtifactFile(workspaceRoot, relPath, expectedSha256) {
    const normalized = normalizeWorkspacePath(relPath, "artifact path");
    const abs = join(workspaceRoot, normalized);
    let st;
    try {
        st = lstatSync(abs);
    }
    catch {
        throw new OrchestrationError("artifact_missing", `artifact를 찾을 수 없다: ${normalized}`);
    }
    if (st.isSymbolicLink()) {
        throw new OrchestrationError("artifact_symlink", `artifact가 symlink다: ${normalized}`);
    }
    if (!st.isFile()) {
        throw new OrchestrationError("artifact_not_regular_file", `artifact가 일반 파일이 아니다: ${normalized}`);
    }
    let realFile;
    let realRoot;
    try {
        realFile = realpathSync(abs);
        realRoot = realpathSync(workspaceRoot);
    }
    catch {
        throw new OrchestrationError("artifact_unresolvable", `artifact 경로를 확인할 수 없다: ${normalized}`);
    }
    if (realFile !== resolve(realRoot, normalized)) {
        throw new OrchestrationError("artifact_outside_workspace", `artifact가 workspace 밖을 가리킨다: ${normalized}`);
    }
    const actual = sha256Hex(readFileSync(abs));
    if (expectedSha256 !== null && actual !== expectedSha256) {
        throw new OrchestrationError("artifact_hash_mismatch", `artifact hash가 등록값과 다르다: ${normalized}`);
    }
    return actual;
}
// ── runtime state validator (closed) ────────────────────────────────────────
function asObject(v, what) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new OrchestrationError("invalid_state", `${what}는 객체여야 한다`);
    }
    return v;
}
function closedKeys(o, allowed, what) {
    for (const k of Object.keys(o)) {
        if (!allowed.includes(k))
            throw new OrchestrationError("invalid_state", `${what}에 허용되지 않은 필드: ${k}`);
    }
    for (const k of allowed) {
        if (!(k in o))
            throw new OrchestrationError("invalid_state", `${what}에 필수 필드 없음: ${k}`);
    }
}
function boundedInt(v, what, min, max) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        throw new OrchestrationError("invalid_state", `${what}는 ${min}..${max} 정수여야 한다`);
    }
    return v;
}
function enumValue(v, allowed, what) {
    if (typeof v !== "string" || !allowed.includes(v)) {
        throw new OrchestrationError("invalid_state", `${what}는 ${allowed.join("|")} 중 하나여야 한다`);
    }
    return v;
}
function slugArray(v, what, max) {
    if (!Array.isArray(v))
        throw new OrchestrationError("invalid_state", `${what}는 배열이어야 한다`);
    if (v.length > max)
        throw new OrchestrationError("invalid_state", `${what}는 ${max}개 이하여야 한다`);
    const out = [];
    for (const x of v) {
        const id = assertSlug(x, `${what} 항목`);
        if (out.includes(id))
            throw new OrchestrationError("invalid_state", `${what}에 중복: ${id}`);
        out.push(id);
    }
    return out;
}
export const TASK_KEYS = [
    "taskId",
    "roleId",
    "title",
    "scope",
    "ownership",
    "resourceClasses",
    "parentTaskId",
    "childTaskIds",
    "dependsOn",
    "state",
    "depth",
    "createdAt",
    "updatedAt",
    "resultSummary",
    "blockerSummary",
    "artifactRefs",
];
export const MESSAGE_KEYS = [
    "messageId",
    "type",
    "taskId",
    "parentTaskId",
    "sender",
    "recipient",
    "createdAt",
    "dependsOn",
    "artifactRefs",
    "supersedes",
    "bodyPath",
    "bodySha256",
    "summary",
];
export const ARTIFACT_RECORD_KEYS = [
    "artifactId",
    "path",
    "sha256",
    "revision",
    "producerTaskId",
    "role",
    "registeredAt",
    "supersedes",
];
export const EVENT_KEYS = [
    "eventId",
    "prevHash",
    "stateDigest",
    "at",
    "type",
    "revision",
    "taskId",
    "messageId",
    "fromState",
    "toState",
    "reason",
    "artifactId",
];
export const STATE_KEYS = [
    "schemaVersion",
    "runId",
    "milestoneId",
    "revision",
    "lastEventId",
    "lastEventHash",
    "createdAt",
    "updatedAt",
    "tasks",
    "messages",
    "artifacts",
];
function validateTask(raw) {
    const o = asObject(raw, "task");
    // M4b 이전(M4a) state에는 resourceClasses가 없다. 기본값으로 조용히 채우지 않고 **거부**한다 —
    // 채우면 그 state의 stateDigest가 어차피 어긋나 원인이 불분명한 실패가 되고, 배타 자원 선언이
    // 없는 task를 "병렬 안전"으로 오해할 여지도 남는다. 마이그레이션 프레임워크는 만들지 않는다.
    if (!("resourceClasses" in o)) {
        throw new OrchestrationError("state_pre_m4b_unsupported", "M4b 이전 orchestration state다(task.resourceClasses 없음). 마이그레이션하지 않으며 새 run을 만들어야 한다");
    }
    closedKeys(o, TASK_KEYS, "task");
    return {
        taskId: assertSlug(o.taskId, "task.taskId"),
        roleId: assertSlug(o.roleId, "task.roleId"),
        title: assertText(o.title, "task.title", LIMITS.maxTextLength),
        scope: assertText(o.scope, "task.scope", LIMITS.maxTextLength),
        ownership: normalizeOwnership(o.ownership, "task.ownership"),
        resourceClasses: normalizeResourceClasses(o.resourceClasses, "task.resourceClasses"),
        parentTaskId: o.parentTaskId === null ? null : assertSlug(o.parentTaskId, "task.parentTaskId"),
        childTaskIds: slugArray(o.childTaskIds, "task.childTaskIds", LIMITS.maxChildrenPerTask),
        dependsOn: slugArray(o.dependsOn, "task.dependsOn", LIMITS.maxDependsOn),
        state: enumValue(o.state, TASK_STATES, "task.state"),
        depth: boundedInt(o.depth, "task.depth", 0, LIMITS.maxDepth),
        createdAt: assertTimestamp(o.createdAt, "task.createdAt"),
        updatedAt: assertTimestamp(o.updatedAt, "task.updatedAt"),
        resultSummary: o.resultSummary === null ? null : assertText(o.resultSummary, "task.resultSummary", LIMITS.maxSummaryLength),
        blockerSummary: o.blockerSummary === null ? null : assertText(o.blockerSummary, "task.blockerSummary", LIMITS.maxSummaryLength),
        artifactRefs: validatePointerArray(o.artifactRefs, "task.artifactRefs"),
    };
}
function validatePointerArray(v, what) {
    if (!Array.isArray(v))
        throw new OrchestrationError("invalid_state", `${what}는 배열이어야 한다`);
    if (v.length > LIMITS.maxArtifactRefs)
        throw new OrchestrationError("invalid_state", `${what}는 ${LIMITS.maxArtifactRefs}개 이하여야 한다`);
    return v.map((x) => validateArtifactPointer(x));
}
function validateMessage(raw) {
    const o = asObject(raw, "message");
    closedKeys(o, MESSAGE_KEYS, "message");
    const messageId = assertSlug(o.messageId, "message.messageId");
    const bodyPath = normalizeWorkspacePath(o.bodyPath, "message.bodyPath");
    if (bodyPath !== `messages/${messageId}.md`) {
        throw new OrchestrationError("invalid_state", `message.bodyPath는 messages/<messageId>.md여야 한다: ${bodyPath}`);
    }
    return {
        messageId,
        type: enumValue(o.type, AGENT_MESSAGE_TYPES, "message.type"),
        taskId: assertSlug(o.taskId, "message.taskId"),
        parentTaskId: o.parentTaskId === null ? null : assertSlug(o.parentTaskId, "message.parentTaskId"),
        sender: assertSlug(o.sender, "message.sender"),
        recipient: assertSlug(o.recipient, "message.recipient"),
        createdAt: assertTimestamp(o.createdAt, "message.createdAt"),
        dependsOn: slugArray(o.dependsOn, "message.dependsOn", LIMITS.maxDependsOn),
        artifactRefs: validatePointerArray(o.artifactRefs, "message.artifactRefs"),
        supersedes: o.supersedes === null ? null : assertSlug(o.supersedes, "message.supersedes"),
        bodyPath,
        bodySha256: assertSha256(o.bodySha256, "message.bodySha256"),
        summary: o.summary === null ? null : assertText(o.summary, "message.summary", LIMITS.maxSummaryLength),
    };
}
function validateArtifactRecord(raw) {
    const o = asObject(raw, "artifact");
    closedKeys(o, ARTIFACT_RECORD_KEYS, "artifact");
    const pointer = validateArtifactPointer({
        path: o.path,
        sha256: o.sha256,
        revision: o.revision,
        producerTaskId: o.producerTaskId,
        role: o.role,
    });
    const artifactId = `${pointer.path}@${pointer.revision}`;
    if (o.artifactId !== artifactId) {
        throw new OrchestrationError("invalid_state", `artifact.artifactId는 <path>@<revision>이어야 한다: ${String(o.artifactId)}`);
    }
    // key 순서는 ARTIFACT_RECORD_KEYS와 같게 유지한다 — create 경로와 open 경로가 같은 바이트를 쓰게 한다.
    return {
        artifactId,
        path: pointer.path,
        sha256: pointer.sha256,
        revision: pointer.revision,
        producerTaskId: pointer.producerTaskId,
        role: pointer.role,
        registeredAt: assertTimestamp(o.registeredAt, "artifact.registeredAt"),
        supersedes: o.supersedes === null ? null : assertText(o.supersedes, "artifact.supersedes", LIMITS.maxPathLength + 16),
    };
}
export function validateEvent(raw) {
    const o = asObject(raw, "event");
    closedKeys(o, EVENT_KEYS, "event");
    return {
        eventId: boundedInt(o.eventId, "event.eventId", 1, 1_000_000),
        prevHash: assertSha256(o.prevHash, "event.prevHash"),
        stateDigest: o.stateDigest === null ? null : assertSha256(o.stateDigest, "event.stateDigest"),
        at: assertTimestamp(o.at, "event.at"),
        type: enumValue(o.type, EVENT_TYPES, "event.type"),
        revision: boundedInt(o.revision, "event.revision", 1, 1_000_000),
        taskId: o.taskId === null ? null : assertSlug(o.taskId, "event.taskId"),
        messageId: o.messageId === null ? null : assertSlug(o.messageId, "event.messageId"),
        fromState: o.fromState === null ? null : enumValue(o.fromState, TASK_STATES, "event.fromState"),
        toState: o.toState === null ? null : enumValue(o.toState, TASK_STATES, "event.toState"),
        reason: o.reason === null ? null : enumValue(o.reason, TRANSITION_REASONS, "event.reason"),
        artifactId: o.artifactId === null ? null : assertText(o.artifactId, "event.artifactId", LIMITS.maxPathLength + 16),
    };
}
/**
 * run state 전체 검증 — 필드 형태 + 참조 무결성(parent/child 대칭, dependsOn 실재, cycle 없음,
 * artifact/message 참조 실재, 정렬 순서)까지 본다. 통과하면 정규화된 사본을 돌려준다.
 */
export function validateRunState(raw) {
    const o = asObject(raw, "run_state");
    closedKeys(o, STATE_KEYS, "run_state");
    if (o.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
        throw new OrchestrationError("invalid_state", `run_state.schemaVersion은 "${ORCHESTRATION_SCHEMA_VERSION}"이어야 한다`);
    }
    if (!Array.isArray(o.tasks) || !Array.isArray(o.messages) || !Array.isArray(o.artifacts)) {
        throw new OrchestrationError("invalid_state", "tasks/messages/artifacts는 배열이어야 한다");
    }
    if (o.tasks.length > LIMITS.maxTasksPerRun) {
        throw new OrchestrationError("task_limit_exceeded", `run당 task는 ${LIMITS.maxTasksPerRun}개 이하여야 한다`);
    }
    const state = {
        schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
        runId: assertSlug(o.runId, "run_state.runId"),
        milestoneId: assertSlug(o.milestoneId, "run_state.milestoneId"),
        revision: boundedInt(o.revision, "run_state.revision", 1, 1_000_000),
        lastEventId: boundedInt(o.lastEventId, "run_state.lastEventId", 0, 1_000_000),
        lastEventHash: assertSha256(o.lastEventHash, "run_state.lastEventHash"),
        createdAt: assertTimestamp(o.createdAt, "run_state.createdAt"),
        updatedAt: assertTimestamp(o.updatedAt, "run_state.updatedAt"),
        tasks: o.tasks.map(validateTask),
        messages: o.messages.map(validateMessage),
        artifacts: o.artifacts.map(validateArtifactRecord),
    };
    assertReferentialIntegrity(state);
    return state;
}
/** 정렬·유일성·참조·cycle 검사. kernel이 만든 state와 디스크에서 읽은 state 모두 이걸 통과해야 한다. */
export function assertReferentialIntegrity(state) {
    const sortedIds = (xs) => xs.every((v, i) => i === 0 || xs[i - 1] < v);
    const taskIds = state.tasks.map((t) => t.taskId);
    if (!sortedIds(taskIds))
        throw new OrchestrationError("invalid_state", "tasks는 taskId 오름차순이어야 한다");
    if (!sortedIds(state.messages.map((m) => m.messageId))) {
        throw new OrchestrationError("invalid_state", "messages는 messageId 오름차순이어야 한다");
    }
    if (!sortedIds(state.artifacts.map((a) => a.artifactId))) {
        throw new OrchestrationError("invalid_state", "artifacts는 artifactId 오름차순이어야 한다");
    }
    const byId = new Map(state.tasks.map((t) => [t.taskId, t]));
    for (const t of state.tasks) {
        if (t.dependsOn.includes(t.taskId)) {
            throw new OrchestrationError("self_dependency", `task ${t.taskId}가 자기 자신에 의존한다`);
        }
        for (const d of t.dependsOn) {
            if (!byId.has(d))
                throw new OrchestrationError("unknown_dependency", `task ${t.taskId}의 dependsOn 미상: ${d}`);
        }
        if (t.parentTaskId !== null) {
            const p = byId.get(t.parentTaskId);
            if (!p)
                throw new OrchestrationError("unknown_parent", `task ${t.taskId}의 parent 미상: ${t.parentTaskId}`);
            if (!p.childTaskIds.includes(t.taskId)) {
                throw new OrchestrationError("invalid_state", `parent ${p.taskId}의 childTaskIds에 ${t.taskId}가 없다`);
            }
            if (t.depth !== p.depth + 1) {
                throw new OrchestrationError("invalid_state", `task ${t.taskId}의 depth가 parent+1이 아니다`);
            }
        }
        else if (t.depth !== 0) {
            throw new OrchestrationError("invalid_state", `root task ${t.taskId}의 depth는 0이어야 한다`);
        }
        for (const c of t.childTaskIds) {
            const child = byId.get(c);
            if (!child)
                throw new OrchestrationError("unknown_child", `task ${t.taskId}의 child 미상: ${c}`);
            if (child.parentTaskId !== t.taskId) {
                throw new OrchestrationError("invalid_state", `child ${c}의 parentTaskId가 ${t.taskId}가 아니다`);
            }
        }
        for (const ref of t.artifactRefs) {
            if (!state.artifacts.some((a) => a.artifactId === `${ref.path}@${ref.revision}` && a.sha256 === ref.sha256)) {
                throw new OrchestrationError("unknown_artifact", `task ${t.taskId}가 미등록 artifact를 참조한다: ${ref.path}@${ref.revision}`);
            }
        }
    }
    assertNoDependencyCycle(state.tasks);
    assertExclusiveResourceClaims(state.tasks);
    for (const m of state.messages) {
        if (!byId.has(m.taskId))
            throw new OrchestrationError("unknown_task", `message ${m.messageId}의 taskId 미상: ${m.taskId}`);
        if (m.supersedes !== null && !state.messages.some((x) => x.messageId === m.supersedes)) {
            throw new OrchestrationError("unknown_message", `message ${m.messageId}의 supersedes 미상: ${m.supersedes}`);
        }
        for (const d of m.dependsOn) {
            const known = byId.has(d) || state.messages.some((x) => x.messageId === d);
            if (!known)
                throw new OrchestrationError("unknown_dependency", `message ${m.messageId}의 dependsOn 미상: ${d}`);
        }
    }
    const artifactIds = new Set();
    for (const a of state.artifacts) {
        if (artifactIds.has(a.artifactId))
            throw new OrchestrationError("invalid_state", `artifact 중복: ${a.artifactId}`);
        artifactIds.add(a.artifactId);
        if (!byId.has(a.producerTaskId)) {
            throw new OrchestrationError("unknown_task", `artifact ${a.artifactId}의 producer 미상: ${a.producerTaskId}`);
        }
    }
    for (const a of state.artifacts) {
        if (a.supersedes === null)
            continue;
        // supersedes는 같은 path의 **더 낮은** revision이어야 한다(문자열 정렬과 무관하게 판정).
        if (!artifactIds.has(a.supersedes) || a.supersedes !== `${a.path}@${a.revision - 1}`) {
            throw new OrchestrationError("invalid_state", `artifact ${a.artifactId}의 supersedes가 직전 revision이 아니다: ${a.supersedes}`);
        }
    }
}
/**
 * M4b 핵심 불변식: **같은 배타 자원 class를 `running` task 둘이 동시에 점유할 수 없다.**
 * 점유는 `running` 동안만이고 `waiting_children`은 중단 상태라 점유하지 않는다.
 * kernel이 만든 state와 디스크에서 읽은 state 모두 이 검사를 통과해야 하므로,
 * scheduler를 우회한 전이나 손으로 고친 state는 커밋·load 어느 쪽에서도 통과하지 못한다.
 */
export function assertExclusiveResourceClaims(tasks) {
    const holder = new Map();
    for (const t of tasks) {
        if (t.state !== "running")
            continue;
        for (const r of t.resourceClasses) {
            const other = holder.get(r);
            if (other !== undefined) {
                throw new OrchestrationError("resource_conflict", `배타 자원 class '${r}'를 running task 둘이 점유한다: ${other}, ${t.taskId}`);
            }
            holder.set(r, t.taskId);
        }
    }
}
/** dependsOn + parent/child를 함께 본 DAG cycle 검사(반복 DFS — 재귀 깊이 무관). */
export function assertNoDependencyCycle(tasks) {
    const edges = new Map();
    for (const t of tasks) {
        const out = [...t.dependsOn];
        if (t.parentTaskId !== null)
            out.push(t.parentTaskId);
        edges.set(t.taskId, out);
    }
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Map(tasks.map((t) => [t.taskId, WHITE]));
    for (const start of edges.keys()) {
        if (color.get(start) !== WHITE)
            continue;
        const stack = [{ id: start, next: 0 }];
        color.set(start, GREY);
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const outs = edges.get(frame.id) ?? [];
            if (frame.next >= outs.length) {
                color.set(frame.id, BLACK);
                stack.pop();
                continue;
            }
            const nxt = outs[frame.next++];
            const c = color.get(nxt);
            if (c === GREY)
                throw new OrchestrationError("dependency_cycle", `task 의존 cycle: ${nxt}`);
            if (c === WHITE) {
                color.set(nxt, GREY);
                stack.push({ id: nxt, next: 0 });
            }
        }
    }
}
// ── snapshot (파생물) ───────────────────────────────────────────────────────
/**
 * state에서 결정론적으로 재생성하는 bounded brief. 생성 시각 등 state 밖 값은 쓰지 않으므로
 * 같은 state면 항상 같은 바이트가 나온다. **raw artifact 본문·raw transcript는 넣지 않는다** —
 * bounded summary와 검증된 포인터만 옮긴다(로드맵 §3.2).
 */
export function renderSnapshot(state) {
    const lines = [];
    lines.push("# Orchestration Snapshot");
    lines.push("");
    lines.push("> state에서 결정론적으로 재생성한 파생물이다. 원본은 run_state.json + messages/*.md.");
    lines.push("");
    lines.push(`- run: ${state.runId}`);
    lines.push(`- milestone: ${state.milestoneId}`);
    lines.push(`- schemaVersion: ${state.schemaVersion}`);
    lines.push(`- revision: ${state.revision}`);
    lines.push(`- lastEventId: ${state.lastEventId}`);
    lines.push(`- updatedAt: ${state.updatedAt}`);
    lines.push("");
    lines.push("## Ready Tasks");
    const ready = state.tasks.filter((t) => t.state === "ready");
    if (ready.length === 0)
        lines.push("- (none)");
    for (const t of ready)
        lines.push(`- ${t.taskId} — role=${t.roleId} depth=${t.depth}`);
    lines.push("");
    lines.push("## Tasks");
    for (const t of state.tasks) {
        lines.push(`### ${t.taskId}`);
        lines.push(`- state: ${t.state}`);
        lines.push(`- role: ${t.roleId}`);
        lines.push(`- depth: ${t.depth}`);
        lines.push(`- title: ${t.title}`);
        lines.push(`- scope: ${t.scope}`);
        lines.push(`- parent: ${t.parentTaskId ?? "(none)"}`);
        lines.push(`- children: ${t.childTaskIds.length > 0 ? t.childTaskIds.join(", ") : "(none)"}`);
        lines.push(`- dependsOn: ${t.dependsOn.length > 0 ? t.dependsOn.join(", ") : "(none)"}`);
        lines.push(`- ownership: ${t.ownership.join(", ")}`);
        lines.push(`- resourceClasses: ${t.resourceClasses.length > 0 ? t.resourceClasses.join(", ") : "(none — 병렬 안전)"}`);
        lines.push(`- resultSummary: ${t.resultSummary ?? "(none)"}`);
        lines.push(`- blockerSummary: ${t.blockerSummary ?? "(none)"}`);
        for (const a of t.artifactRefs) {
            lines.push(`- artifact: ${a.path}@${a.revision} sha256=${a.sha256} role=${a.role}`);
        }
        lines.push("");
    }
    lines.push("## Artifacts");
    if (state.artifacts.length === 0)
        lines.push("- (none)");
    for (const a of state.artifacts) {
        lines.push(`- ${a.artifactId} sha256=${a.sha256} producer=${a.producerTaskId} role=${a.role} supersedes=${a.supersedes ?? "(none)"}`);
    }
    lines.push("");
    lines.push("## Messages");
    if (state.messages.length === 0)
        lines.push("- (none)");
    for (const m of state.messages) {
        lines.push(`- ${m.messageId} type=${m.type} task=${m.taskId} ${m.sender}→${m.recipient} body=${m.bodyPath} sha256=${m.bodySha256}`);
        if (m.summary !== null)
            lines.push(`  - summary: ${m.summary}`);
    }
    lines.push("");
    return lines.join("\n");
}
// ── 영속화 ──────────────────────────────────────────────────────────────────
/** 같은 디렉터리 임시 파일 → rename. (M4a 범위: 과도한 fsync/crash hardening은 하지 않는다) */
function writeAtomic(target, data) {
    const tmp = `${target}.tmp-${process.pid}`;
    try {
        writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, target);
    }
    catch (e) {
        try {
            rmSync(tmp, { force: true });
        }
        catch {
            /* 정리 실패는 원 오류를 가리지 않는다 */
        }
        throw e;
    }
}
export function ensureRunDir(paths) {
    mkdirSync(paths.messagesDir, { recursive: true, mode: 0o700 });
}
export function runExists(paths) {
    return existsSync(paths.stateFile);
}
/**
 * state **내용**의 SHA-256. chain 필드(`lastEventId`/`lastEventHash`)는 제외한다 —
 * 그래야 event가 state digest를 담고 state가 event chain hash를 담아도 순환하지 않는다.
 * key 목록을 명시해 직렬화를 정규화한다(tasks/messages/artifacts는 이미 정렬·key 순서 고정).
 */
export function stateContentDigest(state) {
    return sha256Hex(JSON.stringify({
        schemaVersion: state.schemaVersion,
        runId: state.runId,
        milestoneId: state.milestoneId,
        revision: state.revision,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        tasks: state.tasks,
        messages: state.messages,
        artifacts: state.artifacts,
    }));
}
const O_NOFOLLOW_SUPPORTED = typeof fsConstants.O_NOFOLLOW === "number";
/**
 * run 하나의 커밋을 직렬화하는 배타 lock. `O_CREAT|O_EXCL`(= `wx`) 하나로 성립하며
 * **대기하지 않는다**: 이미 있으면 즉시 `run_lock_held`로 fail-closed다(retry loop 없음).
 *
 * ponytail: 최소 파일 lock이다. **stale lock 자동 회수·소유자 생존 확인·크래시 복구·분산 lock은 넣지 않았다** —
 * writer가 커밋 도중 죽으면 lock이 남아 그 run의 이후 커밋을 전부 거부하고 사람이 지워야 한다(fail closed).
 * 상향 경로는 기존 suite lock(`scripts/lib/suite-exclusive-lock.mjs`)의 guard/격리 계약이며 별도 승인 범위다.
 * 그 계약은 suite 전용 의미(ownership token 상속·pgid 스캔·격리)를 함께 들고 오므로 여기서는 재사용하지 않았다.
 */
export function acquireRunWriterLock(paths) {
    ensureRunDir(paths);
    const nonce = randomBytes(16).toString("hex");
    let fd;
    try {
        fd = openSync(paths.lockFile, "wx", 0o600);
    }
    catch (e) {
        if (e.code === "EEXIST") {
            throw new OrchestrationError("run_lock_held", `이 run에 다른 writer가 커밋 중이다(대기하지 않는다): ${paths.runId}`);
        }
        throw e;
    }
    try {
        writeFileSync(fd, `${nonce}\n`, { encoding: "utf8" });
    }
    finally {
        closeSync(fd);
    }
    return { file: paths.lockFile, nonce };
}
/**
 * **이 acquire가 만든 lock만** 해제한다. 최종 엔트리는 `O_NOFOLLOW`로만 읽고(symlink 교체 거부),
 * nonce가 다르면 남의 lock이므로 **지우지 않고** `run_lock_owner_mismatch`로 올린다.
 *
 * ponytail: Node 18에 compare-and-unlink가 없어 "확인 → unlink" 창을 0으로 만들 수 없다
 * (대장 `C-5`와 같은 한계 — 창 최소화 + 사후 탐지).
 */
export function releaseRunWriterLock(paths, lock) {
    if (!O_NOFOLLOW_SUPPORTED) {
        throw new OrchestrationError("run_lock_nofollow_unsupported", "이 플랫폼은 O_NOFOLLOW를 지원하지 않는다");
    }
    let text;
    let fd;
    try {
        fd = openSync(paths.lockFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    catch {
        throw new OrchestrationError("run_lock_release_failed", "해제할 writer lock을 읽을 수 없다(교체·삭제됨)");
    }
    try {
        text = readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
    if (text.trim() !== lock.nonce) {
        throw new OrchestrationError("run_lock_owner_mismatch", "writer lock 소유자가 다르다 — 남의 lock은 지우지 않는다");
    }
    unlinkSync(paths.lockFile);
}
/**
 * lock을 쥔 상태에서 디스크가 아직 호출자의 기준과 같은지 확인한다.
 * 다르면 **아무것도 쓰지 않고** `stale_writer`로 거부한다 — 늦은 writer가 먼저 쓴 결과를 덮거나
 * 남의 event tail에 이어 붙여 체인을 깨뜨리는 경로를 없앤다.
 */
function assertDurableBase(paths, base) {
    if (base === null) {
        if (runExists(paths)) {
            throw new OrchestrationError("run_already_exists", `이미 존재하는 run이다: ${paths.runId}`);
        }
        return;
    }
    if (!runExists(paths)) {
        throw new OrchestrationError("stale_writer", "커밋 기준 run_state.json이 디스크에서 사라졌다");
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    }
    catch {
        throw new OrchestrationError("state_unparsable", "run_state.json이 JSON이 아니다");
    }
    const o = asObject(parsed, "run_state");
    if (o.revision !== base.revision || o.lastEventId !== base.lastEventId || o.lastEventHash !== base.lastEventHash) {
        throw new OrchestrationError("stale_writer", `디스크 state가 커밋 기준과 다르다 (기준 revision ${base.revision}/event ${base.lastEventId}, 디스크 revision ${String(o.revision)}/event ${String(o.lastEventId)})`);
    }
    const tail = existsSync(paths.eventsFile)
        ? readFileSync(paths.eventsFile, "utf8").split("\n").filter((l) => l.length > 0).length
        : 0;
    if (tail !== base.lastEventId) {
        throw new OrchestrationError("stale_writer", `events.jsonl 줄 수(${tail})가 커밋 기준(${base.lastEventId})과 다르다`);
    }
}
/**
 * 하나의 kernel 변경을 디스크에 반영한다. **검증은 전부 호출 전에 끝나 있어야 한다** —
 * 유효하지 않은 입력은 여기까지 오지 않으므로 invalid input에서는 파일 전이가 0이다.
 * 순서: message body(rename) → events append → snapshot → state(rename).
 *
 * 커밋의 **마지막** 이벤트가 이 커밋이 남기는 state 내용의 digest를 들고 가고, load가 그것을
 * 재계산해 대조한다 → 문법적으로 유효한 state 편집(예: `state`/`resultSummary` 손대기)만으로는
 * kernel을 우회할 수 없다. 그래서 커밋마다 이벤트가 최소 1건 필요하다.
 *
 * M4b: 위 전 과정(디스크 기준 확인 → body → events → snapshot → state)을 **run 단위 배타 writer
 * lock 하나 안에서** 수행한다. 다른 프로세스가 커밋 중이면 대기 없이 `run_lock_held`, 디스크가
 * 이미 앞서 있으면 `stale_writer`이며 두 경우 다 파일 전이가 0이다.
 */
export function commitRun(paths, input) {
    ensureRunDir(paths);
    const { state, events, bodies } = input;
    if (events.length === 0) {
        throw new OrchestrationError("commit_without_event", "state 커밋은 이벤트를 최소 1건 남겨야 한다");
    }
    // chain 필드를 뺀 내용은 아래 finalState와 동일하므로 append 전에 미리 계산할 수 있다.
    const digest = stateContentDigest(state);
    const lock = acquireRunWriterLock(paths);
    try {
        assertDurableBase(paths, input.base);
        for (const b of bodies) {
            writeAtomic(join(paths.messagesDir, `${b.messageId}.md`), b.body);
        }
        let prevHash = state.lastEventHash;
        let eventId = state.lastEventId;
        let appended = "";
        for (let i = 0; i < events.length; i++) {
            eventId += 1;
            const full = {
                ...events[i],
                eventId,
                prevHash,
                stateDigest: i === events.length - 1 ? digest : null,
            };
            const line = JSON.stringify(full);
            appended += `${line}\n`;
            prevHash = sha256Hex(line);
        }
        appendFileSync(paths.eventsFile, appended, { encoding: "utf8", mode: 0o600 });
        const finalState = { ...state, lastEventId: eventId, lastEventHash: prevHash };
        assertReferentialIntegrity(finalState);
        if (stateContentDigest(finalState) !== digest) {
            throw new OrchestrationError("state_digest_drift", "커밋 중 state 내용이 바뀌었다");
        }
        writeAtomic(paths.snapshotFile, renderSnapshot(finalState));
        writeAtomic(paths.stateFile, `${JSON.stringify(finalState, null, 2)}\n`);
        return finalState;
    }
    finally {
        // ponytail: 해제 실패(남의 lock으로 교체 등)는 원 오류를 가릴 수 있지만 삼키지 않는다 —
        // 그 경로는 외부 조작이며 조용히 넘기면 다음 writer가 남의 lock 위에서 커밋한다.
        releaseRunWriterLock(paths, lock);
    }
}
/**
 * state 내용이 append-only event tail이 기록한 digest와 일치하는지. 불일치는 fail-closed다.
 *
 * ponytail: 키 없는 digest라 **두 파일을 모두 일관되게 다시 쓰는** 위조(state + events.jsonl 전체
 * 재작성)까지는 막지 못한다 — 그 경우 감사 로그 자체가 조작되므로 탐지·감사 대상이다.
 * 상향 경로는 out-of-band 키를 쓰는 HMAC/서명이며 별도 승인 범위다.
 */
export function assertStateEventBinding(state, events) {
    const last = events[events.length - 1];
    if (!last) {
        throw new OrchestrationError("state_event_binding_missing", "state를 묶어 줄 이벤트가 없다");
    }
    if (last.stateDigest === null) {
        throw new OrchestrationError("state_event_binding_missing", "마지막 이벤트에 stateDigest가 없다");
    }
    if (last.stateDigest !== stateContentDigest(state)) {
        throw new OrchestrationError("state_event_binding_mismatch", "run_state.json 내용이 event 이력이 기록한 digest와 다르다 (kernel 커밋의 산물이 아니다)");
    }
}
/** events.jsonl을 읽고 해시 체인·번호를 검증한다. */
export function loadEvents(paths, expected) {
    let text = "";
    if (existsSync(paths.eventsFile)) {
        const st = lstatSync(paths.eventsFile);
        if (st.isSymbolicLink() || !st.isFile()) {
            throw new OrchestrationError("events_not_regular_file", "events.jsonl이 일반 파일이 아니다");
        }
        text = readFileSync(paths.eventsFile, "utf8");
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    if (lines.length !== expected.lastEventId) {
        throw new OrchestrationError("event_count_mismatch", `events.jsonl 줄 수(${lines.length})가 state.lastEventId(${expected.lastEventId})와 다르다`);
    }
    let prevHash = GENESIS_HASH;
    const events = [];
    for (let i = 0; i < lines.length; i++) {
        let parsed;
        try {
            parsed = JSON.parse(lines[i]);
        }
        catch {
            throw new OrchestrationError("event_unparsable", `events.jsonl ${i + 1}번째 줄이 JSON이 아니다`);
        }
        const e = validateEvent(parsed);
        if (e.eventId !== i + 1) {
            throw new OrchestrationError("event_id_mismatch", `events.jsonl ${i + 1}번째 줄의 eventId가 ${e.eventId}다`);
        }
        if (e.prevHash !== prevHash) {
            throw new OrchestrationError("event_chain_broken", `events.jsonl ${i + 1}번째 줄의 prevHash가 체인과 다르다`);
        }
        prevHash = sha256Hex(lines[i]);
        events.push(e);
    }
    if (prevHash !== expected.lastEventHash) {
        throw new OrchestrationError("event_chain_broken", "events.jsonl의 마지막 해시가 state.lastEventHash와 다르다");
    }
    return events;
}
/**
 * run 적재 — fail-closed. state schema · event linkage · **state↔event binding** ·
 * message body hash · artifact hash를 전부 확인하고 하나라도 어긋나면 던진다.
 * 빈 run이나 null로 강등하지 않는다.
 */
export function loadRun(paths) {
    if (!existsSync(paths.stateFile)) {
        throw new OrchestrationError("run_not_found", `run_state.json이 없다: ${paths.stateFile}`);
    }
    const st = lstatSync(paths.stateFile);
    if (st.isSymbolicLink() || !st.isFile()) {
        throw new OrchestrationError("state_not_regular_file", "run_state.json이 일반 파일이 아니다");
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    }
    catch {
        throw new OrchestrationError("state_unparsable", "run_state.json이 JSON이 아니다");
    }
    const state = validateRunState(parsed);
    if (state.runId !== paths.runId) {
        throw new OrchestrationError("run_id_mismatch", `run_state.runId(${state.runId})가 디렉터리(${paths.runId})와 다르다`);
    }
    const events = loadEvents(paths, state);
    assertStateEventBinding(state, events);
    for (const m of state.messages) {
        const file = join(paths.dir, m.bodyPath);
        if (!existsSync(file)) {
            throw new OrchestrationError("message_body_missing", `message body가 없다: ${m.bodyPath}`);
        }
        const bst = lstatSync(file);
        if (bst.isSymbolicLink() || !bst.isFile()) {
            throw new OrchestrationError("message_body_not_regular_file", `message body가 일반 파일이 아니다: ${m.bodyPath}`);
        }
        if (sha256Hex(readFileSync(file)) !== m.bodySha256) {
            throw new OrchestrationError("message_body_hash_mismatch", `message body hash 불일치: ${m.bodyPath}`);
        }
    }
    for (const a of state.artifacts) {
        verifyArtifactFile(paths.workspaceRoot, a.path, a.sha256);
    }
    return { state, events };
}
/** snapshot.md만 state에서 다시 만들어 쓴다 — run_state/events는 건드리지 않는다(파생물). */
export function writeSnapshot(paths, state) {
    const content = renderSnapshot(state);
    ensureRunDir(paths);
    writeAtomic(paths.snapshotFile, content);
    return content;
}
