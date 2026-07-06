# WORKLOG.md

## 2026-07-06

- 레포 구조 정리, registry JSON 생성, spec 불일치 수정
- git init + 원격(agrade1) 연결 + 초기 커밋/푸시 (아이디어 문서 IDEA_*.md는 .gitignore 제외)
- [1] scaffold: package.json/tsconfig/src/cli.ts, 최소 의존성(commander/tsx/typescript) 설치, 5개 명령 뼈대 + tsc 빌드 통과
- [2] registry 로드: src/core/paths.ts(REPO_ROOT), src/core/registry.ts(agent/workflow 로더 + 타입 + find 헬퍼)
- [3] harness list: src/commands/list.ts, acceptance Test 2 통과 (7 agents / common prompt 존재 / 4 workflows)
- [4] harness init: src/core/project.ts + src/commands/init.ts, 필수 docs 6개 + outputs 생성, 기존 파일 보호, acceptance Test 1 통과
- [5] mock provider + runAgent: src/providers/{provider,mockProvider}.ts + src/core/runAgent.ts, 스키마 필수 4헤더 출력·prompt 누락 throw 검증
- [6][6-1] runWorkflow + validator + saveArtifact: src/core/{runWorkflow,validate,saveArtifact}.ts + src/commands/run.ts. acceptance Test 3 전 조건 통과(순서/저장/run_state/failed_agent 중단/필수헤더 경고)
- [7] harness summary: src/core/summary.ts + src/commands/summary.ts. run_state+docs 읽어 CONTEXT_SUMMARY 갱신, 다음 작업 도출. acceptance Test 4 통과
- [8] harness task-prompt: src/core/taskPrompt.ts + src/commands/taskPrompt.ts. Context/Task/Include/Exclude/Rules/Done Criteria + 안전 규칙(설치/배포/DB) 포함. acceptance Test 5 통과
- [9] 통합 검증: scripts/acceptance.sh (npm test) — Test 1~5 자동 검증 30 checks all pass. README 사용법/테스트 섹션 추가. **v1 완료.**

## 2026-07-06 (v2 착수)

- v1 재검증: npm test 30/30 통과, 5개 명령 라이브 데모 정상 확인
- provider 전략 C안 확정 (구독기반 B안 지금 / API A안 나중) — 설계 문서 docs/reference/PROVIDER_ARCHITECTURE_V2.md 작성, V2_KICKOFF 링크
- [v2-1] Provider 인터페이스 async화 + token usage 필드 신설:
  - provider.ts: `generate()` 동기 string → `Promise<AgentResult>`, TokenUsage/AgentResult 타입 추가
  - mockProvider.ts: async화, usage 0 반환 (테스트/오프라인 기반 유지)
  - runAgent.ts / runWorkflow.ts: async 전파, run_state에 `provider` + `usage`(per_agent 합계) 기록
  - providers/index.ts: provider 셀렉터(getProvider), 현재 mock만 등록
  - cli.ts/run.ts: `run --provider <id>` 플래그(기본 mock), async action
  - 회귀 검증: acceptance 30/30 그대로 통과. run_state 새 필드 라이브 확인.
- [v2-2] claude-code provider(B안) 구현 — 실제 LLM 첫 연동:
  - claudeCodeProvider.ts: `claude -p --output-format json` 에 프롬프트를 stdin으로 위임, JSON `.result`/`.usage` 파싱, 코드펜스 제거. 환경변수(HARNESS_CLAUDE_BIN/MODEL/TIMEOUT_MS).
  - AgentRunInput에 `ideaContent` 추가, runAgent가 docs/00_IDEA.md 로드해 전달 (실제 LLM이 검토할 아이디어).
  - buildPrompt: common+agent 프롬프트 + 아이디어 + 컨텍스트 + AGENT_OUTPUT_SCHEMA 출력형식 지시.
  - providers/index.ts에 claude-code 등록.
  - **버그 수정**: extractMainJudgment가 불릿만 뽑아 실제 LLM의 문단형 Main Judgment를 놓쳐 handoff 요약이 비었음 → 첫 비어있지 않은 줄(불릿/문단 both) 반환하도록 수정.
  - 검증: `claude -p` 스모크(stdin+JSON shape 확인) → dev-preflight(3 agent) end-to-end 실행 성공(경고 0, usage 집계 in 9399/out 12798, ~3.5분). 실제 출력 스키마 준수 확인. acceptance 30/30 유지.
- [v2-3] 스키마 검증 재생성 루프 (V2_KICKOFF 2번, "가장 쉬운 첫 루프"):
  - runWorkflow: 각 step에서 validateAgentOutput 실패 시 누락 헤더를 retryFeedback으로 넘겨 maxRegenerations회(기본 1)까지 재생성. 재생성 후에도 실패면 경고+저장(기존 동작).
  - AgentRunInput.retryFeedback / RunAgentArgs.retryFeedback 추가, claudeCodeProvider가 프롬프트에 "재작성 지시" 블록으로 반영. mock은 항상 유효 → 미발동.
  - run_state에 regenerations[{agent_id, attempts, resolved}] 라운드 기록. usage는 재생성 포함 전 시도 합산.
  - CLI `--max-regen <n>` 플래그, run 출력에 재생성 요약.
  - 검증: flaky provider(1차 Risks 누락→재생성 시 포함)로 루프 결정적 테스트 — 재생성 1회 후 resolved:true, usage 합산 확인. mock acceptance 30/30 유지. README v2 섹션 추가.
- [v2-4] Red Team 비평 루프 (V2_KICKOFF 3번) — 워크플로우 아키텍처 확장:
  - workflows.json steps를 `(string | {critique_loop})[]` union으로 확장. registry에 CritiqueLoopDef/WorkflowStep/isCritiqueLoop 추가.
  - runWorkflow 전면 재작성: 재생성 로직을 runStepWithRegen 헬퍼로 추출, priorFindings를 Map(upsert, 순서유지)로. 비평 루프 실행부 추가.
  - 루프: critic 실행 → extractCriticalRisks로 Critical 추출 → 있으면 target에 revisionRequest로 되먹여 revise → 재검토. Critical 소멸 또는 max_rounds까지. run_state.critique_rounds 기록.
  - AgentRunInput.revisionRequest 추가, claudeCodeProvider가 "비평 반영 수정 지시" 블록으로 반영.
  - mvp-planning에 루프 내장(tech_lead⟲red_team×2) — 워크플로우 4개 유지(acceptance 무영향). list가 `↻[critic⟲target×N]` 렌더링.
  - 검증: mock(Critical 0→라운드1 해소) + stub provider(Critical 발견→revise→라운드2 해소) 두 경로 결정적 확인. completed_steps 중복제거, usage 재실행분 집계. acceptance 30/30 유지.
- 다음: [v2-5] anthropic provider(A안, 설치 승인 후) 또는 [v2-6] CEO 게이트 분기(V2_KICKOFF 4번)
