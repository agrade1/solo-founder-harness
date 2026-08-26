# C-126 설계 — 리서치 어댑터 production 배선 + `.env` 키 UX

> 이 문서는 오케스트레이터 세션(Fable 5)이 설계하고 **Codex 5.6-sol이 2라운드 심사**(계획 리뷰 A 10 + B 4 ·
> B-41 착지 후 integration gate A 5 + B 1)한 결과다. 지시대로 scratchpad에서 레포로 **영구화**했다
> (킥오프 §2.1 — 설계 문서가 세션과 함께 사라지는 것을 막는다). 구현 세션은 이 문서를 계약으로 쓴다.
> 판정·기각 대안·미확인은 아래 본문에 있고, 착지 후 정본은 로드맵 판정 절로 옮긴다.

---

# C-126 설계 — 리서치 어댑터 production 배선 + `.env` 키 UX (개정 3)

설계 세션: Fable 5 (read-only) · 2026-08-26 · 구현 대상: Opus 5 세션
개정 3: **B-41 착지본(PR #97) 실독 후** integration gate 리뷰(Codex · A 5 + B 1) 전부 반영.
양립 확인된 것(리뷰 비-finding): 형태 B의 2-LLM-호출과 progress 모델 · `completed_steps` 단일 항목 · 1차 미commit 자체 · replay/lease/lock 재독과 무충돌. A-10(개정 2)의 integration gate는 **이 개정으로 이행 완료** — 아래 좌표는 전부 착지본 실독 결과다.

## 개정 3 변경 요약 (개정 2 → 3 · 근거는 전부 착지본 라인)

| # | 지적 | 반영 |
|---|---|---|
| A-1 | **`pipeline next`가 배선을 우회** — 파이프라인은 `run.ts`를 거치지 않고 `commands/pipeline.ts`의 `nextLocked`가 `locked.runStage(...)→runWorkflow(...)`를 직접 부른다(:406) | key 해석+backend/scrub 구성을 **공유 함수 `resolveResearchRuntime()`** 하나로 → `runRun`과 `nextLocked` **양쪽에서** 호출. `RunWorkflowArgs.research?: ResearchRuntime`(명시적) · `NextPipelineOptions.researchRuntimeOverride?` 테스트 seam. `process.env` 불변 유지 (§5.0) |
| A-2 | 1차 미commit이 **usage·경고·예산까지 버린다** — `commitOutcome`(runWorkflow.ts:707)이 저장과 usage/regen/warning 누산을 겸하고, `tokensSpent`(:551)·예산 검사(:750)가 그 누산을 읽는다 | `commitOutcome`을 **`recordOutcomeTelemetry`**(모든 LLM 호출 직후 · usage/regen/warning)와 **`persistFinalOutcome`**(최종 채택본만 · 저장/completed_steps/findings)으로 분리. 1차는 telemetry만, 2차는 둘 다 (§5.2) |
| A-3 | **checkpoint가 evidence를 결박하지 않는다** — manifest는 `runStateSources`(core/pipeline.ts:681)가 `default_output`+`token_output`만 모은다. 반대로 append-only `evidence.jsonl`을 결박하면 승인 후 append가 전수 검증(approve :634 · gate :907)에서 drift가 된다 | attempt마다 **불변 JSON receipt**(write-once `wx`) + `runStateSources`가 **최종 attempt receipt + 그것이 참조한 content-addressed raw**를 source에 추가. `evidence.jsonl`은 비권위 인덱스로 checkpoint **제외**. 승인 전 재실행은 drift 아님 명시 (§6.1) |
| A-4 | partial evidence를 **현재 gateway API로는 사실대로 못 적는다** — `runResearch`의 `items`는 지역 변수라 두 번째 호출 throw 시 소실(researchGateway.ts:162·213) · `last_failure.written`은 `result.savedFiles`만 digest(commands/pipeline.ts:465) | **"gateway 로직 불변" 철회**: `RunResearchOpts.onStored(item, relPath)` collector 추가. 모든 evidence write를 `savedFiles`에 반영 → `last_failure.written`에 잡힘. resume은 `prior.research.attempts`를 **명시적 carry-forward** 후 마지막 성공 attempt만 digest 복원 (§5.3) |
| A-5 | 실패 안내가 **B-41 탈출구와 모순** — 활성 파이프라인에서 직접 run/resume은 전면 거부(runWorkflow.ts:465~·`pipeline_run_reserved`)인데 summary의 failed 분기(core/summary.ts:94~98)가 `harness run … --resume`을 출력. `awaiting_run`에선 restart 거부·pending 없어 reject 불가 | 파이프라인 소유 상태에서는 **`pipeline next`만** 안내(summary `nextActions`가 이미 받는 `pipelineOwns`를 failed 분기에도 적용). 복구 경로 2개 명시 + 실패 attempt는 삭제 없이 보존 (§4.4) |
| B | seed·digest·1차 전문이 프롬프트 예산에서 충돌 | 공동 상한 기각. **byte 단위 3축 각각**: seed 16,384B(B-41 계약 불변) · digest 16,384B(`Buffer.byteLength` — 20,000자 폐기) · 1차 전문 32,768B(초과 = `research_first_pass_too_large` fail closed). 최악 총량 **≈65,536B + 지시문·아이디어** 명시 · provider 감당 여부는 실측 항목 (§6.3) |

## 개정 2 변경 요약 (Codex 계획 리뷰 A 10 + B 4 — 전부 수용 · 유지)

| # | 요지 |
|---|---|
| A-1 | `.env` 리더는 `TAVILY_API_KEY` **한 이름 allowlist** · **`process.env` 불변경** · 값은 config 객체로만 → `createTavilyBackend({apiKey})` · 자식 env 부재 테스트 결박 |
| A-2 | `.gitignore` append만으로는 tracked `.env`를 못 지킨다 → git 추적·최종 ignore 효과 검사, tracked면 **키 읽기 거부** + 회전·`git rm --cached` 안내, history 정리 무주장 |
| A-3 | `self`는 **키 부재에만** · 외부 시도 실패 = resumable `failed` · "실패 시 계속" 정책은 미결정(사용자 결정 대기) |
| A-4 | `RESEARCH_REQUEST none` 종결자 필수 · `external`은 evidence ≥1일 때만 · bounded `attempts[]` · partial 사실 계수 |
| A-5 | 1차 전문+sha256을 2차에 전달 · 최종 채택본만 저장 |
| A-6 | run 수명 sessionBackend가 cache·호출 예산 소유(재진입 유지·resume 복원) · 선언 ≤2 코드 강제 · `$0` 주장 철회 |
| A-7 | 수집물은 웹 원문이 아니라 **Tavily search 응답 content(스니펫)** · sha256은 저장 응답 바이트의 것 — 전 문구 강등 |
| A-8 | 저장 전 exact-secret redaction · 결과 수/URL/총 evidence/digest 총량 fail-closed 상한 · `storeEvidence` EEXIST hash 재검증 |
| A-9 | resume 재주입은 시각 창이 아니라 attempt에 결박된 `EvidenceItem[]` snapshot에서만 |
| A-10 | "B-41 0줄" 과대주장 철회 → integration gate (**개정 3에서 이행**) |
| B 1~4 | digest 수신자 allowlist 상수 + attempt 시작 시 소거 · query 전송 고지+redacted bounded query 영수증 · 테스트 보강 · §9.1 형식 대장 행 |

---

## 1. 요약 (만드는 것 / 안 만드는 것)

- **만드는 것**: ⓐ `TAVILY_API_KEY` 한 이름만 읽는 `.env` 리더(의존성 0 · `process.env` 불변경 · 셸 우선) + `init` 템플릿 + git 추적 검사 ⓑ **공유 `resolveResearchRuntime()`** — `runRun`과 파이프라인 `nextLocked` 양쪽이 호출(파이프라인이 1급 소비자) ⓒ research step 배선: 1차(문서+말미 선언/`none`, search 전용) → Tavily → 2차(1차 전문+digest) → **최종 1회 저장**(telemetry는 호출마다) ⓓ attempt별 **불변 receipt 파일** + checkpoint 결박(`runStateSources` 확장) ⓔ digest를 `pm`·`red_team`·`founder_ceo`에 전달 ⓕ 외부 시도 실패 = resumable `failed` + 파이프라인 정합 안내.
- **안 만드는 것**: extract 개방 · 다른 검색 provider · 새 CLI 플래그 · MCP/도구 개방 · 캐시 영속화 · dotenv · git history 정리 · source-page 원문 검증 · "외부 실패 시 계속" 정책(미결정).

---

## 2. `.env` UX (개정 2와 동일 — 요지만)

- **위치**: `fromWorkspace(".env")` 단수. 키는 사용자 단위.
- **생성**: `harness init` + self fallback 판정 순간(없으면) — 공통 `ensureEnvTemplate()`(0600 · 존재 시 불변).
- **템플릿**: 주석(커밋 금지 · 채팅에 붙여넣기 금지 · **"모델이 생성한 검색어가 Tavily로 전송된다"** 고지) + `https://tavily.com` + `TAVILY_API_KEY=`. 빈 값 = 키 없음.
- **git 안전 검사**: `git ls-files --error-unmatch .env`(추적) · `git check-ignore -q .env`(최종 효과). **추적 중이면 키 읽기 거부** + 회전·`git rm --cached` 안내 · history 정리 무주장. 미ignore면 managed block 멱등 append 후 재확인. 이 레포 `.gitignore`에 `.env` + `projects/*/outputs/research/` 추가.

## 3. 리더 (개정 2와 동일 — 요지만)

`src/core/envFile.ts`: `resolveResearchKey()` — `TAVILY_SECRET_REF` 한 이름만(`^(?:export\s+)?TAVILY_API_KEY\s*=\s*(.*)$`), `process.env[이름] ?? .env`, **`process.env` 불변경**, BOM·따옴표 1쌍·비대상 줄 개수만 기록(내용 비노출). 자식 프로세스에 키가 실리지 않음을 테스트로 결박(셸 export 키는 기존과 동일하게 상속 — 우리가 만든 유출 아님, 문서화). redaction은 해석된 값 자체로: `scrub = (s) => redactSecrets(s, key ? [key] : [])`.

---

## 4. 판정·모드·영수증

### 4.1 판정 위치 — **공유 runtime, 두 호출자** (개정 3 A-1)

```ts
// 신규 src/core/researchRuntime.ts (~40줄)
export type ResearchRuntime =
  | { kind: "external"; backend: ResearchBackend; scrub: (s: string) => string }
  | { kind: "self"; envPath: string };  // 키 부재 (self가 곧 사실의 기록이다)
export function resolveResearchRuntime(): ResearchRuntime; // resolveResearchKey → createTavilyBackend({apiKey})
```

- **`runRun`**(commands/run.ts): workflow 실행 전 1회 해석 → `runWorkflow({ research: runtime, … })`.
- **`nextLocked`**(commands/pipeline.ts — workflow 단계 분기, provider 결정 :395와 같은 자리): `o.researchRuntimeOverride ?? resolveResearchRuntime()` → `locked.runStage(stage.workflowId, (lease) => runWorkflow({ …, research: runtime, pipelineLease: lease }))`. **`NextPipelineOptions`에 `researchRuntimeOverride?: ResearchRuntime` seam 추가**(기존 `providerOverride`·`now`와 같은 계열 · CLI 미노출).
- `runWorkflow`는 키를 모른다 — `args.research`가 유일한 입력. 미지정(기존 테스트·exec 경로) = `self`와 동일 동작.

### 4.2 종결자·모드 (개정 2 유지)

1차 지시(키 있을 때만 · `spawnRequest` 런타임 주입 패턴): 선언 최대 2줄 **또는** 정확히 `RESEARCH_REQUEST none`.
진행 mode: `self`(키 부재) · `external_declined`(none 명시) · `external_empty`(API 정상·결과 0) · `external`(evidence ≥1 · 2차 완료).
실패(resumable `failed`): `research_declaration_missing` · `research_declaration_invalid`(malformed·extract·2건 초과) · `research_backend_error` · `research_budget_exceeded` · `research_cap_exceeded` · `research_first_pass_too_large`(개정 3 신설 — §6.3).

### 4.3 영수증 — `run_state.research` + **불변 receipt 파일** (개정 3 A-3·A-4)

```ts
research?: {
  attempts: Array<{                     // resume 시 prior에서 carry-forward (kill_history 선례) · 코드 상한 4
    started_at: string;
    mode: "external" | "external_declined" | "external_empty" | "self" | null; // null = 실패로 종결
    error_code?: string;                // scrub 통과 후
    requests: Array<{ redacted_query: string }>;   // ≤100자 · redact 후
    backend_calls: number; cache_hits: number; dropped_by_domain: number;
    first_pass_sha256: string | null;
    evidence: EvidenceItem[];           // 원문 없는 포인터+발췌 (§3.2 허용 형태) — resume digest 복원의 유일 근거
    receipt_path: string;               // 아래 불변 receipt 파일 (프로젝트 상대경로)
  }>;
}
```

**receipt 파일**: `outputs/research/receipt-<compact started_at>[-n].json` — attempt 종결(성공·실패 무관) 시 **write-once**(`wx` · 이름 충돌 시 suffix 루프 — `restartPipeline`의 archive 예약 :770과 같은 패턴). 내용 = 위 attempt 객체와 동일(+ pipeline이 결박할 raw 상대경로 목록). **`run_state.json`은 다음 workflow가 덮으므로**(mvp-planning이 idea-validation의 run_state를 대체) 장기 보존·checkpoint 결박은 이 파일이 담당한다.

### 4.4 실패 안내 — 파이프라인 정합 (개정 3 A-5)

- **파이프라인 소유 상태에서 `harness run … --resume`을 안내하는 문구를 내지 않는다.** 수정 지점: `core/summary.ts`의 `nextActions` **failed 분기**(:94~98)가 이미 받는 `pipelineOwns` 인자를 적용해 `harness pipeline next --project <P>`로 교체(awaiting_approval 분기는 이미 정합). `commands/pipeline.ts`의 실패 출력(:470~473)은 이미 `pipeline next`를 안내한다 — 불변. `run.ts`의 `--resume` 안내는 파이프라인 밖에서만 도달하므로(활성 파이프라인의 직접 run은 `pipeline_run_reserved`로 거부) 불변.
- **복구 경로 2개 (문서·출력 양쪽에 명시)** — `awaiting_run`에서는 restart 거부·pending 부재로 reject 불가하므로 이 둘이 전부다:
  - ⓐ 원인(키 오류·네트워크·크레딧)을 고친 뒤 `harness pipeline next` — `last_failure` 영수증에 따라 같은 workflow를 자동 resume, research step 재실행.
  - ⓑ 사용자가 **명시적으로** 셸 키 unset + `.env` 키 비움 → `harness pipeline next` → **self attempt가 새로 append**된다(키 부재 = 승인된 fallback). 실패한 external attempt는 **삭제하지 않고 attempts에 보존**.
- CLI 영수증 줄(run.ts + pipeline 출력): mode별 한 줄, self일 때 `.env` 절대경로 안내(+없으면 생성 고지).

---

## 5. 배선 지점 (착지본 좌표 기준)

### 5.0 호출 경로 (개정 3에서 확정)

`runRun`/`nextLocked` → `runWorkflow(args.research)` → string-step 분기에서 `web_research: true`(registry 신규 optional 플래그) agent에 적용. 파이프라인 경로는 lease·seed(`seedFindings` :558~561)·fresh-run 게이트(:473~479)와 **직교** — research 배선은 step 내부이고 그 계약들을 건드리지 않는다.

### 5.1 흐름 (형태 B 유지)

1. `runtime.kind === "external"`이면 1차 프롬프트에 선언 지시 주입. 1차 실행 → **`recordOutcomeTelemetry`만**(§5.2).
2. 말미 판정: `none` → 1차를 `persistFinalOutcome`(mode `external_declined`) · 선언 파싱 실패/extract/2건 초과 → `research_declaration_invalid`로 run 실패(미저장) · 둘 다 없음 → `research_declaration_missing`.
3. `runResearch(requests, { backend: sessionBackend, evidenceDir, now, allowedDomains: null, onStored })`. §6.2의 run 수명 sessionBackend. **`onStored(item, relPath)`가 모든 저장을 관찰**해 ⓐ attempt.evidence에 누적 ⓑ `savedFiles`에 relPath push — 그래서 실패해도 partial이 attempt와 `last_failure.written`(commands/pipeline.ts:465 — `digestArtifacts(root, result.savedFiles)`)에 사실대로 남는다.
4. evidence 0건 → 1차 `persistFinalOutcome`(mode `external_empty`). ≥1건 → **1차 전문 byte 검사**(§6.3 · 초과 = `research_first_pass_too_large`) → 2차 실행: `revisionRequest`에 1차 전문(fanout-brief 선례 형태) + "인용에 source와 저장 스니펫 sha256" 지시, `evidenceDigest` 필드로 fence digest. `kind: "revise"`. 2차만 `persistFinalOutcome`.
5. attempt 종결 시 receipt 파일 write-once + `savedFiles`에 push(→ checkpoint·last_failure 양쪽에서 결박 가능).
6. digest 전달: 상수 `EVIDENCE_DIGEST_RECIPIENTS = ["pm", "red_team", "founder_ceo"]` · kind:"agent"·full-context만 · **새 attempt 시작 시 소거**.
7. **resume**: `prior.research.attempts`를 **명시적으로 carry-forward**(B-40 `kill_history` :546 선례와 같은 자리·같은 규율 — resume이 아닌 재평가 run도 이어받는 것까지 동일) 후, **마지막 성공(mode ≠ null) attempt의 `evidence` 저장본에서만** digest 재렌더.

### 5.2 telemetry/persist 분리 (개정 3 A-2)

착지본 `commitOutcome`(runWorkflow.ts:707)은 ⓐ usage/regen/warning 누산과 ⓑ 저장/completed_steps/findings를 겸하고, 토큰 예산(:750)이 ⓐ를 읽는다. 1차를 통째로 미기록하면 **1차 LLM 비용이 `run_state.usage`·`maxTokens`에서 사라진다**(2차·backend 실패 시 소비 전액 증발). 분리:

- **`recordOutcomeTelemetry(agent, o)`**: usagePerAgent·regenerations·warnings push — **모든** `runStepWithRegen` 반환 직후 호출(research 1차 포함). 1차의 헤더 누락 warning도 그 호출의 사실이므로 남긴다.
- **`persistFinalOutcome(agent, o)`**: saveArtifact·token_output·completed_steps·findings·lastMarkdown — **최종 채택본 1회만**.
- 기존 호출부(일반 step·critique critic/target·fanout)는 두 함수를 연달아 호출 — **동작 바이트 동일**(회귀 단정).

### 5.3 gateway 변경 (개정 3 A-4 — "gateway 로직 불변" 철회)

`RunResearchOpts.onStored?: (item: EvidenceItem, relPath: string) => void` — `storeEvidence` 성공 직후 호출(researchGateway.ts `call()` 내부 :203 자리). additive optional이라 기존 호출부(벤치마크·테스트) 불변, 미지정 시 동작 동일. typed partial error 대안은 기각(§9-14). 테스트 추가(완화 없음).

### 5.4 allowlist — extract 봉인 (개정 2 유지)

`allowedDomains: null` 고정(search 안 좁힘 · extract 전부 거부 — 착지 코드 사실). extract 선언 = `research_declaration_invalid`. 개방 조건 = 승인 축 — §10 대장 행.

---

## 6. 증거의 정체·결박·상한

### 6.1 checkpoint 결박 (개정 3 A-3)

- **결박 대상**: 최종(성공) attempt의 **receipt 파일** + 그것이 참조한 **content-addressed raw**(`outputs/research/raw/<sha256>.txt`).
- **수집 지점**: `runStateSources(state: RunState)`(core/pipeline.ts:681) 확장 — `state.research`의 마지막 성공 attempt가 있으면 `{ agent_id: "research", path: receipt_path, seed: false }` + raw 상대경로들(seed: false)을 out에 추가. 시그니처 불변(RunState만 받는다). `buildManifest`가 bytes를 읽어 digest — evidence·mode를 바꾸면 checkpoint_id가 바뀐다.
- **`evidence.jsonl`은 checkpoint에서 제외**(사람용 비권위 인덱스). append-only라 결박하면 승인 후 append 하나가 전수 검증(approve의 `effectiveDigests` 대조 :634 · completed 게이트 :907 · fresh-run 게이트 :861)에서 전부 drift가 된다.
- **불변성 근거**: receipt는 write-once, raw는 content-addressed(+A-8의 EEXIST hash 재검증) — 승인 후 바뀔 정당한 경로가 없다. 바뀌면 drift로 막히는 것이 **맞다**.
- **drift가 아닌 것(명시)**: 게이트 '검증' 재진입과 reject 후 재실행은 **승인 전**이다 — 새 attempt·새 receipt는 새 pending에 결박될 뿐 approved digest와 무관하다. 승인 **후** bound receipt/raw 변경만 drift다.
- mode `self`/`declined`/`empty`도 receipt를 남기고 결박한다 — 승인자가 "이 문서가 어떤 리서치 모드에서 나왔나"를 승인 바이트 안에서 본다.

### 6.2 run 수명 예산 (개정 2 유지)

sessionBackend wrapper(runWorkflow 수명): query memo(attempt 간 유지) · run 누적 호출 counter 상한 8(`research_budget_exceeded`) · resume 시 `prior.research.attempts[].backend_calls` 합으로 복원(프로세스 간 memo 소실 = 크레딧 재소모 — 문서화). 저장 전 exact-secret redact + 결과 수/URL ≤2048/총 evidence ≤12 상한(A-8).

### 6.3 프롬프트 byte 예산 — 3축 분리 (개정 3 B)

공동 상한 기각(리서치 증거가 seed 잔여만 받으면 slice 목적 상실). **전부 byte 단위**(`Buffer.byteLength` — B-41 `SEED_MAX_BYTES`와 같은 자, 다국어에서 chars ≠ bytes):

| 축 | 상한 | 초과 시 |
|---|---|---|
| seed (B-41 계약 — 불변) | `SEED_MAX_ITEMS` 24 · `SEED_MAX_BYTES` 16,384B | 기존 `seedFindingsFrom` marker 규칙 그대로 |
| evidence digest | **16,384B** (개정 2의 20,000자 폐기) | 항목 단위로 못 들어가면 **`research_budget_exceeded` fail closed** — 조용한 절단 금지 |
| 2차의 1차 문서 전문 | **32,768B** | 자르지 않고 **`research_first_pass_too_large` fail closed** |

최악 총량 = **약 65,536B(64KB) + 선언 지시·digest fence·아이디어 전문(v1 기존 탑재)**. 이것이 provider 입력에서 감당 가능한지는 **구현 세션 실측 항목**(기억으로 단정하지 않는다 — 참고 실측: PRD 28KB 문서를 v1 프롬프트가 이미 운반한 전례 있음, M11⑩).

### 6.4 정체 표기 (개정 2 유지)

수집물 = **Tavily search 응답 content(스니펫)** · sha256 = **저장 응답 바이트**. source-page 검증 무주장(extract 개방 시의 몫 — 범위 밖). `renderEvidenceDigest`·gateway 주석의 "원문" 표현은 "저장된 응답"으로 정정.

---

## 7. 파일별 변경 계획 (착지본 기준 갱신)

| 파일 | 종류 | 내용 | 규모 |
|---|---|---|---|
| `src/core/envFile.ts` (+test) | **신규** | 단일 이름 리더 · 템플릿 · git 안전 검사 | ~120 (+~200) |
| `src/core/researchRuntime.ts` | **신규** | `resolveResearchRuntime()` — 두 호출자 공유 (A-1) | ~40 |
| `src/commands/run.ts` | 수정 | runtime 해석·주입 · 영수증 출력 · self 시 `.env` 보장 | +25 |
| `src/commands/pipeline.ts` | 수정 | `nextLocked`에 runtime 주입(:395 자리) · `NextPipelineOptions.researchRuntimeOverride?` seam · 실패 출력에 복구 경로 ⓐⓑ | +20 |
| `src/core/runWorkflow.ts` | 수정 | `research?: ResearchRuntime` · commitOutcome 분리(telemetry/persist) · research 배선·sessionBackend·receipt·attempts carry-forward·resume 복원 | +190 |
| `src/core/pipeline.ts` | 수정 | `runStateSources`에 receipt+raw 추가 (A-3) | +12 |
| `src/core/summary.ts` | 수정 | failed 분기 `pipelineOwns` 적용(:94) — `pipeline next` 안내 | +5 |
| `src/tools/researchGateway.ts` | 수정 | `onStored` collector · "원문"→"저장 응답" 문구 | +12 |
| `src/tools/tavilyBackend.ts` | 수정 | `apiKey?` 옵션 · HINT `.env` 안내 | +10 |
| `src/tools/evidenceStore.ts` | 수정 | EEXIST hash 재검증 | +8 |
| `src/providers/provider.ts` / `promptParts.ts` / `runAgent.ts` | 수정 | `evidenceDigest?`·`researchRequest?` 배선 | +26 |
| `src/core/registry.ts` + `registry/agent_registry.json` | 수정 | `web_research?: boolean` | +3 |
| `.gitignore` | 수정 | `.env` · `projects/*/outputs/research/` | +4 |
| 테스트(runWorkflow·pipeline·summary·gateway·evidenceStore) | 수정 | §8 | ~500 |

새 런타임 의존성 0. workflow 정의·step 종류·B-41 state schema(`PipelineState`) **불변** — 파이프라인 접점은 `runStateSources` 확장과 seam 추가 2곳뿐.

---

## 8. 테스트 계획

### 무과금 (전부 fake/offline)

- **리더·템플릿·git 검사**: 개정 2 그대로(비허용 이름 무효 · `process.env` 불변 · 자식 env 부재 · tracked/negated `.env` 거부 · append 멱등).
- **A-1 경로 동등성**: `nextPipeline`에 `researchRuntimeOverride`(fake backend) 주입 → **파이프라인 경로에서** external mode 완주 · receipt 생성 · checkpoint artifacts에 receipt+raw 포함. 같은 fixture를 `runWorkflow` 직접 호출로도 — 두 경로의 attempt 기록 동등.
- **A-2 telemetry**: 2차/backend 실패 시나리오에서 **1차 usage가 `run_state.usage`에 존재** · `--max-tokens`가 1차 비용을 센다(예산 검사 단정).
- **A-3 결박**: ⓐ 승인 후 raw 1바이트 변조 → `pipeline_artifact_drift`(approve·completed 게이트 양쪽) ⓑ 승인 후 `evidence.jsonl` append → drift **아님** ⓒ reject 후 재실행(새 receipt) → 새 pending 정상 · 옛 approved와 무충돌 ⓓ receipt 없는 self attempt도 결박됨.
- **A-4 partial**: 2건 중 1건 저장 후 throw → attempt.evidence에 1건 · `savedFiles`에 raw+receipt → `last_failure.written`에 digest 존재 → resume 사전 drift 검증 통과. `onStored` 미지정 gateway 호출은 기존과 바이트 동일.
- **A-5 안내**: 활성 파이프라인 + failed run에서 `summary` 출력에 `--resume` 부재 · `pipeline next` 존재. 복구 ⓑ: 키 제거 후 resume → self attempt append · 실패 external attempt 보존.
- **B 예산**: digest 16,385B fixture → fail closed(절단 없음) · 1차 32,769B → `research_first_pass_too_large` · 다국어(UTF-8 3byte 문자) fixture로 byte 집행 확인.
- 개정 2의 나머지 시나리오 유지(none/모드 분리 · 게이트 재진입과 run-wide 상한 · backend가 키 반환 · 상한들 · resume 결박 · digest 수신자/소거 · critic 미주입).
- **mutation 표적(C-116 형식 · 8)**: ① 리더가 `process.env`에 쓰도록 → 불변 단정 red ② tracked `.env` 허용 → 거부 red ③ 실패 시 계속 진행 → failed 단정 red ④ 저장 전 redact 제거 → 키 반환 red ⑤ `runStateSources`에서 receipt/raw 제외 → 결박 테스트 ⓐ red ⑥ telemetry 분리 제거(1차 미기록) → A-2 테스트 red ⑦ resume 복원을 시각 창으로 → 결박 red ⑧ digest 초과 시 절단으로 → B 테스트 red.

### live 1회 (최소 — 리뷰 확인: 현 제안으로 충분)

`workflowsPath` fixture `steps: ["research"]` + `--max-regen 0` + 실키 → LLM 정확히 2호출 · backend ≤2회. 검증: mode=`external` · receipt 실재 · 인용 sha256 ↔ 저장 응답 대응 · 전 산출물 grep 키 부재 · 자식 env 키 부재. 크레딧 단가·플랜 과금은 실측 기록(과거 1회: 6크레딧·해당 계정 $0 — 일반화 금지).

---

## 9. 기각한 대안 (개정 2의 13건 유지 + 개정 3 신규)

1~13. (개정 2 — 범용 로더 · dotenv · `.env` 우선 · per-project `.env` · 선언 전용 1차 · 하네스 질의 생성 · 도구/MCP 개방 · 상수 allowlist · 실패 시 계속 · 시각 창 resume · 무선언=조용한 self · 하네스가 문서에 digest append · `--research` 플래그)
14. **partial 전달을 typed error로**: throw 경로마다 wrapping이 필요하고 캐시 적중·부분 성공 조합에서 사실 손실 — `onStored` collector가 더 작고 정확. 기각.
15. **`evidence.jsonl`을 checkpoint에 결박**: append-only 인덱스라 승인 후 정당한 append가 전수 검증에서 drift — 권위는 receipt+raw로. 기각.
16. **run_state.research만으로 장기 보존 주장**: `run_state.json`은 다음 workflow가 덮는다(실측 — mvp-planning 단계가 대체) — receipt 파일이 없으면 idea-validation의 리서치 영수증이 소멸. 기각.
17. **seed·digest·1차 전문의 공동 상한**: 리서치 증거가 seed 잔여 예산만 받으면 slice 목적이 죽는다 — 3축 분리(오케스트레이터 결정). 기각.

---

## 10. 미확인·리스크 · 미결정 · 대장 등록 · B-40/B-41 접점

**미확인 (구현 세션 실측 목록)**
- Tavily 스펙(endpoint·응답 형태·크레딧 단가·플랜 과금·rate limit) — live 1회에서 실측. Codex 인용 공식 문서도 실측 전 미확정.
- live 모델의 선언/`none` 준수율(표본 1 · B-42 부류) — 불이행 시 fail closed(마찰 가능).
- **≈64KB 최악 프롬프트를 provider가 감당하는지** — 실측 항목(§6.3).
- 2차 개정의 품질 이득(벤치마크는 인용-저장 대응만 측정) · claude-code ambient 도구(기존과 동일 미확인).
- `.env` 리더는 CLI 경로(run·pipeline)에서만 돈다 — 스크립트 직접 실행은 기존 셸 env 방식.

**미결정 (사용자 결정 대기)**: 외부 시도 실패 시 "자체로 계속" 옵트인 정책 — 현 설계는 fail closed(resumable failed + 복구 경로 ⓐⓑ).

**§9.1 대장 등록 행 (구현 착지 시 그대로 등재)**

| id | 분류 | 항목 | 심각도/확률 | 영향 반경 | 유예 비용 | 수정 공수 | 기한/트리거 | 담당 | 증거 | 상태 |
|---|---|---|---|---|---|---|---|---|---|---|
| (신규) | C (P2) | **extract(원문 수집) 봉인** — search 스니펫만 · source-page 검증 불가 · 개방에는 allowlist 승인 축 설계 선행 | 중/확실 | 리서치 근거 깊이 | 근거가 스니펫 수준 | 중 | 사용자가 원문 수집 요구 시 | 미정 | 이 문서 §5.4·§6.4 | open |
| (신규) | C (P3) | **summary/vault에 research mode 미렌더** — receipt·checkpoint에는 있으나 두 표면이 생략(누락이지 거짓 아님 · 장기 보존은 A-3 receipt가 담당) | 낮/중 | 영수증 가시성 | run_state·receipt 직접 열람 필요 | 소 | C-126 착지 후 첫 하드닝 | 미정 | 이 문서 §4.3 | open |

**B-40 접점**: idea snapshot·kill 잠금·`## Decision` 파서·`lockFieldsProblem` 불변. `RunState.research`는 additive optional(구버전 통과) · attempts carry-forward는 `kill_history`(:546)와 같은 자리·같은 규율.

**B-41 접점 (integration gate 이행 결과)**: 착지본과의 충돌 지점은 리뷰가 지목한 5곳이었고 전부 이 개정에 반영됐다 — `nextLocked` 직접 호출(A-1) · `commitOutcome` 겸직(A-2) · `runStateSources` 한정 수집(A-3) · `last_failure.written`=savedFiles(A-4) · summary `--resume` 안내(A-5). **양립 확인된 계약은 건드리지 않는다**: lease(`lockPipeline().runStage()` · `leaseAllowsRun`) · seed(`seedFindingsFrom`→`seedFindings`) · drift 전수 검증 · replay · `PipelineState` schema. research step의 이벤트 2회 방출(1차+2차, 같은 stepIndex)은 critique_loop 다회 방출과 같은 형태로 **checkpoint 소비자와 무충돌 확인됨**(리뷰 비-finding). 구현 순서: 단일 슬라이스(B-41은 이미 main) — `runWorkflow.ts`·`pipeline.ts` 소유권이 겹치므로 **병렬 세션 부적격, 직렬 구현**.
