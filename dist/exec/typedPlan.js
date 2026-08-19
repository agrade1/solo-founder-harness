/**
 * V3 M5c — **typed 실행 계획의 닫힌 validator와 계약 상수**(순수 — 부수 효과 0).
 *
 * 이 모듈은 `typedExecution.ts`에서 **의도적으로 갈라져 나왔다**(3A 리비전 C 항목: worker의 least-authority
 * import 그래프). offline plan worker는 계획을 검증만 하면 되므로 파일 시스템 권위를 가진 모듈을
 * transitive하게 끌어올 이유가 없다. 지금 worker의 import 그래프는
 * `orchestrationTypes`(순수) · `autopilotTypes`(순수) · 이 파일 · `node:util/types`(introspection)뿐이다.
 *
 * 여기 있는 것:
 * - 계약 상수(닫힌 key 집합 · 경로/드라이브/고립 surrogate pattern) — JSON Schema와 공유하는 정본.
 * - `readOwnData`/`readOwnArray` — **호출자 코드를 실행하지 않는** 닫힌 데이터 읽기.
 * - `validateTypedExecutionPlan` — 계획 1건의 검증·입양·깊은 동결.
 *
 * **여기 없는 것**: 파일 시스템 · 프로세스 · git · 네트워크 · provider · 승인 조회. 표현할 타입도 없다.
 * 오류에는 **필드 이름과 규칙만** 담는다 — 계획 본문 · 파일 내용 · 경로 값은 담지 않는다.
 */
import { isProxy } from "node:util/types";
import { ARTIFACT_ROLES, LIMITS, OrchestrationError, SHA256_PATTERN, SLUG_PATTERN, TYPED_EXECUTION_PLAN_SCHEMA_VERSION, assertText, isSlug, normalizeWorkspacePath, } from "./orchestrationTypes.js";
import { MAX_PLAN_OPERATIONS, MAX_PLAN_REQUESTS, } from "./autopilotTypes.js";
// ── 계획 계약(닫힌 key 집합 — JSON Schema와 동치) ─────────────────────────────
export const TYPED_PLAN_KEYS = ["schemaVersion", "runId", "taskId", "attemptId", "turnId", "operations", "result"];
/**
 * `requests`가 실린 계획의 닫힌 key 집합(V3 M6 T2). **두 집합 모두 유효하다** — 요청이 없는 계획은
 * `requests` key 자체를 적지 않아도 되고 그때는 빈 배열로 입양된다. 집합을 하나로 합쳐 필수로 만들면
 * 기존에 승인된 모든 계획 문서가 한꺼번에 `plan_invalid`가 되므로 그렇게 하지 않는다.
 */
export const TYPED_PLAN_KEYS_WITH_REQUESTS = [...TYPED_PLAN_KEYS, "requests"];
export const SPAWN_CHILD_REQUEST_KEYS = ["kind", "childTaskId", "roleId", "title", "scope", "dependsOn", "reason"];
export const DELIVER_STATUS_REQUEST_KEYS = ["kind", "deliverTo", "note"];
/** [M7 T6] 사람 결정 **요청**의 닫힌 key 집합. 답(`decision`)을 만드는 요청 갈래는 없다. */
export const REQUEST_DECISION_REQUEST_KEYS = ["kind", "question", "safeDefault"];
export const TYPED_PLAN_RESULT_KEYS = ["summary", "outputs"];
export const TYPED_PLAN_OUTPUT_KEYS = ["path", "role"];
export const TYPED_PLAN_BINDING_KEYS = ["runId", "taskId", "attemptId", "turnId"];
export const WRITE_FILE_OPERATION_KEYS = [
    "operationId",
    "kind",
    "authorityId",
    "path",
    "content",
    "expectedBeforeSha256",
];
export const RUN_PROCESS_OPERATION_KEYS = ["operationId", "kind", "authorityId"];
/**
 * **이미 정규화된** workspace-relative 경로의 정규형(JSON Schema와 공유하는 정본).
 * segment는 비어 있지 않고 `.`/`..`가 아니며 `\`·NUL을 포함하지 않는다. 선행·후행·중복 `/`도 없다.
 * 런타임 판정은 `normalizeWorkspacePath(v) === v`이며 두 판정의 동치는 focused 테스트가 표로 강제한다.
 * (드라이브 접두사 `C:`와 고립 surrogate는 이 regex로 표현되지 않으므로 schema는 `not`으로, 런타임은
 * `normalizeWorkspacePath`가 따로 거부한다.)
 */
export const NORMALIZED_WORKSPACE_PATH_PATTERN = "^(?!\\.\\.?(?:/|$))[^/\\\\\\u0000]+(?:/(?!\\.\\.?(?:/|$))[^/\\\\\\u0000]+)*$";
/** 드라이브 접두사 거부(schema `not` 절과 같은 정본). */
export const WINDOWS_DRIVE_PATTERN = "^[A-Za-z]:";
/**
 * **고립 UTF-16 surrogate 거부**(V3 M5c 3A 리비전 A4) — schema `not` 절과 공유하는 정본.
 *
 * JSON Schema의 regex는 ECMA-262지만 `u` flag를 쓸 수 없으므로 **code unit** 표현으로 적는다:
 * ⓐ 뒤에 low surrogate가 오지 않는 high surrogate ⓑ 앞에 high surrogate가 없는 low surrogate.
 * 런타임 정본은 `orchestrationTypes.hasLoneSurrogate`(`\p{Surrogate}` + `u`)이며 두 판정의 동치는
 * focused 테스트가 양/음성 표로 강제한다(유효 astral과 리터럴 U+FFFD는 양쪽에서 통과한다).
 */
export const LONE_SURROGATE_PATTERN = "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(^|[^\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";
function planInvalid(what) {
    return new OrchestrationError("plan_invalid", `계획이 계약 밖이다: ${what}`);
}
/**
 * **own string data property를 전부 읽어 새 map으로 옮긴다.** 계약 밖이면 `null`이다(던지지 않는다 —
 * 거부 taxonomy를 호출자가 고르는 통로를 남기지 않는다. 대장 `C-38`).
 *
 * 거부하는 것: 객체가 아닌 값 · `null` · 배열 · **`Proxy`** · 계약 밖 prototype · symbol key ·
 * **accessor property**. accessor는 값이 아니라 **코드**이므로 성공하든 던지든 데이터 입력이 아니다 →
 * descriptor의 `value`만 읽으므로 getter/trap이 **애초에 실행되지 않는다**.
 *
 * `Proxy`를 명시적으로 거부하는 이유: trap이 깔끔한 데이터를 돌려주면 "성공한 호출자 코드"가 되고,
 * 그건 "데이터 전용" 계약의 위반이다(리비전 A1).
 */
export function readOwnData(raw) {
    try {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw) || isProxy(raw))
            return null;
        const proto = Reflect.getPrototypeOf(raw);
        if (proto !== Object.prototype && proto !== null)
            return null;
        const read = Object.create(null);
        for (const k of Reflect.ownKeys(raw)) {
            if (typeof k !== "string")
                return null;
            const d = Object.getOwnPropertyDescriptor(raw, k);
            if (d === undefined || !("value" in d))
                return null;
            read[k] = d.value;
        }
        return read;
    }
    catch {
        return null;
    }
}
/**
 * 배열 항목을 **정확히 한 번씩** 새 배열로 옮긴다. 계약 밖이면 `null`이다.
 * 여분 property·symbol·accessor 인덱스·`Proxy`·계약 밖 prototype은 전부 거부한다.
 */
export function readOwnArray(raw) {
    try {
        if (!Array.isArray(raw) || isProxy(raw))
            return null;
        if (Reflect.getPrototypeOf(raw) !== Array.prototype)
            return null;
        const n = raw.length;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
            return null;
        if (Reflect.ownKeys(raw).length !== n + 1)
            return null; // 인덱스 n개 + "length"
        const out = [];
        for (let i = 0; i < n; i++) {
            const d = Object.getOwnPropertyDescriptor(raw, i);
            if (d === undefined || !("value" in d))
                return null;
            out.push(d.value);
        }
        return out;
    }
    catch {
        return null;
    }
}
function isSameKeySet(keys, allowed) {
    return keys.length === allowed.length && keys.every((k) => allowed.includes(k));
}
/** 닫힌 key 집합의 순수 데이터 객체를 읽는다. 어긋나면 `plan_invalid`다. */
function closedRead(raw, allowed, what) {
    const read = readOwnData(raw);
    if (read === null || !isSameKeySet(Object.keys(read), allowed)) {
        throw planInvalid(`${what}는 닫힌 key 집합의 순수 데이터 객체여야 한다`);
    }
    return read;
}
/** 닫힌 배열을 읽는다. 어긋나면 `plan_invalid`다. */
function closedArray(raw, what) {
    const items = readOwnArray(raw);
    if (items === null)
        throw planInvalid(`${what}는 여분 property 없는 순수 데이터 배열이어야 한다`);
    return items;
}
function planSlug(v, what) {
    if (!isSlug(v))
        throw planInvalid(`${what}는 slug(${SLUG_PATTERN})여야 한다`);
    return v;
}
const SHA256_RE = new RegExp(SHA256_PATTERN);
function planSha256OrNull(v, what) {
    if (v === null)
        return null;
    if (typeof v !== "string" || !SHA256_RE.test(v))
        throw planInvalid(`${what}는 소문자 hex SHA-256 또는 null이어야 한다`);
    return v;
}
/**
 * **이미 정규화된** workspace 경로만 받는다. 정규화가 값을 바꾸면 거부다 — 같은 파일을 가리키는 두 표기가
 * 계획에 남으면 "승인된 경로와 정확히 같은가"를 문자열 동치로 판정할 수 없기 때문이다.
 * 고립 surrogate 거부도 같은 이유로 `normalizeWorkspacePath` 안에 있다(리비전 A4).
 */
function planPath(v, what) {
    let normalized;
    try {
        normalized = normalizeWorkspacePath(v, what);
    }
    catch {
        throw planInvalid(`${what}는 정규화된 workspace-relative 경로여야 한다`);
    }
    if (normalized !== v)
        throw planInvalid(`${what}는 이미 정규화된 형태여야 한다`);
    return normalized;
}
/**
 * 파일 본문. **바이트**로 상한을 본다(`Buffer.byteLength`) — schema `maxLength`는 코드 포인트라
 * 상한 값은 같아도 의미가 다르며, 이 방향(런타임이 더 엄격)이 fail closed다.
 * 왕복이 깨지는 문자열(고립 surrogate)은 쓰기 바이트가 의도와 조용히 달라지므로 거부한다.
 */
function planContent(v, what) {
    if (typeof v !== "string")
        throw planInvalid(`${what}는 문자열이어야 한다`);
    const bytes = Buffer.byteLength(v, "utf8");
    if (bytes > LIMITS.maxWriteBytes)
        throw planInvalid(`${what}가 ${LIMITS.maxWriteBytes} 바이트 상한을 넘는다`);
    if (Buffer.from(v, "utf8").toString("utf8") !== v)
        throw planInvalid(`${what}는 UTF-8 왕복이 보존되는 문자열이어야 한다`);
    return v;
}
/**
 * operation 1건. **kind는 key 집합이 정한다** — key 집합을 먼저 보고 그것에 맞는 닫힌 읽기를 한 번 하며,
 * 읽은 `kind` 값이 그 집합과 다르면 거부한다(교대 getter가 kind를 바꿔 다른 갈래로 새는 통로가 없다 —
 * 애초에 accessor 자체가 거부되므로 통로가 하나 더 줄었다).
 */
function planOperation(raw, index) {
    const what = `operations[${index}]`;
    const read = readOwnData(raw);
    if (read === null)
        throw planInvalid(`${what}는 닫힌 key 집합의 순수 데이터 객체여야 한다`);
    const keys = Object.keys(read);
    if (isSameKeySet(keys, WRITE_FILE_OPERATION_KEYS)) {
        if (read.kind !== "write_file")
            throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
        return Object.freeze({
            operationId: planSlug(read.operationId, `${what}.operationId`),
            kind: "write_file",
            authorityId: planSlug(read.authorityId, `${what}.authorityId`),
            path: planPath(read.path, `${what}.path`),
            content: planContent(read.content, `${what}.content`),
            expectedBeforeSha256: planSha256OrNull(read.expectedBeforeSha256, `${what}.expectedBeforeSha256`),
        });
    }
    if (isSameKeySet(keys, RUN_PROCESS_OPERATION_KEYS)) {
        // **V3 M9 T3③에서 규칙을 정확히 다시 적는다**: `run_process`와 `git_worktree`는 key 집합이
        // `{operationId, kind, authorityId}`로 **같다**. 그래서 "kind는 key 집합이 정한다"는 문장은
        // 이제 "**key 집합이 모양을 정하고, 같은 모양 안에서는 kind가 갈래를 정한다**"이다.
        //
        // 원래 규칙의 목적(교대 getter가 갈래를 바꾸는 통로 차단)은 그대로 지켜진다: `readOwnData`가
        // accessor·proxy를 이미 거부하고 순수 데이터만 남기므로, 여기서 읽는 `read.kind`는 **한 번 굳은
        // 값**이고 두 번 읽어도 달라지지 않는다. 아래 `enumOf` 대신 명시 비교를 쓰는 이유도 같다 —
        // 닫힌 두 값 밖은 전부 거부다.
        if (read.kind === "run_process") {
            return Object.freeze({
                operationId: planSlug(read.operationId, `${what}.operationId`),
                kind: "run_process",
                authorityId: planSlug(read.authorityId, `${what}.authorityId`),
            });
        }
        if (read.kind === "git_worktree") {
            return Object.freeze({
                operationId: planSlug(read.operationId, `${what}.operationId`),
                kind: "git_worktree",
                authorityId: planSlug(read.authorityId, `${what}.authorityId`),
            });
        }
        throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
    }
    throw planInvalid(`${what}는 write_file|run_process|git_worktree의 닫힌 key 집합이어야 한다`);
}
/** bounded 짧은 텍스트(title/scope/reason/note) — 상한은 durable state가 받는 것과 같다. */
function planText(v, what, max) {
    try {
        return assertText(v, what, max);
    }
    catch {
        throw planInvalid(`${what}는 1..${max}자 문자열이어야 한다`);
    }
}
/**
 * 오케스트레이션 요청 1건. **kind는 key 집합이 정한다**(operation과 같은 규칙 — 교대 getter가 갈래를
 * 바꾸는 통로가 없다). 여기서 통과하는 것은 **요청의 모양**뿐이고, 실제 승인은 kernel이 한다:
 * registry role · depth/개수 상한 · 미상 dependsOn · 전달 관계는 전부 kernel 게이트가 다시 본다.
 */
function planRequest(raw, index) {
    const what = `requests[${index}]`;
    const read = readOwnData(raw);
    if (read === null)
        throw planInvalid(`${what}는 닫힌 key 집합의 순수 데이터 객체여야 한다`);
    const keys = Object.keys(read);
    if (isSameKeySet(keys, SPAWN_CHILD_REQUEST_KEYS)) {
        if (read.kind !== "spawn_child")
            throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
        const rawDeps = closedArray(read.dependsOn, `${what}.dependsOn`);
        if (rawDeps.length > LIMITS.maxDependsOn)
            throw planInvalid(`${what}.dependsOn은 ${LIMITS.maxDependsOn}개 이하여야 한다`);
        return Object.freeze({
            kind: "spawn_child",
            childTaskId: planSlug(read.childTaskId, `${what}.childTaskId`),
            roleId: planSlug(read.roleId, `${what}.roleId`),
            title: planText(read.title, `${what}.title`, LIMITS.maxTextLength),
            scope: planText(read.scope, `${what}.scope`, LIMITS.maxTextLength),
            dependsOn: Object.freeze(rawDeps.map((d, i) => planSlug(d, `${what}.dependsOn[${i}]`))),
            reason: planText(read.reason, `${what}.reason`, LIMITS.maxTextLength),
        });
    }
    if (isSameKeySet(keys, DELIVER_STATUS_REQUEST_KEYS)) {
        if (read.kind !== "deliver_status")
            throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
        return Object.freeze({
            kind: "deliver_status",
            deliverTo: planSlug(read.deliverTo, `${what}.deliverTo`),
            note: planText(read.note, `${what}.note`, LIMITS.maxTextLength),
        });
    }
    if (isSameKeySet(keys, REQUEST_DECISION_REQUEST_KEYS)) {
        if (read.kind !== "request_decision")
            throw planInvalid(`${what}.kind가 key 집합과 맞지 않는다`);
        return Object.freeze({
            kind: "request_decision",
            question: planText(read.question, `${what}.question`, LIMITS.maxTextLength),
            safeDefault: planText(read.safeDefault, `${what}.safeDefault`, LIMITS.maxTextLength),
        });
    }
    throw planInvalid(`${what}는 spawn_child|deliver_status|request_decision의 닫힌 key 집합이어야 한다`);
}
function planOutput(raw, index) {
    const what = `result.outputs[${index}]`;
    const read = closedRead(raw, TYPED_PLAN_OUTPUT_KEYS, what);
    if (!ARTIFACT_ROLES.includes(read.role)) {
        throw planInvalid(`${what}.role은 ${ARTIFACT_ROLES.join("|")} 중 하나여야 한다`);
    }
    return Object.freeze({ path: planPath(read.path, `${what}.path`), role: read.role });
}
/**
 * **계획 1건을 입양한다.** 통과하면 깊이 동결된 새 객체이고, 원본을 이후에 바꿔도 이 값은 바뀌지 않는다.
 *
 * `binding`은 **kernel이 소유한** 실행 신원이다(durable state에서 나온다): 계획이 다른
 * run/task/attempt/turn을 자칭하면 거부한다. binding 자체도 **같은 닫힌 읽기**를 지나므로 hostile
 * accessor/proxy가 거부 taxonomy를 고를 수 없다(대장 `C-38`을 이 직접 진입점에서도 닫는다).
 */
export function validateTypedExecutionPlan(raw, binding) {
    const b = closedRead(binding, TYPED_PLAN_BINDING_KEYS, "binding");
    const bound = {
        runId: planSlug(b.runId, "binding.runId"),
        taskId: planSlug(b.taskId, "binding.taskId"),
        attemptId: planSlug(b.attemptId, "binding.attemptId"),
        turnId: planSlug(b.turnId, "binding.turnId"),
    };
    // 요청이 실린 계획과 실리지 않은 계획 **둘 다** 닫힌 집합이다(어느 쪽도 여분 key를 허용하지 않는다).
    const readAny = readOwnData(raw);
    const hasRequests = readAny !== null && isSameKeySet(Object.keys(readAny), TYPED_PLAN_KEYS_WITH_REQUESTS);
    const read = closedRead(raw, hasRequests ? TYPED_PLAN_KEYS_WITH_REQUESTS : TYPED_PLAN_KEYS, "plan");
    if (read.schemaVersion !== TYPED_EXECUTION_PLAN_SCHEMA_VERSION) {
        throw planInvalid(`plan.schemaVersion은 "${TYPED_EXECUTION_PLAN_SCHEMA_VERSION}"이어야 한다`);
    }
    for (const key of TYPED_PLAN_BINDING_KEYS) {
        if (planSlug(read[key], `plan.${key}`) !== bound[key]) {
            throw planInvalid(`plan.${key}가 kernel이 준 실행 신원과 다르다`);
        }
    }
    const rawOps = closedArray(read.operations, "plan.operations");
    if (rawOps.length > MAX_PLAN_OPERATIONS)
        throw planInvalid(`plan.operations는 ${MAX_PLAN_OPERATIONS}건 이하여야 한다`);
    const operations = [];
    const seen = new Set();
    for (let i = 0; i < rawOps.length; i++) {
        const op = planOperation(rawOps[i], i);
        // JSON Schema draft-07은 배열 항목 사이의 유일성을 표현할 수 없다 — 이 불변식은 **런타임 전용**이다.
        if (seen.has(op.operationId))
            throw planInvalid("plan.operations에 중복 operationId가 있다");
        seen.add(op.operationId);
        operations.push(op);
    }
    const requests = [];
    if (hasRequests) {
        const rawRequests = closedArray(read.requests, "plan.requests");
        if (rawRequests.length > MAX_PLAN_REQUESTS)
            throw planInvalid(`plan.requests는 ${MAX_PLAN_REQUESTS}건 이하여야 한다`);
        const seenChild = new Set();
        for (let i = 0; i < rawRequests.length; i++) {
            const req = planRequest(rawRequests[i], i);
            // 같은 계획이 같은 child를 두 번 요청하면 두 번째는 kernel에서 `duplicate_task_id`로 죽는다 —
            // 그러면 첫 요청만 durable하게 남고 turn은 실패한다. 그 갈림을 만들지 않고 계획 단계에서 닫는다.
            if (req.kind === "spawn_child") {
                if (seenChild.has(req.childTaskId))
                    throw planInvalid("plan.requests에 중복 childTaskId가 있다");
                seenChild.add(req.childTaskId);
            }
            requests.push(req);
        }
    }
    const resultRead = closedRead(read.result, TYPED_PLAN_RESULT_KEYS, "plan.result");
    let summary;
    try {
        summary = assertText(resultRead.summary, "plan.result.summary", LIMITS.maxSummaryLength);
    }
    catch {
        throw planInvalid(`plan.result.summary는 1..${LIMITS.maxSummaryLength}자 문자열이어야 한다`);
    }
    const rawOutputs = closedArray(resultRead.outputs, "plan.result.outputs");
    if (rawOutputs.length > LIMITS.maxArtifactRefs) {
        throw planInvalid(`plan.result.outputs는 ${LIMITS.maxArtifactRefs}건 이하여야 한다`);
    }
    const outputs = rawOutputs.map((o, i) => planOutput(o, i));
    return Object.freeze({
        schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
        runId: bound.runId,
        taskId: bound.taskId,
        attemptId: bound.attemptId,
        turnId: bound.turnId,
        operations: Object.freeze(operations),
        requests: Object.freeze(requests),
        result: Object.freeze({ summary, outputs: Object.freeze(outputs) }),
    });
}
