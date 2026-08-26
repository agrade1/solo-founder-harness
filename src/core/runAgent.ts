import { readFileSync, existsSync } from "node:fs";
import { fromPackage } from "./paths.js";
import type { AgentDef, AgentRegistry } from "./registry.js";
import type { Provider, TokenUsage, ProviderExecContext } from "../providers/provider.js";

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
  /** [C-126] 리서치 1차의 선언 지시 (키가 있을 때만 · 미지정이면 프롬프트 바이트 불변). */
  researchRequest?: string;
  /** [C-126] 래핑된 근거 digest (2차와 수신자 allowlist agent에만). */
  evidenceDigest?: string;
  /** 있으면 prompt_path 파일 대신 이 텍스트를 agent prompt로 사용 (동적 분화된 하위 에이전트용). */
  agentPromptText?: string;
  /**
   * [B-40/A-1] 검토 대상 아이디어 본문. **호출자(runWorkflow)가 run 시작에 한 번 snapshot한 값**이며
   * 이 함수는 파일을 다시 읽지 않는다 — 예전엔 여기서 매번 읽어서, CEO가 본 바이트와 게이트가
   * digest를 낸 바이트가 다를 수 있었다(TOCTOU). run 안의 모든 프롬프트·기록이 같은 바이트를 쓴다.
   */
  ideaContent: string;
  /** [M2.1] 도구 정책 실행 context. --tool-profile 지정 시에만 전달된다. */
  execContext?: ProviderExecContext;
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
  const { agent, registry, workflowId, project, createdAt, priorFindings, contextMode, nextAgentId, provider, retryFeedback, revisionRequest, spawnRequest, researchRequest, evidenceDigest, agentPromptText, execContext, ideaContent } = args;

  const commonPrompt = loadPrompt(registry.common_prompt_path, "common");
  // 동적 분화된 하위 에이전트는 파일 대신 런타임 생성 프롬프트를 쓴다.
  const agentPrompt = agentPromptText ?? loadPrompt(agent.prompt_path, agent.agent_id);

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
    researchRequest,
    evidenceDigest,
    execContext,
  });

  return { agentId: agent.agent_id, markdown, usage };
}
