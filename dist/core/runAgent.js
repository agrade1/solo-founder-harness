import { readFileSync, existsSync } from "node:fs";
import { fromPackage } from "./paths.js";
function loadPrompt(relPath, label) {
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
export async function runAgent(args) {
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
