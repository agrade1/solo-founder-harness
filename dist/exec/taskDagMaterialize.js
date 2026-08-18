import { LIMITS, OrchestrationError, REQUIRED_BODY_HEADINGS } from "./orchestrationTypes.js";
import { validateTaskDag } from "./taskDag.js";
/** 이 모듈이 고유하게 내는 안정 오류 코드(닫힌 목록 — kernel 코드는 그대로 올라온다). */
export const TASK_DAG_MATERIALIZE_CODES = [
    /** 만든 task가 문서와 어긋난다(`B-30` 집행 — 매핑이 필드를 잃거나 바꿨다). */
    "dag_materialize_drift",
    /** 이미 task가 있는 run에 물질화하려 했다(부분 물질화·중복 방지). */
    "dag_materialize_run_not_empty",
];
/**
 * `task_assignment` 본문. **필수 헤딩 전부**를 계약 순서대로 채운다(`REQUIRED_BODY_HEADINGS`가 정본).
 * 내용은 문서에서만 나오고 시각·예산 실측값을 담지 않는다 → 같은 문서면 같은 바이트다.
 */
export function assignmentBodyFor(node) {
    const list = (items, empty) => items.length === 0 ? empty : items.map((i) => `- \`${i}\``).join("\n");
    const sections = {
        Objective: node.title,
        "Scope / Ownership": `${node.scope}\n\n소유(쓰기 허용) 경로:\n${list(node.ownership, "- (없음)")}`,
        // **금지 목록을 문서가 만들지 않는다**: 권한 정본은 승인 manifest이고 이 절은 그 사실을 가리킨다.
        "Out of Scope / Forbidden": "위 소유 경로 밖 쓰기는 kernel이 거부한다(`operation_not_owned`).\n" +
            "동시에 자원을 점유 중인 다른 task가 그 경로를 소유하면 역시 거부다(`operation_ownership_contended`).\n" +
            "실행 권한·명령·예산의 정본은 **승인 manifest**이며 이 문서가 만들지 않는다.",
        "Inputs and Contracts": `이 task가 만들기로 한 것(provides):\n${list(node.provides, "- (없음)")}\n\n읽기로 한 것(consumes):\n${list(node.consumes, "- (없음)")}`,
        Dependencies: list(node.dependsOn, "- (없음 — 즉시 시작 가능)"),
        "Definition of Done": "provides로 선언한 산출물이 전부 발행되고 결과 요약이 수락된다.",
        "Budget and Permission Envelope": "승인 manifest의 `autopilotPolicy`·`operationAuthorityByTask`가 정본이다.",
        "Expected Deliverables": list(node.provides, "- (없음)"),
    };
    const body = REQUIRED_BODY_HEADINGS.task_assignment.map((h) => `## ${h}\n\n${sections[h]}\n`).join("\n");
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > LIMITS.maxBodyBytes) {
        // 문서 상한(`MAX_DAG_CONTRACT_PATHS`·`maxPathLength`·`maxTextLength`)이 이 한도 안에 들어가지만,
        // 상한이 나중에 느슨해지면 조용히 잘리는 대신 여기서 멈춘다.
        throw new OrchestrationError("dag_materialize_drift", `task_assignment 본문이 상한을 넘는다: ${node.taskId}`);
    }
    return body;
}
/**
 * 의존 먼저 오는 순서. kernel이 `unknown_dependency`로 거부하므로 **순서가 곧 계약**이다.
 * 문서가 이미 비순환임을 검증받았으므로 이 정렬은 항상 끝난다(그 사실에 기대는 것을 명시한다).
 * 같은 문서면 같은 순서다: 후보를 taskId 오름차순으로만 고른다.
 */
function dependencyOrder(nodes) {
    const remaining = [...nodes].sort((a, b) => (a.taskId < b.taskId ? -1 : 1));
    const done = new Set();
    const out = [];
    while (remaining.length > 0) {
        const i = remaining.findIndex((n) => n.dependsOn.every((d) => done.has(d)));
        if (i === -1) {
            // 도달 불가: `validateTaskDag`가 순환과 미상 의존을 이미 거부했다. 조용히 부분 물질화하지 않는다.
            throw new OrchestrationError("dag_materialize_drift", "의존 순서를 정할 수 없다(검증된 DAG가 아니다)");
        }
        const [node] = remaining.splice(i, 1);
        done.add(node.taskId);
        out.push(node);
    }
    return out;
}
/**
 * **검증 → 순서 → 생성 → 대조.** 문서를 다시 검증하는 것은 중복이 아니다: "이미 검증했다"는 호출자의
 * 주장이며 이 모듈은 그것을 신뢰하지 않는다(deny-by-default).
 *
 * **빈 run에만 물질화한다**: 이미 task가 있는 run에 얹으면 taskId 충돌·소유권 겹침 판정이 문서 범위를
 * 벗어난다(문서는 자기 안에서만 겹침을 봤다). 부분 물질화를 남기지 않는 가장 좁은 계약이다.
 */
export function materializeTaskDag(kernel, rawDocument) {
    const document = validateTaskDag(rawDocument);
    if (kernel.getState().tasks.length > 0) {
        throw new OrchestrationError("dag_materialize_run_not_empty", "이미 task가 있는 run에는 DAG를 물질화하지 않는다");
    }
    const ordered = dependencyOrder(document.tasks);
    const createdOrder = [];
    for (const node of ordered) {
        const seed = {
            taskId: node.taskId,
            roleId: node.roleId,
            title: node.title,
            scope: node.scope,
            ownership: [...node.ownership],
            resourceClasses: [...node.resourceClasses],
            assignmentMessageId: `asg-${node.taskId}`,
            assignmentBody: assignmentBodyFor(node),
        };
        // 의존이 없으면 root, 있으면 dependent — 둘 다 depth 0이고 **중앙이** 만든다.
        if (node.dependsOn.length === 0)
            kernel.createRootTask(seed);
        else
            kernel.createDependentTask({ ...seed, dependsOn: [...node.dependsOn] });
        createdOrder.push(node.taskId);
    }
    // **`B-30` 최후 방어선**: kernel에서 다시 읽어 문서와 대조한다. 물질화가 필드를 잃거나 바꾸면
    // `taskDag.ts`의 소유권 충돌 면제가 근거를 잃기 때문이다(면제의 근거가 곧 이 등호다).
    // **도달 불가 분기다** — 이 블록만 지워도 테스트는 green이다(등호를 단정하는 것은 테스트 쪽이다).
    const tasks = [];
    for (const node of document.tasks) {
        const task = kernel.getTask(node.taskId);
        if (task === null || task === undefined) {
            throw new OrchestrationError("dag_materialize_drift", `물질화한 task를 kernel에서 찾을 수 없다: ${node.taskId}`);
        }
        const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
        if (task.roleId !== node.roleId ||
            task.title !== node.title ||
            task.scope !== node.scope ||
            task.depth !== 0 ||
            task.parentTaskId !== null ||
            !same(task.ownership, node.ownership) ||
            !same(task.dependsOn, node.dependsOn) ||
            !same(task.resourceClasses, node.resourceClasses)) {
            throw new OrchestrationError("dag_materialize_drift", `물질화한 task가 문서와 다르다: ${node.taskId}(ownership·dependsOn·resourceClasses·role·제목·scope 중 하나)`);
        }
        tasks.push(task);
    }
    return { document, createdOrder, tasks };
}
