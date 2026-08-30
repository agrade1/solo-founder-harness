# B-50 설계 — '검증' 판정은 사람 검증 요청이다 (기계 되돌림이 아니다)

> 작성 2026-08-30 (Fable 설계 세션 · read-only). live 6-run에서 '검증' 4/4가 **사람 과제**를 뜻했는데
> 게이트는 research 재실행(0/4 유효)으로 응답해 교착한 문제의 어휘·상태 설계.
> **B-49(영수증 파생 예산)가 머지된 HEAD를 실측했다.** 이 세션에 b49-impl·c125-impl이 병행 중이므로
> 아래 file:line은 밀릴 수 있다 — 구현자는 심볼로 찾아라.

## 1. 실측한 현행 (file:line) — 전부 이 세션에서 직접 열었다

**킥오프가 준 사실 목록은 전건 재확인 일치 — 반박 0건.** 재확인 핵심 + 킥오프에 없던 **보완 7건**:

재확인한 것:

- `validate.ts:176` `CEO_DECISION_TOKENS = ["진행","축소","검증","보류","폐기"]` · `:177` 타입 ·
  `:217-233` `extractCeoDecision` — `{token}` 또는 `{error: "absent"|"ambiguous"}` fail closed. 일치.
- `runWorkflow.ts` 게이트 분기 `:1271-1377`. 순서: decider-미실행(:1284) → 파싱 fail closed(:1300) →
  **kill 먼저**(:1318) → jump(:1329-1345, `on[decision]`+예산) → '진행' 화이트리스트(:1352) →
  사유별 중단(:1364-1370: `gate_jump_target_missing` / `ceo_decision_hold`(보류) /
  `ceo_decision_unmapped` / `gate_jump_budget_exhausted`). 일치.
- `registry/workflows.json:12`(idea-validation)·`:53`(full-predev) `on:{"축소":"pm","검증":"research"}` ·
  `:26`(mvp-planning) `on:{"축소":"pm"}`만. 셋 다 `kill:["폐기"]`·`max_jumps:1`. 일치.
- `agents/founder_ceo_agent.md:528-537` 토큰 표 — `:532` `| 검증 | C | 개발 없이 먼저 검증 (앞 단계로 되돌림) |`. 일치.
- B-49: 예산은 영수증 파생 — `runWorkflow.ts:643-651` `isJump`(레거시 `outcome` 부재 fallback 포함) +
  `remainingJumps`. `gate_jumps`는 resume carry-forward(`:758`). 게이트 인덱스 resume은
  복원 문서로 **LLM 0회** 재판정(`:756-775` 복원 → `restoredIds` → `decision_source:"restored_artifact"`). 일치.

보완 (킥오프 목록에 없던 실측):

- **① 이 설계의 출발점**: CEO 프롬프트 §8-C(`founder_ceo_agent.md:272-287` 부근)는 **이미** '검증'을
  사람 과제로 정의한다 — "개발하지 않는다. 먼저 리서치, **인터뷰, 랜딩페이지, 수동 MVP**로 검증한다."
  기계 되돌림이라는 해석은 §14.0 표의 괄호("(앞 단계로 되돌림)")와 registry 라우팅에만 있다.
  즉 **모순은 CEO 등급 정의가 아니라 하네스의 응답 쪽에 있다** — live CEO들이 (b)를 뜻한 것은
  프롬프트를 잘 따른 결과다.
- **② 토큰↔registry 대조는 로더가 아니라 테스트다**: `registry.ts:119-121` `loadWorkflows`는 JSON을
  읽기만 하고 `on` 키를 **검증하지 않는다** (`validate.ts:168-174` 주석의 "로더 테스트가 red"는
  회귀 테스트 이야기다). 로더 수준 강제는 현재 0이다 — §8의 강제 위치 선택에 영향.
- **③** 런타임 프롬프트 주입(`providers/promptParts.ts:76-83`)은 토큰 **이름만** 싣는다(뜻 없음) —
  어휘 5개가 유지되면 코드 무변경.
- **④** mock CEO는 '진행' 고정(`mockProvider.ts:27`) · golden fixture의 gate entry도
  `decision:"진행"·outcome:"proceed"` — 이번 변경과 무접점.
- **⑤** `taskPrompt.ts:46-47`은 killed(ideaGateStatus)와 파이프라인 게이트만 막는다 — **failed run은
  지시문 생성을 막지 않는다**(`:104` "주의: 중단됨" 한 줄). 보류·예산소진도 오늘 같다(기존 동작).
- **⑥** pipeline resume의 사전 drift 검증(`commands/pipeline.ts:364-377`)은 **승인된 digest만** 결박
  — 1단계(idea-validation)는 approvedDigests가 비어 Decision 수정 레버가 살아 있고, 2단계 이후는
  앞 단계 승인이 decider 문서를 결박해 수정이 `pipeline_artifact_drift`로 막힌다(B-49 설계 R1-B가
  이미 증명·등재). `restartPipeline`은 awaiting_run을 `pipeline_active`로 거부(`:796-802` 부근).
- **⑦** '검증'을 실제로 쓰는 테스트 자산: `runWorkflow.test.ts:368-489`(B-49 예산 시나리오 driver),
  `:489-530` 5토큰×3workflow 전수, `:871`(mvp-planning 검증→unmapped 렌더),
  `tests/fixtures/workflows/research-adapter.json:20`(재진입 fixture),
  `kill-sentinel.json:38`(gate-dup-decider — **실행 전 거부되는 fixture라 런타임 무접점**).

## 2. Q1 — 어휘: **새 토큰 0개.** '검증'을 사람 검증으로 재결박하고, 기계 재조사 어휘는 만들지 않는다

**선택**: 토큰 5개 유지. `검증`의 뜻을 "사람이 직접 확인 — run은 멈추고 사람이 받는다"로 재결박한다.
`검증→research` 라우팅은 registry에서 제거하고, **게이트 코드가 '검증'을 `on` 조회 전에 가로챈다**(§8-a).

근거:

- **live 6-run의 언어 실측이 재결박을 지지한다**: '검증'을 낸 5개 run 중 4개(claimrep·sellercs·nuga·
  commrep)가 사람 과제를 뜻했고, research 재실행이 유효했던 경우는 0이다. 그리고 §1-①: CEO 프롬프트
  §8-C가 애초에 사람 과제(인터뷰·랜딩페이지·수동 MVP)로 정의하고 있다. **낱말은 이미 (b)를 뜻한다** —
  하네스만 (a)로 읽고 있었다.
- **옛 토큰 방출 = 새 의미 적중**(Q5와 연결): 재결박하면 변경 후 CEO가 습관대로 '검증'을 내도
  실측상 의도했던 경로(사람 검증 대기)에 떨어진다. 반대로 새 토큰(예: '실검증')을 만들고 '검증'을
  기계용으로 남기면, 모델이 옛 습관으로 '검증'을 낼 때마다 교착이 재생산된다 — 6 run이 그 증거다.
- **기계 재조사 토큰(예: '재조사')은 만들지 않는다 (YAGNI)**: 수요 실측 0/4. 필요가 실증되면 그때
  추가 비용은 registry 매핑 + 프롬프트 표 한 줄뿐이다 — jump 기계 장치(`on`)는 일반형이라 남는다.
- **`축소`는 같은 모호성이 없다**: "범위를 줄여 pm 재계획"은 기계가 실제로 할 수 있는 일이고
  (pm 재실행이 유의미한 새 산출을 낸다), live에서 오독 사례가 없다. 유지.
- **`보류`는 덮지 못한다**: 보류는 "백로그로 — 복귀 기대 없음"(`ceo_decision_hold`)이고, 검증은
  "싼 확인 과제 + 복귀 기대"다. 합치면 '2주짜리 확인 과제'가 백로그 무덤과 구분되지 않는다.

기각:

1. **새 토큰 추가('실검증'/'현장검증') + '검증'은 기계 유지** — 위 둘째 근거로 기각. 교착의 원인이던
   낱말 해석을 그대로 두고 모델의 습관 교정에 베팅하는 안이다.
2. **'검증' 삭제(토큰 4개)** — §8-C 등급 C가 실재하는 판단 범주다(6 run 중 5 run이 냈다). 삭제하면
   모델이 가장 자주 내는 판정이 `ambiguous`(파싱 실패)로 떨어진다 — 더 나쁜 정지.
3. **registry 제거만, 코드 가로채기 없음** — 매핑을 누가 다시 얹으면 교착이 조용히 부활한다.
   어휘의 뜻은 판정을 읽는 자리 한 곳에서 강제한다(§8-a) — 모든 호출자(실 registry + 테스트 fixture)를
   한 줄로 덮는다.

## 3. Q2 — 종료 상태: **`failed` + `failed_reason: "ceo_decision_verify"`** (새 status 없음)

**선택**: status는 `failed`, `resume_from` = 게이트 인덱스(현행 실패 경로 그대로), 사유 코드만 신설.
gate_jumps에는 기존 push가 `{outcome:"failed", reason:"ceo_decision_verify"}`를 남긴다.

옵션 비교:

| 옵션 | 판정 | 이유 |
|---|---|---|
| **`failed` + 신규 사유 코드** | **채택** | 이 레포에서 `failed`+`resume_from`은 이미 "오류"가 아니라 "**고치고 이어서 하라**"다 — `runWorkflow.ts:63-66` C-127 주석이 명문화했고 `user_rejected`(사람이 승인 거부 — 오류 아님)·`ceo_decision_hold`(판정 자체가 정지 — 오류 아님) 선례 둘이 이미 그 자리에 있다. resume 기계·pipeline `last_failure`·사유별 CLI 안내가 전부 공짜로 재사용된다. |
| 새 status (`awaiting_human_verify` 등) | 기각 | 소비자 전수 비용: `RunState.status` union(`runWorkflow.ts:188`), resume 수용 조건(`:747-748` `prior.status !== "failed"` throw — **새 status는 resume이 거부한다**), `run.ts` 분기 3곳, `pipeline.ts` resume 조건(`:353-358` `rs.status === "failed"`)·killed 화해·approve 대조, `summary.ts:84`(**switch가 `never` 소진 체크라 컴파일부터 깨진다**), obsidianExport, progress `run_end` 타입, golden fixture, 테스트 다수. 전부 고쳐도 얻는 것은 이름뿐이다. |
| `completed` 변형 | 기각 | fail open — completed는 task-prompt·handoff·pipeline 승인을 연다. "미검증 아이디어가 개발 착수로 넘어가는 것"이 이 게이트의 존재 이유고, 정확히 그 구멍을 B-40이 닫았다(`runWorkflow.ts:1346-1351` 주석). |

"검증은 오류가 아니다"라는 반론에 대한 답: 이 레포의 durable `failed`는 이미 "오류"가 아니라
"중단 — 사람 개입 필요·재개 가능"이다(위 선례 둘). 의미는 사유 코드가 나른다. exit code도 1로
기존 계열(재개 가능한 중단)과 일치한다 — killed(exit 0·terminal)와 구분 유지.

## 4. Q3 — 복귀 경로: **사람이 확인 후 decider 문서의 `## Decision`을 결과 판정으로 고치고 resume** (전 문장 코드 검증)

복귀 절차 (run 단독 경로 — live 6-run이 쓴 경로):

1. decider 문서(founder_ceo의 `default_output` — `registry/agent_registry.json:85-89`,
   `docs/06_CEO_DECISION.md`)의 **산문에서 확인 항목을 읽는다** — live 실측상 CEO는 확인 계획을
   이미 산문에 쓴다(claimrep "2주 안에 사전 등록된 3개 증거" · sellercs "직접 설치해 보면 하루" ·
   nuga "출시 전에 수동으로 재현"). 새 구조화 절 계약은 만들지 않는다(§11-5).
2. 사람이 확인한다 (인터뷰·설치·수동 재현 — 하네스 밖).
3. 결과로 같은 문서의 `## Decision`을 `진행`/`축소`/`폐기`/`보류`로 바꾸고
   `harness run <wf> --project <p> --resume`.

3의 각 문장을 코드로 검증했다:

- resume 수용: `run.ts:52-60`(failed만 통과) → `runWorkflow.ts:747-748`(`prior.status !== "failed"`
  throw · `resume_from`부터) → 완료 step 산출물 복원(`:773-782` 부근 `lastMarkdown`·`restoredIds`) →
  게이트가 startIndex라 **LLM 호출 0회**로 복원 문서만 재판정. 이 체인 전체를
  `runWorkflow.test.ts` "[B-49] 사람이 Decision을 고치면 resume이 모델 호출 0회로 종결…" 테스트가
  이미 고정하고 있다(live 0.84s 실측 포함) — **B-50은 이 레버에 새 코드를 얹지 않는다.**
- `진행` → proceed + `cleared_idea_sha256` 발급(`:1352-1360`) → completed → task-prompt/handoff 개방.
- `폐기` → kill(:1318) → killed(terminal · resume 불가 · 재평가 run 안내는 기존 `run.ts:180-188`).
- `축소` → jump(:1329-1345) — **검증은 예산을 안 썼으므로**(§5) 되돌림 1회가 남아 있어 pm 재계획
  lap이 실제로 돈다.
- 무편집 `--resume` → 같은 자리에서 `ceo_decision_verify`로 다시 정지, LLM 0회, 영수증 한 줄 추가
  (예산소진 사유의 기존 프로파일과 동일 — lap 재생은 없다).
- `run.ts`에 사유별 안내 블록을 추가한다(§8-b) — `gate_jump_budget_exhausted` 블록(`run.ts:124-133`)과
  같은 형태·같은 검증 규율(C-138/④).

pipeline 경로 (검증했으나 **안내 문장은 추가하지 않는다**):

- **1단계(idea-validation)는 레버가 살아 있다**: 실패 → `commitAfterRun`이 `last_failure` 기록 +
  awaiting_run 유지 → 사람이 문서 수정 → `pipeline next` → resume 조건 충족(`pipeline.ts:353-358`) →
  사전 drift 검증은 **approvedDigests만** 보는데 1단계는 승인이 아직 없어 빈다(`:364-377`) →
  게이트 재판정 → 통과. (§1-⑥)
- **2단계 이후는 막힌다**: 1단계 승인이 `docs/06_CEO_DECISION.md`를 결박 → 수정 시
  `pipeline_artifact_drift`, restart는 awaiting_run에서 `pipeline_active` 거부. **B-50이 넓힌 구멍이
  아니다** — mvp-planning의 '검증'은 오늘도 `ceo_decision_unmapped`로 같은 자리에 갇힌다(B-49 R1-B
  등재 사항). 그래서 pipeline 실패 메시지에는 참을 보장할 수 없는 안내를 새로 쓰지 않는다 —
  `run.ts`의 예산소진 안내가 pipeline을 다루지 않는 것과 같은 규율.

기각한 복귀 대안: §11-6·7.

## 5. Q4 — B-49 파생 예산과의 상호작용: **검증은 되돌림을 소비하지 않고, 종결은 그대로 보장된다**

- **소비 안 함이 맞다**: 검증 entry는 `{outcome:"failed"}`라 `isJump`(`runWorkflow.ts:643-651`)에
  안 걸린다 — 점프를 일으키지 않은 판정이 예산을 쓰면 영수증(실제 한 일)과 파생값이 어긋난다.
  실익도 있다: 사람이 확인 후 `축소`로 바꾸는 경로(§4)가 되돌림 1회를 온전히 갖고 시작한다.
- **"소비 안 하면 무한 방출 가능" 반론에 대한 답**: 반복 방출의 비용 프로파일이 다르다.
  '검증'은 **점프 분기에 진입할 수 없으므로**(§8-a 가로채기가 `on` 조회보다 앞) lap 재생이 원천
  차단된다 — 방출마다 run이 그 자리에서 멈춘다(invocation당 종결 보장: 게이트 분기는 항상 break).
  무편집 resume 반복 = LLM 0회 + 영수증 1줄(예산소진과 같은 기수용 프로파일). 새 run 반복 = 전체
  재실행 비용을 사람이 내는 의도된 탈출구(B-49와 동일 규율). **모델 호출이 무한히 도는 경로는 없다.**
- **종결 정리**: 점프 유발 토큰은 이제 `축소` 하나뿐이고 그것은 영수증 파생 예산에 결박돼 있다(B-49).
  검증·보류·unmapped는 정지, 진행·폐기는 terminal. B-49의 종결 증명에서 점프 소스가 하나 줄었을 뿐
  구조는 같다.

## 6. Q5 — 하위 호환: **옛 state·옛 registry 어느 조합도 깨지지 않고, silent-proceed 조합이 없다**

| 조합 | 동작 |
|---|---|
| 옛 run_state의 `gate_jumps[].decision === "검증"` (outcome:"jump") | 영수증은 재해석되지 않는다 — `isJump`는 outcome만 보고(예산 파생 정확), `gateOutcomeLabel`은 과거 사실("research 되돌림")을 그대로 렌더. |
| **교착 4개 live 프로젝트** (failed·`gate_jump_budget_exhausted`·되돌림 0) | `--resume` 시 게이트가 복원된 '검증'을 재판정 → 가로채기 → `jumpTarget=null` → 예산 분기 자체에 못 가고(`jumpTarget !== null`이어야 소진 코드) **`ceo_decision_verify` + 새 안내**로 떨어진다. 사유가 바뀌는 것은 새 판정의 새 기록이고, 실제로 점프를 요구하지 않았으므로 더 참에 가깝다. 4개 프로젝트가 곧바로 사람 검증 경로를 얻는다 — 개선이지 파손이 아니다. |
| 옛 registry(매핑 잔존) + 새 코드 | 가로채기가 `on` 조회 전이라 **점프 안 함** → verify 정지. fail closed·즉시 가시적(조용한 통과 아님). |
| 새 registry + 옛 코드 | '검증' → `ceo_decision_unmapped` 정지. fail closed. |
| 변경 후 CEO가 옛 토큰 '검증' 방출 | 그것이 곧 새 경로다 — 재결박의 요점(§2). 낱말·파서·프롬프트 주입(§1-③) 모두 불변이라 absent/ambiguous 위험도 불변. |
| golden fixture · mock provider | '진행' 고정(§1-④) — 바이트 무변경. |
| kill 잠금 (`cleared_idea_sha256`·`kill_history`) | 무접점 — 해제는 여전히 '진행' 한 자리에서만 발급. |

## 7. Q6 — 프롬프트 diff: `founder_ceo_agent.md` §14.0 **표 한 줄 + 안내 두 문장** (그리고 DECISIONS.md 항목)

§8-C는 **건드리지 않는다** — 이미 사람 과제로 정의돼 있다(§1-①). 고치는 것은 §14.0에서 하네스
동작을 설명하는 부분뿐이다. 이 파일은 계약 문서다 — **구현 시 `docs/DECISIONS.md` 항목 필수**
(harness-dev 규칙: 기각한 대안 포함).

`:532` 표 행 교체:

```diff
-| `검증` | C | 개발 없이 먼저 검증 (앞 단계로 되돌림) |
+| `검증` | C | 개발 없이 사람이 직접 검증 — run이 멈추고, 사람이 확인 결과로 판정을 바꿔 재개한다 |
```

표 아래(`:538` "**이 절이 없거나…**" 문단 뒤)에 두 문장 추가:

```markdown
`검증`은 **하네스가 아니라 사람이 움직이는 판정**이다: 검색·재조사로는 얻을 수 없고 사람이 싸게
직접 확인할 수 있는 증거(§8-C — 인터뷰·설치·수동 재현·랜딩페이지)가 판단을 가를 때 쓴다. 하네스는
앞 단계를 다시 돌리지 않는다 — **무엇을 어떻게 확인하면 판정이 바뀌는지**를 산문([핵심 이유]·[가장
큰 리스크])에 구체적으로 적어라.
```

- `:541` "확신이 없으면 `보류`나 `검증`을 쓴다"는 새 의미에서도 참 — 불변.
- §14.1 산문 형식("추가 검증") 불변. 런타임 주입(`promptParts.ts:76-83`)은 이름만 실으므로 불변(§1-③).
- 주석 정합(구현 시 함께, 코드 동작 무관): `registry.ts:37`의 예시 `{"축소":"pm","검증":"research"}`,
  `researchRuntime.ts:51·305·450`의 "게이트가 research로 되돌리면" 서술 — 실 registry에서 사라진
  경로를 계약처럼 남기면 다음 읽는 사람이 틀린 것을 믿는다(fixture 재진입으로 정정).

## 8. 설계 (최소 diff) — 파일별 변경분

### (a) `src/core/runWorkflow.ts` — 게이트 분기 2곳 (신규 필드 0 · 신규 함수 0)

`:1329` 교체 — '검증' 가로채기를 `on` 조회 앞에:

```ts
        // [B-50] '검증'은 사람 검증 요청이다 — 기계 되돌림(on)을 조회하지 않는다. registry가 매핑을
        // 다시 얹어도 점프하지 않는다: 어휘의 뜻은 판정을 읽는 이 자리에서 강제한다(로더는 on 키를
        // 검증하지 않는다 — registry.ts loadWorkflows). live 6-run: '검증' 4/4가 사람 과제,
        // research 재실행 유효 0/4 → 교착 4건 (B-50 · 기각한 대안: 신규 토큰 분화·로더 거부는 설계 문서).
        const jumpTarget = decision === "검증" ? null : (on[decision] ?? null);
```

`:1364-1370` 사유 ternary에 한 case 삽입:

```ts
        failed_reason = targetMissing
          ? "gate_jump_target_missing"
          : jumpTarget === null
            ? decision === "보류"
              ? "ceo_decision_hold"
              : decision === "검증"
                ? "ceo_decision_verify" // 오류가 아니라 "사람 차례"라는 뜻의 중단 — 복귀는 Decision 대체 후 resume
                : "ceo_decision_unmapped"
            : "gate_jump_budget_exhausted";
```

이하 전부 기존 코드가 처리한다: `failedIndex = i`(게이트 인덱스 resume), gate_jumps push
(`{outcome:"failed", reason:"ceo_decision_verify"}`), 콘솔 `중단(ceo_decision_verify)`,
`gateOutcomeLabel` failed case 렌더, exit 1.

### (b) `src/commands/run.ts` — 사유별 안내 (`:133` 예산소진 블록 뒤, 같은 형태)

```ts
    // [B-50] '검증'은 사람 검증 대기다 — 기계는 여기서 할 일이 없고, 무편집 resume은 진행하지 않는다.
    // 아래 문장은 전부 코드로 확인한 실동작이다(C-138/④ 규율): 게이트 인덱스 resume은 LLM 0회
    // 재판정(B-49와 같은 레버), '검증'은 on을 조회하지 않으므로 lap 재생이 없다.
    if (state.failed_reason === "ceo_decision_verify") {
      const deciderDoc = (state.failed_agent && findAgent(loadAgentRegistry(), state.failed_agent)?.default_output) || "(decider 산출 문서)";
      console.log(
        `  ↳ CEO 판정 '검증' — 하네스가 아니라 **사람이 확인할 차례**입니다 (기계 재조사는 돌지 않습니다).\n` +
          `    ① ${deciderDoc}의 산문에서 확인할 항목을 읽고 직접 확인하세요 (인터뷰·설치·수동 재현 등).\n` +
          `    ② 결과에 따라 같은 문서의 "## Decision"을 진행/축소/폐기/보류 중 하나로 고친 뒤 --resume —\n` +
          `       게이트가 그 문서를 다시 읽어 재판정합니다 (모델 호출 0회 · 영수증에 "판정 출처: 복원 문서"가 남습니다).\n` +
          `    아무것도 고치지 않은 --resume은 모델 호출 없이 같은 자리에서 다시 멈춥니다.`,
      );
    }
```

### (c) `registry/workflows.json` — 매핑 2개 제거 + description 2개 정정

`:12`·`:53`의 `on`에서 `"검증": "research"` 제거(`{"축소": "pm"}`만 남김).
`idea-validation`·`full-predev`의 description "축소/검증이면 되돌려 재검토" →
"축소면 되돌려 재검토, 검증이면 사람 확인 대기로 중단".

### (d) `agents/founder_ceo_agent.md` — §7 문안 그대로 (+ `docs/DECISIONS.md` 항목)

### (e) 주석 정합 (동작 무관 · §7 말미 목록): `registry.ts:37` · `researchRuntime.ts:51·305·450`

## 9. 상태·소비자 전수 표

| 소비자 | 접점 (file:line) | 영향 |
|---|---|---|
| `src/core/validate.ts` | `:176` 토큰 목록 | **무변경** — 어휘 5개 유지, 파서 불변 |
| `src/core/runWorkflow.ts` | 게이트 분기 | §8-a 2곳. status/resume/영수증 기계는 기존 failed 경로 재사용 |
| `src/commands/run.ts` | `:108-133` failed 렌더 | 사유 코드는 기존 줄이 그대로 출력. §8-b 안내 블록 추가 |
| `src/commands/pipeline.ts` | `:353-358` resume 조건 · commitAfterRun | **무변경** — failed 일반 경로. 1단계 레버 생존·2단계 이후 drift는 §4 (기존과 동일) |
| `src/core/summary.ts` | `:84-99` status switch | **무변경** — failed 분기가 `failed_reason`을 그대로 싣는다 |
| `src/core/obsidianExport.ts` | `:147-150` | **무변경** — `gateOutcomeLabel` 단일 렌더가 `중단(ceo_decision_verify)` 출력 |
| `gateOutcomeLabel` | `runWorkflow.ts:125-141` | **무변경** — failed case가 reason을 일반 렌더 |
| `src/core/progress.ts` | `gate_jump` 이벤트 | **무변경** — 실제 점프에만 방출(검증은 점프 없음), `run_end` status는 failed |
| `src/core/taskPrompt.ts` | `:46-47` 게이트 | **무변경** — failed는 오늘도 지시문을 막지 않는다(§1-⑤ 기존 동작 · §12-2) |
| golden `idea-validation.run_state.json` | gate entry | **무변경** — '진행' 고정(§1-④) |
| `scripts/acceptance.sh` | — | **무변경** — '검증' 토큰을 쓰는 테스트 없음(grep 확인) |
| `src/providers/mockProvider.ts` | `:27` | **무변경** — '진행' 고정 |
| `src/providers/promptParts.ts` | `:76-83` | **무변경** — 토큰 이름만 주입(§1-③) |
| `tests/fixtures/workflows/research-adapter.json` | `:20` | **수정** — `"검증"→"축소"` 키 교체(재진입 역학은 토큰 무관, §10) |
| `tests/fixtures/workflows/kill-sentinel.json` | `:38` gate-dup-decider | **무변경 가능** — 실행 전 거부 fixture라 매핑이 도달 불능. 정합 위해 `축소`로 바꿔도 무해 |
| `src/core/runWorkflow.test.ts` | §1-⑦ | **수정** — §10의 기존 테스트 조정 3건 + 신규 5건 |
| `src/core/researchAdapter.test.ts` | `:904`·`:1569` | **수정** — decisions `["검증",…]` → `["축소",…]` (fixture 키와 함께) |

## 10. 테스트 계획 — 신규 5 + 기존 조정 3 (약화·삭제 0)

신규 (각각의 red 조건 명시):

- **T1 검증=사람 대기**: idea-validation + `ceoDeciding("- 검증")` → `status:"failed"` ·
  `failed_reason:"ceo_decision_verify"` · gate_jumps가 `[{outcome:"failed", reason:"ceo_decision_verify"}]`
  1건(jump 없음) · research step 실행 1회(`timingsFor === 1`).
  **red**: 가로채기(§8-a) 누락 + 매핑 잔존이면 jump 발생(research 2회·entry 2건); ternary 누락이면
  reason이 `ceo_decision_unmapped`.
- **T2 registry가 뜻을 뒤집지 못한다**: `workflowsPath` fixture에 `on:{"검증":"<앞 step>"} + 게이트 뒤
  sentinel step`(kill-sentinel.json에 workflow 1개 추가) → 그래도 verify 정지 · sentinel 호출 0회 ·
  jump entry 0건. **red**: 가로채기를 registry 제거만으로 대체하면 이 fixture에서 점프가 부활한다 —
  §2-기각-3을 고정하는 테스트.
- **T3 복귀 레버(진행)**: T1 실패 후 `## Decision`을 `진행`으로 수정 → resume → `completed` ·
  모델 호출 0회 · `cleared_idea_sha256` 발급 · 마지막 entry `decision_source:"restored_artifact"`.
  **red**: verify 정지가 resume 레버를 막거나(수용 조건 파손) 재실행이 일어나면(호출>0) 빨감.
- **T4 검증은 예산을 안 쓴다**: T1 실패 후 `## Decision`을 `축소`로 수정 → resume → **jump가 실제로
  돈다**(pm 재실행 · gate_jumps에 outcome:"jump"). **red**: verify entry를 isJump로 세면 remaining=0이라
  `gate_jump_budget_exhausted`로 떨어진다.
- **T5 CLI 안내**: `runRun` 출력에 "사람이 확인할 차례" + decider 문서 경로 + `"## Decision"` 포함.
  **red**: §8-b 블록 삭제 시 무차별 "재개:" 한 줄만 남는다(거짓에 가까운 안내로 회귀).

기존 조정 3건 — **약화가 아닌 이유를 각각 적는다**:

- `exhaustedProject` driver 및 B-49 예산 4종(`:368-489`): `"- 검증"` → `"- 축소"`.
  검증은 이제 점프 자체가 불가능해 "예산 소진" 전제를 **만들 수 없다** — 전제 단정(`전제: 되돌림 1회
  후 예산 소진`)이 새 계약에서 거짓이 되는 것이지, 재는 대상(소진 예산이 resume으로 부활하지 않음)은
  `축소`로 바이트 하나 다르지 않게 유지된다. 되돌림 기계의 커버리지 동일.
- 5토큰×3workflow 전수(`:489-530`): 기대값만 새 계약으로 — 검증 행이 세 workflow 모두
  `failed:ceo_decision_verify`(기존: exhausted/unmapped/exhausted). 전수성(5×3) 불변.
- B-40/A-2 렌더 4종(`:871`): `{mvp-planning, 검증, unmapped}` case가 새 계약에서 도달 불능이 된다 →
  `{kill-overlap fixture, 축소, ceo_decision_unmapped}`로 교체(kill-overlap은 on에 `축소`가 없어
  unmapped 도달 — 신규 fixture 불요)하고 `{idea-validation, 검증, ceo_decision_verify}` case를
  **추가**. unmapped 렌더 커버리지 유지 + verify 렌더 신규 — 4종이 5종이 된다.
- (부속) research-adapter fixture·테스트 토큰 교체는 §9 표 — 재진입 역학(run 수명 예산·digest 소거)은
  게이트 점프의 **존재**에만 의존하고 어느 토큰이 점프하는지와 무관하다.

## 11. 기각한 대안과 이유 (본문 상술 외 요약)

1. **신규 토큰 분화**('검증'=기계 유지 + '실검증' 신설) — §2. 교착 재생산 경로를 남긴다.
2. **새 durable status** — §3. resume 기계가 거부하고 summary의 never 체크가 컴파일부터 깨진다.
3. **`completed` 변형** — §3. fail open, B-40이 닫은 구멍의 재개방.
4. **로더에서 `on` 키의 '검증' 거부** — 로더는 오늘 `on`을 아예 검증하지 않는다(§1-②). 첫 로더
   의미 검증을 신설하는 것보다 게이트 한 줄(§8-a)이 작고, fixture(재진입·dup-decider)까지 한 자리에서
   덮는다. 두 곳 강제는 언젠가 어긋난다.
5. **decider 산출물에 구조화 "검증 계획" 절 신설** — 새 파싱 계약 + required_headers 재생성 실패
   모드 추가. live 실측상 CEO는 계획을 이미 산문에 쓰고, 소비자는 사람이다 — 구조가 필요 없다.
6. **`harness verify-done --result <토큰>` 신설 명령** — Decision 수정+resume과 효과 동일한데 CLI
   표면·테스트·안내가 새로 생긴다. zero-code 경로가 이미 검증돼 있다(§4).
7. **사람 증거 주입 + CEO 재판정**(resume_from을 CEO step으로) — CEO 프롬프트는 아이디어+한 줄
   findings를 받으므로 증거가 도달할 배선 자체가 없다. 주입 기계 신설 + LLM 1회 재과금. 사람이
   판정을 대체하는 현행 레버가 불충분하다고 실증되면 그때 재고(§12-3).

## 12. 남는 위험 · 이번에 닫지 않는 것

1. **pipeline 2단계 이후의 Decision 레버 차단**(drift) — 기존 B-49 R1-B 등재 사항, B-50이 넓히지
   않는다(§4). 이번에 닫지 않는다.
2. **failed run이 task-prompt를 막지 않음**(§1-⑤) — 보류·예산소진과 공유하는 기존 동작. '검증' 대기
   중 지시문 생성은 논리상 이르지만 새 구멍이 아니다. §9.1 대장 C급 등재 후보로 남긴다.
3. **프롬프트 준수는 미증명**: 새 표 행·안내 문장이 live CEO의 '검증' 사용 정확도를 바꾸는지는
   재측정 전까지 모른다. 이 설계가 증명하는 것은 **'검증'에 대한 하네스의 응답**이지 CEO 판단
   품질이 아니다 — 과대주장하지 않는다. (다만 4/4 실측상 현행 방출도 새 의미에 적중한다.)
4. **기계 재조사 어휘 부재**: 진짜 "다시 검색하라"가 필요한 case가 live에 나타나면 그때 신규 토큰 +
   registry 매핑으로 추가한다(§2). 지금은 근거 0/4.
5. **`ceo_decision_unmapped`가 실 registry에서 도달 불능**이 된다 — 코드는 남긴다(향후 workflow의
   일반 fallback · fixture로 커버 유지, §10).

## 13. 예상 diff 크기 · 런타임 비용

| 파일 | 예상 diff |
|---|---|
| `src/core/runWorkflow.ts` | ~10줄 (가로채기 1+주석 4 · ternary 2+주석 1) |
| `src/commands/run.ts` | ~14줄 |
| `registry/workflows.json` | 4줄 |
| `agents/founder_ceo_agent.md` | ~7줄 |
| `registry.ts`·`researchRuntime.ts` 주석 | ~5줄 |
| `tests/fixtures/workflows/*` | ~14줄 (research-adapter 키 1 · kill-sentinel workflow 1개 추가) |
| `src/core/runWorkflow.test.ts` | ~90줄 (신규 T1–T5 + 조정 3건) |
| `src/core/researchAdapter.test.ts` | ~4줄 |
| `docs/DECISIONS.md` | ~10줄 |
| **합계** | **~160줄** — 목표 300줄 이내 |

**런타임 비용 (LLM 호출 수 변화)** — 이전 설계가 diff 줄 수만 세다 지적받은 항목:

- '검증' 판정 1회의 비용: 현행 **+1 lap**(research→pm→critique→ceo 재실행 = agent 호출 4회 이상,
  live run#3 실측 lap 14.0분·output 105k — 그리고 어차피 교착) → 변경 후 **+0회**(즉시 정지).
- 복귀: Decision 대체 후 resume = **0회**(B-49 실측 0.84s 계열). 무편집 resume = 0회.
- 어느 경로도 호출을 **늘리지 않는다** — 순감소만 있다. mock/골든/acceptance 경로 비용 불변.


---

# 리비전 1 — Codex 적대적 계획 리뷰 반영 (2026-08-30, 오케스트레이터 실물 검증 후)

Codex(gpt-5.6-sol, read-only) 판정은 **"승인 불가" · A급 7건**이었다. 전부 인용된 file:line을 직접
열어 검증했고 결과를 항목마다 적는다. **A 7건 전부 수용**, B 2건·C 1건 수용.

## ★ R1-A [A · 설계의 핵심 전제가 거짓 · 설계를 뒤집는다] 2차 research는 무효가 아니었다

**설계 §2·§8(a)의 근거는 "research 재실행 유효 0/4"였다. 이것이 사실이 아니다.**

**오케스트레이터 실측**(영수증 직접 대조):

| run | attempt1 | attempt2 | 판정 |
|---|---|---|---|
| `claimrep` | KATECH **없음** | **KATECH 있음** | 아이디어를 죽인 결정적 사실이 **2차에만** 있다 |
| `sellercs` | 근거 10건 | 9건 중 **새 출처 8건** | 채널 내 0원 경쟁자를 2차가 찾았다 |
| `nuga` | 근거 10건 | 10건 중 **새 출처 10건** | 전부 새 출처 |

즉 **게이트 되돌림은 제 일을 하고 있었다.** CEO가 새 질문을 품은 채 research가 다시 도니 이전에
없던 사실이 나왔고, `claimrep`에서는 그것이 판정의 축이 됐다.

**따라서 `검증 → research` 매핑 제거는 실증된 가치를 버리는 것이다. 기각한다.**

### 교체 설계 — 훨씬 작다

문제는 되돌림이 아니라 **되돌림이 끝난 뒤**다. 예산이 남았을 때의 `검증`은 "더 파봐라"이고 기계가
할 수 있다. **예산이 소진된 뒤의 `검증`은 "검색으로는 안 나오는 것이 필요하다" = 사람 차례**다.
**예산 자체가 기계/사람의 경계다.**

- **유지**: `검증 → research` 매핑, 예산이 남아 있으면 그대로 점프(§8(a)의 `jumpTarget` 가로채기 **삭제**).
- **바꾸는 것 하나**: 사유 ternary에서 `gate_jump_budget_exhausted`가 될 자리에 **`decision === "검증"`
  이면 `ceo_decision_verify`**. 나머지 판정(`축소` 등)의 소진은 그대로 `gate_jump_budget_exhausted`
  — 기계가 좁히기를 두 번 시도한 것이므로 의미가 다르다.

```ts
            : decision === "검증"
              ? "ceo_decision_verify" // [B-50] 되돌림을 다 쓰고도 '검증' — 검색으로 안 나오는 것이 필요하다 = 사람 차례
              : "gate_jump_budget_exhausted";
```

**부수 효과**: `registry/workflows.json` 변경 **0** · 리서치 fixture 변경 **0**(R1-G 자동 해소) ·
`researchRuntime.ts` 상한 산식 주석 **정정 불요**(되돌림이 남으므로 산식이 여전히 참) ·
프롬프트에서 "검색은 쓸모없다"는 문장 **불필요**(R1-E 자동 해소).

## R1-B [A · 수용] 안내가 막힌 4개 프로젝트에 **도달하지 않는다**

**검증**: 참이다. 넷 다 활성 파이프라인이고(`pipeline_state.json`), `harness run --resume`은
`run.ts:44`에서 `pipeline_run_reserved`로 거부된다 — 제안한 `run.ts` 안내는 **실행되지 않는다.**
실제 경로는 `pipeline next`이고 그것은 일반 안내만 낸다(`pipeline.ts:488`).

**B-49에서 뺐던 것과 같은 함정이고 이번엔 방향이 반대다** — 그때는 검증 불가라 뺐는데, 이번엔
**막힌 넷이 전부 1단계**라 검증 가능하다. **`pipeline.ts`에 `ceo_decision_verify` 분기를 넣는다.**
단 문장은 1단계에서 실증된 것만 쓰고, 2단계 이후는 R1-C 때문에 **약속하지 않는다.**

## R1-C [A · 수용 · 별도 등재] 2단계 stale 판정 재생 경로

**검증**: 참이다. resume drift는 승인 digest **또는** `last_failure.written`을 받고(`pipeline.ts:361`),
1단계 manifest에는 `06_CEO_DECISION.md`가 들어 있다(`pipeline.ts:681`). 2단계에서 그 파일을
1단계 내용으로 되돌리면 drift를 통과하고, 게이트가 그 문서를 읽어 **1단계의 `진행`을 2단계 판정으로
수용**할 수 있다.

**B-50이 만드는 결함이 아니다**(기존 경로다). 그러나 설계가 "2단계는 막힌다"고 단정한 것은 거짓이다.
**대장에 신규 A급으로 등재하고 이번 슬라이스에서는 닫지 않는다** — 이 슬라이스가 그것에 의존하지
않도록 2단계 안내를 쓰지 않는 것으로 대응한다(R1-B).

## R1-D [A · 수용] `task-prompt`·`plan-dag`가 `검증` 상태를 막지 않는다

**검증**: 참이다. `taskPrompt.ts:45`는 kill 이력과 파이프라인 상태만 보고 `failed` 사유는 안 본다
(`:102`에서 실패 run으로도 생성한다). `planDag.ts:139`도 같다. **"개발하지 않는다"가 계약인데
개발 착수 문서가 생성된다 — 상태 전이 우회이고 이 레포 규칙상 A급이다**(설계는 C로 분류했다).
**두 곳에 `ceo_decision_verify` 차단을 넣는다.** (`handoff.ts:366`은 이미 completed만 받아 정상.)

## R1-E [A · 수용 · R1-A로 대부분 해소] 프롬프트 전제가 과장이었다

**검증**: 참이다. §8-C는 *"리서치, 인터뷰, 랜딩페이지, 수동 MVP"* 로 **리서치를 포함한다**
(`founder_ceo_agent.md:283`). 설계가 "이미 사람 과제만 정의한다"고 한 것은 과장이다.
(오케스트레이터도 앞서 "대부분 사람 과제"로 읽었고 그 표현은 유지 가능하나, 설계의 단정은 틀렸다.)

**R1-A로 뒤집으면 이 모순이 사라진다** — 새 의미론에서 `검증`은 **둘 다**를 뜻하고(먼저 기계, 소진 후
사람) 그것이 §8-C 문면과 정확히 일치한다. 프롬프트 변경은 **표 한 줄의 "(앞 단계로 되돌림)"을
"(되돌림 1회 후 소진 시 사람 확인 대기)"로 고치는 것**으로 줄어든다. 정본 예시(`:595` 이하)는
Research Agent를 권하면서 `검증`을 내는데 **새 의미론에서는 그대로 옳다** — 수정 불요.

## R1-F [A · 수용] 비용·유효성 주장 정정

- "research 재실행 유효 0/4" → **거짓**(R1-A 실측).
- "105k가 replay lap 비용" → **거짓**. `105,355`는 2-lap run 전체이고 replay lap은 **49,233**이다
  (`commrep run_state`). **로드맵이 이미 같은 오류를 한 번 정정했는데 설계가 되풀이했다.**
- 정확한 비용 서술: 같은 토큰이 나올 때 **어느 경로도 호출이 늘지 않는다**(교체 설계에서는
  소진 시점의 사유만 바뀌므로 호출 수 **불변**). "모든 경로에서 순감소"는 주장하지 않는다.

## R1-G [A · R1-A로 자동 해소] 리서치 fixture 문구

매핑을 유지하므로 fixture(`research-adapter.json`)를 건드리지 않는다 — 문구 불일치가 생기지 않는다.

## R1-H [B · 수용] 레거시 `검증` 영수증 커버리지

`outcome` 있는 것과 **`outcome` 없는 구버전** 두 형태를 담은 레거시 state 테스트를 추가한다
(소진으로 계산 · 모델 호출 0 · resume 시 verify 사유 append).

## R1-I [B · 수용] kill 우선순위 mutation 잠금

`검증`이 `on`과 `kill`에 **동시에** 있는 fixture로 `killed`를 단정해, 훗날 누가 가로채기를 kill 앞으로
옮기면 red가 되게 한다.

## R1-J [C · 수용] "종결 보장" 문구 하향

각 invocation은 반드시 끝나지만 **사람이 무한히 resume할 수 있고 새 run이 `검증`을 무한히 낼 수
있다.** "각 invocation 종결 보장"으로 적는다.

## 확정 범위 (리비전 후) — 설계 초판보다 **작아졌다**

**넣는다**: 사유 ternary 한 case(`ceo_decision_verify`) · `pipeline.ts` 1단계 안내(검증된 문장만) ·
`taskPrompt`·`planDag` 차단 · `founder_ceo_agent.md` 표 한 줄 + `DECISIONS.md` 항목 · 테스트(레거시 2형태 ·
kill 우선순위 · verify 종결 · 개발 표면 차단).
**빼는다**: `jumpTarget` 가로채기 · `registry/workflows.json` 변경 · fixture 변경 ·
`researchRuntime.ts` 주석 정정 · 프롬프트의 "검색 무용" 문장 · `run.ts` 안내(파이프라인이 아닌
경로는 이 4건에 해당 없음 — 넣되 2순위).
**신규 대장**: R1-C(2단계 stale 판정 재생, A급).
