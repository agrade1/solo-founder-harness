import Anthropic from "@anthropic-ai/sdk";
import type { Provider, AgentRunInput, AgentResult, TokenUsage } from "./provider.js";
import { buildPromptParts } from "./promptParts.js";

/**
 * A안 provider: Anthropic API 직접 호출 (@anthropic-ai/sdk).
 * ⚠️ 구독과 별개인 종량 과금. ANTHROPIC_API_KEY(별도 API 키) 필요.
 * (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md)
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY         Anthropic API 키 (필수)
 *   HARNESS_ANTHROPIC_MODEL   모델 id (기본 claude-opus-4-8; 비용 절감시 claude-sonnet-5 등)
 *   HARNESS_ANTHROPIC_MAX_TOKENS  출력 상한 (기본 8000)
 */

const MODEL = process.env.HARNESS_ANTHROPIC_MODEL ?? "claude-opus-4-8";
const MAX_TOKENS = Number(process.env.HARNESS_ANTHROPIC_MAX_TOKENS ?? 8000);

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY 미설정 — anthropic provider(A안)는 별도 API 키가 필요하다(구독과 무관, 종량과금). " +
        "구독으로 무료 실행하려면 '--provider claude-code'를 사용하라.",
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

/** content 블록에서 text만 이어붙인다. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export const anthropicProvider: Provider = {
  id: "anthropic",

  async generate(input: AgentRunInput): Promise<AgentResult> {
    const { system, user } = buildPromptParts(input, "anthropic");

    const resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });

    const markdown = extractText(resp.content);
    const usage: TokenUsage = {
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
    };
    return { markdown, usage };
  },
};
