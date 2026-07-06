# TASKS.md

## 진행 중

- [ ] 하네스 v1 구현 착수

## 구현 순서 (v1)

1. [x] 프로젝트 scaffold (package.json, tsconfig, cli entry)
2. [x] registry 로드 (agent_registry.json, workflows.json)
3. [x] harness list
4. [x] harness init (docs 템플릿 6개 + outputs)
5. [x] mock provider + runAgent (prompt 파일 로드 → mock 결과)
6. [x] runWorkflow (순서 실행, 결과 markdown 저장, run_state.json 기록, 실패 시 failed_agent 기록)
6-1. [x] 결과 필수 섹션 헤더 validator (누락 시 경고)
7. [x] harness summary (CONTEXT_SUMMARY.md 갱신)
8. [ ] harness task-prompt (Context/Task/Include/Exclude/Rules/Done Criteria)
9. [ ] acceptance test 1~5 통과 확인

## 완료

- [x] 문서/레포 구조 정리 (2026-07-06)
