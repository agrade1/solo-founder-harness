# M6 KICKOFF — Hierarchical Orchestrator + Fresh Context Rotation

> 새 세션이 **이 문서 하나로** 착수할 수 있게 쓴 문서다. 작성 2026-08-11(M5 완료 직후).
> 계획 수립: fresh Fable 5. 기준 커밋 `9291946` · 브랜치 `work/m5c-autopilot`.

---

## 0. 30초 요약

M5까지 **kernel(SoR) · 승인 manifest · typed execution · autopilot loop · live provider**가 전부 섰다.
M6에서 진짜 새로 만들 것은 **세 가지뿐**이다:

1. **agent 출력 → kernel spawn/message 배선** (지금은 autopilot이 `requestSpawn`을 부르지 않는다)
2. **context bundle** (durable state만으로 재구성되는 순수 파생물)
3. **coordinator rotation + 등가성 증명** (교체 전후 task graph·결정·artifact hash 동일)

registry·depth/count 게이트·scheduler·중앙 경유 routing·`assertFresh`는 **이미 있다. 다시 만들지 마라.**

---

## 1. 시작 전에 읽을 것 (이것만)

```text
CLAUDE.md                                   # 세션 계약 (작업 방침 포함)
AGENTS.md                                   # 리뷰·병렬·모델 분업 상세
docs/handoff/M6_KICKOFF.md                  # 이 문서
docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md   # §10 M6 절 + §9.1 대장(위쪽이 최신)
docs/CONTEXT_SUMMARY.md                     # 직전 상태 한 눈
```

**로드맵은 위쪽 절이 최신이다** — 아래로 내려갈수록 과거 기록이다. 충돌 시 위쪽(최신 절)이 현행이다.

`.claude/skills/harness-dev/SKILL.md`는 세션 시작 시 자동 로드된다.

---

## 2. 지금 서 있는 지반 (M5 완료 시점)

| 계층 | 상태 | 위치 |
|---|---|---|
| durable SoR (state·event chain·revision·hash) | 완료 | `src/exec/orchestrationKernel.ts` (~5000행) |
| 7 specialist registry · 메시지 10종 · 중앙 경유 routing | 완료(M4c) | `SPECIALIST_ROLES` · `deliverTo` · `resolveRecipientTask` |
| `requestSpawn` + depth/count 게이트 | 완료 | `requestSpawn` · `assertSpawnLimits` · `LIMITS.maxDepth`=3 |
| scheduler + 배타 resource class | 완료 | `selectSchedulable` · `RESOURCE_HOLDING_STATES` |
| dependency-aware ready 승격 | 완료 | dependsOn 전부 completed → ready |
| 승인 manifest 게이트 | 완료 | `ownershipByTask` · `operationAuthorityByTask` · `writableRoots` · 예산 |
| autopilot loop (**사실상 현재의 Coordinator**) | 완료 | `src/commands/autopilot.ts` (~830행) |
| typed execution | 부분 | write는 **승인된 기존 파일 교체만**(`B-16` 잔여) · `run_process` action은 읽기 전용 `validate-plan` 하나 |
| live provider | 1회 검증 | `CodexCliProvider` — 2026-08-11 첫 live 성공(in 13,049 / out 5) |
| task brief 생성 | 전신 있음 | `src/exec/briefGenerator.ts` (~100행) — context bundle의 출발점 |

**실측 baseline**: `test:exec` 514/514 · `test:core` 402/402 · `scripts/acceptance.sh` PASS=108 / FAIL=0.

**미확인(착수 시 직접 확인할 것)**: autopilot이 agent 출력의 `spawn_request`를 kernel에 배선하는지
(grep상 autopilot에 spawn 언급 없음 → **미배선으로 추정**) · coordinator 자체의 fresh-session 강제 여부.

---

## 3. M6 완료 조건 → 증명물

로드맵 §10 M6 절이 스펙 전부다. **여기 없는 기능은 만들지 않는다.**

| 완료 조건 | 무엇을 만들면 증명되는가 |
|---|---|
| ① parent→child→parent · child→orchestrator→sibling 전달 | **autopilot 경유** end-to-end 테스트(kernel 단위 테스트가 아니다): provider가 `spawn_request`·`deliverTo`를 emit → kernel `requestSpawn`/전달 API 경유 → child 결과가 parent inbox로, sibling inbox로 도착 |
| ② child가 직접 spawn/state 변경 불가 | (a) typed action enum에 spawn류 부재 고정 (b) child가 state 파일에 직접 write 시도 → fail-closed 영수증 (c) **mutation**: autopilot의 spawn 게이트 호출을 제거하면 red |
| ③ Coordinator 교체 전후 동일 | `snapshotDigest()` 3종(graph·decision·artifact) 을 교체 전 기록 → 프로세스 종료 → 재기동 `open()` → 재계산 → **일치**. 추가로 교체 후 끝까지 진행한 최종 산출물 hash가 무교체 대조 run과 동일 |

---

## 4. Task 분해 (6개)

### T1 — `B-19`/`C-44` 선결 **(최우선·직렬)**
- **왜 먼저**: 대장 기한이 "**M6 spawn 계층 착수 전**"이고, M6가 fan-out을 늘리는 마일스톤이다.
- 목표: `LIMITS.maxTasksPerRun`이 **task 상한과 프로세스 상한 양쪽에 쓰이는 것**을 전용 상수로 분리
  (`maxProcessesPerRun`). `C-44`의 unreachable depth backstop은 **주석으로 명시만**(state 위조 harness 신설은 과잉).
- 파일: `orchestrationKernel.ts`(`assertSpawnLimits` ~785행, task 상한 검사 ~4751행) + 그 테스트 + 대장.
- 완료: 두 상수를 **각각** 바꾸는 mutation에 **각자의** 테스트가 red. 대장 `B-19`·`C-44` fixed 전환.

### T2 — spawn/message 배선 (agent 출력 → kernel)
- 목표: autopilot turn 결과에서 `spawn_request`·`deliverTo`를 파싱해 **기존 kernel API**로 전달.
  child는 **요청만** 하고, 승인·생성은 orchestrator가 kernel 게이트를 통과시킨다.
- 파일: `src/commands/autopilot.ts` · `src/exec/autopilotTypes.ts` · mock provider · `autopilot.test.ts`.
  - 위험 완화: 배선 로직은 별 모듈(예: `spawnRouting.ts`)로 빼되 **신규 추상화는 최소**.
- 완료: 완료 조건 ①② 테스트 green + 게이트 제거 mutation red.
- 의존: T1. **병렬 불가**(T3와 `autopilot.ts` 공유).

### T3 — context bundle
- 목표: `buildContextBundle(state, taskId)` **순수 함수**. 입력은 **durable state만**(프로세스 메모리 금지).
  내용: task 스펙 + `dependsOn` 각 task의 `resultSummary` + artifact 포인터(sha256) + 미확인 inbox route.
  **별도 저장 포맷을 만들지 않는다** — 파생물은 SoR이 아니다.
- 파일: `src/exec/briefGenerator.ts`(+test) · `autopilot.ts` 주입 지점.
- 완료: 같은 revision에서 2회 생성 → **byte-identical**(결정성 테스트).
- 의존: T2. 직렬(`autopilot.ts` 공유).

### T4 — coordinator rotation + 등가성 다이제스트
- 목표: kernel에 `snapshotDigest()` 추가 — `{ graphHash, decisionHash, artifactHash }`.
  - `graphHash` = sha256(정렬된 `[taskId, state, dependsOn, depth, parentId]`)
  - `decisionHash` = sha256(message index 정규화 직렬화)
  - `artifactHash` = sha256(정렬된 `[path, revision, sha256]`)
  - **시각 필드는 넣지 않는다**(넣으면 교체 전후가 절대 같을 수 없다).
- rotation 자체는 신규 코드가 거의 없다 — **기존 durable 재개(`B-21` 되찾기 포함)가 이미 그것**이며,
  이 task의 중심은 그것을 **증명**하는 것이다.
- 파일: `orchestrationKernel.ts`(digest 함수) · rotation 테스트.
- 완료: ③ 테스트 + mutation(교체 후 task 하나의 state를 위조 → 다이제스트 불일치로 red).
- 의존: T1. **T2와 병렬 가능** — digest는 읽기 전용 함수이고 `assertSpawnLimits` 근처를 안 건드리면
  파일 소유권이 분리된다. 겹치면 **직렬로 전환**한다.

### T5 — fresh-session 강제 확장
- 목표: reviewer·revision worker에 이미 있는 `assertFresh`(~4704행)를 worker 일반·coordinator로 확장.
  - (a) `startPreparedTask` 경로에서 세션 재사용 불가 보장 — **attempt마다 새 세션 id가 발급되는지 미확인**.
    확인 후 **부족분만** 만든다.
  - (b) coordinator 재기동 시 이전 in-memory 컨텍스트를 이어받을 수단이 없음을 테스트로 고정.
- 파일: `orchestrationKernel.ts` 또는 `sessionRunner.ts`(+test).
- 완료: 비-fresh 세션 재사용 시도가 red-path.
- 의존: T4. 직렬(kernel 공유).

### T6 — acceptance + mutation 확인 + 대장 갱신 **(최종·직렬)**
- 목표: `scripts/acceptance.sh`에 **Test 18**(M6 ①②③) 추가 · 각 체크를 **mutation으로 red 확인** ·
  전체 suite 1회 · 로드맵 M6 절과 대장 갱신 · `B-27` 절차 체크 1줄(승인 문서에 wrapper 경로 금지).
- 의존: T2~T5 전부.

**병렬 요약**: `T1` → (`T2`→`T3` 직렬 트랙) ∥ (`T4`) → `T5` → `T6`.

---

## 5. 유예 항목 판정 (M6 범위 안/밖)

| 항목 | 판정 | 근거 |
|---|---|---|
| `B-19` | **안** — T1 | 기한이 "M6 spawn 계층 착수 전"이고 M6가 fan-out을 늘린다 |
| `C-44` | **안** — T1(주석만) | 같은 기한. harness 신설은 과잉 |
| `C-15`(run별 registry) | **밖** | M6 스펙에 요구 없음 — 트리거 미발화 |
| `B-27`(wrapper 승인 함정) | **밖**(절차만) | 코드 아님. T6 문서 단계에서 체크 1줄 |
| `B-11`·`B-12`·`B-13`·`B-17`·`B-18`·`B-20` | **밖** | M6 스펙 ①②③과 무관 → 배송 우선 방침대로 보류. T6에서 대장 재확인 1회 |

---

## 6. 위험 3건

1. **`autopilot.ts` 비대화** — T2+T3이 같은 파일에 얹힌다. 배선은 별 모듈로 빼되 추상화는 최소.
2. **다이제스트 정규화 실수** — 직렬화 순서·시각 필드 포함 여부가 흔들리면 ③이 **공허한 체크**가 된다.
   → mutation red 확인 **필수**.
3. **T5의 미확인 영역** — 세션 재사용 방지가 이미 충분하면 T5는 테스트 고정만으로 축소. 착수 시 판정.

---

## 7. 작업 방침 (M5에서 확정 — 그대로 따른다)

- **배송 우선(MVP-first)**: 기능 전체를 먼저 세우고 개선은 그 다음. **A급·크리티컬은 즉시 수정**,
  **B/C는 대장에 기록하고 보류**하며 진행을 멈추지 않는다.
- **A급에 포함되는 것**: 승인·인증·상태 전이 우회 · 데이터 손실 · 거짓 성공 영수증 ·
  되돌리기 어려운 아키텍처 결정 · **문서·주석·커밋 메시지의 과대주장**.
- **테스트 완화·삭제 금지** · **과대주장 금지** — 속도와 교환하지 않는다.
- **acceptance를 만들면 mutation으로 red가 되는지 확인한다.** M5에서 공허한 체크로 A급을 세 번 맞았다
  (항등식 예산 체크 · 구조적 상시 green · 측정값보다 넓은 라벨). 이 절차는 그 대가로 얻은 것이다.
- **모델 분업**: 맥락·계획·**적대적 read-only 리뷰** = fresh **Fable 5** / 구현·리비전·통합 = fresh **Opus 5**.
  자기 코드를 자기가 승인하지 않는다. 리뷰 프롬프트에 **깨야 할 지점**을 명시한다.
- **병렬**: 파일 소유권이 겹치지 않으면 격리 worktree. 공유 schema/API·통합·상태 마이그레이션·
  최종 전체 테스트·배타 자원 테스트는 **직렬**.
- **live는 과금**이다. M6는 offline+mock으로 ①②③ 증명 가능하므로 **live 실행 계획 없음**.
  필요해지면 별도 승인. probe(`scripts/m5-live-probe.mjs`)는 `acceptance.sh`에 등록하지 않는다.

---

## 8. 첫 착수 지점 (T1)

1. `src/exec/orchestrationKernel.ts` — `assertSpawnLimits`(~785행)와 `LIMITS` 정의, task 상한 검사(~4751행).
   **두 검사가 같은 상수를 쓰는 지점**을 먼저 눈으로 확인한다.
2. `src/exec/orchestrationKernel.test.ts` — `process_spawn_limit_exceeded` · task 상한 기존 테스트.
3. 로드맵 §9.1의 `B-19`·`C-44` 행 — fixed 전환 시 갱신 근거.

---

## 9. 완료 판정 기준

- 완료 조건 ①②③ 각각의 acceptance가 **mutation으로 red 확인**됨.
- `scripts/acceptance.sh` 전체 green(현재 108 + M6 증가분).
- 전체 suite 직렬 1회: `test:exec` · `test:core` · acceptance.
- 대장에 M6에서 닫은 항목과 **새로 등록한 항목**이 전부 기록됨(유예는 조용히 버리지 않는다).
- 로드맵 M6 절에 **증명/미증명**을 같은 무게로 적는다 — M5 완료 판정 절이 그 형식의 본보기다.
