# FAILURE_RECOVERY.md

## 1. 문서 목적

이 문서는 Solo Founder AI Harness 실행 중 실패가 발생했을 때 어떻게 중단하고, 기록하고, 재실행하고, 복구할지 정의한다.

LLM 기반 하네스는 반드시 실패할 수 있다.

예상 가능한 실패:

```text
- LLM 호출 실패
- 빈 응답
- 형식이 깨진 응답
- 너무 긴 응답
- 중간 workflow 실패
- 파일 저장 실패
- 문서 덮어쓰기 문제
- API 비용 초과
- 사용자가 수동 수정한 문서와 충돌
```

---

## 2. 기본 원칙

```text
- 실패를 숨기지 않는다.
- 중간 결과를 가능한 한 보존한다.
- 자동으로 위험한 복구를 하지 않는다.
- 재실행 가능한 상태를 만든다.
- 사용자가 어디서 실패했는지 알 수 있어야 한다.
```

---

## 3. 실행 상태

각 workflow 실행은 상태를 가진다.

```text
pending
running
completed
failed
cancelled
needs_review
```

v1에서는 JSON 파일 하나로 상태를 저장해도 된다.

예시:

```text
projects/my-project/outputs/run_state.json
```

---

## 4. 실패 기록 형식

실패 시 아래 파일을 남긴다.

```text
projects/my-project/outputs/errors/<timestamp>_<agent_id>_error.md
```

내용:

```markdown
# Harness Error

## Metadata

- workflow:
- agent_id:
- project:
- failed_at:
- status:

## Error Summary

-

## Input Sources

-

## Partial Output

-

## Recovery Options

1.
2.
3.
```

---

## 5. 실패 유형별 처리

### 5.1 LLM 호출 실패

처리:

```text
- 실패 agent_id 기록
- 재시도 가능 여부 표시
- 이전 agent 결과는 보존
- workflow는 중단
```

복구:

```bash
harness run <workflowName> --project <projectName> --resume
```

v1에서는 `--resume` 구현이 어렵다면 TODO로 남기고, 실패 지점만 기록한다.

### 5.2 빈 응답

처리:

```text
- 빈 응답 파일을 저장하지 않는다.
- error 파일 생성
- 사용자에게 재실행 요청
```

### 5.3 형식 깨짐

처리:

```text
- raw output은 outputs/raw/에 저장
- docs에는 저장하지 않는다.
- schema warning 출력
- 사용자 검토 필요 상태로 표시
```

### 5.4 너무 긴 응답

처리:

```text
- 원문은 outputs/raw/에 저장
- docs에는 요약본만 저장
- CONTEXT_SUMMARY에는 핵심 결정만 반영
```

### 5.5 파일 저장 실패

처리:

```text
- console에 명확한 오류 출력
- 어떤 파일 저장에 실패했는지 표시
- partial output을 임시 파일로 저장 시도
```

### 5.6 문서 덮어쓰기 충돌

처리:

```text
- 기존 파일이 있으면 백업 생성
- 새 파일은 timestamp 버전으로 저장
- 사용자가 어떤 버전을 채택할지 선택
```

예시:

```text
01_RESEARCH.md
01_RESEARCH.20260706-1530.backup.md
```

v1에서는 최소한 덮어쓰기 전 경고 또는 백업을 권장한다.

---

## 6. 재실행 정책

### 6.1 전체 재실행

```bash
harness run idea-validation --project my-project --force
```

위 명령은 기존 결과를 덮어쓸 수 있으므로 승인 필요 작업으로 본다.

### 6.2 특정 agent만 재실행

v2 후보:

```bash
harness run-agent research --project my-project
```

v1에서는 구현하지 않아도 된다.

### 6.3 실패 지점부터 재실행

v2 후보:

```bash
harness run idea-validation --project my-project --resume
```

v1에서는 실패 지점 기록만 해도 된다.

---

## 7. 백업 정책

문서 덮어쓰기 전에 다음 중 하나를 적용한다.

v1 추천:

```text
- 기존 파일이 있으면 .backup.md 생성
```

v2 후보:

```text
- outputs/runs/<run_id>/ 아래에 모든 실행 결과 저장
- docs에는 latest만 반영
```

권장 구조:

```text
outputs/
  runs/
    20260706-153000/
      001_chief_of_staff.md
      002_research.md
      003_pm.md
      run_state.json
  latest/
    final_summary.md
```

---

## 8. 사용자 수동 수정 보호

사용자가 docs 파일을 직접 수정할 수 있다.

따라서 하네스는 다음을 고려해야 한다.

```text
- docs 파일은 최종 편집본일 수 있다.
- outputs/runs는 원본 실행 결과다.
- docs를 덮어쓰기 전 백업한다.
- 중요한 docs는 사용자가 승인 후 갱신하게 할 수 있다.
```

v1에서는 단순 백업으로 충분하다.

---

## 9. 비용 초과 / 토큰 초과 처리

예상 문제가 발생하면:

```text
- workflow 중단
- 현재까지 결과 저장
- CONTEXT_SUMMARY 갱신 시도
- 비용/토큰 경고 출력
```

너무 긴 입력은 다음 원칙을 따른다.

```text
- 전체 문서 대신 summary 전달
- raw file path만 참조
- 최근 결정과 next action 중심 전달
```

---

## 10. 사람이 개입해야 하는 상황

다음 상황에서는 자동 진행하지 않는다.

```text
- CEO 판단이 보류/폐기
- Red Team Critical risk 존재
- Tech Lead가 보안 검토 필요 판단
- 인증/결제/DB/파일 업로드 필요
- package install 필요
- LLM 응답 형식이 반복적으로 깨짐
- agent 결과가 서로 충돌
```

---

## 11. v1 최소 구현 기준

v1에서는 아래까지만 구현해도 충분하다.

```text
- 실패 agent_id 표시
- error markdown 저장
- 빈 응답 감지
- 기존 파일 백업
- workflow 중단
- 사용자에게 다음 복구 방법 안내
```

---

## 12. 완료 기준

이 문서가 적용되면 다음이 가능해야 한다.

```text
- workflow가 실패해도 어디서 실패했는지 알 수 있다.
- 중간 결과가 보존된다.
- 기존 문서가 조용히 덮어써지지 않는다.
- 사용자가 재실행 또는 수동 복구를 선택할 수 있다.
```
