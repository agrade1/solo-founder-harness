/**
 * SessionRunner 오케스트레이션 테스트 (무과금). 파일을 쓰는 stub provider + 실제 git 임시레포로
 * worktree→게이트→커밋→diff→승인→병합 전 경로를 토큰 없이 검증한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { AsyncEventQueue } from "./eventQueue.js";
import { runSession } from "./sessionRunner.js";
import { autoApprove } from "./approvalQueue.js";
import { MockExecProvider, type EventScript } from "./mockExecProvider.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";

/** 라운드마다 다른 Critical 목록을 내는 리뷰어 mock. */
function reviewerProvider(perRound: string[][]): ExecutionProvider {
  let i = 0;
  const script: EventScript = (spec): SessionEvent[] => {
    const critical = perRound[Math.min(i, perRound.length - 1)];
    i++;
    const md = `## Risks\n### Critical\n${critical.length ? critical.map((c) => `- ${c}`).join("\n") : "- 없음"}\n### Notes\n- n`;
    const raw = { type: "mock", session_id: spec.sessionId };
    return [
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], mcpServers: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: md, numTurns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  return new MockExecProvider(script);
}

/** start()에서 worktree(cwd)에 파일을 쓰고 init/assistant/result를 재생하는 stub. */
class FileWriteProvider implements ExecutionProvider {
  readonly id = "fw";
  private q = new Map<string, AsyncEventQueue<SessionEvent>>();
  constructor(private files: Record<string, string>) {}
  async start(spec: SessionSpec): Promise<SessionHandle> {
    for (const [rel, c] of Object.entries(this.files)) writeFileSync(join(spec.cwd, rel), c);
    const queue = new AsyncEventQueue<SessionEvent>();
    this.q.set(spec.sessionId, queue);
    const raw = { type: "fw", session_id: spec.sessionId };
    queue.push({ kind: "init", sessionId: spec.sessionId, model: "fw", cwd: spec.cwd, permissionMode: "acceptEdits", tools: [], mcpServers: [], raw });
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

/** develop 브랜치 + 스크래치 체크아웃(develop 비점유)인 임시 레포. pkg 스크립트 주입 옵션. */
async function initRepo(pkgScripts?: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-run-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# temp\n");
  if (pkgScripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", scripts: pkgScripts }));
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  await runProcess("git", ["-C", dir, "branch", "-m", "develop"]);
  await runProcess("git", ["-C", dir, "checkout", "-q", "-b", "scratch"]); // develop 비점유 → push .:develop 허용
  return dir;
}

const spec = (): SessionSpec => ({ sessionId: "sess1", role: "구현", task: "hello 파일 생성", cwd: "" });

test("승인 → develop 병합 (파일이 base에 반영)", async () => {
  const repo = await initRepo();
  try {
    const provider = new FileWriteProvider({ "hello.txt": "harness\n" });
    const out = await runSession({ repoRoot: repo, runId: "r1", spec: spec(), provider, approver: autoApprove });
    assert.equal(out.status, "merged", out.error ?? "");
    assert.equal(out.turns, 1);
    assert.equal(out.usage?.inputTokens, 10);
    const show = await runProcess("git", ["-C", repo, "show", "develop:hello.txt"]);
    assert.equal(show.stdout, "harness\n", "develop에 파일 반영됨");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("거부 → 병합 안 함 (develop 그대로)", async () => {
  const repo = await initRepo();
  try {
    const provider = new FileWriteProvider({ "hello.txt": "x\n" });
    const out = await runSession({ repoRoot: repo, runId: "r2", spec: spec(), provider, approver: async () => "reject" });
    assert.equal(out.status, "rejected");
    const show = await runProcess("git", ["-C", repo, "show", "develop:hello.txt"]);
    assert.notEqual(show.code, 0, "develop엔 파일 없음");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("변경 없음 → no_changes (병합 시도 안 함)", async () => {
  const repo = await initRepo();
  try {
    const provider = new FileWriteProvider({}); // 아무 파일도 안 씀
    const out = await runSession({ repoRoot: repo, runId: "r3", spec: spec(), provider, approver: autoApprove });
    assert.equal(out.status, "no_changes");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("L1 게이트 실패 → gate_failed, 병합 차단", async () => {
  const repo = await initRepo({ typecheck: "false" }); // 항상 실패하는 typecheck
  try {
    const provider = new FileWriteProvider({ "hello.txt": "x\n" });
    const out = await runSession({ repoRoot: repo, runId: "r4", spec: spec(), provider, approver: autoApprove });
    assert.equal(out.status, "gate_failed");
    assert.equal(out.gate?.passed, false);
    const show = await runProcess("git", ["-C", repo, "show", "develop:hello.txt"]);
    assert.notEqual(show.code, 0, "게이트 실패 시 develop 미반영");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("L3 리뷰 통과(첫 라운드 Critical 없음) → 병합", async () => {
  const repo = await initRepo();
  try {
    const out = await runSession({
      repoRoot: repo, runId: "r5", spec: spec(),
      provider: new FileWriteProvider({ "hello.txt": "ok\n" }),
      approver: autoApprove,
      review: { provider: reviewerProvider([[]]) }, // 첫 리뷰 clean
    });
    assert.equal(out.status, "merged", out.error ?? "");
    assert.equal(out.reviews.length, 1);
    assert.deepEqual(out.reviews[0].critical, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("L3 Critical → revise → 재리뷰 통과 → 병합 (2라운드)", async () => {
  const repo = await initRepo();
  try {
    const out = await runSession({
      repoRoot: repo, runId: "r6", spec: spec(),
      provider: new FileWriteProvider({ "hello.txt": "ok\n" }),
      approver: autoApprove,
      review: { provider: reviewerProvider([["계약 불일치"], []]), maxRounds: 2 }, // R1 critical, R2 clean
    });
    assert.equal(out.status, "merged", out.error ?? "");
    assert.equal(out.reviews.length, 2);
    assert.deepEqual(out.reviews[0].critical, ["계약 불일치"]);
    assert.deepEqual(out.reviews[1].critical, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("L3 라운드 소진해도 Critical → review_deferred, 병합 차단", async () => {
  const repo = await initRepo();
  try {
    const out = await runSession({
      repoRoot: repo, runId: "r7", spec: spec(),
      provider: new FileWriteProvider({ "hello.txt": "ok\n" }),
      approver: autoApprove,
      review: { provider: reviewerProvider([["버그"], ["버그"]]), maxRounds: 2 },
    });
    assert.equal(out.status, "review_deferred");
    assert.equal(out.reviews.length, 2);
    const show = await runProcess("git", ["-C", repo, "show", "develop:hello.txt"]);
    assert.notEqual(show.code, 0, "리뷰 미해결 시 develop 미반영");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
