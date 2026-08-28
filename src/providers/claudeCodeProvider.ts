import { spawn } from "node:child_process";
import type { Provider, AgentRunInput, AgentResult, TokenUsage } from "./provider.js";
import { buildPromptParts } from "./promptParts.js";
import { redactSecrets, collectSecretValues } from "../tools/redact.js";

/**
 * B안 provider: `claude -p` (headless print mode)에 위임한다.
 * 사용자 Claude 구독으로 로그인된 claude CLI를 사용 → API 종량과금 없이 구독 한도 내 소비.
 * (설계: docs/reference/PROVIDER_ARCHITECTURE_V2.md)
 *
 * 환경변수:
 *   HARNESS_CLAUDE_BIN        claude 실행 파일 경로 (기본 "claude")
 *   HARNESS_CLAUDE_MODEL      --model 값 (기본: 구독 기본 모델)
 *   HARNESS_CLAUDE_TIMEOUT_MS 호출 타임아웃 ms (기본 900000 — [C-140])
 */

// 실행 파일/타임아웃은 호출 시점에 읽는다 (스텁 주입·테스트 가능성 확보. 기본값은 동일).
const claudeBin = () => process.env.HARNESS_CLAUDE_BIN ?? "claude";
const CLAUDE_MODEL = process.env.HARNESS_CLAUDE_MODEL;
/**
 * [C-140] 기본 900초. 예전 기본 300초는 **live에서 실제로 정당한 호출을 죽였다** — 리서치 계약이
 * 붙은 프롬프트에서 1차 호출이 타임아웃했고, 900초로 늘리자 self 337초 · external 148초로 성공했다
 * (2026-08-27). 이후 관측된 단일 호출 분포는 93~233초에 몰려 있고 상한 2건이 337.5초·352.6초다 —
 * 300초는 그 꼬리를 자르고 900초는 관측 최대의 2.5배 여유를 둔다.
 * 무제한이 아닌 이유: 멈춘 호출은 여전히 끝나야 하고, 죽이지 않으면 run 전체가 영원히 매달린다.
 * (기각한 대안: step 종류별 상한 — 지금 근거는 "리서치가 길다" 하나뿐이고, 축을 하나 더 만들면
 *  registry·CLI·문서에 어휘가 번진다. 분포가 step별로 갈린다는 실측이 나오면 그때 쪼갠다.)
 */
const timeoutMs = () => Number(process.env.HARNESS_CLAUDE_TIMEOUT_MS ?? 900_000);

/** 공유 빌더로 system+user를 만들어 claude -p용 단일 프롬프트로 합친다. */
function buildPrompt(input: AgentRunInput): string {
  const { system, user } = buildPromptParts(input, "claude-code");
  return `${system}\n\n---\n${user}`;
}


/** `modelUsage`의 모델별 항목. 필드명이 `usage`와 달리 **camelCase**다 (CLI가 그렇게 낸다). */
interface ClaudeModelUsage {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

interface ClaudeJsonResult {
  result?: string;
  /**
   * [B-46] **whole-tree 회계.** 최상위 `usage`는 서브에이전트(Task) 토큰을 **빼고** 낸다.
   * 2026-08-27 실측(같은 호출 1회): 서브에이전트를 띄우면 `usage` 입력 합 **69,297** ·
   * `modelUsage` 입력 합 **91,036** — 21,739 토큰이 `usage`에서 사라진다. 서브에이전트가 없으면
   * 둘이 정확히 같다(33,903 = 33,903). 예산이 지키려는 것은 이 run이 실제로 태운 전부이므로
   * `modelUsage`가 있으면 그것을 쓴다.
   */
  modelUsage?: Record<string, ClaudeModelUsage>;
  /**
   * [B-46] claude CLI의 `usage`는 입력을 **세 필드로 쪼개 낸다**: 캐시되지 않은 `input_tokens`,
   * 새로 캐시에 쓴 `cache_creation_input_tokens`, 캐시에서 읽은 `cache_read_input_tokens`.
   * 프롬프트가 크면 거의 전부가 뒤 두 필드로 가고 `input_tokens`는 한 자릿수가 된다
   * (2026-08-27 실측: 짧은 프롬프트 1회에 `input_tokens: 2` / `cache_creation_input_tokens: 33,178`).
   */
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  is_error?: boolean;
}

/** 앞뒤 ```markdown 코드펜스가 있으면 제거한다. */
function stripFences(text: string): string {
  const t = text.trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/;
  const m = t.match(fence);
  return m ? m[1].trim() : t;
}

/**
 * claude -p argv를 조립한다. base(-p/--output-format/--model)에 compiled policy의
 * claudeArgs(--strict-mcp-config/--tools/--permission-mode/--allowedTools/--disallowedTools 등)를
 * 이어붙인다. policyArgs 미지정 시 기존 동작과 동일(회귀 없음).
 * (M2: argv 조립·검증까지. 실제 policy 배선은 M3 handoff/run에서.)
 */
export function buildClaudeArgs(policyArgs: string[] = [], model: string | undefined = CLAUDE_MODEL): string[] {
  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", model);
  args.push(...policyArgs);
  return args;
}

function runClaude(prompt: string, policyArgs: string[] = [], redactNames: string[] = []): Promise<string> {
  // [M2.1] 오류 메시지에 새는 secret을 가린다. secret 값은 provider 내부에서만 env로 조회하고,
  // 이름(redactNames) + Authorization/token/password 패턴을 함께 redaction한다.
  const secretValues = collectSecretValues(redactNames);
  const scrub = (s: string) => redactSecrets(s, secretValues);
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(policyArgs);

    const timeout = timeoutMs();
    const child = spawn(claudeBin(), args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p 타임아웃 (${timeout}ms). HARNESS_CLAUDE_TIMEOUT_MS로 조정 가능`));
    }, timeout);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) =>
      reject(new Error(`claude 실행 실패: ${scrub(e.message)} (claude CLI 설치/PATH 또는 HARNESS_CLAUDE_BIN 확인)`)),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p 종료코드 ${code}: ${scrub(err.trim() || out.trim() || "(출력 없음)")}`));
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
    // [M2.1] --tool-profile 지정 시 compile된 정책 argv를 실제 spawn에 반영. 미지정 시 [] → 기존 동작.
    const policyArgs = input.execContext?.claudeArgs ?? [];
    const redactNames = input.execContext?.redactNames ?? [];
    const raw = await runClaude(buildPrompt(input), policyArgs, redactNames);

    let markdown = raw.trim();
    let usage: TokenUsage | undefined;

    try {
      const obj = JSON.parse(raw) as ClaudeJsonResult;
      if (typeof obj.result === "string") markdown = obj.result;
      // [B-46] `modelUsage`(whole-tree)를 **우선**한다. 없으면 `usage`로 강하한다 —
      // 구버전 CLI·다른 스텁에서도 예전과 같은 값이 나오고 더 나빠지지 않는다.
      // (기각한 대안: `usage.iterations[]`를 합산 — num_turns 2인 호출에서 iterations 원소가 **1개**뿐이고
      //  그 안의 수치가 최상위와도 안 맞았다(실측). 총계로 쓸 수 없는 배열이다.)
      const mu = obj.modelUsage && Object.values(obj.modelUsage);
      if (mu && mu.length > 0) {
        usage = {
          inputTokens: mu.reduce(
            (s, m) => s + (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0),
            0,
          ),
          outputTokens: mu.reduce((s, m) => s + (m.outputTokens ?? 0), 0),
        };
      } else if (obj.usage) {
        // [B-46] **세 입력 필드를 전부 더한다.** 예전엔 `input_tokens`만 읽어서 캐시로 간 입력이
        // 통째로 사라졌다 — live 3 run의 `usage.input_tokens`가 16·26·36인데 output은 61k~133k였고,
        // 그래서 `--max-tokens`("누적 토큰(input+output) 상한" — runWorkflow.ts:245)가 **사실상
        // output 전용**으로 동작했다. 캐시 읽기는 과금이 싸지만 **컨텍스트 창은 똑같이 차지한다** —
        // 이 예산이 지키려는 것이 그 쪽이므로 할인 가중치를 두지 않고 그대로 센다.
        // (기각한 대안: `total_cost_usd`를 예산 축으로 삼기 — 토큰 상한과 다른 축이고 CLI 표면·
        //  provider 계약·기존 테스트를 전부 갈아야 한다. 필요해지면 별도 슬라이스.)
        usage = {
          inputTokens:
            (obj.usage.input_tokens ?? 0) +
            (obj.usage.cache_creation_input_tokens ?? 0) +
            (obj.usage.cache_read_input_tokens ?? 0),
          outputTokens: obj.usage.output_tokens ?? 0,
        };
      }
    } catch {
      // JSON 파싱 실패 시 stdout 원문을 결과로 사용 (usage 없음)
    }

    return { markdown: stripFences(markdown), usage };
  },
};
