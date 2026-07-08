# CONTEXT_SUMMARY.md

최종 갱신: 2026-07-08

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
- **[v2-6 완료] CEO 게이트 분기.** WorkflowStep에 `{gate}` 확장. decider(founder_ceo) 판정이 on 키와 맞으면 해당 agent로 되돌려 재실행(max_jumps로 무한루프 방지). full-predev에 내장(`⤴[founder_ceo?축소→pm,검증→research×1]`). run_state.gate_jumps 기록. mock+stub 검증.
- **[v2-5 완료] anthropic provider(A안).** @anthropic-ai/sdk 연동, 프롬프트 빌더를 promptParts.ts로 공유. ANTHROPIC_API_KEY 필요(종량과금). 키 없으면 안전 실패+claude-code 안내. 기본 provider는 mock 유지. **실제 유료 호출 미검증**.
- provider 3종(mock/claude-code/anthropic) + 루프 3종(재생성/비평/게이트) 완비.

- **[실전 검증 완료]** mvp-planning을 claude-code로 실제 실행 → 비평 루프 실작동 확인(red_team이 Critical 2건 발견→tech_lead 반영 수정→재검토→max_rounds 종료). 루프가 출력 개선함.
- **v2 완료 → v2.0.0 태그** (develop→main 병합).
- **[v2.1-A 완료] 라이브러리화.** 경로 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(=CWD, projects). 서비스 레포마다 설치. v2.1.0 태그·푸시 완료.
- **[B-② 완료] 동적 분화(fanout).** planner(tech_lead)가 `SPAWN id=..|name=..|focus=..` 선언 → fanout이 파싱 → **기본 계획만(사람 승인 게이트)**, `--allow-spawn` 시 하위 전문 에이전트 런타임 생성·실행(outputs/spawned/<id>.md). dev-preflight 내장. run_state.spawned_agents. v2.2.0 태그.
- **[B-③ 완료] 멀티에이전트 task-prompt.** spawned_agents 있으면 task-prompt에 "병렬 실행" 섹션(FE/BE별 담당·계획문서·통합·승인게이트) 생성. **하네스는 스펙 생성만, 실제 병렬 코딩은 Claude Code subagent(사람 승인 후).** stub 검증. **v2.3.0 태그**(develop→main 병합).
- **[Obsidian 완료] Obsidian 연동.** run 결과를 vault로 read-only export — agent별 노트(frontmatter + `[[wikilink]]` 이전/다음/인덱스) + run MOC 인덱스(실행 순서 링크 + 메타). `run --vault <path>` / `HARNESS_VAULT`, opt-in(미지정 시 무동작). `src/core/obsidianExport.ts`. acceptance Test 6 추가 → **35/35 통과**. (develop, 미태그 — v2.4.0 예정)

## v2.5 안정화 Phase 0 (2026-07-07, V3_KICKOFF 기반)

- v3 착수 조건 미충족 → v3 선결로 v2.5 Phase 0 먼저 구현(V3_KICKOFF.md 0-1~0-4). 각 항목 단위 커밋(develop).
- **[0-1] run --resume** — RunState status/failed_reason/resume_from/loop_state, 실패 지점부터 재개(완료 step은 산출물 복원, 재실행 X).
- **[0-2] token budget** — `--max-tokens`/`HARNESS_MAX_TOKENS`, 초과 시 중단→--resume, 80% 경고.
- **[0-3] approval gate** — `{approval}` step, 거부=user_rejected(재개 가능), `--yes` 비대화. dev-preflight 착수 승인 1곳.
- **[0-4] Red Team 편향 분리** — critic은 target 결론만 격리(contextMode=conclusion_only).
- mock `npm test` → **57/57 통과**.

## 현재 상태 요약 (한 줄)

provider 3종 + 루프 3종 + 분화 + 멀티에이전트 task-prompt + Obsidian + v2.5 안전장치(resume/budget/approval/편향분리)까지 완비. mock 기준 `npm test` 57/57. git: **main=v2.5.0(태그 완료)**, develop에 v3 dogfooding 문서까지(origin/develop 동기화됨).

## Phase 1 도그푸딩 완료 (2026-07-08)

- 실제 아이디어 A(증적엔진)/B(폐쇄망) full-predev(claude-code) 검증 — **CEO 게이트 두 분기(축소/검증) 실발화**.
- A로 dev-preflight(--allow-spawn --yes) → 하위 3개 실제 실행 + 승인게이트 + task-prompt 병렬 스펙 handoff.
- 하네스 self-review(mvp-planning) — critique_loop 2R + 0-4 편향분리 실전 검증.
- 실전 검증된 v2.5 경로: 게이트 두 분기·무한루프 가드·분화+allow-spawn·승인게이트·critique_loop·편향분리·토큰계측. 스키마 경고 0. (resume/budget만 실패상황 미재현, mock 검증됨.)
- 산출물: `docs/backlog/V3_FIELD_NOTES.md`. 아이디어 원문/결과는 gitignore된 `projects/dogfood-*` 로컬 전용.

## v3 진입 게이트 충족 (2026-07-08, 이 세션)

- **"실제 개발 착수 1건" 게이트 충족됨.** 별도 private 레포 `github.com/agrade1/audit-evidence-engine`(하네스 로컬 설치)에서 아이디어 A(증적엔진)를 full-predev(claude-code) 검증 → task-prompt → **실제 코드 착수 완주**(`scripts/collect_evidence.sh`: KISA U-코드 읽기전용 점검→증적 패키지. CEO 판정 경계 준수로 remediation/제품코드 없음). 아이디어 F(인프라교육)도 idea-validation로 추가 검증("추가 검증" 판정).
- → v3 착수 3조건(아이디어 2건 검증 + 1건 개발착수) **모두 충족.** 이제 v3는 "규율상 착수 가능" 상태.

## 다음 작업 (self-review 결론 반영)

- v3 게이트는 충족됐으나, self-review 처방대로 **바로 v3.0 코딩에 들어가지 않는다.** execute는 안전경계 시나리오("게이트 이후 실패 시 롤백 주체") 서면 뒤에만, report는 **관측성 통증이 실사용에서 수치로 확인된 뒤** 최소형. (FIELD_NOTES "자기검토 결론" 참고.)
- **관측성 통증 측정법**(v3 report 필요성 판단 기준): 하네스를 실서비스에 반복 사용하며 — ① run당 소요/토큰을 run_state에서 집계했을 때 "매번 파일 열어 확인"이 번거로운가, ② 프로젝트 여러 개의 최신 run 상태를 한눈에 못 봐서 불편한가, ③ 게이트 되돌림/실패 원인을 run_state.json 수동 파싱으로 찾는 빈도가 높은가. 이 통증이 실제로 쌓이면 그때 `harness report`(read-only 스냅샷 표)를 최소형으로.
- 하네스 자체는 현재 "충분히 좋다"(v2.5.0) — 다음 코딩은 하네스가 아니라 **실서비스(audit-evidence-engine 등)** 쪽에서 나온다.
- [보류] anthropic 유료 1회 실검증(비용), resume/budget 실패상황 재현 — 우선순위 낮음.
- 범위 확장 금지 유지. 하네스는 현재 "충분히 좋다"(v2.5.0).
