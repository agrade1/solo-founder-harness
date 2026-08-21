---
name: harness-dev
description: Rules for working inside the solo-founder-harness repository (TypeScript CLI — v1 docs automation + v2 providers + v3 exec/mission layer). Use in every session that edits, reviews, or plans code or documents in this repo — even for small changes. Enforces the current scope, the document contract, and approval gates.
---

# Harness Development Rules

This repo is built against fixed specs with explicit approval gates. Spec wins over cleverness.
`CLAUDE.md` is the session contract and always wins over this skill.

## Scope guard (hard boundary)

Current shipped scope: v1 문서 자동화(init/list/run/summary/task-prompt) + v2 provider 계층
(mock / claude-code / anthropic) + exec·mission 실행 계층. 실행 계층은 **승인·권한 게이트 안에서만** 동작한다.

Out of scope — do not implement, scaffold, or add dependencies for these, even "to prepare":

- 승인 없는 코드 수정 · production 변경(배포 / DB / live 결제)
- Codex 자동 리뷰 · OMC 연동 · Agent Teams 연동 · Web UI · DB · 배포 · 결제

If a task seems to require any of these, stop and flag: "범위 밖 — docs/DECISIONS.md 논의 필요."

패키지 설치는 사전 승인 후에만 진행한다.

## Document contract

These files are the project's contract. Never rewrite them wholesale; propose diffs only.

| File | Role | Update rule |
|---|---|---|
| `CLAUDE.md` | Session contract | Diff proposal only, user applies |
| `AGENTS.md` | 리뷰·병렬 세션·테스트 정책 | Diff proposal only |
| `docs/TASKS.md` | Task list + acceptance criteria | Mark status; never delete entries |
| `docs/DECISIONS.md` | Irreversible decisions | Append-only |
| `docs/WORKLOG.md` | What was done | Append after each work unit |
| `docs/CONTEXT_SUMMARY.md` | Rolling context | Refresh at session end if state changed |

V3 작업의 구현 근거는 활성 문서 3건뿐이다 (`docs/backlog/V3_AUTONOMOUS_ORCHESTRATION_ROADMAP.md` ·
`V3_MCP_CAPABILITY_TOOL_PROFILES.md` · `V3_DESIGN_LEARN_PROGRESS_HANDOFF.md`). 충돌 시 로드맵이 우선한다.
`docs/archive/*` 는 근거로 쓰지 않는다.

## Approval gates

- A task is done ONLY when its acceptance criteria pass (`docs/ACCEPTANCE_TEST_CHECKLIST.md` Test 1~5 포함).
  Run the verification, show the result, then stop for approval before starting the next task.
- Never batch multiple gated tasks into one "done" report.
- Stress · live runner · 반복 실행은 마일스톤/하드닝 게이트에서만 (해당 계약을 건드린 변경은 예외).

## Review findings triage

리뷰 finding은 **A(지금 차단) / B(지정 마일스톤·트리거 전 필수) / C(개선 backlog)** 로 분류한다.
C만으로는 리비전 루프를 다시 돌리거나 진행을 멈추지 않는다. 유예 항목은 조용히 버리지 않고
대장에 남긴다(심각도·확률·영향 반경·유예 비용·수정 공수·기한·담당·증거·상태). 상세: `AGENTS.md`, 로드맵 §9.1.

## 배송 우선 진행 방식 (MVP-first)

**기능 전체를 먼저 세우고 개선은 그 다음이다.** 한 지점을 끝까지 다듬느라 남은 기능이 착수도 못 하는
상태를 만들지 않는다.

- **A급·크리티컬은 즉시 고친다**: 승인·인증·상태 전이 우회 · 데이터 손실 · 거짓 성공 영수증 ·
  되돌리기 어려운 아키텍처 결정 · **문서·주석·커밋 메시지의 과대주장**.
- **B/C는 대장에 기록하고 보류**한다. 진행을 멈추지 않는다. 값싸고(수 줄) 오독을 실제로 줄이는 C는
  그 자리에서 처리해도 된다 — 기준은 "안 고치면 다음 사람이 틀린 것을 믿게 되는가"다.
- **보류 ≠ 폐기**: 대장 항목(심각도·확률·영향 반경·유예 비용·수정 공수·기한·담당·증거·상태)이 없으면
  보류가 아니라 누락이다.
- 기능이 다 선 뒤 **하드닝 slice**에서 유예 항목을 비용순으로 처리한다.
- 이 방식은 **테스트 완화·삭제 금지**와 **과대주장 금지**를 면제하지 않는다. 그 둘은 속도와 바꾸지 않는다.

## 모델 분업 (세션이 달라져도 유지)

| 역할 | 모델 |
|---|---|
| 맥락 파악 · 계획 · 설계 | **fresh Fable 5** |
| **부정적·적대적 비판 리뷰**(read-only · 구현자와 다른 세션) | **fresh Fable 5** |
| 구현 · 리비전 · 통합 | **fresh Claude Code Opus 5** |

리뷰 프롬프트에는 **깨야 할 지점**(주장한 계약 · 안전 경계 · 테스트 공허성 · 과대주장)을 명시하고,
자료 조사가 끝났으면 **판정과 개선점만** 요구한다. 자기 코드를 자기가 승인하지 않는다.

**병렬 가능한 것은 병렬로 돌린다** — 격리 worktree + 파일 소유권 분리가 성립할 때만. 공유 schema/API
변경 · 통합 · 상태 마이그레이션 · 최종 전체 테스트 · 배타 자원 테스트는 **직렬**이다(AGENTS.md).

## Anti-shrink rule

Minimalism plugins may suggest cutting features. If a feature is specified in `docs/TASKS.md`, the roadmap,
or the handoff spec, implement it fully — spec'd scope is not over-engineering. Cut only what NO spec requires.
테스트 완화·삭제는 금지.

## Agent prompts

`agents/*.md` 와 `prompts/*` 는 agent 행동을 정의한다 (Research → PM → UX → Tech Lead → Red Team → CEO).
코드 주석이 아니라 product content로 다룬다: 변경 시 `docs/DECISIONS.md` 항목이 필요하다.
세션 중에는 원문 전체를 읽지 않고 경로·존재만 확인하며, 특정 agent 디버깅 시에만 해당 파일 하나를 연다.

## Project templates

`templates/` 는 **이 레포용이 아니라** 하네스가 만든 대상 프로젝트에 설치할 자산이다.

- `templates/CLAUDE.md` — 생성 프로젝트의 계약 문서 템플릿 (`{{ }}` 치환)
- `templates/claude-skills/founder-mvp-guard/SKILL.md` — 생성 프로젝트에 설치할 Claude Code 스킬

절대 이 레포 루트의 `CLAUDE.md` 나 `.claude/skills/` 로 복사하지 않는다.
