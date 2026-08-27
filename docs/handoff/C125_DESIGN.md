# C-125 설계 — 아이디어 비평→개정 루프

> 작성 2026-08-27 (M13 · Fable 설계 세션 read-only). 오케스트레이터가 §1 핵심 3주장을 실물 재검했다:
> `idea-validation`의 `red_team`이 평문 step인 것 · `critique_loop`이 `mvp-planning`(target `tech_lead`)
> **한 곳뿐**인 것 · `LoopState.critique_round`(runWorkflow.ts:142)가 **선언만 있고 쓰이는 곳이 0건**인 것
> — `registry/workflows.json` 전문과 `grep -rn critique_round src`로 확인. 셋 다 참.
>
> **오케스트레이터 결정 1건(설계에 없던 것)**: `full-predev`도 평문 `red_team`을 갖지만 **이번에 바꾸지
> 않는다**. 사용자의 실제 경로는 파이프라인(`idea-validation`)이고, 레거시 올인원 workflow를 함께
> 바꾸면 acceptance 형태 단정이 추가로 흔들린다. 두 workflow의 비평 강도가 달라지는 불일치는
> **대장에 C급으로 등재**한다.

## 1. 실측한 현행 (file:line) — critique_loop이 정확히 무엇을 고치는가

**워크플로 정의.**
- `registry/workflows.json:4-13` — `idea-validation` steps: `chief_of_staff → research → pm → red_team → founder_ceo → {gate}`. **critique_loop이 없다.** `red_team`(:10)은 평문 step이라 비평이 `docs/05_RED_TEAM.md` 보고서로만 남고 아무 문서도 고쳐지지 않는다.
- `registry/workflows.json:24` — critique_loop은 레포 전체에서 **한 곳뿐**: `mvp-planning`의 `{ "critique_loop": { "target": "tech_lead", "critic": "red_team", "max_rounds": 2 } }`. 라운드 상한은 registry 데이터에 있고, 코드는 `Math.max(1, max_rounds ?? 1)`로 clamp한다(`src/core/runWorkflow.ts:1370`).

**루프 실행 방식** (`src/core/runWorkflow.ts:1350-1419`):
- critic은 `contextMode: "conclusion_only"` + `priorFindingsOverride: [target의 finding 한 줄]`로 격리 실행된다(:1376-1386). 단 **아이디어 본문(`ideaContent`)은 critic 프롬프트에도 항상 실린다**(`src/providers/promptParts.ts:71-73`).
- critic 산출물은 `persistFinalOutcome`으로 **채택·저장**된다(:1388) → `docs/05_RED_TEAM.md` 덮어쓰기 + `completed_steps`/`findings` 갱신(:842-860).
- `extractCriticalRisks`로 Critical 절을 뽑아(:1392) 0건이면 `resolved=true`로 조기 종료(:1394-1397), 있으면 `revisionRequest`로 target을 revise 실행(:1400-1412)하고 그 결과를 다시 `persistFinalOutcome`으로 채택(:1414) — **target의 `default_output`을 제자리 덮어쓰기**한다.
- 종료: Critical 0건 또는 `round >= maxRounds`(:1398). durable 기록은 루프 **완주 시에만** `critique_rounds`에 `{target, critic, rounds, resolved}` 1건(:1418, 타입 :71-76). 루프 도중 throw면 catch(:1420-1425)로 빠져 **이 entry는 안 남는다**.
- `LoopState.critique_round` 필드는 **선언만 있고 쓰는 곳이 없다**(:139-143); `:1451`은 `{ step_index }`만 기록.

**resume이 예산을 다시 여는 현행 결함.** resume은 `resume_from`부터 step 단위로 재시작하고(:661-694), `critique_rounds`는 carry하지만(:677) 루프의 `round`는 지역변수라 **루프 step에서 실패한 run을 resume하면 라운드 예산이 0부터 다시 시작**한다. (gate의 `gateBudget`(:575, :1162)도 같은 성질 — 기존 결함, 이번 범위 밖.)

**아이디어 snapshot과 B-40 결박.**
- `IDEA_REL = "docs/00_IDEA.md"`(:362), `snapshotProjectIdea`(:375-384)가 run 시작에 **한 번** 읽고(:504) 모든 agent가 그 snapshot을 쓴다(:773).
- kill 시 `idea.sha256`이 `kill_history`에 기록(:1189-1192), '진행' 판정 순간에만 `cleared_idea_sha256` 발급(:1229). 잠금 판정은 `ideaGateStatus`(:411-446).
- **하네스는 `00_IDEA.md`를 쓰는 경로가 없다**: 저장은 `saveArtifact(project, agent.default_output|token_output, …)`뿐이고(:843, :849) registry 8개 agent 출력 경로에 `00_IDEA.md`가 없다.

**checkpoint 배선.** `runStateSources`는 **`completed_steps` 기반**(`src/core/pipeline.ts:681-715`). `buildManifest`가 같은 read에서 digest+seed 한 줄을 뽑고(:630-662), 다음 단계 입력은 **승인된 checkpoint의 seeds만**이다(`seedFindingsFrom` :734-771).

## 2. 대장 처방·사용자 제안 검증 — versioned venture brief가 정말 필요한가?

**아니다. 더 싼 답이 있고 그 답의 4분의 3은 이미 레포에 있다.**

- "venture brief"에 해당하는 문서는 이미 존재한다: **pm의 `docs/02_PRD.md`**. 필수 헤더(문제 정의·대상 사용자·비범위·제약과 가정)가 곧 벤처 브리프의 골격이고, `00_IDEA.md`(사람 소유·불가침)의 **하네스 소유 해석본**이라는 자리가 정확히 이 파일이다. 새 문서를 만들면 init 파일명·checkpoint manifest·taskPrompt 문서 목록·요약 소비자를 전부 새로 배선해야 한다(C-130 부류의 어휘 중복).
- "비평→개정 루프" 메커니즘도 이미 존재한다: `critique_loop` step 타입은 target/critic이 **데이터**다(`registry.ts:28-32`). `target: "pm"`으로 꽂는 것은 registry 한 줄이다.
- **"versioned"는 기각한다.** 기존 tech_lead 루프도 `04_TECH_PLAN.md`를 제자리 덮어쓰기하고 레포가 그것을 수용했다. 라운드의 durable 기록은 `critique_rounds` 영수증 + `step_timings`이고, **최종 채택 바이트는 checkpoint가 sha256으로 결박**한다(`pipeline.ts:658`). 라운드별 바이트 보존이 실제로 필요해지면 그때 `outputs/rounds/` 복사 한 줄을 추가한다.

**결론: registry 1행 교체 + resume 라운드 예산 durable화(기존 결함의 근본 수정) = C-125의 전부다.** 새 문서·새 agent·새 step 타입·새 상태 0개.

## 3. 설계 (최소 diff)

### 3-A. registry 변경분 (`registry/workflows.json`)

`idea-validation`의 평문 `"red_team"`(:10)을 critique_loop으로 **교체**:

```json
"steps": [
  "chief_of_staff",
  "research",
  "pm",
  { "critique_loop": { "target": "pm", "critic": "red_team", "max_rounds": 2 } },
  "founder_ceo",
  { "gate": { "decider": "founder_ceo", "on": { "축소": "pm", "검증": "research" }, "kill": ["폐기"], "max_jumps": 1 } }
]
```

효과 (전부 기존 코드가 수행):
- red_team은 라운드 1 critic으로 **여전히 실행·저장**된다(:1388) → `docs/05_RED_TEAM.md`와 `completed_steps` 순서가 **현행과 동일** → checkpoint artifacts/seeds 집합 불변(`pipeline.ts:681-698`).
- Critical이 있으면 pm이 `docs/02_PRD.md`를 revise(:1400-1415) — **아이디어의 하네스 해석본이 실제로 고쳐진다.** founder_ceo는 revise된 pm finding + 최신 비평으로 판정한다(:857).
- step 수 6 유지, gate 점프 대상(`pm`·`research`)도 평문 step으로 그대로 존재(:1203).
- **교체(추가 아님)인 이유**: 평문 red_team을 남기고 루프를 덧붙이면 critic의 `persistFinalOutcome`이 같은 `default_output`을 즉시 덮어써 평문 보고서가 소멸한다 — LLM 1회 순수 낭비.

트레이드(정직하게): red_team이 full-context step에서 `conclusion_only` critic이 되므로 chief_of_staff/research finding 체인과 evidence digest를 못 받는다(digest 미지급은 C-126의 규율 — :739-749). mvp-planning에서 이미 수용한 편향 분리 설계와 동일하며, 아이디어 본문 자체는 계속 받는다.

### 3-B. 코드 변경분 (`src/core/runWorkflow.ts` 한 파일, ~30줄)

라운드 예산 durable화 — **공용 critique_loop 분기 한 곳**을 고쳐 tech_lead 루프의 같은 구멍도 함께 닫는다:

1. 누산기 옆(:587 부근)에 `let activeCritiqueRound = 0;`.
2. 루프에서 `round++` 직후 `activeCritiqueRound = round;`, `critique_rounds.push`(:1418) 직전에 `activeCritiqueRound = 0;`.
3. state 조립(:1451):
   ```ts
   loop_state: stopped && failedIndex !== null
     ? { step_index: failedIndex, ...(activeCritiqueRound > 0 ? { critique_round: activeCritiqueRound } : {}) }
     : null,
   ```
   (`LoopState.critique_round`는 이미 선언돼 있다 :142 — **새 필드도 새 상태도 아니다.**)
4. 루프 진입부(:1370 부근)에서 재개 라운드 복원:
   ```ts
   // [C-125] resume은 라운드 예산을 다시 열지 않는다 — 실패한 라운드 하나만 재시도한다
   // (C-126 totals와 같은 규율: 재시도 호출은 다시 쓰되 누적 예산은 단조).
   const priorRound = args.resume && prior?.loop_state?.step_index === i ? (prior.loop_state.critique_round ?? 0) : 0;
   let round = priorRound > 0 ? priorRound - 1 : 0;
   ```
   resume 시 findings는 저장 산출물에서 이미 복원되므로(:685-693) 라운드 k의 critic이 최신 revise본 finding으로 이어진다.

`registry/workflows.json` 외 다른 registry·schema·`pipeline.ts`·CLI 변경 **없음**.

## 4. 00_IDEA.md 불가침 보장 (B-40 sha256 결박과의 관계)

- 이 설계는 **쓰기 경로를 하나도 추가하지 않는다.** revise가 쓰는 곳은 `persistFinalOutcome → saveArtifact(project, targetAgent.default_output …)`(:1414, :843)이고 target=pm의 출력은 `docs/02_PRD.md`다. `00_IDEA.md`를 출력 경로로 가진 agent는 없다.
- 따라서 B-40 결박이 자동 성립: `cleared_idea_sha256`은 kill 게이트 '진행' 판정 순간 **run 시작 snapshot의 digest**로만 발급되며(:1229, :504), 하네스가 만든 바이트가 그 digest의 대상이 될 수 없다. "하네스가 아이디어를 고쳐 스스로 잠금을 푸는" 경로는 **파일을 쓰는 코드가 없으므로 원천 부재**.
- 개정되는 것은 아이디어의 **해석본(02_PRD.md)**이고, 그 바이트는 B-41 checkpoint가 sha256으로 결박해 사람 승인을 받는다 — 원본 불가침과 개정 가능성이 파일 두 개로 분리된다.

## 5. 라운드 상한과 durable 집행

- 상한 자체는 registry 데이터(`max_rounds: 2`) + clamp(:1370). 정상 경로 집행은 while 조건(:1374).
- resume 재개방은 §3-B로 닫는다: 라운드 k 실행 중 실패 → `loop_state.critique_round = k` durable 기록 → resume은 `round = k-1`에서 시작해 **실패한 라운드 k 하나만 재시도**하고 남은 예산(`maxRounds - k`)만 돈다. 반복 resume에서도 기록값은 k로 고정(단조).
- 구버전 run_state(critique_round 없음)는 `?? 0` → 현행과 동일한 전체 재시작 — additive, 하위 호환.
- 정직한 한계: run_state 손수 편집으로 카운터를 지우는 것은 못 막는다(C-7·C-131 부류). gate `max_jumps`의 resume 재개방은 기존 결함으로 이번에 안 닫는다(§11).

## 6. 루프 종료 판정 주체

**3중이며 전부 기존 의미론이다 — 새 판정자를 만들지 않는다.**
1. **모델(critic)**: Critical 0건이면 조기 종료(:1394-1397).
2. **고정 상한**: `max_rounds`가 미해결이어도 강제 종료하고 `resolved:false` 영수증을 남긴다(:1398, :1418).
3. **사람**: 같은 run의 founder_ceo kill 게이트와, 단계 끝 **B-41 checkpoint 승인**이 최종 채택 권한. `resolved:false`는 CLI(`run.ts:118-120`)·vault(`obsidianExport.ts:144-146`)에 "미해결(라운드 소진)"으로 표시된다.

미해결 Critical에서 run을 failed로 멈추는 안은 기각 — 그것은 C-127의 축이고 결합하면 두 항목이 서로를 인질 잡는다.

## 7. 하류 전달 경로 (C-123 미해결 전제)

- **run 내부**: revise마다 `findings.set(pm, …)`(:857)이 갱신되어 뒤 step(founder_ceo)의 `priorFindings`에 즉시 실린다 — 추가 배선 불필요.
- **단계 간**: 개정된 `docs/02_PRD.md`의 최종 바이트가 checkpoint artifacts로 결박되고, 같은 read에서 뽑은 **seed 한 줄**(`pipeline.ts:659`)이 승인 후 `seedFindingsFrom`(:734)으로 mvp-planning 첫 프롬프트에 실린다.
- **C-123 의존 없음**: 이 설계가 하류에 요구하는 것은 seed 한 줄뿐이고 그것은 지금 동작하는 경로다. 개정 전문이 하류 프롬프트에 안 실리는 것은 **오늘 모든 문서가 겪는 것과 같은 충실도**이며 C-123이 닫히면 균일하게 좋아진다.

## 8. 상태·소비자 전수

**새 상태 0, 새 필드 0** (미사용 선언 필드 `loop_state.critique_round` 사용 개시가 전부).

| 소비자 | 영향 | 근거 |
|---|---|---|
| CLI `run` 출력 | 변경 불요 — `critique_rounds`를 target 무관하게 렌더 | `src/commands/run.ts:118-120` |
| vault export | 변경 불요 | `src/core/obsidianExport.ts:144-146` |
| `summary` | 변경 불요 — critique_rounds를 읽지 않음 | `src/core/summary.ts` 전수 grep |
| progress 렌더러 | 변경 불요 — `critic`/`revise` kind + `round` 기지원 | `src/core/progress.ts:24` |
| checkpoint manifest | 변경 불요 — `completed_steps` 기반, 집합·순서 동일 | `pipeline.ts:681-698` |
| 영수증(run_state) | additive — `critique_round`는 루프 중 실패 시에만 출현 | `lockFieldsProblem` :312-331 |
| acceptance.sh | 완료 단계 문자열·실패 주입(pm index)·토큰 예산 시나리오 불변 | `scripts/acceptance.sh:55,94-120` |

## 9. 테스트 계획

**ⓐ 형태 추적 갱신 (약화 아님 — 새 설계 형태를 더 강하게 단정):**
- `progress.test.ts` "이벤트 순서: 순차 workflow…"(:120-154): kinds `["agent","agent","agent","critic","agent","gate"]` + critic의 `round:1` + `critique_rounds`에 `{target:"pm", critic:"red_team", rounds:1, resolved:true}` 단정으로 교체. red 조건: 루프 미배선.
- `approvalSeed.test.ts:173` 주석 한 줄(체인 표기) 갱신.

**ⓑ 신규 (red 조건 명시):**
1. `[C-125] idea-validation: red_team Critical → pm 문서 revise · 00_IDEA.md 바이트 불변` — 단정: `docs/02_PRD.md`에 revise 마커 존재, `critique_rounds = [{target:"pm",…}]`, **`sha256(00_IDEA.md)` 실행 전후 동일**. red: revise가 원본을 건드리거나 루프가 pm을 안 고침.
2. `[C-125] 라운드 예산 durable: 루프 중 실패 → critique_round 기록 · resume은 남은 라운드만` — critique fixture workflow(`workflowsPath` seam, `runWorkflow.test.ts:34` 선례) + R2 revise에서 throw하는 provider → `loop_state.critique_round === 2` → resume에서 critic 호출 수 == 1, 최종 `rounds === 2`. red: resume이 R1부터 다시 돎.
3. `[C-125] 루프 밖 실패에서는 critique_round가 없다 (additive)` — 평문 step 실패 run_state에 필드 부재 단정.

**ⓒ 불변 감시(기존 그대로 green — 수정 금지):** `pipeline.test.ts:139-154`, `approvalSeed.test.ts` 바이트 동일성 2건, `runWorkflow.test.ts` B-40 kill/잠금 전수, `acceptance.sh` Test 3/5/6.

## 10. 기각한 대안과 이유

1. **새 venture brief 문서(+전용 agent)** — `02_PRD.md`와 중복, init/manifest/taskPrompt/요약 어휘 전파 비용(C-130 부류).
2. **하네스가 `00_IDEA.md`를 버전 붙여 개정** — 제약 위반이자 B-40 의미론 파괴(하네스가 심사 대상 바이트의 저자가 됨).
3. **평문 red_team 유지 + 루프 추가** — critic이 같은 `default_output`을 즉시 덮어써 평문 보고서 소멸, LLM 1회 낭비.
4. **라운드용 monotonic totals 필드(C-126 모사)** — gate 되돌림의 정당한 재검토와 resume 재시도를 한 카운터에 뭉갠다. 이미 선언된 `loop_state.critique_round`로 충분.
5. **라운드별 사람 승인** — B-41 checkpoint가 이미 단계 끝 사람 게이트. 루프 내 approval은 `approval_approver_missing` preflight(:532-538) 때문에 approver 없는 idea-validation 호출 전부를 깬다.
6. **미해결 Critical 시 failed** — C-127의 축, 별도 항목.
7. **라운드별 바이트 스냅샷 저장** — 소비자 없는 파일 생산. YAGNI.

## 11. 남는 위험 · 이번에 닫지 않는 것

- **gate `max_jumps`의 resume 재개방**(:575, resume 블록 :663-694에 복원 없음) — 같은 부류지만 별개 결함, 별도 등재 권고.
- **`full-predev`의 평문 red_team** — 오케스트레이터 결정으로 이번에 안 바꾼다(머리말). 두 workflow의 비평 강도 불일치를 대장에 등재.
- **workflows.json이 실패~resume 사이 편집되면** step 의미가 바뀐 채 재개된다(resume은 `workflow_id`만 대조 :670-672) — 기존 전 step 공통 한계.
- red_team이 idea-validation에서 research 근거 digest를 못 받게 되는 트레이드(§3-A) — 편향 분리의 대가로 수용, 문서화만.
- 라운드 중간 바이트는 덮어쓰기로 소실 — 영수증(횟수·resolved)만 durable.
- C-127 미해결 시 revise 산출물의 필수 헤더 미충족이 warning으로 통과할 수 있다 — **C-127이 먼저 머지되면 자동 해소**(이 세션의 순서).
- run_state 손수 편집에 의한 카운터 소거(C-7/C-131 부류).

## 12. 예상 diff 크기

| 파일 | 추정 |
|---|---|
| `registry/workflows.json` | ~3줄 |
| `src/core/runWorkflow.ts` | +30~40 |
| `src/core/progress.test.ts` | ~15 변경 |
| `src/core/runWorkflow.test.ts` | +100~140 |
| `tests/fixtures/workflows/critique-resume.json` | +15 (신규) |
| `src/core/approvalSeed.test.ts` | ~1 (주석) |
| **합계** | **약 170~220줄** |

---

# 리비전 1 — Codex 적대적 계획 리뷰 반영 (2026-08-27, 오케스트레이터 triage 후)

Codex(gpt-5.5, read-only) 리뷰 finding을 **오케스트레이터가 실물 검증**한 뒤 아래를 계약에 편입한다.
검증 방법은 인용된 file:line을 직접 열어 확인하는 것이었고, 결과를 finding마다 적었다.

## R1-A [A급 · 수용 · 설계 §3-B를 고친다] resume 힌트가 게이트 재진입에서 재사용된다

**Codex 주장**: `prior`는 resume 시작 때 한 번 고정되는데(`runWorkflow.ts:662`) 설계 §3-B의 복원 조건은
**루프 진입마다** `prior.loop_state`를 본다. 게이트 점프는 `i = targetIdx - 1; continue`로 같은
critique_loop을 **다시** 지나가게 한다(`:1212`). 시나리오: R2에서 실패 → resume → 루프 완주 →
CEO '축소' → pm 점프 → critique_loop 재진입 시 **철 지난 `critique_round`가 아직 살아 있어**
새 pass를 "실패 라운드 재개"로 오인하고 R1을 건너뛴다.

**오케스트레이터 검증**: **참이다.** `:662`의 `const prior = args.resume ? loadRunState(project) : null;`은
run 수명 동안 불변이고, `:1212`의 점프가 같은 인덱스를 다시 밟는 것을 코드에서 확인했다.

**수정 계약**: **힌트를 1회 소비 자원으로 만든다.**
```ts
// [C-125/R1-A] resume 힌트는 **한 번만** 쓴다. 게이트 되돌림(:1212)이 같은 critique_loop 인덱스를
// 다시 밟으므로, 힌트를 상시 참조하면 새 pass가 옛 실패의 라운드를 이어받아 R1을 건너뛴다.
// (기각한 대안: pass id를 만들어 힌트에 결박 — 새 식별자 축이 늘고 durable 필드가 하나 더 생긴다.)
let critiqueResumeHint = args.resume ? (prior?.loop_state ?? null) : null;
...
const priorRound = critiqueResumeHint?.step_index === i ? (critiqueResumeHint.critique_round ?? 0) : 0;
critiqueResumeHint = null;   // 소비
let round = priorRound > 0 ? priorRound - 1 : 0;
```
**필수 테스트 추가 4**: `[C-125/R1-A] 게이트 재진입은 resume 힌트를 재사용하지 않는다` — R2 실패 →
resume → 루프 완주 → 게이트 '축소' 점프 → 재진입 루프가 **R1부터** 돈다(critic 호출 수로 관측).
red 조건: 힌트 소비를 지우면 재진입이 R1을 건너뛴다.

## R1-B [B급 · 수용(문구만) · 영수증의 의미를 낮춘다] gate 점프 후 영수증과 최종 바이트가 어긋난다

**Codex 주장**: pm revise와 pm 평문 재실행이 **둘 다** `docs/02_PRD.md`를 덮는데
(`:1138`, `:1414`), `critique_rounds`는 `{target, critic, rounds, resolved}`만 남기고 hash·pass가 없다
(`:71-76`). 1차 loop가 revise → CEO '축소' → pm 평문이 PRD를 다시 덮음 → 2차 loop가 Critical 0으로
종료 → **최종 PRD가 "비평 반영본"이 아닌데 영수증은 남는다.**

**오케스트레이터 검증**: **참이다.** 다만 이것은 **C-125가 만드는 결함이 아니라** 기존
tech_lead 루프에도 이미 있는 성질이다(같은 두 경로가 `04_TECH_PLAN.md`를 덮는다).

**수정 계약**: 코드는 안 고친다. **`critique_rounds` 타입 주석에 한 줄** — *"이것은 라운드 이력 로그이지
최종 바이트의 증명이 아니다. 최종 바이트를 결박하는 것은 B-41 checkpoint의 sha256뿐이다."*
hash/pass 필드 추가는 **기각**(새 durable 필드 + 소비자 전수). 대장에 C급 등재.

## R1-C [B급 · 수용 · 설계 §12를 정정한다] 비용·호출 수 증가가 과소 반영됐다

**Codex 실측**: token budget 검사는 top-level step 시작 전에만 있고(`:1076-1085`) critique_loop 안의
critic/revise/critic 연속 호출 사이에는 **없다**(`:1374-1406`). 호출 수(research self 기준):
- 게이트 점프 없음: 기존 5회 → **새 설계 최악 7회**
- '검증' 점프 포함: 기존 9회 → **새 설계 최악 13회**
- external research 2차 포함: 기존 11회 → **새 설계 최악 15회**
- `maxRegenerations=1`이면 실제 provider 호출은 각각 **최악 2배 → 30회**

**오케스트레이터 판단**: 수용한다. **설계 §12는 diff 줄 수만 셌고 런타임 비용은 세지 않았다** — 그것이
누락이다. 이번 세션 live 실측이 이 숫자에 무게를 준다: run #1(idea-validation 1단계)만으로 **37.5분 ·
output 133,458 토큰**이 들었고 그것은 critique_loop **없이** 나온 값이다.
**계약**: 구현은 그대로 진행하되 `--max-tokens` overshoot(루프 내부 미검사)를 **대장에 B급 등재**하고,
판정 절에 위 호출 수 표를 **그대로** 싣는다. 루프 내부 예산 검사는 별도 슬라이스.

## R1-D [C급 · 수용 · 테스트 계획 보강] 설계가 빠뜨린 golden 소비자

**Codex 지적**: `toolProfile.test.ts:62-69`의 golden 회귀가 `critique_rounds: []`와 기존 timing을
전제한다(`tests/fixtures/golden/idea-validation.run_state.json`). 설계 §9는 `progress.test.ts`만 적었다.

**오케스트레이터 검증**: **참이다** — `toolProfile.test.ts`가 `idea-validation`을 mock으로 돌려 golden과
비교한다. **§9 ⓐ에 `toolProfile.test.ts` + golden fixture를 추가한다.**
(주의: C-127 슬라이스가 **같은 golden 파일**을 이미 고친다 — 통합 순서상 C-127이 먼저 머지되므로
C-125 구현자는 **C-127 머지 후의 golden을 기준으로** 갱신해야 한다.)

## R1-E [C급 · 기각하지 않되 과대주장 금지] acceptance는 이 경로를 못 본다

**Codex 지적**: mock red_team은 Critical 없음만 내므로(`mockProvider.ts:100-104`) **PRD revise 경로를
acceptance가 검증하지 않는다.** "acceptance 272 통과"를 C-125의 검증 근거로 내세우면 과대주장이다.

**오케스트레이터 판단**: 수용. 판정 절에 그대로 적는다. 다만 **mock을 Critical을 내도록 바꾸지는
않는다** — 그러면 모든 workflow의 mock run이 루프를 돌아 golden·타이밍이 전부 흔들린다. 대신 신규
테스트 1·4가 **fixture provider로** 그 경로를 덮는다(§9 ⓑ).

## Codex가 확인해 준 것 (설계가 맞았던 부분)
- `completed_steps` 집합·순서는 성공 run 기준 **불변**이다(red_team은 첫 critic 저장 때 push, pm revise는
  이미 있는 pm을 다시 push하지 않는다 — `:1388`, `:856`). seed/hash 값만 PRD 바이트를 따라 바뀐다.
- `revisionRequest`는 **tech_lead 전용 어휘가 아니다**(`Decisions/Assumptions/Risks`는 공용 출력 헤더 —
  `promptParts.ts:98-104`). pm에게도 말이 된다.
- §3-B 코드의 스코프는 **컴파일된다**(`args`·`prior`·`loop_state.critique_round` 접근 가능).
- **[오케스트레이터 live 실측 추가]** red_team은 PRD/아이디어 맥락에서도 `### Critical`을 실제로 낸다
  (2026-08-27 subcut live: Critical 3건). → `extractCriticalRisks`가 발화한다는 전제는 참이다.
