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
- **[v2-1 완료] Provider 인터페이스 async화 + token usage 필드.** `generate()` → `Promise<AgentResult>`, run_state에 provider+usage 기록, `run --provider` 플래그.
- **[v2-2 완료] claude-code provider(B안).** `claude -p --output-format json` stdin 위임, usage 파싱. AgentRunInput에 ideaContent(00_IDEA.md) 추가. extractMainJudgment 문단형 대응 버그수정. dev-preflight end-to-end 검증 완료. mock acceptance 30/30 유지.
- 사용: `harness run <wf> --project <p> --provider claude-code` (claude CLI가 Max 구독 로그인 상태여야 함). 기본은 mock.
- **[v2-3 완료] 스키마 검증 재생성 루프.** 필수 헤더 누락 시 피드백해 재생성(`--max-regen <n>`, 기본 1). run_state.regenerations 기록.
- **[v2-4 완료] Red Team 비평 루프.** workflow steps를 `(string|{critique_loop})[]`로 확장. critic(red_team)이 Critical 리스크 발견 시 target(tech_lead)에 되먹여 revise→재검토, Critical 소멸/max_rounds까지. mvp-planning에 내장(`↻[red_team⟲tech_lead×2]`). run_state.critique_rounds 기록. mock+stub 검증, acceptance 30/30 유지.
- 아키텍처: runWorkflow가 runStepWithRegen 헬퍼 + priorFindings Map(upsert) 구조. CEO 게이트도 이 위에 얹으면 됨.

## 다음 작업

- **[v2-5] anthropic provider(A안)** — @anthropic-ai/sdk 직접, 종량과금. 사용자가 원할 때 (설치 승인 필요).
- **[v2-6] CEO 게이트 분기**(V2_KICKOFF 4번): founder_ceo 판정("축소"→pm, "검증"→research)에 따라 되돌아가는 조건 분기. steps에 `{gate}` 구성 추가하는 식.
- 실사용: mvp-planning을 `--provider claude-code`로 실제 돌려 비평 루프 품질 체감(아직 미실행 — mock/stub만 검증).
- 범위 확장 금지 규칙 유지. 패키지 설치(@anthropic-ai/sdk)는 A안 붙일 때만.
