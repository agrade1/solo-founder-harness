# M8 KICKOFF — UX & Design Pipeline

> 새 세션이 **이 문서 하나로** 착수할 수 있게 쓴 문서다. 작성 2026-08-13(M7 완료 직후).
> 브랜치 `work/m5c-autopilot`. 앞선 판정은 로드맵 `M7 진행 판정` 절이 정본이다.

---

## 0. 30초 요약

M7까지 **kernel(SoR) · 승인 manifest · autopilot · 계층 spawn · research gateway(선언→실행) ·
EvidenceItem · 승인 정적 감사 · 도구 예산 상한 · 사람 gate**가 전부 섰다. M8은 처음으로
**디자인 산출물 파이프라인**을 세운다 — UX flow, 디자인 방향, `DESIGN.md`, `tokens.json`,
component inventory를 만들고, **핵심 화면 설계 → 토큰 기반 구현 handoff**의 계약·접근성·범위를 검증한다.

핵심 재사용 세 가지:

1. **shadcn filtered read는 이미 있다** — `src/tools/shadcn*.ts` + registry `handoff-shadcn-readonly`
   profile. M3c에서 만들었고 live acceptance까지 통과했다. **다시 만들지 마라. 그 위에 선다.**
2. **선언→실행 패턴**(M7 `researchGateway`)이 component registry 조회의 본보기다 — 새 상시 컴포넌트를
   만들지 않는다.
3. **`design_write`는 hard deny다**(`capabilities.ts`). M8은 디자인 **문서**를 만드는 것이지
   디자인 도구에 쓰는 것이 아니다.

**M8은 M7과 달리 스펙상 외부 유료 API가 필수가 아니다.** shadcn registry는 무료 공개 registry이고,
과금 후보는 live LLM 왕복뿐이다. §6을 먼저 읽어라.

---

## 1. 시작 전에 읽을 것 (이것만)

```text
CLAUDE.md                                              # 세션 계약 (작업 방침 포함)
AGENTS.md                                              # 리뷰·병렬·모델 분업 상세
docs/handoff/M8_KICKOFF.md                             # 이 문서
docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md    # §10 M8 절 + `M7 진행 판정` 절 + §9.1 대장
docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md        # §5 ux_ui 행 · §6.4 shadcn read 판정 ← M8의 설계 정본
docs/CONTEXT_SUMMARY.md                                # 직전 상태 한 눈
```

**로드맵은 위쪽 절이 최신이다.** 충돌 시 위쪽이 현행이며, M3d 이후 오케스트레이션 충돌은 로드맵이 우선한다.

---

## 2. 지금 서 있는 지반 (M7 완료 시점 · 실측)

| 계층 | 상태 | 위치 |
|---|---|---|
| durable SoR · 승인 manifest · autopilot · 계층 spawn · context bundle · rotation | 완료(M6) | `src/exec/orchestrationKernel.ts` · `spawnRouting.ts` · `contextBundle.ts` |
| research gateway(선언→`RESEARCH_REQUEST` 파싱→backend 직접 호출) | 완료(M7) | `src/tools/researchGateway.ts` — **MCP 서버가 아니다** |
| `EvidenceItem`(원문은 content-addressed 파일 + 포인터, 중앙엔 발췌만) | 완료(M7) | `src/tools/evidenceStore.ts` — `liveEvidence.ts`(metrics 전용)와 다른 것 |
| 승인 manifest 정적 감사(`C-67`, read-only 5규칙+심각도) | 완료(M7) | `src/exec/manifestAudit.ts` |
| 도구 예산 상한(초과 등록은 profile 로드 거부, fail-closed) | 완료(M7) | `src/tools/profiles.ts` `MAX_MCP_SERVERS_PER_PROFILE=3` · `MAX_EXPOSED_TOOLS_PER_PROFILE=16` |
| 사람 gate(답 없는 `decision_request` → `decision_pending` 거부) | 완료(M7) | kernel `completeTaskWithArtifacts`/`submitResult` |
| **shadcn read 계층(M3c — M8의 기반)** | **이미 있다. 다시 만들지 마라** | 아래 실측 표 |
| tool profile registry | 4개 profile | `registry/tool_profiles.json` |
| **디자인 산출물 파이프라인(DESIGN.md · tokens.json · inventory · handoff 계약)** | **없다 — M8이 만든다** | (신규) |

**shadcn 계층 실측**(`src/tools/`):

| 파일 | 역할 |
|---|---|
| `shadcnPilot.ts` | M3c-0: headless `claude -p` + `system/init` 스냅샷으로 shadcn MCP **도구명 발견**(discovery-only) |
| `shadcnSchemaProbe.ts` | M3c-1: `tools/list`로 7개 도구 이름·schema 확정 |
| `shadcnReadSemanticsProbe.ts` | M3c-2: 읽기 후보 5개를 고정 인자로 tools/call — cwd 무변경·결과 계약·8,000 chars budget 측정 |
| `shadcnReadPolicy.ts` | M3c-3a: 읽기 5개만 노출·금지 2개(`get_add_command_for_items`·`get_audit_checklist`) fail-closed·인자 좁게 강제·로컬 제한 schema만 노출(정책 상수, deep-freeze) |
| `shadcnReadMcpProxy.ts` | M3c-3a: 위 정책을 집행하는 read-only filtering MCP proxy(downstream `npx`, upstream 공식 MCP 계약) |

**registry 실측**(`registry/tool_profiles.json` — profile 4개):

| profile | capability | permissionMode | 비고 |
|---|---|---|---|
| `planning-none` | (없음) | `read_only` | `mcp__*` 전부 deny |
| `planning-local-readonly` | `repo_read` | `read_only` | Read/Glob/Grep만 |
| `research-tavily` | `web_search` · `page_extract` | `read_only` | `internal_adapter`(모델에 도구 미노출) · `secretRefs:["TAVILY_API_KEY"]` |
| `handoff-shadcn-readonly` | `component_registry_read` | `approval_write` | server `shadcn`(launcher `shadcn_read_proxy`) · 읽기 5도구 preapproved · 금지 2도구 denied |

**capability 실측**(`src/tools/capabilities.ts`): `design_read` · `component_registry_read` ·
`framework_docs`는 **active 집합**에 있다. `design_write`는 `production_deploy`·`billing_live`와 같은
**deny 집합**에 있다.

**실측 baseline**(로드맵 M7 진행 판정 절 인용 — 이번에 다시 돌리지 않았다): `test:exec` **542/542** ·
`test:core` **426/426** · `scripts/acceptance.sh` **PASS=140 / FAIL=0** · `npx tsc --noEmit` clean.
acceptance 마지막 번호는 **Test 19**(M7)다 — **M8은 Test 20**을 쓴다.

**§9.1 대장**: "M8" 기한·트리거를 가진 열린 항목은 **grep 기준 없다**(로드맵에서 `M8` 언급은 §10 M8 절뿐).

**착수 시 확인할 것 — 2026-08-13 실측 판정 (M8 세션)**:

1. **`handoff-shadcn-readonly`의 `permissionMode: "approval_write"` → 그대로 둔다.**
   근거: 이 profile의 유일한 소비 경로인 `src/core/handoff.ts`는 `buildSpawnArgv`에서
   `--permission-mode default`를 **하드코딩**하고 `compileToolProfile`을 쓰지 않는다. 즉
   `profile.permissionMode`는 `assertShadcnReadonlyContract`(handoff.ts:90)의 **exact 계약 값**으로만
   쓰인다 — `read_only`로 바꾸면 계약 검증이 red가 되고 argv는 하나도 바뀌지 않는다(이득 0, 파괴 1).
   `profiles.ts:permissionModeFlag`에서 `read_only`는 `plan`으로 매핑되므로, 이 profile을
   **문서를 쓰는** worker에게 주면 오히려 쓰기가 막힌다. M8에서 이 profile은 **registry 읽기 단계 전용**이고,
   `DESIGN.md`/`tokens.json`은 kernel artifact 경로로 발행하므로 profile 쓰기 권한이 필요하지 않다.
2. **role ↔ profile 배선**: `ux_ui`·`design` role은 §5대로 `planning-none`(도구 없음 — 산출물은 kernel
   artifact). shadcn registry 읽기는 기존 `runHandoff({toolProfileId: "handoff-shadcn-readonly"})`
   경로만 사용한다(M3c live 통과 경로). **신규 profile을 만들지 않는다.**
3. **"design review는 fresh Codex" 실행 경로**: 새 배선 불필요. `src/exec/codexCliProvider.ts` +
   승인 manifest `executionAuthority.codex`/`codexHome`(`approvalManifest.ts`)가 이미 실행 권위를 쥐고 있고,
   fresh 세션 강제는 kernel `attemptId`(`orchestrationKernel.ts`) 재사용으로 성립한다.
   (`src/exec/reviewer.ts`는 Opus 고정·`plan` 전용이라 **design review에 쓰지 않는다** — 별 경로다.)
4. **문서 검증기 위치(기존 패턴)**: `src/core/validate.ts`(`validateAgentOutput` 필수 4헤더 +
   registry `required_headers`, `extractTokensJson`) · `registry/agent_registry.json`의 `design` role은
   이미 9개 필수 헤더(디자인 방향·컴포넌트 인벤토리·접근성 기준·디자인 토큰 …)를 갖고 있고,
   `runWorkflow.ts`는 `design_gate` + `tokens_hash`까지 기록한다. **T1은 이것을 다시 만들지 않고**
   그 위에 `tokens.json` **닫힌 형태 schema** + inventory 형식 + fail-closed 검증만 얹는다
   (v1 검증은 경고 수준 — M8 산출물 계약은 fail-closed로 올린다).
5. **§9.1 대장의 M8 기한 항목**: grep 기준 **없음**(재확인). 새로 등록되는 항목만 T7에서 기록한다.

---

## 3. 이미 결정된 설계 — 다시 논의하지 마라

1. **`design_write`는 deny다.** `capabilities.ts` deny 집합 + §5 ux_ui 행("금지: design_write(beta)").
   M8은 디자인 **문서 산출물**(DESIGN.md·tokens.json·inventory)을 하네스 파일로 만드는 것이지,
   Figma 등 디자인 도구에 쓰는 것이 아니다. write-to-canvas류는 만들지 않는다.
2. **shadcn read는 filtered proxy 경유만.** §6.4 판정 — 읽기 5도구만, install 계열은 차단.
   **custom/private registry는 차단한다**(로드맵 M8 절). 정책 정본은 `shadcnReadPolicy.ts`.
3. **Figma read는 M8 기본이 아니다.** §5 ux_ui 행 — `design_source=figma`가 프로젝트에 명시될 때만
   조건부이고, §6.4가 "design_source 있는 첫 프로젝트가 생기면 승격"으로 판정했다. 지금 그 프로젝트는 없다.
4. **새 MCP 서버·상시 컴포넌트를 만들지 않는다.** M7 §6.2 판정의 근거(1인 운영·headless 승인 부재)는
   M8에도 그대로 적용된다. 필요한 외부 조회는 기존 proxy(shadcn) 또는 선언→실행 패턴을 재사용한다.
5. **원문은 파일, 중앙은 포인터**(로드맵 §3.2). component 조회 결과·디자인 원문도 같은 규칙이다 —
   kernel state·프롬프트에 원문을 싣지 않는다. `evidenceStore.ts` 계약을 재사용한다.
6. **모델 분업**: design review는 fresh Codex, 수정은 fresh design worker(로드맵 M8 절).
   자기 산출물을 자기가 승인하지 않는다.

---

## 4. M8 완료 조건 → 증명물

로드맵 §10 M8 절이 스펙 전부다. **여기 없는 기능은 만들지 않는다.**

| 완료 조건(로드맵 원문) | 무엇을 만들면 증명되는가 |
|---|---|
| UX flow · 디자인 방향 · `DESIGN.md` · `tokens.json` · component inventory | 산출물 schema/계약 + 생성 파이프라인이 offline(mock worker)로 end-to-end. 필수 섹션·형식 검증이 fail-closed |
| shadcn filtered read 재사용 | 디자인 worker가 `handoff-shadcn-readonly`(기존 proxy) 경유로만 registry를 읽는다. 읽기 5도구 외 호출·차단 우회 mutation → red |
| custom/private registry 차단 | 비공식 registry 지정이 fail-closed. 차단 제거 mutation → red |
| design review는 fresh Codex, 수정은 fresh design worker | 리뷰→수정 왕복이 서로 다른 fresh 세션으로 배선되고, 같은 세션 재사용이 거부됨을 red-path로 고정 |
| **완료: 핵심 화면 설계→토큰 기반 구현 handoff의 계약·접근성·범위 검증** | handoff 계약(구현 세션이 받는 입력의 닫힌 형태) + 접근성 체크(tokens/inventory 수준에서 검증 가능한 것 — 예: 대비·필수 상태) + 범위 검증(설계에 없는 화면·컴포넌트가 handoff에 없음). 각 체크 mutation → red |

접근성 검증의 **구체 범위는 로드맵에 명시돼 있지 않다** — 착수 세션이 정의하고 근거를 적는다(미확정).
tokens.json 수준에서 기계 검증 가능한 것(색 대비 등)부터 시작하고, 렌더링 필요 항목은 범위 밖으로 명시한다.

---

## 5. Task 분해 (제안 — 착수 세션이 확정한다)

### T1 — 산출물 계약 정의 **(직렬·최우선)**
- `DESIGN.md` 필수 섹션 · `tokens.json` schema(닫힌 형태) · component inventory 형식.
  기존 문서 계약(v1의 필수 섹션 헤더 검증)과 같은 결의 검증기를 만든다.
- 완료: 계약 위반 fixture가 각각 fail-closed. 각 검증 규칙 제거 mutation → red.

### T2 — shadcn read 배선 (기존 proxy 재사용)
- 디자인 worker(또는 handoff 단계)가 `handoff-shadcn-readonly` profile로 registry를 읽어
  component inventory를 채우는 경로. **`shadcnReadMcpProxy` 위에 선다 — 새 proxy 금지.**
- custom/private registry 차단을 여기서 고정한다(`shadcnReadPolicy.ts` 인자 강제 확인 후 부족분만 추가).
- 완료: offline(fake npx fixture — 기존 테스트 패턴 재사용)로 end-to-end + 차단 mutation red.

### T3 — 디자인 파이프라인 배선 (kernel 위)
- ux_ui task가 T1 산출물을 만들고, kernel artifact + 사람 gate(M7 `decision_pending` 패턴)를 지나는 경로.
- 완료: 사람 gate 우회 경로 없음 red-path.

### T4 — design review(fresh Codex) → 수정(fresh design worker) 왕복
- 기존 리뷰 흐름(AGENTS.md 분업) 위에 배선. fresh-session 강제는 M6 `attemptId` 패턴 재사용.
- 완료: 같은 세션 재사용 거부 red.

### T5 — handoff 계약 + 접근성·범위 검증
- 핵심 화면 설계 → 토큰 기반 구현 handoff의 입력 계약 + §4의 접근성·범위 체크.
- 완료: 각 체크 mutation red.

### T6 — live 1회 (필요 시 · 사용자 승인 필수 — §6)
- 실제 모델이 DESIGN.md/tokens.json을 산출하고 shadcn registry를 실조회하는 왕복 1회.

### T7 — acceptance + mutation 확인 + 대장·로드맵 갱신 **(최종·직렬)**
- `scripts/acceptance.sh`에 **Test 20** 추가 · 각 체크 mutation red 확인 · 전체 suite 1회 ·
  로드맵 M8 절에 **증명/미증명을 같은 무게로** 기록(M7 진행 판정 절이 형식의 본보기다).

**병렬 요약**: `T1` → (`T2` ∥ `T3`) → `T4` → `T5` → `T6`(승인) → `T7`.

---

## 6. ⚠️ 과금 게이트

M8 스펙에는 **외부 유료 API가 없다.** shadcn registry(`ui.shadcn.com`)는 무료 공개 registry이고
API key가 필요 없다. 과금 후보는 **live LLM 왕복뿐**이다.

| 무엇 | 과금 | 언제 |
|---|---|---|
| T1~T5 (계약 · shadcn 배선 · 파이프라인 · 리뷰 왕복 · handoff 검증) — offline·mock·fixture | **없음** | 지금 바로 진행 가능 |
| shadcn registry 실조회(네트워크) | **없음**(무료 공개) — 단 네트워크 실행 자체는 사용자에게 알린다 | T2 live 확인 시 |
| live LLM 왕복(design worker · Codex review) | **있음**(구독/토큰) | T6 |

**따라서**: T1~T5를 offline으로 전부 세운 뒤 **T6 착수 전에 사용자 승인을 받는다.** mock으로 통과한 것을
live 통과로 적지 않는다 — 로드맵 M8 절에 "**미증명 — live 미실행**"으로 적는 것이 거짓 완료 선언보다 낫다.
M7이 정확히 이 형식으로 판정을 남겼다(부분 증명·표본 1건 명시).

---

## 6.5 M8 범위 경계

아래는 **M8이 하는 일이 아니다** — 다른 마일스톤에 배치돼 있으니 M8 세션이 손대지 마라.

| 항목 | 어디로 | 왜 M8이 아닌가 |
|---|---|---|
| `run_process` action enum 확장(테스트 실행) | **M9 선결(하드 게이트)** | 구현 파이프라인의 전제 |
| `B-16` 신규 파일 발행 · `B-17` inbox ack · `F2` 진행률·ETA | **M9 선결** | 병렬 worker 구현 마일스톤의 전제 |
| Tech Lead task DAG · worker 병렬 worktree 구현 · code/security/test review | **M9** | 개발 파이프라인 |
| `F3` 문서 완료 → Claude Code 핸드오프 | **M10** | 문서 파이프라인이 전부 선 뒤 |
| resume/crash recovery/도그푸딩 감사 게이트 | **M10** | 하드닝 |
| Figma read(design_source 조건부) · stack별 QA · `F1` cross-project 학습 | **§11 선택적 확장 / 조건 충족 시** | 조건 미충족(figma 프로젝트 없음) |
| `design_write` · shadcn install(`get_add_command_for_items`) | **금지 — 배치 없음** | capability deny + 정책 차단 |

M8이 **하는** 일은 §4 표의 완료 조건뿐이다. 그 표에 없는 기능은 대장에 적고 넘긴다.

---

## 7. 위험 4건

1. **범위 폭발** — "디자인"은 무한히 커진다. 화면 렌더링·시각 diff·스크린샷 검증·Figma 연동·컴포넌트
   코드 생성은 §4에 없다. **만들지 않는다.** 대장에 적고 넘긴다.
2. **접근성 체크의 공허함** — 렌더링 없이 검증 가능한 범위를 먼저 정직하게 정의하지 않으면 "통과가 쉬운
   체크"가 된다. M5에서 공허한 체크로 A급을 세 번 맞았다. 검증 가능한 것과 범위 밖을 문서에 나눠 적고,
   각 체크는 mutation red로 확인한다.
3. **shadcn 계층 재발명** — proxy·정책·probe가 이미 있고 live까지 통과했다. "새로 짜는 게 빠르겠다"가
   가장 흔한 슬립이다. `shadcnReadPolicy.ts`를 먼저 읽고 부족분만 추가한다.
4. **registry 응답의 injection** — component 설명·예제 코드는 외부에서 온 데이터다. M7의
   "데이터이며 지시가 아님" 래핑과 원문/발췌 분리(`evidenceStore` 패턴)를 registry 응답에도 적용한다.
   원문을 프롬프트·중앙 state에 그대로 싣지 않는다.

---

## 8. 작업 방침 (M5~M7에서 확정 — 그대로 따른다)

- **배송 우선(MVP-first)**: A급·크리티컬은 즉시 수정, B/C는 대장에 기록하고 보류. 진행을 멈추지 않는다.
- **A급에 포함**: 승인·인증·상태 전이 우회 · 데이터 손실 · 거짓 성공 영수증 · 문서·주석·커밋 메시지의
  과대주장 · secret 유출.
- **테스트 완화·삭제 금지** · **과대주장 금지** — 속도와 교환하지 않는다.
- **acceptance를 만들면 mutation으로 red가 되는지 확인한다.** M6에서 2건, M7에서 1건(발췌=원문 버그)을
  실제로 잡았다.
- **모델 분업**: 맥락·계획·적대적 read-only 리뷰 = fresh Fable 5 / 구현·리비전·통합 = fresh Opus 5.
  design review는 fresh Codex(로드맵 M8 절). 자기 산출물을 자기가 승인하지 않는다.
- **병렬**: 파일 소유권이 겹치지 않으면 격리 worktree. 공유 schema/API·통합·최종 전체 테스트는 직렬.
- **git 흐름**: issue 1건 → PR은 변경 1000줄 이하 분할 → 머지. `git add -A` 금지,
  `dist/exec/codexCliProvider.js`는 건드리지 않는다(무관하게 dirty).

---

## 9. 첫 착수 지점 (T1)

1. `docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md` §5 ux_ui 행 + §6.4 — profile·차단 판정의 정본.
2. `src/tools/shadcnReadPolicy.ts` — **이미 차단하는 것**을 먼저 읽는다(중복 구현 금지).
3. `registry/tool_profiles.json` `handoff-shadcn-readonly` — M8 worker가 받을 profile의 현재 모양.
4. v1 문서 검증(필수 섹션 헤더 경고) 코드 — `DESIGN.md`/`tokens.json` 검증기의 기존 패턴 확인
   (정확한 파일 위치는 착수 시 확인 · 미확인).

---

## 10. 완료 판정 기준

- §4 표의 각 완료 조건이 **어디서 증명됐는지** 로드맵 M8 절에 적혔고, **미증명 항목도 같은 무게로** 적혔다.
- acceptance **Test 20**의 각 체크가 **mutation으로 red 확인**됐다.
- `scripts/acceptance.sh` 전체 green(현재 140 + M8 증가분).
- 전체 suite 직렬 1회: `test:exec` · `test:core` · acceptance · `tsc --noEmit`.
- 대장에 M8에서 닫은 항목과 **새로 등록한 항목**이 전부 기록됐다.
- **live를 돌렸다면** 그 사실과 비용·횟수를, 돌리지 않았다면 **미증명**을 명시했다.
