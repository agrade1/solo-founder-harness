# B-49 설계 — 게이트가 '검증'을 반복해도 단계가 끝난다

> 작성 2026-08-27 (M14 · Fable 설계 세션 read-only). live run#3(commrep) 교착의 종결 규칙 설계.
> **C-125가 먼저 머지된 코드 위에 얹힌다고 가정한다** — `idea-validation`의 step 3은
> `critique_loop{target: pm}`이고 `loop_state.critique_round`·R1-A(힌트 1회 소비)가 들어와 있다.
> 아래 file:line은 현재 HEAD `a0e5dbd` 실측이며, C-125 머지로 밀릴 수 있다 — 구현자는 심볼로 찾아라.

## 1. 실측한 현행 (file:line) — 전부 이 세션에서 직접 열었다

**킥오프가 준 사실 목록은 전건 재확인 일치 — 반박 0건.** 재확인한 핵심 + 목록에 없던 **보완 4건**:

- `runWorkflow.ts:582` `const gateBudget = new Map<number, number>()` — run 지역. `:1207` 게이트 도착
  시 초기화, `:1252` jump 시 차감. 게이트 분기 순서(decider 미실행 → 파싱 fail closed `:1214-1226` →
  kill `:1233-1242` → jump `:1248-1257` → '진행' 화이트리스트 `:1265-1275` → 사유별 중단 `:1276-1291`,
  소진은 `:1285`) 재확인. `:1494-1498` failed + `resume_from = 게이트 인덱스`, killed는 resume_from null.
- `gate_jumps`는 resume에서 carry-forward(`:685`)·truncate 없음(잘리는 것은 researchAttempts뿐,
  `:951-953` 부근). entry(`:85-97`)에 **step index 없음**, `outcome:"jump"`가 실제 되돌림 1회. 재확인.
- resume: `workflow_id` 강제(`:678` 부근), 완료 step은 저장 산출물에서 `findings`·`lastMarkdown` 복원
  (`:693-699`) → **게이트 인덱스에서 resume하면 LLM 0회로 게이트만 재평가된다**. 재확인.
- **보완 ①(이 설계의 출발점)**: 위 "게이트만 재평가"는 현행에서 **재평가가 곧 재점프**다. 지역 Map이
  부활시킨 예산(remaining=1)으로 복원된 '검증'이 jump 분기(`:1248`)를 다시 타 `research`부터 한 lap을
  통째로 재실행한다. 즉 소진 실패의 resume은 "재판정 후 정지"가 아니라 **무조건 한 바퀴 더**(live 실측
  lap당 30.2분 · output 105k)이고, 바뀐 입력이 없으면 같은 '검증'으로 같은 실패를 재생산한다.
- **보완 ②**: `ceo_decision_absent`/`ambiguous` 중단(`:1214-1226`)은 gate_jumps에 **entry를 남기지
  않는다**(push 없음) — §3의 파생 예산이 그 사유들의 복구 경로(`:1217` 주석: 사람이 Decision을 고쳐
  재개)를 건드리지 않는다.
- **보완 ③**: pipeline resume의 사전 drift 검증(`commands/pipeline.ts:363-377`)은 **승인된(이전
  checkpoint) 산출물만** 결박한다. 현 단계 decider 문서(`docs/06_CEO_DECISION.md`,
  `registry/agent_registry.json:89`)는 승인 전이라 검증 대상이 아니고, idea-validation은 1단계라
  approvedDigests 자체가 빈다 — **사람이 Decision을 고치고 resume하는 레버는 pipeline 경로에서 실제로
  살아 있다** (코드로 확인).
- **보완 ④**: `restartPipeline`(`commands/pipeline.ts:781`)은 awaiting_run/awaiting_approval을
  `pipeline_active`로 거부(`:796-802`)하고 killed/completed에서만 새로 시작한다 — pipeline 안에서
  "전체 재평가"는 **kill 종결을 거친 뒤에만** 열린다. run 단독 경로는 활성 pipeline에서 전면 거부
  (`commands/run.ts:38-46`)이므로 fresh run 레버는 비-pipeline 프로젝트에서만 참이다.
- `:1265-1271` 주석 직접 읽음(ⓐ-(2) 판단 근거): "되돌림 예산이 소진되면 같은 '축소' 판정이 진행으로
  바뀌고, run이 completed가 되어 task-prompt·handoff까지 열렸다 — 상태 전이 우회 + 거짓 성공 영수증."
- B-40: '진행' 순간에만 `cleared_idea_sha256 = idea.sha256`(`:1274`), snapshot은 run 시작 1회(`:511`).
  `lockFieldsProblem`(`:319`)은 kill_history/cleared만 본다 — 이 설계의 신규 필드는 잠금 필드가 아니다.
- 주입 seam: `runStepWithRegen`의 `revisionRequest`(`:713-720`) → `runAgent.ts:17` →
  `providers/promptParts.ts:43` 블록 렌더. 평문 step은 현재 이 옵션을 안 쓴다(`:1177-1182`) — 비게이트
  경로 프롬프트 바이트를 안 바꾸고 재사용 가능.

## 2. ⓐ '검증' 반복의 종결 규칙 — **(3)+(1) 조합**을 고른다

**규칙**: 되돌림 예산이 소진된 lap의 decider는 **그 사실을 통지받은 채** 판정한다(=(3)). 그래도
'검증'이면 기존 `gate_jump_budget_exhausted` 중단이 **그 자체로 종결**이고 공이 사람에게 넘어간다(=(1)).
사람의 레버는 코드로 검증된 실동작 2개다(§2-1). 모델이 스스로 무한 재검토하는 경로는 어디에도 없다.

**(3)이 장식이 아닌 이유**: 현행 lap 2의 CEO는 lap 1과 **구분되는 입력을 하나도 받지 않는다** —
gate_jumps는 프롬프트에 없고 findings는 같은 키로 덮인다. 같은 입력이면 같은 '검증'이 나오는 것이
run#3 교착의 메커니즘이다. "되돌림은 이미 소진됐고 이번이 종결"이라는 참인 한 문장이 lap 간 유일한
새 정보이고, 추가 호출 0으로 주입된다. 통지는 **판정을 바꾸라는 지시가 아니다** — '검증' 유지도 정당한
종결이며 그때 run이 멈춰 사람이 받는다(fail closed 유지). 모델을 '진행' 쪽으로 몰면 그것이 곧 새로운
거짓 영수증 공장이 되므로 문구에서 명시적으로 금지한다(§5-(h) 문안).

**(1)의 사람 레버 — 출처 위조 질문에 정면으로 답한다.** 레버는 "decider 문서의 `## Decision`을 사람이
종결 판정으로 고치고 resume"이고, 그 결과 '진행'이면 `cleared_idea_sha256`이 발급된다. 이것이 위조인가:

- **오늘의 실상**: 이 레버는 이미 계약이다 — `:1217` 주석이 absent/ambiguous의 복구 경로로 "사람이
  decider 문서의 `## Decision`을 고치면 재개된다"를 명시하고, 그 경로로 '진행'을 적어 resume하면
  **지금도** clearance가 아무 표시 없이 발급된다(코드로 확인: 복원 `lastMarkdown` → `:1265` → `:1274`).
  즉 출처 위조는 이 설계가 여는 것이 아니라 **현행에 이미 성립해 있다** — 모델 판정과 사람 수정이
  영수증에서 구분 불가능하다.
- **설계의 답**: 레버를 막지 않고(막으면 `:1217` 복구 경로가 죽는다) **영수증을 정직하게 만든다**.
  게이트가 판정을 읽은 문서가 이번 run에서 실행된 decider의 출력이 아니라 resume 복원본이면, 그
  entry에 `decision_source: "restored_artifact"`를 남긴다(§5-(e,f)). `cleared_idea_sha256`의 의미는
  "게이트가 **이 아이디어 바이트**에 해제를 발급했다"이지 "모델이 진행을 판정했다"가 아니다 — 판정
  저자 사실은 gate_jumps entry가 나른다. 구분되는 기록은 위조가 아니다. **따라서 허용 — 단 표시가
  조건이다**(표시 없는 현행 그대로는 허용이라 말할 수 없다). 사용자 목표("단계마다 사람 확인")에서
  사람은 위임자(founder)이고 founder_ceo는 그 대리 모델이다 — 위임자의 기각(override)은 은폐될 때만
  문제가 된다.
- 한계는 §9에 정직하게 적는다: 이 필드는 "복원 문서였다"까지만 증언하고 편집 주체(사람/스크립트)는
  증명하지 않는다.

**(2) 기각 — "되돌림 없이 그대로 체크포인트를 올린다"**: `:1265-1271` 주석이 닫은 바로 그 동작이다.
checkpoint(`commitPending`)는 completed run의 산물이므로 (2)를 세우려면 '검증' run을 completed로
만들거나 failed run에서 pending을 승격하는 제3의 전이가 필요하다 — 전자는 닫힌 취약점의 재개방(CEO가
진행 판정을 낸 적 없는 run이 task-prompt·handoff·vault에 완주 영수증을 뿌린다), 후자는 새 상태 전이
+ 전 소비자 전수 비용. "사람이 checkpoint에서 승인하니 괜찮다"는 반론의 정직한 형태가 정확히 (1)의
레버다: 사람이 판정을 **명시적으로, 출처가 남게** 대체한 뒤 completed가 되는 것. (2)는 (1)의 익명
버전일 뿐이므로 기각한다.

## 3. ⓑ durable화 — **gate_jumps에서 파생한다 (새 필드 0 · 지역 Map 삭제)**

- `spent = gate_jumps에서 outcome==="jump" && decider 일치 entry 수`,
  `remaining = max(0, max_jumps - spent)`. gate_jumps는 run 안에서 jump마다 push되므로 파생값이 항상
  현재값이고(별도 차감 불필요), resume은 `:685`가 이어받으므로 예산이 되살아나지 않는다 — C-126
  `totals`와 같은 단조 규율. **run 내 동작은 현행과 완전 동일**(첫 도착 spent=0, jump 후 재도착
  spent=1)이라 기존 게이트 테스트가 그대로 green이다.
- **step index 부재의 함정**: 같은 decider의 게이트가 둘이면 예산을 나눠 갖는다(과소 예산 — fail
  closed 방향이지만 원인 불명 정지). **실행 전 중복 decider 게이트를 명시적으로 거부**하는 guard로
  다룬다(§5-(c)). 현행 registry는 workflow당 게이트 1개라 걸리지 않는다. entry에 step_index를 추가하는
  안은 기각(§8-3).
- **탈출구의 대가 — 이렇게 치른다**: durable화로 "공짜 한 바퀴"는 사라지지만 정당한 경로는 남는다.
  ① **사람 종결 판정**(§2 레버): resume이 LLM 0회로 복원 문서를 재판정 — '진행'→checkpoint,
  '보류'→hold 중단, '폐기'→killed. ② **전액 지불 재평가**: gate_jumps는 resume에서만 carry되므로
  (`:685`가 resume 블록 안 — kill_history류의 무조건 carry와 다름을 확인) **새 run은 예산이 새로
  시작한다**. 비-pipeline은 `harness run`(fresh), pipeline은 ①의 '폐기' 종결 후
  `pipeline restart`(§1 보완 ④). "한 번 더 돌려본다"는 전체 재실행 비용을 정직하게 내는 경로로만
  존재한다. ③ 예산을 늘리는 전용 CLI는 **기각**(§8-5) — 수요가 live로 실측되면 C급 등재.
- 아무것도 안 고친 resume은 **LLM 0회로 즉시 같은 자리에서 다시 막히고** failed entry 한 줄만
  는다(단조 영수증). 안내가 이것을 그대로 적는다(§5 run.ts/pipeline.ts) — C-138/④의 규율.

## 4. ⓒ C-125와의 상호작용 — 두 예산의 곱은 run 안에 갇힌다

`C125_DESIGN.md` 전문·리비전 1 절 읽음. 전제: critique_loop이 step 3, 라운드 예산은
`loop_state.critique_round`로 durable, resume 힌트는 1회 소비(R1-A).

- **게이트 되돌림이 critique_loop을 R1부터 다시 돌리는 것은 의도다.** 점프 후 pm이 평문 재실행으로 새
  문서를 만들므로 옛 라운드는 죽은 바이트에 대한 것이다 — R1-A의 힌트 소비가 정확히 이 의미론을
  보장하고, B-49는 그것을 바꾸지 않는다. 두 durable 상태는 축이 다르다: `critique_round`는 "실패한
  라운드 재시도"(lap 안), `gate_jumps` 파생 예산은 "lap 수"(run 전체) — 서로 읽지도 쓰지도 않는다.
- **곱의 상한**: run 안 lap 수 ≤ 1 + max_jumps(=2). R1-C 표가 그대로 성립한다 — '검증' 점프 포함 최악
  13회(external 15회, maxRegenerations=1이면 최악 30회). **B-49는 run 내 최악 호출 수를 늘리지도
  줄이지도 않는다**(통지는 기존 CEO 호출의 프롬프트 바이트 추가일 뿐, 호출 0).
- **B-49가 바꾸는 것은 resume 곱셈 항이다**: 현행은 소진 실패 resume마다 예산이 부활해 한 lap
  전부(자체 리서치 기준 5~8호출, regen 포함 최대 ~16)를 다시 태우며 **반복 횟수에 상한이 없다**. 설계
  후 그 항은 0이다(소진 게이트 resume = LLM 0회 재판정). R1-C의 "루프 내부 --max-tokens 미검사"(B급
  등재)는 이번에도 닫지 않는다 — B-49는 상한을 낮추는 슬라이스가 아니라 무한 증식을 없애는 슬라이스다.
- 수용 판단: 최악 30회는 C-125 판정 절이 이미 수용한 값이고, B-49 이후 그 값이 **run당 1회로 유한**해
  지므로 수용한다. 유한하지 않던 것은 resume 항이었고 그것을 이 설계가 없앤다.

## 5. 설계 (최소 diff) — 파일별 변경분

### (a) `src/core/runWorkflow.ts` — import

`./registry.js` import(`:4-18`)에 `type GateDef,` 추가.

### (b) 예산 파생 (`:582` 교체)

```ts
// [B-49] 되돌림 예산은 gate_jumps 영수증에서 파생한다 (지역 Map 삭제). Map은 resume마다 예산을
// 되살려, 소진 실패에서 resume하면 복원된 '검증'으로 무조건 재점프해 한 lap을 통째로 재실행했다
// (2026-08-27 live run#3: lap당 30.2분 · output 105k, 반복 상한 없음). 영수증은 resume에서
// carry-forward되고(gate_jumps.push(...prior.gate_jumps)) 잘리지 않으므로 어느 경로에서도
// 예산이 되살아나지 않는다 — C-126 totals와 같은 단조 규율. 새 run(비resume)은 영수증을
// 이어받지 않으므로 예산이 새로 시작한다: "전체 재실행 비용을 내면 한 바퀴 더"가 의도된 탈출구다.
const spentJumps = (decider: string) =>
  gate_jumps.filter((g) => g.outcome === "jump" && g.decider === decider).length;
const remainingJumps = (gate: GateDef) => Math.max(0, (gate.max_jumps ?? 0) - spentJumps(gate.decider));
const restoredIds = new Set<string>(); // [B-49] 이번 run에서 실행되지 않고 디스크에서 복원된 step
```

### (c) 중복 decider 게이트 거부 (main 루프 진입 전, `:1120` 앞)

```ts
// [B-49] 파생 예산은 decider 단위다 — GateJumpEntry에 step index가 없다. 같은 decider의 게이트가
// 둘이면 예산을 서로 나눠 갖는다(과소 예산: fail closed 방향이지만 원인이 보이지 않는 정지).
// 정의 오류는 실행 전에 거부한다. 현행 registry는 workflow당 게이트 1개라 걸리지 않는다.
// (기각한 대안: entry에 step_index 추가 — durable 형태 변경 + 구버전 entry fallback 이중화.)
const gateDeciders = workflow.steps.filter(isGate).map((s) => s.gate.decider);
if (new Set(gateDeciders).size !== gateDeciders.length) {
  throw new Error(
    `workflow '${workflowId}': 같은 decider의 게이트가 2개 이상 — 되돌림 예산(gate_jumps 파생)이 decider 단위라 지원하지 않는다.`,
  );
}
```

### (d) 게이트 분기 — Map 대신 파생 (`:1207-1208` 교체, `:1252` 삭제)

```ts
const remaining = remainingJumps(step.gate);
```

jump 분기의 `gateBudget.set(i, remaining - 1);`(`:1252`)은 삭제 — 직후 push되는 jump entry가 곧
차감이다. `남은 되돌림 ${remaining - 1}` 로그 문구는 그대로 참.

### (e) 판정 출처 영수증 (resume 복원 루프 · persistFinalOutcome · 게이트 분기)

- 복원 루프(`:699` 뒤): `restoredIds.add(id);`
- `persistFinalOutcome`(`:895` 부근, `completed_steps` push 옆): `restoredIds.delete(agent.agent_id);`
- 게이트 분기, `const decision: string = parsed.token;`(`:1229`) 뒤:

```ts
// [B-49] 판정 출처: decider가 이번 run에서 실행되지 않았다면(=resume 복원 문서를 읽었다면) entry에
// 남긴다. 사람이 "## Decision"을 고쳐 재개하는 복구 경로(위 absent 주석)는 이미 계약인데, 그 경로로
// 발급되는 영수증이 모델 판정과 구분되지 않았다 — 구분되는 기록은 위조가 아니다(B49_DESIGN §2).
const src = restoredIds.has(decider) ? ({ decision_source: "restored_artifact" } as const) : {};
```

네 push(`:1238`, `:1253`, `:1268`, `:1287`)에 `...src` 추가. 예:
`gate_jumps.push({ decider, decision, jumped_to: null, outcome: "proceed", ...src });`

### (f) `GateJumpEntry` 타입 (`:96` 부근)

```ts
/** [B-49] 게이트가 읽은 판정 문서가 이번 run에서 실행된 decider의 출력이 아니라 resume 복원본일
 * 때만 존재한다(사람이 Decision을 고쳐 재개한 경우 포함). cleared_idea_sha256은 아이디어 바이트의
 * 영수증이지 판정 저자의 영수증이 아니다 — 저자 사실은 이 필드가 나른다. */
decision_source?: "restored_artifact";
```

### (g) `gateOutcomeLabel` (`:104`) — 단일 렌더 지점에 출처 표시

```ts
export function gateOutcomeLabel(g: GateJumpEntry): string {
  const base = (() => {
    switch (g.outcome) {
      // ... 기존 case 전부 그대로 ...
    }
  })();
  return g.decision_source === "restored_artifact" ? `${base} · 판정 출처: 복원 문서(decider 이번 run 미실행)` : base;
}
```

CLI(`run.ts:124-125`)·vault(`obsidianExport.ts:147-150`)가 이 함수 하나를 쓰므로 자동 반영(B-40/A-2).

### (h) 종결 통지 (평문 step 분기, `:1177` runStepWithRegen 호출 앞)

```ts
// [B-49/ⓐ-3] 이 agent가 하류 게이트의 decider이고 되돌림 예산이 이미 소진됐으면, 이번 판정이
// 종결임을 알린다 — 추가 LLM 호출 0, 같은 호출의 프롬프트 바이트만 는다. 예산 미소진 lap과
// 게이트 없는 workflow에서는 undefined → 프롬프트 바이트 불변(additive).
const deciderGate = workflow.steps.filter(isGate).find((s) => s.gate.decider === step);
const gateNotice =
  deciderGate && (deciderGate.gate.max_jumps ?? 0) > 0 && remainingJumps(deciderGate.gate) === 0
    ? `게이트 되돌림 예산 소진 통지: 이 workflow의 되돌림(max_jumps=${deciderGate.gate.max_jumps})은 이미 소진되었다. ` +
      `이번 "## Decision"은 종결 판정이다 — '검증'/'축소'를 내도 되돌림은 일어나지 않고 run이 중단되어 사람에게 넘어간다. ` +
      `판정을 바꾸라는 지시가 아니다: 여전히 검증이 부족하다고 판단하면 '검증'을 유지하되, ` +
      `무엇이 어떻게 검증되어야 하는지 Main Judgment에 구체적으로 적어라 — 사람이 그 사유로 후속 조치를 정한다.`
    : undefined;
```

`runStepWithRegen` 호출에 `revisionRequest: gateNotice,` 추가 — **기존 seam 재사용, 새 파라미터 0**
(promptParts 블록 라벨이 "비평 반영 수정 지시"로 일반적인 것은 §8-4에서 다룬 트레이드).
decider가 web_research agent인 workflow에는 실리지 않는다(그 분기가 먼저 continue) — 현행 registry에
해당 없음, §9에 기록.

### (i) `src/commands/run.ts` — 사유별 안내 (`:114-116` 사이)

registry import(`:2`)에 `loadAgentRegistry, findAgent` 추가.

```ts
if (state.failed_reason === "gate_jump_budget_exhausted") {
  // [B-49] 안내는 참이어야 한다(C-138/④): 예산은 영수증 파생이라 resume으로 되살아나지 않는다.
  const deciderDoc =
    (state.failed_agent && findAgent(loadAgentRegistry(), state.failed_agent)?.default_output) ?? "(decider 문서)";
  console.log(
    `되돌림 예산이 소진됐습니다 — 아무것도 고치지 않고 --resume하면 LLM 호출 없이 같은 자리에서 다시 막힙니다.\n` +
      `  ⓐ 사람이 종결 판정: ${deciderDoc}의 "## Decision"을 진행/보류/폐기 중 하나로 고친 뒤 --resume — ` +
      `게이트가 복원 문서로 재판정하고(LLM 0회) 영수증에 판정 출처가 남습니다.\n` +
      `  ⓑ 모델 재평가: 아이디어·문서를 보강한 뒤 --resume 없이 새 run — 전체 재실행 비용으로 예산이 새로 시작됩니다.`,
  );
}
```

### (j) `src/commands/pipeline.ts` — `commitAfterRun` 실패 분기 (`:514` 뒤, research 분기와 병렬)

```ts
// [B-49] 사유별로 갈린다(C-138/④ 규율). restart는 awaiting_run에서 거부되므로(restartPipeline)
// 여기 적는 경로는 전부 코드로 확인된 실동작이다.
if (reason === "gate_jump_budget_exhausted") {
  const deciderDoc =
    (result.state.failed_agent && findAgent(loadAgentRegistry(), result.state.failed_agent)?.default_output) ??
    "(decider 문서)";
  console.error(
    `게이트 복구 경로 (되돌림 예산은 영수증 파생이라 resume으로 되살아나지 않습니다):\n` +
      `  ⓐ 사람이 종결 판정: ${deciderDoc}의 "## Decision"을 진행/보류/폐기로 고친 뒤 같은 명령 — ` +
      `게이트가 복원 문서로 재판정합니다(LLM 0회). '진행'이면 다음은 체크포인트 승인, '폐기'면 killed 종결.\n` +
      `  ⓑ 처음부터 재평가: 진행 중 파이프라인은 restart가 거부되므로, ⓐ의 '폐기' 종결 뒤 ` +
      `'harness pipeline restart --project ${project}'로 새로 시작하세요.\n` +
      `  (아무것도 고치지 않은 resume은 LLM 호출 없이 같은 자리에서 다시 막히고 실패 영수증만 한 줄 늡니다.)`,
  );
}
```

registry import(`:55`)에 `findAgent, loadAgentRegistry` 추가.

**registry·schema·golden·acceptance 변경 없음.**

## 6. 상태·소비자 전수 표

**새 durable 필드 1**: `GateJumpEntry.decision_source?`(additive — resume 재판정 entry에만 출현).
**삭제 1**: 지역 `gateBudget` Map. 새 status·새 CLI 표면 0.

| 소비자 | 영향 | 근거 (grep/실측) |
|---|---|---|
| CLI `run` 게이트 렌더 | 자동 — `gateOutcomeLabel` 경유 | `run.ts:124-125` |
| CLI `run` 실패 안내 | +사유 분기 (§5-i) | `run.ts:113-116` 현행은 무차별 resume 안내 |
| `pipeline next` 실패 안내 | +사유 분기 (§5-j) | `pipeline.ts:471-521` (research만 분기하던 곳) |
| pipeline resume/drift | 변경 불요 — decider 문서는 승인 전 산출물 | `pipeline.ts:351-377` (§1 보완 ③) |
| vault export | 자동 — `gateOutcomeLabel` 경유 | `obsidianExport.ts:147-150` |
| `summary` | 변경 불요 — gate_jumps/failed_reason 미소비 | `summary.ts` grep 0건 |
| progress 렌더러 | 변경 불요 — `gate` kind·`gate_jump` 이벤트 불변 | `progress.ts:13,38` |
| `lockFieldsProblem` | 변경 불요 — 잠금 필드 아님 | `runWorkflow.ts:319-345` |
| golden fixture | **불변** — mock 완주는 jump 0·decider 실행됨·통지 미발생 | `tests/fixtures/golden/idea-validation.run_state.json` (gate_jumps 1건 proceed 확인) |
| `scripts/acceptance.sh` | **불변** — mock CEO '진행' 고정, 게이트 소진 시나리오 없음, Test 7/8 resume은 gate 무관(gate_jumps 빈 상태 carry) | `:92-122` |
| 기존 게이트 테스트 | **그대로 green** — run 내 예산 의미 동일, deepEqual 대상 entry는 decider 실행 케이스라 새 필드 부재 | `runWorkflow.test.ts:283,333,355-356` |

## 7. 테스트 계획 (전부 신규 — 기존 테스트 약화·삭제 0)

기존 fixture seam 재사용: 게이트 뒤 sentinel step workflow(`runWorkflow.test.ts:34`),
providerOverride로 CEO 토큰 고정, per-agent 호출 수 관측.

1. `[B-49] resume은 되돌림 예산을 되살리지 않는다` — CEO '검증' 고정 → run: jump 1 + exhausted →
   resume → **provider 호출 0회** · status failed 유지 · gate_jumps 정확히 +1(failed entry) ·
   sentinel 0회. **red**: 파생을 지우고 지역 Map으로 되돌리면 resume이 재점프해 호출 > 0.
2. `[B-49] 사람이 Decision을 고치면 resume이 LLM 0회로 종결하고 출처가 영수증에 남는다` — 소진 실패
   후 decider 산출 파일의 `## Decision`을 '진행'으로 rewrite → resume → completed · sentinel 1회 ·
   decider 호출 0회 · 마지막 entry `{outcome:"proceed", decision_source:"restored_artifact"}` ·
   `cleared_idea_sha256 === sha256(아이디어 snapshot)`. **red**: decision_source 기록을 지우면(출처
   무표시 = 현행 위조 상태로 회귀) 빨감.
3. `[B-49] 종결 통지는 예산 소진 lap의 decider에게만 실린다` — 프롬프트 캡처 provider: lap 1 CEO
   프롬프트에 "되돌림 예산 소진 통지" 부재, 점프 후 lap 2 존재, 비decider step 부재. **red**: 통지
   배선 제거 또는 조건 오적용(모든 lap 주입 → lap 1 단정이 빨감 — additive 계약 감시).
4. `[B-49] decider가 이번 run에서 실행되면 decision_source가 없다 (additive)` — 정상 완주 run의
   proceed entry에 필드 부재. **red**: restored 판정 과잉 적용.
5. `[B-49] 같은 decider 게이트 2개 workflow는 실행 전 거부` — fixture workflow(신규 json 1개) →
   throw 단정. **red**: guard 삭제(예산 교차 차감이 조용히 성립).
6. (`pipeline.test.ts`) `[B-49] gate_jump_budget_exhausted 안내 분기` — 소진 실패를 pipeline 경로로
   유도하고 출력에 "되살아나지 않습니다" 문자열 + exit 1 단정. **red**: 분기 제거(무차별 resume 안내로
   회귀 — 거짓 안내).

**형태 추적 갱신 아님의 논증**: 기존 `:355-356`(소진), `:283`(kill), `:333`(proceed)의 deepEqual은
전부 decider가 이번 run에서 실행된 케이스라 새 필드가 출현하지 않는다 — 갱신 자체가 불필요하다.
`gateOutcomeLabel`의 기존 라벨 단정도 decision_source 부재 entry에서 바이트 동일.

## 8. 기각한 대안과 이유

1. **(2) 소진 시 진행/체크포인트 승격** — `:1265-1271`이 닫은 취약점의 재개방(§2에서 상술). (2)의
   정직한 형태는 (1)의 레버와 동치이므로 별도 채택 이유가 없다.
2. **새 durable 필드(예: `gate_budget_spent`)** — gate_jumps에서 파생 가능한 값의 중복 상태. 두 값이
   어긋나는 날이 온다(C-130 부류 — 지시하는 곳과 채점하는 곳의 분리).
3. **GateJumpEntry에 step_index 추가** — durable 형태 변경 + 구버전 entry(필드 없음) fallback
   이중화 + golden 재생성. 중복 decider guard(§5-c)가 새 필드 0으로 같은 안전을 fail closed로 준다.
4. **전용 gateNotice 프롬프트 파라미터** — runWorkflow→runAgent→provider.ts→promptParts 4파일
   배선(~12줄) 대비 revisionRequest 재사용은 0줄. 블록 라벨("🔁 비평 반영 수정 지시")이 통지 내용과
   어긋나는 것은 프롬프트 코스메틱이지 영수증이 아니다. live에서 모델 혼동이 실측되면 그때 승격.
5. **`--extend-gate-budget` 류 예산 연장 CLI** — 새 우회 표면 + 그 승인의 영수증 설계가 따로 필요.
   정당한 수요("한 번 더")는 사람 종결 판정·전액 지불 새 run 두 레버로 덮인다. 수요가 실측되면 C급
   등재 후 별도 슬라이스.
6. **모든 lap에 lap 번호 상시 주입** — 통지 없는 lap의 프롬프트 바이트가 바뀌어 additive 계약이
   깨진다(approvalSeed 바이트 동일성 부류). 소진 lap에만 주입한다.
7. **소진을 별도 status(예: stalled)로** — 새 상태는 전 소비자 전수 비용. failed + 사유 코드가 이미
   그 의미를 나른다(C-96 규율: 원인별 코드는 이미 분리돼 있다).
8. **absent/ambiguous에도 파생 예산 적용** — 그 사유들은 entry를 안 남기므로(§1 보완 ②) 자연히 적용
   밖이고, 그것이 옳다: 형식 오류 복구는 판정 반복이 아니다.

## 9. 남는 위험 · 이번에 닫지 않는 것

- **decision_source는 "복원 문서였다"까지만 증언한다** — 편집 주체(사람/스크립트/무편집)는 미증명.
  `last_failure.written`의 digest로 사후 편집을 관측할 수는 있으나 차단하지 않는다 — 차단하면 `:1217`
  복구 경로가 죽는다. 주체 서명이 필요해지면 별도 슬라이스.
- **run_state 손수 편집으로 gate_jumps를 지우면 예산이 부활한다** — C-7/C-131 부류의 기존 한계.
- **통지가 CEO 판정 분포를 실제로 바꾸는지 미증명** — offline 테스트는 주입 여부만 고정한다. live
  재실측 필요(B-42와 같은 부류). 통지의 목적은 분포 변경이 아니라 정보 대칭이므로, 바뀌지 않아도
  설계는 실패가 아니다(그때는 사람 레버가 종결한다).
- `ceo_decision_hold`·`ceo_decision_unmapped`의 안내 문구는 이번에 안 고친다.
- decider가 web_research agent인 workflow에는 통지가 실리지 않는다 — 현행 registry 해당 없음.
- critique_loop 내부 `--max-tokens` 미검사(C-125 R1-C에서 B급 등재)는 이 슬라이스가 닫지 않는다.
- mvp-planning·full-predev 게이트에도 동일 적용되지만 live 실측은 idea-validation뿐이다.
- workflows.json이 실패~resume 사이 편집되면 파생 예산의 max_jumps 기준이 바뀐 채 재개된다 — resume이
  workflow_id만 대조하는 기존 전 step 공통 한계.

## 10. 예상 diff 크기 + 런타임 비용

| 파일 | 추정 |
|---|---|
| `src/core/runWorkflow.ts` | +45 / −8 (파생 헬퍼·guard·통지·restoredIds·`...src` 4곳·타입·라벨) |
| `src/commands/run.ts` | +12 (+import 1) |
| `src/commands/pipeline.ts` | +14 (+import 1) |
| `src/core/runWorkflow.test.ts` | +170~200 (테스트 5건 + 캡처 provider) |
| `src/commands/pipeline.test.ts` | +25 |
| `tests/fixtures/workflows/*.json` (중복 decider fixture) | +12 (신규 1개) |
| **합계** | **약 270~310줄** (목표 300 근접 — 초과분은 전부 테스트) |

**LLM 호출 수 변화** (C-125 R1-C가 diff만 세고 호출 수를 빠뜨린 실수를 반복하지 않는다):

| 경로 | 현행 | 설계 후 |
|---|---|---|
| 완주 run(점프 0) | R1-C 기준 5~7회 | **동일** (프롬프트 바이트도 불변) |
| '검증' 1점프 run | 최악 13회(regen 시 30) | **동일 호출 수** + 최종 lap CEO 호출에 통지 ~150토큰 |
| 소진 실패 후 무편집 resume | **한 lap 전부 재실행**(5~8회, regen 시 ~16) × **반복 상한 없음** — live 실측 lap당 30.2분 · output 105k | **0회** (게이트 재판정만, 즉시 재실패) |
| 소진 실패 후 사람 종결 resume | 한 lap 재실행 후에야 종결 여부 판명 | **0회** (복원 문서 재판정으로 즉시 종결) |

---

# 리비전 1 — Codex 적대적 계획 리뷰 반영 (2026-08-27, 오케스트레이터 실물 검증 후)

Codex(gpt-5.6-sol, read-only) 판정은 **"승인 불가"**였다. finding을 **전부 인용된 file:line을 직접 열어
검증**했고 결과를 항목마다 적는다. **A 6건 중 5건 수용 · 1건 부분 수용**, B 3건 중 1건 수용(범위 축소)·2건 수용.

## R1-A [A · 수용 · §5-(j) 삭제] pipeline의 "폐기 후 restart" 탈출구는 **동작하지 않는다**

**검증**: 참이다. `pipeline.test.ts:311`이 정확히 이것을 고정한다 —
`[B-41/P6] 폐기 판정 → killed 종료 · restart 후 killed run_state는 화해(모델 호출 0)`, 반환 코드
`pipeline_killed_reconciled`. restart는 `pipeline_state.json`만 갈고 killed `run_state.json`을 남기며,
다음 `next`가 그것을 화해시켜 즉시 killed로 되돌린다(`pipeline.ts:329`).

**설계가 적으려던 안내는 거짓이었다** — 그리고 그것은 이 설계가 §5-(i,j)에서 스스로 인용한
C-138/④(거짓 안내)와 **같은 부류**다. 계획 리뷰가 없었으면 같은 실수를 반복할 뻔했다.

## R1-B [A · 수용 · §5-(j) 삭제] Decision 수정 레버는 **파이프라인 2단계 이후 drift로 막힌다**

**검증**: 참이다. `docs/06_CEO_DECISION.md`는 1단계 checkpoint에서 **이미 승인된 산출물**이고,
`pipeline.ts:363-377`의 사전 검증은 승인 digest 전수 대조에 `last_failure.written`만 예외로 준다.
사람이 그 파일을 고치면 승인 바이트와도 written 바이트와도 달라 `pipeline_artifact_drift`로 막힌다.

**Codex가 더 나쁜 반례를 찾았다**: 소진 게이트에서의 무편집 resume은 agent를 하나도 실행하지 않아
`savedFiles === []`이고, 실패 분기가 `last_failure.written`을 **빈 배열로 덮는다**(`pipeline.ts:471-487`).
따라서 2회차 resume부터는 게이트에 닿기도 전에 drift로 막힌다 — 설계의 "resume마다 failed entry
한 줄만 는다"도 일반적으로 거짓이다.

**이것은 이미 `B-47`(`pipeline_artifact_drift` 막다른 길)로 등재된 결함이다.** B-49가 만드는 것이
아니지만, B-49가 그 위에 안내를 얹으면 거짓이 된다.

**계약**: **§5-(j) pipeline 안내 분기를 이번 슬라이스에서 통째로 뺀다.** 검증할 수 없는 경로에
안내를 쓰지 않는 것이 이 레포의 규율이다. 기존 일반 안내는 그대로 둔다(B-49가 악화시키지 않는다).
파이프라인 경로의 게이트 소진 복구는 **`B-47`과 같은 슬라이스에서** 다룬다 — 대장에 그렇게 적는다.

## R1-C [A · 수용 · §5-(b) 수정] 레거시 gate receipt에서 예산이 한 번 부활한다

**검증**: **부분 정정.** `GateJumpEntry.outcome`은 타입상 **필수 필드**다(`runWorkflow.ts:99`) —
Codex의 "구버전 entry를 명시적으로 지원한다"는 서술은 정확하지 않다. 그 자리 주석(B-40/A-2)은
*소비자가 `jumped_to`로 결과를 추론하던 과거*를 기록한 것이다.

**그러나 결론은 맞다**: 타입은 런타임 검증이 아니다. `lockFieldsProblem`(`:319`)은 gate_jumps를 보지
않으므로, `outcome` 필드가 생기기 **전에 쓰인 디스크 상의 run_state**를 resume하면 entry에 `outcome`이
없고 파생 예산이 그것을 0으로 세어 **비싼 lap 하나가 다시 열린다**.

**계약**: 파생 조건을 넓힌다 — 비용 대비 10자다.
```ts
const isJump = (g: GateJumpEntry) => g.outcome === "jump" || (g.outcome === undefined && g.jumped_to !== null);
```
**필수 테스트 추가**: `outcome` 없는 레거시 entry를 담은 prior state로 resume → 예산이 소진된 것으로
읽힌다. red: `outcome === "jump"`만 세도록 되돌리면 재점프한다.

## R1-D [A · 수용(문구) · §2·§5-(f,g) 정정] `decision_source`는 **판정 저자를 증명하지 않는다**

**검증**: 참이다. `restoredIds`가 증명하는 것은 "이번 **invocation**에서 decider가 재실행되지 않았고
게이트가 디스크 바이트를 읽었다"까지다. **무편집 resume의 원래 모델 출력에도 똑같이 붙는다.**
또 resume은 `started_at`을 이어받으므로(`:723`) "이번 run 미실행"이라는 문구도 부정확하다.

설계 §9는 이 한계를 정직하게 적었는데 §2·§5-(f)는 "판정 저자 사실을 나른다"고 **과대주장했다** —
같은 문서 안에서 앞뒤가 어긋났다. 과대주장은 이 레포에서 A급이다.

**계약**: 필드는 유지하되(값은 실재한다) **주장을 낮춘다**. 타입 주석과 라벨을 고친다:
- 라벨: `판정 출처: 복원 문서(이번 invocation에서 decider 미실행)`
- 타입 주석: "이것은 **판정 저자의 증명이 아니다** — 사람·스크립트·이전 모델 출력을 구분하지 못한다.
  증언하는 것은 '이번 invocation이 decider를 실행하지 않고 디스크 바이트로 판정했다'뿐이다."
- §2의 "구분되는 기록은 위조가 아니다"는 **"모델이 이번에 판정한 것이 아님을 표시한다"**로 좁힌다.

**Codex가 확인해 준 것**: 판별 로직 자체(`persistFinalOutcome`에서 Set 삭제)는 게이트 재점프 재실행 ·
더 앞 step부터의 resume · critique revise 덮어쓰기 **세 경우 모두 정확**하다(`:877`).

## R1-E [A · 수용 · §10 표 전면 교체] live 비용과 resume 호출 수가 과대계상됐다

**검증**: 참이다. `projects/commrep/outputs/run_state.json`의 `step_timings`를 직접 읽었다:

| | 값 |
|---|---|
| run 전체 | 05:56:26 → 06:26:39 = **30.2분** · output **105,355** (2 lap 합계) |
| **replay lap 1개** | 06:12:38 → 06:26:39 = **14.0분** (research 4.4 + pm 4.6 + red_team 2.6 + ceo 2.5) |
| replay lap 호출 수 | **4회**(C-125 이전) — 설계의 "5~8"은 근거 없음 |

`30.2분 · 105k`는 **lap당이 아니라 run 전체**다. (로드맵·CONTEXT_SUMMARY의 수치는 run 전체를 말한
것이므로 **그쪽은 정확하다** — 틀린 것은 설계의 lap 귀속이다.)

**더 중요한 정정**: 설계 §10 표의 "소진 실패 후 **사람 종결** resume: 현행 = 한 lap 재실행 후 판명"은
**거짓**이다. 사람이 Decision을 종결 판정으로 고치면 **현행도 이미 LLM 0회**다(게이트부터 resume →
복원 문서 즉시 파싱 → '진행'/'보류'/'폐기'는 점프가 아니므로 예산과 무관). 즉 **B-49가 사람 레버를
싸게 만드는 것이 아니다 — 그 레버는 이미 싸다.**

**B-49의 실제 이득은 하나로 좁혀진다**: **무편집 resume이 예산을 부활시켜 replay lap을 무한히 반복할
수 있던 것을 0회로 만든다.** C-125 이후 그 lap은 최악 6호출(regen 1이면 12, external이면 14)이다.
판정 절에는 이 좁힌 주장만 싣는다.

## R1-F [A · 수용 · §6 표 정정] `summary`가 `failed_reason`을 **소비한다**

**검증**: 참이다. 설계 §6은 "`summary` 변경 불요 — gate_jumps/failed_reason 미소비 · grep 0건"이라고
적었는데 `src/core/summary.ts:94`가 `failed_reason`과 resume 안내를 **렌더한다**. 전수 표가 틀렸다.

**계약**: summary는 `failed_reason`을 **그대로 출력할 뿐 사유별 안내를 만들지 않으므로** 코드 변경은
불요다 — 그러나 **표의 근거 문장을 정정**한다("미소비"가 아니라 "사유 문자열을 그대로 싣고 사유별
분기가 없다"). 사유별 안내를 summary에 넣는 것은 R1-B로 pipeline 분기를 뺀 이상 범위 밖이다.

## R1-G [B · 수용 · §5-(h) 이번 슬라이스에서 **뺀다**] 종결 통지의 '중립'은 미증명

**검증**: Codex의 배선 분석은 맞다 — `revisionRequest` seam은 평문 step에서도 동작하고(`:792`,
`runAgent.ts:55`), 미주입 경로의 프롬프트 바이트는 불변이며 mock은 이것을 읽지 않으므로 golden·
결정성은 안 깨진다. **즉 통지는 기술적으로 안전하다.**

문제는 다른 데 있다: 통지는 "'검증'/'축소'면 run이 멈춘다"는 **결과**를 알려주므로 `'진행'` 쪽으로
압력을 줄 수 있고, `'진행'`은 곧 `cleared_idea_sha256` 발급이다. **중립이라는 증거가 없다.**

**오케스트레이터 판단**: 뺀다. 근거 셋 — ⓐ **종료 보장은 통지 없이도 성립한다**(파생 예산만으로
충분하다). ⓑ 효과는 offline으로 증명 불가하고 이 세션에 live 재측정 예산이 없다. ⓒ 값이 불확실한
프롬프트 변경이 **영수증 발급 판정 분포**를 건드리는 것은 이 레포가 A급으로 다루는 축이다.
**대장 B급 등재** — 다음 live run에서 lap 2 CEO의 판정 분포를 재고, 정보 대칭이 실제로 필요하다는
근거가 나오면 그때 중립 문안으로 넣는다. (설계 §2의 "정보 대칭" 논증 자체는 기각하지 않는다 —
lap 2 CEO가 lap 1과 구분되는 입력을 하나도 안 받는다는 관찰은 참이고 여전히 값지다.)

## R1-H [B · 수용 · §5-(c) 위치 이동] guard가 `run_start` 이후 throw하면 progress가 샌다

**검증**: 참이다. 설계가 지정한 위치(main 루프 직전)는 `run_start` 방출 뒤이고 `run_end`를 보장하는
`try/finally` **바깥**이다(`:1131`, `:1571`). invalid workflow가 renderer의 spinner·stderr를 안 치운다.

**계약**: guard를 **workflow lookup 직후**(`run_start` 방출 전, 모델 호출 0회 지점)로 옮긴다 —
`approval_approver_missing` preflight(`:540` 부근)와 같은 자리다. 그 자리가 이 레포의 "실행 전 거부"
관용구다.

## R1-I [B · 수용(기록만)] workflow 정의가 resume 사이 바뀌면 decider 결박이 깨진다

**검증**: 참이다. resume은 `workflow_id`만 대조한다(`:690`). 같은 id에서 decider 이름이 바뀌면 옛
jump가 안 보여 예산이 부활하고, 다른 게이트가 그 이름을 얻으면 옛 예산을 잘못 부담한다.
설계 §9는 `max_jumps` 변경만 적었다. **§9에 decider 개명 축을 추가**하고 대장 C급 등재.
(workflow digest 결박은 전 step 공통 문제라 이 슬라이스 범위 밖.)

## 확정 범위 (리비전 후)

**넣는다**: 파생 예산(R1-C 레거시 포함) · 중복 decider guard(R1-H 위치) · `decision_source`
영수증(R1-D 문구) · `run.ts` 사유별 안내(비파이프라인 경로 — 검증 가능) · 테스트(레거시 회귀 추가).
**뺀다**: 종결 통지(R1-G → 대장 B) · pipeline 안내 분기(R1-B → `B-47`과 같은 슬라이스).
**예상 diff**: 약 200~240줄(설계 270~310에서 축소).
