# HARNESS_MVP_SPEC.md

## 1. 문서 목적

이 문서는 Solo Founder AI Harness v1의 정확한 범위와 성공 기준을 고정하기 위한 명세서다.

하네스 v1의 목표는 완전 자동 개발 시스템이 아니다.  
목표는 **7개 코어 에이전트 프롬프트를 기반으로 아이디어 검토부터 Claude Code 작업 지시문 생성까지 자동 문서화하는 CLI MVP**를 만드는 것이다.

---

## 2. 제품 한 줄 정의

Solo Founder AI Harness는 1인 창업자가 아이디어를 입력하면, 필요한 에이전트 워크플로우를 실행해 Research, PM, UX, Tech Lead, Red Team, CEO 판단 문서를 생성하고, Claude Code에 넘길 안전한 작업 지시문을 만들어주는 CLI 도구다.

---

## 3. v1 핵심 목표

v1에서 반드시 달성해야 하는 목표는 다음이다.

```text
사용자 아이디어 입력
→ workflow 선택
→ agent prompt 로드
→ agent 결과 markdown 저장
→ CONTEXT_SUMMARY.md 갱신
→ Claude Code 작업 지시문 생성
```

---

## 4. v1 포함 기능

### 4.1 프로젝트 초기화

명령:

```bash
harness init <projectName>
```

생성 대상:

```text
projects/<projectName>/
  docs/
    00_IDEA.md
    TASKS.md
    DECISIONS.md
    CONTEXT_SUMMARY.md
    WORKLOG.md
    API_CONTRACT.md
  outputs/
```

참고:

- init이 만드는 docs는 위 6개뿐이다 (ACCEPTANCE_TEST_CHECKLIST Test 1과 동일 기준).
- `01_RESEARCH.md` ~ `06_CEO_DECISION.md`는 init이 아니라 workflow 실행(`harness run`) 시 각 agent 결과로 생성된다.
- `HANDOFF.md`는 v1에서 제외한다. 필요 시 v2에서 추가한다.

### 4.2 워크플로우 실행

명령:

```bash
harness run <workflowName> --project <projectName>
```

v1 기본 workflow:

```text
idea-validation
mvp-planning
dev-preflight
full-predev
```

### 4.3 에이전트 프롬프트 로드

하네스는 아래 파일을 로드한다.

```text
agents/common_agent_operating_prompt_v3.md
agents/founder_ceo_agent.md
agents/chief_of_staff_agent.md
agents/research_agent.md
agents/pm_product_strategy_agent.md
agents/ux_ui_design_agent.md
agents/tech_lead_agent.md
agents/red_team_critic_agent.md
```

### 4.4 결과 저장

각 agent 실행 결과는 markdown으로 저장한다.

예시:

```text
projects/my-project/docs/01_RESEARCH.md
projects/my-project/docs/02_PRD.md
projects/my-project/docs/05_RED_TEAM.md
projects/my-project/docs/06_CEO_DECISION.md
projects/my-project/outputs/final_summary.md
```

저장 시 최소 검증:

- agent 결과에 AGENT_OUTPUT_SCHEMA의 필수 섹션 헤더(Metadata, Main Judgment, Risks, Next Actions)가 존재하는지 확인한다.
- 누락 시 저장은 하되 경고를 출력하고 run_state에 기록한다. (v1은 경고까지만, 재생성은 v2)

### 4.4.1 run_state 기록

workflow 실행마다 `projects/<projectName>/outputs/run_state.json`을 기록한다.

최소 필드:

```json
{
  "workflow_id": "",
  "project": "",
  "completed_steps": [],
  "failed_agent": null,
  "warnings": [],
  "started_at": "",
  "finished_at": ""
}
```

v1에서는 기록만 한다. `--resume`은 v2에서 이 파일을 기반으로 구현한다.

### 4.5 요약 갱신

명령:

```bash
harness summary --project <projectName>
```

역할:

- docs와 outputs를 읽는다.
- `CONTEXT_SUMMARY.md`를 짧게 갱신한다.
- 새 Claude Code 세션이 현재 상태를 이해할 수 있게 한다.

### 4.6 Claude Code 작업 지시문 생성

명령:

```bash
harness task-prompt --project <projectName>
```

출력:

```text
projects/<projectName>/outputs/claude_code_task_prompt.md
```

---

## 5. v1 제외 기능

다음은 v1에서 만들지 않는다.

```text
- Claude Code 자동 실행
- Codex 자동 실행
- OMC 자동 실행
- Agent Teams 자동 연동
- GitHub PR 자동 생성
- 배포 자동화
- DB 연동
- 웹 UI
- 로그인
- 결제
- 멀티유저 기능
- 실시간 agent-to-agent 채팅
- 복잡한 plugin 시스템
- 파일 자동 수정
```

---

## 6. 필수 CLI 명령

v1 필수 명령:

```bash
harness init <projectName>
harness list
harness run <workflowName> --project <projectName>
harness summary --project <projectName>
harness task-prompt --project <projectName>
```

---

## 7. 기본 Workflow

### 7.1 idea-validation

목적: 아이디어를 개발하기 전에 검토한다.

순서:

```text
chief_of_staff
→ research
→ pm
→ red_team
→ founder_ceo
```

### 7.2 mvp-planning

목적: MVP 범위와 화면/기술 계획을 정리한다.

순서:

```text
pm
→ ux_ui
→ tech_lead
→ red_team
→ founder_ceo
```

### 7.3 dev-preflight

목적: Claude Code 개발 착수 전 기술/리스크/작업 순서를 점검한다.

순서:

```text
tech_lead
→ red_team
→ chief_of_staff
```

### 7.4 full-predev

목적: 아이디어부터 개발 착수까지 전체 사전 검토를 한 번에 실행한다.

순서:

```text
chief_of_staff
→ research
→ pm
→ ux_ui
→ tech_lead
→ red_team
→ founder_ceo
```

---

## 8. 성공 기준

v1은 다음 조건을 만족하면 성공이다.

```text
- harness init이 동작한다.
- sample project docs와 outputs 폴더가 생성된다.
- harness list가 agents와 workflows를 출력한다.
- harness run idea-validation이 mock provider로 동작한다.
- 각 agent 결과가 markdown으로 저장된다.
- harness summary가 CONTEXT_SUMMARY.md를 갱신한다.
- harness task-prompt가 Claude Code 작업 지시문을 생성한다.
- README에 사용법이 정리되어 있다.
```

---

## 9. 실패 기준

다음 상태가 되면 v1 범위를 벗어난 것이다.

```text
- 실제 Claude Code 실행까지 자동화하려 한다.
- OMC, Codex, Agent Teams 연동을 먼저 만들려 한다.
- 웹 UI를 먼저 만든다.
- DB나 계정을 붙인다.
- 7개 agent를 항상 무조건 다 실행한다.
- 결과 문서가 너무 길어져 다시 읽기 어렵다.
- 파일 수정/패키지 설치/배포를 자동으로 수행한다.
```

---

## 10. v2 이후 후보

v1이 안정화된 뒤 검토할 기능:

```text
- 실제 LLM provider 연결
- agent output schema 검증 강화
- retry / resume
- Codex review prompt 자동 생성
- Claude Code SDK/CLI 연동
- OMC task prompt 생성
- Agent Teams 실험
- 간단한 웹 UI
- GitHub issue/PR 연동
```
