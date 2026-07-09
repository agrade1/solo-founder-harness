# WORKLOG.md

## 2026-07-09 (실행 계층 §9-6 — L3 리뷰어 + revise 루프)

- **reviewer.ts**: 신선 컨텍스트 L3 리뷰어(Opus 고정, plan 모드 읽기전용, --fork 금지). diff+SPEC+계약 인라인 → `### Critical` 스키마(red_team과 동일) → extractCriticalRisks 재사용.
- **SessionRunner 통합**: L1 게이트·커밋·diff 후 리뷰 루프 — Critical이면 코더에 --resume revise 주입 → 재게이트·재리뷰(max 2R) → 소진 시 review_deferred(병합 차단). `finalize()`/`consumeTurn()` 헬퍼로 재사용. SessionOutcome.reviews 기록.
- **harness exec --review [--review-rounds n]**.
- **실세션 e2e PASS**: 코더가 sum.js+sum.test.js 생성 → plan 모드 리뷰어 정상 판정(Critical 0) → develop 병합. plan 모드 리뷰어가 파싱 가능한 판정 텍스트를 냄을 실검증.
- 테스트: exec 단위 **51/51**(reviewer 3 + review 루프 3경로: 통과/revise후통과/라운드소진) + acceptance 57/57.
- 다음: §9-7 미션 모드(브리프·사전승인·defer·강등·turn 예산) → §9-8(자동 병합·rate limit 재개·MISSION_REPORT).

## 2026-07-09 (실행 계층 §9-5 — v3 대화형 단일 실행 완주)

- **§9-5 독립 조각**: `promptCompiler.ts`(SessionSpec→착수 프롬프트, 하이브리드) + `diffPreview.ts`(base 대비 변경 수집·요약) + `approvalQueue.ts`(승인 직렬화 FIFO + approve/reject/defer). SessionSpec에 task/inputs/contractPaths/dod 추가.
- **§9-5 통합**: `sessionRunner.ts`(worktree→권한컴파일→프롬프트→세션실행→L1게이트→자기브랜치 커밋→diff→승인→base 병합) + `harness exec` CLI(--task/--role/--base/--yes/--no-merge 등, stdin 승인 y/d/N, 이벤트 마일스톤 출력).
- **실제 세션 e2e 스모크 PASS** (임시 repo, 구독 토큰): 진짜 claude 세션이 hello.txt 생성 → 게이트 통과 → develop 병합, `develop:hello.txt="harness\n"` 검증. → **권한 컴파일러 `--settings` 실 CLI 수용 확인**(§9-3 미검증 항목 해소).
- settings는 worktree 밖(repoRoot/.harness/sessions)에 써서 세션 diff 미오염(테스트가 잡은 버그 수정).
- 테스트: exec 단위 **45/45**(promptCompiler·diff·queue·SessionRunner 오케스트레이션 4경로 mock+실git) + acceptance 57/57.
- 다음: §9-6 Opus 리뷰어 세션(L3) + revise 루프.

## 2026-07-09 (실행 계층 §9-3·§9-4 + ARCH v0.3 결정 반영)

- **ARCH v0.3 확정 반영**(페이블): Q1=Model A(one-shot+resume, B기각), Q2=하이브리드 프롬프트, Q3=그레이스1턴→DEFERRED. claudeCliProvider 잠정 딱지 제거, DESIGN_QUESTIONS 해소 마킹.
- **§9-3 권한 컴파일러**: `registry/permission_policy.json`(PERMISSION_POLICY §7 기계본) + `permissionCompiler.ts`(SessionSpec+정책→allow/ask/deny 규칙 + Claude Code settings + T3 hookDenyPatterns + materializeSettings). claudeCliProvider `--settings` 연결. SessionSpec에 ownership/forbidden/settingsPath 추가.
- **§9-4 worktree + L1 게이트**: `worktree.ts`(세션당 git worktree/브랜치 생성·제거·조회, develop 기준) + `machineGate.ts`(typecheck/lint/test/build 탐지·실행, 없으면 skip) + `runProcess.ts`(버퍼링 헬퍼). `.harness/` gitignore.
- 테스트: exec 단위 **29/29**(파서/mock/권한/worktree(실git 임시레포)/게이트) + acceptance 57/57. `npm test`=exec+acceptance. dist 재빌드(테스트·fixture 제외).
- 다음: §9-5 대화형 게이트(ApprovalQueue)+diff 미리보기+tell+PromptCompiler → v3 acceptance.

## 2026-07-08 (실행 계층 구현 착수 — §9-1·§9-2)

- 역할 분담 확정: **구현은 이 세션, 설계는 Fable 세션.** 설계 필요 지점은 `docs/reference/EXECUTION_DESIGN_QUESTIONS.md`에 정리만.
- **§9-1 CLI 실측**(`EXECUTION_CLI_RECON.md`): claude 2.1.204 플래그 매칭 — stream-json/resume/session-id/permission-mode(acceptEdits)/allowedTools/append-system-prompt/model/fallback-model/add-dir/agents 전부 존재. 어긋난 전제: `--max-turns` 부재 → 오케스트레이터 이벤트 카운팅. print+stream-json은 `--verbose` 필수.
- **stream-json 스키마 프로브**(승인 후 실호출 1회, $0.06): 이벤트 타입별 필드 박제. rate_limit_event(resetsAt/rateLimitType) 실존 → 강등·체크포인트 실데이터 구동. hook_response로 T3 거부 실시간 관측. 구독에서도 total_cost_usd/modelUsage 채워짐.
- **§9-2 ExecutionProvider 골격**(`src/exec/`): types(SessionEvent 정규화·SessionSpec·ExecutionProvider) + streamParser(NDJSON→이벤트, 청크 버퍼링) + eventQueue(async 스트림) + mockExecProvider(무과금 재생) + claudeCliProvider(Model A 잠정, --resume 체이닝). 단위 테스트 10/10(`npm run test:exec`, 실측 fixture 기반). `npm test`=exec 10 + acceptance 57. build/dist 정리(테스트·fixture 제외).
- **설계 미결**: 세션 수명 모델 A(one-shot+resume) vs B(지속형 stdin) = DESIGN_QUESTIONS Q1(블로킹). initialPrompt 조립(Q2), turn 예산 초과 동작(Q3).

## 2026-07-08 (진행 표시 UX + 실행 계층 설계 핸드오프)

- **진행 표시자(ProgressReporter) 추가.** run 중 각 agent LLM 호출이 침묵하던 문제 해결. TTY면 한 줄 스피너(`⠹ [2/5] research 실행 중… 0:42`) + 경과시간 제자리 갱신, 비TTY(파이프/로그)면 `▶ 시작` 줄만 폴백. 완료 라인에 `[i/N]` 카운터 + 경과시간(`[2/5] ✓ research → ... (42s)`).
  - core는 순수 유지: `runWorkflow.ts`에 `ProgressReporter` 인터페이스 + `reporter?` 주입, 스피너 구현은 CLI 계층(`src/commands/progress.ts`). 외부 패키지 0. 재생성 경고는 `reporter.note`로 스피너 훼손 없이 출력.
  - mock `npm test` 57/57 유지, tsc 통과, dist 재빌드.
- **실행 계층 설계 브리핑 문서 작성** (`docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`). 창업자 비전("문서→자동 Claude Code 실행→병행/다중 라이브 세션→라이브 분화, 큰 이슈만 예/아니요")과 현재 v2.6.0(앞쪽 절반=문서 생성만) 갭 정리 + 재사용 뼈대(승인게이트/fanout/claude-code provider/ProgressReporter) + 설계 세션이 답할 질문. **설계 자체는 별도 Fable 모드 세션에서 진행 예정.**

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
- [v2-6] CEO 게이트 분기 (V2_KICKOFF 4번):
  - registry에 GateDef/isGate 추가, WorkflowStep union에 `{gate}` 확장.
  - validate.extractDecision: Main Judgment + Decisions 섹션만 검색(문서 전체 검색은 Input Summary 역할설명 boilerplate 오탐 → 버그 발견·수정).
  - runWorkflow: gate 분기 추가. decider 판정이 on 키와 맞으면 해당 agent step으로 i 되돌림. gateBudget(step별 max_jumps)로 무한루프 방지. lastMarkdown 맵으로 판정 원문 보관. run_state.gate_jumps 기록.
  - full-predev에 게이트 내장(founder_ceo→{축소:pm,검증:research}×1). list `⤴[decider?분기×N]` 렌더링, run 요약에 게이트 표시.
  - 검증: mock(판정 미매칭→진행) + stub(축소→pm 되돌림→재실행→진행) 두 경로 + max_jumps 준수 확인. acceptance 30/30.
- [v2-5] anthropic provider (A안):
  - @anthropic-ai/sdk 설치(v0.110). anthropicProvider.ts: messages.create(system+user), usage 파싱. ANTHROPIC_API_KEY 없으면 명확한 에러(claude-code 안내). 기본 모델 claude-opus-4-8(HARNESS_ANTHROPIC_MODEL로 변경).
  - promptParts.ts로 프롬프트 빌더 공유(claude-code/anthropic 중복 제거) — claude-code buildPrompt 리팩터.
  - index.ts에 anthropic 등록. 기본 provider는 계속 mock.
  - 검증: 키 없을 때 failed_agent 경로로 깔끔히 실패(유료호출 X). 공유 빌더 구조 결정적 확인. **실제 유료 API 호출은 미검증**(사용자가 키 세팅 후).
- [실전 검증] mvp-planning을 claude-code로 실제 실행(카페 재고앱 아이디어): 비평 루프가 실제로 작동 확인 — red_team이 Critical 2건("입력 동기 부재", "감 대비 우위 미검증") 발견 → tech_lead가 반영해 수정("코드 쓰지 말고 검증부터") → red_team 재검토 여전히 2건 → max_rounds 소진 종료(무한루프 방지 정상). 9분41초, in 22K/out 33K. 루프가 출력을 유의미하게 개선함 확인.
- **v2 완료.** provider 3종 + 루프 3종 완비, 실전 검증. develop→main 병합 + v2.0.0 태그.

## 2026-07-07 (v2.1 — 라이브러리화)

- [v2.1-A] 하네스를 설치형 라이브러리로: 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, 사용자 데이터)로 분리.
  - paths.ts: fromRoot → fromPackage(자산) + fromWorkspace(projects, CWD 기준, HARNESS_WORKSPACE 오버라이드).
  - registry/runAgent(프롬프트)=fromPackage, project(projects)=fromWorkspace로 전환.
  - package.json: version 2.1.0, files=[dist,agents,registry,README], engines node>=18, prepublishOnly=build, repository.
  - 효과: 서비스 레포마다 `npm install github:...` 후 `npx harness init`하면 그 레포에 projects/ 생성. 하네스 레포에 서비스 안 쌓임.
  - 검증: 하네스 레포 밖 임시 디렉토리에서 실행 → 자산은 패키지 로드, projects는 CWD 생성, 하네스 레포 미오염 확인. npm pack --dry-run으로 배포 파일 검증. acceptance 30/30 유지(개발 CWD=레포루트라 동일).
  - publish는 안 함(사용자 결정). install-ready까지.
- [B-②] 동적 분화(fanout) 추가:
  - registry: FanoutDef/isFanout, WorkflowStep union에 `{fanout}` 확장.
  - validate.extractSpawnDeclarations: `SPAWN id=.. | name=.. | focus=..` 파싱(id 정규화, 중복 제거).
  - 메인 루프: string step 다음이 fanout(planner=this)면 spawnRequest 주입 → planner 출력에 SPAWN 블록 유도. AgentRunInput.spawnRequest + provider 반영.
  - fanout step: planner 출력의 SPAWN 선언 파싱(max_agents 상한) → run_state.spawned_agents 기록. **기본은 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 에이전트 런타임 생성·실행.
  - 하위 에이전트: 런타임 AgentDef + 생성 브리프(agentPromptText 오버라이드, runAgent가 prompt_path 파일 대신 사용) → outputs/spawned/<id>.md. 레포 영구등록 안 함.
  - dev-preflight에 fanout 내장(tech_lead→spawn×4). list `⑂[planner→spawn×N]`, run 요약 표시.
  - 검증: stub으로 계획만(executed:false) + --allow-spawn(실제 실행, outputs/spawned 생성) 두 모드 확인. acceptance 30/30 유지.
- **v2.2.0 태그** (동적 분화). develop→main 병합 + Release.
- [B-③] task-prompt를 멀티에이전트 실행 스펙으로 확장:
  - run_state.spawned_agents가 있으면 task-prompt에 "## 병렬 실행 (Claude Code subagents)" 섹션 추가 — FE/BE별 담당범위·계획문서(outputs/spawned/*.md)·산출범위 + API_CONTRACT 기준 통합 + 승인 게이트("자동 실행 금지").
  - Include에 spawned 계획문서 자동 포함. spawned 없으면 기존 단일 task-prompt 그대로(acceptance 무영향).
  - **경계 유지**: 하네스는 병렬 실행 "스펙을 생성"만. 실제 병렬 코딩은 Claude Code subagent가 사람 승인 후 수행(하네스가 코드 실행 안 함).
  - 검증: stub fanout(--allow-spawn) → task-prompt에 병렬 섹션·통합·Include 반영 확인. acceptance 30/30 유지.
- 다음(선택): 실전(claude-code) dev-preflight로 분화·병렬스펙 품질 체감, 또는 v2.3.0 태그.
- **v2.3.0 태그** (B-③ 멀티에이전트 task-prompt). develop→main 병합.

## 2026-07-07 (Obsidian 연동 — V2_KICKOFF 5번)

- [Obsidian] workflow 실행 결과를 Obsidian vault로 export:
  - src/core/obsidianExport.ts: `exportToVault({vault, state})` — run_state 기반으로 vault에 노트 사본 생성. 원본 프로젝트 파일은 읽기만(비파괴).
  - 각 완료 agent 출력 → `<vault>/<project>/<agent_id>.md`: YAML frontmatter(project/workflow/agent/role/provider/date/tags) + 원문 + "## 연결"(이전/다음/인덱스 `[[wikilink]]`).
  - run 인덱스 노트(MOC) `<workflow>_run.md`: 실행 순서대로 `[[wikilink]]` 나열 + 실행 메타(provider/토큰/비평루프/게이트/분화). tags에 moc 추가 → 그래프뷰 허브.
  - 분화된 하위 에이전트(spawn_*) 출력도 함께 export. safeName으로 노트명 안전화, YAML 값 이스케이프.
  - CLI `run --vault <path>` 플래그 + `HARNESS_VAULT` 환경변수. 미지정 시 export 안 함(기존 동작 무영향). export 실패해도 실행 결과 저장은 보존(경고만).
  - 검증: acceptance에 Test 6 추가(인덱스/agent 노트 생성, frontmatter, wikilink 양방향) → 35/35 통과. e2e로 vault 트리·노트 내용 확인.

## 2026-07-07 (v3 킥오프 → v2.5 안정화 Phase 0)

- **V3_KICKOFF.md(Fable 5 작성) 기반 착수.** v3 착수 조건(아이디어 2개 검증) 미충족 판정 → 버전 승격 원칙대로 Phase 0(v2.5 안정화: v2에서 보류했던 안전장치)을 v3 선결로 먼저 구현. 각 항목 단위 커밋(develop).
- **[v2.5 0-1] run --resume.** RunState에 status/failed_reason/resume_from/loop_state 추가(기존 필드 유지 → 하위호환). `--resume` 시 완료 step은 저장 산출물에서 findings만 복원(재실행 X), 중단 지점부터 완주. 완료 실행 재개는 덮어쓰기 방지(FAILURE_RECOVERY). loadRunState() export, summary는 실패 시 --resume 안내. 검증용 HARNESS_FAIL_AT 훅. acceptance Test 7.
- **[v2.5 0-2] token budget.** `run --max-tokens <n>` / `HARNESS_MAX_TOKENS`(기본 무제한). step 경계 누적(input+output) 검사 → 초과 시 status=failed, failed_reason="token_budget_exceeded", resume_from=다음 step → --resume 재개. 80% 도달 stderr 경고. 예산 중단도 exit 1. 검증용 HARNESS_MOCK_TOKENS 훅. acceptance Test 8.
- **[v2.5 0-3] approval gate.** WorkflowStep에 `{approval:{message,show}}` 타입 + isApproval. 승인 게이트: show 문서 표시 후 stdin y/N, 거부 시 user_rejected로 중단(--resume 재개), `--yes` 비대화 전체 승인. dev-preflight 마지막에 "개발 착수 승인" 1곳 내장(나머지 지점은 v3 executor 책임). list에 ✔[승인게이트]. acceptance Test 9.
- **[v2.5 0-4] Red Team 편향 분리.** AgentRunInput.contextMode(full|conclusion_only). critique_loop critic은 target 결론만 격리 검토(전체 findings 체인 anchoring 방지 — priorFindings를 target 결론만으로 제한 + 프롬프트 격리 문구). 일반 step은 full 유지. acceptance Test 10.
- 검증: mock `npm test` → **57/57 통과**.
- **남음(0-5, 사용자 액션)**: ① anthropic provider 유료 1회 실검증(ANTHROPIC_API_KEY + --max-tokens 상한), ② v2.5.0 태그(develop→main). 이후 Phase 1 도그푸딩(실제 아이디어 2개 full-predev 검증).

## 2026-07-08 (v2.5.0 릴리스 + Phase 1 도그푸딩)

- **v2.5.0 릴리스**: develop push → main 병합(--no-ff "Merge develop: v2.5 안정화 Phase 0") → v2.5.0 태그 + push. acceptance 57/57.
- **Phase 1 도그푸딩(claude-code 실제 LLM)**:
  - 아이디어 A(증적엔진)·B(폐쇄망) full-predev → **CEO 게이트 두 분기 실발화**(A 축소→pm, B 검증→research), max_jumps 가드 작동, 스키마 경고 0.
  - A dev-preflight(--allow-spawn --yes) → tech_lead 하위 3개 SPAWN 실제 실행 + approval gate 통과 + task-prompt 병렬 handoff 생성.
  - 하네스 self-review(mvp-planning) → critique_loop 2R 되먹임 + 0-4 편향분리(conclusion_only) 실전 검증. **red_team이 "결론만 받았다" 명시.**
  - 관찰·결론은 `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 projects/dogfood-*.
- **self-review 판정**: 하네스가 자신을 검토해 "v3 착수 조건(개발 착수 1건) 미충족 → 지금 v3.0 코딩 시작 말라"고 결론. 다음 코딩은 하네스가 아니라 실제 서비스 아이디어 쪽에서 나와야 함.

## 2026-07-08 (실사용 + v2.6.0 — ux_ui 디자인 레퍼런스 확장)

- **실사용 개발 착수(v3 게이트 충족)**: 별도 private 레포 `audit-evidence-engine`에 하네스 설치 → 아이디어 A full-predev(claude-code) + F idea-validation → task-prompt → 실제 코드 착수(`collect_evidence.sh`, 판정 경계 준수). "개발 착수 1건" 게이트 충족.
- **public 설치 지원**: dist를 레포에 커밋(.gitignore에서 제거) + build에 `chmod +x dist/cli.js` → `npm install github:agrade1/solo-founder-harness`가 빌드/스크립트 없이 동작. prepare 제거(소비자 경고 제거). README "사용 가이드" 섹션 추가. v2.5.1.
- **[v2.6.0] ux_ui 디자인 레퍼런스 확장**: ux_ui 에이전트가 레퍼런스 리서치 방향(Pinterest/Dribbble/Mobbin/경쟁사·유사서비스 + 검색 키워드) + 비주얼 방향 + 디자인 실행 handoff를 산출하도록 프롬프트 확장(§4·§5·§12-B·§14·§15, v1.1). task-prompt는 03_UX_FLOW 존재 시 "디자인 실행(화면 시안)" 섹션 자동 추가 — Claude Code에서 레퍼런스 검색 + Claude 아티팩트 시안 생성. **경계 유지**: ux_ui는 픽셀을 직접 렌더링하지 않고 방향·지시만, 실제 시안은 Claude Code. MVP-lean 원칙 유지. acceptance 57/57.
