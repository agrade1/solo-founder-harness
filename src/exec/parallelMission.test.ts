/**
 * 병렬 미션 테스트 (실 git + mock, 무과금). 웨이브 병렬 실행 + 직렬 병합 + deps 순서.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { AsyncEventQueue } from "./eventQueue.js";
import { MockExecProvider, type EventScript } from "./mockExecProvider.js";
import { runParallelMission } from "./parallelMission.js";
import { REVIEW_RESULT_HEADINGS } from "./reviewer.js";
import type { MissionBrief } from "./mission.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";

/** 태스크별 고유 파일(ownership 분리 흉내)을 쓰는 코더. 동시 시작 수를 기록. */
class ParallelCoder implements ExecutionProvider {
  readonly id = "pc";
  active = 0;
  maxActive = 0;
  private q = new Map<string, AsyncEventQueue<SessionEvent>>();
  async start(spec: SessionSpec): Promise<SessionHandle> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 15)); // 겹침 유도
    writeFileSync(join(spec.cwd, `f-${spec.sessionId.replace(/[^a-z0-9]/gi, "_")}.txt`), "x\n");
    this.active--;
    const queue = new AsyncEventQueue<SessionEvent>();
    this.q.set(spec.sessionId, queue);
    const raw = { type: "pc", session_id: spec.sessionId };
    queue.push({ kind: "init", sessionId: spec.sessionId, model: spec.model ?? "?", cwd: spec.cwd, permissionMode: "acceptEdits", tools: [], mcpServers: [], raw });
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

/**
 * §5.2 `review_result` "결함 없음" 본문. heading 이름은 `REVIEW_RESULT_HEADINGS`에서 가져오고
 * 대상 신원은 프롬프트가 알려준 값을 그대로 확인해 준다(M5b A5 계약).
 */
function cleanReviewBody(prompt: string): string {
  const rev = /^- revision: (.+)$/m.exec(prompt)?.[1] ?? "(미상)";
  const hash = /^- hash: (.+)$/m.exec(prompt)?.[1] ?? "(미상)";
  return [
    `## ${REVIEW_RESULT_HEADINGS[0]}\n- revision: ${rev}\n- hash: ${hash}`,
    `## ${REVIEW_RESULT_HEADINGS[1]}\n- 없음`,
    `## ${REVIEW_RESULT_HEADINGS[2]}\n- diff 근거`,
    `## ${REVIEW_RESULT_HEADINGS[3]}\n- 없는 테스트 없음`,
    `## ${REVIEW_RESULT_HEADINGS[4]}\n- 계약 위반 없음`,
    `## ${REVIEW_RESULT_HEADINGS[5]}: pass`,
  ].join("\n\n");
}

function cleanReviewer(): MockExecProvider {
  const script: EventScript = (spec, prompt): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    return [
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], mcpServers: [], raw },
      // M5b(`B-8`+A5): 리뷰 게이트가 §5.2 스키마 · 명시 verdict · 대상 신원 확인을 요구한다.
      { kind: "result", sessionId: spec.sessionId, isError: false, text: cleanReviewBody(prompt), numTurns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  return new MockExecProvider(script);
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-pmission-"));
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

test("독립 태스크 2개 병렬 실행 + 직렬 병합 → 둘 다 develop", async () => {
  const repo = await initRepo();
  try {
    const coder = new ParallelCoder();
    const brief: MissionBrief = { goal: "g", tasks: [{ id: "t1", role: "r", task: "a", ownership: ["a/**"] }, { id: "t2", role: "r", task: "b", ownership: ["b/**"] }] };
    const r = await runParallelMission({ repoRoot: repo, brief, coderProvider: coder, reviewProvider: cleanReviewer(), sessionIdFor: idFor, concurrency: 2, now: () => 1000, sleep: async () => {} });
    // 동시성 자체는 runPool 구조 + e2e 스모크(실세션 maxConcurrent=2)가 보장. 유닛은 정확성만 단정
    // (worktree 생성 직렬화로 mock의 짧은 관찰 창이 어긋나 maxActive 측정은 타이밍 취약).
    assert.deepEqual(r.merged.sort(), ["t1", "t2"], JSON.stringify(r.tasks));
    const files = (await runProcess("git", ["-C", repo, "ls-tree", "-r", "--name-only", "develop"])).stdout;
    assert.ok(files.includes("f-s_t1.txt") && files.includes("f-s_t2.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deps: t2가 t1에 의존 → 웨이브 순서(t1 병합 후 t2)", async () => {
  const repo = await initRepo();
  try {
    const coder = new ParallelCoder();
    const brief: MissionBrief = { goal: "g", tasks: [{ id: "t1", role: "r", task: "a" }, { id: "t2", role: "r", task: "b", deps: ["t1"] }] };
    const r = await runParallelMission({ repoRoot: repo, brief, coderProvider: coder, reviewProvider: cleanReviewer(), sessionIdFor: idFor, concurrency: 3, now: () => 1000, sleep: async () => {} });
    assert.deepEqual(r.merged, ["t1", "t2"]);
    assert.equal(coder.maxActive, 1, "deps로 인해 동시성 1(웨이브 분리)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("선행 미충족(존재하지 않는 dep) → dep_unmet", async () => {
  const repo = await initRepo();
  try {
    const brief: MissionBrief = { goal: "g", tasks: [{ id: "t1", role: "r", task: "a", deps: ["ghost"] }] };
    const r = await runParallelMission({ repoRoot: repo, brief, coderProvider: new ParallelCoder(), reviewProvider: cleanReviewer(), sessionIdFor: idFor, now: () => 1000, sleep: async () => {} });
    assert.equal(r.tasks[0].status, "dep_unmet");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
