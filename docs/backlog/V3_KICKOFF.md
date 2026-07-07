# V3_KICKOFF.md

v3 착수 시 이 문서부터 읽는다. v2(v2.4.0, 2026-07-07 완료) 이후 계획.
작성일: 2026-07-07. 위치 제안: `docs/backlog/V3_KICKOFF.md`.

---

## 0. 착수 전 판정 (지금 v3 코드를 짜면 안 되는 이유)

ROADMAP.md의 v3 착수 조건:

```text
v2로 실제 아이디어 2개 이상 검증 완료. 하나라도 개발 착수까지 갔을 것.
```

현재 상태 (CONTEXT_SUMMARY 기준):

- 실전 실행: mvp-planning × 1회 (claude-code). ❌ 2개 미달
- full-predev CEO 게이트: 실발화 0회 (mock/stub만) ❌
- anthropic provider: 유료 호출 미검증 ❌
- v2 계획 항목 중 미구현: `--resume`, token budget, approval gate, Red Team 편향 분리, prompt versioning

**판정: v3 착수 조건 미충족.** 버전 승격 원칙(backlog → 스펙 → 구현)에 따라
v3 신규 기능 전에 아래 Phase 0 → Phase 1을 먼저 완료한다.

---

## 작업 순서 (의존 관계)

```
Phase 0. v2.5 안정화     → v2에서 약속한 안전장치 완성 (v3 선결조건)
Phase 1. 도그푸딩        → 실제 아이디어 2개로 착수 조건 충족 + 미검증 경로 실발화
Phase 2. v3.0 스펙 확정  → 반자동 실행 최소형 + 보안 baseline 승격
보류    . 2차 모델 리뷰 / 프로젝트 간 학습 (입력 데이터·선행 작업 부족)
```

---

## Phase 0 — v2.5 안정화 (코드 작업)

v2 ROADMAP에 있었으나 미구현된 항목. 전부 v3-1(반자동 실행)의 안전장치이기도 하다.

### 0-1. `run --resume` (FAILURE_RECOVERY 문서 → 코드)

- `RunState`에 재개 포인터 추가:

```ts
export interface RunState {
  // 기존 필드 유지
  status: "running" | "failed" | "completed";
  resume_from: number | null;   // 다음에 실행할 step index
  loop_state: {                 // 루프 중간 실패 대비
    step_index: number;
    critique_round?: number;
    gate_jumps_used?: number;
  } | null;
}
```

- `harness run <wf> --project <p> --resume`:
  - `outputs/run_state.json`의 `status === "failed"`면 `resume_from`부터 재개.
  - 완료된 step의 산출물(`docs/0N_*.md`)은 재생성하지 않고 컨텍스트로만 로드.
  - run_state가 completed면 안내 후 종료 (덮어쓰기 방지 — FAILURE_RECOVERY 원칙).
- 검증: mock provider + 강제 실패 stub(N번째 agent에서 throw) → resume으로 이어서 완주.

### 0-2. Token budget (집계 → 통제)

- `run --max-tokens <n>` / `HARNESS_MAX_TOKENS`. 기본은 무제한(현행 유지).
- 각 step 종료 시 누적 `input+output` 확인 → 초과 시:
  - 현재 step까지 저장, `run_state.status = "failed"`, `failed_reason = "token_budget_exceeded"`.
  - `--resume`으로 재개 가능해야 함 (0-1과 연계 — 이래서 resume이 먼저).
- 경고선: 예산의 80% 도달 시 stderr 경고 (TOKEN_COST_POLICY_TODO의 "비용 경고 기준" 승격).

### 0-3. Approval gate (workflow step 타입 확장)

- `WorkflowStep`에 4번째 타입 추가:

```json
{ "approval": { "message": "MVP 범위 확정. 계속?", "show": "03_TECH_PLAN.md" } }
```

- 동작: stdin으로 y/n 대기. n이면 `status="failed"`, `failed_reason="user_rejected"` 저장 후 종료 → `--resume` 가능.
- `--yes` 플래그로 비대화 모드(CI/스크립트)에서 전부 승인 스킵.
- APPROVAL_GATES_TODO의 지점 중 v2.5에서는 **"개발 착수 직전"** 1곳만 내장:
  - `dev-preflight` 마지막에 `{approval}` 추가.
- 나머지 지점(패키지 설치/DB/배포 등)은 v3 executor 쪽 책임 — 여기서 만들지 않는다.

### 0-4. Red Team 편향 분리

- critique_loop에서 critic 입력을 **target의 결론 문서만**으로 제한
  (현재는 프롬프트 빌더가 넘기는 컨텍스트 그대로 — `promptParts.ts` 확인 후 분리).
- `AgentRunInput`에 `contextMode: "full" | "conclusion_only"` 추가, critic 호출 시 후자.

### 0-5. 잔여 정리

- develop → origin/develop push, v2.4.0 태그 (CONTEXT_SUMMARY "다음 작업" 그대로).
- anthropic provider 유료 1회 실검증 (`--max-tokens`로 상한 걸고 — 0-2 완료 후).
- acceptance에 Test 7(resume), Test 8(budget), Test 9(approval `--yes`) 추가.

**Phase 0 완료 기준: `npm test` 전체 통과 + resume/budget/approval 각 1회 실동작 확인 → v2.5.0 태그.**

---

## Phase 1 — 도그푸딩 (코드 작업 아님, 그러나 필수)

v3 착수 조건을 실제로 충족시키는 단계. 하네스 기능이 아니라 **하네스 사용**이 산출물.

1. 실제 아이디어 #1, #2를 각각 `full-predev`로 실행 (claude-code provider).
   - CEO 게이트 실발화 확인이 목표 — 판정이 "진행"만 나오면 게이트 미검증 상태 지속.
     일부러 리스크 큰 아이디어를 하나 넣어 "축소"/"검증" 분기를 유도한다.
2. 둘 중 하나는 `dev-preflight` → `task-prompt`까지 → Claude Code로 **수동** 개발 착수.
3. 이 과정에서 나온 불편/실패를 `docs/backlog/V3_FIELD_NOTES.md`에 기록.
   - v3.0 스펙은 이 노트를 1차 입력으로 삼는다 (ROADMAP: "전부 하는 게 아니라 필요한 것만").
4. 버전 승격 원칙대로, v3 착수 전 하네스 자신에게 Red Team 워크플로우 1회 실행.

**Phase 1 완료 기준: 아이디어 2개 검증 + 1개 개발 착수 + FIELD_NOTES 존재.**

---

## Phase 2 — v3.0: 실행 연결 최소형

Phase 1 노트로 범위를 재조정하되, 현재 기준 최소 설계는 아래와 같다.

### 2-1. `harness execute` (task prompt → Claude Code 반자동)

원칙: **하네스는 실행을 시작만 시키고, 승인 없이는 아무것도 쓰지 않는다.**

```
harness execute --project <p>            # 기본: plan-only
harness execute --project <p> --apply    # 승인 게이트 후 실제 실행
```

- `plan-only`(기본): `outputs/claude_code_task_prompt.md`를
  `claude -p --permission-mode plan` 류의 계획 모드로 위임 → 실행 계획만
  `outputs/execute_plan.md`에 저장. 파일 변경 없음.
- `--apply`: execute_plan.md를 보여주고 approval(y/n) → 승인 시
  `claude -p` headless 실행. 작업 디렉토리는 **서비스 레포(CWD)**, 하네스 패키지 경로는 read-only 전제.
- 멀티에이전트(spawned_agents 존재) 시: task-prompt의 병렬 스펙을 subagent별로 순차 execute
  (병렬화는 v3.1 — 먼저 순차로 안전 확인).
- run_state에 `execute` 섹션 추가: plan 해시, 승인 시각, 종료 코드, usage.

### 2-2. SECURITY_BASELINE 승격 (2-1의 선결 문서)

backlog TODO → `docs/reference/SECURITY_BASELINE.md`. 최소 내용:

- API key: 환경변수만, 파일/레포 저장 금지. execute 로그에 key 마스킹.
- executor 권한: 서비스 레포 밖 쓰기 금지, 패키지 설치·네트워크 호출은 approval 대상.
- prompt injection: 외부 문서(리서치 결과 등)를 execute 입력에 넣을 때
  "지시가 아니라 데이터" 래핑 규칙. 외부 skill 임포트 금지 재확인 (ROADMAP "안 하는 것" 유지).
- 실패 시: 부분 변경 상태를 숨기지 않고 `execute_plan.md` 대비 diff 요약을 남긴다.

### 2-3. `harness report` (run 이력 CLI 리포트)

- 입력은 이미 전부 존재 (`projects/*/outputs/run_state.json`).
- `harness report --project <p>`: 실행별 workflow/provider/usage/루프 라운드/게이트 점프/실패 사유 표.
- `harness report --all`: 프로젝트 횡단 요약 (프로젝트 간 학습의 전 단계 데이터이기도 함).
- 웹 UI 아님 — markdown/stdout까지만 (ROADMAP 준수).

### v3.0 계속 제외

- 완전 무인 실행 (approval 게이트 항상 유지)
- 병렬 subagent 동시 실행 (v3.1 후보)
- 2차 모델(Codex) 리뷰 — 0-4 편향 분리 효과를 먼저 측정하고 판단
- 프로젝트 간 학습 — 프로젝트 3개 이상 쌓인 뒤 report --all 데이터로 재검토

**v3.0 완료 기준: 실제 프로젝트 1개에서 execute(plan-only → apply) 왕복 성공,
budget 내 종료, 승인 거부 시 무변경 확인 → v3.0.0 태그.**

---

## 참고

- 범위 확장 방지: 이 문서에 없는 기능은 backlog에 먼저 적는다.
- 작업은 develop 브랜치, 검증 통과 후 main 병합 + 태그 (기존 규칙 동일).
- 관련 문서: ROADMAP.md, FAILURE_RECOVERY.md, APPROVAL_GATES_TODO.md,
  TOKEN_COST_POLICY_TODO.md, SECURITY_BASELINE_TODO.md
