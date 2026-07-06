import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadAgentRegistry,
  loadWorkflows,
  findWorkflow,
  findAgent,
} from "./registry.js";
import { projectPaths, projectExists } from "./project.js";
import { runAgent } from "./runAgent.js";
import { saveArtifact } from "./saveArtifact.js";
import { validateAgentOutput, extractMainJudgment } from "./validate.js";
import type { Provider } from "../providers/provider.js";

export interface StepWarning {
  agent_id: string;
  missing: string[];
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
  now?: () => string; // 테스트용 시각 주입 (기본: 현재 ISO 시각)
}

const RUN_STATE_REL = "outputs/run_state.json";

/**
 * workflow를 순서대로 실행한다.
 * - 각 step: runAgent → 필수 헤더 검증(경고) → 결과 저장 → Main Judgment를 다음 step에 전달
 * - agent 실행 실패 시 중단하고 failed_agent 기록
 * - 항상 outputs/run_state.json 기록
 */
export async function runWorkflow(args: RunWorkflowArgs): Promise<RunWorkflowResult> {
  const now = args.now ?? (() => new Date().toISOString());
  const { workflowId, project, provider } = args;

  if (!projectExists(project)) {
    throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
  }

  const registry = loadAgentRegistry();
  const workflow = findWorkflow(loadWorkflows(), workflowId);
  if (!workflow) {
    throw new Error(`알 수 없는 workflow: ${workflowId} ('harness list'로 확인)`);
  }

  const started_at = now();
  const completed_steps: string[] = [];
  const warnings: StepWarning[] = [];
  const savedFiles: string[] = [];
  const priorFindings: string[] = [];
  const usagePerAgent: UsageEntry[] = [];
  let failed_agent: string | null = null;

  for (let i = 0; i < workflow.steps.length; i++) {
    const agentId = workflow.steps[i];
    const agent = findAgent(registry, agentId);

    if (!agent) {
      failed_agent = agentId;
      console.error(`  ✗ ${agentId}: registry에 없는 agent — 중단`);
      break;
    }

    const nextAgentId = workflow.steps[i + 1];

    try {
      const { markdown, usage } = await runAgent({
        agent,
        registry,
        workflowId,
        project,
        createdAt: now(),
        priorFindings: [...priorFindings],
        nextAgentId,
        provider,
      });

      if (usage) {
        usagePerAgent.push({
          agent_id: agentId,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        });
      }

      // 필수 헤더 검증 (경고 수준)
      const validation = validateAgentOutput(markdown);
      if (!validation.ok) {
        warnings.push({ agent_id: agentId, missing: validation.missing });
        console.warn(`  ⚠ ${agentId}: 필수 섹션 누락 — ${validation.missing.join(", ")} (저장은 진행)`);
      }

      const saved = saveArtifact(project, agent.default_output, markdown);
      savedFiles.push(saved);
      completed_steps.push(agentId);
      priorFindings.push(`${agentId}: ${extractMainJudgment(markdown)}`);
      console.log(`  ✓ ${agentId} → ${saved}`);
    } catch (err) {
      failed_agent = agentId;
      console.error(`  ✗ ${agentId}: 실행 실패 — ${(err as Error).message} — 중단`);
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
    usage,
    started_at,
    finished_at,
  };

  // run_state.json은 성공/실패와 무관하게 항상 기록
  const runStateAbs = join(projectPaths(project).root, RUN_STATE_REL);
  writeFileSync(runStateAbs, JSON.stringify(state, null, 2) + "\n", "utf8");

  return { state, savedFiles, runStatePath: RUN_STATE_REL };
}
