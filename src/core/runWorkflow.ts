import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadAgentRegistry,
  loadWorkflows,
  findWorkflow,
  findAgent,
  isCritiqueLoop,
  isGate,
  isFanout,
  isApproval,
  type AgentDef,
  type AgentRegistry,
  type WorkflowStep,
} from "./registry.js";
import { projectPaths, projectExists } from "./project.js";
import { runAgent } from "./runAgent.js";
import { saveArtifact } from "./saveArtifact.js";
import {
  validateAgentOutput,
  extractMainJudgment,
  extractCriticalRisks,
  extractDecision,
  extractSpawnDeclarations,
} from "./validate.js";
import type { Provider } from "../providers/provider.js";

export interface StepWarning {
  agent_id: string;
  missing: string[];
}

export interface RegenEntry {
  agent_id: string;
  attempts: number; // 추가 재생성 횟수 (0 = 첫 시도에 통과)
  resolved: boolean; // 재생성 후 최종적으로 스키마 통과했는가
}

export interface CritiqueRoundEntry {
  target: string;
  critic: string;
  rounds: number; // 실행된 critic 라운드 수
  resolved: boolean; // 마지막에 Critical 리스크가 사라졌는가
}

export interface GateJumpEntry {
  decider: string;
  decision: string | null; // 매칭된 판정 키워드 (없으면 null)
  jumped_to: string | null; // 되돌아간 agent (점프 안 했으면 null)
}

export interface SpawnEntry {
  parent: string; // 분화를 선언한 planner
  id: string;
  name: string;
  focus: string;
  executed: boolean; // 실제 실행됨(--allow-spawn) or 계획만(승인 대기)
  output: string | null; // 실행 시 저장 경로
}

export interface UsageEntry {
  agent_id: string;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  per_agent: UsageEntry[];
}

/** 루프(critique_loop) 중간 실패 시 재개 지점 힌트. 현재는 step 단위 재개라 정보성. */
export interface LoopState {
  step_index: number;
  critique_round?: number;
}

export interface RunState {
  workflow_id: string;
  project: string;
  provider: string;
  status: "completed" | "failed"; // 정상 완주 / 중단
  completed_steps: string[];
  failed_agent: string | null;
  failed_reason: string | null; // 중단 사유 (실패 시)
  resume_from: number | null; // 재개 시 실행할 step index (실패 시 = 중단된 step). completed면 null
  loop_state: LoopState | null;
  warnings: StepWarning[];
  regenerations: RegenEntry[];
  critique_rounds: CritiqueRoundEntry[];
  gate_jumps: GateJumpEntry[];
  spawned_agents: SpawnEntry[];
  usage: UsageSummary;
  started_at: string;
  finished_at: string;
}

export interface RunWorkflowResult {
  state: RunState;
  savedFiles: string[];
  runStatePath: string; // 프로젝트 상대경로
}

export interface RunWorkflowArgs {
  workflowId: string;
  project: string;
  provider: Provider;
  maxRegenerations?: number; // 스키마 실패 시 재생성 상한 (기본 1). mock은 항상 통과라 미발동.
  allowSpawn?: boolean; // 동적 분화된 하위 에이전트를 실제 실행할지 (기본 false = 계획만, 사람 승인 게이트)
  resume?: boolean; // outputs/run_state.json이 status=failed면 resume_from부터 재개
  maxTokens?: number; // 누적 토큰(input+output) 상한. 0/미지정 = 무제한. 초과 시 step 경계에서 중단
  approve?: (message: string, show?: string) => Promise<boolean>; // 승인 게이트 응답자. 미지정 시 자동 승인
  now?: () => string; // 테스트용 시각 주입 (기본: 현재 ISO 시각)
}

const RUN_STATE_REL = "outputs/run_state.json";

/** outputs/run_state.json을 읽는다. 없거나 파싱 실패면 null. */
export function loadRunState(project: string): RunState | null {
  const p = join(projectPaths(project).root, RUN_STATE_REL);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunState;
  } catch {
    return null;
  }
}

/** 완료된 step id의 저장 산출물 상대경로를 구한다 (resume 시 findings 복원용). */
function resolveOutputRel(id: string, registry: AgentRegistry, prior: RunState): string | null {
  const agent = findAgent(registry, id);
  if (agent) return agent.default_output;
  // 동적 분화된 하위 에이전트(spawn_<id>)는 registry에 없으므로 prior 기록에서 찾는다.
  const sp = prior.spawned_agents.find((s) => `spawn_${s.id}` === id && s.output);
  return sp?.output ?? null;
}

interface StepOutcome {
  markdown: string;
  validation: { ok: boolean; missing: string[] };
  attempt: number; // 재생성 횟수
  usageIn: number;
  usageOut: number;
  sawUsage: boolean;
}

/** 한 step에서 다음 primary agent id 힌트를 구한다 (프롬프트의 Next Agent 표시용). */
function nextHint(steps: WorkflowStep[], i: number): string | undefined {
  const nx = steps[i + 1];
  if (nx === undefined) return undefined;
  if (isCritiqueLoop(nx)) return nx.critique_loop.critic;
  if (isGate(nx) || isFanout(nx) || isApproval(nx)) return undefined; // 게이트/분화/승인은 다음 agent가 아님
  return nx;
}

/**
 * workflow를 순서대로 실행한다.
 * - string step: agent 1회 실행 (+ 스키마 재생성 루프)
 * - critique_loop step: critic 실행 → Critical 리스크가 있으면 target에 되먹여 revise → 재검토 (max_rounds까지)
 * - agent 실행 실패 시 중단하고 failed_agent 기록
 * - 항상 outputs/run_state.json 기록 (regenerations, critique_rounds, usage 포함)
 */
export async function runWorkflow(args: RunWorkflowArgs): Promise<RunWorkflowResult> {
  const now = args.now ?? (() => new Date().toISOString());
  const { workflowId, project, provider } = args;

  if (!projectExists(project)) {
    throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
  }

  const registry: AgentRegistry = loadAgentRegistry();
  const workflow = findWorkflow(loadWorkflows(), workflowId);
  if (!workflow) {
    throw new Error(`알 수 없는 workflow: ${workflowId} ('harness list'로 확인)`);
  }

  const completed_steps: string[] = [];
  const warnings: StepWarning[] = [];
  const regenerations: RegenEntry[] = [];
  const critique_rounds: CritiqueRoundEntry[] = [];
  const gate_jumps: GateJumpEntry[] = [];
  const spawned_agents: SpawnEntry[] = [];
  const savedFiles: string[] = [];
  const usagePerAgent: UsageEntry[] = [];
  const findings = new Map<string, string>(); // agentId → "agentId: judgment" (재실행 시 덮어씀, 순서 유지)
  const lastMarkdown = new Map<string, string>(); // agentId → 마지막 출력 원문 (게이트 판정 추출용)
  const gateBudget = new Map<number, number>(); // gate step index → 남은 되돌림 횟수
  const maxRegen = Math.max(0, args.maxRegenerations ?? 1);
  const allowSpawn = args.allowSpawn ?? false;
  const maxTokens = Math.max(0, args.maxTokens ?? 0);
  const approve = args.approve;
  let failed_agent: string | null = null;
  let failed_reason: string | null = null;
  let failedIndex: number | null = null;
  let budgetStopped = false;
  let rejected = false;
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
    usagePerAgent.push(...prior.usage.per_agent);
    for (const id of prior.completed_steps) {
      const rel = resolveOutputRel(id, registry, prior);
      if (!rel) continue;
      const abs = join(projectPaths(project).root, rel);
      if (!existsSync(abs)) continue;
      const md = readFileSync(abs, "utf8");
      findings.set(id, `${id}: ${extractMainJudgment(md)}`);
      lastMarkdown.set(id, md);
    }
    console.log(`  ↩ resume: step ${startIndex}부터 재개 (완료 ${completed_steps.length}개 복원)`);
  }

  const started_at = prior ? prior.started_at : now();

  const findingsList = () => Array.from(findings.values());

  // 한 agent를 실행하고 스키마 재생성 루프를 적용한다. runAgent throw는 호출자에 전파.
  async function runStepWithRegen(
    agent: AgentDef,
    nextAgentId: string | undefined,
    opts: { revisionRequest?: string; spawnRequest?: string; agentPromptText?: string } = {},
  ): Promise<StepOutcome> {
    currentAgentId = agent.agent_id;
    // 테스트용 강제 실패 훅 (0-1 resume 검증): 지정 agent에서 throw → failed_agent로 기록.
    if (process.env.HARNESS_FAIL_AT === agent.agent_id) {
      throw new Error(`강제 실패(HARNESS_FAIL_AT=${agent.agent_id})`);
    }
    let markdown = "";
    let validation = { ok: false, missing: [] as string[] };
    let feedback: string | undefined;
    let attempt = 0;
    let usageIn = 0;
    let usageOut = 0;
    let sawUsage = false;

    while (true) {
      const res = await runAgent({
        agent,
        registry,
        workflowId,
        project,
        createdAt: now(),
        priorFindings: findingsList(),
        nextAgentId,
        provider,
        retryFeedback: feedback,
        revisionRequest: opts.revisionRequest,
        spawnRequest: opts.spawnRequest,
        agentPromptText: opts.agentPromptText,
      });
      markdown = res.markdown;
      if (res.usage) {
        sawUsage = true;
        usageIn += res.usage.inputTokens;
        usageOut += res.usage.outputTokens;
      }
      validation = validateAgentOutput(markdown);
      if (validation.ok || attempt >= maxRegen) break;

      attempt++;
      feedback =
        `직전 출력에 필수 섹션 헤더가 누락되었다: ${validation.missing.join(", ")}. ` +
        `누락된 "## <헤더>"를 정확한 이름으로 포함하여 문서 전체를 다시 작성하라. 문서 외 텍스트는 출력하지 마라.`;
      console.warn(`  ↻ ${agent.agent_id}: 필수 섹션 누락(${validation.missing.join(", ")}) — 재생성 ${attempt}/${maxRegen}`);
    }

    return { markdown, validation, attempt, usageIn, usageOut, sawUsage };
  }

  // step 결과를 저장하고 run_state 누산기에 반영한다.
  function commitOutcome(agent: AgentDef, o: StepOutcome): string {
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
    if (!completed_steps.includes(agent.agent_id)) completed_steps.push(agent.agent_id);
    findings.set(agent.agent_id, `${agent.agent_id}: ${extractMainJudgment(o.markdown)}`);
    lastMarkdown.set(agent.agent_id, o.markdown);
    return saved;
  }

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
        let spawnRequest: string | undefined;
        if (nx && isFanout(nx) && nx.fanout.planner === step) {
          const max = Math.max(1, nx.fanout.max_agents ?? 1);
          spawnRequest =
            `이 계획을 실제로 진행할 때 병렬/전문화하면 좋은 하위 에이전트가 있으면, ` +
            `문서 맨 끝에 아래 형식으로 각 줄에 정확히 나열하라 (최대 ${max}개):\n` +
            `SPAWN id=<영문소문자_id> | name=<이름> | focus=<한 줄 담당 범위>\n` +
            `분화가 불필요하면 정확히 "SPAWN none" 한 줄만 출력하라.`;
        }
        const o = await runStepWithRegen(agent, nextHint(workflow.steps, i), { spawnRequest });
        const saved = commitOutcome(agent, o);
        console.log(`  ✓ ${agent.agent_id} → ${saved}`);
        continue;
      }

      if (isGate(step)) {
        // ── CEO 게이트 분기 ────────────────────────────
        const { decider, on, max_jumps } = step.gate;
        if (!completed_steps.includes(decider)) {
          failed_agent = decider;
          failed_reason = `gate decider '${decider}'가 게이트 전에 실행되지 않음`;
          failedIndex = i;
          console.error(`  ✗ gate: decider '${decider}'이(가) 게이트 전에 실행되지 않음 — 중단`);
          break;
        }
        if (!gateBudget.has(i)) gateBudget.set(i, Math.max(0, max_jumps ?? 0));
        const remaining = gateBudget.get(i) ?? 0;

        const decision = extractDecision(lastMarkdown.get(decider) ?? "", Object.keys(on));
        const jumpTarget = decision ? on[decision] : null;

        if (decision && jumpTarget && remaining > 0) {
          const targetIdx = workflow.steps.findIndex((s) => s === jumpTarget);
          if (targetIdx >= 0) {
            gateBudget.set(i, remaining - 1);
            gate_jumps.push({ decider, decision, jumped_to: jumpTarget });
            console.log(`  ⤴ 게이트: ${decider} 판정 '${decision}' → ${jumpTarget} 되돌림 (남은 되돌림 ${remaining - 1})`);
            i = targetIdx - 1; // 다음 i++가 targetIdx를 가리킴
            continue;
          }
          console.warn(`  ⤴ 게이트: 되돌림 대상 '${jumpTarget}' 스텝을 찾지 못함 — 진행`);
        }
        gate_jumps.push({ decider, decision, jumped_to: null });
        console.log(`  ⤴ 게이트: ${decider} 판정 '${decision ?? "미매칭"}' → 진행`);
        continue;
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
          const subAgent: AgentDef = {
            agent_id: `spawn_${spec.id}`,
            name: spec.name,
            role: spec.focus,
            prompt_path: "",
            default_output: `outputs/spawned/${spec.id}.md`,
          };
          const brief =
            `너는 '${spec.name}' 전문 에이전트다. 담당 범위: ${spec.focus}.\n` +
            `아래는 상위 '${planner}'의 전체 계획이다. 이 중 네 담당 범위에 해당하는 부분을 구체화하라.\n\n` +
            `--- 상위 계획 시작 ---\n${plannerPlan}\n--- 상위 계획 끝 ---`;
          const so = await runStepWithRegen(subAgent, undefined, { agentPromptText: brief });
          const saved = commitOutcome(subAgent, so);
          spawned_agents.push({ parent: planner, id: spec.id, name: spec.name, focus: spec.focus, executed: true, output: saved });
          console.log(`  ⑂ 하위 실행: ${spec.id} (${spec.name}) → ${saved}`);
        }
        if (!allowSpawn) {
          console.log(`  ⑂ 계획만 기록 (실행하려면 --allow-spawn) — 사람 승인 게이트`);
        }
        continue;
      }

      if (isApproval(step)) {
        // ── 승인 게이트 ────────────────────────────────
        const { message, show } = step.approval;
        if (show) {
          const abs = join(projectPaths(project).root, show);
          if (existsSync(abs)) {
            console.log(`\n--- 승인 검토 문서: ${show} ---\n${readFileSync(abs, "utf8")}\n--- (문서 끝) ---`);
          }
        }
        const ok = approve ? await approve(message, show) : true; // approver 없으면 자동 승인(프로그램 호출 기본)
        if (!ok) {
          failed_reason = "user_rejected";
          failedIndex = i; // 승인 step 자체 — resume 시 다시 묻는다
          rejected = true;
          console.error(`  ✗ 승인 거부: "${message}" — 중단 (--resume으로 재개)`);
          break;
        }
        console.log(`  ✔ 승인: "${message}"`);
        continue;
      }

      if (!isCritiqueLoop(step)) continue; // 알 수 없는 step 타입 방어

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
        // 1) critic 실행
        const co = await runStepWithRegen(criticAgent, target);
        const criticSaved = commitOutcome(criticAgent, co);
        console.log(`  ✓ ${critic} → ${criticSaved}`);

        // 2) Critical 리스크 추출
        const critical = extractCriticalRisks(co.markdown);
        console.log(`  ⚖ ${critic} 라운드 ${round}/${maxRounds}: Critical ${critical.length}건`);
        if (critical.length === 0) {
          resolved = true;
          break;
        }
        if (round >= maxRounds) break; // 라운드 소진 — 미해결로 종료

        // 3) target에 Critical을 되먹여 revise
        const revisionRequest =
          `${critic}가 다음 Critical 리스크를 제기했다:\n` +
          critical.map((c, idx) => `${idx + 1}. ${c}`).join("\n") +
          `\n이 리스크들을 정면으로 반영해 이전 판단을 수정하고 문서 전체를 다시 작성하라. ` +
          `각 리스크에 대한 대응·완화책을 Decisions / Assumptions / Risks에 반영하라.`;
        const to = await runStepWithRegen(targetAgent, critic, { revisionRequest });
        const targetSaved = commitOutcome(targetAgent, to);
        console.log(`  ✎ ${target} 라운드 ${round}: 비평 반영 수정 → ${targetSaved}`);
      }

      critique_rounds.push({ target, critic, rounds: round, resolved });
      console.log(`  ⚖ 비평 루프 종료: ${critic}⟲${target} ${round}라운드, ${resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
    } catch (err) {
      failed_agent = currentAgentId || "(unknown)";
      failed_reason = (err as Error).message;
      failedIndex = i;
      console.error(`  ✗ ${failed_agent}: 실행 실패 — ${(err as Error).message} — 중단`);
      break;
    }
  }

  const finished_at = now();
  const usage: UsageSummary = {
    input_tokens: usagePerAgent.reduce((s, u) => s + u.input_tokens, 0),
    output_tokens: usagePerAgent.reduce((s, u) => s + u.output_tokens, 0),
    per_agent: usagePerAgent,
  };
  const stopped = failed_agent !== null || budgetStopped || rejected;
  const state: RunState = {
    workflow_id: workflowId,
    project,
    provider: provider.id,
    status: stopped ? "failed" : "completed",
    completed_steps,
    failed_agent,
    failed_reason: stopped ? failed_reason : null,
    resume_from: stopped ? failedIndex : null,
    loop_state: stopped && failedIndex !== null ? { step_index: failedIndex } : null,
    warnings,
    regenerations,
    critique_rounds,
    gate_jumps,
    spawned_agents,
    usage,
    started_at,
    finished_at,
  };

  // run_state.json은 성공/실패와 무관하게 항상 기록
  const runStateAbs = join(projectPaths(project).root, RUN_STATE_REL);
  writeFileSync(runStateAbs, JSON.stringify(state, null, 2) + "\n", "utf8");

  return { state, savedFiles, runStatePath: RUN_STATE_REL };
}
