# CODEX_HANDOFF.md — Solo Founder AI Harness (V3 M0~M2 완료)

작성 기준: 아래 사실은 실제 코드·테스트·git 기록으로 검증했다. 검증 불가 항목은 `미확인`으로 표기한다.
고정 규칙은 루트 `AGENTS.md`를 함께 본다.

---

## 1. 프로젝트 개요

- **현재 버전**: `package.json` `2.6.0`. CLI `--version`은 package.json을 런타임에서 읽어 동일 값 출력(M0).
  (exec/mission·V3 M1/M2는 v2.6.0 태그 이후 develop에 누적된 미태그 작업.)
- **현재 브랜치 / 작업 트리**: `develop` / **CLEAN** (검증: `git status --porcelain` 빈 출력).
- **Provider 구조** (`src/providers/`): 3종 — `mock`(무과금 기본), `claude-code`(`claude -p` 구독 위임),
  `anthropic`(API). 인터페이스 `Provider = { id; generate(input): Promise<AgentResult> }`.
- **workflow / step 종류** (`registry/workflows.json`, 4개):
  - `idea-validation`: chief_of_staff → research → pm → red_team → founder_ceo (순수 순차)
  - `mvp-planning`: pm → ux_ui → design → {approval} → tech_lead → {critique_loop tech_lead⟲red_team} → founder_ceo
  - `dev-preflight`: tech_lead → {fanout} → red_team → chief_of_staff → {approval}
  - `full-predev`: chief_of_staff → research → pm → ux_ui → design → {approval} → tech_lead → red_team → founder_ceo → {gate}
  - step 5종: `agent`(string) / `critique_loop` / `gate` / `fanout` / `approval`.
- **exec/mission 실행 계층** (`src/exec/`, `src/commands/{exec,mission}.ts`): worktree에서 실제 claude 세션을
  돌려 게이트·승인 후 병합하는 계층. 승인·권한 게이트 안에서만 동작. **V3(M0~M2) 범위와 별개**이며 이번
  작업에서 수정하지 않았다.

---

## 2. 문서 우선순위

- **활성 설계 문서 (구현 기준, 충돌 시 우선)**:
  1. `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` (F1 학습 / F2 진행 가시성 / F3 handoff)
  2. `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md` (Capability/ToolProfile/MCP, M0~M7)
- **참고 자료**: `docs/backlog/V3_FIELD_NOTES.md` (실측 근거로만. 단독 구현 근거 금지).
- **폐기(역사 기록)**: `docs/archive/V3_KICKOFF_SUPERSEDED.md` — 구현 근거 아님.
- **충돌 시**: 위 활성 2문서 > 코드 현실. 문서와 코드가 어긋나면 **구현 전에 보고**.

---

## 3. 완료된 마일스톤

### M0 — 문서 동기화 + provider 하드코딩 수정 · 커밋 `582f6e0`

- **해결한 문제**:
  - `taskPrompt.ts` 하드코딩 `provider: mock` → `run_state.provider` 반영(미실행 폴백).
  - CLI `--version` `0.1.0` ↔ package.json `2.6.0` 불일치 → package.json 단일 원본에서 읽기.
  - `CLAUDE.md` v1 단정 문구 → 현행 범위(문서 자동화 + exec/mission, 승인·권한 게이트) 교정.
  - V3 문서 v2.4 전제 → v2.6 구조 동일 각주. `V3_KICKOFF_SUPERSEDED.md`를 `docs/archive/`로 이동.
- **변경 파일**: `src/core/taskPrompt.ts`, `src/cli.ts`, `CLAUDE.md`,
  `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`(각주), archive 이동, docs(WORKLOG/DECISIONS/CONTEXT_SUMMARY), dist.
- **테스트**: acceptance 63 + exec 74 통과. task-prompt provider 3케이스(mock/claude-code/미실행) 실측.

### M1 — 진행 이벤트 모델 + tool 이벤트 골격 + JSONL trace 골격 · 커밋 `5cbdbcb`

- **RunEvent** (`src/core/progress.ts`) — 9 타입:
  `run_start` / `step_start` / `step_end` / `gate_jump` / `run_end` + tool 골격 `tool_start` / `tool_end` /
  `tool_denied` + `note{level:"info"|"warn"}`. `StepKind = agent|critic|revise|spawn|gate|approval`.
  **tool_* 는 타입만 존재하고 어디서도 방출되지 않는다** (검증: 방출 grep 결과 없음, trace.test 픽스처 데이터뿐).
- **ProgressReporter**: `{ emit(e: RunEvent): void }`. `runWorkflow` 인자로 주입(미지정 시 no-op).
  기존 `start/note/stop` 인터페이스를 이벤트 모델로 **교체**.
- **실패 시 step_end/run_end**: `runStepWithRegen`는 try/finally로 예외에도 `step_end{ok:false}` 방출
  (HARNESS_FAIL_AT 훅을 step_start 이후로 이동). run 전체를 try/finally로 감싸 예외에도
  `run_end{status:"failed"}` 보장. 렌더러는 `run_end`에서 spinner interval 정리.
- **resume**: `run_start.resumeFrom` = 재개 위치. 완료 step은 재실행하지 않고 타이밍 보존.
- **step_timings** (`RunState.step_timings: StepTiming[]`): `{ agent_id; kind; started_at(ISO); elapsed_ms; ok }`.
  resume 시 기존 배열(`gate_jumps`와 동일 패턴)로 보존 — 완료 step 중복 기록 없음.
- **TTY/non-TTY 렌더러** (`src/commands/progress.ts`): 이벤트 소비형. TTY=스피너, non-TTY=`▶` 시작 라인.
  완료 `✓ [i/total]` 라인은 core `console.log`가 직접 출력(불변). **gate/approval은 스피너 미가동**
  (stdin 승인 프롬프트와 \r 충돌 방지).
- **범용 JSONL writer** (`src/tools/trace.ts`): `createJsonlWriter(path)` → `{ path; append(record); count(); close() }`.
  ToolTrace 스키마 미고정, **runWorkflow 미배선**(검증: runWorkflow에 trace import 없음).
- **테스트**: `src/core/progress.test.ts`(이벤트 순서·critique·gate jump·실패/resume·TTY/non-TTY),
  `src/tools/trace.test.ts`(JSONL 왕복). `test:core` 스크립트 추가.

### M2 — Capability/ToolProfile 정책 계층 (실행 배선 없음) · 커밋 `b359bfc`

- **Capability 3계층** (`src/tools/capabilities.ts`):
  - **active (7)**: web_search, page_extract, source_verify, repo_read, design_read,
    component_registry_read, framework_docs.
  - **reserved (13)**: site_crawl, runtime_diagnostics, browser_explore, browser_test, database_read,
    database_migration_draft, database_apply, preview_deploy, error_monitoring_read, billing_sandbox,
    workspace_export, **local_workspace_write, pull_request_create**.
  - **permanent deny (5)**: **remote_repository_write, pull_request_merge**, production_deploy, billing_live,
    design_write. (`repo_write_direct`는 제거됨 → `capabilityTier`가 `unknown` 반환.)
  - `capabilityTier(c)` → `active|reserved|deny|unknown`.
- **ToolBinding 4종**: `builtin{tools[]}` / `internal_adapter{adapter, operations[]}` /
  `mcp{server, tools[]}` / `cli{command, operations?}`. profile만 보고 실행 주체를 판별.
- **ToolProfile + 수동 validator** (`src/tools/profiles.ts`): 필드 = id, capabilities, `bindings`, servers,
  preapprovedTools, deniedTools, permissionMode(read_only|dev_write|approval_write), allowedDomains, limits,
  secretRefs, source?. **신규 런타임 의존성 0** — `validateStructure`(수동 구조) + `validateSemantics`(시맨틱).
  `schemas/tool_profile.schema.json`은 계약 문서용이며 **런타임 미실행**.
- **bindings에서 exposedTools 자동 파생**: `deriveExposedTools(bindings)` — builtin.tools 그대로 + mcp는
  `mcp__<server>__<tool>`. internal_adapter/cli는 모델 노출 도구가 아니라 제외. **exposedTools는 profile
  입력이 아니다** — compile이 계산한다.
- **preapprovedTools / deniedTools 의미**:
  - `preapprovedTools` = 노출 도구 중 승인 없이 자동 실행할 도구. compile → `--allowedTools`(allowTools).
  - `deniedTools` = 명시 차단. compile → `--disallowedTools`(denyTools).
  - validator 강제: `preapproved ⊆ exposed`, `exposed ∩ denied = ∅`.
- **compileToolProfile(profile, {bare?, mcpConfigPath?}) → CompiledToolPolicy**:
  `{ profileId; exposedTools; builtinTools; allowTools; denyTools; hookRules; mcpConfig; claudeArgs;
  adapterPolicy{allowedDomains, limits}; redactNames; bindings; permissionMode }`.
  - `builtinTools` → `--tools`(빈 배열이면 `--tools ""`).
  - permissionMode 매핑: read_only→`plan`, dev_write→`acceptEdits`, approval_write→`default` (→ `--permission-mode`).
  - `hookRules`는 인자 조건부 deny(PreToolUse Hook) 산출용 — 현재 항상 `[]`(M3에서 채움).
- **Binding 실행 방식 기반 fail-fast** (`assertPolicyExecutable(policy, ctx)`):
  - builtin → `ctx.provider.builtinTools`
  - mcp → `ctx.provider.localMcp || remoteMcp`
  - internal_adapter → `adapterAvailable(adapter, ctx.adapters)` (Adapter Registry, M2 빈 목록)
  - cli → `ctx.commandAvailable(command)`
  - 위치: `src/core/runWorkflow.ts:215~222` — `--tool-profile` 지정 시 **run_start(라인 429)·run_state 생성
    이전**에 load→compile→assert. 미충족이면 throw → run 시작 안 함(run_state 미생성). 미지정 시 완전 no-op.
- **secret validation/redaction** (`src/tools/redact.ts`): `isValidSecretRef`(`^[A-Z][A-Z0-9_]*$`),
  `assertValidSecretRefs`(값 형태 거부), `redactSecrets`(값 + Authorization/`key=`/`token=`/`secret=` 패턴 `***`).
- **`--tool-profile <id>` opt-in**: `src/cli.ts` → `runRun`(`src/commands/run.ts`) → `runWorkflow` 인자
  `toolProfileId`. 지정 시에만 fail-fast, 미지정 시 기존 동작 불변.
- **Planning `--bare` + 내장 도구 제한**: `--bare` → compile이 `--strict-mcp-config` + `--tools`(내장 제한) 산출.
  일반 문서 profile(planning-none)=`--tools ""`, 로컬 읽기(planning-local-readonly)=`--tools "Read,Glob,Grep"`
  + `--permission-mode plan`. provider는 `claudeCodeProvider.buildClaudeArgs(policyArgs, model)`로 base
  argv(`-p --output-format json [--model]`) 뒤에 정책 argv를 병합(미지정 시 기존 동작 보존).
- **strict empty profile fallback**: `compileToolProfile(profile, {mcpConfigPath})` → `--strict-mcp-config
  --mcp-config <path>` + `mcpConfig={mcpServers:{}}`. **argv 생성·검증까지만**(자동 강등 판정은 M3).
- **registry/schema 배포 상태**: `registry/tool_profiles.json`에 `planning-none`, `planning-local-readonly`만.
  `schemas/tool_profile.schema.json` 신규. `package.json.files`에 `schemas` 추가(registry는 이미 포함).
  Tavily/shadcn profile은 실행기가 붙는 M3·M4까지 미등록.
- **테스트/npm pack**: `tests/fixtures/tool-profiles/`(7개, 배포 제외) + `tests/fixtures/golden/`(회귀 스냅샷).
  단위: `src/tools/{capabilities,redact,profiles}.test.ts`, `src/providers/claudeCodeBare.test.ts`,
  `src/core/toolProfile.test.ts`(run fail-fast + golden snapshot 회귀 — 가변 메타 제거 후 비교).
  npm pack: 69 files, tests/·src/·*.test.* 미포함, `dist/tools/*`·`registry/tool_profiles.json`·
  `schemas/tool_profile.schema.json` 포함.

### 최신 전체 테스트 결과 (이번 세션 실측)

`npm test` → **exec 75 pass / core(=test:core: core+tools+providers) 94 pass / acceptance 63 PASS**, 실패 0. (M3a offline+보안 반영)

### ProviderCapabilities 값 (검증, `src/providers/capabilities.ts`)

| provider | toolUse | builtinTools | localMcp | remoteMcp | toolAllowlist | interactiveApproval | streaming | toolTrace |
|---|---|---|---|---|---|---|---|---|
| mock | F | F | F | F | F | F | F | F |
| claude-code | T | T | T | T | T | **F**(-p) | T | **F**(M3) |
| anthropic | F | F | F | F | F | F | F | F |

---

## 4. 현재 코드 상태 (구분)

- **구현·배선 모두 완료 (실동작)**:
  - M0 전부. M1 진행 이벤트(run/step/gate_jump/run_end/note) 방출 + TTY/non-TTY 렌더러 + step_timings 저장
    + resume. M2 profile 로드/검증, compileToolProfile, binding 기반 fail-fast(`--tool-profile` run 연결),
    secret 검증/redaction, `--bare`/strict-empty **argv 생성**.
  - **[M2.1] non-MCP profile의 policy argv가 실제 claude-code spawn까지 배선됨**: compile된
    `claudeArgs`(`--strict-mcp-config`/`--tools`/`--permission-mode`)가 `ProviderExecContext`로
    runWorkflow→runAgent→`claudeCodeProvider` spawn argv에 반영(mock/anthropic 무시, 미지정 회귀 없음).
    provider 오류(stderr/stdout/spawn error)는 `redactSecrets` 통과. JSONL writer optional 재귀 redaction.
  - **[M2.1] MCP binding profile은 run_start 이전 fail-closed**(per-tool 강제 없음 → M3 preflight/snapshot 필요).
    loader/compileToolProfile은 MCP를 거부하지 않음(M3가 로드 가능).
- **정책·타입만 구현 (소비처 없음)**:
  - RunEvent `tool_start/tool_end/tool_denied`(방출 없음). `src/tools/trace.ts` JSONL writer(runWorkflow 미배선).
    compileToolProfile의 `mcpConfig`·`hookRules`(생성만, 실제 claude 전달·Hook 실행 없음).
    `schemas/tool_profile.schema.json`(런타임 미실행). Adapter Registry(빈 목록).
    (`claudeArgs`는 M2.1에서 non-MCP에 한해 실제 전달로 승격 — 위 항목 참조.)
- **실제 외부 실행 아직 없음**:
  - 실 MCP 서버 기동, `mcpConfig` 파일 write·claude 전달, `system/init` snapshot 수집,
    shadcn/Tavily 호출, PreToolUse 등 Hook, canary 격리 실측 — 전부 미구현.
    (`--strict-mcp-config`/`--tools`가 argv에는 실리나 **격리 강제는 실측 미검증** — M3a.)
- **M3에서 연결해야 하는 것**:
  - compileToolProfile의 `mcpConfig` 파일 write·claude 전달(non-MCP argv 전달은 M2.1 완료), tool 이벤트 실 방출(stream-json 파싱)
    → JSONL trace 배선, handoff 세션, `--bare` snapshot 검증·자동 fallback.

---

## 5. 다음 마일스톤 M3 (분리 기록)

### M3a — Headless preflight — **offline+live 완료** (Claude Code 2.1.215 실측 PASS)
구현: `src/exec/{types,streamParser}.ts`(init.mcpServers 정규화), `src/providers/claudeCodeMcpAdapter.ts`(mcp-config 생성·검증), `src/tools/preflight.ts`(`runPreflight` — argv/env 강제, hard timeout, init 후 의도적 종료, snapshot 검증, fail-closed `PreflightError`). offline 테스트는 fake claude stub + NDJSON fixture. **live acceptance는 수동 runner `scripts/m3a-live-preflight.mjs`(+`fixtures/m3a/minimal-stdio-mcp.mjs`), `HARNESS_LIVE_M3A=1` 필수, npm test/CI 비대상.**
- `claude -p --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --mcp-config <gen> --tools "" --permission-mode plan`, env `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false`.
- `system/init`의 실제 mcp_servers·mcp__* 도구를 기대치와 정확 비교(전부 connected, canary/누락/중복 자동 실패).
- 성공 시 tools-snapshot.json(profileId/cwd/timestamp/configHash/servers/tools) 저장, 실패 시 성공 result 미반환.
- **live 실측(2026-07-19, Claude Code 2.1.215)**: expected server `connected`, `mcp__expected__read_thing` 정확 일치, ambient `.mcp.json` canary **미기동**(strict 격리 확인), sentinel/config/snapshot redaction 통과, fixture·임시 디렉터리 잔존 없음. **버전 종속 실측 — CLI 변경 시 재검증**("플래그=격리" 금지 유지).
- 실행: `npm run build && HARNESS_LIVE_M3A=1 node scripts/m3a-live-preflight.mjs`. preflight 통과 전 interactive handoff 시작 금지(M3b 배선 시).

### M3b — Interactive handoff trace
- Claude Code 대화형 TUI 유지(stdio inherit). **대화형 세션 자체를 stream-json으로 파싱하지 않는다.**
- Hook 이벤트 수집: PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest / SessionEnd.
- Hook 이벤트를 **M1 ToolTrace JSONL 형식으로 정규화**(`src/tools/trace.ts` writer 재사용, RunEvent
  tool_start/tool_end/tool_denied 매핑).

### M3c — 제한된 shadcn read 파일럿
- **검증한 고정 버전** 사용(`@latest` 금지).
- 표준 shadcn registry만 허용. `components.json`의 custom/private registry 검사.
- `browse`/`search`(read) 도구만 exposed. `install`/`add`/write 도구 미노출.
- 실제 snapshot(도구명)·결과 크기 검증. (`미확인`: shadcn 실제 MCP 도구명은 M3 착수 시 확인 필요.)

---

## 6. M3에서 하지 않을 것

- Tavily / Research Query Plan / Research Adapter (M4)
- production deploy / live billing / remote repository write / PR merge (hard deny)
- shadcn install 자동 승인
- Anthropic Provider MCP parity (M7)
- 범용 MCP client 직접 구현

---

## 7. 위험과 미해결 사항

- **M2 정책 ↔ 실제 Claude Code CLI 동작 차이 가능성**: compile이 산출하는 `--tools`/`--allowedTools`/
  `--disallowedTools`/`--permission-mode`/`--strict-mcp-config`/`--mcp-config` 플래그가 현재 claude 버전에서
  기대대로 동작하는지 **미확인**(이 저장소에서 실제 claude 미실행). M3a preflight로 실측 필요.
- **`--bare` 실제 snapshot 검증 미완료**: argv 생성·검증만 완료. 격리 효과는 미검증.
- **strict MCP config의 claude 버전별 동작**: 플래그 무시(#10787)·`disabledMcpServers` 미차단(#14490) 이슈가
  보고된 바 있음(설계 문서 §2.4). "플래그 존재=격리"로 신뢰 금지 — snapshot 실측으로만 판정. 현재 버전 동작 `미확인`.
- **Hook payload 민감 정보 redaction**: `redactSecrets`는 존재하나 Hook payload에 아직 미적용(M3b).
- **shadcn 실제 도구명**: `미확인` — M3c 착수 시 확인.
- **README 문서 불일치**: `README.md`에 v1/v2.6 범위 서술 잔재(예: "현재 진행 중인 개발 항목 없음",
  삭제된 `V3_KICKOFF.md` 참조). M0~M2에서 손대지 않음 — 후속 정리 항목.
- **package 배포 파일 후속 검증**: 현재 npm pack에 dist/tools·registry/tool_profiles.json·schemas 포함 확인.
  M3에서 mcp-config 생성물은 `outputs/runtime/`에 두고 gitignore·배포 제외 필요(현재 gitignore 미포함 — 후속).

---

## 8. Codex 첫 작업 (파일 수정 전)

1. M0~M2 완료 사실을 **코드·git으로 재검증**(커밋 582f6e0/5cbdbcb/b359bfc, `npm test` 통과).
2. M2 구현이 활성 설계 문서(위 §2)와 일치하는지 검토.
3. M3 범위를 **M3a/M3b/M3c로 분리**.
4. **실제 Claude Code 현재 버전과 CLI 지원 플래그 확인**(stream-json/system/init/strict-mcp-config/tools/
   permission-mode, Hook 이벤트명·payload).
5. 상세 M3 구현 계획과 acceptance만 제시.
6. **사용자 승인 전 코드·패키지·설정 수정 금지.**

---

## 부록 — 검증된 사실 요약

- 브랜치 `develop`, 작업 트리 CLEAN, package.json `2.6.0`.
- 커밋: M0 `582f6e0` / M1 `5cbdbcb` / M2 `b359bfc`.
- 명령: build=`npm run build`, 테스트=`npm test`(=`test:exec` 75 + `test:core` 94 + `acceptance` 63),
  `test:core`는 `HARNESS_WORKSPACE=.tmp-test-workspace tsx --test src/core/*.test.ts src/tools/*.test.ts
  src/providers/*.test.ts`.
- npm pack: 69 files. 포함=dist/·agents/·registry/·schemas/·README.md. 제외=tests/·src/·*.test.*.
