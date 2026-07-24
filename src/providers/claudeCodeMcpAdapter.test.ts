/**
 * [M3a] MCP config 생성·검증 테스트 (실제 claude 미실행).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildMcpConfig, writeMcpConfig, McpConfigError, verifyTrustedProxyFile } from "./claudeCodeMcpAdapter.js";
import { fromPackage } from "../core/paths.js";
import { TRUSTED_LAUNCHER_IDS } from "../tools/profiles.js";
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


// ── [M3c-3b] 신뢰된 launcher(shadcn_read_proxy) — 실행 경로 override 불가 ──────────
function launcherProfile(over: Record<string, unknown> = {}): ToolProfile {
  return profile({
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "shadcn", tools: ["get_project_registries", "list_items_in_registries"] } },
    servers: [{ name: "shadcn", launcher: "shadcn_read_proxy", ...over } as ToolProfile["servers"][number]],
    preapprovedTools: ["mcp__shadcn__get_project_registries", "mcp__shadcn__list_items_in_registries"],
  });
}

const FIXED_PROXY = fromPackage("dist", "tools", "shadcnReadMcpProxy.js");

test("[M3c-3b] launcher config = node + 고정 절대 proxy 경로 (override 없음·launcher 필드 미포함)", () => {
  const c = buildMcpConfig(launcherProfile());
  assert.deepEqual(c.config.mcpServers, { shadcn: { command: process.execPath, args: [FIXED_PROXY], alwaysLoad: true } });
  const entry = c.config.mcpServers.shadcn as { command: string; args: string[] };
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args[0], FIXED_PROXY, "args[0]는 항상 PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js");
  assert.ok(!JSON.stringify(c.config).includes("launcher"), "생성 config에 launcher 논리 필드 없음");
  assert.ok(!JSON.stringify(c.config).includes("npx"), "npx shadcn 직접 실행 아님");
  assert.deepEqual(c.expectedServers, ["shadcn"]);
  assert.deepEqual(c.expectedTools, ["mcp__shadcn__get_project_registries", "mcp__shadcn__list_items_in_registries"]);
});

test("[M3c-3b] buildMcpConfig 공개 시그니처에 실행 경로 override 인자 없음(3번째 인자 무시)", () => {
  // 실행 경로 override seam이 제거됨: 3번째 인자를 넘겨도 무시되고 항상 고정 경로.
  const c = (buildMcpConfig as unknown as (p: ToolProfile, s?: string[], x?: unknown) => ReturnType<typeof buildMcpConfig>)(
    launcherProfile(),
    undefined,
    { someIgnoredKey: "/tmp/evil-override.js" },
  );
  const entry = c.config.mcpServers.shadcn as { args: string[] };
  assert.equal(entry.args[0], FIXED_PROXY, "3번째 인자로 실행 경로를 바꿀 수 없음");
});

test("[M3c-3b] launcher + command/args/url/transport 혼합 → mixed_launcher 거부 (args:[]도 거부)", () => {
  for (const bad of [{ command: "npx" }, { args: ["x"] }, { args: [] }, { url: "https://x/" }, { transport: "http" }]) {
    assert.throws(
      () => buildMcpConfig(launcherProfile(bad)),
      (e: unknown) => e instanceof McpConfigError && e.code === "mixed_launcher",
      `mixed=${JSON.stringify(bad)}`,
    );
  }
});

test("[M3c-3b] 신뢰 launcher ID는 profiles.TRUSTED_LAUNCHER_IDS 단일 출처", () => {
  assert.deepEqual([...TRUSTED_LAUNCHER_IDS], ["shadcn_read_proxy"], "단일 출처 목록 불변");
  // adapter는 이 목록만 허용한다: 목록 내 값은 통과(파일 실존), 목록 밖은 unknown_launcher.
  for (const id of TRUSTED_LAUNCHER_IDS) {
    assert.doesNotThrow(() => buildMcpConfig(launcherProfile({ launcher: id })));
  }
  const p = launcherProfile();
  (p.servers[0] as { launcher: string }).launcher = "not_in_source";
  assert.throws(() => buildMcpConfig(p), (e: unknown) => e instanceof McpConfigError && e.code === "unknown_launcher");
});

test("[M3c-3b] 알 수 없는 launcher → unknown_launcher 거부", () => {
  const p = launcherProfile();
  (p.servers[0] as { launcher: string }).launcher = "evil_launcher";
  assert.throws(
    () => buildMcpConfig(p),
    (e: unknown) => e instanceof McpConfigError && e.code === "unknown_launcher",
  );
});

test("[M3c-3b] launcher profile이 secretRefs 선언 → launcher_secret_refs_forbidden(값 미노출)", () => {
  const p = { ...launcherProfile(), secretRefs: ["M3C3B_ADAPTER_SENTINEL"] };
  const prev = process.env.M3C3B_ADAPTER_SENTINEL;
  process.env.M3C3B_ADAPTER_SENTINEL = "sk-live-ADAPTER";
  try {
    assert.throws(
      () => buildMcpConfig(p),
      (e: unknown) => e instanceof McpConfigError && e.code === "launcher_secret_refs_forbidden" && !e.message.includes("sk-live-ADAPTER"),
    );
  } finally {
    if (prev === undefined) delete process.env.M3C3B_ADAPTER_SENTINEL;
    else process.env.M3C3B_ADAPTER_SENTINEL = prev;
  }
});

// verifyTrustedProxyFile: 임시 경로로 검증 함수만 테스트(임시 경로가 generated config에 들어가는 API 아님).
test("[M3c-3b] verifyTrustedProxyFile: 정상 파일 통과", () => {
  const dir = mkdtempSync(join(tmpdir(), "vtp-ok-"));
  const f = join(dir, "p.js");
  writeFileSync(f, "//\n", "utf8");
  try {
    assert.doesNotThrow(() => verifyTrustedProxyFile(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3c-3b] verifyTrustedProxyFile: 부재 → launcher_proxy_missing", () => {
  assert.throws(
    () => verifyTrustedProxyFile(join(tmpdir(), `no-such-${process.pid}.js`)),
    (e: unknown) => e instanceof McpConfigError && e.code === "launcher_proxy_missing",
  );
});

test("[M3c-3b] verifyTrustedProxyFile: 디렉터리 → launcher_proxy_not_file", () => {
  const dir = mkdtempSync(join(tmpdir(), "vtp-dir-"));
  const asDir = join(dir, "d");
  mkdirSync(asDir);
  try {
    assert.throws(
      () => verifyTrustedProxyFile(asDir),
      (e: unknown) => e instanceof McpConfigError && e.code === "launcher_proxy_not_file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3c-3b] verifyTrustedProxyFile: symlink → launcher_proxy_symlink 거부(lstat 기반)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vtp-sym-"));
  const real = join(dir, "real.js");
  const link = join(dir, "link.js");
  writeFileSync(real, "//\n", "utf8");
  symlinkSync(real, link);
  try {
    assert.throws(
      () => verifyTrustedProxyFile(link),
      (e: unknown) => e instanceof McpConfigError && e.code === "launcher_proxy_symlink",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3c-3b] verifyTrustedProxyFile: 읽기 불가 → launcher_proxy_unreadable", () => {
  const dir = mkdtempSync(join(tmpdir(), "vtp-noread-"));
  const f = join(dir, "p.js");
  writeFileSync(f, "//\n", "utf8");
  chmodSync(f, 0o000);
  try {
    assert.throws(
      () => verifyTrustedProxyFile(f),
      (e: unknown) => e instanceof McpConfigError && e.code === "launcher_proxy_unreadable",
    );
  } finally {
    chmodSync(f, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});
