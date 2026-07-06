import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadAgentRegistry,
  loadWorkflows,
  findWorkflow,
  findAgent,
  isCritiqueLoop,
  type AgentDef,
  type AgentRegistry,
  type WorkflowStep,
} from "./registry.js";
import { projectPaths, projectExists } from "./project.js";
import { runAgent } from "./runAgent.js";
import { saveArtifact } from "./saveArtifact.js";
import { validateAgentOutput, extractMainJudgment, extractCriticalRisks } from "./validate.js";
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

export interface RunState {
  workflow_id: string;
  project: string;
  provider: string;
  completed_steps: string[];
  failed_agent: string | null;
  warnings: StepWarning[];
  regenerations: RegenEntry[];
  critique_rounds: CritiqueRoundEntry[];
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
  now?: () => string; // 테스트용 시각 주입 (기본: 현재 ISO 시각)
}

const RUN_STATE_REL = "outputs/run_state.json";

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
  return isCritiqueLoop(nx) ? nx.critique_loop.critic : nx;
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

  const started_at = now();
  const completed_steps: string[] = [];
  const warnings: StepWarning[] = [];
  const regenerations: RegenEntry[] = [];
  const critique_rounds: CritiqueRoundEntry[] = [];
  const savedFiles: string[] = [];
  const usagePerAgent: UsageEntry[] = [];
  const findings = new Map<string, string>(); // agentId → "agentId: judgment" (재실행 시 덮어씀, 순서 유지)
  const maxRegen = Math.max(0, args.maxRegenerations ?? 1);
  let failed_agent: string | null = null;
  let currentAgentId = "";

  const findingsList = () => Array.from(findings.values());

  // 한 agent를 실행하고 스키마 재생성 루프를 적용한다. runAgent throw는 호출자에 전파.
  async function runStepWithRegen(
    agent: AgentDef,
    nextAgentId: string | undefined,
    revisionRequest?: string,
  ): Promise<StepOutcome> {
    currentAgentId = agent.agent_id;
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
        revisionRequest,
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
    return saved;
  }

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];

    try {
      if (!isCritiqueLoop(step)) {
        // ── 일반 step ──────────────────────────────
        const agent = findAgent(registry, step);
        if (!agent) {
          failed_agent = step;
          console.error(`  ✗ ${step}: registry에 없는 agent — 중단`);
          break;
        }
        const o = await runStepWithRegen(agent, nextHint(workflow.steps, i));
        const saved = commitOutcome(agent, o);
        console.log(`  ✓ ${agent.agent_id} → ${saved}`);
        continue;
      }

      // ── 비평 루프 step ─────────────────────────────
      const { target, critic, max_rounds } = step.critique_loop;
      const targetAgent = findAgent(registry, target);
      const criticAgent = findAgent(registry, critic);
      if (!targetAgent || !criticAgent) {
        failed_agent = !targetAgent ? target : critic;
        console.error(`  ✗ critique_loop: registry에 없는 agent(${failed_agent}) — 중단`);
        break;
      }
      if (!completed_steps.includes(target)) {
        // 설계 오류: 비평 대상이 루프 전에 실행되지 않음
        failed_agent = critic;
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
        const to = await runStepWithRegen(targetAgent, critic, revisionRequest);
        const targetSaved = commitOutcome(targetAgent, to);
        console.log(`  ✎ ${target} 라운드 ${round}: 비평 반영 수정 → ${targetSaved}`);
      }

      critique_rounds.push({ target, critic, rounds: round, resolved });
      console.log(`  ⚖ 비평 루프 종료: ${critic}⟲${target} ${round}라운드, ${resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
    } catch (err) {
      failed_agent = currentAgentId || "(unknown)";
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
  const state: RunState = {
    workflow_id: workflowId,
    project,
    provider: provider.id,
    completed_steps,
    failed_agent,
    warnings,
    regenerations,
    critique_rounds,
    usage,
    started_at,
    finished_at,
  };

  // run_state.json은 성공/실패와 무관하게 항상 기록
  const runStateAbs = join(projectPaths(project).root, RUN_STATE_REL);
  writeFileSync(runStateAbs, JSON.stringify(state, null, 2) + "\n", "utf8");

  return { state, savedFiles, runStatePath: RUN_STATE_REL };
}
