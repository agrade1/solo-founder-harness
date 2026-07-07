import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fromPackage } from "./paths.js";
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
  contextMode?: "full" | "conclusion_only";
  nextAgentId?: string;
  provider: Provider;
  retryFeedback?: string;
  revisionRequest?: string;
  spawnRequest?: string;
  /** 있으면 prompt_path 파일 대신 이 텍스트를 agent prompt로 사용 (동적 분화된 하위 에이전트용). */
  agentPromptText?: string;
}

export interface RunAgentResult {
  agentId: string;
  markdown: string;
  usage?: TokenUsage;
}

function loadPrompt(relPath: string, label: string): string {
  const abs = fromPackage(relPath);
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
  const { agent, registry, workflowId, project, createdAt, priorFindings, contextMode, nextAgentId, provider, retryFeedback, revisionRequest, spawnRequest, agentPromptText } = args;

  const commonPrompt = loadPrompt(registry.common_prompt_path, "common");
  // 동적 분화된 하위 에이전트는 파일 대신 런타임 생성 프롬프트를 쓴다.
  const agentPrompt = agentPromptText ?? loadPrompt(agent.prompt_path, agent.agent_id);

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
    contextMode,
    nextAgentId,
    retryFeedback,
    revisionRequest,
    spawnRequest,
  });

  return { agentId: agent.agent_id, markdown, usage };
}
