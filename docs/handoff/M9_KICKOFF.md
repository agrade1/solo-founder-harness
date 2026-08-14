# M9 KICKOFF — Development Pipeline

> 새 세션이 **이 문서 하나로** 착수할 수 있게 쓴 문서다. 작성 2026-08-13(M8 완료 직후).
> 브랜치 `work/m5c-autopilot`. 앞선 판정은 로드맵 `M8 진행 판정` 절이 정본이다.

---

## 0. 30초 요약

M8까지 **kernel(SoR) · 승인 manifest · autopilot · 계층 spawn · research gateway · EvidenceItem ·
승인 정적 감사 · 사람 gate · 디자인 산출물 계약/handoff**가 섰다. M9는 **아이디어 → 로컬 동작 MVP →
전체 테스트 → 최종 report를 단일 실행으로** 잇는 첫 마일스톤이다: Tech Lead가 task DAG를 만들고,
Claude worker가 **격리 worktree에서 병렬로 구현**하고, fresh Codex가 code/security/test 리뷰를 하고,
fresh Claude가 수정, fresh Codex가 verify, 병합은 **직렬**이다.

**M9는 선결 4건 없이는 스펙상 닫히지 않는다**(로드맵 M9 절이 그렇게 못 박았다). 그 4건이 §3이고,
**T1은 그것부터**다. 특히 `run_process` action enum은 **하드 게이트**다 — 테스트를 실행할 타입이 없으면
"test review"를 표현할 수 없다.

---

## 1. 시작 전에 읽을 것 (이것만)

```text
CLAUDE.md                                              # 세션 계약 (작업 방침 포함)
AGENTS.md                                              # 리뷰·병렬·모델 분업 상세
docs/handoff/M9_KICKOFF.md                             # 이 문서
docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md    # §10 M9 절 + 선결 4건 + `M8 진행 판정` 절 + §9.1 대장
docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md       # F2 절(진행률·ETA) ← 선결 4번의 설계 정본
docs/CONTEXT_SUMMARY.md                                # 직전 상태 한 눈
```

**로드맵은 위쪽 절이 최신이다.** 충돌 시 위쪽이 현행이며, M3d 이후 오케스트레이션 충돌은 로드맵이 우선한다.

---

## 2. 지금 서 있는 지반 (M8 완료 시점 · 실측)

| 계층 | 상태 | 위치 |
|---|---|---|
| durable SoR · 승인 manifest · autopilot · 계층 spawn · context bundle · rotation | 완료(M6) | `src/exec/orchestrationKernel.ts` · `spawnRouting.ts` · `contextBundle.ts` |
| typed operation · 프로세스 관측 · 정리 확인 · attempt 회계 | 완료(M5c) | `orchestrationKernel.ts` · `typedExecution.ts` · `stableController.ts` |
| research gateway · `EvidenceItem` · 승인 정적 감사 · 도구 예산 상한 · 사람 gate | 완료(M7) | `researchGateway.ts` · `evidenceStore.ts` · `manifestAudit.ts` · `profiles.ts` · kernel |
| 디자인 산출물 계약(fail-closed) · registry inventory · handoff 계약 · review 왕복 계약 | 완료(M8) | `src/core/designContract.ts` · `src/tools/registryInventory.ts` · `src/exec/designHandoff.ts` · `src/exec/designReviewRoundtrip.ts` |
| shadcn filtered read proxy(live 통과) | 완료(M3c · M8에서 재사용) | `src/tools/shadcnRead*.ts` · profile `handoff-shadcn-readonly` |
| Codex provider(read-only sandbox · xhigh · ephemeral) | 완료(M5a) | `src/exec/codexCliProvider.ts` · manifest `executionAuthority.codex` |
| **task DAG 생성 · 병렬 worktree 구현 · code/security/test 리뷰 왕복** | **없다 — M9가 만든다** | (신규) |

**실측 baseline**(M8 판정 절): `test:exec` **549/549** · `test:core` **442/442** ·
`scripts/acceptance.sh` **PASS=154 / FAIL=0** · `npx tsc --noEmit` clean.
acceptance 마지막 번호는 **Test 20**(M8)다 — **M9는 Test 21**을 쓴다.

**M8이 남긴 것**: live는 design worker만 돌렸다. **fresh Codex 리뷰의 실제 프로세스 왕복은 미증명**이고
계약 층만 증명됐다(`designReviewRoundtrip.ts`). M9는 code/security/test 리뷰를 Codex로 돌리므로
**이 미증명이 M9에서 실측 대상이 된다**. Codex live는 인증 방식에 따라 **실결제 가능성**이 있어
§6의 과금 게이트에 걸린다.

---

## 3. 선결 4건 — T1에서 먼저 닫는다 (로드맵 M9 절 원문 · 실측 확인 포함)

| # | 항목 | 실측 현재 상태 | 무엇이 필요한가 |
|---|---|---|---|
| 1 | **`run_process` action enum 확장 (하드 게이트)** | `orchestrationTypes.ts:802` `CONTROLLER_ACTIONS = ["validate-plan"]` **하나이고 읽기 전용** | 테스트 실행을 표현하는 action 추가. **닫힌 enum 유지** · action마다 정확한 key 집합 · argv/shell 문자열을 모델이 고르는 통로를 만들지 않는다(승인 레코드가 실행 파일·argv·timeout을 정한다 — `validate-plan`의 action 전용 입력 패턴이 본보기) |
| 2 | **`B-16` 신규 파일 발행** | `orchestrationKernel.ts` `write_publish_unsupported` — 부재 대상 발행이 fail-closed. 승인된 **기존 파일 교체만** 가능 | worker가 새 파일을 만드는 경로. 승인 manifest의 ownership·writableRoots 집행을 유지한 채 신규 경로 발행을 연다 |
| 3 | **`B-17` inbox 전달 소비(ack)** | kernel API `acknowledgeDelivery`는 **있다**(`orchestrationKernel.ts:2848`, durable event `delivery_acknowledged`) · `stableController.ts:923`이 호출한다. **autopilot 경로의 소비는 확인되지 않았다**(M6 판정: "autopilot은 여전히 전달을 ack하지 않는다") — **착수 시 실측으로 판정하라** | "fresh Codex 검토 → fresh Claude 수정"의 자동 전달이 성립하려면 수신 task가 inbox를 실제로 읽고 행동을 바꿔야 한다 |
| 4 | **F2 실행 가시성(진행률·스피너·ETA · 신규 의존성 0)** | v1 계층은 **이미 있다** — `src/core/progress.ts`(`RunEvent`·`ProgressReporter`·TTY/비-TTY 렌더러) + `progress.test.ts`. **exec/autopilot 계층의 가시성은 없다**(`autopilotTypes.ts`의 `progress` 이벤트는 durable 회계용이고 사람용 표시가 아니다) | **v1 `progress.ts`를 재사용**해 exec/autopilot 진행을 사람에게 보이게 한다. 새 렌더러·새 의존성을 만들지 않는다. F1의 데이터 기반(step 타임스탬프)도 여기서 생긴다 |

**§9.1 대장에서 M9 기한·트리거를 가진 열린 항목**(grep 실측):
`C-70`(M8 신규 — design 계약이 v1 `runWorkflow` 경로에 미배선, 담당 "M9 착수 세션") ·
`C-10`(scheduler priority/fairness/starvation — 트리거 "M5/M9 worker 병렬에서 starvation 실측될 때") ·
`B-16`·`B-17`(위 표) · `C-68`(attempt 신원 재사용이 직전 한 칸까지 — 효과 경로는 이미 닫혀 있고 잔여는 감사 추적성).
**착수 시 이 목록을 다시 grep해서 확인하라** — 문서가 아니라 grep이 정본이다.

---

## 4. 이미 결정된 설계 — 다시 논의하지 마라

1. **닫힌 enum·닫힌 key 집합.** action·요청 union·operation은 전부 닫힌 형태다. 모델이 argv·경로·권한·
   예산을 문자열로 고르는 통로를 만들지 않는다(M5c A3/3A 리비전이 그 통로를 삭제했다).
2. **중앙만이 상태 전이 주체다.** worker/reviewer는 제출할 뿐이고 남의 task 상태·mailbox를 바꾸는 API는
   없다. 병렬 worker를 더해도 이 규칙은 그대로다.
3. **리뷰어는 read-only.** Codex sandbox는 `read-only`만 허용이다(`types.ts` `CodexSessionOptions` —
   `workspace-write`는 hard deny). 리뷰가 파일을 고치는 경로를 만들지 않는다.
4. **자기 산출물을 자기가 승인하지 않는다.** fresh reviewer/revision worker는 kernel이 이미 강제한다
   (`assertFresh` · `review_result_missing` · `subject_not_completed`). provider/세션 층 계약은
   `designReviewRoundtrip.ts` 패턴을 재사용한다 — **두 번째 패턴을 만들지 마라.**
5. **병합은 직렬.** 병렬은 격리 worktree + 파일 소유권 분리가 성립할 때만이고, 통합·공유 schema 변경·
   최종 전체 테스트·배타 자원 테스트는 직렬이다(AGENTS.md · 로드맵 §7 병렬 계약).
6. **원문은 파일, 중앙은 포인터.** 테스트 출력·리뷰 원문도 같은 규칙이다(`evidenceStore` 계약 재사용).
   kernel state·프롬프트에 원문을 싣지 않는다.
7. **사람 gate는 우회 불가.** 답 없는 `decision_request`를 남긴 task는 완료할 수 없다(M7).

---

## 5. M9 완료 조건 → 증명물

로드맵 §10 M9 절이 스펙 전부다. **여기 없는 기능은 만들지 않는다.**

| 완료 조건(로드맵 원문) | 무엇을 만들면 증명되는가 |
|---|---|
| Tech Lead가 task DAG/ownership/API contract 생성 | DAG·ownership·contract가 **닫힌 형태**로 생성되고 kernel이 검증(순환·미상 의존·소유권 충돌 → fail-closed). 각 검증 제거 mutation → red |
| Claude Code Opus worker 병렬 worktree 구현 | 격리 worktree에서 2개 이상 worker가 파일 소유권 분리 아래 동시 진행하고, 소유권 밖 쓰기가 거부된다. `B-16` 신규 파일 발행이 이 경로에서 동작 |
| fresh Codex code/security/test review | 리뷰 3종이 fresh Codex read-only 세션으로 돌고, **test review가 실제로 테스트를 실행**한다(선결 1의 action). 같은 세션·같은 task 재사용 거부 red-path |
| fresh Claude revise · fresh Codex verify · 직렬 로컬 병합 | 리뷰→수정→verify 왕복이 서로 다른 fresh 세션으로 배선되고, 병합은 직렬이며 실패 시 fail-closed |
| **완료: 아이디어에서 로컬 동작 MVP와 전체 테스트·최종 report까지 단일 실행** | 작은 fixture repo(M5d 선례 — self-hosting은 큰 레포로 하지 않는다)에서 end-to-end 1회. 최종 report에 **증명/미증명이 같은 무게로** 남는다 |

---

## 6. ⚠️ 과금 게이트

| 무엇 | 과금 | 언제 |
|---|---|---|
| 선결 4건 · DAG/ownership 계약 · 병렬 worktree 배선 · 리뷰 왕복 계약 — offline·mock·fixture | **없음** | 지금 바로 |
| Claude worker live(`claude -p`) | **구독 한도 소모 · 실결제 $0**(M8 실측 · `@anthropic-ai/sdk` API 키 경로는 쓰지 않는다) | end-to-end live |
| **Codex live(code/security/test review · verify)** | **인증 방식에 따라 실결제 가능** — 사용자의 Codex 인증이 구독인지 API 키인지 **먼저 확인**해야 한다. M8에서 이 이유로 Codex live를 제외했다 | **사용자 승인 전에는 실행 금지** |

**따라서**: offline을 전부 세운 뒤 live를 두 단계로 나눈다 — ⓐ Claude worker live(구독) ⓑ Codex live
(승인 필요). ⓑ를 못 돌리면 로드맵에 **"미증명 — Codex live 미실행"** 으로 적는다. 거짓 완료 선언보다 낫다.

---

## 6.5 M9 범위 경계

| 항목 | 어디로 | 왜 M9가 아닌가 |
|---|---|---|
| `F3` 문서 완료 → Claude Code 핸드오프 | **M10** | 문서 파이프라인이 전부 선 뒤 |
| resume/crash recovery · 예산 · 도그푸딩 감사 게이트 | **M10** | 하드닝 |
| `F1` cross-project 학습 · Figma read · stack별 QA | **§11 선택적 확장** | 조건 미충족 |
| 배포·DB 마이그레이션 적용·live 결제 | **금지 — 배치 없음** | capability deny(하네스 규율) |
| 화면 렌더링·시각 diff·컴포넌트 코드 생성 | **금지 — M8에서 이미 범위 밖 판정** | 범위 폭발 |

---

## 7. 위험 4건

1. **병렬 worker의 파일 충돌.** 격리 worktree + 소유권 분리가 **성립하는지 실측**하지 않고 병렬로 돌리면
   조용한 덮어쓰기가 난다. 소유권 밖 쓰기 거부를 red-path로 먼저 고정한 뒤 병렬을 켠다.
2. **`run_process` enum이 실행 통로로 새는 것.** 테스트 실행을 열면서 argv·shell을 모델이 고르게 하면
   M5c가 삭제한 구멍이 되살아난다. 승인 레코드가 실행 파일·argv·timeout을 정하고 enum은 닫힌 채 남아야 한다.
3. **거짓 성공 영수증.** 테스트를 실행했다는 기록과 실제 종료코드가 어긋나면 그것이 곧 A급이다.
   테스트 실패가 "완료"로 덮이지 않는지 red-path로 고정한다(M5c `operation_pending_unreconciled` 패턴).
4. **범위 폭발.** M9는 "개발 파이프라인"이라 무한히 커진다. §5 표에 없는 것(CI 연동·다중 언어 스택·
   배포·성능 튜닝)은 만들지 않고 대장에 적고 넘긴다.

---

## 8. 작업 방침 (M5~M8에서 확정 — 그대로 따른다)

- **배송 우선(MVP-first)**: A급·크리티컬은 즉시 수정, B/C는 대장에 기록하고 보류. 진행을 멈추지 않는다.
- **A급에 포함**: 승인·인증·상태 전이 우회 · 데이터 손실 · **거짓 성공 영수증** · 문서·주석·커밋 메시지의
  과대주장 · secret 유출.
- **테스트 완화·삭제 금지** · **과대주장 금지** — 속도와 교환하지 않는다.
- **acceptance를 만들면 mutation으로 red가 되는지 확인한다.** M6에서 2건, M7에서 1건, M8에서 3건을
  실제로 잡았다(M8은 **live 첫 호출**이 잡았다 — 가능하면 실제 경로를 한 번은 밟아라).
- **모델 분업**: 맥락·계획·적대적 read-only 리뷰 = fresh Fable 5 / 구현·리비전·통합 = fresh Opus 5.
  code/security/test review는 fresh Codex(로드맵 M9 절). 자기 산출물을 자기가 승인하지 않는다.
- **병렬**: 파일 소유권이 겹치지 않으면 격리 worktree. 공유 schema/API·통합·최종 전체 테스트는 직렬.
- **git**: issue 1건 → PR은 변경 1000줄 이하 분할(소스/dist 분리하면 대개 맞는다) → 머지.
  **머지에 `--delete-branch` 쓰지 마라**(스택 PR의 base가 사라지면 뒤 PR이 자동 close된다 — M7에서 겪음).
  브랜치 삭제는 전부 머지한 뒤 마지막에 한 번에. `git add -A` 금지.
  `dist/exec/codexCliProvider.js`는 M7·M8과 무관하게 dirty이니 건드리지 마라.

---

## 9. 첫 착수 지점 (T1 = 선결 4건)

1. `src/exec/orchestrationTypes.ts:802` `CONTROLLER_ACTIONS` + 그 아래 action 전용 입력 계약 —
   확장의 형태를 여기서 읽는다(새 패턴 금지).
2. `src/exec/orchestrationKernel.ts` `write_publish_unsupported` 주변 — `B-16`이 무엇을 막고 있는지.
3. `acknowledgeDelivery`(kernel) ↔ autopilot 경로 — **`B-17`의 실제 잔여가 무엇인지 grep으로 판정**하고
   근거를 문서에 남긴다(kernel API는 이미 있다).
4. `src/core/progress.ts` — F2를 **재사용**할 표면. 새 렌더러를 만들지 않는다.
5. `src/exec/designReviewRoundtrip.ts` — 리뷰 왕복 계약의 기존 패턴(M9 리뷰 3종에 재사용).

---

## 10. 완료 판정 기준

- §5 표의 각 완료 조건이 **어디서 증명됐는지** 로드맵 M9 절에 적혔고, **미증명 항목도 같은 무게로** 적혔다.
- acceptance **Test 21**의 각 체크가 **mutation으로 red 확인**됐다.
- `scripts/acceptance.sh` 전체 green(현재 154 + M9 증가분).
- 전체 suite 직렬 1회: `test:exec` · `test:core` · acceptance · `tsc --noEmit`.
- 대장에 M9에서 닫은 항목(`B-16`·`B-17` 등)과 **새로 등록한 항목**이 전부 기록됐다.
- **live를 돌렸다면** 그 사실과 비용·횟수를(Claude 구독 / Codex 실결제 여부 구분), 돌리지 않았다면
  **미증명**을 명시했다.
