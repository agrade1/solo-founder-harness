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
 * - **도구·네트워크** — 인자에서 도구를 끊는다(`--tools ""` · `--strict-mcp-config` ·
 *   `--setting-sources ""` · `--permission-mode plan`). 모델이 파일을 읽거나 쓰지 못하므로 산출물은
 *   **오직 계획 텍스트**이며, 실제 쓰기는 kernel typed-write 채널만 한다.
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
import { LIMITS, OrchestrationError, TYPED_EXECUTION_PLAN_SCHEMA_VERSION } from "./orchestrationTypes.js";
import type { TypedExecutionPlan, WorkerEvent, WorkerStream } from "./autopilotTypes.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";

/** 무인 loop가 아는 **두 번째** backend 이름(닫힌 집합의 나머지 한 값). */
export const LIVE_PLAN_BACKEND = "claude-plan";

/**
 * 모델에게 주는 **도구 없는 plan 모드** 인자. 값이 상수인 이유: 호출자가 인자를 고를 수 있으면
 * 그것이 곧 임의 실행이다(`--eval`·`--settings`·`--add-dir`가 전부 그 통로다).
 */
export const LIVE_WORKER_ARGS: readonly string[] = Object.freeze([
  "-p",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--tools",
  "",
  "--permission-mode",
  "plan",
]);

/** 자식 프로세스에 주는 환경 **전부**. 부모 환경을 상속하지 않는다(secret·proxy·NODE_OPTIONS 차단). */
export const LIVE_WORKER_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  /**
   * **`node`가 PATH에 있어야 한다**(V3 M9 live 실측 함정 중 하나 — nvm 등에서 `/usr/bin`에 node가 없다).
   * 승인된 worker 실행 파일이 `#!/usr/bin/env node` 스크립트면 이 PATH로 해석되므로, **이 컨트롤러를
   * 돌리는 그 node의 디렉터리**를 앞에 둔다. 부모 PATH를 상속하지는 않는다(그것이 임의 프로그램 통로다).
   */
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  /** 세션 자격증명은 사람이 이미 넣어 둔 홈에 있다 — harness는 로그인을 대행하지 않는다. */
  HOME: process.env.HOME ?? "",
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
] as const;

export interface LiveWorkerLaunch {
  /** `kernel.approvedWorkerExecutable()`가 **지금** 검증해 준 값. 이 모듈은 이것을 바꿀 수 없다. */
  executable: string;
  /** 모델에게 줄 프롬프트(bounded). 원문은 durable에 남지 않는다. */
  prompt: string;
  /** durable에서만 나오는 실행 신원 — 계획이 자기 binding을 주장하지 못하게 한다. */
  binding: { runId: string; taskId: string; attemptId: string; turnId: string };
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * CLI가 보고한 사용량을 **bounded 정수 둘**로 접는다. 형태가 아니거나 음수·비정수면 0이다
 * (자유 데이터가 회계 숫자를 고르지 못한다 — kernel이 다시 상한으로 clamp한다).
 * cache 관련 필드도 input에 합산한다: 우리가 쓰는 것은 "이 turn이 얼마나 소모했는가"이고
 * cache read/creation도 그 소모의 일부다.
 */
export function readReportedUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { inputTokens: 0, outputTokens: 0 };
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    inputTokens: num(o.input_tokens) + num(o.cache_read_input_tokens) + num(o.cache_creation_input_tokens),
    outputTokens: num(o.output_tokens),
  };
}

function workerError(code: (typeof LIVE_WORKER_CODES)[number], what: string): OrchestrationError {
  return new OrchestrationError(code, `live worker: ${what}`);
}

/**
 * 모델 출력 텍스트에서 **계획 JSON 하나**를 꺼낸다. 모델은 설명을 덧붙이거나 fence로 감싸므로
 * 마지막 균형 잡힌 `{...}` 블록을 찾는다 — **파싱은 여기서 하지 않는다**(검증기가 정본이다).
 *
 * ponytail: JSON 파서를 새로 쓰지 않는다. 중괄호 깊이만 세고 문자열·escape만 건너뛴다(그래야 본문에
 * `}`가 들어 있어도 잘리지 않는다). 후보가 여러 개면 **마지막**을 쓴다(모델이 예시를 먼저 적는 경우).
 */
export function extractPlanJson(text: string): string | null {
  let best: string | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (candidate.includes('"result"')) best = candidate;
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
export function startLivePlanTurn(launch: LiveWorkerLaunch): WorkerStream {
  const events: WorkerEvent[] = [];
  const run = async (): Promise<void> => {
    let child;
    try {
      child = spawn(launch.executable, [...LIVE_WORKER_ARGS], {
        env: { ...LIVE_WORKER_ENV },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch {
      // `ENOEXEC`처럼 **동기적으로** 던지는 실패도 있다(실행 형식이 아닌 파일). 비동기 `error`
      // 이벤트만 보면 그 경로가 예외로 새어 나가 marker가 엉뚱해진다.
      throw workerError("worker_spawn_failed", "실행 파일을 띄울 수 없다(형식·권한)");
    }
    let out = "";
    let errText = "";
    let overflow = false;
    let killedBy: "deadline" | "cancel" | null = null;
    const timer = setTimeout(() => {
      killedBy = "deadline";
      child.kill("SIGKILL");
    }, Math.max(1_000, launch.timeoutMs));
    const onAbort = (): void => {
      killedBy = "cancel";
      child.kill("SIGKILL");
    };
    launch.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (out.length + d.length > MAX_WORKER_STDOUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out += d;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (errText += d.slice(0, 2000)));

    const exit = await new Promise<{ code: number | null; spawnError: Error | null }>((resolve) => {
      child.once("error", (e) => resolve({ code: null, spawnError: e }));
      child.once("close", (code) => resolve({ code, spawnError: null }));
      child.stdin.end(launch.prompt);
    });
    clearTimeout(timer);
    launch.signal?.removeEventListener("abort", onAbort);

    if (exit.spawnError !== null) throw workerError("worker_spawn_failed", "실행 파일을 띄울 수 없다");
    if (overflow) throw workerError("worker_output_too_large", `stdout이 ${MAX_WORKER_STDOUT_BYTES}바이트를 넘었다`);
    if (killedBy !== null) throw workerError("worker_deadline_exceeded", `${killedBy}로 종료했다`);
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
      const envelope = JSON.parse(out) as { result?: unknown; usage?: unknown };
      if (typeof envelope.result === "string") text = envelope.result;
      reported = readReportedUsage(envelope.usage);
    } catch {
      /* 봉투가 아니면 원문에서 찾는다 */
    }
    const json = extractPlanJson(text);
    if (json === null) throw workerError("worker_plan_absent", "출력에서 계획 JSON을 찾지 못했다");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw workerError("worker_plan_unparsable", "계획 후보가 JSON이 아니다");
    }
    // **binding은 모델이 고르지 못한다**: durable 값으로 덮어쓴 뒤 검증한다(계획이 다른 attempt·다른
    // run을 주장할 통로가 없다). 검증기는 offline backend와 **같은 함수**다.
    // **계약이 소유한 필드는 중앙이 채운다**: binding(run/task/attempt/turn)과 `schemaVersion` 둘 다
    // 모델이 적을 값이 아니다(offline backend의 `encodePlan`도 똑같이 중앙에서 채운다). 모델이 무엇을
    // 적었든 여기서 덮으므로 "다른 attempt·다른 계약 버전"을 주장할 통로가 없다.
    const plan: TypedExecutionPlan = validateTypedExecutionPlan(
      { ...(parsed as Record<string, unknown>), ...launch.binding, schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION },
      launch.binding,
    );
    events.push({ kind: "terminal", seq: 3, plan, usage: reported });
  };

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
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
export function planContractPrompt(): string {
  return [
    "출력은 **JSON 객체 하나**여야 한다. 설명·코드펜스·도구 호출 텍스트를 덧붙이지 마라.",
    '필수 key: {"operations": [...], "result": {"summary": "...", "outputs": [...]}}.',
    '`requests`는 선택이다(spawn_child · deliver_status · request_decision).',
    '**`schemaVersion`·binding은 적지 마라** — 계약이 소유한 필드이고 중앙이 채운다.',
    `\`result.summary\`는 ${LIMITS.maxSummaryLength}자 이내의 한 줄 요약이다.`,
    "`result.outputs[]`는 `{path, role}`이며 path는 workspace 상대경로다.",
    "`operations[]`는 승인된 것만 가능하다: `{operationId, kind, authorityId, ...}`.",
    "승인되지 않은 경로·명령·네트워크는 표현할 수 없다(적어도 거부된다).",
  ].join("\n");
}
