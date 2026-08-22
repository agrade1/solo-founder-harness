/**
 * V3 M10 T7 — codex 리뷰어 worker backend(대장 `C-97`) 테스트.
 * 실제 codex를 부르지 않는다: **JSONL을 찍는 가짜 실행 파일**로 스트림 계약만 고정한다(무과금).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PLAN_BACKEND, codexWorkerArgs, startCodexPlanTurn } from "./codexPlanWorker.js";
import { OrchestrationError } from "./orchestrationTypes.js";

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BINDING = { runId: "run-1", taskId: "review-1", attemptId: "att-1", turnId: "turn-1" };
const PLAN = JSON.stringify({
  schemaVersion: "1",
  ...BINDING,
  operations: [],
  result: { summary: "리뷰 결과", outputs: [] },
});

/** JSONL을 그대로 찍는 가짜 codex. 인자는 무시하고 `$CODEX_HOME`을 되돌려 env 계약도 관측한다. */
function fakeCodex(body: string): string {
  const dir = makeDir("m10-codexw-");
  const bin = join(dir, "codex.sh");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * JSONL 네 줄을 **파일로 써 두고 `cat`**한다 — 계획 본문에는 개행·backtick·따옴표가 들어가므로
 * shell 인용으로 만들면 그 자체가 테스트의 버그가 된다(실측으로 한 번 겪었다).
 */
function jsonlBin(text: string): string {
  const dir = makeDir("m10-codexjsonl-");
  const stream = join(dir, "stream.jsonl");
  writeFileSync(
    stream,
    [
      JSON.stringify({ type: "thread.started", thread_id: "01a028a2-0ba8-7911-83ab-c3efa8cc743c" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 11, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 },
      }),
    ].join("\n") + "\n",
  );
  return fakeCodex(`cat ${JSON.stringify(stream)}`);
}

async function collect(stream: AsyncIterable<{ kind: string }>): Promise<string[]> {
  const kinds: string[] = [];
  for await (const e of stream) kinds.push(e.kind);
  return kinds;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "(통과)";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
}

test("[M10 T7/C-97] 계약: 인자에 read-only sandbox·격리 flag가 고정돼 있고 고를 통로가 없다", () => {
  const args = codexWorkerArgs("/ws");
  assert.equal(CODEX_PLAN_BACKEND, "codex-plan");
  for (const want of ["exec", "--json", "--sandbox", "read-only", "--strict-config", "--ignore-user-config", "--ignore-rules", "--cd", "/ws"]) {
    assert.ok(args.includes(want), `인자에서 ${want}가 사라졌다`);
  }
  assert.ok(args.includes("mcp_servers={}"), "MCP 비우기가 사라졌다");
  // 쓰기 sandbox·resume·skip-git-repo-check는 **표현되지 않는다**(리뷰어가 권한을 얻는 통로 금지).
  for (const never of ["workspace-write", "danger-full-access", "resume", "--skip-git-repo-check"]) {
    assert.equal(args.includes(never), false, `${never}가 인자에 있다`);
  }
});

test("[M10 T7/C-97] JSONL 마지막 agent_message에서 계획을 꺼내고 usage를 회계로 넘긴다", async () => {
  const bin = jsonlBin(`리뷰 요약입니다.\n\`\`\`json\n${PLAN}\n\`\`\``);
  const events: { kind: string; usage?: { inputTokens: number; outputTokens: number } }[] = [];
  for await (const e of startCodexPlanTurn({
    executable: bin,
    codexHome: makeDir("m10-codexhome-"),
    cwd: makeDir("m10-codexws-"),
    prompt: "리뷰해라",
    binding: BINDING,
    timeoutMs: 30_000,
  })) {
    events.push(e as { kind: string });
  }
  assert.deepEqual(events.map((e) => e.kind), ["started", "progress", "terminal"]);
  const terminal = events[2] as { usage: { inputTokens: number; outputTokens: number } };
  assert.equal(terminal.usage.inputTokens, 11);
  assert.equal(terminal.usage.outputTokens, 7);
});

test("[M10 T7/C-97] 자식 env는 CODEX_HOME 하나다(부모 env를 상속하지 않는다)", async () => {
  // 가짜 codex가 자기 env를 계획 요약에 실어 돌려준다 → 그 요약으로 env 계약을 관측한다.
  const bin = fakeCodex(
    `NAMES=$(env | cut -d= -f1 | sort | tr '\\n' ' ')\n` +
      `echo '{"type":"thread.started","thread_id":"01a028a2-0ba8-7911-83ab-c3efa8cc743c"}'\n` +
      `printf '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\\\"schemaVersion\\\\":\\\\"1\\\\",\\\\"runId\\\\":\\\\"run-1\\\\",\\\\"taskId\\\\":\\\\"review-1\\\\",\\\\"attemptId\\\\":\\\\"att-1\\\\",\\\\"turnId\\\\":\\\\"turn-1\\\\",\\\\"operations\\\\":[],\\\\"result\\\\":{\\\\"summary\\\\":\\\\"env %s\\\\",\\\\"outputs\\\\":[]}}"}}\\n' "$NAMES"\n` +
      `echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'`,
  );
  process.env.M10_T7_LEAK_PROBE = "leaked";
  let summary = "";
  try {
    for await (const e of startCodexPlanTurn({
      executable: bin,
      codexHome: makeDir("m10-codexhome-"),
      cwd: makeDir("m10-codexws-"),
      prompt: "x",
      binding: BINDING,
      timeoutMs: 30_000,
    })) {
      if (e.kind === "terminal") summary = (e as { plan: { result: { summary: string } } }).plan.result.summary;
    }
  } finally {
    delete process.env.M10_T7_LEAK_PROBE;
  }
  assert.match(summary, /CODEX_HOME/, "자식이 CODEX_HOME을 받지 못했다");
  assert.equal(summary.includes("M10_T7_LEAK_PROBE"), false, "부모 env가 자식으로 샜다");
  assert.equal(summary.includes("PATH"), false, "PATH까지 상속됐다(닫힌 env가 아니다)");
});

test("[M10 T7/C-97] 계획이 없거나 출력이 없으면 성공이 아니다(fail closed)", async () => {
  const noPlan = jsonlBin("계획 없이 말만 한다");
  assert.equal(
    await codeOf(() =>
      collect(
        startCodexPlanTurn({
          executable: noPlan,
          codexHome: makeDir("m10-codexhome-"),
          cwd: makeDir("m10-codexws-"),
          prompt: "x",
          binding: BINDING,
          timeoutMs: 30_000,
        }),
      ),
    ),
    "worker_plan_missing",
  );

  const silent = fakeCodex("exit 0");
  assert.equal(
    await codeOf(() =>
      collect(
        startCodexPlanTurn({
          executable: silent,
          codexHome: makeDir("m10-codexhome-"),
          cwd: makeDir("m10-codexws-"),
          prompt: "x",
          binding: BINDING,
          timeoutMs: 30_000,
        }),
      ),
    ),
    "worker_no_output",
  );
});

test("[M10 T7/C-97] 계획이 다른 task/turn에 묶여 있으면 거부한다(binding은 kernel이 준 값이다)", async () => {
  const wrong = jsonlBin(
    JSON.stringify({ schemaVersion: "1", ...BINDING, taskId: "other-task", operations: [], result: { summary: "s", outputs: [] } }),
  );
  const code = await codeOf(() =>
    collect(
      startCodexPlanTurn({
        executable: wrong,
        codexHome: makeDir("m10-codexhome-"),
        cwd: makeDir("m10-codexws-"),
        prompt: "x",
        binding: BINDING,
        timeoutMs: 30_000,
      }),
    ),
  );
  assert.equal(code, "plan_invalid");
});
