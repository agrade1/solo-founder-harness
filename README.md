# solo-founder-harness

1인 창업자가 아이디어를 입력하면 코어 에이전트 워크플로우(Research → PM → UX → Tech Lead → Red Team → CEO)를 실행해
판단 문서를 자동 생성하고, Claude Code에 넘길 안전한 작업 지시문을 만들어주는 CLI 도구.

## v1 범위

- harness init / list / run / summary / task-prompt
- mock provider 기반 (실제 LLM 호출 없음)
- agent prompt 파일 로드 → workflow 순서 실행 → markdown 저장 → CONTEXT_SUMMARY 갱신 → task prompt 생성

## v1 제외

- 자동 코드 실행, Codex/OMC/Agent Teams 연동, 웹 UI, DB, 배포, 결제

## v2 (진행 중)

- **실제 LLM provider** (mock과 교체 가능): `--provider mock | claude-code | anthropic`
  - `claude-code`(B안): `claude -p`에 위임, Claude 구독으로 실행 (추가 API 비용 0). `claude` CLI 로그인 필요.
  - `anthropic`(A안): Anthropic API 직접 (`@anthropic-ai/sdk`, 종량 과금). `ANTHROPIC_API_KEY` 필요, 모델은 `HARNESS_ANTHROPIC_MODEL`(기본 opus-4-8).
- **스키마 검증 재생성 루프**: 필수 헤더 누락 시 누락 항목을 피드백해 자동 재생성 (`--max-regen <n>`, 기본 1). run_state에 라운드 기록.
- **Red Team 비평 루프**: workflow steps를 loop 구성으로 확장(`(string | {critique_loop} | {gate})[]`). critic이 Critical 리스크를 지적하면 target에 되먹여 revise → 재검토(Critical 소멸/max_rounds까지). `mvp-planning`에 내장(`↻[red_team⟲tech_lead×2]`). run_state에 `critique_rounds` 기록.
- **CEO 게이트 분기**: decider(founder_ceo) 판정이 매칭되면 지정 agent로 되돌려 재실행(max_jumps로 무한루프 방지). `full-predev`에 내장(`⤴[founder_ceo?축소→pm,검증→research×1]`). run_state에 `gate_jumps` 기록.
- **동적 분화(fanout)**: planner(tech_lead)가 `SPAWN id=..|name=..|focus=..`로 하위 전문 에이전트 선언 → 기본은 계획만 기록(사람 승인 게이트), `--allow-spawn` 시 런타임 생성·실행(`outputs/spawned/<id>.md`). `dev-preflight`에 내장(`⑂[tech_lead→spawn×4]`). run_state에 `spawned_agents` 기록.
- **멀티에이전트 task-prompt**: 분화가 있었으면 `task-prompt`가 FE/BE별 **병렬 subagent 실행 스펙**을 생성(담당범위·계획문서·API_CONTRACT 통합·승인 게이트). 하네스는 스펙 생성까지 — 실제 병렬 코딩은 Claude Code subagent가 사람 승인 후 수행.
- token usage를 `run_state.json`에 집계.
- 상세: `docs/reference/PROVIDER_ARCHITECTURE_V2.md`, `docs/backlog/V2_KICKOFF.md`.

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

## 라이브러리로 다른 레포에서 사용

하네스 하나에 서비스를 쌓지 말고, **서비스 레포마다 하네스를 설치**해서 쓴다. projects/는 실행한 레포(CWD)에 생성된다.

```bash
# 새 서비스 레포에서 (아직 npm 미배포 → git/로컬 설치)
npm install github:agrade1/solo-founder-harness
# 또는 로컬 개발용: npm install /path/to/solo-founder-harness

npx harness init my-service        # ./projects/my-service/ 생성 (이 레포 안)
# ./projects/my-service/docs/00_IDEA.md 작성
npx harness run mvp-planning --project my-service --provider claude-code
npx harness task-prompt --project my-service
```

에이전트 프롬프트/워크플로우 정의는 설치된 패키지에서 로드되므로 서비스 레포는 깨끗하게 유지된다.

## 사용법

```bash
npm install          # 최초 1회 (의존성: commander/tsx/typescript)
npm run build        # 타입 체크 + dist 빌드 (선택)

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
| `run <workflow> --project <name> [--provider <id>] [--max-regen <n>]` | workflow 순서 실행, 결과 저장 (기본 provider=mock) | `docs/0N_*.md`, `outputs/run_state.json` |
| `summary --project <name>` | 상태 요약 갱신 | `docs/CONTEXT_SUMMARY.md` |
| `task-prompt --project <name>` | Claude Code 작업 지시문 생성 | `outputs/claude_code_task_prompt.md` |

기본 workflow: `idea-validation`, `mvp-planning`, `dev-preflight`, `full-predev`.

## 테스트

```bash
npm test             # acceptance Test 1~5 자동 검증 (30 checks)
```

## 참고

개발 시작: `prompts/claude_code_minimal_context_start_prompt.md`.
문서 로드 정책: `docs/reference/MINIMAL_CONTEXT_LOAD_POLICY.md`.
