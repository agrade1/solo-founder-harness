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
- [x] [v2-3] 스키마 검증 재생성 루프 — 누락 헤더 피드백 재생성(--max-regen), run_state 라운드 기록 (flaky provider로 검증)
- [x] [v2-4] Red Team 비평 루프 — steps를 loop 구성으로 확장, critic Critical→target revise→재검토(critique_rounds). mvp-planning에 내장 (mock+stub 검증)
- [x] [v2-5] anthropic provider(A안) — @anthropic-ai/sdk 연동, 공유 프롬프트 빌더. 키 없을 때 안전 실패 (실제 유료 호출은 미검증)
- [x] [v2-6] CEO 게이트 분기 — WorkflowStep에 {gate} 확장, 판정→되돌림(max_jumps). full-predev에 내장 (mock+stub 검증)
- [x] [v2.1-A] 라이브러리화 — PACKAGE_ROOT(자산)/WORKSPACE_ROOT(CWD) 경로 분리, install-ready (외부 CWD 검증)
- [~] [B-①] FE/BE 전문 에이전트 — 정적 추가는 보류(동적 분화로 대체), 필요 시 수동
- [x] [B-②] 동적 분화(fanout) — planner SPAWN 선언 → 승인(--allow-spawn) → 하위 에이전트 런타임 실행. dev-preflight 내장 (stub 검증)
- [x] [B-③] task-prompt 멀티에이전트 실행 스펙 — 분화 시 FE/BE 병렬 subagent 지시문 생성(승인 게이트). 실제 코딩은 Claude Code (stub 검증)
- [ ] (선택) 하네스→Claude Code 실행 자동 연동 (스펙 생성 넘어 실행 트리거, 승인 게이트 필수) — 신중히
- [ ] (선택) Obsidian 연동 (V2_KICKOFF 5번)

## 완료

- [x] 문서/레포 구조 정리 (2026-07-06)
