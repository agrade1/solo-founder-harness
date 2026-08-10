# CLAUDE.md — {{PRODUCT_NAME}}

<!-- solo-founder-harness가 생성한 프로젝트 계약. {{ }} 는 하네스가 치환. -->

## 프로젝트

{{PRODUCT_ONE_LINER}}

- 단계: MVP (하네스 판단 문서 기준)
- 스택: {{TECH_STACK}}
- 타깃: {{TARGET_USER}}

## 계약 문서 (수정 금지 — 참조만)

- 작업 지시문: `docs/handoff.md` ← 모든 구현의 기준
- 사업 판단: `docs/decision.md`
- 리스크: `docs/risk.md` (Red Team)
- 요구사항·UX·기술: `docs/` 하위 생성 문서

문서와 현실이 충돌하면 구현으로 덮지 말고 보고한다. 재판단은 하네스가 한다.

## 명령어

```bash
{{DEV_COMMAND}}
{{BUILD_COMMAND}}
{{TEST_COMMAND}}
```

## 작업 규칙

- handoff.md의 태스크 순서·승인 기준을 따른다. 기준 통과 증거 제시 → 승인 대기 → 다음 태스크.
- 스펙에 명시된 기능은 축소 없이 전부 구현. 스펙 밖 기능은 구현하지 않는다.
- 파괴적 작업(force-push, 삭제, 마이그레이션)은 실행 전 1줄 확인.
- 의존성 추가는 이유 1줄 + 승인 후.
- 작업 단위 종료 시 WORKLOG.md에 1줄 기록.

## 하지 말 것

- docs/ 하위 하네스 생성 문서 수정
- 테스트 없는 "동작할 것" 단정 보고
- {{PROJECT_SPECIFIC_PROHIBITIONS}}
