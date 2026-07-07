# DECISIONS.md

## 2026-07-06

- agent prompt 파일명에서 버전 접미사 제거 (버전은 파일 내부 헤더로 관리)
- harness init 생성 docs = 6개 (00_IDEA, TASKS, DECISIONS, CONTEXT_SUMMARY, WORKLOG, API_CONTRACT), HANDOFF.md v1 제외
- 01~06 번호 문서는 workflow 실행 시 생성
- 구버전 가이드(solo_founder_harness_dev_guide)와 COMBINED_CORE_PROMPTS.md는 레포에서 제외
- v1 완료 기준 = acceptance test 1~5 전부 통과

## 2026-07-06 (2차)

- run_state.json v1 필수 필드 확정 (workflow_id, project, completed_steps, failed_agent, warnings, started_at, finished_at). resume은 v2
- 결과 저장 시 필수 섹션 헤더 검증(경고 수준) v1 포함
- v2/v3 로드맵은 docs/reference/ROADMAP.md — v1 개발 중 로드 금지
- v2 최우선 결정 = provider 전략 (API 직접 vs Claude Code subagent) → backlog/PROVIDER_STRATEGY_TODO.md
- 개발은 Opus 모델로 진행, 운영 규칙은 prompts/opus_optimization_guide.md
- IMPLEMENTATION_PLAYBOOK.md 추가: 세션 5개 기준 단계별 진행 순서 (사람용, Claude 기본 로드 제외)

## 2026-07-06 (v2 provider 결정)

- **provider 전략 = C안 확정**: 인터페이스에 mock/claude-code(B안,구독)/anthropic(A안,API) 3종, 플래그 교체. 지금은 claude-code로 운영, A안은 사용자가 종량과금 원할 때 추가.
- 이유: Claude.ai/ChatGPT 구독은 API 접근 미포함(별개 청구). 사용자는 기존 구독으로 추가비용 0 원함 → B안 우선.
- Provider.generate() 동기→비동기 + token usage 필드 신설(A안 예산상한 대비). mock은 계속 유지(acceptance 기반).
- 상세 설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md

## 2026-07-06 (v2 루프 아키텍처)

- workflow `steps`를 선형 `string[]`에서 `(string | {critique_loop})[]` union으로 확장 (V2_KICKOFF "steps→loop 확장"). CEO 게이트도 이 union에 `{gate}` 추가로 얹을 예정.
- Red Team 비평 루프는 **기존 mvp-planning에 내장**(새 워크플로우 추가 X) — acceptance Test 2의 "Workflows (4)" 개수 유지 위해. idea-validation 등 나머지는 선형 유지.
- 비평 루프 종료 조건 = critic 출력의 "### Critical" 리스크 소멸 OR max_rounds 소진. 무한루프 방지로 max_rounds 필수.
- priorFindings를 Map(upsert)로 변경 — 루프에서 agent 재실행 시 handoff 요약 중복/누적 방지, 순서 유지.
- 재생성 로직(v2-3)을 runStepWithRegen 헬퍼로 추출해 선형/루프 양쪽에서 재사용.
- CEO 게이트를 union에 `{gate}`로 추가(V2_KICKOFF 4번). full-predev에 내장(축소→pm, 검증→research), max_jumps로 무한루프 방지.
- 판정 추출(extractDecision)은 Main Judgment + Decisions 섹션만 검색 — 문서 전체 검색은 Input Summary의 역할설명("진행/축소/검증...")을 오탐하므로 금지.
- anthropic provider(A안): 프롬프트 빌더를 promptParts.ts로 claude-code와 공유(중복/drift 방지). 기본 모델 opus-4-8, 기본 provider는 mock 유지. 실제 유료 호출은 사용자 키 세팅 후 검증.

## 2026-07-07 (라이브러리화 방향)

- 하네스 배포 모델 = **설치형 라이브러리**로 전환 (사용자 의도: 하네스 하나에 서비스 쌓지 말고 서비스 레포마다 설치). 경로를 PACKAGE_ROOT(자산)/WORKSPACE_ROOT(CWD, 데이터)로 분리.
- projects/<name> 구조와 --project 플래그는 **유지**(최소 변경, acceptance 보존). "레포=단일 프로젝트"로 --project 없애는 건 별도 결정으로 보류.
- npm publish는 하지 않음 — install-ready(git/로컬 설치)까지. 실제 배포는 사용자 결정.
- 사용자 원래 기획 = 에이전트 분리(FE/BE 전문화). 3층으로 분해: ①정적 전문화 에이전트 추가 ②동적 분리 게이트 ③Claude Code 병렬 실행 연동(v3). 실제 병렬 코딩은 하네스가 아니라 Claude Code 영역(하네스는 기획문서+task-prompt 생성기). 상세: [[v2-provider-decision]] 다음 방향.

## 2026-07-07 (동적 분화 B-② 구현)

- 동적 분화 = `{fanout}` step. planner가 SPAWN 형식으로 하위 에이전트 선언 → fanout이 파싱해 런타임 생성·실행.
- **하위 에이전트는 레포에 영구 등록하지 않음** — 런타임 AgentDef + 생성 브리프(agentPromptText)로 per-run 생성. private/read-only 패키지와 충돌 회피, "동적"의 본질에 부합.
- **사람 승인 게이트 유지**(ROADMAP 원칙): 기본은 계획만 기록(executed:false), `--allow-spawn` 있을 때만 실제 실행. 자동 무단 생성 안 함.
- ①정적 전문 에이전트 추가는 보류 — 동적 분화로 갈음. 실제 병렬 코딩(B-③)은 여전히 Claude Code 영역(v3).
