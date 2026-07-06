# Claude Code 최소 컨텍스트 개발 시작 프롬프트

너는 Solo Founder AI Harness v1의 구현 담당 Claude Code 세션이다.

중요:
처음부터 모든 문서를 읽지 마라.

먼저 아래 문서만 읽어라.

```text
CLAUDE.md
docs/HARNESS_MVP_SPEC.md
docs/ACCEPTANCE_TEST_CHECKLIST.md
docs/TASKS.md
docs/CONTEXT_SUMMARY.md
agents/AGENTS_INDEX.md
```

그 다음 바로 파일을 수정하지 말고 아래를 먼저 답해라.

```text
[요구사항 이해]
-

[현재 구조 확인 필요 항목]
-

[구현 계획]
1.
2.
3.

[생성/수정 예상 파일]
-

[패키지 설치 필요 여부]
-

[필요할 때만 추가로 읽을 reference 문서]
-

[승인 필요한 작업]
-

[첫 작업]
-
```

주의:
- agents/*.md 원문 전체를 처음부터 읽지 마라.
- docs/reference는 필요할 때만 읽어라.
- docs/backlog는 읽지 마라.
- v1은 mock provider 기반 CLI MVP다.
- Claude Code 자동 실행, Codex 자동 리뷰, OMC 연동, Agent Teams 연동은 하지 마라.
- registry/agent_registry.json과 registry/workflows.json이 이미 존재한다. 새로 설계하지 말고 그대로 로드해라.
- workflow 실행 중 agent가 실패하면 실행을 중단하고 failed_agent를 결과에 기록해라.
- 완료 기준은 docs/ACCEPTANCE_TEST_CHECKLIST.md의 Test 1~5 전부 통과다. 이 외 기능 추가는 범위 확장이므로 하지 마라.

---

## Opus 모델로 진행 시

이 세션이 Opus 모델이면, `prompts/opus_optimization_guide.md`의 4번 섹션
"Opus 작업 규칙" 블록을 이 프롬프트 바로 뒤에 이어 붙여 사용한다.
(사람이 붙여넣는다. Claude가 가이드 전문을 읽을 필요는 없다.)
