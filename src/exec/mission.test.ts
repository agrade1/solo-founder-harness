/**
 * 미션 런타임 테스트 (무과금). 파일 쓰는 코더 stub + clean 리뷰어 + 실 git 임시레포로
 * 태스크 루프·강등·dep·rate limit 대기·리포트를 토큰 없이 검증.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { AsyncEventQueue } from "./eventQueue.js";
import { MockExecProvider, type EventScript } from "./mockExecProvider.js";
import { runMission, renderMissionReport, type MissionBrief } from "./mission.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";

/** 태스크마다 고유 파일을 쓰고, 받은 model을 기록하는 코더 stub. 옵션으로 rate limit 이벤트 방출. */
class MissionCoder implements ExecutionProvider {
  readonly id = "mc";
  models: string[] = [];
  private q = new Map<string, AsyncEventQueue<SessionEvent>>();
  constructor(private opts: { rateLimitResetsAt?: number } = {}) {}
  async start(spec: SessionSpec): Promise<SessionHandle> {
    this.models.push(spec.model ?? "?");
    writeFileSync(join(spec.cwd, `f-${spec.sessionId.replace(/[^a-z0-9]/gi, "_")}.txt`), "x\n");
    const queue = new AsyncEventQueue<SessionEvent>();
    this.q.set(spec.sessionId, queue);
    const raw = { type: "mc", session_id: spec.sessionId };
    queue.push({ kind: "init", sessionId: spec.sessionId, model: spec.model ?? "?", cwd: spec.cwd, permissionMode: "acceptEdits", tools: [], raw });
    if (this.opts.rateLimitResetsAt !== undefined) {
      queue.push({ kind: "rateLimit", sessionId: spec.sessionId, status: "exceeded", rateLimitType: "five_hour", resetsAt: this.opts.rateLimitResetsAt, raw });
    }
    queue.push({ kind: "assistant", sessionId: spec.sessionId, text: "done", toolUses: [], stopReason: "end_turn", raw });
    queue.push({ kind: "result", sessionId: spec.sessionId, isError: false, text: "ok", numTurns: 1, usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw });
    queue.close();
    return { sessionId: spec.sessionId, spec };
  }
  async send(): Promise<void> {}
  events(h: SessionHandle): AsyncIterable<SessionEvent> {
    return this.q.get(h.sessionId)!;
  }
  async stop(): Promise<void> {}
}

function cleanReviewer(): MockExecProvider {
  const script: EventScript = (spec): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    const md = "## Risks\n### Critical\n- 없음\n### Notes\n- ok";
    return [
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: md, numTurns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  return new MockExecProvider(script);
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-mission-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  await runProcess("git", ["-C", dir, "branch", "-m", "develop"]);
  await runProcess("git", ["-C", dir, "checkout", "-q", "-b", "scratch"]);
  return dir;
}

const idFor = (id: string) => `s-${id}`;

test("독립 태스크 2개 모두 병합 → merged 2, deferred 0", async () => {
  const repo = await initRepo();
  try {
    const brief: MissionBrief = { goal: "두 화면", tasks: [{ id: "t1", role: "r", task: "a" }, { id: "t2", role: "r", task: "b" }] };
    const r = await runMission({ repoRoot: repo, brief, coderProvider: new MissionCoder(), reviewProvider: cleanReviewer(), sessionIdFor: idFor, now: () => 1000, sleep: async () => {} });
    assert.deepEqual(r.merged, ["t1", "t2"], JSON.stringify(r.tasks));
    assert.equal(r.deferred.length, 0);
    assert.equal(r.endedStage, "B");
    assert.equal(r.totalUsage.inputTokens, 20);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("선행 태스크 미충족 → dep_unmet 보류", async () => {
  const repo = await initRepo();
  try {
    const brief: MissionBrief = { goal: "g", tasks: [{ id: "t1", role: "r", task: "a", deps: ["ghost"] }] };
    const r = await runMission({ repoRoot: repo, brief, coderProvider: new MissionCoder(), reviewProvider: cleanReviewer(), sessionIdFor: idFor, now: () => 1000, sleep: async () => {} });
    assert.equal(r.tasks[0].status, "dep_unmet");
    assert.deepEqual(r.merged, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rate limit → 자동 강등 B→C, 단순 태스크는 Sonnet", async () => {
  const repo = await initRepo();
  try {
    const coder = new MissionCoder({ rateLimitResetsAt: 0 }); // 매 태스크 rate limit 신호(과거 시각 → 대기 0)
    const brief: MissionBrief = { goal: "g", degradeOnLimit: "auto", tasks: [{ id: "t1", role: "r", task: "a" }, { id: "t2", role: "r", task: "b", difficulty: "simple" }] };
    const r = await runMission({ repoRoot: repo, brief, coderProvider: coder, reviewProvider: cleanReviewer(), sessionIdFor: idFor, now: () => 1000, sleep: async () => {}, threshold: { count: 1, totalMs: 9e15 } });
    assert.ok(r.degradeHistory.length >= 1, "강등 발생");
    assert.equal(r.degradeHistory[0].from, "B");
    assert.equal(r.degradeHistory[0].to, "C");
    assert.equal(coder.models[0], "opus", "t1: B단계 opus");
    assert.equal(coder.models[1], "sonnet", "t2: C단계 simple → sonnet");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rate limit → 다음 태스크 착수 직전에만 sleep (마지막 뒤엔 안 함)", async () => {
  const repo = await initRepo();
  try {
    const slept: number[] = [];
    const coder = new MissionCoder({ rateLimitResetsAt: 1010 }); // 매 태스크 rate limit, resetsAt 1010s
    const brief: MissionBrief = { goal: "g", tasks: [{ id: "t1", role: "r", task: "a" }, { id: "t2", role: "r", task: "b" }] };
    await runMission({ repoRoot: repo, brief, coderProvider: coder, reviewProvider: cleanReviewer(), sessionIdFor: idFor, now: () => 1_000_000, sleep: async (ms) => { slept.push(ms); }, threshold: { count: 99, totalMs: 9e15 } });
    // t1 뒤 대기가 t2 직전에 1회. t2 뒤(마지막)엔 대기 없음.
    assert.deepEqual(slept, [10_000], "t2 직전 1회만, resetsAt(1010s)-now(1000s)=10s");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("renderMissionReport: 목표·병합·강등 포함", () => {
  const md = renderMissionReport({
    goal: "테스트 목표", startedStage: "B", endedStage: "C",
    degradeHistory: [{ from: "B", to: "C", afterTask: "t1" }],
    tasks: [{ taskId: "t1", status: "merged", branch: "harness/m/t1", turns: 1, usage: null, reviews: [{ round: 1, critical: [] }] }],
    merged: ["t1"], deferred: [], rateLimitWaits: { count: 1, totalMs: 5000 }, totalUsage: { inputTokens: 10, outputTokens: 5 },
  });
  assert.ok(md.includes("테스트 목표"));
  assert.ok(md.includes("B → C"));
  assert.ok(md.includes("t1"));
});
