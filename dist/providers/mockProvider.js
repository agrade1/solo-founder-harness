/**
 * Mock provider: 실제 LLM을 호출하지 않고 AGENT_OUTPUT_SCHEMA를 따르는
 * 결정적(deterministic) markdown을 생성한다. 테스트/오프라인/CI 기반.
 * usage는 0 — 실제 provider(anthropic)만 토큰을 계측한다.
 */
export const mockProvider = {
    id: "mock",
    async generate(input) {
        const { agent, workflowId, project, createdAt, priorFindings, nextAgentId } = input;
        const priorBlock = priorFindings.length > 0
            ? priorFindings.map((f, i) => `- (${i + 1}) ${f}`).join("\n")
            : "- (첫 단계 — 이전 agent 판단 없음)";
        const nextAgentLine = nextAgentId
            ? `- ${nextAgentId}`
            : "- (없음 — 이 workflow의 마지막 단계)";
        // [B-40] gate decider(founder_ceo)는 "## Decision" 정본 판정 절을 반드시 낸다 —
        // 게이트가 이 절을 못 찾으면 fail closed로 멈추기 때문에, 기본값이 없으면 mock 기반
        // acceptance/golden 전부가 ceo_decision_absent로 죽는다(만족 불가능한 계약).
        // 기본은 '진행' — 무과금 회귀 경로가 완주해야 한다. kill/jump 경로는 테스트 fixture가 토큰을 바꾼다.
        const decisionBlock = agent.agent_id === "founder_ceo" ? "## Decision\n\n- 진행\n\n" : "";
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

${decisionBlock}## Main Judgment

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
