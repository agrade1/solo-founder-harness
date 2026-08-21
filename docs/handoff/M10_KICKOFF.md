# M10 KICKOFF — End-to-End Hardening & Release

> 새 세션이 **이 문서 하나로** 착수할 수 있게 쓴 문서다. 작성 2026-08-19(M9 마감 직후).
> 브랜치 `work/m5c-autopilot`. 앞선 판정은 로드맵 **`M9 판정 요약`** 절이 정본이다.

---

## 0. 30초 요약

M9까지 **개발 파이프라인이 실제로 돈다**: Tech Lead DAG → kernel task 물질화 → 병렬 worker가
소유권 분리 아래 동시 구현 → `run-tests`가 실제 테스트 실행 → fresh Codex 리뷰 3종 → 수정 → verify.
**live로 실측했다**(PASS=17, Claude·Codex 둘 다 구독 경로).

M10은 **하드닝과 릴리스**다. 새 기능을 세우는 마일스톤이 아니라 **이미 선 것이 중단·크래시·상한·경합
아래에서도 거짓말하지 않는지**를 증명하는 마일스톤이다. 그래서 M10의 대부분은 **§9.1 대장에 이미
등록된 항목을 닫는 일**이고, 새로 만드는 것은 F3 핸드오프 하나뿐이다.

M9와 결정적으로 다른 점: **M9는 "된다"를 증명했고 M10은 "안 되는 척하지 않는다"를 증명한다.**
그래서 M10에서 가장 위험한 실패는 기능 미완이 아니라 **공허한 게이트**다(§7 위험 1).

---

## 1. 시작 전에 읽을 것 (이것만)

```text
CLAUDE.md                                              # 세션 계약 (작업 방침 포함)
AGENTS.md                                              # 리뷰·병렬·모델 분업 상세
docs/handoff/M10_KICKOFF.md                            # 이 문서
docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md    # §10 M10 절 + `M9 판정 요약` 절 + §9.1 대장
docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md       # F3 절 ← 아래 T4의 설계 정본
docs/CONTEXT_SUMMARY.md                                # 직전 상태 한 눈
```

**로드맵은 위쪽 절이 최신이다.** 충돌 시 위쪽이 현행이며, M3d 이후 오케스트레이션 충돌은 로드맵이 우선한다.

---

## 2. 지금 서 있는 지반 (M9 마감 시점 · 실측)

**baseline**: `test:exec` **601/601** · `test:core` **442/442** · `scripts/acceptance.sh`
**PASS=171 / FAIL=0** · `npx tsc --noEmit` clean. acceptance 마지막 번호는 **Test 21**(M9) →
**M10은 Test 22**를 쓴다.

| 계층 | 상태 | 위치 |
|---|---|---|
| durable SoR · 승인 manifest · autopilot · 계층 spawn · rotation | 완료(M6) | `src/exec/orchestrationKernel.ts` · `spawnRouting.ts` |
| typed operation(3종) · 프로세스 관측 · 정리 확인 · attempt 회계 | 완료(M5c·M9) | `orchestrationKernel.ts` · `typedExecution.ts` |
| research gateway · EvidenceItem · 승인 정적 감사 · 사람 gate | 완료(M7) | `researchGateway.ts` · `manifestAudit.ts` |
| 디자인 계약 · registry inventory · handoff · 리뷰 왕복 | 완료(M8·M9) | `designContract.ts` · `designReviewRoundtrip.ts` |
| **Tech Lead DAG 계약 · 물질화 · 소유권 경합 게이트 · 격리 worktree · F2 가시성** | **완료(M9)** | `taskDag.ts` · `taskDagMaterialize.ts` · `B-29` 게이트 · `git_worktree` kind · `autopilotProgress.ts` |
| **resume/crash recovery · 예산 재시작 · stale lock · 도그푸딩 감사 게이트 · F3 핸드오프** | **없다 — M10이 만든다** | (신규 + 대장 항목) |

**M9가 남긴 "부분" 2건**(로드맵 `M9 판정 요약` 절):
1. **"직렬 로컬 병합"이 이 아키텍처에 매핑되지 않는다**(`C-80`) — worker 산출물이 브랜치가 아니라
   kernel typed-write로 run workspace에 발행되고 worktree는 `--detach`라 브랜치가 없다.
   **M10에서 이것을 "닫으려" 하지 마라** — 닫으려면 worker 산출 경로 자체를 바꾸는 결정이 선행한다.
2. **end-to-end가 `runAutopilot` 무인 loop가 아니다** — M9 live는 스크립트가 단계를 부르는 형태다.
   **이것은 M10 T3의 실질 과제다**(§3 참조).

---

## 3. M10 과업 — 이 순서로 한다

로드맵 §10 M10 절이 스펙 전부다. **여기 없는 기능은 만들지 않는다.**

### T1 — resume / crash recovery (대장 항목을 닫는다)

**새 설계를 짜기 전에 대장을 grep해라.** 관련 항목이 이미 등록돼 있고 각 행에 증거·공수·트리거가 있다.

| 항목 | 무엇 | 왜 M10인가 |
|---|---|---|
| `B-12` | **재시작하면 토큰·경과 회계가 0으로 초기화된다** | 예산 게이트가 재시작으로 우회된다 — **거짓 성공 영수증 부류에 가깝다.** 우선순위 최상 |
| `B-21` | 중단된 batch의 `prepared` task를 autopilot이 스스로 되찾지 못한다 | "중단 후 재개" 완료 조건의 직접 대상 |
| `C-4` | 커밋 중간 크래시 복구 도구 없음(event append 후 state rename 전 사망) | 완료 조건 "결정 유실 없음"의 직접 대상 |
| `C-8` | stale lock 자동 회수·소유자 생존 확인이 없다 | 죽은 소유자의 lock이 run을 영구 차단한다 |
| `C-22` | `CODEX_HOME` 소유 신원이 in-memory라 재시작 후 같은 홈으로 resume 불가 | live 재개 경로 |
| `C-7` | state↔event binding이 **키 없는** digest다 | 손편집 방어의 강도 문제 — 릴리스 게이트에서 판단 |

**착수 시 `grep -n '| open |' docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`로 목록을 다시
확인하라** — 문서가 아니라 grep이 정본이다.

### T2 — 통합 시나리오 (공허하지 않은 게이트)

로드맵: "context rotation/요약 변질/문서 누락/의존성 실패/권한 요청 통합 시나리오."
**각 시나리오는 red-path가 먼저다** — 결함을 심어 놓고 게이트가 잡는지 확인한 뒤 green을 만든다.
M9에서 mutation이 공허한 테스트를 세 번 잡았다(위상 정렬·spawn 회계·C-1). 같은 규율을 쓴다.

### T3 — end-to-end를 `runAutopilot` 무인 loop로 (M9의 "부분"을 닫는다)

M9 live는 **스크립트가 단계를 부르는 형태**다. M10 완료 조건이 "기획→디자인→개발 end-to-end
acceptance 전부 통과"이므로, 그 실행이 **무인 loop 안에서** 일어나야 의미가 있다.
`src/commands/autopilot.ts`의 `runAutopilot`이 그 자리이고, 지금 그 worker는 **정적 offline plan
백엔드**(`startOfflinePlanTurn`)다. 여기가 M10에서 가장 큰 설계 결정이다 — **§4의 유예 항목 1번을
먼저 읽어라**(`B-17` autopilot 전달 루프가 여기 걸려 있다).

### T4 — F3: 문서 완료 → Claude Code 핸드오프 (~~M10의 유일한 신규 기능~~ — **stale**)

> **정정(2026-08-21 · M10 T4 판정 ④)**: "M10의 유일한 신규 기능"은 **사실이 아니었다.** F3는
> **M3b.2/M3c.3b에서 이미 구현·증명됐다**(`src/core/handoff.ts` 562줄 · `harness handoff` ·
> acceptance Test 12 · live 스크립트 2개). T4는 **새 코드 0줄**로 "이미 완료" 판정을 받았고
> 9항목 전수 대조는 로드맵 `M10 진행 판정 ④` 절에 있다. v3 오케스트레이션 run 쪽 미배선만
> `C-89`로 대장에 남았다.

설계 정본은 `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`의 F3 절이다. **경계가 문서에 못 박혀 있다**:

> **headless `execute --apply`가 아니다.** 대화형 Claude Code 세션을 여는 것까지만. 코드 수정 권한은
> Claude Code 자체 permission 시스템에 그대로 남는다.

**그 경계를 넘는 변형은 만들지 마라.** 자동으로 코드를 고치는 경로를 여는 것은 M10 범위가 아니다.

### T5 — 릴리스 게이트: 도그푸딩 + 승인 정적 감사(`C-67`)

로드맵 원문: "도그푸딩하는 실제 프로젝트 2~3개의 승인 manifest를 감사해 '과도하게 넓은 승인'이
실사용에서 실제로 생기는지 확인한다. **감사가 아무것도 못 찾으면 그 사실을 그대로 적는다**(공허한
게이트를 통과로 세지 않는다)."

`manifestAudit.ts`는 M7에서 이미 있다 — **새로 만들지 말고 실제 프로젝트에 돌려라.**

---

## 4. 이미 결정된 설계 — 다시 논의하지 마라

1. **닫힌 enum·닫힌 key 집합.** action·요청 union·operation·worktree action 전부 닫힌 형태다.
   모델·호출자가 argv·경로·권한·예산을 문자열로 고르는 통로를 만들지 않는다.
2. **중앙만이 상태 전이 주체다.** worker/reviewer는 제출할 뿐이다.
3. **리뷰어는 read-only.** Codex sandbox는 `read-only`만 허용(hard deny).
4. **자기 산출물을 자기가 승인하지 않는다.** `designReviewRoundtrip.ts`의 `assertRoundtrip()` **하나**가
   M8·M9 규칙을 다 담는다 — **세 번째 패턴을 만들지 마라.** M10에서 참가자가 늘면 그 함수를 다시 쓴다.
5. **원격 쓰기는 표현 불가로 남는다.** push·fetch·PR/merge·clone은 담을 필드가 없다.
   `worktree add`가 `--detach`인 이유가 그것이다(브랜치명 필드를 만들지 않기 위해).
6. **원문은 파일, 중앙은 포인터.**
7. **사람 gate는 우회 불가.**
8. **`MANAGED_PROCESS_ENV`는 닫혀 있다.** 호출자별 env 오버라이드 표면을 열지 마라(M9 T3③ 리뷰에서
   `GIT_NO_LAZY_FETCH`를 그 상수에 넣은 이유다).

### 유예 항목 — M10에서 판단해야 하는 것

1. **`B-17` autopilot 전달 루프**(회계면은 M9에서 닫혔다). 남은 것은 "수신 task가 inbox를 읽어
   **행동을 바꾼다**"이고, autopilot worker가 **정적 offline plan 백엔드**라 offline에서는 증명할 수
   없다. **T3와 같은 결정에 걸려 있다** — worker 백엔드를 live provider로 바꾸는 결정.
2. `C-76` — DAG 물질화의 mid-loop kernel 거부가 부분 물질화를 남기고 run을 벽돌로 만든다.
   구조적 종결책은 "전 task를 한 `#mutate`로 만드는 API". **resume/recovery와 같은 slice에서 보라.**
3. `C-74` — 소유권 경합을 scheduler에서 직렬화하지 않는다(거부로만 닫혀 있다). fixture 전수 정정이
   선행한다. `C-10`(starvation)과 함께 본다.
4. `C-80` — 위 §2 참조. **닫으려 하지 마라.**

---

## 5. M10 완료 조건 → 증명물

| 완료 조건(로드맵 원문) | 무엇을 만들면 증명되는가 |
|---|---|
| 기획→디자인→개발 end-to-end acceptance 전부 통과 | acceptance **Test 22**가 그 경로를 돌고 각 체크가 **mutation으로 red 확인**된다. T3의 무인 loop 안에서 도는 것이 요점이다 |
| 중단 후 재개 시 **중복 agent/중복 merge/결정 유실 없음** | 실제로 중단시킨 뒤(SIGINT·프로세스 kill·커밋 중간 fault seam) 재개해 durable 상태가 중복도 유실도 없음을 확인. `B-12`·`B-21`·`C-4`가 여기서 닫힌다 |
| hard deny와 milestone approval 경계 **우회 없음** | 우회 시도별 red-path. `manifestAudit`를 실제 프로젝트 manifest에 돌리고 **아무것도 못 찾으면 그렇게 적는다** |

---

## 6. ⚠️ 과금 게이트 (M9에서 실측된 값)

| 무엇 | 과금 | 근거 |
|---|---|---|
| offline·mock·fixture 전부 | **없음** | — |
| Claude worker live(`claude -p`) | **구독 한도 소모 · 실결제 $0** | M8·M9 실측 |
| Codex live(`codex exec`) | **구독 한도 소모** — `~/.codex/auth.json`의 `auth_mode: chatgpt`이고 `OPENAI_API_KEY`가 null이다 | M9 T5 실측(값은 읽지 않고 key 이름·mode만 확인) |

**M9에서 이 게이트가 해소됐다** — 둘 다 구독 경로이므로 KICKOFF M9 §6이 걱정한 "실결제 가능"
시나리오는 이 환경에서 성립하지 않는다. **그래도 live 실행 전에 사용자에게 알리고, 인증 방식이
바뀌었을 수 있으니 `auth_mode`를 다시 확인하라.**

도그푸딩(T5)은 **사용자의 실제 프로젝트**를 건드린다 — 읽기만 하더라도 **어느 프로젝트인지 먼저
물어라.** 승인 manifest 감사는 읽기 전용이지만 대상 선택은 사용자의 결정이다.

---

## 6.5 M10 범위 경계

| 항목 | 어디로 | 왜 M10이 아닌가 |
|---|---|---|
| `F1` cross-project 학습 · Figma read · stack별 QA | **§11 선택적 확장** | 조건 미충족 |
| 브랜치 기반 병합(`mergeCoordinator` 배선) | **미정 — `C-80`** | worker 산출 경로를 바꾸는 결정이 선행한다 |
| headless 자동 코드 수정(`execute --apply`) | **금지** | F3 설계 문서가 그 경계를 명시했다 |
| 배포·DB 마이그레이션 적용·live 결제 | **금지 — 배치 없음** | hard deny |
| 외부 Claude Code 하네스 팩(ECC·gstack·oh-my-claudecode) | **금지** | 2026-08-12 판정 — durable SoR·승인 manifest가 없는 층이라 역할 어휘가 둘이 된다 |

---

## 7. 위험 4건

1. **공허한 게이트.** M10은 "복구된다"를 주장하는 마일스톤이라 **테스트가 실제로 중단시키지 않으면
   전부 거짓이 된다.** M9에서 mutation이 공허한 테스트를 세 번 잡았다(위상 정렬이 사전순과 우연히
   일치 · spawn 회계를 테스트가 직접 셈 · O_NOFOLLOW 판별 불가). **acceptance를 만들면 반드시
   mutation으로 red를 확인하라.**
2. **재시작 경로가 예산·승인 게이트를 우회하는 것.** `B-12`가 정확히 그 부류다 — 재시작하면 회계가
   0이 된다. 이것을 닫기 전에 "재개된다"고 적으면 그것이 과대주장이다.
3. **live가 잡는 결함을 offline만으로 놓치는 것.** M9 live가 **4건**을 잡았고 전부 offline에서는
   보이지 않았다(도구 호출 텍스트 발행 · PATH에 없는 node · entrypoint 형식 · 정규식 sanity 게이트).
   **가능하면 실제 경로를 한 번은 밟아라.**
4. **범위 폭발.** M10은 "하드닝"이라 무한히 커진다. §5 표에 없는 것은 대장에 적고 넘긴다.

---

## 8. 작업 방침 (M5~M9에서 확정 — 그대로 따른다)

- **배송 우선(MVP-first)**: A급·크리티컬은 즉시 수정, B/C는 대장에 기록하고 보류.
- **A급에 포함**: 승인·인증·상태 전이 우회 · 데이터 손실 · **거짓 성공 영수증** · 문서·주석·커밋
  메시지의 **과대주장** · secret 유출.
- **테스트 완화·삭제 금지** · **과대주장 금지** — 속도와 교환하지 않는다.
- **acceptance를 만들면 mutation으로 red가 되는지 확인한다.**
- **모델 분업**: 맥락·계획·적대적 read-only 리뷰 = fresh Fable 5 / 구현·리비전·통합 = fresh Opus 5.
  **자기 코드를 자기가 승인하지 않는다.** M9에서 리뷰 6회가 **A급 3건**을 잡았다(부분 물질화와 그
  과대주장 · 실패한 worktree 명령의 거짓 성공 영수증 · 존재하지 않는 필드 검사 주장).
- **병렬**: 파일 소유권이 겹치지 않으면 격리 worktree. 공유 schema/API·통합·최종 전체 테스트는 직렬.
  **테스트 suite를 live와 동시에 돌리지 마라** — M9에서 그 조합이 5건을 깨뜨렸고 직렬 재실행은
  clean이었다(배타 자원 규율의 실측 사례).
- **git**: PR은 변경 1000줄 이하로 분할(소스/dist 분리하면 대개 맞는다).
  **머지에 `--delete-branch` 쓰지 마라.** 브랜치 삭제는 전부 머지한 뒤 마지막에 한 번에.
  `git add -A` 금지. `dist/exec/codexCliProvider.js`는 M5~M9와 무관하게 dirty이니 건드리지 마라.
  **스택 PR은 위(가장 나중 것)부터 머지하라** — M9에서 아래부터 머지했더니 중간 base 브랜치에만
  착지해 별도 승격 PR이 필요했다.

---

## 9. 첫 착수 지점

1. `grep -n '| open |' docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` — 대장 열린 항목 전수.
   T1은 그중 `B-12`·`B-21`·`C-4`·`C-8`부터다.
2. `src/exec/orchestrationStore.ts` — commit/rename 순서와 `setCommitFaultHook`(`C-36`).
   **크래시 복구 테스트가 쓸 seam이 이미 있다.**
3. `src/commands/autopilot.ts` `runAutopilot` — T3의 자리. 지금 worker는 `startOfflinePlanTurn`이다.
4. `src/exec/manifestAudit.ts` — T5에서 **재사용**한다(새로 만들지 않는다).
5. `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` F3 절 — T4 설계 정본.
6. `scripts/m9-live-pipeline.mjs` — live 배선 선례. M9가 잡은 4건의 함정이 주석에 적혀 있다.

---

## 10. 완료 판정 기준

- §5 표의 각 완료 조건이 **어디서 증명됐는지** 로드맵 `M10 진행/완료 판정` 절에 적혔고,
  **미증명 항목도 같은 무게로** 적혔다.
- acceptance **Test 22**의 각 체크가 **mutation으로 red 확인**됐다.
- `scripts/acceptance.sh` 전체 green(현재 171 + M10 증가분).
- 전체 suite **직렬** 1회: `test:exec` · `test:core` · acceptance · `tsc --noEmit`.
- 대장에 M10에서 닫은 항목과 **새로 등록한 항목**이 전부 기록됐다.
- **live를 돌렸다면** 그 사실과 비용·횟수를, 돌리지 않았다면 **미증명**을 명시했다.
- `docs/CONTEXT_SUMMARY.md`가 갱신됐다.
