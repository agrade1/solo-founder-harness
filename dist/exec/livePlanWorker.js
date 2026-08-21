/**
 * V3 M10 T3 — **live plan worker**: 무인 loop(`runAutopilot`)의 두 번째 worker backend다.
 *
 * `offlinePlanWorker`는 **운영자가 authoring한 계획 파일**을 읽는 데이터 어댑터다. 이 모듈은 그 자리에
 * **실제 모델 세션**을 놓는다 — 그래야 "무인 loop가 end-to-end를 돈다"가 스크립트가 단계를 부르는 것이
 * 아니라 loop 안에서 성립한다(로드맵 M10 완료 조건).
 *
 * ## 이 모듈이 여는 것과 열지 않는 것
 *
 * **연다**: 승인된 실행 파일 하나를 spawn해 프롬프트를 주고 stdout을 받는다.
 *
 * **열지 않는다**:
 * - **실행 대상 선택** — 경로·digest는 `kernel.approvedWorkerExecutable()`이 turn마다 다시 검증해 주는
 *   값이고 이 모듈에는 그것을 바꿀 인자가 없다. 승인에 그 키가 없으면 backend 자체가 표현 불가다.
 * - **권한 확대** — 모델이 낸 것은 **계획 문서 하나**뿐이고, 그 계획은 `validateTypedExecutionPlan`
 *   (offline backend와 **같은 validator**) → kernel의 승인 레코드 대조 → 소유권·`writableRoots`·digest
 *   재검증을 전부 지나야 한다. 계획에 없는 operation·승인 밖 경로·다른 task의 소유 경로는 그대로 거부다.
 *   **모델은 자기 권한을 스스로 넓힐 수 없다**(그래서 이 backend가 승인 경계를 바꾸지 않는다).
 * - **도구·네트워크** — 인자에서 권능을 끊는다: `--tools ""`(도구 0) · `--strict-mcp-config`(MCP 0) ·
 *   `--setting-sources ""`(사용자·프로젝트 설정 0) · `--no-session-persistence`(세션 기록 0).
 *   `--permission-mode`는 `default`다(**`plan`이 아니다** — 이유는 `LIVE_WORKER_ARGS` 주석의 실측).
 *   그래서 산출물은 **오직 계획 텍스트**이며, 실제 쓰기는 kernel typed-write 채널만 한다.
 *   (M8 live 실측: 도구를 끊은 세션도 **가짜 tool-use 텍스트**를 낼 수 있다. 그때 계약 검증이 그것을
 *   거부해 산출물로 승격되지 않았다 — 이 모듈도 같은 검증기 하나에 의존한다.)
 * - **원문 durable 반입** — stdout 전문은 여기서 끝난다. 중앙으로 가는 것은 검증된 계획과 bounded
 *   요약뿐이고, 프롬프트·응답 원문·토큰 카운터는 durable에 남지 않는다.
 *
 * ## 스트림 계약은 offline backend와 같다
 *
 * `started → progress ≥1 → terminal 정확히 1건`. 그래서 `silent_session`이 구조적으로 불가능하고,
 * autopilot의 deadline·취소·정리 경로가 backend와 무관하게 그대로 돈다.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { ARTIFACT_ROLES, LIMITS, OrchestrationError, TYPED_EXECUTION_PLAN_SCHEMA_VERSION } from "./orchestrationTypes.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";
/** 무인 loop가 아는 **두 번째** backend 이름(닫힌 집합의 나머지 한 값). */
export const LIVE_PLAN_BACKEND = "claude-plan";
/**
 * 모델에게 주는 **도구 없는 세션** 인자. 값이 상수인 이유: 호출자가 인자를 고를 수 있으면 그것이 곧
 * 임의 실행이다(`--eval`·`--settings`·`--add-dir`가 전부 그 통로다).
 *
 * 권능을 끊는 것은 세 축이다: `--tools ""`(도구 0) · `--strict-mcp-config`(MCP 서버 0) ·
 * `--setting-sources ""`(사용자·프로젝트 설정 0). 그래서 이 세션은 파일을 읽거나 쓰거나 명령을
 * 돌릴 수 없고, 낼 수 있는 것은 **텍스트 하나**뿐이다.
 *
 * **`--permission-mode plan`을 쓰지 않는다(V3 M10 T3 live 실측)**: plan 모드는 응답을 "계획 요약"으로
 * 감싸므로 계약이 요구하는 JSON이 나오지 않았다(첫 live 시도가 그래서 `worker_plan_absent`였고 그 한
 * turn에 output 67k 토큰을 태웠다). 같은 프롬프트를 plan 모드 없이 돌리면 **87 토큰**으로 정확한 JSON이
 * 나왔다. 대신 `default`를 **명시한다** — 생략하면 ambient 기본값(`acceptEdits`일 수 있다)에 의존하게
 * 되고, 그것이 곧 "환경이 권한을 고른다"는 뜻이다. 도구가 0이라 승인할 도구 호출 자체가 없다.
 *
 * **선례를 잘못 인용하지 않는다**(리뷰 B3): `src/core/handoff.ts`도 `--permission-mode default`를
 * 쓰지만 그쪽은 `--tools default`(**전체 도구** · 사람이 감독하는 대화형 세션)와 짝이므로 **이유가
 * 다르다**. 여기 근거는 그 선례가 아니라 ⓐ 도구 목록이 비어 있다는 것과 ⓑ headless에는 편집·명령을
 * 승인해 줄 사람이 없다는 것이다. `--tools ""`가 실제로 도구를 끊는다는 근거는 M8 live 실측이다
 * (도구를 끊은 세션이 **가짜** tool-use 텍스트를 냈고 실제 파일 접근은 없었다 — 로드맵 M8 절).
 */
export const LIVE_WORKER_ARGS = Object.freeze([
    "-p",
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--tools",
    "",
    "--permission-mode",
    "default",
    /**
     * **세션 기록을 남기지 않는다**(T3 적대적 리뷰 B1). 이것이 없으면 CLI가 turn마다 프롬프트 전문
     * (= assignment 본문 + context bundle)과 응답 원문을 **사용자 세션 저장소**에 쓴다. harness durable에
     * 남지 않는다는 성질만으로는 "원문이 어디에도 남지 않는다"가 아니다. 레포의 다른 headless 세션
     * (`src/tools/preflight.ts` · `src/tools/shadcnPilot.ts`)이 이미 같은 축을 끊는다.
     */
    "--no-session-persistence",
]);
/** 자식 프로세스에 주는 환경 **전부**. 부모 환경을 상속하지 않는다(secret·proxy·NODE_OPTIONS 차단). */
export const LIVE_WORKER_ENV = Object.freeze({
    /**
     * **`node`가 PATH에 있어야 한다**(V3 M9 live 실측 함정 중 하나 — nvm 등에서 `/usr/bin`에 node가 없다).
     * 승인된 worker 실행 파일이 `#!/usr/bin/env node` 스크립트면 이 PATH로 해석되므로, **이 컨트롤러를
     * 돌리는 그 node의 디렉터리**를 앞에 둔다. 부모 PATH를 상속하지는 않는다(그것이 임의 프로그램 통로다).
     */
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    /**
     * **`USER`만 더한다 — 실측으로 필요한 최소 하나다**(V3 M10 T3 live 실측).
     *
     * 닫힌 env로 처음 돌렸을 때 CLI는 `"Not logged in · Please run /login"`으로 **exit 1**이었다.
     * 부모 env에서 한 변수씩 빼며 이분한 결과: `USER`를 빼면 실패하고 `HOME`·`SHELL`·`TMPDIR`·`LANG`·
     * `LC_ALL`·`TZ`·`PATH`는 빠져도 성공한다 → 세션 자격증명은 **파일이 아니라 macOS Keychain**에 있고
     * 그 계정 해석에 `USER`가 쓰인다.
     *
     * **`HOME`을 주지 않는다** — 다만 이것은 **env 위생이고 경계가 아니다**(리뷰 B4). sandbox가 없고
     * 같은 uid이므로 HOME을 빼도 홈 **접근 권능**이 사라지지 않는다(`os.homedir()`는 HOME 부재 시 passwd로
     * 해석하고, Keychain 로그인이 성공한 것 자체가 계정 자원에 닿았다는 증거다). 주지 않는 이유는
     * "줄 필요가 없는 값을 주지 않는다"이며 경계는 `--setting-sources ""`·`--strict-mcp-config`·
     * `--no-session-persistence`가 만든다.
     *
     * **이 이분은 표본 1이다**(CLI 버전 하나). CLI가 갱신되면 다시 필요해질 수 있고 그 경우 실패 모드는
     * "로그인 안 됨"으로 **fail closed**다(조용한 성공이 아니다).
     *
     * 호출자별 오버라이드 표면은 열지 않는다(`MANAGED_PROCESS_ENV`와 같은 규율 — 그것이 곧 임의 env
     * 주입 통로다). 이 상수가 닫혀 있다는 성질 자체가 secret·`NODE_OPTIONS`·proxy 유입을 막는 근거다.
     */
    USER: process.env.USER ?? "",
});
/** stdout 수집 상한. 넘으면 그 자리에서 죽인다(무한 출력이 메모리를 먹지 않는다). */
export const MAX_WORKER_STDOUT_BYTES = 4 * 1024 * 1024;
export const LIVE_WORKER_CODES = [
    /** 승인에 live worker 실행 파일이 없다(backend 표현 불가). */
    "worker_backend_unapproved",
    "worker_spawn_failed",
    "worker_exit_nonzero",
    "worker_deadline_exceeded",
    "worker_output_too_large",
    /** 출력에서 계획 JSON을 찾지 못했다(모델이 계약 밖 텍스트만 냈다). */
    "worker_plan_absent",
    "worker_plan_unparsable",
];
/**
 * CLI가 보고한 사용량을 **bounded 정수 둘**로 접는다. 형태가 아니거나 음수·비정수면 0이다
 * (자유 데이터가 회계 숫자를 고르지 못한다 — kernel이 다시 상한으로 clamp한다).
 * cache 관련 필드도 input에 합산한다: 우리가 쓰는 것은 "이 turn이 얼마나 소모했는가"이고
 * cache read/creation도 그 소모의 일부다.
 */
export function readReportedUsage(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return { inputTokens: 0, outputTokens: 0 };
    const o = raw;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    return {
        inputTokens: num(o.input_tokens) + num(o.cache_read_input_tokens) + num(o.cache_creation_input_tokens),
        outputTokens: num(o.output_tokens),
    };
}
function workerError(code, what) {
    return new OrchestrationError(code, `live worker: ${what}`);
}
/**
 * 모델 출력 텍스트에서 **계획 JSON 하나**를 꺼낸다. 모델은 설명을 덧붙이거나 fence로 감싸므로
 * 마지막 균형 잡힌 `{...}` 블록을 찾는다 — **파싱은 여기서 하지 않는다**(검증기가 정본이다).
 *
 * ponytail: JSON 파서를 새로 쓰지 않는다. 중괄호 깊이만 세고 문자열·escape만 건너뛴다(그래야 본문에
 * `}`가 들어 있어도 잘리지 않는다). 후보가 여러 개면 **마지막**을 쓴다(모델이 예시를 먼저 적는 경우).
 */
export function extractPlanJson(text) {
    let best = null;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== "{")
            continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < text.length; j++) {
            const c = text[j];
            if (inStr) {
                if (esc)
                    esc = false;
                else if (c === "\\")
                    esc = true;
                else if (c === '"')
                    inStr = false;
                continue;
            }
            if (c === '"')
                inStr = true;
            else if (c === "{")
                depth += 1;
            else if (c === "}") {
                depth -= 1;
                if (depth === 0) {
                    const candidate = text.slice(i, j + 1);
                    if (candidate.includes('"result"'))
                        best = candidate;
                    i = j;
                    break;
                }
            }
        }
    }
    return best;
}
/**
 * **live worker turn 하나.** 프로세스를 띄우고 계획을 받아 offline backend와 **같은 이벤트 계약**으로
 * 흘린다. 실패는 전부 닫힌 코드이며 성공을 만들어내는 경로가 없다.
 */
export function startLivePlanTurn(launch) {
    const events = [];
    const run = async () => {
        let child;
        try {
            child = spawn(launch.executable, [...LIVE_WORKER_ARGS], {
                env: { ...LIVE_WORKER_ENV },
                stdio: ["pipe", "pipe", "pipe"],
                shell: false,
            });
        }
        catch {
            // `ENOEXEC`처럼 **동기적으로** 던지는 실패도 있다(실행 형식이 아닌 파일). 비동기 `error`
            // 이벤트만 보면 그 경로가 예외로 새어 나가 marker가 엉뚱해진다.
            throw workerError("worker_spawn_failed", "실행 파일을 띄울 수 없다(형식·권한)");
        }
        let out = "";
        let errText = "";
        let overflow = false;
        let killedBy = null;
        const timer = setTimeout(() => {
            killedBy = "deadline";
            child.kill("SIGKILL");
        }, Math.max(1_000, launch.timeoutMs));
        const onAbort = () => {
            killedBy = "cancel";
            child.kill("SIGKILL");
        };
        launch.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (d) => {
            if (out.length + d.length > MAX_WORKER_STDOUT_BYTES) {
                overflow = true;
                child.kill("SIGKILL");
                return;
            }
            out += d;
        });
        child.stderr.setEncoding("utf8");
        // **누적 상한**(리뷰 C3): chunk당 절삭만으로는 deadline까지 무제한으로 자란다.
        child.stderr.on("data", (d) => {
            if (errText.length < 4_000)
                errText += d.slice(0, 4_000 - errText.length);
        });
        const exit = await new Promise((resolve) => {
            child.once("error", (e) => resolve({ code: null, spawnError: e }));
            child.once("close", (code) => resolve({ code, spawnError: null }));
            child.stdin.end(launch.prompt);
        });
        clearTimeout(timer);
        launch.signal?.removeEventListener("abort", onAbort);
        if (exit.spawnError !== null)
            throw workerError("worker_spawn_failed", "실행 파일을 띄울 수 없다");
        if (overflow)
            throw workerError("worker_output_too_large", `stdout이 ${MAX_WORKER_STDOUT_BYTES}바이트를 넘었다`);
        if (killedBy !== null)
            throw workerError("worker_deadline_exceeded", `${killedBy}로 종료했다`);
        if (exit.code !== 0) {
            // stderr 원문을 durable로 옮기지 않는다 — 코드와 짧은 꼬리만 오류 메시지에 남는다.
            throw workerError("worker_exit_nonzero", `종료코드 ${exit.code} ${errText.trim().slice(0, 200)}`);
        }
        // CLI가 `--output-format json`으로 감싼 봉투에서 결과 텍스트와 **사용량**을 꺼낸다.
        // 사용량을 읽는 이유: 이것이 durable 토큰 회계에 들어가고 그 회계가 예산 게이트다. 읽지 못하면
        // **0으로 보고한다** — 그러면 토큰 축은 그 turn에 대해 공허해지고 경과(`budgetDeadlineAt`)만 남는다.
        // 그 사실을 지어내지 않고 그대로 둔다(0을 "적게 썼다"로 읽어서는 안 된다).
        let text = out;
        let reported = { inputTokens: 0, outputTokens: 0 };
        try {
            const envelope = JSON.parse(out);
            if (typeof envelope.result === "string")
                text = envelope.result;
            reported = readReportedUsage(envelope.usage);
        }
        catch {
            /* 봉투가 아니면 원문에서 찾는다 */
        }
        const json = extractPlanJson(text);
        if (json === null)
            throw workerError("worker_plan_absent", "출력에서 계획 JSON을 찾지 못했다");
        let parsed;
        try {
            parsed = JSON.parse(json);
        }
        catch {
            throw workerError("worker_plan_unparsable", "계획 후보가 JSON이 아니다");
        }
        // **binding은 모델이 고르지 못한다**: durable 값으로 덮어쓴 뒤 검증한다(계획이 다른 attempt·다른
        // run을 주장할 통로가 없다). 검증기는 offline backend와 **같은 함수**다.
        // **계약이 소유한 필드는 중앙이 채운다**: binding(run/task/attempt/turn)과 `schemaVersion` 둘 다
        // 모델이 적을 값이 아니다(offline backend의 `encodePlan`도 똑같이 중앙에서 채운다). 모델이 무엇을
        // 적었든 여기서 덮으므로 "다른 attempt·다른 계약 버전"을 주장할 통로가 없다.
        const plan = validateTypedExecutionPlan({ ...parsed, ...launch.binding, schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION }, launch.binding);
        events.push({ kind: "terminal", seq: 3, plan, usage: reported });
    };
    return {
        async *[Symbol.asyncIterator]() {
            yield { kind: "started", seq: 1 };
            // **진행 이벤트가 반드시 1건 이상**이다(offline backend와 같은 계약) — 모델 왕복은 한 덩어리라
            // 단계 이름을 durable 형태(bounded slug)로 낸다. 내용은 담지 않는다.
            yield { kind: "progress", seq: 2, step: "worker_session_started" };
            await run();
            yield { kind: "progress", seq: 3, step: "worker_plan_received" };
            const terminal = events[events.length - 1];
            if (terminal === undefined || terminal.kind !== "terminal") {
                throw workerError("worker_plan_absent", "terminal 이벤트가 만들어지지 않았다");
            }
            yield terminal;
        },
    };
}
/**
 * 계획 계약을 **검증기 상수에서 파생한** 프롬프트 조각. 하드코딩 사본을 만들지 않는다 —
 * 계약이 바뀌면 이 문장이 따라간다(M8 실측: 생산자 프롬프트와 검증기가 갈리면 산출물이 매번 거부된다).
 */
export function planContractPrompt() {
    return [
        "**네 응답 전체가 JSON 객체 하나**여야 한다. 머리말·설명·코드펜스·계획 요약·도구 호출 텍스트를",
        "하나도 붙이지 마라(첫 글자가 `{`이고 마지막 글자가 `}`다).",
        '필수 key: {"operations": [...], "result": {"summary": "...", "outputs": [...]}}.',
        '`requests`는 선택이다(spawn_child · deliver_status · request_decision).',
        '**`schemaVersion`·binding은 적지 마라** — 계약이 소유한 필드이고 중앙이 채운다.',
        `\`result.summary\`는 ${LIMITS.maxSummaryLength}자 이내의 한 줄 요약이다.`,
        // **닫힌 값 집합을 상수에서 파생한다**(M8 실측: 생산자 프롬프트에 값 형식 규칙이 없으면 계약이
        // 매번 산출물을 거부한다 — 검증기와 프롬프트는 단일 출처여야 한다). 첫 live 시도가 `role: "plan"`을
        // 내서 `plan_invalid`였다.
        `\`result.outputs[]\`는 \`{path, role}\`이며 path는 workspace 상대경로, role은 다음 중 하나다: ${ARTIFACT_ROLES.map((r) => `\`${r}\``).join(" · ")}.`,
        "`operations[]`는 **승인된 것만** 가능하다. 지시(`Inputs and Contracts`)에 operation 객체가 적혀 있으면",
        "그것을 **그대로** 넣고, 없으면 `operations`는 빈 배열이다(스스로 만들어 낸 operation은 거부된다).",
        // **소유 경로 규칙**(V3 M10 T3 live 실측 3번째 반복): 첫 성공 turn 2건 뒤 개발 단계가
        // `artifact_not_owned`로 거부됐다 — 계약이 "이 task가 무엇을 발행할 수 있는가"를 말하지 않았기 때문이다.
        // 소유 경로 자체는 문맥(context bundle)의 `ownership`에 이미 있다.
        "`result.outputs[]`의 path는 **이 task의 소유 경로 안**이어야 한다(문맥의 `ownership` 참조).",
        "지시가 요구한 산출물만 적어라 — 소유 밖 경로나 남의 단계 산출물을 적으면 발행이 거부된다.",
        "승인되지 않은 경로·명령·네트워크는 표현할 수 없다(적어도 거부된다).",
    ].join("\n");
}
