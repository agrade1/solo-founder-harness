# solo-founder-harness

1인 창업자가 아이디어를 입력하면 코어 에이전트 워크플로우(Research → PM → UX → Tech Lead → Red Team → CEO)를 실행해
판단 문서를 자동 생성하고, Claude Code에 넘길 안전한 작업 지시문을 만들어주는 CLI 도구.

## v1 범위

- harness init / list / run / summary / task-prompt
- mock provider 기반 (실제 LLM 호출 없음)
- agent prompt 파일 로드 → workflow 순서 실행 → markdown 저장 → CONTEXT_SUMMARY 갱신 → task prompt 생성

## v1 제외

- 자동 코드 실행, Codex/OMC/Agent Teams 연동, 웹 UI, DB, 배포, 결제

## 기능 (v2.6.0 — 전부 릴리스 완료)

> v1(문서 자동화) 이후 v2.x에서 아래를 순차 추가·완료했다. **현재 진행 중인 개발 항목은 없다.** (v3는 실사용 통증이 확인되면 착수 — `docs/backlog/V3_KICKOFF.md`)

- **실제 LLM provider** (mock과 교체 가능): `--provider mock | claude-code | anthropic`
  - `claude-code`(B안): `claude -p`에 위임, Claude 구독으로 실행 (추가 API 비용 0). `claude` CLI 로그인 필요.
  - `anthropic`(A안): Anthropic API 직접 (`@anthropic-ai/sdk`, 종량 과금). `ANTHROPIC_API_KEY` 필요, 모델은 `HARNESS_ANTHROPIC_MODEL`(기본 opus-4-8).
- **스키마 검증 재생성 루프**: 필수 헤더 누락 시 누락 항목을 피드백해 자동 재생성 (`--max-regen <n>`, 기본 1). run_state에 라운드 기록.
- **Red Team 비평 루프**: workflow steps를 loop 구성으로 확장(`(string | {critique_loop} | {gate})[]`). critic이 Critical 리스크를 지적하면 target에 되먹여 revise → 재검토(Critical 소멸/max_rounds까지). `mvp-planning`에 내장(`↻[red_team⟲tech_lead×2]`). run_state에 `critique_rounds` 기록.
- **CEO 게이트 분기**: decider(founder_ceo) 판정이 매칭되면 지정 agent로 되돌려 재실행(max_jumps로 무한루프 방지). `full-predev`에 내장(`⤴[founder_ceo?축소→pm,검증→research×1]`). run_state에 `gate_jumps` 기록.
- **동적 분화(fanout)**: planner(tech_lead)가 `SPAWN id=..|name=..|focus=..`로 하위 전문 에이전트 선언 → 기본은 계획만 기록(사람 승인 게이트), `--allow-spawn` 시 런타임 생성·실행(`outputs/spawned/<id>.md`). `dev-preflight`에 내장(`⑂[tech_lead→spawn×4]`). run_state에 `spawned_agents` 기록.
- **멀티에이전트 task-prompt**: 분화가 있었으면 `task-prompt`가 FE/BE별 **병렬 subagent 실행 스펙**을 생성(담당범위·계획문서·API_CONTRACT 통합·승인 게이트). 하네스는 스펙 생성까지 — 실제 병렬 코딩은 Claude Code subagent가 사람 승인 후 수행.
- **Obsidian export**: `run --vault <경로>`(또는 `HARNESS_VAULT`) 지정 시 실행 결과를 Obsidian vault로 read-only export. agent별 노트(YAML frontmatter + 이전/다음/인덱스 `[[wikilink]]`) + run MOC 인덱스(실행 순서 링크 + 메타). 미지정 시 동작 안 함(기존 파이프라인 무영향). 원본 `projects/` 파일은 비파괴.
- **안전장치 (v2.5)**: `run --resume`(실패 지점부터 재개), `--max-tokens`(토큰 상한, 초과 시 중단→재개, 80% 경고), `{approval}` step(진행 전 y/n 승인, `--yes`로 비대화), Red Team 편향 분리(critic은 대상의 결론만 격리 검토).
- **디자인 레퍼런스 (v2.6)**: `ux_ui` 에이전트가 레퍼런스 리서치 방향(Pinterest/Dribbble/Mobbin/경쟁사·유사서비스 + 검색 키워드) + 비주얼 방향 + 디자인 실행 handoff 산출. `03_UX_FLOW.md`가 있으면 `task-prompt`에 "디자인 실행(화면 시안)" 섹션 자동 추가 → Claude Code에서 레퍼런스 검색 + Claude 아티팩트로 시안 생성. (ux_ui는 방향만 지시, 픽셀은 Claude Code가.)
- **디자인 시스템 레이어**: `design` 에이전트가 `DESIGN.md`(디자인 시스템 명세) + `tokens.json`(3계층 디자인 토큰: primitive→semantic→component)을 산출(source of truth). `mvp-planning`·`full-predev`는 UX 다음에 design → **디자인 승인 게이트**({approval}, 시안 검증 후 md/json에 역반영)를 거쳐 tech_lead로 이어진다. 게이트 승인 시 `run_state.design_gate`에 tokens.json 해시 기록. PM=PRD·tech_lead=Tech Spec·design=DESIGN.md는 에이전트별 필수 헤더가 스키마 재생성 루프에 등록됨. DESIGN.md+tokens.json이 있으면 `task-prompt`에 토큰 기반 구현 규칙(하드코딩 금지 등) 주입. `scripts/token-lint.mjs`가 raw hex·primitive 직접참조·토큰 구조 위반을 정적 검사(LLM 없음, exit 0/1).
- token usage를 `run_state.json`에 집계.
- 상세: `docs/reference/PROVIDER_ARCHITECTURE_V2.md`, `docs/backlog/V2_KICKOFF.md`, `docs/backlog/V3_KICKOFF.md`.

## 구조 (요약 아키텍처)

```text
[패키지 자산 — PACKAGE_ROOT 기준]
registry/*.json  → agent/workflow 정의 (데이터)
agents/*.md      → prompt 원문 (runAgent가 로드)
src/core         → runWorkflow → runAgent → saveArtifact → updateContextSummary → generateClaudeTaskPrompt

[사용자 데이터 — WORKSPACE_ROOT(=CWD) 기준]
projects/<name>  → 사용자 프로젝트 (docs + outputs)
```

경로는 둘로 분리된다(`src/core/paths.ts`): **자산**은 설치된 패키지 위치에서, **projects 데이터**는 실행한 디렉토리(CWD)에서. `HARNESS_WORKSPACE`로 데이터 위치 오버라이드 가능.

## 빠른 시작 (실전)

```bash
# 1. 설치 (서비스 레포에서 1회)
npm install github:agrade1/solo-founder-harness

# 2. 프로젝트 만들고 아이디어 작성
npx harness init my-idea
#   → projects/my-idea/docs/00_IDEA.md 에 아이디어 적기

# 3. 기획 (실제 LLM) — PRD·UX·DESIGN.md/tokens.json·Tech Spec·CEO 판정 생성
npx harness run full-predev --project my-idea --provider claude-code
#   → 중간 디자인 게이트에서 멈추면 DESIGN.md 확인 후 진행(승인)

# 4. 코딩 — 아래 셋 중 하나
#   A) 대화형 한 세션: 격리 worktree에서 구현→게이트→리뷰→develop 병합
npx harness exec --task "신호등 리포트 화면 구현" --review

#   B) 자율 미션: 목표를 태스크로 쪼개 알아서 완주 → 아침에 MISSION_REPORT
npx harness mission --goal "MVP 화면 3개 구현"

#   C) 병렬 자율: 독립 태스크를 여러 세션 동시에
npx harness mission --goal "..." --parallel

#   D) 수동: 기획만 받고 코딩은 직접
npx harness task-prompt --project my-idea   # → 지시문을 Claude Code에 붙여넣기
```

- **기획만 필요하면 3번까지**, **코딩까지 자동으로 하려면 4번**. main 병합·배포만 사람이, develop까지는 게이트(lint/test/build + Opus 리뷰) 통과 조건으로 자율.
- 실행 계층(`exec`/`mission`) 상세는 `docs/reference/EXECUTION_LAYER_ARCH_v1.md`.

## 사용 가이드 — 새 레포에서 작업 시작 순서

하네스 하나에 서비스를 쌓지 말고, **서비스 레포마다 하네스를 설치**해서 쓴다.
`projects/`는 실행한 레포(CWD)에 생성되고, 에이전트/워크플로우 정의는 설치된 패키지에서 로드되므로 서비스 레포는 깨끗하게 유지된다.

### 0. 최초 1회 — 레포 세팅 + 하네스 설치 (public repo)

```bash
mkdir my-service && cd my-service
git init
npm init -y                                     # package.json 없으면

# public GitHub 레포에서 설치 (dist 포함 커밋돼 있어 별도 빌드 불필요)
npm install github:agrade1/solo-founder-harness

# (선택) 비공개 서비스 레포로 만들기 — 실제 아이디어는 private 권장
gh repo create my-service --private --source=. --push
```

> 특정 버전 고정: `npm install github:agrade1/solo-founder-harness#v2.5.1`

### 1. 아이디어마다 — 작업 흐름

```bash
# ① 프로젝트 생성 → ./projects/<name>/ (docs 6개 + outputs)
npx harness init <프로젝트명>

# ② 아이디어 작성 (사람이): projects/<프로젝트명>/docs/00_IDEA.md 편집

# ③ 판단·기획 실행 (실제 LLM)
npx harness run full-predev --project <프로젝트명> --provider claude-code

# ④ 결과 검토 (사람이): docs/01_RESEARCH ~ 06_CEO_DECISION.md, 특히 CEO 판정

# ⑤ 개발 지시문 생성 → outputs/claude_code_task_prompt.md
npx harness task-prompt --project <프로젝트명>

# ⑥ 실제 개발 — 둘 중 하나:
#    (자동) npx harness exec --task "..." --review   ← 격리 worktree에서 구현→게이트→리뷰→develop 병합
#           npx harness mission --goal "..."          ← 목표 자율 완주(+--parallel 병렬)
#    (수동) ⑤ 지시문을 Claude Code에 붙여넣어 사람이 진행
```

### 2. 워크플로우 선택

| 워크플로우 | 언제 | 특징 |
|---|---|---|
| `idea-validation` | 아이디어 go/no-go 빠른 검증 | 5단계, 게이트 없음 |
| `mvp-planning` | MVP 범위 잡기 | pm→ux→**design→[디자인 게이트]**→tech + red_team 비평 루프 |
| `full-predev` | **제품 아이디어 종합 사전검토(가장 많이 씀)** | research→pm→ux→**design→[디자인 게이트]**→tech→red→ceo + CEO 게이트 |
| `dev-preflight` | 개발 직전 | 에이전트 분화 + 승인게이트 + 병렬 task-prompt |

### 주의

- 실제 아이디어는 **private 레포**에. 공개 레포면 `00_IDEA.md`·`docs/`·`evidence/` 등을 `.gitignore` 처리.
- 하네스는 **텔레메트리 없음** — 아무것도 외부로 안 보낸다. 전부 로컬.
- `--provider mock`(기본)은 오프라인 더미 출력(구조 확인용). 실제 판단은 `--provider claude-code`(구독 로그인 필요).

## 하네스 자체 개발/수정 시 (from source)

> 아래는 **하네스 레포를 직접 수정**할 때만. 서비스에서 쓰는 법은 위 "사용 가이드" 참고.
> dist는 레포에 커밋되므로, 소스 수정 후에는 `npm run build`로 dist를 갱신해 커밋한다.

```bash
npm install          # 최초 1회 (의존성 설치)
npm run build        # 소스 수정 후 dist 갱신 (dist는 커밋되므로 커밋 전 필수)

# 개발 중에는 tsx로 바로 실행
npm run harness -- list
npm run harness -- init my-project
npm run harness -- run idea-validation --project my-project
npm run harness -- summary --project my-project
npm run harness -- task-prompt --project my-project
```

명령 요약:

| 명령 | 설명 | 산출물 |
|---|---|---|
| `list` | core agents / common prompt / workflows 출력 | (stdout) |
| `init <name>` | 프로젝트 docs 6개 + outputs 생성 | `projects/<name>/` |
| `run <workflow> --project <name> [--provider <id>] [--max-regen <n>] [--allow-spawn] [--vault <경로>]` | workflow 순서 실행, 결과 저장 (기본 provider=mock). `--vault` 시 Obsidian export | `docs/0N_*.md`, `outputs/run_state.json`, (`--vault` 시) `<vault>/<project>/*.md` |
| `summary --project <name>` | 상태 요약 갱신 | `docs/CONTEXT_SUMMARY.md` |
| `task-prompt --project <name>` | Claude Code 작업 지시문 생성 | `outputs/claude_code_task_prompt.md` |
| `handoff --project <name> [--cwd <serviceRepo>] [--print] [--yes]` | [v3-M3b.2] 완료된 판단 문서 → 서비스 레포에서 Claude Code 대화형 세션을 연다(승인 게이트·headless preflight 통과 후, `-p` 아님·`stdio:inherit`). `--print`는 재진입 명령만 출력. `run ... --handoff`로도 이어붙임 | 대화형 세션 (+ `outputs/tool-trace/<id>.jsonl`) |
| `exec --task <t> [--review] [--yes]` | 실행 세션 1개: worktree에서 구현→게이트→(리뷰)→승인→develop 병합 | 코드 커밋(develop) |
| `mission --goal <g> [--parallel] [--concurrency <n>] [--yes]` | 목표 분해→승인→자율 완주(태스크마다 게이트·리뷰·병합) | develop 커밋들 + `outputs/MISSION_REPORT.md` |

기본 workflow: `idea-validation`, `mvp-planning`, `dev-preflight`, `full-predev`.
실행 계층(`exec`/`mission`)은 실제 claude 구독 세션으로 코드를 짜고 develop까지 자율 병합(main·배포만 사람).

## 테스트

```bash
npm test             # acceptance Test 1~5 자동 검증 (30 checks)
```

## 참고

개발 시작: `prompts/claude_code_minimal_context_start_prompt.md`.
문서 로드 정책: `docs/reference/MINIMAL_CONTEXT_LOAD_POLICY.md`.
