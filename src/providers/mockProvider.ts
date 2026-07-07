import type { Provider, AgentRunInput, AgentResult } from "./provider.js";

/**
 * Mock provider: 실제 LLM을 호출하지 않고 AGENT_OUTPUT_SCHEMA를 따르는
 * 결정적(deterministic) markdown을 생성한다. 테스트/오프라인/CI 기반.
 * usage는 0 — 실제 provider(anthropic)만 토큰을 계측한다.
 */
export const mockProvider: Provider = {
  id: "mock",

  async generate(input: AgentRunInput): Promise<AgentResult> {
    const { agent, workflowId, project, createdAt, priorFindings, nextAgentId } = input;

    const priorBlock =
      priorFindings.length > 0
        ? priorFindings.map((f, i) => `- (${i + 1}) ${f}`).join("\n")
        : "- (첫 단계 — 이전 agent 판단 없음)";

    const nextAgentLine = nextAgentId
      ? `- ${nextAgentId}`
      : "- (없음 — 이 workflow의 마지막 단계)";

    const markdown = `# Agent Output

## Metadata

- agent_id: ${agent.agent_id}
- agent_name: ${agent.name}
- workflow_id: ${workflowId}
- project: ${project}
- created_at: ${createdAt}
- provider: mock
- input_sources: docs/00_IDEA.md, 이전 agent 결과

## Input Summary

- 대상 프로젝트: ${project}
- 역할: ${agent.role}
- 이전 판단 요약:
${priorBlock}

## Main Judgment

- [MOCK] ${agent.name}의 판단 결과 (실제 LLM 미호출). 역할 관점에서 이 아이디어는 조건부로 진행 가능하다.

## Key Findings

1. [MOCK] ${agent.role} 관점의 핵심 발견 1
2. [MOCK] 핵심 발견 2
3. [MOCK] 핵심 발견 3

## Decisions

- [MOCK] 이 단계에서 확정한 결정 사항

## Assumptions

- [MOCK] 확인 필요한 가정

## Risks

### Critical

- (없음)

### High

- [MOCK] 이 역할 관점의 주요 리스크

### Medium

- [MOCK] 중간 리스크

### Low

- (없음)

## Recommended Next Actions

1. [MOCK] 다음에 해야 할 일 1
2. [MOCK] 다음에 해야 할 일 2

## Next Agent

${nextAgentLine}

## Artifacts To Update

- ${agent.default_output}

## Handoff Notes

- [MOCK] 다음 agent가 알아야 할 핸드오프 메모
`;

    // 기본 usage는 0 (실제 provider만 토큰 계측). 단, 예산 로직 검증용으로
    // HARNESS_MOCK_TOKENS가 설정되면 호출당 그 값을 input 토큰으로 계측한다.
    const mockTokens = Number(process.env.HARNESS_MOCK_TOKENS ?? 0);
    const usage = mockTokens > 0 ? { inputTokens: mockTokens, outputTokens: 0 } : { inputTokens: 0, outputTokens: 0 };
    return { markdown, usage };
  },
};
