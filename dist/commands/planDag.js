/**
 * V3 M12 L2a — **`harness plan-dag`**(아이디어 문서 → task DAG 문서 **초안**) + **`harness validate-dag`**.
 *
 * `B-38`이 만든 통로(지시에 operation 객체를 싣는다 → 모델이 복사해 `content`를 채운다 → typed write가
 * 파일을 만든다)를 **하네스 자신에게** 먹인다: 지금 `dag.json`은 사람이 손으로 쓴다. 이 명령은 그것을
 * **planner task가 typed write로 내는 산출물**로 바꾼다.
 *
 * ## 이 명령이 만드는 것과 만들지 않는 것
 *
 * - 만든다: **단일 task DAG**("dag 초안을 작성하라") 하나와, 그것을 물질화한 orchestration run.
 * - **만들지 않는다: 승인.** 승인 manifest는 **사람이 쓴다**. 이 명령은 manifest 필드를 채우지도, 승인
 *   초안을 생성하지도 않는다 — 그것(L2b)은 trust root를 건드리므로 별도의 사용자 결정이다.
 * - **만들지 않는다: 초안 → 실행 자동 통로.** 산출물은 **DAG 문서 초안 하나**이며, 하네스가 그것을
 *   `autopilot-create`에 자동으로 넘기는 코드는 여기 없다(그런 import 자체가 없다). 사람이 읽고 고치고
 *   자기 손으로 다음 명령을 친다. `validate-dag`도 **읽기 전용**이다 — 초안을 고치거나 지우지 않는다.
 *
 * ## task node를 **승인에서 파생한다**(지어내지 않는다)
 *
 * 운영자가 쓰는 파일은 승인 manifest 하나이고, planner task의 축은 전부 거기서 나온다:
 *
 * | node 축 | 어디서 | 어긋나면 |
 * |---|---|---|
 * | `ownership` | `manifest.ownershipByTask[dag-draft]` | 없으면 fail closed(seed를 만들 수 없다) |
 * | `operations` | `manifest.operationAuthorityByTask[dag-draft]`의 `authorityId` **전부** | 없으면 fail closed |
 * | `provides` | 위 권위 중 `write_file`의 `path` | `ownership` 밖이면 `provides_not_owned` |
 *
 * **기각한 대안** ⓐ 경로·권위를 CLI 플래그로 받기: 그러면 승인 밖 경로를 명령줄로 적을 수 있게 되고,
 * 물질화가 그것을 거부하더라도 "명령이 권위를 표현한다"는 모양이 남는다. 파생은 그 모양 자체를 없앤다.
 * ⓑ `write_file`만 골라 `operations`에 싣기: 사람이 승인에 넣은 권위를 **조용히 버리는** 필터가 된다.
 * 전부 싣고, 필요 없으면 승인에서 빼는 것이 정본이다.
 *
 * ## 아이디어 텍스트는 **지시 본문 안에** 실린다
 *
 * live worker는 `--tools ""`로 돌아 **파일을 읽을 수 없다**. 그래서 아이디어 원문은 새 읽기 통로가
 * 아니라 `briefing`(→ 지시 본문 `Inputs and Contracts` 절)으로 간다. 상한을 넘으면 **fail closed이며
 * 자르지 않는다** — 잘린 아이디어로 만든 DAG는 조용히 틀린 산출물이다.
 *
 * `scope`가 아니라 `briefing`인 이유: `scope`는 500자(`LIMITS.maxTextLength`)이고 kernel durable state에
 * 그대로 저장된다(`taskDag.ts`의 `briefing` 주석 참조). 아이디어 문서 원문은 거기 들어가지 않는다.
 *
 * ## 문서 계약은 **상수에서 파생한다**
 *
 * M8의 함정: 생산자 프롬프트와 검증기가 갈리면 산출물이 매번 거부된다. 그래서 지시에 실리는 key 목록·
 * schemaVersion·상한·role 목록은 전부 `taskDag.ts`/`approvalManifest.ts`의 **상수를 읽어** 만든다.
 * 손으로 옮겨 적은 사본은 이 파일에 없다(규칙 산문은 파생할 수 없으므로 최소로 적는다).
 */
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { ideaGateStatus, readRunStateAt } from "../core/runWorkflow.js";
import { pipelineGateStatus, pipelineStatePath, readPipelineStateAt } from "../core/pipeline.js";
import { LIMITS, OrchestrationError } from "../exec/orchestrationTypes.js";
import { SPECIALIST_ROLES, validateApprovalManifest } from "../exec/approvalManifest.js";
import { DAG_DOCUMENT_KEYS, DAG_NODE_KEYS, DAG_NODE_OPTIONAL_KEYS, MAX_DAG_CONTRACT_PATHS, MAX_DAG_TASKS, TASK_DAG_SCHEMA_VERSION, validateTaskDag, } from "../exec/taskDag.js";
import { assignmentBodyFor } from "../exec/taskDagMaterialize.js";
import { createRunFromDocuments, readJsonDocument } from "./autopilotCreate.js";
/**
 * planner task의 **고정 taskId**. 사람이 승인 manifest에 이 이름으로 `ownershipByTask`와
 * `operationAuthorityByTask`를 적어야 한다 — 그 두 항목이 곧 "이 초안을 어디에 쓸 수 있는가"다.
 *
 * `--task` 플래그를 두지 않았다: 이름을 명령줄에서 고를 수 있으면 승인과 명령이 갈릴 자리가 하나 더
 * 늘어난다(승인에 없는 이름 → seed 거부인데, 그 거부는 오타에서도 나온다). run마다 디렉터리가 다르므로
 * 이름 하나로 충분하다.
 */
export const PLAN_DAG_TASK_ID = "dag-draft";
/** DAG 문서를 만드는 것은 Tech Lead 역할이다(`taskDag.ts` 모듈 docstring의 전제와 같다). */
export const PLAN_DAG_ROLE_ID = "tech-lead";
/**
 * 아이디어 문서를 읽는다. 실패·빈 파일·비 UTF-8·상한 초과는 전부 **기존 text 계약 코드**로 닫는다
 * (새 코드를 만들지 않는다 — 그러면 이 명령이 자기 판정을 갖게 된다).
 *
 * 상한은 `LIMITS.maxBodyBytes`다: 이보다 큰 아이디어는 어차피 지시 본문 상한에서 죽으므로 두 번째
 * 규칙이 아니라 **같은 규칙을 먼저 보는 것**이고, 크기를 `statSync`로 먼저 보므로 거대한 파일을
 * 메모리에 올리지 않는다. **자르지 않는다.**
 */
function readIdeaDocument(file) {
    const path = resolve(file);
    let bytes;
    try {
        const size = statSync(path).size;
        if (size > LIMITS.maxBodyBytes) {
            throw new OrchestrationError("text_too_long", `아이디어 문서가 ${LIMITS.maxBodyBytes}바이트 상한을 넘는다(${size}) — 자르지 않는다. 문서를 줄여라: ${path}`);
        }
        bytes = readFileSync(path);
    }
    catch (err) {
        if (err instanceof OrchestrationError)
            throw err;
        throw new OrchestrationError("invalid_text", `아이디어 문서를 읽을 수 없다: ${path}`);
    }
    let text;
    try {
        // `fatal: true` — 잘못된 UTF-8을 U+FFFD로 조용히 바꾸지 않는다(`offlinePlanWorker`와 같은 판단).
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    }
    catch {
        throw new OrchestrationError("invalid_text", `아이디어 문서가 올바른 UTF-8이 아니다: ${path}`);
    }
    if (text.trim().length === 0) {
        throw new OrchestrationError("invalid_text", `아이디어 문서가 비어 있다: ${path}`);
    }
    // [B-40/A-1] 원본 바이트를 함께 돌려준다: 폐기 잠금 digest는 **지시 본문에 실리는 그 바이트**에서
    // 나와야 한다. 경로를 두 번 읽으면 검사한 것과 싣는 것이 다를 수 있다.
    return { text, bytes };
}
/**
 * [B-40] **폐기된 아이디어로는 run을 만들지 않는다.** kill 게이트가 죽인 아이디어가 DAG 초안 → 실행으로
 * 부활하는 길을 닫는다. `createRunFromDocuments` **앞에서** 던지므로 durable 잔류가 0이다.
 *
 * **한계(정직하게 적는다)**: 아이디어 경로가 `<project>/docs/00_IDEA.md` 꼴일 때만 프로젝트를 찾는다
 * (`dirname(dirname(idea))/outputs/run_state.json`). 아이디어 문서를 프로젝트 밖 임의 경로에 두면
 * 연결할 run_state가 없어 **이 검사는 아무것도 막지 못한다** — 그 경로를 프로젝트로 되짚는 규칙이
 * 하네스에 없기 때문이고, 없는 규칙을 여기서 지어내지 않는다. 판정 자체는 `killedIdeaBlock` 하나를
 * 공유하므로 run/task-prompt와 규칙이 갈리지 않는다.
 */
function assertIdeaNotKilled(ideaPath, bytes) {
    const ideaAbs = resolve(ideaPath);
    const projectRoot = dirname(dirname(ideaAbs));
    const read = readRunStateAt(join(projectRoot, "outputs", "run_state.json"));
    // [A-1] digest는 **방금 읽어 지시 본문에 실릴 그 바이트**에서 낸다 (경로 재읽기 없음).
    // allowReevaluation=false: DAG 초안은 재평가가 아니다. 잠금이 걸려 있으면 계속 거부한다.
    const snapshot = { path: ideaAbs, sha256: createHash("sha256").update(bytes).digest("hex"), text: "" };
    const gate = ideaGateStatus(read, snapshot);
    if (!gate.ok)
        throw new OrchestrationError("dag_materialize_seed_rejected", `${gate.code}: ${gate.message}`);
    // [B-41/2단] **단계 체크포인트 게이트도 같은 자리에서 본다** — 개정 2가 산문으로 "닫힌다"고 적었던
    // 것을 코드로 만든다(소비자 5곳이 같은 함수 하나를 쓴다). 확인 대기·앞 단계·폐기·drift는 전부 거부.
    // 위 폐기 잠금과 **같은 한계**를 공유한다: 아이디어 경로가 `<project>/docs/00_IDEA.md` 꼴이 아니면
    // projectRoot를 못 찾고, 그 경우 두 게이트 모두 아무것도 막지 못한다(신규 악화 없음 — §8 우회 4).
    const pipeGate = pipelineGateStatus(readPipelineStateAt(pipelineStatePath(projectRoot)), projectRoot, "plan-dag");
    if (!pipeGate.ok)
        throw new OrchestrationError("dag_materialize_seed_rejected", pipeGate.message);
}
/** `["a","b"]` → `` `a` · `b` `` (상수 목록을 지시 산문에 싣는 유일한 형식). */
const inline = (items) => items.map((i) => `\`${i}\``).join(" · ");
/**
 * **DAG 문서 계약을 상수에서 파생해** 지시에 실을 산문으로 만든다. 손으로 옮겨 적은 key 사본이 없으므로
 * `taskDag.ts`가 축을 늘리면 이 문구도 같이 움직인다(M8 함정 — 생산자와 검증기가 갈리면 산출물이 매번
 * 거부된다).
 */
export function dagContractBriefing() {
    const required = DAG_NODE_KEYS.filter((k) => !DAG_NODE_OPTIONAL_KEYS.includes(k));
    return [
        "## 산출물 계약 — task DAG 문서 (아래 규칙은 검증기 `validateTaskDag`에서 그대로 파생했다 — " +
            "**단 1건, `provides` 개수 지침은 검증기가 아니라 live 실행층 실측 제약이며 그 줄에 그렇게 적혀 있다**)",
        "",
        `- 문서 최상위 key는 정확히 이것뿐이다(다른 key는 거부): ${inline(DAG_DOCUMENT_KEYS)}`,
        `- \`schemaVersion\`은 문자열 "${TASK_DAG_SCHEMA_VERSION}"이다.`,
        `- \`tasks\`는 node 배열이고 1개 이상 ${MAX_DAG_TASKS}개 이하다(빈 배열은 계획이 아니다).`,
        `- node의 key는 정확히 이것뿐이다: ${inline(DAG_NODE_KEYS)}`,
        `- 그중 **반드시 있어야 하는 것**: ${inline(required)}`,
        `- 생략 가능한 것(생략하면 빈 목록/빈 문자열): ${inline(DAG_NODE_OPTIONAL_KEYS)}`,
        "",
        "규칙:",
        "",
        "- `taskId`는 소문자 slug이며 문서 안에서 유일하다.",
        `- \`roleId\`는 다음 7종 중 하나이거나 그 하위(\`<상위>.<하위>\`)다: ${inline(SPECIALIST_ROLES.map((r) => r.roleId))}`,
        "- `title`·`scope`는 비어 있지 않은 문자열이고 각각 " + `${LIMITS.maxTextLength}자 이하다.`,
        "- `ownership`·`provides`·`consumes`는 **정규화된 workspace-relative 경로**다: 절대경로·`..`·`./`·" +
            "backslash·중복 금지, 이미 정규화된 표기 그대로 적어야 한다.",
        `- \`ownership\`은 1개 이상 ${LIMITS.maxOwnershipPaths}개 이하, \`provides\`/\`consumes\`는 각각 ${MAX_DAG_CONTRACT_PATHS}개 이하다.`,
        `- \`dependsOn\`은 **이 문서 안에 있는** taskId만 가리킨다(${LIMITS.maxDependsOn}개 이하). 자기 자신·중복·순환은 거부된다.`,
        "- `provides`는 그 task가 만들 산출물이며 **자기 `ownership` 안**이어야 한다.",
        // **C-117 결정 ⓐ — 계획층에서 푼다.**
        //
        // **관측(인과가 아니다)**: 문서 전문 2개를 한 task의 `provides`에 담은 live task가
        // `worker_plan_absent`로 2/2 실패했고, 같은 run의 1-file task는 성공했다(17,969B). transcript는 설계상
        // 미저장이라 **원인은 미확정**이다. 그리고 **반례가 있다**: 다른 1-file task(ux-flows)도 같은 코드로
        // 죽었다(가짜 tool-use 출력) — 즉 `worker_plan_absent`는 파일 수와 무관한 실패 모드를 포함하며
        // "provides 2개가 계획 추출을 깨뜨린다"는 **관측이 뒷받침하지 않는 일반화**다(적대적 리뷰 A-2에서 정정).
        //
        // 그래서 이 지침의 근거는 인과가 아니라 **위험 회피 + 재시도 단위 축소**다: 나누면 multi-provides라는
        // 조건 자체가 사라지고(논리적 사실), 실패했을 때 다시 도는 단위가 task 하나로 작아진다.
        //
        // 기각한 대안 ⓑ **turn 분할 발행**(한 task가 여러 turn에 걸쳐 provides를 하나씩 낸다): plan schema ·
        // kernel permit · autopilot loop · 영수증을 전부 건드리는 **계약층** 변경인데 지금 그것을 요구하는
        // 실사용 경로가 없다. 문서 단계는 task 분할로 완전히 표현되고 재시도 단위도 task 하나로 작아진다.
        //
        // 검증기(`validateTaskDag`)는 **조이지 않았다**: 손으로 쓴 DAG의 multi-provides는 offline backend에서
        // 멀쩡히 돈다 → 이것은 문서 계약이 아니라 live 실행층의 실측 제약이고, 그래서 검증 규칙이 아니라
        // **지침 한 줄**로만 산다(그 사실을 줄 안에 적어 헤더의 "검증기에서 파생했다"와 모순되지 않게 한다).
        "- `provides`는 **task당 1개**로 하라 — 산출물이 여러 개인 단계는 task를 나눠 각각 1개씩 `provides`하고 " +
            "`dependsOn`/`consumes`로 이어라. (**검증기 규칙이 아니라 live 실행층 관측에서 나온 지침이다**: 실측에서 " +
            "2-file task가 2/2 실패했고 1-file 대조군은 성공했다 — **원인은 미확정**이다. 위험 회피와 재시도 단위 " +
            "축소를 위해 나눈다 — C-117.)",
        "- `consumes`는 그 task가 읽을 남의 산출물이며 **이행적 의존 중 누군가가 `provides`로 선언한 것**이어야 한다.",
        "- 서로 의존으로 묶이지 않은(= 동시에 돌 수 있는) 두 task는 **같은 경로를 소유할 수 없다**. 겹쳐야 한다면 " +
            "`dependsOn`으로 순서를 주거나 같은 `resourceClasses`를 공유해라.",
        "- `operations`는 승인 manifest에 있는 `authorityId` **문자열 참조**다. 경로·명령·상한을 여기 적을 수 없다" +
            "(권한의 정본은 승인 manifest이고 이 문서는 권한을 만들지 못한다). 승인 밖 id는 거부된다.",
        "- `briefing`은 그 task의 지시 본문에 그대로 실릴 산문이다(권한이 아니다).",
    ].join("\n");
}
/** 승인에서 파생한 planner task node 1건. 파생할 수 없으면 던진다(조용한 기본값 없음). */
function planDagNode(manifest, idea, ideaPath) {
    const ownership = manifest.ownershipByTask[PLAN_DAG_TASK_ID];
    if (ownership === undefined || ownership.length === 0) {
        throw new OrchestrationError("dag_materialize_seed_rejected", `승인 manifest의 ownershipByTask에 "${PLAN_DAG_TASK_ID}"가 없다 — 초안을 쓸 소유 경로가 승인되지 않았다`);
    }
    const approvedOps = manifest.operationAuthorityByTask[PLAN_DAG_TASK_ID] ?? [];
    const writes = approvedOps.filter((op) => op.kind === "write_file");
    if (writes.length === 0) {
        throw new OrchestrationError("dag_materialize_seed_rejected", `승인 manifest의 operationAuthorityByTask["${PLAN_DAG_TASK_ID}"]에 write_file 권위가 없다 — 초안을 쓸 곳이 없다`);
    }
    const draftPaths = writes.map((op) => op.path);
    const node = {
        taskId: PLAN_DAG_TASK_ID,
        roleId: PLAN_DAG_ROLE_ID,
        title: "아이디어 문서에서 task DAG 문서 초안을 만든다",
        scope: "산출물은 아래 승인된 경로의 task DAG 문서 JSON **초안** 하나다. " +
            "아이디어 원문과 문서 계약은 `Inputs and Contracts` 절에 있다. " +
            "이것은 초안이며 사람이 읽고 고친 뒤에야 실행에 쓰인다 — 스스로 실행하거나 승인을 만들지 마라.",
        ownership: [...ownership],
        dependsOn: [],
        provides: [...draftPaths].sort(),
        consumes: [],
        resourceClasses: [],
        operations: approvedOps.map((op) => op.authorityId),
        briefing: `${dagContractBriefing()}\n\n## 아이디어 문서 원문 (\`${ideaPath}\`) — 이 아래 전부가 입력이다\n\n${idea}`,
    };
    // node는 **검증기를 지나서** 나간다: 정규화(정렬·중복 거부)와 승인-파생 값의 형식 판정을 여기서
    // 두 번째로 구현하지 않는다. 단일 node 문서이므로 `tasks[0]`이 곧 그 node다.
    return { node: validateTaskDag({ schemaVersion: TASK_DAG_SCHEMA_VERSION, tasks: [node] }).tasks[0], approvedOps };
}
/**
 * 승인 파일 + 아이디어 문서 → **DAG 초안을 만드는 run**. 실행은 하지 않는다(그 다음은 `harness autopilot`).
 * 던지는 것은 전부 기존 검증기의 안정 코드다.
 */
export function createPlanDagRun(opts) {
    // [A-1] 아이디어를 한 번 읽고, 그 바이트로 잠금을 판정하고 그 바이트를 지시 본문에 싣는다.
    // 잠금 거부는 승인 읽기·run 생성보다 앞이라 durable 잔재가 0이다.
    const idea = readIdeaDocument(opts.idea);
    assertIdeaNotKilled(opts.idea, idea.bytes);
    const workspaceRoot = resolve(opts.workspace ?? process.cwd());
    const rawManifest = readJsonDocument(opts.approval, "invalid_manifest");
    // 여기서 `validateApprovalManifest`를 직접 부르는 이유는 **파생**이다(검증이 아니다 — 그것은
    // `createRunFromDocuments`가 다시 한다): 승인이 정한 ownership·권위를 읽어야 node를 만들 수 있다.
    const manifest = validateApprovalManifest(rawManifest);
    const { node, approvedOps } = planDagNode(manifest, idea.text, opts.idea);
    // **본문 상한을 run 생성 *전에* 본다.** 물질화도 같은 함수로 같은 판정을 하지만 그때는 run이 이미
    // durable에 있다 → 아이디어 하나가 커서 거부되면 **task 0개인 run**이 남는다. 같은 함수를 부르므로
    // 두 번째 규칙은 생기지 않고, 본문은 결정론적이라 두 호출의 결과가 갈릴 수 없다.
    assignmentBodyFor(node, approvedOps);
    const result = createRunFromDocuments({
        workspaceRoot,
        runId: opts.run,
        milestoneId: opts.milestone,
        rawManifest,
        rawDag: { schemaVersion: TASK_DAG_SCHEMA_VERSION, tasks: [node] },
    });
    return { ...result, draftPaths: node.provides };
}
/** `harness plan-dag` 명령 본체. 거부는 다른 무인 loop 진입점과 같은 exit 2다. */
export function runPlanDagCommand(opts) {
    let result;
    try {
        result = createPlanDagRun(opts);
    }
    catch (err) {
        // 코드를 지어내지 않는다: `OrchestrationError`가 아니면 예상한 거부가 아니라 버그다.
        const code = err instanceof OrchestrationError ? err.code : "plan_dag_internal_error";
        process.stdout.write(`[plan-dag] 거부: ${code} — ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
        return;
    }
    process.stdout.write(`[plan-dag] ${result.created ? "run 생성" : "기존 run 이어받기"}: ${result.runId}@${result.milestoneId} · ` +
        `planner task ${result.taskCount}건 · 초안 산출 경로 ${result.draftPaths.join(",")}\n`);
    process.stdout.write(`[plan-dag] 다음: harness autopilot --run ${result.runId} --milestone ${result.milestoneId} --worker-backend <backend> ...\n`);
    // **초안은 초안이다.** 검증은 사람이 자기 손으로 돌린다 — 여기서 자동으로 실행에 넘기는 통로는 없다.
    process.stdout.write(`[plan-dag] 그 다음: harness validate-dag ${result.draftPaths[0]} 로 초안을 판정하고, 사람이 고친 뒤 autopilot-create에 넘겨라\n`);
}
/**
 * `harness validate-dag <file>` — 초안이 `validateTaskDag`를 지나는지 **읽기 전용**으로 판정한다.
 *
 * ## 왜 별도 명령인가 (기각한 대안: plan-dag 완료 시 자동 검증)
 *
 * `plan-dag`는 run을 만들고 **즉시 끝난다** — 모델이 초안을 쓰는 것은 그 뒤 `harness autopilot`이다.
 * 그래서 "plan-dag 완료 시 자동 검증"은 검증할 파일이 아직 없는 시점이고, 실제로 하려면 `autopilot`
 * loop가 "이 task는 DAG 초안이다"를 알아야 한다. 그것은 ⓐ 범용 loop에 특정 task 종류를 심는 것이고
 * ⓑ 불통과 초안을 pause·실패로 만들 유혹을 만든다 — **불통과 초안도 산출물로 남아야 한다**(사람이
 * 읽고 고치는 재료다). 별도 read-only 명령은 그 둘 다에서 자유롭고, 사람이 손으로 쓴 DAG 파일을
 * `autopilot-create` 전에 미리 재는 데에도 그대로 쓰인다.
 *
 * **이 명령은 파일을 쓰지 않는다**(import에 쓰기 API가 없다). 불통과여도 초안은 그 자리에 그대로 있다.
 */
export function runValidateDagCommand(opts) {
    let document;
    try {
        document = validateTaskDag(readJsonDocument(opts.file, "invalid_dag_document"));
    }
    catch (err) {
        const code = err instanceof OrchestrationError ? err.code : "validate_dag_internal_error";
        process.stdout.write(`[validate-dag] 불통과: ${code} — ${err instanceof Error ? err.message : String(err)}\n`);
        process.stdout.write(`[validate-dag] 초안 파일은 그대로 남아 있다: ${resolve(opts.file)}\n`);
        process.exitCode = 2;
        return;
    }
    process.stdout.write(`[validate-dag] 통과: task ${document.tasks.length}건 — ${document.tasks.map((t) => `${t.taskId}(${t.roleId})`).join(" · ")}\n`);
    // 통과는 **문서 계약**만 말한다. 승인 대조(ownership·operations)는 `autopilot-create`가 한다.
    process.stdout.write("[validate-dag] 이것은 문서 계약 판정이다 — 승인 범위 대조는 autopilot-create에서 한다\n");
}
