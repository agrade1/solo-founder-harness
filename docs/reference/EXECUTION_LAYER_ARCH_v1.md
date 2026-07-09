# EXECUTION_LAYER_ARCH.md

실행 계층(execution layer) 아키텍처 설계 확정본 — v0.3

- **작성일**: 2026-07-08 (v0.1 → v0.2 → v0.2.1 → **v0.3: RECON 실측 반영 + DESIGN_QUESTIONS Q1~Q3 결정**)
- **입력**: EXECUTION_LAYER_DESIGN_BRIEF.md §8 + 창업자 결정 + EXECUTION_CLI_RECON.md(실측) + EXECUTION_DESIGN_QUESTIONS.md(Q1~Q3)
- **상태**: 설계안. §11이 구현 블로킹 질문에 대한 확정 답 — §9-2 마감 가능
- **v0.3 개정 요지**:
  1. **Q1 결정: 세션 수명 = Model A(호출당 프로세스 + resume) 확정** — 잠정 구현 그대로 승격, B(지속형 stdin)는 기각
  2. **Q2 결정: initialPrompt = 하이브리드 조립** — SPEC·API_CONTRACT 인라인, 배경 문서는 경로+Read
  3. **Q3 결정: turn 예산 초과 = 그레이스 1턴(WIP 커밋) 후 stop → DEFERRED**
  4. RECON 반영: max_turns는 오케스트레이터 정책값, `--fallback-model`로 강등 사다리 CLI 폴백, `rate_limit_event` 실데이터 구동, `--session-id` 사전 할당, `--verbose` 필수
- **v0.2 개정 요지**:
  1. Agent SDK 전환 계획 **삭제** — 구독 기반 claude CLI로 확정 (미래 슬롯도 두지 않음)
  2. **모델 정책 다이얼** 추가 — 기본은 전 역할 Opus, 한도 병목 시 구현만 Sonnet 강등 (v0.2.1에서 확정)
  3. **리뷰 게이트** 신설 — critique_loop 패턴의 실행 계층 이식 (3층 품질 방어)
  4. 불변 원칙 재정의 — "무인 금지" → **"main 반영만 사람"**. develop까지는 자율 허용
  5. **v3.5 미션 모드** 신설 — 단일 목표 자율 완주(밤샘 가능) + rate limit 체크포인트/재개

---

## 0. 설계 한 장 요약

```
[사고 계층 — 기존 v2]                    [실행 계층 — 신규]
idea-validation / mvp-planning        ┌─ Orchestrator (하네스 프로세스)
        │                             │   ├ SessionManager: 세션 수명/상태머신
        ▼                             │   ├ ApprovalQueue: 게이트 직렬화·보류(defer)
dev-preflight ──► SPAWN 선언 ─────────►│   ├ Mailbox: 세션↔세션/사람 메시지 라우팅
        │                             │   ├ Reviewer: Opus 리뷰 세션 (코드 게이트)
        ▼                             │   └ StatusBoard + MISSION_REPORT
SessionSpec 생성 (task-prompt 확장) ──►│
                                      │  세션 N개 = claude CLI headless (구독)
                                      │  각 세션 = git worktree 1개 (격리)
                                      ▼
   [미션 브리프 승인] → 자율 실행 → 기계 게이트(lint/type/test/build)
                                      ▼
              Opus 리뷰어 승인 → develop 자동 푸시 (여기까지 무인 OK)
                                      ▼
              [사람: MISSION_REPORT 확인 → main 병합·푸시]  ← 유일한 사람 게이트
```

핵심 결정 4줄:
1. 실행 = **claude CLI 헤드리스, 구독 토큰 전용** (SDK 없음). 모델 정책: **기본 전부 Opus**, 한도 병목 시 구현만 Sonnet 강등
2. 격리 = **세션당 git worktree + 브랜치**, develop 병합·푸시는 게이트 통과 시 자동, **main만 사람**
3. 품질 = 리뷰 단독이 아닌 **3층 방어**: 기계 게이트 → 테스트 포함 DoD → Opus 리뷰어 세션
4. 세션 간 통신 = 직접 대화 금지, **오케스트레이터 중계(허브-스포크 메일박스)**

---

## 1. 실행 세션 provider (브리프 Q1) — 확정

**claude CLI 헤드리스, 구독 토큰 전용.** Agent SDK는 채택하지 않으며 전환 계획도 두지 않는다(창업자 결정: 과금 구조를 구독 하나로 고정). `ExecutionProvider` 인터페이스는 유지하되 목적은 SDK 대비가 아니라 테스트용 mock 실행기와의 교체 가능성.

```ts
interface ExecutionProvider {
  start(spec: SessionSpec): Promise<SessionHandle>;      // 세션 생성
  send(h: SessionHandle, msg: string): Promise<void>;    // 지시 주입 (resume)
  events(h: SessionHandle): AsyncIterable<SessionEvent>; // stream-json 파싱
  stop(h: SessionHandle, reason: string): Promise<void>;
}
```

호출 확정형 (RECON §1·§5 실측, claude 2.1.204 핀):

```
claude -p --output-format stream-json --include-partial-messages --verbose \
  --permission-mode acceptEdits --allowedTools <컴파일 목록> \
  --model <spec.model> --fallback-model <강등대상> \
  --session-id <사전할당 uuid> --add-dir <허용 경로> \
  --append-system-prompt <역할>
```

- `--verbose`는 print+stream-json 조합에서 **필수**(없으면 즉시 에러 — 실측).
- 세션 ID는 오케스트레이터가 **사전 할당**(`--session-id`) — run_state.sessions[] 추적이 기동 전에 성립.

### 1.0 세션 수명 모델 = Model A 확정 (DESIGN_QUESTIONS Q1 — 블로킹 해소)

**호출당 프로세스(one-shot) + `--resume` 연속.** 잠정 구현(claudeCliProvider)을 그대로 확정 승격한다. B(지속형 stdin 단일 프로세스)는 기각.

근거:
1. **CLI의 공식 계약과 일치** — `claude -p`는 호출당 1회가 기본 사용법이고 `--resume`이 공식 연속성 경로. 컨텍스트 재로드 비용은 프롬프트 캐시가 대부분 흡수하며, 이는 turn당 수 초 수준의 오버헤드로 밤샘 미션에서 무시 가능.
2. **복구 경로가 A의 부분집합이 아니라 A 그 자체** — 미션 모드의 체크포인트/재개(rate limit 대기, 오케스트레이터 재시작)는 결국 "프로세스 없음 → `--resume`"이다. B를 채택해도 프로세스가 죽으면 resume으로 돌아오므로, A는 복구 경로를 상시 경로로 쓰는 것 = 코드 경로 1개.
3. **행(hang)·좀비 리스크 제거** — 장수명 프로세스 관리, stdin 프로토콜 실측, 정지 처리 복잡성이 전부 사라짐. 무인 밤샘에서 가장 위험한 실패 모드(조용히 멈춘 프로세스)를 구조적으로 회피.
4. v4 병행도 `claude agents --bg`(RECON 실측 존재)가 있어 지속 프로세스 직접 보유의 이점이 추가로 희석됨.

**events() 소비 계약 (확정)**: provider 레벨은 **invocation(turn) 단위 스트림** — `start()`/`send()`가 각각 새 invocation을 낳고, `events()`는 최근 invocation의 스트림을 `result`까지 흘린다(현 구현 그대로). 세션 수명 전체를 잇는 논리 스트림이 필요하면 **오케스트레이터의 SessionRunner가 합성**한다(turn 경계에 `turn_started`/`turn_ended` 메타 이벤트 삽입). provider 계약을 단순하게 유지하고 합성 책임을 상위로 — mock provider와의 대칭성도 유지된다.

### 1.1 모델 정책 다이얼 (v0.2.1 확정 — 창업자 결정)

전제 확인: Team Premium 시트는 Claude Code에서 Opus 사용에 제약이 없다 (기본 모델이 Opus, Opus 전용 캡 제거, 1M 컨텍스트 자동). 따라서 배분은 "가능/불가능"이 아니라 **한도 소진 속도 대 품질**의 다이얼이며, 아래 사다리로 운영한다.

| 단계 | 정책 | 적용 조건 |
|---|---|---|
| **B (기본)** | **전 역할 Opus** — 계획·구현·리뷰 전부 | 미션 시작 기본값. 첫 미션에서 소모 프로파일 계측 |
| C (1차 강등) | 난이도 라우팅 — tech_lead(Opus)가 태스크 분해 시 어려운 태스크만 `model: opus`, 단순 구현은 `sonnet`. 계획·리뷰는 항상 Opus | 미션 중 rate limit 대기가 임계(기본: 누적 대기 > 1h 또는 2회) 초과 시 |
| A (2차 강등) | 구현 전부 Sonnet, 계획·리뷰만 Opus ("Opus가 설계하고 검수하는 Sonnet 공장") | C로도 주간 한도 압박 시 |

- 강등은 **미션 브리프의 `degrade_on_limit: auto | ask` 설정**을 따른다: `auto`면 무인 중 자동 강등(MISSION_REPORT에 기록), `ask`면 보류 후 대기. 기본 `auto` — "막히면 Sonnet으로 내린다"는 운영 의도 반영.
- 어느 단계든 **리뷰어는 Opus 고정** — 리뷰는 입력 무겁고 출력 짧아 소모가 적고, 강등 시 품질 방어의 마지막 층이므로.
- SessionSpec `model` 필드 = 단계별 산출값 (HARNESS_CLAUDE_MODEL은 최후 폴백). 요약·상태 정리 등 저부가 작업은 단계와 무관하게 Haiku/Sonnet.

---

## 2. 병행/다중 세션 격리 모델 (브리프 Q2)

### 세션당 git worktree + 전용 브랜치 (유지)

```
<repo>/.harness/worktrees/<run_id>/<session_id>/   ← 각 세션의 CWD
작업 브랜치: harness/<run_id>/<session_id>
통합 브랜치: develop                                ← 게이트 통과 시 자동 병합·푸시 (v0.2 변경)
보호 브랜치: main                                   ← 사람 전용
```

- v0.1의 `harness/<run>/integration` 임시 브랜치를 **develop으로 대체** — 창업자 워크플로우(develop 자동/ main 수동)와 일치. run 단위 격리가 필요하면 develop 위에 run 브랜치를 선택 옵션으로.
- 충돌은 병합이 아니라 **예방**으로: SessionSpec의 ownership globs가 담당 경계, 세션 간 공유 지점은 코드가 아닌 `docs/API_CONTRACT.md`.
- 병합 순서: 완료 세션부터 develop에 직렬 병합 → 기계 게이트 재실행 → 실패 시 해당 세션에 revise 자동 주입.

---

## 3. 오케스트레이션 실행 모델 (브리프 Q3)

### 3.1 SessionSpec (task-prompt의 승격)

```yaml
# projects/<p>/outputs/sessions/<session_id>/SPEC.yaml
session_id: fe-screens
role: "프론트엔드 — 신호등 리포트 화면"
model: opus                                      # v0.2.1 기본 정책 B: 전부 Opus. 강등 시 다이얼이 재산출
inputs: [docs/02_PRD.md, docs/03_UX.md, docs/API_CONTRACT.md]
ownership: ["src/app/**", "src/components/**"]
forbidden: ["API_CONTRACT 변경"]
dod:                                             # v0.2: 테스트가 DoD의 1급 시민
  - "주소 입력→신호등 요약 화면 렌더"
  - "핵심 로직 단위 테스트 작성 + 통과"
  - "typecheck/lint/build 통과"
budget: { max_turns: 40 }   # CLI 플래그 아님(RECON §2.1) — 오케스트레이터가 assistant 이벤트 카운트로 강제
```

### 3.1.1 착수 프롬프트 컴파일러 (DESIGN_QUESTIONS Q2 결정 — 하이브리드)

`start(spec, initialPrompt)`의 `initialPrompt`는 오케스트레이터의 **PromptCompiler**가 SessionSpec에서 조립한다. 규칙:

| 구성 요소 | 처리 | 근거 |
|---|---|---|
| 태스크 브리핑 + role/ownership/forbidden/dod | **인라인** (짧음) | 세션의 헌법 — 오독 불가 |
| `docs/API_CONTRACT.md` **전문** | **인라인** | 계약 오독이 세션 간 충돌의 최대 원인이자 가장 비싼 실패. 보통 짧아 토큰 부담 미미 |
| PRD·UX 등 배경 문서 (inputs 나머지) | **경로 목록 + "필요 시 Read" 지시** | 전문 인라인은 정책 B(전부 Opus)에서 토큰 폭증. Read는 T0 자동이라 세션이 스스로 선별 — MINIMAL_CONTEXT_LOAD_POLICY 정합 |
| STATUS.md 갱신 계약 (§3.3 스키마) | **인라인** | 허브-스포크 통신의 전제 |

조립 순서 고정: ①태스크 ②SPEC 요약 ③API_CONTRACT ④배경 문서 경로+지시 ⑤STATUS 계약 ⑥DoD/금지 재확인. 권한 연동: inputs 경로가 worktree 밖(`docs/`)이면 `--add-dir`에 포함, allowedTools의 Read는 T0 기본(§9-3 권한 컴파일러).

### 3.1.2 turn 예산 초과 동작 (DESIGN_QUESTIONS Q3 결정 — 그레이스 후 보류)

max_turns 도달 시 **(b) 변형: 그레이스 1턴 → stop → DEFERRED**:

1. 오케스트레이터가 assistant 이벤트 카운트로 한도 감지 → 마지막 지시 1회 주입: *"예산 소진. 새 작업 금지. 진행 상황을 STATUS.md에 기록하고 미완 변경을 자기 브랜치에 WIP 커밋하라"* (그레이스 상한 +2 turn, 이 안에 result 안 오면 강제 stop)
2. `stop()` → 태스크 상태 `DEFERRED(budget_exhausted)` → 미션은 다음 태스크로 진행
3. MISSION_REPORT에 num_turns(result 검증값)/budget/WIP 커밋 해시 기록 — 사람이 아침에 "예산 증액 재개 vs 태스크 분할" 결정

기각한 선택지: (a) 즉시 kill — uncommitted 변경이 worktree에 뜬 채 유실되고 재개 컨텍스트가 사라짐. (c) 리뷰어 부분 평가 — 미완 코드는 L1 게이트가 어차피 develop 진입을 막으므로 Opus 리뷰 토큰만 낭비.
상태머신 전이 추가: `RUNNING → BUDGET_GRACE → DEFERRED`.

### 3.2 SPAWN 선언의 라이브 승격 (유지)
fanout planner의 `SPAWN id|name|focus` → SessionSpec 초안 자동 생성 → 착수 승인(미션 모드에서는 미션 브리프에 포함) → worktree+세션 기동.

### 3.3 세션 간 통신 = 허브-스포크 (유지)
직접 대화 금지. 세션은 turn마다 `STATUS.md`(RUNNING|BLOCKED|QUESTION|SPLIT request|DONE) 갱신 — 스키마 검증·재생성 루프 적용. QUESTION/BLOCKED은 오케스트레이터가 메일박스로 라우팅(상대 세션 다음 turn 주입 / 계약 변경 제안은 리뷰어 검토). 사람 주입도 동일 통로: `harness tell <session|all> "..."`.

### 3.4 라이브 분화 SPLIT (유지)
트리거: 자기 신고 or 예산 80% 초과. 처리: HANDOFF 자동 생성 → (대화형: 승인 / 미션 모드: 사전승인 한도 내 자동) → 새 worktree, ownership 이관.

---

## 4. 게이트 체계 (브리프 Q4) — v0.2 전면 개정

### 4.1 품질 게이트: 3층 방어 (신규 — "리뷰로 보장 가능한가"에 대한 답)

리뷰 단독은 보장이 아니다. 리뷰가 잘 잡는 것(명백한 버그·규약 위반·계약 불일치·보안 안티패턴)과 못 잡는 것(테스트 없는 미묘한 로직 오류, 장기 아키텍처 드리프트, 스펙 자체의 오류)이 갈리므로 3층으로 쌓는다:

| 층 | 내용 | 성격 |
|---|---|---|
| L1 기계 게이트 | typecheck / lint / test / build 전부 통과 | 객관적 바닥. 협상 불가 |
| L2 테스트 DoD | 구현 세션이 코드+테스트를 함께 작성. 리뷰어의 1번 질문은 "테스트가 **올바른 것을** 검증하는가" | 미묘한 로직 오류의 주 방어선 |
| L3 리뷰어 세션 | **Opus, 신선한 컨텍스트**(코더 세션과 대화 이력 미공유 — 기존 conclusion_only 편향 분리 원칙 재사용). diff + SPEC + API_CONTRACT만 입력. ⚠ `--fork-session` 사용 금지 — fork는 코더 컨텍스트를 복제하므로 신선 컨텍스트 원칙과 정반대. 리뷰어는 항상 **새 세션** | critique_loop 패턴의 실행 계층 이식: Critical → 코더에 revise 주입, max_rounds=2, 초과 시 보류 목록행 |

L1~L3 전부 통과 = **develop 자동 병합·푸시 조건**. 아키텍처 드리프트는 리뷰 범위 밖이므로 미션 단위를 작게 유지(§6)하고 MISSION_REPORT에서 사람이 방향을 본다.

### 4.2 권한 티어 (v0.2 재분류 — 사람 동기 승인 최소화)

| 티어 | 정의 | 예 | 처리 |
|---|---|---|---|
| T0 자동 | 읽기·검증 | Read, git diff, lint/test | allowedTools 통과 |
| T1 자동 | 경계 내 작업 | ownership 내 Edit, 자기 브랜치 커밋, **develop 병합·푸시(L1~L3 통과 시)** | acceptEdits + 게이트 파이프라인 |
| T2 **정책** | 경계·환경 변경 | 의존성 추가, API_CONTRACT·스키마 변경, ownership 밖 수정, 다수 파일 삭제, 외부 API 호출 | **미션 사전승인 패키지** 범위 내 → 자동. 범위 밖 → **차단이 아니라 보류(defer)**: 해당 작업만 보류 목록에 넣고 우회 가능한 다른 작업 계속. 대화형 모드에서는 기존처럼 inbox 즉답 가능 |
| T3 금지 | 파괴·유출·최종 반영 | **main push**, force push, prod 배포, secret 접근·출력, `rm -rf` 류 | PreToolUse 훅 무조건 거부 + 이벤트 로그 |

### 4.3 사람 게이트 재정의 (불변 원칙 개정)

> 구 원칙: "완전 무인 자동 개발 금지 — 모든 실행에 사람 승인 게이트"
> **신 원칙: "main 반영·푸시·배포만 사람. develop까지의 개발 사이클(코딩→리뷰→병합→푸시)은 게이트 통과를 조건으로 자율."**

사람 접점은 3곳으로 축소: ① 미션 브리프 승인(시작 전 1회) ② 보류 목록 결정(비동기, 아침에) ③ main 병합(MISSION_REPORT 검토 후). CLAUDE.md / ROADMAP의 해당 문구도 이 개정에 맞춰 갱신할 것.

---

## 5. 상태 관측 (브리프 Q5)

- 상태머신: `SPEC_READY → RUNNING → (DEFERRED_ITEM 기록 | BLOCKED) → REVIEW → MERGED_DEVELOP | ABORTED`. `run_state.json`의 `sessions[]`에 기록, resume로 복원.
- StatusBoard(ProgressReporter 일반화) + `outputs/sessions/<id>/events.ndjson` 보존.
- CLI 표면:

```
harness mission --project zipda --goal "신호등 리포트 화면 완성"   # v3.5: 브리프 생성→승인→자율 완주
harness exec   --project zipda                                   # v3: 대화형 단일 세션
harness status --project zipda [--watch]
harness inbox  --project zipda            # 대화형 승인 + 보류 목록 결정
harness tell   <session|all> "메시지"
harness report --project zipda            # MISSION_REPORT 출력
```

---

## 6. 미션 모드 — 단일 목표 자율 완주 (v0.2 신규, 창업자 요구 반영)

### 6.1 흐름
1. `harness mission --goal "..."` → 오케스트레이터(Opus)가 **미션 브리프** 생성: 태스크 분해, 세션 계획, DoD, **T2 사전승인 패키지**(설치 예상 의존성 목록, 계약 변경 허용 범위, 예상 토큰 예산)
2. 사람이 브리프 승인 (유일한 시작 게이트) → 이후 무인
3. 태스크 단위로: 구현(모델 = §1.1 다이얼, 기본 Opus) → L1 기계 게이트 → L3 리뷰(Opus, revise 루프) → develop 병합·푸시 → 다음 태스크
4. 사전승인 밖 T2 조우 → 그 작업만 **보류**, 의존성 없는 다음 태스크로 진행. 전부 막히면 세션 유지한 채 정지(체크포인트)
5. 종료(완료/예산 소진/전면 보류) 시 **MISSION_REPORT.md**: 완료 태스크, develop 커밋 목록, 테스트 결과, 화면 스크린샷(가능 시), 보류 결정 목록, 토큰 사용량
6. 사람: 리포트 검토 → 보류 결정 → main 병합·푸시

### 6.2 rate limit 대응 (밤샘의 실질 제약) — v0.3: 이벤트 기반으로 구체화
무인 금지의 원 사유는 원칙이었지 토큰이 아니다 — 그러나 구독은 5시간 롤링 윈도우+주간 한도가 있어 밤샘 연속 실행은 중간에 한도 도달 가능성이 높다. RECON 실측으로 이 대응은 추측이 아니라 **CLI가 흘려주는 `rate_limit_event` 실데이터로 구동**된다:

- 신호: `rate_limit_info.status` 변화를 감시, `rateLimitType`(five_hour/weekly)으로 사유 구분, `overageStatus`로 유료 초과분 가용 여부 판단
- 대응 2단: ① **강등 사다리**(§1.1) — `degrade_on_limit: auto`면 B→C→A 자동 강등 + CLI 레벨 `--fallback-model` 이중화(리뷰어 Opus 고정, MISSION_REPORT에 강등 이력 기록) ② 강등으로도 막히면(weekly 등) **체크포인트 저장 → `resetsAt`(epoch)까지 대기 → 자동 재개** — Model A(§1.0) 덕에 재개는 그냥 `--resume`, 대기 중 살아있는 프로세스가 없다

### 6.3 미션 크기 가드
리뷰가 못 잡는 아키텍처 드리프트는 미션이 클수록 커진다. 가드: 미션 브리프의 태스크 수 상한(권장 ≤ 8), 초과 규모 목표는 브리프 단계에서 분할 제안. "하나의 목표 = 하룻밤" 단위를 기본으로.

---

## 7. 범위 로드맵 (브리프 Q6 개정)

| 버전 | 범위 | 포함 |
|---|---|---|
| **v3 — 대화형 단일 실행** | 세션 1개, 사람 동기 승인 | ExecutionProvider(CLI stream-json+resume), SessionSpec, 권한 컴파일(T0~T3 훅), 기계 게이트, diff 미리보기, tell, worktree 1개 |
| **v3.5 — 미션 모드** | 단일 목표 자율 완주 | 미션 브리프+사전승인 패키지, **Opus 리뷰어 세션(L3)**, develop 자동 병합·푸시, defer 보류 체계, rate limit 체크포인트/재개, MISSION_REPORT |
| **v4 — 병행 오케스트레이션** | 세션 N개 | SessionManager, SPAWN 승격, Mailbox, StatusBoard, SPLIT, 병렬 미션 |
| v4.5 | 관측 강화 | Playwright 화면 스크린샷 자동 첨부, 세션별 모델·예산 자동 재배분 |

**v3 수용 기준**: zipda에서 화면 1개를 세션이 자기 브랜치에 구현, T2에서 정지·승인, tell 반영, diff 승인 후 develop 병합.
**v3.5 수용 기준**: `harness mission` 한 번 승인 후 자리 비움 → 아침에 develop에 L1~L3 통과 커밋 N개 + MISSION_REPORT가 있고, main은 미변경.

---

## 8. 안전 baseline (브리프 Q7, v0.2 갱신)

1. 권한 최소화 컴파일: SessionSpec+PERMISSION_POLICY → allowedTools 화이트리스트, 목록 밖 기본 거부
2. 훅 이중화: T3(main push, force push, rm -rf, secret, prod)는 PreToolUse 훅 무조건 거부 — **develop push는 훅이 아니라 게이트 파이프라인(L1~L3)을 통해서만 허용** (세션이 직접 push하는 게 아니라 오케스트레이터가 수행)
3. blast radius: worktree 밖 쓰기 차단, secret/env 미전달, 네트워크 호출 T2
4. 예산 상한: max_turns + 미션 토큰 예산, 초과 시 체크포인트 정지
5. 신 불변: **main·배포·secret은 어떤 경로로도 자율 불가.** develop 자율은 L1~L3 게이트 전부 통과가 조건이며 게이트 우회 경로를 두지 않는다

---

## 9. 구현 순서 (v3 → v3.5) — v0.3 진행 상태

1. ~~CLI 실측 스크립트~~ **완료** (EXECUTION_CLI_RECON.md, claude 2.1.204 핀)
2. ~~ExecutionProvider(CLI) + 이벤트 파서 + 단일 세션 수명~~ **완료** (`src/exec/`, 단위 10/10) — Q1 확정으로 **잠정 딱지 제거, §9-2 마감**
3. 권한 컴파일러(티어→플래그+훅) — PERMISSION_POLICY를 기계가 읽는 JSON으로 병행 정리 ← **다음**
4. worktree 수명 + L1 기계 게이트 파이프라인
5. 대화형 게이트(stdinApprover→ApprovalQueue) + diff 미리보기 + tell + **PromptCompiler(§3.1.1)** → **여기까지 v3 acceptance**
6. Opus 리뷰어 세션(L3) + revise 루프 (critique_loop 이식)
7. 미션 브리프 생성기 + 사전승인 패키지 + defer 보류 체계 + 모델 강등 사다리(degrade_on_limit) + **turn 예산 강제(§3.1.2)**
8. develop 자동 병합·푸시 + rate limit 체크포인트/재개 + MISSION_REPORT  → **v3.5 acceptance**

## 10. 미결정/백로그
- **첫 미션 = 정책 B(전부 Opus)로 소모 프로파일 계측** → 강등 임계값(누적 대기 1h/2회) 기본값 보정. `result.total_cost_usd`·`modelUsage`가 구독 경로에서도 채워지므로(실측) USD/모델 단위 집계 가능
- v4 SessionManager 설계 시 `claude agents --bg` + `--json` 폴링 활용 검토 — 프로세스 핸들 직접 보유 필요성 재평가 (RECON §4)
- `--max-budget-usd`는 API 키 경로 전용 추정 — anthropic provider용 가드로만 백로그
- 스크린샷 자동화(Playwright)·모바일 뷰포트 — v4.5
- 병렬 미션 간 develop 경합 시 병합 순서 정책 — v4 설계 시

---

## 11. 결정 로그 — DESIGN_QUESTIONS 응답 (v0.3)

| # | 질문 | 결정 | 반영 위치 | 구현 영향 |
|---|---|---|---|---|
| Q1 ⭐ | 세션 수명: one-shot+resume(A) vs 지속형 stdin(B) | **A 확정, B 기각** | §1.0 | claudeCliProvider 잠정형 → 확정 (재작성 없음). events()=turn 단위 계약 유지, 세션 논리 스트림은 SessionRunner 합성 |
| Q2 | initialPrompt 조립 책임·포맷 | **하이브리드**: SPEC·API_CONTRACT 인라인 + 배경 문서 경로+Read | §3.1.1 | PromptCompiler 신규(§9-5), 권한 컴파일러의 Read=T0·add-dir 연동 |
| Q3 | turn 예산 초과 동작 | **그레이스 1턴(WIP 커밋+STATUS 기록) → stop → DEFERRED**. (a)즉시kill·(c)리뷰어평가 기각 | §3.1.2 | 상태머신에 BUDGET_GRACE 추가, 오케스트레이터 카운터(§9-7) |

> DESIGN_QUESTIONS.md의 세 항목은 이 표를 근거로 "결정됨(→ARCH §참조)" 마킹 가능. §9-2는 마감 확정.
