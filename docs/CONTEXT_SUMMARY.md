# CONTEXT_SUMMARY.md

최종 갱신: 2026-08-12 (M6 완료)

## 최신 (2026-08-12 — **V3 M6 완료. 다음은 M7** · 이 블록이 가장 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · 브랜치 `work/m5c-autopilot`.
- **M6 완료**: 계층 오케스트레이션이 **실제로 돈다**. 판정은 로드맵 `M6 완료 판정` 절(증명/미증명 표).
  실측 `test:exec` **531/531** · `test:core` **409/409** · acceptance **PASS=124 / FAIL=0** · **live 0회**.
- **무엇이 새로 섰나**: ① agent 출력의 `spawn_child`/`deliver_status` 요청이 autopilot 경유로 kernel
  게이트를 지난다(`src/exec/spawnRouting.ts`) · child `result`가 parent inbox로 route된다 ·
  ② 요청 union에 state·권능 필드가 **없다** · ③ `snapshotDigest()` 3종으로 coordinator 교체 등가성을
  증명한다 · `buildContextBundle`(durable state만 입력, byte-identical).
- **kernel 계약 변경 2건**(근거: `docs/DECISIONS.md` 2026-08-11): `requestSpawn`이 **정리 확인된
  `cleaning`** parent도 받는다(`recordTerminal → confirmCleanup → requestSpawn` 순서로 `B-13` 유지) ·
  결과가 parent inbox로 route된다. **상태 게이트를 넓힌 것이지 우회로가 아니다.**
- **M6에서 닫은 대장**: `B-19` · `C-44`. **새로 등록**: `C-67`(승인 설정 정적 감사, 기한 M7) ·
  `C-68`(attempt 신원 재사용 차단이 직전 한 칸까지). **열린 A는 0건.**
- **의도적 미증명(M6 절에 같은 무게로 적혀 있다)**: context bundle의 **프롬프트 주입 없음**(offline
  worker에 프롬프트 채널 자체가 없다) · inbox ack 없음(`B-17`) · 실제 LLM이 spawn을 요청하는 경로 ·
  `decisionHash`의 run 사이 동일성은 **주장하지 않는다**(messageId가 난수 신원).
- **외부 하네스 팩(ECC/gstack/oh-my-claudecode)은 미도입 판정**(`docs/DECISIONS.md` 2026-08-12).
  durable SoR·승인 manifest가 없는 프롬프트 층이라 역할 어휘가 충돌한다. 가져온 발상 둘만 로드맵에
  배치: `C-67` · M7의 **도구 예산 상한**(tool/MCP 등록만으로 컨텍스트를 상시 소모 — 숫자는 M7 착수 시 재측정).
- **다음: M7**(Planning & Evidence Research). 착수 전에 `C-67`을 닫는다(승인 manifest에 외부 provider
  권능이 들어오기 전).
- **로드맵 배치 정정(2026-08-12)**: "M10까지면 기능 끝인가"를 점검해 **미배치 기능 2건을 배치**했다 —
  `F2`(진행률·ETA) → **M9 선결**, `F3`(문서 완료 → Claude Code 핸드오프) → **M10**. 그리고 M6까지의
  의도적 잔여 3건이 M9에서는 **전제**가 됨을 M9 절에 명시했다: `run_process` action enum 확장(현재
  `["validate-plan"]` 하나·읽기 전용이라 **테스트 실행을 표현할 수 없다**) · `B-16` 신규 파일 발행 ·
  `B-17` inbox ack. **M7 범위는 바뀌지 않았다.**

## (2026-08-11 — V3 M5 완료 · 위 M6 블록이 더 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · 브랜치 `work/m5c-autopilot`.
- **M5 완료**: offline 전부 + **첫 live 실행 1회 성공**(input 13,049/output 5).
  실측 `test:exec` **514/514** · `test:core` **402/402** · acceptance **PASS=108 / FAIL=0**.
- **M5에서 닫은 대장**: `B-7ⓐ`·`B-7ⓑ`·`B-9`·`B-10`(소비면)·`B-16`(부분 — 승인된 **기존 파일 교체만**)·
  `B-21`·`B-22`·`B-23`·`B-24`·`B-25`·`B-26`·`C-1`·`C-55`. **열린 A는 0건.**
- **의도적 잔여(M6+ 범위)**: 테스트 *실행* 불가(`run_process` action은 읽기 전용 `validate-plan` 하나) ·
  신규 파일 발행 fail closed(`B-16` 잔여) · Claude↔Codex 자동 전달 없음(`B-17` 미소비).
- **live 규율**: 승인 대상은 **native 바이너리**다. `which codex`는 Node wrapper이고 승인해봐야 실제
  추론 바이너리가 고정되지 않는다(`B-27` P1 — 다음 live manifest 작성 전 절차화 필요).
  live는 과금이므로 probe는 `acceptance.sh`에 **등록하지 않았다**(수동 실행 전용).
- **작업 방침**(CLAUDE.md·AGENTS.md·harness-dev 스킬·templates/에 기록됨): 배송 우선(MVP-first) —
  A급·크리티컬(과대주장 포함) 즉시 수정, B/C는 대장 기록 후 진행. 모델 분업(Fable 5 계획·적대적 리뷰 /
  Opus 5 구현). 파일 소유권 분리되면 병렬. **acceptance는 만들 때마다 mutation으로 red 확인**.
- **다음: M6**(Hierarchical Orchestrator + Fresh Context Rotation). 착수 문서는
  `docs/handoff/M6_KICKOFF.md`.

## (2026-08-13 — **V3 M8: T1~T5·T7 완료(offline) · T6 live 미실행** · 이 블록이 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · 브랜치 `work/m5c-autopilot`.
- 새로 선 것: `src/core/designContract.ts`(DESIGN.md·tokens·inventory fail-closed + **WCAG 대비 계산**) ·
  `src/tools/registryInventory.ts`(공식 registry 참조/출처 2층 차단 + 원문=파일/중앙=발췌) ·
  `src/exec/designHandoff.ts`(handoff 닫힌 계약 + 범위 + 승인 재사용 금지) ·
  `src/exec/designReviewRoundtrip.ts`(fresh Codex 리뷰 / fresh design worker 왕복).
- **계약 변경 1건**: `tokens.json` 최상위가 `primitive`/`semantic`/`component`/**`a11y`** 넷.
  `agents/design_agent.md` §4도 같이 갱신했다(생산자↔검증기 단일 출처).
- **새 proxy·새 tool profile을 만들지 않았다**(M3c shadcn read 계층 재사용 · profile 4개 유지).
- 실측: `test:exec` 549 · `test:core` 442 · acceptance **PASS=154 / FAIL=0**(Test 20 신설) · tsc clean.
  **live LLM 0회 · registry 실조회 0회 · 과금 0원** · mutation red 9건.
- 접근성은 **tokens 층만** 증명했다 — 렌더링·이미지 위 텍스트·large-text 예외·스크린리더·시각 diff는
  범위 밖이며 통과로 주장하지 않는다. 판정 정본은 로드맵 `M8 진행 판정` 절. 신규 대장 `C-70`.
- **다음: T6 live 1회(사용자 승인 필요) 또는 M9**(§6.5 선결 4건부터).

## (2026-08-12 — **V3 M7: T1~T8 완료 — offline 전부 + live benchmark 1회**)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · 브랜치 `work/m5c-autopilot`.
  PR `pr/v3-m7-01-gateway`(T1~T5) · `pr/v3-m7-02-human-gate`(T6·T8).
- 새로 선 것: `src/exec/manifestAudit.ts`(C-67 정적 감사 5규칙) · `src/tools/evidenceStore.ts`(원문=파일 /
  중앙=포인터+발췌) · `src/tools/researchGateway.ts`(선언 파서·mock backend·캐시·상한·주입 래핑) ·
  `profiles.ts` 도구 예산 상한 · kernel **사람 gate**(`decision_pending`) · `AgentRequest.request_decision`.
- 실측: `test:exec` 542 · `test:core` 426 · acceptance **PASS=140 / FAIL=0**(Test 19 신설) · tsc clean.
  **live 0회 · 검색 API 0회 · 과금 0원.**
- **T7 live 1회 실측**(2026-08-12): baseline 인용 5건 중 검증 가능 **0** vs research 인용 6건 중 **6**.
  baseline 인용은 환각이 아니라 **검증 불가**였다(실재 주소). Tavily 무료 크레딧 6 소모 = $0.
  표본 1건이므로 일반화하지 않는다. 실행: `scripts/m7-live-benchmark.mjs`(수동 전용 · acceptance 미등록).
  주입 방어는 완화이며 "모델이 안 따른다"의 증명이 아니다. 도구 예산의 **토큰** 비용은 미측정(개수 단위 상한).
- 판정 정본은 로드맵 `M7 진행 판정` 절. `C-67`은 fixed로 전환했다.

## 최신 (2026-08-11 — **V3 M5d 착수: task 1·2·4 완료 · 독립 리뷰 3건 `APPROVE A=0` · `B-16` 결정 대기** · 이 블록이 가장 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · `work/m5c-autopilot` · HEAD `2b49a36`.
  계획=fresh Fable 5 · 구현=fresh Opus 5 · 리뷰=fresh Fable 5 read-only.
- **M5d 승인 범위**: offline typed execution 소비 게이트 개방(live 유지) · self-hosting = 작은 fixture repo.
- **완료**: task 1(`B-21`·`C-55`) · task 2(`B-10` 소비면) · task 4(`C-1`, **격리 worktree 병렬**).
  `tsc` 0 · exec+autopilot **528 pass / 0 fail** · 기존 테스트 삭제·완화 0.
- **⚠️ 핵심 발견**: **typed execution은 지금 바이트를 하나도 만들 수 없다.** write는 신규 생성·내용 교체가
  둘 다 fail closed이고 성공 경로는 멱등(`already_applied`) 하나, run_process action은 읽기 전용
  `validate-plan` 하나다. 열린 것은 **집행 lifecycle**이고 **implement 능력이 아니다** —
  self-hosting 루프를 말 그대로 돌리려면 **`B-16`(예방 안전한 발행 primitive)** 을 여는 별도 승인이 필요하다.
- **`B-16` 부분 개방 완료**(사용자 승인 — HEAD `7e5a966`): typed write가 **처음으로 실제 바이트를 낸다**.
  승인된 **기존 파일 교체만**이고 신규 파일 발행은 계속 fail closed. 고정한 fd에 직접 써서 발행 syscall에
  pathname이 없다(3A 2차 A3의 폐쇄 근거가 이 형태엔 성립하지 않는다). **교환한 것은 원자성** — torn은
  재시도 시 preimage 불일치로 fail closed이고 자동 복구하지 않는다. 적대적 리뷰 `APPROVE A=0/B=1/C=3`.
  → **self-hosting 루프의 implement 단계가 "기존 파일 수정" 범위에서 열렸다.**
- 신규 유예: `C-59`·`C-60`(task 1) · `C-61`·`C-62`(task 2·4) · `C-63`~`C-65`(`B-16`). 열린 A·B는 **0건**.
- **Task 3·5 완료**: `scripts/m5d-offline-acceptance.mjs`(acceptance.sh **Test 16**, 내부 체크 27건) —
  승인 1건 · 수동 복사 0회로 autopilot이 fixture repo의 **실제 파일을 고쳐** DAG 완주. 적대적 리뷰
  `REVISE A=2`(둘 다 공허한 체크의 과대주장) → **즉시 수정 후 재검증**.
  **전체 suite 직렬 1회**: `test:exec` **510/510** · `test:core` **402/402** · acceptance **99/99**.
- **작업 방침 문서화 완료**(CLAUDE.md · AGENTS.md · harness-dev 스킬 · templates/): 배송 우선(MVP-first,
  A급 즉시 수정 / B·C 기록 후 진행) · 모델 분업(Fable 5 계획·적대적 리뷰 / Opus 5 구현) · 병렬 규율.
- **M5 완료 게이트 3건 전부 마감**(2026-08-11): `B-24`(deadline·cancellation 자손 정리 — acceptance
  **Test 17**, 실제 spawn·SIGKILL 경로까지) · `B-25`(배타 자원 동시 실행 0 — Test 16 ⑨) ·
  `B-26`(별도 프로세스 재시작 — Test 16 ⑩). acceptance 전체 **PASS=108 / FAIL=0**.
- **남은 하드 게이트는 `B-23` 하나이고 사용자 액션이다**: `CODEX_HOME=~/harness-codex-home codex login`
  실행 후 `ls -la ~/harness-codex-home` 결과 필요. 하네스는 그 홈에 `auth.json` **외 항목이 하나라도**
  있으면 거부하므로(설정·MCP 정의가 자격증명 뒤에 묻어 들어오는 통로 차단), **실측 후 관측된 파일만**
  허용 목록에 넣는다. 그 전까지 **M5는 완료가 아니고 live 실행은 0회**다.
- 신규 유예: `C-59`~`C-65`. **열린 A는 0건이고 열린 B는 `B-23` 외 lifecycle 잔여뿐이다.**
- **이 세션의 절차 학습**: acceptance를 만들 때마다 **mutation으로 red가 되는지 직접 확인**한다.
  공허한 체크(항등식·구조적 상시 green·측정값보다 넓은 라벨)로 A급 지적을 세 번 받았고 전부 즉시 고쳤다.

## 이전 (2026-08-10 — **live 하드 게이트 4건 마감(`B-9`·`B-7ⓑ`·`B-22`·`B-7ⓐ`) · live 실행은 여전히 0회** · 이 블록이 가장 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · `work/m5c-autopilot` · HEAD `fc0a528`.
- **닫힌 게이트 4건**: `B-9`(실측 JSONL usage 필드명) · `B-7ⓑ`(자식 stderr를 fd 단계에서 폐기 —
  패턴 redaction 의존 제거) · `B-22`(charge 실패를 pause·정지 조건으로) · `B-7ⓐ`(live 인증 방식 결정:
  **승인 manifest가 격리 `CODEX_HOME` 경로를 고정하고 사람이 1회 로그인**. harness는 auth를
  복사·해싱·기록하지 않는다 → `ApprovedDirectory`에 digest 필드가 없다).
- **`B-7ⓐ` 독립 리뷰(fresh Fable 5) `APPROVE — A=0, B=1, C=2`**. 신규 `B-23`(실제 `codex login`이
  `auth.json` 하나만 쓰는지 **미확인** — 아니면 첫 live가 `codex_home_not_empty`로 죽는다. 허용 목록을
  미리 넓히지 않고 **실측 후 관측된 파일만** 추가한다) · `C-57`(재시작 후 홈 재사용 마찰) ·
  `C-58`(자격증명 파일 dev+ino 미고정 — 선언된 threat model 밖)를 대장에 등록했다.
- **live 게이트는 사라지지 않았다** — `B-7`/`B-9` 자리를 **`B-23`**(자격증명 산출물 실측 1회)이 이어받는다.
- 검증: `tsc --noEmit` 0 · `npm run test:exec` **168/168**(focused). 전체 suite·acceptance·stress·live는
  **미실행**(다음 handoff 게이트에 예약).
- 스킬 자산 설치(`82a890b`): `.claude/skills/harness-dev/` + 대상 프로젝트용 `templates/`.
- **다음(사용자 결정)**: `B-23` 실측을 포함한 **M5-live 슬라이스** 또는 **M5d**. 중앙은 승인 없이 착수하지 않는다.

## 이전 (2026-08-05 — **V3 M5c 완료(3A~3F) · 전체 suite 1회 PASS · M5는 완료 아님** · 이 블록이 가장 최신이다)

- worktree `/Users/jihun/Developer/solo-founder-harness-m5c` · `work/m5c-autopilot` · HEAD `77b55e5`.
  구현은 task마다 fresh Opus 5 worker, 리뷰는 fresh Fable 5 read-only, 중앙(Opus 5)은 계획·재검증·문서.
- **M5c 완료**: 3A(typed execution kernel) · 3B(StableController 배선) · 3C(managed process supervisor ·
  `B-F1` 폐쇄) · 3D(trusted Git) · 3E(`harness autopilot` CLI) · 3F(숨은 red 48건 복구).
  **전부 독립 리뷰 A=0.**
- **M5는 완료가 아니다.** M5 완료 조건은 live provider + typed execution을 요구하고 둘 다 열린
  게이트다(`B-7`/`B-9`/`B-10`). autopilot은 **operation 0건 plan만 완료**시키므로 **아직 마일스톤을
  완료까지 몰고 갈 수 없다.** 증명된 것은 "Autopilot **Bootstrap**"이다.
- **전체 suite 직렬 1회 실행**: `test:exec` **493/493** · `test:core` **391/391** ·
  acceptance **PASS=92 / FAIL=0**. **M5a 이후 처음으로 전체가 초록이다.**
- **이번 세션 최대 발견**: `codexCliProvider.test.ts`가 **11/48로 `8dd05f9`부터 red**였고 아무도
  몰랐다(모든 세션이 focused 테스트만 돌림). M5a/M5b **안전 테스트 48건**이 Task 3A 이후 실제로
  검증된 적이 없었다. 원인은 3B가 고친 것과 같은 pre-M5c manifest fixture. **프로덕션 결함은 없었다.**
- **열린 A는 없다.** 신규 `B-21`(중단 batch의 `prepared` 잔여) · `B-22`(charge 실패 삼킴 — live 전
  하드 게이트) · `C-50`~`C-56`. 전체 유예 목록의 **비용순 정리는
  `docs/backlog/DEFERRED_COST_ORDER.md`**.
- **미실행**: live · stress · 반복 3회 · build/dist · M5d.
- **다음(사용자 결정 사항)**: **M5-live 슬라이스**(`B-7` 인증 결정 + `B-9` live JSONL 1회 캡처) 또는
  **M5d**(스펙이 한 줄뿐 — 계획 리뷰 A-1). 중앙은 사용자 승인 없이 착수하지 않는다.

## 이전 (2026-08-04 — **V3 M5c task 3D trusted Git 독립 리뷰 `APPROVE — A=0, B=1, C=3`. Task 3D 완료. M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree **`/Users/jihun/Developer/solo-founder-harness-m5c`**(`/private/tmp`에서 이전 — 그쪽은
  내구성이 없었고 실제로 청소기가 파일을 지웠다) · `work/m5c-autopilot` · 커밋 `b09df0e`.
- **trusted Git**: 허용 연산 3개뿐, 전부 로컬 read-only + exit code만. remote·refspec·branch·경로·
  메시지를 담을 필드가 API에 없어 **push/fetch/merge는 표현 불가능**. argv는 동결 상수 + `shell:false`.
  권위 모델은 3C 선례 그대로이고 `superviseProcess`를 재사용해 두 번째 spawn 경로를 만들지 않았다.
- **독립 리뷰가 실증했다**: `.git` mtime+size 스냅샷 전후 동일(NO-WRITE) · 적대적 repo config
  (`fsmonitor`/`diff.external`/`pager`)를 심어도 코드 실행 0.
- **의도된 gap**: commit-class 로컬 쓰기는 durable pending 계약(소유권 밖 닫힌 union)이 먼저라서
  미구현이다. 다음 task가 그 계약 + stdout 캡처를 함께 가져와야 한다(`C-49`).
- **실측**: `tsc` exit 0 · `trustedGit` **15/15**(중앙 10회 연속) · 회귀 **225/225** ·
  managedProcess+stableController **73/73** · 누수 0 · mutation 4종 red 후 원복.
- **열린 A는 없다.** 신규: `B-20`(gitconfig 미차단 — env 한 줄) · `C-47`/`C-48`/`C-49`.
  기존: `B-10`·`B-11`·`B-12`·`B-13`·`B-16`·`B-17`·`B-18`·`B-19`·`B-7`·`B-9`·`C-1`·`C2`·`C-43`~`C-46`.
  **비용순 정리는 `docs/backlog/DEFERRED_COST_ORDER.md`.**
- **미실행**: `npm test` · acceptance 전체 · stress · live · build/dist(M5 최종 handoff 예약).
- **다음 DAG task(미착수)**: `autopilot` CLI — M5c의 마지막.

## 이전 (2026-08-04 — **V3 M5c task 3C 독립 리뷰 `REVISE — A=0, B=4, C=2` → 값싼 B 2건 후속 폐쇄. Task 3C 완료 · `B-F1` 폐쇄. M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · `work/m5c-autopilot` · 구현 `56cf8d6` ·
  후속 `4774c43`. 구현·후속은 각각 fresh Opus 5 worker, 리뷰는 fresh Fable 5 read-only,
  중앙 오케스트레이터(Opus 5)는 계획·재검증·문서만 했다.
- **이 시스템 최초의 실제 승인 spawn.** `B-F1` 폐쇄 — 1회 소비 · live grant + 발급자 신원 ·
  durable 재독 · spawn 직전 digest 재검증 · A4 mark-then-re-verify. 중복 spawn 경로 없음이
  독립 리뷰에서 실제 실행으로 확인됐다.
- **자손 정리**: detached 프로세스 그룹 + `reapGroup()`(SIGTERM → ESRCH 폴링 → SIGKILL → 재폴링,
  `EPERM`은 살아있음). `cleanupConfirmed: false`가 deadline 오류보다 우선(B1 보존).
- **아키텍처 결정**: 권능 레지스트리를 `typedExecution.ts` → kernel로 이동(A3 선례). `DECISIONS.md` 참조.
- **flaky 테스트**: worker는 "안정"이라 했으나 중앙 약 43회 중 1회 · 리뷰어 52회 중 1회 실패.
  원인은 fixture 배리어 부재였고 **테스트 전용 false red**(프로덕션은 ESRCH 관측 기반 · false green 없음).
  후속 커밋이 관측 배리어를 넣어 **중앙 재실행 정상 20회 + 부하 10회 = 30회 전부 통과**.
- **실측**: `tsc` exit 0 · `managedProcess` **15/15** · 회귀 5파일 **225/225** ·
  `stableController` **58/58** · 프로세스 누수 0 · mutation 7종(구현 4 + 후속 3) red 후 원복.
- **열린 A는 없다.** 신규 유예: `B-18`(setsid 탈출 자손) · `B-19`(run 전역 프로세스 상한이
  `maxTasksPerRun` 상수 차용) · `C-44`(depth backstop 도달 불가) · `C-45`(exit≠0인데 `applied`) ·
  `C-46`(win32 미검증). 기존 열린 게이트: `B-10`·`B-11`·`B-12`·`B-13`·`B-16`·`B-17`·`B-7`·`B-9`·
  `C-1`·`C2`·`C-43`. **비용순 정리는 `docs/backlog/DEFERRED_COST_ORDER.md`.**
- **계획 검토(2026-08-04, fresh Fable 5)**: `PLAN-REVIEW — A=1, B=6, C=4`. 핵심 — M5d 스펙 부재 ·
  `B-10`을 소유한 마일스톤 없음 · live 검증이 단일 고분산 게이트로 누적 · M7이 존재한 적 없는
  Research Adapter를 "이동"한다고 서술. 상세는 `DEFERRED_COST_ORDER.md` 4군.
- **미실행**: `npm test` · acceptance 전체 · stress · live · build/dist(M5 최종 handoff 예약).
- **다음 DAG task(미착수)**: trusted Git → `autopilot` CLI.
- **주의**: worktree가 `/private/tmp`에 있어 내구성이 없다. 세션 중 `/tmp` 청소기가 실제로 파일을
  지웠고 복구했다(손실 0 · 커밋은 메인 저장소 object store에 durable). **이전 예정.**

## 이전 (2026-08-03 — **V3 M5c task 3B 독립 리뷰 `APPROVE — A=0, B=1, C=1`. Task 3B 완료, M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · `work/m5c-autopilot` · 시작 `8dd05f9` ·
  코드 커밋 `9a34c5d`. 구현은 fresh Opus 5 worker 1개, 리뷰는 fresh Fable 5 read-only.
  중앙 오케스트레이터(Opus 5)는 계획·검증·문서만 하고 구현하지 않았다.
- **Task 3B**: `StableController`를 M5c 계약에 배선했다 — `planRunnableBatch` →
  `commitPreflightBatch`(전부 `prepared`) → `startPreparedTask`(await 창 0) →
  `beginDeliveryAttempt` → `recordTerminal` → `confirmCleanup` → `completeTaskWithArtifacts`.
  `startScheduledBatch()`는 `preflight_required` 던지는 stub만 남았다.
- **변경 파일 2개뿐**: `stableController.ts` · `stableController.test.ts`. kernel/schema/package/docs
  무변경 · **spawn 0** · 신규 의존성 0 · 테스트 삭제·완화·skip 0(교체 assertion 9건 전수는 WORKLOG).
- **실측**: `tsc --noEmit` exit 0 · `stableController` **58/58**(이전 3/55) · 회귀 5파일 **225/225** ·
  mutation 2종 red 확인 후 원복. 중앙·리뷰어·구현 세션 3자 수치 일치.
- **열린 A는 없다.** 열린 게이트: `B-F1`(첫 spawn 전) · `B-16`(첫 real typed-write 배선 전) ·
  `B-11`/`B-12`(무인 advance·재시작 회계) · **신규 `B-17`**(전달 실패 시 `activeAttemptId` 잔존) ·
  `C-1` · `C2` · **신규 `C-43`**.
- **미실행**: `npm test` · acceptance 전체 · stress · live · 반복 3회 · build/dist(M5 최종 handoff 예약).
- **다음 DAG task(미착수)**: managed process supervisor(+자손 정리 · `B-F1` 개봉 필요) →
  trusted Git → `autopilot` CLI.

## 이전 (2026-07-31 — **V3 M5c task 3A 독립 승인 `APPROVE — A=0, B=2, C=3`. Task 3A 완료, M5c·M5는 미완료** · 이 블록이 가장 최신이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `e88c1ca` ·
  코드 커밋 **`12fbf08`**. fresh Claude Opus 5 단일 세션(이전 transcript·자기평가 미상속 · 재개 아님) ·
  Ponytail **full**. 입력 권위: `/private/tmp/m5c-task3a-revision5-codex-review-output.txt`
  (Codex `gpt-5.6-sol` xhigh read-only · 범위 `7d3f547..e88c1ca` · `REVISE — A=1, B=2, C=3`).
- **최종 독립 승인**: `/private/tmp/m5c-task3a-revision6-codex-review-output.txt` · fresh Codex
  `gpt-5.6-sol` xhigh read-only · 세션 `019fb6d4-cad0-7232-bd2e-a33ca1390362` · 범위
  `e88c1ca..e0043ef` · **`APPROVE — A=0, B=2, C=3`**. Task 3A만 완료이며 M5c/M5는 미완료다.
- **닫은 것 — A1(유일)**: `issueOperationDispatchPermit()`이 대상 task의 claim과 run 전역
  `chargedTurnIds`만 봐서 **두 running task가 둘 다 genuine permit으로 같은 turn ID를 claim**할 수 있었다
  (B가 먼저 과금 → A의 genuine charge가 `turn_already_charged` → A는 task-local 과금 증거를 못 얻어
  claim을 영원히 정산·교체 못 하는 **교착**). 원인은 과금 namespace(run 전역) ↔ claim namespace(task-local)
  폭 불일치. `assertTurnClaimableBy()`가 발급 전 경로·커밋 draft 양쪽에서 `turn_conflict`로 fail closed하고,
  `assertUniqueDispatchClaims()`가 `assertReferentialIntegrity()`에 들어가 **커밋과 load가 같은 불변식**을
  본다(중복 live claim state는 `open()`에서 `invalid_state`). 멱등 재발급 0-event · lazy replacement ·
  safety-only bare 회계 · genuine charging · task-local settlement 전부 보존.
- **문서 정정**: `C-1` 발행 seam은 "성공을 만들 수 없다"가 **과대**였다(ambient fs 권한 코드가 hook 안에서
  승인 대상을 만들면 canonical `already_applied` 가능 — 대장의 확률·영향·증거·기한 M5d handoff 전과
  source/facade 주석을 정정).
  pending 재발급 조건도 **모든 전진·권위 게이트**(토큰/wall/no-progress/신원/과금/preflight/claim 유일성)로
  schema를 고쳤다. `C2`(draft-07 실검증)는 기한과 함께 open.
- **검증**: 구현 세션과 supervisor 재실행 모두 `npx tsc --noEmit` 0 error · focused 5파일
  **225/225 pass · fail 0** · mutation(충돌 검사
  3곳 제거 → 신규 2건 red · 원복 후 재확인). **미실행**: `npm test` · 전체 acceptance · stress · 반복 ·
  live · build/dist(전체 suite 1회는 M5 handoff 게이트).
- **여전히 열린 것**: `B-F1` · `B-16` · `C-1` · `C2`. 열린 A 없음.
- **다음 작업**: **현재 Task 3A로 Codex 작업을 중단한다.** 다음 DAG task 미착수 · 이후는 사용자 별도 지시.

## (그 시점 기록) 2026-07-31 — **V3 M5c task 3A 5차 리비전: 독립 재리뷰 `REVISE A=5·B=2·C=3`의 A 5건 닫음** · 위 블록이 A1을 정정한다

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `7d3f547` ·
  코드 커밋 **`de59348`**. fresh Claude Opus 5 단일 세션(CLI `2.1.220` · 이전 작성자 transcript·자기평가
  미상속 · 재개 아님) · Ponytail **full**. 입력 권위:
  `/private/tmp/m5c-task3a-revision4-codex-review-output.txt`(Codex `gpt-5.6-sol` xhigh read-only ·
  세션 `019fb685-3f2f-7512-aa13-9d12f3e47585` · 범위 `20530b0..7d3f547`).
- **닫은 것**
  - **A1** bare 회계(`chargeTurnUsage`)가 **남이 claim한 생산 turn을 선점**할 수 없다(커밋 안에서
    `turn_conflict`). 정산 권위가 run 전역 `chargedTurnIds`에서 **task-local 진짜 과금 증거**
    (`execution.turnId` + `chargedPlanDigest == dispatchPlanDigest` + 그 turn 미확정 0)로 옮겨졌다 →
    생산 task의 진짜 사용량이 영구히 과금 불가가 되는 일도, 거짓 정산으로 claim이 교체되는 일도 없다.
    claim 없는 turn의 safety-only 회계(`B-12`)는 그대로다.
  - **A2** permit·grant·outcome·진행 채널이 **발급 kernel 인스턴스 자체**를 들고 있고 수신 메서드 5종이
    `this`와 `===`로 대조한다. `LIVE_GRANTS`는 발급자별 `Map` → durable ID가 같은 두 workspace가 서로
    교차 과금·등록·표시·영수증·grant 소비를 하지 못한다. **같은 workspace의 두 번째 인스턴스도 남**이고
    권위는 durable 경로(정확한 permit **커밋 없는** 재발급 / handle-free 정합화)로만 넘어간다.
  - **A3** `src/exec/writeFileEffect.ts` **삭제** — 위조 가능한 구조적 `DispatchAuthority`로 도달하던
    `judgeWriteFile` export가 사라졌다. 집행기는 grant 등록부와 같은 모듈의 **사설 함수**이고 유일한
    진입점은 진짜 grant를 요구하는 `executeWriteFileOperation()`이다.
  - **A4** `attemptedAt` 표시 커밋 **이후** 권위를 전수 재확인한 뒤에만 집행기에 들어간다(표시 커밋은
    safety-only라 deadline을 보지 않는다) → 커밋 도중 만료·예산·wall·no-progress 경계를 지나면 파일
    효과 0 · 영수증 0이고 pending은 `outcome_unknown`으로만 닫힌다.
  - **A5** 새 pending마다 **영수증 자리를 먼저 예약**한다
    (`operationReceipts + pendingOperations <= 64` — 커밋과 store load 양쪽) → 영수증 상한 위에서 열려
    어떤 경로로도 닫히지 않던 미아 pending이 없다.
  - pending schema 서술 정정: 재시작한 `running` kernel도 `attemptedAt: null`이면 새 permit으로 재발급한다
    (handle-free는 attempted·cleaning·게이트 폐쇄에서 **필수**).
- **검증**: `npx tsc --noEmit` exit 0 · focused **223/223 pass**(typedExecution 62 · kernel 103 ·
  autopilotLifecycle 28 · executionBoundary + offlinePlanWorker) · M4a/M4b/M4c offline acceptance
  32/45/80 FAIL=0 · `git diff --check` 0 · mutation 10종(각 게이트 red 확인 · 원복 후 tree clean ·
  흔적 grep 0). **미실행**: `npm test` · 전체 acceptance · stress · 반복 · live(전체 suite 1회는 M5
  handoff 게이트).
- **여전히 열린 것**: 열린 A 없음(단 **독립 재리뷰 전 self-approve 금지**) · `B-F1`(launcher 첫 소비자·
  첫 spawn 전) · `B-16`(첫 typed-write 산출물 배선 전, 늦어도 M5c 통합) · `B-7`/`B-9`/`B-11`/`B-12`/
  `B-13`/`C-12→B` · `C-1`(발행 seam export, M5d 전) · `C2`(draft-07 실검증, M5d 전).
- **다음 DAG task는 착수하지 않았다**: StableController 재작성/배선 · managed process supervisor/launcher ·
  trusted Git · 첫 spawn · M5d · live 실행 전부 미구현. **정정(6차 리비전)**: 이 자리의 `fable5` 문구는 사용자 의도의 오기였다 — 사용자는 도구를 바꿀 것이며 **현재 Task 3A 마감 후 Codex는 이후 작업을 시작하지 않는다**(이후는 사용자 별도 지시).

## (그 시점 기록) 2026-07-31 — **V3 M5c task 3A 4차 리비전: 독립 재리뷰 `REVISE A/P1=3`의 A 3건 닫음. M5c는 여전히 미완료** · 위 블록이 이를 정정한다

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `20530b0` ·
  코드 커밋 **`5ec0a57`**. fresh Claude Opus 5 단일 세션(이전 작성자 transcript·자기평가 미상속 · 재개
  아님) · Ponytail **full**. 입력 권위:
  `/private/tmp/m5c-task3a-revision3-codex-review-output.txt`(Codex `gpt-5.6-sol` xhigh read-only ·
  세션 `019fb648-ae3a-7252-ada5-e23edd37770a` · 범위 `2956ffc..20530b0`).
- **닫은 것**
  - **A1** 과금을 **권위 없는 `chargeTurnUsage`**(claim 없는 turn만 · 만료·재시작 회계 유지)와
    **권위 있는 `chargeDispatchTurnUsage({permit,…})`**(durable `execution.chargedPlanDigest`를 남긴다)로
    갈랐다. 효과 게이트가 run 전역 `chargedTurnIds`가 아니라 **이 task의** `turnId`+`chargedPlanDigest`를
    claim된 turn/계획/attempt와 함께 본다 → claim 없는 sibling의 0 토큰 과금이 남의 효과를 승인하지 못한다.
    진행은 `startPreparedTask()`가 발급하는 **brand된 worker 채널 + 단조 seq**로만(복사한 lease·구조
    사본·재생·역순·sibling 거부). `assertClockSane`이 `now < state.updatedAt`도 거부한다(safety-only 포함).
  - **A2** 공개 `executeUnderGrant(grant, op, 임의콜백)` **삭제** → kind별 고정 진입점
    `executeWriteFileOperation` + 고정 집행기 `writeFileEffect.judgeWriteFile`(신규 파일 · kernel을
    **타입으로만** import해 순환 0 · 신규 의존성 0). 집행 경계 진입을 **효과보다 먼저** durable에 적고
    (`PendingOperation.attemptedAt`), 그 뒤에는 재발급도 `failOperation`도 거부한다.
  - **A3** 신규 `reconcileUncertainOperation()` — **kernel handle 0**, durable 신원 8종 전수 대조,
    marker는 durable 진실에서 파생(`attemptedAt` 있으면 `outcome_unknown`, 없으면 `failed`),
    path/hash/exit는 항상 null. safety-only라 만료·deadline·`running`/`cleaning` 어디서나 열려 있고
    정합화 뒤 cleanup·settle이 정상 진행된다.
  - **C-1** `dispatchTurnId` 서술을 lazy replacement로 · pending schema의 없는 재시작 경로 주장 정정 ·
    schema 대조 테스트 4종 이름을 "구조적으로 일치한다"로(draft-07 validator는 **여전히 미추가**).
  - **`C-42` 폐기(closed)** — 유예가 아니라 A1ⓑ가 그대로 구현했다.
- **정정한 과대주장**: 직전 블록의 `A1`(bare run-global turn ID 승인 · 복사 가능한 lease · seq 비단조 ·
  safety-only 시계 역행) · `A2`(임의 콜백의 효과 없는 성공 · 효과 뒤 재발급 · 부분 효과 뒤 평범한 실패) ·
  `A3`(WeakMap handle 의존 → 재시작 뒤 영구 미아). 표는 WORKLOG 최상단.
- **여전히 유효한 폐쇄**: A4(발행 fail closed) · B1(정리 우선) · B2(spawn 0 계약) · C1(멱등 재발급) ·
  C2(적대적 manifest 단일 입양) — 4차 리뷰가 재확인했고 이번에 건드리지 않았다.
- **열린 미래 게이트**: **`B-16`**(typed write 신규 발행 fail closed — 첫 typed-write 산출물 배선 전) ·
  **신규 `B-F1`**(managed launcher 첫 소비자 전: 1회 소비 · 살아 있는 pending/grant · durable 재독 ·
  spawn 직전 node/entrypoint digest 재검증).
- **안 끝난 것(M5c의 남은 핵심)**: **`StableController` 재작성·배선**(다음 DAG task) · managed process
  supervisor + 자손 정리(`B-13`/`C-18`) · trusted Git(`C-26`) · 구조화 리뷰 검증(`C-19`/`C-35`) ·
  `autopilot` CLI · legacy `exec`/`mission` 비활성화 · build/dist · M5d.
- **검증(실측)**: `npx tsc --noEmit` 0 error · 파일 단독 `typedExecution` **56/56** ·
  `autopilotLifecycle` **28/28** · `orchestrationKernel` **103/103** · `executionBoundary` **20/20** ·
  `offlinePlanWorker` **10/10**(동시 합계 **217/217**) · `m4a` **32/32** · `m4b` **45/45** ·
  `m4c` **80/80** · `git diff --check` clean · mutation **7종** 전부 red 확인 후 원복
  (`git status --short` = `?? node_modules` 한 줄 · 잔재 grep 0).
- **알려진 red**: `stableController.test.ts` **3 pass / 55 fail**(이번 변경 전후 동일 · 다음 DAG task 범위 ·
  측정만 하고 수정하지 않았다).
- **미실행**: `npm test` · `test:core` · `test:exec` · 전체 acceptance · stress · live · 반복 · build/dist.
- **다음 DAG task는 시작하지 않았다**: controller 재작성·배선 · managed launcher · trusted Git · 첫 spawn ·
  M5d · live. **정정(6차 리비전)**: 이 자리의 `fable5` 모델 문구는 사용자 의도의 오기였다 — 사용자는 도구를 바꿀 것이며 **현재 Task 3A 마감 후 Codex는 이후 작업을 시작하지 않는다**(이후는 사용자 별도 지시).

## 이전 (2026-07-31 — **V3 M5c task 3A 3차 리비전: 독립 재리뷰 `REVISE A=4·B=2·C=3`의 A 4건 + B 2건 + C 3건 닫음** · 그 시점 기록 — 위 4차 블록이 A1~A3를 다시 열어 정정했다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `2956ffc` ·
  코드 커밋 **`d4a6596`**. fresh Claude Opus 5 단일 세션(이전 작성자 transcript·자기평가 미상속 · 재개
  아님) · Ponytail **full**. 입력 권위:
  `/private/tmp/m5c-task3a-revision2-codex-review-output.txt`(Codex `gpt-5.6-sol` xhigh read-only ·
  세션 `019fb5fb-89ec-7e40-90a9-4a4e7e66d3c2` · 범위 `16cdc87..2956ffc`).
- **닫은 것**
  - **A1** 순서를 계약으로: **permit(claim) → `chargeTurnUsage` → grant → 효과**. 효과 게이트가
    `chargedTurnIds`를 요구한다(신규 `budget_turn_unaccounted`) → 토큰 판정이 stale일 수 없다.
    과금은 claim을 닫지 않고, **끝난 claim**(과금 + 미확정 0)만 다음 turn이 교체한다(지연 해제).
    `recordProgress`는 소진된 창을 되살리지 못하고 attempt lease + worker `progress` 이벤트를 요구한다.
    전진 시각은 `state.updatedAt`에 대해 단조여야 한다.
  - **A2** durable pending 신원당 **살아 있는 grant 1개**(새 발급이 이전 것 폐기 → live/live 중복 불가).
    `consumeExecutionGrant` 삭제 → `executeUnderGrant(grant, op, effect)`(진입 일회용 · 정상 반환 시에만
    canonical 결과를 굳혀 **opaque handle**). `recordOperationReceipt({outcome})`가 저장된 값을 적고,
    미시도·실패는 신규 `failOperation(denied|failed)`로만 닫힌다. 영수증·event에 attempt/turn/planDigest.
  - **A3** 영수증 정합화가 **safety-only**(만료·deadline·`cleaning` 뒤에도 가능 · 신원 전수 확인).
    attempt를 떠나거나 리셋하는 전이는 pending이 있으면 전부 거부. 런타임·schema 불변식으로 pending을
    attempt/turn/plan digest에 묶고 그 밖의 state에서 금지.
  - **A4** **신규 발행 fail closed**(`write_publish_unsupported`) — pathname `link(2)`의 부모 교체 경쟁을
    예방할 수 없고 Node 18/macOS에 디스크립터 상대 primitive가 없다. `process.chdir` 우회는 평가 후
    **채택하지 않았다**. temp를 만들지 않으므로 부작용 0.
  - **B1** temp 소멸로 unlink/truncate durability·고아 plaintext가 성립하지 않는다. fd 반납 실패는
    `write_cleanup_unconfirmed`이고 **1차 오류에 가려지지 않는다**(복합 처리).
  - **B2=`B-10`** action별 입력 계약(`data: string[]` → `{planPath}` + 정규화·소유·범위 검사) ·
    공개 `ProcessLaunchSpec` 삭제 → opaque `ProcessLaunchCapability`(실행 대상·argv·digest 비노출) ·
    권능 발급은 순수 판정이라 **spawn 없는 계획이 성공을 만들 수 없다**. **spawn 0 유지.**
  - **C1** 같은 (turn,계획) 재발급이 durable 커밋 없이 멱등 · **C2** manifest validator 단일 입양
    (accessor·proxy 거부) · **C3** schema 과대주장 정정 + 낡은 서술 수정(draft-07 validator는 **미추가**).
- **정정한 과대주장**: 직전 블록의 `A1`(생산 turn 과금이 효과 뒤 · 늦은 진행 부활 · 시계 역행) ·
  `A2`(live/live grant · 구조적 영수증 · spawn 없는 성공) · `A3`(신규 발행 창은 열려 있었다) ·
  `B1`(unlink/truncate durability · 1차 오류 은폐) · `B-10`("게이트 해제"는 과장). 표는 WORKLOG 최상단.
- **이번 리비전이 만든 기능 공백(정직)**: `applyWriteFile`이 **새 파일을 만들지 못한다** → 대장 신규
  **`B-16`**(기한: typed write로 실제 산출물을 만드는 첫 배선 전). 신규 **`C-42`**(진행 provenance를
  kernel brand 스트림 채널로 승격 — controller 배선 task).
- **안 끝난 것(M5c의 남은 핵심)**: **`StableController` 재작성·배선**(다음 DAG task) · managed process
  supervisor + 자손 정리(`B-13`/`C-18`) · trusted Git(`C-26`) · 구조화 리뷰 검증(`C-19`/`C-35`) ·
  `autopilot` CLI · legacy `exec`/`mission` 비활성화 · build/dist · M5d.
- **검증(실측)**: `npx tsc --noEmit` 0 error · 파일 단독 `typedExecution` **47/47** ·
  `autopilotLifecycle` **28/28** · `orchestrationKernel` **103/103** · `executionBoundary` **20/20** ·
  `offlinePlanWorker` **10/10**(동시 합계 **208/208**) · `m4a` **32/32** · `m4b` **45/45** ·
  `m4c` **80/80** · `git diff --check` clean · mutation **6종** 전부 red 확인 후 원복(세 파일 SHA-256
  바이트 일치 · 잔재 grep 0).
- **미실행**: `npm test` · `test:core` · 전체 acceptance · `test:exec` · stress · live · 반복 · build/dist ·
  `stableController.test.ts`(**이 세션은 그 파일을 열지 않았다** — 다음 DAG task 범위).
- **다음 DAG task는 시작하지 않았다**: controller 재작성·배선 · managed launcher · trusted Git · 첫 spawn ·
  M5d · live. **정정(6차 리비전)**: 이 자리의 `fable5` 모델 문구는 사용자 의도의 오기였다 — 사용자는 도구를 바꿀 것이며 **현재 Task 3A 마감 후 Codex는 이후 작업을 시작하지 않는다**(이후는 사용자 별도 지시).

## 이전 (2026-07-30 — **V3 M5c task 3A 2차 리비전: 독립 재리뷰 `REVISE A=4·B=2·C=3`의 A 4건 + B 2건 닫음. M5c는 여전히 미완료** · **그 시점 기록** — 현행은 맨 위 블록이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `16cdc87` ·
  코드 커밋 **`cecc529`** · stack base `81554cf`. fresh Claude Opus 5 단일 세션(이전 작성자 transcript·
  자기평가 미상속 · 재개 아님) · Ponytail **full**. 입력 권위: `/private/tmp/m5c-task3a-rereview-output.txt`.
- **닫은 것**
  - **A1** dispatch 권위를 **정확히 하나의 turn/계획**에 durable하게 묶었다: `issueOperationDispatchPermit()`이
    커밋이 되어 `execution.dispatchTurnId`/`dispatchPlanDigest`를 claim한다(다른 turn=`dispatch_identity_stale` ·
    같은 turn의 다른 계획=`dispatch_plan_conflict` · 과금된 turn 재개방=`turn_already_charged` · 같은
    (turn,계획) 재발급은 멱등). `chargeTurnUsage()`가 turn을 닫는다. permit이 공개 `getState()`가 아니라
    private `#state`를 읽는다. 효과 직전마다 **토큰·attempt wall·no-progress 등호**를 추가로 본다.
  - **A2** 신규 `beginOperation()`이 **집행 전** durable `pendingOperations`를 커밋하고 **일회용 execution
    grant**를 발급한다. 효과 게이트가 소진하고 `recordOperationReceipt({grant,…})`가 소비한다. 성공 marker는
    효과 게이트를 지난 grant에서만 나온다. 미확정 operation이 있으면 turn도 완료·차단도 막힌다. 재시작
    정합화는 결정론적(멱등 재집행 → `already_applied` → 영수증 1건).
  - **A3** 기존 경로 교체를 **temp 생성 전에** `write_replace_unsupported`로 거부하고 `renameSync` 발행을
    **삭제**했다. 발행은 부재 대상 `link(2)` no-replace뿐이다(네이티브 의존성 0).
  - **A4** `already_applied`도 **부모 fsync 성공 뒤에만** 반환한다(계속 실패 = 계속
    `write_durability_unconfirmed`).
  - **B1** close·unlink 실패를 `write_cleanup_unconfirmed`로 올린다(성공 삼킴 0). 지울 수 없는 temp는
    소유 fd로 `ftruncate(0)` → **0바이트**(승인 내용 노출 0) · 이름이 operation 신원 파생이라 귀속 가능.
  - **B2=`B-10`** `executionAuthority.controllerEntrypoint`(digest 고정) 필수 + 승인 레코드에서
    `executable`/`args` 삭제 → 닫힌 `action` enum + **데이터 전용** `data`(`-` 시작 금지). argv는
    `[entrypoint, action, ...data]`로 파생. **spawn 0 유지.**
  - 부수: `C-41`(executionBoundary v1 fixture) **1/20 → 20/20** · `C-38` kernel 행(호출자 taxonomy 선택) 폐쇄.
- **정정한 과대주장**: 직전 블록의 "A3 fixed"(최종 pathname `rename` 창은 열려 있었다) · "인접 B fixed"
  (fsync 재시도·정리 실패·plaintext temp 미해소) · "A2 fixed"(경쟁 turn·구조적 영수증·permit 재사용 미해소).
  상세 표는 `docs/WORKLOG.md` 최상단.
- **안 끝난 것(M5c의 남은 핵심)**: **`StableController` 재작성·배선**(다음 DAG task) · managed process
  supervisor + 자손 정리(`B-13`/`C-18`) · trusted Git(`C-26`) · 구조화 리뷰 검증(`C-19`/`C-35`) ·
  `autopilot` CLI · legacy `exec`/`mission` 비활성화 · build/dist · M5d.
- **검증(직렬 실측)**: `npx tsc --noEmit` 0 error · `typedExecution` **46/46** · `offlinePlanWorker` **10/10** ·
  `autopilotLifecycle` **28/28** · `orchestrationKernel` **103/103** · `executionBoundary` **20/20**
  (동시 실행 합계 **207/207**) · `git diff --check` clean · mutation **8종** 전부 해당 테스트 실패 확인 후
  일반 편집으로 원복(6번은 처음에 0건 실패 → 커버리지 구멍을 찾아 테스트를 추가한 뒤 실패 확인).
- **알려진 red**: `stableController.test.ts` **3 pass / 55 fail**(이번 변경 전후 동일 · 다음 DAG task 범위).
- **미실행**: `npm test` · `test:exec` · `test:core` · 전체 acceptance · M4 acceptance 3종 · stress · live ·
  반복 3회 · build/dist · M5d. 최종 전체 suite 1회는 **M5 최종 handoff에 예약**돼 있다.
- 다음 세션 첫 작업: **`StableController` 재작성 + grant/pending lifecycle 배선**.

## 이전 (2026-07-30 — **V3 M5c task 3A 리비전: 독립 리뷰 A 4건 + 인접 filesystem B 닫음** · 그 시점 기록)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `5a35bce` ·
  코드 커밋 `f132d87` · stack base `81554cf`. fresh Claude Opus 5 단일 세션(이전 작성자 transcript 미상속) ·
  Ponytail(full). 입력: 독립 fresh Codex 리뷰 `REVISE · A=4 · B=2 · C=3`.
- **닫은 것**: ⓐ **A1** 적대적 바이트 입양 — intrinsic `%TypedArray%` getter만 사용(`Symbol.species`·
  iterator·constructor·caller property 읽기 0 · Proxy receiver 거부) · **상한을 할당·복사보다 먼저** ·
  Buffer 수락 · SAB는 복사(alias 0) · detached/축소 resizable 안정 거부 · **accessor는 성공해도 거부이며
  실행조차 되지 않는다**(descriptor `value`만 읽는다) ⓑ **A2** 위조 가능한 `OperationDispatchContext`
  삭제 → kernel 발급 **봉인 permit**(모듈 사설 `WeakMap` · 발급 토큰/factory export 0)과 **효과 직전마다
  현재 durable state 재확인**(run/task/attempt/turn · `running` · preflight digest 재계산 · manifest
  canonical digest · `now < expiresAt`·`now < budgetDeadlineAt` **등호 거부** · operation의 계획 소속 신원
  비교 · 현재 ownership/writableRoots) ⓒ **A3** 부재 대상은 `link(2)` **no-replace** 발행 · 교체는 preimage
  신원·내용 발행 직전 재확인 · 부모 신원 fd 고정 + walk 재실행 · temp 확인 fd를 발행까지 유지 ·
  `O_NOFOLLOW` 부재 시 fail closed ⓓ **A4** 고립 UTF-16 surrogate 경로를 공유 정규화 계약에서 거부
  (`path_not_utf8`) + schema `not.anyOf` 정렬(astral·U+FFFD는 통과) ⓔ **인접 B** fd·temp 누수 0(`finally`
  하나) · OS 오류 닫힌 코드로 접기 · **디렉터리 fsync 확인 뒤에만 `applied`**(실패 =
  `write_durability_unconfirmed` → 재시도 `already_applied`로 수렴) ⓕ **C** 순수 validator를 신규
  `src/exec/typedPlan.ts`로 분리해 worker **transitive** 그래프를 least-authority로 만들고, schema의
  런타임 전용 불변식(중복 operationId · summary NUL)을 정직하게 문서화.
- **안 끝난 것(M5c의 남은 핵심)**: managed process supervisor + 자손 정리(`B-13`/`C-18`) · trusted Git
  (`C-26`) · **`StableController` 재작성·배선** · 구조화 리뷰 검증(`C-19`/`C-35`) · `autopilot` CLI ·
  legacy `exec`/`mission` 비활성화 · review-result schema · mutation 나머지 6종 · build/dist · M5d.
- **검증(직렬)**: `npx tsc --noEmit` 0 error · `typedExecution.test.ts` **36/36** ·
  `offlinePlanWorker.test.ts` **10/10** · `autopilotLifecycle.test.ts` **28/28** ·
  `orchestrationKernel.test.ts` **103/103** · `git diff --check`/`--cached --check` clean.
  mutation 2건(A2 만료·예산 재확인 제거 / A1 unsafe 바이트 입양 복원) → 각 named 테스트 실패 확인 후
  **정확히 원복**(`git diff --stat` 빈 출력 · 흔적 grep 0) 뒤 4종 focused 재확인.
- **red 실측 2건**: `stableController.test.ts` **3/58**(의도적 미실행 · 직전 실측 그대로) ·
  **신규 측정** `executionBoundary.test.ts` **1/20** — 원인은 이번 변경이 아니라 **직전 slice의 v2 manifest
  fail-closed**(그 파일 fixture가 v1이라 `manifest_pre_m5c_unsupported` 38회 · `path_not_utf8` 0회)이며
  **소유 범위 밖**이라 고치지 않고 대장에 등록했다.
- **미실행**: `npm test` · `test:exec` · `test:core` · 전체 acceptance · M4 acceptance 3종 · stress ·
  live · 반복 · build/dist · M5d.
- **`B-10`은 여전히 열린 하드 게이트**다(`run_process` spawn 0 유지 · 첫 spawn 전 digest 고정 entrypoint
  필요). 실제 Claude/Codex는 **부재·비활성**, dist는 M5b 상태. 다음 세션의 첫 작업: **managed process
  supervisor + `StableController` 배선**. **M5c는 self-approved가 아니다.**

## 이전 (2026-07-30 — **V3 M5c task 3A: typed 계획 validator · offline plan worker · 권위 집행. M5c는 여전히 미완료** · 그 시점 기록이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `0c0011a` ·
  stack base `81554cf`. fresh Claude Opus 5 단일 세션 · Ponytail(full).
- **끝난 것(신규 파일 5개 · 기존 파일 변경 0)**: ⓐ `typedExecution.ts` — 닫힌 `TypedExecutionPlan`
  validator(모든 property 1회 입양 · 미상/누락 key · symbol · 이질 prototype · getter/proxy trap · 함수 ·
  순환 · 중복 id · binding · 상한 · Unicode 경로 경계를 전부 `plan_invalid`로 접는다 · **호출자가 던진
  오류 코드도 접는다** = `C-38` 이 seam에서 닫힘 · 결과는 깊이 동결) ⓑ controller 소유 권위 해석 +
  실제 `write_file` 집행(deny-by-default · dispatch 시점 경로·**durable child ownership**·writableRoots
  재검사 · symlink/비일반 파일 거부 · 배타 temp → 재확인 → 원자적 rename · **크래시 창 멱등
  `already_applied`** · 충돌 시 무쓰기 · 내용 없는 닫힌 영수증) ⓒ `run_process`는 **spawn 0** — 승인
  레코드에서만 나오는 동결 데이터 명세뿐(callback·env·cwd·shell·PATH·argv 확장 표현 불가)
  ⓓ `offlinePlanWorker.ts` — 데이터 전용 backend(파일 시스템·프로세스·git·provider·네트워크·환경·
  callback **import조차 0**) · bounded UTF-8 JSON 1회 파싱 → 같은 validator → 동결 → turn마다 새 스트림
  (`started → progress ≥1 → terminal 1건 → 정상 종료`, `silent_session` 구조적 불가) · `claude`/`codex`
  등 미상 backend hard reject ⓔ `schemas/typed_execution_plan.schema.json`(draft-07 · 전 계층 closed ·
  런타임 동치 · 경로 길이 코드 포인트 정본 공유).
- **안 끝난 것(M5c의 남은 핵심)**: managed process supervisor + 자손 정리(`B-13`/`C-18`) · trusted Git
  (`C-26`) · **`StableController` 재작성·배선** · 구조화 리뷰 검증(`C-19`/`C-35`) · `autopilot` CLI ·
  legacy `exec`/`mission` 비활성화 · review-result schema · mutation 나머지 7종 · build/dist · M5d.
- **검증(직렬)**: `npx tsc --noEmit` 0 error · `typedExecution.test.ts` **23/23** ·
  `offlinePlanWorker.test.ts` **8/8** · `autopilotLifecycle.test.ts` **27/27** ·
  `orchestrationKernel.test.ts` **103/103** · `git diff --check` clean.
  비공허성: 권위 대조 mutation 1건 → named guard 포함 2건 실패 확인 후 **정확히 원복**(sha256 일치).
- **여전히 red**: `stableController.test.ts` **3/58**(이 slice는 controller를 건드리지 않아 의도적으로
  **미실행**이며 직전 실측 그대로다). **미실행**: `npm test` · `test:exec` · `test:core` · 전체
  acceptance · M4 acceptance 3종 · stress · live · 반복 · build/dist · M5d.
- **`B-10`은 부분**이다(offline typed 경로 집행기만). 실제 Claude/Codex는 여전히 **부재·비활성**이고
  dist는 M5b 상태 그대로다. 다음 세션의 첫 작업: **managed process supervisor + `StableController` 배선**.
  **M5c는 self-approved가 아니다.**

## 이전 (2026-07-30 — **V3 M5c green-recovery slice: v2 schema 정본화 + kernel/M4 검증면 green. M5c는 여전히 미완료** · **그 시점 기록** — 현행은 맨 위 블록이다)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · 시작 HEAD `23d663c` ·
  stack base `81554cf`. fresh Claude Opus 5 단일 세션 · Ponytail(full).
- **끝난 것**: ⓐ 계약 문서 2종을 **v2 정본**으로 갱신(`orchestration_run_state` = `schemaVersion "2"` ·
  필수 `accounting`/`task.execution`/`message.delivery` · 상태 11종 · event 19종 · 사유 21종 · 닫힌 감사
  필드 7종 · marker/pause/cleanup/operation enum · `eventMarker` 합집합 32종 / `milestone_approval_manifest`
  = `autopilotPolicy` 8필드 상·하한 · 닫힌 typed operation union · `node`/`processObserver` + nullable
  `codex`) ⓑ schema↔runtime **동치 단정을 새 v2 표면 전부로 정확히 확장**(경계 밖 값 runtime 거부까지 확인)
  ⓒ kernel 테스트와 M4 acceptance 3종을 **진짜 lifecycle 경로**로 이관(preflight → start / terminal →
  cleanup → 완료 / 시도 → 수령) ⓓ legacy `startTask`/`startScheduledBatch` 거부 테스트 보존(기대 코드
  `preflight_required`) ⓔ M4 acceptance가 **`dist` 대신 `src`를 소비**하도록 고쳤다(dist는 M5b 계약이라
  acceptance가 낡은 계약을 검사하며 green이었다 — 호출 방식은 `node scripts/m4X-...` 그대로).
- **안 끝난 것(M5c의 남은 핵심)**: typed 실행 집행 · trusted Git · managed process supervisor + 자손 정리 ·
  offline plan worker · 구조화 리뷰 검증(`C-19`/`C-35`) · **`StableController` 재작성** · `autopilot` CLI ·
  legacy `exec`/`mission` 비활성화 · typed-plan/review schema JSON · mutation 8종 · M5d.
- **검증(직렬)**: `npx tsc --noEmit` 0 error · `autopilotLifecycle.test.ts` **27/27** ·
  `orchestrationKernel.test.ts` **103/103** · `m4a` **32/32** · `m4b` **45/45** · `m4c` **80/80**(셋 다 exit 0) ·
  `git diff --check 81554cf..HEAD` clean.
- **여전히 red**: `stableController.test.ts` **3/58** — controller가 아직 `startScheduledBatch()`를 부른다
  (런타임 소스 무변경이라 이전 블록과 같은 수치다). **미실행**: `npm test` · 전체 `test:core` ·
  전체 acceptance · `npm run test:exec` · stress · live · mutation · build/dist.
- **dist는 여전히 M5b 상태**(src↔dist drift) → 배포 가능 상태가 **아니다**. 단, M4 acceptance는 이제 src를
  보므로 그 drift가 검증면을 속이지 않는다.
- 다음 세션의 첫 작업: **`StableController` 재작성**(단일 scheduler + cleanup-before-completion + durable
  회계 연결)으로 남은 red를 닫고 typed 실행/process 계층으로 간다. **M5c는 self-approved가 아니다.**

## 이전 (2026-07-30 — **V3 M5c 착수: 기반 slice만 구현. M5c 미완료 · 기존 focused 테스트 red** · 그 시점 기록)

- worktree `/private/tmp/solo-founder-harness-m5c` · branch `work/m5c-autopilot` · base `81554cf`.
- **끝난 것**: state/manifest **v2**(마이그레이션 없는 fail closed) · lifecycle 5상태 추가 ·
  `prepared|running|cleaning`이 자원·세션 점유 · 단일 scheduler(`planRunnableBatch` →
  `commitPreflightBatch` → `startPreparedTask`, ready→running 직접 전이 제거) · durable 토큰·경과 회계
  (재시작 유지 · turn 멱등) · **확인된 zero-survivor 정리 뒤에만 완료/차단** · 전달 재시도(조기 ack 없음) ·
  만료 후 safety-only reducer 예외(DECISIONS + 로드맵 §8.1에 먼저 기록) · 대장 `C-17`·`C-24`·`C-40` 닫음 ·
  typed operation 권위 계약면(deny-by-default).
- **안 끝난 것(M5c의 남은 핵심)**: typed 실행 집행(`typedExecution.ts`) · trusted Git · managed process
  supervisor + 자손 정리 · offline plan worker · 구조화 리뷰 검증(`C-19`/`C-35`) · `StableController` 재작성 ·
  `autopilot` CLI · legacy `exec`/`mission` 비활성화 · schema JSON 4종 · mutation 8종 · M4 acceptance fixture.
- **검증**: `npx tsc --noEmit` 0 · 신규 `autopilotLifecycle.test.ts` **27/27**.
  **red**: `orchestrationKernel.test.ts` 14/103 · `stableController.test.ts` 3/58 — 원인은 미완료
  fixture/호출부 마이그레이션이며 테스트를 완화·삭제하지 않았다.
- **dist는 M5b 상태 그대로**(src↔dist drift) → 이 커밋은 배포 가능 상태가 **아니다**.
- 다음 세션의 첫 작업: controller 재작성 전에 **kernel 테스트·M4 acceptance fixture 마이그레이션**을 끝내
  green을 회복한 뒤 나머지 slice로 간다.

## 이전 (2026-07-30 — **V3 M5b 7차 리비전: 독립 Codex 재리뷰(REVISE, A/P1=2 · B=7 · C=12) 대응 · 독립 8차 리뷰 대기** · 그 시점 기록 — 현행은 맨 위 블록이다)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 시작 HEAD `ff5e035` 위에 **7차 리비전 커밋** — code/tests/dist/schema
  1건 + docs 1건. **fresh Claude Opus 5 세션**(이전 transcript·자기평가 미상속 · subagent·병렬 writer 0 ·
  공유 dirty 체크아웃이라 단일 writer). 원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 ·
  **live provider 추론** · secret 0. `node_modules`(supervisor symlink)는 stage 0이고 세션 끝에 `unlink`로
  제거했다. Ponytail(full) 적용.
- **⚠ 6차 리비전 기록의 부분성 정정**: 7차 독립 리뷰(`409dee2..ff5e035`)는 **6차 A1을 PARTIAL** ·
  **6차 A3를 PARTIAL**로 판정했다(**초기 A2 CLOSED · 초기 A4 PARTIAL**). 공통 뿌리는 **"검증을 트랜잭션
  1회 단위로 잡았다"**: ⓐ git을 **경계 진입에서 한 번** 해싱한 뒤 `readCheckoutHead()`가 `--show-toplevel`·
  `rev-parse HEAD` **두 자식 프로세스**를 각각 await했으므로, 첫 프로세스가 도는 동안 owner-writable 승인
  파일을 **같은 inode에 제자리 덮어쓰면** 두 번째가 승인되지 않은 바이트를 실행했다(`revalidateSync()` 루프도
  동일) ⓑ body 발행이 **전수 preflight 1회** 뒤 staging **경로 이름 그대로** link했으므로, hook·동시 writer가
  그 사이 staging을 갈아끼우면 교체본이 최종 body가 되고 staging도 journal도 삭제됐다(같은 digest면 남의
  inode 입양, 다른 digest면 "성공한 커밋 + 잘못된 body"). **지금도 self-approved가 아니다.**
- **7차 리비전이 닫은 것(A 2건)**:
  ⓐ **A1** — `GitGate` 하나로 **모든 git spawn이 자기 `runProcess`/`spawnSync` 직전에** 같은 fd
  (`O_RDONLY|O_NOFOLLOW`) 신원 + 승인 SHA-256을 다시 증명한다(게이트↔spawn 사이 **`await` 없음**).
  `readCheckoutHead()`의 **두 호출 각각** · `revalidateSync()`의 **controller/target 회차 각각**이 지나고,
  루프 앞 1회 검증은 제거했다. 남는 창은 **fd 해싱→exec syscall 몇 개**뿐(`fexecve` 없음 — `C-5` 종류)이며
  호출자 경로·PATH·ambient env·대체 trust root·신규 의존성은 없다.
  ⓑ **A2** — `ownershipOf()`가 **열린 fd 하나로** dev+ino·정확한 바이트 수·내용 SHA-256을 판정하고,
  **link 직전** · **link 직후** · **`finishJournal()`의 journal 삭제 직전 전수**(앞선 시도가 발행한 것까지)에서
  다시 증명한다. `journal:cleanup` hook은 전수 sweep **앞**에서 울린다. 어긋나면 **journal을 남기고**
  fail closed이며, 남의 파일을 지우거나 덮거나 채택하지 않고 재시도는 결정론적·멱등이다. journal 삭제는
  정상 커밋과 "이미 목표 state" 복구가 **같은 한 경로**로 지나고, roll back은 최종 body가 애초에 없으므로
  자기 경로를 유지한다.
- **낡은 주석 정정**: store의 "`C-37` 닫힘" · kernel/controller의 "roll forward" 서술 ·
  `setCommitFaultHook`의 "던지는 일뿐" 서술(hook은 **동기 파일 변경도 한다**). **`C-37`·`C-36`은 open.**
- **B/C**: **B 7건 그대로**(`B-7`·`B-9`·`B-10`·`B-11`·`B-12`·`B-13`·`C-12`→B — 하나도 닫지 않았다).
  **C 12건** 중 11건(`C-35`·`C-5`·`C-17`·`C-29`·`C-19`·`C-36`·`C-37`·`C-30`·`C-38`·`C-39`·`C-26`) 상태 유지 +
  신규 **`C-40`**(승인 경로 schema regex가 runtime보다 느슨 — `/a//b`·`/a/./b`·`/a/../b`)을 등록하고
  **이번에 정렬해 닫았다**: 정본 `APPROVED_PATH_PATTERN` 하나를 runtime·schema가 공유 · 양/음성 표 전수
  동치 테스트 · 정렬 전 1021 케이스 실측 불일치 0 · 양방향 mutation kill.
- **테스트(worker 자기보고 · 독립 실측 아님)**: kernel **103/103**(98 → 103) · controller **58/58** ·
  provider **59/59** · boundary **20/20**(17 → 20) · reviewer **21/21** · parser **28/28** ·
  `tsc --noEmit` clean · `build` + `git diff --check` clean · `node --check` emitted 5파일 ·
  **dist 프로브 2종**(A1 제자리 교체 → digest 불일치·spawns=1·sentinel 0 · C-40 비정규 경로 거부 /
  A2 `journal:cleanup` 제자리 변경 → `journal_body_foreign`·journal 보존·**reopen도 완료 아님**) ·
  offline acceptance `m4a` **31/31** · `m4b` **42/42** · `m4c` **77/77** ·
  race subset(경계+kernel) **3회 직렬 123/123** · `npm run test:exec` **361/361**(353 → 361, 1회) ·
  **mutation 9종 전부 kill · 살아남은 0 · `shasum -c` 바이트 동일 원복 · `MUTATION` 잔재 0**.
- **미실행**: `npm test` 전체 · `test:core` · 전체 `acceptance.sh` · stress · live · MCP · 실제 추론 · push.
- **다음 세션이 할 일**: **fresh Codex `gpt-5.6-sol` xhigh read-only 8차 리뷰**(`409dee2..HEAD` 전 범위).
  **A=0**일 때만 M5b가 M5c로 전진한다. 그 전에는 M5c 착수·전체 suite·live 금지.

## 이전 (2026-07-28 — **V3 M5b 6차 리비전: 독립 Codex 재리뷰(REVISE, A/P1=2 · B=7 · C=10) 대응** · dated history · **7차 리뷰가 A1/A3를 PARTIAL로 다시 열었다**)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 시작 HEAD `6a5e418` 위에 **6차 리비전 커밋** — code/tests/dist 1건 +
  docs 1건. **fresh Claude Opus 5 세션**(이전 transcript·자기평가 미상속 · subagent·병렬 writer 0).
  원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 · **live provider 추론** · secret 0.
  `node_modules`(supervisor symlink)는 stage 0이고 세션 끝에 `unlink`로 제거했다. Ponytail(full) 적용.
- **⚠ 5차 리비전 기록의 과장 정정**: 6차 독립 리뷰(`409dee2..6a5e418`)는 **A1을 OPEN** · **A3를 OPEN**으로
  판정했다(**A2 CLOSED · A4 PARTIAL**). ⓐ 실행 파일의 **기대값 자체가 caller 옵션**이라 provider와 controller
  양쪽에 `/usr/bin/true`·사용자 소유 0700 sentinel을 주면 path/dev/ino가 같아 `authorityMatches: true`가 됐고,
  **같은 inode 제자리 덮어쓰기**도 통과했다 ⓑ journal이 **자기 안에서만** 일관됐으므로 해시를 전부 재계산한
  **위조 후속**(다른 milestone·다른 승인·다른 task state)을 복구가 발행했고, event 정규형 판정이 key 순서를
  못 봤고, 남의 same-digest 최종 body를 **채택·덮어쓰기·삭제**할 수 있었다. **지금도 self-approved가 아니다.**
- **6차 리비전이 닫은 것(A 2건)**:
  ⓐ **A1** — 실행 권위 trust root를 **kernel 소유 승인 manifest**로 옮겼다: 필수 `executionAuthority`
  (codex·git의 **정규 절대경로 + 내용 SHA-256**) 추가 · **호출자 경로 옵션 전부 삭제**(provider·controller·경계) ·
  새 `verifyApprovedExecutable()`이 경로를 **한 번만 열어** 신원(dev+ino)·권한·**승인 digest**를 함께 판정하고
  **생성·경계 진입·모든 spawn 직전**에 재검증 → 제자리 덮어쓰기 fail closed · controller는 그 두 경로를 자기
  손으로 검증해 provider 발급 권위와 대조하고 불일치는 **git·codex spawn 이전에** 생성 거부 ·
  하위 호환은 **fail closed**(`invalid_manifest`, 마이그레이션 없음).
  ⓑ **A3** — **roll forward 폐기**(복구 규칙 = 기준이면 roll back / 목표 바이트면 마무리 / 그 밖 fail closed) ·
  발행 순서를 **journal → append → snapshot → state → 최종 body**로 재배치 · journal을 **기준 불변 권위 ·
  기준 event 접두 신원 · `validateEvent` 정본 바이트 · base→target body delta · staging dev+ino/바이트/digest**
  에 묶고 · 최종 body는 **`link(2)` no-clobber CAS**로만 발행(남의 same-digest 파일 채택·삭제 금지) ·
  rollback은 **자기 staging만** 제거.
- **B 7건은 하나도 닫지 않았다**(리뷰 원문 그대로): `B-7`·`B-9`(첫 live 실행 전) · `B-10`(edit 가능 provider
  활성화 전) · `B-11`(무인 autopilot 전) · `B-12`(첫 restart/resume 전) · `B-13`(live runner 또는 두 번째
  process-backed provider 전) · `C-12`→B(M5c autopilot 전).
  **C 10건**: `C-35`·`C-5`·`C-17`·`C-29`·`C-19`·`C-36`·`C-37`·`C-30`·`C-38` 상태 유지 + **신규 `C-43`**
  (transaction staging·atomic tmp 정리 실패 orphan). **`C-37`은 닫지 않았다** — 범위가 발행 경계 11개 중
  2개(`body:publish`·`journal:cleanup`)로 줄었을 뿐이다. `C-36`도 그대로 open.
- **테스트(worker 자기보고 — 독립 실측 아님)**: `orchestrationKernel` **98/98**(89 → 98) ·
  `stableController` **58/58**(57 → 58) · `codexCliProvider` **59/59** · `executionBoundary` **17/17** ·
  `reviewer` **21/21** · `codexStreamParser` **28/28** · authority/provenance/recovery subset
  **3회 직렬 215/215** · `npm run test:exec` **353/353** · `tsc --noEmit --pretty false` clean ·
  `build` PASS + **dist 런타임 프로브**(승인 digest 통과/불일치/**제자리 덮어쓰기** 거부 · 권위 불일치
  `authorityMatches:false` · `executionAuthority` 없는 manifest `invalid_manifest` · foreign tail
  `journal_foreign` + 바이트 보존 · **유효 journal + 완전 append → roll back** · spawn 0) ·
  `git diff --check` clean · kernel 계열 offline acceptance 개별 재실행(`m4a` 31 · `m4b` 42 · `m4c` 77).
  **mutation 13종 전부 kill · 살아남은 0 · 바이트 동일 원복 · `MUTATION` 잔재 0.**
  **정직한 기록**: 세션이 중간에 한 번 끊겨 `test:exec`·subset 3회를 재개 후 다시 돌렸다(위 수치가 재개분이다).
- **미실행**: `npm test` 전체 · `test:core` · 전체 `acceptance.sh` · stress · live · MCP · 실제 Codex/Claude 추론.
  전체 suite 1회는 **최종 M5 handoff(M5d 이후) 직렬 1회**로 예약돼 있다.
- **다음 게이트**: supervisor의 **fresh Codex `gpt-5.6-sol` xhigh read-only 독립 재리뷰**. 위 fixed 판정
  **전부가 재확인 대상**이다 — 이 세션은 스스로를 승인하지 않는다.

## 이전 (2026-07-28 — **V3 M5b 5차 리비전: 독립 Codex 재리뷰(REVISE, A/P1=4 · B=7 · C=9) 대응** · dated history · **6차 리뷰가 A1/A3를 다시 열었다**)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 시작 HEAD `35de547` 위에 **5차 리비전 커밋** — code/tests/dist
  `e477235` + docs 1건. **fresh Claude Opus 5 세션**(이전 transcript·자기평가 미상속 · subagent·병렬 writer 0).
  원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 · **live provider 추론** · secret 0.
  `node_modules` stage 0. Ponytail(full) 적용.
- **⚠ 4차 리비전 기록의 과장 정정**: 5차 독립 리뷰(`409dee2..35de547`)는 **A1을 PARTIAL** · **A3를 OPEN(3건)** ·
  **A4를 PARTIAL**로 판정했다(**A2만 CLOSED**). ⓐ 증명이 **메서드 신원만** 보므로 숨은 `executablePath`·
  `gitExecutablePath`·manifest·checkout이 무엇이든 통과했다(**실측: `/bin/echo`·`/bin/true` 증명 통과**) →
  사용자 소유 0700 스크립트가 승인 경계 안에서 실제로 실행될 수 있었다 ⓑ **최종 message body가 journal보다
  먼저** 생겨 실패한 전이가 색인되지 않은 durable 파일을 남겼다(다른 id로 재시도하면 영구) ⓒ 복구가 **정확히
  일치하지 않는 모든 event suffix를 truncate**해 남의 append-only 감사 바이트를 파괴할 수 있었다 ⓓ journal
  schema가 **열려 있고 전이에 묶이지 않아** 그럴듯한 journal 하나로 유효 state를 덮어쓸 수 있었다.
  **지금도 self-approved가 아니다.**
- **5차 리비전이 닫은 것(A 4건)**:
  ⓐ **A1** — 증명이 **불변·정규·런타임 검증된 설정 신원**(codex/git 실행 파일 dev+ino · checkout · 승인
  canonical digest · 시각 권위)을 근거로 하고, 판정 함수는 **호출자가 스스로 검증해 온 기대값과의 대조 결과만**
  준다. `StableController`에 **명시 필수 `codexExecutablePath`** 추가 → 불일치는 **git·codex spawn 이전에**
  `controller_provider_authority_mismatch`로 생성 거부. 실행 파일 신원은 **매 invocation 생성 시점 pin으로**
  재검증하고 git 신원은 실행 경계에도 pin으로 간다. 시각 권위는 **controller와 같은 함수 또는 진짜 `Date.now`**만.
  ⓑ **A3(body)** — **staging → journal → 최종 이름** 순서. journal 전 실패는 스스로 정리(최종 body 0),
  이후는 복구가 유일한 정리 주체(roll forward는 참조 body **전부** 확인·발행 / roll back은 **자기 파일만** 삭제).
  ⓒ **A3(suffix)** — `baseEventBytes` 이후 **실제 바이트**로 판정: 완전 append → roll forward · **정확한 접두**
  → roll back · 그 밖은 `journal_foreign` fail closed + **모든 파일 바이트 보존**.
  ⓓ **A3(journal)** — **closed schema + 전이 전수 묶기**(경로 runId · milestone · 승인 digest · 기준 state
  원본 바이트 digest·chain · 후속 revision · 정규 event record · eventId/prevHash 체인 · 최종 hash ·
  state 정규 바이트/내용 digest · body 대상+digest), **쓰기·삭제 전에 전수 검증**.
- **B 7건은 하나도 닫지 않았다**(리뷰 원문 그대로): `B-7`·`B-9`(첫 live 실행 전) · `B-10`(edit 가능 provider
  활성화 전) · `B-11`(무인 autopilot 전) · `B-12`(첫 restart/resume 전) · `B-13`(live runner 또는 두 번째
  process-backed provider 전) · `C-12`→B(M5c autopilot 전).
  **C 9건**: `C-35`·`C-5`·`C-17`·`C-29`·`C-19`·`C-36`·`C-37`·`C-30` 사실·기한 유지 + **신규 `C-38`**
  (caller getter가 artifact 거부 taxonomy를 고를 수 있다 — durable 오염·성공 marker는 불가능).
  `C-36`/`C-37`은 **직접 증거가 없어 재분류하지 않았다**(그대로 open).
- **테스트(worker 자기보고 — 독립 실측 아님)**: `orchestrationKernel` **89/89** · `stableController` **57/57** ·
  `codexCliProvider` **59/59** · `executionBoundary` **17/17** · `reviewer` **21/21** ·
  `npm run test:exec` **343/343**(최종 원복 구현으로 1회) · authority/provenance/recovery subset
  **3회 직렬 205/205** · `tsc --noEmit` clean · `build` PASS + **dist 런타임 프로브**(emitted JS에서 임의
  실행 파일 provider 대조 실패 · foreign suffix `journal_foreign` + 바이트 보존 · 미상 필드 journal
  `journal_invalid` · sentinel 프로세스 0) · `git diff --check` clean · kernel 계열 offline acceptance 개별
  재실행(`m4a` 31 · `m4b` 42 · `m4c` 77). **mutation 11종 전부 kill · 살아남은 0 · 바이트 동일 원복.**
  **정직한 관측**: `test:exec` 첫 실행에 부하 기인 `boundary_git_failed` 1건(고정 10초 git 상한), 즉시
  재실행 343/343 — 완화 없이 기록만 남겼다.
- **미실행**: `npm test` 전체 · `test:core` · 전체 `acceptance.sh` · stress · live · MCP · 실제 Codex/Claude 추론.
  전체 suite 1회는 **최종 M5 handoff(M5d 이후) 직렬 1회**로 예약돼 있다.
- **다음 게이트**: supervisor의 **fresh Codex `gpt-5.6-sol` xhigh read-only 독립 재리뷰**. 위 fixed 판정
  **전부가 재확인 대상**이다 — 이 세션은 스스로를 승인하지 않는다.

## 이전 (2026-07-28 — **V3 M5b 4차 리비전: 독립 Codex 재리뷰(REVISE, A/P1=4 · B=7 · C=5) 대응** · dated history)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 시작 HEAD `d554a46` 위에 **4차 리비전 커밋** — code/tests/dist
  `b64974a` + docs 1건. **fresh Claude Opus 5 세션**(이전 transcript·자기평가 미상속 · subagent·병렬 writer 0).
  원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 · **live provider 추론** · secret 0.
  `node_modules` stage 0. Ponytail(full) 적용.
- **⚠ 3차 리비전 기록의 과장 정정**: 4차 독립 리뷰(`409dee2..d554a46`)는 3차 A1~A3를 **PARTIAL**로 판정했다 —
  executor 신원·오류 provenance는 닫혔지만 ⓐ controller/provider의 **나머지 상태가 런타임에서 writable**
  (`sealed`·`pins`·`tokensUsed`·`opts`) ⓑ **완료 권위가 구조적 검사뿐**이라 가짜 kernel이 디스크 변화 0으로
  success 발급 ⓒ **물리 발행이 여전히 네 연산**. 네 번째는 caller-owned artifact getter 재읽기(A4).
  **지금도 self-approved가 아니다.**
- **4차 리비전이 닫은 것(A 4건)**:
  ⓐ **A1** — controller 권위·pin·토큰 카운터·`opts`와 **게이트 메서드 14개**를 `#private`으로, 인스턴스·
  prototype을 **freeze**(own property 0 · 대입/`defineProperty` 전부 throw · 토큰 리셋 불가 · 게이트
  no-op 덮어쓰기 불가). provider는 **생성 시점 immutable `#config`** 만 실행 권위로 쓰고(호출자 `opts`는
  tripwire 전용), `id`는 prototype getter, 증명은 **own property 0**만 통과.
  ⓑ **A2** — kernel 모듈에 **사설 발급 등록부 + 사설 생성 토큰**, 인스턴스 own property 0 · freeze,
  `paths`는 prototype getter(freeze된 값). controller는 진짜 instance/prototype/메서드 신원만 캡처하고
  구조적 객체·delegate·proxy·subclass·override는 **생성에서 거부**(`controller_kernel_not_genuine`).
  성공 회귀는 **디스크 변화 + 새 kernel reopen `completed`** 로 확인한다.
  ⓒ **A3** — `commitRun`이 준비(예정 state를 **런타임 validator 전수**로 재검증) → 발행(**`commit.journal`**
  원자적 rename → append → snapshot → state → journal 삭제)이고, 다음 열기가 **결정론적·멱등** roll
  forward/roll back한다. 발행 경계 **10곳 전수** fault 주입 + 찢어진 append + journal 변조 4종 회귀.
  ⓓ **A4** — caller-owned `{path, role}`을 **닫힌 key 집합 + 단일 읽기**로 입양(두 등록 경로 같은 헬퍼),
  교대 getter는 첫(검증된) 값으로만 굳고 나머지 적대 입력은 durable delta 0으로 거부.
- **B 7건은 하나도 닫지 않았다**(리뷰 원문 그대로 유지): `B-7`·`B-9`(첫 live 실행 전) · `B-10`(edit 가능
  provider 활성화 전) · `B-11`(무인 autopilot 전) · `B-12`(첫 restart/resume 전) · `B-13`(live runner 또는
  두 번째 process-backed provider 전) · `C-12`→B(M5c autopilot 전).
  **C 5건 유지·갱신**: `C-35`(신규 `ReviewSubject` closed) · `C-5` · `C-17` · `C-29` · `C-19`.
  **신규 절충 2건 등록**: `C-36`(store 전용 fault seam) · `C-37`(roll-forward가 미승인 커밋을 완료로 만든다).
- **테스트(worker 자기보고 — 독립 실측 아님)**: `orchestrationKernel` **82/82** · `stableController` **54/54** ·
  `codexCliProvider` **59/59** · `npm run test:exec` **333/333** · authority/provenance/recovery subset
  **3회 직렬 195/195** · `tsc --noEmit` clean · `build` PASS + dist parity(emitted JS의 `#private`·freeze·
  발급 등록부 런타임 확인) · `git diff --check` clean · kernel 계열 offline acceptance 개별 재실행
  (`m4a` 31 · `m4b` 42 · `m4c` 77). **mutation 7종 전부 kill · 살아남은 것 0 · 정확히 원복.**
  **`npm test` 전체·전체 acceptance·stress·live 미실행**(최종 M5d handoff에서 supervisor 직렬 1회).

## 이전 (2026-07-28 — **V3 M5b 3차 리비전: 독립 Codex 재리뷰(REVISE, A/P1=3) 대응**)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 시작 HEAD `38b8d32` 위에 **3차 리비전 커밋**(code/tests/dist + docs).
  **fresh Claude Opus 5 세션.** 원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 · **live provider 추론** ·
  secret 사용 0. `node_modules` stage 0. Ponytail(full) 적용.
- **⚠ 2차 리비전 기록의 과장 정정**: 2차는 A2(증명)·A5b(닫힌 taxonomy)를 "닫았다"고 적었지만 **같은
  뿌리가 남아 있었다** — 증명과 provenance의 근거가 여전히 **공개 API 표면**이었다. 3차 독립 리뷰
  (`409dee2..38b8d32`)가 **A/P1=3**을 냈다. **지금도 self-approved가 아니다.**
- **3차 리비전이 닫은 것**:
  ⓐ **A1 (증명 위조)** — 공개 `opts.spawn`으로 **임의 executor를 주입한 인스턴스도 증명**됐고 TS
  `private spawnFn`은 writable own field라 테스트가 실제로 덮어썼다 → 모듈 사설 `PRODUCTION_SPAWN` +
  `#spawn`·`#sessions` **ECMAScript `#private`** + **`opts.spawn`을 준 인스턴스는 비증명**(하위 계층
  테스트용 untrusted seam은 유지). **controller 성공 경로 테스트는 실제 OS 자식 프로세스**(기존
  `__fixtures__/fake-codex.mjs`를 절대 `process.execPath` shebang 래퍼로 감싼 0700 실행 파일)로
  production 생성·argv·env·stdin·파서를 지난다. 세션 종료 관측도 **공개 API 프로브**로 바꿨다.
  ⓑ **A2 (provenance 위조)** — exported `ControllerError`를 `instanceof`로 신뢰해 handoff가
  `new ControllerError("result_accepted")`로 성공 marker를 심을 수 있었다 → 모듈 사설 `ISSUED_HERE`
  WeakSet만 provenance이고 경계는 **예외 없이** 접는다. 호출자 콜백 전수 차단(handoff · provider ·
  **`opts.nowMs` 시계** · **`opts.kernel` 전 메서드** · kernel 반환값의 throwing getter).
  kernel native 코드는 **닫힌 집합 `KERNEL_MARKERS`(23종)** 만 입양하고 나머지는 `kernel_rejected`.
  `consumeExactlyOneTerminal`은 클래스 대신 **factory**를 받는다.
  ⓒ **A3 (비원자 완료)** — 산출물마다 durable commit 뒤 별도 `submitResult`라서 뒤쪽 실패 시 **앞선
  artifact·event·revision만 남았다** → kernel 원자 트랜잭션 **`completeTaskWithArtifacts`** 하나로 합쳤다
  (검증 전부 선행 · 개수 상한 16 · 경로 중복 `artifact_path_duplicate` · 포인터는 트랜잭션이 채운다).
  집행 불변식은 `registerArtifact`와 **같은 헬퍼** 공유.
- **리뷰 B 2건도 유예하지 않고 닫았다**: **`B-14`**(종료를 처음 본 자리에서 회계 → 늦은 이벤트·중복 종료·
  종료 뒤 throw 경로에서도 usage가 예산에서 빠진다) · **`B-15`**(`ReviewSubject` 한 줄·정규형·bounded·
  정규 16진 hash closed 검증 + frozen 스냅샷). 리뷰 C 1건은 **`C-32`**로 등록 후 닫았다(inbox 단일 읽기).
  **신규 open C**: `C-33`(`KERNEL_MARKERS`가 수동 목록 — M5c marker 분기 시) · `C-34`(`codeOf`가 대부분
  경로에서 중복 방어 — mutation 실측). **`C-31` 축소 재기술** · **`C-30` 범위 축소**.
- **테스트(worker 자기보고 — 독립 실측 아님)**: `stableController` **52/52** · `orchestrationKernel`
  **74/74** · `codexCliProvider` **58/58** · `reviewer` **21/21** · `npm run test:exec` **322/322** ·
  authority/atomicity/timing subset **3회 직렬 205/205** · `tsc --noEmit` clean · `build` PASS(dist parity) ·
  `git diff --check` clean. **mutation**: A1/A2/A3 게이트 kill·원복 확인, **살아남은 1건**(`codeOf` 느슨화)은
  실제 도달 경로 회귀를 추가해 죽이고 남은 중복성을 `C-34`로 등록했다.
  **`npm test` 전체·acceptance·stress·live 미실행**(최종 M5d handoff에서 supervisor 직렬 1회).

## 이전 (2026-07-28 — **V3 M5b 2차 리비전: 독립 Codex 재리뷰(REVISE, A=5) 대응**)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 커밋: `1a94261` · `42777d9` · `6bc390d`(1차 리비전) · `ac827bf` ·
  **`55b488f`(2차 리비전 fix)** + 이 docs 커밋. **fresh Claude Opus 5 세션.** 원격 push/PR/merge ·
  네트워크 · MCP · 패키지 설치 · **live provider 추론** · secret 사용 0. `node_modules` stage 0. Ponytail(full).
- **⚠ 이전 세션의 과장 정정**: 1차 리비전은 "A/P1 5건 전부 fixed"라고 적었으나 **2차 독립 리뷰가 같은 다섯
  자리에서 A=5를 다시 냈다**. 넷은 "고쳤다고 적은 코드가 여전히 열려 있었다"였고 `B-8`도 다시 열렸다.
  **A4(포인터 재검증)만 유지**됐다. **지금 상태도 self-approved가 아니다.**
- **2차 리비전 `55b488f`가 닫은 것**:
  ⓐ **A1** — `scheduleReady`/`startScheduledBatch`가 호출 시점 재읽기 wrapper였고 검증도 검사-후-재읽기였다
  (교대 getter·재진입 시계로 갈림) → caller property를 **정확히 한 번** 읽어 검증·bind·pin 기준을 공유한다.
  ⓑ **A2** — `READ_ONLY_EXECUTION_CONTRACT`가 **공개 export**라 아무 provider나 자기에게 달 수 있었다 →
  brand 제거 + `codexCliProvider.ts`의 **모듈 사설 WeakSet**(등록은 생성자 하나 · 밖으로는 판정 함수
  `attestReadOnlyCodexProvider` 하나 · 발급기/factory 없음) + prototype·메서드 신원 + `Object.freeze(prototype)`.
  복사·prototype 위조·subclass·override·Proxy·임의 scripted provider **전부 거부**.
  → controller 테스트의 provider가 **진짜 `CodexCliProvider` + 주입 spawn seam**으로 바뀌었다(live 0).
  ⓒ **A3** — 공용 소비자가 `isError`에서 먼저 던져 **실패 turn의 usage가 예산에서 누락**됐다 →
  종료 1건 확정 뒤 **해석 전에** `onTerminal`로 정확히 한 번 회계한다.
  ⓓ **A5a** — 대상 신원 `includes` · 길이를 잊은 펜스 · findings 미상 줄 무시로 **허위 승인**이 가능했다 →
  정확·유일 라벨 완전 일치 / 문자+길이 있는 펜스(틸드 동등) / 미상 줄 거부 + 본문 nonempty·bounded /
  heading **순서**까지 계약. **`B-8` 세 번째 close.**
  ⓔ **A5b** — provider가 `code: "result_accepted"`를 달면 **성공처럼 보이는 marker를 단 실패**가 됐다 →
  소비자는 자기가 만든 오류만 통과, 경계는 `handoff_failed`/`provider_start_failed`/`provider_send_failed`/
  `provider_stream_failed`(reviewer는 `reviewer_provider_failed`)로 접는다.
- **대장**: **`C-2` 닫음**(트리거가 M5b에서 이미 발화한 overdue 항목 — 진입점 **5개 전수** 명시).
  `C-12`의 낡은 C 행은 **superseded** 표기(현행은 B(P1) 승격 행 하나). 신규 **`C-29`**(중첩 handoff schema
  closed 검증 — M5c 구조화 필드) · **`C-30`**(중복 종료 방어가 codex 경로로 도달 불가 — M5c 두 번째
  provider) · **`C-31`**(테스트가 provider 내부 white-box 관측 — `B-13` 구현 시).
  **확정 기한**: `B-7` 첫 live 전 · `B-9` 첫 live 전 · `B-10` M5c Claude/edit provider 전 ·
  `B-11` M5c autopilot 전 · `B-12` 자동 재시작/resume 전(늦어도 M5c) · `B-13` live 프로세스 provider 전 ·
  `C-12`(→B) M5c autopilot 전. `C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26`은 **손대지 않았다**.
- **테스트(자기보고 — 독립 재실행 아님)**: `stableController` **42/42** · `reviewer` **19/19** ·
  `suiteExclusiveLock` **75/75** · `npm run test:exec` **306/306** ·
  **권위/타이밍 부분집합 206건 직렬 3회 → 3/3** · `tsc --noEmit` 0 · `build` PASS(dist parity) ·
  `git diff --check` clean. **mutation 16종 전부 kill·전부 원복**(1회차에 A2 prototype 검사가 살아남아
  **override 없는 subclass** 케이스를 추가해 kill — 이 이력을 남긴다).
- **다음 세션이 할 일**: ① **supervisor의 fresh Codex read-only 독립 재리뷰**(범위 `409dee2..HEAD`) —
  **M5b는 그 전까지 승인 상태가 아니고 위 fixed 판정 전부가 재확인 대상**이다. ② M5c(`B-10`~`B-13` +
  `C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26` + `C-29`~`C-31` + autopilot CLI + pause/recovery).
  ③ M5d = offline self-hosting acceptance. **미실행**: `npm test` 전체(최종 M5 handoff 직렬 1회 예약) ·
  `test:core` · `acceptance.sh` 전체 · stress · live · MCP · 실제 추론. **M5 전체는 미완료다.**

## 이전 (2026-07-27 — **V3 M5b 1차 리비전: A/P1 5건 "fixed"라고 적었으나 2차 리뷰가 넷을 다시 열었다** · 위 블록이 현행이다)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  base = 승인된 M5a HEAD `409dee2`. 커밋: `1a94261`(feat) · `42777d9`(docs) · **`6bc390d`(1차 리비전 fix)**
  + 이 docs 커밋. **fresh Claude Opus 5 세션.** 원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 ·
  **live provider 추론** · secret 사용 0. `node_modules` stage 0. Ponytail(full).
- **독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가 `409dee2..42777d9`에 REVISE(A/P1 5건)** 를 냈고
  **리비전 `6bc390d`가 5건을 전부 닫았다**:
  ⓐ **생성 authority 미봉인** — caller-owned `opts`를 실행 입력으로 재읽기(객체·메서드 교체 통과, 테스트가
  `provider.start` monkey-patch를 기대) · 중첩 manifest 가변 · handoff 산출물이 await를 건너는 live alias ·
  경계의 `targetRoot` 폐기 → **객체+메서드 함수 포착 · 깊은 freeze · handoff 즉시 봉인 · targetRoot로 만든
  새 불변 spec**, tripwire는 단일 marker `controller_binding_drift`.
  ⓑ **정책이 집행이 아니었다**(선언 검증기 · 결과 폐기 · provider 권한과 독립) → M5b 계약을 **증명 가능한
  read-only Codex planning/review bridge**로 좁혔다: `READ_ONLY_EXECUTION_CONTRACT` brand 있는 provider만 ·
  spec은 `permissionMode: "plan"` 전용(**ClaudeCliProvider 기본 acceptEdits 차단**) · 실행 요구 선언은 전부
  `policy_not_read_only` · artifact 소유권은 **kernel `registerArtifact`(권위)** 가 집행. wrapper token 화면을
  집행이라고 주장하지 않는다 → 타입 있는 집행 = 신규 **`B-10`(M5c)**.
  ⓒ **소진된 예산으로 다음 task 시작** → start·send **직전마다** 게이트, 소진 후 남은 task는 provider 호출 0.
  ⓓ **포인터가 경계 await 뒤 낡음** → 불변 스냅샷을 **await 없는 동기 게이트**에서 재검증(다음 문장이 호출).
  ⓔ **중복 종료·중복 리뷰 섹션(`B-8` reopen)** → 공용 `consumeExactlyOneTerminal`(종료 정확히 1건 · 종료 뒤
  이벤트 전부 거부) + reviewer가 **§5.2 `review_result`** 를 **펜스 밖에서** 파싱(필수 heading 6개 각 1회 ·
  verdict 1개 · 미상/중복/모순 거부 · 대상 revision·hash를 호출자 기대값에 묶음). `B-8` **재closed**.
- **C 정정**: `resultBody`가 durable body에 토큰 usage를 적고 있었다 → **제거 + 부재 회귀**(반환값만 남는다).
- **대장**: `C-16`·`C-21`·`C-25`·`C-27` fixed(M5b) · `B-8` fixed(리비전 `6bc390d`).
  **신규 `B-10`**(타입 있는 실행 집행 — M5c Claude 쓰기 전) · **`B-11`**(batch 전체 running vs per-task
  preflight — M5c autopilot 전) · **`B-12`**(재시작 시 예산 회계 초기화 — 늦어도 M5c) · **`B-13`**(durable
  완료가 provider 정리 확인보다 먼저 · `stop` 실패 삼킴 — M5c live runner 전) ·
  **`C-12` → B(P1) 재분류**(트리거 발화). `B-7`·`B-9`는 열린 live 하드 게이트.
  `C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26`은 **손대지 않았다**(fixed 아님).
- **테스트(자기보고 — 독립 리뷰어 재실행 아님)**: 파일 단독 `stableController` **36/36** ·
  `reviewer` **14/14** · `orchestrationKernel` **70/70** · `codexCliProvider` **58/58** ·
  `executionBoundary` **17/17** · `sessionRunner` **7/7** · `npm run test:exec` **295/295** ·
  **race subset 14건 직렬 3회 → 3/3** · kernel acceptance 개별 재실행 `m4a` 31/31 · `m4b` 42/42 ·
  `m4c` 77/77 · `tsc --noEmit` 0 · `build` PASS(dist parity) · `git diff --check` clean.
  **mutation 6종 전부 죽고 정확히 원복**. 살아남는 1건은 durable 직전 중복 포인터 재검증(사이에 await 없음).
- **다음 세션이 할 일**: ① **supervisor의 fresh Codex read-only 독립 재리뷰**(범위 `409dee2..HEAD`) —
  **M5b는 그 전까지 승인 상태가 아니고 위 fixed 판정 전부가 재확인 대상**이다. ② M5c(`B-10`~`B-13` +
  `C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26` + autopilot CLI + pause/recovery). ③ M5d = offline
  self-hosting acceptance. **미실행**: `npm test` 전체(최종 M5 handoff 직렬 1회 예약) · `test:core` ·
  `acceptance.sh` 전체 · stress · live · MCP · 실제 추론. **M5 전체는 미완료다.**

## 이전 (2026-07-27 — **V3 M5b: stable controller bridge, offline 구현** · 봉인·정책·usage·증거 서술은 위 리비전이 정정했다)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5b` · branch `work/m5b-stable-controller`.
  **현재 HEAD `42777d9`**(이 문서 커밋 전 기준). base = **승인된 M5a HEAD `409dee2`**.
  **fresh Claude Opus 5 세션.** amend/rebase/reset · 원격 push/PR/merge · 네트워크 · MCP · 패키지 설치 ·
  **live provider 추론** · secret 사용 0. `node_modules` stage 0. Pony Tail(full).
- **M5a는 승인됐다**: 다섯 번째 fresh 독립 Codex 리뷰가 `409dee2`에 **`APPROVE_TO_STACK` · A finding 0**.
  이전 문서의 "5차 리뷰 pending / M5a 미승인" 표현은 **그 승인 이전의 dated 기록**이다.
- **M5b 커밋 2개**: `1a94261`(feat — stable controller + `B-8`/`C-16`/`C-21`/`C-25`/`C-27`) ·
  `42777d9`(docs — durable 직전 포인터 재검증을 중복 방어로 명시).
- **핵심 계약**: `StableController`는 `OrchestrationKernel` 위의 **얇은 다리**다 — kernel이 유일한
  scheduler·상태 권위이고 controller는 `scheduleReady` → `startScheduledBatch` → `registerArtifact` →
  `submitResult`/`acknowledgeDelivery`만 부른다(두 번째 scheduler·상태 시스템 0, `runParallelMission`
  재사용 0). manifest·checkout·git 경로·provider 신원·시각 권위 **봉인** + 매 advance 대조 →
  단일 marker `controller_binding_drift`. 모든 start·send 직전 `verifyExecutionBoundary`+`revalidateSync`.
  **deny-by-default 정책 1개**(정확한 명령·pin된 dependency·정확한 도메인·task 소유권/writableRoots·
  로컬 merge·예산 + **manifest가 덮지 못하는 레포 hard deny**), 게이트는 start·send **이전**과 ack **이전**.
  durable inbox 순서 소비 · **성공 종료 결과 뒤에만 ack** · artifact 포인터 재검증 · turn마다 `events()`
  재구독(`C-25`) · durable state에 프롬프트/transcript/stderr/argv/secret/`SessionHandle` 0 ·
  usage는 반환값(state schema 무변경).
- **테스트**: 파일 단독 `stableController` **19/19** · `orchestrationKernel` **68/68** ·
  `codexCliProvider` **58/58** · **provider race subset 8/8 직렬 반복 3회(3/3)** ·
  `npm run test:exec` **268/268** · `tsc --noEmit` 0 · `build` PASS(dist parity) · `git diff --check` clean.
  mutation은 `B-8` fail-open · start/전달 직전 정책 제거 · 조기 ack · provider 이전 artifact 검증 제거 ·
  예전 events iterable 재사용 · `C-27` unhandled rejection · `C-21` poison 제거 · `C-16` 교차 충돌 제거를
  전부 죽였다. **살아남은 1건(정직)**: durable 직전 중복 포인터 재검증만 제거하면 실패 테스트가 **없다**
  (`registerArtifact`와 `submitResult`가 사이에 await 없이 같은 검증을 한다) — 중복 방어로 남기고 주석에
  단독 커버리지 없음을 적었다.
- **대장**: `B-8`·`C-16`·`C-21`·`C-25`·`C-27` **fixed(M5b)**. `B-7`·`B-9`는 **열린 live 하드 게이트**
  (M5b는 live 0이라 트리거 미소진). **M5c open**: `C-17`(kernel 만료 `>=`) · `C-18`(deadline·취소·자손
  정리) · `C-19`(reviewer 결과를 kernel state로 옮기기 전 schema 검증) · `C-22`(재시작 소유권·복구) ·
  `C-24`(stderr 정확한 상한) · `C-26`(신뢰된 git/worktree 자동화). `C-23`의 최종 closer는 **M5a 5차**다.
- **다음 세션이 할 일**: ① **supervisor의 fresh Codex `gpt-5.6-sol` xhigh read-only 독립 리뷰**(범위
  `409dee2..42777d9`) — **M5b는 그 전까지 승인 상태가 아니고 위 fixed 판정도 재확인 대상**이다.
  ② 리뷰 통과 후 **M5c**(위 6건 + autopilot CLI + pause/recovery). ③ **M5d**는 offline self-hosting
  acceptance. **미실행**: `npm test` 전체(최종 M5 handoff 직렬 1회로 예약) · `test:core` · acceptance ·
  stress · live · MCP · 실제 추론. **M5 전체는 미완료다.**

## 이전 (2026-07-27 — **V3 M5a 5차 리비전: 독립 Codex 리뷰(REVISE) — 낡은 핸들 · 가변 시계로 만료 우회(`C-23` 2차 reopen) · 드리프트 marker 불일치**)



- **위치**: 같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
  시작 HEAD `8f95877` 위에 **로컬 커밋만**(code+tests+dist `bfd1cd0`, docs 후속). **새 fresh Claude Opus 5
  세션**. amend/rebase/reset·원격 push/PR/merge·네트워크·MCP·패키지 설치·live provider 추론 0,
  `node_modules` stage 0. Pony Tail(full).
- **리뷰**: 독립 fresh Codex `gpt-5.6-sol` xhigh read-only, 범위 `85ebe883..8f95877` → **REVISE**.
  4차의 내부 linearization(동기 claim → 소유권 재확인 → 동기 신뢰 게이트 → 발행 → no-await spawn)은
  **그대로 유효·보존**. 이번 A는 **밖에서 들어오는 신원과 권위**였다.
- **고친 것**:
  ⓐ **낡은 핸들이 교체 세션을 조종(A/P1)** — `send`/`events`/`stop`이 `sessionId`만으로 상태를 찾아서,
  H1 stop 후 같은 id로 start한 H2를 **이미 반환된 H1**이 읽고·조종하고·중지·삭제할 수 있었다. 이제 세션
  인스턴스마다 **내용 없는 frozen 신원 객체**를 발급해 핸들에 붙이고(`SessionHandle.providerBinding` —
  **선택 필드**, 다른 provider 무영향) **참조 동일성**으로만 대조한다. 낡은·위조 핸들: `send`/`events`는
  읽기·발행·spawn·변경·삭제 0으로 **`codex_stale_handle`**, `stop`은 **무해·멱등**. 세션 자체가 없으면
  기존대로 `codex_unknown_session`. 신원은 빈 객체라 **로그·문서에 남길 비밀 material이 없다**.
  ⓑ **가변 `opts.nowMs`로 만료 우회(A/P1 · `C-23` 2차 reopen)** — 4차 봉인에 `nowMs`·`manifest`가 없어
  매 invocation 재읽기했고, 첫 turn 뒤 시계를 갈아끼우면 **두 만료 검사가 모두 통과**해 **만료된 승인 아래
  resume이 떴다**. 이제 **시각 권위(clock)와 검증된 manifest 사본을 봉인**해 경계에 봉인값만 넘기고,
  `SEALED_KEYS`에 `clock`·`manifestDigest` 추가 → 시계 **교체·제거·추가**와 manifest **전 필드** 변경이
  `codex_spec_mutated`다. 봉인 clock은 **매 검사마다 재호출**(시각 고정 아님). `spawn`은 생성자 포착이라
  재읽기 없음 → **invocation 중 `this.opts`에서 읽는 실행 입력 0**.
  ⓒ **드리프트 marker 불일치(A)** — 문서는 단일 marker를 약속했는데 비교가 native 오류를 흘렸고 테스트가
  그걸 기대했다. 이제 **초기 `start`는 정밀 native 코드**, **start 이후는 `codex_spec_mutated` 하나**.
- **테스트**: 파일 단독 boundary **17/17** · parser **28/28** · provider **53/53**(합 **98/98**, 이전 95) ·
  `npm run test:exec` **240/240**(237 → 240) · `tsc --noEmit` 0 · `build` PASS(dist parity — 재빌드 후
  `git diff --numstat` 변화 0) · `git diff --check` clean. **stale-handle + clock/drift 회귀 7건 반복 3회
  → 3회 모두 7/7.** 신규 3(낡은 핸들 vs 살아 있는 H2 · 시각 권위 봉인 · nowMs 타입/spawn seam 무관함),
  기존 2건은 핸들 계약에 맞게 **정정하며 커버리지를 늘렸고**, 드리프트 표는 **9 → 17케이스**.
  mutation **4종**(핸들 신원 대조 제거 2 · 봉인 clock 대조 제거 2 · 대조 제거+재읽기 2(**시각 권위 테스트가
  `(통과)`** = 만료 승인 아래 resume 실제 발생) · 드리프트 중 native 오류 허용 2) 후 정확히 원복
  (`MUTATION` grep 0 소스·dist · numstat 기준선 일치 · `tsc` 0).
  **정직한 한계**: 재읽기만 되돌리고 봉인 대조를 남기면 실패하는 테스트가 **없다**(그 사이에 await가 없다) —
  두 방어는 중복이고 봉인 clock은 미래에 await가 끼어도 깨지지 않게 하는 쪽이다.
- **대장**: `C-23` **fixed(5차)** — 행에 **3차 overclaim → 4차 부분 fix → 5차 완결** 이력을 전부 남겼다.
  `C-28` **fixed(5차)**(manifest canonical digest 봉인 — 구현+테스트 완료). **`C-27`·`C-26`은 그대로 open**
  (계약 미구현 — 기한·트리거·증거 유지). `B-7`·`B-8`·`B-9`·`C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`도
  전부 open. **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · MCP · 실제 추론.
  **M5a는 supervisor의 다음 fresh 독립 리뷰 전까지 미승인이고 M5도 미완료다.**

## 이전 (2026-07-27 — **V3 M5a 4차 리비전: 독립 Codex 리뷰(REVISE) — pre-spawn race · `C-23` reopen · 발행 순서**)

- **위치**: 같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
  시작 HEAD `3493a2e` 위에 **로컬 커밋만**. **새 fresh Claude Opus 5 세션**.
  amend/rebase/reset·원격 push/PR/merge·네트워크·MCP·패키지 설치·live provider 추론 0,
  `node_modules` stage 0. Pony Tail(full).
- **리뷰**: 독립 fresh Codex `gpt-5.6-sol` xhigh read-only, 범위 `85ebe883..3493a2e` → **REVISE**.
  3차의 A 3건(spawn-adjacent 게이트 · 신뢰된 git · resume UUID 봉인)은 **fixed 확인**, 계약·테스트 보존.
  이번 A는 **상태 기계**였다 — 게이트는 제자리인데 **게이트를 지날 자격**이 원자적으로 정해지지 않았다.
- **고친 것**:
  ⓐ **pre-spawn session-state race(A/P1)** — `invoke()`가 await된 경계 검증 **뒤에야** 세션을 점유해서
  겹친 두 `send`가 같은 UUID·`CODEX_HOME`으로 **중복 resume 프로세스**를 띄우고 큐·child를 덮어쓸 수
  있었고, 그 창에서 `stop`이 세션을 지워도 뒤늦게 `running`을 발행하며 **추적되지 않는 프로세스**가 뜰
  수 있었다. 이제 **`starting` 상태 + 단조 증가 generation 토큰을 첫 await 전에 동기 claim** → 겹친
  호출은 spawn·발행 없이 `codex_send_overlap` 즉시 거부 → **모든 await 뒤 + spawn 직전 동기 게이트**에서
  세션 존재·같은 state 객체·같은 generation·미취소·미중지 재확인(`codex_invocation_cancelled`) →
  `stop()`은 **child 없어도** claim 취소 + 같은 id **교체 세션은 안 지운다**(낡은 catch·`settle`도
  소유권 확인 후에만 상태를 만진다). 신뢰 검사→`spawn` **no-await** 유지, stop 멱등·poison·만료·큐 격리 무변경.
  ⓑ **`C-23` reopen 후 해소(A/P1)** — provider가 호출자 `spec`을 들고 **매 turn 재해석**해 1차 turn 후의
  변조가 **새 baseline**이 됐다(3차의 fixed는 **overclaim** — 같은 invocation 창만 닫혀 있었다). 이제
  `start()`가 유효 옵션 **전부 봉인**(`sessionId`·model·effort·sandbox·codexHome·outputSchemaPath·
  ephemeral·cwd·codex/git 실행 파일 경로·controllerRepoRoot·manifest 신원/TTL/상한, `Object.freeze`)하고
  **매 invocation 동기 진입 + spawn 직전 게이트**에서 `SEALED_KEYS` **명시 필드 목록**으로 대조한다
  (JSON 키 순서 의존 없음). 드리프트 marker는 **`codex_spec_mutated` 하나**. argv·env·경계 입력은 전부 봉인값.
  ⓒ **발행 순서 정합(A)** — 큐·`running` 발행을 **동기 게이트 뒤로**. 발행 전 실패는 이전 완료 큐·child·
  세션 신원을 하나도 건드리지 않고 rejected promise로만 나간다(주석과 구현이 어긋나 있었다).
- **테스트**: 파일 단독 boundary **17/17** · parser **28/28** · provider **50/50**(합 **95/95**, 이전 90) ·
  `npm run test:exec` **237/237**(232 → 237) · `tsc --noEmit` 0 · `build` PASS(dist parity — 재빌드 후
  `git status` 변화 0) · `git diff --check` clean. **동시성 계약을 건드렸으므로 신규 race/spec 5건 반복 3회**
  → 3회 모두 5/5. 신규 5: 겹친 send · stop이 child 없는 claim 취소 · start 중 send · stop 뒤 교체 세션 ·
  **turn 사이 드리프트 9케이스**. race 창은 provider hook 없이 **경계의 git을 신뢰된 래퍼로 정지**시켜 연다.
  mutation **5종**(claim `starting` 2 · `owns()` 검사 2 · 매 turn 재해석 1(**between-turn만** 실패) ·
  필드 비교 무력화 2 · `start` catch 무조건 삭제 1) 후 정확히 원복(`MUTATION` grep 0 · `tsc` 0).
  **정직한 한계**: `cancelled` 단독 제거·`settle` 소유권 가드는 **단독 커버리지가 없다**(중복 방어).
- **대장**: `C-23` **fixed(4차)** — 행에 **reopen 사유**를 명시했다. 신규 **`C-27`**(`stop()`이 `starting`에서
  반환한 뒤 취소된 invocation promise가 나중에 reject → **M5b 배선 전**) · **`C-28`**(봉인 밖 manifest 권한
  필드는 turn 간 고정 없음. 현재 provider가 읽지 않는다 → **권한 집행 계층 도입 시**).
  **그대로 open**: `B-7`(live 인증·secret redaction, M5b live 전) · `B-8`(reviewer 결과 게이트, M5b reviewer
  배선 전) · `B-9`(JSONL payload live 확인, M5b live 전) · `C-17`(kernel 만료 경계, M5c 전) · `C-18` ·
  `C-19` · `C-21` · `C-22` · `C-24` · `C-25` ·
  **`C-26`(경계 밖 `runProcess` git 호출자가 여전히 `git`을 이름으로 부르고 `process.env`를 상속 —
  기한: controller가 worktree 조작을 자동화 경로로 쓰기 시작할 때 = M5c 자율 실행 전. 현재도 open)**.
- **미실행(정직)**: `npm test` 전체 · `test:core` · acceptance · stress · live · MCP · 실제 Codex/Claude 추론 ·
  M5b controller · M5c lifecycle · M5d E2E. 최종 직렬 `npm test` 1회는 **M5b~M5d 이후 supervisor**의 몫.
  → **M5a는 supervisor의 다음 fresh 독립 리뷰 전까지 승인된 것이 아니다. M5도 미완료.**

## 이전 (2026-07-27 — **V3 M5a 3차 리비전: 독립 Codex 리뷰(REVISE) A 3건**)

- **위치**: 같은 worktree/branch, 시작 HEAD `2627f8f` 위에 **로컬 커밋만**. 작성 세션을 playbook §6대로
  **A 처리에만 한 번 resume**. amend/rebase/reset·원격·네트워크·MCP·live provider 추론 0,
  `node_modules` stage 0. Pony Tail(full).
- **리뷰**: 독립 fresh Codex `gpt-5.6-sol` xhigh read-only, 범위 `85ebe883..2627f8f` → **REVISE**
  (A 3 = P0 1 + P1 2 · 문서·타입 정정 · "전체 suite 미실행" 지적).
- **고친 것**: ⓐ **spawn-adjacent TOCTOU(P0)** — 홈·실행 파일 검증이 비동기 경계 작업 **앞**에만 있었다.
  이제 **await 없는 단일 순서 동기 pre-spawn 게이트**(spec 스냅샷 → 만료·git·checkout·HEAD → 홈(+고정 신원,
  첫 invocation은 여전히 비어 있음) → 실행 파일(+**고정 신원 dev+ino**)) 뒤 바로 spawn. 같은 권한의 다른
  실행 파일 교체도 거부. 창은 syscall 규모로 축소이며 0이 아니라고 적었다.
  ⓑ **ambient git 우회(P1)** — `gitExecutablePath` 필수 + async/sync 모두 그 경로 + 자식 env는
  `GIT_SANITIZED_ENV` 화이트리스트(PATH·HOME·상속 `GIT_*` 0). `runProcess` 다른 호출자 무수정.
  ⓒ **resume 신원 누출(P1)** — 파서 `expectedSessionId`로 **init 전에 봉인**, 같은 chunk 뒷줄까지 방출 0,
  marker·result는 기대 UUID, 세션 닫힘 → 후속 send spawn 0.
- **문서·타입**: 순서 있는 게이트로 서술 정정, `types.ts` `codexHome` = "첫 invocation 비어 있음 + 이후 같은
  소유 홈". `C-23`은 **비동기 창 내 spec aliasing까지 확장한 뒤 fixed**(스냅샷 대조 + argv 후컴파일).
  `B-7`·`B-8`·`B-9` · `C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`는 **그대로 open**.
- **테스트**: 파일 단독 boundary **17/17** · parser **28/28** · provider **45/45**(합 **90/90**) ·
  `npm run test:exec` **232/232** · `tsc --noEmit` 0 · `build` PASS(dist parity) · `git diff --check` clean.
  mutation **6종**(홈 재검증 2 · 실행 파일 신원 1 · git async 1 · git sync 1 · 파서 봉인 2 · spec 스냅샷 1건 실패)
  후 정확히 원복(`MUTATION` grep 0).
- **미실행(정직)**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 3회.
  M5a는 **내부 stacked M5 slice**이고 **최종 직렬 `npm test` 1회는 M5b~M5d 이후 supervisor**가 돌린다.
  → **M5a handoff는 supervisor 리뷰 전까지 승인된 것이 아니다. M5도 미완료.**

## 이전 (2026-07-27 — **V3 M5a 2차 리비전: 구조적 A 4건 + 문서 정정**)

- **위치**: 같은 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider`,
  시작 HEAD `450739a` 위에 **로컬 커밋만** 추가. **새 fresh Claude Opus 5 세션**(이전 세션 resume 안 함),
  amend/rebase/reset 0, 원격 push/PR/merge 0, `node_modules` stage 0. Pony Tail(full).
- **고친 것(A 4)**: ⓐ **`CODEX_HOME` 소유 수명** — 이전엔 **모든** invocation이 빈 홈을 요구해
  비-ephemeral resume이 구조적으로 불가능했다. 이제 첫 invocation만 빈 홈(+신원 dev+ino 고정), resume은
  **같은 신원일 때만** codex 상태를 허용하고 경로·0700·홈 금지·strict 플래그·단일 env는 그대로.
  교체·symlink·권한 완화·소유하지 않은 상태 = spawn 0. fake CLI가 실제처럼 `sessions/…/rollout` 상태를 남긴다.
  ⓑ **만료 재확인** — `nowMs`를 clock 함수로 넓혀 `revalidateSync()`(spawn 직전)가 `now >= expiresAt`을
  다시 본다(비동기 git 조회 중 만료 창을 닫는다). ⓒ **신원 우선 파싱** — 의미 있는 첫 이벤트가 정규 UUID를
  세워야 하고 그 전 이벤트는 비가역 `missing_session_id`이며 내용·도구 payload를 전달하지 않는다.
  ⓓ **MCP 위반 세션 격리** — MCP를 본 thread는 resume 불가(`codex_mcp_observed`).
- **문서 정정**: "agent message 전문은 어떤 이벤트에도 실리지 않는다" → raw/추론/명령/stderr payload는 제외,
  **상한 지난 최종 본문은 `assistant.text`·`result.text`로 의도적으로 전달**. `B-7`·`B-8`·`B-9`는 **여전히 open**.
- **신규 대장**: `C-21`(프로토콜 실패 뒤 resume 허용 — `B-8`과 함께) · `C-22`(홈 소유권 in-memory → 재시작 후
  resume 불가) · `C-23`(turn 사이 spec 변경 drift) · `C-24`(stderr chunk 상한) · `C-25`(`events()` 큐 교체).
  B 신규 없음.
- **테스트**: 파일 단독 boundary **13/13** · parser **26/26** · provider **40/40**(합 **79/79**) ·
  `npm run test:exec` **221/221** · `tsc --noEmit` 0 · `build` PASS · `git diff --check` clean.
  **미실행**: `npm test` 전체 · core · acceptance · stress · live · 반복 — 최종 전체 suite 1회는 **여전히
  supervisor가 M5 handoff 시점으로 예약**. mutation 4종(2/2/2/1건 실패) 후 정확히 원복(`MUTATION` grep 0).
- **M5는 이 2차 리비전 뒤에도 미완료다.** 다음: `B-7`/`B-8`/`B-9` 해소 → M5b 계획 → 사용자 승인.

## 이전 (2026-07-27 — **V3 M5a 리비전: fresh Codex 리뷰(REVISE)의 A 9건 수정**
· `CODEX_HOME` "비어 있음" 서술은 2차 리비전 전 계약이다)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider` ·
  base `85ebe883`. 커밋 3개(`115e0be` feat → `6ae7fd6` docs → `bdd5507` fix, + 이 문서 커밋).
  **원격 push/PR/merge 0**, amend/rebase/reset 0. Pony Tail(full).
- **리뷰**: fresh Codex `gpt-5.6-sol` xhigh · read-only · strict empty MCP · 범위 `85ebe883..6ae7fd6` →
  **REVISE**(A 9 = P0 2 + P1 7, B 2, C 1). playbook §6의 **단 한 번 resume**으로 A 전부 수정.
  이 리뷰는 supervisor의 **별도 read-only Codex 세션**이며 **새 provider/live 경로로 Codex 추론을 돌린 적은 없다**.
- **고친 것**: ⓐ 임의 실행 파일 seam 제거(env·PATH 조회 0, 신뢰 절대경로 필수 + spawn 직전 신원 검증)
  ⓑ `workspace-write` hard deny(read-only 전용) ⓒ fresh/resume argv 배치 분리 + `--strict-config`·
  `--ignore-user-config`·`--ignore-rules` ⓓ 세션 신원 = 불변 정규 UUID 1개 ⓔ `CODEX_HOME` 검증
  (정규·비symlink·0700·비어 있음·사용자 홈 아님, 자식 env는 `CODEX_HOME` 하나) ⓕ 실행 신원 TOCTOU
  (비정규 입력 거부 + spawn 직전 동기 신원·HEAD 재확인, cwd는 `targetRoot`만) ⓖ 비가역 프로토콜 실패
  (성공 뒤 실패/MCP/중복 종료/오염 줄 = 실패) ⓗ 멱등 invocation 상태 기계 ⓘ `raw`를 bounded sanitized
  projection으로.
- **대장**: `B-6` **fixed**(supervisor 실측 codex-cli `0.146.0-alpha.3` parse-only — 플래그 배치 한정) ·
  `C-20` **철회**(=`C-17` 중복, `C-17`만 유지·기한 M5c 전) · 신규 `B-8`(reviewer가 `isError`/빈 구조화 출력을
  통과시킨다 — **M5b reviewer 배선 전**) · `B-9`(JSONL payload 필드 live 확인 — **M5b live 전**) ·
  `B-7` 확장(live 인증 + stderr 폐기/승인된 정확한 secret 값만 redaction — **live만 막고 offline M5b는 막지 않는다**).
  `C-18`·`C-19`는 그대로 open.
- **테스트(명령 + 범위)**: 파일 단독 `executionBoundary.test.ts` **12/12** · `codexStreamParser.test.ts` **24/24** ·
  `codexCliProvider.test.ts` **34/34**(합 70/70) · `npm run test:exec` 전체 **212/212**(186 → 212) ·
  `tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  **미실행**: `npm test` 전체 · core · acceptance · stress · live · 반복 — **최종 전체 suite 1회는 supervisor가
  M5 handoff 시점으로 예약**. mutation 2종(실행 파일 게이트 2건 실패 · 프로토콜 실패 게이트 16건 실패) 후 정확히 원복.
- **M5는 이 리비전 뒤에도 미완료다.** 다음: `B-7`/`B-8`/`B-9` 해소 → M5b 계획 → 사용자 승인.

## 이전 (2026-07-27 — **V3 M5a 구현: 실행 경계 + CodexCliProvider + JSONL 어댑터**
· 아래 "열린 블로커·env·sandbox" 서술은 리비전 전 기록이다)

- **위치**: worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider` ·
  base `85ebe883ff96fad1070a508f5d4a28f7fc637b8e`. 로컬 커밋만, **원격 push/PR/merge 0**. Pony Tail(full).
- **범위**: M5a만이다. **M5는 여전히 미완료** — autopilot CLI · Claude↔Codex 자동 전달 ·
  실제 7-agent 동시 실행 · live acceptance는 **하지 않았다**(M5b/M5c/M5d).
- **신규**: `src/exec/executionBoundary.ts` · `src/exec/codexCliProvider.ts` · `src/exec/codexStreamParser.ts`
  + 테스트 3종 + `src/exec/__fixtures__/fake-codex.mjs`. **변경**: `src/exec/types.ts`(`SessionSpec.codex?` 추가만) ·
  `docs/handoff/CLAUDE_CODE_WORKER_PLAYBOOK.md`(§3 예시에 `--verbose`) · `dist/exec/*.js`(build 산출물).
  `runWorkflow`/`mission`/`orchestration*`/기존 테스트·schema·script·package/lockfile은 **무수정**.
- **대장**: `B-5` **fixed**(승인 커밋 ↔ 실행 checkout HEAD 대조가 spawn 직전마다 fail closed).
  신규 등록: `B-6`(codex help 실측 미완 — M5b live 전 필수) · `B-7`(격리 홈 인증 방식 미정 — M5b live 전 필수) ·
  `C-18`(no-progress/wall-clock deadline·cancellation 미구현) · `C-19`(`--output-schema` 응답 검증 없음) ·
  `C-20`(kernel 만료 경계는 여전히 `>`).
- **테스트(명령 + 범위)**: 파일 단독 `executionBoundary.test.ts` **8/8** · `codexStreamParser.test.ts` **18/18** ·
  `codexCliProvider.test.ts` **18/18**(합 44/44) · `npm run test:exec` 전체 **186/186**(142 → 186) ·
  `tsc --noEmit` 0 · `npm run build` PASS. **미실행**: `npm test` 전체 · core · acceptance · stress · live · 반복.
  mutation 2종으로 새 게이트 비공허성 확인 후 정확히 원복(diff 0 · `MUTATION` grep 0).
- **열린 블로커**: 로컬 `codex exec --help` 실행 승인이 나지 않아 **argv·플래그·JSONL 필드명이 미실측**이다.
  다음 세션은 이것부터 확정한다(대장 `B-6`).

## 이전 (2026-07-27 — **M4 문서 정합성 정정 세션(docs-only)**)

- **위치**: worktree `/private/tmp/solo-founder-harness-m4-doc-consistency` · branch
  `work/m4-doc-consistency` · base `c963cb0`(= M4c 최종 HEAD). **문서만 수정**했고 소스·테스트·schema·
  script·package/lockfile·`dist`·config·`AGENTS.md`·`CLAUDE.md`는 무수정. 원격 조작·네트워크·MCP·
  provider 호출 **없음**. 로컬 커밋 1개. Pony Tail(full).
- **현행 커밋 사실**: M4a `55d99a3`+`805da35` · M4b `11775fd`+`ab63eac` · M4c `3cfdb39`+`c963cb0`
  (**M4c 최종 HEAD `c963cb0`**). 세 브랜치는 clean stacked 로컬 브랜치이고 **원격 push/PR/merge는 0**.
  원본 checkout은 `bbb8b72`로 clean·무수정. 각 구현 세션 본문의 "미커밋" 표기는 그 시점 기록으로 표시했다.
- **테스트 범위 라벨**: 파일 단독 `orchestrationKernel.test.ts` **67/67**(37 → 50 → 67) ·
  `npm run test:exec` 전체 **142/142**(125 → 142) · core **374/374** · acceptance **92/92** ·
  offline acceptance M4a **31/31** / M4b **42/42** / M4c **77/77** · build PASS.
  **142/142를 파일 단독 focused로 적지 않는다.** stress·live·반복 suite는 **미실행**.
- **대장 추가(로드맵 §9.1)**: `B-5`(P1 — `manifest.approvedCommit`이 실행 checkout HEAD에 묶이지 않음,
  **M5가 실제 명령을 실행하기 전 fail closed 필수**) · `C-16`(P2 — taskId↔roleId 교차 모호성) ·
  `C-17`(P2 — `expiresAt` 경계 1회 통과). 전부 backlog, 코드 리비전 루프 없음.
- **신규**: `docs/handoff/CLAUDE_CODE_WORKER_PLAYBOOK.md`(Claude Code 세션 운영 표준, CODEX_HANDOFF에서 링크).
- **전체 suite**: `npm test` **1회 직렬 — PASS**(acceptance **92/92**, `ALL PASS`). 원본 checkout의
  기설치 `node_modules`를 ignored symlink로 받은 뒤 실행했고 **패키지 설치·네트워크는 없었다**.
  `test:inner`가 `&&` 체인이라 acceptance 도달이 exec·core 통과를 뜻하지만 **exec·core 개별 카운트는
  이 실행에서 캡처하지 못했다**(base 실측 exec 142/142 · core 374/374 — 이 세션 실측으로 적지 않는다).
  stress·live·반복·두 번째 전체 suite **미실행**.
- **M5는 not started·미승인.** 다음 단계는 M5 계획 → 사용자 승인.

## 이전 (2026-07-27 — V3 **M4c 구현 완료: 중앙 경유 sibling/reviewer 라우팅 + 메시지 10종 + milestone approval manifest + 7 specialist registry** · M4b 위 **stacked** 격리 worktree · **이로써 M4 전체 완료 · M5는 미완료**)

> **현행 마일스톤 상태 (마일스톤 판정은 이 항목이 기준이고 아래 dated 항목보다 우선한다.
> 커밋·테스트 카운트 등 사실 관계는 위 docs-only "최신" 블록이 우선한다.)**
> - **M3 완료(재개방 금지)** · **M4a·M4b·M4c 완료 → M4 전체 완료(offline 검증)**.
> - **M5는 미완료·not started**: provider bridge(`CodexCliProvider`) · autopilot CLI ·
>   실제 7-agent 동시 실행 · live acceptance. 별도 사용자 승인이 필요하다.
> - `B-1`/`B-2`는 여전히 **nonblocking release-readiness backlog**다.
> - 대장 **`C-6`(나머지 6개 메시지 타입 + 7 specialist registry)은 이번에 fixed**.
> - **열린 P0는 없다.** 다음 단계는 M4c의 fresh Codex 독립 리뷰 → M5 계획 → 사용자 승인.

- **위치**: worktree `/private/tmp/solo-founder-harness-m4c` · branch `work/m4c-routing-approval` ·
  base `ab63eac`(리뷰 완료된 M4b 커밋) — **M4a/M4b와 분리된 stacked 브랜치**. 세션 중에는 미커밋
  working tree였고(그 시점 기록) **현행 M4c는 로컬 커밋 `3cfdb39`+`c963cb0`**(최종 HEAD `c963cb0`)이다.
  **원격 push/PR/merge 없음.** 원본 checkout·M4a/M4b worktree 무수정. 네트워크·`gh`·deploy·DB·production·
  live billing·패키지 설치·신규 의존성·package/lockfile 변경·MCP·provider 호출·subagent **전부 없음**.
  Pony Tail(full) 적용.
- **무엇을 했나**: M4b kernel에 **§5.1 메시지 10종 · 중앙 경유 sibling/reviewer/decision 라우팅 ·
  §8 milestone approval manifest · 7 specialist registry**를 더했다. 두 번째 오케스트레이터·범용
  queue/mailbox·provider 추상화를 만들지 않았고 `runWorkflow`/`mission`/`ExecutionProvider`/
  `projects/<p>/outputs/run_state.json`은 **무수정**이다.
- **변경 파일 10 + 신규 3**: `orchestrationTypes.ts` · `approvalManifest.ts`(신규) ·
  `orchestrationStore.ts` · `orchestrationKernel.ts` · `orchestrationKernel.test.ts` ·
  `schemas/milestone_approval_manifest.schema.json`(신규) · `schemas/agent_message.schema.json` ·
  `schemas/orchestration_run_state.schema.json` · `scripts/m4c-offline-acceptance.mjs`(신규) ·
  `scripts/acceptance.sh`(Test 15 추가, 기존 1~14 무변경) · `scripts/m4a|m4b-offline-acceptance.mjs`
  (manifest 인자 1개씩 — 체크 수 31/42 불변) · `dist/exec/*.js`(build 산출물).
- **계약 요약**:
  · 메시지 **10종 전부**. envelope 필드 집합은 **무변경** — route는 message index의
    `routeToTaskId`/`acknowledgedAt`에 중앙이 남긴다. summary는 `task_assignment`/`spawn_request`만 null.
  · sibling 전달은 **같은 parent 또는 직접 의존**일 때만. 자기 자신·미상·**모호(같은 roleId 다수)**·
    orchestrator·종료 수신자·무관은 각각 다른 stable code로 거부(전이 0).
  · reviewer 왕복: `review_request`는 **completed 대상 + 그 대상에 의존하는 fresh reviewer**에게만,
    `review_result`는 받은 요청이 있어야, `revision_request`는 **선행 review_result가 있어야** 나간다.
    decision 왕복은 **미응답 decision_request**가 있을 때만. **라우팅은 task 상태를 바꾸지 않는다.**
  · 미수령 전달은 durable state만으로 계산(`createdAt`→`messageId`) → 재시작 후 같은 다음 전달.
    수령은 좁은 전이 하나 + durable event `delivery_acknowledged`. **범용 queue/retry 없음.**
  · **manifest는 run 생성 시 필수 bind**(기본값 = 조용한 자동 승인이므로). state·digest·snapshot에
    들어가 손편집은 binding으로 거부된다. 강제되는 권한: ownership 명시 승인 · writableRoots ·
    child는 parent 부분집합 · `maxSessions` · 만료. 전부 **커밋 경로 공용 불변식**이라 우회 불가.
  · 실행 권한은 **조회만**: `commandAllowed`/`dependencyAllowed`/`networkDomainAllowed`(deny-by-default,
    정확히 pin된 버전만, 하위 도메인 자동 허용 없음). `localMergeAllowed`는 기록 전용 — git 조작 없음.
  · registry 7종(`research`/`pm`/`ux`/`design`/`tech-lead`/`dev-lead`/`qa-security`) + 하위 role 한 겹.
    그 밖은 `unknown_role`. pre-M4c state는 `state_pre_m4c_unsupported`로 fail closed(자동 승인 금지).
- **검증(offline)**: **파일 단독** focused **67/67**(50 → 67) → `npm run build` PASS →
  M4c acceptance **77/77** · M4a **31/31** · M4b **42/42** →
  `npm test` **PASS(최종 코드 변경 후 1회)** = exec suite **142/142**(125 → 142) + core **374/374** +
  acceptance **92/92**(81 → 92). `git diff --check` clean. mutation 4종(ownership·session·sibling 관계·
  만료)으로 비공허성 확인 후 정확히 원복(파일 해시 일치, 흔적 grep 0, **파일 단독 focused 67/67** 재확인).
  **142/142는 exec suite 수치이며 파일 단독 focused가 아니다.**
- **하지 않은 것**: M5 provider bridge/autopilot · 실제 7-agent 동시 실행 · stress/live/반복 suite ·
  UI/dashboard · 크래시·fsync 하드닝 · stale lock 회수 · schema 마이그레이션 도구 · fairness/retry ·
  git 조작 · 테스트 삭제·완화 **0**.
- **새 유예 항목**: `C-11`(manifest 재승인 경로 없음) · `C-12`(ack 재전송·우선순위 없음) ·
  `C-13`(리뷰 대상이 durable 필드 아님) · `C-14`(command 조회는 문자열 동치) · `C-15`(registry는 코드 상수).
  전부 nonblocking, 로드맵 §9.1 대장 등록.
- **다음**: M4c fresh Codex 독립 리뷰 → **M5**(provider bridge + autopilot) 계획 → 사용자 승인.

## 이전 (2026-07-27 — V3 **M4b 구현 완료: 배타 자원 class + deterministic scheduler + run writer lock** · M4a 위 **stacked** 격리 worktree · **M4 전체는 여전히 미완료(M4c 잔여)**)

> **(2026-07-27 M4b 시점 기록 — 현행 상태는 위 "최신" 블록이 우선한다. M4는 M4c로 완료됐다.)**
> - **M3 완료(재개방 금지)** · **M4a 완료** · **M4b 완료(offline 검증)** · **M4 전체는 미완료**.
>   남은 것은 **M4c**: sibling 전달 · reviewer 왕복(나머지 6개 메시지 타입) · milestone approval manifest.
> - `B-1`/`B-2`는 여전히 **nonblocking release-readiness backlog**다(M4 선행 조건 아님).
> - 대장 **`B-3`(exclusive class + scheduler) · `B-4`(멀티프로세스 writer lock)는 이번에 fixed**.
> - **열린 P0는 없다.** 다음 단계는 M4c 계획 → 사용자 승인.

- **위치**: worktree `/private/tmp/solo-founder-harness-m4b` · branch `work/m4b-resource-scheduler` ·
  base `805da35`(리뷰 완료된 M4a 커밋) — **M4a와 분리된 stacked PR이고 아직 commit/push/PR/merge 없음**
  (미커밋 working tree). 원본 checkout 무수정. 네트워크·`gh`·deploy·DB·production·live billing·
  패키지 설치·신규 의존성·package/lockfile 변경·MCP·provider 호출·subagent **전부 없음**.
  Pony Tail(full) 적용.
- **무엇을 했나**: M4a kernel에 **배타 자원 class 계약 + 결정론적 scheduler + run 단위 writer lock**을
  더했다. 두 번째 오케스트레이터를 만들지 않았고 `runWorkflow`/`mission`/`ExecutionProvider`/
  `projects/<p>/outputs/run_state.json`은 **무수정**이다.
- **변경 파일 9 + 신규 1**: `orchestrationTypes.ts` · `orchestrationStore.ts` · `orchestrationKernel.ts` ·
  `orchestrationKernel.test.ts` · `schemas/orchestration_run_state.schema.json` ·
  `scripts/acceptance.sh`(Test 14 추가, 기존 1~13 무변경) · `scripts/m4b-offline-acceptance.mjs`(신규) ·
  `dist/exec/*.js` 3개(build 산출물).
- **계약 요약**:
  · task가 배타 자원 class **0..4개** 선언(`resourceClasses` — slug·사전순·중복 거부·빈 배열 = 병렬 안전).
    state·schema(required)·snapshot·`stateContentDigest`에 반영되므로 **선언 위조는 binding으로 거부**된다.
    선언 주체는 **중앙**이고 §5.1 envelope는 무변경(agent가 자기 자원 권한을 못 만든다).
  · **점유는 `running` 동안만**, `waiting_children`은 중단 상태라 미점유(명시 결정).
  · `scheduleReady(limit?)` = `taskId` 오름차순 greedy(이미 점유된 class + 같은 batch에서 앞서 고른
    class 회피, state 변경 0) · `startScheduledBatch(limit?)` = **커밋 1회**로 batch 시작 · 상한 1..8.
  · 충돌 규칙은 **커밋 경로 공용 불변식 하나**(`assertExclusiveResourceClaims`)라 직접 `startTask`도,
    앞으로 생길 어떤 전이 경로도, load도 같은 검사를 받는다(`resource_conflict`, 전이 0).
  · 커밋 전 과정을 `run_state.lock`(`O_CREAT|O_EXCL`) 안에서 수행하고 **대기하지 않는다**
    (`run_lock_held`). 해제는 `O_NOFOLLOW` 읽기 + nonce 대조라 **남의 lock은 보존**
    (`run_lock_owner_mismatch`). 정상 커밋 후 잔재 0.
  · **stale writer 거부**: `CommitInput.base`(직전 디스크 state의 revision/lastEventId/lastEventHash)를
    lock 안에서 대조 → 같은 revision에서 열린 두 kernel 중 늦은 쪽은 `stale_writer`(전이 0)이고
    먼저 쓴 결과는 온전하다. `base`는 optional이 아니다.
  · **하위 호환**: `resourceClasses`가 없는 M4a state는 마이그레이션하지 않고
    **`state_pre_m4b_unsupported`로 거부**(새 run 생성). `schemaVersion`은 `"1"` 유지(메시지 envelope와 공용).
- **검증(offline)**: focused **50/50**(37 → 50) → `npm run build` PASS →
  M4b offline acceptance **42/42(exit 0)** · M4a offline acceptance **31/31(불변)** →
  `npm test` **PASS(최종 코드 변경 후 1회)** = exec → core → acceptance **81/81**(75 → 81).
  `npm run test:exec` 단독 **125/125**(112 → 125). core 카운트는 이 세션에서 별도 캡처하지 않았다
  (`test:inner`가 `&&` 체인이라 acceptance 도달 = exec·core 통과). `git diff --check` clean.
  **두 번째 `npm test`는 중복 실행이라 Codex가 시작 직후 중단시켰고 결과로 세지 않는다.**
  mutation 4종으로 신규 방어의 비공허성 확인 후 원복(그중 1종은 중복 검사임이 드러나 **삭제**).
- **하지 않은 것**: stress·live runner·반복(3회) suite **미실행**(`B-1`/`B-2` — M4b 게이트 아님) ·
  실제 7-agent 동시 실행 · provider/LLM 호출 · 크래시 복구/fsync 하드닝 · stale lock 자동 회수 ·
  schema 마이그레이션 도구 · queue/retry/priority/fairness · 테스트 삭제·완화 **0**.
- **새 유예 항목**: `C-4` 보강(writer lock 크래시 잔재 → 사람이 지워야 함) · `C-8`(stale lock 자동 회수
  없음) · `C-9`(schema 마이그레이션 도구 없음) · `C-10`(priority/fairness/starvation 방어 없음).
  전부 nonblocking이며 로드맵 §9.1 대장에 확률·영향 반경·유예 비용·공수·트리거와 함께 등록했다.
- **다음**: **M4c**(sibling 전달 · reviewer 왕복 · approval manifest) 계획 → 사용자 승인 → 구현.
  M4b는 fresh Codex 독립 리뷰 대상이다.

## 이전 (2026-07-27 — V3 **M4a durable orchestration kernel 구현 + Codex P0 2건 수정 완료** · **M3 완료(재개방 금지)** · **M4 전체는 미완료** · 격리 worktree 단일 세션)

> **현행 마일스톤 상태 (이 항목이 최신이며 아래 dated 항목보다 우선한다)**
> - **M3는 완료다.** M3a/M3b/M3c core와 **실제 live acceptance까지 완료**됐고, M3d.2는 PR #10으로
>   `ea764a5`에 병합됐다. **M3/M3d를 재개방하지 않는다.**
> - **`B-1`(부하/stress 재실행) · `B-2`(live runner 재실행·evidence 재생성)는 nonblocking
>   release-readiness backlog다** — M3 완료 게이트가 **아니고** M4 작업의 선행 조건도 **아니다**.
>   아래 2026-07-26 이전 항목들이 이 둘을 "차단 게이트 / M3d 완료 전 필수"로 적은 것은
>   **그 시점의 기록**이며 현행 판정이 아니다.
> - 현재 열린 차단(P0)은 **없다**. 다음 단계는 M4 잔여 범위의 계획→승인이다.

- **위치**: worktree `/private/tmp/solo-founder-harness-m4a` · branch `work/m4a-durable-orchestration` ·
  base `ea764a5`(PR #10 merge commit). 원본 checkout은 읽기 전용으로만 접근했다.
  **commit/push/PR/merge 없음** · 네트워크·`gh`·deploy·DB·production·live billing·패키지 설치·신규 의존성 **없음**.
- **무엇을 했나**: `src/exec` 안에 **state-only/offline** deterministic durable orchestration kernel을
  추가했다. 기존 `runWorkflow`/`mission`/`ExecutionProvider`와 `projects/<p>/outputs/run_state.json`,
  `registry/agent_registry.json`은 **복제·교체·마이그레이션 모두 없음**. provider·LLM·프로세스를 하나도
  띄우지 않는다.
- **신규 8 + 수정 2**: `orchestrationTypes.ts` · `agentMessage.ts` · `orchestrationStore.ts` ·
  `orchestrationKernel.ts` · `orchestrationKernel.test.ts` · `schemas/agent_message.schema.json` ·
  `schemas/orchestration_run_state.schema.json` · `scripts/m4a-offline-acceptance.mjs` /
  `scripts/acceptance.sh`(Test 13 추가, 기존 무변경) · `.gitignore` 1줄. `dist/exec/*.js` 4개 동반 생성.
- **계약 요약**: 상태 6개(`pending|ready|running|waiting_children|completed|blocked`) · 메시지 4종
  (`task_assignment|spawn_request|result|blocker`, 나머지 6종은 schema·runtime 모두 거부) ·
  §5.1 envelope 유지 + 타입별 필수 Markdown heading·16 KiB 상한 · child 4/depth 3/run 32 상한 ·
  nested spawn · ownership 정규화(**권한이 아니라 메타데이터**) · result는 bounded summary + 검증된
  포인터만 운반 · 수락 직전 artifact 재검증(symlink/missing/hash mismatch/workspace 탈출 fail-closed) ·
  parent/dependent 전파는 kernel만 수행 · **agent가 상태를 직접 바꾸는 API 없음** ·
  SoR `run_state.json` + 해시 체인 `events.jsonl` + `messages/*.md` + 파생 `snapshot.md` ·
  load fail-closed 및 invalid input에서 **전이 0** · ready/snapshot 결정론적.
- **Codex P0 2건 수정(2026-07-27, 이번 세션 후반)**:
  **P0-1 — 유효한 형태의 run_state 변조가 중앙 전이 계약을 우회했다.** `tasks[0].state="completed"` +
  `resultSummary="forged"`처럼 **허용 필드만** 고친 state를 load가 받아들였다. 이제 커밋의 **마지막
  이벤트**가 그 커밋이 남긴 **state 내용 digest**(chain 필드 `lastEventId`/`lastEventHash` 제외 →
  순환 없음)를 들고 가고, load가 재계산해 대조한다(`assertStateEventBinding`). 불일치는
  `state_event_binding_mismatch`로 fail-closed다. 커밋마다 이벤트가 최소 1건 필요해졌다.
  키 없는 digest이므로 **state와 events.jsonl을 모두 일관되게 재작성하는 위조**는 여전히
  감사 대상이며, 상향 경로(out-of-band 키 HMAC/서명)는 backlog `C-7`이다.
  **P0-2 — 문서가 완료된 M3를 재개방하고 있었다.** 현행 상태 표기를 위 인용 블록대로 정정했다.
- **최종 검증(offline)**: focused **37/37** → `npm run build` PASS →
  `node scripts/m4a-offline-acceptance.mjs` **31/31 PASS(exit 0)** →
  `npm test` **PASS** = exec **112/112** + core **374/374**(불변) + acceptance **75/75**(71 → 75) →
  `git diff --check` clean.
  `npm test` 실행 횟수는 **총 4회**다 — 구현 세션 3회(최초 / 카운트 확인 / 미사용 코드 삭제 후 최종)와
  이번 P0 수정 세션의 **마지막 코드 변경 후 1회**. **4회 모두 PASS.**
- **하지 않은 것**: stress·live runner 3종·반복(3회) suite **미실행** — 이것들은 nonblocking
  release-readiness backlog(`B-1`/`B-2`)이고 M3 완료 게이트도 M4 선행 조건도 아니다.
  M3/M3d 재개방 없음 · 테스트 삭제·완화 없음.
- **M4 전체는 미완료**: provider bridge · 7 specialist registry 등록/동시 실행 · 나머지 6개 메시지 타입 ·
  범용 scheduler · **exclusive resource class**(M4 완료 항목) · 멀티프로세스 writer lock ·
  approval manifest 전체 · MCP/CLI/UI 미구현. 신규 유예 항목 **`B-3`(exclusive class/scheduler, P1)** ·
  **`B-4`(멀티프로세스 writer lock, P1)** · `C-4`(커밋 중간 크래시 복구 도구) · `C-5`(경로 TOCTOU 창) ·
  `C-6`(잔여 메시지 타입·registry) · `C-7`(키 없는 digest의 전체 재작성 위조)을 로드맵 §9.1 대장에
  기한·비용과 함께 등록했다. **열린 P0는 없다**(Codex P0 2건은 이번에 수정).
- **다음**: M4 잔여 범위(scheduler · exclusive resource class · sibling/reviewer 메시지 ·
  approval manifest)의 계획→승인→구현. `B-1`/`B-2`는 **release-readiness 시점의 트리거**로만 남는다.

## 이전 (2026-07-26 — 여덟 번째 리비전 **재검토 결과 기록 + 배송 우선 리뷰 정책·병렬 세션 정책 도입** · 문서 전용 세션 · **M3d 여전히 미완료**)

- **문서·정책 전용 세션이다.** 코드·패키지·schema·script·생성 산출물·의존성 **무수정**,
  commit/push/fetch/pull/PR·설치·네트워크·테스트·stress·live runner **미실행**.
  변경 파일 9개 = `AGENTS.md` · `CLAUDE.md` · CODEX_HANDOFF · CONTEXT_SUMMARY · WORKLOG · DECISIONS ·
  활성 V3 문서 3건(로드맵 · MCP · DESIGN).
- **여덟 번째 리비전 재검토(fresh Codex Sol xhigh, read-only) = `APPROVE_FEATURE_PROGRESSION`.
  Category A(지금 차단) 0건.** 그러나 **M3d 완료 APPROVE가 아니다** — 부하(stress) acceptance는 여섯 번째
  리비전의 FAIL 기록 그대로 **미충족(차단 게이트)**, live runner 3종·evidence 3건도 **pending** →
  **M3d 미완료**이고 기존 완료 게이트는 전부 유효하다. 리뷰 이력은 이제
  **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회**다.
- **Category C 1건은 유예 대장 `C-1`로 등록**: bounded computed dynamic specifier 분석이, 조각 각각에는
  `fixture-config`가 없지만 런타임에 합성되는 route(`"./lib/" + (flag ? "fixture-" : "other-") + "config.mjs"`)를
  놓칠 수 있다. 현재 호출부 5개 영향 없음 · 확률 낮음 · 영향 반경 제한적 · 유예 비용 낮음 · 공수 소~중.
  같은 C로 **문서 과장 정정**: "unproven/loader 보고 = 조용히 통과하는 경로 없음"은 사실이 아니다(`safe` 분기가
  그 경로다). bounded 규칙 서술과 **정상 dist import 3파일이 호출부로 잡히지 않는다**는 positive 대조군은 유지.
- **도입된 정책(문서화만)**: ⓐ 리뷰 finding **A/B/C 분류 + 배송 우선** — C만으로는 리비전 루프·진행 정지 없음,
  우선순위는 **유예 비용 대 수정 공수**. ⓑ 유예 항목은 심각도·확률·영향 반경·유예 비용·공수·기한/트리거·담당·
  증거·상태를 유지하는 **무손실 대장**(조용한 폐기 금지). ⓒ 테스트 비례 — 변경마다 focused, handoff 전 전체 1회,
  반복·stress·live는 마일스톤/하드닝 게이트(해당 계약 변경 시 예외). **완화·삭제 금지 불변.**
  ⓓ fresh context 유지 + **병렬 Claude Opus 5는 격리 worktree·disjoint 소유권일 때만**, 공유 schema/API·통합·
  마이그레이션·최종 전체 테스트·배타 자원/stress/live는 직렬, 원격 쓰기 hard deny 유지.
  직전 공유 dirty 리비전을 **단일 세션으로 한 것은 옳았다.** 상세는 로드맵 §9.1~§9.3.
- **M4 구현은 not started** — 별도 사용자 마일스톤 승인 필요. **M4 계획 준비는 지금 가능**하고, 승인된
  offline/격리 M4 작업이 남은 외부 M3d 작업과 겹칠 수 있다는 **제안**만 로드맵 M4 절에 적었다(미발동·미승인).
- Git: `develop` / HEAD `af0552e` 불변, 기존 dirty 전부 보존.
- **다음: 조용한 호스트에서 stress 재실행(또는 5초 deadline 방침 결정 — `B-1`) → 사용자 live 실행 3종 →
  evidence 3건 확인(`B-2`) → fresh Codex 최종 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **여덟 번째 리비전**(여덟 번째 Codex REQUEST_CHANGES 3건(P2 2 · P3 1) 수정) · **부하 acceptance 미충족(차단 게이트 — 직전 FAIL 기록 유지, 이번 세션 미재실행) · live acceptance pending · M3d 미완료 · 승인 미수령**)

> **재검토됨(2026-07-26).** 아래 "재검토 대기(pending)"·"APPROVE 0회"는 **그 시점 기록**이다.
> 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회**이며 위 "최신" 항목을 본다.

- **여덟 번째 리비전이다. live runner 3종 여전히 미실행 + 부하 acceptance 미충족 → M3d 완료·M4 ready 아님.
  M4는 not started.** 리뷰 이력은 **REQUEST_CHANGES 8회 · APPROVE 0회**이고, 이 리비전은 **재검토 대기(pending)** 다.
  아래 일곱 번째~세 번째 리비전 항목의 계약은 전부 유효하며 이 항목이 그것을 **보강**한다.
  변경은 **테스트 1개 + 문서 7개**(`src/tools/suiteExclusiveLock.test.ts` / WORKLOG·DECISIONS·CONTEXT_SUMMARY·
  CODEX_HANDOFF·로드맵·활성 V3 문서 2건). **production 코드(lock 라이브러리·wrapper·stress runner·fixture 로더의
  주석까지)·live runner 3종·liveEvidence·schemas·package.json은 미수정.**
- **P2-1 지정자 정규화**: 상대 지정자를 문자열로만 비교해서 `?query`·`#fragment`·`fixture%2Dconfig.mjs`(percent)를
  로더로 **인식하지 못했다**(Node ESM은 file URL을 디코드해 같은 파일로 해석한다). 이제 URL 문법 순서대로
  자르고 `decodeURIComponent` 한 뒤 비교하며, 디코드 불가(`%zz`)·인코딩된 구분자(`%2F`)는 **판정 불가 = fail closed**다.
- **P2-2 계산된 동적 import**: 예전엔 `import()` 인자가 문자열 리터럴일 때만 봤다. 이제 리터럴·치환 없는 template·
  `+` 연결·**정확히 한 번 선언된 `const` 문자열**을 bounded하게 접어 판정하고, 접히지 않으면 **도달 가능한 문자열
  조각** 규칙을 쓴다: 조각 0개 → fail closed / 로더 token 포함 → 로더 보고 / 그 밖 → `safe`.
  `safe`는 live runner의 정상 빌드 산출물 동적 import를 깨지 않기 위한 **명시적 bounded 규칙**이며 whole-program
  증명이 아니다(실제 repo 대조군 3파일이 호출부로 잡히지 않음을 테스트가 단정).
- **P2-3 재수출**: 직접 `export … from`만 잡아서 **import 후 `export { loadFixtureConfig }`는 무문제로 통과**했다.
  이제 수집이 두 패스라 소스 순서(import 먼저/export 먼저)와 무관하게 `export {X}`·`export {X as Y}`·
  `export default X`·namespace 파생 노출·`export * as`를 전부 잡는다.
- **P2-4 scope**: 식별자 텍스트만 봐서 지역 `process` shadow가 첫 인자 정규형·원문 단정을 통과했고, shadow된
  이름이 import 사용으로 계산됐고, namespace엔 미사용 검사가 없었다. 이제 선언 sweep으로 **`process`·direct·
  namespace를 가릴 수 있는 선언이 하나라도 있으면 감사 실패**(conservative fail closed), shadow된 식별자는
  **사용으로 인정하지 않으며**, namespace도 direct와 같은 미사용 검사를 받는다.
- **P3**: 감사가 **파싱 진단**을 보고 구문 오류 소스를 "안전"으로 보지 않는다. 문서 리비전·카운트·게이트 표기 정정
  (부하 acceptance 완료 게이트를 **비차단으로 적지 않는다**).
- 테스트: `suiteExclusiveLock.test.ts` **70 → 75건**(신규 5: 지정자 정규화 · 계산된 동적 import · 재수출 ·
  shadow/미사용 namespace · 파싱 진단. 기존 실호출부 테스트에 정상 동적 import 대조군 3파일 단정 추가). 삭제·완화 0.
  전부 **순수 합성 소스**라 파일 잔재·production 훼손 0. **mutation 8종**(query/fragment 분해 · percent 디코드 ·
  동적 게이트 리터럴 전용 복원 · 노출 패스 · `process` shadow · direct/ns shadow · ns 미사용 · 파싱 진단) 확인 후
  **전부 원복**(원복 후 타입체크 0 · build PASS · focused 75/75 · 24/24, `MUTATION` 흔적 grep 0).
- offline 검증: `node --check`(.mjs 4종)·`tsc --noEmit -p tsconfig.json` 0·테스트 파일 단독 strict 타입체크 0·
  build PASS(종료 상태 확인), focused **75/75** + **24/24**,
  `npm test` **연속 3회 PASS(직렬, 겹침 없음)** = exec **75/75** + core **374/374** + acceptance **71/71**,
  `git diff --check` clean, tmp lock/guard/격리/`.new` 잔재 0, repo mutation 잔재 0, 잔존 프로세스 0.
- **부하(stress) acceptance: 이 세션에서 실행하지 않았다 → 미충족이며 M3d 완료의 차단 게이트다.** 여섯 번째 세션이
  같은 호스트에서 2회 다 FAIL(exit 1)했고 원인이 **범위 밖 고정 5초 child startup deadline 2건 + 외부 부하**로
  확인됐다. production을 바꾸지 않은 이번 리비전에서 같은 조건 재실행은 새 정보를 주지 않으므로 **그 FAIL을
  미충족으로 그대로 기록**한다(거짓 PASS 없음).
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크/live runner 없음, 기존 dirty 전부 보존.
- 잔여 위험(추가분, 비차단): 감사는 정적 분석 · `scripts` 밖 호출부는 범위 밖(현재 없음) · 동적 지정자 판정은
  bounded 규칙(증명 아님) · 선언 sweep은 열거한 선언 형태만 봄 · `parseDiagnostics`는 TypeScript 준공개 필드 ·
  `scripts/lib/fixture-config.mjs` 주석이 진입점을 2개만 예시로 적어 실제 5개와 어긋나 보임(production 미수정 —
  다음 승인 범위 권장). 그 밖의 위험은 아래 여섯 번째 리비전 항목과 동일하다.
- **다음: 조용한 호스트에서 stress 재실행(또는 5초 deadline 방침 결정) → 사용자 live 실행 3종 → evidence 3건 확인
  → fresh Codex 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **일곱 번째 리비전**(일곱 번째 Codex REQUEST_CHANGES 1건(P2) 수정) · **stress acceptance 미충족(직전 세션 FAIL 기록 유지, 이번 세션 미재실행) · live acceptance pending · M3d 미완료 · 승인 미수령**)

> **보강됨(여덟 번째 리비전).** 아래 수치·리비전 표기는 **그 시점 기록**이다. 현행 사실은
> **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회 · 75건 · core 374**이며 위 "최신" 항목을 본다.

- **일곱 번째 리비전이다. live runner 3종 여전히 미실행 → M3d 완료·M4 ready 아님. M4는 not started.**
  리뷰 이력은 **REQUEST_CHANGES 7회 · APPROVE 0회**이고, 이 리비전은 **재검토 대기(pending)** 다(당시 기록).
  아래 여섯 번째~세 번째 리비전 항목의 계약은 전부 유효하며 이 항목이 그것을 **보강**한다.
  변경은 **테스트 1개 + 문서 7개**(`src/tools/suiteExclusiveLock.test.ts` / WORKLOG·DECISIONS·CONTEXT_SUMMARY·
  CODEX_HANDOFF·로드맵·활성 V3 문서 2건). **production 코드(lock 라이브러리·wrapper·stress runner·fixture 로더)·
  live runner 3종·liveEvidence·schemas·package.json은 미수정.**
- **P2 — 호출부 발견을 구문 인식·재귀 감사로 교체**: 옛 회귀는 `scripts` 루트+`lib` **한 겹**만 훑고
  `loadFixtureConfig(` **문자열 일치**로 찾아서, ⓐ 중첩 디렉터리 호출부, ⓑ 식별자와 `(` 사이 공백·주석,
  ⓒ 별칭(`as`) import가 **세 번째 인자(io seam)를 넘긴 채 통과**할 수 있었다. 이제 `scripts` 아래 모든 깊이의
  일반 `.mjs`를 재귀 열거하고(symlink 파일·디렉터리는 신뢰하지 않고 따라가지 않으며 건너뛴 목록 보고),
  TypeScript AST로 로더 모듈에서 온 바인딩(별칭·namespace 포함)을 추적해 **호출부 목록 == 기대 5개**,
  파일당 **호출 1회**, **인자 정확히 2개**, 첫 인자가 **구조적으로** `process.argv.slice(2)`임을 고정한다.
  미사용 바인딩·다중 호출·동적 로딩·재수출·비호출 참조도 문제로 보고하고, 문자열·주석은 오탐하지 않는다.
  **TypeScript는 기존 devDependency이며 테스트에서만 쓴다(의존성·production 주입 표면 변경 0).**
- 테스트: `suiteExclusiveLock.test.ts` **67 → 70건**(기존 호출부 회귀 1건 교체·강화 + 신규 3건: 재귀/symlink 열거 계약 ·
  우회 4종(중첩·공백/주석·별칭·namespace, 전부 세 번째 인자) 발견+거부 · 첫 인자 정규형/미사용/다중 호출/동적 로딩
  검출 + 오탐 금지). 삭제·완화 0. 우회 케이스는 **순수 합성 소스**라 파일 잔재·production 훼손 없음.
  **mutation 4종**(재귀 제거 → 열거+실호출부 2건 실패 / 옛 문자열 스캔 복원 → 공백·별칭 실패 / 별칭 인식 제거 →
  별칭 실패 / 인자 검사 완화 → 거부 단정 전부 실패) 확인 후 **전부 원복**(원복 후 focused 70/70·24/24 재확인, 흔적 0).
- offline 검증: `node --check`(.mjs 4종)·`tsc --noEmit -p tsconfig.json` 0·테스트 파일 strict 타입체크 0·
  build PASS(종료 상태 확인), focused **70/70** + **24/24**,
  `npm test` **연속 3회 PASS(직렬, 겹침 없음)** = exec **75/75** + core **369/369** + acceptance **71/71**,
  `git diff --check` clean, tmp lock/guard/격리/`.new` 잔재 0, repo mutation 잔재 0, 잔존 프로세스 0.
- **stress acceptance: 이 세션에서는 실행하지 않았다(pending).** 직전(여섯 번째) 세션이 같은 호스트에서 2회
  실행해 2회 다 FAIL(exit 1)했고 원인이 **이번 범위 밖 고정 5초 child startup deadline 2건 + 외부 부하**로
  확인됐다. production 코드를 바꾸지 않은 이번 리비전에서 같은 조건 재실행은 새 정보를 주지 않으므로
  **그 FAIL을 미충족으로 그대로 기록**한다(거짓 PASS 없음).
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크/live runner 없음, 기존 dirty 전부 보존.
- 잔여 위험(추가분): 감사는 **정적 분석**이라 런타임 동적 호출은 보고만 가능 · `scripts` 밖 호출부는 범위 밖
  (현재 없음) · `scripts/lib/fixture-config.mjs` 주석이 production 진입점을 2개만 예시로 적어 실제 5개와
  어긋나 보인다(이번 범위에서 production 미수정 — 다음 승인 범위에서 주석 정정 권장).
  그 밖의 위험은 아래 여섯 번째 리비전 항목과 동일하다.
- **다음: 조용한 호스트에서 stress 재실행(또는 5초 deadline 방침 결정) → 사용자 live 실행 3종 → evidence 3건 확인
  → fresh Codex 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **여섯 번째 리비전**(여섯 번째 Codex REQUEST_CHANGES 6건 수정) · **stress acceptance는 그 세션 호스트에서 FAIL(외부 부하) · live acceptance pending · M3d 미완료 · 승인 미수령**)

- **여섯 번째 리비전이다. live runner 3종 여전히 미실행 → M3d 완료·M4 ready 아님. M4는 not started.**
  리뷰 이력은 **REQUEST_CHANGES 6회 · APPROVE 0회**이고, 이 리비전은 **재검토 대기(pending)** 다.
  아래 다섯 번째~세 번째 리비전 항목의 계약은 유효하며 이 항목이 그것을 **보강**한다.
  변경은 **코드/테스트 4개 + 문서 7개**(lock 라이브러리 · wrapper · stress runner · lock 테스트 /
  WORKLOG·DECISIONS·CONTEXT_SUMMARY·CODEX_HANDOFF·로드맵·활성 V3 문서 2건). fixture 로더·liveEvidence·schemas·
  package.json·live runner 3종은 **미수정**.
- **최종 엔트리 symlink 거부(P1)**: `readLockSnapshot`·`readGuardRecord`가 `openSync(path,"r")`로 symlink를
  따라가던 것을 `O_RDONLY|O_NOFOLLOW` 단일 경로(`openReadNoFollow`)로 바꿨다. 원본을 옮기고 그 자리에 symlink를
  둔 교체에서 예전엔 release가 **symlink만 unlink하고 해제 성공**을 보고하고 quarantine이 **남의 symlink 엔트리를
  rename으로 덮을** 수 있었다. 이제 symlink는 `lock_path_symlink`, `O_NOFOLLOW` 미지원은
  `lock_nofollow_unsupported`로 거부하며 **엔트리·대상 모두 건드리지 않는다**(release는 guard 잔존,
  acquire는 상태 미변경 거부라 guard 정상 반납).
- **성공 상태는 완결 후 공표(P2)**: `release()`가 콜백 안에서 `state="released"`를 먼저 세팅해, 그 뒤
  guard 반납 실패(`lock_guard_release_failed`)에도 released로 남고 소비자가 `lockReleased:true`로 보고했다.
  이제 콜백은 결과만 값으로 돌려주고 `publishState`가 `withTransitionGuard` 정상 반환 뒤에만 상태를 바꾼다 →
  lock unlink 뒤 guard 정리/교체/unlink 실패는 `failed` · `released=false` · problems 보고 · guard 잔존.
  wrapper·stress도 "해제가 완결되지 않았습니다(state=…)"를 명시한다. `quarantine()` 동일 규칙,
  acquire·reentry는 이미 완결 후 공표라 **재감사만** 했다.
- **io seam 회귀를 production 호출부 전수로 확대**: `scripts/**.mjs` 스캔으로 호출부를 발견해 기대 5개
  (wrapper · stress · live runner 3종)와 목록 일치를 확인하고, 각 호출의 **최상위 인자 2개**·첫 인자
  `process.argv.slice(2)`를 고정한다(새 호출부가 생기면 먼저 깨진다). 의존성·외부 주입 표면 추가 없음.
- **P3 문서 정정**: CODEX_HANDOFF의 다섯 번째 리비전 "3개 + 문서 6개" → 실제 나열과 맞게 **"4개 + 문서 7개"**.
- 테스트: `suiteExclusiveLock.test.ts` **62 → 67건**(신규 5: symlink release/격리/acquire · lock unlink 뒤 guard 반납
  실패 시 handle `failed` · stress 요약 `lockReleased:false`; 강화 2: wrapper 미완결 보고 · 호출부 전수 검사).
  삭제·완화 0, pause 지점·fixture key 추가 0. **mutation 4종**(O_NOFOLLOW 제거 → symlink 3건 전부 실패 /
  guard 반납 전 released 공표 → P2 3건 전부 실패 / 로더 호출 세 번째 인자 → 인자 회귀 실패 / 임시 호출부 파일 →
  발견 회귀 실패) 확인 후 **전부 원복**(원복 후 focused 67/67·24/24 재확인, 흔적 0).
- offline 검증: `node --check`·`tsc --noEmit` 0·build PASS, focused **67/67** + **24/24**,
  `npm test` **연속 3회 PASS(직렬, 겹침 없음)** = exec **75/75** + core **366/366** + acceptance **71/71**(3회 동일),
  `git diff --check` clean, git 가시 파일 **266건 NUL 0**, tmp lock/guard/격리/`.new` 잔재 0,
  repo backup/mutation 잔재 0, 잔존 프로세스 0.
- **stress acceptance: FAIL(exit 1) — 이 세션 호스트의 외부 부하 때문이다(정직 보고).**
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":1,"cleanupConfirmed":true,`
  `"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false}` (elapsed 264.0s; 진단 재실행 1회도 동일, 302.0s).
  부하 중 실패는 **이번 리비전이 손대지 않은 2건**: `preflight.test.ts` "[M3a] extra canary tool 실패",
  `shadcnPilot.test.ts` "[M3c-0] discovery 성공(generic fixture)" — 둘 다 **고정 5000ms child startup deadline**
  초과(core 364/366). 호스트 load average **8.76/11.10/8.50**(10 CPU, Chrome 57%·WindowServer 42%·VS Code·OBS)에
  worker 4개가 더해진 결과다(이전 PASS 기록은 elapsed 109.8s의 한가한 호스트). 두 파일은 부하 없이 **40/40 PASS**.
  lock 계층은 두 실행 모두 정상(확인 성공·문제 0·정상 해제·격리 없음·잔재 0). **테스트 완화·production 5초
  deadline 변경은 하지 않았다**(범위 밖, 별도 승인 필요).
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크/live runner 없음, 기존 dirty 전부 보존.
- 잔여 위험: **stress는 호스트 외부 부하에 민감(고정 5초 deadline 2건)**, `O_NOFOLLOW` 미지원 플랫폼은 전이 전체
  거부(전용 테스트 없음), symlink 방어는 열기 시점 판정이라 "확인 → unlink/rename" 창은 여전히 0이 아님,
  격리 lock·남은 guard·`.new` 수동 제거, lock 라이브러리 `closeSync` 실패 전용 테스트 없음,
  `ps lstart` 1초 해상도, procps 호환 `/bin/ps` 전제, 계약 밖 교체는 탐지·중단만 보장.
- **다음: 조용한 호스트에서 stress 재실행(또는 5초 deadline 방침 결정) → 사용자 live 실행 3종 → evidence 3건 확인
  → fresh Codex 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **다섯 번째 리비전**(다섯 번째 Codex REQUEST_CHANGES 5건 수정)·offline 검증 완료 · **live acceptance pending, M3d 미완료, 승인 미수령**)

- **다섯 번째 리비전이다. live runner 3종 여전히 미실행 → M3d 완료·M4 ready 아님. M4는 not started.**
  리뷰 이력은 **REQUEST_CHANGES 5회 · APPROVE 0회**이고, 이 리비전은 **재검토 대기(pending)** 다.
  아래 네 번째·세 번째 리비전 항목의 계약은 유효하며 이 항목이 그것을 **보강**한다.
- **파괴 직전 재검증(P1-1/P1-2)**: guard 제거는 "소유 확인 → 동기화 지점 → **같은 fd로 record+inode 재확인** →
  최종 경로 `lstat` 신원 → unlink" 순서다. 격리는 "temp write/close → **기본 record+inode 재확인** → rename →
  사후 확인"이다. 그 사이 교체된 남의 guard/lock은 **지우거나 덮지 않고 보존**하고 mechanism 실패로 올린다.
  Node 18에 `unlinkat`·compare-and-unlink가 없어 마지막 확인과 syscall 사이 창은 **0이 아니다**(창 최소화 +
  사후 탐지 + fail closed로 대응, 주석·문서에 명시).
- **guard 이후 실패는 성공 handle이 되지 않는다(P1-3)**: `withTransitionGuard`가 guard 반납 실패를 무시하지 않고
  `lock_guard_release_failed`(mechanism)로 올린다 → acquire/reentry가 완결되지 않았는데 suite가 시작되는 경로 제거.
  임시 파일 정리는 **열자마자 확보한 (dev,ino)와 일치할 때만** unlink하고(남의 파일 blind unlink 금지),
  발행 후 정리 실패는 `lock_publish_cleanup_failed`, 발행 실패 경로의 `closeSync` 오류·`readGuardRecord`/
  `readLockSnapshot`의 close 실패도 삼키지 않는다. **상태 미변경 refusal만 guard 반납**이라는 계약은 유지.
- **재진입 기준 보존(P1-4)**: `tryReenterSuiteLock`이 성공 시점의 **기본 record + dev/ino**를 `base`로 돌려주고,
  wrapper가 이를 cleanup 격리(`quarantineByToken({ expected })`)까지 명시 전달한다. 같은 tokenHash지만
  pid/identity가 다른 외부 교체 lock은 **보존**하고 guard를 남긴다. 판정 순서는
  tokenHash → 기본 record → quarantined → inode(= `verifyOwnership`과 동일). `expected` 없으면 아무것도 하지 않는다.
- **fixture 로더 close 실패(P2-5)**: `closeSync` 실패는 `fixture_close_failed`로 거부한다. 그 경로 검증용 주입은
  `loadFixtureConfig`의 **세 번째 인자(in-process io seam, fs 함수 4개)** 뿐이며 production 진입점은 인자 2개로만
  호출한다 → **"외부 주입은 argv 하나뿐" 계약 불변**(회귀 테스트가 호출부 인자 개수를 고정).
- 테스트: `suiteExclusiveLock.test.ts` **54 → 62건**(신규 8건: guard 제거 직전 재확인 2케이스 · acquire/reentry
  guard 제거 실패 시 성공 handle 없음 · 발행 후 임시 파일 정리 실패 · 격리 rename 직전 교체 보존 2케이스 ·
  동일 token 외부 교체 lock 보존 · fixture close 실패 · 호출부 io seam 미전달). 기존 1건은 강해진 계약대로
  **강화**(acquire guard inode 교체: exit 1 → **exit 2 + 성공 handle 없음**). 삭제·완화 0건.
  주입은 argv fixture 고정 enum에 pause 지점 4개 추가뿐(env·임의 명령 seam 없음).
  **mutation 6종**으로 비공허성 확인 후 전부 원복(원복 후 focused 62/62 재확인, mutation 흔적 grep 0).
- offline 검증: `node --check`·`tsc --noEmit` 0·build PASS, focused **62/62** + **24/24**,
  `npm test` **연속 3회 PASS(직렬, 겹침 없음)** = exec **75/75** + core **361/361** + acceptance **71/71**(3회 동일),
  그 뒤 stress **1회 PASS**(worker 4/4, elapsed 109.8s, `cleanupConfirmed:true`, `cleanupProblems:0`,
  `lockReleased:true`, `lockQuarantined:false`), `git diff --check` clean, git 가시 파일 **266건 NUL 0**,
  tmp lock/guard/격리/`.new` 잔재 0, repo backup/mutation 잔재 0, 잔존 프로세스 0.
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크/live runner 없음, 기존 dirty 전부 보존.
- 잔여 위험: 격리 lock·남은 guard·정리하지 못한 `.new`는 **사람이 수동 제거**, "마지막 확인 → unlink/rename" 창은
  Node 18에서 0으로 만들 수 없음, **lock 라이브러리 `closeSync` 실패 경로는 전용 테스트 없음**(io seam을 그쪽까지
  넓히지 않기로 결정 — 구현은 fail closed), `ps lstart` 1초 해상도, procps 호환 `/bin/ps` 전제,
  계약 밖 교체는 탐지·중단만 보장.
- **다음: 사용자 live 실행 3종 → evidence 3건 확인 → fresh Codex 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **네 번째 리비전**(네 번째 Codex REQUEST_CHANGES 5건 수정)·offline 검증 완료 · **live acceptance pending, M3d 미완료, 승인 미수령**)

- **네 번째 리비전이다. live runner 3종 여전히 미실행 → M3d 완료·M4 ready 아님.**
  리뷰 이력은 **REQUEST_CHANGES 4회 · APPROVE 0회**이고, 이 리비전은 **재검토 대기(pending)** 다.
  아래 "이전(세 번째 리비전)" 항목의 guard 계약은 유효하며 이 항목이 그것을 **보강**한다.
- **발행 신원 불변식(P1-1)**: 파일 발행은 임시 파일 fd `fstat` → `link` → 최종 경로 `lstat` **(dev,ino) 일치**까지
  확인해야 성공이다. lstat 실패(`lock_publish_unverifiable`)·불일치(`lock_publish_identity_mismatch`)는 성공이 아니고
  **최종 경로를 지우지 않는다**(증거 없는 파일은 blind unlink 금지 → 그 파일이 남아 새 suite를 막는다).
  `published:true`의 dev/ino는 non-null이라 이후 전이에서 **inode 검증이 생략되는 분기가 없다**.
- **전이 실패 분류(P1-2)**: `failure ∈ {refusal, mechanism}`, **기본값 mechanism(guard 유지)**.
  guard 취득 뒤의 I/O·신원 오류(temp create/write/close/link, 발행 확인, lock unlink, 격리 write/close/rename,
  guard 제거)는 전부 guard를 남기고, **상태를 바꾸지 않은 계약상 거부만** nonce+inode 확인 후 반납한다.
  short write·격리 close 실패·unlink ENOENT도 실패로 본다. 격리 record는 기본 필드 보존을 요구하므로
  **같은 token만으로는** 외부 교체를 격리로 인정하지 않는다(순서: tokenHash → record 동일성 → quarantined → inode).
- **주입 로더 단일 fd(P1-3)**: 경로를 **1회만** 열고(`O_RDONLY|O_NOFOLLOW`) 같은 fd의 `fstat`으로 일반 파일을 확인하고
  같은 fd에서 최대 8193B를 읽어 **실제 읽은 바이트로** 상한을 판정한다(검사–사용 경합 제거, 최종 symlink는 열기 전 거부).
- **confused deputy 축소**: stress는 child에게 **최소 설정만**(lockPath/injectDir/childMs/confirmMs/guardWaitMs)
  별도 파일로 전달하고, wrapper 계약에서 stress 전용 key를 삭제했다(`fixture_unknown_key`로 거부).
- 테스트: `suiteExclusiveLock.test.ts` **43 → 54건**(post-guard 발행 실패·발행 충돌·lock unlink 실패·guard 제거 실패·
  같은 token 외부 격리 거부·**TERM 무시 중첩 자손의 유예 후 KILL**·fixture 로더 4건·양방향 fixture key 거부).
  주입은 argv fixture의 고정 enum뿐(pause 지점 1개 추가), env/임의 명령 seam 없음, 기존 테스트 삭제·완화 없음.
  **mutation 9종**으로 비공허성 확인 후 전부 원복(해시 일치 확인).
- offline 검증: `node --check`·`tsc --noEmit` 0·build PASS, focused **54/54** + **24/24**,
  `npm test` **연속 3회 PASS(직렬)** = exec **75/75** + core **353/353** + acceptance **71/71**(3회 동일),
  그 뒤 stress **1회 PASS**(worker 4/4, elapsed 109.5s, `cleanupConfirmed:true`, `cleanupProblems:0`,
  `lockReleased:true`, `lockQuarantined:false`), `git diff --check` clean, git 가시 파일 **266건 NUL 0**, 잔재 0.
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크/live runner 없음, 기존 dirty 전부 보존.
- 잔여 위험: 격리 lock·남은 guard는 **사람이 수동 제거**, `ps lstart` 1초 해상도, procps 호환 `/bin/ps` 전제,
  계약 밖 경로 교체는 탐지·중단만 보장, Node 18에 `unlinkat`이 없어 "확인 → unlink" 창을 0으로 만들 수는 없다.
- **다음: 사용자 live 실행 3종 → evidence 3건 확인 → fresh Codex 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **세 번째 리비전**(세 번째 Codex REQUEST_CHANGES 6건 수정)·offline 검증 완료 · **live acceptance pending, M3d 미완료, 승인 미수령**)

- **세 번째 리비전이다. live runner 3종 여전히 미실행 → M3d 완료·M4 ready 아님. 어떤 리뷰 승인도 받지 않았다.**
  아래 "이전"(두 번째 리비전) 항목의 `.recovery`·stale 자동 회수 서술은 **이 항목으로 대체된다 — 그 모델은 제거됐다.**
- **lock format v2 + transition guard**: acquire/release/quarantine/reentry 전이는 전부 crash-persistent
  `<lock>.guard`를 exclusive 발행한 프로세스만 수행하고, guard 안에서 **tokenHash → 격리 표시 → inode** 순으로
  재확인한 뒤에만 파일을 만들거나 지우거나 덮는다. release↔quarantine 양방향 TOCTOU(새 소유 lock 삭제·덮어쓰기)가
  구조적으로 불가능하다. 옛 v1 record는 `lock_unverifiable`.
- **fail closed**: 전이 메커니즘 실패(quarantine write 실패 등)·전이 중 SIGKILL은 **guard를 남겨** 이후 acquire를
  전부 거부한다(수동 제거 안내). 아무것도 바꾸지 않은 계약상 거부는 no-op이라 **자기 nonce+inode 확인 후** guard 반납.
- **자동 회수 폐지**: `.recovery` mutex·stale rename 경로 삭제. 소유자가 죽은 lock은 `lock_orphaned`로 **항상 거부**
  (죽음 ≠ 정리 완료). lock이 없어도 guard가 있으면 acquire는 우회 publish하지 않는다.
- **중첩 그룹 계약**: standalone만 detached(자기 그룹 정리·확인), **nested wrapper는 그룹을 만들지 않아 전 자손이
  상위 stress pgid에 남는다**. 상위 timeout도 즉시 KILL이 아니라 **TERM → 8s 유예 → 확인 → KILL**(하위 예산 1.2s+3s보다 김).
- **테스트 주입 seam은 argv 하나뿐**: `scripts/lib/fixture-config.mjs`의 `--fixture-config <절대경로 .json>`
  (크기 8KiB·일반 파일·symlink 금지·절대경로·allowlist key·타입/범위 검증, 임의 명령 실행 없음).
  production은 lock 경로·`ps` fixture·pause/injection·evidence 디렉터리를 **env에서 읽지 않는다**
  (`HARNESS_LIVE_EVIDENCE_DIR` 폐기 → `resolveEvidenceDir({repoRoot, overrideDir})`).
  `HARNESS_SUITE_LOCK_TOKEN`만 남으며 이는 실제 부모→자식 ownership handoff다. live runner 정상 명령은 flag 없이 동작.
- 테스트: `suiteExclusiveLock.test.ts` **32 → 43건**(release↔quarantine 양방향, release 중 lock 교체 2케이스,
  전이 중 SIGKILL 잔존 차단, quarantine write 실패, guard 존재 시 acquire 거부, guard 소유권 nonce/inode 2케이스,
  orphan 거부, 중첩 자손 정리 3건), `liveEvidence.test.ts` **23 → 24건**(argv fixture + env decoy 무시 + 경로 미노출).
  mutation 4종(재확인 제거 / guard blind unlink / nested detached / timeout 즉시 KILL)으로 비공허성 확인 후 원복.
- offline 검증: `node --check`·`tsc --noEmit` 0·build PASS, `git diff --check` clean, git 가시 파일 **266건 NUL 0**,
  focused 24/24 + 43/43, `npm test` **연속 3회 PASS(직렬)** = exec 75/75 + core **342/342** + acceptance 71/71
  (1회차는 캡처 tail에 acceptance 71/71·ALL PASS만 남음 — `&&` 체인이라 앞 단계 통과가 전제),
  그 뒤 stress 1회 PASS(worker 4/4, elapsed 89.6s, `cleanupConfirmed:true`, `lockReleased:true`,
  `lockQuarantined:false`, 잔재 0).
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크 없음, 기존 dirty 전부 보존.
- 잔여 위험: 격리 lock·남은 guard는 **사람이 수동 제거**(자동 회수 폐지의 대가), `ps lstart` 1초 해상도,
  procps 호환 `/bin/ps` 전제, 계약 밖 경로 교체는 탐지·중단만 보장, evidence 경로 TOCTOU 완전 제거 불가.
- **다음: 사용자 live 실행 3종 → evidence 3건 확인 → fresh Codex 최종 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **두 번째 리비전**(두 번째 Codex REQUEST_CHANGES 4건 수정)·offline 검증 완료 · **live acceptance pending, M3d 미완료, 최종 재검토 미수령**)

> **대체됨(세 번째 리비전):** 아래 P1-3의 `.recovery`·stale 자동 회수는 제거되었고, detached 서술도 정정되었다.

- **두 번째 리비전이다. live runner 3종 여전히 미실행 → M3d 완료·M4 ready 아님. fresh Codex 최종 재검토도 아직 못 받았다.**
  아래 "이전" 리비전 항목의 stale 회수·정리 후 해제 서술은 이 항목으로 대체된다.
- **P1-1 (stress)**: 정리 확인 실패인데 lock을 무조건 해제하던 결함 수정. 확인 성공 시에만 해제하고,
  실패하면 **격리(quarantine)** 한다. 격리 lock은 소유자가 죽어도 stale 회수 대상이 아니라 다른 suite가 못 들어온다.
  격리는 write 1회라 매달리지 않는다. `exit` 핸들러·반복 시그널 경로도 동일. 요약에 `lockQuarantined` 추가.
- **P1-2 (`scripts/suite-lock.mjs`)**: 시그널 직후/두 번째 시그널에 즉시 해제하던 것과 normal close의 그룹 잔재
  미확인을 **단일 비동기 idempotent bounded shutdown 상태 기계**로 교체. 소유 그룹 TERM→유예→KILL →
  그룹·소유 pgid 자손 소멸 bounded 확인 → 확인 뒤에만 해제, 확인 실패는 격리. **exit 130/143 유지.**
  detached child의 중첩 그룹은 이 wrapper가 직접 확인한다(상위 pgid 스캔에 안 잡히므로).
- **P1-3 (`scripts/lib/suite-exclusive-lock.mjs`)**: `check → blind rename` 경합 제거.
  ① `<lock>.recovery` exclusive로 회수 직렬화(살아있는 회수자 → 대기 후 `lock_recovery_in_progress`,
  죽은/손상 mutex → **자동 인수 없이** `lock_recovery_stalled`), ② 회수 구간 안 재읽기·재분류(`lock_held`로 잡힘),
  ③ fd fstat inode 확보 + rename 직전 lstat + **rename 직후 inode 재확인**(원자적 rename의 CAS 증명),
  어긋나면 되돌리고 `lock_reclaim_identity_mismatch`. lock 파일은 임시 파일 → `link()` 발행이라 부분 write 잔재 없음.
- **P2-4**: "src/scripts/schemas/dist NUL 0" 주장은 거짓이었다(ignore된 `src/.DS_Store`에 NUL 6,681B).
  현행 M3d.2 검증 문장만 "변경·추적 대상 텍스트 파일"로 정정(과거 무관 항목은 미수정).
- 테스트: `suiteExclusiveLock.test.ts` **17 → 32건**(주입 seam은 좁은 enum·절대경로만, 무관 프로세스 생존도 함께 확인).
  mutation으로 신규 P1-3 테스트의 비공허성 확인 후 원복.
- offline 검증: build PASS, `git diff --check` clean, git 가시 파일 265건 NUL 0, focused **32/32**,
  `npm test` **연속 3회 PASS(직렬)** = exec 75/75 + core **330/330** + acceptance 71/71,
  그 뒤 stress 1회 PASS(worker 4/4, elapsed 100.9s, `cleanupConfirmed:true`, `lockReleased:true`,
  `lockQuarantined:false`, 잔재 0).
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치/네트워크 없음, 기존 dirty 전부 보존.
- 잔여 위험: 회수 mutex 보유 중 크래시·격리 lock은 **사람이 수동 제거**해야 풀린다(의도적: 겹침 방지 우선),
  `ps lstart` 1초 해상도, procps 호환 `/bin/ps` 전제, 계약 밖 경로 교체는 탐지·중단만 보장.
- **다음: 사용자 live 실행 3종 → evidence 3건 확인 → fresh Codex 최종 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 **리비전**(Codex REQUEST_CHANGES 6건 수정)·offline 검증 완료 · **live acceptance pending, M3d 미완료**)

- **리비전 완료. live runner 3종은 여전히 미실행 → M3d 완료·M4 ready 아님.** 아래 "이전" M3d.2 항목의
  저장 프로토콜·stress 계약·테스트 카운트는 이 항목으로 대체됐다.
- 신규: `scripts/lib/suite-exclusive-lock.mjs`, `scripts/suite-lock.mjs`, `src/tools/suiteExclusiveLock.test.ts`.
  `npm test`는 이제 `node scripts/suite-lock.mjs run test:inner`이고 `test:inner` = exec → core → acceptance(불변).
- 일반 `npm test`와 stress는 **같은 배타 lock 하나**를 지난다. stress가 띄운 자기 소유 child만 추측 불가 token으로
  재진입(lock 파일엔 sha256만). 소유자 판정은 `pid + ps lstart`, stale은 rename 원자 회수만, 확인 불가 lock은 거부(fail closed).
  `ps` 스캔은 backstop.
- stress: worker 전원 spawn 확인 + suite 종료까지 전원 생존 요구(부하 없는 PASS 금지), 부하 deadline > suite 상한 강제,
  단일 비동기 idempotent shutdown(소유 그룹·worker 종료 → 소멸 bounded 확인 → **그 뒤** lock 해제) —
  normal/timeout/error/SIGINT(130)/SIGTERM(143) 공용, 확인 실패는 FAIL.
- evidence 저장: 숨김 임시 파일에 전부 쓰고 fsync·close·재검증 후 **exclusive hard link로 원자적 publish**
  (덮어쓰기 없음). 크래시가 나도 최종 성공 산출물 이름의 잘린 파일이 생기지 않는다. dev+ino 신원으로 publish 직전
  재확인·정리 unlink 확인, 정리 실패는 실패로 보고. 경로 TOCTOU 완전 방어는 아님(Node 18 한계 명시).
- timestamp: schema == 런타임 판정(Z UTC, ms 3자리 선택, 시 00-23, 달력 실재성, 연도 2000..2099). 동치를 표 테스트로 강제.
- offline 검증: build PASS, `git diff --check` clean, **변경·추적 대상 텍스트 파일** NUL 0
  (정정: "src/scripts/schemas/dist NUL 0"은 틀렸다 — ignore된 기존 `src/.DS_Store`에 NUL이 있다),
  focused 23/23 + 17/17,
  `npm test` **연속 3회 PASS** = exec 75/75 + core **315/315** + acceptance 71/71,
  이후 stress 1회 PASS(worker 4/4 생존, elapsed 191.2s, `cleanupConfirmed:true`, 잔재 0, `lockReleased:true`).
- Git: `develop` / HEAD `af0552e` 불변, commit/push/PR/패키지 설치 없음, 기존 dirty 전부 보존,
  `dist/tools/liveEvidence.js` 재빌드(소스와 일치).
- **다음: 사용자 live 실행 3종 → evidence 3건 확인 → fresh Codex 재검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.2 구현·offline 검증 완료 · **live acceptance pending, M3d 미완료**)

- **M3d.2 코드/테스트/문서 완료. 그러나 live runner 3종을 아직 실행하지 않았다 → M3d 완료·M4 ready 아님.**
- 신규: `schemas/live_evidence.schema.json`, `src/tools/liveEvidence.ts`(+테스트), `scripts/m3d2-stress-acceptance.mjs`,
  `npm run acceptance:stress:m3d2`. 통합 대상은 최종 live runner 3종(`m3a-live-preflight`, `m3b2-live-handoff`,
  `m3c3b-live-handoff`)뿐이다.
- evidence 계약: 성공 전용(`status:"pass"`), 허용 필드는 version/contract/status/timestamp/metrics 5개,
  metrics는 runner별 exact key 집합의 정수(0..1e6)·boolean만. 모든 레벨 unknown key 거부.
  금지 필드(transcript·tool/MCP 입출력·argv·명령·경로·hostname/user·PID·session/call/request ID·env·secret·config 본문·
  free-form error/message)는 이름 스캔으로 먼저 거부하며 **`***` 마스킹으로도 통과 못 함**.
  영속화 직전 redactSecrets backstop에서 잔재가 잡히면 **가리지 않고 쓰기 거부**.
- 저장: `docs/evidence/m3d2`에 성공 1건당 1파일, dir 0700 / file 0600, exclusive create(덮어쓰기 없음),
  symlink·비디렉터리 거부, 실패 시 잔재 0. 경로는 payload·콘솔에 없음. 모든 검사+cleanup 성공 후에만 기록하고
  **기록 실패는 runner 실패**. (정정: 당시 테스트 seam이던 `HARNESS_LIVE_EVIDENCE_DIR`는 **세 번째 리비전에서 제거**됐다 —
  현행은 argv `--fixture-config`의 `evidenceDir`뿐이다.)
- offline 검증 결과: build PASS, `git diff --check` clean, NUL 0, `liveEvidence.test.ts` 단독 16/16 PASS,
  `npm test` **연속 3회 PASS** = exec 75/75 + core **291/291** + acceptance 71/71,
  stress `npm run acceptance:stress:m3d2` PASS(부하 worker 4, elapsed 85.6s, cleanup 문제 0, 잔존 0).
- **사용자 액션(live, pending)** — 순서대로 실행해 evidence 3건 생성:
  `HARNESS_LIVE_M3A=1 node scripts/m3a-live-preflight.mjs` →
  `HARNESS_LIVE_M3B2=1 node scripts/m3b2-live-handoff.mjs`(TTY 대화형) →
  `HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs`(TTY + npx shadcn 네트워크). 각각 앞에 `npm run build`.
- Git: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 이번에도 commit/fetch/push/PR/패키지 설치 없음.
  기존 dirty 변경 전부 보존. `dist/`는 커밋 대상 레포이므로 `dist/tools/liveEvidence.js`가 새 untracked 산출물로 존재.
- 잔여 위험(비차단): 상위 symlink 검사 bounded(4단계), `docs/evidence/m3d2`는 첫 성공 live 실행 시 생성,
  stress `ps` 스캔은 command line heuristic(배타 lock이 1차 방어), evidence 지표는 runner 판정의 파생값.
- **다음: 사용자 live 실행 → evidence 확인 → fresh Codex 독립 검토 → 그때 M3d 완료 판정.**

## 이전 (2026-07-26 — V3 M3d.1 완료, Codex Sol xhigh APPROVE · M3d 전체는 미완료)

- **M3d.1 완료. fresh Codex Sol xhigh 최종 검토 APPROVE. M3d 전체 완료 아님.**
- 원인: M3c-2 live runner가 baseline 이후 `shadcn@4.13.1 mcp` 매칭 프로세스를 전부 자기 잔여물로 간주 →
  무관한 동시 프로세스가 거짓 실패 유발. 수정 범위는 `scripts/m3c2-live-read-semantics.mjs` +
  `src/tools/shadcnReadSemanticsProbe.test.ts` 두 파일뿐.
- 소유권 = runner 프로세스 트리 자손 OR cwd가 runner 임시 base 하위. base 밖의 진짜 독립 post-baseline
  sibling은 foreign으로 무시. unknown inspection은 fail-closed 유지·kill 안 함.
- 신원은 PID 단독이 아니라 `pid + ps lstart`. 후보 argv 미로깅, 진단은 pid·ownership·run별 salted SHA-256
  signature만. 테스트 sleeper는 bounded TTL, 정리는 child handle 또는 nonce 확인 orphan에 대해 bounded 종료
  확인(blind PID signal 없음).
- 최종 리비전 후 검증: `git diff --check` clean, NUL 0, build PASS, 해당 파일 단독 18/18 PASS 2회,
  `test:core` 275/275 PASS, 격리 `npm test` PASS = exec 75/75 + core 275/275 + acceptance 71/71.
- 앞선 겹친 검증 1회 실패는 fresh 리뷰어와 메인 스위트가 전역 m3c2 temp/process 상태를 동시 관찰한 탓.
  격리 재실행 PASS. 교훈(로드맵 반영): **전역 프로세스/tmp 상태 관찰 테스트는 exclusive resource class/lock
  필수·동시 실행 금지** → M4 durable-state/scheduler 계약 + M5 bridge 실행 요건.
- M5 추가 요건(Claude bootstrap): 진행/이벤트 스트리밍, no-progress·wall-clock bounded deadline,
  cancellation, descendant cleanup. 최종 결과만 내는 silent session 불가.
- Git 관찰: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74`, 로컬 origin/develop 동일 커밋
  (remote-tracking reflog 2026-07-26 13:48:21 +0900 push). 이번 작업은 commit/fetch/push 없음.
  워킹 트리는 **의도적으로 dirty**(선행 docs-only 로드맵 편집 + M3d.1 구현 2파일, 로드맵 문서는 untracked) —
  clean 아님. Claude Code 관찰 버전 2.1.220.
- 잔여 위험(비차단): `lstart` 1초 해상도, 대상 Linux는 procps 호환 `/bin/ps` 전제(미지원 시 fail-closed).
- **다음: 남은 M3d — redacted persistent live-evidence schema/테스트 + 반복 full-suite/stress acceptance.
  별도 상세 계획·승인 필요. M4 ready 아님.**

## 이전 (2026-07-26 — M3d~M10 자율 오케스트레이션 로드맵 활성화)

- `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` 신규. M3d 이후 최우선 구현 기준으로 승격.
- 순서: M3d 안정화 → M4 통신/state → M5 Codex↔Claude bridge/autopilot → M6 계층/fresh context
  → M7 기획·Research → M8 디자인 → M9 개발 → M10 hardening.
- 중앙 LLM 장기 세션을 SoR로 사용하지 않음. deterministic TypeScript kernel+디스크 state가
  상태·의존성·권한·artifact hash를 관리하고 Coordinator/Worker/Reviewer는 fresh session.
- agent 메시지는 공통 envelope+type별 Markdown template+artifact SHA-256; sibling 직접 상태변경·raw transcript 전달 금지.
- 모델: Claude Code Opus=개발/수정, Codex `gpt-5.6-sol` xhigh=계획·문서 비평·fresh review.
- M5 뒤부터 milestone 1회 승인 범위에서 자동 plan→implement→test→review→revise→verify. hard deny 불변.
- 기준: `develop`/`af0552e`, origin 동일, clean, Claude Code 2.1.220, Codex CLI 0.146.0-alpha.3.
- 재검증: exec 75 PASS, acceptance 71 PASS, core 전체 부하 272/273(known M3c-2 smoke flake),
  해당 파일 단독 16/16 PASS. 다음은 M3d 상세 계획·승인(코드 미착수).

> 정정: 위 "clean"과 flake 수치는 이 항목 작성 시점 기록이다. 현재 상태는 위 M3d.1 항목 참조
> (워킹 트리 dirty, flake는 M3d.1에서 해소, core 275/275).

## 최신 (2026-07-24 세션 — V3 M3c-3b actual live PASS · V3 M3 전체 완료)

- **filtered shadcn read handoff actual live acceptance PASS(Claude Code 2.1.218). offline+live 완료. V3 M3 전체 완료.**
- live 증거(runner exit 0/PASS): preflight shadcn **connected**+host **5** exact(원본7 중 금지2 미노출·canary 부재); config `node`+고정 proxy(launcher/npx 없음); **config hash 체인**(파일 sha256==snapshot==outcome==run_state)·snapshot_path 일치; argv allowed5/denied2/mcp__* 없음/`-- prompt`/-p·stream-json 없음; trace **records 25·MCP tool_requested 3·session_end 1**, 3개 각 requested/succeeded 동일 callId·server=shadcn, **permission_requested/tool_failed/tool_denied 없음**, sanitizedInput 정확 일치, 금지2 미관측·원문/transcript/secret 없음; serviceCwd 무변경·run_state completed 불변·dir700/file600·canary·잔존 프로세스 없음·cleanup 완료.
- 실패 이력: ①첫 live protocol/startup interop → server_not_connected, ②두 번째 status=pending(5s connect deadline), ③blocking MCP env 0/45000/45000 후 PASS.
- dead helper 정리: `applyBlockingMcpEnv()` 단일 적용(preflight return·handoff shadcn spawn), 직접 Object.assign 제거, 기본 handoff 불변. runner는 계약 값 사후 확인 유지.
- M3a(strict 격리 live)·M3b.2(empty MCP 대화형 Hook live)·M3c-3b(filtered read live) 모두 충족. **다음 단계는 별도 계획 검토(M4 등)로만 기록 — 구현 미착수.**
- 커밋: `feat(v3-m3c.3b): enable filtered shadcn read handoff` 단일 커밋(push 금지). 검증: exec 75 + core 273 + acceptance 71.

## 이전 (2026-07-24 세션 — V3 M3c-3b 두 번째 live P0: blocking MCP 연결 env)

- **두 번째 live도 server_not_connected(status=pending). 원인: Claude 2.1.218 MCP_CONNECT_TIMEOUT_MS 기본 5s < cold npx+attestation. 동일 live 재시도 안 함.**
- 단일 출처 `src/tools/mcpEnv.ts`: `BLOCKING_MCP_ENV`(NONBLOCKING=0/CONNECT_TIMEOUT_MS=45000/MCP_TIMEOUT=45000). 순서: proxy 30s < handshake 45s < preflight 60s.
- preflight `buildChildEnv`·handoff-shadcn interactive spawn env에 **마지막에** 강제(ambient/testEnv override 불가). 기본 handoff(empty MCP) 경로는 미적용 → 불변. pending/failed/needs-auth 불성공·connected+exact tools만 성공·hard timeout 60s 유지. argv/stdio/Hook 무변경.
- 테스트: preflight/handoff-shadcn env 세 값 정확·override 불가·secret 미전달, 기본 handoff 강제 없음. runner는 BLOCKING_MCP_ENV 계약 값 사후 확인(불일치 exit 2), pending retry/성공 처리 미추가.
- 검증: exec 75 + core 273 + acceptance 71, build/tsc/node --check/gates/diff/rg 통과.
- **live 재실행은 사람 승인 후 수동(보류) — handshake 타임아웃(5s→45s) 원인 제거.**

## 이전 (2026-07-24 세션 — V3 M3c-3b MCP proxy interoperability P0)

- **live preflight `server_not_connected` 원인 수정(동일 live 재시도 안 함). 실제 Claude/network 미실행.**
- **P0-1**: proxy가 downstream 협상 버전을 upstream initialize에 복사하던 것 제거. upstream `params.protocolVersion` 검증(missing/비문자열/미허용 → fail-closed·tools 미노출) 후 **요청 버전 그대로** 반환. downstream은 REQUEST_PROTOCOL_VERSION 별도 협상. upstream/downstream pv 별도 상태.
- **P0-2**: downstream attestation(init→tools/list exact-7) 완료 후에야 upstream listener를 켜던 구조 → **spawn 직후 즉시 upstream listener**, initialize 즉시 응답. attestation은 별도 bounded Promise. tools/list·tools/call은 attestation passed 전 성공 금지(pending은 startup timeout bounded wait), 실패 시 5개 미노출·연결 종료·non-zero·그룹 kill·HOME cleanup. upstream_end 성공 종료는 attestation 완료까지 defer.
- proxy 테스트 26→32(protocol 분리·unsupported/missing pv·2s 지연 init <500ms·지연 tools/list attestation 후 bare5·지연 attestation 실패 reject·pending abort). runner 진단: preflight_failed 시 scrub된 message(status) 출력·claudeBin redact.
- 검증: exec 75 + core 271 + acceptance 71, build/tsc/node --check/gates/diff/rg 통과. (M3c-2 runner smoke 테스트는 부하 시 간헐 flake — 단독 16/16, 재실행 green.)
- **live acceptance는 사람 승인 후 수동(보류) — preflight 협상/타임아웃 원인은 제거됨.**

## 이전 (2026-07-24 세션 — V3 M3c-3b 마지막 P1 정리 + 전용 live runner)

- **live 직전 P1 정리 + 전용 acceptance runner.** 실제 Claude/npx/network/TUI·commit 없음.
- P1: launcher 혼합 검사 `decl.args !== undefined`(빈 배열도 mixed_launcher). adapter 중복 launcher Set 제거 → `profiles.TRUSTED_LAUNCHER_IDS` 단일 출처.
- 신규 `scripts/m3c3b-live-handoff.mjs`: `HARNESS_LIVE_M3C3B=1`+TTY+claude version 게이트(없으면 exit 2), 임시 workspace/service repo, ambient MCP/Hook canary, production `runHandoff({toolProfileId:"handoff-shadcn-readonly"})` seam 없이 실행. 시나리오: 계획 승인→get_project_registries→search(button,limit1)→view(@shadcn/button)→/exit, 금지 2개 미호출.
- PASS: preflight snapshot(shadcn/connected·host5·원본7/금지2/canary 부재), config(node+고정 proxy·launcher/npx 없음), argv(allowed5·denied2·mcp__* 없음·-- 꼬리·-p/stream-json 없음), trace(profileId·server=shadcn·correlation·session_end1·금지2 미관측·원문/transcript/secret 없음), serviceCwd 무변경, run_state completed 불변·handoff record, 권한(700/600), canary 미기동, 잔존 프로세스 없음(lsof ownership 확인 후 kill), cleanup 완료.
- offline 검증: build/tsc(0)/node --check/opt-in·非TTY exit2/diff clean. exec 75 + core 265 + acceptance 71.
- **live acceptance는 사람 승인 후 수동 실행(보류).**

## 이전 (2026-07-24 세션 — V3 M3c-3b live 전 P0/P1 하드닝)

- **M3c-3b offline 배선의 P0/P1 보완.** 실제 Claude/npx/network/TUI·commit 없음.
- **P0-1**: launcher 실행 경로 override seam(proxyPath/launcherProxyPath) 전부 제거. `shadcn_read_proxy`는 항상 `node + PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js` 고정(외부 변경 불가). 파일 검증은 `verifyTrustedProxyFile`로 분리(임시 경로가 config에 들어가는 API 없음). `rg proxyPath src dist`=0.
- **P0-2**: 계약에 secretRefs=[]·allowedDomains=[]·server key 정확히 {name,launcher}(args 존재 거부) 추가. launcher+secretRefs → `launcher_secret_refs_forbidden`(config 전, 값 미노출). 변조 재현 → profile_rejected, runtime 0, sentinel 평문 0.
- **P1-1**: `validateServer`(로드 단계) — launcher/stdio/http/bare 분류별 강제, unknown key·launcher·mixed transport 거부. `McpServerDecl.launcher` literal. schema server oneOf+additionalProperties:false로 runtime 일치.
- **P1-2**: `lstatSync` 기반 symlink 거부(`launcher_proxy_symlink`).
- 불변 확인: profile 미지정 handoff 경로·allowed5/denied2/exact snapshot·runWorkflow MCP 가드 유지, 기존 테스트 삭제·완화 없음.
- 검증: exec 75 + core 264 + acceptance 71, build/tsc/diff clean, rg override 0.
- **live acceptance는 여전히 보류(사람 승인 후 수동).**

## 이전 (2026-07-23 세션 — V3 M3c-3b filtered shadcn read profile offline 배선)

> 정정: 최초 배선의 `launcherProxyPath` override seam은 2026-07-24 P0-1에서 제거됨(실행 경로 고정).

- **M3c-3a proxy를 handoff profile로 offline 배선.** 실제 Claude/npx/network/TUI·commit·push 없음.
- registry `handoff-shadcn-readonly`(mcp shadcn·bare5·preapproved host5·denied host2·approval_write·calls6/8000/60000·official). server는 **launcher `shadcn_read_proxy`**(절대경로·npx 미기록) → runtime에만 node+dist proxy로 변환(혼합/unknown/파일부재·디렉터리·읽기불가 fail-closed, config에 launcher 필드 없음).
- `harness handoff --tool-profile`(파일럿 이 id만, 계약 exact 검증) / `harness run … --handoff --handoff-tool-profile`(workflow `--tool-profile`과 분리, runWorkflow MCP 가드 불변) / `--print`에 `--tool-profile` 보존.
- 시퀀스(profile): load+계약검증 → components.json 표준 registry 검사(custom/private/malformed/symlink이면 Claude·proxy 전 registry_rejected) → preflight(proxy config)로 shadcn connected + 정확 5개일 때만 통과 → 동일 config 대화형 spawn(stream-json 미사용). argv는 `--allowedTools host5 --disallowedTools host2 -- prompt`(profile엔 mcp__* 전체 deny 없음; 기본 경로는 유지). Hook profileId+toolMap(5→shadcn), preview 'MCP 없음' 제거·secret/raw 미노출. HandoffRecord optional tool_profile_id/config_hash/snapshot_path, status/completed 불변.
- 검증: exec 75 + core 253 + acceptance 71, build/tsc/diff clean. 기존 M3c 불변 테스트는 "shadcn profile은 handoff-shadcn-readonly(launcher)만"으로 정정.
- **다음: live acceptance(실제 Claude+shadcn stdio proxy)는 사람 승인 후 수동 실행 — 현재 보류.**

## 이전 (2026-07-22 세션 — V3 M3c-3a signal P0 보완, M3c-3b 계획 검토 전)

- **startup/in-flight signal 즉시 종료 결함 보완.** fake `npx` fixture만.
- **원인**: AbortSignal이 serve(startup 완료 후)에만 붙어 startup/in-flight signal이 timeout(30s/60s)까지 대기.
- **보완**: 단일 관리 Promise로 재구성, **downstream spawn 직후부터** abort 연결(이미 aborted면 즉시). signal ⇒ 즉시 group 종료+pending reject+queue 폐기, child close 후 HOME 삭제. main SIGINT=130/SIGTERM=143(그대로), settled 후 stdout 미기록. listener 완료 시 제거, cleanup 정확히 1회(경합 안전), markDead가 timer clear.
- **downstream 응답 계약 위반(malformed/bad jsonrpc/id mismatch/result 비객체/cap/timeout/조기 close)=fatal group 종료. 일반 JSON-RPC tool error·result budget·입력 정책 거부=세션 유지**(그 호출만 거부).
- **P1**: main에서 env 백도어 제거, cleanup 실패는 `cleanupFaultForTest` 함수 seam으로만.
- 테스트 21→26(+5: exec SIGINT 130/SIGTERM 143 3초 내·descendant·HOME, env 무시 exit 0, downstream malformed/bad-result fatal, 정책거부/tool error 뒤 정상호출). 검증: exec 75 + core 234 + acceptance 71.
- **M3c-3b = 계획 검토 전 유지. 5개는 아직 노출 승인 아님. 전체 M3c 미완료.**

## 최신 (2026-07-22 세션 — V3 M3c-3a proxy P0/P1 보완, M3c-3b 착수 보류)

- **M3c-3a 프록시 P0 3건+P1 보완. M3c-3b(profile/handoff 배선)는 보류. 전체 M3c 미완료.** fake PATH `npx` fixture만.
- **P0-1** `main()`+ESM 가드(실행 진입점) — stdin/stdout 구동, stdout JSON-RPC 전용, stdin 정상종료+cleanup 성공만 exit 0, cleanup 실패/startup 실패/signal non-zero, SIGINT/SIGTERM에서 group 종료+HOME cleanup. **P0-2** tools/list/tools/call은 **bare name**만(`mcp__shadcn__` prefix는 host가 생성 — 서버 반환 금지), prefix 입력 거부, host-namespaced는 내부 보고만. **P0-3** `terminateProcessGroup()` 공용, fatal downstream(timeout/cap/malformed/id-mismatch/조기종료)은 즉시 그룹 종료+안전 오류 응답 후 finalize; 정책 거부(result_too_large 등)는 downstream 유지.
- **P1**: negotiated protocolVersion 저장→upstream init 응답 사용, initialize→initialized→tools/* 상태 머신, notification 무응답, id string/number 구분(1≠"1"), buffer/queue(≤64) 상한, constructor/spawn 실패 cleanup, cleanup_failed 표면화.
- 테스트: 기존 13개 공식 MCP 계약으로 교정(bare·순서) + 8 추가 = 21. 검증: exec 75 + core 229 + acceptance 71.
- **M3c-3b = 계획 검토 후 착수(보류). 5개는 아직 노출 승인 아님.**

## 최신 (2026-07-22 세션 — V3 M3c-3a shadcn read-only filtering MCP proxy, offline)

- **M3c-3a offline proxy 완료. profile 등록·노출 승인 아님. 전체 M3c 미완료.** fake PATH `npx` fixture만(실제 shadcn/network/Claude 없음). registry/tool_profiles.json·handoff·profiles·CLI 미수정.
- **`src/tools/shadcnReadMcpProxy.ts`(+`.test.ts`)·`src/tools/shadcnReadPolicy.ts`(신규)**: 원본 7개 전부 노출 문제 → 로컬 필터 MCP 프록시가 경계 제공. upstream엔 5개만·**로컬 제한 schema**(downstream desc/schema 미노출), downstream 고정 `npx --yes shadcn@4.13.1 mcp`(seam 없음). startup: components.json 검사(child 이전)→downstream init(허용 protocol·caps.tools·serverInfo)→tools/list **실측 7개 정확 일치** 아니면 fail-closed. 금지 2개 tools/list 미노출+call fail-closed(downstream 미전달), unknown/dup id/malformed fail-closed. 입력 정책(additionalProperties:false, registries=["@shadcn"]·types=["ui"]·limit1-20·offset0-1000·query1-200·view items 1-10 @shadcn/ prefix·traversal/URL/제어문자 금지). 상한: call≤6·60s·단일 256KiB·stdout2MiB·stderr64KiB, **resultChars>8000 hard reject(원문·pointer 미전달)**, isError/빈/structured/non-text fail-closed. child env allowlist+임시 HOME(ambient secret 미전달). 종료는 그룹 kill(detached, descendant 방치 없음)→close 확인→temp 정리.
- 테스트(+13, core 221). 검증: exec 75 + core 221 + acceptance 71.
- **미완료**: profile 등록·노출 승인·handoff 연결·result-size enforcement 정식 배선 = M3c-3b. 5개는 아직 노출 승인 아님.

## 최신 (2026-07-22 세션 — V3 M3c-2 actual live read semantics acceptance PASS)

- **M3c-2 offline+actual live 완료(PASS). 전체 M3c 미완료.** live runner 1회 exit 0, Claude 미사용(shadcn@4.13.1 stdio), 실행으로 코드·git 불변.
- 고정 5개(`get_project_registries`→`list_items_in_registries`→`search_items_in_registries`→`view_items_in_registries`→`get_item_examples_from_registries`) 정확 순서 호출, 금지 2개 미호출, 5회 unchanged=true, 전 결과 contentTypes=[text]·structuredContentPresent=false·withinProposedBudget=true.
- 실측 responseBytes/textChars: 365/285, 274/194, 289/207, 172/94, **최대 get_item_examples 4441/4161(budget true)**. config 정확·권한(runtime700/config600/snapshot600)·redaction·cleanup·잔존 없음 통과.
- 증거 경계: resultChars/resultBytes·protocolVersion/serverInfo 정확값은 이번 출력에 없어 추측 안 함(계약 통과로만 기록; 2025-11-25/shadcn 1.0.0은 M3c-1 실측 구분). 단일 무변경≠모든 부작용 부재.
- **5개는 노출 승인 아닌 검증 후보. 권한 분류·profile·handoff·result-size enforcement 미착수. 다음: M3c-3 권한 매핑·필터링·result-size enforcement 계획 검토(구현 미착수).**

## 최신 (2026-07-22 세션 — V3 M3c-2 read semantics probe P0/P1 보완, live 전)

- **M3c-2 P0 2건+P1 2건+runner 정합성 보완. actual five read calls 승인 대기. 전체 M3c 미완료.** fake stdio MCP fixture만(실제 shadcn/network 없음).
- **P0-1**: 호출 계획·금지·protocol allowlist를 non-exported 내부 상수 + deep-freeze로. 외부는 clone getter(`getSemanticsCalls`/`getForbiddenCallTools`/`getAllowedProtocolVersions`)만. 시작 시 독립 contract와 exact 비교(이름·순서·args canonical hash·중복·금지). getter clone/set 변조가 실제 호출/인자·금지·allowlist에 영향 없음 테스트.
- **P0-2**: withinProposedBudget을 text가 아니라 **전체 결과 canonical `resultChars`≤8000**으로 판정(+resultBytes). responseBytes=raw line bytes. structuredContent 큰 경우 budget false(측정만).
- **P1-3**: fs snapshot에 root type/mode 포함, baseline symlink spawn 전 차단, `O_NOFOLLOW` fd fstat/read(TOCTOU), 파일별 1MiB·전체 16MiB 상한, MAX_FS_ENTRIES off-by-one 수정. root chmod/기존 symlink/oversized 테스트.
- **P1-4**: 모든 실패 경로 kill→bounded close 후 reject, close 전 HOME/cache 미삭제, cleanup 실패 `cleanup_failed`. 실패/runner 후 `m3c2-home-*` 잔존 없음.
- **runner**: clone getter 사용, mcp-config 정확·권한(config600/runtime700/snapshot600), snapshot 구조(허용 key)로 raw payload 검사, capabilities.tools plain object.
- 테스트(+2 net, core 208). 검증: exec 75 + core 208 + acceptance 71.
- **미완료**: 권한 분류·profile 등록·handoff 연결·result-size enforcement. 5개는 노출 승인 아닌 검증 후보.

## 최신 (2026-07-21 세션 — V3 M3c-2 controlled read semantics probe scaffold, offline)

- **M3c-2 controlled semantics scaffold offline 완료. actual five read calls 승인 대기. 전체 M3c 미완료.** 실제 shadcn/network 미실행(fake stdio MCP fixture). profile/handoff/registry/result-enforcement 없음.
- **`src/tools/shadcnReadSemanticsProbe.ts`(신규)**: exact `npx --yes shadcn@4.13.1 mcp`. init→initialized→tools/list(7개 exact)→ **읽기 후보 5개만 고정 인자로 순차 tools/call**(코드 상수, 주입 seam 없음). 금지 2개(get_add_command_for_items·get_audit_checklist)는 호출 경로 없음. serviceCwd 호출 전/후 재귀 snapshot(경로·타입·mode·size·SHA-256)로 무변경 검증 — 생성/수정/삭제/symlink 시 `filesystem_changed` fail-closed. HOME/cache는 serviceCwd 밖 임시. CallToolResult(content/structuredContent/isError) 계약·isError/빈/malformed 거부. **외부 결과 원문 미저장** — 파생 지표만(hash/count/type/elapsed/bytes/unchanged/budget). 상한: 5회·per-call 60s·overall 5min·단일 256KiB·stdout 2MiB·stderr 64KiB·budget 8,000 chars **측정만**(초과 `withinProposedBudget:false`, 자르지 않음). artifact `mcp-read-semantics.json`(mode:read-semantics·usableForHandoff:false·externalDataUntrusted:true, dir700/file600/wx). operationSummary{initialize:1,initialized:1,toolsListPages≥1,toolCalls:5,calledTools:[5개],forbiddenToolCalls:0}.
- **`scripts/m3c2-live-read-semantics.mjs`(신규)**: `HARNESS_LIVE_M3C2_SEMANTICS=1` 없으면 exit 2, Claude 미사용, metrics만 출력·cleanup·잔존 검사. **이번 세션 미실행.**
- 테스트(+14, core 206). 검증: exec 75 + core 206 + acceptance 71.
- **미완료(주장 금지)**: 5개는 노출 승인 아닌 검증 후보. 권한 분류·profile 등록·handoff 연결·result-size enforcement 미완료. **다음: actual five read calls(승인 후) → 노출 승인·enforcement 설계.**

## 최신 (2026-07-21 세션 — V3 M3c-1 actual live schema probe PASS, offline+live 완료)

- **M3c-1 offline+actual live 완료(PASS). 전체 M3c 미완료.** live runner 1회 실행 exit 0/OK, Claude 미사용, tools/call 없음, cleanup·잔존 프로세스 통과.
- 실측: package `shadcn@4.13.1`, protocolVersion **2025-11-25**, serverInfo `shadcn 1.0.0`, 도구 7개 정확. **annotations·outputSchema 전 도구 없음.** inputSchema 요약 — items(get_add_command_for_items·view_items_in_registries required), query required(get_item_examples/search), get_audit_checklist·get_project_registries 입력 없음, list/search에 registries?/types?/limit?/offset?.
- **schema/description 실측됐으나 annotations/outputSchema 증거 없음. description은 서버 제공 untrusted → 권한 분류 근거로 미확정.** profile 등록·handoff 연결·도구 호출·result-size enforcement 미완료.
- **다음: M3c-2 controlled read semantics 검증 계획.** 검증: exec 75 + core 192 + acceptance 71.

## 최신 (2026-07-21 세션 — V3 M3c-1 schema probe P0 보완, live 전, offline)

- **M3c-1 P0 6건 보완. 실제 live schema probe 미실행·승인 대기. 전체 M3c 미완료.** fake stdio MCP fixture만 사용(실제 claude/npx/network 없음).
- P0-1 runner `checkComponentsJson` import를 `shadcnPilot.js`로 정정 + offline smoke(exit 0). P0-2 `HARNESS_SHADCN_NPX_BIN` 제거(항상 `npx --yes shadcn@4.13.1 mcp`, 테스트는 PATH의 `npx` fixture). P0-3 schema **key** scrub 대상이면 `secret_in_schema_key` fail-closed(원 key 미노출). P0-4 protocolVersion `2025-11-25`+revision allowlist, capabilities(.tools)·serverInfo(name/version) 검증, description optional·title 수집·inputSchema/outputSchema root type:object 강제·annotations untrusted hint. P0-5 raw Buffer byte 상한+StringDecoder, 수집 후 child close bounded wait(미종료 `child_did_not_close`). P0-6 결과 `operationSummary{...,toolCalls:0}`·raw payload 미저장.
- 테스트(core 192). 검증: exec 75 + core 192 + acceptance 71, runner offline smoke·opt-in exit 2.
- **미확정(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement. 실제 schema는 runner 승인 실행 후.

## 최신 (2026-07-21 세션 — V3 M3c-1 tools/list schema discovery scaffold, offline)

- **M3c-1 schema scaffold offline 완료. actual live schema probe 승인 대기. 전체 M3c 미완료.** 실제 claude/npx/shadcn/네트워크 미실행(fake stdio MCP fixture 검증). tools/call 미구현·미전송, profile 등록·handoff 연결·권한 분류 없음.
- **`src/tools/shadcnSchemaProbe.ts`(신규)**: shadcn 전용 좁은 stdio JSON-RPC probe. `initialize→notifications/initialized→tools/list`만(tools/call 코드 경로 없음). 명령 정확히 `npx --yes shadcn@4.13.1 mcp`(주입 seam 없음, 테스트는 `HARNESS_SHADCN_NPX_BIN` launcher만 교체). protocolVersion `2025-06-18` 엄격 negotiation. registry 검사를 config/spawn 이전 강제. bare 도구명→`mcp__shadcn__` namespacing→M3c-0 7개 정확 일치. pagination(반복 cursor·페이지8·64개 상한), name/description/inputSchema 필수·outputSchema/annotations plain object, 깊이/키/크기 상한, JSON-RPC/malformed/no-init/timeout/non-zero/stdout(1MiB)/stderr(64KiB) 거부. 산출물 `mcp-schema-discovery.json`(mode:schema-discovery·usableForHandoff:false, raw payload 미저장, 반환==저장, dir700/file600/wx, deep-scrub, `ShadcnSchemaResult{schemaDiscovery:true}` 타입 분리).
- **`scripts/m3c-live-schema-probe.mjs`(신규)**: `HARNESS_LIVE_M3C_SCHEMA=1` 없으면 exit 2. shadcn MCP stdio 직접 실행(claude 미사용), 잔존 프로세스·tools/call 미전송 검증. **이번 세션 미실행.**
- 테스트(+12, core 188). 검증: exec 75 + core 188 + acceptance 71, npm pack 78(`shadcnSchemaProbe.js` 포함).
- **미확정(주장 금지)**: 권한 분류·profile 활성화·handoff 연결·result-size enforcement. 실제 schema는 runner 승인 실행 후 확정.

## 최신 (2026-07-21 세션 — V3 M3c-0 실제 live discovery 1회 실행, discovery offline+live 완료)

- **M3c-0 discovery offline+live 완료. 전체 M3c는 미완료.** Claude Code **2.1.216**에서 `shadcn@4.13.1` MCP discovery 1회 실행 — runner **exit 0/OK**, server `shadcn` **connected**, strict 격리(ambient canary 미기동), 권한(dir700/file600)·redaction·cleanup·잔존 프로세스 검사 통과. 실행으로 코드·git 상태 불변.
- **발견된 실제 MCP 도구 7개(원문, 권한 추측 금지)**: `get_add_command_for_items`, `get_audit_checklist`, `get_item_examples_from_registries`, `get_project_registries`, `list_items_in_registries`, `search_items_in_registries`, `view_items_in_registries` (모두 `mcp__shadcn__` prefix).
- **미착수**: profile 등록·handoff 연결·MCP 도구 호출·권한 등급 분류 없음(이름=권한 금지).
- **다음: M3c-1 — `tools/list` schema·semantics 검증 계획**(inputSchema·read/write 성격 실측 → 권한 매핑·profile 등록). 검증: exec 75 + core 176 + acceptance 71.

## 최신 (2026-07-21 세션 — V3 M3c-0 live runner 런타임 결함 2건 수정, live discovery 승인 대기)

- **runner 런타임 결함 수정(`scripts/m3c-live-discovery.mjs`만, src/dist 불변).** ① 잔존 polling의 `sleep` 미정의(ReferenceError) → inline `const sleep` 정의. ② versionEnv `LC_*` wildcard 제거 → 표준 POSIX LC 카테고리만 명시(LC_SECRET_TOKEN/LC_API_KEY 유출 차단). ③ `/bin/ps` 실패 fail-closed(`matchingShadcnPids`→{ok,error}, baseline 실패 exit 2·polling 실패 FAIL, redact).
- offline 실측: 잔존 프로세스 stub → polling 진입·ReferenceError 0·exit 1(테스트 PID ownership 정리), 정상 stub exit 0, LC_SECRET/LC_API 미전달, opt-in 없음 exit 2. 검증 exec 75/core 176/acceptance 71 유지.

## 최신 (2026-07-21 세션 — V3 M3c-0 live runner 최종 보안 보완, live discovery 승인 대기)

- **live runner 최종 보안 보완 완료. 실제 live discovery 승인 대기.** `scripts/m3c-live-discovery.mjs`만(src/dist 불변). 실제 Claude/npx/network 미실행(임시 stub 실측).
- `claude --version`: allowlist env만·timeout 10s·maxBuffer 64KiB(초과/오류 fail-closed, sentinel/ambient secret 미전달, claudeBin redact). discovery 오류는 rawMessage로 sentinel 검사 후 redact 출력(always-false 버그 정정). discovery 전/후 `/bin/ps`로 `shadcn@4.13.1 … mcp` 잔존 PID 감지(≤5s polling, 자동 kill 없이 redact 보고·FAIL). offline stub: runner exit 0, version env=allowlist만(sentinel/secret 부재). opt-in 없음 exit 2.
- 검증: node --check·build·npm test(exec 75/core 176/acceptance 71)·tsc noEmit·git diff --check 클린. **실제 도구명·profile·handoff·result-size enforcement 미확정, M3c 완료 아님.**

## 최신 (2026-07-21 세션 — V3 M3c-0 offline hardening, live discovery 미실행)

- **M3c-0 offline hardening 완료. live discovery 미실행.** Codex 재현(custom registry 수용·빈 도구 수용·foreign pin package·duplicate 도구명 평문 노출) 반영.
- **P0-1**: `runShadcnDiscovery`가 시작 직후 `checkComponentsJson` 강제(config/spawn/산출물보다 먼저) → custom/malformed/symlink/oversized면 `registry_<code>`·spawn 없음·runtimeDir 미생성. **P0-2**: `package` 우회 인자 제거 → 무조건 `shadcn@4.13.1`. **P0-3**: shadcn 도구 0개면 `no_tools`(성공 1~64). **P0-4**: 전 경로 typed 오류 code 보존+message scrub, 성공 snapshot(status/tools/package/timestamp) scrub 후 반환==저장(deepEqual), `redactNames`(scrub 전용·child 미전달).
- **P1**: components.json `O_NOFOLLOW` fd fstat/read(TOCTOU 방지), stdout 1MiB·stderr 64KiB 상한(초과 kill), 강제 env(MCP_CONNECTION_NONBLOCKING 등) testEnv 우회 불가, snapshot persist wx 충돌 typed·부분성공 미반환, runner 강화(claude --version·config 서버1개·권한·snapshot 계약·canary/sentinel 부재).
- **테스트(core 176)**: registry 판정·package 고정·discovery 성공/실패·registry 핵심강제·no_tools·redaction·forced env·persist·stream 상한. runPreflight/handoff/M3b.2 불변, registry/tool_profiles.json 불변. 검증: exec 75 + core 176 + acceptance 71.
- **실제 도구명·profile·handoff·result-size enforcement는 여전히 미확정. M3c 완료 아님.** live discovery는 별도 승인 후 실행.

## 최신 (2026-07-20 세션 — V3 M3c-0 shadcn discovery scaffold, offline)

- **M3c discovery scaffold offline 완료. 실제 discovery 및 profile 활성화는 미완료(미실행).** 실제 Claude/npx/shadcn/네트워크·MCP 도구 호출 안 함. registry 미등록·handoff 미연결.
- **`src/tools/shadcnPilot.ts`(신규)**: (1) shadcn 파일럿 정책 — `SHADCN_PACKAGE="shadcn@4.13.1"` pin, `npx --yes shadcn@4.13.1 mcp`, server=shadcn, secretRefs=[], `shadcnDiscoveryProfile`(tools=[] 발견 대상). (2) `checkComponentsJson` — 없음/registries 없음/빈 객체 허용, 항목 있음/비plain object→custom_registry_forbidden, malformed·symlink·비일반·64KiB→fail-closed(내용·secret 미포함). (3) `runShadcnDiscovery` — runPreflight와 분리된 별도 API, 단일 shadcn strict config + headless `claude -p` system/init 도구명 수집, 서버 정확 [shadcn]+connected, foreign/duplicate/empty/too-long/too-many/malformed/non-zero/no-init/timeout(60s) 거부, ≤64도구·≤256B·≤64KiB, raw init 미저장, 오류 redaction. 산출물 `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false, `ShadcnDiscoveryResult{discovery:true}`)로 `PreflightSuccess{ok:true}`와 타입 분리.
- **`scripts/m3c-live-discovery.mjs`(신규)**: `HARNESS_LIVE_M3C_DISCOVERY=1` 없으면 exit 2, npm test/CI 비대상, 임시 serviceCwd·ambient canary·PID ownership 검사·signal/finally cleanup, 실제 도구명 출력·snapshot, 도구 호출/TUI 미실행. **이번 세션 미실행.**
- **테스트**: registry 판정·pin·discovery 성공/실패·산출물 권한·redaction·registry/tool_profiles.json 불변. runPreflight/handoff/M3b.2 불변. (하드닝 후 core 176 — 위 07-21 항목 참조.)
- **실제 shadcn 도구명(browse/search/install/add 등)은 아직 미확인** — runner를 사람이 실행해야 발견. **다음: M3c 파일럿 계획 검토(discovery 실행 → 도구명 확정 → profile 등록·handoff 연결).**

## 최신 (2026-07-20 세션 — V3 M3b.2 actual live acceptance 완료, PASS)

- **M3b.2 offline + actual live 완료(PASS)**: 실제 Claude Code 2.1.215에서 live runner(`scripts/m3b2-live-handoff.mjs`, `HARNESS_LIVE_M3B2=1`) exit 0/PASS. 앞선 P0(argv/planning 경로/sentinel 출력) 수정 후 재검증. 임시 `m3b2-live-*` 정리 완료.
- **통과 범위**: exact Hook 6종(exec form) · empty MCP snapshot(servers=[]/tools=[])·config({}) · planning contextRoot 접근(`--add-dir`, 00_IDEA/06_CEO_DECISION Read 성공, serviceCwd docs 미생성) · Read 성공/실패 callId correlation · Bash 승인(permission_requested callId=null + tool_requested/succeeded, 비출력 sentinel 검사) · Write 수동 거부(requested+permission·marker 부재, denied 미합성) · SessionEnd 1건 · ambient MCP/Hook canary 미기동(strict + `--setting-sources ""`) · trace redaction·권한(dir700/file600)·원문 미저장 · run_state 불변 · argv `-p`/stream-json 없음(`--` 꼬리).
- **버전 종속 실측**: 2.1.215. CLI 변경 시 재검증. 실패 시도(argv P0·planning P0-1·sentinel P0-2)는 역사 기록으로 유지.
- **다음: M3c(shadcn read) 파일럿 계획 검토**(구현 아님). 검증: exec 75 + core 159 + acceptance 71.

## 최신 (2026-07-20 세션 — V3 M3b.2 두 번째 live P0 2건 + 수정, 전체 PASS 아님)

- **두 번째 live acceptance 전체 PASS 아님**: argv `--` 꼬리는 통과했으나 P0 2건 발견. 실제 Claude/TUI 미재실행, 수정·offline 검증만.
- **P0-1 planning 경로 단절**: task prompt Include는 `docs/*.md` 상대경로인데 대화형 cwd=serviceCwd, 실제 planning 문서는 `projectPaths(project).root/docs`. Claude가 docs 못 찾고 serviceCwd에 잘못된 `docs/WORKLOG.md` 생성. → 수정: `contextRoot=projectPaths(project).root` + argv `--add-dir <contextRoot>` + initialPrompt 경로 계약(Include=contextRoot 절대경로, serviceCwd/contextRoot 별개, WORKLOG=contextRoot/docs/WORKLOG.md, serviceCwd docs 금지) + preview에 두 경로 별도 표시 + 128KB fallback도 contextRoot 접근. `--disallowedTools mcp__* -- <initialPrompt>` 꼬리 유지.
- **P0-2 sentinel TUI 평문 출력**: Bash 검증이 `printf '%s' "$M3B2_LIVE_TOKEN"`이라 fake sentinel 값이 TUI에 출력됨(실제 credential 아님, runner fake). → 수정: `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`(비출력 존재 검사)로 변경. 값은 terminal/settings/config/snapshot/trace/outcome에 미출력. collector redaction 단위 테스트 유지.
- **테스트/runner**: `--add-dir=contextRoot`·경로 계약·serviceCwd docs 미생성 회귀(core 단위 + runner), planning 문서(00_IDEA/06_CEO_DECISION) Read 성공 trace, Write 거부 안내(기본 Yes에서 Enter 금지·방향키 No·재시도 금지).
- **상태: M3b.2 live 재검증 대기**(전체 PASS 아님). 검증: build/tsc noEmit 클린, exec 75 + core 159 + acceptance 71.

## 최신 (2026-07-20 세션 — V3 M3b.2 첫 live 시도 무효(argv P0) + 수정)

- **첫 live acceptance 시도 무효(argv P0)**: 대화형 spawn argv 꼬리가 `--disallowedTools mcp__* <initialPrompt>`였는데, `--disallowedTools`(가변 인자)가 프롬프트를 deny 규칙으로 소비 → Claude Code 2.1.215에서 `Permission deny rule "..." matches no known tool` 경고 폭주. **Hook 검증 미수행, PASS 아님.**
- **수정**: `src/core/handoff.ts` argv 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로(옵션 종료 구분자 `--`). 회귀 테스트 2지점 추가(`handoff.test.ts` 기존 성공 테스트 강화 + 전용 P0 테스트), runner(`m3b2-live-handoff.mjs`) 사후 argv 검증에 `--` 종료·prompt 격리 확인 추가. 대화형 TUI·stdio inherit·`-p`/stream-json 미사용 불변.
- **상태: M3b.2 live acceptance 재실행 대기**(offline 검증만 완료, 실제 Claude/TUI 미재실행). 사람이 runner 재실행해야 실제 Hook 검증 성립. **M3c(shadcn read)는 live 통과 후.**
- 검증: build/tsc noEmit 클린, exec 75 + core 158 + acceptance 71.

## 최신 (2026-07-20 세션 — V3 M3b.2 offline 최종 보완)

- **offline 최종 보완(실제 Claude/TUI/live Hook 미실행)**: ① 승인 preview 전체 redaction — `buildPreview`가 task prompt head만이 아니라 cwd·trace 등 모든 동적 문자열을 포함한 최종 결과 전체를 scrub(승인 화면 secret 평문 부재). ② collector 검증 예외 정규화 — stat/readability 검증을 try/catch로 감싸 부재·디렉터리·stat/access 오류를 예외 없이 scrub된 `setup_failed`로 반환(preflight/spawn/handoff 기록 없음). production 경로는 `PACKAGE_ROOT/dist/tools/hookCollector.js` 유지 + 테스트용 `collectorPath` seam. ③ 테스트 정합성 — wx 충돌 테스트를 "trace 파일 exclusive-create 충돌"로 개명, collector 부재/디렉터리 setup_failed 테스트 추가, preview 전체 scrub 테스트 추가. 검증: exec 75 + core 157 + acceptance 71.
- **다음: M3b.2 actual Claude Hook live acceptance(수동)** — 아래 07-19 항목과 동일(empty MCP/settings/Hook 대화형 경로 live 미검증). **M3c(shadcn read)는 live 통과 후.**

## 최신 (2026-07-19 세션 — V3 M3b.2 Interactive handoff, offline)

- **M3b.2 완료(offline + P0/P1 보완)**: 문서 완료 → Claude Code 대화형(TUI) 핸드오프. `src/core/handoff.ts`(신규, `runHandoff` 명시적 outcome union)·`src/commands/handoff.ts`(신규)·`src/cli.ts`·`src/commands/run.ts`(`--handoff`/`--cwd`). 시퀀스: print → completed 확인 → summary/task-prompt 갱신 → initialPrompt(128KB 초과 시 절대경로 지시, "AGENTS.md·CLAUDE.md 준수" 명시) → missing binary/non-TTY 폴백 → 승인 게이트 → **collector 존재 검증(setup_failed)** → **fail-closed preflight(빈 MCP config, ambient 감지 차단)** → 산출물 exclusive-create(0600/dir700) → spawn. argv: `--strict-mcp-config --mcp-config <빈> --settings <hook-settings> --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --disallowedTools mcp__* -- <initialPrompt>` (가변 인자 `--disallowedTools` 뒤 `--`로 옵션 파싱 종료 → prompt를 positional로; `--add-dir <contextRoot>`는 planning 문서 접근용, P0 수정 반영). **`-p`/stream-json 없음, stdio inherit.** Hook settings 공식 exec form(command=node, args=[dist collector 절대경로, kind]). redaction refs는 env 이름에서 파생(값 미기록)→`HARNESS_TOOL_SECRET_REFS`(이름)+preflight `redactNames`(scrub 전용, child 미전달). run_state.handoff는 실제 spawn 시에만(종료코드·completed 불변). trace JSONL은 spawn 전 빈 0600 사전 생성(append 후 0600 유지). 실제 Claude/TUI/live Hook 미실행. 검증: exec 75 + core 154 + acceptance 71.
- **다음: M3b.2 actual Claude Hook live acceptance(수동)** — `--setting-sources ""` 수용, exec-form Hook 6종 등록, 6 payload, trace redaction·0600, TUI 유지·stream-json 미사용. **M3c(shadcn read)는 live 통과 후.**

## 이전 (2026-07-19 세션 — V3 M3b.1 HookTrace 기반, offline)

- **M3b.1 완료(offline + P0/P1 하드닝)**: Hook payload→공통 ToolTrace JSONL. `src/tools/{toolTrace,hookCollector,hookSettings}.ts`(+test), `trace.ts` sanitizeValue(민감 key 마스킹+depth 상한). 6 이벤트/필수 필드, collector fail-closed(엄격 config·payload 계약 검증·PreToolUse/PermissionRequest exit2·사후 exit1·stack/secret 미출력), PermissionRequest 공식 payload엔 correlation ID 없음→callId=null·synthetic 미생성·permissionOutcomeObservable:false, SessionEnd는 종료 사실만(unresolved·승인 결과 추측 금지), UTF-8 byte·재귀 depth 상한, settings shell-safe quoting+denyMatchers dedupe, env 계약(secret 이름만), 원문 미저장. `toRunEvent`는 post-session/테스트용(실시간 emit 없음). 실제 Claude/TUI 미실행. 검증: exec 75 + core 131 + acceptance 63.
- **다음 M3b.2**: handoff command/spawn, settings 파일 write·claude 실행, 실제 Claude Hook 이름 대응 실측. 대화형은 `stdio:inherit`+Hooks만(stream-json은 M3a preflight 전용). (M3c shadcn은 그 뒤.)

## 이전 (2026-07-19 세션 — V3 M3a offline+live 완료)

- **M3a offline+live 완료**: 수동 live runner(`scripts/m3a-live-preflight.mjs`, `HARNESS_LIVE_M3A=1`)로 실제 Claude Code **2.1.215** 실측 PASS — expected server connected, `mcp__expected__read_thing` 정확 일치, ambient canary 미기동(strict 격리), sentinel/config/snapshot redaction 통과, fixture·임시 디렉터리 잔존 없음. **버전 종속 실측(CLI 변경 시 재검증)**. offline(파서/config/preflight/보안 보완)은 커밋 `cbb8749`.
- **다음**: **M3b 계획 검토**(handoff trace: Hook→ToolTrace JSONL). M3c shadcn은 그 뒤.

## 이전 (2026-07-19 세션 — V3 M3a live 전 보안 보완)

- **M3a 보안 보완**: npx 정확 고정버전 강제(unpinned/latest 거부, node 예외), config 강화(중복도구·transport 혼합·credential·secret 실값 거부), preflight env 격리(allowlist+선언 secret만, testEnv seam), snapshot redaction 정합(반환=저장, 실패 시 미생성), init fixture 9곳 `mcpServers:[]`. 실제 claude 미실행. 검증: exec 75 + core 94 + acceptance 63.
- **다음**: M3a live(실제 구독 호출 실측) → M3b handoff trace → M3c shadcn read.

## 이전 (2026-07-19 세션 — V3 M3a Headless MCP preflight, offline)

- **M3a 완료(offline)**: system/init 파서 확장(`McpServerStatus`, connected는 "connected"만), MCP config 생성(`claudeCodeMcpAdapter.ts` — 서버 검증·@latest 거부·alwaysLoad·SHA-256·runtime gitignore), headless preflight(`preflight.ts` — argv/env 강제·hard timeout·init 후 의도적 종료), snapshot 검증(정확 비교·canary 자동 실패·fail-closed `PreflightError`·redaction). 실제 claude 미실행(stub acceptance). M2.1 MCP fail-closed 유지. 검증: exec 75 + core 74 + acceptance 63.
- **다음**: M3a live(실제 구독 호출로 argv·system/init·strict 격리·canary 실측) → M3b handoff trace(Hook→ToolTrace JSONL) → M3c shadcn read.

## 이전 (2026-07-19 세션 — V3 M2.1 P0 보완)

- **M2.1 완료(M3 이전 선행 보완)**: ① 정책 실제 전달 — `ProviderExecContext{claudeArgs,redactNames}`로 compile된 policy를 runWorkflow→runAgent→claudeCodeProvider spawn argv까지 배선(mock/anthropic 무시, 미지정 회귀 없음). ② MCP fail-closed — `hasMcpBinding` profile은 run_start 이전 거부(loader/compile은 성공, M3용). ③ secret redaction — invalid secretRef 오류 index만, provider 오류 stderr/stdout `redactSecrets` 통과, 값은 context로 미전달(이름만). ④ JSONL writer optional 재귀 redaction(원본 불변). 검증: exec 74 + core 52 + acceptance 63.
- **다음 M3**: M3a preflight(stream-json/system·init snapshot/canary 격리) → M3b handoff trace(Hook→ToolTrace JSONL) → M3c shadcn read. MCP config 생성·전달·snapshot 강제가 여기서 배선(그 후 MCP profile fail-closed 해제 가능).

## 이전 (2026-07-17 세션 — V3 M0 + M1 + M2)

- **V3 M2 완료(Capability/ToolProfile 정책 계층)**: `src/tools/{capabilities,profiles,adapters,redact}.ts` + `src/providers/capabilities.ts`. 3계층 capability(repo_write_direct 분리), ToolBinding 4종(builtin 포함), ToolProfile(bindings 필드, exposedTools compile 파생), 수동 validator(의존성 0), compileToolProfile(4버킷), binding 기반 fail-fast(run 시작 전), redaction, `--bare` argv. registry=`planning-none`/`planning-local-readonly`만. `--tool-profile`·`--bare` CLI 플래그. golden snapshot 회귀. M1 무영향. 검증: exec 74 + core 37 + acceptance 63.
- **다음 M3**: handoff + shadcn read + stream-json 파싱(tool 이벤트 실 방출·trace 배선) + mcp-config write·claude 전달 + `system/init` snapshot 격리 실측.

## 이전 (2026-07-17 세션 — V3 M0 + M1)

- **V3 M1 완료(진행 이벤트 모델)**: `src/core/progress.ts`(RunEvent/ProgressReporter) — run_start/step_start/step_end/gate_jump/run_end + tool_*(타입 골격) + note{level}. runWorkflow가 모든 top-level step에 이벤트 방출(index 1-based, kind/round, 실제 jump만 gate_jump), try/finally로 예외에도 run_end{failed} 보장. RunState.step_timings 저장. 렌더러(`commands/progress.ts`) 이벤트 소비형 재작성(출력 계약 보존, gate/approval 스피너 없음). `src/tools/trace.ts` 범용 JSONL writer 골격(runWorkflow 미배선). 테스트: core 8 신규(`test:core`). 검증: exec 74 + core 8 + acceptance 63.
- **V3 M0 완료(문서 동기화)**: taskPrompt provider 수정, CLI 버전 package.json 단일 원본, CLAUDE.md 교정, SUPERSEDED→archive, HANDOFF v2.6 각주.
- **다음**: M2(Capability/Profile 기반) — 별도 승인 대기. M3에서 handoff+shadcn read+stream-json 파싱(여기서 tool 이벤트 실 방출·trace 배선). 활성 기준: `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`, `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md`.
- **후속 정리 항목**: README v1/v2.6 범위 서술 갱신, V3 문서의 exec/mission 실행 계층 미참조, package.json.files(M2에서 registry/schemas 추가).

## 최신 (2026-07-08 세션)

- **진행 표시자 추가**: run 중 TTY 스피너(`⠹ [2/5] research 실행 중… 0:42`)+경과시간, 비TTY는 `▶` 폴백. `src/commands/progress.ts` + `runWorkflow.ts`의 `ProgressReporter` 인터페이스. core는 TTY 무지 유지. 57/57.
- **실행 계층 설계 핸드오프**: 창업자 비전(문서→자동 실행→병행/다중 라이브 세션→라이브 분화, 큰 이슈만 예/아니요) vs 현재(문서 생성만) 갭·다음 스텝 정리 → `docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`. **설계는 별도 Fable 세션 예정.** (결정: docs/DECISIONS.md 2026-07-08)

## 현재 상태

- **하네스 v1 구현 완료.** acceptance Test 1~5 전부 통과 (`npm test` → 30 checks all pass).
- 5개 명령 동작: list / init / run / summary / task-prompt (mock provider 기반, 실제 LLM 미호출).
- 코드 구조:
  - `src/cli.ts` — commander 진입점
  - `src/core/` — paths, registry, project, runAgent, runWorkflow, validate, saveArtifact, summary, taskPrompt
  - `src/providers/` — provider 인터페이스 + mockProvider
  - `src/commands/` — 각 CLI 명령 래퍼
- `scripts/acceptance.sh` = 통합 검증 스위트 (`npm test`/`npm run acceptance`).
- git: origin = github.com/agrade1/solo-founder-harness, main 브랜치에 단계별 커밋/푸시.
- 비공개: `projects/idea-discovery/IDEA_*.md`는 .gitignore로 원격 제외.

## v2 진행 상황 (2026-07-06 착수)

- **provider 전략 C안 확정** (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md): mock/claude-code(B안,구독)/anthropic(A안,API) 3종 교체. 지금은 claude-code, A안은 나중.
- **[v2-1 완료] Provider 인터페이스 async화 + token usage 필드.** `generate()` → `Promise<AgentResult>`, run_state에 provider+usage 기록, `run --provider` 플래그.
- **[v2-2 완료] claude-code provider(B안).** `claude -p --output-format json` stdin 위임, usage 파싱. AgentRunInput에 ideaContent(00_IDEA.md) 추가. extractMainJudgment 문단형 대응 버그수정. dev-preflight end-to-end 검증 완료. mock acceptance 30/30 유지.
- 사용: `harness run <wf> --project <p> --provider claude-code` (claude CLI가 Max 구독 로그인 상태여야 함). 기본은 mock.
- **[v2-3 완료] 스키마 검증 재생성 루프.** 필수 헤더 누락 시 피드백해 재생성(`--max-regen <n>`, 기본 1). run_state.regenerations 기록.
- **[v2-4 완료] Red Team 비평 루프.** workflow steps를 `(string|{critique_loop})[]`로 확장. critic(red_team)이 Critical 리스크 발견 시 target(tech_lead)에 되먹여 revise→재검토, Critical 소멸/max_rounds까지. mvp-planning에 내장(`↻[red_team⟲tech_lead×2]`). run_state.critique_rounds 기록. mock+stub 검증, acceptance 30/30 유지.
- **[v2-6 완료] CEO 게이트 분기.** WorkflowStep에 `{gate}` 확장. decider(founder_ceo) 판정이 on 키와 맞으면 해당 agent로 되돌려 재실행(max_jumps로 무한루프 방지). full-predev에 내장(`⤴[founder_ceo?축소→pm,검증→research×1]`). run_state.gate_jumps 기록. mock+stub 검증.
- **[v2-5 완료] anthropic provider(A안).** @anthropic-ai/sdk 연동, 프롬프트 빌더를 promptParts.ts로 공유. ANTHROPIC_API_KEY 필요(종량과금). 키 없으면 안전 실패+claude-code 안내. 기본 provider는 mock 유지. **실제 유료 호출 미검증**.
- provider 3종(mock/claude-code/anthropic) + 루프 3종(재생성/비평/게이트) 완비.

- **[실전 검증 완료]** mvp-planning을 claude-code로 실제 실행 → 비평 루프 실작동 확인(red_team이 Critical 2건 발견→tech_lead 반영 수정→재검토→max_rounds 종료). 루프가 출력 개선함.
- **v2 완료 → v2.0.0 태그** (develop→main 병합).
- **[v2.1-A 완료] 라이브러리화.** 경로 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, projects). 서비스 레포마다 설치. v2.1.0 태그·푸시 완료.
- **[B-② 완료] 동적 분화(fanout).** planner(tech_lead)가 `SPAWN id=..|name=..|focus=..` 선언 → fanout이 파싱 → **기본 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 전문 에이전트 런타임 생성·실행(outputs/spawned/<id>.md). dev-preflight 내장. run_state.spawned_agents. v2.2.0 태그.
- **[B-③ 완료] 멀티에이전트 task-prompt.** spawned_agents 있으면 task-prompt에 "병렬 실행" 섹션(FE/BE별 담당·계획문서·통합·승인게이트) 생성. **하네스는 스펙 생성만, 실제 병렬 코딩은 Claude Code subagent(사람 승인 후).** stub 검증. **v2.3.0 태그**(develop→main 병합).
- **[Obsidian 완료] Obsidian 연동.** run 결과를 vault로 read-only export — agent별 노트(frontmatter + `[[wikilink]]` 이전/다음/인덱스) + run MOC 인덱스(실행 순서 링크 + 메타). `run --vault <path>` / `HARNESS_VAULT`, opt-in(미지정 시 무동작). `src/core/obsidianExport.ts`. acceptance Test 6 추가 → **35/35 통과**. (develop, 미태그 — v2.4.0 예정)

## v2.5 안정화 Phase 0 (2026-07-07, V3_KICKOFF 기반)

- v3 착수 조건 미충족 → v3 선결로 v2.5 Phase 0 먼저 구현(V3_KICKOFF.md 0-1~0-4). 각 항목 단위 커밋(develop).
- **[0-1] run --resume** — RunState status/failed_reason/resume_from/loop_state, 실패 지점부터 재개(완료 step은 산출물 복원, 재실행 X).
- **[0-2] token budget** — `--max-tokens`/`HARNESS_MAX_TOKENS`, 초과 시 중단→--resume, 80% 경고.
- **[0-3] approval gate** — `{approval}` step, 거부=user_rejected(재개 가능), `--yes` 비대화. dev-preflight 착수 승인 1곳.
- **[0-4] Red Team 편향 분리** — critic은 target 결론만 격리(contextMode=conclusion_only).
- mock `npm test` → **57/57 통과**.

## 현재 상태 요약 (한 줄)

provider 3종 + 루프 3종 + 분화 + 멀티에이전트 task-prompt + Obsidian + v2.5 안전장치(resume/budget/approval/편향분리) + ux_ui 디자인 레퍼런스 확장(v2.6.0)까지 완비. mock 기준 `npm test` 57/57. git: **main=v2.6.0**. public github 설치 지원(dist 커밋, `npm install github:agrade1/solo-founder-harness`). 실사용 개발 착수 1건 완료(audit-evidence-engine) → v3 게이트 충족.

## Phase 1 도그푸딩 완료 (2026-07-08)

- 실제 아이디어 A(증적엔진)/B(폐쇄망) full-predev(claude-code) 검증 — **CEO 게이트 두 분기(축소/검증) 실발화**.
- A로 dev-preflight(--allow-spawn --yes) → 하위 3개 실제 실행 + 승인게이트 + task-prompt 병렬 스펙 handoff.
- 하네스 self-review(mvp-planning) — critique_loop 2R + 0-4 편향분리 실전 검증.
- 실전 검증된 v2.5 경로: 게이트 두 분기·무한루프 가드·분화+allow-spawn·승인게이트·critique_loop·편향분리·토큰계측. 스키마 경고 0. (resume/budget만 실패상황 미재현, mock 검증됨.)
- 산출물: `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 `projects/dogfood-*` 로컬 전용.

## v3 진입 게이트 충족 (2026-07-08, 이 세션)

- **"실제 개발 착수 1건" 게이트 충족됨.** 별도 private 레포 `github.com/agrade1/audit-evidence-engine`(하네스 로컬 설치)에서 아이디어 A(증적엔진)를 full-predev(claude-code) 검증 → task-prompt → **실제 코드 착수 완주**(`scripts/collect_evidence.sh`: KISA U-코드 읽기전용 점검→증적 패키지. CEO 판정 경계 준수로 remediation/제품코드 없음). 아이디어 F(인프라교육)도 idea-validation로 추가 검증("추가 검증" 판정).
- → v3 착수 3조건(아이디어 2건 검증 + 1건 개발착수) **모두 충족.** 이제 v3는 "규율상 착수 가능" 상태.

## 다음 작업 (self-review 결론 반영)

- v3 게이트는 충족됐으나, self-review 처방대로 **바로 v3.0 코딩에 들어가지 않는다.** execute는 안전경계 시나리오("게이트 이후 실패 시 롤백 주체") 서면 뒤에만, report는 **관측성 통증이 실사용에서 수치로 확인된 뒤** 최소형. (FIELD_NOTES "자기검토 결론" 참고.)
- **관측성 통증 측정법**(v3 report 필요성 판단 기준): 하네스를 실서비스에 반복 사용하며 — ① run당 소요/토큰을 run_state에서 집계했을 때 "매번 파일 열어 확인"이 번거로운가, ② 프로젝트 여러 개의 최신 run 상태를 한눈에 못 봐서 불편한가, ③ 게이트 되돌림/실패 원인을 run_state.json 수동 파싱으로 찾는 빈도가 높은가. 이 통증이 실제로 쌓이면 그때 `harness report`(read-only 스냅샷 표)를 최소형으로.
- 하네스 자체는 현재 "충분히 좋다"(v2.5.0) — 다음 코딩은 하네스가 아니라 **실서비스(audit-evidence-engine 등)** 쪽에서 나온다.
- [보류] anthropic 유료 1회 실검증(비용), resume/budget 실패상황 재현 — 우선순위 낮음.
- 범위 확장 금지 유지. 하네스는 현재 "충분히 좋다"(v2.5.0).
