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
- **M5는 여전히 미완료다.** slice별 판정은 다음과 같다.
  - **M5a — 승인 완료.** 2026-07-27에 사용자가 M5a 범위를 승인해 구현·offline 검증을 마쳤고, 같은 날
    fresh Codex 독립 리뷰 5라운드(전부 REVISE)의 A 항목을 리비전으로 닫았다
    (실행 경계 + `CodexCliProvider` + JSONL 어댑터 + fake 테스트 — §10 M5 → M5a).
    라운드별 A: 1차 9건 → 2차 4건 → 3차 3건 → 4차 3건(pre-spawn race · `C-23` reopen · 발행 순서) →
    **5차 3건(낡은 핸들이 교체 세션을 조종 · 가변 `nowMs`로 만료 우회(`C-23` 2차 reopen) · 드리프트 marker
    문서·구현 불일치)**. 5차는 대장 **`C-28`도 함께 닫았다**(manifest canonical digest 봉인).
    **M5a 최종 로컬 HEAD `409dee2`는 다섯 번째 fresh 독립 Codex 리뷰에서 `APPROVE_TO_STACK` ·
    A finding 0으로 승인됐다.** 이 문서 아래쪽의 "5차 이후에도 M5a는 다음 fresh 독립 리뷰 전까지 승인된
    것이 아니다"류 표기는 **그 승인 이전 시점의 기록**이며 현행 판정이 아니다(원문은 이력으로 보존한다).
  - **M5b — 7차 리비전 완료 · 독립 8차 재리뷰 대기(현행 판정).** 2026-07-30 **7차 독립 fresh Codex
    `gpt-5.6-sol` xhigh read-only 리뷰가 `409dee2..ff5e035` 전체를 보고 다시 REVISE(A/P1 2건 · B 7 · C 12)**
    했다. 6차 리비전 절의 "둘 다 닫았다"는 **부분적으로만 사실**이었다: 리뷰는 **6차 A1을 PARTIAL**
    (승인 manifest가 trust root인 것·같은 fd digest 검증은 닫혔지만 **git 검증이 프로세스 1회**여서
    `readCheckoutHead()`의 두 자식 프로세스 사이·`revalidateSync()` 루프 회차 사이에 **같은 inode 제자리
    덮어쓰기**가 통과했다 — 자식 프로세스 수명만큼 넓은 창) · **6차 A3를 PARTIAL**(roll forward 폐기·
    journal 묶기·no-clobber는 닫혔지만 **발행 preflight 이후 staging 교체본이 link되고 journal이 삭제**될 수
    있었고, 이미 발행된 body의 소유를 dev/ino/size로만 봤다)로 판정했다.
    **초기 A2는 CLOSED · 초기 A4는 PARTIAL**(잔여 `C-29`·`C-35`·`C-38`)이다.
    **7차 리비전이 그 둘을 닫았다**: git 검증 단위를 **spawn 1회**로 좁혀(`GitGate` — 게이트↔spawn 사이
    `await` 없음) `readCheckoutHead()`의 두 호출과 `revalidateSync()`의 각 checkout 회차가 자기 게이트를
    지나게 하고 · body 발행 소유 판정을 **열린 fd 하나**(dev+ino·정확한 바이트 수·내용 SHA-256)로 바꿔
    **link 직전 · link 직후 · journal 삭제 직전 전수**에서 다시 증명한다(`finishJournal` 하나가 삭제의
    유일한 경로이고 `journal:cleanup` hook은 sweep **앞**에서 울린다). ID 없던 **승인 경로 schema regex
    갈림**은 `C-40`으로 등록하고 정본 pattern 공유로 정렬했다. 상세·증거는 §10 M5 → **M5b 7차 리비전**.
    **이 판정도 스스로 승인이 아니다** — 다음 fresh Codex 독립 read-only 8차 리뷰가 게이트다.
  - **M5b 6차 리비전(dated history — 위 7차 판정이 현행이다).** 2026-07-28 **6차 독립 fresh Codex
    `gpt-5.6-sol` xhigh read-only 리뷰가 `409dee2..6a5e418` 전체를 보고 다시 REVISE(A/P1 2건 · B 7 · C 10)**
    했다. 5차 리비전 절의 "넷 다 닫았다"는 **부분적으로만 사실**이었다: 리뷰는 **A1을 OPEN**
    (경로/dev/ino 동치는 trust root가 아니다 — caller가 provider와 controller **양쪽에** `/usr/bin/true`나
    사용자 소유 0700 sentinel을 주면 두 관측이 같아 `authorityMatches: true`가 됐고, **같은 inode 제자리
    덮어쓰기**도 통과했다) · **A3를 OPEN**(journal이 base 승인·전이나 정확한 body 소유권에 묶이지 않아
    ⓐ 해시를 전부 재계산한 **위조 후속**이 milestone·승인 manifest·task state를 바꿀 수 있었고
    ⓑ event "정규형"을 `JSON.stringify(JSON.parse(line))`로 봐서 **key 순서 변경**이 통과했고
    ⓒ 남의 same-digest 최종 body를 채택·rename으로 덮거나 rollback에서 지울 수 있었다)로 판정했다.
    **A2는 CLOSED · A4는 PARTIAL**(잔여 `C-29`·`C-35`·`C-38`)이다.
    **6차 리비전이 그 둘을 닫았다**: 실행 권위의 trust root를 **kernel 소유 승인 manifest**로 옮겨
    (`executionAuthority` = codex·git의 정규 절대경로 + **내용 SHA-256**) 호출자 경로 옵션을 **삭제**하고
    생성·**모든 spawn 직전**에 신원 + 내용 digest를 재검증한다 · 복구는 **roll forward를 폐기**해
    "기준이면 되돌린다 / 이미 목표 바이트면 마무리한다" 두 규칙만 남기고, journal을 **기준 불변 권위 ·
    정규 event 바이트(validator 출력) · base→target body delta · staging 소유 신원**에 묶고 최종 body는
    **state 뒤에 no-clobber hard link**로만 발행한다. 상세·증거는 §10 M5 → **M5b 6차 리비전**.
    **7차 리뷰가 이 두 판정을 PARTIAL로 다시 열었다**(위 7차 블록이 현행이다).
  - **M5b 5차 리비전(dated history — 위 7차 판정이 현행이다).** 2026-07-28 **5차 독립 fresh Codex
    `gpt-5.6-sol` xhigh read-only 리뷰가 `409dee2..35de547` 전체를 보고 다시 REVISE(A/P1 4건 · B 7 · C 9)**
    했다. 4차 리비전 절의 "넷을 닫았다"는 **부분적으로만 사실**이었다: 리뷰는 **A1을 PARTIAL**
    (증명이 메서드 신원만 보므로 **임의 executable/git 권위**가 read-only provider로 증명됐다 —
    사용자 소유 0700 스크립트·`/bin/echo`·`/bin/true`가 실제로 통과) · **A3를 OPEN**(① 최종 message body가
    journal보다 먼저 생겨 실패한 전이가 색인되지 않은 durable 데이터를 남겼다 ② 복구가 정확히 일치하지 않는
    **모든** event suffix를 truncate해 **남의 append-only 감사 바이트를 파괴**할 수 있었다 ③ journal schema가
    열려 있고 전이에 묶이지 않아 그럴듯한 journal 하나로 유효 state를 caller-chosen state로 덮어쓸 수
    있었다) · **A2는 CLOSED · A4는 PARTIAL**(잔여는 `C-29` + caller getter taxonomy = 신규 `C-38`)로 판정했다.
    **5차 리비전(`e477235`)이 그 넷을 닫았다**: 증명이 **불변·정규·런타임 검증된 설정 신원**을 포함하고
    controller가 **명시 필수 `codexExecutablePath`** + git/checkout/승인 digest/시각 권위로 대조해
    **git·codex를 띄우기 전에** 불일치를 거부한다 · body는 **트랜잭션 소유 staging → journal → 최종 이름**
    순서로만 발행한다 · suffix는 **실제 바이트**로 판정해 정확한 접두만 되돌리고 남의 바이트는 보존한다 ·
    journal은 **closed schema + 전이 전수 묶기**다. 상세·증거는 §10 M5 → **M5b 5차 리비전**.
    **이 판정도 스스로 승인이 아니다** — 다음 fresh Codex 독립 read-only 리뷰가 게이트다.
  - **M5b 4차 리비전(dated history — 위 5차 판정이 현행이다).** 2026-07-28 **4차 독립 fresh Codex
    `gpt-5.6-sol` xhigh read-only 리뷰가 `409dee2..d554a46` 전체를 보고 REVISE(A/P1 4건 · B 7 · C 5)**
    했다. 3차 리비전의 자기평가는 승인 근거가 아니었고, 리뷰는 3차 A1~A3를 **PARTIAL**로 판정했다:
    ① **A1** — TS `private`은 emitted JS에서 writable own property이므로 `controller.sealed`·`pins`·
    `tokensUsed`·attested provider의 `opts`가 밖에서 교체·리셋 가능했다(승인·executable 신원·kernel/provider
    권위·예산 우회). ② **A2** — controller가 kernel을 **메서드 모양**으로만 봤으므로, 스케줄링은 진짜
    kernel에 위임하고 `completeTaskWithArtifacts`만 위조하는 delegate가 **디스크 변화 0으로**
    `completed`/`result_accepted`를 받아냈다. ③ **A3** — 논리적 단일 `#mutate`와 달리 물리 발행은
    body → event append → snapshot → state 네 연산이라, append 성공 뒤 실패가 **낡은 state + 새 event
    tail**을 남겨 reopen과 재시도가 함께 깨졌다. ④ **A4** — `addArtifact`가 caller-owned `out.role`을
    검증 뒤 **다시 읽어** 교대 getter가 invalid role을 durable에 심을 수 있었다(커밋 성공 · reopen 실패).
    **4차 리비전(`b64974a`)이 넷을 다뤘다**: 런타임 사설 권위(`#private` 상태·게이트 + 인스턴스·prototype
    freeze) · **진짜 kernel 발급 증명**(모듈 사설 WeakSet + 사설 생성 토큰 + own property 0 + 메서드 신원) ·
    **복구 가능한 발행**(`commit.journal` + 결정론적 roll forward/roll back 규칙 + 발행 전 런타임 validator
    전수) · **단일 읽기 산출물 입양**. 상세·증거는 §10 M5 → **M5b 4차 리비전**.
    **정정(2026-07-28, 5차 독립 리뷰)**: 그 절의 "넷을 닫았다"는 과장이었다 — **A1은 PARTIAL**(숨은
    executable/git 설정이 증명 대상이 아니었다) · **A3는 OPEN**(pre-journal 최종 body · foreign suffix
    truncate · 열린 journal schema)였고 **A4도 PARTIAL**이었다. 현행 판정은 위 5차 리비전 항목이다.
  - **M5b 3차 리비전(dated history — 위 4차 판정이 현행이다).** 승인된 `409dee2` 위에 stable controller bridge를
    구현했고(`1a94261` + `42777d9`), **1차 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가
    REVISE(A/P1 5건)** → 리비전 `6bc390d`. 그 뒤 **2차 독립 리뷰가 같은 다섯 자리에서 다시 REVISE(A=5)**
    → **2차 리비전 `55b488f`** (§10 M5 → M5b · M5b 2차 리비전).
    **그리고 3차 독립 리뷰(`409dee2..38b8d32`)가 또 REVISE(A/P1=3)** — ① 공개 `spawn` seam으로 read-only
    증명 위조 ② exported `ControllerError`로 오류 provenance 위조(성공 marker 주입) ③ 다중 artifact 등록과
    완료가 비원자적. 공통 뿌리는 **"공개 표면을 권위로 신뢰했다"** 이고, **3차 리비전**이 근거를 언어 수준
    사설 상태(`#private` · 모듈 사설 `WeakSet`)로 옮기고 완료를 **kernel 단일 원자 트랜잭션**
    (`completeTaskWithArtifacts`)으로 합쳐 셋을 닫았다. 같은 라운드의 **B 2건도 유예하지 않고 닫았다**
    (`B-14` 실패 경로 usage 회계 · `B-15` `ReviewSubject` closed 검증+봉인). §10 M5 → **M5b 3차 리비전** 참조.
    controller 성공 경로 테스트는 이제 **production 생성 경로 + 실제 OS 자식 프로세스**(결정론적 fake codex
    실행 파일)를 지난다 — codex/claude 추론·네트워크는 여전히 0이다.
    **1·2차 리비전의 "A 전부 fixed" 서술은 그때마다 과장이었다**(각 절은 dated history로 보존하고
    현행 판정은 3차 리비전 절이다). 1차분 상세: A1(재읽기·재진입) · A2(공개 export라 위조 가능한
    brand) · A3(실패 turn의 usage가 예산에서 누락) · A5a(파서 허위 승인) · A5b(열린 오류 taxonomy)가
    실제로는 열려 있었고 `B-8`도 다시 열렸다. **A4(포인터 재검증)만 유지**됐다. 2차 리비전이 그 다섯을
    닫았다: 생성 권위 **단일 읽기** · **모듈 사설 WeakSet 기반 위조 불가 read-only 증명**(공개 brand 제거) ·
    **성공/실패 해석 전 usage 회계** · **닫힌 리뷰 파서**(정확 라벨 · 길이 있는 펜스 · 미상 줄 거부 · 순서) ·
    **닫힌 오류 taxonomy**(경계 밖 코드는 결과 코드를 고르지 못한다).
    **M5b의 실제 계약은 "증명 가능한 read-only Codex planning/review bridge"로 좁혀졌다** — 타입 있는
    edit 가능 실행 집행은 신규 대장 **`B-10`(M5c)** 이다.
    **아직 독립 재리뷰·승인을 받지 않았다** — supervisor의 다음 fresh Codex read-only 리뷰가 게이트이고
    **위 fixed 판정 전부가 재확인 대상**이다(이 세션은 스스로를 승인하지 않는다).
    live provider 추론·네트워크·secret 사용은 0이다.
  - **M5c/M5d는 시작하지 않았고 live acceptance도 미실행이다.** M5c는 신규 B 4건
    (`B-10`~`B-13`)을 함께 소유한다.
  **M5a/M5b가 아닌 것**: autopilot CLI · Claude↔Codex 자동 전달 · 실제 7-agent 동시 실행 ·
  **live acceptance**. 이 문서 아래쪽의 "M5 not started" 표기는 M5a 승인 이전 기록이다.
  열린 B(P1)는 `B-7`(live 인증·secret redaction — **첫 live 전**) · `B-9`(JSONL live 확인 — **첫 live 전**) ·
  `B-10`(타입 있는 실행 집행 — **M5c Claude/edit 가능 provider 전**) · `B-11`(per-task preflight —
  **M5c autopilot/무인 advance 전**) · `B-12`(재시작 예산 회계 — **자동 재시작/resume 전, 늦어도 M5c**) ·
  `B-13`(durable 완료 전 provider 정리 확인 — **live 프로세스를 띄우는 provider 배선 전**) ·
  `C-12`→B(전달 재시도 — **M5c autopilot 전**). `B-7`·`B-9`는 **live 착수만 막고 offline 작업은 막지
  않는다.** `B-8`(reviewer 결과 게이트)은 두 번 reopen된 뒤 **M5b 2차 리비전 `55b488f`에서 fixed**다.
  3차 리비전이 추가로 닫은 B: **`B-14`**(첫 terminal 뒤 실패 경로의 usage 회계) · **`B-15`**
  (`ReviewSubject` closed 검증 + 봉인 스냅샷) — 둘 다 원래 기한은 M5c였으나 작고 안전해 앞당겨 닫았다.
- 현재 기준 커밋: M4a 기준은 `ea764a54108f1715248f3e0ae414ea87eb8ffaa9`.
  **세 마일스톤은 각각 로컬 커밋이 있는 분리된 stacked 브랜치다**(원격 push/PR/merge는 0):
  - `work/m4a-durable-orchestration` — `55d99a3`(feat) + `805da35`(docs)
  - `work/m4b-resource-scheduler`(base `805da35`) — `11775fd`(feat) + `ab63eac`(docs)
  - `work/m4c-routing-approval`(base `ab63eac`) — `3cfdb39`(feat) + `c963cb0`(docs)
  **M4c 최종 HEAD = `c963cb0832d66a58fefdaa2025a9213966c3cc27`.** 원본 checkout은 `bbb8b72`로 clean·무수정.
  이 문서 아래쪽의 "미커밋 working tree / 아직 commit·push·PR 없음" 표기는 **각 구현 세션 시점의 기록**이며
  현행 사실이 아니다(현행: 로컬 커밋 있음 · 원격 push/PR/merge 없음).
- 현행 offline 테스트 범위 라벨(2026-07-30 **M5b 7차 리비전** 기준 — **worker 자기보고**이며 독립 리뷰
  실측이 아니다): **파일 단독** `src/exec/stableController.test.ts` **58/58**(19 → 36 → 51 → 52 → 54 → 57 → 58) ·
  `src/exec/reviewer.test.ts` **21/21**(14 → 19 → 21) ·
  `src/exec/orchestrationKernel.test.ts` **103/103**(M4a 37 → M4b 50 → M4c 67 → M5b 68 → 70 → 74 → 82 → 89 → 98 → 103) ·
  `src/exec/codexCliProvider.test.ts` **59/59**(58 → 59) · `src/exec/executionBoundary.test.ts` **20/20**(17 → 20),
  **`npm run test:exec` 전체 suite 361/361**(125 → 142 → 240 → 268 → 295 → 322 → 333 → 343 → 353 → 361).
  7차 리비전의 race-sensitive subset(실행 경계 + kernel 2파일) **3회 직렬 123/123**.
  6차 리비전의 authority/provenance/recovery/atomicity subset(kernel·controller·provider 3파일) **3회 직렬 215/215**.
  **353/353을 "파일 단독 focused"로 적지 않는다.** core **374/374** · 전체 acceptance **92/92**는
  **M4c 시점의 마지막 실측**이며 M5a/M5b 세션에서는 돌리지 않았다(전체 suite 1회는 최종 M5 handoff 예약).
  단, M5b 리비전이 `registerArtifact` 불변식과 **4·5차 리비전에서 커밋 발행 프로토콜**을 건드렸으므로
  **kernel 계열 offline acceptance 3개는 개별로 재실행**했다: `m4a` **31/31** · `m4b` **42/42** ·
  `m4c` **77/77**(6차 리비전에서 **승인 manifest schema와 발행 프로토콜이 바뀌었으므로 다시 실행**하고,
  7차 리비전에서 **경로 pattern schema와 body 발행 경로가 다시 바뀌었으므로 또 실행** —
  전체 `acceptance.sh`·`npm test`·stress·live는 미실행).
  **6차 리비전 하위 호환(명시)**: 승인 manifest에 **필수 필드 `executionAuthority`가 추가**됐다.
  기존 manifest·기존 run state는 **조용한 기본값 없이** `invalid_manifest`로 거부된다(fail closed) —
  마이그레이션 도구는 만들지 않았다(대장 `C-9`와 같은 판단이며 현재 운영 중인 실 run은 없다).
  `commitRun`의 event 줄 바이트도 이제 **`validateEvent` 출력 정본**이므로 새 커밋의 key 순서가 바뀐다
  (기존 줄은 그대로 읽히고 체인은 raw 바이트 기준이라 열기·검증에 영향이 없다).
  **정직한 관측 1건(5차 리비전 세션)**: `npm run test:exec` 첫 실행에서 `stableController.test.ts`의
  "advanceOnce: kernel batch 순서대로 …" 1건이 `boundary_git_failed`로 실패했고 **즉시 재실행은 343/343**
  이었다. 원인은 계약 위반이 아니라 **호스트 부하에서 고정 10초 git 조회 상한 초과**(M3d.2에 기록된
  같은 부류의 부하 flake)이며, 테스트를 완화하지 않았다. 대신 그 파일의 게이트 회귀들이 케이스마다
  새 checkout을 만들지 않게 **run 하나를 공유**하도록 정리해 git 프로세스 수를 줄였다(단정은 그대로).

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

### 8.1 만료(`expiresAt`) 이후의 정확한 계약 — **safety-only reducer 예외** (2026-07-30 · V3 M5c 확정)

**이 항목이 현행 정본이다.** M4c~M5b 본문·주석의 "만료 후에는 **모든** 변경을 거부한다"는 문장은
그 시점 기록으로 읽는다. M5c가 실제 프로세스와 durable lifecycle을 도입하면서 그 문장이 안전을
막는 것이 드러났기 때문이다(만료가 곧 회계 누락 + 자손 프로세스 누수 + 자원 영구 점유가 된다).

- **전진 작업은 `now >= expiresAt`에서 전부 거부**한다(경계 **포함** — 대장 `C-17`을 이 규칙으로 닫는다).
  durable run deadline(`accounting.budgetDeadlineAt`)도 같은 방식으로 전진을 닫는다.
- **예외는 아래 safety-only reducer 4종뿐**이고 코드에서 **닫힌 목록**으로 강제한다:
  ① usage charge(이미 태운 토큰·경과의 durable 반영 — 증가만) ② cancellation request
  ③ cleanup(진입 · 시도 카운트 · zero-survivor 확인 · `cleanup_unconfirmed`)
  ④ 중단·시계 역행·복구 후의 fail-closed `paused` 전이와 action reconcile.
- **이 reducer들은 절대** 작업을 시작하지 않고(`ready|prepared → running` 금지), 실패한 전달을 수령하지
  않고, artifact를 발행·등록하지 않고, `completed`로 전이하지 않는다. → 만료 뒤에 새로 생기는
  산출물·권한·성공은 **0건**이며, 남는 것은 "이미 일어난 일의 회계"와 "자원 회수"뿐이다.
- 근거·대안 비교는 `docs/DECISIONS.md` 2026-07-30 (V3 M5c) 항목에 있다.

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
| `C-2` | C (P3) → **fixed(M5b 2차 리비전)** | `scripts/lib/fixture-config.mjs` 모듈 주석이 production 진입점을 2개만 예시로 적어 실제 5개와 어긋나 보인다 | — | 문서/주석만 | 낮음 | 소 | (닫힘 — 트리거 "production 파일을 여는 다음 승인 범위"는 **M5b에서 이미 발화했고**(M5b가 `src/exec/*` production을 열었다) 1차 리비전이 그것을 처리하지 않아 **overdue였다**) | 구현 세션 | 여섯~여덟 번째 리비전 잔여 위험 목록 · **fix(2차 리비전 `55b488f` 이후 docs 커밋)**: 주석이 진입점 **5개 전수**(`suite-lock` · `m3d2-stress-acceptance` · `m3a-live-preflight` · `m3b2-live-handoff` · `m3c3b-live-handoff`)를 적고 "예시가 아니라 전수"임을 명시한다. 실제 호출부 수는 `grep -rn loadFixtureConfig scripts src`로 재확인했고(5개) `suiteExclusiveLock.test.ts` **75/75** focused 재실행으로 소스 감사 계약이 그대로임을 확인했다 | **fixed (2026-07-28)** |
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
| ~~`C-12`~~ | **superseded → `C-12` → B(P1) 재분류 행(§9.1 "M5b 1차 리비전" 표)** | ~~전달 수령(ack)은 호출자가 직접 하는 좁은 전이일 뿐, 재전송·타임아웃·우선순위·starvation 방어가 없다~~ | — | — | — | — | **이 행은 더 이상 독립적으로 열려 있지 않다.** 트리거("실제 worker가 inbox를 소비하기 시작할 때")가 M5b controller에서 발화해 **B(P1)로 승격**됐고, 현행 기한·담당·증거는 승격된 행 하나에만 있다(기한: **M5c autopilot 착수 전**) | — | 아래 "M5b 1차 리비전" 표의 `C-12 → B (P1) 재분류` 행 | **superseded (2026-07-27, 2026-07-28 표기 정정)** |
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
| `C-16` | **C (P2) → fixed(M5b)** | **taskId ↔ roleId 교차 namespace 모호성.** 어떤 task의 `taskId`가 다른 task의 `roleId`와 같으면 `deliverTo` 해석이 **taskId를 먼저** 고른다. 같은 roleId가 여럿일 때(`ambiguous_recipient`)는 거부하지만 이 교차 충돌은 거부하지 않는다 | 낮음 — 명명 규칙이 겹칠 때만 | 전달 1건의 수신자(정확성) | 중 — **실제 inbox 소비가 생기면 bounded summary·artifact 포인터가 엉뚱한 관련 task로 전달될 수 있다** | 소(해석 전에 교차 충돌을 `ambiguous_recipient`로 거부) | (닫힘 — 원래 기한은 **M5에서 실제 worker가 inbox를 소비하기 시작하기 전**이었고, M5b controller가 정확히 그 소비자다) | M5b 구현 세션 | M4c 최종 Codex 리뷰 · `deliverTo` 해석 순서 · `C-13` 인접 · **fix(M5b)**: `resolveRecipient`가 해석 **전에** 교차 충돌을 확인해 `deliverTo`가 어떤 task의 `taskId`이면서 **다른** task의 `roleId`이기도 하면 `ambiguous_recipient`로 거부한다(전이 0 · revision·event·body 변경 0). 증거: `orchestrationKernel.test.ts` focused(68/68) 교차 충돌 케이스 + mutation(교차 확인 제거 → 실패) | **fixed (2026-07-27, M5b)** |
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
- spawn 상한: **task당 child 4 · child depth 최대 3(root=0) · run당 task 32 · run당 프로세스 32**.
  (task 상한 `maxTasksPerRun`과 프로세스 상한 `maxProcessesPerRun`은 값이 같아도 **별개 상수**다 — M6 T1.) child도 같은
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

#### M5a — 실행 경계 + `CodexCliProvider` + JSONL 어댑터 · **offline 구현·검증 완료 / 독립 리뷰 APPROVE_TO_STACK / live 미검증**

> **현행 판정(2026-07-27, 5차 리비전 이후 — 이 줄이 이 절에서 가장 최신이다).** **M5a 최종 로컬 HEAD
> `409dee2`는 다섯 번째 fresh 독립 Codex 리뷰에서 `APPROVE_TO_STACK` · A finding 0으로 승인됐다.**
> 아래 3차 시점의 "미승인" 정정 블록과 각 리비전 절의 같은 표현은 **그 승인 이전의 dated 기록**이며
> 현행이 아니다(이력으로 보존한다). 승인된 것은 **M5a slice뿐**이고 전체 suite 1회·live acceptance·
> M5 전체 완료는 그대로 남는다.

> **상태 정정(2026-07-27, 3차 리비전 — 당시 기록).** M5a는 **내부 stacked M5 slice**다. 전체 suite(`npm test`)는
> **아직 돌리지 않았고**(supervisor가 M5b~M5d 이후 **최종 M5 handoff에서 직렬 1회** 예약),
> **M5a handoff는 supervisor 리뷰 전까지 승인된 것이 아니다.** 아래 "완료" 표기는 **offline focused·exec
> suite 범위**를 뜻한다.

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
  **증명 도구도 신뢰 대상이다(3차 리비전 · A/P1)**: `gitExecutablePath`(신뢰된 절대·정규·비-symlink·
  실행 비트·group/other 쓰기 없음)가 **필수 입력**이고, async·sync 두 조회 모두 그 경로로만 부르며 자식 env는
  **최소 화이트리스트**(`GIT_SANITIZED_ENV`)다 — `PATH`·`HOME`·상속 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_*`·
  자격증명이 판정에 끼어들 통로가 없고 system/global config는 **사용자 상태를 읽지 않고** 끈다.
  git 실행 파일 **신원(dev+ino)** 도 고정해 spawn 직전에 다시 확인한다.
  **만료는 두 번 본다(2026-07-27 2차 리비전).** ⓑ의 첫 검사와 spawn 사이에는 **비동기 git 조회**가 있어
  그 사이에 승인이 만료될 수 있었다. 이제 `nowMs`에 **함수(clock)** 를 주면 `revalidateSync()`(spawn 직전
  마지막 동기 검증)가 **시각을 다시 읽어** `now >= expiresAt`을 재확인하고, 읽을 수 없는 시각도 거부한다
  (fail closed). 숫자를 주면 그 시각으로 고정된다.
- **신뢰 판정의 근거는 spawn 직전 단일 동기 게이트다(3차 리비전 · A/P0).** 이전 판은 홈·실행 파일을
  **비동기 경계 작업 전에** 검사하고 그 뒤에는 경계 재검증만 했다 → 그 창에서 홈/실행 파일이 교체·symlink화·
  권한 완화·inode 교체되면 spawn까지 도달할 수 있었다. 현행: **await가 하나도 남지 않은 상태에서**
  ① `spec` 스냅샷(해석값 + `cwd`) ② 승인 만료 · git 신원 · checkout 신원 · HEAD ③ `CODEX_HOME`
  (정규 · 비-symlink · 0700 · 사용자 홈 아님 + **고정 신원**, 첫 invocation은 **여전히 비어 있음**)
  ④ codex 실행 파일(신뢰 조건 + **고정 신원 dev+ino**)을 순서대로 재확인하고 **바로 다음 문장이 spawn**이다.
  실행 파일을 경로·mode가 아니라 **신원**으로 묶으므로 **같은 0755 다른 실행 파일로 교체**해도 거부된다.
  남는 창은 syscall 몇 개 규모이며 `fexecve`·디렉터리 fd 상대 실행이 없는 Node에서 **0이라고 주장하지 않는다**.
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
  **resume은 파서 수준에서 기대 신원과 대조한다(3차 리비전 · A/P1)**: provider가 `expectedSessionId`를
  넘기고, 다른 thread id가 오면 **init을 만들기 전에 스트림을 봉인**한다 — 같은 chunk에 뒤따라 오던
  assistant·status·도구 이벤트까지 방출 0이고, bounded `session_identity_conflict` marker와 결과 1건만
  나가며 둘 다 **기대 UUID**를 싣는다(관측된 다른 id·usage·본문은 어디에도 남지 않는다).
  그 세션은 닫히므로 후속 `send`는 **spawn 0**이다.
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
- **핸들은 세션 인스턴스에 묶인다(5차 리비전).** `sessionId`는 **교체 세션과 같은 값**이므로 신원이 될 수
  없다. provider가 세션 인스턴스마다 **내용 없는 frozen 신원 객체**를 만들어 `start`가 반환하는 핸들에
  붙이고(`SessionHandle.providerBinding` — **선택 필드라 다른 provider는 영향 없다**), 모든 진입점이
  **참조 동일성**으로 대조한다. 낡은·위조 핸들의 `send`/`events`는 대상 세션을 **읽지도 건드리지도 않고**
  `codex_stale_handle`이며, `stop`은 **무해·멱등**이다(교체 세션에 signal·close·상태 변경·삭제 0).
  신원은 비밀 material이 아니다 — 빈 객체 참조이므로 로그·직렬화·문서에 남길 값 자체가 없다.
- **실행 권위는 `start()`가 포착한 값뿐이다(5차 리비전).** invocation 도중 `this.opts`에서 다시 읽는
  실행 입력은 **하나도 없다**: **시각 권위(clock)** 와 **검증된 manifest 사본**까지 봉인하고 실행 경계에는
  봉인값만 넘긴다. 봉인된 clock은 만료 검사마다 **다시 호출**되므로 시간은 자연스럽게 흐르고(시각을 얼리지
  않는다), `opts.nowMs`의 교체·제거·추가와 manifest **전 필드**(canonical digest) 변경은 드리프트로 잡힌다.
  `opts.spawn`은 **생성자에서 포착**되어 이후 교체가 무의미하다(테스트로 고정).
  **start 이후 드리프트 marker는 `codex_spec_mutated` 하나**이고 — 값이 *바뀐* 경우와 *무효가 된* 경우가
  같은 marker다 — **초기 `start`의 native 코드**(`codex_sandbox_forbidden`·`codex_config_invalid`·
  `invalid_manifest` 등)는 그대로 유지된다.

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

> **M5b 갱신(2026-07-27 — 커밋 `1a94261`+`42777d9`, **1차 리비전 `6bc390d`로 정정됨**).**
> `C-21`(프로토콜 실패 뒤 resume) · `C-25`(turn마다 `events()` 재구독) · `C-27`(취소 promise 정착)은
> **아래 표에서 fixed**로 닫았고, M4c 리뷰 대장의 `C-16`(taskId↔roleId 교차 모호성)도 같은 커밋에서 닫았다.
> **`B-8`은 `1a94261`에서 닫혔다고 적었지만 그 판정은 성립하지 않았다** — 독립 리뷰(A5)가 ⓐ 중복 종료 결과
> ⓑ 부분 문자열 헤더 검사 ⓒ 중복·모순 섹션으로 게이트를 다시 열었다. `B-8`은 **리비전 `6bc390d`에서
> 새 증거로 다시 닫았다**(아래 표의 증거란 갱신).
> **`B-7`·`B-9`는 live 하드 게이트로 그대로 open**이다(M5b는 live를 켜지 않았다 — 실제 Codex 추론 0 ·
> secret 사용 0 → 트리거 미소진, M5c로 이월).
> **M5c 소유로 남은 것**: `C-17`(kernel 만료 `>=`) · `C-18`(deadline·취소·자손 정리) · `C-19`(reviewer
> 결과를 kernel state로 옮기기 전 schema 검증) · `C-22`(재시작 소유권·복구) · `C-24`(stderr 정확한 상한) ·
> `C-26`(신뢰된 git/worktree 자동화) + **신규 `B-10`~`B-13`**(아래 별도 표). 이 여섯은 **fixed로 주장하지
> 않는다** — 리비전은 이들을 손대지 않았다.
> **M5b는 리비전 이후에도 독립 재리뷰를 받지 않았으므로 위 fixed 판정 전부가 다음 fresh Codex 독립 리뷰의
> 재확인 대상이다.**

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-6` | **B (P1) → fixed(M5a 리비전)** | **`codex exec --help` 실측이 없다.** M5a 세션에서 로컬 codex 바이너리 실행 승인이 나지 않아(권한 거부 3회) argv·플래그 철자·`--config` TOML 표기·JSONL 필드명을 **로드맵 §1의 기록**(`0.146.0-alpha.3`)으로만 잡았다. 파서는 `thread_id`/`session_id` 같은 별칭을 받지만 이름이 다르면 세션 id 관측·usage가 비게 된다 | 중간 — alpha CLI의 필드명은 잘 바뀐다 | provider 1개(잘못된 플래그는 codex 비정상 종료 → fail closed. 조용한 오작동은 usage/세션 id 누락뿐) | 중 — 실측 없이 live를 켜면 첫 실행이 전부 실패로 낭비된다 | 소(help 1회 + fixture 갱신) | **M5b live 착수 전(하드 게이트)** | 다음 구현 세션(M5b) | **supervisor 실측(codex-cli `0.146.0-alpha.3`, parse-only·추론 미실행)**: fresh `exec`는 `--config`·`--strict-config`·`--model`·`--sandbox`·`--cd`·`--ephemeral`·`--ignore-user-config`·`--ignore-rules`·`--output-schema`·`--json`·stdin `-`를 받고, `exec resume`는 `--config`·`--strict-config`·`--model`·`--ignore-user-config`·`--ignore-rules`·`--output-schema`·`--json`만 받는다(**subcommand-local `--sandbox`/`--cd` 없음** — `exec resume <uuid> --sandbox … --cd … --help`는 거부, `exec --sandbox … --cd … resume --help`는 파싱). M5a 리비전이 이 배치를 argv 컴파일러와 파싱 계약 테스트에 고정했다. **JSONL payload 필드명은 provider live 경로로 확인하지 않았다 — 그 부분은 `B-9`로 남는다** | **fixed (2026-07-27, M5a 리비전 — 플래그 배치 한정)** |
| `B-7` | **B (P1)** | **격리 `CODEX_HOME`에는 자격증명이 없어 live 인증 방식이 미정이고, live secret 값 redaction도 미해결이다.** ⓐ 인증: auth 파일 복사·영속화를 금지했으므로 live는 "승인된 env 하나를 명시 전달 / 격리 홈에 사람 1회 로그인 / 다른 방식" 중 하나를 **사람이 결정**해야 한다(M5a 리비전에서 자식 env를 `CODEX_HOME` 하나로 좁혀 이 결정 없이는 live가 아예 인증되지 않는다 = fail closed). ⓑ redaction: 현재 `redactSecrets(stderr)`는 **알려진 secret 값 목록 없이 패턴만** 보므로 실제 토큰이 stderr에 찍히면 못 가릴 수 있다 → live 전에 **stderr를 아예 버리거나** `collectSecretValues`로 **승인된 정확한 값만** 넘겨야 한다 | 확실(설계상) | live 실행 전부 · live 오류 요약의 secret | 중 — 결정 없이 켜면 매 실행이 인증 실패이고, 값 목록 없이 켜면 토큰이 요약에 남을 수 있다 | 소~중(결정 + env allowlist 1개 + redaction 입력 배선) | **첫 live 실행 착수 전(하드 게이트).** **M5b 갱신**: offline M5b는 이 게이트를 지나지 않았다(live provider 추론 0 · secret 사용 0)이므로 트리거는 **M5c/M5d live 착수 시점으로 이월**된다 | 사용자 + live를 켜는 구현 세션(M5c) | `compileCodexEnv` · `summarizeError`/`redactSecrets` · 2026-07-27 fresh Codex 리뷰 P1/B · DECISIONS 2026-07-27(M5a) | open |
| `B-8` | **B (P1) → `1a94261` "fixed" 불완전(1차 독립 리뷰 A5가 reopen) → `6bc390d` "fixed"도 불완전(2차 독립 리뷰 A5a가 다시 reopen) → fixed(M5b 2차 리비전 `55b488f`)** | **`src/exec/reviewer.ts`가 리뷰 결과를 무비판적으로 받는다**: `result.isError`를 보지 않고, 비어 있거나 구조화되지 않은 출력도 `extractCriticalRisks`가 Critical 0건으로 읽어 **"통과"가 된다**. 즉 리뷰어 세션이 실패하거나 아무 말도 못 하면 게이트가 조용히 열린다. M5a는 provider 계층만 다뤘고 controller 통합은 범위 밖이라 이번에 고치지 않았다 | 중간 — live 리뷰어는 실패·빈 출력이 드물지 않다 | 리뷰 게이트 전체(잘못된 "통과") | **높음** — 리뷰 게이트를 신뢰한 채 M5b 자동 왕복을 켜면 잘못된 통과가 산출물로 굳는다 | 소~중(`isError`·빈 출력·헤더 부재를 실패로 + 회귀 테스트) | (닫힘 — 원래 기한은 **M5b에서 reviewer를 처음 배선하기 전(하드 게이트)** 이었고 그 전에 닫았다) | M5b 구현 세션 | 2026-07-27 fresh Codex 리뷰 P1/B · `src/exec/reviewer.ts` `reviewDiff` · **fix(M5b)**: `reviewDiff`가 **판정을 만들지 않고 던진다** — 안정 `ReviewGateError` 코드 1개씩: provider throw/스트림 소비 실패 `reviewer_provider_failed` · 종료 결과 부재 `reviewer_no_result` · `isError`/실패 종료 `reviewer_result_error` · 빈 출력 `reviewer_empty_output` · 필수 헤더(`## Risks / Known Limitations` · Critical) 부재 `reviewer_malformed_output` · `## Verdict: pass\|revise\|block` 부재·미상 값·**verdict와 Critical 목록 모순**(pass인데 Critical 있음 / revise·block인데 Critical 없음) `reviewer_verdict_invalid`. 증거: `reviewer.test.ts` focused 회귀 + mutation(fail-open 복원 → 실패). **reopen 사유(독립 리뷰 A5/P1)**: 그 판은 ⓐ `if (e.kind === "result") result = e`로 종료 결과를 **덮었으므로 실패 종료 뒤 성공 종료가 통과**했고 ⓑ 필수 헤더를 `raw.includes(...)` **부분 문자열**로만 봤으므로 코드 펜스 안의 헤더·프롬프트 인용이 헤더로 통했고 ⓒ **첫** verdict·첫 Critical만 읽었으므로 **모순되는 섹션을 중복**으로 넣어 판정을 고를 수 있었다. 게다가 스키마가 **활성 로드맵 §5.2 `review_result`가 아니라** 사고 계층 red_team의 `## Risks`/`### Critical`이었다. **fix(1차 리비전 `6bc390d`)**: 공용 `consumeExactlyOneTerminal`(`types.ts`)이 종료 결과를 **정확히 1건**만 받고 두 번째 종료·종료 뒤 이벤트를 `reviewer_duplicate_terminal`로 거부한다(`StableController`도 같은 소비자를 쓴다 — `provider_duplicate_terminal`). 파서는 **코드 펜스를 걷어낸 뒤** top-level `## ` heading을 뽑아 §5.2 필수 6개(`Reviewed Revision and Hash` · `Findings (P0/P1/P2)` · `Reproduction or Evidence` · `Missing Tests` · `Contract Deviations` · `Verdict`)가 **각각 정확히 1회**여야 하고 **미상 heading·중복 섹션·`없음`과 P0/P1/P2 동시 서술을 거부**하며, verdict는 `pass\|revise\|block` **정확히 1개**여야 하고 `pass`는 **P0·P1 0건**일 때만 성립한다(P2는 pass와 공존). 리뷰 대상은 호출자가 **명시로 준** `subject.revision`/`subject.hash`에 묶는다(`reviewer_subject_mismatch`/`reviewer_subject_invalid`) — 본문 자기 주장만으로는 통과하지 않는다. `buildReviewPrompt`와 **모든 caller/mock**(`sessionRunner.ts`·`sessionRunner.test.ts`·`mission.test.ts`·`parallelMission.test.ts`)을 새 스키마로 갱신했다. 리비전 증거: `reviewer.test.ts` focused **14/14**(중복 종료 2 · 펜스 주입 2 · 중복·모순 5케이스 · 대상 신원 4케이스) + mutation(중복 섹션 거부 제거 → 1건 실패 / 공용 소비자의 중복 종료 거부 제거 → 5건 실패)  **2차 reopen 사유(독립 리뷰 A5a/P1)**: 그 판도 파서가 열려 있었다 — ⓐ 대상 신원을 섹션 전체 문자열의 `includes`로 봐서 **라벨 뒤바뀜 · 접두/접미 · "다른 대상 + 기대값 언급"** 이 통과했고 ⓑ 펜스 파서가 **여는 길이를 잊어** 3-백틱 줄이 4-백틱 블록을 닫아 블록 안의 가짜 `## Verdict: pass`가 본문으로 새어 나올 수 있었고 ⓒ findings 섹션의 **형식을 벗어난 비공백 줄을 조용히 무시**해서 `- 없음` + 불릿 없는 `P1: 승인 우회`가 함께 통과했다. **fix(2차 리비전 `55b488f`)**: 대상 섹션은 비공백 줄이 **정확히 `- revision:` 1개 · `- hash:` 1개**이고 두 값이 호출자 기대값과 **완전 일치**여야 한다(중복 라벨·미상 줄 거부). 펜스는 **문자와 여는 길이**를 기억해 같은 문자 · 여는 길이 이상 · 뒤 공백만인 줄로만 닫는다(틸드 동등). findings의 미상 비공백 줄은 **거부**하고 항목 본문은 비어 있지 않고 `MAX_FINDING_CHARS`(1000) 이하여야 하며, 필수 heading은 각 1회 + **정확한 순서**다. 경계 밖 오류(`start` · `events()` · 스트림 소비 · `stop`)는 전부 `reviewer_provider_failed`로 접힌다(A5b). 증거: `reviewer.test.ts` **19/19**(신규 5건 — 라벨 11케이스 · 펜스 3변형 · findings 5케이스 · heading 순서 · 임의 코드 7케이스) + mutation 7종 전부 kill·원복 | **fixed (2026-07-28, M5b 2차 리비전 `55b488f`)** |
| `B-9` | **B (P1)** | **codex JSONL payload 필드명·semantics를 provider live 경로로 확인하지 않았다.** supervisor 실측은 **플래그 파싱까지**이고(`B-6` fixed), 이벤트 필드(`thread_id` 등)는 별칭을 받아 두었을 뿐이다. 이름이 다르면 세션 id·usage가 비고 resume이 막힌다(성공으로 오인되지는 않는다 — `missing_session_id`가 실패다) | 중간 — alpha CLI | provider 1개(fail closed 방향) | 중 — 확인 없이 live를 켜면 첫 실행이 전부 실패로 낭비된다 | 소(live 1회 캡처 + fixture 갱신) | **첫 live 실행 착수 전(하드 게이트).** **M5b 갱신**: M5b offline slice는 live를 켜지 않았으므로(실제 Codex 추론 0) 트리거는 소진되지 않았고 **M5c/M5d의 live runner 착수 시점으로 그대로 이월**된다 | 사용자 + live를 켜는 구현 세션(M5c) | `codexStreamParser.ts` 상단 주석 · `B-6` 증거란 | open |
| `C-18` | C (P2) | **no-progress deadline · wall-clock deadline · cancellation/descendant 정리가 없다.** provider는 `stop()`으로 SIGTERM만 보내고 자손 소멸을 확인하지 않는다. §M5 "bridge 실행 요건"의 나머지 절반이다 | 중간(실제 live 세션에서) | 세션 1건이 오래 매달릴 수 있다(상태 오염은 아님 — 결과는 여전히 1건) | 중 — live 운영 전에는 필요하다 | 중 | **M5c live runner/lifecycle 도입 시**(M5b offline slice는 프로세스 수명을 손대지 않았다 — controller 주석이 명시적으로 M5c로 넘긴다) | **M5c 구현 세션** | `CodexCliProvider.stop()` · 로드맵 §10 M5 목표 · `stableController.ts` 머리말 "이 범위가 아닌 것(M5c/M5d)" | open |
| `C-19` | C (P2) | **`--output-schema`를 넘겨도 응답 본문을 schema로 검증하지 않는다.** provider는 최종 agent message 텍스트를 그대로 `result.text`로 준다(호출자가 파싱). **M5b 갱신**: controller는 provider 본문을 durable state로 옮기지 않으므로(bounded 안정 summary만 기록) 이 항목은 여전히 M5c 범위이고, `B-8`이 닫힌 지금 **reviewer 판정 자체는 헤더·verdict 계약으로 검증된다**(schema 검증과는 별개다) | 중간 | 구조화 결과 1건의 형태 오류가 호출자에게 넘어간다 | 낮음 — 검증기를 나중에 얹으면 된다(기존 수동 closed validator 방식) | 소~중 | **reviewer 결과를 kernel state로 옮기기 시작할 때(M5c)** | **M5c 구현 세션** | `codexStreamParser` `lastMessage` · M5a focused "구조화 최종 출력" · M5b `reviewer.ts` verdict 게이트 | open |
| `C-21` | **C (P2) → fixed(M5b)** | **프로토콜 실패로 끝난 invocation 뒤에도 resume이 허용된다**(MCP 위반·세션 신원 충돌만 세션을 닫는다). malformed·oversized·중복 종료로 실패한 turn 뒤에 호출자가 `send`를 부르면 provider는 그 thread를 이어간다 — 판정은 `result.isError`를 보는 호출자 몫이다 | 중간(호출자가 `isError`를 무시할 때) | 세션 1건의 후속 turn | 낮~중 — `B-8`(reviewer가 `isError`를 무시한다)과 같은 방향의 위험이고 그쪽을 닫으면 대부분 사라진다 | 소(실패 사유 화이트리스트로 poison 확장 + 회귀 테스트) | (닫힘 — 원래 기한은 **`B-8`을 닫을 때 같이(= M5b reviewer 배선 전)** 였고 같은 세션에서 함께 닫았다) | M5b 구현 세션 | `CodexCliProvider.send`/`state.poisoned` · M5a 2차 리비전 focused "MCP 위반을 본 세션은 닫힌다" · **fix(M5b)**: 파서가 **비가역 프로토콜 실패**를 기록한 invocation이 닫히면 세션도 `codex_protocol_failed`로 닫는다(MCP 위반·세션 신원 충돌과 같은 취급) → malformed·과대 줄·중복/모순 종료로 실패한 turn 뒤의 `send`는 **spawn 0**이다. 증거: `codexCliProvider.test.ts` focused(58/58) poison 케이스 + mutation(poison 제거 → 실패) | **fixed (2026-07-27, M5b)** |
| `C-22` | C (P2) | **`CODEX_HOME` 소유 신원이 in-memory라 controller가 재시작하면 같은 홈으로 resume할 수 없다**(신원을 잃으므로 최초 검증 규칙에 걸려 `codex_home_not_empty`). 방향은 fail closed이지만 self-hosting 재시작 후 진행 중 세션을 이어갈 수 없다 | 중간(M5c self-hosting에서) | 재시작 시점에 열려 있던 codex 세션의 resume | 낮~중 — 재시작 후에는 새 세션으로 다시 시작하면 된다 | 중(소유권을 `run_state.json`에 durable 기록 + 복원 검증) | **self-hosting controller 재시작 경계를 다룰 때(M5c)** | M5c 구현 세션 | `CodexState.homeId` · M5a 2차 리비전 focused "격리 홈 수명" | open |
| `C-23` | **C (P2) → 3차 "fixed"는 overclaim(절반만 닫힘) → 4차 reopen 후 fix → 4차 fix도 완전하지 않았다(5차 독립 리뷰가 다시 reopen: 봉인 밖 `nowMs`·`manifest` 재읽기) → fixed(M5a 5차 리비전)** | **호출자 소유 `spec`/`opts`의 변조.** ⓐ turn 사이 변경으로 model·`--output-schema` 경로가 resume에서 달라질 수 있었다. ⓑ **한 invocation의 비동기 경계 작업 중** 값이 바뀌면 검증한 값과 argv·env가 갈라질 수 있었다. **ⓒ reopen 사유(4차 · 독립 리뷰 A/P1)**: 3차 fix는 **같은 invocation 안의** 스냅샷만 대조하고 provider는 여전히 `state.spec`을 들고 **매 turn `resolveCodexOptions`를 다시 해석**했다 → 1차 turn 완료 후 `send` 전의 변조가 **새 baseline**이 됐다. 즉 ⓐ는 닫히지 않았는데 대장·문서가 fixed라고 적었다(overclaim) | 낮~중 — `spec`/`opts`는 controller 소유 객체이지만 M5b 배선이 정확히 그 경로다 | 세션 1건의 invocation 설정 전체(argv·env·홈·실행 파일·경계 입력) | 중 — M5b provider 배선이 이 계약을 그대로 신뢰한다 | 소(start에서 봉인 + 필드 단위 대조) | (닫힘 — 원래 기한은 **M5b provider 배선 전**이었다) | **M5a 5차 리비전(최종 closer)** — 3차 overclaim · 4차 부분 fix · **5차가 닫았다** | **fix(4차)**: `start()`가 유효 옵션 **전부**를 봉인한다(`sessionId`·`model`·`reasoningEffort`·`sandbox`·`codexHome`·`outputSchemaPath`·`ephemeral`·`cwd`·codex/git 실행 파일 경로·`controllerRepoRoot`·manifest `milestoneId`/`approvedCommit`/`expiresAt`/`maxSessions`/`maxTokens`/`maxElapsedMs`, `Object.freeze`). **모든 invocation 동기 진입 + spawn 직전 게이트**에서 `SEALED_KEYS` **명시 필드 목록**으로 대조하고(JSON 키 순서 의존 없음) 드리프트는 단일 marker `codex_spec_mutated`다. argv·env·경계 입력은 전부 봉인값에서만 만든다. 증거: focused "C-23: turn 사이 spec/opts 변조 …" **9케이스**(model·outputSchema·cwd·codexHome·ephemeral·sessionId·codexBinaryPath·gitExecutablePath 드리프트 + sandbox는 재해석에서 `codex_sandbox_forbidden`) — 각 케이스 spawn 1차 그대로 · 이전 완료 큐 교체 0 · 되돌린 뒤 정상 turn 1건 + 기존 "창 안에서 spec이 변조되면 …" 4케이스 유지 + mutation(봉인값 대신 매 turn 재해석 → **between-turn 테스트만** 실패 / 필드 비교 무력화 → 2건 실패). **ⓓ 2차 reopen 사유(5차 · 독립 리뷰 A/P1)**: 4차 봉인 목록에 **`nowMs`와 manifest 객체가 없었다** → 매 invocation `this.opts.nowMs`/`this.opts.manifest`를 다시 읽었고, 첫 turn 뒤 호출자가 시계를 만료 전 시각을 말하는 함수로 갈아끼우면 **경계 진입·spawn 직전 두 만료 검사가 모두 통과**해 **실제로는 만료된 승인 아래 resume이 떴다**(mutation으로 재현: 그 상태에서 send가 `(통과)` + spawn 2건). **fix(5차)**: 시각 권위와 **검증된 manifest 사본**을 봉인해 경계에 봉인값만 넘기고(`nowMs: s.clock` · `manifest: s.manifest`), `SEALED_KEYS`에 `clock`·`manifestDigest`를 더했다. 봉인 clock은 만료 검사마다 **다시 호출**한다(시각 고정 아님). `opts.spawn`은 생성자 포착이라 재읽기 자체가 없다(무관함을 테스트로 고정). 증거: focused "C-23: 시각 권위는 봉인된다 …"(교체 → `codex_spec_mutated`+spawn 0 · 되돌림 → 같은 시계가 `manifest_expired` · 시간 되돌아오면 정상 turn · 제거 → `codex_spec_mutated`) + 드리프트 표 **17케이스**로 확장 + mutation 3종 | **fixed (2026-07-27, M5a 5차 리비전)** |
| `C-27` | **C (P2) → fixed(M5b)** | **`stop()`이 `starting` 상태에서 돌아올 때 그 invocation의 promise는 아직 정착하지 않았다.** `stop`은 claim을 취소하고 즉시 반환하지만, 취소된 `start`/`send`는 진행 중인 비동기 경계 작업이 끝난 뒤에야 `codex_invocation_cancelled`로 **reject**된다. 프로세스는 뜨지 않는다(테스트로 고정) — 남는 것은 "stop 반환 후에도 호출자가 그 promise를 받아야 한다"는 계약이 코드/문서에만 있다는 점이다 | 중간(오케스트레이션 배선에서 promise를 버리면 unhandled rejection) | 취소 경로의 호출자 배선 | 낮~중 — 배선 시 `stop` 전 promise를 잡아두면 된다. 안 잡으면 로그 소음이지 상태 오염은 아니다 | 소~중(취소 시 즉시 settle하거나 `stop`이 진행 중 invocation을 await) | (닫힘 — 원래 기한은 **provider를 orchestrator에 배선할 때(M5b — `C-25`와 같은 게이트)** 였고 그 배선과 같은 세션에서 닫았다) | M5b 구현 세션 | `CodexCliProvider.stop`/`claim`/`assertOwned` · M5a 4차 리비전 focused "stop은 child 없는 claim도 취소한다" · "stop 뒤 교체 세션 …" · **fix(M5b)**: 취소 신호가 호출자 promise를 **즉시** `codex_invocation_cancelled`로 정착시키고 `stop()`은 그 invocation이 **정착한 뒤에** 반환한다. 호출자에게 주는 promise에는 **항상 handler가 하나 붙어** 있어 취소 promise를 버려도 unhandled rejection이 나지 않는다(`stop`은 진행 중 git 조회를 기다리지 않는다). 증거: `codexCliProvider.test.ts` focused(58/58) 취소·정착 케이스 + mutation(handler 제거 → unhandled rejection으로 실패) | **fixed (2026-07-27, M5b)** |
| `C-28` | **C (P2) → fixed(M5a 5차 리비전)** | **봉인 대상 밖의 manifest 필드는 turn 사이에 고정되지 않는다.** 4차 리비전은 manifest의 신원·TTL·상한(`milestoneId`·`approvedCommit`·`expiresAt`·`maxSessions`·`maxTokens`·`maxElapsedMs`)만 봉인했다. `writableRoots`·`ownershipByTask`·`allowedCommands`·`allowedDependencies`·`allowedNetworkDomains`·`localMergeAllowed`가 turn 사이에 바뀌면 드리프트로 잡히지 않는다. **M5a provider는 이 필드들로 아무 판정도 하지 않으므로**(read-only sandbox · 명령 실행 없음 · 네트워크 없음) 지금은 실행 결정에 영향이 없고, 매 invocation `validateApprovalManifest`를 다시 지나므로 형태 위반은 여전히 fail closed다 | 낮음 — 현재 provider가 읽지 않는 필드다 | 이 필드들을 실제로 집행하는 계층(권한 컴파일러·kernel)이 붙은 뒤의 판정 | 중 — task-bound 권한 계층(`workspace-write` 재도입)에서는 이 필드가 곧 판정 근거가 된다 | 소(`SEALED_KEYS`에 canonical manifest 전체 해시 1개 추가) | (닫힘 — 원래 기한은 **manifest 권한 필드를 실제로 집행하는 계층을 붙일 때**였다) | M5a 5차 리비전 | **fix(5차)**: `sealCodexSpec`이 **검증·정규화된 manifest 사본**과 그 **canonical digest**(정규화 결과의 결정론적 JSON)를 봉인하고 `SEALED_KEYS`에 `manifestDigest`를 더했다 → 신원·TTL·상한뿐 아니라 `writableRoots`·`ownershipByTask`·`allowedCommands`·`allowedDependencies`·`allowedNetworkDomains`·`localMergeAllowed`까지 **한 필드도 빠짐없이** turn 사이에 고정된다. 실행 경계에도 `this.opts.manifest`가 아니라 **봉인 사본**을 넘긴다(승인 자체를 갈아끼우는 경로 제거). 오류에는 키 이름만 싣는다(digest 내용 미노출). 증거: focused 드리프트 표의 manifest 5케이스(`approvedCommit`·`expiresAt` 연장·`writableRoots`·`allowedCommands`·`localMergeAllowed`) + "manifest 무효화" 1케이스 — 전부 `codex_spec_mutated` · spawn 1차 그대로 · 이전 완료 큐 교체 0 · 되돌린 뒤 정상 turn 1건 | **fixed (2026-07-27, M5a 5차 리비전)** |
| `C-24` | C (P2) | **stderr 버퍼 상한이 chunk 단위로만 적용된다**(`stderr.length < MAX_STDERR_BUFFER` 검사 뒤 chunk 전체를 붙인다 → 한 chunk만큼 초과 가능). 밖으로 나가는 요약은 여전히 `MAX_ERROR_CHARS` + `redactSecrets`로 bounded하다 | 낮음 | 실패 1건의 메모리 상한(정확도) | 낮음 | 소(붙일 때 잘라내기) | **live runner 도입 시(M5c, `C-18`과 함께)** | M5c 구현 세션 | `CodexCliProvider.invoke` stderr 핸들러 | open |
| `C-26` | C (P2) | **경계 밖의 `runProcess` git 호출자는 여전히 `git`을 이름으로 부르고 `process.env`를 상속한다**(worktree 유틸·기계 게이트 등). M5a 3차 리비전은 **`executionBoundary`로 범위를 한정**했다(리뷰 지시). 이 호출자들은 **승인 커밋을 증명하지 않으므로** 경계 우회는 아니지만, 적대적 `PATH`·`GIT_*` 아래에서는 worktree 조작·조회가 다른 저장소를 볼 수 있다 | 낮~중 — 로컬 개발 환경 가정에서는 낮다 | worktree 생성·삭제·조회 경로(실행 승인 판정은 아님) | 낮~중 — 지금 함께 바꾸면 M5a 위험 예산을 넘고, 나중에 하면 호출자별 회귀 확인이 필요하다 | 중(공용 `git()` 헬퍼 1개 + 호출자 전환 + 회귀) | **controller가 worktree 조작을 자동화 경로로 쓰기 시작할 때(M5c 자율 실행 전)** | M5c 구현 세션 | `src/exec/runProcess.ts` 호출자 · `executionBoundary`의 `GIT_SANITIZED_ENV` 대비 · 2026-07-27 독립 리뷰 A/P1 범위 한정 | open |
| `C-25` | **C (P2) → fixed(M5b — 소비자 배선으로 닫음)** | **`events(handle)`는 현재 invocation의 큐를 준다** — `send` 전에 잡아 둔 스트림은 그 invocation이 끝나며 닫히고, 후속 turn 이벤트는 **다시 `events()`를 불러야** 나온다. 결과 유실은 아니지만(각 invocation은 종료 결과 1건으로 닫힌다) 소비자 계약이 문서에만 있다 | 중간(오케스트레이션 배선 시 오해하기 쉽다) | 소비자 배선 | 낮~중 — 배선 코드에서 turn마다 다시 구독하면 된다 | 소~중(멀티 turn 하나의 스트림으로 합치기 + 테스트) | (닫힘 — 원래 기한은 **provider를 orchestrator에 배선할 때(M5b)** 였다) | M5b 구현 세션 | `CodexCliProvider.events`/`invoke`의 큐 교체 · M5a focused "실행 중 send" · **fix(M5b — 계약 변경이 아니라 소비자 배선으로 닫았다)**: provider의 per-invocation 큐 계약은 그대로 두고, `StableController`가 **turn마다 `events(handle)`를 다시 불러** 그 invocation의 bounded 스트림(상한 `MAX_TURN_EVENTS`)을 끝까지 소비한다. 멀티 turn을 하나의 스트림으로 합치지 않았다(불필요한 상태 추가 회피). 증거: `stableController.test.ts` focused(19/19) 다중 turn 케이스 + mutation(예전 iterable 재사용 → 두 번째 결과 유실로 실패) | **fixed (2026-07-27, M5b)** |

#### M5b 1차 리비전(독립 fresh Codex 리뷰)에서 추가·재분류된 유예 항목 (2026-07-27 기준)

리뷰가 낸 **A/P1 5건은 리비전 커밋 `6bc390d`에서 전부 fixed**다(§10 M5 → M5b 1차 리비전 표).
아래는 같은 리뷰가 **유예로 지목한 항목**과 **트리거가 발화한 기존 항목**이다. 하나도 조용히 버리지 않는다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-10` | **B (P1)** | **타입 있는 edit 가능 실행 집행이 없다.** M5b가 실제로 증명할 수 있는 것은 "아무것도 실행하지 않는 read-only planning/review turn"뿐이다. `ExecutionRequest`는 handoff의 **자기 선언**이고 provider의 실제 권한과 독립이므로, 명령·쓰기·dependency·네트워크를 **집행**하려면 승인 단계에서 명령을 **구조화(프로그램+인자)** 로 받고 실행 계층이 그 구조만 실행하는 계층이 필요하다. `HARD_DENY_COMMAND_SCREEN`은 **정직한 선언에 대한 token 화면**이며 wrapper(`bin/git push` · `git -c … push` · alias · `sh -c` · 스크립트 경유)를 잡지 못한다 — **불완전한 shell 파서는 만들지 않는다**(`C-14`와 같은 결정) | 확실(미구현) | edit 가능 실행 전부 | **높음** — 집행 없이 Claude 쓰기 실행을 켜면 승인 문서가 장식이 된다 | 중~대(별도 승인 범위) | **M5c에서 Claude 쓰기 실행(edit 가능 provider)을 켜기 전 — 하드 게이트** | M5c 구현 세션 + 사용자(승인 형식 결정) | 독립 리뷰 A2/P1 · `stableController.ts` 머리말 "이 slice의 정확한 계약" · `assertReadOnlyRequest`/`assertReadOnlySpec` · `C-14` 인접 | open |
| `B-11` | **B (P1)** | **선택된 batch 전체가 per-task preflight **전에** running이 된다.** `startScheduledBatch()`가 한 커밋으로 전부 `running`으로 올리므로, 뒤 task가 예산·게이트로 시작되지 못하면 그 task는 **자원(배타 자원 class·세션 예산)을 붙잡은 채 running으로 남는다**. 리비전은 **새 provider 호출이 일어나지 않는 것**만 보장했고(`B-12`/`B-13`과 함께 lifecycle은 손대지 않았다), 이유는 `PreparedTask` 형태의 사전 preflight가 kernel의 "batch 하나 = 커밋 하나" 원자성과 M5c pause/recovery 설계에 함께 걸리기 때문이다 — 지금 좁게 고치면 M5c에서 다시 열어야 한다 | 중간(예산이 batch 중간에 소진될 때) | 그 run의 scheduling 처리량(정확성·durable 무결성은 무관 — 시작되지 않은 task는 결과를 내지 않는다) | 중 — autopilot이 사람 개입 없이 돌기 시작하면 자원이 조용히 묶인다 | 중(`PreparedTask` 사전 preflight + lifecycle 전이 설계) | **M5c autopilot/무인 advance 착수 전** | M5c 구현 세션 | 독립 리뷰 B · `orchestrationKernel.startScheduledBatch` · `stableController.advanceOnce`의 gate 루프 · focused "[M5b] A3: 앞 task가 토큰 예산을 소진하면 …"(시작 0은 고정 / `state === "running"`은 그대로 단정) | open |
| `B-12` | **B (P1)** | **재시작하면 토큰·경과 회계가 0으로 초기화된다.** `tokensUsed`와 `startedAtMs`는 controller in-memory이므로 프로세스를 다시 띄우면 **같은 승인 아래 예산이 새로 생긴다**(만료 `expiresAt`은 durable하므로 무한은 아니다) | 중간(M5c 재시작/resume에서) | 그 마일스톤의 토큰·시간 예산 상한 | 중 — 무인 재시작 루프가 생기면 승인 예산이 사실상 무제한이 된다 | 중(누적치를 `run_state.json`에 durable 기록 — schema 추가이므로 `C-9` 마이그레이션 판단 필요) | **첫 자동 재시작/resume 도입 전, 늦어도 M5c** | M5c 구현 세션 | 독립 리뷰 B · `StableController.tokensUsed`/`sealed.startedAtMs` · `usedTokens()` 주석 | open |
| `B-13` | **B (P1)** | **durable 완료·자원 해제가 provider 정리 확인보다 먼저이고 `stop` 실패는 삼켜진다.** `submitResult`로 task가 `completed`가 된 뒤 `finally`의 `provider.stop(...).catch(() => undefined)`가 돈다 → 프로세스가 실제로 죽지 않아도 durable state는 "끝났다"이고, 정리 실패는 marker로 남지 않는다. M5b의 in-process provider는 프로세스를 띄우지 않으므로 지금 관측되는 위험은 없다 | 중간(실제 프로세스를 띄우는 순간) | 세션 1건의 프로세스·자원 누수(durable 무결성은 무관) | 중 — live runner에서는 좌초 프로세스가 다음 batch의 배타 자원 판정을 거짓으로 만든다 | 중(`C-18` 자손 정리와 함께: stop 결과를 확인하고 실패를 안정 marker로 올린 뒤 완료) | **M5c live runner 착수 전 또는 다른(프로세스를 띄우는) provider를 배선할 때** | M5c 구현 세션 | 독립 리뷰 B · `StableController.runTask`의 `finally` · `C-18` 인접 | open |
| `C-12` → **B (P1) 재분류** | **B (P1)** | **`C-12`의 트리거가 발화했다.** "실제 worker가 inbox를 소비하기 시작할 때"가 기한이었고 **M5b controller가 정확히 그 소비자다.** 관측된 구체 결과: 전달 turn이 실패하면 그 전달은 **unack 상태로 running task의 inbox에 남고**, 앞으로의 **ready-only advance는 그 task를 다시 고르지 않으므로**(이미 `running`) 재전송 경로가 없다. 방향은 fail closed(유실이 아니라 정지)이지만 **자동으로는 진행되지 않는다** | 중간(전달 turn 실패는 live에서 드물지 않다) | 그 task의 진행(전달 1건이 영구 대기) | 중 — autopilot이 조용히 멈춘 것을 사람이 알아채야 한다 | 중(재전송·타임아웃 정책 + running task 재진입 경로 — `B-11` lifecycle과 같은 설계) | **M5c autopilot 착수 전(더 이상 "미정"이 아니다)** | M5c 구현 세션 | 독립 리뷰 C(트리거 발화) · `acknowledgeDelivery`/`pendingDeliveries` · focused "[M5b] ack는 전달 turn이 성공한 뒤에만 — 실패하면 수령 0"이 이 상태를 그대로 고정한다 | open (reclassified 2026-07-27) |

> **`C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26`은 리비전이 손대지 않았다 — 전부 기존 M5c 트리거로 open이다.**
> 리비전 세션은 이들을 fixed로 주장하지 않는다.

##### M5b 2차 리비전 신규 유예 (2026-07-28)

> **1차 리비전의 "A/P1 5건 전부 fixed · 리뷰 finding 전부 closed" 서술은 과장이었다.** 2차 독립 리뷰가
> 같은 다섯 자리에서 **A=5**를 다시 냈다(A1 재읽기/재진입 · A2 위조 가능 brand · A3 실패 turn 예산 누락 ·
> A5a 파서 허위 승인 · A5b 열린 오류 taxonomy). 2차 리비전 `55b488f`가 그 다섯을 닫았고 **A4는 유지**했다.
> **지금 상태도 "self-approved"가 아니다 — 독립 재리뷰가 다음 게이트다.**

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-29` | C (P3) | **handoff 산출물의 중첩 schema는 복사·freeze만 되고 closed 검증은 top-level까지다.** `sealHandoff`는 `handoff`와 `request`의 **미상 top-level 필드**를 거부하지만 `spec`(`SessionSpec`) 내부 필드와 `outputs[]` 항목의 **여분 key**는 거부하지 않는다(형태만 본다). 지금은 위험이 bounded다 — `assertReadOnlySpec`이 권한을 넓히는 알려진 필드를 전부 막고, provider는 **봉인 해석값으로만** argv를 만들며, 여분 key는 어디에도 쓰이지 않는다 | 낮음 — 여분 key를 읽는 소비자가 없다 | handoff 1건의 미래 필드 오타·오해(권한 확대 아님) | 낮음 — 구조화 필드를 도입할 때 같이 닫으면 된다 | 소~중(closed validator를 중첩까지) | **M5c에서 handoff/실행 요청을 구조화 필드로 바꿀 때**(= `B-10` 타입 있는 집행과 같은 승인 범위) | M5c 구현 세션 | 2차 리뷰 잔여 · `stableController.ts` `sealHandoff`/`HANDOFF_KEYS`/`REQUEST_KEYS` · focused "[M5b] A1: handoff 산출물은 closed 검증을 지난다" | open |
| `C-30` | C (P3) | **controller의 중복 종료·결과 부재·이벤트 상한 방어는 지금 받아들이는 유일한 provider로는 도달할 수 없다.** A2 이후 bridge는 실제 `CodexCliProvider`만 받고, 그 파서가 이미 invocation당 종료를 **1건으로 정규화**한다(중복·모순 종료는 `isError` 1건이 된다). 따라서 controller 층의 `provider_duplicate_terminal`/`provider_no_result`/`provider_stream_unbounded`는 **미래 provider용 defense in depth**이고 end-to-end 경로가 없다 | 확실(설계상) | 없음(현재) — 미래 provider 배선 시 회귀 감지력 | 낮음 — 방어를 지우지 않는 한 위험이 아니다 | 소(새 provider를 붙일 때 e2e 회귀 추가) | **M5c에서 두 번째 실행 provider(Claude/edit 가능)를 bridge에 붙일 때** | M5c 구현 세션 | 2차 리비전 세션 · focused "[M5b] A5: controller 계약 — 종료는 정확히 1건…"(공용 소비자를 **controller가 실제로 쓰는 `CONTROLLER_TERMINAL_CODES`** 로 직접 단정) + "[M5b] A5: codex 파서가 중복·모순 종료를 완료로 만들지 않는다"(실제 provider 경로) | open |
| `C-31` | C (P3) | **controller 테스트가 provider 내부 상태 두 곳을 white-box로 관측한다**: 세션 map(`sessions` — "닫혔는가")과 `spawnFn`(경계 오류 주입). provider를 감싸거나 subclass하면 A2 증명을 통과하지 못하므로 **의도한 절충**이지만, provider 내부 이름이 바뀌면 그 관측이 조용히 무의미해질 수 있다(테스트는 계속 통과한다) | 낮~중 — provider 리팩터 시 | 테스트 관측력 2건(production 동작 무관) | 낮음 | 소(provider가 정리 결과를 관측 가능한 형태로 내놓게 하거나 — `B-13`이 어차피 그 방향이다) | **`B-13`(durable 완료 전 provider 정리 확인)을 구현할 때 같이** | M5c 구현 세션 | 2차 리비전 세션 · `stableController.test.ts` `CodexHarness`/`ObservedSessions` | open |

##### M5b 3차 리비전 신규·갱신 유예 (2026-07-28)

> **2차 리비전도 A를 전부 닫지 못했다.** 3차 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가
> `409dee2..38b8d32`에 대해 **REVISE · A/P1 3건**을 냈다: **A1** 공개 `spawn` seam으로 read-only 증명 위조
> (임의 executor를 주입한 인스턴스도 증명됐고, TS `private spawnFn`은 emitted JS에서 writable own field라
> 테스트가 실제로 덮어썼다) · **A2** exported `ControllerError`로 오류 provenance 위조(`instanceof`가 근거라
> `new ControllerError("result_accepted", …)`가 성공 marker를 단 실패를 만들 수 있었다) · **A3** 다중 artifact
> 등록과 완료가 비원자적(뒤쪽 산출물 실패 시 앞선 artifact·event·revision만 durable에 남음).
> **셋 다 이번 리비전에서 닫았다**(아래 §10 M5b 3차 리비전). 2차 리비전이 "닫았다"고 적은 A2/A5b는
> **같은 뿌리(공개 표면을 provenance로 신뢰)가 남아 있었다** — 그 서술은 dated history로 보존하고
> 현행 판정은 이 절이다. **여전히 self-approved가 아니다.**

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-14` | **B (P1)** | **첫 terminal 뒤 늦은 이벤트·중복 종료·iterator throw로 닫히는 turn의 usage 회계.** 3차 독립 리뷰 B가 지적한 자리 — 이전 판은 스트림이 정상 종료할 때까지 회계를 미뤘으므로 그 경로에서 **이미 태운 토큰이 전역 예산에서 빠지지 않았다**. genuine Codex `AsyncEventQueue`는 그 스트림을 만들지 않으므로 M5b A는 아니었다 | 중간(두 번째 provider·retry 배선 시) | 그 run의 토큰 예산 정확도(durable 무결성 무관) | 중 — 예산 초과가 조용히 지나간다 | 소 | **원래 기한: M5c 두 번째 provider 또는 retry/resume 경로 배선 전.** 작고 안전해 **이번에 앞당겨 닫았다** | 3차 리비전 세션 | `src/exec/types.ts` `consumeExactlyOneTerminal`(종료를 **처음 본 자리에서** 정확히 한 번 회계, 콜백 오류는 참조 동일성으로 그대로 통과) · focused "[M5b] B: 종료 뒤 실패로 닫혀도 **첫 종료의 usage는 회계된다**"(늦은 이벤트 · 두 번째 종료 · 실패 종료 · 종료 뒤 iterator throw · 예산 콜백 throw 5경로) | **fixed (2026-07-28)** |
| `B-15` | **B (P1)** | **`ReviewSubject`가 nonempty만 검사하고 caller object를 async 뒤 재읽기·참조 반환.** 3차 독립 리뷰 B — 하드 기한은 **M5c/`C-19` durable reviewer integration 전**이었다. 인접하고 작아 **이번에 앞당겨 닫았다** | 중간(reviewer 결과를 durable state로 옮기기 시작하면) | 리뷰 판정 1건의 대상 신원(본문 대조가 변조된 기대값에 맞춰질 수 있었다) | 중 — durable 배선 뒤에는 잘못된 대상 판정이 state에 남는다 | 소 | (닫힘 — 원래 기한 `C-19` 착수 전) | 3차 리비전 세션 | `src/exec/reviewer.ts` `sealSubject`(한 줄 · 정규형 · bounded 200자 · 정규 16진 hash 7~64자 · `Object.freeze` 스냅샷, 프롬프트·대조·반환값이 전부 그 스냅샷) · focused "[M5b] B: subject는 한 줄·정규형·정규 hash여야 한다" + "[M5b] B: subject는 봉인 스냅샷이다" | **fixed (2026-07-28)** |
| `C-32` | C (P2) → **fixed** | **`deliveryPrompt(entry)`가 검증된 frozen `refs` 대신 원본 entry alias를 다시 읽었고, 최종 result도 포인터 객체를 재사용했다.** genuine kernel clone 계약에서는 exploit이 증명되지 않았다(리뷰도 C로 분류) | 낮음 | 전달 프롬프트 1건의 내용 | 낮음 | 소 | (닫힘 — bounded defense-in-depth로 정리) | 3차 리비전 세션 | `stableController.runTask`가 inbox 항목을 **읽는 즉시** `frozenClone`으로 봉인하고 그 사본만 검증·전달에 쓴다 · 최종 포인터는 kernel 트랜잭션 반환값이다 · focused "[M5b] C: inbox 항목은 **한 번만 읽고** 그 사본으로 전달한다(교대 getter 무효)" | **fixed (2026-07-28)** |
| `C-31` | C (P3) → **부분 fixed · 축소 재기술** | 2차 리비전이 등록한 "controller 테스트가 provider 내부 2곳(`sessions` map · `spawnFn`)을 white-box 관측" 중 **두 곳 모두 제거됐다**: `spawnFn`은 A1 수정으로 `#private`이 되어 애초에 도달 불가이고, 세션 종료 관측은 **공개 API 프로브**(`sessionClosed` — 같은 id `start`가 `codex_session_exists`인지 `codex_prompt_invalid`인지)로 바꿨다. **남은 절충은 다른 것**: 그 프로브는 "세션이 map에서 지워졌다"를 간접 관측할 뿐 **provider가 자식 프로세스를 실제로 회수했는지는 보지 않는다** | 낮~중 | 테스트 관측력 1건(production 동작 무관) | 낮음 | 소(`B-13`이 stop 결과를 관측 가능한 형태로 내놓으면 함께 해소) | **`B-13`(durable 완료 전 provider 정리 확인) 구현 시** | M5c 구현 세션 | 3차 리비전 세션 · `stableController.test.ts` `sessionClosed` · `B-13` 인접 | open (축소됨) |
| `C-33` | C (P3) | **`KERNEL_MARKERS`는 손으로 유지하는 닫힌 목록이다.** kernel이 새 코드를 도입하면 controller는 그것을 자동으로 올리지 않고 `kernel_rejected`로 접는다(fail closed로 의도한 동작이지만 **진단 정보가 조용히 줄어든다**). 목록과 kernel 코드 집합을 묶는 컴파일 타임·테스트 타임 검사는 없다 | 중간(kernel에 코드를 추가할 때마다) | M5c 분기의 진단 해상도(정확성·durable 무결성 무관 — 성공 marker는 어떤 경우에도 불가능하다) | 낮~중 — M5c가 marker로 분기하기 시작하면 "왜 `kernel_rejected`인가"를 다시 파야 한다 | 소~중(kernel 코드 상수화 + 목록 대조 테스트) | **M5c가 outcome marker로 실제 분기 로직을 만들 때** | M5c 구현 세션 | 3차 리비전 세션 · `stableController.ts` `KERNEL_MARKERS`/`atKernel` · focused "[M5b] A2: 호출자 kernel(SoR)이 던진 임의 코드는 닫힌 taxonomy로만 나온다" | open |
| `C-34` | C (P3) | **`codeOf`의 provenance 검사 하나만 느슨하게 해도 실패하는 테스트가 "kernel 반환값 getter" 1경로뿐이다**(mutation 실측). 나머지 경로는 `atBoundary`/`atKernel`/`atTrusted` 래퍼가 **이미 owned 오류로 접어서** 올려보내므로 `codeOf`는 그 지점에서 **중복 방어**다. 정직한 한계 표기이며 방어를 지우지 않는다 | 확실(설계상) | 없음(현재) | 낮음 — 미래에 래퍼를 빠뜨린 경로가 생기면 그때 유일한 방어가 된다 | 소(래퍼 누락을 잡는 정적 검사) | **새 kernel/provider seam을 controller에 배선할 때** | M5c 구현 세션 | 3차 리비전 세션 mutation 실측(§10 M5b 3차 리비전 "mutation 비공허성") | open |

##### M5b 4차 리비전 신규·갱신 유예 (2026-07-28)

> **3차 리비전도 A를 전부 닫지 못했다.** 4차 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가
> `409dee2..d554a46`에 대해 **REVISE · A/P1 4건 · B 7 · C 5**를 냈고, 3차 A1~A3를 **PARTIAL**로 판정했다
> (A1: 증명은 닫혔지만 controller/provider 설정·예산 상태가 여전히 writable · A2: 오류 provenance는 닫혔지만
> **구조적 kernel이 durable commit 없이 성공을 발급** · A3: 논리 트랜잭션은 닫혔지만 **물리 발행이 비원자적**).
> 네 번째 A는 **caller-owned artifact getter 재읽기**(A4)다. **넷 다 이번 리비전(`b64974a`)에서 닫았다**
> (아래 §10 M5b 4차 리비전). 3차 절의 "A 3건 전부 fixed" 서술은 **부분적으로만 사실**이었고 dated history로
> 보존한다 — 현행 판정은 이 절이다. **여전히 self-approved가 아니다.**
>
> **B 7건은 4차 리뷰 원문 그대로 유지한다**(이번 A 작업과 겹쳐 실제로 닫힌 것은 없다):
> `B-7`(live 인증·secret redaction — 첫 live 실행 전 · 사용자+M5c) · `B-9`(live JSONL 필드 확인 — 첫 live
> 실행 전 · 사용자+M5c) · `B-10`(타입 있는 edit 실행 집행 — Claude/edit 가능 provider 활성화 전 · M5c+사용자
> 승인 형식 결정) · `B-11`(per-task preflight 전에 batch 전체가 running — 무인 autopilot/advance 전 · M5c) ·
> `B-12`(재시작·resume 후 토큰·경과 회계 — 첫 자동 restart/resume 전, 늦어도 M5c · M5c) ·
> `B-13`(provider 정리 확인 뒤 durable 완료 — live runner 또는 두 번째 process-backed provider 전 · M5c) ·
> `C-12→B`(미수령 전달의 재전송 불가 — M5c autopilot 전 · M5c). 각 행의 심각도·확률·영향 반경·유예 비용·
> 공수·증거는 위 `B-7`/`B-9` 본표와 "M5b 1차 리비전" 표의 해당 행에 그대로 있다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-35` | C (P2) | **`ReviewSubject`는 스냅샷 안전하지만 완전히 closed·taxonomy-safe는 아니다**(4차 리뷰 C-1). 여분·cyclic·깊은 key는 조용히 무시되고, `revision`/`hash` **getter가 던지면** 그 오류가 입양(`reviewer_subject_invalid`) **전에** 새어나간다. 유효 값은 한 번 읽고 freeze해 alias 없이 반환한다 | 낮음 — 호출자가 controller 코드일 때만 | review 호출 1건 | 낮음 — durable reviewer 배선 전이면 되돌리기 쉽다 | 소(closed key 검사 + 읽기 try) | **`C-19`/durable reviewer integration 착수 전(M5c)** | M5c 구현 세션 | 4차 독립 리뷰 C-1 · `reviewer.ts:167`/`:228` · `reviewer.test.ts:265` | open |
| `C-5` | C (P2) — **갱신(4차 리뷰 C-2)** | **경로 기반 artifact 신원 TOCTOU.** `lstat`/`realpath`/`readFile`가 별개 syscall이라 그 사이의 교체를 0으로 만들 수 없다(Node 18에 descriptor 상대 접근이 없다) | 낮음 | artifact hash 판정 1건 | 낮음 | 중 — 런타임 지원에 의존 | **descriptor 상대 접근이 가능한 Node 런타임 또는 M10 하드닝** | 미배정 | 4차 독립 리뷰 C-2 · `orchestrationStore.ts:108` `verifyArtifactFile` | open |
| `C-17` | C (P2) — **갱신(4차 리뷰 C-3)** | **kernel 만료 비교가 `>`라서 `expiresAt`과 **정확히 같은** 시각에 상태 변경 1건이 통과한다**(controller·실행 경계는 `>=`). 경계 하나의 불일치다 | 낮음 | 상태 전이 1건 | 낮음 | 소 | **M5c 장시간 autopilot/재승인 도입 전** | M5c 구현 세션 | 4차 독립 리뷰 C-3 · `orchestrationKernel.ts` `assertNotExpired`(`>`) vs controller `>=` | open |
| `C-29` | C (P3) — **갱신(4차 리뷰 C-4)** | **중첩 handoff schema가 closed가 아니다.** `spec`·`outputs[]`의 여분 key가 복사·freeze를 지나 살아남는다(현재 읽는 소비자는 없다) | 낮음 | 미래 handoff 1건의 오타·필드 모호성 | 낮음 | 소~중 | **`B-10`이 구조화된 edit 요청을 도입할 때** | M5c 구현 세션 | 4차 독립 리뷰 C-4 · `stableController.ts` `sealHandoff` | open |
| `C-19` | C (P2) — **갱신(4차 리뷰 C-5)** | **live `--output-schema` 결과를 그 schema로 검증하지 않는다** | live 사용 시 중간 | 구조화 결과 1건 | 낮음 | 소~중 | **reviewer 출력을 kernel state로 옮기기 시작할 때(M5c)** | M5c 구현 세션 | 4차 독립 리뷰 C-5 · roadmap:1600 · `codexStreamParser` `lastMessage` | open |
| `C-36` | C (P3) | **store에 테스트 전용 fault seam이 있다**(`setCommitFaultHook` — A3 복구 규칙을 발행 경계 10곳에서 실제로 검증하기 위한 것). production 호출부는 없고 kernel·provider 권위에 연결되지 않으며 기본값 `null`이라 성공 경로에 영향이 없지만, **export된 가변 전역**이라는 절충은 남는다 | 확실(설계상) | 없음(현재) — 잘못 쓰면 그 프로세스의 커밋만 실패한다 | 낮음 | 소(런타임 가드나 별도 test-only 진입점) | **store 발행 경로를 다시 여는 다음 승인 범위(M5c/M10 하드닝)** | M5c 구현 세션 | 4차 리비전 세션 · `orchestrationStore.ts` `COMMIT_STAGES`/`setCommitFaultHook` · focused "[M5b] A3: 발행 경계마다 fault를…" | open |
| `C-37` | C (P3) | **journal roll-forward는 "미승인 커밋을 완료로 만든다".** event append가 **완전히** 끝난 뒤 실패하면 호출자는 실패를 받지만 다음 열기가 그 커밋을 완료시킨다(append-only 감사 이력에 이미 남은 커밋을 버리지 않는 선택). 결과는 항상 일관되고 전진 가능하지만, **호출자가 본 실패와 durable 진실이 갈릴 수 있다** — M5c가 outcome marker로 분기할 때 "실패했지만 완료됐다"를 다룰 수 있어야 한다 | 낮~중(디스크 I/O 실패 시) | run 1건의 완료 1건에 대한 호출자 인식 | 중 — M5c가 재시도 로직을 짤 때 이 규칙을 알아야 한다 | 중(호출자에게 "복구 여부 재조회" API를 주거나 커밋 id를 반환) | **M5c가 outcome marker로 재시도·pause를 분기할 때** | M5c 구현 세션 | 4차 리비전 세션 · `orchestrationStore.recoverPendingCommit` 규칙 2 · focused "[M5b] A3: 발행 경계마다…"의 `after` 케이스 | open |

##### M5b 5차 리비전 신규·갱신 유예 (2026-07-28)

> **4차 리비전도 A를 전부 닫지 못했다.** 5차 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가
> `409dee2..35de547`에 대해 **REVISE · A/P1 4건 · B 7 · C 9**를 냈다: **A1 PARTIAL**(임의 executable/git
> 권위가 read-only provider로 증명 — `/bin/echo`·`/bin/true` 실측 통과) · **A3 OPEN 3건**(pre-journal 최종
> body · foreign event suffix truncate · 열린 journal schema) · **A2 CLOSED** · **A4 PARTIAL**.
> **넷 다 5차 리비전(`e477235`)에서 닫았다**(§10 M5 → M5b 5차 리비전). 4차 절의 "넷을 닫았다" 서술은
> **부분적으로만 사실**이었고 dated history로 보존한다 — 현행 판정은 이 절이다. **여전히 self-approved가 아니다.**
>
> **B 7건은 5차 리뷰 원문 그대로 유지한다**(이번 A 작업과 겹쳐 실제로 닫힌 것은 **하나도 없다**):
> `B-7`(live 인증·secret redaction — **첫 live 실행 전** · 사용자+M5c) · `B-9`(live JSONL 필드 확인 —
> **첫 live 실행 전** · 사용자+M5c) · `B-10`(타입 있는 edit 실행 집행 — **Claude/edit 가능 provider 활성화
> 전** · M5c+사용자) · `B-11`(per-task preflight 전에 batch 전체가 running — **무인 autopilot/advance 전** ·
> M5c) · `B-12`(재시작·resume 후 토큰·경과 회계 — **첫 자동 restart/resume 전, 늦어도 M5c** · M5c) ·
> `B-13`(provider 정리 확인 뒤 durable 완료 — **live runner 또는 두 번째 process-backed provider 전** · M5c) ·
> `C-12`→B(미수령 전달의 재전송 불가 — **M5c autopilot 전** · M5c). 각 행의 심각도·확률·영향 반경·유예
> 비용·공수·증거는 `B-7`/`B-9` 본표와 "M5b 1차 리비전" 표의 해당 행에 그대로 있다.
>
> **C 9건**: 기존 `C-35` · `C-5` · `C-17` · `C-29` · `C-19` · `C-36` · `C-37` · `C-30`은 **사실·기한 그대로
> 유지**하고(이번 리비전이 손대지 않았다 — fixed로 주장하지 않는다), 리뷰가 "신규/기존 ID 없음"으로 낸
> **caller getter artifact taxonomy** 항목을 아래 **`C-38`** 로 등록한다. **C만으로 추가 리비전 루프를
> 돌리지 않는다.**
>
> **`C-36`/`C-37` 재분류 안 함(직접 증거 없음).** 이번 리비전이 store 발행 경로를 다시 열었으므로 두 항목의
> 트리거("store 발행 경로를 다시 여는 다음 승인 범위" · "outcome marker 분기")를 검토했으나, `setCommitFaultHook`은
> **여전히 export된 가변 전역**이고(발행 경계가 하나 늘어 `COMMIT_STAGES`는 11개가 됐다) roll-forward도
> **여전히 호출자가 받은 실패를 다음 열기가 완료로 만든다**(규칙 2 유지 · body 발행이 그 앞에 붙었을 뿐).
> 둘 다 **상태·기한 변경 없이 open**이다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-38` | C (P3) | **호출자 getter가 artifact 거부 taxonomy를 고를 수 있다**(5차 리뷰 C-8 — 기존 ID 없음). `readClosedOnce`가 caller가 던진 `OrchestrationError`를 그대로 다시 던지므로, `path`/`role` getter가 `new OrchestrationError("artifact_missing", …)`처럼 kernel 코드를 흉내 내면 **거부 1건의 코드**를 호출자가 고를 수 있다. controller는 경계 밖 코드를 닫힌 집합(`KERNEL_MARKERS`) 밖이면 `kernel_rejected`로 접고 **무효 state는 어떤 경로로도 durable에 남지 않으므로** 성공 marker·상태 오염은 불가능하다 | 낮음 — 호출자가 controller 코드일 때만 | kernel API 거부 1건의 진단 코드(정확성·durable 무결성 무관) | 낮음 | 소(입양 경로에서 caller 오류를 `invalid_artifact_ref`로 접기) | **M5c가 caller-owned 값에서 온 kernel 오류로 직접 분기하기 전** | M5c 구현 세션 | 5차 독립 리뷰 C-8 · `orchestrationKernel.ts` `readClosedOnce`(caller `OrchestrationError` 재throw) · emitted `dist/exec/orchestrationKernel.js` 동일 · 인접: `C-33`(`KERNEL_MARKERS` 수동 목록) | open |

##### **M7 진행 판정 — T1~T8 완료(live 1회 포함)** (2026-08-12 · 이 절이 M7의 현행이며 아래 M6 절보다 최신이다)

**offline 전부 + live 검색·benchmark 1회를 실행했다.** 아래 표의 "증명"은 어디서 증명됐는지를 가리키고,
남은 한계는 같은 무게로 적는다.

| M7 완료 조건 | 증명 | 상태 |
|---|---|---|
| idea validation · 최신 web research | acceptance **Test 19** ①(mock) + **live 1회**(2026-08-12 `scripts/m7-live-benchmark.mjs`) — 실제 모델이 `RESEARCH_REQUEST` 2건을 선언 → Tavily 2회 호출 → `EvidenceItem` **10건**(원문 11,740 bytes) → 래핑 digest 주입 → 최종 문서 | **증명(live)** |
| `EvidenceItem` · 외부 원문과 모델 요약 분리 | Test 19 ① + focused — 원문은 content-addressed 파일에만 있고 중앙·digest는 포인터(`source`/`sha256`/`retrievedAt`/`bytes`) + **상한 절삭 발췌**만 운반한다. 발췌 제거 mutation → acceptance red | **증명** |
| injection 방어 | Test 19 ③ — 적대적 fixture 3종(직접 명령·역할 탈취·경계 위조)이 데이터 블록 **안**에 갇히고 경계 마커 위조가 무력화된다. 래핑 제거 mutation → red | **부분 증명** — 래핑은 완화이지 "모델이 따르지 않음"의 증명이 아니다(offline에서 만들 수 없다) |
| cache · 상한 | Test 19 ② — 같은 query 재호출이 backend를 다시 부르지 않고, 도메인 allowlist(`null`=전부 거부)·호출 수·문서당 선언 수·URL 수·원문 byte가 fail-closed | **증명** |
| 도구 예산 상한 | Test 19 ⑤ — `MAX_MCP_SERVERS_PER_PROFILE=3` · `MAX_EXPOSED_TOOLS_PER_PROFILE=16`을 코드 상수로 두고 초과 등록은 profile 로드 자체가 거부. 값의 근거는 **우리 registry 실측**(2026-08-12 최대 1서버/5도구) | **증명(개수 단위)** — 도구 1개의 **토큰** 비용은 upstream inputSchema 소유라 **미측정** |
| `C-67` 승인 설정 정적 감사 | Test 19 ④ + focused 7건 — `src/exec/manifestAudit.ts`의 read-only 판정 5규칙 + 심각도. 깨끗한 승인은 finding 0(공허한 체크 아님). 각 규칙 제거 mutation 5건 → red | **증명 · `C-67` fixed** |
| research→PM→CEO 조언 · 최종 사람 gate | Test 19 ⑥ + kernel focused — agent 요청 union에 `request_decision`(요청)은 있고 **답을 만드는 갈래는 없다**. 답 없는 `decision_request`를 남긴 task는 `completeTaskWithArtifacts`/`submitResult`가 `decision_pending`으로 거부(`blocker`는 허용 — 차단은 진행이 아니다). gate 제거 mutation 2건 → red | **증명** |
| tool 없는 baseline 대비 benchmark | **live 1회 실측**(아래 §T7 결과) — 같은 아이디어·**같은 인용 지시**로 baseline(도구 차단) 1회 vs research 2단계 1회 | **증명(live 1회)** — 표본 1건이라 일반화하지 않는다 |

###### T7 live 결과 (2026-08-12 · 1회 · 표본 1건)

| | 인용 URL | **검증 가능**(우리가 가져와 해싱한 원문에 대응) |
|---|---|---|
| baseline (도구 차단 — `--tools "" --permission-mode plan --strict-mcp-config`) | 5건 | **0건** |
| research (선언→Tavily→EvidenceItem→래핑 digest→2차) | 6건 | **6건** |

**과장하지 않는다**: baseline이 인용한 5건은 **환각이 아니다** — `github.com/anthropics/claude-code`,
`cursor.com` 같은 실재하는 유명 프로젝트 주소였다. 차이는 사실 여부가 아니라 **검증 가능성**이다:
baseline 쪽은 하네스가 가진 바이트가 없어 나중에 "그 문서가 정말 그렇게 말했나"를 되짚을 수 없고,
research 쪽은 6건 전부 `source`+`sha256`+`retrievedAt`이 남은 원문 파일을 가리킨다.

**비용 실측**: Tavily 무료 크레딧 **6** 소모(probe 2 + 벤치 2회분 4 · basic search 1크레딧/회) = **$0**.
LLM은 Claude Code 구독 경로(`claude -p`) 3회 왕복 × 2런 · 보고된 usage output 합계 7,713 토큰
(input은 CLI가 2로 보고했다 — 그대로 적는다. 이 수치의 의미는 검증하지 않았다).
**표본 1건이므로 "research가 항상 낫다"고 말하지 않는다.**

**실측**: `test:exec` **542/542** · `test:core` **423/423** · `scripts/acceptance.sh` **PASS=137 / FAIL=0**
(M6의 124 + M7 13) · `npx tsc --noEmit` clean · **live 실행 0회 · 검색 API 호출 0회 · 과금 0원**.

**acceptance가 실제로 잡은 것 1건**(공허한 체크가 아니었다는 증거): gateway가 원문을 그대로 요약 필드로
넘겨 **짧은 문서에서는 "축약"이 곧 원문**이었다 — Test 19 ①의 FAIL로 발견해 `MAX_EXCERPT_CHARS=400`
발췌로 고쳤다. 하네스는 offline에서 모델 요약을 만들지 않으므로 이름도 요약이 아니라 **발췌**로 적는다.

**M7에서 닫은 대장 항목**: `C-67`(fixed).
**부수 판정**(`M7_KICKOFF.md` §2의 미확정 항목): `profiles.ts`의 `PermissionMode` 3등급은 **누락이 아니라
표현 불가**다 — 값이 곧 `claude --permission-mode` 플래그로 나가므로(`permissionModeFlag`) `forbidden`은
플래그 값이 아니라 **profile 미등록(도구 부재)** 로 표현된다. 타입에 넣지 않는다.

**M7이 하지 않은 것**: 다중 backend · 자동 재검색 루프 · 벡터 검색 · 요약 모델 라우팅(§7 위험 1의 범위 폭발
금지 그대로) · §6.5의 M9/M10 배치 항목.

##### **M6 완료 판정** (2026-08-12 — offline 전부 · live 0회 · 이 절이 M6의 최종 판정이며 위 M5 절보다 최신이다)

**M6는 완료다.** §10 M6 완료 조건을 항목별로 어디서 증명했는지 적는다 — **증명하지 못한 것도 같은 무게로** 적는다.

| M6 완료 조건 | 증명 | 상태 |
|---|---|---|
| parent→child→parent 전달 | acceptance **Test 18** ①② — 계획의 `spawn_child` 요청이 **autopilot 경유로** kernel `requestSpawn`을 지나 child를 만들고, child `result`가 `routeToTaskId=parent`로 parent inbox에 durable하게 남고, child 완료 뒤 parent가 같은 실행에서 완주 | **증명** |
| child→orchestrator→sibling 전달 | Test 18 ③ — `deliver_status` 요청이 `submitStatusUpdate`를 지나 **중앙이 route를 정해** sibling inbox에 도착(발신 recipient는 `orchestrator`) | **증명** |
| child가 직접 spawn/state 변경 불가 | Test 18 ④⑤ — 요청 union이 `spawn_child`·`deliver_status` **둘뿐**이고 상태·권능·경로·예산 필드가 **없다**(schema 정본 대조) · registry 밖 role과 관계 없는 수신자는 kernel이 거부하고 **durable 흔적 0** · 거부 turn은 `paused`로 착지 | **증명** |
| Coordinator 교체 전후 task graph·결정·artifact hash 동일 | Test 18 ⑦ — `snapshotDigest()` 3종을 기록 → kernel 인스턴스 폐기 → **다른 clock으로** 재기동 → 재계산 **일치**. 추가로 교체 후 완주한 run이 **무교체 대조 run과 같은 graph·artifact 다이제스트**에 도달 | **증명** |
| context bundle | Test 18 ⑥ + focused 18건 — `buildContextBundle`은 **durable state만** 입력이고 같은 revision에서 byte-identical, 시각·예산 미포함, state 무변경 | **증명** |
| reviewer·worker·coordinator fresh-session 강제 | focused — `commitPreflightBatch`가 **직전 attempt와 같은 `attemptId`를 거부**(`attempt_id_reused`) · 교체된 coordinator가 이전 프로세스의 진행 채널을 이어받지 못함(`invalid_progress_channel`) | **증명(범위 한정 — 아래 참조)** |
| **`decisionHash`의 run 사이 동일성** | `messageId`가 난수 durable 신원이라 **서로 다른 두 run은 반드시 다르다**. 교체 전후(같은 run)만 동일하며, 교체 run vs 대조 run은 **신원을 뺀 결정 내용**을 비교했다 | **주장하지 않음(의도적)** |
| **context bundle의 프롬프트 주입** | offline plan worker에 **프롬프트 채널 자체가 없다** → 주입 지점이 존재하지 않는다. bundle은 kernel 읽기 전용 접근자로만 소비된다 | **미증명 — live/프롬프트 backend 슬라이스 범위** |
| **attempt 신원 재사용 차단의 완전성** | 막는 것은 **직전 attempt** 한 칸까지다. 두 attempt 이전 값의 재사용은 durable state가 과거 attemptId를 보관하지 않아 막지 못한다. **효과 경로는 durable `chargedTurnIds`가 이미 닫는다**(잔여는 감사 추적성) → 대장 `C-68` | **부분 — 잔여 등록** |
| **inbox 소비(전달 ack)** | autopilot은 여전히 전달을 ack하지 않는다(`B-17` 미소비) → ①이 증명하는 것은 **route가 durable하게 남는 것**까지이고, 수신 task가 그것을 읽어 행동을 바꾸는 것은 아니다 | **미증명 — `B-17` 범위** |
| **live 실행** | M6는 offline+mock으로 ①②③을 증명할 수 있어 **live 계획을 두지 않았다**(무과금) | **해당 없음(의도적)** |
| **실제 LLM이 spawn을 요청하는 경로** | worker는 사람이 authoring한 offline 계획을 읽는 in-memory 어댑터다 → 증명한 것은 **계약의 모양**이다 | **미증명 — live 슬라이스 범위** |

**mutation 실측**(acceptance를 만들면 red를 확인한다 — M5에서 공허한 체크로 A급을 세 번 맞고 얻은 절차):

| 제거·위조한 것 | Test 18 red |
|---|---|
| autopilot의 spawn 배선 호출 | 5건 |
| 전달 배선 | 5건 |
| child `result` → parent inbox route | 4건 |
| spawn turn의 `result.outputs` 게이트 | 2건 |
| 다이제스트에 시각 필드 주입 | 2건 |
| bundle의 child artifact 포인터 | 1건 |
| registry role 게이트(**2중 — `addTask` + 적재 검증 둘 다** 제거해야 red) | 4건 |

**절차에서 실제로 잡아 고친 것**(이 두 건은 처음 판이 green이었다):
- ③의 "교체 전후 동일" 체크는 재개해도 durable `updatedAt`이 같아 **시각이 섞여도 green으로 남았다** →
  시각 필드만 바꾼 state 사본으로 다이제스트가 움직이지 않는지 보는 체크를 **추가**해 red를 확인했다.
- context bundle이 **child의 artifact 포인터를 빠뜨리고 있었다**(위임한 parent가 다음 attempt에서 통합할
  산출물을 못 본다) → acceptance ⑥의 FAIL로 발견해 고쳤다.

**최종 실측**: `test:exec` **531/531** · `test:core` **409/409** · `scripts/acceptance.sh` **PASS=124 / FAIL=0**
(M5의 108 + M6 16) · `npx tsc --noEmit` clean · **live 실행 0회 · 프로세스 spawn 0회**(Test 18 한정).

**M6에서 닫은 대장 항목**: `B-19` · `C-44`.
**M6에서 새로 등록한 것**: `C-67`(승인 설정 정적 감사 — 외부 팩 조사에서 발상만 채택) · `C-68`(attempt 신원
재사용 차단 범위). **열린 A는 0건.**

**M6 범위 밖으로 유예한 것**(조용히 버리지 않는다): `B-11`·`B-12`·`B-13`·`B-16`(신규 발행)·`B-17`·`B-18`·
`B-20`·`B-27`(절차)·`C-15`(run별 registry — 트리거 미발화). M6 스펙 ①②③과 무관하므로 배송 우선 방침대로 보류.

**`B-27` 절차 체크**: 이 마일스톤에서 승인 manifest 문서에 **wrapper 경로를 넣지 않았다** — Test 18의
`executionAuthority`는 고정 fixture 경로이고 typed operation을 하나도 집행하지 않는다(프로세스 spawn 0회).

##### **M5 완료 판정** (2026-08-11 — offline 전부 + live 1회 · 이 절이 M5의 최종 판정이다)

**M5는 완료다.** 로드맵 §10의 M5 완료 조건을 항목별로 어디서 증명했는지 적는다 — 증명하지 못한 항목도
같은 무게로 적는다.

| M5 완료 조건 | 증명 | 상태 |
|---|---|---|
| fixture repo에서 plan → implement → … 가 **수동 복사 0회 · 승인 1회**로 | acceptance **Test 16**(33건) — 승인 manifest 1건으로 gate된 run이 fixture repo의 **실제 파일을 고쳐** DAG 완주 | **증명** |
| non-interactive 승인 불가 작업이 **hang 없이 paused**로 복구 가능 | Test 16 ⑤ · autopilot focused 테스트 | **증명** |
| 진행 이벤트 스트리밍 관측 | Test 16 ④(이벤트 + durable `progressCount`) | **증명** |
| deadline·cancellation 시 **descendant까지 정리 · 잔존 프로세스 0** | acceptance **Test 17**(15건) — 실제 spawn · SIGTERM 견디는 손자 · SIGKILL 경로 · reparent 유출까지 확인 | **증명** |
| 전역 상태 관찰 작업 **동시 실행 0** | Test 16 ⑨(배타 resource class) | **증명** |
| `CodexCliProvider` live | 2026-08-11 **첫 live 실행 1회 성공**(input 13,049 / output 5 · 이벤트 4종이 파서 계약과 일치) | **증명(1회)** |
| **test → fresh review → verify의 *실행*** | `run_process` action enum이 `validate-plan` 하나(읽기 전용)라 **표현할 수 없다** | **미증명 — M6+ 범위** |
| **신규 파일 발행** | `B-16` **부분 개방**(승인된 기존 파일 교체만) · 신규 생성은 fail closed | **미증명 — 의도적 잔여** |
| Claude worker ↔ Codex planner/reviewer **자동 전달** | autopilot은 inbox 전달을 하지 않는다(`B-17` 미소비). 라우팅 계약 자체는 M4c가 덮는다 | **미증명 — M6 범위** |

**최종 실측**: `test:exec` **514/514** · `test:core` **402/402** · `scripts/acceptance.sh` **PASS=108 / FAIL=0**
· live 실행 **1회**(과금 있음 — probe는 acceptance에 등록하지 않는다).

**M5에서 닫은 대장 항목**: `B-7ⓐ`·`B-7ⓑ`·`B-9`·`B-10`(소비면)·`B-16`(부분)·`B-21`·`B-22`·`B-23`·`B-24`·
`B-25`·`B-26`·`C-1`·`C-55`. **열린 A는 0건.**
**M5에서 새로 등록한 것**: `B-27`(wrapper 승인 함정) · `C-59`~`C-66`.
**M6에서 새로 등록한 것**: `C-67`(승인 설정 정적 감사 — 외부 팩 조사에서 발상만 채택) · `C-68`(attempt 신원 재사용 차단 범위).

**M5가 아닌 것(다음 마일스톤으로 넘긴다)**: 위 표의 미증명 3항목 · live 반복 실행 · stress · build/dist
갱신 이후의 배포 검증. **M6는 이 위에서 시작한다.**

##### **첫 live 실행 성공** — `B-23` 마감 · `B-9` live 재확인 (2026-08-11 · 이 절이 현행이다)

> 사용자가 `CODEX_HOME=~/harness-codex-home codex login`(codex-cli `0.146.0-alpha.3`)을 1회 실행했고,
> `scripts/m5-live-probe.mjs`로 **실제 Codex 추론 1회**를 돌렸다. **이 레포 최초의 live 실행이다.**

**실측 usage**: `input 13,049 · output 5 · cacheRead 9,984 · cacheWrite 0`.
**관측 이벤트**: `init` → `status(turn_started)` → `assistant` → `result`. 파서 계약과 일치 →
**`B-9`(JSONL 필드명 live 확인)는 live 경로로 재확인됐다.**

- **`B-23` → fixed**: `codex login` 산출물은 `auth.json` 하나가 아니었다(`log/`·`log/codex-login.log`·
  `tmp/`·`tmp/arg0`). 허용 목록을 **최상위 이름 2개(`log`·`tmp`)만** 넓혔고 `config.toml`·`AGENTS.md`·
  MCP 정의는 여전히 거부된다. 실측 구조로 첫 invocation이 통과하는 것을 live로 확인했다.
- **A급 발견 — `which codex`를 승인하면 trust root가 비어 있다**: `codex`는 **Node wrapper**
  (`@openai/codex/bin/codex.js`, 7KB)이고 런타임에 `require.resolve`로 native 바이너리
  (`codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, **267MB**)를 찾아 spawn한다.
  wrapper digest를 승인하면 **실제 추론 바이너리가 고정되지 않는다** — 이 레포가 여러 리비전에 걸쳐
  닫은 "승인된 실행 파일이 유일한 trust root" 계약에 그대로 구멍이 난다.
  → **승인 대상은 native 바이너리다**(`5ab45f8f9819c120…`). live probe가 native 직접 실행으로 성공해
  wrapper가 기능적으로 불필요함도 함께 확인했다(wrapper가 더하는 env 2개는 업데이트 안내용이다).
- probe 스크립트는 **과금이 있으므로 `acceptance.sh`에 등록하지 않는다**(수동 실행 전용).

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-27` | B (P1) | **승인 문서 작성자가 wrapper 경로를 승인하면 실행 권위가 무력화된다.** `which codex`가 가리키는 것은 Node wrapper이고 실제 추론 바이너리는 런타임 해석된다 → wrapper digest는 아무것도 고정하지 않는다. 지금은 **사람이 올바른 경로를 넣어야만** 성립하는 규율이고 런타임 가드가 없다(harness는 승인된 경로를 그대로 믿는다 — 그것이 설계다). 최소한 승인 문서 생성 절차·문서에 못박아야 하고, 가능하면 "승인된 실행 파일이 다른 실행 파일을 spawn하는 wrapper인지"를 사람 검토 항목으로 남겨야 한다 | 중 — 다른 사람이 manifest를 쓰면 | live 실행 전부의 trust root | 높음 — 무력화된 채로 돌면 승인 계약이 서류상으로만 존재한다 | 소(문서·절차) ~ 중(런타임 휴리스틱) | **다음 live manifest를 사람이 작성하기 전** | live 운영 slice | 2026-08-11 live probe 준비 중 실측 · `@openai/codex/bin/codex.js` `findCodexExecutable`/`spawn` | open |
| `C-66` | C (P3) | **승인된 codex 바이너리가 267MB라 spawn 직전 digest 재검증 비용이 크다.** 계약상 매 spawn 직전 전체 내용 해싱이 필요하다(같은 inode 제자리 덮어쓰기까지 잡기 위한 설계). 측정은 하지 않았으나 수백 MB 해싱은 무시할 수 없다 — live 반복 실행 전에 실측하고, 필요하면 캐시가 아니라 **계약을 유지하는 방식**으로 개선안을 찾아야 한다(캐시는 그 자체가 우회로다) | 확실 | 매 spawn 지연 | 낮음 | 중 | live 반복 실행 착수 전 | live 운영 slice | 2026-08-11 live probe · 바이너리 267,867,408 bytes | open |
| `C-67` | C (P3) | **승인 설정 자체를 정적 감사하는 수단이 없다.** kernel은 *실행 시점*에 승인 manifest를 집행하지만, **manifest·`writableRoots`·`operationAuthorityByTask`·`executionAuthority`가 서로 모순되거나 지나치게 넓은지**를 실행 전에 읽어 보고하는 경로가 없다(예: `writableRoots`가 repo 루트를 통째로 덮음 · 어떤 task도 쓰지 않는 권능이 승인돼 있음 · 만료가 과도하게 김 · digest가 가리키는 파일이 이미 부재). 외부 도구(ECC AgentShield류)는 `.claude` 설정을 감사하지 그 대상이 **우리 승인 manifest가 아니다** — 그대로 붙일 수 없고, 붙인다 해도 kernel 계약을 모른다. 그래서 **가져올 것은 도구가 아니라 발상**이다: read-only 정적 감사 + 심각도 있는 보고 | 낮음(지금은 승인 문서가 손으로 쓰여 작다) | 과도하게 넓은 승인이 조용히 통과 | 낮음~중 — 승인 범위가 커진 뒤 발견하면 되짚기 어렵다 | 중(순수 판정 함수 + 보고 · 새 의존성 0) | **MCP/커넥터나 외부 provider 권능을 승인 manifest에 추가하는 마일스톤 착수 전**(현재 M7 예상) | 미정 | 2026-08-12 외부 하네스 팩(ECC/gstack/oh-my-claudecode) 조사 — 셋 다 durable 승인 계층이 없어 그대로 도입 불가로 판정, 감사 발상만 채택 | **fixed** (2026-08-12 M7 T1 — `src/exec/manifestAudit.ts` 5규칙 · mutation 5건 red · acceptance Test 19 ④) |
| `C-68` | C (P3) | **attempt 신원 재사용 차단이 “직전 attempt” 한 칸까지다(M6 T5).** `commitPreflightBatch`는 새 `prepared` attempt가 **직전 attempt와 같은 `attemptId`**를 쓰면 `attempt_id_reused`로 막지만, **두 attempt 이전의 값**을 다시 쓰는 것은 막지 못한다 — durable state가 과거 attemptId를 보관하지 않고 event log는 state 밖 파일이라 `#mutate` 안에서 볼 수 없다. **효과 경로는 이미 닫혀 있다**: 같은 turn은 durable `chargedTurnIds`가 두 번 과금하지 않고, 과금되지 않은 turn은 효과 게이트에서 `budget_turn_unaccounted`로 막힌다. 그래서 잔여는 **감사 기록에서 두 attempt가 구분되지 않는 것**이다 | 낮음(호출자가 id를 재사용해야 하고 autopilot은 매번 난수로 만든다) | 감사 추적성 | 낮음 | 소~중(kernel이 `attemptNo`에서 attemptId를 **파생**하면 구조적으로 종결 — 다만 `PreflightDecision` 계약과 모든 호출부가 바뀐다) | 없음(bounded backlog) — attempt 신원이 감사 증거로 쓰이는 마일스톤 전 | 미정 | M6 T5 구현 시 실측 · `orchestrationKernel.ts` `commitPreflightBatch` prepared 갈래 | open |

##### `B-24` 마감 — deadline·cancellation 자손 정리 end-to-end (2026-08-11 · **M5 완료 게이트 3건 전부 닫힘** · 이 절이 현행이다)

> 범위 `69cd089..3742ff6`. 구현은 **격리 worktree 병렬 slice**(파일 소유권: 신규 스크립트 1개만),
> 통합·mutation 검증·라벨 정정은 중앙이 직렬로 했다.

- **`B-24` → fixed**: `scripts/m5d-cleanup-acceptance.mjs`(acceptance.sh **Test 17**, 내부 체크 15건).
  **실제로 spawn한다** — autopilot → typed `run_process` 집행 → 승인 manifest가 digest로 고정한
  `node <controllerEntrypoint>` → **손자 프로세스**까지의 end-to-end다.
  - deadline 초과와 cancellation **양쪽**에서 손자가 실제로 죽는 것을 `process.kill(pid,0)` ESRCH
    폴링(상한 5초, 넘으면 FAIL)으로 확인한다. 손자는 `trap ... TERM`으로 **SIGTERM을 받고도 살아남으므로**
    정리는 **SIGKILL 경로까지** 밟아야 성립하고, cancel 시나리오는 `*.term` 증거 파일로 그것을 단정한다.
  - 고정 sleep 없이 **ready 파일 배리어**로 경합을 없앴다(이 레포가 과거 `trap` 설치 전 deadline 발화로
    간헐 red를 겪은 그 함정).
  - 성공 영수증 0 · 미확정 pending 0 · hang 없이 `paused` 착지 · marker `process_failed`.
- **중앙의 mutation 검증에서 과대주장 1건을 잡아 고쳤다**: `managedProcess`의 SIGKILL 승격을 제거하니
  자손 정리 체크가 red가 되는데 **③("이 프로세스의 자손이 남지 않았다")만 green으로 남았다**.
  `childPids()`가 `ppid === process.pid`인 **직계 자식**만 세는데 유출된 손자는 부모가 죽는 순간 init으로
  **reparent**되어 그 목록에서 사라지기 때문이다 → 라벨이 측정값보다 넓었다. ①②에서 **관측한 손자 pid를
  모아 직접 확인**하도록 바꿔 같은 mutation에서 ③도 red가 된다(관측=2 잔존=2).
- **증명하지 않는 것(헤더에 명시)**: fixture controller는 실제 `validate-plan` 구현이 아니다(정리 역학만
  대상) · deadline 시나리오는 spawn 시각부터 시계가 흘러 외부 배리어를 걸 수 없으므로 **"죽는다"만**
  단정하고 SIGKILL 경로 단정은 cancel 시나리오에만 둔다 · 증손자·`setsid`로 pgid를 탈출한 자손은 범위
  밖이다(supervisor의 소유 단위는 pgid 하나다) · live·네트워크·git write 0.
- **프로덕션 코드 무수정** — acceptance만으로 통과했다(= 이 계약에 숨은 제품 결함이 없었다).
- **실측**: 내부 체크 15건 FAIL=0 · `scripts/acceptance.sh` 전체 **PASS=108 / FAIL=0**.

**M5 완료 선언 전 게이트 3건(`B-24`·`B-25`·`B-26`)이 전부 닫혔다.** 남은 것은 **`B-23`(live 인증
자격증명 산출물 실측)** 하나이고 그것은 **사용자의 `codex login` 1회**가 필요하다 — 그 전까지 M5는
완료가 아니며, live 실행은 여전히 0회다.

##### M5 완료 게이트 정리 — `B-25`·`B-26` 마감 (2026-08-11 · `B-24`는 병렬 slice 진행 중 · 이 절이 현행이다)

> 범위 `d02ee77..69cd089`. M5 완료 선언 전 하드 게이트 3건 중 2건을 닫았다.

- **`B-25` → fixed**(⑨): 같은 배타 resource class를 요구하는 task 2건이 **같은 batch에 함께 들어가지
  않는다**(scheduler가 자원 점유 상태를 보고 하나만 고른다)는 것, 그럼에도 **둘 다 완주해 굶지 않는다**는
  것, 종료 시 점유 상태가 남지 않는다는 것을 autopilot loop를 통과시켜 실측한다.
- **`B-26` → fixed**(⑩): **진짜 자식 프로세스**를 띄워 durable 파일만으로 같은 run을 이어받게 한다 —
  in-memory 상태는 하나도 넘어가지 않고 자식은 **자기 실제 시계**를 쓴다. ⑦(같은 프로세스 재수화)이
  시계 단조성을 인위적으로 유지하던 한계가 여기서 사라진다.
  - 그 과정에서 **fixture 결함 1건**을 발견해 고쳤다: 합성 시계가 고정 날짜였던 탓에 자식의 실제 시계가
    durable 예산 창 밖으로 벗어나 `budget_elapsed_exhausted`가 됐다. 제품 결함이 아니라 acceptance 설계
    결함이었고, 기준을 **실제 시각**으로 바꿔 해결했다(1 tick = 1ms).
- **mutation 확인**(공허성 방지): 배타 class 선언을 지우면 ⑨가 red, 자식 spawn을 없애면 ⑩이 red.
- **실측**: M5d 내부 체크 27 → **33건**(FAIL=0) · `scripts/acceptance.sh` 전체 **PASS=101 / FAIL=0**.
- **`B-24`는 열려 있다** — 별도 격리 worktree에서 `scripts/m5d-cleanup-acceptance.mjs`(실제 spawn +
  deadline/cancellation 자손 정리)로 진행 중이다. **M5 완료 선언은 그것과 `B-23`(live) 이후다.**

##### M5d task 3·5 — offline self-hosting acceptance + 전체 suite 1회 (2026-08-11 — **적대적 리뷰 `REVISE — A=2` → A 2건 즉시 수정 후 재검증** · 이 절이 현행이다)

> 범위 `c66b88f..462e1c9`. **배송 우선(MVP-first) 방침**(사용자 2026-08-11) 아래 진행했다:
> A급·크리티컬은 즉시 수정, B/C는 대장에 기록하고 진행을 멈추지 않는다.

**Task 3 — `scripts/m5d-offline-acceptance.mjs`(acceptance.sh Test 16).** 승인 manifest **1건**으로
gate된 durable run에서 사람이 프롬프트를 **한 번도 복사하지 않고** autopilot이 fixture repo의 **실제
파일을 고쳐** task DAG를 완주시키는 것을 증명한다. 시나리오 8종 · 내부 체크 **27건**.

**적대적 리뷰가 A 2건을 잡았고 둘 다 과대주장이었다 — 즉시 수정했다**(`462e1c9`):

- **A1**: ⑦의 예산 체크가 **구조적으로 공허**했다. offline worker는 usage를 항상 0으로 신고하므로
  `tokensUsed`는 언제나 0이고, `remainingBudget <= maxTokens - tokensUsed`는 `remainingBudget`의
  **정의식 그대로라 항등식**이었다(어떤 mutation으로도 red가 되지 않는다). → ⑦을 **durable 재수화**
  증명으로 바꿨다(task 상태·산출물·집행 영수증·revision·경과 예산 deadline이 디스크에서 복원되는지).
  토큰은 `=== 0`을 **사실 그대로** 단언하고 "예산 소진 미증명"을 라벨에 박았다.
- **A2**: ⑧("생존 자손 0")은 **spawn 0회 loop**에서 직계 자식을 세는 것이라 cleanup 코드를 통째로
  지워도 red가 되지 않는다. 그런데 라벨·커밋이 무조건부로 "잔존 프로세스 0"을 증명 목록에 올렸다.
  → 라벨에 "(spawn 0회 — 자손 정리 증명 아님)" 한정어를 달고, 헤더 "증명하지 않는다" 절에 **3건을
  추가**했다(자손 정리 · 배타 resource class 동시 실행 0 · 토큰 예산 소진).
- C1(발행 hash를 실제로 대조 — mutation으로 red 확인) · C2(중복 제거)도 함께 처리했다.
- **커밋 메시지 자체에도 과대주장이 1건 있었다**("전체 acceptance PASS=102") — acceptance.sh 총계는
  99로 변동이 없고 늘어난 것은 스크립트 **내부** 체크였다. amend로 정정했다.

**리뷰가 확인한 방어(깨려다 실패한 것)**: ②③은 workspace의 **실제 바이트**를 단언하므로 write 경로·
DAG 전진 mutation에 red가 된다 · ⑥은 승인·경로·소유권이 전부 갖춰진 신규 발행이 fail closed임을 파일
부재로 단언한다 · `grep -q` 단언은 fail-closed다(미매치 → FAIL) · ⑤가 ②보다 먼저 도는 순서 공유는
오염을 오히려 먼저 검출한다.

**Task 5 — 전체 suite 직렬 1회**(예약돼 있던 그 1회): `npm test` → `test:exec` **510/510** ·
`test:core` **402/402** · `scripts/acceptance.sh` **PASS=99 / FAIL=0**. 이 수치는 `f53c967`에서 측정했고
이후 두 커밋은 `scripts/`만 건드렸다(acceptance는 HEAD에서 재실행해 green 재확인).

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-24` | B (P1) | **[fixed 2026-08-11 — acceptance Test 17]** deadline·cancellation 시 descendant 정리 acceptance가 없었다. M5 완료 조건의 명시 항목("잔존 프로세스 0")인데 M5d acceptance는 spawn 0회라 그것을 증명할 수 없고, 증명한 것처럼 읽히지 않도록 라벨을 한정했을 뿐이다. `managedProcess` 단위 테스트가 supervisor 계층은 덮지만 **autopilot→집행→자손**의 end-to-end는 미검이다 | 확실(미검) | M5 완료 판정의 정당성 | 중 — M5 done을 선언한 뒤 발견하면 판정을 되돌려야 한다 | 중(자손을 낳는 fixture + deadline 시나리오) | **M5 완료 선언 전(하드 게이트)** | live/lifecycle slice | Task 3 적대적 리뷰 A2·B2 · `m5d-cleanup-acceptance.mjs`(Test 17) | **fixed** |
| `B-25` | B (P2) | **[fixed 2026-08-11 — M5d acceptance ⑨]** 배타 resource class 동시 실행 0이 M5d acceptance에 없었다. M5 완료 조건 항목이고 M4b acceptance가 scheduler 층을 부분적으로 덮지만, autopilot loop를 통과하는 경로는 미검이다(이 run의 task들은 자원 class를 선언하지 않는다) | 중 | M5 완료 판정의 정당성 | 중 | 소~중(자원 class를 선언한 task 2건 시나리오) | **M5 완료 선언 전** | 다음 acceptance slice | Task 3 적대적 리뷰 4번 | **fixed** |
| `B-26` | B (P2) | **[fixed 2026-08-11 — M5d acceptance ⑩]** "재시작"이 같은 프로세스 안에서의 `openOrchestrationRun` 재호출이었다. 디스크 rehydrate는 실측이지만 프로세스 전역 `clockTick` 공유로 시계 단조성이 인위적으로 유지된다 → **별도 프로세스 재시작(시계 되감김 포함)** 은 미검이다 | 중 | 재시작 복구 계약 | 중 | 소(child process로 2단계 실행) | **M5 완료 선언 전** | 다음 acceptance slice | Task 3 적대적 리뷰 B1 | **fixed** |

##### M5d — **`B-16` 부분 개방**: 고정한 fd로 기존 파일 교체 발행 (2026-08-11 — **적대적 독립 리뷰 `APPROVE — A=0, B=1, C=3`** · B-1 즉시 수정 · 이 절이 현행이다)

> 범위 `b3226fc..7e5a966`. **사용자가 명시 승인한 slice**다("2번으로 진행" = `B-16`을 여는 slice를 먼저).
> 이 레포에서 **안전 반경이 가장 큰 변경**이라 리뷰를 통과가 아니라 **파괴 목적**으로 걸었다.

**무엇이 바뀌었나.** typed `write_file`이 **처음으로 실제 바이트를 낸다** — 단 **승인된 기존 파일의 교체만**이다.

- 3A 2차 리비전 A3이 교체를 닫은 이유는 "temp → 최종 pathname `rename(2)`" 형태에서 **부모 이름 교체
  경쟁**을 예방할 수 없다는 것이었다. **그 이유는 새 형태에 성립하지 않는다**: rename하지 않고,
  신원(dev+ino)과 preimage를 이미 확정해 둔 **바로 그 fd**에 `write`/`ftruncate`/`fsync`한다 →
  발행 syscall에 **pathname이 하나도 없다**. 리뷰가 코드로 확인했다(판정·멱등·conflict·교체가 전부
  같은 `targetFd` 하나를 공유하고, 쓰기 syscall은 `applyToFixedTarget` 안에만 존재한다).
- **신규 파일 발행은 계속 fail closed**다(`write_publish_unsupported` — `B-16` **잔여**): 부재 대상에는
  고정할 fd가 없어 최종 `link(2)`가 pathname을 지나야 한다. 그 창은 여전히 예방할 수 없다.
- `already_applied`의 durability 기준을 **높였다**: 내용 fsync도 요구한다(앞선 시도가 다 쓰고 fsync 전에
  죽었을 수 있다 — "다시 보니 있더라"는 durability의 증거가 아니다).
- 신규 코드 `write_apply_incomplete`(torn일 수 있음을 정직하게 말한다) · seam 2종 추가.

**교환한 것(정직 — 없앴다고 주장하지 않는다)**: **원자성을 잃었다.** 이전 계약은 "원자성을 보장할 수
없으면 거부"였고 지금은 "원자성 없이 쓰되 torn을 fail closed로 표면화"다. torn은 재시도 시 preimage
불일치(`write_conflict`)로 막히고 **자동 복구되지 않는다**(사람이 본다). 거짓 성공 영수증 경로는 없다 —
리뷰가 durable 경로를 추적해 확인했다. 같은 uid 경쟁자는 여전히 막지 못한다(선언된 threat model 그대로);
막는 것은 **바이트가 다른 파일·다른 디렉터리로 새는 일**이다. durability는 기존 fsync 전제와 같은 수준이다.

- **리뷰 B-1 — 이 세션이 저지른 과대주장, 즉시 수정**(`7e5a966`): 테스트 주석이 "autopilot 쪽 테스트가
  그 경로를 덮는다"고 적었으나 `write_apply_incomplete`도 그로 인한 `outcome_unknown` 닫힘도 **어디에도
  없었다**. 없는 커버리지를 실제로 만들었다(autopilot 경로에 seam fault 주입 → pending 0 · 영수증
  `outcome_unknown` · paused 착지 · artifact 0) 그리고 주석을 정정했다. 리뷰 C-1(낡은 사양 서술)도 함께.
- **검증**: `tsc --noEmit` 0 · `src/exec/*.test.ts` + `autopilot.test.ts` **538 pass / 0 fail**.
  테스트 **삭제·완화 0건** — "replace는 항상 fail closed" 1건을 새 계약으로 갱신하고 **11건 추가**했다
  (inode 유지 = rename 부재 증거 · 꼬리 절단 · preimage 불일치 · 부모 교체 · torn · 내용 fsync 실패 ·
  멱등 경로 fsync 실패 · 신규 발행 잔여 · autopilot 교체 성공 · autopilot 신규 발행 거부 · torn e2e).

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-63` | C (P2) | **torn 파일을 그대로 artifact로 선언하는 별도 승인 plan은 막히지 않는다.** 재시도는 `write_conflict`로 막히지만, 깨진 내용을 "의도한 산출물"이라고 선언한 승인된 plan이 오면 `completeTaskWithArtifacts`는 hash·소유권만 보므로 통과한다. 승인 게이트 뒤이므로 사람의 판단 문제다 | 낮음 | task 1건의 산출물 품질 | 낮음 | 중(내용 sanity 계약이 필요한데 그것은 승인 문서의 몫) | 없음 — `B-16` 신규 발행을 열 때 함께 재검토 | 다음 `B-16` slice | `B-16` 적대적 리뷰 3번 | open |
| `C-64` | C (P3) | **쓰기 권한 없는 대상(0444)은 멱등 판정조차 못 한다.** 대상 open이 `O_RDWR`이라 `already_applied`·`write_conflict` 판정이 open 단계에서 `write_failed`가 된다. fail closed 방향이지만 크래시 복구 멱등의 범위가 좁아졌다. `O_RDONLY` 재시도 fallback은 **경로 재오픈이라 채택하지 않았다**(그것이 이 slice의 핵심 성질을 깬다) | 낮음 | read-only 대상 | 낮음 | 중(fd 재사용을 유지하는 해법이 필요) | 없음(bounded) | — | `B-16` 적대적 리뷰 C-2 · `judgeWriteTransaction` 대상 open | open |
| `C-65` | C (P3) | **"발행 경로에 pathname이 없다"를 집행하는 테스트가 없다.** 판정 후 경로를 재오픈해 쓰는 구현도 현재 테스트를 전부 통과한다(부모 교체 seam은 재확인 단계에서 발화한다) — 그 성질의 보증은 **코드 리뷰뿐**이다. 정직하게 기록한다 | 확실(현재) | 회귀 검출 | 중 — 나중에 조용히 깨질 수 있다 | 중(경로 재오픈을 관측하는 seam 또는 syscall 추적) | 발행 경로를 다시 손대는 slice | 다음 `B-16` slice | `B-16` 적대적 리뷰 6번 | open |

##### M5d task 2·4 — `B-10` 소비면 · `C-1` 마감 (2026-08-11 — **독립 리뷰 2건 병렬 `APPROVE — A=0, B=0` · C 5건 전부 이번에 반영** · 이 절이 현행이다)

> 범위 `d7bcdc9..2b49a36`. Task 2(autopilot)와 Task 4(kernel seam)는 **파일 소유권이 겹치지 않아
> 격리 worktree에서 병렬**로 진행했고(AGENTS.md 병렬 조건 충족), 통합·최종 실측은 직렬로 했다.

**⚠️ 이 slice의 가장 중요한 발견 — typed execution은 지금 바이트를 하나도 만들 수 없다.**
게이트를 열고 실제로 배선해 보니 그 뒤에 있는 능력이 예상과 달랐다. 계획 단계에서는 몰랐고
**구현해 봐야 드러난** 사실이라 그대로 적는다:

| 경로 | 오늘의 결과 |
|---|---|
| `write_file` 신규 생성 | `write_publish_unsupported` — **`B-16`**(열지 않은 별도 게이트) |
| `write_file` 내용 교체 | `write_replace_unsupported`(3A 2차 리비전 A3에서 닫음) |
| `write_file` 성공 경로 | **크래시 창 멱등(`already_applied`) 하나뿐** |
| `run_process` action | 닫힌 enum **`validate-plan` 하나** · 읽기 전용 |

→ **Task 2가 연 것은 "집행 lifecycle"이지 "코드를 쓸 능력"이 아니다.** permit → 권위 과금 → grant →
고정 집행기 → 영수증 / 거부 / 불확실 정합화가 전부 실제로 도는 것은 증명했고 그것이 M5d의 절반이지만,
**self-hosting 루프의 implement 단계는 여전히 불가능**하다. 그러려면 `B-16`(예방 안전한 발행 primitive)을
여는 별도 승인 slice가 필요하다 — **사용자가 승인한 범위 밖이므로 이 slice는 열지 않았다.**

- **`B-10` 소비면 → 배선 완료**(`0f11a02`): 권위는 **하나도 autopilot에 없다**. 배선하며 kernel 계약 3건을
  실측으로 확인했다: ⓐ **순서가 계약이다** — 권위 과금(`chargeDispatchTurnUsage`)이 grant보다 먼저가
  아니면 `budget_turn_unaccounted`다(효과를 승인하는 것은 **과금된 생산 turn**이지 호출자의 선언이 아니다).
  ⓑ operation은 **permit이 쥔 kernel 검증 사본**에서 꺼내야 한다(호출자 객체는 `dispatch_operation_unbound`
  — 이 결박이 곧 "계획 밖 operation은 표현할 수 없다"이다). ⓒ 승인 여부는 **등록 전에** facade 순수 판정으로
  봐야 한다 — 집행기는 pending을 `attemptedAt`으로 먼저 찍은 뒤 승인을 다시 읽으므로, 사전 판정이 없으면
  **효과가 한 번도 없었던 거부**가 `outcome_unknown`으로 기록된다(승인 밖 요청과 진짜 불확실이 같은
  marker를 받아서는 안 된다). 독립 리뷰가 ⓒ에 대해 "승인 해석 이중화 아님"을 확인했다(같은
  `resolveWriteAuthority` 하나를 쓴다).
- **`C-1` → fixed**(`95fdb4e`): 발행 seam setter를 production 표면에서 제거했다. 두 겹이다 —
  ⓐ facade(`typedExecution.ts`)에서 런타임 재수출 삭제(타입만 잔존) ⓑ 등록 시 **직접 호출자 프레임이
  `*.test.ts`** 여야 하고, `tsconfig` exclude가 모든 `.test.ts`를 build에서 빼므로 `dist/`에는 그 조건을
  만족할 프레임이 **존재하지 않는다**. 프레임 파싱이 깨지면 **fail closed**임을 리뷰가 확인했다.
  **남은 표면은 없앴다고 주장하지 않는다**: 소스 체크아웃을 `tsx`로 돌리는 개발 환경 · 같은 프로세스에서
  `Error.prepareStackTrace`를 바꿀 수 있는 코드(그 권한이면 모듈 자체를 교체할 수 있어 신규 상승 아님) ·
  hook 등록 **이후**의 상한은 기존과 동일(이번 변경은 **등록 경로만** 좁혔다).
- **리뷰 C 5건 전부 반영**(`2b49a36`): Task 2 C-1(정지 경로 서술이 틀렸다 — 실제로는 착지 전이의
  `assertNoPendingOperations` → `C-55` catch이지 `B-22`가 아니다) · C-2(거부된 생산 turn도 원장에
  들어가는지 단언) · C-3(취소 테스트 추가) · Task 4 C-a(등록 거부가 집행 taxonomy를 빌리지 않는다) ·
  C-c(스택 가드는 동기 호출 전제).
- **검증**: `tsc --noEmit` 0 · `src/exec/*.test.ts` + `autopilot.test.ts` **528 pass / 0 fail**.
  기존 테스트 **삭제·완화 0건**. 프로세스 spawn 0 · 네트워크 0 · live 0.
- **기존 테스트 1건은 갱신했다(약화가 아니다)**: "typed operation을 요구하는 계획은 집행하지 않고 paused로
  착지한다 (B-10/B-16 미소비)"는 **사용자가 명시 승인해 연 게이트**를 고정하고 있었다. 지금은 같은 자리에서
  더 강한 것을 단언한다 — 승인 밖 요청은 **등록 전에** 거부돼 durable 흔적이 0이고, 바이트 발행은 승인된
  authority 아래에서도 여전히 fail closed다(`B-16` 미개봉 테스트를 **추가**했다).

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-61` | C (P3) | **operation과 operation 사이의 취소 창이 미검증이다.** 집행 loop는 매 operation 앞에서 abort를 보지만, 그 창을 결정론적으로 때릴 **관측 hook이 없어** 테스트가 덮지 못한다(현재 취소 테스트는 terminal **이전** 창을 덮는다). 코드상 pending 0으로 반환하나 실행으로 확인되지 않았다 | 미확인 | 취소 1건의 pending 정합성 | 낮음 — 남은 pending은 착지 전이가 막는다 | 소(operation 경계 진행 이벤트 추가 후 barrier) | 집행 loop에 관측 이벤트를 추가하는 다음 slice | 다음 autopilot slice | Task 2 독립 리뷰 C-3 · `autopilot.ts` `dispatchOperations` abort 체크 | open |
| `C-62` | C (P3) | **seam 등록 가드의 `.test.ts` 판정이 suffix 매칭이다** — 경로 어디에 있든 `.test.ts`로 끝나면 통과한다(`/tmp/evil.test.ts`). 그 조건 자체가 이미 임의 코드 실행 능력을 전제하므로 등급은 "남은 표면 ⓐ"와 같다. repo 경로 prefix 검사 추가는 선택 | 낮음 | 개발 환경 | 낮음 | 소 | 없음(bounded) | — | Task 4 독립 리뷰 C-b | open |

> **`B-16`은 미개봉이다** — 이 slice가 그 판단을 바꾸지 않았고, 오히려 **M5d 완료 조건의 의미가 그것에
> 달려 있다**는 사실을 드러냈다(위 표). `B-11`·`B-12`·`B-13`·`B-17`·`B-18`·`B-19`·`B-20`·`B-21`(fixed) ·
> live 게이트(`B-23`·`B-7`/`B-9` fixed)는 **변화 없음**.

##### M5d task 1 — `B-21`·`C-55` 마감 (2026-08-10 — **독립 리뷰 `APPROVE — A=0, B=0, C=3`** · 이 절이 현행이다)

> 범위 `fc0a528..1cbfe9a`. M5d는 **offline self-hosting acceptance**이고 사용자가 두 결정을 승인했다:
> ⓐ **offline typed execution 소비 게이트를 연다**(live provider 게이트는 닫힌 채 유지) ·
> ⓑ self-hosting 대상은 **작은 fixture repo**(하네스 레포 자신이 아니다).
> Task 1은 그 acceptance가 밟게 될 복구 경로를 먼저 닫는다.

- **`B-21` → fixed**: `prepared`는 `RESOURCE_HOLDING_STATES`인데 `selectSchedulable`은 `ready`/`retry_wait`만
  고른다 → 중단된 batch의 잔여가 배타 class와 `maxSessions` 자리를 영구히 잡았다. iteration 시작에서
  잔여를 되찾는다: 계획이 있으면 `startPreparedTask`로 이어 달리고(봉인된 preflight 재대조 —
  **새 attempt를 태우지 않는다**), 없으면 `paused(approval_required)`로 접어 자원을 놓아준다.
  시작이 거부된 잔여(`preflight_drift`)도 `prepared`에 두지 않는다 — 그것이 같은 누수를 다시 만든다.
- **`C-55` → fixed(범위 명시)**: turn 중간 kernel throw가 CLI를 죽이고 나머지 batch를 조용히 밀던 것을
  잡아 `turn_aborted`로 loop를 멈춘다. **그 task 자체의 정리는 하지 않는다** — lease가 `runTaskTurn`
  안에 있어 catch가 대신 놓을 수 없다. 크래시 등가는 그대로이고 durable `processLeaseMarker`가
  복구 근거다. 바뀐 것은 "나머지를 계속 밀지 않는다" 하나다.
- **검증**: `tsc --noEmit` 0 · `autopilot.test.ts` **21 pass** · `src/exec/*.test.ts` **501 pass / 0 fail**.
  기존 테스트 수정·완화 **0건**. 프로세스 spawn 0 · 네트워크 0 · live 0.
- **독립 리뷰**(fresh Fable 5 read-only): `APPROVE`. attempt 미소모(`attemptNo` 증가는
  `commitPreflightBatch`의 `prepared` 분기뿐) · `prepared`의 `cleanupStatus="none"`이라 `pauseTask`
  합법 · 되찾기가 batch 계산보다 **먼저**라 이중 계상 없음 · 동시 writer는 `commitRun`의 revision
  대조(`stale_writer`)가 막음 · 새 테스트 3건 전부 mutation 관점에서 red가 된다고 판정. C-3은 **이번에
  수정**했다(`1cbfe9a` — abort를 `task_paused`로 알리지 않는다).

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-59` | C (P3) | **되찾기·start_rejected의 `pauseTask`가 `C-55` try/catch 밖이다.** 다른 writer가 그 좁은 창에서 상태를 바꾸면(`stale_writer`·`invalid_transition`) 예외가 CLI로 전파돼 `C-55`가 막은 것과 같은 크래시가 재현된다. 단일 운영자 모델에서는 실질 무해다 | 낮음 | CLI 프로세스 1개 | 낮음 | 소(같은 catch 안으로) | 다중 운영자·동시 autopilot을 허용하기 전 | 다음 autopilot slice | Task 1 독립 리뷰 C-1 · `autopilot.ts` 되찾기/start_rejected pause | open |
| `C-60` | C (P3) | **abort 원인이 어디에도 남지 않는다.** `codeOf`가 비-`OrchestrationError`를 `autopilot_internal_error`로 접어 운영자는 marker 한 단어만 본다. 원문 메시지를 그대로 싣는 것은 경로 유출 위험이 있으므로(같은 계층의 stderr 규율) **bounded·정규화된 진단**이 필요하다 | 중(진단할 일이 생길 때) | 운영자 진단 | 낮음 | 소 | 없음(bounded) | — | Task 1 독립 리뷰 C-2 | open |

##### live 하드 게이트 마감 4건 — `B-9` · `B-7ⓑ` · `B-22` · `B-7ⓐ` (2026-08-10 — **`B-7ⓐ` 독립 리뷰 `APPROVE — A=0, B=1, C=2`** · live 실행은 **여전히 0회** · 이 절이 현행이다)

> 범위 `a00a6af..fc0a528`. 커밋 4건은 **live를 켜기 전에 닫기로 예약돼 있던 하드 게이트**를 offline에서
> 닫은 것이다. **이 세션도 실제 Codex 추론 0 · 네트워크 0 · secret 사용 0**이며, 게이트가 닫혔다는 것과
> live가 검증됐다는 것은 다르다 — 아래 `B-23`이 그 남은 간극이다.

- **`B-9` → fixed**(`3d14c7b`): 실측 codex JSONL usage 필드명(`cache_write_input_tokens` 등) 반영.
- **`B-7ⓑ` → fixed**(`2154a39`): 자식 `stdio[2] = "ignore"`. stderr가 fd 단계에서 버려져 이 프로세스
  메모리에 들어오지 않는다. `SpawnFn` 타입도 `"ignore"` 고정이라 pipe로 받는 코드는 컴파일되지 않는다.
  패턴 전용 redaction에 의존하지 않는다.
- **`B-22` → fixed**(`5a8d9f0`): `chargeTurnUsage` 거부를 삼키지 않고 정리 후 `approval_required` pause +
  loop `usage_unaccounted` 정지. task는 resume 가능하다.
- **`B-7ⓐ` → fixed**(`fc0a528`): live 인증 방식을 사람이 결정해야 했던 항목. **"승인된 격리 홈에 사람이
  1회 로그인"** 을 택했다. `manifest.executionAuthority.codexHome`(유일한 선택 key · `ApprovedDirectory` ·
  **내용 digest 없음**)이 경로를 고정하고, 승인 홈이면 ⓐ 경로 정확 일치(`codex_home_not_approved`)
  ⓑ 홈·자격증명 프로세스 uid 소유 ⓒ `auth.json` 외 항목 0(`codex_home_not_empty`) ⓓ 자격증명 부재는
  거부(`codex_home_credentials_missing`)다. harness는 로그인을 대행·자동화·프록시하지 않고 auth를
  복사·영속화·**해싱**·기록하지 않는다(digest를 남기는 것 자체가 유출 경로다). 승인이 홈을 담지 않으면
  기존 계약대로 **완전히 비어 있어야** 하고 `~/.codex` fallback은 어느 경로에도 없다. 부재와 `null`을 같게
  정규화하므로 **기존 승인의 canonical digest는 바이트 단위로 불변**이다.
- **검증**: `tsc --noEmit` 0 · `npm run test:exec` **168/168 pass**(focused). 전체 suite·acceptance·stress·
  live는 **미실행**(다음 handoff 게이트에 그대로 예약).
- **독립 리뷰**(fresh Fable 5 read-only, `fc0a528` diff): `APPROVE`. TOCTOU는 사전 검증 + spawn 직전
  동기 게이트가 둘 다 `approved`를 받아 재검증하므로 닫혀 있고, 오류 메시지에 경로·uid·파일명이 없으며,
  하드링크는 inode의 소유자·모드를 공유하므로 소유자 검사로 덮인다고 판정했다. 신규 등록은 아래 3건이다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-23` | B (P1) | **[fixed 2026-08-11 — live probe]** **`codex login`의 실제 산출물이 `auth.json` 하나라는 가정이 미확인이다.** `CODEX_CREDENTIAL_FILES`가 `["auth.json"]` 하나인데 실제 로그인이 `config.toml`·버전 파일 등을 함께 쓰면 첫 invocation이 `codex_home_not_empty`로 죽어 **live가 실사용 불가**가 된다. 지금 테스트는 전부 **합성 홈**이라 이 가정을 검증하지 못한다. 반대 방향(허용 목록을 미리 넓히기)은 하지 않는다 — 넓히는 순간 `config.toml`·MCP 정의가 자격증명 뒤에 묻어 들어오는 통로가 열린다. 실측 후 **정확히 관측된 파일만** 추가한다 | 중 | 첫 live 실행 | 낮음(offline 0 · live에서 즉시 발견) | 소(실제 `CODEX_HOME=<path> codex login` 1회 실행 후 항목 목록 실측) | **첫 live 실행 착수 전(하드 게이트 — `B-7`을 대체한다)** | 사용자 + live 활성화 slice | `B-7ⓐ` 독립 리뷰 B · `codexCliProvider.ts` `CODEX_CREDENTIAL_FILES` | open |
| `C-57` | C (P3) | **provider 재시작 후 홈 재사용이 막힐 수 있다.** codex가 첫 run에서 홈에 세션·캐시 파일을 쓴다면(**미확인**) `homeId`가 없는 새 provider의 첫 검증이 `codex_home_not_empty`로 거부하고, 사람이 `auth.json`만 남기고 수동 청소해야 한다. 운영 마찰이며 안전 결함은 아니다. `B-23` 실측에서 같이 관측될 항목이다 | 미확인 | 운영 절차 | 낮음 | 소(문서화 또는 실측 기반 목록 확장) | `B-23`과 함께 | live 활성화 slice | `B-7ⓐ` 독립 리뷰 C-1 | open |
| `C-58` | C (P3) | **자격증명 파일 자체는 dev+ino가 고정되지 않는다.** 홈은 첫 invocation에서 dev+ino로 핀되지만 `auth.json`은 `lstat` 1회뿐이라 검증~codex 읽기 사이 교체가 가능하다. 다만 **같은 uid만** 가능하고 그건 이 계층이 명시적으로 선언한 threat model 밖이다(소유자 자신은 언제든 자기 홈을 쓸 수 있다) | 매우 낮음 | 자격증명 1건 | 낮음 | 중(fd 기반 고정) | 없음(선언된 범위 밖) | — | `B-7ⓐ` 독립 리뷰 C-3 | open |

> **`B-7`은 이 절로 닫힌다**(ⓐ·ⓑ 모두 fixed) — 다만 **live 하드 게이트가 사라진 것은 아니다**:
> 그 자리는 `B-23`(자격증명 산출물 실측)이 이어받고 `B-9`는 fixed다. `B-10`·`B-11`·`B-12`·`B-13`·
> `B-16`·`B-17`·`B-18`·`B-19`·`B-20`·`B-21`은 **변화 없음**(이 세션은 controller·process·scheduler 계층을
> 건드리지 않았다).

##### M5c task 3E·3F 대장 갱신 + **M5c 마감** (2026-08-05 — **3E 독립 리뷰 `APPROVE — A=0, B=2, C=6` · 3F로 숨은 red 48건 복구 · 전체 suite 1회 PASS · M5c 완료 · M5 완료 조건은 미충족** · 이 절이 현행이다)

> 3E 범위 `6a743f2..c771f81`(fresh Fable 5 read-only 독립 리뷰) · 3F `c771f81..32b8853` ·
> 경합 수정 `32b8853..77b55e5`. 열린 **A는 0건**이다.

**M5c는 완료다. M5는 완료가 아니다 — 이 구분을 흐리지 않는다.**
독립 리뷰(3E Q11)의 판정 그대로 적는다: M5 완료 조건(로드맵 ~:1490)은 fixture repo에서
Codex plan → Claude implement → test → fresh review → revise → verify가 수동 복사 0회로 도는 것인데,
그건 live provider와 typed execution이 필요하고 **둘 다 의도적으로 열린 게이트**(`B-7`/`B-9`/`B-10`)다.
현재 autopilot은 **operation이 0건인 plan만 완료에 도달**시킬 수 있다 — 즉 **아직 마일스톤을 완료까지
몰고 갈 수 없다.** 이번에 증명된 것은 제목의 나머지 절반, **"Autopilot Bootstrap"**(승인 게이트 · durable ·
pause-not-hang · 관측 가능 · 취소 정리)이다.

**3E — `harness autopilot`**: 승인 manifest 게이트 → 16회 상한 루프 → `planRunnableBatch` →
plan 파일이 있는 task만 `prepared`, 없으면 **`deferred`(무접촉)** → turn 직전 `startPreparedTask` →
`startOfflinePlanTurn`(in-memory · spawn 0) → progress를 `recordProgress` + stdout **양쪽**으로 →
`recordTerminal` → `confirmCleanup` → `completed`/`paused`/`cancelled`.
plan 파일은 `{operations, result}`만 담고 **run/task/attempt/turn 결박은 durable state에서** 채운다 →
plan 파일이 다른 run을 사칭하거나 낡은 attempt를 되살릴 수 없다.
**열린 게이트 7종(`B-10`·`B-11`·`B-12`·`B-13`·`B-16`·`B-17`·`B-7`/`B-9`)을 하나도 닫지 않고 하나도
넘지 않았다 — 전부 "소비 회피"로 독립 판정됐다.** `--resume`/재예산 플래그를 **의도적으로 만들지 않았다**.
`B-16` 경계 판정(구현자가 second opinion을 요청한 건): **밖이다** — B-16은 `applyWriteFile`이 **새 바이트**를
발행하는 것을 게이트하는데 typed write가 0이고, 기존 task 소유 파일 등록은 M5b가 이미 승인한
`completeTaskWithArtifacts → addArtifact` 경로(소유권·`writableRoots`·hash 집행)다.

**3F — 숨어 있던 red 48건 복구(이번 세션 최대 발견).**
`src/exec/codexCliProvider.test.ts`가 **11 pass / 48 fail**이었고 **적어도 `8dd05f9`부터 그랬다.**
원인은 3B가 `stableController`에서 고친 것과 **같은 결함** — pre-M5c v1 manifest fixture라
`manifest_pre_m5c_unsupported`가 **각 테스트의 검증 대상에 도달하기 전에** 승인을 거부했다.
**아무도 몰랐던 이유: 모든 세션이 focused 테스트만 돌렸고 `npm run test:exec`를 아무도 돌리지 않았다.**
그 48건은 M5a/M5b **안전 테스트**다 — spawn 0 단언 · TOCTOU 재검증 · 실행 파일 신원 고정 · 격리 홈
계약 · MCP 위반 · 세션 소유권 · 핸들 위조. **Task 3A 이후 이 속성들이 실제로 검증된 적이 없었다.**
수정은 fixture 이관뿐이고 **프로덕션 변경은 하나도 필요하지 않았다**(= red 뒤에 숨은 제품 결함 없음).
"초록으로 만든 게 아니라 대상에 도달한다"는 증명: suite 헬퍼 `codeOfCall`이 아무것도 안 던지면
`"(통과)"` 센티넬을 반환하고 `expectNoSpawn`이 별도로 `calls.length === 0`을 단언하며, 모든 테스트가
`assert.equal(code, "<구체 코드>")`로 끝난다 → 센티넬로도 `manifest_pre_m5c_unsupported`로도 통과 불가.
mutation 4종이 실증했다(`approved_commit_mismatch` 3개소 변조 · digest 검사 제거 시 **spawn 0 → 1 반전** ·
seal-drift 가드 무력화 시 4건 사망).

**경합 수정(`77b55e5`)**: `managedProcess` SIGKILL 테스트가 병렬 부하에서만 red였다. 실험으로 원인
확정 — 지연 100ms에서 SIGKILL 40/40, 3ms에서 SIGTERM 29·SIGKILL 11, 1ms에서 SIGTERM 40/0 →
`sh`가 `trap '' TERM`을 설치하기 **전에** deadline이 터져 자식이 그냥 SIGTERM으로 죽고 "고집스러운
프로세스"가 생기지 않았다. **supervisor는 두 경우 모두 올바르게 동작했다 — 테스트 쪽 경합이다.**
`4774c43`과 같은 관측 배리어(trap 다음 줄에서 ready 파일 기록 → 폴링)로 고정했고 원본 assertion 3건은
바이트 동일, 배리어 실패를 소리나게 만드는 assertion 1건이 **추가**됐다.

**전체 suite 1회 — 실행했다(계획 리뷰어 권고를 앞당김).**
`npm test` 직렬 1회: `test:exec` **493/493** · `test:core` **391/391** · acceptance **PASS=92 / FAIL=0**.
`test:exec`는 중앙 재실행 **3회 연속 493/493**(수정 전 444/49). **이 저장소에서 M5a 이후 처음으로
전체가 초록이다.**

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-21` | B (P1) | **중단된 batch의 `prepared` task를 autopilot이 스스로 되찾지 못한다.** 예산 게이트·SIGINT·`preflight_drift`로 batch 중간에 멈추면 나머지가 `prepared`로 남는데, `prepared`는 `RESOURCE_HOLDING_STATES`(`orchestrationTypes.ts:79`)라 배타 class를 잡고 `maxSessions`에 계상되는 반면 `selectSchedulable`(`orchestrationKernel.ts:3985`)은 `ready`/`retry_wait`만 고른다 → **이후 어떤 autopilot 실행도 그 task를 다시 입양·정착시킬 수 없다.** 사람이 `pauseTask`(→`cleanupStatus:"none"`이라 허용) 후 `resumeTask`로 복구할 수는 있으나 attempt 1회를 태운다. 교착도 게이트 소비도 아니지만 **이후 모든 batch를 조용히 줄인다**. `autopilot.test.ts`에 `prepared` 잔여를 다루는 테스트가 **0건**이다 | 중 — batch가 2건 이상인 run에서 | run 1개의 처리량 | 중 | 소~중(`prepared` 재입양/정착 pass) | **autopilot을 반복·예약 실행(cron/loop)하기 전** | 다음 M5c slice | 3E 독립 리뷰 F-1(STATIC) · `autopilot.ts:192-199, 241-243` | open |
| `B-22` | B (P1) | **`chargeTurnUsage` 실패를 삼켜 토큰 예산이 과소 집행된다.** 거부(`charged_turns_exhausted` · 시계 sanity)가 조용히 넘어가면 그 turn의 토큰이 durable `accounting.tokensUsed`에 반영되지 않고, 이후 `budgetGate`가 낡은 합계로 통과한다. 경과 예산(`budgetDeadlineAt`)은 durable 고정이라 그대로 집행되고 offline 사용량은 어차피 자기신고라 **오늘 노출은 0**이지만, live backend에서는 **실제 미계측 지출**이 된다 | 낮음(지금) → 확실(live) | run 1개의 토큰 회계 | 높음 — live에서 발견하면 이미 지출된 뒤다 | 소(실패를 stop/pause 조건으로) | **`B-7`/`B-9`와 같은 하드 게이트 — live·토큰 생성 backend 배선 전** | live 활성화 slice | 3E 독립 리뷰 F-2(STATIC) · `autopilot.ts:285-295` | open |
| `C-50` | C (P3) | plan 파일의 malformed JSON · 초과 크기 · 읽기 실패가 전부 `null` → `deferred(plan_missing)`으로 접힌다. 오타 난 plan과 의도적 부재를 구분할 수 없어 **오설정을 숨긴다**. `plan_missing`과 `plan_unreadable`을 분리할 것 | 중 | 운영자 진단 | 낮음 | 소 | 없음(bounded) | — | 3E 리뷰 C-1 · `autopilot.ts:414-427` | open |
| `C-51` | C (P3) | `readFileSync`가 4 MiB 검사 **전에** 파일 전체를 읽는다 → 거대 plan 파일이 먼저 메모리에 올라온다. `statSync`로 크기를 먼저 볼 것 | 낮음 | 메모리 | 낮음 | 소 | 없음 | — | 3E 리뷰 C-2 · `autopilot.ts:417-418` | open |
| `C-52` | C (P3) | `resultEnvelope`가 주입된 `clock` 대신 `new Date()`를 쓴다 — 모듈 내 유일한 시계 우회. kernel이 envelope `createdAt`을 교차 검증하지 않아 동작은 하지만 모듈 자신의 시계 권위 규율과 어긋난다 | 낮음 | 일관성 | 낮음 | 소 | 없음 | — | 3E 리뷰 C-3 · `autopilot.ts:477` | open |
| `C-53` | C (P3) | 잘못된 `--max-iterations`(`"abc"` → NaN)가 거부되지 않고 조용히 16으로 폴백한다 | 낮음 | 운영자 오인 | 낮음 | 소 | 없음 | — | 3E 리뷰 C-4 · `cli.ts:143` · `autopilot.ts:441-444` | open |
| `C-54` | C (P2) | `resultBody`/`resultEnvelope`가 `stableController`의 사설 등가물을 부분 복제한다. 지금은 수용 가능(제목을 `REQUIRED_BODY_HEADINGS`에서 파생 · kernel이 본문을 재검증 · controller는 범위 밖이었다)이나 **분기 위험**이 있다 | 중 | 두 경로의 본문 계약 | 중 | 중(통합) | **controller를 다음에 여는 slice에서 통합 판단** | 다음 controller slice | 3E 리뷰 C-5 · `autopilot.ts:488-501` vs `stableController.ts:1373` | open |
| `C-55` | C (P3) | `startPreparedTask` 이후 turn 중간에 kernel이 예기치 않게 throw하면(시계 역행 · `recordTerminal`/`confirmCleanup` 디스크 오류) 잡히지 않고 전파돼 CLI가 죽고 task가 `running`/`cleaning`에서 durable lease를 쥔 채 남는다. **크래시 등가**(`kill -9`와 같음)이고 durable `processLeaseMarker`가 복구용으로 읽히므로 "pause가 필요한데 hang한" 경우는 아니다. `B-21`의 복구 slice에 합류시킬 것 | 낮음 | task 1건 | 낮음 | 중 | `B-21`과 함께 | 다음 M5c slice | 3E 리뷰 C-6 | open |
| `C-56` | C (P3) | `managedProcess.test.ts`의 `mkdtemp` fixture 디렉터리를 suite가 unlink하지 않아 `$TMPDIR`에 남는다(프로세스 누수는 아니다 · 기존 `makeDir` 헬퍼의 동작이며 이번 변경과 무관) | 확실 | 디스크 부스러기 | 없음 | 소 | 없음 | — | 경합 수정 worker 실측 | open |

> **확인 사항**: `C-49`의 trigger("autopilot CLI 착수 전")는 기술적으로 발화했으나 **autopilot은 commit
> 자동화를 하지 않으므로** 행은 열린 채 두고 trigger를 **commit 자동화 slice**로 옮긴다.
> `C-41`(executionBoundary red)은 **fixed 유지**이며 이번 전체 suite 통과로 재확인됐다.
> `B-16` **미개봉** · `B-10`/`B-11`/`B-12`/`B-13`/`B-17`/`B-18`/`B-19`/`B-20` 변화 없음.

##### M5c task 3D 대장 갱신 (2026-08-04 — **독립 리뷰 `APPROVE — A=0, B=1, C=3` · Task 3D 완료 · M5c/M5 미완료 · 이 절이 현행이다**)

> 범위 `f33c1aa..b09df0e`. fresh Fable 5 read-only 독립 리뷰(구현 worker transcript 미전달).
> **이 리뷰는 정적 검토에 그치지 않고 실증 실험을 했다** — ⓐ scratchpad repo에서 `.git` 전 파일의
> mtime+size 스냅샷을 3개 쿼리 실행 전후로 비교(**바이트 단위 동일 = NO-WRITE**) ⓑ repo `.git/config`에
> `core.fsmonitor`·`diff.external`·`core.pager`를 sentinel 스크립트로 심고 실행(**코드 실행 0**).
> 그 외 `trustedGit` 15/15 · kernel+managedProcess+stableController **176/176** · `tsc` exit 0 직접 실행.

**허용 집합은 3개뿐이고 전부 로컬 read-only다**: `rev-parse --verify --quiet HEAD^{commit}` ·
`diff --no-ext-diff --no-textconv --quiet HEAD --` · 같은 것의 `--cached` 판. 고정 prefix
`-c core.fsmonitor=false -c core.hooksPath=/dev/null --no-optional-locks --no-pager`.
**remote·refspec·branch·경로·커밋 메시지를 담을 필드가 API에 없다** → push/fetch/pull/clone/
submodule/merge는 "안 부르는" 게 아니라 **표현 불가능**하다. `spec.mutates === false`를 spawn 전에
단언하므로 표에 쓰기 행을 추가하는 것만으로는 여전히 거부된다. 권위 모델은 Task 3C 선례 그대로
(kernel 사설 WeakMap · 객체 참조가 권위 · 발급자 `===` · durable 재독 · A4 mark-then-re-verify) —
독립 리뷰가 위조·재생 전수 거부와 동시 이중 소비 불가(①~④가 첫 `await` 전에 동기 실행)를 확인했다.
`superviseProcess`를 재사용해 **두 번째 spawn 경로를 만들지 않았고** `managedProcess.ts`는 무변경이다.

**리뷰어의 Q2 판정 — "durable pending 불필요" 논리는 성립한다.** 구현자가 스스로 최우선 공격
대상으로 지목한 항목이다. 실측 결과 세 쿼리 전부 `.git`에 **아무것도 쓰지 않는다**
(`--no-optional-locks`가 `git diff`의 기회적 index refresh를 억제하고, `rev-parse --verify`는 쓰기가
없으며, plumbing 쿼리는 auto-gc/maintenance를 유발하지 않는다). **효과가 0이면 A4의 pending이 서술할
불확실 창 자체가 없다.** 편법이 아니라 옳은 판단이다.

**리뷰어의 Q9 판정 — commit-class 로컬 쓰기 미구현은 옳은 범위 결정이다.** durable pending의
`kind`는 `orchestrationTypes.ts`/`schemas/`의 닫힌 union이라 이 task 소유권 밖이고, durable 표시 없이
쓰기를 넣으면 **3A가 닫은 "효과는 있는데 durable 흔적이 없는" 구멍을 재생성**한다. 다만 M5c
self-hosting은 결국 로컬 commit/worktree 쓰기가 필요하므로 **이 task는 의도적으로 gap을 남겼다** —
다음 task가 **durable pending 계약을 먼저** 가져와야 하며, `mutates` 단언과 `git_mutation_unsupported`
코드가 그 순서를 기억이 아니라 **집행**으로 강제한다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-20` | B (P2) | **system/repo gitconfig를 여전히 읽는다.** `GIT_CONFIG_NOSYSTEM`/`XDG_CONFIG_HOME` 미설정이라 `/etc/gitconfig`와 `.git/config`가 파싱된다. **오늘 도달 가능한 코드 실행 경로는 없다** — 코드를 실행하는 키(fsmonitor · hooks · external diff · textconv · pager)는 전부 최고 우선순위 `-c`/플래그로 강제 무력화되고, `HOME` 부재가 `~/.gitconfig`와 그 안의 `include.path`를 죽이며, 네트워크 subcommand가 0이라 `credential.helper`/`uploadpack`/`core.sshCommand`는 도달 불가다. 리뷰어가 적대적 config를 실제로 심어 **실행 0**을 확인했다. 남는 것은 *미래 git 버전이 추가할 키*의 가설적 위험이며 gitconfig 파일 쓰기 권한이 선행 조건이다 | 낮음 | read-only 쿼리 프로세스 1개 | 낮음 | **소 — env 한 줄**(`GIT_CONFIG_NOSYSTEM=1`, 선택적으로 `GIT_CONFIG_GLOBAL=/dev/null`) | **`managedProcess.ts` env를 다음에 건드리는 task**(`B-18`/`B-13`/`C-18` live-runner slice)에서 함께 닫는다 | M5c live-runner 세션 | Task 3D 독립 리뷰 F1(STATIC+EXECUTED) · `orchestrationKernel.ts` `TRUSTED_GIT_PREFIX` | open |
| `C-47` | C (P3) | **`.git`이 regular file(worktree 포인터)이어도 통과한다.** workspace 루트에 `gitdir:` 파일을 심으면 세 쿼리가 **다른 로컬 저장소**에 대해 답한다(그 gitdir의 config도 읽는다 — `B-20`과 같은 잔여). workspace 루트 쓰기 권한이 필요하고 결과는 **잘못된 boolean 판정 1건**이다 — 변경 0 · remote 0 | 낮음 | 판정 1건 | 낮음 | 소(포인터 대상 검증) | worktree가 의미를 갖는 시점 | 다음 kernel slice | Task 3D 독립 리뷰 F2(STATIC) | open |
| `C-48` | C (P3) | **repo 신원 검사와 spawn 사이 TOCTOU.** 검사와 `cwd` 해석 사이 마이크로초에 경로 구성요소를 symlink로 바꿔치기할 수 있다. 결과는 역시 **다른 로컬 경로에 대한 read-only 쿼리**뿐이다 | 매우 낮음 | 판정 1건 | 낮음 | 중(fd 기반 고정) | 없음(bounded) | — | Task 3D 독립 리뷰 F3(STATIC) | open |
| `C-49` | C (P2) | **exit-code-only 표면이 self-hosting에 얇다.** `superviseProcess`가 `stdio:"ignore"`라 무엇이 dirty인지·현재 브랜치·HEAD sha를 관측할 수 없다. 게이트 술어("시도 전후 worktree가 깨끗한가")로는 충분하나, **commit 자동화를 원하는 다음 task는 stdout 캡처와 durable pending을 둘 다** 가져와야 한다. 발견이 아니라 계획으로 다루라는 취지 | 확실(다음 task) | 다음 task 범위 | 중(뒤늦게 발견하면 재설계) | 중 | `autopilot` CLI / commit 자동화 착수 전 | 다음 slice | Task 3D 독립 리뷰 F4(STATIC/EXECUTED) | open |

> **확인만 하고 새로 열지 않은 것**: `git_result_unknown`은 매핑 안 된 exit code에서 **던지며 판정을
> 만들지 않는다**(fail-closed — `exit 42` 테스트로 확인) · `TRUSTED_GIT_TIMEOUT_MS = 30_000` 하드코딩은
> **옳은 판단**(상수 작업량 로컬 쿼리는 마일스톤 승인 정책의 대상이 아니다) · `B-18`은 `superviseProcess`
> 경유로 **그대로 상속**되며 악화되지 않았다(`managedProcess` diff 0) · 교체 assertion 2건은 둘 다
> allow-list **추가 등록**이고 같은 테스트의 위조 거부 루프가 신규 predicate까지 **강화**됐다 ·
> 신규 공개 API 2종은 안전(resolver는 running task에 봉인된 enum 결박 권능만 발행 · predicate는 read-only).
> `B-16` **미개봉** · `managedProcess.ts` **무변경**.

##### M5c task 3C 대장 갱신 (2026-08-04 — **독립 리뷰 `REVISE — A=0, B=4, C=2` → 값싼 B 2건 후속 폐쇄 · Task 3C 완료 · M5c/M5 미완료 · 이 절이 현행이다**)

> 범위 `f2e187d..56cf8d6`(구현) + `98a0778..4774c43`(후속). fresh Fable 5 read-only 독립 리뷰
> (구현 worker transcript 미전달). 리뷰어는 정적 검토 + `managedProcess.test.ts` **52회 실행** ·
> kernel/typedExecution **167/167** · `tsc` exit 0을 **직접 실행**했다.
> 판정은 `REVISE`였으나 **열린 A는 0건**이며, B 4건 중 값싼 2건(F1·F3)을 같은 task 안에서 닫았다.

**`B-F1` — closed (2026-08-04, Task 3C).** 첫 실제 승인 spawn이 들어왔고 대장 요건 ①~④가
`orchestrationKernel.executeRunProcessOperation`에서 집행된다: ① 1회 소비(module-private WeakMap ·
`spent`를 효과 **이전**에 세우고 절대 되돌리지 않으며 권위가 **객체 참조 자체**라 spread/freeze/Proxy/
JSON 왕복이 전부 빗나간다) · ② live grant + 발급자 신원(`GENUINE_GRANTS` · `state === "issued"` ·
operation identity `!==` · kernel 인스턴스 `===` · operationId/authorityId/run/task/attempt/turn 결박) ·
③ durable 재독(`record.readState()`, 표시 후 재차) · ④ spawn 직전 digest 재검증
(`verifyLaunchTargets` → mint 시점 path+sha256 대조 후 `verifyApprovedExecutable`로 canonical path ·
no-symlink · regular · exec bit · group/other write 금지 · 내용 SHA-256). A4 mark-then-re-verify 순서
유지 — 표시 후 거부는 `reconcileUncertainOperation` → `outcome_unknown`으로만 닫힌다.
독립 리뷰가 **중복 spawn 경로 없음**(1 승인 → 최대 1 spawn · 재시작 후 `assertNotAttempted`가 재발급 차단)과
**위조 전수 거부**를 실제 실행으로 확인했다. 잔여 한계는 아래 `B-18`이다.

**F1(flaky deadline 테스트) — fixed.** 원인은 fixture의 **동기화 배리어 부재**였다(테스트 전용 false red ·
프로덕션 `reapGroup()`은 `kill(-pgid,0)` ESRCH **관측** 기반이라 영향 없고 false green 경로도 없다).
`4774c43`이 관측 배리어(pid 파일 폴링, 기존 cancel 테스트와 같은 패턴)를 넣고 `timeoutMs` 300 → 2000으로
올렸다. 삭제·완화 0이고 `assert.equal(existsSync(pidFile), true)` 1건이 **추가**돼 더 강해졌다
(손자가 deadline 전에 살아 있었음을 이제 *증명*한다). 실측: 유예 전 약 **2/95 실패** →
후속 후 중앙 재실행 **정상 20회 + 부하 10회 = 30회 전부 0 fail**, 파일 13 → **15 tests**.

**F3(spawn 상한 미검증) — 부분 폐쇄.** run 전역 상한은 양쪽 경계가 고정됐다(32번째 실제 실행 ·
33번째 `process_spawn_limit_exceeded`이고 그 pending의 `attemptedAt`은 `null` = **spawn 전 · 표시 전** 거부).
mutation으로 red 확인. depth는 **허용 측만** 고정됐다 — 아래 `C-44` 참조.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-18` | B (P1) | **`cleanupConfirmed`는 `setsid()`/`setpgid()`로 프로세스 그룹을 탈출한 자손을 보지 못한다.** 그룹 기반 reap은 pgid에 **남아 있는** 자손만 덮는다. 탈출한 자손이 있으면 `kill(-pgid,0)`이 ESRCH를 돌려주고 kernel이 성공 영수증을 발행하는데 고아는 살아 있다 → `cleanupConfirmed: true` + 살아 있는 고아. `managedProcess.ts` 헤더 주석의 "모든 자손"은 **과장이며 정정 대상**이다 | 지금 낮음(digest 승인된 node+entrypoint만 실행 · fixture 통제) — **daemonize하는 entrypoint를 승인하면 확실** | 승인 밖 프로세스 1개 이상이 무기한 생존. durable 무결성은 무관 | 중 — live runner에서 좌초 프로세스가 다음 batch 자원을 먹고, "정리됐다"는 기록만 남아 추적 불가 | 중(그룹 밖 자손 탐지 또는 daemonize 금지 집행) | **daemonize 가능한 실제 controller entrypoint 승인 전 / live runner 배선 전** — `B-13`·`C-18`과 같은 발화점 | live-runner slice | Task 3C 독립 리뷰 F2(STATIC) · `managedProcess.ts:13-16, 103-109` | open |
| `B-19` | B (P2) | **run 전역 프로세스 상한이 `LIMITS.maxTasksPerRun`(=32) 상수를 빌려 쓴다(스펙 혼동).** 로드맵의 32는 **run당 task** 수인데, `assertSpawnLimits`의 도달 가능한 검사는 `runTotal = Σ(run_process 영수증 + pending) > 32`로 **run당 프로세스** 수를 센다. 현재 두 값이 우연히 같아 동작은 방어 가능하나, task fan-out 때문에 `maxTasksPerRun`을 조정하면 **프로세스 상한이 조용히 따라 움직인다** | 낮음(상수를 건드릴 때만) | run 전역 spawn 상한이 의도 없이 변경 | 낮음~중 — 나중에 발견하면 어느 상한이 의도였는지 재판정해야 한다 | 소(전용 상수 분리 + 로드맵 문구 정정) | **`LIMITS.maxTasksPerRun` 값을 바꾸기 전, 늦어도 M6 spawn 계층 착수 전** | M6 T1 | Task 3C 독립 리뷰 F3 · 후속 worker 코드 재독 확인 · `orchestrationKernel.ts` `assertSpawnLimits` | **fixed(M6 T1)** — `LIMITS.maxProcessesPerRun` 전용 상수 분리, `assertSpawnLimits`의 run 전역 검사가 이 상수를 쓴다. 두 상수를 **각각** 32→64로 바꾸는 mutation에 **각자의** 테스트만 red(프로세스: `managedProcess.test.ts` run 전역 경계 / task: `orchestrationKernel.test.ts` task 32개 상한), 교차 오염 없음을 실측. 로드맵 §5 문구도 정정 |
| `C-44` | C (P3) | **`assertSpawnLimits`의 `task.depth > LIMITS.maxDepth` 분기는 도달 불가능한 backstop이다.** depth 4 task는 애초에 durable에 존재할 수 없다 — `requestSpawn`이 유일한 생성 경로이고 거기서 `depth_limit_exceeded`로 막으며, `addTask`는 private, `open()`이 `depth.maximum` schema로 재검증한다. 그래서 이 분기는 **production 변경이나 hash chain 위조 없이는 red로 만들 수 없다**(후속 worker가 시도 후 정직하게 보고). 허용 측(depth 3 실제 실행)과 거부 측(`requestSpawn` depth 4 거부)은 둘 다 고정됐고 `requestSpawn` 게이트 제거 mutation으로 red 확인했다 | 낮음 | 없음(방어 심층화) | 없음 | 소(주석으로 unreachable 명시) 또는 state 위조 harness 도입(중) | 없음(bounded backlog) — 늦어도 M6 spawn 계층 착수 전 판단 | M6 T1 | Task 3C 독립 리뷰 F3 · 후속 worker mutation 실측(depth 검사 제거해도 green) | **fixed(M6 T1) — 주석 명시로 종결.** `assertSpawnLimits` doc comment에 depth 분기와 `maxTasksPerRun` 분기가 **도달 불가능한 최후 방어선**임을, 집행되는 경계는 task당 child·run당 프로세스 둘임을 적었다. state 위조 harness는 **도입하지 않는다**(과잉) — 즉 이 두 분기는 여전히 테스트로 red를 만들 수 없고 그 사실을 문서화한 것이 이 항목의 종결이다 |
| `C-45` | C (P3) | **exit code가 0이 아니어도 marker가 `applied`다.** `exit 7`이 `applied` + `exitCode: 7` 영수증을 만든다(테스트가 의도적으로 고정). exit code는 durable에 남아 **정보 손실은 없으나**, 모든 후속 소비자가 `applied ≠ "명령이 성공했다"`를 기억해야 한다 | 중(소비자가 생길 때) | 영수증 해석 1건 | 낮음 | 소(영수증 소비 경계에 문서화) | 첫 영수증 소비자 배선 전 | 다음 slice | Task 3C 독립 리뷰 F5(EXECUTED) · `orchestrationKernel.ts:919-926` | open |
| `C-46` | C (P3) | win32는 spawn을 거부해 **fail closed**이나 Windows에서 검증되지 않았다. 이 저장소는 darwin/linux 대상이라 현 상태로 수용 가능하다 | 낮음 | Windows 사용자 | 낮음 | 소 | 없음 — Windows 지원을 선언할 때 | — | Task 3C 독립 리뷰 F6(STATIC) · `managedProcess.ts:121-123` | open |

> **`B-13` 재확인(승격하지 않는다)**: 독립 리뷰가 코드를 읽고 확인 — 결함은 `StableController.runTask`의
> `finally { provider.stop().catch() }`에 있는데 **프로세스 기반 provider가 아직 배선되지 않았다**
> (`executeRunProcessOperation`/`superviseProcess`는 kernel과 테스트 밖 호출자 0). 새 kernel 경로 자체는
> 순서가 옳다(정리 확인 → 결과 반환 → 영수증). **B 유지 · trigger는 controller 배선 시점에 발화한다.**
> `B-16`은 **미개봉**(typed-write publication 0줄) · `B-10`/`B-11`/`B-12`/`B-17`/`C-1`/`C2` 변화 없음.

##### M5c task 3B 대장 갱신 (2026-08-03 — **독립 리뷰 `APPROVE — A=0, B=1, C=1` · Task 3B 완료 · M5c/M5 미완료 · 이 절이 현행이다**)

> 범위 `8dd05f9..9a34c5d` · fresh Fable 5 read-only 독립 리뷰(구현 worker transcript 미전달).
> 리뷰어는 정적 검토 + `stableController` 58/58 · 회귀 225/225 · `tsc --noEmit` exit 0 ·
> `git diff --name-only`/package·lock diff/skip grep을 **직접 실행**했다. 열린 **A는 0건**이다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `B-17` | B (P1) | **전달 turn이 실패하면 `failDeliveryAttempt()`를 부르지 않아 `activeAttemptId`가 durable에 남는다.** `beginDeliveryAttempt()`는 `provider.send()` 전에 커밋되는데 send가 던지면 예외가 바깥 catch로 빠져 attempt를 닫지 않고 `nextAttemptAt`도 잡지 않는다 | 중 — 전달 실패가 나는 모든 run | 미정산 delivery attempt 1건이 durable에 잔존. **교착은 아니다** — `beginDeliveryAttempt`(`orchestrationKernel.ts:3091~3137`)는 기존 `activeAttemptId`를 거부하지 않고 덮어쓰며 `attempts < maxDeliveryAttempts`와 deadline만 본다. `acknowledgeDelivery`(:2041)도 active attempt만 요구해 충족된다 → 후속 retry 경로가 마이그레이션 없이 복구 가능 | 낮음 — 지금은 무인 advance가 없어 사람이 run을 다시 만든다 | 소~중(실패 경로에 `failDeliveryAttempt` + backoff 배선) | **M5c autopilot(무인 advance) 착수 전** — 기존 `C-12→B` 게이트와 같은 trigger이며 이 행이 durable shape 잔존이라는 새 국면을 추가한다 | M5c autopilot 구현 세션 | Task 3B 독립 리뷰 F-1(STATIC · kernel 코드 확인 · 복구 경로는 추론이며 미실행) · `stableController.ts` 전달 루프 · `orchestrationKernel.ts:3091`·`:2041` | open |
| `C-43` | C (P3) | `stableController.ts:785` `const startedIds = plannedIds` — 그 시점 task는 `prepared`일 뿐인데 이름이 `started`이고, outcome 루프와 blocked 반환이 그대로 재사용한다. 동작은 정확하고 가독성 위험만 있다 | 낮음 | 후속 세션의 오독 | 낮음 | 소(변수명) | 없음(bounded backlog) — 늦어도 autopilot CLI 착수 전 | 후속 M5c 세션 | Task 3B 독립 리뷰 F-2(STATIC) | open |

> **재확인만 하고 새 항목으로 열지 않은 것**: `B-11`(무인 advance 전 per-task preflight — Task 3B가
> `running` 승격을 없애 오히려 좁혔다) · `B-12`(재시작 예산 회계 — controller 토큰/경과 예산은 여전히
> in-memory 카운터이고, kernel의 durable `budget_elapsed_exhausted`가 커밋 시점에 별도로 걸린다.
> 리뷰 판정: 표면이 늘지 않았고 기존 게이트 그대로) · `B-F1`(**미개봉 · spawn 0 유지**) ·
> `B-16`(**미개봉 · typed operation dispatch 0**) · `C-1` · `C2`.
> 실패 task가 `prepared`/`running`/`cleaning`에 남는 것은 **fail-closed**(조용한 전진 0 · 중복 외부
> 효과 0 · 데이터 손실 0)이며 `B-11`/`B-17` 배선으로 복구 가능하다 — 교착이 아니라 유예다.

##### M5c task 3A **6차 리비전** 대장 갱신 (2026-07-31 — **독립 재리뷰 `APPROVE — A=0, B=2, C=3` · Task 3A 완료 · M5c/M5 미완료 · 이 절이 현행이다**)

> **범위 경고**: 이 리비전은 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰
> (`7d3f547..e88c1ca` · `/private/tmp/m5c-task3a-revision5-codex-review-output.txt` ·
> 판정 **`REVISE — A=1, B=2, C=3`**)의 **Category A 1건**을 닫고 C 문서 정정을 했다.
> **M5c 완료 선언이 아니다.** managed process supervisor·자손 정리 · trusted Git ·
> **`StableController` 재작성/배선** · managed launcher · 첫 spawn · 구조화 리뷰 검증 ·
> `autopilot` CLI · legacy 비활성화 · build/dist · M5d는 **미구현·미실행**이다.
> 프로세스 spawn 0 · 네트워크 0 · 신규 런타임/dev 의존성 0 · package·lockfile 변경 0 · live 실행 0 ·
> **다음 DAG task 착수 0**. 코드 커밋 `12fbf08`(시작 HEAD `e88c1ca`).
> 최종 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰
> (`e88c1ca..e0043ef` · 세션 `019fb6d4-cad0-7232-bd2e-a33ca1390362` ·
> `/private/tmp/m5c-task3a-revision6-codex-review-output.txt`)가
> **`APPROVE — A=0, B=2, C=3`**으로 Task 3A를 승인했다. M5c/M5 전체 승인은 아니다.
>
> **직전 절(5차 리비전)의 `A1` 폐쇄는 불완전했다.** 5차는 **bare 회계 공격**만 닫았고, 두 running task가
> **둘 다 genuine permit으로** 같은 run-global turn ID를 claim하는 경로는 그대로였다. 그 절의 `A1` 행은
> "bare 선점"에 한해서만 유효하며, **claim 유일성은 이 절이 닫는다.**
>
> **여전히 열린 미래 게이트**: `B-F1`(managed launcher 첫 소비자·첫 spawn 전) · `B-16`(첫 typed-write
> 산출물 배선 전, 늦어도 M5c 통합) · `C-1`(발행 seam export — **위험 서술 정정**, 아래 행) ·
> `C2`(draft-07 실검증). 전부 **트리거 변경 없이 open**이다.

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| A1(6차) | **A (P1) → fixed** | `issueOperationDispatchPermit()`이 대상 task의 claim과 run 전역 `accounting.chargedTurnIds`만 봤다 → **두 running task가 둘 다 genuine permit으로 같은 turn ID를 claim**할 수 있었다. 공격 순서: ① A가 turn `X` claim ② B도 `X`를 genuine permit으로 claim ③ B가 genuine charge ④ run 전역 `chargedTurnIds` 때문에 A의 genuine charge가 `turn_already_charged`로 실패 ⑤ A는 task-local 과금 증거(`chargedPlanDigest`)를 얻지 못해 `dispatchTurnSettled(A)`가 영구히 false → claim을 정산도 교체도 못 하는 **영구 교착**(양쪽 회계 부패 + run/DAG liveness) | **fixed (2026-07-31, `12fbf08`)** | 원인은 **namespace 폭 불일치**였다(과금은 run 전역 · claim은 task-local). claim namespace를 과금 namespace와 같은 폭으로 맞췄다: ⓐ `assertTurnClaimableBy(state, taskId, turnId)`가 `turnId`를 claim한 **다른 task**를 찾으면 `turn_conflict`로 fail closed하고, permit 발급의 **커밋 전 경로와 커밋 draft 양쪽**에서 돈다(재발급 경로 포함). ⓑ `assertUniqueDispatchClaims()`가 `assertReferentialIntegrity()`에 들어가 **커밋과 store load가 같은 불변식**을 본다 → 손으로 만든 중복 live claim state는 `open()`에서 `invalid_state`다. 보존: 정확히 같은 `(turnId, planDigest)` 멱등 재발급은 **revision·event 0** · 끝난 claim의 lazy replacement · claim 없는 turn의 safety-only bare 회계(`B-12`) · genuine dispatch charging · task-local settlement 전부 그대로다(끝난 남의 claim은 이 검사 앞에서 `turn_already_charged`로 걸린다). 증거: `A1(6차): 두 task가 같은 turn ID를 claim할 수 없다`(genuine 충돌 거부 + revision·event·회계·state 불변 + 멱등 재발급 0-event + **대조군**: 보유자의 과금·grant·실패종결·다음 turn 교체 + sibling 자기 turn claim 성공) · `A1(6차): 손으로 만든 중복 live claim state는 load에서 거부된다`(`validateRunState` 직접 단정 + `open()` fail closed) + mutation(충돌 검사 3곳 제거 → 두 테스트 red, 원복 후 재확인) |
| `B-F1` | B (P1) | managed launcher 첫 소비자·`LaunchRecord.spent` 소비자 부재 | **closed (2026-08-04, Task 3C) — 그 시점 기록이다. 현행 판정은 "task 3C 대장 갱신" 절의 `B-F1` 폐쇄 문단을 본다** | 이 리비전은 launcher·capability 소비자·spawn을 만들지 않았다(spawn 0). **기한: 첫 capability 소비자 또는 첫 spawn 전.** 나머지 항목은 4차 리비전 절의 `B-F1` 행 그대로다 |
| `B-16` | B (P1) | 부재 대상 typed write 발행이 `write_publish_unsupported` | **open — 변화 없음(트리거 유지)** | 발행 경로를 다시 열지 않았다. **기한: 첫 real typed-write 산출물 발행/배선 전, 늦어도 M5c 통합.** 담당·증거는 3차 리비전 절의 `B-16` 행 그대로다 |
| `C-1`(발행 seam export) | C (P2) | shipped 발행 seam setter가 임의 closure를 받고 대상 검사 **이전에** 부른다 | **open — 위험 서술 정정(이번 리비전의 필수 코드 수정 아님)** | **직전 기록의 "성공을 만들 수 없다 / 임의 콜백 공개 API가 없다"는 과대였다**(6차 리뷰 C1). 같은 프로세스에서 ambient 파일 권한을 가진 코드가 `parentWalk` hook 안에서 **승인된 대상 파일을 의도한 바이트로 직접 만들면**, 뒤따르는 hash 비교가 canonical `already_applied`를 돌려줄 수 있다 → 결과는 "실패만 만든다"가 아니라 **canonical 성공 영수증**이다. 다만 이것은 여전히 **진짜 grant + 승인된 경로/내용**을 요구하므로 위조 권위 우회를 되살리지는 않는다. 심각도 **C/P2**. 확률 **낮음**(같은 프로세스 · ambient fs 권한 코드). 영향 반경: in-process operation 1건과 그 canonical 영수증. 유예 비용 **낮음** · 수정 공수 **낮음**(shipped export 정리 슬라이스). **기한: shipped export 정리, 늦어도 M5d handoff.** 담당: typed-execution 유지 담당. 증거: 6차 리뷰 C1 · `orchestrationKernel.ts` seam setter/`parentWalk`/hash 비교 경로. **C 단독으로 리비전 루프를 다시 돌리지 않는다.** |
| `C-1`(pending schema 서술) | C (P3) → **fixed(2차 정정)** | 5차의 정정도 **여전히 과대**였다: pending 재발급 조건을 `attemptedAt === null` + `running` + "만료/예산 게이트"로만 적었다 | **fixed (2026-07-31, `12fbf08`)** | 실제로는 `issueOperationDispatchPermit()`/`beginOperation()`의 **모든 전진·권위 게이트**를 지나야 한다: run 만료·예산 deadline·**토큰 예산·attempt wall·no-progress·durable attempt/turn/계획 신원·그 turn의 권위 있는 과금 증거(`budget_turn_unaccounted`)·preflight drift·claim 유일성**. schema `pendingOperations.description`을 그대로 고쳤다 |
| `C2`(draft-07 실검증) | C (P3) | draft-07 구현으로 적대적 행렬을 실제 검증하지 않았다(구조 대조만) | **open — 변화 없음(트리거 유지)** | 이번에도 validator를 넣지 않았다(신규 의존성 0). **기한: 외부 provider/worker에 schema를 넘기기 전, 늦어도 M5d 계약 handoff.** 담당: schema 유지 담당 |
| `C3`(잘못된 `fable5` 지시 잔존) | C (P3) → **fixed** | 최신 절은 중단을 지시했지만 과거 handoff 2곳에 "다음 task부터 fable5" 문구가 남아 후속 작업의 모델/착수 판단을 오염시킬 수 있었다 | **fixed (2026-07-31, Task 3A 최종 handoff)** | 두 잔존 문구를 모두 폐기 문구로 교체했다. 현행 지시는 **Task 3A 뒤 Codex 중단, 이후는 사용자 별도 지시**다. 증거: 최종 독립 리뷰 C3 · `docs/handoff/CODEX_HANDOFF.md` 전수 검색 |
| A2~A5(5차) · 발행 fail closed · cleanup 우선 · spawn 0 · 정확 재발급 · 단조 진행/시계 · 적대적 manifest · durable uncertain 정합화 | — | 5차까지 닫은 항목 | **closed 유지 — 독립 6차 리뷰가 재확인** | 6차 리뷰 "Other closure checks" 절 · 이 리비전은 해당 경로를 바꾸지 않았고 focused 225/225 통과. **테스트 삭제·완화·skip 0** |

##### M5c task 3A **5차 리비전**(독립 재리뷰 `REVISE A=5·B=2·C=3`) 대장 갱신 (2026-07-31 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록 · 위 절이 `A1`을 정정한다**)

> **범위 경고**: 이 리비전은 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰
> (`20530b0..7d3f547` · 세션 `019fb685-3f2f-7512-aa13-9d12f3e47585` ·
> `/private/tmp/m5c-task3a-revision4-codex-review-output.txt` · 판정 **`REVISE — A=5, B=2, C=3`**)의
> **Category A 5건**을 닫고 인접 C를 처리했다. **M5c 완료 선언이 아니다.** managed process supervisor·
> 자손 정리 · trusted Git · **`StableController` 재작성/배선** · managed launcher · 첫 spawn ·
> 구조화 리뷰 검증 · `autopilot` CLI · legacy 비활성화 · build/dist · M5d는 **미구현·미실행**이다.
> 프로세스 spawn 0 · 네트워크 0 · 신규 런타임/dev 의존성 0 · package·lockfile 변경 0 · live 실행 0 ·
> **다음 DAG task 착수 0**. 코드 커밋 `de59348`(시작 HEAD `7d3f547`). 증거·미실행 목록의 정본은
> `docs/WORKLOG.md` 최상단 블록이다. 이 세션은 **self-approve하지 않는다.**
>
> **직전 절(4차 리비전)의 과대주장을 정정한다.** 아래 "4차 리비전" 절의 `A1`~`A3` 행은 **fixed로 적혔지만
> 재리뷰가 셋 다 불완전 — blocking으로 되돌렸고, 새로 A 2건을 더 찾았다**:
> ⓐ `A1 fixed`("효과 게이트를 per-task 증거로 옮겼다")는 **효과 승인만** 막았다. `chargeTurnUsage`는
> 여전히 caller-selected `{taskId, turnId}`를 받고 중복 namespace가 run 전역이었으므로, sibling이 생산
> task의 **claim된 turn ID를 0 토큰으로 선점**해 ① 생산 task의 진짜 사용량을 **영구히 과금 불가**로 만들고
> ② `dispatchTurnSettled`가 run 전역 turn ID를 정산 권위로 봤기 때문에 **거짓 정산 위에서 claim 교체**를
> 열 수 있었다. 그 테스트는 이것을 "DoS일 뿐"이라고 **명시적으로 단정하고 있었다**(불안전한 assertion).
> ⓑ `A2 fixed`("임의 콜백 표면 삭제")는 콜백만 지웠다. 새로 만든 `src/exec/writeFileEffect.ts`가
> `judgeWriteFile(auth, op)`를 **export**했고 `DispatchAuthority`는 평범한 구조적 interface였으므로,
> 그 모듈을 직접 import하면 **위조 authority 하나로** 파일을 열어 hash하고 디렉터리를 fsync하고 성공
> marker까지 받을 수 있었다(진짜 permit·과금·durable 상태 확인 0). 패키지는 `dist` 전체를 exports map
> 없이 배포하므로 "내부 파일"·이름·주석·barrel 누락·TS 가시성은 경계가 아니었다. 또한 permit·grant·
> outcome·진행 채널 등록부가 **모듈 전역**이어서 durable ID가 같은 두 workspace가 서로 교차 과금·교차
> 등록·교차 표시·교차 영수증을 하고 live grant key까지 서로 죽였다.
> ⓒ `A2`의 `attemptedAt` 표시는 순서만 맞췄다 — 표시 커밋은 safety-only라 deadline을 **의도적으로 보지
> 않는데**, 집행기는 표시 **이전**의 판정을 그대로 들고 들어갔다 → 첫 시계 읽기에서 유효했던 deadline이
> 커밋 도중 지나도 효과가 나갔다.
> ⓓ `A3 fixed`(정합화 경로)는 **용량 경계를 빠뜨렸다**: operation은 turn 단위(64), 영수증은 attempt
> 단위(64) 상한인데 `beginOperation`은 동시 pending 용량만 봤으므로, 뒤 turn이 영수증 64건 위에서 65번째
> operation을 열 수 있었고 그 pending은 **어떤 경로로도 닫히지 않는 영구 미아**였다.
> 그 절은 dated history로 보존하고 **현행 판정은 이 절이다.**
>
> **여전히 열린 미래 게이트**: `B-F1`(managed launcher 첫 소비자·첫 spawn 전) · `B-16`(첫 typed-write
> 산출물 배선 전, 늦어도 M5c 통합). 둘 다 **트리거 변경 없이 open 유지**다.

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| A1 | **A (P1) → fixed** | bare 회계(`chargeTurnUsage`)가 **남이 claim한 생산 turn을 선점**할 수 있었고, `dispatchTurnSettled`가 **run 전역 `chargedTurnIds`** 를 정산 권위로 봤다 → ① 생산 task의 진짜 사용량이 영구히 과금 불가(`turn_already_charged`) ② 거짓 정산 위에서 claim 교체 가능. 테스트가 이것을 "DoS일 뿐"이라고 단정 | **fixed (2026-07-31, `de59348`)** | ⓐ `#chargeTurn`의 권위 없는 분기가 **커밋 안에서** `draft.tasks.find(t => t.execution.dispatchTurnId === turnId)`를 보고 `turn_conflict`로 거부한다(자기 이름·남의 이름 모두). 기존 "이 task가 claim을 들고 있으면 permit 필수" 검사는 그대로다. ⓑ `dispatchTurnSettled(task)`가 `accounting`을 **더 이상 보지 않는다** — 정산은 `execution.turnId === 열린 claim` + `execution.chargedPlanDigest !== null` + `chargedPlanDigest === dispatchPlanDigest` + 그 turn의 미확정 0, 즉 **정확히 이 run/task/attempt/turn/계획의 진짜 과금**에서만 나온다. ⓒ claim 없는 turn의 safety-only 회계는 그대로 가능하다(대장 `B-12` 유지 — 테스트 ⓔ가 단정). 증거: `A1: bare 회계는 남이 claim한 생산 turn을 선점·정산할 수 없다`(선점 2종 거부 + 회계·revision 불변 + 거짓 정산 거부 + **진짜 생산자 과금 성공** + 미확정 0까지 claim 유지 + 정산 후 교체 + claim 없는 turn 회계 허용) + mutation `MUT-1`(claimant 검사 제거 → red) · `MUT-8+1`(양쪽 layer 제거 → 4차 동작 재현) |
| A2 | **A (P1) → fixed** | permit·grant·outcome·진행 채널 등록부가 **모듈 전역**이고 수신 메서드가 발급 인스턴스를 보지 않았다 → durable ID가 같은 두 workspace가 교차 과금·교차 pending 등록·교차 attempted 표시·교차 영수증 커밋을 하고 **live grant key까지 서로 죽였다** | **fixed (2026-07-31, `de59348`)** | 발급된 모든 handle이 **발급 kernel 인스턴스 자체**를 들고 있고(`PermitRecord.issuer`·`GrantRecord.issuer`·`ProgressChannelRecord.issuer`), 수신 메서드 5종(`chargeDispatchTurnUsage`·`beginOperation`·`recordOperationReceipt`·`failOperation`·`recordProgress`)이 `this`와 **동일 객체인지**(`===`) 본다 — 평범한 durable 문자열 ID는 발급자 신원이 아니다. `LIVE_GRANTS`는 `WeakMap<issuer, Map<pendingKey, …>>`이라 durable ID 충돌이 성립하지 않고 죽은 kernel 항목도 수거된다. grant의 `markAttempted`는 **발급 인스턴스의 private 전이**를 부르는 클로저이므로 집행은 발급 kernel의 state로만 작용한다. **같은 workspace의 두 번째 인스턴스도 남이다**(명시적 결정 — DECISIONS 2026-07-31 결정 2): 권위는 durable 경로로만 넘어간다(정확한 `(turn, 계획)` permit **커밋 없는** 재발급 / handle-free `reconcileUncertainOperation`). 증거: `A2: 진짜 handle은 발급 kernel 인스턴스에만 통한다`(**바이트 동일 durable ID 두 workspace** — 교차 과금·등록·실패종결·live key·표시·영수증·채널 8종 + 같은 issuer 정상 동작 대조군) · `A2: 같은 workspace의 두 번째 인스턴스도 남이다`(거부 4종 + durable 재발급 경로 성공) + mutation `MUT-2`(issuer 검사 제거 → red 2건) · `MUT-3`(live key 전역 공유 → `dispatch_grant_spent`) |
| A3 | **A (P1) → fixed(파일 삭제)** | `src/exec/writeFileEffect.ts`가 `judgeWriteFile(auth, op)`를 **export**했고 `DispatchAuthority`는 위조 가능한 구조적 interface였다 → 직접 import로 진짜 permit·과금·durable 확인 **없이** 선택 파일을 열어 hash하고 디렉터리를 fsync하고 성공 marker를 받을 수 있었다. `dist` 전체 배포 + exports map 부재 | **fixed (2026-07-31, `de59348`) — 이름 변경·`@internal`·barrel 제외가 아니라 파일 제거** | 파일 시스템 집행기를 **kernel 모듈 안 사설 함수**(`judgeWriteFile`/`judgeWriteTransaction`/`walkParents`/`confirmDirDurability` — export 없음)로 옮기고 `src/exec/writeFileEffect.ts`를 **삭제**했다. 이제 grant 등록부와 효과 코드가 같은 모듈에 있으므로 유일한 진입점은 **진짜 grant를 요구하는** `executeWriteFileOperation()`이다. 남은 export는 부수 효과 0인 순수 권위 판정(`resolveApprovedOperation`/`resolveWriteAuthority` — 호출자가 준 manifest를 되비추기만 하고 파일을 열지 않는다) · 안정 코드 목록(`WRITE_EFFECT_CODES`) · 테스트 seam이다. 런타임 순환 없음(`typedExecution → kernel` 한 방향). 보존 확인: 임의 콜백 0 · A4 발행 fail-closed · B1 정리 우선 · 신규 의존성/helper 0 · `run_process` 성공 집행기 부재. 증거: `A3: 위조 authority로 파일 시스템 효과에 도달하는 import 표면이 없다`(**helper 모듈 import가 `ERR_MODULE_NOT_FOUND`** + kernel/facade **모든 함수 export**를 위조 authority로 두 인자 순서 호출 → 성공 marker 0·inode·바이트·목록 불변 + 진짜 경로 대조군) + mutation `MUT-4`(집행기 재 export → red) |
| A4 | **A (P1) → fixed** | `executeWriteFileOperation`이 권위를 한 번 읽고, deadline을 **의도적으로 보지 않는** safety-only `attemptedAt` 커밋을 한 뒤, **그 옛 판정으로** 집행기에 들어갔다 → 첫 시계 읽기에서 유효했던 deadline이 커밋 도중 지나도 효과가 나갔다(이전 테스트는 **정지한 시계**의 등호만 봤다) | **fixed (2026-07-31, `de59348`)** | 순서를 `진입 자격 → 표시 커밋 → 일회용 소진 → **권위 전수 재확인** → 집행기`로 바꿨다. 재확인이 거부하면 파일 효과 0 · 영수증 0 · 거짓 성공 0이고, pending은 보수적으로 "시도됐을 수 있다"로 남아 재발급(`operation_attempt_uncertain`)도 평범한 실패도 거부되며 **`reconcileUncertainOperation`의 `outcome_unknown`으로만** 닫힌다. 증거: `A4: 표시 커밋 도중 deadline을 넘으면 집행기에 들어가지 않는다`(표시 커밋 직후 정확히 경계로 넘어가는 clock으로 **만료·예산 deadline·attempt wall·no-progress 등호 4종** + 각 경계 **1ms 전 성공 대조군** + 영수증 0 + 재발급·실패 종결 거부 + `outcome_unknown` + 바이트·목록 불변) + mutation `MUT-5`(재확인 제거 → 만료 등호에서 `already_applied`) |
| A5 | **A (P1) → fixed** | operation은 turn 단위(64) · 영수증은 attempt 단위(64) 상한인데 `beginOperation`이 **동시 pending 용량만** 봤다 → 뒤 turn이 영수증 64건 위에서 65번째 operation을 열 수 있었고, 영수증 커밋·handle-free 정합화가 둘 다 상한에서 거부되는데 attempt 이탈 전이는 전부 pending 0을 요구하므로 **영구 미아 + 영구 stall** | **fixed (2026-07-31, `de59348`)** | 새 pending마다 **영수증 자리를 먼저 예약**한다: 불변식 `operationReceipts.length + pendingOperations.length <= LIMITS.maxOperationReceipts`를 **커밋(`beginOperation`)과 store load**가 함께 본다. 정확한 재발급(기존 eligible pending)은 커밋 밖에서 반환되므로 **두 번째 자리를 쓰지 않는다**. 수락된 pending은 재시작·만료·cleaning·집행기 예외에서도 닫을 자리를 유지한다. 증거: `A5: 영수증 용량을 먼저 예약한다`(`cap-1` 영수증 + pending 1 → 정합화 성공 / 다음 turn의 operation 65 → **pending·revision·`events.jsonl` 전부 불변**으로 `operation_limit_exceeded` / cleanup·settle 정상) · `A5: 상한을 넘긴 pending+영수증 조합은 load에서 거부된다` + mutation `MUT-6`·`MUT-7`·**`MUT-6+7`**(양쪽 제거 시 operation 65가 실제로 열린다 = 미아 재현) |
| `B-F1` | B (P1) | managed launcher 첫 소비자가 현재 권능을 그대로 실행 권위로 믿으면 안 된다 | **closed (2026-08-04, Task 3C) — 그 시점 기록이다. 현행 판정은 "task 3C 대장 갱신" 절의 `B-F1` 폐쇄 문단을 본다** | 이 리비전은 launcher·capability 소비자·spawn을 만들지 않았다(spawn 수 0). 심각도·확률·영향·rework·공수·**기한(첫 capability 소비자 또는 첫 spawn 전)**·담당·증거는 4차 리비전 절의 `B-F1` 행 그대로다 |
| `B-16` | B (P1) | typed write가 새 파일을 만들지 못한다(A4 fail-closed의 직접 결과) | **open — 변화 없음(트리거 유지)** | 발행 경로를 다시 열지 않았다. A3의 파일 이동은 발행 계약을 **바꾸지 않았다**(`write_publish_unsupported` 그대로 · 부작용 0). **기한: 첫 real typed-write 산출물 발행/배선 전, 늦어도 M5c 통합.** 담당·증거는 3차 리비전 절의 `B-16` 행 그대로다 |
| `C-1`(pending schema 서술) | C (P3) → **fixed(주장 정정)** | pending schema가 "재시작하면 무조건 handle-free 경로"라고 적었다 — 실제로는 **재시작한 `running` kernel도** `attemptedAt: null`이면 새 permit을 받아 grant를 재발급할 수 있고, handle-free 경로가 **필수인 것**은 attempted·cleaning·전진 게이트 폐쇄 경우다 | **fixed (2026-07-31, `de59348`)** | schema description이 갈림길을 **attemptedAt + task 상태 + 전진 게이트**로 정확히 적는다: (1) `attemptedAt === null` + `running` + 게이트 열림 → 어느 인스턴스든 같은 `(turnId, planDigest)`의 **커밋 없는** permit 재발급 → 새 grant(단, **다른 인스턴스의 옛 handle은 거부** — A2) (2) `attemptedAt !== null` 또는 `cleaning` 또는 게이트 닫힘 → `reconcileUncertainOperation` 필수. A5 교차 불변식도 두 자리(`pendingOperations`·`operationReceipts` description)에 적었다 |
| `C-1`(발행 seam export) | C (P2) | 파일 시스템 판정의 테스트 seam setter가 shipped export다 — 같은 프로세스 코드가 성공할 판정을 **실패로** 바꿀 수 있다(성공은 만들 수 없다) | **open — 위치만 옮겼고 표면은 그대로다(정직 기록)** | 심각도 **C/P2**. 확률 **낮음**(같은 프로세스·같은 파일 권한 전제). 영향 반경: in-process 집행기 판정 1건 — hook이 던진 것은 **전부 `write_failed`로 정규화**되므로 거짓 성공·권한 상승·승인 우회는 불가능하고 남는 것은 DoS다. 유예 비용 **낮음**, 수정 공수 **낮음**(shipped export 정리 슬라이스). A3로 파일이 사라져 seam은 이제 kernel 모듈에서 export된다(표면 개수 동일 · 4종). **기한: shipped export 정리, 늦어도 M5d handoff.** 담당: typed-execution 유지 담당. 증거: `orchestrationKernel.ts` `__setPublicationSeamsForTest` 주석 · `typedExecution.ts` 재수출. **C 단독으로 리비전 루프를 다시 돌리지 않는다.** |
| `C2`(draft-07 실검증) | C (P3) | draft-07 구현으로 적대적 행렬을 실제 검증하지 않았다(구조 대조만 한다) | **open — 변화 없음(트리거 유지)** | 이번에도 draft-07 validator를 넣지 않았다(신규 의존성 0). **기한: 외부 provider/worker에 schema를 넘기기 전, 늦어도 M5d 계약 handoff.** 담당: schema 유지 담당. 증거: 테스트 이름이 "구조적으로 일치한다"이고 헤더가 "draft-07 validator를 실행하지 않는다"를 명시한다 |
| `A4` `B1` `B2`=`B-10` `C1`(재발급 멱등) `C2`(적대적 manifest) | — | 3차 리비전이 닫은 항목 | **closed 유지 — 이 리비전이 재확인했다** | A4: 발행·생성 syscall 0(코드가 파일만 옮겼고 판정 로직은 동일 · `write_publish_unsupported` 테스트 유지) · B1: temp/unlink/truncate 부재 + 정리 실패 우선 · B2: opaque 권능(spawn 0) · C1: 정확한 재발급이 **커밋 없이** 멱등(A2 두 번째 인스턴스 테스트가 `revision` 불변으로 재확인) · C2: descriptor 기반 단일 입양 |
| `B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B` | B (P1) | live 게이트와 lifecycle 잔여 | **open — 변화 없음** | live 실행 0이고 controller·프로세스 계층을 건드리지 않았다. `stableController.test.ts`는 **3 pass / 55 fail**(이번 변경 전후 동일 · 실패 55건 전부 `manifest_pre_m5c_unsupported` = 다음 DAG task 범위) |
| `C-5` `C-18` `C-19` `C-26` `C-29` `C-30` `C-31` `C-33` `C-34` `C-35` `C-36` `C-37` `C-38` `C-39` | C | 이 리비전이 손대지 않은 나머지 | **변화 없음** | 프로세스 감독자 · 리뷰 검증 · trusted Git · outcome 단일 출처 · seam provenance · store 발행 내부 · pathname TOCTOU 잔여는 이 리비전의 소유 범위 밖이었다 |

##### M5c task 3A **4차 리비전**(독립 재리뷰 `REVISE A/P1=3`) 대장 갱신 (2026-07-31 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록 · 위 절이 이를 정정한다**)

> **범위 경고**: 이 리비전은 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰
> (`2956ffc..20530b0` · 세션 `019fb648-ae3a-7252-ada5-e23edd37770a` ·
> `/private/tmp/m5c-task3a-revision3-codex-review-output.txt` · 판정
> **`REVISE — A/P1 = 3; A4/B1/B2/C1/C2 closed; future B-F1·B-16 remain`**)의 **A 3건**을 닫고
> 인접 문서·schema 정정(C-1)을 했다. **M5c 완료 선언이 아니다.** managed process supervisor·자손 정리 ·
> trusted Git · **`StableController` 재작성/배선** · 구조화 리뷰 검증 · `autopilot` CLI ·
> legacy 비활성화 · build/dist · M5d는 **미구현·미실행**이다. 프로세스 spawn 0 · 네트워크 0 ·
> 신규 런타임/dev 의존성 0 · package·lockfile 변경 0. 코드 커밋 `5ec0a57`(시작 HEAD `20530b0`).
> 증거·미실행 목록의 정본은 `docs/WORKLOG.md` 최상단 블록이다. 이 세션은 **self-approve하지 않는다.**
>
> **직전 절(3차 리비전)의 과대주장을 정정한다.** 아래 "3차 리비전" 절의 `A1`~`A3` 행은 **fixed로 적혔지만
> 재리뷰가 셋 다 PARTIAL — blocking으로 되돌렸다**:
> ⓐ `A1 fixed`는 **효과 승인을 run 전역 bare turn ID(`accounting.chargedTurnIds`)로** 했고
> `chargeTurnUsage`가 `{taskId, turnId, 카운트}`를 호출자 선택으로 받았다 → **claim 없는 sibling이
> 생산 task의 turn을 0 토큰으로 과금해 남의 효과를 승인**할 수 있었다. 진행 provenance도 `getTask()`가
> 그대로 돌려주는 **durable lease**였고 seq는 모양만 봤다(재생·역순 통과). 공용 시계 검사가
> `state.updatedAt`을 보지 않아 **safety-only 커밋이 durable 시각을 뒤로 돌릴 수 있었다**.
> ⓑ `A2 fixed`는 **`executeUnderGrant(grant, op, 임의콜백)`을 공개**했으므로 아무 효과도 내지 않는
> 콜백이 진짜 `applied` 영수증을 만들 수 있었고, 첫 효과 뒤 영수증 커밋 전에 grant를 재발급해 **두 번째
> 효과**를 낼 수 있었으며, 부분 외부 효과 뒤의 예외를 `failOperation`이 **평범한 실패로 지웠다**.
> ⓒ `A3 fixed`는 정합화를 **프로세스 메모리 `WeakMap` handle**에 묶어 두었다 → 재시작 뒤
> `cleaning`/만료된 `running` pending은 새 permit도 옛 handle도 없어 **영구 미아**였다.
> 그 절은 dated history로 보존하고 **현행 판정은 이 절이다.**
>
> **여전히 열린 미래 게이트**: `B-16`(typed write 신규 발행 fail closed — 첫 typed-write 산출물 배선 전) ·
> **신규 `B-F1`**(managed launcher 첫 소비자 전). 아래 표에 등록한다.

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| A1 | **A (P1) → fixed** | 생산 turn 회계와 진행 권위가 묶여 있지 않았다: ⓐ 효과 게이트가 **run 전역 bare turn ID**로 승인했고 `chargeTurnUsage`가 caller-selected `{task, turn, 카운트}`를 받았다(claim 없는 sibling이 0 토큰으로 남의 효과 승인) ⓑ 진행 자격이 `getTask()`로 읽히는 durable lease였고 seq 단조성이 없었다 ⓒ 공용 시계 검사가 `state.updatedAt`을 보지 않아 safety-only 커밋이 시각을 되돌려 wall/no-progress 창을 다시 열 수 있었다 | **fixed (2026-07-31, `5ec0a57`)** | ⓐ **과금을 둘로 갈랐다**: `chargeTurnUsage`(권위 없음 — claim이 열려 있으면 `turn_conflict`, `chargedPlanDigest`를 남기지 않는다 · 만료·재시작 뒤 회계는 그대로 가능 → `B-12` 유지)와 신규 `chargeDispatchTurnUsage({permit,…})`(권위 있음 — 신원이 **kernel 발급 permit**에서 나오고 durable `execution.chargedPlanDigest`를 남긴다). 효과 게이트는 이제 **이 task의** `execution.turnId` + `chargedPlanDigest`를 claim된 `dispatchTurnId`/`dispatchPlanDigest`/`attemptId`와 **함께** 본다 → run/task/attempt/turn/계획 전부에 묶인 과금만 효과를 승인한다. store가 `chargedPlanDigest !== null → turnId !== null` 교차 불변식을 load에서도 본다. ⓑ 진행은 `startPreparedTask()`가 발급하는 **brand된 worker 채널**(모듈 사설 `WeakMap` · run/task/attempt/lease 재대조 · **엄격 증가 seq**)로만 들어온다 — 복사한 lease·구조 사본·`Proxy`·재생·역순·sibling 권위 전부 거부, 늦은 진행은 소진된 창을 되살리지 못한다. ⓒ `assertClockSane`이 `now < state.updatedAt`도 거부한다(`#mutate` 하나를 모든 경로가 지나므로 전진·safety-only 공통). 증거: `A1: 생산 turn 과금은 kernel 발급 권위에만…`(sibling 0 토큰 공격 재현) · `A1: 손으로 심은 chargedPlanDigest는 load에서 거부된다` · `A1: 진행은 brand된 단조 worker 채널로만…` · `A1: 시계 역행은 safety-only 커밋에서도 거부된다`(창이 그대로 소진됨) + mutation 3종(MUTATION-1/2/3) |
| A2 | **A (P1) → fixed** | ⓐ 공개 `executeUnderGrant(grant, op, 임의콜백)`이 호출자 반환값을 canonical 성공으로 굳혔다(**효과 없는 성공**) ⓑ 첫 효과 뒤 영수증 커밋 전에 grant를 재발급하면 **두 번째 효과**가 가능했다 ⓒ 부분 외부 효과 뒤의 예외를 `failOperation`이 평범한 실패로 지웠다 | **fixed (2026-07-31, `5ec0a57`)** | ⓐ **임의 콜백 표면 삭제.** grant를 소비해 canonical 성공을 만드는 통로는 operation kind별 고정 진입점 `executeWriteFileOperation(grant, op)` 하나이고, 그 안에서 부르는 집행기도 정적으로 고정된 `writeFileEffect.judgeWriteFile`이다. `run_process`에는 그런 진입점이 **아예 없다**(권능 발급은 순수 판정 · spawn 0). 런타임 순환을 피하려고 파일 시스템 판정을 신규 `src/exec/writeFileEffect.ts`로 갈랐다 — 그 모듈은 kernel을 **`import type`으로만** 참조하므로 방출된 그래프는 `kernel → writeFileEffect` 한 방향이다(**신규 의존성·네이티브 helper 0**). ⓑⓒ **집행 경계 진입을 효과보다 먼저 durable에 적는다**: `PendingOperation.attemptedAt` + safety-only `operation_attempted` event. 표시된 pending은 `beginOperation`이 재발급하지 않고(`operation_attempt_uncertain`) `failOperation`도 거부한다 → `effect(g1) → 재발급 → effect(g2)`와 "부분 효과 뒤 예외 지우기"가 둘 다 닫혔다. 증거: `A2: 임의 콜백으로 성공을 만드는 공개 표면이 존재하지 않는다`(두 모듈 export 전수 + 인자 수) · `A2: 집행이 던진 grant는 성공으로도 '평범한 실패'로도 닫히지 않는다` · `A2: effect(g1) → 재발급 → effect(g2)…` + mutation 3종(MUTATION-4/5/7) |
| A3 | **A (P1) → fixed** | permit·grant·outcome이 전부 프로세스 메모리 `WeakMap`이라, 재시작 뒤 `cleaning` pending은 새 permit을 받을 수 없고(발급은 `running` 요구) 만료·deadline을 넘긴 `running`도 마찬가지이며 옛 handle이 없어 영수증·실패 API 어느 쪽도 부를 수 없었다 → **영구 미아 + attempt 이탈 전이 영구 stall** | **fixed (2026-07-31, `5ec0a57`)** | 신규 `reconcileUncertainOperation({runId, taskId, attemptId, turnId, planDigest, operationId, kind, authorityId, actionId})` — **kernel 발급 handle을 하나도 요구하지 않는다**. durable pending 레코드와 8개 신원을 전수 대조하고(하나라도 어긋나면 거부 · 거부는 pending·영수증·revision을 건드리지 않는다), marker는 **호출자 입력이 아니라 durable 진실에서 파생**된다(`attemptedAt !== null` → `outcome_unknown`, `null` → `failed`). path·resultSha256·exitCode는 항상 `null`이고 "외부 효과가 일어나지 않았다"고 단정하지 않는다. **성공을 만들 입력이 시그니처에 없다.** safety-only라 만료·예산 deadline·`running`/`cleaning` 어디서나 열려 있고, 정합화 뒤 같은 pending 신원의 살아 있는 grant를 그 자리에서 폐기하며, cleanup·settle이 정상 진행된다. 증거: `A3: 재시작 뒤 cleaning pending을…`(새 kernel · 신원 8종 불일치 전수 거부 · settle까지 · 재재시작 동일) · `A3: 만료·deadline을 넘긴 running pending도…` · `A3: 집행 경계에 들어가지 않은 pending은 재시작 뒤 failed로…` + mutation(MUTATION-6) |
| **신규 `B-F1`** | **B (P1)** | **managed launcher 첫 소비자가 현재 권능을 그대로 실행 권위로 믿으면 안 된다** — 지금 `resolveProcessLaunchCapability`는 순수 minting이라 반복 발급되고 사설 `spent` 필드에 소비자가 없다 | **closed (2026-08-04, Task 3C) — 최초 등록 행이며 요건 ①~④의 정본 서술이다. 폐쇄 근거는 "task 3C 대장 갱신" 절을 본다. 잔여 한계는 `B-18`(setsid 탈출)** | 현재 도달 확률: **0**(소비자도 spawn 경로도 없다). 미래 확률: **확실**(소비자가 생기는 순간). 영향 반경: 로컬 프로세스 실행. 유예 비용: **높음**(launcher 통합 뒤에는 재작업). 수정 공수: 중. **요구**: ① 권능을 **정확히 한 번** 소비 ② 소비 시점에 살아 있는 pending/grant 요구 ③ durable 상태 **재독** ④ spawn **직전에** node·entrypoint 두 digest 재검증. **기한/트리거: 첫 capability 소비자 또는 첫 spawn 전.** 담당: managed-launcher 구현자. 증거: 4차 독립 리뷰 B-F1 · `typedExecution.ts` `resolveProcessLaunchCapability`/`LaunchRecord.spent` |
| `B-16` | B (P1) | typed write가 **새 파일을 만들지 못한다**(A4 fail-closed의 직접 결과) | **open — 변화 없음(정직 유지)** | 이 리비전은 발행 경로를 다시 열지 않았다(지시대로 신규 의존성·helper 0). 기한/트리거·담당·증거는 3차 리비전 절의 `B-16` 행 그대로다 |
| ~~`C-42`~~ | C (P2) → **폐기(해소됨)** | 진행 provenance를 kernel brand 스트림 채널로 승격 | **closed (2026-07-31, `5ec0a57`) — 유예가 아니라 구현으로 닫혔다** | 위 A1ⓑ가 이 항목을 그대로 구현했다(brand된 채널 + 단조 seq + attempt/lease 재대조). 3차 리비전 절의 `C-42` 행은 dated history로 남기고 **이 절이 현행**이다 |
| `C-1`(schema·문서 정직성) | C (P3) → **fixed(주장 정정)** | `dispatchTurnId` 서술이 "과금이 claim을 지운다"였고(코드·schema), pending schema가 **존재하지 않는** 재시작 정합화 경로를 주장했으며, schema 대조 테스트 이름이 "동치"라 draft-07 validator를 실행한 것처럼 읽혔다 | **fixed (2026-07-31, `5ec0a57`) — draft-07 validator는 여전히 미추가** | ⓐ `orchestrationTypes.TaskExecution.dispatchTurnId`와 schema description을 **lazy replacement**로 고쳤다(과금은 claim을 지우지 않는다 · 끝난 claim만 다음 turn의 permit 요청이 교체한다). ⓑ pending schema가 실제 경로 2종을 정확히 적는다(같은 프로세스 handle + `attemptedAt === null` → 멱등 재집행 / 그 밖 전부 → `reconcileUncertainOperation` safety-only). ⓒ schema 대조 테스트 4종의 이름을 **"key·enum·상한이 구조적으로 일치한다"**로 바꾸고 헤더에 "draft-07 validator를 실행하지 않는다"를 명시했다. 구 `C2`(draft-07 실검증)는 **기한 그대로 open** |
| `A4` `B1` `B2`=`B-10` `C1`(재발급 멱등) `C2`(적대적 manifest) | — | 3차 리비전이 닫은 항목 | **closed 유지 — 재리뷰가 재확인했다** | A4: pathname 기반 발행·생성 syscall 0(정적 검사) · B1: temp·unlink·truncate 경로 부재, 정리 실패가 1차 오류를 이긴다 · B2: action 계약 닫힘·정규화·root/ownership 결합·opaque 권능(spawn 0) · C1: 정확한 재발급이 커밋 없이 멱등 · C2: descriptor 기반 단일 입양. 이 리비전은 넷 다 건드리지 않았다 |
| `B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B` | B (P1) | live 게이트와 lifecycle 잔여 | **open — 변화 없음** | 이 리비전은 live 실행 0이고 controller·프로세스 계층을 건드리지 않았다. `stableController.test.ts`는 **3 pass / 55 fail**(이번 변경 전후 동일 실측 · 다음 DAG task 범위) |
| `C-18` `C-19` `C-26` `C-29` `C-30` `C-31` `C-33` `C-34` `C-35` `C-36` `C-37` `C-38` `C-39` `C-5` | C | 이 리비전이 손대지 않은 나머지 | **변화 없음** | 프로세스 감독자 · 리뷰 검증 · trusted Git · outcome 단일 출처 · seam provenance · store 발행 내부는 이 리비전의 소유 범위 밖이었다 |

##### M5c task 3A **3차 리비전**(독립 재리뷰 `REVISE A=4·B=2·C=3`) 대장 갱신 (2026-07-31 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록 · 위 절이 이를 정정한다**)

> **범위 경고**: 이 리비전은 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰
> (`16cdc87..2956ffc` · 세션 `019fb5fb-89ec-7e40-90a9-4a4e7e66d3c2` ·
> `/private/tmp/m5c-task3a-revision2-codex-review-output.txt` · 판정 **`REVISE — A=4, B=2, C=3`**)의
> **A 4건 · B 2건 · 인접 C 3건**을 닫았다. **M5c 완료 선언이 아니다.** managed process supervisor·자손
> 정리 · trusted Git · **`StableController` 재작성/배선** · 구조화 리뷰 검증 · `autopilot` CLI ·
> legacy 비활성화 · build/dist · M5d는 **미구현·미실행**이다. 프로세스 spawn 0 · 네트워크 0 ·
> 신규 런타임/dev 의존성 0 · package·lockfile 변경 0. 코드 커밋 `d4a6596`(시작 HEAD `2956ffc`).
> 증거·미실행 목록의 정본은 `docs/WORKLOG.md` 최상단 블록이다. 이 세션은 **self-approve하지 않는다.**
>
> **직전 절(2차 리비전)의 과대주장을 정정한다.** 아래 "2차 리비전" 절의 `A1`~`A4`·`B1`·`B-10` 행은
> **그 시점의 A 목록에 대해서만** 사실이었고 재리뷰가 낸 다른 A 목록에 대해서는 부정확했다:
> ⓐ `A1 fixed`는 **생산 turn을 과금하기 전에 효과가 나갔다**(예산 판정이 항상 한 turn 뒤처짐) ·
> 늦은 `recordProgress`가 소진된 창을 되살렸다 · 시계 역행이 durable 기록에 대해 막히지 않았다
> ⓑ `A2 fixed`는 같은 pending에 **살아 있는 grant를 여러 개** 냈고 `recordOperationReceipt`가
> **호출자가 만든 구조적 영수증**을 받았으며 `resolveProcessLaunchSpec`이 **spawn 없이** 성공 자격을
> 만들었다 ⓒ `A3 fixed(예방)`는 교체만 막았고 **신규 발행의 최종 pathname 창은 그대로**였다
> ⓓ `B1 fixed`는 unlink/truncate durability와 1차 오류의 정리-실패 은폐를 닫지 못했다
> ⓔ `B-10 fixed(하드 게이트 해제)`는 **과장이었다** — `data: string[]`에는 action별 의미가 없었고
> `ProcessLaunchSpec`은 공개 구조적·재생 가능 값이었다. 그 절은 dated history로 보존하고
> **현행 판정은 이 절이다.**

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| A1 | **A (P1) → fixed** | 생산 turn 사용량이 효과 뒤에 과금돼 예산 판정이 stale이었고, 늦은 진행이 소진된 attempt를 되살렸으며, 시계 역행이 durable 기록에 대해 막히지 않았다 | **fixed (2026-07-31, `d4a6596`)** | 순서를 계약으로 만들었다: **permit(claim) → `chargeTurnUsage` → grant → 효과**. 효과 게이트가 `accounting.chargedTurnIds.includes(turnId)`를 요구한다(신규 `budget_turn_unaccounted`). 과금과 turn 닫기를 **분리**했다 — 과금해도 claim은 살아 있고(그 계획의 grant·영수증 경로 유지) **끝난 claim**(과금 + 미확정 0)만 다음 turn의 permit 요청이 교체한다(지연 해제 → operation 0건 turn·부분 집행 turn 모두 교착 없음). `recordProgress`는 효과 게이트와 **같은 등호 규칙**으로 `no_progress_exhausted`·`attempt_wall_exhausted`를 먼저 보고, provenance로 attempt `processLeaseMarker` + worker `{kind:"progress",seq,step}` 닫힌 읽기를 요구한다. 전진 시각은 `state.updatedAt`(모든 durable 시각의 상한)에 대해 **단조**여야 한다. 증거: `typedExecution.test.ts` `A1: 토큰 등호…`(등호 + 1 토큰 남은 대조군 + 늦은 진행 거부 + 경계 안 진행 인정 + provenance 6종) · `lifecycle…ⓒⓓ`(과금 전 grant = `budget_turn_unaccounted` · 과금 후 열림) · `A1: durable turn이 null인 동안…`(미과금 claim·미확정 claim이 다른 turn을 막는다) + mutation 2종(과금 요구 제거 / 늦은 진행 거부 제거) |
| A2 | **A (P1) → fixed** | 같은 pending에 **살아 있는 grant가 여러 개**였고, 영수증이 **호출자 구조체**였으며(marker·path·hash·exit 위조), spawn 없는 프로세스 계획이 성공 자격을 만들었고, durable 영수증·event에 attempt/turn/plan binding이 없었다 | **fixed (2026-07-31, `d4a6596`)** | ⓐ 모듈 사설 `LIVE_GRANTS` map — durable pending 신원당 **살아 있는 grant 하나**이고 새 발급이 이전 것을 **그 자리에서 폐기**한다(재시작 정합화는 그대로 된다). ⓑ `consumeExecutionGrant` **export 삭제** → `executeUnderGrant(grant, op, effect)`: 진입 일회용, `effect`가 **정상 반환**할 때만 canonical 결과를 grant 안에 굳혀 opaque handle을 낸다(던지면 `errored` → 성공 불가). ⓒ `recordOperationReceipt({outcome})`가 **저장된 canonical 결과**를 적고 호출자 필드를 채택하지 않는다. 집행하지 않은/실패한 operation은 신규 `failOperation({grant, marker: denied\|failed})`로만 닫힌다. ⓓ `resolveProcessLaunchCapability`는 **순수 판정**이라 grant를 소진하지 않는다 → spawn 없는 계획이 성공을 만들 통로가 없다. ⓔ 영수증·`dispatch_claimed`/`operation_began`/`operation_receipt`/`usage_charged` event에 attemptId·turnId·**planDigest**를 durable하게 남긴다. 증거: `A2:` 5개 테스트(구조적 위조 7종 · 필드 치환 불가 · **live/live 중복** · 미시도 성공 불가 · effect 예외) + mutation(grant 폐기 제거) |
| A3 | **A (P1) → fixed** | 영수증 커밋이 전진 게이트를 지나 만료·deadline·`cleaning` 뒤에는 **정합화 자체가 불가능**했고, 그 pending을 남긴 채 attempt를 떠날 수 있어 다음 preflight·resume이 조용히 지웠다 | **fixed (2026-07-31, `d4a6596`)** | 영수증 정합화가 **safety-only 전이**가 됐다(신규 `requireReconcilableTask` — `running\|cleaning`만 허용하고 run/task/attempt/turn/계획/kind/authority를 전수 확인하되 만료·예산·wall·no-progress·preflight drift는 보지 않는다). attempt를 **떠나거나 리셋하는** 전이 전부(`commitPreflightBatch(prepared)`·`pauseTask`·`resumeTask`·`settleCleanedAttempt`)가 공용 `assertNoPendingOperations` 하나를 지난다. 런타임 불변식: pending은 `running\|cleaning`에만 존재하고 각 항목의 attemptId/turnId/planDigest가 `execution.attemptId`/`dispatchTurnId`/`dispatchPlanDigest`와 **정확히 같아야** 한다(커밋과 load 양쪽). schema는 상태 제약을 `allOf`+`if/then/else`로 표현하고 교차 필드 일치는 **런타임 전용**으로 명시했다. 증거: `A2/A3: 효과가 났는데…`(settle·pause·complete 전부 거부 후 pending 유지) · `A3: 영수증 정합화는 만료·deadline·cleaning 뒤에도 가능하다` · `lifecycle…ⓑ`(cleaning 정합화 → settle → 재시작) + mutation 2종 |
| A4 | **A (P1) → fixed(fail closed)** | 최종 `linkSync(temp, target)`가 pathname 기반이라 부모 이름 교체 경쟁으로 **승인 범위 밖 발행**이 가능했고 사후 inode 검증은 통과했으며 fsync는 엉뚱한 디렉터리에 걸렸다 | **fixed (2026-07-31, `d4a6596`) — 발행 경로를 제거했다(기능 축소)** | Node 18/macOS 내장에 디스크립터 상대 no-replace 발행(`linkat`)이 **없고** 이 세션은 신규 의존성·네이티브 helper·자식 프로세스를 만들 수 없다 → 지시대로 **fail closed**: 신규 발행은 `write_publish_unsupported`로 거부하고 **temp도 만들지 않는다**(부작용 0). `process.chdir(parent)` + basename `link`(cwd를 디렉터리 참조로 쓰는 방법)는 **평가 후 채택하지 않았다** — 프로세스 전역 상태이고 worker thread에서 던지며 managed launcher가 자식을 띄우는 순간 자식 cwd까지 오염시킨다(안전을 증명할 수 없다). 남은 안전 경로는 바이트를 만들지 않는 판정뿐이다: `already_applied`(부모 fsync 확인 뒤) · `write_conflict` · `write_replace_unsupported`. 판정 직전 부모 신원 재확인을 추가했다. 증거: `A4: 신규 발행 경로는 도달하지 않는다`(대상·temp 0 · 경쟁자 바이트 불변) · `A4: 부모 이름이 교체돼도…` · `A4: fsync 실패 뒤 재시도…` + mutation(발행 복원 → 6건 red). **기능 결과(정직)**: `applyWriteFile`은 이제 **새 파일을 만들지 못한다** → 아래 신규 `B-16` |
| B1 | **B (P1) → fixed(트리거 전 폐쇄)** | temp unlink 뒤 부모 fsync 없음 · 고아 truncate 뒤 파일 fsync 없음 · 1차 예외가 정리 실패를 은폐 | **fixed (2026-07-31, `d4a6596`)** | A4로 **temp를 만드는 경로가 사라져** unlink durability · 고아 plaintext · truncate 폴백 문제가 **성립하지 않는다**(남길 파일이 없다 — 테스트가 `.m5c-op-` 잔재 0을 단정한다). 남은 정리는 fd 반납뿐이고 실패는 `write_cleanup_unconfirmed`이며, **1차 오류와 동시에 나면 정리 미확인이 이기고 1차 안정 코드를 메시지에 코드로만 싣는다**(복합 처리 — 경로·내용 없음). 증거: `B1: 정리(fd 반납) 실패는 성공이 되지 않고, 1차 오류에 가려지지도 않는다`(진짜 EBADF를 (dev,ino)로 찾아 주입 · 복합 케이스) |
| B2 = `B-10` | **B (P1) → fixed(첫 spawn 전 요구 충족 · spawn 수 여전히 0)** | `data: string[]`에 action별 arity·경로 의미·소유권이 없었고 `ProcessLaunchSpec`이 **공개 구조적·재생 가능** 값이었다 | **fixed (2026-07-31, `d4a6596`)** | ⓐ **action별 입력 계약**: `validate-plan`은 정확히 `{planPath}`이고 런타임이 정규화 항등 · 고립 surrogate 거부 · 코드 포인트 상한 · `writableRoots` 안 · 그 task 승인 ownership 안을 본다(읽기 전용 action이지만 **새 readableRoots 축을 열지 않고 승인된 쓰기 범위 안쪽으로 좁혔다**). ⓑ 공개 `ProcessLaunchSpec` **삭제** → opaque `ProcessLaunchCapability`: 감사용 신원(run/task/attempt/turn/operation/authority)만 표면에 있고 **실행 파일·entrypoint·digest·argv·timeout·planPath는 모듈 사설 레코드에만** 있다. argv 파생 코드도 **삭제**했다(소비자가 없으므로 만들지 않는다 — 미래 launcher가 durable 상태를 다시 읽고 두 digest를 spawn 직전에 재검증하며 만든다). ⓒ 권능 발급이 순수 판정이라 `run_process` pending은 이 슬라이스에서 `denied`/`failed`로만 닫힌다. 증거: `B2:` 2개 테스트(표면에 실행 명세 9종 부재 · 전개 사본/proxy는 진짜 권능 아님 · lifecycle 사망 시 발급 거부 · pending은 실패로만 닫힘) · `B-10: run_process는 --eval…`(옵션 7종 · 실행대상 필드 10종 · action 8종 · data 형태 6종) · `autopilotLifecycle` action-data 계약 9종. **남은 일**: 실제 `controller.mjs` entrypoint와 managed launcher는 **다음 DAG task**다 |
| **신규 `B-16`** | **B (P1)** | **`applyWriteFile`이 새 파일을 발행하지 못한다**(A4 fail-closed의 직접 결과). typed write는 지금 "이미 있는 바이트 확인 + 충돌 판정"만 할 수 있다 | **open (2026-07-31 최초 등록)** | 확률: **확실**(설계상). 영향 반경: typed `write_file` 산출물 생성 전체 — controller 배선이 이 집행기로 파일을 만들려 하면 항상 `write_publish_unsupported`다. 유예 비용: **중** — 배선을 이 계약 위에 먼저 만들면 재작업이지만, 반대로 안전하지 않은 발행 위에 만드는 것이 훨씬 비싸다. 수정 공수: **중**(디스크립터 상대 no-replace 발행 확보 — Node 20+ `fs` 확장 채택 또는 **사람이 승인한** pinned helper. `process.chdir` 우회는 위 A4 사유로 채택하지 않는다). **기한/트리거: typed `write_file`로 실제 산출물을 만드는 첫 배선 전(늦어도 M5c 통합)**. 담당: **M5c 통합 구현자**. 증거: `typedExecution.ts` `write_publish_unsupported` 주석 · `A4: 신규 발행 경로는 도달하지 않는다` |
| **신규 `C-42`** | C (P2) | 진행 신호 provenance가 **durable lease marker**다 — state 파일을 읽을 수 있는 코드에는 비밀이 아니다. kernel이 brand한 스트림 채널이 더 강하다 | **open (2026-07-31 최초 등록)** | 확률: 낮음(같은 프로세스·같은 파일 권한 전제). 영향 반경: no-progress 시계 1건(소진된 창은 이미 되살아나지 않으므로 **deadline 우회는 불가능**하다 — 남는 것은 "살아 있는 attempt의 창을 남이 연장"뿐). 유예 비용: 소. 수정 공수: 중(스트림 수용 계층이 필요하다). **기한: controller가 worker 스트림을 실제로 소비하는 배선 task**. 담당: M5c controller 구현자. 증거: `recordProgress` 주석 + `A1 … provenance` 테스트 |
| `C1`(permit 재발급 멱등) | C (P2) → **fixed** | 정확히 같은 claim의 재발급이 매번 `dispatch_claimed`를 커밋해 bounded revision·event 용량을 소모했다(문서는 "멱등"이라 적었다) | **fixed (2026-07-31, `d4a6596`)** | durable `dispatchTurnId`+`dispatchPlanDigest`가 이미 그 값이면 **커밋하지 않고** 새 봉인 permit만 낸다. 그래서 **이미 과금된 turn이라도 claim이 열려 있으면** 정합화용 permit을 다시 받을 수 있다. 증거: `permit 발급은 durable 신원…`(revision·`events.jsonl` 줄 수 불변 · 4회 반복). **직전 판의 `rev + 1` assertion이 결함을 고정하고 있었으므로 교체했다**(완화 아님 — 전수 기록은 WORKLOG) |
| `C2`(적대적 manifest 객체) | C (P3) → **fixed** | `asObject`/`closedKeys`가 호출자 소유 accessor/proxy를 **여러 번** 읽어 교대 getter가 선언 enum 밖 `action`을 반환하게 하거나 trap이 진단 taxonomy를 고를 수 있었다 | **fixed (2026-07-31, `d4a6596`)** | `asObject`가 이미 계획 경계에서 쓰는 정본 `typedPlan.readOwnData`를 재사용한다 → **accessor·`Proxy`·계약 밖 prototype·symbol key 거부**, descriptor `value`만 **한 번** 읽는다(호출자 코드가 실행되지 않는다). 배열도 `readOwnArray` 기반 `asArray`로 통일했다. 신규 검증 의존성 0 |
| `C3`(schema 과대주장·낡은 서술) | C (P3) → **fixed(주장 정정)** | "동치" 주장이 실제보다 넓었고 manifest schema 최상단이 삭제된 `run_process.executable`을, 집행기 헤더가 삭제된 rename 경로를 서술했다 | **fixed (2026-07-31, `d4a6596`) — draft-07 validator는 추가하지 않았다** | 두 schema의 "동치" 문장을 **"구조 대조일 뿐이며 draft-07 구현을 실행하지 않는다"**로 정정하고, 런타임이 더 엄격한 항목(정규화 항등 · 고립 surrogate · 코드 포인트 길이 · 배열 항목 간 유일성 · pending↔attempt/turn/plan 교차 일치)을 각 자리 description에 **런타임 전용**으로 적었다. 낡은 서술 2곳을 고쳤다. 지시대로 **draft-07 구현을 새로 넣지 않았다** → 적대적 corpus 실행은 아래 `C2`(구 항목) 기한 그대로 |
| `C2`(구 항목 — schema/runtime 동치 실검증) | C (P3) | draft-07 구현으로 적대적 행렬을 실제 검증하지 않았다 | **open — 주장만 정정했다** | 기한: **외부 provider/worker에 schema를 넘기기 전, 늦어도 M5d 계약 handoff**. 담당: M5c/M5d schema 유지 담당 |
| `C1`(발행 seam export) | C (P2) | 발행 seam이 export돼 있다 | **open — 표면이 줄었다** | A4로 seam이 4종(`parentWalk`·`targetOpen`·`publish`·`dirFsync`)으로 줄었고 hook 오류는 여전히 `write_failed`로 정규화된다. 기한·담당 변경 없음(shipped export 표면 정리 슬라이스, 늦어도 M5d handoff) |
| `C-5` | C (P2) | 경로 이름 기반 TOCTOU 잔여 창 | **open — 표면이 다시 줄었다(정직 갱신)** | 발행(`link`)·정리(`unlink`)·`rename` 경로가 **전부 사라졌다** → 남는 것은 **읽기 판정**의 pathname 구간뿐이고, 그 구간도 판정 직전 부모 신원 재확인을 지난다. 최악의 경우는 "한순간 승인된 부모 안에 있던 파일에 대한 `already_applied`/`write_conflict` 판정"이며 **바이트를 만들지 않는다**. 기한/담당 변경 없음(디스크립터 상대 API 채택 또는 M10) |
| `C-39` | C (P3) | 정리 영수증 공개 | **부분 해소 유지** | 정리 실패가 조용하지 않고 이제 1차 오류와 **복합**으로 보고된다. 공개 영수증 필드 승격은 그대로 open |
| `C-18` `C-19` `C-26` `C-29` `C-30` `C-31` `C-33` `C-34` `C-35` `C-36` `C-37` `C-40` `C-41` | C | 이 리비전이 손대지 않은 나머지 | **변화 없음**(`C-40`·`C-41`은 fixed 유지) | 프로세스 감독자 · 리뷰 검증 · trusted Git · 중첩 handoff schema · outcome 단일 출처 · seam provenance · ReviewSubject · store 발행 내부는 이 리비전의 소유 범위 밖이었다 |
| `B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B` | B (P1) | live 게이트와 lifecycle 잔여 | **open — 변화 없음** | 이 리비전은 live 실행 0이고 controller·프로세스 계층을 건드리지 않았다. `stableController.test.ts`는 **미실행**(다음 DAG task 범위 · 이 세션은 그 파일을 열지 않았다) |

##### M5c task 3A **2차 리비전**(독립 재리뷰 `REVISE A=4·B=2·C=3`) 대장 갱신 (2026-07-30 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록 · 위 절이 이를 정정한다**)

> **범위 경고**: 이 리비전은 독립 fresh read-only 재리뷰(`/private/tmp/m5c-task3a-rereview-output.txt` ·
> 판정 **`REVISE — A=4, B=2, C=3`**)의 **Category A 4건과 B 2건**을 닫았다. **M5c 완료 선언이 아니다.**
> managed process supervisor·자손 정리 · trusted Git · **`StableController` 재작성/배선** · 구조화 리뷰
> 검증 · `autopilot` CLI · legacy 비활성화 · build/dist · M5d는 **미구현·미실행**이다. 프로세스 spawn 0 ·
> 네트워크 0 · 신규 런타임 의존성 0. 코드 커밋 `cecc529`(시작 HEAD `16cdc87`). 증거·미실행 목록의 정본은
> `docs/WORKLOG.md` 최상단 블록이다. 이 세션은 **self-approve하지 않는다.**
>
> **직전 절의 과대주장을 정정한다.** 바로 아래 "M5c task 3A 리비전" 절의 `A2`/`A3`/`인접 B` 행은
> **그 시점의 A 목록에 대해서만** 사실이었고, 재리뷰가 낸 다른 A 목록에 대해서는 부정확했다:
> ⓐ `A3 fixed`는 **교체 경로의 최종 `renameSync` 창을 `C-5`로 축소 분류**했는데 그것은 실제로 경쟁자 바이트
> 파괴·승인 부모 밖 발행이 가능한 **A**였다 ⓑ `인접 B fixed`는 fsync **재시도**·close/unlink 실패 전파·
> 고아 plaintext temp를 닫지 못했다 ⓒ `A2 fixed`는 permit 위조는 막았지만 **경쟁 turn 공존·구조적 영수증
> 수용·permit 재사용**을 닫지 못했다. 그 절은 dated history로 보존하고 **현행 판정은 이 절이다.**

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| A1 | **A (P1) → fixed** | dispatch 권위가 하나의 turn/계획에 durable하게 묶이지 않았고(caller-turn 선택 · durable turn이 null인 동안 다중 permit) 공개 `getState()`를 지났으며 토큰·wall·no-progress 게이트가 없었다 | **fixed (2026-07-30, `cecc529`)** | `issueOperationDispatchPermit()`이 **커밋**으로 `execution.dispatchTurnId`+`dispatchPlanDigest`를 claim한다(다른 turn=`dispatch_identity_stale` · 같은 turn의 다른 계획=`dispatch_plan_conflict` · 과금된 turn=`turn_already_charged` · 같은 (turn,계획) 재발급은 **멱등**). `chargeTurnUsage()`가 claim을 닫고 `chargedTurnIds`에 남긴다. permit 레코드가 **private `#state`** 를 직접 읽는다(반환 manifest는 사본). 효과·명세 발급 직전마다 `budget_tokens_exhausted`/`attempt_wall_exhausted`/`no_progress_exhausted`를 **등호 포함**으로 본다. 증거: `typedExecution.test.ts` `A1: durable turn이 null인 동안에도…` · `A1: 공개 getState()를 monkey-patch해도…` · `A1: 토큰 등호·attempt wall 등호·no-progress 등호가…`(`steppableClock`으로 정확히 그 밀리초 · +1ms 전 통과 대조군 · 전부 **파일 효과 0**) + mutation 2종(claim 검사 제거 / 토큰 `>=`→`>`) |
| A2 | **A (P1) → fixed** | 영수증이 위조·재생 가능했고 permit이 소비되지 않아 재사용됐으며 집행/결과/재시작이 attempt·turn·계획에 묶이지 않았다 | **fixed (2026-07-30, `cecc529`)** | 신규 `beginOperation()`이 **집행 전에** durable `pendingOperations`(operationId·kind·authorityId·attemptId·turnId·planDigest·beganAt)를 커밋하고 모듈 사설 `WeakMap`의 **일회용 grant**를 발급한다. 효과 게이트가 grant를 소진(`dispatch_grant_spent`)하고 `recordOperationReceipt({grant,…})`가 한 번 소비한다. **성공 marker는 효과 게이트를 지난 grant에서만** 나온다(미시도는 `denied`/`failed`만 — `invalid_receipt`). 미확정 pending이 있으면 `chargeTurnUsage`·완료·차단 전부 `operation_pending_unreconciled`. 재시작은 pending을 보고 같은 operation을 다시 열어 멱등 재집행(`already_applied`) 후 영수증 1건으로 수렴한다. 부수 정정: `RECEIPT_KEYS`에 `at` 추가 — **집행기가 낸 영수증을 그대로 커밋하는 경로가 항상 막혀 있었다**. 증거: `A2:` 4개 테스트(위조 6종·치환 3종·재사용·중복 집행·효과없는 성공·재시작 3단계) + mutation 2종 |
| A3 | **A (P1) → fixed(예방)** | 기존 대상 `renameSync(temp,target)`의 최종 pathname 창에서 경쟁자 덮어쓰기·승인 부모 밖 발행이 가능했다(사후 탐지뿐) | **fixed (2026-07-30, `cecc529`) — 교체 자체를 제거했다** | Node 18에 디스크립터 상대 compare-and-publish가 없으므로 **창을 없애는 대신 도달하지 않게** 했다: 대상이 존재하고 내용이 의도와 다르면 **temp 생성 이전에** `write_replace_unsupported`. `renameSync` 발행 경로 **삭제**(import까지). 발행은 부재 대상 `link(2)` no-replace뿐이다. **네이티브 primitive·런타임 의존성 추가 0**(승인 대상이므로 이 슬라이스 밖). 증거: `A3:` 2개 테스트(교체 거부 시 **tempCreate/publish seam 미도달** 단정 · 바이트·inode 불변 · temp 잔재 0) + mutation(`targetExists` 거부 제거 → 2건 실패) |
| A4 | **A (P1) → fixed** | 디렉터리 fsync 실패 후 재시도가 **fsync 없이** `already_applied`를 돌려줘 거짓 durability를 증명했다 | **fixed (2026-07-30, `cecc529`)** | `before === intended` 경로도 `confirmDirDurability(dirFd)`를 지나야 한다. 계속 실패하면 계속 `write_durability_unconfirmed`다. 증거: `A4: fsync 실패 뒤 재시도는 fsync를 다시 시도하고…`(재시도의 fsync 호출 수를 세어 **1회 이상** 단정 · 성공해야 `already_applied`) + mutation. **리뷰가 지적한 대로 옛 assertion이 결함을 고정하고 있었으므로 교체했다**(완화 아님 — 전수 기록은 WORKLOG) |
| B1 | **B (P1) → fixed(트리거 전 폐쇄)** | close/unlink 실패 삼킴 · no-replace 분기의 조기 소유권 해제 · 부모 이름 교체 시 **승인 내용이 담긴 고아 plaintext temp** | **fixed (2026-07-30, `cecc529`)** | 정리 실패를 `status.cleanupFailed`로 모아 신규 `write_cleanup_unconfirmed`로 올린다(성공 영수증 0). 소유권은 `finally`가 unlink를 확인할 때까지 유지한다. pathname으로 지울 수 없으면 남의 파일을 지우지 않고 **소유 fd로 `ftruncate(0)`** → 남는 파일이 **0바이트**·0600·미참조다. temp 이름은 `sha256(run|task|attempt|turn|operation)` 파생(`.m5c-op-<16hex>-<24hex>.tmp`)이라 sweep이 **안전하게 귀속**한다. durable pending 레코드가 정합화 신원이다. **발행 뒤에는 truncate하지 않는다**(temp fd와 대상이 같은 inode). 증거: `B1: 실제 close/unlink 실패는…`(부모 `chmod 0500` = 진짜 EACCES · temp fd를 (dev,ino)로 찾아 미리 close = 진짜 EBADF) · 부모 symlink 교체 테스트가 **0바이트·이름 패턴**을 단정 + mutation |
| `B-10` | **B (P1) → fixed(하드 게이트 해제)** | `run_process`가 승인된 Node + 자유 argv라 `--eval`/`--require`/임의 script로 임의 로컬 코드 권위였다 | **fixed (2026-07-30, `cecc529`) — 첫 spawn 전 요구 충족. 이 리비전의 spawn 수는 여전히 0** | `executionAuthority.controllerEntrypoint`(**digest 고정** 절대경로) 필수 추가. 승인 operation 레코드에서 `executable`·`args`를 **삭제**하고 닫힌 `action` enum(`CONTROLLER_ACTIONS = ["validate-plan"]`)과 **데이터 전용** `data`만 남겼다 — data는 NUL·고립 surrogate 없고 **`-`로 시작할 수 없다**(`operation_data_not_approved`). argv는 `ProcessLaunchSpec`이 `[entrypoint, action, ...data]`로 **파생**하며 만들 다른 통로가 없고, argv[1]이 절대경로 script이므로 Node 옵션 자리 자체가 없다. 명세에 `entrypoint`/`entrypointSha256`/`action`을 실어 spawn 직전 재검증이 가능하다. shell·env·cwd·network·remote는 여전히 **표현할 필드가 없다**. 증거: `B-10: run_process는 --eval·--require·임의 script/module·action 주입을 표현할 수 없다`(옵션 7종 · 실행대상 필드 10종 · action 8종 · NUL/surrogate/상한 · v1 manifest fail-closed · digest 실림 · **승인 경로가 존재하지 않는데도 명세가 나온다 = spawn 0**) + mutation. **남은 일**: 실제 `controller.mjs` entrypoint 구현과 managed launcher는 **다음 DAG task**다 |
| **`C-41`** | C (P2) → **fixed** | `executionBoundary.test.ts`가 v1 manifest fixture라 시작 HEAD부터 red(1/20) | **fixed (2026-07-30, `cecc529`)** | 이번 manifest 계약 변경이 그 파일을 직접 건드리므로 범위 안이다. fixture를 v2로 갱신(`node`/`processObserver`/`controllerEntrypoint` + `autopilotPolicy` + `operationAuthorityByTask`) → **20/20**. 빈 객체 manifest의 기대 코드를 `invalid_manifest` → `manifest_pre_m5c_unsupported`로 정정(둘 다 hard reject · 완화 아님) |
| `C-38` | C (P3) → **kernel 행도 fixed** | 호출자 getter/proxy가 던진 `OrchestrationError`가 그대로 나가 **production taxonomy를 고를 수 있었다** | **fixed (2026-07-30, `cecc529`)** | `readClosedOnce`가 우리 오류만 `try` 밖에서 던지고 **호출자 예외는 종류 불문** `invalid_artifact_ref`로 접는다. 영수증 커밋이 이제 신뢰 경계이므로 이 행을 여기서 닫았다. 증거: `적대적 객체·proxy·accessor는 lifecycle을 우회하거나 오류 taxonomy를 고를 수 없다`(던지는 getter · `ownKeys` trap · 적대적 permit/grant · 적대적 계획) |
| `C1`(발행 seam) | C (P2) | 발행 seam이 export돼 있고 hook 오류가 production taxonomy를 골랐다. 과거 문서의 "module-private" 서술은 **거짓이었다** | **부분 fixed — 위험 축은 닫았고 export는 남았다(정직 기록)** | hook이 던진 것은 **종류 불문 `write_failed`** 로 정규화된다 → 호출자 코드 선택 불가(테스트가 그 계약을 단정). **export는 남겼다**: 결정론적 경쟁·fault 재현에 현행 대안이 없고 같은 슬라이스에서 하네스를 분리하면 A/B 검증이 흔들린다. 확률: 낮음(같은 프로세스에서 실행 중인 코드에 파일 시스템 권위를 **추가하지는 않는다**). 영향 반경: production 가용성·진단 무결성. 유예 비용: 소. 수정 공수: 소. **기한: shipped export 표면을 정리하는 다음 슬라이스, 늦어도 M5d handoff**. 담당: M5c 통합 구현자 |
| `C2`(schema/runtime 동치) | C (P3) | draft-07 구현으로 적대적 행렬을 실제 검증하지 않았다 | **open — 이번에 손대지 않았다. 동치라고 다시 주장하지 않는다** | 기한: **외부 provider/worker에 schema를 넘기기 전, 늦어도 M5d 계약 handoff**. 담당: M5c/M5d schema 유지 담당 |
| `C-5` | C (P2) | 경로 이름 기반 TOCTOU 잔여 창 | **open — 표면이 줄었다(정직 갱신)** | `rename(2)` 발행 경로가 **사라졌으므로** ⓐ(교체 직전 pathname 창)는 더 이상 존재하지 않는다. 남는 것은 ⓑ 부모 **이름** 교체 시 소유 temp를 pathname으로 지울 수 없음뿐이고, 그 경우도 이제 `ftruncate(0)`로 **내용 노출은 0**이다. 기한/담당 변경 없음(디스크립터 상대 API 채택 또는 M10) |
| `C-39` | C (P3) | 정리 영수증 공개 | **부분 해소** | 정리 실패가 더 이상 조용하지 않다(`write_cleanup_unconfirmed`). 공개 영수증 필드로 승격하는 일은 그대로 open |
| `C-18` `C-19` `C-26` `C-29` `C-30` `C-31` `C-33` `C-34` `C-35` `C-36` `C-37` `C-40` | C | 이 리비전이 손대지 않은 나머지 | **open — 변화 없음** | 프로세스 감독자 · 리뷰 검증 · trusted Git · 중첩 handoff schema · outcome 단일 출처 · seam provenance · ReviewSubject · store 발행 내부는 이 리비전의 소유 범위 밖이었다(`C-40`은 fixed 유지) |
| `B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B` | B (P1) | live 게이트와 lifecycle 잔여 | **open — 변화 없음** | 이 리비전은 live 실행 0이고 controller·프로세스 계층을 건드리지 않았다. `stableController.test.ts`는 **3 pass / 55 fail**(변경 전후 동일 · 의도적 미수정 · **다음 DAG task 범위**). 직전 절의 "3/58 red" 표기는 "3건 red"로 읽힐 수 있어 부정확했다 |

##### M5c task 3A **리비전**(독립 리뷰 A 4건 + 인접 filesystem B) 대장 갱신 (2026-07-30 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록 · 위 절이 이를 정정한다**)

> **범위 경고**: 이 리비전은 독립 fresh Codex 리뷰(`REVISE · A=4 · B=2 · C=3`)의 **Category A 4건**과
> controller 배선의 선행 조건인 **인접 filesystem B 1건**을 닫았다. **M5c 완료 선언이 아니다.**
> managed process supervisor·자손 정리 · trusted Git · `StableController` 재작성/배선 · 구조화 리뷰 검증 ·
> `autopilot` CLI · legacy 비활성화 · mutation 나머지 6종 · build/dist · M5d는 **미구현·미실행**이다.
> 코드 커밋 `f132d87`(시작 HEAD `5a35bce`). 증거·미실행 목록의 정본은 `docs/WORKLOG.md` 최상단 블록이다.
> 이 세션은 **self-approve하지 않는다.**

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| A1 | **A (P1) → fixed** | 적대적 `Uint8Array` 입양이 닫힌 worker 경계를 벗어났다(`instanceof` + `slice`가 subclass·proxy 통과 · `Symbol.species`로 호출자 코드 실행 · oversized가 상한 검사 전에 복사) | **fixed (2026-07-30, `f132d87`)** | `%TypedArray%.prototype` intrinsic getter(`Symbol.toStringTag`/`byteLength`/`byteOffset`/`buffer`)만 사용 → species·iterator·constructor·caller property 읽기 **0**, 슬롯 없는 receiver(`Proxy`)는 거부. 4 MiB 상한이 **할당·복사보다 먼저**. 실패는 전부 `worker_input_invalid`, 크기 확정 후 초과만 `worker_plan_too_large`. Buffer(pool view) 수락 · SAB **복사**(alias 0) · detached/축소 resizable 안정 거부. 외부 request·binding은 descriptor `value`만 읽어 **accessor를 실행하지 않고 거부**하며 `Proxy`도 거부. 증거: `offlinePlanWorker.test.ts` **10/10**(적대적 바이트 · SAB 변경 · Proxy · throwing species · oversized · Buffer · detached · resizable) + mutation(옛 unsafe 경로 복원 → 해당 테스트 실패 후 정확히 원복) |
| A2 | **A (P1) → fixed** | dispatcher가 durable 권위·현재 실행 자격을 증명하지 않았다(위조 가능·가변 `OperationDispatchContext` · 만료/예산/lifecycle/attempt 미확인) | **fixed (2026-07-30, `f132d87`)** | `OperationDispatchContext` export **삭제**. `OrchestrationKernel.issueOperationDispatchPermit()`이 **durable state에서** binding을 만들어 계획을 kernel이 검증하고 봉인 permit을 발급한다(모듈 사설 `WeakMap` 등록부 · **임의 데이터를 권위로 만드는 토큰·factory·등록 함수 export 0** · state 변경 0). `readDispatchAuthority()`가 **모든 효과·명세 발급 직전에** 현재 durable state를 다시 읽어 permit 진위 · operation의 계획 소속(**신원 비교**) · 시계 · `now < expiresAt` · `now < budgetDeadlineAt`(**등호 거부**) · run/task 신원 · **`running`** · attempt/turn 신원 · preflight digest **재계산** · manifest canonical digest를 확인하고 경로는 **현재** ownership/`writableRoots`로 본다. 단일 scheduler·기존 lifecycle API 유지 · ready→running 직접 경로 없음. 증거: `typedExecution.test.ts` **36/36**(위조 permit 10종 · 묶이지 않은/합성 operation · prepared·cleaning·낡은 attempt·다른 turn · 만료·예산 등호 · 전부 **효과 0** 단정 · 양성은 진짜 preflight→running run) · `orchestrationKernel.test.ts` **103/103** · mutation(만료·예산 재확인 제거 → 경계 테스트 실패 후 정확히 원복) |
| A3 | **A (P1) → fixed** | 발행 경쟁이 미승인 데이터를 덮어쓰거나 승인된 부모 밖으로 쓸 수 있었다(사후 탐지뿐) | **fixed (2026-07-30, `f132d87`) — 잔여 pathname 창은 `C-5`** | 부재 대상은 `link(2)` **no-replace** 발행(`EEXIST` = 경쟁자 바이트 보존 · Node 18 내장). 교체는 preimage **신원·내용**을 발행 직전 재확인. 부모 신원을 열린 fd로 고정하고 **발행 직전 walk 재실행**(symlink 교체·workspace 탈출 차단). temp 확인 fd를 **발행까지 유지**(`O_RDWR` 한 fd) + temp 경로 inode 직전 확인. `O_NOFOLLOW` 부재 시 **fail closed**(조용한 `0` 제거). race seam은 **모듈 사설·테스트 전용**이며 인자·반환값이 없어 권위가 될 수 없다(권위 판정은 seam보다 먼저, 신원 재확인은 seam 뒤). 증거: 결정론적 경쟁 3종(대상 생성 · 대상 교체(내용/inode) · 부모 symlink 교체 · temp 경로 탈취) 전부 **경쟁자/외부 바이트 불변** 단정 + "남의 temp는 지우지 않는다" 단정 |
| A4 | **A (P1) → fixed** | 고립 surrogate 경로가 정확한 승인 경로 신원을 무력화했다 | **fixed (2026-07-30, `f132d87`)** | 공유 정본 `orchestrationTypes.hasLoneSurrogate`(`\p{Surrogate}` + `u`)를 `normalizeWorkspacePath`에서 `path_not_utf8`로 거부 → 승인 manifest 경로 · ownership · `writableRoots` · typed operation 경로 · 산출물 경로가 **함수 하나**를 지난다. 승인된 실행 파일 절대 경로와 `run_process` argv에도 적용. schema `normalizedWorkspacePath.not`을 `anyOf`(드라이브 + 고립 surrogate **code-unit** pattern)로 정렬하고, in-memory JS malformed 판정의 최종 권위는 **런타임**임을 description에 명시. 유효 astral·리터럴 U+FFFD는 양쪽 통과. 증거: `typedExecution.test.ts` schema↔runtime 표(고립 high/low·pair·U+FFFD·😀 512/513 전수 일치) · `autopilotLifecycle.test.ts` **28/28**(공유 정규화 · manifest 3자리 · 실행 파일 · argv · durable ownership) |
| B(인접) | **B (P1) → fixed(기한 앞당겨 이번에 닫음)** | filesystem 실패·durability 처리가 controller 영수증 배선 전에 닫혀야 한다 | **fixed (2026-07-30, `f132d87`)** | 모든 자원 정리를 **`finally` 하나**로 모아 어떤 단계(초기/후속 `fstat`·open·write·read·fsync·close·link/rename·부모 재검증·사후 검증·디렉터리 fsync)가 실패해도 fd·소유 temp 누수 **0**. OS·seam 오류는 경로·내용 없이 닫힌 안정 코드로 접는다. **디렉터리 fsync 성공 확인 뒤에만 `applied`**이며 실패는 신규 `write_durability_unconfirmed`(바이트는 발행됨 → 재시도가 `already_applied`로 수렴하는 crash/retry-safe 계약을 코드·테스트에 명시). fault 주입 8지점 전수 + durability 실패 + 재시도 수렴 테스트. **잔여 한계(정직)**: 정리도 pathname만 가능해(Node 18 `unlinkat` 없음) 부모 **이름**이 적대적으로 교체된 경우 우리 temp를 지우지 못하고 진짜 디렉터리에 남는다(0600 · 미참조 · **미발행**) — 남의 파일을 지우지 않는 쪽을 택한 결과이며 테스트가 그 계약을 단정한다 |
| `B-10` | **B (P1) — open (하드 게이트)** | `run_process`가 여전히 제약 없는 Node 코드 권위다 | **open — 이번에도 spawn 0. 게이트 유지** | 확률: 그런 권위 레코드가 승인되면 **확실**. 영향 반경: 미래 child 프로세스의 전체 로컬 권위 + 레포 hard-deny 표면. 유예 비용: launcher를 이 느슨한 명세 위에 만들면 **높음**(재작업). 수정 공수: 중. **트리거: managed launcher가 `ProcessLaunchSpec`을 소비하거나 첫 spawn을 하기 **전**(하드 게이트)**. 담당: **M5c managed-process 구현자**. 증거: `approvalManifest.ts` argv가 bounded non-NUL이면 통과(`--eval`·가변 script 경로 포함)이고 digest는 Node 실행 파일만 덮는다. 이번 리비전이 한 것은 **강화만**이다: argv 고립 surrogate 거부 + 명세에 run/task/attempt/turn 신원을 담아 다른 attempt 재사용 차단 + 명세 발급 직전 권위 재확인. **필요한 수정**: 고정 **digest 고정 controller entrypoint** 또는 동등한 닫힌 action 계약(UTF-8 왕복 argv 포함) 또는 동등한 sandbox 집행 — **token 화면은 수정이 아니다** |
| `C-38` | C (P3) | 직접 validator binding 오류가 호출자 taxonomy로 새었다 | **이 진입점에서 fixed — `orchestrationKernel.readClosedOnce` 행은 open 유지** | `validateTypedExecutionPlan`의 `binding`도 닫힌 데이터 읽기를 지나므로 hostile accessor/proxy가 거부 코드를 고를 수 없다(증거: "binding의 던지는 getter" 케이스). kernel 쪽 원래 행은 **바꾸지 않았으므로 기한·담당 그대로 open** |
| C(worker 격리) | C (P2) → **fixed** | worker의 least-authority 주장이 취약한 직접 import 테스트로만 증명됐다 | **fixed (2026-07-30, `f132d87`)** | 순수 validator/계약 상수를 신규 `src/exec/typedPlan.ts`로 분리했다. worker의 **transitive** 그래프가 `orchestrationTypes`·`autopilotTypes`·`typedPlan`·`node:util/types`뿐임을 테스트가 **그래프 전체를 순회**하며 강제한다(외부 지정자는 명시 허용 목록만). 이전에는 `typedExecution`을 지나 `node:fs`와 store 모듈을 끌어왔다 |
| C(schema 과대주장) | C (P3) → **부분 fixed** | schema/runtime "동치" 주장이 실제보다 넓었다 | **부분 fixed — 문서·테스트로 정정. draft-07 표현 한계는 남는다** | 중복 `operationId`(draft-07이 배열 항목 간 유일성을 표현할 수 없다) · `summary` NUL · `content` UTF-8 바이트 상한/왕복을 **런타임 전용 불변식**으로 schema description·`operations.description`에 명시하고 테스트가 그 문장의 존재까지 확인한다. **남은 일**: draft-07 구현으로 적대적 행렬을 실제 검증(현재는 pattern·상한·key 집합 대조 + 경로 표 전수). 기한: **외부 provider/worker에 schema를 넘기기 전, 늦어도 M5d 계약 handoff**. 담당: M5c/M5d schema 유지 담당 |
| **신규** `C-41` | C (P2) | **`src/exec/executionBoundary.test.ts`가 시작 HEAD부터 red다(1/20).** 그 파일의 manifest fixture가 v1(`executionAuthority.node`/`processObserver`·`autopilotPolicy` 없음)이라 **직전 slice가 도입한** `manifest_pre_m5c_unsupported` fail-closed에 걸린다. 런타임은 fail closed 방향이므로 A가 아니다 | **open (2026-07-30 최초 측정)** | 확률: **확실**(현재 red). 영향 반경: 실행 경계 회귀 검출 **테스트 커버리지**(런타임 권한 판정은 무관 — fail closed다). 유예 비용: **중** — 전체 suite/handoff를 green이라고 주장하는 순간 거짓이 되고, M5c 통합에서 실행 경계 회귀를 못 잡는다. 수정 공수: **소**(fixture를 v2로 갱신). **기한: 최종 M5c 통합 및 전체 suite green 주장 전(늦어도 M5d handoff 전)**. 담당: **M5c 통합 구현자**. 증거: 실패 메시지 `manifest_pre_m5c_unsupported` **38회** · 이번 리비전이 추가한 `path_not_utf8` **0회** · `git show HEAD:src/exec/approvalManifest.ts \| grep -c manifest_pre_m5c_unsupported` = 3(시작 HEAD에 이미 있었다) · `git diff HEAD -- src/exec/executionBoundary*.ts` 변경 0 · 그 테스트 파일에 `processObserver`/`autopilotPolicy` 출현 0. 이번 리비전의 **소유 범위 밖**이라 고치지 않았다 |
| `C-5` | C (P2) | 경로 이름 기반 TOCTOU 잔여 창 | **open 유지 — 창을 크게 줄였고 남은 것을 정확히 적었다** | 예방으로 바뀐 것: 부재 대상 no-replace `link`, 교체 preimage 신원·내용 재확인, 부모 신원 fd 고정 + walk 재실행, temp 확인 fd 발행까지 유지. **남는 것 2가지**: ⓐ `rename(2)` 직전의 좁은 pathname syscall 구간(Node 18에 `renameat2`·디스크립터 상대 발행 없음 — 네이티브 의존성을 만들지 않고 없앴다고 주장하지도 않는다) ⓑ 부모 **이름**이 교체된 경우 소유 temp를 pathname으로 지울 수 없음(`unlinkat` 없음). 기한/담당 변경 없음(디스크립터 상대 API 채택 또는 M10) |
| `C-30` | C (P3) | 두 번째 backend의 종료·이벤트 방어 e2e 경로 부재 | **open — 변화 없음** | controller 소비 경로가 아직 없다(배선 미완). worker 프로토콜 자체는 그대로다 |
| `C-40` | C (P3) | 경로 길이 schema↔runtime 의미 불일치 | **fixed 유지 + surrogate 규칙과 함께 재강제** | 경로 `maxLength`는 draft-07 코드 포인트이고 런타임도 `codePointLength`다. pattern·제외 pattern·길이 정본을 공유하며 `typedExecution.test.ts`의 표가 고립 surrogate까지 포함해 전수 일치를 강제한다 |
| `C-18` `C-19` `C-26` `C-29` `C-31` `C-33` `C-34` `C-35` `C-36` `C-37` `C-39` | C | 이 리비전이 손대지 않은 나머지 | **open — 변화 없음** | 프로세스 감독자 · 리뷰 검증 · trusted Git · 중첩 handoff schema · 정리 영수증 공개 · outcome 단일 출처 · seam provenance · ReviewSubject · store 발행 내부는 이 리비전의 소유 범위 밖이었다 |
| `B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B` | B (P1) | live 게이트와 lifecycle 잔여 | **open — 변화 없음** | 이 리비전은 live 실행 0이고 controller·프로세스 계층을 건드리지 않았다. `stableController.test.ts`는 **여전히 3/58 red**(의도적 미실행) |

##### M5c task 3A(typed 계획·offline worker·권위 집행) 대장 갱신 (2026-07-30 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록이다**)

> **범위 경고**: 이 slice는 계획 §6의 3번 묶음 중 **typed 계획 validator · offline plan worker ·
> 권위 해석/파일 쓰기 집행**만 닫았다. **M5c 완료 선언이 아니다.** managed process supervisor·자손 정리 ·
> trusted Git · `StableController` 재작성/배선 · 구조화 리뷰 검증 · `autopilot` CLI · legacy 비활성화 ·
> mutation 나머지 7종 · build/dist · M5d는 **미구현·미실행**이다. 아래 절들의 다른 상태 판정은 그대로
> 유효하다. 증거·미실행 목록의 정본은 `docs/WORKLOG.md` 최상단 블록이다.
> 이 세션은 **self-approve하지 않는다.**

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| `B-10` | B (P1) | edit 가능 실행에 타입 있는 집행 계층이 없었다 | **부분 fixed — offline typed 경로의 집행기가 생겼다. 게이트는 여전히 열려 있다** | 신규 `src/exec/typedExecution.ts`: 닫힌 계획 validator + deny-by-default 권위 해석(`approvedOperationFor` 하나만) + dispatch 시점 경로·**durable child ownership**·`writableRoots` 재검사 + symlink 비추적 + 배타 temp → 재확인 → 원자적 rename + 크래시 창 `already_applied` + 충돌 시 무쓰기 + 내용 없는 닫힌 영수증. `run_process`는 **동결 데이터 명세까지만**이고 spawn 0. 증거: `typedExecution.test.ts` 23/23 + mutation(권위 대조 생략) 2건 실패 후 원복. **남은 일**: managed process launcher · controller 배선 · 그 둘의 독립 리뷰. **실제 Claude/Codex는 여전히 부재·비활성**이다 |
| `C-38` | C (P3) | 호출자 getter가 거부 taxonomy를 고를 수 있다 | **이 seam에서 fixed — 다른 호출부는 open 유지** | `typedExecution`/`offlinePlanWorker`의 입양 경로는 getter/proxy가 던진 것을 **무엇이든**(호출자가 만든 `OrchestrationError` 포함) `plan_invalid`/`worker_input_invalid`로 접는다. 증거: `typedExecution.test.ts` "던지는 getter는 호출자가 고른 코드가 아니라 안정 코드로 접힌다" · `offlinePlanWorker.test.ts` 같은 케이스. `orchestrationKernel.readClosedOnce`의 원래 행 자체는 **바꾸지 않았으므로 open**이다(기한·담당 그대로) |
| `C-30` | C (P3) | 두 번째 실행 backend가 없어 종료·이벤트 방어에 e2e 경로가 없었다 | **부분 진전 — offline backend의 이벤트 프로토콜 경로가 생겼다** | `offlinePlanWorker`가 `started → progress ≥1 → terminal 1건 → 정상 종료`를 내고 **최종 결과만 있는 스트림을 구조적으로 만들 수 없다**. 다만 **controller 소비 경로가 아직 없으므로**(배선 미완) 중복 종료·late event·상한 초과에 대한 controller 방어의 e2e는 **여전히 미도달**이다 → `open` 유지 |
| `C-40` | C (P3) | 경로 길이 schema↔runtime 의미 불일치 | **fixed 유지 + 신규 schema에도 적용** | `typed_execution_plan.schema.json`의 경로 `maxLength`는 draft-07 코드 포인트이고 런타임은 `codePointLength`를 쓴다. pattern은 정본 하나(`NORMALIZED_WORKSPACE_PATH_PATTERN`)를 공유하고 `typedExecution.test.ts`가 양/음성 표(😀 512/513 포함) 전수로 두 판정이 갈리지 않음을 강제한다 |
| `C-5` | C (P2) | 경로 이름 기반 TOCTOU 잔여 창 | **open 유지 — 이 slice가 창을 줄였고 그 사실을 소스에 적었다** | `rename(2)`는 pathname을 받으므로 증명과 발행 사이 창이 0이 아니다. 배타 `O_EXCL` temp · 같은 fd 재확인 · rename 직후 대상 inode 확인으로 줄였고 남은 한계를 `typedExecution.ts` ponytail 주석에 적었다. Node 20+ 디스크립터 상대 API 채택은 여전히 M10 |
| `C-18` `C-19` `C-26` `C-29` `C-31` `C-33` `C-34` `C-35` `C-36` `C-37` `C-39` | C | 이 slice가 손대지 않은 나머지 | **open — 변화 없음** | 프로세스 감독자 · 리뷰 검증 · trusted Git · 중첩 handoff schema · 정리 영수증 공개 · outcome 단일 출처 · seam provenance · ReviewSubject · store 발행 내부는 이 slice의 소유 범위 밖이었다 |
| `B-7` `B-9` `B-11` `B-12` `B-13` `C-12→B` | B (P1) | live 게이트와 lifecycle 잔여 | **open — 변화 없음** | 이 slice는 live 실행 0이고 controller·프로세스 계층을 건드리지 않았다. `stableController.test.ts`는 **여전히 3/58 red**(의도적 미실행) |

##### M5c green-recovery slice 대장 갱신 (2026-07-30 — **M5c 미완료 상태의 부분 갱신 · 그 시점 기록**)

> **범위 경고**: 이 slice는 **직전 기반 slice가 red로 남긴 kernel + M4 offline 검증면을 green으로 되돌린 것**
> 뿐이며 **M5c 완료 선언이 아니다**. 아래 아래 절("M5c 기반 slice에서의 대장 갱신")의 상태 판정은 그대로
> 유효하고, 이 절은 **검증면·계약 문서 쪽 진전만** 더한다. 런타임 소스는 한 줄도 바꾸지 않았다.
> `docs/WORKLOG.md` 최상단 블록이 증거·미실행 목록의 정본이다. 이 세션은 **self-approve하지 않는다.**

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| `C-40` | C (P3) | 승인 경로 길이 schema↔runtime 의미 불일치 | **fixed 유지 + schema 쪽 증거 보강** | 런타임은 직전 slice에서 코드 포인트로 통일됐고, 이 slice가 `milestone_approval_manifest.schema.json`의 `maxLength`가 draft-07 코드 포인트 의미임을 문서에 명시하고 `orchestrationKernel.test.ts`가 pattern 항등 + 양/음성 경로 표 전수 + 길이 경계를 다시 강제한다 |
| `C-33` | C (P3) | 손으로 관리하는 marker 목록이 여러 곳에 흩어졌다 | **부분 진전 유지 — 이제 schema까지 동치가 강제된다** | `EVENT_MARKERS`(합집합 32종) · `AUTOPILOT_MARKERS` · `PAUSE_REASONS` · `DELIVERY_MARKERS` · `OPERATION_RECEIPT_MARKERS` · `CLEANUP_STATUSES`가 `orchestration_run_state.schema.json`과 **정확히 동치**임을 `orchestrationKernel.test.ts`가 단정한다(schema 쪽 중복 금지 포함). 여전히 **타입 있는 outcome 단일 출처는 미구현**이므로 `open` 그대로다 |
| — (신규 관측 · ID 부여 안 함) | 운영 정확성 | **M4 offline acceptance 3종이 `dist`를 소비해 낡은 계약을 검사하며 green이었다** | **fixed (2026-07-30)** | tracked `dist`는 M5b 계약(state/manifest v1)에 머물러 있고 그 갱신은 M5 handoff의 build 단계다 → M5c 창 동안 M4 acceptance는 **검증면으로서 무가치**했다. 세 스크립트를 `src/exec/*.ts` 소비로 바꿨고(로더 없이 들어오면 스스로 `node --import tsx`로 한 번 재실행 — 호출 방식·`scripts/acceptance.sh` grep 문자열 무변경) v2 fixture와 실제 lifecycle 경로로 이관했다. 실측: `m4a` 32/32 · `m4b` 45/45 · `m4c` 80/80(셋 다 exit 0). **미해결 잔여**: `src↔dist` drift 자체는 그대로이고 dist 재생성은 M5 handoff의 build 단계 몫이다 |

**이 slice가 green으로 되돌린 것**: `orchestrationKernel.test.ts` **14/103 → 103/103** ·
M4a/M4b/M4c offline acceptance **전부 exit 0**. `tsc --noEmit` 0 error · `autopilotLifecycle.test.ts` 27/27 유지.
**여전히 red**: `stableController.test.ts` **3/58** (`StableController`가 아직 `startScheduledBatch()`를
부른다 — `B-11`/`B-12`/`B-13`/`C-12→B`의 "controller 배선" 잔여가 그대로라는 뜻이다).
**미실행**: `npm test` · 전체 `test:core` · 전체 acceptance · `npm run test:exec` · stress · live ·
mutation 8종 · build/dist.

##### M5c 기반 slice에서의 대장 갱신 (2026-07-30 — **M5c 미완료 상태의 부분 갱신** · 그 시점 기록)

> **범위 경고**: 아래는 M5c의 **기반 slice(state/manifest v2 · lifecycle · durable 회계)** 만 반영한 것이며
> **M5c 완료 선언이 아니다**. typed 실행 집행 · trusted Git · managed process supervisor · offline plan
> worker · 구조화 리뷰 검증 · controller 재작성 · autopilot CLI는 **미구현**이다. 증거·미실행 목록은
> `docs/WORKLOG.md` 최상단 블록이 정본이다. 이 세션은 **self-approve하지 않는다.**

| id | 분류 | 항목 | 상태 | 근거·증거 |
|---|---|---|---|---|
| `C-17` | C (P3) | kernel 만료 판정이 `>` 라서 만료 밀리초에 전이 1건이 통과했다 | **fixed (2026-07-30)** | `orchestrationKernel.assertNotExpired`가 `>=`다. 실행 경계와 판정이 일치한다. 증거: `autopilotLifecycle.test.ts` "만료는 경계 포함이다(C-17)" — 만료 −1ms는 통과, 만료 정각은 `manifest_expired`. 만료 후 safety-only 예외는 DECISIONS 2026-07-30 + 로드맵 §8.1에 **먼저** 기록했다 |
| `C-24` | C (P2) | Codex stderr 버퍼 상한이 chunk 단위라 큰 chunk 하나가 상한을 임의로 넘겼다 | **fixed (2026-07-30)** | `codexCliProvider.ts` stderr handler가 **남은 자리만큼만** 정확히 슬라이스한다. 전용 회귀는 **미작성**(provider 테스트 파일 미갱신) — 이 항목의 증거는 소스뿐이므로 리뷰어 확인 대상이다 |
| `C-40` | C (P3) | 승인 경로 길이가 runtime은 UTF-16 unit, schema는 코드 포인트라 판정이 갈렸다 | **fixed (2026-07-30)** | `orchestrationTypes.codePointLength`가 정본이고 `normalizeWorkspacePath`·`validateApprovedExecutable`이 그것을 쓴다. 증거: `autopilotLifecycle.test.ts` C-40 케이스 — `/`+😀×256(코드 포인트 257 / UTF-16 513) **수락** · 정확히 512 **수락** · 513 **거부** |
| `B-11` | B (P1) | batch 전체가 per-task preflight 전에 running이 됐다 | **부분 fixed — kernel 계약은 닫혔고 controller는 미배선** | `planRunnableBatch`→`commitPreflightBatch`(원자적)→`startPreparedTask`. `startTask`/`startScheduledBatch`는 `preflight_required` stub. `prepared`가 자원·`maxSessions`를 점유한다. **남은 일**: `StableController`가 아직 옛 API를 부른다 |
| `B-12` | B (P1) | 재시작이 토큰·경과 회계를 리셋했다 | **fixed (kernel 층) — controller 배선은 미완** | `state.accounting`(v2) · turn 멱등 과금 · `stateContentDigest`에 포함(손편집 거부) · durable run deadline. 증거: `autopilotLifecycle.test.ts` 재시작·멱등·손편집 3케이스 |
| `B-13` | B (P1) | durable 완료가 확인된 provider 정리보다 앞섰다 | **부분 fixed — 순서 계약만 닫혔다** | `requireCleanedTask`(= `cleaning` + `cleanupStatus==="confirmed"`)가 `completeTaskWithArtifacts`·`submitResult`·`submitBlocker` 전부를 지난다. 정리 실패는 `cleaning`에 남고 자원을 유지한다. **남은 일**: 실제 프로세스 감독자·자손 정리(`C-18`)는 **미구현** |
| `C-12→B` | B (P1) | 실패한 inbox 전달을 자동 재시도할 수 없었다 | **부분 fixed — durable 재진입 데이터는 닫혔다** | `message.delivery` + `beginDeliveryAttempt`/`failDeliveryAttempt`. 실패는 ack하지 않고 재시도만 남기며, 시도 기록 없는 ack는 `delivery_attempt_missing`이다. **남은 일**: controller의 재진입 loop |
| `B-10` | B (P1) | edit 가능 실행에 타입 있는 집행 계층이 없었다 | **open (계약면만 닫힘)** | `manifest.operationAuthorityByTask` 닫힌 union + deny-by-default `approvedOperationFor` + `run_process.executable`을 승인된 node로 한정(git·codex·임의 경로 거부). **집행기(`typedExecution.ts`)·worker는 미구현** → **여전히 열린 게이트**다 |
| `C-18` `C-19` `C-26` `C-29` `C-30` `C-31` `C-33` `C-34` `C-35` `C-37` | C | M5c가 닫기로 한 나머지 | **open — 미착수** | 해당 slice(프로세스 감독자 · 리뷰 검증 · trusted Git · 중첩 handoff schema · 두 번째 backend · 정리 영수증 공개 · outcome 코드 단일 출처 · seam provenance · ReviewSubject 닫기 · action 정합화)가 구현되지 않았다. `C-33`은 event `marker`를 닫힌 합집합(`EVENT_MARKERS`)으로 모으는 **부분 진전**만 있다 |
| `B-7` `B-9` | B (P1) | live 인증·secret redaction · live JSONL 검증 | **open — 손대지 않았다** | 첫 live 실행 전 하드 게이트 그대로. 이 세션은 live 실행 0 |
| `C-22` | C (P2) | same-thread live Codex resume 소유권 | **open — 의도적** | M5c는 provider 세션을 재개하지 않고 fresh offline attempt를 쓰기로 했다(계획 §5) |
| `C-36` `C-39` | C (P3) | store 발행 경로의 test-only hook · 정리 실패 억제 | **open — 트리거 미발화** | 이 세션은 `orchestrationStore` **발행 내부를 건드리지 않았다**(검증자만 변경) |

##### M5b 7차 리비전 신규·갱신 유예 (2026-07-30)

> **6차 리비전도 A를 전부 닫지 못했다.** 7차 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가
> `409dee2..ff5e035`에 대해 **REVISE · A/P1 2건 · B 7 · C 12**를 냈다: **6차 A1 PARTIAL**(승인 manifest가
> trust root가 된 것·같은 fd digest 검증은 닫혔지만 **git 검증이 프로세스 1회**여서 `readCheckoutHead()`의
> 두 자식 프로세스 사이·`revalidateSync()` 루프 회차 사이에 제자리 덮어쓰기가 통과했다) ·
> **6차 A3 PARTIAL**(roll forward 폐기·journal 묶기·no-clobber는 닫혔지만 **발행 preflight 이후 staging
> 교체본이 link되고 journal이 삭제**될 수 있었다) · **초기 A2 CLOSED** · **초기 A4 PARTIAL**.
> **둘 다 7차 리비전에서 닫았다**(§10 M5 → M5b 7차 리비전). 6차 절의 "둘 다 닫았다"는 **부분적으로만
> 사실**이었고 dated history로 보존한다 — 현행 판정은 이 절이다. **여전히 self-approved가 아니다.**
>
> **B 7건은 7차 리뷰 원문 그대로 유지한다**(이번 A 작업과 겹쳐 실제로 닫힌 것은 **하나도 없다**):
> `B-7`(live 인증·secret redaction — **첫 live 실행 전** · 사용자+M5c) · `B-9`(live JSONL 필드 확인 —
> **첫 live 실행 전** · 사용자+M5c) · `B-10`(타입 있는 edit 실행 집행 — **Claude/edit 가능 provider 활성화
> 전** · M5c+사용자) · `B-11`(per-task preflight 전에 batch 전체가 running — **무인 autopilot/advance 전** ·
> M5c) · `B-12`(재시작·resume 후 토큰·경과 회계 — **첫 자동 restart/resume 전, 늦어도 M5c** · M5c) ·
> `B-13`(provider 정리 확인 뒤 durable 완료 — **live runner 또는 두 번째 process-backed provider 전** · M5c) ·
> `C-12`→B(미수령 전달의 재전송 불가 — **M5c autopilot 전** · M5c). 각 행의 심각도·확률·영향 반경·유예
> 비용·공수·증거는 `B-7`/`B-9` 본표와 "M5b 1차 리비전" 표의 해당 행에 그대로 있다.
>
> **C 12건**: 기존 `C-35` · `C-5` · `C-17` · `C-29` · `C-19` · `C-36` · `C-37` · `C-30` · `C-38` ·
> `C-39` · `C-26`은 **사실·기한 그대로 open 유지**하고(이번 리비전이 그 뿌리를 손대지 않았다 — fixed로
> 주장하지 않는다), 리뷰가 "신규/기존 ID 없음"으로 낸 **승인 실행 파일 경로 schema regex와 runtime의
> 갈림** 항목을 아래 **`C-40`** 으로 등록하고 **이번에 정렬해 닫았다**(아래 행의 상태·증거 참조).
> **C만으로 추가 리비전 루프를 돌리지 않는다.**
>
> **`C-36` 증거 갱신(재분류 안 함).** 리뷰가 정확히 지적한 대로 `setCommitFaultHook` 콜백은 **던지는 일만
> 하는 것이 아니다** — 동기 콜백이므로 파일 시스템을 임의로 바꿀 수 있고 기존 테스트가 실제로 그렇게 쓴다.
> 그렇게 주장했던 source 주석을 정정했고, A2 수정이 그 변경들을 **fail closed로 잡도록**(hook 이후 재증명 ·
> journal 삭제 직전 전수 sweep) 만들었다. **export된 가변 전역이라는 절충 자체는 그대로 open**이며
> 기한(다음 store publication-path 변경 또는 M10)도 그대로다.
>
> **`C-37` 갱신(닫지 않음 · 낡은 "닫힘" 주석 정정).** 6차 리비전 source 주석은 roll forward 폐기를 근거로
> "`C-37` 닫힘"이라고 적었으나 **사실이 아니었다**: 목표 state가 durable해진 뒤의 `body:publish`·
> `journal:cleanup` 실패는 여전히 호출자에게 실패를 주고 다음 열기가 마무리한다. 이번 리비전은 그 주석
> (`orchestrationStore.recoverPendingCommit` · `orchestrationKernel.completeTaskWithArtifacts` ·
> `stableController` 모듈 doc)을 사실대로 고쳤고 **상태는 open**, 기한은 그대로 **M5c outcome marker
> 처리 전**이다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-40` | C (P3) | **승인 실행 파일 경로의 schema regex가 runtime보다 느슨했다**(7차 리뷰 C-40 — 기존 ID 없음). `milestone_approval_manifest.schema.json`의 `approvedExecutable.path` regex `^/[^\0]*[^/\0]$`가 `/a//b`·`/a/./b`·`/a/../b`를 통과시키는데 runtime `validateApprovedExecutable`은 거부했다. **runtime이 fail closed이므로 A가 아니다** — 영향은 schema를 소비하는 도구의 검증 UX·호환성이고 권한 판정은 아니다. 기존 "동치" 테스트는 필수 key·digest regex·최대 길이만 봤다 | 중 — schema를 admission으로 쓰는 외부 도구가 있을 때 | manifest 검증 UX·문서 신뢰도(런타임 권한 판정 무관) | 낮음 | 소(정규형 pattern 하나를 양쪽이 공유) | **다음 manifest schema 변경 또는 외부 schema 검증을 admission으로 쓰기 전** | M5c/schema 유지 담당 | 7차 독립 리뷰 C-40 · `approvalManifest.ts` `APPROVED_PATH_PATTERN`(runtime·schema 공용 정본) · schema `definitions.approvedExecutable.properties.path.pattern` · focused "[M4c] milestone_approval_manifest.schema.json이 runtime 계약과 동치다"의 **양/음성 경로 표 전수 + 길이 상한** · 사전 실측 1021 케이스 명령형 predicate ↔ regex 불일치 0 · mutation 2종(schema만/runtime만 옛 regex로) 전부 kill | **fixed (2026-07-30, 7차 리비전)** |

##### M5b 6차 리비전 신규·갱신 유예 (2026-07-28)

> **5차 리비전도 A를 전부 닫지 못했다.** 6차 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰가
> `409dee2..6a5e418`에 대해 **REVISE · A/P1 2건 · B 7 · C 10**을 냈다: **A1 OPEN**(caller가 provider·
> controller 양쪽에 지정한 임의 실행 파일이 권위가 됐고 같은 inode 제자리 덮어쓰기도 통과했다) ·
> **A3 OPEN**(journal이 base 승인·전이·정확한 body 소유권에 묶이지 않았다) · **A2 CLOSED** · **A4 PARTIAL**.
> **둘 다 6차 리비전에서 닫았다**(§10 M5 → M5b 6차 리비전). 5차 절의 "넷 다 닫았다"는 **부분적으로만
> 사실**이었고 dated history로 보존한다 — 현행 판정은 이 절이다. **여전히 self-approved가 아니다.**
>
> **B 7건은 6차 리뷰 원문 그대로 유지한다**(이번 A 작업과 겹쳐 실제로 닫힌 것은 **하나도 없다**):
> `B-7`(live 인증·secret redaction — **첫 live 실행 전** · 사용자+M5c) · `B-9`(live JSONL 필드 확인 —
> **첫 live 실행 전** · 사용자+M5c) · `B-10`(타입 있는 edit 실행 집행 — **Claude/edit 가능 provider 활성화
> 전** · M5c+사용자) · `B-11`(per-task preflight 전에 batch 전체가 running — **무인 autopilot/advance 전** ·
> M5c) · `B-12`(재시작·resume 후 토큰·경과 회계 — **첫 자동 restart/resume 전, 늦어도 M5c** · M5c) ·
> `B-13`(provider 정리 확인 뒤 durable 완료 — **live runner 또는 두 번째 process-backed provider 전** · M5c) ·
> `C-12`→B(미수령 전달의 재전송 불가 — **M5c autopilot 전** · M5c). 각 행의 심각도·확률·영향 반경·유예
> 비용·공수·증거는 `B-7`/`B-9` 본표와 "M5b 1차 리비전" 표의 해당 행에 그대로 있다.
>
> **C 10건**: 기존 `C-35` · `C-5` · `C-17` · `C-29` · `C-19` · `C-36` · `C-37` · `C-30` · `C-38`은
> **사실·기한 그대로 유지**하고(이번 리비전이 그 뿌리를 손대지 않았다 — fixed로 주장하지 않는다),
> 리뷰가 "신규/기존 ID 없음"으로 낸 **transaction staging·atomic tmp 정리 실패 orphan** 항목을 아래
> **`C-39`** 로 등록한다. **C만으로 추가 리비전 루프를 돌리지 않는다.**
>
> **`C-37` 갱신(닫지 않음 · 직접 증거로 범위만 줄임).** roll forward를 폐기했으므로 "호출자가 받은 실패를
> 다음 열기가 완료로 만드는" 경계가 **11개 중 2개**(`body:publish` · `journal:cleanup` — 목표 state가 이미
> durable해진 뒤)로 줄었다. 그러나 그 둘에서는 **여전히** 성립하므로 **상태는 open**이고 기한(M5c가 outcome
> marker로 retry/pause를 분기할 때)도 그대로다. 증거: `orchestrationKernel.test.ts`의 `STAGE_OUTCOME` 표에서
> `after`가 정확히 그 두 자리뿐임을 발행 경계 전수 회귀가 고정한다.
> **`C-36`도 재분류하지 않았다**: `setCommitFaultHook`은 여전히 export된 가변 전역이며(발행 경계는 11개 유지 —
> `body:publish`가 `state:rename` 뒤로 **이동**했을 뿐이다) 이번 복구 경로 I/O 실패 회귀도 그 seam을 썼다.

| id | 분류 | 항목 | 확률 | 영향 반경 | 유예 비용(rework) | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| `C-39` | C (P3) | **transaction staging·atomic tmp 정리 실패를 삼켜 orphan을 남긴다**(6차 리뷰 C-10 — 기존 ID 없음). journal 발행 **전** 오류 경로의 staging 제거와 `writeAtomic`의 tmp 제거, 그리고 발행 성공 뒤 staging 제거는 `rmSync` 실패를 조용히 넘긴다 → `messages/.staged-<txn>.<id>.md` 또는 `<file>.tmp-<pid>` orphan이 남을 수 있다. **다른 최종 body·state·events·journal은 손대지 않으므로** 현재는 비차단이고, 남은 orphan은 다음 커밋·복구의 판정을 바꾸지 않는다(소유 신원이 journal에 있고 최종 이름은 no-clobber다) | 낮음 — 정리 `rm` 자체가 실패할 때만 | 그 run 디렉터리의 staging/tmp orphan 1~2건(무결성·판정 무관) | 낮음 — 나중에 정리 sweep을 붙이면 된다 | 소~중(정리 실패를 안정 marker로 올리거나 열거 기반 sweep 추가) | **다음 store publication-path 변경 또는 M10 hardening** | M5c/M10 구현 세션 | 6차 독립 리뷰 C-10 · `orchestrationStore.ts` `writeAtomic`의 `rmSync` catch · `commitRun`의 journal 발행 전 staging 정리 catch · `publishOwnedBodies`/`removeOwnedStaging`의 정리 catch(각 `ponytail:`/주석에 명시) | open |

> **`C-30` 갱신(2026-07-28, 3차 리비전).** "중복 종료·결과 부재 방어가 codex 경로로는 도달 불가"는 그대로
> open이지만 **범위가 줄었다**: 위 `B-14` 수정으로 그 방어 경로의 **usage 회계**는 공용 소비자 수준에서
> end-to-end로 고정됐다(늦은 이벤트·중복 종료·종료 뒤 throw). 남은 것은 `provider_duplicate_terminal`/
> `provider_no_result`/`provider_stream_unbounded` **marker 자체**의 e2e 경로이고 기한은 그대로
> **M5c 두 번째 실행 provider 배선 시**다.

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

#### M5a 3차 리비전 (2026-07-27, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰 → **REVISE**)

범위 `85ebe883..2627f8f`를 **독립 read-only Codex 리뷰**가 다시 봤고 판정은 **REVISE**였다. 앞선 두 라운드가
게이트를 하나씩 세웠지만, 이번 findings는 **게이트가 서 있는 위치**(비동기 창 밖)와 **게이트가 신뢰하는
도구·기대값**(ambient git, 기대 세션 신원 부재)을 지적했다. 작성 세션을 playbook §6에 따라 이 A 처리에만
resume해 **A 3건을 전부 고쳤고** 문서·타입 정정과 `C-23` 확장/해소를 함께 했다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| 1 | **A (P0)** | **spawn-adjacent TOCTOU**: `CODEX_HOME`·codex 실행 파일을 `await verifyExecutionBoundary` **전에** 검사하고 그 뒤에는 `revalidateSync`만 돌았다 → 비동기 창에서 홈/실행 파일 교체·symlink화·권한 완화·**inode 교체**가 spawn까지 도달할 수 있었다 | **fixed** — await 없는 **단일 순서 동기 pre-spawn 게이트**(spec 스냅샷 → 만료·git·checkout·HEAD → 홈(+고정 신원, 첫 invocation은 여전히 비어 있음) → 실행 파일(+**고정 신원**)) 뒤 바로 spawn. 창 안 훼손 8케이스(홈 4 · 실행 파일 4) + resume 1케이스 **spawn 0** 테스트. 남는 syscall 규모 창은 명시하고 0이라 주장하지 않는다 |
| 2 | **A (P1)** | **ambient git 증명 우회**: 경계가 `git`을 이름으로 부르고 `runProcess`가 `process.env`를 상속 → 적대적 `PATH`·`GIT_DIR`·`GIT_WORK_TREE`가 **다른 저장소/커밋**을 증명할 수 있었다 | **fixed** — `gitExecutablePath` 필수(정규·비symlink·일반 파일·실행 비트·타인 쓰기 금지·**신원 고정**), async·sync 두 조회 모두 그 경로, 자식 env는 `GIT_SANITIZED_ENV` 화이트리스트(PATH·HOME·상속 `GIT_*` 0, system/global config는 사용자 상태 없이 off). 적대적 PATH+`GIT_DIR`+`GIT_WORK_TREE` 테스트가 승인 checkout 판정 유지를 고정. **`runProcess` 다른 호출자는 무수정**(경계 범위 한정) |
| 3 | **A (P1)** | **resume 신원 누출**: 파서가 기대 UUID를 몰라 conflicting `init`이 먼저 나가고, **한 chunk가 통째로 파싱**되므로 다른 thread의 assistant·status·도구 payload까지 새어나갈 수 있었으며 결과가 잘못된 UUID를 들 수 있었다 | **fixed** — `CodexParserContext.expectedSessionId`로 **init 생성 전에** 불일치를 잡아 스트림 **봉인**(같은 chunk 뒷줄까지 방출 0). marker·result는 **기대 UUID**에 묶이고 관측된 다른 id·usage·본문은 어디에도 없다. provider는 세션을 닫아 후속 `send`가 spawn 0. 적대적 one-chunk 테스트(sentinel 4종 · init/assistant/status/도구 0 · 결과 1건) |
| 4 | **C(문서·타입)** | "실행 파일/홈을 spawn 직전에 확인한다"는 서술이 실제 순서와 달랐고, `codexHome` 타입 주석이 "비어 있어야 한다"만 말했다 | **fixed** — 로드맵·provider 헤더는 **순서 있는 동기 게이트**를 서술하고, `types.ts`는 "첫 invocation 비어 있음 + 이후 같은 소유 홈"으로 정정. `B-7`·`B-8`·`B-9`와 `C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`는 **그대로 유지**하고 `C-23`만 확장 후 fixed |

검증 실측(offline, 2026-07-27 — 3차 리비전 세션):

- 파일 단독 `npx tsx --test --test-timeout=180000` : `executionBoundary.test.ts` **17/17** ·
  `codexStreamParser.test.ts` **28/28** · `codexCliProvider.test.ts` **45/45**(합 **90/90**, 이전 79).
- `npm run test:exec` **232/232**(221 → 232). **232는 exec suite 수치이며 파일 단독 focused가 아니다.**
- `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity** — 재빌드 후 diff 변화 0) · `git diff --check` clean.
- **비공허성(mutation) 6종**: 게이트의 홈 재검증 제거 → **2건 실패** / 실행 파일 신원 pin 제거 → **1건** /
  git 경로·env(async) 되돌림 → **1건** / git 경로·env(sync) 되돌림 → **1건** / 파서 봉인 무효화 → **2건** /
  spec 스냅샷 비교 제거 → **1건**. 여섯 번 모두 정확히 원복하고 `MUTATION` grep 0 ·
  `git diff --numstat` 기준선 일치 · focused 90/90 재확인.
- **전체 suite(`npm test`) 미실행 — 리뷰가 지적한 그대로다.** M5a는 **내부 stacked M5 slice**이고,
  supervisor가 **M5b~M5d 이후 최종 M5 handoff에서 직렬 1회**를 예약했다. 이 세션은 그것을 돌리지 않았고
  **M5a handoff는 supervisor 리뷰 전까지 승인된 것이 아니다.** 미실행: `npm test` 전체 · `test:core` ·
  acceptance · stress · live · 반복 3회.
- **Codex/Claude provider 추론 0회**(fake CLI·in-process seam만). `B-7`·`B-8`·`B-9`는 여전히 open이며
  그 전에는 이 provider로 실제 Codex를 부르지 않는다.

#### M5a 4차 리비전 (2026-07-27, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰 → **REVISE**)

범위 `85ebe883..3493a2e`를 **새 독립 read-only Codex 리뷰**가 다시 봤고 판정은 다시 **REVISE**였다.
3차의 A 3건(spawn-adjacent 홈/실행 파일/git 게이트 · ambient git 증명 · resume UUID 봉인)은
**fixed로 확인**됐고 그 계약·테스트는 그대로 보존했다. 이번 findings는 **상태 기계**를 봤다:
게이트는 제자리에 있었지만 **누가 그 게이트를 지날 자격이 있는지**를 아무도 원자적으로 정하지 않았다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| 1 | **A (P1)** | **pre-spawn session-state race.** `send()`가 상태를 본 뒤 `invoke()`가 **await된 `verifyExecutionBoundary` 뒤에야** 세션을 점유했다 → 겹친 두 `send`가 둘 다 통과해 같은 UUID·`CODEX_HOME`으로 **중복 resume 프로세스**를 띄우고 큐·child를 서로 덮어쓸 수 있었고, 같은 창에서 `stop()`이 세션을 지워도 뒤늦게 `running`을 발행하며 **추적되지 않는 프로세스**가 뜰 수 있었다 | **fixed** — ⓐ `starting` 상태 + provider 전역 **단조 증가 generation 토큰**을 **첫 await 전에 동기로** claim한다 ⓑ 겹친 start/send는 spawn·발행 없이 `codex_send_overlap`으로 즉시 거부(큐·child·events 무변경) ⓒ **모든 await 뒤 + spawn 직전 동기 게이트**에서 세션 존재 · 같은 state 객체 · 같은 generation · 미취소 · 미중지를 재확인 → `codex_invocation_cancelled` ⓓ `stop()`은 **child가 없어도** claim을 취소하고 같은 id의 **교체 세션은 지우지 않는다**(낡은 `start` catch·`settle`도 소유권 확인 후에만 상태를 만진다). 신뢰 검사 → `spawn` 사이 **no-await** 유지, stop 멱등·poison·만료·큐 격리 semantics 무변경 |
| 2 | **A (P1) — `C-23` reopen** | **세션 spec이 turn 사이에 고정되지 않았다.** provider가 호출자 소유 `state.spec`을 들고 **매 turn `resolveCodexOptions`를 다시 해석**해, 1차 turn 완료 후 `send` 전의 변조가 **새 baseline**이 됐다. 3차가 이를 fixed로 적은 것은 **overclaim**이었다(같은 invocation 안의 창만 닫혀 있었다) | **fixed** — `start()`가 유효 옵션 **전부를 봉인**(`Object.freeze`)하고 `SEALED_KEYS` **명시 필드 목록**으로 매 invocation 동기 진입 + spawn 직전 게이트에서 대조한다. 드리프트 marker는 **`codex_spec_mutated` 하나**(필드 이름만 알리고 경로·내용은 싣지 않는다). argv·env·경계 입력은 전부 봉인값에서만 만든다. 대장 `C-23` 행을 **reopen 사유와 함께** 정정했다 |
| 3 | **A (문서/구현 불일치)** | `invoke` 주석은 "검증 단계 실패 시 기존 큐·상태는 그대로"라고 말했지만, 구현은 **동기 게이트 전에** 새 큐와 `running`을 발행해 실패가 **이전 invocation의 완료된 큐를 교체**하고 가짜 종료 결과를 하나 더 냈다 | **fixed** — 발행을 **동기 게이트 뒤로** 옮겼다. 발행 전 실패는 큐·`child`·세션 신원을 **하나도 건드리지 않고** claim만 되돌린다(거부는 rejected promise로만). 발행 이후 실패(동기 spawn 예외)만 그 invocation의 **bounded 스트림**을 종료 결과 1건으로 닫는다. 테스트가 `leaked === 0`으로 고정 |
| 4 | **C (신규 등록)** | 인접 상태 기계 감사에서 나온 두 건 | **유예(대장 등록)** — `C-27`(`stop()`이 `starting`에서 반환한 뒤에도 취소된 invocation promise가 나중에 reject된다 → M5b 배선 전) · `C-28`(봉인 밖 manifest 권한 필드는 turn 사이 고정 없음 — 현재 provider가 읽지 않는다 → 권한 집행 계층 도입 시). `B-7`·`B-8`·`B-9`와 `C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`·`C-26`은 **전부 그대로 open** |

검증 실측(offline, 2026-07-27 — 4차 리비전 세션):

- 파일 단독 `npx tsx --test` : `executionBoundary.test.ts` **17/17** · `codexStreamParser.test.ts` **28/28** ·
  `codexCliProvider.test.ts` **50/50**(45 → 50, 합 **95/95**, 이전 90).
- `npm run test:exec` **237/237**(232 → 237). **237은 exec suite 수치이며 파일 단독 focused가 아니다.**
- `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity** — 재빌드 후 `git status` 변화 0) ·
  `git diff --check` clean.
- **동시성 계약을 건드렸으므로 신규 race/spec 테스트 5건을 반복 3회**: 3회 모두 5/5.
- **비공허성(mutation) 5종**: `claim`의 `starting` 전이 제거 → **2건 실패**(겹친 send · start 중 send) /
  `owns()`의 세션 존재·미취소·미중지 검사 제거 → **2건**(stop 취소 · 교체 세션) /
  봉인값 대신 매 turn 재해석 → **1건**(between-turn만 실패하고 기존 same-invocation 테스트는 **통과** —
  reopen 사유를 정확히 재현) / 필드 비교 무력화 → **2건**(same-invocation + between-turn) /
  `start` catch의 소유권 확인 없는 삭제 → **1건**(교체 세션). 다섯 번 모두 정확히 원복하고
  `MUTATION` grep 0(소스·dist) · `tsc --noEmit` 0.
  - **정직한 한계**: `stop()`의 `cancelled` 플래그 **단독 제거는 어떤 테스트도 실패하지 않는다** —
    `stop`이 세션을 지우고 `status`를 `stopped`로 올리므로 `owns()`의 다른 두 검사가 같은 경로를 잡는다.
    세 신호는 **서로 중복된 방어**이고, 셋을 함께 제거하면 2건이 실패한다. `settle`의 소유권 가드도
    같은 이유로 단독 커버리지가 없다(교체 세션이 살아 있는 동안 낡은 child가 존재할 수 없다).
- **전체 suite(`npm test`) 미실행 — 이전 라운드와 같다.** M5a는 **내부 stacked M5 slice**이고,
  supervisor가 **M5b~M5d 이후 최종 M5 handoff에서 직렬 1회**를 예약했다. 미실행: `npm test` 전체 ·
  `test:core` · acceptance · stress · live · MCP · 실제 Codex/Claude 추론.
  **M5a는 supervisor의 다음 fresh 독립 리뷰 전까지 승인된 것이 아니다. M5도 미완료.**

#### M5a 5차 리비전 (2026-07-27, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰 → **REVISE**)

범위 `85ebe883..8f95877`을 **또 다른 독립 read-only 리뷰**가 봤고 판정은 다시 **REVISE**였다. 4차의 내부
linearization(첫 await 전 동기 claim · await 뒤·발행 직전 소유권 재확인 · 동기 신뢰 게이트 · 게이트 뒤 발행 ·
spawn까지 no-await)은 **그대로 유효**하고 이번에도 보존했다. 이번 findings는 **경계 밖에서 들어오는 신원과
권위**를 봤다: ⓐ 내부 상태는 원자적인데 **공개 핸들이 어느 인스턴스의 것인지**는 아무도 확인하지 않았고
ⓑ 봉인이 **호출자가 계속 들고 있는 함수·객체 두 개**(시계·승인)를 빠뜨렸으며 ⓒ 문서가 약속한 단일
드리프트 marker가 **코드·테스트와 어긋나** 있었다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| 1 | **A (P1)** | **낡은 핸들이 교체 세션을 조종한다.** `SessionHandle`에 provider 인스턴스/generation 신원이 없고 `send`/`events`/`stop`이 **`sessionId`만으로** 상태를 찾았다 → H1을 stop하고 같은 id로 H2를 start하면 **이미 반환된 H1**이 H2의 이벤트를 읽고, H2에 지시를 보내고, H2를 중지·삭제할 수 있었다(4차의 교체 테스트는 **내부 정리**만 봤고 공개 stale 핸들은 보지 않았다) | **fixed** — 세션 인스턴스마다 **내용 없는 frozen 신원 객체**를 만들어 `start`가 반환하는 핸들에 붙이고(`SessionHandle.providerBinding` — **선택 필드**라 `claude-cli`·`mock-exec`는 무영향), 모든 진입점이 **참조 동일성**으로 대조한다(`sessionId`·가변 `spec` 내용은 근거가 아니다). 낡은·위조 핸들: `send`/`events`는 **읽기·발행·spawn·변경·삭제 0**으로 `codex_stale_handle`, `stop`은 **무해·멱등**(signal·close·상태 변경·삭제 0). 그 id에 세션이 아예 없으면 기존대로 `codex_unknown_session`. 신원은 빈 객체 참조라 **로그·문서에 남길 비밀 material이 없다** |
| 2 | **A (P1) — `C-23` 2차 reopen** | **가변 `opts.nowMs` 재읽기로 승인 만료를 우회할 수 있었다.** 4차 봉인 목록에 `nowMs`가 없어 매 invocation `this.opts.nowMs`를 다시 읽었다 → 첫 turn 뒤 호출자가 **만료 전을 말하는 시계**로 갈아끼우면 경계 진입·spawn 직전 **두 만료 검사가 모두 통과**해 **실제로는 만료된 승인 아래 resume 프로세스**가 떴다. 같은 재읽기 패턴이 `this.opts.manifest`에도 있었다 | **fixed** — **시각 권위(clock)와 검증된 manifest 사본을 `start()`에서 봉인**하고 경계에는 봉인값만 넘긴다. 봉인 clock은 만료 검사마다 **다시 호출**하므로 시간은 자연스럽게 흐른다(시각 고정 아님). `SEALED_KEYS`에 `clock`·`manifestDigest`를 더해 `opts.nowMs`의 **교체·제거·추가**와 manifest **전 필드** 변경을 `codex_spec_mutated`로 잡는다. 함수 아닌 `nowMs`는 start에서 `codex_config_invalid`. **caller-owned 옵션 전수 감사**: `manifest`·`nowMs`는 봉인으로 전환, `executablePath`/`gitExecutablePath`/`controllerRepoRoot`/`spec`은 이미 봉인값 사용, `spawn`은 **생성자 포착**이라 재읽기 없음(무관함을 테스트로 고정) → **invocation 중 `this.opts`에서 읽는 실행 입력 0** |
| 3 | **A (문서/계약 불일치)** | 코드·문서는 "post-start 드리프트는 전부 `codex_spec_mutated`"라고 했지만 `assertNoSpecDrift`가 `sealCodexSpec`을 먼저 불러 **재해석 단계의 native 오류를 그대로 던졌고**, sandbox 드리프트 테스트가 `codex_sandbox_forbidden`을 기대해 **증거가 문서를 반박**하고 있었다 | **fixed** — 드리프트 비교 중의 검증 실패를 **단일 marker로 접는다**(원인 코드·경로·값 미노출). **초기 `start`는 정밀 native 코드를 그대로 유지**한다(`codex_sandbox_forbidden` 테스트 존치). sandbox 드리프트 테스트 2곳(같은 invocation · turn 사이)을 `codex_spec_mutated`로 정정하고 "무효화" 케이스(`codexHome` 삭제 · manifest 무효화)를 추가했다 — **문서·코드·증거가 이제 정확히 일치**한다 |
| 4 | **C** | 인접 감사 | `C-28`은 이번 봉인 확장으로 **실제 구현+테스트까지 마쳐 fixed**로 닫았다. **`C-27`·`C-26`은 계약을 구현하지 않았으므로 그대로 open**이며 기한·트리거·증거 필드를 유지했다. `B-7`·`B-8`·`B-9`와 `C-17`·`C-18`·`C-19`·`C-21`·`C-22`·`C-24`·`C-25`도 전부 open이다 |

검증 실측(offline, 2026-07-27 — 5차 리비전 세션):

- 파일 단독 `npx tsx --test` : `executionBoundary.test.ts` **17/17** · `codexStreamParser.test.ts` **28/28** ·
  `codexCliProvider.test.ts` **53/53**(50 → 53, 합 **98/98**, 이전 95).
- `npm run test:exec` **240/240**(237 → 240). **240은 exec suite 수치이며 파일 단독 focused가 아니다.**
- `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity** — 재빌드 후 `git diff --numstat` 변화 0) ·
  `git diff --check` clean · `node_modules` stage 0.
- **세션 신원·만료 타이밍을 건드렸으므로 stale-handle + clock/drift 회귀 7건을 반복 3회**: 3회 모두 7/7.
- **비공허성(mutation) 4종**: ⓐ 핸들 신원 대조 제거 → **2건 실패**(발급되지 않은 핸들 · 낡은 핸들) /
  ⓑ 봉인 clock 대조 제거 → **2건**(시각 권위 · 드리프트 표) / ⓒ 봉인 clock 대조 제거 **+** `this.opts.nowMs`
  재읽기(= 수정 전 상태 그대로) → **2건**이며 그중 시각 권위 테스트는 `codex_spec_mutated` 대신 **`(통과)`**,
  즉 **만료된 승인 아래 resume이 실제로 떴다** / ⓓ 드리프트 중 native 오류 허용 → **2건**(같은 invocation ·
  turn 사이 sandbox). 네 번 모두 정확히 원복하고 `MUTATION` grep 0(소스·dist) ·
  `git diff --numstat` 기준선 일치 · `tsc --noEmit` 0 · focused 53/53 재확인.
  - **정직한 한계**: ⓒ에서 **재읽기만** 되돌리고 봉인 대조를 남기면 **어떤 테스트도 실패하지 않는다** —
    현재 코드에는 동기 진입의 드리프트 검사와 경계 호출 인자 평가 **사이에 await가 없어** 호출자가 끼어들
    수 없기 때문이다. 즉 두 방어는 **중복**이고, 봉인 clock은 지금 막는 쪽이자 **앞으로 그 사이에 await가
    하나 생겨도 깨지지 않게 하는 쪽**이다. 커버리지를 과대 주장하지 않는다.
- **전체 suite(`npm test`) 미실행 — 이전 라운드와 같다.** supervisor가 **M5b~M5d 이후 최종 M5 handoff에서
  직렬 1회**를 예약했다. 미실행: `npm test` 전체 · `test:core` · acceptance · stress · live · MCP ·
  실제 Codex/Claude 추론. **M5a는 supervisor의 다음 fresh 독립 리뷰 전까지 승인된 것이 아니다. M5도 미완료.**

> **결과(2026-07-27, 5차 이후).** 그 다음 fresh 독립 Codex 리뷰가 **M5a 최종 로컬 HEAD `409dee2`를
> `APPROVE_TO_STACK` · A finding 0으로 승인**했다. 위 문단들의 "미승인" 표기는 **그 승인 이전의 dated
> 기록**이며 현행 판정이 아니다(이력으로 보존한다). 승인된 것은 **M5a slice뿐이고 M5 전체는 여전히
> 미완료**다 — 전체 suite 1회와 live acceptance는 그대로 최종 M5 handoff에 남는다.

#### M5b — stable controller bridge (offline) · **7차 리비전 완료 / 독립 8차 재리뷰·승인 대기 / live 미검증**

**상태(2026-07-30): M5b는 offline 구현 + 리비전 7회만 끝났다. 7차 리비전 이후 독립 재리뷰를 아직 받지
않았고 M5 전체도 미완료다.** 승인된 M5a HEAD `409dee2` 위에서 격리 worktree `/private/tmp/solo-founder-harness-m5b` ·
branch `work/m5b-stable-controller`로 작업했다. 로컬 커밋뿐이고 원격 push/PR/merge는 0이다.
**아래 "범위·검증 실측" 문단은 `1a94261`+`42777d9` 시점의 dated 기록이며, 현행 판정은 이 절 아래의
리비전 절들(1차 → 2차 → 3차 → 4차 → 5차 → **6차 = 현행**)이다.**

- `1a94261` — `feat(v3-m5b): stable controller bridge + close B-8/C-16/C-21/C-25/C-27`
- `42777d9` — `docs(v3-m5b): mark pre-durable pointer revalidation as a redundant defense`
- `6bc390d` — `fix(v3-m5b): seal construction authority, read-only bridge, per-call budget/pointer gates, single terminal`
  (**1차 리비전** — 1차 독립 fresh Codex 리뷰 REVISE의 A/P1 5건. 아래 별도 절.)
- `ac827bf` — `docs(v3-m5b): record independent REVISE …`
- `55b488f` — `fix(v3-m5b): 봉인 단일 읽기 · 위조 불가 read-only 증명 · 실패 turn 회계 · 닫힌 리뷰/오류 taxonomy`
  (**2차 리비전** — 2차 독립 fresh Codex 리뷰 REVISE의 A=5. 아래 별도 절.)

> **정정: "리뷰 finding 전부 closed"는 1차 리비전 시점에 사실이 아니었다.** 2차 독립 리뷰가 **같은 다섯
> 자리에서 A=5**를 다시 냈다. 아래 "M5b 1차 리비전" 절의 fixed 판정 중 **A1·A2·A3·A5는 부분적이었고**
> `B-8`도 다시 열렸다. 현행 사실은 **"M5b 2차 리비전"** 절이며, 충돌하면 그 절이 우선한다.
> **A4(포인터 재검증)만 2차 리뷰에서도 유지됐다.**

> **아래 "범위"·"검증 실측" 문단은 `1a94261`+`42777d9` 시점의 dated 기록이다.** 독립 리뷰가 그중
> **봉인 · 정책 집행 · usage · "전이 0"** 서술을 반박했다. 정정판은 **"M5b 1차 리비전"** 절에 있고,
> 충돌하면 리비전 절이 현행이다.

**범위(구현한 것)**

- `src/exec/stableController.ts`(신규) — durable M4 task를 기존 `ExecutionProvider`로 한 걸음 전진시키는
  **얇은 다리**다. `OrchestrationKernel`이 여전히 **유일한 scheduler이자 상태 전이 권위(SoR)** 이고
  controller가 kernel에 하는 일은 좁은 API 호출뿐이다:
  `scheduleReady` → `startScheduledBatch` → `registerArtifact` → `submitResult` / `acknowledgeDelivery`.
  **두 번째 scheduler·DAG·큐·상태 파일·상태 기계를 만들지 않았고 `runParallelMission`을 부르거나 감싸거나
  복제하지 않았다.**
- **run 하나는 생성 시점에 봉인된 승인·controller 신원에 묶인다.**
  - **정정(리비전 `6bc390d`)**: 이 "봉인"은 **불완전했다** — controller가 caller-owned `opts`를 실행 입력으로
    계속 재읽기했고(객체·메서드 교체가 통과) 중첩 manifest는 가변이었고 handoff 산출물은 await를 건너는
    live alias였다. 현행 봉인은 **객체+메서드 함수 포착 · 깊은 freeze · handoff 즉시 봉인**이다(리비전 절 참조).

  manifest는 **kernel(SoR)에서 읽어**
  `validateApprovalManifest`로 다시 닫고 정규 사본 + canonical digest를 봉인한다(호출자가 들고 있는 가변
  manifest를 새 baseline으로 다시 읽지 않는다 — M5a `C-23`/`C-28`과 같은 방향). controller checkout ·
  git 실행 파일 경로 · provider 신원 · 시각 권위도 함께 봉인하고, 매 advance마다 필드 단위로 대조해
  어긋나면 **단일 marker `controller_binding_drift`** 로 fail closed다.
- **승인된 커밋에서만 프로세스가 뜬다.** 모든 provider handoff(start·send) 직전에 M5a
  `verifyExecutionBoundary` → `revalidateSync()`를 지난다(대장 `B-5` 재사용 — 새 permissive 경로 0).
  cwd는 경계가 확인한 `targetRoot`만 쓴다.
- **중앙 deny-by-default 실행 정책**(`compileExecutionPolicy`) — handoff마다 결정 하나로 컴파일한다:
  정확히 승인된 명령 allowlist · 정확히 pin된 dependency · 정확히 승인된 도메인 · task 소유권과
  writableRoots · 로컬 merge 허용 · 세션/토큰/경과 예산, 그리고 **레포 hard deny**(production deploy ·
  live billing · 원격 저장소 직접 쓰기 · PR merge · MCP `@latest`). **manifest 항목이 hard deny를 덮지
  못한다.** 정책 거부는 **provider start·send 이전, 그리고 전달 수령(ack) 이전**에 일어난다.
  - **정정(리비전 `6bc390d`)**: 이 문단은 `compileExecutionPolicy`를 **실행 집행**처럼 적었으나 그것은
    **handoff 자기 선언 검증기**였고 컴파일 결과는 버려졌으며 provider 실제 권한과 독립이었다. 현행 M5b는
    **명령·쓰기·dependency·네트워크·merge·MCP 요구를 전부 거부하는 read-only bridge**이고, wrapper token
    화면을 집행이라고 주장하지 않는다. 타입 있는 집행은 대장 `B-10`(M5c)이다.
- **durable inbox는 순서대로 소비하고, ack는 그 전달 turn이 성공 종료 결과를 낸 뒤에만 한다**
  (`send` 성공만으로 ack하지 않는다 — 실패 = ack 0). provider가 준 `SessionHandle`(불투명
  `providerBinding` 포함)은 **그 객체 그대로** 들고 다닌다(직렬화·재구성 금지 — M5a 5차 계약).
- **artifact 포인터는 provider handoff 직전과 durable 직전에 다시 검증**하고(기존 `verifyArtifactFile`),
  **turn마다 `events(handle)`를 다시 부른다**(대장 `C-25`).
- **durable state에 raw는 하나도 없다**: 프롬프트 · transcript · 추론 · stdout/stderr · argv · secret 값 ·
  `SessionHandle`을 저장하지 않는다. 남는 것은 검증된 message body · bounded summary · 검증된 artifact
  포인터 · 안정 status/error marker뿐이고 **usage 카운터는 state schema가 아니라 반환값**으로 나간다.
  - **정정(리비전 `6bc390d`)**: 이 서술은 당시 **사실이 아니었다** — `resultBody`의 `## Tests and Evidence`가
    durable body에 토큰 카운트를 적고 있었다. 리비전이 durable usage를 **제거**하고 부재를 회귀로 고정했다.
    이제 문서와 구현이 일치한다(반환값 `TaskOutcome.usage`만 남는다).
- 대장 정리: `C-16` · `C-21` · `C-25` · `C-27`을 닫았다. `B-8`은 이 커밋에서 닫혔다고 적었으나
  독립 리뷰(A5)가 **중복 종료 · 부분 문자열 헤더 · 중복·모순 섹션**으로 reopen했고 리비전 `6bc390d`가
  새 증거로 다시 닫았다. 자세한 fix·증거는 위 대장 표의 각 행에 있다.

**검증 실측(offline, 2026-07-27 — M5b 구현 세션)**

- 파일 단독 `npx tsx --test`: `stableController.test.ts` **19/19** · `orchestrationKernel.test.ts`
  **68/68** · `codexCliProvider.test.ts` **58/58**.
- provider race subset **8/8**을 **직렬 반복 3회**(3회 모두 8/8) — 동시성·타이밍 계약을 건드렸기 때문이다.
- 수정 반영 후 `npm run test:exec` **268/268**. **268은 exec suite 수치이며 파일 단독 focused가 아니다.**
- `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity**) · `git diff --check` clean ·
  `node_modules` stage 0.
- **증거 라벨(정정)**: 아래 mutation·race·PASS 수치는 **구현 세션 자기보고**이며 독립 리뷰어가 재실행한
  것이 아니다. 또한 이 시점의 `B-8` mutation은 **부분 문자열 헤더 검사만** 시험했으므로 A5가 지적한
  중복 종료·중복 섹션은 덮지 못했다.
- **비공허성(mutation) — 다음 변형은 전부 테스트가 죽였다**: `B-8` fail-open 복원 · provider start 직전
  정책 검사 제거 · 전달 직전 정책 검사 제거 · 성공 결과 전 조기 ack · provider 이전 artifact 검증 제거 ·
  예전 events iterable 재사용 · `C-27` unhandled rejection · `C-21` poison 제거 · `C-16` 교차 충돌 제거.
- **살아남은 mutation 1건(정직한 기록)**: durable **직전**의 중복 artifact 포인터 재검증만 제거하면
  실패하는 테스트가 **없다** — `registerArtifact`와 바로 뒤 `submitResult`가 **사이에 await 없이** 같은
  포인터를 다시 검증하기 때문이다. 두 방어는 **중복**이므로 제거하지 않고 남기되, 코드 주석이
  **defense-in-depth이고 단독 커버리지가 없다**는 사실을 적는다(커밋 `42777d9`). 커버리지를 과대 주장하지
  않는다.

**이 slice가 아닌 것(여전히 미완료)**

- **독립 리뷰·승인**: supervisor의 **fresh Codex `gpt-5.6-sol` xhigh read-only 독립 리뷰가 다음 게이트**다.
  그 전까지 M5b는 승인된 것이 아니고, 위 fixed 판정도 재확인 대상이다.
- **전체 suite(`npm test`) 미실행 — 최종 M5 handoff(M5d 이후) 직렬 1회로 그대로 예약**돼 있다.
  미실행: `npm test` 전체 · `test:core` · acceptance · stress · live · MCP · 실제 Codex/Claude 추론.
- **live 없음**: live provider 실행 0 · 네트워크 0 · secret 사용 0 → `B-7`·`B-9`는 **여전히 열린 live
  하드 게이트**다.
- **M5c 범위**: `C-17`(kernel 만료 `>=` 경계 포함) · `C-18`(프로세스 그룹 · no-progress/wall-clock
  deadline · 자손 정리) · `C-19`(reviewer 결과를 kernel state로 옮기기 전 schema 검증) ·
  `C-22`(재시작 소유권·복구) · `C-24`(stderr 정확한 상한) · `C-26`(신뢰된 git/worktree 자동화) ·
  autopilot CLI · 실패 task의 lifecycle 전이와 pause/recovery.
- **M5d 범위**: offline self-hosting acceptance.

#### M5b 1차 리비전 (2026-07-27, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 리뷰 → **REVISE**)

범위 `409dee2..42777d9`를 **독립 read-only Codex 리뷰**가 봤고 판정은 **REVISE**였다. 앞선 M5a 5라운드가
**provider 안쪽**의 봉인·신원·linearization을 세웠고 그 계약은 그대로 유효하다. 이번 findings는 **bridge
바깥쪽**을 봤다: ⓐ controller의 "봉인"이 실제로는 호출자 소유 객체를 계속 재읽기했고 ⓑ "실행 정책"이
**집행이 아니라 자기 선언 검증**이었으며 ⓒ 게이트가 batch 진입에 **한 번만** 있었고 ⓓ 포인터 검증이 비동기
경계를 건너며 낡았고 ⓔ 종료 결과·리뷰 섹션의 **중복**이 `B-8`을 다시 열었다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| 1 | **A (P1)** | **생성 authority가 봉인되지 않았다.** controller가 caller-owned `opts`를 들고 매 advance마다 `opts.kernel`/`opts.provider`/`opts.handoff`를 **실행 입력으로 다시 읽었다** → 같은 `id`를 단 다른 provider, 같은 state를 가진 다른 kernel, 다른 handoff로 교체해도 preflight를 통과했고 **테스트 자체가 `provider.start`를 monkey-patch해 그것이 실행되기를 기대**하고 있었다. 봉인은 겉 객체만 `Object.freeze`였고 **중첩 manifest는 가변**인 채 handoff에 넘어갔다. handoff의 `spec`/`request`/`outputs`는 여러 await를 건너는 **살아 있는 alias**였고, 경계가 확인한 `targetRoot`는 **버려지고** 호출자 `cwd` 문자열이 그대로 provider에 갔다 | **fixed** — kernel·provider·handoff **객체와 호출할 메서드 함수까지** 생성자에서 포착하고 실행 입력은 그것만 쓴다(`captureKernel`/`captureProvider`). `this.opts`는 **tripwire 전용**이며 `Pin` 목록이 객체·메서드·경로·시계·`opts` 자체의 교체를 **단일 marker `controller_binding_drift`** 로 닫는다. 승인 manifest는 **깊게 복사·깊게 freeze**해 봉인하고 밖(handoff·경계)에는 **방어적 불변 사본**만 넘긴다. handoff 산출물은 **await 하나도 지나기 전에** closed 검증 → 깊은 복사 → 깊은 freeze(`sealHandoff`)한다. provider cwd는 **경계가 돌려준 `targetRoot`로 만든 새 불변 `SessionSpec`**뿐이다. `SessionHandle` 참조 동일성은 그대로 보존한다(M5a 5차 계약) |
| 2 | **A (P1)** | **정책이 자기 선언만 검증하고 실행을 집행하지 않았다.** `ExecutionRequest`는 optional이고 컴파일 결과는 **버려졌으며**, `SessionSpec`·provider 권한은 그 선언과 **독립**이었다 → **빈 request로도 edit 가능한 provider가** 명령·쓰기·네트워크·hard-deny 행위를 할 수 있었다. token 화면은 wrapper(`bin/git push` · `git -c … push` · 스크립트)를 놓쳤다. artifact 등록은 **task 소유권을 집행하지 않았다**(task A가 task B의 경로를 자기 산출물로 등록 가능) | **fixed(범위를 정직하게 좁힘)** — 이 slice는 **증명 가능한 read-only Codex planning/review bridge 하나**다. provider는 `READ_ONLY_EXECUTION_CONTRACT` **brand**를 가진 구현만 받고(문자열 `id` 위조 불가 · production 발급자는 `CodexCliProvider` 하나 · in-process 테스트 seam은 **명시적으로 brand를 다는** 형태로 드러내 둔다 · `types.ts` 주석이 **보장/비보장 범위**를 적는다), spec은 `permissionMode: "plan"` 전용이라 **ClaudeCliProvider의 기본 `acceptEdits`가 들어오지 못한다**(`allowedTools`·`addDirs`·`settingsPath`·비 read-only codex sandbox도 거부). 명령·쓰기·dependency·네트워크·merge·MCP를 요구하는 선언은 범위를 따지지 않고 `policy_not_read_only`, hard deny 의도는 그대로 `policy_hard_denied`다. **wrapper token 화면을 집행이라고 주장하지 않는다.** artifact 경로 소유권·`writableRoots`는 **권위 계층인 kernel의 `registerArtifact`**에서 집행한다(`artifact_not_owned`/`artifact_outside_writable_root` — 모든 호출자가 지나는 좁은 API 하나). 타입 있는 edit 가능 집행은 신규 대장 **`B-10`(M5c, Claude 쓰기 실행 착수 전 하드 게이트)** 이다 |
| 3 | **A (P1)** | **소진을 아는 예산으로 다음 batch task가 시작될 수 있었다.** preflight가 `advanceOnce` 진입에 **한 번만** 있어, task A가 토큰·경과 예산을 소진한 뒤에도 task B가 `runTask`에 들어가 provider를 띄웠다 | **fixed** — 봉인·만료·경과·토큰 게이트를 **provider start와 send 직전마다** 다시 본다(`assertGatesOpen` → `syncGate`). `advanceOnce`는 소진을 한 번 확인하면 남은 batch task를 **provider 호출 0**으로 같은 marker에 닫는다. 두 task 회귀가 **B의 start 수 0**을 고정한다. 이미 durable running인 task의 lifecycle 회수는 대장 **`B-11`**(M5c) |
| 4 | **A (P1)** | **artifact 포인터 검증이 비동기 경계를 건너며 낡았다.** 의존·inbox 포인터를 검증한 뒤 `await verifyExecutionBoundary`를 지나고 **재검증 없이** provider에 넘겼다 | **fixed** — 포인터를 **불변 스냅샷**으로 굳히고, 경계 await가 **끝난 뒤** 단일 동기 게이트(`syncGate`)에서 **그 스냅샷으로** 다시 검증한다. 게이트와 provider 호출 사이에 **await가 없다**. durable 쪽 검증은 그대로 유지한다. start 창·send 창 각각에 **결정론적 변조 seam 테스트**(시각 권위를 seam으로 써 production 코드에 seam을 넣지 않는다)를 붙였다 |
| 5 | **A (P1)** | **중복 종료·중복 섹션이 `B-8`을 다시 열었다.** `reviewer.ts`와 `StableController`가 종료 결과를 **덮었으므로** 실패 종료 뒤 성공 종료가 통과했고, reviewer는 헤더를 **부분 문자열**로 보고 **첫** verdict·첫 Critical만 읽어 코드 펜스 주입과 중복·모순 섹션을 통과시켰다 | **fixed** — 공용 `consumeExactlyOneTerminal`이 종료 결과를 **정확히 1건**만 받고 두 번째 종료·**종료 뒤 모든 이벤트**를 거부한다(`provider_duplicate_terminal`/`reviewer_duplicate_terminal`). reviewer는 **활성 로드맵 §5.2 `review_result`** 스키마를 **코드 펜스 밖에서** 파싱해 필수 heading 6개가 **각각 정확히 1회** · verdict **정확히 1개** · 미상/중복/모순 섹션 거부 · 대상 revision·hash를 **호출자 기대값**에 묶는다. `buildReviewPrompt`와 모든 caller/mock을 갱신했다. `B-8`은 **새 증거로 다시 닫았다** |
| 6 | **C(문서·durable)** | `resultBody`가 문서(“usage는 return-only”)와 달리 durable body에 토큰 카운트를 적고 있었다. 증거 문단이 구현 세션 자기보고를 독립 재실행처럼 읽히게 적혀 있었고, 테스트 제목이 state가 `running`인데 "전이 0"을 주장했다 | **fixed(문서·구현 동시)** — durable `resultBody`에서 토큰 usage를 **제거**하고 부재를 회귀로 고정했다(반환값 `TaskOutcome.usage`는 그대로). 대장·§10·WORKLOG·CONTEXT_SUMMARY·CODEX_HANDOFF의 봉인·hard-deny·usage·"전이 0" 서술을 정정했고, 이전 PASS/race/mutation 실측은 **구현 세션 자기보고**로 라벨링했다(독립 리뷰어가 재실행한 것이 아니다). 테스트 제목은 "spawn 0 · task는 kernel이 이미 running으로 올렸다"로 고쳤다 |

**신규·재분류 유예(§9.1의 "M5b 1차 리비전" 표)**: `B-10`(타입 있는 실행 집행 — M5c Claude 쓰기 전) ·
`B-11`(batch 전체 running vs per-task preflight — M5c autopilot 전) · `B-12`(재시작 시 예산 회계 초기화 —
늦어도 M5c) · `B-13`(durable 완료가 provider 정리 확인보다 먼저 · `stop` 실패 삼킴 — M5c live runner 전) ·
**`C-12` → B(P1) 재분류**(트리거 발화: 실패한 전달이 running task에 unack로 남고 ready-only advance가
재시도하지 않는다 — M5c autopilot 전). `C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26`은 **손대지 않았고
fixed로 주장하지 않는다**.

**검증 실측(offline, 2026-07-27 — M5b 1차 리비전 세션. 아래 수치는 이 세션이 실제로 돌린 명령의 출력이다)**

- 파일 단독 `npx tsx --test --test-timeout=180000`: `stableController.test.ts` **36/36**(19 → 36) ·
  `reviewer.test.ts` **14/14** · `orchestrationKernel.test.ts` **70/70**(68 → 70) ·
  `codexCliProvider.test.ts` **58/58** · `executionBoundary.test.ts` **17/17** ·
  `sessionRunner.test.ts` **7/7**.
- `npm run test:exec` **295/295**(268 → 295) — **exec suite 수치이며 파일 단독 focused가 아니다.**
- 스트림·비동기 경계 순서를 건드렸으므로 **중복 종료 + 포인터/예산 race subset 14건을 직렬 반복 3회**:
  3회 모두 **14/14**(`--test-name-pattern='A[345]:'`, `stableController.test.ts` + `reviewer.test.ts`).
- `registerArtifact` 불변식을 건드렸으므로 **kernel 계열 offline acceptance를 개별 재실행**:
  `node scripts/m4a-offline-acceptance.mjs` **PASS=31 FAIL=0** · `m4b` **PASS=42 FAIL=0** ·
  `m4c` **PASS=77 FAIL=0**. **`scripts/acceptance.sh` 전체는 미실행.**
- `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity** — 커밋 후 재빌드 시 `git status` 변화 0) ·
  `git diff --check` clean · `node_modules` stage 0.
- **비공허성(mutation) 6종 — 전부 죽었고 전부 `git checkout --`로 정확히 원복**했다
  (`MUTATION` grep 0 · `git diff --numstat` 기준선 0줄):
  ⓐ 포착 메서드 대신 `this.opts.provider.start` 재읽기 + 메서드 신원 pin 제거 → **1건 실패**(monkey-patch) /
  ⓑ `frozenClone`의 깊은 복사·freeze 제거 → **4건**(중첩 manifest 불변 · in-flight 변조 · 새 불변 spec ·
  closed 검증) / ⓒ 경계 await 뒤 포인터 재검증 제거 → **2건**(start 창 · send 창) /
  ⓓ per-task 예산 게이트 + 동기 게이트의 예산 재확인 제거 → **2건**(토큰 · 경과) /
  ⓔ 공용 소비자의 중복 종료·종료 뒤 이벤트 거부 제거 → **5건**(controller 3 · reviewer 2) /
  ⓕ reviewer의 중복 섹션 거부 제거 → **1건**.
- **여전히 살아남는 mutation 1건(정직한 기록 · `42777d9`과 동일)**: durable **직전**의 중복 artifact
  포인터 재검증만 제거하면 실패하는 테스트가 **없다** — `registerArtifact`와 바로 뒤 `submitResult`가
  **사이에 await 없이** 같은 포인터를 검증한다. 중복 방어로 남기고 주석이 그 한계를 직접 말한다.
- **미실행**: `npm test` 전체 · `test:core` · `scripts/acceptance.sh` 전체 · stress · live · MCP ·
  실제 Codex/Claude 추론 · 원격 push/PR/merge. 전체 suite 1회는 **최종 M5 handoff(M5d 이후) 직렬 1회**로
  그대로 예약돼 있다.
- **증거 라벨 정정**: 위 수치와 `1a94261` 시점의 수치는 **구현·리비전 세션의 자기보고**다. 독립 리뷰어는
  read-only이며 이 명령들을 **재실행하지 않았다**. static 테스트 개수만이 커밋된 소스로 독립 확인 가능하다.

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인**(supervisor의 다음 fresh Codex read-only 리뷰가
게이트다 — 위 fixed 판정 전부가 재확인 대상) · 전체 suite 1회 · live · M5c(`B-10`~`B-13` · `C-17`·`C-18`·
`C-19`·`C-22`·`C-24`·`C-26` · autopilot CLI · pause/recovery) · M5d(offline self-hosting acceptance).
**M5 전체는 미완료다.**

> **후속(2026-07-28): 위 "fixed" 여섯 판정 중 다섯이 부분적이었다.** 2차 독립 리뷰가 A1·A2·A3·A5를
> 다시 열었다(A4만 유지). 아래 절이 현행이다.

#### M5b 2차 리비전 (2026-07-28, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰 → **REVISE, A=5**)

같은 다섯 자리를 다시 봤고 **전부 "고쳤다고 적은 곳이 여전히 열려 있었다"** 는 형태였다. 이번 리비전
`55b488f`가 그 다섯을 닫았고 **A4(포인터 재검증)는 손대지 않고 유지**했다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| A1 | **A (P1)** | **생성 authority가 여전히 재읽기·재진입 가능했다.** `captureKernel`이 대부분은 bind했지만 `scheduleReady`/`startScheduledBatch`는 **호출 시점에 caller 소유 property를 다시 읽는 wrapper**였다. 생성자 검증도 `typeof k[m] === "function"`으로 본 **뒤** `k.m.bind(k)`로 다시 읽었으므로, 교대 getter/proxy면 "검사한 함수"와 "실행하는 함수"가 갈렸다(그리고 pin은 둘 다 두 번째 값이라 통과했다). 재진입 `nowMs`는 pin 통과 **뒤** 메서드를 갈아끼워 교체본을 실행시킬 수 있었다 | **fixed** — caller 소유 property(kernel·provider·handoff·경로·시계·`provider.id`)를 생성자에서 **지역 변수로 정확히 한 번** 읽고, 검증·봉인·실행·pin 기준을 전부 **그 값**으로 한다. `captureMethods`가 메서드를 한 번 읽어 그 값을 검증하고 **그 값을 bind**한다 → 재읽기 wrapper가 남아 있지 않다. 회귀: **재진입 시계**가 게이트 통과 뒤 `scheduleReady`/`startScheduledBatch`를 갈아끼워도 `patched === 0`이고 다음 게이트가 `controller_binding_drift`로 닫는다 · **교대 getter**(첫 읽기만 진짜)는 두 번째 값을 실행하지도 권위로 받아들이지도 않는다 |
| A2 | **A (P1)** | **read-only provider 권위가 호출자 위조 가능이었다.** `READ_ONLY_EXECUTION_CONTRACT`가 `types.ts`에서 **공개 export** 됐으므로 같은 프로세스의 아무 provider나 import해 자기에게 달 수 있었다 — 집행이 아니라 자기 신고였고, 그때의 "production 경로" 테스트는 **brand가 붙어 있다**는 것만 증명했다 | **fixed(범위는 정직하게 좁게)** — 공개 brand를 **제거**하고 `codexCliProvider.ts`에 **모듈 사설 `WeakSet`** 을 뒀다. 등록 경로는 `CodexCliProvider` 생성자 하나뿐이고, 밖으로 나가는 것은 판정 함수 `attestReadOnlyCodexProvider` 하나다(**발급기·토큰·임의 provider를 증명하는 factory는 내보내지 않는다**). 판정 = WeakSet + `prototype` 동일성 + 4개 메서드 **함수 신원**이고, 통과하면 **그 한 번의 읽기 결과**를 돌려주어 A1의 재읽기 창도 열지 않는다. `CodexCliProvider.prototype`은 얼려 인스턴스 대입 자체가 던지게 했다. 거부 회귀: property/심볼 복사 · `Object.create`/`setPrototypeOf` 위조 · subclass(**override 유무 무관**) · 인스턴스 메서드 override · `Proxy` wrapper · 임의 scripted provider · "증명 표면이 늘지 않았다"(모듈 export 감사). **production 경로 회귀**: 실제 `CodexCliProvider` + **주입 spawn seam**으로 controller가 끝까지 전진한다(live codex/claude·네트워크·자식 프로세스 0). **주장 범위**: 같은 프로세스에서 *공개 API만으로는* 못 들어온다 — **OS 샌드박스 격리가 아니다** |
| A3 | **A (P1)** | **실패한 terminal의 usage가 전역 예산에서 빠지지 않았다.** 공용 소비자가 `result.isError`에서 **먼저 던졌으므로** controller의 `applyTurn`이 돌지 않았다 → 토큰을 태운 실패 turn 뒤에도 예산이 그대로였고 다음 task가 시작됐다 | **fixed** — `consumeExactlyOneTerminal`이 종료 1건을 확정한 뒤 **`isError`를 해석하기 전에** `onTerminal`을 **정확히 한 번** 부르고 controller가 거기서 bounded usage를 회계한다. A4(정확히 1건 · 종료 뒤 이벤트 거부 · bounded · 닫힌 taxonomy)는 그대로다. 회귀: 실패 turn 5토큰이 상한 5를 소진 → 다음 task는 `budget_tokens_exhausted` · turn 0 · provider 호출 1회뿐이고 다음 advance도 차단 / 실패(5) + 성공(5) = **정확히 10**(이중 회계 없음) |
| A5a | **A (P1)** | **리뷰 파서가 허위 승인을 계속 받았다.** 대상 신원을 `includes`로 봐서 라벨 뒤바뀜·접두/접미·"다른 대상 + 기대값 언급"이 통과했고, 펜스가 **여는 길이를 잊어** 3-백틱이 4-백틱 블록을 닫았으며(가짜 `## Verdict: pass` 노출), findings의 미상 비공백 줄을 조용히 무시해 `- 없음` + `P1: 승인 우회`가 함께 통과했다 | **fixed** — 대상 섹션은 비공백 줄이 **정확히 `- revision:` 1개 · `- hash:` 1개**이고 값이 기대값과 **완전 일치**여야 한다(중복 라벨·미상 줄·한 줄 두 값 거부). 펜스는 **문자 + 여는 길이**를 기억하고 같은 문자·여는 길이 이상·뒤 공백만인 줄로만 닫는다(정보 문자열이 붙으면 닫는 펜스가 아니다 · 틸드 동등). findings의 미상 비공백 줄은 **거부**하고 항목 본문은 nonempty·`MAX_FINDING_CHARS` 이하다. 필수 heading은 각 1회 + **정확한 순서**다. `B-8`을 **세 번째 증거로** 다시 닫았다 |
| A5b | **A (P1)** | **임의 provider/reviewer 오류 코드가 닫힌 taxonomy를 빠져나갔다.** `consumeExactlyOneTerminal`이 "문자열 `code`를 가진 Error"면 무엇이든 통과시켰다 → provider가 `code: "result_accepted"`를 달고 던지는 것만으로 **성공처럼 보이는 marker를 단 실패 outcome**을 만들 수 있었다(M5c 분기가 그 marker를 읽는다) | **fixed** — 공용 소비자는 **자기가 만든 오류만**(참조 동일성) 통과시키고 나머지는 전부 `codes.streamFailed`다(`throw null`도 안전하게 접힌다). controller는 handoff·`start`·`send`·`events()`를 각각 `handoff_failed`/`provider_start_failed`/`provider_send_failed`/`provider_stream_failed`로 접고, reviewer는 전부 `reviewer_provider_failed`다. `finally`의 `stop()` **동기 throw**도 삼켜 확정된 결과를 덮지 않는다. kernel(SoR) 코드는 권위이므로 그대로 올라온다 |
| A4 | **(유지)** | 1차 리비전이 닫은 "포인터를 경계 await 뒤 · provider 호출 직전에 재검증" + "종료는 정확히 1건" 계약 | **그대로 유지** — 실패 결과 처리만 바꿨고(A3) 정확히 1건 · 종료 뒤 이벤트 거부 · bounded event · 결정론적 taxonomy는 회귀로 계속 고정된다 |

**신규 유예(§9.1 "M5b 2차 리비전 신규 유예" 표)**: `C-29`(중첩 handoff schema가 복사·freeze만 되고 closed
검증은 top-level까지 — 기한 **M5c 구조화 필드**) · `C-30`(중복 종료·결과 부재 방어가 codex 경로로는 도달
불가 — 기한 **M5c 두 번째 provider 배선**) · `C-31`(테스트가 provider 내부 2곳을 white-box 관측 — 기한
**`B-13` 구현 시**). **`C-2`는 트리거가 M5b에서 이미 발화했던 overdue 항목으로 이번에 닫았다**(진입점 5개 전수 명시).
`C-17`·`C-18`·`C-19`·`C-22`·`C-24`·`C-26`은 **손대지 않았고 fixed로 주장하지 않는다.**

**확정 기한(변경 없음 — 다시 명시)**: `B-7` **첫 live 전** · `B-9` **첫 live 전** · `B-10` **M5c에서
Claude/edit 가능 provider를 켜기 전** · `B-11` **M5c autopilot/무인 advance 착수 전** · `B-12` **자동
재시작/resume 도입 전, 늦어도 M5c** · `B-13` **live 프로세스를 띄우는 provider 배선 전** ·
`C-12`(→B(P1)) **M5c autopilot 착수 전**.

> **후속(2026-07-28, 같은 날 늦게): 위 A2·A5b "fixed"도 같은 뿌리가 남아 있었다.** 3차 독립 리뷰가
> **A=3**(공개 `spawn` seam으로 증명 위조 · exported class로 오류 provenance 위조 · 비원자적 완료)을 냈다.
> 아래 절이 현행이다.

#### M5b 7차 리비전 (2026-07-30, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰 `409dee2..ff5e035` → **REVISE, A/P1=2 · B=7 · C=12**)

**공통 뿌리는 "검증을 트랜잭션 1회 단위로 잡았다"** 이다. 6차 리비전은 *무엇이 권위인가*(승인 manifest ·
내용 digest · 묶인 journal)를 바로잡았지만 **언제 다시 보는가**를 넓게 잡았다: ⓐ git은 **경계 진입 1회**만
해싱하고 그 뒤 `readCheckoutHead()`가 **두 자식 프로세스**를 await했으므로 첫 프로세스가 도는 동안 승인
파일을 제자리에서 덮어쓰면 두 번째가 승인되지 않은 바이트를 실행했고 ⓑ body는 **전수 preflight 1회** 뒤
경로 이름 그대로 link했으므로 그 사이 staging 교체본이 최종 body가 되고 journal까지 삭제됐다.
이번 리비전은 검증 단위를 **spawn 1회 / 발행 1건 / 삭제 직전 전수**로 좁힌다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| A1 | **A (P1)** | **git 내용이 spawn마다 재검증되지 않는다.** `verifyExecutionBoundary()`가 git을 한 번 해싱·pin한 뒤 `readCheckoutHead()`가 `--show-toplevel`과 `rev-parse HEAD`를 **각각 await**했다 → 첫 프로세스를 기다리는 동안 owner-writable 승인 실행 파일이 **같은 inode를 제자리에서** 덮어쓰면 두 번째 프로세스가 **SHA-256이 승인되지 않은 바이트**를 실행한다. 그 payload는 임의 작업을 하고 기대 HEAD를 출력하고 원 바이트를 되돌릴 수 있으므로 뒤 검사도 통과한다. `revalidateSync()`도 루프 **앞에서** 한 번 해싱하고 checkout마다 `spawnSync`했다. 문서화된 fd→exec syscall 창보다 **자식 프로세스 수명만큼 넓다** | **fixed** — ① `GitGate = () => string` 하나를 두고 **모든 git spawn이 자기 `runProcess`/`spawnSync` 직전에** 그것을 지난다: 같은 fd(`O_RDONLY\|O_NOFOLLOW`)에서 정규 경로·비symlink 일반 파일·실행 비트·타인 쓰기 없음·**pin된 dev+ino**·**승인된 내용 SHA-256**을 다시 판정하고 실행 경로를 돌려준다 ② 게이트 호출과 spawn 사이에 **`await`가 없다**(`runProcess`는 Promise executor 안에서 동기로 `spawn`한다). 게이트 실패는 `boundary_git_failed`로 접지 않고 `boundary_git_digest_mismatch`/`boundary_git_identity_changed`로 그대로 올린다 ③ `readCheckoutHead()`의 **두 호출 각각** · `revalidateSync()`의 **controller/target 회차 각각**이 자기 게이트를 지난다(루프 앞 1회 검증은 제거 — spawn별 게이트가 그것을 포함한다) ④ 남는 창은 **fd 해싱→exec syscall 몇 개**뿐이며 그 한계를 정직하게 문서화했다(Node에 `fexecve` 없음 — 대장 `C-5`와 같은 종류). 호출자 경로·PATH 조회·ambient env·대체 trust root·신규 의존성은 없고 manifest-only 실행 권위와 provider/controller attestation 계약은 그대로다 ⑤ 회귀: **자기 inode를 제자리에서 sentinel payload로 덮어쓰는 승인 wrapper**(`{ }` 묶음으로 `sh`가 전체를 먼저 파싱 → 자기 절단이 안전, 자식 env에 PATH가 없으므로 builtin·절대경로만)로 ⓐ 같은 checkout(첫 조회 뒤 두 번째 spawn 차단) ⓑ **controller/target 분리 checkout**(controller HEAD 뒤 target 조회 차단) ⓒ **`revalidateSync()` 다중 root 루프**(1회차 뒤 2회차 차단) — 전부 `boundary_git_digest_mismatch`이고 **sentinel 실행 0**, 각각 **양성 대조군 + 정확한 spawn 수**(2·3·4·6·7)까지 단정 |
| A2 | **A (P1)** | **body 발행이 검증 이후 교체본을 link하고 복구 증거를 지울 수 있다.** `publishOwnedBodies()`가 **전수 preflight** 뒤 발행 hook을 부르고 **staging 경로 이름 그대로** `linkSync`했다 → hook이나 durable journal을 읽는 **같은 UID의 동시 writer**가 preflight 이후 staging을 갈아끼우면 그 교체본이 최종 body가 되고 staging은 지워지고 `commit.journal`까지 삭제된다. 다른 digest면 **"성공한 target state + 잘못된 body"**(reopen이 뒤늦게 탐지하지만 이미 복구 증거가 없다), 같은 digest면 **남의 inode 입양**이다. 게다가 이미 발행된 body의 소유를 dev/ino/**size**로만 봤으므로 **같은 inode·같은 크기 제자리 내용 변경** 뒤에도 journal이 삭제됐다 | **fixed** — ① `ownershipOf(file, journalBody)`가 **열린 fd 하나로** dev+ino · **정확한 바이트 수** · **내용 SHA-256**을 전부 판정한다(`absent`/`ours`/`foreign`, `O_NOFOLLOW`라 symlink는 열리지 않고 ENOENT만 "아직 없다"다) → `lstat` 뒤 경로를 다시 읽는 창이 없다 ② **hook 이후·`linkSync` 직전**에 staging을 다시 증명한다(같은 digest의 다른 inode도 거부 — 입양 금지) ③ **`linkSync` 직후** 만들어진 최종 이름을 다시 증명한다 → EEXIST 경합·교체본 link를 그 자리에서 `journal_body_foreign`으로 접고 **staging(= body 바이트의 유일한 사본)을 지우지 않는다** ④ `finishJournal()` 하나가 **journal 삭제의 유일한 경로**다(정상 커밋 + "이미 목표 state" 복구 둘 다): `journal:cleanup` hook을 **먼저** 울린 뒤 journal이 고정한 **모든** 최종 body를 전수 재증명하고(앞선 시도가 발행한 것까지) 하나라도 어긋나면 **journal을 남기고** fail closed다 ⑤ roll back은 `finishJournal`을 쓰지 않는다(발행 순서상 최종 body가 애초에 없다 — 이유를 주석에 남겼다). 초기 생성·기준 roll back 동작은 그대로다 ⑥ 어떤 경로도 남의 최종 body를 지우거나 덮거나 채택하지 않고, 실패를 조용히 성공으로 바꾸지 않으며, 재시도는 결정론적·멱등이다 ⑦ 정직한 한계: `link(2)`는 **경로 이름**을 받으므로 "증명한 fd를 그대로 link"할 수 없다(Node에 `AT_EMPTY_PATH` 없음) → 증명→link 창을 0으로 만들지 못하고 **link 직후 + 삭제 직전** 재증명으로 사후 탐지한다 ⑧ 회귀: 발행 hook의 **same/different-digest staging 교체** · **다중 body 부분 발행** 중 (뒤 staging 교체 / 이미 link된 앞 최종 body의 같은 크기 제자리 변경) · **`journal:cleanup`에서 같은 크기 다른 내용 변경**(→ 거부 · journal 보존 · reopen도 완료로 보고하지 않음) · **link 직후 증명이 EEXIST 경합을 잡고 staging 증거를 남김** · **이미 발행된 최종 body의 멱등 재시도 양성 대조군** — 전부 바이트·디렉터리 엔트리·journal 생존과 "남의 파일 미삭제·미덮어쓰기"를 단정한다 |

**정직한 한계(주장하지 않는 것)**: ⓐ git은 **해싱한 fd를 그대로 exec하지 않는다** → 창이 0이라고
주장하지 않는다(syscall 몇 개 · `C-5`와 같은 종류). ⓑ body 발행도 **증명한 fd를 link하지 않는다**(같은
종류의 한계) → 사후 탐지로 보완한다. ⓒ `C-7`(키 없는 state↔event digest)·`C-37`(caller가 본 실패와
durable 진실의 갈림)·`C-36`(export된 fault seam)은 **그대로 열려 있다**. ⓓ hard-link 발행의 POSIX·같은
파일 시스템 전제도 그대로다.

**B/C 처리(§9.1 "M5b 7차 리비전 신규·갱신 유예" 표)**: 리뷰의 **B 7건은 그대로 유지**한다
(`B-7` · `B-9` · `B-10` · `B-11` · `B-12` · `B-13` · `C-12`→B) — 이번 A 작업과 겹쳐 실제로 닫힌 것은
**하나도 없다.** 리뷰의 **C 12건** 중 11건(`C-35` · `C-5` · `C-17` · `C-29` · `C-19` · `C-36` · `C-37` ·
`C-30` · `C-38` · `C-39` · `C-26`)은 **상태·기한 그대로 open 유지**하고, ID가 없던 **승인 경로 schema
regex와 runtime의 갈림**을 신규 **`C-40`** 으로 등록한 뒤 **이번에 정렬해 닫았다**(정본 pattern 하나를
runtime·schema가 공유 · 양/음성 표 전수 동치 테스트 · 사전 실측 1021 케이스 불일치 0 · 양방향 mutation kill).
**`C-36`은 증거만 갱신했다**(hook은 던지기만 하지 않고 **동기 파일 변경도 한다** — 그렇게 주장한 source
주석을 정정했고 A2가 그 변경을 fail closed로 잡는다. export된 가변 전역 절충은 open).
**`C-37`은 닫지 않았다** — 6차 source 주석의 "`C-37` 닫힘"은 사실이 아니었으므로 store·kernel·controller
주석을 사실대로 고쳤고, 목표 state durable 이후 실패는 여전히 caller-visible 결과와 갈릴 수 있다.

**mutation 비공허성(실측 9종, 전부 kill · 전부 바이트 동일 원복 · `MUTATION` 잔재 0)**: ① 경계 —
게이트를 경계당 1회로 memoize(옛 동작) → **4건 fail**(신규 3 + 6차 회귀 1) ② 경계 — `git()`의 spawn별
게이트만 제거 → **2건** ③ 경계 — `headSync()` 회차별 게이트 제거 + 루프 앞 1회 검증 복원 → **1건**
④ store — link **직전** 재증명 제거 → **2건** ⑤ store — link **직후** 재증명 제거 → **1건**
⑥ store — journal 삭제 직전 전수 sweep 제거 → **2건** ⑦ store — `ownershipOf` 내용 digest 대조 제거
→ **2건** ⑧ store — `journal:cleanup` hook을 전수 sweep **뒤**로 → **1건** ⑨ schema/runtime 경로 regex를
**양방향으로** 갈라놓기(schema만 옛 regex / runtime만 옛 regex) → **각 1건**. **살아남은 mutation 0건.**
원복은 레포 밖 사본과 `shasum -c`로 바이트 동일성을 확인했다(`MUTATION` grep 0).

**이 리비전이 실행한 테스트(worker 자기보고 — 독립 리뷰 아님)**: 파일 단독 `orchestrationKernel.test.ts`
**103/103**(98 → 103) · `stableController.test.ts` **58/58** · `codexCliProvider.test.ts` **59/59** ·
`executionBoundary.test.ts` **20/20**(17 → 20) · `reviewer.test.ts` **21/21** ·
`codexStreamParser.test.ts` **28/28** · `npx tsc --noEmit --pretty false` clean ·
`npm run build` + `git diff --check` clean + `node --check` 5개 emitted 파일 ·
**dist 런타임 프로브 2종**(ⓐ A1: 첫 조회 뒤 제자리 교체 → `boundary_git_digest_mismatch` · spawns=1 ·
sentinel 미실행, C-40: `/a//b`·`/a/./b`·`/a/../b` → `invalid_manifest` ⓑ A2: `journal:cleanup`에서 발행된
body를 같은 크기로 제자리 변경 → `journal_body_foreign` · **journal 보존** · 변경된 파일 미삭제·미덮어쓰기 ·
**reopen도 완료된 run으로 보고하지 않음**) · **승인 schema와 발행 프로토콜이 바뀌었으므로 kernel 계열
offline acceptance 3개 개별 재실행**: `m4a` **31/31** · `m4b` **42/42** · `m4c` **77/77** ·
**race-sensitive subset(경계+kernel 2파일) 3회 직렬 123/123** ·
**`npm run test:exec` 361/361**(353 → 361, **최종 원복 구현으로 1회**).
**`npm test` 전체 suite·전체 `acceptance.sh`·stress·live는 실행하지 않았다**(최종 M5d handoff에서
supervisor가 직렬 1회). live provider 추론·네트워크·secret·MCP·remote git 쓰기·push는 0이다.

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인**(다음 fresh Codex `gpt-5.6-sol` xhigh read-only
**8차** 리뷰가 게이트이고 위 fixed 판정 전부가 재확인 대상이다 — 이 세션은 스스로를 승인하지 않는다) ·
전체 suite 1회 · live · M5c · M5d. **M5 전체는 미완료다.**

#### M5b 6차 리비전 (2026-07-28, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰 `409dee2..6a5e418` → **REVISE, A/P1=2 · B=7 · C=10**)

> **정정(2026-07-30, 7차 독립 리뷰) — 이 절의 "둘 다 6차 리비전에서 닫았다"는 부분적으로만 사실이었다.**
> 7차 리뷰는 **A1을 PARTIAL**(승인 manifest가 trust root인 것·같은 fd digest·Codex 최종 spawn 무-await은
> 닫혔지만 **git 검증이 프로세스 1회**여서 `readCheckoutHead()`의 두 프로세스 사이·`revalidateSync()`
> 루프 회차 사이에 제자리 덮어쓰기가 통과했다) · **A3를 PARTIAL**(roll forward 폐기·journal 묶기·
> no-clobber·남의 body 보존은 닫혔지만 **발행 preflight 이후 staging 교체본이 link되고 journal이 삭제**될
> 수 있었다)로 판정했다. **초기 A2는 CLOSED · 초기 A4는 PARTIAL**이다.
> 이 절은 dated history로 보존하고 현행 판정은 위 **7차 리비전** 절이다.

**공통 뿌리는 "권위의 근거를 같은 caller 입력·자기 일관성에서 찾았다"** 이다. 5차 리비전은 *증명할 값*
(실행 파일 신원·journal 필드)을 넓혔지만, ⓐ 실행 파일의 **기대값 자체가 caller 옵션**이었으므로 provider와
controller에 **같은 임의 경로**를 주면 대조가 성립했고(신원이 path/dev/ino뿐이라 **같은 inode 제자리
덮어쓰기**도 통과했다) ⓑ journal은 **자기 안에서만** 일관됐으므로 해시를 전부 다시 계산한 **위조 후속**을
복구가 그대로 발행했다. 이번 리비전은 근거를 **kernel 소유 승인(manifest) · 내용 digest · "복구는 후속을
만들지 않는다"** 로 옮긴다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| A1 | **A (P1)** | **caller가 고른 임의 Git/Codex 실행 파일이 production 권위로 승인된다.** provider `executablePath`/`gitExecutablePath`와 controller `codexExecutablePath`/`gitExecutablePath`가 **같은 caller 입력**이라 `/usr/bin/true`나 사용자 소유 0700 sentinel을 양쪽에 주면 path/dev/ino가 같아 `authorityMatches: true`가 됐다(리뷰의 읽기 전용 프로브 실측: `{"attested":true,"authorityMatches":true,"executable":"/usr/bin/true"}`). 실행 파일 신원도 dev/ino뿐이라 **같은 inode 제자리 덮어쓰기**는 재검증을 그대로 통과했다 | **fixed** — ① **승인 manifest가 trust root다**: `MilestoneApprovalManifest`에 필수 필드 **`executionAuthority`**(codex·git 각각 **정규 절대경로 + 내용 SHA-256**)를 추가했다. 이 승인은 run 생성 시 durable state에 들어가 `stateContentDigest` → state↔event binding으로 봉인되므로 손편집이 거부된다 ② **실행 파일 경로를 고르는 호출자 옵션을 전부 삭제**했다(`CodexCliProviderOpts.executablePath`/`gitExecutablePath` · `StableControllerOpts.codexExecutablePath`/`gitExecutablePath` · `ExecutionBoundaryInput.gitExecutablePath`) — provider·controller·경계 모두 `manifest.executionAuthority`만 읽는다 ③ 새 `verifyApprovedExecutable()`이 경로를 **한 번만 열고**(`O_RDONLY|O_NOFOLLOW`) 같은 fd에서 정규 경로 · 비symlink 일반 파일 · 실행 비트 · group/other 쓰기 없음 · **pin된 dev+ino** · **승인된 내용 SHA-256**(64KiB chunk 스트리밍 · 512MiB 상한)을 전부 판정한다 → **provider 생성 · controller 생성 · 경계 진입 · spawn 직전 동기 게이트**에서 각각 다시 부르므로 같은 inode 제자리 덮어쓰기가 `codex_executable_digest_mismatch`/`boundary_git_digest_mismatch`로 fail closed다 ④ controller는 **kernel(SoR) 승인**에서 온 두 경로를 **자기 손으로** 열어 검증한 뒤 checkout·승인 digest·시각 권위와 함께 기대 권위를 만들고, 불일치는 **git·codex spawn 이전에** `controller_provider_authority_mismatch`로 생성 거부다 ⑤ **하위 호환은 fail closed**: `executionAuthority`가 없는 manifest·state는 `invalid_manifest`로 거부되고 조용한 기본값이 없다(마이그레이션 도구 없음 — `C-9`와 같은 판단) ⑥ 회귀: 승인과 다른 codex 경로 · 승인과 다른 git 경로 · **caller가 양쪽에 같은 임의 sentinel 경로를 지정** · 승인 digest 불일치 · **발급 뒤 controller 생성 전 제자리 덮어쓰기** · **생성 뒤 advance 전 제자리 덮어쓰기**(spawn 0) · 같은 경로 다른 inode(생성·실행 두 시점) · path/mode 위반 · **manifest가 정확히 승인한 offline fake 실행 파일 양성 대조군** — 전부 **codex·git sentinel 미실행**. custom-spawn 비증명 · 모듈 사설 발급 · `#private`/freeze/own property 0 · read-only sandbox · strict empty MCP · argv·env 계약은 그대로다 |
| A3 | **A (P1)** | **복구 journal이 base 승인·전이나 정확한 body 소유권에 묶이지 않는다.** ⓐ 해시를 전부 다시 계산한 **완전히 일관된 위조 후속**(다른 milestone·다른 승인 manifest·다른 task state)을 `baseIsOnDisk` + roll forward가 그대로 발행했다 ⓑ event "정규형"을 `JSON.stringify(JSON.parse(line))`와 비교해 **key 순서를 바꾼 event**가 통과했다 ⓒ body는 journal에 등장하는지만 봤고 **base→target 새 메시지 delta**와 대조하지 않았으며, 같은 digest의 **남의 최종 body를 채택**하고 다른 내용의 최종 파일을 `renameSync`로 **덮고** rollback에서 digest만 같으면 **지웠다** | **fixed** — ① **roll forward 폐기**: 복구 규칙은 "디스크가 **기준 원본 바이트**면 → **roll back**(자기 staging 제거 + `events.jsonl`을 기준 길이로 truncate) / 디스크가 **정확히 목표 바이트**면 → 마무리(body 발행 + journal 삭제) / 그 밖 → fail closed" 둘뿐이다 → **복구는 후속 state를 만들 권한이 없다.** 완전한 append도 state가 없으면 되돌린다(그 바이트의 소유는 우리 journal이 증명한다) ② 발행 순서를 **journal → append → snapshot → state → body(최종 이름)** 로 바꿨다 → 기준 상태 복구가 최종 body를 만들 필요도, **증명되지 않은 최종 body를 지울 필요도** 없다 ③ journal `base`에 **불변 권위**(milestone · 승인 manifest digest · 내용 digest · 생성 시각 · 메시지 수)를 담고, target이 그것을 바꾸면 `journal_foreign`이다. 복구는 디스크 기준 state를 **전수 대조**한다(원본 바이트 digest + 파싱 필드 전부) ④ **기준 event 접두 신원**을 검증한다(앞 `baseEventBytes` 바이트가 정확히 `base.lastEventId`줄 · 마지막 줄 hash = `base.lastEventHash`) → `baseEventBytes`를 줄여 **남의 감사 바이트를 자기 append로 주장**하는 경로가 닫힌다 ⑤ event 정규형은 **`JSON.stringify(validateEvent(parsed))`** 와 비교하고 `commitRun`도 같은 함수로 직렬화한다(key 순서 위조 불가 · 정본 하나) ⑥ journal `bodies[]`는 **base→target 새 메시지 delta와 정확히 같아야** 하고(개수 항등식 + 기준 state 대조 시 id 집합) 항목마다 **digest · 정확한 바이트 수 · staging의 dev+ino**를 담는다 ⑦ 발행은 **no-clobber CAS**다: `link(2)`는 대상이 있으면 EEXIST이므로 덮어쓰기가 원자적으로 불가능하고, 최종 경로가 이미 있으면 **journal이 기록한 dev+ino·크기**가 같을 때만 "우리 것"이며 **digest가 같아도 남의 파일은 채택하지 않는다**(`journal_body_foreign`). rollback은 **자기 staging만** 지운다(digest 기반 최종 body 삭제 제거) ⑧ 회귀: 위조 후속 4케이스(task state · milestone · 승인 확대 · 생성 시각) · reordered event keys · body delta 누락/추가/기준 id 주장 · same-digest·different-digest 남의 최종 body · **계획과 발행 사이 최종 파일 등장** · rollback에서 same-digest 남의 body 보존 · **기준 + 완전 append roll back** · 다중 body 부분 발행 + 복구 I/O 실패 후 재시도 멱등 · 목표 바이트인데 불완전 append · 무효 journal 표(신규 기준 신원·body 소유 필드 포함) — 전부 **바이트·디렉터리 엔트리 보존** 단정 |

**정직한 한계(주장하지 않는 것)**: ⓐ 내용 digest는 "해싱한 fd를 그대로 exec"하는 것이 아니다(Node에 `fexecve`
없음) → 창이 0이라고 주장하지 않는다(`C-5`와 같은 종류의 한계). ⓑ hard-link 발행은 **같은 디렉터리(같은 파일
시스템)** 와 POSIX dev+ino 신원을 전제한다 — hard link가 없는 파일 시스템에서는 발행이 실패로 남는다
(fail closed). engines `>=18` · POSIX 대상 범위에서만 지원한다고 적는다. ⓒ `C-7`(키 없는 state↔event digest)은
그대로 열려 있다: 두 파일을 **모두 일관되게** 다시 쓰는 위조는 여전히 감사 대상이며 이번 변경의 범위가 아니다.

**B/C 처리(§9.1 "M5b 6차 리비전 신규·갱신 유예" 표)**: 리뷰의 **B 7건은 그대로 유지**한다
(`B-7` · `B-9` · `B-10` · `B-11` · `B-12` · `B-13` · `C-12`→B) — 이번 A 작업과 겹쳐 실제로 닫힌 것은
**하나도 없다.** 리뷰의 **C 10건** 중 9건(`C-35` · `C-5` · `C-17` · `C-29` · `C-19` · `C-36` · `C-37` ·
`C-30` · `C-38`)은 **상태 그대로 유지**하고, ID가 없던 **staging/tmp 정리 실패 orphan**을 신규 **`C-39`** 로
등록했다. **`C-37`은 닫지 않았다** — roll forward를 없애 "호출자가 받은 실패를 다음 열기가 완료로 만드는"
범위가 **11개 발행 경계 중 2개**(`body:publish`·`journal:cleanup`, 즉 목표 state가 이미 durable해진 뒤)로
줄었지만 **여전히 존재**한다(증거: 테스트의 `STAGE_OUTCOME` 표에서 `after`가 그 둘뿐이다).
**`C-36`도 그대로 open**이다(`setCommitFaultHook`은 여전히 export된 가변 전역이고, 이번에 복구 경로의
body 발행 I/O 실패 회귀에도 그 seam을 썼다).

**mutation 비공허성(실측 13종, 전부 kill · 전부 바이트 동일 원복 · `MUTATION` 잔재 0)**: ① 경계 —
내용 digest 대조 제거 → **6건 fail** ② provider — 실행 파일 신원 대조 제거 → **2건** ③ controller —
권위 불일치 거부 제거 → **2건** ④ provider — invocation pin 제거(첫 invocation이 baseline) → **1건**
⑤ store — roll forward 복원 → **4건** ⑥ store — canonical event 비교를 옛 방식으로 → **1건**
⑦ store — 최종 body 소유를 digest로만 판정 → **1건** ⑧ store — base→target 불변 권위 묶기 제거 → **2건**
⑨ store — body delta 대조 제거 → **2건** ⑩ store — 기준 event 접두 신원 대조 제거 → **1건**
⑪ store — rollback이 same-digest 최종 body 삭제 → **1건** ⑫ store — 발행을 `renameSync`로(no-clobber 제거)
→ **1건** ⑬ store — 최종 body를 state 앞에서 발행(옛 순서) → **11건**. **살아남은 mutation 0건.**
원복은 레포 밖 사본과 `cmp`로 바이트 동일성을 확인했다(`MUTATION` grep 0).

**이 리비전이 실행한 테스트(worker 자기보고 — 독립 리뷰 아님)**: 파일 단독 `orchestrationKernel.test.ts`
**98/98**(89 → 98) · `stableController.test.ts` **58/58**(57 → 58) · `codexCliProvider.test.ts` **59/59** ·
`executionBoundary.test.ts` **17/17** · `reviewer.test.ts` **21/21** · `codexStreamParser.test.ts` **28/28** ·
`npx tsc --noEmit --pretty false` clean · `npm run build` + `git diff --check` clean +
**dist 런타임 프로브**(발행 경계 11개 중 `body:publish`가 `state:rename` 뒤 · 승인 digest 통과/불일치/
**같은 inode 제자리 덮어쓰기** 거부 · `assertTrustedExecutable` export 제거 · `executionAuthority` 없는
manifest는 `invalid_manifest` · 다른 승인으로 발급된 provider `authorityMatches:false` · own property 0 ·
freeze · custom-spawn 비증명 · foreign tail `journal_foreign` + 바이트 보존 · 미상 필드 `journal_invalid` ·
**유효 journal + 완전 append → roll back**(task 0건) — codex·git·sentinel spawn 0) ·
**승인 schema와 발행 프로토콜이 바뀌었으므로 kernel 계열 offline acceptance 3개 개별 재실행**:
`m4a` **31/31** · `m4b` **42/42** · `m4c` **77/77**.
**authority/provenance/recovery subset(kernel·controller·provider 3파일) 3회 직렬 215/215** ·
**`npm run test:exec` 353/353**(343 → 353, **최종 원복 구현으로 1회**).
**정직한 기록 — 세션 중단**: 이 리비전 세션은 중간에 한 번 끊겼다. 첫 `test:exec` 353/353은 **마지막 store
리팩터(발행 전 body 전수 사전 검증) 직전** 수치였고, 위 subset 3회와 `test:exec` 1회는 **재개 세션에서
최종 코드로 다시 돌린 실측**이다(그 사이 production 파일은 backup과 `cmp` 바이트 동일 · `MUTATION` grep 0).
**`npm test` 전체 suite·전체 `acceptance.sh`·stress·live는 실행하지 않았다**(최종 M5d handoff에서
supervisor가 직렬 1회). live provider 추론·네트워크·secret·MCP·remote git 쓰기는 0이다.

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인**(다음 fresh Codex read-only 리뷰가 게이트이고 위 fixed
판정 전부가 재확인 대상이다 — 이 세션은 스스로를 승인하지 않는다) · 전체 suite 1회 · live · M5c · M5d.
**M5 전체는 미완료다.**

#### M5b 5차 리비전 (2026-07-28, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰 `409dee2..35de547` → **REVISE, A/P1=4 · B=7 · C=9**)

> **정정(2026-07-28, 6차 독립 리뷰) — 이 절의 "넷 다 닫았다"는 부분적으로만 사실이었다.**
> 6차 리뷰는 **A1을 OPEN**(경로/dev/ino 동치가 trust root가 아니다 — caller가 provider·controller
> **양쪽에** 같은 임의 실행 파일을 주면 대조가 성립했고 같은 inode 제자리 덮어쓰기도 통과했다) ·
> **A3를 OPEN**(journal이 base 승인·전이·body 소유권에 묶이지 않아 위조 후속·reordered event key·남의
> same-digest 최종 body 채택/덮어쓰기/삭제가 가능했다)로 판정했다. **A2는 CLOSED · A4는 PARTIAL**이다.
> 이 절은 dated history로 보존하고 현행 판정은 위 **6차 리비전** 절이다.

**공통 뿌리는 "증명·복구의 근거를 좁게 잡았다"** 이다. 4차 리비전은 *누가* 실행 권위인지(발급 등록부·
`#private`·freeze)와 *발행이 복구 가능한지*(journal)를 세웠지만, ⓐ 증명은 **메서드 신원만** 봤으므로
"무엇을 실행하는 provider인가"(숨은 executable·git·승인·checkout·시계)는 증명 대상이 아니었고
ⓑ 복구 기록은 **열린 객체**였고 판정이 **바이트가 아니라 크기·revision 숫자**였고 ⓒ 최종 body가
**journal보다 먼저** 생겼다. 이번 리비전은 근거를 **런타임 검증된 신원 · 실제 바이트 · closed 묶기**로 옮긴다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| A1 | **A (P1)** | **임의 executable/git 권위가 read-only provider로 증명된다.** `CodexCliProvider`는 `opts.spawn`이 없는 **모든** 인스턴스를 숨은 `executablePath`·`gitExecutablePath`·manifest·controller root와 무관하게 등록했고, 증명은 WeakSet·prototype·own property·**메서드 신원**만 봤다. `StableController`는 기대 codex 실행 파일 신원을 **아예 받지 않았다** → 사용자 소유 0700 스크립트를 주면 진짜 `nodeSpawn`이 그것을 codex처럼 실행하고(스크립트는 argv를 무시하고 쓰기·네트워크·hard deny 작업을 할 수 있다), 경계 검증에 쓰는 git도 다른 실행 파일일 수 있었다. **emitted JS 실측: `/bin/echo`·`/bin/true` 둘 다 증명을 받았고 custom-spawn만 거부됐다** | **fixed** — ① provider production 분기가 **생성 시점에 런타임 검증**한다: codex 실행 파일(정규·비symlink·일반 파일·실행 비트·타인 쓰기 없음 + **dev/ino**) · git 실행 파일(같은 규칙) · controller checkout 절대경로 · **승인 canonical digest** · 시각 권위 → **불변 스냅샷**으로 freeze하고 등록부에 담는다. 검증 불가한 설정은 **생성 자체가 실패**한다(`codex_executable_invalid`·`codex_git_executable_invalid`·`invalid_manifest`·`codex_config_invalid`) ② 판정 함수는 **`attestReadOnlyCodexProvider(provider, expected)`** 로 바뀌어 **호출자가 스스로 검증해 온 기대 권위와의 대조 결과만** 돌려준다(신원 객체는 export하지 않는다 → 임의 실행 파일에 대해 "승인처럼 읽히는 답"이 존재하지 않는다. 기대값이 계약 밖이면 대조는 **false**이고 던지지 않는다) ③ `StableController`에 **명시 필수 옵션 `codexExecutablePath`** 를 추가하고, controller가 그 경로와 `gitExecutablePath`를 **자기 손으로** 검증해 kernel(SoR) 승인 digest · checkout 루트 · 시각 권위와 함께 기대 권위를 만든다 → 불일치는 **git도 codex도 spawn하기 전에** `controller_provider_authority_mismatch`로 생성 거부다. `codexExecutablePath`도 드리프트 pin에 들어간다 ④ 시각 권위는 **controller와 같은 함수이거나 진짜 `Date.now`** 만 인정한다(호출자가 고른 다른 시계는 거부 — 만료 판정이 갈리는 통로를 닫고, 실제 시각은 결정론적 테스트 시계보다 **엄격한** 방향이다) ⑤ provider는 **생성 시점 pin**으로 매 invocation 실행 파일 신원을 재검증하고(첫 invocation이 새 baseline이 되지 않는다) git 신원은 **실행 경계에도 pin으로** 넘어간다(`ExecutionBoundaryInput.gitIdentity`) ⑥ 회귀: **valid-mode sentinel 실행 파일**(0700·정규·일반 파일이지만 실행되면 sentinel 파일을 남긴다) 6케이스 — 임의 codex 실행 파일 · 다른 git · controller가 다른 git을 기대 · 다른 승인 · 다른 checkout · 다른 시계 → 전부 생성 거부이고 **codex sentinel·git sentinel 모두 미실행**, 그리고 **명시로 pin한 sentinel 실행 파일은 그대로 쓸 수 있다**(양성 대조군) · 같은 경로 **다른 inode** 거부(생성 시점 · 실행 시점 둘 다 · 실행 시점은 spawn 0) · 권위 필드 5종 드리프트 대조 · custom-spawn 비증명 · `#private`/freeze/own property 0 · production spawn 성공 경로 유지 |
| A3 | **A (P1)** | **최종 message body가 journal보다 먼저 생긴다.** `commitRun`이 `messages/<id>.md`를 먼저 만들고 그 뒤에 journal을 발행했으므로, journal write/rename의 일반 I/O 실패가 **낡은 state + 색인되지 않은 최종 메시지 파일**을 SoR 이름공간에 남겼다. `loadRun`은 state가 참조하는 body만 보므로 그것을 탐지도 정리도 하지 못했고, **다른 messageId로 재시도하면 영구히 남았다**. 기존 테스트는 그 orphan을 "무해"로 적고 state·events만 확인했다 | **fixed** — ① body는 **트랜잭션 소유 staging 이름**(`messages/.staged-<txnId>.<messageId>.md`)으로만 쓴다 ② journal에 **대상 messageId + 내용 digest**를 담고(경로는 `txnId`에서 파생하므로 자유 문자열이 아니다) ③ 최종 이름은 **journal이 durable해진 뒤** 새 발행 단계 `body:publish`에서만 만든다 ④ **journal 발행 전 실패는 이 invocation의 staging을 스스로 지운다**(최종 body 0 · 복구 대상 전이 0), 발행 뒤엔 결정론적 복구가 소유한다 ⑤ roll forward는 발행할 state가 참조하는 **모든** body의 존재·digest를 **쓰기 전에** 확인하고 하나라도 없으면 `journal_body_missing`으로 state를 쓰지 않는다 ⑥ roll back은 **이 트랜잭션 소유 staged 파일**과 "digest가 이 journal의 body와 같고 **기준 state가 참조하지 않는**" 최종 파일만 지운다 → **기존·남의 body는 어떤 경로에서도 지우지 않는다** ⑦ 회귀: 발행 경계 **11곳 전수**(+`body:publish`) · **다중 body**(store 계층 직접 커밋 — kernel API는 커밋당 1건이다) · 같은 id 재시도 · **다른 id 재시도** · reopen · staging 정리 · **최종 디렉터리 열거가 색인과 정확히 일치** · 기존 body 보존. "orphan은 무해" 단정·주석은 **삭제**했다 |
| A3 | **A (P1)** | **복구가 정확히 일치하지 않는 모든 event suffix를 잘라냈다.** tail을 **파일 크기가 정확히 맞을 때만** 읽었고 그 밖의 모든 비어 있지 않은 suffix(같은 길이의 남의 바이트 · 완전한 append 뒤의 여분 · 접두가 아닌 짧은 바이트)를 기준 길이로 truncate했다 → **남의 append-only 감사 바이트 파괴 = durable 데이터 손실**. 기존 "찢어진 append" 테스트는 실제로는 **완전한 append + 여분 바이트**를 만들고 그 전부가 지워지기를 요구했다 | **fixed** — `baseEventBytes` 이후 **실제 바이트를 읽어** 판정한다: **정확히 완전한 append** → roll forward / **정확한 바이트 접두**(빈 tail·찢어진 부분 줄 포함) → roll back(기준 길이 truncate) / 그 밖 → **`journal_foreign`으로 fail closed**이며 journal·state·events·snapshot·body가 **바이트 그대로** 남는다. 회귀: 부분 접두 되돌림+재시도 성공 · 빈 tail · 완전 append roll forward(**event 바이트 0 손실**) · **완전 append + 여분** · **같은 길이의 남의 바이트** · **짧지만 접두 아닌 바이트** 3케이스 전부 fail closed + 바이트 보존 단정 |
| A3 | **A (P1)** | **journal schema가 열려 있고 발행할 전이에 묶이지 않았다.** 미상 key를 허용했고 `base`를 검사 없이 받았고 아무 숫자나 `baseEventBytes`로 썼으며, 복구는 embedded state의 **일반 schema와 revision 숫자만** 봤다 → 경로 runId ≠ embedded runId · 후속 revision · 기준 신원 · 정규 event record · 체인 · 최종 hash/state digest · 참조 body를 **증명하지 않고** snapshot·state를 발행했다. 즉 그럴듯한 journal 하나로 **유효한 state를 caller-chosen state로 덮어쓸 수** 있었다(뒤늦은 load 거부는 이미 파괴된 뒤다) | **fixed** — ① journal은 **closed schema**다(미상·누락 필드 거부 · bounded 음수 아닌 정수 · 정규 sha256/slug/txnId 형태 · 파일 크기 상한) ② **전이에 전수 묶는다**: 경로 runId · milestone · **승인 manifest canonical digest** · **기준 state 원본 바이트 digest + revision/lastEventId/lastEventHash** · 기준 event 바이트 수 · **후속 revision** · 발행 state의 **정규 직렬화 바이트**와 `stateSha256` · `stateContentDigest` · 정규 event record(왕복 최소 JSON) · eventId 연속 · **prevHash 체인** · event revision · 마지막 event `stateDigest` · 최종 `lastEventId`/`lastEventHash` · body 대상이 state 메시지와 **digest까지** 일치 ③ **어떤 쓰기·삭제보다 먼저** journal·발행 state·append·body 신원·디스크 현재 상태를 전부 검증하고 어느 경우인지 판정한다 ④ 디스크가 **이미 목표 state 바이트**면 append 완전성·body 신원을 확인한 뒤에만 journal을 지운다(목표 revision이지만 바이트가 다르면 `journal_unrecognized`) ⑤ 무효·변조·미상 journal은 journal·state·events·snapshot·body를 **바이트 그대로** 남긴다 ⑥ 회귀 **26케이스**: 미상/누락 필드 · schema/txnId 형태 · `baseEventBytes` 음수·비정수·범위 밖·타입 · eventCount 불일치 · **revision 간격** · 기준 원본 digest 불일치 · 기준 chain 불일치 · **다른 run의 embedded state**(digest까지 맞춘 위조) · 다른 milestone · 다른 manifest · state 바이트/내용 digest · 목표 revision · 최종 event 신원 · event eventId/prevHash/revision/미상 필드/마지막 digest · **정합적으로 위조한 state digest**(다른 검사를 전부 맞춰 온 경우) · body digest 불일치 · state에 없는 body · **missing/tampered body** — 전부 안정 코드 + 바이트 보존 단정 |

**B/C 처리(§9.1 "M5b 5차 리비전 신규·갱신 유예" 표)**: 리뷰의 **B 7건은 그대로 유지**한다
(`B-7` · `B-9` · `B-10` · `B-11` · `B-12` · `B-13` · `C-12`→B) — 이번 A 작업과 겹쳐 실제로 닫힌 것은
**하나도 없으므로 닫았다고 적지 않는다.** 리뷰의 **C 9건** 중 8건(`C-35` · `C-5` · `C-17` · `C-29` ·
`C-19` · `C-36` · `C-37` · `C-30`)은 **사실·기한 그대로 유지**하고, ID가 없던 **caller getter artifact
taxonomy**를 신규 **`C-38`** 로 등록했다. `C-36`/`C-37`은 트리거를 검토했으나 **직접 증거가 없어
재분류하지 않았다**(둘 다 그대로 open — 근거는 §9.1 표 위 주석). **C만으로 추가 리비전 루프를 돌리지 않는다.**

**mutation 비공허성(실측 11종, 전부 kill · 전부 정확히 원복 · `MUTATION` 잔재 0)**: ① A1 provider —
설정 권위 대조를 무력화 → controller **2건 fail** ② A1 provider — 실행 파일 pin을 첫 invocation baseline으로
되돌림 → **1건 fail** ③ A1 controller — 권위 대조 거부 제거 → **1건 fail** ④ A3 store — 최종 body를
journal 전에 만들기 → **1건 fail** ⑤ A3 store — journal 발행 전 staging 정리 제거 → **3건 fail**
⑥ A3 store — "정확한 접두가 아닌 tail도 truncate"(예전 규칙) → **1건 fail** ⑦ A3 store — journal closed key
검사 제거 → **1건 fail** ⑧ A3 store — `stateContentDigest` 묶기 제거 → **처음에는 살아남았다**(다른 검사들이
그 경로에서 중복 방어였다). 그래서 **다른 검사를 전부 맞춰 온 정합적 위조** 회귀를 추가하고 다시 돌려
**kill**했다(이 이력을 지우지 않고 남긴다) ⑨ A3 store — 후속 revision 검사 제거 → **1건 fail**
⑩ A3 store — event 해시 체인 검사 제거 → **1건 fail** ⑪ A3 store — 복구 전 body 신원 확인 제거 →
**1건 fail**. **살아남은 mutation 0건.** 원복은 레포 밖 사본과 `cmp`로 바이트 동일성을 확인했다
(커밋이 없는 상태였으므로 `git checkout --`를 쓰지 않았다).

**이 리비전이 실행한 테스트(worker 자기보고 — 독립 리뷰 아님)**: 파일 단독 `orchestrationKernel.test.ts`
**89/89**(82 → 89) · `stableController.test.ts` **57/57**(54 → 57) · `codexCliProvider.test.ts` **59/59** ·
`executionBoundary.test.ts` **17/17** · `reviewer.test.ts` **21/21** · `npm run test:exec` **343/343**
(333 → 343, **최종 원복 구현으로 1회**) · authority/provenance/recovery subset(kernel·controller·provider)
**3회 직렬 205/205** · `npx tsc --noEmit --pretty false` clean · `npm run build` + `git diff --check` clean +
**dist 런타임 프로브**(emitted JS에서 `/bin/echo`·`/usr/bin/true` provider가 sentinel 기대 아래 대조 실패 ·
custom-spawn 비증명 · own property 0 · freeze · export 표면 = 판정 함수 하나 · foreign suffix `journal_foreign`
+ 바이트 보존 · 미상 필드 journal `journal_invalid` · `COMMIT_STAGES` 11개 · sentinel 프로세스 0) ·
발행 프로토콜을 건드렸으므로 **kernel 계열 offline acceptance 3개 개별 재실행**: `m4a` **31/31** ·
`m4b` **42/42** · `m4c` **77/77**.
**`npm test` 전체 suite·전체 `acceptance.sh`·stress·live는 실행하지 않았다**(최종 M5d handoff에서
supervisor가 직렬 1회). live provider 추론·네트워크·secret·MCP·remote git 쓰기는 0이다.
**정직한 관측**: `test:exec` 첫 실행에서 부하 기인 `boundary_git_failed` 1건(고정 10초 git 상한)이 있었고
즉시 재실행은 343/343이었다 — 테스트를 완화하지 않고 §0-0에 기록했다.

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인**(다음 fresh Codex read-only 리뷰가 게이트이고 위 fixed
판정 전부가 재확인 대상이다 — 이 세션은 스스로를 승인하지 않는다) · 전체 suite 1회 · live · M5c · M5d.
**M5 전체는 미완료다.**

#### M5b 4차 리비전 (2026-07-28, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰 `409dee2..d554a46` → **REVISE, A/P1=4 · B=7 · C=5**)

**공통 뿌리는 "TypeScript 수준의 사설성·논리적 원자성을 런타임 보장으로 착각했다"** 이다. 3차 리비전은
executor 신원과 오류 provenance를 언어 수준 사설로 옮겼지만, **같은 클래스의 나머지 상태**(controller의
봉인 권위·pin·토큰 카운터, provider의 설정)는 TS `private`에 남아 emitted JS에서 writable own property였다.
kernel 쪽도 **논리 트랜잭션은 하나**였지만 **물리 발행은 네 연산**이었고, **완료 권위 자체**는 구조적으로만
검사됐다. 이번 리비전은 ⓐ 상태를 `#private` + freeze로 실제로 감추고 ⓑ 완료 권위에 **발급 증명**을 붙이고
ⓒ 발행에 **journal 기반 복구 규칙**을 넣고 ⓓ caller-owned 입력을 **단일 읽기로 입양**한다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| A1 | **A (P1)** | **controller/provider의 권한·설정·예산 상태가 emitted JS에서 writable.** `controller.sealed`(봉인 manifest/kernel/provider)·`pins`(드리프트 tripwire)·`tokensUsed`(예산)·`opts`가 전부 public writable own property였고, attested `CodexCliProvider`의 `opts`도 그랬으며 **실행마다 그것을 권위로 다시 읽었다**(executable·manifest·repo·git·clock 교체 가능). TS `private` **메서드**도 prototype 메서드이므로 `defineProperty`로 `assertGatesOpen`을 no-op으로 덮으면 만료·예산 게이트가 사라졌다 | **fixed** — ① controller의 `#sealed`·`#pins`·`#tokensUsed`·`#opts`와 **게이트 메서드 14개 전부**를 ECMAScript `#private`으로 전환 ② 생성자 끝에서 `Object.freeze(this)` + `Object.freeze(StableController.prototype)` → own property가 0이고 **어떤 대입·`defineProperty`도 던진다**(`#private`은 property가 아니라 내부 상태는 정상 동작) ③ 밖에 남는 표면은 `advanceOnce`·`usedTokens`·`approvedManifest`·`approvedCommit` 넷뿐 ④ provider는 **생성 시점에 정규화된 immutable `#config`**(manifest는 구조적 복제로 입양)를 한 번 포착해 그것만 실행 권위로 쓰고, 호출자 `opts` 참조(`#optsRef`)는 **드리프트 tripwire 전용**이다 ⑤ `id`를 prototype getter로 옮기고 인스턴스를 freeze ⑥ 증명은 **own property가 0인 인스턴스만** 통과시킨다(사후 `defineProperty` override 차단) ⑦ 회귀: 전체 own-property 목록 · 권위·카운터·게이트 **19개 후보**에 대입+`defineProperty` 시도 · **토큰 리셋 불가**(소진 뒤 어떤 조작으로도 advance가 다시 열리지 않는다) · **start 전 `opts` 변조도 baseline이 되지 못한다**(spawn 0) · custom-spawn 비증명과 실제 OS 자식 프로세스 성공 경로 유지 |
| A2 | **A (P1)** | **구조적으로 비슷한 kernel이 durable commit 없이 success를 발급.** `captureKernel()`이 메서드 모양과 `paths.workspaceRoot`만 봤으므로, 스케줄링은 진짜 kernel에 위임하고 `completeTaskWithArtifacts()`만 그럴듯한 task·artifact를 돌려주는 delegate를 넣으면 **state·event·body·artifact가 하나도 안 바뀐 채** `status:"completed"`·`marker:"result_accepted"`가 나왔다(M5c가 durable SoR 없이 성공을 읽는 통로) | **fixed** — ① `orchestrationKernel.ts`에 **모듈 사설 발급 등록부**(`GENUINE_KERNELS` WeakSet) + **모듈 사설 생성 토큰**(`ISSUER_TOKEN` — TS `private constructor`는 emitted JS에서 호출 가능하므로 토큰 없는 직접 생성은 `kernel_issuer_required`) ② kernel 인스턴스는 **own property 0 · `Object.freeze(this)`** 이고 `paths`는 **prototype getter**가 freeze된 값만 준다(`#paths`), prototype도 freeze ③ 밖으로 나가는 것은 판정 함수 `attestOrchestrationKernel` 하나뿐 — 발급기·토큰·factory는 export하지 않는다 ④ controller는 **정확한 instance/prototype/메서드 신원**만 캡처하고 구조적 객체·delegate·proxy·subclass·prototype 위조·메서드 복사본·override를 **생성 자체에서 거부**한다(`controller_kernel_not_genuine`) ⑤ 기존 `delegateKernel` 테스트를 **성공/실패 경계에서 떼어내** "생성 거부" 회귀로 재구성했다 — production 성공 권위에 fake seam이 연결되지 않는다 ⑥ 성공 회귀는 **revision·event tail·result body 파일·artifact record·snapshot이 실제로 바뀌었고 새 genuine kernel로 reopen한 task가 `completed`** 임을 확인한다 ⑦ kernel 오류 taxonomy 회귀는 이제 **진짜 kernel이 실제로 내는** 닫힌 집합 밖 코드(`run_lock_held`)로 `kernel_rejected` 접힘을 고정한다 |
| A3 | **A (P1)** | **물리 발행이 원자적·복구 가능하지 않다.** `commitRun()`이 body publication → event append → snapshot → state 교체를 각자 실패할 수 있는 순서로 했다 → append 성공 뒤 snapshot/state 실패면 디스크에 **낡은 state + 새 event tail**이 남아 reopen은 `event_count_mismatch`, 재시도는 `stale_writer`로 **둘 다 깨졌다**(forward progress 상실). 이전 판의 `C-4` crash-hardening 유예로 덮을 수 없는 **일반 I/O 실패**다 | **fixed(신규 의존성 0 · 별도 오케스트레이터 0)** — ① `commitRun`을 **준비/발행** 두 국면으로 분리: 준비에서 event 줄·최종 state를 만들고 **참조 무결성 + 런타임 validator 전수**(`validateRunState`를 발행할 바이트에 대고) + digest 재확인을 통과해야 발행에 들어간다(무효 state는 절대 발행되지 않는다 — A4와 같은 자리) ② 발행 직전 **`commit.journal`**(base 신원 · 기준 event 바이트 길이 · append할 줄 전체 · 발행할 state 바이트)을 **원자적 rename**으로 남긴다 ③ 다음 `commitRun`·`loadRun`이 `recoverPendingCommit`으로 **결정론적·멱등** 복구: 디스크가 이미 journal revision이면 journal만 삭제 / 기준 state + **정확히 journal 바이트로 끝난 append**면 **roll forward**(snapshot·state 발행) / 기준 state + 다른 tail(0바이트·찢어진 부분 append)이면 **roll back**(기준 길이로 truncate) / 그 밖은 fail closed(`journal_unrecognized`·`journal_foreign`·`journal_unparsable`·`journal_invalid`) ④ body 파일은 어느 경로에서도 지우지 않는다(state가 참조하지 않으면 load 검증 대상이 아니고 같은 messageId 재시도는 같은 경로를 덮으므로 멱등) ⑤ append-only 감사 의미 보존: **커밋된 이력은 버리지 않고**(roll forward) 미승인·찢어진 tail만 되돌린다 ⑥ 테스트 seam은 **store 안에만 있는 bounded fault hook**이다(kernel·provider 권위에 노출 0) ⑦ 회귀: 발행 경계 **10곳 전수**(body write/rename · journal write/rename · events append · snapshot write/rename · state write/rename · journal cleanup)에 fault 주입 → 각각 **가시적 전이 0 또는 결정론적 roll forward**, journal 잔여 0, event 줄 수 = `lastEventId`, artifact revision 중복 0, **재시도 또는 다음 커밋 성공**, 두 번째 reopen도 같은 revision. 추가로 **찢어진 append**(부분 줄 덧붙임) 되돌림 + 재시도 성공, journal 변조 4종 fail closed |
| A4 | **A (P1)** | **caller-owned artifact getter를 반복 읽어 invalid role을 durable state에 저장 가능.** `addArtifact()`가 `out.role`을 검증한 뒤 **다시 읽어** 기록했으므로, 첫 읽기 `"output"` · 두 번째 읽기 계약 밖 role인 교대 getter가 artifact record와 result 포인터를 **함께** 오염시켰다(`acceptMessage`는 공격자 유래 두 값을 서로 비교하므로 통과, 커밋 성공, **reopen만 실패** = 읽을 수 없는 run) | **fixed** — ① 호출자 소유 `{path, role}`을 **닫힌 key 집합**(string 외 key·symbol·미상 key 거부)으로 확인하고 각 property를 **정확히 한 번** 읽어 평범한 불변값으로 입양한다(`readClosedOnce` + `adoptedOutput`) — 이후 원본 객체를 다시 읽지 않는다 ② 읽는 순간 던지는 getter/proxy(`ownKeys` trap 포함)는 안정 코드 `invalid_artifact_ref`로 접힌다(경계 밖 오류가 자기 코드를 고르지 못한다) ③ 목록도 길이를 한 번만 읽고 항목마다 즉시 입양한다 ④ **단건(`registerArtifact`)·트랜잭션(`completeTaskWithArtifacts`) 두 등록 경로가 같은 헬퍼**를 쓴다 ⑤ cyclic·깊은 payload는 path/role 타입 검사에서 걸린다 ⑥ **예정 state 전체를 발행 전에 런타임 validator로 다시 닫는다**(A3 ①과 같은 자리) → 어떤 경로로도 "커밋은 되고 reopen만 실패하는" state가 나오지 않는다 ⑦ 회귀: 교대 getter는 **첫(검증된) 값으로만 굳고** reopen 성공 · 입양 뒤 원본 변조 무효(비공허성 단정 포함) · throwing getter/proxy/미상 key/symbol key/cyclic/깊은 payload는 **durable delta 0**으로 거부 |

**B/C 처리(§9.1 "M5b 4차 리비전 신규·갱신 유예" 표)**: 리뷰의 **B 7건은 그대로 유지**한다
(`B-7` · `B-9` · `B-10` · `B-11` · `B-12` · `B-13` · `C-12`→B) — 이번 A 작업과 겹쳐 실제로 닫힌 것은
**하나도 없으므로 닫았다고 적지 않는다.** 각 항목의 기한·트리거·담당·증거·상태는 본표와 1차 리비전 표에
그대로 있다. 리뷰의 **C 5건**은 `C-35`(신규 — `ReviewSubject` closed/taxonomy) · `C-5`(갱신 — artifact
TOCTOU) · `C-17`(갱신 — 만료 equality) · `C-29`(갱신 — 중첩 handoff schema) · `C-19`(갱신 — output-schema
검증)로 **전부 완전한 행으로 유지**했고, 이번 리비전이 만든 절충 2건을 **신규 등록**했다:
`C-36`(store 전용 fault seam) · `C-37`(roll-forward가 미승인 커밋을 완료로 만들 수 있다).
**C만으로 추가 리비전 루프를 돌리지 않는다.**

**mutation 비공허성(실측 6종, 전부 정확히 원복)**: ① A1 controller — `Object.freeze(this)` 제거 →
"권위·카운터는 밖에서 보이지도 바뀌지도 않는다" + "객체 교체는 드리프트다" **2건 fail** ② A1 provider —
`Object.freeze(this)` 제거 → controller **3건** + provider **1건 fail** ③ A1 provider 권위 — 실행 봉인을
`#config` 대신 `#optsRef`(호출자 객체)로 되돌림 → "실행 설정은 생성 시점에 포착된다" **fail** ④ A2 kernel —
발급 등록부 검사 무력화 → "구조적으로 같은 위조 kernel은 증명을 받지 못한다" **fail** ⑤ A2 controller —
`captureKernel`을 구조적 검사로 되돌림 → controller **3건 fail**(위조 완료 권위 · 교대 getter kernel · inbox)
⑥ A3 — `recoverPendingCommit` 무력화 → kernel **3건 fail** ⑦ A4 — `adoptOutput`이 role을 원본에서 다시
읽게 되돌림 → "교대 getter는 첫 읽기 값으로만 굳는다" **fail**. **살아남은 mutation 0건.**

**이 리비전이 실행한 테스트(worker 자기보고 — 독립 리뷰 아님)**: 파일 단독 `orchestrationKernel.test.ts`
**82/82**(74 → 82) · `stableController.test.ts` **54/54**(52 → 54) · `codexCliProvider.test.ts`
**59/59**(58 → 59) · `npm run test:exec` **333/333**(322 → 333) ·
authority/provenance/recovery/atomicity subset(kernel·controller·provider) **3회 직렬 195/195** ·
`npx tsc --noEmit --pretty false` clean · `npm run build` + source/dist parity(emitted JS의 `#private`·
freeze·발급 등록부 런타임 확인) · `git diff --check` clean ·
발행 프로토콜을 건드렸으므로 **kernel 계열 offline acceptance 3개 개별 재실행**: `m4a` **31/31** ·
`m4b` **42/42** · `m4c` **77/77**.
**`npm test` 전체 suite·전체 `acceptance.sh`·stress·live는 실행하지 않았다**(최종 M5d handoff에서
supervisor가 직렬 1회). live provider 추론·네트워크·secret·MCP·remote git 쓰기는 0이다.

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인**(다음 fresh Codex read-only 리뷰가 게이트이고 위 fixed
판정 전부가 재확인 대상이다 — 이 세션은 스스로를 승인하지 않는다) · M5c/M5d 착수 · live 실행.

> **후속(2026-07-28): 위 "넷 다 닫았다"는 부분적으로만 사실이었다.** 5차 독립 리뷰가 **A1을 PARTIAL**
> (증명이 숨은 executable/git 권위를 보지 않는다 — `/bin/echo`·`/bin/true` 실측 통과) · **A3를 OPEN 3건**
> (pre-journal 최종 body · foreign suffix truncate · 열린 journal schema) · **A4를 PARTIAL**로 다시 열었다
> (A2만 CLOSED). 현행 판정은 위 **M5b 5차 리비전** 절이다.

#### M5b 3차 리비전 (2026-07-28, 독립 fresh Codex `gpt-5.6-sol` xhigh read-only 재리뷰 `409dee2..38b8d32` → **REVISE, A/P1=3**)

**공통 뿌리는 "공개 표면을 권위로 신뢰했다"** 이다. 1·2차 리비전은 위조 경로를 하나씩 막았지만
**증명·provenance의 근거 자체가 공개 API**였으므로 다른 공개 표면으로 같은 위조가 다시 가능했다.
이번 리비전은 근거를 **언어 수준 사설 상태**(`#private` 필드 · 모듈 사설 `WeakSet`)로 옮기고,
kernel 쪽은 **비원자적 다단계 커밋을 단일 트랜잭션**으로 합쳤다.

| # | 분류 | finding | 처리 |
|---|---|---|---|
| A1 | **A (P1)** | **attested read-only provider가 공개 `spawn` seam으로 위조 가능.** `CodexCliProviderOpts.spawn`은 공개 임의 callback이고 생성자는 `opts.spawn ?? nodeSpawn`을 포착한 **모든** 인스턴스를 증명 등록부에 넣었다 → 증명을 통과한 callback이 argv·env를 무시하고 임의 write/command/network를 할 수 있었다. TS `private readonly spawnFn`도 emitted JS에서는 writable own field였고 **controller 테스트가 실제로 그 필드를 덮어썼다** | **fixed** — ① 모듈 사설 `PRODUCTION_SPAWN`(적재 시점 포착한 진짜 `node:child_process.spawn`) ② `#spawn`·`#sessions`를 **ECMAScript `#private`** 로 봉인(외부 대입·`defineProperty` 불가) ③ **`opts.spawn`을 준 인스턴스는 증명하지 않는다**(untrusted seam으로 유지 — 하위 계층 provider 단위 테스트 58건은 그대로 살아 있다) ④ 함수 아닌 `spawn`은 `codex_config_invalid` ⑤ **controller 성공 경로 테스트를 실제 OS 자식 프로세스로 전환**: 기존 `__fixtures__/fake-codex.mjs`를 절대 `process.execPath` shebang 래퍼(0700)로 감싸 default `nodeSpawn`이 직접 실행하고, argv·cwd·env·stdin·파서·증명이 전부 production 경로다(codex 추론·네트워크 0) ⑥ 회귀: custom-spawn 비증명 · production 증명(양성 대조군) · 사후 필드 덮어쓰기 무효 · public own field 부재 · subclass/plain-subclass/proxy/override/복사본 거부 |
| A2 | **A (P1)** | **controller error taxonomy provenance가 exported class로 위조 가능.** `ControllerError`가 public constructible이고 `atBoundary`/`atBoundaryAsync`가 `instanceof ControllerError`를 trusted internal로 그대로 보존했다 → handoff가 `new ControllerError("result_accepted", …)`를 던지면 `status:"failed"` + `marker:"result_accepted"`가 만들어졌다. `codeOf`도 아무 `OrchestrationError`의 코드를 신뢰했다 | **fixed** — ① 모듈 사설 `ISSUED_HERE` WeakSet: **이 모듈이 발급한 오류만** marker가 된다(클래스·코드·이름 흉내 무효) ② `atBoundary`/`atBoundaryAsync`는 **예외 없이** 고정 코드로 접는다 ③ 호출자 콜백 전수 차단: handoff · provider start/send/events · **`opts.nowMs` 시계**(`controller_clock_unreadable`) · **`opts.kernel` 전 메서드**(`atKernel`) ④ kernel native 코드는 **닫힌 허용 집합 `KERNEL_MARKERS`(23종)** 일 때만 입양하고 나머지는 `kernel_rejected` — `result_accepted`는 어떤 경로로도 실패 marker가 될 수 없다 ⑤ 신뢰된 정적 import(`verifyArtifactFile`·`verifyExecutionBoundary`)만 `atTrusted`로 코드를 입양한다(신뢰 근거는 호출 지점) ⑥ **반환값 읽기까지** 접는다(kernel이 준 객체의 throwing getter) ⑦ `consumeExactlyOneTerminal`은 클래스 대신 **factory**를 받아 소비자가 자기 provenance를 붙인다 |
| A3 | **A (P1)** | **다중 artifact 등록과 task completion이 비원자적.** controller가 `registerArtifact`를 산출물마다 durable commit한 뒤 별도로 `submitResult`를 불렀다 → 뒤쪽 output이 없거나 무효·중복·상한 초과이거나 envelope/body 검증이 실패하면 **앞선 artifact·event·revision만 durable에 남고** task는 running/failed였고, 재시도가 revision을 계속 올렸다 | **fixed** — kernel에 원자 트랜잭션 **`completeTaskWithArtifacts`** 추가: 한 `#mutate` 안에서 envelope(type · `artifactRefs`는 비어 있어야 함) · summary · body · task 전이를 먼저 닫아 보고, 산출물 전체를 (소유권 · writableRoots · 파일/hash/symlink · role · **개수 상한 `LIMITS.maxArtifactRefs`=16** · **경로 중복 `artifact_path_duplicate`**) 검증하며 등록한 뒤 그 포인터로 envelope를 채워 `acceptMessage`가 다시 대조하고 artifact record + event + result 메시지 + `completed` 전이를 **한 커밋**으로 반영한다. 소유권·파일 신원 집행은 `registerArtifact`와 **같은 헬퍼**(`addArtifact`)이므로 진입점이 둘이어도 불변식은 하나다. 기존 `registerArtifact`/`submitResult` API·테스트는 호환 유지. controller는 loop+submit을 버리고 이 호출 하나만 쓴다 |

**B/C 처리(§9.1 "M5b 3차 리비전 신규·갱신 유예" 표)**: 리뷰의 **B 2건은 유예하지 않고 이번에 닫았다** —
`B-14`(첫 terminal 뒤 실패 경로의 usage 회계, 원 기한 *M5c 두 번째 provider/retry 배선 전*) ·
`B-15`(`ReviewSubject` closed 검증 + 봉인 스냅샷, 원 기한 *M5c/`C-19` durable reviewer integration 전*).
리뷰의 **C 1건**은 `C-32`로 등록하고 bounded defense-in-depth로 **닫았다**(inbox 항목 단일 읽기).
**신규 open C 2건**: `C-33`(`KERNEL_MARKERS`가 손으로 유지하는 목록 — 기한 *M5c marker 분기 로직 도입 시*) ·
`C-34`(`codeOf` provenance 검사가 1경로를 빼면 중복 방어 — mutation 실측 기반 정직 표기).
**`C-31`은 축소 재기술**(white-box 관측 2곳 제거 → 남은 절충은 "자식 프로세스 회수까지는 보지 않는다",
기한 그대로 `B-13`). **`C-30`은 범위 축소 갱신**(usage 회계 부분은 `B-14`가 닫았고 marker e2e만 남는다).
기존 `B-7`·`B-9`·`B-10`~`B-13`·`C-12`→B·`C-29`의 사실과 기한은 **그대로 보존**한다 — 이번 리비전은
그 항목들을 손대지 않았고 fixed로 주장하지 않는다.

**mutation 비공허성(실측, 정확히 원복)**: ① A1 — 증명 등록부에 custom-spawn 인스턴스도 추가 →
"[M5b] A1: 임의 executor를 주입한 인스턴스는 증명을 받지 못한다" **fail** ② A2 — `atBoundary`에
`instanceof ControllerError` 보존 복원 → handoff·시계 회귀 **2건 fail** ③ A3 — 트랜잭션 안에서 산출물을
`registerArtifact`로 먼저 따로 커밋 → kernel **3건** + controller **6건 fail**. **살아남은 mutation 1건**:
`codeOf`를 "아무 `OrchestrationError` 코드 신뢰"로 되돌렸을 때 처음에는 **아무 테스트도 실패하지 않았다**
(래퍼들이 이미 owned 오류로 접기 때문). 그래서 실제 도달 경로(kernel 반환값의 throwing getter)를 찾아
회귀를 추가했고 그 뒤 mutation이 **fail**했다. 남은 중복성은 위 `C-34`로 등록했다.

**이 리비전이 실행한 테스트(worker 자기보고 — 독립 리뷰 아님)**: 파일 단독 `stableController.test.ts`
**52/52**(36 → 51 → 52) · `orchestrationKernel.test.ts` **74/74**(70 → 74) · `codexCliProvider.test.ts`
**58/58** · `reviewer.test.ts` **21/21**(19 → 21) · `npm run test:exec` **322/322**(295 → 322) ·
authority/atomicity/timing subset(위 4파일) **3회 직렬 205/205** · `npx tsc --noEmit` clean ·
`npm run build` + source/dist parity 확인 · `git diff --check` clean.
**`npm test` 전체 suite·acceptance·stress·live는 실행하지 않았다**(최종 M5d handoff에서 supervisor가 직렬 1회).

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인**(supervisor의 다음 fresh Codex read-only 리뷰가
게이트이고 위 fixed 판정 **전부가 재확인 대상**이다 — 이 세션은 스스로를 승인하지 않는다) ·
전체 suite 1회 · live · M5c · M5d. **M5 전체는 미완료다.**

**검증 실측(offline, 2026-07-28 — 2차 리비전 세션의 자기보고. 독립 리뷰어가 재실행한 것이 아니다)**

- 파일 단독 `npx tsx --test`: `stableController.test.ts` **42/42**(36 → 42) · `reviewer.test.ts`
  **19/19**(14 → 19) · `suiteExclusiveLock.test.ts` **75/75**(`C-2` 주석 수정 확인).
- `npm run test:exec` **306/306**(295 → 306).
- 권위·타이밍 경계를 건드렸으므로 **권위/타이밍 부분집합을 직렬 3회**:
  `stableController` + `codexCliProvider` + `executionBoundary` + `orchestrationKernel` + `reviewer`
  = **206/206**, 3회 모두 동일.
- `npx tsc --noEmit` 0 · `npm run build` PASS(**dist parity** — 재빌드 시 `git status` 변화 0) ·
  `git diff --check` clean · `node_modules` stage 0.
- **비공허성(mutation) 16종 — 전부 죽었고 전부 원문 그대로 원복**(runner는 레포 밖 로직으로 원본 문자열을
  복원하고 매 케이스 `restored=true`를 확인했다. 종료 후 `git status`에 임시 파일 0):
  A1 bind 제거→재읽기 wrapper **1건** · A1 단일 읽기 제거(pin 기준을 두 번째 읽기로) **1건** ·
  A2 WeakSet 검사 제거 **1건** · A2 prototype 검사 제거 **1건** · A2 메서드 신원 검사 제거 **1건** ·
  A2 `Object.freeze(prototype)` 제거 **1건** · A3 usage 회계를 `isError` 뒤로 **2건** ·
  A5a 펜스 길이·정보문자열 검사 제거 **1건** · A5a 대상 완전 일치 → `includes` **1건** ·
  A5a 대상 미상 줄 무시 **1건** · A5a findings 미상 줄 무시 **1건** · A5a findings 본문 상한·nonempty 제거 **1건** ·
  A5a heading 순서 검사 제거 **1건** · A5b 공용 소비자 코드 passthrough 복원 **2건** ·
  A5b 경계 오류 passthrough **2건** · A5b reviewer `events()` 래핑 제거 **1건**.
  (초기 1회차에서 **A2 prototype 검사 제거가 살아남았다** — 회귀가 *override하는* subclass만 봤기 때문이다.
  **override 없는 subclass** 케이스를 추가해 kill했다. 이 이력을 지우지 않고 남긴다.)
- **미실행**: `npm test` 전체 · `test:core` · `scripts/acceptance.sh` 전체 · stress · live · MCP ·
  실제 Codex/Claude 추론 · 원격 push/PR/merge. 전체 suite 1회는 **최종 M5 handoff(M5d 이후) 직렬 1회**로
  그대로 예약돼 있다.

**이 리비전 이후에도 아닌 것**: **독립 재리뷰·승인** — 다음 fresh Codex `gpt-5.6-sol` xhigh read-only
리뷰가 게이트이고 **위 fixed 판정 전부가 재확인 대상**이다. 이 세션은 스스로를 승인하지 않는다.
전체 suite 1회 · live · M5c · M5d는 그대로 남아 있고 **M5 전체는 미완료다.**

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
- **도구 예산을 상한으로 선언한다**(2026-08-12 외부 팩 조사에서 채택한 유일한 수치 근거): tool/MCP 설명은
  등록만으로 컨텍스트를 상시 소모한다 — ECC 문서는 200k 창에서 가용분이 ~70k까지 줄어드는 것을 보고하고
  MCP 10개·활성 툴 80개 미만을 권한다. M7은 tool을 **늘리는 첫 마일스톤**이므로 상한을 코드 상수로 두고
  초과를 fail-closed로 만든다(관례가 아니라 계약). 실측 없이 이 숫자를 그대로 쓰지 않는다 — 착수 시 우리
  프로파일에서 재측정하고 그 값을 근거로 적는다.
- `C-67`(승인 설정 정적 감사) 기한이 이 마일스톤이다 — 외부 provider 권능이 manifest에 들어오기 전에 닫는다.

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

#### M9 선결 4건 (2026-08-12 추가 — **이것들 없이는 M9 완료 조건이 스펙상 닫히지 않는다**)

M6까지의 "의도적 잔여"가 M9에서는 **전제 조건**이 된다. 개선 항목이 아니라 **빠진 기능**이므로 여기 배치한다.

1. **`run_process` action enum 확장 — 하드 게이트.** 현재 `CONTROLLER_ACTIONS`는 `["validate-plan"]`
   **하나이고 읽기 전용**이다(`orchestrationTypes.ts`). M9 완료 조건의 "**test** review"는 테스트를
   *실행*해야 하는데 **표현할 타입이 없다**. M5 완료 판정 절이 이것을 "미증명 — M6+ 범위"로 적었고
   M6에서도 열지 않았다. **M9 착수 전에 닫는다.** 확장은 여전히 닫힌 enum이며 argv·shell 문자열을
   모델이 고르는 통로를 만들지 않는다(승인 레코드가 실행 파일·argv·timeout을 정한다).
2. **`B-16` 신규 파일 발행** — 지금은 승인된 **기존 파일 교체만** 가능하다(신규 생성 `write_publish_unsupported`).
   worker가 새 파일을 만드는 것이 구현 파이프라인의 기본 동작이므로 M9 전제다.
3. **`B-17` inbox 전달 소비(ack)** — M6는 route가 durable하게 남는 것까지만 증명했다. "fresh Codex 검토 →
   fresh Claude 수정"의 **자동 전달**은 수신 task가 inbox를 실제로 읽어야 성립한다.
4. **F2 실행 가시성**(`V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` F2 — 진행률·스피너·ETA, 신규 의존성 0).
   M9는 **병렬 worker가 다수 도는 첫 마일스톤**이라 불투명함이 최대가 된다. FIELD_NOTES self-review가
   관측성 통증 **1순위**로 지목한 항목이고, F1(프로젝트 간 학습)의 데이터 기반(step 타임스탬프)도 여기서 생긴다.

완료: 아이디어에서 로컬 동작 MVP와 전체 테스트·최종 report까지 단일 실행.

### M10 — End-to-End Hardening & Release

- resume/idempotency, crash recovery, timeout, rate limit, budget, deadlock, cancellation, cleanup.
- context rotation/요약 변질/문서 누락/의존성 실패/권한 요청 통합 시나리오.
- **F3 문서 완료 → Claude Code 자동 핸드오프**(`V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` F3 — 2026-08-12 배치).
  문서 파이프라인이 전부 선 뒤에야 "문서 완료 → 핸드오프"가 의미를 갖기 때문에 여기다. **headless
  `execute --apply`가 아니다** — 대화형 Claude Code 세션을 여는 것까지이고, 코드 수정 권한은 Claude Code
  자체 permission 시스템에 그대로 남는다. 그 경계를 넘는 변형은 만들지 않는다.
- **승인 설정 정적 감사를 릴리스 게이트에 포함한다**(`C-67`): 도그푸딩하는 실제 프로젝트 2~3개의 승인
  manifest를 감사해 "과도하게 넓은 승인"이 실사용에서 실제로 생기는지 확인한다. 감사가 아무것도 못 찾으면
  그 사실을 그대로 적는다(공허한 게이트를 통과로 세지 않는다).
- 실제 서로 다른 프로젝트 2~3개 도그푸딩.

완료:

- 기획→디자인→개발 end-to-end acceptance 전부 통과.
- 중단 후 재개 시 중복 agent/중복 merge/결정 유실 없음.
- hard deny와 milestone approval 경계 우회 없음.

## 11. M10 이후 선택적 확장

- stack별 QA/Next.js DevTools/Supabase dev branch.
- preview/운영 read profile(Vercel/Sentry 등).
- Anthropic provider parity.
- F1 cross-project learn-from(프로젝트 축적 조건 충족 시 — `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` F1).
  **같은 문서의 F2·F3는 선택적 확장이 아니다** — 2026-08-12에 F2는 M9 선결, F3는 M10으로 배치했다.
  그 문서가 정한 순서(F2 → F3 → F1)는 그대로 유지된다.

**외부 Claude Code 하네스 팩(ECC · gstack · oh-my-claudecode)은 선택적 확장에도 넣지 않는다**
(2026-08-12 판정, `docs/DECISIONS.md`). 셋 다 프롬프트·스킬·훅 층이고 **durable SoR·승인 manifest·
상태 기계가 없다** — 우리 v3와 같은 자리를 다른 계약으로 채우므로 얹으면 역할 어휘가 둘이 된다.
CLAUDE.md의 기존 금지(`OMC 연동`·`Agent Teams 연동`)와도 같은 판정이다. 그 조사에서 **가져온 것은 두 가지
발상뿐**이고 둘 다 이미 위에 배치했다: `C-67`(승인 설정 정적 감사, M7 기한) · M7의 도구 예산 상한.

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
