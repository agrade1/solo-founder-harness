# C-127 설계 — v1 필수 섹션 검증을 차단으로

> 작성 2026-08-27 (M13 · Fable 설계 세션 read-only). Codex 리뷰 후 구현 계약으로 사용한다.

## 1. 실측한 현행 동작 (파일:줄 인용)

**검증과 재생성 루프** — `src/core/runWorkflow.ts`:

- `runStepWithRegen`이 매 LLM 호출 후 `validateAgentOutput(markdown, agent.required_headers ?? [])`를 부른다 (`runWorkflow.ts:791`). 통과하거나 `attempt >= maxRegen`이면 루프 탈출 (`:792`), 실패 시 누락 헤더를 피드백으로 실어 재생성한다 (`:794-800`).
- `maxRegen`은 `runWorkflow.ts:576` — `Math.max(0, args.maxRegenerations ?? 1)`, **기본 1**. CLI는 `--max-regen` 기본 `"1"`(`src/cli.ts:59`), **파이프라인 경로는 이 인자를 아예 넘기지 않아 항상 기본 1이다** (`src/commands/pipeline.ts:418-431`의 `runWorkflow` 호출에 `maxRegenerations` 없음).

**warning-only의 실체**:

- `recordOutcomeTelemetry` (`runWorkflow.ts:828-839`): `!o.validation.ok`면 `warnings[]`에 push하고 `console.warn("… (저장은 진행)")` (`:836-838`). **여기서 끝난다.**
- `persistFinalOutcome` (`runWorkflow.ts:842-860`): validation 결과를 보지 않고 무조건 `saveArtifact` → `completed_steps` push (`:856`) → `findings.set` (`:857`). 즉 깨진 문서가 저장되고, 완료로 세어지고, 다음 agent 프롬프트의 priorFindings에 실린다.
- 최종 status는 `runWorkflow.ts:1435-1438`: `stopped = failed_agent !== null || budgetStopped || rejected` — **warnings는 status에 영향 0**. 그래서 재생성 상한 소진 후에도 `completed`.
- 기존 모순: `runStepWithRegen`의 finally는 이미 `ok = validation.ok`로 `step_end`/`step_timings`에 **ok:false를 남긴다** (`:802`, `:806-816`) — 진행 이벤트는 "실패"라는데 durable status는 "completed"인, 이 레포가 "거짓 영수증"이라 부르는 바로 그 모양이다.

**하류 전달** — `src/commands/pipeline.ts` + `src/core/pipeline.ts`:

- `pipeline next` → `commitAfterRun` (`commands/pipeline.ts:458`): run이 `completed`면 `buildManifest(root, runStateSources(result.state))`로 checkpoint를 만들고 (`:510-524`) `awaiting_approval`로 전이. `runStateSources`는 **`completed_steps` 기반**이다 (`core/pipeline.ts:681-`). 즉 필수 섹션이 깨진 PRD도 `completed_steps`에 들어 있는 한 **정상 산출물로 B-41 checkpoint에 결박**되고, 승인 seed(`extractMainJudgment`)까지 다음 단계 프롬프트에 실린다 — 사용자가 지목한 통점 그대로.
- run이 `failed`면 (`commands/pipeline.ts:471-508`): `last_failure` 기록, 상태는 `awaiting_run` 유지, exit 1, 다음 `pipeline next`가 자동 resume (`:352-359`). **checkpoint는 만들어지지 않는다.**

**기존 실패 메커니즘** (재사용 후보):

- 재개 가능 실패 = `status:"failed"` + `resume_from`(`runWorkflow.ts:1450`). resume은 `prior.status !== "failed" || resume_from === null`이면 거부 (`:667-668`), 완료 step은 재실행하지 않고 산출물을 findings로 복원 (`:685-693`).
- 같은 모양의 선례: `token_budget_exceeded`(`:1081`), `user_rejected`(`:1328`), 게이트 4종 코드(`:1233-1241`), 리서치 `research_*` 코드(`:1121-1126`), `HARNESS_FAIL_AT` 훅(`:762-764`) → step 단위 catch(`:1420-1426`)가 `failed_agent/failed_reason/failedIndex`를 적고 break.

**검증기와 계약의 소재**:

- `validateAgentOutput` = `src/core/validate.ts:50-64`. 공용 4개(Metadata/Main Judgment/Risks/Next Actions, `validate.ts:12-17`)는 **모든 agent에** 적용되고, `required_headers`는 agent별 추가분이다. 파일 머리 주석이 "v1은 경고 수준"이라고 명시 (`validate.ts:1-4`).
- `required_headers` 데이터: `registry/agent_registry.json` — pm(PRD 7개 절, :25), design(9개 절 + `token_output`, :49), tech_lead(7개 절, :67), founder_ceo(`["Decision"]`, :90).

## 2. 대장 처방 검증

**절반 맞고 절반 틀리다.**

- 맞다: "재생성 상한 후에도 깨진 산출물이 completed로 하류에 전달된다" — §1에서 실측 확인. `runWorkflow.ts`가 자리라는 것도 맞다.
- 틀리다 ①: **"paused"는 만들면 안 된다.** 킥오프 §4-11이 명시한 대로 새 상태마다 거짓 영수증이 재발했고, 이 레포의 "paused"는 이미 존재한다 — `status:"failed"` + `resume_from` + 안정 사유 코드가 정확히 그것이다(`user_rejected`가 선례).
- 틀리다 ② (불완전): 처방은 메인 루프만 암시하지만 **채택 지점은 8곳**이다 — 일반 step(`:1138`), 리서치 self/`external_declined`/`external_empty`/2차(`:932·961·1004·1048`), 스폰(`:1293`), 비평 critic/revise(`:1388·1414`). 메인 루프에만 가드를 넣으면 비평 루프와 리서치 채택 경로가 그대로 뚫린다.
- 틀리다 ③ (불완전): 리서치 **1차는 차단하면 안 된다** — 1차는 채택본이 아니고(telemetry만, `:947`) 2차가 교정 기회다. `runStepWithRegen` 안에 넣으면 이 경로가 부서지고 usage 계측도 잃는다(C-126/A-2가 막은 그 회귀).
- 틀리다 ④ (누락): 기존 테스트 하나가 현행 fail-open에 **기대고 있다** — `ceoWithoutDecision()` fixture(§8). 대장은 이를 적지 않았다.

## 3. 영향 반경 (실제 명령으로 확인한 것만)

- `runWorkflow` 프로덕션 호출부 **2곳뿐**: `src/commands/run.ts:86` (v1 `run`), `src/commands/pipeline.ts:418` (v3 `pipeline next`). exec/mission/autopilot은 호출하지 않는다.
- `persistFinalOutcome` 호출부 8곳 — 전부 step 단위 try(`:1095`) 또는 `runWebResearchStep`의 봉인 try(`:927`) 안이라, 여기서 throw하면 기존 catch가 전부 받는다.
- `failed_reason` 소비자: `summary.ts:99`(표시), `commands/pipeline.ts:488`(표시 + `startsWith("research_")` 분기 `:494`), `commands/run.ts:113-114`(표시). **정확 일치 매칭 소비자는 없다.** 신규 코드 `required_sections_missing`은 `research_` 접두사와 충돌하지 않는다.
- 검증 실패를 의도적으로 내는 테스트 fixture는 **1개뿐**: `runWorkflow.test.ts:77` `ceoWithoutDecision()` (사용처 `:191`, 기대값 `ceo_decision_absent`).

## 4. 설계 (최소 diff)

**한 곳, `persistFinalOutcome`에 가드 하나.** 채택(저장→완료 등재→findings)의 유일한 관문이므로 8개 호출부가 전부 한 번에 닫힌다. 새 상태 없음, 새 설정 없음.

**`src/core/runWorkflow.ts`** — 3군데 수정:

① 모듈 상단(`ResearchError` 선례)에 판별용 에러 클래스:

```ts
/** [C-127] 재생성 상한 후에도 필수 섹션 계약 미달 — 채택 거부. failed_reason에 안정 코드로 실린다. */
class RequiredSectionsMissing extends Error {}
```

② `persistFinalOutcome` (`:842`) — `savedFiles.push(saved)`(`:844`) 직후, `token_output` 처리(`:846`) 앞에:

```ts
// [C-127] 계약 미충족 산출물은 채택하지 않는다. 파일은 검토용으로 남긴다(오늘과 같은 바이트 —
// 파이프라인 last_failure.written에 잡혀 resume drift 검증이 오해하지 않는다). token_output은
// 뽑지 않는다: 깨진 design 문서가 정상 tokens.json을 덮으면 안 된다.
if (!o.validation.ok) {
  throw new RequiredSectionsMissing(
    `${agent.agent_id}: 필수 섹션 미충족(${o.validation.missing.join(", ")}) — 재생성 ${maxRegen}회 후에도 계약 미달. ` +
      `산출물은 ${saved}에 남겼지만 completed로 채택하지 않는다.`,
  );
}
```

③ step 단위 catch (`:1420-1425`) — 코드 한 줄:

```ts
failed_reason = err instanceof RequiredSectionsMissing ? "required_sections_missing" : (err as Error).message;
```

누락 헤더의 durable 기록은 이미 `recordOutcomeTelemetry`가 `warnings[]`에 남긴다(`:835-836`).

**부수 문구 2건** (거짓말 제거):

- `recordOutcomeTelemetry`의 `"(저장은 진행)"`(`:837`) → 중립 문구. 이 warn은 리서치 1차(비채택·비차단)에서도 나오므로 "차단된다"고 적어도 거짓이 된다.
- `validate.ts:1-4`의 "v1은 경고 수준" 주석 갱신.

**`pipeline.ts`·`run.ts`·`summary.ts`·`obsidianExport.ts` 수정 없음** — failed 처리 경로가 이미 전부 있다(§5).

동작 결과:

- v1 `run`: 해당 step에서 `status:"failed"` · `failed_agent=<agent>` · `failed_reason="required_sections_missing"` · `resume_from=<그 step>` · exit 1 + resume 안내(`run.ts:108-116, 181-184`). 후속 step 미실행(break), findings 미오염, `--handoff` 미발동(`run.ts:186-188`).
- v3 `pipeline next`: `commitAfterRun`의 failed 분기(`:471-508`)로 떨어져 **checkpoint가 만들어지지 않고** `awaiting_run` 유지 + `last_failure` 기록. 깨진 PRD의 digest는 `last_failure.written`에 잡힌다(`:477-484`). 고친 뒤 `pipeline next`가 자동 resume(`:352-359`).
- 리서치 step에서 채택 실패 시: `runWebResearchStep`의 최외곽 catch(`:1053-1062`)가 attempt를 `research_step_failed`로 **봉인하고** 재throw → run은 `required_sections_missing`으로 failed. 영수증 없는 성공/침묵 소실 없음.

## 5. 상태·소비자 전수

**새 상태를 만들지 않는다.** `completed | failed | killed` 그대로, `failed` + 신규 `failed_reason` 문자열 하나.

| 소비자 | 근거 | 수정 |
|---|---|---|
| CLI `run` | `run.ts:108-116` failed 분기 + `:181-184` exit 1 | 없음 |
| `summary` | `summary.ts:84-103` — status switch에 failed 케이스 존재, `never` 봉인 | 없음 |
| Obsidian vault | `obsidianExport.ts:123` — `상태: ${state.status}` 인쇄 | 없음 |
| pipeline checkpoint | `commands/pipeline.ts:471-524` — failed→last_failure, completed에서만 manifest | 없음 |
| C-126 영수증 | `research.attempts`/`totals` carry-forward(`:602, 609-613`)는 status와 무관 | 없음 |
| B-40 잠금 | `kill_history`/`cleared` carry-forward(`:592-593`)는 실패 누산기와 독립 | 없음 |
| `lockFieldsProblem` | `:312-331` — status 어휘를 열거하지 않음(killed만 특칙) | 없음 |

## 6. 탈출구 + 뒷문 아님의 근거

이 검증이 보는 것은 **`## <정확한 헤더>` 줄의 존재뿐**이므로 "멀쩡한데 미달"이란 곧 "헤더 이름이 계약과 다르다"이다. 탈출구는 두 개고 둘 다 durable하다:

1. **재시도**: `--resume`(v1) / `pipeline next`(v3)가 그 step만 재실행한다. 재생성 피드백이 누락 헤더를 명시하므로(`:794-797`) 일시적 형식 이탈은 여기서 걷힌다. v1은 `--max-regen N`으로 상한도 올릴 수 있다.
2. **계약 자체 수정**: `registry/agent_registry.json`의 `required_headers`(또는 역할 프롬프트)를 고친다. 깨진 산출물은 `default_output`에 남아 있어(§4) 판단 근거를 눈으로 볼 수 있다.

**뒷문이 아닌 근거**: `--force`/env 스위치 같은 per-run 문자열 우회를 만들지 않는다(§4-12 금지 부류). ②는 호출 한 번을 몰래 통과시키는 자격증명이 아니라 **git에 diff로 남고 이후 모든 run에 적용되는 계약 변경**이다.

## 7. resume / research(형태 B) / maxRegen 상호작용

- **resume**: `status:"failed"` + `resume_from=<실패 step>`이므로 기존 관문(`:667-668`) 통과. 완료 step 복원(`:685-693`)에 실패 step은 없으니 **그 step이 LLM부터 다시 돈다**. 활성 파이프라인에서는 `run --resume`이 `pipeline_run_reserved`로 거부되고(`:519-526`) `pipeline next`가 유일한 재개 통로인 것도 기존 그대로.
- **research 형태 B**: 1차는 채택본이 아니라서 **비차단**(가드를 `runStepWithRegen`이 아닌 `persistFinalOutcome`에 두는 이유). 차단되는 것은 `external_declined`(`:961`)·`external_empty`(`:1004`)·2차(`:1048`)·self(`:932`)의 **채택 순간**뿐. catch-all(`:1053`)이 attempt를 봉인하므로 "영수증 없는 실패"는 생기지 않는다.
- **maxRegen**: `runWorkflow.ts:576`, 기본 1(호출당 최대 2회 생성). 가드는 상한 소진 **후의 최종 판정**만 바꾼다. 파이프라인 경로에 상한 조절 수단이 없다는 사실은 이 수정으로 새로 생기는 문제가 아니다.

## 8. 테스트 계획

기존 테스트 처리 (약화 없음):

- `[B-40/A-1] 정본 판정 절이 없으면 fail closed`(`runWorkflow.test.ts:187`) — fixture `ceoWithoutDecision()`(`:77`)이 "## Decision" 절을 통째로 지우는데, 이제 그 문서는 게이트 도달 전에 `required_sections_missing`으로 멈춘다. **단정은 한 글자도 바꾸지 않고 fixture만 교체**: Decision 절을 코드펜스로 감싼다. `validateAgentOutput`은 펜스를 마스킹하지 않아 통과하고(`validate.ts:55-57`), `extractCeoDecision`은 fenceMask로 걸러 `absent`를 낸다(`validate.ts:213-218`) — 게이트 방어선이 여전히 도달 가능함을 증명하는 fixture로 오히려 강해진다.

신규:

1. `[C-127] 재생성 상한 후 필수 섹션 미충족 → failed(required_sections_missing) · 채택 없음 · 후속 step 0회` — pm 출력에서 `## Risks`를 지우는 mock 래퍼. red 조건: 가드를 지우면 `status:"completed"`가 되어 status·`completed_steps` 미포함·후속 agent 호출 0회·`resume_from` 단정이 전부 깨진다.
2. `[C-127] resume은 실패 step부터 재실행하고 계약 충족 시 완주한다` — 1회차 깨짐/2회차 정상인 상태ful provider.
3. `[C-127] pipeline: 계약 미달 PRD는 checkpoint에 결박되지 않는다` — `pipeline next` → exit 1 · `pending === null` · `last_failure.stage` 기록 · 이후 정상 provider로 재호출 시 resume 후 `awaiting_approval`. 사용자가 지목한 통점의 직접 회귀 테스트.
4. `[C-127] 리서치 1차 미달은 2차가 교정하면 완주한다` — `tap()`으로 1차만 헤더 제거 → `completed` + warnings 1건. red 조건: 가드를 `runStepWithRegen`으로 옮기는 과차단 리팩터를 잡는다.
5. `[C-127] 리서치 채택 지점 미달 → failed + attempt 봉인` — 2차 헤더 제거 → `required_sections_missing` · receipt 존재 · `error_code: "research_step_failed"`.
6. `[C-127] Decision 절이 아예 없으면 게이트 전에 required_sections_missing` — 구 `ceoWithoutDecision` 시나리오의 인수 테스트.

## 9. 기각한 대안과 이유

1. **새 상태 `paused`** (대장 처방) — 소비자 전수 sweep + `summary.ts`의 `never` 봉인 switch 수정 강제. `failed`+`resume_from`이 의미상 동일하고 이미 전 소비자가 처리한다.
2. **`runStepWithRegen`에서 throw** — usage 계측 소실(C-126/A-2 회귀) + 리서치 1차 과차단.
3. **메인 루프 string-step 분기에만 가드** — 비평 critic/revise·리서치 채택 4경로가 그대로 열린다.
4. **깨진 산출물 미저장** — 운영자가 §6의 판단을 내릴 근거가 사라지고, diff도 더 크다. `savedFiles` 등재 덕에 파이프라인 drift 검증과의 정합도 공짜다.
5. **override 플래그(`--accept-invalid` 류)** — §4-12 문자열 자격증명. 통과시킨 문서의 헤더를 하류가 어차피 못 읽으므로 "통과"가 또 다른 거짓 영수증이 된다.
6. **resume 시 디스크 문서 재검증 후 채택** — 모델 산출도 아니고 run 기록도 없는 바이트를 채택하는 새 신뢰 경로. 구멍을 닫는 데 불필요하다.
7. **파이프라인 경계(buildManifest)에서 검증** — v3만 닫히고 v1 `run`의 completed 거짓은 그대로 남는다.

## 10. 남는 위험 (닫지 않는 것)

- **헤더 존재 ≠ 내용 품질.** 절만 있고 내용이 빈 문서는 여전히 completed다 — 비평 루프와 B-41 사람 승인의 몫.
- **리서치 채택 실패의 receipt `error_code`가 거칠다**(`research_step_failed`, run_state는 `required_sections_missing`).
- **v1 비파이프라인 `task-prompt`는 failed run을 하드 차단하지 않는다**(`taskPrompt.ts:44-56`) — 기존 성질이며 모든 실패 유형에 공통.
- **모델이 지속적으로 계약을 못 맞추면 resume마다 토큰이 탄다** — 자동 차단기는 `--max-tokens`뿐.
- **live provider의 실제 헤더 누락 빈도는 미확인** — 이 수정이 live에서 경고를 실패로 승격시키는 비용의 크기는 실측 전이다.
