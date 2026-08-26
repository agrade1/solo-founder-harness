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
        // [B-41/Codex A-2] `token_output`을 선언한 agent(design)는 그 사이드카를 **반드시** 낸다.
        // 파이프라인 영수증이 선언된 사이드카까지 결박하는데(승인 후 교체 탐지) mock이 그것을 안 내면
        // 계약을 만족할 수 없는 fixture가 된다 — 그럴 때 고칠 것은 계약이 아니라 **test provider**다.
        // 3계층(primitive→semantic→component)은 token-lint의 tokens.json 규율과 같은 모양이다.
        const tokensBlock = agent.token_output
            ? "## Design Tokens\n\n```json\n" +
                JSON.stringify({
                    primitive: { color: { "gray-900": "#111827", "blue-500": "#3b82f6", white: "#ffffff" }, space: { "2": "8px" } },
                    semantic: {
                        color: { "text-body": "{primitive.color.gray-900}", action: "{primitive.color.blue-500}", surface: "{primitive.color.white}" },
                        space: { gap: "{primitive.space.2}" },
                    },
                    component: { button: { bg: "{semantic.color.action}", fg: "{semantic.color.text-body}", gap: "{semantic.space.gap}" } },
                    // **최상위 key는 3계층 + `a11y`가 정확히 있어야 하고**(`designContract.ts`의 `tokens_layers`),
                    // `text-*` semantic 색은 전부 `contrastPairs`의 fg로 선언돼야 한다(`a11y_text_uncovered`).
                    // 그래서 mock도 그 계약을 만족한다 — test provider가 만족 못 하는 계약은 fixture가 아니라 함정이다.
                    // gray-900 on white = 대비비 ≈ 17.7 ≥ 4.5.
                    a11y: { contrastPairs: [{ fg: "semantic.color.text-body", bg: "semantic.color.surface", min: 4.5 }] },
                }, null, 2) +
                "\n```\n\n"
            : "";
        // [C-126] **선언을 요구받았으면 종결자를 낸다.** 리서치 선언(`RESEARCH_REQUEST`)이 프롬프트에
        // 실렸는데 아무 선언도 내지 않으면 계약이 `research_declaration_missing`으로 fail closed다
        // (무선언 ≠ `none` — 그 구분이 "모델이 형식을 어겼다"를 잡는 축이다). mock은 검색어를 지을 수
        // 없으니 **명시적 `none`** 이 정직한 답이고, 그래야 실키가 셸에 있는 개발자가 `--provider mock`으로
        // 돌려도 ⓐ 실패하지 않고 ⓑ **크레딧을 쓰지 않는다**(backend 0회 · mode `external_no_requests`).
        // B-40의 `## Decision`·B-41의 tokens.json과 같은 규율: **test provider가 자기가 받은 계약을
        // 만족하지 못하면 고칠 것은 계약이 아니라 test provider다.**
        const researchNoneLine = input.researchRequest ? "\nRESEARCH_REQUEST none\n" : "";
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

${decisionBlock}${tokensBlock}## Main Judgment

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
${researchNoneLine}`;
        // 기본 usage는 0 (실제 provider만 토큰 계측). 단, 예산 로직 검증용으로
        // HARNESS_MOCK_TOKENS가 설정되면 호출당 그 값을 input 토큰으로 계측한다.
        const mockTokens = Number(process.env.HARNESS_MOCK_TOKENS ?? 0);
        const usage = mockTokens > 0 ? { inputTokens: mockTokens, outputTokens: 0 } : { inputTokens: 0, outputTokens: 0 };
        return { markdown, usage };
    },
};
