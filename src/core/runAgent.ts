import { readFileSync, existsSync } from "node:fs";
import { fromRoot } from "./paths.js";
import type { AgentDef, AgentRegistry } from "./registry.js";
import type { Provider, TokenUsage } from "../providers/provider.js";

export interface RunAgentArgs {
  agent: AgentDef;
  registry: AgentRegistry;
  workflowId: string;
  project: string;
  createdAt: string;
  priorFindings: string[];
  nextAgentId?: string;
  provider: Provider;
}

export interface RunAgentResult {
  agentId: string;
  markdown: string;
  usage?: TokenUsage;
}

function loadPrompt(relPath: string, label: string): string {
  const abs = fromRoot(relPath);
  if (!existsSync(abs)) {
    throw new Error(`${label} prompt 파일이 없습니다: ${relPath}`);
  }
  return readFileSync(abs, "utf8");
}

/**
 * 한 agent를 실행한다.
 * - common prompt와 agent prompt를 로드한다 (spec 4.3).
 * - provider로 결과 markdown을 생성한다.
 * prompt 파일이 없으면 throw → 호출자(runWorkflow)가 failed_agent로 기록한다.
 */
export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const { agent, registry, workflowId, project, createdAt, priorFindings, nextAgentId, provider } = args;

  const commonPrompt = loadPrompt(registry.common_prompt_path, "common");
  const agentPrompt = loadPrompt(agent.prompt_path, agent.agent_id);

  const { markdown, usage } = await provider.generate({
    agent,
    workflowId,
    project,
    createdAt,
    commonPrompt,
    agentPrompt,
    priorFindings,
    nextAgentId,
  });

  return { agentId: agent.agent_id, markdown, usage };
}
