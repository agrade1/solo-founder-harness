import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadAgentRegistry, loadWorkflows, findWorkflow, findAgent, isCritiqueLoop, isGate, isFanout, isApproval, hasKillGate, reevaluationWorkflowIds, } from "./registry.js";
import { projectPaths, projectExists } from "./project.js";
import { runAgent } from "./runAgent.js";
import { saveArtifact } from "./saveArtifact.js";
import { validateAgentOutput, extractTokensJson, extractMainJudgment, extractCriticalRisks, extractSpawnDeclarations, extractCeoDecision, CEO_DECISION_TOKENS, } from "./validate.js";
import { loadToolProfiles, compileToolProfile, assertPolicyExecutable, hasMcpBinding } from "../tools/profiles.js";
import { getProviderCapabilities } from "../providers/capabilities.js";
const RUN_STATE_REL = "outputs/run_state.json";
/** ms를 사람이 읽는 경과시간으로. 60초 미만은 "12s", 이상은 "1:23". */
function fmtElapsed(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** 지정 절대경로의 run_state.json을 읽는다 (부재/손상 구분). */
export function readRunStateAt(abs) {
    if (!existsSync(abs))
        return { kind: "absent" };
    try {
        return { kind: "ok", state: JSON.parse(readFileSync(abs, "utf8")) };
    }
    catch (err) {
        return { kind: "unreadable", path: abs, detail: err.message };
    }
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
/** 아이디어 문서의 sha256. 파일이 없으면 null. */
export function ideaDigestAt(ideaAbs) {
    if (!existsSync(ideaAbs))
        return null;
    return createHash("sha256").update(readFileSync(ideaAbs)).digest("hex");
}
/** 프로젝트의 docs/00_IDEA.md sha256. 없으면 null. */
export function ideaDigest(project) {
    return ideaDigestAt(join(projectPaths(project).root, IDEA_REL));
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
 * @param allowReevaluation 호출자가 "kill 게이트가 있는 workflow의 새 run"일 때만 true.
 */
export function ideaGateStatus(read, ideaAbs, allowReevaluation = false) {
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
    const now = ideaDigestAt(ideaAbs);
    if (now === null) {
        return {
            ok: false,
            code: "idea_missing",
            message: `폐기 기록이 있는데 아이디어 문서를 읽을 수 없습니다: ${ideaAbs}. 해제 여부를 확인할 수 없어 거부합니다.`,
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
            `아이디어를 고치는 것만으로는 해제되지 않습니다 — ${ideaAbs}를 고친 뒤 재평가를 먼저 돌리고 ` +
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
    const priorRead = readRunState(project);
    if (!args.resume) {
        const gateStatus = ideaGateStatus(priorRead, join(projectPaths(project).root, IDEA_REL), hasKillGate(workflow));
        if (!gateStatus.ok)
            throw new Error(`${gateStatus.code}: ${gateStatus.message}`);
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
    const gateBudget = new Map(); // gate step index → 남은 되돌림 횟수
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
    let killed_by = null;
    // [B-40/A-3] **carry forward.** 폐기 기록과 해제 증거는 이전 state에서 이어받는다 — resume이든
    // 새 run이든. 이어받지 않으면 kill 뒤 아무 run 하나가 증거를 지우고 잠금 전체가 무의미해진다.
    // (prior는 resume 전용이라 여기서 쓰지 않는다: 재평가 run은 resume이 아니면서도 이어받아야 한다.)
    const priorState = priorRead.kind === "ok" ? priorRead.state : null;
    const kill_history = [...(priorState?.kill_history ?? [])];
    let cleared_idea_sha256 = priorState?.cleared_idea_sha256 ?? null;
    let warned80 = false;
    let currentAgentId = "";
    const tokensSpent = () => usagePerAgent.reduce((s, u) => s + u.input_tokens + u.output_tokens, 0);
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
        }
        console.log(`  ↩ resume: step ${startIndex}부터 재개 (완료 ${completed_steps.length}개 복원)`);
    }
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
                    contextMode: opts.contextMode,
                    nextAgentId,
                    provider,
                    retryFeedback: feedback,
                    revisionRequest: opts.revisionRequest,
                    spawnRequest: opts.spawnRequest,
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
    // step 결과를 저장하고 run_state 누산기에 반영한다.
    function commitOutcome(agent, o) {
        if (o.sawUsage) {
            usagePerAgent.push({ agent_id: agent.agent_id, input_tokens: o.usageIn, output_tokens: o.usageOut });
        }
        if (o.attempt > 0) {
            regenerations.push({ agent_id: agent.agent_id, attempts: o.attempt, resolved: o.validation.ok });
        }
        if (!o.validation.ok) {
            warnings.push({ agent_id: agent.agent_id, missing: o.validation.missing });
            console.warn(`  ⚠ ${agent.agent_id}: 필수 섹션 누락 — ${o.validation.missing.join(", ")} (저장은 진행)`);
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
        return saved;
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
                    const o = await runStepWithRegen(agent, nextHint(workflow.steps, i), {
                        spawnRequest,
                        progressLabel: `[${i + 1}/${total}] ${agent.agent_id}`,
                        stepIndex: i + 1,
                        kind: "agent",
                    });
                    const saved = commitOutcome(agent, o);
                    console.log(`  [${i + 1}/${total}] ✓ ${agent.agent_id} → ${saved} (${fmtElapsed(o.elapsedMs)})`);
                    continue;
                }
                if (isGate(step)) {
                    // ── CEO 게이트 분기 ────────────────────────────
                    const { decider, on, max_jumps, kill } = step.gate;
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
                    if (!gateBudget.has(i))
                        gateBudget.set(i, Math.max(0, max_jumps ?? 0));
                    const remaining = gateBudget.get(i) ?? 0;
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
                    // ── kill 판정은 jump/진행보다 먼저 ─────────────────
                    // 순서가 뒤바뀌면 되돌림이 이겨 죽은 아이디어가 한 바퀴 더 돈다. kill을 앞에 두면 최악이
                    // "사람이 새 run으로 다시 시작"이고, 뒤에 두면 최악이 "미달 아이디어를 그대로 개발 착수" —
                    // 후자가 이 게이트가 존재하는 이유 그 자체다. 그래서 멈추는 쪽으로 fail closed.
                    if (kill?.includes(decision)) {
                        const idea_sha256 = ideaDigest(project);
                        killed_by = { decider, decision, idea_sha256 };
                        kill_history.push({ decider, decision, idea_sha256, at: now() });
                        cleared_idea_sha256 = null; // 폐기는 이전 해제를 무효화한다 (다시 재평가를 받아야 한다)
                        gate_jumps.push({ decider, decision, jumped_to: null, killed: true });
                        console.log(`  ⛔ 게이트: ${decider} 판정 '${decision}' → run 종료(killed) — 후속 단계 미실행`);
                        endGate(true); // 게이트 자체는 정상 동작했다 (판정을 내리는 것이 이 step의 일)
                        break;
                    }
                    const jumpTarget = on[decision] ?? null;
                    if (jumpTarget && remaining > 0) {
                        const targetIdx = workflow.steps.findIndex((s) => s === jumpTarget);
                        if (targetIdx >= 0) {
                            gateBudget.set(i, remaining - 1);
                            gate_jumps.push({ decider, decision, jumped_to: jumpTarget });
                            reporter?.emit({ type: "gate_jump", decider, decision, target: jumpTarget }); // 실제 jump일 때만
                            console.log(`  ⤴ 게이트: ${decider} 판정 '${decision}' → ${jumpTarget} 되돌림 (남은 되돌림 ${remaining - 1})`);
                            endGate(true);
                            i = targetIdx - 1; // 다음 i++가 targetIdx를 가리킴
                            continue;
                        }
                    }
                    // ── 게이트 통과는 '진행' 토큰 하나뿐 ────────────────
                    // 예전에는 kill도 jump도 아닌 모든 판정이 "→ 진행"으로 떨어졌다. 그래서 '보류'(백로그)와
                    // '검증'(개발하지 않음)이 진행하고, 되돌림 예산이 소진되면 같은 '축소' 판정이 진행으로 바뀌고,
                    // run이 completed가 되어 task-prompt·handoff까지 열렸다 — 상태 전이 우회 + 거짓 성공 영수증.
                    // 통과 조건을 화이트리스트로 뒤집고, 그 밖은 **원인별로 다른 코드**로 멈춘다
                    // (원인과 다른 코드를 적는 것은 이 레포가 C-96으로 잡은 부류다).
                    if (decision === "진행") {
                        gate_jumps.push({ decider, decision, jumped_to: null });
                        console.log(`  ⤴ 게이트: ${decider} 판정 '진행' → 진행`);
                        // [A-3] 폐기 잠금 해제 증거는 **이 자리에서만** 발급한다: kill 게이트가 있는 게이트가
                        // '진행'을 낸 순간. 다른 경로에서 적으면 그 경로가 곧 우회 통로가 된다.
                        if ((kill ?? []).length > 0)
                            cleared_idea_sha256 = ideaDigest(project);
                        endGate(true);
                        continue;
                    }
                    failed_agent = decider;
                    failed_reason =
                        jumpTarget === null
                            ? decision === "보류"
                                ? "ceo_decision_hold" // 판정 자체가 "지금은 하지 않는다" — 매핑 부재와 구분한다
                                : "ceo_decision_unmapped" // 이 workflow에 해당 판정의 되돌림 대상이 없다
                            : remaining > 0
                                ? "gate_jump_target_missing" // on에 있지만 그 step이 workflow에 없다 (정의 오류)
                                : "gate_jump_budget_exhausted"; // 되돌려 봤는데 판정이 그대로다
                    failedIndex = i;
                    gate_jumps.push({ decider, decision, jumped_to: null });
                    console.error(`  ✗ 게이트: ${decider} 판정 '${decision}' → 진행하지 않고 중단 (${failed_reason})`);
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
                        const saved = commitOutcome(subAgent, so);
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
                    const ok = approve ? await approve(message, show) : true; // approver 없으면 자동 승인(프로그램 호출 기본)
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
                let round = 0;
                let resolved = false;
                while (round < maxRounds) {
                    round++;
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
                    const criticSaved = commitOutcome(criticAgent, co);
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
                    const targetSaved = commitOutcome(targetAgent, to);
                    console.log(`  ✎ ${target} 라운드 ${round}: 비평 반영 수정 → ${targetSaved} (${fmtElapsed(to.elapsedMs)})`);
                }
                critique_rounds.push({ target, critic, rounds: round, resolved });
                console.log(`  ⚖ 비평 루프 종료: ${critic}⟲${target} ${round}라운드, ${resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
            }
            catch (err) {
                failed_agent = currentAgentId || "(unknown)";
                failed_reason = err.message;
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
            loop_state: stopped && failedIndex !== null ? { step_index: failedIndex } : null,
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
        };
        // run_state.json은 성공/실패와 무관하게 항상 기록
        const runStateAbs = join(projectPaths(project).root, RUN_STATE_REL);
        writeFileSync(runStateAbs, JSON.stringify(state, null, 2) + "\n", "utf8");
        return { state, savedFiles, runStatePath: RUN_STATE_REL };
    }
    finally {
        // 정상/실패/예외 모든 경로에서 run_end 방출 → 렌더러가 spinner interval·stderr를 정리한다.
        reporter?.emit({ type: "run_end", status: runStatus, elapsedMs: Date.now() - runStartMs });
    }
}
