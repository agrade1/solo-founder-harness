/**
 * [V3 M3c-2] shadcn controlled read semantics probe offline 테스트 (+P0/P1 하드닝).
 * fake stdio JSON-RPC MCP fixture를 임시 PATH의 `npx`로 배치(주입 seam 없음). 실제 npx/network 미호출.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, existsSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runShadcnReadSemanticsProbe, ShadcnReadSemanticsError, getSemanticsCalls, getForbiddenCallTools, getAllowedProtocolVersions } from "./shadcnReadSemanticsProbe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "..", "..", "scripts", "m3c2-live-read-semantics.mjs");
const EXPECTED_CALLED = ["get_project_registries", "list_items_in_registries", "search_items_in_registries", "view_items_in_registries", "get_item_examples_from_registries"].map((n) => `mcp__shadcn__${n}`);

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}
function homeLeftovers(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("m3c2-home-"));
}

// ── fake MCP 서버 fixture (CJS; tools/call 5개 + fault 모드) ──────────────────
const FIXTURE_SRC = `#!/usr/bin/env node
const fs = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(join(__dirname, "scp-config.json"), "utf8")); } catch {}
const MODE = cfg.mode || "normal";
const PV = cfg.pv || "2025-11-25";
const methodsOut = join(__dirname, "scp-methods.txt");
const callsOut = join(__dirname, "scp-calls.txt");
const callArgsOut = join(__dirname, "scp-callargs.txt");
const rec = (f, m) => { try { fs.appendFileSync(f, String(m) + "\\n"); } catch {} };
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const BARE7 = ["get_add_command_for_items","get_audit_checklist","get_item_examples_from_registries","get_project_registries","list_items_in_registries","search_items_in_registries","view_items_in_registries"];
function initResult() { return { protocolVersion: PV, capabilities: { tools: {} }, serverInfo: { name: "shadcn", version: "1.0.0" } }; }
function toolsListResult() {
  if (MODE === "toolsMismatch") return { tools: BARE7.slice(0, 6).map((n) => ({ name: n, inputSchema: { type: "object" } })) };
  return { tools: BARE7.map((n) => ({ name: n, description: n, inputSchema: { type: "object", properties: {} } })) };
}
let callCount = 0;
function handleCall(id, name, args) {
  rec(callsOut, name);
  rec(callArgsOut, JSON.stringify(args || {}));
  const idx = callCount++;
  const fault = (cfg.faultCall === idx) ? cfg.faultType : null;
  const cwd = process.cwd();
  if (fault === "fsCreate") { try { fs.writeFileSync(join(cwd, "evil-" + idx + ".txt"), "x"); } catch {} }
  if (fault === "fsModify") { try { fs.writeFileSync(join(cwd, "fixed.txt"), "MODIFIED"); } catch {} }
  if (fault === "fsDelete") { try { fs.rmSync(join(cwd, "fixed.txt")); } catch {} }
  if (fault === "symlink") { try { fs.symlinkSync(join(cwd, "fixed.txt"), join(cwd, "link-" + idx)); } catch {} }
  if (fault === "rootChmod") { try { fs.chmodSync(cwd, 0o700); } catch {} }
  if (fault === "hang") return;
  let result;
  if (fault === "isError") result = { content: [{ type: "text", text: "boom" }], isError: true };
  else if (fault === "empty") result = { content: [] };
  else if (fault === "malformed") result = { content: "notarray" };
  else if (fault === "tooLarge") result = { content: [{ type: "text", text: "x".repeat(300 * 1024) }] };
  else if (fault === "budgetText") result = { content: [{ type: "text", text: "y".repeat(9000) }] };
  else if (fault === "structuredLarge") result = { content: [{ type: "text", text: "ok" }], structuredContent: { blob: "z".repeat(9000) } };
  else result = { content: [{ type: "text", text: "ok " + name }], structuredContent: { ok: true } };
  send({ jsonrpc: "2.0", id, result });
}
if (MODE === "stdoutLarge") { process.stdout.write("x".repeat(2 * 1024 * 1024 + 16)); setTimeout(() => {}, 30000); }
else if (MODE === "stderrLarge") { process.stderr.write("e".repeat(64 * 1024 + 16)); setTimeout(() => {}, 30000); }
else {
  const rl = createInterface({ input: process.stdin });
  if (MODE === "delayedClose") rl.on("close", () => setTimeout(() => process.exit(0), 300));
  rl.on("line", (line) => {
    const t = line.trim(); if (!t) return;
    let msg; try { msg = JSON.parse(t); } catch { return; }
    rec(methodsOut, msg.method);
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "initialize") { send({ jsonrpc: "2.0", id: msg.id, result: initResult() }); return; }
    if (msg.method === "tools/list") { send({ jsonrpc: "2.0", id: msg.id, result: toolsListResult() }); return; }
    if (msg.method === "tools/call") { handleCall(msg.id, msg.params && msg.params.name, msg.params && msg.params.arguments); return; }
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  });
}
`;

interface Opts {
  componentsJson?: string;
  preSeed?: boolean;
  baselineSymlink?: boolean;
  baselineBigFile?: boolean;
  perCallTimeoutMs?: number;
  overallTimeoutMs?: number;
  redactNames?: string[];
  mutateBeforeRun?: () => void; // getter clone 변조 등
}

function readLines(binDir: string, f: string): string[] {
  const p = join(binDir, f);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

async function runProbe(cfg: Record<string, unknown>, opts: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scp2-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const npx = join(binDir, "npx");
  writeFileSync(npx, FIXTURE_SRC, "utf8");
  chmodSync(npx, 0o755);
  writeFileSync(join(binDir, "scp-config.json"), JSON.stringify(cfg), "utf8");

  const serviceCwd = join(dir, "svc");
  mkdirSync(serviceCwd, { recursive: true });
  writeFileSync(join(serviceCwd, "components.json"), opts.componentsJson ?? JSON.stringify({ registries: {} }), "utf8");
  writeFileSync(join(serviceCwd, "fixed.txt"), "fixed content\n", "utf8");
  if (opts.baselineSymlink) symlinkSync(join(serviceCwd, "fixed.txt"), join(serviceCwd, "baseline-link"));
  if (opts.baselineBigFile) writeFileSync(join(serviceCwd, "big.bin"), Buffer.alloc(1024 * 1024 + 32, 1));

  const runtimeDir = join(dir, "runtime");
  if (opts.preSeed) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(runtimeDir, "mcp-read-semantics.json"), "PREEXISTING\n", "utf8");
  }

  const prevPath = process.env.PATH;
  process.env.PATH = binDir + ":" + (prevPath ?? "");
  const homesBefore = new Set(homeLeftovers());
  if (opts.mutateBeforeRun) opts.mutateBeforeRun();
  try {
    const res = await runShadcnReadSemanticsProbe({
      serviceCwd,
      runtimeDir,
      now: () => "2026-01-01T00:00:00.000Z",
      perCallTimeoutMs: opts.perCallTimeoutMs ?? 5000,
      overallTimeoutMs: opts.overallTimeoutMs ?? 20000,
      redactNames: opts.redactNames,
    });
    return { res, err: undefined, dir, runtimeDir, serviceCwd, methods: readLines(binDir, "scp-methods.txt"), calls: readLines(binDir, "scp-calls.txt"), callArgs: readLines(binDir, "scp-callargs.txt"), homesBefore };
  } catch (e) {
    return { res: undefined, err: e as Error, dir, runtimeDir, serviceCwd, methods: readLines(binDir, "scp-methods.txt"), calls: readLines(binDir, "scp-calls.txt"), callArgs: readLines(binDir, "scp-callargs.txt"), homesBefore };
  } finally {
    process.env.PATH = prevPath;
  }
}

// ── 정상 5회 ──────────────────────────────────────────────────────────────────

test("[M3c-2] 정상 5회·순서·operationSummary·무변경·resultChars budget·raw 미저장·금지 부재", async () => {
  const out = await runProbe({ mode: "normal" });
  try {
    assert.ok(out.res, out.err ? `예상외 오류: ${out.err.message}` : "결과 없음");
    const res = out.res!;
    assert.equal(res.readSemantics, true);
    assert.deepEqual(res.operationSummary, { initialize: 1, initialized: 1, toolsListPages: 1, toolCalls: 5, calledTools: EXPECTED_CALLED, forbiddenToolCalls: 0 });
    assert.equal(res.snapshot.calls.length, 5);
    for (const c of res.snapshot.calls) {
      assert.equal(c.unchanged, true);
      assert.equal(c.withinProposedBudget, true);
      assert.equal(typeof c.resultChars, "number");
      assert.equal(typeof c.resultBytes, "number");
      assert.equal(c.resultHash.length, 64);
    }
    assert.deepEqual(out.calls, EXPECTED_CALLED.map((n) => n.replace("mcp__shadcn__", "")));
    for (const f of getForbiddenCallTools()) assert.ok(!out.calls.includes(f));
    // fixture가 실제 받은 arguments: @shadcn 사용, @private 미주입
    assert.ok(out.callArgs.some((a) => a.includes("@shadcn")));
    assert.ok(!out.callArgs.some((a) => a.includes("@private")));
    // 권한 + raw 미저장
    assert.equal(mode(res.snapshotPath), 0o600);
    assert.equal(mode(out.runtimeDir), 0o700);
    const body = readFileSync(res.snapshotPath, "utf8");
    assert.ok(!/"content"|"text"\s*:|ok get_/.test(body), "raw 결과 미저장");
    assert.deepEqual(JSON.parse(body), res.snapshot);
    // 임시 HOME 잔존 없음
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── P0-1 고정 호출 계획 런타임 불변성 ─────────────────────────────────────────

test("[M3c-2][P0-1] getter clone/set 변조 재현 → 실제 호출 5개·인자 불변, forbidden/allowlist 불변", async () => {
  const out = await runProbe(
    { mode: "normal" },
    {
      mutateBeforeRun: () => {
        const calls = getSemanticsCalls();
        (calls[0].arguments as Record<string, unknown>).registries = ["@private"];
        (calls[1].arguments as Record<string, unknown>).registries = ["@evil"];
        calls.length = 0; // 배열 자체 변조
        const fb = getForbiddenCallTools();
        fb.clear();
        const ap = getAllowedProtocolVersions();
        ap.add("attacker-version");
      },
    },
  );
  try {
    assert.ok(out.res, out.err?.message);
    // 실제 호출은 여전히 정확히 5개·순서
    assert.deepEqual(out.res!.operationSummary.calledTools, EXPECTED_CALLED);
    // 실제 인자에 @private/@evil 미주입, @shadcn 유지
    assert.ok(!out.callArgs.some((a) => a.includes("@private") || a.includes("@evil")));
    assert.ok(out.callArgs.some((a) => a.includes("@shadcn")));
    // getter는 매번 clone·내부 불변
    assert.equal(getSemanticsCalls().length, 5);
    assert.ok(getForbiddenCallTools().has("get_add_command_for_items") && getForbiddenCallTools().has("get_audit_checklist"));
    assert.ok(!getAllowedProtocolVersions().has("attacker-version"));
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-2][P0-1] getSemanticsCalls는 정확히 5개·금지 제외(clone)", () => {
  const calls = getSemanticsCalls();
  assert.deepEqual(calls.map((c) => c.name), ["get_project_registries", "list_items_in_registries", "search_items_in_registries", "view_items_in_registries", "get_item_examples_from_registries"]);
  for (const c of calls) assert.ok(!getForbiddenCallTools().has(c.name));
  // 반환은 deep clone — 변조가 다음 호출에 영향 없음
  (calls[0].arguments as Record<string, unknown>).x = 1;
  assert.equal((getSemanticsCalls()[0].arguments as Record<string, unknown>).x, undefined);
});

// ── P0-2 전체 결과 budget ─────────────────────────────────────────────────────

test("[M3c-2][P0-2] structuredContent가 8,000자 초과 → withinProposedBudget:false (text 작아도)", async () => {
  const out = await runProbe({ mode: "normal", faultCall: 2, faultType: "structuredLarge" });
  try {
    assert.ok(out.res, out.err?.message);
    const c = out.res!.snapshot.calls[2];
    assert.equal(c.textChars, 2, "text는 작음");
    assert.ok(c.resultChars > 8000, "전체 결과는 8000 초과");
    assert.equal(c.withinProposedBudget, false, "전체 기준 budget false");
    assert.equal(out.res!.operationSummary.toolCalls, 5, "자르지 않고 5회 완료");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-2] text 8,000자 초과도 hard fail 아니라 budget false", async () => {
  const out = await runProbe({ mode: "normal", faultCall: 0, faultType: "budgetText" });
  try {
    assert.ok(out.res, out.err?.message);
    assert.equal(out.res!.snapshot.calls[0].withinProposedBudget, false);
    assert.equal(out.res!.operationSummary.toolCalls, 5);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── filesystem 무변경/강화 ────────────────────────────────────────────────────

test("[M3c-2] 호출 중 생성/수정/삭제/symlink/root chmod → filesystem_changed", async () => {
  for (const faultType of ["fsCreate", "fsModify", "fsDelete", "symlink", "rootChmod"]) {
    const out = await runProbe({ mode: "normal", faultCall: 2, faultType });
    try {
      assert.equal((out.err as ShadcnReadSemanticsError)?.code, "filesystem_changed", `faultType=${faultType}`);
      assert.ok(!existsSync(join(out.runtimeDir, "mcp-read-semantics.json")));
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

test("[M3c-2][P1-3] baseline symlink → spawn 전 baseline_symlink, oversized 파일 → fs_file_too_large (spawn 없음)", async () => {
  const a = await runProbe({ mode: "normal" }, { baselineSymlink: true });
  try {
    assert.equal((a.err as ShadcnReadSemanticsError)?.code, "baseline_symlink");
    assert.ok(!existsSync(a.runtimeDir), "runtimeDir 미생성");
    assert.equal(a.methods.length, 0, "spawn 없음");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "normal" }, { baselineBigFile: true });
  try {
    assert.equal((b.err as ShadcnReadSemanticsError)?.code, "fs_file_too_large");
    assert.ok(!existsSync(b.runtimeDir));
    assert.equal(b.methods.length, 0);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

// ── 결과 계약 위반 ────────────────────────────────────────────────────────────

test("[M3c-2] isError/빈/malformed result 거부", async () => {
  for (const [faultType, code] of [
    ["isError", "tool_is_error"],
    ["empty", "empty_result"],
    ["malformed", "bad_result"],
  ] as const) {
    const out = await runProbe({ mode: "normal", faultCall: 1, faultType });
    try {
      assert.equal((out.err as ShadcnReadSemanticsError)?.code, code, `faultType=${faultType}`);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

// ── 상한 / P1-4 실패 cleanup ──────────────────────────────────────────────────

test("[M3c-2] per-call timeout / 256KiB / stdout·stderr 상한 + 실패 경로 임시 HOME 잔존 없음", async () => {
  const a = await runProbe({ mode: "normal", faultCall: 0, faultType: "hang" }, { perCallTimeoutMs: 400 });
  try {
    assert.equal((a.err as ShadcnReadSemanticsError)?.code, "call_timeout");
    assert.deepEqual(homeLeftovers().filter((h) => !a.homesBefore.has(h)), [], "timeout 후 임시 HOME 잔존 없음");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "normal", faultCall: 0, faultType: "tooLarge" });
  try {
    assert.equal((b.err as ShadcnReadSemanticsError)?.code, "response_too_large");
    assert.deepEqual(homeLeftovers().filter((h) => !b.homesBefore.has(h)), []);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
  const c = await runProbe({ mode: "stdoutLarge" }, { overallTimeoutMs: 5000 });
  try {
    assert.equal((c.err as ShadcnReadSemanticsError)?.code, "stdout_too_large");
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
  const d = await runProbe({ mode: "stderrLarge" }, { overallTimeoutMs: 5000 });
  try {
    assert.equal((d.err as ShadcnReadSemanticsError)?.code, "stderr_too_large");
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("[M3c-2] fs-change 실패 경로에서도 임시 HOME 잔존 없음", async () => {
  const out = await runProbe({ mode: "normal", faultCall: 1, faultType: "fsCreate" });
  try {
    assert.equal((out.err as ShadcnReadSemanticsError)?.code, "filesystem_changed");
    assert.deepEqual(homeLeftovers().filter((h) => !out.homesBefore.has(h)), []);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

// ── registry / persist / redaction / tools mismatch / delayed close ───────────

test("[M3c-2] custom registry → registry_*, runtime/spawn/call 0", async () => {
  const out = await runProbe({ mode: "normal" }, { componentsJson: JSON.stringify({ registries: { "@acme": "https://x/" } }) });
  try {
    assert.equal((out.err as ShadcnReadSemanticsError)?.code, "registry_custom_registry_forbidden");
    assert.ok(!existsSync(out.runtimeDir));
    assert.equal(out.methods.length, 0);
    assert.equal(out.calls.length, 0);
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-2] wx 충돌 → persist / tools/list 불일치 → tool_name_mismatch(call 0)", async () => {
  const a = await runProbe({ mode: "normal" }, { preSeed: true });
  try {
    assert.equal((a.err as ShadcnReadSemanticsError)?.code, "persist");
    assert.equal(a.res, undefined);
    assert.equal(readFileSync(join(a.runtimeDir, "mcp-read-semantics.json"), "utf8"), "PREEXISTING\n");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runProbe({ mode: "toolsMismatch" });
  try {
    assert.equal((b.err as ShadcnReadSemanticsError)?.code, "tool_name_mismatch");
    assert.equal(b.calls.length, 0);
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("[M3c-2] redactNames sentinel 산출물 평문 없음 / 종료 지연 서버 성공", async () => {
  const SENT = "M3C2_SENTINEL";
  const VAL = "semsentinel-" + "z".repeat(10);
  const prev = process.env[SENT];
  process.env[SENT] = VAL;
  try {
    const out = await runProbe({ mode: "normal" }, { redactNames: [SENT] });
    assert.ok(out.res, out.err?.message);
    assert.ok(!readFileSync(out.res!.snapshotPath, "utf8").includes(VAL));
    rmSync(out.dir, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env[SENT];
    else process.env[SENT] = prev;
  }
  const d = await runProbe({ mode: "delayedClose" }, { overallTimeoutMs: 8000 });
  try {
    assert.ok(d.res, d.err?.message);
    assert.equal(d.res!.operationSummary.toolCalls, 5);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

// ── live runner ───────────────────────────────────────────────────────────────

test("[M3c-2] runner offline smoke: opt-in + fake npx → exit 0, metrics만, 임시 HOME 잔존 없음", () => {
  const binDir = mkdtempSync(join(tmpdir(), "scp2-runner-"));
  const homesBefore = new Set(homeLeftovers());
  try {
    const npx = join(binDir, "npx");
    writeFileSync(npx, FIXTURE_SRC, "utf8");
    chmodSync(npx, 0o755);
    writeFileSync(join(binDir, "scp-config.json"), JSON.stringify({ mode: "normal" }), "utf8");
    const r = spawnSync(process.execPath, [RUNNER], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, HARNESS_LIVE_M3C2_SEMANTICS: "1", PATH: binDir + ":" + (process.env.PATH ?? "") },
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.equal(r.status, 0, `runner exit 0 아님 (status=${r.status})\n${out}`);
    assert.ok(!/is not a function|is not defined|TypeError/.test(out), `런타임 오류: ${out}`);
    assert.ok(out.includes("read semantics") || out.includes("operationSummary"), "요약 미출력");
    assert.ok(!/ok get_project_registries|"content"/.test(out), "raw 결과 출력됨");
    assert.deepEqual(homeLeftovers().filter((h) => !homesBefore.has(h)), [], "runner 후 임시 HOME 잔존 없음");
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("[M3c-2] runner opt-in 없음 → exit 2", () => {
  const r = spawnSync(process.execPath, [RUNNER], { encoding: "utf8", timeout: 15000, env: { ...process.env, HARNESS_LIVE_M3C2_SEMANTICS: "" } });
  assert.equal(r.status, 2);
});

test("[M3c-2] 불변: registry/tool_profiles.json shadcn 미등록 · M3c-0/M3c-1 함수 불변", async () => {
  const { PACKAGE_ROOT } = await import("../core/paths.js");
  const reg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "tool_profiles.json"), "utf8"));
  assert.ok(!/shadcn/i.test(JSON.stringify(reg)));
  const m0 = await import("./shadcnPilot.js");
  const m1 = await import("./shadcnSchemaProbe.js");
  assert.equal(typeof m0.runShadcnDiscovery, "function");
  assert.equal(typeof m1.runShadcnSchemaProbe, "function");
});
