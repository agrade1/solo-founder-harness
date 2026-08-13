# WORKLOG.md


## 2026-08-12 — V3 M6 완료 (Hierarchical Orchestrator + Fresh Context Rotation)

- **T1** `B-19`/`C-44`: `LIMITS.maxProcessesPerRun` 전용 상수 분리(프로세스 상한이 task 상한을 빌려 쓰고
  있었다). `C-44`의 도달 불가능한 backstop 두 분기는 **주석 명시로 종결** — 여전히 red로 만들 수 없다는
  사실을 대장에 적었다. 두 상수 각각의 mutation에 각자의 테스트만 red(교차 오염 없음).
- **T2** spawn/message 배선: `AgentRequest` 닫힌 union 2갈래 + `src/exec/spawnRouting.ts`. kernel 계약
  2건 변경(`requestSpawn`이 정리 확인된 `cleaning` parent 수용 · child `result`가 parent inbox로 route).
  A급 1건 즉시 수정 — `B-17` 테스트가 없는 key를 읽어 **언제나 통과**하던 공허한 체크였다.
- **T3** `src/exec/contextBundle.ts` — `buildContextBundle(state, taskId)` 순수 함수 + kernel 읽기 전용
  접근자. kickoff와 달리 `briefGenerator.ts`(v2 계층)에 넣지 않았고 **autopilot 주입도 하지 않았다**
  (offline worker에 프롬프트 채널이 없다).
- **T4** `snapshotDigest()` 3종(graph/decision/artifact) — 시각·revision 미포함. 교체 전후 일치 + 무교체
  대조 run 대비 graph·artifact 일치.
- **T5** fresh 강제: `attempt_id_reused` 신설(직전 attempt 신원 재사용 차단, 잔여는 `C-68`) · 교체된
  coordinator가 이전 프로세스의 진행 채널을 이어받지 못함을 테스트로 고정.
- **T6** acceptance **Test 18**(45 내부 체크 / acceptance.sh 16 체크) + mutation 7종 red 확인.
  **절차가 실제로 두 건을 잡았다**: 시각에 눈먼 rotation 체크 · bundle의 child artifact 포인터 누락.
- **외부 팩 조사**(ECC/gstack/oh-my-claudecode): **미도입 판정**. 발상 둘만 로드맵에 배치(`C-67` ·
  M7 도구 예산 상한).
- 실측: `test:exec` 531/531 · `test:core` 409/409 · acceptance PASS=124/FAIL=0 · tsc clean · live 0회.
- PR: #12 #13 #14 #15 (전부 merged, 각 1000줄 이하). Issue #11.

## 2026-08-11 (V3 **M5 완료** — offline 전부 + **첫 live 실행 1회 성공** · 이 블록이 가장 최신이다)

- **첫 live 실행**(`e03008b`): 사용자가 `CODEX_HOME=~/harness-codex-home codex login`을 1회 실행했고
  `scripts/m5-live-probe.mjs`로 실제 Codex 추론 1회를 돌렸다. **이 레포 최초의 live다.**
  실측 usage `input 13,049 / output 5 / cacheRead 9,984`. 이벤트 `init → status → assistant → result`가
  파서 계약과 일치 → **`B-9` live 재확인**.
- **`B-23` 마감**(`0986383`): `codex login` 산출물이 `auth.json` 하나가 **아니었다**(`log/`·`tmp/` 동반).
  허용 목록을 **최상위 이름 2개만** 넓혔고 `config.toml`·MCP 정의는 계속 거부. 양방향 mutation 확인.
  **미리 넓히지 않고 실측을 기다린 판단이 맞았다.**
- **A급 발견 — `which codex`는 Node wrapper다**: 런타임에 `require.resolve`로 native 바이너리(267MB)를
  찾아 spawn하므로 **wrapper digest를 승인하면 실제 추론 바이너리가 고정되지 않는다.** 승인 대상은
  native다. 신규 `B-27`(P1)로 등록 — 다음 live manifest를 사람이 작성하기 전 절차로 못박아야 한다.
- **M5 완료 판정**: 로드맵 §10 완료 조건을 항목별로 증명/미증명으로 갈라 대장에 적었다.
  **증명**: 수동 복사 0회 자동 진행 · hang 없는 pause 복구 · 진행 관측 · 자손 정리(잔존 0) ·
  배타 자원 동시 실행 0 · live 1회. **미증명(의도적 잔여)**: 테스트 실행(`run_process` action이
  읽기 전용 하나) · 신규 파일 발행(`B-16` 잔여) · Claude↔Codex 자동 전달(`B-17` 미소비 — M6 범위).
- **최종 실측**: `test:exec` **514/514** · `test:core` **402/402** · acceptance **PASS=108 / FAIL=0**.
- **M5에서 닫은 것**: `B-7ⓐ`·`B-7ⓑ`·`B-9`·`B-10`(소비면)·`B-16`(부분)·`B-21`·`B-22`·`B-23`·`B-24`·
  `B-25`·`B-26`·`C-1`·`C-55`. **열린 A 0건.** 새로 등록: `B-27`·`C-59`~`C-66`.

## 2026-08-11 (V3 **M5 완료 게이트 3건 전부 마감 — `B-24`·`B-25`·`B-26`. 남은 것은 `B-23`(사용자 `codex login` 1회)뿐** · 이 블록이 가장 최신이다)

- **`B-25`·`B-26`**(`69cd089`, 중앙 직렬) — M5d acceptance에 시나리오 2종 추가(내부 체크 27 → 33).
  - ⑨ **배타 resource class**: 같은 class를 요구하는 task 2건이 같은 batch에 함께 들어가지 않으면서
    **둘 다 완주해 굶지 않는다**. 종료 시 자원 점유 상태 0.
  - ⑩ **별도 프로세스 재시작**: 진짜 자식 프로세스가 durable 파일만으로 run을 이어받는다(in-memory
    전달 0 · 자식은 **자기 실제 시계**를 쓴다). ⑦의 "같은 프로세스 재수화" 한계를 없앴다.
  - 그 과정에서 **fixture 결함 1건** 발견·수정: 합성 시계가 고정 날짜라 자식의 실제 시계가 durable 예산
    창 밖으로 나가 `budget_elapsed_exhausted`가 됐다. 제품 결함이 아니었고 기준을 실제 시각으로 바꿨다.
  - **mutation 확인**: 배타 class 선언 제거 → ⑨ red · 자식 spawn 제거 → ⑩ red.
- **`B-24`**(`7a6a985`+`3742ff6`, **격리 worktree 병렬 slice** → 중앙 통합) — `m5d-cleanup-acceptance.mjs`
  (acceptance.sh **Test 17**, 내부 체크 15). **실제로 spawn한다**: autopilot → typed `run_process` →
  digest로 고정된 `node <controllerEntrypoint>` → **손자**까지 end-to-end.
  - deadline·cancellation 양쪽에서 손자가 ESRCH로 사라지는 것을 폴링(상한 5초, 넘으면 FAIL)으로 확인.
    손자는 `trap ... TERM`으로 SIGTERM을 견디므로 정리는 **SIGKILL 경로까지** 밟아야 성립한다.
  - 고정 sleep 없이 **ready 파일 배리어** — 이 레포가 과거 겪은 "trap 설치 전 deadline 발화" 경합 회피.
  - **프로덕션 코드 무수정**으로 통과 = 이 계약에 숨은 제품 결함이 없었다.
- **중앙 mutation 검증이 과대주장 1건을 잡았다**: `managedProcess`의 SIGKILL 승격을 지우면 자손 정리
  체크가 red가 되는데 **③만 green으로 남았다**. `childPids()`는 직계 자식만 세는데 유출된 손자는
  부모가 죽는 순간 init으로 **reparent**되어 목록에서 사라지기 때문이다 — 라벨이 측정값보다 넓었다.
  → 관측한 손자 pid를 직접 확인하도록 고쳐 같은 mutation에서 ③도 red가 된다. **acceptance를 만들 때마다
  mutation으로 확인하는 것을 이 세션의 기본 절차로 삼았다**(공허한 체크로 A급을 두 번 맞은 뒤의 학습).
- **실측**: `scripts/acceptance.sh` 전체 **PASS=108 / FAIL=0**(Test 16 33건 + Test 17 15건 포함).
- **M5 상태**: 완료 게이트 3건은 닫혔다. **남은 하드 게이트는 `B-23` 하나** — 실제 `codex login` 산출물
  실측이 필요하고 **사용자 액션**이다(`CODEX_HOME=~/harness-codex-home codex login` 후 `ls -la`).
  그 전까지 **M5는 완료가 아니고 live 실행은 0회**다.

## 2026-08-11 (V3 **M5d 착수 — task 1·2·4 완료. 독립 리뷰 3건 전부 `APPROVE — A=0`. typed execution이 바이트를 만들 수 없다는 사실을 실측으로 확인** · 이 블록이 가장 최신이다)

- **M5d 범위 승인 2건**(사용자): ⓐ **offline typed execution 소비 게이트를 연다**(live는 닫힌 채 유지)
  ⓑ self-hosting 대상은 **작은 fixture repo**(하네스 레포 자신이 아니다).
- **계획은 fresh Fable 5**, 구현은 fresh Opus 5, 리뷰는 **fresh Fable 5 read-only** — 이 분업으로 진행했다.
- **Task 0(read-only 실측)**: 계획의 미확인 4건을 확인 — no-progress deadline은 **이미 있고**(`autopilot.ts`
  `attemptDeadline` · `maxNoProgressMs`), 자손 정리·wall deadline은 M5c 3C `superviseProcess`가 제공한다
  → `C-18` 잔여는 live provider 쪽뿐이다. typed execution kernel API도 전부 존재 → Task 2는 배선이다.
- **Task 1**(`f76b6f3`·`1cbfe9a`) — `B-21`·`C-55` fixed. 독립 리뷰 `APPROVE A=0/B=0/C=3`.
  `prepared` 잔여 되찾기(새 attempt 미소모) · 계획 없는 잔여는 pause로 자원 반납 · turn 중간 kernel
  throw를 `turn_aborted`로 받아 loop 정지. 신규 `C-59`·`C-60` 등록.
- **Task 2**(`0f11a02`) — `B-10` **소비면 배선**. 독립 리뷰 `APPROVE A=0/B=0/C=3`.
  배선하며 kernel 계약 3건을 실측으로 알아냈다: **권위 과금 → grant → 효과** 순서(`budget_turn_unaccounted`) ·
  operation은 **permit이 쥔 kernel 검증 사본**에서 꺼내야 함(`dispatch_operation_unbound`) ·
  승인 여부는 **등록 전에** facade 순수 판정으로 봐야 함(아니면 효과 없는 거부가 `outcome_unknown`이 된다).
- **⚠️ Task 2의 최대 발견 — typed execution은 지금 바이트를 하나도 만들 수 없다.**
  `write_file`은 신규 생성(`write_publish_unsupported` = **`B-16`**)도 내용 교체(`write_replace_unsupported`)도
  fail closed이고 성공 경로는 **크래시 창 멱등(`already_applied`) 하나뿐**이다. `run_process`의 action은
  닫힌 enum `validate-plan` 하나이며 읽기 전용이다. → **연 것은 집행 lifecycle이지 코드를 쓸 능력이 아니다.**
  self-hosting 루프의 **implement 단계는 `B-16`을 여는 별도 승인 slice 없이는 불가능**하다.
  계획 단계에서는 몰랐고 구현해 봐야 드러났다 — M5d 완료 조건의 의미가 여기 달려 있다(사용자 결정 대기).
- **Task 4**(`95fdb4e`, **격리 worktree 병렬**) — `C-1` fixed. 독립 리뷰 `APPROVE A=0/B=0/C=3`.
  seam setter를 production 표면에서 제거(facade 재수출 삭제 + 호출자 프레임 `*.test.ts` 요구, `dist/`에는
  그 조건을 만족할 프레임이 없다 · 파싱이 깨지면 **fail closed**). 남은 표면 3종은 **없앴다고 주장하지 않고**
  코드 주석에 그대로 적었다. Task 2와 파일 소유권이 겹치지 않아 병렬로 돌렸고 통합·최종 실측은 직렬.
- **리뷰 C 5건 전부 이번에 반영**(`2b49a36`). 그중 Task 2 C-1은 **내 주석이 틀린 정지 경로를 가리키던 것**이다:
  집행 경계 이후 pending이 남으면 turn은 이미 권위 과금돼 있어 `chargeTurnUsage`를 건너뛰므로, 실제 정지는
  착지 전이의 `assertNoPendingOperations`(`operation_pending_unreconciled`) → `C-55` catch다. `B-22`가 아니다.
  신규 `C-61`(operation 사이 취소 창 미검증 — 관측 hook이 없어 **덮지 못했다고 정직하게 기록**) ·
  `C-62`(seam 가드의 `.test.ts` suffix 매칭) 등록.
- **검증**: `tsc --noEmit` 0 · `src/exec/*.test.ts` + `autopilot.test.ts` **528 pass / 0 fail**.
  기존 테스트 **삭제·완화 0건**(기존 "B-10 미소비" 테스트 1건은 사용자가 연 게이트라 **더 강한 새 계약으로
  갱신**했고, `B-16` 미개봉 테스트를 추가했다). `test:core`·acceptance·stress·live는 **미실행**.
- **`B-16` 부분 개방**(`90f72db`·`7e5a966`) — 사용자가 "2번으로 진행"으로 승인한 slice. 계획은 fresh
  Fable 5, 구현 Opus 5, **적대적** 독립 리뷰 fresh Fable 5 → `APPROVE A=0/B=1/C=3`.
  - typed `write_file`이 **처음으로 실제 바이트를 낸다** — 승인된 **기존 파일 교체만**. rename하지 않고
    신원·preimage를 확정해 둔 **그 fd**에 `write`/`ftruncate`/`fsync` → 발행 syscall에 pathname이 없다.
    3A 2차 A3이 교체를 닫은 이유(최종 pathname rename 직전 창)가 이 형태에는 성립하지 않는다.
  - **신규 파일 발행은 계속 fail closed**(고정할 fd가 없다 — `B-16` 잔여).
  - **교환한 것: 원자성.** torn은 재시도 시 preimage 불일치로 fail closed이고 자동 복구하지 않는다.
    거짓 성공 영수증 경로는 없다(리뷰가 durable 경로 추적으로 확인).
  - `already_applied`의 durability 기준을 **높였다**(내용 fsync 추가).
  - **리뷰 B-1은 이 세션의 과대주장이었다**: 테스트 주석이 "autopilot 쪽 테스트가 덮는다"고 적었는데
    실제로는 없었다. 없는 커버리지를 만들고(seam fault → `outcome_unknown` · pending 0) 주석을 정정했다.
    이 레포가 반복 지적받아 온 바로 그 병이라 A급으로 다뤘다.
  - 신규 `C-63`(torn을 artifact로 선언하는 승인 plan은 막지 않는다) · `C-64`(0444 대상은 멱등 판정 불가) ·
    `C-65`("pathname 없음"을 집행하는 테스트가 없다 — 보증은 코드 리뷰뿐).
  - 실측: `tsc` 0 · **538 pass / 0 fail** · 테스트 삭제·완화 0(1건 갱신 + **11건 추가**).
- **Task 3 — offline self-hosting acceptance**(`f53c967`·`462e1c9`): `scripts/m5d-offline-acceptance.mjs`
  (acceptance.sh **Test 16**). 승인 1건으로 gate된 durable run에서 **수동 복사 0회**로 autopilot이
  fixture repo의 **실제 파일을 고쳐** DAG를 완주시킨다. 시나리오 8종 · 내부 체크 **27건**.
  - **적대적 리뷰 `REVISE — A=2`**, 둘 다 과대주장이었고 즉시 수정했다.
    **A1**: ⑦ 예산 체크가 항등식이라 어떤 mutation으로도 red가 안 됐다(offline worker는 0 토큰 신고) →
    "durable 재수화" 증명으로 교체하고 토큰은 `=== 0`을 사실 그대로 단언.
    **A2**: ⑧ "생존 자손 0"은 spawn 0회 loop라 cleanup을 지워도 green → 라벨에 한정어를 달고 헤더
    "증명하지 않는다" 절에 3건 추가(자손 정리 · 배타 자원 동시 실행 0 · 예산 소진).
  - **커밋 메시지에도 과대주장 1건**("전체 acceptance PASS=102")을 스스로 냈고 amend로 정정했다 —
    acceptance 총계는 99 그대로였고 늘어난 건 스크립트 내부 체크였다. 같은 병이 반복된다는 뜻이라 기록한다.
  - 신규 `B-24`(자손 정리 acceptance 부재 — **M5 완료 선언 전 하드 게이트**) · `B-25`(배타 자원 동시
    실행 0 미검) · `B-26`(별도 프로세스 재시작 미검).
- **Task 5 — 전체 suite 직렬 1회**(예약돼 있던 그 1회): `test:exec` **510/510** · `test:core` **402/402** ·
  acceptance **PASS=99 / FAIL=0**. `f53c967`에서 측정했고 이후 두 커밋은 `scripts/`만 건드렸다(재실행 green).
- **작업 방침 문서화**(`0b9d3fb`): 사용자 방침을 CLAUDE.md · AGENTS.md · `.claude/skills/harness-dev` ·
  `templates/`(대상 프로젝트) 4곳에 기록했다 — 배송 우선(MVP-first, A급 즉시·B/C 기록 후 진행) ·
  모델 분업(Fable 5 = 맥락·계획·적대적 리뷰 / Opus 5 = 구현) · 병렬 규율. 세션이 바뀌어도 유지된다.
- **M5d 상태**: task 1·2·3·4·5 완료 + `B-16` 부분 개방. **M5 완료는 아니다** — `B-24`(자손 정리) ·
  `B-25` · `B-26`이 완료 선언 전 게이트이고, live는 `B-23`이 그대로 막고 있다.

## 2026-08-10 (V3 **live 하드 게이트 4건 마감 — `B-9` · `B-7ⓑ` · `B-22` · `B-7ⓐ`. `B-7ⓐ` 독립 리뷰 `APPROVE — A=0, B=1, C=2`. live 실행은 여전히 0회** · 이 블록이 가장 최신이다)

- **스킬 자산 설치**(`82a890b`): 형제 체크아웃 `solo-founder-harness`의 `2600c13` 자산 3개를 이 worktree에도
  설치 — `.claude/skills/harness-dev/SKILL.md`(이 레포 개발 규칙) + 대상 프로젝트용 `templates/CLAUDE.md` ·
  `templates/claude-skills/founder-mvp-guard/SKILL.md`. 스킬 자체가 정한 경계대로 `templates/`는 이 레포의
  `CLAUDE.md`·`.claude/skills/`로 섞지 않았다. 코드·schema 무수정.
- **`B-9` fixed**(`3d14c7b`): 실측 codex JSONL usage 필드명(`cache_write_input_tokens` 등) 반영.
- **`B-7ⓑ` fixed**(`2154a39`): 자식 `stdio[2]="ignore"` — stderr가 fd 단계에서 버려져 이 프로세스 메모리에
  들어오지 않는다. `SpawnFn` 타입도 `"ignore"` 고정이라 pipe로 받는 코드는 컴파일되지 않는다. settle에
  stderr를 싣지 않는다. 패턴 전용 redaction에 의존하지 않게 됐다.
- **`B-22` fixed**(`5a8d9f0`): `chargeTurnUsage` 거부를 삼키지 않는다. 정리(`recordTerminal`→`confirmCleanup`)
  순서는 보존하고, 그 뒤 `approval_required`로 pause + loop를 `usage_unaccounted`로 정지한다. task는
  `paused`로 남아 resume 가능하다(hang도 소실도 아니다).
- **`B-7ⓐ` fixed**(`fc0a528`) — live 인증 방식을 **사람이 결정해야 했던** 항목. 대장의 세 선택지 중
  **"격리 홈에 사람 1회 로그인"** 을 택했다.
  - `manifest.executionAuthority.codexHome`: **유일한 선택 key** · `ApprovedDirectory`(경로 하나, **내용
    digest 없음** — digest를 남기는 것 자체가 자격증명 유출 경로다). 부재/`null`을 같게 정규화하므로
    **기존 승인의 canonical digest는 바이트 단위로 불변**이다(예산 회계·state binding 무영향).
  - 승인 홈일 때: 경로 정확 일치(`codex_home_not_approved`) · 홈·자격증명 **프로세스 uid 소유** ·
    `auth.json` 외 항목 0(`codex_home_not_empty`) · 자격증명 부재는 거부(`codex_home_credentials_missing`).
    자격증명은 **열지 않는다**(lstat 한 번 — 존재·정규 파일·비symlink·group/other 0·소유자).
  - 승인이 홈을 담지 않으면 기존 계약대로 **완전히 비어 있어야** 한다 = 인증 없이 fail closed.
    `~/.codex` fallback은 어느 경로에도 없다(자식 env는 `CODEX_HOME` 하나뿐).
  - 승인 홈은 **봉인된 manifest**에서만 오므로 turn 사이 교체는 `codex_spec_mutated`다.
  - schema에 `approvedDirectory` 정의 추가. kernel 계약 테스트가 **"선택 key는 `codexHome` 하나"** 를 강제한다.
- **검증**: `tsc --noEmit` 0 · `npx tsx --test src/exec/{codexCliProvider,approvalManifest,orchestrationKernel}.test.ts`
  **168 pass / 0 fail**. 전체 suite·`test:core`·acceptance·stress·live는 **미실행**.
- **독립 리뷰**(fresh Fable 5 read-only, `fc0a528` diff): `APPROVE`. TOCTOU는 사전 검증 + spawn 직전 동기
  게이트가 둘 다 승인 홈을 재검증해 닫혀 있고, 오류 메시지에 경로·uid·파일명이 없으며, 하드링크는 inode의
  소유자·모드를 공유하므로 소유자 검사로 덮인다고 판정. 신규 등록: **`B-23`**(실제 `codex login` 산출물이
  `auth.json` 하나인지 **미확인** — 아니면 첫 live가 `codex_home_not_empty`로 죽는다. **허용 목록을 미리
  넓히지 않고** 실측 후 관측된 파일만 추가한다) · `C-57`(재시작 후 홈 재사용 마찰 — 미확인) ·
  `C-58`(자격증명 dev+ino 미고정 — 같은 uid만 가능하므로 선언된 threat model 밖).
- **`B-7`은 닫혔지만 live 하드 게이트는 남아 있다** — 그 자리를 `B-23`이 이어받는다. live 실행 0 ·
  네트워크 0 · secret 사용 0. `B-10`~`B-21`은 변화 없음(controller·process·scheduler 계층 무접촉).

## 2026-08-05 (V3 **M5c 완료 — task 3E autopilot CLI 독립 리뷰 `APPROVE — A=0, B=2, C=6` · 3F로 숨은 red 48건 복구 · 전체 suite 1회 PASS. M5는 완료 아님** · 이 블록이 가장 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · branch `work/m5c-autopilot`.
  커밋: `c771f81`(3E) · `32b8853`(3F) · `77b55e5`(경합 수정). 구현은 전부 **각각 별도의 fresh Opus 5
  worker**, 리뷰는 fresh Fable 5 read-only, 중앙 오케스트레이터(Opus 5)는 계획·재검증·문서만 했다.
- **M5c는 완료다. M5는 완료가 아니다.** 독립 리뷰 판정 그대로: M5 완료 조건은 live provider와 typed
  execution을 요구하고 둘 다 **의도적으로 열린 게이트**다(`B-7`/`B-9`/`B-10`). 현재 autopilot은
  **operation 0건인 plan만 완료에 도달**시키므로 **아직 마일스톤을 완료까지 몰고 갈 수 없다.**
  증명된 것은 "Autopilot **Bootstrap**"(승인 게이트 · durable · pause-not-hang · 관측 · 취소 정리)이다.

### Task 3E — `harness autopilot` CLI (`c771f81`)

- **변경 파일(3)**: `src/cli.ts` · `src/commands/autopilot.ts`(신규) · `.test.ts`(신규).
  `src/exec/`·schemas·docs·package **diff 0줄** — `stableController.ts` 무변경.
- 승인 게이트(마일스톤 일치 · 만료 · durable 예산) → 16회 상한 루프 → plan 파일 있는 task만
  `prepared`, 없으면 **`deferred`(무접촉)** → turn 직전 `startPreparedTask` → `startOfflinePlanTurn`
  (in-memory · **spawn 0**) → progress를 `recordProgress` + stdout 양쪽 → `recordTerminal` →
  `confirmCleanup` → `completed`/`paused`/`cancelled`. run-level 거부만 exit 2.
- plan 파일은 `{operations, result}`만 담고 **run/task/attempt/turn 결박은 durable state에서** 온다 →
  plan이 다른 run을 사칭하거나 낡은 attempt를 되살릴 수 없다. 경로 순회는 kernel 발급 taskId의
  `assertSlug`로 차단. `__proto__`는 `JSON.parse` + 2필드 복사로 무력.
- **열린 게이트 7종을 하나도 닫지 않고 하나도 넘지 않았다** — `B-10`·`B-11`·`B-12`·`B-13`·`B-16`·
  `B-17`·`B-7`/`B-9` 전부 **"소비 회피"로 독립 판정**됐다. `--resume`/재예산 플래그를 **의도적으로
  만들지 않았다**(만들었으면 같은 승인 아래 예산이 새로 생겼을 것이다).
- **교체 assertion 0건** — 기존 테스트를 하나도 건드리지 않았다.
- 실측: `tsc` exit 0 · `autopilot.test.ts` **17/17**(중앙 10회 연속 · worker 20회 + 부하 10회) ·
  exec 8파일 **313/313** · `test:core` **391/391** · mutation 3종 red 후 원복.
- 개발 중 flake 1건을 **출하 전에** 잡아 고쳤다(자손 검사가 tsx의 esbuild 자식을 셌다 → baseline 상대 +
  2회 표본 교집합). 고정 sleep 0.

### Task 3F — 숨어 있던 red 48건 복구 (`32b8853`) — **이번 세션 최대 발견**

- `src/exec/codexCliProvider.test.ts`가 **11 pass / 48 fail**이었고 **적어도 `8dd05f9`부터** 그랬다
  (중앙이 별도 worktree를 떠서 직접 확인). **우리 작업의 회귀가 아니다.**
- 원인은 3B가 `stableController`에서 고친 것과 **같은 결함** — pre-M5c v1 manifest fixture라
  `manifest_pre_m5c_unsupported`가 **각 테스트의 검증 대상에 도달하기 전에** 승인을 거부했다.
- **아무도 몰랐던 이유: 모든 세션이 focused 테스트만 돌렸고 `npm run test:exec`를 아무도 돌리지 않았다.**
  계획 리뷰어가 경고한 "live/전체 검증이 단일 고분산 게이트로 누적된다"가 실제로 발현한 사례다.
- 그 48건은 M5a/M5b **안전 테스트**다 — spawn 0 단언 · TOCTOU 재검증 · 실행 파일 신원 고정 ·
  격리 홈 계약 · MCP 위반 · 세션 소유권 · 핸들 위조. **Task 3A 이후 이 속성들이 실제로 검증된 적이 없다.**
- 수정은 **fixture 이관뿐**이고 **프로덕션 변경이 하나도 필요하지 않았다** = red 뒤에 숨은 제품 결함 없음.
  변경 +27/−1, **교체 assertion 0건**(삭제된 줄은 fixture 리터럴 하나).
- **"초록으로 만든 게 아니라 대상에 도달한다"는 구조적 증명**: `codeOfCall`이 아무것도 안 던지면
  `"(통과)"` 센티넬을 반환하고 `expectNoSpawn`이 별도로 `calls.length === 0`을 단언하며 모든 테스트가
  `assert.equal(code, "<구체 코드>")`로 끝난다 → 센티넬로도 `manifest_pre_m5c_unsupported`로도 통과 불가.
  mutation 4종이 실증: `approved_commit_mismatch` 3개소 변조 → spawn 0·TOCTOU 테스트 사망 ·
  digest 검사 제거 → **spawn 수 0 → 1 반전** · seal-drift 가드 무력화 → 4건 사망.
- 정직 기록: worker가 mutation 위치를 한 줄 잘못 짚어 무의미한 결과를 낸 뒤 다시 했고, 세 곳 중 한 곳만
  끄면 다른 경로로 발화해 green이라 **세 곳 전부**를 꺼야 도달 범위가 증명된다고 보고했다.
  이 worker는 중간에 API 529로 한 번 죽었고, 중앙이 **프로덕션 파일에 mutation 잔존이 없음을 확인한 뒤**
  같은 컨텍스트로 재개시켜 mutation·검증·커밋만 마무리했다.

### 경합 수정 (`77b55e5`)

- `managedProcess`의 SIGKILL 테스트가 **병렬 부하에서만** red였다(단독 15/15). 실험으로 원인 확정:
  지연 100ms → SIGKILL 40/40 · 3ms → SIGTERM 29·SIGKILL 11 · 1ms → SIGTERM 40/0.
  `sh`가 `trap '' TERM`을 설치하기 **전에** deadline이 터져 자식이 그냥 SIGTERM으로 죽고
  "고집스러운 프로세스"가 생기지 않았다. **supervisor는 두 경우 모두 올바르게 동작했다 — 테스트 경합이다.**
- `4774c43`과 같은 관측 배리어(trap 다음 줄에서 ready 파일 → 폴링)로 고정. 원본 assertion 3건 바이트
  동일, 배리어 실패를 소리나게 만드는 assertion 1건 **추가**. `timeoutMs` 100 → 2000(배리어가 그 값을
  비-load-bearing으로 만들었기 때문이며 escalation 창인 `termGraceMs`/`killGraceMs`는 불변).
  파일의 나머지 14건도 같은 형태인지 전수 확인했다(3건은 이미 배리어 보유, 1건은 경합 없음).

### 전체 suite — **직렬 1회 실행했다**

- `npm test`(공용 배타 lock) 1회: `test:exec` **493/493** · `test:core` **391/391** ·
  acceptance **PASS=92 / FAIL=0** → **ALL PASS**.
- `test:exec`는 중앙 재실행 **3회 연속 493/493**(3F 이전 444/49 · 경합 수정 이전 492~493 진동).
- **M5a 이후 이 저장소에서 처음으로 전체가 초록이다.**

### 신규 유예

`B-21`(중단된 batch의 `prepared` 잔여를 autopilot이 되찾지 못함 — 반복·예약 실행 전) ·
`B-22`(`chargeTurnUsage` 실패를 삼켜 토큰 예산 과소 집행 — live 배선 전 하드 게이트) ·
`C-50`~`C-56`. 상세는 roadmap §9.1.

### 미실행

live · stress · 반복 3회 · build/dist · M5d. **live는 `B-7`/`B-9` 하드 게이트이며 사용자 승인 사항이다.**

### 다음

M5c 잔여 없음. 다음은 **M5-live 슬라이스**(`B-7` 인증 방식 결정 + `B-9` live JSONL 1회 캡처) 또는
**M5d**(스펙 부재 — 계획 리뷰 A-1). 둘 다 **사용자 결정 사항**이다.

## 2026-08-04 (V3 **M5c task 3D — trusted Git · 독립 리뷰 `APPROVE — A=0, B=1, C=3`. Task 3D 완료, M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree **`/Users/jihun/Developer/solo-founder-harness-m5c`**(내구성 없는 `/private/tmp`에서 이전) ·
  branch `work/m5c-autopilot` · 시작 HEAD `f33c1aa` · 코드 커밋 **`b09df0e`**(단일).
  fresh Claude Opus 5 worker 1개. 중앙 오케스트레이터는 별도 Opus 5 세션이며 구현하지 않았다.
- **변경 파일(4)**: `orchestrationKernel.ts`(+test) · `trustedGit.test.ts`(신규) · `typedExecution.ts`.
  **신규 소스 모듈을 만들지 않았다** — `trustedGit.ts`는 두 번째 spawn 경로이거나 삭제된
  `writeFileEffect.ts` 구멍의 재현이 될 것이라 존재 이유를 얻지 못했다. `managedProcess.ts` ·
  `orchestrationTypes.ts` · `approvalManifest.ts` · `orchestrationStore.ts` · `schemas/*` ·
  `stableController.*` · package/lock · docs · dist **전부 무변경**. 신규 의존성 0(stdlib만).
- **허용 git 연산은 3개뿐이고 전부 로컬 read-only · exit code만 본다**:
  `rev-parse --verify --quiet HEAD^{commit}` · `diff --no-ext-diff --no-textconv --quiet HEAD --` ·
  같은 것의 `--cached` 판. 고정 prefix `-c core.fsmonitor=false -c core.hooksPath=/dev/null
  --no-optional-locks --no-pager`.
- **hard deny는 구조적으로 불가능하다**: remote·refspec·branch·경로·커밋 메시지를 담을 필드가
  API에 **존재하지 않는다** → push/fetch/pull/clone/submodule/merge는 안 부르는 게 아니라
  **표현 불가능**하다. argv는 동결 상수 배열이고 `shell: false`라 호출자 문자열이 argv에 닿지 않는다.
  `spec.mutates === false`를 spawn 전에 단언하므로 표에 쓰기 행만 추가해도 여전히 거부된다.
- **권위 모델은 Task 3C 선례 그대로**: kernel 사설 WeakMap 레지스트리 · **객체 참조가 권위**(spread ·
  hand-made · `Proxy` · `Object.create` · JSON 왕복 전부 조회 실패) · live grant + 발급자 kernel
  인스턴스 `===` · durable 재독 · A4 mark-then-re-verify(진입 → 소진 → **재독** → digest/repo 재검증 →
  spawn) · 정리 미확인이 1차 오류를 이김(B1) · 닫힌 13종 `git_*` 코드.
- **repo 신원**: mint 시점과 spawn 직전 **두 번** 검증 — 절대경로 · NUL 없음 ·
  `realpathSync(root) === root`(symlink 탈출 차단) · 디렉터리 · 그 경로에 `.git` 존재.
  대상은 항상 `this.#paths.workspaceRoot`이며 **호출자가 지정할 수 없다**.
  `MANAGED_PROCESS_ENV`가 `GIT_*`·`HOME` 없는 동결 whitelist라 ambient 리다이렉트도 불가능하다.
- **독립 리뷰가 정적 검토를 넘어 실증했다**: ⓐ `.git` 전 파일 mtime+size 스냅샷을 3개 쿼리 실행
  전후 비교 → **바이트 단위 동일(NO-WRITE)** ⓑ repo `.git/config`에 `core.fsmonitor`·`diff.external`·
  `core.pager`를 sentinel 스크립트로 심고 실행 → **코드 실행 0**(`-c`가 우선순위에서 이긴다).
- **구현자가 스스로 신고한 3건에 대한 리뷰 판정**
  - **durable pending 불필요 주장 → 성립.** 효과가 0이면 A4의 pending이 서술할 불확실 창이 없다.
  - **config 잔여 → B(`B-20`), A 아님.** 오늘 도달 가능한 코드 실행 경로가 없음을 실험으로 확인.
    수정은 **env 한 줄**(`GIT_CONFIG_NOSYSTEM=1`)이고 `managedProcess.ts` env를 다음에 만지는
    task에서 함께 닫는다.
  - **commit-class 쓰기 미구현 → 옳은 결정.** durable pending의 `kind`가 소유권 밖 닫힌 union이라,
    durable 표시 없는 쓰기는 3A가 닫은 구멍의 재생성이다. 대신 **의도된 gap**이 남았고 다음 task가
    durable pending 계약을 먼저 가져와야 한다(`C-49`).
- **교체 assertion 2건**: 둘 다 allow-list **추가 등록**(`resolveTrustedGitCapability`를 공개 API 목록에,
  `isGenuineTrustedGitCapability`를 attest 표면 목록에). 같은 테스트의 위조 거부 루프가 신규
  predicate까지 검사하도록 **강화**됐다. 삭제·완화·skip 0.
- **검증 실측(중앙 재실행)**: `tsc --noEmit` exit 0 · `trustedGit.test.ts` **15/15** ·
  **10회 연속 전부 통과**(구현 worker는 20회 + 부하 10회 자체 통과) · 회귀 5파일 **225/225** ·
  managedProcess + stableController **73/73** · 프로세스 누수 0 · `git status --short` = `?? node_modules`.
  구현 worker mutation 4종(1회 소비 · git 바이너리 검증 · repo 신원 · allow-list 거부) 각각 red 확인 후 원복.
- **정직 기록**: 구현 중 red 2건이 있었고 근본 원인을 고쳤다 — argv 로그 구분자로 쓴 `--`가 실제 argv
  원소였던 것, 생존 프로세스 탐지가 tsx 헬퍼와 `ps` 자신을 세던 것. 3C 교훈대로 **고정 sleep 없이
  관측 배리어만** 썼다.
- **신규 유예**: `B-20`(system/repo gitconfig 미차단) · `C-47`(`.git` regular file 통과) ·
  `C-48`(신원 검사 ↔ spawn TOCTOU) · `C-49`(exit-code-only 표면이 얇음 — 다음 task 계획 항목).
- **미실행**: `npm test` · `test:exec` · `test:core` · 전체 acceptance · stress · live · build/dist.
- **다음 DAG task(미착수)**: `autopilot` CLI — M5c의 마지막.

## 2026-08-04 (V3 **M5c task 3C — managed process supervisor · `B-F1` 개봉 후 폐쇄 · 독립 리뷰 `REVISE — A=0, B=4, C=2` → 값싼 B 2건 후속 폐쇄. Task 3C 완료, M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` ·
  구현 커밋 **`56cf8d6`**(base `f2e187d`) · 후속 커밋 **`4774c43`**(base `98a0778`).
  구현·후속 모두 **fresh Claude Opus 5 worker**(각각 별도 세션 · 이전 작성자 transcript·자기평가
  미상속 · 병렬 writer 0). 중앙 오케스트레이터는 별도 Opus 5 세션이며 구현하지 않았다.
- **이 시스템 최초의 실제 승인 spawn이 들어왔다.** 그 전까지 전역 spawn 수는 0이었다.
- **변경 파일**: 구현 6개 — `managedProcess.ts`(신규) · `managedProcess.test.ts`(신규) ·
  `orchestrationKernel.ts`(+test) · `typedExecution.ts`(+test). 후속 1개 — `managedProcess.test.ts`.
  package/lock · schemas · store · `stableController.*` · docs · dist · `AGENTS.md`/`CLAUDE.md`
  **전부 무변경**(중앙 재검증: 해당 경로 diff 0줄). 신규 의존성 0(stdlib만).
- **`B-F1` 폐쇄**: ① 1회 소비 ② live grant + 발급자 신원 ③ durable 재독 ④ spawn 직전 digest
  재검증 + A4 mark-then-re-verify. 상세와 근거는 roadmap §9.1 "task 3C 대장 갱신" 절.
- **아키텍처 결정**: `ProcessLaunchCapability`/`LaunchRecord`/`GENUINE_LAUNCH_CAPABILITIES`/
  `resolveProcessLaunchCapability`/`isGenuineLaunchCapability`를 `typedExecution.ts`에서 **kernel로
  이동**하고 `typedExecution.ts`는 이름만 재수출한다. 이유: 소비자가 kernel 밖에 있으면 권능을
  **공개 함수의 인자로** 받아야 하는데 그게 정확히 A3가 삭제한 `writeFileEffect.ts` 구멍이다.
  독립 리뷰가 순환 0 · module-private 유지 · A3 성립을 확인했다(`DECISIONS.md` 참조).
- **자손 정리**: `spawn(..., {detached:true})`로 자식을 프로세스 그룹 리더로 만들고 `reapGroup()`이
  `-pgid`에 SIGTERM → `kill(-pgid,0)` ESRCH까지 폴링 → SIGKILL → 재폴링한다. **`EPERM`은 살아있음으로
  처리(fail closed)**. 정상 종료 경로에서도 항상 돈다. `cleanupConfirmed: false`면 deadline 오류보다
  **먼저** `process_cleanup_unconfirmed`를 던진다(B1 우선순위 보존).
- **flaky 테스트 — 발견·재현·수정 전말(정직 기록)**: 구현 worker는 "3회 연속 13/13 안정"이라고
  보고했으나 **중앙 재실행에서 3회 중 1회 실패**했다(약 43회 중 1회, 이름 미포착). 독립 리뷰어가
  **52회 중 1회 재현하고 이름을 포착**했다 — `[M5c/3C] deadline: 손자까지 …`. 합산 관측 약 **2/95**.
  원인은 fixture의 **동기화 배리어 부재**(`timeoutMs: 300`인데 이 파일이 실제 프로세스 ~10개를 연속
  기동 → 부하 시 자식의 첫 명령이 300ms를 넘겨 `grandchild.pid` 기록 전에 deadline SIGTERM이 그룹을
  죽이고 `readFileSync`가 ENOENT). **테스트 전용 false red다** — 프로덕션 `reapGroup()`은 ESRCH
  **관측** 기반이라 타이밍이 밀려도 정리 확인이 흔들리지 않고, pgid 재사용은 `false` 방향으로만
  틀리므로 **false green 경로가 없다**. `4774c43`이 관측 배리어(pid 파일 폴링 — 기존 cancel 테스트와
  같은 패턴)를 넣고 `timeoutMs` 300 → 2000으로 올렸다. 삭제·완화 0, assertion 1건 **추가**로 강화.
- **교체 assertion(구현 3~4건 · 후속 0건 삭제)**: 전부 동등하거나 강화. 특히
  `assert.equal("executeRunProcessOperation" in kernelModule, false)` → 함수임을 확인으로 바뀐 것은
  **게이트 개봉이 곧 task 목표**라 불가피하며, 콜백 주입이 영수증 0·표시 0으로 거부됨을 **실제 실행**으로
  검사하는 더 강한 테스트로 대체됐다. A3 sweep은 promise도 await하도록 **강화**됐다.
- **검증 실측(중앙 재실행)**: `tsc --noEmit` exit 0 · `managedProcess.test.ts` **15/15**(13 → 15) ·
  **정상 20회 + 부하 10회 = 30회 전부 fail 0**(수정 전 약 2/95) · 회귀 5파일 **225/225** ·
  `stableController.test.ts` **58/58** · 프로세스 누수 검사 **0줄** · `git status --short` =
  `?? node_modules`. 구현 worker mutation 4종 · 후속 worker mutation 3종 각각 red 확인 후 원복.
- **독립 리뷰**: fresh Fable 5 read-only · 범위 `f2e187d..56cf8d6` · 판정
  **`REVISE — A=0, B=4, C=2`**. 리뷰어는 `managedProcess.test.ts` **52회**와 kernel+typedExecution
  **167/167**을 직접 실행했다. **A=0이므로 리비전 루프를 돌리지 않고**, B 4건 중 값싼 2건(F1 flake ·
  F3 상한 테스트)만 같은 task 안에서 닫았다.
- **신규 유예**: `B-18`(setsid 그룹 탈출 자손을 `cleanupConfirmed`가 못 봄) ·
  `B-19`(run 전역 프로세스 상한이 `maxTasksPerRun` 상수를 빌려 씀 — 스펙 혼동) ·
  `C-44`(depth backstop 분기 도달 불가 — 후속 worker가 red 만들기 실패를 정직 보고) ·
  `C-45`(exit≠0인데 marker가 `applied`) · `C-46`(win32 미검증).
- **`B-13`은 승격하지 않는다**: 결함은 `StableController.runTask`의 `finally { provider.stop().catch() }`인데
  프로세스 기반 provider가 **아직 배선되지 않았다**. 새 kernel 경로 자체는 순서가 옳다.
- **미실행**: `npm test` · `test:exec` · `test:core` · 전체 acceptance · stress · live · build/dist.
- **다음 DAG task(미착수)**: trusted Git → `autopilot` CLI.

## 2026-08-03 (V3 **M5c task 3B — StableController M5c 배선 · 독립 리뷰 `APPROVE — A=0, B=1, C=1`. Task 3B 완료, M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `8dd05f9` ·
  코드 커밋 **`9a34c5d`** (단일). 구현은 **fresh Claude Opus 5 worker 1개**(이전 작성자 transcript·
  자기평가 미상속 · 병렬 writer 0). 중앙 오케스트레이터는 별도 Opus 5 세션이며 구현하지 않았다.
- **변경 파일(2)**: `src/exec/stableController.ts` · `src/exec/stableController.test.ts`.
  kernel · store · typedExecution · approvalManifest · schemas · `scripts/*` · package/lock ·
  tracked `dist` · `AGENTS.md`/`CLAUDE.md` · docs **전부 무변경**(중앙 재검증: `git diff --name-only
  8dd05f9..9a34c5d` = 2파일, package/lock diff 0줄).
- **한 일**: 55건 red의 원인이던 pre-M5c v1 manifest fixture를 M5c manifest
  (`autopilotPolicy` + `operationAuthorityByTask` + `executionAuthority`)로 교체하고, controller를
  M5c 계약에 배선했다. `scheduleReady`+`startScheduledBatch` → `planRunnableBatch` →
  `commitPreflightBatch`(전부 `prepared`) → `startPreparedTask`(sync gate와 `provider.start()` **사이
  동기 호출**, await 창 0) → `beginDeliveryAttempt` → `recordTerminal` → `confirmCleanup` →
  `completeTaskWithArtifacts`. `startScheduledBatch()`는 무조건 `preflight_required`를 던지는
  우회 차단 stub로만 남았다. per-attempt `lease.<32hex>`(`node:crypto`) · `#actionId(kind)` 추가.
- **typed operation dispatch 0**: 이 bridge는 read-only이며 permit → charge → grant → 효과 → 영수증
  체인에 **진입하지 않는다**. `B-16` 미개봉 · **spawn 0**(`B-F1` 미개봉) · 신규 의존성 0
  (stdlib `node:crypto`만).
- **교체 assertion 9건 전수**(삭제·skip·완화 0 · grep `skip/todo/only` 0건)
  1~3. artifact 실패 3계열 — 기대 state `"running"` → `"cleaning"` (실패 지점이 `confirmCleanup` 뒤
     `completeTaskWithArtifacts`로 이동). 핵심 assertion(결과 메시지 없음 · durable artifact 없음 ·
     미완료)은 **무변경**.
  4~7. 예산 소진 sibling · A4 start 창 · handoff throw · run-lock — `"running"` → `"prepared"`.
     프로세스/lease 없이 `running`으로 올라가지 않는다는 **더 강한** 불변식을 고정한다.
  8. multi-output 성공 revision `before + 2` → `before + 5`(preflight/start/terminal/cleanup/complete).
     **정확 등호 유지** — per-artifact 등록 회귀는 8이 되어 여전히 잡힌다.
  9. 빈 manifest 기대 코드 `invalid_manifest` → `manifest_pre_m5c_unsupported`. `assert.throws` 유지.
  - A1 monkey-patch/getter/위조 테스트는 커버 메서드 집합이 **8종 → 11종으로 확대**됐다(강화).
- **fixture-only 변경**: `maxAttemptElapsedMs = min(default, maxElapsedMs)` · `maxElapsedMs: 1 → 1_000`
  (validator 하한 1000ms · 1s/호출 시계라 첫 게이트에서 여전히 `budget_elapsed_exhausted`) ·
  kernel 시계 초→ms(추가 lifecycle 커밋이 무관한 테스트의 durable deadline을 선점하지 않게).
  독립 리뷰가 **경계 테스트 무력화 없음**을 확인했다.
- **검증 실측(중앙 재실행 · 리뷰어 재실행 · 구현 세션 3자 일치)**: `npx tsc --noEmit` exit 0 ·
  `stableController.test.ts` **58/58 pass · fail 0**(이전 3 pass / 55 fail) · 회귀 5파일
  (`orchestrationKernel`·`typedExecution`·`autopilotLifecycle`·`executionBoundary`·`offlinePlanWorker`)
  **225/225 pass · fail 0** · `git status --short` = `?? node_modules` 한 줄.
- **mutation 2종**: `confirmCleanup()` 제거 → 40 pass / 18 fail · `beginDeliveryAttempt()` 제거 →
  56 pass / 2 fail. 각각 원복 후 58/58 재확인, mutation marker 잔존 0.
- **독립 리뷰**: fresh Fable 5 **read-only**(구현 worker transcript·자기평가 미전달) · 범위
  `8dd05f9..9a34c5d` · 판정 **`APPROVE — A=0, B=1, C=1`**. 리뷰어는 정적 검토에 더해
  위 3종 테스트와 `git diff --name-only`·package/lock diff·skip grep을 **직접 실행**했다.
- **신규 유예**: `B-17`(전달 실패 시 `failDeliveryAttempt` 미호출 → `activeAttemptId` 잔존) ·
  `C-43`(`startedIds` 변수명 오도). 상세는 roadmap §9.1.
- **미실행**: `npm test` · `test:exec` · `test:core` · 전체 acceptance · stress · live · 반복 3회 ·
  build/dist. 최종 전체 suite 1회는 M5 최종 handoff에 예약돼 있다.
- **다음 DAG task(미착수)**: managed process supervisor(+자손 정리 — **`B-F1` 개봉 필요**) →
  trusted Git → `autopilot` CLI.

## 2026-07-31 (V3 **M5c task 3A — 독립 재리뷰 `APPROVE — A=0, B=2, C=3`. Task 3A 완료, M5c·M5는 미완료** · 이 블록이 가장 최신이다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`e88c1ca55170370c8e24e111fcf8ea06bc1e845c` · 코드 커밋 `12fbf08`. **새 fresh Claude Opus 5 단일
세션**(이전 작성자 transcript·자기평가 **미상속** · subagent·병렬 writer 0 · 재개 아님).
Ponytail SessionStart hook **level `full`**. amend/rebase/reset/merge/stash · 원격 push/PR/merge ·
네트워크 · `gh` · MCP · 패키지 설치 · 의존성/lockfile 변경 · live 추론 · secret · deploy · DB ·
production · live billing · **프로세스 spawn 0**. 유일한 untracked 항목은 supervisor의
`node_modules` symlink이며 손대지 않았다(stage 0). **테스트 완화·삭제·skip 0**(추가만 2건).

**입력 권위**: `/private/tmp/m5c-task3a-revision5-codex-review-output.txt` — 독립 fresh Codex
`gpt-5.6-sol` xhigh read-only 재리뷰(범위 `7d3f547d6d47ec9f0cefa8904c8e45a52d80cab0..e88c1ca`),
판정 **`REVISE — A=1, B=2, C=3`**.

**최종 독립 권위**: `/private/tmp/m5c-task3a-revision6-codex-review-output.txt` — fresh Codex
`gpt-5.6-sol` xhigh read-only(세션 `019fb6d4-cad0-7232-bd2e-a33ca1390362` · 범위
`e88c1ca55170370c8e24e111fcf8ea06bc1e845c..e0043eff55f4520c899a728e30658f3d2b336ab1`),
판정 **`APPROVE — A=0, B=2, C=3`**. 정적 검토만 했고 테스트·빌드는 실행하지 않았다.

**정직한 판정: Task 3A는 독립 승인으로 완료됐지만 M5c 완료가 아니고 M5 완료도 아니다.** managed process supervisor·자손 정리 ·
trusted Git · **`StableController` 재작성/배선** · managed launcher · 첫 spawn · 구조화 리뷰 검증 ·
`autopilot` CLI · legacy 비활성화 · build/dist · M5d는 **여전히 미구현**이다. **다음 DAG task는
착수하지 않았다.**

### 직전 문서의 과대주장 정정

| 직전 주장(HEAD `e88c1ca`) | 실제(6차 독립 리뷰) | 이번 조치 |
|---|---|---|
| "A1 fixed — 남이 claim한 turn을 선점할 수 없다" | **bare 회계 공격만 닫혔다.** `issueOperationDispatchPermit()`은 대상 task의 claim과 run 전역 `chargedTurnIds`만 봤으므로 **두 running task가 둘 다 genuine permit으로** 같은 turn ID를 claim할 수 있었다. 5차 A1 테스트는 `chargeTurnUsage` 공격만 검증했다 | permit 발급 커밋에서 **run-wide live-claim uniqueness**를 강제하고, 같은 불변식을 store load에도 넣었다. genuine 충돌 회귀 테스트 2건 추가 |
| `C-1`(발행 seam) "성공을 만들 수 없다 / 임의 콜백 공개 API 없다" | **과대다.** 같은 프로세스에서 ambient fs 권한을 가진 코드가 `parentWalk` hook 안에서 승인 대상을 의도한 바이트로 만들면 뒤따르는 hash 비교가 canonical `already_applied`를 낸다. 다만 진짜 grant + 승인 경로/내용이 여전히 필요하므로 위조 권위 우회는 아니다 | 대장의 확률·영향·증거·기한(M5d handoff 전)을 정정했고, 최종 독립 리뷰 뒤 source/facade 주석도 같은 사실로 바로잡았다. shipped seam export 자체는 `C-1`로 open |
| pending 재발급 조건 "attemptedAt null + running + 만료/예산 게이트" | **여전히 과대.** 토큰 예산·attempt wall·no-progress·durable 신원·권위 과금 증거·preflight drift·claim 유일성까지 **모든 전진·권위 게이트**를 지나야 한다 | schema `pendingOperations.description`을 정확히 고쳤다 |
| "다음 task부터 `fable5` 모델" | **사용자 의도의 오기.** 사용자는 도구를 바꿀 것이며 **현재 Task 3A가 끝나면 Codex는 이후 작업을 전혀 시작하지 않는다** | 최종 독립 리뷰가 찾은 과거 handoff 2곳까지 전부 제거·폐기 문구로 정정했다 |

### 이번 A(유일) — 두 task가 같은 run-global turn ID를 claim

- **원인**: 과금 namespace는 run 전역(`accounting.chargedTurnIds`)인데 claim namespace는 task-local이었다.
- **공격 순서**: ① task A가 turn `X` claim ② task B도 `X`를 genuine permit으로 claim ③ B가 genuine charge
  ④ A의 genuine charge는 run 전역 중복 때문에 `turn_already_charged` ⑤ A는 task-local 과금 증거
  (`chargedPlanDigest`)를 얻지 못해 `dispatchTurnSettled(A)`가 영구히 false → claim을 정산도 교체도 못 하는
  **영구 교착**(양쪽 회계 부패 + run/DAG liveness).
- **수정**: `assertTurnClaimableBy(state, taskId, turnId)`가 그 turn을 claim한 **다른 task**를 찾으면
  `turn_conflict`로 fail closed한다. 발급 전 경로(재발급 포함)와 **커밋 draft** 양쪽에서 돈다.
  `assertUniqueDispatchClaims()`를 `assertReferentialIntegrity()`에 넣어 **커밋과 store load가 같은
  불변식**을 본다 → 손으로 만든 중복 live claim state는 `open()`에서 `invalid_state`.
- **보존**: 정확한 `(turnId, planDigest)` 멱등 재발급 revision/event 0 · 끝난 claim의 lazy replacement ·
  claim 없는 turn의 safety-only bare 회계(`B-12`) · genuine dispatch charging · task-local settlement ·
  5차 A1~A5 폐쇄 전부.
- **검증**: 구현 세션과 supervisor 재실행 모두 `npx tsc --noEmit` 0 error · focused 5파일
  **225/225 pass · fail 0** ·
  mutation(충돌 검사 3곳 제거 → 신규 테스트 2건 red, 원복 후 225/225 재확인).
- **미실행**: `npm test` · `test:exec` · `test:core` · 전체 acceptance · stress · live · 반복 3회 ·
  build/dist · M5d.
- **남은 B/C**: `B-F1`(첫 capability 소비자·첫 spawn 전) · `B-16`(첫 real typed-write 발행/배선 전,
  늦어도 M5c 통합) · `C-1`(발행 seam export 정리, M5d handoff 전 — 위 정정) · `C2`(draft-07 실검증,
  M5d 계약 handoff 전).
- **다음 작업**: **현재 Task 3A로 중단한다.** 다음 DAG task 미착수 · 이후는 사용자 별도 지시.

### 커밋(6차)

| 해시 | 내용 |
|---|---|
| `12fbf08` | A1 폐쇄(claim 유일성 커밋+load) · 회귀 2건 · schema C2 문구 정정 |
| `e0043ef` | 6차 문서 기록 · C-1/C2 과대주장 정정 |

## 2026-07-31 (V3 **M5c task 3A 5차 리비전 — 독립 재리뷰 `REVISE A=5·B=2·C=3`의 A 5건을 닫았다. M5c는 여전히 미완료다** · 위 최신 블록이 이 기록을 대체한다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`7d3f547d6d47ec9f0cefa8904c8e45a52d80cab0` · 코드 커밋 `de59348`. **새 fresh Claude Opus 5 단일
세션**(이전 작성자 transcript·자기평가 **미상속** · subagent·병렬 writer 0 · 재개 세션 아님 ·
Claude Code CLI `2.1.220` · 모델 `claude-opus-5`).
Ponytail SKILL.md **level `full`** 적용 —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`
(SessionStart hook이 전문을 주입했고 `Skill(ponytail:ponytail, full)`로 다시 확인했다 — 그 경로는
allowed working directory 밖이라 `Read`/`ls`가 권한으로 막혔고 skill 호출이 base directory와 전문을
돌려주었다). amend/rebase/reset/merge/stash · 원격 push/PR/merge · 네트워크 · `gh` · MCP ·
패키지 설치 · 의존성/lockfile 변경 · live Codex/Claude 추론 · secret · deploy · DB · production ·
live billing · **프로세스 spawn 0**. 유일한 untracked 항목은 supervisor가 제공한 `node_modules`
symlink이며 손대지 않았다(stage 0). **테스트 완화·삭제 0**(교체한 assertion 2건은 아래
§"교체한 assertion 전수"에 기록했다).

**입력 권위**: `/private/tmp/m5c-task3a-revision4-codex-review-output.txt` — 독립 fresh Codex
`gpt-5.6-sol` xhigh read-only 재리뷰(세션 `019fb685-3f2f-7512-aa13-9d12f3e47585` ·
범위 `20530b0038266b66b2f83cbc36bf7f358dab1c55..7d3f547`), 판정 **`REVISE — A=5, B=2, C=3`**.

**정직한 판정: 이 리비전도 M5c 완료가 아니고 M5 완료도 아니다.** managed process supervisor·자손 정리 ·
trusted Git · **`StableController` 재작성/배선** · managed launcher · 첫 spawn · 구조화 리뷰 검증 ·
`autopilot` CLI · legacy 비활성화 · build/dist · M5d는 **여전히 미구현**이다. **다음 DAG task는
착수하지 않았다.** **self-approve하지 않는다.**

### 직전 문서의 과대주장 정정

| 직전 주장(HEAD `7d3f547`) | 실제(5차 독립 리뷰) | 이번 조치 |
|---|---|---|
| "A1 fixed — 효과 게이트를 per-task 증거로 옮겼다" | **효과 승인만 막았다.** `chargeTurnUsage`는 여전히 caller-selected `{taskId, turnId}`를 받고 중복 namespace가 run 전역이었으므로, sibling이 생산 task의 **claim된 turn ID를 0 토큰으로 선점**해 ① 생산 task의 진짜 사용량을 **영구히 과금 불가**로 만들고 ② `dispatchTurnSettled`가 run 전역 turn ID를 정산 권위로 봤으므로 **거짓 정산 위에서 claim 교체**를 열 수 있었다. 테스트가 이것을 "DoS일 뿐"이라고 **명시적으로 단정**하고 있었다 | bare 회계가 **남이 claim한 turn**을 커밋 안에서 거부하고, 정산 권위를 `accounting`에서 떼어 **task-local 진짜 과금 증거**로 옮겼다. 불안전한 assertion을 선점·거짓 정산 전수 거부로 **교체** |
| "A2 fixed — 임의 콜백 표면 삭제" | **콜백만 지웠다.** 새로 만든 `writeFileEffect.ts`가 `judgeWriteFile(auth, op)`를 **export**했고 `DispatchAuthority`는 평범한 구조적 interface였다 → 직접 import로 **위조 authority 하나로** 파일을 열어 hash하고 디렉터리를 fsync하고 성공 marker를 받을 수 있었다. 그리고 permit·grant·outcome·채널 등록부가 **모듈 전역**이라 durable ID가 같은 두 workspace가 서로 교차 과금·등록·표시·영수증을 하고 live grant key까지 죽였다 | `writeFileEffect.ts`를 **삭제**하고 집행기를 kernel 모듈 **사설 함수**로 옮겼다. 모든 handle이 **발급 인스턴스**를 들고 있고 수신 메서드 5종이 `this`와 동일 객체인지 본다. `LIVE_GRANTS`는 발급자별 `Map` |
| "A2 — 집행 경계 진입을 효과보다 먼저 durable에 적는다" | **순서만 맞았다.** 표시 커밋은 safety-only라 deadline을 **의도적으로 보지 않는데** 집행기는 표시 **이전**의 판정을 들고 들어갔다 → 첫 시계 읽기에 유효했던 deadline이 커밋 도중 지나도 효과가 나갔다. 이전 테스트는 **정지한 시계**의 등호만 봤다 | 표시 커밋 **이후** 권위를 전수 재확인한 뒤에만 집행기에 들어간다. 표시 직후 경계로 넘어가는 clock으로 **등호 4종 + 1ms 전 대조군** 추가 |
| "A3 fixed — 정합화 경로가 열려 있다" | **용량 경계를 빠뜨렸다.** operation은 turn 단위(64)·영수증은 attempt 단위(64) 상한인데 `beginOperation`은 동시 pending만 봤으므로 뒤 turn이 영수증 64건 위에서 65번째를 열 수 있었고 그 pending은 **영구 미아**였다 | 새 pending마다 **영수증 자리를 먼저 예약**한다(커밋 + store load 양쪽). 다중 turn 경계 테스트와 crafted over-cap load 테스트 추가 |
| pending schema "재시작하면 handle-free 경로" | **부정확.** 재시작한 `running` kernel도 `attemptedAt: null`이면 새 permit을 받아 grant를 재발급한다. handle-free가 **필수인 것**은 attempted·cleaning·전진 게이트 폐쇄 경우다 | schema description이 갈림길을 attemptedAt + task 상태 + 전진 게이트로 정확히 적는다(A5 교차 불변식도 함께) |

### 커밋

| 해시 | 내용 |
|---|---|
| `de59348` | 코드·schema·테스트 (A1~A5 · pending schema 서술 정정 · `writeFileEffect.ts` 삭제) |
| (이 문서 커밋) | 진행/handoff 문서 + 로드맵 §9.1 대장 |

### 변경 파일 (삭제 1 · 변경 6)

- **삭제** `src/exec/writeFileEffect.ts` — 4차 판이 새로 만든 파일이다. 그 파일이 `judgeWriteFile`을
  export했고 `DispatchAuthority`가 위조 가능한 구조적 interface였으므로 **직접 import 우회**가 됐다
  (A3). 이름 변경·`@internal`·barrel 제외·exports map은 리뷰가 명시적으로 배제했으므로 **파일을 없애고**
  집행기를 grant 등록부와 같은 모듈로 옮겼다.
- `src/exec/orchestrationKernel.ts` — A1 bare 회계 claimant 거부 + `dispatchTurnSettled` task-local화 ·
  A2 `issuer` 필드 3종 + 수신 메서드 5종 대조 + `LIVE_GRANTS` 발급자별 격리 · A3 집행기 사설 이관
  (`WRITE_EFFECT_CODES`·`resolveApprovedOperation`·`resolveWriteAuthority`·seam은 순수/테스트용으로 유지) ·
  A4 표시 커밋 이후 권위 재확인 · A5 `beginOperation` 영수증 자리 예약.
- `src/exec/orchestrationStore.ts` — A5 load 교차 불변식
  (`operationReceipts + pendingOperations <= maxOperationReceipts`).
- `src/exec/typedExecution.ts` — import·재수출 경로를 kernel로 옮기고 헤더 계약 서술을 갱신했다
  (공개 facade 계약 자체는 **불변** — `applyWriteFile`/`resolveWriteFileAuthority`/
  `resolveProcessLaunchCapability` 시그니처 동일).
- `schemas/orchestration_run_state.schema.json` — pending 정합화 경로 서술 정정 + A5 교차 불변식 2곳.
- `src/exec/typedExecution.test.ts` · `src/exec/autopilotLifecycle.test.ts` — 아래 참조.

**무변경 확인**: `package.json` · `package-lock.json` · `AGENTS.md` · `CLAUDE.md` ·
`orchestrationTypes.ts` · `approvalManifest.ts` · `typedPlan.ts` · `agentMessage.ts` ·
`executionBoundary.ts` · `offlinePlanWorker.ts` · `stableController.ts` · managed process/controller ·
trusted Git · provider/CLI · legacy exec/mission · `scripts/*` · tracked `dist` · 다음 DAG task 코드.
두 번째 scheduler·대안 controller·신규 런타임/dev 의존성 **0**.

### 교체한 assertion 전수 (완화가 아니라 강화 — 삭제·skip 0)

1. `typedExecution.test.ts` — 구 `A1: 생산 turn 과금은 kernel 발급 권위에만 묶인다…` ⓐ/ⓒ:
   sibling의 bare 과금이 **통과하는 것**과 그 결과를 **"남의 과금은 DoS일 뿐 우회가 아니다"** 로 단정하던
   두 assertion. 실제로는 생산 task의 진짜 사용량이 영구히 과금 불가가 되고 거짓 정산으로 claim 교체가
   열렸다 → 테스트를 `A1: bare 회계는 남이 claim한 생산 turn을 선점·정산할 수 없다`로 바꾸고
   **선점 2종 거부 · 회계·revision 불변 · 거짓 정산 거부 · 진짜 생산자 과금 성공 · 미확정 0까지 claim 유지 ·
   정산 후 교체 · claim 없는 turn 회계 허용**을 단정한다.
2. `autopilotLifecycle.test.ts` — `만료 후: 전진은 닫히고 safety-only reducer만 통과한다`에서 **다른 kernel
   인스턴스가 발급한 진행 채널을 만료 게이트까지 수락하는 것**을 정상으로 고정하던 assertion
   (`manifest_expired` 기대). 발급자 격리 뒤에는 **더 이른 자리**에서 `invalid_progress_channel`이다 →
   그 코드로 바꾸고, 원래 사실("만료 뒤 진행으로 시계를 되돌릴 수 없다")을 유지하기 위해
   **만료된 인스턴스는 채널을 새로 발급받을 수도 없다**(`startPreparedTask` → `manifest_expired`)를 더했다.

### 실행한 검증 (명령과 카운트 그대로)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | exit 0 (경고 0) |
| `npx tsx --test src/exec/typedExecution.test.ts` | **62/62 pass**(신규 5건 포함) |
| `npx tsx --test src/exec/orchestrationKernel.test.ts` | **103/103 pass** |
| `npx tsx --test src/exec/autopilotLifecycle.test.ts` | **28/28 pass** |
| `npx tsx --test src/exec/executionBoundary.test.ts` + `offlinePlanWorker.test.ts` | 위 3종과 합쳐 **223/223 pass** |
| `node scripts/m4a-offline-acceptance.mjs` | PASS=32 FAIL=0 (exit 0) |
| `node scripts/m4b-offline-acceptance.mjs` | PASS=45 FAIL=0 (exit 0) |
| `node scripts/m4c-offline-acceptance.mjs` | PASS=80 FAIL=0 (exit 0) |
| `git diff --check` | 출력 0 |
| `npx tsx --test src/exec/stableController.test.ts` | **3 pass / 55 fail** — 실패 55건 전부 `manifest_pre_m5c_unsupported`(변경 전후 동일 · **다음 DAG task 범위**, 이 세션은 그 파일을 수정하지 않았다) |

**미실행(정직)**: `npm test` · `npm run test:core` · `npm run test:exec` · 전체 acceptance ·
stress(`acceptance:stress:m3d2`) · 반복 3회 · live runner · 실제 Claude/Codex 추론 · build/dist.
지시에 따라 위험 비례 focused 범위만 돌렸다 — **전체 suite 1회는 M5 handoff 게이트로 남는다.**

### mutation 증거 (각 신규 게이트 · 원복 뒤 tree clean · 흔적 grep 0)

| id | 무엇을 되돌렸나 | 결과 |
|---|---|---|
| `MUT-1` | A1 bare 회계의 claimant 검사 제거 | `A1: bare 회계는…` **red** (`no-error` ≠ `turn_conflict`) |
| `MUT-2` | A2 `record.issuer !== issuer` 검사 무력화 | A2 테스트 **2건 red** |
| `MUT-3` | A2 `LIVE_GRANTS`를 모듈 전역 공유 `Map`으로 되돌림 | A2 교차 공격 테스트 **red** (`dispatch_grant_spent` — B의 발급이 A의 grant를 소비) |
| `MUT-4` | A3 `judgeWriteFile`을 다시 `export` | A3 표면 테스트 **red** ("kernel.judgeWriteFile이 위조 authority로 집행 결과를 냈다") |
| `MUT-5` | A4 표시 커밋 이후 재확인 제거(옛 판정 재사용) | A4 테스트 **red** (만료 **등호**에서 `already_applied` = 거짓 성공) |
| `MUT-6` | A5 `beginOperation` 영수증 자리 예약 제거 | A5 다중 turn 테스트 **red** (`invalid_state` — load layer가 대신 잡는다) |
| `MUT-7` | A5 store load 교차 불변식 제거 | A5 crafted-load 테스트 **red** (`state_event_binding_mismatch`) |
| **`MUT-6+7`** | A5 **두 layer 동시 제거** | operation 65가 **실제로 열린다**(`no-error`) = 4차 판의 영구 미아 재현 |
| `MUT-8` | A1 `dispatchTurnSettled`를 run 전역 `chargedTurnIds`로 되돌림 | **red 없음 — 193/193 pass.** 정직한 판정: claimant 검사(A1ⓐ)가 부패 상태를 도달 불가로 만들기 때문에 이 layer는 **단독으로는 관측되지 않는 defense-in-depth**다. 리뷰가 요구한 "정산은 task-local 증거에서" 계약 자체는 코드로 성립한다 |
| **`MUT-8+1`** | A1 **두 layer 동시 제거** | A1 테스트 **red** — 4차 판 동작(sibling 선점 성공)이 그대로 재현된다 |

원복 증거: 각 mutation 뒤 `git checkout -- <file>` → `git status --short`가 `?? node_modules` 한 줄
(= 커밋 `de59348`과 바이트 동일) · `grep -rn "MUT[1-8]" src/ schemas/` → **0건** · 원복 후
`npx tsc --noEmit` exit 0 + focused **223/223 pass** 재확인.

### 남은 A/B/C (트리거 포함)

- **열린 A: 없다**(이 리비전이 A 5건을 닫았다 — 다만 **독립 재리뷰 전에는 self-approve하지 않는다**).
- **`B-F1`** (P1, open) — managed launcher 첫 소비자가 현재 권능을 실행 권위로 믿으면 안 된다.
  **트리거: 첫 capability 소비자 또는 첫 spawn 전.** 담당 managed-launcher 구현자.
- **`B-16`** (P1, open) — typed write가 새 파일을 만들지 못한다.
  **트리거: 첫 real typed-write 산출물 발행/배선 전, 늦어도 M5c 통합.** 담당 M5c 통합 구현자.
- **`B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B`** (P1, open) — live 게이트·lifecycle 잔여. 변화 없음.
- **`C-1`(발행 seam export)** (P2, open) — 위치만 kernel 모듈로 옮겼고 표면 개수는 그대로(4종).
  hook이 던진 것은 전부 `write_failed`로 정규화되므로 거짓 성공·승인 우회는 불가능하고 남는 것은 DoS다.
  **트리거: shipped export 정리, 늦어도 M5d handoff.**
- **`C2`(draft-07 실검증)** (P3, open) — **트리거: 외부 provider/worker schema handoff 전, 늦어도 M5d.**
- 나머지 C(`C-5` `C-18` `C-19` `C-26` `C-29`~`C-39`)는 변화 없음. 상세는 로드맵 §9.1 5차 리비전 표.

## 2026-07-31 (V3 **M5c task 3A 4차 리비전 — 독립 재리뷰 `REVISE A/P1=3`의 A 3건을 닫았다. M5c는 여전히 미완료다** · 그 시점 기록 · 위 블록이 이를 정정한다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`20530b0038266b66b2f83cbc36bf7f358dab1c55` · 코드 커밋 `5ec0a57`. **새 fresh Claude Opus 5
단일 세션**(이전 작성자 transcript·자기평가 **미상속** · subagent·병렬 writer 0 · 재개 세션 아님).
Ponytail SKILL.md **level `full`** 적용 —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`
(SessionStart hook이 전문을 주입했고 `Skill(ponytail:ponytail, full)`로 다시 확인했다. 그 경로는
allowed working directory 밖이라 `Read`/`ls`는 권한으로 막혔고, skill 호출이 전문을 돌려주었다).
amend/rebase/reset/merge · 원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 ·
의존성/lockfile 변경 · live Codex/Claude 추론 · secret · deploy · DB · production · live billing ·
**프로세스 spawn 0**. 유일한 untracked 항목은 supervisor가 제공한 `node_modules` symlink이며 손대지 않았다
(stage 0). **테스트 완화·삭제 0**(교체한 assertion 2건은 아래 §"교체한 assertion 전수"에 기록했다).

**입력 권위**: `/private/tmp/m5c-task3a-revision3-codex-review-output.txt` — 독립 fresh Codex
`gpt-5.6-sol` xhigh read-only 재리뷰(세션 `019fb648-ae3a-7252-ada5-e23edd37770a` ·
범위 `2956ffcf01551de97ac123420190c466893b5829..20530b0`), 판정
**`REVISE — A/P1 = 3; 현행 A4/B1/B2/C1/C2 closed; 미래 B-F1·B-16 유지`**.

**정직한 판정: 이 리비전도 M5c 완료가 아니다.** managed process supervisor·자손 정리 · trusted Git ·
**`StableController` 재작성/배선** · 구조화 리뷰 검증 · `autopilot` CLI · legacy 비활성화 · build/dist ·
M5d는 **여전히 미구현**이다. **self-approve하지 않는다.**

### 직전 문서의 과대주장 정정

| 직전 주장(HEAD `20530b0`) | 실제(4차 독립 리뷰) | 이번 조치 |
|---|---|---|
| "A1 fixed — 순서를 계약으로 만들었다(permit → 과금 → grant → 효과)" | **순서만 맞았다.** 효과 승인 근거가 **run 전역 bare turn ID**(`accounting.chargedTurnIds`)였고 `chargeTurnUsage`는 `{taskId, turnId, 카운트}`를 호출자가 골랐다 → **claim 없는 sibling이 생산 task의 turn을 0 토큰으로 과금해 남의 효과를 승인**할 수 있었다. 진행 자격은 `getTask()`로 그대로 읽히는 **durable lease**였고 `seq`는 모양만 봤다(재생·역순 통과). 공용 시계 검사가 `state.updatedAt`을 보지 않아 **safety-only 커밋이 durable 시각을 되돌려** wall/no-progress 창을 다시 열 수 있었다 | 과금을 권위 없는 것과 **permit 기반 권위 있는 것**으로 갈랐고, 효과 게이트를 **이 task의** `turnId`+`chargedPlanDigest`로 옮겼다. 진행은 kernel 발급 **brand 채널 + 단조 seq**로만. `assertClockSane`에 `updatedAt` 추가 |
| "A2 fixed — 위조·재생·치환·중복 집행 불가" | **부분적으로만 사실.** 공개 `executeUnderGrant(grant, op, 임의콜백)`이 **아무 효과도 내지 않는 콜백**의 반환값을 진짜 `applied`로 굳혔고, 첫 효과 뒤 영수증 커밋 전 **재발급**으로 두 번째 효과가 가능했으며, 부분 효과 뒤 예외를 `failOperation`이 **평범한 실패로 지웠다** | 임의 콜백 표면 **삭제** → kind별 고정 진입점 + 고정 집행기. 집행 경계 진입을 **효과보다 먼저** durable에 적고(`attemptedAt`), 표시 뒤에는 재발급·평범한 실패 종결 둘 다 거부 |
| "A3 fixed — 영수증 정합화는 만료·deadline·cleaning 뒤에도 가능하다" | **같은 프로세스에서만 사실이었다.** permit·grant·outcome이 전부 프로세스 메모리 `WeakMap`이라 **재시작하면** `cleaning`/만료된 `running` pending은 새 permit도 옛 handle도 없어 **영구 미아**였고 attempt 이탈 전이가 영구 stall이었다 | 신규 `reconcileUncertainOperation()` — handle 0, durable 신원 8종 전수 대조, marker는 durable 진실에서 파생, **성공을 만들 입력 없음** |
| "`C-42`는 유예(C)" | **유예가 아니라 이번에 구현으로 닫혔다** | 대장에서 `C-42`를 폐기(closed)로 표시 |
| schema/문서 3곳 | `dispatchTurnId` 서술이 "과금이 claim을 지운다"였고, pending schema가 **없는** 재시작 경로를 주장했으며, schema 테스트 이름이 "동치"라 draft-07 실행처럼 읽혔다 | 셋 다 정정(아래 C-1) |

### 커밋

| 해시 | 내용 |
|---|---|
| `5ec0a57` | 코드·schema·테스트 (A1~A3 · C-1 문서/schema 정정 · M4 fixture clock) |
| (이 문서 커밋) | 진행/handoff 문서 + 로드맵 §9.1 대장 |

### 변경 파일 (신규 1 · 변경 11)

- **신규** `src/exec/writeFileEffect.ts` — `write_file`의 **고정 집행기**(권위 해석 + 파일 시스템 판정 +
  테스트 seam). kernel을 **`import type`으로만** 참조하므로 방출된 런타임 그래프는
  `kernel → writeFileEffect` 한 방향이다(임의 콜백을 지우면서 순환이 생기지 않게 하는 유일한 이유).
- `src/exec/orchestrationKernel.ts` — `chargeDispatchTurnUsage` 신설 · `chargeTurnUsage` 권위 분리 ·
  효과 게이트를 per-task 증거로 이동 · `assertClockSane`에 `updatedAt` · brand된 worker 진행 채널
  (`startPreparedTask` 반환 변경 `{task, progress}`) · `executeUnderGrant` **삭제** →
  `executeWriteFileOperation` · `#markOperationAttempted` · `assertNotAttempted` ·
  `reconcileUncertainOperation` · `genuinePermit`/`killLiveGrant`.
- `src/exec/typedExecution.ts` — 공개 facade로 축소(파일 시스템 판정을 `writeFileEffect.ts`로 이관 ·
  `applyWriteFile`은 kernel 고정 진입점의 얇은 이름).
- `src/exec/orchestrationTypes.ts` — `chargedPlanDigest` · `PendingOperation.attemptedAt` ·
  `operation_attempted` event(+safety-only) · `outcome_unknown` marker · `dispatchTurnId` 서술 정정.
- `src/exec/orchestrationStore.ts` — 위 세 필드의 closed key·검증·교차 불변식 ·
  `OPERATION_RECEIPT_MARKERS`에 `outcome_unknown`.
- `schemas/orchestration_run_state.schema.json` — 같은 계약 반영 + 서술 정정 2건.
- `src/exec/typedExecution.test.ts` · `src/exec/autopilotLifecycle.test.ts` ·
  `src/exec/orchestrationKernel.test.ts` — 계약 변경 반영 + 신규 공격 테스트.
- `scripts/m4a|m4b|m4c-offline-acceptance.mjs` — `makeClock` tick을 **프로세스 전역 단조**로
  (이전 fixture는 kernel 재개 시 시각을 0으로 되돌려 **시계 역행 자체를 흉내 내고 있었다**).

**손대지 않은 것**: `stableController.ts`(+테스트 — **열지도 않았다**) · managed process · trusted Git ·
reviewer · CLI · legacy `exec`/`mission` · `orchestrationStore` 발행 내부 · `executionBoundary.ts` ·
`typedPlan.ts` · `offlinePlanWorker.ts` · `approvalManifest.ts` · package/lock · tracked `dist/**` ·
`AGENTS.md`/`CLAUDE.md`. 두 번째 scheduler·대안 controller·신규 런타임/dev 의존성 **0**.

### A 해소 (3/3)

- **A1 — 생산 turn 회계와 진행 권위를 실제 권위에 묶었다.**
  ⓐ **과금 두 갈래**: `chargeTurnUsage`(권위 없음)는 claim이 열려 있으면 `turn_conflict`이고
  `execution.chargedPlanDigest`를 **남기지 않는다** — 만료·재시작 뒤 "이미 태운 자원을 적는 일"은
  그대로 가능하다(`B-12` 유지). 신규 `chargeDispatchTurnUsage({permit,…})`만 신원을 **kernel 발급
  permit**에서 가져오고 `chargedPlanDigest`를 남긴다. 효과 게이트는 run 전역 목록이 아니라 **이 task의**
  `execution.turnId` + `chargedPlanDigest`를 claim된 `dispatchTurnId`/`dispatchPlanDigest`/`attemptId`와
  **함께** 본다 → 과금은 run/task/attempt/turn/계획 전부에 묶인다. store가
  `chargedPlanDigest !== null → turnId !== null`을 load에서도 본다(손편집 차단).
  ⓑ **진행은 brand된 worker 채널로만.** `startPreparedTask()`가 시작을 커밋한 그 순간 채널 하나를
  발급하고(모듈 사설 `WeakMap`), 사용할 때마다 현재 durable run/task/attempt/lease를 다시 대조하며,
  `seq`는 **성공한 커밋에 대해 엄격 증가**여야 한다. 복사한 lease · 구조 사본 · `Proxy` · 재생 · 역순 ·
  sibling 채널이 전부 거부되고, 늦은 진행은 소진된 창을 되살리지 못한다(등호 규칙 유지).
  ⓒ **시계 역행은 모든 mutation에서 거부된다.** `assertClockSane`이 `now < state.updatedAt`도 본다 —
  `#mutate` 하나를 전진·safety-only가 모두 지나므로 우회로가 없다.
- **A2 — 성공 provenance와 pending당 효과 1회.**
  ⓐ **임의 콜백 표면 삭제.** `executeUnderGrant(grant, op, effect)`를 지우고
  `executeWriteFileOperation(grant, op)` 하나만 남겼다. 그 안에서 부르는 집행기는 정적으로 고정된
  `writeFileEffect.judgeWriteFile`이고, `run_process`에는 성공 집행기가 **아예 없다**.
  두 모듈의 export를 전수 훑어 "3번째 콜백 인자를 받는 함수 0"을 테스트가 단정한다.
  ⓑ **집행 경계 진입을 효과보다 먼저 durable에 적는다**(`PendingOperation.attemptedAt` +
  safety-only `operation_attempted`). 표시된 pending은 `beginOperation`이 재발급하지 않고
  (`operation_attempt_uncertain`) `failOperation`도 거부한다 → `effect(g1) → 재발급 → effect(g2)`와
  "부분 효과 뒤 예외를 평범한 실패로 지우기"가 둘 다 닫혔다.
- **A3 — 재시작이 durable pending을 영구 미아로 만들지 않는다.**
  신규 `reconcileUncertainOperation()`은 **kernel 발급 handle을 하나도 요구하지 않는다**.
  `run/task/attempt/turn/plan/operation/kind/authority` 8종을 durable pending과 전수 대조하고
  (불일치는 pending·영수증·revision을 하나도 건드리지 않는다), marker는 **호출자 입력이 아니라
  durable 진실에서 파생**된다(`attemptedAt !== null` → `outcome_unknown` · `null` → `failed`).
  path·resultSha256·exitCode는 항상 `null`이며 "외부 효과가 일어나지 않았다"고 단정하지 않는다.
  safety-only라 만료·예산 deadline·`running`/`cleaning` 어디서나 열려 있고, 정합화가 끝나면 같은
  pending 신원의 살아 있는 grant를 폐기하며 cleanup·settle이 정상 진행된다.

### 인접 문서·schema 정정 (C-1)

- `TaskExecution.dispatchTurnId`(코드·schema): "과금이 claim을 지운다" → **lazy replacement**
  (과금은 claim을 유지하고, 끝난 claim만 다음 turn의 permit 요청이 교체한다).
- pending schema: **존재하지 않는** 재시작 정합화 경로 주장을 지우고 실제 2종을 적었다
  (같은 프로세스 handle + `attemptedAt === null` → 멱등 재집행 / 그 밖 전부 → safety-only 정합화).
- schema 대조 테스트 4종 이름을 **"key·enum·상한이 구조적으로 일치한다"**로 바꾸고 헤더에
  "draft-07 validator를 실행하지 않는다"를 명시했다. **draft-07 구현은 여전히 추가하지 않았다.**

### 교체한 assertion 전수 (완화 아님 — 전부 강화)

| 파일 | 이전 assertion | 왜 교체했나 | 지금 |
|---|---|---|---|
| `typedExecution.test.ts` "A2: 집행이 던진 grant…" | `failOperation(failed)`가 pending을 닫는다 | **부분 외부 효과 뒤 예외를 평범한 실패로 지우는 동작을 정상으로 고정**하고 있었다(리뷰 A-2) | `failed`·`denied` 둘 다 `operation_attempt_uncertain` · 재발급도 거부 · `outcome_unknown` 정합화만 |
| `typedExecution.test.ts` "A2: 등록·발행·영수증 사이에서 재시작…" ③ | attempted pending을 재시작 뒤 **다시 집행**해 `already_applied`로 수렴 | **집행 경계에 들어간 pending의 재집행을 정상으로 고정**하고 있었다(리뷰 A-2) | 재발급 거부 + durable 신원만으로 `outcome_unknown` 수렴(바이트 inode 불변 확인 유지) |

### 검증 (실측 · 이 세션이 실제로 실행한 것)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | 0 error |
| `npx tsx --test src/exec/typedExecution.test.ts` | **56/56** |
| `npx tsx --test src/exec/autopilotLifecycle.test.ts` | **28/28** |
| `npx tsx --test src/exec/orchestrationKernel.test.ts` | **103/103** |
| `npx tsx --test src/exec/executionBoundary.test.ts` | **20/20** |
| `npx tsx --test src/exec/offlinePlanWorker.test.ts` | **10/10** |
| 위 5개 파일 **한 번에** | **217/217** |
| `node scripts/m4a-offline-acceptance.mjs` | **PASS=32 FAIL=0** |
| `node scripts/m4b-offline-acceptance.mjs` | **PASS=45 FAIL=0** |
| `node scripts/m4c-offline-acceptance.mjs` | **PASS=80 FAIL=0** |
| `git diff --check` / `git diff --cached --check` | clean |

**알려진 red(실측 · 이번 변경 전후 동일)**: `stableController.test.ts` **3 pass / 55 fail** —
controller가 아직 `startScheduledBatch()`를 부른다. **다음 DAG task 범위**이며 이 세션은 그 파일을
**수정하지 않았다**(측정만 했다).

### mutation 7종 (전부 red 확인 후 정확히 원복)

| # | 주입 | 기대(=실제) |
|---|---|---|
| 1 | 효과 게이트를 run 전역 `chargedTurnIds.includes(turnId)`로 되돌림 | `A1: 생산 turn 과금은 kernel 발급 권위에만…` **1 fail** |
| 2 | `assertClockSane`에서 `now < state.updatedAt` 제거 | `A1: 시계 역행은 safety-only 커밋에서도 거부된다` **1 fail** |
| 3 | `recordProgress`의 단조 `seq` 검사 무력화 | `A1: 진행은 brand된 단조 worker 채널로만…` **1 fail** |
| 4 | `executeWriteFileOperation`에서 `rec.markAttempted()` 제거 | **5 fail**(A2 2종 · A3 2종 · 재시작 수렴) |
| 5 | `beginOperation` 재발급 경로의 `assertNotAttempted` 제거 | **3 fail**(A2 2종 · 재시작 수렴) |
| 6 | `reconcileUncertainOperation`의 kind·authority 대조 제거 | `A3: 재시작 뒤 cleaning pending…` **1 fail** |
| 7 | `failOperation`의 durable attempted 확인 제거 | `A2: 집행이 던진 grant…` **1 fail** |

원복 증거: 7건 모두 `git checkout -- src/exec/orchestrationKernel.ts`로 되돌린 뒤
`git status --short` = `?? node_modules` **한 줄뿐**(추적 파일 변경 0) ·
`grep -rn "MUTATION-[1-7]" src schemas scripts` **0건** · `npx tsc --noEmit` 0 error ·
5개 파일 합계 **217/217** 재확인.

### 미실행 (정직)

`npm test` · `npm run test:exec` · `npm run test:core` · 전체 `acceptance.sh` · stress ·
`acceptance:stress:m3d2` · live runner · 반복(3회) · build/dist · 실제 Claude/Codex 추론 · MCP · push.
**최종 전체 suite 1회는 M5 최종 handoff에 예약**돼 있다(지시대로 이 세션에서 돌리지 않았다).
`stableController.test.ts`는 red 수치 확인 목적으로만 실행했고 **수정하지 않았다**.

### 남은 것 / 다음 DAG task (이 세션은 **시작하지 않았다**)

`StableController` 재작성·배선 · managed process supervisor + 자손 정리(`B-13`/`C-18`) ·
trusted Git(`C-26`) · 구조화 리뷰 검증(`C-19`/`C-35`) · `autopilot` CLI · legacy `exec`/`mission`
비활성화 · build/dist · **첫 spawn** · M5d · live. (**정정 — 6차 리비전**: 이 자리의 `fable5` 모델
문구는 사용자 의도의 오기였다. 사용자는 도구를 바꿀 것이며 **현재 Task 3A 마감 후 Codex는 이후 작업을
시작하지 않는다** — 이후는 사용자 별도 지시.) 이 리비전은 레포 규칙대로 fresh Claude Code Opus 5로 진행했다.

**열린 게이트**: `B-16`(typed write 신규 발행 fail closed — 첫 typed-write 산출물 배선 전) ·
**신규 `B-F1`**(managed launcher 첫 소비자 전: 1회 소비 · 살아 있는 pending/grant · durable 재독 ·
spawn 직전 node/entrypoint digest 재검증). 상세는 로드맵 §9.1 4차 리비전 절.

---

## 2026-07-31 (V3 **M5c task 3A 3차 리비전 — 독립 재리뷰 `REVISE A=4·B=2·C=3`의 A 4건 + B 2건 + C 3건을 닫았다** · **그 시점 기록** — 위 4차 리비전 블록이 A1~A3를 다시 열어 정정했다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`2956ffcf01551de97ac123420190c466893b5829` · 종료 HEAD 아래 커밋 표 참조. **새 fresh Claude Opus 5
단일 세션**(이전 작성자 transcript·자기평가 **미상속** · subagent·병렬 writer 0 · 재개 세션 아님).
Ponytail SKILL.md **level `full`** 적용 —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`
(SessionStart hook이 전문을 주입했고 `Skill(ponytail:ponytail, full)`로 다시 확인했다).
amend/rebase/reset/checkout·stash · 원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 ·
의존성/lockfile 변경 · live Codex/Claude 추론 · secret · deploy · DB · production · live billing ·
**프로세스 spawn 0**. 유일한 untracked 항목은 supervisor가 제공한 `node_modules` symlink이며 손대지 않았다.
**테스트 완화·삭제 0**(교체한 assertion은 아래 §"교체한 assertion 전수"에 전부 기록했다).

**입력 권위**: `/private/tmp/m5c-task3a-revision2-codex-review-output.txt` — 독립 fresh Codex
`gpt-5.6-sol` xhigh read-only 재리뷰(세션 `019fb5fb-89ec-7e40-90a9-4a4e7e66d3c2` ·
범위 `16cdc87..2956ffc`), 판정 **`REVISE — A=4, B=2, C=3`**.

**정직한 판정: 이 리비전도 M5c 완료가 아니다.** managed process supervisor·자손 정리 · trusted Git ·
**`StableController` 재작성/배선** · 구조화 리뷰 검증 · `autopilot` CLI · legacy 비활성화 · build/dist ·
M5d는 **여전히 미구현**이다. **self-approve하지 않는다.**

### 직전 문서의 과대주장 정정

| 직전 주장(HEAD `2956ffc`) | 실제 | 이번 조치 |
|---|---|---|
| "A1 fixed — dispatch 권위를 turn/계획에 durable하게 묶었다" | **부분적으로만 사실**. 생산 turn은 효과 **뒤에야** 과금될 수 있었고(과금이 claim을 닫았으므로) 그래서 토큰 게이트가 항상 **한 turn 뒤처진 총량**을 봤다. 늦은 `recordProgress`가 소진된 창을 되살렸다. 시계 역행이 `updatedAt`에 대해 막히지 않았다 | 과금과 turn 닫기를 분리하고 **과금 → grant** 순서를 강제했다. 늦은 진행 거부 + lease/이벤트 provenance. `updatedAt` 단조성 |
| "A2 fixed — 위조·재생·치환·중복 불가" | **부분적으로만 사실**. 같은 pending에 **살아 있는 grant가 여러 개**였고(둘 다 소진 가능), `recordOperationReceipt`가 **호출자 구조체**를 받았으며, `resolveProcessLaunchSpec`이 **spawn 없이** 성공 자격을 만들었다 | pending 신원당 live grant 1개 · `executeUnderGrant` + opaque outcome handle · 권능 발급은 순수 판정 |
| "A3 fixed(예방) — 교체를 손대기 전에 거부" | **정확했지만 좁았다**. 교체만 막았고 **신규 발행의 최종 `link(2)` pathname 창은 그대로**였다 | 신규 발행도 fail closed(`write_publish_unsupported`) |
| "B1 fixed — 정리 실패를 성공으로 삼키지 않는다" | **부분적으로만 사실**. unlink 뒤 부모 fsync·truncate 뒤 파일 fsync가 없었고 1차 예외가 정리 실패를 은폐했다 | temp 경로 소멸로 앞 둘이 성립하지 않게 됐고, 복합 처리(정리 미확인 우선)를 넣었다 |
| "`B-10` fixed — 하드 게이트 해제" | **과장이었다**. `data: string[]`에 action별 의미가 없었고 `ProcessLaunchSpec`은 공개 구조적·재생 가능 값이었다 | action별 `{planPath}` 계약 + opaque `ProcessLaunchCapability` |
| "`C1` 재발급은 멱등" | **문서만 그랬다** — 매번 커밋했다 | 값이 같으면 커밋하지 않는다(테스트가 event 줄 수까지 단정) |

### 커밋

| 해시 | 내용 |
|---|---|
| `d4a6596` | 코드·schema·테스트 (A1~A4 · B1 · B2/`B-10` · C1~C3) |
| (이 문서 커밋) | 진행/handoff 문서 + 로드맵 §9.1 대장 |

### 변경 파일 (신규 0 · 변경 10)

- `src/exec/orchestrationKernel.ts`(+테스트) — 과금·turn 닫기 분리 · `budget_turn_unaccounted` ·
  시계 단조성 · `recordProgress` 게이트/provenance · `LIVE_GRANTS` · `executeUnderGrant` ·
  opaque outcome handle · `failOperation` · `requireReconcilableTask` · `assertNoPendingOperations` ·
  C1 멱등 재발급.
- `src/exec/typedExecution.ts`(+테스트) — 발행 fail closed(A4) · temp 경로 제거 · 판정 직전 부모
  재확인 · 정리 복합 처리(B1) · `ProcessLaunchCapability`(B2).
- `src/exec/approvalManifest.ts` — action별 `{planPath}` 계약 · `readOwnData`/`readOwnArray` 입양(C2) ·
  `CONTROLLER_DATA_ARG_PATTERN` 삭제.
- `src/exec/orchestrationTypes.ts` · `src/exec/orchestrationStore.ts` — `ValidatePlanData` ·
  영수증 attempt/turn/planDigest · event `planDigest` · pending 상태·binding 불변식.
- `schemas/milestone_approval_manifest.schema.json` · `schemas/orchestration_run_state.schema.json`.
- `src/exec/autopilotLifecycle.test.ts` · `src/exec/orchestrationKernel.test.ts` — 계약 변경 반영.

**손대지 않은 것**: `stableController.ts`(+테스트 — **열지도 않았다**) · managed process · trusted Git ·
reviewer · CLI · legacy `exec`/`mission` · `orchestrationStore` 발행 내부 · `executionBoundary.ts` ·
`typedPlan.ts` · `offlinePlanWorker.ts` · `scripts/m4*-offline-acceptance.mjs`(fixture 변경 불필요 —
셋 다 `operationAuthorityByTask: {}`) · package/lock · tracked `dist/**`. 두 번째 scheduler·대안
controller·신규 런타임/dev 의존성 **0**.

### A 해소 (4/4)

- **A1 — 순서를 계약으로 만들었다: permit(claim) → `chargeTurnUsage` → grant → 효과.**
  효과 게이트가 `accounting.chargedTurnIds.includes(turnId)`를 요구한다(신규
  `budget_turn_unaccounted`) → 토큰 판정이 stale일 수 없다. 과금은 더 이상 turn을 닫지 않는다
  (닫으면 바로 그 계획의 grant가 죽는다) — **끝난 claim**(과금 + 미확정 0)만 다음 turn의 permit
  요청이 교체하는 **지연 해제**다. 그래서 operation 0건 turn도, 계획의 일부만 집행한 turn도
  교착되지 않는다(durable에 "몇 건 집행할 것인가"를 적어 둘 필요가 없다).
  `recordProgress`는 ⓐ 효과 게이트와 같은 등호 규칙으로 `no_progress_exhausted`·
  `attempt_wall_exhausted`를 **먼저** 보고(늦은 진행이 소진된 attempt를 되살리지 못한다)
  ⓑ attempt `processLeaseMarker`(= `confirmCleanup`과 같은 durable attempt 권위) + worker
  `{kind:"progress",seq,step}` 닫힌 읽기를 요구한다(heartbeat·미상 이벤트·구조 없는 호출 거부).
  전진 시각은 `state.updatedAt`에 대해 **단조**여야 한다(`updatedAt`이 `phaseStartedAt`·
  `lastProgressAt`을 포함한 모든 durable 시각의 상한이다).
  **정직한 한계**: lease marker는 durable 값이라 state 파일을 읽을 수 있는 코드에는 비밀이 아니다 →
  kernel brand 스트림 채널은 신규 `C-42`(controller 배선 task).
- **A2 — 결과를 집행기에 묶었다.** 모듈 사설 `LIVE_GRANTS`가 durable pending 신원당 **살아 있는 grant
  하나**만 허용한다(새 발급이 이전 것을 폐기 → 재시작 정합화는 되고 live/live 중복은 불가능).
  `consumeExecutionGrant` export를 **삭제**하고 `executeUnderGrant(grant, op, effect)`로 바꿨다:
  진입 일회용이고, `effect`가 정상 반환할 때만 canonical 결과를 grant 안에 굳혀 opaque handle을 낸다.
  `recordOperationReceipt({outcome})`는 그 handle만 받고 **저장된 canonical 결과**를 적는다 —
  marker·path·hash·exit을 바꿔 넣을 필드가 없다. 미시도·실패는 신규 `failOperation`(`denied|failed`)
  으로만 닫힌다. 영수증·event에 attemptId·turnId·**planDigest**가 durable하게 남는다.
  **주장하지 않는 범위(정직)**: 진짜 grant를 쥔 같은 프로세스 코드는 거짓말하는 `effect`를 넘길 수
  있다. 그러나 진짜 grant는 진짜 permit → `beginOperation` 커밋을 지나야 나오므로 그 코드는 이미
  승인된 dispatch 경로 안이다. 밖에서 오는 구조적 영수증·재생·치환·중복은 전부 닫혔다.
- **A3 — 미아 pending을 없앴다.** 영수증 정합화가 **safety-only**가 됐다(`requireReconcilableTask` —
  만료·예산·wall·no-progress·preflight drift를 보지 않고 신원은 전수 확인, `running|cleaning`만).
  attempt를 떠나거나 리셋하는 전이 전부가 `assertNoPendingOperations` 하나를 지난다.
  런타임·schema 불변식으로 pending을 attempt/turn/plan digest에 묶고 그 밖의 state에서 금지했다.
- **A4 — 발행을 제거했다(fail closed).** `link(2)`/`rename(2)`는 pathname을 받고, 최종 부모 확인과
  syscall 사이에 경쟁자가 승인된 부모 **이름**을 교체하면 커널이 그 교체본을 통해 경로를 해석한다 →
  승인 범위 밖 발행 + 엉뚱한 디렉터리 fsync, 그리고 발행된 inode는 우리 temp와 같으므로 **사후 검증은
  통과한다**. Node 18/macOS 내장에 디스크립터 상대 no-replace 발행이 없고 이 세션은 신규 의존성·
  네이티브 helper·자식 프로세스를 만들 수 없다 → **지시대로 fail closed**.
  `process.chdir(parent)` + basename `link`는 **평가 후 채택하지 않았다**(프로세스 전역 상태 ·
  worker thread에서 throw · managed launcher가 자식을 띄우면 자식 cwd 오염 → 안전을 증명할 수 없다).
  **기능 결과(정직): `applyWriteFile`은 이제 새 파일을 만들지 못한다** → 신규 `B-16`으로 등록했다.

### B 해소 (2/2)

- **B1 — 정리 durability.** A4로 temp를 만드는 경로가 사라져 unlink 뒤 부모 fsync · truncate 뒤 파일
  fsync · 고아 plaintext 문제가 **성립하지 않는다**(남길 파일이 없다). 남은 fd 반납 실패는
  `write_cleanup_unconfirmed`이고, **1차 오류와 동시에 나면 정리 미확인이 이기고** 1차 안정 코드를
  메시지에 **코드로만** 싣는다(경로·내용 없음).
- **B2 = `B-10` — action 계약 + opaque 실행 권능.** `data: string[]` → action별 `{planPath}`
  (정규화 항등 · 고립 surrogate 거부 · 코드 포인트 상한 · `writableRoots` 안 · task ownership 안).
  읽기 전용 action이지만 **새 `readableRoots` 축을 열지 않고** 승인된 쓰기 범위 안쪽으로 좁혔다.
  공개 `ProcessLaunchSpec`을 **삭제**하고 opaque `ProcessLaunchCapability`로 바꿨다 —
  실행 파일·entrypoint·digest·argv·timeout·planPath는 **모듈 사설 레코드에만** 있다. argv 파생 코드도
  삭제했다(소비자가 없다 — 미래 launcher가 durable 상태를 다시 읽고 두 digest를 재검증하며 만든다).
  **이 세션의 spawn 수는 0이다**(승인된 node·entrypoint 경로가 존재하지 않는데 권능이 나온다).

### C 처리 (3/3 손댐)

- **`C1` fixed** — 정확히 같은 (turn, 계획) 재발급은 durable 커밋 없이 멱등(revision·event 줄 수 불변).
- **`C2` fixed** — manifest validator가 `typedPlan.readOwnData`/`readOwnArray`로 **한 번만** 입양한다
  (accessor·`Proxy`·계약 밖 prototype·symbol key 거부 → 호출자 코드가 실행되지 않는다). 신규 의존성 0.
- **`C3` 주장 정정** — 두 schema의 "동치" 문장을 "구조 대조이며 draft-07을 실행하지 않는다"로 고치고
  런타임 전용 불변식을 각 자리에 명시했다. 낡은 서술(`run_process.executable` · rename 경로) 수정.
  **지시대로 draft-07 validator는 추가하지 않았다** → 적대적 corpus 실행은 기한 그대로 open.

### 교체한 assertion 전수 (완화 0)

| 파일·테스트 | 이전 | 지금 | 왜 |
|---|---|---|---|
| `typedExecution.test.ts` `permit 발급은 durable 신원…` | `revision === rev + 1`("재발급도 claim 커밋을 남긴다") | `revision === rev` **+ `events.jsonl` 줄 수 불변 + 4회 반복** | 그 assertion이 `C1` 결함(문서상 멱등인데 매번 커밋)을 **정상 동작으로 고정**하고 있었다 |
| 같은 파일 `A1: 토큰 등호…` ⓒ | 늦은 `recordProgress` 뒤 `applyWriteFile(...).marker === "applied"` | 늦은 진행 = `no_progress_exhausted` **+ 경계 안 진행은 인정되는 대조군** | 그 assertion이 A1의 **소진된 attempt 부활**을 정상 동작으로 고정하고 있었다 |
| 같은 파일 `A2: 영수증이 커밋된 뒤에는 살아 있던 두 번째 grant로도…` | 첫 영수증 커밋 **뒤에** g2 사용(pending 확인에 걸림) | **영수증 전에** g1·g2를 둘 다 쓰려 시도 → g1은 발급 시점에 폐기 | 이전 순서로는 리뷰가 지적한 **live/live 중복**을 재현하지 못했다 |
| 여러 테스트의 `marker === "applied"` | 신규 발행 성공 | `write_publish_unsupported` 또는 사전 배치 후 `already_applied` | A4로 발행 경로가 **존재하지 않는다**(계약 변경 반영이며 완화가 아니다) |
| `A2: 등록·발행·영수증…재시작` | 재시작마다 `clockFrom(T0)` 새 clock | **하나의 clock 공유** | A1의 시계 단조 게이트가 "재시작이 시간을 되돌린다"를 정확히 거부한다(테스트 전제 수정) |

### 검증 실측 (이 세션에서 실제로 실행한 것만)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | **0 error** |
| `npx tsx --test src/exec/typedExecution.test.ts` | **47/47** |
| `npx tsx --test src/exec/autopilotLifecycle.test.ts` | **28/28** |
| `npx tsx --test src/exec/orchestrationKernel.test.ts` | **103/103** |
| `npx tsx --test src/exec/executionBoundary.test.ts` | **20/20**(변경 0 — 회귀 확인) |
| `npx tsx --test src/exec/offlinePlanWorker.test.ts` | **10/10**(변경 0 — `typedPlan` 재사용 회귀 확인) |
| 위 5개 파일 동시 | **208/208** |
| `node scripts/m4a-offline-acceptance.mjs` | **32/32** exit 0 |
| `node scripts/m4b-offline-acceptance.mjs` | **45/45** exit 0 |
| `node scripts/m4c-offline-acceptance.mjs` | **80/80** exit 0 |
| `git diff --check` | 출력 없음 |

**mutation 6종**(전부 red 확인 후 정확히 원복 — 원복 증거: 세 파일 SHA-256이 주입 전과 **바이트 일치** ·
`grep -rn "if (false &&" src/exec` 비테스트 **0건**):

| # | 주입 | 죽은 테스트 |
|---|---|---|
| M1 | 효과 게이트의 `chargedTurnIds` 요구 제거 | `lifecycle·attempt·turn이 어긋나면…` |
| M2 | `recordProgress`의 no-progress 소진 거부 제거 | `A1: 토큰 등호·attempt wall 등호·no-progress 등호…` |
| M3 | 같은 pending 신원의 이전 grant 폐기 제거 | `A2: 같은 pending 신원에는 살아 있는 grant가 하나뿐이다` |
| M4 | `assertNoPendingOperations` 무력화 | `lifecycle…` · `A2/A3: 효과가 났는데 결과 전이가 없으면…` |
| M5 | 영수증 정합화를 전진 게이트로 되돌림 | `lifecycle…` · `A3: 영수증 정합화는 만료·deadline·cleaning 뒤에도 가능하다` |
| M6 | 발행 fail-closed 제거(`applied` 복원) | 6건(`A4: 신규 발행 경로는 도달하지 않는다` 포함) |

**미실행(정직)**: `npm test` · 전체 `test:core` · 전체 `acceptance.sh` · `npm run test:exec` ·
stress · live · 반복(3회) · build/dist · `stableController.test.ts`(다음 DAG task 범위 — 이 세션은
그 파일을 **열지 않았다**). 최종 전체 suite 1회는 **M5 handoff 예약**이다.

### 다음 DAG task는 시작하지 않았다

`StableController` 재작성/배선 · managed process supervisor/launcher · trusted Git 연동 · 첫 spawn ·
M5d · live 실행 — **하나도 시작하지 않았다.** (**정정 — 6차 리비전**: 이 자리의 `fable5` 모델 문구는
사용자 의도의 오기였다. 사용자는 도구를 바꿀 것이며 **현재 Task 3A 마감 후 Codex는 이후 작업을 시작하지
않는다** — 이후는 사용자 별도 지시.) 이 세션은 기존 레포 규칙대로 fresh Claude Code Opus 5였다.

---

## 2026-07-30 (V3 **M5c task 3A 2차 리비전 — 독립 재리뷰 `REVISE A=4·B=2·C=3`의 A 4건 + B 2건을 닫았다. M5c는 여전히 미완료다** · 그 시점 기록 — 현행은 맨 위 블록이다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`16cdc87dc6e407357e1847459708d4825ba49f70` · 종료 HEAD **아래 커밋 표 참조**. **새 fresh Claude Opus 5
단일 세션**(이전 작성자 transcript·자기평가 **미상속** · subagent·병렬 writer 0 · 재개 세션 아님).
Ponytail SKILL.md **level `full`** 적용 —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`
(SessionStart hook이 전문을 주입했다: `PONYTAIL MODE ACTIVE — level: full`).
amend/rebase/reset/checkout·stash 기반 실험 · 원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 ·
의존성/lockfile 변경 · live Codex/Claude 추론 · secret · deploy · DB · production · live billing ·
**프로세스 spawn 0**. 유일한 untracked 항목은 supervisor가 제공한 `node_modules` symlink이며 손대지 않았다.
**테스트 완화·삭제 0**(변경한 assertion은 아래 §"변경한 assertion 전수"에 전부 기록했다).

**입력 권위**: `/private/tmp/m5c-task3a-rereview-output.txt` — 독립 read-only 재리뷰,
판정 **`REVISE — A=4, B=2, C=3`**. 이 파일이 이번 리비전의 결함 권위다.

**정직한 판정: 이 리비전도 M5c 완료가 아니다.** 닫은 것은 재리뷰의 Category A 4건과 B 2건(`B1` 인접
filesystem · `B2`=`B-10` `run_process` 코드 권위)이다. managed process supervisor·자손 정리 ·
trusted Git · **`StableController` 재작성/배선** · 구조화 리뷰 검증 · `autopilot` CLI · legacy 비활성화 ·
build/dist · M5d는 **여전히 미구현**이다. **self-approve하지 않는다.**

### 직전 문서의 과대주장 정정 (A1~A4/B1)

직전 블록(HEAD `16cdc87`)과 로드맵 §9.1의 "A1~A4 fixed · 인접 B fixed" 서술은 **그 시점의 A 목록에
대해서만** 사실이었고, 독립 재리뷰가 낸 **다른 A 목록**(dispatch 권위 durability · 영수증 provenance ·
최종 pathname 발행 · fsync 재시도)에 대해서는 **부정확했다**. 구체적으로:

| 직전 주장 | 실제 | 이번 조치 |
|---|---|---|
| "A3 fixed — 발행 경쟁 예방" | **부정확**. 부재 대상은 예방됐지만 **교체 경로의 최종 `renameSync(temp,target)`** 는 사후 탐지뿐이었다(검사와 syscall 사이 창에서 경쟁자 바이트 파괴·승인 부모 밖 발행 가능). 대장은 이를 `C-5`로 축소 분류했다 | 교체를 **temp 생성 전에** `write_replace_unsupported`로 거부하고 `renameSync` 발행을 **삭제**했다 |
| "인접 B fixed — durability/정리 계약 닫음" | **부분적으로만 사실**. ⓐ `already_applied` 재시도가 **fsync 없이** 성공을 돌려줬다(거짓 durability) ⓑ close·unlink 실패를 전부 삼켰다 ⓒ no-replace 분기가 정리 확인 전에 소유권을 비웠다 ⓓ 부모 이름 교체 시 **승인 내용이 담긴 plaintext temp**가 남는 것을 계약으로 인정했다 | 넷 다 닫았다(A4 + B1 — 아래) |
| "A2 fixed — 위조 불가 dispatch 권위" | **부분적으로만 사실**. permit 위조는 막혔지만 ⓐ permit이 **state를 바꾸지 않아** durable turn이 `null`인 동안 서로 다른 turn의 permit이 공존했고 ⓑ `recordOperationReceipt()`가 **구조적 영수증**을 그대로 받았으며 ⓒ 진짜 permit이 **소비되지 않아** 재사용 가능했다 | turn/계획 durable claim + pending operation lifecycle + 일회용 grant로 닫았다(A1/A2 — 아래) |
| permit 레코드가 "현재 durable state를 읽는다" | **읽는 통로가 공개 `getState()` 였다**. (이 레포에서는 `OrchestrationKernel.prototype`이 frozen이라 리뷰가 서술한 monkey-patch 자체는 그 시점에도 실패했다 — 그 점은 리뷰가 부정확하다. 다만 게이트가 공개 메서드 조회에 의존한다는 지적은 타당하다) | permit 레코드가 private `#state`를 **직접** 읽는다(반환 manifest는 사본). 두 freeze 사실과 함께 테스트로 고정했다 |
| `B-10` "open — 게이트 유지" | **정확했다**(과대주장 아님) | 이번에 **닫았다**: digest 고정 controller entrypoint + 닫힌 action + 데이터 전용 인자 |

### 커밋

| 해시 | 내용 |
|---|---|
| `cecc529` | 코드·schema·테스트 (A1~A4 · B1 · B-10 · `C-41` fixture) |
| (이 문서 커밋) | 진행/handoff 문서 + 로드맵 §9.1 대장 |

### 변경 파일 (신규 0 · 변경 14)

- `src/exec/orchestrationKernel.ts`(+테스트) — turn/계획 durable claim · pending operation lifecycle ·
  일회용 execution grant · 효과 게이트 3종 추가 · `readClosedOnce` taxonomy 폐쇄.
- `src/exec/typedExecution.ts`(+테스트) — 교체 거부(A3) · 재시도 fsync(A4) · 정리 실패 전파(B1) ·
  seam taxonomy 정규화(`C1`) · `ProcessLaunchSpec` 폐쇄 계약(B-10).
- `src/exec/approvalManifest.ts` — `controllerEntrypoint` 필수 · `run_process` 권위에서
  `executable`/`args` **삭제** → `action`/`data`.
- `src/exec/orchestrationTypes.ts` · `src/exec/orchestrationStore.ts` — durable 필드·enum·validator.
- `schemas/milestone_approval_manifest.schema.json` · `schemas/orchestration_run_state.schema.json`.
- `src/exec/autopilotLifecycle.test.ts` · `src/exec/executionBoundary.test.ts` — fixture를 v2 계약으로.
- `scripts/m4a|m4b|m4c-offline-acceptance.mjs` — manifest fixture에 `controllerEntrypoint` 추가(미실행).

**손대지 않은 것**: `stableController.ts`(+테스트) · managed process · trusted Git · reviewer · CLI ·
legacy `exec`/`mission` · `orchestrationStore` 발행 내부 · `executionBoundary.ts` 런타임 · `typedPlan.ts` ·
`offlinePlanWorker.ts` · package/lock · tracked `dist/**`. 두 번째 scheduler·대안 controller·신규 런타임
의존성 **0**.

### A 해소 (4/4)

- **A1 — dispatch 권위를 정확히 하나의 turn/계획에 durable하게 묶는다.**
  `issueOperationDispatchPermit()`이 **커밋**이 되어 `execution.dispatchTurnId` +
  `execution.dispatchPlanDigest`를 claim한다. durable turn이 `null`인 동안 두 turn이 각각 permit을 받아
  둘 다 집행하던 경로가 사라졌다: 다른 turn은 `dispatch_identity_stale`, 같은 turn의 **다른 계획**은
  `dispatch_plan_conflict`, 이미 과금된 turn 재개방은 `turn_already_charged`다. 같은 (turn, 계획) 재발급은
  **멱등**이다(재시작한 controller의 정합화 경로). `chargeTurnUsage()`가 turn을 **닫는다**(claim 해제 +
  `chargedTurnIds` 기록)므로 같은 attempt 안에서 turn이 이어진다. permit 레코드는 공개 `getState()`가
  아니라 private `#state`를 직접 읽는다. 효과·명세 발급 직전마다 **토큰 등호**
  (`budget_tokens_exhausted`) · **attempt wall 등호**(`attempt_wall_exhausted`) · **no-progress 등호**
  (`no_progress_exhausted`)를 추가로 본다.
  **정직한 한계**: `preflightDigest`에 토큰·경과 같은 **가변 사실은 넣지 않았다**. 넣으면 매 turn drift가
  되어 seal의 의미가 사라진다 — 대신 명시 게이트 3종으로 닫았고 활성 turn은 별도 durable 필드다.
- **A2 — 집행·영수증을 위조·재생·치환·중복 불가능하게 만들었다.** 신규 `beginOperation()`이 **집행 전에**
  durable `pendingOperations` 레코드(operationId·kind·authorityId·attemptId·turnId·planDigest·beganAt)를
  커밋하고 모듈 사설 `WeakMap` 등록부의 **일회용 execution grant**를 발급한다. 효과 게이트
  (`consumeExecutionGrant`)가 grant를 정확히 한 번 소진하고, `recordOperationReceipt({grant,...})`가 정확히
  한 번 소비한다. **성공 marker는 효과 게이트를 지난 grant에서만** 나온다(미시도 grant는 `denied`/`failed`로만
  pending을 닫는다). 미확정 operation이 하나라도 있으면 **turn을 닫을 수도**(`chargeTurnUsage`) **task를
  완료·차단할 수도** 없다(`operation_pending_unreconciled`) → "효과는 났는데 결과 전이가 없다"가 durable에
  남고 조용히 덮이지 않는다. 재시작 정합화는 결정론적이다: 같은 operation을 다시 열면 pending을 중복
  등록하지 않고 새 grant만 주며, 멱등 재집행(`already_applied`) 후 영수증이 하나로 수렴한다.
  부수로 `RECEIPT_KEYS`에 `at`을 추가했다 — **집행기가 낸 영수증을 그대로 커밋하는 자연스러운 경로가
  항상 `invalid_artifact_ref`로 막혀 있었다**(그 조합을 돌려 본 테스트가 없었다).
- **A3 — 최종 pathname 교체를 손대기 전에 거부한다.** Node 18 내장에는 디스크립터 상대
  compare-and-publish(`renameat2`/`RENAME_EXCHANGE`)가 없어 `rename(2)` 직전 창을 0으로 만들 수 없다.
  그래서 사후 탐지를 포기하고 **예방**으로 바꿨다: 대상이 이미 존재하고 내용이 의도와 다르면 **temp를
  만들기도 전에** `write_replace_unsupported`로 거부한다. `renameSync` 발행 경로는 **삭제**했고 발행은
  부재 대상 `link(2)` no-replace만 남는다. 네이티브 primitive·런타임 의존성은 **추가하지 않았다**
  (승인 대상이므로 이 슬라이스에서 도입할 수 없다).
- **A4 — 재시도가 durability를 증명하게 한다.** `already_applied` 경로도 **부모 디렉터리 fsync 성공 뒤에만**
  반환한다. fsync가 계속 실패하면 계속 `write_durability_unconfirmed`다.

### B 해소 (2/2)

- **B1 — 정리 실패를 성공으로 삼키지 않는다.** close·unlink 실패를 `status.cleanupFailed`로 모아
  신규 `write_cleanup_unconfirmed`로 올린다(발행 판정이 성공이었어도 성공 영수증을 내지 않는다).
  no-replace 분기가 정리 확인 전에 소유권을 비우던 코드를 제거했다(`finally` 하나가 확인한다).
  **부모 이름이 적대적으로 교체돼 pathname으로 우리 temp를 지울 수 없는 경우**에는 남의 파일을 지우지 않고,
  대신 **우리가 들고 있는 fd로 `ftruncate(0)`** 해서 남는 파일이 **0바이트**가 되게 한다 → 승인 내용이
  고아 plaintext로 노출되지 않는다. temp 이름은 `sha256(run|task|attempt|turn|operation)`에서 파생돼
  (`.m5c-op-<16hex>-<24hex>.tmp`) 정합화 sweep이 **안전하게 귀속**할 수 있다. durable pending 레코드가
  정합화 신원이다. **발행 뒤에는 truncate 폴백을 쓰지 않는다**(temp fd와 발행된 대상이 같은 inode이므로
  자르면 산출물이 0바이트가 된다) — 그때는 이름 unlink만 시도하고 실패는 cleanup-unconfirmed다.
- **B2 = `B-10` — `run_process`의 임의 코드 권위를 제거했다.** `executionAuthority.controllerEntrypoint`
  (digest 고정 절대경로)를 **필수**로 추가하고, 승인 operation 레코드에서 `executable`·`args`를
  **삭제**했다. 남은 것은 닫힌 `action` enum(`CONTROLLER_ACTIONS = ["validate-plan"]`)과 **데이터 전용**
  `data`뿐이며, data 항목은 NUL·고립 surrogate 없고 **`-`로 시작할 수 없다**(그 규칙 하나가
  `--eval`·`--require`·`--input-type`·`--import` 계열을 형태로 닫는다). argv는 `ProcessLaunchSpec`이
  `[entrypoint, action, ...data]`로 **파생**하며 이 배열을 만드는 다른 통로가 없다. argv[1]이 절대경로
  script이므로 Node 옵션 자리 자체가 없다. 명세에 `entrypoint`/`entrypointSha256`/`action`을 실어 spawn
  직전 `executionBoundary.verifyApprovedExecutable` 재검증이 가능하다. **이 리비전의 spawn 수는 0이다**
  (승인된 node·entrypoint 경로가 이 환경에 존재하지 않는데도 명세가 나오는 것이 그 증거다).
  production/deploy/billing/remote-write 표면은 여전히 표현할 타입이 없다.

### C 처리

- **`C1`(발행 seam) — 부분 해소.** hook이 던진 것은 **종류 불문** `write_failed`로 정규화했다 →
  **호출자가 production 오류 taxonomy를 고를 수 없다**(리뷰가 지목한 진짜 위험). export 자체는
  **남겼다**: 결정론적 경쟁·fault 재현에 현재 대안이 없고, 이 리비전에서 테스트 전용 하네스로 분리하면
  같은 슬라이스에서 A/B 검증이 흔들린다. **"module-private"라는 과거 서술은 거짓이었으므로 정정한다**
  (아래 대장 참조).
- **`C2`(schema/runtime 동치 과대주장) — 손대지 않았다.** 기한(M5d) 그대로 open. 동치라고 다시 주장하지
  않는다.
- **`C-41`(executionBoundary v1 fixture red) — 닫았다.** 이번 manifest 계약 변경이 그 파일을 건드리므로
  범위 안이다: fixture를 v2로 올려 **1/20 → 20/20**.
- **`C-38` kernel 행 — 닫았다.** `readClosedOnce`가 호출자 예외를 종류 불문 접는다(이전에는
  `OrchestrationError`를 그대로 재던져 던지는 getter가 코드를 고를 수 있었다).

### 변경한 assertion 전수 (완화 0 — 전부 강화 또는 계약 정정)

| 파일·테스트 | 이전 | 이후 | 이유 |
|---|---|---|---|
| `typedExecution.test.ts` "디렉터리 durability…" → "A4: fsync 실패 뒤 재시도…" | 재시도가 **fsync 없이** `already_applied` | 재시도가 fsync를 **다시 시도**하고, 계속 실패하면 `write_durability_unconfirmed`; 성공해야 `already_applied` | **리뷰가 지적한 대로 옛 assertion이 결함을 고정하고 있었다**(거짓 durability) |
| 같은 파일 "교체는 발행 직전 preimage…" → "A3: 기존 대상 교체는 temp를 만들기 전에 거부…" | 발행 직전 재확인 후 `write_failed` | `write_replace_unsupported` + **temp 생성 단계 미도달** 단정 + 바이트·inode 불변 | 사후 탐지 → 예방으로 계약이 바뀌었다 |
| 같은 파일 "성공적인 원자적 쓰기와 교체" → "A3: 부재 대상은 원자적으로 발행되고…" | 교체가 **성공**한다고 단정 | 교체는 거부되고 기존 바이트가 그대로임을 단정 | 같은 계약 변경 |
| 같은 파일 "부모 디렉터리가 symlink로…" | 남는 temp가 **"우리 내용"** 을 담는다고 단정 | 남는 temp가 **0바이트**·0600·operation 신원 파생 이름임을 단정 | B1 — 승인 내용의 고아 노출 제거 |
| 같은 파일 "모든 실패 경계가…" 끝부분 | hook이 던진 `already_applied`가 **그대로 전파**된다고 단정 | `write_failed`로 정규화됨을 단정 | `C1` — 호출자 taxonomy 선택 차단 |
| 같은 파일 "평범한/위조 permit으로는…" | 위조는 `dispatch_permit_invalid` | + **진짜 permit만으로도** 효과 없음(`dispatch_grant_invalid`) · grant 모양 위조 추가 | A2 — 집행 전 durable 등록 강제 |
| 같은 파일 "lifecycle·attempt·turn…" ⓒ | `chargeTurnUsage(turn-2)`가 durable turn을 갈아끼움 | 미확정 operation이 있으면 과금 거부 · 과금이 claim을 닫음 · 닫힌 turn 재claim 불가 | A1/A2 |
| 같은 파일 "만료·예산 deadline…" | 루프로 clock을 태워 경계 도달 | `steppableClock`으로 **정확히 그 밀리초**에 등호 판정(+1ms 전 통과 단정) | 등호가 우연이 아니라 단정이 된다 |
| `orchestrationKernel.test.ts` "kernel 공개 API는 좁은 목록뿐" | 목록에 `beginOperation` 없음 | 추가 | 신규 좁은 진입점 1개 |
| 같은 파일 "milestone_approval_manifest.schema.json 동치" | `args.maxItems`/`items.maxLength` | `action.enum`/`data.*` + `executable`·`args` **부재** 단정 + `controllerEntrypoint` | `B-10` 계약 변경 |
| `autopilotLifecycle.test.ts` "typed operation 권위는…" | 비승인 executable → `operation_executable_not_approved` | 실행 대상 필드 자체가 없으므로 `invalid_manifest` + `--eval` 데이터 거부 추가 | `B-10` |
| 같은 파일 argv 고립 surrogate | `invalid_manifest` | `operation_data_not_approved` | 전용 안정 코드 도입 |
| `executionBoundary.test.ts` "manifest 누락·형태 위반" | `call({})` → `invalid_manifest` | `manifest_pre_m5c_unsupported` | 빈 객체는 v2 필수 절이 없는 manifest다(둘 다 hard reject) |

### 신규 적대적 테스트 (요구 10종 매핑)

1. 두 turn/계획 경쟁 → `[M5c] A1: durable turn이 null인 동안에도 두 turn/계획이 함께 살아남지 못한다`
2. 공개 `getState()` monkey-patch → `[M5c] A1: 공개 getState()를 monkey-patch해도…`
3. 토큰·wall·no-progress **등호** → `[M5c] A1: 토큰 등호·attempt wall 등호·no-progress 등호가…`(효과 0)
4. 위조·재생·치환·재사용·효과없는성공 → `[M5c] A2: 위조·재생·치환·재사용 영수증과 '효과 없는 성공'이…` ·
   `[M5c] A2: 집행 게이트를 지나지 않은 grant는…` · `[M5c] A2: 영수증이 커밋된 뒤에는 살아 있던 두 번째
   grant로도 다시 집행할 수 없다` · `lifecycle·attempt·turn…` ⓑ(낡은 attempt 재생)
5. 재시작 수렴 → `[M5c] A2: 등록·발행·영수증 사이에서 재시작해도 중복 손상 없이 하나로 수렴한다`
6. 교체 거부·경쟁자 보존·부모/temp 경쟁 → `[M5c] A3: …` 2건 + `부모 디렉터리가 symlink로…` +
   `temp 경로가 다른 파일로 교체되면…` + `부재 대상은 경쟁적으로 생긴 파일을 덮어쓰지 않는다`
7. fsync 재시도 → `[M5c] A4: fsync 실패 뒤 재시도는…`
8. **실제** close/unlink 실패 주입 → `[M5c] B1: 실제 close/unlink 실패는 성공이 되지 않고…`
   (부모 디렉터리 `chmod 0500` = 진짜 EACCES · 집행기 temp fd를 (dev,ino)로 찾아 미리 close = 진짜 EBADF)
9. `run_process` 거부 전수 + spawn 0 → `[M5c] B-10: run_process는 --eval·--require·임의 script/module·
   action 주입을 표현할 수 없다`
10. 적대적 객체/proxy/accessor → `[M5c] 적대적 객체·proxy·accessor는 lifecycle을 우회하거나…`

### 검증 (전부 직렬 · 이 세션 실측)

- `npx tsc --noEmit` — **0 error**.
- 파일 단독 focused: `typedExecution.test.ts` **46/46** · `offlinePlanWorker.test.ts` **10/10** ·
  `autopilotLifecycle.test.ts` **28/28** · `orchestrationKernel.test.ts` **103/103** ·
  `executionBoundary.test.ts` **20/20**. 5개 동시 실행 합계 **207/207 pass · 0 fail**.
- `git diff --check` clean · 전체 diff 육안 검사(생성물·secret·node_modules·완화 테스트 0).

### mutation 검증 (8종 — 전부 해당 테스트를 실패시킨 뒤 **일반 편집으로 정확히 원복**)

| # | 제거·훼손한 guard | 실패한 테스트 |
|---|---|---|
| 1 | `issueOperationDispatchPermit`의 경쟁 turn claim 검사 | A1 두 turn/계획 |
| 2 | `already_applied` 경로의 `confirmDirDurability` | A4 fsync 재시도 |
| 3 | `targetExists` 교체 거부 | A3 2건 |
| 4 | `finally`의 close 실패 → `cleanupFailed` | B1 실제 close/unlink |
| 5 | 성공 marker의 `attempted` 요구 | A2 성공 marker 2건 |
| 6 | 효과 게이트의 durable pending 확인 | **처음에는 0건 실패 → 커버리지 구멍 발견** → `[M5c] A2: 영수증이 커밋된 뒤에는 살아 있던 두 번째 grant로도…` 테스트 추가 후 재실행하여 실패 확인 |
| 7 | 토큰 예산 등호(`>=` → `>`) | A1 등호 3종 |
| 8 | data 인자 `-` 시작 거부 | B-10 · autopilot typed operation 권위 |

원복 확인: `git diff --stat`에 MUTATION 흔적 0 · `npx tsc --noEmit` 0 error · 207/207 재확인.

### 미실행 (정직 목록)

`npm test` · `test:exec` · `test:core` · 전체 acceptance · M4 offline acceptance 3종(fixture만 갱신) ·
stress · live · 반복(3회) · build/dist 재생성 · M5d. **최종 전체 suite 1회는 supervisor가 M5 최종
handoff에 예약했다.**

### 알려진 red (실측)

- `stableController.test.ts` — **3/58 pass · 55 fail**(이번 변경 전후 동일 · 의도적 미수정).
  원인은 v1 manifest fixture(`authorityFor`가 codex+git뿐)와 `startScheduledBatch()` stale 호출이며,
  **다음 M5c DAG task(StableController 재작성)의 범위**다. 직전 대장의 "3/58 red"라는 표기는
  "3건이 red"로 읽힐 수 있어 부정확했다 — 정확히는 **3 pass / 55 fail**이다.

### 남은 C / 다음 작업

- open: `C-2`~`C-5`(pathname TOCTOU 잔여 — **`rename` 경로가 사라져 표면이 줄었다**) · `C-18` · `C-19` ·
  `C-26` · `C-29` · `C-30` · `C-31` · `C-33` · `C-34` · `C-35` · `C-36` · `C-37` · `C-39` ·
  `C-40`(fixed 유지) · `C2`(schema 동치, M5d) · `C1`(seam export, 부분 해소).
- open B: `B-7` · `B-9` · `B-11` · `B-12` · `B-13` · `C-12→B`(전부 이번 범위 밖 · 변화 없음).
- **다음 DAG task**: `StableController` 재작성 + 이 grant/pending lifecycle 배선 → managed process
  supervisor(+자손 정리) → trusted Git → `autopilot` CLI.

---

## 2026-07-30 (V3 **M5c task 3A 리비전 — 독립 리뷰 A 4건 + 인접 filesystem B 닫음. M5c는 여전히 미완료다** · 그 시점 기록)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`5a35bce27569d672d6aea2803b42d064c175cd49` · stack base `81554cf`. **새 fresh Claude Opus 5 단일
세션**(이전 작성자 transcript·자기평가 **미상속** · subagent·병렬 writer 0). Ponytail SKILL.md(level
`full`) 적용 — `/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`.
amend/rebase/reset/stash · 원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 · 의존성/lockfile
변경 · live Codex/Claude 추론 · secret · deploy · DB · production · live billing **없음**.
`--dangerously-skip-permissions` 미사용. **테스트 완화·삭제 0** (변경한 assertion은 아래에 전수 기록).

**입력 권위**: `/private/tmp/m5c-planning-codex-output.txt`(계획) ·
`/private/tmp/m5c-typed-authority-claude-prompt.txt`(의도한 계약) ·
`/private/tmp/m5c-task3a-codex-review-output.txt`(독립 fresh Codex 리뷰 — 판정 `REVISE · A=4 · B=2 · C=3`).

**정직한 판정: 이 리비전도 M5c 완료가 아니다.** 닫은 것은 리뷰의 Category A 4건과 controller 배선의
선행 조건인 인접 filesystem B 1건이다. managed process supervisor·자손 정리 · trusted Git ·
`StableController` 재작성/배선 · 구조화 리뷰 검증 · `autopilot` CLI · legacy 비활성화 · build/dist ·
M5d는 **여전히 미구현**이다.

### 커밋

| 해시 | 내용 |
|---|---|
| `f132d87` | 코드·schema·테스트 (아래 A/B/C 전부) |
| (이 문서 커밋) | 진행/handoff 문서 + 로드맵 §9.1 대장 |

### 변경 파일 (신규 1 · 변경 10)

- 신규 `src/exec/typedPlan.ts` — **순수** 계획 validator + 계약 상수(파일 시스템 권위 0).
- `src/exec/typedExecution.ts` · `src/exec/typedExecution.test.ts`
- `src/exec/offlinePlanWorker.ts` · `src/exec/offlinePlanWorker.test.ts`
- `src/exec/orchestrationKernel.ts` · `src/exec/orchestrationKernel.test.ts`
- `src/exec/orchestrationTypes.ts` · `src/exec/approvalManifest.ts` · `src/exec/autopilotLifecycle.test.ts`
- `schemas/typed_execution_plan.schema.json`

**손대지 않은 것**: `stableController.ts`(+테스트) · managed process · trusted Git · reviewer · CLI ·
legacy `exec`/`mission` · `orchestrationStore` 발행 내부 · `executionBoundary` · package/lock · tracked
`dist/**`. 두 번째 scheduler·대안 controller·신규 런타임 의존성 **0**(`node:util/types`는 Node 내장
introspection이며 의존성이 아니다).

### A 해소 (4/4 — 전부 이번에 닫았다)

- **A1 — 적대적 `Uint8Array`·외부 입력 입양.** `instanceof` + `Uint8Array.prototype.slice.call()`을
  제거하고 `%TypedArray%.prototype`의 **intrinsic getter**(`Symbol.toStringTag`·`byteLength`·
  `byteOffset`·`buffer`)만 쓴다 → `Symbol.species`·iterator·constructor·호출자 property를 **하나도
  읽지 않고**, 내부 슬롯이 없는 receiver(`Proxy` 포함)는 그 자리에서 거부된다. 4 MiB 상한은
  **할당·복사보다 먼저** 본다. 모든 입양 실패는 `worker_input_invalid`로 접고, **크기를 안전하게 확정한
  뒤의** 초과만 `worker_plan_too_large`다. `Buffer`(byteOffset ≠ 0인 pool view 포함) 수락 ·
  `SharedArrayBuffer`는 **복사**하므로 이후 caller 변경이 채택 바이트를 바꿀 수 없고 alias도 남지 않는다 ·
  detached buffer와 도중에 줄어든 resizable buffer는 안정 거부. 외부 request·binding은
  `typedPlan.readOwnData`로 읽는다: **accessor는 성공해도 데이터 입력이 아니며 애초에 실행되지 않고**
  (descriptor의 `value`만 읽는다) `Proxy`는 `node:util/types.isProxy`로 명시 거부한다.
- **A2 — 위조 불가·현재 durable dispatch 권위.** 위조 가능했던 `OperationDispatchContext` export를
  **삭제**했다. 집행은 kernel이 발급한 **봉인 permit**만 받는다(모듈 사설 `WeakMap` 등록부 —
  기존 `attestOrchestrationKernel`과 같은 패턴이고 **임의 데이터를 권위로 만드는 토큰·factory·등록
  함수는 하나도 export하지 않는다**). `issueOperationDispatchPermit()`은 binding(run/task/attempt/turn)을
  **durable state에서 만들어** 계획을 kernel이 검증한다(state 변경 0 · revision·event 그대로).
  `readDispatchAuthority()`는 **모든 효과·명세 발급 직전에** 현재 durable state를 다시 읽어
  ⓐ permit 발급 진위 ⓑ operation이 그 permit에 묶인 계획의 **항목 그 자체**인지(신원 비교) ⓒ 시계 정상성
  ⓓ `now < expiresAt`·`now < accounting.budgetDeadlineAt`(**등호는 거부**) ⓔ run/task 신원과 `running`
  ⓕ durable attempt/turn 신원 ⓖ preflight digest **재계산** 일치 ⓗ manifest canonical digest 일치를
  확인하고, 경로 판정은 **현재** durable ownership과 `writableRoots`로 한다. 단일 scheduler와 기존
  lifecycle API는 그대로이고 ready→running 직접 경로는 여전히 없다(`preflight_required`).
- **A3 — 발행 경쟁·경로 탈출 예방(탐지가 아니라 예방).** 부재 대상은 `link(2)`로 **덮어쓰지 않는**
  원자적 발행이다(`EEXIST` = 경쟁자 바이트 보존 · Node 18+ 내장). 교체는 preimage **신원과 내용**을
  발행 직전에 다시 확인한다. 부모 디렉터리 신원을 열린 fd로 고정하고 **발행 직전에 walk를 재실행**해
  symlink 교체·workspace 탈출을 막는다. temp 확인 fd를 **발행까지 열어 두고**(`O_RDWR` 한 fd로 쓰고 읽는다)
  temp 경로가 여전히 그 inode인지 직전에 확인한다. `O_NOFOLLOW`가 없으면 **fail closed**다(조용한 `0`
  대입 제거). `rename(2)`의 좁은 pathname syscall 창은 **없앴다고 주장하지 않고** 대장 `C-5`에 남긴다
  (Node 18에 `renameat2`·디스크립터 상대 발행이 없고 네이티브 의존성은 만들지 않는다).
- **A4 — UTF-8 경로 신원.** `normalizeWorkspacePath`가 고립 UTF-16 surrogate를 `path_not_utf8`로
  거부한다(공유 정본 `hasLoneSurrogate` = `\p{Surrogate}` + `u`). 승인 manifest 경로 · ownership ·
  `writableRoots` · typed operation 경로 · 산출물 경로가 **전부 이 함수 하나를 지난다**(근본 지점 1개).
  승인된 실행 파일 절대 경로와 `run_process` argv에도 같은 규칙을 적용했다. schema는
  `normalizedWorkspacePath.not`을 `anyOf`(드라이브 접두사 + 고립 surrogate code-unit pattern)로 정렬했고,
  **유효 astral과 리터럴 U+FFFD는 양쪽에서 통과**한다. JSON 파서가 `\uD800` escape를 어떻게 다루는지는
  구현마다 다르므로 **최종 판정은 런타임**이라는 사실을 schema description에 적었다.

### 인접 B 해소 (controller 배선 전 필수 — 이번에 닫았다)

filesystem 오류 taxonomy·정리·durability: 모든 자원 정리를 **`finally` 하나**로 모아 어떤 단계가
실패해도 fd·소유 temp 누수가 0이다. OS·seam 오류는 경로·내용 없이 **닫힌 안정 코드**로 접는다.
발행 후 **디렉터리 fsync 성공까지 확인한 뒤에만** `applied` 영수증을 준다 — 실패는 신규
`write_durability_unconfirmed`이고 바이트는 발행된 상태이므로 **재시도가 `already_applied`로 수렴**한다
(crash/retry-safe 계약을 코드와 테스트에 명시).

**정직한 잔여 한계 1건**: 정리도 **경로 이름**으로만 할 수 있어(Node 18에 `unlinkat` 없음) 발행 도중
**부모 디렉터리 이름 자체가 적대적으로 교체된** 경우에는 우리 temp를 지우지 못하고 진짜 디렉터리에
남는다. 남의 파일을 지우지 않는 쪽을 골랐고, 남는 파일은 `0600` · 미참조 · **발행되지 않은** 바이트다.
테스트가 이 계약을 그대로 단정한다(대장 `C-5`/`C-39` 계열).

### C 처리

- **`C-38`(직접 validator binding taxonomy) — 이 seam에서 닫았다.** `validateTypedExecutionPlan`의
  `binding`도 닫힌 데이터 읽기를 지나므로 hostile accessor/proxy가 거부 코드를 고를 수 없다.
  `orchestrationKernel.readClosedOnce`의 원래 행은 **바꾸지 않았으므로 open 유지**다.
- **worker least-authority 분리 — 했다.** 순수 validator/상수를 신규 `src/exec/typedPlan.ts`로 갈랐다.
  worker의 **transitive** import 그래프가 `orchestrationTypes`·`autopilotTypes`·`typedPlan`·
  `node:util/types`뿐임을 테스트가 그래프 전체를 훑어 강제한다(이전에는 `typedExecution`을 지나
  `node:fs`와 store 모듈을 끌어왔다).
- **schema/runtime 과대주장 정정 — 했다.** 중복 `operationId`(draft-07이 표현 불가) · `summary` NUL ·
  `content`의 UTF-8 바이트 상한/왕복을 **런타임 전용 불변식**으로 schema description에 명시하고 테스트가
  그 문장의 존재까지 확인한다.

### B/C로 남긴 것 (기한·담당·증거는 로드맵 §9.1 신규 절에 전수 기록)

- **`B-10`은 열린 하드 게이트다.** `run_process`는 이번에도 **spawn 0**이고 명세 데이터까지만 만든다
  (명세에 run/task/attempt/turn 신원을 담아 다른 attempt 재사용을 막는 것만 강화했다). 첫 spawn/managed
  launcher 전에 **digest 고정 controller entrypoint 또는 동등한 닫힌 action 계약**(UTF-8 왕복 argv 포함)이
  필요하다 — token 화면은 수정이 아니다.
- **신규 red 실측(이 세션이 처음 측정했다)**: `src/exec/executionBoundary.test.ts` **1/20**.
  원인은 이번 변경이 **아니다** — 그 파일의 manifest fixture가 v1(`node`/`processObserver`/
  `autopilotPolicy` 없음)이라 **직전 slice가 도입한** `manifest_pre_m5c_unsupported` fail-closed에 걸린다.
  실측: 실패 메시지에 `manifest_pre_m5c_unsupported` 38회, 이번에 추가한 `path_not_utf8` **0회**.
  `git show HEAD:src/exec/approvalManifest.ts | grep -c manifest_pre_m5c_unsupported` = 3(시작 HEAD에
  이미 있었다), `git diff HEAD -- src/exec/executionBoundary*.ts` = 변경 0.
  이 파일은 **이번 리비전의 소유 범위 밖**이므로 고치지 않고 대장에 등록했다.

### 검증 실측 (직렬 · 실행한 명령 그대로 · 출력 필터로 exit code를 가리지 않았다)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | **0 error** |
| `npx tsx --test src/exec/typedExecution.test.ts` | **36/36 pass** |
| `npx tsx --test src/exec/offlinePlanWorker.test.ts` | **10/10 pass** |
| `npx tsx --test src/exec/autopilotLifecycle.test.ts` | **28/28 pass** |
| `npx tsx --test src/exec/orchestrationKernel.test.ts` | **103/103 pass** |
| `npx tsx --test src/exec/executionBoundary.test.ts` | **1/20 pass — 시작 HEAD부터 red(위 참조)** |
| `git diff --check` / `git diff --cached --check` | clean |

**비공허성 mutation 2건(하나씩 · A 수정에 직접 대응)**

1. `orchestrationKernel.readDispatchAuthority`의 만료·예산 deadline 재확인 2블록을 지웠다
   (`MUTATION-A2-EXPIRY-RECHECK-REMOVED`) → `[M5c] 만료·예산 deadline은 경계 등호에서 거부한다(로드맵 §8.1)`
   **실패**(35/36). `git checkout --`로 원복 → `git diff --stat` **빈 출력**(index와 바이트 동일) ·
   `grep -rn MUTATION-A2 src/exec/` **0건**.
2. `offlinePlanWorker.decodePlanJson`에 옛 `instanceof` + `Uint8Array.prototype.slice.call()` 경로를
   되살렸다(`MUTATION-A1-UNSAFE-BYTE-ADOPTION`) → `[M5c] 적대적 바이트 입양: species·iterator·
   constructor·proxy는 실행되지 않고 상한이 복사보다 먼저다` **실패**(9/10 · 실제 관측
   `non-orchestration:TypeError` ≠ `worker_input_invalid`). 원복 → `git diff --stat` **빈 출력** ·
   `grep -rn MUTATION-A1 src/exec/` **0건**.

원복 뒤 4종 focused를 **전부 재실행**해 위 표의 카운트를 다시 확인했다.

### 변경한 기존 assertion (완화가 아니라 **강화** — 전수)

1. `typedExecution.test.ts` "교대 getter는 두 번째 값을 반영하지 못한다" → **"accessor는 성공해도
   데이터가 아니다(실행조차 되지 않는다)"**. 이전: 성공하는 getter를 **수락**하고 첫 값만 쓰는지 봤다.
   지금: **거부**(`plan_invalid`)하고 **호출 횟수 0**까지 단정한다(A1 요구사항).
2. 같은 파일의 권위·쓰기 테스트 전부가 손으로 만든 `OperationDispatchContext` 대신 **진짜 kernel run**
   (create → createRootTask → planRunnableBatch → commitPreflightBatch → startPreparedTask → permit)을
   지난다. 위조 manifest로 증명했던 `operation_outside_writable_root`는 **승인 문서에 담길 수조차 없음**을
   `validateApprovalManifest` 거부로 증명하도록 바꿨다(더 강한 주장).
3. `offlinePlanWorker.test.ts` import 정적 확인이 **직접 import 3줄 세기**에서 **transitive 그래프 전체
   순회 + 외부 모듈 허용 목록**으로 바뀌었다.
4. `orchestrationKernel.test.ts` 공개 API 목록에 `issueOperationDispatchPermit` 1건 추가(목록 자체는
   여전히 닫힌 전수 비교다).

### 미실행 (정직하게 — 이 세션에서 돌리지 않았다)

`npm test` · `npm run test:exec` · 전체 `test:core` · 전체 acceptance · M4 offline acceptance 3종 ·
stress · live · 반복(3회) · `npm run build`/dist 재생성 · M5d · 계획 §8 mutation 나머지 6종 ·
`src/exec/stableController.test.ts`(**직전 실측 3/58 red 그대로 · 의도적 미실행** — 이 리비전은 controller
런타임을 건드리지 않았다) · `codexCliProvider.test.ts` · `reviewer.test.ts` · CLI 테스트.

**실제 Claude/Codex provider 실행은 여전히 부재·비활성**이고 **src↔dist drift**도 그대로다(dist는 M5b
상태 → 배포 가능 상태가 아니다). **M5c·M5d·`B-10`·`B-13`/`C-18`·controller 배선·trusted Git·
managed process는 미완료이며 이 세션은 self-approve하지 않는다.**

## 2026-07-30 (V3 **M5c task 3A — typed 계획 validator · offline plan worker · 권위 집행. M5c는 여전히 미완료다** · 이 블록은 그 시점 기록이다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`0c0011a`(아래 블록의 끝 지점) · stack base `81554cf`. **새 fresh Claude Opus 5 단일 세션**(이전 세션
transcript·자기평가 미상속 · subagent·병렬 writer 0). Ponytail SKILL.md(level `full`) 적용 —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`.
amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 · 의존성/lockfile 변경 ·
live Codex/Claude 추론 · secret · deploy · DB · production · live billing **없음**.
`--dangerously-skip-permissions` 미사용. **테스트 완화·삭제·assertion 축소 0.**

**정직한 판정: 이 slice도 M5c 완료가 아니다.** 계획 §6의 3번 묶음(typed authority) 중에서도
**계획 validator · offline worker · 권위 해석/파일 쓰기 집행**만 닫았다. 실제 프로세스 실행(managed
process supervisor·자손 정리) · trusted Git · `StableController` 재작성 · 구조화 리뷰 검증 ·
`autopilot` CLI · legacy 비활성화는 **여전히 미구현**이고 `stableController.test.ts`는 **여전히 red**다.

### 이 slice가 한 것 (신규 파일 5개 · 기존 파일 변경 0)

- **`src/exec/typedExecution.ts` — 닫힌 typed 계획 validator(schema v1).**
  모든 property를 **정확히 한 번** 읽고(교대 getter 무력화) 미상/누락 key · symbol key · 계약 밖
  prototype · getter/proxy trap · 함수 · 순환 · 중복 `operationId` · binding 불일치 · 버전 · operation/
  output/summary/본문 상한 · Unicode 경로 경계를 전부 **안정 코드 `plan_invalid`** 로 접는다.
  **호출자가 던진 `OrchestrationError`도 접는다** — 거부 taxonomy를 호출자가 고르는 통로를 이 seam에서
  없앴다(대장 `C-38`을 여기서 닫는다). 입양 결과는 **깊이 동결**된다.
  `kind`는 **key 집합이 정한다**: write 갈래(6 key)와 process 갈래(3 key)를 key 집합으로 고른 뒤 읽은
  `kind` 값이 그 집합과 어긋나면 거부한다(교대 getter가 다른 갈래로 새지 못한다).
- **controller 소유 권위 해석 + 실제 `write_file` 집행**(같은 파일).
  durable manifest의 `approvedOperationFor(taskId, authorityId)` **하나만** 본다(deny-by-default).
  dispatch 시점에 ⓐ 승인 경로와의 **문자열 동치** ⓑ **durable task ownership**(manifest에 없는 child
  위임도 존중) ⓒ `writableRoots`를 **다시** 본다. 쓰기는 `min(승인 maxBytes, LIMITS.maxWriteBytes)` ·
  기존 경로 구성요소/대상 **symlink 거부**(따라가지 않는다) · 비일반 파일 거부 · `expectedBeforeSha256`
  대조 · 같은 디렉터리 **배타(O_EXCL) temp** → 같은 fd로 바이트·digest 재확인 → **원자적 rename** →
  rename 뒤 대상 inode가 우리 것인지 확인. **크래시 창 멱등**: 현재 내용 hash가 의도한 hash와 같으면
  영수증이 durable하지 않았어도 `already_applied`이고 다시 쓰지 않는다. 그 밖의 preimage 불일치는
  **한 바이트도 쓰지 않고** `write_conflict`. 정리는 **이 호출이 만든 temp만** 한다.
  돌려주는 값은 닫힌 `OperationReceipt` 모양의 동결 값이고 **내용을 담지 않는다**(오류 메시지도 같다).
- **`run_process`는 이 slice에서 아무것도 띄우지 않는다.** 승인 레코드에서만 나오는 **동결 데이터
  명세**(승인된 node 경로 · 승인 digest · 정확한 argv · 정확한 timeout)만 만든다. callback · env · cwd ·
  shell · PATH 조회 · 런타임 실행 파일 선택 · 인자 확장 · network/dependency/git/deploy/billing/remote/PR
  변종은 **표현할 필드가 없다**. 실제 launcher는 managed process slice의 몫이다.
- **`src/exec/offlinePlanWorker.ts` — M5c의 유일한 worker backend(데이터 어댑터).**
  닫힌 데이터 입력(`backend`/`planJson`/`binding`)만 받는다: 파일 시스템·프로세스·git·provider·
  네트워크·환경 객체·callback seam이 **없다**(테스트가 소스의 import 목록을 정적으로 확인한다 — 3줄).
  bounded UTF-8(`TextDecoder{fatal:true}`) JSON을 **정확히 한 번** 파싱해 같은 validator로 검증·동결하고,
  **turn마다 새** 이벤트 스트림을 낸다: `started → 인정되는 progress 1건 이상 → terminal 정확히 1건 →
  정상 종료`. **최종 결과만 있는 스트림은 구조적으로 만들 수 없다**(`silent_session` 불가).
  `claude`·`codex`를 포함한 미상 backend는 `worker_backend_unsupported`로 hard reject다.
- **`schemas/typed_execution_plan.schema.json`** — draft-07 · **전 계층 closed**(테스트가 재귀로 확인) ·
  런타임과 동치: schema 버전 `const "1"` · required/key 집합 · 닫힌 2갈래 union · slug/sha256/role/
  경로 pattern · 상한. **draft-07 `maxLength`는 코드 포인트**이므로(대장 `C-40`) 경로는 정본 pattern·
  길이를 공유하고 표 전수로 두 판정이 갈리지 않음을 증명한다. `result.summary`(런타임 UTF-16 code unit)와
  `content`(런타임 UTF-8 바이트)는 **상한 값이 같고 런타임이 더 엄격**하며 그 방향이 fail closed다.
- **기존 파일은 하나도 바꾸지 않았다** — `autopilotTypes.ts`의 이미 계획된 닫힌 계약이 정정 없이
  그대로 성립했으므로 수정하지 않았다(`stableController.ts` · kernel/store 발행 · managed process ·
  trusted Git · reviewer · CLI · legacy exec/mission · package/lock · tracked `dist`도 무변경).

### 검증 실측 (직렬 · 실행한 명령 그대로 · 출력 필터로 exit code를 가리지 않았다)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | **0 error** |
| `npx tsx --test src/exec/typedExecution.test.ts` | **23/23 pass** |
| `npx tsx --test src/exec/offlinePlanWorker.test.ts` | **8/8 pass** |
| `npx tsx --test src/exec/autopilotLifecycle.test.ts` | **27/27 pass** |
| `npx tsx --test src/exec/orchestrationKernel.test.ts` | **103/103 pass** |
| `git diff --check` / `git diff --cached --check` | clean |

**비공허성(mutation 1건 · 이 slice 범위)**: 계획 §8의 mutation 1번 "operation-authority 대조 생략"을
`resolveApprovedOperation`의 `null` 검사 자리에 넣었더니 **`[M5c] MUTATION-GUARD: 권위 대조를 건너뛰면
거부가 사라진다`와 `[M5c] 승인이 없거나 task·kind가 다르면 거부한다(deny-by-default)` 2건이 실패**했다
(21/23). 정확히 원복했고 **파일 sha256이 mutation 전과 같다**
(`3c76c1d0305449e1b852764a01fa101f6173aff7a264ebbda3e69a705efbded1`) · mutation 흔적 grep 0
(남은 것은 seam을 설명하는 주석뿐이다). 나머지 mutation 7종은 이 slice의 소유 범위 밖이라 **미실행**이다.

### 이 slice가 하지 않은 것 (미실행·미구현 — 정직 기록)

- **미실행 명령**: `npm test` · `npm run test:exec` · 전체 `test:core` · 전체 acceptance
  (`scripts/acceptance.sh`) · M4 offline acceptance 3종 · stress · live · 반복(3회) · `npm run build`/
  dist 재생성 · provider 추론 · 네트워크 · secret · M5d.
- **`src/exec/stableController.test.ts`는 의도적으로 돌리지 않았다** — 직전 세션 실측 **3/58 red**가
  그대로다(이 slice가 controller 런타임을 건드리지 않았으므로 수치가 바뀔 이유가 없다).
- **미구현**: managed process supervisor·자손 정리(`B-13`/`C-18`) · trusted Git(`C-26`) ·
  `StableController` 재작성과 배선 · 구조화 리뷰 검증(`C-19`/`C-35`) · `autopilot` CLI ·
  legacy `exec`/`mission` 비활성화 · review-result schema · dist 갱신.
- **`B-10`은 여전히 부분이다**: 이 slice는 **offline typed 경로의 집행기**를 닫았을 뿐이고,
  managed process와 controller 통합이 리뷰될 때까지 게이트는 열려 있다. **실제 Claude/Codex는
  여전히 부재·비활성**이다.

## 2026-07-30 (V3 **M5c green-recovery slice — v2 계약 schema 정본화 + kernel/M4 검증면 이관. M5c는 여전히 미완료다** · 그 시점 기록 — 현행은 맨 위 블록이다)

같은 worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD
`23d663c`(아래 블록의 끝 지점) · stack base `81554cf`. **새 fresh Claude Opus 5 단일 세션**(이전 세션
transcript·자기평가 미상속, subagent·병렬 writer 0). Ponytail SKILL.md(level `full`) 적용 —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`.
amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 · 의존성/lockfile 변경 ·
live Codex/Claude 추론 · secret · deploy · DB · production · live billing **없음**.
`--dangerously-skip-permissions` 미사용. **테스트 완화·삭제·assertion 축소 0.**

**정직한 판정: 이 slice도 M5c 완료가 아니다.** 아래 블록이 red로 남긴 검증면 중 **kernel + M4 offline
acceptance만** green으로 되돌렸다. controller/typed 실행/trusted Git/managed process/offline plan
worker/구조화 리뷰/autopilot CLI는 **여전히 미구현**이고 `stableController.test.ts`는 **여전히 red**다.

### 이 slice가 한 것

- **계약 문서 2종을 v2 정본으로 갱신**(런타임 validator와 동치):
  - `schemas/orchestration_run_state.schema.json` — `schemaVersion "2"` · 필수 `accounting` ·
    필수 `task.execution` · 필수 `message.delivery` · task 상태 11종 · event 종류 19종 · 전이 사유 21종 ·
    닫힌 감사 필드 7종 · `autopilotMarker`/`pauseReason`/`cleanupStatus`/`operationKind`/
    `operationReceiptMarker`/`eventMarker`(합집합 32종)/`leaseMarker` · 서술용 `resourceHoldingState` ·
    `safetyOnlyReasons`/`safetyOnlyEventTypes`.
  - `schemas/milestone_approval_manifest.schema.json` — `autopilotPolicy`(8필드 정확한 상·하한) ·
    `operationAuthorityByTask`(닫힌 `write_file`/`run_process` union) · `executionAuthority`에
    `node`/`processObserver` 추가와 `codex` nullable.
  - 계획에 있던 **typed-plan / review-result schema는 이 slice 범위 밖**이라 만들지 않았다.
- **schema↔runtime 동치 단정을 새 v2 표면 전부로 정확히 확장**했다: 닫힌 key 집합 · enum · required ·
  bounds · nullable codex · node/processObserver 권위 · autopilot 정책 · operation 권위 · 회계 ·
  task 실행 · 전달 · event 감사 필드 · schema 버전. 미상 key는 양쪽에서 여전히 거부된다. 정책 상·하한은
  **경계 밖 값을 runtime이 실제로 거부하는지**까지 확인해 공허하지 않음을 남겼다.
- **테스트·스크립트를 실제 lifecycle 경로로 이관**(흉내·우회 없음):
  시작은 `planRunnableBatch` → `commitPreflightBatch`(정확한 결정 집합) → `startPreparedTask`,
  완료·차단은 `recordTerminal` → `confirmCleanup` 뒤에만, 수령은 `beginDeliveryAttempt` 뒤에만.
  legacy `startTask`/`startScheduledBatch` 거부 테스트는 **보존**하고 기대 코드를 `preflight_required`로
  맞췄다. "충돌·pending·세션 초과 task는 시작할 수 없다"는 이제 **scheduler가 고르지 않음 +
  `preflight_batch_mismatch`** 로 증명한다(우회 진입점 0). 상태를 손으로 고치거나 공개 API를 우회해
  cleanup을 위조한 곳은 없다.
- **손으로 만드는 durable state fixture를 먼저 유효한 v2로** 만들고 **의도한 위조 하나만** 남겼다:
  `completed`에서 `pendingResult` 정리 · forged `running`에 attempt 배정 · journal 위조의
  `approvalDigest` 재계산. 그래서 거부가 자기 일관성 검사가 아니라 **전이 권위 묶기**에서 나온 것임이
  그대로 증명된다.
- **재시작 site에 fixture 시계를 넘겼다**: 실시간 시계로 열면 durable 예산 deadline(`B-12`)이 낡은
  fixture를 `budget_elapsed_exhausted`로 닫아 테스트가 **시간 의존**이 된다(2026-07-27 fixture는 실행일에
  따라 결과가 갈렸다). 계약을 완화한 것이 아니라 fixture를 결정론으로 되돌린 것이다.
- `[M4a][P0-1]` 위조 표의 허용 거부 코드에 **`accounting_approval_mismatch`를 더했다** — 승인을 넓히면
  회계↔승인 묶기가 state↔event binding보다 **먼저** 닫는다(약화가 아니라 게이트 추가).
- `git diff --check` 실패 원인이던 `autopilotLifecycle.test.ts` **EOF 빈 줄 제거**(테스트 동작 무변경).
- **M4 offline acceptance 3종의 소비 대상을 `dist/exec/*` → `src/exec/*`로 바꿨다.** tracked `dist`는
  M5b 계약에 머물러 있고(그 갱신은 M5 handoff의 build 단계다) dist를 소비하면 이 acceptance가 **낡은
  계약을 검사하며 green**이 된다 — 즉 M5c 창 동안 검증면으로서 무가치했다. 호출 방식은 그대로 유지했다
  (`node scripts/m4X-offline-acceptance.mjs`): 로더 없이 들어오면 스크립트가 tsx로 정확히 한 번
  재실행한다. `scripts/acceptance.sh`가 grep하는 라벨·코드 문자열은 **전부 보존**했다(수정 0).

### 검증 실측 (직렬 · 실행한 명령 그대로 · 출력 필터로 exit code를 가리지 않았다)

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit` | **0 error** |
| `npx tsx --test src/exec/autopilotLifecycle.test.ts` | **27/27 pass** |
| `npx tsx --test src/exec/orchestrationKernel.test.ts` | **103/103 pass** (직전 14/103) |
| `node scripts/m4a-offline-acceptance.mjs` | **PASS=32 FAIL=0 · exit 0** |
| `node scripts/m4b-offline-acceptance.mjs` | **PASS=45 FAIL=0 · exit 0** |
| `node scripts/m4c-offline-acceptance.mjs` | **PASS=80 FAIL=0 · exit 0** |
| `git diff --check 81554cf..HEAD` | clean |

`npx tsx --test src/exec/stableController.test.ts`는 **판정 정직성 확인용으로만** 한 번 돌렸다 —
**3/58 pass (55 fail)**, 아래 블록과 동일하다(런타임 소스를 하나도 건드리지 않았으므로 변화가 없다).

### 이 slice가 하지 않은 것 (정직한 기록)

- **여전히 red**: `src/exec/stableController.test.ts` **3/58**. `StableController`는 아직
  `startScheduledBatch()`를 부르므로 autopilot 경로가 `kernel_rejected`로 닫힌다 — controller 재작성이
  M5c의 남은 핵심이고 이 slice의 소유 범위 밖이었다.
- **미구현 그대로**: typed 실행 집행 · trusted Git · managed process supervisor/observer ·
  offline plan worker · 구조화 리뷰 검증 · autopilot CLI · typed-plan/review schema JSON · mutation 8종 · M5d.
- **미실행**: `npm test` · 전체 `test:core` · 전체 acceptance(`scripts/acceptance.sh`) ·
  `npm run test:exec` · stress · live · 반복(3회) · `npm run build`/dist 재생성.
- **`dist`는 여전히 M5b 상태**이므로 `src↔dist` drift가 남아 있고 **배포 가능 상태가 아니다**.
  M4 acceptance가 이제 src를 보므로 그 drift가 검증면을 속이지는 않는다.
- `scripts/acceptance.sh`는 소유 밖이라 수정하지 않았다. 전체 acceptance는 `node scripts/m4X-...`를
  그대로 부르고 스크립트가 스스로 tsx로 재실행하므로 **호출 계약은 깨지지 않았다**(다만 전체 acceptance
  자체는 이 세션에서 미실행이다).
- `B-7`·`B-9`는 손대지 않았고 여전히 **열린 live 하드 게이트**다. `C-22`·`C-36`·`C-39`는 open 그대로다.
- **M5c 완료 선언이나 자기 승인은 하지 않는다.**

## 2026-07-30 (V3 **M5c 착수 — 기반 slice(state/manifest v2 · lifecycle · durable 회계)만 구현. M5c는 미완료이고 기존 테스트가 red다** · 이 블록은 그 시점 기록이다)

worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작·기준 HEAD
`81554cf`(M5b 8차 재리뷰 `APPROVE_TO_STACK` 시점). fresh Claude Opus 5 단일 세션(subagent·병렬 writer 0).
원격 push/PR/merge · 네트워크 · `gh` · MCP · 패키지 설치 · 의존성/lockfile 변경 · live Codex/Claude 추론 ·
secret · deploy · DB · production · live billing **없음**. `--dangerously-skip-permissions` 미사용.

**정직한 판정: M5c는 구현되지 않았다.** 계획(`/private/tmp/m5c-planning-codex-output.txt`)의 9개 작업
묶음 중 **2개(권위 결정 + kernel/state)만** 끝났고, 나머지(typed 실행 집행 · trusted Git · managed
process supervisor · offline plan worker · 구조화 리뷰 검증 · controller 재작성 · autopilot CLI ·
schema JSON · mutation 8종 · M4 acceptance fixture 갱신)는 **착수하지 않았다**.

### 구현한 것 (focused 검증 완료)

- **schema 버전 분리**: `AGENT_MESSAGE_SCHEMA_VERSION="1"`(무변경) / `RUN_STATE_SCHEMA_VERSION="2"` /
  `APPROVAL_MANIFEST_SCHEMA_VERSION="2"` / typed plan · review result 상수. v1 state·manifest는
  **마이그레이션·기본값 0으로 fail closed**(`state_pre_m5c_unsupported` · `manifest_pre_m5c_unsupported`).
- **lifecycle 상태 5종 추가**: `prepared` · `cleaning` · `retry_wait` · `paused` · `cancelled`.
  `RESOURCE_HOLDING_STATES = prepared|running|cleaning`이 배타 자원·`maxSessions` 점유의 **단일 정본**이며
  커밋·load 공용 불변식이 그것을 강제한다(대장 `B-11`·`B-13` 방향).
- **단일 scheduler**: `planRunnableBatch()` → `commitPreflightBatch()`(원자적) → `startPreparedTask()`.
  `startTask()`/`startScheduledBatch()`는 **안정 코드 `preflight_required`로 닫힌 stub**이다(ready→running
  직접 전이가 존재하지 않음을 테스트로 단정할 수 있게 남겼다 — 제거하면 `TypeError`라 taxonomy가 없다).
  재시도(`retry_wait`)도 **같은 scheduler 하나**가 고른다(두 번째 scheduler 없음).
  계획 §2의 네 결과에 **`deferred`를 더했다**(batch 일부만 시작할 때 남은 task 상태를 오염시키지 않기 위해 —
  네 결과보다 엄격히 적게 한다).
- **durable 토큰·경과 회계**(`state.accounting`): 재시작이 예산을 새로 만들지 않고, 같은 `turnId`는 정확히
  한 번만 과금되며, 회계는 `stateContentDigest`에 들어가 손편집이 state↔event binding에서 거부된다.
- **완료·차단은 확인된 zero-survivor 정리 뒤에만**: `requireCleanedTask`(= `cleaning` + `cleanupStatus
  === "confirmed"`) 하나가 `completeTaskWithArtifacts`·`submitResult`·`submitBlocker` 전부를 지난다.
  정리 실패는 `cleaning`에 남고 자원을 계속 붙잡는다.
- **전달 재시도**(대장 `C-12→B`): `message.delivery` durable 메타데이터 + `beginDeliveryAttempt` /
  `failDeliveryAttempt`. 실패는 **수령하지 않고** 재시도만 남긴다. 시도 기록 없는 ack는 거부다.
- **만료 후 safety-only reducer 예외**: DECISIONS 2026-07-30 + 로드맵 **§8.1**에 먼저 기록한 뒤 구현했다.
  전진은 `now >= expiresAt`·durable run deadline에서 닫히고(대장 `C-17` 경계 포함으로 닫음), 회계·취소·
  정리·fail-closed pause만 통과한다. safety-only 커밋은 닫힌 event·사유 집합만 낼 수 있고
  `completed`/`running` 전이와 본문 발행이 구조적으로 불가능하다.
- **대장 `C-24`**: Codex stderr 버퍼 상한을 **정확한 남은 자리만큼** 자른다(이전 판은 큰 chunk 하나가 상한을
  임의로 넘길 수 있었다).
- **대장 `C-40`**: 승인·workspace 경로 길이를 **Unicode 코드 포인트**로 센다(`codePointLength`) →
  draft-07 `maxLength`와 같은 의미. astral 경계 3케이스를 테스트로 고정했다.
- typed operation 권위(`manifest.operationAuthorityByTask`)·`autopilotPolicy`·`executionAuthority.node`·
  `processObserver` **계약면**을 닫았다(deny-by-default 조회 `approvedOperationFor`). `codex`는 null 허용이며
  그 승인으로는 `verifyCodexExecutable`이 `codex_not_approved`로 provider 생성을 거부한다.
  `run_process` 권위의 `executable`은 **승인된 node 경로와 정확히 같아야** 한다(계획보다 의도적으로 좁다 —
  git을 typed operation으로 열면 승인 문서가 원격 쓰기 hard deny를 덮는 형태가 된다).

### 검증 실측 (이 세션에서 실제로 실행한 것)

- `npx tsc --noEmit` — **0 error**.
- 파일 단독 `npx tsx --test src/exec/autopilotLifecycle.test.ts` — **27/27 pass**(신규 focused 파일).
  덮은 것: v2 fail-closed 4종 · preflight 원자성/집합 일치/낡은 revision · `prepared` 점유 ·
  `preflight_drift` · cleanup 뒤 완료 · lease 불일치 · settle 3분기 · 재시작 회계 · 회계 손편집 거부 ·
  전달 재시도 · 만료 경계(C-17) · safety-only 통과/차단 · C-40 astral 3케이스 · operation 권위 deny.
- `git diff --check` — clean. 소유 밖 파일 변경 0. `node_modules` stage 0.

### 실행하지 않은 것 / red 상태 (정직한 기록)

- **기존 focused 테스트가 red다**: `orchestrationKernel.test.ts` **14/103 pass (89 fail)** ·
  `stableController.test.ts` **3/58 pass (55 fail)**. 원인은 결함이 아니라 **미완료 마이그레이션**이다:
  ① 두 파일의 manifest fixture가 v2 필드(`autopilotPolicy`·`operationAuthorityByTask`·`node`·
  `processObserver`)를 아직 담지 않았고 ② 약 48곳이 `startTask`(now `preflight_required`)를 부르며
  ③ 약 49곳의 완료가 `recordTerminal`→`confirmCleanup` 단계를 지나지 않는다.
  **테스트를 완화·삭제하지 않았다** — 마이그레이션이 남아 있을 뿐이다.
- `StableController`는 아직 `startScheduledBatch()`를 부르므로 **autopilot 경로가 동작하지 않는다**
  (`advanceOnce`가 `kernel_rejected`로 닫힌다). controller 재작성이 M5c의 남은 핵심이다.
- `npm run test:exec` · `npm test` · `test:core` · acceptance(M4a/M4b/M4c) · stress · live · mutation 8종 ·
  `npm run build`/dist 재생성 — **전부 미실행**. dist는 의도적으로 **M5b 상태 그대로** 두었다(반쯤
  마이그레이션된 dist를 발행하는 것이 더 위험하다) → **현재 src↔dist는 drift 상태이며 이 커밋은
  배포 가능 상태가 아니다**.
- `B-7`·`B-9`는 손대지 않았고 여전히 **열린 live 하드 게이트**다. `C-22`는 의도적으로 open이다.
  `C-36`·`C-39`는 store 발행 내부를 건드리지 않았으므로 open 그대로다.

## 2026-07-30 (V3 **M5b 7차 리비전 — 독립 Codex 재리뷰 REVISE(A/P1=2): git 내용이 spawn마다 재검증되지 않음 · body 발행이 검증 이후 교체본을 link하고 복구 journal을 삭제할 수 있음** · **독립 재리뷰 대기**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `ff5e035`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(이전 세션 transcript·자기평가
미상속). amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 ·
MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
subagent·병렬 writer 없음(단일 세션 직렬 — 공유 dirty 체크아웃). `node_modules`(supervisor symlink)는
**stage하지 않았고** 세션 끝에 `unlink`로 제거했다. Ponytail(full) 적용.

> **정정 — 6차 리비전 기록의 부분성.** 6차 기록은 A1·A3를 "둘 다 닫았다"고 적었지만 7차 독립 리뷰는
> **둘 다 PARTIAL**로 판정했다(초기 A2 CLOSED · 초기 A4 PARTIAL). 공통 뿌리는 **"검증을 트랜잭션 1회 단위로
> 잡았다"** 이다: 6차는 *무엇이 권위인가*는 바로잡았지만 *언제 다시 보는가*를 넓게 잡아서, git은 경계 진입
> 1회만 해싱한 뒤 두 자식 프로세스를 await했고 body는 전수 preflight 1회 뒤 경로 이름 그대로 link했다.
> 이전 절은 dated history로 보존한다.

- **A1 — git 검증 단위를 프로세스 1회에서 spawn 1회로 좁혔다.** `GitGate` 하나를 두고 **모든 git spawn이
  자기 `runProcess`/`spawnSync` 직전에** 같은 fd(`O_RDONLY|O_NOFOLLOW`) 신원 + 승인 SHA-256을 다시 증명한다.
  게이트와 spawn 사이에 **`await`가 없다**. `readCheckoutHead()`의 두 호출 각각과 `revalidateSync()`의
  controller/target 회차 각각이 자기 게이트를 지나며, 루프 앞 1회 검증은 제거했다(spawn별 게이트가 포함).
  남는 창은 **fd 해싱→exec syscall 몇 개**뿐이고 그 한계는 그대로 적었다(`fexecve` 없음 — `C-5`와 같은 종류).
  호출자 경로·PATH 조회·ambient env·대체 trust root·신규 의존성은 없고 manifest-only 실행 권위와
  provider/controller attestation 계약은 그대로다.
- **A2 — body 발행을 link 직전·직후·journal 삭제 직전에 다시 증명한다.** `ownershipOf()`가 **열린 fd
  하나로** dev+ino·정확한 바이트 수·내용 SHA-256을 판정한다(`absent`/`ours`/`foreign`). ⓐ hook 이후·
  `linkSync` 직전 staging 재증명(같은 digest의 다른 inode도 거부 — 입양 금지) ⓑ `linkSync` 직후 최종 이름
  재증명(EEXIST 경합·교체본을 그 자리에서 접고 **staging 증거를 지우지 않는다**) ⓒ `finishJournal()` 하나가
  journal 삭제의 **유일한 경로**이며(정상 커밋 + "이미 목표 state" 복구 공용) `journal:cleanup` hook을
  **먼저** 울린 뒤 **모든** 최종 body를 전수 재증명한다. 어긋나면 **journal을 남기고** fail closed다.
  roll back은 최종 body가 애초에 없으므로 자기 경로를 유지한다(이유를 주석에 남겼다).
- **낡은 주석 정정.** store `recoverPendingCommit`의 "`C-37` 닫힘" · kernel `completeTaskWithArtifacts`와
  `stableController` 모듈 doc의 "roll forward" 서술 · `setCommitFaultHook`의 "부를 수 있는 것은 던지는
  일뿐" 서술(hook은 **동기 파일 변경도 한다** — `C-36` 증거 갱신)을 사실대로 고쳤다. **둘 다 닫지 않았다.**
- **B 7건은 하나도 닫지 않았다**(`B-7`·`B-9`·`B-10`·`B-11`·`B-12`·`B-13`·`C-12`→B — 기한·트리거 원문 유지).
  **C 12건**: 11건(`C-35`·`C-5`·`C-17`·`C-29`·`C-19`·`C-36`·`C-37`·`C-30`·`C-38`·`C-39`·`C-26`) 상태 유지 +
  ID 없던 **승인 경로 schema regex와 runtime의 갈림**을 **`C-40`** 으로 등록하고 **이번에 정렬해 닫았다**
  (정본 pattern `APPROVED_PATH_PATTERN` 하나를 runtime·schema가 공유 · 양/음성 표 전수 동치 테스트 ·
  사전 실측 1021 케이스 불일치 0 · 양방향 mutation kill).
- **테스트(worker 자기보고 — 독립 실측 아님)**: kernel **103/103**(98 → 103) · controller **58/58** ·
  provider **59/59** · boundary **20/20**(17 → 20) · reviewer **21/21** · parser **28/28** ·
  `tsc --noEmit` clean · `build` + `git diff --check` clean · `node --check` emitted 5파일 ·
  **dist 런타임 프로브 2종**(A1 제자리 교체 → digest 불일치·spawns=1·sentinel 미실행 · C-40 비정규 경로 거부 /
  A2 `journal:cleanup` 제자리 변경 → `journal_body_foreign`·journal 보존·파일 미삭제·**reopen도 완료 아님**) ·
  승인 schema·발행 경로가 바뀌어 **kernel 계열 offline acceptance 3개 재실행**: `m4a` **31/31** ·
  `m4b` **42/42** · `m4c` **77/77** · race-sensitive subset(경계+kernel) **3회 직렬 123/123** ·
  `npm run test:exec` **361/361**(353 → 361, 최종 원복 구현으로 1회).
  **mutation 9종 전부 kill · 살아남은 0 · `shasum -c` 바이트 동일 원복 · `MUTATION` 잔재 0.**
- **미실행**: `npm test` 전체 · `test:core` · 전체 `acceptance.sh` · stress · live · MCP · 실제 추론 · push.
- **자기 승인 아님**: 다음 게이트는 fresh Codex `gpt-5.6-sol` xhigh read-only **8차** 리뷰(`409dee2..HEAD`
  전 범위)이고, 위 fixed 판정 전부가 재확인 대상이다. **A=0**일 때만 M5b가 전진한다.

## 2026-07-28 (V3 **M5b 6차 리비전 — 독립 Codex 재리뷰 REVISE(A/P1=2): caller가 고른 임의 Git/Codex 실행 파일이 권위 · journal이 base 승인·전이·body 소유권에 묶이지 않음** · **독립 재리뷰 대기**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `6a5e418`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(이전 세션 transcript·자기평가
미상속). amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 ·
MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
subagent·병렬 writer 없음(단일 세션 직렬). `node_modules`(supervisor symlink)는 **stage하지 않았고**
세션 끝에 `unlink`로 제거했다. Ponytail(full) 적용.

> **정정 — 5차 리비전 기록의 과장.** 5차 기록은 A1·A3(3건)·A4를 "넷 다 닫았다"고 적었지만 6차 독립 리뷰는
> **A1을 OPEN** · **A3를 OPEN**으로 판정했다(A2만 CLOSED · A4는 PARTIAL). 공통 뿌리는 **"권위의 근거를 같은
> caller 입력·자기 일관성에서 찾았다"** 이다: 실행 파일의 *기대값 자체가 caller 옵션*이라 provider·controller
> 양쪽에 같은 임의 경로를 주면 대조가 성립했고(같은 inode 제자리 덮어쓰기도 통과) journal은 *자기 안에서만*
> 일관됐으므로 해시를 전부 재계산한 위조 후속을 복구가 발행했다. 이전 절은 dated history로 보존한다.

- **A1 — 실행 권위의 trust root를 kernel 소유 승인으로 옮겼다.** `MilestoneApprovalManifest`에 필수
  **`executionAuthority`**(codex·git 각각 **정규 절대경로 + 내용 SHA-256**)를 추가하고, **실행 파일 경로를
  고르는 호출자 옵션을 전부 삭제**했다(provider `executablePath`/`gitExecutablePath` · controller
  `codexExecutablePath`/`gitExecutablePath` · 경계 `gitExecutablePath`). 새 `verifyApprovedExecutable()`이
  경로를 **한 번만 열고**(`O_RDONLY|O_NOFOLLOW`) 같은 fd에서 정규·비symlink·일반 파일·실행 비트·타인 쓰기
  없음·**pin된 dev+ino**·**승인 digest**(64KiB chunk, 512MiB 상한)를 판정하며 **provider 생성 · controller
  생성 · 경계 진입 · spawn 직전**에 각각 다시 부른다 → 같은 inode 제자리 덮어쓰기가 fail closed다. controller는
  kernel(SoR) 승인의 두 경로를 자기 손으로 열어 검증한 뒤 checkout·승인 digest·시각 권위와 대조하고,
  불일치는 **git·codex spawn 이전에** `controller_provider_authority_mismatch`로 생성 거부다.
  하위 호환은 **fail closed**(`executionAuthority` 없는 manifest·state는 `invalid_manifest`, 마이그레이션 없음).
- **A3 — 복구가 후속 state를 만들 권한을 없앴다.** roll forward를 **폐기**해 규칙은 "기준 바이트면 roll back /
  정확히 목표 바이트면 마무리 / 그 밖 fail closed" 둘뿐이다. 발행 순서를 **journal → append → snapshot →
  state → 최종 body**로 바꿔 기준 상태 복구가 최종 body를 만들거나 지울 필요가 없게 했다. journal은 이제
  기준 **불변 권위**(milestone·승인 digest·내용 digest·생성 시각·메시지 수) · **기준 event 접두 신원** ·
  **`JSON.stringify(validateEvent(...))` 정본 바이트** · **base→target body delta** · **staging dev+ino/바이트
  수/digest**에 묶인다. 최종 body는 **`link(2)` no-clobber CAS**로만 발행하고, 남의 same-digest 파일은
  **채택도 삭제도 하지 않는다**(rollback은 자기 staging만 지운다).
- **B 7건은 하나도 닫지 않았다**(`B-7`·`B-9`·`B-10`·`B-11`·`B-12`·`B-13`·`C-12`→B — 기한·트리거 원문 유지).
  **C 10건**: 9건(`C-35`·`C-5`·`C-17`·`C-29`·`C-19`·`C-36`·`C-37`·`C-30`·`C-38`) 상태 유지 + ID 없던
  staging/tmp 정리 orphan을 **`C-39`** 로 등록. **`C-37`은 닫지 않았다** — 범위가 발행 경계 11개 중 2개
  (`body:publish`·`journal:cleanup`)로 줄었을 뿐이고 그 사실을 증거와 함께 적었다. `C-36`도 그대로 open.
- **테스트(worker 자기보고 — 독립 실측 아님)**: kernel **98/98**(89 → 98) · controller **58/58**(57 → 58) ·
  provider **59/59** · boundary **17/17** · reviewer **21/21** · parser **28/28** · `tsc --noEmit` clean ·
  `build` + `git diff --check` clean · **dist 런타임 프로브**(승인 digest·제자리 덮어쓰기 거부 · 권위 불일치 ·
  foreign tail 보존 · 유효 journal + 완전 append → roll back · spawn 0) · 승인 schema·발행 프로토콜이 바뀌어
  **kernel 계열 offline acceptance 3개 재실행**: `m4a` **31/31** · `m4b` **42/42** · `m4c` **77/77**.
  **mutation 13종 전부 kill · 살아남은 0 · 바이트 동일 원복 · `MUTATION` 잔재 0.**
- **재개 검증(최종 코드 기준 실측)**: authority/provenance/recovery subset(kernel·controller·provider)
  **3회 직렬 215/215** · `npm run test:exec` **353/353**(343 → 353).
  **정직한 기록**: 이 세션은 중간에 한 번 끊겼다. 첫 `test:exec` 353/353은 **마지막 store 리팩터(발행 전 body
  전수 사전 검증) 직전** 수치였고, 위 두 줄이 **재개 후 최종 코드로 다시 돌린** 값이다. 재개 시점에
  production 5파일은 레포 밖 backup과 `cmp` **바이트 동일**이고 `MUTATION` grep은 **0**이었다.
- **미실행**: `npm test` 전체 · `test:core` · 전체 `acceptance.sh` · stress · live · MCP · 실제 추론.
- **이 세션은 스스로를 승인하지 않는다** — 다음 fresh Codex xhigh read-only 리뷰가 게이트다.

## 2026-07-28 (V3 **M5b 5차 리비전 — 독립 Codex 재리뷰 REVISE(A/P1=4): 임의 executable/git 권위가 증명됨 · journal 전에 생긴 최종 body · 남의 event suffix 파괴 · 열린 journal schema** · **독립 재리뷰 대기** · **위 6차 리뷰가 A1/A3를 다시 열었다**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `35de547`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(이전 세션 transcript·자기평가
미상속). amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 ·
MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
subagent·병렬 writer 없음(단일 세션 직렬). `node_modules`(supervisor symlink)는 **stage하지 않았다**.
Ponytail(full) 적용.

> **정정 — 4차 리비전 기록의 과장.** 4차 기록은 A1~A4를 "넷 다 닫았다"고 적었지만 5차 독립 리뷰는
> **A1을 PARTIAL** · **A3를 OPEN(3건)** · **A4를 PARTIAL**로 판정했다(A2만 CLOSED). 공통 뿌리는
> **"증명·복구의 근거를 좁게 잡았다"** 이다: 증명은 *누가*(발급 등록부·메서드 신원)만 봤고 *무엇을 실행하는가*
> (숨은 executable·git·승인·checkout·시계)는 보지 않았고, 복구는 **바이트가 아니라 크기·revision 숫자**로
> 판정했으며 최종 body가 **journal보다 먼저** 생겼다. 이전 절은 dated history로 보존하고 아래가 현행 사실이다.

- **A1 — 증명이 "설정 신원"까지 본다.** provider production 분기가 생성 시점에 codex/git 실행 파일(정규 ·
  비symlink · 일반 파일 · 실행 비트 · 타인 쓰기 없음 · **dev+ino**) · controller checkout · **승인 canonical
  digest** · 시각 권위를 런타임 검증해 **불변 스냅샷**으로 고정한다(검증 불가면 **생성 자체 실패**).
  판정 함수는 `attestReadOnlyCodexProvider(provider, expected)`로 바뀌어 **호출자가 스스로 검증해 온 기대
  권위와의 대조 결과만** 준다(신원 객체 미export → 임의 실행 파일에 "승인처럼 읽히는 답"이 없다).
  `StableController`에 **명시 필수 `codexExecutablePath`** 를 추가해 controller가 그 경로와 git 경로를 직접
  검증하고 kernel(SoR) 승인 digest·checkout·시각 권위와 함께 대조 → 불일치는 **git·codex spawn 이전에**
  `controller_provider_authority_mismatch`로 생성 거부. 실행 파일 신원은 **매 invocation 생성 시점 pin으로**
  재검증하고 git 신원은 실행 경계에도 pin으로 넘어간다. 회귀: **valid-mode sentinel 실행 파일** 6케이스
  (임의 codex · 다른 git · controller가 다른 git 기대 · 다른 승인 · 다른 checkout · 다른 시계) 전부 생성 거부 +
  **두 sentinel 모두 미실행**, **명시로 pin한 sentinel은 사용 가능**(양성 대조군), 같은 경로 다른 inode 거부
  (생성·실행 두 시점), custom-spawn 비증명·freeze·own property 0·production 성공 경로 유지.
- **A3 — 최종 body는 journal 뒤에만 생긴다.** body는 **트랜잭션 소유 staging**(`.staged-<txn>.<id>.md`)으로
  먼저 쓰고 journal에 **대상 + 내용 digest**를 담은 뒤 `body:publish` 단계에서만 최종 이름이 된다. journal
  발행 전 실패는 이 invocation의 staging을 스스로 지운다(최종 body 0). roll forward는 참조되는 body를 **전부**
  확인·발행하고(없으면 `journal_body_missing`으로 state를 쓰지 않는다) roll back은 **자기 트랜잭션 파일만**
  지운다. 회귀: 발행 경계 11곳 · **다중 body** · 같은/다른 id 재시도 · reopen · staging 정리 ·
  **최종 디렉터리 열거 = 색인** · 기존 body 보존. "orphan은 무해" 단정·주석은 **삭제**했다.
- **A3 — 남의 event 바이트를 보존한다.** `baseEventBytes` 이후 **실제 바이트**를 읽어 완전 append면 roll
  forward · **정확한 접두**면 roll back · 그 밖(같은 길이의 남의 바이트 · 접두 아닌 짧은 바이트 · 완전
  append + 여분)은 `journal_foreign`으로 fail closed이고 **모든 파일이 바이트 그대로** 남는다.
- **A3 — journal은 closed schema + 전이 전수 묶기다.** 미상/누락 필드 거부 · bounded 정수 · 정규형 ·
  경로 runId · milestone · 승인 digest · **기준 state 원본 바이트 digest**와 chain · 후속 revision · 정규
  event record · eventId/prevHash 체인 · 최종 hash · state 정규 바이트/내용 digest · body 대상+digest.
  복구는 **쓰기·삭제 전에** 전부 검증하고, 무효 journal은 아무 바이트도 바꾸지 않는다. 회귀 26케이스.
- **B 7건은 하나도 닫지 않았다**(`B-7`·`B-9`·`B-10`·`B-11`·`B-12`·`B-13`·`C-12`→B — 기한·트리거 원문 유지).
  **C 9건**: 8건(`C-35`·`C-5`·`C-17`·`C-29`·`C-19`·`C-36`·`C-37`·`C-30`) 사실·기한 유지 + ID 없던 caller
  getter artifact taxonomy를 **`C-38`** 로 등록. `C-36`/`C-37`은 **직접 증거가 없어 재분류하지 않았다.**
- **테스트(worker 자기보고 — 독립 실측 아님)**: kernel **89/89**(82 → 89) · controller **57/57**(54 → 57) ·
  provider **59/59** · boundary **17/17** · reviewer **21/21** · `npm run test:exec` **343/343**(최종 원복
  구현으로 1회) · authority/provenance/recovery subset **3회 직렬 205/205** · `tsc --noEmit` clean ·
  `build` + `git diff --check` clean + **dist 런타임 프로브** · `m4a` 31 · `m4b` 42 · `m4c` 77.
  **mutation 11종 전부 kill · 살아남은 0 · 바이트 동일 원복 · `MUTATION` 잔재 0**(⑧ `stateContentDigest`
  묶기는 처음 살아남아 **정합적 위조 회귀**를 추가해 kill했다 — 이 이력을 지우지 않는다).
  **정직한 관측**: `test:exec` 첫 실행에서 호스트 부하 기인 `boundary_git_failed` 1건(고정 10초 git 상한),
  즉시 재실행 343/343. 테스트를 완화하지 않고 §0-0에 기록했으며, 게이트 회귀들이 run 하나를 공유하도록
  정리해 git 프로세스 수를 줄였다(단정 불변).
- **미실행**: `npm test` 전체 · `test:core` · 전체 `acceptance.sh` · stress · live · MCP · 실제 추론.
- **이 세션은 스스로를 승인하지 않는다** — 다음 fresh Codex xhigh read-only 리뷰가 게이트다.

## 2026-07-28 (V3 **M5b 4차 리비전 — 독립 Codex 재리뷰 REVISE(A/P1=4): 런타임에서 writable한 권위·예산 · 위조 가능한 완료 권위 · 비원자적 물리 발행 · caller getter 재읽기** · **독립 재리뷰 대기**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `d554a46`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(이전 세션 transcript·자기평가
미상속). amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 ·
MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
subagent·병렬 writer 없음(단일 세션 직렬). `node_modules`(supervisor symlink)는 **stage하지 않았다**.
Ponytail(full) 적용.

> **정정 — 3차 리비전 기록의 과장.** 3차 기록은 A1~A3를 "전부 닫았다"고 적었지만 4차 독립 리뷰는 셋을
> **PARTIAL**로 판정했다: executor 신원·오류 provenance는 닫혔으나 **같은 클래스의 나머지 상태**
> (controller의 봉인 권위·pin·토큰 카운터, provider의 설정)가 TS `private`에 남아 **런타임에서 writable**
> 이었고, **완료 권위 자체는 구조적으로만** 검사됐으며(가짜 kernel이 디스크 변화 0으로 success 발급),
> **물리 발행은 여전히 네 연산**이었다. 이전 절은 dated history로 보존하고 아래가 현행 사실이다.

- **A1 — 권위·예산 상태를 런타임에서 감췄다.** `StableController`의 `#sealed`·`#pins`·`#tokensUsed`·`#opts`와
  **게이트 메서드 14개 전부**를 ECMAScript `#private`으로 옮기고 인스턴스·prototype을 freeze했다 →
  own property 0, 어떤 대입·`defineProperty`도 던지며, `defineProperty`로 `assertGatesOpen`을 no-op으로
  덮어 만료·예산 게이트를 지우는 경로도 사라졌다(밖에 남는 표면은 `advanceOnce`·`usedTokens`·
  `approvedManifest`·`approvedCommit` 넷). `CodexCliProvider`는 **생성 시점의 정규화된 immutable `#config`**
  하나만 실행 권위로 쓰고(호출자 `opts`는 tripwire 전용 참조), `id`를 prototype getter로 옮기고 인스턴스를
  freeze했으며, 증명은 **own property가 0인 인스턴스만** 통과시킨다. 회귀: own-property 전수 · 권위·카운터·
  게이트 19개 후보에 대입+`defineProperty` · **토큰 리셋 불가** · **start 전 opts 변조도 baseline이 되지
  못한다(spawn 0)** · custom-spawn 비증명 + 실제 OS 자식 프로세스 성공 경로 유지.
- **A2 — 완료 권위에 발급 증명을 붙였다.** kernel 모듈에 사설 발급 등록부(WeakSet)와 **사설 생성 토큰**을
  두고(토큰 없는 직접 생성은 `kernel_issuer_required`), 인스턴스는 own property 0 · freeze이며 `paths`는
  prototype getter가 freeze된 값만 준다. 밖으로 나가는 것은 판정 함수 하나뿐이고, controller는 **정확한
  instance/prototype/메서드 신원**만 캡처해 구조적 객체·delegate·proxy·subclass·override를 **생성에서
  거부**한다(`controller_kernel_not_genuine`). 기존 `delegateKernel` 테스트를 성공/실패 경계에서 떼어내
  "생성 거부" 회귀로 재구성했고, 성공 회귀는 **revision·event tail·body 파일·artifact record·snapshot의
  실제 변화 + 새 genuine kernel reopen이 `completed`** 임을 확인한다.
- **A3 — 발행을 복구 가능한 트랜잭션으로 바꿨다.** `commitRun`이 준비(예정 state를 **런타임 validator
  전수**로 다시 닫는다) → 발행(body → **`commit.journal` 원자적 rename** → event append → snapshot → state →
  journal 삭제) 두 국면이고, 다음 `commitRun`·`loadRun`이 journal을 보고 **결정론적·멱등**으로 roll
  forward(append가 정확히 journal 바이트로 끝났을 때) 또는 roll back(0바이트·찢어진 부분 append)한다.
  신규 런타임 의존성 0 · 별도 오케스트레이터 0. 발행 경계 **10곳 전수** fault 주입으로 "가시적 전이 0
  또는 결정론적 복구 + 재시도·전진 성공 + event/revision 중복 0"을 검증했고, 찢어진 append 되돌림과
  journal 변조 4종 fail closed도 고정했다. 테스트 seam은 **store 안에만 있는 bounded hook**이다.
- **A4 — caller-owned 산출물을 단일 읽기로 입양한다.** `{path, role}`을 닫힌 key 집합으로 확인하고 각
  property를 정확히 한 번 읽어 불변값으로 굳힌 뒤 원본을 다시 읽지 않는다(단건·트랜잭션 두 등록 경로가
  같은 헬퍼). throwing getter/proxy(`ownKeys` trap)·미상/symbol key·cyclic·깊은 payload는 안정 코드로
  거부하고 durable delta 0이며, 교대 getter는 **첫(검증된) 값으로만 굳고** reopen이 성공한다.
- **테스트(worker 자기보고)**: `orchestrationKernel.test.ts` **82/82** · `stableController.test.ts`
  **54/54** · `codexCliProvider.test.ts` **59/59** · `npm run test:exec` **333/333** ·
  authority/provenance/recovery subset 3파일 **3회 직렬 195/195** · `npx tsc --noEmit` clean ·
  `npm run build` + source/dist parity(emitted JS의 `#private`·freeze·발급 등록부를 런타임으로 확인) ·
  `git diff --check` clean · 발행 프로토콜을 건드렸으므로 kernel 계열 offline acceptance 개별 재실행
  (`m4a` 31/31 · `m4b` 42/42 · `m4c` 77/77). **`npm test` 전체 suite·전체 `acceptance.sh`·stress·live는
  실행하지 않았다.**
- **mutation 비공허성 7종 실측 · 전부 kill · 정확히 원복 · 살아남은 것 0건**(상세: 로드맵 §10 M5b 4차 리비전).
- **커밋**: code/tests/dist `b64974a` + docs(이 절).
- **여전히 아닌 것**: 독립 재리뷰·승인(다음 fresh Codex read-only 리뷰가 게이트) · M5c 착수 · live 실행.
  B 7건(`B-7`·`B-9`·`B-10`~`B-13`·`C-12`→B)은 **하나도 닫지 않았다**.

## 2026-07-28 (V3 **M5b 3차 리비전 — 독립 Codex 재리뷰 REVISE(A/P1=3): 공개 `spawn` seam으로 증명 위조 · exported class로 오류 provenance 위조 · 비원자적 다중 artifact 완료** · **독립 재리뷰 대기**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `38b8d32`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(이전 세션 transcript·자기평가
미상속). amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 ·
MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
`node_modules`(supervisor symlink)는 **stage하지 않았다**. Ponytail(full) 적용.

> **정정 — 2차 리비전 기록의 과장.** 2차 기록은 A2(증명)·A5b(닫힌 taxonomy)를 "닫았다"고 적었다.
> **같은 뿌리가 남아 있었다**: 증명과 provenance의 근거가 여전히 **공개 API 표면**(`opts.spawn` 콜백,
> exported `ControllerError` 클래스)이었으므로 다른 공개 표면으로 같은 위조가 가능했다.
> 3차 독립 리뷰가 **A/P1=3**을 냈고 아래가 현행 사실이다. 이전 절은 dated history로 보존한다.

- **A1 — 임의 executor를 주입한 인스턴스는 증명받지 못한다.** `CodexCliProviderOpts.spawn`은 공개 임의
  callback인데 생성자가 `opts.spawn ?? nodeSpawn`을 포착한 **모든** 인스턴스를 증명 등록부에 넣었다 →
  증명을 통과한 callback이 argv·env를 무시하고 임의 write/command/network를 할 수 있었다. TS
  `private readonly spawnFn`도 emitted JS에서는 writable own field였고 **controller 테스트가 실제로 그것을
  덮어썼다**. 지금: 모듈 사설 `PRODUCTION_SPAWN`(적재 시점의 진짜 `node:child_process.spawn`) +
  `#spawn`·`#sessions`를 **ECMAScript `#private`** 로 봉인 + **`opts.spawn`을 준 인스턴스는 등록하지
  않는다**(하위 계층 단위 테스트용 untrusted seam으로 유지 — provider 테스트 58건 커버리지 그대로).
  **controller 성공 경로 테스트를 실제 OS 자식 프로세스로 전환**했다: 기존 `__fixtures__/fake-codex.mjs`를
  절대 `process.execPath` shebang 래퍼(0700)로 감싸 default `nodeSpawn`이 직접 실행 → 생성·증명·봉인·경계·
  argv·env·stdin·파서가 전부 production 경로다(codex/claude 추론·네트워크 0). 세션 종료 관측도 내부 map
  교체를 버리고 **공개 API 프로브**로 바꿨다.
- **A2 — marker는 이 모듈이 발급한 오류에서만 나온다.** `ControllerError`가 public constructible이고
  `atBoundary`가 `instanceof ControllerError`를 내부 오류로 보존했으므로 handoff가
  `new ControllerError("result_accepted", …)`만 던지면 `status:"failed"` + `marker:"result_accepted"`가
  만들어졌다. 지금: 모듈 사설 `ISSUED_HERE` WeakSet이 provenance이고, 경계는 **예외 없이** 고정 코드로
  접는다. 호출자 콜백 전수 차단 — handoff · provider start/send/events · **`opts.nowMs` 시계** ·
  **`opts.kernel` 전 메서드**. kernel native 코드는 **닫힌 집합 `KERNEL_MARKERS`(23종)** 일 때만 입양하고
  나머지는 `kernel_rejected`다. 신뢰된 정적 import만 `atTrusted`로 코드를 입양한다(근거는 호출 지점).
  kernel이 **돌려준 값의 throwing getter**까지 접는다. `consumeExactlyOneTerminal`은 클래스 대신
  **factory**를 받아 소비자가 자기 provenance를 붙인다.
- **A3 — 완료는 kernel의 단일 원자 트랜잭션이다.** controller가 `registerArtifact`를 산출물마다 durable
  commit한 뒤 별도로 `submitResult`를 불렀으므로, 뒤쪽 산출물이 없거나 무효·중복·상한 초과이거나
  envelope/body 검증이 실패하면 **앞선 artifact·event·revision만 durable에 남았고** 재시도가 revision을
  계속 올렸다. 새 kernel API `completeTaskWithArtifacts`가 검증(envelope·summary·body·전이 → 산출물 전체의
  소유권·writableRoots·파일/hash/symlink·role·개수 상한 16·경로 중복) 뒤 artifact record + event +
  result 메시지 + `completed` 전이를 **한 커밋**으로 반영한다. 소유권·파일 신원 집행은 `registerArtifact`와
  **같은 헬퍼**(`addArtifact`)라 진입점이 둘이어도 불변식은 하나다. 기존 API·테스트는 호환 유지.
- **리뷰 B 2건도 유예하지 않고 닫았다.** `B-14`(종료를 **처음 본 자리에서** 회계 → 늦은 이벤트·중복 종료·
  종료 뒤 iterator throw 경로에서도 태운 토큰이 예산에서 빠진다) · `B-15`(`ReviewSubject`를 한 줄·정규형·
  bounded·정규 16진 hash로 closed 검증하고 **frozen 스냅샷**만 프롬프트·대조·반환값에 쓴다).
  리뷰 C 1건은 `C-32`로 등록 후 닫았다(inbox 항목 단일 읽기 — `deliveryPrompt`가 원본 alias를 다시 읽지 않는다).
- **테스트(worker 자기보고 — 독립 리뷰 실측 아님)**: `stableController` **52/52** · `orchestrationKernel`
  **74/74** · `codexCliProvider` **58/58** · `reviewer` **21/21** · `npm run test:exec` **322/322** ·
  authority/atomicity/timing subset **3회 직렬 205/205** · `npx tsc --noEmit` clean · `npm run build` +
  source/dist parity · `git diff --check` clean. **`npm test` 전체 suite·acceptance·stress·live는 미실행**
  (최종 M5d handoff에서 supervisor가 직렬 1회).
- **mutation 비공허성**: A1/A2/A3 핵심 게이트를 각각 되돌려 회귀가 죽는 것을 확인하고 정확히 원복했다.
  **살아남은 mutation 1건**: `codeOf`의 provenance 검사를 느슨하게 해도 처음에는 아무 테스트도 실패하지
  않았다(래퍼들이 이미 owned 오류로 접기 때문). 실제 도달 경로를 찾아 회귀를 추가해 죽였고, 남은 중복성은
  대장 `C-34`로 등록했다. 숨기지 않는다.
- **여전히 self-approved가 아니다.** 위 fixed 판정 전부가 다음 fresh Codex 독립 read-only 리뷰의
  재확인 대상이다.

## 2026-07-28 (V3 **M5b 2차 리비전 — 독립 Codex 재리뷰 REVISE(A=5): 재읽기 가능한 authority · 위조 가능한 read-only brand · 실패 turn 예산 누락 · 파서 허위 승인 · 열린 오류 taxonomy** · **독립 재리뷰 대기 · M5 미완료**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `ac827bf`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(이전 세션 transcript·자기평가
미상속). amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 ·
MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
`node_modules`(supervisor symlink)는 **stage하지 않았다**. Ponytail(full).

> **정정 — 이전 세션의 과장.** 1차 리비전 기록은 "A/P1 5건 전부 fixed"라고 적었다. **사실이 아니었다.**
> 2차 독립 리뷰가 **같은 다섯 자리에서 A=5**를 다시 냈고, 그중 넷은 "고쳤다고 적은 코드가 여전히 열려
> 있었다"였다. **A4(포인터 재검증)만 유지**됐다. 아래가 현행 사실이다.

- **리비전 커밋 `55b488f`** — `fix(v3-m5b): 봉인 단일 읽기 · 위조 불가 read-only 증명 · 실패 turn 회계 ·
  닫힌 리뷰/오류 taxonomy`. + 이 docs 커밋.
- **A1 — 생성 권위를 정확히 한 번 읽는다.** `captureKernel`의 `scheduleReady`/`startScheduledBatch`는
  **호출 시점에 caller 소유 property를 다시 읽는 wrapper**였고, 생성자 검증도 `typeof k[m]`으로 본 **뒤**
  `k.m.bind(k)`로 다시 읽었다 → 교대 getter/proxy면 검사한 함수와 실행하는 함수가 갈렸고, **재진입
  `nowMs`** 가 pin 통과 뒤 메서드를 갈아끼우면 그 교체본이 실행됐다. 이제 caller property를 지역 변수로
  **한 번만** 읽고 그 값을 검증·bind·pin 기준으로 쓴다(`captureMethods`). 회귀 2건: 재진입 시계 ·
  교대 getter — 둘 다 "교체본 실행 0 + `controller_binding_drift`"를 단정한다.
- **A2 — read-only 권위를 위조 불가로.** `READ_ONLY_EXECUTION_CONTRACT`가 **공개 export** 였으므로 같은
  프로세스의 아무 provider나 import해 달 수 있었다(자기 신고였다). 공개 brand를 **제거**하고
  `codexCliProvider.ts`에 **모듈 사설 WeakSet**을 뒀다 — 등록은 `CodexCliProvider` 생성자 하나,
  밖으로 나가는 것은 판정 함수 `attestReadOnlyCodexProvider` 하나뿐이다(**발급기·토큰·임의 provider factory
  없음**). 판정 = WeakSet + prototype 동일성 + 메서드 함수 신원이고, prototype은 얼렸다.
  **거부**: 심볼/property 복사 · prototype 위조·`setPrototypeOf` · subclass(override 유무 무관) ·
  인스턴스 override · `Proxy` wrapper · 임의 scripted provider.
  그 결과 **controller 테스트의 provider를 흉내에서 진짜 `CodexCliProvider` + 주입 spawn seam으로 바꿨다**
  (live codex/claude·네트워크·자식 프로세스 0 — `FakeChild`는 in-process다). 관측은 자식이 받은
  argv·cwd·env·stdin으로 한다. **주장 범위는 좁다**: 같은 프로세스에서 *공개 API만으로는* 못 들어온다는
  것이지 OS 샌드박스가 아니다.
- **A3 — 실패한 turn의 usage도 예산에서 뺀다.** 공용 소비자가 `isError`에서 **먼저 던져서** 회계가 건너뛰어졌다.
  이제 종료 1건 확정 뒤 **성공/실패 해석 전에** `onTerminal`을 정확히 한 번 부른다. 회귀 2건:
  실패 turn이 상한을 소진 → 다음 task는 provider 호출 0 · `budget_tokens_exhausted` / 실패+성공 = 정확히 10(이중 회계 0).
- **A5a — 리뷰 파서의 허위 승인 경로.** 대상 신원 `includes`(라벨 뒤바뀜·접두/접미·"다른 대상 + 기대값 언급"
  통과) · 펜스가 **여는 길이를 잊어** 3-백틱이 4-백틱 블록을 닫음(가짜 `## Verdict: pass` 노출) ·
  findings의 미상 비공백 줄 무시(`- 없음` + `P1: 승인 우회`). 전부 닫았다: 정확·유일·한 줄 라벨 + 완전 일치 /
  문자+길이 있는 펜스(틸드 동등 · 정보 문자열이 붙으면 닫는 펜스가 아니다) / 미상 줄 거부 + 본문
  nonempty·bounded / heading **순서**까지 계약. **`B-8` 세 번째 close.**
- **A5b — 열린 오류 taxonomy.** `consumeExactlyOneTerminal`이 "문자열 `code`를 가진 Error"면 전부
  통과시켰다 → provider가 `result_accepted`를 달고 던지면 **성공처럼 보이는 marker를 단 실패**가 됐다.
  이제 소비자는 **자기가 만든 오류만** 통과시키고(참조 동일성 · `throw null`도 안전), controller는
  handoff·start·send·events를 `handoff_failed`/`provider_start_failed`/`provider_send_failed`/
  `provider_stream_failed`로, reviewer는 전부 `reviewer_provider_failed`로 접는다.
  `finally`의 `stop()` 동기 throw도 삼킨다.
- **`C-2` 닫음(overdue였다)**: 트리거("production 파일을 여는 다음 승인 범위")는 **M5b에서 이미 발화**했는데
  1차 리비전이 처리하지 않았다. `scripts/lib/fixture-config.mjs` 주석이 진입점 **5개 전수**를 적도록 고치고
  `suiteExclusiveLock.test.ts` **75/75**로 소스 감사 계약을 확인했다.
- **신규 유예**: `C-29`(중첩 handoff schema closed 검증 — **M5c 구조화 필드**) · `C-30`(중복 종료 방어가
  codex 경로로 도달 불가 — **M5c 두 번째 provider 배선**) · `C-31`(테스트가 provider 내부 2곳 white-box
  관측 — **`B-13` 구현 시**). 세 항목 모두 대장 전 필드(심각도·확률·영향 반경·유예 비용·수정 공수·기한·
  담당·증거·상태)를 채웠다. `C-12`의 **낡은 C 행은 superseded**로 표기해 독립적으로 열려 있지 않게 했다.
- **확정 기한(다시 명시)**: `B-7` 첫 live 전 · `B-9` 첫 live 전 · `B-10` M5c Claude/edit provider 전 ·
  `B-11` M5c autopilot/무인 advance 전 · `B-12` 자동 재시작/resume 전(늦어도 M5c) ·
  `B-13` live 프로세스를 띄우는 provider 배선 전 · `C-12`(→B) M5c autopilot 전.
- **검증(이 세션이 실제로 돌린 명령 — 자기보고, 독립 재실행 아님)**: 파일 단독 `stableController`
  **42/42**(36 → 42) · `reviewer` **19/19**(14 → 19) · `suiteExclusiveLock` **75/75**.
  `npm run test:exec` **306/306**(295 → 306). 권위·타이밍 경계를 건드렸으므로 **권위/타이밍 부분집합
  206건(controller·codex·boundary·kernel·reviewer)을 직렬 3회 → 3회 모두 206/206**.
  `npx tsc --noEmit` 0 · `npm run build` PASS(dist parity) · `git diff --check` clean · `node_modules` stage 0.
- **mutation 16종 전부 kill · 전부 원문 그대로 원복**(runner가 매 케이스 `restored=true`를 확인했고
  종료 후 임시 파일 0). **1회차에 A2 prototype 검사 제거가 살아남았다** — 회귀가 *override하는* subclass만
  봤기 때문이다. **override 없는 subclass** 케이스를 추가해 kill했고 이 이력을 지우지 않는다.
- **아직 아닌 것**: **독립 재리뷰·승인** — supervisor의 다음 fresh Codex `gpt-5.6-sol` xhigh read-only
  리뷰가 게이트이고 **위 fixed 판정 전부가 재확인 대상**이다. 이 세션은 스스로를 승인하지 않는다.
  **`npm test` 전체 미실행**(최종 M5d handoff 직렬 1회 예약) · `test:core` · `acceptance.sh` 전체 ·
  stress · live · MCP · 실제 추론 미실행. **M5 전체는 미완료다.**

## 2026-07-27 (V3 **M5b 1차 리비전 — 독립 Codex 리뷰 REVISE: 봉인되지 않은 authority · 집행 아닌 정책 · 소진된 예산으로 다음 task 시작 · 낡은 포인터 · 중복 종료/섹션(`B-8` reopen)** · **독립 재리뷰 대기 · M5 미완료**)

같은 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
시작 HEAD `42777d9`(승인 base = M5a `409dee2`). **새 fresh Claude Opus 5 세션**(작성 세션 컨텍스트 미상속).
amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 · 의존성/lockfile 변경 · MCP ·
**live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production · live billing **없음**.
`node_modules`(supervisor symlink)는 **stage하지 않았다**. Ponytail(full) —
`/Users/jihun/.claude/plugins/cache/ponytail/ponytail/4.8.4/skills/ponytail/SKILL.md`.

- **리비전 커밋 `6bc390d`** — `fix(v3-m5b): seal construction authority, read-only bridge, per-call
  budget/pointer gates, single terminal`. **A/P1 5건 전부 fixed.**
- **A1 — 생성 authority 봉인.** 이전 판은 caller-owned `opts`를 **실행 입력으로 계속 재읽기**했다 →
  같은 `id`의 다른 provider, 같은 state의 다른 kernel, 다른 handoff로 교체해도 통과했고 **테스트가
  `provider.start`를 monkey-patch해 그것이 실행되기를 기대**하고 있었다. 이제 kernel·provider·handoff의
  **객체와 호출 메서드 함수까지** 생성자에서 포착하고 `this.opts`는 **tripwire 전용**이다
  (`Pin` 목록 → 단일 marker `controller_binding_drift`). manifest는 **깊게 복사·깊게 freeze**해 봉인하고
  밖에는 방어적 불변 사본만 넘긴다. handoff 산출물은 **await 하나도 지나기 전에** closed 검증 → 깊은 복사 →
  freeze. provider cwd는 **경계가 돌려준 `targetRoot`로 만든 새 불변 spec**뿐이다. `SessionHandle` 참조
  동일성은 그대로 보존한다.
- **A2 — 계약을 증명 가능한 것으로 좁혔다.** `ExecutionRequest`는 **자기 선언**이었고 컴파일 결과는 버려졌고
  provider 실제 권한과 독립이었다 → 빈 request로도 edit 가능한 provider가 명령·쓰기·네트워크를 할 수 있었다.
  이제 provider는 `READ_ONLY_EXECUTION_CONTRACT` **brand**를 가진 구현만(문자열 `id` 위조 불가 · production
  발급자는 `CodexCliProvider` 하나), spec은 `permissionMode: "plan"` 전용(**ClaudeCliProvider 기본
  `acceptEdits` 차단**), 실행을 요구하는 선언은 전부 `policy_not_read_only`다. **wrapper token 화면을 집행이라고
  주장하지 않는다.** artifact 소유권은 **kernel `registerArtifact`(권위)** 가 집행한다(`artifact_not_owned`).
  타입 있는 실행 집행 = 신규 대장 **`B-10`(M5c)**.
- **A3 — 예산 게이트를 provider 호출마다.** 이전엔 batch 진입에 **한 번만** 있어서 task A가 소진한 뒤에도
  task B가 떴다. 이제 start·send **직전마다** 봉인·만료·경과·토큰을 다시 보고, 소진을 확인하면 남은 batch
  task는 **provider 호출 0**으로 닫는다(두 task 회귀가 B의 start 수 0을 고정).
- **A4 — 포인터를 경계 await 뒤에 재검증.** 불변 스냅샷으로 굳히고 **await 없는 단일 동기 게이트**
  (`syncGate`) 안에서 다시 검증한다 — 그 다음 문장이 provider 호출이다. start 창·send 창 각각에 **결정론적
  변조 seam 테스트**(시각 권위를 seam으로 써서 production에 seam을 넣지 않는다).
- **A5 — 종료·섹션 중복.** 공용 `consumeExactlyOneTerminal`(`types.ts`)이 종료 결과를 **정확히 1건**만 받고
  두 번째 종료·**종료 뒤 모든 이벤트**를 거부한다. reviewer는 **활성 로드맵 §5.2 `review_result`** 스키마를
  **코드 펜스 밖에서** 파싱해 필수 heading 6개 각각 1회 · verdict 1개 · 미상/중복/모순 거부 · 대상
  revision·hash를 **호출자 기대값**에 묶는다. `buildReviewPrompt`와 모든 caller/mock 갱신. **`B-8`을
  새 증거로 다시 닫았다.**
- **C(문서·durable) 정정**: `resultBody`가 durable body에 토큰 usage를 적고 있었다(문서는 return-only라고
  적었다) → **durable usage 제거 + 부재 회귀**. 이전 세션의 "봉인/hard-deny 집행/전이 0/usage" 서술과
  증거 라벨을 정정했다.
- **신규·재분류 유예**: `B-10`(타입 있는 실행 집행 — M5c Claude 쓰기 전) · `B-11`(batch 전체 running vs
  per-task preflight — M5c autopilot 전) · `B-12`(재시작 시 예산 회계 초기화 — 늦어도 M5c) ·
  `B-13`(durable 완료가 provider 정리 확인보다 먼저 · `stop` 실패 삼킴 — M5c live runner 전) ·
  **`C-12` → B(P1) 재분류**(트리거 발화 — 실패한 전달이 running task에 unack로 남고 ready-only advance가
  재시도하지 않는다). `C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26`은 **손대지 않았고 fixed로 주장하지 않는다.**
- **검증(이 세션이 실제로 돌린 명령 — 자기보고)**: 파일 단독 `stableController` **36/36**(19 → 36) ·
  `reviewer` **14/14** · `orchestrationKernel` **70/70**(68 → 70) · `codexCliProvider` **58/58** ·
  `executionBoundary` **17/17** · `sessionRunner` **7/7**. `npm run test:exec` **295/295**(268 → 295).
  스트림·비동기 순서를 건드렸으므로 **중복 종료 + 포인터/예산 race subset 14건 직렬 반복 3회 → 3회 모두
  14/14**. `registerArtifact` 불변식을 건드렸으므로 kernel 계열 acceptance 개별 재실행:
  `m4a` **31/31** · `m4b` **42/42** · `m4c` **77/77**(전체 `acceptance.sh`는 미실행).
  `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity** — 커밋 후 재빌드 시 변화 0) ·
  `git diff --check` clean · `node_modules` stage 0.
- **mutation 6종 전부 죽었고 전부 `git checkout --`로 정확히 원복**(`MUTATION` grep 0 · `numstat` 0줄):
  포착 메서드 재읽기 → 1건 / 깊은 복사·freeze 제거 → 4건 / 경계 뒤 포인터 재검증 제거 → 2건 /
  per-task 예산 게이트 제거 → 2건 / 중복 종료 거부 제거 → 5건 / 중복 리뷰 섹션 거부 제거 → 1건.
  **살아남는 1건(정직)**: durable 직전 중복 포인터 재검증 단독 제거는 실패 테스트가 없다(사이에 await 없음).
- **아직 아닌 것**: **독립 재리뷰·승인** — supervisor의 다음 fresh Codex `gpt-5.6-sol` xhigh read-only
  리뷰가 게이트이고 **위 fixed 판정 전부가 재확인 대상**이다. **`npm test` 전체 미실행**(최종 M5 handoff
  직렬 1회 예약) · `test:core` · `acceptance.sh` 전체 · stress · live · MCP · 실제 추론 미실행.
  **M5 전체는 미완료다.**

## 2026-07-27 (V3 **M5b — stable controller bridge (offline 구현)** · **위 1차 리비전이 이 항목의 봉인·정책·usage·증거 서술을 정정했다**)

> **정정 안내:** 아래 기록은 `1a94261`+`42777d9` 시점의 dated 기록이다. 독립 Codex 리뷰가
> ⓐ "봉인" ⓑ "deny-by-default 정책이 hard deny를 집행한다" ⓒ "usage는 반환값" ⓓ `B-8` fixed 판정 ⓔ 증거 라벨을
> 반박했다. 현행 사실은 **위 1차 리비전 항목**이다.

격리 worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`,
base = **승인된 M5a HEAD `409dee2`**(다섯 번째 fresh 독립 Codex 리뷰 = **`APPROVE_TO_STACK`, A finding 0**).
**새 fresh Claude Opus 5 세션.** amend/rebase/reset · 원격 push/PR/merge · 네트워크 · `gh` · 패키지 설치 ·
의존성/lockfile 변경 · MCP · **live Codex/Claude provider 추론** · secret 사용 · deploy · DB · production ·
live billing **없음**. `node_modules`(supervisor symlink)는 **stage하지 않았다**. Pony Tail(full).

- **커밋 2개**: `1a94261`(feat — controller + `B-8`/`C-16`/`C-21`/`C-25`/`C-27`) ·
  `42777d9`(docs — durable 직전 포인터 재검증을 **중복 방어**로 명시).
- **`src/exec/stableController.ts`(신규) — kernel 위의 얇은 다리다.** `OrchestrationKernel`이 여전히
  **유일한 scheduler이자 상태 전이 권위(SoR)** 이고, controller가 하는 일은 좁은 kernel API 호출뿐이다:
  `scheduleReady` → `startScheduledBatch` → `registerArtifact` → `submitResult`/`acknowledgeDelivery`.
  **두 번째 scheduler·DAG·큐·상태 파일을 만들지 않았고 `runParallelMission`을 부르거나 감싸거나 복제하지
  않았다.**
- **봉인·경계**: manifest를 **kernel(SoR)에서** 읽어 `validateApprovalManifest`로 다시 닫고 정규 사본 +
  canonical digest를 봉인한다(호출자 가변 manifest를 새 baseline으로 재읽기 0). controller checkout ·
  git 실행 파일 경로 · provider 신원 · 시각 권위도 봉인하고 매 advance 필드 대조 →
  단일 marker **`controller_binding_drift`** 로 fail closed. 모든 provider start·send 직전에 M5a
  `verifyExecutionBoundary` → `revalidateSync()`(대장 `B-5` 재사용, 새 permissive 경로 0),
  cwd는 경계가 확인한 `targetRoot`만.
- **중앙 deny-by-default 정책**(`compileExecutionPolicy`): 정확한 명령 allowlist · 정확히 pin된
  dependency · 정확한 도메인 · task 소유권/writableRoots · 로컬 merge · 세션/토큰/경과 예산 +
  **레포 hard deny**(production deploy · live billing · 원격 저장소 직접 쓰기 · PR merge · MCP `@latest`).
  **manifest 항목이 hard deny를 덮지 못한다.** 게이트는 **provider start·send 이전, ack 이전**에 돈다.
- **durable inbox는 순서대로 소비하고, ack는 그 turn이 성공 종료 결과를 낸 뒤에만** 한다(`send` 성공만으로
  ack 0). provider가 준 `SessionHandle`은 **그 객체 그대로** 들고 다닌다(재구성 금지 — M5a 5차 계약).
  artifact 포인터는 provider handoff 직전·durable 직전에 재검증하고, **turn마다 `events(handle)`를 다시
  부른다**(`C-25`). durable state에는 프롬프트·transcript·stderr·argv·secret·`SessionHandle`이 **하나도**
  들어가지 않고, usage는 **state schema가 아니라 반환값**이다.
- **대장 5건 닫음**: `B-8`(reviewer fail-open → 안정 `ReviewGateError` 코드 + 명시 Risks/Critical 헤더 +
  명시 `pass|revise|block` verdict 일관성으로 **판정을 만들지 않고 던진다**) · `C-16`(taskId↔roleId 교차
  모호성 → `ambiguous_recipient`) · `C-21`(프로토콜 실패 turn 뒤 resume → `codex_protocol_failed`로 세션
  poison, 후속 `send`는 spawn 0) · `C-25` · `C-27`(취소 promise 즉시 정착 + 항상 handler → unhandled
  rejection 0). 넷 다 기한이 "M5b 배선 전"이었고 **배선과 같은 세션**에서 닫았다.
- **검증(실행한 명령과 카운트)**: 파일 단독 `npx tsx --test` → `stableController.test.ts` **19/19** ·
  `orchestrationKernel.test.ts` **68/68** · `codexCliProvider.test.ts` **58/58**.
  동시성·타이밍 계약을 건드렸으므로 **provider race subset 8/8을 직렬 반복 3회** → 3회 모두 8/8.
  수정 반영 후 `npm run test:exec` **268/268**(240 → 268). `npx tsc --noEmit` 0 ·
  `npm run build` PASS(**dist parity**) · `git diff --check` clean · `node_modules` stage 0.
- **mutation — 죽은 변형**: `B-8` fail-open 복원 · start 직전 정책 검사 제거 · 전달 직전 정책 검사 제거 ·
  조기 ack · provider 이전 artifact 검증 제거 · 예전 events iterable 재사용 · `C-27` unhandled rejection ·
  `C-21` poison 제거 · `C-16` 교차 충돌 제거.
  **살아남은 변형 1건(정직한 기록)**: durable **직전**의 중복 포인터 재검증만 제거하면 실패하는 테스트가
  **없다** — `registerArtifact`와 바로 뒤 `submitResult`가 **사이에 await 없이** 같은 포인터를 다시
  검증하기 때문이다. 두 방어는 중복이므로 남기되 코드 주석이 **defense-in-depth · 단독 커버리지 없음**을
  적는다(`42777d9`). 커버리지를 과대 주장하지 않는다.
- **아직 아닌 것**: **독립 리뷰를 받지 않았다** — supervisor의 fresh Codex `gpt-5.6-sol` xhigh read-only
  독립 리뷰가 **다음 게이트**이고 그 전까지 M5b는 승인 상태가 아니다(위 fixed 판정도 재확인 대상).
  **`npm test` 전체는 이 세션에서도 돌리지 않았다** — 최종 M5 handoff(M5d 이후) 직렬 1회로 그대로 예약.
  미실행: `npm test` 전체 · `test:core` · acceptance · stress · live · MCP · 실제 추론.
  **live 0**이므로 `B-7`·`B-9`는 열린 live 하드 게이트로 남는다. **M5c**: `C-17`·`C-18`·`C-19`·`C-22`·
  `C-24`·`C-26` + autopilot CLI + pause/recovery. **M5d**: offline self-hosting acceptance.
  **M5 전체는 미완료다.**

## 2026-07-27 (V3 **M5a 5차 리비전 — 독립 Codex 리뷰 REVISE: 낡은 핸들 · 가변 시계로 만료 우회(`C-23` 2차 reopen) · 드리프트 marker 불일치** · **M5는 미완료, M5a handoff 미승인**)

같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
시작 HEAD `8f95877`(clean — `node_modules` supervisor symlink 제외). **새 fresh Claude Opus 5 세션**
(이전 세션 resume 아님). amend/rebase/reset·push/PR/merge·네트워크·`gh`·패키지 설치·의존성/lockfile
변경·MCP·**live Codex/Claude provider 추론**·deploy·DB·production·live billing **없음**.
`node_modules`는 **stage하지 않았다**(`git add`는 4개 경로를 명시했다). Pony Tail(full).

- **리뷰**: 독립 fresh Codex `gpt-5.6-sol` xhigh · read-only, 범위 `85ebe883..8f95877` → **REVISE**.
  4차의 내부 linearization(첫 await 전 동기 claim · await 뒤·발행 직전 소유권 재확인 · 동기 신뢰 게이트 ·
  게이트 뒤 발행 · spawn까지 no-await)은 **그대로 유효**하고 이번에도 보존했다. 이번 A는 **밖에서 들어오는
  신원과 권위**다.
- **① 낡은 핸들이 교체 세션을 조종했다(A/P1)**: `SessionHandle`에 provider 인스턴스 신원이 없고
  `send`/`events`/`stop`이 **`sessionId`만으로** 상태를 찾았다 → H1을 stop하고 같은 id로 H2를 start하면
  **이미 반환된 H1**이 H2의 이벤트를 읽고, H2에 지시를 보내고, H2를 중지·삭제할 수 있었다
  (4차의 교체 테스트는 **내부 정리**만 봤다). 고친 방식:
  - 세션 인스턴스마다 **내용 없는 frozen 신원 객체**를 만들어 `start`가 반환하는 핸들에 붙인다
    (`SessionHandle.providerBinding` — **선택 필드**라 `claude-cli`·`mock-exec`는 무영향).
  - 모든 진입점이 **참조 동일성**으로만 대조한다 — `sessionId`(교체본과 같다)나 가변 `spec` 내용은 근거가
    아니다. 낡은·위조 핸들의 `send`/`events`는 **읽기·발행·spawn·변경·삭제 0**으로 `codex_stale_handle`,
    `stop`은 **무해·멱등**(signal·close·상태 변경·삭제 0). 세션 자체가 없으면 기존대로 `codex_unknown_session`.
  - 신원은 **비밀 material이 아니다**: 빈 객체 참조이므로 로그·직렬화·문서에 남길 값이 없고, 반대로
    그 참조를 이미 가진 쪽만 그 세션을 조종한다.
- **② 가변 `opts.nowMs`로 만료를 우회할 수 있었다(A/P1 · `C-23` 2차 reopen)**: 4차 봉인에 `nowMs`가 없어
  매 invocation `this.opts.nowMs`를 다시 읽었다 → 첫 turn 뒤 호출자가 **만료 전을 말하는 시계**로 갈아끼우면
  경계 진입·spawn 직전 **두 만료 검사가 모두 통과**해 **실제로는 만료된 승인 아래 resume이 떴다**
  (mutation으로 재현했다 — 아래). 같은 재읽기 패턴이 `this.opts.manifest`에도 있었다. 이제:
  - **시각 권위(clock)와 검증된 manifest 사본을 봉인**하고 경계에는 **봉인값만** 넘긴다
    (`nowMs: s.clock` · `manifest: s.manifest`). 봉인 clock은 만료 검사마다 **다시 호출**한다 —
    시각을 얼리지 않으므로 시간은 자연스럽게 흐른다.
  - `SEALED_KEYS`에 `clock`·`manifestDigest`를 더했다 → `opts.nowMs`의 **교체·제거·추가**와 manifest
    **전 필드**(canonical digest) 변경이 `codex_spec_mutated`다. 함수 아닌 `nowMs`는 start에서
    `codex_config_invalid`(초기 native 코드 유지).
  - **caller-owned 옵션 전수 감사**: `manifest`·`nowMs` → 봉인 전환 / `executablePath`·`gitExecutablePath`·
    `controllerRepoRoot`·`spec` → 이미 봉인값 사용 / `spawn` → **생성자에서 포착**이라 재읽기 자체가 없다
    (나중 교체가 무의미함을 테스트로 고정). **invocation 중 `this.opts`에서 읽는 실행 입력은 0**이다.
- **③ 드리프트 marker 문서·구현 불일치(A)**: 코드·문서는 "post-start 드리프트는 전부 `codex_spec_mutated`"
  라고 했는데 `assertNoSpecDrift`가 `sealCodexSpec`을 먼저 불러 **native 오류를 그대로 던졌고**, sandbox
  드리프트 테스트가 `codex_sandbox_forbidden`을 기대해 **증거가 문서를 반박**했다. 이제 드리프트 비교 중의
  검증 실패를 **단일 marker로 접고**(원인 코드·경로·값 미노출), **초기 `start`의 정밀 native 코드는 유지**한다
  (`codex_sandbox_forbidden` 테스트 존치). sandbox 드리프트 2곳을 정정하고 "무효화" 케이스를 추가했다.
- **테스트(신규 3, 기존 완화·삭제 0)**: ⓐ "낡은 핸들은 교체 세션을 읽지도·조종하지도·중지하지도 못한다"
  (H1 stop → 같은 id로 H2 → H1의 `events`/`send`/위조 핸들 전부 `codex_stale_handle` · **spawn 총계 불변** ·
  H1 `stop` 2회 무해 · **H2 스트림 결과 1건이 비-error**(signal 유입 0) · **H2 후속 send가 정상 spawn·resume
  argv 유지** · H2 자신의 stop은 정상) ⓑ "시각 권위는 봉인된다"(교체 → `codex_spec_mutated`+spawn 0+시계
  미호출 · 되돌림 → **같은 시계가** `manifest_expired` · 시간이 되돌아오면 정상 turn(얼리지 않음) ·
  제거 → `codex_spec_mutated`) ⓒ "함수 아닌 nowMs 거부 + spawn seam 교체 무의미".
  기존 2건은 **핸들 계약에 맞게 정정**했다(진행 중 start 테스트는 `codex_session_exists`로 동기 claim을
  증명하고 위조 핸들 3종을 추가 · 교체 세션 테스트는 **발급된 핸들**로 취소·교체를 수행 — 커버리지는 늘었다).
  turn 사이 드리프트 표는 **9 → 17케이스**(manifest 5 · 무효화 2 · `nowMs` 추가 1 추가).
- **검증(실행한 명령과 카운트)**: 파일 단독 `npx tsx --test` → `executionBoundary.test.ts` **17/17** ·
  `codexStreamParser.test.ts` **28/28** · `codexCliProvider.test.ts` **53/53**(합 **98/98**, 이전 95) ·
  `npm run test:exec` **240/240**(237 → 240) · `npx tsc --noEmit` 0 ·
  `npm run build` PASS(**dist parity**: 재빌드 후 `git diff --numstat` 변화 0) · `git diff --check` clean.
  **세션 신원·만료 타이밍을 건드렸으므로 stale-handle + clock/drift 회귀 7건을 반복 3회** → 3회 모두 7/7.
  **mutation 4종**: 핸들 신원 대조 제거(**2건 실패**) · 봉인 clock 대조 제거(**2건**) · 봉인 clock 대조 제거
  **+** `this.opts.nowMs` 재읽기 = 수정 전 상태(**2건**, 그중 시각 권위 테스트는 `codex_spec_mutated` 대신
  **`(통과)`** — **만료된 승인 아래 resume이 실제로 떴다**) · 드리프트 중 native 오류 허용(**2건**) →
  전부 정확히 원복, `MUTATION` grep 0(소스·dist), `git diff --numstat` 기준선 일치, `tsc --noEmit` 0,
  focused 53/53 재확인.
  **정직한 한계**: **재읽기만** 되돌리고 봉인 대조를 남기면 **어떤 테스트도 실패하지 않는다** — 동기 진입의
  드리프트 검사와 경계 호출 인자 평가 **사이에 await가 없어** 호출자가 끼어들 수 없기 때문이다. 두 방어는
  **중복**이며 봉인 clock은 앞으로 그 사이에 await가 하나 생겨도 깨지지 않게 하는 쪽이다. 과대 주장하지 않는다.
- **대장**: `C-23` **fixed(5차)** — 행에 **2차 reopen 사유(`nowMs`·manifest 재읽기)까지 이력으로 남겼다**
  (3차 overclaim → 4차 부분 fix → 5차 완결). `C-28`은 이번에 **실제 구현+테스트까지 마쳐 fixed**
  (manifest canonical digest 봉인). **`C-27`·`C-26`은 계약을 구현하지 않았으므로 그대로 open**이고
  기한·트리거·증거 필드를 유지했다. `B-7`·`B-8`·`B-9`·`C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`도
  전부 open이다.
- **전체 suite는 이 세션에서 돌리지 않았다(supervisor 지시)**: **supervisor가 M5b~M5d 이후 최종 M5
  handoff에서 `npm test` 직렬 1회**를 돌린다. 미실행: `npm test` 전체 · `test:core` · acceptance · stress ·
  live · MCP · 실제 Codex/Claude 추론 · M5b controller · M5c lifecycle · M5d E2E.
  **M5a는 supervisor의 다음 fresh 독립 리뷰 전까지 승인 상태가 아니다. M5도 미완료.**

## 2026-07-27 (V3 **M5a 4차 리비전 — 독립 Codex 리뷰 REVISE: pre-spawn race · `C-23` reopen · 발행 순서** · **M5는 미완료, M5a handoff 미승인**)

같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
시작 HEAD `3493a2e`(clean). **새 fresh Claude Opus 5 세션**(이전 세션 resume 아님).
amend/rebase/reset·push/PR/merge·네트워크·`gh`·패키지 설치·의존성/lockfile 변경·MCP·
**live Codex/Claude provider 추론**·deploy·DB·production·live billing **없음**.
`node_modules`(supervisor symlink)는 **stage하지 않았다**. Pony Tail(full).

- **리뷰**: 독립 fresh Codex `gpt-5.6-sol` xhigh · read-only, 범위 `85ebe883..3493a2e` → **REVISE**.
  3차의 A 3건(spawn-adjacent 게이트 · 신뢰된 git · resume UUID 봉인)은 **fixed로 확인**됐고 계약·테스트를
  그대로 보존했다. 이번 A는 **상태 기계**다 — 게이트는 제자리였지만 **누가 그 게이트를 지날 자격이 있는지**를
  아무도 원자적으로 정하지 않았다.
- **① pre-spawn session-state race(A/P1)**: `send()`가 상태를 본 뒤 `invoke()`가 **await된
  `verifyExecutionBoundary` 뒤에야** 세션을 점유했다 → 겹친 두 `send`가 둘 다 통과해 같은 UUID·`CODEX_HOME`으로
  **중복 resume 프로세스**를 띄우고 큐·child를 서로 덮어쓸 수 있었고, 같은 창에서 `stop()`이 세션을 지워도
  뒤늦게 `running`을 발행하며 **추적되지 않는 프로세스**가 뜰 수 있었다. 고친 방식:
  - **`starting` 상태 + provider 전역 단조 증가 generation 토큰**을 **첫 await 전에 동기로** claim한다.
    프롬프트 계약 위반은 claim 전에 거부해 세션 상태를 건드리지 않는다.
  - 겹친 start/send는 spawn·발행 없이 **`codex_send_overlap`으로 즉시(동기/rejected promise) 거부**된다 —
    소유자의 큐·child·events를 교체하지 않는다.
  - **모든 await 뒤 + spawn 직전 동기 게이트**에서 세션 존재 · **같은 state 객체** · 같은 generation ·
    미취소 · 미중지를 다시 확인하고 어긋나면 **`codex_invocation_cancelled`** 로 fail closed.
  - **`stop()`은 child가 없어도** claim을 취소하고, 같은 id로 만들어진 **교체 세션은 지우지 않는다**.
    낡은 `start`의 catch와 `settle`도 **소유권 확인 후에만** 상태를 만진다.
  - 신뢰 검사 → `spawn` 사이 **no-await 동기 게이트**는 그대로. stop 멱등 · poison · 만료 · 큐 격리 무변경.
- **② `C-23` reopen 후 해소(A/P1)**: provider가 호출자 소유 `state.spec`을 들고 **매 turn
  `resolveCodexOptions`를 다시 해석**해, 1차 turn 완료 후 `send` 전의 변조가 **새 baseline**이 됐다.
  3차가 이를 fixed로 적은 것은 **overclaim**이었고 대장 행에 reopen 사유를 명시했다. 이제 `start()`가
  유효 옵션 **전부를 봉인**(`Object.freeze`)한다: `sessionId`·`model`·`reasoningEffort`·`sandbox`·
  `codexHome`·`outputSchemaPath`·`ephemeral`·`cwd`·codex/git 실행 파일 경로·`controllerRepoRoot`·
  manifest `milestoneId`/`approvedCommit`/`expiresAt`/`maxSessions`/`maxTokens`/`maxElapsedMs`.
  **모든 invocation 동기 진입 + spawn 직전 게이트**에서 `SEALED_KEYS` **명시 필드 목록**으로 대조하고
  (JSON 키 순서 의존 없음) 드리프트는 **단일 marker `codex_spec_mutated`** 다(필드 이름만, 경로·내용 없음).
  argv·env·경계 입력은 **전부 봉인값에서만** 만든다.
- **③ 발행 순서 정합(A/문서·구현 불일치)**: `invoke` 주석은 "검증 실패 시 기존 큐·상태는 그대로"라고 했지만
  구현은 **동기 게이트 전에** 새 큐와 `running`을 발행해 실패가 **이전 완료 큐를 교체**하고 가짜 종료 결과를
  하나 더 냈다. 발행을 **게이트 뒤로** 옮겼다 — 발행 전 실패는 큐·`child`·세션 신원을 하나도 건드리지 않고
  (거부는 rejected promise로만), 발행 이후 실패(동기 spawn 예외)만 그 invocation의 **bounded 스트림**을
  종료 결과 1건으로 닫는다.
- **테스트(신규 5, 기존 완화·삭제 0)**: 겹친 send(소유자만 spawn · 패자 프롬프트로 spawn 0 · 큐 교차 0) ·
  stop이 child 없는 claim 취소(release 후에도 spawn 0 · 세션 부활 0 · unhandled rejection 0 · stop 멱등) ·
  start 진행 중 send 거부 · stop 뒤 교체 세션(낡은 정리가 교체본을 지우거나 바꾸지 못한다) ·
  **turn 사이 드리프트 9케이스**(model·outputSchema·cwd·codexHome·ephemeral·sessionId·codexBinaryPath·
  gitExecutablePath + sandbox는 재해석에서 `codex_sandbox_forbidden`) — 각 케이스 spawn 1차 그대로 ·
  이전 완료 큐 교체 0 · 되돌리면 정상 turn 1건(claim 누수 0).
  **창을 여는 방법**: provider에 테스트 hook을 **더하지 않고**, 실행 경계의 **비동기 git 조회를
  결정론적으로 정지**시키는 신뢰된 git 래퍼 fixture(`arm`/`release` 파일)를 테스트가 만든다. 타이밍 추측 0.
- **검증(실행한 명령과 카운트)**: 파일 단독 `npx tsx --test` → `executionBoundary.test.ts` **17/17** ·
  `codexStreamParser.test.ts` **28/28** · `codexCliProvider.test.ts` **50/50**(합 **95/95**, 이전 90) ·
  `npm run test:exec` **237/237**(232 → 237) · `npx tsc --noEmit` 0 ·
  `npm run build` PASS(**dist parity**: 재빌드 후 `git status` 변화 0) · `git diff --check` clean.
  **동시성 계약을 건드렸으므로 신규 race/spec 5건을 반복 3회** → 3회 모두 5/5.
  **mutation 5종**: `claim`의 `starting` 전이 제거(**2건 실패**) · `owns()`의 세션 존재·미취소·미중지 검사
  제거(**2건**) · 봉인값 대신 매 turn 재해석(**1건** — between-turn만 실패하고 기존 same-invocation 테스트는
  **통과**해 reopen 사유를 정확히 재현) · 필드 비교 무력화(**2건**) · `start` catch의 소유권 확인 없는
  삭제(**1건**) → 전부 정확히 원복, `MUTATION` grep 0(소스·dist), `tsc --noEmit` 0, focused 95/95 재확인.
  **정직한 한계**: `stop()`의 `cancelled` **단독 제거는 어떤 테스트도 실패시키지 않는다**(stop이 세션을 지우고
  `status`를 올리므로 `owns()`의 다른 두 검사가 같은 경로를 잡는다) — 세 신호는 서로 **중복된 방어**이고
  셋을 함께 제거하면 2건이 실패한다. `settle`의 소유권 가드도 같은 이유로 단독 커버리지가 없다.
- **인접 상태 기계 감사**: 새 A는 없었다. 신규 C 2건을 대장에 등록 — **`C-27`**(`stop()`이 `starting`에서
  반환한 뒤에도 취소된 invocation promise가 나중에 reject된다 → 기한 **M5b 배선 전**, `C-25`와 같은 게이트) ·
  **`C-28`**(봉인 밖 manifest 권한 필드는 turn 사이 고정 없음. 현재 provider가 그 필드로 아무 판정도 하지
  않는다 → 기한 **권한 집행 계층 도입 시 = `workspace-write` 재승인 또는 M5c 권한 컴파일러**).
  **`B-7`·`B-8`·`B-9` 및 `C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`·`C-26`은 전부 그대로 open**이다.
- **전체 suite는 이 세션에서 돌리지 않았다(supervisor 지시)**: M5a는 **내부 stacked M5 slice**이고
  **supervisor가 M5b~M5d 이후 최종 M5 handoff에서 `npm test` 직렬 1회**를 돌린다. 그래서 **M5a는
  supervisor의 다음 fresh 독립 리뷰 전까지 승인 상태가 아니다.** 미실행: `npm test` 전체 · `test:core` ·
  acceptance · stress · live · MCP · 실제 Codex/Claude 추론 · M5b controller · M5c lifecycle · M5d E2E.

## 2026-07-27 (V3 **M5a 3차 리비전 — 독립 Codex 리뷰 REVISE의 A 3건 + 문서·타입 정정** · **M5는 미완료, M5a handoff 미승인**)

같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
시작 HEAD `2627f8f`(clean). 작성 세션을 playbook §6에 따라 **A 처리에만 한 번 resume**했다.
amend/rebase/reset·push/PR/merge·네트워크·`gh`·패키지 설치·의존성/lockfile 변경·MCP·
**live Codex/Claude provider 추론**·deploy·DB·production·live billing **없음**.
`node_modules`(supervisor symlink)는 **stage하지 않았다**. Pony Tail(full).

- **리뷰**: 독립 fresh Codex `gpt-5.6-sol` xhigh · read-only, 범위 `85ebe883..2627f8f` → **REVISE**
  (A 3 = P0 1 + P1 2, 문서·타입 정정 1, "전체 suite 미실행" 지적 1).
- **① spawn-adjacent TOCTOU(A/P0)**: 홈·codex 실행 파일 검증이 `await verifyExecutionBoundary` **앞에만**
  있었고 그 뒤에는 경계 재검증만 돌았다 → 비동기 창에서 **교체·symlink화·권한 완화·inode 교체**가 spawn까지
  갈 수 있었다. 이제 **await 없는 단일 순서 동기 pre-spawn 게이트**다: ① `spec` 스냅샷(해석값+`cwd`)
  ② 승인 만료·git 신원·checkout 신원·HEAD ③ `CODEX_HOME`(정규·비symlink·0700·사용자 홈 아님 + **고정 신원**,
  첫 invocation은 **여전히 비어 있음**) ④ codex 실행 파일(신뢰 조건 + **고정 신원 dev+ino**) → **바로 spawn**.
  실행 파일을 신원으로 묶었으니 **같은 0755 다른 실행 파일 교체도 거부**된다. 창은 syscall 몇 개 규모로
  줄인 것이고 `fexecve`가 없는 Node에서 **0이라 주장하지 않는다**.
- **② ambient git 증명 우회(A/P1)**: 경계가 `git`을 이름으로 부르고 `runProcess`가 `process.env`를 상속해
  적대적 `PATH`·`GIT_DIR`·`GIT_WORK_TREE`가 다른 저장소/커밋을 증명할 수 있었다. 이제 `gitExecutablePath`가
  **필수**(정규·비symlink·일반 파일·실행 비트·타인 쓰기 금지·**신원 고정 후 spawn 직전 재확인**)이고,
  async·sync 조회 모두 그 경로로만 부르며 자식 env는 `GIT_SANITIZED_ENV` 화이트리스트다
  (PATH·HOME·상속 `GIT_*`·자격증명 0, system/global config는 **사용자 상태를 읽지 않고** off).
  **`runProcess`의 다른 호출자는 건드리지 않았다**(경계 범위로 한정).
- **③ resume 신원 누출(A/P1)**: 파서가 기대 UUID를 몰라 conflicting `init`이 먼저 방출되고, **한 chunk가
  통째로 파싱**되므로 다른 thread의 본문·도구 payload까지 나갈 수 있었다. 이제 `expectedSessionId`로
  **init 생성 전에** 봉인한다 — 같은 chunk 뒷줄까지 방출 0, bounded marker와 결과 1건만 나가고 둘 다
  **기대 UUID**를 싣는다(다른 id·usage·본문 0). 세션은 닫혀 후속 `send`가 **spawn 0**이다.
- **④ 문서·타입 정정**: "실행 파일/홈을 spawn 직전에 확인한다"는 서술을 **순서 있는 동기 게이트**로 바꾸고,
  `types.ts` `codexHome` 주석을 "**첫 invocation 비어 있음 + 이후 같은 소유 홈**"으로 정정했다.
  `B-7`·`B-8`·`B-9`와 `C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`는 **그대로 유지**했다.
- **`C-23` 확장 후 해소**: 리뷰가 넓힌 범위(가변 `spec` aliasing이 **한 invocation의 비동기 창 안에서도**
  문제)를 반영하고 **지금 값싸게 닫았다** — 게이트가 해석값+`cwd` 스냅샷을 대조해 `codex_spec_mutated`로
  거부하고 **argv는 대조 통과 후에 컴파일**한다. 대장에 확장 사유·증거와 함께 **fixed**로 기록.
- **검증(실행한 명령과 카운트)**: 파일 단독 `npx tsx --test --test-timeout=180000` →
  `executionBoundary.test.ts` **17/17** · `codexStreamParser.test.ts` **28/28** ·
  `codexCliProvider.test.ts` **45/45**(합 **90/90**, 이전 79) · `npm run test:exec` **232/232**(221 → 232) ·
  `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity**: 재빌드 후 diff 변화 0) · `git diff --check` clean.
  **mutation 6종**: 게이트 홈 재검증 제거(**2건 실패**) · 실행 파일 신원 pin 제거(**1건**) ·
  git 경로·env async 되돌림(**1건**) · git 경로·env sync 되돌림(**1건**) · 파서 봉인 무효화(**2건**) ·
  spec 스냅샷 비교 제거(**1건**) → 전부 정확히 원복, `MUTATION` grep 0, `git diff --numstat` 기준선 일치,
  focused 90/90 재확인.
- **인접 감사**: 경계 **밖의** `runProcess` git 호출자(worktree 유틸 등)는 아직 이름 호출 + env 상속이다.
  리뷰 지시대로 범위를 경계로 한정했고 이들은 **승인 커밋을 증명하지 않으므로** A가 아니다 →
  대장 `C-26`으로 등록(기한: controller가 worktree 조작을 자동화 경로로 쓰기 전, M5c). 그 밖의 새 A는 없었다.
- **전체 suite는 이 세션에서 돌리지 않았다(리뷰 지적 반영·정직한 상태)**: M5a는 **내부 stacked M5 slice**이고
  **supervisor가 M5b~M5d 이후 최종 M5 handoff에서 `npm test` 직렬 1회**를 돌린다. 그래서 **M5a handoff는
  supervisor 리뷰 전까지 승인 상태가 아니다.** 미실행: `npm test` 전체 · `test:core` · acceptance · stress ·
  live · 반복 3회.

## 2026-07-27 (V3 **M5a 2차 리비전 — 구조적 A 4건 + 문서 정정 1건** · fresh Claude Opus 5 세션 · **M5 전체는 여전히 미완료**)

같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
시작 HEAD `450739a`(clean). **이전 세션 컨텍스트를 잇지 않는 새 fresh 세션**이고, 그 세션의
`--resume`은 이미 한 번 썼으므로 다시 열지 않았다. amend/rebase/reset 없음, 기존 커밋 위에 **로컬 커밋만**
쌓았다. push/fetch/pull/PR/merge·네트워크·`gh`·패키지 설치·의존성/lockfile 변경·MCP·**live Codex/Claude 추론**·
deploy·DB·production·live billing **없음**. `node_modules`(supervisor symlink)는 **stage하지 않았다**.
Pony Tail(full) — 경로 `/Users/jihun/.claude/plugins/cache/ponytail/...`는 SessionStart 훅으로 로드됨(level full).

- **① 비-ephemeral resume 구조 모순(A)**: 첫 codex 프로세스는 `CODEX_HOME`에 세션 상태를 **남겨야** 하는데
  이전 계약은 **모든** invocation에 "빈 홈"을 요구했다 → `ephemeral:false` + `send`는 production에서 항상
  `codex_home_not_empty`(fake CLI가 상태를 cwd에만 써서 테스트로 드러나지 않았다). 이제 **provider 소유 홈
  수명**이다: 첫 invocation은 여전히 **빈** 0700 정규 비-symlink 홈(사용자 홈 금지)을 요구하고 그때
  **신원(dev+ino)** 을 고정한다. resume은 **같은 신원일 때만** codex가 남긴 상태를 허용하며 경로 계약·권한·
  홈 금지·strict 플래그(`--strict-config`/`--ignore-user-config`/`--ignore-rules`/`mcp_servers={}`)·
  단일 `CODEX_HOME` env를 그대로 재검증한다. **교체(inode)·symlink화·권한 완화·소유하지 않은 기존 상태는
  spawn 0.** fake CLI는 실제 codex처럼 `sessions/…/rollout-<uuid>.jsonl` + `history.jsonl`(0700)을 남긴다.
  **live 인증(`B-7`)은 구현하지 않았고**, 같은 uid 공격자에 대한 내성도 **주장하지 않는다**.
- **② 승인 만료 재확인(A)**: 만료를 **비동기 git 조회 전에만** 봤다. 이제 `nowMs`가 함수면 clock으로 취급해
  `revalidateSync()`(spawn 직전 마지막 동기 검증)가 시각을 **다시 읽고** `now >= expiresAt`을 재확인한다.
  읽을 수 없는 시각도 거부(fail closed). 만료가 그 사이에 걸치면 provider **spawn 0**.
- **③ 신원 우선 파싱(A)**: `thread.started` 전에 assistant/status/unknown/error가 방출되고 나중에 성공할 수
  있었다. 이제 **의미 있는 첫 이벤트가 정규 UUID 하나를 세워야** 하고, 그 전 이벤트는 비가역
  `missing_session_id`이며 **내용·도구 payload를 전달하지 않는다**. 늦은 `thread.started`도, 그 뒤의 정상
  종료도 되돌리지 못한다.
- **④ MCP 위반 세션 격리(A)**: MCP 호출을 본 thread를 `send`로 이어갈 수 있었다(비가역 실패의 resume 우회).
  이제 세션이 닫히고(`codex_mcp_observed`) 후속 `send`는 spawn 0이다.
- **⑤ 문서 정정(C/문서)**: 로드맵·파서 주석의 "agent message 전문은 **어떤 이벤트에도** 실리지 않는다"는
  실제 동작과 어긋났다(raw 배제 목록을 이벤트 전체로 넓힌 오류). raw/추론 원문/명령 문자열/stderr·error
  payload는 여전히 제외하되, **상한 지난 최종 본문은 `assistant.text`·`result.text`로 의도적으로 전달**된다고
  정정했다. `B-7`·`B-8`·`B-9` 서술은 손대지 않았다 — 세 항목 모두 **여전히 open**이다.
- **신규 유예(C)**: `C-21`(프로토콜 실패 뒤 resume 허용 — `B-8`과 함께 M5b) · `C-22`(홈 소유 신원 in-memory →
  controller 재시작 후 resume 불가, M5c) · `C-23`(turn 사이 spec 변경으로 model/schema 경로 drift, M5b) ·
  `C-24`(stderr 버퍼 chunk 단위 상한, M5c) · `C-25`(`events()`가 invocation별 큐, M5b). 기한·담당·증거는
  로드맵 §9.1 M5a 대장에 전부 적었다. **B로 올릴 새 항목은 없다.**
- **검증(실행한 명령과 카운트)**: 파일 단독 `npx tsx --test --test-timeout=180000` →
  `executionBoundary.test.ts` **13/13** · `codexStreamParser.test.ts` **26/26** ·
  `codexCliProvider.test.ts` **40/40**(합 **79/79**, 이전 70) · `npm run test:exec` **221/221**(212 → 221) ·
  `npx tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 3회 —
  **최종 전체 suite 1회는 supervisor가 M5 handoff 시점으로 예약**한 그대로다.
  **mutation 4종**: 홈 소유 신원 비교 제거(**2건 실패**) · `revalidateSync` 만료 재확인 제거(**2건 실패**) ·
  신원 우선 게이트 무효화(**2건 실패**) · MCP 세션 격리 제거(**1건 실패**) → 네 번 모두 정확히 원복,
  `MUTATION` grep 0 · `git diff --numstat` 기준선 일치 · focused 79/79 재확인.
- **정정**: 아래 리비전 기록의 "`CODEX_HOME` … **비어 있음**"은 **그 시점 계약**이다. 현행은 위 ①(첫
  invocation만 빈 홈, 이후는 소유 신원 일치)이다.

## 2026-07-27 (V3 **M5a 리비전 — fresh Codex 리뷰 REVISE의 A 9건 수정** · playbook §6의 **단 한 번 resume** · **M5 전체는 여전히 미완료**)

같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
리비전 시작 HEAD `6ae7fd6`. **기존 두 커밋은 유지**했고 amend/rebase/reset은 하지 않았다.
push/fetch/pull/PR/merge·네트워크·`gh`·패키지 설치·의존성/lockfile 변경·MCP·**live Codex/Claude 추론**·
deploy·DB·production·live billing **없음**. Pony Tail(full).

- **리뷰**: fresh Codex `gpt-5.6-sol` xhigh · read-only · strict empty MCP, 범위 `85ebe883..6ae7fd6`,
  판정 **REVISE**. A 9건(P0 2 · P1 7) + B 2건 + C 1건. 이 리뷰는 supervisor가 돌린 **별도 read-only 세션**이며
  **새 provider/live 경로로 Codex 추론을 돌린 적은 없다**.
- **① 임의 실행 파일 seam 제거(P0)**: production의 `HARNESS_CODEX_BIN`·PATH 조회를 없앴다. 이제
  `executablePath`(신뢰된 절대·정규 경로)가 **필수**이고 spawn 직전마다 symlink 아님·일반 파일·실행 비트·
  group/other 쓰기 없음을 확인한다. 자식 env는 **`CODEX_HOME` 하나**(PATH도 상속하지 않는다).
  테스트가 provider **코드**에 `process.env`가 없음을 고정하고, env 오염 상태에서도 명시 경로로만 spawn함을 단정한다.
- **② `workspace-write` hard deny(P0)**: M5a Codex 세션은 read-only 전용이다. 요청 시 spawn 0.
  쓰기 모드는 manifest task 소유권·writableRoots를 집행하는 권한 계층이 생긴 뒤 별도 승인으로만 되살린다.
- **③ resume argv 배치(P1)**: supervisor 실측(codex-cli `0.146.0-alpha.3`, parse-only)에 맞춰 fresh와 resume
  배치를 분리했다 — `--sandbox`/`--cd`는 **`resume` 앞**, resume 뒤에는 subcommand-local 지원 플래그만.
  `--strict-config`·`--ignore-user-config`·`--ignore-rules`를 양쪽에 추가했고, 자기 자신과 비교하던
  기대 argv를 실측 근거의 **손으로 적은 기대값 + 파싱 계약 표**로 바꿨다. → 대장 `B-6` **fixed**(플래그 한정).
- **④ 세션 신원(P1)**: `thread.started`의 **정규 UUID 정확히 1개**만 인정한다. 빈 값·형식 위반(`--last` 포함)·
  중복·모순·부재·invocation 간 충돌은 전부 **비가역 프로토콜 실패**이고, 검증되지 않은 텍스트로 resume 인자를 만들지 않는다.
- **⑤ 설정 격리(P1)**: `CODEX_HOME`을 정규·비symlink·0700·**비어 있음**·사용자 홈 아님으로 검증한다.
  fake CLI 채널을 `CODEX_HOME` → **cwd**로 옮겨 그 계약을 깨지 않으면서 **env 테스트 seam을 만들지 않았다**.
  auth는 복사·영속화하지 않는다(live 인증은 `B-7`).
- **⑥ 실행 신원 TOCTOU(P1)**: 비정규·symlink 입력 경로를 **해석하지 않고 거부**하고, argv `--cd`와 native cwd에
  경계가 확인한 `targetRoot`만 쓴다. `revalidateSync()`가 spawn 직전 마지막 연산으로 디렉터리 신원(dev+ino)과
  HEAD를 **동기 재확인**한다(shell 미경유 인자 배열). Node 한계상 창은 0이 아니며 최소화 + fail closed다.
- **⑦ 파서 fail-open(P1)**: malformed·과대 줄, 중복/모순 종료, MCP 관측, 종료 뒤 신원·최종 메시지 변경 시도,
  이벤트 상한 초과가 **비가역 실패**다. **성공 뒤 실패/error/MCP는 실패**다. 기존 중복-종료 테스트는
  **삭제·완화 없이 갱신**했고, 전방 호환 unknown은 **형태가 유효한** 모르는 타입에만 남긴다.
- **⑧ 수명(P1)**: 멱등 invocation 상태 기계를 넣었다 — 검증 통과 뒤에만 큐 발행, harness 세션 id 중복 start ·
  겹친 send 거부, 실패한 start/send는 오염 큐·잔여 상태 0, 동기 spawn 예외 · error+close 경합 · stdin 오류 ·
  `stop`(결과 정착 후 정리)이 전부 결정론적으로 **종료 결과 1건**으로 수렴한다. 프로세스 그룹·TERM→유예→KILL·
  deadline·자손 0은 **M5c**(`C-18`).
- **⑨ raw 유출(P1)**: `SessionEvent.raw`를 원본 JSON에서 **bounded sanitized metadata projection**으로 바꿨다.
  명령 문자열은 tool input에서도 제거(상태·exit code·길이만). 전 kind `JSON.stringify` sentinel 테스트와
  소비자 전달 fixture를 추가했다.
- **비-A 처리**: `B-8`(reviewer가 `isError`·빈 구조화 출력을 통과시킨다 — **M5b reviewer 배선 전** 하드 게이트) ·
  `B-7` 확장(live 인증 + **stderr 폐기 또는 승인된 정확한 secret 값만 redaction에 전달**) ·
  `B-9`(JSONL payload 필드 live 확인) 신규 등록. `C-20`은 `C-17`과 중복이라 **철회**하고 `C-17` 하나만
  남기며 기한을 **M5c 전**으로 좁혔다. M5a 범위를 controller 통합으로 넓히지 않았다.
- **검증(실행한 명령과 카운트)**: `npx tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  파일 단독 `executionBoundary.test.ts` **12/12** · `codexStreamParser.test.ts` **24/24** ·
  `codexCliProvider.test.ts` **34/34**(합 **70/70**) · `npm run test:exec` 전체 **212/212**(186 → 212).
  **미실행**: `npm test` 전체 · core · acceptance · stress · live · 반복 — **최종 전체 suite 1회는 supervisor가
  M5 handoff 시점으로 예약**했다.
  **mutation 2종**: 실행 파일 신원 검증 제거(2건 실패) · 프로토콜 실패 기록 제거(16건 실패) →
  정확히 원복, `MUTATION` grep 0, focused 70/70 재확인.
- **정정**: 아래 구현 세션 기록의 "자식 env는 `PATH`/`CODEX_HOME` 둘뿐" · "`workspace-write`는 spec이 명시할
  때만" · "`B-6` open" · "열린 P0 없음"은 **리비전 전 시점의 기록**이며 현행은 이 블록이다.

## 2026-07-27 (V3 **M5a 구현 — 실행 경계(`B-5`) + CodexCliProvider + JSONL 어댑터 + offline fake 테스트** · **M5 전체는 미완료**)

격리 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider` ·
base `85ebe883ff96fad1070a508f5d4a28f7fc637b8e`(= M4 문서 정합성 커밋) 단일 세션. Pony Tail(full) 적용.
**M5a 범위만** 구현했다 — autopilot CLI·실제 7-agent 동시 실행·live acceptance·Claude↔Codex 자동 전달은
**하지 않았다**. push/fetch/pull/PR/merge/rebase/reset·네트워크·`gh`·패키지 설치·신규 의존성·
package/lockfile 변경·MCP·실제 Codex 추론·deploy·DB·production·live billing **없음**.
`runWorkflow`/`mission`/`orchestration*`/기존 테스트·schema·script는 **무수정**이다.

- **① 플레이북 정정(B/P1, 첫 패치)**: `docs/handoff/CLAUDE_CODE_WORKER_PLAYBOOK.md` §3의 Claude
  stream-json 예시에 **`--verbose`가 빠져 있었다**(그대로 실행하면 CLI가 거부한다). 플래그와 근거 주석을 넣었다.
- **② 실행 경계 — 대장 `B-5` fixed**: `src/exec/executionBoundary.ts` 신규.
  `verifyExecutionBoundary()`가 ⓐ manifest closed 재검증 ⓑ 만료(경계 포함) ⓒ 경로 계약(절대·NUL 없음·
  디렉터리) ⓓ realpath 정규화 + `--show-toplevel` 대조로 **checkout 루트 신원** ⓔ controller·실행 checkout
  **양쪽 HEAD == `approvedCommit`** 을 확인한 뒤에만 통과한다(같은 checkout이면 대조 1회).
  `CodexCliProvider`는 **spawn 직전마다** 이 함수를 부른다 — 위반 경로 전부에서 **fake spawn 횟수 0**을
  테스트가 고정한다. 기존 승인 manifest 규칙은 약화하지 않았다(같은 `validateApprovalManifest`를 통과해야 한다).
- **③ `CodexCliProvider`**: 기존 `ExecutionProvider` 인터페이스 그대로 구현. argv는 **배열 컴파일**
  (`exec --json --model … --config model_reasoning_effort="…" --config mcp_servers={} --sandbox … --cd … --ephemeral [--output-schema …] -`),
  프롬프트는 **stdin**, cwd 명시, 리뷰 기본값은 `gpt-5.6-sol`·`xhigh`·`read-only`·ephemeral.
  `workspace-write`는 spec이 명시할 때만이고 **bypass 계열 플래그·`danger-full-access`는 컴파일 단계에서 도달 불가**.
  strict empty MCP는 **격리 `CODEX_HOME`(필수 입력) + `--config mcp_servers={}` + 자식 env를 `PATH`/`CODEX_HOME`
  둘로 제한**(사용자 `HOME` 미상속 → ambient `~/.codex`·auth 미노출, 복사·저장도 없음)으로 강제하고,
  스트림에 MCP 호출이 보이면 실패다. resume은 **관측된 session id로 `codex exec resume <id>`만** 하고
  **`--last`는 쓰지 않는다**; ephemeral 세션의 resume은 거부한다.
- **④ JSONL 어댑터**: `src/exec/codexStreamParser.ts` 신규. 8종을 좁게 파싱하고 나머지는 bounded unknown이다
  (성공 근거로 쓰지 않는다). **종료 결과는 정확히 1건**이며 stream outcome + exit code/signal을 합쳐
  `finish()`가 만든다 → silent stream·정상 종료 뒤 비정상 exit·중복 종료 이벤트가 모두 조용한 성공이 되지 않는다.
  줄/이벤트/텍스트/usage 상한, malformed·과대 줄 처리, 권한 실패 → `permission_required` 매핑을 넣었고
  error/stderr 요약은 상한 + 기존 `redactSecrets`를 통과한 것만 싣는다. **새 durable raw 로그는 만들지 않았다.**
- **⑤ 타입 변경(최소)**: `src/exec/types.ts`에 `CodexSessionOptions`와 `SessionSpec.codex?` **추가만** 했다.
  `SessionEvent`·`ExecutionProvider`·기존 필드는 **무변경**(codex 이벤트는 기존 kind로 매핑된다).
- **⑥ offline fake 테스트**: `src/exec/__fixtures__/fake-codex.mjs`(결정론적 fake CLI — argv·cwd·stdin·env를
  격리 홈에 기록하고 시나리오 JSONL을 재생) + 테스트 3종.
- **검증(실행한 명령과 카운트)**:
  · `npx tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  · 파일 단독 `npx tsx --test src/exec/executionBoundary.test.ts` **8/8**,
    `… codexStreamParser.test.ts` **18/18**, `… codexCliProvider.test.ts` **18/18** (세 파일 합 **44/44**).
  · `npm run test:exec` 전체 suite **186/186**(142 → 186). **186은 exec suite 수치이며 파일 단독 focused가 아니다.**
  · **미실행**: `npm test` 전체 · core · acceptance · stress · live · 반복 3회 — M5a 범위상 돌리지 않았다
    (사용자 지시: build + focused exec만). 미실행은 미실행으로 적는다.
  · **비공허성(mutation) 2종**: ⓐ provider의 경계 대조 제거 → 경계 테스트 2건 실패
    ⓑ 종료 이벤트 없는 스트림을 성공 처리 → 5건 실패. 둘 다 **정확히 원복**했고 원복 후
    `git diff` 빈 diff · 소스 내 `MUTATION` grep **0** · focused 44/44 재확인.
- **열린 블로커**: **로컬 `codex exec --help` 실행 승인이 나지 않아 argv·플래그·JSONL 필드명을 실측하지
  못했다**(권한 거부 3회). 근거는 로드맵 §1의 기록(`0.146.0-alpha.3`에서 `--json`·`--output-schema`·
  `--ephemeral`·`--sandbox`·`--model`·config override 확인)뿐이다 → 대장 `B-6`으로 등록했고
  **M5b live 착수 전 필수**다. 잘못된 플래그는 codex가 비정상 종료하므로 결과는 fail closed다.

## 2026-07-27 (V3 **M4 문서 정합성 정정 — docs-only** · M5 착수 전 · **M5는 여전히 not started·미승인**)

격리 worktree `/private/tmp/solo-founder-harness-m4-doc-consistency` · branch `work/m4-doc-consistency` ·
base `c963cb0832d66a58fefdaa2025a9213966c3cc27`(= M4c 최종 HEAD) 단일 세션. **문서만 수정**했다 —
소스·테스트·schema·script·package/lockfile·`dist`·config·`AGENTS.md`·`CLAUDE.md` **무수정**.
push/fetch/pull/PR/merge/rebase/reset/checkout/switch/worktree 조작·네트워크·`gh`·패키지 설치·MCP·
provider 호출·deploy·DB·production·live billing **없음**. Pony Tail(full) 적용. **로컬 커밋 1개만** 만들었다.

- **① 커밋 상태 정정**: M4a `55d99a3`+`805da35` · M4b `11775fd`+`ab63eac` · M4c `3cfdb39`+`c963cb0`
  (M4c 최종 HEAD `c963cb0`). 각 구현 세션 본문의 "미커밋 working tree"는 원문을 보존한 채
  **그 시점 기록임을 명시**했고, 현행 상태 블록은 로컬 커밋 사실로 고쳤다. 원격 push/PR/merge는 **0**이며
  원본 checkout은 `bbb8b72`로 clean·무수정이다.
- **② 테스트 범위 라벨 정정**: 파일 단독 `orchestrationKernel.test.ts`는 **67/67**(37 → 50 → 67),
  **142/142는 `npm run test:exec` 전체 suite**(125 → 142)다. 두 수치를 혼동한 곳을 owned 문서 전부에서
  고쳤다(요약뿐 아니라 M4c 본문·mutation 원복 문장·활성 V3 문서 3건 머리말 포함).
  core **374/374** · acceptance **92/92** · offline acceptance 31/42/77 · build PASS는 불변.
- **③ 대장 등록(로드맵 §9.1)**: M4c 최종 Codex 리뷰 3건 — `B-5`(P1, `manifest.approvedCommit`이 실행
  checkout HEAD에 묶이지 않음 → **M5가 실제 명령을 처음 실행하기 전 fail closed 필수**) ·
  `C-16`(P2, taskId↔roleId 교차 모호성 → M5 실제 inbox 소비 전) · `C-17`(P2, `expiresAt` 정확히 같은 시각
  1회 통과 → 장시간 autopilot/재승인 전). **셋 다 backlog이고 코드 리비전 루프를 열지 않았다.**
- **④ 신규 문서**: `docs/handoff/CLAUDE_CODE_WORKER_PLAYBOOK.md`(Claude Code 구현 세션 운영 표준).
  `AGENTS.md`의 장기 규칙을 복제하지 않고 링크하며 세션 운영 절차만 적었다. CODEX_HANDOFF 현행 절에서 링크했다.
- **검증**: `git diff` 확인 · `git diff --check` **clean** · 소유 밖 변경 **0**(git status로 확인) ·
  임시 제어 파일(`.codex-doc-worker-prompt.md`·`.mcp-empty.codex.json`)은 untracked·unstaged 유지.
- **전체 suite**: `npm test` **1회 직렬 실행 — PASS**. 처음에는 이 격리 worktree에 `node_modules`가 없어
  `tsx: command not found`로 멈췄고(그 시점 블로커), 감독 Codex가 **원본 checkout의 기설치 `node_modules`를
  이 worktree에 ignored 로컬 symlink로 제공**한 뒤 실행했다. **패키지 설치·네트워크는 없었다.**
  실측: acceptance **PASS=92 FAIL=0**(Test 1~15 전부 OK, `ALL PASS`). `test:inner`는
  `test:exec && test:core && acceptance` **`&&` 체인**이므로 acceptance 단계 도달 자체가 exec·core 통과를
  뜻한다 — 다만 **exec·core의 개별 카운트는 이 실행에서 출력 tail만 캡처해 그대로 옮기지 못했다**(base
  `c963cb0` 실측은 exec 142/142 · core 374/374). 그 두 숫자를 이 세션 실측으로 적지 않는다.
  **stress·live·반복(3회)·두 번째 전체 suite는 실행하지 않았다.**
- **stress·live·반복(3회) suite는 실행하지 않았다**(`B-1`/`B-2` — 이 세션 게이트 아님).
- **하지 않은 것**: M5 구현 · 코드 변경 · 원격 조작 · 두 번째 오케스트레이션 설계 추가 ·
  M5 세부 구현 명세 추측. **M5는 not started·미승인이다.**

## 2026-07-27 (V3 **M4c — sibling/reviewer 라우팅 + 메시지 10종 + milestone approval manifest + 7 specialist registry** · M4b 위 stacked 격리 worktree · **이로써 M4 전체 완료 · M5는 미완료**)

격리 worktree `/private/tmp/solo-founder-harness-m4c` · branch `work/m4c-routing-approval` ·
base `ab63eacc51650deaee0ce92b78a22a7ddcdc27bd`(리뷰 완료된 M4b 커밋) 단일 세션.
**M4a/M4b와 분리된 stacked 브랜치**다. 세션 중에는 미커밋 working tree였고(그 시점 기록),
현행 M4c는 로컬 커밋 `3cfdb39`(feat) + `c963cb0`(docs)로 남아 있다 — **최종 HEAD `c963cb0`, 원격 push/PR/merge 없음.**
원본 checkout과 M4a/M4b worktree는 수정하지 않았다. 패키지 설치·신규 의존성·package/lockfile 변경 **0**,
네트워크·`gh`·deploy·DB·production·live billing·MCP·provider 호출·subagent/Agent Team **없음**,
stress·live runner **미실행**. Pony Tail(full) 적용 세션이다.

- **① §5.1 메시지 계약을 4종 → 10종으로 닫았다.** `status_update`·`review_request`·`review_result`·
  `revision_request`·`decision_request`·`decision`을 runtime·body·schema·durable index·테스트에 전부
  반영했다. **envelope 필드 집합은 무변경**이다 — route·권한을 envelope에 밀어 넣지 않았다.
  heading은 §5.2가 지정한 것(`review_result`, 공유 `blocker`/`decision_request`)을 그대로 쓰고,
  지정되지 않은 4종만 **최소 closed set 3개씩**을 새로 정해 문서화했다. summary 계약도 표(`SUMMARY_REQUIRED`)
  하나로 닫았다: `task_assignment`/`spawn_request`는 null, 나머지 8종은 bounded summary 필수.
- **② sibling·reviewer·decision 라우팅은 전부 중앙을 지난다.** 진입점은 타입마다 하나씩 좁게 뒀고
  (`submitStatusUpdate`/`requestReview`/`submitReviewResult`/`requestRevision`/`submitDecisionRequest`/
  `recordDecision`), **다른 task를 바꾸거나 남의 mailbox에 쓰는 범용 API는 만들지 않았다.**
  전달 대상은 taskId 또는 **유일한** roleId로만 해석하고 자기 자신·미상·모호·orchestrator·종료 상태·
  무관 관계를 각각 다른 stable code로 거부한다(전이 0). reviewer는 **대상에 의존하는 fresh task**여야
  하고, `revision_request`는 **그 대상의 review_result가 이미 있을 때만** 나간다.
  durable route는 envelope가 아니라 message index(`routeToTaskId`/`acknowledgedAt`)에 있다.
- **③ 미수령 전달 목록은 durable state만으로 계산한다.** `createdAt` → `messageId` 정렬이라 재시작 후에도
  같은 순서·같은 다음 전달이다. 수령은 좁은 전이 하나(`acknowledgeDelivery` + durable event
  `delivery_acknowledged`)이고 **범용 queue/retry/우선순위는 만들지 않았다**(→ `C-12`).
- **④ §8 milestone approval manifest를 durable 계약으로 넣었다.** run 생성 시 **필수 bind**이고
  (기본값 = 조용한 자동 승인이므로), state·`stateContentDigest`·snapshot(bounded·비밀 아님)에 들어간다.
  검증은 closed: 40자 commit hash · 정규화된 writableRoots/ownership · **정확히 pin된 dependency**
  (latest·범위·tag 거부) · 정규화 도메인 · 양수 bounded 예산 · 만료 · milestone 일치.
- **⑤ state 관련 권한은 지금 전부 강제한다 — 커밋 경로 공용 불변식으로.** root/dependent ownership은
  `ownershipByTask` 명시 승인 안이어야 하고, 모든 ownership은 `writableRoots` 안, child는 **parent
  범위의 부분집합**만, 동시 running은 `maxSessions` 이하, 만료 후 변경은 전부 거부다.
  M4b가 자원 충돌을 한 곳에 둔 것과 같은 이유로 `assertReferentialIntegrity` 안에 넣었다 →
  **새 전이 경로도 load도 우회할 수 없다**(mutation으로 비공허성 확인).
- **⑥ 실행 권한은 조회만 한다.** `commandAllowed`/`dependencyAllowed`/`networkDomainAllowed`는
  **순수 술어**이고 deny-by-default다. shell 파싱·패키지 설치·네트워크·git merge·provider 호출은 없다.
  `localMergeAllowed`는 기록·조회 전용이며 repo hard deny가 항상 더 강하다.
- **⑦ 7 specialist registry를 정본 상수 하나로 넣었다**(`research`/`pm`/`ux`/`design`/`tech-lead`/
  `dev-lead`/`qa-security`). `roleId`는 이 목록이거나 `<상위>.<하위>`(한 겹)여야 하고 그 밖은
  `unknown_role`이다. run마다 7개 task를 요구하지 않고 프로세스도 띄우지 않으며 모델·provider 라우팅을
  중복 정의하지 않는다. 기존 테스트/스크립트의 role 픽스처는 registry 값으로 바꿨다(단정은 무변경).
- **⑧ 하위 호환은 fail closed 하나로.** manifest 없는 pre-M4c state는 마이그레이션하지 않고
  **`state_pre_m4c_unsupported`** 로 거부한다(자동 승인 금지). `schemaVersion`은 `"1"` 유지.
- **⑨ 테스트(삭제·완화 0)**: **파일 단독** focused `orchestrationKernel.test.ts` 50 → **67건**(M4c 17건 추가).
  같은 17건으로 `npm run test:exec` 전체 suite는 125 → 142건이 됐다.
  계약 변경으로 손댄 기존 단정은 3곳뿐이다 — ⓐ "미구현 타입 거부"를 **union 밖 타입 거부**로 바꿨고
  (10종이 구현됐으므로), ⓑ 공개 API 목록에 신규 9개를 더했고, ⓒ state 위조 루프에 **manifest 위조
  6종을 추가**하며 거부 코드 집합을 넓혔다(전부 여전히 fail closed). 신규
  `scripts/m4c-offline-acceptance.mjs`(77 체크) + `acceptance.sh` **Test 15**(11 checks),
  **기존 Test 1~14 무변경**. M4a/M4b 스크립트는 manifest 인자 1개만 더했고 체크 수는 31/42 그대로다.
- **검증 실측(offline)**: **파일 단독** focused **67/67** → `npm run build` PASS →
  M4c acceptance **77/77** · M4a **31/31** · M4b **42/42** →
  `npm test` **PASS(최종 코드 변경 후 1회)** = exec suite **142/142** + core **374/374** + acceptance **92/92**
  (81 → 92). `git diff --check` clean. (**142/142는 exec suite 수치이지 파일 단독 focused가 아니다.**)
- **비공허성(mutation) 4종**: ① ownership 불변식 호출 제거 ② session 불변식 호출 제거
  ③ sibling 관계 검사 무력화 ④ 만료 게이트 제거 — 각각 해당 M4c 테스트 1건이 실패함을 확인하고
  **전부 정확히 원복**(원복 후 파일 SHA-256 일치, 소스 내 `MUTATION` 흔적 grep 0,
  **파일 단독 focused 67/67** 재확인).
- **하지 않은 것**: M5 provider bridge/autopilot · 실제 7-agent 동시 실행 · stress/live/반복 suite ·
  UI/dashboard · 크래시·fsync 하드닝 · stale lock 회수 · schema 마이그레이션 도구 · fairness/retry ·
  git 조작 · 테스트 삭제·완화 **0**.
- **새 유예 항목**: `C-11`(manifest 재승인 경로 없음) · `C-12`(ack에 재전송·우선순위 없음) ·
  `C-13`(리뷰 대상이 durable 필드가 아님) · `C-14`(command 조회는 문자열 동치) ·
  `C-15`(registry가 코드 상수). 전부 nonblocking이며 로드맵 §9.1 대장에 등록했다. `C-6`은 **fixed**.
- **문서 정정**: 대장 `C-4` 보강 항목의 "lock 발행 후 write 실패 경로도 같은 잔재를 남긴다"를 정정했다 —
  커밋 경로에서 잡히는 정상적인 write 실패는 `commitRun`의 `finally`가 lock을 **해제한다**. 잔재는
  크래시/kill · 해제 실패 · `acquireRunWriterLock`이 파일을 만든 뒤 nonce write가 실패하는 좁은 창뿐이다.
  (`maxResourceClasses`는 문서·코드 모두 이미 **4**로 일치해 고칠 것이 없었다.)

## 2026-07-27 (V3 **M4b — 배타 자원 class + deterministic scheduler + run writer lock** · M4a 위 stacked 격리 worktree · **M4 전체는 여전히 미완료**)

격리 worktree `/private/tmp/solo-founder-harness-m4b` · branch `work/m4b-resource-scheduler` ·
base `805da35801a59aeecf436d96d1054483247d643b`(리뷰 완료된 M4a 커밋) 단일 세션.
**M4a와 분리된 stacked 브랜치**다. 세션 중에는 미커밋 working tree였고(그 시점 기록),
현행 M4b는 로컬 커밋 `11775fd`(feat) + `ab63eac`(docs)로 남아 있다 — **원격 push/PR/merge 없음.**
원본 checkout은 수정하지 않았다. 패키지 설치·신규 의존성·package/lockfile 변경 **0**,
네트워크·`gh`·deploy·DB·production·live billing·MCP·provider 호출·subagent **없음**,
stress·live runner **미실행**. Pony Tail(full) 적용 세션이다.

- **① 배타 자원 class를 durable 계약으로 만들었다(대장 `B-3` 절반).** task가 배타 자원 class를
  **0..4개** 선언한다(`OrchestrationTask.resourceClasses` — slug · 사전순 · 중복 거부 ·
  빈 배열 = 병렬 안전). runtime validator · `TASK_KEYS` · JSON schema(required) · snapshot ·
  `stateContentDigest`(→ state↔event binding)에 모두 반영했으므로 선언을 손으로 고치면
  `state_event_binding_mismatch`로 거부된다. 선언 주체는 **중앙**이다 — §5.1 envelope 필드 집합은
  건드리지 않았고 **agent가 자기 자원 권한을 선언할 경로는 없다**.
  점유는 **`running` 동안만**이고 `waiting_children`은 중단 상태라 자원을 들고 있지 않다(명시 결정).
- **② deterministic scheduler를 kernel 안 좁은 API 2개로 넣었다(대장 `B-3` 나머지).**
  `scheduleReady(limit?)`는 `taskId` 오름차순으로 훑어 ⓐ running task가 점유한 class와
  ⓑ **같은 batch에서 앞서 고른** class를 모두 피해 고른다(state·파일 변경 0, 같은 state면 같은 답).
  `startScheduledBatch(limit?)`는 그 batch를 **커밋 1회**로 running으로 올린다. batch 상한 1..8.
  **두 번째 오케스트레이터·queue·retry·priority·fairness·실제 동시 실행은 만들지 않았다.**
- **③ 충돌 규칙은 한 곳에만 뒀다 — 직접 `startTask`도 우회할 수 없다.** 처음에는 `startTask` 안에
  사전 검사를 뒀는데 **mutation 테스트에서 그 검사를 지워도 아무 테스트도 실패하지 않았다**:
  커밋 경로의 공용 불변식(`assertExclusiveResourceClaims` ← `assertReferentialIntegrity`)이 이미
  같은 판정을 내리고 있었다. 그래서 중복 검사를 **삭제**하고 불변식 하나만 남겼다 →
  `startTask`든 앞으로 추가되는 어떤 전이 경로든, 그리고 load까지 같은 검사를 받는다
  (`resource_conflict`, 전이 0).
- **④ run 단위 writer lock + stale writer 거부(대장 `B-4`).**
  커밋 전 과정(디스크 base 확인 → body → events append → snapshot → state)을
  `outputs/orchestration/<run-id>/run_state.lock` **하나 안에서** 수행한다.
  lock은 `O_CREAT|O_EXCL`이고 **대기하지 않는다**(`run_lock_held`, retry loop 없음).
  호출자는 커밋 기준(직전 디스크 state의 `revision`/`lastEventId`/`lastEventHash`)을
  `CommitInput.base`로 넘기고 lock 안에서 디스크와 대조한다 → 같은 revision에서 열린 두 kernel 중
  늦은 쪽은 `stale_writer`로 거부되고 **먼저 쓴 결과를 덮지도, 남의 event tail에 이어 붙이지도 않는다**.
  `base`는 optional이 아니다(기본값을 두면 새 호출부가 조용히 보호 밖으로 나간다).
  해제는 최종 엔트리를 `O_RDONLY|O_NOFOLLOW`로 읽어 nonce를 대조하고 다르면 **남의 lock을 보존**한 채
  `run_lock_owner_mismatch`로 올린다. 정상 커밋 후 lock 잔재 0.
  **자동 stale 회수·크래시 복구·fsync 하드닝·분산 lock·retry는 넣지 않았다**(→ `C-4` 보강 / `C-8`).
  기존 suite lock(`scripts/lib/suite-exclusive-lock.mjs`)은 **재사용하지 않았다** — guard·ownership
  token 상속·pgid 스캔·격리 같은 suite 전용 의미를 orchestration에 끌어오지 않기 위해서다.
- **⑤ 하위 호환: M4a state는 마이그레이션 없이 거부한다.** `task.resourceClasses`가 없는 상태 파일은
  기본값으로 조용히 채우지 않고 `state_pre_m4b_unsupported`로 fail-closed하며 새 run을 만들게 한다.
  기본값으로 채우면 ⓐ 그 state의 `stateDigest`가 어차피 어긋나 원인이 불분명한 실패가 되고
  ⓑ 선언 없는 task를 "병렬 안전"으로 오해할 여지가 남는다. `schemaVersion`은 `"1"`을 유지했다 —
  그 상수는 메시지 envelope와 공용이라 올리면 M4a 계약과 acceptance Test 13까지 흔든다.
  **마이그레이션 프레임워크는 만들지 않았다**(→ `C-9`).
- **⑥ 테스트(삭제·완화 0)**: focused `orchestrationKernel.test.ts` 37 → **50건**(M4b 13건 추가) =
  선언 정규화/상한/durable 왕복 · scheduler 결정론 · batch 커밋 1회·limit 검증 · 직접 start 동일 규칙 ·
  `waiting_children` 미점유 · holder 완료 시 해제 · 재시작 후 동일 결정 · 선언 위조 거부 ·
  pre-M4b state 거부 · running 둘 충돌 state 거부 · stale writer · lock 경합 · lock 소유자 보존.
  기존 M4a 테스트는 **전부 유지**했고 계약 변경으로 손댄 것은 2곳뿐이다(공개 API 목록에 신규 2개 추가,
  `commitRun` 호출에 `base` 전달). 신규 `scripts/m4b-offline-acceptance.mjs`(42 체크)와
  `scripts/acceptance.sh` **Test 14**(6 checks)를 추가했고 **기존 Test 1~13은 무변경**이다.
- **검증 실측(offline)**: focused **50/50** → `npm run build` PASS →
  `node scripts/m4b-offline-acceptance.mjs` **42/42 PASS(exit 0)** ·
  `node scripts/m4a-offline-acceptance.mjs` **31/31 PASS(불변)** →
  `npm test` **PASS(최종 코드 변경 후 1회)** = `test:exec` → `test:core` → acceptance **81/81**
  (75 → 81). `npm run test:exec` 단독은 이 세션에서 **125/125**로 확인(112 → 125).
  core 카운트는 별도 캡처하지 않았지만 `test:inner`가 `&&` 체인이라 acceptance 도달 자체가
  exec·core 통과를 뜻한다. **두 번째 `npm test`는 중복이라 Codex가 시작 직후 중단시켰고 결과로 세지
  않는다**(부분 출력 없음). `git diff --check` clean.
- **비공허성(mutation) 4종**: ① 공용 자원 불변식 제거 → M4b 3건 실패, ② stale base 대조 제거 →
  stale writer 1건 실패, ③ lock EEXIST를 성공 처리 → lock 2건 실패, ④ `startTask` 중복 사전 검사 제거 →
  **0건 실패(중복 확인 → 삭제)**. ①~③은 정확히 원복하고 원복 후 focused **50/50** 재확인,
  소스 내 `MUTATION` 흔적 grep 0.
- **M4 전체는 여전히 미완료**: sibling 전달 · reviewer 왕복(나머지 6개 메시지 타입) ·
  milestone approval manifest · 7 specialist registry 등록·**실제 7-agent 동시 실행** ·
  provider bridge/MCP · CLI/UI가 **M4c 잔여**다. **M4b에서 발견한 P0는 없다.**

## 2026-07-27 (V3 M4a — **Codex 독립 리뷰 P0 2건 수정** · 허용된 단일 P0 정정 세션 · **M3 완료 재확인** · **M4 전체 여전히 미완료**)

같은 격리 worktree/branch(`work/m4a-durable-orchestration`, base `ea764a5`)에서 이어서 진행했다.
**P0 2건만 고쳤고 M4a 범위를 넓히지 않았다.** P1/P2는 구현하지 않고 backlog로 남겼다.
commit/push/PR/merge/rebase/reset/checkout/switch/worktree 조작 **없음**, 패키지 설치·네트워크·`gh`·
deploy·DB·production **없음**, stress·live·반복 acceptance **미실행**.

- **① P0-1 — 형태가 유효한 `run_state.json` 변조가 중앙 전이 계약을 우회했다.**
  재현(빌드된 코드 기준): run/root 생성 → root start → `run_state.json`만 편집해
  `tasks[0].state="completed"` · `tasks[0].resultSummary="forged"` → `openOrchestrationRun`이 **수락**.
  기존 load는 형태·참조·event 해시 체인은 봤지만 **검증된 state 내용을 durable event 이력에 묶지 않았다**
  → 후속 작업이 잘못 풀릴 수 있었다.
  **수정(최소·의존성 0)**: 커밋의 **마지막 이벤트**에 `stateDigest`를 추가했다. 값은 그 커밋이 남기는
  state **내용**의 SHA-256이고 chain 필드(`lastEventId`/`lastEventHash`)를 **제외**해 순환을 피한다
  (state → event digest → chain hash → state.lastEventHash). load가 `assertStateEventBinding`으로
  재계산·대조하며 불일치는 `state_event_binding_mismatch`, digest 부재는 `state_event_binding_missing`으로
  fail-closed다. binding을 남길 곳이 반드시 있어야 하므로 `commitRun`이 빈 이벤트 커밋을
  `commit_without_event`로 거부한다. 결정론적 직렬화, event/message/artifact 기존 계약,
  invalid-input 전이 0, parent/child acceptance 동작은 그대로다.
  event 계약이 바뀐 만큼 `schemas/orchestration_run_state.schema.json`과 runtime parity 테스트도 갱신했다.
  **한계(정직하게 기록)**: 키 없는 digest라 `run_state.json`과 `events.jsonl`을 **모두 일관되게 재작성**하는
  위조는 막지 못한다 — 그 경우 append-only 감사 로그 자체가 조작되므로 감사 대상이다.
  상향 경로(out-of-band 키 HMAC/서명)는 대장 **`C-7`** 로 등록했다.
- **② P0-1 회귀 테스트**: focused 34 → **37건**(삭제·완화 0). 신규 3건 =
  ⓐ Codex 재현 시나리오 그대로의 위조 거부 + 허용 필드 6종(`state`/`resultSummary`/`ownership`/
  `revision`/`milestoneId`/`messages[].summary`) 개별 변조 전부 fail-closed + 원상 복구 후 정상 open,
  ⓑ digest가 chain 필드와 무관함(순환 없음) + 커밋 **마지막** 이벤트에만 붙음(커밋 3건 = digest 3건),
  ⓒ 이벤트 없는 커밋 거부. 기존 malformed/event/message/artifact fail-closed 테스트는 **전부 유지**했다.
  offline acceptance도 29 → **31 체크**(위조 state 거부 + 복구 확인)로 늘렸다.
- **③ P0-2 — 문서가 완료된 M3를 재개방하고 있었다.** 사용자 확정 상태는 이렇다:
  M3a/M3b/M3c core와 **실제 live acceptance 완료**, M3d.2는 **PR #10으로 `ea764a5` 병합**,
  **M3는 완료이며 재개방 금지**, stress/live **재실행은 nonblocking release-readiness backlog**로
  M3 완료 게이트도 M4 선행 조건도 아니다. 그런데 최신 문서들이 `B-1`/`B-2`를 여전히
  "M3d 완료 게이트 / 사용자 액션 대기 / 차단"으로 적고 있었다.
  **현행 섹션만 정정했다**: 로드맵에 `§0-0 현행 상태` 블록 신설 · `§1`과 `§10 M3d` 머리에 "이 절은
  2026-07-26 스냅샷" 표시 · `§9.1` 대장의 `B-1`/`B-2`를 **C(release-readiness)** 로 재분류하고 재분류
  근거를 명시 · `§12` 항목 7~9를 정정 · CONTEXT_SUMMARY와 CODEX_HANDOFF의 최신 섹션에 같은 취지의
  현행 상태 블록 추가. **과거 dated 항목의 원 문장은 하나도 고쳐 쓰지 않았다**(이력으로 보존).
- **④ 최종 검증(offline)**: focused **37/37 PASS** → `npm run build` PASS →
  `node scripts/m4a-offline-acceptance.mjs` **31/31 PASS(exit 0)** →
  `npm test` **PASS** = exec **112/112** + core **374/374**(불변) + acceptance **75/75** →
  `git diff --check` clean.
- **⑤ `npm test` 실행 횟수(정직한 기록)**: 구현 체인 전체에서 **4회**다 — 구현 세션 3회
  (최초 / 카운트 확인용 재실행 / 미사용 코드 삭제 후 최종) + 이번 P0 수정 세션의 **마지막 코드 변경 후
  정확히 1회**. **4회 모두 PASS.** 이번 세션은 카운트 추출 목적의 추가 실행을 하지 않았다.
- **⑥ 변경 파일**: `src/exec/orchestrationTypes.ts`(event에 `stateDigest`) ·
  `src/exec/orchestrationStore.ts`(`stateContentDigest`/`assertStateEventBinding`/`commitRun` binding·
  빈 이벤트 거부/`loadRun` 검증 추가/`EVENT_KEYS`·`validateEvent`) ·
  `src/exec/orchestrationKernel.ts`(`eventId: 0` placeholder 제거, Mutation 타입 정리) ·
  `src/exec/orchestrationKernel.test.ts`(+3건) · `schemas/orchestration_run_state.schema.json` ·
  `scripts/m4a-offline-acceptance.mjs`(+2 체크) · 문서 6건 · `dist/exec/*.js` 재빌드.
- **⑦ 하지 않은 것**: P1/P2 구현(대장 `B-3`/`B-4`/`C-4`/`C-5`/`C-6`/`C-7`에 비용·트리거와 함께 유예) ·
  M4a 범위 확대 · stress/live/반복 acceptance · 기존 테스트 삭제·완화.
- **다음**: M4 잔여 범위(scheduler · exclusive resource class · sibling/reviewer 메시지 ·
  approval manifest)의 계획 → 사용자 승인 → 구현.

## 2026-07-27 (V3 **M4a** — deterministic durable orchestration kernel 구현·offline 검증 · **M4a 완료 / M4 전체 미완료**)

**격리 worktree 세션이다.** worktree `/private/tmp/solo-founder-harness-m4a` ·
branch `work/m4a-durable-orchestration` · base `ea764a54108f1715248f3e0ae414ea87eb8ffaa9`
(PR #10 merge commit). 원본 checkout `/Users/jihun/Developer/solo-founder-harness`는 읽기 전용으로만
접근했고 수정·초기화하지 않았다. **commit/push/PR/merge/rebase/reset/checkout/switch/worktree 조작 없음.**
네트워크·`gh`·deploy·DB·production·live billing·패키지 설치·신규 의존성 **없음**.
subagent/Agent Team 없이 **단일 세션**으로 구현했다.

- **① M4a 최소 수직 기능을 구현했다(M4 전체가 아니다).** 기존 `runWorkflow`/`mission`/
  `ExecutionProvider`를 복제하거나 교체하지 않고, `src/exec` 안에 **state-only/offline** durable
  orchestration kernel을 추가했다. 실제 provider·LLM·프로세스는 하나도 띄우지 않는다.
  `projects/<p>/outputs/run_state.json`과 `registry/agent_registry.json`은 **무수정**이다.
- **② 신규 파일 8개 + 수정 2개.** 신규: `src/exec/orchestrationTypes.ts` ·
  `src/exec/agentMessage.ts` · `src/exec/orchestrationStore.ts` · `src/exec/orchestrationKernel.ts` ·
  `src/exec/orchestrationKernel.test.ts` · `schemas/agent_message.schema.json` ·
  `schemas/orchestration_run_state.schema.json` · `scripts/m4a-offline-acceptance.mjs`.
  수정: `scripts/acceptance.sh`(Test 13 추가 — 기존 Test 1~12 무변경) · `.gitignore`
  (`outputs/orchestration/` 1줄). 빌드 산출물 `dist/exec/*.js` 4개가 함께 생성됐다.
- **③ 상태·메시지 계약.** task 상태는 `pending|ready|running|waiting_children|completed|blocked`
  6개뿐, 메시지 타입은 `task_assignment|spawn_request|result|blocker` 4종뿐이다(§5.1의 나머지 6종은
  schema·runtime 양쪽에서 거부). §5.1 envelope 필드를 유지하고 machine-readable envelope와
  human-readable Markdown body를 함께 다루며, 타입별 필수 h2 heading 전부 + 계약 밖 h2 금지 +
  중복 금지 + 16 KiB 상한을 runtime validator가 강제한다.
- **④ spawn 상한과 nested child.** task당 child 4 · child depth 최대 3(root=0) · run당 task 32.
  child도 같은 bounded API로 자기 child를 요청할 수 있다(3단 중첩 테스트로 고정).
  한 번 spawn해 `waiting_children`이 된 parent도 상한 안에서 child를 더 요청할 수 있다.
- **⑤ ownership.** workspace-relative 정규화(`.` segment만 접음)이고 absolute·`..`·빈 경로·
  빈 segment·backslash·NUL을 거부한다. **M4a에서 ownership은 기록·검증 메타데이터일 뿐 실제 파일
  권한이나 provider 실행 권한이 아니다**(문서·주석·schema에 명시).
- **⑥ artifact는 포인터만 운반한다.** `result`가 중앙 state로 옮기는 것은 bounded summary(≤1000자)와
  검증된 포인터(workspace-relative path · SHA-256 · revision · producer task · role)뿐이고 raw 본문·
  raw transcript는 복사하지 않는다. 수락 **직전** 일반 파일 여부 · 상위 디렉터리 symlink를 포함한
  workspace 탈출 여부(realpath 비교) · 등록 revision/hash 일치를 재검증하며 symlink·missing·
  hash mismatch·탈출은 fail-closed다. 등록은 조용히 덮어쓰지 않고 revision+`supersedes`를 남긴다.
- **⑦ 상태 전파는 kernel만 한다.** child가 completed면 모든 child가 완료된 parent를 ready로,
  의존이 전부 완료된 dependent를 ready로 재계산한다. blocker는 child를 blocked로 만들고 영향받는
  조상·dependent를 blocked로 갱신하되 completed는 되돌리지 않는다. **agent가 다른 task 상태를
  직접 바꾸는 API는 없다** — 공개 prototype 메서드 목록을 테스트가 고정하고 읽기 API는 깊은 사본만 준다.
- **⑧ durable state.** SoR는 `outputs/orchestration/<run-id>/run_state.json`,
  `events.jsonl`은 append-only 해시 체인, `messages/<message-id>.md`는 검증된 body 저장소,
  `snapshot.md`는 state에서 재생성하는 파생물이다. state에 `schemaVersion`·monotonic `revision`·
  `lastEventId`/`lastEventHash`를 두고, 저장은 같은 디렉터리 임시 파일 → rename이다
  (**과도한 fsync/crash hardening은 이번 범위가 아니다**). load는 state schema·event linkage·
  message body hash·artifact hash 중 하나라도 어긋나면 던지고 **null/빈 run으로 강등하지 않는다**.
  유효하지 않은 입력에서는 **state revision과 영속 파일 모두 전이 0**이다(검증 → 커밋 순서).
- **⑨ 결정성.** ready 목록·snapshot은 taskId 정렬로 고정이고, create 경로와 open 경로가 같은
  직렬화 바이트를 낸다(검증 중 `artifactRecord` key 순서 불일치를 발견해 고쳤고 회귀 단정을 넣었다).
  타임스탬프는 주입 clock, ID는 호출자 제공 bounded slug라 테스트가 결정론적이다.
- **⑩ schema는 계약 문서, runtime validator가 보안 경계다.** 신규 Ajv 등 검증 의존성 0
  (기존 `liveEvidence.ts`와 같은 수동 closed validator 방식). 두 schema의 enum·required·bounds와
  runtime 상수의 동치를 테스트 2건이 강제한다.
- **⑪ 검증 실측(offline)**: focused `src/exec/orchestrationKernel.test.ts` **34/34 PASS** →
  `npm run build` PASS → `node scripts/m4a-offline-acceptance.mjs` **PASS(29/29, exit 0)** →
  `npm test` **PASS** = exec **109/109**(75 → 109) + core **374/374**(불변) +
  acceptance **75/75**(71 → 75) → `git diff --check` clean.
  (`npm test`는 첫 실행에서 exec/core 카운트가 출력 tail 밖이라 카운트 확인용으로 한 번 더 돌렸다 —
  **두 번 다 PASS**이며 그 사실을 그대로 적는다.)
- **⑫ 하지 않은 것.** stress(`acceptance:stress:m3d2`)·live runner 3종·반복(연속 3회) suite는
  **실행하지 않았다** — release-readiness backlog(`B-1`/`B-2`)로 그대로 열려 있다.
  M3/M3d는 재개방하지 않았고 기존 테스트를 삭제·완화하지 않았다.
- **⑬ M4 전체는 미완료다.** provider bridge · 7 specialist registry 등록·동시 실행 · 나머지 6개 메시지 타입 ·
  범용 scheduler · **exclusive resource class**(M4 완료 항목) · 멀티프로세스 writer lock ·
  approval manifest 전체 · MCP/CLI/UI는 구현하지 않았다. 신규 유예 항목 `B-3`·`B-4`·`C-4`·`C-5`·`C-6`을
  로드맵 §9.1 대장에 기한·비용과 함께 등록했다. **P0는 없다.**
- **다음: fresh Codex P0 검수.** 그 결과에 따라 M4 잔여 범위(scheduler·exclusive class·sibling/reviewer
  메시지)의 계획→승인→구현으로 넘어간다.

## 2026-07-26 (여덟 번째 리비전 **재검토 결과 기록** + **배송 우선 리뷰 정책 · 안전 병렬 Claude 세션 정책 도입** — 문서 전용 세션 · **M3d 여전히 미완료**)

**문서·정책 전용 세션이다.** 코드·패키지·schema·script·생성 산출물·의존성을 **한 줄도 바꾸지 않았고**,
commit/push/fetch/pull/PR·패키지 설치·네트워크·테스트·stress·live runner도 **실행하지 않았다**
(docs-only이고 코드는 이미 검증됐으므로 build/test를 돌리지 않는다는 지시에 따랐다).
변경 파일은 정확히 9개: `AGENTS.md` · `CLAUDE.md` · `docs/handoff/CODEX_HANDOFF.md` ·
`docs/CONTEXT_SUMMARY.md` · `docs/WORKLOG.md` · `docs/DECISIONS.md` ·
`docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` · `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` ·
`docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`.

- **① 여덟 번째 리비전 재검토 결과(fresh Codex Sol xhigh · read-only)를 기록했다.**
  verdict = **`APPROVE_FEATURE_PROGRESSION`**, **Category A(지금 차단) 0건**. 리뷰는 read-only였고
  테스트·네트워크·편집을 수행하지 않았다.
  **이것은 M3d 완료 APPROVE가 아니다** — 부하(stress) acceptance는 여섯 번째 리비전 세션의 **FAIL 기록 그대로
  미충족/pending(차단 게이트)** 이고, live runner 3종·evidence 3건도 **pending**이며 **M3d는 미완료**다.
  **기존 완료 게이트는 전부 그대로 존재한다.** 리뷰 이력 현행 = **REQUEST_CHANGES 8회(리비전 1~8) +
  진행 승인 1회 · M3d 완료 APPROVE 0회**. 이 판정을 "M3d APPROVE"로 줄여 적지 않는다.
- **② Category C(개선 backlog) 1건을 유예 대장 `C-1`로 등록했다(이번에 고치지 않음).**
  bounded computed dynamic specifier 분석이, 도달 가능한 조각 각각에는 `fixture-config`가 없지만 런타임에
  합성되는 route(예: `"./lib/" + (flag ? "fixture-" : "other-") + "config.mjs"`)를 놓칠 수 있다.
  현재 production 호출부 5개는 **영향 없음** · 확률 낮음 · 영향 반경은 "미래 소스 레벨 호출부 감사 누락"으로
  한정 · 유예 비용 낮음 · 수정 공수 소~중 → 유예 비용 대비 공수 판단으로 **C 유예**가 맞다.
- **③ 같은 Category C의 문서 정확성 정정을 반영했다.** CODEX_HANDOFF의 "`loader`·`unproven` 둘 다 문제로
  보고되므로 **조용히 통과하는 경로는 없다**"는 서술은 사실이 아니다 — `safe` 분기가 정확히 그 경로다.
  과장된 문장만 제거하고, **정직하게 bounded된 규칙 서술**과 **정상 dist 동적 import 3파일이 호출부로 잡히지
  않는다**는 positive 대조군 단정은 그대로 유지했다.
- **④ 배송 우선 리뷰 triage 정책(사용자 승인)을 문서화했다.** 리뷰 finding은 **A/B/C**로 분류한다 —
  A = 지금 차단(P0/P1 · 데이터 손실 · 승인/인증/상태 전이 우회 · 되돌리기 어려운 아키텍처 · 유예 비용이 커서
  후속 작업이 안전하지 않거나 폐기 대상), B = 지정 마일스톤/트리거 전 필수(**명시적 기한**이 있을 때만 유예),
  C = bounded P2/P3 완전성·문서 정밀도·낮은 확률 edge case·micro-optimization.
  **C만으로는 리비전 루프를 다시 돌리거나 기능 진행을 멈추지 않는다.** 우선순위는 **심각도 단독이 아니라
  유예 비용 대 수정 공수**로 정한다.
- **⑤ 유예 findings 무손실 대장을 만들었다(로드맵 §9.1).** 각 항목은 심각도 · 발생 확률 · 영향 반경 ·
  유예/rework 비용 · 수정 공수 · 기한/트리거 · 담당 · 증거/산출물 참조 · 상태를 유지한다. **조용한 폐기 금지.**
  현재 열린 항목: `C-1`(위) · `C-2`(fixture 로더 모듈 주석 진입점 2개 예시 ↔ 실제 5개) ·
  `C-3`(`parseDiagnostics` 준공개 필드 위험) · `B-1`(부하 acceptance 미충족 = **차단**) ·
  `B-2`(live runner 3종·evidence 3건 = **차단**).
- **⑥ 테스트 비례 원칙을 명문화했다.** 변경마다 focused → handoff 전 전체 suite 1회 → 반복(연속 3회)·stress·
  live는 마일스톤/하드닝 게이트에서만(단 변경이 동시성·lock·타이밍·live runner 계약을 건드리면 즉시).
  **테스트 완화·삭제 금지는 예외 없이 유지된다.**
- **⑦ fresh context 강제 유지 + 안전한 병렬 Claude 세션 정책을 도입했다.** 구현·리비전 = fresh Claude Code
  Opus 5, 넓은 계획·비평·리뷰 = fresh Codex `gpt-5.6-sol` xhigh, 리뷰어는 **read-only**이며 작성자 transcript·
  자기평가와 분리한다. 병렬 Opus 5 세션은 **실질적으로 빨라지고 안전할 때만** 쓰며 조건은
  ⓐ task DAG·공유 API/schema 선확정, ⓑ worker당 격리 worktree 1개 + 명시적 파일 소유권,
  ⓒ 같은 파일 두 writer 금지(disjoint), ⓓ 공유 schema/API 변경·통합/병합·상태 마이그레이션·최종 전체 테스트
  직렬, ⓔ 배타 자원·전역 tmp/프로세스·stress·live는 기존 suite lock 아래 직렬, ⓕ 동시성 상한은 CPU/부하·메모리·
  토큰/비용 예산·manifest `maxSessions`(오버헤드가 이득을 넘으면 세션 1개로), ⓖ 오케스트레이터가 의존성·소유권·
  artifact hash·상태·완료·결과 라우팅 검증, ⓗ 로컬 통합 직렬 · **원격 쓰기 hard deny 유지**.
  **직전의 공유 dirty 체크아웃 리비전을 단일 세션으로 진행한 것은 옳은 판단이었다** — 병렬은 격리 worktree가
  준비된 미래 작업부터 적용한다.
- **⑧ 마일스톤 게이팅 문구를 정리했다.** **M4 구현은 not started**이며 별도 사용자 마일스톤 승인이 필요하다.
  배송 우선 원칙에 따라 **M4 계획 준비는 지금 가능**하고, 로드맵 M4 절에 "별도로 승인된 offline·격리 M4 작업은
  **미검증 live evidence를 소비하지 않는 범위에서만** 남은 외부 M3d stress/live 종료 작업과 겹칠 수 있다"는
  **제안**을 적었다. 단 **M3d는 게이트가 닫히기 전까지 미완료**이고 **M4도 M3d 게이트 전에는 자기 통합/acceptance
  게이트를 통과할 수 없으며**, 이 중첩은 **M4 사용자 승인 없이는 발동하지 않는다**(승인받았다고 적지 않았다).
  hard deny와 모든 승인 경계는 그대로다.
- **⑨ 규율**: `AGENTS.md`/`CLAUDE.md`에는 **오래 가는 정책 요약만** 넣고, 상세 근거·대장 템플릿은 로드맵과
  상태 문서에 두었다. 과거 리비전 기록은 **덮어쓰지 않고** "그 시점 기록" 표기를 달아 보존했다.
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변.
  로컬 `develop`과 `origin/develop` 모두 같은 커밋(remote-tracking reflog에 2026-07-26 13:48:21 +0900 외부 push
  갱신 기록). 워킹 트리는 의도적으로 dirty하며 누적된 승인 범위 M3d 작업이 **전부 보존**되어 있다.
  이 세션이 만든 변경은 위 문서 9개뿐이고 신규 파일은 없다.
- **읽기 전용 확인만 수행**: `git diff --check`(clean) · `git status --short` · `git branch --show-current` ·
  `git rev-parse HEAD` · 낡은 현행 상태 문구 grep. build/test는 docs-only이므로 돌리지 않았다.

## 2026-07-26 (V3 M3d.2 **여덟 번째 리비전** — 여덟 번째 fresh Codex Sol xhigh REQUEST_CHANGES 3건(P2 2 · P3 1) 수정 · **부하(stress) acceptance는 여섯 번째 리비전 세션의 FAIL 기록 그대로 미충족(차단 게이트, 이번 세션 미재실행) · live 검증 여전히 pending · 승인 미수령**)

> **재검토됨(2026-07-26).** 아래 "재검토 대기(pending)"·"APPROVE 0회"는 **그 시점 기록**이다. 현행 사실은
> **REQUEST_CHANGES 8회 + 진행 승인(`APPROVE_FEATURE_PROGRESSION`) 1회 · M3d 완료 APPROVE 0회**이며,
> **M3d 미완료·M4 not started는 변함없다**(위 2026-07-26 항목 참조).

**여덟 번째 리비전이다.** 리뷰가 지적한 **P2 2건(감사에 유효한 ESM 우회로가 남아 있다 / 바인딩 판정이
scope를 모른다)** 과 **P3 1건(회귀 커버리지 부족 + 문서 과장)** 을 **테스트·문서로만** 해소했다.
**production 코드·live runner·의존성은 이번 리비전에서 전혀 수정하지 않았다**(fixture 로더의 모듈 주석도
건드리지 않았다). **live acceptance 3종은 이 세션에서도 미실행이고 부하 acceptance도 미충족이므로 M3d 완료도
M4 ready도 아니며, 어떤 리뷰 승인도 받지 않았다.**
리뷰 이력은 **REQUEST_CHANGES 8회(리비전 1~8에 각 1회) · APPROVE 0회**이며 이 리비전은 **재검토 대기(pending)** 다.
이 항목은 아래 일곱 번째~세 번째 리비전 항목을 **대체하지 않고 보강**한다.

- **변경 파일(여덟 번째 리비전): 코드·테스트 1개 + 문서 7개.** 테스트 =
  `src/tools/suiteExclusiveLock.test.ts`(70 → 75건). 문서 = WORKLOG / DECISIONS / CONTEXT_SUMMARY /
  CODEX_HANDOFF / 로드맵 / 활성 V3 기준 문서 2건.
  `scripts/lib/suite-exclusive-lock.mjs`·`scripts/lib/fixture-config.mjs`·`scripts/suite-lock.mjs`·
  `scripts/m3d2-stress-acceptance.mjs`·`src/tools/liveEvidence.*`·`schemas/*`·`package.json`·live runner 3종은
  **이번 리비전에서 수정하지 않았다.**
- **① P2 — 지정자 정규화가 URL 규칙이 아니었다.** 일곱 번째 리비전의 AST 감사는 상대 지정자를 문자열 경로로만
  풀어서 `"./lib/fixture-config.mjs?v=1"`(query) · `"…#seam"`(fragment) · `"./lib/fixture%2Dconfig.mjs"`
  (percent — Node ESM은 file URL을 디코드해 **같은 파일**로 해석한다)를 **로더로 인식하지 못했다**.
  이제 정규화는 URL 문법 그대로다(첫 `#` 뒤 fragment → 그 앞 첫 `?` 뒤 query → 남은 path `decodeURIComponent`).
  디코드 불가(`%zz`)·인코딩된 경로 구분자(`%2F`)는 "로더가 아니다"로 넘기지 않고 **판정 불가 = fail closed**로 보고한다.
- **② P2 — 계산된 동적 import route를 아예 보지 않았다.** 예전엔 `import()` 인자가 문자열 리터럴일 때만 판정했다.
  이제 지정자 식을 bounded하게 **접는다**(리터럴 · 치환 없는 template · `+` 연결 · 파일 안에서 **정확히 한 번**
  `const`로 선언되고 초기화식이 있는 이름, 재귀 상한 8). 접히면 그 결과로 판정한다.
  **접히지 않을 때의 bounded fail-closed 규칙(문서화 · whole-program 증명 주장 없음)**: 도달 가능한 문자열 조각이
  하나도 없으면(파라미터·재할당 `let`·중복 선언) **fail closed로 보고**, 조각 중 하나라도 로더 token
  (`fixture-config`)을 포함하거나 정규화 불가면 **로더 동적 로딩으로 보고**, 그 밖은 `safe`로 본다.
  `safe`를 남긴 이유는 live runner 3종의 **정상** 동적 import(`await import(join(HERE, "..", "dist", …))`)를
  깨뜨리지 않기 위해서이고, 실제 repo 대조군 3파일이 호출부 목록에 **들어오지 않음**을 테스트가 단정한다.
- **③ P2 — import-then-export 재수출을 놓쳤다.** 직접 `export … from`만 잡고 `import {loadFixtureConfig}` 뒤의
  `export { loadFixtureConfig }`는 ExportSpecifier를 참조에서 제외해 **아무 문제도 보고하지 않았다**
  (정상 호출 + 재수출이면 issues가 비어 있었다). 이제 수집이 **두 패스**다 — import/`export … from`/동적 로딩을
  모두 모은 **뒤에** 노출 패스가 `export { X }` · `export { X as Y }` · `export default X` · namespace 파생 노출을
  본다 → **소스 순서로 우회할 수 없다**. `export * as ns from <loader>`도 직접 재수출로 잡는다.
- **④ P2 — 바인딩 판정이 scope를 몰랐다.** 식별자 텍스트만 봤기 때문에 ⓐ 지역 `process` shadow가
  `canonicalFirstArg` + 첫 인자 **원문** 단정까지 통과했고, ⓑ shadow된 이름이 **import 사용으로 계산**되어 미사용
  검사가 무력했고, ⓒ **namespace import에는 미사용 검사가 없었다**. 이제 선언 sweep(`var`/`let`/`const`·구조 분해·
  파라미터·function/class 이름·import 바인딩·`catch` 변수)으로 **전역 `process`나 추적 중인 direct/namespace
  바인딩을 가리는 선언이 하나라도 있으면 감사를 실패**시킨다(정확한 scope 계산 대신 conservative fail closed).
  shadow된 식별자는 **import 사용으로 인정하지 않고**(→ 미사용으로도 보고), `process` shadow가 있으면 구조가
  맞아도 `canonicalFirstArg=false`다. namespace도 direct와 **같은 미사용 검사**를 받는다.
- **⑤ P3 — 감사 신뢰성·문서 정확성.** 감사가 **파싱 진단**을 보고, 구문 오류가 있으면 "부분 파싱된 소스"이므로
  "import를 못 찾았다"를 "로더를 부르지 않는다"의 근거로 쓰지 않는다(fail closed). 상태 문서의 리비전·카운트·
  게이트 표기를 여덟 번째 리비전 사실로 정정했고, **부하 acceptance 완료 게이트를 "비차단"으로 적지 않는다**.
- **기존 계약은 그대로 유지**: `scripts` 아래 모든 깊이 재귀 열거 + symlink 미추적·보고, 기대 호출부 **정확히 5개**,
  파일당 호출 **1회**, **인자 정확히 2개**, 첫 인자 구조·원문 = `process.argv.slice(2)`, 문자열·주석 오탐 0,
  여섯 번째 리비전의 `O_NOFOLLOW`·post-guard 상태 공표·소비자 미완결 보고.
  **TypeScript는 이미 devDependency이고 테스트에서만 import한다 — 의존성·production 주입 표면 추가 0.**
- **⑥ 테스트 — `src/tools/suiteExclusiveLock.test.ts` 70 → 75건**(삭제·완화 0건). 신규 5건 =
  ⓐ query/fragment/percent 지정자 6형태(전부 세 번째 인자) 발견+거부 · 정규화 불가 2형태 fail closed ·
  로더가 아닌 query 지정자 **오탐 금지**, ⓑ 계산된 동적 import 6형태 로더 확정 + 확정 불가 3형태 fail closed +
  **정상 빌드 산출물 동적 import 대조군**, ⓒ 재수출 6형태(import-then-export · export-before-import · 별칭 ·
  default · namespace 파생 · `export * as`), ⓓ shadow 6형태(`process` const/파라미터 · direct · namespace ·
  미사용 namespace · namespace 값 전달), ⓔ 파싱 진단 2형태. 기존 production 호출부 테스트에는 **정상 동적 import
  대조군 3파일 열거** 단정을 더했다. 신규 케이스는 전부 **순수 합성 소스**라 파일 잔재·production 훼손 0이다.
- **검증 실측(offline)**: `node --check`(.mjs 4종) OK, `npx tsc --noEmit -p tsconfig.json` 0,
  테스트 파일 단독 strict 타입체크 0, `npm run build` PASS(파이프로 종료 상태를 가리지 않고 확인).
  focused `suiteExclusiveLock.test.ts` **75/75**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **374/374** + acceptance **71/71**
  (1회차는 grep tail 때문에 core·acceptance만 캡처했고 `&&` 연쇄라 exec 통과가 전제다. 2·3회차는 3단계 전부 캡처).
  `git diff --check` clean, tmp lock/guard/격리/`.new` 잔재 0, repo backup/mutation 잔재 0, 잔존 suite/fixture
  프로세스 0, git 파일 목록 세션 시작과 동일. live runner 3종은 실행하지 않았다.
  (범위 밖 기존 잔재는 그대로 남는다: `harness-perm-*` 다수 — `src/exec/permissionCompiler.test.ts:69` ·
  이번 세션보다 9시간 앞선 `harness-pf-*` 1건.)
- **부하(stress) acceptance는 미충족이고 이것은 M3d 완료의 차단 게이트다(비차단 위험이 아니다).**
  여섯 번째 리비전 세션이 같은 호스트에서 두 번 실행해 두 번 다 **FAIL(exit 1)** 했고 원인이 **그 뒤 어떤 리비전도
  손대지 않은 고정 5초 child startup deadline 2건 + 외부 호스트 부하**로 확인됐다. 이번 리비전도 production 코드를
  전혀 바꾸지 않았으므로 사용자 지시에 따라 재실행하지 않고 **그 FAIL을 그대로 미충족으로 기록**한다
  (거짓 PASS 주장 없음). 상세 수치는 아래 여섯 번째 리비전 항목에 있다.
- **비공허성(mutation) 8종** — 새 방어를 하나씩 되돌려 해당 테스트가 실패함을 확인하고 **전부 정확히 원복**했다:
  ① query/fragment 분해 제거 → **2건 실패**, ② percent 디코드 제거 → 지정자 테스트 실패, ③ 동적 지정자 게이트를
  문자열 리터럴 전용으로 복원 → 동적 테스트 실패, ④ 노출 패스 제거 → 재수출 테스트 실패, ⑤ `process` shadow를
  정규형 판정에서 제외 → shadow 테스트 실패, ⑥ direct/namespace shadow 검출 제거 → shadow 테스트 실패,
  ⑦ namespace 미사용 검사 제거 → shadow 테스트 실패, ⑧ 파싱 진단 무시 → 구문 오류 테스트 실패.
  원복 후 프로젝트/단독 strict 타입체크 0 · build PASS · focused **75/75** · **24/24** 재확인,
  소스 내 `MUTATION` 흔적 grep **0**.
- **Git**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/push/fetch/pull/PR·패키지 설치·
  의존성 변경·네트워크·live runner 실행 없음. 세션 시작 시점의 dirty 파일 목록과 동일(기존 변경 전부 보존,
  신규 파일 추가 없음).
- **잔여 위험(비차단 — 부하 acceptance 게이트는 여기 포함되지 않는다)**: 아래 여섯 번째~일곱 번째 리비전의 lock
  계층 위험이 전부 유효하다. 이번 리비전이 더하거나 명시한 것: ⓐ 감사는 정적 분석이므로 런타임 동적 호출은
  보고까지만 한다, ⓑ `scripts` 밖 호출부는 범위 밖이다(현재 없음), ⓒ 동적 지정자 판정은 **bounded 규칙**이라
  "조각은 있으나 로더 token이 없는" 완전 런타임 구성 경로는 `safe`로 본다, ⓓ 선언 sweep은 열거한 선언 형태만
  보므로 새 형태의 shadow는 놓칠 수 있다(그 경우에도 호출 형태·노출·동적 로딩 검사는 동작한다),
  ⓔ `parseDiagnostics`는 TypeScript 준공개 필드라 상위 버전에서 이름이 바뀌면 검사가 조용히 무력화될 수 있다
  (전용 회귀 2건이 그걸 잡는다), ⓕ `scripts/lib/fixture-config.mjs` 모듈 주석이 진입점을 2개만 예시로 적어 실제
  5개와 어긋나 보인다 — 이번 범위에서 production 주석을 건드리지 않기로 해 **수정하지 않았다**(다음 승인 범위 권장).

## 2026-07-26 (V3 M3d.2 **일곱 번째 리비전** — 일곱 번째 fresh Codex Sol xhigh REQUEST_CHANGES 1건(P2) 수정 · **stress acceptance는 여섯 번째 리비전 세션의 FAIL 기록 그대로 pending(이번 세션 미재실행) · live 검증 여전히 pending · 승인 미수령**)

> **보강됨(여덟 번째 리비전).** 아래 리비전 표기·테스트 카운트(70건)·core 369는 **그 시점 기록**이다.
> 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회 · 75건 · core 374**이며
> 위 여덟 번째 리비전 항목과 2026-07-26 항목을 본다.

**일곱 번째 리비전이다.** 리뷰가 지적한 **P2 1건(production 로더 호출부 발견이 전수가 아니다)** 을
테스트·문서로 해소했다. **production 코드·live runner·의존성은 이번 리비전에서 전혀 수정하지 않았다.**
**live acceptance 3종은 이 세션에서도 미실행이므로 M3d 완료도 M4 ready도 아니고, 어떤 리뷰 승인도 받지 않았다.**
리뷰 이력은 **REQUEST_CHANGES 7회(리비전 1~7에 각 1회) · APPROVE 0회**이며 이 리비전은 **재검토 대기(pending)** 다.
이 항목은 아래 여섯 번째~세 번째 리비전 항목을 **대체하지 않고 보강**한다.

- **변경 파일(일곱 번째 리비전): 코드·테스트 1개 + 문서 7개.** 테스트 =
  `src/tools/suiteExclusiveLock.test.ts`(67 → 70건). 문서 = WORKLOG / DECISIONS / CONTEXT_SUMMARY /
  CODEX_HANDOFF / 로드맵 / 활성 V3 기준 문서 2건.
  `scripts/lib/suite-exclusive-lock.mjs`·`scripts/lib/fixture-config.mjs`·`scripts/suite-lock.mjs`·
  `scripts/m3d2-stress-acceptance.mjs`·`src/tools/liveEvidence.*`·`schemas/*`·`package.json`·live runner 3종은
  **이번 리비전에서 수정하지 않았다.**
- **① P2 호출부 발견이 전수가 아니었다.** 여섯 번째 리비전의 회귀는 `scripts` 루트와 `scripts/lib` **한 겹만**
  훑고 `loadFixtureConfig(` **문자열 일치**로 호출부를 찾았다. 그래서 ⓐ 더 깊은 하위 디렉터리의 호출부
  (실제로 `scripts/fixtures/m3a/minimal-stdio-mcp.mjs` 같은 깊이가 존재한다), ⓑ 식별자와 `(` 사이에 공백·줄바꿈·
  주석이 낀 호출, ⓒ `import { loadFixtureConfig as loadCfg }` 별칭 호출이 감사를 통과한 채 **세 번째 인자
  (in-process io seam)를 넘길 수 있었다** — "새 호출부가 생기면 먼저 깨진다"는 문서화된 경계와 모순이다.
- **② 감사를 구문 인식·재귀로 교체했다(테스트 전용).** `scripts` 아래 **모든 깊이**의 일반 `.mjs`를 재귀 열거하고
  (symlink 파일·디렉터리는 production 소스로 신뢰하지 않고 따라가지 않으며, 건너뛴 목록을 함께 보고한다),
  TypeScript AST로 `scripts/lib/fixture-config.mjs`에서 온 바인딩(별칭 `as`·namespace import 포함)을 추적해
  **그 바인딩을 통한 호출만** 검사한다. 계약: 호출부 목록 == 기대 5개(`suite-lock.mjs`,
  `m3d2-stress-acceptance.mjs`, `m3a-live-preflight.mjs`, `m3b2-live-handoff.mjs`, `m3c3b-live-handoff.mjs`),
  파일당 호출 1회, **인자 정확히 2개**, 첫 인자가 **구조적으로** `process.argv.slice(2)`(문자열 비교가 아니라 AST 모양).
  import했지만 호출하지 않는 바인딩·다중 호출·동적 로딩(`import()`/`require()`)·재수출·비호출 참조도 **문제로 보고**한다.
  문자열·주석 안의 이름은 구문상 호출이 아니므로 오탐하지 않는다.
  **TypeScript는 이미 devDependency이고 테스트에서만 import한다 — 의존성 변경·production 주입 표면 추가 0.**
- **③ 테스트 — `src/tools/suiteExclusiveLock.test.ts` 67 → 70건**(삭제·완화 0건): 기존 호출부 회귀 1건을
  재귀·AST 판으로 **교체·강화**하고 신규 3건을 더했다.
  ⓐ **열거 계약**(임시 디렉터리: 중첩 `.mjs` 발견 · symlink 파일/디렉터리 미추적·보고 · 비 `.mjs` 제외),
  ⓑ **우회 mutation 4종**(중첩 경로 · 공백/주석 분리 호출 · 별칭 import · namespace import — 모두 세 번째 인자를
  넘긴다)이 전부 **발견되고 거부**되며 같은 실행에서 정상 합성 호출부는 통과,
  ⓒ 첫 인자 비정규형 · 미사용 바인딩 · 다중 호출 · 동적 로딩/재수출/비호출 참조 검출 + **문자열·주석 오탐 금지**.
  우회 케이스는 **순수 합성 소스**라 임시 파일을 남기지 않고 production을 훼손하지도 않는다.
  실제 5개 호출부가 그대로 통과함도 같은 테스트가 단정한다(목록·바인딩 이름·인자 2개·첫 인자 원문까지).
- **검증 실측(offline)**: `node --check`(.mjs 4종) OK, `npx tsc --noEmit -p tsconfig.json` 0,
  테스트 파일 단독 strict 타입체크 0, `npm run build` PASS(파이프로 종료 상태를 가리지 않고 확인).
  focused `suiteExclusiveLock.test.ts` **70/70**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **369/369** + acceptance **71/71**
  (1회차는 acceptance 71/71 tail만 캡처했고, `&&` 연쇄라 exec·core 통과가 전제다).
  `git diff --check` clean, tmp lock/guard/격리/`.new` 잔재 0, repo backup/mutation 잔재 0,
  잔존 suite/fixture 프로세스 0. live runner 3종은 실행하지 않았다.
- **stress acceptance는 이 세션에서 실행하지 않았다(pending).** 여섯 번째 리비전 세션이 같은 호스트에서 두 번
  실행해 두 번 다 **FAIL(exit 1)** 했고 원인이 **이번 리비전이 손대지 않은 고정 5초 child startup deadline 2건 +
  외부 호스트 부하**로 확인됐기 때문에, 사용자 지시에 따라 재실행하지 않고 **그 FAIL을 그대로 미충족(pending)으로
  기록**한다(거짓 PASS 주장 없음). 상세 수치는 아래 여섯 번째 리비전 항목에 그대로 있다.
- **비공허성(mutation) 4종** — 각 mutation에서 해당 테스트가 실패함을 확인한 뒤 **전부 정확히 원복**하고,
  원복 후 타입체크 0 · focused **70/70** · **24/24** 재확인, 소스에 mutation 흔적 grep 0:
  ① 재귀 제거(하위 디렉터리 미탐색) → 열거 테스트 + 실제 호출부 테스트 **2건 실패**,
  ② 옛 문자열 스캔 게이트 복원(`text.includes("loadFixtureConfig(")`) → **공백/주석·별칭 케이스 실패**,
  ③ 별칭 인식 제거(로컬 이름만 인정) → **별칭 케이스 실패**,
  ④ 인자 개수 검사 완화(`!== 2` → `< 2`) → **세 번째 인자 거부 단정 전부 실패**.
- **Git**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/push/fetch/pull/PR·패키지 설치·
  의존성 변경·네트워크·live runner 실행 없음. 세션 시작 시점의 dirty 파일 목록과 동일(기존 변경 전부 보존,
  신규 파일 추가 없음).
- **잔여 위험(비차단 — 여덟 번째 리비전 정정: 부하 acceptance 미충족은 비차단 위험이 아니라 M3d 완료를 막는
  차단 게이트다)**: 아래 여섯 번째 리비전 항목의 위험이 모두 유효하다(부하 acceptance 미충족 · `O_NOFOLLOW`
  미지원 플랫폼 전용 테스트 없음 · 확인→unlink 창 0 불가 · 수동 정리 표면 · `ps lstart` 1초 해상도 등).
  이번 리비전이 추가한 위험: ⓐ 감사는 **정적 분석**이므로 런타임 동적 호출(값으로 전달된 함수 등)은 "문제 보고"로
  막을 뿐 실행을 막지 못한다, ⓑ `scripts` 밖(예: `src/`)에서 로더를 부르는 코드는 이 감사 범위 밖이다
  (현재 그런 호출부는 없다), ⓒ `scripts/lib/fixture-config.mjs` 모듈 주석은 production 진입점을 **2개만 예시**로
  적고 있어 실제 5개와 어긋나 보인다 — 이번 범위(테스트+문서)에서 production 파일을 건드리지 않기 위해
  수정하지 않았고, 다음 승인 범위에서 주석만 정정하기를 권한다.

## 2026-07-26 (V3 M3d.2 **여섯 번째 리비전** — 여섯 번째 fresh Codex Sol xhigh REQUEST_CHANGES 6건 수정 · **stress acceptance는 이 세션 환경에서 FAIL(외부 부하 원인) · live 검증 여전히 pending · 승인 미수령**)

**여섯 번째 리비전이다.** 리뷰가 지적한 P1 1건(최종 경로 symlink가 lock 신원 검사를 우회), P2 1건
(guard 반납 실패 뒤에도 handle이 released로 남음), P3 1건(리비전 5 변경 파일 수 표기 모순)과 추가 지적
(io seam 회귀가 production 호출부 일부만 검사)을 코드·결정적 회귀 테스트·문서로 해소했다.
**live acceptance 3종은 이 세션에서도 미실행이므로 M3d 완료도 M4 ready도 아니고, 어떤 리뷰 승인도 받지 않았다.**
리뷰 이력은 **REQUEST_CHANGES 6회(리비전 1~6에 각 1회) · APPROVE 0회**이며 이 리비전은 **재검토 대기(pending)** 다.
이 항목은 아래 다섯 번째~세 번째 리비전 항목을 **대체하지 않고 보강**한다.

- **변경 파일(여섯 번째 리비전): 코드·테스트 4개 + 문서 7개.** 코드/테스트 =
  `scripts/lib/suite-exclusive-lock.mjs`(symlink 거부 · 성공 상태 공표 순서), `scripts/suite-lock.mjs`(해제 미완결
  명시 보고), `scripts/m3d2-stress-acceptance.mjs`(같은 보고), `src/tools/suiteExclusiveLock.test.ts`(62 → 67건).
  문서 = WORKLOG / DECISIONS / CONTEXT_SUMMARY / CODEX_HANDOFF / 로드맵 / 활성 V3 기준 문서 2건.
  `scripts/lib/fixture-config.mjs`·`src/tools/liveEvidence.*`·`schemas/*`·`package.json`·live runner 3종은
  **이번 리비전에서 수정하지 않았다.**
- **① P1 최종 경로 symlink는 lock/guard 신원으로 인정하지 않는다 (`openReadNoFollow`)**: 예전
  `readLockSnapshot`/`readGuardRecord`는 `openSync(path, "r")`로 열어 **symlink를 따라갔다**. 그래서 계약 밖 행위자가
  우리 lock 파일을 다른 이름으로 **옮기고 그 자리에 symlink**를 두면 ⓐ release가 옮겨진 원본의 record·(dev,ino)로
  소유를 인정한 뒤 **symlink만 unlink하고 해제 성공을 보고**하고, ⓑ quarantine이 그 **남의 symlink 엔트리를
  rename으로 덮을** 수 있었다(신원을 확인한 파일과 파괴적 조작 대상이 서로 다른 파일). 이제 두 reader 모두
  `O_RDONLY|O_NOFOLLOW`로만 열고 symlink(ELOOP/EMLINK)는 `lock_path_symlink`로, `O_NOFOLLOW` 미지원 플랫폼은
  `lock_nofollow_unsupported`로 **거부**한다(fail closed). 두 경우 모두 **엔트리와 대상 파일을 지우거나 덮지 않는다.**
  release는 mechanism 실패로 guard를 남기고, acquire는 상태를 바꾸지 않은 거부라 guard를 정상 반납한다.
- **② P2 성공 상태는 guard 반납이 끝난 뒤에만 공표한다**: 예전 `release()`는 전이 콜백 안에서
  `handle.state = "released"`를 먼저 세팅했고, 그 뒤 `releaseTransitionGuard`가 실패해
  `lock_guard_release_failed`가 throw돼도 catch가 `held`만 `failed`로 바꿨기 때문에 **state는 released로 남았다** →
  소비자(`suite-lock.mjs` wrapper·stress runner)가 `lockReleased:true`로 보고했다. 이제 전이 콜백은 **결과만 값으로
  돌려주고**(`{value:{state}, retainGuard}`) `handle.state`는 `withTransitionGuard`가 정상 반환한 뒤 `publishState`
  에서만 바뀐다. lock unlink **뒤** guard 정리/교체/unlink가 실패하면 `state="failed"`, `released=false`, problems
  보고이며 guard가 남아 다음 실행을 막는다. 두 소비자도 `released·quarantined`가 모두 아니면
  `lock 해제가 완결되지 않았습니다(state=…)`를 문제로 명시한다. `quarantine()`도 같은 완결 규칙으로 정리했고,
  **acquire·reentry는 이미 `withTransitionGuard` 반환 뒤에 handle/결과를 만들므로** 재감사만 하고 구현은 넓히지 않았다.
- **③ 추가 지적 — io seam 회귀를 production 전 호출부로 확대**: 예전 회귀는 `suite-lock.mjs`·stress runner만
  검사했지만 `loadFixtureConfig`는 live runner 3종(`m3a-live-preflight` / `m3b2-live-handoff` / `m3c3b-live-handoff`)도
  호출한다. 이제 회귀가 `scripts/**.mjs`를 **스캔해 호출부를 발견**하고 ⓐ 발견된 목록이 기대 5개와 정확히 같은지,
  ⓑ 각 호출의 **최상위 인자가 정확히 2개**이고 첫 인자가 `process.argv.slice(2)`인지 확인한다.
  새 호출부가 생기면 목록 비교가 먼저 깨져 계약을 다시 확인하게 된다(의존성·외부 주입 표면 추가 없음).
- **④ P3 문서 수치 정정**: `docs/handoff/CODEX_HANDOFF.md`의 다섯 번째 리비전 항목이 파일 4개(lock 라이브러리 ·
  fixture 로더 · wrapper · 테스트)와 문서 7개를 나열하면서 "3개 + 문서 6개"로 적어 두었던 것을
  **"4개 + 문서 7개"** 로 정정했다. 이번 작업은 **여섯 번째 리비전 · 여섯 번째 REQUEST_CHANGES**이며
  APPROVE 0 · live evidence 3건 pending · M3d 미완료 · M4 not started는 그대로다.
- **⑤ 테스트 — `src/tools/suiteExclusiveLock.test.ts` 62 → 67건**(신규 5건, 기존 2건 **강화**, 삭제·완화 0건):
  ⓐ symlink release(엔트리+대상 원본 보존 · `released=false` · guard 잔존 · 다음 실행 차단),
  ⓑ symlink token 격리(엔트리 미덮음 · 대상에 격리 표시 없음 · guard 잔존 · 격리 temp 잔재 0),
  ⓒ symlink acquire 거부(엔트리·대상 보존 · guard 정상 반납 + "따라가는 읽기 open 없음" 소스 계약 고정),
  ⓓ **lock unlink 뒤 guard 반납 실패 → handle `failed`/`released=false`**(pause 지점에서 별도 프로세스가 guard를
  같은 내용·다른 inode로 교체 · 교체 사실을 inode로 증명 · 재호출해도 released로 승격되지 않음),
  ⓔ **stress 요약이 `lockReleased:true`가 아님**(lock unlink 뒤 guard unlink만 EACCES로 실패시켜
  `cleanupConfirmed:true` + `lockReleased:false` + `cleanupProblems>0` 관측). 강화 2건 = wrapper guard 제거 실패
  테스트에 `lock_guard_release_failed`·"해제 미완결" 보고 검사 추가, io seam 회귀를 호출부 전수 검사로 확대.
  주입 표면은 **늘리지 않았다**(pause 지점·fixture key 추가 없음, env seam·임의 명령 seam 없음).
- **검증 실측(offline)**: `node --check`(.mjs 4종) OK, `npx tsc --noEmit -p tsconfig.json` 0, `npm run build` PASS.
  focused `suiteExclusiveLock.test.ts` **67/67**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **366/366** + acceptance **71/71**
  (3회 동일 수치). `git diff --check` clean, **git이 보는 파일 266건 전수 NUL 0**,
  scoped tmp lock/guard/격리/`.new` 잔재 0, repo backup/mutation 잔재 0, 잔존 suite/fixture 프로세스 0.
  live runner 3종은 실행하지 않았다.
- **stress acceptance(부하 조건) — 이 세션에서는 FAIL이다(정직 보고)**: 일반 suite 3회가 모두 끝난 **뒤**
  `npm run acceptance:stress:m3d2`를 실행했고 **exit 1**이었다 —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":1,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false,"shutdownReason":"error"}`
  (elapsed **264.0s**). 실패 원인 파악을 위해 전체 로그를 남기는 **진단 실행 1회**를 더 했고 같은 결과였다
  (elapsed **302.0s**, 같은 JSON). 부하 중 실패한 테스트는 **2건뿐이며 이번 리비전이 건드리지 않은 파일**이다:
  `src/tools/preflight.test.ts` "[M3a] extra canary tool 실패"와 `src/tools/shadcnPilot.test.ts`
  "[M3c-0] discovery 성공(generic fixture)" — 둘 다 **고정 5000ms child startup deadline**(`preflight 타임아웃
  (5000ms) — system/init 미수신` / `discovery 타임아웃 (5000ms)`)이며 부하 중 fake child가 그 안에 뜨지 못했다.
  core는 **364/366**(exec 75/75 · acceptance 미도달)이었다. 호스트가 외부 앱 때문에 이미 바빴다(10 CPU에
  load average **8.76 / 11.10 / 8.50**, Chrome 57% · WindowServer 42% · VS Code · OBS) → stress의 worker 4개가
  더해지면 5초 창을 넘긴다(이전 리비전의 stress PASS 기록은 elapsed 109.8s로 훨씬 한가한 호스트였다).
  같은 두 파일은 부하 없이 **40/40 PASS**이고 `npm test` 3회도 모두 PASS다. lock 계층 계약은 두 실행 모두
  정상 동작했다(정리 확인 성공 · 문제 0 · lock 정상 해제 · 격리 없음 · 잔재 0 · worker 4/4 suite 종료까지 생존,
  즉 "부하 없는 PASS 금지"와 정직한 FAIL 보고가 그대로 작동). **테스트를 완화하거나 production 5초 deadline을
  임의로 늘리지 않았다** — 그건 이번 리뷰 범위가 아니고 별도 근거·승인이 필요하다.
- **비공허성(mutation) 4종** — 각 mutation에서 해당 테스트가 실패함을 확인한 뒤 **전부 정확히 원복**하고,
  원복 후 `node --check`·`tsc --noEmit` 0·focused **67/67**·**24/24** 재확인, 소스에 mutation 흔적 0,
  git 파일 목록 동일:
  ① `O_NOFOLLOW` 제거(symlink 따라가기 복원) → symlink 3건 **전부 실패**(0/3),
  ② guard 반납 전에 `released` 공표(옛 동작 복원) → P2 3건 **전부 실패**(handle · wrapper CLI · stress 요약),
  ③ `suite-lock.mjs`의 로더 호출에 세 번째 인자 추가 → 호출부 회귀가 인자 개수로 실패,
  ④ 임시 production 호출부 파일 추가 → 호출부 **발견**(목록 비교)이 실패(파일은 삭제).
- **Git**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/push/fetch/pull/PR·패키지 설치·
  의존성 변경·네트워크·live runner 실행 없음. 세션 시작 시점의 dirty 파일 목록과 동일(기존 사용자 변경 전부 보존,
  신규 파일 추가 없음).
- **잔여 위험**(①은 비차단이 아니다 — 여덟 번째 리비전 정정: 부하 acceptance 통과는 M3d 완료의 차단 게이트다.
  ② 이하가 비차단 위험이다): ① **stress acceptance는 호스트 외부 부하에 민감하다** — 위 두 테스트의 고정 5초
  child startup deadline 때문이며, 조용한 호스트에서 재실행하거나 별도 승인 하에 그 deadline을 부하 내성 있게
  바꿔야 한다(이번 리비전에서는 하지 않았다). ② `O_NOFOLLOW` 미지원 플랫폼은 lock 전이 전체가 거부된다
  (fail closed) — 그 분기는 전용 테스트가 없다(주입 seam을 lock 라이브러리에 만들지 않기로 한 결정 유지).
  ③ symlink 방어는 **열기 시점**에 판정하므로 "마지막 확인 → unlink/rename" 창은 여전히 0이 아니다(Node 18에
  `unlinkat`·compare-and-unlink 없음 — 창 최소화 + 사후 탐지 + fail closed). ④ 격리 lock·남은 guard·정리하지 못한
  `.new`는 **사람이 수동 제거**해야 한다. ⑤ lock 라이브러리 `closeSync` 실패 경로 전용 테스트 없음(간접 고정).
  ⑥ `ps lstart` 1초 해상도. ⑦ Linux는 procps 호환 `/bin/ps` 전제. ⑧ 신원 확인은 계약 밖 경로 교체를
  **탐지·중단**하지만 원복은 보장하지 않는다. ⑨ evidence 경로 TOCTOU 완전 제거 불가 · evidence 지표는 runner
  판정의 파생값. ⑩ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.
- **다음(사용자 액션)**: ⓐ 조용한 호스트에서 stress acceptance 재실행(또는 5초 deadline 처리 방침 결정) →
  ⓑ live runner 3종 실행 → evidence 3건 확인 → ⓒ fresh Codex 재검토 → 그때 M3d 완료 판정.

## 2026-07-26 (V3 M3d.2 **다섯 번째 리비전** — 다섯 번째 fresh Codex Sol xhigh REQUEST_CHANGES 5건 수정 · **live 검증 여전히 pending · 승인 미수령**)

**다섯 번째 리비전이다.** 리뷰가 지적한 P1 4건(guard 제거 직전 재검증 · 격리 rename 직전 재검증 ·
publish/guard lifecycle의 삼킨 실패 · 재진입 token 격리의 신뢰 기준 부재)과 P2 1건(fixture 로더 close 실패)을
모두 코드·결정적 회귀 테스트·문서로 해소했다.
**live acceptance 3종은 이 세션에서도 미실행이므로 M3d 완료도 M4 ready도 아니고, 어떤 리뷰 승인도 받지 않았다.**
리뷰 이력은 **REQUEST_CHANGES 5회(리비전 1~5에 각 1회) · APPROVE 0회**이며 이 리비전은 **재검토 대기(pending)** 다.
이 항목은 아래 네 번째·세 번째 리비전 항목을 **대체하지 않고 보강**한다.

- **① P1-1 guard 제거는 "확인 → 동기화 지점 → 재확인 → 최종 경로 lstat → unlink" 순서다
  (`scripts/lib/suite-exclusive-lock.mjs` `releaseTransitionGuard`)**: 소유 확인 뒤 pause를 지나 **재검증 없이**
  unlink하던 창을 닫았다. pause 이후 ⓐ 같은 방식으로 guard record(nonce)와 (dev,ino)를 **같은 fd에서** 다시 읽어
  확인하고 ⓑ unlink 직전 최종 경로 `lstat` 신원까지 재확인한 뒤에만 지운다. 그 사이 **다른 nonce/inode guard로
  교체**되면 그 guard를 **보존**하고 문제로 보고한다. 반환값이 `{ok, problem}`으로 바뀌어 호출자가 판단한다.
  Node 18에는 `unlinkat`·compare-and-unlink 원자 연산이 없어 마지막 확인과 unlink 사이 창을 **0으로 만들 수는
  없다** — 창을 syscall 두 개로 줄이고, 사후 실패는 숨기지 않고 mechanism 실패로 올려 guard가 남게 했다(모듈 주석에 명시).
- **② P1-2 격리(quarantine) rename **직전**에 원본 신원을 다시 확인한다 (`writeQuarantineRecord`)**:
  마지막 원본 확인이 temp write/close **앞**에만 있어, 그 사이 외부 lock 교체가 일어나면 rename이 **남의 파일을
  덮을** 수 있었다. 이제 temp close 성공 뒤 rename 직전에 `readLockSnapshot`으로 **기본 record + (dev,ino)** 를
  다시 확인하고, 하나라도 다르면 rename하지 않고 외부 lock을 그대로 두며 호출자가 guard를 남긴다.
  비교 기준(`expected.record`)이 없으면 아무것도 덮지 않는다.
- **③ P1-3 guard 이후의 모든 I/O·정리 실패가 성공 handle로 이어지지 않는다**:
  ⓐ `withTransitionGuard`가 guard 반납 실패 반환을 **무시하던** 것을 고쳐 `lock_guard_release_failed`
  (mechanism)로 올린다 — acquire/reentry가 전이를 완결하지 못했는데 handle을 돌려주고 suite를 시작하는 경로가
  사라졌다(원인 문자열을 오류 메시지에 담아 조용히 사라지지 않게 했다). 상태 미변경 `refusal`만 guard를 반납한다는
  기존 계약은 유지했고, 그 반납마저 실패하면 원래 거부 코드를 함께 담아 mechanism으로 올린다.
  ⓑ 임시 파일 정리(`dropOwnTemp`)는 **열자마자 fd로 확보한 (dev,ino)와 일치할 때만** unlink한다 — 신원이 없거나
  교체됐으면 **남의 파일을 blind unlink하지 않고** 문제로 보고한다. 발행 성공 후 정리 실패는
  `lock_publish_cleanup_failed`로 올린다. ⓒ 발행 실패 경로에서 삼켰던 `closeSync` 오류와 격리 temp 정리 실패도
  메시지에 함께 보고한다. ⓓ `readGuardRecord`·`readLockSnapshot`의 fd `closeSync` 실패도 무시하지 않는다
  (소유 확인을 불확실로 보고 fail closed).
- **④ P1-4 재진입 token 격리는 **재진입 시점의 신뢰 기준**을 요구한다**: `tryReenterSuiteLock`이 검증에 성공한
  시점의 **기본 record + (dev,ino)** 를 `base`로 돌려주고, wrapper가 이를 보관해 cleanup 격리
  (`quarantineByToken({ expected })`)까지 **명시 전달**한다. 이후 같은 tokenHash지만 pid/identity가 다른 외부
  lock으로 교체되면 그 lock을 **보존**하고 guard를 남긴다(새 기준을 받아 남의 lock을 격리하지 않는다).
  판정 순서는 `verifyOwnership`과 동일하게 **tokenHash → 기본 record → quarantined → inode**로 고정했다.
  `expected`는 필수이며 없으면 아무것도 하지 않는다. 테스트 전용 `quarantine` CLI 모드도 production과 같은 순서로
  (먼저 재진입해 기준 확보 → 그 기준으로만 격리) 동작하게 바꿨다.
- **⑤ P2-5 fixture 로더의 fd close 실패를 무시하지 않는다 (`scripts/lib/fixture-config.mjs`)**:
  읽기 전용 fd라도 `closeSync`가 실패하면 설정을 돌려주지 않고 `fixture_close_failed`로 거부한다.
  이 경로를 결정론적으로 검증하기 위해 주입은 **`loadFixtureConfig`의 세 번째 인자(in-process io seam)** 로만
  열었다: fs 함수 4개(openSync/fstatSync/readSync/closeSync)로 표면이 최소이고, 허용 key 밖·함수 아닌 값은
  `fixture_io_invalid`로 거부하며, **production 진입점은 인자 2개로만 호출**하므로 argv·env·설정 파일 내용으로는
  도달할 수 없다. 즉 활성 문서의 "**외부** 주입은 argv 하나뿐" 계약과 모순되지 않는다(전용 회귀 테스트가
  두 production 호출부의 인자 개수를 고정한다). env seam·임의 명령 seam은 추가하지 않았다.
- **⑥ 테스트 — `src/tools/suiteExclusiveLock.test.ts` 54 → 62건**(신규 8건, 삭제·완화 0건):
  guard 제거 직전 재확인(다른 nonce / 동일 nonce·다른 inode 2케이스) · acquire 전이 guard 제거 실패 시 성공 handle
  없음 · reentry 전이 guard 제거 실패 시 재진입 성공 없음 · 발행 후 임시 파일 정리 실패 시 성공 handle 없음 ·
  격리 rename 직전 외부 교체 보존(다른 소유자 / 동일 내용·다른 inode 2케이스) · 동일 tokenHash 외부 교체 lock 보존 ·
  fixture 로더 close 실패 · production 호출부 io seam 미전달. 기존 1건은 계약이 강해진 대로 **강화**했다
  (acquire 경로 guard inode 교체: 옛 기대 "경고 후 probe 성공(exit 1)" → 새 계약 "성공 handle 없이 거부(exit 2) +
  lock·guard 잔존 + 다음 실행 차단"). 주입은 기존 argv fixture의 **고정 enum에 pause 지점 4개**만 추가했다
  (`before_publish_tmp_cleanup`, `before_quarantine_rename`, `before_guard_unlink_acquire`,
  `before_guard_unlink_reentry`) — 지점 이름에 전이 종류를 붙여 한 실행에서 정확히 한 전이만 멈춘다.
  모든 신규 테스트는 bounded(권한/rename/pause 기반)이며 fixture 프로세스·임시 파일을 남기지 않는다.
- **검증 실측(offline)**: `node --check`(.mjs 4종) OK, `npx tsc --noEmit -p tsconfig.json` 0, `npm run build` PASS.
  focused `suiteExclusiveLock.test.ts` **62/62**, `liveEvidence.test.ts` **24/24**.
  코드·테스트 확정 후 `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **361/361** +
  acceptance **71/71**(3회 동일 수치). 일반 suite가 모두 끝난 **뒤** stress `acceptance:stress:m3d2` **1회 PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false}` (elapsed 109.8s,
  부하 중에도 exec 75/75 + core 361/361 + acceptance 71/71). `git diff --check` clean,
  **git이 보는 파일 266건 전수 NUL 0**, scoped tmp lock/guard/격리/`.new` 잔재 0, repo backup/mutation 잔재 0,
  잔존 suite/fixture 프로세스 0. live runner 3종은 실행하지 않았다.
  (기록 정확성: 위 3회 앞에 수치 캡처가 잘린 예비 full suite 1회가 있었고 그 회차도 acceptance 71/71 PASS였다.
  기록·보고 대상은 그 뒤의 **연속 3회**다.)
- **비공허성(mutation) 6종** — 각 mutation에서 해당 신규 테스트가 실패함을 확인한 뒤 **전부 원복**하고
  원복 후 `node --check`·focused 62/62 재확인, 소스에 mutation 흔적 0(grep):
  ① guard 재확인 제거 → 교체된 guard가 삭제되며 "guard 제거 직전 재확인" 실패,
  ② guard 반납 실패 무시(옛 동작) → 4건 실패(guard 소유권 · 재확인 · acquire · reentry),
  ③ 격리 rename 직전 재확인 제거 → 외부 lock을 덮고 `ok:true`를 보고하며 실패,
  ④ 재진입 기준 대신 현재 파일을 기준으로 수용(tokenHash만 신뢰) → 남의 lock을 격리하며 실패,
  ⑤ 발행 후 임시 파일 정리 실패 삼킴 → 성공 handle이 되어 실패,
  ⑥ fixture 로더 close 실패 삼킴 → 예외가 나지 않아 실패.
- **Git**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/push/fetch/pull/PR·패키지 설치·
  의존성 변경·네트워크·live runner 실행 없음. 세션 시작 시점의 dirty 파일 목록과 동일(기존 사용자 변경 전부 보존,
  신규 파일 추가 없음).
- **잔여 위험(비차단)**: ① 격리 lock·남은 guard·정리하지 못한 `.new` 임시 파일은 **사람이 수동 제거**해야 풀린다
  (자동 회수 폐지의 대가이며, 이제 정리 실패까지 fail closed에 포함되어 수동 개입 표면이 조금 더 넓다).
  ② Node 18에 `unlinkat`·compare-and-unlink가 없어 "마지막 확인 → unlink/rename" 창을 0으로 만들 수 없다
  (창 최소화 + 사후 탐지 + fail closed). ③ 잠금 라이브러리의 `closeSync` 실패 경로는 결정론적 주입 수단이 없어
  (io seam을 lock 라이브러리까지 넓히지 않기로 했다) 전용 테스트가 없다 — 구현은 fail closed지만 회귀 테스트는
  "소유 확인 불가 → 제거하지 않음" 분기로만 간접 고정된다. ④ `ps lstart` 1초 해상도. ⑤ Linux는 procps 호환
  `/bin/ps` 전제. ⑥ 신원 확인은 계약 밖 경로 교체를 **탐지·중단**하지만 원복은 보장하지 않는다.
  ⑦ evidence 경로 TOCTOU 완전 제거 불가(Node 18 한계). ⑧ evidence 지표는 runner 판정의 파생값.
  ⑨ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.
- **다음(사용자 액션)**: live runner 3종 실행 → evidence 3건 확인 → fresh Codex 재검토 → 그때 M3d 완료 판정.

## 2026-07-26 (V3 M3d.2 **네 번째 리비전** — 네 번째 fresh Codex Sol xhigh REQUEST_CHANGES 5건 수정 · **live 검증 여전히 pending · 승인 미수령**)

**네 번째 리비전이다.** 리뷰가 지적한 P1 3건(발행 신원 불변식 · 전이 실패 분류 · fixture 로더 검사–사용 경합),
P2 1건(테스트 공백), P3 1건(문서 리뷰 횟수 모순)을 수정했다.
**live acceptance 3종은 여전히 미실행이므로 M3d 완료도 M4 ready도 아니고, 어떤 리뷰 승인도 받지 않았다.**
이 항목은 아래 "세 번째 리비전" 항목을 **대체하지 않고 보강**한다(세 번째 리비전의 guard 계약은 그대로 유효하다).

- **① P1-1 발행(publish)은 신원 확인 뒤에만 성공이다 (`scripts/lib/suite-exclusive-lock.mjs`)**:
  `publishFileExclusive`가 `linkSync` **뒤** `lstatSync` 실패를 `published:true` + `dev/ino: null`로 반환해,
  이후 전이가 tokenHash만 보고 **inode 검증을 조용히 생략**하는 구멍이 있었다. 이제
  ① 임시 파일을 **열린 fd의 `fstat`** 으로 (dev,ino)를 확보하고(경로 재해석 없음),
  ② `link` 뒤 최종 경로 `lstat`이 **같은 (dev,ino)** 이며 일반 파일임을 확인해야 성공으로 인정한다.
  lstat 실패는 `lock_publish_unverifiable`, 불일치는 `lock_publish_identity_mismatch`이고 **둘 다 최종 경로를
  지우지 않는다** — 우리 파일이라는 증거가 없는 파일은 blind unlink하지 않는다(계약 밖 경로 간섭을 탐지·중단하고
  그 파일이 남아 새 suite 실행을 막는다). `published:true`의 dev/ino는 **non-null 불변식**이라
  `verifyOwnership`·`writeQuarantineRecord`의 inode 검증이 **무조건** 수행된다(옛 `if (ino !== null)` 우회 제거).
  guard 발행이 불확실하면 그 guard를 제거하지 않고 실패하며, lock 발행 실패는 감싼 guard를 남긴다.
- **② P1-2 전이 실패 분류를 명시했다 (fail closed가 기본값)**: `SuiteLockError.failure ∈ {refusal, mechanism}`을
  도입하고 **기본값을 `mechanism`(guard 유지)** 으로 두었다 — 분류를 적지 않은 새 오류 경로가 자동으로 안전한 쪽에
  선다. acquire/release/quarantine/reentry 전 전이를 감사해 ⓐ guard 취득 뒤의 메커니즘 I/O 오류
  (temp create/write/close/link, 발행 신원 확인, lock unlink, 격리 write/close/rename, guard 제거)는 전부 guard를
  남기고, ⓑ **아무 상태도 바꾸지 않은 계약상 거부만**(lock_held/quarantined/orphaned/unverifiable/unreadable/
  concurrent_suite/ps_unavailable/reentry_*) 자기 nonce+inode 재확인 후 guard를 반납하게 했다. 함께 고친 것:
  `writeAllSync`로 **short write를 오류로** 올리고(부분 기록 금지), 격리 경로의 `closeSync` 실패를 무시하지 않고
  (rename하지 않는다), 격리 rename **직후** 신원을 재확인하고, **lock unlink의 ENOENT도 실패**로 보며,
  **guard 제거 실패(ENOENT 포함)도 문제로 보고**하고, 보유 중 lock이 계약 밖에서 사라진 경우를 "해제됨"으로
  처리하지 않는다. `quarantineByToken`은 **tokenHash를 먼저** 확인해 남의 격리 lock을 우리 성공으로 착각하지 않는다.
  또 격리 rewrite는 기본 record(v/kind/pid/identity/tokenHash) 보존을 요구하므로 **같은 token만으로는** 외부 교체를
  격리로 인정하지 않는다(순서는 tokenHash → record 동일성 → quarantined → inode).
  guard record와 그 inode도 **한 fd**에서 함께 읽어 경로를 두 번 해석하지 않는다.
- **③ P1-3 fixture 로더의 검사–사용 경합 제거 (`scripts/lib/fixture-config.mjs`)**: `lstatSync(path)`로 검사한 뒤
  `readFileSync(path)`로 경로를 **다시 해석**하던 구조를, 경로를 **정확히 한 번** 열고
  (`O_RDONLY|O_NOFOLLOW`) → **그 fd의 `fstat`** 으로 일반 파일 확인 → **같은 fd에서 최대 8193B 읽기** →
  **실제 읽은 바이트로 상한 판정**으로 바꿨다. 최종 symlink는 열기 전에 거부되고(ELOOP/EMLINK),
  교체된 경로는 다시 열지 않으며, close 오류는 이미 읽은 바이트에 영향이 없으므로 fd 누수만 막고 넘어간다.
  O_NOFOLLOW 미지원 플랫폼은 주입 자체를 거부한다(fail closed).
- **④ P2 테스트 보강 — `src/tools/suiteExclusiveLock.test.ts` 43 → 54건**: post-guard **lock 발행 실패(EACCES)**,
  계약 밖 writer와의 **발행 충돌**(디렉터리는 쓸 수 있는 상태 → guard 유지가 오직 분류 때문임을 고정),
  **lock unlink syscall 실패**, **guard 제거 unlink 실패**, 같은 token으로 심어진 외부 격리 record 거부,
  **TERM을 무시하는 중첩 child·손자의 상위 유예 후 KILL과 전 자손 소멸**(stress `suiteMode: nested_ignore_term`),
  fixture 로더 4건(최종 symlink 거부 · 8192 통과/8193 거부 · 비일반 파일 거부 · **경합 중 교체된 설정 미해석**),
  wrapper·stress 양방향 fixture key 거부. 주입은 기존 argv `--fixture-config`의 고정 enum·allowlist뿐이며
  pause 지점 1개(`before_guard_unlink_release`)만 추가했다 — env seam·임의 명령 seam은 만들지 않았고 fixture가
  없으면 이 경로들은 모두 불가능하다. 기존 테스트는 삭제·완화하지 않았다.
- **⑤ confused deputy 축소 (`scripts/m3d2-stress-acceptance.mjs`, `scripts/suite-lock.mjs`)**: stress runner가
  자기 fixture 파일을 그대로 물려주지 않고 **child에게 필요한 최소 설정만**(`lockPath`/`injectDir`/`childMs`/
  `confirmMs`/`guardWaitMs`) 새 파일로 명시 전달한다. 그래서 wrapper 계약에서 stress 전용 key
  (workers/testTimeoutMs/deadlineMs/suiteMode/suiteSleepMs)를 **삭제**하고 `inject`를 `confirm_failure` 하나로
  좁혔다 — 이제 그런 key가 담긴 설정으로 wrapper를 부르면 `fixture_unknown_key`로 거부된다.
- **⑥ P3 문서 정정**: 로드맵의 "REQUEST_CHANGES 두 번뿐"과 "세 번째 반영"이 서로 모순이었다.
  실제 이력은 **REQUEST_CHANGES 4회(리비전 1~4에 각 1회) · APPROVE 0회**이며 네 번째 리비전은 **재검토 대기**다.
  로드맵·WORKLOG·DECISIONS·CONTEXT_SUMMARY·CODEX_HANDOFF와 활성 V3 기준 문서 2건을 이 사실로 맞췄다.
- **검증 실측(offline, 이 리비전)**: `node --check`(.mjs 4종)·`npx tsc --noEmit -p tsconfig.json` 0건·
  `npm run build` PASS. focused `suiteExclusiveLock.test.ts` **54/54**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **353/353** + acceptance **71/71**
  (3회 모두 동일 카운트). 일반 suite가 전부 끝난 **뒤** `npm run acceptance:stress:m3d2` **1회 PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false}` (elapsed 109.5s).
  `git diff --check` clean, **git이 보는 파일 266건 전수 NUL 0**. 실행 후 lock/guard/격리 파일·m3d2 임시 디렉터리·
  잔존 fixture 프로세스 0(앞선 실패한 경합 테스트가 남긴 임시 디렉터리 1건은 원인을 고치고 제거했다).
- **비공허성(mutation) 9종**: O_NOFOLLOW 제거 / 바이트 상한 제거 / 옛 `lstat`+`readFileSync` 복원 /
  실패 분류 기본값을 옛 방식으로 되돌림 / lock unlink 오류 무시 / guard unlink 오류 무시 / base record 검사 제거 /
  발행 신원 확인 제거(54건 중 **40건 실패**) / 그룹 대신 child만 kill — 모두 해당 테스트가 실패함을 확인한 뒤
  **전부 원복**(원복 후 파일 해시 일치 확인). 첫 시도의 CLI 기반 경합 테스트는 시도 횟수가 적어 옛 로더를 잡지
  못했으므로, 로더를 **in-process로 수천 번** 호출하는 형태로 바꿔 옛 구현이 교체된 설정을 해석함을 재현했다.
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/push/fetch/pull/PR·
  패키지 설치·의존성 변경·네트워크·live runner 실행 없음. 워킹 트리는 계속 dirty(기존 dirty 변경 전부 보존).
- **잔여 위험(비차단)**: ① 격리 lock과 남은 guard는 사람이 수동 제거해야 풀린다(자동 회수 폐지의 대가).
  ② `ps lstart` 1초 해상도. ③ Linux는 procps 호환 `/bin/ps` 전제. ④ 신원 확인은 계약 밖 경로 교체를 탐지·중단하지만
  원복은 보장하지 않는다. ⑤ Node 18에는 `unlinkat`/디렉터리 상대 열기가 없어 "신원 확인 → unlink" 사이의 창을
  완전히 없앨 수 없다(같은 fd로 창을 줄이고 사후 탐지·fail closed로 막는다). ⑥ evidence 지표는 runner 판정의 파생값.
  ⑦ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.

## 2026-07-26 (V3 M3d.2 **세 번째 리비전** — 세 번째 fresh Codex Sol xhigh REQUEST_CHANGES 6건 수정 · **live 검증 여전히 pending**)

**세 번째 리비전이다.** lock 계약을 **format v2 + transition guard**로 확정하고, **stale/orphan 자동 회수 모델을 완전히
제거**했으며, 테스트 주입 seam을 **argv `--fixture-config` 하나**로 통일했다.
**live acceptance 3종은 여전히 미실행이므로 M3d 전체 완료도 M4 ready도 아니고, 어떤 리뷰 승인도 받지 않았다.**
아래 항목은 같은 날 "두 번째 리비전" 항목의 `.recovery` mutex·stale rename 회수 서술을 **대체**한다.

- **① 전이 TOCTOU 제거 — 모든 상태 전이는 crash-persistent `<lock>.guard` 안에서만 (`scripts/lib/suite-exclusive-lock.mjs`)**:
  종전 release/quarantine은 소유 확인(snapshot) 뒤 unlink/rename을 그대로 실행해, 그 사이 생긴 **새 소유 lock을
  지우거나 덮을** 수 있었다(양방향). 이제 acquire / release / quarantine / reentry 검증이 예외 없이
  `<lock>.guard`를 exclusive 발행한 프로세스만 수행하고, guard 안에서 **tokenHash → 격리 표시 → inode 신원** 순으로
  재확인한 뒤에만 파일을 만들거나 지우거나 덮는다. 다른 guard는 **절대 blind unlink하지 않는다**.
  guard가 이미 있으면 bounded 대기 후 거부하며 자동 제거·자동 인수는 없다. lock 파일 버전은 `v2`다(옛 record는
  `lock_unverifiable`).
- **② fail closed — 전이 메커니즘 실패·전이 중 SIGKILL은 guard를 남긴다**: quarantine write 실패, unlink 실패,
  신원 불일치, 예상 밖 예외, guard 보유 중 강제 종료는 전부 guard 파일을 남겨 **이후 모든 acquire를 거부**한다
  (`lock_transition_guard_present`, 사람이 확인 후 수동 제거). 반대로 **아무것도 바꾸지 않은 계약상 거부**
  (이미 보유 중 / 격리됨 / orphan / 형식 위반 / 동시 suite 감지 / 격리 상태 인지)는 no-op이므로 자기 guard를
  **nonce+inode로 신원 확인한 뒤** 정상 반납한다 — 한 번 겹쳐 실행한 것만으로 영구 수동 개입이 필요해지지 않게 한다.
- **③ stale/orphan 자동 회수 폐지**: `.recovery` mutex와 stale rename 회수 경로를 **코드에서 삭제**했다.
  소유자의 죽음은 "정리가 끝났다"는 증거가 아니므로(SIGKILL이면 소유 그룹 잔재가 남을 수 있다) 소유자가 죽은 lock은
  `lock_orphaned`로 **항상 거부**하고 사람이 확인 후 제거한다. 회수가 없으니 회수 mutex도 없다 —
  두 번째 리비전의 잔여 위험 ①(회수 mutex 크래시 창)은 원인 자체가 사라졌다.
  **lock 파일이 없어도 guard가 있으면 acquire는 우회 publish하지 않는다.**
- **④ 중첩(nested) 그룹 계약 정정 (`scripts/suite-lock.mjs`, `scripts/m3d2-stress-acceptance.mjs`)**:
  종전 wrapper는 재진입(nested) 상황에서도 child를 `detached`로 띄워 **상위 stress runner의 pgid 스캔에 잡히지 않는
  중첩 그룹**을 만들었고, 상위 timeout은 곧바로 그룹 SIGKILL이라 하위가 자기 정리를 끝낼 시간이 없었다.
  이제 standalone일 때만 detached(자기 그룹을 직접 정리·확인)하고, **nested면 그룹을 새로 만들지 않아 모든 자손이
  상위 소유 pgid에 남는다**. 상위 timeout도 **TERM → 8초 유예 → 생존 확인 → KILL**로 바꿔 하위 wrapper의 shutdown
  예산(유예 1.2s + 확인 3s)보다 짧지 않게 했다. 중첩 wrapper의 자기 child 소멸 확인 실패는 상위 lock을 token으로 격리한다.
- **⑤ production에서 테스트 env seam 제거 (`scripts/lib/fixture-config.mjs` 도입)**: lock 경로·`ps` fixture·
  pause/injection·evidence 디렉터리를 `process.env`에서 읽는 경로를 전부 없앴다(`HARNESS_LIVE_EVIDENCE_DIR` 포함 —
  `resolveEvidenceDir`는 이제 명시 인자 `overrideDir`만 받는다). env는 자손에 **암묵 상속**되어 셸에 export한 값이
  production 실행의 lock 경로·evidence 위치를 조용히 바꿀 수 있었다. 주입은 상속되지 않는
  **argv `--fixture-config <절대경로 .json>` 하나**뿐이며, 파일 크기(8KiB)·일반 파일·symlink 금지·절대경로·
  소비자 선언 allowlist key·타입/범위/enum을 엄격 검증한다(위반은 전부 fail closed). **임의 명령 실행 seam은 없다.**
  `HARNESS_SUITE_LOCK_TOKEN`만 남는데, 이것은 테스트 seam이 아니라 실제 부모→자식 ownership handoff 메커니즘이다.
  live runner 3종의 정상 사용자 명령은 fixture flag 없이 그대로 동작한다.
- **⑥ 경합·강제종료 회귀 테스트 보강**: `src/tools/suiteExclusiveLock.test.ts` **32 → 43건**.
  신규/교체 — release↔quarantine 양방향 인터리빙 2건, **release 전이 중 lock 교체**(다른 소유자 token / 동일 내용·
  다른 inode) 2케이스, **전이 중 SIGKILL → lock+guard 잔존 → 이후 suite·stress 거부**, quarantine write 실패 →
  guard 잔존, guard 존재 시 lock 없어도 acquire 거부, **guard 소유권**(nonce 불일치 / inode 교체 시 제거 금지) 2케이스,
  orphan(죽은 pid·pid 재사용) 자동 회수 금지, 옛 v1 record 거부, 중첩 자손 정리 3건.
  옛 env seam 테스트는 **"production은 env를 해석하지 않는다"** 검증으로 교체했다(옛 이름을 전부 심어도 테스트
  모드 거부 + 그 경로에 아무 파일도 만들지 않음 + production 소스에 이름 잔재 없음).
  `src/tools/liveEvidence.test.ts`는 evidence 위치 override를 argv fixture로 바꾸고, **env decoy 경로를 함께 심어도
  거기에 아무것도 쓰지 않으며 콘솔에 경로가 노출되지 않음**을 PASS 경로에서 확인한다(23 → 24건).
  **비공허성(mutation으로 확인 후 원복)**: unlink 직전 재확인 제거 → 교체 lock 삭제 재현(실패), guard blind unlink →
  남의 guard 제거 재현(실패), nested child `detached:true` → 중첩 3건 전부 실패, timeout 즉시 SIGKILL →
  하위 shutdown 미완 재현(실패).
- **검증 실측(offline, 이번 세션)**: `node --check`(변경 .mjs 4종) PASS, `tsc --noEmit` 0, `npm run build` PASS,
  `git diff --check` clean, **git이 보는 파일 266건 전수 스캔 NUL 0**.
  focused `liveEvidence.test.ts` **24/24**, `suiteExclusiveLock.test.ts` **43/43**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** — 2·3회차 실측 = exec **75/75** + core **342/342** +
  acceptance **71/71**, 1회차는 캡처 tail에 acceptance **71/71 / ALL PASS**만 남았다(`test:inner`가 `&&` 체인이라
  exec·core 통과 없이는 acceptance에 도달하지 않는다).
  모든 일반 suite가 끝난 **뒤** stress `npm run acceptance:stress:m3d2` **1회 PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false,"shutdownReason":"normal"}`
  (elapsed 89.6s). 실행 후 공용 lock/guard/격리 파일·m3d2 임시 잔재·잔존 fixture 프로세스 **0**.
- **live runner는 이번 세션에서도 실행하지 않았다(pending).** commit/push/fetch/PR/패키지 설치/네트워크 없음,
  `develop` / HEAD `af0552e` 불변, 기존 dirty 변경 전부 보존.
- **잔여 위험(비차단)**: ① 격리된 lock과 남은 guard는 **사람이 수동 제거**해야 풀린다(자동 회수를 없앤 대가 —
  겹침 방지 우선). ② `ps lstart` 1초 해상도. ③ Linux는 procps 호환 `/bin/ps` 전제(미지원 시 fail closed).
  ④ inode/tokenHash 확인은 계약 밖 행위자의 경로 교체를 **탐지·중단**하지만 원복을 보장하지는 않는다.
  ⑤ evidence 경로 TOCTOU 완전 제거 불가(Node 18 한계, 첫 리비전 P2-5 그대로).
  ⑥ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.
- **다음**: 사용자가 live runner 3종 실행 → evidence 3건 확인 → **fresh Codex 최종 재검토** → 그때 M3d 완료 판정.
  **현재 승인된 리뷰 결과는 없다. M4에 착수하지 않는다.**

## 2026-07-26 (V3 M3d.2 **두 번째 리비전** — 두 번째 fresh Codex Sol xhigh REQUEST_CHANGES 4건 수정 · **live 검증 여전히 pending**)

> **대체됨(2026-07-26 세 번째 리비전).** 아래 P1-3의 `.recovery` mutex·stale rename 회수 설계는 **삭제**되었다.
> 현행 계약은 transition guard + **자동 회수 없음(orphan은 항상 거부)**이다. 아래는 역사 기록이다.

**두 번째 리비전이다.** 앞선(첫 번째) 리비전의 lock/정리 설계에서 남아 있던 P1 3건과 문서 P2 1건을 구현으로 해소했다.
**live acceptance 3종은 여전히 미실행이므로 M3d 전체 완료도 M4 ready도 아니고, fresh Codex 최종 재검토도 아직 받지 않았다.**

- **P1-1 정리 확인 실패 시 lock 노출 금지 (`scripts/m3d2-stress-acceptance.mjs`)**: 종전에는 `cleanupConfirmed:false`를
  계산해 놓고도 lock을 **무조건 해제**했다 — 소유 worker·npm 그룹·자손이 남아 있을 수 있는 상태에서 다음 suite가
  lock을 이어받을 수 있었다. 이제 확인 성공 시에만 해제하고, 실패하면 해제 대신 lock을 **격리(quarantine)** 한다.
  격리된 lock은 소유자가 죽어도 stale 회수 대상이 아니라서(=`lock_quarantined` 거부) 잔재가 있을 수 있는 동안
  다른 suite/stress가 시작되지 못한다. 격리는 파일 write 1회라 **매달리지 않고 즉시 종료**한다(terminal exit 호환).
  `process.on("exit")`·반복 시그널 탈출 경로도 미확인 상태면 같은 격리를 적용한다. 요약에 `lockQuarantined` 추가.
- **P1-2 wrapper 종료 상태 기계 (`scripts/suite-lock.mjs`)**: 종전에는 시그널 경로가 child에 TERM/KILL을 보낸 **직후**
  lock을 해제했고(두 번째 시그널은 더 일찍), 정상 close 경로도 그룹 잔재를 확인하지 않고 해제했다.
  이제 normal close / spawn error / SIGINT / SIGTERM / 반복 시그널 / escalation 전부가 **비동기 idempotent bounded
  shutdown 상태 기계 하나**를 지난다: 소유 child 그룹만 TERM → 유예 → KILL → **그룹과 소유 pgid 자손 소멸을 bounded
  확인** → 확인 뒤에만 해제. 확인 실패·불가는 해제 대신 격리(fail closed)하며, **시그널 exit 의미(130/143)는 유지**한다.
  child는 detached라 상위 stress runner의 pgid 스캔에 잡히지 않는 중첩 그룹을 만들므로, 이 wrapper가 자기 그룹을
  직접 확인한다는 점을 코드·주석에 명시했다. 인자·설정 검증은 lock 획득 **전에** 끝내도록 옮겼다.
- **P1-3 stale 회수 신원 안전성 (`scripts/lib/suite-exclusive-lock.mjs`)**: 종전 `check → blind rename`은
  "A가 stale로 읽음 → B가 회수하고 live lock 생성 → A가 그 live lock을 rename" 경합으로 겹침을 허용했다. 세 겹으로 막았다.
  ① **회수 직렬화**: `<lock>.recovery`를 exclusive 발행한 프로세스만 회수 구간에 들어간다. 보유자가 살아 있으면
  bounded 대기 후 `lock_recovery_in_progress` 거부, 보유자가 죽었거나 확인 불가면 **자동 인수하지 않고**
  `lock_recovery_stalled` 거부(안전 > 편의 — 사람이 확인 후 수동 제거).
  ② **회수 구간 안에서 재읽기·재분류**: 대기 중 남이 만든 live lock을 여기서 `lock_held`로 잡는다.
  ③ **inode CAS**: fd `fstat`으로 (dev,ino)를 확보하고 rename 직전 `lstat`으로 동일 inode를 확인하며, rename은 원자적이므로
  **직후** 옮겨진 파일의 inode 재확인이 "그 inode를 옮긴 유일한 프로세스"라는 증명이 된다. 어긋나면 되돌린 뒤
  `lock_reclaim_identity_mismatch`로 실패하고 **절대 그 상태로 lock을 만들지 않는다**.
  더불어 lock 파일은 비공개 임시 파일에 전부 쓰고 `link()`로 발행하므로 **부분 write가 최종 경로에 남지 않는다**.
- **P2-4 문서 NUL 주장 정정**: "src/scripts/schemas/dist NUL 0"은 거짓이었다 — gitignore된 기존 `src/.DS_Store`에
  NUL 6,681바이트가 있다. WORKLOG·CODEX_HANDOFF·로드맵·CONTEXT_SUMMARY의 **현행 M3d.2 검증 문장만**
  "변경·추적 대상 텍스트 파일"로 정정했다(무관한 과거 항목은 건드리지 않았다).
- **테스트(회귀, 결정론적)**: `src/tools/suiteExclusiveLock.test.ts` **17 → 32건**. 추가 15건 —
  stress 정리 확인 실패 주입(격리·타 suite 획득 불가·무관 프로세스 무사·소유 worker는 정리),
  wrapper normal 잔존 자손 / spawn 실패 / SIGINT(130) / SIGTERM(143) / TERM 무시 자손 escalation /
  반복 시그널(143+격리) / 확인 불가(격리) / 확인 불가+시그널(143+격리),
  stale 회수 2-contender 인터리빙(먼저 회수한 live lock이 옮겨지지도 우회되지도 않음) / 조작 직전 inode 교체 거부 /
  회수 직렬화 / 중단된 회수 mutex 거부 / 격리 lock은 죽은 소유자여도 회수 금지 / 기록 실패 시 부분 기록 없음.
  주입 seam은 좁은 enum·절대경로만 받고 임의 명령 실행 경로를 만들지 않는다.
  **비공허성 확인**: 재분류를 끄면 2-contender 테스트가 실패하고(A가 B의 live lock을 탈취), inode 사후 확인을 끄면
  교체 거부 테스트가 실패한다는 것을 mutation으로 확인한 뒤 원복했다.
- **offline 검증(실행 결과)**: `npm run build` PASS, `git diff --check` clean,
  **git이 보는 파일 265건 전수 스캔 결과 NUL 0**(ignore된 `src/.DS_Store`는 범위 밖이며 NUL을 포함한다).
  focused `suiteExclusiveLock.test.ts` **32/32 PASS**.
  `npm test` **연속 3회 전부 PASS(직렬, 동시 실행 없음)** = exec **75/75** + core **330/330** + acceptance **71/71**.
  모든 일반 suite가 끝난 **뒤** stress `npm run acceptance:stress:m3d2` **1회 PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"ownedDescendantsAfterCleanup":0,"cleanupConfirmed":true,"cleanupProblems":0,`
  `"lockReleased":true,"lockQuarantined":false}` (elapsed 100.9s). 실행 후 공용 lock 파일·m3d2 임시 잔재 0.
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 이 리비전도 commit/fetch/push/PR/
  패키지 설치·의존성 변경·네트워크를 하지 않았다. 기존 dirty 변경은 전부 보존했다.
- **잔여 위험(비차단)**: ① 회수 mutex를 쥔 채 프로세스가 죽으면(마이크로초 창) 자동 stale 회수가 영구 거부되고
  사람이 `<lock>`·`<lock>.recovery`를 수동 제거해야 한다 — 겹침 방지를 우선한 의도적 선택이다.
  ② 격리된 lock도 사람이 지워야 풀린다(같은 이유). ③ `ps lstart` 1초 해상도.
  ④ Linux는 procps 호환 `/bin/ps` 전제(미지원 시 fail closed). ⑤ inode CAS 사후 확인은 계약 밖 외부 행위자가
  경로를 교체하는 경우 **탐지·중단**은 하지만, 이미 옮긴 파일을 되돌리지 못하는 극단적 3중 경합은 경고로만 남는다.
  ⑥ evidence 경로 TOCTOU 완전 제거 불가(앞선 리비전 P2-5 그대로). ⑦ 기존 이슈:
  `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다(이 리비전 범위 밖).
- **다음**: 사용자가 live runner 3종 실행 → evidence 3건 확인 → **fresh Codex 최종 재검토** → 그때 M3d 완료 판정.
  **현재는 승인받은 리뷰 결과가 없다. M4에 착수하지 않는다.**

## 2026-07-26 (V3 M3d.2 **리비전** — fresh Codex Sol xhigh REQUEST_CHANGES 6건 수정 · **live 검증 여전히 pending**)

**리비전 구현·offline 검증 완료. live acceptance 3종은 여전히 미실행이므로 M3d 전체 완료도 M4 ready도 아니다.**
아래 항목은 같은 날 이전 M3d.2 항목(그 아래)을 대체한다 — 특히 저장 프로토콜·stress 계약·테스트 카운트가 바뀌었다.

- **P1-1 부하 지속 보증(stress)**: 설정된 부하 worker **전부**의 spawn을 `spawn` 이벤트로 확인하고, `npm test`가
  닫힐 때까지 **전원 생존**을 요구한다. spawn 실패·정리 전 조기 종료·정리 전 error는 전부 FAIL이다(부하 없는 PASS 금지).
  부하 firm deadline > `npm test` wall-clock 상한을 **강제**한다(위반 시 exit 2) — 부하가 suite 전 구간을 덮는다.
  worker는 부모 소멸(ppid 변경) 시 스스로 종료해 고아로 남지 않는다.
- **P1-2 shutdown 상태 기계**: 비동기 idempotent 종료 경로 하나로 통일했다. 소유 npm 프로세스 그룹(TERM→유예→KILL)과
  자기 부하 worker만 종료하고, worker·그룹·소유 pgid 자손 소멸을 bounded 확인한 **뒤에** lock을 해제한다.
  normal/timeout/error/SIGINT(exit 130)/SIGTERM(exit 143) 전 경로가 같은 기계를 쓴다. timeout은 group kill이 실패해도
  실제 wall-clock 상한으로 확정되고, 정리 확인 실패·`ps` 확인 불가는 FAIL로 bounded하게 보고한다(pid·경로·argv 없음).
- **P1-3 공용 배타 lock**: 일반 `npm test`와 stress가 **같은 lock 하나**를 지난다
  (`scripts/lib/suite-exclusive-lock.mjs` + `scripts/suite-lock.mjs`). `npm test` = lock wrapper → `test:inner`
  (= `test:exec` → `test:core` → `acceptance.sh`, 순서·카운트·exit 의미 불변). stress가 띄운 자기 소유 `npm test`
  child만 추측 불가 32B ownership token으로 재진입한다(lock 파일에는 sha256만 기록 — 파일을 읽어도 재진입 불가).
  소유자 판정은 `pid + ps lstart`(PID 단독 신뢰 없음), stale lock은 `rename` 원자적 회수로만 처리해 경합을 제거했고,
  손상·버전 불일치·`ps` 확인 불가 lock은 회수하지 않고 거부한다(fail closed). `ps` 스캔은 backstop으로 남기되
  `npm test`/`npm run test:*`/`tsx|node --test`/`acceptance.sh`/stress/lock wrapper 탐지를 강화했다.
- **P1-4 evidence temp → atomic publish**: 같은 디렉터리의 **숨김 임시 파일**에 전부 쓰고 chmod·fsync·close·재검증
  (byte 동일 + 계약 재파싱)까지 끝낸 뒤 **exclusive hard link**로 최종 이름을 원자적으로 만든다(덮어쓰기 없음).
  쓰기 중 SIGKILL 크래시를 실제 child로 재현해 **최종 성공 산출물 이름의 잘린 파일이 생기지 않음**을 테스트했다.
  실패·정리 실패 시 발행분까지 신원 확인 후 되돌리고, publish 후 지원 플랫폼에서 디렉터리 fsync를 수행한다.
- **P2-5 symlink TOCTOU 완화 + 주장 축소**: 디렉터리·파일 dev+ino 신원을 보관해 publish 직전 재확인하고,
  정리 unlink도 신원 확인 후에만 한다(교체된 파일은 지우지 않고 실패로 보고). 잡아낸 정리 실패는 조용히 무시하지 않는다.
  Node 18에는 디렉터리 핸들 상대 열기가 없어 경로 기반 TOCTOU를 완전히 없앨 수 없다는 한계를 코드·문서에 명시했다.
- **P2-6 timestamp 판정 동치**: schema와 런타임이 같은 결정을 내린다 — `Z` 고정 UTC, 밀리초 3자리 선택,
  시 00-23·분·초 범위, 달력 실재성(2월 30·31, 4·6·9·11월 31, 비윤년 2월 29 거부), 연도 2000..2099
  (이 범위에서 윤년 = 4의 배수여서 정규식만으로 동일 판정이 가능). accept 6건/reject 28건 표로 동치를 강제하고,
  schema에 미지원 keyword가 추가되면 테스트가 실패한다.
- **offline 검증(실행 결과)**: `npm run build` PASS, `git diff --check` clean,
  **변경·추적 대상 텍스트 파일(tracked + ignore 제외 untracked)** NUL 0.
  (정정: 이 항목은 원래 "src/scripts/schemas/dist NUL 0"이라고 적었으나 사실이 아니다 —
  gitignore된 기존 `src/.DS_Store`에 NUL 바이트가 있다. 검증한 실제 범위는 git이 보는 텍스트 파일이다.)
  focused `src/tools/liveEvidence.test.ts` **23/23 PASS**, `src/tools/suiteExclusiveLock.test.ts` **17/17 PASS**.
  `npm test` **연속 3회 전부 PASS(직렬)** = exec **75/75** + core **315/315** + acceptance **71/71**
  (115.9s / 124.1s / 114.2s). 모든 일반 suite 종료 후 stress `npm run acceptance:stress:m3d2` **1회 PASS** —
  worker 4/4 spawn, suite 종료 시점까지 4/4 생존, elapsed 191.2s, `npmTestExitCode:0`, `cleanupConfirmed:true`,
  잔존 worker/자손 0, cleanup 문제 0, `lockReleased:true`. 실행 후 공용 lock 파일·m3d2 임시 디렉터리 잔재 0.
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 이 리비전도 commit/fetch/push/PR/
  패키지 설치·의존성 변경을 하지 않았다. 기존 dirty 변경(M3d.1·로드맵 편집 포함)은 전부 보존했고 `dist/tools/liveEvidence.js`는
  소스와 일치하게 재빌드했다.
- **잔여 위험(비차단)**: ① `ps lstart` 1초 해상도 — 같은 초에 pid가 재사용되면 신원이 겹칠 수 있다.
  ② Linux는 procps 호환 `/bin/ps` 전제이며 미지원 환경은 fail closed로 거부된다. ③ evidence 경로 TOCTOU는 완전 제거 불가.
  ④ evidence 지표는 runner 판정의 파생값이라 runner 판정이 틀리면 그대로 반영된다.
  ⑤ 관찰(이 리비전 범위 밖, 기존 이슈): `src/exec/permissionCompiler.test.ts:69`가 실행마다 `harness-perm-*`
  임시 디렉터리를 남긴다.
- **다음**: 사용자가 live runner 3종 실행 → evidence 3건 확인 → fresh Codex 재검토 → 그때 M3d 완료 판정.
  **그 전에는 M4에 착수하지 않는다.**

## 2026-07-26 (V3 M3d.2 — redacted live evidence 영속화 + stress acceptance 구현 · **live 검증 pending**)

**구현·offline 검증 완료. live acceptance 3종은 아직 실행하지 않았으므로 M3d 전체 완료도 M4 ready도 아니다.**

- **신규 계약**: `schemas/live_evidence.schema.json` + `src/tools/liveEvidence.ts`(수동 closed validator, 신규 의존성 0).
  evidence 허용 필드는 정확히 `version`/`contract`/`status`/`timestamp`/`metrics` 5개이며, `metrics`는 runner별
  **discriminated 계약**의 exact key 집합(0..1,000,000 정수 또는 boolean만)이다. 모든 객체 레벨에서 unknown key를 거부한다.
  `status`는 `"pass"` 고정 — **성공 전용**이라 실패·스킵·미실행 run은 evidence를 남기지 않는다.
- **금지 필드**: raw transcript, tool/MCP 입출력, argv, 명령, 파일 경로, hostname/user, PID, session/call/request ID,
  환경변수·secret 참조/값, config 본문, free-form error/message는 key 이름 조각 스캔으로 **먼저** 거부한다.
  redaction 마커(`***`)로 치환해도 통과하지 않는다.
- **backstop(defense in depth)**: 영속화 직전 기존 `redactSecrets`/`collectSecretValues`로 직렬화 텍스트를 재검사한다.
  secret 값·credential 형태·예상 외 문자(`/ \ $ =`)가 있으면 **가리고 저장하지 않고 쓰기를 거부**한다. 검증은 fail-closed 유지.
- **저장 계약**: `docs/evidence/m3d2`에 성공 1건당 파일 1개(`<contract>-<UTC compact ts>-<nonce>.json`),
  디렉터리 0700 / 파일 0600, exclusive create(`wx`)로 덮어쓰기 없음, symlink·비디렉터리 대상 거부(대상 + bounded 상위 검사),
  실패 시 부분 산출물 제거. 경로는 내부 반환값이며 payload에 담지 않고 콘솔에도 출력하지 않는다.
- **runner 통합**: 최종 live runner 3종(`m3a-live-preflight`, `m3b2-live-handoff`, `m3c3b-live-handoff`)만 통합했다.
  기존 opt-in 가드·fail-closed·cleanup·PASS 의미를 유지하고, **모든 계약 검사 + 정리가 성공한 뒤에만** evidence를 기록한다.
  evidence 기록 실패는 runner 실패(exit 1)다. live runner는 계속 opt-in이며 `npm test`에서 실행되지 않는다.
- **stress acceptance**: `scripts/m3d2-stress-acceptance.mjs` + `npm run acceptance:stress:m3d2`(narrow script).
  bounded CPU worker(기본 4, firm deadline 900s) 아래에서 `npm test`를 **1회 직렬** 실행한다. 배타 lock + `ps` 스캔으로
  다른 suite/stress와 겹치면 거부(fail-closed)하고, 자신이 만든 child만 성공·실패·시그널 어느 경로에서도 정리한다.
  `ps` 스캔은 실행 파일(node/npm/sh 계열)로 후보를 좁힌다 — argv에 테스트 명령 문자열만 담은 무관한 프로세스를
  동시 실행으로 오판하지 않기 위함(M3d.1 loose matching 교훈).
- **offline 검증(실행 결과)**: `npm run build` PASS, `git diff --check` clean, NUL 바이트 0.
  `src/tools/liveEvidence.test.ts` 단독 **16/16 PASS**(계약별 valid, unknown/누락/wrong-type/nested extra 거부,
  금지 필드 거부·미기록, secret 값·credential 형태 미영속화, 0700/0600 생성, exclusive-create 충돌, symlink/비디렉터리 거부,
  쓰기 실패 시 잔재 0, schema↔validator 동기, runner offline smoke, **offline fake claude로 m3a PASS 경로 evidence 1건 실증**).
  `npm test` **연속 3회 전부 PASS** = exec 75/75 + core **291/291** + acceptance 71/71(직렬 실행).
  stress `npm run acceptance:stress:m3d2` **PASS** = 부하 worker 4개 하에서 동일 카운트, elapsed 85.6s,
  `npmTestExitCode:0`, `loadWorkersAliveAfterCleanup:0`, `cleanupProblems:0`.
- **live acceptance는 pending**: M3b.2는 사람 대화형 터미널(TTY)을 요구하므로 이 세션에서 실행하지 않았다.
  사용자가 아래를 순서대로 실행해 evidence 3건을 생성해야 M3d 완료를 판정할 수 있다.
  ```bash
  npm run build && HARNESS_LIVE_M3A=1   node scripts/m3a-live-preflight.mjs
  npm run build && HARNESS_LIVE_M3B2=1  node scripts/m3b2-live-handoff.mjs    # TTY 필수, 대화형
  npm run build && HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs   # TTY 필수, npx shadcn 네트워크
  ```
- **Git 관찰**: 브랜치 `develop`, HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74`(불변).
  **이번 M3d.2 작업도 commit/fetch/push/PR/패키지 설치를 하지 않았다.** 워킹 트리는 계속 의도적으로 dirty하며,
  기존 dirty 변경은 모두 보존했다. `dist/`는 이 레포에서 커밋 대상이므로 빌드 산출물 `dist/tools/liveEvidence.js`가
  새 untracked 파일로 생겼다(live runner가 dist에서 import한다).
- **잔여 위험(비차단)**: ① 상위 경로 symlink 검사는 bounded(4단계) — 시스템 prefix(macOS `/var` 등)는 대상이 아니다.
  ② `docs/evidence/m3d2`는 첫 성공 live 실행 때 생성된다(현재 미존재). ③ stress `ps` 스캔은 여전히 command line 기반
  heuristic이라 비정상적으로 위장한 suite는 감지하지 못한다(배타 lock이 1차 방어). ④ evidence 지표는 runner가 이미
  판정한 파생값이므로 runner 판정 자체가 틀리면 evidence도 그 판정을 반영한다.
- **다음**: 사용자가 live runner 3종을 실행 → evidence 3건 확인 → fresh Codex가 diff/test/evidence schema 독립 검토 →
  그때 M3d 전체 완료 판정. **그 전에는 M4에 착수하지 않는다.**

## 2026-07-26 (V3 M3d.1 — M3c-2 live runner 소유권 판정 안정화, 완료 · Codex Sol xhigh APPROVE)

**M3d.1 완료. fresh Codex Sol xhigh 최종 검토 verdict = APPROVE. M3d 전체는 아직 미완료다.**

- **원인**: M3c-2 live runner가 baseline 이후에 등장한 `shadcn@4.13.1 … mcp` 매칭 프로세스를 전부
  자기 잔여물로 간주했다. 그래서 무관한 동시 실행 프로세스가 있으면 거짓 실패(false failure)가 났다.
- **수정 범위**: `scripts/m3c2-live-read-semantics.mjs`, `src/tools/shadcnReadSemanticsProbe.test.ts` 두 파일뿐.
  production src(runner 대상 코드)·registry·package 파일은 수정하지 않았다.
- **소유권(ownership) 판정**: runner의 **프로세스 트리 자손**이거나 **cwd가 runner의 임시 base 하위**일 때만 소유로
  본다. baseline 이후에 생겼더라도 그 base 밖의 진짜 독립 sibling은 foreign으로 보고 무시한다.
  검사 자체가 불가능한 unknown은 **fail-closed 유지**이며, 절대 kill하지 않는다.
- **식별 방식**: process baseline과 재검증은 PID 단독이 아니라 **pid + `ps lstart`** 조합으로 한다(PID 재사용 방지).
  후보 argv는 로그에 남기지 않고, 진단에는 pid·ownership·**run별 salt를 섞은 SHA-256 signature**만 쓴다.
- **테스트 sleeper**: TTL을 둬 무한 잔존을 막고, 정리는 child handle 또는 nonce로 신원을 확인한 orphan에 대해서만
  수행하며 종료를 bounded하게 확인한다. **PID만 보고 신호를 보내는 경로는 없다.**
- **최종 리비전 후 검증**: `git diff --check` clean, NUL 바이트 0, `npm run build` PASS,
  해당 파일 단독 **18/18 PASS 2회**, `npm run test:core` **275/275 PASS**,
  격리 실행 `npm test` PASS = exec **75/75** + core **275/275** + acceptance **71/71**.
- **중간 실패 1건과 교훈**: 앞선 겹친 검증 1회가 실패했는데, 원인은 fresh 리뷰어와 메인 스위트가 **동시에**
  전역 m3c2 temp/process 상태를 관찰한 것이었다. 격리 재실행은 PASS. 오케스트레이션 교훈 —
  **프로세스 전역 또는 tmp 전역 상태를 관찰하는 테스트는 명시적 exclusive resource class/lock이 필요하며
  동시 실행하면 안 된다.** 이를 M4 durable-state/scheduler 계약과 M5 bridge 실행 요건으로 로드맵에 기록했다.
- **M5 추가 요건(Claude bootstrap 실측에서)**: 진행/이벤트 스트리밍, no-progress·wall-clock **bounded deadline**,
  cancellation, descendant cleanup. **최종 결과만 내는 silent session은 허용하지 않는다.**
- **Git 관찰**: 브랜치 `develop`, HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74`,
  로컬 `origin/develop`도 동일 커밋(remote-tracking reflog: 2026-07-26 13:48:21 +0900 push로 갱신).
  **이번 M3d.1 작업은 commit/fetch/push를 하지 않았다.** 워킹 트리는 의도적으로 dirty하다 —
  앞선 docs-only 로드맵 편집 + M3d.1 구현 파일 2개, 그리고 자율 오케스트레이션 로드맵 문서는 여전히 untracked.
  **clean이 아니다.**
- 환경: Claude Code 관찰 버전 `2.1.220`.
- **잔여 위험(비차단)**: `lstart`는 1초 해상도다. 대상 Linux는 procps 호환 `/bin/ps`를 전제하며,
  지원되지 않는 환경의 inspection은 fail-closed된다.
- **다음**: 남은 M3d 범위 — redacted persistent live-evidence schema/테스트 + 로드맵의 반복 full-suite/stress
  acceptance. **별도 상세 계획과 승인이 필요하다. M4 ready 아님.**

## 2026-07-26 (M3d~M10 자율 오케스트레이션 로드맵 재정렬, docs-only)

**사람이 Codex↔Claude Code 사이의 프롬프트·완료보고·권한요청을 수동 전달하는 병목을 제거하기 위한
자율 오케스트레이션 로드맵을 활성화했다. 실행 코드·패키지·registry는 수정하지 않았다.**

- 신규: `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`.
- 활성 우선순위: 새 로드맵 > MCP/ToolProfile 설계 > Design/Learn/Progress/Handoff 설계.
- 중앙 장기 LLM 세션 대신 deterministic kernel+disk state, bounded snapshot, fresh Coordinator/Worker/Reviewer.
- 통신: 공통 envelope, type별 Markdown template, artifact revision/SHA-256, orchestrator-mediated routing.
- 자동화: M5에 CodexCliProvider+기존 ClaudeCliProvider bridge와 milestone approval manifest/autopilot.
  M5 통과 후 M6부터 plan→implement→test→fresh review→revise→verify 전달 자동화.
- 모델: Claude Code Opus=개발, Codex `gpt-5.6-sol` xhigh=큰 계획·문서 비평·독립 검토.
- hard deny·마일스톤 승인·기존 5-step 엔진/exec 계층 재사용 원칙 불변.
- 검증: `develop`/`af0552e`, origin 동일, clean, Claude 2.1.220, Codex CLI 0.146.0-alpha.3.
  exec 75 PASS, acceptance 71 PASS. core 전체 부하에서 known M3c-2 smoke flake 1건(272/273),
  해당 테스트 파일 단독 16/16 PASS. M3d에서 테스트 완화 없이 안정화 예정.
- 다음: M3d 상세 구현 계획 → 사용자 승인 → Claude Code Opus 구현 → fresh Codex 검토.

## 2026-07-24 (V3 M3c-3b — actual live acceptance PASS · V3 M3 전체 완료)

**filtered shadcn read handoff의 actual live acceptance가 PASS. offline+actual live 완료. dead helper 정리 + 단일 커밋 마무리.**

- **live 실측(Claude Code 2.1.218, `HARNESS_LIVE_M3C3B=1` 수동 runner)**: runner **exit 0 / PASS**.
  - preflight snapshot: server 정확히 `shadcn` **connected** + tools 정확히 **host 5개**(원본 7개 중 금지 2개 `get_add_command_for_items`·`get_audit_checklist` **미노출**·ambient canary 부재).
  - generated mcp-config: `command=process.execPath`, `args=[PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js]`, launcher/npx 직접 실행 필드 없음. **config 파일 sha256 == snapshot.configHash == outcome.handoff.config_hash == run_state.handoff.config_hash**, snapshot_path 3중 일치.
  - interactive argv: allowedTools 정확히 5개·disallowedTools 정확히 금지 2개·`mcp__*` 전체 deny 없음·`-- <initialPrompt>`·`-p`/stream-json 없음.
  - ToolTrace: **records 25 / MCP tool_requested 3 / session_end 1**, profileId=handoff-shadcn-readonly, 호출 3개(get_project_registries·search_items_in_registries·view_items_in_registries) 각각 requested/succeeded **동일 callId** correlation·server=shadcn, **permission_requested/tool_failed/tool_denied 없음**(preapproved 자동 실행 확인), **sanitizedInput 지시 인자 정확 일치**, 금지 2개 미관측, raw MCP 결과·transcript_path·secret 평문 없음.
  - serviceCwd 파일 **무변경**, run_state **completed 불변**, runtime/tool-trace dir **0700** · config/snapshot/settings/trace **0600**, ambient MCP/Hook canary **미기동**, proxy·shadcn@4.13.1·canary **잔존 프로세스 없음**, 임시 디렉터리 **cleanup 완료**.
- **실패 이력(보존)**: ① 첫 live — protocol/startup interoperability 결함(downstream 버전 upstream 복사 + 초기화 응답을 attestation 이후로 지연)으로 `server_not_connected`. ② 두 번째 live — `status=pending`, Claude 2.1.218의 MCP connect deadline 기본 **5초**를 cold npx + attestation이 초과. ③ **blocking MCP env 0/45000/45000** 적용(proxy 30s < handshake 45s < preflight 60s) 후 **최종 PASS**.
- **dead helper 정리**: `mcpEnv.applyBlockingMcpEnv()`를 실제 단일 적용 함수로 사용 — preflight `buildChildEnv`는 `return applyBlockingMcpEnv(env)`, handoff shadcn profile은 `applyBlockingMcpEnv(baseEnv)` 결과를 spawn env로 전달. 직접 `Object.assign(BLOCKING_MCP_ENV)` 중복 제거. 기본 handoff는 baseEnv 그대로(불변). runner는 계약 검증용 `BLOCKING_MCP_ENV` import 유지.
- **상태**: M3c-3b = **offline + actual live 완료**. M3a(non-empty MCP strict 격리 live) · M3b.2(empty MCP 대화형 Hook live) · M3c-3b(filtered shadcn read handoff live) acceptance 모두 충족 → **V3 M3 전체 완료**. 다음 단계(예: 활성 read 도구 확대·Tavily/Research adapter M4)는 별도 계획 검토로만 기록(구현 미착수).
- 검증: build/tsc(0)/node --check runner/git diff --check/npm pack dry-run/secret·runtime 스캔. exec 75 + core 273 + acceptance 71.

## 2026-07-24 (V3 M3c-3b — 두 번째 live P0: blocking MCP 연결 env 강제)

**두 번째 live도 `server_not_connected`(status=pending). 원인: Claude Code 2.1.218 `MCP_CONNECT_TIMEOUT_MS` 기본 5000ms인데 filtered proxy의 cold npx + exact-7 attestation이 5초 초과 → system/init 시점 pending. 동일 live 재시도 안 함. 실제 Claude/network 미실행.**
- **단일 출처 helper**: `src/tools/mcpEnv.ts` 신규 — `BLOCKING_MCP_ENV = { MCP_CONNECTION_NONBLOCKING:"0", MCP_CONNECT_TIMEOUT_MS:"45000", MCP_TIMEOUT:"45000" }`(+`applyBlockingMcpEnv`). 타임아웃 순서: proxy downstream startup 30000ms < Claude MCP handshake 45000ms < preflight hard timeout 60000ms (cleanup 여유).
- **preflight 배선**: `buildChildEnv`가 기존 allowlist·secret 격리·`ENABLE_TOOL_SEARCH`·auto-memory 유지하되, blocking MCP env를 **마지막에** `Object.assign`으로 강제 → ambient process.env·testEnv override 불가. hard timeout 60000ms·pending/failed/needs-auth 불성공·connected+exact tools만 성공 계약 유지.
- **interactive 배선**: handoff-shadcn-readonly profile 경로의 대화형 spawn env에만 blocking MCP env를 **마지막에** 강제(ambient override 불가). 기본 handoff(empty MCP, toolProfile 미지정) 경로는 이 env를 추가하지 않아 **기존 동작 불변**. argv·stdio inherit·Hook 계약 무변경.
- **테스트**: preflight child env 세 값 정확 + ambient/testEnv override 불가 + ambient 임의 변수 미전달(core 273). handoff-shadcn spawn env 세 값 정확 + ambient(1) override 불가. 기본 handoff env는 세 MCP 값을 강제하지 않음(ambient 그대로). 기존 pending/failed/needs-auth 불성공 테스트·protocol 두 leg·attestation·cleanup 테스트 전부 유지.
- **runner**: `BLOCKING_MCP_ENV` 계약 값(0/45000/45000)을 실행 전 사후 확인(불일치 시 exit 2). pending retry/성공 처리 로직 미추가. actual live 미실행.
- 검증: build/tsc(0)/node --check runner/opt-in 없음 exit2/opt-in+非TTY exit2/git diff --check 클린/rg override 0. exec 75 + core 273 + acceptance 71.
- **live 재실행은 사람 승인 후 수동(보류). 이번 수정으로 handshake 타임아웃(5s→45s) 원인 제거.**

## 2026-07-24 (V3 M3c-3b — MCP proxy interoperability P0: protocol 분리 + 초기화 응답 지연 제거)

**live에서 preflight가 `server_not_connected`로 실패한 원인을 수정. 동일 live 재시도는 안 함. 실제 Claude/network 미실행.**
- **P0-1 protocolVersion 두 leg 분리**: `shadcnReadMcpProxy`가 downstream 협상 버전을 upstream initialize 응답에 복사하던 것을 제거. upstream initialize의 `params.protocolVersion`을 검증(missing/비문자열/미허용 → `-32602` fail-closed, tools 미노출)하고 **요청받은 허용 버전을 그대로** 반환. downstream은 기존 `REQUEST_PROTOCOL_VERSION`으로 별도 협상, `upstreamProtocolVersion`/`downstreamProtocolVersion` 별도 상태. initialize·initialized 이전 tools/list·tools/call 금지 유지.
- **P0-2 초기화 응답 지연 제거**: downstream initialize + tools/list exact-7 검증 완료 후에야 upstream listener를 시작하던 구조를 바꿔, **downstream spawn 직후 upstream listener 즉시 시작**. upstream initialize는 downstream 검증과 독립적으로 즉시 응답. downstream attestation은 별도 bounded Promise(`runAttestation`)로 수행하고, **tools/list·tools/call은 attestation exact-7 통과 전 성공 응답 금지**(pending은 startup timeout 안에서 bounded wait). attestation 실패 시 restricted 5개를 절대 노출하지 않고 연결 종료(`rejectStartup`) → main non-zero + downstream 그룹 종료 + HOME/cache cleanup. `upstream_end` 성공 종료는 attestation 완료(pass)까지 defer해 실패가 성공으로 가려지지 않게 함. queue/request/output 상한·signal 즉시 종료 계약 유지.
- **회귀 테스트(proxy 26→32)**: downstream=2025-11-25인데 upstream이 각 허용 구버전 요청 → 응답=요청 버전, unsupported/missing pv → fail-closed·tools 미노출, downstream initialize 2s 지연에도 upstream initialize <500ms, 지연 downstream에서 tools/list는 attestation(≥600ms) 후에만 bare 5, 지연 attestation 실패 → initialize 이후에도 tools/list 성공 없음·reject·cleanup, pending attestation 중 abort 즉시 signal 종료·HOME cleanup. `toolsMismatch` 테스트는 새 계약(초기화 응답 허용·tools 미노출·reject)으로 정정. 금지 2·입력 필터·result budget·fatal/session·기존 exec SIGINT/SIGTERM(이제 pending-attestation 신호 경로) 전부 유지.
- **runner 진단(§4)**: `preflight_failed` 시 scrub된 `outcome.message`(status 포함) 출력, raw init/stderr/result 미출력, 성공/실패 로그의 `claudeBin`도 `redact()` 적용.
- 검증: build/tsc(0)/node --check runner/opt-in 없음 exit2/opt-in+非TTY exit2/git diff --check 클린/rg override 0. exec 75 + core 271 + acceptance 71.
- **live acceptance는 여전히 사람 승인 후 수동 실행(보류). 이번 수정으로 preflight의 upstream 협상·연결 타임아웃 원인은 제거.**

## 2026-07-24 (V3 M3c-3b — live runner 거짓 PASS 차단 보완, runner-only)

**`scripts/m3c3b-live-handoff.mjs`만 보완(production 범위 확장 없음). 실제 live·commit 없음.**
- **preapproved 실측 강화**: 계획된 3개 각각 tool_requested 정확히 1개 + 동일 callId tool_succeeded, 동일 callId에 tool_failed/tool_denied 없음, sanitizedInput이 지시 인자와 정확 deepEqual, preapproved 3개에 permission_requested 한 건이라도 있으면 FAIL(수동 승인이 `--allowedTools` 실패를 가리는 것 차단), 계획 외 `mcp__*` tool_requested 있으면 FAIL.
- **잔존 프로세스 fail-closed**: runHandoff 전 proxy/shadcn 후보 baseline 수집(ps 실패 시 실행 시작 전 exit 2). TUI 종료 후 최대 5초 grace polling → 새 후보만 대상, lsof cwd로 임시 base ownership 확인. ps/lsof 실패·ownership 미확인은 **kill 없이 FAIL**, owned만 kill + 실제 사망 확인. cleanup 백스톱도 검사 실패를 숨기지 않고 기록.
- **claude --version 안전장치**: 명시적 env allowlist(PATH/HOME/USER/SHELL/TMPDIR/TMP/TEMP/LANG + 표준 LC 카테고리만; TOKEN/KEY/SECRET/PASSWORD/AUTH·임의 LC_* 금지), timeout 10s·maxBuffer 64KiB, error/signal/stdout/stderr redaction, 실패 시 preflight/TUI 미실행 exit 2.
- **artifact 연결 검증**: mcp-config를 `{mcpServers:{shadcn:{command:process.execPath,args:[고정 proxy],alwaysLoad:true}}}`로 exact deepEqual, mcp-config 파일 sha256 == snapshot.configHash == outcome.handoff.config_hash == run_state.handoff.config_hash 전부 동일, snapshot status 정확히 `"connected"`(정규식 아님), snapshot_path outcome==run_state==실제 경로.
- offline: build/tsc(0)/node --check/opt-in 없음 exit2/opt-in+非TTY exit2/git diff --check 클린. exec 75 + core 265 + acceptance 71(runner는 production 미변경 → 카운트 불변).
- **live acceptance는 여전히 사람 승인 후 수동 실행(보류).**

## 2026-07-24 (V3 M3c-3b — 마지막 P1 정리 + 전용 live acceptance runner)

**live 직전 P1 정리 + 전용 runner 준비. 실제 Claude/npx/network/TUI·commit 없음.**
- **P1 정리(claudeCodeMcpAdapter.ts)**: launcher 혼합 검사를 `(decl.args && decl.args.length>0)`→`decl.args !== undefined`로(빈 배열 `args:[]`도 mixed_launcher 거부, buildMcpConfig 직접 호출 포함). adapter 내부 중복 `TRUSTED_LAUNCHERS` Set 제거 → `profiles.ts`의 `TRUSTED_LAUNCHER_IDS` **단일 출처** 사용(`isTrustedLauncher`). 테스트: launcher+args:[]→mixed_launcher, launcher ID 단일 출처 불변(목록 값 통과·목록 밖 unknown_launcher).
- **전용 live runner 신규**: `scripts/m3c3b-live-handoff.mjs`(m3b2 안전장치·임시 workspace 방식 재사용). 게이트: `HARNESS_LIVE_M3C3B=1` 없으면 exit 2·非TTY exit 2·`claude --version`(semver) 실패 exit 2. 시작 전 구독 사용량 + `npx --yes shadcn@4.13.1 mcp` 네트워크 가능성 출력. production/remote/deploy/billing 미접촉, 모든 파일 `$TMPDIR/m3c3b-live-*`, signal/finally cleanup, npm test/CI 자동 실행 없음.
- **runner 시나리오**: 임시 HARNESS_WORKSPACE+service repo에 completed run_state + planning 문서 생성 → production `runHandoff({ toolProfileId:"handoff-shadcn-readonly" })` seam 없이 실행(실제 preflight+TUI). serviceCwd custom registry 없음, ambient `.mcp.json` MCP canary + `.claude/settings.json` Hook canary 추가(strict 격리 시 미기동). 대화형 지시: 계획 승인 → get_project_registries → search(button,limit1) → view(@shadcn/button) → 파일 수정 없이 /exit, 금지 2개 미호출.
- **PASS 조건**: runner exit 0 + preflight snapshot(shadcn/connected·host 5개·원본7/금지2/canary 부재) + config(node+고정 proxy·launcher/npx 없음) + argv(allowed5·denied2·mcp__* 없음·`-- prompt`·-p/stream-json 없음) + ToolTrace(profileId·MCP server=shadcn·requested/succeeded correlation·session_end 1·금지2 미관측·raw/transcript/secret 없음) + serviceCwd 무변경 + run_state completed 불변 + handoff record(tool_profile_id/config_hash/snapshot_path) + 권한(dir700/file600) + ambient canary 미기동 + proxy/shadcn/canary 잔존 프로세스 없음(lsof cwd ownership 확인 후에만 kill) + cleanup 완료. 실패 처리: preflight 실패 시 TUI 미실행, canary/금지 도구/trace 불일치 FAIL, cleanup 실패 숨김 금지, 결과 원문 미출력.
- offline 검증: build/tsc noEmit(exit 0)/node --check runner/opt-in 없음 exit 2/opt-in+非TTY exit 2/git diff --check 클린. exec 75 + core 265 + acceptance 71.
- **live acceptance는 여전히 사람 승인 후 수동 실행(보류).**

## 2026-07-24 (V3 M3c-3b — actual live 전 P0/P1 하드닝)

**M3c-3b offline 배선의 P0/P1을 보완. live 전 필수 하드닝만, 최소 수정. 실제 Claude/npx/network/TUI·commit 없음.**
- **P0-1 launcher 실행 경로 override 완전 제거**: `BuildMcpConfigOpts.proxyPath`·`buildMcpConfig(...opts)`·`writeMcpConfig(...opts)`·`RunPreflightOpts.launcherProxyPath`·`HandoffOptions.launcherProxyPath` 및 전달 코드 삭제. `shadcn_read_proxy`는 항상 `command=process.execPath, args=[fromPackage("dist","tools","shadcnReadMcpProxy.js")]` **고정** — 인자·env·profile·test seam으로 변경 불가. 파일 검증은 실행 경로와 분리된 `verifyTrustedProxyFile(path)`로 추출(테스트는 이 함수만 임시 경로로 호출, 임시 경로가 generated config에 들어가는 API 없음). `rg "launcherProxyPath|proxyPath" src dist` = 0.
- **P0-2 secretRefs 정확 계약 + 방어 심층화**: `assertShadcnReadonlyContract`에 secretRefs 정확히 `[]`·allowedDomains 정확히 `[]`·server own key 정확히 `{name, launcher}`(args는 빈 배열이어도 존재 거부) 추가. launcher profile이 secretRefs를 하나라도 선언하면 `buildMcpConfig`에서 `launcher_secret_refs_forbidden`으로 config·preflight·spawn 전에 거부(오류에 secret 값 미노출). 변조 재현: handoff-shadcn-readonly에 secretRefs 주입 + 실환경 sentinel → profile_rejected, preflight/spawn/runtime 0, 로그·오류 sentinel 평문 0.
- **P1-1 runtime server validator**: `profiles.ts`에 `validateServer` 신설(단순 cast 제거). launcher/stdio/http/bare(name만, M2 호환) 분류별 강제 — launcher는 {name,launcher}만·shadcn_read_proxy만, stdio는 command 필수·args string[]·launcher/url 금지, http는 HTTPS·command/args/launcher 금지, unknown key·unknown launcher·mixed transport·bad transport는 로드 단계 ToolProfileError. `McpServerDecl.launcher`를 `"shadcn_read_proxy"` literal로 제한. `schemas/tool_profile.schema.json` server를 additionalProperties:false + launcher/stdio/http/bare oneOf로 runtime과 일치. 기존 stdio/http/bare profile 동작 유지.
- **P1-2 symlink 거부**: `verifyTrustedProxyFile`을 `statSync`→`lstatSync` 기반으로 — symlink는 `launcher_proxy_symlink`로 거부, 일반 파일만·읽기 가능만. symlink 테스트 추가.
- 추가 확인: profile 미지정 handoff 경로 완전 불변, allowed 5/denied 2/exact snapshot 유지, runWorkflow MCP fail-closed 유지, 기존 테스트 삭제·완화 없음.
- 검증: build/tsc noEmit exit 0, exec 75 + core 264 + acceptance 71, git diff --check 클린, `rg` override 0건.
- **live acceptance는 여전히 보류**(실제 Claude+shadcn stdio proxy 필요). 이번 단계는 P0/P1 하드닝만.

## 2026-07-23 (V3 M3c-3b — filtered shadcn read profile offline 배선)

> **정정(2026-07-24 P0-1):** 아래 최초 배선에는 `launcherProxyPath`(테스트/live) 실행 경로 override seam이 있었다. 이는 P0-1에서 **완전히 제거**되어 이제 proxy 실행 경로는 `PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js`로 고정이며 외부에서 바꿀 수 없다. 아래 서술 중 launcher override 관련 부분은 상단 2026-07-24 항목으로 대체된다.

**M3c-3a filtered proxy를 handoff profile로 offline 배선. 실제 Claude/npx/network/TUI·commit·push 없음.**
- **ToolProfile 등록**: `registry/tool_profiles.json`에 `handoff-shadcn-readonly`(capability component_registry_read / mcp binding server shadcn / bare 5개 / preapproved 5 host / denied 2 host / approval_write / calls6·resultChars8000·elapsed60000 / source official).
- **신뢰된 launcher**: `McpServerDecl.launcher`(schema enum `shadcn_read_proxy`) 추가. registry엔 절대경로·npx 없이 논리 식별자만. runtime config 생성 시에만 `command=process.execPath, args=[PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js]`로 변환(`claudeCodeMcpAdapter.compileLauncherServer`). command/args/url/transport 혼합·unknown launcher 거부, config 기록 전 proxy 파일 존재·일반파일·읽기가능 검사, 생성 config에 launcher 필드 미포함. 기존 command/args/http 동작 불변.
- **handoff 연결**: `harness handoff --tool-profile handoff-shadcn-readonly`(파일럿은 이 id만 허용, 다른 profile fail-closed). `harness run … --handoff --handoff-tool-profile <id>`(workflow용 `--tool-profile`과 분리, runWorkflow MCP 가드 불변). `--print` 재진입 명령에 `--tool-profile` 보존.
- **실행 시퀀스(profile 경로)**: profile 로드+정확 계약 검증 → serviceCwd components.json 표준 registry 검사(custom/private/malformed/symlink이면 Claude·proxy 전 `registry_rejected`) → preflight(proxy config, emptyConfig=false) → shadcn connected + 정확한 5개 도구일 때만 통과 → 동일 config로 대화형 spawn(stream-json 미사용). preflight 실패 시 spawn·기록 금지.
- **interactive argv(profile)**: `--strict-mcp-config --mcp-config <proxy> --settings <hook> --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --allowedTools <host5> --disallowedTools <host2> -- <prompt>`. **profile 경로엔 `mcp__*` 전체 deny 없음**; 미지정 기본 경로는 기존 `mcp__*` deny 유지.
- **Hook/trace/preview**: profile 경로 Hook profileId=handoff-shadcn-readonly·toolMap 허용 5개→shadcn, preview에 profileId·server·허용5·금지2·상한 표시('MCP 없음' 문구 제거), secret 값·raw MCP 결과 미노출. HandoffRecord에 optional `tool_profile_id/config_hash/snapshot_path`. run_state status/completed 불변.
- **테스트**: adapter launcher 6종(config node+절대proxy·혼합·unknown·부재/디렉터리/읽기불가), handoffShadcn 통합(argv·toolMap·record·preview·profile_rejected·registry_rejected·preflight_failed·print·workflow 거부 유지) + 실 preflight fake-claude exact5 성공·누락/초과/금지 tool_mismatch. 기존 M3c-0/1/2/3a 불변 테스트는 "shadcn 미등록"→"shadcn profile은 handoff-shadcn-readonly(launcher)만·npx 미등록"으로 정정(삭제·완화 아님).
- 검증: build/tsc noEmit 클린, exec 75 + core 253 + acceptance 71, git diff --check 클린, build 후 dist 정합.
- **live acceptance는 보류**(실제 Claude 2.1.x + shadcn@4.13.1 stdio proxy 필요). 이번 단계는 offline 배선만.

## 2026-07-22 (V3 M3c-3a — signal P0 보완, M3c-3b 계획 검토 전 유지)

**startup/in-flight signal 즉시 종료 결함 보완.** fake PATH `npx` fixture만(실제 shadcn/network/Claude 미실행).
- **원인**: AbortSignal 리스너가 serve Promise 내부(startup 완료 후)에만 붙어, startup(initialize/tools/list) 또는 in-flight tools/call 중 signal이 오면 startupTimeout(30s)·perCallTimeout(60s)까지 대기해야 종료됐다. in-flight 종료도 processing 완료를 수동 대기했다.
- **보완**: runShadcnReadProxy를 단일 관리 Promise로 재구성해 **downstream spawn 직후부터** AbortSignal을 연결(이미 aborted면 즉시 처리). signal 수신 즉시 `ds.markDead("aborted")`로 downstream **process group 전체 종료 + pending 즉시 reject**(timeout 대기 없음), queue 폐기, child close 확인 후에만 HOME/cache 삭제. `main`은 SIGINT=130·SIGTERM=143로 종료(proxy_error/exit 1로 바꾸지 않음), 종료 후 stdout에 불완전 JSON/진단 미기록(writeMsg가 settled 후 무시).
- **리스너 수명/idempotent**: 완료 시 AbortSignal listener 제거, doResolve/cleanup은 settled 가드로 정확히 한 번(signal과 child close 경합에도 cleanup 1회). markDead가 pending timer를 clear → signal 뒤 timeout 콜백 재실행 없음.
- **downstream 응답 계약 위반 fatal 분류**: malformed line·bad jsonrpc·id mismatch·**result 비객체(ds_bad_result)**·stdout/stderr cap·timeout·조기 close → group 종료 fatal. 반면 **일반 JSON-RPC tool error(downstream error 응답)와 result budget/입력 정책 거부는 세션 유지**(그 호출만 거부, downstream 생존).
- **P1**: production `main`에서 `HARNESS_M3C3_TEST_CLEANUP_FAIL` env 백도어 제거. cleanup 실패는 `cleanupFaultForTest` 함수 인자 seam으로만 검증(직접 실행 경로에 env override 없음).
- **재현 테스트(추가 5, 총 26)**: [exec] startup initialize 무한 대기 → SIGINT ⇒ 3초 내 exit 130·child/grandchild 없음·`m3c3-home-*` 없음(실측 ~8ms). [exec] in-flight tools/call 무한 대기 → SIGTERM ⇒ 3초 내 exit 143·descendant 없음·HOME 없음(실측 ~16ms). [exec] env 백도어 무시 → exit 0. downstream malformed/bad-result → 즉시 fatal finalize. 정책 거부/일반 tool error 뒤 다음 정상 호출 성공(세션 유지). cleanup seam → cleanupOk:false.
- 검증: build/tsc noEmit 클린, exec 75 + core 234 + acceptance 71, git diff --check 클린.
- **M3c-3b(profile/handoff/result-enforcement 배선)은 계획 검토 전 상태 유지. 전체 M3c 미완료. 5개는 아직 노출 승인 아님.**

## 2026-07-22 (V3 M3c-3a — proxy P0/P1 보완, M3c-3b 착수 보류)

**M3c-3a 프록시에서 발견된 P0 3건 + P1 보완. 이 보완 전에는 M3c-3b(profile/handoff 배선) 착수 불가 → 착수 판정을 "보류"로 정정.** 실제 shadcn/network/Claude 미실행(fake PATH `npx` fixture).
- **P0-1 실행 진입점 부재**: 프록시에 `main()` + ESM 직접 실행 가드 추가. 실행 시 serviceCwd=cwd, stdin/stdout으로 구동, stdout은 JSON-RPC 전용. 오류는 짧은 code만 stderr + non-zero, **stdin 정상 종료 + cleanup 성공만 exit 0**, cleanup 실패는 non-zero, SIGINT/SIGTERM에서도 downstream group 종료 + HOME/cache cleanup. (원인: dist 실행 시 바로 exit 0 회귀 — 실제 MCP 서버로 못 씀.)
- **P0-2 MCP tool name 계층 오류**: tools/list Tool.name을 **bare 5개**로 수정(`mcp__shadcn__*` prefix는 Claude host가 server name으로 생성 — MCP 서버가 반환하면 안 됨). tools/call도 bare만 허용, 이미 prefix 붙은 입력은 unknown/invalid 거부. host-namespaced(`mcp__shadcn__<bare>`)는 ProxyResult.calledTools 등 **내부 보고에서만** 파생. (원인: 이전 구현이 namespaced 이름을 반환 → double namespace.)
- **P0-3 fatal downstream 처리**: `terminateProcessGroup()` 단일 함수를 markDead()·shutdown()이 공용. timeout/stdout·stderr cap/malformed/id mismatch/조기 종료는 즉시 그룹 종료 + **안전 오류 응답 후 finalize**(열린 채 대기 금지). result_too_large 등 정상 정책 거부는 downstream을 죽이지 않고 호출만 거부. descendant 종료 확인 후에만 HOME/cache 삭제.
- **P1**: downstream negotiated protocolVersion 저장 → upstream initialize 응답에 사용. initialize→notifications/initialized→tools/list·tools/call **상태 머신** 강제(순서 위반 -32600). notification엔 error 응답 안 함. request id는 string/number만, number 1과 string "1" 구분. upstream 개행 없는 buffer·queue(≤64)·총 요청 상한. childHome 생성 후 constructor/spawn 실패도 cleanup. startup/serve cleanup 실패를 `cleanup_failed`로 표면화, **cleanupOk:false를 성공으로 보고 안 함**.
- **테스트**: 기존 13개를 공식 MCP 계약으로 교정(bare name·initialize→initialized 순서), +8 추가(executable 왕복·startup 실패 non-zero·cleanup 실패 non-zero·SIGINT group cleanup·lifecycle 위반·unknown notification 무응답·numeric/string id 구분·buffer/queue 상한·fatal→finalize+descendant 종료). 총 21개.
- 기존 입력 정책·5개 필터·6회·60s·256KiB·8,000 resultChars hard reject 유지.
- 검증: build/tsc noEmit 클린, exec 75 + core 229 + acceptance 71, git diff --check 클린.
- **M3c-3b(profile 등록·노출 승인·handoff 연결·result-size enforcement 정식 배선) = 계획 검토 후 착수(현재 보류). 전체 M3c 미완료. 5개는 아직 노출 승인 아님.**

## 2026-07-22 (V3 M3c-3a — shadcn read-only filtering MCP proxy, offline)

**M3c-3a offline proxy 구현·검증 완료.** 실제 shadcn/network/Claude 미실행(fake PATH `npx` fixture만). profile 등록·registry 변경·handoff 연결 없음. **이 5개는 아직 profile에 등록·노출된 것이 아니다** — 로컬 필터 프록시가 보안 경계를 제공하는 단계일 뿐이다.
- **이유**: 원본 shadcn MCP는 7개를 모두 노출하므로 직접 profile 연결 금지. deniedTools/Hook만으로는 "미노출"과 "응답 전달 전 크기 제한"을 보장 못 함 → 로컬 필터 MCP 프록시가 실제 경계를 제공.
- **신규**: `src/tools/shadcnReadMcpProxy.ts`(+`.test.ts`, dist), `src/tools/shadcnReadPolicy.ts`(정책 상수 전용). registry/tool_profiles.json·handoff.ts·profiles.ts·schema·CLI **미수정**.
- **프록시 계약**: upstream엔 MCP 서버로 동작(읽기 후보 5개만 노출, **로컬 제한 schema**·downstream description/schema 미노출), downstream은 고정 `npx --yes shadcn@4.13.1 mcp`(override seam 없음). startup에서 표준 components.json 검사(child/config 이전) → downstream initialize(허용 protocol·capabilities.tools·non-empty serverInfo) → downstream tools/list가 **실측 7개와 정확 일치**해야 serve 시작(불일치·custom registry는 spawn 전/직후 fail-closed). child env는 allowlist + 임시 HOME/npm cache(ambient secret 미전달).
- **노출/차단**: 노출 5개 = get_project_registries·list_items_in_registries·search_items_in_registries·view_items_in_registries·get_item_examples_from_registries. 금지 2개(get_add_command_for_items·get_audit_checklist)는 tools/list 미노출 + tools/call fail-closed(downstream 미전달). 알 수 없는 method/tool·중복 JSON-RPC id·malformed는 fail-closed.
- **입력 정책(additionalProperties:false)**: get_project_registries=빈 객체만 · list=registries 정확히 ["@shadcn"]·types 정확히 ["ui"]·limit 1~20·offset 0~1000 · search=list+query 1~200자 · view=items 1~10개·전부 @shadcn/ prefix·traversal(..)/URL(://)/제어문자 금지 · examples=registries ["@shadcn"]+query 1~200자. custom/private registry·추가 인자 거부(child 호출 전 차단).
- **실행 상한**: 세션당 tools/call ≤ 6, 호출당 timeout 60s, 단일 raw 응답 256KiB, downstream stdout 2MiB·stderr 64KiB, upstream line 256KiB. CallToolResult 전체 canonical resultChars > 8,000이면 **모델에 원문 미전달·pointer 미반환**(hard reject) — contextRoot runtime 읽기로 pointer가 상한 우회가 되므로 M3 파일럿은 hard reject. isError=true·빈 content·structuredContent 존재·text 이외 block은 현재 실측 계약 밖이라 fail-closed. 원문·secret·stack은 stdout(JSON-RPC 전용)/stderr/artifact에 미기록.
- **수명주기**: 성공/실패/timeout/malformed 모두 downstream **그룹 종료**(detached spawn + `process.kill(-pid)`)로 descendant 방치 없이 kill→bounded close 확인 후 임시 HOME/cache 정리(startup 실패 포함).
- **테스트**(`shadcnReadMcpProxy.test.ts`, +13): 정상 왕복, tools/list 정확히 5개(금지/extra 부재·downstream desc 미노출), 허용 5개 인자 전달, downstream 7 불일치·init 계약 위반 startup 거부, forbidden/unknown child 미호출, 도구별 잘못된 registry/추가 key/범위/traversal/URL/제어문자 거부, 7번째 차단, timeout·256KiB·8,000 resultChars·isError·빈·structured·non-text 안전 error(원문 미노출), ambient secret child env 부재·출력 평문 부재, custom registry child spawn 전 차단, malformed/dup id/unknown method fail-closed, **descendant 그룹 종료**, 실패 경로 임시 HOME 잔존 없음. M3c-0/1/2 회귀 없음.
- 검증: build/tsc noEmit 클린, exec 75 + core 221 + acceptance 71, git diff --check 클린.
- **미완료**: profile 등록·노출 승인·handoff 연결·result-size enforcement의 정식 배선은 여전히 별도 단계(M3c-3b). **전체 M3c 미완료.**

## 2026-07-22 (V3 M3c-2 — actual live read semantics acceptance PASS)

**M3c-2 controlled read semantics live acceptance 1회 실행 — runner exit 0 / PASS.** `HARNESS_LIVE_M3C2_SEMANTICS=1 node scripts/m3c2-live-read-semantics.mjs`. **Claude CLI/구독 미사용**(shadcn MCP stdio 직접, `shadcn@4.13.1`). 실행으로 코드·git 상태 불변(runner는 임시 경로만 사용·자체 정리).
- **고정 5개 도구가 정확한 순서로 호출됨**: `get_project_registries` → `list_items_in_registries` → `search_items_in_registries` → `view_items_in_registries` → `get_item_examples_from_registries`(모두 `mcp__shadcn__` prefix). operationSummary `{initialize:1, initialized:1, toolsListPages:1, toolCalls:5, forbiddenToolCalls:0}`.
- **금지 도구 2개(get_add_command_for_items, get_audit_checklist) 호출 없음.** 5회 모두 **serviceCwd unchanged=true**(before==after hash). 전 결과 **contentTypes=[text], structuredContentPresent=false**, 전 호출 **withinProposedBudget=true**.
- **실측 지표(runner 출력값)**:
  - `get_project_registries`: responseBytes=365, textChars=285
  - `list_items_in_registries`: responseBytes=274, textChars=194
  - `search_items_in_registries`: responseBytes=289, textChars=207
  - `view_items_in_registries`: responseBytes=172, textChars=94
  - `get_item_examples_from_registries`(**최대 결과**): responseBytes=4441, textChars=4161, withinProposedBudget=true
- **계약/보안 검사 통과(exit 0 근거)**: mcp-config 정확히 `npx --yes shadcn@4.13.1 mcp`, runtime dir 0700·mcp-config 0600·snapshot 0600, snapshot 구조(허용 key만)·sentinel 평문 부재, 외부 결과 원문 미출력·미저장, cleanup·잔존 프로세스(`shadcn@4.13.1 mcp`) 없음. **protocolVersion은 허용 집합·serverInfo는 non-empty(name/version) 계약 통과로 기록**(정확한 값은 이번 runner 출력에 직접 재출력되지 않음; `2025-11-25`/`shadcn 1.0.0`은 M3c-1 기존 실측값으로만 구분해 언급).
- **증거 경계**: 이번 출력에는 정확한 `resultChars`/`resultBytes`가 없어 수치는 추측하지 않는다(withinProposedBudget=true만 확인). 단일 실행의 serviceCwd 무변경이 모든 원격 부작용 부재를 증명하지는 않는다.
- **여전히 미완료**: 5개는 아직 **"노출 승인"이 아니라 read semantics 검증 후보**다. 권한 분류·profile 등록·registry 변경·handoff 연결·result-size enforcement **미착수**. **전체 M3c 미완료.**
- **다음: M3c-3 권한 매핑·필터링·result-size enforcement 계획 검토(구현 미착수).**

## 2026-07-22 (V3 M3c-2 — read semantics probe P0/P1 보완, live 전, offline)

**M3c-2 P0 2건 + P1 2건 + runner 정합성 보완. actual five read calls는 여전히 승인 대기.** 실제 shadcn/network 미실행(fake stdio MCP fixture만).
- **P0-1 고정 호출 계획 런타임 불변성**: `SEMANTICS_CALLS`/`FORBIDDEN_CALL_TOOLS`/`MCP_ALLOWED_PROTOCOL_VERSIONS` export를 제거하고 **non-exported 내부 상수 + deep-freeze**로 변경. 외부에는 매번 **deep clone**을 돌려주는 getter(`getSemanticsCalls`/`getForbiddenCallTools`/`getAllowedProtocolVersions`)만 노출. 실행은 내부 frozen 계획만 사용. 시작 시 이름·순서·arguments canonical hash·중복 부재·금지 제외를 **독립 contract와 exact 비교**. M3c-1의 가변 `EXPECTED_SHADCN_TOOLS`에 의존하지 않고 내부 namespaced exact set으로 tools/list 검증. 재현(`SEMANTICS_CALLS[0].arguments=…`·`FORBIDDEN.clear()`·`ALLOWED.add()`)이 getter clone에만 적용되고 실제 호출/인자·금지·allowlist는 불변임을 테스트.
- **P0-2 전체 결과 budget**: `textChars`는 관측 지표로 유지하고, **CallToolResult 전체 canonical serialization** 기준 `resultChars`/`resultBytes`를 추가. `withinProposedBudget = resultChars <= 8000`. `responseBytes`는 JSON-RPC envelope 포함 raw line bytes로 유지. structuredContent가 8,000자 초과면 text가 작아도 budget=false. hard 256KiB cap 유지, 원문 미저장.
- **P1-3 filesystem snapshot 강화**: serviceCwd **root 자체 type/mode**를 hash에 포함. baseline symlink는 **spawn 전 fail-closed**(`baseline_symlink`). 파일은 `O_NOFOLLOW` fd로 열어 **같은 fd로 fstat/read**(snapshot 중 symlink 교체 방지, ELOOP→symlink 기록). 파일별(1MiB)·전체(16MiB) read 상한. `MAX_FS_ENTRIES` off-by-one(`>=`) 수정. root chmod·기존 symlink·oversized 파일 테스트 추가.
- **P1-4 실패 경로 child/HOME cleanup**: 성공뿐 아니라 timeout/malformed/fs-change 등 **모든 실패 경로도 kill→bounded close 확인 후 reject**(settle→closeGrace→SIGKILL→killGrace, close 미확인 시 `child_did_not_close`). child close **전에는 임시 HOME/cache를 삭제하지 않음**. cleanup 실패는 typed `cleanup_failed`로 표면화. 실패 fixture·runner 종료 후 `m3c2-home-*` 잔존 없음 검증.
- **runner 정합성**: mutable export 대신 clone getter 사용. generated mcp-config가 정확히 `npx --yes shadcn@4.13.1 mcp`인지, mcp-config 0600·runtime 0700·snapshot 0600, snapshot mode/readSemantics/calls.length===5 확인. raw payload 검사를 `"content"` 정규식이 아니라 **허용 top-level/call metric key 구조**로 검증. phase=tools 중복 조건(단일 응답 cap 재검사) 제거. capabilities.tools도 plain object로 검증.
- 검증: build/tsc noEmit 클린, exec 75 + core 208 + acceptance 71, node --check·opt-in exit 2·runner offline smoke, git diff --check 클린.
- **미완료(주장 금지)**: 5개는 노출 승인 아닌 검증 후보, add-command/audit-checklist 제외. 권한 분류·profile 등록·handoff 연결·result-size enforcement 미완료. **전체 M3c 미완료. 다음: actual five read calls(승인 후).**

## 2026-07-21 (V3 M3c-2 — controlled read semantics probe scaffold, offline)

**M3c-2 controlled semantics scaffold offline 완료. actual five read calls는 승인 대기.** 실제 shadcn/network 미실행(fake stdio MCP fixture만). profile 등록·handoff 연결·registry 변경·result-size enforcement 없음.
- **shadcn 전용 semantics probe**(`src/tools/shadcnReadSemanticsProbe.ts` 신규): exact `npx --yes shadcn@4.13.1 mcp`. `initialize → notifications/initialized → tools/list`(M3c-1과 동일 exact 7개 검증) → **읽기 후보 5개만 고정 인자로 순차 tools/call**. 호출 대상·인자는 코드 상수(외부 주입 seam 없음), 범용 MCP client 아님.
  - **정확한 5개 호출**: `get_project_registries {}`, `list_items_in_registries {registries:["@shadcn"],types:["ui"],limit:1,offset:0}`, `search_items_in_registries {registries:["@shadcn"],query:"button",types:["ui"],limit:1,offset:0}`, `view_items_in_registries {items:["@shadcn/button"]}`, `get_item_examples_from_registries {registries:["@shadcn"],query:"button-demo"}`.
  - **금지 2개**: `get_add_command_for_items`, `get_audit_checklist` — tools/call 생성 경로 없음(fixture도 미수신).
- **무변경 검증**: serviceCwd 전체를 호출 전/각 호출 후 재귀 snapshot(상대경로·타입·mode·size·SHA-256) 비교. 생성·수정·삭제·symlink 발생 시 즉시 `filesystem_changed` fail-closed. child HOME/npm cache는 serviceCwd 밖 임시 경로로 분리. custom/private registry는 config/spawn/call 이전 `checkComponentsJson`으로 거부.
- **결과 검증**: CallToolResult content(배열·비어있지 않음)/structuredContent/isError 계약. isError=true·빈 결과·malformed 거부. **외부 결과 원문은 저장/출력하지 않고** 파생 지표만 기록: toolName·argumentsHash·elapsedMs·responseBytes·textChars·contentTypes·structuredContentPresent·resultHash·filesystemBefore/AfterHash·unchanged·withinProposedBudget.
- **상한**: 정확히 5회, per-call 60s·overall 5min, 단일 raw response 256KiB(초과 fail-closed), stdout 2MiB·stderr 64KiB, proposed budget 8,000 chars는 **측정만**(초과 시 자르지 않고 `withinProposedBudget:false`). cursor/tool schema 검증은 M3c-1 유지.
- **artifact**: `mcp-read-semantics.json`(mode:`read-semantics`·usableForHandoff:false·**externalDataUntrusted:true**, package/server/protocolVersion/serverInfo/proposedBudgetChars/calls/configHash/timestamp), dir 0700/file 0600/wx, deep redaction, child close bounded wait·잔존 프로세스 검사.
- **operationSummary**: `{initialize:1, initialized:1, toolsListPages≥1, toolCalls:5, calledTools:[정확한 5개], forbiddenToolCalls:0}`.
- **live runner**(`scripts/m3c2-live-read-semantics.mjs` 신규): `HARNESS_LIVE_M3C2_SEMANTICS=1` 없으면 exit 2, 실제 Claude 미사용, metrics만 출력(원문 없음), cleanup·잔존 검사. **이번 작업 미실행.**
- **테스트**(`src/tools/shadcnReadSemanticsProbe.test.ts` 신규, +14): 정상 5회·순서·금지 부재·무변경·raw 미저장, fs 생성/수정/삭제/symlink 감지, isError/빈/malformed 거부, per-call·response 256KiB·stdout·stderr 상한, 8,000 초과=budget false(hard fail 아님), custom registry 부작용 0, persist wx, tools/list 불일치, redaction, 종료 지연, runner offline smoke(exit 0·원문 미출력)·opt-in exit 2, fixture 수신 method가 tools/list + 정확한 5 tools/call. M3c-0/M3c-1 불변.
- 검증: build/tsc noEmit 클린, exec 75 + core 206 + acceptance 71, node --check·git diff --check 클린.
- **미완료(주장 금지)**: 5개는 아직 "노출 승인"이 아닌 **검증 후보**. 권한 분류·profile 등록·handoff 연결·result-size enforcement **미완료**. 실제 5회 호출은 승인 대기. **전체 M3c 미완료.**
- **다음: actual five read calls(승인 후 1회) → 결과로 노출 승인 여부·result budget enforcement 설계.**

## 2026-07-21 (V3 M3c-1 — actual live schema probe PASS, offline+live 완료)

**M3c-1 offline+actual live 완료.** 사용자 승인 하에 `HARNESS_LIVE_M3C_SCHEMA=1 node scripts/m3c-live-schema-probe.mjs`를 1회 실행 — **runner exit 0 / schema discovery OK**. Claude CLI/구독 미사용(shadcn MCP stdio 직접), tools/call 없음, cleanup·잔존 프로세스 검사 통과. 실행으로 코드·git 상태 불변.
- **환경/결과**: package `shadcn@4.13.1`, **protocolVersion `2025-11-25`**, serverInfo `shadcn 1.0.0`. 도구 **7개 정확 일치**. **annotations: 전 도구 없음. outputSchema: 전 도구 없음.**
- **실측 inputSchema 요약**(서버 제공, 아직 권한 근거 아님):
  - `get_add_command_for_items`: items(required)
  - `get_audit_checklist`: 입력 없음
  - `get_item_examples_from_registries`: registries?, query(required)
  - `get_project_registries`: 입력 없음
  - `list_items_in_registries`: registries?, types?, limit?, offset?
  - `search_items_in_registries`: registries?, query(required), types?, limit?, offset?
  - `view_items_in_registries`: items(required)
- **한계(주장 금지)**: schema/description은 실측됐으나 **annotations/outputSchema 증거는 없음**(hint 부재). description은 **서버 제공 untrusted 정보**이므로 아직 read/write **권한 분류 근거로 확정하지 않는다**(이름·description=권한 금지). profile 등록·handoff 연결·MCP 도구 호출·result-size enforcement는 **미완료**. **전체 M3c 미완료.**
- **다음: M3c-2 — controlled read semantics 검증 계획**(승인·격리 하에서 각 도구의 실제 read-only 성격·결과 크기를 통제된 방식으로 확인 → 그 근거로 권한 등급·profile 등록·result-size enforcement). 이번 단계에서 M3c-2 코드·registry 변경·handoff 연결·도구 호출 없음.

## 2026-07-21 (V3 M3c-1 — schema probe P0 보완, live 전, offline)

**M3c-1 P0 6건 보완. 실제 live schema probe 미실행·승인 대기.** 실제 claude/npx/네트워크 미실행(fake stdio MCP fixture만).
- **P0-1 runner import 오류**: runner가 `checkComponentsJson`을 `shadcnSchemaProbe.js`에서 import(undefined)하던 것을 `dist/tools/shadcnPilot.js`에서 정확히 import. opt-in + fake npx(PATH)로 runner를 끝까지 도는 offline smoke 테스트 추가(exit 0·`is not a function` 부재 검증). 실제 npx/network 미호출.
- **P0-2 실행 명령 우회 제거**: production의 `HARNESS_SHADCN_NPX_BIN` 지원 완전 제거 → `runShadcnSchemaProbe`는 항상 `npx --yes shadcn@4.13.1 mcp`만 실행. 테스트는 임시 PATH에 `npx` 이름 fixture 배치 방식으로 전환. "주입 seam 없음" 문서 주장과 코드 일치(bogus env override 무시 테스트).
- **P0-3 schema key redaction**: 문자열 value뿐 아니라 **객체 key**도 검사 — key가 scrub 대상(secret/credential)이면 이름을 변형하지 않고 typed `secret_in_schema_key`로 fail-closed(오류·snapshot에 원 key 평문 없음). 중첩 properties key sentinel 테스트 추가.
- **P0-4 공식 MCP 계약 정합화**: 요청 protocolVersion `2025-11-25`(+ 이전 revision negotiation allowlist), "2025-06-18 최신 stable" 주장 제거. init result에서 capabilities plain object·`capabilities.tools` 존재·serverInfo.name/version non-empty string 검증. Tool.description은 **optional string**, optional **title** 수집, inputSchema·outputSchema root `type:"object"` 강제, annotations는 untrusted hint로 알려진 boolean 필드 타입만 검증(권한 판정 근거 아님).
- **P0-5 UTF-8·프로세스 lifecycle**: stdout byte 상한은 raw Buffer.length로 계산, `StringDecoder`로 chunk 경계 UTF-8 손상 방지. 수집 성공 후 stdin close→child close **bounded wait**(grace 후 SIGKILL, close 확인 전 resolve/저장 금지, 미종료 시 typed `child_did_not_close`). 멀티바이트 chunk 분할·종료 지연 fixture 테스트 추가.
- **P0-6 tools/call 증거 정직화**: 결과에 고정 `operationSummary {initialize:1, initialized:1, toolsListPages:n, toolCalls:0}` 반환, runner가 이를 검사. snapshot에 raw JSON-RPC payload 미저장, tools/call 생성 경로 부재 유지.
- 검증: build/tsc noEmit 클린, exec 75 + core 192 + acceptance 71, node --check·opt-in 게이트 exit 2·runner offline smoke PASS, git diff --check 클린.
- **미확정(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement. 실제 schema는 runner 승인 실행 후 확정. **전체 M3c 미완료.**

## 2026-07-21 (V3 M3c-1 — tools/list schema discovery scaffold, offline)

**M3c-1 schema scaffold offline 완료. actual live schema probe 승인 대기.** 실제 claude/npx/shadcn/네트워크 미실행(fake stdio MCP fixture로만 검증). **tools/call 미구현·미전송**, profile 등록·registry 변경·handoff 연결·권한 분류 없음.
- **좁은 stdio schema probe**(`src/tools/shadcnSchemaProbe.ts` 신규): shadcn 전용(범용 MCP client 아님). shadcn MCP 서버와 직접 stdio JSON-RPC로 `initialize → notifications/initialized → tools/list`까지만 대화. **tools/call 코드 경로 없음.** 실행 명령은 정확히 `npx --yes shadcn@4.13.1 mcp`(package/command/args 주입 seam 없음; 테스트는 launcher 실행 파일만 `HARNESS_SHADCN_NPX_BIN`으로 교체, pinned args 불변). MCP protocolVersion 상수(`2025-06-18`)·허용 집합으로 negotiation 엄격 검증.
- **registry 강제**: `checkComponentsJson`을 config/spawn 이전에 재사용 — custom/private/malformed/symlink/oversized면 runtimeDir·config·spawn 없이 `registry_<code>` 실패.
- **tools/list 검증**: 서버 bare 도구명을 host가 `mcp__shadcn__`로 namespacing → M3c-0 확정 7개와 정확 일치(누락/추가/중복 거부). pagination 지원(nextCursor), 반복 cursor·페이지 상한(8)·64개 초과 거부. 각 도구 name/description/inputSchema 필수, outputSchema·annotations 존재 시 plain object. schema 깊이(16)·객체 키(256)·문자열(8KiB)·도구(64KiB)·snapshot(256KiB) 상한. JSON-RPC version/id 불일치·malformed line·no-init·timeout·non-zero·stdout(1MiB)/stderr(64KiB) 상한 거부.
- **산출물**(`mcp-schema-discovery.json`, mode:`schema-discovery`·usableForHandoff:false): package/server/protocolVersion/serverInfo/tools/configHash/timestamp. raw protocol payload 미저장(추출 schema만), 반환==저장 deepEqual, dir 0700·file 0600·wx, 문자열 deep-scrub(redactNames scrub 전용·child env 미전달). 타입 `ShadcnSchemaResult{schemaDiscovery:true}`로 PreflightSuccess·discovery와 분리.
- **live runner**(`scripts/m3c-live-schema-probe.mjs` 신규): `HARNESS_LIVE_M3C_SCHEMA=1` 없으면 Claude/npx 미호출 exit 2, npm test/CI 비대상. 실제 Claude CLI 미사용 — shadcn MCP stdio 직접 실행. 임시 standard-registry serviceCwd, package/network 경고, signal/finally cleanup·잔존 프로세스(ownership 확인 후 kill) 검사, tools/call 미전송 검증. **이번 작업 미실행.**
- **테스트**(`src/tools/shadcnSchemaProbe.test.ts` 신규, +12): fake stdio MCP fixture로 정상 수집·7개 정확·누락/추가/중복·JSON-RPC version/id·malformed schema·depth·pagination 성공/반복 cursor/page 상한·timeout/non-zero/stdout·stderr 상한·registry 거부(부작용 0)·고정 package·redaction·반환=저장·0700/0600·wx 충돌·**fixture 수신 method에 tools/call 부재**. M3a preflight·M3c-0 discovery 불변.
- 검증: build/tsc noEmit 클린, exec 75 + core 188 + acceptance 71, node --check·opt-in 게이트 exit 2, git diff --check 클린, npm pack entryCount 78(`dist/tools/shadcnSchemaProbe.js` 포함·runner/snapshot/test 제외).
- **미완료(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement는 **미확정**. 실제 schema는 아직 실측 안 됨(runner 승인 대기). **전체 M3c 미완료.**

## 2026-07-21 (V3 M3c-0 — 실제 live discovery 1회 실행, discovery offline+live 완료)

**M3c-0 discovery offline+live 완료.** 사용자 승인 하에 `HARNESS_LIVE_M3C_DISCOVERY=1 node scripts/m3c-live-discovery.mjs`를 **정확히 1회** 실행. 코드·문서·git 상태는 실행으로 바뀌지 않았다(runner는 임시 경로만 사용·자체 정리).
- **환경/결과**: Claude Code **2.1.216**, package `shadcn@4.13.1`(`npx --yes shadcn@4.13.1 mcp`). runner **exit 0 / discovery OK**. server `shadcn` **connected**.
- **strict 격리·ambient canary**: ambient `.mcp.json` canary 서버는 strict(shadcn 단일) config로 배제 — canary 미기동(pid-file 부재), init 도구 전부 `mcp__shadcn__*` prefix, 서버 목록에 canary 없음. 실행 후 독립 `/bin/ps`에서도 canary·shadcn MCP 프로세스 잔존 없음.
- **검사 통과(exit 0 근거)**: generated mcp-config = 서버 1개(shadcn)·`npx --yes shadcn@4.13.1 mcp`, dir 0700·config/snapshot 0600, snapshot `mode="discovery"`·`usableForHandoff=false`·tools non-empty·raw init 필드 부재, config/snapshot/result에 sentinel 평문 부재, 잔존 프로세스 없음(5초 polling), 임시 디렉터리 cleanup 완료.
- **system/init에서 발견된 실제 MCP 도구 7개(원문 그대로, 권한 분류·browse/search/install/add 추측 매핑 금지)**:
  - `mcp__shadcn__get_add_command_for_items`
  - `mcp__shadcn__get_audit_checklist`
  - `mcp__shadcn__get_item_examples_from_registries`
  - `mcp__shadcn__get_project_registries`
  - `mcp__shadcn__list_items_in_registries`
  - `mcp__shadcn__search_items_in_registries`
  - `mcp__shadcn__view_items_in_registries`
- **미착수(규칙)**: profile 등록·handoff 연결·MCP 도구 호출·권한 등급 분류 없음. **전체 M3c는 미완료.**
- **다음 단계: M3c-1 — `tools/list` schema·semantics 검증 계획**(각 도구의 inputSchema·read/write 성격을 실측·문서로 확정한 뒤에야 권한 매핑·profile 등록으로 진행). 이름만으로 권한을 추정하지 않는다.

## 2026-07-21 (V3 M3c-0 — live runner 런타임 결함 2건 수정, 실제 live discovery 승인 대기)

`scripts/m3c-live-discovery.mjs`만 수정(src/dist 불변). 실제 Claude/npx/network 미실행 — 임시 stub으로만 실측.
- **`sleep` 미정의(ReferenceError) 수정**: 잔존 프로세스 polling의 `await sleep(500)`가 정의 없이 호출되던 것을 inline `const sleep = (ms) => new Promise((r) => setTimeout(r, ms))`로 정의. 잔존 검출 경로에서 ReferenceError 없이 5초 polling 후 FAIL 확인.
- **`LC_*` wildcard 제거**: versionEnv가 모든 `LC_*`를 전달해 `LC_SECRET_TOKEN`/`LC_API_KEY`도 새던 것을 제거. 표준 POSIX LC 카테고리(LC_ALL/LC_CTYPE/LC_MESSAGES/LC_NUMERIC/LC_TIME/LC_COLLATE/LC_MONETARY)만 명시 allowlist.
- **`/bin/ps` 실패 fail-closed**: `matchingShadcnPids`가 실패 시 빈 Map으로 성공 처리하던 것을 `{ok:false,error}`로 변경. baseline ps 실패=discovery 전 exit 2, polling 중 ps 실패=problems 기록·FAIL. 오류는 redact.
- offline 강제 실패-path 실측: 잔존 `shadcn@4.13.1 … mcp` 프로세스 생성 stub → polling 진입·ReferenceError 없음·**exit 1**, 테스트 PID는 ownership 확인 후 정리. LC_SECRET_TOKEN/LC_API_KEY 주입해도 version env dump 부재. 정상 stub exit 0·opt-in 없음 exit 2 유지.
- 검증: node --check·build·npm test(exec 75/core 176/acceptance 71)·tsc noEmit·git diff --check 클린.

## 2026-07-21 (V3 M3c-0 — live runner 최종 보안 보완 완료, 실제 live discovery 승인 대기)

`scripts/m3c-live-discovery.mjs`만 보완(src/dist 불변). 실제 Claude/npx/network 미실행 — 임시 stub으로만 실측.
- `claude --version`을 **allowlist env(PATH/HOME/USER/SHELL/TMPDIR/TMP/TEMP/LANG/LC_*)만** 전달·timeout 10s·maxBuffer 64KiB로 실행(초과/오류 fail-closed). sentinel·ambient TOKEN/KEY/SECRET/PASSWORD/AUTH 미전달. claudeBin 출력도 redact.
- discovery 오류는 **rawMessage로 sentinel 노출 여부 먼저 검사** 후 사용자 출력에만 redact(이전 always-false 버그 정정).
- discovery 전/후 `/bin/ps`로 `shadcn@4.13.1 … mcp` PID 집합 비교(최대 5초 polling) — 이전에 없던 잔존 PID는 **자동 kill 없이** PID/command redact 보고·FAIL. canary PID ownership cleanup 유지.
- offline stub 실측: runner exit 0, version env = allowlist만(sentinel/ambient secret 부재 확인). opt-in 없음 exit 2 유지.
- 검증: node --check·build·npm test(exec 75/core 176/acceptance 71 유지)·tsc noEmit·git diff --check 클린.
- **실제 live discovery는 승인 대기.** 실제 도구명·profile·handoff·result-size enforcement 미확정, M3c 완료 아님.

## 2026-07-21 (V3 M3c-0 — offline hardening, live discovery 미실행)

**M3c-0 offline hardening 완료. live discovery 미실행.** Codex 재현(customRegistryAccepted/emptyToolsAccepted/foreignPinnedPackage + duplicate 도구명 평문 노출)을 반영한 P0/P1 보완. 실제 Claude/npx/shadcn/네트워크 미실행.
- **P0-1 registry 검사를 핵심 API에서 강제**: `runShadcnDiscovery` 시작 직후 `checkComponentsJson(serviceCwd)` — config/runtime/spawn보다 먼저. 실패 시 `registry_<code>` ShadcnDiscoveryError, runtimeDir·mcp-config·discovery snapshot 미생성·spawn 없음. runner 사전 검사는 보조.
- **P0-2 package 고정 우회 제거**: `RunShadcnDiscoveryOpts.package`·`shadcnDiscoveryProfile(pkg)` 인자 제거. production API는 무조건 `SHADCN_PACKAGE="shadcn@4.13.1"`. 다른 exact-pin package도 주입 불가. generic npx pin 검증은 `claudeCodeMcpAdapter` 테스트 유지. shadcnPilot 테스트는 생성 config가 정확히 `npx --yes shadcn@4.13.1 mcp`인지 검증.
- **P0-3 빈 discovery 거부**: system/init에 shadcn MCP 도구 0개면 `no_tools` 실패(성공 1~64개). snapshot 미생성. runner도 tools.length>0 독립 검증.
- **P0-4 전 경로 redaction**: typed ShadcnDiscoveryError를 그대로 rethrow하지 않고 **code 보존 + message scrub**한 새 오류로 정규화(duplicate server/tool·status·spawn/stderr·persistence 공통). 성공 snapshot의 status/tools/package/timestamp도 scrub 후 반환·저장(반환==저장 deepEqual). `redactNames?`(scrub 전용, child env 미전달) 추가. credential 형태·redactNames sentinel 평문 부재 테스트.
- **P1-5 components.json TOCTOU 방지**: `O_NOFOLLOW`로 fd를 열고 같은 fd로 fstat/read(경로 재오픈 없음). ENOENT만 허용, symlink(ELOOP)/non-regular/read error/64KiB 초과 fail-closed, 64KiB+1 byte 초과 미판독.
- **P1-6 stream 출력 상한**: stdout 누적 1MiB(수신 시 byte 검사 후 push → NdjsonParser buffer 무한 증가 방지)·stderr 64KiB 초과 시 child kill + `stdout_too_large`/`stderr_too_large`.
- **P1-7 강제 env 우선순위**: `MCP_CONNECTION_NONBLOCKING`/`ENABLE_TOOL_SEARCH`/`CLAUDE_CODE_DISABLE_AUTO_MEMORY`는 testEnv 병합 후 **마지막에 강제** — testEnv가 덮어쓸 수 없음(테스트로 env 덤프 검증).
- **P1-8 snapshot persistence 정규화**: mkdir/write/wx 충돌도 typed+redacted `persist` 오류로 반환. 기존 mcp-discovery.json·symlink는 `wx`로 덮어쓰지 않고 부분 성공 미반환.
- **P1-9 live runner 강화**: 동일 `HARNESS_CLAUDE_BIN` `claude --version` 검증·기록(실패 시 미실행), generated mcp-config가 서버 1개(shadcn)·`npx --yes shadcn@4.13.1 mcp` 검사, canary config/snapshot 부재, dir 0700·config/snapshot 0600, snapshot mode/usableForHandoff=false/tools non-empty·raw init 부재, random sentinel parent-only(config/snapshot/result/error 평문 부재·child 미전달), 출력은 scrub된 snapshot 값만. **이번 작업 미실행.**
- 검증: build/tsc noEmit 클린, exec 75 + core 176 + acceptance 71, node --check·opt-in 게이트 exit 2, git diff --check 클린.
- **실제 도구명·profile·handoff·result-size enforcement는 여전히 미확정.** M3c 완료 아님.

## 2026-07-20 (V3 M3c-0 — shadcn MCP discovery scaffold, offline)

**M3c discovery scaffold offline 완료. 실제 discovery 및 profile 활성화는 미완료(미실행).** 실제 Claude/npx/shadcn/네트워크·MCP 도구 호출은 하지 않았다. registry 미등록·handoff 미연결.
- **shadcn 파일럿 정책**(`src/tools/shadcnPilot.ts` 신규): `SHADCN_PACKAGE="shadcn@4.13.1"`(고정 pin), 실행 선언 `npx --yes shadcn@4.13.1 mcp`, server=`shadcn`, secretRefs=[]. `shadcnDiscoveryProfile(pkg)` — in-code profile(bindings.component_registry_read=mcp, **tools=[]** 발견 대상). `@latest`/무버전/범위는 기존 `buildMcpConfig`(compileServer) 규칙대로 거부.
- **표준 registry 검사** `checkComponentsJson(serviceCwd)`: 파일 없음→허용, registries 없음/빈 plain object→허용, 항목 있음/plain object 아님→`custom_registry_forbidden`, malformed·root 비객체·symlink·일반 파일 아님·64KiB 초과→fail-closed(코드만, 파일 내용·credential·env secret 미포함).
- **전용 MCP discovery** `runShadcnDiscovery(...)`: runPreflight의 exact-profile 검증을 **완화하지 않고 별도 API**로 구현. 단일 shadcn 서버 strict config, headless `claude -p --output-format stream-json --strict-mcp-config --setting-sources "" --mcp-config <gen> --tools "" --permission-mode plan`(env MCP_CONNECTION_NONBLOCKING=0·ENABLE_TOOL_SEARCH=false·auto-memory 차단), system/init에서 실제 도구명 수집. 서버 정확 `["shadcn"]`+connected 필수, 다른 서버/다른 prefix 도구·중복·빈이름·malformed·non-zero·no-init·timeout(기본 60s) 거부. 도구 ≤64개·각 ≤256B·snapshot ≤64KiB. raw init 미저장, 오류·반환 redaction.
- **discovery 산출물 분리**: `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false·package·server·status·tools·configHash·timestamp, dir700/file600/wx). 타입 `ShadcnDiscoveryResult{discovery:true}`·`ShadcnDiscoveryError`로 `PreflightSuccess{ok:true}`와 분리 → 정상 preflight·handoff 승인 근거로 사용 불가.
- **수동 live discovery runner**(`scripts/m3c-live-discovery.mjs` 신규): `HARNESS_LIVE_M3C_DISCOVERY=1` 없으면 exit 2(Claude/npx 미호출), npm test/CI 비대상, package download·네트워크·구독 사용량 명시, 임시 serviceCwd·components.json(registries:{})·ambient .mcp.json canary(strict 격리 확인), 실제 도구명 출력·snapshot, 도구 호출·interactive TUI 미실행, signal/finally cleanup + canary PID ownership(`/bin/ps`) 검사. **이번 작업에서 실제 실행하지 않음.**
- **테스트**(`src/tools/shadcnPilot.test.ts` 신규, +21): components.json 없음/없는 registries/빈 객체 허용, custom/private/third-party·배열 registries 거부, malformed/symlink/oversized/non-regular 거부, 정확한 shadcn@4.13.1 pin·비pin 거부, discovery 성공(generic fixture)·PreflightSuccess와 분리, extra server/foreign tool/duplicate/empty/too-long/too-many/not-connected/no-init/non-zero/timeout 거부, 산출물 권한·raw init 미저장·오류 redaction, registry/tool_profiles.json 불변. 일반 runPreflight·handoff argv·M3b.2 테스트 불변(코드 미수정).
- 검증(하드닝 후): build/tsc noEmit 클린, exec 75 + core 176 + acceptance 71, node --check·opt-in 게이트 exit 2, git diff --check 클린.
- **실제 shadcn 도구명(browse/search/install/add 등)은 아직 미확인** — 위 runner를 사람이 실행해야 발견된다. **다음: M3c 파일럿 계획 검토(실제 discovery 실행 → 도구명 확정 → profile 등록·handoff 연결).**

## 2026-07-20 (V3 M3b.2 — offline + actual live acceptance 완료, PASS)

**M3b.2 interactive handoff가 실제 Claude Code 2.1.215에서 live acceptance PASS(runner exit 0)로 완료됐다.** 앞선 argv P0(1차 무효)·planning 경로 P0-1·sentinel 출력 P0-2를 모두 수정한 뒤의 재검증 결과다(아래 실패 시도들은 역사 기록으로 유지).
- **runner**: `scripts/m3b2-live-handoff.mjs`(`HARNESS_LIVE_M3B2=1`, TTY 필수). 최종 exit 0 / PASS. 임시 `m3b2-live-*` 디렉터리 정리 완료.
- **실측 통과 범위(Claude Code 2.1.215)**:
  - exact Hook 6종 등록(exec form: SessionStart/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/PermissionDenied·SessionEnd 계약 — hooks 키 집합·matcher1·handler1·args2 정확 일치).
  - empty MCP preflight snapshot `servers=[]`/`tools=[]` + mcp-config `mcpServers={}`.
  - planning contextRoot 접근(`--add-dir <contextRoot>`): 00_IDEA.md·06_CEO_DECISION.md를 contextRoot 절대경로로 Read 성공. serviceCwd에 docs/ 나 docs/WORKLOG.md 미생성(P0-1 해소 확인).
  - Read 성공/실패 callId correlation(tool_requested ↔ tool_succeeded / tool_failed 동일 callId).
  - Bash 승인: permission_requested(Bash, callId=null 별도) + tool_requested/succeeded(동일 callId). 비출력 sentinel 존재 검사(`node -e …`)로 값 미출력(P0-2 해소 확인).
  - Write 수동 거부: tool_requested + permission_requested 기록, rejectMarker 파일 부재·해당 경로 tool_succeeded 부재. tool_denied로 합성·연결하지 않음.
  - SessionEnd: session_end 정확 1건(callId/toolName=null).
  - ambient MCP canary(.mcp.json)·Hook canary(SessionStart+PreToolUse) 모두 미기동(strict MCP + `--setting-sources ""` 격리 확인).
  - trace redaction·권한(dir700/file600)·원문 미저장(transcript_path/raw tool_response 부재)·sentinel/credential 평문 부재, run_state.handoff 기록·completed 상태 불변, 대화형 argv에 `-p`/stream-json 없음(`--` 꼬리).
- **결론**: M3b.2 offline + actual live 완료. **다음 단계는 M3c(shadcn read) 파일럿 계획 검토**(구현 아님).

## 2026-07-20 (V3 M3b.2 — 두 번째 live에서 P0 2건 발견 + 수정, 전체 PASS 아님)

**두 번째 live acceptance는 전체 PASS가 아니다.** argv P0(`--`)는 통과했으나 아래 P0 2건이 새로 드러났다. 실제 Claude/TUI는 재실행하지 않고 수정·offline 검증만 했다.
- **통과 범위(2차 live)**: argv `--` 꼬리로 초기 프롬프트가 정상 전달됨(1차 무효 원인 해소). 대화형 세션이 실제로 열렸고 절차 입력이 가능했다.
- **P0-1 planning context 경로 단절**: task prompt의 `Include`는 `docs/*.md` 상대경로인데 대화형 cwd는 serviceCwd고 실제 planning 문서는 `projectPaths(project).root/docs`에 있다. live에서 Claude가 "docs 디렉터리가 없다"고 보고하고 serviceCwd 아래 잘못된 `docs/WORKLOG.md`를 만들었다.
  - 수정(`src/core/handoff.ts`): `contextRoot = projectPaths(project).root` 명시 → argv에 `--add-dir <contextRoot>` 추가 → initialPrompt에 경로 계약(Include의 docs/…는 contextRoot 절대경로, serviceCwd/contextRoot 별개, WORKLOG 대상 = contextRoot/docs/WORKLOG.md, serviceCwd에 docs 생성 금지) 명시 → 승인 preview에 serviceCwd·contextRoot 별도 표시 → 128KB fallback도 contextRoot 접근으로 읽힘. `--disallowedTools mcp__* -- <initialPrompt>` 꼬리 유지.
- **P0-2 sentinel TUI 평문 출력**: Bash 검증 명령이 `printf '%s' "$M3B2_LIVE_TOKEN"`이라 fake sentinel **값**이 TUI에 출력됐다. (실제 credential이 아니라 runner가 심은 fake sentinel이지만, "외부 미출력" 주장과 모순.)
  - 수정(`scripts/m3b2-live-handoff.mjs`): 값을 출력하지 않는 존재 검사 `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`로 변경. task prompt·안내·trace 판정을 새 명령에 맞춤. 실제 sentinel 값은 terminal/settings/config/snapshot/trace/outcome에 출력하지 않는다. collector redaction 단위 테스트는 유지.
- **테스트**(`src/core/handoff.test.ts`): 성공 테스트에 `--add-dir=contextRoot`·prompt 절대 contextRoot·WORKLOG 절대경로·경로 계약 문구 검증 추가. 전용 P0-1 테스트(serviceCwd≠contextRoot fixture, `--add-dir` 정확, `--` 꼬리 회귀 없음, serviceCwd에 docs/WORKLOG 미생성) 신규. 128KB fallback 테스트에 경로 계약·`--add-dir`·`--` 검증 추가. 기존 테스트 삭제·완화 없음.
- **runner 보강**: `--add-dir`=contextRoot 검사, planning 문서(00_IDEA/06_CEO_DECISION) Read 성공 trace 검증, serviceCwd/docs/WORKLOG.md 생성 시 실패, Write 단계 안내에 "기본 Yes에서 Enter 금지·방향키로 No·재시도 금지" 명시, permission mode default/manual 유지, manual deny는 marker 부재+tool_succeeded 부재로만 판정.
- **상태: M3b.2 live 재검증 대기**(전체 PASS 아님). fake sentinel이 출력됐으나 **실제 credential은 아니었다**. 수정 후 사람이 runner를 재실행해야 Hook 검증이 성립한다.
- 검증: build/tsc noEmit 클린, exec 75 + core 159 + acceptance 71, node --check·opt-in/non-TTY 게이트 exit 2.

## 2026-07-20 (V3 M3b.2 — 첫 live 시도 무효(argv P0) + 수정)

**첫 live acceptance 시도는 argv 파싱 오류로 무효였고, 실제 Hook 검증은 수행되지 않았다.** 실제 Claude/TUI는 재실행하지 않았다.
- **원인(P0)**: `src/core/handoff.ts`의 대화형 spawn argv 꼬리가 `--disallowedTools`, `mcp__*`, `initialPrompt` 순서였다. `--disallowedTools <tools...>`는 **가변 인자**라, 옵션 종료 구분자 `--` 없이 뒤에 붙은 initialPrompt(및 그 안의 모든 단어)를 deny 규칙으로 소비했다. Claude Code 2.1.215 실측에서 초기 프롬프트의 모든 단어가 `Permission deny rule "..." matches no known tool` 경고로 출력됨 → 세션이 acceptance 절차를 받지 못해 **무효**.
- **수정**: 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로 변경(옵션 파싱 종료 후 프롬프트를 순수 positional로 전달). 대화형 TUI·`stdio:"inherit"`·`-p`/stream-json 미사용 계약 불변.
- **회귀 테스트**(`src/core/handoff.test.ts`): 기존 성공 테스트에 `argv.at(-2)==="--"`·마지막 인자=initialPrompt·`--disallowedTools` 값이 `mcp__*` 하나이고 그 뒤 `--`로 종료 검증 추가. 전용 P0 회귀 테스트(`[M3b.2][P0] interactive argv 꼬리 …`) 신규: 꼬리 4개 순서(`--disallowedTools`·`mcp__*`·`--`·prompt), `--` 정확히 1개, prompt가 deny 값 영역 밖. 기존 테스트 삭제·완화 없음.
- **runner**(`scripts/m3b2-live-handoff.mjs`): 사후 argv 검증에 `argv.at(-2)==="--"`, `--disallowedTools mcp__* -- <prompt>` 구조, 마지막 인자가 이번 실행 고유 live acceptance 지시(readOk 경로/‘live acceptance’) 포함을 추가. 실제 Claude/TUI 미실행.
- **상태**: **M3b.2 live acceptance 재실행 대기**(PASS 아님). 첫 시도 무효 → 수정 후 사람이 재실행해야 실제 Hook 검증이 이뤄진다.
- 검증: build/tsc noEmit 클린, exec 75 + core 158 + acceptance 71 통과(argv P0 회귀: 기존 성공 테스트 강화 + 전용 P0 테스트 1개 신규), node --check·opt-in/non-TTY 게이트 exit 2.

## 2026-07-20 (V3 M3b.2 — offline 최종 보완)

여전히 실제 Claude/TUI/live Hook은 실행하지 않는다(offline seam). 승인 preview·collector 검증 fail-closed 보강.
- **승인 preview 전체 redaction**(`src/core/handoff.ts` `buildPreview`): 기존엔 task prompt head만 scrub했으나, cwd·trace 등 **모든 동적 문자열**이 secret 값을 담을 수 있으므로 조립한 최종 preview 전체를 scrub한다. 승인 화면에 secret 평문이 노출되지 않는다.
- **collector 검증 예외 정규화**: collector stat/readability 검증 전체를 try/catch로 감싼다. 파일 부재·디렉터리·stat/access 오류 모두 예외 throw 없이 scrub된 `setup_failed`로 정규화(preflight/spawn/handoff 기록 없음). production 기본 경로는 `PACKAGE_ROOT/dist/tools/hookCollector.js` 유지, 테스트용 `collectorPath` seam 추가. 일반 파일이며 읽을 수 있을 때만 통과.
- **테스트 정합성**: 기존 "collector 산출물 부재(exclusive-create 충돌)" 테스트를 실제 의미대로 "trace 파일 exclusive-create(wx) 충돌"로 이름 변경. collector 경로 부재·디렉터리 두 `setup_failed` 테스트 추가(각각 preflight/spawn/handoff 기록 없음·runtime 미생성 검증). 승인 preview 전체 scrub 테스트 추가(cwd에 secret sentinel 심어도 preview 평문 없음 + 거부 시 기록 없음). command wrapper의 `setup_failed`→exitCode=1 동작 유지.
- 검증: exec 75 + core 157 + acceptance 71 전부 통과. build/tsc noEmit/diff --check 클린.

## 2026-07-19 (V3 M3b.2 — Interactive handoff, offline)

문서 완료 → Claude Code 대화형(TUI) 핸드오프. 실제 Claude/TUI/live Hook은 실행하지 않는다(seam 주입).
- **handoff 코어**(`src/core/handoff.ts` 신규): `runHandoff` — 결정 시퀀스를 명시적 outcome union으로 반환한다.
  print → completed 확인 → summary/task-prompt 자동 갱신 → initialPrompt(128KB 초과 시 절대경로 읽기 지시로 대체) →
  missing binary(설치+재진입 안내) → non-TTY 차단 → **collector fail-closed 검증(setup_failed)** → 승인 게이트(preview) → **fail-closed preflight(빈 MCP config)** → Hook settings·trace 준비 → spawn.
  **부작용 경계**: completed 확인 이후 summary/task-prompt 갱신은 outcome과 무관하게 수행(문서 갱신 자체는 handoff 결정과 독립). 그러나 runtime 산출물 write·run_state.handoff 기록·interactive spawn은 **spawned 경로에서만** 발생하고, print/reject/setup_failed/non_tty/missing_binary/preflight_failed/spawn_failed는 이들을 남기지 않는다.
- **명령/CLI**: `harness handoff --project <p> [--cwd <serviceRepo>] [--print] [--yes]`(`src/commands/handoff.ts` 신규),
  `harness run ... --handoff [--cwd]`(run이 completed일 때만). `src/cli.ts`·`src/commands/run.ts` 배선.
- **대화형 격리 spawn argv**(현재 구현): `--strict-mcp-config --mcp-config <runtime/mcp-config.json> --settings <runtime/hook-settings.json>
  --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --disallowedTools mcp__* -- <initialPrompt>`. 가변 인자 `--disallowedTools`가 프롬프트를 deny 값으로 소비하지 않도록 `--`로 옵션 파싱을 종료하고 initialPrompt를 positional로 전달한다(`--`는 2026-07-20 argv P0 수정으로 추가). `--add-dir <contextRoot>`는 planning 문서(docs/*.md) 접근용(2026-07-20 P0-1 수정으로 추가). **`-p`/stream-json 없음, `stdio:"inherit"`.**
  env: `HARNESS_TOOL_*`(이름만) + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **fail-closed preflight 보강**(`src/tools/preflight.ts`): `--setting-sources ""` argv + child env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `emptyConfig` allow-empty 경로(expected 서버/도구=[], ambient 하나라도 보이면 차단). 기존 profile `no_mcp_binding` 거부·M3a 의미 불변.
- **allow-empty config**(`src/providers/claudeCodeMcpAdapter.ts`): `buildEmptyMcpConfig`/`writeEmptyMcpConfig`(dir 0700/file 0600). 기존 buildMcpConfig 불변.
- **Hook settings 공식 exec form**(`src/tools/hookSettings.ts`): shell 문자열 조합 → `command`=node 실행 파일, `args`=[collectorPath, hookKind(, "deny")].
  collector는 배포 가능한 `dist/tools/hookCollector.js` 절대경로. settings에 secret 값 없음. `shellQuote`는 handoff 재진입 명령용으로 유지.
- **run_state.handoff**(optional): `{launched_at, cwd, prompt_bytes, trace_path, runtime_dir}` — **interactive child가 실제 spawn된 경우에만** 기록.
  print/reject/preflight 실패/spawn 실패/non-TTY/missing binary에서는 미기록. 종료코드·completed 상태 불변.
- **산출물**: `projects/<p>/outputs/runtime/<handoff-id>/{mcp-config.json,hook-settings.json}` + `outputs/tool-trace/<handoff-id>.jsonl`(gitignore 추가). raw payload/transcript 미저장.
- **P0/P1 보완**:
  - **collector 경로 P0**: import.meta.url 상대 계산 제거 → 항상 `PACKAGE_ROOT/dist/tools/hookCollector.js`(dev tsx·prod 동일). spawn/preflight 전 존재·일반 파일 검증, 없으면 `setup_failed`(build 안내).
  - **파일 권한 P0**: ToolTrace JSONL을 spawn 전 빈 0600 파일로 사전 생성(collector append 후에도 0600 유지). hook-settings/mcp-config/tools-snapshot 실제 stat 0600, runtime/trace dir 0700. 기존 파일·symlink는 exclusive-create(`wx`)로 fail-closed. 기본 handoff id는 `randomUUID` 포함(테스트 seam 유지).
  - **secret/redaction**: `process.env`에서 이름이 TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH 형태이고 값이 있는 항목의 **이름만** redaction refs로 파생 → `HARNESS_TOOL_SECRET_REFS`(이름만)·collector 값 마스킹. preflight엔 `redactNames`(scrub 전용, child env 미전달) 추가. spawn/setup/preflight 오류·로그·outcome을 `redactSecrets` 처리.
  - **setting-sources 보완**: `--setting-sources ""`로 서비스 레포 CLAUDE.md 자동 로드 안 되므로 initialPrompt에 "AGENTS.md·CLAUDE.md 존재 시 먼저 읽고 준수" 명시. managed policy 우회는 계속 금지.
- **테스트**: `src/core/handoff.test.ts`(13) + `src/commands/handoff.test.ts`(4, `run --handoff` completed/failed stub 포함) + preflight(emptyConfig·setting-sources·env·mode·redactNames) + hookSettings exec form. sentinel 평문 부재: settings·generated env·preflight 오류·spawn 오류·실제 collector append JSONL. `test:core`에 `src/commands/*.test.ts` 추가. acceptance Test 12(handoff).
- 검증: exec 75 + core 154 + acceptance 71 전부 통과. build/tsc noEmit/diff --check 클린.
- **`runHandoff`는 명시적 outcome union 반환**(printed/not_completed/missing_binary/non_tty/rejected/setup_failed/preflight_failed/spawn_failed/spawned). 산출물 write·run_state 기록은 spawned 경로에서만.
- **남은 M3b.2 live acceptance**: 실제 Claude Hook 수동 검증(`--setting-sources ""` 수용, exec-form Hook 6종 등록, 6 payload, trace redaction·0600, TUI 유지·stream-json 미사용). **M3c(shadcn read)는 live 통과 후.**

## 2026-07-19 (V3 M3b.1 — Interactive HookTrace 기반, offline)

Hook payload→공통 ToolTrace JSONL 변환 기반. 실제 Claude/TUI/handoff/stream-json 미실행·미구현(M3b.2).
- **ToolTrace 모델**(`src/tools/toolTrace.ts` 신규): 6 이벤트(tool_requested/permission_requested/tool_succeeded/tool_failed/tool_denied/session_end) + 필수 필드(version/timestamp/source/profileId/sessionId/callId/event/status/toolName/server/durationMs/resultBytes/sanitizedInput/inputTruncated/error/reason/denialMode/sessionEndReason). `normalizeHook`(6 Hook 정규화) + `toRunEvent` 매핑(tool_start/tool_end/tool_denied; permission_requested·session_end→없음). **RunEvent reporter 실시간 emit 안 함**.
- **collector**(`src/tools/hookCollector.ts` 신규): stdin payload→정규화→JSONL. PreToolUse deny→tool_denied+exit2, PreToolUse audit 기록 실패→exit2(차단), 사후 Hook 실패→exit1(경고), 정상 stdout 미사용. env 계약 `HARNESS_TOOL_TRACE_PATH/PROFILE_ID/SECRET_REFS(이름 JSON)/MAP(exact)`.
- **settings**(`src/tools/hookSettings.ts` 신규): 6 Hook 정확 등록 + deny matcher 선택. argv/env에 secret **이름만**.
- **trace.ts 강화**: `sanitizeValue` — 민감 key(authorization/cookie/token/key/secret/password/credential) 재귀 마스킹 + secret 값/credential 패턴(URL query 포함). 병렬 append 라인 원자성 주석.
- **규칙**: transcript_path·raw tool_response 미저장(byte 수만), 입력/오류 크기 상한, MCP server는 exact tool map으로만 판정(추측 금지), secretRefs 실제 환경값 redaction.
- **승인 의미(한계 명시)**: PermissionRequest는 permission_requested만, PermissionDenied는 auto-mode denial만. PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없어 callId=null·synthetic ID 미생성, `permissionOutcomeObservable:false`로 수동 승인/거부 관측 불가 명시. SessionEnd는 종료 사실만 기록(unresolved·승인 결과 추측 금지). 타입·테스트·문서 반영.
- **테스트**(+24): 각 Hook 정규화, 민감 key/secret/URL query/중첩 배열 redaction, 크기 상한, malformed/oversized stdin, deny exit2, 승인 오판 금지, PermissionDenied auto 의미, 병렬 collector append 유효성, settings 6 Hook·secret 평문 부재, 기존 trace/RunEvent 회귀 없음.
- **P0/P1 하드닝**: collector fail-closed(`parseConfig` 엄격 검증·JSON fallback 금지, PreToolUse/PermissionRequest 실패 exit2·사후 exit1, 전 경로 catch, stack/raw env/secret 미출력), payload 계약 검증(hook_event_name 일치·session_id 필수, PermissionRequest=tool_name+tool_input 필수·tool_use_id 없음, tool hook=tool_use_id 필수, deny는 PreToolUse만), **SessionEnd는 종료 사실만 기록**(공식 payload에 correlation ID 부재로 unresolved·승인 결과 추측 금지), UTF-8 byte 상한(멀티바이트 경계 보존)·재귀 depth 상한, settings `nodePath/collectorPath` shell-safe quoting + `denyMatchers[]` dedupe.
- 검증: exec 75 + core 131 + acceptance 63 전부 통과.
- **남은 M3b.2**: handoff command/spawn, settings 파일 write·claude 실행, 실제 Claude Hook 이름 대응 실측. 대화형은 `stdio:inherit`+Hooks만(stream-json은 M3a preflight 전용, 대화형 미사용). `toRunEvent`는 post-session/테스트용(실시간 emit 없음).

## 2026-07-19 (V3 M3a — live acceptance 실측 PASS)

수동 live runner(`scripts/m3a-live-preflight.mjs`, `HARNESS_LIVE_M3A=1` 필수)로 실제 Claude 1회 실측.
- **환경**: Claude Code **2.1.215**. headless preflight(`claude -p --output-format stream-json --strict-mcp-config ...`), interactive 미실행.
- **결과 (PASS, exit 0)**:
  - `system/init` expected server `connected`.
  - 도구 `mcp__expected__read_thing` **정확 일치**(누락·추가·중복 없음).
  - 임시 service cwd의 ambient `.mcp.json` canary 서버/도구 **미기동**(strict-mcp-config 격리 확인, canary pid-file 부재).
  - sentinel(전용 env + cwd 경로)·config·반환/저장 snapshot **redaction 통과**(cwd `svc-***`, 평문 노출 0).
  - expected fixture 5초 내 종료, fixture·임시 디렉터리 **잔존 없음**.
- **범위**: 이 결과는 **Claude Code 2.1.215 실측**이며, CLI 버전 변경 시 재검증 필요(플래그·`system/init` 스키마·strict 격리 동작이 버전 의존).
- runner/fixture는 수동 live acceptance 전용(CI·자동 파이프라인 비대상). flaky 완화로 offline preflight 테스트 기본 timeout 1500→5000ms(hard-timeout 전용 700ms 유지).
- 다음: **M3b 계획 검토**.

## 2026-07-19 (V3 M3a — live 전 보안 보완)

실제 claude 미실행. M3a offline 위에 보안 5건 강화.
- **npx 고정 버전 검증**: npx 실행 package는 정확한 `pkg@X.Y.Z`(scoped 포함)만 허용. `package`/`@next`/`@^`/`@~`/`@*`/`@1`/`@1.2` → `unpinned_npx`, `@latest` → `latest_forbidden`(유지). 절대경로 npx 동일 적용. 일반 node/local executable엔 pin 규칙 미적용.
- **config 검증 강화**: 중복 파생 `mcp__server__tool` 거부(dedupe 금지, `duplicate_tool`), transport는 stdio/http만(`bad_transport`), 혼합(stdio+url / http+command) 거부(`mixed_transport`), secretRefs 실제 값이 command/args/url에 있으면 기록 전 거부(`secret_in_config`, 값 미노출), credential 형태 URL query/arg 거부(`credential_in_config`).
- **preflight env 격리**: `process.env` 전체 전달 폐지 → allowlist(PATH/HOME/USER/SHELL/TMPDIR/LANG 등) + `profile.secretRefs` 선언분만 + `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false` 강제. 스텁 통신은 production allowlist와 분리된 명시적 `testEnv` seam으로만. 미선언 token/key/secret/password 형태 변수 미전달 테스트 추가.
- **snapshot redaction 정합**: 반환 `PreflightSuccess.snapshot`도 redacted(저장 파일과 동일). 실패 시 tools-snapshot.json 미생성 테스트 추가.
- **타입 정합성**: init을 직접 만드는 exec 테스트 fixture 9곳에 `mcpServers: []` 추가.
- 검증: exec 75 + core 94(+20) + acceptance 63 전부 통과.

## 2026-07-19 (V3 M3a — Headless MCP preflight, offline)

실제 claude 미실행, stub 기반 offline acceptance까지. M3b(Hook/TUI)·M3c(shadcn) 미구현.
- **system/init 파서 확장**: `types.ts`에 `McpServerStatus{name,status,connected}` + init 이벤트에 `mcpServers` 추가. `streamParser.ts`가 `mcp_servers` 정규화(connected는 status==="connected"만; pending/failed/needs-auth는 false). 기존 exec/mockExecProvider init에 `mcpServers:[]` 보강. raw는 SessionEvent에만, snapshot 미저장.
- **MCP config 생성**(`src/providers/claudeCodeMcpAdapter.ts` 신규): profile MCP binding·servers 검증 → `buildMcpConfig`/`writeMcpConfig`. binding server가 servers에 없음/중복 거부, stdio=command 필수·http=HTTPS url 필수, `@latest` 거부, 참조된 서버만 포함, 각 서버 `alwaysLoad:true`, secret 값 미기록, runtime에 mcp-config.json + SHA-256. `.gitignore`에 `projects/*/outputs/runtime/`.
- **Headless preflight**(`src/tools/preflight.ts` 신규): `HARNESS_CLAUDE_BIN` 호출시점 읽기. argv `-p/--output-format stream-json/--verbose/--no-session-persistence/--strict-mcp-config/--mcp-config/--tools ""/--permission-mode plan`, cwd=서비스경로, env `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false`, hard timeout, TUI 미실행. init 수집 후 의도적 종료(실패 오판 안 함).
- **Snapshot 검증**(fail-closed): expected 서버명 정확 비교 + 전부 connected, binding 파생 mcp 도구명 정확 비교. 누락·추가(canary)·중복 → typed `PreflightError`. 성공 시 tools-snapshot.json에 `profileId/cwd/timestamp/configHash/servers(status)/정렬 tools`만 저장, 오류·snapshot redaction. 실패 시 성공 result 미반환.
- **테스트**(+23): streamParser mcpServers 정규화, adapter 검증 9, preflight offline 13(exact 성공·canary server/tool·missing/duplicate tool·pending/failed/needs-auth·no-init/malformed/non-zero/timeout·argv strict/config/tools-empty/plan·@latest·snapshot secret redaction). 기존 stream parser 테스트 회귀 없음.
- 검증: exec 75 + core 74 + acceptance 63 전부 통과. M2.1 MCP fail-closed 유지(preflight는 별도 경로).
- **live 전 남음**: 실제 claude 구독 호출로 argv·`system/init`·strict 격리·canary 실측, alwaysLoad/env 강제의 실제 동작 확인.

## 2026-07-19 (V3 M2.1 — P0 보완: 정책 전달 배선 + secret redaction + MCP fail-closed)

M3 이전 선행 보완 3건. M3a/b/c·MCP config 생성·stream-json·Hook·shadcn 미구현.
- **정책 실제 전달**: `ProviderExecContext{claudeArgs, redactNames}`(`provider.ts`). runWorkflow가 compile된 policy를 보존 → runAgent → `provider.generate(input.execContext)`. claudeCodeProvider가 `execContext.claudeArgs`를 실제 spawn argv에 병합. mock/anthropic 무시, 미지정 시 argv·경로 완전 불변(회귀 테스트).
- **MCP fail-closed**: `hasMcpBinding(profile)`(`profiles.ts`). runWorkflow가 MCP binding profile을 run_start·run_state 이전에 거부(M3 preflight/snapshot 이후 사용). loader/compile은 거부 안 함(M3가 로드 가능). 테스트용 `toolProfilesPath` seam 추가.
- **secret redaction**: invalid secretRef 오류가 값 대신 index만 출력(`redact.ts`). secret 값은 execContext로 전달 안 함 — 이름(redactNames)만 넘기고 claudeCodeProvider가 내부에서 `collectSecretValues` 조회. spawn/non-zero 오류의 stderr/stdout을 `redactSecrets` 통과(이름 없어도 Authorization/token/password 패턴 적용). `HARNESS_CLAUDE_BIN`/timeout 호출 시점 읽기로 전환(스텁 테스트 가능).
- **JSONL writer**: `createJsonlWriter(path, {redact, redactValues})` — record의 모든 문자열 재귀 sanitize 후 stringify, 원본 record 불변. 기존 호출 호환(기본 raw). M3 ToolTrace 스키마·Hook 미배선.
- **테스트**(+11): 실제 spawn argv 포함/미지정 회귀(스텁), 오류 redaction, invalid secretRef sentinel 부재, JSONL 중첩·배열 redaction+원본 불변, MCP run-level 거부(loader/compile 성공), golden snapshot 유지.
- 검증: exec 74 + core 52 + acceptance 63 전부 통과.

## 2026-07-17 (V3 M2 — Capability/ToolProfile 정책 계층)

types+loader+compile+fail-fast+redaction+`--bare` argv. 실 MCP/shadcn/Tavily/stream-json/Hooks/Research Adapter 미구현.
- **Capability 3계층**(`src/tools/capabilities.ts`): active(7)/reserved/deny. `repo_write_direct` 제거 → reserved(`local_workspace_write`,`pull_request_create`) / deny(`remote_repository_write`,`pull_request_merge`,`production_deploy`,`billing_live`,`design_write`) 분리.
- **ToolBinding 4종**: builtin{tools[]}/internal_adapter{adapter,operations[]}/mcp{server,tools[]}/cli{command,operations?}. profile만 보고 실행 주체 판별.
- **ToolProfile + loader**(`src/tools/profiles.ts`): `bindings` 필드 추가. `exposedTools`는 입력이 아니라 compile이 bindings에서 파생(builtin ∪ mcp__server__tool). 수동 구조+시맨틱 validator(신규 런타임 의존성 0). deny/reserved/unknown capability·binding 누락·orphan·preapproved⊄exposed·exposed∩denied·secretRef 값형태 → 로드 거부.
- **compileToolProfile**: profile→CLI 플래그(exposed내장=`--tools`, preapproved=`--allowedTools`, denied=`--disallowedTools`, permissionMode=`--permission-mode`, bare=`--strict-mcp-config`)/생성 mcp-config/내부 어댑터·Hook 정책/redact 목록 4버킷. 인자 조건부 deny=PreToolUse Hook(산출만).
- **Binding 기반 fail-fast**(`assertPolicyExecutable`): builtin→provider 내장도구, mcp→provider MCP, internal_adapter→Adapter Registry(`src/tools/adapters.ts`, M2 빈 목록), cli→실행 환경. `runWorkflow` 최상단(run_start·run_state 이전)에서 `--tool-profile` 지정 시 검증. `assertProviderSupports` 폐기.
- **ProviderCapabilities**(`src/providers/capabilities.ts`): mock/claude-code/anthropic 능력 테이블.
- **secret**: `src/tools/redact.ts` — secretRef 이름 형식 검증 + Authorization/key= 패턴 redaction.
- **Planning `--bare`**: `claudeCodeProvider.buildClaudeArgs` 추출(정책 args 병합, 기본 동작 보존). 일반 문서=`--tools ""`, 로컬읽기=`--tools "Read,Glob,Grep"`+`--permission-mode plan`, strict empty fallback=`--mcp-config <path>`. argv 생성·검증까지(snapshot fallback 판정은 M3).
- **registry**: `registry/tool_profiles.json`에 `planning-none`, `planning-local-readonly`만. Tavily/shadcn은 실행기 붙는 M3·M4까지 미등록. `schemas/tool_profile.schema.json`(계약 문서, 런타임 미실행). `package.json.files`에 `schemas` 추가.
- **테스트**: `tests/fixtures/tool-profiles/`(배포 제외) + `src/tools/{capabilities,redact,profiles}.test.ts`, `src/providers/claudeCodeBare.test.ts`, `src/core/toolProfile.test.ts`(run fail-fast + **golden snapshot 회귀**: 가변 메타 제거 후 비교).
- **M1 영향 없음**: RunEvent/step_timings/trace 골격·RunState 무변경. profile 미지정 시 전 경로 no-op → mock 출력 불변(golden 확인).
- 검증: exec 74 + core 37 + acceptance 63 전부 통과.
- **다음 M3**: handoff + shadcn read + stream-json 파싱(tool 이벤트 실 방출·trace 배선) + mcp-config write·claude 전달 + `system/init` snapshot 격리 실측.

## 2026-07-17 (V3 M1 — 진행 이벤트 모델 + tool 이벤트 골격 + JSONL trace 골격)

F2(진행 가시성) + MCP M1(tool 이벤트 타입/trace 골격). 실 MCP/ToolProfile/stream-json/Hooks/Tavily/shadcn 미구현.
- **RunEvent/ProgressReporter 이벤트 모델**(`src/core/progress.ts` 신규): run_start/step_start/step_end/gate_jump/run_end + tool_start/tool_end/tool_denied(타입 골격, 방출 없음) + note{level}. 기존 `start/note/stop` 인터페이스를 이벤트 모델로 교체.
- **runWorkflow 배선**: 모든 top-level step(agent/critic/revise/spawn/gate/approval)에 step_start/step_end. index 1-based, total=top-level step 수. critique 내부는 kind(critic/revise)+round로 구분. 실제 jump일 때만 gate_jump. run_start에 resumeFrom. **run_start→…→run_end를 try/finally로 감싸 예외에도 step_end{ok:false}+run_end{failed}+렌더러 정리 보장.**
- **step_timings 저장**(RunState 신규 필드): agent_id/kind/started_at/elapsed_ms/ok. resume 시 완료 step 타이밍 보존, 재실행 없음.
- **렌더러 재작성**(`src/commands/progress.ts`): 이벤트 소비형. 현 CLI 출력 계약 보존(TTY 스피너/비-TTY 라인/✓ 라인 동일). gate/approval은 스피너 미가동(stdin 충돌 방지, F2.2).
- **범용 JSONL writer 골격**(`src/tools/trace.ts` 신규): ToolTrace 스키마 미고정·runWorkflow 미배선(M3+). 임의 레코드 append/read만.
- **테스트**: `src/core/progress.test.ts`(이벤트 순서·critique·gate jump·실패/resume·TTY/non-TTY 렌더러 계약) + `src/tools/trace.test.ts`(JSONL 왕복). `test:core` 스크립트 추가(HARNESS_WORKSPACE 격리).
- 검증: exec 74 + core 8 + acceptance 63 = **전부 통과**. 기존 mock 출력 계약 회귀 없음.
- **미구현(다음)**: M2 Capability/Profile 기반, M3 handoff+shadcn read+stream-json 배선(tool 이벤트 실 방출·trace 배선은 여기서).

## 2026-07-17 (V3 M0 — 문서 동기화 + provider 하드코딩 수정)

V3 착수 전 문서-코드 불일치 해소. 계획 승인 후 최소 수정.
- **taskPrompt provider 버그 수정**: `taskPrompt.ts:70` 하드코딩 `provider: mock` → `state?.provider ?? "미실행"`. mock/claude-code/미실행 3케이스 실측 확인.
- **CLI 버전 단일 원본화**: `cli.ts` `--version` `0.1.0` → `package.json` 런타임 읽기(`import.meta.url` 기준). dev·dist 동일, 드리프트 구조상 불가 → 별도 일치 테스트 불필요. 설명도 현 범위로 갱신. `--version`=2.6.0 확인.
- **CLAUDE.md 교정**: v1 단정 문구 → 현행 범위(문서 자동화 + exec/mission, 승인·권한 게이트 내 실행). `읽지 말 것`에 활성 V3 2문서 예외 추가. V3_KICKOFF_SUPERSEDED 참조 경로 정정.
- **파일 이동**: `docs/backlog/V3_KICKOFF_SUPERSEDED.md` → `docs/archive/`(과거 기록, 구현 근거 아님).
- **V3 HANDOFF 문서 각주**: v2.4 전제 → v2.6 구조 동일 각주 추가.
- 검증: `npm test` → acceptance 63/63 + exec 74/74 전부 통과. 테스트 완화·삭제 없음.
- **남은 불일치(후속)**: ① README v1/v2.6 범위 서술 낡음 ② V3 두 문서가 이미 구현된 exec/mission 실행 계층 미참조 ③ package.json.files는 M2에서 registry/schemas 추가 시 갱신.
- M1(V3 F2 + tool 이벤트 골격) 착수 가능. 별도 승인 대기.

## 2026-07-09 (디자인 레이어 킥오프 — P1~P5)

Phase 0 탐색 보고 → 승인(4개 결정: 별도 design 에이전트 / DESIGN.md에 tokens 펀치+추출 / node·tsx 린트 / {approval}+design_gate) 후 Phase별 커밋.
- **P1 에이전트별 헤더 스키마**: `validateAgentOutput(md, extra[])`, `AgentDef.required_headers`, pm=PRD·tech_lead=Tech Spec 등록 + 프롬프트 명시. mock에서 누락→재생성 루프 발동 확인.
- **P2 design 에이전트 신규**: `agents/design_agent.md`(DESIGN.md 9헤더 + 3계층 tokens 규칙), registry 등록(token_output). 산출 md의 ```json→docs/tokens.json 추출(`extractTokensJson`). 카운트 7→8.
- **P3 워크플로우 통합 + 디자인 게이트**: mvp-planning·full-predev에 design + {approval}(UX→Design→[승인]→Tech). `ApprovalDef.tokens_path`, `RunState.design_gate{status,tokens_hash}`(승인 시 sha256). mock e2e로 흐름·기록 확인.
- **P4 task-prompt 디자인 규칙**: DESIGN.md+tokens.json 존재 시 토큰 기반 구현 규칙 섹션 주입(부재 시 무영향).
- **P5 토큰 린트**: `scripts/token-lint.mjs`(node) — raw hex·primitive 직접참조·tokens 계층/참조/순환 정적 검사, ignore 예외, exit 0/1. acceptance Test 11 추가.
- 검증: acceptance **63/63**(신규 6), exec 74/74. README 갱신.
- **미완(§7)**: 실 provider e2e 1회(실제 DESIGN.md/tokens.json 산출+token-lint 통과 확인) — 토큰 비용 있어 사용자 승인 대기. 파이프라인 기계 검증은 mock으로 완료.

## 2026-07-09 (v4 후속 — StatusBoard, 나머지는 검증 후 보류)

- **필요성 검증 먼저**: 남은 v4 4개(Mailbox/tell/SPLIT/StatusBoard)를 냉정히 평가 → one-shot(Model A)엔 mid-session 상호작용이 없고 hub-spoke 설계가 세션 간 통신을 최소화하므로 Mailbox/tell/SPLIT은 근거 없는 선투자로 판단 → **보류(필드 관측 후)**. StatusBoard만 관측성 실통증(병렬 로그 뒤섞임)이라 착수.
- **statusBoard.ts**: 세션당 한 줄 상태판(코딩/게이트/리뷰/병합/완료/보류/실패), TTY 제자리 갱신·비TTY 전이 로그. ProgressReporter 일반화.
- **onPhase 훅**: SessionRunner에 단계 전이 훅 추가(coding/gate/review/merging/done) → 병렬·순차 미션에 threading → 미션 CLI가 StatusBoard로 렌더.
- 테스트: exec 단위 **74/74**(StatusBoard 3 추가) + acceptance 57/57. 실토큰 스모크는 생략(표시 계층, 병렬 실행은 기검증).
- 실행 계층 상태: v3·v3.5·v4(병렬 코어+상태판) 완료. Mailbox/tell/SPLIT만 필드 관측 후 판단.

## 2026-07-09 (실행 계층 v4 — 병행 오케스트레이션)

- **mergeCoordinator.ts**: 직렬 안전 병합(ARCH §2) — 브랜치마다 base 머지→L1 재게이트→ff 푸시, 충돌/게이트실패는 그 항목만 보류. 성공 시 worktree 정리.
- **parallelMission.ts**: `runParallelMission` — 의존 없는 태스크를 웨이브로 묶어 concurrency 한도 내 **병렬 실행**(runPool), 각자 worktree/ownership 격리, merge:false·keepWorktree로 브랜치에 커밋만 → 웨이브 끝나면 코디네이터가 직렬 병합 → 다음 웨이브. 강등/rate limit 대기 재사용.
- **harness mission --parallel [--concurrency N]**.
- **실세션 2 코더 동시 스모크 PASS**: 독립 유틸 2개(strutil/numutil) 동시 구현→리뷰→둘 다 develop 병합(최대 동시 세션 2 확인).
- **버그 2건 수정(스모크·flaky 테스트가 잡음)**: ① STATUS.md(세션 내부 통신, ARCH §3.3)가 병렬 병합 시 add/add 충돌 → 공용 git exclude로 커밋·병합·diff에서 제외. ② 동시 `git worktree add`가 .git 락 경합으로 flaky → worktree 생성/제거를 뮤텍스로 직렬화(세션 작업은 병렬 유지).
- 테스트: exec 단위 **71/71**(mergeCoordinator 2·parallelMission 3 추가, 3회 반복 안정) + acceptance 57/57.
- 남은 v4: Mailbox·tell·SPLIT·StatusBoard 고도화(병렬 코어는 완성). 설계 미결 Q4·Q5는 필드 튜닝.

## 2026-07-09 (실행 계층 §9-7·§9-8 — v3.5 미션 모드 완성)

- **modelPolicy.ts**: 강등 사다리 B(전부 Opus)/C(난이도 라우팅)/A(구현 Sonnet), 리뷰·계획은 Opus 고정. shouldDegrade(누적 대기 임계).
- **mission.ts**: runMission — 브리프 태스크 루프(dep 순서, 사전승인=autoApprove, 코더→L1→L3→develop 자동 병합), rate_limit_event 기반 auto 강등, rate limit 체크포인트(다음 태스크 직전 resetsAt까지 대기), MISSION_REPORT 렌더. turn 예산 가드는 SessionRunner 리뷰 루프에 추가.
- **briefGenerator.ts**: 목표→태스크 분해(플래너 Opus, JSON 파싱, maxTasks 가드).
- **harness mission --goal**: 브리프 생성→승인(유일 게이트)→자율 실행→outputs/MISSION_REPORT.md.
- **실세션 미션 e2e PASS**: 목표 분해(1태스크)→코더(math.js+math.test.js+package.json)→L3 리뷰(Critical0)→develop 병합, 실제 rate_limit로 B→C 강등 실증. **버그 수정**: 미션 기본 sessionId가 비-UUID라 코더 세션 실패(no_changes)→randomUUID로. 마지막 태스크 뒤 불필요 대기→다음 태스크 직전으로 이월.
- 테스트: exec 단위 **66/66**(modelPolicy 4·mission 5·briefGenerator 6 추가) + acceptance 57/57.
- 남은 설계 판단: DESIGN_QUESTIONS Q4(병합 전략)·Q5(rate limit 의미론) — 필드 튜닝.
- **→ 실행 계층 v3(대화형)+v3.5(미션 모드) 구현 완료.** 남은 §9 항목 없음(v4 병행은 별도 tier).

## 2026-07-09 (실행 계층 §9-6 — L3 리뷰어 + revise 루프)

- **reviewer.ts**: 신선 컨텍스트 L3 리뷰어(Opus 고정, plan 모드 읽기전용, --fork 금지). diff+SPEC+계약 인라인 → `### Critical` 스키마(red_team과 동일) → extractCriticalRisks 재사용.
- **SessionRunner 통합**: L1 게이트·커밋·diff 후 리뷰 루프 — Critical이면 코더에 --resume revise 주입 → 재게이트·재리뷰(max 2R) → 소진 시 review_deferred(병합 차단). `finalize()`/`consumeTurn()` 헬퍼로 재사용. SessionOutcome.reviews 기록.
- **harness exec --review [--review-rounds n]**.
- **실세션 e2e PASS**: 코더가 sum.js+sum.test.js 생성 → plan 모드 리뷰어 정상 판정(Critical 0) → develop 병합. plan 모드 리뷰어가 파싱 가능한 판정 텍스트를 냄을 실검증.
- 테스트: exec 단위 **51/51**(reviewer 3 + review 루프 3경로: 통과/revise후통과/라운드소진) + acceptance 57/57.
- 다음: §9-7 미션 모드(브리프·사전승인·defer·강등·turn 예산) → §9-8(자동 병합·rate limit 재개·MISSION_REPORT).

## 2026-07-09 (실행 계층 §9-5 — v3 대화형 단일 실행 완주)

- **§9-5 독립 조각**: `promptCompiler.ts`(SessionSpec→착수 프롬프트, 하이브리드) + `diffPreview.ts`(base 대비 변경 수집·요약) + `approvalQueue.ts`(승인 직렬화 FIFO + approve/reject/defer). SessionSpec에 task/inputs/contractPaths/dod 추가.
- **§9-5 통합**: `sessionRunner.ts`(worktree→권한컴파일→프롬프트→세션실행→L1게이트→자기브랜치 커밋→diff→승인→base 병합) + `harness exec` CLI(--task/--role/--base/--yes/--no-merge 등, stdin 승인 y/d/N, 이벤트 마일스톤 출력).
- **실제 세션 e2e 스모크 PASS** (임시 repo, 구독 토큰): 진짜 claude 세션이 hello.txt 생성 → 게이트 통과 → develop 병합, `develop:hello.txt="harness\n"` 검증. → **권한 컴파일러 `--settings` 실 CLI 수용 확인**(§9-3 미검증 항목 해소).
- settings는 worktree 밖(repoRoot/.harness/sessions)에 써서 세션 diff 미오염(테스트가 잡은 버그 수정).
- 테스트: exec 단위 **45/45**(promptCompiler·diff·queue·SessionRunner 오케스트레이션 4경로 mock+실git) + acceptance 57/57.
- 다음: §9-6 Opus 리뷰어 세션(L3) + revise 루프.

## 2026-07-09 (실행 계층 §9-3·§9-4 + ARCH v0.3 결정 반영)

- **ARCH v0.3 확정 반영**(페이블): Q1=Model A(one-shot+resume, B기각), Q2=하이브리드 프롬프트, Q3=그레이스1턴→DEFERRED. claudeCliProvider 잠정 딱지 제거, DESIGN_QUESTIONS 해소 마킹.
- **§9-3 권한 컴파일러**: `registry/permission_policy.json`(PERMISSION_POLICY §7 기계본) + `permissionCompiler.ts`(SessionSpec+정책→allow/ask/deny 규칙 + Claude Code settings + T3 hookDenyPatterns + materializeSettings). claudeCliProvider `--settings` 연결. SessionSpec에 ownership/forbidden/settingsPath 추가.
- **§9-4 worktree + L1 게이트**: `worktree.ts`(세션당 git worktree/브랜치 생성·제거·조회, develop 기준) + `machineGate.ts`(typecheck/lint/test/build 탐지·실행, 없으면 skip) + `runProcess.ts`(버퍼링 헬퍼). `.harness/` gitignore.
- 테스트: exec 단위 **29/29**(파서/mock/권한/worktree(실git 임시레포)/게이트) + acceptance 57/57. `npm test`=exec+acceptance. dist 재빌드(테스트·fixture 제외).
- 다음: §9-5 대화형 게이트(ApprovalQueue)+diff 미리보기+tell+PromptCompiler → v3 acceptance.

## 2026-07-08 (실행 계층 구현 착수 — §9-1·§9-2)

- 역할 분담 확정: **구현은 이 세션, 설계는 Fable 세션.** 설계 필요 지점은 `docs/reference/EXECUTION_DESIGN_QUESTIONS.md`에 정리만.
- **§9-1 CLI 실측**(`EXECUTION_CLI_RECON.md`): claude 2.1.204 플래그 매칭 — stream-json/resume/session-id/permission-mode(acceptEdits)/allowedTools/append-system-prompt/model/fallback-model/add-dir/agents 전부 존재. 어긋난 전제: `--max-turns` 부재 → 오케스트레이터 이벤트 카운팅. print+stream-json은 `--verbose` 필수.
- **stream-json 스키마 프로브**(승인 후 실호출 1회, $0.06): 이벤트 타입별 필드 박제. rate_limit_event(resetsAt/rateLimitType) 실존 → 강등·체크포인트 실데이터 구동. hook_response로 T3 거부 실시간 관측. 구독에서도 total_cost_usd/modelUsage 채워짐.
- **§9-2 ExecutionProvider 골격**(`src/exec/`): types(SessionEvent 정규화·SessionSpec·ExecutionProvider) + streamParser(NDJSON→이벤트, 청크 버퍼링) + eventQueue(async 스트림) + mockExecProvider(무과금 재생) + claudeCliProvider(Model A 잠정, --resume 체이닝). 단위 테스트 10/10(`npm run test:exec`, 실측 fixture 기반). `npm test`=exec 10 + acceptance 57. build/dist 정리(테스트·fixture 제외).
- **설계 미결**: 세션 수명 모델 A(one-shot+resume) vs B(지속형 stdin) = DESIGN_QUESTIONS Q1(블로킹). initialPrompt 조립(Q2), turn 예산 초과 동작(Q3).

## 2026-07-08 (진행 표시 UX + 실행 계층 설계 핸드오프)

- **진행 표시자(ProgressReporter) 추가.** run 중 각 agent LLM 호출이 침묵하던 문제 해결. TTY면 한 줄 스피너(`⠹ [2/5] research 실행 중… 0:42`) + 경과시간 제자리 갱신, 비TTY(파이프/로그)면 `▶ 시작` 줄만 폴백. 완료 라인에 `[i/N]` 카운터 + 경과시간(`[2/5] ✓ research → ... (42s)`).
  - core는 순수 유지: `runWorkflow.ts`에 `ProgressReporter` 인터페이스 + `reporter?` 주입, 스피너 구현은 CLI 계층(`src/commands/progress.ts`). 외부 패키지 0. 재생성 경고는 `reporter.note`로 스피너 훼손 없이 출력.
  - mock `npm test` 57/57 유지, tsc 통과, dist 재빌드.
- **실행 계층 설계 브리핑 문서 작성** (`docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`). 창업자 비전("문서→자동 Claude Code 실행→병행/다중 라이브 세션→라이브 분화, 큰 이슈만 예/아니요")과 현재 v2.6.0(앞쪽 절반=문서 생성만) 갭 정리 + 재사용 뼈대(승인게이트/fanout/claude-code provider/ProgressReporter) + 설계 세션이 답할 질문. **설계 자체는 별도 Fable 모드 세션에서 진행 예정.**

## 2026-07-06

- 레포 구조 정리, registry JSON 생성, spec 불일치 수정
- git init + 원격(agrade1) 연결 + 초기 커밋/푸시 (아이디어 문서 IDEA_*.md는 .gitignore 제외)
- [1] scaffold: package.json/tsconfig/src/cli.ts, 최소 의존성(commander/tsx/typescript) 설치, 5개 명령 뼈대 + tsc 빌드 통과
- [2] registry 로드: src/core/paths.ts(REPO_ROOT), src/core/registry.ts(agent/workflow 로더 + 타입 + find 헬퍼)
- [3] harness list: src/commands/list.ts, acceptance Test 2 통과 (7 agents / common prompt 존재 / 4 workflows)
- [4] harness init: src/core/project.ts + src/commands/init.ts, 필수 docs 6개 + outputs 생성, 기존 파일 보호, acceptance Test 1 통과
- [5] mock provider + runAgent: src/providers/{provider,mockProvider}.ts + src/core/runAgent.ts, 스키마 필수 4헤더 출력·prompt 누락 throw 검증
- [6][6-1] runWorkflow + validator + saveArtifact: src/core/{runWorkflow,validate,saveArtifact}.ts + src/commands/run.ts. acceptance Test 3 전 조건 통과(순서/저장/run_state/failed_agent 중단/필수헤더 경고)
- [7] harness summary: src/core/summary.ts + src/commands/summary.ts. run_state+docs 읽어 CONTEXT_SUMMARY 갱신, 다음 작업 도출. acceptance Test 4 통과
- [8] harness task-prompt: src/core/taskPrompt.ts + src/commands/taskPrompt.ts. Context/Task/Include/Exclude/Rules/Done Criteria + 안전 규칙(설치/배포/DB) 포함. acceptance Test 5 통과
- [9] 통합 검증: scripts/acceptance.sh (npm test) — Test 1~5 자동 검증 30 checks all pass. README 사용법/테스트 섹션 추가. **v1 완료.**

## 2026-07-06 (v2 착수)

- v1 재검증: npm test 30/30 통과, 5개 명령 라이브 데모 정상 확인
- provider 전략 C안 확정 (구독기반 B안 지금 / API A안 나중) — 설계 문서 docs/reference/PROVIDER_ARCHITECTURE_V2.md 작성, V2_KICKOFF 링크
- [v2-1] Provider 인터페이스 async화 + token usage 필드 신설:
  - provider.ts: `generate()` 동기 string → `Promise<AgentResult>`, TokenUsage/AgentResult 타입 추가
  - mockProvider.ts: async화, usage 0 반환 (테스트/오프라인 기반 유지)
  - runAgent.ts / runWorkflow.ts: async 전파, run_state에 `provider` + `usage`(per_agent 합계) 기록
  - providers/index.ts: provider 셀렉터(getProvider), 현재 mock만 등록
  - cli.ts/run.ts: `run --provider <id>` 플래그(기본 mock), async action
  - 회귀 검증: acceptance 30/30 그대로 통과. run_state 새 필드 라이브 확인.
- [v2-2] claude-code provider(B안) 구현 — 실제 LLM 첫 연동:
  - claudeCodeProvider.ts: `claude -p --output-format json` 에 프롬프트를 stdin으로 위임, JSON `.result`/`.usage` 파싱, 코드펜스 제거. 환경변수(HARNESS_CLAUDE_BIN/MODEL/TIMEOUT_MS).
  - AgentRunInput에 `ideaContent` 추가, runAgent가 docs/00_IDEA.md 로드해 전달 (실제 LLM이 검토할 아이디어).
  - buildPrompt: common+agent 프롬프트 + 아이디어 + 컨텍스트 + AGENT_OUTPUT_SCHEMA 출력형식 지시.
  - providers/index.ts에 claude-code 등록.
  - **버그 수정**: extractMainJudgment가 불릿만 뽑아 실제 LLM의 문단형 Main Judgment를 놓쳐 handoff 요약이 비었음 → 첫 비어있지 않은 줄(불릿/문단 both) 반환하도록 수정.
  - 검증: `claude -p` 스모크(stdin+JSON shape 확인) → dev-preflight(3 agent) end-to-end 실행 성공(경고 0, usage 집계 in 9399/out 12798, ~3.5분). 실제 출력 스키마 준수 확인. acceptance 30/30 유지.
- [v2-3] 스키마 검증 재생성 루프 (V2_KICKOFF 2번, "가장 쉬운 첫 루프"):
  - runWorkflow: 각 step에서 validateAgentOutput 실패 시 누락 헤더를 retryFeedback으로 넘겨 maxRegenerations회(기본 1)까지 재생성. 재생성 후에도 실패면 경고+저장(기존 동작).
  - AgentRunInput.retryFeedback / RunAgentArgs.retryFeedback 추가, claudeCodeProvider가 프롬프트에 "재작성 지시" 블록으로 반영. mock은 항상 유효 → 미발동.
  - run_state에 regenerations[{agent_id, attempts, resolved}] 라운드 기록. usage는 재생성 포함 전 시도 합산.
  - CLI `--max-regen <n>` 플래그, run 출력에 재생성 요약.
  - 검증: flaky provider(1차 Risks 누락→재생성 시 포함)로 루프 결정적 테스트 — 재생성 1회 후 resolved:true, usage 합산 확인. mock acceptance 30/30 유지. README v2 섹션 추가.
- [v2-4] Red Team 비평 루프 (V2_KICKOFF 3번) — 워크플로우 아키텍처 확장:
  - workflows.json steps를 `(string | {critique_loop})[]` union으로 확장. registry에 CritiqueLoopDef/WorkflowStep/isCritiqueLoop 추가.
  - runWorkflow 전면 재작성: 재생성 로직을 runStepWithRegen 헬퍼로 추출, priorFindings를 Map(upsert, 순서유지)로. 비평 루프 실행부 추가.
  - 루프: critic 실행 → extractCriticalRisks로 Critical 추출 → 있으면 target에 revisionRequest로 되먹여 revise → 재검토. Critical 소멸 또는 max_rounds까지. run_state.critique_rounds 기록.
  - AgentRunInput.revisionRequest 추가, claudeCodeProvider가 "비평 반영 수정 지시" 블록으로 반영.
  - mvp-planning에 루프 내장(tech_lead⟲red_team×2) — 워크플로우 4개 유지(acceptance 무영향). list가 `↻[critic⟲target×N]` 렌더링.
  - 검증: mock(Critical 0→라운드1 해소) + stub provider(Critical 발견→revise→라운드2 해소) 두 경로 결정적 확인. completed_steps 중복제거, usage 재실행분 집계. acceptance 30/30 유지.
- [v2-6] CEO 게이트 분기 (V2_KICKOFF 4번):
  - registry에 GateDef/isGate 추가, WorkflowStep union에 `{gate}` 확장.
  - validate.extractDecision: Main Judgment + Decisions 섹션만 검색(문서 전체 검색은 Input Summary 역할설명 boilerplate 오탐 → 버그 발견·수정).
  - runWorkflow: gate 분기 추가. decider 판정이 on 키와 맞으면 해당 agent step으로 i 되돌림. gateBudget(step별 max_jumps)로 무한루프 방지. lastMarkdown 맵으로 판정 원문 보관. run_state.gate_jumps 기록.
  - full-predev에 게이트 내장(founder_ceo→{축소:pm,검증:research}×1). list `⤴[decider?분기×N]` 렌더링, run 요약에 게이트 표시.
  - 검증: mock(판정 미매칭→진행) + stub(축소→pm 되돌림→재실행→진행) 두 경로 + max_jumps 준수 확인. acceptance 30/30.
- [v2-5] anthropic provider (A안):
  - @anthropic-ai/sdk 설치(v0.110). anthropicProvider.ts: messages.create(system+user), usage 파싱. ANTHROPIC_API_KEY 없으면 명확한 에러(claude-code 안내). 기본 모델 claude-opus-4-8(HARNESS_ANTHROPIC_MODEL로 변경).
  - promptParts.ts로 프롬프트 빌더 공유(claude-code/anthropic 중복 제거) — claude-code buildPrompt 리팩터.
  - index.ts에 anthropic 등록. 기본 provider는 계속 mock.
  - 검증: 키 없을 때 failed_agent 경로로 깔끔히 실패(유료호출 X). 공유 빌더 구조 결정적 확인. **실제 유료 API 호출은 미검증**(사용자가 키 세팅 후).
- [실전 검증] mvp-planning을 claude-code로 실제 실행(카페 재고앱 아이디어): 비평 루프가 실제로 작동 확인 — red_team이 Critical 2건("입력 동기 부재", "감 대비 우위 미검증") 발견 → tech_lead가 반영해 수정("코드 쓰지 말고 검증부터") → red_team 재검토 여전히 2건 → max_rounds 소진 종료(무한루프 방지 정상). 9분41초, in 22K/out 33K. 루프가 출력을 유의미하게 개선함 확인.
- **v2 완료.** provider 3종 + 루프 3종 완비, 실전 검증. develop→main 병합 + v2.0.0 태그.

## 2026-07-07 (v2.1 — 라이브러리화)

- [v2.1-A] 하네스를 설치형 라이브러리로: 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, 사용자 데이터)로 분리.
  - paths.ts: fromRoot → fromPackage(자산) + fromWorkspace(projects, CWD 기준, HARNESS_WORKSPACE 오버라이드).
  - registry/runAgent(프롬프트)=fromPackage, project(projects)=fromWorkspace로 전환.
  - package.json: version 2.1.0, files=[dist,agents,registry,README], engines node>=18, prepublishOnly=build, repository.
  - 효과: 서비스 레포마다 `npm install github:...` 후 `npx harness init`하면 그 레포에 projects/ 생성. 하네스 레포에 서비스 안 쌓임.
  - 검증: 하네스 레포 밖 임시 디렉토리에서 실행 → 자산은 패키지 로드, projects는 CWD 생성, 하네스 레포 미오염 확인. npm pack --dry-run으로 배포 파일 검증. acceptance 30/30 유지(개발 CWD=레포루트라 동일).
  - publish는 안 함(사용자 결정). install-ready까지.
- [B-②] 동적 분화(fanout) 추가:
  - registry: FanoutDef/isFanout, WorkflowStep union에 `{fanout}` 확장.
  - validate.extractSpawnDeclarations: `SPAWN id=.. | name=.. | focus=..` 파싱(id 정규화, 중복 제거).
  - 메인 루프: string step 다음이 fanout(planner=this)면 spawnRequest 주입 → planner 출력에 SPAWN 블록 유도. AgentRunInput.spawnRequest + provider 반영.
  - fanout step: planner 출력의 SPAWN 선언 파싱(max_agents 상한) → run_state.spawned_agents 기록. **기본은 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 에이전트 런타임 생성·실행.
  - 하위 에이전트: 런타임 AgentDef + 생성 브리프(agentPromptText 오버라이드, runAgent가 prompt_path 파일 대신 사용) → outputs/spawned/<id>.md. 레포 영구등록 안 함.
  - dev-preflight에 fanout 내장(tech_lead→spawn×4). list `⑂[planner→spawn×N]`, run 요약 표시.
  - 검증: stub으로 계획만(executed:false) + --allow-spawn(실제 실행, outputs/spawned 생성) 두 모드 확인. acceptance 30/30 유지.
- **v2.2.0 태그** (동적 분화). develop→main 병합 + Release.
- [B-③] task-prompt를 멀티에이전트 실행 스펙으로 확장:
  - run_state.spawned_agents가 있으면 task-prompt에 "## 병렬 실행 (Claude Code subagents)" 섹션 추가 — FE/BE별 담당범위·계획문서(outputs/spawned/*.md)·산출범위 + API_CONTRACT 기준 통합 + 승인 게이트("자동 실행 금지").
  - Include에 spawned 계획문서 자동 포함. spawned 없으면 기존 단일 task-prompt 그대로(acceptance 무영향).
  - **경계 유지**: 하네스는 병렬 실행 "스펙을 생성"만. 실제 병렬 코딩은 Claude Code subagent가 사람 승인 후 수행(하네스가 코드 실행 안 함).
  - 검증: stub fanout(--allow-spawn) → task-prompt에 병렬 섹션·통합·Include 반영 확인. acceptance 30/30 유지.
- 다음(선택): 실전(claude-code) dev-preflight로 분화·병렬스펙 품질 체감, 또는 v2.3.0 태그.
- **v2.3.0 태그** (B-③ 멀티에이전트 task-prompt). develop→main 병합.

## 2026-07-07 (Obsidian 연동 — V2_KICKOFF 5번)

- [Obsidian] workflow 실행 결과를 Obsidian vault로 export:
  - src/core/obsidianExport.ts: `exportToVault({vault, state})` — run_state 기반으로 vault에 노트 사본 생성. 원본 프로젝트 파일은 읽기만(비파괴).
  - 각 완료 agent 출력 → `<vault>/<project>/<agent_id>.md`: YAML frontmatter(project/workflow/agent/role/provider/date/tags) + 원문 + "## 연결"(이전/다음/인덱스 `[[wikilink]]`).
  - run 인덱스 노트(MOC) `<workflow>_run.md`: 실행 순서대로 `[[wikilink]]` 나열 + 실행 메타(provider/토큰/비평루프/게이트/분화). tags에 moc 추가 → 그래프뷰 허브.
  - 분화된 하위 에이전트(spawn_*) 출력도 함께 export. safeName으로 노트명 안전화, YAML 값 이스케이프.
  - CLI `run --vault <path>` 플래그 + `HARNESS_VAULT` 환경변수. 미지정 시 export 안 함(기존 동작 무영향). export 실패해도 실행 결과 저장은 보존(경고만).
  - 검증: acceptance에 Test 6 추가(인덱스/agent 노트 생성, frontmatter, wikilink 양방향) → 35/35 통과. e2e로 vault 트리·노트 내용 확인.

## 2026-07-07 (v3 킥오프 → v2.5 안정화 Phase 0)

- **V3_KICKOFF.md(Fable 5 작성) 기반 착수.** v3 착수 조건(아이디어 2개 검증) 미충족 판정 → 버전 승격 원칙대로 Phase 0(v2.5 안정화: v2에서 보류했던 안전장치)을 v3 선결로 먼저 구현. 각 항목 단위 커밋(develop).
- **[v2.5 0-1] run --resume.** RunState에 status/failed_reason/resume_from/loop_state 추가(기존 필드 유지 → 하위호환). `--resume` 시 완료 step은 저장 산출물에서 findings만 복원(재실행 X), 중단 지점부터 완주. 완료 실행 재개는 덮어쓰기 방지(FAILURE_RECOVERY). loadRunState() export, summary는 실패 시 --resume 안내. 검증용 HARNESS_FAIL_AT 훅. acceptance Test 7.
- **[v2.5 0-2] token budget.** `run --max-tokens <n>` / `HARNESS_MAX_TOKENS`(기본 무제한). step 경계 누적(input+output) 검사 → 초과 시 status=failed, failed_reason="token_budget_exceeded", resume_from=다음 step → --resume 재개. 80% 도달 stderr 경고. 예산 중단도 exit 1. 검증용 HARNESS_MOCK_TOKENS 훅. acceptance Test 8.
- **[v2.5 0-3] approval gate.** WorkflowStep에 `{approval:{message,show}}` 타입 + isApproval. 승인 게이트: show 문서 표시 후 stdin y/N, 거부 시 user_rejected로 중단(--resume 재개), `--yes` 비대화 전체 승인. dev-preflight 마지막에 "개발 착수 승인" 1곳 내장(나머지 지점은 v3 executor 책임). list에 ✔[승인게이트]. acceptance Test 9.
- **[v2.5 0-4] Red Team 편향 분리.** AgentRunInput.contextMode(full|conclusion_only). critique_loop critic은 target 결론만 격리 검토(전체 findings 체인 anchoring 방지 — priorFindings를 target 결론만으로 제한 + 프롬프트 격리 문구). 일반 step은 full 유지. acceptance Test 10.
- 검증: mock `npm test` → **57/57 통과**.
- **남음(0-5, 사용자 액션)**: ① anthropic provider 유료 1회 실검증(ANTHROPIC_API_KEY + --max-tokens 상한), ② v2.5.0 태그(develop→main). 이후 Phase 1 도그푸딩(실제 아이디어 2개 full-predev 검증).

## 2026-07-08 (v2.5.0 릴리스 + Phase 1 도그푸딩)

- **v2.5.0 릴리스**: develop push → main 병합(--no-ff "Merge develop: v2.5 안정화 Phase 0") → v2.5.0 태그 + push. acceptance 57/57.
- **Phase 1 도그푸딩(claude-code 실제 LLM)**:
  - 아이디어 A(증적엔진)·B(폐쇄망) full-predev → **CEO 게이트 두 분기 실발화**(A 축소→pm, B 검증→research), max_jumps 가드 작동, 스키마 경고 0.
  - A dev-preflight(--allow-spawn --yes) → tech_lead 하위 3개 SPAWN 실제 실행 + approval gate 통과 + task-prompt 병렬 handoff 생성.
  - 하네스 self-review(mvp-planning) → critique_loop 2R 되먹임 + 0-4 편향분리(conclusion_only) 실전 검증. **red_team이 "결론만 받았다" 명시.**
  - 관찰·결론은 `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 projects/dogfood-*.
- **self-review 판정**: 하네스가 자신을 검토해 "v3 착수 조건(개발 착수 1건) 미충족 → 지금 v3.0 코딩 시작 말라"고 결론. 다음 코딩은 하네스가 아니라 실제 서비스 아이디어 쪽에서 나와야 함.

## 2026-07-08 (실사용 + v2.6.0 — ux_ui 디자인 레퍼런스 확장)

- **실사용 개발 착수(v3 게이트 충족)**: 별도 private 레포 `audit-evidence-engine`에 하네스 설치 → 아이디어 A full-predev(claude-code) + F idea-validation → task-prompt → 실제 코드 착수(`collect_evidence.sh`, 판정 경계 준수). "개발 착수 1건" 게이트 충족.
- **public 설치 지원**: dist를 레포에 커밋(.gitignore에서 제거) + build에 `chmod +x dist/cli.js` → `npm install github:agrade1/solo-founder-harness`가 빌드/스크립트 없이 동작. prepare 제거(소비자 경고 제거). README "사용 가이드" 섹션 추가. v2.5.1.
- **[v2.6.0] ux_ui 디자인 레퍼런스 확장**: ux_ui 에이전트가 레퍼런스 리서치 방향(Pinterest/Dribbble/Mobbin/경쟁사·유사서비스 + 검색 키워드) + 비주얼 방향 + 디자인 실행 handoff를 산출하도록 프롬프트 확장(§4·§5·§12-B·§14·§15, v1.1). task-prompt는 03_UX_FLOW 존재 시 "디자인 실행(화면 시안)" 섹션 자동 추가 — Claude Code에서 레퍼런스 검색 + Claude 아티팩트 시안 생성. **경계 유지**: ux_ui는 픽셀을 직접 렌더링하지 않고 방향·지시만, 실제 시안은 Claude Code. MVP-lean 원칙 유지. acceptance 57/57.

## 2026-08-12 — V3 M7 (T1~T6·T8 offline)

- T1 `C-67` 승인 manifest 정적 감사(read-only 5규칙) — `preflight.ts`와 중복 없음 확인 후 신설.
- T2 `EvidenceItem` — content-addressed 원문 파일 + 포인터 + 상한 절삭 발췌.
- T3·T4 Research Gateway — `RESEARCH_REQUEST` 선언 파서 · mock backend · 캐시 · 도메인/호출 상한 fail-closed ·
  "데이터이며 지시가 아님" 래핑(적대적 fixture 3종).
- T5 도구 예산 상한 — 우리 registry 실측 근거로 3서버/16도구, 초과 등록 로드 거부.
- T6 사람 gate — 답 없는 `decision_request`를 남긴 task는 완료 불가(`decision_pending`), 요청 union에
  답을 만드는 갈래 없음(`request_decision`만 추가).
- T8 acceptance **Test 19** 신설(PASS=137) · mutation red 확인 총 26건 · 로드맵/대장 갱신(`C-67` fixed).
- T7 live 1회 — Tavily backend 신설, live 첫 호출에서 search/extract 도메인 게이트 분리를 정정
  (후보 도메인은 질의 전에 알 수 없다 → 위협이 있는 extract만 fail-closed 유지).
  benchmark: baseline 검증 가능 0/5 vs research 6/6. 크레딧 6 소모($0), LLM은 구독 경로 3왕복×2런.
