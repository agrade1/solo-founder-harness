# V2_KICKOFF.md

v2 착수 시 이 문서부터 읽는다. v1(v1.0.0 태그, 2026-07-06 완료) 이후 확장 계획.

## 작업 순서 (의존 관계)

```
1. provider 전략 결정   → 모든 v2 기능의 선결 조건
2. 검증 재생성 루프      → 가장 쉬운 첫 루프
3. Red Team 비평 루프    → 임팩트 큼
4. CEO 게이트 분기       → 조건 분기
5. Obsidian 연동        → 독립 트랙 (병행 가능)
```

## 1. Provider 전략 (v2 최우선)

- **결정됨 (2026-07-06): C안** — 상세 설계 `docs/reference/PROVIDER_ARCHITECTURE_V2.md`.
- 결정 배경: `docs/backlog/PROVIDER_STRATEGY_TODO.md` (API 직접 vs Claude Code 위임).
- 요지: 인터페이스에 `mock`/`claude-code`(B안, 구독)/`anthropic`(A안, API) 3개 provider, 플래그 교체. 지금은 `claude-code`로 운영, A안은 나중.
- v1의 `Provider` 인터페이스(`src/providers/provider.ts`)에 실제 구현체를 추가하는 형태 — mock과 교체 가능하게 이미 추상화돼 있음.

## 2. 루프 엔지니어링 (v2/v3)

**전제:** mock에선 출력이 불변이라 무의미. 실제 provider가 붙어야 수렴 신호가 생김.

붙일 루프 지점 (부품은 v1에 이미 존재):

1. **스키마 검증 재생성 루프** — validator가 필수 헤더 누락 시 지금은 경고만(spec: 재생성은 v2). → `runWorkflow` for 루프 안에 `while(!ok && tries<N)` 재실행.
2. **Red Team ↔ 대상 agent 비평 루프** — red_team의 Critical 리스크를 PM/Tech Lead에 되먹여 revise → 재검토. Critical 소멸 또는 M라운드까지.
3. **CEO 게이트 분기** — founder_ceo 판정이 "축소"→pm, "검증"→research로 되돌아감. decision-driven loop.
4. **loop-until-budget / until-quality** — 토큰 예산 또는 판정 점수로 반복 상한.

**아키텍처 변경 필요:**
- workflow 정의를 선형 `steps: string[]`에서 **루프/조건 구성**으로 확장 (예: `{ loop: {agents, until, maxRounds} }`, `{ gate: "founder_ceo", on: {축소:"pm"} }`).
- 오케스트레이터에 루프 제어 + 종료 조건 + 무한루프 방지(maxRounds).
- `run_state.json`에 라운드 기록 추가 (resume 설계와 연계).

## 3. Obsidian 연동 (v2/v3)

- 아이디어/판단 문서를 Obsidian vault와 연동 (양방향 링크, 그래프뷰 활용).
- 독립 트랙 — provider/루프와 무관하게 병행 가능.
- 검토: 출력 markdown에 `[[wikilink]]`/frontmatter 부여, vault 경로 export 옵션.

## 참고

- 범위 확장 방지: `docs/reference/ROADMAP.md` 기준 유지.
- 작업은 `develop` 브랜치에서. 검증 통과 후 `main` 병합 + `vX.Y.Z` 태그.
