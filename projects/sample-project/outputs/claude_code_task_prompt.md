# Claude Code 작업 지시문 — sample-project

생성: 2026-07-06 (harness task-prompt, provider: mock)

## Context
- 프로젝트: sample-project
- 마지막 workflow: `idea-validation` (완료: chief_of_staff → research → pm → red_team → founder_ceo)
- CEO 핵심 판단: [MOCK] Founder CEO Agent의 판단 결과 (실제 LLM 미호출). 역할 관점에서 이 아이디어는 조건부로 진행 가능하다.

## Task
아래 판단 문서를 근거로 다음을 수행한다 (우선순위 순):
1. [MOCK] 다음에 해야 할 일 1
2. [MOCK] 다음에 해야 할 일 2

## Include (읽을 것)
- docs/00_IDEA.md
- docs/01_RESEARCH.md
- docs/02_PRD.md
- docs/05_RED_TEAM.md
- docs/06_CEO_DECISION.md
- docs/API_CONTRACT.md

## Exclude (건드리지 말 것)
- 위 Include에 없는 무관한 파일
- .env 및 secrets 파일
- 하네스 자체 소스(src/, registry/, agents/)

## Rules
- 작업 전 구현 계획을 먼저 제시하고, 사용자 승인 전에는 파일을 수정하지 않는다.
- 관련 없는 파일은 열지 않고, 한 번에 하나의 기능만 구현한다.
- 패키지 설치가 필요하면 이유와 대체안을 먼저 제시한다. 승인 없이 설치하지 않는다.
- 배포, DB migration/변경, git push는 실행하지 않는다.
- .env, secrets 파일은 읽거나 출력하지 않는다.
- 수정 후 변경 파일, 실행한 명령어, 남은 TODO를 요약한다.
- 작업 결과는 docs/WORKLOG.md에 남긴다.

## Done Criteria
- Task 항목이 구현되고 로컬에서 동작 확인됨
- 변경 파일/실행 명령/남은 TODO가 요약됨
- docs/WORKLOG.md에 결과 기록됨
- 승인 없는 패키지 설치/배포/DB 변경이 없음
