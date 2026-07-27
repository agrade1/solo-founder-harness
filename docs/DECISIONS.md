# DECISIONS.md

## 2026-07-27 (V3 M5a 리비전 — fresh Codex 리뷰 REVISE 반영)

- **실행 대상은 env가 고르지 않는다.** `HARNESS_CODEX_BIN`/PATH 조회를 없애고 신뢰된 절대경로를 **필수 입력**으로
  바꿨다. 상속 환경이 실행 파일을 고르는 순간 승인 경계 전체가 무의미해진다. 대가: controller가 경로를
  알아야 한다(그 책임을 문서에 명시). 자식 env도 `CODEX_HOME` 하나로 좁혔다 — PATH를 물려주면 codex가
  띄우는 하위 명령의 해석까지 상속 환경에 맡기게 된다. 이 선택은 **live에서 인증·PATH 필요 여부를 사람이
  결정하게 만드는 fail-closed 기본값**이다(`B-7`).
- **M5a Codex는 read-only 전용이다.** `workspace-write`를 spec 한 줄로 열 수 있으면 manifest의 task 소유권·
  writableRoots를 아무도 집행하지 않는 쓰기가 생긴다. 집행 계층이 생기기 전에는 **기능을 제거**한다 —
  플래그를 두고 "쓰지 말자"로 두지 않는다.
- **"성공 뒤 실패"는 실패다(비가역 프로토콜 실패).** 종료 이벤트를 먼저 봤다는 이유로 그 뒤의 error·MCP·
  중복 종료·오염된 줄을 무시하면, 가장 위험한 스트림이 가장 조용히 통과한다. 첫 실패가 이기고 어떤 이벤트도
  그것을 되돌리지 못한다.
- **세션 신원은 형식으로 증명한다.** codex가 준 텍스트를 그대로 `resume` 인자로 쓰면 CLI 인자 표면이
  스트림 내용에 노출된다. 정규 UUID 정확히 1개만 인정하고 나머지는 전부 프로토콜 실패로 닫았다.
- **`raw`는 원본이 아니라 projection이다.** 소비자(오케스트레이터·로그·전달)가 이벤트를 통째로 직렬화하는 것은
  정상적인 사용이다. 그러면 원본 payload를 들고 다니는 순간 durable 위생 계약은 소비자 규율에 의존하게 된다.
  타입 계층에서 아예 못 담게 만들었다.
- **fake CLI 채널을 env가 아니라 cwd로 옮겼다.** `CODEX_HOME`이 비어 있어야 한다는 새 계약과 "env 테스트 seam
  금지" 규칙을 동시에 지키는 방법이다. 테스트가 소유한 임시 checkout이라 production 경로에서는 도달할 수 없다.
- **범위를 넓히지 않았다.** `reviewer.ts`의 결과 게이트 결함(P1/B)은 controller 통합 문제라 M5a에서 고치지 않고
  **기한 있는 대장 항목(`B-8`, M5b reviewer 배선 전)** 으로 남겼다. 리뷰 지적을 조용히 흡수하지도, M5a를
  controller 작업으로 부풀리지도 않는다.

## 2026-07-27 (V3 M5a — 실행 경계 · Codex provider)

- **실행 경계는 provider마다 복제하지 않고 함수 하나로 뒀다**(`verifyExecutionBoundary`).
  provider별로 HEAD 대조를 복사하면 새 provider·controller 경로가 조용히 우회한다. 앞으로 프로세스를
  띄우는 모든 경로가 같은 함수를 지나야 하며, 이 결정이 `B-5`를 닫는 실제 이유다.
- **경계는 checkout "루트 신원"까지 본다.** realpath로 정규화한 경로가 `git rev-parse --show-toplevel`의
  realpath와 같아야 통과한다. 그렇지 않으면 검사 대상(하위 디렉터리·symlink)과 실행 대상이 다른 저장소일 수 있다.
- **실행 경계의 만료 판정은 kernel보다 좁다**(`now >= expiresAt`이면 거부). 대장 `C-17`이 지적한
  경계 1회 통과를 **실행 경로에서는** 지금 닫는다 — kernel의 상태 전이 계약(`>`)은 이번 범위가 아니라 건드리지 않았다.
- **종료 결과는 stream 이벤트가 아니라 `finish()`가 만든다.** `turn.completed`를 보자마자 result를 내면
  그 뒤의 비정상 exit·signal을 성공에 덧붙일 방법이 없다. outcome을 기록해 두고 exit까지 합쳐 **정확히 1건**을
  내면 "조용한 성공"이 구조적으로 불가능해진다(대신 result는 프로세스 종료 시점에 온다 — 진행 가시성은
  init/status/assistant 이벤트가 담당한다).
- **strict empty MCP를 ambient 설정에 기대지 않는다.** 격리 `CODEX_HOME`을 **필수 입력**으로 만들고
  자식 env를 `PATH`/`CODEX_HOME` 둘로 좁혔다(사용자 `HOME` 미상속).
  **(2026-07-27 리비전에서 `CODEX_HOME` 하나로 더 좁혔고 홈 자체를 검증한다 — 위 리비전 블록이 현행이다.)**
  대가: 그 홈에는 자격증명이 없으므로
  **live 실행은 인증 방식을 따로 결정해야 한다** — auth 파일 복사·영속화는 하지 않기로 했으므로 이 결정은
  M5b에서 사람이 내린다(대장 `B-7`).
- **resume은 `codex exec resume <session-id>`만.** `--last`는 "마지막 세션"이 다른 프로세스의 것일 수 있어
  자동화에서 소유권을 증명하지 못한다. session id를 관측하지 못했으면 그냥 거부한다.
- **`SessionEvent`를 늘리지 않았다.** codex 이벤트는 기존 kind(init/status/assistant/unknown/result)로
  충분히 표현된다. provider 중립 타입에 vendor 전용 변형을 넣으면 모든 소비자가 그 변형을 알아야 한다.
  추가한 것은 `SessionSpec.codex?` 하나뿐이다.

## 2026-07-27 (M4 문서 정합성 — docs-only)

- **`manifest.approvedCommit`을 실행 checkout HEAD에 묶는 것은 M5 실행 경계의 진입 조건으로 못박았다**
  (대장 `B-5`, P1). 지금 고치지 않은 이유는 M4가 state-only이고 아무 프로세스도 띄우지 않아서다.
  대신 기한을 "M5 provider/autopilot이 실제 명령을 처음 실행하기 전"으로 고정했다 — 그 시점에
  `approvedCommit ≠ 실행 worktree/컨트롤러 HEAD`면 **fail closed**여야 한다. 유예 비용이 큰 항목
  (잘못된 base에서 나온 worker 산출물 전량 폐기 + 실행 경계 재개방)이므로 C가 아니라 **B**로 뒀다.
- **과거 세션 기록은 고쳐 쓰지 않고 "그 시점 기록"으로 표시한다.** M4a/M4b/M4c 본문의
  "미커밋 working tree"는 실제로 그때 사실이었다. 원문을 사후 사실로 덮어쓰면 세션 로그가
  감사 자료로서 쓸모가 없어진다. 현행 사실은 현행 상태 블록에만 둔다.
- **테스트 수치는 "명령 + 범위"와 함께만 적는다.** 파일 단독 focused(67)와 exec suite(142)를 같은
  "focused"라는 말로 적어 온 것이 이번 불일치의 원인이었다. 앞으로 카운트는 실행한 명령을 붙여 적는다.

## 2026-07-27 (V3 M4c — 중앙 경유 라우팅 · 메시지 10종 · milestone approval manifest · specialist registry)

- **route는 envelope가 아니라 중앙 state에 둔다.** 전달 대상을 envelope 필드로 만들면 agent가 자기
  메시지에 "누구에게 보낼지"를 적는 셈이고, 그러면 검증은 사후 필터가 된다. §5.1 필드 집합을 그대로 두고
  **message index의 `routeToTaskId`/`acknowledgedAt`** 에 중앙이 결정한 route만 남겼다. 발신 agent의
  `recipient`는 sibling 전달에서도 **언제나 `orchestrator`** 다 — 계약상 "직접 mailbox 쓰기"가 표현
  불가능하다.
- **타입마다 좁은 진입점 하나. 범용 `route(message)`는 만들지 않았다.** 6종의 검증 규칙이 서로 다르고
  (fresh reviewer · 선행 review_result · 미응답 decision_request · sibling 관계), 하나의 범용 API로
  합치면 호출자가 규칙을 고르게 된다. 공통 골격(`#acceptRouted`)만 private으로 한 번 쓰고 규칙은
  진입점에 남겼다.
- **sibling 관계는 "같은 parent 또는 직접 의존"으로 좁혔다.** 조상·후손 전체나 같은 run 전체를 허용하면
  사실상 무제한 전달이다. 좁은 규칙은 나중에 넓히기 쉽지만 넓은 규칙은 되돌리기 어렵다.
  수신자 해석도 **taskId 또는 유일한 roleId**만 인정하고 중복 roleId는 `ambiguous_recipient`로 거부한다 —
  중앙이 "누구에게"를 추측하지 않는다.
- **reviewer/review_result/decision_request는 task 상태를 바꾸지 않는다.** 상태 전이는 이미
  `result`/`blocker`가 담당한다. 검토 왕복마다 새 상태를 만들면 6개 상태 기계가 10개로 늘고 재계산
  fixpoint가 복잡해진다. reviewer도 평소처럼 `result`로 완료한다 — **"라우팅은 전달이지 전이가 아니다."**
- **manifest는 run 생성 시 필수 인자다(기본값 없음).** 기본 manifest를 두면 그것이 곧 조용한 자동 승인이고,
  "승인 없이 만들어진 run"이 나중에 승인된 run과 구분되지 않는다. 대가로 기존 M4a/M4b acceptance
  스크립트와 테스트 헬퍼에 manifest 인자를 더해야 했지만, **기존 단정은 하나도 바꾸지 않았다.**
- **manifest 권한 검사도 커밋 경로 공용 불변식에 넣었다**(M4b 교훈 그대로). ownership 승인·writable root·
  child 위임·`maxSessions`를 메서드마다 검사하지 않고 `assertReferentialIntegrity` 안에 한 번만 뒀다 →
  `createRootTask`·`requestSpawn`·`startTask`·`startScheduledBatch`·load가 **같은 문**을 지난다.
  mutation 4종으로 이 문이 실제 게이트임을 확인했다.
- **실행 권한은 "조회만" 한다.** `allowedCommands`는 **문자열 동치**로만 판정한다. shell을 파싱하면
  "승인된 명령처럼 보이는 것"을 판정하게 되고 그 판정은 이 계층의 권한이 아니다(대장 `C-14`).
  같은 이유로 dependency는 **정확히 pin된 버전만**, 도메인은 **하위 도메인 자동 허용 없이** 통과시킨다.
  `localMergeAllowed`는 기록·조회 전용이며 kernel은 git을 만지지 않는다 — repo hard deny가 항상 더 강하다.
- **pre-M4c state는 마이그레이션하지 않고 코드 하나로 거부한다**(`state_pre_m4c_unsupported`).
  M4b의 `state_pre_m4b_unsupported`와 같은 판단이다: 기본 manifest로 채우면 조용한 자동 승인이 되고,
  digest도 어차피 어긋나 원인이 불분명한 실패가 된다. 마이그레이션 프레임워크는 여전히 만들지 않았다(`C-9`).
- **7 specialist registry는 "장식"이 아니라 게이트로 만들었다.** roleId가 registry 밖이면 task를 만들 수
  없다(`unknown_role`) — 그래야 registry가 "중앙이 정한 metadata"라는 말이 실제 계약이 된다.
  하위 role은 `<상위>.<하위>` **한 겹**만 허용해 임의 계층 명명을 막았다. 대신 run별 registry 축소·확대는
  넣지 않았다(`C-15`) — 지금 필요 없는 유연성이다.
- **registry를 run state에 복제하지 않았다.** 7개짜리 코드 상수를 state 필드로 또 저장하면 drift 지점만
  늘어난다. durable·재시작 안정성은 ⓐ 모든 task의 roleId가 **load에서도** registry 검사를 받고
  ⓑ snapshot(파생 durable 파일)이 registry를 렌더한다는 두 가지로 확보했고, acceptance가 재시작 후
  바이트 동일까지 확인한다.

## 2026-07-27 (V3 M4b — 배타 자원 class · deterministic scheduler · run writer lock)

- **자원 점유는 `running` 동안만이고 `waiting_children`은 들고 있지 않는다.** 중단된 parent가 자원을
  계속 점유하면 child가 도는 내내 같은 class의 다른 task가 전부 막히고, child가 그 자원을 필요로 하면
  **자기 parent와 교착**한다. "점유 = 실행 중"이라는 한 줄 규칙이 교착 회피 로직보다 싸고 검증하기 쉽다.
  대가는 명시적이다: parent가 `waiting_children` 동안 남이 그 class를 잡을 수 있으므로 parent가
  다시 ready가 되어도 즉시 시작되지 않을 수 있다(결정론은 유지). 그 대가를 로드맵·타입 주석에 적었다.
- **충돌 규칙은 메서드마다 두지 않고 커밋 경로의 공용 불변식 하나로 뒀다.** 처음엔 `startTask` 안에
  사전 검사를 넣었는데 mutation으로 지워도 **아무 테스트도 실패하지 않았다** — `assertReferentialIntegrity`
  안의 `assertExclusiveResourceClaims`가 이미 같은 판정을 내리고 있었기 때문이다. 중복 검사는 "우회 불가"를
  증명하지 못하면서 두 곳이 갈라질 위험만 만든다. 그래서 중복을 **삭제**하고 불변식 하나만 남겼다:
  모든 전이 경로와 load가 같은 문을 지난다. **한 곳에 두는 것이 방어를 줄이는 게 아니라 우회로를 줄인다.**
- **scheduler는 새 오케스트레이터가 아니라 kernel 메서드 2개다.** 별도 scheduler 모듈·queue·priority·
  fairness·retry는 지금 필요 없다(실제 동시 실행이 아직 없다). 대신 좁은 계약만 고정했다:
  결정론(`taskId` 오름차순 greedy) · batch 내부 충돌 없음 · batch는 커밋 1회 · 상한 1..8.
  starvation·priority는 **실측된 뒤에** 정책으로 얹는다(대장 `C-10`).
- **자원 선언은 중앙이 하고 agent envelope는 건드리지 않았다.** agent가 envelope로 자기 자원 class를
  선언할 수 있으면 그것은 자기 실행 권한을 스스로 넓히는 경로다. §5.1 envelope 필드 집합을 유지하고
  선언을 task 생성 입력에만 뒀다. class 이름을 자유 문자열이 아니라 **slug**로 좁힌 이유도 같다 —
  정규화되지 않은 두 이름이 같은 자원을 뜻하면 직렬화 계약이 조용히 깨진다.
- **writer lock은 기존 suite lock을 재사용하지 않고 최소 primitive를 새로 썼다.**
  `suite-exclusive-lock.mjs`는 검증된 계약이지만 suite 전용 의미(ownership token 부모→자식 상속,
  pgid 자손 스캔, 격리/quarantine, guard 상태 기계)를 함께 들고 온다. 그것을 orchestration 커밋 경로에
  끌어오면 **orchestration이 suite 실행 모델에 결합**되고 실패 모드가 두 배가 된다. 필요한 계약은
  "같은 run에 동시 커밋 금지 + 자기 lock만 정리"뿐이라 `O_CREAT|O_EXCL` + nonce로 충분했다.
  대신 **못 하는 것을 명시**했다: stale 회수·소유자 생존 확인·크래시 복구 없음(대장 `C-4` 보강/`C-8`).
- **lock만으로는 lost update를 막지 못하므로 base 대조를 함께 넣었다.** 두 프로세스가 시간차로
  lock을 잡으면 각자 "혼자"라고 믿고 순차적으로 쓴다 — 늦은 쪽이 앞선 revision을 덮는다.
  그래서 lock 안에서 디스크의 `revision`/`lastEventId`/`lastEventHash`를 호출자 기준과 대조하고
  다르면 `stale_writer`로 거부한다. **`CommitInput.base`는 optional로 두지 않았다**: 기본값이 있으면
  새 호출부가 아무 경고 없이 보호 밖으로 나간다. 필수 필드는 컴파일 시점에 그 사실을 강제한다.
- **M4a state는 마이그레이션하지 않고 거부한다(`state_pre_m4b_unsupported`).** 세 선택지를 놓고
  판단했다. ⓐ 없는 필드를 `[]`로 채우기 → 그 state의 `stateDigest`가 어차피 어긋나 **원인이 불분명한
  실패**가 되고, 선언 없는 task를 "병렬 안전"으로 오해할 여지가 남는다. ⓑ `schemaVersion` 올리기 →
  그 상수는 메시지 envelope와 **공용**이라 M4a 계약과 acceptance Test 13까지 흔든다.
  ⓒ 전용 코드로 fail-closed → 모호함 0, 마이그레이션 프레임워크 0, 조용한 수락 0. ⓒ를 택했다.
  현재 실 운영 run이 없어(offline 테스트 run뿐) 유예 비용이 낮다는 점도 근거다(대장 `C-9`).
  **M4a와 M4b는 분리된 stacked PR이므로 이 규칙을 문서에 명시**한다 — M4a만 병합된 상태의 run을
  M4b 코드가 조용히 읽는 일이 없어야 한다.
- **M4 전체를 완료로 적지 않는다.** `B-3`/`B-4`는 테스트가 증명했으므로 fixed로 적었지만
  sibling/reviewer 라우팅과 approval manifest는 그대로 열려 있다(M4c). 닫힌 항목만 닫혔다고 적는 것이
  이 대장의 유일한 유지 조건이다.

## 2026-07-27 (V3 M4a — Codex P0 2건 수정: state↔event binding · 완료된 M3 재개방 금지)

- **"형태가 유효한 state"는 신뢰의 근거가 못 된다 — 내용을 append-only 이력에 묶었다.** 기존 load는
  schema·참조·event 체인을 봤지만 그 셋 다 통과하는 `run_state.json` 편집(예: `state="completed"`)을
  막지 못했다. 검증기를 더 촘촘히 해도 소용없는 종류의 구멍이다 — **누가 그 내용을 만들었는지**를
  묻지 않았기 때문이다. 그래서 "state가 kernel 커밋의 산물인가"를 직접 검사하도록 바꿨다.
- **digest는 event에 넣고 chain 필드는 digest에서 뺐다 — 순환을 구조로 없앴다.** state가 event chain
  hash를 담는데 event가 state 전체 해시를 담으면 순환한다. state 내용에서 `lastEventId`/`lastEventHash`
  **두 개만** 제외하면 방향이 한 줄로 정리된다: state 내용 → event digest → chain hash →
  state.lastEventHash. 별도 sidecar 파일이나 두 번째 해시 파일 같은 대안은 파일과 실패 모드를
  하나씩 더 늘릴 뿐이라 택하지 않았다.
- **커밋의 마지막 이벤트에만 digest를 붙인다.** 모든 이벤트에 붙이면 "커밋 경계"라는 정보가 사라지고,
  중간 이벤트의 digest는 디스크에 대응하는 state가 없어 검증할 수도 없다. 대신 커밋마다 이벤트가
  최소 1건 있어야 하므로 빈 이벤트 커밋을 명시적으로 거부한다(조용히 binding을 건너뛰는 경로 제거).
- **키 없는 digest의 한계를 문서에 적고 유예했다.** 두 파일을 모두 일관되게 재작성하는 위조는 이 설계로
  못 막는다. 그 사실을 "막는다"고 쓰지 않고 `assertStateEventBinding` 주석과 상태 문서 양쪽에 적었으며,
  상향 경로(out-of-band 키 HMAC/서명)를 대장 `C-7`로 남겼다. **막지 못하는 것을 막았다고 적는 것**이
  이 수정으로 없애려던 바로 그 종류의 실패다.
- **완료된 M3를 문서가 재개방하고 있었던 것은 "보수적이라 안전한" 실수가 아니다.** 이전 세션이
  `B-1`/`B-2`를 "M3d 완료 게이트 · 사용자 액션 대기"로 옮겨 적으면서, 이미 실제 live acceptance까지
  끝나고 PR #10(`ea764a5`)으로 병합된 M3를 미완료로 되돌렸다. 다음 세션이 이걸 읽으면 닫힌 게이트를
  다시 열고 M4를 막는다 — **상태 문서의 오류는 그대로 작업 차단으로 번역된다.**
  그래서 둘을 **nonblocking release-readiness backlog 트리거**로 재분류하고, 로드맵에 `§0-0 현행 상태`
  블록을 만들어 우선순위를 명시했다.
- **정정 범위는 "현행 섹션"으로 한정했다.** 과거 dated 항목은 그 시점의 사실 기록이므로 원 문장을 고쳐
  쓰지 않고, 대신 `§1`·`§10 M3d` 머리에 "이 절은 2026-07-26 스냅샷이며 §0-0이 우선한다"를 붙였다.
  이력을 소급 수정하면 "언제 무엇을 알고 있었는지"가 사라져 다음 리뷰가 같은 논쟁을 반복한다.
- **P0만 고치고 M4a를 넓히지 않았다.** exclusive resource class·scheduler·writer lock은 여전히
  P1이고 이번에 손대지 않았다. P0 수정 세션에서 범위를 넓히면 그 diff에 대한 독립 검수가 다시 필요해진다.

## 2026-07-27 (V3 M4a — durable orchestration kernel의 설계 결정)

M4a 범위 한정 승인을 받아 격리 worktree `work/m4a-durable-orchestration`(base `ea764a5`)에서
구현하며 내린 결정이다. **M4a 최소 수직 기능은 완료이고 M4 전체는 미완료**라는 구분을 문서 전반에서 유지한다.

- **기존 실행 계층을 복제하지 않고 그 안에 별개 계약을 추가했다.** `runWorkflow`의
  `projects/<p>/outputs/run_state.json`은 project workflow 실행 상태이고, 새 kernel의
  `outputs/orchestration/<run-id>/run_state.json`은 self-dev/mission 실행 상태다(로드맵 §4가 이미
  둘을 분리해 적어 뒀다). 하나로 합치면 v1 acceptance 계약과 V3 오케스트레이션 계약이 같은 파일에서
  충돌하므로, 기존 파일·schema·마이그레이션을 **건드리지 않는 쪽**을 택했다. `ExecutionProvider`도
  복사하지 않았다 — M4a는 provider를 실행하지 않으므로 provider 추상화가 필요 없다.
- **검증 → 커밋 2단계로 "전이 0"을 구조로 보장했다.** 유효성 검사를 커밋 경로 밖에서 끝내고, 통과한
  경우에만 message body → events append → snapshot → state rename 순으로 쓴다. "쓰다가 실패하면
  되돌린다"는 보상 로직 대신 **애초에 쓰기 전에 던지는** 구조라 rollback 코드가 없다.
  대신 커밋 중간 크래시는 fail-closed로 남으므로(다음 load가 `event_count_mismatch`로 거부) 복구
  도구가 필요하다 — 이건 `C-4`로 유예했다(M4a는 crash hardening 범위가 아니다).
- **JSON Schema는 계약 문서, 런타임 수동 validator가 보안 경계다.** Ajv 같은 신규 검증 의존성을
  넣지 않는 기존 `liveEvidence.ts` 방식을 그대로 이어받았다. 두 정의가 갈라지는 것이 진짜 위험이므로
  enum·required·bounds 동치를 테스트가 강제한다(문서 주장 대신 실행되는 단정).
- **메시지 타입을 4종으로 좁힌 것은 축소가 아니라 fail-closed 선택이다.** §5.1은 10종을 정의하지만
  M4a는 4종만 처리한다. 나머지를 "일단 통과시키고 나중에 처리"하면 미구현 경로가 조용히 열린다.
  그래서 schema enum과 런타임 모두 **거부**하고, 확장은 해당 마일스톤에서 열도록 했다.
- **ownership을 권한이 아니라 메타데이터로 못 박았다.** 경로를 정규화하고 탈출을 거부하지만, M4a에는
  이 값을 강제하는 실행 주체가 없다. "권한처럼 보이는 미집행 필드"는 나중에 실제 권한으로 오해되기 쉬워서
  타입 주석·schema description·로드맵·WORKLOG 네 곳에 같은 문장으로 적었다.
- **artifact는 등록과 제출을 분리했다.** `registerArtifact`로 해시를 확정한 뒤 `submitResult`에서
  **다시** 디스크를 검증한다. 한 번에 처리하면 "등록 시점 해시"와 "수락 시점 파일"이 같다는 보장이 없고,
  등록 후 변조라는 실제 공격 경로를 테스트로 재현할 수도 없다. 분리 덕에 tamper 케이스가 회귀로 남았다.
- **spawn 상한을 넘긴 parent도 `waiting_children`에서 child를 더 요청할 수 있게 했다.** 첫 spawn 직후
  parent를 `waiting_children`으로 보내면서 `running`만 허용하면 "task당 child 4개" 상한이 실질적으로
  1개가 된다. 계약(child 4개)이 상태 기계보다 우선이므로 허용 상태를 둘로 넓혔다.
- **snapshot은 이벤트를 만들지 않는다.** 재시작 후 `rebuildSnapshot()`이 revision을 올리면
  "재시작 후 동일 revision" 계약이 깨진다. snapshot은 로드맵 §4대로 **파생물**이므로 state·events를
  건드리지 않고 파일만 다시 쓴다.
- **create 경로와 open 경로의 직렬화 바이트를 일치시켰다.** 검증 중 `artifactRecord`의 key 순서가
  두 경로에서 달라 같은 논리 상태가 다른 바이트로 저장되는 것을 발견했다. 결정성이 M4a의 명시 요건이므로
  validator의 반환 key 순서를 고정하고 `JSON.stringify` 동일성 단정을 회귀로 추가했다.
- **P0 없이 완료로 적되, 미구현을 완료로 적지 않는다.** exclusive resource class·scheduler·
  멀티프로세스 writer lock은 M4 완료 항목이지만 M4a 범위가 아니므로 `B-3`/`B-4`로 기한과 함께 남겼다.
  provider bridge·7 agent 실행·full scheduler를 "완료"로 쓰지 않는다는 규칙을 문서 전반에 적용했다.

## 2026-07-26 (배송 우선 리뷰 triage · 유예 무손실 대장 · 테스트 비례 · 안전 병렬 Claude 세션 — 문서 전용)

여덟 번째 리비전 재검토 결과(`APPROVE_FEATURE_PROGRESSION` · Category A 0건 · Category C 1건)를 기록하면서
사용자가 승인한 작업 방식 정책을 확정했다. **코드·schema·의존성은 건드리지 않았다.**

- **기능 배송이 무한 디테일 하드닝보다 우선한다 — 그래서 finding을 분류 없이 두지 않는다.** 리비전 루프가
  여덟 번 돈 실제 이유는 "발견된 모든 것이 암묵적으로 차단 취급"됐기 때문이다. 이제 모든 finding은
  **A(지금 차단) / B(지정 마일스톤·트리거 전 필수) / C(개선 backlog)** 중 하나로 분류하고,
  **C만으로는 리비전 루프를 다시 돌리거나 기능 진행을 멈추지 않는다.** "리뷰가 뭔가를 찾았으니 또 한 바퀴"는
  기본 동작이 아니다. 반대로 A의 정의는 좁히지 않았다 — P0/P1, 데이터 손실, 승인/인증/상태 전이 우회,
  되돌리기 어려운 아키텍처, **유예 비용이 커서 후속 작업이 안전하지 않거나 폐기 대상이 되는 것**은 그대로 차단이다.
- **우선순위는 심각도 단독이 아니라 "유예 비용 대 수정 공수"로 매긴다.** 심각도 라벨만 보면 확률이 극히 낮고
  영향 반경이 좁은 항목이 실제 배송을 계속 막는다. 반대로 라벨이 낮아도 지금 안 고치면 후속 산출물을 통째로
  다시 만들어야 하는 항목이 있다. 판단 기준을 **비용 축**으로 옮긴 이유다.
- **유예는 하되 조용히 버리지 않는다.** 분류만 하고 잊으면 "배송 우선"이 곧 "위험 은폐"가 된다. 그래서 유예 항목은
  심각도·확률·영향 반경·유예/rework 비용·수정 공수·기한/트리거·담당·증거 참조·상태를 전부 유지하는 대장
  (로드맵 §9.1)에 남기고, **B는 명시적 기한이 있을 때만** 유예를 허용한다. 기존 M3d 차단 게이트 2건도 같은
  대장에 `B-1`/`B-2`로 적었다 — **형식만 바뀌었을 뿐 여전히 차단**이다.
- **이번 Category C를 실제로 유예했다(정책의 첫 적용).** bounded computed dynamic specifier가 런타임 합성
  route를 놓칠 수 있다는 지적은 사실이지만, 현재 production 호출부 5개는 영향이 없고 확률이 낮으며 영향 반경이
  "미래 소스 레벨 감사 누락"으로 한정되고 유예 비용이 낮다 → `C-1`로 등록하고 아홉 번째 리비전을 열지 않았다.
  **다만 같은 지적 중 "문서가 사실보다 강하게 적혀 있다"는 부분은 즉시 고쳤다** — 유예해도 되는 것은 *구현 범위*
  이지 *부정확한 주장*이 아니기 때문이다. `safe` 분기가 존재하는 이상 "조용히 통과하는 경로는 없다"고 쓸 수 없다.
  bounded 규칙 서술과 positive 대조군(정상 dist import 3파일이 호출부로 잡히지 않음)은 그대로 남겼다.
- **진행 승인과 완료 승인을 어휘로 분리한다.** 이번 verdict는 `APPROVE_FEATURE_PROGRESSION`이며
  **M3d 완료 APPROVE가 아니다.** 둘을 같은 단어로 적으면 다음 세션이 게이트를 닫힌 것으로 오독한다.
  그래서 상태 문서 전반에서 이 판정을 **절대 "M3d APPROVE"로 축약하지 않기로** 했고, 리뷰 이력도
  "REQUEST_CHANGES 8회 + 진행 승인 1회 · **M3d 완료 APPROVE 0회**"로 적는다.
- **테스트는 위험에 비례시킨다 — 단 완화는 아니다.** 매 리비전마다 전체 suite 3회 + stress를 돌리는 것은
  비용만 크고 새 정보를 주지 않았다(일곱·여덟 번째 리비전이 실증). 이제 변경마다 focused, handoff 전 전체 1회,
  반복·stress·live는 마일스톤/하드닝 게이트에서만 돌린다. **변경이 동시성·lock·타이밍·live runner 계약을
  건드리면 예외 없이 즉시 돌린다**, 그리고 **테스트 완화·삭제 금지는 그대로**다.
- **병렬 Claude 세션은 "속도"가 아니라 "격리"가 조건이다.** 여러 Opus 5 세션을 쓰는 이득은 파일 소유권이
  disjoint하고 worktree가 격리됐을 때만 실재한다. 공유 dirty 체크아웃에서 병렬을 돌리면 서로의 미커밋 변경을
  덮어쓰고 검증이 무의미해진다 — 그래서 **직전 리비전들을 단일 세션으로 진행한 것은 옳았다**고 명시 기록한다.
  병렬을 허용하는 경우에도 공유 schema/API 변경·통합/병합·상태 마이그레이션·최종 전체 테스트·배타 자원/stress/
  live 테스트는 **직렬**이고, 동시성 상한은 CPU/부하·메모리·토큰 예산·manifest `maxSessions`로 묶으며,
  이득보다 경합이 크면 **세션 1개로 되돌린다**. 오케스트레이터가 의존성·소유권·artifact hash·상태·완료·결과
  라우팅을 검증하고, 로컬 통합은 직렬, **원격 쓰기는 계속 hard deny**다.
- **M4는 계획 준비와 구현 착수를 분리한다.** "M3d 완료 전 M4 금지"를 문자 그대로 유지하면, 사람이 실행해야 하는
  외부 게이트(조용한 호스트 stress · TTY live runner)를 기다리는 동안 아무 진전도 못 한다. 그래서 **계획 준비는
  지금 허용**하고 **구현 착수는 별도 사용자 마일스톤 승인**으로 남겼다. 승인된 offline/격리 M4 작업이 남은 외부
  M3d 작업과 겹칠 수 있다는 것은 **제안으로만** 적었다 — **미검증 live evidence를 소비하지 않는 범위**에서만
  성립하고, M3d는 그대로 미완료이며 M4도 M3d 게이트 전에는 자기 통합/acceptance를 통과할 수 없다.
  이 중첩을 조용히 발동하거나 승인받았다고 적지 않는다.
- **장기 규칙과 상세 근거의 위치를 분리한다.** `AGENTS.md`/`CLAUDE.md`에는 세션·마일스톤과 무관하게 유효한
  **요약 규칙만** 넣고, 대장 템플릿·항목·판단 근거는 로드맵과 상태 문서에 둔다. 과거 리비전 기록은
  다시 쓰지 않고 "그 시점 기록" 표기로 보존한다(이력 훼손 금지).

## 2026-07-26 (V3 M3d.2 **여덟 번째 리비전** — 지정자는 URL 규칙으로, 동적 route는 bounded fail closed, scope는 보수적으로)

여덟 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES 3건: P2 2 — 감사에 남은 ESM 우회로 · scope 미인식,
P3 1 — 회귀 커버리지 부족 + 문서 과장)를 **테스트·문서로만** 해소하며 내린 결정들이다.
일곱 번째~세 번째 리비전의 계약을 **폐기하지 않고 보강**한다. **production 코드는 건드리지 않았다**
(fixture 로더의 모듈 주석 정정도 이번 범위 밖으로 두었다 — 범위 규율 우선).

- **"모듈 지정자"는 문자열이 아니라 URL이다.** 상대 경로를 문자열로만 비교하면 query·fragment·percent 인코딩이
  전부 우회로가 된다(Node ESM은 file URL을 디코드해 같은 파일로 해석한다). 그래서 감사는 **URL 문법 순서대로**
  자르고 디코드한 뒤 비교한다. 정규식으로 `?`·`#`·`%`를 더 잘 다루는 길은 택하지 않았다 — 같은 종류의 구멍이
  계속 남는다. **디코드할 수 없으면 "로더가 아니다"라고 결론내지 않는다**(판정 불가 = 문제로 보고).
- **동적 route는 "증명"이 아니라 명시적으로 bounded한 규칙으로 판정한다.** `import()` 인자를 정적으로 접을 수 있는
  범위(리터럴 · 치환 없는 template · `+` 연결 · 정확히 한 번 선언된 `const` 문자열)는 접어서 확정하고,
  접히지 않으면 **도달 가능한 문자열 조각**으로 판정한다: 조각이 없으면 fail closed, 조각에 로더 token이 있으면
  로더로 보고, 조각이 있고 token이 없으면 `safe`. **`safe` 분기를 남긴 것은 의도적 트레이드오프**다 —
  live runner 3종의 정상 동적 import(빌드 산출물 로딩)를 깨뜨리면 규칙이 쓸 수 없게 되고, 그러면 사람이 감사를
  끄게 된다. 대신 **whole-program 증명을 주장하지 않는다**고 코드 주석·문서·리뷰 보고에 명시하고, 실제 repo의
  정상 동적 import 3파일이 호출부로 잡히지 않음을 테스트가 대조군으로 고정한다.
- **"재수출"은 형태가 아니라 결과로 본다.** 직접 `export … from`만 막으면 import-then-export로 같은 결과를 만들 수
  있다(그리고 그 경우 예전 감사는 **아무 문제도 보고하지 않았다**). 그래서 수집을 **두 패스**로 나눠
  import/동적 로딩을 전부 모은 뒤 노출을 판정한다 — **소스 순서(ESM hoisting)로 우회할 수 없어야** 하기 때문이다.
  namespace 자체의 export, 별칭 export, default export도 같은 도달 경로로 취급한다.
- **scope는 정확히 계산하는 대신 보수적으로 실패시킨다.** 테스트 감사에 완전한 binder를 재구현하는 것은 비용도
  크고 그 자체가 새 버그 표면이다. 대신 선언 sweep으로 "전역 `process`나 추적 중인 바인딩을 **가릴 수 있는**
  선언이 하나라도 있으면 실패"로 고정했다 — 오탐(가려지지 않은 경우까지 실패)은 사람이 확인하면 되고,
  미탐(가려진 것을 정상으로 인정)은 계약을 조용히 무너뜨린다. 같은 이유로 **shadow된 식별자는 import 사용으로
  인정하지 않는다**(미사용 검사가 무력해지는 것을 막는다).
- **부분 파싱된 소스를 "안전"의 근거로 쓰지 않는다.** 구문 오류가 있으면 AST가 불완전하므로 "import를 못 찾았다"는
  아무것도 증명하지 않는다 → 파싱 진단이 있으면 그 파일을 감사 결과에 남기고 문제로 보고한다.
  (`parseDiagnostics`는 TypeScript 준공개 필드라는 위험을 문서에 남기고, 전용 회귀 2건으로 고정했다.)
- **부하(stress) acceptance 완료 게이트를 "비차단"으로 적지 않는다.** 이전 리비전 기록들이 이 게이트를 잔여
  위험(비차단) 목록에 넣어 적었는데, 그러면 "미충족이지만 넘어갈 수 있는 항목"으로 읽힌다. 게이트는 **차단**이다 —
  해당 줄들에 정정 표기를 달고 이번 리비전 서술에서는 차단 게이트로 분류했다. 동시에 **재실행은 하지 않았다**:
  production 코드를 바꾸지 않은 리비전에서 같은 부하 조건의 재실행은 새 정보를 주지 않으므로 직전 FAIL을 그대로
  미충족으로 남긴다(테스트 완화·낙관적 PASS 주장으로 대체하지 않는다).

## 2026-07-26 (V3 M3d.2 **일곱 번째 리비전** — 호출부 발견은 구문 인식·재귀 감사로)

일곱 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES 1건: P2 — 호출부 발견이 전수가 아님)를 해소하며
내린 결정들이다. 여섯 번째~세 번째 리비전의 계약을 **폐기하지 않고 보강**한다.

- **"스캔으로 발견한다"는 계약은 구문 인식이 아니면 공허하다.** 여섯 번째 리비전은 하드코딩 목록을 스캔으로
  바꾼 것까지는 옳았지만, 문자열 일치 + 한 겹 디렉터리라는 구현이 **중첩 경로 · 공백/주석이 낀 호출 ·
  별칭 import**를 놓쳤다. "새 호출부가 생기면 먼저 깨진다"고 문서에 적어 둔 이상, 그 발견은 **언어 문법 수준**
  이어야 한다고 판단해 TypeScript AST 기반 감사로 바꿨다. 문법을 근사하는 정규식·문자열 규칙을 더 정교하게
  만드는 길은 택하지 않았다(같은 종류의 구멍이 계속 남는다).
- **감사 도구는 테스트 안에만 둔다.** TypeScript는 이미 devDependency이므로 **테스트에서만** import하고
  production 코드·`package.json`·런타임 의존성은 건드리지 않았다. 소스 계약 검사를 위해 production에
  hook·주입 표면을 만드는 선택지는 배제했다.
- **symlink는 production 소스로 세지 않는다.** 감사 대상 열거에서 symlink 파일·디렉터리는 **따라가지 않고
  건너뛰되 목록으로 보고**한다. 따라가면 경로 밖 파일을 "감사한 production 소스"로 세게 되고, 조용히 제외하면
  숨겨진 호출부가 생긴다 — lock 계층의 `O_NOFOLLOW` 결정과 같은 이유(검사 대상과 실제 대상이 같아야 한다)다.
- **비공허성은 합성 소스로 증명하고 production을 훼손하지 않는다.** 우회 3종(중첩·공백/주석·별칭)과 namespace
  경유 호출을 **메모리상의 합성 소스**로 감사에 통과시켜, 발견되고 거부되는지 확인한다. 임시 파일을 만들거나
  production 호출부를 잠시 고치는 방식은 잔재·원복 위험이 있어 피했다(열거 계약만 임시 디렉터리로 확인한다).
- **감사는 "조용한 통과"를 만들지 않는다.** import했지만 호출하지 않는 바인딩, 두 번 이상의 호출, 동적 로딩,
  재수출, 비호출 참조는 전부 문제로 보고한다 — 계약 밖 형태를 "검사 대상 아님"으로 흘려보내면 다시 같은
  우회가 생긴다.
- **부하(stress) acceptance는 이번 세션에서 재실행하지 않는다.** 직전 세션이 같은 호스트에서 두 번 실행해
  두 번 다 같은 원인(외부 부하 + 이번 범위 밖 고정 5초 deadline 2건)으로 FAIL했고, 이번 리비전은 production
  코드를 전혀 바꾸지 않았다. 같은 조건에서 세 번째 실행은 새 정보를 주지 않으므로 **직전 FAIL을 그대로
  미충족(pending)으로 기록**한다 — 테스트 완화나 낙관적 PASS 주장으로 대체하지 않는다.

## 2026-07-26 (V3 M3d.2 **여섯 번째 리비전** — 최종 엔트리 symlink 거부 · 성공 상태는 완결 후 공표 · 호출부 전수 계약)

여섯 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES 6건: P1 1 · P2 1 · P3 1 + 추가 지적)를 구현으로 해소하며
내린 결정들이다. 다섯 번째~세 번째 리비전의 계약을 **폐기하지 않고 보강**한다.

- **신원 검사 대상과 파괴적 조작 대상은 같은 "엔트리"여야 한다 → 읽기 open도 `O_NOFOLLOW`.**
  `openSync(path, "r")`는 symlink를 따라가므로, 검사는 "옮겨진 원본"을 보고 unlink/rename은 "그 자리의 symlink
  엔트리"에 적용될 수 있었다. 우회로를 좁히는 대신 **최종 엔트리가 symlink면 아예 열지 않는다**(ELOOP/EMLINK →
  `lock_path_symlink`). 대상 파일이 정상적인 우리 lock이더라도 인정하지 않는다 — "우리 파일이라는 증거"는
  경로 해석 없는 단일 엔트리에서만 얻는다는 기존 원칙(발행 시 fd `fstat` → `link` → `lstat`)과 같은 규칙이다.
- **`O_NOFOLLOW` 미지원 플랫폼은 lock 전이를 거부한다(fail closed).** fixture 로더가 이미 같은 선택을 했고
  (주입 거부), lock은 그보다 더 중요하므로 "보장할 수 없으면 하지 않는다"를 택했다. 대상 플랫폼
  (macOS/Linux + Node ≥18)에서는 항상 지원되며, 그렇지 않은 환경에서 조용히 약해지는 것보다 멈추는 편이 낫다.
- **성공 상태는 "전이 완결" 뒤에만 공표한다.** 다섯 번째 리비전에서 guard 반납 실패를 오류로 올리기로 했는데,
  `release()`는 여전히 콜백 안에서 `state="released"`를 먼저 세팅해 **오류가 나도 released로 남았다**
  (소비자는 `lockReleased:true`로 보고). 이제 전이 콜백은 **결과만 값으로 돌려주고** 상태 공표는
  `withTransitionGuard`가 정상 반환한 뒤 한 곳(`publishState`)에서만 한다. lock 파일이 사라졌다는 사실만으로
  "해제됨"이라 부르지 않는다 — guard가 남아 있으면 다음 실행을 막아야 하므로 상태는 `failed`가 맞다.
  같은 규칙을 `quarantine()`에도 적용했고, acquire·reentry는 **이미** guard 반납 뒤에 결과를 만들므로
  재감사만 하고 구현을 넓히지 않았다(근거 없는 확장 금지).
- **소비자도 "미완결"을 숨기지 않는다.** wrapper와 stress runner는 `released`도 `quarantined`도 아니면
  `lock 해제가 완결되지 않았습니다(state=…)`를 문제로 남긴다. 상태 문자열은 고정 집합이라 경로·pid·환경이
  새지 않으며, 요약 지표(`lockReleased`)와 사람이 읽는 진단이 서로 어긋나지 않게 한다.
- **소스 계약 회귀는 "발견 + 형태" 두 단계로 만든다.** io seam 회귀가 두 파일만 보고 있었기 때문에 live runner
  3종의 호출부는 검사되지 않았다. 파일 목록을 하드코딩하는 대신 `scripts/**.mjs`를 **스캔해 호출부를 발견**하고
  기대 목록과 비교한 뒤 각 호출의 최상위 인자를 세는 방식을 택했다 — 새 호출부가 생기면 테스트가 먼저 깨져
  사람이 계약을 확인하게 된다. 이 방식은 의존성도, 외부 주입 표면도 늘리지 않는다(정적 소스 검사).
- **부하 acceptance 실패를 테스트 완화로 없애지 않는다.** 이 세션의 stress 실행은 외부 부하가 큰 호스트에서
  **고정 5초 child startup deadline** 두 건(`preflight` M3a canary · `shadcnPilot` M3c-0 discovery) 때문에 FAIL했다.
  그 deadline을 늘리거나 테스트를 건드리는 것은 이번 리뷰 범위 밖이며 production 타임아웃 정책 변경이므로,
  **원인·증거를 기록하고 사용자 판단에 남긴다**(조용한 호스트 재실행 또는 별도 승인 후 부하 내성 개선).
  stress runner 자체는 거짓 PASS 없이 FAIL을 정직하게 보고했고 lock 정리·해제 계약은 정상 동작했다.

## 2026-07-26 (V3 M3d.2 **다섯 번째 리비전** — 파괴 직전 재검증 · 정리 실패도 실패 · 재진입 기준 보존)

다섯 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES 5건)를 구현으로 해소하며 내린 결정들이다.
네 번째·세 번째 리비전의 계약을 **폐기하지 않고 보강**한다.

- **파괴적 syscall은 "직전 재검증"을 반드시 앞세운다.** 확인과 unlink/rename 사이에 동기화 지점이나 임의의
  지연이 끼면 그 사이 교체가 가능하므로, guard 제거는 pause 이후 **record+inode 재확인 → 최종 경로 lstat**,
  격리 rename은 temp 완성 이후 **기본 record+inode 재확인**을 통과해야만 진행한다. Node 18에는
  `unlinkat`·compare-and-unlink가 없어 이 창을 **0으로 만들 수 없다**는 사실을 숨기지 않고 주석·문서에 적었다.
  택한 원칙: **창을 syscall 두 개로 줄이고, 남은 창에서 벌어진 일은 사후에 탐지해 fail closed로 멈춘다.**
  낙관적으로 "우리 것이겠지"라고 지우는 것보다 남의 파일을 보존하고 수동 개입을 요구하는 쪽이 낫다.
- **전이는 "완결"까지 성공이다 — guard 반납 실패는 성공이 아니다.** 이전에는 guard를 반납하지 못해도
  경고만 남기고 handle을 돌려줬는데, 그러면 전이가 완결되지 않은 상태로 suite가 시작된다. 이제 반납 실패는
  `lock_guard_release_failed`(mechanism)로 올려 acquire/reentry 자체를 거부한다. 대가로 그런 경우
  **발행된 lock과 남은 guard가 모두 수동 정리 대상**이 되지만, "겹쳐 실행하지 않는다"가 이 lock의 존재 이유이므로
  가용성보다 배타성을 택했다.
- **정리(cleanup)도 신원 확인 대상이고, 정리 실패는 삼키지 않는다.** 임시 파일조차 열자마자 확보한 (dev,ino)와
  일치할 때만 지운다 — 이름이 추측 불가능하더라도 "우리가 만든 그 inode"라는 증거 없이 unlink하지 않는다.
  신원을 확보하지 못했거나 교체됐거나 unlink가 실패하면 지우지 않고 보고하며, 발행 후라면 mechanism 실패로
  올린다. `.new` 잔재가 남는 것보다 남의 파일을 지우는 것이 더 나쁜 결과라는 판단이다.
- **재진입 이후의 소유권 기준은 tokenHash가 아니라 "재진입 시점에 본 그 파일"이다.** 성공한 재진입은
  기본 record + (dev,ino)를 `base`로 고정해 돌려주고, 이후 cleanup 격리까지 그 기준을 **명시 전달**한다.
  같은 tokenHash를 아는 행위자가 pid/identity가 다른 lock으로 바꿔치우면 격리하지 않고 보존한다.
  즉 token은 "우리 계열"임을 말할 뿐 "이 파일이 그 lock"임을 말하지 못한다.
- **테스트 전용 주입은 외부 표면(argv/env)을 넓히지 않는 선에서만 늘린다.** fd close 실패처럼 syscall 결과를
  바꿔야 하는 경로는 argv로는 재현할 수 없으므로, `loadFixtureConfig`의 **세 번째 인자(in-process io seam)** 를
  택했다: fs 함수 4개로 표면이 최소이고, production 진입점은 인자 2개로만 호출하므로 argv·env·설정 파일
  내용으로는 도달할 수 없다. "**외부** 주입은 argv 하나뿐"이라는 계약은 그대로이며, 회귀 테스트가 production
  호출부의 인자 개수를 문자열로 고정해 미래의 확장을 막는다. 반대로 lock 라이브러리에는 io seam을 **넣지 않았다**
  — 여러 함수에 io를 관통시키는 비용·표면이 그 경로 한 건의 테스트 가치보다 크다고 판단했고, 대신 그 한계를
  잔여 위험으로 명시한다.
- **pause 지점은 "전이 종류 + 위치"로만 늘린다.** 새 회귀 테스트 4건을 위해 고정 enum에 4개
  (`before_publish_tmp_cleanup` / `before_quarantine_rename` / `before_guard_unlink_acquire` /
  `before_guard_unlink_reentry`)를 추가했다. 이름에 전이 종류를 붙여 한 실행에서 정확히 한 전이만 멈추게 하는
  기존 규칙을 유지한다(같은 이름이 여러 전이에서 걸리면 테스트가 비결정적이 된다).
- **계약이 강해지면 기존 테스트의 기대도 강해진 쪽으로 고친다(완화 금지).** acquire 경로의 guard inode 교체
  케이스는 "경고 후 probe 성공(exit 1)"을 기대했지만, 새 계약에서는 **성공 handle 없이 거부(exit 2)** 다.
  단정 자체는 유지·추가만 했다(guard 보존·내용 불변 + lock 잔존 + 다음 실행 차단). 테스트를 지우거나 느슨하게
  만들지 않고, 관측 가능한 계약이 바뀐 부분만 그 계약대로 다시 적었다.

## 2026-07-26 (V3 M3d.2 **네 번째 리비전** — 발행 신원 불변식 · 전이 실패 분류 · 주입 로더 단일 fd)

네 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES 5건)를 구현으로 해소하며 내린 결정들이다.
세 번째 리비전의 guard 계약을 **폐기하지 않고 보강**한다.

- **"발행했다"는 신원까지 확인해야 성립한다.** 파일 발행은 임시 파일 fd `fstat`으로 (dev,ino)를 확보하고
  `link` 뒤 최종 경로 `lstat`이 같은 (dev,ino)임을 확인해야 성공이다. 신원 확인이 실패하거나 어긋나면
  **성공을 반환하지 않고**, 그 파일이 우리 것이라는 증거가 없으므로 **최종 경로를 지우지도 않는다**.
  결과적으로 `published:true`의 dev/ino는 non-null **불변식**이 되고, 이후 전이의 inode 검증에
  "신원을 몰라서 건너뛰는" 분기가 존재하지 않는다. 신원을 모르는 상태로 계속 진행하는 것보다
  **탐지 후 중단**이 안전하다는 판단이다.
- **전이 실패는 두 분류뿐이고 기본값은 fail closed다.** `refusal`(아무 상태도 바꾸지 않은 계약상 거부)만
  guard를 반납하고, `mechanism`(I/O 오류·신원 불일치·불확실·예상 밖 예외)은 guard를 남긴다.
  **분류를 명시하지 않은 오류는 자동으로 `mechanism`** 이다 — 새 코드가 실수로 위험한 쪽 기본값을 고르지
  않게 하려는 의도적 선택이다. 그 결과 unlink 실패의 ENOENT나 close 실패처럼 "성공처럼 보이는 실패"도
  전부 흔적을 남긴다.
- **"우리 token이 맞다"만으로 외부 교체를 인정하지 않는다.** 격리(quarantine) rewrite는 rename이라 inode가
  바뀌므로 inode보다 먼저 판정해야 하지만, 그 대가로 token만 아는 행위자의 교체를 통과시켜서는 안 된다.
  그래서 격리 record는 기본 필드(v/kind/pid/identity/tokenHash) **보존**을 요구하고, 판정 순서를
  tokenHash → record 동일성 → quarantined → inode로 고정했다. `quarantineByToken`도 tokenHash를 먼저 본다
  (남의 lock이 격리돼 있다는 사실을 우리 성공으로 보고하지 않는다).
- **주입 설정은 경로를 한 번만 연다.** 검사(`lstat`)와 사용(`readFileSync`)이 경로를 두 번 해석하면 그 사이의
  교체로 검사와 실제 바이트가 서로 다른 대상이 된다. 따라서 `O_RDONLY|O_NOFOLLOW`로 **1회 open** → 같은 fd의
  `fstat`으로 일반 파일 확인 → **같은 fd**에서 상한+1 바이트만 읽고 **실제 읽은 바이트로** 상한을 판정한다.
  O_NOFOLLOW를 제공하지 않는 플랫폼에서는 주입 기능 자체를 거부한다(기능보다 안전).
- **하위 프로세스는 남의 권한 key를 해석하지 않는다(confused deputy 금지).** 상위 runner가 자기 fixture 파일을
  그대로 물려주면 하위가 상위 전용 key까지 계약에 넣어야 한다. 그래서 상위는 **하위가 실제로 해석하는 최소 설정만**
  새 파일로 명시 전달하고, 하위 계약에서 상위 전용 key를 삭제했다. 넓은 공용 설정보다 좁은 명시 전달이 낫다.
- **주입 seam은 늘리지 않는다.** 새 테스트가 필요해도 env seam·임의 명령 seam은 만들지 않고, 기존 argv
  `--fixture-config`의 **고정 enum에 pause 지점 1개**(`before_guard_unlink_release`)만 추가했다. pause 지점 이름에
  전이 종류를 붙여 한 실행에서 **정확히 한 전이만** 멈추게 한다(같은 이름이 여러 전이에서 걸리면 테스트가
  비결정적이 된다).
- **테스트는 "실패를 만드는 방법"까지 검증 대상이다.** 읽기 전용 디렉터리로 실패를 만들면 lock 발행과 guard 제거가
  **동시에** 막혀 분류(mechanism/refusal)를 구분할 수 없다는 것을 mutation으로 확인했다. 그래서 디렉터리를 쓸 수 있는
  상태에서 발행만 충돌시키는 테스트를 따로 두었다. 마찬가지로 CLI spawn 기반 경합 테스트는 시도 횟수가 적어
  검사–사용 경합을 잡지 못하므로 로더를 **in-process로 수천 번** 호출하는 형태로 바꿨다.

## 2026-07-26 (V3 M3d.2 **세 번째 리비전** — lock format v2 + transition guard, 자동 회수 폐지, argv 전용 주입)

세 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES 6건)를 구현으로 해소하며 내린 결정들이다.
아래 결정은 같은 날 **두 번째 리비전의 stale 회수 관련 결정 3건(직렬화·inode CAS·중단된 회수)을 폐기·대체**한다.

- **상태 전이는 파일 하나가 아니라 "전이 guard"로 직렬화한다.** lock 파일만으로는 "소유를 확인한 순간"과
  "지우거나 덮는 순간" 사이가 열려 있어, release가 새 소유 lock을 지우고 quarantine이 그것을 덮는 양방향 TOCTOU가
  생긴다. 그래서 acquire/release/quarantine/reentry를 **crash-persistent `<lock>.guard` 안에서만** 수행하고,
  guard 안에서 tokenHash·격리 표시·inode 신원을 다시 확인한 뒤에만 파일을 조작한다. lock format은 `v2`다.
- **guard는 남의 것을 절대 건드리지 않는다.** guard 제거는 **자기 nonce + 자기 inode**를 확인한 뒤에만 한다.
  다른 guard가 있으면 bounded 대기 후 거부할 뿐, 죽은 보유자의 guard라도 자동 제거·자동 인수하지 않는다.
- **전이 실패와 전이 중 강제종료는 흔적을 남겨 다음 suite를 막는다(fail closed).** quarantine write 실패·unlink
  실패·신원 불일치·SIGKILL은 guard를 남긴다. 반대로 **아무것도 바꾸지 않은 거부는 no-op**이므로 guard를 정상
  반납한다 — 그렇지 않으면 두 suite를 한 번 겹쳐 실행한 것만으로 영구 수동 개입이 필요해진다.
  안전(겹침 금지)과 사용성(정상 경합은 회복 가능)을 이 경계로 나눈다.
- **dead/orphan lock 자동 회수를 폐지한다.** 소유자의 죽음은 정리 완료의 증거가 아니다 — SIGKILL로 죽었다면
  소유 프로세스 그룹의 잔재가 남아 있을 수 있고, 그 상태에서 lock을 이어받으면 다음 suite가 그 잔재를 관측한다.
  따라서 `lock_orphaned`로 **항상 거부**하고 사람이 확인 후 제거한다. 회수가 없으므로 `.recovery` mutex,
  stale rename, inode CAS 회수 경로도 전부 제거했다(두 번째 리비전의 "회수 mutex 크래시 창" 위험은 소멸).
- **lock이 없어도 guard가 있으면 acquire는 우회하지 않는다.** "lock 파일이 안 보이니 비었다"는 판단은 전이 도중
  스냅샷일 수 있다.
- **detached는 "정리 책임을 지는 계층"만 쓴다.** 재진입(nested) wrapper가 detached child를 만들면 그 그룹이
  상위 stress runner의 pgid 스캔에서 사라진다. 그래서 standalone일 때만 자기 그룹을 만들고, nested면 그룹을 만들지
  않아 **모든 자손이 상위 소유 pgid에 남게** 한다. 상위의 유예(TERM→8s→KILL)는 하위 shutdown 예산보다 짧지 않다 —
  timeout 경로도 즉시 SIGKILL하지 않는다.
- **테스트 주입은 env가 아니라 argv 하나로만 들어온다.** env는 자손에 암묵 상속되므로 셸에 export한 값이
  production 실행(`npm test`, live runner)의 lock 경로·evidence 위치를 조용히 바꿀 수 있고, 상위/하위가 서로 다른
  lock 파일을 보게 되어 배타성 자체가 깨진다. 주입은 `--fixture-config <절대경로 .json>` 하나뿐이며
  크기·일반 파일·symlink·절대경로·allowlist key·타입/범위를 엄격 검증한다. **임의 명령 실행 seam은 만들지 않는다.**
  `HARNESS_SUITE_LOCK_TOKEN`은 예외로 남기는데, 테스트 seam이 아니라 실제 부모→자식 ownership handoff이기 때문이다.
  evidence 디렉터리도 같은 이유로 `HARNESS_LIVE_EVIDENCE_DIR`를 폐기하고 명시 인자(`overrideDir`)만 받는다.
- **회귀는 실제 경합·강제종료로 검증하고 비공허성을 mutation으로 증명한다.** 재확인 제거·guard blind unlink·
  nested detached·timeout 즉시 KILL 네 가지를 실제로 주입해 해당 테스트가 실패함을 확인한 뒤 원복했다.
- **M3d 완료·리뷰 승인은 여전히 선언하지 않는다.** live runner 3종과 evidence 3건은 **pending**이며
  **fresh Codex 최종 재검토도 받지 않았다.**

## 2026-07-26 (V3 M3d.2 **두 번째 리비전** — lock 격리(quarantine), 단일 종료 상태 기계, stale 회수 신원 안전성)

> **부분 대체됨(세 번째 리비전).** 격리·단일 종료 상태 기계는 유효하다. 반면 **stale 회수 3건
> (`.recovery` 직렬화 / inode CAS 회수 / 중단된 회수 거부)은 폐기**되었다 — 자동 회수 자체가 없어졌다.
> detached 관련 서술도 "nested는 detached하지 않는다"로 정정되었다. 아래는 역사 기록이다.

두 번째 fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES)를 문서로 무마하지 않고 구현으로 해소하며 내린 결정들이다.
아래 결정은 같은 날 앞선 M3d.2 결정 중 **stale 회수·정리 후 해제** 항목을 대체한다.

- **정리 확인에 실패하면 lock을 해제하지 않는다 — 해제 대신 "격리"한다.** 소유 worker·프로세스 그룹·자손이
  남아 있을 수 있는 상태에서 lock을 노출하면 다음 suite가 그 잔재를 관측해 거짓 실패한다. 그렇다고 확인될 때까지
  붙잡고 있으면 terminal에서 빠져나갈 수 없다. 그래서 lock 파일에 `quarantined:true`를 원자적으로 표시하고
  **즉시 종료**한다. 격리된 lock은 **소유자가 죽어도 stale 회수 대상이 아니다** — 자동 복구보다 겹침 방지를 우선한다.
  해제는 사람이 잔재를 확인한 뒤 수동으로 한다. 이 규칙은 stress runner와 lock wrapper 양쪽에 같게 적용한다.
- **종료 경로는 하나의 비동기 idempotent bounded 상태 기계뿐이다.** normal close / spawn error / SIGINT / SIGTERM /
  반복 시그널 / escalation이 전부 같은 기계를 지난다. "시그널을 보냈다"는 정리의 증거가 아니다 — 소유 그룹과
  소유 pgid 자손이 **사라진 것을 확인**한 뒤에만 lock을 해제한다. 반대로 **시그널 exit 의미(130/143)는 확인 결과와
  무관하게 유지**한다. 종료 코드는 호출자와의 계약이고, lock 노출 여부는 별개의 안전 결정이기 때문이다.
- **detached child의 중첩 프로세스 그룹은 만든 쪽이 확인한다.** lock wrapper가 띄우는 `npm run test:inner`는
  자기 pgid를 갖기 때문에 상위 stress runner의 pgid 스캔에 잡히지 않는다. 각 계층이 자기 그룹을 확인하고,
  상위는 하위의 종료를 기다리는 사슬로 전체를 덮는다.
- **stale 회수는 직렬화 + 재분류 + inode CAS 세 겹으로만 한다.** `check → blind rename`은
  "A가 stale로 읽음 → B가 회수 후 live lock 생성 → A가 그 live lock을 rename"으로 겹침을 만든다.
  ① `<lock>.recovery` exclusive 발행으로 회수 구간을 직렬화하고, ② 구간 안에서 **다시 읽고 다시 분류**하며,
  ③ rename **직후** 옮겨진 파일의 inode가 분류 대상과 같은지 확인한다. rename은 원자적이므로 이 사후 확인이
  "그 inode를 옮긴 유일한 프로세스"라는 증명이다. 어긋나면 되돌리고 **절대 lock을 만들지 않는다**.
- **중단된 회수는 자동으로 인수하지 않는다.** 회수 mutex 보유자가 죽었거나 확인 불가하면 `lock_recovery_stalled`로
  거부한다. 죽은 mutex를 인수하는 순간 "둘 다 인수" 경합이 다시 열리고, 그 경합의 손해(남의 live lock 이동)는
  탐지는 되어도 원복이 보장되지 않는다. **안전이 편의를 이긴다** — 사람이 파일 두 개를 지우면 된다.
- **lock 파일은 완성된 뒤에만 최종 이름으로 존재한다.** 비공개 임시 파일에 전부 쓰고 `link()`로 발행한다
  (EEXIST = 이미 보유자 있음, `wx`와 동일한 배타성). 부분 write 실패가 최종 경로에 "형식 위반 lock"을 남겨
  영구 거부 상태를 만드는 일을 없앤다. evidence publish와 같은 원칙이다.
- **테스트 주입 seam은 좁은 enum·절대경로만 받는다.** 정리 확인 실패·회수 경합 인터리빙은 실제 잔존 프로세스를
  만들지 않고 결정론적으로 재현한다. 회수 경합 재현용 동기화 지점(`PAUSE_DIR`/`PAUSE_AT`)도 firm 상한(20s)을 갖는다.
  주입 경로는 다른 프로세스에 신호를 보내지 않으며, 회귀 테스트가 **무관한 제3 프로세스의 생존**을 함께 확인한다.
- **회귀 테스트의 비공허성을 mutation으로 확인한다.** 재분류를 끄면 2-contender 테스트가 실패하고, inode 사후 확인을
  끄면 교체 거부 테스트가 실패한다는 것을 실제로 확인한 뒤 원복했다. "통과했다"만으로는 방어를 증명하지 않는다.
- **M3d 완료·리뷰 승인은 여전히 선언하지 않는다.** 이번 검증(연속 3회 `npm test` + 부하 stress 1회)은 통과했지만
  live runner 3종과 evidence 3건은 **pending**이고, **fresh Codex 최종 재검토도 받지 않았다.**

## 2026-07-26 (V3 M3d.2 리비전 — suite 직렬화 lock, evidence publish 프로토콜, timestamp 동치)

fresh Codex Sol xhigh 리뷰(REQUEST_CHANGES) 지적을 문서로 무마하지 않고 구현으로 해소하며 내린 결정들이다.
아래 결정은 같은 날 이전 M3d.2 결정 중 저장·동시성 항목을 **대체**한다.

- **전체 suite 직렬화는 "탐지"가 아니라 "lock"이 1차 방어다.** 일반 `npm test`와 stress를 **같은 배타 lock 하나**로
  묶었다(`npm test` = lock wrapper → `test:inner`). `ps` 스캔은 lock을 우회해 시작된 suite를 잡는 backstop으로만 남긴다.
  이유: 전역 프로세스/tmp 상태를 관측하는 테스트가 있어(M3d.1 실측) 두 suite가 동시에 시작되면 거짓 실패한다.
  `test:inner`는 기존 순서(exec → core → acceptance)와 카운트·exit 의미를 그대로 유지한다 — lock만 추가한다.
- **재진입은 token으로만 허용한다.** stress가 띄운 자기 소유 `npm test` child만 32B 난수 ownership token으로 재진입한다.
  lock 파일에는 **sha256만** 남기므로 파일을 읽어도 재진입할 수 없고, PID만으로는 어떤 신뢰도 부여하지 않는다.
- **stale lock 회수는 신원 확인 + 원자적 rename으로만 한다.** 소유자 판정은 `pid + ps lstart`이며,
  pid 부재 또는 lstart 불일치(pid 재사용)일 때만 `rename`으로 회수한다(rename ENOENT = 남이 먼저 회수 → 경합 없이 재시도).
  **손상·버전 불일치·`ps` 확인 불가 lock은 회수하지 않고 거부한다(fail closed).** 자동 복구보다 겹침 방지를 우선한다.
- **부하 없는 stress PASS를 금지한다.** worker 전원 spawn 확인 + `npm test` 종료 시점까지 전원 생존을 요구하고,
  부하 deadline > suite 상한을 강제한다. "부하를 걸었다고 주장하지만 실제로는 없었다"를 구조적으로 배제한다.
- **정리는 단일 비동기 idempotent 상태 기계로만 한다.** 소유 그룹·worker만 종료하고, 소멸을 bounded 확인한
  **뒤에** lock을 해제한다. 확인 실패·확인 불가는 성공으로 넘기지 않고 FAIL로 보고한다.
  timeout은 group kill 실패와 무관하게 실제 wall-clock 상한을 유지한다(매달리지 않는다).
- **evidence 최종 파일명은 완성 후에만 존재한다.** 숨김 임시 파일에 전부 쓰고 fsync·close·재검증한 뒤
  **exclusive hard link**로 publish한다(덮어쓰기 없음). 이유: 이전 방식은 최종 이름으로 열어 쓰는 중 크래시가 나면
  성공 산출물과 같은 이름의 잘린 파일이 남을 수 있었다. 정리 실패는 조용히 무시하지 않고 실패로 보고하며,
  완결되지 않은 기록은 발행분까지 되돌린다.
- **경로 기반 TOCTOU는 완전 방어라고 주장하지 않는다.** dev+ino 신원 보관·publish 직전 재확인·신원 확인 후 unlink로
  창을 좁히고 교체를 탐지하되, Node 18에 디렉터리 핸들 상대 열기가 없다는 한계를 코드·문서에 남긴다.
- **schema와 런타임 timestamp 판정은 반드시 같아야 한다.** 정규식만으로 동일 판정이 가능하도록 연도를 2000..2099로
  한정했다(그 범위에서 윤년 = 4의 배수). 두 판정의 동치는 accept/reject 표 테스트로 강제한다.

## 2026-07-26 (V3 M3d.2 — live evidence 계약과 stress acceptance 동시성)

- **live evidence는 "성공 전용 + allowlist"다.** `status`는 `"pass"` 고정이며 실패·스킵·미실행 run은 evidence를 남기지
  않는다. 허용 필드는 `version`/`contract`/`status`/`timestamp`/`metrics`뿐이고 `metrics`는 runner별 exact key 집합의
  정수(0..1,000,000)·boolean만이다. **denylist가 아니라 allowlist로 닫는다** — 새 필드를 추가하려면 schema·validator·테스트를
  같이 바꿔야 한다.
- **runner별 discriminated 계약을 쓴다.** 하나의 느슨한 공통 evidence 대신 `m3a_live_preflight`/`m3b2_live_handoff`/
  `m3c3b_live_handoff` 세 계약을 두고, 다른 계약의 metrics 교차는 거부한다. 모든 객체 레벨에서 unknown key를 거부한다
  (`additionalProperties:false` 동등).
- **런타임 검증은 수동 closed validator다(신규 검증 의존성 0).** JSON Schema는 계약 문서이고,
  두 정의의 동기는 테스트가 강제한다(`tool_profile.schema.json`과 동일한 기존 방식 유지).
- **금지 필드는 이름 스캔으로 먼저 거부한다.** raw transcript·tool/MCP 입출력·argv·명령·경로·hostname/user·PID·
  session/call/request ID·환경변수·secret 참조/값·config 본문·free-form error/message는
  **redaction 마커로 치환해도 허용되지 않는다.** 마스킹은 금지 필드의 통과 수단이 아니다.
- **redaction은 backstop이지 게이트가 아니다.** 영속화 직전 `redactSecrets`/`collectSecretValues`로 잔재를 재검사하되,
  잔재가 있으면 **가려서 저장하는 대신 쓰기를 거부**한다. 지표만 담는 payload에 secret/경로 문자가 나타나는 것 자체가
  계약 위반이라는 판단이다.
- **evidence 경로는 payload에 담지 않고 출력하지도 않는다.** 파일명은 UTC compact timestamp + nonce로 충돌 저항성을 갖고,
  exclusive create(`wx`)로 조용한 덮어쓰기를 금지한다. 디렉터리 0700 / 파일 0600, symlink·비디렉터리 대상 거부,
  실패 시 부분 산출물 제거. 상위 경로 symlink 검사는 bounded(4단계)로 두고 시스템 prefix(macOS `/var` 등)는 대상에서
  제외한다 — realpath 완전 일치를 요구하면 정상 tmp 경로까지 거부되기 때문이다.
- **evidence는 "모든 계약 검사 + cleanup 성공" 이후에만 기록하고, 기록 실패는 runner 실패다.**
  PASS를 먼저 선언하고 나중에 기록하지 않는다(PASS 출력 자체를 evidence 기록 뒤로 옮겼다).
- **stress acceptance는 겹쳐 실행하지 않는다.** 배타 lock + `ps` 스캔으로 다른 suite/stress가 있으면 거부하고,
  `ps` 확인 실패도 거부(fail-closed)한다. 단 후보는 **실행 파일이 node/npm/sh 계열인 프로세스로 좁힌다** —
  argv에 테스트 명령 문자열만 담은 무관한 프로세스(예: 허용 도구 목록을 argv로 받는 agent CLI)를 동시 실행으로
  오판했기 때문이다(M3d.1의 loose command matching 교훈 재확인).
- **SIGKILL 직후 생존 판정은 하지 않는다.** reap 전이라 거짓 실패가 된다. 종료 확인은 bounded polling으로 한다.
- **M3d 완료는 아직 선언하지 않는다.** 구현·offline 검증(연속 3회 `npm test` + 부하 stress 1회)은 통과했지만
  live runner 3종 실행과 evidence 3건 생성은 **pending**이다. M3b.2는 사람 TTY를 요구하므로 자동 실행 대상이 아니다.
  **M4 ready로 판정하지 않는다.**

## 2026-07-26 (V3 M3d.1 — live runner 소유권 판정과 전역상태 테스트 동시성 계약)

- **M3d.1은 완료로 표시한다(fresh Codex Sol xhigh 최종 verdict = APPROVE). 단 M3d 전체는 완료가 아니다.**
- **"baseline 이후 매칭 = 내 잔여물"은 잘못된 판정 규칙이다.** M3c-2 live runner가 baseline 이후의
  `shadcn@4.13.1 … mcp` 매칭 프로세스를 전부 자기 것으로 간주해 무관한 동시 프로세스가 거짓 실패를 유발했다.
  수정 범위는 `scripts/m3c2-live-read-semantics.mjs`와 `src/tools/shadcnReadSemanticsProbe.test.ts`로 한정한다.
- **소유권 정의는 "runner 프로세스 트리 자손 OR cwd가 runner 임시 base 하위"다.** baseline 이후에 생겼어도
  그 base 밖의 진짜 독립 sibling은 foreign으로 무시한다. 검사 불가(unknown)는 fail-closed를 유지하되
  **kill 대상이 아니다** — 판정 불가를 소유로 승격하지 않는다.
- **프로세스 신원은 PID 단독으로 판단하지 않는다.** baseline과 재검증 모두 `pid + ps lstart`를 쓴다(PID 재사용 방지).
  후보 argv는 로그에 남기지 않고, 진단은 pid·ownership·**run별 salted SHA-256 signature**만 노출한다.
- **테스트 sleeper는 bounded TTL을 갖고, 정리는 신원 확인 후에만 한다.** child handle 또는 nonce로 orphan 신원을
  확인하고 종료를 bounded하게 확인한다. **blind PID signal은 금지한다.**
- **프로세스 전역·tmp 전역 상태를 관찰하는 테스트는 exclusive resource class/lock을 요구한다.**
  근거: 이번에 겹친 검증 1회가, fresh 리뷰어와 메인 스위트가 동시에 전역 m3c2 temp/process 상태를 관찰하는 바람에
  실패했고 격리 재실행은 PASS였다. 이런 테스트는 동시 실행하지 않는다. 이 계약을 **M4 durable-state/scheduler**의
  구체 요건과 **M5 bridge 실행 요건**으로 로드맵에 반영한다(마일스톤 목표 자체는 변경하지 않는다).
- **M5 bridge 세션은 silent하면 안 된다.** Claude bootstrap 실측에 따라 진행/이벤트 스트리밍,
  no-progress·wall-clock bounded deadline, cancellation, descendant cleanup을 요건으로 둔다.
  최종 결과만 반환하는 세션은 수용하지 않는다.
- **잔여 위험은 비차단으로 수용한다.** `lstart` 1초 해상도, 대상 Linux의 procps 호환 `/bin/ps` 전제
  (미지원 환경 inspection은 fail-closed).
- **다음은 남은 M3d 범위다.** redacted persistent live-evidence schema/테스트 + 반복 full-suite/stress acceptance는
  **별도 상세 계획·승인 후** 진행한다. M4 착수 가능 상태로 선언하지 않는다.

## 2026-07-26 (자율 오케스트레이션 로드맵·통신·fresh-session·권한 모델)

- **M3d 이후 최우선 기준은 `V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md`.** 기존 두 활성 문서의
  M0~M3 보안·진행·handoff 계약은 유지하되 기존 M4~M7 순서는 새 M3d~M10으로 대체한다.
- **중앙 LLM 세션은 SoR이 아니다.** TypeScript orchestrator+디스크 run state가 상태·의존성·예산·승인을
  소유하고, Coordinator도 phase/wave/context 경계마다 fresh하게 교체할 수 있어야 한다.
- **agent 통신은 orchestrator 중계만.** 공통 envelope+type별 Markdown body+artifact revision/hash를
  runtime validator가 확인한다. direct sibling state mutation과 raw transcript 전달은 금지한다.
- **fresh 정책:** task attempt, review/critique/verification, 기본 revise는 각각 새 세션. reviewer는
  저자 transcript 없이 task/contract/diff/test/evidence만 읽는 read-only 독립 세션이다.
- **모델 라우팅:** 개발·수정은 Claude Code Opus, 큰 계획·문서 비평·검토는 Codex
  `gpt-5.6-sol` xhigh, 상태 전이·schema·hash·gate는 LLM 없는 kernel.
- **권한 피로는 milestone approval manifest로 줄인다.** 승인된 writable roots/commands/dependencies/
  domains/budget 안에서는 자동 진행하고 범위 확대는 consolidated request로 pause한다. auto-review는
  승인 검토자 변경일 뿐 sandbox 확대가 아니다. 기존 hard deny는 불변이다.
- **자기개발 bootstrap:** controller는 검증된 base/dist에서 고정 실행하고 worker는 worktree만 수정한다.
  로컬 병합 뒤 milestone 경계에서 controller를 rebuild/restart한다. M5 live 후 M6부터 autopilot 사용.
- **로드맵 자기수정 제한:** Codex는 개선 proposal을 만들 수 있으나 scope·권한·비용 확대, dependency 추가,
  테스트 완화, hard deny 변경은 사람 재승인 없이는 active roadmap에 반영하지 않는다.

## 2026-07-24 (V3 M3 전체 완료 — M3c-3b actual live PASS)

- **M3c-3b는 offline + actual live 완료로 표시한다.** filtered shadcn read handoff가 Claude Code 2.1.218에서 runner exit 0/PASS로 실측됐다(preflight shadcn connected+host 5 exact, 금지 2 미노출, trace records 25/tool_requested 3/session_end 1, config_hash 체인·snapshot_path 일치, serviceCwd 무변경, canary·잔존 프로세스 없음, cleanup 완료).
- **V3 M3 전체 완료.** M3a(non-empty MCP strict 격리 live) · M3b.2(empty MCP 대화형 Hook live) · M3c-3b(filtered shadcn read handoff live) acceptance가 모두 충족됐다. 다음 단계(활성 read 도구 확대, Tavily/Research adapter M4 등)는 **별도 계획 검토로만** 기록하며 이번 범위에서 구현하지 않는다.
- **live 실패에서 배운 계약(보존)**: (1) proxy는 upstream/downstream protocolVersion을 분리하고 초기화 응답을 attestation과 독립적으로 즉시 낸다(안 그러면 `server_not_connected`). (2) MCP connect deadline이 기본 5s라 cold npx + attestation을 위해 blocking MCP env(45s)를 강제해야 한다(안 그러면 `status=pending`).

## 2026-07-24 (V3 M3c-3b — blocking MCP 연결 env 단일 출처·마지막 강제)

- **MCP 연결 timeout env는 한 곳(`src/tools/mcpEnv.ts`)에서만 정의한다.** `MCP_CONNECTION_NONBLOCKING=0`·`MCP_CONNECT_TIMEOUT_MS=45000`·`MCP_TIMEOUT=45000`. filtered proxy의 cold npx + exact-7 attestation이 Claude 기본 handshake 5s를 넘겨 pending 되는 것을 막는다. 45s는 proxy startup 30s와 preflight hard timeout 60s 사이에 두어 cleanup 여유를 남긴다.
- **안전값은 마지막에 강제한다.** preflight child env와 handoff-shadcn interactive spawn env 모두, ambient `process.env`·testEnv를 먼저 깔고 blocking MCP env를 `Object.assign`으로 **가장 마지막에** 덮어써 override를 원천 차단한다.
- **blocking MCP env는 shadcn profile 경로에만.** 기본 handoff(empty MCP, toolProfile 미지정)는 이 env를 추가하지 않아 기존 동작이 완전히 불변이다. pending/failed/needs-auth를 성공으로 완화하지 않고, connected + exact tools만 성공이라는 계약도 그대로다.

## 2026-07-24 (V3 M3c-3b — MCP proxy: protocol 두 leg 분리 + attestation 게이팅)

- **upstream/downstream protocolVersion은 완전히 분리한다.** proxy는 MCP 서버(upstream)와 MCP 클라이언트(downstream) 두 leg를 갖는다. upstream initialize 응답은 **upstream이 요청한 허용 버전**을 그대로 돌려주고, downstream은 `REQUEST_PROTOCOL_VERSION`으로 별도 협상한다. downstream 버전을 upstream에 복사하면 Claude가 협상 불일치로 연결에 실패할 수 있으므로 금지. upstream pv가 missing/비문자열/미허용이면 initialize를 fail-closed로 거부하고 tools를 노출하지 않는다.
- **upstream initialize는 downstream 검증과 독립적으로 즉시 응답한다.** downstream attestation(initialize→tools/list exact-7)을 initialize 응답 전제조건으로 두면 downstream 기동 지연이 Claude의 MCP 연결 타임아웃(`server_not_connected`)을 유발한다. 따라서 upstream listener를 downstream spawn 직후 시작하고, attestation은 별도 bounded Promise로 돌린다.
- **tools/list·tools/call은 attestation 통과 전 성공하지 않는다.** attestation pending이면 startup timeout 안에서 bounded wait, 실패면 restricted 5개를 절대 노출하지 않고 연결을 종료(non-zero + 그룹 kill + HOME cleanup)한다. attestation 실패가 `upstream_end` 정상 종료로 가려지지 않도록, upstream_end 성공 종료는 attestation 완료까지 defer한다.

## 2026-07-24 (V3 M3c-3b — launcher args 엄격화·단일 출처·전용 live runner)

- **launcher 서버에 args는 빈 배열이어도 금지.** 혼합 검사를 `decl.args !== undefined`로 해 `args:[]` 존재 자체를 mixed_launcher로 거부한다(모호한 stdio/launcher 혼합 여지 제거).
- **신뢰 launcher 목록은 단일 출처.** `profiles.ts`의 `TRUSTED_LAUNCHER_IDS` 하나만 사용하고 adapter의 중복 Set을 제거한다(목록 드리프트 방지). loader·adapter·contract가 같은 목록을 본다.
- **live acceptance는 전용 runner로만, 자동 실행 금지.** `scripts/m3c3b-live-handoff.mjs`는 `HARNESS_LIVE_M3C3B=1`+TTY+claude version 게이트를 통과할 때만 실제 Claude·`npx shadcn`을 호출한다. npm test/CI에서 절대 실행되지 않으며 임시 경로·canary 격리·lsof ownership 확인 후 kill·원문 미출력을 강제한다. production/remote/billing/deploy 미접촉.

## 2026-07-24 (V3 M3c-3b — live 전 P0/P1 하드닝 계약)

- **trusted proxy 실행 경로는 고정, override 불가.** `shadcn_read_proxy`는 항상 `node + PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js`. 인자·환경변수·profile·test seam 어느 것으로도 실행 경로를 바꿀 수 없다(과거 `launcherProxyPath`/`proxyPath` seam 제거). 파일 상태 검증(`verifyTrustedProxyFile`)만 분리해 테스트가 임시 경로로 호출하되, 그 경로가 generated config에 들어가는 공개 API는 두지 않는다.
- **launcher profile은 secret을 갖지 않는다.** filtered shadcn read profile은 secretRefs·allowedDomains 정확히 `[]`, server key 정확히 `{name, launcher}`. launcher 서버가 secretRefs를 선언하면 config 생성 단계에서 `launcher_secret_refs_forbidden`으로 fail-closed(값 미노출). proxy는 임시 HOME/cache로 동작하므로 ambient secret이 필요 없다.
- **server 선언은 로드 단계에서 runtime 검증한다(단순 cast 금지).** launcher/stdio/http/bare 분류별로 필수·금지 필드와 unknown key·mixed transport를 `validateServer`가 강제하고, `McpServerDecl.launcher`는 `"shadcn_read_proxy"` literal로 제한한다. schema(server oneOf + additionalProperties:false)도 runtime 계약과 일치시켜 문서-런타임 드리프트를 없앤다.
- **trusted proxy는 symlink이면 거부한다.** `lstatSync`로 symlink을 따라가지 않고 거부(`launcher_proxy_symlink`), 일반 파일·읽기 가능만 통과. 심볼릭 링크로 신뢰 경로를 바꿔치기하는 것을 막는다.

## 2026-07-23 (V3 M3c-3b — filtered shadcn read profile 배선 계약)

- **registry엔 launcher 논리 식별자만, 절대경로·npx 미기록.** `McpServerDecl.launcher`(신뢰 목록 `shadcn_read_proxy`)를 runtime에서만 `node + PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js`로 변환한다. command/args/url과 배타적, unknown launcher·proxy 파일 부재/디렉터리/읽기불가는 config 기록 전 fail-closed. 원본 `npx shadcn`을 profile에서 직접 실행하지 않는다(filtered proxy만이 경계).
- **파일럿 handoff profile은 `handoff-shadcn-readonly` 하나만 허용.** `harness handoff --tool-profile`에 다른(MCP) profile을 주면 fail-closed(`profile_rejected`). 로드 후 정확 계약 검증(capability/binding/launcher/preapproved/denied/permission/limits/source)으로 registry 변조에 의한 노출 확대를 막는다. 상한은 proxy 정책 상수(calls6/resultChars8000/timeout60000)와 exact 일치.
- **workflow용 `--tool-profile`과 handoff용 `--handoff-tool-profile`은 분리.** runWorkflow의 MCP fail-closed 가드는 그대로 — MCP binding profile을 workflow에 주면 여전히 거부. handoff 경로만 preflight+proxy로 MCP를 연다.
- **profile 경로 대화형 argv는 `mcp__*` 전체 deny 대신 정확한 host 5개 allow + 금지 2개 deny.** 미지정 기본 경로는 기존 empty-MCP + `mcp__*` deny 그대로(완전 불변). preflight는 shadcn connected + 정확한 5개 도구일 때만 통과(누락/초과/금지 도구 snapshot은 tool_mismatch).
- **components.json 표준 registry 검사는 Claude·proxy 실행 전.** custom/private/malformed/symlink이면 `registry_rejected`로 spawn·preflight·기록 없이 중단.
- **HandoffRecord optional 필드(tool_profile_id/config_hash/snapshot_path)는 profile 경로에서만.** 기본 경로 record는 종전과 동일(optional 키 미포함), run_state status/completed 불변.

## 2026-07-22 (V3 M3c-3a — signal 즉시 종료 계약, downstream 위반 fatal 분류)

- **AbortSignal은 downstream spawn 직후부터 연결한다.** startup 완료 후 등록하면 startup/in-flight signal이 timeout까지 대기하므로, spawn 직후(이미 aborted면 즉시) 연결하고 signal 수신 즉시 process group을 죽여 pending을 해제한다(startupTimeout 30s·perCallTimeout 60s 대기 금지).
- **signal은 signal exit로만 종료한다.** `main`은 SIGINT=130·SIGTERM=143로 종료하고 이를 proxy_error/exit 1로 바꾸지 않는다. 종료 후 stdout에는 불완전 JSON/진단 문자열을 쓰지 않는다.
- **cleanup은 정확히 한 번, listener는 완료 시 제거.** signal과 child close가 경합해도 settled 가드로 cleanup 1회. markDead가 pending timer를 clear해 signal 뒤 timeout 콜백이 재실행되지 않는다.
- **downstream 응답 계약 위반은 fatal, 일반 tool error/정책 거부는 세션 유지.** malformed·bad jsonrpc·id mismatch·result 비객체(ds_bad_result)·cap·timeout·조기 close는 group 종료 fatal. downstream이 정상 JSON-RPC error를 돌려준 "일반 tool error"와 result budget·입력 정책 거부는 그 호출만 거부하고 downstream을 유지한다.
- **테스트 백도어는 함수 seam으로만.** cleanup 실패 검증은 `cleanupFaultForTest` 인자로만 하고, production `main`은 환경변수(HARNESS_M3C3_TEST_CLEANUP_FAIL)를 해석하지 않는다.

## 2026-07-22 (V3 M3c-3a — proxy P0/P1 보완, M3c-3b 착수 보류)

- **M3c-3b 착수는 이 P0 보완 이후로 보류한다.** 프록시가 (1) 실제 실행 진입점이 없어 dist 실행 시 즉시 종료, (2) MCP tool name을 host prefix로 잘못 반환(double namespace), (3) fatal downstream 후 열린 채 대기 — 세 P0가 있어 아직 실제 MCP 서버 경계로 쓸 수 없었다. 이를 고치기 전 profile/handoff 배선은 위험하므로 M3c-3b는 "계획 검토 후 착수(보류)"로 둔다.
- **MCP 서버는 bare tool name만 반환한다.** `mcp__<server>__` prefix는 Claude host가 server name으로 붙이는 것이므로 MCP 서버(프록시)가 반환하면 안 된다. tools/call도 bare만 허용하고 prefix 입력은 거부한다. host-namespaced 이름은 내부 보고(ProxyResult/trace)에서만 파생한다.
- **fatal downstream은 즉시 그룹 종료 + finalize, 정책 거부는 유지.** timeout/cap/malformed/id-mismatch/조기종료는 `terminateProcessGroup()`로 그룹을 죽이고 안전 오류 응답 후 세션을 finalize한다(열린 채 대기 금지). result_too_large·isError·형태 위반 등 정상 정책 거부는 downstream을 죽이지 않고 그 호출만 거부한다.
- **exit code 계약**: stdin 정상 종료 + cleanup 성공만 exit 0. startup 실패·cleanup 실패·signal은 non-zero. cleanupOk:false를 성공으로 보고하지 않는다. stdout은 JSON-RPC 전용, 오류는 짧은 code만 stderr(원문·secret·stack 없음).

## 2026-07-22 (V3 M3c-3a — read-only filtering MCP proxy가 보안 경계)

- **원본 shadcn MCP를 profile에 직접 연결하지 않는다.** 7개를 모두 노출하므로, deniedTools/Hook만으로는 "미노출"과 "응답 전달 전 크기 제한"을 보장하지 못한다. profile/handoff 연결 전에 **로컬 필터 MCP 프록시**가 실제 경계를 제공한다 — upstream엔 5개만·로컬 제한 schema만 노출하고, downstream 원본 description/schema는 신뢰·전달하지 않는다.
- **downstream은 고정 명령·override seam 없음.** 항상 `npx --yes shadcn@4.13.1 mcp`. startup에서 표준 registry 검사(child/config 이전) → downstream tools/list가 실측 7개와 정확 일치해야 serve. 불일치·custom registry는 spawn 전/직후 fail-closed.
- **결과 크기 초과는 pointer가 아니라 hard reject.** contextRoot에서 runtime을 읽을 수 있어 "oversized 원문을 파일에 저장하고 pointer를 반환"하면 상한이 우회된다. 그래서 M3 파일럿은 resultChars > 8,000을 **원문·pointer 미반환**으로 hard reject한다. isError/빈/structuredContent/non-text 등 현재 실측 계약 밖 응답도 fail-closed.
- **종료는 그룹 단위.** downstream을 detached로 spawn하고 `process.kill(-pid)`로 그룹을 종료해 npx가 띄운 descendant를 방치하지 않는다. 성공/실패/timeout 모두 close 확인 후 임시 HOME/cache 정리.
- **이 5개는 아직 "노출 승인"이 아니다.** 프록시는 경계를 제공할 뿐, registry profile 등록·handoff 연결·result-size enforcement의 정식 배선은 M3c-3b에서 별도로 다룬다. 이번 단계는 profile/registry/handoff/CLI를 수정하지 않았다.

## 2026-07-22 (V3 M3c-2 — actual live read semantics acceptance PASS)

- **M3c-2를 offline+actual live 완료로 확정하되, 5개를 노출 승인으로 승격하지 않는다.** 실제 shadcn MCP에서 읽기 후보 5개를 고정 인자·정확 순서로 1회 호출(exit 0), 5회 모두 serviceCwd unchanged, 금지 2개 미호출, 전 결과 text-only·budget 이내를 실측했다. 그러나 이는 **read semantics 검증 후보**의 통과일 뿐 노출·권한 부여 근거로 확정하지 않는다.
- **증거를 관측된 범위로만 기록한다.** runner 출력에 없는 `resultChars`/`resultBytes`·protocolVersion/serverInfo 정확값은 추측하지 않는다. M3c-2는 "허용 protocol negotiation + non-empty serverInfo 계약 통과"로만 기록하고, `2025-11-25`/`shadcn 1.0.0`은 M3c-1 실측값으로 구분한다. 단일 실행의 무변경을 모든 원격 부작용 부재로 확대 해석하지 않는다.
- **다음은 M3c-3 계획 검토(구현 미착수).** 권한 등급 매핑·도구/인자 필터링·result-size enforcement를 이번 semantics 근거 위에서 설계·검토하고, 그 다음에야 registry profile 등록·handoff 연결로 진행한다. 이번 단계에서는 profile/registry/handoff/enforcement 어느 것도 구현하지 않았다.

## 2026-07-22 (V3 M3c-2 — read semantics probe P0/P1 보완)

- **고정 호출 계획은 export하지 않고 deep-freeze한다.** 실행에 쓰는 호출 목록·금지 목록·protocol allowlist는 non-exported 내부 상수 + runtime deep-freeze. 외부(runner/test)는 매번 deep clone getter만 본다. TypeScript `readonly`만 믿지 않고 런타임 변조 불가를 테스트로 강제. 시작 시 독립 contract(이름·순서·arguments canonical hash·중복 부재)와 exact 비교하고, M3c-1의 가변 export가 아니라 내부 exact set으로 검증한다.
- **budget은 전체 결과 크기로 판정한다.** text block 길이만이 아니라 CallToolResult 전체(content+structuredContent+isError) canonical serialization의 `resultChars`로 `withinProposedBudget`를 정한다. structuredContent/image/resource가 커도 budget에 반영된다. 여전히 측정만(자르지 않음), enforcement 없음.
- **파일시스템 무변경은 root·symlink·TOCTOU까지 방어한다.** root type/mode 포함, baseline symlink는 spawn 전 차단, 파일은 `O_NOFOLLOW` fd로 fstat/read해 snapshot 중 symlink 교체를 막고, 파일별·전체 read 상한을 둔다.
- **모든 실패 경로도 child close 확인 후에만 reject하고, close 전에는 임시 HOME/cache를 지우지 않는다.** cleanup 실패는 `cleanup_failed`로 표면화한다(임시 자원 leak를 숨기지 않음). 잔존 가능성은 fail-closed.
- **5개는 노출 승인이 아니라 검증 후보다(불변).** 이 offline 하드닝 이후에도 권한 분류·profile 등록·handoff 연결·result-size enforcement는 하지 않는다. 실제 5회 호출(승인 후)로 read-only·크기 근거를 확인한 뒤 별도 단계에서 진행한다.

## 2026-07-21 (V3 M3c-2 — controlled read semantics probe scaffold, offline)

- **읽기 후보 5개만, 고정 인자로, 코드 상수로 호출한다.** `get_project_registries`·`list_items_in_registries`·`search_items_in_registries`·`view_items_in_registries`·`get_item_examples_from_registries`. `get_add_command_for_items`·`get_audit_checklist`는 **호출·노출 후보에서 제외**하고 tools/call 생성 경로를 두지 않는다. package/command/args/tool/arguments 외부 주입 seam 없음.
- **"실제로 read-only인가"를 파일시스템 무변경으로 실측한다.** serviceCwd 전체를 호출 전/후 재귀 snapshot(경로·타입·mode·size·SHA-256)해 생성·수정·삭제·symlink가 하나라도 생기면 즉시 fail-closed. runtime/cache/home은 serviceCwd 밖 임시 경로로 분리해 "정상적 캐시 쓰기"와 "serviceCwd 변조"를 구분한다.
- **외부 결과는 untrusted data다 — 저장·출력·실행하지 않는다.** artifact에는 원문 대신 파생 지표(hash/count/type/elapsed/bytes/unchanged/budget)만 남기고 `externalDataUntrusted:true`로 표식한다. content 문자열을 model/Claude에 전달하거나 그 안의 지시를 실행하지 않는다.
- **budget은 이번 단계에서 측정만 한다.** 8,000 chars 초과를 자르거나 통과로 숨기지 않고 `withinProposedBudget:false`로 기록한다. result-size **enforcement는 아직 하지 않는다**(측정 근거를 모은 뒤 별도 단계).
- **5개는 "노출 승인"이 아니라 검증 후보다.** 이번 semantics 측정(승인 후 actual 5회)으로 read-only·결과 크기 근거를 확인한 뒤에만 권한 등급 매핑·registry profile 등록·handoff 연결·result budget enforcement로 진행한다. 이번 offline 단계에서는 그 어느 것도 하지 않았다.

## 2026-07-21 (V3 M3c-1 — actual live schema probe PASS)

- **M3c-1은 offline+actual live 완료로 확정하되, schema를 권한 근거로 승격하지 않는다.** 실제 shadcn MCP(protocolVersion 2025-11-25, serverInfo shadcn 1.0.0)에서 7개 도구 schema를 1회 실측(runner exit 0). **annotations/outputSchema는 전 도구에 없음** — read/write hint가 서버에서 제공되지 않았다.
- **description은 서버 제공 untrusted 정보다.** 이름과 마찬가지로 description·inputSchema 필드명만으로 read/write를 분류하지 않는다. 권한 분류는 실제 동작(semantics)을 통제된 방식으로 확인한 뒤에만 한다(M3a "플래그=격리 금지"의 연장).
- **버전 종속 실측.** shadcn@4.13.1 · protocolVersion 2025-11-25 조합의 스냅샷이며 버전 변경 시 재-probe로 재확인한다.
- **다음은 M3c-2 controlled read semantics 검증 계획.** 승인·격리 하에서 각 도구의 read-only 성격·결과 크기를 통제 확인한 근거로만 권한 등급 매핑·registry profile 등록·handoff 연결·result-size enforcement로 진행한다. 이번 단계에서는 profile 등록·handoff 연결·MCP 도구 호출·registry 변경을 하지 않았다.

## 2026-07-21 (V3 M3c-1 — schema probe P0 보완: 보안 경계·공식 계약·lifecycle)

- **실행 명령 우회 seam을 코드에서 완전히 제거한다.** `HARNESS_SHADCN_NPX_BIN` 지원 삭제 — `runShadcnSchemaProbe`는 항상 `npx --yes shadcn@4.13.1 mcp`만 실행한다. 테스트는 임시 PATH에 `npx` 이름 fixture를 두는 방식으로 격리(문서의 "주입 seam 없음" 주장과 코드 일치). runner import는 export 위치(`shadcnPilot.js`의 `checkComponentsJson`)와 정확히 일치시키고 offline smoke로 재발을 막는다.
- **schema object key는 마스킹 대상이 아니라 fail-closed 대상이다.** value는 scrub하지만 key가 secret/credential 형태면 이름을 바꿔 잘못된 schema를 저장하지 않고 `secret_in_schema_key`로 실패한다(원 key 미노출).
- **공식 MCP 계약을 근거로 검증한다.** protocolVersion은 stable `2025-11-25`를 요청하고 allowlist 내 이전 revision negotiation을 인정한다("특정 버전이 최신"이라는 문서 단정은 제거). initialize의 capabilities(.tools)·serverInfo(name/version)를 검증하고, Tool.description은 optional·title 수집·inputSchema/outputSchema root `type:"object"` 강제. **annotations는 untrusted hint** — 형식만 검증하고 권한 판정 근거로 쓰지 않는다.
- **성공은 child close 확인 이후에만 확정한다.** 수집 후 stdin을 닫고 bounded wait로 close를 기다리며(grace 후 SIGKILL), close 확인 전에는 result 반환·snapshot 저장을 하지 않는다. 미종료·잔존 가능성은 typed fail-closed. stdout byte 상한은 raw Buffer로 계산하고 StringDecoder로 멀티바이트 경계를 보존한다.
- **tools/call 부재는 로그 추측이 아니라 고정 operationSummary로 증명한다.** 결과에 `{initialize,initialized,toolsListPages,toolCalls:0}`를 반환하고 runner가 검사한다. snapshot에는 raw JSON-RPC payload를 저장하지 않으며 tools/call 생성 경로는 계속 없다.

## 2026-07-21 (V3 M3c-1 — tools/list schema discovery scaffold, offline)

- **schema probe는 shadcn 전용의 좁은 stdio JSON-RPC 경로로 구현한다.** 범용 MCP client를 만들지 않는다. `initialize → notifications/initialized → tools/list`까지만 허용하고 **tools/call 코드 경로 자체를 두지 않는다**(도구 실행 불가가 구조적으로 보장). MCP protocolVersion은 공식 stable spec 상수(`2025-06-18`)로 요청하고 허용 버전 집합 내에서만 negotiation을 인정한다.
- **실행 명령은 우회 불가로 고정한다.** `npx --yes shadcn@4.13.1 mcp`를 `shadcnDiscoveryProfile()`+`buildMcpConfig`로 pin 검증해 얻고, 외부에서 package/command/args를 주입하는 seam을 두지 않는다. 테스트는 launcher 실행 파일(`HARNESS_SHADCN_NPX_BIN`)만 교체하며 pinned args는 불변(M3c-0 HARNESS_CLAUDE_BIN과 동형).
- **직접 서버는 bare 도구명을 반환한다 — host가 namespacing한다.** claude 경유(M3c-0)는 `mcp__shadcn__*`를, 직접 stdio는 bare 이름을 준다. probe가 `mcp__<server>__`를 붙여 M3c-0 확정 7개와 정확 비교(누락/추가/중복/pagination 루프/상한 fail-closed).
- **schema 산출물은 raw protocol이 아니라 추출 schema만 저장한다.** `mcp-schema-discovery.json`(mode:`schema-discovery`·usableForHandoff:false)은 JSON-RPC envelope를 담지 않고 name/description/inputSchema(+outputSchema/annotations)만 담으며, 깊이·크기 상한·deep-scrub·wx·0600으로 보호한다. 타입은 PreflightSuccess/discovery와 분리해 승인 근거 오용을 막는다.
- **이름·schema를 권한으로 해석하지 않는다.** description·annotations를 봐도 read/write·browse/search/install/add로 분류하지 않는다. 권한 등급 매핑·registry profile 등록·handoff 연결·result-size enforcement는 **미착수**이며, 실제 schema 실측(runner 승인 실행) 이후 별도 단계(M3c-2+)에서 근거를 갖춰 진행한다.

## 2026-07-21 (V3 M3c-0 — 실제 live discovery 1회 실행, discovery offline+live 완료)

- **discovery는 offline+live 완료로 확정하되, 전체 M3c는 미완료로 둔다.** 실제 Claude Code 2.1.216에서 `shadcn@4.13.1` MCP를 strict 격리로 1회 discovery(exit 0/OK) → server `shadcn` connected + 도구 7개 실측. 격리·권한·redaction·cleanup·잔존 프로세스 검사 통과.
- **발견된 도구명을 권한으로 해석하지 않는다.** `get_*`/`list_*`/`search_*`/`view_*`/`get_add_command_*` 같은 이름은 read/write 성격의 근거가 아니다. `tools/list`의 inputSchema·실제 동작(semantics)을 실측하기 전까지 browse/search/install/add 등으로 매핑하거나 permissionMode를 부여하지 않는다. (M3a "플래그=격리 금지" 원칙의 연장 — "이름=권한 금지".)
- **버전 종속 실측(2.1.216)이며 도구 셋은 shadcn 버전에 종속된다.** shadcn@4.13.1·CLI 2.1.216 조합의 스냅샷이다. 버전 변경 시 재-discovery로 재확인한다.
- **다음은 M3c-1 `tools/list` schema·semantics 검증 계획.** 도구별 inputSchema·read/write 성격을 확정한 뒤에야 권한 등급 매핑·registry profile 등록·handoff 연결로 진행한다. 이번 단계에서는 profile 등록·handoff 연결·MCP 도구 호출을 하지 않았다.

## 2026-07-21 (V3 M3c-0 — offline hardening: 보안 경계는 핵심 API)

- **보안 경계는 runner가 아니라 핵심 API(`runShadcnDiscovery`)에 둔다.** 표준 registry 검사·package 고정·빈 도구 거부를 API가 강제하고, runner의 사전 검사는 보조로만 둔다(Codex가 API 직접 호출로 custom registry·빈 도구·foreign pin package를 통과시킨 재현을 근거로 승격). registry 검사는 config/runtime/spawn보다 **먼저** 실행해 실패 시 부작용(spawn·산출물) 0.
- **discovery package는 우회 불가로 고정한다.** `RunShadcnDiscoveryOpts.package`·`shadcnDiscoveryProfile(pkg)` 인자를 제거하고 항상 `shadcn@4.13.1`을 쓴다. 다른 exact-pin package도 주입할 수 없다(generic npx pin 검증은 adapter 계층에 유지).
- **빈 discovery는 실패다.** system/init에 shadcn MCP 도구가 0개면 `no_tools`로 fail-closed(성공은 1~64개). "연결됐지만 도구 없음"을 성공 스냅샷으로 저장하지 않는다.
- **오류·반환은 전 경로 scrub.** typed 오류를 그대로 rethrow하지 않고 code 보존 + message scrub으로 정규화한다(도구명/서버/stderr에 섞인 credential·sentinel 평문 노출 재현 차단). 성공 snapshot의 외부 문자열도 scrub하고 반환==저장(deepEqual)을 보장한다. `redactNames`는 scrub 전용이며 그 값을 discovery child env로 전달하지 않는다.
- **파일/스트림은 TOCTOU·무한 증가에 대비한다.** components.json은 `O_NOFOLLOW` fd로 열어 같은 fd로 fstat/read(경로 재오픈 없음), 64KiB+1 초과 미판독. stdout 1MiB·stderr 64KiB 상한으로 무개행 stdout·거대 stderr에 의한 메모리 폭증을 막는다. 강제 env(MCP 격리 변수)는 testEnv가 덮어쓸 수 없다.
- **snapshot 기록은 exclusive-create로 부분 성공을 남기지 않는다.** wx 충돌·기록 실패도 typed+redacted `persist` 오류로 반환하고 기존 파일/symlink를 덮어쓰지 않는다.
- **여전히 M3c 완료가 아니다.** 실제 도구명·profile 등록·handoff 연결·result-size enforcement는 미확정. live discovery는 별도 승인 후 수동 실행.

## 2026-07-20 (V3 M3c-0 — shadcn discovery scaffold, offline)

- **M3c는 "도구명 발견 기반"부터 offline로만 착수한다.** 실제 shadcn MCP 도구명을 모르는 상태에서 profile을 먼저 등록하거나 browse/search/install/add를 expected 도구로 추측하지 않는다. discovery 산출물로 실측한 뒤에 profile·handoff를 붙인다. **M3c 완료로 문서화하지 않는다**(discovery scaffold offline 완료까지).
- **discovery는 runPreflight와 타입·API로 분리한다.** runPreflight의 exact-profile 검증(정확 서버·도구 일치)을 완화하지 않는다. discovery는 도구명이 미지이므로 별도 `runShadcnDiscovery`로 "shadcn 단일 서버·shadcn prefix 도구만" 수집한다. 산출물은 `mcp-discovery.json`(mode:"discovery"·usableForHandoff:false, `ShadcnDiscoveryResult{discovery:true}`)로 `PreflightSuccess{ok:true}`와 섞이지 않게 하여 handoff/preflight 승인 근거로 오용될 수 없게 한다.
- **표준 registry만 허용, 나머지는 fail-closed.** components.json이 custom/private/third-party registry(항목 있음·plain object 아님)를 선언하면 거부. malformed·symlink·비일반 파일·64KiB 초과도 거부. 오류에 파일 내용·credential을 담지 않고 .env·환경 secret을 읽지 않는다.
- **shadcn 실행은 고정 pin(shadcn@4.13.1)만.** `@latest`/무버전/범위는 기존 npx pin 규칙(compileServer)으로 거부. discovery도 이 경로를 재사용한다.
- **live discovery는 수동 opt-in 전용.** `HARNESS_LIVE_M3C_DISCOVERY=1` 없이는 거부(Claude/npx 미호출), npm test/CI 비대상. 실제 실행 시 package download·네트워크·구독 사용량이 발생하므로 자동화하지 않는다. 이번 세션에서 실행하지 않았다.

## 2026-07-20 (V3 M3b.2 — actual live acceptance 완료(PASS))

- **M3b.2를 offline + actual live 완료로 확정한다.** 실제 Claude Code 2.1.215에서 live runner가 exit 0/PASS. 검증 항목: exact Hook 6종, empty MCP snapshot(servers=[]/tools=[])·config({}), planning contextRoot 접근(00_IDEA/06_CEO_DECISION Read 성공·serviceCwd docs 미생성), Read 성공/실패 callId correlation, Bash 승인(permission_requested callId=null + tool_requested/succeeded 동일 callId, sentinel 비출력), Write 수동 거부(requested+permission·marker 부재, denied 미합성), SessionEnd 1건, ambient MCP/Hook canary 미기동, trace redaction·권한·원문 미저장, run_state 불변, argv `-p`/stream-json 없음.
- **격리·Hook 계약 통과는 이 CLI 버전(2.1.215) 실측이다.** M3a 원칙 계승 — CLI 버전 변경 시 재검증한다("플래그=격리/계약" 금지). runner는 재현 가능한 수동 acceptance 자산으로 유지(`HARNESS_LIVE_M3B2=1`, npm test/CI 비대상).
- **앞선 실패 시도는 역사 기록으로 남긴다.** 1차 argv P0(무효), 2차 P0-1 planning 경로·P0-2 sentinel 출력. 삭제하지 않는다(재발 방지 근거).
- **다음은 M3c(shadcn read) 파일럿 계획 검토.** 구현 착수가 아니라 계획·acceptance 설계부터. 활성 설계 문서 기준 유지.

## 2026-07-20 (V3 M3b.2 — 두 번째 live P0 2건: planning 경로·sentinel 출력)

- **두 번째 live도 전체 PASS로 기록하지 않는다.** argv `--` 꼬리는 통과했으나 planning context 경로 단절(P0-1)과 sentinel TUI 평문 출력(P0-2)이 드러났다. 상태는 **M3b.2 live 재검증 대기**.
- **planning contextRoot ↔ serviceCwd를 명시적으로 분리한다(P0-1).** task prompt의 `Include`는 `docs/*.md` 상대경로인데 대화형 cwd는 serviceCwd다. handoff는 `contextRoot=projectPaths(project).root`를 argv `--add-dir`로 열고, initialPrompt에 "Include의 docs/…는 contextRoot 절대경로, serviceCwd 아래 docs 생성 금지, WORKLOG 대상=contextRoot/docs/WORKLOG.md" 계약을 명시한다. 승인 preview에도 두 경로를 별도 표시한다. `--disallowedTools mcp__* -- <initialPrompt>` 꼬리는 유지.
- **live 검증용 fake sentinel은 값을 출력하지 않는 방식으로만 다룬다(P0-2).** Bash 검증을 `printf '%s' "$TOKEN"`(값 출력) → `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'`(존재만 확인)로 바꾼다. 실제 sentinel 값은 terminal/settings/config/snapshot/trace/outcome 어디에도 출력하지 않는다. 이번에 출력된 것은 runner가 심은 fake sentinel로 **실제 credential이 아니다**. collector redaction 단위 테스트는 유지.
- **경로 계약도 회귀 테스트로 고정한다.** `--add-dir`=contextRoot, prompt의 절대 contextRoot·WORKLOG 경로, serviceCwd에 docs 미생성을 core 단위 테스트와 runner 사후 검증 양쪽에서 강제한다(실제 Claude 없이도 구조 회귀 포착).

## 2026-07-20 (V3 M3b.2 — 첫 live 시도 무효(argv P0))

- **첫 live acceptance 시도는 무효로 확정한다.** Claude Code 2.1.215에서 대화형 argv `--disallowedTools mcp__* <initialPrompt>`가 `--disallowedTools`(가변 인자) 값으로 프롬프트를 소비해 `Permission deny rule "..." matches no known tool` 경고가 폭주했다. 세션이 acceptance 절차를 받지 못했으므로 **Hook 검증은 수행되지 않았고 PASS로 기록하지 않는다.**
- **대화형 argv는 옵션 종료 구분자 `--`로 프롬프트를 격리한다.** 꼬리를 `--disallowedTools`, `mcp__*`, `--`, `initialPrompt`로 고정한다. 가변 옵션 뒤 positional은 항상 `--` 뒤에 둔다(향후 옵션 추가 시에도 이 규칙 유지). 대화형 TUI·stdio inherit·`-p`/stream-json 미사용은 불변.
- **argv 계약은 회귀 테스트로 고정한다.** 프롬프트가 deny 값 영역에 들어가지 않음을 core 단위 테스트와 runner 사후 검증 양쪽에서 강제한다. 실제 Claude 없이도 argv 구조 회귀를 잡는다("플래그 존재=정상" 금지, 실측 P0 방지).
- **상태는 "M3b.2 live acceptance 재실행 대기"로 유지한다.** 수정은 offline 검증까지만. 실제 Hook 검증은 사람이 runner를 재실행해야 성립한다.

## 2026-07-19 (V3 M3b.2 — Interactive handoff, offline)

- **handoff는 대화형 TUI를 "여는" 것까지만.** `claude <initialPrompt>` + `stdio:"inherit"`. 코드 수정 권한은 Claude Code 자체 permission이 게이트한다. `-p`/stream-json/stdout 파싱은 대화형에 쓰지 않는다(그건 M3a headless preflight 전용).
- **spawn 전 fail-closed preflight 필수.** 빈 MCP config(`{mcpServers:{}}`) + `--strict-mcp-config`로 헤드리스 preflight를 돌려 ambient MCP 서버/도구가 하나라도 보이면 차단하고 spawn하지 않는다. "플래그=격리"가 아니라 snapshot 실측으로만 판정(M3a 원칙 계승). expected 서버/도구는 모두 빈 배열.
- **allow-empty는 별도 명시 경로.** profile 기반 `buildMcpConfig`의 `no_mcp_binding` 기본 거부는 유지하고, handoff용 빈 config는 `buildEmptyMcpConfig`/`writeEmptyMcpConfig`로 분리한다.
- **격리는 CLI 인자로만, managed policy 우회 없음.** `--setting-sources ""`(user/project/local settings·Hook 격리), `--mcp-config`(빈), `--settings`(런타임 hook settings), `--permission-mode default`, `--tools default`, `--disallowedTools mcp__*`, env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **Hook settings는 공식 exec form.** shell 문자열 조합 대신 `command`=node 실행 파일 + `args`=[collectorPath, hookKind]. shell 파싱/이스케이프 경유가 없고 argv가 collector parseArgs와 정확히 일치한다. collector는 배포 가능한 `dist/tools/hookCollector.js` 절대경로.
- **run_state.handoff는 실제 spawn된 경우에만.** print/reject/preflight 실패/spawn 실패/non-TTY/missing binary에서는 기록하지 않는다. 대화형 종료코드는 기록하지 않고 completed 상태도 바꾸지 않는다.
- **비-TTY·바이너리 부재는 실패가 아니라 폴백.** 비-TTY는 대화형 세션을 열지 않고(--yes와 조합돼도 백그라운드 TUI 금지), 바이너리 부재는 설치 안내 + 재진입 명령. `--print`는 실행·preflight·상태 변경 없이 재진입 명령(`harness handoff ... --yes`)만 출력하며, 실제 실행 시 preflight를 다시 거친다.
- **runtime 산출물은 최소 권한·gitignore.** `outputs/runtime/`(기존)·`outputs/tool-trace/`(추가) 커밋 금지. mcp-config/hook-settings는 dir 0700/file 0600. raw Hook payload·transcript는 저장하지 않는다.
- **[P0] collector는 배포 산출물 절대경로만.** `PACKAGE_ROOT/dist/tools/hookCollector.js`(dev tsx·prod 동일). import.meta.url 상대 계산은 dev에서 존재하지 않는 src/*.js를 가리키므로 쓰지 않는다. spawn/preflight 전 존재·일반 파일 검증, 없으면 `setup_failed`.
- **[P0] 산출물 파일은 최소 권한 + exclusive-create.** ToolTrace JSONL은 spawn 전 빈 0600 파일로 사전 생성하고 collector가 append(모드 불변). hook-settings/mcp-config/tools-snapshot 0600, dir 0700. 기존 파일·symlink는 `wx`로 fail-closed(조용한 덮어쓰기·symlink 공격 방지). 기본 handoff id는 randomUUID 포함(충돌·예측 방지).
- **[P1] redaction refs는 env 이름에서 파생, 값은 절대 기록 안 함.** `process.env`에서 이름이 secret 형태(TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL/AUTH)이고 값이 있는 항목의 **이름만** refs로 파생 → `HARNESS_TOOL_SECRET_REFS`(이름) + collector가 값 마스킹. preflight `redactNames`는 오류 scrub 전용이며 그 secret 값을 preflight child env로 전달하지 않는다. spawn/setup/preflight 오류·로그·outcome은 `redactSecrets` 통과. raw process.env·secret 값 자체는 출력하지 않는다.
- **[P1] `--setting-sources ""`가 서비스 레포 CLAUDE.md를 로드하지 않으므로 프롬프트로 보완.** initialPrompt에 "서비스 레포 AGENTS.md·CLAUDE.md 존재 시 먼저 읽고 준수" 명시. managed policy 우회는 계속 금지.
- **M3b.2는 offline 기반 완료.** 다음은 M3c가 아니라 **M3b.2 actual Claude Hook live acceptance**(수동): `--setting-sources ""` 실제 수용, exec-form Hook 6종 실제 등록, 6 payload(PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/PermissionDenied/SessionEnd), trace redaction·0600, TUI 유지·stream-json 미사용. **M3c(shadcn read)는 live 통과 후.**

## 2026-07-19 (V3 M3b.1 — HookTrace 기반, offline)

- **Hook은 관측만, 승인 결과를 유추하지 않는다.** PermissionRequest→요청 사실만, PermissionDenied→auto-mode denial만. **PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없다** → callId=null이며 synthetic ID를 만들지 않는다. Hook만으로 수동 승인/거부 결과를 정확히 연결할 수 없음을 `permissionOutcomeObservable:false`로 명시하고 denied로 추측 금지(타입·테스트·문서에 한계 명시).
- **MCP server는 전달된 exact tool map으로만 판정.** 이름(`mcp__srv__t`)에서 추측하지 않는다(미매핑→null).
- **원문 미저장 원칙.** transcript_path·raw tool_response는 기록하지 않고 tool_response는 byte 수만. 입력/오류는 크기 상한 절삭.
- **secret은 이름만 설정·argv에.** 값은 collector가 hook 실행 시점 process.env에서 조회해 redaction. 민감 key는 값 통째 마스킹.
- **collector 종료코드로 실행 게이팅.** PreToolUse audit/deny 실패·거부는 exit 2(차단), 사후 Hook 실패는 exit 1(경고, 원 실행 왜곡 금지), 정상은 stdout 미사용(Claude Hook JSON 해석 비간섭).
- **RunEvent 매핑(`toRunEvent`)은 post-session/테스트용.** TUI 중 실시간 emit하지 않는다.
- **대화형은 `stdio:inherit` + Hooks만.** stream-json 파싱은 M3a headless preflight 전용이며 대화형 세션에 쓰지 않는다(설계 정정).
- **collector fail-closed 강화(P0/P1).** env는 엄격 검증(JSON fallback 금지), payload 계약(hook_event_name/session_id/tool 필드·deny=PreToolUse 전용) 위반은 blocking Hook에서 exit 2. 오류에 stack/env/secret 미출력.
- **SessionEnd는 종료 사실만 기록.** 승인 결과나 unresolved permission 목록을 추측·계산하지 않는다(공식 payload에 correlation ID가 없어 수동 승인/거부를 정확히 연결할 수 없기 때문).
- **크기·깊이는 UTF-8 byte·재귀 depth 상한으로 실제 강제.** 병렬 append 라인이 작게 유지되어 원자성 확보.

## 2026-07-19 (V3 M3a — live acceptance)

- **live acceptance는 수동 전용, 명시 opt-in.** `scripts/m3a-live-preflight.mjs`는 `HARNESS_LIVE_M3A=1` 없이는 거부하고 npm test/CI에서 실행하지 않는다. 실제 Claude를 호출하므로 자동 파이프라인에 편입하지 않음.
- **격리 통과는 CLI 버전에 종속.** 2026-07-19 실측(Claude Code 2.1.215)에서 strict-mcp-config가 ambient canary를 차단함을 확인했으나, 이는 해당 버전의 실측이다. CLI 버전 변경 시 flag/`system/init`/격리 동작을 재검증한다("플래그 존재=격리" 금지 원칙 유지).
- **live runner/fixture를 저장소에 커밋한다.** 재현 가능한 수동 acceptance 자산으로 유지(이전의 "커밋 금지"는 검토 단계 한정이었음). 단 production MCP 구현이 아니라 canary acceptance 더블임을 헤더에 명시.

## 2026-07-19 (V3 M3a — live 전 보안 보완)

- **npx만 정확 고정 버전 강제.** 임의 dist-tag(`@latest`/`@next`)·범위(`@^`/`@~`/`@*`)·무버전을 npx에서 거부(재현성·공급망). node/local executable엔 미적용(오탐 방지).
- **preflight child env는 allowlist + 선언 secret만.** `process.env` 전체 전달은 미선언 토큰/키 유출 경로 — 폐지. 테스트용 env 주입은 production allowlist와 섞지 않는 명시적 `testEnv` seam으로 분리(프로덕션 경로 오염 방지).
- **반환 snapshot도 redacted, 저장본과 동일.** 호출자가 받는 객체와 파일이 달라 redaction이 우회되는 구멍 제거. 실패 시 성공 snapshot 미생성(fail-closed 일관).
- **중복 파생 도구는 조용히 dedupe하지 않고 거부.** 노출 표면 착오를 감추지 않기 위함. transport 혼합·credential 형태·secret 실값 포함도 기록 전 거부.

## 2026-07-19 (V3 M3a — Headless MCP preflight)

- **격리는 snapshot 실측으로만 판정.** `--strict-mcp-config`/`--mcp-config` 플래그 존재를 격리로 신뢰하지 않고, `system/init`의 실제 mcp_servers·tools를 기대치와 정확 비교(canary 자동 실패). 실패 시 typed error로 fail-closed — 성공 result를 절대 반환하지 않음.
- **preflight는 M2.1 fail-closed와 별도 경로.** runWorkflow의 MCP profile 거부는 유지하고, preflight는 M3에서 MCP를 여는 유일한 검증 관문으로 독립 배선. (해제는 preflight 통과가 전제.)
- **config는 참조된 서버만·secret 값 미기록.** binding이 참조하는 서버만 mcp-config에 포함, `@latest` 금지, secret은 이름만(값은 config·snapshot·error에 redaction). runtime 산출물은 gitignore.
- **init 수집 후 의도적 종료는 실패가 아니다.** headless preflight는 init만 필요하므로 수집 즉시 kill하고, 그 종료 코드를 성공/실패 판정에 쓰지 않음(오판 방지). timeout·비정상 종료(무 init)만 실패.
- **파서는 exec/streamParser 재사용.** 신규 파서를 만들지 않고 init 이벤트에 mcpServers 정규화만 추가(connected는 "connected"만).

## 2026-07-19 (V3 M2.1 — P0 보완)

- **secret 값은 provider context로 전달하지 않는다.** execContext에는 이름(redactNames)만 담고, 값은 claude-code provider가 내부에서 `collectSecretValues(process.env)`로 조회 → redaction 표면 축소.
- **MCP profile은 loader/compile이 아니라 run 경로에서 fail-closed.** per-tool 강제(M3 snapshot) 없이 실행하면 exposedTools가 거짓 강제가 되므로 run_start 이전 거부. 단 loader/compile은 성공시켜 M3가 동일 profile을 로드·검증할 수 있게 한다.
- **claude 실행 파일/타임아웃을 호출 시점에 읽는다.** 모듈 로드 시 고정 → 스텁 주입 불가였음. 동작 중립적 변경으로 실제 spawn argv 테스트 가능.
- **`toolProfilesPath` seam 추가.** registry에 MCP profile을 넣지 않고도 run-level 거부를 테스트하기 위한 최소 override(테스트/M3 겸용).

## 2026-07-17 (V3 M2 — Capability/ToolProfile 정책 계층)

- **`exposedTools`는 입력이 아니라 compile이 bindings에서 파생.** 노출 도구를 손으로 나열하지 않고 builtin/mcp binding에서 계산 → binding tools ⊆ exposed가 구조적으로 보장. preapproved/denied만 명시 입력.
- **`repo_write_direct` 폐기, 쓰기 권한을 세분화.** reserved(local_workspace_write, pull_request_create) vs deny(remote_repository_write, pull_request_merge, ...). "로컬 쓰기/PR 생성"과 "원격 쓰기/머지"의 위험도가 달라 계층을 분리.
- **fail-fast는 capability 이름이 아니라 compiled policy의 binding 실행 주체로 검증.** builtin→provider, mcp→provider MCP, internal_adapter→Adapter Registry, cli→실행 환경. `assertProviderSupports(ids)` 폐기 — 이름만 보면 "어떻게 실행되는가"를 놓친다.
- **JSON Schema는 런타임 미실행.** 신규 의존성(ajv 등) 추가 없이 수동 structural+semantic validator 사용. `schemas/*.json`은 계약 문서 + 향후 정식 validator용.
- **`--bare`는 argv 생성·검증까지만(M2).** planning 격리 = `--strict-mcp-config` + 내장도구 제한(`--tools`). snapshot 기반 회귀 판정·strict empty fallback 자동 강등은 실제 claude 실행이 필요하므로 M3.
- **회귀는 byte 동일 대신 golden snapshot.** 가변 메타데이터(project/타임스탬프/elapsed_ms) 제거 후 정규화 비교 + 시맨틱 assertion.
- **registry에는 실행 가능한 profile만.** planning-none/planning-local-readonly만 등록. Tavily/shadcn 등은 실행기(어댑터/MCP 배선)가 붙는 M3·M4까지 미등록 — 등록 즉시 fail-fast로 걸릴 profile을 배포하지 않음.

## 2026-07-17 (V3 M1 — 진행 이벤트 모델)

- **기존 `ProgressReporter`(start/note/stop)를 이벤트 모델(emit(RunEvent))로 교체.** 병존 대신 교체 — 두 진행 시스템은 부채. 렌더러가 이벤트 소비자가 되고 CLI 출력 계약은 보존.
- **run_end는 try/finally로 항상 방출.** "정상 완료 직전에만" 방출하는 구조 금지 — provider/step 예외에도 step_end{ok:false}+run_end{failed}+렌더러 정리가 보장돼야 함.
- **note 이벤트에 level(info|warn) 포함.** 기존 재생성 경고 라인을 손실 없이 보존.
- **gate/approval은 스피너 미가동.** approval은 stdin(승인 프롬프트)을 기다려 \r 스피너와 충돌 — 이벤트는 방출하되 렌더러가 안 그림 (F2.2).
- **`src/tools/trace.ts`는 M1에서 범용 JSONL writer로만.** ToolTrace 공통 스키마 고정·runWorkflow 배선은 M3(실제 tool 이벤트 방출 시점)로. 골격을 특정 스키마에 조기 결박하지 않음.
- **step_timings resume 복원은 기존 배열(gate_jumps 등)과 동일하게 완료분 보존.** 완료 step 재실행/중복 기록 없음.

## 2026-07-17 (V3 M0 — 문서 동기화)

- **CLI 버전은 package.json 단일 원본.** `cli.ts`가 런타임에 `../package.json`을 읽어 버전 드리프트를 구조적으로 제거. 하드코딩·별도 일치 테스트 불필요.
- **V3 활성 구현 기준은 두 문서로 한정.** `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md` + `V3_MCP_CAPABILITY_TOOL_PROFILES.md`. `V3_KICKOFF_SUPERSEDED.md`는 archive로 이동(과거 계획, 구현 근거 아님). backlog 문서는 사용자가 V3 작업을 명시 요청할 때만 활성 2문서를 읽는다.
- **M0 범위 엄수.** M1+ Capability/Profile/MCP/handoff/report 코드는 이번 세션에서 구현하지 않음. exec/mission ↔ V3 문서 괴리는 후속 항목으로만 기록(관계없는 리팩터링 금지).

## 2026-07-08 (실행 계층 방향)

- **실행 계층(문서→자동 실행→병행/다중 라이브 세션)은 v3+ 로 분리, 설계 먼저.** 창업자 비전은 ROADMAP v3 "실행 연결 실험"보다 넓음(병행/다중 세션 오케스트레이션). 바로 구현하지 않고 별도 Fable 모드 세션에서 아키텍처 설계 → `docs/reference/EXECUTION_LAYER_DESIGN_BRIEF.md`가 그 핸드오프. 설계 확정본은 `EXECUTION_LAYER_ARCH.md`(예정) + ROADMAP v3/v4 갱신.
- **진행 표시(ProgressReporter)는 UX 개선으로 즉시 반영.** 실행 계층 설계와 독립적이고, 다중 세션 상태판의 첫 조각도 됨. core/CLI 분리 원칙 유지(core는 TTY 무지).

## 2026-07-06

- agent prompt 파일명에서 버전 접미사 제거 (버전은 파일 내부 헤더로 관리)
- harness init 생성 docs = 6개 (00_IDEA, TASKS, DECISIONS, CONTEXT_SUMMARY, WORKLOG, API_CONTRACT), HANDOFF.md v1 제외
- 01~06 번호 문서는 workflow 실행 시 생성
- 구버전 가이드(solo_founder_harness_dev_guide)와 COMBINED_CORE_PROMPTS.md는 레포에서 제외
- v1 완료 기준 = acceptance test 1~5 전부 통과

## 2026-07-06 (2차)

- run_state.json v1 필수 필드 확정 (workflow_id, project, completed_steps, failed_agent, warnings, started_at, finished_at). resume은 v2
- 결과 저장 시 필수 섹션 헤더 검증(경고 수준) v1 포함
- v2/v3 로드맵은 docs/reference/ROADMAP.md — v1 개발 중 로드 금지
- v2 최우선 결정 = provider 전략 (API 직접 vs Claude Code subagent) → backlog/PROVIDER_STRATEGY_TODO.md
- 개발은 Opus 모델로 진행, 운영 규칙은 prompts/opus_optimization_guide.md
- IMPLEMENTATION_PLAYBOOK.md 추가: 세션 5개 기준 단계별 진행 순서 (사람용, Claude 기본 로드 제외)

## 2026-07-06 (v2 provider 결정)

- **provider 전략 = C안 확정**: 인터페이스에 mock/claude-code(B안,구독)/anthropic(A안,API) 3종, 플래그 교체. 지금은 claude-code로 운영, A안은 사용자가 종량과금 원할 때 추가.
- 이유: Claude.ai/ChatGPT 구독은 API 접근 미포함(별개 청구). 사용자는 기존 구독으로 추가비용 0 원함 → B안 우선.
- Provider.generate() 동기→비동기 + token usage 필드 신설(A안 예산상한 대비). mock은 계속 유지(acceptance 기반).
- 상세 설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md

## 2026-07-06 (v2 루프 아키텍처)

- workflow `steps`를 선형 `string[]`에서 `(string | {critique_loop})[]` union으로 확장 (V2_KICKOFF "steps→loop 확장"). CEO 게이트도 이 union에 `{gate}` 추가로 얹을 예정.
- Red Team 비평 루프는 **기존 mvp-planning에 내장**(새 워크플로우 추가 X) — acceptance Test 2의 "Workflows (4)" 개수 유지 위해. idea-validation 등 나머지는 선형 유지.
- 비평 루프 종료 조건 = critic 출력의 "### Critical" 리스크 소멸 OR max_rounds 소진. 무한루프 방지로 max_rounds 필수.
- priorFindings를 Map(upsert)로 변경 — 루프에서 agent 재실행 시 handoff 요약 중복/누적 방지, 순서 유지.
- 재생성 로직(v2-3)을 runStepWithRegen 헬퍼로 추출해 선형/루프 양쪽에서 재사용.
- CEO 게이트를 union에 `{gate}`로 추가(V2_KICKOFF 4번). full-predev에 내장(축소→pm, 검증→research), max_jumps로 무한루프 방지.
- 판정 추출(extractDecision)은 Main Judgment + Decisions 섹션만 검색 — 문서 전체 검색은 Input Summary의 역할설명("진행/축소/검증...")을 오탐하므로 금지.
- anthropic provider(A안): 프롬프트 빌더를 promptParts.ts로 claude-code와 공유(중복/drift 방지). 기본 모델 opus-4-8, 기본 provider는 mock 유지. 실제 유료 호출은 사용자 키 세팅 후 검증.

## 2026-07-07 (라이브러리화 방향)

- 하네스 배포 모델 = **설치형 라이브러리**로 전환 (사용자 의도: 하네스 하나에 서비스 쌓지 말고 서비스 레포마다 설치). 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(CWD, 데이터)로 분리.
- projects/<name> 구조와 --project 플래그는 **유지**(최소 변경, acceptance 보존). "레포=단일 프로젝트"로 --project 없애는 건 별도 결정으로 보류.
- npm publish는 하지 않음 — install-ready(git/로컬 설치)까지. 실제 배포는 사용자 결정.
- 사용자 원래 기획 = 에이전트 분리(FE/BE 전문화). 3층으로 분해: ①정적 전문화 에이전트 추가 ②동적 분리 게이트 ③Claude Code 병렬 실행 연동(v3). 실제 병렬 코딩은 하네스가 아니라 Claude Code 영역(하네스는 기획문서+task-prompt 생성기). 상세: [[v2-provider-decision]] 다음 방향.

## 2026-07-07 (동적 분화 B-② 구현)

- 동적 분화 = `{fanout}` step. planner가 SPAWN 형식으로 하위 에이전트 선언 → fanout이 파싱해 런타임 생성·실행.
- **하위 에이전트는 레포에 영구 등록하지 않음** — 런타임 AgentDef + 생성 브리프(agentPromptText)로 per-run 생성. private/read-only 패키지와 충돌 회피, "동적"의 본질에 부합.
- **사람 승인 게이트 유지**(ROADMAP 원칙): 기본은 계획만 기록(executed:false), `--allow-spawn` 있을 때만 실제 실행. 자동 무단 생성 안 함.
- ①정적 전문 에이전트 추가는 보류 — 동적 분화로 갈음. 실제 병렬 코딩(B-③)은 여전히 Claude Code 영역(v3).

## 2026-07-07 (B-③ 멀티에이전트 task-prompt)

- B-③ = task-prompt를 멀티에이전트 실행 스펙으로 확장. spawned_agents 있으면 FE/BE별 병렬 subagent 지시문 생성.
- **경계 결정**: 하네스는 실행 "스펙 생성"까지만. 실제 병렬 코딩은 Claude Code subagent가 **사람 승인 후** 수행. 하네스가 직접 코드 실행/세션 자동 spawn 안 함 (v1부터의 "코드 자동 실행 금지" + ROADMAP "사람 승인 게이트" 유지). Claude Code는 병렬 subagent 능력 이미 있음 → 하네스는 구조화된 handoff만 제공.
- 하네스→Claude Code 실행 자동 트리거는 신중히(보류). 승인 게이트 없이는 안 함.

## 2026-07-07 (Obsidian 연동)

- Obsidian 연동 = **run_state 기반 read-only export**. 원본 projects/ 파일은 건드리지 않고 vault에 사본(frontmatter+wikilink 부여) 생성 → 안전(비파괴), 재실행 시 vault만 갱신.
- **opt-in**: `--vault` 또는 `HARNESS_VAULT` 있을 때만 동작. 기본 파이프라인/acceptance 무영향. export 실패는 경고로만 처리(실행 결과 저장 우선).
- 노트 구조 = agent별 노트 + run 인덱스(MOC). wikilink는 실행 순서(completed_steps) 기반 이전/다음/인덱스 + MOC의 순서 링크. frontmatter tags(harness/workflow/project/moc)로 그래프뷰 군집화. → V2_KICKOFF "양방향 링크·그래프뷰" 충족.
- vault를 실행 트리거로 삼지 않음 — 어디까지나 결과 아카이빙/지식그래프 용도.

## 2026-07-07 (v2 범위 정합성 정리)

- **배경**: "v2 스펙"이 두 벌이었다 — ①ROADMAP.md의 v2 목록(v1 때 적어둔 희망 목록) vs ②V2_KICKOFF.md(실제 착수 계획: provider 전략 + 루프 3종 + Obsidian). **실제 개발은 V2_KICKOFF를 따랐다.** 스코프 락 원칙("backlog → 다음 버전 스펙 → 구현 순서로만 이동")상 V2_KICKOFF로 승격되지 않은 ROADMAP 항목은 미구현으로 남았다. 버그/누락이 아니라 승격 게이트 미통과.
- **결정**: 아래 ROADMAP v2 항목들을 지금 구현하지 않고 **명시적으로 보류**한다(문서에 상태 표기, ROADMAP "v2 포함" 범례 ✅/⚠️/⏸).
  - `token budget 상한/중단` — 예산 상한이 실제로 필요한 종량 API(anthropic) 경로가 아직 미사용/미검증. mock=무료, claude-code=구독(회당 과금 없음) → 필요 미발생. **anthropic 실사용 시작 시 재검토.**
  - `run --resume` — mock 즉시, claude-code ~10분 수준. 중간 실패 재개 실익이 아직 작음.
  - `step 사이 승인 게이트` — 코드가 실제로 산출물을 생성하는 유일 지점(분화)은 `--allow-spawn`으로 이미 승인 게이트 존재. 일반 step은 결과를 사람이 사후 검토 → 매 스텝 승인은 마찰만 큼.
  - `schema validation 강화(내용 길이/형식)` — 주 실패모드(섹션 누락)는 재생성 루프가 처리. 내용 품질 검증은 기준이 애매하고 ROI 낮음.
  - `prompt CHANGELOG` — 파일 내부 버전 헤더는 v1부터 존재. 별도 CHANGELOG는 필요 미발생.
- **사실상 달성(다르게 구현)**: Red Team 편향 분리 — handoff(priorFindings)가 각 agent의 결론(Main Judgment 한 줄, extractMainJudgment)만 전달하고 전체 추론 문서는 안 넘김. red_team 포함 모든 하류 agent가 결론만 봄. red_team 전용 로직은 아니지만 편향 분리 목적은 충족.
- **provider는 초과 달성**: ROADMAP은 "실제 provider 1개"였으나 3종(mock/claude-code/anthropic) 구현.
- 이 정리는 코드 변경 없음(문서 정합성만). 보류 항목은 실전 필요 발생 시 v2.5/v3 스펙으로 승격해 구현.

## 2026-07-07 (v3 킥오프 — 보류했던 안전장치를 v2.5 Phase 0로 재승격)

- **결정 반전**: 바로 위 "v2 범위 정합성 정리"에서 보류(⏸)했던 `run --resume` / `token budget` / `approval gate`를, V3_KICKOFF.md(Fable 5)가 v3 반자동 실행(`harness execute`)의 **선결 안전장치**로 재평가 → v2.5 Phase 0(0-1~0-3)으로 재승격해 구현했다.
- **사유**: v3-1(task prompt → Claude Code 반자동 실행)은 파일을 실제로 바꾸는 executor다. 그 전에 (a)실패 재개(resume), (b)토큰 상한(budget), (c)실행 직전 사람 승인(approval)이 없으면 안전하지 않다. v2 때는 "종량 API 미사용 + 매 스텝 승인 마찰"이라 보류가 타당했지만, **v3 실행 연결을 목표로 잡는 순간 이 셋은 선결 조건이 된다.** 보류 사유가 사라진 것 — 스코프 확장이 아니라 목표 변경에 따른 재평가.
- **Red Team 편향 분리(0-4) 강화**: v2에서 "사실상 달성(결론만 handoff)"으로 봤으나, critic이 **전체 findings 체인**을 보면 앞선 에이전트 합의에 anchoring된다. → critic 호출 시 target 결론만으로 격리(`contextMode=conclusion_only`, priorFindings 제한)해 명시적으로 강화. 일반 step은 full 유지.
- **스코프 락 유지**: V3_KICKOFF에 없는 기능은 추가하지 않았다(HARNESS_FAIL_AT/HARNESS_MOCK_TOKENS는 문서가 명시한 "강제 실패 stub" 검증 방식). 0-5 이후 Phase 1(도그푸딩)로 넘어가며, **실제 아이디어 2개 검증 전까지 v3 신규 기능(execute/report/security baseline) 미착수.**
- 검증: mock acceptance 57/57. anthropic 유료 실검증과 v2.5.0 태그는 사용자 액션으로 남김.

## 2026-07-08 (Phase 1 도그푸딩 결론 — v3.0 코딩 진입 보류)

- **v2.5.0 릴리스 완료** (develop→main, 태그+push).
- **Phase 1 도그푸딩 결과**: 하네스 핵심 파이프라인(게이트 두 분기·critique_loop·편향분리·분화+allow-spawn·승인게이트·토큰계측)이 실제 LLM에서 설계대로 작동함을 확인. 스키마 경고 0. 남은 이슈는 기능 결함이 아니라 **관측성**(진행률·되돌림 가시성·판정근거 기록).
- **결정: Phase 2(v3.0 코딩) 진입을 보류한다.** 근거 = 하네스 self-review(mvp-planning)의 red_team Critical: "v3 착수 조건은 '아이디어 2개 검증 + **개발 착수 1건**'인데 개발 착수 0건. 조건 미충족 상태로 v3 기능을 구현하면 하네스가 자기 진입 게이트를 어기는 첫 사례가 된다."
  - founder_ceo도 동일 판정: v3 첫 작업은 코드가 아니라 "실제 아이디어 1개를 기존 task-prompt로 개발 착수까지 손으로 완주"해 게이트를 채우는 것.
  - execute: 안전경계 시나리오("승인 게이트 이후 실패 시 롤백 주체")가 서지 않으면 만들지 않음. 현재 plan-only도 보류.
  - report: 관측성 통증이 실사용에서 수치로 확인된 뒤 최소형(스냅샷 표, 신규 의존성 0)으로만.
- **의미**: 도그푸딩이 "다음 코딩을 미루라"는 결론을 냈다는 것 자체가 하네스가 제 역할(순서 틀린 착수 차단)을 한 증거. 다음 코딩은 하네스가 아니라 실제 서비스 아이디어에서 나와야 함. 하네스는 v2.5.0으로 "충분히 좋다".

## 2026-07-08 (public 설치 + ux_ui 디자인 레퍼런스 확장)

- **dist 커밋으로 전환**: github 설치가 빌드 없이 동작하도록 `dist/`를 레포에 커밋(.gitignore 제거). 최신 npm이 install 스크립트(prepare)를 기본 차단하므로 prepare 빌드에 의존하지 않고 산출물을 직접 커밋하는 게 더 견고. build에 `chmod +x dist/cli.js` 추가(tsc가 644로 만들어 bin permission denied 발생하던 버그 해소). 소스 수정 시 `npm run build` 후 dist 커밋 필수.
- **ux_ui 역할 경계 = "디자인 방향 지시자", 픽셀 렌더러 아님**: headless `claude -p`는 웹검색·렌더링 불가하므로, ux_ui는 레퍼런스 소스·검색 키워드·비주얼 방향만 산출하고 실제 레퍼런스 수집(WebSearch)·화면 시안(Claude 아티팩트)은 다음 단계 Claude Code에서 수행. 기존 "아트 디렉터 아니다/최소 화면" 철학과 충돌 없이 확장(MVP-lean: 레퍼런스는 명확성·속도용, 과설계 금지).
- **task-prompt 디자인 실행 섹션**: 03_UX_FLOW.md 존재 시에만 조건부 추가 → idea-validation 등 UX 없는 워크플로우/acceptance 무영향.
