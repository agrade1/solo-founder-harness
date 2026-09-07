# M15 — Codex 독립 검수 보고 (2026-09-03)

> 세 축 병렬(`gpt-5.6-sol`, read-only): ⓐ 구현 인벤토리 ⓑ 문서·안내문 과대주장 적대 감사 ⓒ 사용 불가 지점.
> **Codex 주장을 그대로 옮기지 않았다** — 아래 "확인" 열이 `실행`이면 내가 명령을 돌려 본 것,
> `코드`면 해당 file:line을 읽어 대조한 것, `미검`이면 Codex 주장을 그대로 둔 것이다.

## 0. 규모 (직접 실측)

| 층 | 구현 | 테스트 | 비 | CLI 노출 |
|---|---:|---:|---:|---|
| `src/exec` (v3 오케스트레이션 커널) | 21,111줄 | 22,557줄 | 1.07 | `exec` `mission` `autopilot*` `plan-dag` `*-approval` |
| `src/tools` (MCP·리서치·프로브) | 5,185 | 8,558 | 1.65 | (간접) |
| `src/core` (v1 문서 자동화) | 5,790 | 6,133 | 1.06 | `run` `summary` `task-prompt` `handoff` |
| `src/commands` | 4,461 | 5,040 | 1.13 | `pipeline` 외 |
| `src/providers` | 1,001 | 671 | 0.67 | `--provider` |

**총 106 구현 파일 · 74 테스트 파일 · 21 CLI 명령.** 실행층(`exec`)이 구현의 **절반 이상**인데,
사용자가 실제로 걷는 4단계 파이프라인은 `core`+`commands`(약 1만 줄)에 있다.

## 1. 얼마나 구현됐나 — 명령 21개 판정

Codex 판정을 코드로 대조했다. **SCAFFOLD(껍데기)는 0개다** — 모든 명령이 실제 동작을 한다.

- **COMPLETE 17**: `list` `init` `pipeline status|next|approve|reject|restart|unlock` `handoff`
  `summary` `task-prompt` `autopilot-create` `validate-dag` `draft-approval` `validate-approval` `autopilot`
- **PARTIAL 4**: `run` · `exec` · `mission` · `plan-dag`

| PARTIAL | 빠진 것 | 확인 |
|---|---|---|
| `run` | MCP 결속 tool profile이 이 경로에서 **일괄 거부**된다 (`runWorkflow.ts:692-704`) | 코드 |
| `exec` | 소유권·hook-deny 정책이 **compile되지만 집행되지 않는다** (`permissionCompiler.ts:39-46,90-108`) · **게이트 스크립트가 없으면 빈 게이트가 통과한다** (`machineGate.ts:42-58`) | 미검 |
| `mission` | brief 배열의 잘못된 항목을 **거부하지 않고 조용히 버린다** (`briefGenerator.ts:49-63`) | 미검 |
| `plan-dag` | 아이디어 경로가 `<project>/docs/00_IDEA.md` 꼴이 아니면 kill·파이프라인·개발표면 게이트가 **전부 우회된다** | 코드 (이미 주석에 한계로 적혀 있다) |

**두 상태기는 서로 모른다.** v1은 `outputs/run_state.json`, v3 커널은 `outputs/orchestration/<run>/run_state.json`.
`plan-dag`가 v1 상태를 **단방향으로 읽기만** 한다. `exec`·`mission`은 커널이 아니라 옛 `sessionRunner` 경로를 쓴다.

**죽은 표면**: 비-테스트 호출자가 0인 export가 **18~24건**(내 스캔 24 · Codex 18, 서로 놓친 것이 있다).
그중 하나가 중요하다 — **`B-4` 독립 확인**: `validateDesignArtifacts`의 유일한 비-테스트 호출자가
`buildDesignHandoff`인데 그 함수 자체가 호출자 0이다. **디자인 계약 검증 체인 전체가 production에서 죽어 있다.**
(Codex는 이걸 놓쳤고 내 스캔이 잡았다.)

## 2. 무엇이 부족한가 — 실사용을 막는 것

### ★ 최상위 — provider가 파이프라인에 저장되지 않는다 (신규 · 확인: 실행)

| 사실 | 근거 |
|---|---|
| `PipelineState`에 `provider` 필드가 **없다** | `src/core/pipeline.ts` 내 `provider` 등장 횟수 **0** |
| 매 `next`가 독립적으로 provider를 해석하고 기본값은 **mock** | `commands/pipeline.ts:451` · `providers/index.ts:21` |
| 도구가 인쇄하는 다음 단계 안내 **6곳 전부** `--provider`가 없다 | `commands/pipeline.ts:145,172,602,618,644,780` |
| `run_state`는 provider를 기억한다(`claude-code`) | `_t_preflight/outputs/run_state.json` 실측 |

**결과**: 1단계를 `--provider claude-code`로 돌린 뒤 **도구 자신의 안내를 그대로 따르면** 2단계가
**mock으로 조용히 떨어진다.** 오류가 아니라 `[MOCK]` 딱지가 붙은 그럴듯한 문서가 나오고 승인 대기로 간다.
이 레포의 거짓 안내 계열 중 **처음으로 "막히는" 것이 아니라 "가짜를 만드는" 쪽**이다.

### 거짓 안내 4건 추가 (전부 확인: 실행)

이 레포는 거짓 복구 안내를 네 번 잡았다. **다섯~여덟 번째가 여기 있다.**

| 안내 | 실행 결과 |
|---|---|
| `harness task-prompt` (`summary.ts:66,109`) | `error: required option '--project' not specified` |
| `harness handoff` (`summary.ts:66`) | 같음 |
| `harness pipeline restart` (`summary.ts:56` · `core/pipeline.ts:333,860`) | 같음 |
| `scripts/token-lint` (`taskPrompt.ts:184`) | `No such file or directory` (실제는 `node scripts/token-lint.mjs`) |

### 내 이번 세션 수정이 만든 형제 결함 3건 (확인: 코드)

한 자리만 고치고 **같은 말을 하는 다른 자리를 안 고쳤다.**

1. **`driftMessage()`(`core/pipeline.ts:928`)가 여전히 restart를 권한다** — 그 함수 주석이 *"drift 거부
   문장은 한 곳에서 만든다(같은 상황 = 같은 안내)"* 인데 내가 고친 것은 **다른 쪽**(`commands/pipeline.ts`)이다.
   `summary.ts:63`도 같다.
2. **`A-3` 가드가 restart를 막는 상태에서 restart를 권하는 자리 4곳**: `commands/pipeline.ts:177,304` ·
   `core/pipeline.ts:896` · `core/summary.ts:56`.
3. **`summary.ts:52`가 "next가 자동 resume한다"** — `pipeline status` 쪽은 고쳤는데 여기는 안 고쳤다.
   `A-4` 크래시 뒤에는 fresh로 돈다.

추가로 **`B-1` 수정이 파이프라인 경로에서 틀리다**: 내 새 문구가 `--max-tokens <n> --resume`을 권하는데
`pipeline next`에는 `--resume`이 없다(기존 대장 `C-2`와 같은 모양을 내가 넓혔다).

### 나머지 gap (Codex 주장 · 확인 표시)

| # | gap | 확인 |
|---|---|---|
| 1 | **`init`이 `harness run`을 안내한다 — 4단계 파이프라인으로 가는 길을 말하지 않는다** (`init.ts:48`) | 코드 |
| 2 | 자리표시자 아이디어를 그대로 받는다 — 게이트는 kill 이력만 본다 | 미검 |
| 3 | 승인 후 `00_IDEA.md`를 고치면 **두 아이디어가 섞인다**(아이디어는 checkpoint에 결박되지 않는다) | 미검 |
| 4 | **활성 파이프라인에 취소·롤백 전이가 없다** — 완주하거나 파일을 손으로 만지는 것뿐 | 미검 |
| 5 | 2단계 `검증` 후 **이미 승인된 CEO 문서**를 고치면 drift로 막힌다 → 탈출구 0 | 미검(단 `B-47`·`B-54`와 같은 계열) |
| 6 | Next Actions가 비면 **"MVP의 첫 기능 하나를 구현한다"를 지어낸다** (`taskPrompt.ts:72-78`) | 코드 |
| 7 | 단독 task prompt에 **절대경로 계약이 없다** — `handoff` 경로에만 있다 | 미검 |

## 3. 지금 무엇을 작업 중인가

- **머지 대기 스택 3개**: `#116`(A-1·A-2·A-3·B-1·B-5) → `#117`(A-4) → `#118`(P1 계측).
- **대장 122건**: 등급 A **0** · B 13 · C 106 + nonblocking 2.
- **직전 세션 대비 닫힌 것**: 수색 보고서 A급 4건 전부 + `B-1`·`B-5`. **`B-4`는 이 검수가 재확인했다.**
- **열린 큰 것**: `B-47`(drift 막다른 길) · `B-48`(critique_loop 예산 미검사, 트리거 도래) ·
  `B-51`(아이디어 문서로 게이트 우회) · `B-54`(잔여분) · `C-152`(fanout 직렬) · `C-153`(토큰 고정 바닥).

## 4. 한 줄 판정

**기계는 서 있다** — 21개 명령에 껍데기가 없고, live 3단계가 완주했고, 게이트·영수증·잠금은 fail-closed로 동작한다.
**부족한 것은 기능이 아니라 "사람이 실제로 걸을 수 있는 길"이다** — 도구가 인쇄하는 안내를 그대로 따르면
`--project`가 빠져 실패하거나, 존재하지 않는 스크립트를 부르거나, **가짜 provider로 조용히 떨어진다.**

## 5. 미검 8건 전수 검증 + 적대적 재검수 (2026-09-03 2차)

1차 보고의 **미검 8건을 전부 실물 검증**하고, 그 판정을 다시 Codex(`gpt-5.6-sol`)에 **반박시켰다**
(기본값 REFUTED · 반증 못 하면 CONFIRMED). **내 판정 둘이 뒤집혔다.**

| # | 1차 판정 | 재검수 | 결론 |
|---|---|---|---|
| 1 | `exec`/`mission`에 쓰기 경계 미집행 | CONFIRMED | `ownership`·`hookDenyPatterns`가 컴파일 후 **아무도 안 읽는다**. `ownership`은 자연어 프롬프트에만 실린다. worktree는 관례적 격리이지 파일시스템 봉쇄가 아니다 |
| 2 | 빈 게이트는 **의도된 것 · 공개됨** | **REFUTED (내가 틀렸다)** | `"체크 없음"`은 `commands/exec.ts:79` **한 곳뿐**. `mergeCoordinator.ts:57-72`는 빈 게이트를 통과시키고 **바로 push**하며, `parallelMission`·`mission` 리포트는 게이트도 "체크 없음"도 남기지 않는다 |
| 3 | brief 조용한 버림 — **영향 낮음** | **PARTIAL (내가 틀렸다)** | `deps: "task-a"`(스칼라) → `undefined` → 스케줄러가 **의존성 없음으로 취급** → 선행 완료 전 실행, 병렬 모드에선 자동 병합까지 간다 |
| 4 | 자리표시자 아이디어 통과 | CONFIRMED | 97B 원문 그대로 1단계 `awaiting_approval` 도달. 프롬프트 층이 빈 아이디어를 **명시적으로 허용**하고 가정으로 진행하라고 지시한다 |
| 5 | 아이디어 교체가 섞인다 | CONFIRMED | 아이디어 게이트는 **파이프라인 생성 시에만** 본다. checkpoint manifest에 `00_IDEA.md`가 없다 |
| 6 | 활성 파이프라인에 취소 없음 | **PARTIAL** | **사용자가 조종할 수 있는** 취소는 없다(맞다). 단 `awaiting_run`은 workflow 게이트가 '폐기'를 내면 terminal `killed`에 닿는다 — 내 "종결 상태 없음"은 과했다 |
| 7 | 2단계 검증 교착 · 안내 ⓐ 거짓 | CONFIRMED | 되돌리면 replay 분기로 재거부(실행 확인). **탈출구 0** |
| 8 | 단독 task prompt에 경로 계약 없음 | CONFIRMED | 계약은 `handoff.ts:193-207`에만. 그 주석이 막는 실패("serviceCwd에 엉뚱한 docs/WORKLOG.md")를 단독 경로는 그대로 맞는다 |

### 재검수가 새로 찾은 것 (내가 실행/코드로 재확인)

**ⓐ 거짓 안내 두 개가 더 있고, 둘 다 내가 손댄 함수 안이다.**
`commands/pipeline.ts:412-415` replay 분기가 *"폐기 판정 또는 `harness pipeline reject`로 종결한 뒤 다시 세우세요"*
라고 권하는데, 그 상태(`awaiting_run` + drift)에서 **둘 다 도달 불가능**하다 — 폐기 판정은 게이트까지 가야 하는데
drift가 `next`를 그 앞에서 막고, `reject`는 pending이 없어 `pipeline_no_pending`이다.
**나는 같은 함수의 else 분기만 고치고 replay 분기를 그대로 뒀다.** `driftMessage()`와 같은 형제 miss다.

**ⓑ Claude가 non-zero로 죽어도 세션이 실패로 접히지 않는다 → 빈 게이트 → 자동 병합.**
`claudeCliProvider.ts:94-104`가 non-zero 종료를 `unknown/exit_error` **이벤트 하나로만** 낸다.
`sessionRunner.ts:90-97`의 `consumeTurn`은 `assistant`·`result`만 세고 그 이벤트를 **실패로 바꾸지 않는다**.
그다음 `finalize()`가 게이트를 도는데, 대상 레포에 4종 스크립트가 없으면 빈 게이트가 통과한다(`:139-143`).
`mission`은 `merge:true`·`approver:autoApprove`다 → **중단된 작업의 부분 코드가 검증 0회로 develop에 병합될 수 있다.**
그리고 `mission.ts:47`은 사용자에게 *"게이트 통과 시 develop 자동 병합"*이라고 광고한다.

## 6. 최종 판정 (2차)

**기계는 서 있다. 무너지는 곳은 "사람이 걷는 길"과 "자동 병합 경로"다.**

| 심각도 | 항목 |
|---|---|
| **가장 무거움** | `exec`/`mission` 자동 병합 3단 복합: 종료코드 미반영 + 빈 게이트 통과 + 비공개 + 쓰기 경계 미집행 |
| 무거움 | provider가 파이프라인에 저장되지 않아 **안내대로 따르면 mock으로 조용히 강등** |
| 무거움 | 2단계 `검증` + 승인된 decider 문서 = **탈출구 0** (안내 셋 전부 거짓) |
| 중간 | 거짓 안내 총 **6건 신규**(`--project` 누락 3 · `token-lint` · replay 분기 2) — 그중 **3건이 이번 세션 내 수정이 만든 것** |
| 중간 | 아이디어가 checkpoint에 결박되지 않음 · 자리표시자 통과 · 사용자 취소 전이 없음 · 단독 프롬프트 경로 계약 없음 |

## 5. 이 검수가 하지 않은 것

- 테스트 스위트·live 호출을 돌리지 않았다(Codex는 read-only 정적 감사).
- 위 표의 **미검 7건은 Codex 주장 그대로**다 — 수정 전에 실물 확인이 필요하다(`C-150`과 같은 규율).
- `exec`/`mission`의 정책 미집행 주장(가장 무거운 PARTIAL 둘)을 **재현하지 않았다.**
