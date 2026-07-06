# CLAUDE.md

이 레포는 Solo Founder AI Harness v1 (TypeScript CLI MVP)이다.

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
- docs/backlog/*
- docs/IMPLEMENTATION_PLAYBOOK.md (사람용 진행 플레이북 — 사용자가 범위를 지정해주므로 직접 읽을 필요 없음)
- docs/reference/* (아래 호출 조건에 해당할 때만)
- docs/reference/ROADMAP.md (v2/v3 계획 — v1 개발 중 읽지 않는다. 범위 확장 방지)

## reference 호출 조건

- AGENT_OUTPUT_SCHEMA.md: 결과 저장/validation/task prompt 로직 구현 시
- PERMISSION_POLICY.md: task prompt 안전 규칙 구현 시
- EVALUATION_CHECKLIST.md: acceptance test 보강 시
- FAILURE_RECOVERY.md: error handling / failed_agent 기록 구현 시

## v1 규칙

- mock provider 기반 CLI MVP. 실제 LLM 호출 없이 동작해야 한다.
- 필수 명령: init / list / run / summary / task-prompt
- 금지: Claude Code 자동 실행, Codex 자동 리뷰, OMC 연동, Agent Teams 연동, 웹 UI, DB, 배포, 결제
- 패키지 설치는 사전 승인 후 진행한다.
- 완료 기준: docs/ACCEPTANCE_TEST_CHECKLIST.md의 Test 1~5 전부 통과
- workflow 실행마다 outputs/run_state.json 기록, 결과 저장 시 필수 섹션 헤더 검증(경고)
- Opus 모델 세션: 지시를 문자 그대로 따르고, 명세에 없는 기능을 추가하지 않으며, 승인 전 파일 수정 금지 (상세: prompts/opus_optimization_guide.md)

## 작업 종료 시

- WORKLOG.md 업데이트
- 중요 결정은 DECISIONS.md 기록
- CONTEXT_SUMMARY.md를 짧게 갱신 (다음 세션 시작용)
