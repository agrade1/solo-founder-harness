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

---

## 2-2. V3 확장 테스트 (v1 완료 기준 아님)

### Test 13. M4a durable orchestration (offline)

명령:

```bash
npm run build && node scripts/m4a-offline-acceptance.mjs
```

확인:

```text
- 네트워크 / LLM / provider spawn / TTY / git write 없이 exit 0
- 임시 workspace에서만 동작 (레포에 outputs/orchestration 생성하지 않음)
- parent running → spawn_request → child 생성 → parent=waiting_children, child=ready
- child에 의존하는 dependent task = pending
- kernel 인스턴스를 버리고 같은 run을 다시 열어 state/ready 목록 복원
- child running → workspace 안 artifact 등록(SHA-256/revision/producer/role) → result 제출
- child=completed, parent=ready, dependent=ready
- 재시작 후 동일 ready 목록 / revision / artifact 포인터 / 바이트 동일 snapshot
- run_state.json · snapshot.md · message index 어디에도 raw artifact 본문·transcript 없음
- 형태가 유효한 run_state.json 편집(state/resultSummary 위조)은 state↔event binding으로 거부
  (`state_event_binding_mismatch`), 원상 복구하면 다시 열림
```

현재 이 스크립트는 **31개 체크**를 수행한다(2026-07-27 P0-1 수정으로 29 → 31).

`scripts/acceptance.sh` Test 13이 위 스크립트의 exit code와 내부 체크 결과를 검증한다
(기존 Test 1~12는 변경하지 않았다). 세부 계약은
`docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` §M4 → M4a 절을 본다.

---

### Test 14. M4b 배타 자원 class · deterministic scheduler · run writer lock (offline)

명령:

```bash
npm run build && node scripts/m4b-offline-acceptance.mjs
```

확인:

```text
- 네트워크 / LLM / provider spawn / TTY / git write 없이 exit 0
- 임시 workspace에서만 동작 (레포에 outputs/orchestration 생성하지 않음)
- 같은 배타 class(suite-lock)를 요구하는 ready task 2건 + 자원 요구 없는 ready task 1건
- 선언이 run_state.json과 snapshot.md에 durable하게 남음(task.resourceClasses)
- 결정론적 schedule(scheduleReady)은 같은 class 중 taskId가 앞선 하나만 고르고,
  자원 요구가 없는 task는 같은 batch에서 함께 고른다 → startScheduledBatch는 커밋 1회
- 같은 class를 요구하는 나머지 task는 ready로 유예된다(동시 running 0)
- scheduler를 거치지 않는 직접 startTask도 같은 규칙을 받는다(`resource_conflict`, 전이 0)
- 재시작(같은 run을 새로 열기) 후 점유·class 선언·schedule 결정이 동일
- holder가 completed되면 class가 풀리고 대기 task가 다시 schedulable해진다
- 같은 revision에서 열린 두 kernel: 첫 커밋 성공, 낡은 기준의 두 번째 커밋은 `stale_writer`로
  거부(파일 전이 0), 다시 열면 첫 writer 결과가 온전하고 정상 커밋이 가능
- 보유 중인 run writer lock은 mutation을 대기 없이 `run_lock_held`로 거부하고 state/event/body
  전이가 0이다. 남의 lock은 `run_lock_owner_mismatch`로 보존하며, 해제 후에는 정상 커밋된다
```

현재 이 스크립트는 **42개 체크**를 수행한다(2026-07-27 M4b 신규).

`scripts/acceptance.sh` Test 14가 위 스크립트의 exit code와 내부 체크 결과를 검증한다
(**기존 Test 1~13은 변경하지 않았다**). 세부 계약은
`docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` §M4 → M4b 절을 본다.

---

## 3. v1 통과 조건

```text
위 5개 테스트(Test 1~5)가 모두 통과하면 v1 MVP 완료로 본다.
(Test 6은 v2 Obsidian 확장 — scripts/acceptance.sh는 현재 Test 1~14 총 81 checks 검증.
 2026-07-27 M4a에서 Test 13 4 checks 추가: 71 → 75.
 2026-07-27 M4b에서 Test 14 6 checks 추가: 75 → 81. 기존 checks는 변경하지 않았다.)
```

## 4. v1 실패 조건

```text
- Claude Code 자동 실행 기능을 만들었다.
- 실제 LLM provider가 없으면 동작하지 않는다.
- init/list/run/summary/task-prompt 중 하나가 빠졌다.
- 결과가 파일로 저장되지 않는다.
- task prompt가 바로 사용할 수 없다.
```
