import type { Provider } from "./provider.js";
import { mockProvider } from "./mockProvider.js";
import { claudeCodeProvider } from "./claudeCodeProvider.js";
import { anthropicProvider } from "./anthropicProvider.js";

export { getProviderCapabilities, type ProviderCapabilities } from "./capabilities.js";

/**
 * provider id → 구현체:
 *   mock         — 테스트/오프라인 (기본)
 *   claude-code  — B안, `claude -p` 위임 (구독 소비, 추가비용 0)
 *   anthropic    — A안, Anthropic API 직접 (별도 API 키, 종량과금)
 * (상세: docs/reference/PROVIDER_ARCHITECTURE_V2.md)
 */
const PROVIDERS: Record<string, Provider> = {
  mock: mockProvider,
  "claude-code": claudeCodeProvider,
  anthropic: anthropicProvider,
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
