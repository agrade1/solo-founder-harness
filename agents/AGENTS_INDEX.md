# AGENTS_INDEX.md

이 파일은 Claude Code가 기본으로 읽는 짧은 agent index다.  
실제 프롬프트 원문은 같은 폴더의 개별 markdown 파일에 둔다.

| agent_id | name | role | prompt_path | default_output |
|---|---|---|---|---|
| common | Common Agent Operating Prompt | 모든 에이전트 공용 운영 규칙 | agents/common_agent_operating_prompt_v3.md | - |
| founder_ceo | Founder CEO Agent | 최종 사업 판단, 진행/축소/검증/보류/폐기 결정 | agents/founder_ceo_agent.md | docs/06_CEO_DECISION.md |
| chief_of_staff | Chief of Staff Agent | 작업 라우팅, 에이전트 호출 순서, 실행 흐름 관리 | agents/chief_of_staff_agent.md | outputs/chief_of_staff.md |
| research | Research Agent | 시장, 고객, 경쟁, 기존 대안, 진입 가능성 조사 | agents/research_agent.md | docs/01_RESEARCH.md |
| pm | PM / Product Strategy Agent | MVP 범위 축소, 기능 우선순위, PRD, 사용자 흐름 | agents/pm_product_strategy_agent.md | docs/02_PRD.md |
| ux_ui | UX/UI Design Agent | 최소 화면 흐름, 랜딩/입력/결과/피드백 UX 설계 | agents/ux_ui_design_agent.md | docs/03_UX_FLOW.md |
| design | Design Agent (디자인 시스템) | 디자인 시스템 — 3계층 토큰, 컴포넌트 인벤토리, 레이아웃/접근성 (DESIGN.md + tokens.json) | agents/design_agent.md | docs/DESIGN.md (+ docs/tokens.json) |
| tech_lead | Tech Lead Agent | 기술 판단, 최소 아키텍처, 구현 순서, Preflight | agents/tech_lead_agent.md | docs/04_TECH_PLAN.md |
| red_team | Red Team / Critic Agent | 실패 가능성, 고객이 안 쓸 이유, 리스크 반박 | agents/red_team_critic_agent.md | docs/05_RED_TEAM.md |

## 사용 원칙

```text
- 기본적으로 이 index만 읽는다.
- 실제 prompt 원문은 runAgent가 파일로 로드한다.
- 사람이 읽는 컨텍스트로 agents/*.md 전체를 매번 열지 않는다.
- 특정 agent 출력 문제가 생겼을 때만 해당 prompt 하나를 연다.
```
