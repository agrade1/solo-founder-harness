import type { Provider } from "./provider.js";
import { mockProvider } from "./mockProvider.js";

/**
 * provider id → 구현체. v2 페이즈별로 추가:
 *   mock         (완료)  — 테스트/오프라인
 *   claude-code  (2단계) — B안, `claude -p` 위임 (구독 소비)
 *   anthropic    (3단계) — A안, Anthropic API 직접
 * (상세: docs/reference/PROVIDER_ARCHITECTURE_V2.md)
 */
const PROVIDERS: Record<string, Provider> = {
  mock: mockProvider,
};

export const DEFAULT_PROVIDER_ID = "mock";

export function availableProviderIds(): string[] {
  return Object.keys(PROVIDERS);
}

/** id로 provider를 얻는다. 미등록이면 throw. */
export function getProvider(id: string): Provider {
  const p = PROVIDERS[id];
  if (!p) {
    throw new Error(
      `알 수 없는 provider: ${id} (사용 가능: ${availableProviderIds().join(", ")})`,
    );
  }
  return p;
}
