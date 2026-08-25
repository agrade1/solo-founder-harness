/**
 * **Tech Lead가 만드는 task DAG 문서와 그 fail-closed 검증**(V3 M9 T2 — 로드맵 §10 M9 절
 * "Tech Lead가 task DAG/ownership/API contract 생성").
 *
 * ## 왜 문서가 필요한가 (kernel이 이미 하는 것과 무엇이 다른가)
 *
 * kernel은 task를 **한 번에 하나씩** 만든다(`createRootTask` · `requestSpawn` — 둘 다 `addTask`
 * 하나를 지난다). 거기서 `dependsOn`은 **이미 존재하는 task**만 가리킬 수 있고(`unknown_dependency`),
 * 만들어진 뒤 간선을 바꾸는 API는 없다 — `orchestrationKernel.ts`에서 `dependsOn`에 쓰는 자리는
 * `addTask` 안의 지역 배열 하나뿐이다. 그래서 **kernel 경로에서는 순환이 애초에 표현되지 않는다.**
 *
 * 이것은 **코드 구조에서 나오는 논증이고 이 모듈의 테스트가 증명하는 성질이 아니다**(정직하게 구분
 * 한다). 여기서 순환 검사를 만드는 이유도 kernel이 못 잡아서가 아니라 아래 이유 때문이다.
 *
 * Tech Lead는 다르다: **여러 task를 한 문서로 한꺼번에** 선언하므로 그 안에서는 순환도, 아직
 * 존재하지 않는 task에 대한 의존도, 동시에 돌 두 task가 같은 파일을 소유하는 것도 **전부 표현
 * 가능하다**. 그래서 검증은 문서 단계에 있어야 한다 — 만들어진 뒤가 아니라.
 *
 * ## 닫힌 형태
 *
 * 승인 manifest·typed operation과 **같은 규율**이다: key 집합이 닫혀 있고, 모델이 명령·권한·경로
 * 형식을 문자열로 고를 자리가 없다. 여기서 선언되는 것은 **무엇을 누가 소유하고 무엇에 의존하며
 * 무엇을 주고받는가**, 그리고 **이미 승인된 operation 중 무엇을 지시에 실을 것인가**뿐이고,
 * 실행 권한은 여전히 승인 manifest가 정한다(이 문서는 권한을 만들지 않는다 — 그래서
 * `writableRoots`·`operationAuthority` 같은 필드가 **없다**).
 *
 * **V3 M11에서 `operations` 축이 생겼다**(대장 `B-38`). 그것도 권한이 아니다: **`authorityId` 참조
 * 목록**이며 경로·상한·명령을 표현할 타입이 없고, 물질화가 승인 manifest와 대조해 어긋나면 거부한다.
 * 이 축이 하는 일은 승인을 **좁혀 지시에 싣는 것**이지 넓히는 것이 아니다.
 *
 * ## 이 모듈이 하지 않는 것
 *
 * kernel을 부르지 않고 파일을 읽지 않으며 상태를 만들지 않는다. **순수 검증**이다. 문서를 실제
 * task로 물질화하는 것은 별도 단계이고 거기서도 권위는 kernel이다.
 */
import { LIMITS, OrchestrationError, assertSlug, assertText, normalizeAssignedOperations, normalizeOwnership, normalizeResourceClasses, normalizeWorkspacePath } from "./orchestrationTypes.js";
import { assertRegistryRoleId, pathWithin } from "./approvalManifest.js";
/** DAG 문서 1건이 담을 수 있는 최대 task 수 — kernel의 run당 task 상한과 같은 값을 쓴다. */
export const MAX_DAG_TASKS = LIMITS.maxTasksPerRun;
/** node 하나가 선언할 수 있는 산출/소비 항목 수. `maxArtifactRefs`와 같은 규모로 묶는다. */
export const MAX_DAG_CONTRACT_PATHS = LIMITS.maxArtifactRefs;
/** DAG node 1건의 **닫힌 key 집합**. 여기 없는 key는 문서에 담길 수 없다. */
export const DAG_NODE_KEYS = ["taskId", "roleId", "title", "scope", "ownership", "dependsOn", "provides", "consumes", "resourceClasses", "operations", "briefing"];
/** 문서 최상위의 **닫힌 key 집합**. */
export const DAG_DOCUMENT_KEYS = ["schemaVersion", "tasks"];
/** `DAG_NODE_KEYS` 중 부재가 허용되는 것(생략 = 빈 목록/빈 문자열). */
export const DAG_NODE_OPTIONAL_KEYS = ["provides", "consumes", "resourceClasses", "operations", "briefing"];
export const TASK_DAG_SCHEMA_VERSION = "1";
/**
 * **이 모듈이 고유하게 내는 안정 오류 코드**(닫힌 목록).
 *
 * 전부는 아니다 — 경로·slug·role·ownership 형식은 kernel과 **같은 검증 함수**를 재사용하므로 그쪽
 * 코드(`unknown_role` · `invalid_ownership` · `path_absolute` · `path_parent_segment` · `path_not_utf8`
 * · `invalid_slug` 등)가 그대로 올라온다. 같은 규칙을 두 곳에 두지 않는 대가이며, 그래서 호출자는
 * 이 목록만으로 catch를 좁히면 안 된다.
 */
export const TASK_DAG_CODES = [
    /** 문서 구조·key 집합·타입·상한 위반. */
    "invalid_dag_document",
    /** 같은 taskId가 두 번 나왔다. */
    "duplicate_task_id",
    /** 문서 안에 없는 task에 의존한다. */
    "unknown_dependency",
    /** 자기 자신에 의존한다. */
    "self_dependency",
    /** 같은 의존을 두 번 적었다. */
    "depends_on_duplicate",
    /** 의존 간선에 **순환**이 있다. */
    "dependency_cycle",
    /** **동시에 돌 수 있는** 두 task가 같은 경로를 소유한다(조용한 덮어쓰기 위험). */
    "ownership_conflict",
    /** `provides`가 자기 `ownership` 밖이다(만들 수 없는 것을 만들겠다고 선언했다). */
    "provides_not_owned",
    /** `consumes`를 만들어 주는 이행적 의존이 없다. */
    "consumes_unprovided",
];
function fail(code, what) {
    return new OrchestrationError(code, what);
}
function asObject(raw, what) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw fail("invalid_dag_document", `${what}는 객체여야 한다`);
    }
    return raw;
}
function closedKeys(o, allowed, optional, what) {
    for (const k of Object.keys(o)) {
        if (!allowed.includes(k))
            throw fail("invalid_dag_document", `${what}에 허용되지 않은 필드: ${k}`);
    }
    for (const k of allowed) {
        if (!optional.includes(k) && !(k in o))
            throw fail("invalid_dag_document", `${what}에 ${k}가 없다`);
    }
}
/** 정규화된 workspace-relative 경로 목록(중복·미정규화·범위 이탈 거부). */
function pathList(raw, what, max) {
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw))
        throw fail("invalid_dag_document", `${what}는 배열이어야 한다`);
    if (raw.length > max)
        throw fail("invalid_dag_document", `${what}는 ${max}개 이하여야 한다`);
    const out = [];
    for (const v of raw) {
        let p;
        try {
            p = normalizeWorkspacePath(v, `${what} 항목`);
        }
        catch {
            throw fail("invalid_dag_document", `${what} 항목이 정규화 가능한 workspace-relative 경로가 아니다`);
        }
        // 문서에는 **이미 정규화된 형태**만 담긴다(같은 경로의 두 표기가 계약에 남지 않는다).
        if (v !== p)
            throw fail("invalid_dag_document", `${what} 항목이 이미 정규화된 형태가 아니다`);
        if (out.includes(p))
            throw fail("invalid_dag_document", `${what} 항목 중복: ${p}`);
        out.push(p);
    }
    return [...out].sort();
}
function stringList(raw, what, max) {
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw))
        throw fail("invalid_dag_document", `${what}는 배열이어야 한다`);
    if (raw.length > max)
        throw fail("invalid_dag_document", `${what}는 ${max}개 이하여야 한다`);
    return raw.map((v) => assertSlug(v, `${what} 항목`));
}
/** 두 경로가 겹치는가 — 한쪽이 다른 쪽의 하위 경로면 겹친다(`pathWithin`이 동일 경로를 포함한다). */
function overlaps(a, b) {
    return pathWithin(a, b) || pathWithin(b, a);
}
/**
 * **Tech Lead의 DAG 문서 1건을 검증한다.** 통과하면 정규화된 문서를 돌려주고, 아니면 위 닫힌 코드로
 * 던진다. 부분 통과는 없다 — 하나라도 걸리면 그 문서로는 아무 task도 만들어지지 않는다.
 */
export function validateTaskDag(raw) {
    const doc = asObject(raw, "DAG 문서");
    closedKeys(doc, DAG_DOCUMENT_KEYS, [], "DAG 문서");
    if (doc.schemaVersion !== TASK_DAG_SCHEMA_VERSION) {
        throw fail("invalid_dag_document", `schemaVersion은 ${TASK_DAG_SCHEMA_VERSION}이어야 한다`);
    }
    if (!Array.isArray(doc.tasks))
        throw fail("invalid_dag_document", "tasks는 배열이어야 한다");
    if (doc.tasks.length === 0)
        throw fail("invalid_dag_document", "tasks가 비어 있다(빈 DAG는 계획이 아니다)");
    if (doc.tasks.length > MAX_DAG_TASKS)
        throw fail("invalid_dag_document", `tasks는 ${MAX_DAG_TASKS}개 이하여야 한다`);
    const nodes = [];
    const byId = new Map();
    for (const rawNode of doc.tasks) {
        const o = asObject(rawNode, "DAG node");
        closedKeys(o, DAG_NODE_KEYS, DAG_NODE_OPTIONAL_KEYS, "DAG node");
        const taskId = assertSlug(o.taskId, "DAG node.taskId");
        if (byId.has(taskId))
            throw fail("duplicate_task_id", `문서에 같은 taskId가 두 번 있다: ${taskId}`);
        // ownership은 kernel과 **같은 계약**(`normalizeOwnership`)을 쓰되, 문서에는 **이미 정규화된
        // 형태**만 담기게 한 번 더 좁힌다: `normalizeOwnership`은 `src/./a`를 조용히 `src/a`로 고치는데,
        // 같은 경로의 두 표기가 계약 문서에 남으면 소유권 충돌 판정이 표기에 따라 달라 보인다.
        if (Array.isArray(o.ownership)) {
            for (const v of o.ownership) {
                let n;
                try {
                    n = normalizeWorkspacePath(v, `DAG node(${taskId}).ownership 항목`);
                }
                catch {
                    continue; // 형식 오류는 아래 normalizeOwnership이 kernel과 같은 코드로 던진다.
                }
                if (v !== n)
                    throw fail("invalid_dag_document", `DAG node(${taskId}).ownership 항목이 이미 정규화된 형태가 아니다: ${String(v)}`);
            }
        }
        // 빈 ownership은 `normalizeOwnership`이 kernel과 같은 코드(`invalid_ownership`)로 거부한다 —
        // 여기서 따로 막지 않는다(같은 규칙을 두 곳에 두지 않는다).
        const ownership = normalizeOwnership(o.ownership, `DAG node(${taskId}).ownership`);
        const dependsOn = [];
        for (const d of stringList(o.dependsOn, `DAG node(${taskId}).dependsOn`, LIMITS.maxDependsOn)) {
            if (d === taskId)
                throw fail("self_dependency", `task가 자기 자신에 의존할 수 없다: ${taskId}`);
            if (dependsOn.includes(d))
                throw fail("depends_on_duplicate", `dependsOn 중복: ${taskId} → ${d}`);
            dependsOn.push(d);
        }
        const provides = pathList(o.provides, `DAG node(${taskId}).provides`, MAX_DAG_CONTRACT_PATHS);
        for (const p of provides) {
            // **만들 수 없는 것을 만들겠다고 선언할 수 없다.** 이 검사가 없으면 contract가 실행 권한과
            // 어긋난 채 통과하고, 하류 task는 영원히 오지 않을 입력을 기다린다.
            // `pathWithin`이 `child === root`를 이미 포함한다(approvalManifest.ts) — 등호 절을 따로 두지 않는다.
            if (!ownership.some((own) => pathWithin(p, own))) {
                throw fail("provides_not_owned", `${taskId}의 provides가 자기 ownership 밖이다: ${p}`);
            }
        }
        const node = {
            taskId,
            roleId: assertRegistryRoleId(o.roleId, `DAG node(${taskId}).roleId`),
            title: assertText(o.title, `DAG node(${taskId}).title`, LIMITS.maxTextLength),
            scope: assertText(o.scope, `DAG node(${taskId}).scope`, LIMITS.maxTextLength),
            ownership,
            dependsOn,
            provides,
            consumes: pathList(o.consumes, `DAG node(${taskId}).consumes`, MAX_DAG_CONTRACT_PATHS),
            // kernel과 **같은 함수**를 쓴다(중복 거부·사전순 고정). 이전 판은 자체 목록 검증이라 중복이
            // 문서 검증을 통과하고 물질화에서 늦게 터졌다(T2 적대적 리뷰 C-1 — fail-late).
            resourceClasses: normalizeResourceClasses(o.resourceClasses ?? [], `DAG node(${taskId}).resourceClasses`),
            // kernel·store와 **같은 정규화 함수**를 쓴다(slug·중복 거부·사전순). 문서가 `null`을 적어
            // bind를 벗어나는 통로는 없다: `?? []`가 부재를 빈 집합으로 굳히고, 명시 `null`은 그 함수가
            // `null`을 돌려주므로 아래에서 `?? []`가 다시 접는다 — DAG node는 언제나 배열이다.
            operations: normalizeAssignedOperations(o.operations ?? [], `DAG node(${taskId}).operations`) ?? [],
            // 상한은 **본문 바이트 상한**과 같은 값으로 잡는다: 이보다 긴 briefing은 어차피
            // `assignmentBodyFor`가 `maxBodyBytes`에서 거부하므로 두 번째 규칙을 만들지 않는다.
            // 명시적 `""`는 `assertText`가 `invalid_text`로 거부한다 — "빈 briefing"을 적는 방법은 **생략**뿐이다.
            briefing: o.briefing === undefined ? "" : assertText(o.briefing, `DAG node(${taskId}).briefing`, LIMITS.maxBodyBytes),
        };
        byId.set(taskId, node);
        nodes.push(node);
    }
    // 미상 의존은 **모든 node를 읽은 뒤에** 본다(문서는 순서가 없다 — 뒤에 선언된 task에 의존해도 된다).
    for (const n of nodes) {
        for (const d of n.dependsOn) {
            if (!byId.has(d))
                throw fail("unknown_dependency", `문서에 없는 task에 의존한다: ${n.taskId} → ${d}`);
        }
    }
    // **순환.** DFS 3색 — 재귀 대신 명시 스택이라 깊은 DAG에서도 스택을 태우지 않는다.
    const ancestors = reachability(nodes, byId); // taskId → 그 task가 (이행적으로) 의존하는 전부
    for (const n of nodes) {
        if (ancestors.get(n.taskId).has(n.taskId)) {
            throw fail("dependency_cycle", `의존 간선에 순환이 있다: ${n.taskId}`);
        }
    }
    // **소유권 충돌.** 순서가 강제되지 않는 두 task(= 어느 쪽도 상대의 이행적 의존이 아니다)는 동시에
    // 돌 수 있으므로 같은 경로를 소유하면 조용한 덮어쓰기가 난다(로드맵 M9 위험 1). 의존 사슬로 묶인
    // 두 task가 같은 파일을 소유하는 것은 **정상이다**(구현 → 수정이 같은 파일을 만진다).
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i];
            const b = nodes[j];
            if (ancestors.get(a.taskId).has(b.taskId) || ancestors.get(b.taskId).has(a.taskId))
                continue;
            // 배타 자원 class를 공유하면 kernel scheduler가 동시 실행을 막는다 — 그때는 충돌이 아니다.
            if (a.resourceClasses.some((r) => b.resourceClasses.includes(r)))
                continue;
            for (const pa of a.ownership) {
                for (const pb of b.ownership) {
                    if (overlaps(pa, pb)) {
                        throw fail("ownership_conflict", `순서가 강제되지 않는 두 task가 같은 경로를 소유한다: ${a.taskId}(${pa}) ↔ ${b.taskId}(${pb})`);
                    }
                }
            }
        }
    }
    // **API contract.** `consumes`는 이행적 의존 중 누군가가 `provides`한 것이어야 한다.
    for (const n of nodes) {
        const upstream = ancestors.get(n.taskId);
        for (const c of n.consumes) {
            const provided = [...upstream].some((up) => byId.get(up).provides.some((p) => pathWithin(c, p)));
            if (!provided) {
                throw fail("consumes_unprovided", `${n.taskId}의 consumes를 만들어 주는 이행적 의존이 없다: ${c}`);
            }
        }
    }
    // taskId 오름차순으로 굳힌다(같은 문서면 같은 결과 — kernel state 불변식과 같은 규율).
    nodes.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    return { schemaVersion: TASK_DAG_SCHEMA_VERSION, tasks: nodes };
}
/**
 * 각 task의 **이행적 의존 집합**. 순환이 있으면 그 사슬의 모든 node가 자기 자신을 포함하게 되므로
 * 이 한 번의 계산이 순환 검출과 조상 조회 **둘 다**에 쓰인다(두 번 순회하지 않는다).
 */
function reachability(nodes, byId) {
    const out = new Map();
    for (const n of nodes) {
        const seen = new Set();
        const stack = [...n.dependsOn];
        while (stack.length > 0) {
            const cur = stack.pop();
            if (seen.has(cur))
                continue;
            seen.add(cur);
            // 순환이 있으면 `cur`이 `n.taskId`가 되어 돌아온다 — `seen`이 그것을 기록하고 루프는 끝난다.
            const node = byId.get(cur);
            if (node !== undefined)
                stack.push(...node.dependsOn);
        }
        out.set(n.taskId, seen);
    }
    return out;
}
