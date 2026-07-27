/**
 * V3 M5b — StableController 테스트.
 *
 * 실제 Codex/Claude 추론·네트워크·인증은 **없다**. 쓰는 것은 ⓐ 진짜 git checkout(실행 경계가 승인 커밋을
 * 증명해야 하므로) ⓑ in-process **scripted provider**(handle 신원·turn별 스트림·실패 주입) ⓒ 실제
 * `OrchestrationKernel`(SoR)뿐이다. provider 프로세스는 하나도 뜨지 않는다.
 * 실행: `npx tsx --test src/exec/stableController.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AsyncEventQueue } from "./eventQueue.js";
import { runProcess } from "./runProcess.js";
import { OrchestrationKernel, createOrchestrationRun } from "./orchestrationKernel.js";
import { LIMITS, OrchestrationError, REQUIRED_BODY_HEADINGS } from "./orchestrationTypes.js";
import type { AgentMessageType } from "./orchestrationTypes.js";
import { runPaths } from "./orchestrationStore.js";
import { StableController, compileExecutionPolicy, type ControllerHandoff, type HandoffContext } from "./stableController.js";
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

// ── scripted provider ──────────────────────────────────────────────────────

interface TurnRecord {
  kind: "start" | "send";
  sessionId: string;
  text: string;
  cwd: string;
}

type TurnScript = (turn: number) => SessionEvent[];

/**
 * in-process provider. **CodexCliProvider와 같은 핸들 계약**을 흉내낸다(불투명 `providerBinding` 참조
 * 동일성) — controller가 핸들을 직렬화·재구성하면 여기서 fail closed로 잡힌다.
 * turn마다 큐를 **교체**하므로(실제 provider와 동일) 예전 iterable을 재사용하면 결과를 잃는다(`C-25`).
 */
class ScriptedProvider implements ExecutionProvider {
  readonly id = "scripted";
  readonly turns: TurnRecord[] = [];
  readonly stops: string[] = [];
  /** `start()`가 발급한 핸들과, 이후 진입점이 **실제로 받은** 핸들. 참조 동일성 단정용. */
  readonly issued: SessionHandle[] = [];
  readonly seen: SessionHandle[] = [];
  /** `events()` 호출 횟수 — turn마다 다시 구독했는지 센다. */
  eventCalls = 0;
  private sessions = new Map<string, { binding: object; queue: AsyncEventQueue<SessionEvent>; spec: SessionSpec }>();
  private turn = 0;

  constructor(private readonly script: TurnScript) {}

  async start(spec: SessionSpec, prompt: string): Promise<SessionHandle> {
    if (this.sessions.has(spec.sessionId)) throw new OrchestrationError("scripted_session_exists", "중복 start");
    const binding = Object.freeze({});
    const queue = new AsyncEventQueue<SessionEvent>();
    this.sessions.set(spec.sessionId, { binding, queue, spec });
    this.turns.push({ kind: "start", sessionId: spec.sessionId, text: prompt, cwd: spec.cwd });
    this.replay(queue);
    const handle = Object.freeze({ sessionId: spec.sessionId, spec, providerBinding: binding });
    this.issued.push(handle);
    return handle;
  }

  async send(handle: SessionHandle, message: string): Promise<void> {
    const st = this.require(handle);
    st.queue = new AsyncEventQueue<SessionEvent>(); // 새 invocation = 새 스트림
    this.turns.push({ kind: "send", sessionId: handle.sessionId, text: message, cwd: st.spec.cwd });
    this.replay(st.queue);
  }

  events(handle: SessionHandle): AsyncIterable<SessionEvent> {
    this.eventCalls++;
    return this.require(handle).queue;
  }

  async stop(handle: SessionHandle, reason: string): Promise<void> {
    const st = this.sessions.get(handle.sessionId);
    if (!st || st.binding !== handle.providerBinding) return; // 낡은 핸들은 무해
    st.queue.close();
    this.sessions.delete(handle.sessionId);
    this.stops.push(reason);
  }

  private require(handle: SessionHandle): { binding: object; queue: AsyncEventQueue<SessionEvent>; spec: SessionSpec } {
    this.seen.push(handle);
    const st = handle && typeof handle.sessionId === "string" ? this.sessions.get(handle.sessionId) : undefined;
    if (!st) throw new OrchestrationError("scripted_unknown_session", "없는 세션");
    if (st.binding !== handle.providerBinding) {
      throw new OrchestrationError("scripted_stale_handle", "이 핸들은 이 세션 인스턴스의 것이 아니다");
    }
    return st;
  }

  private replay(queue: AsyncEventQueue<SessionEvent>): void {
    for (const e of this.script(this.turn++)) queue.push(e);
    queue.close();
  }
}

function okTurn(text = "완료"): SessionEvent[] {
  const raw = { type: "scripted" };
  return [
    { kind: "init", sessionId: "s", model: "m", cwd: "/", permissionMode: "read-only", tools: [], mcpServers: [], raw },
    { kind: "result", sessionId: "s", isError: false, text, numTurns: 1, usage: USAGE, totalCostUsd: 0, permissionDenials: [], raw },
  ];
}

function errTurn(reason: string): SessionEvent[] {
  const raw = { type: "scripted" };
  return [
    {
      kind: "result",
      sessionId: "s",
      isError: true,
      text: "",
      numTurns: 0,
      usage: USAGE,
      totalCostUsd: 0,
      terminalReason: reason,
      permissionDenials: [],
      raw,
    },
  ];
}

// ── 픽스처: root task 2개(자원 class 공유) + 의존 reviewer ────────────────────

interface Fixture {
  repo: { root: string; head: string };
  kernel: OrchestrationKernel;
  provider: ScriptedProvider;
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
}

async function fixture(opts: FixtureOpts = {}): Promise<Fixture> {
  const repo = await initRepo();
  const taskIds = opts.taskIds ?? ["task-a", "task-b"];
  const kernel = createOrchestrationRun({
    workspaceRoot: repo.root,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(repo.head, taskIds, opts.manifest),
    clock: (() => {
      let n = 0;
      return () => new Date(Date.UTC(2026, 6, 27, 0, 0, n++));
    })(),
  });
  for (const id of taskIds) {
    kernel.createRootTask(seed(id, "dev-lead", opts.shareResource ? { resourceClasses: ["global-tmp"] } : {}));
  }
  const provider = new ScriptedProvider(opts.script ?? (() => okTurn()));
  const handoffs: HandoffContext[] = [];
  const controller = new StableController({
    kernel,
    provider,
    controllerRepoRoot: repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: opts.nowMs ?? msClock(),
    handoff: (ctx) => {
      handoffs.push(ctx);
      return opts.handoff
        ? opts.handoff(ctx, repo.root)
        : {
            spec: { sessionId: `sess-${ctx.task.taskId}`, role: ctx.task.roleId, cwd: repo.root },
            prompt: `# ${ctx.task.title}\n${ctx.inputs.map((i) => `- ${i.path}@${i.revision}`).join("\n")}`,
            request: { commands: ["npm test"] },
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
  assert.equal(g.provider.eventCalls, 2, "turn마다 events()를 다시 부르지 않았다");
  assert.equal(worker.usage.inputTokens, 6, "두 turn의 usage가 합산되지 않았다");
});

/** producer(완료) → worker(의존) 배치: worker inbox에 중앙 경유 전달 1건이 대기한다. */
async function fixtureWithDelivery(over: FixtureOpts = {}): Promise<Fixture> {
  const repo = await initRepo();
  const kernel = createOrchestrationRun({
    workspaceRoot: repo.root,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(repo.head, ["producer", "worker"], over.manifest),
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
  const provider = new ScriptedProvider(over.script ?? ((t) => okTurn(t === 0 ? "첫 turn" : "두 번째 turn")));
  const handoffs: HandoffContext[] = [];
  const controller = new StableController({
    kernel,
    provider,
    controllerRepoRoot: repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: over.nowMs ?? msClock(),
    handoff: (ctx) => {
      handoffs.push(ctx);
      return over.handoff
        ? over.handoff(ctx, repo.root)
        : {
            spec: { sessionId: `sess-${ctx.task.taskId}`, role: ctx.task.roleId, cwd: repo.root },
            prompt: `# ${ctx.task.title}`,
            request: { commands: ["npm test"] },
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
      spec: { sessionId: `sess-${ctx.task.taskId}`, role: ctx.task.roleId, cwd: root },
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
      spec: { sessionId: "s", role: ctx.task.roleId, cwd: root },
      prompt: "구현",
      outputs: [{ path: "src/task-a/missing.md", role: "output" }],
    }),
  });
  const bad = (await g.controller.advanceOnce()).tasks[0];
  assert.equal(bad.marker, "artifact_missing");
  assert.equal(g.kernel.getTask("task-a")!.state, "running", "등록 실패인데 완료로 만들었다");
  assert.equal(g.kernel.getMessage("res.task-a"), null, "실패했는데 result 메시지가 남았다");
});

// ── 5. 정책 preflight ───────────────────────────────────────────────────────

test("[M5b] 정책은 deny-by-default이고 hard deny가 manifest보다 강하다", async () => {
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

test("[M5b] 승인 목록에 들어온 hard deny 명령도 거부한다(manifest가 덮지 못한다)", async () => {
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
});

test("[M5b] 정책 거부는 provider start 이전이다(spawn·전이 0)", async () => {
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => ({
      spec: { sessionId: "s", role: ctx.task.roleId, cwd: root },
      prompt: "p",
      request: { commands: ["rm -rf /"] },
    }),
  });
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].marker, "policy_command_denied");
  assert.equal(f.provider.turns.length, 0, "정책 거부인데 provider를 시작했다");
  assert.equal(f.kernel.getTask("task-a")!.state, "running");
});

test("[M5b] 정책 거부는 전달 send·수령보다 먼저다(send 0 · ack 0)", async () => {
  // handoff가 **첫 컴파일 뒤에** 승인 밖 명령을 요구하도록 바꾼다 → 전달 turn은 뜨지 않고 ack도 없다.
  // (요청 객체를 하나 공유하므로 controller가 전달 직전에 다시 컴파일할 때 그 값이 보인다.)
  const request = { commands: ["npm test"] };
  const g = await fixtureWithDelivery({
    handoff: (ctx, root) => ({
      spec: { sessionId: `sess-${ctx.task.taskId}`, role: ctx.task.roleId, cwd: root },
      prompt: "p",
      request,
    }),
    script: (t) => {
      if (t === 0) request.commands = ["npm run deploy:prod"]; // 첫 turn 뒤에 승인 밖으로 바뀐다
      return okTurn();
    },
  });
  const out = await g.controller.advanceOnce();
  const worker = out.tasks.find((t) => t.taskId === "worker")!;
  assert.equal(worker.marker, "policy_command_denied");
  assert.deepEqual(worker.acknowledged, [], "정책 거부인데 전달을 수령했다");
  assert.deepEqual(g.provider.turns.map((t) => t.kind), ["start"], "정책 거부인데 전달 turn을 보냈다");
  assert.equal(g.kernel.getMessage("su-1")!.acknowledgedAt, null);
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
      return { spec: { sessionId: "s", role: ctx.task.roleId, cwd: join(root, "src") }, prompt: "p" };
    },
  });
  const bad = (await g.controller.advanceOnce()).tasks[0];
  assert.equal(bad.marker, "boundary_not_checkout_root");
  assert.equal(g.provider.turns.length, 0);
});

// ── 7. provider 실패·낡은 핸들 ──────────────────────────────────────────────

test("[M5b] provider가 준 핸들 객체를 그대로 들고 다닌다(직렬화·재구성 없음)", async () => {
  const g = await fixtureWithDelivery();
  const out = await g.controller.advanceOnce();
  assert.equal(out.tasks.find((t) => t.taskId === "worker")!.status, "completed");
  // producer는 픽스처가 이미 완료시켰으므로 이 배치의 세션은 worker 하나다.
  assert.equal(g.provider.issued.length, 1);
  const worker = g.provider.issued[0];
  assert.equal(worker.sessionId, "sess-worker");
  const seenForWorker = g.provider.seen.filter((h) => h.sessionId === "sess-worker");
  assert.ok(seenForWorker.length >= 3, "send·events·stop이 핸들을 받지 않았다");
  for (const h of seenForWorker) {
    assert.equal(h, worker, "controller가 핸들을 재구성해 넘겼다(참조 동일성 깨짐)");
  }
});

test("[M5b] provider 오류·결과 없음은 완료를 만들지 않는다", async () => {
  const noResult = await fixture({ taskIds: ["task-a"], script: () => [] });
  assert.equal((await noResult.controller.advanceOnce()).tasks[0].marker, "provider_no_result");
  assert.equal(noResult.kernel.getTask("task-a")!.state, "running");

  const thrown = await fixture({ taskIds: ["task-a"] });
  const p = thrown.provider as unknown as { start: () => Promise<never> };
  p.start = async () => {
    throw new OrchestrationError("codex_spawn_failed", "spawn 실패");
  };
  assert.equal((await thrown.controller.advanceOnce()).tasks[0].marker, "codex_spawn_failed");
  assert.equal(thrown.provider.turns.length, 0);
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
  const raw = { type: "scripted", cmd: SENTINELS.argv };
  const f = await fixture({
    taskIds: ["task-a"],
    script: () => [
      { kind: "status", sessionId: "s", status: `reasoning:${SENTINELS.reasoning}`, raw },
      { kind: "assistant", sessionId: "s", text: `추론 원문 ${SENTINELS.reasoning}`, toolUses: [], stopReason: null, raw },
      {
        kind: "result",
        sessionId: "s",
        isError: false,
        text: `최종 메시지 ${SENTINELS.reasoning} ${SENTINELS.stderr} ${SENTINELS.secret}`,
        numTurns: 1,
        usage: USAGE,
        totalCostUsd: 0,
        permissionDenials: [],
        raw,
      },
    ],
    handoff: (ctx, root) => ({
      spec: { sessionId: "s", role: ctx.task.roleId, cwd: root },
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
