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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "./runProcess.js";
import { OrchestrationKernel, createOrchestrationRun, openOrchestrationRun } from "./orchestrationKernel.js";
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
import { CodexCliProvider, attestReadOnlyCodexProvider, type SpawnFn } from "./codexCliProvider.js";
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

// ── 실제 CodexCliProvider(production 생성 경로) + 실제 자식 프로세스 ─────────────
//
// **2026-07-28 3차 리뷰 A1 이후**: `opts.spawn`으로 임의 executor를 주입한 인스턴스는 **증명을 받지
// 못한다**(그것이 A1의 요점이다). 그래서 controller 테스트는 그 seam을 쓰지 않고 **production 생성
// 경로 그대로**(spawn 미지정 → 진짜 `node:child_process.spawn`) provider를 만들고, 결정론은
// **결정론적 fake codex 실행 파일**로 만든다: 실제 OS 자식 프로세스가 뜨지만 codex 추론·네트워크·
// 인증은 전혀 없다(자식은 `__fixtures__/fake-codex.mjs`가 시나리오 파일대로 JSONL을 흘리는 것뿐이다).
//
// 관측은 **자식이 실제로 받은 것**(argv·cwd·stdin·env)으로만 한다 — provider를 감싸거나 내부 필드를
// 갈아끼우면 A1/A2 증명을 통과하지 못하고, 그것이 요점이다.

const FAKE_CODEX = fileURLToPath(new URL("./__fixtures__/fake-codex.mjs", import.meta.url));

/**
 * 신뢰 조건(정규 · 비symlink · 일반 파일 · 실행 비트 · group/other 쓰기 없음)을 만족하는 fake codex
 * 실행 파일. 자식 env는 **`CODEX_HOME` 하나뿐**이라 `#!/usr/bin/env node`는 PATH가 없어 실패한다 →
 * **절대 `process.execPath` shebang**을 쓴다. 본문은 기존 fixture를 그대로 import한다(복제 금지).
 */
function fakeCodexBin(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5b-bin-")));
  cleanups.push(dir);
  const bin = join(dir, "codex.mjs");
  writeFileSync(bin, `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(FAKE_CODEX).href)};\n`);
  chmodSync(bin, 0o700);
  return bin;
}
const FAKE_CODEX_BIN = fakeCodexBin();

/** 결정론적 codex thread id — 파서가 정규 UUID를 요구한다. */
const CODEX_TID = "0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";

/** `CODEX_HOME` → harness 세션 id. 자식 env가 유일한 상관 관계 표면이다(provider를 감싸지 않는다). */
const HOME_TO_SESSION = new Map<string, string>();

/** 시나리오에 미리 적어 두는 turn 수(초과 호출은 fixture가 마지막 run을 반복한다). */
const SCRIPTED_TURNS = 6;

interface TurnRecord {
  kind: "start" | "send";
  sessionId: string;
  text: string;
  cwd: string;
  /** 자식이 실제로 받은 argv — provider가 **봉인 spec**으로 컴파일한 결과다. */
  args: string[];
  /** 자식이 상속한 env key 전부. `["CODEX_HOME"]` 하나여야 한다. */
  envKeys: string[];
}

/** 한 invocation이 낼 codex JSONL + stderr + 프로세스 exit code. */
interface TurnOutput {
  lines: string[];
  exit?: number;
  stderr?: string;
}
type TurnScript = (turn: number) => TurnOutput;

interface RecordedCall {
  argv: string[];
  cwd: string;
  stdin: string;
  envKeys: string[];
  codexHome?: string;
}

/**
 * **production 생성 경로 그대로의** `CodexCliProvider`(spawn 미지정 = 진짜 `nodeSpawn`) +
 * cwd에 놓인 결정론적 시나리오. 세션 종료 관측은 내부 map 교체가 아니라 **공개 API 프로브**로 한다
 * (`sessionClosed`) — 증명된 인스턴스의 내부를 테스트가 만지지 않는다.
 */
class CodexHarness {
  readonly codex: CodexCliProvider;

  constructor(
    script: TurnScript,
    private readonly opts: { manifest: unknown; controllerRepoRoot: string; cwd: string; executablePath?: string },
  ) {
    writeFileSync(
      join(opts.cwd, ".fake-codex-scenario.json"),
      JSON.stringify({
        runs: Array.from({ length: SCRIPTED_TURNS }, (_, i) => {
          const out = script(i);
          return { lines: out.lines, exitCode: out.exit ?? 0, stderr: out.stderr ?? "" };
        }),
      }),
    );
    this.codex = new CodexCliProvider({
      manifest: opts.manifest,
      controllerRepoRoot: opts.controllerRepoRoot,
      executablePath: opts.executablePath ?? FAKE_CODEX_BIN,
      gitExecutablePath: TRUSTED_GIT,
      // **spawn을 주지 않는다** — 증명은 production executor일 때만 발급된다(3차 리뷰 A1).
    });
  }

  /** 자식이 실제로 받은 invocation 기록(프로세스가 뜨지 않았으면 빈 배열). */
  get turns(): TurnRecord[] {
    let calls: RecordedCall[];
    try {
      calls = JSON.parse(readFileSync(join(this.opts.cwd, ".fake-codex-invocation.json"), "utf8")).calls;
    } catch {
      return [];
    }
    return calls.map((c) => ({
      // resume subcommand가 붙은 invocation만 후속 `send`다(fresh는 `--ephemeral` 또는 그냥 `exec`).
      kind: c.argv.includes("resume") ? "send" : "start",
      sessionId: HOME_TO_SESSION.get(c.codexHome ?? "") ?? "(미상 세션)",
      text: c.stdin,
      cwd: c.cwd,
      args: c.argv,
      envKeys: c.envKeys,
    }));
  }
}

/**
 * **공개 API만으로** "provider가 그 세션을 닫았는가"를 본다(3차 리뷰 A1 — 증명된 인스턴스의 내부
 * 상태를 테스트가 갈아끼우지 않는다). 세션이 살아 있으면 같은 id의 `start`는 `codex_session_exists`이고,
 * 닫혔으면 프롬프트 계약 검사까지 내려가 `codex_prompt_invalid`가 된다. 어느 쪽도 프로세스를 띄우지 않는다.
 */
async function sessionClosed(codex: CodexCliProvider, sessionId: string, cwd: string): Promise<boolean> {
  try {
    await codex.start(readOnlySpec(sessionId, "probe", cwd), "");
    return false; // 빈 프롬프트는 항상 거부다 — 여기 오면 계약이 깨진 것이다
  } catch (e) {
    return e instanceof OrchestrationError && e.code === "codex_prompt_invalid";
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
  const home = freshHome();
  HOME_TO_SESSION.set(home, sessionId);
  if (over.codex?.codexHome) HOME_TO_SESSION.set(over.codex.codexHome, sessionId);
  return { sessionId, role, cwd, permissionMode: "plan", codex: { codexHome: home, ephemeral: false }, ...over };
}

/** provider가 첫 invocation에서 요구하는 **비어 있는 0700 격리 홈**. */
function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "m5b-home-")));
  cleanups.push(home);
  return home;
}

// ── 픽스처: root task 2개(자원 class 공유) + 의존 reviewer ────────────────────

interface Fixture {
  repo: { root: string; head: string };
  kernel: OrchestrationKernel;
  provider: CodexHarness;
  controller: StableController;
  handoffs: HandoffContext[];
  /**
   * controller에 넘긴 **호출자 소유 opts 객체**. 4차 리뷰 A1 이후 controller는 이 참조를 `#private`으로
   * 들고 tripwire로만 읽으므로, 드리프트 회귀는 (controller의 필드가 아니라) 이 객체를 바꿔서 시험한다 —
   * 그것이 호출자가 실제로 할 수 있는 유일한 조작이다.
   */
  opts: Record<string, unknown>;
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
  /**
   * codex 실행 파일을 **신뢰 조건 밖으로** 만들어 provider `start` 실패를 만든다(실행 비트 제거).
   * 임의 executor 주입 seam은 증명을 받지 못하므로(A1) 실패 주입도 production 경로로 한다.
   */
  breakExecutable?: boolean;
  /** kernel 자리에 끼울 대리자 — caller-supplied kernel seam 회귀용(A2). */
  wrapKernel?: (kernel: OrchestrationKernel) => OrchestrationKernel;
}

/**
 * 신뢰 조건을 깨뜨린 codex 실행 파일 사본. provider는 spawn 직전 신원 검사에서 거부한다
 * (`codex_executable_invalid`) → controller는 그것을 자기 taxonomy로 접는다.
 */
function brokenCodexBin(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5b-badbin-")));
  cleanups.push(dir);
  const bin = join(dir, "codex.mjs");
  writeFileSync(bin, "#!/bin/false\n");
  chmodSync(bin, 0o600); // 실행 비트 없음
  return bin;
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
  const provider = new CodexHarness(opts.script ?? (() => okTurn()), {
    manifest,
    controllerRepoRoot: repo.root,
    cwd: repo.root,
    executablePath: opts.breakExecutable ? brokenCodexBin() : undefined,
  });
  const handoffs: HandoffContext[] = [];
  const controllerOpts = {
    kernel: opts.wrapKernel ? opts.wrapKernel(kernel) : kernel,
    provider: provider.codex,
    controllerRepoRoot: repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: opts.nowMs ?? msClock(),
    handoff: (ctx: HandoffContext) => {
      handoffs.push(ctx);
      return opts.handoff
        ? opts.handoff(ctx, repo.root)
        : {
            spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, repo.root),
            prompt: `# ${ctx.task.title}\n${ctx.inputs.map((i) => `- ${i.path}@${i.revision}`).join("\n")}`,
          };
    },
  };
  const controller = new StableController(controllerOpts);
  return { repo, kernel, provider, controller, handoffs, opts: controllerOpts as unknown as Record<string, unknown> };
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
  for (const id of ["sess-task-a", "sess-task-b"]) {
    assert.equal(await sessionClosed(f.provider.codex, id, f.repo.root), true, `${id} 세션을 닫지 않았다`);
  }
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
  assert.equal(await sessionClosed(g.provider.codex, "sess-worker", g.repo.root), true, "세션을 닫지 않았다");
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
    cwd: repo.root,
    executablePath: over.breakExecutable ? brokenCodexBin() : undefined,
  });
  const handoffs: HandoffContext[] = [];
  const controllerOpts = {
    kernel: over.wrapKernel ? over.wrapKernel(kernel) : kernel,
    provider: provider.codex,
    controllerRepoRoot: repo.root,
    gitExecutablePath: TRUSTED_GIT,
    nowMs: over.nowMs ?? msClock(),
    handoff: (ctx: HandoffContext) => {
      handoffs.push(ctx);
      return over.handoff
        ? over.handoff(ctx, repo.root)
        : {
            spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, repo.root),
            prompt: `# ${ctx.task.title}`,
          };
    },
  };
  const controller = new StableController(controllerOpts);
  return { repo, kernel, provider, controller, handoffs, opts: controllerOpts as unknown as Record<string, unknown> };
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
  const revBefore = f.kernel.getState().revision;
  const origRoot = f.opts.controllerRepoRoot;
  f.opts.controllerRepoRoot = "/tmp";
  assert.deepEqual(await f.controller.advanceOnce(), { blocked: "controller_binding_drift", started: [], tasks: [] });
  f.opts.controllerRepoRoot = origRoot;
  const origGit = f.opts.gitExecutablePath;
  f.opts.gitExecutablePath = "/usr/bin/env";
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift");
  f.opts.gitExecutablePath = origGit;
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

  // 실행 파일이 신뢰 조건 밖이면 provider는 **spawn 0으로** `codex_executable_invalid`를 올리고,
  // controller는 그 native 코드를 **자기 taxonomy**로 접는다(A5b·A2 — provider 코드가 marker가 되지 않는다).
  const thrown = await fixture({ taskIds: ["task-a"], breakExecutable: true });
  assert.equal((await thrown.controller.advanceOnce()).tasks[0].marker, "provider_start_failed");
  assert.equal(thrown.kernel.getTask("task-a")!.state, "running");
  assert.equal(thrown.provider.turns.length, 0, "거부인데 자식 프로세스가 떴다");
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
  const m = f.opts;
  const revBefore = f.kernel.getState().revision;

  // 같은 run을 여는 **다른** kernel 객체 — 상태는 동일하지만 권위는 봉인된 그 객체뿐이다.
  const twin = OrchestrationKernel.open({ workspaceRoot: f.repo.root, runId: RUN_ID });
  const origKernel = m.kernel;
  m.kernel = twin;
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "같은 state의 다른 kernel을 받아들였다");
  m.kernel = origKernel;

  // 같은 `id`를 단 **다른 진짜 provider 객체**(증명을 통과하는 provider라도 봉인된 그것이 아니면 거부다).
  const origProvider = m.provider;
  m.provider = new CodexHarness(() => okTurn(), {
    manifest: manifestFor(f.repo.head, ["task-a"]),
    controllerRepoRoot: f.repo.root,
    cwd: f.repo.root,
  }).codex;
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "같은 id의 다른 provider를 받아들였다");
  m.provider = origProvider;

  // handoff 함수 교체.
  const origHandoff = m.handoff;
  m.handoff = () => ({ spec: readOnlySpec("x", "dev-lead", f.repo.root), prompt: "탈취" });
  assert.equal((await f.controller.advanceOnce()).blocked, "controller_binding_drift", "handoff 교체를 받아들였다");
  m.handoff = origHandoff;

  // **`opts` 참조 자체를 갈아끼우는 경로는 아예 없다**(4차 리뷰 A1): controller는 그것을 `#private`으로
  // 들고 있고 인스턴스는 얼어 있으므로 대입·`defineProperty`가 전부 던지고 tripwire 대상도 그대로다.
  assert.throws(() => {
    (f.controller as unknown as Record<string, unknown>).opts = { ...m };
  }, TypeError);
  assert.throws(() => Object.defineProperty(f.controller, "opts", { value: { ...m }, configurable: true }), TypeError);

  assert.equal(f.kernel.getState().revision, revBefore, "차단이 durable state를 바꿨다");
  assert.equal(f.provider.turns.length, 0, "차단인데 provider를 불렀다");
  assert.equal((await f.controller.advanceOnce()).blocked, null, "되돌린 뒤 정상 진행하지 않는다");
});

/** controller가 밖에 내놓는 API 전부(그 밖의 이름은 밖에서 읽히지 않아야 한다). */
const PUBLIC_API = ["advanceOnce", "usedTokens", "approvedManifest", "approvedCommit"];

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

test("[M5b] A1: 봉인된 kernel·provider는 메서드 monkey-patch 자체를 거부한다(그래도 진행은 정상)", async () => {
  // 4차 리뷰 A1·A2 이후 **양쪽 권위 객체가 얼어 있다** → 예전처럼 `k.completeTaskWithArtifacts = evil`이나
  // `defineProperty`로 갈아끼울 수 없다(패치 시도 자체가 TypeError). 드리프트 tripwire는 방어선으로
  // 그대로 남아 있고(객체 교체는 위 테스트가 잡는다), 여기서는 **패치 경로가 닫혔음**을 고정한다.
  const f = await fixture({ taskIds: ["task-a"] });
  const revBefore = f.kernel.getState().revision;
  const targets: Array<[string, Record<string, unknown>, string]> = [
    ["provider.start", f.opts.provider as Record<string, unknown>, "start"],
    ["provider.events", f.opts.provider as Record<string, unknown>, "events"],
    ["kernel.completeTaskWithArtifacts", f.opts.kernel as Record<string, unknown>, "completeTaskWithArtifacts"],
    ["kernel.scheduleReady", f.opts.kernel as Record<string, unknown>, "scheduleReady"],
  ];
  for (const [label, target, name] of targets) {
    assert.throws(
      () => {
        target[name] = () => {
          throw new Error("이 패치는 실행되면 안 된다");
        };
      },
      TypeError,
      `${label}: 대입이 통과했다`,
    );
    assert.throws(
      () => Object.defineProperty(target, name, { value: () => undefined, configurable: true }),
      TypeError,
      `${label}: defineProperty가 통과했다`,
    );
  }
  // 패치가 하나도 성립하지 않았으므로 정상 진행이고, durable state는 그 커밋만 늘어난다.
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  assert.ok(f.kernel.getState().revision > revBefore);
});

test("[M5b] A1: controller 권위·카운터는 밖에서 보이지도 바뀌지도 않는다(토큰 리셋 불가)", async () => {
  const f = await fixture({ manifest: { maxTokens: 5 }, taskIds: ["task-a", "task-b"] });
  // ⓐ own property 0 + freeze: 권위(`opts`/`sealed`/`pins`)와 카운터(`tokensUsed`)가 표면에 없다.
  assert.deepEqual(Object.getOwnPropertyNames(f.controller), [], "controller 권위가 own property로 노출됐다");
  assert.deepEqual(Object.getOwnPropertySymbols(f.controller), []);
  assert.equal(Object.isFrozen(f.controller), true, "controller 인스턴스가 얼지 않았다");
  assert.equal(Object.isFrozen(StableController.prototype), true, "controller prototype이 얼지 않았다");

  // ⓑ 권위·카운터·게이트 **후보 전부**에 대입과 defineProperty를 시도한다 — 전부 던진다.
  const candidates = [
    "opts",
    "sealed",
    "pins",
    "tokensUsed",
    "assertGatesOpen",
    "assertNoBindingDrift",
    "preflight",
    "now",
    "runTask",
    "syncGate",
    "verifyPointers",
    "verifyBoundary",
    "consumeTurn",
    "applyTurn",
    "requireTask",
    "advanceOnce",
    "usedTokens",
    "approvedManifest",
    "approvedCommit",
  ];
  for (const name of candidates) {
    assert.throws(
      () => {
        (f.controller as unknown as Record<string, unknown>)[name] = () => undefined;
      },
      TypeError,
      `${name} 대입이 통과했다`,
    );
    assert.throws(
      () => Object.defineProperty(f.controller, name, { value: () => undefined, configurable: true, writable: true }),
      TypeError,
      `${name} defineProperty가 통과했다`,
    );
    assert.equal((f.controller as unknown as Record<string, unknown>)[name] === undefined, !PUBLIC_API.includes(name), name);
  }

  // ⓒ 토큰 예산은 리셋할 수 없다: 소진된 뒤 어떤 조작으로도 다시 열리지 않는다.
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[1].marker, "budget_tokens_exhausted");
  assert.equal(f.controller.usedTokens(), 5);
  for (const name of ["tokensUsed", "usedTokens", "sealed"]) {
    try {
      (f.controller as unknown as Record<string, unknown>)[name] = name === "usedTokens" ? () => 0 : 0;
    } catch {
      /* 얼어 있으므로 던지는 것이 정상 */
    }
  }
  assert.equal(f.controller.usedTokens(), 5, "토큰 카운터가 리셋됐다");
  assert.equal((await f.controller.advanceOnce()).blocked, "budget_tokens_exhausted", "소진 뒤 advance가 다시 열렸다");
});

test("[M5b] A1: 재진입 시계는 봉인된 kernel 메서드를 갈아끼울 수 없다(진행은 정상)", async () => {
  // 시계는 **봉인 대조를 지난 뒤에** 불린다(`assertGatesOpen`: 드리프트 → clock → 만료·예산). 이전 판의
  // `scheduleReady`/`startScheduledBatch`는 호출 시점에 caller 소유 property를 **다시 읽는** wrapper였으므로
  // 재진입 시계가 그 창에서 갈아끼운 함수가 그대로 실행됐다. 지금은 ⓐ 포착한 함수만 실행되고
  // ⓑ kernel 자체가 얼어 있어 **패치 시도가 성립하지 않는다**(4차 리뷰 A2).
  let patched = 0;
  let refused = 0;
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
        for (const name of ["scheduleReady", "startScheduledBatch"]) {
          try {
            definePatch(holder.kernel, name, evil);
          } catch {
            refused++;
          }
        }
      }
      return base();
    },
  });
  holder.kernel = f.kernel as unknown as Record<string, unknown>;
  armed = true;
  const out = await f.controller.advanceOnce();

  assert.equal(refused, 2, "봉인된 kernel에 패치가 성립했다(회귀가 공허하다)");
  assert.equal(patched, 0, "갈아끼운 kernel 메서드가 실행됐다");
  assert.deepEqual(out.started, ["task-a", "task-b"]);
  assert.deepEqual(
    out.tasks.map((t) => [t.taskId, t.status]),
    [
      ["task-a", "completed"],
      ["task-b", "completed"],
    ],
  );
});

test("[M5b] A1/A2: 교대 getter를 단 kernel은 '권위'가 되지 못한다(생성 자체 거부)", async () => {
  // 이전 판은 `typeof k[m] === "function"`으로 검사한 **뒤** `k.m.bind(k)`로 다시 읽었으므로, 교대
  // getter가 검사에는 진짜를 실행에는 공격자 함수를 줄 수 있었다. 그 다음 판은 한 번만 읽어 그 값을
  // 실행했다. 지금은 그런 객체가 **진짜 kernel이 아니므로**(own property 0 · prototype 메서드 동일성)
  // controller 생성 자체가 거부된다 — 봉인된 진짜 kernel에는 getter를 달 수도 없다(frozen).
  const f = await fixture({ taskIds: ["task-a"] });
  const real = f.kernel as unknown as Record<string, unknown>;
  assert.throws(
    () =>
      Object.defineProperty(real, "scheduleReady", {
        configurable: true,
        get: () => real.scheduleReady,
      }),
    TypeError,
    "봉인된 kernel에 교대 getter를 달 수 있었다",
  );

  let evilCalls = 0;
  const alternating = Object.create(Object.getPrototypeOf(f.kernel) as object) as Record<string, unknown>;
  let reads = 0;
  Object.defineProperty(alternating, "scheduleReady", {
    configurable: true,
    enumerable: true,
    get: () => (reads++ === 0 ? () => f.kernel.scheduleReady() : () => (evilCalls++, [])),
  });
  for (const m of ["getState", "getManifest", "getTask", "startScheduledBatch", "listPendingInbox", "completeTaskWithArtifacts", "acknowledgeDelivery"]) {
    Object.defineProperty(alternating, m, {
      configurable: true,
      enumerable: true,
      value: (...a: unknown[]) => (f.kernel as unknown as Record<string, (...x: unknown[]) => unknown>)[m](...a),
    });
  }
  Object.defineProperty(alternating, "paths", { configurable: true, enumerable: true, value: f.kernel.paths });

  assert.equal(
    await controllerKernelGateCode(alternating as unknown as OrchestrationKernel, f.repo, f.provider.codex),
    "controller_kernel_not_genuine",
  );
  assert.equal(evilCalls, 0, "위조 kernel의 두 번째 읽기 값이 실행됐다");
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
 * A2(4차) 회귀 공용 러너 — **kernel 후보** 하나를 controller 생성자에 넣고 코드를 돌려준다.
 * 통과하면 `"(생성됨)"`이다(그 경우가 하나라도 나오면 위조 완료 권위가 다시 열린 것이다).
 */
async function controllerKernelGateCode(
  kernel: OrchestrationKernel,
  repo: { root: string; head: string },
  provider: ExecutionProvider,
): Promise<string> {
  try {
    new StableController({
      kernel,
      provider,
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

/**
 * **production 생성 경로 그대로의** provider — `spawn`을 주지 않으므로 executor는 진짜
 * `node:child_process.spawn`이고 증명을 받는다. 아래 테스트들은 이 인스턴스를 **세션을 열지 않고**
 * controller 생성자에만 넣는다.
 */
function genuineCodex(repoRoot = "/"): CodexCliProvider {
  return new CodexCliProvider({
    manifest: {},
    controllerRepoRoot: repoRoot,
    executablePath: FAKE_CODEX_BIN,
    gitExecutablePath: TRUSTED_GIT,
  });
}

/** 임의 executor를 주입한 provider — 생성자를 지나지만 **증명 대상이 아니다**(3차 리뷰 A1). */
function customSpawnCodex(): CodexCliProvider {
  return new CodexCliProvider({
    manifest: {},
    controllerRepoRoot: "/",
    executablePath: FAKE_CODEX_BIN,
    gitExecutablePath: TRUSTED_GIT,
    spawn: (() => {
      throw new Error("이 provider는 증명을 받지 못한다");
    }) as unknown as SpawnFn,
  });
}

test("[M5b] A1: 임의 executor를 주입한 인스턴스는 증명을 받지 못한다(사후 필드 덮어쓰기도 무효)", async () => {
  // ⓐ `opts.spawn`을 준 인스턴스는 생성자를 지나도 read-only bridge에 들어오지 못한다.
  //    (이전 판은 `opts.spawn ?? nodeSpawn`을 포착한 **모든** 인스턴스를 증명 등록부에 넣었으므로,
  //     argv·env를 무시하고 임의 쓰기·명령·네트워크를 하는 callback이 그대로 통과했다.)
  assert.equal(attestReadOnlyCodexProvider(customSpawnCodex()), null, "custom spawn 인스턴스가 증명됐다");
  assert.equal(await controllerGateCode(customSpawnCodex()), "controller_provider_not_read_only");

  // ⓑ production 인스턴스는 증명을 받고 controller 생성도 통과한다(음성 대조군이 아니라 **양성** 대조군).
  assert.notEqual(attestReadOnlyCodexProvider(genuineCodex()), null, "production 인스턴스가 증명을 못 받았다");
  assert.equal(await controllerGateCode(genuineCodex()), "(생성됨)");

  // ⓒ 생성 뒤에는 **어떤 필드도 덧붙일 수 없다**(4차 리뷰 A1 — 인스턴스가 얼어 있다).
  //   executor·세션·설정·`id`가 전부 `#private`/prototype이므로 own property는 0이어야 한다.
  const patched = genuineCodex();
  assert.deepEqual(
    [...Object.getOwnPropertyNames(patched), ...Object.getOwnPropertySymbols(patched)],
    [],
    "provider 상태·설정이 public own property로 노출됐다(대입·defineProperty 통로)",
  );
  assert.equal(Object.isFrozen(patched), true, "provider 인스턴스가 얼지 않았다");
  for (const name of ["spawn", "spawnFn", "opts", "id", "sessions"]) {
    assert.throws(
      () => {
        (patched as unknown as Record<string, unknown>)[name] = () => undefined;
      },
      TypeError,
      `${name} 대입이 통과했다`,
    );
    assert.throws(
      () => Object.defineProperty(patched, name, { value: () => undefined, configurable: true }),
      TypeError,
      `${name} defineProperty가 통과했다`,
    );
  }
  assert.equal(patched.id, "codex-cli", "id가 prototype 상수가 아니다");
  assert.notEqual(attestReadOnlyCodexProvider(patched), null, "거부된 덮어쓰기 시도가 증명을 깨뜨렸다");
  assert.equal(await controllerGateCode(patched), "(생성됨)");

  // ⓓ 함수가 아닌 spawn은 생성 자체가 거부다.
  assert.throws(
    () =>
      new CodexCliProvider({
        manifest: {},
        controllerRepoRoot: "/",
        executablePath: FAKE_CODEX_BIN,
        gitExecutablePath: TRUSTED_GIT,
        spawn: 1 as unknown as SpawnFn,
      }),
    /codex_config_invalid/,
  );
});

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
  // `id`는 prototype getter다(A1) — setter가 없으므로 대입이 아니라 own property로 심어야 한다.
  Object.defineProperty(spoofedProto, "id", { value: "codex-cli", enumerable: true, configurable: true });
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
  // **production 인자 그대로**(spawn 주입 없음)여도 거부여야 한다 — 거부 근거는 executor가 아니라 subclass다.
  const subOpts = { manifest: {}, controllerRepoRoot: "/", executablePath: FAKE_CODEX_BIN, gitExecutablePath: TRUSTED_GIT };
  const sub = new EvilSubclass(subOpts);
  assert.equal(await controllerGateCode(sub), "controller_provider_not_read_only", "subclass가 통과했다");

  // ⓓ' 아무것도 override하지 않은 subclass도 거부다 — 증명 대상은 "이 구현"이지 "이 구현의 자손"이 아니다
  //     (자손은 다른 메서드·getter·필드로 계약을 얼마든지 바꿀 수 있고, 그 표면을 여기서 추적하지 않는다).
  class PlainSubclass extends CodexCliProvider {}
  const plain = new PlainSubclass(subOpts);
  assert.equal(await controllerGateCode(plain), "controller_provider_not_read_only", "override 없는 subclass가 통과했다");

  // ⓔ 인스턴스 메서드 override. **4차 리뷰 A1 이후 인스턴스가 얼어 있어 두 경로 모두 던진다** —
  //    대입도, `defineProperty`도 own property를 만들지 못한다. 그래도 방어선(함수 신원 대조 +
  //    own property 0 검사)은 남기고, 그 판정 자체는 **subclass 인스턴스**(얼리지 않은 표면)로 시험한다.
  for (const m of ["start", "send", "events", "stop"] as const) {
    const frozen = genuineCodex();
    assert.throws(() => {
      (frozen as unknown as Record<string, unknown>)[m] = () => undefined;
    }, TypeError);
    assert.throws(() => definePatch(frozen as unknown as Record<string, unknown>, m, () => undefined), TypeError);
    assert.notEqual(attestReadOnlyCodexProvider(frozen), null, `${m}: 거부된 override 시도가 증명을 깨뜨렸다`);

    // own property가 하나라도 있으면(= 여기서는 override) 증명은 `null`이다.
    const overridden = Object.create(CodexCliProvider.prototype) as Record<string, unknown>;
    definePatch(overridden, m, () => undefined);
    assert.equal(await controllerGateCode(overridden), "controller_provider_not_read_only", `${m} override가 통과했다`);
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

test("[M5b] A2: production 경로 — 진짜 자식 프로세스로 controller가 그대로 전진한다", async () => {
  // live codex/claude 추론·네트워크·인증 0. **실제 OS 자식 프로세스**가 뜨고, provider 생성·증명·봉인·
  // 경계·argv·env·stdin·파서 배선이 전부 production 경로다(3차 리뷰 A1 — 주입 executor 없음).
  const f = await fixture({ taskIds: ["task-a"] });
  assert.notEqual(attestReadOnlyCodexProvider(f.provider.codex), null, "증명된 production provider가 아니다");
  const out = await f.controller.advanceOnce();
  assert.equal(out.tasks[0].status, "completed", out.tasks[0].marker);
  const turn = f.provider.turns[0];
  assert.equal(turn.args[0], "exec");
  assert.deepEqual([turn.args.includes("--sandbox"), turn.args[turn.args.indexOf("--sandbox") + 1]], [true, "read-only"]);
  assert.ok(turn.text.includes("task-a 제목"), "프롬프트가 stdin으로 가지 않았다");
  // provider가 **넘기는** env가 정확히 `{CODEX_HOME}` 하나라는 것은 provider 테스트가 고정한다.
  // 여기서 보는 것은 자식이 **실제로 본** env이고, OS/libc가 자기 키를 더할 수 있으므로
  // (macOS의 `__CF_USER_TEXT_ENCODING`) 부재를 단정할 대상만 명시한다.
  assert.ok(turn.envKeys.includes("CODEX_HOME"), "CODEX_HOME이 자식에게 가지 않았다");
  for (const leaked of ["PATH", "HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"]) {
    assert.ok(!turn.envKeys.includes(leaked), `${leaked}가 자식에게 상속됐다`);
  }
  assert.equal(turn.cwd, f.repo.root, "경계가 확인한 targetRoot가 아닌 cwd로 떴다");
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

// ── 11b. A3(3차): 산출물 등록과 완료는 kernel의 한 트랜잭션이다 ────────────────

test("[M5b] A3: multi-output 성공 — 순서·포인터가 정확하고 완료 커밋은 하나다", async () => {
  const outs = ["src/task-a/one.md", "src/task-a/two.md", "src/task-a/three.md"];
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => ({
      spec: readOnlySpec("s", ctx.task.roleId, root),
      prompt: "p",
      outputs: outs.map((p) => ({ path: p, role: "output" as const })),
    }),
  });
  for (const p of outs) writeArtifact(f.repo.root, p, `# ${p}\n`);
  const before = f.kernel.getState().revision;
  const a = (await f.controller.advanceOnce()).tasks[0];

  assert.equal(a.status, "completed", a.marker);
  assert.deepEqual(a.artifacts, outs.map((p) => `${p}@1`), "등록 순서가 handoff 순서와 다르다");
  assert.deepEqual(f.kernel.getTask("task-a")!.artifactRefs.map((r) => r.path), outs);
  // batch 시작 커밋 1 + 완료 트랜잭션 1 = 2. 산출물마다 커밋하면 이 수가 커진다.
  assert.equal(f.kernel.getState().revision, before + 2, "완료가 한 커밋이 아니다");
});

test("[M5b] A3: 뒤쪽 산출물이 실패하면 앞쪽 artifact도 durable에 남지 않는다", async () => {
  const cases: Array<[string, Array<{ path: string; role: "output" }>, string]> = [
    [
      "두 번째가 없다",
      [
        { path: "src/task-a/ok.md", role: "output" },
        { path: "src/task-a/gone.md", role: "output" },
      ],
      "artifact_missing",
    ],
    [
      "두 번째가 남의 소유다",
      [
        { path: "src/task-a/ok.md", role: "output" },
        { path: "src/task-b/steal.md", role: "output" },
      ],
      "artifact_not_owned",
    ],
    [
      "경로 중복",
      [
        { path: "src/task-a/ok.md", role: "output" },
        { path: "src/task-a/ok.md", role: "output" },
      ],
      "artifact_path_duplicate",
    ],
  ];
  for (const [label, outputs, want] of cases) {
    const f = await fixture({
      taskIds: ["task-a", "task-b"],
      handoff: (ctx, root) => ({
        spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, root),
        prompt: "p",
        outputs: ctx.task.taskId === "task-a" ? outputs : [],
      }),
    });
    writeArtifact(f.repo.root, "src/task-a/ok.md", "앞쪽 산출물\n");
    writeArtifact(f.repo.root, "src/task-b/steal.md", "남의 것\n");
    const out = await f.controller.advanceOnce();
    const a = out.tasks.find((t) => t.taskId === "task-a")!;
    assert.deepEqual([a.status, a.marker], ["failed", want], label);
    assert.deepEqual(a.artifacts, [], `${label}: 실패인데 artifact를 보고했다`);
    assert.equal(f.kernel.getTask("task-a")!.state, "running", `${label}: 실패인데 완료로 만들었다`);
    assert.equal(f.kernel.getMessage("res.task-a"), null, `${label}: 실패인데 result가 남았다`);
    assert.deepEqual(
      f.kernel.getState().artifacts.filter((x) => x.producerTaskId === "task-a"),
      [],
      `${label}: 앞쪽 artifact가 durable에 남았다(부분 적용)`,
    );
  }
});

test("[M5b] A3: 산출물 상한을 넘는 handoff는 등록 0 · 완료 0이다", async () => {
  const many = Array.from({ length: LIMITS.maxArtifactRefs + 1 }, (_, i) => ({
    path: `src/task-a/n${i}.md`,
    role: "output" as const,
  }));
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => ({ spec: readOnlySpec("s", ctx.task.roleId, root), prompt: "p", outputs: many }),
  });
  for (const o of many) writeArtifact(f.repo.root, o.path, "x\n");
  const a = (await f.controller.advanceOnce()).tasks[0];
  assert.deepEqual([a.status, a.marker], ["failed", "artifact_refs_too_many"]);
  assert.deepEqual(f.kernel.getState().artifacts, []);
  assert.equal(f.kernel.getTask("task-a")!.state, "running");
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
  // handoff에서 arm → 이후 clock ①=start 경계 진입 ②=start 동기 게이트 ③=start revalidate
  // ④=start turn의 applyTurn ⑤=**전달 경계 진입**(여기서 변조) → git 비동기 조회 → 동기 게이트의
  // 포인터 재검증이 잡아야 한다. 전달 직전의 1차 `verifyPointers`는 ⑤ **전에** 원본 hash로 통과한다.
  const seam = armedClock(() => {
    if (root) writeArtifact(root, "src/producer/out.md", "# send 창에서 바뀐 산출물\n");
  }, 5);
  const g = await fixtureWithDelivery({
    nowMs: seam.clock,
    handoff: (ctx, r) => {
      root = r;
      seam.arm();
      return { spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, r), prompt: "p" };
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
    await consumeExactlyOneTerminal(
      stream,
      CONTROLLER_TERMINAL_CODES,
      MAX_TURN_EVENTS,
      (code, message) => new ControllerError(code, message),
      onTerminal as never,
    );
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

test("[M5b] B: 종료 뒤 실패로 닫혀도 **첫 종료의 usage는 회계된다**", async () => {
  // 3차 독립 리뷰 B: 이전 판은 종료 결과를 본 뒤 스트림이 끝날 때까지 회계를 미뤘으므로,
  // 늦은 이벤트·두 번째 종료·iterator throw로 닫히는 경로에서 **이미 태운 토큰이 예산에서 빠지지 않았다**.
  // (현재 genuine Codex 파서는 이 스트림을 만들지 않는다 — 두 번째 provider·retry 배선 전 방어다.)
  const late: SessionEvent = { kind: "assistant", sessionId: "s", text: "늦음", toolUses: [], stopReason: null, raw: RESULT_RAW };
  const cases: Array<[string, SessionEvent[], string]> = [
    ["종료 뒤 늦은 이벤트", [resultEvent(false, "완료"), late], "provider_duplicate_terminal"],
    ["두 번째 종료", [resultEvent(false, "완료"), resultEvent(false, "또")], "provider_duplicate_terminal"],
    ["실패 종료", [resultEvent(true, "")], "provider_result_error"],
  ];
  for (const [label, events, want] of cases) {
    const accounted: number[] = [];
    const code = await consumeAsController(events, (r) => accounted.push((r as { usage: SessionUsage }).usage.inputTokens));
    assert.equal(code, want, label);
    assert.deepEqual(accounted, [USAGE.inputTokens], `${label}: 첫 종료의 usage가 회계되지 않았다`);
  }

  // iterator가 종료 **뒤에** 던지는 경우도 같다.
  const accounted: number[] = [];
  const throwing = (async function* (): AsyncGenerator<SessionEvent> {
    yield resultEvent(false, "완료");
    throw new Error("종료 뒤 폭발");
  })();
  await assert.rejects(
    consumeExactlyOneTerminal(
      throwing,
      CONTROLLER_TERMINAL_CODES,
      MAX_TURN_EVENTS,
      (code, message) => new ControllerError(code, message),
      (r) => accounted.push(r.usage.inputTokens),
    ),
    /provider_stream_failed/,
  );
  assert.deepEqual(accounted, [USAGE.inputTokens], "종료 뒤 iterator throw에서 usage가 사라졌다");

  // 회계 콜백이 던지면(예산 소진) **그 오류가 그대로** 올라온다 — streamFailed로 접히지 않는다.
  await assert.rejects(
    consumeExactlyOneTerminal(
      (async function* (): AsyncGenerator<SessionEvent> {
        yield resultEvent(false, "완료");
      })(),
      CONTROLLER_TERMINAL_CODES,
      MAX_TURN_EVENTS,
      (code, message) => new ControllerError(code, message),
      () => {
        throw new ControllerError("budget_tokens_exhausted", "예산 소진");
      },
    ),
    /budget_tokens_exhausted/,
  );
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
    await consumeExactlyOneTerminal(
      stream,
      CONTROLLER_TERMINAL_CODES,
      MAX_TURN_EVENTS,
      (code, message) => new ControllerError(code, message),
    );
    return "(수락됨)";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `(${String(e)})`;
  }
}

/**
 * 진짜 kernel에 위임하되 지정 메서드만 갈아끼운 **호출자 소유 kernel**.
 *
 * **4차 리뷰 A2 이후 이것은 controller 권위가 되지 못한다** — 아래 회귀들은 이 seam이 성공/실패
 * 경계에 들어오는 것이 아니라 **생성 자체에서 거부됨**을 고정한다. production 성공 권위는 진짜
 * `OrchestrationKernel`만이고, 그 증명은 `orchestrationKernel.ts`의 모듈 사설 등록부가 발급한다.
 */
function delegateKernel(k: OrchestrationKernel, over: Partial<Record<string, unknown>>): OrchestrationKernel {
  const fake = Object.create(Object.getPrototypeOf(k) as object) as Record<string, unknown>;
  const own: Record<string, unknown> = {
    paths: k.paths,
    getState: () => k.getState(),
    getManifest: () => k.getManifest(),
    getTask: (id: string) => k.getTask(id),
    scheduleReady: () => k.scheduleReady(),
    startScheduledBatch: () => k.startScheduledBatch(),
    listPendingInbox: (id: string) => k.listPendingInbox(id),
    acknowledgeDelivery: (i: { taskId: string; messageId: string }) => k.acknowledgeDelivery(i),
    completeTaskWithArtifacts: (i: Parameters<OrchestrationKernel["completeTaskWithArtifacts"]>[0]) =>
      k.completeTaskWithArtifacts(i),
    ...over,
  };
  for (const [name, value] of Object.entries(own)) {
    Object.defineProperty(fake, name, { value, enumerable: true, configurable: true });
  }
  return fake as unknown as OrchestrationKernel;
}

/** 경계 밖이 던질 수 있는 값 전수 — 진짜 클래스·코드 있는 객체·원시값·null까지. */
const HOSTILE_THROWS: unknown[] = [
  new OrchestrationError("result_accepted", "탈취"),
  new ControllerError("result_accepted", "같은 타입을 흉내낸다"),
  Object.assign(new Error("탈취"), { code: "result_accepted" }),
  Object.assign(new Error("탈취"), { code: "budget_tokens_exhausted" }),
  { code: "result_accepted" },
  "result_accepted",
  null,
];

test("[M5b] A5b: provider iterator가 임의 코드를 달아도 결과 코드가 되지 못한다", async () => {
  // 이전 판은 "문자열 `code`를 가진 Error"면 무엇이든 그대로 통과시켰다 →
  // provider가 `result_accepted`를 달고 던지면 **성공처럼 보이는 marker를 단 실패**가 만들어졌다.
  for (const err of HOSTILE_THROWS) {
    assert.equal(await consumeThrowing(err), "provider_stream_failed", `${String((err as { code?: string })?.code ?? err)}가 새어나갔다`);
  }
});

test("[M5b] A2: handoff가 던진 값은 실제 클래스와 무관하게 handoff_failed로 접힌다", async () => {
  // **공개 `ControllerError`가 provenance가 아니다**(3차 리뷰 A2): 이전 판은 `instanceof ControllerError`를
  // 내부 오류로 보존했으므로 handoff가 `new ControllerError("result_accepted", …)`를 던지는 것만으로
  // `status:"failed"` + `marker:"result_accepted"`를 만들 수 있었다.
  for (const err of HOSTILE_THROWS) {
    const h = await fixture({
      taskIds: ["task-a"],
      handoff: () => {
        throw err;
      },
    });
    const a = (await h.controller.advanceOnce()).tasks[0];
    assert.deepEqual([a.status, a.marker], ["failed", "handoff_failed"], String((err as { code?: string })?.code ?? err));
    assert.equal(h.kernel.getTask("task-a")!.state, "running");
    assert.equal(h.kernel.getMessage("res.task-a"), null);
    assert.equal(h.provider.turns.length, 0, "거부인데 자식 프로세스가 떴다");
  }
});

test("[M5b] A2: 호출자 시계가 던진 임의 코드도 marker가 되지 못한다", async () => {
  // `opts.nowMs`는 호출자 콜백이다 — 이전 판은 그 오류가 `codeOf`를 그대로 지나 marker가 됐다.
  for (const err of HOSTILE_THROWS) {
    const base = msClock();
    let n = 0;
    const f = await fixture({
      taskIds: ["task-a"],
      nowMs: () => {
        if (++n > 2) throw err; // 생성·preflight는 지나고 실행 게이트에서 던진다
        return base();
      },
    });
    const a = (await f.controller.advanceOnce()).tasks[0];
    assert.deepEqual(
      [a.status, a.marker],
      ["failed", "controller_clock_unreadable"],
      String((err as { code?: string })?.code ?? err),
    );
    assert.equal(f.provider.turns.length, 0, "시계가 던졌는데 자식 프로세스가 떴다");
  }
});

/** controller가 kernel(SoR)에 대고 부르는 좁은 API 전부. */
const KERNEL_API = [
  "getState",
  "getManifest",
  "getTask",
  "scheduleReady",
  "startScheduledBatch",
  "listPendingInbox",
  "completeTaskWithArtifacts",
  "acknowledgeDelivery",
];

test("[M5b] A2(4차): 위조 완료 권위는 controller 생성에서 거부된다 — 성공을 만들 수 없다", async () => {
  const f = await fixture({ taskIds: ["task-a"] });
  const real = f.kernel;
  const provider = f.provider.codex;
  const proto = Object.getPrototypeOf(real) as Record<string, unknown>;

  // ⓐ **A2의 핵심**: 스케줄링은 진짜에 위임하고 완료만 그럴듯하게 위조하는 delegate.
  //   이전 판은 이것을 받아들여 디스크 변화 0으로 `completed`/`result_accepted`를 발급했다.
  let fakeCompletions = 0;
  const forged = delegateKernel(real, {
    completeTaskWithArtifacts: () => {
      fakeCompletions++;
      return {
        task: { ...real.getTask("task-a")!, state: "completed" as const, resultSummary: "위조" },
        artifacts: [{ path: "src/task-a/x.md", sha256: "0".repeat(64), revision: 1, producerTaskId: "task-a", role: "output" as const }],
      };
    },
  });
  assert.equal(await controllerKernelGateCode(forged, f.repo, provider), "controller_kernel_not_genuine", "위조 완료 권위가 통과했다");
  assert.equal(fakeCompletions, 0, "위조 완료가 한 번이라도 불렸다");

  // ⓑ 평범한 구조적 객체(메서드 모양 + paths.workspaceRoot만 맞춘 것).
  const structural: Record<string, unknown> = { paths: real.paths };
  for (const m of ["getState", "getManifest", "getTask", "scheduleReady", "startScheduledBatch", "listPendingInbox", "completeTaskWithArtifacts", "acknowledgeDelivery"]) {
    structural[m] = (...a: unknown[]) => (real as unknown as Record<string, (...x: unknown[]) => unknown>)[m](...a);
  }
  assert.equal(
    await controllerKernelGateCode(structural as unknown as OrchestrationKernel, f.repo, provider),
    "controller_kernel_not_genuine",
    "구조적 객체가 통과했다",
  );

  // ⓒ Proxy wrapper · subclass · prototype 위조 · 메서드 복사본.
  assert.equal(await controllerKernelGateCode(new Proxy(real, {}), f.repo, provider), "controller_kernel_not_genuine", "Proxy가 통과했다");
  const copied: Record<string, unknown> = { paths: real.paths };
  for (const m of KERNEL_API) copied[m] = proto[m];
  assert.equal(
    await controllerKernelGateCode(copied as unknown as OrchestrationKernel, f.repo, provider),
    "controller_kernel_not_genuine",
    "메서드 복사본이 통과했다",
  );
  assert.equal(
    await controllerKernelGateCode(Object.create(proto) as OrchestrationKernel, f.repo, provider),
    "controller_kernel_not_genuine",
    "prototype 위조가 통과했다",
  );
  // ⓓ 진짜 kernel은 통과한다(양성 대조군 — 게이트가 전부를 막는 것이 아니다).
  const fresh = await fixture({ taskIds: ["task-a"] });
  assert.equal(await controllerKernelGateCode(fresh.kernel, fresh.repo, fresh.provider.codex), "(생성됨)");
});

test("[M5b] A2(4차): 성공은 durable SoR 변화를 동반하고 새 kernel로 reopen하면 completed다", async () => {
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => ({
      spec: readOnlySpec("s", ctx.task.roleId, root),
      prompt: "p",
      outputs: [{ path: "src/task-a/out.md", role: "output" as const }],
    }),
  });
  writeArtifact(f.repo.root, "src/task-a/out.md", "# 산출물\n");
  const paths = runPaths(f.repo.root, RUN_ID);
  const before = {
    rev: f.kernel.getState().revision,
    events: readFileSync(paths.eventsFile, "utf8").split("\n").filter((l) => l.length > 0).length,
    bodies: readdirSync(paths.messagesDir).length,
  };

  const a = (await f.controller.advanceOnce()).tasks[0];
  assert.deepEqual([a.status, a.marker], ["completed", "result_accepted"]);

  // ⓐ 디스크가 실제로 움직였다: revision · event tail · result body · artifact record · state 파일.
  const after = f.kernel.getState();
  assert.ok(after.revision > before.rev, "성공인데 revision이 그대로다");
  assert.ok(readFileSync(paths.eventsFile, "utf8").split("\n").filter((l) => l.length > 0).length > before.events, "event가 append되지 않았다");
  assert.ok(readdirSync(paths.messagesDir).length > before.bodies, "result body가 디스크에 없다");
  assert.deepEqual(after.artifacts.map((x) => x.artifactId), ["src/task-a/out.md@1"]);
  assert.ok(readFileSync(paths.stateFile, "utf8").includes("result_accepted") === false, "state에 marker 문자열을 넣지 않는다");
  assert.ok(readFileSync(paths.snapshotFile, "utf8").includes("src/task-a/out.md@1"), "snapshot이 갱신되지 않았다");
  assert.equal(existsSync(paths.journalFile), false, "커밋 journal이 남았다");

  // ⓑ **새 genuine kernel로 reopen**하면 completed이고 포인터가 그대로다(fail-closed load를 지난다).
  const reopened = openOrchestrationRun({ workspaceRoot: f.repo.root, runId: RUN_ID });
  const task = reopened.getTask("task-a")!;
  assert.equal(task.state, "completed");
  assert.deepEqual(
    task.artifactRefs.map((r: { path: string; revision: number }) => `${r.path}@${r.revision}`),
    ["src/task-a/out.md@1"],
  );
  assert.equal(reopened.getMessage("res.task-a")!.summary, "[task-a] turns=1 acked=0");
});

test("[M5b] A2: 호출자 kernel(SoR)의 닫힌 집합 밖 코드는 kernel_rejected로 접힌다", async () => {
  // kernel은 **호출자가 주는 객체**다. 이제 진짜 kernel만 받으므로 임의 코드를 던지는 kernel은 넣을 수
  // 없고, 남는 것은 **진짜 kernel이 실제로 낼 수 있는** 코드다. 닫힌 집합 안(`artifact_not_owned`)은
  // 그대로 올라오고(위 소유권 테스트), 밖(`run_lock_held`)은 `kernel_rejected`로 접힌다.
  const f = await fixture({
    taskIds: ["task-a"],
    handoff: (ctx, root) => {
      // handoff는 batch 시작 커밋 **뒤**, 완료 커밋 **앞**이다 → 여기서 lock을 잡아 두면 완료 커밋이
      // `run_lock_held`(닫힌 집합 밖)로 거부된다.
      writeFileSync(runPaths(root, RUN_ID).lockFile, "다른 writer\n");
      return { spec: readOnlySpec("s", ctx.task.roleId, root), prompt: "p" };
    },
  });
  const a = (await f.controller.advanceOnce()).tasks[0];
  assert.deepEqual([a.status, a.marker], ["failed", "kernel_rejected"], "kernel native 코드가 그대로 새어나갔다");
  rmSync(runPaths(f.repo.root, RUN_ID).lockFile, { force: true });
  assert.equal(openOrchestrationRun({ workspaceRoot: f.repo.root, runId: RUN_ID }).getTask("task-a")!.state, "running");
});

test("[M5b] C: inbox 항목은 **한 번만 읽고** 그 사본으로 전달한다", async () => {
  // 3차 독립 리뷰 C: 이전 판은 검증한 `refs`와 별개로 `deliveryPrompt(entry)`가 **원본 alias를 다시**
  // 읽었다. 지금은 읽는 즉시 봉인 사본을 만든다. 진짜 kernel은 깊은 사본을 주므로 적대적 getter를
  // 끼울 표면이 없고(그 자체가 A2의 결과다), 여기서는 전달 내용이 **durable state의 값**임을 고정한다.
  const g = await fixtureWithDelivery();
  await g.controller.advanceOnce();
  const send = g.provider.turns.find((t) => t.kind === "send")!;
  const entry = g.kernel.getMessage("su-1")!;
  assert.ok(send.text.includes(entry.summary!), "durable summary가 전달되지 않았다");
  for (const ref of entry.artifactRefs) assert.ok(send.text.includes(`${ref.path}@${ref.revision}`), "검증된 포인터가 빠졌다");
  // 교대 getter를 심을 수 있는 유일한 경로(위조 kernel)는 생성 자체가 거부된다.
  const forged = delegateKernel(g.kernel, { listPendingInbox: () => [] });
  assert.equal(await controllerKernelGateCode(forged, g.repo, g.provider.codex), "controller_kernel_not_genuine");
});

test("[M5b] A2: provider start·send의 native 코드도 controller taxonomy로 접힌다", async () => {
  // 증명 규칙 때문에 controller에 "임의 코드를 던지는 provider"를 넣을 수는 없다(A1). 남는 것은
  // **진짜 provider가 내는 native 코드**이고, 그것도 marker가 되지 못한다는 것을 고정한다.
  const s = await fixture({ taskIds: ["task-a"], breakExecutable: true });
  const b = (await s.controller.advanceOnce()).tasks[0];
  assert.deepEqual([b.status, b.marker], ["failed", "provider_start_failed"], "provider native 코드가 새어나갔다");

  // `send` 경계: ephemeral 세션은 resume할 수 없다(`codex_resume_unavailable`) → 전달 turn이 그 자리에서 실패한다.
  const g = await fixtureWithDelivery({
    handoff: (ctx, root) => ({
      spec: readOnlySpec(`sess-${ctx.task.taskId}`, ctx.task.roleId, root, { codex: { codexHome: freshHome(), ephemeral: true } }),
      prompt: "p",
    }),
  });
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
