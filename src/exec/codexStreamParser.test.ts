/**
 * V3 M5a — codex JSONL 파서 테스트. 순수 in-memory(프로세스·네트워크 없음).
 * 실행: `npx tsx --test src/exec/codexStreamParser.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexJsonlParser, MAX_EVENTS, MAX_LINE_CHARS, MAX_TEXT_CHARS, MAX_USAGE } from "./codexStreamParser.js";
import type { SessionEvent } from "./types.js";

const CTX = { model: "gpt-5.6-sol", cwd: "/tmp/wt", sandbox: "read-only" };
const TID = "0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
const TID2 = "0199ffff-c3d4-4e5f-8a9b-0c1d2e3f4a5b";

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
function markers(events: SessionEvent[]): string[] {
  return events.filter((e) => e.kind === "unknown").map((e) => (e.kind === "unknown" ? e.type : ""));
}

const SUCCESS = [
  `{"type":"thread.started","thread_id":"${TID}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"i0","item_type":"reasoning"}}',
  '{"type":"item.completed","item":{"id":"i0","item_type":"reasoning","text":"secret thinking"}}',
  '{"type":"item.completed","item":{"id":"i1","item_type":"command_execution","command":"ls -a /etc/shadow","status":"completed","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"i2","item_type":"file_change","status":"completed","changes":[{"path":"src/a.ts","kind":"modify"}]}}',
  '{"type":"item.completed","item":{"id":"i3","item_type":"agent_message","text":"검토 결과: 문제 없음"}}',
  '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":40,"output_tokens":30}}',
];

test("[M5a] 성공 스트림: init·진행·메시지·도구·usage를 provider 중립 이벤트로 매핑", () => {
  const events = run(SUCCESS);
  const init = events.find((e) => e.kind === "init");
  assert.ok(init && init.kind === "init");
  assert.equal(init.sessionId, TID);
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
  assert.deepEqual(tools[0].input, { status: "completed", exitCode: 0, commandChars: 17 }, "명령 문자열은 싣지 않는다");
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

test("[M5a] raw 유출 방지: 모든 이벤트 직렬화에 본문·명령·secret·프롬프트가 없다", () => {
  const stderrBody = "STDERR_BODY_SENTINEL";
  const events = run(
    [
      ...SUCCESS.slice(0, 7),
      '{"type":"vendor.future","payload":{"leak":"UNKNOWN_PAYLOAD_SENTINEL"}}',
      '{"type":"item.completed","item":{"id":"i9","item_type":"web_search","query":"UNKNOWN_ITEM_SENTINEL"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
    ],
    { stderr: stderrBody },
  );
  const forbidden = ["secret thinking", "/etc/shadow", "ls -a", "UNKNOWN_PAYLOAD_SENTINEL", "UNKNOWN_ITEM_SENTINEL", stderrBody];
  const kinds = new Set<string>();
  for (const e of events) {
    kinds.add(e.kind);
    const json = JSON.stringify(e);
    for (const bad of forbidden) assert.ok(!json.includes(bad), `${e.kind} 이벤트에 '${bad}'가 새어나갔다: ${json.slice(0, 200)}`);
    // raw는 언제나 bounded metadata projection이다(원본 객체 금지).
    assert.ok(!("item" in e.raw) && !("message" in e.raw) && !("payload" in e.raw), `${e.kind}의 raw가 원본 필드를 담았다`);
  }
  assert.deepEqual([...kinds].sort(), ["assistant", "init", "result", "status", "unknown"], "모든 방출 kind를 덮었다");
});

test("[M5a] 소비자가 이벤트를 그대로 전달·직렬화해도 본문이 새지 않는다", () => {
  // orchestrator가 이벤트를 로그/전달용으로 통째 직렬화하는 상황 재현.
  const forwarded = run(SUCCESS).map((e) => JSON.parse(JSON.stringify(e)) as SessionEvent);
  const blob = JSON.stringify(forwarded);
  assert.ok(!blob.includes("secret thinking"));
  assert.ok(!blob.includes("ls -a"));
  assert.ok(blob.includes("검토 결과"), "정당한 최종 메시지는 남는다(assistant.text/result.text)");
});

test("[M5a] 구조화 최종 출력: 마지막 agent_message 본문이 result.text다", () => {
  const payload = '{\\"verdict\\":\\"pass\\",\\"findings\\":[]}';
  const events = run([
    `{"type":"thread.started","thread_id":"${TID}"}`,
    `{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"${payload}"}}`,
    '{"type":"turn.completed","usage":{}}',
  ]);
  const r = only(events);
  assert.equal(r.isError, false);
  assert.deepEqual(JSON.parse(r.text), { verdict: "pass", findings: [] });
});

test("[M5a] 깨진 JSON·type 없는 객체·배열은 비가역 프로토콜 실패다", () => {
  const events = run(["{not json", `{"type":"thread.started","thread_id":"${TID}"}`, '{"type":"turn.completed","usage":{}}']);
  assert.deepEqual(markers(events), ["malformed_line"]);
  const r = only(events);
  assert.equal(r.isError, true, "성공 종료 이벤트가 뒤에 와도 실패를 되돌리지 못한다");
  assert.equal(r.terminalReason, "malformed_line");

  for (const bad of ['{"no_type":1}', "[1,2,3]"]) {
    const one = only(run([bad, `{"type":"thread.started","thread_id":"${TID}"}`, '{"type":"turn.completed","usage":{}}']));
    assert.equal(one.isError, true);
    assert.equal(one.terminalReason, "malformed_line");
  }
});

test("[M5a] 과대 줄은 내용을 버리고 프로토콜 실패로 처리한다(개행 있든 없든)", () => {
  const huge = `{"type":"item.completed","item":{"item_type":"agent_message","text":"${"x".repeat(MAX_LINE_CHARS)}"}}`;
  const withNewline = run([`{"type":"thread.started","thread_id":"${TID}"}`, huge, '{"type":"turn.completed","usage":{}}']);
  assert.ok(markers(withNewline).includes("oversized_line"));
  const r = only(withNewline);
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "oversized_line");
  for (const e of withNewline) if (e.kind === "assistant") assert.ok(!e.text.includes("xxxx"));

  const p = parser();
  const noNewline = p.push(huge); // 개행 없이 상한 초과 → 버퍼를 붙잡지 않는다
  assert.ok(noNewline.some((e) => e.kind === "unknown" && e.type === "oversized_line"));
  assert.equal(p.malformedLines, 1);
  assert.equal(p.protocolFailed, true);
});

test("[M5a] 텍스트·usage 상한: 긴 메시지는 절삭, 계약 밖 usage는 0", () => {
  const long = "가".repeat(MAX_TEXT_CHARS + 100);
  const events = run([
    `{"type":"thread.started","thread_id":"${TID}"}`,
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

test("[M5a] 형태가 유효한 모르는 이벤트·item은 bounded unknown이고 성공 근거가 아니다", () => {
  const events = run([
    `{"type":"thread.started","thread_id":"${TID}"}`,
    '{"type":"turn.future_thing","payload":{"a":1}}',
    '{"type":"item.completed","item":{"id":"i","item_type":"web_search","query":"q"}}',
  ]);
  assert.deepEqual(markers(events), ["turn.future_thing", "item.completed:web_search"]);
  const r = only(events);
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "no_terminal_event", "모르는 이벤트만으로는 성공도 프로토콜 실패도 아니다");

  // 같은 스트림에 정상 종료가 오면 전방 호환 이벤트는 성공을 막지 않는다.
  const ok = only(run([...SUCCESS.slice(0, 2), '{"type":"turn.future_thing"}', ...SUCCESS.slice(2)]));
  assert.equal(ok.isError, false);
});

test("[M5a] MCP 호출 이벤트가 보이면 비가역 실패다(뒤에 성공 종료가 와도 뒤집히지 않는다)", () => {
  for (const line of [
    '{"type":"item.completed","item":{"id":"i","item_type":"mcp_tool_call","server":"s","tool":"t"}}',
    '{"type":"item.started","item":{"id":"i","item_type":"mcp_tool_call"}}',
  ]) {
    const events = run([`{"type":"thread.started","thread_id":"${TID}"}`, line, '{"type":"turn.completed","usage":{}}']);
    assert.ok(markers(events).includes("mcp_call_observed"));
    const r = only(events);
    assert.equal(r.isError, true);
    assert.equal(r.terminalReason, "mcp_call_observed");
  }
  // 성공 종료가 **먼저** 오고 그 뒤에 MCP가 관측돼도 실패다.
  const late = only(run([...SUCCESS, '{"type":"item.completed","item":{"id":"z","item_type":"mcp_tool_call"}}']));
  assert.equal(late.isError, true);
  assert.equal(late.terminalReason, "mcp_call_observed");
});

test("[M5a] turn.failed / error는 bounded·scrubbed 요약만 싣는다", () => {
  const failed = only(
    run([
      `{"type":"thread.started","thread_id":"${TID}"}`,
      '{"type":"turn.failed","error":{"message":"boom api_key=SUPERSECRET happened"}}',
    ]),
  );
  assert.equal(failed.isError, true);
  assert.equal(failed.terminalReason, "turn_failed");
  assert.ok(!failed.text.includes("SUPERSECRET"), "secret은 가려진다");
  assert.ok(failed.text.includes("boom"));

  const errored = only(run([`{"type":"thread.started","thread_id":"${TID}"}`, '{"type":"error","message":"stream broke"}'], { code: 1 }));
  assert.equal(errored.terminalReason, "error");
  assert.equal(errored.text, "stream broke");
});

test("[M5a] 권한·비대화 승인 불가 실패는 permission_required로 매핑된다", () => {
  const r = only(
    run([
      `{"type":"thread.started","thread_id":"${TID}"}`,
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

test("[M5a] 중복·모순 종료 이벤트는 성공이 아니라 프로토콜 실패다", () => {
  // 성공 → 실패 → 성공: 첫 outcome을 채택하고도 결과는 실패여야 한다.
  const conflicting = run([
    `{"type":"thread.started","thread_id":"${TID}"}`,
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
    '{"type":"turn.failed","error":{"message":"late failure"}}',
    '{"type":"turn.completed","usage":{"input_tokens":9}}',
  ]);
  assert.equal(markers(conflicting).filter((m) => m === "duplicate_terminal").length, 2);
  const r = only(conflicting);
  assert.equal(r.isError, true, "성공 뒤 종료 이벤트가 더 오면 성공으로 보고하지 않는다");
  assert.equal(r.terminalReason, "conflicting_terminal");
  assert.equal(r.usage.inputTokens, 1, "채택된 outcome의 usage만 남는다");

  // 성공 → 성공(같은 종류 중복)
  const dup = only(run([...SUCCESS, '{"type":"turn.completed","usage":{}}']));
  assert.equal(dup.isError, true);
  assert.equal(dup.terminalReason, "duplicate_terminal");
});

test("[M5a] 종료 뒤 이벤트는 세션 신원도 최종 메시지도 바꾸지 못한다", () => {
  const events = run([
    ...SUCCESS,
    `{"type":"thread.started","thread_id":"${TID2}"}`,
    '{"type":"item.completed","item":{"id":"z","item_type":"agent_message","text":"OVERWRITE"}}',
  ]);
  assert.equal(markers(events).filter((m) => m === "post_terminal_event").length, 2);
  const r = only(events);
  assert.equal(r.sessionId, TID, "세션 신원 불변");
  assert.ok(!r.text.includes("OVERWRITE"), "최종 메시지 불변");
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "post_terminal_event");
});

test("[M5a] 세션 신원: 정규 UUID 하나만 인정하고 적대적 값은 전부 거부", () => {
  const hostile = ["", "--last", "not-a-uuid", "0199A1B2-C3D4-4E5F-8A9B-0C1D2E3F4A5B", `${TID} --last`, "123"];
  for (const id of hostile) {
    const r = only(run([JSON.stringify({ type: "thread.started", thread_id: id }), '{"type":"turn.completed","usage":{}}']));
    assert.equal(r.isError, true, `거부해야 한다: ${id}`);
    assert.equal(r.terminalReason, "invalid_session_id", `거부 사유: ${id}`);
    assert.equal(r.sessionId, "", "잘못된 id는 세션 신원이 되지 않는다");
  }
  // 숫자·객체 같은 비문자열도 마찬가지
  const nonString = only(run(['{"type":"thread.started","thread_id":123}', '{"type":"turn.completed","usage":{}}']));
  assert.equal(nonString.terminalReason, "invalid_session_id");
});

test("[M5a] 세션 신원: 중복·모순 thread.started는 프로토콜 실패", () => {
  const dup = only(
    run([`{"type":"thread.started","thread_id":"${TID}"}`, `{"type":"thread.started","thread_id":"${TID}"}`, '{"type":"turn.completed","usage":{}}']),
  );
  assert.equal(dup.terminalReason, "duplicate_session_id");

  const conflict = only(
    run([`{"type":"thread.started","thread_id":"${TID}"}`, `{"type":"thread.started","thread_id":"${TID2}"}`, '{"type":"turn.completed","usage":{}}']),
  );
  assert.equal(conflict.terminalReason, "conflicting_session_id");
  assert.equal(conflict.sessionId, TID, "첫 신원은 바뀌지 않는다");
});

test("[M5a] 세션 신원: 이벤트는 흘렀는데 thread.started가 없으면 실패", () => {
  const r = only(run(['{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":3}}']));
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "missing_session_id");
  assert.equal(r.sessionId, "");
});

test("[M5a] 세션 신원: 신원 확립 전 이벤트는 비가역 실패이고 내용·도구를 전달하지 않는다", () => {
  const before: Array<[string, string]> = [
    ["turn.started", '{"type":"turn.started"}'],
    ["assistant", '{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"EARLY_TEXT_SENTINEL"}}'],
    ["command", '{"type":"item.completed","item":{"id":"i","item_type":"command_execution","command":"ls /etc/shadow","status":"completed","exit_code":0}}'],
    ["item.started", '{"type":"item.started","item":{"id":"i","item_type":"reasoning"}}'],
    ["unknown", '{"type":"vendor.future","payload":{"leak":"EARLY_TEXT_SENTINEL"}}'],
    ["error", '{"type":"error","message":"EARLY_TEXT_SENTINEL"}'],
  ];
  for (const [label, line] of before) {
    // 신원 확립 전 이벤트 → 뒤늦게 thread.started와 정상 종료가 와도 성공이 아니다.
    const events = run([
      line,
      `{"type":"thread.started","thread_id":"${TID}"}`,
      '{"type":"item.completed","item":{"id":"i2","item_type":"agent_message","text":"LATE_TEXT_SENTINEL"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
    ]);
    const r = only(events);
    assert.equal(r.isError, true, `${label}: 신원 없이 시작한 스트림은 성공이 아니다`);
    assert.equal(r.terminalReason, "missing_session_id", label);
    assert.equal(r.sessionId, "", `${label}: 늦은 thread.started도 신원을 세우지 못한다`);
    assert.deepEqual(markers(events), ["missing_session_id"], `${label}: 실패 표시는 1건이고 뒤 이벤트는 방출되지 않는다`);
    assert.equal(events.filter((e) => e.kind === "init").length, 0, `${label}: init이 없다`);
    assert.equal(events.filter((e) => e.kind === "assistant" || e.kind === "status").length, 0, `${label}: 내용·진행 이벤트 0`);
    assert.deepEqual(events.flatMap((e) => (e.kind === "assistant" ? e.toolUses : [])), [], `${label}: 도구 payload 0`);
    const blob = JSON.stringify(events);
    assert.ok(!blob.includes("EARLY_TEXT_SENTINEL") && !blob.includes("LATE_TEXT_SENTINEL"), `${label}: 본문이 새지 않는다`);
    assert.ok(!blob.includes("/etc/shadow"), `${label}: 명령이 새지 않는다`);
    assert.equal(r.numTurns, 0, label);
  }
});

test("[M5a] 세션 신원: 형식 위반 thread.started 뒤에 정규 UUID가 와도 되돌리지 못한다", () => {
  const events = run([
    '{"type":"thread.started","thread_id":"--last"}',
    `{"type":"thread.started","thread_id":"${TID}"}`,
    '{"type":"turn.completed","usage":{}}',
  ]);
  const r = only(events);
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "invalid_session_id", "첫 실패가 이긴다");
  assert.equal(r.sessionId, "");
  assert.equal(events.filter((e) => e.kind === "init").length, 0);
});

test("[M5a] resume 기대 신원: 다른 thread는 init 전에 봉인되고 같은 chunk의 뒷줄까지 막힌다", () => {
  const p = new CodexJsonlParser({ ...CTX, expectedSessionId: TID });
  const hostile = [
    `{"type":"thread.started","thread_id":"${TID2}"}`,
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"h","item_type":"agent_message","text":"HIJACK_SENTINEL"}}',
    '{"type":"item.completed","item":{"id":"h2","item_type":"command_execution","command":"HIJACK_CMD","status":"completed","exit_code":0}}',
    '{"type":"turn.completed","usage":{"input_tokens":77}}',
  ];
  // 한 번의 push에 전부 들어온다(최악의 경우).
  const emitted = p.push(`${hostile.join("\n")}\n`);
  assert.deepEqual(emitted.map((e) => e.kind), ["unknown"], "봉인 뒤에는 아무것도 방출하지 않는다");
  assert.ok(emitted[0].kind === "unknown" && emitted[0].type === "session_identity_conflict");
  assert.equal(emitted[0].sessionId, TID, "marker는 기대 UUID에 묶인다");
  assert.equal(p.sessionId, TID, "관측된 다른 id가 신원을 대체하지 않는다");
  assert.equal(p.protocolFailed, true);

  // 봉인 이후 도착한 chunk도 무시된다.
  assert.deepEqual(p.push('{"type":"item.completed","item":{"item_type":"agent_message","text":"LATE_SENTINEL"}}\n'), []);

  const out = p.finish({ code: 0, signal: null });
  assert.equal(out.length, 1);
  const r = out[0];
  assert.ok(r.kind === "result");
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "session_identity_conflict");
  assert.equal(r.sessionId, TID);
  assert.equal(r.numTurns, 0);
  assert.equal(r.usage.inputTokens, 0, "하이재킹된 usage를 채택하지 않는다");
  const blob = JSON.stringify([...emitted, ...out]);
  for (const bad of ["HIJACK_SENTINEL", "HIJACK_CMD", "LATE_SENTINEL", TID2]) {
    assert.ok(!blob.includes(bad), `'${bad}'가 새어나갔다`);
  }
});

test("[M5a] resume 기대 신원: 같은 UUID면 정상 진행하고, 기대값 자체는 정규 UUID여야 한다", () => {
  const p = new CodexJsonlParser({ ...CTX, expectedSessionId: TID });
  const out: SessionEvent[] = [];
  for (const l of SUCCESS) for (const e of p.push(`${l}\n`)) out.push(e);
  for (const e of p.finish({ code: 0, signal: null })) out.push(e);
  const init = out.find((e) => e.kind === "init");
  assert.ok(init && init.kind === "init" && init.sessionId === TID, "기대 신원과 같으면 init이 정상 발행된다");
  const r = out.filter((e) => e.kind === "result")[0];
  assert.ok(r && r.kind === "result" && r.isError === false);

  for (const bad of ["--last", "", "not-a-uuid", `${TID} --last`]) {
    assert.throws(
      () => new CodexJsonlParser({ ...CTX, expectedSessionId: bad }),
      (err: unknown) => (err as { code?: string }).code === "codex_resume_id_invalid",
      `기대값 거부: ${bad}`,
    );
  }
});

test("[M5a] 이벤트 수 상한을 넘기면 종료 결과가 실패다", () => {
  const lines = Array.from({ length: MAX_EVENTS + 5 }, () => '{"type":"turn.started"}');
  const events = run([`{"type":"thread.started","thread_id":"${TID}"}`, ...lines, '{"type":"turn.completed","usage":{}}']);
  assert.ok(markers(events).includes("event_limit_exceeded"));
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
  assert.equal(p.sessionId, TID);
});

test("[M5a] 개행 없이 끝난 마지막 줄도 finish에서 소진된다", () => {
  const p = parser();
  p.push(`{"type":"thread.started","thread_id":"${TID}"}\n`);
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

test("[M5a] protocolFail: provider가 스트림 밖 위반을 같은 비가역 실패로 넣는다", () => {
  const p = parser();
  p.push(`${SUCCESS.join("\n")}\n`);
  p.protocolFail("session_identity_conflict", "token=SUPERSECRET detail");
  const out = p.finish({ code: 0, signal: null });
  const r = out[0];
  assert.ok(r && r.kind === "result");
  assert.equal(r.isError, true);
  assert.equal(r.terminalReason, "session_identity_conflict");
  assert.ok(!JSON.stringify(r).includes("SUPERSECRET"));
});
