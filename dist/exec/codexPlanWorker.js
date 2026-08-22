/**
 * V3 M10 T7 — **codex 리뷰어 worker backend**(대장 `C-97`).
 *
 * 무인 loop가 리뷰어 세션을 **직접** 띄우게 만드는 것이 이 모듈의 존재 이유다. 리뷰 왕복 계약
 * (`designReviewRoundtrip.assertCodeReviewRoundtrip`)은 리뷰어·verify가 **fresh Codex read-only**여야
 * 한다고 요구하는데, M10까지 autopilot이 아는 live backend는 `claude-plan` 하나뿐이라 그 축이
 * **표현 불가**였다(M9는 스크립트가 단계를 부르는 형태로만 증명했다).
 *
 * ## `livePlanWorker`(claude)와 같은 것 · 다른 것
 *
 * **같다**: 스트림 계약(`started → progress ≥1 → terminal 1건`) · 계획 JSON을 텍스트에서 꺼내는 방식
 * (`extractPlanJson` **재사용** — 두 번째 추출기를 만들지 않는다) · 계획 계약 프롬프트(`planContractPrompt`
 * 재사용) · turn마다 **새 프로세스**이고 resume이 없다(그래서 "fresh 세션"이 구조적으로 참이다) ·
 * durable에 원문을 남기지 않는다(중앙으로 가는 것은 검증된 계획과 bounded 요약뿐).
 *
 * **다르다**: 실행 파일·홈이 `executionAuthority.codex`/`.codexHome`에서 온다(claude worker의
 * `executionAuthority.claude`와 같은 자리) · 자식 env는 **`CODEX_HOME` 하나**다(M5a 계약 — 부모 env를
 * 상속하지 않으므로 ambient 자격증명이 도달할 통로가 없다) · sandbox는 **`read-only` 고정**이고 그 값을
 * 고를 인자가 없다(리뷰어가 쓰기를 얻는 통로를 만들지 않는다).
 *
 * ## 승인 계층은 여기서 만들지 않는다
 *
 * 홈·실행 파일 검증은 `codexCliProvider`의 `verifyCodexHome`/`verifyCodexExecutable`을 **그대로 쓴다**
 * (두 번째 홈 계약을 만들지 않는다 — 대장 `B-7ⓐ`가 그 계약의 정본이다).
 *
 * ## 하지 않는 것
 *
 * - resume·세션 재사용·`--output-schema`·MCP·쓰기 sandbox·네트워크 도메인 승인. 전부 표현할 필드가 없다.
 * - `--skip-git-repo-check`를 붙이지 않는다: CLI 자신의 "신뢰된 디렉터리" 가드를 끄지 않는다는 뜻이고,
 *   v3 workspace는 어차피 승인된 checkout이다(`executionBoundary`가 그것을 요구한다).
 */
import { spawn } from "node:child_process";
import { OrchestrationError, TYPED_EXECUTION_PLAN_SCHEMA_VERSION } from "./orchestrationTypes.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";
import { extractPlanJson, MAX_WORKER_STDOUT_BYTES } from "./livePlanWorker.js";
import { CodexJsonlParser } from "./codexStreamParser.js";
/** 무인 loop가 아는 **세 번째** backend 이름(닫힌 집합의 나머지 한 값). */
export const CODEX_PLAN_BACKEND = "codex-plan";
/** 리뷰어 모델·추론 강도 — 승인 문서가 고르는 값이 아니다(닫힌 상수). */
export const CODEX_WORKER_MODEL = "gpt-5.6-sol";
export const CODEX_WORKER_EFFORT = "medium";
/**
 * codex 리뷰어에게 주는 **인자 전부**. 호출자가 더하거나 뺄 통로가 없다.
 *
 * - `--sandbox read-only`: 리뷰어는 읽기만 한다(M5a hard deny와 같은 값).
 * - `--ignore-user-config --ignore-rules --strict-config`: 사용자 config·rule이 리뷰 결과를 바꾸지 못한다.
 * - `mcp_servers={}`: 격리 홈과 이중으로 MCP를 비운다.
 * - `--json`: JSONL 스트림(파서는 `codexStreamParser` 하나를 쓴다).
 */
export function codexWorkerArgs(cwd) {
    return Object.freeze([
        "exec",
        "--json",
        "--model",
        CODEX_WORKER_MODEL,
        "--config",
        `model_reasoning_effort="${CODEX_WORKER_EFFORT}"`,
        "--config",
        "mcp_servers={}",
        "--strict-config",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--cd",
        cwd,
    ]);
}
export const CODEX_WORKER_CODES = [
    "worker_spawn_failed",
    "worker_no_output",
    "worker_plan_missing",
    "worker_deadline_exceeded",
    "worker_cancelled",
];
function workerError(code, what) {
    return new OrchestrationError(code, `codex worker: ${what}`);
}
/**
 * turn 하나. **프로세스 하나 = 세션 하나**이고 resume이 없으므로 이 turn의 세션은 언제나 fresh다
 * (왕복 계약의 "fresh 세션" 축이 구조적으로 참이 되는 근거다).
 */
export function startCodexPlanTurn(launch) {
    const events = [];
    const run = async () => {
        let child;
        try {
            child = spawn(launch.executable, [...codexWorkerArgs(launch.cwd), launch.prompt], {
                // **자식 env는 `CODEX_HOME` 하나**다(M5a). 부모 env를 상속하지 않는다.
                env: { CODEX_HOME: launch.codexHome },
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
            });
        }
        catch {
            throw workerError("worker_spawn_failed", "실행 파일을 띄울 수 없다(형식·권한)");
        }
        const parser = new CodexJsonlParser({ model: CODEX_WORKER_MODEL, cwd: launch.cwd, sandbox: "read-only" });
        let lastMessage = "";
        let usage = { inputTokens: 0, outputTokens: 0 };
        let bytes = 0;
        let killedBy = null;
        const timer = setTimeout(() => {
            killedBy = "deadline";
            child.kill("SIGKILL");
        }, Math.max(1_000, launch.timeoutMs));
        const onAbort = () => {
            killedBy = "cancel";
            child.kill("SIGKILL");
        };
        if (launch.signal !== undefined) {
            if (launch.signal.aborted)
                onAbort();
            else
                launch.signal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            // 상한을 넘으면 **더 읽지 않는다**(계획은 마지막 메시지에서 나오므로 넘친 스트림은 실패다).
            bytes += Buffer.byteLength(chunk, "utf8");
            if (bytes > MAX_WORKER_STDOUT_BYTES) {
                killedBy = killedBy ?? "deadline";
                child.kill("SIGKILL");
                return;
            }
            // 파서 이벤트는 provider 중립 형태다: 최종 텍스트는 `assistant`, 사용량은 `finish()`가 낸
            // `result`에 실린다(중간 `assistant`에도 도구 payload가 올 수 있어 **텍스트가 있는 것만** 취한다).
            for (const e of parser.push(chunk)) {
                if (e.kind === "assistant" && e.text.length > 0)
                    lastMessage = e.text;
            }
        });
        // stderr는 읽지 않는다(`B-7ⓑ`와 같은 규율 — 원문·secret이 이 프로세스 메모리에 들어오지 않는다).
        child.stderr?.resume();
        await new Promise((resolve) => {
            child.once("error", () => resolve());
            child.once("close", () => resolve());
        });
        clearTimeout(timer);
        launch.signal?.removeEventListener("abort", onAbort);
        // 종료 이벤트에서 사용량을 읽는다. 읽지 못하면 **0으로 보고한다**(지어내지 않는다 — 그러면 그 turn의
        // 토큰 축이 공허해지고 경과 축만 남는다. `livePlanWorker`와 같은 규율이다).
        for (const e of parser.finish({ code: 0, signal: null })) {
            if (e.kind === "result")
                usage = { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens };
            else if (e.kind === "assistant" && e.text.length > 0)
                lastMessage = e.text;
        }
        if (killedBy === "cancel")
            throw workerError("worker_cancelled", "취소로 세션을 종료했다");
        if (killedBy === "deadline")
            throw workerError("worker_deadline_exceeded", "세션 상한을 넘겨 종료했다");
        if (lastMessage.length === 0)
            throw workerError("worker_no_output", "모델 메시지가 없다");
        const json = extractPlanJson(lastMessage);
        if (json === null)
            throw workerError("worker_plan_missing", "응답에서 계획 JSON을 찾지 못했다");
        let parsed;
        try {
            parsed = JSON.parse(json);
        }
        catch {
            throw workerError("worker_plan_missing", "계획 JSON을 파싱할 수 없다");
        }
        // **계약이 소유한 필드는 중앙이 채운다** — `livePlanWorker`와 **완전히 같은 한 줄**이다(V3 M10 T7
        // 실측으로 확정). 프롬프트가 모델에게 `schemaVersion`·binding을 적지 말라고 하는데
        // (`planContractPrompt`) 검증기는 그 다섯 필드를 **요구**하므로, 채우지 않으면 모델이 계약을
        // 완벽히 지켜도 항상 `plan_invalid`다. live 리뷰어 turn이 전부 그렇게 죽었다(실측: codex가 낸
        // `{"operations":[],"result":{…}}`는 규격대로였는데 거부됐다).
        //
        // 이전 판의 주석("정규화·동결 계획을 실으면 autopilot 재검증이 닫힌 key 집합에서 걸린다")은
        // **틀렸다** — claude 갈래가 바로 그 정규화 계획을 실어 통과한다. 원인은 재검증이 아니라
        // 여기서 중앙 필드를 채우지 않은 것이었다.
        //
        // 모델이 무엇을 적었든 durable 값이 **덮는다** → 계획이 다른 run·task·attempt·turn을 주장할 통로가
        // 없다(거부가 아니라 **표현 불가**이므로 claude 갈래와 같은 세기다).
        const plan = validateTypedExecutionPlan({ ...parsed, ...launch.binding, schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION }, launch.binding);
        events.push({ kind: "progress", seq: 2, step: "codex-review" });
        events.push({ kind: "terminal", seq: 3, plan, usage });
    };
    return {
        async *[Symbol.asyncIterator]() {
            yield { kind: "started", seq: 1 };
            await run();
            for (const e of events)
                yield e;
        },
    };
}
