# B-52 설계 — 앞 단계의 판정이 현 단계 판정으로 재생되는 구멍

> 작성 2026-08-30 (M14 · 설계+구현 세션, 격리 worktree). 기준 커밋 `f48e710`.
> 아래 file:line은 전부 **이 세션에서 직접 열어 확인**했고, 핵심 주장 3개는 **실행으로 재현**했다
> (§1.6 재현 로그). B-50(`ceo_decision_verify`)은 **이 worktree 베이스에 없다** — 병렬 브랜치다.
> 이 설계는 `runWorkflow.ts`를 건드리지 않으므로 B-50과 파일 소유권이 겹치지 않는다.

---

## 1. 실측한 현행 (file:line)

### 1.1 pipeline resume의 사전 drift 검증 — 구멍의 위치

`src/commands/pipeline.ts:361-377`

```ts
// 승인 바이트 사전 검증. **fresh는 예외 없는 전수 검증**이고, resume만 `last_failure.written`
// digest와 일치하는 경로에 예외를 준다(그 attempt가 정당하게 덮은 것). 어느 쪽도 아니면 손댄 것이다.
const written = new Map((resume && state.last_failure ? state.last_failure.written : []).map((w) => [w.path, w]));
for (const approved of approvedDigests(state).values()) {
  const accept: ArtifactEntry[] = [approved];
  const w = written.get(approved.path);
  if (w) accept.push(w);                                  // ← **OR**. 여기가 구멍이다.
  if (!accept.some((a) => driftProblem(root, [a]) === null)) { ... }
}
```

주석은 "resume만 `written` digest와 **일치하는 경로에 예외를 준다**"라고 선언하지만, 코드는 예외를
**교체(replacement)** 가 아니라 **추가(addition)** 로 구현했다. 그래서 이 단계가 이미 덮어쓴 경로에서
**앞 단계의 승인 바이트가 여전히 유효한 현 단계 내용으로 통과한다**. 주석과 코드가 어긋난 자리다.

### 1.2 `06_CEO_DECISION.md`는 1·2단계가 **같은 경로에 다시 쓴다**

- `registry/agent_registry.json` — `founder_ceo` → `default_output: docs/06_CEO_DECISION.md` (유일 경로)
- `registry/workflows.json` — `idea-validation`(1단계)과 `mvp-planning`(2단계)이 **둘 다**
  `founder_ceo` step + `gate{decider: founder_ceo, kill:["폐기"]}`로 끝난다.
- `src/core/pipeline.ts:681-698` `runStateSources` — 승인 manifest는 `completed_steps` 전수이므로
  1단계 checkpoint의 `artifacts`에 `docs/06_CEO_DECISION.md`가 **반드시** 들어간다.
- `src/core/pipeline.ts:776-784` `approvedDigests` — 그래서 2단계 시점 `approvedDigests`에
  `docs/06_CEO_DECISION.md → (1단계 바이트)`가 들어 있다.

### 1.3 게이트는 복원 바이트를 **재실행 없이** 판정으로 읽는다

`src/core/runWorkflow.ts:766-774` (resume 복원 루프)

```ts
const md = readFileSync(abs, "utf8");
findings.set(id, `${id}: ${extractMainJudgment(md)}`);
lastMarkdown.set(id, md);
restoredIds.add(id); // [B-49] 이 바이트는 이번 invocation의 모델 출력이 아니다
```

`:1291` `const deciderMd = lastMarkdown.get(decider) ?? "";` → `:1293` `extractCeoDecision(deciderMd)`
→ `:1352` `if (decision === "진행")` → `:1359` `cleared_idea_sha256 = idea.sha256`.

`:1312`의 B-49 영수증(`decision_source: "restored_artifact"`)은 **기록만 한다 — 거부하지 않는다**.
타입 주석(`:110-117`)이 그 한계를 이미 명시해 뒀다: "판정 저자의 증명이 아니다".

### 1.4 파이프라인 밖 경로는 이미 닫혀 있다

- `src/core/pipeline.ts:879-887` — 활성 파이프라인에서 일반 `harness run`(및 `--resume`)은
  `pipeline_run_reserved`로 전면 거부. 즉 **활성 파이프라인에서 게이트에 닿는 문은 `pipeline next` 하나뿐**이다.
- `src/commands/pipeline.ts:483` — `last_failure.written = digestArtifacts(root, result.savedFiles, …)`,
  즉 그 attempt가 실제로 쓴 파일들.

### 1.5 B-50/B-49 사람 레버의 **실제 사정거리** (여기가 이 설계의 분기점)

킥오프는 "B-50 복구 경로가 깨지면 안 된다"를 제약으로 줬다. 실측 결과 그 경로의 사정거리는
**단계에 따라 다르다**:

| 위치 | `approvedDigests`에 `06_CEO_DECISION.md`가 있나 | 사람이 `## Decision`을 고치고 resume |
|---|---|---|
| 1단계 `idea-validation` | **없다** (승인 checkpoint 0개) | **된다** — 루프가 0회 도는다 |
| 2·3단계 | **있다** (1단계 승인본) | **오늘 이미 안 된다** — `pipeline_artifact_drift` |
| 파이프라인 밖 `harness run --resume` | 해당 없음 | **된다** — drift 검증 자체가 없다 |

이것은 B-49 설계 §1 "보완 ③"이 이미 문서로 적어 둔 사실이고(`docs/handoff/B49_DESIGN.md`),
이 세션에서 **코드 실행으로 재확인**했다(§1.6-(a)).

따라서 2단계의 실상은 이렇다:

> **파이프라인은 정직한 편집(사람이 Decision을 고침)은 거부하고, 부정직한 재생(앞 단계 승인본을
> 되돌려 놓음)은 통과시킨다.**

이 비대칭이 B-52의 본체다. "권한이 없는 자가 권한을 얻는다"가 아니라 **"권한 경계가 반대로 걸려 있다"** 이다.

### 1.6 재현 로그 (mock provider · 실제 LLM 0회)

`_b52repro.test.ts`(임시, 커밋하지 않음)로 1단계 승인 → 2단계 CEO '보류' → 게이트 실패까지 만든 뒤:

```
failed_reason = ceo_decision_hold | resume_from = 7 | completed: pm,ux_ui,design,tech_lead,red_team,founder_ceo
written = docs/02_PRD.md, docs/03_UX_FLOW.md, docs/DESIGN.md, docs/tokens.json,
          docs/04_TECH_PLAN.md, docs/05_RED_TEAM.md, docs/06_CEO_DECISION.md
(a) B-50 사람 편집 resume code = pipeline_artifact_drift | 모델 호출 0
(b) 1단계 승인본 복원 후 resume code = pipeline_awaiting_approval | founder_ceo 호출 0 회
    run status = completed
    gate_jumps last = {"decider":"founder_ceo","decision":"진행","jumped_to":null,
                       "outcome":"proceed","decision_source":"restored_artifact"}
    cleared_idea_sha256 = c535dc58…843a      ← B-40 폐기 잠금 해제까지 발급됐다
```

**(b)가 구멍이다**: 2단계 CEO의 실제 판정은 '보류'인데, 1단계의 '진행'이 2단계 판정으로 채택되고
run이 `completed`가 되고 파이프라인이 확인 대기까지 올라갔다. **모델 호출 0회**로.
**(a)는 이 구멍이 권한 상승이 아니라 권한 역전임을 증명한다.**

**영향 반경**: `06_CEO_DECISION.md`만이 아니다. 같은 OR은 이 단계가 덮어쓴 **모든 승인 경로**에
적용된다(위 `written` 목록의 `docs/02_PRD.md` 등). 판정 문서가 가장 나쁜 사례일 뿐이다.

---

## 2. 설계

### 2.1 규칙 한 줄

> **이 단계의 실패 attempt가 덮은 경로는, 그 attempt가 쓴 바이트만이 정본이다.**
> 앞 단계의 승인 바이트는 그 경로의 **다른 단계 산출물**이므로 현 단계 내용으로 설 수 없다.

`accept`를 OR(추가)에서 교체로 바꾼다 — 주석이 원래 선언하던 그대로.

```ts
const w = written.get(approved.path);
// [B-52] `written`이 있으면 **그것만** 정본이다(추가가 아니라 교체).
const accept: ArtifactEntry[] = w ? [w] : [approved];
```

### 2.2 왜 여기가 root cause이고 게이트가 아닌가

게이트에서 "복원 바이트를 기록된 digest와 대조"하는 방향(킥오프의 유력안)은 **원리적으로 구분에
실패한다**. 두 경우를 나란히 두면:

| | 이번 run에서 decider 실행 | 게이트에서 실패 | 파일 바이트가 기록 digest와 다름 |
|---|---|---|---|
| 정당(B-50 사람 편집) | ○ | ○ | ○ |
| 부정(앞 단계 재생) | ○ (§1.6에서 '보류' 출력) | ○ | ○ |

**세 신호가 전부 같다.** 게이트가 가진 정보(문서 바이트 + `restoredIds` + `gate_jumps`)로는
"사람이 고친 이 run의 문서"와 "다른 단계의 문서"가 구분되지 않는다. B-50이 사람에게 **바이트로
판정을 쓸 권한**을 준 순간, 그 권한 안에서 "1단계 파일을 복사해 온다"는 "손으로 진행이라 친다"와
정보량이 동일해진다. 따라서 digest 대조를 게이트에 넣으면 **정당·부정 양쪽을 함께 닫는다** —
킥오프가 "crux"라고 지목한 그 문제이고, 답은 "게이트에서 풀지 않는다"이다.

권한 경계는 게이트가 아니라 **파이프라인의 승인 바이트 perimeter**다. 파이프라인 밖에서는 사람이
곧 권한자이고 B-50이 그것을 명문화했다(`runWorkflow.ts:1287` 주석). 파이프라인 안에서 사람의 권한은
**checkpoint를 통해서만** 행사된다. 그래서 고칠 것은 perimeter의 판정 규칙 한 줄이다.

### 2.3 왜 B-50 복구 경로가 안 깨지는가 — 세 경로 전수

1. **1단계(`idea-validation`)**: `approvedDigests(state)`가 비어 있어 `for` 루프가 **0회** 돈다.
   `accept`가 만들어지지도 않는다. 바뀐 코드가 실행되지 않으므로 동작이 정의상 불변. §1.5 표 1행.
   → **B-50 레버가 살아 있는 유일한 파이프라인 단계이고, 이 diff는 그 자리를 지나지 않는다.**
   (회귀 테스트로 못 박는다 — §4 테스트 ②)
2. **파이프라인 밖 `harness run --resume`**: `commands/pipeline.ts`를 아예 지나지 않는다.
   `runWorkflow.ts` 미변경. → 불변.
3. **2·3단계**: 오늘 이미 `pipeline_artifact_drift`로 닫혀 있다(§1.6-(a) 실측). 이 diff는
   그 자리를 **더 닫지도 열지도 않는다** — 사람이 편집한 바이트는 변경 전에도 후에도
   `approved`·`written` 어느 쪽과도 다르므로 같은 거부다.

**즉 이 변경으로 새로 거부되는 것은 정확히 하나다: "이 단계가 덮은 경로가, 앞 단계 승인 바이트와
정확히 일치하는 상태" — 즉 재생 그 자체.**

### 2.4 거부 메시지

기존 문구는 "승인된 산출물이 승인 시점 바이트와 다릅니다"인데, B-52 케이스는 정반대로
**승인 시점 바이트와 같아서** 거부된다. 같은 문구를 내면 사람이 진단할 수 없다. 사유 코드는
`pipeline_artifact_drift`를 유지하고(소비자·테스트 계약), **메시지만** 케이스별로 가른다.

기존 문구가 안내하는 `harness pipeline restart`는 `awaiting_run`에서 `pipeline_active`로 거부되므로
(`commands/pipeline.ts` `restartPipeline`, B-49 설계 보완 ④) B-52 문구에서는 그 거짓 안내를 반복하지
않고 **실제로 남아 있는 행동**만 적는다.

---

## 3. 상태·소비자 전수

**새 durable 필드 0개.** `run_state.json`·`pipeline_state.json` 스키마 불변 →
기존 6개 live 프로젝트 상태 파일 전부 그대로 읽힌다. 하위 호환 논증이 필요 없다(변경할 것이 없다).

`accept` 판정의 입력이 되는 두 값의 소비자를 전수했다:

| 값 | 정의 위치 | 다른 소비자 | 이 변경의 영향 |
|---|---|---|---|
| `approvedDigests(state)` | `core/pipeline.ts:776` | `effectiveDigests`(approve `:664`) · `pipelineGateStatus` `:876` · `:922` | **없다** — 함수 미변경. resume 사전 검증의 `accept` 조립만 바뀐다 |
| `last_failure.written` | `commands/pipeline.ts:483` 기록 | **이 사전 검증 한 곳뿐** (grep 전수 확인) | 의미가 "추가 허용"에서 "그 경로의 정본"으로 좁아진다 — 원 주석의 선언과 일치 |
| `restoredIds` / `decision_source` | `core/runWorkflow.ts:653,1312` | `gateOutcomeLabel` `:142` | **없다** — 미변경 |

`pipelineGateStatus`(`core/pipeline.ts:876`, `:922`)는 `approvedDigests` 전수를 예외 없이 검증한다
(resume 예외가 없다) — 그쪽은 원래부터 이 구멍이 없다. 확인만 하고 손대지 않는다.

---

## 4. 테스트 계획 (red condition 명시)

전부 mock provider, 실제 LLM 0회. `src/commands/pipeline.test.ts`에 추가한다(같은 파일의
P8a/P8b와 같은 계열이고 헬퍼를 그대로 쓴다).

**① `[B-52] 적대적 재현` — 이번 구멍 본체**
1단계 승인 → 2단계 CEO '보류' → 게이트 실패 → `docs/06_CEO_DECISION.md`를 **1단계 승인본 바이트로
되돌림** → `pipeline next`.
- 단정: `pipeline_artifact_drift` · exit 1 · **모델 호출 0** · `pipeline_state` 바이트 불변 ·
  `run_state.status`가 여전히 `failed`(=`completed`로 승격되지 않았다) ·
  `gate_jumps`에 `decision:"진행"` entry가 **추가되지 않았다**.
- **red condition**: `accept`를 `w ? [w] : [approved]`에서 원래의 OR로 되돌리면
  `pipeline_awaiting_approval` + run `completed`가 되어 단정이 빨감.
  (§1.6-(b)가 이미 그 빨감을 실측했다 — 이 테스트는 그 로그의 코드화다.)

**② `[B-52] 1단계 B-50 레버 회귀` — 닫으면 안 되는 문**
1단계에서 CEO '보류'로 게이트 실패 → 사람이 `## Decision`을 '진행'으로 고침 → `pipeline next`.
- 단정: `pipeline_awaiting_approval` · `founder_ceo` 재실행 0회 ·
  `gate_jumps` 마지막 entry가 `outcome:"proceed"` + `decision_source:"restored_artifact"`.
- **red condition**: 사전 검증을 `approvedDigests` 전수가 아니라 "`written` 전수"로 넓히면
  (§5 기각안 (다)) 1단계 편집이 drift로 막혀 빨감. 즉 이 테스트는 **과잉 차단을 잡는 감시자**다.

**③ 기존 P8b ⓐ가 계속 초록** — "written digest와 일치하는 경로는 예외로 통과"(정당한 재작성).
새 테스트를 쓰지 않는다. 이미 있는 단정이 곧 회귀 감시다.

### 4.1 실측한 mutation 결과 (구현 후 채움)

| # | 변형 (정확한 역치환) | ① 재생 거부 | ② 1단계 레버 | 기존 P8b |
|---|---|---|---|---|
| M1 | `accept = w ? [w] : [approved]` → `w ? [approved, w] : [approved]` (원래의 OR) | **RED** | 초록 | 초록 |
| M2 | `const replay = w !== undefined && …` → `const replay: boolean = false` | **RED** | 초록 | 초록 |
| M3 | 루프를 `written` 전수로 확대(`new Map([...approvedDigests(state), ...written])`) | **RED** | **RED** | 초록 |
| M4 | `accept = [approved]` (written 예외 완전 제거) | **RED**(대조군) | 초록 | **RED** |

**M1에서 ①의 단정별 독립 검증** — 임시 테스트로 순서를 바꿔가며 하나씩 확인했다:

| 단정 | M1에서 |
|---|---|
| `pipeline_state` 바이트 불변 | RED |
| `run_state.status === "failed"` | RED |
| `gate_jumps.length` 불변 | RED |
| `gate_jumps.at(-1).decision === "보류"` | RED |
| 거부 메시지 문구(`앞 단계 승인본…`) | RED (M2에서도 RED) |
| **`guard.calls === 0`** | **GREEN — 처음부터 통과했다** |

**`guard.calls === 0`은 이 구멍을 구분하지 못한다.** resume이 게이트 인덱스에서 재개하므로
**원본도 변종도 모델 호출이 0이다** — 재생본을 읽는 것은 provider가 아니라 게이트다.
P8a가 "다른 원인과 섞인다"로, P8d가 "공허한 단정"으로 남긴 것과 같은 계열이다.
지우지 않고 **주석으로 그 사실을 못 박아** 남겼다(별개의 참인 성질이고, 미래에 decider를 재실행하게
바뀌면 그때는 구분한다). 구분하는 단정은 위 네 개다.

---

## 5. 기각한 대안

**(가) decider 출력 digest를 `run_state`에 durable로 기록하고 게이트에서 대조 (킥오프 유력안)**
기각. §2.2의 표대로 **정당/부정을 구분하지 못한다** — 사람이 편집한 바이트도 기록 digest와 다르다.
넣으면 B-50 복구 경로를 함께 닫고, 안 넣으면(경고만) 거부 능력이 0이다. 게다가 새 durable 필드가
생긴다. 얻는 정보 "복원 문서가 편집되었는가"는 B-49의 `decision_source`가 이미 담는 것보다
한 칸 세밀할 뿐, **차단 근거가 되지 못한다**.

**(나) 게이트에서 `restoredIds.has(decider)`면 무조건 거부**
기각. B-50 복구 경로와 B-49 레버를 정면으로 삭제한다. 킥오프가 명시적으로 금지한 방향.

**(다) resume 사전 검증을 `written` 전수로 확대** (승인 안 된 경로까지 결박)
기각. `mvp-planning`의 디자인 승인 게이트 문구가 **"변경은 DESIGN.md/tokens.json에 역반영한 뒤 재개"**
라고 사람에게 직접 지시한다(`registry/workflows.json`). `docs/DESIGN.md`는 2단계 시점에 미승인이라
`approvedDigests`에 없고 `written`에는 있다 — 전수로 넓히면 그 계약된 손편집이 drift로 막힌다.
**미승인 바이트는 아직 결박 대상이 아니다**가 이 파이프라인의 모델이고, 그 바이트는 승인 시점에
사람이 통째로 검토한다. B-52는 "승인된 바이트가 잘못된 단계에서 재사용된다"는 문제이지
"미승인 바이트가 자유롭다"는 문제가 아니다.

**(라) `founder_ceo` 문서만 특별 취급 (경로 하드코딩)**
기각. 같은 OR이 이 단계가 덮은 **모든 승인 경로**에 적용된다(§1.6의 `written` 목록). 판정 문서만
막으면 `02_PRD.md` 재생은 남고, 다음 사람이 "이건 닫힌 줄 알았다"를 다시 밟는다. 규칙은 경로에
중립이어야 한다 — 그리고 그쪽이 diff도 더 작다.

**(마) 단계 식별자를 문서 본문에 스탬프**
기각. 모델이 쓰는 바이트를 신뢰 근거로 삼는 설계이고(모델은 스탬프를 빠뜨리거나 베낀다),
사람 편집 경로가 스탬프를 보존해야 하는 새 계약이 생긴다. 문서 포맷 변경 = 모든 agent 템플릿 변경.

---

## 6. 남는 위험 (닫지 않았다 — 대장 후보)

1. **미승인 중간 산출물은 resume 사이에 결박되지 않는다.** §5-(다)의 의도된 결과다. 2단계가 쓴
   `docs/04_TECH_PLAN.md`를 게이트 실패 후 임의로 바꿔 resume해도 drift가 없다. 그 바이트는
   승인 시점에 사람이 본다(그것이 checkpoint의 존재 이유). **의도된 모델이지 닫힌 구멍이 아니다.**
2. **2회 이상 연속 resume에서 앞 attempt의 재작성이 drift로 잡힌다 (기존 결함, 이 diff와 무관).**
   `last_failure.written`은 실패마다 **덮어써진다**(`commands/pipeline.ts:483`). attempt1이
   `02_PRD.md`를 덮고 attempt2가 게이트에서 실패하면 `written₂`에 `02_PRD.md`가 없어,
   3번째 `next`는 `accept=[approved(1단계)]`로 판정해 **거부한다**. 변경 전후 동일 동작
   (`w`가 없으면 두 코드가 같은 배열을 만든다). 방향은 fail closed이나 **사용성 결함**이고,
   `awaiting_run`에서는 `restart`도 막혀 있어 탈출구가 좁다. **이 세션에서 실측하지 않았다
   (코드 독해 기반 추론) — 재현 전까지 미증명으로 남긴다.**
3. **게이트는 여전히 복원 바이트로 판정한다.** 그것은 B-50/B-49의 계약이고 파이프라인 밖에서는
   사람이 권한자다. B-49의 `decision_source` 영수증이 그 사실을 남기는 것이 현재의 방어선이며,
   §2.2대로 **바이트만으로 저자를 증명하는 방법은 없다**.

---

## 7. diff 크기

| 파일 | 성격 | 실측 |
|---|---|---|
| `src/commands/pipeline.ts` | `accept` 조립 1줄 교체 + 케이스별 거부 문구 + 주석 | +31 / −6 |
| `src/commands/pipeline.test.ts` | 테스트 2개 | +86 / −0 |
| `dist/commands/pipeline.js` | 빌드 산출물(레포가 추적한다) | +32 / −6 |
| `docs/handoff/B52_DESIGN.md` | 이 문서 | 신규 |

**동작을 바꾸는 실코드는 한 줄이다**: `accept = [approved]; if (w) accept.push(w)` → `accept = w ? [w] : [approved]`.
나머지는 거부 문구 분기와 주석·테스트다.

---

## 8. 검증 실측 (이 worktree, base `f48e710`)

| | base | 변경 후 |
|---|---|---|
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run test:exec` | tests **649** | tests **649** (변화 없음 — exec 테스트 미추가) |
| `npm run test:core` | tests **665** / fail 0 | tests **667** / fail 0 (**+2, 순증만**) |
| `bash scripts/acceptance.sh` | PASS 270 / FAIL 2 | PASS 270 / FAIL 2 (**동일**) |

**킥오프가 준 기대치(`test:core` 672 · acceptance 272)와의 차이**: acceptance 272는 총 검사 수
(270+2)로 일치한다. `test:core`는 이 worktree base에서 **665**로 실측된다 — 킥오프 수치는 B-50이
얹힌 다른 base에서 잰 것으로 보인다(`ceo_decision_verify`가 이 worktree에 없다, §머리말).

**미해결 실패 2건은 base에서도 같다**: acceptance의 `M10 T1·T2 offline acceptance` 2건, exec의
`[M10-T1] SIGKILL 11경계`. 손대지 않은 base에서 그대로 재현했고 파이프라인 코드와 무관하다.

**환경 flakiness 주의(측정으로 확인)**: `src/tools/`의 마감시간 민감 테스트(M3a canary server ·
M3c-0 discovery · M3c-3a SIGINT/SIGTERM 3초 · M3d.2 중첩 SIGKILL)가 머신 부하에 따라 산발적으로
빨감이 된다. **매번 다른 테스트가 하나씩** 실패하는 형태다. base/변경본을 **번갈아** 돌려 통제했고
(base 4회 · 변경본 마지막 3회 연속 전부 초록), 새 테스트가 원인이 아니라 **동시 실행 중인 다른 세션의
부하**가 원인이라고 판정했다. 이 판정은 상관관계 통제이지 인과 증명은 아니다 — **미증명으로 남긴다.**

**신규 durable 필드 0 · `runWorkflow.ts` 미변경 · 스키마 변경 0 · 신규 파일(코드) 0.**
