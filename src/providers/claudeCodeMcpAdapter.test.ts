/**
 * [M3a] MCP config 생성·검증 테스트 (실제 claude 미실행).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildMcpConfig, writeMcpConfig, McpConfigError } from "./claudeCodeMcpAdapter.js";
import type { ToolProfile } from "../tools/profiles.js";

function profile(over: Partial<ToolProfile>): ToolProfile {
  return {
    id: "p",
    capabilities: [],
    bindings: {},
    servers: [],
    preapprovedTools: [],
    deniedTools: [],
    permissionMode: "read_only",
    allowedDomains: null,
    limits: { maxCallsPerStep: 1, maxResultChars: 1, maxElapsedMsPerCall: 1 },
    secretRefs: [],
    ...over,
  };
}

const stdioProfile = () =>
  profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opb", "opa"] } },
    servers: [{ name: "srva", command: "node", args: ["srva-stub@1.0.0"] }],
    preapprovedTools: ["mcp__srva__opa", "mcp__srva__opb"],
  });

test("[M3a] stdio 서버: config 엔트리·정렬된 기대 서버/도구", () => {
  const c = buildMcpConfig(stdioProfile());
  assert.deepEqual(c.config.mcpServers, { srva: { command: "node", args: ["srva-stub@1.0.0"], alwaysLoad: true } });
  assert.deepEqual(c.expectedServers, ["srva"]);
  assert.deepEqual(c.expectedTools, ["mcp__srva__opa", "mcp__srva__opb"]); // 정렬됨
});

test("[M3a] 선언된(참조된) 서버만 config에 포함 — 미참조 서버 제외", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa"] } },
    servers: [
      { name: "srva", command: "node", args: ["a@1.0.0"] },
      { name: "srvz", command: "node", args: ["z@1.0.0"] }, // 미참조
    ],
    preapprovedTools: ["mcp__srva__opa"],
  });
  const c = buildMcpConfig(p);
  assert.deepEqual(Object.keys(c.config.mcpServers), ["srva"]);
});

test("[M3a] binding server가 servers에 없으면 거부", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "ghost", tools: ["opa"] } },
    servers: [{ name: "srva", command: "node", args: ["a@1.0.0"] }],
  });
  assert.throws(() => buildMcpConfig(p), (e: McpConfigError) => e.code === "unknown_binding_server");
});

test("[M3a] 중복 서버 이름 거부", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa"] } },
    servers: [
      { name: "srva", command: "node", args: ["a@1.0.0"] },
      { name: "srva", command: "node", args: ["b@1.0.0"] },
    ],
  });
  assert.throws(() => buildMcpConfig(p), (e: McpConfigError) => e.code === "duplicate_server");
});

test("[M3a] stdio는 command 필수", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa"] } },
    servers: [{ name: "srva" }], // command 없음
  });
  assert.throws(() => buildMcpConfig(p), (e: McpConfigError) => e.code === "bad_command");
});

test("[M3a] http는 HTTPS url 필수 (http 거부, https 허용)", () => {
  const bad = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srvh", tools: ["opa"] } },
    servers: [{ name: "srvh", transport: "http", url: "http://insecure.example" }],
  });
  assert.throws(() => buildMcpConfig(bad), (e: McpConfigError) => e.code === "bad_url");

  const good = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srvh", tools: ["opa"] } },
    servers: [{ name: "srvh", transport: "http", url: "https://secure.example/mcp" }],
    preapprovedTools: ["mcp__srvh__opa"],
  });
  const c = buildMcpConfig(good);
  assert.deepEqual(c.config.mcpServers, { srvh: { type: "http", url: "https://secure.example/mcp", alwaysLoad: true } });
});

test("[M3a] @latest 거부", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa"] } },
    servers: [{ name: "srva", command: "npx", args: ["-y", "some-mcp@latest"] }],
  });
  assert.throws(() => buildMcpConfig(p), (e: McpConfigError) => e.code === "latest_forbidden");
});

// ── [M3a 보안] npx 고정 버전 검증 ─────────────────────────────
function npxProfile(spec: string, command = "npx"): ToolProfile {
  return profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa"] } },
    servers: [{ name: "srva", command, args: ["-y", spec] }],
    preapprovedTools: ["mcp__srva__opa"],
  });
}

for (const spec of ["shadcn@4.13.0", "@scope/pkg@1.2.3", "pkg@1.2.3-beta.1"]) {
  test(`[M3a] npx 고정 버전 허용: ${spec}`, () => {
    assert.doesNotThrow(() => buildMcpConfig(npxProfile(spec)));
  });
}

for (const spec of ["package", "package@next", "package@^1.2.3", "package@~1.0.0", "package@*", "package@1", "package@1.2"]) {
  test(`[M3a] npx 미고정 거부: ${spec}`, () => {
    assert.throws(() => buildMcpConfig(npxProfile(spec)), (e: McpConfigError) => e.code === "unpinned_npx");
  });
}

test("[M3a] npx @latest는 latest_forbidden (기존 규칙 유지)", () => {
  assert.throws(() => buildMcpConfig(npxProfile("package@latest")), (e: McpConfigError) => e.code === "latest_forbidden");
});

test("[M3a] 절대경로 npx도 동일 pin 규칙", () => {
  assert.throws(
    () => buildMcpConfig(npxProfile("package", "/usr/local/bin/npx")),
    (e: McpConfigError) => e.code === "unpinned_npx",
  );
  assert.doesNotThrow(() => buildMcpConfig(npxProfile("pkg@1.0.0", "/usr/local/bin/npx")));
});

test("[M3a] 일반 node/local executable에는 npm pin 규칙 미적용", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa"] } },
    servers: [{ name: "srva", command: "node", args: ["./server.js", "--port", "3000"] }],
    preapprovedTools: ["mcp__srva__opa"],
  });
  assert.doesNotThrow(() => buildMcpConfig(p));
});

// ── [M3a 보안] config 검증 강화 ──────────────────────────────
test("[M3a] 중복 파생 도구는 거부 (조용한 dedupe 금지)", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa", "opa"] } },
    servers: [{ name: "srva", command: "node", args: ["s@1.0.0"] }],
    preapprovedTools: ["mcp__srva__opa"],
  });
  assert.throws(() => buildMcpConfig(p), (e: McpConfigError) => e.code === "duplicate_tool");
});

test("[M3a] transport는 stdio/http만", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "s", tools: ["opa"] } },
    servers: [{ name: "s", transport: "sse" as never, url: "https://x" }],
  });
  assert.throws(() => buildMcpConfig(p), (e: McpConfigError) => e.code === "bad_transport");
});

test("[M3a] 혼합 전송 거부 (stdio+url, http+command)", () => {
  const stdioUrl = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "s", tools: ["opa"] } },
    servers: [{ name: "s", transport: "stdio", command: "node", url: "https://x" }],
  });
  assert.throws(() => buildMcpConfig(stdioUrl), (e: McpConfigError) => e.code === "mixed_transport");

  const httpCmd = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "s", tools: ["opa"] } },
    servers: [{ name: "s", transport: "http", url: "https://x", command: "node" }],
  });
  assert.throws(() => buildMcpConfig(httpCmd), (e: McpConfigError) => e.code === "mixed_transport");
});

test("[M3a] secretRefs 실제 값이 command/args/url에 있으면 거부 (오류에 값 미포함)", () => {
  const p = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "s", tools: ["opa"] } },
    servers: [{ name: "s", command: "node", args: ["--pass", "topsecretvalue"] }],
    secretRefs: ["MY_SECRET"],
  });
  try {
    buildMcpConfig(p, ["topsecretvalue"]);
    assert.fail("throw 했어야 함");
  } catch (e) {
    assert.equal((e as McpConfigError).code, "secret_in_config");
    assert.ok(!(e as Error).message.includes("topsecretvalue"), "오류에 secret 값 없음");
  }
});

test("[M3a] credential 형태 URL query / arg 거부", () => {
  const urlCred = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "s", tools: ["opa"] } },
    servers: [{ name: "s", transport: "http", url: "https://x/mcp?token=abc123" }],
  });
  assert.throws(() => buildMcpConfig(urlCred), (e: McpConfigError) => e.code === "credential_in_config");

  const argCred = profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "s", tools: ["opa"] } },
    servers: [{ name: "s", command: "node", args: ["--api_key=abc123"] }],
  });
  assert.throws(() => buildMcpConfig(argCred), (e: McpConfigError) => e.code === "credential_in_config");
});

test("[M3a] writeMcpConfig: 파일 기록 + sha256 일치 + secret 평문 부재", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-mcpcfg-"));
  try {
    const p = { ...stdioProfile(), secretRefs: ["MY_SECRET"] };
    const prev = process.env.MY_SECRET;
    process.env.MY_SECRET = "sk-live-SENTINEL";
    try {
      const w = writeMcpConfig(p, dir);
      const bytes = readFileSync(w.configPath, "utf8");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), w.configHash);
      assert.ok(!bytes.includes("sk-live-SENTINEL"), "config에 secret 값 없음");
      assert.match(bytes, /"alwaysLoad": true/);
    } finally {
      if (prev === undefined) delete process.env.MY_SECRET;
      else process.env.MY_SECRET = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
