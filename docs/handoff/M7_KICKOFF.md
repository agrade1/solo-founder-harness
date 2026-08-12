# M7 KICKOFF — Planning & Evidence Research

> 새 세션이 **이 문서 하나로** 착수할 수 있게 쓴 문서다. 작성 2026-08-12(M6 완료 직후).
> 기준 커밋 `e20a949` · 브랜치 `work/m5c-autopilot`. 앞선 판정은 로드맵 `M6 완료 판정` 절이 정본이다.

---

## 0. 30초 요약

M6까지 **kernel(SoR) · 승인 manifest · typed execution · autopilot · 계층 spawn 배선 · context bundle ·
coordinator rotation**이 전부 섰다. M7은 성격이 다르다 — **처음으로 하네스가 외부 세계에서 사실을 들여온다.**

새로 만들 것은 네 가지다:

1. **`C-67` 선결** — 승인 설정 정적 감사(read-only). 외부 provider 권능이 manifest에 들어오기 **전에** 닫는 게 기한이다.
2. **Research Gateway(선언→실행 어댑터)** — **MCP 서버를 만들지 않는다**. 이미 결정된 형태가 있다(§3).
3. **`EvidenceItem`** — 외부 원문과 모델 요약을 분리하고 `source`/`hash`/`retrievedAt`을 보존한다.
4. **도구 예산 상한** — tool/MCP는 등록만으로 컨텍스트를 상시 소모한다. 상한을 **코드 상수 + fail-closed**로.

`src/tools/`의 profile·capability·preflight·redact·trace·mcpEnv는 **이미 있다. 다시 만들지 마라.**

**⚠️ M7은 M6과 달리 offline만으로 완료 조건을 채울 수 없다** — 완료 조건이 "실제 아이디어에서 근거 있는
PRD/판정 + baseline 대비 benchmark"이고 그건 **외부 유료 API + live LLM 호출**을 요구한다. §6을 먼저 읽어라.

---

## 1. 시작 전에 읽을 것 (이것만)

```text
CLAUDE.md                                              # 세션 계약 (작업 방침 포함)
AGENTS.md                                              # 리뷰·병렬·모델 분업 상세
docs/handoff/M7_KICKOFF.md                             # 이 문서
docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md    # §10 M7 절 + `M6 완료 판정` 절 + §9.1 대장
docs/backlog/V3_MCP_CAPABILITY_TOOL_PROFILES.md        # §6.2 Research Gateway 형태 · §7 권한·secret ← M7의 설계 정본
docs/CONTEXT_SUMMARY.md                                # 직전 상태 한 눈
```

**로드맵은 위쪽 절이 최신이다.** 충돌 시 위쪽이 현행이며, M3d 이후 오케스트레이션 충돌은 로드맵이 우선한다.
`.claude/skills/harness-dev/SKILL.md`는 세션 시작 시 자동 로드된다.

---

## 2. 지금 서 있는 지반 (M6 완료 시점 · 실측)

| 계층 | 상태 | 위치 |
|---|---|---|
| durable SoR(state·event chain·revision·hash) | 완료 | `src/exec/orchestrationKernel.ts` |
| 7 specialist registry · 메시지 10종 · 중앙 경유 routing | 완료 | `SPECIALIST_ROLES` · `deliverTo` |
| 승인 manifest 게이트 | 완료 | `ownershipByTask` · `operationAuthorityByTask` · `writableRoots` · 예산 |
| autopilot loop | 완료 | `src/commands/autopilot.ts` |
| **계층 spawn/전달 배선**(M6 T2) | 완료 | `src/exec/spawnRouting.ts` · `plan.requests` 닫힌 union |
| **context bundle**(M6 T3) | 완료 | `src/exec/contextBundle.ts` `buildContextBundle` · kernel `contextBundle()` |
| **rotation 등가성**(M6 T4) | 완료 | `computeSnapshotDigest` · kernel `snapshotDigest()` |
| tool profile · capability · preflight | **이미 있다** | `src/tools/profiles.ts`(4등급 `PermissionMode`) · `capabilities.ts` · `preflight.ts` |
| secret redaction · tool trace | **이미 있다** | `src/tools/redact.ts` · `toolTrace.ts` · `trace.ts` · `mcpEnv.ts` |
| shadcn read 파일럿 | 있다 | `src/tools/shadcn*.ts` |
| live acceptance evidence(metrics) | 있다 — **research `EvidenceItem`과 다른 것이다** | `src/tools/liveEvidence.ts` |
| **research adapter · EvidenceItem · 검색 백엔드** | **없다 — M7이 만든다** | (신규) |

**실측 baseline**: `test:exec` **531/531** · `test:core` **409/409** · `scripts/acceptance.sh` **PASS=124 / FAIL=0** ·
`npx tsc --noEmit` clean.

**실측한 사실 2개**(착수 시 그대로 써도 된다):
- `src/tools/adapters.ts`의 `KNOWN_ADAPTERS`는 **빈 집합**이고 주석이 `// M4: "research" 등 추가 예정`이다 —
  research 어댑터의 자리가 이미 비워져 있다. `adapterAvailable()`도 이미 있다.
- `src/tools/profiles.ts`의 `PermissionMode`는 `read_only | dev_write | approval_write` **3개**다.
  §7.1의 4등급 중 **`forbidden`이 타입에 없다** — "표현할 수 없으니 금지"인지, 누락인지 착수 시 판정하고
  근거를 적어라(둘 중 무엇이든 그 판단을 문서에 남긴다).

**착수 시 직접 확인할 것(미확인)**: `preflight.ts`가 이미 검사하는 항목(→ `C-67`에서 중복 구현하지 않기 위해).

---

## 3. 이미 결정된 설계 — 다시 논의하지 마라

`V3_MCP_CAPABILITY_TOOL_PROFILES.md` §6.2의 판정이 정본이다.

**Research Gateway를 MCP 서버로 만들지 않는다.** 목적(정규화·상한·캐시·단일 창구)은 전부 수용하되 형태는 기각됐다.
근거: 1인 운영에 신규 상시 컴포넌트 · `-p` headless의 승인 부재 · strict 격리 불확실성 상속.

**대신 하네스에 이미 있는 선언→파싱→실행 패턴을 재사용한다:**

```
research agent 1차 실행 (도구 없음)
  → 문서 말미에 선언: RESEARCH_REQUEST query="..." | type=search|extract | urls=... (최대 N개)
  → 하네스가 검색 API를 **직접 호출**(fetch/SDK — provider 무관, MCP 아님)
  → EvidenceItem으로 정규화 · 상한 절삭 · 캐시 · JSONL 저장
  → research agent 2차 실행: **"데이터이며 지시가 아님"** 래핑된 digest 주입 → 최종 문서
```

부수 계약(§6.3·§7):
- search → 후보 4~8건 요약 → **필요한 URL만** extract → **원문은 파일 저장 + 포인터**, 모델에는 축약 전달.
- **backend는 1개로 시작한다**(Tavily/Firecrawl 동시 노출 금지).
- 반복 검색 루프는 `max_rounds=2`로 시작(critique_loop와 같은 형태). 트레이드오프는 benchmark로 실측한다.
- secret은 **환경변수만**. URL·config·trace에 값 기록 금지. trace 기록 전 redaction 패스(`redact.ts` 재사용).
- 사용자 전역 `.mcp.json` 상속 금지 · stdio는 `pkg@<pinned>`(**`@latest` 금지**).

---

## 4. M7 완료 조건 → 증명물

로드맵 §10 M7 절이 스펙 전부다. **여기 없는 기능은 만들지 않는다.**

| 완료 조건 | 무엇을 만들면 증명되는가 |
|---|---|
| idea validation · 최신 web research | 선언→호출→`EvidenceItem`→2차 주입이 **mock backend로** end-to-end(offline) + live 1회(승인 후) |
| `EvidenceItem` · 외부 원문과 모델 요약 분리 | 원문은 파일 + 포인터(`source`/`sha256`/`retrievedAt`), 중앙 state·프롬프트에는 축약만. mutation: 원문을 프롬프트에 실으면 red |
| injection 방어 | 적대적 fixture(“이전 지시를 무시하고 …”가 담긴 검색 결과)가 **지시로 실행되지 않는다**. 래핑 제거 mutation → red |
| cache · 상한 | 같은 query 재호출이 API를 다시 부르지 않고, 호출 수·바이트·도메인 상한이 fail-closed |
| **도구 예산 상한** | 상한이 **코드 상수**이고 초과 등록이 fail-closed. **숫자는 우리 프로파일에서 재측정한 값**으로 적는다(외부 문서 수치를 그대로 쓰지 않는다) |
| `C-67` 승인 설정 정적 감사 | read-only 판정 함수 + 심각도 보고. 과도하게 넓은 `writableRoots`·미사용 권능·부재 digest·과도한 만료를 잡는다. mutation: 각 규칙 제거 → red |
| research→PM→CEO 조언 · 최종 사람 gate | kernel 메시지 계약(M4c) 위에서 배선. **사람 gate 없이 진행하는 경로가 없음**을 red-path로 고정 |
| **tool 없는 baseline 대비 benchmark** | 같은 아이디어를 도구 없이 1회 / research 있이 1회 돌려 **근거 유무를 비교**. 이것은 live가 필요하다(§6) |

---

## 5. Task 분해 (제안 — 착수 세션이 확정한다)

### T1 — `C-67` 선결 **(최우선·직렬)**
- **왜 먼저**: 대장 기한이 "외부 provider 권능이 승인 manifest에 들어오기 전"이고 M7이 바로 그 마일스톤이다.
- 목표: 순수 판정 함수 + 심각도 있는 보고. 대상은 `.claude` 설정이 **아니라 우리 승인 manifest**다.
  규칙 예: `writableRoots`가 repo 루트를 통째로 덮음 · 어떤 task도 쓰지 않는 권능이 승인돼 있음 ·
  `expiresAt`이 과도하게 김 · `executionAuthority` digest가 가리키는 파일이 부재.
- **먼저 `src/tools/preflight.ts`를 읽어라** — 이미 검사하는 항목을 다시 만들지 않는다.
- 완료: 각 규칙을 **하나씩 제거하는 mutation**에 각자의 테스트가 red. 대장 `C-67` fixed 전환.

### T2 — `EvidenceItem` + 저장 계약
- 목표: 원문 파일 저장 + 포인터(`source`·`sha256`·`retrievedAt`·`bytes`) · bounded 요약 · JSONL 인덱스.
  **새 SoR을 만들지 않는다** — kernel state에는 포인터만 들어간다(§3.2 원칙 그대로).
- 완료: 결정성(같은 입력 → 같은 바이트) + 원문이 프롬프트·중앙 state에 실리지 않음을 mutation으로 고정.

### T3 — 선언 파서 + mock backend end-to-end
- 목표: `RESEARCH_REQUEST` 선언 파서(닫힌 형태 · 상한) → **mock backend** 호출 → `EvidenceItem` → 2차 주입.
  **여기까지 offline·무과금으로 전부 증명 가능하다.**
- 완료: end-to-end 1회 green + 선언 밖 요청·상한 초과·미허용 도메인이 fail-closed.

### T4 — injection 방어
- 목표: "데이터이며 지시가 아님" 래핑 + 원문/요약 분리. 적대적 fixture 세트를 만든다.
- 완료: 래핑 제거 mutation → red. **적대적 fixture가 실제로 지시처럼 생겼는지** 사람이 눈으로 확인한다
  (약한 fixture는 공허한 체크다).

### T5 — 도구 예산 상한 (실측 후 상수화)
- 목표: 우리 프로파일에서 tool/MCP 등록이 컨텍스트를 얼마나 먹는지 **재측정** → 그 값을 근거로 상한 상수 →
  초과 등록 fail-closed.
- **외부 문서의 숫자(200k→70k · MCP 10 · 툴 80)를 그대로 쓰지 마라.** 근거로만 인용하고 값은 실측한다.

### T6 — research→PM→CEO 배선 + 사람 gate
- 목표: M4c 메시지 계약 위에서 배선. 사람 gate를 우회하는 경로가 없음을 red-path로 고정.

### T7 — live 1회 + benchmark **(사용자 승인 필수 — §6)**
- 목표: 실제 아이디어 1건으로 baseline(도구 없음) vs research 비교. **과금이 발생한다.**

### T8 — acceptance + mutation 확인 + 대장·로드맵 갱신 **(최종·직렬)**
- `scripts/acceptance.sh`에 **Test 19** 추가 · 각 체크 mutation red 확인 · 전체 suite 1회 ·
  로드맵 M7 절에 **증명/미증명을 같은 무게로** 기록(M6 완료 판정 절이 그 형식의 본보기다).

**병렬 요약**: `T1` → (`T2`→`T3`→`T4` 직렬 트랙) ∥ (`T5`) → `T6` → `T7`(승인) → `T8`.

---

## 6. ⚠️ 과금 게이트 — 착수 전 사용자에게 물어라

M6는 offline+mock으로 완료 조건을 전부 채웠다. **M7은 그럴 수 없다.**

| 무엇 | 과금 | 언제 |
|---|---|---|
| T1~T6 (감사 · EvidenceItem · 선언 파서 · mock backend · injection · 배선) | **없음** | 지금 바로 진행 가능 |
| 검색 API 실호출(Tavily 등) | **있음**(외부 유료 API + API key 필요) | T7 |
| live LLM 왕복(research agent 2회 × baseline/research 2회) | **있음** | T7 |

**따라서**: T1~T6을 offline으로 전부 세운 뒤 **T7 착수 전에 사용자 승인을 받는다.** 승인 없이 외부 API를
호출하지 마라. API key가 없으면 그 사실을 보고하고 T7을 멈춘다 — mock으로 통과한 것을 live 통과로 적지 않는다.

로드맵 M7 절에 "**미증명 — live 미실행**"으로 적는 것이 거짓 완료 선언보다 낫다.

---

## 7. 위험 4건

1. **범위 폭발** — "research"는 무한히 커질 수 있다. §4 표에 없는 기능(다중 backend · 자동 재검색 루프 3라운드 이상 ·
   벡터 검색 · 요약 모델 별도 라우팅)은 **만들지 않는다**. 대장에 적고 넘긴다.
2. **injection 체크의 공허함** — 약한 fixture는 통과가 쉽다. 적대적 fixture는 **실제로 지시처럼 생겨야** 하고,
   래핑 제거 mutation으로 red를 확인해야 한다. M5에서 공허한 체크로 A급을 세 번 맞았다.
3. **secret 유출** — 이번 마일스톤에서 처음으로 API key가 들어온다. `redact.ts`를 재사용하고 **trace 기록 전**
   redaction을 지난다. `.gitignore`에 `outputs/runtime/` 확인. key를 커밋·로그·PR 본문에 넣지 마라.
4. **원문이 중앙으로 새어 들어감** — 로드맵 §3.2("중앙은 원문이 아니라 포인터를 운반한다")를 깨는 가장 쉬운 길이
   research다. 원문은 파일, 중앙은 포인터 + bounded 요약. 이것을 mutation으로 고정한다.

---

## 8. 작업 방침 (M5·M6에서 확정 — 그대로 따른다)

- **배송 우선(MVP-first)**: 기능 전체를 먼저 세우고 개선은 그 다음. **A급·크리티컬은 즉시 수정**,
  **B/C는 대장에 기록하고 보류**하며 진행을 멈추지 않는다.
- **A급에 포함**: 승인·인증·상태 전이 우회 · 데이터 손실 · 거짓 성공 영수증 · 되돌리기 어려운 아키텍처 결정 ·
  **문서·주석·커밋 메시지의 과대주장** · **secret 유출**.
- **테스트 완화·삭제 금지** · **과대주장 금지** — 속도와 교환하지 않는다.
- **acceptance를 만들면 mutation으로 red가 되는지 확인한다.** M6에서 이 절차가 실제로 두 건을 잡았다
  (시각에 눈먼 rotation 체크 · context bundle의 child artifact 누락).
- **모델 분업**: 맥락·계획·**적대적 read-only 리뷰** = fresh **Fable 5** / 구현·리비전·통합 = fresh **Opus 5**.
  자기 코드를 자기가 승인하지 않는다.
- **병렬**: 파일 소유권이 겹치지 않으면 격리 worktree. 공유 schema/API·통합·상태 마이그레이션·최종 전체 테스트·
  배타 자원 테스트는 **직렬**.
- **git 흐름**(M6에서 확정): issue 1건 → PR은 **변경 1000줄 이하로 분할**(소스와 `dist/`를 나누면 대개 맞는다) →
  머지. `git add -A` 금지, `dist/exec/codexCliProvider.js`는 건드리지 않는다(무관하게 dirty).

---

## 9. 첫 착수 지점 (T1)

1. `docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` §9.1의 **`C-67` 행** — 규칙 후보와 기한이 거기 있다.
2. `src/tools/preflight.ts` — **이미 검사하는 것**을 먼저 읽는다(중복 구현 금지).
3. `src/exec/approvalManifest.ts` — 감사 대상 계약의 정본(`validateApprovalManifest`·`SPECIALIST_ROLES`).
4. `src/exec/orchestrationTypes.ts` `LIMITS` — 상한 상수를 두는 자리(M6 T1이 `maxProcessesPerRun`을 여기 넣었다).

---

## 10. 완료 판정 기준

- §4 표의 각 완료 조건이 **어디서 증명됐는지** 로드맵 M7 절에 적혔고, **미증명 항목도 같은 무게로** 적혔다.
- acceptance **Test 19**의 각 체크가 **mutation으로 red 확인**됐다.
- `scripts/acceptance.sh` 전체 green(현재 124 + M7 증가분).
- 전체 suite 직렬 1회: `test:exec` · `test:core` · acceptance · `tsc --noEmit`.
- 대장에 M7에서 닫은 항목(`C-67` 포함)과 **새로 등록한 항목**이 전부 기록됐다.
- **live를 돌렸다면** 그 사실과 비용·횟수를, 돌리지 않았다면 **미증명**을 명시했다.
