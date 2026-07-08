# V3_FIELD_NOTES.md

Phase 1 도그푸딩(하네스를 실제 아이디어에 사용)에서 나온 관찰 기록.
v3.0 스펙(Phase 2)의 1차 입력. — 하네스 **사용성/동작** 기록이지 아이디어 내용 기록이 아니다.
(아이디어 원문·산출물은 gitignore된 `projects/dogfood-*`에만 있음, 푸시 금지.)

작성 시작: 2026-07-08.

---

## 실행한 것

| run | 워크플로우 | provider | 결과 | 게이트 | 소요 | 토큰(in/out) |
|---|---|---|---|---|---|---|
| A (증적엔진) | full-predev | claude-code | completed | 축소→pm 되돌림, 2차 검증(예산소진)→진행 | ~19분 | 37.8k / 65.1k |
| B (폐쇄망) | full-predev | claude-code | completed | 검증→research 되돌림, 2차 검증(예산소진)→진행 | ~25분 | 41.4k / 86.7k |

---

## 검증된 것 (하네스가 실전에서 작동)

1. **full-predev 7개 에이전트 종단 실행** — 실제 LLM으로 완주, 산출물 12~13개 저장.
2. **CEO 게이트 실발화 — 두 분기 모두.** A=축소(→pm), B=검증(→research). 그동안 mock/stub로만 확인됐던 경로가 실제 LLM 판정으로 작동. `max_jumps=1` 가드로 2차 판정은 되돌리지 않고 진행 → **무한루프 방지 확인**.
3. **스키마 재생성 루프 실전 미발동** — 두 run 합쳐 ~24개 에이전트 콜에서 필수 섹션 누락 **경고 0건**. claude-code는 헤더 규격을 안정적으로 지킴. (`--max-regen` 기본 1로 충분.)
4. **handoff 실작동** — red_team이 제기한 Critical을 founder_ceo가 받아 판정에 반영(A: "사업성보다 개인 법률 리스크 해소가 선행 게이트"). 형식만 채우는 게 아니라 앞 단계 결론이 뒤로 전달됨.
5. **토큰 계측 정상** — run_state.usage에 in/out 기록. full-predev 1회(게이트 되돌림 포함) ≈ **10~13만 토큰**. → v3 budget 기본값 가늠에 사용 가능.

---

## 불편/개선점 (v3.0 스펙 입력)

1. **[느림·불투명] full-predev 1회 ~19–25분, 실행 중 진행률/ETA·스트리밍 없음.**
   - 되돌림 발생 시 12콜로 늘어 더 김. 사용자는 끝날 때까지 상태를 모름.
   - → v3: step 시작/종료 타임스탬프 로그, 남은 step 표시, (가능하면) claude-code 스트리밍 패스스루.
2. **[되돌림 가시성 없음] 게이트 되돌림 시 같은 파일(02_PRD 등)을 덮어씀** → 1차 vs 2차 패스에서 무엇이 바뀌었는지 확인 불가.
   - → v3: 되돌림 패스 산출물 버전 보존(예: `02_PRD.v2.md`) 또는 run_state에 pass별 요약/diff 기록.
3. **[게이트 기록 얕음] run_state.gate_jumps는 최종 decision만 남김** — 왜 그 판정인지(근거 문장)는 문서 안에만 있음. 이력 리포트(`harness report`, Phase 2 2-3) 만들 때 판정 근거 한 줄을 run_state에 같이 남기면 유용.
4. **[v2.5 신기능 미검증 경로]** 이번 full-predev는 approval gate(0-3)·critique_loop 편향분리(0-4)·resume(0-1)·budget(0-2)를 타지 않음.
   - approval gate → **dev-preflight** 실행 시 발동 (다음 단계).
   - 편향분리(conclusion_only) → **mvp-planning**(critique_loop 포함) 실행 시 발동.
   - resume/budget → 실제 실패/상한 상황에서 확인 필요.

---

## Phase 1 잔여 (킥오프 기준)

- [x] 실제 아이디어 2개 full-predev(claude-code) 검증 — A, B 완료.
- [x] CEO 게이트 실발화 확인 — 두 분기 모두.
- [ ] 하나는 `dev-preflight` → `task-prompt`까지 → Claude Code로 **수동** 개발 착수(사람 결정).
- [ ] (버전 승격 원칙) v3 착수 전 하네스 자신에게 Red Team 워크플로우 1회.

---

## 잠정 결론

하네스의 핵심 파이프라인(에이전트 체인 + handoff + CEO 게이트 + 가드 + 토큰계측)은 **실제 LLM에서 설계대로 작동한다.** 남은 개선은 기능 결함이 아니라 **관측성**(진행률·되돌림 가시성·판정 근거 기록)에 몰려 있음 → v3.0은 실행 연결(execute)과 함께 **report/관측성**을 우선 후보로.
