# PROVIDER_ARCHITECTURE_V2.md

v2 provider 설계. V2_KICKOFF 1번(provider 전략)의 구현 기준. 결정 배경은 PROVIDER_STRATEGY_TODO 참고.

## 결정 (2026-07-06): C안

Provider 인터페이스에 **여러 구현체**를 붙이고 플래그로 교체한다.

| provider id | 용도 | 비용 | 패키지 |
|-------------|------|------|--------|
| `mock` | 테스트/오프라인 (v1부터 존재, 유지) | 0 | 없음 |
| `claude-code` | **B안** — `claude -p` headless 위임, 사용자 Claude 구독 한도 내 소비 | 구독 내(추가 0) | 없음 (shell out) |
| `anthropic` | **A안** — Anthropic API 직접 (`@anthropic-ai/sdk`) | 종량 과금 | @anthropic-ai/sdk (이때만 설치) |

**왜 C안:** Claude.ai/ChatGPT 구독은 API 접근을 포함하지 않음(별개 청구). 사용자는 기존 구독으로 추가비용 없이 쓰길 원함 → 당분간 `claude-code`(B안)로 운영, 나중에 필요 시 `anthropic`(A안) 추가.

## 인터페이스

```ts
interface AgentResult {
  markdown: string;
  usage?: { inputTokens: number; outputTokens: number };
}
interface Provider {
  readonly id: string;
  generate(input: AgentRunInput): Promise<AgentResult>;  // v1은 동기 string이었음 → async + usage
}
```

- 비동기화가 `runAgent → runWorkflow → run 커맨드`까지 전파된다.
- `usage`는 `anthropic`가 실제 채우고, `claude-code`는 계측 불가라 생략/추정, `mock`은 0. (A안 예산상한 대비 필드는 지금 신설)
- `run_state.json`에 usage 합계 기록.

## provider 선택

- CLI 플래그: `--provider mock|claude-code|anthropic`
- 기본값 자동감지(추후): `ANTHROPIC_API_KEY` 있으면 `anthropic` → 없으면 `claude-code` → 그것도 안되면 `mock`. `--provider`로 항상 강제.

## 작업 순서

1. **인터페이스 async화 + usage 필드 + 전체 스레딩.** mock 유지 → acceptance 30 checks 계속 통과. (provider 무관, 설치 0)
2. **`claude-code` provider 구현 (B안).** 실제 LLM 첫 연동. 실제 프로젝트 1개로 end-to-end 검증. (설치 0)
3. **`anthropic` provider (A안).** 스텁 → 사용자가 API 붙일 때 구현. (@anthropic-ai/sdk 설치는 이때 승인)
4. 이후 루프 엔지니어링 (V2_KICKOFF 2번~).

## 불변 규칙

- mock provider는 계속 존재해야 한다 (오프라인 테스트/CI = acceptance 스위트의 기반).
- 실제 provider 실패는 v1의 `failed_agent` 경로로 그대로 기록 (FAILURE_RECOVERY).
- 범위 확장 방지: 이 문서 밖 기능은 backlog → 스펙 → 구현 순서로만.
