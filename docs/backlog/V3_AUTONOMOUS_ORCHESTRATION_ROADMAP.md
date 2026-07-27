# V3 자율 오케스트레이션 로드맵 — 기획 → 디자인 → 개발

작성일: 2026-07-26  
상태: **M3 완료 후 M3d~M10 활성 구현 기준**  
목적: 사람이 Codex와 Claude Code 사이에서 프롬프트·완료 보고·권한 요청을 수동으로 전달하지 않아도,
승인된 마일스톤 범위 안에서 하네스가 계획·구현·검토·수정·검증을 연속 실행하게 한다.

---

## 0-0. 현행 상태 (2026-07-27 — 이 블록이 최신이며 아래 dated 서술보다 우선한다)

- **M3는 완료다.** M3a/M3b/M3c core와 **실제 live acceptance까지 완료**됐고, M3d.2는 **PR #10으로
  `ea764a5`에 병합**됐다. **M3/M3d는 재개방하지 않는다.**
- **`B-1`(부하/stress 재실행) · `B-2`(live runner 재실행·evidence 재생성)는 nonblocking
  release-readiness backlog다.** M3 완료 게이트가 **아니고** M4 작업의 선행 조건도 **아니다**.
  §1·§10 M3d 안의 "차단 게이트 / M3d 완료 전 필수 / pending" 서술은 **2026-07-26 시점의 기록**이며
  현행 판정이 아니다(원문은 이력으로 보존한다).
- **M4a는 완료**(state-only/offline durable orchestration kernel — §10 M4 → M4a 참조),
  **M4b도 구현·offline 검증 완료**(배타 자원 class + deterministic scheduler + run writer lock —
  §10 M4 → M4b 참조 · 대장 `B-3`/`B-4` fixed), **M4c도 구현·offline 검증 완료**(§5.1 메시지 10종 ·
  중앙 경유 sibling/reviewer 라우팅 · §8 milestone approval manifest · 7 specialist registry —
  §10 M4 → M4c 참조 · 대장 `C-6` fixed). **이로써 M4 전체가 완료다.**
  Codex 독립 리뷰의 **P0 2건은 2026-07-27에 수정 완료**했고 **M4 범위에 열린 P0는 없다**
  (M5a는 별도 리뷰를 받았다 — 아래 M5 항목).
- **M5는 여전히 미완료다.** 다만 **2026-07-27에 사용자가 M5a 범위를 승인해 구현·offline 검증을 마쳤고,
  같은 날 fresh Codex 독립 리뷰(REVISE)의 A 항목 9건을 리비전으로 닫았다**
  (실행 경계 + `CodexCliProvider` + JSONL 어댑터 + fake 테스트 — §10 M5 → M5a). **M5a가 아닌 것**:
  autopilot CLI · Claude↔Codex 자동 전달 · 실제 7-agent 동시 실행 · **live acceptance**.
  이 문서 아래쪽의 "M5 not started" 표기는 M5a 승인 이전 기록이다.
  열린 B(P1)는 `B-7`(live 인증·secret redaction) · `B-8`(reviewer 결과 게이트) · `B-9`(JSONL live 확인)이며
  **셋 다 live/배선 착수만 막고 offline 작업은 막지 않는다.**
- 현재 기준 커밋: M4a 기준은 `ea764a54108f1715248f3e0ae414ea87eb8ffaa9`.
  **세 마일스톤은 각각 로컬 커밋이 있는 분리된 stacked 브랜치다**(원격 push/PR/merge는 0):
  - `work/m4a-durable-orchestration` — `55d99a3`(feat) + `805da35`(docs)
  - `work/m4b-resource-scheduler`(base `805da35`) — `11775fd`(feat) + `ab63eac`(docs)
  - `work/m4c-routing-approval`(base `ab63eac`) — `3cfdb39`(feat) + `c963cb0`(docs)
  **M4c 최종 HEAD = `c963cb0832d66a58fefdaa2025a9213966c3cc27`.** 원본 checkout은 `bbb8b72`로 clean·무수정.
  이 문서 아래쪽의 "미커밋 working tree / 아직 commit·push·PR 없음" 표기는 **각 구현 세션 시점의 기록**이며
  현행 사실이 아니다(현행: 로컬 커밋 있음 · 원격 push/PR/merge 없음).
- 현행 offline 테스트 범위 라벨: **파일 단독** `src/exec/orchestrationKernel.test.ts` **67/67**
  (M4a 37 → M4b 50 → M4c 67), **`npm run test:exec` 전체 suite 142/142**(125 → 142),
  core **374/374**, acceptance **92/92**. **142/142를 "파일 단독 focused"로 적지 않는다.**

## 0. 문서 우선순위와 기존 설계의 처리

M3d 이후 충돌 시 우선순위는 다음과 같다.

1. 이 문서 — M3d~M10 순서, 중앙 오케스트레이션, agent 통신, fresh-session, 모델 라우팅
2. `V3_MCP_CAPABILITY_TOOL_PROFILES.md` — Capability/ToolProfile/MCP 보안 계약
3. `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` — 진행 이벤트, handoff, 학습·report 배경 계약

기존 두 문서의 M0~M3 설계와 이미 구현된 보안 계약은 유지한다. 기존 문서에 적힌 M4~M7
순서는 이 문서가 대체한다. 기존 M5~M7의 stack별 도구·preview·provider parity 후보는 M10 이후
선택적 확장으로 이동한다.

## 1. 검증된 출발점

> **이 절은 2026-07-26 시점의 스냅샷이다(원문 보존).** 현행 상태는 위 §0-0을 본다 —
> M3는 완료이고 `B-1`/`B-2`는 nonblocking release-readiness backlog다. 아래의 HEAD·"미충족"·
> "차단 게이트" 표기는 당시 기록이며 지금의 판정이 아니다.

- 브랜치/HEAD: `develop` / `af0552e5ba98100b7ae5970b0cb44224e3469c74`.
- 로컬 `origin/develop`도 동일 커밋이다(remote-tracking reflog: 2026-07-26 13:48:21 +0900 push로 갱신).
- **working tree는 clean이 아니다(2026-07-26 M3d.1 이후 관찰).** 의도적으로 커밋하지 않은 상태로 둔 것이며,
  선행 docs-only 로드맵 편집 + M3d.1 구현 2파일(`scripts/m3c2-live-read-semantics.mjs`,
  `src/tools/shadcnReadSemanticsProbe.test.ts`)이 dirty하고 이 로드맵 문서 자체는 아직 untracked다.
  M3d.1 작업은 commit/fetch/push를 수행하지 않았다.
- Claude Code 관찰 버전: `2.1.220`.
- Codex CLI 현재 설치: `0.146.0-alpha.3`; `codex exec`의 `--json`, `--output-schema`,
  `--ephemeral`, `--sandbox`, `--model`, config override를 로컬 help에서 확인.
- 사용자 실행 M3a/M3b.2/M3c-3b live runner: PASS 보고. runner가 임시 산출물을 정리하므로
  이 보고만으로는 저장소에서 사후 재검증할 수 없다. 이후 live 증거 영속화는 남은 M3d 범위에서 다룬다.
- **현재 테스트 기준(M3d.2 **여덟 번째** 리비전 후, 격리 실행)**: `npm test` **연속 3회 PASS(직렬, 겹침 없음)** =
  exec **75/75** + core **374/374** + acceptance **71/71**(core는 호출부 감사 테스트가 늘어 366 → 369 → **374**).
  focused `suiteExclusiveLock.test.ts` **75/75**, `liveEvidence.test.ts` **24/24**.
  **부하 조건 stress acceptance는 여전히 미충족이며, 이것은 M3d 완료를 막는 차단 게이트다(비차단 위험이 아니다)** —
  마지막 실측은 **여섯 번째 리비전 세션의 FAIL(exit 1)**
  이고, 일곱·여덟 번째 리비전 세션에서는 **재실행하지 않았다**(두 리비전 다 production 코드를 바꾸지 않았고 같은
  호스트 부하 조건이 유지되어 재실행이 새 정보를 주지 않으므로 사용자 지시로 생략). 그 FAIL 기록: 일반 suite 3회 뒤 1회 실행 결과 `npmTestExitCode:1`,
  elapsed **264.0s**(진단 재실행 1회도 동일, 302.0s)이며, 부하 중 실패한 테스트는
  **그 리비전이 수정하지 않은 2건**(`src/tools/preflight.test.ts` "[M3a] extra canary tool 실패",
  `src/tools/shadcnPilot.test.ts` "[M3c-0] discovery 성공(generic fixture)")으로 둘 다 **고정 5000ms child startup
  deadline** 초과다(core 364/366). 호스트가 외부 앱으로 이미 포화였다(10 CPU · load average 8.76/11.10/8.50 ·
  Chrome 57% · WindowServer 42%). 같은 두 파일은 부하 없이 40/40 PASS이고 lock 계층은 두 실행 모두 정상이었다
  (`cleanupConfirmed:true`, `cleanupProblems:0`, `lockReleased:true`, `lockQuarantined:false`, worker 4/4 생존, 잔재 0).
  → **부하 acceptance는 아직 미충족**이며, 조용한 호스트 재실행 또는 별도 승인 하의 5초 deadline 부하 내성 개선이
  필요하다(테스트 완화·production 타임아웃 임의 변경은 하지 않았다).
  (이전 리비전 기록: 다섯 번째 리비전 시점에는 같은 stress가 elapsed 109.8s로 **PASS**했다 — 훨씬 한가한 호스트였다.)
  live acceptance 3종은 아직 미실행(pending)이며 `docs/evidence/m3d2`는 첫 성공 실행 시 생성된다.
  **리뷰 이력: fresh Codex Sol xhigh REQUEST_CHANGES 8회(리비전 1~8에 각 1회) + 진행 승인
  `APPROVE_FEATURE_PROGRESSION` 1회(여덟 번째 리비전 재검토 결과).**
  이 진행 승인은 **M3d 완료 APPROVE가 아니다** — "여덟 번째 리비전 diff에 지금 차단할 항목(Category A)이 없으니
  기능 진행을 계속해도 된다"는 판정일 뿐이고, 기존 완료 게이트는 전부 그대로 살아 있다.
  **M3d는 여전히 미완료**(부하 acceptance 미충족 = 차단 · live runner 3종과 evidence 3건 pending)이고
  **M4 구현은 not started**이며 별도의 사용자 마일스톤 승인이 필요하다.
  이 판정을 "M3d APPROVE"로 줄여 적지 않는다.
- **suite 직렬화 계약(M3d.2 세 번째~여덟 번째 리비전 — lock format v2)**: 일반 `npm test`와 stress는 **같은 배타 lock 하나**를
  지난다(`scripts/lib/suite-exclusive-lock.mjs` + `scripts/suite-lock.mjs`). `npm test` = lock wrapper → `test:inner`
  (= exec → core → acceptance, 순서·카운트·exit 의미 불변). stress가 띄운 자기 소유 `npm test` child만
  추측 불가능한 ownership token(hash만 디스크 기록)으로 재진입한다.
  · **모든 상태 전이는 crash-persistent `<lock>.guard` 안에서만** 일어난다(acquire/release/quarantine/reentry).
    guard 안에서 **tokenHash → 격리 표시 → inode 신원**을 재확인한 뒤에만 파일을 만들거나 지우거나 덮으며,
    다른 guard는 blind unlink하지 않는다(제거는 자기 nonce+inode 확인 후에만).
  · **fail closed**: 전이 메커니즘 실패(quarantine write 실패 등)와 전이 중 SIGKILL은 **guard를 남겨** 이후 모든
    acquire를 거부한다(수동 제거). 아무것도 바꾸지 않은 계약상 거부만 guard를 정상 반납한다.
  · **정리 확인 실패는 lock을 노출하지 않는다**: 해제 대신 `quarantined:true`로 격리하고 즉시 종료한다.
    격리된 lock은 소유자가 죽어도 이어받을 수 없으며 사람이 확인 후 수동 제거해야 풀린다.
  · **stale/orphan 자동 회수는 없다.** 소유자가 죽은 lock은 `lock_orphaned`로 항상 거부한다(죽음 ≠ 정리 완료).
    lock 파일이 없어도 guard가 있으면 acquire는 우회 publish하지 않는다.
    (두 번째 리비전의 `.recovery` mutex·stale rename 회수·회수 inode CAS는 **폐기·삭제**되었다.)
  · **종료 경로는 단일 비동기 idempotent bounded 상태 기계 하나**다(normal / spawn error / SIGINT / SIGTERM /
    반복 시그널 / escalation 공용). 소유 그룹·소유 pgid 자손 소멸을 확인한 **뒤에만** 해제하고,
    **시그널 exit 의미 130/143은 확인 결과와 무관하게 유지**한다.
  · **중첩 그룹**: standalone wrapper만 detached로 자기 그룹을 만들어 직접 확인한다. **재진입(nested) wrapper는
    그룹을 만들지 않아 전 자손이 상위 stress pgid에 남는다.** 상위 timeout도 즉시 KILL이 아니라
    **TERM → 8s 유예 → 확인 → KILL**이며 하위 shutdown 예산(1.2s + 3s)보다 짧지 않다.
  · lock 파일은 비공개 임시 파일 → `link()` 발행이라 부분 write가 최종 경로에 남지 않는다.
  · **(네 번째 리비전)** 발행은 임시 파일 fd `fstat` → link → 최종 경로 `lstat` **신원 일치**까지 확인해야 성공이며,
    `published:true`의 dev/ino는 non-null 불변식이라 inode 검증이 생략되는 경로가 없다. 전이 실패는
    `refusal`(상태 변경 없음 → guard 반납) / `mechanism`(**기본값** → guard 유지) 두 분류로 명시하고,
    lock·guard unlink 실패와 격리 write/close/rename 실패는 전부 fail closed다.
  · **(다섯 번째 리비전)** 파괴적 syscall 직전에 **한 번 더** 확인한다: guard 제거는 "확인 → 지점 →
    record+inode 재확인 → 최종 경로 `lstat`" 뒤에만, 격리 rename은 "temp close → 기본 record+inode 재확인" 뒤에만
    진행하며 그 사이 교체된 남의 guard/lock은 **보존**한다. guard 반납 실패는 `lock_guard_release_failed`로 올려
    **acquire/reentry가 성공 handle을 돌려주지 않는다**. 임시 파일 정리도 신원 일치 시에만 하고 정리 실패는
    `lock_publish_cleanup_failed`로 올린다. 재진입은 그 시점의 **기본 record + dev/ino**를 `base`로 돌려주고
    cleanup 격리까지 명시 전달하므로 **tokenHash만으로는 소유권을 인정하지 않는다**.
    한계: Node 18에 `unlinkat`·compare-and-unlink가 없어 "마지막 확인 → unlink/rename" 창은 0이 아니다
    (창 최소화 + 사후 탐지 + fail closed).
  · **(여섯 번째 리비전)** lock·guard **읽기 open은 `O_RDONLY|O_NOFOLLOW`뿐**이다: 최종 엔트리가 symlink면
    `lock_path_symlink`, `O_NOFOLLOW` 미지원 플랫폼은 `lock_nofollow_unsupported`로 거부하고 **엔트리도 대상 파일도
    지우거나 덮지 않는다**. 그렇지 않으면 "원본을 옮기고 그 자리에 symlink"에서 신원 검사 대상(옮겨진 원본)과
    파괴적 조작 대상(symlink 엔트리)이 달라져 release가 symlink만 지우고 해제 성공을 보고하거나 quarantine이
    남의 엔트리를 rename으로 덮을 수 있다.
  · **(여섯 번째 리비전)** **성공 상태는 전이 완결 뒤에만 공표한다**: `release()`/`quarantine()`의 전이 콜백은
    결과만 값으로 돌려주고 `handle.state`는 `withTransitionGuard`가 정상 반환한 뒤에만 바뀐다. lock unlink **뒤**
    guard 정리/교체/unlink가 실패하면 `state="failed"` · `released=false` · problems 보고 · guard 잔존이며,
    소비자(wrapper·stress)도 `lockReleased:true`로 보고하지 않고 "해제가 완결되지 않았습니다(state=…)"를 남긴다.
    acquire·reentry는 이미 guard 반납 뒤에 결과를 만든다(재감사만 함).
- **테스트 주입 계약(세 번째~여덟 번째 리비전)**: production 코드는 lock 경로·`ps` fixture·pause/injection·evidence 디렉터리를
  `process.env`에서 **읽지 않는다**(`HARNESS_LIVE_EVIDENCE_DIR` 폐기). 주입은 상속되지 않는 argv
  `--fixture-config <절대경로 .json>` 하나뿐이며(`scripts/lib/fixture-config.mjs`) 크기 8KiB·일반 파일·symlink 금지·
  절대경로·allowlist key·타입/범위/enum을 엄격 검증한다. 임의 명령 실행 seam은 없다.
  `HARNESS_SUITE_LOCK_TOKEN`은 테스트 seam이 아니라 실제 부모→자식 ownership handoff라 유지한다.
  **(네 번째 리비전)** 로더는 경로를 **1회만** 열고(`O_NOFOLLOW`) `fstat`·읽기를 같은 fd에서 처리해 검사–사용
  경합을 없앴으며, 상한은 실제 읽은 바이트로 판정한다. 소비자별 allowlist는 **자기가 해석하는 key만** 담고
  (stress → child에게는 최소 설정만 별도 파일로 전달) 그 밖의 key는 `fixture_unknown_key`로 거부한다.
  **(다섯 번째 리비전)** fd `closeSync` 실패는 무시하지 않고 `fixture_close_failed`로 거부한다. 그 경로를
  결정론적으로 검증하기 위한 주입은 `loadFixtureConfig`의 **세 번째 인자(in-process io seam, fs 함수 4개)** 뿐이며
  **production 진입점은 인자 2개로만 호출**하므로 argv·env·설정 파일 내용으로는 도달할 수 없다 — 위
  "**외부** 주입은 argv 하나뿐" 계약은 그대로다.
  **(여섯 번째 리비전)** 그 회귀는 이제 **production 호출부 전수**를 덮는다: `scripts` 아래를 스캔해 호출부를
  발견하고 기대 5개(`suite-lock.mjs`, `m3d2-stress-acceptance.mjs`, `m3a-live-preflight.mjs`,
  `m3b2-live-handoff.mjs`, `m3c3b-live-handoff.mjs`)와 목록 일치를 확인한 뒤, 각 호출의 **최상위 인자 2개**와
  첫 인자 `process.argv.slice(2)`를 고정한다(새 호출부가 생기면 목록 비교가 먼저 깨진다).
  **(일곱 번째 리비전)** 그 발견은 **구문 인식·재귀 감사**로 바뀌었다(테스트 전용, 의존성 변경 없음):
  `scripts` 아래 **모든 깊이**의 일반 `.mjs`를 재귀 열거하고(symlink 파일·디렉터리는 신뢰하지 않고 따라가지 않으며
  건너뛴 목록을 보고), TypeScript AST로 **`scripts/lib/fixture-config.mjs`에서 온 바인딩**(별칭 `as`·namespace
  import 포함)을 추적해 그 바인딩을 통한 호출만 검사한다. 식별자와 `(` 사이의 공백·주석도 호출로 인식하고,
  문자열·주석 안의 이름은 호출로 세지 않는다. 각 호출은 **인자 정확히 2개** + 첫 인자가 구조적으로
  `process.argv.slice(2)`여야 하며, import했지만 호출하지 않는 바인딩·다중 호출·동적 로딩(`import()`/`require()`)·
  재수출·비호출 참조는 모두 **문제로 보고**한다(조용히 넘기지 않는다).
  **(여덟 번째 리비전)** 그 감사가 **URL 인식 · 동적 route 인식 · 노출 인식 · scope 인식**까지 넓어졌다:
  ⓐ 지정자는 **URL 문법 순서로**(첫 `#` 뒤 fragment → 첫 `?` 뒤 query → 남은 path `decodeURIComponent`) 정규화해
  비교하고, 디코드 불가(`%zz`)·인코딩된 경로 구분자(`%2F`)는 **판정 불가 = fail closed**로 보고한다.
  ⓑ 동적 `import()`/`require()` 지정자는 bounded하게 접고(리터럴·치환 없는 template·`+` 연결·정확히 한 번 선언된
  `const` 문자열, 재귀 상한 8), 접히지 않으면 **도달 가능한 문자열 조각** 규칙을 적용한다 —
  조각 0개 → fail closed 보고 / 로더 token(`fixture-config`) 포함 또는 정규화 불가 → 로더 동적 로딩 보고 /
  그 밖 → `safe`. `safe` 분기는 live runner 3종의 **정상** 빌드 산출물 동적 import를 깨지 않기 위한
  **명시적 bounded 규칙**이며 whole-program 증명이 아니다(실제 repo의 정상 동적 import 3파일이 호출부 목록에
  들어오지 않음을 대조군 단정으로 고정).
  ⓒ 재수출은 직접 `export … from`뿐 아니라 **import-then-export**(`export {X}`·`export {X as Y}`·`export default X`·
  namespace 파생 노출·`export * as`)까지 잡으며, 수집이 **두 패스**라 소스 순서(ESM hoisting)로 우회할 수 없다.
  ⓓ 선언 sweep(`var`/`let`/`const`·구조 분해·파라미터·function/class 이름·import 바인딩·`catch`)으로
  **전역 `process`나 추적 중인 direct/namespace 바인딩을 가릴 수 있는 선언이 하나라도 있으면 감사를 실패**시킨다
  (conservative fail closed). shadow된 식별자는 **import 사용으로 인정하지 않고**, `process` shadow가 있으면 구조가
  맞아도 첫 인자를 정규형으로 보지 않는다. namespace도 direct와 **같은 미사용 검사**를 받는다.
  ⓔ **파싱 진단이 있으면**(부분 파싱) "import를 못 찾았다"를 안전의 근거로 쓰지 않고 fail closed로 보고한다.
- **이전 테스트 기준(M3d.1 최종 리비전 후, 격리 실행)**:
  - `npm run build` PASS, `git diff --check` clean, NUL 바이트 0.
  - 격리 `npm test` PASS = exec 75/75 + core **275/275** + acceptance 71/71.
  - `npm run test:core` 275/275 PASS. 안정화 대상 파일 단독 18/18 PASS 2회.
- 과거 기록(대체됨): 2026-07-26 초기 Codex 재검증은 core 전체 부하에서 M3c-2 runner smoke flake로 272/273,
  해당 파일 단독 16/16이었다. 이 flake는 M3d.1에서 테스트 완화 없이 해소했다.
- **동시성 제약(실측)**: 겹친 검증 1회가 fresh 리뷰어와 메인 스위트의 전역 m3c2 temp/process 상태 동시 관찰로
  실패했고 격리 재실행은 PASS였다. 전역 상태를 관찰하는 테스트는 격리 실행이 전제다(§10 M4/M5 요건 참조).

## 2. 목표와 완료 정의

사용자는 아이디어와 마일스톤 승인 범위만 제공한다. 그 뒤 하네스가 다음을 수행한다.

```text
아이디어
→ 기획/리서치/PRD
→ UX/디자인 시스템/시안
→ 기술 계획/태스크 그래프
→ Claude Code Opus 구현
→ fresh Codex 검토·비평
→ fresh Claude Code Opus 수정
→ fresh Codex 재검증
→ 로컬 통합 테스트·결과 보고
→ 다음 마일스톤 제안
```

M9에서 기능적으로 end-to-end가 연결된다. M10에서 복구·예산·실전 도그푸딩을 통과해야
"1인 창업 기획→디자인→개발 하네스" 완료로 판정한다.

## 3. 핵심 원칙

### 3.1 중앙 LLM 세션은 시스템 오브 레코드가 아니다

긴 중앙 세션에 작업 원문·로그·대화를 계속 쌓지 않는다. 중앙 제어는 결정론적 TypeScript
오케스트레이터가 담당하고, LLM Coordinator는 필요할 때 fresh하게 생성되는 판단자다.

```text
Deterministic Orchestrator Kernel
├─ Task DAG / 상태 / 의존성 / 예산 / 승인 범위
├─ append-only event log
├─ artifact·message index + hash
├─ fresh Coordinator 호출
├─ fresh Specialist/Worker 호출
└─ fresh Reviewer 호출
```

Coordinator가 교체되어도 디스크 상태에서 동일한 다음 행동을 계산할 수 있어야 한다.

### 3.2 중앙은 원문이 아니라 포인터를 운반한다

Coordinator 입력은 아래로 제한한다.

- 현재 milestone과 승인 manifest
- ready/blocked/running task 목록과 의존성
- 미해결 blocker·결정·위험의 bounded summary
- artifact path, revision, SHA-256, 생성 agent
- 다음 판단에 필요한 계약 문서의 지정 section

raw transcript, 전체 테스트 로그, 전체 하위 agent 대화는 전달하지 않는다. 필요할 때 artifact를
직접 읽고, summary에는 반드시 source artifact reference를 붙인다.

### 3.3 fresh-session 기본값

- 각 task attempt는 새 세션이다.
- 각 review/critique/verification은 저자와 분리된 새 read-only 세션이다.
- reviewer에게 저자 transcript나 저자의 자기평가를 주지 않는다.
- revise는 기본적으로 새 구현 세션에 원 task + 현재 artifact/diff + review findings만 제공한다.
- 같은 세션 resume은 동일 atomic attempt의 일시적 중단·rate-limit·승인 복귀에만 허용한다.
- Coordinator도 wave/phase 경계 또는 context budget 도달 시 교체한다.

### 3.4 직접 agent-to-agent 상태 변경 금지

agent는 다른 agent의 상태·의존성·완료 여부를 직접 변경하지 않는다. 모든 메시지와 상태 전이는
오케스트레이터가 schema·권한·의존성을 검증한 뒤 반영한다.

## 4. 시스템 오브 레코드와 저장 구조

Markdown이 판단·설계·결과의 원본이라는 기존 원칙을 유지한다. JSON은 실행 상태와 index다.

```text
projects/<p>/docs/*.md                         # 제품 판단·설계 원본
projects/<p>/outputs/run_state.json            # project workflow 실행 상태
outputs/orchestration/<run-id>/run_state.json  # self-dev/mission 실행 상태
outputs/orchestration/<run-id>/events.jsonl    # append-only 감사·재생 이력
outputs/orchestration/<run-id>/messages/*.md   # 검증된 agent 메시지 body
outputs/orchestration/<run-id>/artifacts/      # 전달 산출물 또는 포인터 index
outputs/orchestration/<run-id>/snapshot.md     # 상태에서 결정론적으로 재생성한 bounded brief
```

- `snapshot.md`는 원본이 아니라 파생물이며 언제든 state+artifact index에서 다시 만든다.
- event log는 상태를 대신하지 않는다. replay/감사/장애 분석용이다.
- artifact는 revision과 SHA-256을 기록하고 조용히 덮어쓰지 않는다.
- 기존 산출물을 대체할 때는 `supersedes` 관계를 남긴다.

## 5. Agent Message Contract

### 5.1 공통 envelope

모든 agent 메시지는 machine-readable envelope와 human-readable Markdown body로 구성한다.

```ts
interface AgentMessageEnvelope {
  schemaVersion: "1";
  messageId: string;
  runId: string;
  milestoneId: string;
  taskId: string;
  parentTaskId: string | null;
  sender: string;
  recipient: string;
  type:
    | "task_assignment"
    | "spawn_request"
    | "status_update"
    | "result"
    | "review_request"
    | "review_result"
    | "revision_request"
    | "blocker"
    | "decision_request"
    | "decision";
  createdAt: string;
  dependsOn: string[];
  artifactRefs: Array<{
    path: string;
    sha256: string;
    revision: number;
    role: "input" | "contract" | "output" | "evidence" | "diff" | "test";
  }>;
  supersedes: string | null;
}
```

envelope는 JSON schema와 runtime validator 양쪽에서 검사한다. Markdown frontmatter만 신뢰하지
않는다. 필수 필드·artifact·hash가 틀리면 전달하지 않고 fail-closed한다.

### 5.2 메시지별 Markdown body

하나의 거대한 공통 템플릿 대신 type별 필수 section을 둔다.

#### `task_assignment`

```markdown
## Objective
## Scope / Ownership
## Out of Scope / Forbidden
## Inputs and Contracts
## Dependencies
## Definition of Done
## Budget and Permission Envelope
## Expected Deliverables
```

#### `spawn_request`

```markdown
## Why Split Is Needed
## Requested Specialty
## Child Scope
## Required Inputs
## Expected Deliverables
## Dependency and Budget Impact
```

#### `result`

```markdown
## Result Summary
## Work Performed
## Decisions and Assumptions
## Deliverables
## Tests and Evidence
## Risks / Known Limitations
## Unresolved Questions
## Recommended Next Action
```

#### `review_result`

```markdown
## Reviewed Revision and Hash
## Findings (P0/P1/P2)
## Reproduction or Evidence
## Missing Tests
## Contract Deviations
## Verdict: pass | revise | block
```

#### `blocker` / `decision_request`

```markdown
## Blocking Condition
## Evidence
## Options and Trade-offs
## Required Authority
## Safe Default While Waiting
```

### 5.3 통신 경로

```text
Specialist → spawn_request → Orchestrator → Child 생성
Child → result/blocker → Orchestrator → Parent 전달
Child → sibling 전달 요청 → Orchestrator → dependency/ownership 검사 → Recipient
Worker → result → Orchestrator → fresh Reviewer
Reviewer → review_result → Orchestrator → fresh Revision Worker
Orchestrator → consolidated gate → Human
```

직접 sibling mailbox 쓰기, 상대 agent state 수정, transcript 전달은 금지한다.

## 6. Agent topology와 모델 라우팅

중앙 오케스트레이터는 agent 수에 포함하지 않는다. 기본 상위 specialist는 약 7개다.

1. Research & Venture Strategy
2. Product / PM
3. UX Architecture
4. Visual Design & Design System
5. Tech Lead / Architecture
6. Development Lead
7. QA / Security / Red Team

Founder 판단은 최종 사람 승인 게이트다. `founder_ceo` 모델 출력은 조언·요약이며 사람 권한을
대체하지 않는다. specialist는 범위가 커지면 `spawn_request`만 제출하고 직접 child를 만들지 않는다.

기본 모델 정책:

| 작업 | 실행 주체 | 기본 권한 |
|---|---|---|
| 코드 구현·수정·테스트 | Claude Code Opus fresh session | 승인 manifest 안의 worktree write |
| 코드/설계 비평·독립 검증 | Codex `gpt-5.6-sol`, `xhigh`, fresh session | read-only |
| 큰 범위 계획·로드맵·문서 비평 | Codex `gpt-5.6-sol`, `xhigh`, fresh session | read-only, structured result |
| 상태 전이·hash·schema·gate | TypeScript kernel | LLM 없음 |

모델 이름은 registry/profile에서 관리하고 코드에 산재시키지 않는다. 버전·CLI 변화 시 live acceptance를
재실행한다.

## 7. Codex ↔ Claude Code 자동 연결

### 7.1 Provider 경계

기존 실행 계층 `ExecutionProvider`를 확장해 아래 adapter를 둔다.

- `ClaudeCliProvider`: 구현 worker. 기존 stream-json/session/worktree 경계를 재사용.
- `CodexCliProvider`: planner/reviewer/document critic. `codex exec`의 JSONL과 output schema를
  좁게 파싱하며 raw transcript를 SoR로 저장하지 않는다.

Codex review 기본 실행 계약 후보:

```text
codex exec
  --model gpt-5.6-sol
  --config model_reasoning_effort="xhigh"
  --sandbox read-only
  --ephemeral
  --json
  --output-schema <review-result.schema.json>
  --cd <worktree-or-repo>
```

정확 argv·event schema·인증·종료 계약은 M5 discovery와 live acceptance에서 고정한다. 현재 help에
플래그가 있다는 사실만으로 통합 완료로 판정하지 않는다.

### 7.2 자동 실행 loop

```text
1. Active roadmap에서 다음 milestone 읽기
2. fresh Codex Planner → task graph + approval manifest 제안
3. Orchestrator validator → scope/permission/dependency 검증
4. 사람의 milestone 1회 승인
5. fresh Claude Code Opus worker들을 worktree에서 실행
6. deterministic tests/gates
7. fresh Codex Reviewer → structured findings
8. revise면 fresh Claude worker → 재테스트
9. fresh Codex Verifier → final verdict
10. 로컬 develop 병합 + 문서/status 갱신
11. 다음 milestone proposal에서 다시 승인
```

M5 완료 이후에는 사람이 프롬프트와 완료 보고를 복사하지 않는다. 하네스가 message contract와
artifact pointer로 자동 전달한다.

### 7.3 self-hosting bootstrap

하네스가 자기 코드를 수정하는 동안 실행 중인 controller binary를 교체하지 않는다.

- controller는 시작 시 검증된 base commit/dist에서 실행한다.
- worker는 별도 worktree/branch만 수정한다.
- gate·review 통과 후 로컬 develop에 직렬 병합한다.
- milestone 종료 시 controller를 중지하고 새 develop에서 build 후 재시작한다.
- 실행 중인 controller가 자기 source/dist를 hot reload하여 판정 계약을 바꾸지 못하게 한다.

M4와 M5 자체는 bridge가 아직 없으므로 기존 수동 handoff로 bootstrap한다. M5 live acceptance 이후
M6부터 새 autopilot 경로를 사용한다.

## 8. 승인과 권한 피로 줄이기

"모든 권한 상시 허용" 대신 milestone별 1회 승인 envelope를 사용한다.

```ts
interface MilestoneApprovalManifest {
  milestoneId: string;
  approvedCommit: string;
  writableRoots: string[];
  ownershipByTask: Record<string, string[]>;
  allowedCommands: string[];
  allowedDependencies: Array<{ name: string; version: string }>;
  allowedNetworkDomains: string[];
  maxSessions: number;
  maxTokens?: number;
  maxElapsedMs: number;
  localMergeAllowed: boolean;
  expiresAt: string;
}
```

- manifest 범위 안의 반복 파일 수정·테스트·로컬 worktree 작업은 자동 진행한다.
- 범위 밖 경로, 신규 dependency, 새 domain, 예산 증액, 계약 변경은 pause하고 단일 consolidated
  approval request로 올린다.
- Codex auto-review를 쓸 수 있어도 sandbox/승인 경계를 확대하는 수단으로 해석하지 않는다.
- production deploy, live billing, remote repository direct write, PR merge, MCP `@latest`는 계속 hard deny다.

## 9. 로드맵 자동 보완 규칙

Codex는 더 나은 방향을 발견하면 `roadmap_change_proposal`을 만들 수 있다. 단 active roadmap을
무제한 자기수정하지 않는다.

현재 승인 범위 안에서 자동 허용:

- task 순서 최적화(의존성 보존)
- read-only 조사 추가
- 테스트·검증 강화
- 위험·가정·실측 기록 추가
- 문구 명확화와 상태 동기화

사람 재승인 필요:

- milestone 목표/비범위 변경
- 신규 런타임 dependency 또는 provider
- 권한·network·비용 범위 확대
- 테스트 완화·삭제
- hard deny 변경
- 다음 milestone을 건너뛰거나 여러 milestone을 한 번에 구현

proposal은 기존 roadmap을 덮어쓰지 않고 diff, 근거, 영향 파일, 비용/권한 변화를 함께 제시한다.

### 9.1 리뷰 findings 분류와 유예 대장 (배송 우선 — 2026-07-26 사용자 승인 정책)

**기능 배송이 무한 디테일 하드닝보다 우선한다.** 리뷰가 낸 모든 finding은 분류 없이 남겨두지 않고
아래 셋 중 하나로 **반드시** 분류한다. 분류 자체는 리뷰어가 제안하고 사람이 확정한다.

| 분류 | 정의 | 처리 |
|---|---|---|
| **A — blocking now** | P0/P1 · 데이터 손실 · 승인/인증/상태 전이 우회 · 되돌리기 어려운 아키텍처 결정 · **유예 비용이 커서 후속 작업이 안전하지 않거나 폐기 대상이 되는** 항목 | 즉시 수정. 진행 차단 |
| **B — 지정 마일스톤/트리거 전 필수** | 지금 막지는 않지만 특정 시점 전에 반드시 닫아야 하는 항목 | **명시적 기한(마일스톤 또는 트리거)** 을 붙일 때만 유예 허용 |
| **C — 개선 backlog** | bounded P2/P3 완전성 · 문서 정밀도 · 낮은 확률의 edge case · micro-optimization | 대장에 등록하고 진행한다. **C만으로는 리비전 루프를 다시 돌리거나 기능 진행을 멈추지 않는다** |

우선순위는 **심각도 단독이 아니라 "유예 비용(cost of deferral) 대 수정 공수(fix effort)"** 로 정한다.
심각도가 높아도 확률·영향 반경이 작고 유예 비용이 낮으면 C로 갈 수 있고, 심각도가 낮아도 지금 안 고치면
후속 산출물을 통째로 다시 만들어야 하면 A다.

**유예한 finding은 하나도 조용히 버리지 않는다.** 각 항목은 아래 필드를 전부 유지한다.

```text
id / 제목
분류(A|B|C) · 심각도(P0..P3)
발생 확률(likelihood)
영향 반경(blast radius)
유예 시 미래 비용(deferral / rework cost)
수정 공수(fix effort)
기한 또는 트리거(deadline / trigger)     ← B는 필수
담당(owner)
증거·산출물 참조(evidence / artifact refs)
상태(open | scheduled | fixed | withdrawn)
```

#### 열린 유예 항목 (2026-07-26 기준)

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-1` | C (P3) | 호출부 감사의 **bounded computed dynamic specifier** 판정이, 도달 가능한 조각 각각에는 `fixture-config`가 없지만 런타임에 합성되는 route(예: `"./lib/" + (flag ? "fixture-" : "other-") + "config.mjs"`)를 `safe`로 본다 | 낮음 — 현재 production 호출부 5개는 전부 해당 없음 | 제한적 — 미래에 그런 호출부가 생겼을 때 **소스 레벨 감사에서 누락**되는 것뿐(런타임 계약·lock 계약은 무관) | 낮음 | 소~중 | M4 소스 계약 감사 확장 시 또는 그런 형태의 호출부가 실제로 추가될 때 | 구현 세션(Claude Opus 5) | 여덟 번째 리비전 리뷰 Category C · `src/tools/suiteExclusiveLock.test.ts` 동적 import 케이스 | open |
| `C-2` | C (P3) | `scripts/lib/fixture-config.mjs` 모듈 주석이 production 진입점을 2개만 예시로 적어 실제 5개와 어긋나 보인다 | — | 문서/주석만 | 낮음 | 소 | production 파일을 여는 다음 승인 범위 | 구현 세션 | 여섯~여덟 번째 리비전 잔여 위험 목록 | open |
| `C-3` | C (P3) | `parseDiagnostics`는 TypeScript 준공개 필드라 상위 버전에서 이름이 바뀌면 파싱 진단 검사가 조용히 무력화될 수 있다 | 낮음 | 감사 1항목 | 낮음(전용 회귀 2건이 탐지) | 소 | TypeScript major 업그레이드 시 | 구현 세션 | 여덟 번째 리비전 회귀 2건 | open |
| `B-1` | **C (release-readiness)** | 조용한 호스트에서 부하(stress) acceptance **재실행** — 고정 5초 child startup deadline 2건이 외부 부하에서 넘친 이력 | 낮음(부하 없는 호스트에서는 PASS 이력) | release 준비 판정 | 낮음 | 중(방침 결정 필요) | **release 준비 시점**(트리거) — M3 완료 게이트 **아님**, M4 선행 조건 **아님** | 사용자 + 구현 세션 | 여섯 번째 리비전 세션 실측(§10 M3d.2) | open (nonblocking) |
| `B-2` | **C (release-readiness)** | live runner **재실행**과 evidence 재생성 | — | release 준비 판정 | 낮음 | 사용자 실행 | **release 준비 시점**(트리거) — M3 완료 게이트 **아님**, M4 선행 조건 **아님** | 사용자(TTY 필요) | §10 M3d.2 | open (nonblocking) |

**`B-1`·`B-2` 재분류(2026-07-27, 사용자 확정 상태 기준).** M3a/M3b/M3c core와 **실제 live acceptance는
완료**됐고 M3d.2는 PR #10으로 `ea764a5`에 병합됐다 → **M3는 완료이고 재개방하지 않는다.**
따라서 이 둘은 **M3 완료 게이트가 아니라 nonblocking release-readiness backlog 트리거**다.
id는 추적 연속성을 위해 유지하되 분류는 C로 내렸다. 위 표 이전 판(둘 다 "B — 차단")은
2026-07-26 시점 기록이며 §1·§10 M3d 본문의 그 표현도 같은 이유로 이력으로만 읽는다.

#### M4a/M4b에서 추가된 유예 항목 (2026-07-27 기준)

> **M4b 갱신(2026-07-27):** `B-3`·`B-4`는 **fixed**다(아래 표에 증거·상태로 반영). M4b가 새로 등록한
> 항목은 `C-8`(stale lock 자동 회수 없음) · `C-9`(schema 마이그레이션 도구 없음) ·
> `C-10`(priority/fairness/retry 없음)이고, `C-4`에는 writer lock 크래시 잔재 보강 항목을 붙였다.
> **M4b에서 발견한 P0는 없다** — 있었다면 M4b를 완료로 적지 않았다.

M4a 구현 중 확인한 **비-P0** 항목이다. **P0는 없었고**(있었다면 M4a를 완료로 적지 않았다)
아래 항목들은 M4a 최소 수직 기능의 완료를 막지 않는다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-3` | B (P1) | **exclusive resource class + scheduler 미구현.** durable state가 배타 자원 class를 선언·직렬화하지 못한다 | 확실(미구현) | M4 완료 판정 · M5 bridge가 전역 상태 관찰 테스트를 병렬로 돌릴 위험 | 높음 — M5에서 거짓 실패가 재현되면 그때 state schema를 다시 열어야 한다 | 중 | **M4 완료 전(= M5 bridge 착수 전)** | 다음 구현 세션 | **M4b: `task.resourceClasses` durable 선언 + `scheduleReady`/`startScheduledBatch` + focused 13건 + acceptance Test 14(42 체크)** | **fixed (2026-07-27, M4b)** |
| `B-4` | B (P1) | **멀티프로세스 writer lock 없음.** kernel은 run 하나당 단일 writer 전제이고, 두 프로세스가 같은 run에 쓰면 마지막 쓰기가 이긴다. load가 event chain 불일치를 fail-closed로 잡지만 그 run은 사람 개입 없이는 다시 열리지 않는다 | 낮음(현재 호출자 1개) | 해당 run 1건 | 중 — 병렬 worker 도입 시점에 반드시 필요 | 중(기존 `suiteExclusiveLock` 계약 재사용 가능) | **실제 병렬 worker/멀티프로세스 writer 도입 시 또는 M4 완료 전** | 다음 구현 세션 | **M4b: `run_state.lock`(O_EXCL, 대기 없음) + `CommitInput.base` 대조로 `stale_writer` 거부 + focused/acceptance 증거.** 남는 크래시·stale lock 한계는 `C-4`/`C-8`로 이관 | **fixed (2026-07-27, M4b)** |
| `C-4` | C (P2) | **커밋 중간 크래시 복구 도구 없음.** event append 후 state rename 전에 죽으면 `event_count_mismatch`로 영구히 열리지 않는다(fail-closed라 손상 데이터를 읽지는 않는다) | 낮음 | 해당 run 1건 | 낮음 — 지금은 run을 버리고 다시 만들면 된다 | 소~중 | **M10 hardening** | 미정 | 로드맵 M4a "저장은 rename, 과도한 crash hardening은 범위 밖" | open |
| `C-5` | C (P2) | **artifact 검증의 경로 기반 TOCTOU 창.** Node 18에 디렉터리 상대 열기가 없어 lstat/realpath와 read 사이 창을 0으로 만들 수 없다(M3d.2 live evidence와 같은 한계) | 낮음 | artifact 1건의 hash 판정 | 낮음 | 중(런타임 상향 필요) | Node 20+ 채택 또는 M10 hardening | 미정 | `verifyArtifactFile` · M3d.2 동일 한계 기록 §10 | open |
| `C-6` | C (P3) | **§5.1의 나머지 6개 메시지 타입과 7 specialist registry 미구현.** 계획된 미구현이지 결함이 아니다 | — | 후속 마일스톤 범위 | 낮음 | 중 | M6(hierarchical orchestrator) | 다음 구현 세션 | **M4c: 메시지 10종 전부 + 중앙 경유 sibling/reviewer 라우팅 + 7 specialist registry(하위 role 한 겹) + focused 17건 + acceptance Test 15(77 체크)** | **fixed (2026-07-27, M4c)** |
| `C-4` 보강 | C (P2) | (M4b) 위 `C-4`의 크래시 창이 **writer lock에도 적용된다**: 커밋 도중 프로세스가 **죽으면**(SIGKILL 등) `run_state.lock`이 남아 그 run의 이후 커밋을 전부 `run_lock_held`로 거부한다(사람이 지워야 한다). **정정(2026-07-27, M4c):** 이전 판의 "lock 발행 후 write 실패 경로도 같은 잔재를 남긴다"는 부정확하다 — 커밋 경로에서 잡히는 정상적인 write 실패는 `commitRun`의 `finally`가 lock을 **해제한다**. 잔재가 남는 경로는 ⓐ 프로세스 크래시/kill ⓑ 해제 자체의 실패(`run_lock_release_failed`/`run_lock_owner_mismatch`) ⓒ `acquireRunWriterLock`이 lock 파일을 만든 뒤 nonce write가 실패하는 **좁은 창**뿐이다 | 낮음 | 해당 run 1건(그 run만 정지, 손상 없음) | 낮음 — 지금은 lock 파일을 지우거나 run을 다시 만들면 된다 | 소~중 | **M10 hardening** 또는 실제 멀티프로세스 writer 운영 시작 시 | 미정 | `acquireRunWriterLock`/`commitRun` ponytail 주석 · M4b acceptance Test 14 | open |
| `C-8` | C (P2) | **stale lock 자동 회수·소유자 생존 확인이 없다.** M4b writer lock은 nonce 파일 하나이며 죽은 소유자를 판별하지 않는다(항상 거부 = fail closed). 기존 suite lock의 guard/격리/inode 신원 계약은 **재사용하지 않았다** — suite 전용 의미(ownership token 상속·pgid 스캔·격리)를 orchestration에 끌어오지 않기 위해서다 | 낮음 | 해당 run 1건 | 중 — 상시 운영 orchestrator가 생기면 운영 부담이 된다 | 중 | **M10 hardening** 또는 상시 orchestrator 프로세스 도입 시 | 미정 | `orchestrationStore.ts` writer lock 주석 · `scripts/lib/suite-exclusive-lock.mjs` 비교 | open |
| `C-9` | C (P3) | **state schema 마이그레이션 도구가 없다.** M4a 상태 파일은 `state_pre_m4b_unsupported`로 거부하고 새 run을 만들게 한다. 앞으로 필드가 또 늘면 같은 판단을 반복해야 한다 | 확실(설계상) | 기존 orchestration run(현재 운영 중인 실 run 없음 — offline 테스트 run뿐) | 낮음 — 지금은 버릴 수 있는 run만 있다 | 중(마이그레이션 프레임워크는 별도 승인 범위) | **실제 운영 중인 orchestration run이 생긴 뒤 첫 state 필드 추가 시** | 미정 | `validateTask`의 pre-M4b 거부 · M4b focused 테스트 1건 | open |
| `C-10` | C (P3) | **scheduler에 priority·fairness·retry·starvation 방어가 없다.** 선택은 `taskId` 오름차순 greedy이므로 자원을 요구하는 뒷순위 task가 계속 유예될 수 있다(결정론은 보장) | 중간(자원 경합이 잦아지면) | scheduling 순서·처리량(안전성은 무관) | 낮음 — 규칙이 좁고 결정론적이라 나중에 정책만 얹으면 된다 | 소~중 | **실제 동시 실행(M5/M9 worker 병렬)에서 starvation이 실측될 때** | 미정 | `selectSchedulable` 주석 · M4b focused "limit는 앞에서부터 자른다" | open |
| `C-7` | C (P2) | **state↔event binding이 키 없는 digest다.** `run_state.json`과 `events.jsonl`을 **모두 일관되게 재작성**하는 위조는 막지 못한다(그 경우 append-only 감사 로그 자체가 조작되므로 감사 대상) | 낮음 — 로컬 파일 쓰기 권한을 가진 공격자 전제 | 해당 run의 감사 신뢰도 | 중 | 중(out-of-band 키 관리 필요) | 서명/HMAC 도입 승인 시 또는 M10 hardening | 미정 | `assertStateEventBinding` 주석 · P0-1 수정 | open |

#### M4c에서 추가된 유예 항목 (2026-07-27 기준)

M4c 구현 중 확인한 **비-P0** 항목이다. **P0는 없었고**(있었다면 M4c를 완료로 적지 않았다) 아래 항목들은
M4 완료 판정을 막지 않는다. `C-6`은 이번에 **fixed**이고, `C-9`(schema 마이그레이션 도구 없음)는
pre-M4c state 거부(`state_pre_m4c_unsupported`)가 하나 더 붙어 **여전히 open**이다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-11` | C (P2) | **manifest는 run 생성 시 고정이라 승인 범위를 넓히거나 만료를 연장하는 경로가 없다.** 범위를 바꾸려면 새 run을 만들어야 한다(수정 시도는 `state_event_binding_mismatch`, 만료 후 변경은 `manifest_expired`) | 중간(마일스톤이 길어지면) | 운영 편의(안전성은 무관 — fail closed 방향) | 낮음 — 지금은 새 run이 값싸다 | 중(재승인 전이 + 감사 이벤트 설계 필요) | **M5 autopilot이 사람 승인 왕복을 자동화할 때** | 다음 구현 세션 | `assertNotExpired` · M4c focused "만료된 manifest" · acceptance Test 15 | open |
| `C-12` | C (P3) | **전달 수령(ack)은 호출자가 직접 하는 좁은 전이일 뿐, 재전송·타임아웃·우선순위·starvation 방어가 없다.** 의도적으로 범용 queue를 만들지 않았다(`C-10`과 같은 결정) | 중간(실제 동시 실행 시) | 전달 순서·처리량(정확성은 무관 — 순서는 결정론적) | 낮음 — 규칙이 좁아 정책만 얹으면 된다 | 소~중 | **M5/M9에서 실제 worker가 inbox를 소비하기 시작할 때** | 미정 | `pendingDeliveries` · `acknowledgeDelivery` 주석 | open |
| `C-13` | C (P3) | **리뷰 대상(subject)은 API 인자이고 message index에는 route만 남는다.** 대상 관계는 `task.dependsOn`으로 재구성해야 하며 "이 review_request가 정확히 어떤 revision을 봤는지"는 body(`## Reviewed Revision and Hash`)와 artifactRefs에만 있다 | 낮음 | 감사 편의 | 낮음 | 소(envelope가 아니라 message index에 필드 1개) | **여러 revision을 병렬 검토하는 흐름이 생길 때** | 미정 | `requestReview`/`requestRevision` · M4c focused "reviewer 게이트" | open |
| `C-14` | C (P3) | **`allowedCommands` 조회는 문자열 동치**다. shell을 파싱하지 않으므로 인자 순서만 다른 동등 명령은 별도 승인이 필요하다(의도적 — 파싱은 "승인된 것처럼 보이는 명령"을 판정하게 된다) | 중간 | 승인 목록 관리 편의(보안은 강화 방향) | 낮음 | 중(안전한 파서 필요 — 별도 승인 범위) | **M5 executor가 실제로 명령을 돌릴 때 재검토** | 미정 | `commandAllowed` 주석 · M4c focused "조회 API" | open |
| `C-15` | C (P3) | **7 specialist registry는 코드 상수이고 run별로 좁히거나 넓힐 수 없다.** 하위 role은 `<상위>.<하위>` 한 겹만 허용한다 | 낮음 | role 명명 유연성 | 낮음 | 소 | **M6 hierarchical orchestrator에서 run별 registry가 필요해질 때** | 미정 | `SPECIALIST_ROLES` · `isRegistryRoleId` | open |

#### M4c 최종 Codex 리뷰에서 추가된 유예 항목 (2026-07-27 기준)

M4c 커밋(`3cfdb39`+`c963cb0`) 이후의 **fresh Codex read-only 최종 리뷰** 결과다. **P0는 없다.**
셋 다 M4 state-only 범위에서는 nonblocking이므로 **지금 코드 리비전 루프를 열지 않고 대장에만 등록**한다.
`B-5`는 **M5 provider/autopilot이 실제 프로세스를 띄우기 전에 반드시 닫는다.**

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-5` | **B (P1) → fixed(M5a)** | **`manifest.approvedCommit`이 40자 형태만 검증되고 실제 실행 checkout HEAD에 묶이지 않는다.** 승인된 base가 아닌 커밋에서 실행돼도 state 계층은 거부하지 않는다. M4는 아무것도 실행하지 않으므로 지금은 nonblocking이지만, **M5 provider/autopilot이 프로세스를 띄우는 시점에는 `approvedCommit === 실행 worktree/컨트롤러 checkout HEAD`가 아니면 fail closed여야 한다** | 중간 — stacked 브랜치·여러 worktree를 쓰는 현재 방식에서 base가 어긋나기 쉽다 | 실행되는 모든 worker(잘못된 base에서 만들어진 diff 전체) | **높음** — worker가 엉뚱한 base에서 돌면 산출물을 버려야 하고 **M5 실행 경계를 다시 열어야 한다** | 소~중(커밋 경로에 HEAD 대조 불변식 1개) | **M5 provider/autopilot이 실제 명령을 처음 실행하기 전** | 다음 구현 세션(M5) | **M5a: `src/exec/executionBoundary.ts` `verifyExecutionBoundary()` — spawn 직전마다 controller·실행 checkout HEAD == `approvedCommit` 대조 + realpath/루트 신원 + 만료(경계 포함) fail closed. focused 8건 + provider 거부 경로 전부 spawn 0** | **fixed (2026-07-27, M5a)** |
| `C-16` | C (P2) | **taskId ↔ roleId 교차 namespace 모호성.** 어떤 task의 `taskId`가 다른 task의 `roleId`와 같으면 `deliverTo` 해석이 **taskId를 먼저** 고른다. 같은 roleId가 여럿일 때(`ambiguous_recipient`)는 거부하지만 이 교차 충돌은 거부하지 않는다 | 낮음 — 명명 규칙이 겹칠 때만 | 전달 1건의 수신자(정확성) | 중 — **실제 inbox 소비가 생기면 bounded summary·artifact 포인터가 엉뚱한 관련 task로 전달될 수 있다** | 소(해석 전에 교차 충돌을 `ambiguous_recipient`로 거부) | **M5에서 실제 worker가 inbox를 소비하기 시작하기 전** | 다음 구현 세션 | M4c 최종 Codex 리뷰 · `deliverTo` 해석 순서 · `C-13` 인접 | open |
| `C-17` | C (P2) | **kernel의 manifest 만료가 `now > expiresAt`이라 `expiresAt`과 정확히 같은 시각의 state 변경은 1회 통과한다**(경계 포함이 아님). **만료 경계 항목은 이것 하나다** — M5a가 잠깐 등록했던 중복 `C-20`은 철회했다. 실행 경계(`verifyExecutionBoundary`)는 M5a에서 이미 `>=`로 좁혔으므로 남은 것은 kernel 쪽뿐이다 | 낮음 — ms 단위 정확 일치 | 만료 경계에서의 state 변경 1건 | 낮음 — 지금은 만료 후 새 run이 값싸다 | 소(비교를 `>=`로) | **M5c(장시간 autopilot·재승인 동작 `C-11`) 착수 전** | M5c 구현 세션 | M4c 최종 Codex 리뷰 · `assertNotExpired` · M4c focused "만료된 manifest" · M5a `verifyExecutionBoundary`(포함 경계) | open |

### 9.2 테스트 비례 원칙

- 변경마다 **focused 테스트**.
- handoff 전 **전체 suite 1회**.
- **반복(연속 3회)·stress·live**는 마일스톤/하드닝 게이트에서만. 단 변경이 동시성·lock·타이밍·live runner
  계약을 건드리면 그 범위에서 즉시 실행한다.
- 어떤 경우에도 **테스트 완화·삭제 금지**(기존 규칙 불변). 실패는 원인을 고치거나 정직하게 미충족으로 남긴다.

### 9.3 fresh context와 병렬 Claude Code 세션 안전 조건

fresh context 강제는 유지한다: 구현·리비전 = **fresh Claude Code Opus 5**, 넓은 범위 계획·비평·리뷰 =
**fresh Codex `gpt-5.6-sol` xhigh**, 리뷰어는 **read-only**이고 작성자 transcript·자기평가와 분리한다.

Claude Code 구현 단계는 **작업이 실질적으로 빨라지고 안전할 때만** 여러 Opus 5 세션을 병렬로 쓴다.
아래 조건을 **전부** 만족해야 한다.

1. **task DAG와 공유 API/schema 결정을 먼저** 확정한다(병렬 시작 전).
2. worker마다 **격리된 git worktree 1개** + **명시적 파일 소유권**.
3. **같은 파일에 두 writer 금지** — 소유권은 disjoint여야 한다.
4. 공유 schema/API 변경 · 통합/병합 · 상태 마이그레이션 · 최종 전체 테스트는 **직렬**.
5. 배타 자원 · 전역 tmp/프로세스 · stress · live 테스트는 **기존 suite lock 아래 직렬**(§1 suite 직렬화 계약).
6. 동시성 상한은 **가용 CPU/부하 · 메모리 · 토큰/비용 예산 · manifest `maxSessions`** 로 정하고,
   오버헤드·경합이 이득을 넘으면 **세션 1개로 줄인다**.
7. 오케스트레이터가 **의존성 · 소유권 · artifact hash · 상태 · 완료 · 결과 라우팅**을 검증한다.
8. 로컬 통합은 직렬이고, **원격 쓰기는 계속 hard deny**다(§8).

공유 dirty 체크아웃에서 이뤄지는 즉시 리비전 작업은 **단일 세션이 맞다**(2026-07-26까지의 M3d.2 리비전
1~8이 그 방식이었고 그 판단은 유효하다). 병렬은 격리 worktree가 준비된 미래 작업에서만 적용한다.
이 병렬 계약은 M6의 fresh-context rotation, M9의 worker 병렬 worktree 구현과 같은 규칙이다.

## 10. 재정렬된 마일스톤

### M3d — Baseline stabilization + roadmap activation

> **현행 상태(2026-07-27): 완료.** M3d.2는 **PR #10으로 `ea764a5`에 병합**됐고 M3 전체가 완료다 —
> **재개방하지 않는다.** 아래 본문의 "진행 중 / pending / 차단 게이트 / 미충족" 표현은
> **2026-07-26 시점의 기록**이며 이력으로 보존한 것이다(§0-0이 우선한다).
> 부하 재실행·live runner 재실행은 nonblocking release-readiness backlog(`B-1`/`B-2`)로 재분류됐다.

**상태(2026-07-26 당시): 진행 중.** M3d.1 완료, M3d.2 구현·offline 검증 완료 / **live acceptance 3종 pending**.
아래 원래 M3d 완료 기준은 그대로 유지하며, M3d 전체 완료는 M3d.2의 live evidence 3건까지
확인했을 때만 선언한다.

목표(원안 유지):

- M3c-2 runner smoke flake를 테스트 완화 없이 안정화.
- live runner 결과를 비밀·raw transcript 없이 버전/계약/지표 중심 evidence로 영속화.
- 이 문서와 현재 M3 완료 상태를 활성 문서·handoff에 동기화.

완료(원안 유지 — M3d 전체 판정 기준):

- 동일 환경 `npm test` 연속 3회 exit 0(known CPU 부하 조건 포함 별도 stress 결과 기록).
- exec/core/acceptance 전부 green, live evidence schema/redaction 테스트.

#### M3d.1 — runner 소유권 판정 안정화 · **완료(fresh Codex Sol xhigh verdict = APPROVE)**

- 원인: M3c-2 live runner가 baseline 이후 `shadcn@4.13.1 mcp`에 매칭되는 명령을 전부 자기 잔여물로 간주해,
  무관한 동시 실행 프로세스가 거짓 실패를 유발할 수 있었다.
- 수정 범위: `scripts/m3c2-live-read-semantics.mjs`, `src/tools/shadcnReadSemanticsProbe.test.ts` 두 파일뿐.
- 소유권 = runner 프로세스 트리 자손 OR cwd가 runner 임시 base 하위. base 밖의 진짜 독립 post-baseline
  sibling은 foreign으로 무시. unknown inspection은 fail-closed 유지이며 kill 대상이 아니다.
- 신원은 `pid + ps lstart`(PID 단독 금지). 후보 argv 미로깅, 진단은 pid·ownership·run별 salted SHA-256
  signature만. 테스트 sleeper는 bounded TTL, 정리는 child handle 또는 nonce 확인 orphan에 대해
  bounded 종료 확인으로만(blind PID signal 없음).
- 검증(최종 리비전 후): `git diff --check` clean, NUL 0, build PASS, 해당 파일 단독 18/18 PASS 2회,
  `test:core` 275/275 PASS, 격리 `npm test` PASS = exec 75/75 + core 275/275 + acceptance 71/71.
- 잔여 위험(비차단): `lstart` 1초 해상도, 대상 Linux는 procps 호환 `/bin/ps` 전제(미지원 inspection은 fail-closed).

#### M3d.2 — live evidence 영속화 + 반복 acceptance · **구현·offline 검증 완료(fresh Codex REQUEST_CHANGES 8회 리비전 반영) / 부하 acceptance 미충족 = 차단 게이트(여섯 번째 리비전 세션 FAIL, 이후 미재실행) · live 검증 pending · 승인 없음**

구현 범위(완료):

- `schemas/live_evidence.schema.json` + `src/tools/liveEvidence.ts`(수동 closed validator, 신규 의존성 0) +
  `src/tools/liveEvidence.test.ts`.
- evidence는 **성공 전용**(`status:"pass"`)이며 허용 top-level은 `version`/`contract`/`status`/`timestamp`/`metrics`
  정확히 5개다. `metrics`는 runner별 **discriminated 계약**의 exact key 집합이고 값은 0..1,000,000 정수 또는 boolean만이다.
  모든 객체 레벨에서 unknown key를 거부한다(JSON Schema `additionalProperties:false`와 런타임 validator가 동일 판정).
- 금지: raw transcript, tool/MCP 입출력, argv, 명령, 파일 경로, hostname/user, PID, session/call/request ID,
  환경변수·secret 참조/값, config 본문, free-form error/message. key 이름 조각 스캔으로 **먼저** 거부하며
  redaction 마커로 치환해도 통과하지 않는다. 영속화 직전 `redactSecrets`/`collectSecretValues` backstop에서 잔재가
  잡히면 가리지 않고 **쓰기를 거부**한다.
- timestamp 계약은 schema와 런타임 validator가 **동일 판정**을 내린다: `Z` 고정 UTC, 밀리초 3자리 선택,
  시 00-23·분·초 범위, 달력 실재성(2월 30·31일, 4·6·9·11월 31일, 비윤년 2월 29일 거부), 연도 2000..2099
  (이 범위에서 윤년 = 4의 배수이므로 정규식만으로도 같은 결정이 가능). 테스트가 accept/reject 표로 동치를 강제한다.
- 저장: `docs/evidence/m3d2`에 성공 1건당 파일 1개(`<contract>-<UTC compact ts>-<nonce>.json`),
  디렉터리 0700 / 파일 0600. **같은 디렉터리의 숨김 임시 파일에 전부 쓰고 fsync·close·재검증(byte 동일 + 계약)까지
  끝낸 뒤, 덮어쓰지 않는 원자적 publish(exclusive hard link)로 최종 이름을 만든다** — 쓰기 중 크래시가 나도
  최종 성공 산출물 이름의 잘린 파일은 생기지 않는다. 디렉터리·파일 dev+ino 신원을 보관해 publish 직전 재확인하고
  정리(unlink)도 신원 확인 후에만 수행하며(교체된 파일 삭제 금지), 잡아낸 정리 실패는 무시하지 않고 오류로 보고한다.
  publish 후 지원 플랫폼에서 디렉터리 fsync. symlink·비디렉터리 대상 거부. 경로는 내부 반환값이며 payload·콘솔 미노출.
  남는 한계: Node 18 API에는 디렉터리 핸들 상대 열기가 없어 경로 기반 TOCTOU를 완전히 없앨 수는 없다(창 축소·사후 탐지 완화).
- 통합 대상은 최종 live runner 3종뿐이다: `scripts/m3a-live-preflight.mjs`, `scripts/m3b2-live-handoff.mjs`,
  `scripts/m3c3b-live-handoff.mjs`. 모든 계약 검사 + cleanup 성공 뒤에만 기록하며 **기록 실패는 runner 실패**다.
  opt-in·fail-closed·cleanup·기존 PASS 의미는 유지하고, live runner는 `npm test`에 연결하지 않았다.
- 반복/부하 acceptance: `scripts/m3d2-stress-acceptance.mjs` + `npm run acceptance:stress:m3d2`(수동 전용).
  · 설정된 부하 worker **전부**의 spawn을 확인하고, `npm test`가 닫힐 때까지 전원 생존을 요구한다.
    spawn 실패·정리 전 조기 종료/error는 FAIL이다(부하 없는 PASS 금지).
  · 부하 firm deadline > `npm test` wall-clock 상한을 **강제**한다(어기면 exit 2) — 부하가 suite 전 구간을 덮는다.
  · 종료는 **비동기 idempotent shutdown 상태 기계** 하나: 소유 npm 프로세스 그룹 + 부하 worker만 종료 →
    worker·그룹·소유 그룹 자손(pgid 스캔) 소멸을 bounded 확인 → **확인 뒤에** lock 해제 → exit.
    normal/timeout/error/SIGINT/SIGTERM 전 경로 공용이고, 확인 실패·불가는 FAIL로 보고한다. timeout은 group kill이
    실패해도 실제 wall-clock 상한으로 확정된다.
  · **정리 확인 실패 시 lock을 해제하지 않는다(두 번째 리비전)** — 해제 대신 격리하고 즉시 종료한다.
    소유 잔재가 남아 있을 수 있는 동안 다음 suite가 lock을 이어받는 경로를 없앤다.
  · 일반 `npm test`와 **같은 배타 lock**을 사용하고, `ps` 스캔은 lock을 우회한 suite를 잡는 backstop으로만 둔다.

검증 실측(offline, **첫 번째 리비전** 시점 기록 — 현행 수치는 §1과 아래 "두 번째 리비전" 블록을 본다):

- `npm run build` PASS, `git diff --check` clean, **변경·추적 대상 텍스트 파일(tracked + ignore 제외 untracked)**
  NUL 바이트 0. (정정: 원래 "소스/스크립트/스키마/dist NUL 0"이라고 적었으나 사실이 아니다 — gitignore된 기존
  `src/.DS_Store`에 NUL이 있다. 실제 검증 범위는 git이 보는 텍스트 파일이다.)
- `src/tools/liveEvidence.test.ts` 단독 **23/23 PASS**, `src/tools/suiteExclusiveLock.test.ts` 단독 **17/17 PASS**.
- `npm test` **연속 3회 전부 PASS(직렬)** = exec 75/75 + core **315/315**(M3d.2 테스트 40건) + acceptance 71/71.
- stress `npm run acceptance:stress:m3d2` **PASS(1회)** — worker 4/4 spawn, suite 종료 시점까지 4/4 생존,
  elapsed 191.2s, `npmTestExitCode:0`, `cleanupConfirmed:true`, 잔존 worker/자손 0, cleanup 문제 0,
  `lockReleased:true`. 부하 실행 중 acceptance 71/71이 로그에 보였고 exec/core 카운트 줄은 캡처 tail 밖이었다
  (`npmTestExitCode:0`이 3단계 전부 통과를 보장한다).

**두 번째 리비전(두 번째 fresh Codex Sol xhigh REQUEST_CHANGES 4건 반영)** — lock 안전성 계약 확정:

- **정리 확인 실패 = lock 노출 금지.** stress runner가 `cleanupConfirmed:false`인데도 lock을 무조건 해제하던 결함을
  고쳤다. 확인 성공 시에만 해제하고, 실패하면 lock을 **격리(quarantine)** 한다. 격리 lock은 소유자가 죽어도
  stale 회수 대상이 아니며(`lock_quarantined` 항상 거부) 사람이 확인 후 수동 제거해야 풀린다. 격리는 write 1회라
  **매달리지 않고 즉시 종료**한다. `exit` 핸들러·반복 시그널 탈출 경로도 동일하게 적용한다.
- **lock wrapper 종료도 단일 상태 기계.** `scripts/suite-lock.mjs`가 시그널 직후(그리고 두 번째 시그널은 더 일찍)
  child close·그룹 확인 없이 해제하던 것을 고쳤다. normal / spawn error / SIGINT / SIGTERM / 반복 시그널 /
  escalation 전부 같은 비동기 idempotent bounded 기계를 지나며, 소유 그룹·소유 pgid 자손 소멸을 확인한 뒤에만
  해제한다. 확인 실패는 격리, **시그널 exit 의미 130/143은 유지**한다. detached child의 중첩 프로세스 그룹은
  상위 pgid 스캔에 잡히지 않으므로 **만든 계층이 직접 확인**한다.
- **stale 회수 신원 안전성.** (이 항목은 **세 번째 리비전에서 폐기**되었다 — `.recovery` 직렬화·rename 회수·
  회수 inode CAS 경로 자체를 삭제하고 **자동 회수를 하지 않는다**. 아래 세 번째 리비전 블록을 본다.)
  당시 서술: `check → blind rename`은 "A가 stale로 읽음 → B가 회수 후 live lock 생성 → A가 그 live lock을 rename"으로
  겹침을 허용했고, 이를 직렬화 + 재분류 + inode CAS 세 겹으로 막았다.
  lock 파일은 비공개 임시 파일 → `link()` 발행이라 **부분 write가 최종 경로에 잔재를 남기지 않는다**(이 부분은 유효).
- **검증 실측(offline, 두 번째 리비전 시점)**: `npm run build` PASS, `git diff --check` clean,
  git 가시 파일 265건 전수 NUL 0. `src/tools/suiteExclusiveLock.test.ts` 단독 **32/32 PASS**(17 → 32건).
  `npm test` **연속 3회 전부 PASS(직렬, 병렬 실행 없음)** = exec 75/75 + core **330/330** + acceptance 71/71.
  일반 suite 종료 후 stress 1회 **PASS**(worker 4/4, elapsed 100.9s, `cleanupConfirmed:true`, `lockReleased:true`,
  `lockQuarantined:false`, 잔재 0). 신규 P1-3 테스트는 mutation으로 비공허성을 확인한 뒤 원복했다.

**세 번째 리비전(세 번째 fresh Codex Sol xhigh REQUEST_CHANGES 6건 반영)** — lock format v2 · 자동 회수 폐지 ·
argv 전용 주입. 위 "두 번째 리비전"의 stale 회수 서술을 **대체**한다:

- **전이 guard로 TOCTOU 제거.** release/quarantine이 소유 확인 뒤 그대로 unlink/rename하던 양방향 경합
  (새 소유 lock 삭제·덮어쓰기)을 없앴다. acquire/release/quarantine/reentry는 전부 crash-persistent
  `<lock>.guard`를 exclusive 발행한 프로세스만 수행하고, guard 안에서 **tokenHash → 격리 표시 → inode** 순으로
  재확인한 뒤에만 파일을 조작한다. guard 제거는 **자기 nonce + 자기 inode** 확인 후에만 한다. lock format `v2`.
- **fail closed 강화.** quarantine write 실패·unlink 실패·신원 불일치·전이 중 SIGKILL은 **guard를 남겨** 이후
  모든 acquire를 거부한다(수동 제거 안내). 아무것도 바꾸지 않은 계약상 거부는 no-op이라 guard를 정상 반납한다.
- **stale/orphan 자동 회수 폐지.** `.recovery` mutex와 rename 회수 경로를 삭제했다. 소유자가 죽은 lock은
  `lock_orphaned`로 항상 거부하며, lock이 없어도 guard가 있으면 acquire는 우회하지 않는다.
- **중첩 그룹 계약 정정.** nested wrapper는 detached를 쓰지 않아 전 자손이 상위 stress pgid에 남는다.
  상위 timeout은 **TERM → 8s 유예 → 확인 → KILL**(하위 예산 1.2s+3s보다 김).
- **argv 전용 테스트 주입.** production은 lock 경로·`ps` fixture·pause/injection·evidence 디렉터리를 env에서 읽지
  않는다(`HARNESS_LIVE_EVIDENCE_DIR` 폐기 → `resolveEvidenceDir({repoRoot, overrideDir})`).
  주입은 `--fixture-config <절대경로 .json>` 하나이며 엄격 검증한다. live runner 정상 명령은 flag 없이 동작한다.
- **검증 실측(offline, 세 번째 리비전 시점)**: `node --check`·`tsc --noEmit` 0·`npm run build` PASS,
  `git diff --check` clean, git 가시 파일 **266건 NUL 0**.
  focused `liveEvidence.test.ts` **24/24**, `suiteExclusiveLock.test.ts` **43/43**(32 → 43건).
  `npm test` **연속 3회 전부 PASS(직렬)** = exec 75/75 + core **342/342** + acceptance 71/71.
  일반 suite 종료 후 stress 1회 **PASS**(worker 4/4, elapsed 89.6s, `cleanupConfirmed:true`, `lockReleased:true`,
  `lockQuarantined:false`, 잔재 0). mutation 4종(재확인 제거 / guard blind unlink / nested detached /
  timeout 즉시 KILL)으로 신규 테스트의 비공허성을 확인한 뒤 원복했다.

**네 번째 리비전(네 번째 fresh Codex Sol xhigh REQUEST_CHANGES 5건 반영: P1 3 · P2 1 · P3 1)** —
발행 신원 불변식 · 전이 실패 분류 · fixture 로더 단일 fd. 위 세 번째 리비전 서술을 **보강**한다(대체 아님):

- **P1-1 발행은 신원 확인 뒤에만 성공이다.** `publishFileExclusive`가 `linkSync` 뒤 `lstat` 실패를
  "published:true, dev/ino null"로 넘겨 이후 inode 검증이 조용히 생략되던 구멍을 닫았다. 이제 임시 파일을
  **열린 fd의 `fstat`** 으로 (dev,ino)를 확보하고, link 뒤 최종 경로 `lstat`이 **같은 (dev,ino)** 임을 확인한다.
  lstat 실패·불일치는 성공이 아니며(`lock_publish_unverifiable` / `lock_publish_identity_mismatch`) 최종 경로를
  **지우지 않는다**(우리 파일이라는 증거가 없으므로). `published:true`의 dev/ino는 **non-null 불변식**이고
  release/quarantine의 inode 검증은 **무조건** 수행된다. guard 발행이 불확실하면 그 guard가 남아 새 suite를 막고,
  lock 발행이 실패하면 감싼 guard를 남긴다(둘 다 fail closed).
- **P1-2 전이 실패 분류를 명시했다.** `SuiteLockError.failure ∈ {refusal, mechanism}`이며 **기본값은 mechanism**
  (= guard 유지)이다. guard 취득 뒤의 메커니즘 I/O 오류(temp create/write/close/link, 발행 신원 확인,
  lock unlink, 격리 write/close/rename, guard 제거)는 전부 guard를 남긴다. 아무 상태도 바꾸지 않은
  **계약상 거부만** 자기 nonce+inode를 재확인해 guard를 반납한다. 추가로 ① `writeAllSync`로 short write를 오류로
  올리고 ② 격리 `closeSync` 실패를 무시하지 않으며(rename 안 함) ③ 격리 rename **직후** 신원을 재확인하고
  ④ lock unlink의 ENOENT도 실패로 보고 ⑤ guard 제거 실패(ENOENT 포함)도 문제로 보고한다.
  ⑥ 보유 중인 lock이 계약 밖에서 사라진 경우를 "해제됨"으로 처리하지 않는다.
  ⑦ `quarantineByToken`은 **tokenHash를 먼저** 본다(남의 격리 lock을 우리 성공으로 착각하지 않는다).
  ⑧ 격리 rewrite는 기본 record(v/kind/pid/identity/tokenHash) 보존을 요구해 **같은 token만으로는** 외부 교체를
  격리로 인정하지 않는다.
- **P1-3 fixture 로더의 검사–사용 경합 제거.** `lstat(path)` → `readFileSync(path)`(경로 2회 해석)를
  **경로 1회 open(`O_RDONLY|O_NOFOLLOW`) → `fstat`으로 일반 파일 확인 → 같은 fd에서 최대 8193B 읽기 →
  실제 읽은 바이트로 상한 판정**으로 바꿨다. 최종 symlink는 열기 전에 거부(ELOOP/EMLINK)되고, 교체된 경로는
  다시 열지 않으며, close 오류는 이미 읽은 바이트에 영향을 주지 않도록 안전 처리한다.
  O_NOFOLLOW 미지원 플랫폼은 주입 자체를 거부한다(fail closed).
- **P2-4 테스트 공백 보강** — `suiteExclusiveLock.test.ts` **43 → 54건**. 신규: post-guard lock 발행 실패(EACCES)
  / 계약 밖 writer와의 발행 충돌 / lock unlink syscall 실패 / guard 제거 unlink 실패 / 같은 token의 외부 격리 교체 거부
  / **TERM을 무시하는 중첩 child·손자의 상위 유예 후 KILL과 전 자손 소멸** / fixture 로더 4건(최종 symlink ·
  8192 통과·8193 거부 · 비일반 파일 · **경합 중 교체된 설정 미해석**) / wrapper·stress 양방향 fixture key 거부.
  주입은 기존 argv `--fixture-config`의 고정 enum(pause 지점 1개 추가: `before_guard_unlink_release`)과
  child fixture allowlist뿐이며, env seam·임의 명령 seam은 추가하지 않았다.
- **confused deputy 축소**: stress runner가 자기 fixture 파일을 그대로 물려주지 않고 **child에게 필요한 최소 설정**
  (`lockPath`/`injectDir`/`childMs`/`confirmMs`/`guardWaitMs`)만 새 파일로 명시 전달한다. wrapper 계약에서
  stress 전용 key(workers/testTimeoutMs/deadlineMs/suiteMode/suiteSleepMs)를 **삭제**했고 `inject`는
  `confirm_failure` 하나로 좁혔다 — 이제 그런 key가 담긴 설정으로 wrapper를 부르면 `fixture_unknown_key`로 거부된다.
- **검증 실측(offline, 네 번째 리비전 시점)**: `node --check`(.mjs 4종)·`tsc --noEmit` 0·`npm run build` PASS,
  `git diff --check` clean, git 가시 파일 **266건 NUL 0**.
  focused `suiteExclusiveLock.test.ts` **54/54**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬)** = exec **75/75** + core **353/353** + acceptance **71/71**(3회 동일).
  일반 suite 종료 후 stress **1회 PASS**(worker 4/4, elapsed 109.5s, `cleanupConfirmed:true`, `cleanupProblems:0`,
  `lockReleased:true`, `lockQuarantined:false`, 잔재 0).
  **비공허성(mutation)**: O_NOFOLLOW 제거 / 바이트 상한 제거 / 옛 `lstat`+`readFileSync` 복원 / 실패 분류 기본값을
  옛 방식으로 되돌림 / lock unlink 오류 무시 / guard unlink 오류 무시 / base record 검사 제거 /
  발행 신원 확인 제거(54건 중 40건 실패) / 그룹 대신 child만 kill — 9종 모두 해당 테스트가 실패함을 확인한 뒤
  **전부 원복**했다(원복 후 파일 해시 일치 확인).
  참고: 첫 시도의 CLI 기반 경합 테스트는 시도 횟수가 적어 옛 구현을 잡지 못했고, 로더를 in-process로 수천 번
  호출하는 형태로 바꾼 뒤 옛 구현을 잡아냈다(교체된 evil 설정을 해석함).

**다섯 번째 리비전(다섯 번째 fresh Codex Sol xhigh REQUEST_CHANGES 5건 반영: P1 4 · P2 1)** —
파괴 직전 재검증 · 정리 실패도 실패 · 재진입 기준 보존. 위 네 번째 리비전 서술을 **보강**한다(대체 아님):

- **P1-1 guard 제거 직전 재검증.** `releaseTransitionGuard`가 소유 확인 뒤 동기화 지점을 지나 **재검증 없이**
  unlink하던 창을 닫았다. 이제 "소유 확인 → 지점 → **같은 fd로 record(nonce)+inode 재확인** → 최종 경로 `lstat`
  신원 확인 → unlink"이며, 그 사이 다른 nonce/inode guard로 교체되면 **그 guard를 보존**하고 mechanism 실패로
  올려 다음 실행을 차단한다. Node 18에는 `unlinkat`·compare-and-unlink가 없어 마지막 확인과 unlink 사이 창을
  **0으로 만들 수 없다** — 창을 syscall 두 개로 줄이고 사후 실패를 숨기지 않는다(구현 주석에 한계 명시).
- **P1-2 격리 rename 직전 재검증.** 마지막 원본 신원 확인이 temp write/close **앞**에만 있어 그 사이 교체된
  외부 lock을 rename이 덮을 수 있었다. 이제 temp close 성공 뒤 rename 직전에 `readLockSnapshot`으로
  **기본 record + (dev,ino)** 를 다시 확인하고, 다르면 rename하지 않고 외부 lock과 guard를 보존한다.
  비교 기준(`expected.record`)이 없으면 아무것도 덮지 않는다.
- **P1-3 guard 이후 I/O·정리 실패는 성공 handle이 되지 않는다.** `withTransitionGuard`가 guard 반납 실패를
  무시하지 않고 `lock_guard_release_failed`(mechanism)로 올린다 → acquire/reentry가 전이를 완결하지 못한 채
  handle을 돌려주고 suite를 시작하는 경로가 사라졌다. 임시 파일 정리는 **열자마자 fd로 확보한 (dev,ino)와 일치할
  때만** unlink하고(신원 없거나 교체 시 blind unlink 금지·보고), 발행 후 정리 실패는 `lock_publish_cleanup_failed`,
  발행 실패 경로의 `closeSync` 오류와 `readGuardRecord`/`readLockSnapshot`의 fd close 실패도 삼키지 않는다.
  **상태 미변경 refusal만 guard 반납**이라는 계약은 유지한다.
- **P1-4 재진입 시점 trusted base 보존.** `tryReenterSuiteLock`이 검증 성공 시점의 **기본 record + dev/ino**를
  `base`로 돌려주고, wrapper가 보관해 cleanup 격리(`quarantineByToken({ expected })`)까지 명시 전달한다.
  같은 tokenHash지만 기본 record·inode가 다른 외부 교체 lock은 **보존**하고 guard를 남긴다.
  판정 순서는 tokenHash → 기본 record → quarantined → inode(= `verifyOwnership`과 동일)이고 `expected`는 필수다.
  테스트 전용 `quarantine` CLI 모드도 production과 같은 순서(재진입으로 기준 확보 → 그 기준으로만 격리)로 바꿨다.
- **P2-5 fixture 로더 close 실패를 거부한다.** `closeSync` 실패는 `fixture_close_failed`다. 그 경로 검증용 주입은
  `loadFixtureConfig`의 **세 번째 인자(in-process io seam, fs 함수 4개)** 뿐이며 production 진입점은 인자 2개로만
  호출한다 — argv·env·설정 파일 내용으로는 도달할 수 없으므로 이 문서의 "**외부** 주입은 argv 하나뿐" 계약과
  모순되지 않는다(회귀 테스트가 두 production 호출부의 호출 문자열을 고정한다). 임의 명령 seam은 없다.
- **테스트 54 → 62건(삭제·완화 0)**: guard 제거 직전 재확인 2케이스 / acquire·reentry guard 제거 실패 시 성공
  handle 없음 / 발행 후 임시 파일 정리 실패 / 격리 rename 직전 교체 보존 2케이스 / 동일 tokenHash 외부 교체 lock
  보존 / fixture close 실패 / production 호출부 io seam 미전달. 기존 1건은 강해진 계약대로 **강화**했다
  (acquire 경로 guard inode 교체: exit 1 → **exit 2 + 성공 handle 없음 + 차단**). pause 지점 4개만 추가
  (`before_publish_tmp_cleanup` / `before_quarantine_rename` / `before_guard_unlink_acquire` /
  `before_guard_unlink_reentry`).
- **검증 실측(offline, 다섯 번째 리비전 시점)**: `node --check`(.mjs 4종)·`tsc --noEmit` 0·`npm run build` PASS,
  `git diff --check` clean, git 가시 파일 **266건 NUL 0**.
  focused `suiteExclusiveLock.test.ts` **62/62**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬)** = exec **75/75** + core **361/361** + acceptance **71/71**(3회 동일).
  일반 suite 종료 후 stress **1회 PASS**(worker 4/4, elapsed 109.8s, `cleanupConfirmed:true`, `cleanupProblems:0`,
  `lockReleased:true`, `lockQuarantined:false`, 잔재 0).
  **비공허성(mutation) 6종**: guard 재확인 제거 / guard 반납 실패 무시(4건 실패) / 격리 rename 직전 재확인 제거 /
  재진입 기준 대신 현재 파일 수용 / 발행 후 임시 파일 정리 실패 삼킴 / fixture close 실패 삼킴 — 전부 해당 테스트가
  실패함을 확인한 뒤 원복했다(원복 후 focused 62/62 재확인, mutation 흔적 grep 0).

**여섯 번째 리비전(여섯 번째 fresh Codex Sol xhigh REQUEST_CHANGES 6건 반영: P1 1 · P2 1 · P3 1 + 추가 지적)** —
최종 엔트리 symlink 거부 · 성공 상태는 완결 후 공표 · 호출부 전수 계약. 위 다섯 번째 리비전 서술을 **보강**한다:

- **P1 최종 경로 symlink가 lock 신원 검사를 우회했다.** `readLockSnapshot`·`readGuardRecord`가
  `openSync(path, "r")`로 **symlink를 따라가서**, 원본 lock을 다른 이름으로 옮기고 그 자리에 symlink를 두면
  ⓐ release가 옮겨진 원본으로 소유를 인정하고 **symlink만 unlink한 뒤 해제 성공을 보고**하거나
  ⓑ quarantine이 **남의 symlink 엔트리를 rename으로 덮을** 수 있었다. 이제 공용 `openReadNoFollow`가
  `O_RDONLY|O_NOFOLLOW`로만 열고 symlink(ELOOP/EMLINK) → `lock_path_symlink`, `O_NOFOLLOW` 미지원 →
  `lock_nofollow_unsupported`로 **거부**하며 엔트리·대상 파일 모두 손대지 않는다(release는 guard 잔존,
  acquire는 상태 미변경 거부라 guard 정상 반납).
- **P2 guard 반납 실패 뒤에도 handle이 released로 남았다.** 전이 콜백이 `handle.state="released"`를 완결 전에
  세팅했고 catch는 `held`만 `failed`로 바꿨기 때문이다. 이제 콜백은 결과만 값으로 돌려주고
  `publishState`가 `withTransitionGuard` 정상 반환 뒤에만 상태를 바꾼다 → lock unlink 뒤 guard 정리/교체/unlink
  실패는 `failed` · `released=false` · problems · guard 잔존이며, wrapper·stress도 `lockReleased:true`로 보고하지
  않고 "해제가 완결되지 않았습니다(state=…)"를 남긴다. `quarantine()` 동일 규칙, acquire·reentry는 재감사만 했다.
- **추가 지적: io seam 회귀를 production 호출부 전수로 확대.** `scripts/**.mjs` 스캔으로 호출부를 발견해
  기대 5개(wrapper · stress · live runner 3종)와 목록 일치를 확인하고, 각 호출의 최상위 인자 2개와 첫 인자
  `process.argv.slice(2)`를 고정한다. 계약을 좁히지 않고 전수 커버리지를 택했으며 의존성·주입 표면은 늘리지 않았다.
- **P3 문서 수치 정정.** `docs/handoff/CODEX_HANDOFF.md`의 다섯 번째 리비전 "3개 + 문서 6개"를 실제 나열대로
  **"코드·테스트 4개 + 문서 7개"** 로 고쳤다. 이번 작업은 여섯 번째 리비전·여섯 번째 REQUEST_CHANGES이고
  APPROVE 0 · live evidence 3건 pending · M3d 미완료 · M4 not started는 그대로다.
- **테스트 62 → 67건(삭제·완화 0)**: symlink release/격리/acquire 3건 · lock unlink 뒤 guard 반납 실패 시
  handle `failed`(pause 지점에서 별도 프로세스가 guard를 같은 내용·다른 inode로 교체) · stress 요약
  `lockReleased:false` 1건. 기존 2건 강화(wrapper 미완결 보고 단정 · 호출부 전수 검사).
  **pause 지점·fixture key·env seam·임의 명령 seam 추가 0.**
- **검증 실측(offline, 여섯 번째 리비전 시점)**: `node --check`(.mjs 4종)·`tsc --noEmit` 0·`npm run build` PASS,
  `git diff --check` clean, git 가시 파일 **266건 NUL 0**.
  focused `suiteExclusiveLock.test.ts` **67/67**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **366/366** + acceptance **71/71**(3회 동일).
  **stress는 FAIL(exit 1)** — 상세·원인·부하 수치는 §1 "현재 테스트 기준" 참조(외부 부하 + 고정 5초 deadline 2건,
  lock 계층 계약은 정상, 테스트 완화·타임아웃 변경 없음).
  **비공허성(mutation) 4종**: `O_NOFOLLOW` 제거(symlink 3건 전부 실패) / guard 반납 전 `released` 공표(P2 3건 전부
  실패) / 로더 호출에 세 번째 인자 추가(인자 회귀 실패) / 임시 production 호출부 파일 추가(발견 회귀 실패) —
  전부 정확히 원복하고 원복 후 focused 67/67·24/24 재확인, 흔적 0, git 파일 목록 동일.

**일곱 번째 리비전(일곱 번째 fresh Codex Sol xhigh REQUEST_CHANGES 1건 반영: P2 1)** —
호출부 발견을 **구문 인식·재귀 감사**로 교체. 위 여섯 번째 리비전 서술을 **보강**한다(대체 아님).
이 리비전은 **테스트 1개 + 문서 7개**만 바꿨다(production 코드·live runner·의존성 **무수정**):

- **P2 production 호출부 발견이 전수가 아니었다.** 여섯 번째 리비전의 스캔은 `scripts` 루트와 `scripts/lib`
  **한 겹만** 훑고 `loadFixtureConfig(` **문자열 일치**로 호출부를 찾았다. 그래서 ⓐ 더 깊은 하위 디렉터리의 호출부
  (`scripts/fixtures/m3a/*.mjs`처럼 실제로 존재하는 깊이), ⓑ 식별자와 `(` 사이에 공백·줄바꿈·주석이 낀 호출,
  ⓒ `import { loadFixtureConfig as loadCfg }` 별칭 호출이 **감사를 통과한 채 세 번째 인자(in-process io seam)를
  넘길 수 있었다** — "새 호출부가 생기면 먼저 깨진다"는 문서화된 경계와 모순이다.
- **이제 감사는 구문 인식·재귀다(테스트 전용).** `scripts` 아래 모든 깊이의 일반 `.mjs`를 재귀 열거하고
  (symlink 파일·디렉터리는 production 소스로 신뢰하지 않고 따라가지 않으며 건너뛴 목록으로 보고),
  TypeScript AST로 로더 모듈에서 온 바인딩(별칭·namespace 포함)을 추적해 그 바인딩을 통한 호출만 검사한다.
  계약: 호출부 목록 == 기대 5개, 각 파일 호출 1회, 인자 정확히 2개, 첫 인자가 구조적으로 `process.argv.slice(2)`.
  미사용 바인딩·다중 호출·동적 로딩·재수출·비호출 참조도 문제로 보고한다. 문자열·주석은 오탐하지 않는다.
  **TypeScript는 이미 devDependency이며 테스트에서만 import한다 — production 의존성·주입 표면 추가 0.**
- **테스트 67 → 70건(삭제·완화 0)**: 기존 호출부 회귀 1건을 재귀·AST 판으로 **교체·강화**하고 신규 3건 추가 =
  ⓐ 재귀 열거 계약(임시 디렉터리에서 중첩 `.mjs` 발견 · symlink 파일/디렉터리 미추적 · 비 `.mjs` 제외),
  ⓑ 우회 mutation(중첩 경로 · 공백/주석 분리 호출 · 별칭 import · namespace import, 모두 세 번째 인자를 넘김)이
  전부 **발견되고 거부**됨 + 같은 실행에서 정상 합성 호출부는 통과, ⓒ 첫 인자 비정규형 · 미사용 바인딩 ·
  다중 호출 · 동적 로딩/재수출/비호출 참조 검출 + **문자열·주석 오탐 금지**.
  우회 케이스는 **순수 합성 소스**라 파일을 남기지 않고 production을 임시로 훼손하지도 않는다.
- **검증 실측(offline, 일곱 번째 리비전 시점)**: `node --check`(.mjs 4종)·`tsc --noEmit -p tsconfig.json` 0
  (+ 테스트 파일 단독 strict 타입체크 0)·`npm run build` PASS(파이프 없이 종료 상태 확인), `git diff --check` clean.
  focused `suiteExclusiveLock.test.ts` **70/70**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **369/369** + acceptance **71/71**.
  **stress는 이 세션에서 재실행하지 않았다**(여섯 번째 리비전의 FAIL 기록을 그대로 pending으로 남긴다).
  **비공허성(mutation) 4종**: ① 재귀 제거 → 열거·실호출부 테스트 2건 실패, ② 옛 문자열 스캔 게이트 복원 →
  공백/주석·별칭 케이스 실패, ③ 별칭 인식 제거 → 별칭 케이스 실패, ④ 인자 개수 검사 완화(`!== 2` → `< 2`) →
  세 번째 인자 거부 단정 전부 실패. 넷 다 **정확히 원복**했고 원복 후 타입체크 0 · focused **70/70** ·
  **24/24** 재확인, 소스 내 mutation 흔적 grep 0.

**여덟 번째 리비전(여덟 번째 fresh Codex Sol xhigh REQUEST_CHANGES 3건 반영: P2 2 · P3 1)** —
감사를 **URL 인식 · 동적 route 인식 · 노출 인식 · scope 인식 · 파싱 진단**까지 넓혔다.
위 일곱 번째 리비전 서술을 **보강**한다(대체 아님). 이 리비전도 **테스트 1개 + 문서 7개**만 바꿨다
(production 코드·live runner·의존성·fixture 로더 주석 **무수정**):

- **P2-1 지정자 정규화.** 상대 지정자를 문자열 경로로만 비교했기 때문에 `"./lib/fixture-config.mjs?v=1"`(query) ·
  `"…#seam"`(fragment) · `"./lib/fixture%2Dconfig.mjs"`(percent — Node ESM은 file URL을 디코드해 **같은 파일**로
  해석한다)로 import하면 감사를 통과한 채 **세 번째 인자(io seam)를 넘길 수 있었다**. 이제 URL 문법 순서대로
  정규화해 비교하고, 디코드 불가(`%zz`)·인코딩된 경로 구분자(`%2F`)는 **판정 불가 = fail closed**로 보고한다.
- **P2-2 계산된 동적 route.** 예전 감사는 `import()` 인자가 **문자열 리터럴일 때만** 판정해 연결·const 바인딩·
  완전 계산 route를 전부 흘렸다. 이제 bounded folding + **도달 가능한 문자열 조각** 규칙을 적용한다(위 §1
  "테스트 주입 계약 (여덟 번째 리비전) ⓑ" 그대로). `safe` 분기는 live runner의 정상 빌드 산출물 동적 import를
  깨지 않기 위한 **명시적 bounded 규칙**이며 whole-program 증명이 아니다.
- **P2-3 import-then-export 재수출.** 직접 `export … from`만 잡고 있어서, 정상 호출 뒤의
  `export { loadFixtureConfig }`는 **아무 문제도 보고되지 않았다**(ExportSpecifier를 참조에서 제외했기 때문) →
  다른 모듈이 감사 밖에서 세 번째 인자를 넘길 수 있었다. 이제 두 패스 수집으로 별칭·default·namespace 파생 노출·
  `export * as`까지 잡고 **소스 순서로 우회할 수 없다**.
- **P2-4 scope 인식.** 식별자 텍스트만 봤기 때문에 지역 `process` shadow가 첫 인자 정규형·원문 단정을 통과했고,
  shadow된 이름이 import 사용으로 계산됐고, namespace엔 미사용 검사가 없었다. 이제 선언 sweep으로
  **가릴 수 있는 선언이 하나라도 있으면 실패**시키고(conservative fail closed), shadow된 식별자를 사용으로 인정하지
  않으며, namespace도 같은 미사용 검사를 받는다.
- **P3 회귀 커버리지·문서 정확성.** 파싱 진단 fail closed를 더하고, 아래 신규 테스트로 각 방어의 결정론적 대조군을
  만들었으며, 상태 문서의 리비전·카운트·게이트 표기를 정정했다(**부하 acceptance 완료 게이트를 "비차단"으로
  적지 않는다**).
- **테스트 70 → 75건(삭제·완화 0)**: 신규 5건 = ⓐ query/fragment/percent 지정자 6형태(전부 세 번째 인자) 발견+거부 ·
  정규화 불가 2형태 fail closed · 로더 아닌 query 지정자 오탐 금지, ⓑ 계산된 동적 import 6형태 로더 확정 +
  확정 불가 3형태 fail closed + **정상 빌드 산출물 동적 import 대조군**, ⓒ 재수출 6형태(import-then-export ·
  export-before-import · 별칭 · default · namespace 파생 · `export * as`), ⓓ shadow 6형태(`process` const/파라미터 ·
  direct · namespace · 미사용 namespace · namespace 값 전달), ⓔ 파싱 진단 2형태.
  기존 production 호출부 테스트에 **정상 동적 import 대조군 3파일 열거** 단정을 추가했다.
  신규 케이스는 전부 **순수 합성 소스**라 파일 잔재·production 훼손이 없다.
- **검증 실측(offline, 여덟 번째 리비전 시점)**: `node --check`(.mjs 4종)·`tsc --noEmit -p tsconfig.json` 0
  (+ 테스트 파일 단독 strict 타입체크 0)·`npm run build` PASS(파이프 없이 종료 상태 확인), `git diff --check` clean.
  focused `suiteExclusiveLock.test.ts` **75/75**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **374/374** + acceptance **71/71**.
  **stress는 이 세션에서 재실행하지 않았다**(여섯 번째 리비전의 FAIL 기록을 그대로 **미충족·차단 게이트**로 남긴다).
  **비공허성(mutation) 8종**: ① query/fragment 분해 제거(2건 실패) ② percent 디코드 제거 ③ 동적 게이트를 문자열
  리터럴 전용으로 복원 ④ 노출 패스 제거 ⑤ `process` shadow를 정규형 판정에서 제외 ⑥ direct/namespace shadow 검출
  제거 ⑦ namespace 미사용 검사 제거 ⑧ 파싱 진단 무시 — 각각 해당 테스트가 실패함을 확인하고 **전부 정확히 원복**,
  원복 후 타입체크 0 · build PASS · focused **75/75** · **24/24** 재확인, 소스 내 `MUTATION` 흔적 grep 0.

**여덟 번째 리비전 재검토 결과(2026-07-26, fresh Codex Sol xhigh · read-only)** —
verdict = **`APPROVE_FEATURE_PROGRESSION`**. 리뷰는 read-only였고 테스트·네트워크·편집을 수행하지 않았다.

- **Category A(지금 차단): 없음.**
- **이것은 M3d 완료 APPROVE가 아니다.** stress는 여섯 번째 리비전의 FAIL 기록 그대로 미충족/pending이고,
  live runner 3종과 evidence 3건도 pending이며, **M3d는 여전히 미완료**다. 기존 완료 게이트는 전부 유효하다.
- **Category C(개선 backlog) 1건**: bounded computed dynamic specifier 분석이, 도달 가능한 조각 각각에는
  `fixture-config`가 없지만 런타임에 합성되는 구성(예: `"./lib/" + (flag ? "fixture-" : "other-") + "config.mjs"`)을
  놓칠 수 있다. 현재 production 호출부 5개는 **영향 없음**, 확률 낮음, 영향 반경은 "미래의 소스 레벨 호출부 감사
  누락"으로 한정, 유예 비용 낮음, 수정 공수 소~중. → 대장 `C-1`(§9.1)로 등록하고 이번에 고치지 않는다.
- **문서 정확성 정정(같은 Category C)**: "`loader`·`unproven` 둘 다 문제로 보고되므로 **조용히 통과하는 경로는
  없다**"는 서술은 사실이 아니다 — 위 `safe` 분기가 정확히 그 경로다. 정직하게 bounded된 규칙 서술과
  "정상 dist import 3파일이 호출부로 잡히지 않는다"는 **positive 대조군** 단정은 그대로 두고, 과장된 문장만 뺀다.
- 이 판정으로 **기능 진행(M4 계획 준비)은 계속할 수 있으나**, M3d 완료 선언과 M4 구현 착수는 별개다(아래 M4 절).

**남은 pending(사용자 액션)**: ⓐ **부하 acceptance 재실행**(조용한 호스트) 또는 5초 child startup deadline 방침
결정 — 이것은 **차단 게이트**다, ⓑ live runner 3종을 실제로 실행해 evidence 3건을 생성하는 것.
M3b.2·M3c-3b는 사람 대화형 TTY를 요구하므로 자동 실행 대상이 아니다.

```bash
npm run build && HARNESS_LIVE_M3A=1   node scripts/m3a-live-preflight.mjs
npm run build && HARNESS_LIVE_M3B2=1  node scripts/m3b2-live-handoff.mjs    # TTY 필수(대화형)
npm run build && HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs   # TTY 필수 + npx shadcn 네트워크
```

**3종 모두 PASS + evidence 3건 확인 + 부하 acceptance PASS + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로 판정하지 않는다.**
현재까지 받은 리뷰는 **REQUEST_CHANGES 여덟 번**(M3d.2 리비전 1~8에 각각 1회) + **진행 승인
`APPROVE_FEATURE_PROGRESSION` 한 번**(여덟 번째 리비전 재검토)이다. **M3d 완료를 승인한 리뷰는 없다.**
진행 승인을 "M3d APPROVE"로 줄여 적지 않는다. **M4 구현은 not started**이며 별도 사용자 승인이 필요하다.

### M4 — Agent Communication & Durable State

**상태(2026-07-27 갱신): M4a 최소 수직 기능 완료 · M4 전체는 미완료.**
사용자가 M4a 범위를 명시적으로 승인해 격리 worktree `work/m4a-durable-orchestration`
(base `ea764a5` = PR #10 merge commit)에서 구현·검증했다. 아래 "M4a" 절이 실제로 들어간 것이고,
그 뒤의 목표/완료 항목 중 M4a가 덮지 않은 부분은 **여전히 열려 있다**.

#### M4a — deterministic durable orchestration kernel · **완료(offline 검증)**

state-only/offline 수직 슬라이스다. **provider·LLM·프로세스를 하나도 띄우지 않는다.**
기존 `runWorkflow`/`mission`/`ExecutionProvider`와 `projects/<p>/outputs/run_state.json`은
**복제도 교체도 마이그레이션도 하지 않았다** — 별개 계약을 `src/exec` 안에 추가한 것이다.

구현 범위(완료):

- `src/exec/orchestrationTypes.ts` — 타입·상한·원시 검증자(slug/timestamp/sha256/path 정규화).
- `src/exec/agentMessage.ts` — §5.1 envelope + §5.2 타입별 Markdown body의 runtime validator
  (신규 검증 의존성 0, 기존 `liveEvidence.ts`와 같은 수동 closed validator 방식).
- `src/exec/orchestrationStore.ts` — 영속화·적재·closed state validator·결정론적 snapshot 렌더.
- `src/exec/orchestrationKernel.ts` — 상태 기계와 좁은 공개 API.
- `schemas/agent_message.schema.json` · `schemas/orchestration_run_state.schema.json` — 계약 문서
  (`additionalProperties:false` · enum · bounds · required). **보안 경계는 runtime validator다.**
- `scripts/m4a-offline-acceptance.mjs` + `scripts/acceptance.sh` Test 13(기존 테스트 무변경).

확정된 계약:

- task 상태는 `pending | ready | running | waiting_children | completed | blocked` **6개뿐**이다.
- 메시지 타입은 `task_assignment` · `spawn_request` · `result` · `blocker` **4종만** 구현했고
  §5.1의 나머지 6종은 schema·runtime 양쪽에서 거부한다(후속 마일스톤 확장).
- §5.1 envelope 필드를 그대로 유지하고 machine-readable envelope + human-readable Markdown body를
  함께 다룬다. body는 타입별 필수 h2 heading 전부 + 계약 밖 h2 금지 + 중복 금지 + 16 KiB 상한.
- spawn 상한: **task당 child 4 · child depth 최대 3(root=0) · run당 task 32**. child도 같은
  bounded API로 자기 child를 요청한다(nested spawn 테스트로 고정).
- ownership은 workspace-relative로 정규화하고 absolute·`..`·빈 경로·빈 segment·backslash·NUL을
  거부한다. **M4a에서 ownership은 기록·검증 메타데이터일 뿐 실제 파일 권한이나 provider 실행 권한이
  아니다.**
- `result`가 중앙으로 옮기는 것은 **bounded summary와 검증된 artifact 포인터뿐**이다
  (raw artifact 본문·raw transcript 복사 없음 — §3.2). 포인터는 workspace-relative path · SHA-256 ·
  revision · producer task · role을 기록한다.
- result 수락 **직전** artifact를 재검증한다: workspace 안의 일반 파일인지, 상위 디렉터리 symlink로
  workspace를 벗어나지 않는지(realpath 비교), 등록 revision/hash와 현재 hash가 같은지.
  symlink · missing · hash mismatch · workspace 탈출은 fail-closed다.
- child가 completed면 kernel이 **모든 child가 완료된 parent를 ready로**, **의존이 전부 완료된
  dependent를 ready로** 재계산한다. blocker는 child를 blocked로 만들고 영향받는 조상·dependent를
  blocked로 갱신한다(completed는 되돌리지 않는다).
- **agent가 다른 task 상태를 직접 바꾸는 API는 없다.** 공개 prototype 메서드 목록을 테스트가 고정하고,
  읽기 API는 전부 깊은 사본을 돌려준다.
- SoR는 `outputs/orchestration/<run-id>/run_state.json`, `events.jsonl`은 append-only 해시 체인,
  `messages/<message-id>.md`는 검증된 body 저장소, `snapshot.md`는 state에서 재생성하는 파생물이다.
- state에 `schemaVersion` · monotonic `revision` · `lastEventId`/`lastEventHash`를 둔다.
  저장은 **같은 디렉터리 임시 파일 → rename**이며, 과도한 fsync/crash hardening은 이번 범위가 아니다.
- **state↔event durable binding(2026-07-27 P0-1 수정)**: 커밋의 **마지막 이벤트**가
  `stateDigest`(그 커밋이 남기는 state **내용**의 SHA-256, chain 필드 `lastEventId`/`lastEventHash`
  제외 → 순환 없음)를 들고 간다. load는 이를 재계산·대조해(`assertStateEventBinding`)
  **형태가 유효한 run_state.json 편집만으로는 중앙 전이 계약을 우회할 수 없게** 한다
  (`state_event_binding_mismatch` / `state_event_binding_missing`). 커밋마다 이벤트가 최소 1건
  필요하므로 빈 이벤트 커밋은 `commit_without_event`로 거부한다.
  한계: 키 없는 digest라 state와 events.jsonl을 **모두** 일관되게 재작성하는 위조는 막지 못한다
  (감사 로그 자체가 조작되므로 감사 대상 — 대장 `C-7`, 상향 경로는 out-of-band 키 HMAC/서명).
- load는 fail-closed다: state runtime schema · event linkage · **state↔event binding** ·
  message body hash · artifact hash 중 하나라도 어긋나면 던진다.
  **실패를 null이나 빈 run으로 강등하지 않는다.**
  유효하지 않은 입력에서는 **state revision과 영속 파일 모두 전이 0**이다(검증 → 커밋 순서).
- ready 목록과 snapshot은 taskId 정렬로 결정론적이고, create 경로와 open 경로가 **같은 직렬화
  바이트**를 낸다(테스트가 단정).
- `roleId`는 **opaque slug 계약**이라 향후 7개 상위 specialist와 그 하위 specialist를 그대로 수용한다.
  **registry 등록·동시 실행은 이번에 하지 않았다.**

검증 실측(offline, 2026-07-27 — Codex P0 수정 후 최종):

- focused `src/exec/orchestrationKernel.test.ts` **37/37 PASS**(34 → 37, P0-1 회귀 3건 추가).
- `npm run build` PASS, `git diff --check` clean.
- `node scripts/m4a-offline-acceptance.mjs` **PASS(31/31 체크, exit 0)** — 29 → 31,
  위조 state 거부·복구 2건 추가. 네트워크·LLM·TTY·git write 없음.
- `npm test` **PASS** = exec **112/112**(75 → 112, M4a 37건) + core **374/374**(불변) +
  acceptance **75/75**(71 → 75, Test 13 4건).
- `npm test` 실행 횟수는 구현 체인 전체에서 **4회**다 — 구현 세션 3회(최초 / 카운트 확인 /
  미사용 코드 삭제 후 최종) + P0 수정 세션의 마지막 코드 변경 후 **1회**. **4회 모두 PASS.**
- **stress·live·반복 suite는 실행하지 않았다** — 이것들은 **nonblocking release-readiness backlog**
  (`B-1`/`B-2`)이며 M3 완료 게이트도 M4 선행 조건도 아니다(§0-0).

**M4a가 아닌 것(당시 미완료)**: 실제 provider/agent spawn · 7 specialist registry 등록·동시 실행 ·
나머지 6개 메시지 타입 · 범용 scheduler · **exclusive resource class 계약** · 멀티프로세스 writer lock ·
milestone approval manifest 전체 · provider bridge/MCP · CLI/UI.
이 중 **exclusive resource class와 writer lock은 아래 M4b에서 닫았고**, 나머지는 그대로 열려 있다.

#### M4b — exclusive resource class + deterministic scheduler + run writer lock · **완료(offline 검증)**

M4a 위에 **stack된 별개 PR**이다(branch `work/m4b-resource-scheduler`, base `805da35` = 리뷰 완료된
M4a 커밋). 이 세션도 state-only/offline이며 **provider·LLM·프로세스·두 번째 오케스트레이터를 만들지
않았다.** `runWorkflow`/`mission`/`ExecutionProvider`와 `projects/<p>/outputs/run_state.json`은
**무수정**이고 신규 런타임/dev 의존성·package/lockfile 변경도 **0**이다.
대장 `B-3`(exclusive class + scheduler) · `B-4`(멀티프로세스 writer lock)를 닫는 수직 슬라이스다.

구현 범위(완료 — 신규 파일 1개 + 기존 5개 확장):

- `src/exec/orchestrationTypes.ts` — `OrchestrationTask.resourceClasses` 필드 · 상한
  (`maxResourceClasses: 4`, `maxScheduleBatch: 8`) · `normalizeResourceClasses()`.
- `src/exec/orchestrationStore.ts` — state validator·`TASK_KEYS`·snapshot 렌더에 자원 선언 반영,
  공용 불변식 `assertExclusiveResourceClaims()`, run writer lock
  (`acquireRunWriterLock`/`releaseRunWriterLock` + `RunPaths.lockFile`), `CommitInput.base`와
  lock 안 base 대조(`stale_writer`).
- `src/exec/orchestrationKernel.ts` — `TaskSeed.resourceClasses?` · `scheduleReady()` ·
  `startScheduledBatch()` · `#mutate`가 직전 state를 커밋 기준으로 전달.
- `schemas/orchestration_run_state.schema.json` — `task.resourceClasses`(required, maxItems 4,
  uniqueItems, slug items) + 계약 설명.
- `src/exec/orchestrationKernel.test.ts` — focused 37 → **50건**(M4b 13건 추가, **삭제·완화 0**).
- `scripts/m4b-offline-acceptance.mjs`(신규, 42 체크) + `scripts/acceptance.sh` **Test 14**
  (**기존 Test 1~13 무변경**).

확정된 계약:

- **자원 선언은 durable이다.** task는 배타 자원 class를 **0..4개** 선언한다(slug · 사전순 · 중복
  거부 · 빈 배열 = 병렬 안전). state·schema·snapshot·`stateContentDigest`(→ state↔event binding)에
  모두 들어가므로 선언을 손으로 고치면 `state_event_binding_mismatch`로 거부된다.
- **점유는 `running` 동안만이다.** `waiting_children`은 중단 상태라 자원을 들고 있지 않는다
  (명시적 결정 — DECISIONS 참조). class 이름을 자유 문자열이 아니라 slug로 좁힌 것도 같은 이유다:
  정규화되지 않은 두 이름이 같은 자원을 뜻하면 직렬화 계약이 조용히 깨진다.
- **선언 주체는 중앙이다.** `resourceClasses`는 task 생성 입력이며 **agent가 envelope로 스스로
  선언하는 값이 아니다**(§5.1 envelope 필드 집합 무변경 — agent가 자기 자원 권한을 만들 수 없다).
- **scheduler는 kernel 안의 좁은 API 2개다**(두 번째 오케스트레이터 없음):
  `scheduleReady(limit?)`는 `taskId` 오름차순으로 훑어 ① running task가 점유한 class와
  ② **같은 batch에서 앞서 고른** class를 모두 피해 고른다(state·파일 변경 없음, 같은 state면 같은 답).
  `startScheduledBatch(limit?)`는 그 batch를 **커밋 1회**로 running으로 올린다(부분 적용 없음).
  batch 상한은 1..8이며 범위 밖은 `invalid_batch_limit`다.
- **직접 `startTask()`도 같은 규칙을 받는다.** 충돌 규칙은 메서드마다 복제하지 않고 **커밋 경로의
  공용 불변식**(`assertExclusiveResourceClaims`, `assertReferentialIntegrity` 안)에 한 번만 뒀다 →
  `startTask`든 앞으로 추가되는 어떤 전이 경로든 우회로가 없고, load도 같은 검사를 받는다
  (`resource_conflict`, 전이 0). mutation 테스트로 이 불변식이 실제 게이트임을 확인했다.
- **커밋은 run 단위 배타 writer lock 안에서만 일어난다.** `outputs/orchestration/<run-id>/run_state.lock`
  을 `O_CREAT|O_EXCL`로 발행하며 **대기하지 않는다**(`run_lock_held`, retry loop 없음).
  lock을 쥔 채 ⓐ 디스크 base 확인 → ⓑ message body → ⓒ events append → ⓓ snapshot → ⓔ state를 모두
  수행하고 정상·실패 모두 해제한다(정상 커밋 후 lock 파일 잔재 0).
- **stale writer는 fail closed다.** 호출자는 자기 커밋의 기준(직전 디스크 state의
  `revision`/`lastEventId`/`lastEventHash`)을 `CommitInput.base`로 넘기고, lock 안에서 디스크와
  대조한다. 같은 revision에서 열린 두 kernel 중 늦은 쪽은 `stale_writer`로 거부되며 **먼저 쓴
  writer의 결과를 덮지도 남의 event tail에 이어 붙이지도 않는다**(파일 전이 0). `base`는 optional이
  아니다 — 기본값을 두면 새 호출부가 조용히 lost-update 보호 밖으로 나간다.
- **정리는 자기 acquire만 한다.** 해제는 최종 엔트리를 `O_RDONLY|O_NOFOLLOW`로만 읽어 nonce를
  대조하고, 다르면 **남의 lock을 보존**한 채 `run_lock_owner_mismatch`로 올린다.
- **하위 호환 규칙(선택·문서화): M4a state는 마이그레이션하지 않고 거부한다.** `task.resourceClasses`가
  없는 상태 파일은 기본값으로 조용히 채우지 않고 `state_pre_m4b_unsupported`로 fail-closed하며,
  운영자는 **새 run을 만든다**. 기본값으로 채우면 ⓐ 그 state의 `stateDigest`가 어차피 어긋나 원인이
  불분명한 실패가 되고 ⓑ 선언이 없는 task를 "병렬 안전"으로 오해할 여지가 남는다. `schemaVersion`은
  `"1"`을 유지했다 — 그 상수는 메시지 envelope와 공용이라 올리면 M4a 계약·Test 13까지 흔든다.
  광범위한 마이그레이션 프레임워크는 만들지 않았다.

검증 실측(offline, 2026-07-27 — M4b 세션):

- focused `src/exec/orchestrationKernel.test.ts` **50/50 PASS**(37 → 50, M4b 13건 추가).
- `npm run build` PASS.
- `node scripts/m4b-offline-acceptance.mjs` **PASS(42/42 체크, exit 0)**.
  `node scripts/m4a-offline-acceptance.mjs` **PASS(31/31, 불변)**.
- `npm test` **PASS(1회)** = `test:exec` → `test:core` → acceptance 순서 통과,
  acceptance **81/81**(75 → 81, Test 14 6 checks). focused `npm run test:exec`는 이 세션에서
  **125/125**로 별도 확인했다(112 → 125). core 카운트는 이 세션에서 별도 캡처하지 않았으나
  `test:inner`가 `&&` 체인이므로 acceptance 단계 도달 자체가 exec·core 통과를 뜻한다.
  **`npm test`는 최종 코드 변경 후 1회만 유효 실행이다** — 두 번째 실행은 중복이라
  Codex가 시작 직후 중단시켰고 **결과로 세지 않는다**(부분 출력 없음).
- **stress·live·반복(3회) suite는 실행하지 않았다** — nonblocking release-readiness backlog
  (`B-1`/`B-2`)이며 M4b 게이트가 아니다.
- **비공허성(mutation) 4종**: ① 커밋 경로 공용 불변식 제거(M4b 3건 실패) ② stale base 대조 제거
  (stale writer 1건 실패) ③ lock EEXIST를 성공으로 처리(lock 2건 실패) ④ `startTask`의 중복 사전
  검사 제거(**0건 실패** → 그 검사는 공용 불변식과 중복이므로 **삭제했다**). ①~③은 정확히 원복했고
  원복 후 focused 50/50 재확인 · 소스 내 `MUTATION` 흔적 grep 0.

**M4b가 아닌 것(여전히 미완료 = M4c 잔여)**: sibling 전달·reviewer 왕복과 나머지 6개 메시지 타입 ·
milestone approval manifest · 7 specialist registry 등록·**실제 7-agent 동시 실행** · provider
bridge/MCP · CLI/UI. 그리고 이번에 **의도적으로 넣지 않은 것**: 커밋 중간 크래시 복구·fsync 하드닝
(`C-4`) · stale lock 자동 회수/소유자 생존 확인(`C-8`) · state schema 마이그레이션 도구(`C-9`) ·
queue/retry/priority/fairness 프레임워크(`C-10`).

#### M4c — sibling/reviewer 라우팅 + 메시지 10종 + milestone approval manifest + specialist registry · **완료(offline 검증)**

M4b 위에 **stack된 별개 PR**이다(branch `work/m4c-routing-approval`, base `ab63eac` = 리뷰 완료된
M4b 커밋). 이 세션도 state-only/offline이며 **provider·LLM·프로세스·두 번째 오케스트레이터·범용
scheduler/mailbox를 만들지 않았다.** `runWorkflow`/`mission`/`ExecutionProvider`와
`projects/<p>/outputs/run_state.json`은 **무수정**이고 신규 런타임/dev 의존성·package/lockfile 변경도
**0**이다. 대장 `C-6`을 닫는 수직 슬라이스다.

구현 범위(완료 — 신규 파일 2개 + 기존 7개 확장):

- `src/exec/orchestrationTypes.ts` — 메시지 타입 4 → **10종**, `CENTRAL_MESSAGE_TYPES`,
  `SUMMARY_REQUIRED`, 새 heading 집합 6개, `MilestoneApprovalManifest`/`ApprovedDependency` 타입,
  `MessageIndexEntry.routeToTaskId`/`acknowledgedAt`, `OrchestrationRunState.manifest`,
  이벤트 `delivery_acknowledged`, manifest 상한 9개.
- `src/exec/approvalManifest.ts`(**신규**) — §8 manifest closed validator · 7 specialist registry ·
  M5용 **순수 조회 술어 3개**(`commandAllowed`/`dependencyAllowed`/`networkDomainAllowed`).
  이 모듈은 아무것도 실행하지 않는다(shell 파싱·설치·네트워크·merge 없음).
- `src/exec/orchestrationStore.ts` — `MESSAGE_KEYS`/`STATE_KEYS` 확장, manifest 검증·bind 대조,
  `state_pre_m4c_unsupported`, roleId registry 검사, 공용 불변식
  `assertManifestOwnership`/`assertSessionLimit`, `pendingDeliveries`, snapshot의 승인·registry·
  route·pending 섹션, digest에 manifest 포함.
- `src/exec/orchestrationKernel.ts` — `create`의 필수 `manifest`, `#mutate`의 만료 게이트,
  좁은 진입점 6개(`submitStatusUpdate`/`requestReview`/`submitReviewResult`/`requestRevision`/
  `submitDecisionRequest`/`recordDecision`) + `acknowledgeDelivery` + 읽기 3개
  (`getManifest`/`listPendingInbox`/`nextPendingDelivery`), scheduler의 세션 예산 반영.
- `schemas/milestone_approval_manifest.schema.json`(**신규**) ·
  `schemas/agent_message.schema.json`(10종 + heading) ·
  `schemas/orchestration_run_state.schema.json`(manifest required · route 필드 · specialistRoleId).
- `src/exec/orchestrationKernel.test.ts` — **파일 단독** focused 50 → **67건**(M4c 17건 추가, 삭제·완화 0).
  같은 17건으로 `npm run test:exec` 전체 suite는 125 → 142건이 된다.
- `scripts/m4c-offline-acceptance.mjs`(신규, 77 체크) + `scripts/acceptance.sh` **Test 15**
  (**기존 Test 1~14 무변경**).

확정된 계약:

- **envelope 필드 집합은 §5.1 그대로다.** route·권한을 envelope에 넣지 않았다 — 전달 대상은
  message index의 `routeToTaskId`(중앙이 정함)이고, 수령 시각은 `acknowledgedAt`이다.
  agent는 자기 task의 메시지만 제출할 수 있고 **남의 mailbox에 직접 쓰거나 남의 상태를 바꾸는 API는 없다.**
- **heading 계약**: `task_assignment`·`spawn_request`·`result`·`review_result`·`blocker`/
  `decision_request`(공유)는 §5.2 그대로. §5.2가 지정하지 않은 `status_update`
  (Current Status / Progress Since Last Update / Next Step) · `review_request`
  (Review Target and Hash / Review Scope / Required Checks) · `revision_request`
  (Findings to Address / Required Changes / Verification Required) · `decision`
  (Decision / Rationale / Scope of Effect)는 **M4c가 정한 최소 closed set(각 3개)** 이다.
- **summary 계약**: `task_assignment`·`spawn_request`는 null, 나머지 8종은 bounded summary 필수
  (`SUMMARY_REQUIRED`). 커밋 경로와 load가 같은 판정을 한다.
- **중앙 경유 라우팅**: sibling 전달은 발신 task가 중앙에 제출하고(수신자는 언제나 `orchestrator`),
  중앙이 **같은 parent이거나 둘 사이 직접 의존**인지 확인한 뒤에만 route를 남긴다.
  전달 대상은 taskId 또는 **유일하게 식별되는** roleId로만 해석하며 자기 자신(`route_self`) ·
  미상(`unknown_recipient`) · 모호(`ambiguous_recipient`) · orchestrator(`invalid_recipient`) ·
  종료 상태(`recipient_unavailable`) · 무관(`route_not_related`)은 전부 거부다(전이 0).
- **reviewer 왕복**: 중앙 `review_request`는 **대상이 completed**이고 **reviewer가 그 대상에 의존**하며
  **reviewer가 fresh**(pending/ready · 결과·blocker·artifact 없음)할 때만 나간다(§3.3 저자 분리).
  `review_result`는 받은 `review_request`가 있어야 하고 중앙에서 끝난다. `revision_request`는
  **그 대상에 대한 review_result가 이미 있을 때만** 나간다. 이 왕복은 **task 상태를 바꾸지 않는다** —
  reviewer는 평소처럼 `result`로 완료한다.
- **decision 왕복**: `decision_request`는 중앙에서 끝나고, `decision`은 **미응답 요청이 있을 때만**
  요청 task의 inbox로 간다.
- **전달 목록은 durable state에서만 계산한다**: `createdAt` → `messageId` 정렬이라 재시작 후에도
  같은 순서·같은 다음 전달이다. 수령은 좁은 중앙 전이 하나(`acknowledgeDelivery`)이고 durable event
  `delivery_acknowledged`를 남기며 상태 전이는 없다. **범용 queue/retry/우선순위는 만들지 않았다.**
- **승인 manifest는 run 생성 시 필수 bind다.** 기본값을 두면 그것이 곧 조용한 자동 승인이다.
  manifest는 state·digest·snapshot(bounded·비밀 아님)에 들어가므로 승인 범위를 손으로 넓히면
  `state_event_binding_mismatch`로 거부된다. milestone 불일치는 `manifest_milestone_mismatch`.
- **강제되는 권한(지금 전부)**: root/dependent task ownership은 `ownershipByTask`에 **명시 승인**이
  있어야 하고, 모든 ownership은 `writableRoots` 안이어야 하며, child는 **parent 범위의 부분집합**만
  위임받는다. 동시 running은 `maxSessions` 이하이고, 만료 후 변경은 전부 거부다.
  이 검사들은 M4b의 자원 불변식과 **같은 커밋 경로 공용 불변식**이라 새 전이 경로도 load도 우회할 수 없다.
- **`allowedCommands`/`allowedDependencies`/`allowedNetworkDomains`/`maxTokens`/`maxElapsedMs`/
  `localMergeAllowed`는 기록·조회 전용**이다. M5 executor는 순수 술어 3개로 **묻기만** 한다
  (deny-by-default · 정확히 pin된 버전만 · 하위 도메인 자동 허용 없음 · 문자열 동치 명령).
  `localMergeAllowed`가 true여도 kernel은 git 조작을 하지 않으며, repo hard deny가 항상 더 강하다.
- **하위 호환**: manifest가 없는 pre-M4c state는 마이그레이션하지 않고
  **`state_pre_m4c_unsupported` 하나로 fail-closed**한다(자동 승인 금지 · 마이그레이션 프레임워크 없음).
  `schemaVersion`은 `"1"`을 유지했다(M4b와 같은 이유 — envelope와 공용).
- **7 specialist registry**: `research`/`pm`/`ux`/`design`/`tech-lead`/`dev-lead`/`qa-security`.
  `roleId`는 이 목록이거나 `<상위>.<하위>`(한 겹)여야 하고 그 밖은 `unknown_role`이다.
  registry는 **중앙 metadata**이며 run마다 7개 task를 요구하지 않고, 프로세스도 띄우지 않으며,
  provider/모델 라우팅을 중복 정의하지 않는다.

검증 실측(offline, 2026-07-27 — M4c 세션):

- focused **파일 단독** `src/exec/orchestrationKernel.test.ts` **67/67 PASS**(50 → 67, M4c 17건 추가,
  삭제·완화 0). **142/142는 파일 단독 focused가 아니라 `npm run test:exec` 전체 suite 수치**다(125 → 142).
- `npm run build` PASS, `git diff --check` clean.
- `node scripts/m4c-offline-acceptance.mjs` **77/77 PASS(exit 0)** ·
  `node scripts/m4a-offline-acceptance.mjs` **31/31 PASS** ·
  `node scripts/m4b-offline-acceptance.mjs` **42/42 PASS**.
- `npm test` **PASS(최종 코드 변경 후 1회)** = exec **142/142** + core **374/374** + acceptance
  **92/92**(81 → 92, Test 15 11 checks).
- **stress·live·반복(3회) suite는 실행하지 않았다** — nonblocking release-readiness backlog
  (`B-1`/`B-2`)이며 M4c 게이트가 아니다.
- **비공허성(mutation) 4종**: ① `assertManifestOwnership` 호출 제거(ownership 게이트 1건 실패)
  ② `assertSessionLimit` 호출 제거(maxSessions 1건 실패) ③ sibling 관계 검사 무력화(전달 거부 1건 실패)
  ④ `#mutate`의 만료 게이트 제거(만료 1건 실패). 넷 다 **정확히 원복**했고 원복 후 파일 SHA-256 일치 ·
  소스 내 `MUTATION` 흔적 grep 0 · **파일 단독 focused 67/67** 재확인.

**M4c가 아닌 것(의도적 범위 밖)**: M5 provider bridge/autopilot CLI · 실제 7-agent 동시 실행 ·
장기 stress/live · UI/dashboard · 크래시·fsync 하드닝(`C-4`) · stale lock 자동 회수(`C-8`) ·
state schema 마이그레이션 도구(`C-9`) · queue/retry/fairness(`C-10`/`C-12`) · manifest 재승인 전이(`C-11`).

#### M4 전체 — **완료(2026-07-27, offline 검증)**

**상태: 완료.** M4a(kernel) + M4b(자원 class·scheduler·writer lock) + M4c(라우팅·메시지 10종·
승인 manifest·registry)가 아래 목표·완료 항목을 전부 덮었고, 세 offline acceptance와 전체 suite가
증거다. **M5는 미완료다.** 아래 원문은 M4b 시점 기록이며 이력으로 보존한다.
배송 우선 원칙(§9.1)에 따라 **M4 계획 준비(계획서·task DAG·영향 파일·승인 manifest 초안 작성)는 지금 해도 된다.**
계획 준비는 구현이 아니며, 코드·schema·의존성을 건드리지 않는다.

**중첩 실행 제안(승인 전 — 자동 발동 금지)**: 별도로 승인된 **offline·격리** M4 작업은,
**미검증 live evidence를 소비하지 않는 범위에서만** 남은 외부 M3d 작업(부하 acceptance 재실행 · live runner 3종)과
시간적으로 겹칠 수 있다. 단 다음은 그대로다 — ⓐ **M3d는 그 게이트가 닫히기 전까지 미완료**이고,
ⓑ **M4도 M3d 게이트가 닫히기 전에는 자기 통합·acceptance 게이트를 통과할 수 없다**,
ⓒ 이 중첩은 **제안일 뿐이며 M4 사용자 승인 없이는 발동하지 않는다**(승인받았다고 적지 않는다),
ⓓ hard deny와 모든 승인 경계는 유지된다.

목표:

- envelope/schema/type별 Markdown template.
- orchestration run state, append-only events, artifact revision/hash, deterministic snapshot.
- 누락·변조·hash mismatch fail-closed.
- **exclusive resource class 계약(M3d.1 실측 반영)**: durable state와 scheduler는 task/테스트가 요구하는
  배타 자원 class를 선언할 수 있어야 하고, 같은 class를 요구하는 작업은 lock으로 직렬화한다.
  프로세스 전역 또는 tmp 전역 상태를 관찰하는 테스트·runner는 이 class를 명시적으로 선언하며 동시 실행하지 않는다.

완료(항목별 현황 — 2026-07-27, M4b 반영):

- mock parent/child/sibling/reviewer 왕복 → **충족(M4c)**. parent↔child(중첩 포함)와 dependent 라우팅은
  M4a에서, **sibling 전달과 reviewer 왕복(+ decision 왕복, 메시지 10종)** 은 M4c에서 닫았다
  (focused 17건 + acceptance Test 15의 77 체크).
- central process 재시작 후 state만으로 ready task와 다음 전달을 동일하게 복구 → **충족**(M4a).
  M4b에서 **점유 중인 배타 자원과 scheduling 결정까지** 재시작 후 동일함을 확인했다.
- raw transcript 없이 결과 전달, schema 오류는 state 전이 0 → **충족**(M4a).
  M4b의 lock 경합·stale writer 거부도 **전이 0**이다.
- 동일 exclusive resource class를 요구하는 두 작업이 동시에 실행되지 않음을 scheduler 테스트로 확인
  → **충족(M4b)**. focused 13건 + offline acceptance Test 14(42 체크)가 ⓐ 같은 class 두 ready 중 하나만
  시작 ⓑ disjoint/자원 없는 task는 같은 batch 동반 ⓒ 직접 `startTask`도 같은 불변식 ⓓ 재시작 후 동일
  결정 ⓔ holder 완료 시 해제를 고정한다. **이것으로 대장 `B-3`을 닫았고, 같은 세션에서 `B-4`(멀티프로세스
  writer lock)도 닫았다.**

**M4 완료 판정(2026-07-27).** 위 네 항목이 M4a·M4b·M4c의 focused/offline/전체 suite 증거로 전부 충족돼
**M4 전체를 완료로 적는다.** M4a·M4b·M4c 승인은 각각 **그 범위에 한정된 승인**이었고, 세 범위가 모두
구현·검증됐다. **M5(provider bridge·autopilot·실제 7-agent 동시 실행)는 미완료이며 별도 사용자 승인이
필요하다.** 위 §M4 절의 중첩 조건 ⓐ~ⓓ 중 M3d 관련 조건은 M3 완료로 해소됐다(§0-0).
(이전 판 "M4 전체를 완료로 적지 않는다 — sibling/reviewer 라우팅과 milestone approval manifest가
남아 있다"는 **2026-07-27 M4c 이전 기록**이며 이력으로 읽는다.)

### M5 — Dual-provider Bridge + Autopilot Bootstrap

목표:

- `CodexCliProvider` discovery/offline/live.
- Claude worker ↔ Codex planner/reviewer 자동 전달.
- milestone approval manifest와 `harness autopilot`(최종 명칭은 구현 계획에서 확정).
- self-hosting stable-controller/worktree/restart 경계.
- **bridge 실행 요건(Claude bootstrap 실측 반영)**: 세션은 진행/이벤트를 스트리밍하고,
  no-progress deadline과 wall-clock deadline을 bounded하게 강제하며, cancellation과 descendant cleanup을
  지원한다. **최종 결과만 반환하는 silent session은 허용하지 않는다.**
- **exclusive resource class 준수**: bridge가 실행하는 테스트·runner 중 프로세스 전역·tmp 전역 상태를 관찰하는
  것은 M4의 배타 class/lock을 통해서만 실행하고 병렬 실행하지 않는다.

완료:

- 작은 fixture repo에서 Codex plan → Claude implement → test → fresh Codex review → revise → verify.
- 사용자의 프롬프트/완료 보고 수동 복사 0회, milestone 승인 1회.
- non-interactive approval 불가 작업은 hang 없이 paused 상태로 복구 가능.
- 진행 이벤트 스트리밍 관측, deadline 초과·cancellation 시 descendant까지 정리되고 잔존 프로세스 0.
- 전역 상태 관찰 작업의 동시 실행 0(거짓 실패 재현 없음).

#### M5a — 실행 경계 + `CodexCliProvider` + JSONL 어댑터 · **구현·offline 검증 완료 / live 미검증**

**상태(2026-07-27): M5a만 완료. M5 전체는 미완료다.** 사용자가 M5a 범위를 명시적으로 승인해 격리 worktree
`work/m5a-codex-provider`(base `85ebe883ff96fad1070a508f5d4a28f7fc637b8e`)에서 구현했다.
**실제 Codex 추론·네트워크·인증은 하지 않았다** — 검증은 전부 결정론적 fake CLI와 in-process seam이다.
기존 `ExecutionProvider`/`runWorkflow`/`mission`/`orchestration*`은 **무수정**이고 신규 의존성·
package/lockfile 변경도 **0**이다. 두 번째 오케스트레이터·상태 시스템을 만들지 않았다.

구현 범위(완료 — 신규 3 + 픽스처 1 + 기존 1 확장):

- `src/exec/executionBoundary.ts`(신규) — 대장 `B-5`를 닫는 **단일 fail-closed 실행 경계**.
- `src/exec/codexCliProvider.ts`(신규) — `ExecutionProvider` 구현.
- `src/exec/codexStreamParser.ts`(신규) — `codex exec --json` JSONL → 기존 `SessionEvent`.
- `src/exec/__fixtures__/fake-codex.mjs`(신규, 테스트 전용) + 테스트 3종.
- `src/exec/types.ts` — `CodexSessionOptions` + `SessionSpec.codex?` **추가만**(`SessionEvent`·
  `ExecutionProvider`·기존 필드 무변경).

확정된 계약:

- **프로세스는 승인된 커밋에서만 뜬다.** `verifyExecutionBoundary()`가 ⓐ manifest closed 재검증
  ⓑ 만료(**`now >= expiresAt`이면 거부** — 실행 경로는 kernel보다 좁다) ⓒ 경로 계약(절대·NUL 없음·디렉터리)
  ⓓ realpath 정규화 + `git rev-parse --show-toplevel` 대조로 **checkout 루트 신원**
  ⓔ **controller·실행 checkout 양쪽 HEAD == `approvedCommit`**(같은 checkout이면 1회)를 확인한다.
  provider는 **spawn 직전마다** 이 함수를 부르고, 거부 경로 전부에서 **spawn 횟수 0**을 테스트가 고정한다.
  이 함수는 provider 중립이라 이후 Claude provider·controller가 그대로 재사용한다.
  **만료는 두 번 본다(2026-07-27 2차 리비전).** ⓑ의 첫 검사와 spawn 사이에는 **비동기 git 조회**가 있어
  그 사이에 승인이 만료될 수 있었다. 이제 `nowMs`에 **함수(clock)** 를 주면 `revalidateSync()`(spawn 직전
  마지막 동기 검증)가 **시각을 다시 읽어** `now >= expiresAt`을 재확인하고, 읽을 수 없는 시각도 거부한다
  (fail closed). 숫자를 주면 그 시각으로 고정된다.
- **실행 파일은 신뢰된 명시 절대경로 하나뿐이다.** provider 코드는 `process.env`를 **읽지 않는다**
  (PATH·`HARNESS_CODEX_BIN` 조회 없음). spawn 직전마다 그 경로가 **정규 · symlink 아님 · 일반 파일 ·
  실행 비트 있음 · group/other 쓰기 없음**임을 확인한다. 경로 선택·신뢰는 **controller의 책임**이다.
- **argv는 배열, 프롬프트는 stdin.** fresh와 resume의 **배치가 다르다**(실측 근거는 `B-6` 증거란):
  fresh `exec --json --model <m> --config model_reasoning_effort="<e>" --config mcp_servers={}
  --strict-config --ignore-user-config --ignore-rules --sandbox read-only --cd <targetRoot>
  [--ephemeral] [--output-schema <p>] -`,
  resume `exec --sandbox read-only --cd <targetRoot> resume <uuid> --json --model … --config …
  --strict-config --ignore-user-config --ignore-rules [--output-schema <p>] -`
  (**`--sandbox`/`--cd`는 `resume` 앞** — subcommand-local로는 받지 않는다. resume에 `--ephemeral`은 없다).
  **bypass 계열 플래그와 `danger-full-access`는 컴파일 단계에서 도달 불가**하고 `--last`는 쓰지 않는다.
- **sandbox는 `read-only` 고정이다(M5a hard deny).** Codex는 planner/reviewer이므로 `workspace-write`는
  거부하고 프로세스를 띄우지 않는다. 쓰기 모드는 manifest의 task 소유권·writableRoots를 실제로 집행하는
  **task-bound 권한 계층**이 생긴 뒤 별도 승인으로만 되살린다.
- **strict empty MCP는 ambient 설정에 기대지 않는다**: 격리 `CODEX_HOME`이 **필수**이고
  **정규 · symlink 아님 · 0700 · 사용자 홈 아님**을 spawn 전에 검증한다. 여기에
  `--config mcp_servers={}` · `--strict-config` · `--ignore-user-config` · `--ignore-rules`를 더하고,
  자식 env는 **`CODEX_HOME` 하나뿐**이다(PATH조차 상속하지 않는다). **auth 파일을 복사하거나 영속화하지
  않는다.** 스트림에 MCP 호출 이벤트가 보이면 비가역 실패이고 **그 세션은 닫힌다**(오염된 thread를
  resume으로 이어가지 않는다).
- **`CODEX_HOME`은 provider가 소유하는 수명이다(2026-07-27 2차 리비전).** 이전 계약은 "**모든** send가
  빈 홈을 요구"했는데, 비-ephemeral resume은 codex가 그 홈에 남긴 세션 상태를 **필요로** 하므로
  구조적으로 모순이었다(ephemeral:false + `send`는 production에서 항상 `codex_home_not_empty`).
  현행: **첫 invocation은 여전히 비어 있는 홈을 요구**해 ambient config·auth·MCP를 0으로 만들고,
  그때 확보한 **디렉터리 신원(dev+ino)** 을 provider가 고정한다. 이후 invocation(resume)은
  **신원이 같을 때만** 비어 있지 않은 홈을 허용하고 경로 계약·0700·사용자 홈 금지·strict 플래그·단일
  `CODEX_HOME` env는 그대로 재검증한다. **교체(inode 다름) · symlink화 · 권한 완화 · provider가 소유하지
  않은 기존 상태로의 resume은 spawn 0**이다. 한계(주장하지 않는 것): 이 게이트는 **경로 교체·권한 완화·
  소유하지 않은 상태**를 막는 것이고 **같은 uid로 동작하는 공격자에 대한 내성은 아니다**(소유자 자신은
  언제든 자기 홈을 쓸 수 있다). live 인증은 여전히 `B-7`이고 M5a는 **auth를 쓰지도 복사하지도 않는다**.
- **비가역 프로토콜 실패 + 종료 결과 정확히 1건.** malformed·과대 줄, 중복/모순 종료 이벤트, MCP 관측,
  세션 신원 위반, 종료 뒤 신원·최종 메시지 변경 시도, 이벤트 상한 초과는 **되돌릴 수 없는 실패**이고,
  **성공 종료 뒤에 실패·error·MCP가 와도 실패**다. `finish()`가 stream outcome + exit code/signal을 합쳐
  결과 하나를 만들므로 silent stream·정상 종료 뒤 비정상 exit도 실패다(조용한 성공 경로 없음).
  **형태가 유효한** 모르는 이벤트 타입만 bounded unknown으로 남기고 성공 근거로 쓰지 않는다.
- **세션 신원은 불변의 정규 UUID 하나이고 신원이 먼저다.** **의미 있는 첫 JSONL 이벤트가 신원을 세워야
  한다** — `thread.started`가 정규 UUID를 정확히 한 번 줘야 하며 빈 값·형식 위반(`--last` 포함)·중복·모순·
  부재, 그리고 invocation 간 id 충돌은 전부 프로토콜 실패다. **신원 확립 전에 온 이벤트는**(status ·
  assistant · unknown · error 포함) **비가역 실패(`missing_session_id`)이고 내용·도구 payload를 전달하지
  않는다.** 뒤늦은 `thread.started`도, 그 뒤의 정상 종료도 이것을 되돌리지 못한다(2026-07-27 2차 리비전).
  **검증되지 않은 텍스트로 resume 인자를 만들지 않는다.**
- **durable 문자열 위생**: `SessionEvent.raw`는 원본 JSON이 아니라 **bounded sanitized metadata
  projection**이다. 추론 원문 · 명령 문자열 · stderr/error 본문 · secret · 프롬프트 · 환경변수 · 전체 argv ·
  모르는 이벤트 payload는 **어떤 이벤트에도** 실리지 않는다(명령은 상태·exit code·길이만 남는다).
  error/stderr 요약은 상한 + `redactSecrets`를 통과한 것만이다. **정정(2026-07-27 2차 리비전)**: 최종
  agent message는 이 배제 목록에 들지 않는다 — **상한(`MAX_TEXT_CHARS`)을 지난 최종 본문은
  `assistant.text`와 `result.text`로 의도적으로 전달된다**(리뷰 판정·`--output-schema` 본문이 그 경로로 온다).
  이전 서술("agent message 전문이 어떤 이벤트에도 실리지 않는다")은 `raw` 얘기를 이벤트 전체로 잘못 넓힌
  것이었다. `raw`에는 여전히 길이·상태·exit code 같은 스칼라만 남는다. **새 durable raw 로그를 만들지 않았다.**
- **수명은 멱등 상태 기계 하나다**: 검증을 모두 통과한 뒤에만 큐를 발행하고, harness 세션 id 중복 start ·
  실행 중 send · 중지된 세션 send를 거부한다. 실패한 start/send는 **열린 오염 큐나 잔여 상태를 남기지 않고**,
  동기 spawn 예외 · error+close 경합 · stdin 오류 · `stop`은 **종료 결과 1건**으로 수렴한다
  (`stop`은 결과가 정착한 뒤에만 정리한다). 프로세스 그룹 · TERM→유예→KILL · deadline · 자손 0은
  **이 범위가 아니다**(`C-18`, M5c).

#### M5a fresh Codex 독립 리뷰와 리비전 (2026-07-27)

첫 두 커밋(`115e0be`+`6ae7fd6`, 범위 `85ebe883..6ae7fd6`)을 **fresh Codex `gpt-5.6-sol` xhigh ·
read-only · strict empty MCP**가 독립 리뷰했다. **판정 REVISE.** 작성 세션은 playbook §6에 따라
**단 한 번 resume**해 A 항목을 전부 고쳤다(리비전 커밋 `bdd5507`). 리뷰는 supervisor가 별도로 돌린
read-only Codex 세션이며 **이 provider/live 경로로 Codex 추론을 돌린 적은 없다**(§검증 실측).

| # | 분류 | finding | 처리 |
|---|---|---|---|
| 1 | **A (P0)** | production이 `HARNESS_CODEX_BIN`/PATH로 **임의 실행 파일**을 고를 수 있었다 | **fixed** — env 조회 제거, 신뢰된 명시 절대경로 필수 + spawn 직전 신원 검증(정규·비symlink·일반 파일·실행 비트·타인 쓰기 금지). 테스트가 provider 코드에 `process.env`가 없음을 고정 |
| 2 | **A (P0)** | `workspace-write`가 spec만으로 열렸다(집행 계층 없음) | **fixed** — M5a hard deny(read-only 전용), 요청 시 spawn 0 |
| 3 | **A (P1)** | resume argv가 설치된 CLI에서 파싱되지 않는 배치였다 | **fixed** — fresh/resume 배치 분리 + `--strict-config`·`--ignore-user-config`·`--ignore-rules` 추가 + 실측 근거 파싱 계약 테스트(자기 자신과 비교하던 기대값 제거) |
| 4 | **A (P1)** | 세션 신원이 검증 없는 텍스트였다 | **fixed** — 불변 정규 UUID 1개, 적대적·중복·모순·부재·invocation 간 충돌 전부 비가역 실패 |
| 5 | **A (P1)** | `CODEX_HOME`이 검증되지 않았다 | **fixed** — 정규·비symlink·0700·비어 있음·사용자 홈 아님 검증, 자식 env는 `CODEX_HOME` 하나. fake CLI 채널을 cwd로 옮겨 **env 테스트 seam 없음** |
| 6 | **A (P1)** | 실행 신원 TOCTOU · argv cwd에 원본 문자열 사용 | **fixed** — 비정규/symlink 입력 거부, `targetRoot`만 사용, spawn 직전 동기 신원+HEAD 재확인(Node 한계상 창 0은 아니며 최소화+fail closed) |
| 7 | **A (P1)** | 파서 fail-open(“성공 뒤 실패”가 성공으로 보고될 수 있었다) | **fixed** — 비가역 프로토콜 실패 도입. 기존 중복-종료 테스트는 **삭제·완화 없이 갱신** |
| 8 | **A (P1)** | 수명 경합·오염 큐 | **fixed** — 멱등 invocation 상태 기계(중복 start·겹친 send 거부, 실패 시 잔여 상태 0, 동기 spawn 예외·error+close·stdin 오류·stop 결정론) |
| 9 | **A (P1)** | `raw`에 원본 payload가 실렸다 | **fixed** — bounded sanitized projection만. 명령 문자열 제거, 전 kind `JSON.stringify` sentinel + 전달 fixture |
| 10 | **B (P1)** | `reviewer.ts`가 `result.isError`를 무시하고 빈/무효 구조화 출력도 통과시킨다 | **유예 — 대장 `B-8`**(M5a는 controller 통합 범위가 아니다). 기한: **M5b에서 reviewer를 처음 배선하기 전** |
| 11 | **B (P1)** | live secret 값 redaction·인증 미해결 | **유예 — `B-7` 확장**(증거·기한 갱신). live만 막고 offline M5b는 막지 않는다 |
| 12 | **C (P2)** | `C-20`이 `C-17`과 중복 | **fixed(문서)** — `C-20` 철회, `C-17` 하나만 유지하고 기한을 M5c 전으로 |

검증 실측(offline, 2026-07-27 — M5a 구현 세션 + 리비전 세션):

- **리비전 후(현행)**: 파일 단독 `npx tsx --test src/exec/executionBoundary.test.ts` **12/12** ·
  `… codexStreamParser.test.ts` **24/24** · `… codexCliProvider.test.ts` **34/34**(합 **70/70**).
  `npm run test:exec` 전체 suite **212/212**(142 → 186 → 212).
  **212는 exec suite 수치이며 파일 단독 focused가 아니다.**
- (리비전 전 기록: focused 44/44 · exec suite 186/186.)
- `npx tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
- **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 3회.
  M5a는 offline 범위이고 **최종 전체 suite 1회는 supervisor가 M5 handoff 시점으로 예약**했다 —
  미실행은 미실행으로 적는다.
- **Codex 추론**: 이 provider/live 경로로는 **0회**. supervisor가 돌린 **별도 fresh read-only Codex 리뷰**만
  실제 Codex 세션이었다. 관측된 JSONL 이벤트 semantics는 그 리뷰 스트림 수준이며 **provider live로 검증하지 않았다**(`B-9`).
- **비공허성(mutation)**: 구현 세션 2종(경계 대조 제거 → 2건 실패 / 종료 이벤트 없는 스트림 성공 처리 → 5건 실패),
  리비전 세션 2종(**실행 파일 신원 검증 제거 → 2건 실패** / **프로토콜 실패 기록 제거 → 16건 실패**).
  네 번 모두 정확히 원복했고 원복 후 `MUTATION` grep 0 · focused 70/70 재확인.

**M5a가 아닌 것(여전히 미완료)**: live 인증·secret 값 redaction(`B-7`) · JSONL payload 필드명 live 확인(`B-9`) ·
reviewer 결과 게이트(`B-8`) · no-progress/wall-clock deadline과 cancellation·descendant 정리(`C-18`) ·
`--output-schema` 응답 검증(`C-19`) · autopilot CLI · Claude↔Codex 자동 전달 · 실제 7-agent 동시 실행 ·
self-hosting controller 재시작 경계 · **live acceptance 전부**. **M5는 이 리비전 뒤에도 미완료다.**

#### M5a에서 추가된 유예 항목 (2026-07-27 기준 · 리비전 반영)

M5a 구현·리비전에서 확인한 항목이다. **리뷰가 낸 A(P0 2 · P1 7)는 전부 이번 리비전에서 fixed**이고,
아래는 남은 B/C다. `B-7`·`B-8`·`B-9`는 **M5b live 실행(또는 reviewer 배선) 착수 전 반드시 닫는다** —
그 전에는 이 provider로 실제 Codex를 부르지 않는다. **offline M5b 작업은 막지 않는다.**

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-6` | **B (P1) → fixed(M5a 리비전)** | **`codex exec --help` 실측이 없다.** M5a 세션에서 로컬 codex 바이너리 실행 승인이 나지 않아(권한 거부 3회) argv·플래그 철자·`--config` TOML 표기·JSONL 필드명을 **로드맵 §1의 기록**(`0.146.0-alpha.3`)으로만 잡았다. 파서는 `thread_id`/`session_id` 같은 별칭을 받지만 이름이 다르면 세션 id 관측·usage가 비게 된다 | 중간 — alpha CLI의 필드명은 잘 바뀐다 | provider 1개(잘못된 플래그는 codex 비정상 종료 → fail closed. 조용한 오작동은 usage/세션 id 누락뿐) | 중 — 실측 없이 live를 켜면 첫 실행이 전부 실패로 낭비된다 | 소(help 1회 + fixture 갱신) | **M5b live 착수 전(하드 게이트)** | 다음 구현 세션(M5b) | **supervisor 실측(codex-cli `0.146.0-alpha.3`, parse-only·추론 미실행)**: fresh `exec`는 `--config`·`--strict-config`·`--model`·`--sandbox`·`--cd`·`--ephemeral`·`--ignore-user-config`·`--ignore-rules`·`--output-schema`·`--json`·stdin `-`를 받고, `exec resume`는 `--config`·`--strict-config`·`--model`·`--ignore-user-config`·`--ignore-rules`·`--output-schema`·`--json`만 받는다(**subcommand-local `--sandbox`/`--cd` 없음** — `exec resume <uuid> --sandbox … --cd … --help`는 거부, `exec --sandbox … --cd … resume --help`는 파싱). M5a 리비전이 이 배치를 argv 컴파일러와 파싱 계약 테스트에 고정했다. **JSONL payload 필드명은 provider live 경로로 확인하지 않았다 — 그 부분은 `B-9`로 남는다** | **fixed (2026-07-27, M5a 리비전 — 플래그 배치 한정)** |
| `B-7` | **B (P1)** | **격리 `CODEX_HOME`에는 자격증명이 없어 live 인증 방식이 미정이고, live secret 값 redaction도 미해결이다.** ⓐ 인증: auth 파일 복사·영속화를 금지했으므로 live는 "승인된 env 하나를 명시 전달 / 격리 홈에 사람 1회 로그인 / 다른 방식" 중 하나를 **사람이 결정**해야 한다(M5a 리비전에서 자식 env를 `CODEX_HOME` 하나로 좁혀 이 결정 없이는 live가 아예 인증되지 않는다 = fail closed). ⓑ redaction: 현재 `redactSecrets(stderr)`는 **알려진 secret 값 목록 없이 패턴만** 보므로 실제 토큰이 stderr에 찍히면 못 가릴 수 있다 → live 전에 **stderr를 아예 버리거나** `collectSecretValues`로 **승인된 정확한 값만** 넘겨야 한다 | 확실(설계상) | live 실행 전부 · live 오류 요약의 secret | 중 — 결정 없이 켜면 매 실행이 인증 실패이고, 값 목록 없이 켜면 토큰이 요약에 남을 수 있다 | 소~중(결정 + env allowlist 1개 + redaction 입력 배선) | **M5b live 착수 전(하드 게이트). offline M5b 작업은 막지 않는다** | 사용자 + 구현 세션 | `compileCodexEnv` · `summarizeError`/`redactSecrets` · 2026-07-27 fresh Codex 리뷰 P1/B · DECISIONS 2026-07-27(M5a) | open |
| `B-8` | **B (P1)** | **`src/exec/reviewer.ts`가 리뷰 결과를 무비판적으로 받는다**: `result.isError`를 보지 않고, 비어 있거나 구조화되지 않은 출력도 `extractCriticalRisks`가 Critical 0건으로 읽어 **"통과"가 된다**. 즉 리뷰어 세션이 실패하거나 아무 말도 못 하면 게이트가 조용히 열린다. M5a는 provider 계층만 다뤘고 controller 통합은 범위 밖이라 이번에 고치지 않았다 | 중간 — live 리뷰어는 실패·빈 출력이 드물지 않다 | 리뷰 게이트 전체(잘못된 "통과") | **높음** — 리뷰 게이트를 신뢰한 채 M5b 자동 왕복을 켜면 잘못된 통과가 산출물로 굳는다 | 소~중(`isError`·빈 출력·헤더 부재를 실패로 + 회귀 테스트) | **M5b에서 reviewer를 처음 배선하기 전(하드 게이트)** | M5b 구현 세션 | 2026-07-27 fresh Codex 리뷰 P1/B · `src/exec/reviewer.ts` `reviewDiff` | open |
| `B-9` | **B (P1)** | **codex JSONL payload 필드명·semantics를 provider live 경로로 확인하지 않았다.** supervisor 실측은 **플래그 파싱까지**이고(`B-6` fixed), 이벤트 필드(`thread_id` 등)는 별칭을 받아 두었을 뿐이다. 이름이 다르면 세션 id·usage가 비고 resume이 막힌다(성공으로 오인되지는 않는다 — `missing_session_id`가 실패다) | 중간 — alpha CLI | provider 1개(fail closed 방향) | 중 — 확인 없이 live를 켜면 첫 실행이 전부 실패로 낭비된다 | 소(live 1회 캡처 + fixture 갱신) | **M5b live 착수 전(하드 게이트)** | M5b 구현 세션 | `codexStreamParser.ts` 상단 주석 · `B-6` 증거란 | open |
| `C-18` | C (P2) | **no-progress deadline · wall-clock deadline · cancellation/descendant 정리가 없다.** provider는 `stop()`으로 SIGTERM만 보내고 자손 소멸을 확인하지 않는다. §M5 "bridge 실행 요건"의 나머지 절반이다 | 중간(실제 live 세션에서) | 세션 1건이 오래 매달릴 수 있다(상태 오염은 아님 — 결과는 여전히 1건) | 중 — live 운영 전에는 필요하다 | 중 | **M5b/M5c live runner 도입 시** | 다음 구현 세션 | `CodexCliProvider.stop()` · 로드맵 §10 M5 목표 | open |
| `C-19` | C (P2) | **`--output-schema`를 넘겨도 응답 본문을 schema로 검증하지 않는다.** provider는 최종 agent message 텍스트를 그대로 `result.text`로 준다(호출자가 파싱) | 중간 | 구조화 결과 1건의 형태 오류가 호출자에게 넘어간다 | 낮음 — 검증기를 나중에 얹으면 된다(기존 수동 closed validator 방식) | 소~중 | **reviewer 결과를 kernel state로 옮기기 시작할 때(M5c)** | 미정 | `codexStreamParser` `lastMessage` · M5a focused "구조화 최종 출력" | open |
| `C-21` | C (P2) | **프로토콜 실패로 끝난 invocation 뒤에도 resume이 허용된다**(MCP 위반·세션 신원 충돌만 세션을 닫는다). malformed·oversized·중복 종료로 실패한 turn 뒤에 호출자가 `send`를 부르면 provider는 그 thread를 이어간다 — 판정은 `result.isError`를 보는 호출자 몫이다 | 중간(호출자가 `isError`를 무시할 때) | 세션 1건의 후속 turn | 낮~중 — `B-8`(reviewer가 `isError`를 무시한다)과 같은 방향의 위험이고 그쪽을 닫으면 대부분 사라진다 | 소(실패 사유 화이트리스트로 poison 확장 + 회귀 테스트) | **`B-8`을 닫을 때 같이(= M5b reviewer 배선 전)** | M5b 구현 세션 | `CodexCliProvider.send`/`state.poisoned` · M5a 2차 리비전 focused "MCP 위반을 본 세션은 닫힌다" | open |
| `C-22` | C (P2) | **`CODEX_HOME` 소유 신원이 in-memory라 controller가 재시작하면 같은 홈으로 resume할 수 없다**(신원을 잃으므로 최초 검증 규칙에 걸려 `codex_home_not_empty`). 방향은 fail closed이지만 self-hosting 재시작 후 진행 중 세션을 이어갈 수 없다 | 중간(M5c self-hosting에서) | 재시작 시점에 열려 있던 codex 세션의 resume | 낮~중 — 재시작 후에는 새 세션으로 다시 시작하면 된다 | 중(소유권을 `run_state.json`에 durable 기록 + 복원 검증) | **self-hosting controller 재시작 경계를 다룰 때(M5c)** | M5c 구현 세션 | `CodexState.homeId` · M5a 2차 리비전 focused "격리 홈 수명" | open |
| `C-23` | C (P2) | **turn 사이에 호출자가 `spec`을 바꾸면 model·`--output-schema` 경로가 resume에서 달라질 수 있다.** provider는 invocation마다 `spec`을 다시 검증하므로 sandbox·`codexHome`(신원)·경로 계약 위반은 막히지만 model 문자열과 schema 경로 교체는 통과한다 | 낮음 — spec은 controller 소유 객체다 | 세션 1건의 후속 turn 설정 | 낮음 | 소(start 시 해석값을 고정하고 resume에서 대조) | **reviewer/controller가 provider를 실제로 배선할 때(M5b)** | M5b 구현 세션 | `CodexCliProvider.invoke`의 `resolveCodexOptions` 재호출 | open |
| `C-24` | C (P2) | **stderr 버퍼 상한이 chunk 단위로만 적용된다**(`stderr.length < MAX_STDERR_BUFFER` 검사 뒤 chunk 전체를 붙인다 → 한 chunk만큼 초과 가능). 밖으로 나가는 요약은 여전히 `MAX_ERROR_CHARS` + `redactSecrets`로 bounded하다 | 낮음 | 실패 1건의 메모리 상한(정확도) | 낮음 | 소(붙일 때 잘라내기) | **live runner 도입 시(M5c, `C-18`과 함께)** | M5c 구현 세션 | `CodexCliProvider.invoke` stderr 핸들러 | open |
| `C-25` | C (P2) | **`events(handle)`는 현재 invocation의 큐를 준다** — `send` 전에 잡아 둔 스트림은 그 invocation이 끝나며 닫히고, 후속 turn 이벤트는 **다시 `events()`를 불러야** 나온다. 결과 유실은 아니지만(각 invocation은 종료 결과 1건으로 닫힌다) 소비자 계약이 문서에만 있다 | 중간(오케스트레이션 배선 시 오해하기 쉽다) | 소비자 배선 | 낮~중 — 배선 코드에서 turn마다 다시 구독하면 된다 | 소~중(멀티 turn 하나의 스트림으로 합치기 + 테스트) | **provider를 orchestrator에 배선할 때(M5b)** | M5b 구현 세션 | `CodexCliProvider.events`/`invoke`의 큐 교체 · M5a focused "실행 중 send" | open |

> **`C-20` 철회(2026-07-27, fresh Codex 리뷰 P2/C).** M5a가 등록했던 `C-20`("kernel 만료가 여전히 `>`")은
> 기존 `C-17`과 **같은 항목의 중복 등록**이었다. 중복을 지우고 **`C-17` 하나만** 만료 경계 항목으로 남긴다.
> `C-17`의 기한은 **M5c(장시간 autopilot 도입) 전**으로 좁혔다. M5a가 실행 경계에서만 `>=`로 좁힌 사실은
> 위 M5a 절과 `C-17` 증거란에 남는다.

#### M5a 2차 리비전 (2026-07-27, fresh Claude Opus 5 세션 — 구조적 A 4건 + 문서 정정 1건)

리비전 커밋 `bdd5507` 이후, **새 fresh Claude Opus 5 세션**(이전 작성 세션의 컨텍스트를 잇지 않는다)이
지목받은 구조적 A 후보를 조사해 전부 수정했다. 앞선 Codex 리뷰의 A 9건과 **다른 층위의 결함**이다 —
개별 게이트는 있었지만 **게이트들끼리 모순**이었다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| 1 | **A** | **비-ephemeral resume이 구조적으로 불가능했다.** 첫 codex 프로세스는 `CODEX_HOME`에 세션 상태를 남겨야 하는데 **모든** invocation이 "빈 홈"을 요구했다 → `ephemeral:false` + `send`는 production에서 항상 `codex_home_not_empty`. fake CLI가 상태를 cwd에만 써서 이 모순이 테스트로 드러나지 않았다 | **fixed** — provider 소유 홈 수명(첫 invocation은 빈 홈 + 신원 고정 / resume은 같은 신원일 때만 상태 허용, 경로·0700·홈 금지·strict 플래그·단일 env 재검증). 교체·symlink·권한 완화·소유하지 않은 상태는 spawn 0. fake CLI가 실제처럼 `sessions/…/rollout-<uuid>.jsonl` + `history.jsonl`을 남긴다. **live 인증(`B-7`)은 그대로 open**이고 같은 uid 공격자 내성은 주장하지 않는다 |
| 2 | **A** | **승인 만료를 비동기 git 조회 **전에만** 봤다.** `revalidateSync()`(spawn 직전 마지막 검증)에는 만료 재확인이 없어 조회 중에 만료된 승인으로 프로세스가 뜰 수 있었다 | **fixed** — `nowMs`에 clock 함수를 주면 재검증이 시각을 다시 읽어 `now >= expiresAt`을 재확인하고 읽을 수 없는 시각도 거부한다. 만료가 그 사이에 걸치면 provider spawn 0 |
| 3 | **A** | **파서가 `thread.started` 전에 assistant·status·error를 방출하고 나중에 성공할 수 있었다** — 신원 없는 이벤트가 내용·도구 payload를 들고 나갔다 | **fixed** — 신원 우선: 의미 있는 첫 이벤트가 정규 UUID를 세워야 하고, 그 전 이벤트는 비가역 `missing_session_id`이며 내용·도구를 전달하지 않는다. 늦은 `thread.started`·성공 종료도 되돌리지 못한다 |
| 4 | **A** | **MCP 위반을 본 thread를 resume할 수 있었다**(비가역 실패의 resume 우회) | **fixed** — MCP 관측 시 세션을 닫는다(`codex_mcp_observed`), 후속 `send`는 spawn 0 |
| 5 | **C(문서)** | 로드맵·파서 주석이 "agent message 전문은 어떤 이벤트에도 실리지 않는다"고 적어 **실제 동작과 어긋났다**(raw 얘기를 이벤트 전체로 넓힌 오류) | **fixed(문서)** — raw/추론/명령/stderr/error payload는 제외, **상한 지난 최종 본문은 `assistant.text`·`result.text`로 의도적으로 전달**로 정정. `B-7`·`B-8`·`B-9`의 서술은 그대로 유효하다(인증·reviewer 게이트·JSONL 필드 live 확인은 여전히 open) |

검증 실측(offline, 2026-07-27 — 2차 리비전 세션):

- 파일 단독 `npx tsx --test --test-timeout=180000` : `executionBoundary.test.ts` **13/13** ·
  `codexStreamParser.test.ts` **26/26** · `codexCliProvider.test.ts` **40/40**(합 **79/79**, 이전 70).
- `npm run test:exec` **221/221**(212 → 221). **221은 exec suite 수치이며 파일 단독 focused가 아니다.**
- `npx tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
- **비공허성(mutation) 4종**: 홈 소유 신원 비교 제거 → **2건 실패** / `revalidateSync` 만료 재확인 제거 →
  **2건 실패** / 신원 우선 게이트 무효화 → **2건 실패** / MCP 세션 격리 제거 → **1건 실패**.
  네 번 모두 정확히 원복하고 `MUTATION` grep 0 · `git diff --numstat` 기준선 일치 · focused 79/79 재확인.
- **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 3회 —
  최종 전체 suite 1회는 여전히 **supervisor가 M5 handoff 시점으로 예약**했다.
- **Codex 추론 0회**(이 세션은 fake CLI·in-process seam만 썼다). `B-7`·`B-8`·`B-9`는 **여전히 open**이고
  그 전에는 이 provider로 실제 Codex를 부르지 않는다. 신규 유예: `C-21`~`C-25`(위 대장).

### M6 — Hierarchical Orchestrator + Fresh Context Rotation

목표:

- 7 specialist registry, dynamic child `spawn_request`, depth/count/budget/ownership gate.
- dependency-aware scheduling, result routing, context bundle/rotation.
- reviewer·worker·coordinator fresh-session 강제.

완료:

- parent→child→parent, child→orchestrator→sibling 전달 테스트.
- child가 직접 spawn/state 변경 불가.
- Coordinator 교체 전후 task graph·결정·artifact hash 동일.

### M7 — Planning & Evidence Research

기존 M4 Research Adapter를 이 단계로 이동한다.

- idea validation, 최신 web research, EvidenceItem, injection 방어, cache/상한.
- research→PM→CEO 조언, 최종 사람 gate.
- 외부 원문과 모델 요약 분리, source/hash/retrievedAt 보존.

완료: 실제 아이디어에서 근거 있는 PRD/판정 + tool 없는 baseline 대비 benchmark.

### M8 — UX & Design Pipeline

- UX flow, 디자인 방향, `DESIGN.md`, `tokens.json`, component inventory.
- shadcn filtered read 재사용, custom/private registry 차단.
- design review는 fresh Codex, 수정은 fresh design worker.

완료: 핵심 화면 설계→토큰 기반 구현 handoff의 계약·접근성·범위 검증.

### M9 — Development Pipeline

- Tech Lead가 task DAG/ownership/API contract 생성.
- Claude Code Opus worker 병렬 worktree 구현.
- fresh Codex code/security/test review.
- fresh Claude revise, fresh Codex verify, 직렬 로컬 병합.

완료: 아이디어에서 로컬 동작 MVP와 전체 테스트·최종 report까지 단일 실행.

### M10 — End-to-End Hardening & Release

- resume/idempotency, crash recovery, timeout, rate limit, budget, deadlock, cancellation, cleanup.
- context rotation/요약 변질/문서 누락/의존성 실패/권한 요청 통합 시나리오.
- 실제 서로 다른 프로젝트 2~3개 도그푸딩.

완료:

- 기획→디자인→개발 end-to-end acceptance 전부 통과.
- 중단 후 재개 시 중복 agent/중복 merge/결정 유실 없음.
- hard deny와 milestone approval 경계 우회 없음.

## 11. M10 이후 선택적 확장

- stack별 QA/Next.js DevTools/Supabase dev branch.
- preview/운영 read profile(Vercel/Sentry 등).
- Anthropic provider parity.
- F1 cross-project learn-from(프로젝트 축적 조건 충족 시).

production deploy, live billing, remote direct write, PR merge 자동화는 선택적 확장이 아니라 계속 금지다.

## 12. 다음 작업

1. ~~M3d 상세 구현 계획~~ → M3d.1은 완료(fresh Codex Sol xhigh APPROVE).
2. ~~M3d.2 상세 구현 계획과 영향 파일 작성~~ → 완료.
3. ~~사용자 승인~~ → 완료(M3d.2 범위 한정 승인).
4. ~~Claude Code Opus가 M3d.2 구현·테스트·작업 기록~~ → 완료(offline 검증 통과, 위 M3d.2 절 참조).
5. ~~fresh Codex Sol xhigh 리뷰 REQUEST_CHANGES 수정~~ → **여덟 차례** 반영 완료
   (1차 6건 · 2차 4건 · 3차 6건 · 4차 5건 · 5차 5건 · 6차 6건 · 7차 1건 · 8차 3건).
   각 차수의 내용은 위 M3d.2 절의 리비전 블록에 있다. **M3d 완료 APPROVE는 아직 없다.**
6. ~~fresh Codex가 여덟 번째 리비전 diff/test를 재검토~~ → 완료(2026-07-26):
   **`APPROVE_FEATURE_PROGRESSION` · Category A 0건 · Category C 1건은 대장 `C-1`로 유예**.
   **M3d 완료 판정이 아니다.**
7. ~~부하 acceptance 재실행이 M3d 완료를 막는 차단 게이트~~ → **2026-07-27 정정**: 사용자 확정 상태 기준
   **M3는 완료**다(M3a/M3b/M3c core + 실제 live acceptance 완료, M3d.2는 PR #10 `ea764a5` 병합).
   부하(stress) 재실행은 **nonblocking release-readiness backlog 트리거**로 재분류했다(대장 `B-1`).
8. ~~사용자가 live runner 3종 실행 → evidence 3건 생성 확인이 완료 전제~~ → **2026-07-27 정정**:
   live acceptance는 이미 완료됐고, runner 재실행·evidence 재생성은 **nonblocking release-readiness
   backlog 트리거**다(대장 `B-2`).
9. ~~7·8이 닫히면 M3d 전체 완료 판정~~ → **완료. M3는 닫혔고 재개방하지 않는다**(§0-0).
10. ~~M4 계획 준비는 지금 가능. M4 구현은 not started~~ → **2026-07-27 갱신**: 사용자가 **M4a 범위만**
    승인해 격리 worktree `work/m4a-durable-orchestration`(base `ea764a5`)에서 구현·offline 검증을 마쳤다
    (위 M4a 절). **M4 전체는 여전히 미완료**이고, M4a 외 잔여 범위(scheduler · exclusive resource class ·
    sibling/reviewer 메시지 · approval manifest)는 **별도 사용자 승인**이 필요하다. 승인 시에도
    계획→승인→구현→fresh review 순서와 M4 절의 중첩 조건 ⓐ~ⓓ를 그대로 따른다.
11. **M4a에 대한 fresh Codex 독립 리뷰 P0 2건은 2026-07-27에 수정 완료**했다
    (P0-1 state↔event binding · P0-2 문서의 M3 재개방 표현). **열린 P0는 없다.**
    구현·수정 세션 모두 commit/push/PR/merge를 하지 않았고 stress·live·반복 suite도 실행하지 않았다
    (`B-1`/`B-2`는 nonblocking release-readiness backlog 트리거로만 남는다).
12. ~~다음 승인 대상: M4 잔여 범위(scheduler · exclusive resource class · sibling/reviewer 메시지 ·
    approval manifest)~~ → **2026-07-27 갱신**: 그중 **scheduler + exclusive resource class +
    멀티프로세스 writer lock을 M4b로 구현·offline 검증 완료**했다(격리 worktree
    `work/m4b-resource-scheduler`, base `805da35` = 리뷰 완료된 M4a 커밋 위 **stacked PR**,
    당시 미커밋 — **그 시점 기록**이며 현행 M4b는 로컬 커밋 `11775fd`+`ab63eac`다. 원격 push/PR은 없다).
    대장 `B-3`·`B-4`는 **fixed**다.
13. 다음 승인 대상: **M4c** = sibling 전달 · reviewer 왕복(나머지 메시지 타입) · milestone approval
    manifest. 그때까지 **M4 전체를 완료로 적지 않는다**. M4b가 남긴 유예 항목은 `C-4`(보강)·`C-8`·
    `C-9`·`C-10`이며 전부 nonblocking이다.

M5 live acceptance가 통과하면 M6부터는 `autopilot`이 위 전달을 대신한다.

## 13. 공식 Codex 근거

- Subagents: main thread는 요구사항·결정에 집중하고, 하위 agent가 독립 작업 후 요약 결과를 반환한다.
  <https://learn.chatgpt.com/docs/agent-configuration/subagents.md>
- Non-interactive Codex: `codex exec`는 자동화용 non-interactive surface다.
  <https://learn.chatgpt.com/docs/non-interactive-mode.md>
- Agent approvals & security / Auto-review: auto-review는 승인 검토자를 바꿀 뿐 sandbox나 권한 범위를
  확대하지 않는다.
  <https://learn.chatgpt.com/docs/agent-approvals-security.md>
  <https://learn.chatgpt.com/docs/sandboxing/auto-review.md>

