# AGENT_OUTPUT_SCHEMA.md

## 1. 문서 목적

이 문서는 각 코어 에이전트 결과를 하네스가 일관되게 저장하고 다음 에이전트에게 넘기기 위한 출력 스키마를 정의한다.

에이전트가 자유롭게 답변하면 사람이 보기에는 좋을 수 있지만, 자동화 하네스에서는 다음 문제가 생긴다.

```text
- 다음 에이전트가 필요한 정보를 찾기 어렵다.
- 결과 문서 구조가 매번 달라진다.
- Claude Code 작업 지시문 생성이 어렵다.
- 평가 기준을 적용하기 어렵다.
- 실패/재실행/요약 처리가 어려워진다.
```

따라서 모든 에이전트 결과는 최소 공통 구조를 가져야 한다.

---

## 2. 공통 출력 원칙

모든 에이전트 출력은 markdown으로 저장한다.

필수 원칙:

```text
- agent_id를 명시한다.
- workflow_id를 명시한다.
- input_summary를 짧게 기록한다.
- main_judgment를 먼저 제시한다.
- key_findings를 구조화한다.
- decisions와 assumptions를 분리한다.
- risks를 명시한다.
- next_actions를 1~3개로 제한한다.
- next_agent를 제안한다.
- 업데이트해야 할 문서를 명시한다.
```

---

## 3. 공통 Markdown Schema

모든 agent 결과는 아래 구조를 기본으로 한다.

```markdown
# Agent Output

## Metadata

- agent_id:
- agent_name:
- workflow_id:
- project:
- created_at:
- input_sources:

## Input Summary

-

## Main Judgment

-

## Key Findings

1.
2.
3.

## Decisions

-

## Assumptions

-

## Risks

### Critical

-

### High

-

### Medium

-

### Low

-

## Recommended Next Actions

1.
2.
3.

## Next Agent

-

## Artifacts To Update

-

## Handoff Notes

-
```

---

## 4. JSON 호환 메타데이터

나중에 자동 처리를 쉽게 하려면 각 출력 상단에 YAML front matter를 둘 수 있다.

예시:

```yaml
---
agent_id: research
agent_name: Research Agent
workflow_id: idea-validation
project: sample-project
created_at: 2026-07-06T00:00:00+09:00
status: completed
next_agent: pm
---
```

v1에서는 필수가 아니지만, v2에서 권장한다.

---

## 5. Agent별 필수 섹션

### 5.1 Chief of Staff Agent

필수 섹션:

```text
- 현재 단계
- 요청 분류
- 필요한 에이전트
- 제외할 에이전트
- 작업 순서
- 각 에이전트에게 넘길 질문
- Preflight 필요 여부
- 오늘 할 일
- 지금 하지 말아야 할 일
```

### 5.2 Research Agent

필수 섹션:

```text
- 리서치 판단
- 고객
- 문제 강도
- 기존 대안 / 경쟁
- 진입 가능성
- 가장 위험한 가정
- 개발 전 검증 질문
- 다음 호출 에이전트
```

### 5.3 PM Agent

필수 섹션:

```text
- PM 판단
- 문제 정의
- 첫 타겟 사용자
- 핵심 가치
- MVP 범위
  - Must Have
  - Should Have
  - Could Have
  - Won't Have
- 사용자 플로우
- 검증해야 할 가설
- 지금 하지 말아야 할 일
```

### 5.4 UX/UI Agent

필수 섹션:

```text
- UX/UI 판단
- 핵심 사용자 흐름
- 필요 화면
- 화면별 목적
- 핵심 컴포넌트
- 입력/결과 경험
- 상태 설계
- 모바일/접근성 고려
- 지금 하지 말아야 할 UI
```

### 5.5 Tech Lead Agent

필수 섹션:

```text
- Tech Lead 판단
- Preflight 판단
- 추천 기술 경로
- 최소 아키텍처
- 구현 순서
- 파일/폴더 계획
- 보안/비용/운영 리스크
- 도구/스킬/훅 판단
- 분리할 에이전트
- 지금 하지 말아야 할 일
```

### 5.6 Red Team Agent

필수 섹션:

```text
- Red Team 판단
- 가장 치명적인 반박
- 리스크 등급
- 실패 시나리오
- 검증해야 할 가정
- 리스크 줄이는 방법
- 그래도 진행한다면 조건
```

### 5.7 Founder CEO Agent

필수 섹션:

```text
- CEO 판단
- 핵심 이유
- 가장 큰 리스크
- 지금 하지 말아야 할 일
- 추천 방향
- 다음 행동
- 다음 호출 에이전트
```

---

## 6. 하네스 검증 규칙

Agent output 저장 전 다음을 확인한다.

```text
- 결과가 비어 있지 않은가
- Metadata가 있는가
- Main Judgment가 있는가
- Recommended Next Actions가 있는가
- Next Agent 또는 workflow 종료 표시가 있는가
- 문서 업데이트 대상이 있는가
```

v1에서는 경고만 출력해도 된다.  
v2에서는 schema validation 실패 시 재생성 또는 사용자 확인을 요구할 수 있다.

---

## 7. 너무 긴 출력 처리

Agent 결과가 너무 길면 다음 규칙을 적용한다.

```text
- 원문은 outputs/raw/에 저장
- 요약본은 docs/에 저장
- CONTEXT_SUMMARY에는 핵심 결정만 반영
- Claude Code 작업 지시문에는 필요한 내용만 넣음
```

---

## 8. 다음 에이전트 input 구성

다음 에이전트에게는 전체 문서를 그대로 넘기지 않는다.

전달 우선순위:

```text
1. 이전 agent의 Main Judgment
2. Decisions
3. Risks
4. Recommended Next Actions
5. 관련 docs의 요약
6. 필요한 경우 원문 링크/경로
```

---

## 9. 완료 기준

이 문서가 적용되면 다음이 가능해야 한다.

```text
- agent output을 기계적으로 저장할 수 있다.
- 다음 agent input을 자동 구성할 수 있다.
- Claude Code task prompt를 안정적으로 생성할 수 있다.
- 평가 체크리스트를 적용할 수 있다.
- output 누락을 감지할 수 있다.
```
