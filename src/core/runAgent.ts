import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fromRoot } from "./paths.js";
import { projectPaths } from "./project.js";
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
  retryFeedback?: string;
  revisionRequest?: string;
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
  const { agent, registry, workflowId, project, createdAt, priorFindings, nextAgentId, provider, retryFeedback, revisionRequest } = args;

  const commonPrompt = loadPrompt(registry.common_prompt_path, "common");
  const agentPrompt = loadPrompt(agent.prompt_path, agent.agent_id);

  // 검토 대상 아이디어 원문 (docs/00_IDEA.md). 없으면 빈 문자열 — mock은 미사용.
  const ideaPath = join(projectPaths(project).root, "docs", "00_IDEA.md");
  const ideaContent = existsSync(ideaPath) ? readFileSync(ideaPath, "utf8") : "";

  const { markdown, usage } = await provider.generate({
    agent,
    workflowId,
    project,
    createdAt,
    commonPrompt,
    agentPrompt,
    ideaContent,
    priorFindings,
    nextAgentId,
    retryFeedback,
    revisionRequest,
  });

  return { agentId: agent.agent_id, markdown, usage };
}
