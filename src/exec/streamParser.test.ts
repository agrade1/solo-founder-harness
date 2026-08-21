/**
 * 실행 계층 파서 + mock provider 단위 테스트. node:test (내장, 무의존).
 * 실행: `npm run test:exec` (tsx --test). fixture = 실제 stream-json 프로브 캡처.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAll, parseLine, NdjsonParser } from "./streamParser.js";
import { MockExecProvider } from "./mockExecProvider.js";
import type { SessionEvent, SessionSpec } from "./types.js";

const FIXTURE = readFileSync(fileURLToPath(new URL("./__fixtures__/probe.ndjson", import.meta.url)), "utf8");

test("parseAll: 캡처된 14개 이벤트를 전부 파싱", () => {
  const events = parseAll(FIXTURE);
  assert.equal(events.length, 14);
  assert.ok(events.every((e) => e.kind !== undefined));
});

test("init 이벤트: session_id·model·cwd 추출", () => {
  const init = parseAll(FIXTURE).find((e) => e.kind === "init");
  assert.ok(init, "init 이벤트 존재");
  assert.equal(init!.kind, "init");
  if (init!.kind === "init") {
    assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(init.model.startsWith("claude-opus"));
    assert.ok(init.tools.length > 0);
    assert.ok(Array.isArray(init.mcpServers)); // 기존 probe fixture는 mcp_servers:[]
    assert.deepEqual(init.mcpServers, []);
  }
});

test("[M3a] init.mcpServers 정규화: connected만 true, pending/failed/needs-auth는 false", () => {
  const nd =
    '{"type":"system","subtype":"init","session_id":"s","mcp_servers":' +
    '[{"name":"a","status":"connected"},{"name":"b","status":"pending"},' +
    '{"name":"c","status":"failed"},{"name":"d","status":"needs-auth"}]}';
  const e = parseLine(nd);
  assert.equal(e?.kind, "init");
  if (e?.kind === "init") {
    assert.deepEqual(e.mcpServers, [
      { name: "a", status: "connected", connected: true },
      { name: "b", status: "pending", connected: false },
      { name: "c", status: "failed", connected: false },
      { name: "d", status: "needs-auth", connected: false },
    ]);
  }
});

test("result 이벤트: 종료 신호 + usage/numTurns/비용", () => {
  const result = parseAll(FIXTURE).find((e) => e.kind === "result");
  assert.ok(result);
  if (result!.kind === "result") {
    assert.equal(result.isError, false);
    assert.equal(result.numTurns, 1);
    assert.equal(result.text, "ok");
    assert.ok(result.usage.inputTokens > 0);
    assert.ok(result.totalCostUsd > 0);
    assert.deepEqual(result.permissionDenials, []);
  }
});

test("rateLimit 이벤트: resetsAt·rateLimitType 추출 (강등 신호)", () => {
  const rl = parseAll(FIXTURE).find((e) => e.kind === "rateLimit");
  assert.ok(rl);
  if (rl!.kind === "rateLimit") {
    assert.equal(rl.status, "allowed");
    assert.equal(rl.rateLimitType, "five_hour");
    assert.ok(rl.resetsAt > 0);
  }
});

test("assistant 이벤트: text 추출", () => {
  const a = parseAll(FIXTURE).find((e) => e.kind === "assistant");
  assert.ok(a);
  if (a!.kind === "assistant") assert.equal(a.text, "ok");
});

test("parseLine: 빈 줄·깨진 JSON은 null", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("{not json"), null);
  assert.equal(parseLine('{"no_type":true}'), null);
});

test("normalize: 알 수 없는 type은 kind:unknown", () => {
  const e = parseLine('{"type":"future_event","session_id":"s1"}');
  assert.ok(e);
  assert.equal(e!.kind, "unknown");
});

test("NdjsonParser: 청크가 줄 경계를 가로질러도 동일 결과", () => {
  const parser = new NdjsonParser();
  const collected: SessionEvent[] = [];
  // 3바이트씩 쪼개 흘려도 파서가 줄을 복원해야 함
  for (let i = 0; i < FIXTURE.length; i += 3) {
    for (const e of parser.push(FIXTURE.slice(i, i + 3))) collected.push(e);
  }
  for (const e of parser.flush()) collected.push(e);
  assert.equal(collected.length, parseAll(FIXTURE).length);
});

test("MockExecProvider: start → init·assistant·result 재생 (무과금)", async () => {
  const provider = new MockExecProvider();
  const spec: SessionSpec = { sessionId: "test-session", role: "테스트", cwd: "/tmp", model: "mock" };
  const handle = await provider.start(spec, "화면 하나 만들어");
  const kinds: string[] = [];
  for await (const e of provider.events(handle)) kinds.push(e.kind);
  assert.deepEqual(kinds, ["init", "assistant", "result"]);
});

test("MockExecProvider: send로 후속 turn 재생", async () => {
  const provider = new MockExecProvider();
  const spec: SessionSpec = { sessionId: "s2", role: "r", cwd: "/tmp" };
  const handle = await provider.start(spec, "first");
  for await (const _ of provider.events(handle)) { /* drain */ }
  await provider.send(handle, "second");
  let sawResult = false;
  for await (const e of provider.events(handle)) if (e.kind === "result") sawResult = true;
  assert.ok(sawResult);
});
