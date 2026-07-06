# TASKS.md

## 진행 중

- [x] 하네스 v1 구현 완료 (2026-07-06) — acceptance Test 1~5 전부 통과

## 구현 순서 (v1)

1. [x] 프로젝트 scaffold (package.json, tsconfig, cli entry)
2. [x] registry 로드 (agent_registry.json, workflows.json)
3. [x] harness list
4. [x] harness init (docs 템플릿 6개 + outputs)
5. [x] mock provider + runAgent (prompt 파일 로드 → mock 결과)
6. [x] runWorkflow (순서 실행, 결과 markdown 저장, run_state.json 기록, 실패 시 failed_agent 기록)
6-1. [x] 결과 필수 섹션 헤더 validator (누락 시 경고)
7. [x] harness summary (CONTEXT_SUMMARY.md 갱신)
8. [x] harness task-prompt (Context/Task/Include/Exclude/Rules/Done Criteria)
9. [x] acceptance test 1~5 통과 확인 (scripts/acceptance.sh, 30 checks all pass)

## v2 (진행 중)

- [x] provider 전략 C안 확정 + 설계 문서 (2026-07-06)
- [x] [v2-1] Provider 인터페이스 async화 + token usage 필드 + run_state 기록 (mock 30/30 유지)
- [x] [v2-2] claude-code provider(B안) 구현 — `claude -p` 위임, 실제 LLM 첫 연동 (dev-preflight end-to-end 검증, handoff 버그 수정)
- [ ] [v2-3] anthropic provider(A안) — API 직접 (@anthropic-ai/sdk, 사용자 승인 후)
- [ ] [v2-4~] 루프 엔지니어링 (스키마 재생성 → Red Team → CEO 게이트)

## 완료

- [x] 문서/레포 구조 정리 (2026-07-06)
