# IMPLEMENTATION_PLAYBOOK.md — 하네스 v1 구현 진행 순서

사람(지원)용 실행 플레이북. Claude Code 기본 로드 대상 아님.
원칙: 1세션 = 1~2단계. 세션마다 커밋 + WORKLOG 갱신 후 종료. 막히면 세션을 늘리지 말고 끊고 새로 시작.

---

## Phase 0. 환경 준비 (사람이 직접, 10분)

```bash
# 1. 레포 생성
unzip solo-founder-harness_v1_final.zip
cd solo-founder-harness
git init && git add -A && git commit -m "chore: v1 docs/prompts baseline"

# 2. Node 확인 (18+)
node -v

# 3. Claude Code 실행, 모델 = Opus 확인, effort 확인
claude
/effort        # 기본 xhigh 확인. 오늘 scaffold 위주면 high로 낮춰도 됨
```

시작 프롬프트 = `prompts/claude_code_minimal_context_start_prompt.md`
+ `prompts/opus_optimization_guide.md` 4번 "Opus 작업 규칙" 블록을 이어 붙여 첫 턴에 투입.

첫 턴에는 반드시 "오늘은 Step N까지만 한다"라고 범위를 못박는다.

---

## Phase 1. Scaffold — Step 1 (세션 1)

목표: TypeScript CLI 뼈대. 로직 없음.

Claude Code 지시 요지:

```text
Step 1만 진행해라.
- package.json, tsconfig.json, src/cli.ts 생성 (commander 또는 유사 경량 CLI 라이브러리 1개만)
- 05_RECOMMENDED_REPO_STRUCTURE의 src/ 구조대로 빈 파일 생성 (core, config, types, templates)
- harness --help 가 5개 명령(init/list/run/summary/task-prompt)을 보여주면 완료 (구현은 stub)
- 패키지 설치 전에 설치 목록을 먼저 보여주고 승인받아라.
```

완료 확인 (사람):

```bash
npx tsx src/cli.ts --help   # 5개 명령 노출
git add -A && git commit -m "feat: cli scaffold"
```

---

## Phase 2. 읽기 계층 — Step 2~3 (세션 1 이어서 또는 세션 2)

목표: registry 로드 + `harness list`.

지시 요지:

```text
Step 2, 3을 진행해라.
- loadConfig: registry/agent_registry.json, registry/workflows.json 로드 + 타입 정의 (src/types)
- 로드 시 prompt_path 파일 존재 여부를 검증해라 (없으면 명확한 에러)
- harness list: agents 8개(공용 포함)와 workflows 4개 출력
- registry JSON 스키마를 재설계하지 마라. 있는 그대로 로드해라.
```

완료 확인: `harness list` 출력 = AGENTS_INDEX.md 내용과 일치. 커밋.

여기서 acceptance Test 2 절반이 끝난다.

---

## Phase 3. 쓰기 계층 — Step 4 (세션 2)

목표: `harness init`.

지시 요지:

```text
Step 4를 진행해라.
- src/templates/docsTemplates.ts에 6개 docs 템플릿을 코드로 정의
  (00_IDEA, TASKS, DECISIONS, CONTEXT_SUMMARY, WORKLOG, API_CONTRACT)
- harness init <name> → projects/<name>/docs + outputs 생성
- 이미 존재하는 프로젝트면 덮어쓰지 말고 에러
```

완료 확인 = acceptance Test 1 그대로 실행:

```bash
harness init sample-project
ls projects/sample-project/docs   # 6개 파일
```

커밋. projects/는 .gitignore 처리 여부 결정 (sample은 커밋해도 무방).

---

## Phase 4. 핵심 실행 — Step 5~6 (세션 3, 가장 중요)

이 세션이 하네스의 심장이다. effort xhigh 유지, 시작 시 계획 승인 절차 필수.

목표: mock provider → runAgent → runWorkflow → run_state.

지시 요지:

```text
Step 5, 6을 진행해라. 구현 전에 설계를 먼저 제안하고 승인받아라.
이 부분은 보기보다 복잡하다. 단계별로 신중하게 검토해라.

- provider interface: generate(input) → { text, usage: { inputTokens, outputTokens } }
  (v1은 mock 하나지만 usage 필드는 지금 넣는다 — v2 예산 상한 대비)
- mock provider: AGENT_OUTPUT_SCHEMA의 필수 섹션 헤더를 갖춘 가짜 markdown 반환
- runAgent: common prompt + agent prompt 파일 로드 → provider 호출 → 결과 반환
- buildAgentInput: 00_IDEA.md + 이전 step 결과들을 다음 agent input으로 구성
- runWorkflow: workflows.json 순서 실행, saveArtifact로 default_output 경로에 저장
  (docs/와 outputs/ 두 경로 모두 지원)
- saveArtifact 저장 전 필수 섹션 헤더 검증 → 누락 시 경고 출력 + run_state.warnings 기록
- 실패 시 중단 + failed_agent 기록
- 매 실행 outputs/run_state.json 기록 (spec 4.4.1 필드 그대로)
```

완료 확인 = acceptance Test 3:

```bash
harness run idea-validation --project sample-project
cat projects/sample-project/outputs/run_state.json
ls projects/sample-project/docs   # 01_RESEARCH, 02_PRD, 05_RED_TEAM, 06_CEO_DECISION 생성
```

추가 확인: mock에서 일부러 섹션 하나 빼고 경고 뜨는지, agent 하나 실패시켜 failed_agent 기록되는지.
커밋 (기능별로 2~3개 커밋 권장). 세션 종료 전 CONTEXT_SUMMARY.md 갱신 지시.

---

## Phase 5. 산출 계층 — Step 7~8 (세션 4)

목표: `harness summary` + `harness task-prompt`.

지시 요지:

```text
Step 7, 8을 진행해라.
- summary: docs/outputs를 읽고 CONTEXT_SUMMARY.md를 짧게 갱신
  (현재 상태 / 핵심 결정 / 다음 작업 1~3개. 길면 실패다)
- task-prompt: outputs/claude_code_task_prompt.md 생성
  필수 섹션: Context / Task / Include / Exclude / Rules / Done Criteria
  Rules에 패키지 설치·배포·DB 변경 금지 문구 포함
  (필요하면 docs/reference/PERMISSION_POLICY.md를 이 시점에만 읽어라)
```

완료 확인 = acceptance Test 4, 5. 생성된 task prompt를 사람이 직접 읽고
"이걸 그대로 새 Claude Code 세션에 붙일 수 있는가"로 판정. 커밋.

---

## Phase 6. 수락 검증 및 마감 (세션 4 이어서 또는 세션 5)

```text
Step 9: acceptance test 1~5를 처음부터 순서대로 전부 재실행해라.
각 테스트의 실제 실행 출력 결과를 근거로 통과/실패를 보고해라.
"될 것 같다"는 보고는 받지 않는다.
```

전부 통과 시:

```bash
git tag v1.0.0
```

마감 작업 (Claude에게 지시):
- TASKS.md 체크박스 정리, WORKLOG/DECISIONS/CONTEXT_SUMMARY 최종 갱신
- README에 실제 사용 예시 3줄 추가

---

## 세션 운영 규칙 (전체 공통)

```text
- 세션 시작: 시작 프롬프트 + Opus 규칙 블록 + "오늘 범위는 Step N까지"
- 세션 종료: 커밋 → WORKLOG 한 줄 → CONTEXT_SUMMARY 갱신 → 종료
- 새 세션: CLAUDE.md + CONTEXT_SUMMARY + TASKS만 읽고 시작 (전 세션 대화 불필요)
- 같은 버그로 2회 이상 헤매면: 세션 끊고, 재현 방법을 CONTEXT_SUMMARY에 적고,
  새 세션에서 "이 버그를 재현해서 원인부터 분석해라"로 시작
- 무관한 질문/실험은 /clear 후 별도로
```

## 하지 말 것 (구현 중 유혹 목록)

```text
- Step 순서 건너뛰기 (특히 scaffold 없이 runWorkflow부터)
- mock 단계에서 실제 API 연결 "테스트만 잠깐" — v2다
- run_state에 retry/resume 로직 추가 — 기록만 한다
- provider 추상화 계층 확장 (멀티 provider 지원 등) — interface 1개면 끝
- 문서 추가 생산 — 지금 있는 문서로 충분하다
- acceptance 5개 외 기능 추가 — 전부 v2 backlog로
```

## 예상 진행량

세션 5개 내외, 실작업 기준 2~4일. 세션 3(Phase 4)이 절반 이상의 난이도를 차지한다.
세션 3이 한 번에 안 끝나면 Step 5(provider+runAgent)와 Step 6(runWorkflow)으로 쪼갠다.
