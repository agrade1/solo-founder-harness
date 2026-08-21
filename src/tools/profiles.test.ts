import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadToolProfiles,
  parseToolProfiles,
  compileToolProfile,
  assertPolicyExecutable,
  hasMcpBinding,
  ToolProfileError,
  deriveExposedTools,
  MAX_EXPOSED_TOOLS_PER_PROFILE,
  MAX_MCP_SERVERS_PER_PROFILE,
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

// ── [M2.1] MCP fail-closed 술어 (loader/compile은 성공) ──────────
test("[M2.1] hasMcpBinding: mcp profile은 true, builtin profile은 false", () => {
  const mcp = loadToolProfiles(FIX("valid-mcp.json")).get("dev-shadcn-readonly")!;
  const builtin = loadToolProfiles().get("planning-local-readonly")!;
  assert.equal(hasMcpBinding(mcp), true);
  assert.equal(hasMcpBinding(builtin), false);
});

test("[M2.1] MCP profile은 loader/compile에서 거부되지 않는다 (M3가 로드해야 함)", () => {
  assert.doesNotThrow(() => {
    const p = loadToolProfiles(FIX("valid-mcp.json")).get("dev-shadcn-readonly")!;
    compileToolProfile(p);
  });
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

// ── [M3c-3b] validateServer: 로드 단계 server 계약 강제 ──────────────────────────
function parseServers(servers: unknown[]): void {
  parseToolProfiles({
    profiles: [
      {
        id: "srvtest",
        capabilities: [],
        bindings: {},
        servers,
        preapprovedTools: [],
        deniedTools: [],
        permissionMode: "read_only",
        allowedDomains: [],
        limits: { maxCallsPerStep: 0, maxResultChars: 0, maxElapsedMsPerCall: 0 },
        secretRefs: [],
      },
    ],
  });
}

test("[M3c-3b] validateServer: launcher/stdio/http/bare 유효 서버 허용", () => {
  assert.doesNotThrow(() => parseServers([{ name: "shadcn", launcher: "shadcn_read_proxy" }]));
  assert.doesNotThrow(() => parseServers([{ name: "s", command: "node", args: ["a"] }]));
  assert.doesNotThrow(() => parseServers([{ name: "s", command: "node" }]));
  assert.doesNotThrow(() => parseServers([{ name: "s", url: "https://x/mcp" }]));
  assert.doesNotThrow(() => parseServers([{ name: "s" }])); // bare (M2 호환)
});

test("[M3c-3b] validateServer: 알 수 없는 launcher → ToolProfileError", () => {
  assert.throws(() => parseServers([{ name: "s", launcher: "evil" }]), ToolProfileError);
});

test("[M3c-3b] validateServer: launcher + command/args/url/transport(unknown key) → ToolProfileError", () => {
  for (const extra of [{ command: "node" }, { args: ["x"] }, { url: "https://x/" }, { transport: "stdio" }]) {
    assert.throws(() => parseServers([{ name: "s", launcher: "shadcn_read_proxy", ...extra }]), ToolProfileError);
  }
});

test("[M3c-3b] validateServer: mixed transport(http+command, stdio+url) → ToolProfileError", () => {
  assert.throws(() => parseServers([{ name: "s", transport: "http", command: "node" }]), ToolProfileError);
  assert.throws(() => parseServers([{ name: "s", command: "node", url: "https://x/" }]), ToolProfileError);
});

test("[M3c-3b] validateServer: http non-HTTPS → ToolProfileError", () => {
  assert.throws(() => parseServers([{ name: "s", url: "http://insecure/" }]), ToolProfileError);
});

test("[M3c-3b] validateServer: unknown key / bad transport / name 누락 → ToolProfileError", () => {
  assert.throws(() => parseServers([{ name: "s", command: "node", foo: 1 }]), ToolProfileError);
  assert.throws(() => parseServers([{ name: "s", foo: 1 }]), ToolProfileError); // bare + unknown key
  assert.throws(() => parseServers([{ name: "s", transport: "sse" }]), ToolProfileError);
  assert.throws(() => parseServers([{ command: "node" }]), ToolProfileError); // name 누락
});

// ── [M7 T5] 도구 예산 상한 — 초과 등록 fail-closed ─────────────────────────────
function parseBudget(servers: unknown[], toolCount: number): void {
  parseToolProfiles({
    profiles: [
      {
        id: "budget",
        capabilities: ["repo_read"],
        bindings: {
          repo_read: { kind: "builtin", tools: Array.from({ length: toolCount }, (_, i) => `T${i}`) },
        },
        servers,
        preapprovedTools: [],
        deniedTools: [],
        permissionMode: "read_only",
        allowedDomains: [],
        limits: { maxCallsPerStep: 0, maxResultChars: 0, maxElapsedMsPerCall: 0 },
        secretRefs: [],
      },
    ],
  });
}

test("[M7 T5] 노출 도구 수가 예산 상한을 넘으면 로드 거부, 상한 이내는 통과", () => {
  assert.doesNotThrow(() => parseBudget([], MAX_EXPOSED_TOOLS_PER_PROFILE));
  assert.throws(() => parseBudget([], MAX_EXPOSED_TOOLS_PER_PROFILE + 1), ToolProfileError);
});

test("[M7 T5] MCP 서버 수가 예산 상한을 넘으면 로드 거부, 상한 이내는 통과", () => {
  const srv = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}` }));
  assert.doesNotThrow(() => parseBudget(srv(MAX_MCP_SERVERS_PER_PROFILE), 1));
  assert.throws(() => parseBudget(srv(MAX_MCP_SERVERS_PER_PROFILE + 1), 1), ToolProfileError);
});

test("[M7 T5] 실사용 registry의 모든 profile이 예산 상한 안에 있다(실측 근거)", () => {
  for (const [, p] of loadToolProfiles()) {
    assert.ok(p.servers.length <= MAX_MCP_SERVERS_PER_PROFILE);
    assert.ok(deriveExposedTools(p.bindings).exposed.length <= MAX_EXPOSED_TOOLS_PER_PROFILE);
  }
});
