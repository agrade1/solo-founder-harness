import { LIMITS, OrchestrationError, REQUIRED_BODY_HEADINGS, assertSlug } from "./orchestrationTypes.js";
import { validateMessageBody } from "./agentMessage.js";
import { pathWithin } from "./approvalManifest.js";
import { validateTaskDag } from "./taskDag.js";
/** 이 모듈이 고유하게 내는 안정 오류 코드(닫힌 목록 — kernel 코드는 그대로 올라온다). */
export const TASK_DAG_MATERIALIZE_CODES = [
    /** 만든 task가 문서와 어긋난다(`B-30` 집행 — 매핑이 필드를 잃거나 바꿨다). */
    "dag_materialize_drift",
    /** 이미 task가 있는 run에 물질화하려 했다(부분 물질화·중복 방지). */
    "dag_materialize_run_not_empty",
    /**
     * 문서는 유효하지만 그것으로 만든 seed가 **kernel이 받아들일 수 없는 형태**다(T3② 적대적 리뷰 A·B).
     * 생성 **전에** 전부 검사하므로 이 코드가 나올 때 durable에는 아무것도 남지 않는다.
     */
    "dag_materialize_seed_rejected",
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
        // **도달 가능한 자리다**(T3② 적대적 리뷰 B — 처음엔 "문서 상한이 이 한도 안에 들어간다"고 잘못
        // 적었다): `provides`는 본문에 **두 번** 실리므로 512자 경로 16개면 ≈16.5KB로 `maxBodyBytes`를 넘고,
        // 그 문서는 `validateTaskDag`를 통과한다. drift가 아니라 크기 초과이므로 코드도 따로 쓴다.
        throw new OrchestrationError("dag_materialize_seed_rejected", `task_assignment 본문이 상한을 넘는다: ${node.taskId}`);
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
            // 도달 불가: `validateTaskDag`가 순환과 미상 의존을 이미 거부했다. 이 함수는 아직 task를
            // 만들지 않은 단계에서 도므로 여기서 던져도 durable에는 아무것도 없다.
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
 * 벗어난다(문서는 자기 안에서만 겹침을 봤다).
 *
 * **부분 물질화에 대해 무엇을 보장하는가(정직하게)**: 문서 검증과 **seed 사전 검증**에서 거부되면
 * durable에는 아무것도 남지 않는다. 그러나 생성 루프 도중 kernel이 거부하면 앞선 task는 **남는다**
 * (task 생성이 task마다 별도 커밋이기 때문이다). 그 상태에서 재시도는 `dag_materialize_run_not_empty`로
 * 막히므로 **run은 사람이 손대야 한다**. 사전 검증이 알려진 원인 4종을 걷어냈을 뿐이고
 * "mid-loop 실패 불가"를 주장하지 않는다 — 대장 `C-76`.
 */
export function materializeTaskDag(kernel, rawDocument) {
    const document = validateTaskDag(rawDocument);
    if (kernel.getState().tasks.length > 0) {
        throw new OrchestrationError("dag_materialize_run_not_empty", "이미 task가 있는 run에는 DAG를 물질화하지 않는다");
    }
    const ordered = dependencyOrder(document.tasks);
    // **seed 전부를 먼저 만들고 먼저 검증한다**(T3② 적대적 리뷰 A). 이전 판은 만들면서 검증했는데,
    // `validateTaskDag`를 통과한 문서도 kernel 생성 단계에서 거부될 수 있고(아래) task 생성은 **task마다
    // 별도 커밋**이라 앞선 task가 durable에 남았다 → 재시도는 `dag_materialize_run_not_empty`로 막혀
    // **run이 벽돌이 됐다.** 실제로 걸린 입력 4종이 전부 여기서 걸러진다:
    //
    //  ⓐ `title`/`scope`에 개행이 있어 본문 안에서 **가짜 h2 heading**이 되는 경우
    //     (`assertText`는 개행을 허용하고, kernel은 `validateMessageBody`에서 `body_unknown_heading`으로
    //      거부한다 → **kernel과 같은 함수를 여기서 먼저 부른다**).
    //  ⓑ 61자 이상 taskId → `asg-<taskId>`가 slug 상한(64)을 넘는 경우.
    //  ⓒ 승인 manifest의 `ownershipByTask`에 그 taskId가 없거나 범위 밖인 경우(문서는 manifest를 보지 않는다).
    //  ⓓ `provides` 경로가 길어 본문이 `maxBodyBytes`를 넘는 경우.
    //
    // **그래도 "mid-loop 실패가 불가능하다"고 주장하지 않는다** — 사전 검증은 kernel 거부 사유를
    // 전부 열거한 것이 아니다. 남은 위험과 그 결과(부분 물질화 · 재시도 불가)는 대장에 적었다.
    const manifest = kernel.getManifest();
    const seeds = ordered.map((node) => {
        const assignmentMessageId = `asg-${node.taskId}`;
        try {
            assertSlug(assignmentMessageId, "assignmentMessageId");
        }
        catch {
            throw new OrchestrationError("dag_materialize_seed_rejected", `taskId가 길어 assignment 메시지 id가 slug 상한을 넘는다: ${node.taskId}`);
        }
        const approvedOwnership = manifest.ownershipByTask[node.taskId];
        if (approvedOwnership === undefined) {
            throw new OrchestrationError("dag_materialize_seed_rejected", `승인 manifest의 ownershipByTask에 없는 task다: ${node.taskId}`);
        }
        for (const own of node.ownership) {
            if (!approvedOwnership.some((a) => pathWithin(own, a))) {
                throw new OrchestrationError("dag_materialize_seed_rejected", `${node.taskId}의 ownership이 승인 범위 밖이다: ${own}`);
            }
        }
        const assignmentBody = assignmentBodyFor(node);
        // **kernel이 쓰는 바로 그 검증기**를 먼저 부른다(두 번째 규칙을 만들지 않는다).
        try {
            validateMessageBody("task_assignment", assignmentBody);
        }
        catch (e) {
            throw new OrchestrationError("dag_materialize_seed_rejected", `${node.taskId}의 task_assignment 본문이 계약 밖이다(${e instanceof OrchestrationError ? e.code : "unknown"}) — title·scope의 개행이 가짜 heading을 만들었을 수 있다`);
        }
        return {
            node,
            seed: {
                taskId: node.taskId,
                roleId: node.roleId,
                title: node.title,
                scope: node.scope,
                ownership: [...node.ownership],
                resourceClasses: [...node.resourceClasses],
                assignmentMessageId,
                assignmentBody,
            },
        };
    });
    const createdOrder = [];
    for (const { node, seed } of seeds) {
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
        const same = (a, b) => {
            if (a.length !== b.length)
                return false;
            const x = [...a].sort();
            const y = [...b].sort();
            return x.every((v, i) => v === y[i]);
        };
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
