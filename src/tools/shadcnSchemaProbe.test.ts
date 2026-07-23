/**
 * [V3 M3c-1] shadcn MCP tools/list schema discovery offline 테스트.
 * fake stdio JSON-RPC MCP 서버 fixture를 **임시 PATH의 `npx` 이름으로 배치**해 주입한다
 * (production은 항상 `npx` 실행 — env override seam 없음). 실제 npx/network를 호출하지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, existsSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runShadcnSchemaProbe, ShadcnSchemaProbeError, EXPECTED_SHADCN_TOOLS, MCP_PROTOCOL_VERSION } from "./shadcnSchemaProbe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "..", "..", "scripts", "m3c-live-schema-probe.mjs");

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

// ── fake stdio JSON-RPC MCP 서버 fixture (CJS; bare 도구명 반환; PATH의 `npx`로 배치) ──
const FIXTURE_SRC = `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
let cfg = {};
try { cfg = JSON.parse(readFileSync(join(__dirname, "scp-config.json"), "utf8")); } catch {}
const MODE = cfg.mode || "normal";
const PV = cfg.pv || "${MCP_PROTOCOL_VERSION}";
const methodsOut = join(__dirname, "scp-methods.txt");
const rec = (m) => { try { appendFileSync(methodsOut, String(m) + "\\n"); } catch {} };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const BARE7 = ["get_add_command_for_items","get_audit_checklist","get_item_examples_from_registries","get_project_registries","list_items_in_registries","search_items_in_registries","view_items_in_registries"];
const tool = (n) => {
  const t = { name: n, inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  if (!cfg.noDesc) t.description = n + " description" + (MODE === "multibyteSplit" ? " 설명 한글 テスト 🚀" : "") + (cfg.embedInDesc ? (" " + cfg.embedInDesc) : "");
  return t;
};
function initResult() { return { protocolVersion: PV, capabilities: { tools: {} }, serverInfo: { name: "shadcn", version: "1.0.0" } }; }
function toolsResponse(id, cursor) {
  if (MODE === "toolsError") return { jsonrpc: "2.0", id, result: { tools: "notarray" } };
  if (MODE === "missing") return { jsonrpc: "2.0", id, result: { tools: BARE7.slice(0, 6).map(tool) } };
  if (MODE === "extra") return { jsonrpc: "2.0", id, result: { tools: [...BARE7.map(tool), tool("unexpected_extra_tool")] } };
  if (MODE === "duplicate") return { jsonrpc: "2.0", id, result: { tools: [...BARE7.map(tool), tool("get_audit_checklist")] } };
  if (MODE === "noInputSchema") { const ts = BARE7.map(tool); delete ts[0].inputSchema; return { jsonrpc: "2.0", id, result: { tools: ts } }; }
  if (MODE === "badInputType") { const ts = BARE7.map(tool); ts[0].inputSchema = { type: "array" }; return { jsonrpc: "2.0", id, result: { tools: ts } }; }
  if (MODE === "annotationsBadBool") { const ts = BARE7.map(tool); ts[0].annotations = { readOnlyHint: "yes" }; return { jsonrpc: "2.0", id, result: { tools: ts } }; }
  if (MODE === "secretKey") { const ts = BARE7.map(tool); ts[0].inputSchema = { type: "object", properties: { [cfg.keyName]: { type: "string" } } }; return { jsonrpc: "2.0", id, result: { tools: ts } }; }
  if (MODE === "deepSchema") { const ts = BARE7.map(tool); let d = {}, c = d; for (let i = 0; i < 22; i++) { c.n = {}; c = c.n; } ts[0].inputSchema = { type: "object", properties: { deep: d } }; return { jsonrpc: "2.0", id, result: { tools: ts } }; }
  if (MODE === "repeatCursor") { const pg = cursor ? BARE7.slice(3, 6) : BARE7.slice(0, 3); return { jsonrpc: "2.0", id, result: { tools: pg.map(tool), nextCursor: "c1" } }; }
  if (MODE === "pageOverflow") return { jsonrpc: "2.0", id, result: { tools: [], nextCursor: "c" + globalThis.__p } };
  if (MODE === "pagination") {
    if (!cursor) return { jsonrpc: "2.0", id, result: { tools: BARE7.slice(0, 4).map(tool), nextCursor: "c1" } };
    if (cursor === "c1") return { jsonrpc: "2.0", id, result: { tools: BARE7.slice(4).map(tool) } };
    return { jsonrpc: "2.0", id, result: { tools: [] } };
  }
  return { jsonrpc: "2.0", id, result: { tools: BARE7.map(tool) } };
}
function respondToolsList(id, cursor) {
  const resp = toolsResponse(id, cursor);
  if (MODE === "multibyteSplit") {
    const buf = Buffer.from(JSON.stringify(resp) + "\\n", "utf8");
    const mid = Math.floor(buf.length / 2);
    process.stdout.write(buf.subarray(0, mid));
    setTimeout(() => process.stdout.write(buf.subarray(mid)), 20);
    return;
  }
  process.stdout.write(JSON.stringify(resp) + "\\n");
}
if (MODE === "stdoutLarge") { process.stdout.write("x".repeat(1024 * 1024 + 16)); setTimeout(() => {}, 30000); }
else if (MODE === "stderrLarge") { process.stderr.write("e".repeat(64 * 1024 + 16)); setTimeout(() => {}, 30000); }
else {
  globalThis.__p = 0;
  const rl = createInterface({ input: process.stdin });
  if (MODE === "delayedClose") rl.on("close", () => setTimeout(() => process.exit(0), 300));
  rl.on("line", (line) => {
    const t = line.trim(); if (!t) return;
    let msg; try { msg = JSON.parse(t); } catch { return; }
    rec(msg.method);
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "initialize") {
      if (MODE === "nonzero") process.exit(3);
      if (MODE === "hang") return;
      if (MODE === "malformedLine") { process.stdout.write("not valid json at all\\n"); return; }
      if (MODE === "badJsonrpc") { send({ jsonrpc: "1.0", id: msg.id, result: initResult() }); return; }
      if (MODE === "idMismatch") { send({ jsonrpc: "2.0", id: 9999, result: initResult() }); return; }
      if (MODE === "initError") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "nope" } }); return; }
      if (MODE === "badProtocol") { const r = initResult(); r.protocolVersion = "zzz-not-real"; send({ jsonrpc: "2.0", id: msg.id, result: r }); return; }
      if (MODE === "noServerInfo") { const r = initResult(); delete r.serverInfo; send({ jsonrpc: "2.0", id: msg.id, result: r }); return; }
      if (MODE === "noServerVersion") { const r = initResult(); r.serverInfo = { name: "shadcn" }; send({ jsonrpc: "2.0", id: msg.id, result: r }); return; }
      if (MODE === "badCaps") { const r = initResult(); r.capabilities = "nope"; send({ jsonrpc: "2.0", id: msg.id, result: r }); return; }
      if (MODE === "noCapsTools") { const r = initResult(); r.capabilities = {}; send({ jsonrpc: "2.0", id: msg.id, result: r }); return; }
      send({ jsonrpc: "2.0", id: msg.id, result: initResult() }); return;
    }
    if (msg.method === "tools/list") { globalThis.__p++; respondToolsList(msg.id, msg.params && msg.params.cursor); return; }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  });
}
`;

interface ProbeOpts {
  componentsJson?: string;
  componentsSymlink?: boolean;
  preSeed?: boolean;
  timeoutMs?: number;
  redactNames?: string[];
  bogusEnvOverride?: boolean; // 제거된 HARNESS_SHADCN_NPX_BIN이 무시되는지 검증용
}

function readMethods(binDir: string): string[] {
  const p = join(binDir, "scp-methods.txt");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** fake `npx`(fixture)를 임시 PATH에 배치하고 runShadcnSchemaProbe를 실행한다. */
async function runProbe(cfg: Record<string, unknown>, opts: ProbeOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scp-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const npx = join(binDir, "npx");
  writeFileSync(npx, FIXTURE_SRC, "utf8");
  chmodSync(npx, 0o755);
  writeFileSync(join(binDir, "scp-config.json"), JSON.stringify(cfg), "utf8");

  const serviceCwd = join(dir, "svc");
  mkdirSync(serviceCwd, { recursive: true });
  if (opts.componentsSymlink) {
    const target = join(dir, "real.json");
    writeFileSync(target, JSON.stringify({ registries: {} }), "utf8");
    symlinkSync(target, join(serviceCwd, "components.json"));
  } else if (opts.componentsJson !== undefined) {
    writeFileSync(join(serviceCwd, "components.json"), opts.componentsJson, "utf8");
  }
  const runtimeDir = join(dir, "runtime");
  if (opts.preSeed) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(runtimeDir, "mcp-schema-discovery.json"), "PREEXISTING\n", "utf8");
  }

  const prevPath = process.env.PATH;
  const prevBogus = process.env.HARNESS_SHADCN_NPX_BIN;
  process.env.PATH = binDir + ":" + (prevPath ?? "");
  if (opts.bogusEnvOverride) process.env.HARNESS_SHADCN_NPX_BIN = "/nonexistent/should-be-ignored";
  try {
    const res = await runShadcnSchemaProbe({ serviceCwd, runtimeDir, now: () => "2026-01-01T00:00:00.000Z", timeoutMs: opts.timeoutMs ?? 8000, redactNames: opts.redactNames });
    return { res, err: undefined, dir, runtimeDir, methods: readMethods(binDir) };
  } catch (e) {
    return { res: undefined, err: e as Error, dir, runtimeDir, methods: readMethods(binDir) };
  } finally {
    process.env.PATH = prevPath;
    if (prevBogus === undefined) delete process.env.HARNESS_SHADCN_NPX_BIN;
    else process.env.HARNESS_SHADCN_NPX_BIN = prevBogus;
  }
}

// ── 정상 수집 + 계약 ──────────────────────────────────────────────────────────

test("[M3c-1] 정상 schema 수집 → 7개 정확·계약·operationSummary·반환==저장·raw 부재·tools/call 없음", async () => {
  const out = await runProbe({ mode: "normal" });
  try {
    assert.ok(out.res, out.err ? `예상외 오류: ${out.err.message}` : "결과 없음");
    const res = out.res!;
    assert.equal(res.schemaDiscovery, true);
    assert.equal((res as unknown as { ok?: unknown; discovery?: unknown }).ok, undefined);
    assert.equal(res.snapshot.mode, "schema-discovery");
    assert.equal(res.snapshot.usableForHandoff, false);
    assert.equal(res.snapshot.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(res.snapshot.serverInfo.name, "shadcn");
    assert.equal(res.snapshot.serverInfo.version, "1.0.0");
    assert.deepEqual(res.snapshot.tools.map((t) => t.name), EXPECTED_SHADCN_TOOLS);
    for (const t of res.snapshot.tools) assert.equal(t.inputSchema.type, "object");
    // operationSummary — tools/call:0 정직 검증
    assert.deepEqual(res.operationSummary, { initialize: 1, initialized: 1, toolsListPages: 1, toolCalls: 0 });
    // 산출물 권한·반환==저장·raw payload 부재
    assert.ok(res.snapshotPath.endsWith("mcp-schema-discovery.json"));
    assert.equal(mode(res.snapshotPath), 0o600);
    assert.equal(mode(out.runtimeDir), 0o700);
    const body = readFileSync(res.snapshotPath, "utf8");
    assert.deepEqual(JSON.parse(body), res.snapshot);
    assert.ok(!body.includes("jsonrpc") && !/"method"\s*:/.test(body), "raw protocol 미저장");
    // 고정 package
    const cfg = JSON.parse(readFileSync(join(out.runtimeDir, "mcp-config.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.shadcn.args, ["--yes", "shadcn@4.13.1", "mcp"]);
    // fixture가 받은 method: tools/call 없음
    assert.ok(!out.methods.includes("tools/call"));
    assert.ok(out.methods.every((m) => ["initialize", "notifications/initialized", "tools/list"].includes(m)));
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-1][P0-2] 제거된 HARNESS_SHADCN_NPX_BIN은 무시된다(항상 PATH의 npx 실행)", async () => {
  const out = await runProbe({ mode: "normal" }, { bogusEnvOverride: true });
  try {
    assert.ok(out.res, out.err?.message);
    assert.deepEqual(out.res!.snapshot.tools.map((t) => t.name), EXPECTED_SHADCN_TOOLS);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-1] description 없어도 성공(optional) · pagination(4+3) 성공", async () => {
  const a = await runProbe({ mode: "normal", noDesc: true });
  try {
    assert.ok(a.res, a.err?.message);
    assert.equal(a.res!.snapshot.tools[0].description, undefined);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "pagination" });
  try {
    assert.ok(b.res, b.err?.message);
    assert.deepEqual(b.res!.snapshot.tools.map((t) => t.name), EXPECTED_SHADCN_TOOLS);
    assert.equal(b.res!.operationSummary.toolsListPages, 2);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

// ── 이름/스키마/페이지네이션 거부 ─────────────────────────────────────────────

test("[M3c-1] 누락/추가/중복/toolsError/필수필드/스키마타입/annotation bool 거부, snapshot 미생성", async () => {
  const cases: [string, string][] = [
    ["missing", "tool_name_mismatch"],
    ["extra", "tool_name_mismatch"],
    ["duplicate", "duplicate_tool"],
    ["toolsError", "tools_error"],
    ["noInputSchema", "tool_missing_field"],
    ["badInputType", "bad_schema"],
    ["deepSchema", "bad_schema"],
    ["annotationsBadBool", "bad_schema"],
  ];
  for (const [m, code] of cases) {
    const out = await runProbe({ mode: m });
    try {
      assert.equal((out.err as ShadcnSchemaProbeError)?.code, code, `mode=${m}`);
      assert.ok(!existsSync(join(out.runtimeDir, "mcp-schema-discovery.json")), `${m}: snapshot 미생성`);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

test("[M3c-1] 반복 cursor → repeat_cursor / 과도한 page → too_many_pages", async () => {
  const a = await runProbe({ mode: "repeatCursor" });
  try {
    assert.equal((a.err as ShadcnSchemaProbeError)?.code, "repeat_cursor");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "pageOverflow" });
  try {
    assert.equal((b.err as ShadcnSchemaProbeError)?.code, "too_many_pages");
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

// ── JSON-RPC / protocol / capabilities / serverInfo 계약 거부 ────────────────

test("[M3c-1] jsonrpc version/id·protocolVersion·capabilities(.tools)·serverInfo(name/version)·initError·malformed 거부", async () => {
  const cases: [string, string][] = [
    ["badJsonrpc", "jsonrpc_version"],
    ["idMismatch", "jsonrpc_id_mismatch"],
    ["badProtocol", "protocol_version"],
    ["badCaps", "capabilities"],
    ["noCapsTools", "capabilities"],
    ["noServerInfo", "server_info"],
    ["noServerVersion", "server_info"],
    ["initError", "init_error"],
    ["malformedLine", "malformed_line"],
  ];
  for (const [m, code] of cases) {
    const out = await runProbe({ mode: m });
    try {
      assert.equal((out.err as ShadcnSchemaProbeError)?.code, code, `mode=${m}`);
      assert.ok(!existsSync(join(out.runtimeDir, "mcp-schema-discovery.json")));
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

test("[M3c-1] nonzero / timeout / stdout·stderr 상한 거부", async () => {
  const a = await runProbe({ mode: "nonzero" });
  try {
    assert.equal((a.err as ShadcnSchemaProbeError)?.code, "nonzero_exit");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "hang" }, { timeoutMs: 400 });
  try {
    assert.equal((b.err as ShadcnSchemaProbeError)?.code, "timeout");
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
  const c = await runProbe({ mode: "stdoutLarge" }, { timeoutMs: 5000 });
  try {
    assert.equal((c.err as ShadcnSchemaProbeError)?.code, "stdout_too_large");
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
  const d = await runProbe({ mode: "stderrLarge" }, { timeoutMs: 5000 });
  try {
    assert.equal((d.err as ShadcnSchemaProbeError)?.code, "stderr_too_large");
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

// ── UTF-8 / lifecycle ─────────────────────────────────────────────────────────

test("[M3c-1][P0-5] 멀티바이트 chunk 분할 → StringDecoder로 손상 없이 수집", async () => {
  const out = await runProbe({ mode: "multibyteSplit" }, { timeoutMs: 5000 });
  try {
    assert.ok(out.res, out.err?.message);
    assert.deepEqual(out.res!.snapshot.tools.map((t) => t.name), EXPECTED_SHADCN_TOOLS);
    assert.ok(out.res!.snapshot.tools[0].description?.includes("🚀"), "멀티바이트 description 온전");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-1][P0-5] 종료 지연 서버 → stdin 종료 후 bounded wait로 close 확인 뒤 성공", async () => {
  const out = await runProbe({ mode: "delayedClose" }, { timeoutMs: 5000 });
  try {
    assert.ok(out.res, out.err?.message);
    assert.deepEqual(out.res!.snapshot.tools.map((t) => t.name), EXPECTED_SHADCN_TOOLS);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── registry / persist / redaction / key ──────────────────────────────────────

test("[M3c-1] custom/malformed/symlink registry → registry_*, runtimeDir·spawn 없음", async () => {
  const a = await runProbe({ mode: "normal" }, { componentsJson: JSON.stringify({ registries: { "@acme": "https://x/" } }) });
  try {
    assert.equal((a.err as ShadcnSchemaProbeError)?.code, "registry_custom_registry_forbidden");
    assert.ok(!existsSync(a.runtimeDir));
    assert.equal(a.methods.length, 0, "spawn 없음");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "normal" }, { componentsJson: "{ bad" });
  try {
    assert.equal((b.err as ShadcnSchemaProbeError)?.code, "registry_malformed");
    assert.ok(!existsSync(b.runtimeDir));
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
  const c = await runProbe({ mode: "normal" }, { componentsSymlink: true });
  try {
    assert.equal((c.err as ShadcnSchemaProbeError)?.code, "registry_not_regular_file");
    assert.ok(!existsSync(c.runtimeDir));
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test("[M3c-1] mcp-schema-discovery.json wx 충돌 → persist, 부분 성공 미반환", async () => {
  const out = await runProbe({ mode: "normal" }, { preSeed: true });
  try {
    assert.equal((out.err as ShadcnSchemaProbeError)?.code, "persist");
    assert.equal(out.res, undefined);
    assert.equal(readFileSync(join(out.runtimeDir, "mcp-schema-discovery.json"), "utf8"), "PREEXISTING\n");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-1][P0-3] 중첩 properties key가 sentinel → secret_in_schema_key, 원 key 평문 부재, snapshot 미생성", async () => {
  const SENT = "M3C_SCHEMA_KEY_SENTINEL";
  const VAL = "keysentinel-" + "w".repeat(12);
  const prev = process.env[SENT];
  process.env[SENT] = VAL;
  try {
    const out = await runProbe({ mode: "secretKey", keyName: VAL }, { redactNames: [SENT] });
    assert.equal((out.err as ShadcnSchemaProbeError)?.code, "secret_in_schema_key");
    assert.ok(!out.err!.message.includes(VAL), "오류에 원 key 평문 없음");
    assert.ok(!existsSync(join(out.runtimeDir, "mcp-schema-discovery.json")), "snapshot 미생성");
    rmSync(out.dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env[SENT];
    else process.env[SENT] = prev;
  }
});

test("[M3c-1] redaction: credential value / redactNames sentinel → snapshot·반환에 평문 부재, 반환==저장", async () => {
  const a = await runProbe({ mode: "normal", embedInDesc: "token=LEAKED_CRED_VALUE" });
  try {
    assert.ok(a.res, a.err?.message);
    const body = readFileSync(a.res!.snapshotPath, "utf8");
    assert.ok(!body.includes("LEAKED_CRED_VALUE"));
    assert.deepEqual(JSON.parse(body), a.res!.snapshot);
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const SENT = "M3C_SCHEMA_VAL_SENTINEL";
  const VAL = "valsentinel-" + "q".repeat(10);
  const prev = process.env[SENT];
  process.env[SENT] = VAL;
  try {
    const b = await runProbe({ mode: "normal", embedInDesc: VAL }, { redactNames: [SENT] });
    assert.ok(b.res, b.err?.message);
    assert.ok(!JSON.stringify(b.res!.snapshot).includes(VAL));
    assert.ok(!readFileSync(b.res!.snapshotPath, "utf8").includes(VAL));
    rmSync(b.dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env[SENT];
    else process.env[SENT] = prev;
  }
});

// ── live runner offline smoke (import 오류 재발 방지) ─────────────────────────

test("[M3c-1][P0-1] runner offline smoke: opt-in + fake npx(PATH) → exit 0, import 오류 없음, 실제 npx/network 미호출", () => {
  const binDir = mkdtempSync(join(tmpdir(), "scp-runner-bin-"));
  try {
    const npx = join(binDir, "npx");
    writeFileSync(npx, FIXTURE_SRC, "utf8");
    chmodSync(npx, 0o755);
    writeFileSync(join(binDir, "scp-config.json"), JSON.stringify({ mode: "normal" }), "utf8");
    const r = spawnSync(process.execPath, [RUNNER], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, HARNESS_LIVE_M3C_SCHEMA: "1", PATH: binDir + ":" + (process.env.PATH ?? "") },
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.equal(r.status, 0, `runner exit 0 아님 (status=${r.status})\n${out}`);
    assert.ok(!/checkComponentsJson is not a function|is not defined|TypeError/.test(out), `import/런타임 오류 재발: ${out}`);
    assert.ok(out.includes("schema discovery OK"), "discovery OK 미출력");
    assert.ok(out.includes("mcp__shadcn__get_project_registries"), "도구명 미출력");
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("[M3c-1] runner opt-in 없음 → exit 2 (Claude/npx 미호출)", () => {
  const r = spawnSync(process.execPath, [RUNNER], { encoding: "utf8", timeout: 15000, env: { ...process.env, HARNESS_LIVE_M3C_SCHEMA: "" } });
  assert.equal(r.status, 2);
});

test("[M3c-1] 불변: registry/tool_profiles.json shadcn 미등록 · M3c-0 discovery 함수 불변", async () => {
  const { PACKAGE_ROOT } = await import("../core/paths.js");
  const reg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "tool_profiles.json"), "utf8"));
  assert.ok(!/shadcn/i.test(JSON.stringify(reg)));
  const m0 = await import("./shadcnPilot.js");
  assert.equal(typeof m0.runShadcnDiscovery, "function");
  assert.equal(typeof m0.checkComponentsJson, "function");
});
