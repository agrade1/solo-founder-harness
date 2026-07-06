# CONTEXT_SUMMARY.md

최종 갱신: 2026-07-06

## 현재 상태

- **하네스 v1 구현 완료.** acceptance Test 1~5 전부 통과 (`npm test` → 30 checks all pass).
- 5개 명령 동작: list / init / run / summary / task-prompt (mock provider 기반, 실제 LLM 미호출).
- 코드 구조:
  - `src/cli.ts` — commander 진입점
  - `src/core/` — paths, registry, project, runAgent, runWorkflow, validate, saveArtifact, summary, taskPrompt
  - `src/providers/` — provider 인터페이스 + mockProvider
  - `src/commands/` — 각 CLI 명령 래퍼
- `scripts/acceptance.sh` = 통합 검증 스위트 (`npm test`/`npm run acceptance`).
- git: origin = github.com/agrade1/solo-founder-harness, main 브랜치에 단계별 커밋/푸시.
- 비공개: `projects/idea-discovery/IDEA_*.md`는 .gitignore로 원격 제외.

## v2 진행 상황 (2026-07-06 착수)

- **provider 전략 C안 확정** (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md): mock/claude-code(B안,구독)/anthropic(A안,API) 3종 교체. 지금은 claude-code, A안은 나중.
- **[v2-1 완료] Provider 인터페이스 async화 + token usage 필드.** `generate()` → `Promise<AgentResult>`, run_state에 provider+usage 기록, `run --provider` 플래그. mock acceptance 30/30 유지.

## 다음 작업

- **[v2-2] claude-code provider(B안) 구현** — `claude -p` headless 위임으로 실제 LLM 첫 연동. 사용자 Claude 구독 소비 → 실행 전 구독/로그인 상태 확인 필요.
- 이후: [v2-3] anthropic provider(A안) → 루프 엔지니어링(V2_KICKOFF 2번~).
- 범위 확장 금지 규칙 유지. 패키지 설치(@anthropic-ai/sdk)는 A안 붙일 때만.
