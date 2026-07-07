# ROADMAP.md

이 문서는 v1 이후 계획이다. v1 개발 중에는 읽지 않는다 (범위 확장 방지).

---

## v1 (현재) — 문서 자동화 CLI

- init / list / run / summary / task-prompt
- mock provider, agent prompt 로드, workflow 순서 실행, markdown 저장
- 완료 기준: ACCEPTANCE_TEST_CHECKLIST Test 1~5 통과

---

## v2 — 실제 LLM 연동 + 운영 안전장치

착수 조건: v1 acceptance 통과 + 실제 프로젝트 1개에서 mock 워크플로우 사용 경험.

### v2.0 Provider 결정 (최우선, 코드보다 먼저)

`docs/backlog/PROVIDER_STRATEGY_TODO.md` 참고. 두 경로 비교 후 결정:

```text
A안: Anthropic API 직접 호출 (종량 과금, 하네스가 독립 실행)
B안: Claude Code subagent/skill로 7개 에이전트 실행 (구독 요금 내 해결, Claude Code에 종속)
```

판단 기준: 월 예상 실행 횟수 × 토큰량 → 비용, 그리고 독립 CLI 필요성.

### v2 포함

> **실제 배포 상태 (2026-07-07 정리).** v2 실제 착수 범위는 `docs/backlog/V2_KICKOFF.md`(provider 전략 + 루프 3종 + Obsidian)로 잡혔고, 아래 목록 중 일부는 V2_KICKOFF 스펙으로 승격되지 않아 보류됐다. 각 항목 상태·사유는 `docs/DECISIONS.md` 2026-07-07 "v2 범위 정합성 정리" 참고. 범례: ✅ 완료 / ⚠️ 부분·대체 / ⏸ 보류.

- ✅ **초과 달성** — 실제 provider 3종 연동(mock/claude-code/anthropic), token usage 리포트 포함
- ⏸ token budget: run당 상한, 초과 시 중단 (backlog TOKEN_COST_POLICY 승격) — 종량 API 경로 미사용으로 필요 미발생, 보류
- ⏸ `harness run --resume`: run_state 기반 실패 지점부터 재개 — 실익 대비 우선순위 낮아 보류
- ⚠️ approval gate: workflow step 사이 사용자 확인 옵션 — 분화(fanout) 지점은 `--allow-spawn`으로 승인 게이트 구현, 일반 step 승인은 보류
- ⚠️ Red Team 편향 분리 — handoff가 각 agent의 결론(Main Judgment 한 줄)만 전달, 전체 추론 문서 미전달로 사실상 달성(red_team 전용 로직은 아님)
- ⚠️ prompt versioning: agent 파일 내부 헤더 버전(v1부터 존재) — CHANGELOG는 보류
- ⏸ output schema validation 강화(내용 최소 길이/형식) — 주 실패모드(섹션 누락)는 재생성 루프가 처리, 내용 검증은 ROI 낮아 보류

### v2 계속 제외

- Claude Code 자동 실행, 웹 UI, DB, 배포, 결제, 멀티유저

---

## v3 — 실행 연결 실험

착수 조건: v2로 실제 아이디어 2개 이상 검증 완료. 하나라도 개발 착수까지 갔을 것.

### v3 후보 (전부 하는 게 아니라 필요한 것만)

- task prompt → Claude Code 반자동 실행 (사람 승인 게이트 필수, headless mode 실험)
- Codex 또는 두 번째 모델 리뷰 연동 (Red Team 편향 완전 분리)
- 프로젝트 간 학습: 이전 프로젝트 DECISIONS/RED_TEAM 결과를 새 프로젝트 리서치 입력으로
- run 이력 대시보드 (웹 UI가 아니라 markdown/CLI 리포트 수준)
- 보안 baseline 적용 (backlog SECURITY_BASELINE 승격 — API key 관리, 실행 권한 최소화)

### v3에서도 안 하는 것

- 완전 무인 자동 개발 (모든 실행은 사람 승인 게이트 유지)
- agent 마켓플레이스/외부 skill 임포트 (공급망 리스크 — 외부 skill의 상당수가 프롬프트 인젝션/취약점 보고됨)

---

## 버전 승격 원칙

```text
기능은 backlog → 다음 버전 스펙 → 구현 순서로만 이동한다.
"만들다 보니 붙인 기능"은 되돌린다.
각 버전 착수 전 Red Team 워크플로우를 하네스 자신에게 실행한다 (dogfooding).
```
