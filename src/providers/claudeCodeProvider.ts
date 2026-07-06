import { spawn } from "node:child_process";
import type { Provider, AgentRunInput, AgentResult, TokenUsage } from "./provider.js";

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

/** AGENT_OUTPUT_SCHEMA를 따르는 단일 프롬프트를 구성한다 (system+context+아이디어+출력형식). */
function buildPrompt(input: AgentRunInput): string {
  const { agent, workflowId, project, createdAt, commonPrompt, agentPrompt, ideaContent, priorFindings, nextAgentId } =
    input;

  const priorBlock =
    priorFindings.length > 0
      ? priorFindings.map((f, i) => `- (${i + 1}) ${f}`).join("\n")
      : "- (첫 단계 — 이전 agent 판단 없음)";

  const nextAgentLine = nextAgentId ? nextAgentId : "(없음 — 이 workflow의 마지막 단계)";

  return `${commonPrompt}

---
# 너의 역할: ${agent.name} (${agent.role})

아래는 이 역할의 상세 운영 프롬프트다. 이 지침에 따라 판단하라.

${agentPrompt}

---
# 검토 대상 아이디어 (docs/00_IDEA.md)

${ideaContent.trim() || "(아이디어 문서가 비어 있음 — 일반 원칙에 따라 판단하고 그 사실을 Assumptions에 명시하라.)"}

---
# 실행 컨텍스트

- workflow_id: ${workflowId}
- project: ${project}
- 이전 에이전트 판단 요약:
${priorBlock}
- 다음 에이전트: ${nextAgentLine}

---
# 출력 형식 (반드시 지켜라)

결과는 아래 markdown 구조를 **정확히** 따른다. 문서 외 서문/설명/코드펜스 없이 문서만 출력한다.
첫 줄은 "# Agent Output". "## Metadata" 섹션에는 아래 값을 그대로 넣는다:

- agent_id: ${agent.agent_id}
- agent_name: ${agent.name}
- workflow_id: ${workflowId}
- project: ${project}
- created_at: ${createdAt}
- provider: claude-code
- input_sources: docs/00_IDEA.md, 이전 agent 결과

이어서 다음 "## 섹션"을 모두 포함한다 (헤더명은 정확히 일치시킬 것):
Input Summary / Main Judgment / Key Findings / Decisions / Assumptions /
Risks(하위 "### Critical" "### High" "### Medium" "### Low") /
Recommended Next Actions(1~3개) / Next Agent(값: ${nextAgentLine}) /
Artifacts To Update(값: ${agent.default_output}) / Handoff Notes.

Main Judgment은 결론을 먼저 한 문장으로 제시하고, 각 섹션은 이 역할 관점에서 구체적으로 채운다.`;
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
