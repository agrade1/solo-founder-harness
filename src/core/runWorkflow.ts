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

export interface RegenEntry {
  agent_id: string;
  attempts: number; // 추가 재생성 횟수 (0 = 첫 시도에 통과)
  resolved: boolean; // 재생성 후 최종적으로 스키마 통과했는가
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
  const regenerations: RegenEntry[] = [];
  const savedFiles: string[] = [];
  const priorFindings: string[] = [];
  const usagePerAgent: UsageEntry[] = [];
  const maxRegen = Math.max(0, args.maxRegenerations ?? 1);
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
      // 스키마 검증 재생성 루프: 필수 헤더 누락 시 누락 항목을 피드백해 maxRegen회까지 재생성.
      let markdown = "";
      let validation = { ok: false, missing: [] as string[] };
      let feedback: string | undefined;
      let attempt = 0;
      let agentInput = 0;
      let agentOutput = 0;
      let sawUsage = false;

      while (true) {
        const res = await runAgent({
          agent,
          registry,
          workflowId,
          project,
          createdAt: now(),
          priorFindings: [...priorFindings],
          nextAgentId,
          provider,
          retryFeedback: feedback,
        });
        markdown = res.markdown;
        if (res.usage) {
          sawUsage = true;
          agentInput += res.usage.inputTokens;
          agentOutput += res.usage.outputTokens;
        }

        validation = validateAgentOutput(markdown);
        if (validation.ok || attempt >= maxRegen) break;

        attempt++;
        feedback =
          `직전 출력에 필수 섹션 헤더가 누락되었다: ${validation.missing.join(", ")}. ` +
          `누락된 "## <헤더>"를 정확한 이름으로 포함하여 문서 전체를 다시 작성하라. 문서 외 텍스트는 출력하지 마라.`;
        console.warn(`  ↻ ${agentId}: 필수 섹션 누락(${validation.missing.join(", ")}) — 재생성 ${attempt}/${maxRegen}`);
      }

      if (sawUsage) {
        usagePerAgent.push({ agent_id: agentId, input_tokens: agentInput, output_tokens: agentOutput });
      }
      if (attempt > 0) {
        regenerations.push({ agent_id: agentId, attempts: attempt, resolved: validation.ok });
      }

      // 재생성 후에도 실패면 경고 수준으로 기록하고 저장은 진행 (spec 4.4)
      if (!validation.ok) {
        warnings.push({ agent_id: agentId, missing: validation.missing });
        console.warn(`  ⚠ ${agentId}: 필수 섹션 누락 — ${validation.missing.join(", ")} (재생성 ${attempt}회 후에도, 저장은 진행)`);
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
    regenerations,
    usage,
    started_at,
    finished_at,
  };

  // run_state.json은 성공/실패와 무관하게 항상 기록
  const runStateAbs = join(projectPaths(project).root, RUN_STATE_REL);
  writeFileSync(runStateAbs, JSON.stringify(state, null, 2) + "\n", "utf8");

  return { state, savedFiles, runStatePath: RUN_STATE_REL };
}
