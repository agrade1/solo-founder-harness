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

## 배송 우선 — 무엇을 지금 고치고 무엇을 미루는가

기능 전체를 먼저 세운다. 완성도는 그 다음이다.

- **지금 고친다(A급·크리티컬)**: 데이터 손실 · 인증/권한 우회 · 결제·과금 오류 · 되돌리기 어려운 스키마
  결정 · 보안 · **보고의 과대주장**("동작 확인했다"는데 안 한 것).
- **기록하고 미룬다(B/C)**: bounded edge case · 성능 미세조정 · 리팩터링 · 문서 정밀도.
  `docs/BACKLOG.md`에 심각도·영향·기한/트리거·근거와 함께 남긴다. **기록 없는 보류는 누락이다.**
- 미룬 것 때문에 다음 기능 착수를 멈추지 않는다. 기능이 다 선 뒤 하드닝 단계에서 비용순으로 처리한다.
- 예외 없음: **테스트를 완화·삭제하지 않고**, 확인하지 않은 것을 확인했다고 적지 않는다.

## 모델 분업

- 맥락 파악 · 계획 · **적대적 비판 리뷰** → **Fable 5**(리뷰는 read-only이고 구현자와 다른 세션이다).
- 구현 · 리비전 → **Claude Code Opus 5**.
- 자기 코드를 자기가 승인하지 않는다. 리뷰 요청에는 **깨야 할 지점**을 명시한다.
- 파일이 겹치지 않는 작업은 **병렬**로 돌린다. 통합 · 스키마 변경 · 최종 전체 테스트는 **직렬**이다.

## Done means verified

- Each handoff task has acceptance criteria. A task is done only when the criteria pass with shown evidence (test output, command result, screenshot path).
- Failed criteria: report the failure verbatim, do not narrate around it.
- After each task: 1-line append to `WORKLOG.md`, then stop for approval before the next gated task.

## Risk surfacing

The Red Team doc lists known risks. When your implementation touches a listed risk area, name it in the report ("Red Team 리스크 #N 관련") so the founder can judge.
