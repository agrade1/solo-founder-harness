# CLAUDE.md

이 레포는 Solo Founder AI Harness다 (TypeScript CLI). v1은 문서 자동화(init/list/run/summary/task-prompt),
이후 exec/mission 실행 계층이 추가되었다. 실행 계층은 승인·권한 게이트 안에서만 동작한다 — 승인 없는 코드 수정·production 변경은 없다.

## 세션 시작 시 읽을 문서 (이것만)

```text
CLAUDE.md
docs/HARNESS_MVP_SPEC.md
docs/ACCEPTANCE_TEST_CHECKLIST.md
docs/TASKS.md
docs/CONTEXT_SUMMARY.md
agents/AGENTS_INDEX.md
```

## 읽지 말 것

- agents/*.md 원문 전체 (경로/존재 확인만, 특정 agent 디버깅 시에만 해당 파일 하나를 연다)
- docs/backlog/* — 단, 예외: 사용자가 V3 작업을 명시적으로 요청한 경우에만 아래 두 활성 문서를 읽는다.
  - `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`
  - `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`
  - 그 외 backlog 문서는 사용자가 직접 지정하지 않는 한 구현 근거로 사용하지 않는다.
- docs/IMPLEMENTATION_PLAYBOOK.md (사람용 진행 플레이북 — 사용자가 범위를 지정해주므로 직접 읽을 필요 없음)
- docs/reference/* (아래 호출 조건에 해당할 때만)
- docs/reference/ROADMAP.md (v2/v3 계획 — v1 개발 중 읽지 않는다. 범위 확장 방지)

## reference 호출 조건

- AGENT_OUTPUT_SCHEMA.md: 결과 저장/validation/task prompt 로직 구현 시
- PERMISSION_POLICY.md: task prompt 안전 규칙 구현 시
- EVALUATION_CHECKLIST.md: acceptance test 보강 시
- FAILURE_RECOVERY.md: error handling / failed_agent 기록 구현 시

## 규칙 (현행)

- mock provider는 무과금 테스트 기본값이다. claude-code/anthropic provider와 exec/mission 실행 계층은 실제 LLM 호출을 한다.
- 필수 명령: init / list / run / summary / task-prompt (+ 실행 계층: exec / mission)
- exec/mission 실행은 승인·권한 게이트 안에서만 동작한다. 승인 없는 코드 수정·production 변경(배포/DB/live 결제)은 금지.
- 금지(v1 문서 자동화 범위): Codex 자동 리뷰, OMC 연동, Agent Teams 연동, 웹 UI, DB, 배포, 결제
- 패키지 설치는 사전 승인 후 진행한다.
- 완료 기준: docs/ACCEPTANCE_TEST_CHECKLIST.md의 Test 1~5 전부 통과
- workflow 실행마다 outputs/run_state.json 기록, 결과 저장 시 필수 섹션 헤더 검증(경고)
- Opus 모델 세션: 지시를 문자 그대로 따르고, 명세에 없는 기능을 추가하지 않으며, 승인 전 파일 수정 금지 (상세: prompts/opus_optimization_guide.md)

## 작업 종료 시

- WORKLOG.md 업데이트
- 중요 결정은 DECISIONS.md 기록
- CONTEXT_SUMMARY.md를 짧게 갱신 (다음 세션 시작용)

## V3 활성 설계 문서

V3 작업은 아래 두 문서만 구현 기준으로 사용한다.

1. `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`
2. `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`

`docs/archive/V3_KICKOFF_SUPERSEDED.md`는 기존 `V3_KICKOFF.md`의 과거 계획 기록이며(archive로 이동됨)
구현 근거로 사용하지 않는다. 문서 간 충돌 시 위 두 활성 문서가 우선한다.

`docs/backlog/V3_FIELD_NOTES.md`는 실측 근거로만 참고하며,
해당 문서만을 근거로 신규 기능을 구현하지 않는다.
