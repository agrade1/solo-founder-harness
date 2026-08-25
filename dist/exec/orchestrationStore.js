/**
 * V3 M4a/M4b — orchestration durable state의 저장·적재 계층 (로드맵 §4).
 *
 * ```text
 * outputs/orchestration/<run-id>/run_state.json   # SoR (실행 상태)
 * outputs/orchestration/<run-id>/events.jsonl     # append-only 감사 이력(해시 체인)
 * outputs/orchestration/<run-id>/messages/<id>.md # 검증된 Markdown body
 * outputs/orchestration/<run-id>/snapshot.md      # state에서 결정론적으로 재생성한 파생물
 * outputs/orchestration/<run-id>/run_state.lock   # M4b — run 단위 배타 writer lock(커밋 동안만 존재)
 * outputs/orchestration/<run-id>/commit.journal   # M5b — 발행 중인 커밋 1건의 복구 기록(발행 완료 시 삭제)
 * ```
 *
 * 계약:
 * - state 저장은 **같은 디렉터리 임시 파일 → rename**으로 교체한다. 과도한 fsync/crash hardening은
 *   M4a/M4b 범위가 아니다(로드맵 M10 hardening 대상).
 * - **발행은 복구 가능한 단일 트랜잭션이다(V3 M5b 4차 독립 리뷰 A3).** 이전 판은 body → event append →
 *   snapshot → state를 **각자 실패할 수 있는 네 연산**으로 했으므로, event append가 성공하고 뒤가 실패하면
 *   디스크에 **새 event tail + 낡은 state**가 남아 reopen(`event_count_mismatch`)도 재시도(`stale_writer`)도
 *   깨졌다. 지금은 발행 전에 `commit.journal`(원자적 rename)을 남기고, 다음 `commitRun`·`loadRun`이
 *   **그 journal을 보고 결정론적으로 복구**한다 — 규칙은 아래 `recoverPendingCommit`에 있다.
 * - **최종 message body는 state가 durable해진 뒤에만 생긴다(5·6차 독립 리뷰 A3).** body는 먼저
 *   **트랜잭션 소유 staging 이름**(`messages/.staged-<txn>.<id>.md`)으로 쓰고, journal에 대상 messageId ·
 *   **내용 digest** · **정확한 바이트 수** · **staging 신원(dev+ino)** 을 남긴 뒤, **state 발행 뒤에**
 *   `link(2)`로 최종 이름을 만든다(**no-clobber CAS** — 남의 파일을 덮는 것이 원자적으로 불가능하다).
 *   같은 내용(digest)의 남의 최종 파일도 **채택하지 않고** 거부하며, roll back은 **자기 staging만** 지운다
 *   (최종 body는 애초에 없으므로 지울 것이 없다). 남의 body는 어떤 경로에서도 지우거나 덮지 않는다.
 *   **소유 판정은 열린 fd 하나로 하고 발행 1건마다 반복한다(7차 독립 리뷰 A2)**: link **직전** ·
 *   link **직후** · **journal 삭제 직전 전수**에서 dev+ino·정확한 바이트 수·내용 SHA-256을 다시 본다 →
 *   전수 preflight 이후 staging을 갈아끼워 교체본을 link하거나, 발행된 최종 body를 제자리에서 고친 뒤
 *   복구 기록을 지우는 경로가 없다. 어긋나면 **journal을 남기고** fail closed다.
 * - **journal은 열린 기록이 아니다(5·6차 독립 리뷰 A3).** closed schema이고 경로 runId·milestone·승인
 *   manifest·**기준 state 원본 바이트와 불변 권위 신원**(milestone·manifest·내용 digest·생성 시각·메시지
 *   수)·기준 event 바이트·후속 revision·**`validateEvent` 출력 바이트와 동일한 정규 event record**·해시
 *   체인·최종 state digest·**base→target 새 body delta와 소유 신원**에 **전부 묶인다**. 어긋나면
 *   `journal_*` 코드로 fail closed이며 journal·state·events·snapshot·body가 **바이트 그대로** 남는다.
 * - **복구는 후속 state를 발행하지 않는다(6차 독립 리뷰 A3).** 규칙은 "기준이면 되돌린다 / 이미 목표
 *   바이트면 마무리한다" 둘뿐이다 — roll forward를 없애 **위조 후속**(해시를 전부 다시 계산한 journal)이
 *   유효한 state를 덮어쓸 권한을 제거했다.
 * - **커밋은 run 단위 배타 writer lock 안에서만 일어나고**(M4b), lock 안에서 디스크 state의
 *   revision·event tail이 호출자의 커밋 기준과 같은지 확인한다. 다르면 `stale_writer`로 거부하며
 *   **먼저 쓴 writer의 결과를 덮지 않는다**. lock 경합은 대기 없이 `run_lock_held`로 fail-closed다.
 * - load는 fail-closed다: state runtime schema · event linkage · message body hash · artifact hash
 *   중 하나라도 어긋나면 던진다. **실패를 null이나 빈 run으로 바꾸지 않는다.**
 * - `artifacts/` 디렉터리는 만들지 않는다 — M4a의 artifact는 workspace 안 실제 파일이고
 *   중앙이 보관하는 것은 포인터뿐이다(§3.2).
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, closeSync, constants as fsConstants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync, } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AGENT_MESSAGE_TYPES, APPROVED_OPERATION_KINDS, ARTIFACT_ROLES, AUTOPILOT_MARKERS, CLEANUP_STATUSES, DELIVERY_MARKERS, EVENT_TYPES, GENESIS_HASH, LIMITS, PAUSE_REASONS, RUN_STATE_SCHEMA_VERSION, SUMMARY_REQUIRED, TASK_STATES, TRANSITION_REASONS, OrchestrationError, assertSha256, assertSlug, assertText, assertTimestamp, holdsResources, normalizeAssignedOperations, normalizeOwnership, normalizeResourceClasses, normalizeWorkspacePath, } from "./orchestrationTypes.js";
import { validateArtifactPointer } from "./agentMessage.js";
import { SPECIALIST_ROLES, assertRegistryRoleId, pathWithin, validateApprovalManifest } from "./approvalManifest.js";
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
        controllerLeaseFile: join(dir, "controller.lock"),
        journalFile: join(dir, "commit.journal"),
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
    "assignedOperations",
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
    "execution",
];
/** M5c — `task.execution`의 닫힌 key 집합. */
export const TASK_EXECUTION_KEYS = [
    "attemptNo",
    "attemptId",
    "turnId",
    "dispatchTurnId",
    "dispatchPlanDigest",
    "chargedPlanDigest",
    "preflightDigest",
    "phaseStartedAt",
    "wallDeadlineAt",
    "lastProgressAt",
    "progressCount",
    "processLeaseMarker",
    "terminalMarker",
    "cleanupStatus",
    "cleanupAttempts",
    "cancelRequestedAt",
    "pauseReason",
    "retryAt",
    "retryDeadlineAt",
    "pendingResult",
    "pendingOperations",
    "operationReceipts",
];
/** M5c 3A 2차 리비전 — 미확정 operation 레코드의 닫힌 key 집합. */
export const PENDING_OPERATION_KEYS = [
    "operationId",
    "kind",
    "authorityId",
    "attemptId",
    "turnId",
    "planDigest",
    "beganAt",
    // M5c 3A 4차 리비전 A2 — 일회용 집행 경계 진입 시각(null이면 아직 아무 효과도 시도되지 않았다).
    "attemptedAt",
];
export const OPERATION_RECEIPT_KEYS = [
    "operationId",
    "kind",
    "authorityId",
    // M5c 3A 3차 리비전 A2 — 영수증에도 실행 신원을 남긴다(claim이 닫힌 뒤에도 재구성 가능).
    "attemptId",
    "turnId",
    "planDigest",
    "path",
    "resultSha256",
    "exitCode",
    "marker",
    "at",
];
/**
 * operation 영수증의 닫힌 marker 집합.
 * `outcome_unknown`은 3A 4차 리비전 A3의 fail-safe 종결이다(성공도 실패도 단정하지 않는다).
 */
export const OPERATION_RECEIPT_MARKERS = [
    "applied",
    "already_applied",
    "write_conflict",
    "denied",
    "failed",
    "outcome_unknown",
];
export const PENDING_RESULT_KEYS = ["summary", "outputs"];
/** M5c — run 단위 durable 회계의 닫힌 key 집합. */
export const ACCOUNTING_KEYS = [
    "approvalDigest",
    "budgetStartedAt",
    "budgetDeadlineAt",
    "tokensUsed",
    "elapsedMsUsed",
    "chargedTurnIds",
];
/** M5c — 메시지 전달 재시도 메타데이터의 닫힌 key 집합. */
export const DELIVERY_KEYS = [
    "attempts",
    "activeAttemptId",
    "firstAttemptAt",
    "lastAttemptAt",
    "nextAttemptAt",
    "deadlineAt",
    "lastMarker",
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
    "routeToTaskId",
    "acknowledgedAt",
    "delivery",
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
    // ── M5c 닫힌 감사 필드 ──
    "actionId",
    "attemptId",
    "turnId",
    "operationId",
    "planDigest",
    "marker",
    "tokenDelta",
    "elapsedMs",
];
export const STATE_KEYS = [
    "schemaVersion",
    "runId",
    "milestoneId",
    "manifest",
    "accounting",
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
    // M5c 이전 state에는 실행 lifecycle 메타데이터가 없다. 기본값으로 채우면 "정리해야 할 프로세스가
    // 없다"고 **거짓으로 주장**하게 되므로 채우지 않고 거부한다(마이그레이션 프레임워크도 만들지 않는다).
    if (!("execution" in o)) {
        throw new OrchestrationError("state_pre_m5c_unsupported", "M5c 이전 orchestration state다(task.execution 없음). 마이그레이션하지 않으며 새 run을 만들어야 한다");
    }
    // `B-38`/`C-111` 이전 state에는 지시-계획 bind 축이 없다. **기본값으로 채우지 않고 거부한다** —
    // pre-M4b·pre-M5c와 같은 판단이고 근거도 같다(대장 `C-9`가 "실제 운영 run 없음, offline 테스트
    // run뿐"이라고 적어 둔 그 시점이다). 채울 수 있는 값이 둘 다 거짓말이라 고를 수도 없다:
    // `null`로 채우면 옛 run이 bind를 **영영 벗어나고**, `[]`로 채우면 승인된 operation을 쓰던 옛 run이
    // 원인 불명으로 죽는다. 어느 쪽이든 stateDigest가 어차피 어긋난다.
    if (!("assignedOperations" in o)) {
        throw new OrchestrationError("state_pre_b38_unsupported", "지시-계획 bind 이전 orchestration state다(task.assignedOperations 없음). 마이그레이션하지 않으며 새 run을 만들어야 한다");
    }
    closedKeys(o, TASK_KEYS, "task");
    return {
        taskId: assertSlug(o.taskId, "task.taskId"),
        // M4c — roleId는 여전히 slug지만 **7 specialist registry 소속**이어야 한다(하위 role 한 겹 허용).
        roleId: assertRegistryRoleId(o.roleId, "task.roleId"),
        title: assertText(o.title, "task.title", LIMITS.maxTextLength),
        scope: assertText(o.scope, "task.scope", LIMITS.maxTextLength),
        ownership: normalizeOwnership(o.ownership, "task.ownership"),
        resourceClasses: normalizeResourceClasses(o.resourceClasses, "task.resourceClasses"),
        assignedOperations: normalizeAssignedOperations(o.assignedOperations, "task.assignedOperations"),
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
        execution: validateTaskExecution(o.execution, enumValue(o.state, TASK_STATES, "task.state")),
    };
}
/** `{path, role}` 산출물 1건(pendingResult용) — 등록 전이므로 포인터가 아니다. */
function validatePendingOutput(raw, what) {
    const o = asObject(raw, what);
    closedKeys(o, ["path", "role"], what);
    if (typeof o.role !== "string" || !ARTIFACT_ROLES.includes(o.role)) {
        throw new OrchestrationError("invalid_state", `${what}.role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
    }
    return { path: normalizeWorkspacePath(o.path, `${what}.path`), role: o.role };
}
function validatePendingResult(raw) {
    const o = asObject(raw, "task.execution.pendingResult");
    closedKeys(o, PENDING_RESULT_KEYS, "task.execution.pendingResult");
    if (!Array.isArray(o.outputs)) {
        throw new OrchestrationError("invalid_state", "task.execution.pendingResult.outputs는 배열이어야 한다");
    }
    if (o.outputs.length > LIMITS.maxArtifactRefs) {
        throw new OrchestrationError("invalid_state", `pendingResult.outputs는 ${LIMITS.maxArtifactRefs}개 이하여야 한다`);
    }
    return {
        summary: assertText(o.summary, "pendingResult.summary", LIMITS.maxSummaryLength),
        outputs: o.outputs.map((x, i) => validatePendingOutput(x, `pendingResult.outputs[${i}]`)),
    };
}
function validateOperationReceipt(raw, what) {
    const o = asObject(raw, what);
    closedKeys(o, OPERATION_RECEIPT_KEYS, what);
    return {
        operationId: assertSlug(o.operationId, `${what}.operationId`),
        kind: enumValue(o.kind, APPROVED_OPERATION_KINDS, `${what}.kind`),
        authorityId: assertSlug(o.authorityId, `${what}.authorityId`),
        attemptId: assertSlug(o.attemptId, `${what}.attemptId`),
        turnId: assertSlug(o.turnId, `${what}.turnId`),
        planDigest: assertSha256(o.planDigest, `${what}.planDigest`),
        path: o.path === null ? null : normalizeWorkspacePath(o.path, `${what}.path`),
        resultSha256: o.resultSha256 === null ? null : assertSha256(o.resultSha256, `${what}.resultSha256`),
        exitCode: o.exitCode === null ? null : boundedInt(o.exitCode, `${what}.exitCode`, -255, 255),
        marker: enumValue(o.marker, OPERATION_RECEIPT_MARKERS, `${what}.marker`),
        at: assertTimestamp(o.at, `${what}.at`),
    };
}
/** M5c 3A 2차 리비전 — 미확정 operation 1건(집행 전에 durable해지고 영수증 커밋으로 사라진다). */
function validatePendingOperation(raw, what) {
    const o = asObject(raw, what);
    closedKeys(o, PENDING_OPERATION_KEYS, what);
    return {
        operationId: assertSlug(o.operationId, `${what}.operationId`),
        kind: enumValue(o.kind, APPROVED_OPERATION_KINDS, `${what}.kind`),
        authorityId: assertSlug(o.authorityId, `${what}.authorityId`),
        attemptId: assertSlug(o.attemptId, `${what}.attemptId`),
        turnId: assertSlug(o.turnId, `${what}.turnId`),
        planDigest: assertSha256(o.planDigest, `${what}.planDigest`),
        beganAt: assertTimestamp(o.beganAt, `${what}.beganAt`),
        attemptedAt: o.attemptedAt === null ? null : assertTimestamp(o.attemptedAt, `${what}.attemptedAt`),
    };
}
/**
 * **M5c 실행 lifecycle 메타데이터 검증**(closed). 여기서 state와의 정합성도 함께 본다:
 * ⓐ `running`은 attempt를 배정받았어야 한다 ⓑ `cleaning`은 정리가 필요하다고 기록돼 있어야 한다
 * ⓒ `paused`는 사유가 있어야 한다 ⓓ `retry_wait`은 예약 시각이 있어야 한다
 * ⓔ **cleanup이 확인되지 않았으면 `completed`가 될 수 없다**(대장 `B-13` — 커밋과 load가 같은 검사 하나를 지난다).
 */
function validateTaskExecution(raw, state) {
    const o = asObject(raw, "task.execution");
    closedKeys(o, TASK_EXECUTION_KEYS, "task.execution");
    if (!Array.isArray(o.operationReceipts)) {
        throw new OrchestrationError("invalid_state", "task.execution.operationReceipts는 배열이어야 한다");
    }
    if (o.operationReceipts.length > LIMITS.maxOperationReceipts) {
        throw new OrchestrationError("invalid_state", `operationReceipts는 ${LIMITS.maxOperationReceipts}개 이하여야 한다`);
    }
    const seenOps = new Set();
    const receipts = o.operationReceipts.map((x, i) => {
        const r = validateOperationReceipt(x, `task.execution.operationReceipts[${i}]`);
        if (seenOps.has(r.operationId)) {
            throw new OrchestrationError("invalid_state", `operationReceipts에 중복 operationId가 있다: ${r.operationId}`);
        }
        seenOps.add(r.operationId);
        return r;
    });
    if (!Array.isArray(o.pendingOperations)) {
        throw new OrchestrationError("invalid_state", "task.execution.pendingOperations는 배열이어야 한다");
    }
    if (o.pendingOperations.length > LIMITS.maxPendingOperations) {
        throw new OrchestrationError("invalid_state", `pendingOperations는 ${LIMITS.maxPendingOperations}개 이하여야 한다`);
    }
    const seenPending = new Set();
    const pendingOperations = o.pendingOperations.map((x, i) => {
        const p = validatePendingOperation(x, `task.execution.pendingOperations[${i}]`);
        if (seenPending.has(p.operationId)) {
            throw new OrchestrationError("invalid_state", `pendingOperations에 중복 operationId가 있다: ${p.operationId}`);
        }
        // 같은 operationId가 pending과 영수증에 동시에 있으면 정합화가 이미 끝난 것을 다시 여는 셈이다.
        if (seenOps.has(p.operationId)) {
            throw new OrchestrationError("invalid_state", `이미 영수증이 있는 operation이 pending으로 남아 있다: ${p.operationId}`);
        }
        seenPending.add(p.operationId);
        return p;
    });
    // **모든 pending은 닫을 자리(영수증 slot)를 갖고 있어야 한다**(M5c 3A 5차 리비전 A5). operation은 turn
    // 단위, 영수증은 attempt 단위로 상한이 있으므로 이 교차 불변식이 없으면 영수증 용량이 소진된 attempt에
    // pending이 남을 수 있고, 그 pending은 영수증 커밋도 handle-free 정합화도 상한에서 거부되는데
    // attempt 이탈 전이는 전부 pending 0을 요구한다 → **영구 미아**다. 커밋(`beginOperation`의 예약)과
    // load가 같은 불변식 하나를 지난다.
    if (receipts.length + pendingOperations.length > LIMITS.maxOperationReceipts) {
        throw new OrchestrationError("invalid_state", `operationReceipts + pendingOperations는 ${LIMITS.maxOperationReceipts}건 이하여야 한다(닫을 수 없는 pending 금지)`);
    }
    const exec = {
        attemptNo: boundedInt(o.attemptNo, "task.execution.attemptNo", 0, LIMITS.maxTaskAttempts),
        attemptId: o.attemptId === null ? null : assertSlug(o.attemptId, "task.execution.attemptId"),
        turnId: o.turnId === null ? null : assertSlug(o.turnId, "task.execution.turnId"),
        dispatchTurnId: o.dispatchTurnId === null ? null : assertSlug(o.dispatchTurnId, "task.execution.dispatchTurnId"),
        dispatchPlanDigest: o.dispatchPlanDigest === null ? null : assertSha256(o.dispatchPlanDigest, "task.execution.dispatchPlanDigest"),
        chargedPlanDigest: o.chargedPlanDigest === null ? null : assertSha256(o.chargedPlanDigest, "task.execution.chargedPlanDigest"),
        preflightDigest: o.preflightDigest === null ? null : assertSha256(o.preflightDigest, "task.execution.preflightDigest"),
        phaseStartedAt: o.phaseStartedAt === null ? null : assertTimestamp(o.phaseStartedAt, "task.execution.phaseStartedAt"),
        wallDeadlineAt: o.wallDeadlineAt === null ? null : assertTimestamp(o.wallDeadlineAt, "task.execution.wallDeadlineAt"),
        lastProgressAt: o.lastProgressAt === null ? null : assertTimestamp(o.lastProgressAt, "task.execution.lastProgressAt"),
        progressCount: boundedInt(o.progressCount, "task.execution.progressCount", 0, LIMITS.maxProgressEvents),
        processLeaseMarker: o.processLeaseMarker === null ? null : assertLeaseMarker(o.processLeaseMarker),
        terminalMarker: o.terminalMarker === null ? null : enumValue(o.terminalMarker, AUTOPILOT_MARKERS, "task.execution.terminalMarker"),
        cleanupStatus: enumValue(o.cleanupStatus, CLEANUP_STATUSES, "task.execution.cleanupStatus"),
        cleanupAttempts: boundedInt(o.cleanupAttempts, "task.execution.cleanupAttempts", 0, LIMITS.maxCleanupAttempts),
        cancelRequestedAt: o.cancelRequestedAt === null ? null : assertTimestamp(o.cancelRequestedAt, "task.execution.cancelRequestedAt"),
        pauseReason: o.pauseReason === null ? null : enumValue(o.pauseReason, PAUSE_REASONS, "task.execution.pauseReason"),
        retryAt: o.retryAt === null ? null : assertTimestamp(o.retryAt, "task.execution.retryAt"),
        retryDeadlineAt: o.retryDeadlineAt === null ? null : assertTimestamp(o.retryDeadlineAt, "task.execution.retryDeadlineAt"),
        pendingResult: o.pendingResult === null ? null : validatePendingResult(o.pendingResult),
        pendingOperations,
        operationReceipts: receipts,
    };
    const bad = (why) => {
        throw new OrchestrationError("invalid_state", `task.execution이 상태 ${state}와 어긋난다: ${why}`);
    };
    if ((state === "prepared" || state === "running") && (exec.attemptNo < 1 || exec.attemptId === null)) {
        bad("attempt가 배정되지 않았다");
    }
    if (state === "prepared" && exec.preflightDigest === null)
        bad("preflight digest가 없다");
    // `cleaning`은 세 단계를 지난다: 정리 필요(`required`) → 실패해 격리(`failed`) 또는 확인(`confirmed`).
    // 확인된 뒤에도 상태는 `cleaning`이다 — 다음 상태는 결과에 맞춰 별도 reducer가 정한다. `none`은 없다.
    if (state === "cleaning" && exec.cleanupStatus === "none") {
        bad("cleaning은 cleanupStatus가 required|failed|confirmed여야 한다");
    }
    if (state === "paused" && exec.pauseReason === null)
        bad("paused는 사유가 있어야 한다");
    // **과금 권위 증거는 그 turn의 과금 없이 존재할 수 없다**(M5c 3A 4차 리비전 A1): 손으로 심은
    // `chargedPlanDigest` 하나로 효과 게이트를 지나가는 경로를 load에서도 막는다.
    if (exec.chargedPlanDigest !== null && exec.turnId === null) {
        bad("chargedPlanDigest가 있는데 과금된 turn이 없다");
    }
    if (state === "retry_wait" && (exec.retryAt === null || exec.retryDeadlineAt === null))
        bad("retry 예약 시각이 없다");
    // **cleanup 미확인 상태로는 종료 상태에 갈 수 없다**(프로세스가 남은 채로 자원을 놓는 경로를 닫는다).
    if ((state === "completed" || state === "cancelled") && exec.cleanupStatus === "required") {
        bad("cleanup이 확인되지 않았다");
    }
    if (state === "completed" && exec.pendingResult !== null)
        bad("완료된 task에 미확정 결과가 남아 있다");
    // **미확정 operation은 활성 attempt에만 존재할 수 있다**(M5c 3A 3차 리비전 A3). 그 밖의 상태는
    // 전부 attempt를 떠났거나 리셋되는 상태이므로, 거기 pending이 남아 있다는 것은 곧 "효과 기록을
    // 잃어버릴 수 있는 state"라는 뜻이다 → 커밋과 load가 같은 검사 하나로 막는다.
    if (exec.pendingOperations.length > 0) {
        if (state !== "running" && state !== "cleaning") {
            bad("미확정 typed operation은 running|cleaning에만 존재할 수 있다");
        }
        for (const p of exec.pendingOperations) {
            // pending은 **자기 attempt/turn/계획에 묶여** 있어야 한다. 이 셋이 갈라지면 어떤 영수증이 어떤
            // 효과를 닫는지 durable에서 판정할 수 없다(그리고 dispatch claim이 닫혀 있으면 정합화가 불가능하다).
            if (p.attemptId !== exec.attemptId)
                bad(`pending operation ${p.operationId}이 현재 attempt의 것이 아니다`);
            if (p.turnId !== exec.dispatchTurnId)
                bad(`pending operation ${p.operationId}의 turn이 열린 dispatch claim과 다르다`);
            if (p.planDigest !== exec.dispatchPlanDigest)
                bad(`pending operation ${p.operationId}의 계획이 claim된 계획과 다르다`);
        }
    }
    return exec;
}
/** lease marker는 **비밀이 아닌 충돌 저항 난수 slug**다(PID·argv가 아니다). */
function assertLeaseMarker(v) {
    if (typeof v !== "string" || !/^lease\.[0-9a-f]{32}$/.test(v)) {
        throw new OrchestrationError("invalid_state", "processLeaseMarker는 `lease.<32 hex>` 형태여야 한다");
    }
    return v;
}
/** M5c — 메시지 전달 재시도 메타데이터(closed). */
function validateDelivery(raw, routed, acknowledged) {
    const o = asObject(raw, "message.delivery");
    closedKeys(o, DELIVERY_KEYS, "message.delivery");
    const d = {
        attempts: boundedInt(o.attempts, "message.delivery.attempts", 0, LIMITS.maxDeliveryAttempts),
        activeAttemptId: o.activeAttemptId === null ? null : assertSlug(o.activeAttemptId, "message.delivery.activeAttemptId"),
        firstAttemptAt: o.firstAttemptAt === null ? null : assertTimestamp(o.firstAttemptAt, "message.delivery.firstAttemptAt"),
        lastAttemptAt: o.lastAttemptAt === null ? null : assertTimestamp(o.lastAttemptAt, "message.delivery.lastAttemptAt"),
        nextAttemptAt: o.nextAttemptAt === null ? null : assertTimestamp(o.nextAttemptAt, "message.delivery.nextAttemptAt"),
        deadlineAt: o.deadlineAt === null ? null : assertTimestamp(o.deadlineAt, "message.delivery.deadlineAt"),
        lastMarker: o.lastMarker === null ? null : enumValue(o.lastMarker, DELIVERY_MARKERS, "message.delivery.lastMarker"),
    };
    if (!routed && d.attempts !== 0) {
        throw new OrchestrationError("invalid_state", "전달 대상이 없는 메시지에 전달 시도 기록이 있다");
    }
    // 수령했으면 마지막 marker는 `delivered`여야 한다 — 실패한 전달이 수령으로 남는 경로를 닫는다.
    if (acknowledged && d.lastMarker !== "delivered") {
        throw new OrchestrationError("invalid_state", "수령된 전달의 lastMarker가 delivered가 아니다");
    }
    return d;
}
/** M5c — run 단위 durable 회계(closed). monotonic·bounded·정렬 계약을 여기서 강제한다. */
function validateAccounting(raw) {
    const o = asObject(raw, "run_state.accounting");
    closedKeys(o, ACCOUNTING_KEYS, "run_state.accounting");
    if (!Array.isArray(o.chargedTurnIds)) {
        throw new OrchestrationError("invalid_state", "accounting.chargedTurnIds는 배열이어야 한다");
    }
    if (o.chargedTurnIds.length > LIMITS.maxChargedTurnIds) {
        throw new OrchestrationError("invalid_state", `accounting.chargedTurnIds는 ${LIMITS.maxChargedTurnIds}개 이하여야 한다`);
    }
    const ids = slugArray(o.chargedTurnIds, "accounting.chargedTurnIds", LIMITS.maxChargedTurnIds);
    if (!ids.every((v, i) => i === 0 || ids[i - 1] < v)) {
        throw new OrchestrationError("invalid_state", "accounting.chargedTurnIds는 오름차순이어야 한다");
    }
    const budgetStartedAt = assertTimestamp(o.budgetStartedAt, "accounting.budgetStartedAt");
    const budgetDeadlineAt = assertTimestamp(o.budgetDeadlineAt, "accounting.budgetDeadlineAt");
    if (budgetDeadlineAt <= budgetStartedAt) {
        throw new OrchestrationError("invalid_state", "accounting.budgetDeadlineAt은 budgetStartedAt보다 뒤여야 한다");
    }
    return {
        approvalDigest: assertSha256(o.approvalDigest, "accounting.approvalDigest"),
        budgetStartedAt,
        budgetDeadlineAt,
        tokensUsed: boundedInt(o.tokensUsed, "accounting.tokensUsed", 0, LIMITS.maxAccountedTokens),
        elapsedMsUsed: boundedInt(o.elapsedMsUsed, "accounting.elapsedMsUsed", 0, LIMITS.maxAccountedElapsedMs),
        chargedTurnIds: ids,
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
    if (!("delivery" in o)) {
        throw new OrchestrationError("state_pre_m5c_unsupported", "M5c 이전 orchestration state다(message.delivery 없음). 마이그레이션하지 않으며 새 run을 만들어야 한다");
    }
    closedKeys(o, MESSAGE_KEYS, "message");
    const messageId = assertSlug(o.messageId, "message.messageId");
    const bodyPath = normalizeWorkspacePath(o.bodyPath, "message.bodyPath");
    if (bodyPath !== `messages/${messageId}.md`) {
        throw new OrchestrationError("invalid_state", `message.bodyPath는 messages/<messageId>.md여야 한다: ${bodyPath}`);
    }
    const type = enumValue(o.type, AGENT_MESSAGE_TYPES, "message.type");
    const summary = o.summary === null ? null : assertText(o.summary, "message.summary", LIMITS.maxSummaryLength);
    if (SUMMARY_REQUIRED[type] && summary === null) {
        throw new OrchestrationError("invalid_state", `message.summary는 ${type}에 필수다: ${messageId}`);
    }
    if (!SUMMARY_REQUIRED[type] && summary !== null) {
        throw new OrchestrationError("invalid_state", `message.summary는 ${type}에 null이어야 한다: ${messageId}`);
    }
    const routeToTaskId = o.routeToTaskId === null ? null : assertSlug(o.routeToTaskId, "message.routeToTaskId");
    const acknowledgedAt = o.acknowledgedAt === null ? null : assertTimestamp(o.acknowledgedAt, "message.acknowledgedAt");
    if (routeToTaskId === null && acknowledgedAt !== null) {
        throw new OrchestrationError("invalid_state", `전달 대상이 없는 메시지에 수령 시각이 있다: ${messageId}`);
    }
    return {
        messageId,
        type,
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
        summary,
        routeToTaskId,
        acknowledgedAt,
        delivery: validateDelivery(o.delivery, routeToTaskId !== null, acknowledgedAt !== null),
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
    if (!("actionId" in o)) {
        throw new OrchestrationError("state_pre_m5c_unsupported", "M5c 이전 event log다(감사 필드 없음). 마이그레이션하지 않으며 새 run을 만들어야 한다");
    }
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
        // M5c 감사 필드 — 전부 닫힌 형태이고 자유 payload가 없다. `marker`는 결과/전달/정리/영수증 marker의
        // 합집합만 허용한다(새 문자열은 자동 편입되지 않는다).
        actionId: o.actionId === null ? null : assertSlug(o.actionId, "event.actionId"),
        attemptId: o.attemptId === null ? null : assertSlug(o.attemptId, "event.attemptId"),
        turnId: o.turnId === null ? null : assertSlug(o.turnId, "event.turnId"),
        operationId: o.operationId === null ? null : assertSlug(o.operationId, "event.operationId"),
        planDigest: o.planDigest === null ? null : assertSha256(o.planDigest, "event.planDigest"),
        marker: o.marker === null ? null : enumValue(o.marker, EVENT_MARKERS, "event.marker"),
        tokenDelta: o.tokenDelta === null ? null : boundedInt(o.tokenDelta, "event.tokenDelta", 0, LIMITS.maxAccountedTokens),
        elapsedMs: o.elapsedMs === null ? null : boundedInt(o.elapsedMs, "event.elapsedMs", 0, LIMITS.maxAccountedElapsedMs),
    };
}
/**
 * event `marker`의 **닫힌 합집합**(대장 `C-33`). autopilot 결과 · pause 사유 · 전달 결과 · 정리 결과 ·
 * operation 영수증 marker만 감사 이벤트에 실린다 — 자유 문자열은 없고 새 코드는 자동 편입되지 않는다.
 */
export const EVENT_MARKERS = [
    ...AUTOPILOT_MARKERS,
    ...PAUSE_REASONS,
    ...DELIVERY_MARKERS,
    ...OPERATION_RECEIPT_MARKERS,
    "cleanup_confirmed",
    "cleanup_unconfirmed",
];
/**
 * run state 전체 검증 — 필드 형태 + 참조 무결성(parent/child 대칭, dependsOn 실재, cycle 없음,
 * artifact/message 참조 실재, 정렬 순서)까지 본다. 통과하면 정규화된 사본을 돌려준다.
 */
export function validateRunState(raw) {
    const o = asObject(raw, "run_state");
    // M4c 이전 state에는 승인 manifest가 없다. 기본값으로 채우면 그것이 곧 **조용한 자동 승인**이므로
    // 채우지 않고 거부한다(마이그레이션 프레임워크도 만들지 않는다 — 새 run을 만든다).
    if (!("manifest" in o)) {
        throw new OrchestrationError("state_pre_m4c_unsupported", "M4c 이전 orchestration state다(승인 manifest 없음). 자동 승인하지 않으며 새 run을 만들어야 한다");
    }
    // M5c 이전 state(v1)는 durable 회계가 없다 → 재시작이 예산을 리셋하는 상태다. 마이그레이션하지 않는다.
    if (!("accounting" in o)) {
        throw new OrchestrationError("state_pre_m5c_unsupported", "M5c 이전 orchestration state다(durable accounting 없음). 마이그레이션하지 않으며 새 run을 만들어야 한다");
    }
    closedKeys(o, STATE_KEYS, "run_state");
    if (o.schemaVersion !== RUN_STATE_SCHEMA_VERSION) {
        // v1 바이트는 여기서 안정 코드로 닫힌다(기본값 채우기·자동 변환 없음).
        if (o.schemaVersion === "1") {
            throw new OrchestrationError("state_pre_m5c_unsupported", 'run_state.schemaVersion "1"은 M5c에서 지원하지 않는다');
        }
        throw new OrchestrationError("invalid_state", `run_state.schemaVersion은 "${RUN_STATE_SCHEMA_VERSION}"이어야 한다`);
    }
    if (!Array.isArray(o.tasks) || !Array.isArray(o.messages) || !Array.isArray(o.artifacts)) {
        throw new OrchestrationError("invalid_state", "tasks/messages/artifacts는 배열이어야 한다");
    }
    if (o.tasks.length > LIMITS.maxTasksPerRun) {
        throw new OrchestrationError("task_limit_exceeded", `run당 task는 ${LIMITS.maxTasksPerRun}개 이하여야 한다`);
    }
    const milestoneId = assertSlug(o.milestoneId, "run_state.milestoneId");
    const manifest = validateApprovalManifest(o.manifest);
    if (manifest.milestoneId !== milestoneId) {
        throw new OrchestrationError("manifest_milestone_mismatch", `manifest.milestoneId(${manifest.milestoneId})가 run(${milestoneId})과 다르다`);
    }
    const accounting = validateAccounting(o.accounting);
    // 회계는 **이 승인**에 묶여 있다 — 승인이 바뀌면 예산 이력을 이어 쓰지 않고 거부한다.
    if (accounting.approvalDigest !== manifestDigest(manifest)) {
        throw new OrchestrationError("accounting_approval_mismatch", "durable 회계가 이 run의 승인 manifest에 묶여 있지 않다(승인이 바뀌면 예산을 이어 쓰지 않는다)");
    }
    const state = {
        schemaVersion: RUN_STATE_SCHEMA_VERSION,
        runId: assertSlug(o.runId, "run_state.runId"),
        milestoneId,
        manifest,
        accounting,
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
    assertUniqueDispatchClaims(state.tasks);
    assertManifestOwnership(state);
    assertSessionLimit(state);
    for (const m of state.messages) {
        if (!byId.has(m.taskId))
            throw new OrchestrationError("unknown_task", `message ${m.messageId}의 taskId 미상: ${m.taskId}`);
        if (m.routeToTaskId !== null && !byId.has(m.routeToTaskId)) {
            throw new OrchestrationError("unknown_task", `message ${m.messageId}의 routeToTaskId 미상: ${m.routeToTaskId}`);
        }
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
 * M4c 핵심 불변식 ①: **모든 task의 ownership이 승인 범위 안이다.**
 * ⓐ 어떤 task의 ownership도 manifest `writableRoots` 밖일 수 없다.
 * ⓑ root/dependent task(중앙이 직접 만든 task)는 `ownershipByTask`에 **명시 승인**이 있어야 하고
 *    그 범위 안이어야 한다.
 * ⓒ child task는 **parent가 가진 ownership의 부분집합**만 위임받는다(권한 확대 금지).
 *
 * M4b의 자원 불변식과 같은 자리에 둔 이유도 같다 — 커밋 경로와 load가 **같은 검사 하나**를 지나므로
 * 새 전이 경로나 손편집 state가 우회할 수 없다.
 */
export function assertManifestOwnership(state) {
    const manifest = state.manifest;
    const byId = new Map(state.tasks.map((t) => [t.taskId, t]));
    for (const t of state.tasks) {
        for (const p of t.ownership) {
            if (!manifest.writableRoots.some((root) => pathWithin(p, root))) {
                throw new OrchestrationError("ownership_outside_writable_root", `task ${t.taskId}의 ownership ${p}가 승인된 writableRoots 밖이다`);
            }
        }
        if (t.parentTaskId === null) {
            const approved = Object.prototype.hasOwnProperty.call(manifest.ownershipByTask, t.taskId)
                ? manifest.ownershipByTask[t.taskId]
                : undefined;
            if (approved === undefined) {
                throw new OrchestrationError("ownership_not_approved", `task ${t.taskId}의 ownership이 manifest에 승인되어 있지 않다`);
            }
            for (const p of t.ownership) {
                if (!approved.some((a) => pathWithin(p, a))) {
                    throw new OrchestrationError("ownership_not_approved", `task ${t.taskId}의 ownership ${p}가 승인 범위 밖이다`);
                }
            }
            continue;
        }
        const parent = byId.get(t.parentTaskId);
        if (!parent)
            throw new OrchestrationError("unknown_parent", `task ${t.taskId}의 parent 미상: ${t.parentTaskId}`);
        for (const p of t.ownership) {
            if (!parent.ownership.some((a) => pathWithin(p, a))) {
                throw new OrchestrationError("ownership_not_delegated", `child ${t.taskId}의 ownership ${p}는 parent ${parent.taskId}가 가진 범위 밖이다`);
            }
        }
    }
}
/**
 * 승인 manifest의 **canonical digest**. 정규화된 사본을 정렬된 key 순서로 직렬화하므로 같은 승인은
 * 언제나 같은 값이다. durable 회계를 이 승인에 묶는 데 쓴다(`accounting.approvalDigest`).
 */
export function manifestDigest(manifest) {
    return sha256Hex(JSON.stringify(manifest));
}
/**
 * M4c 핵심 불변식 ②: **자원을 점유하는 상태**의 task 수는 manifest `maxSessions`를 넘지 않는다.
 *
 * M5c 정정(대장 `B-11`/`B-13`): 이전 판은 `running`만 셌으므로 ⓐ preflight를 통과해 attempt·worktree를
 * 배정받은 `prepared` task와 ⓑ 아직 자손 프로세스가 남아 있을 수 있는 `cleaning` task가 **승인된 동시
 * 세션 예산 밖에서** 자원을 붙잡았다. 점유 상태 목록은 `RESOURCE_HOLDING_STATES` 하나가 정본이다.
 */
export function assertSessionLimit(state) {
    const holders = state.tasks.filter((t) => holdsResources(t.state)).length;
    if (holders > state.manifest.maxSessions) {
        throw new OrchestrationError("max_sessions_exceeded", `자원 점유 task ${holders}건이 승인된 maxSessions(${state.manifest.maxSessions})를 넘는다`);
    }
}
/**
 * M4b 핵심 불변식: **같은 배타 자원 class를 점유 상태 task 둘이 동시에 가질 수 없다.**
 * 점유 상태는 `prepared`·`running`·`cleaning`이고(M5c) `waiting_children`은 중단 상태라 점유하지 않는다.
 * kernel이 만든 state와 디스크에서 읽은 state 모두 이 검사를 통과해야 하므로,
 * scheduler를 우회한 전이나 손으로 고친 state는 커밋·load 어느 쪽에서도 통과하지 못한다.
 */
export function assertExclusiveResourceClaims(tasks) {
    const holder = new Map();
    for (const t of tasks) {
        if (!holdsResources(t.state))
            continue;
        for (const r of t.resourceClasses) {
            const other = holder.get(r);
            if (other !== undefined) {
                throw new OrchestrationError("resource_conflict", `배타 자원 class '${r}'를 점유 상태 task 둘이 가진다: ${other}, ${t.taskId}`);
            }
            holder.set(r, t.taskId);
        }
    }
}
/**
 * **turn ID는 run 전역에서 유일하게 claim된다**(3A 6차 리비전 A1).
 *
 * 과금 namespace(`accounting.chargedTurnIds`)가 run 전역인데 claim은 task-local이었다 → task A가 turn X를
 * claim한 상태에서 task B도 같은 X를 genuine permit으로 claim할 수 있었고, B가 먼저 과금하면 A의 진짜
 * 과금이 `turn_already_charged`로 영구히 막혀 A의 claim은 다시는 정산되지 못했다(교착).
 * claim namespace를 과금 namespace와 같은 폭으로 맞춘다: **한 turn ID는 한 task만 claim한다.**
 *
 * kernel 커밋과 디스크 load 양쪽이 이 검사를 지나므로 손으로 만든 중복 claim state도 `open()`에서 거부된다.
 */
export function assertUniqueDispatchClaims(tasks) {
    const holder = new Map();
    for (const t of tasks) {
        const turnId = t.execution.dispatchTurnId;
        if (turnId === null)
            continue;
        const other = holder.get(turnId);
        if (other !== undefined) {
            throw new OrchestrationError("invalid_state", `dispatch turn '${turnId}'을 task 둘이 동시에 claim한다: ${other}, ${t.taskId}`);
        }
        holder.set(turnId, t.taskId);
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
/**
 * M4c — 아직 수령되지 않은 전달 목록. **durable state에서만** 계산하므로 재시작 후에도 같은 순서다.
 * 정렬은 `createdAt` → `messageId`(동시각 tie-break)이며 둘 다 state 안의 값이다.
 * `taskId`를 주면 그 task의 inbox만 돌려준다.
 */
export function pendingDeliveries(state, taskId) {
    return state.messages
        .filter((m) => m.routeToTaskId !== null && m.acknowledgedAt === null && (taskId === undefined || m.routeToTaskId === taskId))
        .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
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
    // 승인 envelope는 **bounded·비밀 아님**만 싣는다(경로·상한·만료). secret·토큰·자격증명은 계약에 없다.
    const m = state.manifest;
    lines.push("## Milestone Approval");
    lines.push(`- milestone: ${m.milestoneId}`);
    lines.push(`- approvedCommit: ${m.approvedCommit}`);
    lines.push(`- writableRoots: ${m.writableRoots.join(", ")}`);
    lines.push(`- maxSessions: ${m.maxSessions}`);
    lines.push(`- maxTokens: ${m.maxTokens === null ? "(none)" : m.maxTokens}`);
    lines.push(`- maxElapsedMs: ${m.maxElapsedMs}`);
    lines.push(`- localMergeAllowed: ${m.localMergeAllowed} (기록 전용 — kernel은 git 조작을 하지 않는다)`);
    lines.push(`- expiresAt: ${m.expiresAt}`);
    lines.push(`- allowedCommands: ${m.allowedCommands.length > 0 ? m.allowedCommands.join(" | ") : "(none)"}`);
    lines.push(`- allowedDependencies: ${m.allowedDependencies.length > 0 ? m.allowedDependencies.map((d) => `${d.name}@${d.version}`).join(", ") : "(none)"}`);
    lines.push(`- allowedNetworkDomains: ${m.allowedNetworkDomains.length > 0 ? m.allowedNetworkDomains.join(", ") : "(none)"}`);
    for (const taskId of Object.keys(m.ownershipByTask).sort()) {
        lines.push(`- ownership[${taskId}]: ${m.ownershipByTask[taskId].join(", ")}`);
    }
    lines.push("");
    // M5c autopilot 정책·typed operation 권위: **bounded 선언만** 싣는다(파일 내용·argv 값은 담지 않는다).
    const p = m.autopilotPolicy;
    lines.push("## Autopilot Policy");
    lines.push(`- maxTaskAttempts: ${p.maxTaskAttempts} · maxDeliveryAttempts: ${p.maxDeliveryAttempts}`);
    lines.push(`- retryBackoffMs: ${p.retryBackoffMs} · deliveryDeadlineMs: ${p.deliveryDeadlineMs}`);
    lines.push(`- maxNoProgressMs: ${p.maxNoProgressMs} · maxAttemptElapsedMs: ${p.maxAttemptElapsedMs}`);
    lines.push(`- cleanupTermGraceMs: ${p.cleanupTermGraceMs} · cleanupKillGraceMs: ${p.cleanupKillGraceMs}`);
    const opTaskIds = Object.keys(m.operationAuthorityByTask).sort();
    if (opTaskIds.length === 0)
        lines.push("- operationAuthority: (none — typed write/process 권위가 승인되지 않았다)");
    for (const taskId of opTaskIds) {
        // authorityId와 kind만 — 승인된 경로/argv는 승인 문서에 있고 snapshot은 그것을 복제하지 않는다.
        const kinds = m.operationAuthorityByTask[taskId].map((op) => `${op.authorityId}:${op.kind}`).join(", ");
        lines.push(`- operationAuthority[${taskId}]: ${kinds.length > 0 ? kinds : "(none)"}`);
    }
    lines.push("");
    // durable 예산 회계 — 재시작이 이 값을 이어 쓴다(대장 `B-12`). 카운터만이고 raw는 없다.
    const acc = state.accounting;
    lines.push("## Budget Accounting (durable)");
    lines.push(`- budgetStartedAt: ${acc.budgetStartedAt}`);
    lines.push(`- budgetDeadlineAt: ${acc.budgetDeadlineAt}`);
    lines.push(`- tokensUsed: ${acc.tokensUsed}${m.maxTokens === null ? "" : ` / ${m.maxTokens}`}`);
    lines.push(`- elapsedMsUsed: ${acc.elapsedMsUsed} / ${m.maxElapsedMs}`);
    lines.push(`- chargedTurns: ${acc.chargedTurnIds.length}`);
    lines.push("");
    lines.push("## Specialist Registry");
    for (const r of SPECIALIST_ROLES)
        lines.push(`- ${r.roleId} — ${r.title}`);
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
        // M5c lifecycle — **marker와 카운터만**. PID/PGID/argv/transcript는 state에 없으므로 여기에도 없다.
        const e = t.execution;
        lines.push(`- execution: attempt=${e.attemptNo} progress=${e.progressCount} cleanup=${e.cleanupStatus}` +
            ` marker=${e.terminalMarker ?? "(none)"} pause=${e.pauseReason ?? "(none)"}`);
        if (e.wallDeadlineAt !== null)
            lines.push(`- wallDeadlineAt: ${e.wallDeadlineAt}`);
        if (e.retryAt !== null)
            lines.push(`- retryAt: ${e.retryAt} (deadline ${e.retryDeadlineAt ?? "(none)"})`);
        if (e.processLeaseMarker !== null)
            lines.push(`- processLease: ${e.processLeaseMarker}`);
        for (const r of e.operationReceipts) {
            lines.push(`- operation: ${r.operationId} ${r.kind} ${r.marker}${r.path === null ? "" : ` path=${r.path}`}`);
        }
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
    for (const msg of state.messages) {
        lines.push(`- ${msg.messageId} type=${msg.type} task=${msg.taskId} ${msg.sender}→${msg.recipient} body=${msg.bodyPath} sha256=${msg.bodySha256}`);
        if (msg.routeToTaskId !== null) {
            lines.push(`  - routedTo: ${msg.routeToTaskId} ack=${msg.acknowledgedAt ?? "(pending)"}`);
            const d = msg.delivery;
            lines.push(`  - delivery: attempts=${d.attempts} marker=${d.lastMarker ?? "(none)"}` +
                ` next=${d.nextAttemptAt ?? "(none)"} deadline=${d.deadlineAt ?? "(none)"}`);
        }
        if (msg.summary !== null)
            lines.push(`  - summary: ${msg.summary}`);
    }
    lines.push("");
    // 재시작 후에도 같은 순서가 나오는지 눈으로 확인할 수 있게 파생 목록도 남긴다(state만으로 계산).
    lines.push("## Pending Deliveries");
    const pending = pendingDeliveries(state);
    if (pending.length === 0)
        lines.push("- (none)");
    for (const p of pending)
        lines.push(`- ${p.messageId} → ${p.routeToTaskId} type=${p.type} at=${p.createdAt}`);
    lines.push("");
    return lines.join("\n");
}
// ── 영속화 ──────────────────────────────────────────────────────────────────
/**
 * **발행 경계 이름**(A3 fault 주입 대상). 이 목록이 곧 "복구 규칙이 덮어야 하는 실패 지점 전부"다.
 * `commitRun`이 지나는 순서대로다.
 */
export const COMMIT_STAGES = [
    "body:write",
    "body:rename",
    "journal:write",
    "journal:rename",
    "events:append",
    "snapshot:write",
    "snapshot:rename",
    "state:write",
    "state:rename",
    "body:publish",
    "journal:cleanup",
];
/**
 * **store 안에만 있는 bounded fault 주입 seam**(V3 M5b 4차 독립 리뷰 A3). 발행 경계마다 실패를 넣어
 * 복구 규칙을 실제로 검증하기 위한 것이며, **kernel·provider 권위에는 연결되지 않는다**:
 * 이 hook은 상태를 만들지도 검증을 완화하지도 않는다(성공 경로에서는 `null`이라 아무 일도 하지 않는다).
 *
 * **정확히 적는다(7차 독립 리뷰 C-36 증거 갱신)**: 이 콜백이 할 수 있는 것은 "던지는 일뿐"이 **아니다** —
 * 동기 콜백이므로 파일 시스템을 임의로 바꿀 수도 있다(테스트가 실제로 그렇게 쓴다). 그래서 발행 경로는
 * hook **이후**에 소유·내용을 다시 증명하고(`publishOwnedBodies`) journal 삭제 **직전**에 전수 재검증한다
 * (`finishJournal`) → hook이 만든 변경은 **fail closed로 잡히고 복구 기록이 남는다**.
 * export된 가변 전역이라는 절충 자체는 그대로 대장 `C-36`(open)이다.
 */
let commitFaultHook = null;
/** 테스트 전용. production 호출부는 없다(부르면 그 프로세스의 커밋에만 영향이 있다). */
export function setCommitFaultHook(hook) {
    commitFaultHook = hook;
}
function faultPoint(stage) {
    if (commitFaultHook !== null)
        commitFaultHook(stage);
}
/** 같은 디렉터리 임시 파일 → rename. (M4a 범위: 과도한 fsync/crash hardening은 하지 않는다) */
function writeAtomic(target, data, stage) {
    const tmp = `${target}.tmp-${process.pid}`;
    try {
        if (stage)
            faultPoint(`${stage}:write`);
        writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
        if (stage)
            faultPoint(`${stage}:rename`);
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
        // manifest도 digest에 들어간다 → 승인 범위를 손으로 넓히면 state↔event binding에서 거부된다.
        manifest: state.manifest,
        // 회계도 들어간다 → **토큰·경과 사용량을 손으로 되돌리는 것**도 binding 검사에서 거부된다(`B-12`).
        accounting: state.accounting,
        revision: state.revision,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        tasks: state.tasks,
        messages: state.messages,
        artifacts: state.artifacts,
    }));
}
const O_NOFOLLOW_SUPPORTED = typeof fsConstants.O_NOFOLLOW === "number";
/** lock 파일을 `O_NOFOLLOW`로만 읽어 소유자 record로 파싱한다. 형태가 아니면 `null`(= 미상 소유자). */
function readLockOwner(file) {
    let text;
    let fd;
    try {
        fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    catch {
        return null;
    }
    try {
        text = readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    if (typeof o.nonce !== "string" || !/^[0-9a-f]{32}$/.test(o.nonce))
        return null;
    if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 1)
        return null;
    return { nonce: o.nonce, pid: o.pid };
}
/**
 * **그 pid가 지금 존재하지 않는다는 것을 관측했는가.** `ESRCH`만 "없다"이며 `EPERM`(살아 있으나 신호를
 * 보낼 수 없다)과 그 밖의 오류는 **모두 "알 수 없다"** 로 접는다(fail closed — 미확인이 회수 근거가 되지
 * 않는다). `managedProcess.groupAlive`와 같은 규율이고 부호만 다르다(그쪽은 그룹, 이쪽은 단일 pid).
 */
function pidProvablyGone(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (e) {
        return e.code === "ESRCH";
    }
}
/**
 * run 하나의 커밋을 직렬화하는 배타 lock. 발행은 **temp + `link`(no-clobber)** 이므로 이미 있으면
 * `EEXIST`이고 **대기하지 않는다**. lock 파일에는 `{nonce, pid}` 한 줄이 들어간다.
 *
 * **stale lock 회수(V3 M10 T1 — 대장 `C-8` · `C-4` 보강).** 이전 판은 lock이 남으면 그 run의 이후 커밋을
 * **영구히** 거부했다(사람이 지워야 했다). 그 결과 `commitRun` 도중 SIGKILL이면 journal 기반 복구가
 * 이미 결정론적으로 준비돼 있는데도 `loadRun`이 lock 획득에서 먼저 죽어 **복구에 도달하지 못했다** —
 * "재시작하면 복구된다"가 실제로는 거짓이었다.
 *
 * 회수 규칙은 **한 방향으로만 fail closed**다: `process.kill(pid, 0)`가 `ESRCH`를 낼 때, 즉 **그 pid가
 * 존재하지 않는다는 것을 관측했을 때만** 회수한다. 살아 있거나(`EPERM` 포함) 소유자 record가 미상이면
 * 이전과 똑같이 `run_lock_held`다.
 *
 * **회수 자체는 전용 lock 안에서 한다**(T1 적대적 리뷰 A2). 첫 판은 "재확인 → unlink → 발행"이었는데,
 * 두 프로세스가 같은 죽은 lock을 보면 **둘 다 재확인을 통과**하고 나중 쪽의 `unlink`가 **먼저 회수한
 * 쪽의 살아 있는 lock을 지운다** → 두 writer가 동시에 커밋을 열고, 그 창에서는 `assertDurableBase`도
 * 둘 다 통과할 수 있어 event chain이 깨진다. `run_state.lock.reclaim`을 `O_EXCL`로 잡아 **회수자를
 * 하나로 직렬화**하고, 그 안에서 소유자를 다시 읽는다 → 나중 쪽은 살아 있는 lock을 보고 거부한다.
 *
 * ponytail: 남는 구멍 셋을 그대로 적는다. ⓐ **pid 재사용** — 죽은 소유자의 pid가 재사용되면 회수하지
 * 않고 사람 개입이 필요하다(= 이전 판의 동작이며 안전한 방향이다). `ps lstart`로 시작 신원까지 보면
 * 닫히지만 그것은 store 계층에서 **프로세스를 spawn한다**는 뜻이라(이 파일은 spawn이 0이다) 비용이
 * 값어치를 넘는다. ⓑ **회수 lock 자체가 새는 경우** — 회수 도중 죽으면 `run_state.lock.reclaim`이 남아
 * 그 run의 **회수만** 영구히 닫힌다(커밋은 여전히 `run_lock_held`로 fail closed이고 사람이 파일 하나를
 * 지우면 된다). 회수 lock을 또 회수하지는 않는다 — 거북이 탑이 된다. ⓒ **같은 기계 가정** — pid는 호스트
 * 로컬이므로 네트워크 파일 시스템에 run을 두고 다른 호스트에서 커밋하면 이 판정은 성립하지 않는다.
 * suite lock(`scripts/lib/suite-exclusive-lock.mjs`)의 pgid 스캔·ownership token 상속은 여기서도
 * 재사용하지 않는다 — 그쪽은 자식 프로세스를 쥔 suite 전용 의미이고, 커밋은 순수 파일 트랜잭션이라
 * 소유자 사망 뒤의 복구가 journal로 결정론적이다(그래서 회수가 원리적으로 건전하다).
 */
export function acquireRunWriterLock(paths) {
    ensureRunDir(paths);
    return acquireOwnedLock(paths.lockFile, `이 run에 다른 writer가 커밋 중이다(대기하지 않는다): ${paths.runId}`);
}
/**
 * **pid 소유 배타 lock 하나를 잡는다** — writer lock과 controller lease가 **같은 기계**를 쓴다
 * (V3 M10 T3에서 일반화했다). 규칙·한계는 전부 `acquireRunWriterLock` 주석에 있다: temp+`link` 발행 ·
 * `ESRCH` 관측에만 회수 · 회수는 `<lock>.reclaim`(`O_EXCL`)로 직렬화 · pid 재사용·회수 lock 누출·
 * 같은 기계 가정이 남는 구멍이다. **두 번째 lock 구현을 만들지 않는 것이 이 함수의 존재 이유다.**
 */
export function acquireOwnedLock(file, heldMessage) {
    const nonce = randomBytes(16).toString("hex");
    if (!publishLockFile(file, nonce)) {
        reclaimDeadLock(file, nonce, heldMessage);
    }
    return { file, nonce };
}
/** 이 acquire가 만든 lock만 해제한다(`releaseRunWriterLock`과 같은 규율). */
export function releaseOwnedLock(lock) {
    if (!O_NOFOLLOW_SUPPORTED) {
        throw new OrchestrationError("run_lock_nofollow_unsupported", "이 플랫폼은 O_NOFOLLOW를 지원하지 않는다");
    }
    const owner = readLockOwner(lock.file);
    if (owner === null) {
        throw new OrchestrationError("run_lock_release_failed", "해제할 lock을 읽을 수 없다(교체·삭제됨)");
    }
    if (owner.nonce !== lock.nonce) {
        throw new OrchestrationError("run_lock_owner_mismatch", "lock 소유자가 다르다 — 남의 lock은 지우지 않는다");
    }
    unlinkSync(lock.file);
}
/**
 * **죽은 소유자의 lock만 회수하고 이 프로세스 것으로 발행한다.** 회수자는 `<lock>.reclaim`(`O_EXCL`)로
 * 직렬화되므로 동시에 둘이 회수하지 못한다 — 그것이 A2(나중 회수자가 먼저 회수한 쪽의 **살아 있는** lock을
 * 지우는 경로)를 없애는 근거다. 실패는 전부 `run_lock_held`(= 아무것도 바꾸지 않았다)로 접힌다.
 */
function reclaimDeadLock(file, nonce, heldMessage) {
    const held = (what) => new OrchestrationError("run_lock_held", `${what} (${heldMessage})`);
    const reclaimFile = `${file}.reclaim`;
    let guard;
    try {
        guard = openSync(reclaimFile, "wx", 0o600);
    }
    catch (e) {
        // 다른 프로세스가 이미 회수 중이거나(EEXIST) 회수 도중 죽어 남은 잔재다 — 어느 쪽이든 회수하지 않는다.
        if (e.code === "EEXIST")
            throw held("다른 소유자가 lock을 회수 중이다");
        throw e;
    }
    try {
        closeSync(guard);
        // **회수 lock 안에서 다시 읽는다**: 앞선 회수자가 이미 자기 lock을 발행했다면 여기서 살아 있는
        // 소유자를 보고 거부한다.
        const owner = readLockOwner(file);
        if (owner === null)
            throw held("lock 소유자를 알 수 없다(회수하지 않는다)");
        if (!pidProvablyGone(owner.pid))
            throw held("살아 있는 소유자가 lock을 쥐고 있다(대기하지 않는다)");
        try {
            unlinkSync(file);
        }
        catch {
            throw held("죽은 소유자의 lock을 회수할 수 없다");
        }
        if (!publishLockFile(file, nonce))
            throw held("회수한 lock을 다른 소유자가 먼저 잡았다");
    }
    finally {
        try {
            unlinkSync(reclaimFile);
        }
        catch {
            /* 회수 lock 잔재는 회수만 닫는다(커밋은 fail closed 그대로) — 위 ponytail ⓑ. */
        }
    }
}
/**
 * lock 파일을 **완성된 내용으로 원자적으로** 발행한다(temp write → `link` no-clobber → temp 정리).
 * `false`는 `EEXIST`(이미 있다)뿐이고 그 밖의 오류는 그대로 올린다.
 *
 * `open("wx")` + write를 쓰지 않는 이유(대장 `C-4` 보강 ⓒ): 그 순서는 **빈 lock 파일**이 남는 창을
 * 만들고, 빈 파일은 소유자 미상이라 회수할 수 없어 run을 영구히 막는다. link은 완성된 파일에만
 * 이름을 붙이므로 그 창이 0이다. body 발행(`publishOwnedBodies`)이 쓰는 것과 같은 idiom이다.
 */
function publishLockFile(file, nonce) {
    const staging = `${file}.${nonce}`;
    let fd;
    try {
        fd = openSync(staging, "wx", 0o600);
    }
    catch (e) {
        if (e.code === "EEXIST") {
            // 같은 nonce의 staging이 남아 있다 = 난수 충돌이거나 앞선 실패 잔재다. 남의 것일 수 있으니 지우지 않는다.
            throw new OrchestrationError("run_lock_held", "writer lock staging 이름이 이미 있다");
        }
        throw e;
    }
    try {
        writeFileSync(fd, `${JSON.stringify({ nonce, pid: process.pid })}\n`, { encoding: "utf8" });
    }
    finally {
        closeSync(fd);
    }
    try {
        linkSync(staging, file);
        return true;
    }
    catch (e) {
        if (e.code === "EEXIST")
            return false;
        throw e;
    }
    finally {
        try {
            unlinkSync(staging);
        }
        catch {
            /* staging 잔재는 다음 acquire가 새 nonce로 우회한다 — 발행 성공 여부를 바꾸지 않는다. */
        }
    }
}
/**
 * **이 acquire가 만든 lock만** 해제한다. 최종 엔트리는 `O_NOFOLLOW`로만 읽고(symlink 교체 거부),
 * nonce가 다르면 남의 lock이므로 **지우지 않고** `run_lock_owner_mismatch`로 올린다.
 *
 * ponytail: Node 18에 compare-and-unlink가 없어 "확인 → unlink" 창을 0으로 만들 수 없다
 * (대장 `C-5`와 같은 한계 — 창 최소화 + 사후 탐지).
 */
export function releaseRunWriterLock(paths, lock) {
    releaseOwnedLock({ file: paths.lockFile, nonce: lock.nonce });
}
/**
 * lock을 쥔 상태에서 디스크가 아직 호출자의 기준과 같은지 확인한다.
 * 다르면 **아무것도 쓰지 않고** `stale_writer`로 거부한다 — 늦은 writer가 먼저 쓴 결과를 덮거나
 * 남의 event tail에 이어 붙여 체인을 깨뜨리는 경로를 없앤다.
 *
 * 통과하면 **기준 state의 원문·digest·검증된 값**을 돌려준다(최초 커밋은 null) — journal이 그 신원을
 * 들고 가므로 복구가 "디스크가 정확히 그 기준인가"를 revision 숫자가 아니라 **원본 바이트 + 불변
 * 권위 신원**으로 판정한다.
 */
function assertDurableBase(paths, base) {
    if (base === null) {
        if (runExists(paths)) {
            throw new OrchestrationError("run_already_exists", `이미 존재하는 run이다: ${paths.runId}`);
        }
        return null;
    }
    if (!runExists(paths)) {
        throw new OrchestrationError("stale_writer", "커밋 기준 run_state.json이 디스크에서 사라졌다");
    }
    const text = readFileSync(paths.stateFile, "utf8");
    let parsed;
    try {
        parsed = JSON.parse(text);
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
    return { text, sha256: sha256Hex(text), state: validateRunState(parsed) };
}
// ── M5b: 발행 journal (closed schema · 전이에 암호학적·구조적으로 묶인다) ────────
//
// **5차 독립 리뷰 A3.** 이전 판의 journal은 열린 객체였다: 미상 key를 허용했고 `base`를 검사 없이 받았고
// 아무 숫자나 `baseEventBytes`로 썼고 event·state 문자열을 그대로 신뢰했다. 복구는 embedded state의
// 일반 schema와 revision 숫자만 봤으므로, 그럴듯한 journal 하나로 **유효한 state를 호출자가 고른 state로
// 덮어쓸 수** 있었다. 지금 journal은 아래 전부를 **발행 전에** 증명해야 한다:
// 경로 runId · milestone · 승인 manifest 신원 · **기준 state 원본 바이트 digest** · 기준 event 바이트 수와
// tail 신원 · **후속 revision** · 정규 event record와 번호·해시 체인 · 최종 event hash와 state digest ·
// 발행할 state의 정규 바이트 형태 · staged/final body 대상과 **내용 digest**.
const JOURNAL_SCHEMA = "m5b-commit-journal-1";
/** journal 파일 자체의 바이트 상한 — 외부 조작으로 무한정 큰 파일을 읽지 않는다. */
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
/** 한 커밋이 append하는 event 줄 수 상한(kernel 트랜잭션 하나는 batch·산출물 상한 안이다). */
const MAX_JOURNAL_EVENTS = 64;
/** 한 커밋이 발행하는 body 수 상한(kernel 트랜잭션 하나가 수락하는 메시지는 몇 건이다). */
const MAX_JOURNAL_BODIES = 8;
/** `events.jsonl` 바이트 수의 정적 상한 — 형식 검증 단계에서 범위 밖 값을 거른다. */
const MAX_EVENT_FILE_BYTES = 1_073_741_824;
const TXN_ID_RE = /^[0-9a-f]{32}$/;
const JOURNAL_KEYS = [
    "schema",
    "txnId",
    "runId",
    "milestoneId",
    "base",
    "baseEventBytes",
    "targetRevision",
    "eventCount",
    "events",
    "state",
    "stateSha256",
    "stateDigest",
    "lastEventId",
    "lastEventHash",
    "manifestDigest",
    "bodies",
];
const JOURNAL_BASE_KEYS = [
    "revision",
    "lastEventId",
    "lastEventHash",
    "stateSha256",
    "milestoneId",
    "manifestDigest",
    "contentDigest",
    "createdAt",
    "messageCount",
];
const JOURNAL_BODY_KEYS = ["messageId", "sha256", "bytes", "dev", "ino"];
function jfail(code, message) {
    throw new OrchestrationError(code, message);
}
/** 이 트랜잭션이 소유하는 staging 경로. 최종 경로(`messages/<id>.md`)와 절대 겹치지 않는다. */
function stagedBodyPath(paths, txnId, messageId) {
    return join(paths.messagesDir, `.staged-${txnId}.${messageId}.md`);
}
function readJournal(paths) {
    if (!existsSync(paths.journalFile))
        return null;
    const st = lstatSync(paths.journalFile);
    if (st.isSymbolicLink() || !st.isFile()) {
        throw new OrchestrationError("journal_not_regular_file", "commit.journal이 일반 파일이 아니다");
    }
    if (st.size > MAX_JOURNAL_BYTES)
        jfail("journal_invalid", "commit.journal이 상한보다 크다");
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(paths.journalFile, "utf8"));
    }
    catch {
        // journal은 rename으로 발행하므로 부분 기록이 생기지 않는다 → 손상은 외부 조작이다(fail closed).
        throw new OrchestrationError("journal_unparsable", "commit.journal이 JSON이 아니다");
    }
    try {
        return validateJournal(paths, parsed);
    }
    catch (e) {
        // 계약 위반은 **단일 안정 코드**로 접는다 — 내부 validator의 코드(`invalid_state` 등)가 새어 나가
        // 복구 분기의 taxonomy를 흔들지 않게 한다.
        if (e instanceof OrchestrationError && e.code.startsWith("journal_"))
            throw e;
        jfail("journal_invalid", "commit.journal이 계약과 다르다");
    }
}
/** closed 검증 + 전이 묶기. 하나라도 어긋나면 던지며 **파일은 하나도 바뀌지 않는다**. */
function validateJournal(paths, raw) {
    const o = asObject(raw, "commit.journal");
    if (o.runId !== paths.runId)
        jfail("journal_foreign", "commit.journal이 다른 run의 것이다");
    closedKeys(o, JOURNAL_KEYS, "commit.journal");
    if (o.schema !== JOURNAL_SCHEMA)
        jfail("journal_invalid", `commit.journal.schema는 "${JOURNAL_SCHEMA}"여야 한다`);
    if (typeof o.txnId !== "string" || !TXN_ID_RE.test(o.txnId)) {
        jfail("journal_invalid", "commit.journal.txnId는 32자 소문자 16진수여야 한다");
    }
    if (typeof o.events !== "string" || typeof o.state !== "string" || typeof o.manifestDigest !== "string") {
        jfail("journal_invalid", "commit.journal의 events/state/manifestDigest는 문자열이어야 한다");
    }
    const milestoneId = assertSlug(o.milestoneId, "commit.journal.milestoneId");
    const baseEventBytes = boundedInt(o.baseEventBytes, "commit.journal.baseEventBytes", 0, MAX_EVENT_FILE_BYTES);
    const targetRevision = boundedInt(o.targetRevision, "commit.journal.targetRevision", 1, 1_000_000);
    const eventCount = boundedInt(o.eventCount, "commit.journal.eventCount", 1, MAX_JOURNAL_EVENTS);
    const lastEventId = boundedInt(o.lastEventId, "commit.journal.lastEventId", 1, 1_000_000);
    const lastEventHash = assertSha256(o.lastEventHash, "commit.journal.lastEventHash");
    const stateSha256 = assertSha256(o.stateSha256, "commit.journal.stateSha256");
    const stateDigest = assertSha256(o.stateDigest, "commit.journal.stateDigest");
    let base = null;
    if (o.base !== null) {
        const b = asObject(o.base, "commit.journal.base");
        closedKeys(b, JOURNAL_BASE_KEYS, "commit.journal.base");
        base = {
            revision: boundedInt(b.revision, "commit.journal.base.revision", 1, 1_000_000),
            lastEventId: boundedInt(b.lastEventId, "commit.journal.base.lastEventId", 0, 1_000_000),
            lastEventHash: assertSha256(b.lastEventHash, "commit.journal.base.lastEventHash"),
            stateSha256: assertSha256(b.stateSha256, "commit.journal.base.stateSha256"),
            milestoneId: assertSlug(b.milestoneId, "commit.journal.base.milestoneId"),
            manifestDigest: assertText(b.manifestDigest, "commit.journal.base.manifestDigest", MAX_JOURNAL_BYTES),
            contentDigest: assertSha256(b.contentDigest, "commit.journal.base.contentDigest"),
            createdAt: assertTimestamp(b.createdAt, "commit.journal.base.createdAt"),
            messageCount: boundedInt(b.messageCount, "commit.journal.base.messageCount", 0, 1_000_000),
        };
    }
    if (base === null) {
        if (targetRevision !== 1 || baseEventBytes !== 0) {
            jfail("journal_invalid", "최초 커밋 journal은 revision 1 · 기준 event 바이트 0이어야 한다");
        }
    }
    else if (targetRevision !== base.revision + 1) {
        jfail("journal_invalid", "commit.journal의 목표 revision은 기준 revision의 바로 다음이어야 한다");
    }
    if (base !== null) {
        // **불변 권위는 전이로 바뀌지 않는다**(6차 리뷰 A3): runId(아래 state 대조) · milestone ·
        // 승인 manifest · 생성 시각은 기준과 정확히 같아야 하고, 기준 내용 digest도 journal이 들고 간다.
        if (base.milestoneId !== milestoneId)
            jfail("journal_foreign", "commit.journal의 기준 milestone이 journal과 다르다");
        if (base.manifestDigest !== o.manifestDigest) {
            jfail("journal_foreign", "commit.journal의 기준 승인 manifest가 목표와 다르다(승인은 전이로 바뀌지 않는다)");
        }
    }
    // 발행할 state를 **load와 같은 validator**로 닫고, 바이트가 정규 직렬화 형태인지까지 본다.
    let wanted;
    try {
        wanted = validateRunState(JSON.parse(o.state));
    }
    catch {
        jfail("journal_invalid", "commit.journal.state가 유효한 run_state가 아니다");
    }
    if (`${JSON.stringify(wanted, null, 2)}\n` !== o.state) {
        jfail("journal_invalid", "commit.journal.state가 정규 직렬화 바이트가 아니다");
    }
    if (sha256Hex(o.state) !== stateSha256)
        jfail("journal_invalid", "commit.journal.stateSha256이 state 바이트와 다르다");
    if (wanted.runId !== paths.runId)
        jfail("journal_foreign", "commit.journal.state가 다른 run의 것이다");
    if (wanted.milestoneId !== milestoneId)
        jfail("journal_foreign", "commit.journal.state의 milestone이 journal과 다르다");
    if (JSON.stringify(wanted.manifest) !== o.manifestDigest) {
        jfail("journal_foreign", "commit.journal의 승인 manifest 신원이 state와 다르다");
    }
    if (wanted.revision !== targetRevision)
        jfail("journal_invalid", "commit.journal.targetRevision이 state와 다르다");
    if (base !== null && wanted.createdAt !== base.createdAt) {
        jfail("journal_foreign", "commit.journal.state의 생성 신원이 기준과 다르다");
    }
    if (wanted.lastEventId !== lastEventId || wanted.lastEventHash !== lastEventHash) {
        jfail("journal_invalid", "commit.journal의 event chain 신원이 state와 다르다");
    }
    if (stateContentDigest(wanted) !== stateDigest)
        jfail("journal_invalid", "commit.journal.stateDigest가 state 내용과 다르다");
    // append할 event 줄 — 정규 record · 번호 · 해시 체인 · revision · 마지막 digest까지 본다.
    const lines = o.events.split("\n");
    if (lines.pop() !== "")
        jfail("journal_invalid", "commit.journal.events는 개행으로 끝나는 줄들이어야 한다");
    if (lines.length !== eventCount)
        jfail("journal_invalid", "commit.journal.eventCount가 실제 줄 수와 다르다");
    const baseEventId = base === null ? 0 : base.lastEventId;
    let prevHash = base === null ? GENESIS_HASH : base.lastEventHash;
    for (let i = 0; i < lines.length; i++) {
        let ev;
        try {
            ev = validateEvent(JSON.parse(lines[i]));
        }
        catch {
            jfail("journal_invalid", `commit.journal.events ${i + 1}번째 줄이 event 계약과 다르다`);
        }
        // 정규 형태 = **validator 출력 바이트 그대로**(6차 리뷰 A3). 이전 판은 `JSON.stringify(JSON.parse(line))`와
        // 비교했으므로 **key 순서를 바꾼 event**가 정규형으로 통과했다. `commitRun`도 같은 함수로 직렬화하므로
        // 디스크 event 바이트와 이 판정은 항상 같은 정본을 쓴다.
        if (JSON.stringify(ev) !== lines[i]) {
            jfail("journal_invalid", `commit.journal.events ${i + 1}번째 줄이 정규 형태가 아니다`);
        }
        if (ev.eventId !== baseEventId + i + 1)
            jfail("journal_invalid", `commit.journal.events ${i + 1}번째 줄의 eventId가 기준과 이어지지 않는다`);
        if (ev.prevHash !== prevHash)
            jfail("journal_invalid", `commit.journal.events ${i + 1}번째 줄의 prevHash가 체인과 다르다`);
        if (ev.revision !== targetRevision)
            jfail("journal_invalid", `commit.journal.events ${i + 1}번째 줄의 revision이 목표와 다르다`);
        const wantDigest = i === lines.length - 1 ? stateDigest : null;
        if (ev.stateDigest !== wantDigest)
            jfail("journal_invalid", `commit.journal.events ${i + 1}번째 줄의 stateDigest가 계약과 다르다`);
        prevHash = sha256Hex(lines[i]);
    }
    if (baseEventId + lines.length !== lastEventId || prevHash !== lastEventHash) {
        jfail("journal_invalid", "commit.journal의 최종 event 신원이 append와 다르다");
    }
    // body 발행 metadata — 대상 messageId와 내용 digest가 발행할 state의 메시지에 정확히 묶인다.
    if (!Array.isArray(o.bodies) || o.bodies.length > MAX_JOURNAL_BODIES) {
        jfail("journal_invalid", `commit.journal.bodies는 ${MAX_JOURNAL_BODIES}개 이하 배열이어야 한다`);
    }
    const bodies = [];
    for (const item of o.bodies) {
        const b = asObject(item, "commit.journal.bodies 항목");
        closedKeys(b, JOURNAL_BODY_KEYS, "commit.journal.bodies 항목");
        const messageId = assertSlug(b.messageId, "commit.journal.bodies[].messageId");
        const sha256 = assertSha256(b.sha256, "commit.journal.bodies[].sha256");
        const bytes = boundedInt(b.bytes, "commit.journal.bodies[].bytes", 1, LIMITS.maxBodyBytes);
        const dev = boundedInt(b.dev, "commit.journal.bodies[].dev", 0, Number.MAX_SAFE_INTEGER);
        const ino = boundedInt(b.ino, "commit.journal.bodies[].ino", 1, Number.MAX_SAFE_INTEGER);
        if (bodies.some((x) => x.messageId === messageId))
            jfail("journal_invalid", `commit.journal.bodies에 중복 messageId: ${messageId}`);
        const m = wanted.messages.find((x) => x.messageId === messageId);
        if (!m)
            jfail("journal_invalid", `commit.journal.bodies가 state에 없는 메시지를 담았다: ${messageId}`);
        if (m.bodySha256 !== sha256)
            jfail("journal_invalid", `commit.journal.bodies의 digest가 state와 다르다: ${messageId}`);
        // 발행 경로는 messageId에서 파생한다(색인이 이미 `messages/<id>.md`를 강제한다 — 자유 경로 없음).
        if (m.bodyPath !== `messages/${messageId}.md`)
            jfail("journal_invalid", `commit.journal.bodies의 경로가 색인 규칙과 다르다: ${messageId}`);
        bodies.push({ messageId, sha256, bytes, dev, ino });
    }
    // **journal은 base→target 새 메시지 delta와 정확히 같다**(6차 리뷰 A3 — 누락도 추가도 없다).
    // kernel은 메시지를 지우지 않으므로 개수 항등식이 곧 delta 항등식이고, 기준 state가 디스크에 있는
    // 경로(복구 · 커밋 전 self-check)에서는 아래 `assertBaseTransition`이 **id 집합**까지 대조한다.
    if (wanted.messages.length !== (base === null ? 0 : base.messageCount) + bodies.length) {
        jfail("journal_invalid", "commit.journal.bodies가 base→target 새 메시지 집합과 다르다(누락 또는 추가)");
    }
    return {
        txnId: o.txnId,
        base,
        baseEventBytes,
        events: o.events,
        eventBytes: Buffer.from(o.events, "utf8"),
        state: o.state,
        wanted,
        bodies,
    };
}
/**
 * **열린 fd 하나로 판정하는 소유 증명**(V3 M5b 7차 독립 리뷰 A2). journal이 고정한 dev+ino ·
 * **정확한 바이트 수** · **내용 SHA-256** 을 같은 fd에서 전부 본다 → `lstat` 뒤 경로를 다시 읽는
 * 사이의 교체·제자리 덮어쓰기 창이 없다. `O_NOFOLLOW`라 symlink는 열리지 않는다.
 *
 * - `absent` — 그 이름이 없다(발행 대상).
 * - `ours` — 이 트랜잭션이 만든 그 바이트다.
 * - `foreign` — 있지만 우리 것이 아니다(신원·크기·내용 중 하나라도 다르거나 판정 불가) → fail closed.
 */
function ownershipOf(file, b) {
    if (!O_NOFOLLOW_SUPPORTED)
        return "foreign";
    let fd;
    try {
        fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    catch (e) {
        // 부재만 "아직 없다"다. symlink(ELOOP)·권한·그 밖은 **남의 것**으로 접는다.
        return e.code === "ENOENT" ? "absent" : "foreign";
    }
    try {
        const st = fstatSync(fd);
        // 크기를 **먼저** 대조한다 → 아래 버퍼는 journal이 승인한 크기(`LIMITS.maxBodyBytes` 이하)다.
        if (!st.isFile() || st.dev !== b.dev || st.ino !== b.ino || st.size !== b.bytes)
            return "foreign";
        const buf = Buffer.allocUnsafe(st.size);
        for (let off = 0; off < st.size;) {
            const n = readSync(fd, buf, off, st.size - off, off);
            if (n <= 0)
                return "foreign"; // 짧게 읽혔다 = 판정 불가
            off += n;
        }
        return sha256Hex(buf) === b.sha256 ? "ours" : "foreign";
    }
    catch {
        return "foreign";
    }
    finally {
        try {
            closeSync(fd);
        }
        catch {
            /* fd 정리 실패는 판정 결과를 가리지 않는다(대장 `C-39`와 같은 종류) */
        }
    }
}
/** 이 커밋이 발행할 **최종** body 경로(색인 규칙과 같은 한 자리에서만 만든다). */
function finalBodyPath(paths, b) {
    return join(paths.dir, `messages/${b.messageId}.md`);
}
/** 최종 엔트리를 따라가지 않고 읽은 신원(없으면 null). symlink·비일반 파일은 **신원이 없다**. */
function regularIdentity(file) {
    let st;
    try {
        st = lstatSync(file);
    }
    catch {
        return null;
    }
    if (st.isSymbolicLink() || !st.isFile())
        return null;
    return { dev: st.dev, ino: st.ino, size: st.size };
}
/**
 * **소유 증명 + no-clobber 발행**(V3 M5b 6차 독립 리뷰 A3).
 *
 * 이전 판은 최종 경로의 **digest만** 보고 "이미 발행됐다"고 인정했고(=남의 same-digest 파일 채택),
 * 없으면 `renameSync`로 덮었다(=plan 이후 생긴 남의 파일을 POSIX rename이 조용히 파괴). 지금은:
 * ⓐ 최종 경로에 파일이 있으면 **journal이 기록한 dev+ino**(= 우리 staging의 신원, hard link는 inode를
 *    보존한다)와 같을 때만 "우리가 이미 발행했다"로 인정하고, 다르면 digest가 같아도
 *    `journal_body_foreign`으로 fail closed다.
 * ⓑ 없으면 staging의 **dev+ino · 정확한 바이트 수 · 내용 digest**를 확인한 뒤 `linkSync`로 만든다 —
 *    `link(2)`는 대상이 있으면 `EEXIST`이므로 **덮어쓰기가 원자적으로 불가능**하다(CAS).
 * ⓒ 경합으로 `EEXIST`면 ⓐ 판정으로 되돌아간다. 어느 경로도 남의 파일을 지우거나 덮지 않는다.
 *
 * 재시도 멱등: 이미 link된 body는 ⓐ에서 통과하고 남은 staging만 정리한다.
 *
 * **판정은 발행 1건 단위다(7차 독립 리뷰 A2).** 이전 판은 ①에서 전수 판정한 뒤 발행 hook을 부르고
 * **경로 이름 그대로** `linkSync`했다 → hook이나 같은 UID의 동시 writer가 ① 이후 staging을 갈아끼우면
 * 그 교체본이 최종 body로 link되고, staging은 지워지고, journal까지 삭제돼 **복구 증거가 사라졌다**
 * (같은 digest면 남의 inode 입양, 다른 digest면 "성공한 커밋 + 잘못된 body"). 지금은 link **직전**과
 * link **직후**에 같은 fd로 다시 증명하고(`ownershipOf`), journal 삭제 전에 **전수 재검증**한다
 * (`finishJournal`). 어긋나면 journal을 남기고 fail closed다.
 *
 * ponytail: 이식성 한계 — `link(2)`는 같은 파일 시스템(여기서는 **같은 디렉터리**)에서만 성립하고
 * dev+ino는 POSIX 신원이다. Windows/네트워크 FS에서 hard link가 없으면 이 발행은 실패로 남는다
 * (fail closed). engines `>=18` · POSIX 대상 범위에서만 지원한다고 적는다.
 * ponytail: `link(2)`는 **경로 이름**을 받으므로 "증명한 fd를 그대로 link"할 수는 없다(Linux
 * `AT_EMPTY_PATH`는 Node API에 없다) → 증명과 link 사이 창을 0으로 만들지는 못한다. 대신 창을 syscall
 * 몇 개로 줄이고 **link 직후 + journal 삭제 직전** 재검증으로 사후 탐지한다(대장 `C-5`와 같은 종류).
 */
function publishOwnedBodies(paths, j) {
    // ① **어떤 이름도 만들기 전에** 전수 판정한다: 이미 우리 것이거나, staging이 정확히 우리 것이어야 한다.
    const pending = [];
    for (const b of j.bodies) {
        if (finalIsOurs(finalBodyPath(paths, b), b))
            continue;
        assertStagedOwned(stagedBodyPath(paths, j.txnId, b.messageId), b);
        pending.push(b);
    }
    // ② 발행 — `link(2)`는 대상이 있으면 EEXIST이므로 덮어쓰기가 원자적으로 불가능하다(CAS).
    for (const b of j.bodies) {
        const finalFile = finalBodyPath(paths, b);
        const stagedFile = stagedBodyPath(paths, j.txnId, b.messageId);
        if (pending.includes(b)) {
            faultPoint("body:publish");
            // **hook 이후·link 직전**에 같은 fd로 다시 증명한다(7차 리뷰 A2): ①과 여기 사이에 staging이
            // 교체됐으면 그 바이트는 link되지 않는다(같은 digest의 다른 inode도 거부 — 입양 금지).
            assertStagedOwned(stagedFile, b);
            try {
                linkSync(stagedFile, finalFile);
            }
            catch (e) {
                if (e.code !== "EEXIST")
                    throw e;
                // 경합: 판정 이후 최종 이름이 생겼다 — 아래 사후 증명이 우리 것인지 판정한다(덮지 않는다).
            }
            // **link 직후** 만들어진 최종 이름을 같은 fd로 증명한다: 교체본이 link됐거나 남의 파일이
            // 먼저 생겼으면 여기서 fail closed다(지우지도 덮지도 않는다).
            if (!finalIsOurs(finalFile, b)) {
                jfail("journal_body_foreign", `발행된 최종 body가 이 트랜잭션 소유가 아니다: ${b.messageId}`);
            }
        }
        // ponytail: staging 정리 실패는 orphan을 남기지만 발행은 이미 확정이다(대장 `C-39`).
        try {
            rmSync(stagedFile, { force: true });
        }
        catch {
            /* 다음 복구·정리가 같은 판정을 반복한다(멱등) */
        }
    }
}
/**
 * **journal 삭제는 여기로만 지난다**(7차 독립 리뷰 A2) — 정상 커밋과 "이미 목표 state" 복구 둘 다.
 * journal 삭제는 곧 **복구 증거 폐기**이므로, 그 전에 journal이 고정한 **모든** 최종 body를 같은 fd로
 * 다시 증명한다(앞선 시도가 이미 발행한 것까지 전수 — 같은 inode·같은 크기의 제자리 내용 변경도 잡는다).
 * `journal:cleanup` fault hook은 이 sweep **앞**에서 울린다 → hook이 만든 임의의 파일 변경도 증거가
 * 남은 채로 탐지된다. 하나라도 어긋나면 journal을 남기고 fail closed이며, 다음 열기·커밋이 같은 판정을
 * 그대로 반복한다(결정론적·멱등).
 */
function finishJournal(paths, j) {
    faultPoint("journal:cleanup");
    for (const b of j.bodies) {
        if (!finalIsOurs(finalBodyPath(paths, b), b)) {
            jfail("journal_body_missing", `발행이 끝나지 않은 최종 body가 있어 복구 기록을 지울 수 없다: ${b.messageId}`);
        }
    }
    rmSync(paths.journalFile, { force: true });
}
/**
 * 최종 경로가 **이 트랜잭션 소유**(journal이 기록한 dev+ino·크기·**내용 digest**)인가.
 * 파일이 없으면 false, 있는데 우리 것이 아니면 **digest가 같아도** fail closed다(채택 금지).
 * 내용까지 보는 이유(7차 리뷰 A2): dev/ino/size만으로는 **같은 inode 제자리 덮어쓰기**를 잡지 못해
 * 그 뒤 journal이 삭제될 수 있었다.
 */
function finalIsOurs(finalFile, b) {
    const owned = ownershipOf(finalFile, b);
    if (owned === "foreign") {
        jfail("journal_body_foreign", `최종 body가 이 트랜잭션이 만든 파일이 아니다: ${b.messageId}`);
    }
    return owned === "ours";
}
/** staging이 journal이 기록한 신원·크기·내용 그대로인가(하나라도 다르면 발행하지 않는다). */
function assertStagedOwned(stagedFile, b) {
    if (ownershipOf(stagedFile, b) !== "ours") {
        jfail("journal_body_missing", `이 커밋의 staged body가 없거나 신원·내용이 journal과 다르다: ${b.messageId}`);
    }
}
/**
 * roll back에서 지우는 것은 **이 트랜잭션 소유 staging뿐**이다(6차 리뷰 A3).
 * 이전 판은 "digest가 같고 기준 state가 참조하지 않는" **최종** body도 지웠으므로, 같은 내용의 남의
 * 파일이 durable data loss를 겪을 수 있었다. 발행 순서를 "state 발행 뒤 body 발행"으로 바꿨기 때문에
 * roll back 시점에는 애초에 우리 최종 body가 존재할 수 없다 — 지울 이유도 없다.
 */
function removeOwnedStaging(paths, j) {
    for (const b of j.bodies) {
        const stagedFile = stagedBodyPath(paths, j.txnId, b.messageId);
        const id = regularIdentity(stagedFile);
        if (id === null)
            continue; // 없거나 우리 파일이 아니다 — 손대지 않는다
        if (id.dev !== b.dev || id.ino !== b.ino)
            continue;
        try {
            rmSync(stagedFile, { force: true });
        }
        catch {
            /* 정리 실패는 orphan을 남긴다(대장 `C-39`) — 상태·최종 body는 그대로다 */
        }
    }
}
/**
 * `events.jsonl`의 **기준 접두**가 정말 이 journal의 base인가: 앞 `baseEventBytes` 바이트가
 * 정확히 `base.lastEventId`줄이고 마지막 줄 hash가 `base.lastEventHash`여야 한다(6차 리뷰 A3).
 * 이 대조가 없으면 `baseEventBytes`를 작게 적은 journal이 **남의 감사 바이트를 자기 append로 주장**해
 * roll back으로 잘라낼 수 있다.
 */
function assertBaseEventPrefix(j, eventBytes) {
    const prefix = eventBytes.subarray(0, j.baseEventBytes).toString("utf8");
    if (prefix.length > 0 && !prefix.endsWith("\n"))
        jfail("journal_unrecognized", "기준 event 접두가 줄 경계가 아니다");
    const lines = prefix.split("\n").filter((l) => l.length > 0);
    const wantId = j.base === null ? 0 : j.base.lastEventId;
    const wantHash = j.base === null ? GENESIS_HASH : j.base.lastEventHash;
    if (lines.length !== wantId)
        jfail("journal_unrecognized", "기준 event 접두의 줄 수가 기준 신원과 다르다");
    const lastHash = lines.length === 0 ? GENESIS_HASH : sha256Hex(lines[lines.length - 1]);
    if (lastHash !== wantHash)
        jfail("journal_unrecognized", "기준 event 접두의 마지막 해시가 기준 신원과 다르다");
}
/**
 * 디스크에 있는 **기준 state 원문**과 journal 기준 신원을 전수 대조하고, journal의 body 목록이
 * base→target **새 메시지 delta와 정확히 같은지**(id 집합) 확인한다. 어느 쪽이든 어긋나면
 * 아무것도 바꾸지 않고 fail closed다.
 */
function assertBaseTransition(j, diskText) {
    const b = j.base;
    if (b === null)
        jfail("journal_unrecognized", "최초 커밋 journal인데 기준 state가 디스크에 있다");
    let baseState;
    try {
        baseState = validateRunState(JSON.parse(diskText));
    }
    catch {
        jfail("journal_unrecognized", "기준 run_state.json을 계약대로 읽을 수 없다");
    }
    if (baseState.revision !== b.revision ||
        baseState.lastEventId !== b.lastEventId ||
        baseState.lastEventHash !== b.lastEventHash ||
        baseState.milestoneId !== b.milestoneId ||
        baseState.createdAt !== b.createdAt ||
        baseState.messages.length !== b.messageCount ||
        JSON.stringify(baseState.manifest) !== b.manifestDigest ||
        stateContentDigest(baseState) !== b.contentDigest) {
        jfail("journal_unrecognized", "디스크 기준 state가 journal이 적은 기준 신원과 다르다");
    }
    const baseIds = new Set(baseState.messages.map((m) => m.messageId));
    const delta = j.wanted.messages.filter((m) => !baseIds.has(m.messageId)).map((m) => m.messageId).sort();
    const listed = j.bodies.map((x) => x.messageId).sort();
    if (delta.join(",") !== listed.join(",")) {
        jfail("journal_invalid", "commit.journal.bodies가 base→target 새 메시지 delta와 다르다(누락 또는 추가)");
    }
    for (const m of j.wanted.messages) {
        if (!baseIds.has(m.messageId))
            continue;
        const prev = baseState.messages.find((x) => x.messageId === m.messageId);
        // 기존 메시지의 body는 이 트랜잭션이 발행하지 않는다 → 내용이 바뀌었다고 주장할 수 없다.
        if (prev && prev.bodySha256 !== m.bodySha256) {
            jfail("journal_invalid", `기존 메시지의 body digest를 바꾸려 한다: ${m.messageId}`);
        }
    }
}
/**
 * **미완 커밋 복구(V3 M5b 4·5·6차 독립 리뷰 A3).** `commitRun`(lock 안)과 `loadRun`이 부른다.
 * journal이 없으면 아무 일도 하지 않는다. **쓰기·삭제를 하기 전에** journal 전체(closed schema + 전이
 * 묶기) · 발행할 state · event append · 기준 event 접두 신원 · 기준 state 전수 신원 · body delta와
 * 소유권 · 디스크 현재 상태를 **모두** 검증한다. 규칙은 **결정론적이고 멱등**이다:
 *
 * 1. 디스크 state 바이트가 **정확히** journal이 발행할 state면 → 정상 커밋 경로가 이미 전이를 durable하게
 *    만든 것이다. 남은 것은 **소유 증명 + no-clobber body 발행**과 `finishJournal`(발행 전수 재검증 →
 *    journal 삭제)뿐이다 — 정상 커밋과 **같은 한 경로**다(7차 리뷰 A2).
 * 2. 디스크 state가 아직 **기준 원본 바이트**면 → **roll back**: 이 트랜잭션 소유 staging 제거 →
 *    `events.jsonl`을 기준 길이로 truncate → journal 삭제. **가시적 전이 0**이며 호출자가 받은 실패가
 *    그대로 진실이다(같은 커밋 재시도 가능). tail이 이 커밋 append의 **정확한 접두이거나 정확히 완전한
 *    append**일 때만 자르고, 그 밖의 바이트(남의 것)는 손대지 않는다.
 * 3. 그 밖(디스크 state가 기준도 목표도 아님)은 **fail closed**다.
 *
 * **roll forward는 없다(6차 리뷰 A3).** 이전 판은 "기준 state + 완전한 append"에서 journal이 적은
 * target state를 **발행**했으므로, 내부 해시를 전부 다시 계산한 **위조 후속**(다른 milestone·다른 승인
 * manifest·다른 task state)이 유효한 state를 덮어쓸 수 있었다. 복구는 이제 **후속을 만들 권한이 없다** —
 * 목표 state는 정상 커밋 경로만 쓰고, 복구는 되돌리거나 이미 쓰인 것을 마무리할 뿐이다.
 * 대가: append가 완전해도 state가 없으면 그 커밋은 **버려진다**(감사 tail은 우리 journal이 소유를 증명한
 * 바이트이므로 되돌린다).
 *
 * **`C-37`은 닫히지 않았다(7차 독립 리뷰 · 앞선 "닫힘" 주석 정정).** roll forward 폐기로 갈림의 범위는
 * 발행 경계 11개 중 **2개**(`body:publish` · `journal:cleanup` — 목표 state가 **이미 durable해진 뒤**)로
 * 줄었을 뿐이다. 그 두 자리에서 실패하면 호출자는 실패를 받지만 다음 열기가 body 발행·정리를
 * **마무리**하므로 caller가 본 결과와 durable 진실이 여전히 갈릴 수 있다 → 대장 `C-37`은 **open**이고
 * 기한은 M5c outcome-marker 처리 전이다.
 */
function recoverPendingCommit(paths) {
    const j = readJournal(paths);
    if (j === null)
        return "none";
    const diskText = runExists(paths) ? readFileSync(paths.stateFile, "utf8") : null;
    const eventBytes = existsSync(paths.eventsFile) ? readFileSync(paths.eventsFile) : Buffer.alloc(0);
    if (eventBytes.length < j.baseEventBytes)
        jfail("journal_unrecognized", "events.jsonl이 커밋 기준보다 짧다");
    assertBaseEventPrefix(j, eventBytes);
    const suffix = eventBytes.subarray(j.baseEventBytes);
    const appendComplete = suffix.equals(j.eventBytes);
    // ① 정상 커밋 경로가 이미 목표 state를 발행했다 → body 발행과 정리만 마무리한다.
    if (diskText !== null && diskText === j.state) {
        if (!appendComplete) {
            jfail("journal_unrecognized", "발행된 state인데 events.jsonl tail이 이 커밋의 append가 아니다");
        }
        publishOwnedBodies(paths, j);
        // journal 삭제는 정상 커밋과 **같은** 경로다(발행 전수 재검증 → 삭제).
        finishJournal(paths, j);
        return "completed";
    }
    // ② 디스크가 아직 이 커밋의 기준인가 — 원본 바이트 digest + 기준 신원 전수.
    if (!baseIsOnDisk(j, diskText)) {
        jfail("journal_unrecognized", `commit.journal이 디스크 state와 이어지지 않는다(목표 revision ${j.wanted.revision}, 기준 ${String(j.base?.revision ?? null)})`);
    }
    if (diskText !== null)
        assertBaseTransition(j, diskText);
    // 이 커밋 append의 **정확한 접두**(빈 tail·찢어진 부분 줄)이거나 **정확히 완전한 append**만 되돌린다.
    // 그 밖의 바이트는 남의 것이므로 **손대지 않는다**.
    if (appendComplete || j.eventBytes.subarray(0, suffix.length).equals(suffix)) {
        removeOwnedStaging(paths, j);
        if (eventBytes.length !== j.baseEventBytes)
            truncateSync(paths.eventsFile, j.baseEventBytes);
        // roll back은 `finishJournal`을 쓰지 않는다: 발행한 최종 body가 애초에 **없다**(body는 state 뒤에
        // 생긴다). 여기서 최종 body 전수 검증을 요구하면 정상 roll back이 영구히 막힌다.
        rmSync(paths.journalFile, { force: true });
        return "rolled_back";
    }
    jfail("journal_foreign", "events.jsonl tail이 이 커밋 append의 정확한 접두도 완전한 append도 아니다");
}
/** 디스크 state가 이 journal의 **기준 원본 바이트**인가(revision·event chain·digest 전부). */
function baseIsOnDisk(j, diskText) {
    if (j.base === null)
        return diskText === null;
    if (diskText === null)
        return false;
    if (sha256Hex(diskText) !== j.base.stateSha256)
        return false;
    let o;
    try {
        o = asObject(JSON.parse(diskText), "run_state");
    }
    catch {
        return false;
    }
    return o.revision === j.base.revision && o.lastEventId === j.base.lastEventId && o.lastEventHash === j.base.lastEventHash;
}
/**
 * 하나의 kernel 변경을 디스크에 반영한다. **검증은 전부 호출 전에 끝나 있어야 한다** —
 * 유효하지 않은 입력은 여기까지 오지 않으므로 invalid input에서는 파일 전이가 0이다.
 *
 * 순서는 **준비 → 발행** 두 국면이다(V3 M5b 4·5·6차 독립 리뷰 A3):
 * ① 준비 — 미완 커밋 복구 → 디스크 기준 확인 → event 줄·최종 state 계산 → **런타임 validator 전체와
 *    참조 무결성으로 예정 state를 검증**(무효한 state는 여기서 끝나므로 절대 발행되지 않는다) →
 *    body를 **트랜잭션 소유 staging 이름**으로만 쓰고 그 **신원(dev+ino)·바이트 수·digest를 기록**한다.
 * ② 발행 — **journal(원자적 rename)** → events append → snapshot → **state** → **body를 최종 이름으로
 *    발행(hard link · no-clobber)** → journal 삭제.
 *    **body 발행이 state 뒤인 이유(6차 리뷰 A3)**: 그래야 "디스크가 아직 기준"인 복구 경로가 최종 body를
 *    만들 필요도, **증명되지 않은 최종 body를 지울 필요도** 없다 → roll back은 자기 staging만 건드린다.
 *    journal 발행 **전** 실패는 이 invocation의 staging만 지우고 끝난다(전이 0 · 최종 body 0).
 *    journal이 있는 동안의 실패는 다음 `commitRun`·`loadRun`이 `recoverPendingCommit`의 규칙대로
 *    **되돌리거나(기준 상태) 마무리한다(이미 목표 state가 쓰인 경우)** → 관찰 결과는 언제나
 *    **일관된 전 상태 또는 후 상태**다. **복구가 후속 state를 발행하는 경로는 없다.**
 *
 * 커밋의 **마지막** 이벤트가 이 커밋이 남기는 state 내용의 digest를 들고 가고, load가 그것을
 * 재계산해 대조한다 → 문법적으로 유효한 state 편집(예: `state`/`resultSummary` 손대기)만으로는
 * kernel을 우회할 수 없다. 그래서 커밋마다 이벤트가 최소 1건 필요하다.
 *
 * M4b: 위 전 과정을 **run 단위 배타 writer lock 하나 안에서** 수행한다. 다른 프로세스가 커밋 중이면
 * 대기 없이 `run_lock_held`, 디스크가 이미 앞서 있으면 `stale_writer`이며 두 경우 다 파일 전이가 0이다.
 */
export function commitRun(paths, input) {
    ensureRunDir(paths);
    const { state, events, bodies } = input;
    if (events.length === 0) {
        throw new OrchestrationError("commit_without_event", "state 커밋은 이벤트를 최소 1건 남겨야 한다");
    }
    if (events.length > MAX_JOURNAL_EVENTS) {
        throw new OrchestrationError("commit_events_too_many", `한 커밋의 이벤트는 ${MAX_JOURNAL_EVENTS}건 이하여야 한다`);
    }
    if (bodies.length > MAX_JOURNAL_BODIES) {
        throw new OrchestrationError("commit_bodies_too_many", `한 커밋의 body는 ${MAX_JOURNAL_BODIES}건 이하여야 한다`);
    }
    // chain 필드를 뺀 내용은 아래 finalState와 동일하므로 append 전에 미리 계산할 수 있다.
    const digest = stateContentDigest(state);
    const lock = acquireRunWriterLock(paths);
    // 이 invocation이 만든 staging. journal 발행 **전** 실패면 전부 지운다(최종 이름은 아직 없다).
    const staged = [];
    let journalPublished = false;
    try {
        recoverPendingCommit(paths);
        const baseState = assertDurableBase(paths, input.base);
        // ── ① 준비: 발행 전에 전부 만들고 전부 검증한다 ──────────────────────────
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
            // **정본은 `validateEvent` 출력이다**(6차 리뷰 A3): 디스크 바이트와 journal의 정규형 판정이
            // 같은 함수에서 나오므로 key 순서를 바꾼 event가 "정규형"으로 통과할 수 없다.
            const line = JSON.stringify(validateEvent(full));
            appended += `${line}\n`;
            prevHash = sha256Hex(line);
        }
        const finalState = { ...state, lastEventId: eventId, lastEventHash: prevHash };
        assertReferentialIntegrity(finalState);
        if (stateContentDigest(finalState) !== digest) {
            throw new OrchestrationError("state_digest_drift", "커밋 중 state 내용이 바뀌었다");
        }
        const stateText = `${JSON.stringify(finalState, null, 2)}\n`;
        // **예정 state 전체를 load와 같은 validator로 다시 닫는다**(4차 리뷰 A3·A4): 호출자 소유 값에서
        // 온 role·경로·enum이 durable에 들어간 뒤 reopen에서만 거부되는 창을 없앤다.
        const validated = validateRunState(JSON.parse(stateText));
        if (stateContentDigest(validated) !== digest) {
            throw new OrchestrationError("state_digest_drift", "예정 state가 정규화 결과와 다르다");
        }
        const snapshotText = renderSnapshot(finalState);
        // body는 **트랜잭션 소유 staging 이름**으로만 만든다 — 최종 이름은 state 발행 뒤에 생긴다.
        // 각 staging의 **신원(dev+ino)·바이트 수·digest**를 journal에 적어 발행 소유권을 증명한다.
        const txnId = randomBytes(16).toString("hex");
        const journalBodies = [];
        for (const b of bodies) {
            const stagedFile = stagedBodyPath(paths, txnId, b.messageId);
            writeAtomic(stagedFile, b.body, "body");
            staged.push(stagedFile);
            const id = regularIdentity(stagedFile);
            if (id === null)
                throw new OrchestrationError("commit_body_staging_failed", `staged body 신원을 읽을 수 없다: ${b.messageId}`);
            journalBodies.push({ messageId: b.messageId, sha256: sha256Hex(b.body), bytes: id.size, dev: id.dev, ino: id.ino });
        }
        // ── ② 발행: journal이 있는 동안의 실패는 복구 규칙이 덮는다 ───────────────
        const baseEventBytes = existsSync(paths.eventsFile) ? statSync(paths.eventsFile).size : 0;
        const journal = {
            schema: JOURNAL_SCHEMA,
            txnId,
            runId: paths.runId,
            milestoneId: finalState.milestoneId,
            base: input.base === null || baseState === null
                ? null
                : {
                    ...input.base,
                    stateSha256: baseState.sha256,
                    // 기준의 **불변 권위**까지 적는다(6차 리뷰 A3) — 복구가 "허용된 후속인가"를 신원으로 판정한다.
                    milestoneId: baseState.state.milestoneId,
                    manifestDigest: JSON.stringify(baseState.state.manifest),
                    contentDigest: stateContentDigest(baseState.state),
                    createdAt: baseState.state.createdAt,
                    messageCount: baseState.state.messages.length,
                },
            baseEventBytes,
            targetRevision: finalState.revision,
            eventCount: events.length,
            events: appended,
            state: stateText,
            stateSha256: sha256Hex(stateText),
            stateDigest: digest,
            lastEventId: finalState.lastEventId,
            lastEventHash: finalState.lastEventHash,
            manifestDigest: JSON.stringify(finalState.manifest),
            bodies: journalBodies,
        };
        // 발행 직전에 journal 자신을 **읽기 경로와 같은 validator**로 닫는다(우리가 만든 기록도 예외가 없다):
        // 기준 신원 · 후속 revision · 정규 event 바이트 · body delta·digest가 여기서 전부 증명된다.
        const selfChecked = validateJournal(paths, JSON.parse(JSON.stringify(journal)));
        if (input.base !== null)
            assertBaseTransition(selfChecked, baseState.text);
        writeAtomic(paths.journalFile, JSON.stringify(journal), "journal");
        journalPublished = true;
        faultPoint("events:append");
        appendFileSync(paths.eventsFile, appended, { encoding: "utf8", mode: 0o600 });
        writeAtomic(paths.snapshotFile, snapshotText, "snapshot");
        writeAtomic(paths.stateFile, stateText, "state");
        // **state가 durable해진 뒤에만** 최종 body 이름이 생긴다(소유 증명 + no-clobber hard link).
        publishOwnedBodies(paths, selfChecked);
        finishJournal(paths, selfChecked);
        return finalState;
    }
    catch (e) {
        // journal 발행 전 실패: 이 invocation의 staging만 지운다(최종 body·복구 대상 전이는 애초에 없다).
        // 발행 뒤라면 정리 주체는 **결정론적 복구**이므로 여기서 아무것도 지우지 않는다.
        if (!journalPublished) {
            for (const f of staged) {
                try {
                    rmSync(f, { force: true });
                }
                catch {
                    /* 정리 실패는 원 오류를 가리지 않는다 */
                }
            }
        }
        throw e;
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
    // 미완 커밋이 있으면 **읽기 전에** 결정론적으로 정리한다(A3). 복구는 쓰기이므로 writer lock 안에서
    // 하고, 다른 writer가 커밋 중이면 대기 없이 `run_lock_held`로 fail closed다(반쪽 상태를 읽지 않는다).
    if (existsSync(paths.journalFile)) {
        const lock = acquireRunWriterLock(paths);
        try {
            recoverPendingCommit(paths);
        }
        finally {
            releaseRunWriterLock(paths, lock);
        }
    }
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
