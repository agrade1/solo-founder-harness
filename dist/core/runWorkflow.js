import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import { loadAgentRegistry, loadWorkflows, findWorkflow, findAgent, isCritiqueLoop, isGate, isFanout, isApproval, hasKillGate, reevaluationWorkflowIds, } from "./registry.js";
import { projectPaths, projectExists } from "./project.js";
import { leaseAllowsRun, pipelineGateStatus, pipelineStatePath, readPipelineStateAt } from "./pipeline.js";
import { runAgent } from "./runAgent.js";
import { saveArtifact } from "./saveArtifact.js";
import { validateAgentOutput, extractTokensJson, extractMainJudgment, extractCriticalRisks, extractSpawnDeclarations, extractCeoDecision, CEO_DECISION_TOKENS, } from "./validate.js";
import { loadToolProfiles, compileToolProfile, assertPolicyExecutable, hasMcpBinding } from "../tools/profiles.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
import { runResearch, ResearchError } from "../tools/researchGateway.js";
import { EVIDENCE_DIGEST_RECIPIENTS, RESEARCH_DECLARATION_INSTRUCTION, RESEARCH_DIR_REL, RESEARCH_FIRST_PASS_MAX_BYTES, RESEARCH_MAX_ATTEMPTS, buildEvidenceDigest, createSessionBackend, parseResearchDeclaration, redactedQuery, secondPassRequest, sha256Of, verifyResearchReceipt, writeResearchReceipt, } from "./researchRuntime.js";
import { envFilePath } from "./envFile.js";
/**
 * [C-127] 재생성 상한 후에도 필수 섹션 계약 미달 — **채택 거부**. step 단위 catch가 이것을 보고
 * `failed_reason`에 안정 코드(`required_sections_missing`)를 적는다. 새 상태를 만들지 않는 이유는
 * `failed` + `resume_from`이 이미 이 레포의 "고치고 이어서 하라"이기 때문이다(`user_rejected` 선례).
 */
class RequiredSectionsMissing extends Error {
}
/**
 * [B-40/A-2] 게이트 결과를 사람이 읽는 한 줄로. **CLI와 vault가 이 함수 하나를 쓴다** —
 * 렌더가 두 벌이면 한쪽만 정직해진다(실제로 그렇게 killed가 "진행"으로 적히고 있었다).
 * `outcome`이 없는 옛 run_state는 jumped_to로 추론하되 그 사실을 숨기지 않는다.
 */
export function gateOutcomeLabel(g) {
    const base = (() => {
        switch (g.outcome) {
            case "kill":
                return "폐기 — run 종료";
            case "jump":
                return `${g.jumped_to} 되돌림`;
            case "proceed":
                return "진행";
            case "failed":
                return `중단(${g.reason ?? "사유 미기록"})`;
            default:
                return g.jumped_to ? `${g.jumped_to} 되돌림` : "결과 미기록(구버전 run_state)";
        }
    })();
    // [B-49] 출처 표시도 이 한 함수에만 있다 (위 B-40/A-2와 같은 이유). 필드가 없는 entry의
    // 라벨 바이트는 그대로다 — 기존 단정·vault 출력 불변.
    return g.decision_source === "restored_artifact" ? `${base} · 판정 출처: 복원 문서(이번 invocation에서 decider 미실행)` : base;
}
const RUN_STATE_REL = "outputs/run_state.json";
/** ms를 사람이 읽는 경과시간으로. 60초 미만은 "12s", 이상은 "1:23". */
function fmtElapsed(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/**
 * [B-40/A-3] **잠금 근거 필드의 최소 구조 검증.** JSON으로 파싱되기만 하면 통과시키면
 * `status:"killed"`인데 `kill_history`가 없는 state가 "폐기된 적 없음"으로 읽혀 잠금이 사라진다
 * (문법 손상만 막고 구조 손상은 열려 있었다).
 *
 * 전체 스키마 검증기를 새로 짓지 않는다 — 잠금 판정이 읽는 필드만 본다. **정상 구버전은 통과**시킨다
 * (새 필드가 없는 completed/failed state = 잠금 없음, 하위 호환).
 * @returns 문제가 있으면 사람이 읽을 이유, 없으면 null.
 */
function lockFieldsProblem(s) {
    const raw = s;
    const hist = raw.kill_history;
    if (hist !== undefined) {
        if (!Array.isArray(hist))
            return "kill_history가 배열이 아니다";
        for (const [i, e] of hist.entries()) {
            if (typeof e !== "object" || e === null)
                return `kill_history[${i}]가 객체가 아니다`;
            if (!("idea_sha256" in e))
                return `kill_history[${i}]에 idea_sha256 키가 없다`;
        }
    }
    const cleared = raw.cleared_idea_sha256;
    if (cleared !== undefined && cleared !== null && typeof cleared !== "string") {
        return "cleared_idea_sha256가 문자열도 null도 아니다";
    }
    // killed는 반드시 이력을 남긴다 — 없으면 그 state는 폐기 사실을 잃은 것이고 통과시킬 수 없다.
    if (raw.status === "killed" && (!Array.isArray(hist) || hist.length === 0)) {
        return "status가 killed인데 kill_history가 없거나 비어 있다";
    }
    return null;
}
/** 지정 절대경로의 run_state.json을 읽는다 (부재/문법 손상/구조 손상/정상 구분). */
export function readRunStateAt(abs) {
    if (!existsSync(abs))
        return { kind: "absent" };
    let state;
    try {
        state = JSON.parse(readFileSync(abs, "utf8"));
    }
    catch (err) {
        return { kind: "unreadable", path: abs, detail: err.message };
    }
    if (typeof state !== "object" || state === null) {
        return { kind: "unreadable", path: abs, detail: "최상위가 객체가 아니다" };
    }
    const problem = lockFieldsProblem(state);
    if (problem)
        return { kind: "unreadable", path: abs, detail: problem };
    return { kind: "ok", state };
}
/** 프로젝트의 run_state.json을 읽는다 (부재/손상 구분). */
export function readRunState(project) {
    return readRunStateAt(join(projectPaths(project).root, RUN_STATE_REL));
}
/** outputs/run_state.json을 읽는다. 없거나 파싱 실패면 null. (부재/손상을 구분해야 하면 readRunState) */
export function loadRunState(project) {
    const r = readRunState(project);
    return r.kind === "ok" ? r.state : null;
}
/** 검토 대상 아이디어 문서의 프로젝트 상대경로 — kill 잠금의 기준 파일. */
export const IDEA_REL = "docs/00_IDEA.md";
/** 아이디어 문서를 한 번 읽어 snapshot을 만든다. 파일이 없으면 sha256=null, text="". */
export function snapshotIdea(ideaAbs) {
    if (!existsSync(ideaAbs))
        return { path: ideaAbs, sha256: null, text: "" };
    const bytes = readFileSync(ideaAbs);
    return { path: ideaAbs, sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") };
}
/** 프로젝트의 docs/00_IDEA.md를 한 번 읽어 snapshot을 만든다. */
export function snapshotProjectIdea(project) {
    return snapshotIdea(join(projectPaths(project).root, IDEA_REL));
}
/**
 * [B-40/A-3] **폐기 잠금의 단일 판정 함수.** `run`·`task-prompt`·`plan-dag`가 이 함수만 쓴다 —
 * 규칙이 세 벌이면 한쪽만 정직해진다.
 *
 * 잠금의 근거는 두 필드다:
 * - `kill_history`: 이 아이디어가 죽은 적이 있는가 (carry forward — 뒤 run이 지우지 못한다).
 * - `cleared_idea_sha256`: kill 게이트가 **'진행' 판정**을 낸 순간의 아이디어 digest. 그것만이 해제 증거다.
 *
 * **아이디어를 고친 것은 해제가 아니다**(이전 판의 결함): 공백 하나만 바꿔도 기존 killed 산출물로
 * 지시문·DAG를 만들 수 있었다. 변경은 "재평가가 필요하다"는 신호이지 "통과했다"는 증거가 아니다.
 * 그래서 잠금 중 허용되는 것은 **재평가 run 하나**(kill 게이트가 있는 workflow)뿐이고,
 * 그 run의 게이트가 '진행'을 내면 그때 해제 digest가 발급된다.
 *
 * **아이디어는 호출자가 이미 읽은 snapshot으로 받는다**(A-1): 이 함수가 경로를 다시 읽으면
 * "검사한 바이트"와 "쓰는 바이트"가 갈릴 수 있다(검사 통과 후 파일이 바뀌는 창).
 *
 * @param allowReevaluation 호출자가 "kill 게이트가 있는 workflow의 새 run"일 때만 true.
 *   재평가는 **아이디어 변경을 요구하지 않는다** — 같은 바이트를 다시 심사하는 것 자체는 정당하고
 *   (사람이 근거를 새로 댈 수 있다), 막아야 할 것은 "심사 없이 통과"였다.
 */
export function ideaGateStatus(read, idea, allowReevaluation = false) {
    if (read.kind === "unreadable") {
        return {
            ok: false,
            code: "run_state_unreadable",
            message: `run_state.json이 있지만 읽을 수 없습니다: ${read.path} (${read.detail}).\n` +
                `폐기 기록이 이 파일에 있을 수 있어 덮어쓰지 않습니다 — 파일을 고치거나(백업에서 복원) 검토 후 지우세요.`,
        };
    }
    if (read.kind === "absent")
        return { ok: true }; // 실행 이력 없음 — 기존 프로젝트 무영향
    const s = read.state;
    if ((s.kill_history ?? []).length === 0)
        return { ok: true }; // 폐기된 적 없음
    const now = idea.sha256;
    if (now === null) {
        return {
            ok: false,
            code: "idea_missing",
            message: `폐기 기록이 있는데 아이디어 문서를 읽을 수 없습니다: ${idea.path}. 해제 여부를 확인할 수 없어 거부합니다.`,
        };
    }
    if ((s.cleared_idea_sha256 ?? null) === now)
        return { ok: true }; // 재평가에서 '진행' 판정을 받았다
    if (allowReevaluation)
        return { ok: true };
    const last = (s.kill_history ?? []).at(-1);
    const rerun = reevaluationWorkflowIds().join(" | ") || "(kill 게이트가 있는 workflow 없음)";
    return {
        ok: false,
        code: "killed_locked",
        message: `폐기된 아이디어입니다 — ${last?.decider ?? "(게이트)"}가 '${last?.decision ?? "폐기"}' 판정으로 ` +
            `workflow '${s.workflow_id}'를 종료했습니다 (폐기 기록 ${(s.kill_history ?? []).length}건).\n` +
            `아이디어를 고치는 것만으로는 해제되지 않습니다 — ${idea.path}를 고친 뒤 재평가를 먼저 돌리고 ` +
            `게이트에서 '진행' 판정을 받으세요: harness run <${rerun}> --project <name>`,
    };
}
/** 완료된 step id의 저장 산출물 상대경로를 구한다 (resume 시 findings 복원용). */
function resolveOutputRel(id, registry, prior) {
    const agent = findAgent(registry, id);
    if (agent)
        return agent.default_output;
    // 동적 분화된 하위 에이전트(spawn_<id>)는 registry에 없으므로 prior 기록에서 찾는다.
    const sp = prior.spawned_agents.find((s) => `spawn_${s.id}` === id && s.output);
    return sp?.output ?? null;
}
/** 한 step에서 다음 primary agent id 힌트를 구한다 (프롬프트의 Next Agent 표시용). */
function nextHint(steps, i) {
    const nx = steps[i + 1];
    if (nx === undefined)
        return undefined;
    if (isCritiqueLoop(nx))
        return nx.critique_loop.critic;
    if (isGate(nx) || isFanout(nx) || isApproval(nx))
        return undefined; // 게이트/분화/승인은 다음 agent가 아님
    return nx;
}
/**
 * workflow를 순서대로 실행한다.
 * - string step: agent 1회 실행 (+ 스키마 재생성 루프)
 * - critique_loop step: critic 실행 → Critical 리스크가 있으면 target에 되먹여 revise → 재검토 (max_rounds까지)
 * - agent 실행 실패 시 중단하고 failed_agent 기록
 * - 항상 outputs/run_state.json 기록 (regenerations, critique_rounds, usage 포함)
 */
export async function runWorkflow(args) {
    const now = args.now ?? (() => new Date().toISOString());
    const { workflowId, project, provider } = args;
    if (!projectExists(project)) {
        throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
    }
    const registry = loadAgentRegistry();
    const workflow = findWorkflow(loadWorkflows(args.workflowsPath), workflowId);
    if (!workflow) {
        throw new Error(`알 수 없는 workflow: ${workflowId} ('harness list'로 확인)`);
    }
    // [B-40] 폐기 잠금은 **fresh run 경로**에서 본다: prior가 killed면 kill 게이트가 없는 다른 workflow로
    // 돌려서 completed로 덮어쓰는 길이 열려 있었다(그러면 "파이프라인 중단"이 성립하지 않는다).
    // 잠금 중 허용되는 것은 kill 게이트가 있는 workflow의 새 run(=재평가) 하나뿐이다.
    // resume은 아래 status 검사가 이미 killed를 거부하므로 여기서 다시 보지 않는다.
    // [A-1] 아이디어를 **여기서 한 번** 읽는다. 이 run의 모든 agent 프롬프트와 kill/clear digest가
    // 이 snapshot 하나만 쓴다 — 예전엔 runAgent가 매번 읽고 게이트가 또 읽어서, CEO가 판정한 바이트와
    // 해제 digest가 다른 바이트일 수 있었다(그 사이 파일이 바뀌면 CEO가 본 적 없는 것이 해제된다).
    const idea = snapshotProjectIdea(project);
    const priorRead = readRunState(project);
    if (!args.resume) {
        const gateStatus = ideaGateStatus(priorRead, idea, hasKillGate(workflow));
        if (!gateStatus.ok)
            throw new Error(`${gateStatus.code}: ${gateStatus.message}`);
    }
    // [B-41/2단] **활성 파이프라인에서 workflow를 돌리려면 lock을 쥔 파이프라인 연산 안이어야 한다.**
    // (배타 주장을 정정한다 — Codex 검증 A-3: "`pipeline next` 하나뿐"은 거짓이었다. lease는 `lockPipeline`
    //  의 `runStage` 안에서만 발행되지만, 그 연산을 부르는 것이 `next`뿐이라는 것은 **코드가 보장하지 않는다**.)
    // 여기서 fresh와 resume을 **둘 다** 막는다: resume만 열어두면 "체크포인트 대기 중에 --resume으로
    // 단계를 마저 돌린다"가 그대로 우회 통로가 된다(설계 §6은 fresh 경로를 지목했지만, 같은 게이트를
    // 두 경로에 걸어도 pipeline next는 lease로 통과하므로 잃는 것이 없고 닫히는 것이 하나 늘어난다).
    // lease는 "lock 보유 + 현 단계 workflow + awaiting_run" 세 사실에 결박된다(§2.4) — raw 문자열로
    // 자기 권한을 주장하는 인자가 아니다.
    const pipeRead = readPipelineStateAt(pipelineStatePath(projectPaths(project).root));
    const pipeGate = pipelineGateStatus(pipeRead, projectPaths(project).root, "run");
    if (!pipeGate.ok) {
        const leased = pipeGate.code === "pipeline_run_reserved" &&
            leaseAllowsRun(pipeRead, projectPaths(project).root, workflowId, args.pipelineLease);
        if (!leased)
            throw new Error(`${pipeGate.code}: ${pipeGate.message}`);
    }
    // [B-41/1단] **내부 승인 게이트는 응답자 없이 시작하지 않는다.** 예전 계약은 "approve 미지정 =
    // 자동 승인"이었다(아래 approval 분기의 `: true`) — 사람 확인을 존재 이유로 삼는 step이
    // programmatic 호출에서 조용히 통과했고, 비TTY에서는 대화형 응답자가 매달렸다.
    // 판정을 **첫 모델 호출 전에** 낸다: 과금하고 나서 "물어볼 사람이 없다"를 발견하지 않는다.
    // [B-49] **같은 decider의 게이트가 둘 이상인 workflow는 실행 전에 거부한다.**
    // 되돌림 예산은 gate_jumps에서 파생하는데 entry에 step index가 없다 — 게이트 둘이 같은 decider면
    // 서로의 jump를 자기 예산에서 차감한다(과소 예산: fail closed 방향이지만 원인이 보이지 않는 정지).
    // 정의 오류는 첫 모델 호출 전에 낸다: 과금하고 나서 "예산이 왜 없지"를 발견하지 않는다.
    // **위치가 계약이다** — run_start 방출 전이어야 progress renderer의 spinner/stderr가 새지 않는다
    // (main 루프 직전은 run_end를 보장하는 try/finally 바깥이다).
    // 현행 registry는 workflow당 게이트 1개라 걸리지 않는다.
    // (기각한 대안: entry에 step_index 추가 — durable 형태 변경 + 구버전 entry fallback 이중화 + golden 재생성.)
    const gateDeciders = workflow.steps.filter(isGate).map((s) => s.gate.decider);
    if (new Set(gateDeciders).size !== gateDeciders.length) {
        throw new Error(`gate_duplicate_decider: workflow '${workflowId}'에 같은 decider의 게이트가 2개 이상 있습니다 (${gateDeciders.join(", ")}) — ` +
            `되돌림 예산이 gate_jumps 영수증에서 decider 단위로 파생되므로 지원하지 않습니다. (모델 호출 0회)`);
    }
    if (!args.approve && workflow.steps.some(isApproval)) {
        throw new Error(`approval_approver_missing: workflow '${workflowId}'에 내부 승인 게이트가 있는데 응답자가 없습니다 — ` +
            `CLI는 --yes(비대화 승인) 또는 대화형 터미널로 실행하고, programmatic 호출은 approve를 넘기세요. ` +
            `(승인 없이 자동 통과하지 않습니다 · 모델 호출 0회)`);
    }
    // [M2/M2.1] 도구 profile: 지정 시 첫 모델 호출 전(run 시작 전)에 검증하고, compile된 정책을
    // execContext로 보존해 provider 실행에 전달한다. 미충족/불가면 throw → run_start·run_state 미생성.
    // 미지정이면 execContext=undefined → 기존 실행 경로·argv 완전 불변.
    let execContext;
    if (args.toolProfileId) {
        const profiles = loadToolProfiles(args.toolProfilesPath);
        const profile = profiles.get(args.toolProfileId);
        if (!profile) {
            throw new Error(`알 수 없는 tool profile: ${args.toolProfileId} (registry/tool_profiles.json 확인)`);
        }
        // [M2.1] MCP profile fail-closed: MCP per-tool 노출 강제는 M3 preflight/snapshot enforcement가
        // 필요하다. 현재 실행 경로는 그 강제가 없으므로 run_start 이전에 거부한다.
        // (loader/compileToolProfile은 거부하지 않는다 — M3가 동일 profile을 로드할 수 있어야 함.)
        if (hasMcpBinding(profile)) {
            throw new Error(`tool profile '${args.toolProfileId}'는 MCP binding을 포함한다 — M3 preflight/snapshot enforcement 이후 사용 가능 (현재 실행 경로에서 거부).`);
        }
        const policy = compileToolProfile(profile, { bare: args.bare });
        assertPolicyExecutable(policy, { provider: getProviderCapabilities(provider.id) });
        execContext = { claudeArgs: policy.claudeArgs, redactNames: policy.redactNames };
    }
    const completed_steps = [];
    const warnings = [];
    const regenerations = [];
    const critique_rounds = [];
    const gate_jumps = [];
    const spawned_agents = [];
    const step_timings = [];
    let design_gate = null;
    const savedFiles = [];
    const usagePerAgent = [];
    const findings = new Map(); // agentId → "agentId: judgment" (재실행 시 덮어씀, 순서 유지)
    const lastMarkdown = new Map(); // agentId → 마지막 출력 원문 (게이트 판정 추출용)
    // [B-49] 되돌림 예산은 **gate_jumps 영수증에서 파생한다** (지역 Map 삭제).
    //
    // 지역 Map은 run 지역이라 resume마다 예산을 되살렸다: 소진으로 실패한 게이트에서 resume하면
    // 복원된 '검증' 판정이 remaining=1을 다시 받아 jump 분기를 타고 한 lap을 통째로 재실행했고,
    // 입력이 바뀌지 않았으니 같은 판정이 나와 **반복 상한이 없었다**
    // (2026-08-27 live run#3: run 전체 30.2분 · output 105k, replay lap 1개 14.0분).
    // 영수증은 resume에서 carry-forward되고(아래 `gate_jumps.push(...prior.gate_jumps)`) 잘리지
    // 않으므로 파생값은 어느 경로에서도 되살아나지 않는다 — C-126 totals와 같은 단조 규율.
    // run 안에서는 현행과 값이 같다(첫 도착 spent=0 · jump 후 재도착 spent=1)라 기존 게이트 동작 불변.
    // **새 run(비resume)은 영수증을 이어받지 않으므로 예산이 새로 시작한다** — "전체 재실행 비용을
    // 내면 한 바퀴 더"가 의도된 탈출구다.
    //
    // 기각한 대안: 새 durable 필드(gate_budget_spent) — 파생 가능한 값의 중복 상태는 언젠가 어긋난다.
    const isJump = (g) => {
        // 타입은 런타임 검증이 아니다: `outcome`이 생기기 **전에 쓰인 디스크 상의 run_state**를
        // resume하면 필드가 없다(lockFieldsProblem도 gate_jumps를 보지 않는다). 그때 jump를 0으로
        // 세면 비싼 lap 하나가 조용히 다시 열린다 — gateOutcomeLabel의 default case와 같은 fallback.
        const outcome = g.outcome;
        return outcome === "jump" || (outcome === undefined && g.jumped_to !== null);
    };
    const remainingJumps = (gate) => Math.max(0, (gate.max_jumps ?? 0) - gate_jumps.filter((g) => isJump(g) && g.decider === gate.decider).length);
    /** [B-49] 이번 invocation에서 실행되지 않고 디스크에서 복원된 step id (판정 출처 영수증용). */
    const restoredIds = new Set();
    const maxRegen = Math.max(0, args.maxRegenerations ?? 1);
    const allowSpawn = args.allowSpawn ?? false;
    const maxTokens = Math.max(0, args.maxTokens ?? 0);
    const approve = args.approve;
    const reporter = args.reporter;
    const total = workflow.steps.length;
    let failed_agent = null;
    let failed_reason = null;
    let failedIndex = null;
    let budgetStopped = false;
    let rejected = false;
    // [C-125] 실행 중인 비평 라운드 (루프 밖에서는 0). 루프 중 실패 시 durable 힌트로 나간다.
    let activeCritiqueRound = 0;
    let killed_by = null;
    // [B-40/A-3] **carry forward.** 폐기 기록과 해제 증거는 이전 state에서 이어받는다 — resume이든
    // 새 run이든. 이어받지 않으면 kill 뒤 아무 run 하나가 증거를 지우고 잠금 전체가 무의미해진다.
    // (prior는 resume 전용이라 여기서 쓰지 않는다: 재평가 run은 resume이 아니면서도 이어받아야 한다.)
    const priorState = priorRead.kind === "ok" ? priorRead.state : null;
    const kill_history = [...(priorState?.kill_history ?? [])];
    let cleared_idea_sha256 = priorState?.cleared_idea_sha256 ?? null;
    let warned80 = false;
    let currentAgentId = "";
    // ── [C-126] 리서치 배선 ────────────────────────────────
    // 미지정은 self다 — 이 함수는 키를 모르고, 외부 호출은 runtime이 external일 때만 일어난다.
    const research = args.research ?? { kind: "self", envPath: envFilePath(), notices: [] };
    // [A-4·kill_history 선례] attempts는 **명시적 carry-forward**. 없으면 뒤 run 하나가 앞 단계
    // 리서치 영수증을 지운다(그리고 checkpoint 결박 대상도 함께 사라진다).
    const researchAttempts = [...(priorState?.research?.attempts ?? [])];
    const projectRoot = projectPaths(project).root;
    /**
     * [C-126/A-3] **단조 증가 durable 누적치.** `attempts[]`는 4개로 잘리므로 그것을 합산해 상한을
     * 복원하면 attempt당 1회 호출에서 합계가 4로 고정되고 **무한 resume으로 예산이 되살아난다**.
     * 구버전 state(필드 없음)는 잘린 배열 합으로 강하한다 — 예전과 같은 수준이고 더 나쁘지 않다.
     */
    const priorTotals = priorState?.research?.totals ?? {
        backend_calls: researchAttempts.reduce((s, a) => s + (a.backend_calls ?? 0), 0),
        results: researchAttempts.reduce((s, a) => s + (a.evidence?.length ?? 0), 0),
    };
    /** 하류 수신자(EVIDENCE_DIGEST_RECIPIENTS)에게 실리는 digest. **새 attempt 시작 시 소거**된다. */
    let evidenceDigest = null;
    // [A-9 + A-1] resume 재주입은 시각 창이 아니라 attempt에 결박된 snapshot에서 오고, **그 snapshot을
    // 소비 직전에 저장본(receipt+raw)과 대조한다**. run_state 객체를 그대로 믿으면 그 JSON의
    // summary/source/sha256만 바꿔서 **변조된 근거를 모델에 먹이고 checkpoint는 옛 receipt를 결박**할 수
    // 있다(모델이 소비한 근거 ≠ 승인된 근거). 정본은 저장본이다 — B-40 snapshotIdea·B-41 durable seed와 같은 규율.
    if (args.resume) {
        const lastOk = [...researchAttempts].reverse().find((a) => a.mode !== null && (a.evidence ?? []).length > 0);
        if (lastOk) {
            const v = verifyResearchReceipt(projectRoot, lastOk);
            if (!v.ok) {
                // fail closed. 조용히 "근거 없음"으로 강하하면 변조가 보이지 않는다.
                throw new Error(`research_receipt_unverified: ${v.detail}\n` +
                    `저장된 리서치 영수증과 run_state가 일치하지 않아 근거를 재주입하지 않고 멈췄습니다 — ` +
                    `${RESEARCH_DIR_REL}/의 파일을 복원하거나 검토 후 outputs/run_state.json을 정리하세요.`);
            }
            const d = buildEvidenceDigest(v.attempt.evidence);
            if (d.ok)
                evidenceDigest = d.digest;
            else
                console.warn(`  ⚠ resume: 저장된 근거가 digest 예산(${d.limit}B)을 넘어 재주입하지 않았습니다 (${d.bytes}B)`);
        }
    }
    // [§6.2 + A-3] run 수명 sessionBackend가 cache와 호출 예산을 소유한다. resume은 **durable 누적치**를
    // 이어받는다 — **프로세스 간 memo는 소실되므로** 같은 질의는 크레딧을 다시 쓴다(문서화된 한계).
    const sessionBackend = research.kind === "external"
        ? createSessionBackend(research.backend, research.scrub, {
            priorCalls: args.resume ? priorTotals.backend_calls : 0,
            priorResults: args.resume ? priorTotals.results : 0,
        })
        : null;
    const tokensSpent = () => usagePerAgent.reduce((s, u) => s + u.input_tokens + u.output_tokens, 0);
    // [B-41/1단] 앞 단계 승인 영수증에서 온 seed를 findings 체인의 **맨 앞**에 깐다.
    // key를 "agentId: …"의 접두사로 잡는 이유: 같은 agent가 이번 run에서 실행되면 persistFinalOutcome의
    // `findings.set(agent_id, …)`이 **같은 키를 덮어써** 최신 판단이 이긴다(Map은 자리를 유지한다).
    // 접두사가 없는 문자열은 덮어쓸 대상이 없으므로 그냥 추가된다(호출자 형식 오류를 조용히 버리지 않는다).
    // 미지정이면 이 루프가 0회 → findings 초기 상태 불변 → provider 입력 바이트 동일.
    for (const line of args.seedFindings ?? []) {
        const at = line.indexOf(":");
        findings.set(at > 0 ? line.slice(0, at) : `seed_${findings.size}`, line);
    }
    // ── resume: 이전 실패 지점부터 이어서 실행 ──────────────
    // 완료된 step은 재실행하지 않고 저장된 산출물을 컨텍스트(findings)로만 복원한다 (FAILURE_RECOVERY).
    let startIndex = 0;
    const prior = args.resume ? loadRunState(project) : null;
    if (args.resume) {
        if (!prior) {
            throw new Error(`재개할 run_state가 없습니다: ${project} (먼저 'harness run' 실행)`);
        }
        if (prior.status !== "failed" || prior.resume_from === null) {
            throw new Error(`재개할 실패 상태가 아닙니다 (status=${prior.status}) — 재개할 것이 없습니다.`);
        }
        if (prior.workflow_id !== workflowId) {
            throw new Error(`resume workflow 불일치: 이전 실행은 '${prior.workflow_id}' — 같은 workflow로 재개하라.`);
        }
        startIndex = prior.resume_from;
        completed_steps.push(...prior.completed_steps);
        warnings.push(...prior.warnings);
        regenerations.push(...prior.regenerations);
        critique_rounds.push(...prior.critique_rounds);
        gate_jumps.push(...prior.gate_jumps);
        spawned_agents.push(...prior.spawned_agents);
        // 완료 step은 재개 시 재실행하지 않으므로 기존 타이밍을 그대로 보존한다 (중복/덮어쓰기 없음).
        // resume_from 이후 step만 새로 실행되어 새 타이밍이 추가된다.
        step_timings.push(...(prior.step_timings ?? []));
        design_gate = prior.design_gate ?? null;
        usagePerAgent.push(...prior.usage.per_agent);
        for (const id of prior.completed_steps) {
            const rel = resolveOutputRel(id, registry, prior);
            if (!rel)
                continue;
            const abs = join(projectPaths(project).root, rel);
            if (!existsSync(abs))
                continue;
            const md = readFileSync(abs, "utf8");
            findings.set(id, `${id}: ${extractMainJudgment(md)}`);
            lastMarkdown.set(id, md);
            restoredIds.add(id); // [B-49] 이 바이트는 이번 invocation의 모델 출력이 아니다
        }
        console.log(`  ↩ resume: step ${startIndex}부터 재개 (완료 ${completed_steps.length}개 복원)`);
    }
    // [C-125/R1-A] resume 힌트는 **한 번만** 쓴다. 게이트 되돌림(:1276의 `i = targetIdx - 1; continue`)이
    // 같은 critique_loop 인덱스를 다시 밟으므로, 힌트를 상시 참조하면 새 pass가 옛 실패의 라운드를
    // 이어받아 R1을 건너뛴다. (기각한 대안: pass id를 만들어 힌트에 결박 — 새 식별자 축이 늘고
    // durable 필드가 하나 더 생긴다.)
    let critiqueResumeHint = args.resume ? (prior?.loop_state ?? null) : null;
    const started_at = prior ? prior.started_at : now();
    const findingsList = () => Array.from(findings.values());
    // 한 step 실행의 step_start/step_end 이벤트를 방출하고 타이밍을 기록한다.
    // ok:false(예외/검증 실패)에도 반드시 step_end + 타이밍이 남도록 try/finally로 감싼다.
    function recordTiming(t) {
        step_timings.push(t);
    }
    // 한 agent를 실행하고 스키마 재생성 루프를 적용한다. runAgent throw는 호출자에 전파.
    async function runStepWithRegen(agent, nextAgentId, opts) {
        currentAgentId = agent.agent_id;
        const startedAtIso = now();
        const startedAt = Date.now();
        let markdown = "";
        let validation = { ok: false, missing: [] };
        let feedback;
        let attempt = 0;
        let usageIn = 0;
        let usageOut = 0;
        let sawUsage = false;
        let ok = false;
        // [C-126/B-1] digest 수신자는 **상수 allowlist**이고, `conclusion_only`(critic)에는 주지 않는다 —
        // 편향 분리가 그 모드의 존재 이유라서 근거를 주면 격리가 깨진다. 명시 인자(2차)가 우선한다.
        // digest가 null이면 undefined가 흘러 프롬프트 바이트가 기존과 동일하다(additive 계약).
        const digestForStep = opts.evidenceDigest ??
            (opts.kind === "agent" &&
                opts.contextMode !== "conclusion_only" &&
                evidenceDigest !== null &&
                EVIDENCE_DIGEST_RECIPIENTS.includes(agent.agent_id)
                ? evidenceDigest
                : undefined);
        reporter?.emit({
            type: "step_start",
            index: opts.stepIndex,
            total,
            agentId: agent.agent_id,
            kind: opts.kind,
            round: opts.round,
            label: opts.progressLabel,
        });
        try {
            // 테스트용 강제 실패 훅 (resume 검증): 지정 agent에서 throw. step_start 이후라 step_end(ok:false)가 남는다.
            if (process.env.HARNESS_FAIL_AT === agent.agent_id) {
                throw new Error(`강제 실패(HARNESS_FAIL_AT=${agent.agent_id})`);
            }
            while (true) {
                const res = await runAgent({
                    agent,
                    registry,
                    workflowId,
                    project,
                    createdAt: now(),
                    priorFindings: opts.priorFindingsOverride ?? findingsList(),
                    ideaContent: idea.text, // [A-1] run 시작 snapshot — agent마다 파일을 다시 읽지 않는다
                    contextMode: opts.contextMode,
                    nextAgentId,
                    provider,
                    retryFeedback: feedback,
                    revisionRequest: opts.revisionRequest,
                    spawnRequest: opts.spawnRequest,
                    researchRequest: opts.researchRequest,
                    evidenceDigest: digestForStep,
                    agentPromptText: opts.agentPromptText,
                    execContext,
                });
                markdown = res.markdown;
                if (res.usage) {
                    sawUsage = true;
                    usageIn += res.usage.inputTokens;
                    usageOut += res.usage.outputTokens;
                }
                validation = validateAgentOutput(markdown, agent.required_headers ?? []);
                if (validation.ok || attempt >= maxRegen)
                    break;
                attempt++;
                feedback =
                    `직전 출력에 필수 섹션 헤더가 누락되었다: ${validation.missing.join(", ")}. ` +
                        `누락된 "## <헤더>"를 정확한 이름으로 포함하여 문서 전체를 다시 작성하라. 문서 외 텍스트는 출력하지 마라.`;
                const msg = `  ↻ ${agent.agent_id}: 필수 섹션 누락(${validation.missing.join(", ")}) — 재생성 ${attempt}/${maxRegen}`;
                if (reporter)
                    reporter.emit({ type: "note", level: "warn", message: msg });
                else
                    console.warn(msg);
            }
            ok = validation.ok;
            return { markdown, validation, attempt, usageIn, usageOut, sawUsage, elapsedMs: Date.now() - startedAt };
        }
        finally {
            const elapsedMs = Date.now() - startedAt;
            reporter?.emit({
                type: "step_end",
                index: opts.stepIndex,
                agentId: agent.agent_id,
                kind: opts.kind,
                ok,
                elapsedMs,
                round: opts.round,
                tokens: sawUsage ? { in: usageIn, out: usageOut } : undefined,
            });
            recordTiming({ agent_id: agent.agent_id, kind: opts.kind, started_at: startedAtIso, elapsed_ms: elapsedMs, ok });
        }
    }
    /**
     * [C-126/A-2] **모든 LLM 호출 직후** 부른다 — 리서치 1차처럼 **저장하지 않는 호출도 포함**.
     *
     * 예전 `commitOutcome`은 usage 누산과 저장을 겸했다. 리서치 1차를 통째로 미commit하면 **1차 LLM
     * 비용이 `run_state.usage`와 `--max-tokens` 검사에서 사라진다**(2차·backend 실패 시 소비 전액 증발).
     * 그래서 "비용·경고는 호출의 사실"과 "저장은 채택의 사실"을 분리했다. 1차의 헤더 누락 경고도
     * 그 호출의 사실이므로 남긴다.
     */
    function recordOutcomeTelemetry(agent, o) {
        if (o.sawUsage) {
            usagePerAgent.push({ agent_id: agent.agent_id, input_tokens: o.usageIn, output_tokens: o.usageOut });
        }
        if (o.attempt > 0) {
            regenerations.push({ agent_id: agent.agent_id, attempts: o.attempt, resolved: o.validation.ok });
        }
        if (!o.validation.ok) {
            warnings.push({ agent_id: agent.agent_id, missing: o.validation.missing });
            // [C-127] 이 warn은 **채택 여부를 말하지 않는다** — 리서치 1차처럼 저장도 차단도 하지 않는
            // 호출에서도 나온다. 채택 지점의 판정은 persistFinalOutcome이 내린다.
            console.warn(`  ⚠ ${agent.agent_id}: 필수 섹션 누락 — ${o.validation.missing.join(", ")}`);
        }
    }
    /**
     * [C-126/A-2] **최종 채택본만** 저장한다 (saveArtifact·token_output·completed_steps·findings).
     *
     * [C-127] 채택(저장→완료 등재→findings)의 **유일한 관문**이라서 필수 섹션 가드가 여기 있다.
     * 기각한 대안: `runStepWithRegen` 안에서 throw — ⓐ 리서치 **1차**를 과차단한다(1차는 채택본이
     * 아니고 2차가 교정 기회다) ⓑ 그 throw가 usage 누산 이전에 나가 **1차 LLM 비용이 run_state에서
     * 사라진다**(C-126/A-2가 막은 바로 그 회귀).
     */
    function persistFinalOutcome(agent, o) {
        // [C-127/A-1] **검증이 저장보다 먼저다.** 계약 미충족이면 디스크를 아예 건드리지 않는다.
        //
        // 기각한 대안(C-127 초판이 실제로 이렇게 짰다): `saveArtifact` 뒤에서 차단 —
        // **이미 채택된 정상 산출물을 깨진 바이트로 파괴한다.** 최초 채택이면 무해하지만
        // 비평 루프의 revise는 `completed_steps`에 **이미 들어 있는** agent의 문서를 덮는다
        // (`registry/workflows.json`의 mvp-planning: tech_lead는 critique_loop 진입 전에 completed).
        // 그 revise가 계약 미달이면 ① 정상 문서가 깨진 바이트로 덮이고 ② tech_lead는
        // `completed_steps`에서 제거되지 않으므로 ③ resume이 그 깨진 파일을 완료 산출물로
        // 복원하고(findings 복원 루프) ④ critic이 이번엔 Critical 0을 내면 revise 없이 루프가 끝나
        // ⑤ 최종 manifest가 **깨진 문서를 결박**한다. C-127이 닫으려던 거짓 영수증을
        // C-127이 새로 만드는 모양이었다 (Codex 적대적 리뷰 A-1).
        //
        // 초판이 "저장은 하고 채택만 막는다"를 택했던 근거 둘은 이 발견으로 뒤집힌다:
        // ⓐ "운영자가 깨진 문서를 봐야 판단한다" → 실제로 필요한 정보(누락 **헤더 이름**)는
        //    이미 `warnings[]`와 콘솔 경고에 정확히 있다. 문서 전문은 그 판단에 필요 없다.
        // ⓑ "`savedFiles` 등재로 파이프라인 drift 정합이 공짜" → 아무것도 안 썼으면 drift가 없다.
        if (!o.validation.ok) {
            throw new RequiredSectionsMissing(`${agent.agent_id}: 필수 섹션 미충족(${o.validation.missing.join(", ")}) — 재생성 ${maxRegen}회 후에도 계약 미달. ` +
                `${agent.default_output}에 쓰지 않고 채택도 하지 않는다 (기존 산출물 보존).`);
        }
        const saved = saveArtifact(project, agent.default_output, o.markdown);
        savedFiles.push(saved);
        // design 에이전트: 산출 markdown의 ```json 블록을 tokens.json으로 분리 저장(결정 B).
        if (agent.token_output) {
            const tokens = extractTokensJson(o.markdown);
            if (tokens) {
                const tSaved = saveArtifact(project, agent.token_output, tokens);
                savedFiles.push(tSaved);
                console.log(`  ⿻ ${agent.agent_id}: 토큰 추출 → ${tSaved}`);
            }
            else {
                console.warn(`  ⚠ ${agent.agent_id}: ${agent.token_output} 추출 실패 — 산출물에 \`\`\`json 블록 없음`);
            }
        }
        if (!completed_steps.includes(agent.agent_id))
            completed_steps.push(agent.agent_id);
        findings.set(agent.agent_id, `${agent.agent_id}: ${extractMainJudgment(o.markdown)}`);
        lastMarkdown.set(agent.agent_id, o.markdown);
        // [B-49] 복원 바이트가 이번 invocation의 실제 출력으로 덮였다 — 게이트 되돌림 재실행 ·
        // 더 앞 step부터의 resume · critique revise 덮어쓰기 세 경우 모두 여기를 지난다.
        restoredIds.delete(agent.agent_id);
        return saved;
    }
    /**
     * [C-126/§5.1] 리서치 step (형태 B — LLM 2회).
     *
     * 1차(선언 지시 주입 · telemetry만) → 말미 판정 → `runResearch` → 2차(1차 전문 + digest) →
     * **최종 1회 저장**. attempt는 성공·실패 무관하게 **불변 receipt 파일**로 봉인된다.
     *
     * 실패는 전부 **resumable failed**(원인별 사유 코드)다 — "외부 실패 시 자체로 계속"은 사용자
     * 결정 대기 항목이라 구현하지 않았다(설계 §10). 그 옵트인이 없으면 fail closed가 유일한 정직한 답이다.
     */
    async function runWebResearchStep(agent, i, nextAgentId, spawnRequest) {
        const attempt = {
            started_at: now(),
            mode: null,
            requests: [],
            backend_calls: 0,
            cache_hits: 0,
            dropped_by_domain: 0,
            first_pass_sha256: null,
            evidence: [],
            receipt_path: "",
            raw_paths: [],
        };
        // [B-1] 새 attempt가 시작되면 앞 attempt의 digest는 소거한다 — 게이트가 research로 되돌린 뒤에도
        // 옛 근거가 하류 프롬프트에 남아 있으면 그것이 "이번 판단의 근거"라고 거짓말한다.
        evidenceDigest = null;
        const label = `[${i + 1}/${total}] ${agent.agent_id}`;
        let sealed = false;
        /**
         * [C-126/A-2] attempt를 봉인한다: receipt write-once → savedFiles → attempts(표시 상한).
         *
         * **정확히 한 번**이고 **fail closed**다. 예전 판은 `writeResearchReceipt` 예외를 `console.warn`으로
         * 삼키고 성공 판정을 유지했다 — 그러면 **영수증 없는 completed 문서가 pending으로 가고**, 이전 성공
         * attempt가 있으면 `runStateSources`가 **현재 문서가 아닌 옛 receipt를 결박**한다(승인 바이트가
         * 다른 run의 근거를 증언한다). 영수증을 못 쓰면 그 단계는 성공이 아니다.
         */
        const seal = (mode, errorCode) => {
            if (sealed)
                return; // 아래 catch/finally와 정상 경로가 겹쳐도 두 번 적히지 않는다
            sealed = true;
            attempt.mode = mode;
            if (errorCode)
                attempt.error_code = errorCode;
            // receipt와 raw는 checkpoint 결박 대상이고, 실패 시엔 `last_failure.written`에 잡혀야 한다
            // (그래서 resume 사전 drift 검증이 partial 저장을 "손댄 것"으로 오해하지 않는다).
            attempt.receipt_path = writeResearchReceipt(projectRoot, attempt); // 실패는 throw — 삼키지 않는다
            savedFiles.push(attempt.receipt_path);
            researchAttempts.push(attempt);
            if (researchAttempts.length > RESEARCH_MAX_ATTEMPTS) {
                // 표시용 상한. **상한 집행 근거는 이 배열이 아니라 durable `totals`다**(A-3).
                researchAttempts.splice(0, researchAttempts.length - RESEARCH_MAX_ATTEMPTS);
            }
        };
        /** 성공 반환 직전 불변식: **영수증 없는 성공 상태는 없다.** */
        const requireSealed = () => {
            if (!sealed || !attempt.receipt_path) {
                throw new ResearchError("research_receipt_missing", "리서치 영수증 없이 성공으로 판정할 수 없다 (결박 대상이 비어 있다)");
            }
        };
        // attempt 시작 이후의 **모든** 경로를 감싼다: self/1차 provider throw도 예전에는 seal 밖에서
        // 났고, 그래서 영수증 없이 문서가 저장될 수 있었다.
        try {
            // ── self: 키 부재 → 외부 호출 0회 (기존 동작과 같은 1-LLM step) ──
            if (research.kind !== "external" || sessionBackend === null) {
                const o = await runStepWithRegen(agent, nextAgentId, { spawnRequest, progressLabel: label, stepIndex: i + 1, kind: "agent" });
                recordOutcomeTelemetry(agent, o);
                const saved = persistFinalOutcome(agent, o);
                seal("self");
                requireSealed();
                return { ok: true, saved, elapsedMs: o.elapsedMs, mode: "self" };
            }
            const scrub = research.scrub;
            // ── 1차: 선언 지시 주입 · **telemetry만**(미저장) ──
            const first = await runStepWithRegen(agent, nextAgentId, {
                spawnRequest,
                researchRequest: RESEARCH_DECLARATION_INSTRUCTION,
                progressLabel: `${label} (1차 · 검색 선언)`,
                stepIndex: i + 1,
                kind: "agent",
            });
            recordOutcomeTelemetry(agent, first);
            attempt.first_pass_sha256 = sha256Of(first.markdown);
            const decl = parseResearchDeclaration(first.markdown);
            if (decl.kind === "missing") {
                seal(null, "research_declaration_missing");
                return { ok: false, reason: "research_declaration_missing", detail: `문서 말미에 선언도 'RESEARCH_REQUEST none'도 없다` };
            }
            if (decl.kind === "invalid") {
                seal(null, "research_declaration_invalid");
                return { ok: false, reason: "research_declaration_invalid", detail: scrub(decl.detail) };
            }
            if (decl.kind === "none") {
                // 명시 종결자 — 모델이 "검색 불필요"를 선언했다. 1차가 곧 최종본이다.
                const saved = persistFinalOutcome(agent, first);
                seal("external_declined");
                requireSealed();
                return { ok: true, saved, elapsedMs: first.elapsedMs, mode: "external_declined" };
            }
            attempt.requests = decl.requests.map((r) => ({ redacted_query: redactedQuery(r.query, scrub) }));
            console.log(`  🔎 ${agent.agent_id}: 검색 선언 ${decl.requests.length}건 — 외부 검색(Tavily)으로 전송합니다`);
            // ── 검색 실행 ──
            const callsAt = sessionBackend.calls;
            const hitsAt = sessionBackend.memoHits;
            // [B-3] cache_hits는 **두 계층의 합**이다: sessionBackend memo(attempt 간)와 gateway의
            // per-call cache(같은 질의 두 줄). memo delta만 적으면 "같은 query 두 줄"에서 0으로 증언한다.
            const memoDelta = () => sessionBackend.memoHits - hitsAt;
            try {
                const res = await runResearch(decl.requests, {
                    backend: sessionBackend,
                    evidenceDir: join(projectRoot, RESEARCH_DIR_REL),
                    now,
                    // [§5.4] extract 봉인: `null`이면 extract는 **전부 거부**되고 search는 좁혀지지 않는다.
                    allowedDomains: null,
                    // [A-4] partial을 사실대로 적는 유일한 자리 — 뒤 항목이 throw해도 앞 저장은 남는다.
                    onStored: (item, rel) => {
                        // [C-138/②] 예산 누산은 **저장이 성공한 이 자리**다(배치 수신 시점이 아니다).
                        sessionBackend.noteStored(1);
                        attempt.evidence.push(item);
                        const projRel = `${RESEARCH_DIR_REL}/${rel.split(sep).join("/")}`;
                        attempt.raw_paths.push(projRel);
                        savedFiles.push(projRel);
                    },
                });
                attempt.dropped_by_domain = res.droppedByDomain;
                if (res.droppedByStore > 0) {
                    // [C-138/①] 버린 사실은 **영수증과 콘솔 양쪽에** 남는다 — 조용한 손실은 만들지 않는다.
                    attempt.dropped_by_store = res.droppedByStore;
                    console.warn(`  ⚠ ${agent.agent_id}: 검색 결과 ${res.droppedByStore}건은 저장 규칙(https URL 등) 위반으로 버렸습니다 (나머지는 그대로 반영)`);
                }
                attempt.backend_calls = sessionBackend.calls - callsAt;
                attempt.cache_hits = memoDelta() + res.cacheHits;
            }
            catch (err) {
                attempt.backend_calls = sessionBackend.calls - callsAt;
                attempt.cache_hits = memoDelta(); // throw 경로에는 gateway 집계가 없다 (memo delta만)
                const code = err instanceof ResearchError ? err.code : "research_backend_error";
                const reason = code.startsWith("research_") ? code : "research_backend_error";
                seal(null, reason);
                return { ok: false, reason, detail: scrub(err.message) };
            }
            // ── 결과 0건: API는 정상이었고 후보가 없었다 (실패가 아니다) ──
            if (attempt.evidence.length === 0) {
                const saved = persistFinalOutcome(agent, first);
                seal("external_empty");
                requireSealed();
                return { ok: true, saved, elapsedMs: first.elapsedMs, mode: "external_empty" };
            }
            // ── 예산 (§6.3 · byte 단위 · 절단 금지) ──
            const firstBytes = Buffer.byteLength(first.markdown, "utf8");
            if (firstBytes > RESEARCH_FIRST_PASS_MAX_BYTES) {
                seal(null, "research_first_pass_too_large");
                return {
                    ok: false,
                    reason: "research_first_pass_too_large",
                    detail: `1차 문서가 ${firstBytes}B로 상한 ${RESEARCH_FIRST_PASS_MAX_BYTES}B를 넘는다 (자르지 않는다 — 근거 반영이 무의미해진다)`,
                };
            }
            const digest = buildEvidenceDigest(attempt.evidence);
            if (!digest.ok) {
                seal(null, "research_budget_exceeded");
                return {
                    ok: false,
                    reason: "research_budget_exceeded",
                    detail: `근거 digest가 ${digest.bytes}B로 상한 ${digest.limit}B를 넘는다 (조용히 자르지 않는다)`,
                };
            }
            // ── 2차: 1차 전문 + digest → **이것만 저장** ──
            let second;
            try {
                second = await runStepWithRegen(agent, nextAgentId, {
                    revisionRequest: secondPassRequest(first.markdown, attempt.first_pass_sha256),
                    evidenceDigest: digest.digest,
                    progressLabel: `${label} (2차 · 근거 반영)`,
                    stepIndex: i + 1,
                    kind: "revise",
                });
            }
            catch (err) {
                // [B-2] 2차 실패도 **안정 사유 코드로 돌려준다.** 예전엔 원래 예외를 다시 throw해서 outer
                // catch가 `failed_reason = err.message`로 덮었고, 그러면 복구 안내(`research_` 접두사 검사)가
                // 이 실패를 못 보고 attempt의 코드만 고립됐다.
                seal(null, "research_second_pass_failed");
                return { ok: false, reason: "research_second_pass_failed", detail: scrub(err.message) };
            }
            recordOutcomeTelemetry(agent, second);
            const saved = persistFinalOutcome(agent, second);
            evidenceDigest = digest.digest; // 하류 수신자(pm·red_team·founder_ceo)에게 전달
            seal("external");
            requireSealed();
            return { ok: true, saved, elapsedMs: second.elapsedMs, mode: "external" };
        }
        catch (err) {
            // provider throw·영수증 실패·예상 밖 예외 — **어떤 경로든 attempt는 봉인된다.**
            // seal 자체가 실패하면 그 사실을 알리되 원래 실패를 가리지 않는다(둘 다 run을 죽인다).
            try {
                seal(null, "research_step_failed");
            }
            catch (sealErr) {
                console.error(`  ✗ ${agent.agent_id}: 리서치 영수증 기록 실패 — ${sealErr.message}`);
            }
            throw err;
        }
    }
    // 실행 생명주기: run_start → (step_*)* → run_end. run_end는 예외가 나도 반드시 방출되도록
    // try/finally로 감싼다 (렌더러의 spinner interval/stderr 정리 보장).
    reporter?.emit({
        type: "run_start",
        workflow: workflowId,
        totalSteps: total,
        resumeFrom: args.resume ? startIndex : undefined,
    });
    const runStartMs = Date.now();
    let runStatus = "failed";
    try {
        for (let i = startIndex; i < workflow.steps.length; i++) {
            // ── 토큰 예산 검사 (step 경계) ──────────────────
            if (maxTokens > 0) {
                const spent = tokensSpent();
                if (spent >= maxTokens) {
                    failed_reason = "token_budget_exceeded";
                    failedIndex = i; // 아직 실행 안 한 step — resume 시 여기부터
                    budgetStopped = true;
                    console.error(`  ✗ 토큰 예산 초과: ${spent}/${maxTokens} — step ${i} 앞에서 중단 (--resume으로 재개)`);
                    break;
                }
                if (!warned80 && spent >= maxTokens * 0.8) {
                    warned80 = true;
                    console.warn(`  ⚠ 토큰 예산 80% 도달: ${spent}/${maxTokens}`);
                }
            }
            const step = workflow.steps[i];
            try {
                if (typeof step === "string") {
                    // ── 일반 step ──────────────────────────────
                    const agent = findAgent(registry, step);
                    if (!agent) {
                        failed_agent = step;
                        failed_reason = `registry에 없는 agent: ${step}`;
                        failedIndex = i;
                        console.error(`  ✗ ${step}: registry에 없는 agent — 중단`);
                        break;
                    }
                    // 다음 step이 이 agent를 planner로 하는 fanout이면, 하위 에이전트 선언을 유도한다.
                    const nx = workflow.steps[i + 1];
                    let spawnRequest;
                    if (nx && isFanout(nx) && nx.fanout.planner === step) {
                        const max = Math.max(1, nx.fanout.max_agents ?? 1);
                        spawnRequest =
                            `이 계획을 실제로 진행할 때 병렬/전문화하면 좋은 하위 에이전트가 있으면, ` +
                                `문서 맨 끝에 아래 형식으로 각 줄에 정확히 나열하라 (최대 ${max}개):\n` +
                                `SPAWN id=<영문소문자_id> | name=<이름> | focus=<한 줄 담당 범위>\n` +
                                `분화가 불필요하면 정확히 "SPAWN none" 한 줄만 출력하라.`;
                    }
                    // [C-126] `web_research: true` agent는 리서치 step이다 (1차 선언 → 검색 → 2차 반영).
                    // 그 밖의 step은 이 분기를 지나지 않으므로 프롬프트·저장 동작이 완전히 동일하다.
                    if (agent.web_research) {
                        const rr = await runWebResearchStep(agent, i, nextHint(workflow.steps, i), spawnRequest);
                        if (!rr.ok) {
                            failed_agent = agent.agent_id;
                            failed_reason = rr.reason;
                            failedIndex = i; // resume 시 이 step부터 — 원인을 고치면 리서치가 재실행된다
                            console.error(`  ✗ ${agent.agent_id}: 리서치 중단(${rr.reason})${rr.detail ? ` — ${rr.detail}` : ""}`);
                            break;
                        }
                        console.log(`  [${i + 1}/${total}] ✓ ${agent.agent_id} → ${rr.saved} (${fmtElapsed(rr.elapsedMs)}) · 리서치 ${rr.mode}`);
                        continue;
                    }
                    const o = await runStepWithRegen(agent, nextHint(workflow.steps, i), {
                        spawnRequest,
                        progressLabel: `[${i + 1}/${total}] ${agent.agent_id}`,
                        stepIndex: i + 1,
                        kind: "agent",
                    });
                    recordOutcomeTelemetry(agent, o);
                    const saved = persistFinalOutcome(agent, o);
                    console.log(`  [${i + 1}/${total}] ✓ ${agent.agent_id} → ${saved} (${fmtElapsed(o.elapsedMs)})`);
                    continue;
                }
                if (isGate(step)) {
                    // ── CEO 게이트 분기 ────────────────────────────
                    const { decider, on, kill } = step.gate; // [B-49] max_jumps는 remainingJumps가 step.gate에서 직접 읽는다
                    const gateStartIso = now();
                    const gateT0 = Date.now();
                    reporter?.emit({ type: "step_start", index: i + 1, total, agentId: decider, kind: "gate" });
                    const endGate = (ok) => {
                        const elapsedMs = Date.now() - gateT0;
                        reporter?.emit({ type: "step_end", index: i + 1, agentId: decider, kind: "gate", ok, elapsedMs });
                        recordTiming({ agent_id: decider, kind: "gate", started_at: gateStartIso, elapsed_ms: elapsedMs, ok });
                    };
                    if (!completed_steps.includes(decider)) {
                        failed_agent = decider;
                        failed_reason = `gate decider '${decider}'가 게이트 전에 실행되지 않음`;
                        failedIndex = i;
                        console.error(`  ✗ gate: decider '${decider}'이(가) 게이트 전에 실행되지 않음 — 중단`);
                        endGate(false);
                        break;
                    }
                    const remaining = remainingJumps(step.gate); // [B-49] 영수증 파생 — resume에서 되살아나지 않는다
                    const deciderMd = lastMarkdown.get(decider) ?? "";
                    // ── 판정은 구조에서 읽는다 (산문 부분문자열 매칭 아님) ──
                    // decider 출력의 "## Decision" 절에서 정본 토큰 하나를 뽑는다. 산문 매칭은 **누락이 fail open**이라
                    // ('중단한다'·'드롭한다' 같은 폐기 표현이 어떤 키워드 목록에도 안 걸린다) 게이트에 쓸 수 없다.
                    // 절이 없거나 토큰이 애매하면 **진행하지 않고 멈춘다** — 조용히 통과하는 경로를 남기지 않는 것이 요점.
                    const parsed = extractCeoDecision(deciderMd);
                    if ("error" in parsed) {
                        failed_agent = decider; // 실행이 아니라 산출물이 계약 위반 — 기존 gate 오류와 같은 자리에 기록
                        failed_reason = parsed.error === "absent" ? "ceo_decision_absent" : "ceo_decision_ambiguous";
                        failedIndex = i; // resume 시 이 게이트부터: 사람이 decider 문서의 "## Decision"을 고치면 재개된다
                        console.error(`  ✗ 게이트: ${decider} 출력의 "## Decision" 정본 판정을 읽을 수 없음 (${failed_reason}) — ` +
                            `중단. 허용 토큰: ${CEO_DECISION_TOKENS.join(" | ")} 중 정확히 하나`);
                        endGate(false);
                        break;
                    }
                    const decision = parsed.token;
                    // [B-49] 판정 출처. decider가 이번 invocation에서 실행되지 않았다면(=게이트가 복원 문서의
                    // 바이트를 읽었다면) 그 사실만 entry에 남긴다 — 저자를 증명하지는 않는다(타입 주석 참조).
                    const src = restoredIds.has(decider) ? { decision_source: "restored_artifact" } : {};
                    // ── kill 판정은 jump/진행보다 먼저 ─────────────────
                    // 순서가 뒤바뀌면 되돌림이 이겨 죽은 아이디어가 한 바퀴 더 돈다. kill을 앞에 두면 최악이
                    // "사람이 새 run으로 다시 시작"이고, 뒤에 두면 최악이 "미달 아이디어를 그대로 개발 착수" —
                    // 후자가 이 게이트가 존재하는 이유 그 자체다. 그래서 멈추는 쪽으로 fail closed.
                    if (kill?.includes(decision)) {
                        const idea_sha256 = idea.sha256; // [A-1] CEO가 실제로 판정한 바이트의 digest (재읽기 없음)
                        killed_by = { decider, decision, idea_sha256 };
                        kill_history.push({ decider, decision, idea_sha256, at: now() });
                        cleared_idea_sha256 = null; // 폐기는 이전 해제를 무효화한다 (다시 재평가를 받아야 한다)
                        gate_jumps.push({ decider, decision, jumped_to: null, outcome: "kill", ...src });
                        console.log(`  ⛔ 게이트: ${decider} 판정 '${decision}' → run 종료(killed) — 후속 단계 미실행`);
                        endGate(true); // 게이트 자체는 정상 동작했다 (판정을 내리는 것이 이 step의 일)
                        break;
                    }
                    const jumpTarget = on[decision] ?? null;
                    // [C] 대상 존재 여부를 **예산보다 먼저** 판정한다. 예전엔 target 확인이 `remaining > 0` 안에만
                    // 있어서, 예산이 0이면 정의 오류(step 부재)가 `gate_jump_budget_exhausted`로 기록됐다 —
                    // fail closed이긴 하나 "원인마다 다른 코드"라는 계약이 깨진다.
                    const targetIdx = jumpTarget === null ? -1 : workflow.steps.findIndex((s) => s === jumpTarget);
                    const targetMissing = jumpTarget !== null && targetIdx < 0;
                    if (jumpTarget !== null && !targetMissing && remaining > 0) {
                        // [B-49] 차감 없음: 직후 push되는 이 jump entry가 곧 차감이다 (예산은 영수증 파생).
                        gate_jumps.push({ decider, decision, jumped_to: jumpTarget, outcome: "jump", ...src });
                        reporter?.emit({ type: "gate_jump", decider, decision, target: jumpTarget }); // 실제 jump일 때만
                        console.log(`  ⤴ 게이트: ${decider} 판정 '${decision}' → ${jumpTarget} 되돌림 (남은 되돌림 ${remaining - 1})`);
                        endGate(true);
                        i = targetIdx - 1; // 다음 i++가 targetIdx를 가리킴
                        continue;
                    }
                    // ── 게이트 통과는 '진행' 토큰 하나뿐 ────────────────
                    // 예전에는 kill도 jump도 아닌 모든 판정이 "→ 진행"으로 떨어졌다. 그래서 '보류'(백로그)와
                    // '검증'(개발하지 않음)이 진행하고, 되돌림 예산이 소진되면 같은 '축소' 판정이 진행으로 바뀌고,
                    // run이 completed가 되어 task-prompt·handoff까지 열렸다 — 상태 전이 우회 + 거짓 성공 영수증.
                    // 통과 조건을 화이트리스트로 뒤집고, 그 밖은 **원인별로 다른 코드**로 멈춘다
                    // (원인과 다른 코드를 적는 것은 이 레포가 C-96으로 잡은 부류다).
                    if (decision === "진행") {
                        gate_jumps.push({ decider, decision, jumped_to: null, outcome: "proceed", ...src });
                        console.log(`  ⤴ 게이트: ${decider} 판정 '진행' → 진행`);
                        // [A-3] 폐기 잠금 해제 증거는 **이 자리에서만** 발급한다: kill 게이트가 있는 게이트가
                        // '진행'을 낸 순간. 다른 경로에서 적으면 그 경로가 곧 우회 통로가 된다.
                        // [A-1] 해제되는 것은 **CEO가 실제로 심사한 바이트**다. 여기서 파일을 다시 읽으면 판정 후
                        // 바뀐 내용(CEO가 본 적 없는 것)이 해제된다.
                        if ((kill ?? []).length > 0)
                            cleared_idea_sha256 = idea.sha256;
                        endGate(true);
                        continue;
                    }
                    failed_agent = decider;
                    failed_reason = targetMissing
                        ? "gate_jump_target_missing" // on에 있지만 그 step이 workflow에 없다 (정의 오류 — 예산과 무관)
                        : jumpTarget === null
                            ? decision === "보류"
                                ? "ceo_decision_hold" // 판정 자체가 "지금은 하지 않는다" — 매핑 부재와 구분한다
                                : "ceo_decision_unmapped" // 이 workflow에 해당 판정의 되돌림 대상이 없다
                            : "gate_jump_budget_exhausted"; // 되돌려 봤는데 판정이 그대로다
                    failedIndex = i;
                    gate_jumps.push({ decider, decision, jumped_to: null, outcome: "failed", reason: failed_reason, ...src });
                    // 문구를 렌더러(gateOutcomeLabel)와 같은 형태로 맞춘다: "→ 진행하지 않고 중단"은
                    // "판정 X → 진행"을 부분문자열로 포함해 로그 grep·단정을 오염시킨다.
                    console.error(`  ✗ 게이트: ${decider} 판정 '${decision}' → 중단(${failed_reason})`);
                    endGate(false);
                    break;
                }
                if (isFanout(step)) {
                    // ── 동적 분화 (하위 전문 에이전트) ────────────────
                    const { planner, max_agents } = step.fanout;
                    if (!completed_steps.includes(planner)) {
                        failed_agent = planner;
                        failed_reason = `fanout planner '${planner}'가 분화 전에 실행되지 않음`;
                        failedIndex = i;
                        console.error(`  ✗ fanout: planner '${planner}'이(가) 분화 전에 실행되지 않음 — 중단`);
                        break;
                    }
                    const max = Math.max(1, max_agents ?? 1);
                    const specs = extractSpawnDeclarations(lastMarkdown.get(planner) ?? "").slice(0, max);
                    console.log(`  ⑂ 분화: ${planner}가 선언한 하위 에이전트 ${specs.length}개${specs.length ? ` — ${specs.map((s) => s.id).join(", ")}` : ""}`);
                    if (specs.length === 0) {
                        console.log(`  ⑂ 분화 없음 — 진행`);
                        continue;
                    }
                    const plannerPlan = lastMarkdown.get(planner) ?? "";
                    for (const spec of specs) {
                        if (!allowSpawn) {
                            spawned_agents.push({ parent: planner, id: spec.id, name: spec.name, focus: spec.focus, executed: false, output: null });
                            continue;
                        }
                        const subAgent = {
                            agent_id: `spawn_${spec.id}`,
                            name: spec.name,
                            role: spec.focus,
                            prompt_path: "",
                            default_output: `outputs/spawned/${spec.id}.md`,
                        };
                        const brief = `너는 '${spec.name}' 전문 에이전트다. 담당 범위: ${spec.focus}.\n` +
                            `아래는 상위 '${planner}'의 전체 계획이다. 이 중 네 담당 범위에 해당하는 부분을 구체화하라.\n\n` +
                            `--- 상위 계획 시작 ---\n${plannerPlan}\n--- 상위 계획 끝 ---`;
                        const so = await runStepWithRegen(subAgent, undefined, {
                            agentPromptText: brief,
                            progressLabel: `[${i + 1}/${total}] ${spec.name} (하위)`,
                            stepIndex: i + 1,
                            kind: "spawn",
                        });
                        recordOutcomeTelemetry(subAgent, so);
                        const saved = persistFinalOutcome(subAgent, so);
                        spawned_agents.push({ parent: planner, id: spec.id, name: spec.name, focus: spec.focus, executed: true, output: saved });
                        console.log(`  ⑂ 하위 실행: ${spec.id} (${spec.name}) → ${saved} (${fmtElapsed(so.elapsedMs)})`);
                    }
                    if (!allowSpawn) {
                        console.log(`  ⑂ 계획만 기록 (실행하려면 --allow-spawn) — 사람 승인 게이트`);
                    }
                    continue;
                }
                if (isApproval(step)) {
                    // ── 승인 게이트 ────────────────────────────────
                    const { message, show } = step.approval;
                    const apprStartIso = now();
                    const apprT0 = Date.now();
                    reporter?.emit({ type: "step_start", index: i + 1, total, agentId: "approval", kind: "approval" });
                    const endApproval = (ok) => {
                        const elapsedMs = Date.now() - apprT0;
                        reporter?.emit({ type: "step_end", index: i + 1, agentId: "approval", kind: "approval", ok, elapsedMs });
                        recordTiming({ agent_id: "approval", kind: "approval", started_at: apprStartIso, elapsed_ms: elapsedMs, ok });
                    };
                    if (show) {
                        const abs = join(projectPaths(project).root, show);
                        if (existsSync(abs)) {
                            console.log(`\n--- 승인 검토 문서: ${show} ---\n${readFileSync(abs, "utf8")}\n--- (문서 끝) ---`);
                        }
                    }
                    const isDesignGate = Boolean(step.approval.tokens_path);
                    // [B-41/1단] 응답자 부재는 **자동 승인이 아니다**. 여기까지 approve가 없다는 것은 위
                    // preflight가 뚫린 것이므로(도달 불가) 승인하지 않고 멈춘다 — 이 자리에 `: true`를
                    // 되살리면 preflight가 있어도 fail open이 복구된다.
                    if (!approve)
                        throw new Error(`approval_approver_missing: 승인 게이트에 응답자가 없습니다 ("${message}")`);
                    const ok = await approve(message, show);
                    if (!ok) {
                        if (isDesignGate)
                            design_gate = { status: "pending", tokens_hash: null };
                        failed_reason = "user_rejected";
                        failedIndex = i; // 승인 step 자체 — resume 시 다시 묻는다
                        rejected = true;
                        console.error(`  ✗ 승인 거부: "${message}" — 중단 (--resume으로 재개)`);
                        endApproval(false);
                        break;
                    }
                    if (isDesignGate) {
                        // 승인 시점 tokens.json 해시 기록 — 이후 코드화 단계에서 토큰 변경 감지용 (§4.3)
                        const tp = join(projectPaths(project).root, step.approval.tokens_path);
                        const hash = existsSync(tp) ? createHash("sha256").update(readFileSync(tp)).digest("hex") : null;
                        design_gate = { status: "approved", tokens_hash: hash };
                        console.log(`  ✔ 디자인 게이트 승인 — tokens_hash: ${hash ? hash.slice(0, 12) + "…" : "(tokens.json 없음)"}`);
                    }
                    else {
                        console.log(`  ✔ 승인: "${message}"`);
                    }
                    endApproval(true);
                    continue;
                }
                if (!isCritiqueLoop(step))
                    continue; // 알 수 없는 step 타입 방어
                // ── 비평 루프 step ─────────────────────────────
                const { target, critic, max_rounds } = step.critique_loop;
                const targetAgent = findAgent(registry, target);
                const criticAgent = findAgent(registry, critic);
                if (!targetAgent || !criticAgent) {
                    failed_agent = !targetAgent ? target : critic;
                    failed_reason = `critique_loop: registry에 없는 agent(${failed_agent})`;
                    failedIndex = i;
                    console.error(`  ✗ critique_loop: registry에 없는 agent(${failed_agent}) — 중단`);
                    break;
                }
                if (!completed_steps.includes(target)) {
                    // 설계 오류: 비평 대상이 루프 전에 실행되지 않음
                    failed_agent = critic;
                    failed_reason = `critique_loop: target '${target}'가 루프 전에 실행되지 않음`;
                    failedIndex = i;
                    console.error(`  ✗ critique_loop: target '${target}'이(가) 루프 전에 실행되지 않음 — 중단`);
                    break;
                }
                const maxRounds = Math.max(1, max_rounds ?? 1);
                // [C-125] resume은 라운드 예산을 다시 열지 않는다 — 실패한 라운드 하나만 재시도한다
                // (C-126 totals와 같은 규율: 재시도 호출은 다시 쓰되 누적 예산은 단조).
                const priorRound = critiqueResumeHint?.step_index === i ? (critiqueResumeHint.critique_round ?? 0) : 0;
                critiqueResumeHint = null; // 소비 — 위 [R1-A] 참조
                let round = priorRound > 0 ? priorRound - 1 : 0;
                let resolved = false;
                while (round < maxRounds) {
                    round++;
                    activeCritiqueRound = round;
                    // 1) critic 실행 — 편향 분리: critic은 비평 대상(target)의 결론만 보고 판단한다.
                    //    전체 findings 체인을 넘기면 앞선 에이전트 합의에 anchoring될 수 있어 target 결론만 격리.
                    const targetFinding = findings.get(target);
                    const co = await runStepWithRegen(criticAgent, target, {
                        contextMode: "conclusion_only",
                        priorFindingsOverride: targetFinding ? [targetFinding] : [],
                        progressLabel: `[${i + 1}/${total}] ${critic} (비평 R${round})`,
                        stepIndex: i + 1,
                        kind: "critic",
                        round,
                    });
                    recordOutcomeTelemetry(criticAgent, co);
                    const criticSaved = persistFinalOutcome(criticAgent, co);
                    console.log(`  ✓ ${critic} → ${criticSaved} (${fmtElapsed(co.elapsedMs)})`);
                    // 2) Critical 리스크 추출
                    const critical = extractCriticalRisks(co.markdown);
                    console.log(`  ⚖ ${critic} 라운드 ${round}/${maxRounds}: Critical ${critical.length}건`);
                    if (critical.length === 0) {
                        resolved = true;
                        break;
                    }
                    if (round >= maxRounds)
                        break; // 라운드 소진 — 미해결로 종료
                    // 3) target에 Critical을 되먹여 revise
                    const revisionRequest = `${critic}가 다음 Critical 리스크를 제기했다:\n` +
                        critical.map((c, idx) => `${idx + 1}. ${c}`).join("\n") +
                        `\n이 리스크들을 정면으로 반영해 이전 판단을 수정하고 문서 전체를 다시 작성하라. ` +
                        `각 리스크에 대한 대응·완화책을 Decisions / Assumptions / Risks에 반영하라.`;
                    const to = await runStepWithRegen(targetAgent, critic, {
                        revisionRequest,
                        progressLabel: `[${i + 1}/${total}] ${target} (수정 R${round})`,
                        stepIndex: i + 1,
                        kind: "revise",
                        round,
                    });
                    recordOutcomeTelemetry(targetAgent, to);
                    const targetSaved = persistFinalOutcome(targetAgent, to);
                    console.log(`  ✎ ${target} 라운드 ${round}: 비평 반영 수정 → ${targetSaved} (${fmtElapsed(to.elapsedMs)})`);
                }
                activeCritiqueRound = 0; // 루프 완주 — 이후 실패는 라운드에 결박되지 않는다
                critique_rounds.push({ target, critic, rounds: round, resolved });
                console.log(`  ⚖ 비평 루프 종료: ${critic}⟲${target} ${round}라운드, ${resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
            }
            catch (err) {
                failed_agent = currentAgentId || "(unknown)";
                // [C-127] 필수 섹션 미달만 안정 코드로 승격한다. 그 밖의 예외는 기존대로 message 그대로다.
                failed_reason = err instanceof RequiredSectionsMissing ? "required_sections_missing" : err.message;
                failedIndex = i;
                console.error(`  ✗ ${failed_agent}: 실행 실패 — ${err.message} — 중단`);
                break;
            }
        }
        const finished_at = now();
        const usage = {
            input_tokens: usagePerAgent.reduce((s, u) => s + u.input_tokens, 0),
            output_tokens: usagePerAgent.reduce((s, u) => s + u.output_tokens, 0),
            per_agent: usagePerAgent,
        };
        const stopped = failed_agent !== null || budgetStopped || rejected;
        // kill은 failed의 한 종류가 아니다: 실패 누산기(failed_agent/budgetStopped/rejected)를 전혀 건드리지 않으므로
        // stopped=false다. 따라서 resume_from/loop_state는 자연히 null이 되고(killed는 재개 불가), status만 갈라진다.
        runStatus = killed_by ? "killed" : stopped ? "failed" : "completed";
        const state = {
            workflow_id: workflowId,
            project,
            provider: provider.id,
            status: runStatus,
            completed_steps,
            failed_agent,
            failed_reason: stopped ? failed_reason : null,
            killed_by,
            kill_history,
            cleared_idea_sha256,
            resume_from: stopped ? failedIndex : null,
            loop_state: stopped && failedIndex !== null
                ? { step_index: failedIndex, ...(activeCritiqueRound > 0 ? { critique_round: activeCritiqueRound } : {}) }
                : null,
            warnings,
            regenerations,
            critique_rounds,
            gate_jumps,
            spawned_agents,
            design_gate,
            step_timings,
            usage,
            started_at,
            finished_at,
            // [C-126] attempt가 하나도 없으면 필드 자체를 내지 않는다 — 구버전 run_state와 바이트 동일
            // (리서치 agent가 없는 workflow의 run_state.json이 이 슬라이스 때문에 커지지 않는다).
            // [A-3] `totals`는 **단조 증가**다: sessionBackend가 있으면 그 누적치(prior 포함)를 그대로 쓰고,
            // 없으면(self) 이전 값을 내린다 — 어느 경로에서도 줄지 않는다.
            ...(researchAttempts.length > 0
                ? {
                    research: {
                        attempts: researchAttempts,
                        totals: sessionBackend
                            ? { backend_calls: sessionBackend.calls, results: sessionBackend.results }
                            : { backend_calls: priorTotals.backend_calls, results: priorTotals.results },
                    },
                }
                : {}),
        };
        // run_state.json은 성공/실패와 무관하게 항상 기록. **tmp + rename(원자)** 으로 쓴다.
        //
        // [C-135] 왜 직접 writeFileSync가 아닌가 — 실측 근거: `pipeline status`는 **설계상 lock 없이**
        // 이 파일을 읽는다(commands/pipeline.ts 머리 주석). 직접 쓰기는 O_TRUNC와 write(2) 사이에
        // 0바이트 창을 남기고, 그 창을 lock 없는 독자가 실제로 본다 —
        // 동시 `pipeline next` 20회분 창에서 **run_state 2/102,259 파싱 실패**, 같은 창에서 이미
        // tmp+rename으로 쓰던 pipeline_state는 **0/106,064**였다(scripts/c135-concurrency.sh ⓐ).
        // 찢어진 바이트를 본 독자는 `status`면 폐기 경고를 조용히 빠뜨리고, `next`면
        // `run_state_unreadable`로 exit 2를 내며 사람에게 파일 복구를 시킨다.
        // 같은 레포의 writePipelineState(core/pipeline.ts)·orchestrationStore가 쓰는 그 패턴 그대로다
        // (공용 헬퍼를 새로 만들지 않았다 — 세 번째 사용처이고, 모듈을 새로 얽으면 순환이 생긴다).
        const runStateAbs = join(projectPaths(project).root, RUN_STATE_REL);
        const runStateTmp = `${runStateAbs}.tmp-${process.pid}`;
        writeFileSync(runStateTmp, JSON.stringify(state, null, 2) + "\n", "utf8");
        renameSync(runStateTmp, runStateAbs);
        return { state, savedFiles, runStatePath: RUN_STATE_REL };
    }
    finally {
        // 정상/실패/예외 모든 경로에서 run_end 방출 → 렌더러가 spinner interval·stderr를 정리한다.
        reporter?.emit({ type: "run_end", status: runStatus, elapsedMs: Date.now() - runStartMs });
    }
}
