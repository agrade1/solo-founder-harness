import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadToolProfiles,
  compileToolProfile,
  assertPolicyExecutable,
  ToolProfileError,
} from "./profiles.js";
import { getProviderCapabilities } from "../providers/capabilities.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (name: string) => join(HERE, "..", "..", "tests", "fixtures", "tool-profiles", name);

// ── 로드/검증 ─────────────────────────────────────────────────
test("실사용 registry(tool_profiles.json) 로드: planning-none, planning-local-readonly", () => {
  const m = loadToolProfiles(); // 기본 경로 = registry/tool_profiles.json
  assert.ok(m.has("planning-none"));
  assert.ok(m.has("planning-local-readonly"));
});

test("valid mcp fixture 로드 성공", () => {
  const m = loadToolProfiles(FIX("valid-mcp.json"));
  assert.ok(m.has("dev-shadcn-readonly"));
});

for (const [file, why] of [
  ["deny-capability.json", "deny capability"],
  ["reserved-capability.json", "reserved capability"],
  ["missing-binding.json", "binding 누락"],
  ["preapproved-not-exposed.json", "preapproved ⊄ exposed"],
  ["exposed-denied-overlap.json", "exposed ∩ denied"],
  ["bad-secretref.json", "secretRef 값 형태"],
] as const) {
  test(`로드 거부: ${why} (${file})`, () => {
    assert.throws(() => loadToolProfiles(FIX(file)), ToolProfileError);
  });
}

// ── compile ───────────────────────────────────────────────────
test("compile(planning-none, bare): --strict-mcp-config + --tools '' , 노출 도구 없음", () => {
  const p = loadToolProfiles().get("planning-none")!;
  const c = compileToolProfile(p, { bare: true });
  assert.deepEqual(c.exposedTools, []);
  assert.deepEqual(c.builtinTools, []);
  assert.ok(c.claudeArgs.includes("--strict-mcp-config"));
  const ti = c.claudeArgs.indexOf("--tools");
  assert.ok(ti >= 0 && c.claudeArgs[ti + 1] === "", "--tools '' (빈 문자열)");
  assert.equal(c.mcpConfig, null);
});

test("compile(planning-local-readonly, bare): --tools Read,Glob,Grep + read-only permission", () => {
  const p = loadToolProfiles().get("planning-local-readonly")!;
  const c = compileToolProfile(p, { bare: true });
  assert.deepEqual(c.exposedTools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(c.builtinTools, ["Read", "Glob", "Grep"]);
  const ti = c.claudeArgs.indexOf("--tools");
  assert.equal(c.claudeArgs[ti + 1], "Read,Glob,Grep");
  const pi = c.claudeArgs.indexOf("--permission-mode");
  assert.equal(c.claudeArgs[pi + 1], "plan"); // read_only → plan
  assert.ok(c.claudeArgs.includes("--allowedTools"), "preapproved → --allowedTools");
});

test("compile(mcp fixture): exposed는 mcp__server__tool로 파생", () => {
  const p = loadToolProfiles(FIX("valid-mcp.json")).get("dev-shadcn-readonly")!;
  const c = compileToolProfile(p);
  assert.deepEqual(c.exposedTools, ["mcp__shadcn__browse", "mcp__shadcn__search"]);
  assert.deepEqual(c.builtinTools, []);
  assert.deepEqual(c.mcpConfig, { mcpServers: { shadcn: {} } });
});

test("compile(strict empty profile fallback): --mcp-config <path>", () => {
  const p = loadToolProfiles().get("planning-none")!;
  const c = compileToolProfile(p, { bare: true, mcpConfigPath: "/tmp/run/mcp-empty.json" });
  assert.ok(c.claudeArgs.includes("--strict-mcp-config"));
  const mi = c.claudeArgs.indexOf("--mcp-config");
  assert.equal(c.claudeArgs[mi + 1], "/tmp/run/mcp-empty.json");
  assert.deepEqual(c.mcpConfig, { mcpServers: {} });
});

// ── binding 기반 fail-fast ────────────────────────────────────
test("fail-fast(builtin): mock은 내장 도구 미지원 → 거부, claude-code는 통과", () => {
  const p = loadToolProfiles().get("planning-local-readonly")!;
  const c = compileToolProfile(p, { bare: true });
  assert.throws(() => assertPolicyExecutable(c, { provider: getProviderCapabilities("mock") }), ToolProfileError);
  assert.doesNotThrow(() => assertPolicyExecutable(c, { provider: getProviderCapabilities("claude-code") }));
});

test("fail-fast(mcp): anthropic은 MCP 미지원 → 거부", () => {
  const p = loadToolProfiles(FIX("valid-mcp.json")).get("dev-shadcn-readonly")!;
  const c = compileToolProfile(p);
  assert.throws(() => assertPolicyExecutable(c, { provider: getProviderCapabilities("anthropic") }), /MCP/);
  assert.doesNotThrow(() => assertPolicyExecutable(c, { provider: getProviderCapabilities("claude-code") }));
});

test("fail-fast(internal_adapter): 미등록 어댑터 → 거부", () => {
  // 인라인 profile: internal_adapter binding (M2 어댑터 레지스트리는 비어있음)
  const c = compileToolProfile({
    id: "x", capabilities: ["web_search"],
    bindings: { web_search: { kind: "internal_adapter", adapter: "tavily", operations: ["search"] } },
    servers: [], preapprovedTools: [], deniedTools: [], permissionMode: "read_only",
    allowedDomains: null, limits: { maxCallsPerStep: 1, maxResultChars: 1, maxElapsedMsPerCall: 1 }, secretRefs: [],
  });
  assert.throws(() => assertPolicyExecutable(c, { provider: getProviderCapabilities("claude-code") }), /어댑터/);
  assert.doesNotThrow(() =>
    assertPolicyExecutable(c, { provider: getProviderCapabilities("claude-code"), adapters: new Set(["tavily"]) }),
  );
});

test("fail-fast(cli): 명령 미존재 → 거부", () => {
  const c = compileToolProfile({
    id: "x", capabilities: ["framework_docs"],
    bindings: { framework_docs: { kind: "cli", command: "nonexistent-cli" } },
    servers: [], preapprovedTools: [], deniedTools: [], permissionMode: "read_only",
    allowedDomains: null, limits: { maxCallsPerStep: 1, maxResultChars: 1, maxElapsedMsPerCall: 1 }, secretRefs: [],
  });
  assert.throws(
    () => assertPolicyExecutable(c, { provider: getProviderCapabilities("claude-code"), commandAvailable: () => false }),
    /CLI/,
  );
  assert.doesNotThrow(() =>
    assertPolicyExecutable(c, { provider: getProviderCapabilities("claude-code"), commandAvailable: () => true }),
  );
});
