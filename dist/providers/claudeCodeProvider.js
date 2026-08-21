import { spawn } from "node:child_process";
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
 *   HARNESS_CLAUDE_TIMEOUT_MS 호출 타임아웃 ms (기본 300000)
 */
// 실행 파일/타임아웃은 호출 시점에 읽는다 (스텁 주입·테스트 가능성 확보. 기본값은 동일).
const claudeBin = () => process.env.HARNESS_CLAUDE_BIN ?? "claude";
const CLAUDE_MODEL = process.env.HARNESS_CLAUDE_MODEL;
const timeoutMs = () => Number(process.env.HARNESS_CLAUDE_TIMEOUT_MS ?? 300_000);
/** 공유 빌더로 system+user를 만들어 claude -p용 단일 프롬프트로 합친다. */
function buildPrompt(input) {
    const { system, user } = buildPromptParts(input, "claude-code");
    return `${system}\n\n---\n${user}`;
}
/** 앞뒤 ```markdown 코드펜스가 있으면 제거한다. */
function stripFences(text) {
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
export function buildClaudeArgs(policyArgs = [], model = CLAUDE_MODEL) {
    const args = ["-p", "--output-format", "json"];
    if (model)
        args.push("--model", model);
    args.push(...policyArgs);
    return args;
}
function runClaude(prompt, policyArgs = [], redactNames = []) {
    // [M2.1] 오류 메시지에 새는 secret을 가린다. secret 값은 provider 내부에서만 env로 조회하고,
    // 이름(redactNames) + Authorization/token/password 패턴을 함께 redaction한다.
    const secretValues = collectSecretValues(redactNames);
    const scrub = (s) => redactSecrets(s, secretValues);
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
        child.on("error", (e) => reject(new Error(`claude 실행 실패: ${scrub(e.message)} (claude CLI 설치/PATH 또는 HARNESS_CLAUDE_BIN 확인)`)));
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
export const claudeCodeProvider = {
    id: "claude-code",
    async generate(input) {
        // [M2.1] --tool-profile 지정 시 compile된 정책 argv를 실제 spawn에 반영. 미지정 시 [] → 기존 동작.
        const policyArgs = input.execContext?.claudeArgs ?? [];
        const redactNames = input.execContext?.redactNames ?? [];
        const raw = await runClaude(buildPrompt(input), policyArgs, redactNames);
        let markdown = raw.trim();
        let usage;
        try {
            const obj = JSON.parse(raw);
            if (typeof obj.result === "string")
                markdown = obj.result;
            if (obj.usage) {
                usage = {
                    inputTokens: obj.usage.input_tokens ?? 0,
                    outputTokens: obj.usage.output_tokens ?? 0,
                };
            }
        }
        catch {
            // JSON 파싱 실패 시 stdout 원문을 결과로 사용 (usage 없음)
        }
        return { markdown: stripFences(markdown), usage };
    },
};
