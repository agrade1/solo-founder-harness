# CONTEXT_SUMMARY.md

최종 갱신: 2026-07-19

## 최신 (2026-07-19 세션 — V3 M3a offline+live 완료)

- **M3a offline+live 완료**: 수동 live runner(`scripts/m3a-live-preflight.mjs`, `HARNESS_LIVE_M3A=1`)로 실제 Claude Code **2.1.215** 실측 PASS — expected server connected, `mcp__expected__read_thing` 정확 일치, ambient canary 미기동(strict 격리), sentinel/config/snapshot redaction 통과, fixture·임시 디렉터리 잔존 없음. **버전 종속 실측(CLI 변경 시 재검증)**. offline(파서/config/preflight/보안 보완)은 커밋 `cbb8749`.
- **다음**: **M3b 계획 검토**(handoff trace: Hook→ToolTrace JSONL). M3c shadcn은 그 뒤.

## 이전 (2026-07-19 세션 — V3 M3a live 전 보안 보완)

- **M3a 보안 보완**: npx 정확 고정버전 강제(unpinned/latest 거부, node 예외), config 강화(중복도구·transport 혼합·credential·secret 실값 거부), preflight env 격리(allowlist+선언 secret만, testEnv seam), snapshot redaction 정합(반환=저장, 실패 시 미생성), init fixture 9곳 `mcpServers:[]`. 실제 claude 미실행. 검증: exec 75 + core 94 + acceptance 63.
- **다음**: M3a live(실제 구독 호출 실측) → M3b handoff trace → M3c shadcn read.

## 이전 (2026-07-19 세션 — V3 M3a Headless MCP preflight, offline)

- **M3a 완료(offline)**: system/init 파서 확장(`McpServerStatus`, connected는 "connected"만), MCP config 생성(`claudeCodeMcpAdapter.ts` — 서버 검증·@latest 거부·alwaysLoad·SHA-256·runtime gitignore), headless preflight(`preflight.ts` — argv/env 강제·hard timeout·init 후 의도적 종료), snapshot 검증(정확 비교·canary 자동 실패·fail-closed `PreflightError`·redaction). 실제 claude 미실행(stub acceptance). M2.1 MCP fail-closed 유지. 검증: exec 75 + core 74 + acceptance 63.
- **다음**: M3a live(실제 구독 호출로 argv·system/init·strict 격리·canary 실측) → M3b handoff trace(Hook→ToolTrace JSONL) → M3c shadcn read.

## 이전 (2026-07-19 세션 — V3 M2.1 P0 보완)

- **M2.1 완료(M3 이전 선행 보완)**: ① 정책 실제 전달 — `ProviderExecContext{claudeArgs,redactNames}`로 compile된 policy를 runWorkflow→runAgent→claudeCodeProvider spawn argv까지 배선(mock/anthropic 무시, 미지정 회귀 없음). ② MCP fail-closed — `hasMcpBinding` profile은 run_start 이전 거부(loader/compile은 성공, M3용). ③ secret redaction — invalid secretRef 오류 index만, provider 오류 stderr/stdout `redactSecrets` 통과, 값은 context로 미전달(이름만). ④ JSONL writer optional 재귀 redaction(원본 불변). 검증: exec 74 + core 52 + acceptance 63.
- **다음 M3**: M3a preflight(stream-json/system·init snapshot/canary 격리) → M3b handoff trace(Hook→ToolTrace JSONL) → M3c shadcn read. MCP config 생성·전달·snapshot 강제가 여기서 배선(그 후 MCP profile fail-closed 해제 가능).

## 이전 (2026-07-17 세션 — V3 M0 + M1 + M2)

- **V3 M2 완료(Capability/ToolProfile 정책 계층)**: `src/tools/{capabilities,profiles,adapters,redact}.ts` + `src/providers/capabilities.ts`. 3계층 capability(repo_write_direct 분리), ToolBinding 4종(builtin 포함), ToolProfile(bindings 필드, exposedTools compile 파생), 수동 validator(의존성 0), compileToolProfile(4버킷), binding 기반 fail-fast(run 시작 전), redaction, `--bare` argv. registry=`planning-none`/`planning-local-readonly`만. `--tool-profile`·`--bare` CLI 플래그. golden snapshot 회귀. M1 무영향. 검증: exec 74 + core 37 + acceptance 63.
- **다음 M3**: handoff + shadcn read + stream-json 파싱(tool 이벤트 실 방출·trace 배선) + mcp-config write·claude 전달 + `system/init` snapshot 격리 실측.

## 이전 (2026-07-17 세션 — V3 M0 + M1)

- **V3 M1 완료(진행 이벤트 모델)**: `src/core/progress.ts`(RunEvent/ProgressReporter) — run_start/step_start/step_end/gate_jump/run_end + tool_*(타입 골격) + note{level}. runWorkflow가 모든 top-level step에 이벤트 방출(index 1-based, kind/round, 실제 jump만 gate_jump), try/finally로 예외에도 run_end{failed} 보장. RunState.step_timings 저장. 렌더러(`commands/progress.ts`) 이벤트 소비형 재작성(출력 계약 보존, gate/approval 스피너 없음). `src/tools/trace.ts` 범용 JSONL writer 골격(runWorkflow 미배선). 테스트: core 8 신규(`test:core`). 검증: exec 74 + core 8 + acceptance 63.
- **V3 M0 완료(문서 동기화)**: taskPrompt provider 수정, CLI 버전 package.json 단일 원본, CLAUDE.md 교정, SUPERSEDED→archive, HANDOFF v2.6 각주.
- **다음**: M2(Capability/Profile 기반) — 별도 승인 대기. M3에서 handoff+shadcn read+stream-json 파싱(여기서 tool 이벤트 실 방출·trace 배선). 활성 기준: `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`, `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`.
- **후속 정리 항목**: README v1/v2.6 범위 서술 갱신, V3 문서의 exec/mission 실행 계층 미참조, package.json.files(M2에서 registry/schemas 추가).

## 최신 (2026-07-08 세션)

- **진행 표시자 추가**: run 중 TTY 스피너(`⠹ [2/5] research 실행 중… 0:42`)+경과시간, 비TTY는 `▶` 폴백. `src/commands/progress.ts` + `runWorkflow.ts`의 `ProgressReporter` 인터페이스. core는 TTY 무지 유지. 57/57.
- **실행 계층 설계 핸드오프**: 창업자 비전(문서→자동 실행→병행/다중 라이브 세션→라이브 분화, 큰 이슈만 예/아니요) vs 현재(문서 생성만) 갭·다음 스텝 정리 → `docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`. **설계는 별도 Fable 세션 예정.** (결정: docs/DECISIONS.md 2026-07-08)

## 현재 상태

- **하네스 v1 구현 완료.** acceptance Test 1~5 전부 통과 (`npm test` → 30 checks all pass).
- 5개 명령 동작: list / init / run / summary / task-prompt (mock provider 기반, 실제 LLM 미호출).
- 코드 구조:
  - `src/cli.ts` — commander 진입점
  - `src/core/` — paths, registry, project, runAgent, runWorkflow, validate, saveArtifact, summary, taskPrompt
  - `src/providers/` — provider 인터페이스 + mockProvider
  - `src/commands/` — 각 CLI 명령 래퍼
- `scripts/acceptance.sh` = 통합 검증 스위트 (`npm test`/`npm run acceptance`).
- git: origin = github.com/agrade1/solo-founder-harness, main 브랜치에 단계별 커밋/푸시.
- 비공개: `projects/idea-discovery/IDEA_*.md`는 .gitignore로 원격 제외.

## v2 진행 상황 (2026-07-06 착수)

- **provider 전략 C안 확정** (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md): mock/claude-code(B안,구독)/anthropic(A안,API) 3종 교체. 지금은 claude-code, A안은 나중.
- **[v2-1 완료] Provider 인터페이스 async화 + token usage 필드.** `generate()` → `Promise<AgentResult>`, run_state에 provider+usage 기록, `run --provider` 플래그.
- **[v2-2 완료] claude-code provider(B안).** `claude -p --output-format json` stdin 위임, usage 파싱. AgentRunInput에 ideaContent(00_IDEA.md) 추가. extractMainJudgment 문단형 대응 버그수정. dev-preflight end-to-end 검증 완료. mock acceptance 30/30 유지.
- 사용: `harness run <wf> --project <p> --provider claude-code` (claude CLI가 Max 구독 로그인 상태여야 함). 기본은 mock.
- **[v2-3 완료] 스키마 검증 재생성 루프.** 필수 헤더 누락 시 피드백해 재생성(`--max-regen <n>`, 기본 1). run_state.regenerations 기록.
- **[v2-4 완료] Red Team 비평 루프.** workflow steps를 `(string|{critique_loop})[]`로 확장. critic(red_team)이 Critical 리스크 발견 시 target(tech_lead)에 되먹여 revise→재검토, Critical 소멸/max_rounds까지. mvp-planning에 내장(`↻[red_team⟲tech_lead×2]`). run_state.critique_rounds 기록. mock+stub 검증, acceptance 30/30 유지.
- **[v2-6 완료] CEO 게이트 분기.** WorkflowStep에 `{gate}` 확장. decider(founder_ceo) 판정이 on 키와 맞으면 해당 agent로 되돌려 재실행(max_jumps로 무한루프 방지). full-predev에 내장(`⤴[founder_ceo?축소→pm,검증→research×1]`). run_state.gate_jumps 기록. mock+stub 검증.
- **[v2-5 완료] anthropic provider(A안).** @anthropic-ai/sdk 연동, 프롬프트 빌더를 promptParts.ts로 공유. ANTHROPIC_API_KEY 필요(종량과금). 키 없으면 안전 실패+claude-code 안내. 기본 provider는 mock 유지. **실제 유료 호출 미검증**.
- provider 3종(mock/claude-code/anthropic) + 루프 3종(재생성/비평/게이트) 완비.

- **[실전 검증 완료]** mvp-planning을 claude-code로 실제 실행 → 비평 루프 실작동 확인(red_team이 Critical 2건 발견→tech_lead 반영 수정→재검토→max_rounds 종료). 루프가 출력 개선함.
- **v2 완료 → v2.0.0 태그** (develop→main 병합).
- **[v2.1-A 완료] 라이브러리화.** 경로 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, projects). 서비스 레포마다 설치. v2.1.0 태그·푸시 완료.
- **[B-② 완료] 동적 분화(fanout).** planner(tech_lead)가 `SPAWN id=..|name=..|focus=..` 선언 → fanout이 파싱 → **기본 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 전문 에이전트 런타임 생성·실행(outputs/spawned/<id>.md). dev-preflight 내장. run_state.spawned_agents. v2.2.0 태그.
- **[B-③ 완료] 멀티에이전트 task-prompt.** spawned_agents 있으면 task-prompt에 "병렬 실행" 섹션(FE/BE별 담당·계획문서·통합·승인게이트) 생성. **하네스는 스펙 생성만, 실제 병렬 코딩은 Claude Code subagent(사람 승인 후).** stub 검증. **v2.3.0 태그**(develop→main 병합).
- **[Obsidian 완료] Obsidian 연동.** run 결과를 vault로 read-only export — agent별 노트(frontmatter + `[[wikilink]]` 이전/다음/인덱스) + run MOC 인덱스(실행 순서 링크 + 메타). `run --vault <path>` / `HARNESS_VAULT`, opt-in(미지정 시 무동작). `src/core/obsidianExport.ts`. acceptance Test 6 추가 → **35/35 통과**. (develop, 미태그 — v2.4.0 예정)

## v2.5 안정화 Phase 0 (2026-07-07, V3_KICKOFF 기반)

- v3 착수 조건 미충족 → v3 선결로 v2.5 Phase 0 먼저 구현(V3_KICKOFF.md 0-1~0-4). 각 항목 단위 커밋(develop).
- **[0-1] run --resume** — RunState status/failed_reason/resume_from/loop_state, 실패 지점부터 재개(완료 step은 산출물 복원, 재실행 X).
- **[0-2] token budget** — `--max-tokens`/`HARNESS_MAX_TOKENS`, 초과 시 중단→--resume, 80% 경고.
- **[0-3] approval gate** — `{approval}` step, 거부=user_rejected(재개 가능), `--yes` 비대화. dev-preflight 착수 승인 1곳.
- **[0-4] Red Team 편향 분리** — critic은 target 결론만 격리(contextMode=conclusion_only).
- mock `npm test` → **57/57 통과**.

## 현재 상태 요약 (한 줄)

provider 3종 + 루프 3종 + 분화 + 멀티에이전트 task-prompt + Obsidian + v2.5 안전장치(resume/budget/approval/편향분리) + ux_ui 디자인 레퍼런스 확장(v2.6.0)까지 완비. mock 기준 `npm test` 57/57. git: **main=v2.6.0**. public github 설치 지원(dist 커밋, `npm install github:agrade1/solo-founder-harness`). 실사용 개발 착수 1건 완료(audit-evidence-engine) → v3 게이트 충족.

## Phase 1 도그푸딩 완료 (2026-07-08)

- 실제 아이디어 A(증적엔진)/B(폐쇄망) full-predev(claude-code) 검증 — **CEO 게이트 두 분기(축소/검증) 실발화**.
- A로 dev-preflight(--allow-spawn --yes) → 하위 3개 실제 실행 + 승인게이트 + task-prompt 병렬 스펙 handoff.
- 하네스 self-review(mvp-planning) — critique_loop 2R + 0-4 편향분리 실전 검증.
- 실전 검증된 v2.5 경로: 게이트 두 분기·무한루프 가드·분화+allow-spawn·승인게이트·critique_loop·편향분리·토큰계측. 스키마 경고 0. (resume/budget만 실패상황 미재현, mock 검증됨.)
- 산출물: `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 `projects/dogfood-*` 로컬 전용.

## v3 진입 게이트 충족 (2026-07-08, 이 세션)

- **"실제 개발 착수 1건" 게이트 충족됨.** 별도 private 레포 `github.com/agrade1/audit-evidence-engine`(하네스 로컬 설치)에서 아이디어 A(증적엔진)를 full-predev(claude-code) 검증 → task-prompt → **실제 코드 착수 완주**(`scripts/collect_evidence.sh`: KISA U-코드 읽기전용 점검→증적 패키지. CEO 판정 경계 준수로 remediation/제품코드 없음). 아이디어 F(인프라교육)도 idea-validation로 추가 검증("추가 검증" 판정).
- → v3 착수 3조건(아이디어 2건 검증 + 1건 개발착수) **모두 충족.** 이제 v3는 "규율상 착수 가능" 상태.

## 다음 작업 (self-review 결론 반영)

- v3 게이트는 충족됐으나, self-review 처방대로 **바로 v3.0 코딩에 들어가지 않는다.** execute는 안전경계 시나리오("게이트 이후 실패 시 롤백 주체") 서면 뒤에만, report는 **관측성 통증이 실사용에서 수치로 확인된 뒤** 최소형. (FIELD_NOTES "자기검토 결론" 참고.)
- **관측성 통증 측정법**(v3 report 필요성 판단 기준): 하네스를 실서비스에 반복 사용하며 — ① run당 소요/토큰을 run_state에서 집계했을 때 "매번 파일 열어 확인"이 번거로운가, ② 프로젝트 여러 개의 최신 run 상태를 한눈에 못 봐서 불편한가, ③ 게이트 되돌림/실패 원인을 run_state.json 수동 파싱으로 찾는 빈도가 높은가. 이 통증이 실제로 쌓이면 그때 `harness report`(read-only 스냅샷 표)를 최소형으로.
- 하네스 자체는 현재 "충분히 좋다"(v2.5.0) — 다음 코딩은 하네스가 아니라 **실서비스(audit-evidence-engine 등)** 쪽에서 나온다.
- [보류] anthropic 유료 1회 실검증(비용), resume/budget 실패상황 재현 — 우선순위 낮음.
- 범위 확장 금지 유지. 하네스는 현재 "충분히 좋다"(v2.5.0).
