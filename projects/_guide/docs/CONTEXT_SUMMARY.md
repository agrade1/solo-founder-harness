# CONTEXT_SUMMARY.md — _guide

최종 갱신: 2026-09-08

## 현재 상태
- 프로젝트 초기화됨. 아직 workflow 미실행.

## 다음 작업
- 00_IDEA.md를 실제 아이디어로 채운 뒤(이 템플릿 문장은 그대로 두면 안 된다) 4단계 파이프라인 실행:
  `harness pipeline next --project _guide --provider <mock|claude-code|anthropic>`
  단계마다 확인 대기에서 멈춘다 — 승인해야 다음 단계가 돈다.
  (workflow 하나만 돌리려면 `harness run <workflow> --project _guide`.)
