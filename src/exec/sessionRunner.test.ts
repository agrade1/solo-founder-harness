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

/**
 * 라운드마다 다른 Critical 목록을 내는 리뷰어 mock.
 * M5b(`B-8`)부터 리뷰 게이트가 **명시 verdict**를 요구하므로 Critical 유무와 일치하는 verdict를 함께 낸다
 * (계약이 강해진 것이고 이 테스트들의 의미는 그대로다 — 완화·삭제 0).
 */
function reviewerProvider(perRound: string[][]): ExecutionProvider {
  let i = 0;
  const script: EventScript = (spec, prompt): SessionEvent[] => {
    const critical = perRound[Math.min(i, perRound.length - 1)];
    i++;
    // M5b A5: 스키마가 활성 로드맵 §5.2 `review_result`로 좁혀졌고 대상 신원은 호출자 기대값에 묶인다.
    // 프롬프트가 알려준 revision/hash를 그대로 확인해 준다(실제 리뷰어가 하는 일과 같다).
    const revision = /^- revision: (.+)$/m.exec(prompt)?.[1] ?? "(미상)";
    const hash = /^- hash: (.+)$/m.exec(prompt)?.[1] ?? "(미상)";
    const md = [
      `## Reviewed Revision and Hash\n- revision: ${revision}\n- hash: ${hash}`,
      `## Findings (P0/P1/P2)\n${critical.length ? critical.map((c) => `- P1: ${c}`).join("\n") : "- 없음"}`,
      "## Reproduction or Evidence\n- diff 근거",
      "## Missing Tests\n- 없는 테스트 없음",
      "## Contract Deviations\n- 계약 위반 없음",
      `## Verdict: ${critical.length ? "revise" : "pass"}`,
    ].join("\n\n");
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

/**
 * [B-56] **코더가 중간에 죽는** stub. 파일을 일부 쓰고(= 부분 산출물) 실패 신호만 남긴다.
 *
 * 두 모양을 재현한다 — 실제 provider가 내는 것과 같다:
 *  - `exit_error`: 프로세스가 non-zero로 죽었다 (`claudeCliProvider.ts:94-104`가 내는 이벤트)
 *  - `result.isError=true`: 프로세스는 살았지만 세션이 오류로 끝났다
 */
class DyingProvider implements ExecutionProvider {
  readonly id = "dying";
  private q = new Map<string, AsyncEventQueue<SessionEvent>>();
  constructor(
    private files: Record<string, string>,
    private mode: "exit_error" | "result_error",
  ) {}
  async start(spec: SessionSpec): Promise<SessionHandle> {
    for (const [rel, c] of Object.entries(this.files)) writeFileSync(join(spec.cwd, rel), c);
    const queue = new AsyncEventQueue<SessionEvent>();
    this.q.set(spec.sessionId, queue);
    const raw = { type: "dying", session_id: spec.sessionId };
    queue.push({ kind: "init", sessionId: spec.sessionId, model: "d", cwd: spec.cwd, permissionMode: "acceptEdits", tools: [], mcpServers: [], raw });
    queue.push({ kind: "assistant", sessionId: spec.sessionId, text: "작업 중…", toolUses: [], stopReason: null, raw });
    if (this.mode === "exit_error") {
      // 프로세스가 죽었다 — result 이벤트가 **아예 없다**.
      queue.push({ kind: "unknown", type: "exit_error", sessionId: spec.sessionId, raw: { type: "exit_error", code: 1, stderr: "killed" } });
    } else {
      queue.push({ kind: "result", sessionId: spec.sessionId, isError: true, text: "오류로 종료", numTurns: 1, usage: { inputTokens: 3, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw });
    }
    queue.close();
    return { sessionId: spec.sessionId, spec };
  }
  async send(): Promise<void> {}
  events(h: SessionHandle): AsyncIterable<SessionEvent> {
    return this.q.get(h.sessionId)!;
  }
  async stop(): Promise<void> {}
}

// ── B-59 ──────────────────────────────────────────────────────
test("[B-59] 담당 경로(ownership) 밖에 쓰면 병합하지 않는다", async () => {
  // red: runSession의 ownership 검사를 지우면 이 세션이 merged가 된다.
  //      실측(2026-09-04): `CompiledPermissions.ownership`은 컴파일 후 **아무도 읽지 않고**,
  //      settings.json에도 그 경로가 등장하지 않는다(`allow/ask/deny` 어디에도 없다 — 확인).
  //      정책의 T1_bounded가 `Edit`/`Write`/`MultiEdit`를 **경로 제약 없이** allow에 넣고
  //      permissionMode는 `acceptEdits`다. 즉 담당 밖 쓰기를 막는 것이 아무것도 없었고,
  //      그런데도 task 문서는 "소유(쓰기 허용) 경로"라고 적어 강제성을 주장했다.
  const repo = await initRepo();
  try {
    const provider = new FileWriteProvider({ "mine.txt": "담당 안\n", "not-mine.txt": "담당 밖\n" });
    const out = await runSession({
      repoRoot: repo,
      runId: "b59",
      spec: { ...spec(), ownership: ["mine.txt"] },
      provider,
      approver: autoApprove,
    });
    assert.equal(out.status, "ownership_violation", `담당 밖 쓰기는 병합으로 가지 않는다 (실제: ${out.status})`);
    assert.ok(out.error && out.error.includes("not-mine.txt"), `어느 파일인지 말한다 (실제: ${out.error})`);
    const show = await runProcess("git", ["-C", repo, "show", "develop:mine.txt"]);
    assert.notEqual(show.code, 0, "담당 안 파일도 함께 막힌다 (부분 병합하지 않는다)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("[B-59] revise가 담당 밖으로 새어 나가도 막는다 (첫 turn만 보면 리뷰가 우회 통로가 된다)", async () => {
  // red: revise 루프의 ownership 재검사를 지우면, 1차엔 담당 안만 쓰고 2차 revise에서 담당 밖을
  //      건드리는 세션이 그대로 병합된다. 리뷰 되먹임이 경계를 넘는 통로가 되는 것이다.
  const repo = await initRepo();
  try {
    let turn = 0;
    const drifting: ExecutionProvider = {
      id: "drift",
      async start(spec: SessionSpec): Promise<SessionHandle> {
        writeFileSync(join(spec.cwd, "mine.txt"), "1차: 담당 안\n");
        return { sessionId: spec.sessionId, spec };
      },
      async send(h: SessionHandle): Promise<void> {
        writeFileSync(join(h.spec.cwd, "not-mine.txt"), "2차 revise: 담당 밖\n");
      },
      events(h: SessionHandle): AsyncIterable<SessionEvent> {
        const q = new AsyncEventQueue<SessionEvent>();
        const raw = { type: "drift", session_id: h.sessionId };
        q.push({ kind: "assistant", sessionId: h.sessionId, text: `t${++turn}`, toolUses: [], stopReason: "end_turn", raw });
        q.push({ kind: "result", sessionId: h.sessionId, isError: false, text: "ok", numTurns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw });
        q.close();
        return q;
      },
      async stop(): Promise<void> {},
    };
    const out = await runSession({
      repoRoot: repo,
      runId: "b59c",
      spec: { ...spec(), ownership: ["mine.txt"] },
      provider: drifting,
      approver: autoApprove,
      review: { provider: reviewerProvider([["1라운드 Critical"], []]), maxRounds: 2 },
    });
    assert.equal(out.status, "ownership_violation", `revise가 담당 밖으로 새면 막는다 (실제: ${out.status})`);
    assert.match(out.error ?? "", /revise 후/, "어느 단계에서 샜는지 말한다");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("[B-59] ownership이 없으면 아무것도 막지 않는다 (없는 경계를 지어내지 않는다)", async () => {
  const repo = await initRepo();
  try {
    const out = await runSession({ repoRoot: repo, runId: "b59b", spec: spec(), provider: new FileWriteProvider({ "any.txt": "x\n" }), approver: autoApprove });
    assert.equal(out.status, "merged", "ownership 미지정 세션의 동작은 바이트 하나 바뀌지 않는다");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── B-56 ──────────────────────────────────────────────────────
for (const mode of ["exit_error", "result_error"] as const) {
  test(`[B-56] 코더가 ${mode}로 죽으면 병합하지 않는다 — 스크립트 없는 레포(빈 게이트)에서도`, async () => {
    // red: `consumeTurn`(sessionRunner)이 실패 신호를 무시하던 판으로 되돌리면 이 테스트가 병합을 본다.
    //      3단이 겹친 결과였다: ⓐ exit_error·result.isError가 실패로 안 접힌다 ⓑ 대상 레포에
    //      test/lint/typecheck/build가 하나도 없으면 게이트가 checks=[]로 통과한다 ⓒ mission은
    //      merge:true·autoApprove다 → **중단된 작업의 부분 코드가 검증 0회로 develop에 병합된다.**
    //      ⓑ 자체는 의도된 동작이다(바로 위 happy-path 테스트가 스크립트 없이 병합한다) — 그래서
    //      ⓐ를 닫는다. 게이트 의미는 바이트 하나 바꾸지 않는다.
    const repo = await initRepo(); // package.json 없음 → 게이트가 빌 수밖에 없는 레포
    try {
      const provider = new DyingProvider({ "half.txt": "절반만 쓰다 죽었다\n" }, mode);
      const out = await runSession({ repoRoot: repo, runId: `b56-${mode}`, spec: spec(), provider, approver: autoApprove });

      assert.equal(out.status, "coder_failed", `죽은 세션은 성공 상태가 아니다 (실제: ${out.status})`);
      assert.ok(out.error && /코더/.test(out.error), `왜 멈췄는지 말한다 (실제: ${out.error})`);
      const show = await runProcess("git", ["-C", repo, "show", "develop:half.txt"]);
      assert.notEqual(show.code, 0, "부분 산출물이 develop에 병합되지 않았다");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("[B-56] 빈 게이트는 통과하되 '아무것도 실행하지 않았음'을 결과에 남긴다", async () => {
  // red: GateResult에 vacuous 표시를 지우면 mission·parallel 리포트가 "게이트 통과"만 남기고
  //      아무 검사도 안 돌았다는 사실이 사라진다("체크 없음" 공개는 commands/exec.ts 한 곳뿐이었다).
  const repo = await initRepo();
  try {
    const out = await runSession({ repoRoot: repo, runId: "b56-vac", spec: spec(), provider: new FileWriteProvider({ "a.txt": "x\n" }), approver: autoApprove });
    assert.equal(out.status, "merged", "정상 세션은 그대로 병합된다 — 게이트 의미를 바꾸지 않았다");
    assert.equal(out.gate?.passed, true);
    assert.equal(out.gate?.vacuous, true, "실행한 체크가 0개였음이 결과에 남는다");
    assert.deepEqual(out.gate?.checks, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

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
