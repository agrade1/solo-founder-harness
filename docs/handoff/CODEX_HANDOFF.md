# CODEX_HANDOFF.md — Solo Founder AI Harness (V3 M0~M3 완료)

작성 기준: 아래 사실은 실제 코드·테스트·git 기록으로 검증했다. 검증 불가 항목은 `미확인`으로 표기한다.
고정 규칙은 루트 `AGENTS.md`를 함께 본다.

## 현행 상태 (2026-07-27 — V3 **M5a 2차 리비전 완료(offline)** · **M5 전체는 미완료** · 이 절이 가장 최신이다)

worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider` · base `85ebe883`.
커밋 `115e0be`(feat) → `6ae7fd6`(docs) → `bdd5507`(fix, 1차 리비전) → `450739a`(docs) →
`7e7bb9b`(fix, **2차 리비전**) + 이 문서 커밋. **원격 push/PR/merge 0**, amend/rebase/reset 0.
2차 리비전은 **새 fresh Claude Opus 5 세션**이 했다(이전 작성 세션은 다시 resume하지 않았다).

- **2차 리비전에서 고친 A 4건(게이트끼리의 모순)** — 상세 표는 로드맵 §10 "M5a 2차 리비전":
  1. **`CODEX_HOME` 소유 수명**: 이전 계약은 **모든** invocation이 빈 홈을 요구해 **비-ephemeral resume이
     구조적으로 불가능**했다(codex는 resume 상태를 그 홈에 쓴다). 현행 = **첫 invocation만 빈 홈**(0700·정규·
     비-symlink·사용자 홈 금지) + 그때 **신원(dev+ino) 고정** → resume은 **같은 신원일 때만** 기존 상태 허용,
     경로 계약·권한·홈 금지·strict 플래그(`--strict-config`/`--ignore-user-config`/`--ignore-rules`/
     `mcp_servers={}`)·**단일 `CODEX_HOME` env**는 매번 재검증. **교체(inode)·symlink화·권한 완화·provider가
     소유하지 않은 기존 상태 = spawn 0.** 한계: **같은 uid 공격자 내성은 아니다**, 소유권은 **in-memory**(`C-22`).
  2. **승인 만료 재확인**: `nowMs`가 함수면 clock으로 취급 → `revalidateSync()`(spawn 직전 마지막 동기 검증)가
     `now >= expiresAt`을 **다시** 본다. 비동기 git 조회 중 만료 창을 닫았다. 걸치면 spawn 0.
  3. **신원 우선 파싱**: 의미 있는 **첫** JSONL 이벤트가 정규 UUID 하나를 세워야 한다. 그 전 이벤트는
     비가역 `missing_session_id`이고 **내용·도구 payload를 전달하지 않는다**(늦은 `thread.started`·정상 종료도
     되돌리지 못한다).
  4. **MCP 위반 세션 격리**: MCP를 본 thread는 `send`로 이어갈 수 없다(`codex_mcp_observed`, spawn 추가 0).
- **문서 정정(중요)**: 이전 판의 "**agent message 전문은 어떤 이벤트에도 실리지 않는다**"는 틀렸다.
  `raw`·추론 원문·명령 문자열·stderr/error payload·모르는 이벤트 payload는 **여전히 배제**되지만,
  **상한(`MAX_TEXT_CHARS`)을 지난 최종 본문은 `assistant.text`·`result.text`로 의도적으로 전달된다**
  (리뷰 판정·`--output-schema` 본문이 그 경로로 온다). `B-7`·`B-8`·`B-9`는 **여전히 open**이다.
- **2차 리비전 검증**: 파일 단독 `npx tsx --test --test-timeout=180000` → boundary **13/13** ·
  parser **26/26** · provider **40/40**(합 **79/79**) · `npm run test:exec` **221/221**(212 → 221) ·
  `npx tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 3회(예약 그대로).
  mutation 4종(홈 소유 신원 → 2건 / 만료 재확인 → 2건 / 신원 우선 → 2건 / MCP 격리 → 1건 실패) 후 정확히 원복,
  `MUTATION` grep 0 · `git diff --numstat` 기준선 일치.
- **2차 리비전이 추가한 열린 C**: `C-21`(프로토콜 실패 뒤 resume 허용 — `B-8`과 함께 M5b) ·
  `C-22`(홈 소유권 in-memory → controller 재시작 후 resume 불가, M5c) · `C-23`(turn 사이 spec 변경으로
  model/schema drift, M5b) · `C-24`(stderr chunk 단위 상한, M5c) · `C-25`(`events()`가 invocation별 큐, M5b).
  **새 B는 없고 열린 A도 없다.**
- **열린 항목 정본 목록(현행)**: B = `B-7` · `B-8` · `B-9`(전부 live/배선 하드 게이트, offline M5b는 막지 않는다).
  C = `C-17` · `C-18` · `C-19` · `C-21`~`C-25`. 아래 1차 리비전 블록의 열린 목록은 **그 시점 기록**이라
  `C-21`~`C-25`가 빠져 있다.
- **Codex 추론**: 2차 리비전 세션도 **0회**(fake CLI·in-process seam만). `B-7`/`B-8`/`B-9`를 닫기 전에는
  이 provider로 실제 Codex를 부르지 않는다.
- **M5는 2차 리비전 뒤에도 미완료다.** 다음: `B-7`/`B-8`/`B-9` 해소 → M5b 계획 → 사용자 승인.

### 이전 — M5a 1차 리비전 기록 (2026-07-27 · `CODEX_HOME` "비어 있음" 서술은 위 현행 블록이 대체한다)

worktree·branch·base 동일. 커밋 `115e0be`(feat) → `6ae7fd6`(docs) → `bdd5507`(fix, 1차 리비전).

- **독립 리뷰**: fresh Codex `gpt-5.6-sol` xhigh · read-only · strict empty MCP, 범위 `85ebe883..6ae7fd6`,
  판정 **REVISE** — **A 9건(P0 2 · P1 7)** + B 2건 + C 1건. playbook §6에 따라 작성 세션을 **한 번만 resume**해
  **A 9건을 전부 fixed**했다(`bdd5507`). 상세 표는 로드맵 §10 M5 → "M5a fresh Codex 독립 리뷰와 리비전".
  → 이전 판의 "**열린 P0 없음**"은 그 리뷰 **전** 서술이었다. 현행: 리뷰가 P0 2건을 냈고 **지금은 둘 다 fixed**이며
  **열린 A는 없다**. 열린 항목은 아래 B/C뿐이다.
- **핵심 계약 변경(리비전)**: 실행 파일은 **신뢰된 명시 절대경로**만(provider 코드에 `process.env` 0,
  spawn 직전 신원 검증) · 자식 env는 **`CODEX_HOME` 하나** · **`workspace-write` hard deny(read-only 전용)** ·
  fresh/resume argv 배치 분리(+`--strict-config`·`--ignore-user-config`·`--ignore-rules`) ·
  세션 신원은 **불변 정규 UUID 1개** · `CODEX_HOME`은 정규·비symlink·0700·**비어 있음**·사용자 홈 아님 ·
  비정규 입력 경로 거부 + **spawn 직전 동기 신원·HEAD 재확인** · **비가역 프로토콜 실패**(성공 뒤 실패/MCP/
  중복 종료/오염 줄 = 실패) · 멱등 invocation 상태 기계 · `raw`는 **bounded sanitized projection**.
- **열린 B(P1) 3건 — 전부 live/배선만 막고 offline M5b는 막지 않는다**:
  `B-7`(live 인증 미정 + live secret 값 redaction — stderr 폐기 또는 승인된 정확한 값만 전달) ·
  `B-8`(`reviewer.ts`가 `result.isError`와 빈/무효 구조화 출력을 통과시킨다 — **M5b reviewer 배선 전**) ·
  `B-9`(codex JSONL payload 필드명 live 확인 — **M5b live 전**). 열린 C: `C-18`(deadline·cancellation) ·
  `C-19`(`--output-schema` 응답 미검증) · `C-17`(kernel 만료 경계, M5c 전). **`C-20`은 `C-17` 중복이라 철회.**
- **`B-6`는 fixed**: supervisor가 codex-cli **`0.146.0-alpha.3`** help를 **parse-only로 실측**했고
  (추론 미실행) fresh/resume 플래그 배치를 argv 컴파일러와 파싱 계약 테스트에 고정했다.
  **JSONL payload semantics는 provider live로 검증하지 않았다**(`B-9`).
- **Codex 추론 사실관계**: **새 provider/live 경로로는 0회**. supervisor가 돌린 **별도 fresh read-only Codex
  리뷰 세션**만 실제 Codex 사용이었다.
- **검증**: 파일 단독 `executionBoundary.test.ts` **12/12** · `codexStreamParser.test.ts` **24/24** ·
  `codexCliProvider.test.ts` **34/34**(합 70/70) · `npm run test:exec` **212/212**(142 → 186 → 212) ·
  `tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 —
  **최종 전체 suite 1회는 supervisor가 M5 handoff 시점으로 예약**했다.
  mutation 2종(실행 파일 게이트 → 2건 실패 / 프로토콜 실패 게이트 → 16건 실패) 후 정확히 원복(`MUTATION` grep 0).
- **M5는 이 리비전 뒤에도 미완료다.** 다음: `B-7`/`B-8`/`B-9` 해소 → M5b 계획 → 사용자 승인.

## 이전 — M5a 구현 세션 기록 (2026-07-27 · 리뷰 전 시점. "열린 P0 없음"·env/sandbox 서술은 위 현행 블록이 대체한다)

격리 worktree `/private/tmp/solo-founder-harness-m5a` · branch `work/m5a-codex-provider` ·
base `85ebe883ff96fad1070a508f5d4a28f7fc637b8e`. **로컬 커밋만 만들고 원격 push/PR/merge는 0.**
Pony Tail(full). 네트워크·`gh`·패키지 설치·신규 의존성·package/lockfile 변경·MCP·**실제 Codex 추론**·
deploy·DB·production·live billing **없음**.

- **무엇이 들어갔나(M5a 범위 한정 승인)**: ⓐ 단일 fail-closed **실행 경계**
  `src/exec/executionBoundary.ts` — spawn 직전마다 controller·실행 checkout HEAD가 정확히
  `manifest.approvedCommit`인지 확인(대장 **`B-5` fixed**) ⓑ `src/exec/codexCliProvider.ts` —
  기존 `ExecutionProvider` 구현(argv 배열 · stdin 프롬프트 · 명시 cwd/model/effort/sandbox ·
  `--ephemeral` · `--json` · 선택 `--output-schema` · bypass 플래그 도달 불가 · `--last` 미사용)
  ⓒ `src/exec/codexStreamParser.ts` — JSONL 8종 좁은 파싱, **종료 결과 정확히 1건**, bounded/scrubbed
  ⓓ 결정론적 fake CLI 픽스처 + 테스트 3종. `src/exec/types.ts`는 `SessionSpec.codex?` **추가만**.
- **무엇이 아닌가**: autopilot CLI · Claude↔Codex 자동 전달 · 실제 7-agent 동시 실행 ·
  self-hosting controller 재시작 경계 · **live acceptance 전부**. **M5b/M5c/M5d는 시작도 하지 않았다.**
- **검증(명령 + 범위)**: 파일 단독 `executionBoundary.test.ts` **8/8** · `codexStreamParser.test.ts` **18/18** ·
  `codexCliProvider.test.ts` **18/18**(합 44/44) · `npm run test:exec` 전체 **186/186**(142 → 186) ·
  `tsc --noEmit` 0 · `npm run build` PASS · `git diff --check` clean.
  **미실행**: `npm test` 전체 · `test:core` · acceptance · stress · live · 반복 3회.
  mutation 2종으로 새 게이트 비공허성 확인 후 정확히 원복(diff 0 · `MUTATION` grep 0).
- **열린 P0 없음.** 열린 **B(P1) 2건**: `B-6`(로컬 `codex exec --help` 실측 미완 — 이 세션에서 실행 승인이
  나지 않았다) · `B-7`(격리 `CODEX_HOME`의 live 인증 방식 미정). **둘 다 M5b live 착수 전 하드 게이트다.**
  신규 C: `C-18`(deadline·cancellation) · `C-19`(`--output-schema` 응답 미검증) · `C-20`(kernel 만료 경계).
- **다음 단계**: fresh Codex read-only 리뷰 → `B-6`/`B-7` 해소 → M5b 계획 → 사용자 승인.

## 이전 — 문서 정합성 갱신 (2026-07-27 — **docs-only**)

격리 worktree `/private/tmp/solo-founder-harness-m4-doc-consistency` · branch `work/m4-doc-consistency` ·
base `c963cb0832d66a58fefdaa2025a9213966c3cc27`(= M4c 최종 HEAD)에서 **문서만** 고친 단일 세션이다.
소스·테스트·schema·script·package/lockfile·`dist`·config·`AGENTS.md`·`CLAUDE.md`는 **무수정**이고,
push/fetch/pull/PR/merge/rebase/reset/checkout/switch/worktree 조작·네트워크·`gh`·패키지 설치·MCP·
provider 호출·deploy·DB·production·live billing **없음**. Pony Tail(full) 적용. 로컬 커밋 1개만 만든다.

- **커밋 상태 정정**: M4a/M4b/M4c는 **각각 로컬 커밋이 존재하는 stacked 브랜치**다 —
  M4a `55d99a3`+`805da35` · M4b `11775fd`+`ab63eac` · M4c `3cfdb39`+`c963cb0`.
  각 구현 세션 본문의 "미커밋 working tree"는 **그 세션 시점 기록**이며 그대로 보존하되 역사 표시를 붙였다.
  원본 checkout은 `bbb8b72`로 clean·무수정. **원격 push/PR/merge는 여전히 0.**
- **테스트 범위 라벨 정정**: 파일 단독 `src/exec/orchestrationKernel.test.ts`는 **67/67**(M4a 37 → M4b 50 →
  M4c 67)이고 **142/142는 `npm run test:exec` 전체 suite**(125 → 142)다. 이전 문서가 142/142를
  "파일 단독 focused"로 적은 곳을 전부 고쳤다. core **374/374** · acceptance **92/92** ·
  offline acceptance M4a **31/31** · M4b **42/42** · M4c **77/77** · build PASS는 불변.
  **stress·live·반복(3회) suite는 이 세션에서도 실행하지 않았다.**
- **대장 추가**: Codex 최종 리뷰 3건을 로드맵 §9.1에 `B-5`(P1, manifest `approvedCommit`이 실행 checkout
  HEAD에 묶이지 않음) · `C-16`(P2, taskId↔roleId 교차 모호성) · `C-17`(P2, `expiresAt` 정확히 같은 시각
  1회 허용)으로 등록했다. **셋 다 backlog 등록이고 지금 코드 리비전 루프를 열지 않는다.**
- **신규 문서**: `docs/handoff/CLAUDE_CODE_WORKER_PLAYBOOK.md` — Claude Code 구현 세션 운영 표준.
  **다음 세션들은 이 문서를 공통 기준으로 따른다**(장기 고정 규칙은 `AGENTS.md`, 진행 사실은 이 문서).
- **검증 실측**: `git diff --check` clean · 소유 밖 변경 0 · `npm test` **1회 직렬 실행 PASS**.
  최초 시도는 격리 worktree에 `node_modules`가 없어 `tsx: command not found`로 멈췄고, 감독 Codex가
  **원본 checkout의 기설치 `node_modules`를 ignored 로컬 symlink로 제공**한 뒤 실행했다 —
  **패키지 설치·네트워크는 없었다**(`node_modules`는 untracked·미커밋).
  실측: acceptance **PASS=92 FAIL=0**(Test 1~15 전부 OK). `test:inner`가
  `test:exec && test:core && acceptance` **`&&` 체인**이므로 acceptance 도달이 exec·core 통과를 뜻하지만,
  **exec·core 개별 카운트는 이 실행에서 캡처하지 못했다** — base `c963cb0` 실측(exec 142/142 ·
  core 374/374)을 이 세션 실측으로 옮겨 적지 않는다. **stress·live·반복·두 번째 전체 suite 미실행.**
- **M5는 여전히 not started·미승인**이다. 이 세션은 문서 정합성 승인일 뿐 M5 구현 승인이 아니다.

## 최신 갱신 (2026-07-27 — V3 **M4c: 중앙 경유 sibling/reviewer 라우팅 + 메시지 10종 + milestone approval manifest + 7 specialist registry** · M4b 위 **stacked PR** · **M4 전체 완료 · M5 미완료** · 열린 P0 없음)

이 세션은 **M4c 범위 한정 승인**을 받은 구현 세션이다. 격리 worktree
`/private/tmp/solo-founder-harness-m4c` · branch `work/m4c-routing-approval` ·
base `ab63eacc51650deaee0ce92b78a22a7ddcdc27bd`(**리뷰 완료된 M4b 커밋**)에서 단일 세션으로 진행했다.
**M4a·M4b·M4c는 분리된 stacked local 브랜치/PR 단위이며 각각 로컬 커밋이 존재한다**
(M4a `55d99a3`+`805da35` · M4b `11775fd`+`ab63eac` · M4c `3cfdb39`+`c963cb0`,
**M4c 최종 HEAD = `c963cb0832d66a58fefdaa2025a9213966c3cc27`**).
구현 세션 자체는 커밋을 만들지 않았고(그 시점에는 미커밋 working tree였다) 커밋은 리뷰 후 로컬에서 이뤄졌다.
**push/PR/merge/rebase/reset은 여전히 수행하지 않았다.** 원본 checkout(`bbb8b72`, clean)과 M4a/M4b worktree는 수정하지 않았고,
네트워크·`gh`·deploy·DB·production·live billing·패키지 설치·신규 런타임/dev 의존성·package/lockfile
변경·MCP 서버·provider 호출·subagent/Agent Team **없음**. Pony Tail(full) 적용 세션이다.

### 0) M4c가 닫은 것 / 남긴 것 (검수 시작점)

- **닫음**: 대장 `C-6`(§5.1 나머지 6개 메시지 타입 + 7 specialist registry). 그리고 M4b가 M4c 잔여로
  남겼던 **sibling 전달 · reviewer 왕복 · milestone approval manifest**를 전부 구현했다 →
  **M4 전체 완료**(M4a + M4b + M4c의 focused/offline/전체 suite 증거 기준).
- **안 닫음(= M5 이후)**: provider bridge(`CodexCliProvider`)·autopilot CLI · **실제 7-agent 동시 실행** ·
  live acceptance · UI/dashboard. **M5를 완료로 적지 않았다.**
- **의도적 미구현(대장 등록)**: manifest 재승인 전이(`C-11`) · ack 재전송/우선순위(`C-12`) ·
  리뷰 대상의 durable 필드화(`C-13`) · command 조회의 shell 파싱(`C-14`) · run별 registry(`C-15`).
  기존 `C-4`(크래시/fsync) · `C-8`(stale lock 회수) · `C-9`(schema 마이그레이션) · `C-10`(fairness/retry)도
  그대로 open이다.

| 파일 | 성격 |
|---|---|
| `src/exec/orchestrationTypes.ts` | 수정 — 메시지 10종 · `CENTRAL_MESSAGE_TYPES` · `SUMMARY_REQUIRED` · heading 6종 · manifest 타입 · route 필드 · `manifest` state 필드 · 이벤트 1종 · 상한 9개 |
| `src/exec/approvalManifest.ts` | **신규** — §8 manifest closed validator · 7 specialist registry · M5용 순수 조회 술어 3개(실행 없음) |
| `src/exec/orchestrationStore.ts` | 수정 — key 집합·manifest 검증·`state_pre_m4c_unsupported`·roleId registry·`assertManifestOwnership`/`assertSessionLimit`·`pendingDeliveries`·snapshot 4개 섹션·digest |
| `src/exec/orchestrationKernel.ts` | 수정 — 필수 `manifest` bind · 만료 게이트 · 좁은 진입점 6개 + `acknowledgeDelivery` + 읽기 3개 · scheduler 세션 예산 |
| `src/exec/orchestrationKernel.test.ts` | 수정 — 파일 단독 focused 50 → **67건**(M4c 17건, 삭제·완화 0). exec suite 전체는 125 → 142건 |
| `schemas/milestone_approval_manifest.schema.json` | **신규** — §8 계약 문서 |
| `schemas/agent_message.schema.json` | 수정 — type enum 10종 + 타입별 heading |
| `schemas/orchestration_run_state.schema.json` | 수정 — `manifest` required · route 필드 · `specialistRoleId` · 이벤트 enum |
| `scripts/m4c-offline-acceptance.mjs` | **신규** — offline acceptance 77 체크 |
| `scripts/acceptance.sh` | 수정 — Test 15 11 checks 추가(**기존 Test 1~14 무변경**) |
| `scripts/m4a-offline-acceptance.mjs` · `scripts/m4b-offline-acceptance.mjs` | 수정 — manifest 상수 + 인자 1개씩(**체크 수 31/42 불변, 기존 단정 무변경**) |
| `dist/exec/*.js` | `npm run build` 산출물 |

### 0-1) 확정된 M4c 계약 (검수 포인트)

- **envelope 필드 집합 무변경**(§5.1). route는 message index의 `routeToTaskId`/`acknowledgedAt`이며
  **중앙이 정한다**. sibling 전달에서도 발신 agent의 `recipient`는 언제나 `orchestrator`다 →
  "직접 mailbox 쓰기"가 계약상 표현 불가능하다. 다른 task 상태를 바꾸는 API도 여전히 없다.
- **heading**: §5.2 지정분(`review_result`, 공유 `blocker`/`decision_request`)은 그대로. 미지정 4종
  (`status_update`·`review_request`·`revision_request`·`decision`)만 **최소 closed set 3개씩** 신설.
  summary는 `task_assignment`/`spawn_request`만 null, 나머지 8종 필수(`SUMMARY_REQUIRED`).
- **라우팅 게이트**: sibling = 같은 parent 또는 직접 의존만. `route_self`/`unknown_recipient`/
  `ambiguous_recipient`(같은 roleId 다수)/`invalid_recipient`(orchestrator)/`recipient_unavailable`/
  `route_not_related` — 전부 전이 0. reviewer는 **completed 대상 + 그 대상에 의존 + fresh**,
  `review_result`는 선행 요청 필요, `revision_request`는 선행 review_result 필요,
  `decision`은 미응답 요청 필요. **라우팅은 task 상태를 바꾸지 않는다.**
- **전달 목록은 durable state만으로** 계산(`createdAt`→`messageId`) → 재시작 후 같은 다음 전달.
  수령은 좁은 전이 하나 + durable event `delivery_acknowledged`(상태 전이 없음). 범용 queue 없음.
- **manifest 필수 bind**(기본값 없음 = 조용한 자동 승인 금지). digest·snapshot 포함 →
  승인 범위 손편집은 `state_event_binding_mismatch`. milestone 불일치는 `manifest_milestone_mismatch`.
  **강제 권한**: ownership 명시 승인 · writableRoots · child = parent 부분집합 · `maxSessions` · 만료.
  전부 **커밋 경로 공용 불변식**(M4b와 같은 자리)이라 새 전이 경로도 load도 우회할 수 없다.
- **실행 권한은 조회만**: 순수 술어 3개, deny-by-default, 정확히 pin된 버전만(`latest`·범위·tag 거부),
  하위 도메인 자동 허용 없음, command는 문자열 동치(shell 파싱 없음). `localMergeAllowed`는 기록 전용 —
  **kernel은 git을 만지지 않고 repo hard deny가 항상 더 강하다.**
- **registry 7종 + 하위 role 한 겹**만 `roleId`로 허용(`unknown_role`). run별 7 task를 요구하지 않고
  프로세스도 띄우지 않으며 provider/모델 라우팅을 중복 정의하지 않는다.
- **pre-M4c state는 `state_pre_m4c_unsupported` 하나로 fail closed**(마이그레이션 없음).

### 0-2) M4c 검증 실측 (offline)

- focused **파일 단독** `src/exec/orchestrationKernel.test.ts` **67/67**(50 → 67, M4c 17건) ·
  `npm run build` PASS · `git diff --check` clean.
  (**142/142는 파일 단독 focused가 아니라 `npm run test:exec` 전체 suite 수치**다 — 125 → 142.)
- offline acceptance: M4c **77/77** · M4a **31/31** · M4b **42/42**(전부 exit 0).
- `npm test` **PASS(최종 코드 변경 후 1회)** = exec **142/142** + core **374/374** + acceptance **92/92**.
- **stress·live·반복 suite 미실행**(`B-1`/`B-2` — M4c 게이트 아님).
- **mutation 4종**(ownership 불변식 / session 불변식 / sibling 관계 검사 / 만료 게이트)으로 비공허성 확인 후
  **정확히 원복**(파일 SHA-256 일치 · `MUTATION` 흔적 grep 0 · **파일 단독 focused 67/67** 재확인).
- **문서 정정**: 대장 `C-4` 보강의 "lock 발행 후 write 실패도 잔재를 남긴다"는 부정확 → 커밋 경로의
  잡힌 write 실패는 `finally`가 lock을 해제한다. 잔재는 크래시/kill · 해제 실패 ·
  acquire의 nonce write 실패 창뿐이다. (`maxResourceClasses`는 코드·문서 모두 이미 **4**로 일치했다.)

---

## 이전 갱신 (2026-07-27 — V3 **M4b: 배타 자원 class + deterministic scheduler + run writer lock** · M4a 위 **stacked PR** · **M4 전체 미완료(M4c 잔여)** · 열린 P0 없음)

이 세션은 **M4b 범위 한정 승인**을 받은 구현 세션이다. 격리 worktree
`/private/tmp/solo-founder-harness-m4b` · branch `work/m4b-resource-scheduler` ·
base `805da35801a59aeecf436d96d1054483247d643b`(**리뷰 완료된 M4a 커밋**)에서 단일 세션으로 진행했다.
**M4a와 M4b는 분리된 stacked PR이며 이 세션은 commit/push/PR/merge/rebase/reset/checkout/switch/worktree
조작을 하지 않았다**(미커밋 working tree). 원본 checkout은 수정하지 않았고,
네트워크·`gh`·deploy·DB·production·live billing·패키지 설치·신규 런타임/dev 의존성·package/lockfile
변경·MCP 서버·provider 호출·subagent/Agent Team **없음**. Pony Tail(full) 적용 세션이다.

> **역사 기록 표시 (2026-07-27 정정):** 위 "미커밋 working tree"는 **M4b 세션 시점의 기록**이다.
> 현행 사실은 M4b가 로컬 커밋 `11775fd`(feat) + `ab63eac`(docs)로 남아 있다는 것이다. push/PR/merge는 없다.

### 0) M4b가 닫은 것 / 남긴 것 (검수 시작점)

- **닫음**: 대장 `B-3`(exclusive resource class + scheduler) · `B-4`(멀티프로세스 writer lock).
  둘 다 테스트가 증명했을 때만 fixed로 적었다.
- **안 닫음(= M4c)**: sibling 전달 · reviewer 왕복(나머지 6개 메시지 타입) · milestone approval manifest ·
  7 specialist registry 등록 · **실제 7-agent 동시 실행** · provider bridge/MCP · CLI/UI.
  **M4 전체를 완료로 적지 않았다.**
- **의도적 미구현(대장 등록)**: 커밋 중간 크래시 복구·fsync 하드닝(`C-4` 보강) · stale lock 자동 회수·
  소유자 생존 확인(`C-8`) · state schema 마이그레이션 도구(`C-9`) · priority/fairness/retry/starvation
  방어(`C-10`).

| 파일 | 성격 |
|---|---|
| `src/exec/orchestrationTypes.ts` | 수정 — `resourceClasses` 필드 · 상한 2개 · `normalizeResourceClasses()` |
| `src/exec/orchestrationStore.ts` | 수정 — validator/`TASK_KEYS`/snapshot 반영 · `assertExclusiveResourceClaims` · writer lock · `CommitInput.base` 대조 |
| `src/exec/orchestrationKernel.ts` | 수정 — `TaskSeed.resourceClasses?` · `scheduleReady()` · `startScheduledBatch()` · `#mutate`의 커밋 기준 전달 |
| `src/exec/orchestrationKernel.test.ts` | 수정 — focused 37 → **50건**(삭제·완화 0) |
| `schemas/orchestration_run_state.schema.json` | 수정 — `task.resourceClasses` required·bounds |
| `scripts/m4b-offline-acceptance.mjs` | **신규** — offline acceptance 42 체크 |
| `scripts/acceptance.sh` | 수정 — Test 14 6 checks 추가(**기존 Test 1~13 무변경**) |
| `dist/exec/*.js` 3개 | `npm run build` 산출물 |

### 0-1) 확정된 M4b 계약

- **자원 선언은 durable하다.** task가 배타 자원 class를 **0..4개** 선언한다(slug · 사전순 · 중복 거부 ·
  빈 배열 = 병렬 안전). state·schema(required)·snapshot·`stateContentDigest`에 모두 들어가므로
  선언을 손으로 고치면 `state_event_binding_mismatch`로 거부된다. **선언 주체는 중앙**이고
  §5.1 envelope 필드 집합은 무변경이다(agent가 자기 자원 권한을 만들 경로 없음).
- **점유는 `running` 동안만**이고 `waiting_children`은 중단 상태라 자원을 들고 있지 않다(명시 결정 —
  DECISIONS 참조. 대가: parent가 다시 ready여도 그 class가 남에게 잡혀 있으면 즉시 시작되지 않는다).
- **scheduler = kernel 메서드 2개**(두 번째 오케스트레이터 없음): `scheduleReady(limit?)`는 `taskId`
  오름차순으로 ① running 점유 class와 ② 같은 batch에서 앞서 고른 class를 피해 고른다(state 변경 0).
  `startScheduledBatch(limit?)`는 **커밋 1회**로 시작한다. 상한 1..8, 범위 밖은 `invalid_batch_limit`.
- **충돌 규칙은 커밋 경로 공용 불변식 하나**(`assertExclusiveResourceClaims` ←
  `assertReferentialIntegrity`)다 → 직접 `startTask`도, 앞으로 추가되는 어떤 전이 경로도, load도 같은
  검사를 받는다(`resource_conflict`, 전이 0). **`startTask` 안의 중복 사전 검사는 mutation에서 비공허성이
  없음이 드러나 삭제했다** — 우회 불가는 이 공용 불변식이 보장한다.
- **커밋은 run 단위 배타 writer lock 안에서만** 일어난다(`run_state.lock`, `O_CREAT|O_EXCL`,
  **대기 없음** = `run_lock_held`). lock을 쥔 채 base 확인 → body → events → snapshot → state를 모두
  수행하고 정상·실패 모두 해제한다(정상 커밋 후 잔재 0). 해제는 `O_RDONLY|O_NOFOLLOW` 읽기 + nonce
  대조라 **남의 lock은 보존**한다(`run_lock_owner_mismatch`).
- **stale writer는 fail closed다.** `CommitInput.base`(직전 디스크 state의
  `revision`/`lastEventId`/`lastEventHash`)를 lock 안에서 디스크와 대조한다 → 같은 revision에서 열린
  두 kernel 중 늦은 쪽은 `stale_writer`로 거부되고 **먼저 쓴 결과를 덮지도 남의 event tail에 이어
  붙이지도 않는다**(파일 전이 0). `base`는 optional이 아니다(기본값 = 조용한 보호 이탈).
- **하위 호환**: `resourceClasses`가 없는 **M4a state는 마이그레이션하지 않고 거부**한다
  (`state_pre_m4b_unsupported` → 새 run 생성). `schemaVersion`은 `"1"` 유지(그 상수는 메시지 envelope와
  공용이라 올리면 M4a 계약·Test 13까지 흔든다). 마이그레이션 프레임워크는 만들지 않았다(`C-9`).
- **기존 suite lock은 재사용하지 않았다** — guard·ownership token 상속·pgid 스캔·격리 같은 suite 전용
  의미를 orchestration 커밋 경로에 결합시키지 않기 위해서다(`C-8`에 한계 기록).

### 0-2) M4b 검증 실측 (offline, 이 세션)

- focused `src/exec/orchestrationKernel.test.ts` **50/50 PASS**(37 → 50, M4b 13건).
- `npm run build` PASS · `git diff --check` clean.
- `node scripts/m4b-offline-acceptance.mjs` **42/42 PASS(exit 0)** ·
  `node scripts/m4a-offline-acceptance.mjs` **31/31 PASS(불변)**.
- `npm test` **PASS — 최종 코드 변경 후 1회**: `test:exec` → `test:core` → acceptance **81/81**(75 → 81).
  `npm run test:exec` 단독은 **125/125**(112 → 125)로 별도 확인했다. **core 카운트는 이 세션에서 별도로
  캡처하지 않았다**(`test:inner`가 `&&` 체인이므로 acceptance 단계 도달 자체가 exec·core 통과를 뜻한다).
  **두 번째 `npm test`는 중복 실행이라 Codex가 시작 직후 중단시켰고 결과로 세지 않는다**(부분 출력 없음).
- **stress·live runner·반복(3회) suite 미실행** — `B-1`/`B-2`는 nonblocking release-readiness backlog이며
  M4b 게이트가 아니다.
- **비공허성(mutation) 4종**: ① 공용 자원 불변식 제거 → M4b 3건 실패 ② stale base 대조 제거 → 1건 실패
  ③ lock EEXIST를 성공 처리 → 2건 실패 ④ `startTask` 중복 검사 제거 → **0건 실패(→ 삭제)**.
  ①~③ 정확히 원복 후 focused 50/50 재확인 · 소스 내 `MUTATION` 흔적 grep 0.

---

## 이전 갱신 (2026-07-27 — V3 **M4a durable orchestration kernel 구현 + Codex P0 2건 수정 완료** · **M3 완료(재개방 금지)** · **M4 전체 미완료** · 열린 P0 없음)

이 세션은 **M4a 범위 한정 승인**을 받은 구현 세션이다. 격리 worktree
`/private/tmp/solo-founder-harness-m4a` · branch `work/m4a-durable-orchestration` ·
base `ea764a54108f1715248f3e0ae414ea87eb8ffaa9`(PR #10 merge commit)에서 단일 세션으로 진행했다.
원본 checkout `/Users/jihun/Developer/solo-founder-harness`는 **읽기 전용**으로만 접근했다.
**commit/push/fetch/PR/merge/rebase/reset/checkout/switch/worktree 조작 없음**,
네트워크·`gh`·deploy·DB·production·live billing·패키지 설치·신규 런타임/dev 의존성 **없음**,
subagent/Agent Team **없음**.

### 1) 무엇이 들어갔나 (M4a — state-only/offline 수직 슬라이스)

`src/exec` 안에 향후 provider가 소비할 **deterministic durable orchestration kernel**을 추가했다.
**provider·LLM·프로세스를 하나도 띄우지 않는다.** 기존 `runWorkflow`/`mission`/`ExecutionProvider`,
`projects/<p>/outputs/run_state.json`, `registry/agent_registry.json`은 **복제·교체·마이그레이션 모두 없음**.

| 파일 | 성격 |
|---|---|
| `src/exec/orchestrationTypes.ts` | 신규 — 타입·상한·원시 검증자(slug/timestamp/sha256/path 정규화) |
| `src/exec/agentMessage.ts` | 신규 — §5.1 envelope + §5.2 타입별 body runtime validator |
| `src/exec/orchestrationStore.ts` | 신규 — 영속화·적재·closed state validator·결정론적 snapshot |
| `src/exec/orchestrationKernel.ts` | 신규 — 상태 기계와 좁은 공개 API |
| `src/exec/orchestrationKernel.test.ts` | 신규 — focused 34건 |
| `schemas/agent_message.schema.json` | 신규 — 계약 문서 |
| `schemas/orchestration_run_state.schema.json` | 신규 — 계약 문서 |
| `scripts/m4a-offline-acceptance.mjs` | 신규 — offline acceptance(29 체크) |
| `scripts/acceptance.sh` | 수정 — Test 13 4 checks 추가(**기존 Test 1~12 무변경**) |
| `.gitignore` | 수정 — `outputs/orchestration/` 1줄 |
| `dist/exec/*.js` 4개 | `npm run build` 산출물 |

### 2) 확정된 계약 (검수 시 이 목록을 기준으로 보면 된다)

- task 상태는 `pending | ready | running | waiting_children | completed | blocked` **6개뿐**.
- 메시지 타입은 `task_assignment` · `spawn_request` · `result` · `blocker` **4종뿐**이고
  §5.1의 나머지 6종은 **schema·runtime 양쪽에서 거부**한다(조용히 통과하는 경로 없음).
- §5.1 envelope 필드 유지 + machine-readable envelope와 human-readable Markdown body 동시 처리.
  body는 타입별 필수 h2 heading 전부 · 계약 밖 h2 금지 · 중복 금지 · 16 KiB 상한(코드펜스 안의 `##`은
  heading으로 세지 않는다).
- spawn 상한: **task당 child 4 · child depth 최대 3(root=0) · run당 task 32**. child도 같은 bounded
  API로 자기 child를 요청한다. 이미 `waiting_children`인 parent도 상한 안에서 추가 spawn이 가능하다
  (그렇지 않으면 "child 4개" 상한이 실질 1개가 된다 — DECISIONS 참조).
- ownership은 workspace-relative 정규화(`.`만 접음)이며 absolute·`..`·빈 경로·빈 segment·backslash·
  NUL을 거부한다. **M4a에서 ownership은 기록·검증 메타데이터일 뿐 파일 권한도 provider 실행 권한도 아니다.**
- `result`가 중앙으로 옮기는 것은 **bounded summary(≤1000자)와 검증된 artifact 포인터뿐**
  (path · SHA-256 · revision · producer task · role). raw artifact 본문·raw transcript 복사 없음.
- 수락 **직전** artifact 재검증: 일반 파일 여부 · leaf symlink 거부 · **상위 디렉터리 symlink를 통한
  workspace 탈출까지 realpath 비교로 거부** · 등록 revision/hash와 현재 hash 일치. 전부 fail-closed.
  artifact 등록은 조용히 덮어쓰지 않고 revision + `supersedes`를 남긴다.
- child completed → 모든 child가 완료된 parent를 ready로, 의존이 전부 완료된 dependent를 ready로
  kernel이 재계산. blocker → child blocked + 영향받는 조상·dependent blocked(completed는 불변).
- **agent가 다른 task 상태를 직접 바꾸는 API 없음.** 공개 prototype 메서드 목록을 테스트가 고정하고
  읽기 API는 전부 깊은 사본을 돌려준다.
- SoR `outputs/orchestration/<run-id>/run_state.json` · append-only 해시 체인 `events.jsonl` ·
  검증된 body 저장소 `messages/<message-id>.md` · 파생물 `snapshot.md`.
  state에 `schemaVersion` · monotonic `revision` · `lastEventId`/`lastEventHash`.
  저장은 **같은 디렉터리 임시 파일 → rename**(과도한 fsync/crash hardening은 범위 밖).
- load fail-closed: state runtime schema · event linkage · message body hash · artifact hash 중
  하나라도 어긋나면 던진다. **null/빈 run으로 강등하지 않는다.**
  **유효하지 않은 입력에서는 state revision과 영속 파일 모두 전이 0**(검증 → 커밋 순서로 구조적 보장).
- ready 목록·snapshot은 taskId 정렬로 결정론적이고, **create 경로와 open 경로가 같은 직렬화 바이트**를
  낸다(테스트가 `JSON.stringify` 동일성으로 단정).
- `roleId`는 **opaque slug 계약** — 향후 7개 상위 specialist와 하위 specialist를 그대로 수용한다.
  **registry 등록·동시 실행은 이번에 하지 않았다.**
- schema 2건은 **계약 문서**이고 **보안 경계는 runtime validator**다(신규 검증 의존성 0).
  enum·required·bounds 동치를 테스트 2건이 강제한다.

### 3) Codex 독립 리뷰 P0 2건 — **둘 다 수정 완료 (2026-07-27)**

**P0-1 — 형태가 유효한 `run_state.json` 변조가 중앙 전이 계약을 우회했다.**
재현: run/root 생성 → root start → `run_state.json`만 편집(`tasks[0].state="completed"`,
`tasks[0].resultSummary="forged"`) → `openOrchestrationRun`이 **수락**. 기존 load는 형태·참조·
event 해시 체인은 봤지만 **state 내용을 event 이력에 묶지 않았다** → 후속 작업이 잘못 풀릴 수 있었다.

수정(최소·의존성 0): 커밋의 **마지막 이벤트**에 `stateDigest`를 넣는다. 값은 그 커밋이 남기는
**state 내용**의 SHA-256이며, chain 필드(`lastEventId`/`lastEventHash`)를 **제외**해 순환을 피한다
(state → event digest → chain hash → state.lastEventHash). load는 `assertStateEventBinding`으로
재계산·대조하고 불일치는 `state_event_binding_mismatch`, digest 부재는
`state_event_binding_missing`으로 fail-closed다. 커밋마다 이벤트가 최소 1건 있어야 하므로
`commitRun`이 빈 이벤트 커밋을 `commit_without_event`로 거부한다.
직렬화 정규화·event/message/artifact 기존 계약·invalid-input 전이 0·parent/child acceptance 동작은
그대로 유지했고, event 계약이 바뀐 만큼 JSON Schema와 runtime parity 테스트도 함께 갱신했다.
**한계(정직하게)**: 키 없는 digest이므로 `run_state.json`과 `events.jsonl`을 **모두 일관되게
재작성**하는 위조는 막지 못한다 — 그 경우 append-only 감사 로그 자체가 조작되므로 감사 대상이며,
상향 경로는 out-of-band 키를 쓰는 HMAC/서명이다(backlog `C-7`).

**P0-2 — 문서가 완료된 M3를 재개방하고 있었다.** 현행 상태 문서가 `B-1`/`B-2`를 여전히 "M3d 완료
게이트 / 사용자 액션 대기"로 적고 있었다. 현행 판정은 아래 4)이며, 과거 dated 항목은 **그 시점의
기록으로 보존**했다(원 문장을 고쳐 쓰지 않았다).

### 4) 현행 마일스톤 상태 (이 절이 최신이며 아래 dated 항목보다 우선한다)

- **M3는 완료다.** M3a/M3b/M3c core와 **실제 live acceptance까지 완료**됐고 M3d.2는 PR #10으로
  `ea764a5`에 병합됐다. **M3/M3d는 재개방하지 않는다.**
- **`B-1`(부하/stress 재실행) · `B-2`(live runner 재실행·evidence 재생성)는 nonblocking
  release-readiness backlog다.** M3 완료 게이트가 **아니고** M4 작업의 선행 조건도 **아니다**.
  이 문서 아래쪽 2026-07-26 이전 항목들이 둘을 "차단"으로 적은 것은 **그 시점 기록**이다.
- **M4a는 완료**(offline 검증), **M4 전체는 미완료**. 열린 **P0는 없다**.

### 5) 검증 실측 (offline, 2026-07-27 — P0 수정 후 최종)

| 단계 | 결과 |
|---|---|
| `./node_modules/.bin/tsx --test src/exec/orchestrationKernel.test.ts` | **37/37 PASS** (34 → 37, P0-1 회귀 3건) |
| `npm run build` | **PASS** |
| `node scripts/m4a-offline-acceptance.mjs` | **PASS — 31/31 체크, exit 0** (29 → 31, 위조 state 거부 2건) |
| `npm test` | **PASS** = exec **112/112**(75 → 112) + core **374/374**(불변) + acceptance **75/75**(71 → 75) |
| `git diff --check` | clean |

`npm test` 실행 횟수는 **구현 체인 전체에서 4회**다 — 구현 세션 3회(최초 / 카운트 확인용 재실행 /
미사용 코드 삭제 후 최종)와 **이번 P0 수정 세션의 마지막 코드 변경 후 정확히 1회**.
**4회 모두 PASS**이며 이 사실을 축약하지 않고 그대로 적는다.

**stress(`npm run acceptance:stress:m3d2`) · live runner 3종 · 반복(연속 3회) suite는 실행하지 않았다.**
이것들은 **nonblocking release-readiness backlog**이며 M3 완료 게이트도 M4 선행 조건도 아니다.
M3/M3d를 재개방하지 않았고 기존 테스트를 삭제·완화하지 않았다.

### 6) M4a 완료 ≠ M4 완료

**M4a 최소 수직 기능은 완료**이고 **M4 전체는 미완료**다. 아래는 **구현하지 않았고 완료로 적지 않는다**:

- 실제 Claude/Codex/provider 프로세스 spawn, provider bridge, MCP, 네트워크
- 7개 agent registry 등록·동시 실행(`registry/agent_registry.json` 무수정)
- §5.1의 나머지 6개 메시지 타입(status_update / review_request / review_result / revision_request /
  decision_request / decision)
- 범용 scheduler, **exclusive resource class 계약**(M4 "완료" 4번째 항목 — 미충족)
- 멀티프로세스 writer lock, milestone approval manifest 전체, CLI/UI/대시보드
- 장시간 반복·stress·live, 과도한 fsync/crash recovery

### 7) 유예 항목 (로드맵 §9.1 대장 — **열린 P0 0건**, P1/P2는 이번에 구현하지 않았다)

| id | 분류 | 요지 | 기한/트리거 |
|---|---|---|---|
| `B-3` | B (P1) | exclusive resource class + scheduler 미구현 | **M4 완료 전(= M5 bridge 착수 전)** |
| `B-4` | B (P1) | 멀티프로세스 writer lock 없음(단일 writer 전제) | 병렬 worker 도입 시 또는 M4 완료 전 |
| `C-4` | C (P2) | 커밋 중간 크래시 복구 도구 없음(fail-closed로 남음) | M10 hardening |
| `C-5` | C (P2) | artifact 검증의 경로 기반 TOCTOU 창(Node 18 한계) | Node 20+ 또는 M10 |
| `C-6` | C (P3) | 잔여 6개 메시지 타입 · 7 specialist registry 미구현(계획된 미구현) | M6 |
| `C-7` | C (P2) | state↔event binding이 키 없는 digest라 **두 파일 동시 재작성 위조**는 막지 못한다 | 서명/HMAC 승인 시 또는 M10 |

`B-1`(부하/stress 재실행) · `B-2`(live runner 재실행)는 **nonblocking release-readiness backlog**로
재분류됐다(M3 완료 게이트 아님). `C-1`~`C-3`은 그대로 열려 있다.

### 8) 다음

M4 잔여 범위(scheduler · exclusive resource class · sibling/reviewer 메시지 · approval manifest)의
계획→승인→구현. `B-1`/`B-2`는 **release 준비 시점의 트리거**로만 남는다.

## 이전 갱신 (2026-07-26 — 여덟 번째 리비전 **재검토 결과 기록 + 배송 우선 리뷰 정책 · 병렬 세션 정책 도입**: verdict `APPROVE_FEATURE_PROGRESSION` · Category A 0건 · **M3d 완료 APPROVE 아님** · 부하 acceptance 미충족(차단) · live acceptance pending → **M3d 미완료** · 문서 전용 세션)

이 세션은 **문서·정책 전용**이다. 코드·패키지·schema·script·생성 산출물·의존성은 **한 줄도 바꾸지 않았고**,
commit/push/fetch/pull/PR·패키지 설치·네트워크·테스트·stress·live runner도 **실행하지 않았다**.
변경 파일은 정확히 9개: `AGENTS.md` · `CLAUDE.md` · `docs/handoff/CODEX_HANDOFF.md` · `docs/CONTEXT_SUMMARY.md` ·
`docs/WORKLOG.md` · `docs/DECISIONS.md` · 활성 V3 문서 3건(로드맵 · MCP · DESIGN).

### 1) 여덟 번째 리비전 재검토 결과 (fresh Codex Sol xhigh · read-only)

- **verdict: `APPROVE_FEATURE_PROGRESSION`.** 리뷰는 read-only였고 테스트·네트워크·편집을 하지 않았다.
- **Category A(지금 차단): 0건.**
- **이것은 M3d 완료 APPROVE가 아니다.** 부하(stress) acceptance는 여섯 번째 리비전의 **FAIL 기록 그대로
  미충족/pending**(차단 게이트)이고, live runner 3종과 evidence 3건도 pending이다 → **M3d는 미완료**다.
  **기존 완료 게이트는 전부 그대로 존재한다.** 이 판정을 "M3d APPROVE"로 줄여 적지 않는다.
- **Category C(개선 backlog) 1건**: bounded computed dynamic specifier 분석이, 도달 가능한 조각 각각에는
  `fixture-config`가 없지만 런타임에 합성되는 route(예: `"./lib/" + (flag ? "fixture-" : "other-") + "config.mjs"`)를
  놓칠 수 있다. 현재 production 호출부 5개는 **영향 없음** · 확률 낮음 · 영향 반경은 "미래 소스 레벨 호출부 감사
  누락"으로 한정 · 유예 비용 낮음 · 수정 공수 소~중 → 유예 대장 **`C-1`**(로드맵 §9.1)로 등록했고 이번에 고치지 않았다.
  같은 Category C의 **문서 정확성 정정**("unproven/loader 보고 = 조용히 통과하는 경로 없음"이라는 과장 제거,
  bounded 규칙 서술과 positive dist-import 대조군은 유지)은 아래 여덟 번째 리비전 항목 본문에 반영했다.
- 리뷰 이력 현행: **REQUEST_CHANGES 8회(리비전 1~8에 각 1회) + 진행 승인 1회**. **M3d 완료 승인은 0회.**
- **M4 구현은 not started**이며 별도 사용자 마일스톤 승인이 필요하다. 배송 우선 원칙에 따라 **M4 계획 준비는
  지금 가능**하고, 승인된 offline/격리 M4 작업이 남은 외부 M3d 작업과 겹칠 수 있다는 **제안**은 로드맵 M4 절에
  적었다 — **제안일 뿐 발동하지 않았고 승인받지도 않았다.**

### 2) 사용자 승인 정책 도입 (문서화만)

- **리뷰 finding 분류 A/B/C + 배송 우선**: A = 지금 차단(P0/P1 · 데이터 손실 · 승인/인증/상태 전이 우회 ·
  되돌리기 어려운 아키텍처 · 유예 비용이 커서 후속 작업이 안전하지 않거나 폐기 대상), B = 지정 마일스톤/트리거 전
  필수(명시적 기한이 있을 때만 유예), C = 개선 backlog. **C만으로는 리비전 루프를 다시 돌리거나 기능 진행을
  멈추지 않는다.** 우선순위는 **심각도 단독이 아니라 유예 비용 대 수정 공수**로 정한다.
- **유예 항목 무손실 대장**: 심각도 · 확률 · 영향 반경 · 유예/rework 비용 · 수정 공수 · 기한/트리거 · 담당 ·
  증거 참조 · 상태를 유지한다. **조용한 폐기 금지.** 현재 열린 항목은 `C-1`/`C-2`/`C-3`(개선)과
  `B-1`(부하 acceptance)/`B-2`(live evidence) — 뒤 둘은 여전히 **차단**이다.
- **테스트 비례**: 변경마다 focused → handoff 전 전체 suite 1회 → 반복·stress·live는 마일스톤/하드닝 게이트
  (해당 계약을 건드린 변경은 예외적으로 즉시). **테스트 완화·삭제 금지는 불변.**
- **fresh context 유지 + 병렬 Claude 세션 조건부 허용**: 구현/리비전 = fresh Claude Code Opus 5,
  넓은 계획·비평·리뷰 = fresh Codex `gpt-5.6-sol` xhigh, 리뷰어는 read-only이며 작성자 transcript와 분리.
  병렬은 **격리 worktree + disjoint 파일 소유권**이 성립하고 DAG·공유 API/schema가 먼저 확정된 경우에만 쓰며,
  공유 schema/API 변경·통합/병합·상태 마이그레이션·최종 전체 테스트·배타 자원/stress/live 테스트는 **직렬**이다.
  동시성은 CPU/부하·메모리·토큰 예산·manifest `maxSessions`로 제한하고, 오케스트레이터가 의존성·소유권·
  artifact hash·상태·완료·결과 라우팅을 검증한다. **로컬 통합 직렬, 원격 쓰기 hard deny 유지.**
  **직전의 공유 dirty 체크아웃 리비전을 단일 세션으로 한 것은 옳았다** — 병렬은 격리 worktree가 있는 미래 작업부터.
- 상세 규칙·대장 템플릿은 로드맵 §9.1~§9.3에 있고, `AGENTS.md`/`CLAUDE.md`에는 요약만 넣었다.

### 3) Git 관찰

`develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 로컬 `develop`과 `origin/develop` 모두 같은 커밋
(remote-tracking reflog에 2026-07-26 13:48:21 +0900 외부 push 갱신 기록). 워킹 트리는 의도적으로 dirty하며
누적된 승인 범위 M3d 작업이 **전부 보존**되어 있다(이 세션은 문서 9개만 수정).

## 이전 갱신 (2026-07-26 — V3 M3d.2 **여덟 번째 리비전**: 여덟 번째 fresh Codex Sol xhigh REQUEST_CHANGES 3건(P2 2 · P3 1) 수정 · **stress acceptance는 여섯 번째 리비전 세션의 FAIL 기록 그대로 미충족(이번 세션 미재실행) · live acceptance 여전히 pending → M3d 미완료 · 승인 미수령**)

> **재검토됨(2026-07-26).** 아래 구현·검증 서술은 그대로 유효하다. 다만 "재검토 대기(pending)"·"APPROVE 0회"는
> **그 시점 기록**이며, 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인(`APPROVE_FEATURE_PROGRESSION`) 1회 ·
> M3d 완료 APPROVE 0회**다(위 "최신 갱신" 참조). **M3d 미완료·M4 not started는 변함없다.**

리뷰 요청 범위: M3d.2 **여덟 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성, 부하 acceptance 미충족, M4 not started).
리뷰 이력은 **REQUEST_CHANGES 8회(리비전 1~8에 각 1회) · APPROVE 0회**였고, 이 리비전은 당시 **재검토 대기(pending)** 였다
(→ 2026-07-26 재검토 결과 `APPROVE_FEATURE_PROGRESSION`, 위 "최신 갱신").
아래는 구현·검증 보고이며, **M3d 완료 승인은 받지 않았다.**

- **변경 파일(여덟 번째 리비전, 코드·테스트 1개 + 문서 7개)**: `src/tools/suiteExclusiveLock.test.ts`(70 → 75건),
  문서 7개(WORKLOG / DECISIONS / CONTEXT_SUMMARY / 이 파일 / 로드맵 / 활성 V3 기준 문서 2건).
  **production 코드는 한 줄도 바꾸지 않았다** — `scripts/lib/suite-exclusive-lock.mjs`,
  `scripts/lib/fixture-config.mjs`(모듈 주석 포함), `scripts/suite-lock.mjs`, `scripts/m3d2-stress-acceptance.mjs`,
  live runner 3종, `src/tools/liveEvidence.*`, `schemas/*`, `package.json` 모두 **미수정**(의존성 변경도 없다).
- **P2-1 (지정자 정규화가 URL 규칙이 아니었다)**: 일곱 번째 리비전의 AST 감사는 상대 지정자를 **문자열 경로로만**
  풀어서 ⓐ `"./lib/fixture-config.mjs?v=1"`(query) · `"…#seam"`(fragment) · `"…?a=1#b"` 조합, ⓑ
  `"./lib/fixture%2Dconfig.mjs"`처럼 **percent 인코딩**된 지정자(Node ESM은 file URL을 디코드해 **같은 파일**로
  해석한다)를 로더로 **인식하지 못했다** → 그 import로 세 번째 인자(io seam)를 넘겨도 감사를 통과했다.
  이제 정규화는 URL 문법 그대로다: **첫 `#` 뒤 전부 fragment → 그 앞 첫 `?` 뒤 query → 남은 path를
  `decodeURIComponent`**. 디코드 불가(`%zz`)·인코딩된 경로 구분자(`%2F`, `fileURLToPath`가 거부한다)는
  "로더가 아니다"로 넘기지 않고 **판정 불가 = fail closed로 보고**한다.
- **P2-2 (계산된 동적 import route를 아예 보지 않았다)**: 예전 감사는 `import()` 인자가 **문자열 리터럴일 때만**
  판정했다. 이제 지정자 식을 bounded하게 **접는다**: 문자열 리터럴 · 치환 없는 template · `+` 연결 ·
  **파일 안에서 정확히 한 번 `const`로 선언되고 초기화식이 있는 이름**(재귀 상한 8). 접히면 그 결과로 판정하고,
  접히지 않으면 **도달 가능한 문자열 조각**을 모아 판정한다.
  **채택한 bounded fail-closed 규칙(문서화된 규칙이며 whole-program 증명을 주장하지 않는다)**:
  조각이 **하나도 없으면**(파라미터·재할당 `let`·중복 선언 등) 로더를 배제할 근거가 없으므로 **fail closed로 보고**,
  조각 중 하나라도 로더 token(`fixture-config`)을 포함하거나 정규화 불가면 **로더 동적 로딩으로 보고**,
  그 밖(조각이 있고 로더 token이 없음)은 `safe`로 본다. `safe` 분기를 남긴 이유는 live runner 3종의 **정상**
  동적 import(`await import(join(HERE, "..", "dist", …))` 빌드 산출물 로딩)를 깨지 않기 위해서이고,
  실제 repo 대조군(`m3c-live-discovery` · `m3c-live-schema-probe` · `m3c2-live-read-semantics`)이 호출부 목록에
  **들어오지 않음**을 같은 테스트가 단정한다. `loader`·`unproven`은 둘 다 **문제로 보고**된다.
  (**정정 — 2026-07-26, 여덟 번째 리비전 재검토 Category C.** 원래 이 자리에 "조용히 통과하는 경로는 없다"고
  적었으나 사실이 아니다. `safe` 분기가 정확히 그 경로다: 도달 가능한 조각이 있고 그 조각 각각에는 로더 token이
  없지만 런타임에 합성되는 구성(예: `"./lib/" + (flag ? "fixture-" : "other-") + "config.mjs"`)은 보고되지 않는다.
  규칙은 위에 적은 **bounded fail-closed 규칙 그대로**이고 whole-program 증명이 아니며, 실제 안전 근거는
  **positive 대조군** — 정상 dist 동적 import 3파일이 호출부로 잡히지 않고 production 호출부는 정확히 5개라는
  단정 — 이다. 이 한계는 유예 대장 `C-1`(로드맵 §9.1)로 등록했다.)
- **P2-3 (import-then-export 재수출을 놓쳤다)**: 예전 감사는 **직접 `export … from`만** 잡고,
  `import { loadFixtureConfig } …` 뒤의 `export { loadFixtureConfig }`는 ExportSpecifier를 참조 대상에서 제외해
  **아무 문제도 보고하지 않았다**(정상 호출 + 재수출이면 issues가 비어 있었다) → 다른 모듈이 그 재수출로 감사
  밖에서 세 번째 인자를 넘길 수 있었다. 이제 수집이 **두 패스**다: import/`export … from`/동적 로딩을 전부 모은
  **뒤에** 노출 패스가 `export { X }` · `export { X as Y }` · `export default X`(namespace 파생 노출 포함)를 본다 →
  **소스 순서(import 먼저/export 먼저)로 우회할 수 없다**. `export * as ns from <loader>`도 직접 재수출로 잡는다.
- **P2-4 (바인딩 판정이 scope를 몰랐다)**: 식별자 텍스트만 봤기 때문에 ⓐ 지역 `process` shadow가
  `canonicalFirstArg` + 첫 인자 **원문** 단정까지 통과했고(그 경우 "외부 주입은 argv 하나뿐" 계약이 깨진다),
  ⓑ shadow된 이름이 **import 사용으로 계산**되어 미사용 검사가 무력했고, ⓒ **namespace import에는 미사용 검사가
  아예 없었다**. 이제 선언 sweep(`var`/`let`/`const`·구조 분해·파라미터·function/class 이름·import 바인딩·
  `catch` 변수)을 돌려 **전역 `process`나 추적 중인 direct/namespace 바인딩을 가리는 선언이 하나라도 있으면
  감사를 실패**시킨다(정확한 scope 계산 대신 conservative fail closed). 그리고 **shadow된 식별자는 import 사용으로
  인정하지 않으며**(→ 미사용 바인딩으로도 보고된다), `process` shadow가 있으면 구조가 맞아도
  `canonicalFirstArg=false`다. namespace도 direct와 **동일한 미사용 검사**를 받고, namespace를 값으로 넘기는
  참조도 우회 표면으로 보고한다.
- **P3 (감사 신뢰성 · 문서 정확성)**: ⓐ 이제 감사는 **파싱 진단**을 본다 — 구문 오류가 있으면 "부분 파싱된
  소스"이므로 "import를 못 찾았다"를 "로더를 부르지 않는다"의 근거로 쓰지 않고 fail closed로 보고한다.
  ⓑ 상태 문서의 리비전·카운트·게이트 표기를 여덟 번째 리비전 사실로 정정했고, **부하(stress) acceptance
  완료 게이트를 "비차단"으로 표기하지 않는다**(아래 항목 참조).
- **기존 계약은 그대로 유지**: `scripts` 아래 **모든 깊이**의 일반 `.mjs` 재귀 열거 + symlink 파일·디렉터리
  미추적·보고(실제 레포 0건), 기대 호출부 **정확히 5개**(`suite-lock.mjs`, `m3d2-stress-acceptance.mjs`,
  `m3a-live-preflight.mjs`, `m3b2-live-handoff.mjs`, `m3c3b-live-handoff.mjs`), 파일당 호출 **1회**,
  **인자 정확히 2개**, 첫 인자가 **구조적으로** `process.argv.slice(2)`(원문까지 동일), 문자열·주석 **오탐 0**,
  그리고 여섯 번째 리비전의 `O_NOFOLLOW`·post-guard 상태 공표·소비자 미완결 보고 — 모두 이번 focused **75/75**
  실행에서 통과했고 관련 production 코드는 수정하지 않았다.
  **TypeScript는 이미 devDependency이며 테스트에서만 import한다 — 의존성·production 주입 표면 추가 0.**
- **테스트(70 → 75건, 삭제·완화 0)**: 신규 5건 =
  ⓐ **query/fragment/percent 지정자**(6형태, 전부 세 번째 인자를 넘긴다) 발견+거부 · 정규화 불가 2형태
  (`%2F` · `%zz`) fail closed 보고 · 로더가 아닌 query 지정자는 **오탐하지 않음**,
  ⓑ **계산된 동적 import** 6형태(연결 · const 바인딩 · const+연결 · 치환 template · 접힌 지정자+query ·
  `require` 연결) 로더 확정 + 확정 불가 3형태(파라미터 · 재할당 `let` · 중복 선언) fail closed +
  **정상 빌드 산출물 동적 import는 호출부로 세지 않음**(대조군),
  ⓒ **재수출** 6형태(import-then-export · export-before-import · 별칭 · default · namespace 파생 · `export * as`),
  ⓓ **shadow** 6형태(`process` const/파라미터 · direct 바인딩 · namespace · 미사용 namespace · namespace 값 전달),
  ⓔ **파싱 진단** 2형태(로더 호출부 · 로더 무관 파일).
  기존 production 호출부 테스트에는 **정상 동적 import 대조군 3파일이 실제로 열거되는지** 단정을 더했다.
  ⓐ~ⓔ는 **순수 합성 소스**(메모리)라 임시 파일을 남기지 않고 production을 잠시라도 훼손하지 않는다.
- **검증 실측(offline)**: `node --check`(.mjs 4종) OK, `npx tsc --noEmit -p tsconfig.json` 0,
  테스트 파일 단독 strict 타입체크 0, `npm run build` **PASS**(파이프로 종료 상태를 가리지 않고 확인),
  `git diff --check` clean. focused `suiteExclusiveLock.test.ts` **75/75**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **374/374**(369 → 374: 신규 5건) +
  acceptance **71/71**. 실행 후 tmp lock/guard/격리·`.new` 잔재 0, repo backup/mutation 잔재 0,
  잔존 suite/fixture 프로세스 0, git 파일 목록 세션 시작과 동일.
  (범위 밖 기존 잔재는 그대로 남는다: `harness-perm-*` 임시 디렉터리 다수 —
  `src/exec/permissionCompiler.test.ts:69` · 이번 세션보다 9시간 앞선 `harness-pf-*` 1건.)
- **비공허성(mutation) 8종** — 새 방어 하나씩 되돌려 해당 테스트가 실패함을 확인하고 **전부 정확히 원복**했다:
  ① query/fragment 분해 제거 → **2건 실패**(지정자 테스트 + 동적 테스트), ② percent 디코드 제거 → 지정자 테스트 실패,
  ③ 동적 지정자 게이트를 문자열 리터럴 전용으로 복원 → 동적 테스트 실패, ④ 노출 패스 제거 → 재수출 테스트 실패,
  ⑤ `process` shadow를 정규형 판정에서 제외 → shadow 테스트 실패, ⑥ direct/namespace shadow 검출 제거 →
  shadow 테스트 실패(shadow된 식별자가 다시 "사용"으로 계산됨), ⑦ namespace 미사용 검사 제거 → shadow 테스트 실패,
  ⑧ 파싱 진단 무시 → 구문 오류 테스트 실패.
  원복 후 프로젝트/단독 strict 타입체크 0 · `npm run build` PASS · focused **75/75** · **24/24** 재확인,
  소스 내 `MUTATION` 흔적 grep **0**. (이 리포는 hash 명령이 차단되어 있어 역방향 exact edit + 전량 재실행으로
  원복을 확인한다.)
- **부하(stress) acceptance는 미충족이며 이것은 M3d 완료를 막는 차단 게이트다(비차단 위험이 아니다)**:
  여섯 번째 리비전 세션이 같은 호스트에서 2회 실행해 2회 다 **exit 1**이었고, 실패 테스트 2건은 그때부터 지금까지
  **아무 리비전도 손대지 않은 고정 5초 child startup deadline**(`preflight.test.ts` M3a canary ·
  `shadcnPilot.test.ts` M3c-0 discovery)이며 호스트 외부 부하(10 CPU · load average 8.76/11.10/8.50)가 원인으로
  확인됐다. 이번 리비전도 **production 코드를 전혀 바꾸지 않았으므로** 같은 조건의 재실행은 새 정보를 주지 않는다 →
  사용자 지시대로 재실행하지 않고 **직전 FAIL을 그대로 미충족으로 기록**한다(거짓 PASS 없음).
  상세 JSON·수치는 아래 "이전 갱신(여섯 번째 리비전)" 항목에 있다.
  (정정: 아래 여섯 번째·일곱 번째 리비전 항목은 이 게이트를 "잔여 위험(비차단)" 목록에 넣어 적었다 —
  **완료 게이트로서는 차단이 맞다**. 해당 줄에 정정 표기를 달았다.)
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 명령은 아래 "이전 갱신"과 동일하다.
  **3종 PASS + evidence 3건 생성 + 부하 acceptance PASS + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로
  판정하지 말 것.** **M4는 not started.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/fetch/push/pull/PR·
  패키지 설치·의존성 변경·네트워크·live runner 실행 없음. 워킹 트리는 계속 dirty이며 **세션 시작 시점의 파일
  목록과 동일**(기존 dirty 변경 전부 보존, 신규 파일 추가 없음).
- **잔여 위험(비차단 — 부하 acceptance 게이트는 여기 포함되지 않는다)**: 아래 여섯 번째 리비전 목록의 lock 계층
  위험이 전부 유효하다. 이번 리비전이 더하거나 명시한 것: ⓐ 감사는 **정적 분석**이므로 런타임 동적 호출은
  "문제 보고"까지만 하고 실행 자체를 막지는 못한다, ⓑ `scripts` 밖(예: `src/`)에서 로더를 부르는 코드는 이 감사
  범위 밖이다(현재 그런 호출부는 없다), ⓒ 동적 지정자 판정은 **bounded 규칙**이라 "관측 가능한 조각은 있으나
  로더 token이 없는" 완전 런타임 구성 경로는 `safe`로 본다(whole-program 증명 아님 — 위 규칙 그대로),
  ⓓ 선언 sweep은 열거한 선언 형태만 보므로 새 형태가 생기면 shadow를 놓칠 수 있다(그 경우에도 호출 형태·노출·
  동적 로딩 검사는 그대로 동작한다), ⓔ `parseDiagnostics`는 TypeScript의 준공개 필드라 상위 버전에서 이름이
  바뀌면 이 검사가 **조용히 무력화**될 수 있다(전용 회귀 2건이 그걸 잡는다),
  ⓕ `scripts/lib/fixture-config.mjs` 모듈 주석이 production 진입점을 **2개만 예시**로 적어 실제 5개와 어긋나 보인다 —
  이번 범위(테스트+문서, production 주석 수정 금지)에서 **수정하지 않았다**(다음 승인 범위에서 주석만 정정 권장).

## 이전 갱신 (2026-07-26 — V3 M3d.2 **일곱 번째 리비전**: 일곱 번째 fresh Codex Sol xhigh REQUEST_CHANGES 1건(P2) 수정 · **stress acceptance는 여섯 번째 리비전 세션의 FAIL 기록 그대로 미충족(이번 세션 미재실행) · live acceptance 여전히 pending → M3d 미완료 · 승인 미수령**)

> **보강됨(여덟 번째 리비전).** 아래 재귀·AST 감사 계약은 그대로 유효하지만, 지정자 정규화(query/fragment/percent) ·
> 계산된 동적 import · import-then-export 재수출 · scope(shadow) · 파싱 진단은 위 여덟 번째 리비전 항목이
> 더 강한 계약으로 보강했다. 아래 "REQUEST_CHANGES 7회"·테스트 카운트(70건)·core 369는 **그 시점 기록**이며,
> 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회 · 75건 · core 374**다.

리뷰 요청 범위: M3d.2 **일곱 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성, 부하 acceptance 미충족, M4 not started).
리뷰 이력은 **REQUEST_CHANGES 7회(리비전 1~7에 각 1회) · APPROVE 0회**이며, 이 리비전도 **재검토 대기(pending)** 다.
아래는 구현·검증 보고일 뿐이고 어떤 승인도 받지 않았다.

- **변경 파일(일곱 번째 리비전, 코드·테스트 1개 + 문서 7개)**: `src/tools/suiteExclusiveLock.test.ts`(67 → 70건),
  문서 7개(WORKLOG / DECISIONS / CONTEXT_SUMMARY / 이 파일 / 로드맵 / 활성 V3 기준 문서 2건).
  **production 코드는 한 줄도 바꾸지 않았다** — `scripts/lib/suite-exclusive-lock.mjs`,
  `scripts/lib/fixture-config.mjs`, `scripts/suite-lock.mjs`, `scripts/m3d2-stress-acceptance.mjs`,
  live runner 3종, `src/tools/liveEvidence.*`, `schemas/*`, `package.json` 모두 **미수정**(의존성 변경도 없다).
- **P2 (production 호출부 발견이 전수가 아니다)**: 여섯 번째 리비전의 회귀는 `scripts` 루트와 `scripts/lib`를
  **한 겹만** 훑고 `loadFixtureConfig(` **문자열 일치**로 호출부를 찾았다. 그래서 ⓐ 더 깊은 하위 디렉터리의
  호출부(레포에 실제로 `scripts/fixtures/m3a/minimal-stdio-mcp.mjs` 깊이가 있다), ⓑ 식별자와 `(` 사이에
  공백·줄바꿈·주석이 낀 호출, ⓒ `import { loadFixtureConfig as loadCfg }` 별칭 호출이 **세 번째 인자
  (in-process io seam)를 넘긴 채 감사를 통과**할 수 있었다 — 문서화된 "새 호출부가 생기면 먼저 깨진다"는
  경계와 모순이다. 이제 감사는 **구문 인식·재귀**다:
  ⓐ `scripts` 아래 **모든 깊이**의 일반 `.mjs`를 재귀 열거하고 **symlink 파일·디렉터리는 신뢰하지 않고
  따라가지 않으며**(건너뛴 목록을 보고하고 실제 레포에서는 0건임을 단정), 로더 모듈 자신은 호출부에서 제외한다.
  ⓑ TypeScript AST로 **`scripts/lib/fixture-config.mjs`에서 온 바인딩**(named 별칭 `as`, namespace import,
  절대경로/`file:` 지정자까지 fail closed 판정)을 추적해 그 바인딩을 통한 호출만 본다 — 공백·주석은 AST가
  흡수하므로 호출을 놓치지 않고, 문자열·주석 안의 이름은 호출이 아니므로 오탐하지 않는다.
  ⓒ 각 호출은 **인자 정확히 2개**이고 첫 인자가 **구조적으로** `process.argv.slice(2)`여야 한다
  (문자열 비교가 아니라 `process`→`argv`→`slice(2)` AST 모양 + optional chaining 금지).
  ⓓ import했지만 **호출하지 않는 바인딩**, **다중 호출**, 동적 로딩(`import()`/`require()`), 재수출,
  비호출 참조(`const alias = loadFixtureConfig`)는 전부 **문제로 보고**한다(조용히 넘기지 않는다).
  ⓔ 기대 호출부 집합은 실제 코드가 그렇듯 **정확히 5개**(`suite-lock.mjs`, `m3d2-stress-acceptance.mjs`,
  `m3a-live-preflight.mjs`, `m3b2-live-handoff.mjs`, `m3c3b-live-handoff.mjs`)로 유지했다.
  **TypeScript는 이미 devDependency이며 테스트에서만 import한다 — 의존성·production 주입 표면 추가 0.**
- **테스트(67 → 70건, 삭제·완화 0)**: 기존 호출부 회귀 1건을 재귀·AST 판으로 **교체·강화**(목록·바인딩 이름·
  호출 수·인자 2개·첫 인자 원문/구조까지 단정, 재귀가 실제로 중첩 fixture 파일에 닿는지도 단정)하고 신규 3건 추가 =
  ⓐ **열거 계약**(임시 디렉터리 트리: 중첩 `.mjs` 발견 · symlink 파일/디렉터리 미추적 및 보고 · 비 `.mjs` 제외 ·
  symlink 디렉터리 너머 파일을 production 소스로 세지 않음),
  ⓑ **우회 mutation 4종**(중첩 경로 · 공백/주석 분리 호출 · 별칭 import · namespace import — 넷 다 세 번째 인자를
  넘긴다)이 모두 **발견되고 거부**되며 같은 실행에서 정상 합성 호출부는 통과,
  ⓒ 첫 인자 비정규형 · 미사용 바인딩 · 다중 호출 · 동적 로딩/재수출/비호출 참조 검출 + **문자열·주석 오탐 금지**.
  ⓑ·ⓒ는 **순수 합성 소스**(메모리)라 임시 파일을 남기지 않고 production을 잠시라도 훼손하지 않는다.
- **여섯 번째 리비전 수정분 재감사(그대로 유지됨)**: `O_NOFOLLOW` symlink 거부 3건, lock unlink 뒤 guard 반납
  실패 시 handle `failed`/`released=false`, 소비자(wrapper·stress)의 "해제 미완결" 보고, focused 테스트 전량,
  mutation 잔재 0 — 모두 이번 세션의 focused **70/70** 실행에서 통과했고 관련 코드는 수정하지 않았다.
- **검증 실측(offline)**: `node --check`(.mjs 4종) OK, `npx tsc --noEmit -p tsconfig.json` 0,
  테스트 파일 단독 strict 타입체크 0, `npm run build` **PASS**(파이프로 종료 상태를 가리지 않고 확인),
  `git diff --check` clean. focused `suiteExclusiveLock.test.ts` **70/70**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **369/369**(366 → 369: 신규 3건) +
  acceptance **71/71**. 실행 후 tmp lock/guard/격리·`.new` 잔재 0, repo backup/mutation 잔재 0,
  잔존 suite/fixture 프로세스 0(기존 범위 밖 이슈인 `harness-perm-*` 임시 디렉터리는 그대로 남는다).
- **비공허성(mutation) 4종**: ① 재귀 제거 → 열거 테스트 + 실제 호출부 테스트 **2건 실패**, ② 옛 문자열 스캔
  게이트 복원 → **공백/주석·별칭 케이스 실패**, ③ 별칭 인식 제거 → **별칭 케이스 실패**, ④ 인자 개수 검사 완화
  (`!== 2` → `< 2`) → **세 번째 인자 거부 단정 전부 실패**. 네 mutation 모두 **정확히 원복**했고, 원복 후
  타입체크 0 · focused **70/70** · **24/24** 재확인, 소스 내 mutation 흔적 grep 0. (이 리포는 hash 명령이
  차단되어 있어 역방향 exact edit + 전량 재실행으로 원복을 확인한다.)
- **stress acceptance는 이 세션에서 실행하지 않았다(미충족·pending, 거짓 PASS 아님)**: 여섯 번째 리비전 세션이
  같은 호스트에서 2회 실행해 2회 다 **exit 1**이었고, 실패 테스트 2건은 **이번 리비전이 손대지 않은 고정 5초
  child startup deadline**(`preflight.test.ts` M3a canary · `shadcnPilot.test.ts` M3c-0 discovery)이며
  호스트 외부 부하(10 CPU · load average 8.76/11.10/8.50)가 원인으로 확인됐다. 이번 리비전은 **production 코드를
  전혀 바꾸지 않았으므로** 같은 조건의 세 번째 실행은 새 정보를 주지 않는다 → 사용자 지시대로 재실행하지 않고
  **직전 FAIL을 그대로 미충족으로 기록**한다. 상세 JSON·수치는 아래 "이전 갱신(여섯 번째 리비전)" 항목에 있다.
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 명령은 아래 "이전 갱신"과 동일하다.
  **3종 PASS + evidence 3건 생성 + 부하 acceptance PASS + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로
  판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/fetch/push/pull/PR·
  패키지 설치·의존성 변경·네트워크·live runner 실행 없음. 워킹 트리는 계속 dirty이며 **세션 시작 시점의 파일
  목록과 동일**(기존 dirty 변경 전부 보존, 신규 파일 추가 없음).
- **잔여 위험(비차단 — 단, 부하 acceptance 게이트는 비차단이 아니다: 여덟 번째 리비전 정정)**: 아래 여섯 번째
  리비전 목록이 전부 유효하다. 이번 리비전이 더한 것: ⓐ 감사는 **정적
  분석**이므로 런타임 동적 호출은 "문제 보고"까지만 하고 실행 자체를 막지는 못한다, ⓑ `scripts` 밖(예: `src/`)
  에서 로더를 부르는 코드는 이 감사 범위 밖이다(현재 그런 호출부는 없다), ⓒ `scripts/lib/fixture-config.mjs`
  모듈 주석이 production 진입점을 **2개만 예시**로 적어 실제 5개와 어긋나 보인다 — 이번 범위(테스트+문서)에서
  production 파일을 건드리지 않으려 **수정하지 않았다**(다음 승인 범위에서 주석만 정정 권장).

## 이전 갱신 (2026-07-26 — V3 M3d.2 **여섯 번째 리비전**: 여섯 번째 fresh Codex Sol xhigh REQUEST_CHANGES 6건 수정 · **stress acceptance는 이 세션 호스트에서 FAIL(외부 부하) · live acceptance 여전히 pending → M3d 미완료 · 승인 미수령**)

> **보강됨(일곱 번째 리비전).** 아래 계약은 그대로 유효하다. 다만 "io seam 회귀가 호출부를 스캔해 전수 검사한다"는
> 항목의 구현은 위 일곱 번째 리비전에서 **구문 인식·재귀 감사**로 교체·강화됐고, "REQUEST_CHANGES 6회"·
> 테스트 카운트(67건)·core 366은 **그 시점 기록**이다. 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인 1회 ·
> M3d 완료 APPROVE 0회 · 75건 · core 374**다(이 줄은 2026-07-26 재검토 결과로 갱신했다).

리뷰 요청 범위: M3d.2 **여섯 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성, M4 not started).
리뷰 이력은 **REQUEST_CHANGES 6회(리비전 1~6에 각 1회) · APPROVE 0회**이며, 이 리비전도 **재검토 대기(pending)** 다.
아래는 구현·검증 보고일 뿐이고 어떤 승인도 받지 않았다.

- **변경 파일(여섯 번째 리비전, 코드·테스트 4개 + 문서 7개)**: `scripts/lib/suite-exclusive-lock.mjs`
  (최종 엔트리 symlink 거부 · 성공 상태 공표 순서), `scripts/suite-lock.mjs`(해제 미완결 명시 보고),
  `scripts/m3d2-stress-acceptance.mjs`(같은 보고), `src/tools/suiteExclusiveLock.test.ts`(62 → 67건),
  문서 7개(WORKLOG / DECISIONS / CONTEXT_SUMMARY / 이 파일 / 로드맵 / 활성 V3 기준 문서 2건).
  `scripts/lib/fixture-config.mjs`·`src/tools/liveEvidence.*`·`schemas/*`·`package.json`·live runner 3종은
  **이번 리비전에서 수정하지 않았다**.
- **P1 (최종 경로 symlink가 lock 신원 검사를 우회)**: `readLockSnapshot`·`readGuardRecord`가
  `openSync(path, "r")`로 열어 **symlink를 따라갔다**. 그래서 원본 lock을 다른 이름으로 옮기고 그 자리에 symlink를
  두면 ⓐ release가 옮겨진 원본의 record·(dev,ino)로 소유를 인정한 뒤 **symlink만 unlink하고 해제 성공을 보고**하고,
  ⓑ quarantine이 그 **남의 symlink 엔트리를 rename으로 덮을** 수 있었다. 이제 두 reader는 공용
  `openReadNoFollow`로 `O_RDONLY|O_NOFOLLOW`만 사용하고, symlink(ELOOP/EMLINK)는 `lock_path_symlink`,
  `O_NOFOLLOW` 미지원 플랫폼은 `lock_nofollow_unsupported`로 **거부**한다(fail closed).
  두 경우 모두 **그 엔트리도 대상 파일도 지우거나 덮지 않는다**: release는 mechanism 실패로 guard를 남기고,
  acquire는 아무 상태도 바꾸지 않은 거부라 guard를 정상 반납한다. 회귀 3건(release / token 격리 / acquire)은
  **각각 symlink 엔트리 보존 + 대상 원본 inode·내용 보존 + 어떤 성공 종결도 보고하지 않음**을 함께 단정한다.
- **P2 (guard 반납 실패 뒤에도 handle이 released로 남음)**: 전이 콜백이 `handle.state = "released"`를
  `withTransitionGuard` 완결 **전에** 세팅했고, catch는 `held`만 `failed`로 바꿨기 때문에 lock unlink 뒤 guard 반납이
  실패해도(`lock_guard_release_failed`) state가 released로 남아 소비자가 `lockReleased:true`로 보고했다.
  이제 콜백은 **결과만 값으로 돌려주고**(`{value:{state}, retainGuard}`) 상태 공표는 `withTransitionGuard`가 정상
  반환한 뒤 `publishState` 한 곳에서만 한다 → guard 정리/교체/unlink 실패가 lock unlink 뒤에 나면
  **problems 보고 · `state="failed"` · `released=false` · guard 잔존**이다. wrapper(`suite-lock.mjs`)와 stress도
  `released`·`quarantined`가 모두 아니면 `lock 해제가 완결되지 않았습니다(state=…)`를 문제로 남겨
  **`lockReleased:true`로 보고하지 않는다**. 결정적 회귀 3건: ⓐ **in-process handle** — pause 지점에서 별도 프로세스가
  guard를 같은 내용·**다른 inode**로 교체(교체를 inode로 증명) → lock 파일은 이미 없고 handle은 `failed`,
  `released=false`, 재호출해도 승격 없음, 남은 guard가 다음 실행 차단; ⓑ **wrapper CLI** — guard unlink만 EACCES,
  `lock_guard_release_failed` + 미완결 보고; ⓒ **stress 요약** — `cleanupConfirmed:true`인데
  `lockReleased:false` · `cleanupProblems>0`. `quarantine()`도 같은 완결 규칙으로 정리했고,
  **acquire·reentry는 이미 guard 반납 뒤에 handle/결과를 만들므로 재감사만** 하고 구현을 넓히지 않았다.
- **추가 지적 (io seam 회귀가 production 호출부 일부만 검사)**: 이제 `scripts/**.mjs`를 **스캔해 호출부를 발견**하고
  ⓐ 목록이 기대 5개(`suite-lock.mjs`, `m3d2-stress-acceptance.mjs`, `m3a-live-preflight.mjs`,
  `m3b2-live-handoff.mjs`, `m3c3b-live-handoff.mjs`)와 정확히 같은지, ⓑ 각 호출의 **최상위 인자가 정확히 2개**이고
  첫 인자가 `process.argv.slice(2)`인지 확인한다(중첩 괄호/중괄호를 세어 인자를 분리한다).
  좁힌 계약이 아니라 **전수 커버리지**이며, 새 호출부가 생기면 목록 비교가 먼저 깨진다. 의존성·외부 주입 표면 추가 없음.
- **P3 (문서 수치 모순)**: 아래 "이전 갱신(다섯 번째 리비전)"의 "3개 + 문서 6개"를 실제 나열
  (lock 라이브러리 · fixture 로더 · wrapper · 테스트 = **4개**, 문서 **7개**)와 맞게 정정했다.
  이번 작업은 **여섯 번째 리비전 · 여섯 번째 REQUEST_CHANGES**이고 **APPROVE 0 · live evidence 3건 pending ·
  M3d 미완료 · M4 not started**는 그대로다.
- **테스트(62 → 67건, 삭제·완화 0)**: 신규 5건 = symlink release 보존 · symlink token 격리 보존 · symlink acquire 거부
  (+ "따라가는 읽기 open 없음" 소스 계약) · lock unlink 뒤 guard 반납 실패 시 handle `failed` · stress 요약
  `lockReleased:false`. 강화 2건 = wrapper guard 제거 실패 테스트에 `lock_guard_release_failed`·미완결 보고 단정 추가,
  io seam 회귀를 호출부 전수 검사로 확대. **pause 지점·fixture key·env seam·임의 명령 seam 추가 0**.
- **검증 실측(offline)**: `node --check`(.mjs 4종)·`npx tsc --noEmit -p tsconfig.json` 0·`npm run build` PASS,
  `git diff --check` clean, **git이 보는 파일 266건 전수 NUL 0**.
  focused `suiteExclusiveLock.test.ts` **67/67**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **366/366** + acceptance **71/71**(3회 동일).
  실행 후 tmp lock/guard/격리·`.new` 잔재 0, repo backup/mutation 잔재 0, 잔존 suite/fixture 프로세스 0.
- **stress acceptance는 이 세션 호스트에서 FAIL이다(정직 보고, 거짓 PASS 아님)**: 일반 suite 3회가 끝난 **뒤**
  1회 실행 → **exit 1**,
  `{"loadWorkers":4,"loadDeadlineMs":2400000,"testTimeoutMs":1800000,"elapsedMs":263998,"workersSpawned":4,`
  `"workersExitedBeforeCleanup":0,"workersAliveAtSuiteClose":4,"npmTestExitCode":1,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false,"shutdownReason":"error"}`.
  원인 파악을 위한 **진단 실행 1회**(전체 로그 캡처)도 동일 결과(elapsed 301973ms). 부하 중 실패한 테스트는
  **2건뿐이고 이번 리비전이 수정하지 않은 파일**이다: `src/tools/preflight.test.ts` "[M3a] extra canary tool 실패"
  (`preflight 타임아웃 (5000ms) — system/init 미수신`)와 `src/tools/shadcnPilot.test.ts`
  "[M3c-0] discovery 성공(generic fixture)"(`discovery 타임아웃 (5000ms)`) → core **364/366**(exec 75/75, acceptance 미도달).
  호스트가 외부 앱으로 이미 포화였다: 10 CPU에 load average **8.76 / 11.10 / 8.50**(Chrome 57% · WindowServer 42% ·
  VS Code · OBS). 부하 worker 4개가 더해지면 **고정 5초 child startup 창**을 넘긴다(이전 리비전의 stress PASS 기록은
  elapsed 109.8s로 훨씬 한가한 호스트였다). 같은 두 파일은 부하 없이 **40/40 PASS**이고 `npm test` 3회도 PASS다.
  lock 계층 계약은 두 실행 모두 정상 동작했다(정리 확인 성공 · 문제 0 · 정상 해제 · 격리 없음 · 잔재 0 ·
  worker 4/4 suite 종료까지 생존). **테스트를 완화하거나 production 5초 deadline을 임의로 바꾸지 않았다** —
  범위 밖이며 별도 근거·승인이 필요하다. 리뷰어 참고: 이 항목은 **부하 acceptance 미충족**으로 읽어야 하며,
  M3d 완료 판정에 그대로 반영해야 한다.
- **비공허성(mutation) 4종**: ① `O_NOFOLLOW` 제거 → symlink 3건 **전부 실패(0/3)**, ② guard 반납 전에 `released`
  공표(옛 동작) → P2 3건 **전부 실패**(handle · wrapper CLI · stress 요약), ③ `suite-lock.mjs` 로더 호출에 세 번째
  인자 추가 → 호출부 회귀가 인자 개수로 실패, ④ 임시 production 호출부 파일 추가 → 호출부 **발견**이 실패.
  네 mutation 모두 **정확히 원복**했고(임시 파일 삭제), 원복 후 `node --check`·`tsc --noEmit` 0·focused **67/67**·
  **24/24** 재확인, 소스 mutation 흔적 grep 0, git 파일 목록 동일. (이 리포는 hash 명령이 차단되어 있어
  역방향 exact edit + 전량 재실행으로 원복을 확인한다.)
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 명령은 아래 "이전 갱신"과 동일하다.
  **3종 PASS + evidence 3건 생성 + 부하 acceptance PASS + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로
  판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/fetch/push/pull/PR·
  패키지 설치·의존성 변경·네트워크·live runner 실행 없음. 워킹 트리는 계속 dirty이며 **세션 시작 시점의 파일
  목록과 동일**(기존 dirty 변경 전부 보존, 신규 파일 추가 없음).
- **잔여 위험**: ① **stress acceptance가 호스트 외부 부하에 민감**하다(고정 5초 deadline 2건) — 조용한
  호스트 재실행 또는 별도 승인 하의 부하 내성 개선이 필요하다.
  **(여덟 번째 리비전 정정: 이 항목은 원래 "비차단" 목록에 있었으나, 부하 acceptance 통과는 M3d 완료의
  차단 게이트다 — 비차단으로 읽으면 안 된다. 아래 ②~⑩만 비차단 위험이다.)**
  ② `O_NOFOLLOW` 미지원 플랫폼은 lock 전이 전체가
  거부되며(fail closed) 그 분기는 전용 테스트가 없다(lock 라이브러리에 주입 seam을 만들지 않기로 한 결정 유지).
  ③ symlink 방어는 **열기 시점** 판정이므로 "마지막 확인 → unlink/rename" 창은 여전히 0이 아니다(Node 18에
  `unlinkat`·compare-and-unlink 없음). ④ 격리 lock·남은 guard·정리하지 못한 `.new`는 **사람이 수동 제거**해야 한다.
  ⑤ lock 라이브러리 `closeSync` 실패 경로 전용 테스트 없음(간접 고정). ⑥ `ps lstart` 1초 해상도.
  ⑦ Linux는 procps 호환 `/bin/ps` 전제. ⑧ 신원 확인은 계약 밖 경로 교체를 **탐지·중단**하지만 원복은 보장하지 않는다.
  ⑨ evidence 경로 TOCTOU 완전 제거 불가 · evidence 지표는 runner 판정의 파생값.
  ⑩ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.

## 이전 갱신 (2026-07-26 — V3 M3d.2 **다섯 번째 리비전**: 다섯 번째 fresh Codex Sol xhigh REQUEST_CHANGES 5건 수정 · **live acceptance 여전히 pending → M3d 미완료 · 승인 미수령**)

> **보강됨(여섯 번째 리비전).** 아래 계약은 유효하지만 lock/guard 읽기의 symlink 처리와 성공 상태 공표 시점은
> 위 여섯 번째 리비전 항목이 더 강한 계약으로 보강했다. 아래 "REQUEST_CHANGES 5회"·테스트 카운트(62건)는
> **그 시점 기록**이며, 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회 ·
> 75건 · core 374**다(이 줄은 2026-07-26 재검토 결과로 갱신했다).

리뷰 요청 범위: M3d.2 **다섯 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성, M4 not started).
리뷰 이력은 **REQUEST_CHANGES 5회(리비전 1~5에 각 1회) · APPROVE 0회**이며, 이 리비전도 **재검토 대기(pending)** 다.
아래는 구현·검증 보고일 뿐이고 어떤 승인도 받지 않았다.

- **변경 파일(다섯 번째 리비전, 코드·테스트 4개 + 문서 7개)**: `scripts/lib/suite-exclusive-lock.mjs`(guard 제거·격리 rename
  직전 재검증 · 신원 확인 후 임시 파일 정리 · guard 반납 실패 전파 · 재진입 base 기준 반환/요구),
  `scripts/lib/fixture-config.mjs`(close 실패 거부 + in-process io seam), `scripts/suite-lock.mjs`(재진입 base 보관 →
  cleanup 격리에 명시 전달 · quarantine 모드도 재진입 후 격리), `src/tools/suiteExclusiveLock.test.ts`(54 → 62건),
  상태 문서 **7개**(WORKLOG / DECISIONS / CONTEXT_SUMMARY / 이 파일 / 로드맵 / 활성 V3 기준 문서 2건).
  (정정: 이 항목은 원래 "3개 + 문서 6개"로 적혀 있었으나 나열된 실제 개수는 **코드·테스트 4개 + 문서 7개**다 —
  여섯 번째 리비전에서 P3로 정정했다.)
  `src/tools/liveEvidence.*`·`schemas/*`·`package.json`·`scripts/m3d2-stress-acceptance.mjs`·live runner 3종은
  **이번 리비전에서 수정하지 않았다**.
- **P1-1 (`releaseTransitionGuard`가 pause 뒤 재검증 없이 unlink)**: 이제 "소유 확인 → 동기화 지점 →
  **같은 fd로 record(nonce)+inode 재확인** → 최종 경로 `lstat` 신원 확인 → unlink" 순서다. 그 사이 다른
  nonce/inode guard로 교체되면 **그 guard를 보존**하고 `{ok:false, problem}`을 돌려주며, 호출자가 mechanism
  실패로 올려 다음 실행을 차단한다. Node 18에는 `unlinkat`·compare-and-unlink가 없어 마지막 확인과 unlink 사이
  창을 **0으로 만들 수 없다** — 창을 syscall 두 개로 줄이고 사후 실패를 숨기지 않는다(모듈 주석에 한계 명시).
- **P1-2 (격리의 마지막 원본 확인이 temp write/close보다 앞이라 rename이 foreign lock을 덮을 수 있음)**:
  temp close 성공 **뒤**, rename **직전**에 `readLockSnapshot`으로 **기본 record + (dev,ino)** 를 다시 확인한다.
  하나라도 다르면 rename하지 않고 외부 lock을 보존하며 guard를 남긴다. 비교 기준이 없으면 아무것도 덮지 않는다.
  격리 임시 파일 정리도 신원 확인 후에만 하고 정리 실패를 problems에 함께 담는다.
- **P1-3 (publish temp unlink·guard record close 오류 삼킴 + `withTransitionGuard`가 guard 반납 실패 무시)**:
  ⓐ guard 반납 실패는 `lock_guard_release_failed`(mechanism)로 올린다 → **acquire/reentry가 전이를 완결하지 못한 채
  성공 handle을 돌려주고 suite를 시작하는 경로가 없다**(원인 문자열을 메시지에 담아 조용히 사라지지 않게 했다).
  상태 미변경 `refusal`만 guard를 반납한다는 계약은 유지하고, 그 반납이 실패하면 원래 거부 코드를 함께 담아 올린다.
  ⓑ 임시 파일 정리는 `dropOwnTemp`로 **열자마자 fd에서 확보한 (dev,ino)와 일치할 때만** unlink한다 — 신원이
  없거나 교체됐으면 **blind unlink하지 않고** 보고한다. 발행 후 정리 실패는 `lock_publish_cleanup_failed`.
  ⓒ 발행 실패 경로에서 삼켰던 `closeSync` 오류, `readGuardRecord`/`readLockSnapshot`의 fd close 실패도
  더 이상 무시하지 않는다(후자는 소유 확인을 불확실로 보고 fail closed).
- **P1-4 (재진입 시점 trusted base를 보존하지 않아 동일 tokenHash 외부 교체 lock을 격리할 수 있음)**:
  `tryReenterSuiteLock`이 검증 성공 시점의 **기본 record + dev/ino**를 `base`로 돌려주고, wrapper가 보관해
  cleanup 격리(`quarantineByToken({ expected })`)까지 **명시 전달**한다. `expected`는 필수이며, 같은 tokenHash지만
  기본 record·inode가 다른 lock은 **보존**하고 guard를 남긴다. 판정 순서는 `verifyOwnership`과 동일하게
  tokenHash → 기본 record → quarantined → inode. 테스트 전용 `quarantine` CLI 모드도 production과 같은 순서
  (재진입으로 기준 확보 → 그 기준으로만 격리)로 바꿨다 — tokenHash만으로는 격리하지 않는다.
- **P2-5 (fixture 로더가 `closeSync` 실패를 무시하고 config 반환)**: 이제 `fixture_close_failed`로 거부한다.
  검증용 주입은 `loadFixtureConfig`의 **세 번째 인자(in-process io seam)** 뿐이다 — fs 함수 4개로 표면이 최소이고,
  허용 key 밖·함수 아닌 값은 `fixture_io_invalid`, **production 진입점(`suite-lock.mjs`,
  `m3d2-stress-acceptance.mjs`)은 인자 2개로만 호출**하므로 argv·env·설정 파일 내용으로는 도달할 수 없다.
  따라서 활성 문서의 "**외부** 주입은 argv 하나뿐" 계약과 모순되지 않으며, 전용 회귀 테스트가 두 호출부의
  호출 문자열을 고정해 미래 확장을 막는다. 임의 명령 주입 표면은 만들지 않았다.
- **추가 감사 재확인**: 발행 성공의 dev/ino non-null 불변식 유지 · guard 이후 모든 I/O 실패의 분류
  (기본값 mechanism) · guard record+inode 단일 fd · release/quarantine 소유 판정 순서 동일 ·
  기본 record 보존 요구 · 로더의 `O_NOFOLLOW` 단일 open/fstat/read · 소비자별 최소 fixture key(양방향 거부) ·
  TERM 무시 중첩 escalation 계약(상위 TERM → 8s 유예 → 확인 → KILL) 모두 유지됨을 테스트로 재확인했다.
- **P2 테스트(54 → 62건, 삭제·완화 0)**: 신규 8건 = guard 제거 직전 재확인 2케이스(다른 nonce / 동일 nonce·다른
  inode) · **acquire** 전이 guard 제거 실패 시 성공 handle 없음(exit 2 + lock·guard 잔존 + 차단) · **reentry** 동일 ·
  발행 후 임시 파일 정리 실패 시 성공 handle 없음(`.new` 잔재는 보고만 하고 남긴다) · 격리 rename 직전 외부 교체
  보존 2케이스 · 동일 tokenHash 외부 교체 lock 보존 · fixture 로더 close 실패 · production 호출부 io seam 미전달.
  기존 1건은 강해진 계약대로 **강화**했다(acquire 경로 guard inode 교체: exit 1 → **exit 2 + 성공 handle 없음**).
  주입은 argv fixture 고정 enum에 pause 지점 4개 추가뿐(`before_publish_tmp_cleanup` /
  `before_quarantine_rename` / `before_guard_unlink_acquire` / `before_guard_unlink_reentry`) — env seam·임의 명령
  seam 없음, fixture 없으면 불가능, production 기본 동작 불변.
- **검증 실측(offline)**: `node --check`(.mjs 4종)·`npx tsc --noEmit -p tsconfig.json` 0·`npm run build` PASS,
  `git diff --check` clean, **git이 보는 파일 266건 전수 NUL 0**.
  focused `suiteExclusiveLock.test.ts` **62/62**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **361/361** + acceptance **71/71**(3회 동일).
  일반 suite 종료 **뒤** stress 1회 **PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false}` (elapsed 109.8s).
  실행 후 lock/guard/격리·`.new` 임시 잔재·repo backup/mutation 잔재·잔존 fixture 프로세스 0.
  (기록 정확성: 위 연속 3회 앞에 수치 캡처가 잘린 예비 full suite 1회가 있었다 — 그 회차도 acceptance 71/71 PASS이며
  기록 대상은 그 뒤의 연속 3회다. 모든 실행은 직렬이고 stress와 겹치지 않았다.)
- **비공허성(mutation) 6종**: guard 재확인 제거 / guard 반납 실패 무시(옛 동작, 4건 실패) / 격리 rename 직전
  재확인 제거 / 재진입 기준 대신 현재 파일 수용(tokenHash만 신뢰) / 발행 후 임시 파일 정리 실패 삼킴 /
  fixture close 실패 삼킴 — 모두 해당 테스트가 실패함을 확인한 뒤 **전부 원복**했다(원복 후 `node --check`와
  focused 62/62 재확인, 소스 내 mutation 흔적 grep 0). 리뷰어 참고: 이 리포는 hash 명령 사용이 차단되어 있어
  파일 해시 대신 **역방향 exact edit + 전량 재실행**으로 원복을 확인했다.
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 명령은 아래 "이전 갱신"과 동일하다.
  **3종 PASS + evidence 3건 생성 + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로 판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/fetch/push/pull/PR·
  패키지 설치·의존성 변경·네트워크·live runner 실행 없음. 워킹 트리는 계속 dirty이며 **세션 시작 시점의 파일
  목록과 동일**(기존 dirty 변경 전부 보존, 신규 파일 추가 없음).
- **잔여 위험(비차단)**: ① 격리 lock·남은 guard·정리하지 못한 `.new` 임시 파일은 **사람이 수동 제거**해야 한다
  (정리 실패까지 fail closed에 포함되어 수동 개입 표면이 조금 넓어졌다). ② Node 18에 `unlinkat`·
  compare-and-unlink가 없어 "마지막 확인 → unlink/rename" 창을 0으로 만들 수 없다(창 최소화 + 사후 탐지).
  ③ **lock 라이브러리의 `closeSync` 실패 경로는 전용 테스트가 없다** — io seam을 lock 라이브러리까지 넓히지
  않기로 결정했고(표면 비용 > 이득), 구현은 fail closed지만 회귀는 "소유 확인 불가 → 제거하지 않음" 분기로만
  간접 고정된다. ④ `ps lstart` 1초 해상도. ⑤ Linux는 procps 호환 `/bin/ps` 전제. ⑥ 신원 확인은 계약 밖 경로
  교체를 **탐지·중단**하지만 원복은 보장하지 않는다. ⑦ evidence 경로 TOCTOU 완전 제거 불가(Node 18 한계).
  ⑧ evidence 지표는 runner 판정의 파생값. ⑨ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가
  `harness-perm-*` 임시 디렉터리를 남긴다.

## 이전 갱신 (2026-07-26 — V3 M3d.2 **네 번째 리비전**: 네 번째 fresh Codex Sol xhigh REQUEST_CHANGES 5건 수정 · **live acceptance 여전히 pending → M3d 미완료 · 승인 미수령**)

> **보강됨(다섯 번째 리비전).** 아래 계약은 유효하지만 guard 제거·격리 rename·정리 실패 처리·재진입 격리 기준은
> 위 다섯 번째 리비전 항목이 더 강한 계약으로 보강했다. 아래 "REQUEST_CHANGES 4회"·테스트 카운트(54건)는
> **그 시점 기록**이며, 현행 사실은 **REQUEST_CHANGES 8회 + 진행 승인 1회 · M3d 완료 APPROVE 0회 ·
> 75건 · core 374**다(이 줄은 2026-07-26 재검토 결과로 갱신했다).

리뷰 요청 범위: M3d.2 **네 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성).
리뷰 이력은 **REQUEST_CHANGES 4회(리비전 1~4에 각 1회) · APPROVE 0회**이며, 이 리비전도 **재검토 대기(pending)** 다.
아래는 구현·검증 보고일 뿐이고 어떤 승인도 받지 않았다.

- **변경 파일(네 번째 리비전)**: `scripts/lib/suite-exclusive-lock.mjs`(발행 신원 불변식 · 실패 분류 · unlink/close
  fail closed · 격리 record 보존 검사 · guard record+inode 단일 fd), `scripts/lib/fixture-config.mjs`(단일 fd
  `O_NOFOLLOW` 로더), `scripts/suite-lock.mjs`(fixture 계약을 자기 해석 key로 축소), `scripts/m3d2-stress-acceptance.mjs`
  (child 전용 최소 fixture 명시 전달 · `nested_ignore_term` 모드), `src/tools/suiteExclusiveLock.test.ts`(43 → 54건),
  상태 문서 6개(WORKLOG / DECISIONS / CONTEXT_SUMMARY / 이 파일 / 로드맵 / 활성 V3 기준 문서 2건).
  `src/tools/liveEvidence.*`·`schemas/*`·`package.json`·live runner 3종은 **이번 리비전에서 수정하지 않았다**.
- **P1-1 (linkSync 뒤 lstat 실패를 published:true·dev/ino null로 반환 → inode 검증 생략)**: 발행은
  ① 임시 파일을 **열린 fd의 `fstat`** 으로 (dev,ino) 확보(경로 재해석 없음) → ② `link` → ③ 최종 경로 `lstat`이
  **같은 (dev,ino)**·일반 파일임을 확인해야 성공이다. lstat 실패는 `lock_publish_unverifiable`, 불일치는
  `lock_publish_identity_mismatch`이고 **둘 다 최종 경로를 지우지 않는다**(우리 파일이라는 증거가 없으면 손대지 않고,
  그 파일이 남아 새 suite 실행을 막는다 = 계약 밖 경로 간섭 탐지·중단). `published:true`의 dev/ino는 **non-null
  불변식**이므로 `verifyOwnership`·격리 rewrite의 inode 검증이 **무조건** 수행된다(옛 `if (ino !== null)` 우회 제거).
  guard 발행이 불확실하면 그 guard를 제거하지 않고 실패하고, lock 발행 실패는 감싼 guard를 남긴다.
- **P1-2 (guard 취득 뒤 lock temp create/write/close/link 실패가 retainGuard=false로 전파)**: 전이 실패를
  `SuiteLockError.failure ∈ {refusal, mechanism}`으로 **명시 분류**하고 **기본값을 `mechanism`(guard 유지)** 으로
  바꿨다. acquire/release/quarantine/reentry를 전수 감사해 guard 취득 뒤의 메커니즘 오류는 전부 guard를 남기고,
  **아무 상태도 바꾸지 않은 계약상 거부만** 자기 nonce+inode 확인 후 반납한다. 함께 고친 것: `writeAllSync`로
  **short write를 오류로** 올림(부분 기록 금지), 격리 `closeSync` 실패를 무시하지 않음(rename 안 함),
  격리 rename **직후** 신원 재확인, **lock unlink ENOENT도 실패**, **guard 제거 실패(ENOENT 포함)도 보고**,
  보유 중 lock이 계약 밖에서 사라진 경우를 "해제됨"으로 처리하지 않음, `quarantineByToken`은 **tokenHash 먼저**,
  격리 record는 기본 필드(v/kind/pid/identity/tokenHash) **보존 요구**(같은 token만으로 외부 교체 불인정),
  guard record와 inode를 **한 fd**에서 함께 읽기.
- **P1-3 (fixture 로더의 lstat → readFileSync 검사–사용 경합)**: 경로를 **정확히 한 번** 열고
  (`O_RDONLY|O_NOFOLLOW`) → 그 fd의 `fstat`으로 일반 파일 확인 → **같은 fd에서 최대 8193B** 읽기 →
  **실제 읽은 바이트로** 상한 판정. 최종 symlink는 열기 전 거부(ELOOP/EMLINK), 교체된 경로는 다시 열지 않고,
  close 오류는 이미 읽은 바이트에 영향이 없어 fd 누수만 막는다. O_NOFOLLOW 미지원 플랫폼은 주입을 거부한다.
- **P2-4 (테스트 공백)**: `suiteExclusiveLock.test.ts` **43 → 54건**. 신규 11건 = post-guard **lock 발행 실패(EACCES)**,
  계약 밖 writer와의 **발행 충돌**(디렉터리는 쓸 수 있는 상태 → guard 유지가 오직 분류 때문임을 고정),
  **lock unlink syscall 실패**, **guard 제거 unlink 실패**, 같은 token 외부 격리 record 거부,
  **TERM 무시 중첩 child·손자의 상위 유예 후 KILL·전 자손 소멸**(`nested_ignore_term`), fixture 로더 4건
  (최종 symlink / 8192 통과·8193 거부 / 비일반 파일 / **경합 중 교체 설정 미해석**), 양방향 fixture key 거부.
  주입은 기존 argv `--fixture-config`의 고정 enum·allowlist뿐이고 pause 지점 1개(`before_guard_unlink_release`)만
  추가했다 — env seam·임의 명령 seam 없음, fixture가 없으면 불가능, production 기본 동작 불변, 기존 테스트 삭제·완화 없음.
- **confused deputy 축소**: stress runner가 자기 fixture를 그대로 물려주지 않고 **child가 해석하는 최소 설정만**
  (`lockPath`/`injectDir`/`childMs`/`confirmMs`/`guardWaitMs`) 새 파일로 전달한다. wrapper 계약에서 stress 전용 key
  (workers/testTimeoutMs/deadlineMs/suiteMode/suiteSleepMs)를 **삭제**하고 `inject`는 `confirm_failure` 하나로 좁혔다.
- **P3-5 (문서 리뷰 횟수 모순)**: 로드맵의 "REQUEST_CHANGES 두 번뿐"과 "세 번째 반영"을 실제 이력
  **4회 REQUEST_CHANGES · APPROVE 0회 · 네 번째 리비전 재검토 대기**로 정정했고, 상태 문서와 활성 V3 기준 문서 2건도
  같은 사실로 맞췄다. 어디에도 승인을 받았다고 쓰지 않았다.
- **검증 실측(offline)**: `node --check`(.mjs 4종)·`npx tsc --noEmit -p tsconfig.json` 0·`npm run build` PASS,
  `git diff --check` clean, **git이 보는 파일 266건 전수 NUL 0**.
  focused `suiteExclusiveLock.test.ts` **54/54**, `liveEvidence.test.ts` **24/24**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** = exec **75/75** + core **353/353** + acceptance **71/71**(3회 동일).
  일반 suite 종료 **뒤** stress 1회 **PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false}` (elapsed 109.5s).
  실행 후 lock/guard/격리 파일·임시 잔재·잔존 fixture 프로세스 0.
- **비공허성(mutation) 9종**: O_NOFOLLOW 제거 / 바이트 상한 제거 / 옛 `lstat`+`readFileSync` 복원 / 실패 분류
  기본값 되돌림 / lock unlink 오류 무시 / guard unlink 오류 무시 / base record 검사 제거 / 발행 신원 확인 제거
  (54건 중 **40건 실패**) / 그룹 대신 child만 kill — 모두 해당 테스트가 실패함을 확인한 뒤 **전부 원복**
  (원복 후 해시 일치 확인). 리뷰어 참고: 읽기 전용 디렉터리 기반 실패 주입은 lock 발행과 guard 제거를 **동시에**
  막으므로 분류를 구분하지 못한다 — 그래서 "발행 충돌" 테스트를 따로 두었다. 또 CLI spawn 기반 경합 테스트는 시도
  횟수가 적어 옛 로더를 잡지 못했고, 로더를 **in-process로 수천 번** 호출하는 형태로 바꾼 뒤 옛 구현이 교체된
  설정을 해석함을 재현했다(그 테스트는 실제 경합 발생(refused > 0)까지 요구한다).
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 명령은 아래 "이전 갱신"과 동일하다.
  **3종 PASS + evidence 3건 생성 + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로 판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/fetch/push/pull/PR·
  패키지 설치·의존성 변경·네트워크·live runner 실행 없음. 워킹 트리는 계속 dirty(기존 dirty 변경 전부 보존).
- **잔여 위험(비차단)**: ① 격리 lock과 남은 guard는 **사람이 수동 제거**해야 풀린다(자동 회수 폐지의 대가).
  ② `ps lstart` 1초 해상도. ③ Linux는 procps 호환 `/bin/ps` 전제. ④ 신원 확인은 계약 밖 경로 교체를 **탐지·중단**하지만
  원복은 보장하지 않는다. ⑤ Node 18에는 `unlinkat`·디렉터리 상대 열기가 없어 "신원 확인 → unlink" 창을 0으로 만들 수
  없다(같은 fd로 창을 줄이고 사후 탐지·fail closed로 막는다). ⑥ evidence 경로 TOCTOU 완전 제거 불가(Node 18 한계).
  ⑦ evidence 지표는 runner 판정의 파생값. ⑧ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가
  `harness-perm-*` 임시 디렉터리를 남긴다.

## 이전 갱신 (2026-07-26 — V3 M3d.2 **세 번째 리비전**: 세 번째 Codex Sol xhigh REQUEST_CHANGES 6건 수정 · **live acceptance 여전히 pending → M3d 미완료 · 승인 미수령**)

> **보강됨(네 번째 리비전).** 아래 guard 계약은 유효하지만, 발행 신원 확인·전이 실패 분류·fixture 로더는
> 위 네 번째 리비전 항목이 더 강한 계약으로 대체·보강했다. 테스트 카운트도 아래 값은 그 시점 기록이다.

리뷰 요청 범위: M3d.2 **세 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성).
이 세션도 어떤 리뷰 승인도 받지 않았다 — 아래는 구현·검증 보고일 뿐이다.

- **변경 파일(세 번째 리비전)**: `scripts/lib/suite-exclusive-lock.mjs`(guard 계약으로 재작성 · 자동 회수 삭제),
  `scripts/lib/fixture-config.mjs`(신규 · argv 전용 주입 로더), `scripts/suite-lock.mjs`(nested 그룹 계약 · fixture spec),
  `scripts/m3d2-stress-acceptance.mjs`(timeout TERM→유예→확인→KILL), `src/tools/liveEvidence.ts`(env seam 제거 →
  `overrideDir`), live runner 3종(argv fixture), `src/tools/suiteExclusiveLock.test.ts`(32 → 43건),
  `src/tools/liveEvidence.test.ts`(23 → 24건), `dist/tools/liveEvidence.js`(재빌드), 상태 문서 6개.
- **P1-1/P1-2 (release·quarantine의 blind unlink/rename TOCTOU, 전이 실패·SIGKILL이 fail closed 아님)**:
  lock format을 **v2**로 올리고 acquire/release/quarantine/reentry를 **crash-persistent `<lock>.guard`** 안에서만
  수행한다. guard 안에서 **tokenHash → 격리 표시 → inode 신원** 순으로 재확인한 뒤에만 파일을 만들거나 지우거나 덮는다.
  다른 guard는 blind unlink하지 않고, 제거는 **자기 nonce + 자기 inode** 확인 후에만 한다. 전이 메커니즘 실패
  (quarantine write 실패 포함)·전이 중 SIGKILL은 **guard를 남겨** 이후 모든 acquire를 거부한다
  (`lock_transition_guard_present`, 수동 제거 안내). 아무것도 바꾸지 않은 계약상 거부만 guard를 정상 반납한다.
- **P1-3 (stale 경로 제거 후 남은 crash hole)**: `.recovery` mutex와 stale rename 회수를 **삭제**했다.
  소유자가 죽은 lock은 `lock_orphaned`로 **항상 거부**하고, **lock 파일이 없어도 guard가 있으면 acquire는
  우회 publish하지 않는다**. 자동 회수가 없으니 "회수 mutex를 쥔 채 크래시" 창도 없다.
- **P1-4 (nested wrapper의 detached 그룹이 상위 pgid 스캔에 안 보임 · 상위 grace가 너무 짧음)**:
  standalone일 때만 detached로 자기 그룹을 만들고, **nested면 그룹을 만들지 않아 전 자손이 상위 stress pgid에 남는다**.
  상위 stress의 timeout도 즉시 SIGKILL이 아니라 **TERM → 8s 유예 → 생존 확인 → KILL**이며, 이는 하위 wrapper의
  shutdown 예산(유예 1.2s + 확인 3s)보다 짧지 않다.
- **P1-5 (경합·강제종료 경로 테스트 부족)**: `suiteExclusiveLock.test.ts` **32 → 43건**. release↔quarantine 양방향,
  **release 전이 중 lock 교체**(다른 소유자 token / 동일 내용·다른 inode) 2케이스, **전이 중 SIGKILL → lock+guard 잔존
  → suite·stress 모두 거부**, quarantine write 실패 → guard 잔존, guard 존재 시 acquire 거부, **guard 소유권**
  (nonce 불일치 / inode 교체) 2케이스, orphan 자동 회수 금지, 중첩 자손 정리 3건.
  **비공허성**: 재확인 제거 / guard blind unlink / nested `detached:true` / timeout 즉시 KILL 네 mutation에서
  해당 테스트가 실패함을 확인한 뒤 원복했다.
- **P2-6 (production의 process.env 테스트 seam · `HARNESS_LIVE_EVIDENCE_DIR` 노출)**: 주입을 **argv
  `--fixture-config <절대경로 .json>` 하나**로 통일했다(`scripts/lib/fixture-config.mjs`: 8KiB 상한, 일반 파일·
  symlink 금지, 절대경로, 소비자 allowlist key, 타입/범위/enum 검증, 임의 명령 실행 seam 없음).
  production은 lock 경로·`ps` fixture·pause/injection·evidence 디렉터리를 env에서 읽지 않으며
  `resolveEvidenceDir`는 명시 인자 `overrideDir`만 받는다. `HARNESS_SUITE_LOCK_TOKEN`은 테스트 seam이 아니라
  실제 부모→자식 ownership handoff라 유지한다. live runner 3종의 정상 사용자 명령은 flag 없이 그대로 동작한다.
  회귀 테스트가 ① 옛 env 이름을 전부 심어도 테스트 모드 거부 + 그 경로에 파일 미생성, ② production 소스에 이름 잔재
  없음, ③ evidence PASS 경로에서 env decoy 디렉터리 미생성 + 콘솔에 경로 미노출을 확인한다.
- **검증 실측(offline)**: `node --check`(.mjs 4종)·`tsc --noEmit` 0·`npm run build` PASS, `git diff --check` clean,
  **git이 보는 파일 266건 전수 NUL 0**. focused `liveEvidence.test.ts` **24/24**, `suiteExclusiveLock.test.ts` **43/43**.
  `npm test` **연속 3회 전부 PASS(직렬, 겹침 없음)** — 2·3회차 = exec **75/75** + core **342/342** + acceptance **71/71**;
  1회차는 캡처 tail에 acceptance **71/71 / ALL PASS**만 남았다(`test:inner`는 `&&` 체인이라 exec·core 통과가 전제).
  일반 suite 종료 **뒤** stress 1회 **PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"npmGroupAliveAfterCleanup":false,"ownedDescendantsAfterCleanup":0,`
  `"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true,"lockQuarantined":false}` (elapsed 89.6s).
  실행 후 lock/guard/격리 파일·임시 잔재·잔존 fixture 프로세스 0.
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 명령은 아래 "이전 갱신"과 동일하다.
  **3종 PASS + evidence 3건 생성 + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로 판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. commit/fetch/push/PR/패키지 설치·
  의존성 변경·네트워크 없음. 워킹 트리는 계속 dirty(기존 dirty 변경 전부 보존).
- **잔여 위험(비차단)**: ① 격리 lock과 남은 guard는 **사람이 수동 제거**해야 풀린다(자동 회수 폐지의 대가).
  ② `ps lstart` 1초 해상도. ③ Linux는 procps 호환 `/bin/ps` 전제(미지원 시 fail closed).
  ④ inode/tokenHash 확인은 계약 밖 경로 교체를 탐지·중단하지만 원복은 보장하지 않는다.
  ⑤ evidence 경로 TOCTOU 완전 제거 불가(Node 18 한계). ⑥ evidence 지표는 runner 판정의 파생값.
  ⑦ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.

## 이전 갱신 (2026-07-26 — V3 M3d.2 **두 번째 리비전**: 두 번째 Codex Sol xhigh REQUEST_CHANGES 4건 수정 · **live acceptance 여전히 pending → M3d 미완료 · 최종 재검토 미수령**)

> **대체됨(세 번째 리비전).** 아래 P1-3의 `.recovery` mutex·stale rename 회수는 **삭제**되었고,
> detached 관련 서술도 "nested는 detached하지 않는다"로 정정되었다. 아래는 역사 기록이다.

리뷰 요청 범위: M3d.2 **두 번째** 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성).
이 세션은 어떤 리뷰 승인도 받지 않았다 — 아래는 구현·검증 보고일 뿐이다.

- **변경 파일(두 번째 리비전)**: `scripts/lib/suite-exclusive-lock.mjs`(재작성), `scripts/suite-lock.mjs`(재작성),
  `scripts/m3d2-stress-acceptance.mjs`(종료·격리 경로 수정), `src/tools/suiteExclusiveLock.test.ts`(17 → 32건),
  그리고 상태 문서 5개(WORKLOG / DECISIONS / CONTEXT_SUMMARY / 이 파일 / 로드맵).
  live runner 3종·`liveEvidence.*`·`schemas/*`·`package.json`은 **이번 리비전에서 수정하지 않았다**.
- **P1-1 (정리 확인 실패인데 lock을 무조건 해제)**: `scripts/m3d2-stress-acceptance.mjs`가 `cleanupConfirmed:false`를
  계산해 놓고도 `lock.release()`를 무조건 호출했다. 이제 **확인 성공 시에만 해제**하고, 실패하면 해제 대신
  lock을 **격리(quarantine)** 한다 — `quarantined:true`를 원자적으로 표시하며, 격리된 lock은 **소유자가 죽어도
  stale 회수 대상이 아니다**(`lock_quarantined`로 항상 거부). 격리는 파일 write 1회라 **매달리지 않고 즉시 종료**한다
  (terminal exit 호환). `process.on("exit")`와 반복 시그널 탈출 경로에도 같은 격리를 적용했고, 요약에
  `lockQuarantined`를 추가했다. 회귀 테스트가 주입된 확인 실패에서 ①격리 표시 ②다른 suite·stress 모두 `lock_quarantined`
  거부 ③소유 worker는 정리됨 ④**무관한 제3 프로세스는 생존**을 확인한다.
- **P1-2 (wrapper 시그널 경로가 child close·그룹 확인 없이 해제)**: `scripts/suite-lock.mjs`를 **비동기 idempotent
  bounded shutdown 상태 기계 하나**로 재작성했다. normal close / spawn error / SIGINT / SIGTERM / 반복 시그널 /
  escalation 전부 같은 기계를 지난다: 소유 child 그룹만 TERM → 유예(5s) → KILL → **그룹과 소유 pgid 자손 소멸을
  bounded 확인**(기본 20s) → **확인 뒤에만** 해제. 확인 실패·불가는 해제 대신 격리(fail closed),
  **시그널 exit 의미 130/143은 확인 결과와 무관하게 유지**한다. child는 detached라 상위 stress runner의 pgid 스캔에
  잡히지 않는 중첩 그룹을 만드므로 이 wrapper가 자기 그룹을 직접 확인한다. 인자·설정 검증은 lock 획득 **전에** 끝낸다.
- **P1-3 (stale 회수 check-then-blind-rename 경합)**: "A가 stale로 읽음 → B가 회수 후 live lock 생성 → A가 그 live
  lock을 rename"으로 겹침이 가능했다. 세 겹으로 막았다. ① **직렬화**: `<lock>.recovery`를 exclusive 발행한
  프로세스만 회수 구간 진입. 보유자 생존 → bounded 대기 후 `lock_recovery_in_progress`, 보유자 사망/확인 불가 →
  **자동 인수 없이** `lock_recovery_stalled`(안전 > 편의, 수동 제거 안내). ② **회수 구간 안 재읽기·재분류** — 대기 중
  생긴 live lock을 `lock_held`로 잡는다. ③ **inode CAS** — fd `fstat`으로 (dev,ino) 확보, rename 직전 `lstat` 확인,
  rename은 원자적이므로 **직후** 옮겨진 파일의 inode 재확인이 "그 inode를 옮긴 유일한 프로세스"라는 증명이다.
  어긋나면 되돌린 뒤 `lock_reclaim_identity_mismatch`로 실패하고 **절대 lock을 만들지 않는다**.
  추가로 lock 파일은 비공개 임시 파일 → `link()` 발행이라 **부분 write가 최종 경로에 잔재를 남기지 않는다**.
- **P2-4 (문서 NUL 주장 거짓)**: "src/scripts/schemas/dist NUL 0"은 사실이 아니었다 — gitignore된 기존
  `src/.DS_Store`에 NUL 6,681바이트가 있다. WORKLOG·이 파일·로드맵·CONTEXT_SUMMARY의 **현행 M3d.2 검증 문장만**
  "변경·추적 대상 텍스트 파일"로 정정했다(무관한 과거 항목은 건드리지 않았다).
- **테스트**: `src/tools/suiteExclusiveLock.test.ts` **17 → 32건**(신규 15건, 모두 결정론적·bounded).
  주입 seam은 좁은 enum·절대경로만 받고 임의 명령 실행 경로를 만들지 않으며, 실제 잔존 프로세스를 만들지 않는다.
  **비공허성**: 재분류를 끄면 2-contender 테스트가 실패하고(A가 B의 live lock 탈취 재현), inode 사후 확인을 끄면
  교체 거부 테스트가 실패함을 mutation으로 확인한 뒤 원복했다.
- **검증 실측(offline)**: `npm run build` PASS, `git diff --check` clean,
  **git이 보는 파일 265건 전수 스캔 NUL 0**(ignore된 `src/.DS_Store`는 범위 밖이며 NUL 포함).
  focused `suiteExclusiveLock.test.ts` **32/32**. `npm test` **연속 3회 전부 PASS(직렬, 병렬 실행 없음)** =
  exec **75/75** + core **330/330** + acceptance **71/71**. 일반 suite가 전부 끝난 **뒤** stress 1회 **PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"ownedDescendantsAfterCleanup":0,"cleanupConfirmed":true,"cleanupProblems":0,`
  `"lockReleased":true,"lockQuarantined":false}` (elapsed 100.9s). 실행 후 공용 lock 파일·m3d2 임시 잔재 0.
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 아래 "이전 갱신"의 3개 명령 그대로다.
  **3종 PASS + evidence 3건 생성 + fresh Codex 최종 재검토 전에는 M3d 완료·M4 ready로 판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 이 리비전도 commit/fetch/push/PR/
  패키지 설치·의존성 변경·네트워크를 하지 않았다. 워킹 트리는 계속 dirty(기존 dirty 변경 전부 보존).
- **잔여 위험(비차단)**: ① 회수 mutex를 쥔 채 크래시하면(마이크로초 창) 자동 stale 회수가 영구 거부되고 사람이
  `<lock>`·`<lock>.recovery`를 수동 제거해야 한다 — 의도적 선택(겹침 방지 > 자동 복구). ② 격리 lock도 수동 제거해야
  풀린다(같은 이유). ③ `ps lstart` 1초 해상도. ④ Linux는 procps 호환 `/bin/ps` 전제(미지원 시 fail closed).
  ⑤ inode CAS는 계약 밖 외부 행위자의 경로 교체를 **탐지·중단**하지만, 이미 옮긴 파일의 원복까지 보장하지는
  않는다(경고로 보고). ⑥ evidence 경로 TOCTOU 완전 제거 불가(앞선 리비전 P2-5 그대로). ⑦ evidence 지표는 runner
  판정의 파생값. ⑧ 기존 이슈(범위 밖): `src/exec/permissionCompiler.test.ts:69`가 `harness-perm-*` 임시 디렉터리를 남긴다.

## 이전 갱신 (2026-07-26 — V3 M3d.2 **리비전**: Codex Sol xhigh REQUEST_CHANGES 6건 수정 · **live acceptance 여전히 pending → M3d 미완료**)

리뷰 요청 범위: M3d.2 리비전 diff. **M3d 전체 완료·M4 ready 판정은 아직 하지 말 것**(live evidence 3건 미생성).

- **추가/변경 파일(리비전)**: `scripts/lib/suite-exclusive-lock.mjs`(신규), `scripts/suite-lock.mjs`(신규),
  `scripts/m3d2-stress-acceptance.mjs`(재작성), `src/tools/liveEvidence.ts`, `src/tools/liveEvidence.test.ts`,
  `src/tools/suiteExclusiveLock.test.ts`(신규), `schemas/live_evidence.schema.json`, `package.json`(script 2줄),
  `dist/tools/liveEvidence.js`(재빌드). live runner 3종은 이 리비전에서 **수정하지 않았다**(검사 → cleanup →
  evidence → PASS 순서, opt-in 가드, `npm test` 미연결 그대로).
- **P1-1 (부하 없는 stress PASS 가능)**: 설정된 worker **전부**의 spawn을 `spawn` 이벤트로 확인하고,
  `npm test`가 닫힐 때까지 전원 생존을 요구한다. spawn 실패·정리 전 종료·정리 전 error는 FAIL.
  부하 firm deadline > `npm test` wall-clock 상한을 **강제**(위반 시 exit 2)해 부하가 suite 전 구간을 덮게 했다.
  worker는 부모 소멸(ppid 변경) 시 스스로 종료해 고아로 남지 않는다.
- **P1-2 (시그널·자손 정리 미검증)**: 비동기 idempotent **shutdown 상태 기계** 하나로 통일.
  소유 npm 프로세스 그룹(TERM→유예→KILL) + 자기 부하 worker만 종료 → worker/그룹/소유 pgid 자손 소멸을
  bounded 확인 → **확인 뒤에** lock 해제 → exit. normal/timeout/error/SIGINT(130)/SIGTERM(143) 전 경로 공용.
  timeout은 group kill 실패와 무관하게 실제 wall-clock 상한으로 확정된다. 확인 실패·`ps` 확인 불가는 FAIL이며
  보고는 bounded 코드·건수뿐(pid·경로·argv 없음).
- **P1-3 (일반 suite와 stress가 lock을 공유하지 않음)**: 공용 배타 lock 도입.
  `npm test` = `node scripts/suite-lock.mjs run test:inner`이고 `test:inner`는 기존과 동일하게
  **exec → core → acceptance** 순서를 그대로 돌린다(카운트·exit 의미 불변). stress도 같은 lock을 잡는다.
  stress가 띄운 자기 소유 `npm test` child만 **추측 불가 32B ownership token**으로 재진입한다(디스크에는 sha256만).
  소유자 판정은 `pid + ps lstart`이며 PID 단독 신뢰 없음. stale lock은 `rename` 원자적 회수로만 처리해 경합을 없앴고,
  손상/버전 불일치/`ps` 확인 불가 lock은 **회수하지 않고 거부**(fail closed). `ps` 스캔은 backstop으로 남기고
  `npm test`/`npm run test:*`/`tsx|node --test`/`acceptance.sh`/stress/lock wrapper를 잡도록 좁게 강화했다.
  lock 보유 중 중첩 stress 실행도 거부한다.
- **P1-4 (최종 파일명이 완성 전에 노출)**: evidence는 같은 디렉터리의 **숨김 임시 파일**에 전부 쓰고
  chmod·fsync·close·재검증(byte 동일 + 계약 재파싱)까지 끝낸 뒤 **exclusive hard link**로 원자적 publish한다.
  덮어쓰기 없음(EEXIST → 거부). 쓰기 중 SIGKILL 크래시 재현 테스트로 **최종 성공 산출물 이름의 잘린 파일이
  생기지 않음**을 확인했다. 실패·정리 실패 시 발행분까지 신원 확인 후 되돌린다. publish 후 디렉터리 fsync(지원 시).
- **P2-5 (evidence 디렉터리 symlink TOCTOU)**: 디렉터리·파일 **dev+ino 신원**을 보관해 publish 직전 재확인하고,
  정리 unlink도 신원 확인 후에만 수행한다(교체된 파일은 지우지 않고 실패로 보고). 잡아낸 정리 실패는 조용히
  무시하지 않는다. 문서 주장도 좁혔다 — Node 18에는 디렉터리 핸들 상대 열기가 없어 경로 기반 TOCTOU를 완전히
  없앨 수 없고, 위 조치는 창 축소·사후 탐지 **완화**이며 완전 방어가 아니다.
- **P2-6 (schema/런타임 timestamp 판정 불일치)**: 양쪽을 같은 의미로 맞췄다. `Z` 고정 UTC, 밀리초 3자리 선택,
  시 00-23·분·초 범위, 달력 실재성(2월 30·31, 4·6·9·11월 31, 비윤년 2월 29 거부), 연도 2000..2099
  (이 범위에서 윤년 = 4의 배수 → 정규식만으로 동일 결정 가능). 테스트가 accept 6건/reject 28건 표로
  schema 판정 == 런타임 판정을 강제하고, schema에 미지원 keyword가 추가되면 실패한다.
- **검증 실측(offline)**: `npm run build` PASS, `git diff --check` clean,
  **변경·추적 대상 텍스트 파일(tracked + ignore 제외 untracked)** NUL 0.
  (정정: 원래 "src/scripts/schemas/dist NUL 0"이라고 적었으나 사실이 아니다 — gitignore된 기존
  `src/.DS_Store`에 NUL이 있다. 실제 검증 범위는 git이 보는 텍스트 파일이다.)
  focused `liveEvidence.test.ts` **23/23**, `suiteExclusiveLock.test.ts` **17/17**.
  `npm test` **연속 3회 전부 PASS(직렬)** = exec **75/75** + core **315/315** + acceptance **71/71**
  (elapsed 115.9s / 124.1s / 114.2s). 그 뒤 stress 1회 **PASS** —
  `{"loadWorkers":4,"workersSpawned":4,"workersAliveAtSuiteClose":4,"npmTestExitCode":0,"npmTestTimedOut":false,`
  `"workersAliveAfterCleanup":0,"ownedDescendantsAfterCleanup":0,"cleanupConfirmed":true,"cleanupProblems":0,"lockReleased":true}`
  (elapsed 191.2s). 실행 후 공용 lock 파일·m3d2 임시 디렉터리 잔재 0.
- **live acceptance는 이 세션에서도 실행하지 않았다(pending)** — 아래 "이전 갱신"의 3개 명령 그대로다.
  **3종 PASS + evidence 3건 생성 전에는 M3d 완료·M4 ready로 판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 이 리비전도 commit/fetch/push/PR/
  패키지 설치·의존성 변경을 하지 않았다. 워킹 트리는 계속 dirty(기존 dirty 변경 전부 보존).
- **잔여 위험(비차단)**: `ps lstart` 1초 해상도(같은 초에 pid가 재사용되면 신원이 겹칠 수 있음), Linux는 procps
  호환 `/bin/ps` 전제(미지원 시 fail closed로 거부), evidence 경로 TOCTOU 완전 제거 불가(위 P2-5),
  evidence 지표는 runner 판정의 파생값이라 runner 판정이 틀리면 그대로 반영된다.
  관찰(기존 이슈, 이 리비전 범위 밖): `src/exec/permissionCompiler.test.ts:69`가 실행마다 `harness-perm-*`
  임시 디렉터리를 정리하지 않고 남긴다.

## 이전 갱신 (2026-07-26 — V3 M3d.2 구현 완료 · **live acceptance pending → M3d 미완료**)

리뷰 요청 범위: M3d.2 = redacted persistent live-evidence + 반복/부하 acceptance. **M3d 전체 완료 판정은 아직 하지 말 것.**

- **영향 파일**: `schemas/live_evidence.schema.json`(신규), `src/tools/liveEvidence.ts`(신규),
  `src/tools/liveEvidence.test.ts`(신규), `scripts/m3a-live-preflight.mjs`, `scripts/m3b2-live-handoff.mjs`,
  `scripts/m3c3b-live-handoff.mjs`, `scripts/m3d2-stress-acceptance.mjs`(신규), `package.json`(script 1줄 추가),
  그리고 완료/상태 문서 5개. 빌드 산출물 `dist/tools/liveEvidence.js`가 새로 생겼다(이 레포는 dist를 커밋한다).
- **evidence 계약(닫힌 allowlist)**: 허용 top-level은 `version`/`contract`/`status`/`timestamp`/`metrics` 정확히 5개.
  `status`는 `"pass"` 고정(성공 전용). `metrics`는 runner별 discriminated 계약의 exact key 집합이며 값은
  0..1,000,000 정수 또는 boolean만. 모든 객체 레벨에서 unknown key 거부. 직렬화 상한 4096B.
- **금지 필드**: raw transcript, tool/MCP 입출력, argv, 명령, 파일 경로, hostname/user, PID,
  session/call/request ID, env·secret 참조/값, config 본문, free-form error/message → key 이름 조각 스캔으로 **선행 거부**.
  redaction 마커로 치환해도 통과하지 않는다.
- **backstop**: 영속화 직전 기존 `redactSecrets`/`collectSecretValues`로 직렬화 텍스트 재검사.
  secret 값·credential 형태·예상 외 문자(`/ \ $ =`) 감지 시 **가리지 않고 쓰기 거부**(fail-closed).
- **저장**: `docs/evidence/m3d2`(첫 성공 live 실행 시 생성), 성공 1건당 파일 1개
  `<contract>-<UTC compact ts>-<12B nonce>.json`, dir 0700 / file 0600, exclusive create(`wx`),
  symlink·비디렉터리 거부(대상 + bounded 4단계 상위), 실패 시 부분 산출물 제거, 경로는 payload·콘솔 미노출.
- **runner 통합 규칙**: 3종 runner 모두 opt-in 가드·TTY 요건·fail-closed·cleanup·기존 PASS 의미를 유지한다.
  evidence는 **모든 계약 검사 + cleanup 성공 뒤에만** 기록하고, 기록 실패는 runner 실패(exit 1)다.
  non-spawned/실패/미실행 경로는 evidence를 남기지 않는다. live runner는 `npm test`에 연결되지 않았다.
- **stress**: `npm run acceptance:stress:m3d2`(수동 전용). bounded CPU worker(기본 4, firm deadline 900s) 아래
  `npm test` 1회 직렬 실행. 배타 lock + `ps` 스캔(실행 파일이 node/npm/sh 계열인 후보만)으로 다른 suite/stress와
  겹치면 거부하고, `ps` 실패도 거부. 자신이 만든 child만 성공/실패/시그널에서 정리하며 종료는 bounded polling으로 확인.
- **검증 실행 결과(offline)**: `npm run build` PASS, `git diff --check` clean, NUL 0.
  `liveEvidence.test.ts` 단독 **16/16 PASS**. `npm test` **연속 3회 전부 PASS** = exec 75/75 + core **291/291** +
  acceptance 71/71(직렬). stress **PASS**(동일 카운트, elapsed 85.6s, `cleanupProblems:0`, 잔존 worker 0).
  참고: 첫 stress 시도는 SIGKILL 직후 생존을 즉시 판정해 거짓 실패했고, bounded polling으로 고친 뒤 PASS했다.
- **live acceptance는 실행하지 않았다(pending)**: M3b.2가 사람 대화형 TTY를 요구하므로 이 세션에서 돌리지 않았다.
  사용자 실행 명령: `npm run build && HARNESS_LIVE_M3A=1 node scripts/m3a-live-preflight.mjs` /
  `... HARNESS_LIVE_M3B2=1 node scripts/m3b2-live-handoff.mjs` / `... HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs`.
  **3종 모두 PASS + evidence 3건 생성 전에는 M3d 완료·M4 ready라고 판정하지 말 것.**
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74` 불변. 이번 M3d.2 작업도
  commit/fetch/push/PR/패키지 설치를 하지 않았다. 워킹 트리는 계속 dirty(기존 dirty 변경 전부 보존) — clean 아님.
- **잔여 위험(비차단)**: 상위 symlink 검사 bounded(4단계, 시스템 prefix 제외), stress `ps` 스캔은 command line
  heuristic(배타 lock이 1차 방어), evidence 지표는 runner 판정의 파생값이라 runner 판정이 틀리면 그대로 반영된다.

## 이전 갱신 (2026-07-26 — V3 M3d.1 완료, Codex Sol xhigh APPROVE)

- **M3d.1 완료. fresh Codex Sol xhigh 최종 검토 verdict = APPROVE. M3d 전체는 완료가 아니다.**
- 원인: M3c-2 live runner가 baseline 이후 `shadcn@4.13.1 mcp`에 매칭되는 프로세스를 전부 자기 잔여물로
  간주해, 무관한 동시 실행 프로세스가 거짓 실패를 만들 수 있었다.
- 수정 범위는 `scripts/m3c2-live-read-semantics.mjs`와 `src/tools/shadcnReadSemanticsProbe.test.ts` 두 파일뿐이다.
- 소유권 = **runner 프로세스 트리 자손 OR cwd가 runner 임시 base 하위**. 그 base 밖의 진짜 독립적인
  post-baseline sibling은 foreign이며 무시한다. unknown inspection은 fail-closed를 유지하고 kill하지 않는다.
- 프로세스 baseline·재검증은 **PID 단독이 아니라 `pid + ps lstart`**. 후보 argv는 로그에 남기지 않고,
  진단은 pid·ownership·**run별 salted SHA-256 signature**만 쓴다.
- 테스트 sleeper는 bounded TTL을 갖고, 정리는 child handle 또는 nonce로 확인된 orphan 신원에 대해
  bounded 종료 확인으로만 한다. blind PID signal 없음.
- 최종 리비전 후 검증: `git diff --check` clean, NUL 바이트 0, `npm run build` PASS,
  해당 파일 단독 **18/18 PASS 2회**, `npm run test:core` **275/275 PASS**,
  격리 `npm test` PASS = exec **75/75** + core **275/275** + acceptance **71/71**.
- 앞선 겹친 검증 1회 실패는 fresh 리뷰어와 메인 스위트가 전역 m3c2 temp/process 상태를 동시에 관찰했기 때문이고,
  격리 재실행은 PASS였다. 오케스트레이션 계약으로 채택: **프로세스 전역·tmp 전역 상태를 관찰하는 테스트는
  명시적 exclusive resource class/lock을 요구하며 동시 실행하지 않는다**(M4 durable-state/scheduler 요건,
  M5 bridge 실행 요건으로 로드맵에 기록).
- M5 추가 요건(Claude bootstrap 실측): 진행/이벤트 스트리밍, no-progress·wall-clock bounded deadline,
  cancellation, descendant cleanup. 최종 결과만 내는 silent session은 수용하지 않는다.
- **Git 관찰**: `develop` / HEAD `af0552e5ba98100b7ae5970b0cb44224e3469c74`, 로컬 `origin/develop`도 동일 커밋
  (remote-tracking reflog는 2026-07-26 13:48:21 +0900 push로 갱신됨). 이번 M3d.1 작업은 commit/fetch/push를
  하지 않았다. **워킹 트리는 의도적으로 dirty하다** — 선행 docs-only 로드맵 편집 + M3d.1 구현 2파일이 있고
  자율 오케스트레이션 로드맵 문서는 아직 untracked다. clean이라고 부르지 않는다.
- Claude Code 관찰 버전 `2.1.220`.
- 잔여 위험(비차단): `lstart` 1초 해상도, 대상 Linux는 procps 호환 `/bin/ps` 전제이며 미지원 inspection은
  fail-closed된다.
- **다음**: 남은 M3d 범위 — redacted persistent live-evidence schema/테스트 + 로드맵의 반복 full-suite/stress
  acceptance. **별도 상세 계획과 승인이 필요하며, M4 ready 상태가 아니다.**
- 아래 "clean"·flake 272/273 서술은 이 갱신 이전 시점의 기록이다.

## 이전 갱신 (2026-07-26 — 자율 오케스트레이션 로드맵 활성화)

- 새 최우선 구현 기준: `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`.
- 후속 순서: **M3d baseline 안정화 → M4 agent 통신/state → M5 Codex↔Claude bridge/autopilot
  → M6 계층 오케스트레이터 → M7 기획/Research → M8 디자인 → M9 개발 → M10 hardening**.
- 중앙 LLM 세션은 SoR이 아니다. TypeScript kernel+디스크 state가 제어하고 Coordinator/Worker/Reviewer는
  fresh session으로 교체한다. 메시지는 schema+Markdown body+artifact hash로 전달한다.
- 모델 기본: 개발/수정=Claude Code Opus, 큰 계획·문서 비평·독립 review=Codex `gpt-5.6-sol` xhigh.
- M5 완료 뒤부터 사람의 프롬프트/완료보고 복사를 `autopilot`이 대체한다. M4/M5는 기존 수동 handoff로 bootstrap.
- Git: `develop`/`af0552e`, `origin/develop` 동일, clean. Claude Code `2.1.220`, Codex CLI
  `0.146.0-alpha.3`(2026-07-26 확인).
- 사용자 실행 M3 live runner들은 PASS 보고. 임시 산출물 cleanup 때문에 저장소 사후 검증은 불가하며
  M3d에서 redacted live evidence 영속화를 설계한다.
- Codex 재검증: exec 75 PASS, acceptance 71 PASS. core 전체 부하에서 알려진 M3c-2 runner smoke
  1건 재현(272/273), 해당 파일 단독 16/16 PASS. 테스트 완화 없이 M3d에서 안정화한다.
- 이 갱신보다 아래에 있는 “M3 미구현/미확인/다음 M3” 표현은 당시 역사 기록이다.

---

## 1. 프로젝트 개요

- **현재 버전**: `package.json` `2.6.0`. CLI `--version`은 package.json을 런타임에서 읽어 동일 값 출력(M0).
  (exec/mission·V3 M1/M2는 v2.6.0 태그 이후 develop에 누적된 미태그 작업.)
- **현재 브랜치 / 작업 트리**: `develop` / **DIRTY**. 이 "CLEAN" 표기는 V3 M1/M2 시점의 기록이었다 —
  M3d.1 이후 문서·구현 변경과 M3d.2 신규 파일이 누적되어 워킹 트리는 계속 dirty이며 commit하지 않았다
  (현행 상태는 위 "최신 갱신"의 Git 관찰 항목을 본다).
- **Provider 구조** (`src/providers/`): 3종 — `mock`(무과금 기본), `claude-code`(`claude -p` 구독 위임),
  `anthropic`(API). 인터페이스 `Provider = { id; generate(input): Promise<AgentResult> }`.
- **workflow / step 종류** (`registry/workflows.json`, 4개):
  - `idea-validation`: chief_of_staff → research → pm → red_team → founder_ceo (순수 순차)
  - `mvp-planning`: pm → ux_ui → design → {approval} → tech_lead → {critique_loop tech_lead⟲red_team} → founder_ceo
  - `dev-preflight`: tech_lead → {fanout} → red_team → chief_of_staff → {approval}
  - `full-predev`: chief_of_staff → research → pm → ux_ui → design → {approval} → tech_lead → red_team → founder_ceo → {gate}
  - step 5종: `agent`(string) / `critique_loop` / `gate` / `fanout` / `approval`.
- **exec/mission 실행 계층** (`src/exec/`, `src/commands/{exec,mission}.ts`): worktree에서 실제 claude 세션을
  돌려 게이트·승인 후 병합하는 계층. 승인·권한 게이트 안에서만 동작. **V3(M0~M2) 범위와 별개**이며 이번
  작업에서 수정하지 않았다.

---

## 2. 문서 우선순위

- **활성 설계 문서 (구현 기준, 충돌 시 우선)**:
  1. `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` (F1 학습 / F2 진행 가시성 / F3 handoff)
  2. `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md` (Capability/ToolProfile/MCP, M0~M7)
- **참고 자료**: `docs/backlog/V3_FIELD_NOTES.md` (실측 근거로만. 단독 구현 근거 금지).
- **폐기(역사 기록)**: `docs/archive/V3_KICKOFF_SUPERSEDED.md` — 구현 근거 아님.
- **충돌 시**: 위 활성 2문서 > 코드 현실. 문서와 코드가 어긋나면 **구현 전에 보고**.

---

## 3. 완료된 마일스톤

### M0 — 문서 동기화 + provider 하드코딩 수정 · 커밋 `582f6e0`

- **해결한 문제**:
  - `taskPrompt.ts` 하드코딩 `provider: mock` → `run_state.provider` 반영(미실행 폴백).
  - CLI `--version` `0.1.0` ↔ package.json `2.6.0` 불일치 → package.json 단일 원본에서 읽기.
  - `CLAUDE.md` v1 단정 문구 → 현행 범위(문서 자동화 + exec/mission, 승인·권한 게이트) 교정.
  - V3 문서 v2.4 전제 → v2.6 구조 동일 각주. `V3_KICKOFF_SUPERSEDED.md`를 `docs/archive/`로 이동.
- **변경 파일**: `src/core/taskPrompt.ts`, `src/cli.ts`, `CLAUDE.md`,
  `docs/backlog/V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`(각주), archive 이동, docs(WORKLOG/DECISIONS/CONTEXT_SUMMARY), dist.
- **테스트**: acceptance 63 + exec 74 통과. task-prompt provider 3케이스(mock/claude-code/미실행) 실측.

### M1 — 진행 이벤트 모델 + tool 이벤트 골격 + JSONL trace 골격 · 커밋 `5cbdbcb`

- **RunEvent** (`src/core/progress.ts`) — 9 타입:
  `run_start` / `step_start` / `step_end` / `gate_jump` / `run_end` + tool 골격 `tool_start` / `tool_end` /
  `tool_denied` + `note{level:"info"|"warn"}`. `StepKind = agent|critic|revise|spawn|gate|approval`.
  **tool_* 는 타입만 존재하고 어디서도 방출되지 않는다** (검증: 방출 grep 결과 없음, trace.test 픽스처 데이터뿐).
- **ProgressReporter**: `{ emit(e: RunEvent): void }`. `runWorkflow` 인자로 주입(미지정 시 no-op).
  기존 `start/note/stop` 인터페이스를 이벤트 모델로 **교체**.
- **실패 시 step_end/run_end**: `runStepWithRegen`는 try/finally로 예외에도 `step_end{ok:false}` 방출
  (HARNESS_FAIL_AT 훅을 step_start 이후로 이동). run 전체를 try/finally로 감싸 예외에도
  `run_end{status:"failed"}` 보장. 렌더러는 `run_end`에서 spinner interval 정리.
- **resume**: `run_start.resumeFrom` = 재개 위치. 완료 step은 재실행하지 않고 타이밍 보존.
- **step_timings** (`RunState.step_timings: StepTiming[]`): `{ agent_id; kind; started_at(ISO); elapsed_ms; ok }`.
  resume 시 기존 배열(`gate_jumps`와 동일 패턴)로 보존 — 완료 step 중복 기록 없음.
- **TTY/non-TTY 렌더러** (`src/commands/progress.ts`): 이벤트 소비형. TTY=스피너, non-TTY=`▶` 시작 라인.
  완료 `✓ [i/total]` 라인은 core `console.log`가 직접 출력(불변). **gate/approval은 스피너 미가동**
  (stdin 승인 프롬프트와 \r 충돌 방지).
- **범용 JSONL writer** (`src/tools/trace.ts`): `createJsonlWriter(path)` → `{ path; append(record); count(); close() }`.
  ToolTrace 스키마 미고정, **runWorkflow 미배선**(검증: runWorkflow에 trace import 없음).
- **테스트**: `src/core/progress.test.ts`(이벤트 순서·critique·gate jump·실패/resume·TTY/non-TTY),
  `src/tools/trace.test.ts`(JSONL 왕복). `test:core` 스크립트 추가.

### M2 — Capability/ToolProfile 정책 계층 (실행 배선 없음) · 커밋 `b359bfc`

- **Capability 3계층** (`src/tools/capabilities.ts`):
  - **active (7)**: web_search, page_extract, source_verify, repo_read, design_read,
    component_registry_read, framework_docs.
  - **reserved (13)**: site_crawl, runtime_diagnostics, browser_explore, browser_test, database_read,
    database_migration_draft, database_apply, preview_deploy, error_monitoring_read, billing_sandbox,
    workspace_export, **local_workspace_write, pull_request_create**.
  - **permanent deny (5)**: **remote_repository_write, pull_request_merge**, production_deploy, billing_live,
    design_write. (`repo_write_direct`는 제거됨 → `capabilityTier`가 `unknown` 반환.)
  - `capabilityTier(c)` → `active|reserved|deny|unknown`.
- **ToolBinding 4종**: `builtin{tools[]}` / `internal_adapter{adapter, operations[]}` /
  `mcp{server, tools[]}` / `cli{command, operations?}`. profile만 보고 실행 주체를 판별.
- **ToolProfile + 수동 validator** (`src/tools/profiles.ts`): 필드 = id, capabilities, `bindings`, servers,
  preapprovedTools, deniedTools, permissionMode(read_only|dev_write|approval_write), allowedDomains, limits,
  secretRefs, source?. **신규 런타임 의존성 0** — `validateStructure`(수동 구조) + `validateSemantics`(시맨틱).
  `schemas/tool_profile.schema.json`은 계약 문서용이며 **런타임 미실행**.
- **bindings에서 exposedTools 자동 파생**: `deriveExposedTools(bindings)` — builtin.tools 그대로 + mcp는
  `mcp__<server>__<tool>`. internal_adapter/cli는 모델 노출 도구가 아니라 제외. **exposedTools는 profile
  입력이 아니다** — compile이 계산한다.
- **preapprovedTools / deniedTools 의미**:
  - `preapprovedTools` = 노출 도구 중 승인 없이 자동 실행할 도구. compile → `--allowedTools`(allowTools).
  - `deniedTools` = 명시 차단. compile → `--disallowedTools`(denyTools).
  - validator 강제: `preapproved ⊆ exposed`, `exposed ∩ denied = ∅`.
- **compileToolProfile(profile, {bare?, mcpConfigPath?}) → CompiledToolPolicy**:
  `{ profileId; exposedTools; builtinTools; allowTools; denyTools; hookRules; mcpConfig; claudeArgs;
  adapterPolicy{allowedDomains, limits}; redactNames; bindings; permissionMode }`.
  - `builtinTools` → `--tools`(빈 배열이면 `--tools ""`).
  - permissionMode 매핑: read_only→`plan`, dev_write→`acceptEdits`, approval_write→`default` (→ `--permission-mode`).
  - `hookRules`는 인자 조건부 deny(PreToolUse Hook) 산출용 — 현재 항상 `[]`(M3에서 채움).
- **Binding 실행 방식 기반 fail-fast** (`assertPolicyExecutable(policy, ctx)`):
  - builtin → `ctx.provider.builtinTools`
  - mcp → `ctx.provider.localMcp || remoteMcp`
  - internal_adapter → `adapterAvailable(adapter, ctx.adapters)` (Adapter Registry, M2 빈 목록)
  - cli → `ctx.commandAvailable(command)`
  - 위치: `src/core/runWorkflow.ts:215~222` — `--tool-profile` 지정 시 **run_start(라인 429)·run_state 생성
    이전**에 load→compile→assert. 미충족이면 throw → run 시작 안 함(run_state 미생성). 미지정 시 완전 no-op.
- **secret validation/redaction** (`src/tools/redact.ts`): `isValidSecretRef`(`^[A-Z][A-Z0-9_]*$`),
  `assertValidSecretRefs`(값 형태 거부), `redactSecrets`(값 + Authorization/`key=`/`token=`/`secret=` 패턴 `***`).
- **`--tool-profile <id>` opt-in**: `src/cli.ts` → `runRun`(`src/commands/run.ts`) → `runWorkflow` 인자
  `toolProfileId`. 지정 시에만 fail-fast, 미지정 시 기존 동작 불변.
- **Planning `--bare` + 내장 도구 제한**: `--bare` → compile이 `--strict-mcp-config` + `--tools`(내장 제한) 산출.
  일반 문서 profile(planning-none)=`--tools ""`, 로컬 읽기(planning-local-readonly)=`--tools "Read,Glob,Grep"`
  + `--permission-mode plan`. provider는 `claudeCodeProvider.buildClaudeArgs(policyArgs, model)`로 base
  argv(`-p --output-format json [--model]`) 뒤에 정책 argv를 병합(미지정 시 기존 동작 보존).
- **strict empty profile fallback**: `compileToolProfile(profile, {mcpConfigPath})` → `--strict-mcp-config
  --mcp-config <path>` + `mcpConfig={mcpServers:{}}`. **argv 생성·검증까지만**(자동 강등 판정은 M3).
- **registry/schema 배포 상태**: `registry/tool_profiles.json`에 `planning-none`, `planning-local-readonly`만.
  `schemas/tool_profile.schema.json` 신규. `package.json.files`에 `schemas` 추가(registry는 이미 포함).
  Tavily/shadcn profile은 실행기가 붙는 M3·M4까지 미등록.
- **테스트/npm pack**: `tests/fixtures/tool-profiles/`(7개, 배포 제외) + `tests/fixtures/golden/`(회귀 스냅샷).
  단위: `src/tools/{capabilities,redact,profiles}.test.ts`, `src/providers/claudeCodeBare.test.ts`,
  `src/core/toolProfile.test.ts`(run fail-fast + golden snapshot 회귀 — 가변 메타 제거 후 비교).
  npm pack: 69 files, tests/·src/·*.test.* 미포함, `dist/tools/*`·`registry/tool_profiles.json`·
  `schemas/tool_profile.schema.json` 포함.

### 최신 전체 테스트 결과 (이번 세션 실측)

`npm test` → **exec 75 pass / core(=test:core: core+tools+providers+commands) 273 pass / acceptance 71 PASS**, 실패 0. (M3c-3b blocking MCP 연결 env 반영, 2026-07-24. 단, M3c-2 runner smoke 테스트는 부하 시 간헐 flake — 단독/재실행 green.)

### ProviderCapabilities 값 (검증, `src/providers/capabilities.ts`)

| provider | toolUse | builtinTools | localMcp | remoteMcp | toolAllowlist | interactiveApproval | streaming | toolTrace |
|---|---|---|---|---|---|---|---|---|
| mock | F | F | F | F | F | F | F | F |
| claude-code | T | T | T | T | T | **F**(-p) | T | **F**(M3) |
| anthropic | F | F | F | F | F | F | F | F |

---

## 4. 현재 코드 상태 (구분)

- **구현·배선 모두 완료 (실동작)**:
  - M0 전부. M1 진행 이벤트(run/step/gate_jump/run_end/note) 방출 + TTY/non-TTY 렌더러 + step_timings 저장
    + resume. M2 profile 로드/검증, compileToolProfile, binding 기반 fail-fast(`--tool-profile` run 연결),
    secret 검증/redaction, `--bare`/strict-empty **argv 생성**.
  - **[M2.1] non-MCP profile의 policy argv가 실제 claude-code spawn까지 배선됨**: compile된
    `claudeArgs`(`--strict-mcp-config`/`--tools`/`--permission-mode`)가 `ProviderExecContext`로
    runWorkflow→runAgent→`claudeCodeProvider` spawn argv에 반영(mock/anthropic 무시, 미지정 회귀 없음).
    provider 오류(stderr/stdout/spawn error)는 `redactSecrets` 통과. JSONL writer optional 재귀 redaction.
  - **[M2.1] MCP binding profile은 run_start 이전 fail-closed**(per-tool 강제 없음 → M3 preflight/snapshot 필요).
    loader/compileToolProfile은 MCP를 거부하지 않음(M3가 로드 가능).
- **정책·타입만 구현 (소비처 없음)**:
  - RunEvent `tool_start/tool_end/tool_denied`(방출 없음). `src/tools/trace.ts` JSONL writer(runWorkflow 미배선).
    compileToolProfile의 `mcpConfig`·`hookRules`(생성만, 실제 claude 전달·Hook 실행 없음).
    `schemas/tool_profile.schema.json`(런타임 미실행). Adapter Registry(빈 목록).
    (`claudeArgs`는 M2.1에서 non-MCP에 한해 실제 전달로 승격 — 위 항목 참조.)
- **실제 외부 실행 아직 없음**:
  - 실 MCP 서버 기동, `mcpConfig` 파일 write·claude 전달, `system/init` snapshot 수집,
    shadcn/Tavily 호출, PreToolUse 등 Hook, canary 격리 실측 — 전부 미구현.
    (`--strict-mcp-config`/`--tools`가 argv에는 실리나 **격리 강제는 실측 미검증** — M3a.)
- **M3에서 연결해야 하는 것**:
  - compileToolProfile의 `mcpConfig` 파일 write·claude 전달(non-MCP argv 전달은 M2.1 완료), tool 이벤트 실 방출(stream-json 파싱)
    → JSONL trace 배선, handoff 세션, `--bare` snapshot 검증·자동 fallback.

---

## 5. 다음 마일스톤 M3 (분리 기록)

### M3a — Headless preflight — **offline+live 완료** (Claude Code 2.1.215 non-empty MCP strict 격리 live 통과)

> **live 검증 범위 구분**: M3a는 **non-empty MCP profile**(expected 서버 1개 + `mcp__expected__read_thing`)로 headless preflight의 strict 격리·canary 차단을 **실제 Claude 2.1.215에서 실측 통과**했다. **M3b.2의 empty MCP config + hook-settings + 대화형(TUI) Hook 경로도 2026-07-20 실제 Claude 2.1.215에서 live acceptance PASS**(아래 M3b.2 live acceptance 완료 참조).

구현: `src/exec/{types,streamParser}.ts`(init.mcpServers 정규화), `src/providers/claudeCodeMcpAdapter.ts`(mcp-config 생성·검증), `src/tools/preflight.ts`(`runPreflight` — argv/env 강제, hard timeout, init 후 의도적 종료, snapshot 검증, fail-closed `PreflightError`). offline 테스트는 fake claude stub + NDJSON fixture. **live acceptance는 수동 runner `scripts/m3a-live-preflight.mjs`(+`fixtures/m3a/minimal-stdio-mcp.mjs`), `HARNESS_LIVE_M3A=1` 필수, npm test/CI 비대상.**
- `claude -p --output-format stream-json --verbose --no-session-persistence --strict-mcp-config --mcp-config <gen> --tools "" --permission-mode plan`, env `MCP_CONNECTION_NONBLOCKING=0`·`ENABLE_TOOL_SEARCH=false`.
- `system/init`의 실제 mcp_servers·mcp__* 도구를 기대치와 정확 비교(전부 connected, canary/누락/중복 자동 실패).
- 성공 시 tools-snapshot.json(profileId/cwd/timestamp/configHash/servers/tools) 저장, 실패 시 성공 result 미반환.
- **live 실측(2026-07-19, Claude Code 2.1.215)**: expected server `connected`, `mcp__expected__read_thing` 정확 일치, ambient `.mcp.json` canary **미기동**(strict 격리 확인), sentinel/config/snapshot redaction 통과, fixture·임시 디렉터리 잔존 없음. **버전 종속 실측 — CLI 변경 시 재검증**("플래그=격리" 금지 유지).
- 실행: `npm run build && HARNESS_LIVE_M3A=1 node scripts/m3a-live-preflight.mjs`. preflight 통과 전 interactive handoff 시작 금지(M3b 배선 시).

### M3b — Interactive handoff trace
- **M3b.1 완료(offline 기반)**: `src/tools/{toolTrace,hookCollector,hookSettings}.ts`(+test), `trace.ts` sanitizeValue(민감 key 재귀 마스킹). Hook payload(PreToolUse/PermissionRequest/PostToolUse/PostToolUseFailure/PermissionDenied/SessionEnd)→공통 ToolTrace JSONL 정규화, 6 이벤트/필수 필드, exit code 게이팅(deny·audit실패 exit2/사후 exit1/stdout 미사용), env 계약 `HARNESS_TOOL_*`(secret 이름만), 원문 미저장(tool_response byte만)·크기 상한, MCP server=exact tool map 판정(추측 금지). `toRunEvent` 매핑 정의(실시간 emit 없음). **승인 의미 한계**: PermissionRequest=요청만·PermissionDenied=auto denial만. PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없음→callId=null·synthetic ID 미생성·`permissionOutcomeObservable:false`. Hook만으로 수동 승인/거부를 정확히 연결 불가. SessionEnd는 종료 사실만 기록(unresolved·승인 결과 추측 금지).
- **M3b.1 P0/P1 하드닝(완료)**: collector fail-closed(`parseConfig` 엄격·JSON fallback 금지, PreToolUse/PermissionRequest 실패 exit2·사후 exit1, stack/secret 미출력), payload 계약 검증(hook_event_name 일치·session_id 필수, PermissionRequest=tool_name+tool_input·tool_use_id 없음, tool hook=tool_use_id 필수, deny는 PreToolUse만), **SessionEnd는 종료 사실만 기록**(공식 payload에 correlation ID 부재로 unresolved·승인 결과 추측 금지), UTF-8 byte 상한(멀티바이트 경계 보존)·재귀 depth 상한, settings shell-safe quoting·`denyMatchers[]` dedupe.
- **M3b.2 완료(offline)**: handoff CLI·승인·headless preflight 게이트·격리 Hook settings·stub interactive spawn. `src/core/handoff.ts`(신규 `runHandoff` — outcome union, seam 주입)·`src/commands/handoff.ts`(신규)·`src/cli.ts`·`src/commands/run.ts`(`--handoff`/`--cwd`). 대화형 spawn argv `--strict-mcp-config --mcp-config <빈> --settings <hook-settings> --setting-sources "" --add-dir <contextRoot> --permission-mode default --tools default --disallowedTools mcp__* -- <initialPrompt>` (가변 인자 `--disallowedTools`가 프롬프트를 deny 값으로 소비하지 않도록 `--`로 옵션 파싱 종료 후 initialPrompt를 positional로 전달; `--add-dir <contextRoot>`는 planning 문서(docs/*.md) 접근용 — P0-1 수정 반영). **`-p`/stream-json 없음, `stdio:"inherit"`.** env `HARNESS_TOOL_*`(이름만)+`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. **spawn 전 fail-closed preflight**(빈 MCP config, `emptyConfig`, ambient 서버/도구 하나라도 감지 시 차단; `--setting-sources ""`·auto-memory 격리 추가). Hook settings 공식 exec form(`command`=node, `args`=[collectorPath, hookKind]; deny는 args 마지막 "deny"). run_state.handoff는 **실제 spawn된 경우에만**(print/reject/preflight 실패/spawn 실패/non-TTY/missing binary 미기록, 종료코드·completed 불변). 산출물 `outputs/runtime/<id>/{mcp-config,hook-settings}.json`·`outputs/tool-trace/<id>.jsonl`(gitignore·dir700/file600, raw payload/transcript 미저장). **대화형은 `stdio:inherit`+Hooks만 — stream-json은 M3a preflight 전용.** 실제 Claude/TUI/live Hook 미실행(seam 주입).
- **M3b.2 P0/P1 보완(완료)**: (P0) collector는 `PACKAGE_ROOT/dist/tools/hookCollector.js` 절대경로만(import.meta.url 상대 제거), spawn/preflight 전 존재·일반 파일 검증→없으면 `setup_failed`. (P0) trace JSONL은 spawn 전 빈 0600 사전 생성(append 후 0600 유지), hook-settings/mcp-config/tools-snapshot 0600·dir 0700, 기존 파일·symlink는 `wx`로 fail-closed, 기본 handoff id는 randomUUID. (P1) redaction refs는 env 이름(TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH·값 존재)에서 **이름만** 파생→`HARNESS_TOOL_SECRET_REFS`+collector 값 마스킹, preflight `redactNames`는 scrub 전용(child env 미전달), spawn/setup/preflight 오류·outcome `redactSecrets`. (P1) initialPrompt에 "서비스 레포 AGENTS.md·CLAUDE.md 준수" 명시(`--setting-sources ""` 보완). `runHandoff`는 명시적 outcome union. 검증: exec 75 + core 154 + acceptance 71.
- **M3b.2 offline 최종 보완(2026-07-20)**: (1) 승인 preview 전체 redaction — `buildPreview`가 task prompt head만이 아니라 **cwd·trace 등 모든 동적 문자열을 포함한 최종 결과 전체**를 scrub(승인 화면 secret 평문 부재). (2) collector 검증 예외 정규화 — stat/readability 검증을 try/catch로 감싸 **부재·디렉터리·stat/access 오류를 예외 없이 scrub된 `setup_failed`로 반환**(preflight/spawn/handoff 기록 없음). production 경로 `PACKAGE_ROOT/dist/tools/hookCollector.js` 유지 + 테스트용 `collectorPath` seam, 일반 파일이며 읽기 가능할 때만 통과. (3) 테스트 정합성 — wx 충돌 테스트를 "trace 파일 exclusive-create 충돌"로 개명, collector 부재/디렉터리 setup_failed 테스트 추가, preview 전체 scrub 테스트 추가. 검증: exec 75 + core 157 + acceptance 71.
- **M3b.2 두 번째 live 부분 통과 + P0 2건(2026-07-20, 전체 PASS 아님)**: argv `--` 꼬리로 초기 프롬프트는 정상 전달됐으나 **① planning context 경로 단절(P0-1)** — task prompt Include는 `docs/*.md` 상대경로인데 대화형 cwd는 serviceCwd, 실제 planning 문서는 `projectPaths(project).root/docs` → Claude가 docs 못 찾고 serviceCwd에 잘못된 `docs/WORKLOG.md` 생성. **② sentinel TUI 평문 출력(P0-2)** — Bash 검증 `printf '%s' "$M3B2_LIVE_TOKEN"`이 fake sentinel 값을 TUI에 출력(실제 credential 아님). 수정: (P0-1) `contextRoot=projectPaths(project).root` + argv `--add-dir <contextRoot>` + initialPrompt 경로 계약 + preview에 serviceCwd·contextRoot 별도 표시 + 128KB fallback contextRoot 접근, `--disallowedTools mcp__* -- <initialPrompt>` 꼬리 유지. (P0-2) Bash 검증을 비출력 `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`로 변경. 회귀 테스트·runner 검증 추가(planning Read 성공·serviceCwd docs 미생성·`--add-dir`). (재검증 결과: 아래 live PASS 항목 참조.)
- **M3b.2 첫 live 시도 무효(argv P0, 2026-07-20)**: Claude Code 2.1.215 첫 실행에서 대화형 argv 꼬리가 `--disallowedTools mcp__* <initialPrompt>`였고, `--disallowedTools`(가변 인자)가 **initialPrompt를 deny 규칙으로 소비**해 프롬프트 전 단어가 `Permission deny rule "..." matches no known tool` 경고로 출력됨. **세션이 acceptance 절차를 받지 못해 무효 — Hook 검증 미수행, PASS 아님.** 수정: argv 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로(옵션 종료 구분자 `--`). 회귀 테스트(`handoff.test.ts` 성공 테스트 강화 + 전용 P0 테스트)·runner 사후 argv 검증 추가. offline 검증만 완료(실제 Claude/TUI 미재실행).
- **M3b.2 actual live acceptance 완료(PASS, 2026-07-20, Claude Code 2.1.215)**: 위 P0(argv/planning 경로/sentinel 출력) 수정 후 수동 runner(`scripts/m3b2-live-handoff.mjs`, `HARNESS_LIVE_M3B2=1`, TTY 필수)를 재실행해 **exit 0/PASS**. 실측 통과: exec-form Hook 6종 exact 계약·`--setting-sources ""` 수용, empty MCP snapshot(servers=[]/tools=[])·config({}), planning contextRoot 접근(`--add-dir`, 00_IDEA/06_CEO_DECISION Read 성공, serviceCwd docs 미생성), Read 성공/실패 callId correlation, Bash 승인(permission_requested callId=null + tool_requested/succeeded, 비출력 sentinel 검사), Write 수동 거부(requested+permission·marker 부재·denied 미합성), SessionEnd 1건, ambient MCP/Hook canary 미기동, trace redaction·권한(dir700/file600)·원문 미저장, run_state 불변, argv `-p`/stream-json 없음(`--` 꼬리). **버전 종속 실측(2.1.215) — CLI 변경 시 재검증.** **다음: M3c(shadcn read) 파일럿 계획 검토(구현 아님).**

### M3c — 제한된 shadcn read 파일럿
- **검증한 고정 버전** 사용(`@latest` 금지).
- 표준 shadcn registry만 허용. `components.json`의 custom/private registry 검사.
- `browse`/`search`(read) 도구만 exposed. `install`/`add`/write 도구 미노출.
- 실제 snapshot(도구명)·결과 크기 검증. (`미확인`: shadcn 실제 MCP 도구명은 M3 착수 시 확인 필요.)

- **M3c-0 discovery offline+live 완료(2026-07-21). 전체 M3c는 미완료(profile 등록·handoff 미연결).** 실제 Claude Code **2.1.216**에서 `shadcn@4.13.1` MCP discovery **1회 실행 → exit 0/OK, server `shadcn` connected**, strict 격리(ambient canary 미기동)·권한(dir700/file600)·redaction·cleanup·잔존 프로세스 검사 통과. **발견된 실제 도구 7개(원문, 이름으로 권한 분류·browse/search/install/add 추측 매핑 금지)**: `mcp__shadcn__get_add_command_for_items`, `mcp__shadcn__get_audit_checklist`, `mcp__shadcn__get_item_examples_from_registries`, `mcp__shadcn__get_project_registries`, `mcp__shadcn__list_items_in_registries`, `mcp__shadcn__search_items_in_registries`, `mcp__shadcn__view_items_in_registries`. **다음: M3c-1 `tools/list` schema·semantics 검증 계획**(inputSchema·read/write 성격 실측 → 권한 매핑·profile 등록·handoff 연결). 이번 단계 profile 등록·handoff 연결·MCP 도구 호출 없음.
- **M3c-1 tools/list schema discovery scaffold offline 완료(2026-07-21). actual live schema probe 승인 대기.** `src/tools/shadcnSchemaProbe.ts`(+`.test.ts`)·`scripts/m3c-live-schema-probe.mjs` 신규. shadcn 전용 좁은 stdio JSON-RPC probe — `initialize→notifications/initialized→tools/list`만, **tools/call 코드 경로 없음**. 명령 정확히 `npx --yes shadcn@4.13.1 mcp`(주입 seam 없음; 테스트 `HARNESS_SHADCN_NPX_BIN` launcher만 교체). protocolVersion `2025-06-18` 엄격 negotiation, registry 검사 config/spawn 이전 강제, bare 도구명→`mcp__shadcn__` namespacing→7개 정확 일치, pagination(반복 cursor·페이지8·64개 상한), name/description/inputSchema 필수·outputSchema/annotations plain object, 깊이/키/크기 상한, JSON-RPC/malformed/no-init/timeout/non-zero/stdout(1MiB)/stderr(64KiB) 거부. 산출물 `mcp-schema-discovery.json`(mode:`schema-discovery`·usableForHandoff:false, raw payload 미저장, 반환==저장, dir700/file600/wx, deep-scrub, `ShadcnSchemaResult{schemaDiscovery:true}` 타입 분리). **live schema probe(수동 `HARNESS_LIVE_M3C_SCHEMA=1`)는 미실행 — 실제 schema 미확정. 권한 분류·profile 등록·handoff 연결·result-size enforcement 미착수(M3c-2+).**
- **M3c-1 offline+actual live schema probe 완료(PASS, 2026-07-21).** live runner 1회 실행 → exit 0/OK, Claude 미사용(shadcn MCP stdio 직접), tools/call 없음, cleanup·잔존 프로세스 통과. 실측: `shadcn@4.13.1`, protocolVersion **2025-11-25**, serverInfo `shadcn 1.0.0`, 도구 7개 정확. **annotations·outputSchema 전 도구 없음.** inputSchema: `get_add_command_for_items`/`view_items_in_registries`=items(required), `get_item_examples_from_registries`=registries?+query(required), `search_items_in_registries`=registries?+query(required)+types?+limit?+offset?, `list_items_in_registries`=registries?+types?+limit?+offset?, `get_audit_checklist`/`get_project_registries`=입력 없음. **schema/description은 실측됐으나 annotations/outputSchema 증거 없음. description은 서버 제공 untrusted → read/write 권한 분류 근거로 미확정.** profile 등록·handoff 연결·도구 호출·result-size enforcement **미완료. 다음: M3c-2 controlled read semantics 검증 계획.**
- **M3c-2 controlled read semantics probe scaffold offline 완료(2026-07-21). actual five read calls 승인 대기.** `src/tools/shadcnReadSemanticsProbe.ts`(+`.test.ts`)·`scripts/m3c2-live-read-semantics.mjs` 신규. exact `npx --yes shadcn@4.13.1 mcp` → init→initialized→tools/list(7개 exact)→ **읽기 후보 5개만 고정 인자 순차 tools/call**(코드 상수·주입 seam 없음): `get_project_registries`/`list_items_in_registries`/`search_items_in_registries`/`view_items_in_registries`/`get_item_examples_from_registries`. **금지 2개**(`get_add_command_for_items`·`get_audit_checklist`)는 tools/call 경로 없음. serviceCwd 호출 전/후 재귀 snapshot(경로·타입·mode·size·SHA-256) 무변경 검증(생성/수정/삭제/symlink→`filesystem_changed`), HOME/cache serviceCwd 밖 분리. CallToolResult 계약(isError/빈/malformed 거부). **외부 결과 원문 미저장** — 파생 지표만(argumentsHash/resultHash/elapsedMs/responseBytes/textChars/contentTypes/structuredContentPresent/filesystemBefore·AfterHash/unchanged/withinProposedBudget). 상한 5회·per-call 60s·overall 5min·단일 256KiB·stdout 2MiB·stderr 64KiB·budget 8,000 chars **측정만**. artifact `mcp-read-semantics.json`(mode:`read-semantics`·usableForHandoff:false·externalDataUntrusted:true). operationSummary{...,toolCalls:5,forbiddenToolCalls:0}. **5개는 노출 승인 아닌 검증 후보. 권한 분류·profile 등록·handoff 연결·result-size enforcement 미완료. live(수동 `HARNESS_LIVE_M3C2_SEMANTICS=1`) 미실행.**
- **M3c-2 actual live read semantics acceptance PASS(2026-07-22).** live runner 1회 exit 0, **Claude CLI 미사용**(shadcn@4.13.1 stdio 직접). 고정 5개(`get_project_registries`→`list_items_in_registries`→`search_items_in_registries`→`view_items_in_registries`→`get_item_examples_from_registries`) 정확 순서 호출, 금지 2개(add_command/audit_checklist) 미호출, 5회 unchanged=true, 전 결과 contentTypes=[text]·structuredContentPresent=false·withinProposedBudget=true. responseBytes/textChars: 365/285·274/194·289/207·172/94·**최대 get_item_examples 4441/4161**. config 정확(`npx --yes shadcn@4.13.1 mcp`)·권한(runtime700/config600/snapshot600)·redaction·cleanup·잔존 프로세스 없음 통과. protocolVersion 허용·serverInfo non-empty **계약 통과로 기록**(정확값은 이번 출력에 없음; 2025-11-25/shadcn 1.0.0은 M3c-1 실측 구분). resultChars/resultBytes는 미출력 → 추측 안 함. **5개는 노출 승인 아닌 검증 후보. 권한 분류·profile 등록·handoff 연결·result-size enforcement 미착수. 다음: M3c-3 권한 매핑·필터링·result-size enforcement 계획 검토(구현 미착수).**
- **M3c-3a shadcn read-only filtering MCP proxy(offline, 2026-07-22).** `src/tools/shadcnReadMcpProxy.ts`(+`.test.ts`)·`src/tools/shadcnReadPolicy.ts` 신규. 원본 7개 전부 노출 → 직접 profile 연결 금지; deniedTools/Hook은 "미노출"·"전달 전 크기 제한"을 보장 못 하므로 **로컬 필터 MCP 프록시**가 경계. upstream=MCP 서버(읽기 5개만·**로컬 제한 schema**, downstream desc/schema 미노출), downstream 고정 `npx --yes shadcn@4.13.1 mcp`(seam 없음). startup: components.json 검사→downstream init(허용 protocol·caps.tools·serverInfo)→tools/list **실측 7개 정확 일치** 요구, 불일치·custom registry는 spawn 전/직후 fail-closed. 금지 2개(add_command/audit_checklist) tools/list 미노출+call fail-closed(downstream 미전달), unknown/dup id/malformed fail-closed. 입력 정책 additionalProperties:false + 좁은 범위(registries=["@shadcn"]·types=["ui"]·limit1-20·offset0-1000·query1-200·view items 1-10 @shadcn/ prefix·traversal/URL/제어문자 금지). 상한 call≤6·60s·단일 256KiB·stdout2MiB·stderr64KiB, **resultChars>8000 hard reject(원문·pointer 미전달 — pointer 상한 우회 방지)**, isError/빈/structured/non-text fail-closed. child env allowlist+임시 HOME(ambient secret 미전달). 종료는 detached 그룹 kill(descendant 방치 없음)→close 확인→temp 정리. **registry/tool_profiles.json·handoff.ts·profiles.ts·schema·CLI 미수정. 5개는 아직 profile 등록·노출 승인 아님.**
- **M3c-3b actual live acceptance PASS · V3 M3 전체 완료(2026-07-24).** filtered shadcn read handoff가 Claude Code **2.1.218** 수동 runner에서 **exit 0/PASS**. 실측: preflight shadcn **connected**+host **5** exact(원본 7 중 금지 2 미노출·canary 부재); mcp-config `node`+고정 proxy(launcher/npx 없음)·**config 파일 sha256 == snapshot.configHash == outcome.handoff.config_hash == run_state.handoff.config_hash**·snapshot_path 3중 일치; interactive argv allowed 5/denied 2/`mcp__*` 없음/`-- prompt`/-p·stream-json 없음; ToolTrace **records 25·MCP tool_requested 3·session_end 1**, 3개 각 requested/succeeded 동일 callId·server=shadcn, **permission_requested/tool_failed/tool_denied 없음**, sanitizedInput 정확 일치, 금지 2 미관측·원문/transcript/secret 없음; serviceCwd 무변경·run_state completed 불변·dir700/file600·ambient canary 미기동·잔존 proxy/shadcn/canary 없음·cleanup 완료. 실패 이력: ①첫 live protocol/startup interop → server_not_connected, ②status=pending(5s connect deadline), ③blocking MCP env 0/45000/45000 후 PASS. dead helper 정리: `applyBlockingMcpEnv()` 단일 적용(preflight return·handoff shadcn spawn), 직접 Object.assign 제거, 기본 handoff 불변, runner는 계약 값 사후 확인 유지. **M3a(strict 격리)·M3b.2(대화형 Hook)·M3c-3b(filtered read) live 모두 충족 → V3 M3 전체 완료. 다음 단계(활성 read 도구 확대·M4 Tavily/Research 등)는 별도 계획 검토로만 기록(미착수).**
- **M3c-3b 두 번째 live P0: blocking MCP 연결 env(2026-07-24).** server_not_connected(status=pending) 원인 = Claude 2.1.218 `MCP_CONNECT_TIMEOUT_MS` 기본 5s < cold npx+exact-7 attestation. 단일 출처 `src/tools/mcpEnv.ts`(`BLOCKING_MCP_ENV`: NONBLOCKING=0/CONNECT_TIMEOUT_MS=45000/MCP_TIMEOUT=45000; 순서 proxy 30s<handshake 45s<preflight 60s). preflight `buildChildEnv`와 handoff-shadcn interactive spawn env에 **마지막에** `Object.assign` 강제(ambient process.env·testEnv override 불가). 기본 handoff(empty MCP, toolProfile 미지정) 경로는 미적용 → 기존 동작 불변. pending/failed/needs-auth 불성공·connected+exact tools만 성공·hard timeout 60s·argv/stdio/Hook 계약 유지. 테스트: preflight/handoff-shadcn env 세 값 정확·override 불가·secret 미전달, 기본 handoff 강제 없음. runner는 BLOCKING_MCP_ENV 계약 값(0/45000/45000) 사후 확인(불일치 exit 2), pending retry/성공 처리 미추가. 검증: exec 75 + core 273 + acceptance 71. **live 재실행 보류(수동).**
- **M3c-3b MCP proxy interoperability P0(2026-07-24).** live preflight `server_not_connected` 원인 수정. (P0-1) `shadcnReadMcpProxy`가 downstream 협상 버전을 upstream initialize 응답에 복사하던 것 제거 — upstream `params.protocolVersion` 검증(missing/비문자열/미허용 → `-32602` fail-closed·tools 미노출) 후 **요청 버전 그대로** 반환, downstream은 REQUEST_PROTOCOL_VERSION 별도 협상(`upstreamProtocolVersion`/`downstreamProtocolVersion` 분리). (P0-2) downstream attestation 완료 후 upstream listener를 켜던 구조 → **spawn 직후 즉시 listener**·initialize 즉시 응답, attestation은 별도 bounded Promise, tools/list·tools/call은 attestation exact-7 passed 전 성공 금지(pending bounded wait), 실패 시 restricted 5 미노출·연결 종료·main non-zero·그룹 kill·HOME cleanup, upstream_end 성공 종료는 attestation 완료까지 defer. proxy 테스트 26→32(protocol 분리·unsupported/missing pv·2s 지연 init<500ms·지연 tools/list는 attestation 후 bare5·지연 attestation 실패 reject·pending abort). runner: preflight_failed 시 scrub된 outcome.message(status) 출력·claudeBin redact. 검증: exec 75 + core 271 + acceptance 71. **live acceptance 보류(수동).**
- **M3c-3b live runner 거짓 PASS 차단 보완(2026-07-24, runner-only).** `scripts/m3c3b-live-handoff.mjs`만 강화(production 미변경): preapproved 3개 각 tool_requested 1 + 동일 callId succeeded·failed/denied 없음·sanitizedInput 정확 deepEqual·permission_requested 있으면 FAIL·계획 외 mcp__* FAIL; 잔존 프로세스 baseline(ps 실패 시 spawn 전 exit2)+5s grace+lsof ownership(미확인/실패 kill 없이 FAIL, owned만 kill+사망 확인, cleanup 백스톱도 실패 미은폐); claude --version env allowlist(표준 LC만)+timeout10s+maxBuffer64KiB+redaction; mcp-config exact deepEqual + config_hash 4자 체인(파일 sha256==snapshot==outcome==run_state)·snapshot status 정확히 "connected"·snapshot_path 3중 일치. offline: build/tsc(0)/node --check/opt-in·非TTY exit2/diff clean. exec 75 + core 265 + acceptance 71.
- **M3c-3b 마지막 P1 + 전용 live runner(2026-07-24).** P1: `claudeCodeMcpAdapter` launcher 혼합 검사 `decl.args !== undefined`(빈 배열 `args:[]`도 mixed_launcher, buildMcpConfig 직접 호출 포함), 중복 `TRUSTED_LAUNCHERS` Set 제거 → `profiles.TRUSTED_LAUNCHER_IDS` 단일 출처(`isTrustedLauncher`). 전용 live runner `scripts/m3c3b-live-handoff.mjs`(수동 전용): `HARNESS_LIVE_M3C3B=1`+TTY+`claude --version`(semver) 게이트(없으면 exit 2), 임시 `$TMPDIR/m3c3b-live-*` workspace/service repo + ambient `.mcp.json` MCP canary + `.claude` Hook canary, production `runHandoff({toolProfileId:"handoff-shadcn-readonly"})`를 seam 없이 실행(실제 preflight+TUI+`npx shadcn@4.13.1`). 시나리오: 계획 승인→get_project_registries→search(button,limit1)→view(@shadcn/button)→/exit, 금지 2개 미호출. PASS: snapshot(shadcn/connected·host5·원본7/금지2/canary 부재)·config(node+고정 proxy·launcher/npx 없음)·argv(allowed5·denied2·mcp__* 없음·-- 꼬리·-p/stream-json 없음)·trace(profileId·server=shadcn·requested/succeeded correlation·session_end1·금지2 미관측·raw/transcript/secret 없음)·serviceCwd 무변경·run_state completed 불변·handoff(tool_profile_id/config_hash/snapshot_path)·권한(700/600)·canary 미기동·proxy/shadcn/canary 잔존 프로세스 없음(lsof cwd ownership 확인 후 kill)·cleanup 완료. offline: build/tsc(0)/node --check/opt-in·非TTY exit2/diff clean. exec 75 + core 265 + acceptance 71. 실행: `npm run build && HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs`. **live acceptance는 사람 승인 후 수동(보류).**
- **M3c-3b live 전 P0/P1 하드닝(2026-07-24).** P0-1: launcher 실행 경로 override seam(`BuildMcpConfigOpts.proxyPath`·buildMcpConfig/writeMcpConfig opts·`RunPreflightOpts.launcherProxyPath`·`HandoffOptions.launcherProxyPath`) **완전 제거** — `shadcn_read_proxy`는 항상 `process.execPath + fromPackage("dist","tools","shadcnReadMcpProxy.js")` 고정(인자·env·profile·test seam 불가). 파일 검증은 `verifyTrustedProxyFile()`로 분리(테스트만 임시 경로로 호출, config 주입 API 없음). `rg "launcherProxyPath|proxyPath" src dist`=0. P0-2: 계약에 secretRefs=[]·allowedDomains=[]·server key 정확히 {name,launcher}(args 존재 자체 거부); launcher+secretRefs → `launcher_secret_refs_forbidden`(config·preflight·spawn 전, 값 미노출). P1-1: `validateServer`(로드 단계 강제) — launcher/stdio/http/bare 분류·unknown key·unknown launcher·mixed transport 거부, `McpServerDecl.launcher`=`"shadcn_read_proxy"` literal, schema server oneOf+additionalProperties:false. P1-2: `lstatSync` 기반 symlink 거부(`launcher_proxy_symlink`). profile 미지정 경로·allowed5/denied2/exact snapshot·runWorkflow MCP 가드 불변. 검증: exec 75 + core 264 + acceptance 71. **live acceptance 보류.**
- **M3c-3b filtered shadcn read profile offline 배선(2026-07-23).** (주: 최초 배선의 launcher 실행 경로 override seam은 2026-07-24 P0-1에서 제거됨 — 실행 경로 고정.) registry `handoff-shadcn-readonly`(mcp shadcn·bare5·preapproved host5·denied host2·approval_write·상한 calls6/8000/60000·source official) 등록. **`McpServerDecl.launcher`(schema enum `shadcn_read_proxy`)** 신설 — registry엔 절대경로·npx 없이 논리 식별자만, `claudeCodeMcpAdapter.compileLauncherServer`가 runtime에서만 `command=process.execPath, args=[PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js]`로 변환(command/args/url/transport 혼합·unknown launcher·proxy 부재/디렉터리/읽기불가 = 기록 전 fail-closed, 생성 config에 launcher 필드 없음, 원본 npx shadcn 직접 실행 없음). 기존 command/args/http 동작 불변. handoff: `handoff --tool-profile handoff-shadcn-readonly`(파일럿 이 id만·계약 exact 검증, 다른 profile `profile_rejected`), `run … --handoff --handoff-tool-profile`(workflow용 `--tool-profile`과 분리·runWorkflow MCP 가드 불변), `--print`에 `--tool-profile` 보존. 시퀀스(profile): load+계약검증 → components.json 표준 registry 검사(custom/private/malformed/symlink → Claude·proxy 전 `registry_rejected`) → preflight(proxy config)로 shadcn connected + 정확 5개일 때만 통과 → 동일 config 대화형 spawn(stream-json 미사용). argv `--allowedTools <host5> --disallowedTools <host2> -- <prompt>`(profile엔 `mcp__*` 전체 deny 없음; 미지정 기본 경로는 기존 empty-MCP + `mcp__*` deny 완전 불변). Hook profileId=handoff-shadcn-readonly·toolMap(허용5→shadcn), preview에 profileId/server/허용5/금지2/상한('MCP 없음' 제거)·secret 값·raw MCP 미노출. HandoffRecord optional `tool_profile_id/config_hash/snapshot_path`(profile 경로만), status/completed 불변. 테스트: adapter launcher 6 + handoffShadcn 통합/실 preflight exact5·tool_mismatch. 기존 M3c-0/1/2/3a "shadcn 미등록" 불변 → "handoff-shadcn-readonly(launcher)만·npx 미등록"으로 정정(삭제·완화 아님). 검증: exec 75 + core 253 + acceptance 71. **live acceptance(실제 Claude+shadcn stdio proxy)는 사람 승인 후 수동 — 현재 보류.**
- **M3c-3a signal P0 보완(2026-07-22).** AbortSignal을 **downstream spawn 직후부터** 연결(이전엔 serve/startup 완료 후에만 붙어 startup·in-flight signal이 timeout 30s/60s까지 대기했음). signal ⇒ 즉시 process group 종료 + pending reject + queue 폐기, child close 후에만 HOME/cache 삭제. main SIGINT=130·SIGTERM=143(proxy_error/1로 안 바꿈), settled 후 stdout 미기록, listener 완료 시 제거, cleanup 정확히 1회(signal/close 경합 안전), markDead가 pending timer clear(signal 뒤 timeout 콜백 재실행 없음). downstream 응답 계약 위반(malformed/bad jsonrpc/id mismatch/**result 비객체**/cap/timeout/조기 close)=fatal group 종료; **일반 JSON-RPC tool error·result budget·입력 정책 거부=세션 유지**. P1: main에서 `HARNESS_M3C3_TEST_CLEANUP_FAIL` env 백도어 제거 — cleanup 실패는 `cleanupFaultForTest` 함수 seam으로만. 테스트 21→26(+exec SIGINT130/SIGTERM143 3초 내·descendant·HOME, env 무시 exit0, downstream malformed/bad-result fatal, 정책거부/tool error 뒤 정상호출). 검증: exec 75 + core 234 + acceptance 71. **M3c-3b는 계획 검토 전 상태 유지.**
- **M3c-3a P0/P1 보완(2026-07-22).** P0-1 `main()`+ESM 가드(실행 진입점: stdin/stdout 구동, JSON-RPC 전용 stdout, stdin 정상종료+cleanup 성공만 exit 0, cleanup/startup 실패·signal non-zero, SIGINT/SIGTERM group 종료+HOME cleanup). P0-2 tools/list·tools/call **bare name만**(host prefix `mcp__shadcn__*`는 서버가 반환 안 함; prefix 입력 거부; host-namespaced는 내부 보고 파생만). P0-3 `terminateProcessGroup()` 공용, fatal downstream(timeout/cap/malformed/id-mismatch/조기종료) 즉시 그룹 종료+안전 오류 후 finalize, 정책 거부는 downstream 유지. P1: negotiated protocolVersion 사용·상태 머신·notification 무응답·id string/number 구분·buffer/queue 상한·constructor 실패 cleanup·`cleanup_failed` 표면화(cleanupOk:false≠성공). 테스트 13→21(bare·순서 교정 + executable/lifecycle/id/queue/fatal/signal/cleanup-fail). 검증: exec 75 + core 229 + acceptance 71. **M3c-3b(profile/handoff/result-enforcement 배선)는 계획 검토 후 착수 — 현재 보류. 전체 M3c 미완료.**
- **M3c-2 P0/P1 하드닝(2026-07-22).** P0-1 호출 계획·금지·protocol allowlist를 **non-exported + deep-freeze**, clone getter(`getSemanticsCalls`/`getForbiddenCallTools`/`getAllowedProtocolVersions`)만 노출, 시작 시 독립 contract exact 비교(변조 재현 무력화). P0-2 budget을 text가 아니라 **전체 결과 `resultChars`≤8000**으로(+resultBytes, responseBytes=raw line). P1-3 fs snapshot root type/mode 포함·baseline symlink spawn 전 차단·`O_NOFOLLOW` fstat/read(TOCTOU)·파일별 1MiB/전체 16MiB 상한·MAX_FS_ENTRIES off-by-one 수정. P1-4 모든 실패 경로 kill→bounded close 후 reject·close 전 HOME 미삭제·`cleanup_failed` 표면화. runner는 clone getter·mcp-config 정확·권한·구조적 raw payload 검사·capabilities.tools plain object. 검증: exec 75 + core 208 + acceptance 71.
- **M3c-1 schema probe P0 6건 보완(2026-07-21).** (1) runner `checkComponentsJson` import를 `shadcnPilot.js`로 정정(+offline smoke). (2) `HARNESS_SHADCN_NPX_BIN` 제거 — 항상 `npx --yes shadcn@4.13.1 mcp`(테스트는 PATH의 `npx` fixture). (3) schema **key**가 scrub 대상이면 `secret_in_schema_key` fail-closed(원 key 미노출). (4) protocolVersion `2025-11-25`+revision allowlist, capabilities(.tools)·serverInfo(name/version) 검증, description optional·title 수집·inputSchema/outputSchema root `type:"object"` 강제·annotations untrusted hint(권한 근거 아님). (5) raw Buffer byte 상한+StringDecoder, 수집 후 child close bounded wait(미종료 `child_did_not_close`). (6) 결과 `operationSummary{initialize,initialized,toolsListPages,toolCalls:0}`·raw payload 미저장. 검증: exec 75 + core 192 + acceptance 71.
- **M3c-0 discovery scaffold + offline hardening(2026-07-21).** P0/P1 하드닝: 표준 registry 검사를 `runShadcnDiscovery` 핵심 API가 config/spawn 이전에 강제(`registry_<code>`, 부작용 0), discovery package 우회 인자 제거(항상 `shadcn@4.13.1`), 빈 도구 `no_tools` 거부(1~64), 전 경로 typed 오류 code 보존+message scrub·성공 snapshot scrub(반환==저장)·`redactNames`(child 미전달), components.json `O_NOFOLLOW` fstat/read(TOCTOU), stdout 1MiB/stderr 64KiB 상한, 강제 env testEnv 우회 불가, snapshot persist wx 충돌 typed·부분성공 미반환, runner `claude --version`·config/권한/snapshot/canary/sentinel 검사. (이하 초기 scaffold 설명) `src/tools/shadcnPilot.ts`(+`.test.ts`)·`scripts/m3c-live-discovery.mjs` 신규. shadcn 파일럿 정책(`shadcn@4.13.1` pin, `npx --yes shadcn@4.13.1 mcp`, server=shadcn), 표준 registry 검사(`checkComponentsJson` — custom/private/malformed/symlink/oversized/non-regular fail-closed), **runPreflight와 분리된** `runShadcnDiscovery`(단일 shadcn strict config + headless `claude -p` system/init 도구명 수집, foreign/duplicate/empty/too-long/too-many/no-init/non-zero/timeout 거부, ≤64도구·≤256B·≤64KiB, raw init 미저장, 오류 redaction). 산출물 `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false, `ShadcnDiscoveryResult{discovery:true}`)로 `PreflightSuccess`와 타입 분리 → preflight/handoff 승인 근거 불가. **registry/tool_profiles.json 미등록·handoff 미연결·실제 Claude/npx 미실행.** live discovery는 수동 `HARNESS_LIVE_M3C_DISCOVERY=1` runner(npm test/CI 비대상). **shadcn 실제 도구명(browse/search/install/add 등)은 여전히 `미확인` — 사람이 runner 실행 후 확정 → profile 등록·handoff 연결이 후속.**

---

## 6. M3에서 하지 않을 것

- Tavily / Research Query Plan / Research Adapter (M4)
- production deploy / live billing / remote repository write / PR merge (hard deny)
- shadcn install 자동 승인
- Anthropic Provider MCP parity (M7)
- 범용 MCP client 직접 구현

---

## 7. 위험과 미해결 사항

- **M2 정책 ↔ 실제 Claude Code CLI 동작 차이 가능성**: compile이 산출하는 `--tools`/`--allowedTools`/
  `--disallowedTools`/`--permission-mode`/`--strict-mcp-config`/`--mcp-config` 플래그가 현재 claude 버전에서
  기대대로 동작하는지 **미확인**(이 저장소에서 실제 claude 미실행). M3a preflight로 실측 필요.
- **`--bare` 실제 snapshot 검증 미완료**: argv 생성·검증만 완료. 격리 효과는 미검증.
- **strict MCP config의 claude 버전별 동작**: 플래그 무시(#10787)·`disabledMcpServers` 미차단(#14490) 이슈가
  보고된 바 있음(설계 문서 §2.4). "플래그 존재=격리"로 신뢰 금지 — snapshot 실측으로만 판정. 현재 버전 동작 `미확인`.
- **Hook payload 민감 정보 redaction**: **적용됨(M3b.1)** — collector가 민감 key 재귀 마스킹 + secretRefs 실제 값 + credential 패턴을 ToolTrace JSONL에 적용. (실 Claude Hook 배선·이름 대응은 M3b.2 실측 대상.)
- **shadcn 실제 도구명**: 2026-07-21 discovery로 확인(Claude Code 2.1.216 · shadcn@4.13.1) — 7개: `get_add_command_for_items`/`get_audit_checklist`/`get_item_examples_from_registries`/`get_project_registries`/`list_items_in_registries`/`search_items_in_registries`/`view_items_in_registries`(모두 `mcp__shadcn__` prefix). read/write 권한 성격은 `미확정` — M3c-1 `tools/list` schema·semantics 실측 필요(이름=권한 금지). 도구 셋은 버전 종속.
- **README 문서 불일치**: `README.md`에 v1/v2.6 범위 서술 잔재(예: "현재 진행 중인 개발 항목 없음",
  삭제된 `V3_KICKOFF.md` 참조). M0~M2에서 손대지 않음 — 후속 정리 항목.
- **package 배포 파일 후속 검증**: 현재 npm pack에 dist/tools·registry/tool_profiles.json·schemas 포함 확인.
  handoff/preflight 런타임 생성물은 `projects/*/outputs/runtime/`·`projects/*/outputs/tool-trace/`에 두며 **이미 `.gitignore`에 등재됨**(커밋·배포 제외 확인 완료 — 과거 "gitignore 미포함" 문구는 정정).

---

## 8. Codex 첫 작업 (파일 수정 전)

1. M0~M2 완료 사실을 **코드·git으로 재검증**(커밋 582f6e0/5cbdbcb/b359bfc, `npm test` 통과).
2. M2 구현이 활성 설계 문서(위 §2)와 일치하는지 검토.
3. M3 범위를 **M3a/M3b/M3c로 분리**.
4. **실제 Claude Code 현재 버전과 CLI 지원 플래그 확인**(stream-json/system/init/strict-mcp-config/tools/
   permission-mode, Hook 이벤트명·payload).
5. 상세 M3 구현 계획과 acceptance만 제시.
6. **사용자 승인 전 코드·패키지·설정 수정 금지.**

---

## 부록 — 검증된 사실 요약

- 브랜치 `develop`, 작업 트리 CLEAN, package.json `2.6.0`.
- 커밋: M0 `582f6e0` / M1 `5cbdbcb` / M2 `b359bfc`.
- 명령: build=`npm run build`, 테스트=`npm test`(=`test:exec` 75 + `test:core` 157 + `acceptance` 71),
  `test:core`는 `HARNESS_WORKSPACE=.tmp-test-workspace tsx --test src/core/*.test.ts src/tools/*.test.ts
  src/providers/*.test.ts src/commands/*.test.ts`.
- npm pack: 76 files. 포함=dist/·agents/·registry/·schemas/·README.md. 제외=tests/·src/·*.test.*.
