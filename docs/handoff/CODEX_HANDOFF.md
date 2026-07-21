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

`npm test` → **exec 75 pass / core(=test:core: core+tools+providers+commands) 176 pass / acceptance 71 PASS**, 실패 0. (M3c-0 shadcn discovery scaffold + P0/P1 하드닝 반영, 2026-07-21)

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

### M3a — Headless preflight — **offline+live 완료** (Claude Code 2.1.215 non-empty MCP strict 격리 live 통과)

> **live 검증 범위 구분**: M3a는 **non-empty MCP profile**(expected 서버 1개 + `mcp__expected__read_thing`)로 headless preflight의 strict 격리·canary 차단을 **실제 Claude 2.1.215에서 실측 통과**했다. **M3b.2의 empty MCP config + hook-settings + 대화형(TUI) Hook 경로도 2026-07-20 실제 Claude 2.1.215에서 live acceptance PASS**(아래 M3b.2 live acceptance 완료 참조).

구현: `src/exec/{types,streamParser}.ts`(init.mcpServers 정규화), `src/providers/claudeCodeMcpAdapter.ts`(mcp-config 생성·검증), `src/tools/preflight.ts`(`runPreflight` — argv/env 강제, hard timeout, init 후 의도적 종료, snapshot 검증, fail-closed `PreflightError`). offline 테스트는 fake claude stub + NDJSON fixture. **live acceptance는 수동 runner `scripts/m3a-live-preflight.mjs`(+`fixtures/m3a/minimal-stdio-mcp.mjs`), `HARNESS_LIVE_M3A=1` 필수, npm test/CI 비대상.**
- `claude -p --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --mcp-config <gen> --tools "" --permission-mode plan`, env `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false`.
- `system/init`의 실제 mcp_servers·mcp__* 도구를 기대치와 정확 비교(전부 connected, canary/누락/중복 자동 실패).
- 성공 시 tools-snapshot.json(profileId/cwd/timestamp/configHash/servers/tools) 저장, 실패 시 성공 result 미반환.
- **live 실측(2026-07-19, Claude Code 2.1.215)**: expected server `connected`, `mcp__expected__read_thing` 정확 일치, ambient `.mcp.json` canary **미기동**(strict 격리 확인), sentinel/config/snapshot redaction 통과, fixture·임시 디렉터리 잔존 없음. **버전 종속 실측 — CLI 변경 시 재검증**("플래그=격리" 금지 유지).
- 실행: `npm run build && HARNESS_LIVE_M3A=1 node scripts/m3a-live-preflight.mjs`. preflight 통과 전 interactive handoff 시작 금지(M3b 배선 시).

### M3b — Interactive handoff trace
- **M3b.1 완료(offline 기반)**: `src/tools/{toolTrace,hookCollector,hookSettings}.ts`(+test), `trace.ts` sanitizeValue(민감 key 재귀 마스킹). Hook payload(PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/PermissionDenied/SessionEnd)→공통 ToolTrace JSONL 정규화, 6 이벤트/필수 필드, exit code 게이팅(deny·audit실패 exit2/사후 exit1/stdout 미사용), env 계약 `HARNESS_TOOL_*`(secret 이름만), 원문 미저장(tool_response byte만)·크기 상한, MCP server=exact tool map 판정(추측 금지). `toRunEvent` 매핑 정의(실시간 emit 없음). **승인 의미 한계**: PermissionRequest=요청만·PermissionDenied=auto denial만. PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없음→callId=null·synthetic ID 미생성·`permissionOutcomeObservable:false`. Hook만으로 수동 승인/거부를 정확히 연결 불가. SessionEnd는 종료 사실만 기록(unresolved·승인 결과 추측 금지).
- **M3b.1 P0/P1 하드닝(완료)**: collector fail-closed(`parseConfig` 엄격·JSON fallback 금지, PreToolUse/PermissionRequest 실패 exit2·사후 exit1, stack/secret 미출력), payload 계약 검증(hook_event_name 일치·session_id 필수, PermissionRequest=tool_name+tool_input·tool_use_id 없음, tool hook=tool_use_id 필수, deny는 PreToolUse만), **SessionEnd는 종료 사실만 기록**(공식 payload에 correlation ID 부재로 unresolved·승인 결과 추측 금지), UTF-8 byte 상한(멀티바이트 경계 보존)·재귀 depth 상한, settings shell-safe quoting·`denyMatchers[]` dedupe.
- **M3b.2 완료(offline)**: handoff CLI·승인·headless preflight 게이트·격리 Hook settings·stub interactive spawn. `src/core/handoff.ts`(신규 `runHandoff` — outcome union, seam 주입)·`src/commands/handoff.ts`(신규)·`src/cli.ts`·`src/commands/run.ts`(`--handoff`/`--cwd`). 대화형 spawn argv `--strict-mcp-config --mcp-config <빈> --settings <hook-settings> --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --disallowedTools mcp__* -- <initialPrompt>` (가변 인자 `--disallowedTools`가 프롬프트를 deny 값으로 소비하지 않도록 `--`로 옵션 파싱 종료 후 initialPrompt를 positional로 전달; `--add-dir <contextRoot>`는 planning 문서(docs/*.md) 접근용 — P0-1 수정 반영). **`-p`/stream-json 없음, `stdio:"inherit"`.** env `HARNESS_TOOL_*`(이름만)+`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. **spawn 전 fail-closed preflight**(빈 MCP config, `emptyConfig`, ambient 서버/도구 하나라도 감지 시 차단; `--setting-sources ""`·auto-memory 격리 추가). Hook settings 공식 exec form(`command`=node, `args`=[collectorPath, hookKind]; deny는 args 마지막 "deny"). run_state.handoff는 **실제 spawn된 경우에만**(print/reject/preflight 실패/spawn 실패/non-TTY/missing binary 미기록, 종료코드·completed 불변). 산출물 `outputs/runtime/<id>/{mcp-config,hook-settings}.json`·`outputs/tool-trace/<id>.jsonl`(gitignore·dir700/file600, raw payload/transcript 미저장). **대화형은 `stdio:inherit`+Hooks만 — stream-json은 M3a preflight 전용.** 실제 Claude/TUI/live Hook 미실행(seam 주입).
- **M3b.2 P0/P1 보완(완료)**: (P0) collector는 `PACKAGE_ROOT/dist/tools/hookCollector.js` 절대경로만(import.meta.url 상대 제거), spawn/preflight 전 존재·일반 파일 검증→없으면 `setup_failed`. (P0) trace JSONL은 spawn 전 빈 0600 사전 생성(append 후 0600 유지), hook-settings/mcp-config/tools-snapshot 0600·dir 0700, 기존 파일·symlink는 `wx`로 fail-closed, 기본 handoff id는 randomUUID. (P1) redaction refs는 env 이름(TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH·값 존재)에서 **이름만** 파생→`HARNESS_TOOL_SECRET_REFS`+collector 값 마스킹, preflight `redactNames`는 scrub 전용(child env 미전달), spawn/setup/preflight 오류·outcome `redactSecrets`. (P1) initialPrompt에 "서비스 레포 AGENTS.md·CLAUDE.md 준수" 명시(`--setting-sources ""` 보완). `runHandoff`는 명시적 outcome union. 검증: exec 75 + core 154 + acceptance 71.
- **M3b.2 offline 최종 보완(2026-07-20)**: (1) 승인 preview 전체 redaction — `buildPreview`가 task prompt head만이 아니라 **cwd·trace 등 모든 동적 문자열을 포함한 최종 결과 전체**를 scrub(승인 화면 secret 평문 부재). (2) collector 검증 예외 정규화 — stat/readability 검증을 try/catch로 감싸 **부재·디렉터리·stat/access 오류를 예외 없이 scrub된 `setup_failed`로 반환**(preflight/spawn/handoff 기록 없음). production 경로 `PACKAGE_ROOT/dist/tools/hookCollector.js` 유지 + 테스트용 `collectorPath` seam, 일반 파일이며 읽기 가능할 때만 통과. (3) 테스트 정합성 — wx 충돌 테스트를 "trace 파일 exclusive-create 충돌"로 개명, collector 부재/디렉터리 setup_failed 테스트 추가, preview 전체 scrub 테스트 추가. 검증: exec 75 + core 157 + acceptance 71.
- **M3b.2 두 번째 live 부분 통과 + P0 2건(2026-07-20, 전체 PASS 아님)**: argv `--` 꼬리로 초기 프롬프트는 정상 전달됐으나 **① planning context 경로 단절(P0-1)** — task prompt Include는 `docs/*.md` 상대경로인데 대화형 cwd는 serviceCwd, 실제 planning 문서는 `projectPaths(project).root/docs` → Claude가 docs 못 찾고 serviceCwd에 잘못된 `docs/WORKLOG.md` 생성. **② sentinel TUI 평문 출력(P0-2)** — Bash 검증 `printf '%s' "$M3B2_LIVE_TOKEN"`이 fake sentinel 값을 TUI에 출력(실제 credential 아님). 수정: (P0-1) `contextRoot=projectPaths(project).root` + argv `--add-dir <contextRoot>` + initialPrompt 경로 계약 + preview에 serviceCwd·contextRoot 별도 표시 + 128KB fallback contextRoot 접근, `--disallowedTools mcp__* -- <initialPrompt>` 꼬리 유지. (P0-2) Bash 검증을 비출력 `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`로 변경. 회귀 테스트·runner 검증 추가(planning Read 성공·serviceCwd docs 미생성·`--add-dir`). (재검증 결과: 아래 live PASS 항목 참조.)
- **M3b.2 첫 live 시도 무효(argv P0, 2026-07-20)**: Claude Code 2.1.215 첫 실행에서 대화형 argv 꼬리가 `--disallowedTools mcp__* <initialPrompt>`였고, `--disallowedTools`(가변 인자)가 **initialPrompt를 deny 규칙으로 소비**해 프롬프트 전 단어가 `Permission deny rule "..." matches no known tool` 경고로 출력됨. **세션이 acceptance 절차를 받지 못해 무효 — Hook 검증 미수행, PASS 아님.** 수정: argv 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로(옵션 종료 구분자 `--`). 회귀 테스트(`handoff.test.ts` 성공 테스트 강화 + 전용 P0 테스트)·runner 사후 argv 검증 추가. offline 검증만 완료(실제 Claude/TUI 미재실행).
- **M3b.2 actual live acceptance 완료(PASS, 2026-07-20, Claude Code 2.1.215)**: 위 P0(argv/planning 경로/sentinel 출력) 수정 후 수동 runner(`scripts/m3b2-live-handoff.mjs`, `HARNESS_LIVE_M3B2=1`, TTY 필수)를 재실행해 **exit 0/PASS**. 실측 통과: exec-form Hook 6종 exact 계약·`--setting-sources ""` 수용, empty MCP snapshot(servers=[]/tools=[])·config({}), planning contextRoot 접근(`--add-dir`, 00_IDEA/06_CEO_DECISION Read 성공, serviceCwd docs 미생성), Read 성공/실패 callId correlation, Bash 승인(permission_requested callId=null + tool_requested/succeeded, 비출력 sentinel 검사), Write 수동 거부(requested+permission·marker 부재·denied 미합성), SessionEnd 1건, ambient MCP/Hook canary 미기동, trace redaction·권한(dir700/file600)·원문 미저장, run_state 불변, argv `-p`/stream-json 없음(`--` 꼬리). **버전 종속 실측(2.1.215) — CLI 변경 시 재검증.** **다음: M3c(shadcn read) 파일럿 계획 검토(구현 아님).**

### M3c — 제한된 shadcn read 파일럿
- **검증한 고정 버전** 사용(`@latest` 금지).
- 표준 shadcn registry만 허용. `components.json`의 custom/private registry 검사.
- `browse`/`search`(read) 도구만 exposed. `install`/`add`/write 도구 미노출.
- 실제 snapshot(도구명)·결과 크기 검증. (`미확인`: shadcn 실제 MCP 도구명은 M3 착수 시 확인 필요.)

- **M3c-0 discovery offline+live 완료(2026-07-21). 전체 M3c는 미완료(profile 등록·handoff 미연결).** 실제 Claude Code **2.1.216**에서 `shadcn@4.13.1` MCP discovery **1회 실행 → exit 0/OK, server `shadcn` connected**, strict 격리(ambient canary 미기동)·권한(dir700/file600)·redaction·cleanup·잔존 프로세스 검사 통과. **발견된 실제 도구 7개(원문, 이름으로 권한 분류·browse/search/install/add 추측 매핑 금지)**: `mcp__shadcn__get_add_command_for_items`, `mcp__shadcn__get_audit_checklist`, `mcp__shadcn__get_item_examples_from_registries`, `mcp__shadcn__get_project_registries`, `mcp__shadcn__list_items_in_registries`, `mcp__shadcn__search_items_in_registries`, `mcp__shadcn__view_items_in_registries`. **다음: M3c-1 `tools/list` schema·semantics 검증 계획**(inputSchema·read/write 성격 실측 → 권한 매핑·profile 등록·handoff 연결). 이번 단계 profile 등록·handoff 연결·MCP 도구 호출 없음.
- **M3c-0 discovery scaffold + offline hardening(2026-07-21).** P0/P1 하드닝: 표준 registry 검사를 `runShadcnDiscovery` 핵심 API가 config/spawn 이전에 강제(`registry_<code>`, 부작용 0), discovery package 우회 인자 제거(항상 `shadcn@4.13.1`), 빈 도구 `no_tools` 거부(1~64), 전 경로 typed 오류 code 보존+message scrub·성공 snapshot scrub(반환==저장)·`redactNames`(child 미전달), components.json `O_NOFOLLOW` fstat/read(TOCTOU), stdout 1MiB/stderr 64KiB 상한, 강제 env testEnv 우회 불가, snapshot persist wx 충돌 typed·부분성공 미반환, runner `claude --version`·config/권한/snapshot/canary/sentinel 검사. (이하 초기 scaffold 설명) `src/tools/shadcnPilot.ts`(+`.test.ts`)·`scripts/m3c-live-discovery.mjs` 신규. shadcn 파일럿 정책(`shadcn@4.13.1` pin, `npx --yes shadcn@4.13.1 mcp`, server=shadcn), 표준 registry 검사(`checkComponentsJson` — custom/private/malformed/symlink/oversized/non-regular fail-closed), **runPreflight와 분리된** `runShadcnDiscovery`(단일 shadcn strict config + headless `claude -p` system/init 도구명 수집, foreign/duplicate/empty/too-long/too-many/no-init/non-zero/timeout 거부, ≤64도구·≤256B·≤64KiB, raw init 미저장, 오류 redaction). 산출물 `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false, `ShadcnDiscoveryResult{discovery:true}`)로 `PreflightSuccess`와 타입 분리 → preflight/handoff 승인 근거 불가. **registry/tool_profiles.json 미등록·handoff 미연결·실제 Claude/npx 미실행.** live discovery는 수동 `HARNESS_LIVE_M3C_DISCOVERY=1` runner(npm test/CI 비대상). **shadcn 실제 도구명(browse/search/install/add 등)은 여전히 `미확인` — 사람이 runner 실행 후 확정 → profile 등록·handoff 연결이 후속.**

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
- **Hook payload 민감 정보 redaction**: **적용됨(M3b.1)** — collector가 민감 key 재귀 마스킹 + secretRefs 실제 값 + credential 패턴을 ToolTrace JSONL에 적용. (실 Claude Hook 배선·이름 대응은 M3b.2 실측 대상.)
- **shadcn 실제 도구명**: 2026-07-21 discovery로 확인(Claude Code 2.1.216 · shadcn@4.13.1) — 7개: `get_add_command_for_items`/`get_audit_checklist`/`get_item_examples_from_registries`/`get_project_registries`/`list_items_in_registries`/`search_items_in_registries`/`view_items_in_registries`(모두 `mcp__shadcn__` prefix). read/write 권한 성격은 `미확정` — M3c-1 `tools/list` schema·semantics 실측 필요(이름=권한 금지). 도구 셋은 버전 종속.
- **README 문서 불일치**: `README.md`에 v1/v2.6 범위 서술 잔재(예: "현재 진행 중인 개발 항목 없음",
  삭제된 `V3_KICKOFF.md` 참조). M0~M2에서 손대지 않음 — 후속 정리 항목.
- **package 배포 파일 후속 검증**: 현재 npm pack에 dist/tools·registry/tool_profiles.json·schemas 포함 확인.
  handoff/preflight 런타임 생성물은 `projects/*/outputs/runtime/`·`projects/*/outputs/tool-trace/`에 두며 **이미 `.gitignore`에 등재됨**(커밋·배포 제외 확인 완료 — 과거 "gitignore 미포함" 문구는 정정).

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
- 명령: build=`npm run build`, 테스트=`npm test`(=`test:exec` 75 + `test:core` 157 + `acceptance` 71),
  `test:core`는 `HARNESS_WORKSPACE=.tmp-test-workspace tsx --test src/core/*.test.ts src/tools/*.test.ts
  src/providers/*.test.ts src/commands/*.test.ts`.
- npm pack: 76 files. 포함=dist/·agents/·registry/·schemas/·README.md. 제외=tests/·src/·*.test.*.
