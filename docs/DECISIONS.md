# DECISIONS.md

## 2026-08-26 (B-40 kill 게이트 — **CEO 판정은 산문이 아니라 구조에서 읽는다**)

- **결정 — `agents/founder_ceo_agent.md`의 출력 계약에 `## Decision` 절을 추가하고**(본문은
  `진행`|`축소`|`검증`|`보류`|`폐기` 중 **정확히 한 토큰**), 게이트는 새 파서
  `extractCeoDecision`으로 **그 절만** 읽는다. 파서는 코드펜스 안의 헤더·본문을 무시하고,
  펜스 밖 `## Decision` 절이 정확히 1개·본문 비공백 줄이 정확히 1줄·그 줄이 토큰과 **완전 일치**할
  때만 판정을 낸다(부분문자열 아님 — "진행성"·"축소 후 진행" 모두 거부).
  **게이트 통과는 `진행` 토큰 하나뿐이다**: `보류`·매핑 없는 토큰·되돌림 예산 소진·되돌림 대상 부재는
  전부 `failed`로 멈추며 사유 코드를 구분한다(`ceo_decision_hold` / `ceo_decision_unmapped` /
  `gate_jump_budget_exhausted` / `gate_jump_target_missing` / `ceo_decision_absent` /
  `ceo_decision_ambiguous`).
- **"조용히 진행하는 경로"의 범위를 정확히 적는다** (초판은 과대주장이었다 — 실제로는
  ⓐ 비진행 토큰이 암묵 진행으로 떨어지고 ⓑ 첫 절·부분문자열이라 판정을 심을 수 있었다. 둘 다 위에서
  닫았다): **B-40이 닫은 것은 프로젝트 스코프 경로(`run` · `task-prompt` · `plan-dag`)뿐이다.**
  남는 우회는 그대로 있고 종결을 주장하지 않는다 — ① `autopilot-create` 직접 호출(DAG를 손으로 써서
  넘기는 경로 · 이번 스코프 밖) ② `outputs/run_state.json`을 사람이 지우면 잠금 근거가 사라진다
  ③ 아이디어 문서만 새 프로젝트로 복사하면 그 프로젝트엔 폐기 기록이 없다 ④ `exec`/`mission`은
  project/run_state 개념이 없어 잠금이 닿지 않는다.
- **토큰 목록은 "단일 출처"가 아니다**(정정): 같은 낱말이 CEO 프롬프트 · `registry/workflows.json`의
  gate 키 · `CEO_DECISION_TOKENS` 상수에 **수기로 중복**된다(프롬프트도 JSON도 TS 상수를 import할 수
  없다). 상수의 실제 역할은 **파서 allowlist + registry 회귀 대조**이며, workflows.json 키가 목록에서
  벗어나면 로더 테스트가 red가 된다. **프롬프트 쪽 어긋남은 코드로 잡히지 않는다** — 그것이 남는 위험이고,
  그래서 `promptParts`가 최종 출력 지시에 토큰 목록을 상수에서 렌더해 최소한 live 경로는 묶어 뒀다.
- **근거**: 기존 게이트는 `extractDecision`(Main Judgment + Decisions 섹션의 **부분문자열** 매칭)을 썼다.
  오탐("폐기하지 않는다" → kill)은 멈추는 쪽이라 참을 수 있지만 **누락은 fail open이고 그것이 이 게이트의
  목적을 깬다**: CEO 프롬프트 §8-E가 실제로 쓰는 "더 이상 시간을 쓰지 않는다", 그리고 "중단한다"·"드롭한다"
  같은 표현은 어떤 키워드 목록에도 걸리지 않아 **미달 아이디어가 그대로 개발 착수로 진행**한다.
- **대안과 기각 사유**: ⓐ **동의어 열거**(kill 배열에 표현을 계속 추가) — 자연어는 무한해서 닫히지 않고,
  목록이 길어질수록 "빠진 표현"이 조용히 통과하는 확률만 커진다. ⓑ **부분문자열 매칭 유지 + 경고** —
  경고는 진행을 막지 않으므로 fail open 그대로다. ⓒ **LLM에게 판정을 다시 물어보기** — 판정을 두 번
  받는 셈이고 두 답이 갈릴 때 어느 쪽이 정본인지 정할 근거가 없다.
  ⓓ **`required_headers`를 fail closed 수단으로 쓰기** — 기각(수단으로서는). 단
  `registry/agent_registry.json`의 founder_ceo에 `required_headers:["Decision"]`을 **실제로 추가했다** —
  **best-effort 재생성 피드백**으로, 게이트가 멈추기 전에 한 번 더 기회를 준다. 그러나 **재생성 후에도
  없으면 경고로 저장하고 진행**하므로(v1 검증은 경고 수준 — 대장 C-70) **파서를 대체하지 않는다**.
  정본은 게이트의 fail closed이고 헤더는 보조다(대장 `C-127`).
  (초판 항목은 "헤더 강제는 하지 않았다"라고 적었는데 그 뒤 필드를 추가했다 — **정정**.)
  (2026-08-27 `C-127`로 **경고 → 차단**이 됐다 — **정정**. 재생성 상한 후에도 필수 절이 없으면
  `persistFinalOutcome`이 채택을 거부하고 run이 `failed`/`failed_reason: "required_sections_missing"`으로
  멈춘다. 즉 위 "경고로 저장하고 진행"은 더 이상 사실이 아니다. **다만 결론은 그대로다**:
  헤더 검증은 `## Decision` **절의 존재**만 보고 판정 토큰을 읽지 않으므로 게이트 파서를
  **대체하지 않는다**. 정본은 여전히 `extractCeoDecision`이고 헤더는 보조다.)
- **파서 부재 시 왜 fail closed인가**: 잘못 멈추면 사람이 `## Decision` 한 줄을 고쳐 `--resume`하면 되고
  (resume 지점이 그 게이트 step이다), 잘못 진행하면 게이트가 존재하는 이유 그 자체가 사라진다.
  비용이 비대칭이라 멈추는 쪽을 택했다.
- **`mockProvider`도 같은 계약을 지킨다**(founder_ceo 출력에 `## Decision`/기본 `진행`): 그러지 않으면
  mock 기반 acceptance·golden 전부가 `ceo_decision_absent`로 죽어 **만족 불가능한 계약**이 된다.
- **폐기의 효력은 두 필드로 잠근다**(초판의 digest-변경-해제는 결함이었다 — 공백 하나만 바꿔도
  기존 killed 산출물로 지시문·DAG를 만들 수 있었다. **아이디어 변경은 "재평가가 필요하다"는 신호일 뿐
  "통과했다"는 증거가 아니다**):
  ① `kill_history`(폐기 이력 · state를 쓸 때마다 **carry forward** — 이어받지 않으면 kill 뒤 아무 run이
  증거를 지운다) ② `cleared_idea_sha256`(**kill 게이트가 '진행' 판정을 낸 그 순간**의 아이디어 digest —
  다른 경로에서 적으면 그 경로가 곧 우회 통로다). 판정은 **단일 함수 `ideaGateStatus`** 하나이고
  `run`·`task-prompt`·`plan-dag`가 그것만 쓴다. 잠금 중 허용되는 것은 **kill 게이트가 있는 workflow의
  새 run 하나(=재평가)**뿐이며, `task-prompt`·`plan-dag`·kill 게이트 없는 workflow는 계속 거부한다.
- **재평가는 아이디어 변경을 요구하지 않는다**(의도한 선택): 잠금 중 허용되는 재평가 run은 아이디어가
  kill 시점과 **같은 바이트여도** 돌 수 있고, 그 게이트가 `진행`을 내면 해제된다. 같은 아이디어를 다시
  심사하는 것 자체는 정당하다 — 사람이 근거를 새로 댈 수 있고, 리서치가 갱신될 수 있다. **막아야 할 것은
  "심사 없이 통과"였다.** 기각한 대안: 재평가도 digest가 kill 시점과 같으면 거부 — 더 엄격하지만
  "같은 아이디어를 재심사할 권리"를 없애고, CEO 판정이 아니라 파일 편집이 게이트가 된다.
  (그래서 CEO 프롬프트 §14.0의 "아이디어를 고쳐야 다시 시작할 수 있다"는 문구를 "재평가 run이
  필요하다"로 정정했다 — 구현이 검사하지 않는 조건을 프롬프트가 약속하고 있었다.)
- **`--force` 같은 플래그를 기각한 이유**: 잠금을 푸는 조건이 "사람이 우회를 선언했다"가 되면 그 선언이
  곧 게이트의 대체물이 된다. 해제 권한은 게이트에만 둔다.
- **심사한 바이트와 기록한 digest를 결박한다**(A-1 · TOCTOU): run 시작에 아이디어를 **한 번** snapshot하고
  그 run의 모든 agent 프롬프트·kill/clear digest가 그 snapshot만 쓴다(`runAgent`는 파일을 읽지 않는다).
  `task-prompt`·`plan-dag`도 한 번 읽어 검사와 사용에 같은 바이트를 쓴다 — "사용 직전 재검증"보다
  창 자체가 없는 쪽이 싸고 확실하다. 예전엔 게이트가 나중에 경로를 다시 읽어 **CEO가 본 적 없는
  바이트가 해제**될 수 있었다.
- **게이트 결과는 추론하지 않고 기록한다**(A-2): `gate_jumps[].outcome`
  (`proceed`|`jump`|`kill`|`failed`, 실패 시 `reason`). `jumped_to === null`을 "진행"으로 읽던 CLI·vault가
  폐기와 실패를 전부 "진행"으로 적고 있었다 — durable status는 failed인데 영수증은 진행이라고 증언하는
  모순. 렌더는 `gateOutcomeLabel` 하나를 CLI와 vault가 공유한다.
  단, digest가 감지하는 것은 **바이트 변경**뿐이다(정정 — 초판은 "실제로 고쳤는가의 유일한 신호"라고
  적었다): 같은 프로젝트의 **읽을 수 있는** state에 대한 바이트 비교이며 공백만 바꿔도 다른 digest다.
  그래서 digest는 "해제"가 아니라 "해제 증거의 신원"으로만 쓴다.
- **손상된 state는 부재가 아니다**: `JSON.parse` 실패를 `null`로 접으면 소비자가 비차단으로 다뤄
  **깨진 state를 새 state로 덮어쓴다**(system of record 소실). `readRunState`가 부재/손상을 구분하고
  세 소비자 전부 `run_state_unreadable`로 fail closed한다. 아이디어 파일 부재도 같은 방향(`idea_missing`).
  **문법 손상만으로는 부족했다**(A-3): JSON으로 파싱되는 **구조 손상**(`status:"killed"`인데
  `kill_history` 없음 · 새 필드 타입 오류)도 `unreadable`로 분류한다 — 그러지 않으면 그런 state가
  "폐기된 적 없음"으로 읽혀 잠금이 사라진다. 전체 스키마 검증기는 만들지 않았다(잠금이 읽는 필드만
  본다). **정상 구버전은 통과**시킨다 — 새 필드 없는 completed/failed state = 잠금 없음(하위 호환).
- **한계**: `plan-dag --idea`는 `<project>/docs/00_IDEA.md` 꼴 경로만 프로젝트로 되짚는다(그 위치의
  `outputs/run_state.json`만 본다). 프로젝트 밖 임의 경로의 아이디어는 이 검사가 막지 못한다.

## 2026-08-13 (V3 M8 — **접근성 검증 대상은 산출물이 직접 선언한다**)

- **결정 — `tokens.json` 최상위에 `a11y.contrastPairs`를 필수로 추가하고**(3계층 → 4 key),
  하네스가 그 쌍을 primitive hex까지 해석해 **WCAG 대비비를 계산**한다. `min`은 `4.5`/`3`만 허용하고,
  모든 `semantic.color.text-*`는 최소 한 쌍의 `fg`로 등장해야 한다.
- **근거**: 선언이 없으면 대비 검사는 "무엇과 무엇을 비교할지"를 하네스가 추측해야 하고, 추측이 틀리면
  검사는 통과가 쉬운 장식이 된다(§7 위험 2 — M5에서 공허한 체크로 A급 3회). 검증 대상을 산출물이
  선언하게 하면 **선언 누락 자체가 위반**이 되어 검사를 비울 길이 없다.
- **대안과 기각 사유**: ⓐ 이름 규약으로 쌍을 추론(`text-*` ↔ `bg-*`) — 규약에 없는 이름이 나오면 조용히
  검사 0건이 된다. ⓑ 접근성 검사를 DESIGN.md 산문 grep으로 — 문장 존재는 값의 성질을 증명하지 않는다.
  ⓒ 렌더링 기반 검증 — M8 범위 밖이고 의존성·비용이 붙는다.
- **한계를 같이 적는다**: 이 검증은 tokens 층에서만 성립한다. 실제 렌더링 결과·이미지 위 텍스트·
  large-text 예외·스크린리더/키보드 실동작은 범위 밖이며, focus 토큰의 존재는 "초점이 실제로 보인다"의
  증명이 아니다. 생산자 프롬프트 `agents/design_agent.md` §4를 같은 커밋에서 갱신해 계약을 단일 출처로 뒀다.

## 2026-08-04 (V3 M5c task 3C — **실행 권능의 소비자는 kernel 안에 있어야 한다**)

- **결정 — `ProcessLaunchCapability`·`LaunchRecord`·`GENUINE_LAUNCH_CAPABILITIES`·
  `resolveProcessLaunchCapability`·`isGenuineLaunchCapability`를 `typedExecution.ts`에서
  `orchestrationKernel.ts`로 옮기고, `typedExecution.ts`는 이름만 재수출한다.**
- **근거**: 권능 소비자가 kernel 밖에 살면 권능을 **공개 함수의 인자로** 받아야 한다. 그 형태가 바로
  Task 3A의 A3가 삭제한 `writeFileEffect.ts` 구멍이다(위조 가능한 구조적 authority로 효과에 도달하는
  import 표면). 레지스트리와 집행기를 한 모듈에 두는 A3 선례를 따르고 **두 번째 패턴을 만들지 않는다**.
- **대안과 기각 사유**: ⓐ 소비자를 `typedExecution.ts`에 두고 kernel이 주입 — 공개 인자 표면이 그대로
  남는다. ⓑ 별도 `processEffect.ts` 모듈 — 삭제한 `writeFileEffect.ts`를 이름만 바꿔 되살리는 것이다.
- **검증**: 독립 read-only 리뷰가 순환 import 0(`managedProcess.ts`는 `orchestrationTypes`만 import ·
  kernel은 `typedExecution`을 import하지 않는다), `GENUINE_LAUNCH_CAPABILITIES`/`LaunchRecord`의
  module-private 유지, 신규 export 3종이 전부 registry 결박 grant/permit을 요구하거나 read-only
  predicate임을 확인했다. **A3 성립.**
- **남는 판단**: `managedProcess.ts`는 export되어 있고 주는 대로 spawn한다. 독립 리뷰 판정은
  "**새 권위가 아니다**" — canonical marker를 만들지 않고 registry를 건드리지 않으며, 직접 호출은
  ambient `child_process.spawn`과 권위상 동등하고 영수증은 kernel 사설 경로에서만 발행된다.

## 2026-07-31 (V3 M5c task 3A **6차 리비전** — **claim namespace는 과금 namespace와 같은 폭이다**)

- **결정 — turn ID의 durable claim은 run 전역에서 유일하다(task-local이 아니다).** 과금 중복 판정
  (`accounting.chargedTurnIds`)이 run 전역인데 claim은 task-local이어서, 두 running task가 **둘 다 진짜
  permit으로** 같은 turn ID를 claim할 수 있었다 → 먼저 과금한 쪽이 다른 쪽의 genuine charge를 영구히
  막고(`turn_already_charged`) 막힌 쪽은 task-local 과금 증거가 없어 claim을 정산도 교체도 못 하는
  **영구 교착**이었다. 대안 둘: ⓐ 과금 key를 `(taskId, turnId)`로 **task-scoped화** — durable 형식과
  기존 `chargedTurnIds` 계약·load 불변식·상한 계산이 전부 바뀌고 마이그레이션이 필요하다 ⓑ **채택**:
  claim 쪽을 좁힌다. 두 namespace를 같은 폭(run 전역)으로 맞추면 durable 형식 변경 0이고, 정합성 위반은
  **커밋(`assertTurnClaimableBy`)과 load(`assertUniqueDispatchClaims`) 두 곳에서 같은 불변식**으로
  잡힌다. **대가**: 서로 다른 task가 우연히 같은 turn ID 문자열을 쓰면 뒤에 온 쪽이 `turn_conflict`로
  거부된다 — provider/controller가 turn ID를 run 안에서 유일하게 발급해야 한다는 요구가 명시적으로
  생긴다(그 요구는 과금 namespace 때문에 **이미 암묵적으로 존재**했고, 지금은 조용한 교착 대신 즉시
  fail closed로 드러난다).

## 2026-07-31 (V3 M5c task 3A **5차 리비전** — **효과 코드는 권위 경계 안에 살고, handle은 발급자를 떠나지 않는다**)

- **결정 1 — 집행기를 별도 파일에서 kernel 모듈 안으로 옮기고 그 파일을 삭제했다.** 4차 판은 런타임 순환을
  피하려고 파일 시스템 판정을 `src/exec/writeFileEffect.ts`로 갈랐고 `judgeWriteFile(auth, op)`를
  export했다. 그런데 `DispatchAuthority`는 평범한 구조적 interface이므로 **그 모듈을 직접 import하면
  위조 객체 하나로** 파일을 열어 hash하고 디렉터리를 fsync하고 성공 marker까지 받을 수 있었다 — 진짜
  permit·과금·durable 상태 확인이 하나도 없이. 패키지는 `dist` 전체를 exports map 없이 배포하므로
  "내부 파일"·이름·주석·barrel 누락·TypeScript 가시성은 경계가 **아니었다**. 대안 셋: ⓐ exports map 추가·
  `@internal`·이름 변경 — 리뷰가 명시적으로 배제했고 실제로 경계가 아니다 ⓑ helper 모듈을 남기고
  **위조 불가한 발급자 토큰**을 요구하기 — kernel이 토큰을 넘겨야 하는데, 공격자가 kernel 없이 helper만
  import하면 자기 토큰을 등록할 수 있고 로드 순서에 의존한다(안전을 증명할 수 없다) ⓒ **채택**: 효과
  함수를 grant 등록부(`GENUINE_GRANTS`)와 **같은 모듈의 사설 함수**로 옮기고 파일을 삭제. 유일한 진입점은
  진짜 grant를 요구하는 `executeWriteFileOperation()`이다. **대가**: `orchestrationKernel.ts`가 커졌다
  (3618 → 4173줄, 439줄 파일 하나가 사라졌다). **얻는 것**: "효과에 도달하는 import 표면"이라는 개념 자체가 사라진다 — 남은
  export는 부수 효과 0인 순수 판정과 안정 코드 목록, 테스트 seam뿐이다. 순환은 생기지 않는다
  (`typedExecution → kernel` 한 방향).
- **결정 2 — 프로세스 메모리 handle은 kernel 인스턴스 경계를 넘지 않는다(같은 workspace의 두 번째
  인스턴스도 남이다).** 4차 판의 등록부는 모듈 전역이고 수신 메서드는 "이 모듈이 발급했는가"만 봤다 →
  durable ID가 같은 두 workspace가 교차 과금·교차 pending 등록·교차 attempted 표시·교차 영수증 커밋을
  하고 live grant key까지 서로 죽였다. 대안 둘: ⓐ 등록부 key에 `workspaceRoot`를 섞기 — 문자열이므로
  같은 경로를 쓰는 두 인스턴스에서는 여전히 통하고, "발급자 신원"을 문자열로 표현하는 순간 그것이 곧
  위조 가능한 축이 된다 ⓑ **채택**: 발급된 모든 handle이 **발급 인스턴스 객체 자체**를 들고 있고 수신
  메서드가 `this`와 `===`로 대조한다. `LIVE_GRANTS`도 `WeakMap<issuer, Map<…>>`이다.
  **명시적 판단**: 같은 workspace를 두 번 열어도 첫 인스턴스의 handle은 두 번째에서 **거부**된다. 권위는
  durable 경로로만 넘어간다 — `attemptedAt === null`이면 같은 `(turnId, planDigest)`의 **커밋 없는**
  permit 재발급, 그 밖이면 handle을 요구하지 않는 `reconcileUncertainOperation()`이다.
  **대가(정직)**: 한 프로세스가 같은 run을 두 인스턴스로 열고 handle을 주고받는 사용 패턴은 이제 불가능하다.
  그 패턴은 durable 재발급으로 대체되며, 그것이 재시작과 **같은 경로**라서 검증 표면이 하나로 줄어든다.
- **결정 3 — 표시 커밋 이후 권위를 다시 읽는다(첫 판정을 재사용하지 않는다).** `attemptedAt` 표시는
  safety-only 커밋이므로 만료·예산·wall·no-progress deadline을 **의도적으로 보지 않는다**(그러지 않으면
  불확실 구간이 durable에 남지 않아 미아가 된다 — 3차 A3). 그런데 4차 판은 그 커밋을 사이에 두고 **표시
  이전의 판정**으로 집행기에 들어갔다 → 첫 시계 읽기에 유효했던 deadline이 커밋 도중 지나도 효과가 나갔다.
  대안: 표시 커밋에 deadline을 다시 넣기 — 미아 문제가 되살아난다(폐기). **채택**: 표시는 그대로
  safety-only로 두고 **집행기 진입 직전에 전수 재확인**한다. 재확인이 거부하면 효과 0이고, pending은
  보수적으로 "시도됐을 수 있다"로 남아 정합화(`outcome_unknown`)로만 닫힌다. **대가(정직)**: 실제로는
  아무 효과도 없었는데 `outcome_unknown`으로 기록된다 — 리뷰가 요구한 보수적 쪽이며, 거짓 성공보다 안전하다.
- **결정 4 — 닫을 자리가 없으면 열지 않는다(영수증 용량 선예약).** operation은 turn 단위(64)·영수증은
  attempt 단위(64)로 상한이 다르므로, 동시 pending 용량만 보면 뒤 turn이 영수증이 꽉 찬 attempt에
  pending을 열 수 있었고 그 pending은 **어떤 전이로도 닫히지 않았다**(attempt 이탈은 전부 pending 0을
  요구한다). 대안: 영수증 상한을 늘리거나 attempt마다 영수증을 잘라내기 — 감사 기록을 지우는 쪽이므로 폐기.
  **채택**: `operationReceipts.length + pendingOperations.length <= maxOperationReceipts`를 **커밋과 store
  load 양쪽**에서 강제한다. **대가**: 영수증이 상한에 가까운 attempt는 새 operation을 열지 못하고
  `operation_limit_exceeded`로 fail closed다(그 attempt는 정리·재시도로 간다). 미아보다 낫다.
- **결정 5 — 정산 권위를 run 전역 turn ID 집합에서 task-local 증거로 옮겼다.** `chargedTurnIds`는 run
  전역 중복 namespace이므로 그것만으로 "이 task의 이 turn이 끝났다"를 판정하면 남의 과금이 정산을 흉내 낼
  수 있다. **채택**: `dispatchTurnSettled`가 `execution.turnId` + `chargedPlanDigest == dispatchPlanDigest`
  + 그 turn의 미확정 0만 본다. 동시에 bare 회계가 **남이 claim한 turn**을 커밋 안에서 거부한다.
  **정직한 기록**: 두 번째 장치(claimant 거부)가 부패 상태를 도달 불가로 만들기 때문에, 첫 번째 장치를
  단독으로 되돌리는 mutation은 현재 테스트로 관측되지 않는다(`MUT-8` red 0). 그래도 두 장치를 모두 두는
  이유는 "정산은 자기 증거에서 나온다"가 run 전역 namespace의 무결성에 **의존하지 않아야** 하기 때문이다.

## 2026-07-31 (V3 M5c task 3A **4차 리비전** — **권위는 자기 것이어야 하고, 집행기는 고정이며, 불확실은 불확실로 남는다**)

- **결정 1 — 과금 진입점을 둘로 갈랐다(권위 있는 것 / 없는 것).** 3차 판은 효과 승인을 run 전역
  `accounting.chargedTurnIds`에 그 turn ID가 **있는지**로 판정했다. 그런데 `chargeTurnUsage`는
  `{taskId, turnId, 카운트}`를 호출자가 전부 골랐으므로, **claim이 없는 sibling task**가 생산 task의
  bare turn ID를 0 토큰으로 과금해 남의 효과를 승인할 수 있었다. 대안 셋: ⓐ 게이트만 per-task로 옮기기 —
  공격은 닫히지만 "과금 자체가 권위에 묶여야 한다"는 요구를 만족하지 못하고 근거가 세 함수에 흩어진다
  ⓑ `chargeTurnUsage`를 **permit 필수**로 바꾸기 — 가장 단순하지만 **만료·재시작 뒤 회계가 불가능해진다**
  (permit은 전진 게이트를 지나야 나온다) → `B-12`("이미 태운 자원을 적는 일을 막으면 만료가 곧 회계
  누락이다")를 깬다 ⓒ **채택**: 두 진입점. `chargeTurnUsage`는 claim이 **없는** turn만 과금하고 권위
  증거를 남기지 않으며(만료·재시작 회계 유지), 신규 `chargeDispatchTurnUsage({permit,…})`만 신원을
  permit에서 가져와 durable `execution.chargedPlanDigest`를 남긴다. 효과 게이트는 그 증거 + 이 task의
  `turnId`를 claim된 turn/계획/attempt와 함께 본다. **대가**: 공개 API가 하나 늘었다. **얻는 것**:
  "누가 무엇을 근거로 이 효과를 승인했는가"가 durable 필드 하나로 읽힌다.
- **결정 2 — `updatedAt`을 공용 시계 게이트에 넣었다(safety-only 포함).** safety-only 커밋은 만료
  뒤에도 지나야 하지만 **시간을 되돌릴 권리는 없다**. 3차 판은 `#mutate`가 `draft.updatedAt = now`로
  덮어썼고 공용 검사는 run 시작 시각만 봤으므로, 회계·정리·취소·pause 커밋 하나로 durable 시각을 뒤로
  돌린 뒤 과거 시각이 효과 게이트의 단조 판정을 통과할 수 있었다(wall·no-progress 창 재개방).
  이제 `now < state.updatedAt`이면 **모든 mutation**이 `clock_invalid`다. **대가(정직)**: 시계가 어긋난
  두 writer 환경에서는 늦은 쪽이 아무것도 커밋하지 못한다 — fail-closed 쪽을 택했다. 테스트 fixture도
  진짜 시계처럼 단조로 고쳤다(이전 fixture는 kernel 재개 시 tick을 0으로 되돌려 **역행을 흉내 내고
  있었다**).
- **결정 3 — 임의 콜백 집행 표면을 삭제하고 kind별 고정 집행기로 갔다.** 3차 판의
  `executeUnderGrant(grant, op, 임의콜백)`은 "효과는 이 함수 안에서 일어난다"고 적었지만 실제로는
  **호출자가 넘긴 아무 함수의 반환값**을 canonical 성공으로 굳혔다 → 아무것도 하지 않는 콜백이 진짜
  `applied` 영수증을 만들 수 있었다. 이름 변경·barrel 제외·`@internal`은 리뷰가 명시적으로 배제했다.
  그래서 kernel이 집행기를 **직접** 부르게 했는데, 집행기가 있던 `typedExecution.ts`는 kernel을 런타임
  import하므로 그대로 두면 ESM 순환(그리고 top-level `const`의 TDZ)이 된다. **채택**: 파일 시스템 판정만
  신규 `src/exec/writeFileEffect.ts`로 갈랐다 — 그 모듈은 kernel을 **`import type`으로만** 참조하므로
  방출 그래프가 한 방향이다. 신규 의존성·네이티브 helper **0**. `run_process`에는 성공 집행기를
  **만들지 않았다**(만드는 순간 그것이 곧 공개 실행 권위다).
- **결정 4 — 불확실한 효과는 "실패"로 지우지 않는다.** 집행 경계 진입을 **효과보다 먼저** durable에
  적고(`PendingOperation.attemptedAt`), 그 뒤에는 ⓐ 새 grant를 발급하지 않고 ⓑ `failOperation`도
  거부한다. 부분 외부 효과 뒤의 예외를 평범한 `failed` 영수증으로 닫으면 durable 기록이 "아무 일도
  없었다"고 거짓말하기 때문이다. 남은 종결은 `outcome_unknown` 하나이고, 그 marker는 성공도 실패도
  단정하지 않는다. **대가**: operation마다 커밋이 하나 늘었다(safety-only `operation_attempted`).
  그 커밋을 safety-only로 둔 이유는 만료·deadline이 **불확실성의 기록 자체**를 막으면 안 되기 때문이다.
- **결정 5 — 재시작 정합화는 durable 신원만 요구한다(handle 0).** permit·grant·outcome은 프로세스
  메모리 `WeakMap`이므로 재시작하면 사라진다. 3차 판은 그 사실을 문서에 적지 않았고, `cleaning`이나
  만료된 `running`의 pending은 새 permit도(발급은 `running`+전진 게이트를 요구한다) 옛 handle도 없어
  **영구 미아**였다. 신규 `reconcileUncertainOperation()`은 handle을 하나도 요구하지 않는 대신
  durable 신원 8종을 전수 대조하고, **marker를 호출자가 고를 수 없게** durable 진실에서 파생한다
  (`attemptedAt !== null` → `outcome_unknown` · `null` → `failed`). 경로·hash·exit code는 항상 `null`이다.
  **주장하지 않는 것**: 이 경로는 "외부 효과가 일어나지 않았다"를 증명하지 않는다 — 그것을 증명할 수
  없다는 사실을 durable에 적는 것이 이 경로의 전부다.

## 2026-07-31 (V3 M5c task 3A **3차 리비전** — **예방할 수 없으면 발행하지 않는다. 회계는 효과보다 먼저다. 결과는 집행기만 낸다** · 그 시점 기록 — 위 4차 리비전이 결정 2·3을 정정한다)

- **결정 1 — 신규 파일 발행을 fail closed로 만들었다(기능 축소를 감수했다).** `link(2)`/`rename(2)`는
  pathname을 받는다. 최종 부모 신원 확인과 syscall 사이에 같은 사용자 경쟁자가 승인된 부모 **이름**을
  교체하면 커널이 그 교체본을 통해 경로를 해석해 **승인 범위 밖으로** 바이트를 발행하고, 발행된 inode는
  우리 temp와 같으므로 **사후 검증은 통과하며**, fsync는 엉뚱한 디렉터리 fd에 걸린다. Node 18/macOS
  내장에는 디스크립터 상대 no-replace 발행(`linkat`)이 없다. 대안 셋을 검토했다: ⓐ 사후 검증 강화 —
  창을 닫지 못한다(리뷰가 명시적으로 배제했다) ⓑ `process.chdir(parent)` + basename `link` — cwd는
  커널이 잡은 디렉터리 참조이므로 **경쟁을 실제로 닫지만**, 프로세스 전역 상태이고 worker thread에서
  던지며 managed launcher가 자식을 띄우는 순간 **자식 cwd까지 오염**시킨다 → 안전을 증명할 수 없다
  ⓒ 네이티브 helper/의존성 — 이 세션의 권한 밖(사람 승인 대상)이다. 그래서 **발행 경로를 제거**했다.
  **대가는 크다**: `applyWriteFile`은 이제 새 파일을 만들지 못하고 판정·정합화만 한다(`already_applied`·
  `write_conflict`·`write_replace_unsupported`·`write_publish_unsupported`). 그 기능 공백은 대장
  **`B-16`**(기한: typed write로 실제 산출물을 만드는 첫 배선 전)으로 남겼다. **얻는 것**: 승인 범위
  밖 발행이 **도달 불가능**하고, temp가 없으므로 고아 plaintext·unlink durability 문제도 함께 소멸한다.
- **결정 2 — 회계와 turn 닫기를 분리했다(2차 리비전 결정 2의 정정).** 2차 판은 "turn을 닫는 지점은
  과금"이었다. 그런데 그러면 **생산 turn은 효과가 끝난 뒤에야 과금될 수 있고**, 효과 게이트의 토큰 판정이
  항상 한 turn 뒤처진 총량을 본다 → 승인 상한을 넘겨 쓸 수 있다. 지금 순서는 **permit(claim) → 과금 →
  grant → 효과**이고 효과 게이트가 `chargedTurnIds.includes(turnId)`를 요구한다. 과금은 claim을 닫지
  않는다(닫으면 바로 그 계획의 grant가 죽는다) — **끝난 claim**(과금 + 미확정 0)만 다음 turn의 permit
  요청이 교체하는 **지연 해제**다. 대안이었던 "닫을 시점을 durable에 미리 적기"(계획의 operation 수를
  저장)는 채택하지 않았다: 계획의 일부만 집행하기로 한 turn이 **교착**된다.
- **결정 3 — 성공 결과는 집행기만 만든다.** `consumeExecutionGrant`(게이트 통과)와 결과 주장이 갈라져
  있던 것이 위조의 근원이었다: 아무것도 spawn하지 않아도 grant를 `executing`으로 올리면 호출자가 만든
  `applied` 영수증이 수락됐다. 지금은 효과가 `executeUnderGrant(grant, op, effect)` **안에서** 일어나고,
  `effect`가 정상 반환한 값만 grant 안에 canonical 결과로 굳어 opaque handle이 된다. 영수증은 그 handle만
  받고 **저장된 값**을 적는다. **주장하지 않는 범위(정직)**: 진짜 grant를 쥔 같은 프로세스 코드는
  거짓말하는 `effect`를 넘길 수 있다 — 그러나 진짜 grant는 진짜 permit → `beginOperation` 커밋을 지나야
  나오므로 그 코드는 이미 승인된 dispatch 경로 안이다.
- **결정 4 — 영수증 정합화는 safety-only다.** 이미 일어난 효과를 durable에 적는 일을 만료·예산·
  deadline·`cleaning`으로 막으면 그 pending은 **어떤 전이로도 닫히지 않는 미아**가 되고 다음 preflight·
  resume이 조용히 지운다. 그래서 정합화는 로드맵 §8.1의 safety-only 예외에 속한다(전진 0 · 신원은 전수
  확인). 짝이 되는 규칙: attempt를 떠나거나 리셋하는 전이는 pending이 있으면 전부 거부한다.
- **결정 5 — 승인 문서의 `run_process` 입력은 action별 계약이다.** `data: string[]`은 arity·경로 의미·
  소유권·읽기 범위를 **미래 launcher가 지어내야 하는** 인터페이스였다(과승인이거나 폐기 대상). 지금
  `validate-plan`은 정확히 `{planPath}`이고 승인 시점에 정규화 항등·`writableRoots`·task ownership까지
  본다. **읽기 전용 action이지만 새 `readableRoots` 축을 열지 않았다** — 이미 승인된 쓰기 범위 안쪽으로
  읽기를 좁히는 쪽이 더 적은 권한이고 승인 문서에 새 축을 만들지 않는다.

## 2026-07-30 (V3 M5c task 3A **2차 리비전** — **권위는 durable claim + 일회용 grant이고, 예방할 수 없는 발행은 거부한다**)

- **결정 1 — permit 발급은 순수 판정이 아니라 커밋이다.** 1차 판의 permit은 state를 바꾸지 않았다. 그래서
  durable `turnId`가 `null`인 동안 **서로 다른 turn의 permit이 몇 개든 공존**했고, 크래시 뒤에는 "어떤
  계획/turn이 그 효과를 승인했는가"에 대한 durable 기록이 아예 없었다. 지금 `issueOperationDispatchPermit()`은
  `execution.dispatchTurnId` + `dispatchPlanDigest`를 **한 커밋으로 claim**한다. 대가: 발급마다 revision이
  오르고 event가 하나 남는다. 얻는 것: **활성 turn과 활성 계획이 durable하게 정확히 하나**이고, 경쟁 turn·
  경쟁 계획이 fail closed이며, 재시작이 그 사실을 읽을 수 있다. 같은 (turn, 계획) 재발급은 멱등이다 —
  그렇지 않으면 재시작한 controller가 자기 미확정 operation을 정합화할 방법이 없다.
- **결정 2 — turn을 닫는 지점은 과금이다.** `chargeTurnUsage()`가 claim을 해제하고 `chargedTurnIds`에
  기록한다. 그래서 ⓐ 같은 attempt 안에서 turn이 자연스럽게 이어지고 ⓑ 닫힌 turn은 다시 열리지 않으며
  ⓒ **미확정 operation이 남아 있으면 turn을 닫지 못한다**. 마지막 것이 핵심이다: "효과는 냈는데 결과 전이가
  없다"를 조용히 넘기면 durable 회계가 곧 거짓이 된다. `execution.turnId`는 이제 **마지막으로 과금된 turn**
  이고 활성 claim이 아니다(활성 판정은 `dispatchTurnId` 하나로 한다 — 그쪽이 더 강하다).
- **결정 3 — 효과 이전에 durable pending, 효과 이후에 일회용 소비.** `beginOperation()`이 pending 레코드를
  커밋하고 일회용 grant를 준다. 효과 게이트가 grant를 소진하고, 영수증 커밋이 grant를 소비하며 pending을
  닫는다. 대가: controller가 operation마다 커밋을 두 번 한다(등록·영수증). 이유: **구조적 영수증은 권위가
  아니다.** 이 순서가 아니면 "위조 영수증", "낡은 attempt 재생", "operation 치환", "같은 효과 두 번",
  "효과만 있고 결과 없음"이 전부 표현 가능하다. 그리고 **성공 marker는 효과 게이트를 지난 grant에서만**
  나온다 — 집행을 시도조차 하지 않은 grant는 `denied`/`failed`로만 pending을 닫을 수 있다.
- **결정 4 — 예방할 수 없는 발행은 거부한다(`rename` 삭제).** Node 18 내장에는 디스크립터 상대
  compare-and-publish가 없다. 그래서 **기존 경로 교체를 지원하지 않는다**: 대상이 이미 있고 내용이 의도와
  다르면 **temp를 만들기도 전에** `write_replace_unsupported`다. 대가: `expectedBeforeSha256`을 준
  덮어쓰기 계획이 더 이상 성공하지 않는다(부재 대상 발행과 versioned 산출물만 남는다). 이유: 1차 판은
  "검사 후 `rename`"으로 사후 탐지를 했는데, 그 창에서 **경쟁자 바이트가 실제로 파괴되고 승인 부모 밖으로
  발행될 수 있었다**. 네이티브 `*at` primitive는 승인 대상이므로 이 슬라이스에서 도입하지 않는다 —
  그리고 창을 없앴다고 주장하지도 않는다. 창에 **도달하지 않는다**.
- **결정 5 — "다시 보니 있더라"는 durability가 아니다.** `already_applied` 경로도 부모 fsync에 성공해야
  반환한다. 대가: 멱등 재시도마다 fsync 한 번. 이유: 앞선 시도가 fsync에서 실패했다면 디렉터리 엔트리는
  아직 durable하지 않고, 그 상태를 성공으로 적으면 controller의 복구가 거짓 전제 위에 선다.
- **결정 6 — 정리 실패는 성공이 아니고, 지울 수 없는 temp는 비운다.** close·unlink 실패는
  `write_cleanup_unconfirmed`다. 부모 **이름**이 적대적으로 교체돼 pathname으로 우리 temp를 지울 수 없으면
  남의 파일을 지우는 대신 **우리 fd로 `ftruncate(0)`** 한다 → 남는 파일이 0바이트가 되어 승인 내용이
  고아로 노출되지 않는다. temp 이름은 operation 신원 파생이라 sweep이 안전하게 귀속한다. **발행 뒤에는
  truncate하지 않는다**(temp fd와 발행된 대상이 같은 inode다).
- **결정 7 — `run_process`는 실행 대상을 고를 수 없다(`B-10` 폐쇄).** 승인 문서에서 `executable`·`args`를
  **삭제**했다. 실행 대상은 `executionAuthority.node` + **digest 고정 `controllerEntrypoint`** 로 manifest
  전체에 하나이고, 승인이 고르는 것은 닫힌 `action` enum과 **데이터 전용** `data`뿐이다. data는 `-`로
  시작할 수 없다 — 그 형태 규칙 하나가 `--eval`/`--require`/`--input-type` 계열을 닫는다. argv는
  `[entrypoint, action, ...data]`로 **파생**되며 만들 다른 통로가 없다. 대가: 승인 문서가 표현력을 잃는다
  (임의 Node 실행이 불가능해진다). 이유: **token 화면은 집행이 아니라 흉내다.** 승인된 Node + 자유 argv는
  그 자체로 임의 로컬 코드·파일 시스템·네트워크·hard-deny 표면 권위였다.
- **결정 8 — 호출자가 오류 taxonomy를 고르는 통로를 전부 닫는다.** 발행 seam이 던진 것은 종류 불문
  `write_failed`로, `readClosedOnce`가 읽다가 만난 예외는 종류 불문 `invalid_artifact_ref`로 접는다
  (이전에는 `OrchestrationError`를 그대로 재던져 **던지는 getter가 production 코드를 고를 수 있었다**).

## 2026-07-30 (V3 M5c task 3A **리비전** — **집행 권위는 kernel이 발급하는 봉인 permit 하나뿐이다** · 그 시점 기록)

- **결정 1 — 구조적 객체는 권위가 아니다.** 1차 판의 `OperationDispatchContext`(manifest·workspaceRoot·
  ownership을 담은 평범한 객체)를 **삭제**했다. 집행기는 `orchestrationKernel`이 발급한 봉인 permit만
  받고, 권위 값은 **그 permit이 아니라 발급 kernel이 다시 읽는 현재 durable state**에서 나온다.
  대가: 집행 API가 kernel을 알아야 하고 dispatch마다 state 읽기가 한 번 더 든다(operation 64건 상한이라
  비용은 bounded). 얻는 것: "위조한 승인 문서로 `../victim`을 쓴다"가 **표현 불가능**해진다 —
  이전에는 객체 하나로 승인·소유·만료·lifecycle을 전부 자칭할 수 있었다.
- **결정 2 — 권위는 발급 시점이 아니라 효과 직전에 판정한다.** permit은 "지금 집행해도 된다"는 증서가
  아니라 "무엇을 요청했는지"의 봉인 기록이다. 실제 판정(`running` · attempt/turn 신원 · preflight digest
  재계산 · 만료 · 예산 deadline · ownership)은 **모든 효과와 명세 발급 직전에** 다시 돈다. 대가: 같은
  검사를 여러 번 한다. 이유: 발급과 효과 사이에 취소·정리·다음 attempt·만료가 실제로 끼어들 수 있고,
  그 사이의 쓰기는 **승인되지 않은 쓰기**다.
- **결정 3 — operation은 신원으로 묶는다.** 집행 가능한 operation은 permit에 실린 **kernel이 검증하고
  동결한 계획 배열의 항목 그 자체**여야 한다(`===`). 구조가 같은 사본·합성 객체·다른 계획의 항목은 전부
  거부다. 대가: 호출자는 자기 원본 계획이 아니라 `permit.plan.operations`를 순회해야 한다. 이유: 구조
  비교로는 "검증된 계획"과 "검증 뒤에 만든 똑같이 생긴 것"을 구분할 수 없다.
- **결정 4 — 부재 대상 발행은 `rename`이 아니라 `link`다.** `rename(2)`은 대상을 조용히 덮어쓰므로
  경쟁적으로 생긴 파일을 삼킨다. `link(2)`는 대상이 있으면 `EEXIST`이므로 **덮어쓰지 않는 발행**이 된다
  (Node 18 내장 · 네이티브 의존성 0). 교체 경로는 preimage 신원·내용을 발행 직전에 다시 확인한 뒤에만
  `rename`한다. 남는 pathname syscall 창은 **없앴다고 주장하지 않는다**(대장 `C-5`).
- **결정 5 — durability가 확인되지 않으면 `applied`가 아니다.** 디렉터리 fsync가 실패하면 바이트는
  발행됐어도 `write_durability_unconfirmed`를 낸다. 대가: 호출자가 성공/실패 판정을 한 번 더 다뤄야 한다.
  이유: controller가 `applied` 영수증을 durable 복구의 근거로 쓸 예정이므로, 디렉터리 항목이 살아남지
  못할 수 있는 상태를 성공이라고 적으면 그 복구가 거짓 전제 위에 선다. 재시도는 현재 내용 hash가
  의도와 같아 `already_applied`로 수렴하므로 자동 복구가 막히지 않는다.
- **결정 6 — accessor는 성공해도 데이터가 아니다.** 입력 입양은 property descriptor의 `value`만 읽고
  getter/setter가 있으면 **실행하지 않고** 거부하며, `Proxy` receiver도 거부한다. 대가: "getter로 값을
  주는" 편의 호출 형태가 사라진다. 이유: "worker는 데이터만 낸다"가 코드로 성립해야 하고, **성공한
  호출자 코드**도 그 문장을 깬다. 같은 이유로 바이트 입양은 intrinsic 슬롯 접근만 쓴다
  (`Symbol.species`·iterator·constructor를 읽지 않는다).
- **결정 7 — 왕복이 깨지는 경로 문자열은 신원이 없다.** 고립 UTF-16 surrogate가 든 경로는 파일 시스템
  경계에서 U+FFFD로 바뀌므로 승인된 문자열과 실제 접근 경로가 갈린다 → `normalizeWorkspacePath`가
  거부한다(공유 정본 1곳 = 승인·계획·산출물·ownership 전부 커버). 유효 astral과 리터럴 U+FFFD는 통과한다.
  JSON Schema는 code-unit pattern으로 같은 판정을 표현하지만, `\uD800` escape의 파서별 처리 차이가 있으니
  **최종 판정은 런타임**이라고 문서에 적었다.

## 2026-07-30 (V3 M5c task 3A — **크래시 창에서는 "이미 그 바이트다"가 preimage 계약보다 앞선다 · worker는 데이터 어댑터다**)

- **결정 1 — `already_applied`가 `write_conflict`보다 먼저 판정된다.** typed `write_file` 집행은
  ⓐ 현재 대상 내용의 hash가 **의도한 내용의 hash와 같으면** 영수증이 durable하지 않았어도
  `already_applied`이고 ⓑ 그 밖의 preimage 불일치일 때만 `write_conflict`다. 순서가 반대이면
  "rename은 성공했지만 영수증을 남기기 전에 죽은" 재시작이 자기 자신이 쓴 바이트를 남의 것으로 보고
  영원히 충돌로 남는다(자동 복구 불가 = 무인 autopilot의 정지). 대가: 다른 행위자가 우연히 **정확히
  같은 바이트**를 먼저 써 두면 우리가 쓴 것으로 간주된다 — 그러나 결과 파일 내용은 의도와 같고
  새로 생기는 산출물·권한은 0이므로 안전 방향이다.
- **결정 2 — `run_process`는 이 계층에서 "명세"까지만 간다.** 승인 레코드에서 나온 **동결 데이터**
  (실행 파일·argv·timeout)만 만들고 **spawn하지 않는다**. 실행자를 여기 두면 계획 검증 계층이 곧
  프로세스 권위를 갖게 되고, 그 순간 "worker는 데이터만 낸다"는 문장이 코드가 아니라 주장이 된다.
  실제 launcher는 managed process slice **하나**여야 한다(소비자 1개 = 감사 표면 1개).
- **결정 3 — 계획 거부 코드는 호출자가 고를 수 없다.** 입양 중 getter/proxy가 던진 것은 **무엇이든**
  (호출자가 만든 `OrchestrationError` 포함) `plan_invalid`로 접는다. 대장 `C-38`이 지적한 "호출자가
  거부 taxonomy를 고른다"를 이 seam에서 닫은 것이며, 대가는 진단 정보가 한 단계 거칠어지는 것뿐이다.
- **결정 4 — 계획의 경로는 "정규화 가능"이 아니라 "이미 정규화됨"이어야 한다.** `docs/./a.md`처럼
  정규화가 값을 바꾸는 표기는 거부한다. 같은 파일을 가리키는 두 표기가 계획에 남으면 "승인된 경로와
  정확히 같은가"를 문자열 동치로 판정할 수 없고, 그 판정을 느슨하게 하는 순간 승인 대조가 흉내가 된다.
  이 규칙 덕분에 JSON Schema pattern과 런타임 판정이 **정확히 같은 표**를 낸다(대장 `C-40` 계열).

## 2026-07-30 (V3 M5c — **만료 후에도 안전만은 계속 움직인다: 전진은 닫고 회수는 연다**)

- **문제(권위 문서 충돌).** M4c 이후 kernel의 계약은 "만료된 승인으로는 **어떤 변경도** 하지 않는다"였다
  (`#mutate` 진입에서 `assertNotExpired`). M5c는 실제 프로세스와 durable lifecycle을 도입하므로 그 문장이
  **안전을 막는다**: 승인이 만료되는 순간 실행 중이던 task는 ⓐ 그 turn이 태운 토큰을 예산에 반영할 수 없고
  ⓑ 취소를 요청할 수 없고 ⓒ 자손 프로세스 정리 결과(zero-survivor receipt)를 durable에 남길 수 없고
  ⓓ fail-closed `paused`로 내려앉을 수도 없다. 그러면 만료가 곧 **회계 누락 + 프로세스 누수 + 자원 영구
  점유**가 된다(만료 시각을 스스로 넘기는 것만으로 예산을 회피할 수 있다).
- **결정.** `now >= expiresAt`(경계 포함 — 대장 `C-17`도 여기서 닫는다) 이후에는 **전진 작업을 전부 거부**하되
  아래 **safety-only reducer 집합만** 계속 커밋할 수 있게 한다. 집합은 코드에서 **닫힌 목록**이다
  (`SAFETY_ONLY_REASONS` / `#mutate({ safetyOnly: true })`):
  1. **usage charge** — 이미 태운 토큰·경과를 durable accounting에 반영한다(증가만, 감소·리셋 없음).
  2. **cancellation request** — `cancelRequestedAt`을 기록한다(취소는 전진이 아니다).
  3. **cleanup** — `cleaning` 진입 / cleanup 시도 카운트 / zero-survivor 확인 / `cleanup_unconfirmed`.
  4. **fail-closed pause·reconcile** — 중단·시계 역행·복구 후 `paused`로 내려앉히고 action을 정합화한다.
- **이 reducer들이 절대 못 하는 것(같은 게이트에서 강제한다).** 작업 시작(`ready|prepared → running`) ·
  실패한 전달의 수령(ack) · artifact 발행·등록 · `completed` 전이. 즉 **만료 후에 새로 생기는 산출물·권한·
  성공은 0건**이고, 만들어지는 것은 "이미 일어난 일의 회계"와 "자원 회수"뿐이다.
- **대가와 대안.** 대안 ①"만료 후 전부 거부 유지"는 위 4가지 누수를 그대로 남긴다. 대안 ②"만료 시 승인
  자동 연장"은 **사람 승인을 자동으로 넓히는 것**이므로 hard deny 방향이다. ③이 결정은 예외 집합을 코드에
  닫아 두고 그 밖은 전부 거부하므로, 감사 표면이 "reducer 4종"으로 bounded된다. 대가는 만료 뒤에도
  event·revision이 몇 건 더 늘어난다는 것뿐이다(전부 `manifest_expired` 이후임이 event에 남는다).
- **문서 정본 갱신.** 이 예외는 활성 로드맵 §8과 §10 M5c 절에 함께 적었다. 이전 판의 "만료 후 모든 변경
  거부" 문장은 **M4c~M5b 시점 기록**으로 읽고, 현행 계약은 이 항목과 로드맵 M5c 절이다.

## 2026-07-30 (V3 M5b 7차 리비전 — **검증의 단위는 트랜잭션이 아니라 syscall이다 · 이름을 만든 뒤에도 확인한다 · 증거를 지우는 일이 가장 위험한 쓰기다 · 계약 문서와 런타임은 정본을 공유한다**)

- **"한 번 증명했다"는 "그 프로세스 동안 증명됐다"가 아니다.** 6차까지는 경계 진입에서 git을 한 번 해싱하고
  그 뒤 여러 자식 프로세스를 띄웠다. 그런데 **첫 자식을 `await`하는 시간**은 파일을 제자리에서 갈아치우기에
  충분하고도 남는다 → 검증 단위를 **spawn 1회**로 좁혔다(`GitGate`, 게이트↔spawn 사이 `await` 금지).
  "검증을 더 자주 한다"가 아니라 **검증 단위를 실행 단위와 일치시킨다**가 이 finding의 요구였다.
  남는 창(fd 해싱→exec)은 Node에 `fexecve`가 없어 0이 될 수 없고, 그 사실은 **주장하지 않고 적는다**.
- **경로 이름을 받는 syscall은 검증을 무효화한다.** `link(2)`는 **pathname**을 받으므로 "증명한 fd를 그대로
  link"할 수 없다 → 증명과 link 사이 창은 원리적으로 0이 아니다. 그래서 방어를 **사전 증명 하나**에 걸지
  않고 **link 직후 재증명**을 붙였다. 사후 탐지가 사전 검증을 대체하지는 않지만, pathname API에서는
  **둘 다** 있어야 "우리가 만든 것이 실제로 우리 것인가"를 말할 수 있다.
- **증거 삭제는 가장 위험한 쓰기다.** `commit.journal` 삭제는 단순 정리가 아니라 **안전한 재시도 능력의
  폐기**다. 그래서 삭제를 `finishJournal()` **한 경로로 모으고**(정상 커밋 + 복구 공용) 그 앞에 **전수
  재증명**을 두었다. 앞선 시도가 발행한 body까지 다시 보는 이유: 부분 발행 뒤 재시도에서는 "이번에 link한
  것"만 확인해도 이미 있던 것이 조작됐을 수 있다. 그리고 fault hook을 sweep **앞**에 두어, 임의의 변경이
  **증거가 남아 있는 동안** 잡히게 했다.
- **소유 판정은 크기까지가 아니라 내용까지다.** dev/ino/size는 **같은 inode·같은 크기 제자리 변경**을 통과
  시킨다. 실행 파일에 이미 적용한 원칙(신원 ≠ 내용)을 durable body에도 같은 방식으로 적용했다 —
  판정은 **열린 fd 하나**에서 dev+ino·정확한 바이트 수·SHA-256을 함께 본다(`lstat` 뒤 다시 읽는 창 제거).
- **테스트 seam의 능력을 축소해 적지 않는다.** `setCommitFaultHook` 주석은 "부를 수 있는 것은 던지는
  일뿐"이라고 적혀 있었지만, 동기 콜백은 **파일 시스템을 임의로 바꿀 수 있고** 기존 테스트가 실제로 그렇게
  쓰고 있었다. 잘못된 안심을 주는 주석을 고치고, 그 능력이 **fail closed로 잡히게** 만들었다.
  seam 자체(export된 가변 전역)는 여전히 절충이므로 `C-36`은 open으로 남긴다.
- **범위가 줄었다고 닫지 않는다(`C-37`, 재확인).** 6차 source 주석은 roll forward 폐기를 근거로 "`C-37`
  닫힘"이라고 적었는데 **사실이 아니었다**. 목표 state가 durable해진 뒤의 실패는 여전히 caller가 본 결과와
  갈린다 → 주석을 정정하고 상태·기한을 그대로 유지한다. **문서가 코드보다 앞서 닫히는 일을 허용하지 않는다.**
- **계약 문서와 런타임은 정본을 공유한다(`C-40`).** schema regex가 `/a//b`·`/a/./b`·`/a/../b`를 통과시키고
  runtime만 거부하는 상태는 "runtime이 fail closed라서 안전"하긴 하지만 **두 개의 진실**을 남긴다.
  정규형 pattern 하나(`APPROVED_PATH_PATTERN`)를 만들어 runtime validator와 schema가 **같은 문자열**을 쓰게
  하고, 동치를 pattern 항등 + 양/음성 표 전수로 고정했다(정렬 전 1021 케이스 실측으로 명령형 판정과의
  동치를 먼저 증명한 뒤 교체). 이것이 "runtime에 검사 하나 더 붙이기"보다 작은 diff다.

## 2026-07-28 (V3 M5b 6차 리비전 — **실행 권위는 승인 문서에서 나온다 · 신원은 경로가 아니라 내용이다 · 복구는 후속을 발명하지 않는다 · 이름 발행은 no-clobber다**)

- **"양쪽이 같은 값을 봤다"는 신뢰가 아니다.** 5차까지는 provider와 controller가 각각 `executablePath`를 받고
  두 관측이 같으면 권위가 일치한다고 봤다. 그런데 두 값의 **출처가 같은 caller**이면 그 대조는 자기 자신과의
  비교다(리뷰 실측: `/usr/bin/true`를 양쪽에 주면 `authorityMatches: true`). 그래서 실행 권위의 유일한 출처를
  **kernel 소유 승인 manifest**(`executionAuthority`)로 옮기고 **호출자 경로 옵션 자체를 삭제**했다 —
  "검증을 하나 더 붙인다"가 아니라 **권위 모델을 바꾼다**가 이 finding의 요구였다.
- **실행 파일 신원은 path/dev/ino가 아니라 내용이다.** inode를 유지한 제자리 덮어쓰기는 dev/ino 검사를 그대로
  통과한다. 그래서 승인은 **내용 SHA-256**을 담고, 검증은 경로를 **한 번만 열어**(`O_RDONLY|O_NOFOLLOW`) 같은
  fd에서 신원·권한·내용을 함께 판정하며 **모든 spawn 직전에 다시** 한다. 비용(파일 크기에 비례하는 해싱)은
  승인 경계에서 감수할 값이고, `fexecve`가 없어 창이 0이 아니라는 사실은 **주장하지 않고 적는다**.
- **복구는 후속 state를 발명할 권한이 없다.** roll forward는 "감사 이력에 남은 커밋을 버리지 않는다"는 좋은
  의도였지만, 그 대가로 **journal이 말하는 target을 발행**했다 → 해시를 전부 다시 계산한 위조 후속이 승인
  manifest·milestone·task state를 갈아치울 수 있었다. 지금 복구가 할 수 있는 일은 **되돌리기**와
  **이미 쓰인 것 마무리하기** 둘뿐이다. 대가(완전한 append도 되돌린다)는 명시적으로 받아들인다 —
  "호출자가 받은 실패가 진실"이 "감사 tail 보존"보다 안전한 방향이다.
- **발행 순서가 복구 권한을 결정한다.** 최종 body를 state보다 먼저 만들면 roll back이 **증명되지 않은 최종
  파일을 지워야** 한다. 그래서 순서를 state 뒤로 옮겼다 → roll back은 자기 staging만 건드리고, 남의 파일을
  지우는 코드가 애초에 없다. 순서 재배치가 검증 추가보다 강한 이유다.
- **이름 발행은 rename이 아니라 no-clobber다.** POSIX `rename`은 대상을 조용히 덮으므로 "계획 이후 생긴 남의
  파일"을 파괴한다. `link(2)`는 대상이 있으면 `EEXIST`이므로 **덮어쓰기가 원자적으로 불가능**하다. 그리고
  "우리 것"의 근거는 digest가 아니라 **journal이 기록한 dev+ino**다 — 같은 내용의 남의 파일을 채택하는 것도
  오류다. 한계(같은 파일 시스템·POSIX 신원 전제)는 코드와 문서에 함께 적는다.
- **정규형은 validator 출력 바이트다.** `JSON.stringify(JSON.parse(line))`는 key 순서를 보존하므로 정규형
  판정이 아니다. 정본을 `JSON.stringify(validateEvent(...))` 하나로 만들고 **쓰는 쪽도 같은 함수로** 직렬화해
  "쓰기와 검증이 같은 정본"을 강제했다.
- **범위가 줄었다고 닫지 않는다(`C-37`).** roll forward 폐기로 "호출자가 받은 실패를 다음 열기가 완료로 만드는"
  경계가 11개 중 2개로 줄었지만 **여전히 존재**하므로 open으로 남기고, 줄어든 범위를 증거와 함께 적는다.
  대장은 "고쳤다"의 기록이 아니라 **현재 사실**의 기록이다.

## 2026-07-28 (V3 M5b 5차 리비전 — **증명은 "누가"가 아니라 "무엇을 실행하는가"까지다 · 복구는 크기가 아니라 바이트로 판정한다 · SoR 이름공간에는 승인된 것만 나타난다 · 복구 기록도 closed schema다**)

- **증명(attestation)은 발급 주체만이 아니라 "실행 설정"까지 포함해야 한다.** 4차까지의 증명은 "이 인스턴스가
  진짜 생성자를 지났고 메서드가 prototype의 그 함수인가"만 봤다. 그런데 provider의 위험은 클래스가 아니라
  **무엇을 실행하느냐**에 있다: 같은 클래스·같은 메서드라도 `executablePath`가 사용자 소유 0700 스크립트면
  진짜 `spawn`이 그것을 codex처럼 띄운다(리뷰 실측: `/bin/echo`·`/bin/true` 통과). 그래서 증명은 **생성 시점에
  런타임 검증한 불변 설정 신원**(codex/git 실행 파일 dev+ino · checkout · 승인 digest · 시각 권위)을 근거로
  삼고, **판정 함수는 호출자가 스스로 검증해 온 기대값과의 대조 결과만** 돌려준다. 신원 객체를 밖으로 주면
  "attested"가 승인처럼 읽히므로 **내보내지 않는다**.
- **기대 권위는 호출자가 명시로 주고 스스로 검증해야 한다.** controller가 codex 실행 파일 경로를 **필수 옵션**
  으로 받지 않으면, "무엇이 승인된 실행 파일인가"의 유일한 출처가 provider 자신이 된다(자기 신고).
  그래서 `codexExecutablePath`를 필수로 만들고 controller가 직접 검증한다 — 승인의 출처는 여전히 kernel(SoR)이다.
- **시각 권위의 "호환"은 동일 함수 또는 진짜 시스템 시계뿐이다.** 호출자가 고른 제3의 시계를 든 provider는
  controller가 만료로 보는 시점에 "유효"를 판정할 수 있다. 반대로 `Date.now`는 호출자가 골라 거짓말시킬 수
  있는 값이 아니고, 결정론적 테스트 시계보다 **엄격한** 방향이다 → 그 둘만 인정한다(fail-safe).
- **SoR 이름공간에는 승인된 것만 나타난다.** `messages/<id>.md`는 "이 메시지가 존재한다"는 공표다. 그 이름을
  **journal보다 먼저** 만들면 실패한 전이가 색인되지 않은 durable 데이터를 남기고, 색인만 보는 load는 그것을
  탐지도 정리도 하지 못한다. 그래서 발행 순서는 **staging → journal → 최종 이름**이고, journal 이전 실패는
  스스로 정리하며 이후는 **결정론적 복구가 유일한 정리 주체**다. "orphan body는 무해"는 규칙이 아니라 누락이었다.
- **복구는 파일 크기가 아니라 실제 바이트로 판정한다.** "크기가 정확히 맞을 때만 tail을 읽고 나머지는 잘라낸다"는
  규칙은 **남의 append-only 감사 바이트를 파괴**한다. 되돌릴 수 있는 것은 **내가 쓰려던 바이트의 정확한 접두**
  뿐이고, 그 밖은 **fail closed로 사람에게 넘긴다** — 데이터 손실보다 정지가 낫다.
- **복구 기록(journal)도 state와 같은 등급의 closed schema다.** journal은 "무엇을 발행해도 되는가"를 말하는
  권위 문서이므로, 열린 객체로 두면 그럴듯한 파일 하나가 유효 state를 덮어쓴다. 그래서 schema를 닫고
  경로 runId·milestone·승인 digest·**기준 state 원본 바이트**·후속 revision·정규 event record·해시 체인·
  최종 state digest·body digest에 **전부 묶고**, **어떤 쓰기·삭제보다 먼저** 전수 검증한다.
- **중복 방어는 mutation으로만 구분된다.** `stateContentDigest` 묶기를 제거해도 처음에는 아무 테스트도 실패하지
  않았다(다른 검사들이 그 경로를 먼저 잡았다). "다른 검사를 전부 맞춰 온 정합적 위조" 회귀를 추가해 그
  묶기가 **단독으로 load-bearing**임을 고정했고, 그 과정을 기록에서 지우지 않는다.
- **부하 기인 실패는 테스트 완화로 없애지 않는다.** `test:exec` 첫 실행의 `boundary_git_failed` 1건은 고정
  10초 git 상한 + 호스트 부하이고 즉시 재실행은 전부 통과였다. 수치와 원인을 기록에 남기고, 대신 회귀들이
  케이스마다 새 checkout을 만들지 않게 **run 하나를 공유**하도록 정리했다(단정은 그대로).

## 2026-07-28 (V3 M5b 4차 리비전 — **감춤은 런타임에서 증명돼야 한다 · 성공 권위는 발급받은 것만 · 원자성은 논리가 아니라 물리에서 필요하다 · caller 입력은 한 번만 읽는다**)

- **"TS `private`을 `#private`으로 바꿨다"는 파일 단위가 아니라 필드 단위 작업이다.** 3차 리비전은
  executor·세션 map만 `#private`으로 옮기고 **같은 클래스의 나머지 상태**(controller의 봉인 권위·pin·토큰
  카운터·`opts`, provider의 설정)를 TS `private`에 남겼다 → 리뷰어가 런타임 descriptor로 그대로 재현했다.
  규칙: 권위·카운터·게이트를 옮길 때는 **인스턴스의 own-property 목록이 비었는지**를 테스트가 단정하고,
  거기에 **`Object.freeze(this)` + `Object.freeze(prototype)`** 를 더한다. freeze는 `#private` 상태를 건드리지
  않으므로(property가 아니다) 내부 카운터는 그대로 동작하고, **prototype 메서드를 own property로 덮어
  게이트를 no-op으로 만드는 경로**까지 함께 닫힌다. TS `private` **메서드**도 이 통로였다.
- **성공을 발급하는 권위는 "모양"이 아니라 "발급 기록"으로 판정한다.** kernel처럼 **성공을 만들어 내는**
  협력자는 메서드 shape 검사로 받아들이면 안 된다 — 스케줄링은 진짜에 위임하고 완료만 위조하는 delegate가
  **디스크 변화 0으로 success**를 만든다. 규칙: 그 모듈 안에서만 채워지는 **사설 등록부 + 사설 생성 토큰**
  으로 발급을 기록하고(exported TS `private constructor`는 emitted JS에서 호출 가능하므로 토큰이 필요하다),
  밖으로는 **판정 함수 하나만** 내보낸다. 인스턴스는 own property 0 · freeze, 공개 getter는 **freeze된 값만**
  돌려준다. 그리고 **성공 테스트는 디스크와 reopen으로 확인한다** — 반환값만 보는 성공 테스트는 위조 권위를
  통과시킨다.
- **테스트 seam이 production 성공 권위에 연결되면 그 seam이 결함이다.** 기존 `delegateKernel`은 taxonomy
  테스트용이었지만 controller의 성공/실패 경계에 그대로 꽂혀 있었다. 규칙: 임의 seam이 필요하면 그것을
  **"거부됨"을 증명하는 자리**로 옮기고, 실제 taxonomy는 **진짜 권위가 실제로 낼 수 있는 코드**로 시험한다
  (여기서는 `run_lock_held`). seam이 필요한 계층은 store처럼 **권위가 아닌 곳에 bounded hook**으로 둔다.
- **논리적 트랜잭션 하나가 물리적 원자성을 주지 않는다.** `#mutate` 하나로 합쳐도 발행이 body → event →
  snapshot → state 네 연산이면 **append 성공 뒤 실패**가 낡은 state + 새 event tail을 남겨 reopen과 재시도가
  **동시에** 깨진다(forward progress 상실). 규칙: 발행 전에 **journal을 원자적으로 남기고** 다음 열기가
  **결정론적·멱등 규칙**으로 roll forward/roll back한다. 관찰 결과는 **가시적 전이 0 또는 일관된 후 상태**
  둘 중 하나여야 하고 문서의 "원자적/불변" 표현을 그 보장과 정확히 일치시킨다("언제나 전이 0"이라고 적지
  않는다). append-only 감사 이력은 **커밋된 것은 버리지 않고**(roll forward) 미승인·찢어진 tail만 되돌린다.
  대가는 "호출자는 실패를 받았는데 durable은 완료"라는 창이며, 숨기지 않고 대장(`C-37`)에 남긴다.
- **발행 전에 예정 state 전체를 load와 같은 validator로 다시 닫는다.** 커밋 경로와 load 경로가 다른 강도로
  검증하면, caller 유래 값이 durable에 들어간 뒤 **reopen만 실패하는** 상태가 생긴다(A4가 정확히 그것이다).
  규칙: 커밋은 **발행할 바이트**를 런타임 validator + 참조 무결성 + digest 동일성으로 통과시킨 뒤에만 쓴다.
- **caller-owned 입력은 "검증 → 재읽기"가 아니라 "한 번 읽어 입양"이다.** 검증한 값과 저장하는 값이 다른
  읽기에서 오면 교대 getter가 그 사이를 벌린다. 규칙: key 집합을 **닫고**(string 외 key·symbol·미상 key 거부)
  각 property를 **정확히 한 번** 읽어 평범한 불변값으로 굳히고, 그 뒤로는 원본을 보지 않는다. 읽는 중의
  throw(`get`/`ownKeys` trap)는 **안정 코드로 접는다** — 경계 밖 오류가 taxonomy를 고르지 못하게 한다.
  진입점이 둘이면(단건·트랜잭션) **같은 헬퍼**를 쓰게 해서 규칙이 갈라지지 않게 한다.

## 2026-07-28 (V3 M5b 3차 리비전 — **권위의 근거는 공개 API 밖에 있어야 한다 · 완료는 한 커밋이어야 한다**)

- **증명의 근거는 "생성자를 지났는가"가 아니라 "무엇을 실행하는가"다.** 2차 리비전은 `CodexCliProvider`
  생성자를 지난 인스턴스를 전부 증명했는데, 그 생성자가 **호출자 임의 callback을 executor로 받는다**.
  즉 증명서는 "이 클래스가 만든 객체"를 보증했을 뿐 "승인된 실행 계약을 실제로 집행한다"를 보증하지
  않았다. 규칙: **executor가 production binding일 때만 증명한다.** 테스트 seam은 없애지 않되 그런
  인스턴스는 **untrusted**로 두고, 증명이 필요한 계층의 테스트는 **production 경로 그대로** 돌린다.
- **TS `private`은 봉인이 아니다.** emitted JS에서는 writable own field이므로 대입·`defineProperty`로
  갈아끼울 수 있고, 실제로 이전 테스트가 그렇게 했다. 규칙: **실행 권위·내부 상태는 ECMAScript
  `#private`** 로 둔다. "테스트가 내부를 갈아끼워야 관측 가능하다"면 그것은 관측 API가 없다는 신호이지
  봉인을 풀 이유가 아니다 — 공개 API로 관측 가능한 프로브를 찾는다.
- **exported class는 provenance가 아니다.** `instanceof ControllerError`를 "내부 오류"의 근거로 쓰면
  누구나 그 클래스를 `new` 해서 내부를 사칭한다. 규칙: provenance는 **모듈 사설 상태**(WeakSet)로 두고,
  경계 밖이 던진 값은 **실제 클래스와 무관하게** 그 지점의 고정 코드로 접는다. 예외를 하나라도 두면
  그 예외가 통로가 된다.
- **"권위 계층"과 "호출자가 준 객체"는 다르다.** kernel은 SoR 권위지만 `opts.kernel`은 **호출자 객체**다.
  그 native 코드에 진단 가치가 있으므로 버리지 않되, **닫힌 허용 집합**에 있을 때만 입양하고 나머지는
  단일 코드로 접는다. 새 코드는 자동 편입되지 않고 fail closed로 접힌다(진단 해상도가 줄어드는 비용은
  대장에 남긴다). 반면 **정적 import한 신뢰 모듈**은 코드 집합이 그 모듈에 닫혀 있으므로 그대로 입양한다 —
  신뢰의 근거는 **오류 객체의 클래스가 아니라 호출 지점**이다.
- **접힘은 "호출"뿐 아니라 "반환값 읽기"까지 덮어야 한다.** 호출자가 준 객체가 돌려준 값의 getter도
  호출자 코드다. 규칙: 경계 밖 값은 **읽는 즉시 봉인 사본**(`structuredClone` + deep freeze)으로 굳히고
  그 사본만 쓴다. 이것이 provenance 위조와 TOCTOU alias를 동시에 닫는다.
- **여러 durable 쓰기가 하나의 논리적 완료라면 API도 하나여야 한다.** "artifact N건 등록 후 결과 제출"을
  호출자가 순서대로 조립하게 두면, 중간 실패가 **부분 적용**을 남기고 재시도가 revision 찌꺼기를 쌓는다.
  규칙: 원자성이 필요한 단위는 **SoR이 트랜잭션 API로 제공**하고 호출자는 그것 하나만 부른다. 호출자가
  등록 전에 알 수 없는 값(revision·sha256)은 **호출자가 주장하지 않고 트랜잭션이 채운다**(빈 `artifactRefs`
  요구). 집행 불변식은 새 경로가 아니라 **기존 헬퍼를 공유**해 진입점이 늘어도 규칙이 갈라지지 않게 한다.
- **살아남은 mutation은 숨기지 않고 등록한다.** `codeOf`의 provenance 검사는 래퍼들이 이미 접어 올리므로
  대부분 경로에서 중복 방어였다. 실제 도달 경로를 찾아 회귀를 하나 추가해 죽였고, 남은 중복성은
  대장 `C-34`로 남겼다. **"테스트가 안 죽으니 괜찮다"가 아니라 "왜 안 죽는지"를 적는다.**

## 2026-07-28 (V3 M5b 2차 리비전 — **"고쳤다"는 판정은 그 판정 자체가 검증 대상이다**)

- **"전부 fixed"라고 적지 않는다.** 1차 리비전은 A/P1 5건을 "전부 닫았다"고 기록했고 2차 독립 리뷰가
  **같은 다섯 자리에서 A=5**를 다시 냈다. 넷은 "고쳤다고 적은 코드가 여전히 열려 있었다"였다.
  규칙: 리비전 기록은 **무엇을 어떤 증거로 닫았는지**만 적고 **최종 상태는 "독립 재리뷰 pending"** 으로
  남긴다. 자기평가로 A를 닫힌 것으로 확정하지 않는다.
- **권위는 "정확히 한 번 읽는다"로만 성립한다.** 1차 리비전의 "포착"은 대부분 bind였지만 두 메서드가
  호출 시점 재읽기 wrapper였고, 검증도 **검사 후 재읽기**였다. 교대 getter·proxy·재진입 시계 앞에서는
  "검사한 값"과 "실행하는 값"이 다를 수 있다. 규칙: **읽기는 한 번, 그 값으로 검증하고 그 값을 bind하고
  그 값을 pin 기준으로 쓴다.** 세 용도가 같은 한 번의 읽기를 공유하지 않으면 봉인이 아니다.
- **공개 export된 brand는 집행이 아니라 자기 신고다.** 심볼을 `types.ts`에서 내보내면 같은 프로세스의
  아무 provider나 import해 자기에게 달 수 있다. 규칙: 권위 증명은 **모듈 사설 상태**(WeakSet)로 두고
  등록 경로는 **실제 구현의 생성자 하나**, 밖으로 나가는 것은 **판정 함수 하나**다. 발급기·토큰·
  "임의 provider를 증명해 주는 factory"는 만들지 않는다 — 그것을 만드는 순간 다시 자기 신고가 된다.
  겉모습(심볼·메서드 shape·prototype)은 근거가 아니고 **생성 사실 + 함수 신원**이 근거다.
- **주장 범위를 함께 적는다.** 이 증명은 "같은 프로세스에서 **공개 API만으로는** 못 들어온다"이고
  **OS 샌드박스 격리가 아니다**. 프로세스 안에서 모듈 내부를 직접 조작할 수 있는 코드는 여전히 있다.
  범위를 적지 않은 보안 주장은 다음 리뷰에서 반드시 A가 된다.
- **테스트 double은 증명을 우회하는 뒷문이 되면 안 된다.** "brand를 명시적으로 다는 테스트 provider"는
  곧 "아무나 brand를 달 수 있다"였다. 규칙: 결정론이 필요하면 **실제 구현이 이미 가진 seam**
  (여기서는 `CodexCliProvider`의 주입 `spawn`)을 쓰고, 관측은 그 seam이 실제로 받는 값으로 한다.
  provider를 감싸거나 subclass하면 증명을 통과하지 못하는 것이 **정상**이다.
  대가: 흉내 provider로만 만들 수 있던 스트림(중복 종료·결과 부재)은 controller e2e로 못 만든다 →
  그 불변식은 **controller가 실제로 쓰는 코드 집합**에 대고 공용 소비자에 직접 단정하고, 도달 불가라는
  사실을 대장(`C-30`)에 남긴다. 커버리지를 조용히 줄이지 않는다.
- **회계는 판정보다 먼저다.** 실패 turn도 토큰을 태운다. "실패했으니 던진다"를 usage 회계보다 앞에 두면
  **실패가 예산을 무료로 만든다**. 규칙: 자원 소비는 **성공/실패를 해석하기 전에** 정확히 한 번 기록한다.
- **오류 코드는 신뢰 경계다.** 호출된 쪽이 `code` 문자열을 고를 수 있으면 그것은 **오케스트레이션 결과를
  고르는 것**이다(`code: "result_accepted"`). 규칙: 경계 밖에서 온 예외는 **참조 동일성으로 구별해**
  이쪽 계층의 안정 코드로 접는다. "그럴듯한 코드를 그대로 통과"는 편의가 아니라 취약점이다.
- **파서에서 "무시"는 통과와 같다.** 형식을 벗어난 줄을 조용히 버리면 `- 없음` 옆의 `P1: 승인 우회`가
  사라진다. 규칙: 판정 입력 파서는 **모든 비공백 줄을 분류하거나 거부**한다. 부분 문자열 매칭
  (`includes`)은 신원 확인이 아니고, 펜스는 **여는 길이를 기억해야** 펜스다.

## 2026-07-27 (V3 M5b 1차 리비전 — **집행하지 못하는 것을 계약이라고 적지 않는다**)

- **봉인은 "읽지 않는다"로만 성립한다.** 이전 판은 값을 `Object.freeze`한 객체에 복사해 두고도 매 게이트에서
  **caller-owned `opts`에서 실행 입력을 다시 읽었다** → 봉인은 문서에만 있었다. 규칙: **생성 시점에 객체와
  호출할 메서드 함수까지 포착**하고, 그 뒤 `this.opts`는 **tripwire 전용**이다. 두 가지를 함께 하는 이유:
  포착만 하면 교체가 **조용히 무시**되고(호출자는 자기 patch가 먹었다고 믿는다), tripwire만 있으면 게이트
  사이 창이 남는다. 둘을 합치면 교체는 **실행되지도 않고 조용히 지나가지도 않는다**.
- **freeze는 깊어야 freeze다.** 겉 객체만 얼리면 `manifest.writableRoots.push("infra")`가 통한다.
  승인·스냅샷은 **재귀 freeze**하고, 밖으로 나가는 것은 **방어적 사본**이다 — 권위 객체 자체를 handoff에
  넘기면 "누가 승인을 들고 있는가"가 흐려진다.
- **호출자 객체는 await를 건너지 못한다.** handoff가 준 `spec`/`request`/`outputs`를 그대로 들고 여러 await를
  지나면 그것은 **살아 있는 alias**다. 규칙: **await 하나도 지나기 전에** closed 검증 → 깊은 복사 → freeze.
  `structuredClone`이 거부하는 값(함수 등)이 섞여 있으면 그 자리에서 fail closed다 — 관용하지 않는다.
- **검증한 값만 실행한다.** 경계가 `targetRoot`를 확인해 돌려주는데도 호출자 `cwd` **문자열**을 provider에
  넘기고 있었다. 검사 대상과 실행 대상이 다르면 검사는 장식이다. 이제 **경계가 돌려준 값으로 새 불변 spec**을
  만든다.
- **집행하지 못하는 것을 정책이라고 부르지 않는다.** `compileExecutionPolicy`는 handoff의 **자기 선언**을
  검증했고, 컴파일 결과는 버려졌고, provider의 실제 권한은 그것과 **독립**이었다. 그래서 "정확히 승인된 명령만
  실행된다"는 서술은 **거짓**이었다. 선택 두 가지 중 후자를 골랐다: ⓐ 지금 실행 집행 계층을 만든다
  ⓑ **이 slice의 계약을 실제로 증명할 수 있는 것으로 좁힌다**. M5b는 read-only Codex planning/review
  bridge이므로 ⓑ가 정직하다 — 명령·쓰기·dependency·네트워크·merge·MCP 요구는 **범위를 따지지 않고 전부
  거부**한다. 타입 있는 집행은 별도 승인 범위(`B-10`, M5c)로 대장에 남겼다. **범위를 좁히는 것은 후퇴가
  아니라 거짓 주장을 지우는 것이다.**
- **신원은 문자열이 아니다 — brand로 받는다.** provider를 `id === "codex-cli"`로 판정하면 아무 객체나 같은
  id를 달고 들어온다. read-only·strict-empty-MCP를 **실제로 집행하는 구현**이 심볼 brand를 발급하고
  controller는 **그 참조**로만 수락한다. 그리고 그 brand가 **보장하지 않는 것**(같은 프로세스의 코드는 import해
  달 수 있다 = 프로세스 격리가 아니라 레포 안의 명시 계약)을 주석에 적었다. 테스트 seam은 숨기지 않는다 —
  숨긴 seam이 production 구멍이 된다.
- **불완전한 shell 파서는 만들지 않는다.** `bin/git push` · `git -c … push` · `sh -c`를 잡으려 정규식을 늘리면
  "승인된 것처럼 보이는 명령"을 판정하게 되고, 그 화면이 있다는 사실 자체가 잘못된 안심을 만든다.
  대신 **명령을 아예 허용하지 않고**, 상향 경로는 승인 단계에서 명령을 **구조화(프로그램+인자)** 로 받는 것이다.
- **권한은 권위 계층에서 집행한다.** artifact 소유권을 controller가 선언으로 검사하면 controller를 지나지 않는
  호출자가 곧 구멍이다. `registerArtifact` **하나**가 모든 호출자가 지나는 좁은 API이므로 불변식을 거기에 둔다
  (ponytail: 호출자마다 가드가 아니라 공유 함수에 가드 하나 = 더 짧은 diff이자 근본 수정).
- **게이트는 "한 번"이 아니라 "호출마다"다.** 예산·만료를 batch 진입에 한 번만 보면, 소진을 **아는 상태에서**
  다음 task가 프로세스를 띄운다. 규칙: **provider start·send 직전마다** 다시 본다. 이미 durable running인
  task를 회수하는 것은 lifecycle 설계(M5c `B-11`/`B-13`)의 일이므로, 지금은 **새 작업이 시작되지 않는 것**만
  보장하고 그 한계를 대장에 적는다.
- **검증과 호출 사이에 await를 두지 않는다.** 포인터를 검증한 뒤 비동기 경계를 건너면 그 검증은 낡았다.
  **await 없는 단일 동기 게이트**를 두고 그 다음 문장이 provider 호출이다 — M5a의 pre-spawn 동기 게이트와
  같은 형태이며, 창을 0으로 만들 수 없는 부분은 그대로 명시한다.
- **종료는 정확히 1건이다.** `result = e`로 덮어쓰면 **실패 종료 뒤 성공 종료가 이긴다.** 두 소비자
  (reviewer · controller)가 같은 실수를 했으므로 **소비자를 하나로 공유**했다(ponytail 2번 rung).
  종료 뒤에는 **아무 이벤트도** 오지 않는다 — 늦은 assistant도 거부다.
- **리뷰 파싱은 부분 문자열이 아니라 스키마다.** `raw.includes("## Risks")`는 코드 펜스 안의 인용과 프롬프트
  에코를 헤더로 인정했고, **첫** verdict만 읽으면 모순 섹션을 중복으로 넣어 판정을 고를 수 있었다. 규칙:
  **펜스를 걷어낸 뒤** 활성 로드맵 §5.2 스키마로 파싱하고, 필수 heading **각각 정확히 1회** · verdict
  **정확히 1개** · **미상·중복·모순 거부**다. 그리고 리뷰어가 "무엇을 봤는지"는 **호출자가 준 기대값**에
  묶는다 — 리뷰어 자기 주장은 근거가 아니다.
- **문서가 구현보다 관대하면 문서를 고치지 말고 구현을 고친다.** "usage는 durable state에 없다"고 적어 놓고
  `resultBody`가 토큰 카운트를 적고 있었다. 선택: schema를 여는 대신 **durable usage를 제거**하고 부재를
  회귀로 고정했다(durable 회계는 `C-9` 마이그레이션이 걸린 별도 설계 — `B-12`). 회귀 테스트가 durable
  산출물에서 "usage"라는 **낱말의 부재까지** 단정하므로, 다음 사람이 무심코 되살리면 즉시 실패한다.
- **증거는 누가 돌렸는지까지 적는다.** 이전 판의 PASS/race/mutation 수치는 **구현 세션 자기보고**인데
  독립 확인처럼 읽혔다. read-only 리뷰어는 명령을 재실행하지 않는다 — 커밋된 소스로 독립 확인 가능한 것은
  **static 테스트 개수**뿐이다. 라벨을 그렇게 고쳤다.

## 2026-07-27 (V3 M5b — **다리는 다리로 남긴다: 권위는 kernel 하나, 게이트는 fail closed 하나**)

> **정정 안내(1차 리비전):** 아래 항목 중 "봉인" · "deny-by-default 정책이 hard deny를 집행한다" ·
> "usage는 반환값" · `B-8` fixed 판정은 **당시 사실과 달랐다**. 현행 판단은 위 절이다.
> 나머지(kernel 단일 권위 · ack 순서 · 핸들 재구성 금지 · 실패 task를 조용히 진행시키지 않음 ·
> 중복 방어의 커버리지를 정직하게 적음 · 스스로를 승인하지 않음)는 그대로 유효하며 리비전도 보존했다.

- **kernel이 상태 권위이고 controller는 그 위의 다리다.** M5b는 "실행을 붙이는" 마일스톤이라 두 번째
  scheduler·DAG·큐·상태 파일을 만들고 싶어지는 자리다. 그렇게 하면 durable state가 두 곳이 되고
  **어느 쪽이 진실인지**를 매 실패마다 판정해야 한다. 규칙: controller가 kernel에 하는 일은 좁은 API
  호출뿐이다(`scheduleReady` → `startScheduledBatch` → `registerArtifact` → `submitResult` /
  `acknowledgeDelivery`). `runParallelMission`도 부르거나 감싸거나 복제하지 않았다 — **재사용처럼 보이지만
  실제로는 두 번째 실행 경로**이기 때문이다. 이 순서를 늘리거나 우회하는 변경은 **A급 회귀**로 본다.
- **리뷰 게이트는 fail closed다 — 침묵은 통과가 아니다.** 리뷰어가 죽거나 아무 말도 못 하면 Critical 0건이
  되어 **게이트가 조용히 열리는** 것이 `B-8`이었다. 선택: `reviewDiff`는 의심스러우면 **판정을 만들지 않고
  던진다**(안정 `ReviewGateError` 코드 1개씩). 특히 **verdict와 Critical 목록이 모순이면 어느 쪽도 통과
  근거로 쓰지 않는다** — pass인데 Critical이 있거나 revise/block인데 Critical이 없으면 그 출력은 신뢰할 수
  없는 것이지 "둘 중 관대한 쪽"이 아니다. 판정 문자열은 **명시 `## Verdict: pass|revise|block`** 하나이고
  본문에서 추론하지 않는다.
- **정책은 handoff마다 하나로 컴파일되는 deny-by-default 결정이다.** 권한을 호출 지점마다 검사하면
  "검사하지 않은 호출 지점" 하나가 곧 구멍이다. 그래서 **`compileExecutionPolicy` 하나**가 정확한 명령
  allowlist · 정확히 pin된 dependency · 정확한 도메인 · task 소유권/writableRoots · 로컬 merge · 예산을
  한 번에 결정하고, **레포 hard deny**(production deploy · live billing · 원격 저장소 직접 쓰기 · PR merge ·
  MCP `@latest`)는 **manifest 항목이 덮지 못한다** — 승인 문서가 레포 금지를 열 수 있으면 승인 하나로
  hard deny 전체가 무의미해진다. 게이트는 **provider start·send 이전, 그리고 ack 이전**에 돈다.
- **수령(ack)은 "보냈다"가 아니라 "받아졌다" 뒤에 한다.** `send` 성공만으로 ack하면 실패한 turn의 전달이
  durable하게 소비 처리되어 **조용히 유실**된다. 규칙: 그 전달 turn이 **성공 종료 결과**를 낸 뒤에만
  ack하고, 실패는 ack 0이다. inbox는 durable 순서대로 소비한다.
- **핸들은 재구성하지 않는다.** M5a 5차가 핸들을 인스턴스에 묶었으므로, 배선 쪽에서 `{sessionId, spec}`을
  다시 조립하면 fail closed다. controller는 provider가 준 **그 객체 그대로** 들고 다닌다 — 저장하지도
  직렬화하지도 않는다.
- **durable state에 raw를 넣지 않는다 — usage도 state가 아니다.** 프롬프트·transcript·stdout/stderr·argv·
  secret·`SessionHandle`은 어디에도 저장하지 않는다. usage 카운터는 유용하지만 **state schema를 건드리는
  순간 마이그레이션 부채**(`C-9`)가 되므로 **반환값**으로만 내보낸다. 필요해지면 그때 승인받아 schema를 연다.
- **실패한 task는 조용히 진행시키지 않는다.** 정책 거부·artifact 드리프트·manifest 드리프트/만료·예산 소진·
  낡은 핸들은 task를 완료로 만들지도 전달을 수령하지도 않고 **안정 bounded outcome**으로 돌아온다. 실패한
  task를 지금 `running`으로 남겨 자원을 붙잡는 것은 **의도한 선택**이다 — 자동 회수는 pause/recovery 설계가
  있는 M5c의 일이고, 그 전에 자동으로 풀어주면 "실패했는데 진행됐다"가 된다.
- **중복 방어를 남기되 커버리지는 정직하게 적는다.** durable **직전**의 artifact 포인터 재검증은 단독
  mutation으로 죽지 않는다 — `registerArtifact`와 바로 뒤 `submitResult`가 **사이에 await 없이** 같은
  포인터를 다시 검증하기 때문이다. 그래도 남긴다(미래에 await가 하나 끼는 순간 조용히 열리는 방어보다
  구조적으로 닫힌 편이 낫다). 대신 **코드 주석이 그 한계를 직접 말한다** — M5a 5차의 봉인 clock과 같은
  판단이고, 같은 이유로 **커버리지를 과대 주장하지 않는다**.
- **M5b는 스스로를 승인하지 않는다.** 구현 세션의 자기평가는 승인이 아니다. 위 fixed 판정 5건도 포함해
  **supervisor의 fresh Codex read-only 독립 리뷰가 다음 게이트**이며, 그 전까지 문서는 "구현 완료 ·
  리뷰 대기"로만 적는다. M5a의 `C-23` overclaim 이력이 이 규칙의 이유다.

## 2026-07-27 (V3 M5a 5차 리비전 — **신원과 권위는 밖에서 들어오는 값으로 정하지 않는다**)

- **id는 신원이 아니다 — 핸들은 인스턴스에 묶는다.** 같은 `sessionId`로 만들어진 교체 세션이 존재하는 한,
  id 비교는 "누구의 세션인가"에 답하지 못한다. 그래서 세션 인스턴스마다 **내용 없는 frozen 객체**를 발급해
  핸들에 붙이고 **참조 동일성**으로만 판정한다. 이 선택의 이유: ⓐ 위조 불가(그 참조를 이미 가진 쪽만 쓴다)
  ⓑ **비밀이 아니다** — 난수·토큰 문자열이었다면 로그·직렬화·문서에서 지워야 할 material이 되지만 빈 객체는
  새어도 잃을 것이 없다 ⓒ 공유 인터페이스에는 **선택 필드 하나**만 늘어 다른 provider가 그대로 동작한다.
  낡은 핸들의 `stop`은 **던지지 않고 조용히 무해**하게 둔다 — `stop`은 이미 멱등 계약이고, 여기서 던지면
  "정리 코드가 예외를 만난다"는 새로운 실패 모드를 만든다.
- **실행 권위는 포착한 값이고, 시각도 권위다.** 만료 판정에 쓰는 **시계 자체가 호출자 소유 함수**라는 점을
  놓치면, 봉인은 "값"만 지키고 **판정 기준**은 갈아끼울 수 있게 남는다. 규칙: **invocation 중에 `this.opts`
  에서 읽는 실행 입력은 0**이다. 시계는 `start()`에서 포착하고 **매 검사마다 다시 호출**한다 — 시각을
  얼리면 만료 재확인이 무의미해지므로 **고정하는 것이 아니라 출처를 고정**한다.
- **드리프트 탐지와 재읽기 차단은 둘 다 남긴다(중복이라도).** 지금 코드에서는 검사와 사용 사이에 await가
  없어 재읽기만으로는 실패하는 테스트가 없다. 그래도 봉인값을 쓰는 쪽을 택했다 — **미래에 await가 하나
  끼어드는 순간 조용히 다시 열리는 방어**보다, 구조적으로 닫힌 방어가 낫다. 대신 mutation 커버리지가
  중복임을 **정직하게 기록**한다.
- **문서가 약속한 marker는 코드가 지켜야 한다.** "post-start 드리프트는 전부 `codex_spec_mutated`"라고
  적어두고 native 오류를 흘리면, 테스트가 그 native 코드를 기대하도록 굳어 **증거가 문서를 반박**한다.
  선택: **초기 `start`는 정밀 코드**(어디가 잘못됐는지 알아야 고친다), **start 이후는 단일 marker**
  (변조자에게 어느 필드가 왜 막혔는지 알려주지 않는다). 둘 중 하나를 포기하는 대신 **경계로 나눴다**.
- **대장의 "fixed"는 두 번 틀렸다 — 이력을 지우지 않는다.** `C-23`은 3차에서 overclaim, 4차에서 부분 fix,
  5차에서 완결이다. 행에 **세 단계를 모두** 남긴다. 반대로 `C-28`은 이번에 **구현+테스트까지** 했으므로
  fixed로 닫고, `C-26`·`C-27`은 손대지 않았으므로 **기한·트리거·증거를 그대로 둔 채 open**이다.
  "인접해서 쉬워 보인다"는 close 사유가 아니다.

## 2026-07-27 (V3 M5a 4차 리비전 — 게이트를 지날 **자격**은 첫 await 전에 정해져야 한다)

- **소유권은 동기적으로 claim한다 — "검사했다"와 "점유했다"는 다른 사건이다.** 3차까지 게이트는 제자리에
  있었지만, 세션 점유가 **await된 경계 검증 뒤**였다. 그래서 두 호출자가 같은 검사를 통과하고 둘 다
  spawn까지 갈 수 있었다. 규칙: **모든 상태 전이 결정은 첫 await 전에 동기로 끝낸다.** 여기서는
  `starting` 상태 + 재사용되지 않는 **단조 증가 generation 토큰**이고, 겹친 호출은 spawn·발행 없이 거부된다.
  이 순서(claim → 검증 → 게이트 → 발행 → spawn)를 바꾸는 변경은 **A급 회귀**로 본다.
- **취소는 child의 존재와 무관해야 한다.** `stop()`이 "실행 중인 프로세스"만 취소할 수 있으면, 프로세스가
  뜨기 **직전** 구간이 사각지대가 된다. 그래서 취소는 **claim 단위**다(generation 무효화 + 세션 삭제 +
  `stopped` 전이 — 서로 중복된 세 신호). 대신 취소된 invocation의 promise는 나중에 reject된다 →
  그 계약을 `C-27`로 등록했다(감추지 않는다).
- **낡은 정리는 남의 세대를 건드리지 않는다.** `stop` 뒤 같은 id로 새 세션이 생길 수 있으므로, 실패한
  invocation의 `catch`/`settle`이 무조건 `delete`/대입을 하면 **살아 있는 교체본을 죽인다**. 모든 정리는
  "내가 아직 소유자인가"(같은 state 객체 + 같은 generation)를 먼저 본다.
- **발행은 마지막에 한다.** 검증 실패가 이전 invocation의 완료된 큐를 교체하면, 소비자는 있지도 않은 turn의
  종료 결과를 하나 더 본다. 큐·`running` 발행을 동기 게이트 **뒤**로 옮겼다 — 발행 전 실패는 rejected
  promise **하나로만** 나간다. 주석이 이미 그렇게 말하고 있었으므로, 이것은 기능 추가가 아니라 **정합화**다.
- **`C-23`을 다시 열고, 3차의 "fixed"를 overclaim으로 기록했다.** 3차 fix는 같은 invocation 안의 창만
  닫았는데 대장은 turn 간 aliasing까지 닫혔다고 적었다. 대장은 **틀린 fixed를 남겨두는 것이 미해결보다
  나쁘다** — reopen 사유를 행에 명시하고, 이번엔 `start()`에서 **유효 옵션 전부를 봉인**해 호출자 객체가
  다시 baseline이 될 수 없게 했다. 비교는 `JSON.stringify`가 아니라 **명시 필드 목록**이다(키 순서·중첩
  구조에 계약을 걸지 않는다). 드리프트 marker는 **하나**(`codex_spec_mutated`)로 고정한다.
- **테스트를 위해 production에 비동기 hook을 넣지 않았다.** race 창을 결정론적으로 열려면 무언가를 멈춰야
  하는데, provider에 "테스트용 await 지점"을 주면 **신뢰 경로에 주입 표면**이 하나 늘어난다. 대신 경계가
  이미 부르는 **git 실행 파일을 테스트가 신뢰된 래퍼로 지정**해 그 안에서 멈춘다 — production 표면 증가 0,
  타이밍 추측 0(파일 유무로 release).
- **중복 방어의 커버리지를 정직하게 적는다.** `cancelled` 플래그 단독 제거는 어떤 테스트도 실패시키지
  않는다(다른 두 신호가 같은 경로를 잡는다). 그래도 남긴다 — 세 신호가 서로를 보완하는 편이 하나가
  깨졌을 때 안전하다. 다만 대장·WORKLOG에 "단독 커버리지 없음"을 적고 커버리지를 **과대 주장하지 않는다**.

## 2026-07-27 (V3 M5a 3차 리비전 — 게이트를 "언제" 세우는지가 게이트의 내용보다 중요했다)

- **검증은 "실행 직전"에만 의미가 있다 → 단일 동기 pre-spawn 게이트.** 홈·실행 파일 검사를 비동기 경계
  작업 **앞**에 두면, 검사와 사용 사이에 await가 끼어 **검사한 것과 다른 실체**가 실행될 수 있다. 게이트를
  하나로 모으고 그 안에 await를 두지 않는 규칙을 세웠다(순서: spec → 경계 → 홈 → 실행 파일 → spawn).
  대가: 같은 검사를 두 번 한다(사전 검증은 빠른 거부용, **판정 근거는 게이트**). 이 순서를 바꾸는 변경은
  A급 회귀로 본다.
- **실행 파일은 경로·권한이 아니라 신원(dev+ino)으로 묶는다.** 경로와 mode만 보면 "같은 0755 다른 바이너리"
  교체가 통과한다. 검사와 사용 사이의 창을 **0으로 만들 수는 없다**(Node에 `fexecve`·디렉터리 fd 상대 실행이
  없다) — 그래서 창을 syscall 몇 개로 줄이고 **줄였다는 사실만** 문서에 적는다. 과대 주장하지 않는다.
- **증명 도구도 신뢰 대상이다.** 승인 커밋을 증명하는 `git`을 이름으로 부르고 `process.env`를 상속하면,
  `PATH`/`GIT_DIR`/`GIT_WORK_TREE`를 쥔 쪽이 **무엇이 승인된 커밋인지**를 정할 수 있다. 신뢰된 절대경로를
  **필수 입력**으로 만들고 자식 env를 화이트리스트로 좁혔다. 범위는 `executionBoundary`로 **한정**했다 —
  `runProcess`의 다른 호출자(worktree 유틸 등)를 함께 바꾸는 것은 이 리비전의 위험 예산을 넘는다.
- **파서가 기대 신원을 알아야 한다.** provider가 나중에 알아채는 구조에서는 이미 `init`과 본문이 큐에 들어가
  있다(한 chunk가 통째로 파싱되므로 더 나쁘다). "누구의 스트림인지"는 **파싱 시점의 입력**이어야 한다 —
  그래서 기대 UUID를 파서 계약에 넣고, 불일치 시 **봉인**해 그 invocation에서 더 아무것도 방출하지 않는다.
- **`C-23`은 유예 대신 지금 닫았다.** 스냅샷 대조 두 줄이면 되고, 열어 두면 M5b 배선 때 "왜 argv가 검증한
  값과 다른가"를 다시 추적해야 한다. 유예 비용 > 수정 공수일 때는 기한을 미루지 않는다.
- **전체 suite를 이 세션에서 돌리지 않는다(정직한 미실행).** M5a는 내부 stacked slice이고 최종 직렬
  `npm test` 1회는 M5b~M5d 이후 supervisor가 돌린다. 여기서 대신 돌려 "통과"로 적는 것이 더 나쁘다 —
  **M5a handoff 승인은 supervisor 리뷰의 몫**이다.

## 2026-07-27 (V3 M5a 2차 리비전 — 게이트끼리의 모순을 닫았다)

- **격리 홈은 "항상 비어 있음"이 아니라 "provider가 소유한다"로 정의한다.** 이전 계약("모든 invocation이
  빈 `CODEX_HOME`")은 그 자체로는 더 강해 보이지만 **비-ephemeral resume과 양립할 수 없었다** — codex는
  resume에 필요한 상태를 바로 그 홈에 쓴다. 그래서 규칙을 완화하는 대신 **경계를 옮겼다**: ambient 격리는
  **첫 invocation의 빈 홈**이 보장하고, 그 순간 확보한 **디렉터리 신원(dev+ino)** 이 이후 모든 invocation의
  통과 조건이 된다. 되돌리기 어려운 선택이므로 대가를 적어 둔다 — 소유권이 **in-memory**라 controller가
  재시작하면 그 홈으로 resume할 수 없다(`C-22`, fail closed 방향). 그리고 이 게이트는 **같은 uid 공격자
  내성이 아니다**: 막는 것은 경로 교체·권한 완화·소유하지 않은 상태로의 resume이다.
- **"검증 후 spawn 전"에 걸치는 것은 신원뿐이 아니다 — 시간도 걸친다.** 만료를 비동기 git 조회 **전에만**
  보면 승인 창을 조회 시간만큼 늘려 준다. `nowMs`를 숫자에서 **clock(함수)** 로 넓혀 마지막 동기 검증이
  시각을 다시 읽게 했다. 테스트가 "clock을 두 번 읽는다"를 단정하므로 이 계약은 비공허하다.
- **신원 없는 이벤트는 전달할 가치가 없다.** 파서가 `thread_id`를 못 본 상태에서 assistant/status/error를
  내보내면, 그 이벤트들은 **어느 세션에도 귀속되지 않는 내용**이 된다(resume 근거도 만들 수 없다).
  그래서 신원 확립을 **첫 이벤트의 의무**로 올리고 그 전 이벤트는 payload 없이 실패로 닫았다.
- **비가역 실패를 resume으로 우회할 수 없어야 한다.** MCP 관측은 strict 격리 위반인데, 같은 thread를
  `send`로 이어갈 수 있으면 "비가역"이 한 turn짜리 표시로 격하된다. 세션을 닫는 쪽을 골랐다.
  malformed 같은 나머지 실패 사유까지 확장하는 것은 `B-8`(호출자가 `isError`를 무시한다)과 같이 다룬다(`C-21`).
- **문서가 코드보다 강하게 주장하면 그 문서를 고친다.** "agent message 전문은 어떤 이벤트에도 실리지 않는다"는
  실제로는 `raw` 얘기였고, 최종 본문은 `assistant.text`·`result.text`로 **의도적으로** 나간다(리뷰 판정이
  그 경로로 온다). 코드를 문서에 맞춰 약화시키는 대신 문서를 사실로 되돌렸다.

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

## 2026-08-11 (V3 M6 T1·T2 — spawn 상한 분리 · agent 출력 → kernel 배선)

- **`LIMITS.maxProcessesPerRun` 분리(T1, `B-19`)**: run 전역 프로세스 상한이 `maxTasksPerRun`을 빌려 쓰고
  있었다. 값이 같아도 개념이 다르므로 전용 상수로 갈랐다. 두 상수를 **각각** 바꾸는 mutation에 **각자의**
  테스트만 red임을 실측(교차 오염 없음). `C-44`(도달 불가능한 depth backstop)는 **주석 명시로 종결** —
  state 위조 harness는 만들지 않았고, 그 두 분기를 테스트로 red로 만들 수 없다는 사실을 대장에 그대로 적었다.
- **`requestSpawn`이 "정리 확인된 `cleaning`" parent도 받는다(T2)**: M5c의 attempt lifecycle과 M4a의 spawn
  전이가 **합성되지 않은 상태**였다. worker가 turn 안에서 spawn을 요청하면 parent가 `running` →
  `waiting_children`으로 곧장 가버려 그 attempt를 `recordTerminal`(running만 받는다)로 닫을 수 없었고,
  반대로 turn을 먼저 닫으면 `cleaning`이라 spawn을 받을 수 없었다. **정리 확인이 먼저**인 순서를 택했다:
  `recordTerminal → confirmCleanup → requestSpawn`. 새 갈래는 `requireCleanedTask`와 **같은 조건**(자손 0
  확인 + 미확정 operation 0)을 요구하고 lease·봉인된 결과를 같은 커밋에서 놓는다 → `B-13`을 spawn 경로에서도
  지킨다. 상태 게이트를 넓힌 것이지 우회로를 만든 것이 아니다.
- **child 결과는 parent inbox로 route된다(T2)**: `completeTaskWithArtifacts`/`submitResult`가
  `routeToTaskId = task.parentTaskId`로 수락한다. 여전히 중앙 경유다(발신은 orchestrator에게, route를 정하는
  것은 중앙 커밋). autopilot은 아직 inbox를 ack하지 않으므로(`B-17` 미소비) 그 route는 **미확인 상태로
  durable에 남는다** — 이것은 결함이 아니라 T3 context bundle이 읽을 입력이다.
- **spawn turn은 결과를 발행하지 않는다(T2)**: spawn은 위임이므로 그 turn의 artifact를 등록할 커밋이 없다.
  그래서 `spawn_child` 요청이 있는 계획이 `result.outputs`를 주장하면 `plan_invalid`로 닫는다 —
  조용한 산출물 유실을 만들지 않는다. parent의 결과는 child 전부 완료 후 **다음 attempt**에서 나온다.
- **child ownership = parent ownership 위임**: 요청이 경로를 고르게 하면 child가 요청 한 줄로 쓰기 범위를
  넓힐 수 있다. `AgentRequest`에는 ownership·authorityId·경로·예산 필드가 **없다**(schema 테스트가 그 부재를
  고정한다). 위임은 부모 집합과 동일하며 넓힐 수 없고 `writableRoots` 게이트는 kernel 안에 그대로다.
- **공허한 체크 1건 수정(A급)**: `autopilot.test.ts`의 `B-17` 테스트가 존재하지 않는 key
  (`m.activeAttemptId`)를 읽어 **언제나 통과**했다. `m.delivery.activeAttemptId`/`attempts`로 고치고
  "검사할 메시지가 0건이면 red" 가드를 넣었다.

## 2026-08-12 (외부 Claude Code 하네스 팩 도입 판정 — ECC · gstack · oh-my-claudecode)

- **도입하지 않는다.** 셋 다 스킬·서브에이전트·슬래시커맨드·훅을 얹는 **프롬프트 팩**이고(실측 규모:
  ECC agents 16 / skills 65 / commands 40, gstack commands 23, oh-my-claudecode agents 19 / skills 39)
  **durable SoR·승인 manifest·상태 기계가 없다.** 우리 v3와 같은 자리를 다른 계약으로 채우므로 얹으면
  능력이 느는 게 아니라 **역할 어휘가 둘**이 된다(그쪽 planner/architect vs 우리 durable 7 specialist).
  CLAUDE.md의 기존 금지(`OMC 연동`·`Agent Teams 연동`)와 같은 판정이며 새로 뒤집을 근거가 없다.
- **훅은 특히 받지 않는다**: 편집 이벤트 훅은 `scripts/acceptance.sh`의 결정론과 **mutation으로 red를
  확인하는** 절차를 흐린다. M5에서 공허한 체크로 A급을 세 번 맞고 얻은 절차라 속도와 바꾸지 않는다.
- **가져온 것은 발상 둘뿐이고 둘 다 로드맵에 배치했다**:
  ① `C-67` 승인 설정 **정적 감사**(read-only) — 외부 도구는 `.claude` 설정을 보지 우리 승인 manifest를
     보지 않으므로 도구가 아니라 발상만 채택. 기한 = 외부 provider 권능이 manifest에 들어오는 M7 착수 전.
  ② M7의 **도구 예산 상한** — tool/MCP 설명은 등록만으로 컨텍스트를 상시 소모한다는 수치 보고(200k 창에서
     가용분 ~70k). M7이 tool을 늘리는 첫 마일스톤이므로 상한을 코드 상수로 두고 초과를 fail-closed로.
     **그 숫자를 그대로 쓰지 않는다** — 착수 시 우리 프로파일에서 재측정한 값으로 적는다.
- 다른(이 레포와 무관한) 프로젝트에서 전역으로 쓰는 것은 사용자가 별도 판단한다 — 이 레포 계약과 무관.

## 2026-08-12 (V3 M6 T3~T6 — 설계 판단 4건)

- **context bundle을 `briefGenerator.ts`에 넣지 않았다**(kickoff와 다르다). ⓐ 그 파일은 v2 mission 계층이라
  kernel 타입을 끌어오면 계층이 섞이고 ⓑ **offline plan worker에는 프롬프트 채널 자체가 없어** kickoff가
  말한 "autopilot 주입 지점"이 존재하지 않는다. 그래서 순수 모듈(`contextBundle.ts`) + kernel 읽기 전용
  접근자로 만들고 **주입은 하지 않았다**. 현재 소비자는 rotation 증명이며, 프롬프트 소비는 live backend
  슬라이스의 몫이다. 로드맵 M6 절에 **미증명**으로 적었다.
- **`decisionHash`의 run 사이 동일성을 주장하지 않는다.** `messageId`는 durable 신원이고 autopilot이 turn마다
  난수로 발급하므로 서로 다른 두 run은 반드시 다르다. 교체 전후(같은 run)만 동일하다고 적고, 교체 run vs
  대조 run은 **신원을 뺀 결정 내용**을 비교했다. messageId를 다이제스트에서 빼서 억지로 같게 만들지 않았다 —
  그러면 서로 다른 두 메시지가 한 해시로 붕괴한다.
- **다이제스트에 시각·revision을 넣지 않는다.** 넣으면 교체 전후가 구조적으로 절대 같을 수 없어 ③이 공허한
  체크가 된다. 대신 "시각만 바꾼 state는 다이제스트가 그대로"를 **별도 체크**로 두었다 — 처음 판은
  "교체 전후 동일" 하나뿐이었고 재개해도 `updatedAt`이 같아 **시각이 섞여도 green이었다**(mutation으로 실측).
- **`attempt_id_reused`는 직전 한 칸만 막는다.** 두 attempt 이전 값의 재사용은 durable state가 과거
  attemptId를 보관하지 않아 볼 수 없다(event log는 state 밖 파일). 효과 경로는 durable `chargedTurnIds`가
  이미 닫으므로 잔여는 감사 추적성이며 대장 `C-68`로 남겼다. kernel이 `attemptNo`에서 attemptId를 **파생**하면
  구조적으로 종결되지만 `PreflightDecision` 계약과 모든 호출부가 바뀌어 M6 범위로 넣지 않았다.
