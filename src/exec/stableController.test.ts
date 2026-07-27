/**
 * V3 M5b — StableController 테스트.
 *
 * 실제 Codex/Claude 추론·네트워크·인증은 **없다**. 쓰는 것은 ⓐ 진짜 git checkout(실행 경계가 승인 커밋을
 * 증명해야 하므로) ⓑ in-process **scripted provider**(handle 신원·turn별 스트림·실패 주입) ⓒ 실제
 * `OrchestrationKernel`(SoR)뿐이다. provider 프로세스는 하나도 뜨지 않는다.
 *
 * 2026-07-27 독립 fresh Codex read-only 리뷰(REVISE)의 A1~A5 회귀가 아래 §10~§14에 있다.
 * 실행: `npx tsx --test src/exec/stableController.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "./runProcess.js";
import { OrchestrationKernel, createOrchestrationRun } from "./orchestrationKernel.js";
import { LIMITS, OrchestrationError, REQUIRED_BODY_HEADINGS } from "./orchestrationTypes.js";
import type { AgentMessageType } from "./orchestrationTypes.js";
import { runPaths } from "./orchestrationStore.js";
import {
  CONTROLLER_TERMINAL_CODES,
  ControllerError,
  MAX_TURN_EVENTS,
  StableController,
  compileExecutionPolicy,
  type ControllerHandoff,
  type HandoffContext,
} from "./stableController.js";
import { CodexCliProvider, type SpawnFn } from "./codexCliProvider.js";
import { consumeExactlyOneTerminal } from "./types.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec, SessionUsage } from "./types.js";

const RUN_ID = "m5b-run";
const MILESTONE = "m5b";
const USAGE: SessionUsage = { inputTokens: 3, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

const cleanups: string[] = [];
process.on("exit", () => {
  for (const d of cleanups) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 결과를 바꾸지 않는다 */
    }
  }
});

/** 테스트용 신뢰 git 경로(테스트 안에서만 PATH를 훑는다 — production은 호출자가 경로를 준다). */
function findGit(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      return realpathSync(join(dir, "git"));
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error("테스트용 git 실행 파일을 PATH에서 찾지 못했다");
}
const TRUSTED_GIT = findGit();

/** workspace = 실제 checkout 루트. 승인 커밋 = 그 HEAD. */
async function initRepo(): Promise<{ root: string; head: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5b-ctl-")));
  cleanups.push(dir);
  await runProcess("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return { root: dir, head: (await runProcess("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() };
}

function manifestFor(head: string, taskIds: string[], over: Record<string, unknown> = {}) {
  const ownershipByTask: Record<string, string[]> = {};
  for (const id of taskIds) ownershipByTask[id] = ["src"];
  return {
    milestoneId: MILESTONE,
    approvedCommit: head,
    writableRoots: ["src"],
    ownershipByTask,
    allowedCommands: ["npm test", "npm run build"],
    allowedDependencies: [{ name: "typescript", version: "5.7.2" }],
    allowedNetworkDomains: ["registry.npmjs.org"],
    maxSessions: 2,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2099-12-31T00:00:00.000Z",
    ...over,
  };
}

function body(type: AgentMessageType): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

function seed(taskId: string, roleId: string, over: Record<string, unknown> = {}) {
  return {
    taskId,
    roleId,
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: [`src/${taskId}`],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
    ...over,
  };
}

/** 결정론적 clock(ms) — 호출마다 1초 전진. */
function msClock(startMs = Date.UTC(2026, 6, 27, 0, 0, 0)): () => number {
  let n = 0;
  return () => startMs + 1000 * n++;
}

/**
 * **비동기 경계 창 seam**(A4 회귀용). `arm()` 이후 `fireFrom`번째 clock 호출부터 `effect()`를 돌린다.
 * production 코드에 seam을 넣지 않기 위해 **시각 권위**를 seam으로 쓴다(봉인 신원은 그대로 유지된다 —
 * 같은 함수 참조이므로 드리프트가 아니다).
 *
 * clock 호출 순서(arm 이후): ① `verifyExecutionBoundary` 진입 만료 검사 → **여기서부터 git 비동기 조회** →
 * ② controller 동기 게이트의 만료·예산 검사 → ③ `revalidateSync()`의 만료 재확인 → 그 다음이
 * 포인터 재검증이다. 따라서 `fireFrom: 2`는 **경계 await가 끝난 뒤 · 포인터 재검증 직전**이다.
 */
function armedClock(effect: () => void, fireFrom: number): { clock: () => number; arm: () => void } {
  const base = msClock();
  let armed = false;
  let n = 0;
  return {
    arm: () => {
      armed = true;
      n = 0;
    },
    clock: () => {
      if (armed && ++n >= fireFrom) effect();
      return base();
    },
  };
}

// ── 실제 CodexCliProvider + 주입 spawn seam ────────────────────────────────
//
// **2026-07-28 2차 리뷰 A2 이후**: controller는 "brand를 스스로 단 아무 객체"가 아니라 **실제로 생성된
// read-only Codex provider**만 받는다. 그래서 이 파일의 provider는 더 이상 흉내가 아니라 **진짜
// `CodexCliProvider`** 이고, 결정론은 그 provider가 이미 가진 **주입 spawn seam**으로 만든다
// (live Codex/Claude·네트워크·인증 0 — 자식 프로세스도 뜨지 않는다: `FakeChild`는 in-process다).

/** 신뢰 조건을 만족하는 실행 파일(현재 node). codex를 실제로 띄우지 않으므로 내용은 무관하다. */
const TRUSTED_BIN = realpathSync(process.execPath);
/** 결정론적 codex thread id — 파서가 정규 UUID를 요구한다. */
const CODEX_TID = "0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";

/** `CODEX_HOME` → harness 세션 id. 자식 env가 유일한 상관 관계 표면이다(provider를 감싸지 않는다). */
const HOME_TO_SESSION = new Map<string, string>();

interface TurnRecord {
  kind: "start" | "send";
  sessionId: string;
  text: string;
  cwd: string;
  /** 자식이 실제로 받은 argv — provider가 **봉인 spec**으로 컴파일한 결과다. */
  args: string[];
}

/** 한 invocation이 낼 codex JSONL + stderr + 프로세스 exit code. */
interface TurnOutput {
  lines: string[];
  exit?: number;
  stderr?: string;
}
type TurnScript = (turn: number) => TurnOutput;

/** codexCliProvider 테스트와 같은 in-process 자식. 실제 프로세스는 뜨지 않는다. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  private done = false;
  kill(signal: string): boolean {
    setImmediate(() => this.close(null, signal));
    return true;
  }
  close(code: number | null, signal: string | null = null): void {
    if (this.done) return;
    this.done = true;
    this.emit("close", code, signal);
  }
  finish(lines: string[], code: number | null, stderr = ""): void {
    for (const l of lines) this.stdout.write(`${l}\n`);
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.close(code, null));
  }
}

/**
 * provider가 세션을 닫으면 내부 세션 map에서 **지운다** — 정리 사유는 밖으로 나오지 않으므로
 * 그 삭제가 "세션을 닫았는가"의 유일한 관측 표면이다. provider **객체**는 건드리지 않는다
 * (감싸거나 메서드를 바꾸면 A2 증명을 통과하지 못한다 — 그것이 요점이다).
 */
class ObservedSessions<K, V> extends Map<K, V> {
  readonly closed: K[] = [];
  override delete(key: K): boolean {
    const had = super.delete(key);
    if (had) this.closed.push(key);
    return had;
  }
}

/**
 * 진짜 `CodexCliProvider` + 스크립트된 spawn. 관측은 **자식이 받은 것**(argv·cwd·env·stdin)으로만 한다 —
 * provider를 wrapper·subclass·override로 감싸면 A2 증명을 통과하지 못하고, 그것이 요점이다.
 */
class CodexHarness {
  readonly turns: TurnRecord[] = [];
  readonly codex: CodexCliProvider;
  private turnNo = 0;

  constructor(
    private readonly script: TurnScript,
    opts: { manifest: unknown; controllerRepoRoot: string },
  ) {
    const spawn: SpawnFn = (_command, args, options) => {
      const rec: TurnRecord = {
        // resume subcommand가 붙은 invocation만 후속 `send`다(fresh는 `--ephemeral` 또는 그냥 `exec`).
        kind: args.includes("resume") ? "send" : "start",
        sessionId: HOME_TO_SESSION.get(options.env.CODEX_HOME ?? "") ?? "(미상 세션)",
        text: "",
        cwd: options.cwd,
        args,
      };
      this.turns.push(rec);
      const child = new FakeChild();
      child.stdin.on("data", (d: Buffer | string) => (rec.text += String(d)));
      const out = this.script(this.turnNo++);
      setImmediate(() => child.finish(out.lines, out.exit ?? 0, out.stderr ?? ""));
      return child as unknown as ChildProcess;
    };
    this.codex = new CodexCliProvider({
      manifest: opts.manifest,
      controllerRepoRoot: opts.controllerRepoRoot,
      executablePath: TRUSTED_BIN,
      gitExecutablePath: TRUSTED_GIT,
      spawn,
    });
    (this.codex as unknown as { sessions: Map<string, unknown> }).sessions = this.sessions;
  }

  private readonly sessions = new ObservedSessions<string, unknown>();

  /** provider가 닫은(= 세션 map에서 지운) harness 세션 id. */
  get stops(): string[] {
    return this.sessions.closed;
  }
}

/** 성공 turn: thread 시작 → agent 메시지 → usage를 담은 정상 종료. */
function okTurn(text = "완료", usage: SessionUsage = USAGE): TurnOutput {
  return {
    lines: [
      `{"type":"thread.started","thread_id":"${CODEX_TID}"}`,
      `{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":${JSON.stringify(text)}}}`,
      `{"type":"turn.completed","usage":{"input_tokens":${usage.inputTokens},"output_tokens":${usage.outputTokens}}}`,
    ],
  };
}

/** 실패 turn(usage 0) — codex가 turn 자체를 실패로 닫은 경우. */
function errTurn(reason: string): TurnOutput {
  return {
    lines: [`{"type":"thread.started","thread_id":"${CODEX_TID}"}`, `{"type":"turn.failed","error":{"message":${JSON.stringify(reason)}}}`],
  };
}

/**
 * **usage를 태우고 실패로 끝난 turn**(2차 리뷰 A3 회귀용). turn은 usage와 함께 완료 이벤트를 냈지만
 * 프로세스가 비정상 종료했다 → `isError` 종료 + 0이 아닌 usage. 실제로 일어나는 조합이다.
 */
function failedTurnWithUsage(usage: SessionUsage = USAGE): TurnOutput {
  return { lines: okTurn("실패 전 출력", usage).lines, exit: 3 };
}

/**
 * read-only spec 기본형 — `permissionMode: "plan"`은 이 bridge의 **필수** 값이다.
 * 실제 provider가 요구하는 격리 `codexHome`(빈 0700 디렉터리)을 세션마다 새로 만들고, 그 홈으로
 * 자식 invocation을 harness 세션 id에 되짚는다. `ephemeral: false`여야 전달 turn(resume)이 가능하다.
 */
function readOnlySpec(sessionId: string, role: string, cwd: string, over: Partial<SessionSpec> = {}): SessionSpec {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "m5b-home-")));
  cleanups.push(home);
  HOME_TO_SESSION.set(home, sessionId);
  return { sessionId, role, cwd, permissionMode: "plan", codex: { codexHome: home, ephemeral: false }, ...over };
}

// ── 픽스처: root task 2개(자원 class 공유) + 의존 reviewer ────────────────────

interface Fixture {
  repo: { root: string; head: string };
  kernel: OrchestrationKernel;
  provider: CodexHarness;
  controller: StableController;
  handoffs: HandoffContext[];
}

interface FixtureOpts {
  script?: TurnScript;
  manifest?: Record<string, unknown>;
  /** handoff factory. 두 번째 인자로 checkout 루트(= workspace root)를 받는다. */
  handoff?: (ctx: HandoffContext, root: string) => ControllerHandoff;
  nowMs?: () => number;
  taskIds?: string[];
  /** 두 root task가 같은 배타 자원 class를 요구하는가. */
  shareResource?: boolean;
  /** spawn seam을 갈아끼워 provider `start` 실패를 주입할 때만 쓴다. */
  spawn?: SpawnFn;
}

async function fixture(opts: FixtureOpts = {}): Promise<Fixture> {
  const repo = await initRepo();
  const taskIds = opts.taskIds ?? ["task-a", "task-b"];
  const manifest = manifestFor(repo.head, taskIds, opts.manifest);
  const kernel = createOrchestrationRun({
    workspaceRoot: repo.root,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest,
    clock: (() => {
      let n = 0;
      return () => new Date(Date.UTC(2026, 6, 27, 0, 0, n++));
    })(),
  });
  for (const id of taskIds) {
    kernel.createRootTask(seed(id, "dev-lead", opts.shareResource ? { resourceClasses: ["global-tmp"] } : {}));
  }
  const provider = new CodexHarness(opts.script ?? (() => okTurn()), { manifest, controllerRepoRoot: repo.root });
  if (opts.spawn) (provider.codex as unknown as { spawnFn: SpawnFn }).spawnFn = opts.spawn;
  const handoffs: HandoffContext[] = [];
  const controller = new StableController({
    kernel,
    provider: provider.codex,
    controllerRepoRoot: repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: opts.nowMs ?? msClock(),
    handoff: (ctx) => {
      handoffs.push(ctx);
      return opts.handoff
        ? opts.handoff(ctx, repo.root)
        : {
            spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, repo.root),
            prompt: `# ${ctx.task.title}\n${ctx.inputs.map((i) => `- ${i.path}@${i.revision}`).join("\n")}`,
          };
    },
  });
  return { repo, kernel, provider, controller, handoffs };
}

/** durable 산출물 전부(state·events·messages·snapshot)를 한 문자열로. sentinel 부재 단정용. */
function durableText(root: string): string {
  const paths = runPaths(root, RUN_ID);
  const parts = [readFileSync(paths.stateFile, "utf8"), readFileSync(paths.eventsFile, "utf8"), readFileSync(paths.snapshotFile, "utf8")];
  for (const f of readdirSync(paths.messagesDir)) parts.push(readFileSync(join(paths.messagesDir, f), "utf8"));
  return parts.join("\n");
}

function writeArtifact(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// ── 1. 정상 전진: kernel이 유일한 scheduler다 ─────────────────────────────────

test("[M5b] advanceOnce: kernel batch 순서대로 provider handoff → result 수락", async () => {
  const f = await fixture();
  const out = await f.controller.advanceOnce();
  assert.equal(out.blocked, null);
  assert.deepEqual(out.started, ["task-a", "task-b"], "kernel의 taskId 오름차순 결정을 따라야 한다");
  assert.deepEqual(
    out.tasks.map((t) => [t.taskId, t.status, t.marker]),
    [
      ["task-a", "completed", "result_accepted"],
      ["task-b", "completed", "result_accepted"],
    ],
  );
  assert.deepEqual(f.provider.turns.map((t) => t.kind), ["start", "start"]);
  assert.equal(f.kernel.getTask("task-a")!.state, "completed");
  assert.equal(f.kernel.getTask("task-b")!.state, "completed");
  assert.equal(f.provider.stops.length, 2, "세션을 닫지 않았다");
  assert.equal(f.controller.usedTokens(), 10, "bounded usage 카운터(2 turn × 5)");
  // 다음 advance는 할 일이 없다(두 번째 배치를 임의로 만들지 않는다).
  assert.deepEqual(await f.controller.advanceOnce(), { blocked: null, started: [], tasks: [] });
});

test("[M5b] 배타 자원·maxSessions는 kernel 결정 그대로다 — 스케줄되지 않은 task를 시작하지 않는다", async () => {
  const f = await fixture({ shareResource: true });
  const first = await f.controller.advanceOnce();
  assert.deepEqual(first.started, ["task-a"], "같은 자원 class 둘을 동시에 시작했다");
  assert.equal(f.kernel.getTask("task-b")!.state, "ready", "controller가 스케줄 밖 task를 건드렸다");
  const second = await f.controller.advanceOnce();
  assert.deepEqual(second.started, ["task-b"], "holder 완료 후에야 다음 task가 시작된다");
});

test("[M5b] maxSessions=1이면 batch도 1이다(승인 범위를 controller가 넓히지 않는다)", async () => {
  const f = await fixture({ manifest: { maxSessions: 1 } });
  const out = await f.controller.advanceOnce();
  assert.deepEqual(out.started, ["task-a"]);
});

// ── 2. C-25: turn마다 events()를 다시 부른다 ────────────────────────────────

test("[M5b] C-25: 다중 turn(전달 소비)에서 turn마다 events()를 다시 구독한다", async () => {
  // turn 0 = start, turn 1 = 전달 소비 send(= 두 번째 invocation). provider는 실제 provider처럼
  // invocation마다 큐를 **교체**하므로, 예전 iterable을 재사용하면 두 번째 결과를 영원히 얻지 못한다.
  const g = await fixtureWithDelivery();
  const out = await g.controller.advanceOnce();
  assert.equal(out.blocked, null);
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.status, "completed", `전달 소비 turn이 실패했다(${worker.marker})`);
  assert.deepEqual(worker.acknowledged, ["su-1"], "전달을 수령하지 않았다");
  assert.equal(worker.turns, 2, "두 번째 turn의 결과를 얻지 못했다(예전 iterable 재사용)");
  assert.deepEqual(g.provider.turns.map((t) => t.kind), ["start", "send"]);
  // 진짜 provider는 invocation마다 큐를 **교체**한다: 예전 iterable을 재사용하면 두 번째 turn의 스트림은
  // 이미 닫힌 큐라 종료 결과가 0건이 되고(`provider_no_result`) 아래 두 단정이 함께 깨진다.
  assert.equal(worker.usage.inputTokens, 6, "두 turn의 usage가 합산되지 않았다");
  assert.deepEqual(g.provider.stops, ["sess-worker"], "세션을 닫지 않았다");
});

/** producer(완료) → worker(의존) 배치: worker inbox에 중앙 경유 전달 1건이 대기한다. */
async function fixtureWithDelivery(over: FixtureOpts = {}): Promise<Fixture> {
  const repo = await initRepo();
  const deliveryManifest = manifestFor(repo.head, ["producer", "worker"], over.manifest);
  const kernel = createOrchestrationRun({
    workspaceRoot: repo.root,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: deliveryManifest,
    clock: (() => {
      let n = 0;
      return () => new Date(Date.UTC(2026, 6, 27, 0, 0, n++));
    })(),
  });
  kernel.createRootTask(seed("producer", "research"));
  kernel.createDependentTask({ ...seed("worker", "dev-lead"), dependsOn: ["producer"] });
  kernel.startTask("producer");
  writeArtifact(repo.root, "src/producer/out.md", "# 산출물\n근거 한 줄\n");
  const pointer = kernel.registerArtifact({ taskId: "producer", path: "src/producer/out.md", role: "output" });
  // producer → worker 전달(중앙이 의존 관계를 확인한다).
  kernel.submitStatusUpdate({
    envelope: {
      schemaVersion: "1",
      messageId: "su-1",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "producer",
      parentTaskId: null,
      sender: "research",
      recipient: "orchestrator",
      type: "status_update",
      createdAt: "2026-07-27T00:00:00.000Z",
      dependsOn: [],
      artifactRefs: [pointer],
      supersedes: null,
    },
    body: body("status_update"),
    summary: "producer 중간 산출물",
    deliverTo: "worker",
  });
  kernel.submitResult({
    envelope: {
      schemaVersion: "1",
      messageId: "res-producer",
      runId: RUN_ID,
      milestoneId: MILESTONE,
      taskId: "producer",
      parentTaskId: null,
      sender: "research",
      recipient: "orchestrator",
      type: "result",
      createdAt: "2026-07-27T00:00:01.000Z",
      dependsOn: [],
      artifactRefs: [pointer],
      supersedes: null,
    },
    body: body("result"),
    summary: "producer 완료",
  });
  const provider = new CodexHarness(over.script ?? ((t) => okTurn(t === 0 ? "첫 turn" : "두 번째 turn")), {
    manifest: deliveryManifest,
    controllerRepoRoot: repo.root,
  });
  const handoffs: HandoffContext[] = [];
  const controller = new StableController({
    kernel,
    provider: provider.codex,
    controllerRepoRoot: repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: over.nowMs ?? msClock(),
    handoff: (ctx) => {
      handoffs.push(ctx);
      return over.handoff
        ? over.handoff(ctx, repo.root)
        : {
            spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, repo.root),
            prompt: `# ${ctx.task.title}`,
          };
    },
  });
  return { repo, kernel, provider, controller, handoffs };
}

// ── 3. 전달 수령 순서: provider가 안전히 받은 뒤에만 ack ──────────────────────

test("[M5b] ack는 전달 turn이 성공한 뒤에만 — 실패하면 수령 0", async () => {
  const g = await fixtureWithDelivery({ script: (t) => (t === 0 ? okTurn() : errTurn("turn_failed")) });
  const before = g.kernel.getState().revision;
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.status, "failed");
  assert.equal(worker.marker, "provider_result_error");
  assert.deepEqual(worker.acknowledged, []);
  assert.deepEqual(
    g.kernel.listPendingInbox("worker").map((m) => m.messageId),
    ["su-1"],
    "실패한 전달이 수령 처리됐다",
  );
  assert.equal(g.kernel.getMessage("su-1")!.acknowledgedAt, null);
  assert.equal(g.kernel.getTask("worker")!.state, "running", "실패한 task를 완료로 만들었다");
  assert.ok(g.kernel.getState().revision > before, "batch 시작 커밋은 있어야 한다");
});

test("[M5b] 전달 프롬프트는 bounded summary와 검증된 포인터만 옮긴다(body 전문 없음)", async () => {
  const g = await fixtureWithDelivery();
  await g.controller.advanceOnce();
  const send = g.provider.turns.find((t) => t.kind === "send")!;
  assert.ok(send.text.includes("su-1"));
  assert.ok(send.text.includes("producer 중간 산출물"), "bounded summary가 전달되지 않았다");
  assert.ok(send.text.includes("src/producer/out.md@1"), "검증된 포인터가 전달되지 않았다");
  assert.ok(!send.text.includes("## Progress Since Last Update"), "메시지 body 전문이 프롬프트에 실렸다");
  assert.ok(!send.text.includes("근거 한 줄"), "artifact 본문이 프롬프트에 실렸다");
});

// ── 4. artifact 재검증 ──────────────────────────────────────────────────────

test("[M5b] provider에게 넘기기 직전 포인터를 다시 검증한다(변조 → 시작 0)", async () => {
  const g = await fixtureWithDelivery();
  // worker의 입력(producer 산출물)을 시작 직전에 바꾼다 → hash 불일치.
  writeArtifact(g.repo.root, "src/producer/out.md", "# 바뀐 산출물\n");
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.marker, "artifact_hash_mismatch");
  assert.equal(worker.turns, 0, "포인터가 어긋났는데 provider를 시작했다");
  assert.equal(g.provider.turns.length, 0);
});

test("[M5b] 산출물은 등록·durable 경로에서 검증된 포인터로만 들어간다", async () => {
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => ({
      spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, root),
      prompt: "구현",
      outputs: [{ path: "src/task-a/out.md", role: "output" }],
    }),
  });
  writeArtifact(f.repo.root, "src/task-a/out.md", "# 산출물\n");
  const out = await f.controller.advanceOnce();
  const a = out.tasks[0];
  assert.equal(a.status, "completed", a.marker);
  assert.deepEqual(a.artifacts, ["src/task-a/out.md@1"]);
  assert.deepEqual(
    f.kernel.getTask("task-a")!.artifactRefs.map((r) => `${r.path}@${r.revision}`),
    ["src/task-a/out.md@1"],
  );

  // 산출물이 없으면 등록 자체가 fail closed이고 task는 완료되지 않는다.
  const g = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => ({
      spec: readOnlySpec("s", ctx.task.roleId, root),
      prompt: "구현",
      outputs: [{ path: "src/task-a/missing.md", role: "output" }],
    }),
  });
  const bad = (await g.controller.advanceOnce()).tasks[0];
  assert.equal(bad.marker, "artifact_missing");
  assert.equal(g.kernel.getTask("task-a")!.state, "running", "등록 실패인데 완료로 만들었다");
  assert.equal(g.kernel.getMessage("res.task-a"), null, "실패했는데 result 메시지가 남았다");
});

// ── 5. 정책 선언 검증기(M5c용 순수 함수) ────────────────────────────────────
//
// `compileExecutionPolicy`는 **선언 검증기**이고 M5b bridge의 실행 게이트가 아니다(A2). 그래도
// 이 판정 자체는 M5c가 그대로 쓸 계약이므로 회귀를 유지한다.

test("[M5b] 선언 검증기는 deny-by-default이고 hard deny가 manifest보다 강하다", async () => {
  const f = await fixture({ taskIds: ["task-a"] });
  const manifest = f.kernel.getManifest();
  const task = f.kernel.getTask("task-a")!;
  const code = (req: Parameters<typeof compileExecutionPolicy>[2]): string => {
    try {
      compileExecutionPolicy(manifest, task, req);
      return "(통과)";
    } catch (e) {
      assert.ok(e instanceof OrchestrationError);
      return e.code;
    }
  };

  // 승인 범위 안은 통과한다.
  assert.equal(code({ commands: ["npm test"], dependencies: [{ name: "typescript", version: "5.7.2" }] }), "(통과)");
  assert.equal(code({ networkDomains: ["registry.npmjs.org"], writePaths: ["src/task-a/x.ts"] }), "(통과)");
  // 승인 밖은 전부 거부.
  assert.equal(code({ commands: ["npm run deploy"] }), "policy_command_denied");
  assert.equal(code({ commands: ["npm  test"] }), "policy_command_denied", "정규화 밖 문자열을 받아들였다");
  assert.equal(code({ dependencies: [{ name: "typescript", version: "5.7.3" }] }), "policy_dependency_denied");
  assert.equal(code({ dependencies: [{ name: "typescript", version: "latest" }] }), "policy_dependency_denied");
  assert.equal(code({ networkDomains: ["evil.registry.npmjs.org"] }), "policy_domain_denied", "하위 도메인을 자동 허용했다");
  assert.equal(code({ writePaths: ["src/other/x.ts"] }), "policy_write_denied", "소유 경로 밖 쓰기를 허용했다");
  assert.equal(code({ writePaths: ["../escape.ts"] }), "path_parent_segment");
  assert.equal(code({ localMerge: true }), "policy_merge_denied");
  assert.equal(code({ mcpPackages: ["@scope/mcp@latest"] }), "policy_hard_denied", "MCP @latest를 허용했다");
  assert.equal(code({ mcpPackages: ["typescript@5.7.2"] }), "(통과)");
  assert.equal(code({ mcpPackages: ["typescript@5.7.3"] }), "policy_dependency_denied");
  for (const intent of ["production_deploy", "live_billing", "remote_repo_write", "pr_merge", "mcp_latest"]) {
    assert.equal(code({ intents: [intent] }), "policy_hard_denied", intent);
  }
});

test("[M5b] 승인 목록에 들어온 hard deny 명령도 선언 검증기가 거부한다(manifest가 덮지 못한다)", async () => {
  const denied = ["git push origin main", "gh pr merge 12", "npm publish", "vercel --prod", "stripe charges create"];
  const f = await fixture({ taskIds: ["task-a"], manifest: { allowedCommands: denied } });
  const manifest = f.kernel.getManifest();
  const task = f.kernel.getTask("task-a")!;
  for (const c of denied) {
    assert.equal(manifest.allowedCommands.includes(c), true, `${c}가 승인 목록에 있어야 하는 전제`);
    assert.throws(() => compileExecutionPolicy(manifest, task, { commands: [c] }), (e: unknown) => {
      assert.ok(e instanceof OrchestrationError);
      assert.equal(e.code, "policy_hard_denied", c);
      return true;
    });
  }
  // **정직한 한계**: 이 화면은 wrapper를 잡지 못한다 — 그래서 bridge는 명령 자체를 허용하지 않는다.
  assert.doesNotThrow(() =>
    compileExecutionPolicy(manifestFor(f.repo.head, ["task-a"], { allowedCommands: ["bin/git push origin main"] }) as never, task, {
      commands: ["bin/git push origin main"],
    }),
  );
});

// ── 6. 봉인된 신원·예산 ─────────────────────────────────────────────────────

test("[M5b] 승인·controller 신원 드리프트는 kernel·provider를 건드리지 않고 차단한다", async () => {
  const f = await fixture();
  const mutable = f.controller as unknown as { opts: { controllerRepoRoot: string; gitExecutablePath: string } };
  const revBefore = f.kernel.getState().revision;
  const origRoot = mutable.opts.controllerRepoRoot;
  mutable.opts.controllerRepoRoot = "/tmp";
  assert.deepEqual(await f.controller.advanceOnce(), { blocked: "controller_binding_drift", started: [], tasks: [] });
  mutable.opts.controllerRepoRoot = origRoot;
  const origGit = mutable.opts.gitExecutablePath;
  mutable.opts.gitExecutablePath = "/usr/bin/env";
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift");
  mutable.opts.gitExecutablePath = origGit;
  assert.equal(f.kernel.getState().revision, revBefore, "차단이 state를 바꿨다");
  assert.equal(f.provider.turns.length, 0);
  // 되돌리면 정상 진행한다.
  assert.equal((await f.controller.advanceOnce()).blocked, null);
});

test("[M5b] 만료·경과·토큰 예산 소진은 bounded blocked marker로 fail closed", async () => {
  // kernel은 아직 만료 전(task 생성 가능)이고 controller의 시각 권위는 만료 이후다.
  const expired = await fixture({
    manifest: { expiresAt: "2026-07-27T00:00:05.000Z" },
    nowMs: msClock(Date.UTC(2026, 6, 27, 0, 0, 10)),
  });
  assert.equal((await expired.controller.advanceOnce()).blocked, "manifest_expired");
  assert.equal(expired.provider.turns.length, 0);

  const elapsed = await fixture({ manifest: { maxElapsedMs: 1 }, nowMs: msClock() });
  assert.equal((await elapsed.controller.advanceOnce()).blocked, "budget_elapsed_exhausted");

  // 첫 turn(5토큰)에서 상한(3)을 넘으면 그 task는 실패이고 다음 advance는 차단된다.
  const tokens = await fixture({ manifest: { maxTokens: 3 } });
  const out = await tokens.controller.advanceOnce();
  assert.equal(out.tasks[0].marker, "budget_tokens_exhausted");
  assert.equal(tokens.kernel.getTask("task-a")!.state, "running", "예산 초과인데 완료로 만들었다");
  assert.equal((await tokens.controller.advanceOnce()).blocked, "budget_tokens_exhausted");
});

test("[M5b] 승인되지 않은 커밋·경로에서는 provider가 뜨지 않는다(B-5 재사용)", async () => {
  const f = await fixture({ manifest: { approvedCommit: "b".repeat(40) } });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].marker, "approved_commit_mismatch");
  assert.equal(f.provider.turns.length, 0);

  // cwd가 checkout 루트가 아니면(하위 디렉터리) 거부다.
  const g = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      return { spec: readOnlySpec("s", ctx.task.roleId, join(root, "src")), prompt: "p" };
    },
  });
  const bad = (await g.controller.advanceOnce()).tasks[0];
  assert.equal(bad.marker, "boundary_not_checkout_root");
  assert.equal(g.provider.turns.length, 0);
});

// ── 7. provider 실패·낡은 핸들 ──────────────────────────────────────────────

test("[M5b] provider가 준 핸들 객체를 그대로 들고 다닌다(직렬화·재구성 없음)", async () => {
  // 진짜 `CodexCliProvider`가 핸들 신원을 **불투명 `providerBinding` 참조 동일성**으로 집행한다:
  // controller가 핸들을 직렬화·재구성해 넘기면 send·events·stop이 `codex_stale_handle`로 닫히고
  // (경계 밖 오류이므로 `provider_send_failed`로 접힌다) 두 번째 turn·수령이 사라진다.
  const g = await fixtureWithDelivery();
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.status, "completed", `핸들이 재구성되면 여기서 실패한다(${worker.marker})`);
  assert.equal(worker.turns, 2, "재구성된 핸들로는 두 번째 invocation을 얻지 못한다");
  assert.deepEqual(worker.acknowledged, ["su-1"]);
  assert.deepEqual(g.provider.turns.map((t) => [t.kind, t.sessionId]), [
    ["start", "sess-worker"],
    ["send", "sess-worker"],
  ]);
});

test("[M5b] provider 오류·결과 없음은 완료를 만들지 않는다", async () => {
  // codex가 종료 이벤트를 하나도 내지 않고 끝나면 파서가 `no_terminal_event` 실패 종료로 닫는다.
  const noResult = await fixture({ taskIds: ["task-a"], script: () => ({ lines: [] }) });
  assert.equal((await noResult.controller.advanceOnce()).tasks[0].marker, "provider_result_error");
  assert.equal(noResult.kernel.getTask("task-a")!.state, "running");

  // spawn 실패: seam이 동기로 던지면 provider는 `codex_spawn_failed`를 올리고 controller는 그것을
  // **자기 taxonomy**로 접는다(A5b — provider가 결과 코드를 고르지 못한다).
  const thrown = await fixture({
    taskIds: ["task-a"],
    spawn: () => {
      throw new Error("spawn 실패");
    },
  });
  assert.equal((await thrown.controller.advanceOnce()).tasks[0].marker, "provider_start_failed");
  assert.equal(thrown.kernel.getTask("task-a")!.state, "running");
});

// ── 8. durable 순수성 ──────────────────────────────────────────────────────

test("[M5b] durable 산출물에 프롬프트·transcript·stderr·argv·secret이 남지 않는다", async () => {
  const SENTINELS = {
    prompt: "SENTINEL-PROMPT-3f1a",
    reasoning: "SENTINEL-REASONING-9c2b",
    stderr: "SENTINEL-STDERR-71de",
    secret: "SENTINEL-SECRET-VALUE-a44c",
    argv: "SENTINEL-ARGV-b902",
  };
  const f = await fixture({
    taskIds: ["task-a"],
    // codex JSONL 그대로: 추론 항목 · agent 메시지 · 최종 종료 텍스트에 sentinel을 싣고 stderr도 오염시킨다.
    script: () => ({
      lines: [
        `{"type":"thread.started","thread_id":"${CODEX_TID}"}`,
        `{"type":"item.completed","item":{"id":"r","item_type":"reasoning","text":${JSON.stringify(`추론 원문 ${SENTINELS.reasoning}`)}}}`,
        `{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":${JSON.stringify(
          `최종 메시지 ${SENTINELS.reasoning} ${SENTINELS.secret}`,
        )}}}`,
        `{"type":"turn.completed","usage":{"input_tokens":${USAGE.inputTokens},"output_tokens":${USAGE.outputTokens}}}`,
      ],
      stderr: `codex: ${SENTINELS.stderr}`,
    }),
    handoff: (ctx, root) => ({
      // `model`은 실제로 자식 argv에 실린다(`--model`) — argv sentinel의 진짜 경로다.
      spec: readOnlySpec("s", ctx.task.roleId, root, { model: SENTINELS.argv }),
      prompt: `# 지시\n${SENTINELS.prompt}`,
      outputs: [{ path: "src/task-a/out.md", role: "output" }],
    }),
  });
  writeArtifact(f.repo.root, "src/task-a/out.md", `# 산출물\n${SENTINELS.reasoning}\n`);
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);

  const durable = durableText(f.repo.root);
  for (const [what, s] of Object.entries(SENTINELS)) {
    assert.ok(!durable.includes(s), `durable state에 ${what} sentinel이 남았다`);
  }
  assert.ok(!durable.includes("providerBinding"), "durable state에 SessionHandle이 새어나갔다");
  // 남아 있어야 하는 것: bounded summary · 안정 marker · 검증된 포인터.
  assert.ok(durable.includes("turns=1"), "bounded summary가 없다");
  assert.ok(durable.includes("src/task-a/out.md@1"), "검증된 포인터가 없다");
  const summary = f.kernel.getTask("task-a")!.resultSummary!;
  assert.ok(summary.length <= LIMITS.maxSummaryLength);
});

test("[M5b] 토큰 usage 카운터는 durable state에 남지 않는다(반환값 전용)", async () => {
  // 문서는 "usage는 return-only"라고 적었는데 이전 판의 `## Tests and Evidence`가 durable body에
  // 실제 카운트를 적고 있었다(독립 리뷰 C). 구별 가능한 값으로 부재를 단정한다.
  const loud: SessionUsage = { inputTokens: 987654, outputTokens: 123457, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  const f = await fixture({
    taskIds: ["task-a"],
    manifest: { maxTokens: null },
    script: () => okTurn("완료", loud),
    handoff: (ctx, root) => ({ spec: readOnlySpec("s", ctx.task.roleId, root), prompt: "p" }),
  });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  // 반환값에는 그대로 있다.
  assert.deepEqual(out.tasks[0].usage, { inputTokens: 987654, outputTokens: 123457 });
  assert.equal(f.controller.usedTokens(), 1_111_111);

  const durable = durableText(f.repo.root);
  assert.ok(!durable.includes("987654"), "durable state에 inputTokens가 남았다");
  assert.ok(!durable.includes("123457"), "durable state에 outputTokens가 남았다");
  assert.ok(!/usage/i.test(durable), "durable state에 usage 서술이 남았다");
});

// ── 9. 다른 writer의 durable 결과를 덮지 않는다 ──────────────────────────────

test("[M5b] 늦은 writer는 stale_writer로 거부된다(남의 결과를 덮지 않는다)", async () => {
  const f = await fixture({ taskIds: ["task-a"] });
  // 같은 run을 두 번째 kernel로 열어 **먼저** 커밋한다 → controller의 kernel은 낡은 base를 들고 있다.
  const other = OrchestrationKernel.open({ workspaceRoot: f.repo.root, runId: RUN_ID });
  other.startTask("task-a");
  const out = await f.controller.advanceOnce();
  assert.equal(out.blocked, "stale_writer", "낡은 base로 batch를 시작했다");
  assert.equal(f.provider.turns.length, 0);
  assert.equal(other.getTask("task-a")!.state, "running", "남의 결과가 덮였다");
});

// ── 10. A1: 생성 시점 권위 봉인 ─────────────────────────────────────────────

test("[M5b] A1: kernel·provider·handoff **객체 교체**는 드리프트다(같은 state·같은 id도 거부)", async () => {
  const f = await fixture({ taskIds: ["task-a"] });
  const m = f.controller as unknown as { opts: Record<string, unknown> };
  const revBefore = f.kernel.getState().revision;

  // 같은 run을 여는 **다른** kernel 객체 — 상태는 동일하지만 권위는 봉인된 그 객체뿐이다.
  const twin = OrchestrationKernel.open({ workspaceRoot: f.repo.root, runId: RUN_ID });
  const origKernel = m.opts.kernel;
  m.opts.kernel = twin;
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "같은 state의 다른 kernel을 받아들였다");
  m.opts.kernel = origKernel;

  // 같은 `id`를 단 **다른 진짜 provider 객체**(증명을 통과하는 provider라도 봉인된 그것이 아니면 거부다).
  const origProvider = m.opts.provider;
  m.opts.provider = new CodexHarness(() => okTurn(), {
    manifest: manifestFor(f.repo.head, ["task-a"]),
    controllerRepoRoot: f.repo.root,
  }).codex;
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "같은 id의 다른 provider를 받아들였다");
  m.opts.provider = origProvider;

  // handoff 함수 교체.
  const origHandoff = m.opts.handoff;
  m.opts.handoff = () => ({ spec: readOnlySpec("x", "dev-lead", f.repo.root), prompt: "탈취" });
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "handoff 교체를 받아들였다");
  m.opts.handoff = origHandoff;

  // `opts` 객체 자체를 통째로 갈아끼우는 경로도 막힌다.
  const origOpts = m.opts;
  m.opts = { ...origOpts };
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "opts 교체를 받아들였다");
  m.opts = origOpts;

  assert.equal(f.kernel.getState().revision, revBefore, "차단이 durable state를 바꿨다");
  assert.equal(f.provider.turns.length, 0, "차단인데 provider를 불렀다");
  assert.equal((await f.controller.advanceOnce()).blocked, null, "되돌린 뒤 정상 진행하지 않는다");
});

/**
 * `CodexCliProvider.prototype`은 얼려 두었으므로(A2) 평범한 대입(`p.start = …`)은 strict mode에서
 * **던진다** — 즉 그 경로는 아예 닫혀 있다. 그래도 `defineProperty`로는 인스턴스 own property를 만들 수
 * 있으므로, monkey-patch 회귀는 **그 더 강한 경로**로 시험한다.
 */
function definePatch(target: Record<string, unknown>, name: string, value: unknown): () => void {
  const had = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  return () => {
    if (had) Object.defineProperty(target, name, had);
    else delete target[name];
  };
}

test("[M5b] A1: 생성 뒤 메서드 monkey-patch는 실행되지 않고 드리프트로 닫힌다", async () => {
  const cases: Array<[string, (o: Record<string, unknown>) => () => void]> = [
    [
      "provider.start",
      (o) =>
        definePatch(o.provider as Record<string, unknown>, "start", async () => {
          throw new Error("이 패치는 실행되면 안 된다");
        }),
    ],
    [
      "provider.events",
      (o) =>
        definePatch(o.provider as Record<string, unknown>, "events", () => {
          throw new Error("이 패치는 실행되면 안 된다");
        }),
    ],
    [
      "kernel.submitResult",
      (o) => {
        const k = o.kernel as Record<string, unknown>;
        const orig = k.submitResult;
        k.submitResult = () => {
          throw new Error("이 패치는 실행되면 안 된다");
        };
        return () => {
          k.submitResult = orig;
        };
      },
    ],
    [
      "kernel.scheduleReady",
      (o) => {
        const k = o.kernel as Record<string, unknown>;
        const orig = k.scheduleReady;
        k.scheduleReady = () => [];
        return () => {
          k.scheduleReady = orig;
        };
      },
    ],
  ];
  for (const [label, patch] of cases) {
    const f = await fixture({ taskIds: ["task-a"] });
    const m = f.controller as unknown as { opts: Record<string, unknown> };
    const revBefore = f.kernel.getState().revision;
    const restore = patch(m.opts);
    assert.deepEqual(
      await f.controller.advanceOnce(),
      { blocked: "controller_binding_drift", started: [], tasks: [] },
      `${label} patch를 받아들였다`,
    );
    assert.equal(f.provider.turns.length, 0, `${label}: 차단인데 provider를 불렀다`);
    assert.equal(f.kernel.getState().revision, revBefore, `${label}: 차단이 state를 바꿨다`);
    restore();
    assert.equal((await f.controller.advanceOnce()).blocked, null, `${label}: 되돌린 뒤 진행하지 않는다`);
  }
});

test("[M5b] A1: 재진입 시계가 게이트 통과 뒤 메서드를 갈아끼워도 그 함수는 실행되지 않는다", async () => {
  // 시계는 **봉인 대조를 지난 뒤에** 불린다(`assertGatesOpen`: 드리프트 → clock → 만료·예산).
  // 이전 판의 `scheduleReady`/`startScheduledBatch`는 호출 시점에 caller 소유 property를 **다시 읽는**
  // wrapper였으므로, 재진입 시계가 그 창에서 갈아끼운 함수가 그대로 실행됐다.
  let patched = 0;
  let armed = false;
  const holder: { kernel: Record<string, unknown> | null } = { kernel: null };
  const base = msClock();
  const f = await fixture({
    nowMs: () => {
      if (armed && holder.kernel) {
        armed = false;
        const evil = (): unknown[] => {
          patched++;
          return [];
        };
        definePatch(holder.kernel, "scheduleReady", evil);
        definePatch(holder.kernel, "startScheduledBatch", evil);
      }
      return base();
    },
  });
  holder.kernel = f.kernel as unknown as Record<string, unknown>;
  const revBefore = f.kernel.getState().revision;
  armed = true;
  const out = await f.controller.advanceOnce();

  assert.equal(patched, 0, "봉인 뒤 갈아끼운 kernel 메서드가 실행됐다");
  assert.deepEqual(out.started, ["task-a", "task-b"], "교체된 scheduleReady의 결과가 쓰였다");
  // 갈아끼운 사실 자체는 **조용히 넘어가지 않는다** — 다음 게이트에서 단일 marker로 닫힌다.
  assert.deepEqual(
    out.tasks.map((t) => [t.taskId, t.marker]),
    [
      ["task-a", "controller_binding_drift"],
      ["task-b", "controller_binding_drift"],
    ],
  );
  assert.equal(f.provider.turns.length, 0, "드리프트인데 provider를 불렀다");
  assert.ok(f.kernel.getState().revision > revBefore, "batch 시작 커밋은 있어야 한다");
  assert.equal(f.kernel.getMessage("res.task-a"), null);
});

test("[M5b] A1: 교대 getter는 '검증한 값'과 '실행하는 값'을 가르지 못한다", async () => {
  // 이전 판은 `typeof k[m] === "function"`으로 검사한 **뒤** `k.m.bind(k)`로 다시 읽었다.
  // 교대 getter를 두면 검사에는 진짜가, 실행에는 공격자 함수가 들어갔고 pin도 (둘 다 두 번째 값이라)
  // 같은 값을 봐서 통과했다. 지금은 **한 번 읽은 그 값**만 포착·검증·실행하고 pin의 기준도 그 값이다.
  const f = await fixture({ taskIds: ["task-a"] });
  const kernel = f.kernel as unknown as Record<string, unknown>;
  let evilCalls = 0;
  const evil = (): unknown[] => {
    evilCalls++;
    return [];
  };
  const real = kernel.scheduleReady;
  let reads = 0;
  Object.defineProperty(kernel, "scheduleReady", {
    configurable: true,
    get: () => (reads++ === 0 ? real : evil), // 첫 읽기만 진짜다
  });
  const controller = new StableController({
    kernel: f.kernel,
    provider: f.provider.codex,
    controllerRepoRoot: f.repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: msClock(),
    handoff: (ctx) => ({ spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, f.repo.root), prompt: "p" }),
  });
  const out = await controller.advanceOnce();
  assert.equal(evilCalls, 0, "두 번째 읽기 값이 실행됐다");
  assert.equal(out.blocked, "controller_binding_drift", "두 번째 읽기 값을 권위로 받아들였다");
  assert.equal(f.provider.turns.length, 0);
});

test("[M5b] A1: handoff가 받는 manifest는 **중첩까지 불변**이고 권위 객체가 아니다", async () => {
  let seenManifest: unknown = null;
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => {
      seenManifest = ctx.manifest;
      // 중첩 배열·객체 변조 시도 — frozen이므로 조용히 무시되거나 던진다. 어느 쪽이든 승인은 안 바뀐다.
      assert.ok(Object.isFrozen(ctx.manifest), "manifest가 freeze되지 않았다");
      assert.ok(Object.isFrozen(ctx.manifest.writableRoots), "중첩 writableRoots가 freeze되지 않았다");
      assert.ok(Object.isFrozen(ctx.manifest.allowedDependencies[0]), "중첩 dependency 항목이 freeze되지 않았다");
      assert.throws(() => {
        (ctx.manifest.writableRoots as string[]).push("infra");
      });
      assert.throws(() => {
        (ctx.manifest as { approvedCommit: string }).approvedCommit = "f".repeat(40);
      });
      assert.ok(Object.isFrozen(ctx.task), "task 사본이 freeze되지 않았다");
      assert.ok(Object.isFrozen(ctx.inputs), "inputs 스냅샷이 freeze되지 않았다");
      return { spec: readOnlySpec("s", ctx.task.roleId, root), prompt: "p" };
    },
  });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  // 두 번 부르면 매번 **다른 사본**을 준다(권위 객체를 공유하지 않는다).
  const first = seenManifest;
  assert.notEqual(f.controller.approvedManifest(), first, "매번 같은 객체를 내주고 있다");
  assert.deepEqual(f.controller.approvedManifest(), first);
  assert.equal(f.controller.approvedCommit(), f.repo.head);
});

test("[M5b] A1: handoff 반환값을 **나중에** 바꿔도 실행 입력은 바뀌지 않는다", async () => {
  const repo = await initRepo();
  // handoff가 자기 객체를 그대로 들고 있다가 turn 중간에 고친다(악의·버그 어느 쪽이든).
  let mine: ControllerHandoff | null = null;
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => {
      mine = {
        spec: readOnlySpec("s", ctx.task.roleId, root),
        prompt: "원본 지시",
        request: { commands: [] },
        outputs: [{ path: "src/task-a/out.md", role: "output" }],
      };
      return mine;
    },
    script: (t) => {
      // 첫 turn 도중(= start 직후 스트림 재생 시점)에 원본 객체를 전부 바꿔치기한다.
      if (t === 0 && mine) {
        mine.spec.cwd = "/tmp";
        (mine.spec as { permissionMode?: string }).permissionMode = "acceptEdits";
        mine.prompt = "탈취 지시";
        mine.request!.commands = ["git push origin main"];
        mine.outputs![0].path = "src/other/hijack.md";
      }
      return okTurn();
    },
  });
  void repo;
  writeArtifact(f.repo.root, "src/task-a/out.md", "# 산출물\n");
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  // 실행 입력은 봉인 사본이다: cwd·프롬프트·산출물 전부 원본 값 그대로.
  assert.equal(f.provider.turns[0].cwd, f.repo.root, "in-flight cwd 변조가 실행에 반영됐다");
  assert.equal(f.provider.turns[0].text, "원본 지시", "in-flight 프롬프트 변조가 실행에 반영됐다");
  assert.deepEqual(out.tasks[0].artifacts, ["src/task-a/out.md@1"], "in-flight outputs 변조가 등록에 반영됐다");
});

test("[M5b] A1: provider가 받는 spec은 경계가 확인한 targetRoot로 만든 **새 불변 객체**다", async () => {
  // 관측은 자식이 받은 것으로 한다(provider를 감싸면 A2 증명을 잃는다): cwd는 경계가 돌려준
  // `targetRoot`여야 하고, 나머지 spec 필드는 provider가 봉인해 argv로 컴파일하므로 거기서 보인다.
  let handoffSpec: SessionSpec | null = null;
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => {
      handoffSpec = readOnlySpec("s", ctx.task.roleId, root, { model: "opus" });
      return { spec: handoffSpec, prompt: "p" };
    },
  });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  const turn = f.provider.turns[0];
  assert.equal(turn.cwd, realpathSync(f.repo.root), "경계가 확인한 targetRoot가 cwd로 쓰이지 않았다");
  assert.deepEqual(
    [turn.args[turn.args.indexOf("--model") + 1], turn.args[turn.args.indexOf("--cd") + 1]],
    ["opus", realpathSync(f.repo.root)],
    "나머지 spec 필드가 유실됐거나 cwd가 호출자 문자열로 다시 쓰였다",
  );
  // 호출자 객체는 controller의 실행 입력이 아니다 — 봉인 사본이 따로 있으므로 여기 것은 그대로 남는다.
  assert.equal(handoffSpec!.cwd, f.repo.root);
  assert.equal(Object.isFrozen(handoffSpec), false, "controller가 호출자 객체 자체를 실행 입력으로 삼았다");
});

test("[M5b] A1: handoff 산출물은 closed 검증을 지난다(미상 필드·형태 위반 거부)", async () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["미상 top-level 필드", { spec: {}, prompt: "p", surprise: 1 }],
    ["prompt 없음", { spec: {} }],
    ["spec 없음", { prompt: "p" }],
    ["request 미상 필드", { spec: {}, prompt: "p", request: { sudo: true } }],
    ["outputs 배열 아님", { spec: {}, prompt: "p", outputs: {} }],
    ["직렬화 불가(함수)", { spec: { sessionId: "s", role: "r", cwd: "/x", permissionMode: "plan", hack: () => 1 }, prompt: "p" }],
  ];
  for (const [label, bad] of cases) {
    const f = await fixture({ taskIds: ["task-a"], handoff: () => bad as ControllerHandoff });
    const out = await f.controller.advanceOnce();
    assert.equal(out.tasks[0].marker, "handoff_invalid", label);
    assert.equal(f.provider.turns.length, 0, `${label}: 거부인데 provider를 불렀다`);
  }
});

// ── 11. A2: read-only bridge 게이트 ─────────────────────────────────────────

/**
 * A2 회귀 공용 러너 — provider 후보 하나를 controller 생성자에 넣고 코드를 돌려준다.
 * 통과하면 `"(생성됨)"`이다(그 경우가 하나라도 나오면 이 finding이 다시 열린 것이다).
 */
async function controllerGateCode(provider: unknown): Promise<string> {
  const repo = await initRepo();
  const kernel = createOrchestrationRun({
    workspaceRoot: repo.root,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(repo.head, ["task-a"]),
  });
  kernel.createRootTask(seed("task-a", "dev-lead"));
  try {
    new StableController({
      kernel,
      provider: provider as ExecutionProvider,
      controllerRepoRoot: repo.root,
      gitExecutablePath: TRUSTED_GIT,
      handoff: () => ({ spec: readOnlySpec("s", "dev-lead", repo.root), prompt: "p" }),
    });
    return "(생성됨)";
  } catch (e) {
    assert.ok(e instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(e)}`);
    return e.code;
  }
}

/** 실제 생성 경로를 지난 provider(주입 spawn seam — live 프로세스·네트워크 0). */
function genuineCodex(repoRoot = "/"): CodexCliProvider {
  return new CodexCliProvider({
    manifest: {},
    controllerRepoRoot: repoRoot,
    executablePath: TRUSTED_BIN,
    gitExecutablePath: TRUSTED_GIT,
    spawn: (() => {
      throw new Error("이 provider는 세션을 열지 않는다");
    }) as unknown as SpawnFn,
  });
}

test("[M5b] A2: 실제로 생성되지 않은 provider는 controller 생성 자체가 거부된다(위조 표면 전수)", async () => {
  const genuine = genuineCodex();
  const proto = Object.getPrototypeOf(genuine) as Record<string, unknown>;

  // ⓐ 같은 id를 단 임의 scripted provider(예전 판은 brand 심볼만 달면 통과했다).
  const scripted: ExecutionProvider = {
    id: "codex-cli",
    start: async (spec) => ({ sessionId: spec.sessionId, spec }),
    send: async () => undefined,
    events: () => (async function* () {})(),
    stop: async () => undefined,
  };
  assert.equal(await controllerGateCode(scripted), "controller_provider_not_read_only", "임의 scripted provider가 통과했다");

  // ⓑ 진짜 provider의 property·심볼을 **전부 복사**한 객체.
  const copied = { ...genuine } as Record<string | symbol, unknown>;
  for (const s of Object.getOwnPropertySymbols(genuine)) copied[s] = (genuine as unknown as Record<symbol, unknown>)[s];
  for (const m of ["start", "send", "events", "stop"]) copied[m] = proto[m];
  assert.equal(await controllerGateCode(copied), "controller_provider_not_read_only", "property/심볼 복사본이 통과했다");

  // ⓒ prototype 위조: 겉모습·프로토타입이 같아도 생성자를 지나지 않았다.
  const spoofedProto = Object.create(CodexCliProvider.prototype) as Record<string, unknown>;
  spoofedProto.id = "codex-cli";
  assert.equal(await controllerGateCode(spoofedProto), "controller_provider_not_read_only", "prototype 위조가 통과했다");
  const setProto = { id: "codex-cli" };
  Object.setPrototypeOf(setProto, CodexCliProvider.prototype);
  assert.equal(await controllerGateCode(setProto), "controller_provider_not_read_only", "setPrototypeOf 위조가 통과했다");

  // ⓓ subclass: 생성자를 **지나지만** 자기 메서드로 실행 계약을 갈아치울 수 있다.
  class EvilSubclass extends CodexCliProvider {
    override async start(spec: SessionSpec): Promise<SessionHandle> {
      return { sessionId: spec.sessionId, spec };
    }
  }
  const sub = new EvilSubclass({
    manifest: {},
    controllerRepoRoot: "/",
    executablePath: TRUSTED_BIN,
    gitExecutablePath: TRUSTED_GIT,
    spawn: (() => {
      throw new Error("불가");
    }) as unknown as SpawnFn,
  });
  assert.equal(await controllerGateCode(sub), "controller_provider_not_read_only", "subclass가 통과했다");

  // ⓓ' 아무것도 override하지 않은 subclass도 거부다 — 증명 대상은 "이 구현"이지 "이 구현의 자손"이 아니다
  //     (자손은 다른 메서드·getter·필드로 계약을 얼마든지 바꿀 수 있고, 그 표면을 여기서 추적하지 않는다).
  class PlainSubclass extends CodexCliProvider {}
  const plain = new PlainSubclass({
    manifest: {},
    controllerRepoRoot: "/",
    executablePath: TRUSTED_BIN,
    gitExecutablePath: TRUSTED_GIT,
    spawn: (() => {
      throw new Error("불가");
    }) as unknown as SpawnFn,
  });
  assert.equal(await controllerGateCode(plain), "controller_provider_not_read_only", "override 없는 subclass가 통과했다");

  // ⓔ 인스턴스 메서드 override. prototype이 얼어 있어 **평범한 대입은 아예 던지고**,
  //    `defineProperty`로 own property를 만들어도 함수 신원 대조에서 거부된다.
  for (const m of ["start", "send", "events", "stop"] as const) {
    const patched = genuineCodex();
    assert.throws(() => {
      (patched as unknown as Record<string, unknown>)[m] = () => undefined;
    }, TypeError);
    definePatch(patched as unknown as Record<string, unknown>, m, () => undefined);
    assert.equal(await controllerGateCode(patched), "controller_provider_not_read_only", `${m} override가 통과했다`);
  }

  // ⓕ 진짜 provider를 감싼 Proxy(호출을 가로채면서 신원만 빌린다).
  assert.equal(await controllerGateCode(new Proxy(genuineCodex(), {})), "controller_provider_not_read_only", "Proxy wrapper가 통과했다");

  // ⓖ 발급기·토큰·factory는 밖으로 나가 있지 않다 — 모듈이 내보내는 것은 판정 함수뿐이다.
  const mod = (await import("./codexCliProvider.js")) as Record<string, unknown>;
  const attestors = Object.keys(mod).filter((k) => /attest|brand|contract|issue/i.test(k));
  assert.deepEqual(attestors, ["attestReadOnlyCodexProvider"], "임의 provider를 증명해 줄 수 있는 표면이 늘었다");
  assert.equal(mod.attestReadOnlyCodexProvider instanceof Function, true);
  assert.equal((mod.attestReadOnlyCodexProvider as (p: unknown) => unknown)(scripted), null, "판정 함수가 임의 객체를 증명했다");
});

test("[M5b] A2: production 경로 — 실제 CodexCliProvider(주입 spawn)로 controller가 그대로 전진한다", async () => {
  // live codex/claude·네트워크·인증 0. provider 생성·봉인·경계·argv·stdin 배선은 전부 진짜 경로다.
  const f = await fixture({ taskIds: ["task-a"] });
  assert.equal(f.provider.codex instanceof CodexCliProvider, true, "production provider가 아니다");
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  const turn = f.provider.turns[0];
  assert.equal(turn.args[0], "exec");
  assert.deepEqual([turn.args.includes("--sandbox"), turn.args[turn.args.indexOf("--sandbox") + 1]], [true, "read-only"]);
  assert.ok(turn.text.includes("task-a 제목"), "프롬프트가 stdin으로 가지 않았다");
});

test("[M5b] A2: read-only가 아닌 spec은 provider를 띄우지 않는다", async () => {
  const cases: Array<[string, Partial<SessionSpec>]> = [
    ["permissionMode 미지정(기본 acceptEdits)", { permissionMode: undefined }],
    ["permissionMode acceptEdits", { permissionMode: "acceptEdits" }],
    ["permissionMode bypassPermissions", { permissionMode: "bypassPermissions" }],
    ["allowedTools 확대", { allowedTools: ["Bash"] }],
    ["addDirs 확대", { addDirs: ["/etc"] }],
    ["settingsPath 주입", { settingsPath: "/tmp/settings.json" }],
    ["codex sandbox 비 read-only", { codex: { sandbox: "workspace-write" as never, codexHome: "/tmp/ch" } }],
  ];
  for (const [label, over] of cases) {
    const f = await fixture({
      taskIds: ["task-a"],
      handoff: (ctx, root) => ({ spec: { ...readOnlySpec("s", ctx.task.roleId, root), ...over }, prompt: "p" }),
    });
    const out = await f.controller.advanceOnce();
    assert.equal(out.tasks[0].marker, "controller_spec_not_read_only", label);
    assert.equal(f.provider.turns.length, 0, `${label}: 거부인데 provider를 불렀다`);
    assert.equal(f.kernel.getMessage("res.task-a"), null, `${label}: 거부인데 result가 남았다`);
  }
});

test("[M5b] A2: 실행을 요구하는 handoff 선언은 start 이전에 거부된다(spawn 0 · ack 0)", async () => {
  // 승인 범위 **안**의 명령이라도 거부다 — 이 slice에서는 명령 실행 자체가 계약 밖이다.
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["승인된 명령", { commands: ["npm test"] }, "policy_not_read_only"],
    ["승인 밖 명령", { commands: ["rm -rf /"] }, "policy_not_read_only"],
    ["쓰기 경로", { writePaths: ["src/task-a/x.ts"] }, "policy_not_read_only"],
    ["dependency", { dependencies: [{ name: "typescript", version: "5.7.2" }] }, "policy_not_read_only"],
    ["네트워크", { networkDomains: ["registry.npmjs.org"] }, "policy_not_read_only"],
    ["MCP 패키지", { mcpPackages: ["typescript@5.7.2"] }, "policy_not_read_only"],
    ["로컬 merge", { localMerge: true }, "policy_not_read_only"],
    ["hard deny 의도", { intents: ["remote_repo_write"] }, "policy_hard_denied"],
    ["hard deny 의도(배포)", { intents: ["production_deploy"] }, "policy_hard_denied"],
  ];
  for (const [label, request, code] of cases) {
    const g = await fixtureWithDelivery({
      handoff: (ctx, root) => ({ spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, root), prompt: "p", request }),
    });
    const out = await g.controller.advanceOnce();
    const worker = out.tasks.find((t) => t.taskId === "worker")!;
    assert.equal(worker.marker, code, label);
    assert.equal(g.provider.turns.length, 0, `${label}: 거부인데 provider를 불렀다`);
    assert.deepEqual(worker.acknowledged, [], `${label}: 거부인데 전달을 수령했다`);
    assert.equal(g.kernel.getMessage("su-1")!.acknowledgedAt, null, `${label}: 거부인데 ack가 durable에 남았다`);
  }
});

test("[M5b] A2: 산출물 경로 소유권은 kernel(권위)이 집행한다 — 남의 경로는 등록 0", async () => {
  const f = await fixture({
    taskIds: ["task-a", "task-b"],
    handoff: (ctx, root) => ({
      spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, root),
      prompt: "p",
      // task-a가 task-b의 소유 경로를 자기 산출물로 등록하려 한다.
      outputs: ctx.task.taskId === "task-a" ? [{ path: "src/task-b/steal.md", role: "output" }] : [],
    }),
  });
  writeArtifact(f.repo.root, "src/task-b/steal.md", "남의 것\n");
  const out = await f.controller.advanceOnce();
  const a = out.tasks.find((t) => t.taskId === "task-a")!;
  assert.equal(a.marker, "artifact_not_owned");
  assert.deepEqual(a.artifacts, []);
  assert.equal(f.kernel.getTask("task-a")!.state, "running", "소유권 위반인데 완료로 만들었다");
  assert.equal(f.kernel.getState().artifacts.length, 0, "소유권 위반 artifact가 durable에 남았다");
  // 같은 batch의 task-b는 자기 계약대로 완료된다(게이트가 batch 전체를 죽이지 않는다).
  assert.equal(out.tasks.find((t) => t.taskId === "task-b")!.status, "completed");
});

// ── 12. A3: 예산은 provider 호출마다 다시 본다 ───────────────────────────────

test("[M5b] A3: 앞 task가 토큰 예산을 소진하면 뒤 task는 provider를 **한 번도** 부르지 않는다", async () => {
  // turn 하나 = 5 토큰. 상한을 정확히 5로 두면 task-a는 완료되고 그 즉시 예산이 소진된다.
  const f = await fixture({ manifest: { maxTokens: 5 } });
  const out = await f.controller.advanceOnce();
  assert.deepEqual(out.started, ["task-a", "task-b"], "kernel 결정은 그대로여야 한다");
  const [a, b] = out.tasks;
  assert.deepEqual([a.taskId, a.status, a.marker], ["task-a", "completed", "result_accepted"]);
  assert.deepEqual([b.taskId, b.status, b.marker], ["task-b", "failed", "budget_tokens_exhausted"]);
  assert.equal(b.turns, 0);
  assert.equal(f.provider.turns.length, 1, "예산 소진 뒤에도 두 번째 task를 시작했다");
  assert.deepEqual(f.provider.turns.map((t) => t.sessionId), ["sess-task-a"]);
  assert.equal(f.kernel.getTask("task-b")!.state, "running", "시작하지 않은 task의 lifecycle은 M5c(B-11/B-13) 소유다");
  assert.equal(f.kernel.getMessage("res.task-b"), null, "시작도 안 한 task의 result가 남았다");
});

test("[M5b] A3: **실패한** turn이 태운 토큰도 전역 예산에서 빠진다(그 뒤 task는 시작되지 않는다)", async () => {
  // 이전 판은 공용 소비자가 `isError`에서 먼저 던졌으므로 실패 turn의 usage가 회계되지 않았다 →
  // 예산이 이미 소진됐는데 다음 task가 계속 시작됐다. turn 하나 = 5 토큰, 상한도 5로 둔다.
  const f = await fixture({ manifest: { maxTokens: 5 }, script: () => failedTurnWithUsage() });
  const out = await f.controller.advanceOnce();
  const [a, b] = out.tasks;
  assert.deepEqual([a.taskId, a.status, a.marker], ["task-a", "failed", "provider_result_error"]);
  assert.deepEqual(a.usage, { inputTokens: 3, outputTokens: 2 }, "실패 turn의 usage가 회계되지 않았다");
  assert.equal(a.turns, 1, "실패 turn이 turn 수에 세어지지 않았다");
  assert.equal(f.controller.usedTokens(), 5, "실패 turn이 전역 예산을 줄이지 않았다");
  assert.deepEqual([b.taskId, b.marker, b.turns], ["task-b", "budget_tokens_exhausted", 0]);
  assert.equal(f.provider.turns.length, 1, "예산이 소진됐는데 두 번째 task가 provider를 불렀다");
  assert.equal(f.kernel.getTask("task-a")!.state, "running", "실패인데 완료로 만들었다");
  assert.equal((await f.controller.advanceOnce()).blocked, "budget_tokens_exhausted", "소진 뒤 advance가 다시 열렸다");
});

test("[M5b] A3: 0이 아닌 실패 usage 뒤의 task는 **줄어든** 예산을 본다(이중 회계도 없다)", async () => {
  const f = await fixture({ manifest: { maxTokens: 8 }, script: (t) => (t === 0 ? failedTurnWithUsage() : okTurn()) });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].marker, "provider_result_error");
  // task-b는 남은 3토큰으로 시작하지만 5를 태워 상한을 넘는다 → 그 turn에서 닫힌다.
  assert.equal(out.tasks[1].marker, "budget_tokens_exhausted");
  assert.equal(f.controller.usedTokens(), 10, "실패·성공 turn의 usage 합이 정확히 한 번씩 세어지지 않았다");
  assert.equal(f.provider.turns.length, 2);
  assert.equal(f.kernel.getTask("task-b")!.state, "running");
});

test("[M5b] A3: 경과 예산이 첫 task 중에 소진되면 뒤 task는 시작되지 않는다", async () => {
  // 매 clock 호출이 1초 전진하므로 첫 task 진행 중에 5초 상한을 넘긴다.
  const f = await fixture({ manifest: { maxElapsedMs: 5_000 }, nowMs: msClock() });
  const out = await f.controller.advanceOnce();
  const b = out.tasks.find((t) => t.taskId === "task-b")!;
  assert.equal(b.marker, "budget_elapsed_exhausted");
  assert.equal(b.turns, 0);
  assert.equal(f.provider.turns.length, 1, "경과 예산 소진 뒤에도 두 번째 task를 시작했다");
});

// ── 13. A4: 포인터는 경계 await **뒤에** 다시 검증된다 ────────────────────────

test("[M5b] A4: start 창 — 경계 await 도중 입력이 변조되면 provider가 뜨지 않는다", async () => {
  const repo = await initRepo();
  let root = "";
  const seam = armedClock(() => {
    if (root) writeArtifact(root, "src/producer/out.md", "# 경계 도중 바뀐 산출물\n");
  }, 2);
  const g = await fixtureWithDelivery({
    nowMs: seam.clock,
    handoff: (ctx, r) => {
      root = r;
      seam.arm(); // 다음 clock ①=경계 진입 → git 비동기 조회 → ②=동기 게이트(여기서 변조)
      return { spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, r), prompt: "p" };
    },
  });
  void repo;
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.marker, "artifact_hash_mismatch", "경계 뒤 재검증이 없다(낡은 검증으로 provider를 띄웠다)");
  assert.equal(g.provider.turns.length, 0, "포인터가 어긋났는데 provider를 시작했다");
  assert.equal(g.kernel.getTask("worker")!.state, "running");
});

test("[M5b] A4: send 창 — 경계 await 도중 전달 포인터가 변조되면 send·ack 0", async () => {
  let root = "";
  const seam = armedClock(() => {
    if (root) writeArtifact(root, "src/producer/out.md", "# send 창에서 바뀐 산출물\n");
  }, 3);
  const g = await fixtureWithDelivery({
    nowMs: seam.clock,
    handoff: (ctx, r) => {
      root = r;
      return { spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, r), prompt: "p" };
    },
    script: (t) => {
      // start turn이 재생되는 시점에 arm → 이후 clock ①=applyTurn ②=전달 경계 진입
      // → git 비동기 조회 → ③=동기 게이트(여기서 변조) → 포인터 재검증이 잡아야 한다.
      if (t === 0) seam.arm();
      return okTurn();
    },
  });
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.marker, "artifact_hash_mismatch", "전달 경계 뒤 재검증이 없다");
  assert.equal(worker.turns, 1, "start turn만 있어야 한다");
  assert.deepEqual(g.provider.turns.map((t) => t.kind), ["start"], "포인터가 어긋났는데 send했다");
  assert.deepEqual(worker.acknowledged, []);
  assert.equal(g.kernel.getMessage("su-1")!.acknowledgedAt, null);
});

// ── 14. A5: 종료 결과는 정확히 1건이다 ──────────────────────────────────────
//
// **관측 지점이 바뀐 이유(A2 이후)**: controller가 이제 진짜 `CodexCliProvider`만 받고, 그 파서는
// 중복·모순 종료를 **자기 계층에서** 이미 하나의 실패 종료로 정규화한다(아래 첫 두 테스트가 그것을
// 고정한다). 그래서 "종료가 2건인 스트림"은 codex 경로로는 만들 수 없다 — controller의 방어는 그대로
// 남기고(다른 provider·미래 provider용 defense in depth), 그 불변식은 controller가 **실제로 쓰는 코드
// 집합**(`CONTROLLER_TERMINAL_CODES`)에 대고 공용 소비자에 직접 단정한다.

/** 임의 이벤트 스트림 하나를 controller의 실제 계약으로 소비한다. */
async function consumeAsController(events: SessionEvent[], onTerminal?: (r: unknown) => void): Promise<string> {
  const stream = (async function* () {
    for (const e of events) yield e;
  })();
  try {
    await consumeExactlyOneTerminal(stream, CONTROLLER_TERMINAL_CODES, MAX_TURN_EVENTS, ControllerError, onTerminal as never);
    return "(수락됨)";
  } catch (e) {
    assert.ok(e instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(e)}`);
    return e.code;
  }
}

const RESULT_RAW = { type: "scripted" };
function resultEvent(isError: boolean, text: string): SessionEvent {
  return {
    kind: "result",
    sessionId: "s",
    isError,
    text,
    numTurns: 1,
    usage: USAGE,
    totalCostUsd: 0,
    permissionDenials: [],
    raw: RESULT_RAW,
  };
}

test("[M5b] A5: controller 계약 — 종료는 정확히 1건이고 마지막 결과가 이기지 않는다", async () => {
  // 실패 종료 뒤 성공 종료 → 성공으로 읽히던 창.
  assert.equal(await consumeAsController([resultEvent(true, ""), resultEvent(false, "두 번째 종료")]), "provider_duplicate_terminal");
  // 종료 뒤의 **어떤** 이벤트도 거부다.
  assert.equal(
    await consumeAsController([
      resultEvent(false, "완료"),
      { kind: "assistant", sessionId: "s", text: "종료 뒤 덧붙임", toolUses: [], stopReason: null, raw: RESULT_RAW },
    ]),
    "provider_duplicate_terminal",
  );
  assert.equal(await consumeAsController([]), "provider_no_result", "종료 결과 없는 스트림이 수락됐다");
  assert.equal(await consumeAsController([resultEvent(true, "")]), "provider_result_error");
  assert.equal(await consumeAsController([resultEvent(false, "완료")]), "(수락됨)");
  // 이벤트 상한.
  const flood: SessionEvent[] = [];
  for (let i = 0; i <= MAX_TURN_EVENTS; i++) {
    flood.push({ kind: "status", sessionId: "s", status: "x", raw: RESULT_RAW });
  }
  assert.equal(await consumeAsController(flood), "provider_stream_unbounded");
});

test("[M5b] A5: codex 파서가 중복·모순 종료를 완료로 만들지 않는다(실제 provider 경로)", async () => {
  // 실패 종료 뒤 성공 종료를 **JSONL로** 흘려도 task는 완료되지 않는다.
  const f = await fixture({
    taskIds: ["task-a"],
    script: () => ({
      lines: [
        `{"type":"thread.started","thread_id":"${CODEX_TID}"}`,
        '{"type":"turn.failed","error":{"message":"first_failed"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      ],
    }),
  });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "failed");
  assert.equal(out.tasks[0].marker, "provider_result_error", "중복 종료가 성공으로 읽혔다");
  assert.equal(f.kernel.getTask("task-a")!.state, "running", "중복 종료인데 완료로 만들었다");
  assert.equal(f.kernel.getMessage("res.task-a"), null);

  // 종료 뒤에 온 항목도 마찬가지다.
  const g = await fixture({
    taskIds: ["task-a"],
    script: () => ({
      lines: [...okTurn().lines, '{"type":"item.completed","item":{"id":"z","item_type":"agent_message","text":"종료 뒤 덧붙임"}}'],
    }),
  });
  const late = (await g.controller.advanceOnce()).tasks[0];
  assert.equal(late.status, "failed", "종료 뒤 이벤트가 수락됐다");
  assert.equal(g.kernel.getTask("task-a")!.state, "running");
});

// ── 15. A5b: 경계 밖 코드는 orchestration 결과 코드를 고르지 못한다 ──────────

/** 던지는 스트림을 controller의 실제 코드 집합으로 소비한다. */
async function consumeThrowing(err: unknown): Promise<string> {
  const stream = (async function* (): AsyncGenerator<SessionEvent> {
    throw err;
  })();
  try {
    await consumeExactlyOneTerminal(stream, CONTROLLER_TERMINAL_CODES, MAX_TURN_EVENTS, ControllerError);
    return "(수락됨)";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `(${String(e)})`;
  }
}

test("[M5b] A5b: provider iterator가 임의 코드를 달아도 결과 코드가 되지 못한다", async () => {
  // 이전 판은 "문자열 `code`를 가진 Error"면 무엇이든 그대로 통과시켰다 →
  // provider가 `result_accepted`를 달고 던지면 **성공처럼 보이는 marker를 단 실패**가 만들어졌다.
  for (const err of [
    new OrchestrationError("result_accepted", "탈취"),
    Object.assign(new Error("탈취"), { code: "result_accepted" }),
    new ControllerError("result_accepted", "같은 타입을 흉내낸다"),
    Object.assign(new Error("탈취"), { code: "budget_tokens_exhausted" }),
    { code: "result_accepted" },
    "result_accepted",
  ]) {
    assert.equal(await consumeThrowing(err), "provider_stream_failed", `${String((err as { code?: string }).code ?? err)}가 새어나갔다`);
  }
});

test("[M5b] A5b: handoff·start·send가 던진 임의 코드는 안정 실패 코드로 접힌다", async () => {
  // ⓐ handoff factory가 성공처럼 보이는 코드로 던진다.
  const h = await fixture({
    taskIds: ["task-a"],
    handoff: () => {
      throw new OrchestrationError("result_accepted", "탈취");
    },
  });
  const a = (await h.controller.advanceOnce()).tasks[0];
  assert.deepEqual([a.status, a.marker], ["failed", "handoff_failed"]);
  assert.equal(h.kernel.getTask("task-a")!.state, "running");
  assert.equal(h.kernel.getMessage("res.task-a"), null);

  // ⓑ provider `start` 경계가 던진 코드.
  const s = await fixture({
    taskIds: ["task-a"],
    spawn: () => {
      throw new OrchestrationError("result_accepted", "탈취");
    },
  });
  const b = (await s.controller.advanceOnce()).tasks[0];
  assert.deepEqual([b.status, b.marker], ["failed", "provider_start_failed"]);

  // ⓒ provider `send` 경계가 던진 코드(전달 turn).
  const g = await fixtureWithDelivery();
  const inner = (g.provider.codex as unknown as { spawnFn: SpawnFn }).spawnFn;
  let spawns = 0;
  (g.provider.codex as unknown as { spawnFn: SpawnFn }).spawnFn = (cmd, args, o) => {
    if (++spawns === 2) throw new OrchestrationError("result_accepted", "탈취");
    return inner(cmd, args, o);
  };
  const worker = (await g.controller.advanceOnce()).tasks.find((t) => t.taskId === "worker")!;
  assert.deepEqual([worker.status, worker.marker], ["failed", "provider_send_failed"]);
  assert.deepEqual(worker.acknowledged, [], "실패한 전달을 수령했다");
  assert.equal(g.kernel.getMessage("su-1")!.acknowledgedAt, null);
});

test("[M5b] A5: 전달 turn이 실패로 끝나면 ack를 만들지 않는다", async () => {
  const g = await fixtureWithDelivery({
    script: (t) =>
      t === 0
        ? okTurn()
        : {
            lines: [
              `{"type":"thread.started","thread_id":"${CODEX_TID}"}`,
              '{"type":"turn.failed","error":{"message":"delivery_failed"}}',
              '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
            ],
          },
  });
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.marker, "provider_result_error");
  assert.deepEqual(worker.acknowledged, []);
  assert.equal(g.kernel.getMessage("su-1")!.acknowledgedAt, null);
});
