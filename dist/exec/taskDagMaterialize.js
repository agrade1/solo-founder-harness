/**
 * **검증된 DAG 문서를 실제 kernel task로 물질화한다**(V3 M9 T3② — 대장 `B-30`).
 *
 * ## 새 kernel API를 만들지 않았다
 *
 * `createDependentTask`가 이미 **depth-0 + `dependsOn`** task를 만든다(`createRootTask`는 `dependsOn`을
 * 강제로 비우므로 DAG 간선을 표현할 수 없다). 그래서 물질화는 **의존 순서대로 기존 API를 부르는 것**이고,
 * 중앙만이 상태 전이 주체라는 규칙도 그대로다 — 이 모듈은 kernel에게 **요청**할 뿐 state를 만들지 않는다.
 *
 * ## `B-30`을 코드로 닫는다
 *
 * `taskDag.ts`의 `ownership_conflict` 면제 근거 하나가 "배타 class를 공유하면 kernel scheduler가 동시
 * 실행을 막는다"인데, 그것은 물질화가 문서의 `resourceClasses`·`dependsOn`을 **그대로** 옮길 때만 참이다.
 * 그래서 ⓐ **테스트가 그 등호를 직접 단정하고**(`resourceClasses`·`dependsOn` 미전달 mutation이 red다 —
 * 이것이 `B-30`을 닫는 실제 증거다) ⓑ 이 모듈이 만든 뒤 kernel에서 다시 읽어 대조해 어긋나면
 * `dag_materialize_drift`로 던진다.
 *
 * **ⓑ는 도달 불가한 최후 방어선이다**(`C-44` 부류 — 정직하게 적는다): 매핑이 옳으면 drift가 없으므로
 * 이 분기만 제거해도 red가 나오지 않는다(mutation으로 실측했다). 값은 "나중에 매핑을 잘못 손댔을 때
 * 테스트가 없는 경로에서도 런타임이 멈춘다"는 것뿐이고, **집행이 증거를 대신한다고 주장하지 않는다**.
 *
 * ## `provides`/`consumes`는 어디로 가는가
 *
 * kernel state에 그 축이 없고, 표시·계약 서술을 durable schema에 넣지 않는다는 규율(`F2` 판단과 같다)에
 * 따라 **task_assignment 본문의 `Inputs and Contracts` 절**에 적는다 — worker가 실제로 읽는 자리다.
 * 본문은 결정론적이다: 같은 문서면 같은 바이트가 나온다(`REQUIRED_BODY_HEADINGS` 순서 고정).
 */
import { createHash } from "node:crypto";
import { LIMITS, OrchestrationError, REQUIRED_BODY_HEADINGS, TYPED_EXECUTION_PLAN_SCHEMA_VERSION, assertSlug, } from "./orchestrationTypes.js";
import { validateMessageBody } from "./agentMessage.js";
import { approvedOperationFor, pathWithin } from "./approvalManifest.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";
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
 * 계획에 그대로 실릴 수 있는 operation 객체 1건을 **승인 record에서** 만든다(V3 M11 — 대장 `B-38`).
 *
 * ## 형태의 정본은 하나다 — 계획 검증기다
 *
 * M8이 실측한 함정: 생산자(프롬프트·본문)와 소비자(검증기)가 갈리면 산출물이 **매번** 거부된다.
 * 그래서 이 함수가 만든 객체는 아래 `assignmentOperationsSection`에서 **`validateTypedExecutionPlan`
 * 자신에게** 먹여 본 뒤에야 본문에 실린다. 키 목록을 손으로 옮겨 적은 사본이 아니라 **소비자가 직접
 * 통과시킨 값**이므로 두 축이 갈릴 수 없다.
 *
 * ## `content`만 모델이 채운다
 *
 * `write_file`의 `content`는 **산출물 그 자체**라 승인 record에 없다(승인이 정하는 것은 경로와 바이트
 * 상한이다). 그래서 그 자리에 자기설명 placeholder를 넣는다 — 그대로 복사해도 검증기는 지나고
 * (계약상 임의 문자열이다), 무엇을 바꿔야 하는지는 본문 산문이 한 줄로 말한다.
 * `run_process`·`git_worktree`는 `{operationId, kind, authorityId}`뿐이라 **완전히 그대로**다.
 *
 * `operationId`는 `authorityId`에서 결정론적으로 파생한다(같은 문서면 같은 바이트라는 계약 때문에
 * 난수·시각을 쓸 수 없다). **알려진 천장**: kernel은 같은 attempt 안에서 같은 `operationId`를 다시 열지
 * 않는다(`operation_already_recorded`) → 한 attempt에서 같은 authority를 두 번 쓰려면 모델이 id를
 * 바꿔야 하고, 계약은 그것을 지시하지 않는다. 지금 필요한 것은 "한 번 발행"이라 여기서 닫지 않는다.
 */
function planOperationTemplate(approved) {
    if (approved.kind === "write_file") {
        return {
            operationId: approved.authorityId,
            kind: "write_file",
            authorityId: approved.authorityId,
            path: approved.path,
            content: "<여기에 파일 내용을 넣어라 — 이 필드만 네가 채운다>",
            // 신규 파일 발행이 기본값이다. 기존 파일을 고치는 계약은 승인 record가 표현하지 않으므로
            // (경로와 상한뿐이다) 지시도 그것을 지어내지 않는다 — 모델이 필요하면 실제 hash를 넣는다.
            expectedBeforeSha256: null,
        };
    }
    return { operationId: approved.authorityId, kind: approved.kind, authorityId: approved.authorityId };
}
/**
 * `Inputs and Contracts` 절에 덧붙일 operation 블록. **선언이 없으면 빈 문자열**이다 —
 * `operations` 없는 DAG 문서의 본문이 `B-38` 이전과 **바이트 동일**해야 하기 때문이다
 * (이어받기 판정이 `assignment.bodySha256`을 대조한다 → 한 바이트만 달라도 기존 run이 전부 깨진다).
 */
function assignmentOperationsSection(taskId, approvedOps) {
    if (approvedOps.length === 0)
        return "";
    const templates = approvedOps.map((op) => planOperationTemplate(op));
    // **소비자에게 먼저 물어본다**(위 docstring). 여기서 던지면 지시가 발행되지 않는다 — 검증기를 지나지
    // 못하는 객체를 모델에게 "그대로 넣어라"라고 말하는 상태가 durable에 남지 않는다.
    const probe = { runId: "probe-run", taskId: "probe-task", attemptId: "probe-attempt", turnId: "probe-turn" };
    try {
        validateTypedExecutionPlan({
            schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
            ...probe,
            operations: templates,
            result: { summary: "지시가 실은 operation 형태 검사", outputs: [] },
        }, probe);
    }
    catch (e) {
        throw new OrchestrationError("dag_materialize_seed_rejected", `${taskId}의 지시에 실을 operation이 계획 계약 밖이다(${e instanceof OrchestrationError ? e.code : "unknown"})`);
    }
    return ("\n\n계획의 `operations[]`에 넣을 것(**아래 객체를 그대로 복사**한다 — `content`만 네 산출물로 바꾸고\n" +
        "나머지 필드는 손대지 마라. 필요 없는 operation은 빼도 되지만 여기 없는 operation은 거부된다):\n\n" +
        templates.map((t) => "```json\n" + JSON.stringify(t) + "\n```").join("\n"));
}
/**
 * `Inputs and Contracts`에 덧붙일 **briefing 블록**(V3 M12 L2a). 빈 briefing이면 빈 문자열이다 —
 * 이 축이 생기기 전과 본문이 **바이트 동일**해야 하기 때문이다(`assignmentOperationsSection`과 같은 규율).
 *
 * **모든 줄을 `> `로 인용한다.** `validateMessageBody`의 heading 수집기(`agentMessage.collectHeadings`)는
 * ⓐ 줄 앞의 ```` ``` ````/`~~~`를 fence **토글**로 세고 ⓑ `^##[ \t]`를 h2로 잡는다. 인용하지 않은 산문은
 * 그래서 두 가지로 본문을 깬다: 산문 속 `## 제목`이 **가짜 h2**가 되어 `body_unknown_heading`이거나,
 * 홀수 개의 fence 줄이 뒤따르는 **진짜 heading을 삼켜** `body_missing_heading`이다. `> ` 접두사는 두
 * 정규식 어느 쪽에도 걸리지 않으므로 **임의의 마크다운을 안전하게 싣는다**.
 *
 * **기각한 대안** ⓐ fence로 감싸기: 내용 안의 fence 한 줄이 그대로 짝을 깨뜨린다(더 긴 fence를 써도
 * 같다 — 수집기는 앞 세 글자만 본다). ⓑ 내용에서 fence·heading을 지우기: 그것은 조용한 변조이고,
 * 잘린 아이디어로 만든 산출물은 조용히 틀린다 → 애초에 후보가 아니다. 인용은 **한 바이트도 잃지 않는다**.
 */
function assignmentBriefingSection(briefing) {
    if (briefing.length === 0)
        return "";
    return `\n\n${briefing.split("\n").map((line) => `> ${line}`).join("\n")}`;
}
/**
 * `task_assignment` 본문. **필수 헤딩 전부**를 계약 순서대로 채운다(`REQUIRED_BODY_HEADINGS`가 정본).
 * 내용은 문서·승인에서만 나오고 시각·예산 실측값을 담지 않는다 → 같은 문서·같은 승인이면 같은 바이트다.
 *
 * `approvedOps`가 비면 본문은 `B-38` 이전과 **바이트 동일**하다(위 `assignmentOperationsSection`).
 */
export function assignmentBodyFor(node, approvedOps = []) {
    const list = (items, empty) => items.length === 0 ? empty : items.map((i) => `- \`${i}\``).join("\n");
    const sections = {
        Objective: node.title,
        "Scope / Ownership": `${node.scope}\n\n소유(쓰기 허용) 경로:\n${list(node.ownership, "- (없음)")}`,
        // **금지 목록을 문서가 만들지 않는다**: 권한 정본은 승인 manifest이고 이 절은 그 사실을 가리킨다.
        "Out of Scope / Forbidden": "위 소유 경로 밖 쓰기는 kernel이 거부한다(`operation_not_owned`).\n" +
            "동시에 자원을 점유 중인 다른 task가 그 경로를 소유하면 역시 거부다(`operation_ownership_contended`).\n" +
            "실행 권한·명령·예산의 정본은 **승인 manifest**이며 이 문서가 만들지 않는다.",
        "Inputs and Contracts": `이 task가 만들기로 한 것(provides):\n${list(node.provides, "- (없음)")}\n\n읽기로 한 것(consumes):\n${list(node.consumes, "- (없음)")}` +
            assignmentBriefingSection(node.briefing) +
            assignmentOperationsSection(node.taskId, approvedOps),
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
 * **빈 run이거나, 같은 문서로 물질화하다 만 run에만 물질화한다**: 그 밖의 run에 얹으면 taskId 충돌·
 * 소유권 겹침 판정이 문서 범위를 벗어난다(문서는 자기 안에서만 겹침을 봤다).
 *
 * **부분 물질화(V3 M10 T1 — 대장 `C-76`)**: 문서 검증과 **seed 사전 검증**에서 거부되면 durable에는
 * 아무것도 남지 않는다. 그러나 생성 루프 도중 kernel이 거부하면 앞선 task는 **남는다**(task 생성이
 * task마다 별도 커밋이기 때문이다 — 사전 검증은 kernel 거부 사유를 전부 열거한 것이 아니고 시계·동시
 * writer·IO는 열거로 닫히지 않는다). 이전 판은 그 상태에서 재시도를 `dag_materialize_run_not_empty`로
 * 막아 **run을 벽돌로 만들었다**. 지금은 **같은 문서로 이어받는다**:
 *
 * - 기존 task 전부가 문서 node와 **정확히 일치**하고(아래 `nodeMatchesTask` — `B-30` 대조와 같은 등호 +
 *   state 축 밖 필드까지 보는 assignment 본문 digest 대조), 문서 밖 task가 없고, **아무 task도 시작되지
 *   않았을 때**(`attemptNo === 0`)만 이어받는다.
 * - 그 밖에는 그대로 `dag_materialize_run_not_empty`다. 특히 **한 번 진행된 run에 문서를 다시 얹어
 *   DAG를 키우는 경로는 열지 않았다** — 그것은 복구가 아니라 새 능력이고, 진행 중 소유권 경합 판정의
 *   전제를 바꾼다.
 * - 이어받기는 **멱등**이다: 이미 있는 task는 다시 만들지 않고 `createdOrder`에도 넣지 않는다.
 *
 * 원자적 대안(전 task를 한 커밋으로 만드는 kernel API)을 고르지 않은 이유: `commitRun`의 journal 상한
 * (`MAX_JOURNAL_BODIES`=8 · `MAX_JOURNAL_EVENTS`=64)이 task 8건을 넘는 DAG를 한 커밋으로 표현하지
 * 못한다 → 크래시 복구 journal 계약을 넓히는 별도 slice가 선행해야 한다.
 */
export function materializeTaskDag(kernel, rawDocument) {
    const document = validateTaskDag(rawDocument);
    assertResumableRun(kernel, document);
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
        // **승인 대조 — 승인 밖 operation은 지시에 실리지 못한다**(V3 M11 · 대장 `B-38`).
        // DAG는 `authorityId`를 **참조**할 뿐이므로 record 정본은 언제나 승인 manifest다. 여기서 못 찾으면
        // fail closed: 지시에 실을 수 없는 것을 실은 문서로는 **아무 task도 만들어지지 않는다**(사전 검증).
        const approvedOps = node.operations.map((authorityId) => {
            const approved = approvedOperationFor(manifest, node.taskId, authorityId);
            if (approved === null) {
                throw new OrchestrationError("dag_materialize_seed_rejected", `${node.taskId}의 operations가 승인 밖이다(operationAuthorityByTask에 없다): ${authorityId}`);
            }
            return approved;
        });
        const assignmentBody = assignmentBodyFor(node, approvedOps);
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
                // **지시 축은 언제나 배열이다 — `null`(축 없음)을 만들지 않는다**(`C-111`). 선언이 비었으면
                // `[]`가 곧 "이 task는 operation을 낼 수 없다"이고 kernel이 그것을 집행한다.
                assignedOperations: [...node.operations],
                assignmentMessageId,
                assignmentBody,
            },
        };
    });
    const createdOrder = [];
    for (const { node, seed } of seeds) {
        // 이어받기: 앞선 호출이 이미 만든 task는 **다시 만들지 않는다**(`assertResumableRun`이 그것이
        // 문서와 같음을 이미 확인했다). 다시 부르면 kernel이 `task_exists`로 거부할 뿐이다.
        if (kernel.getTask(node.taskId) !== null)
            continue;
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
        if (!nodeMatchesTask(node, task)) {
            throw new OrchestrationError("dag_materialize_drift", `물질화한 task가 문서와 다르다: ${node.taskId}(ownership·dependsOn·resourceClasses·role·제목·scope 중 하나)`);
        }
        tasks.push(task);
    }
    return { document, createdOrder, tasks };
}
/** 순서를 무시한 집합 등호(문서와 kernel의 정렬 규칙이 다를 수 있다). */
function sameSet(a, b) {
    if (a.length !== b.length)
        return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
}
/**
 * **문서 node와 durable task가 같은 것인가.** `B-30` 최후 방어선과 이어받기 판정이 **같은 등호 하나**를
 * 쓴다 — 두 곳이 갈라지면 "이어받아도 안전하다"의 근거와 "1:1 보존"의 근거가 서로 달라진다.
 * 상태·attempt는 보지 않는다(그것은 `assertResumableRun`이 따로 본다).
 */
function nodeMatchesTask(node, task) {
    return (task.roleId === node.roleId &&
        task.title === node.title &&
        task.scope === node.scope &&
        task.depth === 0 &&
        task.parentTaskId === null &&
        sameSet(task.ownership, node.ownership) &&
        sameSet(task.dependsOn, node.dependsOn) &&
        sameSet(task.resourceClasses, node.resourceClasses) &&
        // **`null`은 문서 node와 같지 않다**(V3 M11): 물질화는 언제나 배열을 만들므로, `null`인 task는
        // 이 문서가 만든 것이 아니다. `?? []`로 접으면 kernel API로 직접 만든 task가 `operations` 없는
        // node와 같아 보이고, 그러면 남의 task 위에 문서를 얹는 경로가 열린다.
        task.assignedOperations !== null &&
        sameSet(task.assignedOperations, node.operations));
}
/**
 * **빈 run이거나 같은 문서로 물질화하다 만 run인가**(대장 `C-76`). 아니면 `dag_materialize_run_not_empty`다.
 *
 * 이어받기 조건 셋 전부를 요구한다: ⓐ 기존 task가 전부 문서 안에 있고 ⓑ 각각 문서 node와 정확히 같고
 * ⓒ **아무 task도 시작된 적이 없다**(`attemptNo === 0`). ⓒ가 없으면 진행 중인 run에 문서를 다시 얹어
 * DAG를 키울 수 있고, 그것은 부분 물질화 복구가 아니라 새 능력이다.
 */
function assertResumableRun(kernel, document) {
    const state = kernel.getState();
    const existing = state.tasks;
    if (existing.length === 0)
        return;
    const byId = new Map(document.tasks.map((n) => [n.taskId, n]));
    for (const task of existing) {
        const node = byId.get(task.taskId);
        if (node === undefined) {
            throw new OrchestrationError("dag_materialize_run_not_empty", `이 run에는 문서 밖 task가 있다 — 물질화 이어받기 대상이 아니다: ${task.taskId}`);
        }
        if (!nodeMatchesTask(node, task)) {
            throw new OrchestrationError("dag_materialize_run_not_empty", `기존 task가 문서 node와 다르다 — 이어받으면 문서와 durable이 갈린다: ${task.taskId}`);
        }
        // **state 축이 아닌 필드까지 본다**(T1 적대적 리뷰 B1). `provides`/`consumes`(= API contract)는
        // kernel state에 없고 **assignment 본문**에만 산다 → 위 등호만으로는 "문서를 고쳐 들고 와서
        // 앞선 task는 구계약, 새 task는 신계약"이 통과한다. 본문은 같은 문서면 같은 바이트이므로
        // (`assignmentBodyFor` 결정론) durable digest와 재계산 digest를 그대로 대조한다.
        const assignment = state.messages.find((m) => m.messageId === `asg-${task.taskId}`);
        // 본문은 문서 **와 승인**에서 나온다(V3 M11: operation 객체가 실린다) → 재계산도 같은 두 입력을
        // 쓴다. 승인 밖 id는 여기서 `null`이 되어 대조가 어긋나므로 이어받기도 fail closed다.
        const approvedOps = node.operations
            .map((authorityId) => approvedOperationFor(kernel.getManifest(), node.taskId, authorityId))
            .filter((op) => op !== null);
        const expected = createHash("sha256").update(assignmentBodyFor(node, approvedOps), "utf8").digest("hex");
        if (assignment === undefined || assignment.bodySha256 !== expected) {
            throw new OrchestrationError("dag_materialize_run_not_empty", `기존 task의 assignment 본문이 문서와 다르다(provides·consumes 등 state 축 밖 필드): ${task.taskId}`);
        }
        if (task.execution.attemptNo !== 0) {
            throw new OrchestrationError("dag_materialize_run_not_empty", `이미 시작된 task가 있는 run에는 이어받지 않는다: ${task.taskId}`);
        }
    }
}
