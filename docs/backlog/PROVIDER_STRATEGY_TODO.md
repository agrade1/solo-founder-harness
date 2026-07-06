# PROVIDER_STRATEGY_TODO.md

v2 착수 전 결정 필요. v1에서는 읽지 않는다.

결정할 것: 실제 LLM provider 경로

```text
A안: Anthropic API 직접 호출
  + 독립 CLI, 자동화 유연
  - 종량 과금 (workflow 1회 = 5~7 agent 호출, 긴 프롬프트)

B안: Claude Code subagent/skill로 실행
  + 구독 요금 내 해결, provider 코드 최소화
  - Claude Code 환경 종속

준비물: v1 mock provider 인터페이스에 token usage 필드가 이미 있어야
       A안 선택 시 예산 상한을 리팩토링 없이 붙일 수 있다.
```
