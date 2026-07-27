/**
 * V3 M5a — codex JSONL 파서 테스트. 순수 in-memory(프로세스·네트워크 없음).
 * 실행: `npx tsx --test src/exec/codexStreamParser.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexJsonlParser, MAX_EVENTS, MAX_LINE_CHARS, MAX_TEXT_CHARS, MAX_USAGE } from "./codexStreamParser.js";
import type { SessionEvent } from "./types.js";

const CTX = { model: "gpt-5.6-sol", cwd: "/tmp/wt", sandbox: "read-only" };

function parser(): CodexJsonlParser {
  return new CodexJsonlParser(CTX);
}

/** 줄 배열 + 종료 정보를 흘려 전체 이벤트를 얻는다. */
function run(lines: string[], exit: { code?: number | null; signal?: string | null; stderr?: string } = {}): SessionEvent[] {
  const p = parser();
  const out: SessionEvent[] = [];
  for (const l of lines) for (const e of p.push(`${l}\n`)) out.push(e);
  for (const e of p.finish({ code: exit.code ?? 0, signal: exit.signal ?? null, stderr: exit.stderr })) out.push(e);
  return out;
}

function results(events: SessionEvent[]) {
  return events.filter((e) => e.kind === "result") as Extract<SessionEvent, { kind: "result" }>[];
}
function only(events: SessionEvent[]) {
  const r = results(events);
  assert.equal(r.length, 1, `종료 결과는 정확히 1개여야 한다(실제 ${r.length})`);
  return r[0];
}

const SUCCESS = [
  '{"type":"thread.started","thread_id":"th_123"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"i0","item_type":"reasoning"}}',
  '{"type":"item.completed","item":{"id":"i0","item_type":"reasoning","text":"secret thinking"}}',
  '{"type":"item.completed","item":{"id":"i1","item_type":"command_execution","command":"ls -a","status":"completed","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"i2","item_type":"file_change","status":"completed","changes":[{"path":"src/a.ts","kind":"modify"}]}}',
  '{"type":"item.completed","item":{"id":"i3","item_type":"agent_message","text":"검토 결과: 문제 없음"}}',
  '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":40,"output_tokens":30}}',
];

test("[M5a] 성공 스트림: init·진행·메시지·도구·usage를 provider 중립 이벤트로 매핑", () => {
  const events = run(SUCCESS);
  const init = events.find((e) => e.kind === "init");
  assert.ok(init && init.kind === "init");
  assert.equal(init.sessionId, "th_123");
  assert.equal(init.model, "gpt-5.6-sol");
  assert.equal(init.cwd, "/tmp/wt");
  assert.equal(init.permissionMode, "read-only");
  assert.deepEqual(init.mcpServers, [], "strict empty MCP");

  const statuses = events.filter((e) => e.kind === "status").map((e) => (e.kind === "status" ? e.status : ""));
  assert.ok(statuses.includes("turn_started"));
  assert.ok(statuses.includes("reasoning"), "추론은 진행 신호로만 남는다");
  assert.ok(statuses.some((s) => s.startsWith("item.started:")));

  const tools = events.flatMap((e) => (e.kind === "assistant" ? e.toolUses : []));
  assert.deepEqual(tools.map((t) => t.name), ["command_execution", "file_change"]);
  assert.deepEqual(tools[1].input, {
    status: "completed",
    changes: [{ path: "src/a.ts", kind: "modify" }],
    truncated: false,
  });

  const r = only(events);
  assert.equal(r.isError, false);
  assert.equal(r.terminalReason, "turn_completed");
  assert.equal(r.text, "검토 결과: 문제 없음");
  assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 40 });
  assert.equal(r.totalCostUsd, 0, "codex JSONL은 비용을 주지 않으므로 추정치를 만들지 않는다");
});

test("[M5a] 추론 원문은 어떤 이벤트 텍스트에도 실리지 않는다", () => {
  const events = run(SUCCESS);
  for (const e of events) {
    if (e.kind === "assistant") assert.ok(!e.text.includes("secret thinking"));
    if (e.kind === "result") assert.ok(!e.text.includes("secret thinking"));
  }
});

test("[M5a] 구조화 최종 출력: 마지막 agent_message 본문이 result.text다", () => {
  const payload = '{\\"verdict\\":\\"pass\\",\\"findings\\":[]}';
  const events = run([
    '{"type":"thread.started","thread_id":"t"}',
    `{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"${payload}"}}`,
    '{"type":"turn.completed","usage":{}}',
  ]);
  const r = only(events);
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.text), { verdict: "pass", findings: [] });
});

test("[M5a] 깨진 JSON·type 없는 객체·배열은 malformed로 세고 성공을 만들지 않는다", () => {
  const events = run(['{not json', '{"no_type":1}', "[1,2,3]", '{"type":"thread.started","thread_id":"t"}']);
  const unknowns = events.filter((e) => e.kind === "unknown").map((e) => (e.kind === "unknown" ? e.type : ""));
  assert.deepEqual(unknowns, ["malformed_line", "malformed_line", "malformed_line"]);
  const r = only(events);
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "no_terminal_event");
});

test("[M5a] 과대 줄은 내용을 버리고 malformed로 처리한다(개행 있든 없든)", () => {
  const huge = `{"type":"item.completed","item":{"item_type":"agent_message","text":"${"x".repeat(MAX_LINE_CHARS)}"}}`;
  const withNewline = run([huge, '{"type":"turn.completed","usage":{}}']);
  assert.ok(
    withNewline.some((e) => e.kind === "unknown" && e.type === "oversized_line"),
    "개행으로 끝난 과대 줄",
  );
  assert.equal(only(withNewline).isError, false, "그 뒤 정상 종료 이벤트는 여전히 성공 판정");
  for (const e of withNewline) if (e.kind === "assistant") assert.ok(!e.text.includes("xxxx"));

  const p = parser();
  const noNewline = p.push(huge); // 개행 없이 상한 초과 → 버퍼를 붙잡지 않는다
  assert.ok(noNewline.some((e) => e.kind === "unknown" && e.type === "oversized_line"));
  assert.equal(p.malformedLines, 1);
});

test("[M5a] 텍스트·usage 상한: 긴 메시지는 절삭, 계약 밖 usage는 0", () => {
  const long = "가".repeat(MAX_TEXT_CHARS + 100);
  const events = run([
    '{"type":"thread.started","thread_id":"t"}',
    JSON.stringify({ type: "item.completed", item: { id: "i", item_type: "agent_message", text: long } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: -5, output_tokens: MAX_USAGE * 10, cached_input_tokens: "x" } }),
  ]);
  const msg = events.find((e) => e.kind === "assistant");
  assert.ok(msg && msg.kind === "assistant");
  assert.ok(msg.text.length <= MAX_TEXT_CHARS + 16 && msg.text.endsWith("…[truncated]"));
  const r = only(events);
  assert.deepEqual(r.usage, {
    inputTokens: 0,
    outputTokens: MAX_USAGE,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
});

test("[M5a] 모르는 이벤트·모르는 item 종류는 bounded unknown이며 성공 근거가 아니다", () => {
  const events = run([
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.future_thing","payload":{"a":1}}',
    '{"type":"item.completed","item":{"id":"i","item_type":"web_search","query":"q"}}',
  ]);
  const unknowns = events.filter((e) => e.kind === "unknown").map((e) => (e.kind === "unknown" ? e.type : ""));
  assert.deepEqual(unknowns, ["turn.future_thing", "item.completed:web_search"]);
  const r = only(events);
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "no_terminal_event");
});

test("[M5a] MCP 호출 이벤트가 보이면 실패다(뒤에 성공 종료가 와도 뒤집히지 않는다)", () => {
  for (const line of [
    '{"type":"item.completed","item":{"id":"i","item_type":"mcp_tool_call","server":"s","tool":"t"}}',
    '{"type":"item.started","item":{"id":"i","item_type":"mcp_tool_call"}}',
  ]) {
    const events = run(['{"type":"thread.started","thread_id":"t"}', line, '{"type":"turn.completed","usage":{}}']);
    assert.ok(events.some((e) => e.kind === "unknown" && e.type === "mcp_call_observed"));
    const r = only(events);
    assert.equal(r.isError, true);
    assert.equal(r.terminalReason, "mcp_call_observed");
  }
});

test("[M5a] turn.failed / error는 bounded·scrubbed 요약만 싣는다", () => {
  const failed = only(
    run([
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.failed","error":{"message":"boom api_key=SUPERSECRET happened"}}',
    ]),
  );
  assert.equal(failed.isError, true);
  assert.equal(failed.terminalReason, "turn_failed");
  assert.ok(!failed.text.includes("SUPERSECRET"), "secret은 가려진다");
  assert.ok(failed.text.includes("boom"));

  const errored = only(run(['{"type":"error","message":"stream broke"}'], { code: 1 }));
  assert.equal(errored.terminalReason, "error");
  assert.equal(errored.text, "stream broke");
});

test("[M5a] 권한·비대화 승인 불가 실패는 permission_required로 매핑된다", () => {
  const r = only(
    run([
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.failed","error":{"message":"command requires approval but approvals are disabled"}}',
    ]),
  );
  assert.equal(r.isError, true);
  assert.equal(r.stopReason, "permission_required");
  assert.deepEqual(r.permissionDenials, [{ reason: "permission_required" }]);
});

test("[M5a] silent stream(종료 이벤트 없음)은 성공이 아니다", () => {
  const r = only(run([], { code: 0 }));
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "no_terminal_event");
  assert.equal(r.numTurns, 0);
});

test("[M5a] 정상 종료 이벤트 뒤의 비정상 exit·signal도 실패다", () => {
  const nonzero = only(run(SUCCESS, { code: 2, stderr: "codex: bad flag" }));
  assert.equal(nonzero.isError, true);
  assert.equal(nonzero.terminalReason, "exit_error");
  assert.equal(nonzero.text, "codex: bad flag");

  const killed = only(run(SUCCESS, { code: null, signal: "SIGKILL" }));
  assert.equal(killed.isError, true);
  assert.equal(killed.terminalReason, "signal");
  assert.equal(killed.raw.signal, "SIGKILL");
});

test("[M5a] spawn 실패는 spawn_error로 구분된다", () => {
  const p = parser();
  const r = p.finish({ code: null, signal: null, stderr: "spawn codex ENOENT", spawnError: true });
  assert.equal(r.length, 1);
  assert.equal(r[0].kind === "result" && r[0].terminalReason, "spawn_error");
});

test("[M5a] 중복 종료 이벤트: 첫 outcome만 채택하고 나머지는 표시만 남긴다", () => {
  const events = run([
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
    '{"type":"turn.failed","error":{"message":"late failure"}}',
    '{"type":"turn.completed","usage":{"input_tokens":9}}',
  ]);
  const dups = events.filter((e) => e.kind === "unknown" && e.type === "duplicate_terminal");
  assert.equal(dups.length, 2);
  const r = only(events);
  assert.equal(r.isError, false);
  assert.equal(r.terminalReason, "turn_completed");
});

test("[M5a] 이벤트 수 상한을 넘기면 종료 결과가 실패다", () => {
  const lines = Array.from({ length: MAX_EVENTS + 5 }, () => '{"type":"turn.started"}');
  const events = run([...lines, '{"type":"turn.completed","usage":{}}']);
  assert.ok(events.some((e) => e.kind === "unknown" && e.type === "event_limit_exceeded"));
  const r = only(events);
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "event_limit_exceeded");
});

test("[M5a] 청크가 줄 경계를 가로질러도 같은 결과", () => {
  const text = `${SUCCESS.join("\n")}\n`;
  const p = parser();
  const collected: SessionEvent[] = [];
  for (let i = 0; i < text.length; i += 7) for (const e of p.push(text.slice(i, i + 7))) collected.push(e);
  for (const e of p.finish({ code: 0, signal: null })) collected.push(e);
  assert.equal(collected.length, run(SUCCESS).length);
  assert.equal(only(collected).isError, false);
  assert.equal(p.sessionId, "th_123");
});

test("[M5a] 개행 없이 끝난 마지막 줄도 finish에서 소진된다", () => {
  const p = parser();
  p.push('{"type":"thread.started","thread_id":"t"}\n');
  p.push('{"type":"turn.completed","usage":{"input_tokens":7}}'); // 개행 없음
  const out = p.finish({ code: 0, signal: null });
  const r = out.find((e) => e.kind === "result");
  assert.ok(r && r.kind === "result");
  assert.equal(r.isError, false);
  assert.equal(r.usage.inputTokens, 7);
});

test("[M5a] finish는 두 번 불러도 종료 결과를 한 번만 만든다", () => {
  const p = parser();
  p.push(`${SUCCESS.join("\n")}\n`);
  assert.equal(p.finish({ code: 0, signal: null }).length, 1);
  assert.deepEqual(p.finish({ code: 0, signal: null }), []);
});
