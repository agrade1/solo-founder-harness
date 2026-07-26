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

V3 작업은 아래 세 문서만 구현 기준으로 사용한다. M3d 이후 로드맵·오케스트레이션 충돌은
1번 문서가 우선하고, MCP 보안·기존 M0~M3 계약은 2~3번 문서를 함께 적용한다.

1. `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`
2. `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`
3. `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`

- `docs/archive/V3_KICKOFF_SUPERSEDED.md` — 과거 계획의 **역사 기록**이며 구현 근거가 아니다.
- `docs/backlog/V3_FIELD_NOTES.md` — **실측 참고 자료**로만 쓴다. 이 문서만을 근거로 신규 기능을
  구현하지 않는다.
- 그 외 `docs/backlog/*`는 사용자가 명시적으로 지정하지 않는 한 구현 근거로 쓰지 않는다.

## 작업 진행 원칙

- **마일스톤 단위**로 진행한다: 계획 → 승인 → 구현 → 테스트. 전체 로드맵을 한 번에 구현하지 않는다.
- **사용자 승인 전에는 코드·패키지·설정을 수정하지 않는다.** 먼저 계획과 영향 파일을 제시한다.
- **기존 테스트를 삭제하거나 완화하지 않는다.** 실패 시 원인을 수정한다.
- **실제 코드와 설계 문서가 충돌하면 구현 전에 보고**한다. 추측으로 진행하지 않는다.

## 리뷰 findings 분류 (배송 우선 — 사용자 승인 정책)

기능 배송이 무한 디테일 하드닝보다 우선한다. 모든 리뷰 finding은 **A/B/C 중 하나로 분류**한다.

- **A — 지금 차단(blocking now)**: P0/P1, 데이터 손실, 승인·인증·상태 전이 우회, 되돌리기 어려운 아키텍처 결정,
  또는 **유예 비용이 커서 후속 작업이 안전하지 않거나 폐기 대상이 되는** 경우. 즉시 수정한다.
- **B — 지정 마일스톤·트리거 전 필수**: 유예는 **명시적 기한(마일스톤 또는 트리거)** 이 있을 때만 허용한다.
- **C — 개선 backlog**: bounded P2/P3 완전성, 문서 정밀도, 낮은 확률의 edge case, micro-optimization.
  **C만으로는 리비전 루프를 다시 돌리거나 기능 진행을 멈추지 않는다.**

유예한 finding은 **하나도 조용히 버리지 않는다.** 각 항목은 심각도 · 발생 확률 · 영향 반경 ·
**유예 시 미래 비용(rework)** · 수정 공수 · 기한/트리거 · 담당 · 증거/산출물 참조 · 상태를 함께 남긴다.
우선순위는 **심각도 단독이 아니라 "유예 비용 대 수정 공수"** 로 정한다.
대장 형식과 현재 항목은 `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` §9.1을 본다.

## 테스트는 위험에 비례한다

- 변경마다 **focused 테스트**를 돌린다.
- handoff 전에 **전체 suite 1회**를 돌린다.
- **반복(3회)·stress·live**는 마일스톤/하드닝 게이트에서만 돌린다. 단, 변경이 그 계약(동시성·lock·
  타이밍·live runner)을 건드리면 그때는 해당 범위에서 즉시 돌린다.
- **테스트를 완화하거나 삭제하지 않는다**는 규칙은 위 어느 경우에도 예외가 없다.

## fresh context와 병렬 Claude 세션

fresh context는 계속 강제다: 구현·리비전은 **fresh Claude Code Opus 5**, 넓은 범위의 계획·비평·리뷰는
**fresh Codex `gpt-5.6-sol` xhigh**가 맡고, 리뷰어는 **read-only**이며 작성자 transcript·자기평가와 분리한다.

Claude Code 구현은 **명백히 더 빠르고 안전할 때만** 여러 Opus 5 세션을 병렬로 쓴다. 조건 전부 충족 필수:

- task DAG와 공유 API/schema 결정을 **먼저** 확정한다.
- worker마다 **격리된 git worktree 1개** + **명시적 파일 소유권**을 부여한다.
- **같은 파일에 두 writer 금지** — 소유권은 서로 겹치지 않는다.
- 공유 schema/API 변경, 통합·병합, 상태 마이그레이션, 최종 전체 테스트는 **직렬**이다.
- 배타 자원·전역 tmp/프로세스·stress·live 테스트도 기존 suite lock 아래에서 **직렬**이다.
- 동시성 상한은 CPU/부하, 메모리, 토큰·비용 예산, manifest `maxSessions`로 제한하고,
  오버헤드·경합이 이득을 넘으면 **세션 1개로 줄인다**.
- 오케스트레이터가 의존성 · 소유권 · artifact hash · 상태 · 완료 · 결과 라우팅을 검증한다.
- 로컬 통합은 직렬, **원격 쓰기는 계속 hard deny**다.

공유 dirty 체크아웃에서의 즉시 리비전 작업은 **단일 세션**으로 하는 것이 맞다. 병렬은 격리 worktree에서만 한다.

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
- 테스트 전체: `npm test` (= 공용 배타 lock → `test:inner` = `test:exec` + `test:core` + `acceptance`).
  전체 suite와 `npm run acceptance:stress:m3d2`는 같은 lock을 지나므로 **동시에 시작할 수 없다**(겹치면 exit 2로 거부).
- 완료 기준: `docs/ACCEPTANCE_TEST_CHECKLIST.md`의 acceptance 전부 통과 + 관련 단위 테스트 통과
