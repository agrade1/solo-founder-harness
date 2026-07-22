# AGENTS.md

이 파일은 이 저장소에서 작업하는 모든 에이전트(Codex 포함)가 지키는 **장기 고정 규칙**이다.
세션·마일스톤과 무관하게 유효하다. 진행 상황·마일스톤 상세는 `docs/handoff/CODEX_HANDOFF.md`,
`docs/WORKLOG.md`, `docs/CONTEXT_SUMMARY.md`를 본다.

## 프로젝트 목적과 성격

- Solo Founder AI Harness — TypeScript CLI. 1인 창업자가 아이디어(`00_IDEA.md`)를 입력하면
  코어 에이전트 워크플로우를 실행해 판단 문서를 생성하고, Claude Code에 넘길 작업 지시문을 만든다.
- v1은 문서 자동화(init/list/run/summary/task-prompt), 이후 exec/mission 실행 계층이 추가됐다.
- 실행 계층(exec/mission)은 **승인·권한 게이트 안에서만** 동작한다. 승인 없는 코드 수정·
  production 변경은 없다.

## 아키텍처 유지 원칙

- **TypeScript, ESM(NodeNext), engines `>=18` 유지.** 신규 런타임 의존성은 사전 승인 후에만 추가한다.
- 기존 아키텍처(5 step 종류 워크플로 엔진, provider 추상화, `run_state.json` 시스템 오브 레코드)를
  유지한다. 중복 프레임워크·오케스트레이터를 새로 만들지 않는다.
- 시스템 오브 레코드는 `projects/<p>/docs/*.md` + `outputs/run_state.json`. Markdown이 원본이다.

## 활성 구현 기준 문서

V3 작업은 아래 두 문서만 구현 기준으로 사용한다. 충돌 시 이 두 문서가 우선한다.

1. `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`
2. `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`

- `docs/archive/V3_KICKOFF_SUPERSEDED.md` — 과거 계획의 **역사 기록**이며 구현 근거가 아니다.
- `docs/backlog/V3_FIELD_NOTES.md` — **실측 참고 자료**로만 쓴다. 이 문서만을 근거로 신규 기능을
  구현하지 않는다.
- 그 외 `docs/backlog/*`는 사용자가 명시적으로 지정하지 않는 한 구현 근거로 쓰지 않는다.

## 작업 진행 원칙

- **마일스톤 단위**로 진행한다: 계획 → 승인 → 구현 → 테스트. 전체 로드맵을 한 번에 구현하지 않는다.
- **사용자 승인 전에는 코드·패키지·설정을 수정하지 않는다.** 먼저 계획과 영향 파일을 제시한다.
- **기존 테스트를 삭제하거나 완화하지 않는다.** 실패 시 원인을 수정한다.
- **실제 코드와 설계 문서가 충돌하면 구현 전에 보고**한다. 추측으로 진행하지 않는다.

## 금지 (hard deny — 자동화 대상 아님)

- production deploy
- live billing (실결제)
- remote repository direct write (원격 저장소 직접 쓰기)
- pull request merge 자동화
- MCP 패키지 `@latest` 사용 (버전 pin 필수)

## 작업 종료 시

- `docs/WORKLOG.md` 갱신
- 중요 결정은 `docs/DECISIONS.md` 기록
- `docs/CONTEXT_SUMMARY.md`를 짧게 갱신 (다음 세션 시작용)

## 명령 (참고)

- 빌드: `npm run build` (tsc → dist)
- 테스트 전체: `npm test` (= `test:exec` + `test:core` + `acceptance`)
- 완료 기준: `docs/ACCEPTANCE_TEST_CHECKLIST.md`의 acceptance 전부 통과 + 관련 단위 테스트 통과
