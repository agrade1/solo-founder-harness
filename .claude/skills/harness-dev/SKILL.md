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
