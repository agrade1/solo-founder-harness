# FUTURE_OPERATING_DOCS_BACKLOG.md

이 문서는 하네스 v1 이후 작성하거나 확장할 6~10번 운영 문서를 기록한다.

v1 개발 전 필수 작성 대상은 1~5번이다.

```text
1. HARNESS_MVP_SPEC.md
2. AGENT_OUTPUT_SCHEMA.md
3. PERMISSION_POLICY.md
4. EVALUATION_CHECKLIST.md
5. FAILURE_RECOVERY.md
```

v1 이후 또는 개발 중 필요 시 작성할 문서는 아래 6~10번이다.

---

## 6. TOKEN_COST_POLICY.md

목적:

- 토큰 사용량과 API 비용을 통제한다.
- 모든 에이전트를 항상 실행하지 않도록 한다.
- 긴 문서를 요약해서 전달하는 기준을 정한다.

포함할 내용:

```text
- workflow별 예상 비용 등급
- agent별 최대 입력 길이
- agent별 최대 출력 길이
- CONTEXT_SUMMARY 우선 사용 원칙
- raw 문서와 summary 문서 분리
- 재실행 방지 정책
- 비용 경고 기준
```

---

## 7. PROMPT_VERSIONING.md

목적:

- 공용 프롬프트와 특화 에이전트 프롬프트의 버전을 관리한다.
- 어떤 프로젝트가 어떤 프롬프트 버전으로 실행됐는지 기록한다.

포함할 내용:

```text
- prompt version naming
- agent prompt changelog
- workflow run metadata에 prompt version 기록
- 과거 결과 재현 가능성
- prompt 변경 승인 기준
```

---

## 8. APPROVAL_GATES.md

목적:

- 인간 승인 지점을 명확히 한다.
- AI가 사업/개발 중요 결정을 자동으로 넘기지 않도록 한다.

포함할 내용:

```text
- 개발 착수 승인
- MVP 범위 확정 승인
- 패키지 설치 승인
- DB/인증/결제 도입 승인
- 배포 승인
- 유료화 실험 승인
- Critical risk 존재 시 중단 기준
```

---

## 9. SECURITY_BASELINE.md

목적:

- AI 하네스와 Claude Code 작업에서 기본 보안 기준을 정의한다.

포함할 내용:

```text
- .env / secret 접근 금지
- API key 관리
- prompt injection 주의
- 외부 패키지 설치 기준
- shell script 실행 기준
- 파일 업로드/개인정보/결제 등장 시 Security Agent 호출
- dependency audit 기준
```

---

## 10. API_CONTRACT_TEMPLATE.md

목적:

- 프론트엔드와 백엔드 세션이 API 계약을 기준으로 협업하게 한다.

포함할 내용:

```text
- endpoint
- method
- request body
- response body
- error response
- loading/error UI state
- mock data
- 변경 이력
- breaking change 표시
```

---

## 작성 우선순위

v1 개발 중 바로 필요하면 아래 순서로 작성한다.

```text
1. APPROVAL_GATES.md
2. TOKEN_COST_POLICY.md
3. SECURITY_BASELINE.md
4. PROMPT_VERSIONING.md
5. API_CONTRACT_TEMPLATE.md
```
