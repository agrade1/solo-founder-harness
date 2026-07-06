# solo-founder-harness

1인 창업자가 아이디어를 입력하면 코어 에이전트 워크플로우(Research → PM → UX → Tech Lead → Red Team → CEO)를 실행해
판단 문서를 자동 생성하고, Claude Code에 넘길 안전한 작업 지시문을 만들어주는 CLI 도구.

## v1 범위

- harness init / list / run / summary / task-prompt
- mock provider 기반 (실제 LLM 호출 없음)
- agent prompt 파일 로드 → workflow 순서 실행 → markdown 저장 → CONTEXT_SUMMARY 갱신 → task prompt 생성

## v1 제외

- 자동 코드 실행, Codex/OMC/Agent Teams 연동, 웹 UI, DB, 배포, 결제

## 구조 (요약 아키텍처)

```text
registry/*.json  → agent/workflow 정의 (데이터)
agents/*.md      → prompt 원문 (runAgent가 로드)
src/core         → runWorkflow → runAgent → saveArtifact → updateContextSummary → generateClaudeTaskPrompt
projects/<name>  → 사용자 프로젝트 (docs + outputs)
```

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
| `run <workflow> --project <name>` | workflow 순서 실행, mock 결과 저장 | `docs/0N_*.md`, `outputs/run_state.json` |
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
