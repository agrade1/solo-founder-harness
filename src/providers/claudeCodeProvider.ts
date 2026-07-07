import { spawn } from "node:child_process";
import type { Provider, AgentRunInput, AgentResult, TokenUsage } from "./provider.js";
import { buildPromptParts } from "./promptParts.js";

/**
 * B안 provider: `claude -p` (headless print mode)에 위임한다.
 * 사용자 Claude 구독으로 로그인된 claude CLI를 사용 → API 종량과금 없이 구독 한도 내 소비.
 * (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md)
 *
 * 환경변수:
 *   HARNESS_CLAUDE_BIN        claude 실행 파일 경로 (기본 "claude")
 *   HARNESS_CLAUDE_MODEL      --model 값 (기본: 구독 기본 모델)
 *   HARNESS_CLAUDE_TIMEOUT_MS 호출 타임아웃 ms (기본 300000)
 */

const CLAUDE_BIN = process.env.HARNESS_CLAUDE_BIN ?? "claude";
const CLAUDE_MODEL = process.env.HARNESS_CLAUDE_MODEL;
const TIMEOUT_MS = Number(process.env.HARNESS_CLAUDE_TIMEOUT_MS ?? 300_000);

/** 공유 빌더로 system+user를 만들어 claude -p용 단일 프롬프트로 합친다. */
function buildPrompt(input: AgentRunInput): string {
  const { system, user } = buildPromptParts(input, "claude-code");
  return `${system}\n\n---\n${user}`;
}


interface ClaudeJsonResult {
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  is_error?: boolean;
}

/** 앞뒤 ```markdown 코드펜스가 있으면 제거한다. */
function stripFences(text: string): string {
  const t = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/;
  const m = t.match(fence);
  return m ? m[1].trim() : t;
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json"];
    if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);

    const child = spawn(CLAUDE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p 타임아웃 (${TIMEOUT_MS}ms). HARNESS_CLAUDE_TIMEOUT_MS로 조정 가능`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`claude 실행 실패: ${e.message} (claude CLI 설치/PATH 또는 HARNESS_CLAUDE_BIN 확인)`)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p 종료코드 ${code}: ${err.trim() || out.trim() || "(출력 없음)"}`));
        return;
      }
      resolve(out);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export const claudeCodeProvider: Provider = {
  id: "claude-code",

  async generate(input: AgentRunInput): Promise<AgentResult> {
    const raw = await runClaude(buildPrompt(input));

    let markdown = raw.trim();
    let usage: TokenUsage | undefined;

    try {
      const obj = JSON.parse(raw) as ClaudeJsonResult;
      if (typeof obj.result === "string") markdown = obj.result;
      if (obj.usage) {
        usage = {
          inputTokens: obj.usage.input_tokens ?? 0,
          outputTokens: obj.usage.output_tokens ?? 0,
        };
      }
    } catch {
      // JSON 파싱 실패 시 stdout 원문을 결과로 사용 (usage 없음)
    }

    return { markdown: stripFences(markdown), usage };
  },
};
