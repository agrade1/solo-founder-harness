# ACCEPTANCE_TEST_CHECKLIST.md

## 1. 목적

이 체크리스트는 Solo Founder AI Harness v1이 최소 기능을 만족하는지 확인하기 위한 1페이지 검증 기준이다.

---

## 2. v1 완료 기준

### Test 1. 프로젝트 초기화

명령:

```bash
harness init sample-project
```

확인:

```text
- projects/sample-project 생성
- docs 폴더 생성
- outputs 폴더 생성
- 필수 docs 파일 생성
```

필수 docs:

```text
00_IDEA.md
TASKS.md
CONTEXT_SUMMARY.md
DECISIONS.md
WORKLOG.md
API_CONTRACT.md
```

---

### Test 2. 목록 출력

명령:

```bash
harness list
```

확인:

```text
- 7개 core agents 출력
- common prompt 존재 확인
- workflows 출력
```

---

### Test 3. idea-validation 실행

명령:

```bash
harness run idea-validation --project sample-project
```

확인:

```text
- mock provider로 실행 가능
- workflow 순서가 맞음
- 각 agent 결과 markdown 저장
- 실패 시 failed_agent 표시
- outputs/run_state.json 생성 (completed_steps, failed_agent, 시각 기록)
- 결과에 필수 섹션 헤더 누락 시 경고 출력
```

---

### Test 4. summary 생성

명령:

```bash
harness summary --project sample-project
```

확인:

```text
- CONTEXT_SUMMARY.md 갱신
- 내용이 짧고 읽기 쉬움
- 다음 작업이 보임
```

---

### Test 5. Claude Code 작업 지시문 생성

명령:

```bash
harness task-prompt --project sample-project
```

확인:

```text
- outputs/claude_code_task_prompt.md 생성
- Context / Task / Include / Exclude / Rules / Done Criteria 포함
- 패키지 설치, 배포, DB 변경 금지 규칙 포함
```

---

## 2-1. v2 확장 테스트 (v1 완료 기준 아님)

### Test 6. Obsidian export

명령:

```bash
harness run idea-validation --project sample-project --vault <vault경로>
```

확인:

```text
- <vault>/<project>/<workflow>_run.md (MOC 인덱스 노트) 생성
- <vault>/<project>/<agent_id>.md (agent별 노트) 생성
- 노트에 YAML frontmatter (project/workflow/agent/role/provider/date/tags)
- agent 노트에 [[인덱스]] wikilink, 인덱스에 [[agent]] wikilink (양방향)
- --vault/HARNESS_VAULT 미지정 시 export 하지 않음(기존 동작 무영향)
```

---

## 3. v1 통과 조건

```text
위 5개 테스트(Test 1~5)가 모두 통과하면 v1 MVP 완료로 본다.
(Test 6은 v2 Obsidian 확장 — scripts/acceptance.sh는 현재 Test 1~6 총 35 checks 검증.)
```

## 4. v1 실패 조건

```text
- Claude Code 자동 실행 기능을 만들었다.
- 실제 LLM provider가 없으면 동작하지 않는다.
- init/list/run/summary/task-prompt 중 하나가 빠졌다.
- 결과가 파일로 저장되지 않는다.
- task prompt가 바로 사용할 수 없다.
```
