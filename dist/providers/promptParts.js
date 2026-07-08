/**
 * AGENT_OUTPUT_SCHEMA를 따르는 프롬프트를 구성한다.
 * claude-code는 system+user를 한 프롬프트로 합쳐 stdin에, anthropic은 system/user로 분리해 사용.
 * providerId는 Metadata의 provider 값에 들어간다.
 */
export function buildPromptParts(input, providerId) {
    const { agent, workflowId, project, createdAt, commonPrompt, agentPrompt, ideaContent, priorFindings, contextMode, nextAgentId, retryFeedback, revisionRequest, spawnRequest, } = input;
    const conclusionOnly = contextMode === "conclusion_only";
    const priorHeading = conclusionOnly
        ? "- 비평 대상의 결론 (편향 분리 — 이 결론만 보고 독립적으로 검증하라. 다른 에이전트 판단은 의도적으로 제공하지 않음):"
        : "- 이전 에이전트 판단 요약:";
    const priorBlock = priorFindings.length > 0
        ? priorFindings.map((f, i) => `- (${i + 1}) ${f}`).join("\n")
        : "- (첫 단계 — 이전 agent 판단 없음)";
    const nextAgentLine = nextAgentId ? nextAgentId : "(없음 — 이 workflow의 마지막 단계)";
    const revisionBlock = revisionRequest ? `\n---\n# 🔁 비평 반영 수정 지시\n\n${revisionRequest}\n` : "";
    const retryBlock = retryFeedback ? `\n---\n# ⚠️ 재작성 지시\n\n${retryFeedback}\n` : "";
    const spawnBlock = spawnRequest ? `\n---\n# 🧩 하위 에이전트 분화\n\n${spawnRequest}\n` : "";
    const user = `# 너의 역할: ${agent.name} (${agent.role})

아래는 이 역할의 상세 운영 프롬프트다. 이 지침에 따라 판단하라.

${agentPrompt}

---
# 검토 대상 아이디어 (docs/00_IDEA.md)

${ideaContent.trim() || "(아이디어 문서가 비어 있음 — 일반 원칙에 따라 판단하고 그 사실을 Assumptions에 명시하라.)"}

---
# 실행 컨텍스트

- workflow_id: ${workflowId}
- project: ${project}
${priorHeading}
${priorBlock}
- 다음 에이전트: ${nextAgentLine}

---
# 출력 형식 (반드시 지켜라)

결과는 아래 markdown 구조를 **정확히** 따른다. 문서 외 서문/설명/코드펜스 없이 문서만 출력한다.
첫 줄은 "# Agent Output". "## Metadata" 섹션에는 아래 값을 그대로 넣는다:

- agent_id: ${agent.agent_id}
- agent_name: ${agent.name}
- workflow_id: ${workflowId}
- project: ${project}
- created_at: ${createdAt}
- provider: ${providerId}
- input_sources: docs/00_IDEA.md, 이전 agent 결과

이어서 다음 "## 섹션"을 모두 포함한다 (헤더명은 정확히 일치시킬 것):
Input Summary / Main Judgment / Key Findings / Decisions / Assumptions /
Risks(하위 "### Critical" "### High" "### Medium" "### Low") /
Recommended Next Actions(1~3개) / Next Agent(값: ${nextAgentLine}) /
Artifacts To Update(값: ${agent.default_output}) / Handoff Notes.

Main Judgment은 결론을 먼저 한 문장으로 제시하고, 각 섹션은 이 역할 관점에서 구체적으로 채운다.${revisionBlock}${retryBlock}${spawnBlock}`;
    return { system: commonPrompt, user };
}
