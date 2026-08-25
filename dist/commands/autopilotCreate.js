/**
 * V3 M11 — **`harness autopilot-create`**: 무인 loop의 **운영자 진입점**.
 *
 * 지금까지 `createOrchestrationRun`·`materializeTaskDag`를 부르는 CLI 호출부가 **한 건도 없었다** —
 * live 파이프라인은 `scripts/m10-live-*.mjs`가 손으로 짠 fixture로만 도달했다. 이 모듈이 하는 일은
 * 그 두 함수를 **운영자가 authoring한 파일 두 개**에 잇는 것뿐이다:
 *
 * - **승인 manifest 파일** — `schemas/milestone_approval_manifest.schema.json` 계약.
 * - **task DAG 문서 파일** — `taskDag.ts`의 닫힌 문서 계약.
 *
 * ## 이 명령은 승인을 **발행하지 않는다**
 *
 * 이 레포의 뿌리는 "승인 문서가 유일한 trust root"다. 그래서 여기에는 **manifest 필드를 채워 주거나
 * 기본값을 넣거나 대화형으로 물어보는 코드가 없다.** 파일이 계약을 어기면 그대로 fail closed이고,
 * 거부 코드는 **기존 검증기가 내는 코드 그대로**다(새 코드를 만들지 않았다 — 새 코드는 곧 "이 명령이
 * 자기 판정을 갖는다"는 뜻이고, 그러면 승인 판정이 두 곳으로 갈린다).
 *
 * 검증도 이 모듈이 다시 하지 않는다: `createOrchestrationRun`이 `validateApprovalManifest`를,
 * `materializeTaskDag`가 `validateTaskDag`를 **먼저** 부르고 둘 다 durable 부작용 **전에** 던진다.
 * 이 모듈이 직접 `validateApprovalManifest`를 부르는 자리는 **이어받기 대조 한 곳뿐**이다(아래).
 *
 * ## run이 이미 있으면 (조용히 덮어쓰지 않는다)
 *
 * `createOrchestrationRun`은 `run_already_exists`로 던진다. 그때 이 명령은:
 *
 * 1. 기존 run을 열고 **운영자가 지목한 milestone**과 durable `milestoneId`를 대조한다(다르면 거부).
 * 2. **파일의 승인이 그 run에 bind된 승인과 같은가**를 canonical digest(`JSON.stringify(정규화 결과)` —
 *    `codexCliProvider.manifestDigestOf`·`orchestrationStore`의 journal binding과 **같은 등호**)로
 *    대조한다. 다르면 `run_already_exists`다. 승인이 바뀌었으면 그것은 **새 승인**이고 새 run이다 —
 *    돌고 있는 run의 trust root를 파일 교체로 갈아끼우는 통로를 만들지 않는다.
 * 3. 같으면 `materializeTaskDag`에 그대로 넘긴다. **그 함수가 이미 멱등**이다(`C-76` 이어받기:
 *    문서와 정확히 같고 아직 시작되지 않은 task는 다시 만들지 않고 `createdOrder`에도 넣지 않는다).
 *    그 밖의 어긋남은 `dag_materialize_run_not_empty`로 그쪽이 fail closed한다.
 *
 * **기각한 대안** ⓐ `run_already_exists`를 무조건 거부: 부분 물질화(`C-76`)로 멈춘 run을 CLI에서
 * 되살릴 방법이 사라지고, 운영자가 같은 명령을 두 번 쳤을 때 "이미 있다"만 보게 된다. ⓒ 승인 파일을
 * 무시하고 durable 승인으로 계속 진행: 운영자가 고친 파일이 조용히 버려진다 = 이 레포가 금지하는
 * 조용한 fallback.
 *
 * ## 이어받기의 **실제 경계** (M11 적대적 리뷰 A-1이 정정했다)
 *
 * 이 주석은 한때 "ⓑ 기존 run에 문서를 얹어 DAG를 키우기: **물질화 쪽이 이미 거부하는** 새 능력"이라고
 * 적었다. **거짓이었다.** `assertResumableRun`이 요구하는 것은 "기존 task ⊆ 문서 ∧ 각 task가 일치 ∧
 * **attemptNo가 전부 0**"이므로, **아직 시작되지 않은 run은 superset 문서로 task가 늘어난다.**
 * 리뷰어가 실제로 재현했다(2 task run + 3 task 문서 → `createdOrder = ["extra"]`).
 *
 * **경계를 정확히 적는다**:
 * - **시작된 run**(attemptNo > 0)은 **키울 수 없다** — `dag_materialize_run_not_empty`.
 * - **시작 전 run**은 **bind된 승인의 `ownershipByTask` 안에서만** 자란다. 승인 밖 task는 seed 단계에서
 *   `dag_materialize_seed_rejected`로 닫힌다.
 *
 * **권위 발행이 아니다**: 자라는 task도 이미 bind된 승인 범위 안이고, 그 승인은 digest 대조를 먼저
 * 지난다. 그래서 이 성질을 **없애지 않고 정확히 적는다** — 부분 물질화 복구가 사는 자리이기도 하다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OrchestrationError } from "../exec/orchestrationTypes.js";
import { createOrchestrationRun, openOrchestrationRun } from "../exec/orchestrationKernel.js";
import { validateApprovalManifest } from "../exec/approvalManifest.js";
import { materializeTaskDag } from "../exec/taskDagMaterialize.js";
import { validateTaskDag } from "../exec/taskDag.js";
import { MAX_PLAN_JSON_BYTES } from "../exec/offlinePlanWorker.js";
/**
 * 운영자 파일 → JSON. 읽기·크기·파싱 실패는 **그 파일의 계약 위반과 같은 코드**로 닫는다.
 * (새 코드를 만들지 않는다 — "JSON이 아닌 승인 파일"은 `invalid_manifest`의 한 경우다.)
 *
 * 상한은 offline 계획 문서와 같은 `MAX_PLAN_JSON_BYTES`를 재사용한다: 둘 다 "사람이 authoring한
 * bounded JSON 문서"이고, 상한 없이 `readFileSync`를 부르면 파일 크기가 곧 메모리다.
 */
export function readJsonDocument(file, code) {
    const path = resolve(file);
    let bytes;
    try {
        bytes = readFileSync(path);
    }
    catch {
        throw new OrchestrationError(code, `파일을 읽을 수 없다: ${path}`);
    }
    if (bytes.byteLength > MAX_PLAN_JSON_BYTES) {
        throw new OrchestrationError(code, `문서가 ${MAX_PLAN_JSON_BYTES}바이트 상한을 넘는다: ${path}`);
    }
    try {
        return JSON.parse(bytes.toString("utf8"));
    }
    catch {
        throw new OrchestrationError(code, `JSON으로 파싱할 수 없다: ${path}`);
    }
}
/** 기존 run 이어받기 판정(모듈 docstring 참조). 여기서만 `validateApprovalManifest`를 직접 부른다. */
function openBoundRun(workspaceRoot, runId, milestoneId, rawManifest) {
    const kernel = openOrchestrationRun({ workspaceRoot, runId });
    const state = kernel.getState();
    if (state.milestoneId !== milestoneId) {
        throw new OrchestrationError("manifest_milestone_mismatch", `이미 있는 run ${runId}은 milestone ${state.milestoneId}에 bind돼 있다(요청: ${milestoneId})`);
    }
    // canonical digest 등호 — 정규화 결과의 결정론적 JSON. `state.manifest`도 적재 시 같은 검증기를
    // 지났으므로(`orchestrationStore.loadRun`) 키 순서가 같다.
    if (JSON.stringify(validateApprovalManifest(rawManifest)) !== JSON.stringify(state.manifest)) {
        throw new OrchestrationError("run_already_exists", `이미 있는 run ${runId}에 bind된 승인과 이 파일의 승인이 다르다 — 바뀐 승인은 새 run이다`);
    }
    return kernel;
}
/**
 * 승인 파일 + DAG 문서 → orchestration run. 던지는 것은 전부 기존 검증기의 안정 코드다.
 * (CLI 래퍼가 아니라 이 함수가 계약이다 — 테스트·acceptance가 여기에 붙는다.)
 */
export function createAutopilotRun(opts) {
    return createRunFromDocuments({
        workspaceRoot: resolve(opts.workspace ?? process.cwd()),
        runId: opts.run,
        milestoneId: opts.milestone,
        rawManifest: readJsonDocument(opts.approval, "invalid_manifest"),
        rawDag: readJsonDocument(opts.dag, "invalid_dag_document"),
    });
}
/**
 * **파일이 아니라 값에서 run을 만든다** — `createAutopilotRun`(운영자 파일 두 개)과
 * `planDag.createPlanDagRun`(하네스가 구성한 DAG 문서 1장)이 **같은 이 함수**를 지난다.
 *
 * 왜 나눴나: L2a의 plan-dag는 DAG 문서를 **디스크에 쓰지 않고** 메모리에서 만든다. 그때 생성·이어받기·
 * 물질화 규칙을 복사하면 두 진입점의 trust 판정이 갈린다(승인 digest 대조·멱등·부분 물질화 이어받기가
 * 한쪽에만 남는 모양). 읽기만 바깥으로 빼고 **판정은 하나로** 둔다.
 */
export function createRunFromDocuments(args) {
    const { workspaceRoot, runId, milestoneId, rawManifest, rawDag } = args;
    // **DAG를 run 생성 *전에* 검증한다.** `materializeTaskDag`가 어차피 다시 검증하지만(그쪽은 호출자를
    // 신뢰하지 않는다) 그때는 run이 이미 durable에 있다 → 계약을 어긴 문서 하나가 **task 0개인 run**을
    // 남기고, 그 뒤 재시도는 "기존 run 이어받기"로 보인다. 거부는 아무것도 만들지 않아야 한다.
    // 같은 검증기를 부르므로 두 번째 규칙이 생기지 않는다.
    validateTaskDag(rawDag);
    let kernel;
    let created = true;
    try {
        kernel = createOrchestrationRun({ workspaceRoot, runId, milestoneId, manifest: rawManifest });
    }
    catch (err) {
        if (!(err instanceof OrchestrationError) || err.code !== "run_already_exists")
            throw err;
        kernel = openBoundRun(workspaceRoot, runId, milestoneId, rawManifest);
        created = false;
    }
    const materialized = materializeTaskDag(kernel, rawDag);
    const state = kernel.getState();
    return {
        runId: state.runId,
        milestoneId: state.milestoneId,
        created,
        createdOrder: materialized.createdOrder,
        taskCount: materialized.tasks.length,
    };
}
/** `harness autopilot-create` 명령 본체. 거부는 `autopilot`과 같은 exit 2다. */
export function runAutopilotCreateCommand(opts) {
    let result;
    try {
        result = createAutopilotRun(opts);
    }
    catch (err) {
        // 코드를 지어내지 않는다: `OrchestrationError`가 아니면 그것은 이 모듈이 예상한 거부가 아니라
        // 버그이므로 그렇게 적는다(정상 거부처럼 보이게 접으면 그것이 거짓 영수증이다).
        const code = err instanceof OrchestrationError ? err.code : "autopilot_create_internal_error";
        process.stdout.write(`[autopilot-create] 거부: ${code} — ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 2;
        return;
    }
    process.stdout.write(`[autopilot-create] ${result.created ? "run 생성" : "기존 run 이어받기"}: ${result.runId}@${result.milestoneId} · ` +
        `task ${result.taskCount}건 · 이번에 만든 task ${result.createdOrder.length}건${result.createdOrder.length === 0 ? "" : ` (${result.createdOrder.join(",")})`}\n`);
    process.stdout.write(`[autopilot-create] 다음: harness autopilot --run ${result.runId} --milestone ${result.milestoneId} --plan-dir <계획 디렉터리>\n`);
}
