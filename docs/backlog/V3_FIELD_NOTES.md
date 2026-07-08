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
| A (증적엔진) | dev-preflight | claude-code (--allow-spawn --yes) | completed | 승인게이트 --yes 통과 | ~10분 | 18.8k / 34.1k |
| 하네스 자신 | mvp-planning | claude-code | completed | critique_loop 2R 미해결(소진) | ~13분 | 22.4k / 43.9k |

---

## 검증된 것 (하네스가 실전에서 작동)

1. **full-predev 7개 에이전트 종단 실행** — 실제 LLM으로 완주, 산출물 12~13개 저장.
2. **CEO 게이트 실발화 — 두 분기 모두.** A=축소(→pm), B=검증(→research). 그동안 mock/stub로만 확인됐던 경로가 실제 LLM 판정으로 작동. `max_jumps=1` 가드로 2차 판정은 되돌리지 않고 진행 → **무한루프 방지 확인**.
3. **스키마 재생성 루프 실전 미발동** — 두 run 합쳐 ~24개 에이전트 콜에서 필수 섹션 누락 **경고 0건**. claude-code는 헤더 규격을 안정적으로 지킴. (`--max-regen` 기본 1로 충분.)
4. **handoff 실작동** — red_team이 제기한 Critical을 founder_ceo가 받아 판정에 반영(A: "사업성보다 개인 법률 리스크 해소가 선행 게이트"). 형식만 채우는 게 아니라 앞 단계 결론이 뒤로 전달됨.
5. **토큰 계측 정상** — run_state.usage에 in/out 기록. full-predev 1회(게이트 되돌림 포함) ≈ **10~13만 토큰**. → v3 budget 기본값 가늠에 사용 가능.
6. **동적 분화(fanout) + `--allow-spawn` 실전 작동** — dev-preflight에서 tech_lead가 하위 3개(doc_evidence_engine/input_parser/script_library)를 SPAWN 선언 → 3개 모두 실제 LLM으로 실행·저장. 그동안 stub으로만 확인됐던 하위 에이전트 런타임 생성이 실제 LLM에서 검증됨. 선언 focus가 구체적이고 서로 겹치지 않음(FE/BE류 분담 자연발생).
7. **approval gate(0-3) 실행 경로 확인** — dev-preflight 마지막 게이트가 chief_of_staff 문서를 표시하고 `--yes`로 통과. 게이트 로직은 LLM 비의존이라 정상.
8. **멀티에이전트 task-prompt(B-3) 실전 생성** — spawned가 있으니 task-prompt에 "병렬 실행" 섹션(하위 3개 담당범위 + 통합 + Include에 계획문서) 자동 생성. 개발 착수 handoff 산출물 정상.

---

## 불편/개선점 (v3.0 스펙 입력)

1. **[느림·불투명] full-predev 1회 ~19–25분, 실행 중 진행률/ETA·스트리밍 없음.**
   - 되돌림 발생 시 12콜로 늘어 더 김. 사용자는 끝날 때까지 상태를 모름.
   - → v3: step 시작/종료 타임스탬프 로그, 남은 step 표시, (가능하면) claude-code 스트리밍 패스스루.
2. **[되돌림 가시성 없음] 게이트 되돌림 시 같은 파일(02_PRD 등)을 덮어씀** → 1차 vs 2차 패스에서 무엇이 바뀌었는지 확인 불가.
   - → v3: 되돌림 패스 산출물 버전 보존(예: `02_PRD.v2.md`) 또는 run_state에 pass별 요약/diff 기록.
3. **[게이트 기록 얕음] run_state.gate_jumps는 최종 decision만 남김** — 왜 그 판정인지(근거 문장)는 문서 안에만 있음. 이력 리포트(`harness report`, Phase 2 2-3) 만들 때 판정 근거 한 줄을 run_state에 같이 남기면 유용.
4. **[v2.5 신기능 실전 검증 현황]**
   - approval gate(0-3) → ✅ dev-preflight에서 확인(--yes 경로).
   - 동적 분화 --allow-spawn → ✅ dev-preflight에서 실제 LLM 하위 3개 실행.
   - critique_loop 편향분리(0-4, conclusion_only) → ✅ 하네스 self-review(mvp-planning)에서 검증. red_team이 출력에서 "편향 분리로 tech_lead의 결론만 받았다"고 명시하고 그 결론만 인용 → conclusion_only가 실제 프롬프트에서 작동. critique_loop도 2라운드 되먹임(수정→재검토) 실작동.
   - resume(0-1)/budget(0-2) → ⬜ 실제 실패/상한 상황 미검증. (mock acceptance로는 검증됨. 실전 재현은 우선순위 낮음.)

---

## 하네스 자기검토(self-review) 결론 — v3 방향 직결

버전 승격 원칙("v3 착수 전 하네스 자신에게 Red Team 1회")대로 하네스를 하네스로 검토(mvp-planning). **자기비판이 강력했고, v3.0 스코프를 흔든다:**

- **[red_team Critical] 순서 위반**: 하네스 자기 규칙은 "아이디어 2개 검증 + 1개 개발 착수"인데 **개발 착수 0건**. 조건 미충족 상태에서 v3 기능을 설계·구현하면 하네스가 자기 진입 게이트를 스스로 어기는 첫 사례가 된다.
- **[red_team Critical] execute 안전경계**: headless로 서비스 레포 코드를 바꾸는 순간 잘못된 diff·부분 실패·롤백 주체가 모호. 1인 유지보수자가 감당 불가. 승인 게이트가 있어도 "게이트 이후 실패 시 누가 무엇을 되돌리나" 시나리오가 안 나오면 만들지 마라.
- **[tech_lead 수정본] 범위 대폭 축소**: execute를 plan-only 스캐폴드까지 v3.0에서 **전면 제외**. 코드로 만드는 것은 read-only `report` 하나로 못 박되, "시계열 이력"이 아니라 "프로젝트별 최신 run 스냅샷 표"로만.
- **[founder_ceo 판정] 축소 후 진행 — 단 첫 작업은 코드가 아님**: execute 폐기수준 보류, `report`조차 "통증을 수치로 확인하기 전까지 코드 0줄"로 조건부 보류. **v3의 실제 첫 작업 = 실제 아이디어 1개를 기존 task-prompt로 개발 착수까지 손으로 완주해 v3 착수 조건을 충족하는 것.**

→ **시사점**: v3.0 스펙 작성(Phase 2)에 바로 들어가면 안 된다. 먼저 (a) 실제 개발 착수 1건으로 v3 게이트를 채우고, (b) 그 경험으로 execute 필요성 자체를 재검증하며, (c) report는 관측성 통증이 수치로 확인된 뒤 최소형으로. 도그푸딩이 "다음 코딩을 미루라"는 결론을 냈다는 것 자체가 하네스가 제 역할을 한 강한 증거.

---

## Phase 1 잔여 (킥오프 기준)

- [x] 실제 아이디어 2개 full-predev(claude-code) 검증 — A, B 완료.
- [x] CEO 게이트 실발화 확인 — 두 분기 모두.
- [x] 하나는 `dev-preflight` → `task-prompt`까지 — A 완료(분화 3개 실행 + 승인게이트 + 병렬 handoff 생성). **실제 코드 착수는 사람 결정**(참고: 하네스 자체 판정은 "법률·서식샘플·지불의향 게이트 전 코드 동결" = FAIL-with-parallel-tracks).
- [x] (버전 승격 원칙) v3 착수 전 하네스 자신에게 Red Team 워크플로우 1회 — mvp-planning self-review 완료(위 "자기검토 결론").

**→ Phase 1 완료.** 단, self-review가 "실제 개발 착수 1건" 미충족을 Critical로 지적 → 이 항목이 남는 한 Phase 2(v3.0 코딩) 진입은 보류가 맞다.

---

## 잠정 결론

하네스의 핵심 파이프라인(에이전트 체인 + handoff + CEO 게이트 + critique_loop + 편향분리 + 분화 + 승인게이트 + 가드 + 토큰계측)은 **실제 LLM에서 설계대로 작동한다.** 남은 개선은 기능 결함이 아니라 **관측성**(진행률·되돌림 가시성·판정 근거 기록)에 몰려 있음.

**단, 하네스 self-review의 결론을 존중하면 v3.0 코딩 진입 자체가 시기상조다:**
1. 먼저 **실제 개발 착수 1건**으로 v3 진입 게이트를 채운다(기존 task-prompt로 충분, 신규 코드 불필요).
2. execute는 안전경계 시나리오("게이트 이후 실패 시 롤백 주체")가 서지 않으면 **만들지 않는다** — 현재로선 plan-only도 보류.
3. report는 관측성 통증이 실사용에서 **수치로 확인된 뒤** 최소형(프로젝트별 최신 run 스냅샷 표, 신규 의존성 0)으로.

즉 다음 코딩은 하네스가 아니라 **실제 서비스 아이디어 쪽**에서 나와야 한다. 하네스는 지금 상태로 "충분히 좋다".
