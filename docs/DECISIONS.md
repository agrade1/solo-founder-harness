# DECISIONS.md

## 2026-07-19 (V3 M3a — live acceptance)

- **live acceptance는 수동 전용, 명시 opt-in.** `scripts/m3a-live-preflight.mjs`는 `HARNESS_LIVE_M3A=1` 없이는 거부하고 npm test/CI에서 실행하지 않는다. 실제 Claude를 호출하므로 자동 파이프라인에 편입하지 않음.
- **격리 통과는 CLI 버전에 종속.** 2026-07-19 실측(Claude Code 2.1.215)에서 strict-mcp-config가 ambient canary를 차단함을 확인했으나, 이는 해당 버전의 실측이다. CLI 버전 변경 시 flag/`system/init`/격리 동작을 재검증한다("플래그 존재=격리" 금지 원칙 유지).
- **live runner/fixture를 저장소에 커밋한다.** 재현 가능한 수동 acceptance 자산으로 유지(이전의 "커밋 금지"는 검토 단계 한정이었음). 단 production MCP 구현이 아니라 canary acceptance 더블임을 헤더에 명시.

## 2026-07-19 (V3 M3a — live 전 보안 보완)

- **npx만 정확 고정 버전 강제.** 임의 dist-tag(`@latest`/`@next`)·범위(`@^`/`@~`/`@*`)·무버전을 npx에서 거부(재현성·공급망). node/local executable엔 미적용(오탐 방지).
- **preflight child env는 allowlist + 선언 secret만.** `process.env` 전체 전달은 미선언 토큰/키 유출 경로 — 폐지. 테스트용 env 주입은 production allowlist와 섞지 않는 명시적 `testEnv` seam으로 분리(프로덕션 경로 오염 방지).
- **반환 snapshot도 redacted, 저장본과 동일.** 호출자가 받는 객체와 파일이 달라 redaction이 우회되는 구멍 제거. 실패 시 성공 snapshot 미생성(fail-closed 일관).
- **중복 파생 도구는 조용히 dedupe하지 않고 거부.** 노출 표면 착오를 감추지 않기 위함. transport 혼합·credential 형태·secret 실값 포함도 기록 전 거부.

## 2026-07-19 (V3 M3a — Headless MCP preflight)

- **격리는 snapshot 실측으로만 판정.** `--strict-mcp-config`/`--mcp-config` 플래그 존재를 격리로 신뢰하지 않고, `system/init`의 실제 mcp_servers·tools를 기대치와 정확 비교(canary 자동 실패). 실패 시 typed error로 fail-closed — 성공 result를 절대 반환하지 않음.
- **preflight는 M2.1 fail-closed와 별도 경로.** runWorkflow의 MCP profile 거부는 유지하고, preflight는 M3에서 MCP를 여는 유일한 검증 관문으로 독립 배선. (해제는 preflight 통과가 전제.)
- **config는 참조된 서버만·secret 값 미기록.** binding이 참조하는 서버만 mcp-config에 포함, `@latest` 금지, secret은 이름만(값은 config·snapshot·error에 redaction). runtime 산출물은 gitignore.
- **init 수집 후 의도적 종료는 실패가 아니다.** headless preflight는 init만 필요하므로 수집 즉시 kill하고, 그 종료 코드를 성공/실패 판정에 쓰지 않음(오판 방지). timeout·비정상 종료(무 init)만 실패.
- **파서는 exec/streamParser 재사용.** 신규 파서를 만들지 않고 init 이벤트에 mcpServers 정규화만 추가(connected는 "connected"만).

## 2026-07-19 (V3 M2.1 — P0 보완)

- **secret 값은 provider context로 전달하지 않는다.** execContext에는 이름(redactNames)만 담고, 값은 claude-code provider가 내부에서 `collectSecretValues(process.env)`로 조회 → redaction 표면 축소.
- **MCP profile은 loader/compile이 아니라 run 경로에서 fail-closed.** per-tool 강제(M3 snapshot) 없이 실행하면 exposedTools가 거짓 강제가 되므로 run_start 이전 거부. 단 loader/compile은 성공시켜 M3가 동일 profile을 로드·검증할 수 있게 한다.
- **claude 실행 파일/타임아웃을 호출 시점에 읽는다.** 모듈 로드 시 고정 → 스텁 주입 불가였음. 동작 중립적 변경으로 실제 spawn argv 테스트 가능.
- **`toolProfilesPath` seam 추가.** registry에 MCP profile을 넣지 않고도 run-level 거부를 테스트하기 위한 최소 override(테스트/M3 겸용).

## 2026-07-17 (V3 M2 — Capability/ToolProfile 정책 계층)

- **`exposedTools`는 입력이 아니라 compile이 bindings에서 파생.** 노출 도구를 손으로 나열하지 않고 builtin/mcp binding에서 계산 → binding tools ⊆ exposed가 구조적으로 보장. preapproved/denied만 명시 입력.
- **`repo_write_direct` 폐기, 쓰기 권한을 세분화.** reserved(local_workspace_write, pull_request_create) vs deny(remote_repository_write, pull_request_merge, ...). "로컬 쓰기/PR 생성"과 "원격 쓰기/머지"의 위험도가 달라 계층을 분리.
- **fail-fast는 capability 이름이 아니라 compiled policy의 binding 실행 주체로 검증.** builtin→provider, mcp→provider MCP, internal_adapter→Adapter Registry, cli→실행 환경. `assertProviderSupports(ids)` 폐기 — 이름만 보면 "어떻게 실행되는가"를 놓친다.
- **JSON Schema는 런타임 미실행.** 신규 의존성(ajv 등) 추가 없이 수동 structural+semantic validator 사용. `schemas/*.json`은 계약 문서 + 향후 정식 validator용.
- **`--bare`는 argv 생성·검증까지만(M2).** planning 격리 = `--strict-mcp-config` + 내장도구 제한(`--tools`). snapshot 기반 회귀 판정·strict empty fallback 자동 강등은 실제 claude 실행이 필요하므로 M3.
- **회귀는 byte 동일 대신 golden snapshot.** 가변 메타데이터(project/타임스탬프/elapsed_ms) 제거 후 정규화 비교 + 시맨틱 assertion.
- **registry에는 실행 가능한 profile만.** planning-none/planning-local-readonly만 등록. Tavily/shadcn 등은 실행기(어댑터/MCP 배선)가 붙는 M3·M4까지 미등록 — 등록 즉시 fail-fast로 걸릴 profile을 배포하지 않음.

## 2026-07-17 (V3 M1 — 진행 이벤트 모델)

- **기존 `ProgressReporter`(start/note/stop)를 이벤트 모델(emit(RunEvent))로 교체.** 병존 대신 교체 — 두 진행 시스템은 부채. 렌더러가 이벤트 소비자가 되고 CLI 출력 계약은 보존.
- **run_end는 try/finally로 항상 방출.** "정상 완료 직전에만" 방출하는 구조 금지 — provider/step 예외에도 step_end{ok:false}+run_end{failed}+렌더러 정리가 보장돼야 함.
- **note 이벤트에 level(info|warn) 포함.** 기존 재생성 경고 라인을 손실 없이 보존.
- **gate/approval은 스피너 미가동.** approval은 stdin(승인 프롬프트)을 기다려 \r 스피너와 충돌 — 이벤트는 방출하되 렌더러가 안 그림 (F2.2).
- **`src/tools/trace.ts`는 M1에서 범용 JSONL writer로만.** ToolTrace 공통 스키마 고정·runWorkflow 배선은 M3(실제 tool 이벤트 방출 시점)로. 골격을 특정 스키마에 조기 결박하지 않음.
- **step_timings resume 복원은 기존 배열(gate_jumps 등)과 동일하게 완료분 보존.** 완료 step 재실행/중복 기록 없음.

## 2026-07-17 (V3 M0 — 문서 동기화)

- **CLI 버전은 package.json 단일 원본.** `cli.ts`가 런타임에 `../package.json`을 읽어 버전 드리프트를 구조적으로 제거. 하드코딩·별도 일치 테스트 불필요.
- **V3 활성 구현 기준은 두 문서로 한정.** `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` + `V3_MCP_CAPABILITY_TOOL_PROFILES.md`. `V3_KICKOFF_SUPERSEDED.md`는 archive로 이동(과거 계획, 구현 근거 아님). backlog 문서는 사용자가 V3 작업을 명시 요청할 때만 활성 2문서를 읽는다.
- **M0 범위 엄수.** M1+ Capability/Profile/MCP/handoff/report 코드는 이번 세션에서 구현하지 않음. exec/mission ↔ V3 문서 괴리는 후속 항목으로만 기록(관계없는 리팩터링 금지).

## 2026-07-08 (실행 계층 방향)

- **실행 계층(문서→자동 실행→병행/다중 라이브 세션)은 v3+ 로 분리, 설계 먼저.** 창업자 비전은 ROADMAP v3 "실행 연결 실험"보다 넓음(병행/다중 세션 오케스트레이션). 바로 구현하지 않고 별도 Fable 모드 세션에서 아키텍처 설계 → `docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`가 그 핸드오프. 설계 확정본은 `EXECUTION_LAYER_ARCH.md`(예정) + ROADMAP v3/v4 갱신.
- **진행 표시(ProgressReporter)는 UX 개선으로 즉시 반영.** 실행 계층 설계와 독립적이고, 다중 세션 상태판의 첫 조각도 됨. core/CLI 분리 원칙 유지(core는 TTY 무지).

## 2026-07-06

- agent prompt 파일명에서 버전 접미사 제거 (버전은 파일 내부 헤더로 관리)
- harness init 생성 docs = 6개 (00_IDEA, TASKS, DECISIONS, CONTEXT_SUMMARY, WORKLOG, API_CONTRACT), HANDOFF.md v1 제외
- 01~06 번호 문서는 workflow 실행 시 생성
- 구버전 가이드(solo_founder_harness_dev_guide)와 COMBINED_CORE_PROMPTS.md는 레포에서 제외
- v1 완료 기준 = acceptance test 1~5 전부 통과

## 2026-07-06 (2차)

- run_state.json v1 필수 필드 확정 (workflow_id, project, completed_steps, failed_agent, warnings, started_at, finished_at). resume은 v2
- 결과 저장 시 필수 섹션 헤더 검증(경고 수준) v1 포함
- v2/v3 로드맵은 docs/reference/ROADMAP.md — v1 개발 중 로드 금지
- v2 최우선 결정 = provider 전략 (API 직접 vs Claude Code subagent) → backlog/PROVIDER_STRATEGY_TODO.md
- 개발은 Opus 모델로 진행, 운영 규칙은 prompts/opus_optimization_guide.md
- IMPLEMENTATION_PLAYBOOK.md 추가: 세션 5개 기준 단계별 진행 순서 (사람용, Claude 기본 로드 제외)

## 2026-07-06 (v2 provider 결정)

- **provider 전략 = C안 확정**: 인터페이스에 mock/claude-code(B안,구독)/anthropic(A안,API) 3종, 플래그 교체. 지금은 claude-code로 운영, A안은 사용자가 종량과금 원할 때 추가.
- 이유: Claude.ai/ChatGPT 구독은 API 접근 미포함(별개 청구). 사용자는 기존 구독으로 추가비용 0 원함 → B안 우선.
- Provider.generate() 동기→비동기 + token usage 필드 신설(A안 예산상한 대비). mock은 계속 유지(acceptance 기반).
- 상세 설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md

## 2026-07-06 (v2 루프 아키텍처)

- workflow `steps`를 선형 `string[]`에서 `(string | {critique_loop})[]` union으로 확장 (V2_KICKOFF "steps→loop 확장"). CEO 게이트도 이 union에 `{gate}` 추가로 얹을 예정.
- Red Team 비평 루프는 **기존 mvp-planning에 내장**(새 워크플로우 추가 X) — acceptance Test 2의 "Workflows (4)" 개수 유지 위해. idea-validation 등 나머지는 선형 유지.
- 비평 루프 종료 조건 = critic 출력의 "### Critical" 리스크 소멸 OR max_rounds 소진. 무한루프 방지로 max_rounds 필수.
- priorFindings를 Map(upsert)로 변경 — 루프에서 agent 재실행 시 handoff 요약 중복/누적 방지, 순서 유지.
- 재생성 로직(v2-3)을 runStepWithRegen 헬퍼로 추출해 선형/루프 양쪽에서 재사용.
- CEO 게이트를 union에 `{gate}`로 추가(V2_KICKOFF 4번). full-predev에 내장(축소→pm, 검증→research), max_jumps로 무한루프 방지.
- 판정 추출(extractDecision)은 Main Judgment + Decisions 섹션만 검색 — 문서 전체 검색은 Input Summary의 역할설명("진행/축소/검증...")을 오탐하므로 금지.
- anthropic provider(A안): 프롬프트 빌더를 promptParts.ts로 claude-code와 공유(중복/drift 방지). 기본 모델 opus-4-8, 기본 provider는 mock 유지. 실제 유료 호출은 사용자 키 세팅 후 검증.

## 2026-07-07 (라이브러리화 방향)

- 하네스 배포 모델 = **설치형 라이브러리**로 전환 (사용자 의도: 하네스 하나에 서비스 쌓지 말고 서비스 레포마다 설치). 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(CWD, 데이터)로 분리.
- projects/<name> 구조와 --project 플래그는 **유지**(최소 변경, acceptance 보존). "레포=단일 프로젝트"로 --project 없애는 건 별도 결정으로 보류.
- npm publish는 하지 않음 — install-ready(git/로컬 설치)까지. 실제 배포는 사용자 결정.
- 사용자 원래 기획 = 에이전트 분리(FE/BE 전문화). 3층으로 분해: ①정적 전문화 에이전트 추가 ②동적 분리 게이트 ③Claude Code 병렬 실행 연동(v3). 실제 병렬 코딩은 하네스가 아니라 Claude Code 영역(하네스는 기획문서+task-prompt 생성기). 상세: [[v2-provider-decision]] 다음 방향.

## 2026-07-07 (동적 분화 B-② 구현)

- 동적 분화 = `{fanout}` step. planner가 SPAWN 형식으로 하위 에이전트 선언 → fanout이 파싱해 런타임 생성·실행.
- **하위 에이전트는 레포에 영구 등록하지 않음** — 런타임 AgentDef + 생성 브리프(agentPromptText)로 per-run 생성. private/read-only 패키지와 충돌 회피, "동적"의 본질에 부합.
- **사람 승인 게이트 유지**(ROADMAP 원칙): 기본은 계획만 기록(executed:false), `--allow-spawn` 있을 때만 실제 실행. 자동 무단 생성 안 함.
- ①정적 전문 에이전트 추가는 보류 — 동적 분화로 갈음. 실제 병렬 코딩(B-③)은 여전히 Claude Code 영역(v3).

## 2026-07-07 (B-③ 멀티에이전트 task-prompt)

- B-③ = task-prompt를 멀티에이전트 실행 스펙으로 확장. spawned_agents 있으면 FE/BE별 병렬 subagent 지시문 생성.
- **경계 결정**: 하네스는 실행 "스펙 생성"까지만. 실제 병렬 코딩은 Claude Code subagent가 **사람 승인 후** 수행. 하네스가 직접 코드 실행/세션 자동 spawn 안 함 (v1부터의 "코드 자동 실행 금지" + ROADMAP "사람 승인 게이트" 유지). Claude Code는 병렬 subagent 능력 이미 있음 → 하네스는 구조화된 handoff만 제공.
- 하네스→Claude Code 실행 자동 트리거는 신중히(보류). 승인 게이트 없이는 안 함.

## 2026-07-07 (Obsidian 연동)

- Obsidian 연동 = **run_state 기반 read-only export**. 원본 projects/ 파일은 건드리지 않고 vault에 사본(frontmatter+wikilink 부여) 생성 → 안전(비파괴), 재실행 시 vault만 갱신.
- **opt-in**: `--vault` 또는 `HARNESS_VAULT` 있을 때만 동작. 기본 파이프라인/acceptance 무영향. export 실패는 경고로만 처리(실행 결과 저장 우선).
- 노트 구조 = agent별 노트 + run 인덱스(MOC). wikilink는 실행 순서(completed_steps) 기반 이전/다음/인덱스 + MOC의 순서 링크. frontmatter tags(harness/workflow/project/moc)로 그래프뷰 군집화. → V2_KICKOFF "양방향 링크·그래프뷰" 충족.
- vault를 실행 트리거로 삼지 않음 — 어디까지나 결과 아카이빙/지식그래프 용도.

## 2026-07-07 (v2 범위 정합성 정리)

- **배경**: "v2 스펙"이 두 벌이었다 — ①ROADMAP.md의 v2 목록(v1 때 적어둔 희망 목록) vs ②V2_KICKOFF.md(실제 착수 계획: provider 전략 + 루프 3종 + Obsidian). **실제 개발은 V2_KICKOFF를 따랐다.** 스코프 락 원칙("backlog → 다음 버전 스펙 → 구현 순서로만 이동")상 V2_KICKOFF로 승격되지 않은 ROADMAP 항목은 미구현으로 남았다. 버그/누락이 아니라 승격 게이트 미통과.
- **결정**: 아래 ROADMAP v2 항목들을 지금 구현하지 않고 **명시적으로 보류**한다(문서에 상태 표기, ROADMAP "v2 포함" 범례 ✅/⚠️/⏸).
  - `token budget 상한/중단` — 예산 상한이 실제로 필요한 종량 API(anthropic) 경로가 아직 미사용/미검증. mock=무료, claude-code=구독(회당 과금 없음) → 필요 미발생. **anthropic 실사용 시작 시 재검토.**
  - `run --resume` — mock 즉시, claude-code ~10분 수준. 중간 실패 재개 실익이 아직 작음.
  - `step 사이 승인 게이트` — 코드가 실제로 산출물을 생성하는 유일 지점(분화)은 `--allow-spawn`으로 이미 승인 게이트 존재. 일반 step은 결과를 사람이 사후 검토 → 매 스텝 승인은 마찰만 큼.
  - `schema validation 강화(내용 길이/형식)` — 주 실패모드(섹션 누락)는 재생성 루프가 처리. 내용 품질 검증은 기준이 애매하고 ROI 낮음.
  - `prompt CHANGELOG` — 파일 내부 버전 헤더는 v1부터 존재. 별도 CHANGELOG는 필요 미발생.
- **사실상 달성(다르게 구현)**: Red Team 편향 분리 — handoff(priorFindings)가 각 agent의 결론(Main Judgment 한 줄, extractMainJudgment)만 전달하고 전체 추론 문서는 안 넘김. red_team 포함 모든 하류 agent가 결론만 봄. red_team 전용 로직은 아니지만 편향 분리 목적은 충족.
- **provider는 초과 달성**: ROADMAP은 "실제 provider 1개"였으나 3종(mock/claude-code/anthropic) 구현.
- 이 정리는 코드 변경 없음(문서 정합성만). 보류 항목은 실전 필요 발생 시 v2.5/v3 스펙으로 승격해 구현.

## 2026-07-07 (v3 킥오프 — 보류했던 안전장치를 v2.5 Phase 0로 재승격)

- **결정 반전**: 바로 위 "v2 범위 정합성 정리"에서 보류(⏸)했던 `run --resume` / `token budget` / `approval gate`를, V3_KICKOFF.md(Fable 5)가 v3 반자동 실행(`harness execute`)의 **선결 안전장치**로 재평가 → v2.5 Phase 0(0-1~0-3)으로 재승격해 구현했다.
- **사유**: v3-1(task prompt → Claude Code 반자동 실행)은 파일을 실제로 바꾸는 executor다. 그 전에 (a)실패 재개(resume), (b)토큰 상한(budget), (c)실행 직전 사람 승인(approval)이 없으면 안전하지 않다. v2 때는 "종량 API 미사용 + 매 스텝 승인 마찰"이라 보류가 타당했지만, **v3 실행 연결을 목표로 잡는 순간 이 셋은 선결 조건이 된다.** 보류 사유가 사라진 것 — 스코프 확장이 아니라 목표 변경에 따른 재평가.
- **Red Team 편향 분리(0-4) 강화**: v2에서 "사실상 달성(결론만 handoff)"으로 봤으나, critic이 **전체 findings 체인**을 보면 앞선 에이전트 합의에 anchoring된다. → critic 호출 시 target 결론만으로 격리(`contextMode=conclusion_only`, priorFindings 제한)해 명시적으로 강화. 일반 step은 full 유지.
- **스코프 락 유지**: V3_KICKOFF에 없는 기능은 추가하지 않았다(HARNESS_FAIL_AT/HARNESS_MOCK_TOKENS는 문서가 명시한 "강제 실패 stub" 검증 방식). 0-5 이후 Phase 1(도그푸딩)로 넘어가며, **실제 아이디어 2개 검증 전까지 v3 신규 기능(execute/report/security baseline) 미착수.**
- 검증: mock acceptance 57/57. anthropic 유료 실검증과 v2.5.0 태그는 사용자 액션으로 남김.

## 2026-07-08 (Phase 1 도그푸딩 결론 — v3.0 코딩 진입 보류)

- **v2.5.0 릴리스 완료** (develop→main, 태그+push).
- **Phase 1 도그푸딩 결과**: 하네스 핵심 파이프라인(게이트 두 분기·critique_loop·편향분리·분화+allow-spawn·승인게이트·토큰계측)이 실제 LLM에서 설계대로 작동함을 확인. 스키마 경고 0. 남은 이슈는 기능 결함이 아니라 **관측성**(진행률·되돌림 가시성·판정근거 기록).
- **결정: Phase 2(v3.0 코딩) 진입을 보류한다.** 근거 = 하네스 self-review(mvp-planning)의 red_team Critical: "v3 착수 조건은 '아이디어 2개 검증 + **개발 착수 1건**'인데 개발 착수 0건. 조건 미충족 상태로 v3 기능을 구현하면 하네스가 자기 진입 게이트를 어기는 첫 사례가 된다."
  - founder_ceo도 동일 판정: v3 첫 작업은 코드가 아니라 "실제 아이디어 1개를 기존 task-prompt로 개발 착수까지 손으로 완주"해 게이트를 채우는 것.
  - execute: 안전경계 시나리오("승인 게이트 이후 실패 시 롤백 주체")가 서지 않으면 만들지 않음. 현재 plan-only도 보류.
  - report: 관측성 통증이 실사용에서 수치로 확인된 뒤 최소형(스냅샷 표, 신규 의존성 0)으로만.
- **의미**: 도그푸딩이 "다음 코딩을 미루라"는 결론을 냈다는 것 자체가 하네스가 제 역할(순서 틀린 착수 차단)을 한 증거. 다음 코딩은 하네스가 아니라 실제 서비스 아이디어에서 나와야 함. 하네스는 v2.5.0으로 "충분히 좋다".

## 2026-07-08 (public 설치 + ux_ui 디자인 레퍼런스 확장)

- **dist 커밋으로 전환**: github 설치가 빌드 없이 동작하도록 `dist/`를 레포에 커밋(.gitignore 제거). 최신 npm이 install 스크립트(prepare)를 기본 차단하므로 prepare 빌드에 의존하지 않고 산출물을 직접 커밋하는 게 더 견고. build에 `chmod +x dist/cli.js` 추가(tsc가 644로 만들어 bin permission denied 발생하던 버그 해소). 소스 수정 시 `npm run build` 후 dist 커밋 필수.
- **ux_ui 역할 경계 = "디자인 방향 지시자", 픽셀 렌더러 아님**: headless `claude -p`는 웹검색·렌더링 불가하므로, ux_ui는 레퍼런스 소스·검색 키워드·비주얼 방향만 산출하고 실제 레퍼런스 수집(WebSearch)·화면 시안(Claude 아티팩트)은 다음 단계 Claude Code에서 수행. 기존 "아트 디렉터 아니다/최소 화면" 철학과 충돌 없이 확장(MVP-lean: 레퍼런스는 명확성·속도용, 과설계 금지).
- **task-prompt 디자인 실행 섹션**: 03_UX_FLOW.md 존재 시에만 조건부 추가 → idea-validation 등 UX 없는 워크플로우/acceptance 무영향.
