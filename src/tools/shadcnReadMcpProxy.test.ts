/**
 * [V3 M3c-3a] shadcn read-only filtering MCP proxy offline 테스트.
 * downstream은 임시 PATH의 fake `npx`(CJS fixture)로만 검증. 실제 npx/network/Claude 미실행.
 * upstream은 공식 MCP 계약(bare tool name, initialize→initialized→tools/*)으로 구동한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runShadcnReadProxy, ShadcnProxyError } from "./shadcnReadMcpProxy.js";
import { getAllowedTools, getForbiddenTools, nsName } from "./shadcnReadPolicy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_PROXY = join(HERE, "..", "..", "dist", "tools", "shadcnReadMcpProxy.js");
const BARE5 = getAllowedTools();

function homeLeftovers(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("m3c3-home-"));
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const FIXTURE_SRC = `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(join(__dirname, "scp-config.json"), "utf8")); } catch {}
const MODE = cfg.mode || "normal";
const PV = cfg.pv || "2025-11-25";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const rec = (f, m) => { try { fs.appendFileSync(join(__dirname, f), String(m) + "\\n"); } catch {} };
try { fs.writeFileSync(join(__dirname, "scp-env.txt"), JSON.stringify(process.env)); } catch {}
const BARE7 = ["get_add_command_for_items","get_audit_checklist","get_item_examples_from_registries","get_project_registries","list_items_in_registries","search_items_in_registries","view_items_in_registries"];
let grandchild = null;
if (cfg.spawnGrandchild) { grandchild = cp.spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" }); try { fs.writeFileSync(join(__dirname, "scp-grandchild.pid"), String(grandchild.pid)); } catch {} }
function initResult() {
  if (MODE === "badInitProtocol") return { protocolVersion: "zzz-bad", capabilities: { tools: {} }, serverInfo: { name: "shadcn", version: "1" } };
  if (MODE === "noCapsTools") return { protocolVersion: PV, capabilities: {}, serverInfo: { name: "shadcn", version: "1" } };
  if (MODE === "noServerInfo") return { protocolVersion: PV, capabilities: { tools: {} } };
  return { protocolVersion: PV, capabilities: { tools: {} }, serverInfo: { name: "shadcn", version: "1.0.0" } };
}
function toolsList() { const names = MODE === "toolsMismatch" ? BARE7.slice(0, 6) : BARE7; return { tools: names.map((n) => ({ name: n, description: n + " downstream desc", inputSchema: { type: "object", properties: { anything: { type: "string" } } } })) }; }
function callResult(name) {
  const fault = (cfg.faultTool === name) ? cfg.faultType : null;
  if (fault === "hang") return null;
  if (fault === "isError") return { content: [{ type: "text", text: "boom" }], isError: true };
  if (fault === "empty") return { content: [] };
  if (fault === "structured") return { content: [{ type: "text", text: "ok" }], structuredContent: { a: 1 } };
  if (fault === "nonText") return { content: [{ type: "image", data: "AAAA" }] };
  if (fault === "tooLargeResult") return { content: [{ type: "text", text: "y".repeat(9000) }] };
  if (fault === "rawTooLarge") return { content: [{ type: "text", text: "x".repeat(300 * 1024) }] };
  return { content: [{ type: "text", text: "ok " + name }] };
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim(); if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  rec("scp-methods.txt", m.method);
  if (m.method === "notifications/initialized") return;
  if (m.method === "initialize") { if (cfg.hangInitialize) return; send({ jsonrpc: "2.0", id: m.id, result: initResult() }); return; }
  if (m.method === "tools/list") { send({ jsonrpc: "2.0", id: m.id, result: toolsList() }); return; }
  if (m.method === "tools/call") {
    const name = m.params && m.params.name;
    rec("scp-calls.txt", name);
    rec("scp-callargs.txt", JSON.stringify((m.params && m.params.arguments) || {}));
    const fault = (cfg.faultTool === name) ? cfg.faultType : null;
    if (fault === "malformedLine") { process.stdout.write("this is not json at all\\n"); return; } // 응답 계약 위반 → fatal
    if (fault === "badResult") { send({ jsonrpc: "2.0", id: m.id, result: "not-an-object" }); return; } // result 계약 위반 → fatal
    if (fault === "jsonRpcError") { send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "tool failed" } }); return; } // 일반 tool error → 세션 유지
    const r = callResult(name);
    if (r === null) return;
    send({ jsonrpc: "2.0", id: m.id, result: r });
    return;
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nf" } });
});
`;

function mkFixtureDir(cfg: Record<string, unknown>, componentsJson?: string): { dir: string; binDir: string; serviceCwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "scp3-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "npx"), FIXTURE_SRC, "utf8");
  chmodSync(join(binDir, "npx"), 0o755);
  writeFileSync(join(binDir, "scp-config.json"), JSON.stringify(cfg), "utf8");
  const serviceCwd = join(dir, "svc");
  mkdirSync(serviceCwd, { recursive: true });
  writeFileSync(join(serviceCwd, "components.json"), componentsJson ?? JSON.stringify({ registries: {} }), "utf8");
  return { dir, binDir, serviceCwd };
}
function readLines(binDir: string, f: string): string[] {
  const p = join(binDir, f);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

interface DriveOpts {
  componentsJson?: string;
  perCallTimeoutMs?: number;
  ambientSecret?: boolean;
  noEnd?: boolean;
  useAbort?: boolean;
  cleanupFault?: boolean;
}

async function driveProxy(cfg: Record<string, unknown>, requests: (Record<string, unknown> | string)[], opts: DriveOpts = {}) {
  const { dir, binDir, serviceCwd } = mkFixtureDir(cfg, opts.componentsJson);
  const input = new PassThrough();
  const output = new PassThrough();
  const outLines: Record<string, unknown>[] = [];
  let obuf = "";
  output.on("data", (d) => {
    obuf += d.toString();
    let idx: number;
    while ((idx = obuf.indexOf("\n")) >= 0) {
      const line = obuf.slice(0, idx).trim();
      obuf = obuf.slice(idx + 1);
      if (line) try { outLines.push(JSON.parse(line)); } catch { /* */ }
    }
  });
  const homesBefore = new Set(homeLeftovers());
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ":" + (prevPath ?? "");
  const prevTok = process.env.M3C3_AMBIENT_TOKEN;
  const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
  if (opts.ambientSecret) {
    process.env.M3C3_AMBIENT_TOKEN = "tok-ambient-leak-xyz";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-leak-xyz";
  }
  const ac = new AbortController();
  const diags: string[] = [];
  try {
    const p = runShadcnReadProxy({ serviceCwd, now: () => "t", input, output, perCallTimeoutMs: opts.perCallTimeoutMs ?? 4000, onDiagnostic: (c) => diags.push(c), abortSignal: opts.useAbort ? ac.signal : undefined, cleanupFaultForTest: opts.cleanupFault });
    for (const r of requests) input.write((typeof r === "string" ? r : JSON.stringify(r)) + "\n");
    if (opts.useAbort) setTimeout(() => ac.abort(), 150);
    else if (!opts.noEnd) input.end();
    const result = await p;
    return { result, err: undefined, outLines, diags, dir, binDir, serviceCwd, homesBefore, methods: readLines(binDir, "scp-methods.txt"), calls: readLines(binDir, "scp-calls.txt"), callArgs: readLines(binDir, "scp-callargs.txt") };
  } catch (e) {
    return { result: undefined, err: e as Error, outLines, diags, dir, binDir, serviceCwd, homesBefore, methods: readLines(binDir, "scp-methods.txt"), calls: readLines(binDir, "scp-calls.txt"), callArgs: readLines(binDir, "scp-callargs.txt") };
  } finally {
    process.env.PATH = prevPath;
    if (opts.ambientSecret) {
      if (prevTok === undefined) delete process.env.M3C3_AMBIENT_TOKEN;
      else process.env.M3C3_AMBIENT_TOKEN = prevTok;
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
    }
  }
}

const byId = (out: Record<string, unknown>[], id: unknown) => out.find((m) => m.id === id);
const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
const notif = (method: string) => ({ jsonrpc: "2.0", method });
const call = (id: number, bare: string, args: unknown) => req(id, "tools/call", { name: bare, arguments: args }); // bare name!
const INIT: (Record<string, unknown> | string)[] = [req(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {} }), notif("notifications/initialized")];

// ── 정상 왕복 + bare/host mapping ─────────────────────────────────────────────

test("[M3c-3a] initialize→initialized→tools/list→tools/call 정상 + tools/list bare 5개 exact(금지/extra/double-ns 부재)", async () => {
  const out = await driveProxy({ mode: "normal" }, [...INIT, req(2, "tools/list"), call(3, "get_project_registries", {})]);
  try {
    assert.ok(out.result, out.err?.message);
    const init = byId(out.outLines, 1) as { result?: { serverInfo?: { name?: string }; protocolVersion?: string } } | undefined;
    assert.equal(init?.result?.serverInfo?.name, "shadcn-read-proxy");
    assert.equal(init?.result?.protocolVersion, "2025-11-25", "downstream negotiated pv 사용");
    const tl = byId(out.outLines, 2) as { result?: { tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[] } } | undefined;
    const names = (tl?.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, [...BARE5].sort(), "bare 5개 exact");
    for (const n of names) assert.ok(!n.startsWith("mcp__"), "double namespace 부재");
    // host mapping을 별도 계산하면 mcp__shadcn__<bare> 5개
    assert.deepEqual(names.map(nsName).sort(), BARE5.map(nsName).sort());
    for (const f of getForbiddenTools()) assert.ok(!names.includes(f));
    for (const t of tl!.result!.tools!) {
      assert.ok(!/downstream desc/.test(t.description), "downstream desc 미노출");
      assert.equal(t.inputSchema.additionalProperties, false);
    }
    const cr = byId(out.outLines, 3) as { result?: { content?: { type: string }[] } } | undefined;
    assert.equal(cr?.result?.content?.[0]?.type, "text");
    assert.equal(out.result!.toolCalls, 1);
    assert.deepEqual(out.result!.calledTools, [nsName("get_project_registries")], "calledTools는 내부 host-namespaced");
    assert.equal(out.result!.cleanupOk, true);
    assert.deepEqual(out.calls, ["get_project_registries"]);
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] 허용 5개 호출·정확 인자 downstream 전달(bare)", async () => {
  const out = await driveProxy({ mode: "normal" }, [
    ...INIT,
    call(2, "get_project_registries", {}),
    call(3, "list_items_in_registries", { registries: ["@shadcn"], types: ["ui"], limit: 1, offset: 0 }),
    call(4, "search_items_in_registries", { registries: ["@shadcn"], types: ["ui"], query: "button", limit: 1, offset: 0 }),
    call(5, "view_items_in_registries", { items: ["@shadcn/button"] }),
    call(6, "get_item_examples_from_registries", { registries: ["@shadcn"], query: "button-demo" }),
  ]);
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal(out.result!.toolCalls, 5);
    assert.deepEqual(out.calls, BARE5);
    assert.ok(!out.callArgs.some((a) => a.includes("@private")));
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── startup 거부 ──────────────────────────────────────────────────────────────

test("[M3c-3a] downstream 7 불일치 → ds_tools_mismatch(serve 없음)", async () => {
  const out = await driveProxy({ mode: "toolsMismatch" }, [...INIT, req(2, "tools/list")]);
  try {
    assert.equal((out.err as ShadcnProxyError)?.code, "ds_tools_mismatch");
    assert.equal(out.outLines.length, 0);
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] downstream init 계약 위반 → startup 거부", async () => {
  for (const [mode, code] of [
    ["badInitProtocol", "ds_protocol_version"],
    ["noCapsTools", "ds_capabilities"],
    ["noServerInfo", "ds_server_info"],
  ] as const) {
    const out = await driveProxy({ mode }, [...INIT]);
    try {
      assert.equal((out.err as ShadcnProxyError)?.code, code, `mode=${mode}`);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

test("[M3c-3a] custom registry → child spawn 전 차단(fixture 미실행)", async () => {
  const out = await driveProxy({ mode: "normal" }, [...INIT], { componentsJson: JSON.stringify({ registries: { "@acme": "https://x/" } }) });
  try {
    assert.equal((out.err as ShadcnProxyError)?.code, "registry_custom_registry_forbidden");
    assert.ok(!existsSync(join(out.binDir, "scp-env.txt")), "fixture 미실행");
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── 필터/정책 ─────────────────────────────────────────────────────────────────

test("[M3c-3a] forbidden/unknown/namespaced 입력 → downstream 호출 전 차단", async () => {
  const out = await driveProxy({ mode: "normal" }, [
    ...INIT,
    call(2, "get_add_command_for_items", {}),
    call(3, "get_audit_checklist", {}),
    call(4, "totally_unknown", {}),
    call(5, nsName("get_project_registries"), {}), // 이미 prefix → unknown 취급
  ]);
  try {
    assert.ok(out.result, out.err?.message);
    for (const id of [2, 3, 4, 5]) assert.ok((byId(out.outLines, id) as { error?: unknown })?.error, `id=${id} error`);
    assert.equal(out.result!.forbiddenAttempts, 2);
    assert.equal(out.result!.toolCalls, 0);
    assert.equal(out.calls.length, 0, "downstream 미수신");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] 도구별 잘못된 registry/추가 key/범위/traversal/URL/제어문자 거부(child 미호출)", async () => {
  const bad: [string, unknown][] = [
    ["list_items_in_registries", { registries: ["@private"], types: ["ui"] }],
    ["list_items_in_registries", { registries: ["@shadcn"], types: ["ui"], extra: 1 }],
    ["list_items_in_registries", { registries: ["@shadcn"], types: ["ui"], limit: 999 }],
    ["list_items_in_registries", { registries: ["@shadcn"], types: ["blocks"] }],
    ["search_items_in_registries", { registries: ["@shadcn"], types: ["ui"], query: "" }],
    ["view_items_in_registries", { items: ["@shadcn/../../etc/passwd"] }],
    ["view_items_in_registries", { items: ["https://evil/x"] }],
    ["view_items_in_registries", { items: ["other/button"] }],
    ["get_project_registries", { x: 1 }],
    ["get_item_examples_from_registries", { registries: ["@private"], query: "x" }],
  ];
  const reqs: (Record<string, unknown> | string)[] = [...INIT];
  bad.forEach(([tool, args], i) => reqs.push(call(100 + i, tool, args)));
  const out = await driveProxy({ mode: "normal" }, reqs);
  try {
    assert.ok(out.result, out.err?.message);
    for (let i = 0; i < bad.length; i++) assert.equal((byId(out.outLines, 100 + i) as { error?: { code: number } })?.error?.code, -32602, `bad[${i}]`);
    assert.equal(out.calls.length, 0);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] 7번째 호출 차단(-32000), downstream 6건까지", async () => {
  const reqs: (Record<string, unknown> | string)[] = [...INIT];
  for (let i = 0; i < 7; i++) reqs.push(call(200 + i, "get_project_registries", {}));
  const out = await driveProxy({ mode: "normal" }, reqs);
  try {
    assert.ok(out.result, out.err?.message);
    for (let i = 0; i < 6; i++) assert.ok((byId(out.outLines, 200 + i) as { result?: unknown })?.result);
    assert.equal((byId(out.outLines, 206) as { error?: { code: number } })?.error?.code, -32000);
    assert.equal(out.calls.length, 6);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] result 8,000/256KiB/timeout/isError/빈/structured/non-text → 안전 error(원문 미전달)", async () => {
  const cases: [string, number][] = [
    ["tooLargeResult", 4000],
    ["rawTooLarge", 4000],
    ["hang", 400],
    ["isError", 4000],
    ["empty", 4000],
    ["structured", 4000],
    ["nonText", 4000],
  ];
  for (const [faultType, timeout] of cases) {
    // 정책 거부(isError/empty/structured/nonText/tooLargeResult)는 downstream을 죽이지 않으므로 input end로 finalize.
    // fatal(rawTooLarge/hang)은 스스로 finalize하지만 end해도 무방하다.
    const out = await driveProxy({ mode: "normal", faultTool: "get_project_registries", faultType }, [...INIT, call(2, "get_project_registries", {})], { perCallTimeoutMs: timeout });
    try {
      assert.ok(out.result, out.err?.message);
      const r = byId(out.outLines, 2) as { error?: unknown; result?: unknown } | undefined;
      assert.ok(r?.error && !r.result, `faultType=${faultType}`);
      assert.ok(!/yyyyyyyy|xxxxxxxx|"boom"/.test(JSON.stringify(out.outLines)), `${faultType} 원문 미노출`);
      assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), [], `${faultType} 임시 HOME 잔존 없음`);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

// ── 상태 머신 / notification / id 구분 ────────────────────────────────────────

test("[M3c-3a] lifecycle 순서 강제 + unknown notification 무응답 + numeric/string id 구분", async () => {
  const out = await driveProxy({ mode: "normal" }, [
    req(10, "tools/list"), // initialize 전 → not initialized
    req(1, "initialize", { protocolVersion: "2025-11-25" }),
    req(11, "tools/list"), // initialized 전 → not initialized
    notif("notifications/initialized"),
    notif("some/unknown/notification"), // notification → 무응답
    req("1", "tools/list"), // string "1" ≠ number 1(initialize) → 정상
    req(5, "tools/list"),
    req(5, "tools/list"), // duplicate number id
  ]);
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal((byId(out.outLines, 10) as { error?: { code: number } })?.error?.code, -32600, "init 전 거부");
    assert.equal((byId(out.outLines, 11) as { error?: { code: number } })?.error?.code, -32600, "initialized 전 거부");
    assert.ok((byId(out.outLines, "1") as { result?: unknown })?.result, "string id '1'는 number 1과 구분 → 정상");
    const dup5 = out.outLines.filter((m) => m.id === 5);
    assert.ok(dup5.some((m) => (m as { result?: unknown }).result) && dup5.some((m) => (m as { error?: { code: number } }).error?.code === -32600), "number 5 중복 → 하나는 error");
    // unknown notification에는 응답 없음(id 없는 응답이 없어야)
    assert.ok(!out.outLines.some((m) => !("id" in m)));
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── buffer/queue 상한 ─────────────────────────────────────────────────────────

test("[M3c-3a] 개행 없는 대형 buffer → line too large(-32700)", async () => {
  const outA = await driveProxy({ mode: "normal" }, [...INIT, "x".repeat(300 * 1024)]);
  try {
    assert.ok(outA.result, outA.err?.message);
    assert.ok(outA.outLines.some((m) => (m as { error?: { code: number } }).error?.code === -32700), "line too large");
  } finally {
    rmSync(outA.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] queue 상한 초과 → queue full (단일 chunk 100 요청)", async () => {
  // INIT + 100 tools/list를 한 chunk로 전달 → drain이 따라오기 전에 큐가 64를 넘겨 초과분은 queue full.
  const lines: string[] = [JSON.stringify(req(1, "initialize", { protocolVersion: "2025-11-25" })), JSON.stringify(notif("notifications/initialized"))];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify(req(300 + i, "tools/list")));
  const out = await driveProxy({ mode: "normal" }, [lines.join("\n")]);
  try {
    assert.ok(out.result, out.err?.message);
    assert.ok(out.outLines.some((m) => (m as { error?: { message?: string } }).error?.message === "queue full"), "queue full 발생");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── fatal → finalize / descendant / signal ───────────────────────────────────

test("[M3c-3a] fatal downstream(rawTooLarge) → 안전 error 후 finalize(open 대기 없음)·descendant 종료", async () => {
  // noEnd: input을 닫지 않아도 fatal 후 프록시가 스스로 finalize 해야 한다.
  const out = await driveProxy({ mode: "normal", faultTool: "get_project_registries", faultType: "rawTooLarge", spawnGrandchild: true }, [...INIT, call(2, "get_project_registries", {})], { noEnd: true });
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal(out.result!.reason, "downstream_fatal");
    assert.ok((byId(out.outLines, 2) as { error?: unknown })?.error, "안전 error 응답");
    const gpid = Number(readLines(out.binDir, "scp-grandchild.pid")[0]);
    let alive = isAlive(gpid);
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      alive = isAlive(gpid);
    }
    if (alive) try { process.kill(gpid, "SIGKILL"); } catch { /* */ }
    assert.equal(alive, false, "descendant 종료");
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] downstream malformed/bad-result(응답 계약 위반) → 즉시 fatal finalize", async () => {
  for (const faultType of ["malformedLine", "badResult"]) {
    const out = await driveProxy({ mode: "normal", faultTool: "get_project_registries", faultType, spawnGrandchild: true }, [...INIT, call(2, "get_project_registries", {})], { noEnd: true });
    try {
      assert.ok(out.result, out.err?.message);
      assert.equal(out.result!.reason, "downstream_fatal", `${faultType} → fatal finalize`);
      assert.ok((byId(out.outLines, 2) as { error?: unknown })?.error, `${faultType} 안전 error 응답`);
      assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

test("[M3c-3a] 일반 JSON-RPC tool error·정책 거부 후에도 세션 유지 → 다음 정상 호출 성공", async () => {
  // faultTool=list_items(tooLargeResult) → result budget 거부. jsonRpcError는 일반 tool error. 모두 downstream 유지.
  const out = await driveProxy({ mode: "normal", faultTool: "list_items_in_registries", faultType: "tooLargeResult" }, [
    ...INIT,
    call(2, "list_items_in_registries", { registries: ["@shadcn"], types: ["ui"] }), // result_too_large 거부(세션 유지)
    call(3, "list_items_in_registries", { registries: ["@private"] }),               // invalid arguments 거부(세션 유지)
    call(4, "get_project_registries", {}),                                            // 이후 정상 호출
  ]);
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal(out.result!.reason, "upstream_end", "fatal 아님 — 정상 종료");
    assert.ok((byId(out.outLines, 2) as { error?: unknown })?.error, "result_too_large 거부");
    assert.ok((byId(out.outLines, 3) as { error?: { code: number } })?.error?.code === -32602, "invalid args 거부");
    assert.ok((byId(out.outLines, 4) as { result?: unknown })?.result, "정책 거부 뒤 정상 호출 성공");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] downstream 일반 JSON-RPC error(tool error)는 fatal 아님 → 세션 유지", async () => {
  const out = await driveProxy({ mode: "normal", faultTool: "get_project_registries", faultType: "jsonRpcError" }, [
    ...INIT,
    call(2, "get_project_registries", {}),      // downstream이 JSON-RPC error → 그 호출만 실패
    call(3, "list_items_in_registries", { registries: ["@shadcn"], types: ["ui"] }), // 이후 정상
  ]);
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal(out.result!.reason, "upstream_end", "downstream 살아있음");
    assert.ok((byId(out.outLines, 2) as { error?: unknown })?.error, "tool error");
    assert.ok((byId(out.outLines, 3) as { result?: unknown })?.result, "이후 정상 호출 성공");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] abortSignal → finalize(signal), cleanup 수행", async () => {
  const out = await driveProxy({ mode: "normal" }, [...INIT, req(2, "tools/list")], { useAbort: true, noEnd: true });
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal(out.result!.reason, "signal");
    assert.equal(out.result!.cleanupOk, true);
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── 보안 env ──────────────────────────────────────────────────────────────────

test("[M3c-3a] child env에 ambient secret 미전달 + 출력 평문 부재", async () => {
  const out = await driveProxy({ mode: "normal" }, [...INIT, call(2, "get_project_registries", {})], { ambientSecret: true });
  try {
    assert.ok(out.result, out.err?.message);
    const env = JSON.parse(readFileSync(join(out.binDir, "scp-env.txt"), "utf8"));
    assert.equal(env.M3C3_AMBIENT_TOKEN, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.ok(!/tok-ambient-leak|aws-secret-leak/.test(JSON.stringify(out.outLines)));
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] malformed/unknown method fail-closed(안전 error), tool 미실행", async () => {
  const out = await driveProxy({ mode: "normal" }, [...INIT, "this is not json", req(2, "no/such/method")]);
  try {
    assert.ok(out.result, out.err?.message);
    assert.ok(out.outLines.some((m) => (m as { error?: { code: number } }).error?.code === -32700), "parse error");
    assert.equal((byId(out.outLines, 2) as { error?: { code: number } })?.error?.code, -32601);
    assert.equal(out.result!.toolCalls, 0);
    assert.equal(out.calls.length, 0);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── 실행 진입점(executable) ──────────────────────────────────────────────────

function runExecutable(cfg: Record<string, unknown>, requests: (Record<string, unknown> | string)[], opts: { componentsJson?: string; env?: Record<string, string>; signalAfterMs?: number; signal?: NodeJS.Signals } = {}): Promise<{ code: number | null; signal: string | null; outLines: Record<string, unknown>[]; stderr: string; binDir: string; dir: string; homesBefore: Set<string>; elapsedMs: number }> {
  const { dir, binDir, serviceCwd } = mkFixtureDir(cfg, opts.componentsJson);
  const homesBefore = new Set(homeLeftovers());
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [DIST_PROXY], {
      cwd: serviceCwd,
      env: { ...process.env, PATH: binDir + ":" + (process.env.PATH ?? ""), ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outLines: Record<string, unknown>[] = [];
    let obuf = "";
    let stderr = "";
    let sentAt = 0;
    proc.stdout.on("data", (d) => {
      obuf += d.toString();
      let idx: number;
      while ((idx = obuf.indexOf("\n")) >= 0) {
        const l = obuf.slice(0, idx).trim();
        obuf = obuf.slice(idx + 1);
        if (l) try { outLines.push(JSON.parse(l)); } catch { /* */ }
      }
    });
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    for (const r of requests) proc.stdin.write((typeof r === "string" ? r : JSON.stringify(r)) + "\n");
    if (opts.signalAfterMs !== undefined) setTimeout(() => { sentAt = Date.now(); proc.kill(opts.signal ?? "SIGINT"); }, opts.signalAfterMs);
    else proc.stdin.end();
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal, outLines, stderr, binDir, dir, homesBefore, elapsedMs: sentAt ? Date.now() - sentAt : 0 }));
  });
}

test("[M3c-3a][exec] node dist/…proxy.js 실제 spawn 왕복 → exit 0, JSON-RPC 응답, 즉시-exit0 회귀 없음", async () => {
  const r = await runExecutable({ mode: "normal" }, [...INIT, req(2, "tools/list"), call(3, "get_project_registries", {})]);
  try {
    assert.equal(r.code, 0, `exit 0 (stderr=${r.stderr})`);
    const tl = byId(r.outLines, 2) as { result?: { tools?: { name: string }[] } } | undefined;
    assert.deepEqual((tl?.result?.tools ?? []).map((t) => t.name).sort(), [...BARE5].sort(), "실제 실행에서 bare 5개");
    assert.ok((byId(r.outLines, 3) as { result?: unknown })?.result, "tools/call 왕복(즉시 exit0 아님)");
    assert.deepEqual(homeLeftovers().filter((h) => !r.homesBefore.has(h)), []);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a][exec] startup 실패(custom registry) → non-zero + 짧은 code stderr(raw/secret 미출력)", async () => {
  const r = await runExecutable({ mode: "normal" }, [...INIT], { componentsJson: JSON.stringify({ registries: { "@acme": "x" } }) });
  try {
    assert.notEqual(r.code, 0, "non-zero");
    assert.ok(/registry_custom_registry_forbidden/.test(r.stderr), "짧은 code");
    assert.ok(!/@acme|https/.test(r.stderr), "raw 미출력");
    assert.equal(r.outLines.length, 0);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] cleanup 실패는 함수 seam(cleanupFaultForTest)으로만 → cleanupOk:false(성공 보고 아님)", async () => {
  const out = await driveProxy({ mode: "normal" }, [...INIT, req(2, "tools/list")], { cleanupFault: true });
  try {
    assert.ok(out.result, out.err?.message);
    assert.equal(out.result!.cleanupOk, false, "cleanupOk:false");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a][exec] production main은 HARNESS_M3C3_TEST_CLEANUP_FAIL env 백도어를 해석하지 않음 → exit 0", async () => {
  const r = await runExecutable({ mode: "normal" }, [...INIT, req(2, "tools/list")], { env: { HARNESS_M3C3_TEST_CLEANUP_FAIL: "1" } });
  try {
    assert.equal(r.code, 0, "env 무시 → 정상 exit 0");
    assert.ok(!/cleanup_failed/.test(r.stderr), "cleanup 실패 아님");
    assert.deepEqual(homeLeftovers().filter((h) => !r.homesBefore.has(h)), []);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a][exec] startup initialize 무한 대기 → SIGINT 3초 내 exit 130·child/grandchild/HOME 없음", async () => {
  const r = await runExecutable({ mode: "normal", hangInitialize: true, spawnGrandchild: true }, [...INIT], { signalAfterMs: 400, signal: "SIGINT" });
  try {
    assert.ok(r.elapsedMs > 0 && r.elapsedMs < 3000, `3초 내 종료(${r.elapsedMs}ms) — startupTimeout 대기 안 함`);
    assert.equal(r.code, 130, `exit 130 (stderr=${r.stderr})`);
    const gpid = Number(readLines(r.binDir, "scp-grandchild.pid")[0]);
    let alive = isAlive(gpid);
    for (let i = 0; i < 30 && alive; i++) { await new Promise((x) => setTimeout(x, 100)); alive = isAlive(gpid); }
    if (alive) try { process.kill(gpid, "SIGKILL"); } catch { /* */ }
    assert.equal(alive, false, "child/grandchild 종료");
    assert.deepEqual(homeLeftovers().filter((h) => !r.homesBefore.has(h)), [], "m3c3-home-* 없음");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a][exec] in-flight tools/call 무한 대기 → SIGTERM 3초 내 exit 143·child/grandchild/HOME 없음", async () => {
  const r = await runExecutable({ mode: "normal", faultTool: "get_project_registries", faultType: "hang", spawnGrandchild: true }, [...INIT, call(2, "get_project_registries", {})], { signalAfterMs: 900, signal: "SIGTERM" });
  try {
    assert.ok(r.elapsedMs > 0 && r.elapsedMs < 3000, `3초 내 종료(${r.elapsedMs}ms) — perCallTimeout 대기 안 함`);
    assert.equal(r.code, 143, `exit 143 (stderr=${r.stderr})`);
    const gpid = Number(readLines(r.binDir, "scp-grandchild.pid")[0]);
    let alive = isAlive(gpid);
    for (let i = 0; i < 30 && alive; i++) { await new Promise((x) => setTimeout(x, 100)); alive = isAlive(gpid); }
    if (alive) try { process.kill(gpid, "SIGKILL"); } catch { /* */ }
    assert.equal(alive, false, "child/grandchild 종료");
    assert.deepEqual(homeLeftovers().filter((h) => !r.homesBefore.has(h)), [], "HOME/cache 없음");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("[M3c-3a] 불변: registry/tool_profiles.json shadcn 미등록 · M3c-0/1/2 함수 불변", async () => {
  const { PACKAGE_ROOT } = await import("../core/paths.js");
  const reg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "tool_profiles.json"), "utf8"));
  assert.ok(!/shadcn/i.test(JSON.stringify(reg)));
  const m0 = await import("./shadcnPilot.js");
  const m1 = await import("./shadcnSchemaProbe.js");
  const m2 = await import("./shadcnReadSemanticsProbe.js");
  assert.equal(typeof m0.runShadcnDiscovery, "function");
  assert.equal(typeof m1.runShadcnSchemaProbe, "function");
  assert.equal(typeof m2.runShadcnReadSemanticsProbe, "function");
});
