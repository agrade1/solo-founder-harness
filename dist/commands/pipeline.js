/**
 * [B-41] `harness pipeline` — 단계 체크포인트 오케스트레이션의 6개 명령.
 *
 * `status` / `next` / `approve` / `reject` / `restart` / `unlock`.
 *
 * ## 전이 precedence (모든 mutating 명령이 이 순서를 지킨다)
 *
 * ① pipeline_state 읽기+검증(unreadable → exit 2 · **무접촉**) → ② `pipeline.lock` O_EXCL 획득
 * (실패 → exit 2 · 무접촉) → ③ pipeline 상태로 사건 허용 판정 → ④ 필요 시 run_state
 * (**killed 화해 먼저**) → ⑤ 원자 쓰기 1회 → ⑥ lock 해제(finally).
 *
 * `status`와 `unlock`은 **lock 없이** 동작한다: 진행 중 owner의 상태를 못 보면 사람은 owner를 죽이는
 * 것 말고 할 수 있는 일이 없고, 죽은 owner의 lock을 회수하는 명령이 그 lock을 기다리는 것은 교착이다.
 *
 * ## 체크포인트용 `--yes`/`--force`가 없는 이유
 *
 * 이 기능의 존재 이유다. `--yes-internal-gates`는 **workflow 내부** approval step(디자인 게이트 등)만
 * 자동 승인하며, **checkpoint 전이 함수에는 approver·boolean 인자가 아예 없다** — 그래서 그 플래그가
 * 체크포인트에 닿으려면 시그니처를 바꿔야 하고, 컴파일이 월경을 먼저 막는다(의도).
 */
import { closeSync, existsSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PIPELINE, PIPELINE_ID, PIPELINE_LOCK_REL, PIPELINE_STATE_REL, lockPipeline, approvedDigests, buildManifest, checkpointIdFor, currentStage, digestArtifacts, driftProblem, effectiveDigests, newPipelineState, pipelineGateStatus, pipelineStatePath, pipelineWorkflowProblem, readLock, readPipelineStateAt, runStateSources, seedFindingsFrom, writePipelineState, PipelineError, } from "../core/pipeline.js";
import { projectExists, projectPaths } from "../core/project.js";
import { findAgent, findWorkflow, hasKillGate, loadAgentRegistry, loadWorkflows, reevaluationWorkflowIds } from "../core/registry.js";
import { ideaGateStatus, readRunStateAt, readRunState, runWorkflow, snapshotProjectIdea, } from "../core/runWorkflow.js";
import { generateTaskPrompt } from "../core/taskPrompt.js";
import { researchModeLines, researchOutcomeLines, resolveResearchRuntime } from "../core/researchRuntime.js";
import { exportToVault } from "../core/obsidianExport.js";
import { DEFAULT_PROVIDER_ID, getProvider } from "../providers/index.js";
const RUN_STATE_REL = "outputs/run_state.json";
function done(code, exit) {
    if (exit !== 0)
        process.exitCode = exit;
    return { code, exit };
}
/** 거부는 stderr로, 진행은 stdout으로 — 거부 메시지는 **게이트가 만든 문장을 그대로** 낸다. */
function reject(code, message, exit) {
    console.error(`⛔ ${message}`);
    return done(code, exit);
}
function stageLabel(state) {
    const st = currentStage(state);
    return st ? `${state.current_index + 1}/${DEFAULT_PIPELINE.length} '${st.id}'` : `${DEFAULT_PIPELINE.length}/${DEFAULT_PIPELINE.length} (완료)`;
}
/** dev 단계 이후 사람이 직접 치는 명령을 **인쇄만** 한다 — spawn하지 않는다(자동 통로를 만들지 않는다). */
function printCompletedGuidance(project) {
    console.log("");
    console.log("파이프라인 완료 — 다음은 사람이 직접 실행합니다 (하네스가 자동으로 넘기지 않습니다):");
    console.log(`  harness task-prompt --project ${project}`);
    console.log(`  harness handoff --project ${project} --cwd <serviceRepo>`);
}
/**
 * killed 화해 — run_state가 폐기 판정이면 파이프라인도 terminal killed로 내린다.
 * **재실행·재평가를 시도하지 않는다**: 재평가는 사람이 `harness run <kill 게이트 workflow>`로 직접
 * 돌리는 B-40 경로이고, 그 판정이 '진행'이면 잠금이 풀린 뒤 `pipeline restart`로 다시 세운다.
 *
 * kill 영수증의 artifacts는 **있는 파일만** 담는다(`skipMissing`): 폐기 기록을 남기는 것이 파일 존재
 * 여부보다 중요하고, 이 영수증으로는 아무 소비자도 열리지 않는다(§3.3의 빈 배열 예외가 여기 하나다).
 */
function reconcileKilled(projectRoot, state, stage, rs, at) {
    const { artifacts, seeds } = buildManifest(projectRoot, runStateSources(rs), { skipMissing: true });
    const base = {
        stage: stage.id,
        workflow_id: stage.kind === "workflow" ? stage.workflowId : null,
        run_finished_at: rs.finished_at ?? null,
        artifacts,
        seeds,
    };
    const receipt = {
        ...base,
        checkpoint_id: checkpointIdFor(base),
        decision: "killed",
        decided_at: at,
        note: `${rs.killed_by?.decider ?? "(게이트)"}가 '${rs.killed_by?.decision ?? "폐기"}' 판정`,
    };
    return { ...state, status: "killed", pending: null, last_failure: null, checkpoints: [...state.checkpoints, receipt], updated_at: at };
}
// ── status (lock 불요 · read-only) ──────────────────────────────
export function statusPipeline(o) {
    const root = projectPaths(o.project).root;
    const read = readPipelineStateAt(pipelineStatePath(root));
    const lock = readLock(root);
    if (read.kind === "unreadable") {
        // 게이트가 만든 같은 문장을 쓴다 (같은 상황 = 같은 안내).
        const gate = pipelineGateStatus(read, root, "run");
        return reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2);
    }
    if (lock) {
        console.log(`lock: pid ${lock.pid} 보유 (획득 ${lock.at}) — mutating 명령은 거부됩니다 (status는 읽힙니다)`);
    }
    if (read.kind === "absent") {
        console.log(`파이프라인 없음 (${o.project}) — 'harness pipeline next --project ${o.project}'로 시작하세요.`);
        console.log(`단계: ${DEFAULT_PIPELINE.map((s) => s.id).join(" → ")}`);
        return done("pipeline_absent", 0);
    }
    const st = read.state;
    console.log(`파이프라인 ${PIPELINE_ID} · 프로젝트 ${st.project} · 상태 ${st.status} · 단계 ${stageLabel(st)}`);
    for (const [i, stage] of DEFAULT_PIPELINE.entries()) {
        const last = [...st.checkpoints].reverse().find((c) => c.stage === stage.id);
        const mark = i < st.current_index ? "✔" : i === st.current_index ? "▶" : "·";
        const note = last ? ` (마지막 판정: ${last.decision} @ ${last.decided_at})` : "";
        console.log(`  ${mark} ${stage.id}${note}`);
    }
    if (st.status === "awaiting_approval" && st.pending) {
        console.log("");
        console.log(`확인 대기: '${st.pending.stage}' · checkpoint ${st.pending.checkpoint_id}`);
        for (const a of st.pending.artifacts)
            console.log(`  - ${a.path} (${a.size}B · ${a.sha256.slice(0, 12)}…)`);
        console.log(`승인: harness pipeline approve ${st.pending.stage} --checkpoint ${st.pending.checkpoint_id} --project ${st.project}`);
        console.log(`되돌림: harness pipeline reject ${st.pending.stage} --checkpoint ${st.pending.checkpoint_id} --project ${st.project} [--note <이유>]`);
    }
    else if (st.status === "awaiting_run") {
        if (st.last_failure) {
            // [B-53] `written`은 이 단계의 attempt들에 걸친 **누적**이므로 "직전 실패가 덮은"이 아니다.
            console.log(`직전 실패: '${st.last_failure.stage}' @ ${st.last_failure.at} (이 단계에서 덮인 파일 ${st.last_failure.written.length}개)\n` +
                `  [A-4] next는 run_state가 이 workflow의 failed일 때만 resume하고, 그렇지 않으면 **fresh로 다시 돌린다** ` +
                `(실행 중 크래시는 run_state를 남기지 못한다). 어느 쪽이든 이 영수증이 덮인 경로의 정본이라 drift로 막히지 않는다.`);
        }
        console.log(`다음: harness pipeline next --project ${st.project}${st.provider ? ` --provider ${st.provider}` : ""}`);
    }
    else if (st.status === "killed") {
        console.log("");
        console.log("폐기 판정으로 종료된 파이프라인입니다 — 지시문·DAG·handoff는 만들지 않습니다.");
        console.log(`재평가: harness run <kill 게이트 workflow> --project ${st.project} (게이트가 '진행'을 내면 잠금이 풀립니다)`);
        // [A-3] 2단계 이상 폐기면 restart가 먼저 오면 거부된다 — 순서를 문장에 넣는다.
        console.log(`다시 세우기: **먼저** 재평가로 '진행' 판정을 받고(harness run <${reevaluationWorkflowIds().join(" | ")}> --project ${st.project}), ` +
            `**그다음** harness pipeline restart --project ${st.project} (기존 state는 지우지 않고 rename 보관)`);
    }
    else {
        // [B-41/결정 2] 완료 상태에서도 **하류가 막혀 있으면 그 사실을 먼저 말한다.** 예전 status는
        // drift가 있어도 "완료 — 직접 실행하세요"만 출력했다(오케스트레이터 스모크에서 실측).
        const gate = pipelineGateStatus(read, root, "handoff");
        if (!gate.ok) {
            console.log("");
            console.log(`⚠ 하류가 막혀 있습니다 — ${gate.message}`);
        }
        else {
            printCompletedGuidance(st.project);
        }
    }
    // [표시 전용] 화해되지 않은 killed run도 사실대로 적는다 — **여기서 아무것도 쓰지 않는다**(status는 read-only).
    if (st.status !== "killed") {
        const rs = readRunStateAt(join(root, RUN_STATE_REL));
        if (rs.kind === "ok" && rs.state.status === "killed") {
            console.log("");
            console.log("주의: run_state가 폐기(killed) 판정입니다 — 다음 'pipeline next'에서 파이프라인이 killed로 화해됩니다 (지금 아무것도 쓰지 않았습니다).");
        }
    }
    return done("pipeline_status", 0);
}
export async function nextPipeline(o) {
    const now = o.now ?? (() => new Date().toISOString());
    const project = o.project;
    const root = projectPaths(project).root;
    if (!projectExists(project)) {
        return reject("project_missing", `프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`, 1);
    }
    // ① 읽기 + 검증 (무접촉)
    const read = readPipelineStateAt(pipelineStatePath(root));
    if (read.kind === "unreadable") {
        // 거부 문장은 공용 게이트가 만든 것을 그대로 쓴다 (같은 상황 = 같은 안내).
        const gate = pipelineGateStatus(read, root, "run");
        return reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2);
    }
    // 파이프라인이 가리키는 workflow가 registry에 실제로 있는지 — 첫 모델 호출·state 생성 전에 본다.
    const wfProblem = pipelineWorkflowProblem(loadWorkflows().map((w) => w.workflow_id));
    if (wfProblem)
        return reject("pipeline_stage_workflow_missing", wfProblem, 2);
    // ② lock (mutating). [A-3] nonce는 이 경계 밖으로 나가지 않는다 — lease는 locked.runStage가 발행한다.
    const lock = lockPipeline(root, now);
    if (!lock.ok)
        return reject("pipeline_locked", lock.message, 2);
    const locked = lock.locked;
    try {
        // [Codex A-7] lock 획득 **직후 재독·재검증**한 snapshot만 mutation에 쓴다(lockPipeline이 그 read를
        // 들고 온다). ①의 read는 lock 밖에서 찍힌 것이라, 그 사이 다른 프로세스가 전이를 끝냈으면
        // stale snapshot으로 덮어쓴다(승인 하나가 조용히 사라지는 부류다).
        if (locked.read.kind === "unreadable") {
            const gate = pipelineGateStatus(locked.read, root, "run");
            return reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2);
        }
        return await nextLocked(o, { project, root, now, read: locked.read, locked });
    }
    finally {
        locked.release();
    }
}
async function nextLocked(o, 
// read는 nextPipeline이 unreadable을 이미 걸러낸 뒤의 것이다 (타입으로 그 사실을 들고 온다).
ctx) {
    const { project, root, now, locked } = ctx;
    let state;
    if (ctx.read.kind === "absent") {
        // 파이프라인 시작 전에 **폐기 잠금**(B-40)을 본다: 죽은 아이디어로 파이프라인을 세우지 않는다.
        // 거부면 **아무것도 만들지 않는다**(무생성·무접촉).
        const first = DEFAULT_PIPELINE[0];
        const wf = first.kind === "workflow" ? findWorkflow(loadWorkflows(), first.workflowId) : undefined;
        const ideaGate = ideaGateStatus(readRunState(project), snapshotProjectIdea(project), wf ? hasKillGate(wf) : false);
        if (!ideaGate.ok)
            return reject(ideaGate.code, ideaGate.message, 2);
        // [Codex A-10] run_state가 이미 폐기 판정이면 **파이프라인을 만들지 않는다.**
        // 예전엔 만들고 나서 곧바로 화해로 죽였고(write 2회), 더 나쁘게 그 kill 영수증은 "현재 단계"를
        // 적어서 **거짓말**을 했다: 파이프라인 밖에서 mvp-planning이 폐기됐는데 영수증은
        // "idea-validation이 폐기됐다"고 증언했다. 폐기를 푸는 것은 사람이 직접 돌리는 재평가 run이므로
        // 여기서 만들 것이 없다.
        const rsBefore = readRunStateAt(join(root, RUN_STATE_REL));
        if (rsBefore.kind === "ok" && rsBefore.state.status === "killed") {
            const k = rsBefore.state.killed_by;
            return reject("run_state_killed", `이 프로젝트의 마지막 run이 폐기 판정입니다 (workflow '${rsBefore.state.workflow_id}' · ` +
                `${k?.decider ?? "게이트"}가 '${k?.decision ?? "폐기"}') — 파이프라인을 만들지 않았습니다.\n` +
                `먼저 재평가를 직접 돌려 '진행' 판정을 받으세요: harness run <kill 게이트 workflow> --project ${project}`, 2);
        }
        // [B-57] 이 파이프라인이 쓸 provider를 **처음 만들 때 새긴다** — 이후 단계는 이것을 승계한다.
        state = newPipelineState(project, now(), o.provider);
        writePipelineState(root, state); // 전이: 파이프라인 생성 (원자 쓰기 1회)
        console.log(`파이프라인 시작: ${PIPELINE_ID} · ${DEFAULT_PIPELINE.map((s) => s.id).join(" → ")}`);
    }
    else {
        state = ctx.read.state;
    }
    // ③ 사건 허용 판정
    if (state.status === "killed") {
        return reject("pipeline_killed", `이 파이프라인은 폐기 판정으로 종료됐습니다 — next로 전진하지 않습니다.\n` +
            `[A-3] 순서: **먼저** 재평가 harness run <kill 게이트 workflow> --project ${project} → '진행' 판정 → ` +
            `**그다음** harness pipeline restart --project ${project} (순서를 바꾸면 restart가 run_state_killed로 거부된다)`, 1);
    }
    if (state.status === "completed") {
        console.log(`파이프라인이 이미 완료됐습니다 (${DEFAULT_PIPELINE.length}단계 전부 승인) — 전진할 것이 없습니다.`);
        printCompletedGuidance(project);
        return done("pipeline_completed", 0);
    }
    if (state.status === "awaiting_approval" && state.pending) {
        // **전진 없음**: 확인 대기 중의 next는 안내를 다시 낸다(승인을 대신하지 않는다).
        console.log(`'${state.pending.stage}' 단계 산출물이 확인 대기 중입니다 — 전진하지 않았습니다.`);
        for (const a of state.pending.artifacts)
            console.log(`  - ${a.path} (${a.size}B · ${a.sha256.slice(0, 12)}…)`);
        console.log(`승인: harness pipeline approve ${state.pending.stage} --checkpoint ${state.pending.checkpoint_id} --project ${project}`);
        console.log(`되돌림: harness pipeline reject ${state.pending.stage} --checkpoint ${state.pending.checkpoint_id} --project ${project} [--note <이유>]`);
        return done("pipeline_checkpoint_pending", 0);
    }
    const stage = currentStage(state);
    if (!stage)
        return reject("pipeline_stage_out_of_range", `current_index가 단계 범위를 벗어났습니다 (${state.current_index})`, 2);
    // ④ run_state 첫 접점 — killed 화해가 **먼저**다.
    const rsRead = readRunStateAt(join(root, RUN_STATE_REL));
    if (rsRead.kind === "unreadable") {
        return reject("run_state_unreadable", `run_state.json이 있지만 읽을 수 없습니다: ${rsRead.path} (${rsRead.detail}).\n폐기 기록이 이 파일에 있을 수 있어 덮어쓰지 않습니다 — 파일을 복원하거나 검토 후 지우세요.`, 2);
    }
    if (rsRead.kind === "ok" && rsRead.state.status === "killed") {
        // [Codex A-10] **provenance 대조**: 그 폐기가 **이 단계의 workflow**에서 나온 것일 때만
        // 현 단계 영수증으로 기록한다. 다른 workflow가 죽은 것을 현 단계 이름으로 적으면 영수증이
        // 거짓말을 한다(그리고 그 거짓 영수증이 checkpoint 이력의 정본이 된다).
        const rsWf = rsRead.state.workflow_id;
        if (stage.kind !== "workflow" || rsWf !== stage.workflowId) {
            return reject("pipeline_killed_elsewhere", `run_state가 폐기 판정인데 그 workflow('${rsWf}')는 현 단계('${stage.id}')가 아닙니다 — ` +
                `현 단계 영수증으로 적으면 거짓 기록이 되므로 아무것도 쓰지 않았습니다.\n` +
                `[A-3] **이 상태에서는 안내할 수 있는 명령이 없습니다** — 실측으로 확인했습니다: ` +
                // guidance-exempt: 실행 지시가 아니라 **거부되는 명령을 설명**한다 (인용된 명령을 권하지 않는다)
                `\`harness run\`은 파이프라인이 이 run을 예약해 거부되고(pipeline_run_reserved), ` +
                `\`restart\`는 pipeline_active로, approve/reject는 pending 부재로 거부됩니다.\n` +
                `확인된 생성 경로는 "2단계 이상 폐기 → pipeline restart" 하나이고 그 경로는 이제 restart가 막습니다 ` +
                `(다른 경로가 있는지는 전수로 확인하지 않았습니다).\n` +
                `이미 이 상태라면 outputs/run_state.json(폐기 기록)을 **검토한 뒤 옮기면** 파이프라인이 1단계부터 다시 섭니다 ` +
                `— 실측으로 확인한 유일한 탈출구이고, 폐기 판정을 지우는 일이라 사람이 직접 판단할 몫이라 명령으로 만들지 않았습니다.`, 1);
        }
        const next = reconcileKilled(root, state, stage, rsRead.state, now());
        writePipelineState(root, next);
        console.log(`⛔ 폐기 판정을 파이프라인에 반영했습니다 (killed) — ${next.checkpoints.at(-1)?.note}. 후속 단계는 실행하지 않았습니다.`);
        console.log(`재평가는 사람이 직접: harness run <kill 게이트 workflow> --project ${project}`);
        return done("pipeline_killed_reconciled", 0);
    }
    // resume 판정 — 영수증(`last_failure`)이 있을 때만이다. 없으면 fresh로 강하한다(§4.3).
    const rs = rsRead.kind === "ok" ? rsRead.state : null;
    const resume = stage.kind === "workflow" &&
        rs !== null &&
        rs.status === "failed" &&
        rs.workflow_id === stage.workflowId &&
        state.last_failure !== null &&
        state.last_failure.stage === stage.id;
    // 승인 바이트 사전 검증. 예외는 `last_failure.written` digest뿐이고 **경로별 교체**다 — 아래 [B-52].
    //
    // [A-4] 예외를 **`resume`이 아니라 영수증의 단계**에 건다. 예전엔 `resume &&`가 앞에 붙어 있었는데,
    // `resume`은 `run_state.status === "failed"`까지 요구한다(위 판정). 실행 **중**의 크래시는 run_state를
    // 남기지 못하므로(runWorkflow가 끝나야 쓴다) 그 뒤의 `next`는 fresh로 강하하고, 그러면 이 단계가
    // 방금 덮은 경로까지 앞 단계 승인 바이트로 판정돼 `pipeline_artifact_drift`가 된다 — fresh 재실행이
    // 어차피 그 경로를 다시 덮을 것인데도. 영수증이 "이 단계가 이 바이트를 썼다"고 말하면 그 사실은
    // resume 여부와 무관하게 참이다.
    //
    // **약화가 아니다**(B-52 규칙 그대로): 예외로 들어오는 것은 **이 단계가 실제로 쓴 바이트 하나**이고
    // 아래 `accept = w ? [w] : [approved]`가 여전히 교체다. 앞 단계 승인 바이트를 되돌려 놓으면
    // `w`와 달라 그대로 거부된다(replay 문구). 넓어지는 것은 "판정 대상 경로"가 아니라 "정본을 아는 경로"다.
    const stageWrote = state.last_failure?.stage === stage.id ? state.last_failure.written : [];
    const written = new Map(stageWrote.map((w) => [w.path, w]));
    for (const approved of approvedDigests(state).values()) {
        const w = written.get(approved.path);
        // [B-52] 예외는 **교체이지 추가가 아니다.** 이 단계의 실패 attempt가 덮은 경로는 그 attempt가
        // 쓴 바이트만이 정본이고, 앞 단계의 승인 바이트는 그 경로의 **다른 단계 산출물**이다.
        //
        // 예전 판은 `accept = [approved, written]`(OR)이라 앞 단계 승인본을 되돌려 놓으면 통과했다.
        // `docs/06_CEO_DECISION.md`는 1·2단계가 **같은 경로에 다시 쓰므로**(registry: founder_ceo의
        // default_output이 하나) 2단계 게이트 실패 후 1단계 승인본을 복원하면 drift를 통과하고,
        // resume한 runWorkflow가 그 문서를 재실행 없이 `lastMarkdown`으로 복원해
        // **1단계의 '진행'이 2단계 판정으로 채택됐다** — 모델 호출 0회로 run이 completed가 되고
        // B-40 폐기 잠금 해제(`cleared_idea_sha256`)까지 발급됐다(2026-08-30 실측 재현).
        //
        // 게이트에서 막지 않는 이유: 사람이 "## Decision"을 고쳐 재개하는 것은 이미 계약이라
        // (runWorkflow.ts의 ceo_decision_absent 주석) 게이트가 보는 신호 — 문서 바이트 · restoredIds ·
        // 실패 사유 — 가 정당한 편집과 앞 단계 재생에서 **전부 동일**하다. 바이트로 저자를 증명할 수
        // 없으므로 권한 경계는 게이트가 아니라 **승인 바이트 perimeter**인 여기다. (설계 §2.2)
        //
        // 1단계는 approvedDigests가 비어 이 루프가 0회 돈다 — 사람이 판정을 고쳐 재개하는 레버는
        // 그 자리에 그대로 살아 있다(B-49 설계 보완 ③).
        const accept = w ? [w] : [approved];
        if (!accept.some((a) => driftProblem(root, [a]) === null)) {
            // 같은 사유 코드 안에서 **원인별로 다른 문장**을 낸다: B-52 케이스는 "승인 시점 바이트와
            // 다르다"가 아니라 오히려 **같아서** 거부되므로, 기존 문구를 그대로 내면 진단이 불가능하다.
            const replay = w !== undefined && driftProblem(root, [approved]) === null;
            return reject("pipeline_artifact_drift", replay
                ? `이 단계가 덮어쓴 산출물이 **앞 단계 승인본 바이트로 되돌아가 있습니다**: ${approved.path}\n` +
                    `앞 단계의 판단을 현 단계 판단으로 재사용하게 되므로 **모델을 호출하지 않고** 멈춥니다.\n` +
                    `  ⓐ 이 단계의 실행이 남긴 내용으로 되돌리면 이어집니다 (그 digest가 영수증에 있습니다).\n` +
                    `  ⓑ [B-58] 예전 안내가 함께 제시하던 "폐기 판정 또는 'harness pipeline reject'로 종결"은 ` +
                    `**이 상태에서 둘 다 도달할 수 없습니다** — 폐기 판정은 게이트까지 가야 하는데 이 검사가 그 앞에서 막고, ` +
                    `reject는 확인 대기 산출물이 없어 'pipeline_no_pending'입니다. 실행해 확인했고, 그래서 더는 권하지 않습니다.\n` +
                    `  이 단계의 바이트를 갖고 있지 않다면 나갈 길이 없습니다 — 대장 \`B-54\`의 잔여분입니다.`
                : `승인된 산출물이 승인 시점 바이트와 다릅니다: ${approved.path}\n` +
                    `사람이 확인한 내용이 아니므로 **모델을 호출하지 않고** 멈춥니다.\n` +
                    `  ⓐ 그 파일을 승인 시점 내용으로 되돌리면 이 명령이 이어집니다 — **다만 하네스는 내용을 ` +
                    `보관하지 않습니다**(영수증은 path·size·sha256뿐). git·백업 등 바깥에서 되돌려야 합니다.\n` +
                    `  ⓑ [B-54] 예전 안내가 함께 제시하던 'harness pipeline restart'는 **이 상태에서 거부됩니다** ` +
                    `(진행 중 파이프라인 · pipeline_active) — 실행해 확인했고, 그래서 더는 권하지 않습니다.\n` +
                    `  바이트를 어디에도 갖고 있지 않다면 이 단계에서 나갈 길은 없습니다 — 대장 \`B-54\`의 잔여분입니다.`, 1);
        }
    }
    // ── dev-handoff: workflow가 아니라 지시문 생성 단계 ──
    //
    // **알려진 한계(구현 중 실측으로 발견 — 다음 사람이 닫힌 것으로 믿지 않게 적는다):**
    // 이 단계의 승인 대상은 `outputs/claude_code_task_prompt.md`인데, 완료 후 `harness task-prompt`나
    // `harness handoff`가 **같은 파일을 다시 생성한다**(본문에 생성 날짜가 박힌다). 그래서 승인한 날과
    // 다른 날에 그 명령을 돌리면 파일 바이트가 바뀌어, 그 다음 `task-prompt`/`handoff`/`plan-dag`가
    // `pipeline_artifact_drift`로 거부된다. 탈출구는 `pipeline restart`(전 단계 재실행)뿐이다.
    // 방향은 fail closed이므로 안전 결함은 아니지만 **사용성 결함이고 아직 닫히지 않았다**.
    // 여기서 재작성 경로를 검증에서 빼는 것은 설계 §9-6이 명시적으로 기각한 방향이라(공유 산출 경로
    // 바꿔치기 사각) 임의로 도입하지 않았다 — 결정이 필요한 항목으로 보고했다.
    if (stage.kind === "task_prompt") {
        let rel;
        try {
            rel = generateTaskPrompt(project, now().slice(0, 10));
        }
        catch (err) {
            return reject("pipeline_task_prompt_failed", `지시문 생성 실패 — 파이프라인 상태는 그대로입니다: ${err.message}`, 1);
        }
        // seeds는 담지 않는다: 작업 지시문은 판단 문서가 아니고(Main Judgment 절이 없다) 뒤 단계도 없다.
        const base = { stage: stage.id, workflow_id: null, run_finished_at: now(), artifacts: digestArtifacts(root, [rel]), seeds: [] };
        return commitPending(root, state, base, now(), project);
    }
    // ── workflow 단계 ──
    // [B-57] **provider 승계.** 우선순위: 테스트 seam > 이번 호출의 --provider > 이 파이프라인에 새겨진 값 > 기본값.
    // 예전엔 저장된 값이 없어서 `--provider`를 안 붙인 next가 곧바로 mock으로 떨어졌고, 안내 6곳 전부가
    // 그 플래그를 빼고 인쇄했다 — 사람이 안내를 따르는 것 자체가 강등 경로였다.
    const providerId = o.provider ?? state.provider ?? DEFAULT_PROVIDER_ID;
    const provider = o.providerOverride ?? getProvider(providerId);
    if (state.provider !== providerId) {
        // 전환은 정당하다(mock으로 리허설하고 실제로 돌리는 흐름). **조용한** 전환만 막는다.
        if (state.provider !== undefined) {
            console.log(`provider 변경: '${state.provider}' → '${providerId}' (이 파이프라인에 새로 새깁니다)`);
        }
        state = { ...state, provider: providerId, updated_at: now() };
        writePipelineState(root, state);
    }
    // [C-126/A-1] **파이프라인이 리서치 어댑터의 1급 소비자다.** 여기서 해석하지 않으면 `run.ts`를
    // 거치지 않는 이 경로(→ locked.runStage → runWorkflow)에서 1단계는 항상 self가 된다.
    const researchRuntime = o.researchRuntimeOverride ?? resolveResearchRuntime();
    const seeds = seedFindingsFrom(state);
    console.log(`단계 실행: ${stageLabel(state)} · workflow '${stage.workflowId}' · provider ${provider.id}` +
        `${resume ? " · resume" : ""}${seeds.length ? ` · 승인 판단 seed ${seeds.length}건` : ""}`);
    for (const line of researchModeLines(researchRuntime))
        console.log(line);
    let result;
    try {
        // [Codex A-3] 실행은 **lock을 쥔 연산의 runStage 안에서만** 일어난다: lease는 그 호출 동안만
        // 발행되고(현 단계 workflow + awaiting_run일 때만) 끝나면 만료된다. 임의 호출자가 nonce를
        // 읽어 lease를 만들 길이 없다 — 그것이 예전 판의 구멍이었다.
        result = await locked.runStage(stage.workflowId, (lease) => runWorkflow({
            // [A-4] 산출물을 저장할 때마다 영수증을 **즉시** durable에 남긴다 — 여기서 죽어도
            // "이 단계가 이 경로를 덮었다"가 남아야 다음 next가 탈출구를 갖는다(위 사전 검증의 예외).
            // lock을 쥔 채 도는 구간이라 다른 writer와 경합하지 않는다. 매번 재독·병합하는 이유는
            // 같은 경로를 다시 쓰면(게이트 되돌림 등) **가장 최근 바이트가 정본**이어야 하기 때문이다.
            onArtifactSaved: (rel) => recordStageWrite(root, stage.id, stage.workflowId, rel, now),
            workflowId: stage.workflowId,
            project,
            provider,
            resume,
            maxTokens: o.maxTokens ?? 0,
            approve: o.internalApprover,
            reporter: o.reporter,
            now: o.now,
            // seed는 **durable 저장본**에서만 온다 — 여기서 문서 파일을 다시 읽지 않는다(§5).
            seedFindings: seeds.length > 0 ? seeds : undefined,
            pipelineLease: lease,
            research: researchRuntime,
        }));
    }
    catch (err) {
        // run_state가 만들어지지 않는 경로(잠금·approver 부재·profile 거부 등) — 파이프라인 상태 불변.
        // [A-4] "상태 불변"은 **산출물을 하나도 저장하기 전**에만 참이다. runWorkflow는 step 루프 전체를
        // try로 감싸 provider 오류를 failed 결과로 접으므로 여기 오는 것은 preflight 실패뿐이고(잠금·
        // approver 부재·profile 거부) 그때는 저장이 0건이라 영수증도 0건이다 — 그 전제를 문장에 적어 둔다.
        return reject("pipeline_run_not_started", `단계 '${stage.id}' 실행이 시작되지 않았습니다 (산출물 저장 전이라 파이프라인 상태 불변): ${err.message}`, 1);
    }
    // [Codex A-5] vault export는 **아래 전이(pending/killed/failed 기록)가 끝난 뒤**에 한다:
    // 여기서 내보내면 "run completed"만 적힌 노트가 나오고, 그 시점에 파이프라인은 아직 확인 대기
    // 기록을 갖지 못한다 → vault만 보는 사람에게 거짓 완료 영수증이다. try/finally로 모든 종료
    // 경로(정상·거부)에서 한 번만 내보낸다.
    // [C-126/A-6] 실제 mode 영수증은 run이 끝난 **뒤에만** 낼 수 있다 (사전 문구는 "설정됨"까지다).
    for (const line of researchOutcomeLines(result.state.research?.attempts, result.state.research?.carried_attempts ?? 0))
        console.log(line);
    try {
        if (result.state.status === "killed") {
            const next = reconcileKilled(root, state, stage, result.state, now());
            writePipelineState(root, next);
            console.log(`⛔ 폐기 판정 — 파이프라인 종료(killed): ${next.checkpoints.at(-1)?.note}. 후속 단계는 실행하지 않았습니다.`);
            return done("pipeline_killed_reconciled", 0);
        }
        return commitAfterRun(o, { project, root, now, state, stage, result, research: researchRuntime });
    }
    finally {
        exportVault(o, root, result.state);
    }
}
/**
 * [A-4] 산출물 하나가 저장된 **직후** 영수증에 등재한다 (실행 중 · lock 보유 중).
 *
 * `commitAfterRun`의 병합 규칙과 **같다**: 단계가 같으면 이어 붙이고, 같은 경로는 최신 digest가
 * 이긴다. 다른 것은 시점 하나뿐이다 — 그 하나가 "크래시하면 영수증이 없다"와 "있다"를 가른다.
 *
 * state를 매번 재독하는 이유: 이 콜백은 run 도중 여러 번 불리고, 그 사이 `commitAfterRun`이 아직
 * 돌지 않았어도 앞선 콜백이 이미 파일을 갱신했다. 메모리 snapshot을 들고 있으면 앞의 등재를 덮는다.
 * 실패는 삼킨다 — 영수증 등재가 run 자체를 죽이면 그것이 더 큰 손해다(산출물은 이미 디스크에 있다).
 */
function recordStageWrite(root, stageId, workflowId, rel, now) {
    try {
        const read = readPipelineStateAt(pipelineStatePath(root));
        if (read.kind !== "ok")
            return;
        const st = read.state;
        const carry = st.last_failure?.stage === stageId ? st.last_failure.written : [];
        const merged = new Map(carry.map((w) => [w.path, w]));
        for (const w of digestArtifacts(root, [rel], { skipMissing: true }))
            merged.set(w.path, w);
        if (merged.size === 0)
            return;
        writePipelineState(root, {
            ...st,
            last_failure: { stage: stageId, workflow_id: workflowId, at: now(), written: [...merged.values()] },
            updated_at: now(),
        });
    }
    catch {
        // 영수증을 못 남겨도 run은 계속한다 — 이 경로가 없던 예전 동작으로 강하할 뿐이다.
    }
}
/** run 결과를 파이프라인 상태에 반영한다 (failed → last_failure · completed → pending). */
function commitAfterRun(o, ctx) {
    const { project, root, now, state, stage, result } = ctx;
    if (result.state.status === "failed") {
        // 실패 attempt가 **정당하게 덮은** 파일의 digest를 영수증에 남긴다 — resume의 예외는 이것에만 결박된다.
        // [C-126/A-4] `savedFiles`에는 리서치 receipt와 저장된 raw도 들어 있다(partial 포함) — 그래서
        // 중간에 죽어도 "무엇이 덮였나"가 사실대로 남고, resume 사전 drift 검증이 그것을 손댄 것으로
        // 오해하지 않는다.
        //
        // [B-53] **이 단계의 attempt들에 걸쳐 누적한다** (경로 합집합 · 새 digest가 이긴다).
        // 예전 판은 실패마다 통째로 덮었는데, `savedFiles`는 **그 attempt가 쓴 것만** 담는다:
        //  ⓐ 2번째 실패가 게이트에서 나면 agent가 하나도 안 돌아 `savedFiles`가 비고 `written`이 `[]`가 된다.
        //  ⓑ resume은 완료 step을 재실행하지 않으므로, 앞 attempt가 덮은 경로는 뒤 attempt의 `savedFiles`에 없다.
        // 어느 쪽이든 3번째 `next`의 사전 검증이 그 경로를 `[approved(앞 단계)]`로만 판정해
        // `pipeline_artifact_drift`로 거부한다 — 그리고 `awaiting_run`에서는 restart도 reject도 막혀 있어
        // **탈출구가 하나도 없다**(2026-09-01 실측: ⓐⓑ 둘 다 재현 · restart=pipeline_active · reject=pipeline_no_pending).
        //
        // 합집합이 검사를 넓히지 않는 이유: 이번 attempt가 **쓴** 경로는 새 digest가 앞 것을 덮으므로
        // (`merged.set`) 그 경로의 정본은 여전히 **가장 최근에 그 경로를 쓴 attempt의 바이트 하나**다.
        // 늘어나는 것은 "이번 attempt가 건드리지 않은, 앞 attempt가 쓴 경로"뿐이고 그 정본도 하나다.
        // 그래서 [B-52]의 교체 규칙(`accept = w ? [w] : [approved]`)이 그대로 성립한다 — 합집합 어디에도
        // **앞 단계 승인 바이트**는 들어오지 않는다(이 단계가 실제로 쓴 바이트만 들어온다).
        const at = now();
        // 단계가 바뀌면 리셋한다. 실제로는 승인·폐기가 `last_failure`를 null로 내리고
        // `replayProblem`(core/pipeline.ts)이 단계 불일치 state를 아예 unreadable로 막으므로 이 조건이
        // 거짓이 되는 경로는 현재 없다 — **불변식이 다른 파일에 있어서** 여기 한 번 더 적는다.
        // (`workflow_id`는 `stage.id`의 함수라 따로 대조하지 않는다.)
        const carry = state.last_failure?.stage === stage.id ? state.last_failure.written : [];
        const merged = new Map(carry.map((w) => [w.path, w]));
        for (const w of digestArtifacts(root, result.savedFiles, { skipMissing: true }))
            merged.set(w.path, w);
        const next = {
            ...state,
            last_failure: {
                stage: stage.id,
                workflow_id: stage.workflowId,
                at,
                written: [...merged.values()],
            },
            updated_at: at,
        };
        writePipelineState(root, next);
        const reason = result.state.failed_reason ?? "사유 미기록";
        console.error(`단계 '${stage.id}' 실행이 중단됐습니다 (${reason}) — 상태는 실행 대기(awaiting_run) 그대로입니다.\n` +
            `고친 뒤 다시: harness pipeline next --project ${project} (같은 workflow를 resume합니다)`);
        // [C-126/A-5] 리서치 실패는 **복구 경로가 정확히 둘**이다. `awaiting_run`에서는 restart가 거부되고
        // pending이 없어 reject도 불가하므로, 이 둘 말고는 탈출구가 없다 — 그래서 여기 적는다.
        // 실패한 external attempt는 **지우지 않는다**(영수증으로 남는다).
        if (reason.startsWith("research_")) {
            // [C-138/④] **사유별로 갈린다.** `research_cap_exceeded`에서 예전 ⓐ("원인을 고친 뒤 resume")는
            // 증명 가능하게 거짓이었다: 원인은 키·네트워크·크레딧 어느 것도 아니고, resume은 소진된 예산을
            // `priorResults`로 그대로 이어받아 **반드시 같은 지점에서 다시 막힌다**(2026-08-27 live 실측).
            // restart도 탈출구가 아니다 — `restartPipeline`은 awaiting_run을 `pipeline_active`로 거부한다.
            // 그래서 이 사유에서는 실제로 남은 경로가 ⓑ 하나이고, 그렇게 적는다.
            const capExhausted = reason === "research_cap_exceeded";
            console.error((capExhausted ? `리서치 복구 경로 (ⓐ는 막혔습니다 — 남은 것은 ⓑ 하나):\n` : `리서치 복구 경로 두 개:\n`) +
                (capExhausted
                    ? `  ⓐ 이 run의 리서치 예산이 소진됐습니다 — 같은 명령으로 resume하면 **같은 지점에서 다시 막힙니다**(소진된 예산을 그대로 이어받습니다). restart도 진행 중 파이프라인에서는 거부됩니다.\n`
                    : `  ⓐ 원인(키 오류·네트워크·크레딧)을 고친 뒤: harness pipeline next --project ${project}\n`) +
                `  ⓑ 외부 검색 없이 진행: 셸의 TAVILY_API_KEY를 unset하고 ${ctx.research.kind === "self" ? ctx.research.envPath : "workspace 루트의 .env"}의 값을 비운 뒤 같은 명령 — 키 부재는 **승인된 자체 리서치(self) fallback**입니다.\n` +
                `  (실패한 external attempt는 삭제하지 않고 outputs/research/의 영수증에 남습니다.)`);
        }
        // [B-50] '검증'은 오류가 아니라 **사람이 확인할 차례**다 — 무차별 "고친 뒤 다시" 안내로는
        // "무엇을 고치라는 것인지"가 전달되지 않는다(고칠 것은 코드도 키도 아니고 사람의 확인 결과다).
        //
        // **아래 문장은 전부 코드로 확인한 실동작만 적는다**(C-138/④ 규율 — 이 레포는 거짓 복구 안내를
        // 두 번 냈다): 위에서 방금 쓴 `last_failure`가 resume 조건을 만족시키고(:353-359 계열),
        // 사전 drift 검증은 **승인된 digest**만 결박하므로 decider 문서가 아직 승인 manifest에 없으면
        // 사람의 수정이 통과하며, 게이트 인덱스부터의 resume은 복원 문서를 읽어 재판정한다(모델 호출 0회 ·
        // 영수증 `decision_source: "restored_artifact"`).
        //
        // **decider 문서가 이미 승인 manifest에 있으면 그 약속이 거짓이 된다**(수정이 `pipeline_artifact_drift`로
        // 막힌다) — 그 경우엔 이 안내를 내지 않는다. 그쪽 경로(앞 단계 승인 이후)에는 stale 판정 재생
        // 문제도 얽혀 있어 여기서 참인 안내를 쓸 수 없다(대장 등재 · 이번 슬라이스에서 닫지 않는다).
        if (reason === "ceo_decision_verify") {
            const deciderDoc = (result.state.failed_agent && findAgent(loadAgentRegistry(), result.state.failed_agent)?.default_output) || null;
            if (deciderDoc !== null && !approvedDigests(state).has(deciderDoc)) {
                console.error(`CEO 판정이 '검증'인데 되돌림 예산이 소진됐습니다 — **하네스가 아니라 사람이 확인할 차례입니다** (개발하지 않습니다).\n` +
                    `  ① ${deciderDoc}의 산문에서 CEO가 요구한 확인 항목을 읽고 직접 확인하세요 (인터뷰·설치·수동 재현 등).\n` +
                    `  ② 확인 결과로 같은 문서의 "## Decision"을 **결론 판정**으로 고친 뒤 같은 명령:\n` +
                    `     harness pipeline next --project ${project}\n` +
                    `     게이트가 그 문서를 다시 읽어 재판정합니다 — **모델 호출 0회**이고 영수증에 "판정 출처: 복원 문서"가 남습니다.\n` +
                    `  ('축소'는 되돌림 예산이 이미 소진된 뒤라 진행하지 못하고 같은 자리에서 다시 멈춥니다.\n` +
                    `   아무것도 고치지 않은 재실행도 모델 호출 없이 같은 자리에서 다시 멈춥니다.)\n` +
                    `  [A-2] 결론은 셋이지만 **개발 표면을 여는 것은 '진행' 하나뿐입니다** — '보류'는 백로그, '폐기'는 종료라\n` +
                    `   둘 다 작업 지시문·DAG 초안을 열지 않습니다 (초판 안내는 '보류'를 결론의 하나로 권해 우회로를 지시했다).`);
            }
        }
        return done("pipeline_stage_failed", 1);
    }
    // completed → manifest·seed 재구성 (**같은 read**에서 digest와 seed를 함께 뽑는다)
    let manifest;
    try {
        manifest = buildManifest(root, runStateSources(result.state));
    }
    catch (err) {
        const code = err instanceof PipelineError ? err.code : "pipeline_manifest_failed";
        return reject(code, `영수증을 만들 수 없어 확인 대기로 넘기지 않았습니다: ${err.message}`, 1);
    }
    const base = {
        stage: stage.id,
        workflow_id: stage.workflowId,
        run_finished_at: result.state.finished_at,
        artifacts: manifest.artifacts,
        seeds: manifest.seeds,
    };
    return commitPending(root, state, base, now(), project);
}
/**
 * [Codex A-5] Obsidian export — **파이프라인 사실을 명시 인자로 넘긴다**(방금 쓴 durable state에서
 * 읽는다). vault가 파이프라인 상태를 추측하지 않고, "확인 대기"가 "완료"로 적히지 않는다.
 */
function exportVault(o, root, runState) {
    const vaultPath = o.vault ?? process.env.HARNESS_VAULT;
    if (!vaultPath || !vaultPath.trim())
        return;
    const read = readPipelineStateAt(pipelineStatePath(root));
    // **손상(`unreadable`)을 부재(`absent`)로 접지 않는다**(Codex 검증 신규 A): 둘 다 `null`로 접으면
    // vault 노트에 run의 `상태: completed`만 남아 **외부 vault에 거짓 완료 영수증**이 생긴다. 이 export는
    // 파이프라인 경로에서만 불리므로 state는 있어야 정상이고, 읽히지 않는다는 것 자체가 적어야 할 사실이다.
    // (`absent`는 파이프라인 밖 run이 아니라 — 그 경로는 이 함수를 부르지 않는다 — 방금 쓴 state가 사라진
    //  경우이므로 그것도 사실로 남긴다.)
    const st = read.kind === "ok" ? read.state : null;
    const pipelineNote = st !== null
        ? {
            stage: currentStage(st)?.id ?? "(완료)",
            index: Math.min(st.current_index + 1, DEFAULT_PIPELINE.length),
            total: DEFAULT_PIPELINE.length,
            status: st.status,
            checkpointId: st.pending?.checkpoint_id ?? null,
        }
        : {
            stage: "(파이프라인 상태를 읽을 수 없다)",
            index: 0,
            total: DEFAULT_PIPELINE.length,
            status: read.kind === "unreadable" ? "unreadable — 확인 대기 여부를 알 수 없다" : "absent — 상태 파일이 사라졌다",
            checkpointId: null,
        };
    try {
        const ex = exportToVault({
            vault: vaultPath.trim(),
            state: runState,
            pipeline: pipelineNote,
        });
        console.log(`Obsidian: ${ex.notesWritten}개 노트 → ${ex.folder}`);
    }
    catch (err) {
        console.warn(`Obsidian export 실패 (실행 결과는 저장됨): ${err.message}`);
    }
}
/** pending 기록 + awaiting_approval 전이 (원자 쓰기 1회). `last_failure`는 성공 시 null로 내린다. */
function commitPending(root, state, base, at, project) {
    const pending = { ...base, checkpoint_id: checkpointIdFor(base) };
    writePipelineState(root, { ...state, status: "awaiting_approval", pending, last_failure: null, updated_at: at });
    console.log("");
    console.log(`✅ '${pending.stage}' 단계 완료 — **확인 대기**로 들어갑니다 (다음 단계는 승인 후에 돕니다).`);
    console.log(`checkpoint: ${pending.checkpoint_id}`);
    for (const a of pending.artifacts)
        console.log(`  - ${a.path} (${a.size}B · ${a.sha256.slice(0, 12)}…)`);
    console.log("문서를 확인한 뒤:");
    console.log(`  승인   harness pipeline approve ${pending.stage} --checkpoint ${pending.checkpoint_id} --project ${project}`);
    console.log(`  되돌림 harness pipeline reject ${pending.stage} --checkpoint ${pending.checkpoint_id} --project ${project} --note "<이유>"`);
    return done("pipeline_awaiting_approval", 0);
}
/**
 * 신원 결박: **stage(의도) + checkpoint_id(바이트 신원)** 가 모두 pending과 일치해야 한다.
 * 하나만 받으면 "다른 단계를 승인" 또는 "바뀐 바이트를 옛 승인으로 통과"가 열린다.
 * 이중 approve는 pending이 이미 null이라 여기서 거부된다(멱등).
 */
function openDecision(o, verb, now) {
    const root = projectPaths(o.project).root;
    const read = readPipelineStateAt(pipelineStatePath(root));
    if (read.kind === "unreadable") {
        const gate = pipelineGateStatus(read, root, "run");
        return { ok: false, res: reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2) };
    }
    if (read.kind === "absent") {
        return { ok: false, res: reject("pipeline_absent", `파이프라인이 없습니다 (${o.project}) — 'harness pipeline next'로 시작하세요.`, 1) };
    }
    const lock = lockPipeline(root, now);
    if (!lock.ok)
        return { ok: false, res: reject("pipeline_locked", lock.message, 2) };
    const locked = lock.locked;
    const fail = (code, message, exit) => {
        locked.release();
        return { ok: false, res: reject(code, message, exit) };
    };
    // [Codex A-7] lock 밖 snapshot으로 판정하면 그 사이 끝난 전이를 덮어쓴다 — 재독·재검증한 것만 쓴다.
    const fresh = locked.read;
    if (fresh.kind !== "ok") {
        const gate = pipelineGateStatus(fresh, root, "run");
        return fail(fresh.kind === "absent" ? "pipeline_absent" : "pipeline_state_unreadable", gate.ok ? "파이프라인이 사라졌습니다" : gate.message, 2);
    }
    const state = fresh.state;
    if (state.status === "killed") {
        return fail("pipeline_killed", `폐기 판정으로 종료된 파이프라인입니다 — ${verb}할 체크포인트가 없습니다.`, 1);
    }
    if (state.status === "completed") {
        return fail("pipeline_completed", `파이프라인이 이미 완료됐습니다 — ${verb}할 체크포인트가 없습니다.`, 1);
    }
    if (state.status !== "awaiting_approval" || !state.pending) {
        return fail("pipeline_no_pending", `확인할 산출물이 없습니다 (상태 ${state.status} · 단계 ${stageLabel(state)}) — 먼저 'harness pipeline next --project ${o.project}'로 단계를 실행하세요.`, 1);
    }
    const pending = state.pending;
    if (pending.stage !== o.stage) {
        return fail("pipeline_stage_mismatch", `확인 대기 중인 단계는 '${pending.stage}'입니다 (요청 '${o.stage}') — 상태를 바꾸지 않았습니다.`, 1);
    }
    if (pending.checkpoint_id !== o.checkpointId) {
        return fail("pipeline_checkpoint_mismatch", `checkpoint id가 다릅니다 (대기 ${pending.checkpoint_id} · 요청 ${o.checkpointId}) — 상태를 바꾸지 않았습니다.\n` +
            `'harness pipeline status --project ${o.project}'로 현재 id를 확인하세요.`, 1);
    }
    const stage = currentStage(state);
    if (!stage)
        return fail("pipeline_stage_out_of_range", `current_index가 단계 범위를 벗어났습니다 (${state.current_index})`, 2);
    return { ok: true, root, state, pending, stage, release: locked.release };
}
// ── approve ─────────────────────────────────────────────────────
export function approveCheckpoint(o) {
    const now = o.now ?? (() => new Date().toISOString());
    const opened = openDecision(o, "승인", now);
    if (!opened.ok)
        return opened.res;
    const { root, state, pending, stage } = opened;
    try {
        // ② 승인 직전 **전수 재검증**: pending 산출물 + **앞 단계 승인 바이트 전부**(A-6).
        //    pending만 보면 "마지막 체크포인트 대기 중에 앞 단계 문서를 바꾸고 마지막만 승인" →
        //    '전체 완료' 영수증이 나온다. pending이 같은 경로를 다시 담으면 그 경로 기준은 pending이다
        //    (정당한 재작성을 drift로 잡지 않는다 — effectiveDigests가 그 우선순위를 표현한다).
        const problem = driftProblem(root, effectiveDigests(state, pending.artifacts).values());
        if (problem) {
            return reject("pipeline_artifact_drift", `${problem}\n확인한 바이트가 아니므로 승인하지 않았습니다 (상태 불변) — 파일을 복원하거나 'harness pipeline reject'로 되돌린 뒤 다시 실행하세요.`, 1);
        }
        // ③ workflow 단계면 run_state를 다시 읽어 그 단계의 완료를 확인한다. killed면 화해가 먼저다.
        if (stage.kind === "workflow") {
            const rsRead = readRunStateAt(join(root, RUN_STATE_REL));
            if (rsRead.kind === "unreadable") {
                return reject("run_state_unreadable", `run_state.json을 읽을 수 없어 승인하지 않았습니다: ${rsRead.path} (${rsRead.detail})`, 2);
            }
            if (rsRead.kind === "absent") {
                return reject("run_state_absent", `run_state.json이 없어 이 단계의 완료를 확인할 수 없습니다 — 승인하지 않았습니다.`, 1);
            }
            const rs = rsRead.state;
            if (rs.status === "killed") {
                // [A-10] provenance: 이 단계의 workflow가 죽은 것이 아니면 영수증을 만들지 않는다.
                if (rs.workflow_id !== stage.workflowId) {
                    return reject("pipeline_killed_elsewhere", `run_state가 폐기 판정인데 그 workflow('${rs.workflow_id}')는 이 단계('${stage.id}')가 아닙니다 — 승인하지 않았고 아무것도 쓰지 않았습니다.`, 1);
                }
                const next = reconcileKilled(root, state, stage, rs, now());
                writePipelineState(root, next);
                return reject("pipeline_killed_reconciled", `run이 폐기(killed) 판정입니다 — 승인하지 않고 파이프라인을 종료했습니다 (${next.checkpoints.at(-1)?.note}).`, 1);
            }
            if (rs.workflow_id !== pending.workflow_id || rs.status !== "completed") {
                return reject("pipeline_run_state_mismatch", `run_state가 이 단계의 완료를 증언하지 않습니다 (workflow ${rs.workflow_id} · status ${rs.status}) — 승인하지 않았습니다.`, 1);
            }
            // **byte binding ≠ run identity**: 같은 바이트를 낸 다른 run이면 id가 같고 승인은 통과한다.
            // 표시용 finished_at 불일치는 경고만 한다(거부 사유가 아니다 — 그렇게 하면 재실행 재현이 막힌다).
            if (rs.finished_at !== pending.run_finished_at) {
                console.warn(`참고: 확인 대기 시점의 run과 현재 run_state의 종료 시각이 다릅니다 (${pending.run_finished_at} → ${rs.finished_at}). 바이트는 동일합니다.`);
            }
        }
        const at = now();
        const receipt = { ...pending, decision: "approved", decided_at: at, note: null };
        const nextIndex = state.current_index + 1;
        const finished = nextIndex >= DEFAULT_PIPELINE.length;
        writePipelineState(root, {
            ...state,
            current_index: nextIndex,
            status: finished ? "completed" : "awaiting_run",
            pending: null,
            last_failure: null,
            checkpoints: [...state.checkpoints, receipt],
            updated_at: at,
        });
        console.log(`✅ 승인: '${pending.stage}' (checkpoint ${pending.checkpoint_id} · 산출물 ${pending.artifacts.length}개)`);
        if (finished) {
            printCompletedGuidance(state.project);
        }
        else {
            console.log(`다음 단계: ${DEFAULT_PIPELINE[nextIndex].id} — harness pipeline next --project ${state.project}`);
        }
        return done("pipeline_approved", 0);
    }
    finally {
        opened.release();
    }
}
// ── reject ──────────────────────────────────────────────────────
export function rejectCheckpoint(o) {
    const now = o.now ?? (() => new Date().toISOString());
    const opened = openDecision(o, "되돌림", now);
    if (!opened.ok)
        return opened.res;
    const { root, state, pending } = opened;
    try {
        const at = now();
        const receipt = { ...pending, decision: "rejected", decided_at: at, note: o.note ?? null };
        // 같은 단계의 실행 대기로 되돌린다(index 불변) — 다음 next는 **재실행**한다(old-run 채택 없음).
        writePipelineState(root, {
            ...state,
            status: "awaiting_run",
            pending: null,
            checkpoints: [...state.checkpoints, receipt],
            updated_at: at,
        });
        console.log(`↩ 되돌림: '${pending.stage}' (checkpoint ${pending.checkpoint_id})${o.note ? ` — ${o.note}` : ""}`);
        console.log(`같은 단계를 다시 실행합니다: harness pipeline next --project ${state.project}`);
        return done("pipeline_rejected", 0);
    }
    finally {
        opened.release();
    }
}
// ── restart ─────────────────────────────────────────────────────
/**
 * killed/completed(그리고 **읽을 수 없는 state**)에서만 새로 시작한다. 기존 파일은 **rename 보관**이고
 * 삭제가 없다 — 영수증은 사라지지 않는다.
 *
 * unreadable을 받는 이유(설계 §4 표의 "전부 exit 2"와의 충돌을 이렇게 해소했다): unreadable의 안내
 * 문구 자체가 "복원 또는 restart"인데 restart가 그 state를 읽어야만 돌면 **탈출구가 없다**.
 * 손상된 파일도 지우지 않고 archive로 옮기므로 잃는 것이 없고, 새 state는 stage 0 awaiting_run이라
 * 승인이 위조되지도 않는다(직접 파일 수정은 §8-2의 알려진 범위 밖 위협이다).
 * awaiting_run/awaiting_approval에서는 **거부**한다 — 체크포인트 회피 통로를 만들지 않는다.
 */
export function restartPipeline(o) {
    const now = o.now ?? (() => new Date().toISOString());
    const root = projectPaths(o.project).root;
    const abs = pipelineStatePath(root);
    if (readPipelineStateAt(abs).kind === "absent") {
        return reject("pipeline_absent", `파이프라인이 없습니다 (${o.project}) — 'harness pipeline next'로 시작하세요.`, 1);
    }
    const lock = lockPipeline(root, now);
    if (!lock.ok)
        return reject("pipeline_locked", lock.message, 2);
    const locked = lock.locked;
    try {
        // [Codex A-7] lock 획득 후 재독 — 그 사이 owner가 상태를 바꿨을 수 있다(진행 중 파이프라인을
        // archive해 버리는 것이 이 경로의 최악이다).
        const read = locked.read;
        if (read.kind === "absent")
            return reject("pipeline_absent", `파이프라인이 사라졌습니다 (${o.project}).`, 1);
        // [A-3] **restart가 복구 가능한 상태를 영구 벽돌로 바꾸는 조합 하나를 막는다.**
        // `restart`는 `pipeline_state.json`만 갈아 끼우고 `run_state`는 읽지도 쓰지도 않는다. 그래서
        // "2단계 이상에서 폐기 → restart"를 하면 파이프라인은 1단계 `awaiting_run`이 되는데 `run_state`는
        // **다른 workflow의 killed**로 남는다. 그 조합에서는 이후 **모든 명령이 거부된다**(실측 2026-09-02):
        //   `next`→`pipeline_killed_elsewhere` · `restart`→`pipeline_active` ·
        //   `run`→`pipeline_run_reserved` · `approve`/`reject`→`pipeline_no_pending`.
        // 그리고 `pipeline_killed_elsewhere`가 안내하는 탈출구 **둘 다 그 상태에서 막혀 있다** —
        // 이 레포 거짓 안내 계열(`C-138`·`B-49`·`B-50`·`B-54`)의 또 하나다.
        //
        // **restart 직전에는 그 재평가가 실제로 가능하다**(파이프라인이 `killed`라 `harness run`이 열려
        // 있다 — 실측으로 대조했다). 즉 restart는 **탈출구가 있는 상태를 탈출구가 없는 상태로** 바꾼다.
        // 그래서 여기서 거부하고 순서를 뒤집는다: 재평가 먼저, restart는 그다음.
        //
        // **1단계 폐기는 막지 않는다**: 그때는 `run_state`의 workflow가 새 파이프라인의 첫 단계와 같아서
        // 첫 `next`가 화해하고(`pipeline_killed_reconciled`) 파이프라인이 다시 `killed`로 돌아가므로
        // `harness run` 재평가가 열린 채다 — 벽돌이 아니다. 막을 이유가 없는 것을 막지 않는다.
        const rs = readRunStateAt(join(root, RUN_STATE_REL));
        const first = DEFAULT_PIPELINE[0];
        const firstWf = first.kind === "workflow" ? first.workflowId : null;
        if (rs.kind === "ok" && rs.state.status === "killed" && rs.state.workflow_id !== firstWf) {
            const k = rs.state.killed_by;
            return reject("run_state_killed", `이 프로젝트의 마지막 run이 폐기 판정입니다 (workflow '${rs.state.workflow_id}' · ` +
                `${k?.decider ?? "게이트"}가 '${k?.decision ?? "폐기"}') — 파이프라인을 다시 세우지 않았습니다.\n` +
                `지금 다시 세우면 파이프라인은 1단계로 돌아가는데 폐기 기록은 '${rs.state.workflow_id}'에 남아, ` +
                `이후 next·restart·run·approve가 **전부 거부되는 상태**가 됩니다.\n` +
                `순서를 뒤집으세요 — **재평가를 먼저** 돌려 '진행' 판정을 받고, 그다음에 restart 하세요:\n` +
                `  harness run <${reevaluationWorkflowIds().join(" | ")}> --project ${o.project}\n` +
                `  (지금은 파이프라인이 폐기 상태라 이 run이 열려 있습니다. restart 뒤에는 막힙니다.)`, 2);
        }
        if (read.kind === "ok" && read.state.status !== "killed" && read.state.status !== "completed") {
            return reject("pipeline_active", `진행 중인 파이프라인은 다시 시작할 수 없습니다 (상태 ${read.state.status} · 단계 ${stageLabel(read.state)}) — ` +
                `체크포인트를 우회하는 통로를 만들지 않습니다. 확인 대기면 approve/reject로 판정하세요.`, 1);
        }
        const at = now();
        // [Codex A-11] `renameSync`는 **destination을 교체한다** — 같은 시각 이름이 이미 있으면 앞 archive가
        // 사라지고 "삭제 없음·exact bytes 보존"이 거짓이 된다. 그래서 이름을 **exclusive-create로 예약**
        // (`flag:"wx"`)한 뒤 그 자리에만 rename한다: 우리가 방금 만든 빈 파일만 덮는다.
        const stamp = at.replace(/[-:.]/g, "").replace(/Z$/, "");
        let archive = "";
        for (let n = 1; n <= 100; n++) {
            const cand = join(root, PIPELINE_STATE_REL.replace(/\.json$/, `.${stamp}${n === 1 ? "" : `-${n}`}.json`));
            try {
                closeSync(openSync(cand, "wx")); // 이미 있으면 throw → 다음 이름
                archive = cand;
                break;
            }
            catch {
                continue;
            }
        }
        if (!archive)
            return reject("pipeline_archive_name_exhausted", `archive 이름을 예약할 수 없습니다 (${stamp} 계열 100개 사용 중)`, 1);
        renameSync(abs, archive); // **삭제 없음** — 기존 영수증은 예약한 자리로 그대로 보관된다
        const fresh = newPipelineState(o.project, at, undefined); // [B-57] 다시 세우면 provider도 다시 고른다(승계 안 함)
        writePipelineState(root, fresh);
        console.log(`파이프라인을 다시 시작했습니다 — 기존 state는 보관: ${archive.slice(root.length + 1)}`);
        console.log(`단계 ${stageLabel(fresh)}부터: harness pipeline next --project ${o.project}`);
        return done("pipeline_restarted", 0);
    }
    finally {
        locked.release();
    }
}
// ── unlock (lock 불요 · 죽은 owner만) ───────────────────────────
/**
 * **죽음을 관측했을 때만 회수한다**(`C-4` 보강이 세운 규율). `process.kill(pid, 0)`이 ESRCH를 던지면
 * 그 프로세스는 없다. 살아 있음·EPERM·판별 불가는 전부 거부 — 강제 플래그는 없다(있으면 그것이
 * 곧 "진행 중인 단계를 두 프로세스가 돌리는" 통로다).
 *
 * pipeline_state를 읽지 않는다: lock 회수는 상태 판정이 아니고, 손상된 state + 죽은 owner 조합에서
 * 회수마저 막히면 사람이 손으로 파일을 지우는 것 말고 길이 없어진다.
 */
export function unlockPipeline(o) {
    const root = projectPaths(o.project).root;
    const abs = join(root, PIPELINE_LOCK_REL);
    const lock = readLock(root);
    if (!lock) {
        if (existsSync(abs)) {
            return reject("pipeline_lock_unreadable", `lock 파일이 있지만 내용을 읽을 수 없습니다: ${abs} — owner의 죽음을 관측할 수 없어 회수하지 않습니다. 내용을 확인한 뒤 직접 지우세요.`, 1);
        }
        console.log(`회수할 lock이 없습니다 (${abs}).`);
        return done("pipeline_lock_absent", 0);
    }
    let alive;
    try {
        process.kill(lock.pid, 0);
        alive = true;
    }
    catch (err) {
        const code = err.code;
        if (code === "ESRCH")
            alive = false;
        else
            alive = true; // EPERM 등 = 존재하지만 우리 것이 아니다. 판별 불가는 살아 있는 쪽으로 fail closed.
    }
    if (alive) {
        return reject("pipeline_lock_owner_alive", `lock owner(pid ${lock.pid})가 살아 있거나 판별할 수 없습니다 — 회수하지 않았습니다 (획득 ${lock.at}).\n` +
            `그 프로세스가 끝나기를 기다리세요. 강제 회수 플래그는 없습니다 (같은 단계를 두 프로세스가 돌리는 통로가 됩니다).`, 1);
    }
    try {
        unlinkSync(abs);
    }
    catch (err) {
        return reject("pipeline_unlock_failed", `lock 회수 실패: ${err.message}`, 1);
    }
    console.log(`죽은 owner(pid ${lock.pid} · 획득 ${lock.at})의 lock을 회수했습니다: ${abs}`);
    return done("pipeline_unlocked", 0);
}
