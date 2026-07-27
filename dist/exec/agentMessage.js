/**
 * V3 M4a/M4c — agent message 계약의 runtime validator (로드맵 §5.1/§5.2).
 * M4c에서 타입 union이 4종 → **10종 전부**로 닫혔다. envelope 필드 집합은 **무변경**이다:
 * route·권한을 envelope에 밀어 넣지 않고 중앙 state(message index)가 들고 간다.
 *
 * `schemas/agent_message.schema.json`은 **계약 문서**이고 실제 보안 경계는 이 파일이다
 * (신규 Ajv 등 검증 의존성 0 — 기존 liveEvidence.ts와 같은 수동 closed validator 방식).
 * 두 정의의 핵심 동치(enum · required · bounds)는 orchestrationKernel.test.ts가 강제한다.
 *
 * 여기서는 **메시지 자체의 형태**만 본다. state와의 대조(taskId 존재, 상태 전이 가능 여부,
 * artifact 등록 여부)는 kernel이 한다 — validator는 순수 함수이고 파일을 만들지 않는다.
 */
import { AGENT_MESSAGE_TYPES, ARTIFACT_ROLES, LIMITS, ORCHESTRATION_SCHEMA_VERSION, OrchestrationError, REQUIRED_BODY_HEADINGS, assertSha256, assertSlug, assertTimestamp, normalizeWorkspacePath, } from "./orchestrationTypes.js";
/** envelope의 top-level 허용 key — 이 집합 밖은 전부 거부(closed). */
export const ENVELOPE_KEYS = [
    "schemaVersion",
    "messageId",
    "runId",
    "milestoneId",
    "taskId",
    "parentTaskId",
    "sender",
    "recipient",
    "type",
    "createdAt",
    "dependsOn",
    "artifactRefs",
    "supersedes",
];
/** artifactRefs 항목의 허용 key. */
export const ARTIFACT_POINTER_KEYS = ["path", "sha256", "revision", "producerTaskId", "role"];
function asObject(v, code, what) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new OrchestrationError(code, `${what}는 객체여야 한다`);
    }
    return v;
}
function assertClosedKeys(o, allowed, code, what) {
    for (const k of Object.keys(o)) {
        if (!allowed.includes(k)) {
            throw new OrchestrationError(code, `${what}에 허용되지 않은 필드가 있다: ${k}`);
        }
    }
    for (const k of allowed) {
        if (!(k in o)) {
            throw new OrchestrationError(code, `${what}에 필수 필드가 없다: ${k}`);
        }
    }
}
/** artifact 포인터 1건 검증 — path는 workspace-relative로 정규화된 값으로 돌려준다. */
export function validateArtifactPointer(raw) {
    const o = asObject(raw, "invalid_artifact_ref", "artifactRefs 항목");
    assertClosedKeys(o, ARTIFACT_POINTER_KEYS, "invalid_artifact_ref", "artifactRefs 항목");
    const revision = o.revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || revision > 1_000_000) {
        throw new OrchestrationError("invalid_artifact_ref", "artifactRefs[].revision은 1..1000000 정수여야 한다");
    }
    if (typeof o.role !== "string" || !ARTIFACT_ROLES.includes(o.role)) {
        throw new OrchestrationError("invalid_artifact_ref", `artifactRefs[].role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
    }
    return {
        path: normalizeWorkspacePath(o.path, "artifactRefs[].path"),
        sha256: assertSha256(o.sha256, "artifactRefs[].sha256"),
        revision,
        producerTaskId: assertSlug(o.producerTaskId, "artifactRefs[].producerTaskId"),
        role: o.role,
    };
}
/**
 * envelope 검증. 통과하면 정규화된 사본을 돌려준다(입력 객체는 건드리지 않는다).
 * state와의 대조는 하지 않는다 — kernel의 책임.
 */
export function validateEnvelope(raw) {
    const o = asObject(raw, "invalid_envelope", "envelope");
    assertClosedKeys(o, ENVELOPE_KEYS, "invalid_envelope", "envelope");
    if (o.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
        throw new OrchestrationError("invalid_envelope", `envelope.schemaVersion은 "${ORCHESTRATION_SCHEMA_VERSION}"이어야 한다`);
    }
    if (typeof o.type !== "string" || !AGENT_MESSAGE_TYPES.includes(o.type)) {
        throw new OrchestrationError("unsupported_message_type", `메시지 타입은 §5.1의 ${AGENT_MESSAGE_TYPES.join("|")} 중 하나여야 한다`);
    }
    const parentTaskId = o.parentTaskId === null ? null : assertSlug(o.parentTaskId, "envelope.parentTaskId");
    const supersedes = o.supersedes === null ? null : assertSlug(o.supersedes, "envelope.supersedes");
    if (!Array.isArray(o.dependsOn)) {
        throw new OrchestrationError("invalid_envelope", "envelope.dependsOn은 배열이어야 한다");
    }
    if (o.dependsOn.length > LIMITS.maxDependsOn) {
        throw new OrchestrationError("depends_on_too_many", `envelope.dependsOn은 ${LIMITS.maxDependsOn}개 이하여야 한다`);
    }
    const dependsOn = [];
    for (const d of o.dependsOn) {
        const id = assertSlug(d, "envelope.dependsOn 항목");
        if (dependsOn.includes(id)) {
            throw new OrchestrationError("depends_on_duplicate", `envelope.dependsOn에 중복이 있다: ${id}`);
        }
        dependsOn.push(id);
    }
    if (!Array.isArray(o.artifactRefs)) {
        throw new OrchestrationError("invalid_envelope", "envelope.artifactRefs는 배열이어야 한다");
    }
    if (o.artifactRefs.length > LIMITS.maxArtifactRefs) {
        throw new OrchestrationError("artifact_refs_too_many", `envelope.artifactRefs는 ${LIMITS.maxArtifactRefs}개 이하여야 한다`);
    }
    const artifactRefs = [];
    for (const a of o.artifactRefs) {
        const p = validateArtifactPointer(a);
        if (artifactRefs.some((x) => x.path === p.path)) {
            throw new OrchestrationError("artifact_ref_duplicate", `envelope.artifactRefs에 중복 path가 있다: ${p.path}`);
        }
        artifactRefs.push(p);
    }
    return {
        schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
        messageId: assertSlug(o.messageId, "envelope.messageId"),
        runId: assertSlug(o.runId, "envelope.runId"),
        milestoneId: assertSlug(o.milestoneId, "envelope.milestoneId"),
        taskId: assertSlug(o.taskId, "envelope.taskId"),
        parentTaskId,
        sender: assertSlug(o.sender, "envelope.sender"),
        recipient: assertSlug(o.recipient, "envelope.recipient"),
        type: o.type,
        createdAt: assertTimestamp(o.createdAt, "envelope.createdAt"),
        dependsOn,
        artifactRefs,
        supersedes,
    };
}
/** body에서 `## ` h2 heading만 순서대로 뽑는다(코드펜스 안은 heading으로 보지 않는다). */
function collectHeadings(body) {
    const headings = [];
    let inFence = false;
    for (const line of body.split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
        if (m)
            headings.push(m[1]);
    }
    return headings;
}
/**
 * 타입별 Markdown body 검증: 크기 상한 + 필수 heading 전부 존재 + 목록 밖 h2 없음 + 중복 없음.
 * heading 순서는 강제하지 않는다(계약은 "필수 section 존재"이며 순서 강제는 보안 가치가 없다).
 */
export function validateMessageBody(type, body) {
    if (typeof body !== "string" || body.trim().length === 0) {
        throw new OrchestrationError("invalid_body", "Markdown body는 비어 있지 않은 문자열이어야 한다");
    }
    if (body.includes("\0")) {
        throw new OrchestrationError("invalid_body", "Markdown body에 NUL 바이트가 있다");
    }
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > LIMITS.maxBodyBytes) {
        throw new OrchestrationError("body_too_large", `Markdown body는 ${LIMITS.maxBodyBytes} 바이트 이하여야 한다 (현재 ${bytes})`);
    }
    const required = REQUIRED_BODY_HEADINGS[type];
    const found = collectHeadings(body);
    const seen = new Set();
    for (const h of found) {
        if (!required.includes(h)) {
            throw new OrchestrationError("body_unknown_heading", `${type} body에 계약 밖 heading이 있다: ## ${h}`);
        }
        if (seen.has(h)) {
            throw new OrchestrationError("body_duplicate_heading", `${type} body에 heading 중복이 있다: ## ${h}`);
        }
        seen.add(h);
    }
    for (const h of required) {
        if (!seen.has(h)) {
            throw new OrchestrationError("body_missing_heading", `${type} body에 필수 heading이 없다: ## ${h}`);
        }
    }
    return body;
}
