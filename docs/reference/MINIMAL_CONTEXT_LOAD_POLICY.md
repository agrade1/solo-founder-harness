# MINIMAL_CONTEXT_LOAD_POLICY.md

## 1. 목적

이 문서는 Claude Code 또는 Claude Fable 모드가 하네스 문서를 읽을 때 토큰 낭비와 문맥 혼동을 줄이기 위한 최소 로드 정책이다.

---

## 2. Claude Fable 검토 모드 로드 순서

Fable 모드에는 아래 순서로 읽힌다.

```text
1. README.md
2. harness_development_guide_v3.md
3. docs/00_FABLE_REVIEW_BRIEF.md
4. docs/01_CRITICAL_DOC_STRATEGY_REVIEW.md
5. docs/02_MINIMAL_CONTEXT_LOAD_POLICY.md
6. docs/03_AGENT_PROMPT_REPO_POLICY.md
7. docs/04_ACCEPTANCE_TEST_CHECKLIST.md
```

reference 문서는 Fable이 필요하다고 판단할 때만 열게 한다.

---

## 3. Claude Code 개발 모드 로드 순서

개발 시작 시 Claude Code에는 아래만 먼저 읽힌다.

```text
1. CLAUDE.md
2. docs/HARNESS_MVP_SPEC.md
3. docs/ACCEPTANCE_TEST_CHECKLIST.md
4. docs/TASKS.md
5. docs/CONTEXT_SUMMARY.md
6. agents/AGENTS_INDEX.md
```

그 다음 Claude가 구현 계획을 낸 뒤, 필요한 reference만 추가로 읽힌다.

---

## 4. 읽히지 말아야 할 것

개발 시작부터 아래를 읽히지 않는다.

```text
- agents/*.md 전체 원문
- docs/backlog/*
- OMC/Agent Teams 실험 문서
- 이전 버전 전체 가이드
- 긴 output/raw 결과물
```

---

## 5. Reference 문서 호출 조건

### AGENT_OUTPUT_SCHEMA.md

다음 상황에서만 읽는다.

```text
- runAgent 결과 저장 구조 구현
- output section validation 구현
- task prompt 생성 로직 구현
```

### PERMISSION_POLICY.md

다음 상황에서만 읽는다.

```text
- Claude Code 작업 지시문 생성
- 안전 규칙 템플릿 구현
- 위험 작업 제외 문구 작성
```

### EVALUATION_CHECKLIST.md

다음 상황에서만 읽는다.

```text
- acceptance test 보강
- generated output 품질 점검
```

### FAILURE_RECOVERY.md

다음 상황에서만 읽는다.

```text
- error handling
- backup policy
- failed agent 기록
```

---

## 6. 원칙

```text
읽을 문서 수를 줄인다.
긴 문서는 reference로 둔다.
최신 결정은 CONTEXT_SUMMARY.md에 압축한다.
Claude에게 "필요할 때 특정 문서만 열어라"라고 지시한다.
```
