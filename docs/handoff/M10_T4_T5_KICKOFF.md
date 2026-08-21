# M10 T4·T5 KICKOFF — 새 세션이 이 문서 하나로 이어받는다

> 작성 2026-08-21 (M10 T1·T2·T3 완료 직후 · 앞 세션이 대화 길이 한계로 끊으며 인계).
> 브랜치 `work/m5c-autopilot` · **OPEN PR 0 · 머지 대기 없음**.
> 앞선 판정은 로드맵 **`M10 진행 판정 ③`**(T3) → `②`(T2) → `①`(T1) 절이 정본이다(위가 최신).

---

## 0. 30초 요약

M10의 **T1·T2·T3가 끝났고 T4·T5가 남았다.** T3에서 **무인 loop end-to-end를 live로 밟았다**
(PASS=8/8 · 기획→디자인→개발이 한 번의 `runAutopilot`으로 완주) → M9의 "부분" 판정이 닫혔다
(단 **loop-형태 축에 한정** — 리뷰 왕복·in-loop 테스트·최종 report는 그 live 범위 밖이다).

**T4는 새 기능이 아니다.** 아래 §2가 실측 근거다 — F3는 **M3b.2/M3c.3b에서 이미 구현·증명됐다.**
M10 KICKOFF §3의 "T4 = M10의 유일한 신규 기능"은 **stale**이며, 그것은 이 마일스톤에서 **세 번째로
반복된 같은 부류의 오류**다(`B-12`·`B-21`·`B-22`도 코드가 이미 닫혀 있는데 대장 행만 `open`이었다).
**착수 전 grep으로 실상을 확인하는 규율을 T4·T5에도 그대로 적용하라.**

---

## 1. 지금 서 있는 지반 (실측 · 직렬 재실행 값)

`test:exec` **610/610** · `test:core` **458/458** · `scripts/acceptance.sh` **PASS=189 / FAIL=0**
(M10은 **Test 22** · 내부 41건) · `npx tsc --noEmit` clean.
**mutation red 누적 31종** · **live**: T3 무인 loop 1회 PASS=8/8.

| 항목 | 상태 |
|---|---|
| T1 resume/crash recovery | **완료** — 대장 6건 닫음(`C-4` 부분·`C-4` 보강·`C-8`·`C-55`·`C-59`·`C-76`) + stale 표기 3건 정정 |
| T2 통합 시나리오 | **완료** — 5축 중 통합 층 공백 4축을 red-path로 세움. 문서 누락 축은 **통합 층에서 표현 불가**(kernel 층 전수 커버) |
| T3 무인 loop end-to-end | **완료** — `B-32` 닫음 · live worker backend(`claude-plan`) · live 8/8 |
| **T4 F3 핸드오프** | **아래 §2 — 이미 구현·증명됨. 남은 것은 "무엇을 T4로 셀 것인가"의 판단** |
| **T5 릴리스 게이트(도그푸딩 + `C-67`)** | **미착수 — §3** |

### A급으로 잡아 고친 것 3건 (이 마일스톤에서)

1. **거짓 정리 영수증**(T1): 정리 미확인 turn에도 `confirmCleanup`(survivors 0)을 durable에 적었다.
2. **durable 본문의 거짓 진술**(T2): 결과 본문이 "typed operation은 집행하지 않았다"를 **고정 문구**로
   담아, 실제로 집행한 turn에도 그 문장이 남았다.
3. **프롬프트·응답 원문 유출**(T3 리뷰 B1): `--no-session-persistence`가 없어 turn마다 프롬프트 전문과
   응답 원문이 **사용자 세션 저장소**에 기록됐다("durable에 남지 않는다"는 harness store에만 참이었다).

---

## 2. T4 — F3는 이미 있다 (실측 표)

`src/core/handoff.ts`(562줄) + `harness handoff` 명령 + `harness run … --handoff` 플래그가 **M3b.2**에
들어갔고 tool profile은 **M3c.3b**에서 붙었다. F3 설계 문서(`V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`
§F3.1~F3.2)의 항목을 하나씩 대조한 결과:

| F3 명세 항목 | 구현 | 위치 |
|---|---|---|
| run `completed` 확인 후에만 핸드오프 | ✅ | `handoff.ts:348` → `action: "not_completed"` |
| `updateContextSummary` + `generateTaskPrompt` 자동 실행 | ✅ | `handoff.ts:390-391` |
| 승인 게이트(+ `--yes` 스킵) | ✅ | `handoff.ts:269` `[승인 필요]` · `opts.yes` |
| **대화형 TUI만**(`stdio:"inherit"`) · headless `-p` 금지 | ✅ | `handoff.ts:261` · 헤더 23행이 금지를 명시 |
| `--print` 폴백(실행·상태 변경 0) | ✅ | `handoff.ts:342` → `action: "printed"` |
| `run_state.handoff` 기록(**실제 spawn된 경우에만**) | ✅ | `runWorkflow.ts:112-116` `HandoffRecord` |
| 비-TTY에서 대화형 세션을 띄우지 않는다 | ✅ | `handoff.ts:422-426` → `action: "non_tty"` |
| 바이너리 부재 시 에러가 아니라 `--print` 폴백 | ✅ | `handoff.ts:418` → `action: "missing_binary"` |
| 128KB 초과 프롬프트는 "파일을 열어 읽어라"로 대체 | ✅ | `handoff.ts:37·396-405` |
| 증명물 | ✅ | `src/core/handoff.test.ts` · acceptance **Test 12** · live `scripts/m3b2-live-handoff.mjs` · `scripts/m3c3b-live-handoff.mjs` |

### 그래서 T4를 어떻게 처리할 것인가 (판단이 필요한 지점)

**후보 ①(권장) — "이미 완료"로 판정하고 그 근거를 로드맵에 적는다.** 위 표를 `M10 진행 판정 ④` 절에
넣고, KICKOFF의 stale 기술을 정정한다. 새 코드 0줄. `docs/backlog/...ROADMAP.md` §10 M10 절의 F3
항목에 "M3b.2/M3c.3b에서 구현됨 — M10에서 다시 만들지 않는다"를 명시.

**후보 ② — 진짜 남은 차집합만 좁게 연다.** 현행 handoff는 **v1 문서 워크플로의 `run_state.json`**
(project 기반)을 읽는다. **v3 오케스트레이션 run**(`outputs/orchestration/<run-id>/run_state.json`)에서
"문서 완료 → 핸드오프"는 **배선돼 있지 않다.** 이것이 유일하게 실체 있는 gap이다. 다만:
- F3 설계는 v3 kernel보다 **먼저** 쓰였고(§F3.1은 v1 `harness run` 흐름 전제), 로드맵이 F3를 M10에
  배치한 시점(2026-08-12)에 그 재배선을 요구했는지는 **문서에 명시가 없다.**
- 열면 새 명령 표면·새 승인 판단이 생긴다 → **사용자 판단 대상**이다.

**어느 쪽이든 금지선은 그대로다**: headless 자동 코드 수정(`execute --apply`) 경로를 열지 마라.
설계 문서가 "대화형 Claude Code 세션을 여는 것까지"로 못 박았다.

**T4 live 1회는 사용자가 이미 승인했다**(앞 세션에서 "T3 무인 loop live 1회 + T4 F3 핸드오프 live 1회").
후보 ①을 고르면 live는 **불필요**하다(이미 live 스크립트 2개가 있다) — 그 사실을 판정에 적으면 된다.
새로 돌리려면 `scripts/m3b2-live-handoff.mjs`를 재실행하는 것이 맞고, **새 스크립트를 만들지 마라.**

---

## 3. T5 — 릴리스 게이트: 도그푸딩 + 승인 정적 감사(`C-67`)

로드맵 원문: "도그푸딩하는 실제 프로젝트 2~3개의 승인 manifest를 감사해 '과도하게 넓은 승인'이
실사용에서 실제로 생기는지 확인한다. **감사가 아무것도 못 찾으면 그 사실을 그대로 적는다**(공허한
게이트를 통과로 세지 않는다)."

**대상은 사용자가 승인했다(2개)**: `~/Desktop/구독컷` · **이 harness 레포 자체**.
로드맵은 "2~3개"이므로 2개는 하한이다 — 그 사실을 판정에 적어라.

**`src/exec/manifestAudit.ts`는 M7에 이미 있다(116줄 · 규칙 R1~R5). 새로 만들지 마라.**
T5가 하는 일은 ⓐ 두 프로젝트의 디렉터리 구조를 **읽고**(읽기 전용) ⓑ "내가 그 프로젝트에서 마일스톤을
승인한다면" 형태의 `MilestoneApprovalManifest`를 작성해 ⓒ `auditApprovalManifest()`를 돌려 ⓓ 결과를
**있는 그대로** 적는 것이다. 아무것도 못 찾으면 "R1~R5로는 아무것도 안 걸렸다 + 왜 그런가"를 적는다.

**감사 규칙 5개**(그 이상을 발명하지 마라 — 규칙 추가는 별도 판단이다):
R1 다른 root를 덮는 `writableRoot` · R2 아무도 소유하지 않는 `writableRoot` ·
R3 ownership 없는 task의 operation 권위 · R4 승인 창 7일 초과 · R5 승인 경로 부재.

동시에 M10 완료 조건의 마지막 축이 여기 걸려 있다: **"hard deny와 milestone approval 경계 우회 없음"**.
우회 시도별 red-path는 T1~T3에서 상당 부분 쌓였다(승인 없는 live backend 거부 · digest 재검증 ·
소유권 밖 발행 거부 · 사람 gate 우회 불가). T5는 그 목록을 **한 자리에 모아 판정**하면 된다.

---

## 4. 재논의 금지 (앞 세션에서 확정 · 실측 근거 있음)

1. **`C-80`("직렬 로컬 병합")을 닫으려 하지 마라.** worker 산출 경로를 바꾸는 결정이 선행한다.
2. **두 번째 lock 구현을 만들지 마라.** writer lock과 controller lease가 `acquireOwnedLock` 하나를
   공유한다(회수는 **사망 관측 `ESRCH`에만** · `<lock>.reclaim` 직렬화 · temp+`link` 발행).
3. **`designReviewRoundtrip.ts`에 세 번째 패턴을 만들지 마라.** `assertRoundtrip()` 하나를 다시 쓴다.
4. **`manifestAudit.ts`를 새로 만들지 마라**(M7에 있다).
5. **F3에서 headless 자동 코드 수정 경로를 열지 마라.**
6. **`MANAGED_PROCESS_ENV`·`LIVE_WORKER_ENV`에 호출자별 오버라이드 표면을 열지 마라.**
   `LIVE_WORKER_ENV`는 실측으로 `USER` 하나만 더했고 `HOME`은 **주지 않는다**(그것은 env 위생이고
   경계가 아니다 — 경계는 `--tools ""`·`--strict-mcp-config`·`--setting-sources ""`·
   `--no-session-persistence`가 만든다).
7. **live worker의 계획 검증을 "유일한 방어선"이라고 적지 마라.** 그 mutation은 red가 되지 않는다 —
   kernel의 승인·소유권 검사가 같은 것을 두 번째로 막는다(정직하게 이미 그렇게 적혀 있다).

---

## 5. 열려 있는 위험 (T4·T5에서 만날 수 있는 것)

| id | 무엇 | 왜 지금 중요한가 |
|---|---|---|
| `C-86` | live worker 세션의 **자격증명 신원이 승인 축 밖**이다(Keychain + `USER`). Codex는 `codexHome`으로 사람이 승인하는데 Claude worker는 ambient다 | T5가 "승인 경계 우회 없음"을 판정할 때 이 축을 빠뜨리면 과대주장이다 |
| `C-87` | `--tools ""`+`--permission-mode default` 조합의 도구 차단이 **표본 1**이다 | 같은 이유 |
| `C-88` | **live 직후 전체 suite가 timeout 민감 테스트에서 흔들린다**(3회 재현 · 직렬 재실행은 매번 clean) | T4·T5에서 live를 돌리면 그 뒤 suite 수치를 **직렬 재실행 값**으로 적어라 |
| `C-81` | `process_cleanup_unconfirmed`(supervisor 관측 실패) **실제 재현 테스트가 없다** | "복구된다"의 잔여 미증명 |
| `B-32` | **닫혔다**(T3) — 다만 그 방식은 "동시 controller를 표현 불가로" 만든 것이다 | 병렬 controller를 요구하는 기능은 이 결정을 먼저 되짚어야 한다 |

전체 목록은 `grep -n '| open |' docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`가 정본이다.

---

## 6. ⚠️ 과금 (앞 세션 실측)

| 무엇 | 과금 |
|---|---|
| offline·mock·fixture·acceptance 전부 | **없음** |
| `claude -p`(live worker · handoff live) | **구독 한도만 · 실결제 $0** |
| Codex live | **구독 경로** — `~/.codex/auth.json`이 `auth_mode: chatgpt`이고 `OPENAI_API_KEY` 없음 |

앞 세션 T3에서 쓴 것: `claude -p` **왕복 11회**(실패 반복 5 + 성공 3 + flag 확인 1 + probe 2).
**실행 전에 사용자에게 알리고 `auth_mode`를 다시 확인하라**(값은 읽지 말고 key 이름·mode만).

live를 돌릴 때 **suite와 동시에 돌리지 마라** — `C-88`이 그 실측이다.

---

## 7. 작업 방식 (그대로 유지)

- **A급·크리티컬은 즉시 수정**(승인·상태 전이 우회 · 데이터 손실 · **거짓 성공 영수증** · 주석·문서·
  커밋 메시지의 **과대주장** · secret 유출). B/C는 대장에 적고 진행.
- **테스트 완화·삭제 금지** · **과대주장 금지**.
- **acceptance를 만들면 mutation으로 red를 확인한다.** 앞 세션에서 mutation이 공허한 단정을 여러 번
  잡았다(가짜 동시 호출 barrier · role 축만 증명하던 프롬프트 검사 · worker 상한이 아니라 kernel
  deadline이 끊고 있던 것).
- **모델 분업**: 맥락·계획·**적대적 read-only 리뷰**는 fresh **Fable 5**(구현자와 다른 세션),
  구현·리비전은 fresh **Opus 5**. 앞 세션 리뷰 3회가 **A급 2건 + B급 8건**을 잡았다 — 그중 하나는
  내 주석의 **거짓 인용**이었다(`src/tools/handoff.ts`는 존재하지 않는다).
- **리뷰어에게 live 실행을 금지시켜라**(구독 소모 + `C-88`).
- **git**: PR 1000줄 이하 분할(소스/dist 분리) · `--delete-branch` 금지 · `git add -A` 금지 ·
  **스택 PR은 위(가장 나중 것)부터 머지**(그것이 앞 것들을 포함하므로 나머지는 자동으로 닫힌다) ·
  `dist/exec/codexCliProvider.js`는 **무관하게 dirty**이니 건드리지 마라(빌드 후 원본으로 되돌린다).

---

## 8. 첫 착수 지점

1. `grep -n '| open |' docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` — 대장 실상.
2. `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`의 **`M10 진행 판정 ③`** 절 — 직전 판정.
3. **T4**: 위 §2 표를 확인만 하고(코드는 이미 있다) 후보 ①/② 중 **사용자에게 물어라**.
4. **T5**: `src/exec/manifestAudit.ts` 읽기 → 두 프로젝트 구조 읽기 → manifest 작성 → 감사 → **결과를
   있는 그대로** 적기(아무것도 못 찾으면 그렇게).
5. 마감: 로드맵에 `M10 진행 판정 ④`(및 완료 판정) 절 · `docs/CONTEXT_SUMMARY.md` 갱신 · 대장 정리.
