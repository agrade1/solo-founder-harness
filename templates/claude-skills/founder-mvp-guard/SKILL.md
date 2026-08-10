---
name: founder-mvp-guard
description: Guardrails for developing a product from solo-founder-harness handoff documents. Use in every coding, design, or planning session in this project. Enforces the handoff instruction as the contract, keeps scope at MVP, and verifies acceptance criteria before reporting done.
---

# Founder MVP Guard

This project was scoped by an agent workflow (Research → PM → UX → Tech Lead → Red Team → CEO). The generated documents are the contract.

## Source-of-truth order

When instructions conflict, higher wins:

1. The user's direct message in this session
2. `docs/handoff.md` (Claude Code 작업 지시문)
3. `docs/decision.md` (최종 사업 판단 문서)
4. Other generated docs (market / product / UX / tech / risk)

Never edit generated judgment documents. If reality contradicts them, report the contradiction; the harness re-runs, you don't patch.

## MVP scope enforcement

- Implement exactly what the handoff specifies — no more, no less.
- Spec'd features are not over-engineering: implement them fully even if a minimalism rule suggests cutting.
- Unspec'd "nice to have" ideas: one-line proposal max, then drop unless approved.
- New dependency = one-line justification + approval before install.

## Done means verified

- Each handoff task has acceptance criteria. A task is done only when the criteria pass with shown evidence (test output, command result, screenshot path).
- Failed criteria: report the failure verbatim, do not narrate around it.
- After each task: 1-line append to `WORKLOG.md`, then stop for approval before the next gated task.

## Risk surfacing

The Red Team doc lists known risks. When your implementation touches a listed risk area, name it in the report ("Red Team 리스크 #N 관련") so the founder can judge.
