/**
 * V3 M5a — `codex exec` 어댑터 (로드맵 §7.1의 `CodexCliProvider`).
 *
 * 기존 `ExecutionProvider` 계약을 그대로 구현한다 — **두 번째 오케스트레이터·상태 시스템을 만들지 않는다.**
 * 세션 수명 모델은 `ClaudeCliProvider`와 같다(호출당 프로세스 1개, 후속 turn은 resume).
 *
 * 확정 계약:
 * - argv는 **배열로 컴파일**하고 shell을 경유하지 않는다. 프롬프트는 **stdin**으로만 넣는다(`-`).
 * - cwd·model·reasoning effort·sandbox는 **명시**한다. `--ephemeral`·`--json`·(요청 시)`--output-schema`.
 * - **bypass 계열 플래그는 없다**(`--dangerously-bypass-approvals-and-sandbox`·`--full-auto`·
 *   `danger-full-access` sandbox는 컴파일 단계에서 도달 불가).
 * - **strict empty MCP는 ambient 사용자 설정에 의존하지 않는다**: 격리된 `CODEX_HOME`(필수 입력) +
 *   `--config mcp_servers={}`를 함께 쓰고, 자식 env는 `PATH`/`CODEX_HOME`만 담는다(사용자 `HOME` 미상속).
 *   auth 파일·자격증명은 **복사하지도 저장하지도 않는다**. 스트림에서 MCP 호출이 보이면 실패다(파서).
 * - 프로세스를 띄우기 **직전마다** `verifyExecutionBoundary`로 승인 커밋을 대조한다(대장 `B-5`).
 * - fresh 실행과 `codex exec resume <session-id>`만 지원한다. **`--last`는 쓰지 않는다**(자동화에서
 *   "마지막 세션"은 다른 프로세스의 세션일 수 있다).
 *
 * ⚠ 미확정: 이 argv·env·JSONL 필드명은 로컬 `codex exec --help` 실측으로 고정해야 한다. M5a 세션에서는
 * help 실행 승인이 나지 않아 로드맵 §1의 기록된 플래그 목록(`--json`·`--output-schema`·`--ephemeral`·
 * `--sandbox`·`--model`·config override, 버전 `0.146.0-alpha.3`)만 근거로 삼았다. **live 확정은 M5b 게이트다.**
 * 잘못된 플래그는 codex가 비정상 종료하므로 결과는 fail closed다(조용한 성공 경로가 없다).
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { CodexJsonlParser } from "./codexStreamParser.js";
import { verifyExecutionBoundary } from "./executionBoundary.js";
import { OrchestrationError } from "./orchestrationTypes.js";
import type { CodexSessionOptions, ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";

/** 프롬프트 상한(문자). 넘으면 stdin에 쓰지 않고 거부한다. */
export const MAX_PROMPT_CHARS = 262_144;

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const SANDBOXES = ["read-only", "workspace-write"] as const;

/** 리뷰 기본값 — 로드맵 §6 모델 정책·§7.1 실행 계약. */
export const CODEX_REVIEW_DEFAULTS = { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "read-only" } as const;

/** `child_process.spawn` 시그니처의 최소 부분집합 (테스트 주입용 in-process seam). */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcess;

export interface CodexCliProviderOpts {
  /** 승인 manifest(원본). 프로세스 시작 직전마다 다시 검증된다. */
  manifest: unknown;
  /** 판정 계약을 들고 있는 controller checkout 절대경로. */
  controllerRepoRoot: string;
  /** codex 실행 파일. 미지정 시 `HARNESS_CODEX_BIN` → `codex`(PATH). 절대경로를 하드코딩하지 않는다. */
  bin?: string;
  /** 테스트용 spawn seam. production 진입점은 지정하지 않는다(외부 주입 표면 없음). */
  spawn?: SpawnFn;
  /** 만료 판정용 시각(ms) 주입. 미지정 시 `Date.now()`. */
  nowMs?: () => number;
}

function fail(code: string, message: string): never {
  throw new OrchestrationError(code, message);
}

function requireAbsolute(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.includes("\0") || !isAbsolute(v)) {
    fail("codex_config_invalid", `${what}는 NUL 없는 절대경로여야 한다`);
  }
  return v as string;
}

/** spec의 codex 옵션을 fail-closed로 정규화한다. 계약 밖 값은 기본값으로 눙치지 않고 거부한다. */
export function resolveCodexOptions(spec: SessionSpec): Required<Omit<CodexSessionOptions, "outputSchemaPath">> & {
  outputSchemaPath?: string;
  model: string;
} {
  const o = spec.codex;
  if (!o || typeof o !== "object") {
    fail("codex_config_isolation_required", "spec.codex(격리된 codexHome 포함)가 필요하다");
  }
  const model = spec.model ?? CODEX_REVIEW_DEFAULTS.model;
  if (!MODEL_RE.test(model)) fail("codex_config_invalid", "spec.model이 모델 이름 형식이 아니다");

  const reasoningEffort = o.reasoningEffort ?? CODEX_REVIEW_DEFAULTS.reasoningEffort;
  if (!EFFORTS.includes(reasoningEffort)) fail("codex_config_invalid", `reasoningEffort는 ${EFFORTS.join("|")} 중 하나여야 한다`);

  const sandbox = o.sandbox ?? CODEX_REVIEW_DEFAULTS.sandbox;
  if (!SANDBOXES.includes(sandbox)) {
    // danger-full-access 등 bypass 계열은 여기서 끝난다.
    fail("codex_sandbox_forbidden", `sandbox는 ${SANDBOXES.join("|")} 중 하나여야 한다`);
  }

  const codexHome = requireAbsolute(o.codexHome, "spec.codex.codexHome");
  const outputSchemaPath = o.outputSchemaPath === undefined ? undefined : requireAbsolute(o.outputSchemaPath, "spec.codex.outputSchemaPath");
  requireAbsolute(spec.cwd, "spec.cwd");

  return { model, reasoningEffort, sandbox, codexHome, outputSchemaPath, ephemeral: o.ephemeral ?? true };
}

/**
 * argv 컴파일. `resume`가 주어지면 `codex exec resume <session-id>` 형태다(`--last` 없음).
 * 순수 함수 — 테스트가 argv를 정확히 고정한다.
 */
export function compileCodexArgs(spec: SessionSpec, resumeSessionId?: string): string[] {
  const o = resolveCodexOptions(spec);
  const args = ["exec"];
  if (resumeSessionId) args.push("resume", resumeSessionId);
  args.push("--json");
  args.push("--model", o.model);
  args.push("--config", `model_reasoning_effort="${o.reasoningEffort}"`);
  // ambient 사용자 MCP 서버를 명시적으로 비운다(CODEX_HOME 격리와 이중 방어).
  args.push("--config", "mcp_servers={}");
  args.push("--sandbox", o.sandbox);
  args.push("--cd", spec.cwd);
  if (o.ephemeral && !resumeSessionId) args.push("--ephemeral");
  if (o.outputSchemaPath) args.push("--output-schema", o.outputSchemaPath);
  args.push("-"); // 프롬프트는 stdin
  return args;
}

/** 자식 env. 사용자 HOME·토큰·그 밖의 환경을 상속하지 않는다(auth 파일 복사·저장도 없다). */
export function compileCodexEnv(codexHome: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", CODEX_HOME: codexHome };
}

interface CodexState {
  spec: SessionSpec;
  queue: AsyncEventQueue<SessionEvent>;
  child: ChildProcess | null;
  parser: CodexJsonlParser | null;
  codexSessionId: string;
  ephemeral: boolean;
}

export class CodexCliProvider implements ExecutionProvider {
  readonly id = "codex-cli";
  private readonly sessions = new Map<string, CodexState>();
  private readonly bin: string;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly opts: CodexCliProviderOpts) {
    this.bin = opts.bin ?? process.env.HARNESS_CODEX_BIN ?? "codex";
    this.spawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  }

  async start(spec: SessionSpec, initialPrompt: string): Promise<SessionHandle> {
    const o = resolveCodexOptions(spec); // 설정 거부는 spawn 전에 일어난다
    const state: CodexState = { spec, queue: new AsyncEventQueue<SessionEvent>(), child: null, parser: null, codexSessionId: "", ephemeral: o.ephemeral };
    this.sessions.set(spec.sessionId, state);
    await this.invoke(state, undefined, initialPrompt);
    return { sessionId: spec.sessionId, spec };
  }

  /** 후속 지시 = `codex exec resume <관측된 session id>`. 관측 전이거나 ephemeral이면 거부한다. */
  async send(handle: SessionHandle, message: string): Promise<void> {
    const state = this.sessions.get(handle.sessionId);
    if (!state) fail("codex_unknown_session", `없는 세션 ${handle.sessionId}`);
    if (state.ephemeral) {
      fail("codex_resume_unavailable", "ephemeral 세션은 resume할 수 없다(resume이 필요하면 ephemeral:false로 시작한다)");
    }
    if (!state.codexSessionId) {
      fail("codex_resume_unavailable", "codex session id를 관측하지 못했다(--last는 쓰지 않는다)");
    }
    state.queue = new AsyncEventQueue<SessionEvent>(); // 새 invocation = 새 스트림
    await this.invoke(state, state.codexSessionId, message);
  }

  events(handle: SessionHandle): AsyncIterable<SessionEvent> {
    const state = this.sessions.get(handle.sessionId);
    if (!state) fail("codex_unknown_session", `없는 세션 ${handle.sessionId}`);
    return state.queue;
  }

  async stop(handle: SessionHandle, _reason: string): Promise<void> {
    const state = this.sessions.get(handle.sessionId);
    if (!state) return;
    state.child?.kill("SIGTERM");
    state.queue.close();
    this.sessions.delete(handle.sessionId);
  }

  /** 한 invocation. **검증 → 경계 대조 → spawn** 순서이며, 앞의 둘이 실패하면 프로세스는 없다. */
  private async invoke(state: CodexState, resumeSessionId: string | undefined, prompt: string): Promise<void> {
    if (typeof prompt !== "string" || prompt.length === 0) fail("codex_prompt_invalid", "프롬프트가 비어 있다");
    if (prompt.length > MAX_PROMPT_CHARS) fail("codex_prompt_too_long", `프롬프트는 ${MAX_PROMPT_CHARS}자 이하여야 한다`);

    const o = resolveCodexOptions(state.spec);
    const args = compileCodexArgs(state.spec, resumeSessionId);

    // 대장 `B-5`: 승인된 커밋이 controller/실행 checkout HEAD와 정확히 같을 때만 프로세스를 띄운다.
    await verifyExecutionBoundary({
      manifest: this.opts.manifest,
      controllerRepoRoot: this.opts.controllerRepoRoot,
      targetWorktree: state.spec.cwd,
      nowMs: this.opts.nowMs?.(),
    });

    const parser = new CodexJsonlParser({ model: o.model, cwd: state.spec.cwd, sandbox: o.sandbox });
    state.parser = parser;
    const queue = state.queue;
    const child = this.spawnFn(this.bin, args, {
      cwd: state.spec.cwd,
      env: compileCodexEnv(o.codexHome),
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.child = child;

    let stderr = "";
    let settled = false;
    const settle = (exit: Parameters<CodexJsonlParser["finish"]>[0]): void => {
      if (settled) return;
      settled = true;
      for (const e of parser.finish(exit)) queue.push(e);
      queue.close();
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const e of parser.push(chunk)) {
        if (e.kind === "init" && e.sessionId) state.codexSessionId = e.sessionId;
        queue.push(e);
      }
    });
    // stderr는 요약·redaction 후에만 쓰인다(원문은 큐·상태로 나가지 않는다).
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      if (stderr.length < 8_192) stderr += d;
    });

    child.on("error", (err) => settle({ code: null, signal: null, stderr: err.message, spawnError: true }));
    child.on("close", (code, signal) => settle({ code, signal, stderr }));

    child.stdin?.write(prompt);
    child.stdin?.end();
  }
}
