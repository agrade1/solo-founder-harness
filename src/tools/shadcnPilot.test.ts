/**
 * [V3 M3c-0] shadcn discovery scaffold offline 테스트 (P0/P1 하드닝 포함).
 * fake claude stub + NDJSON fixture만 사용. 실제 claude/npx/shadcn/네트워크를 실행하지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkComponentsJson,
  shadcnDiscoveryProfile,
  runShadcnDiscovery,
  ShadcnDiscoveryError,
  SHADCN_PACKAGE,
  SHADCN_SERVER,
  MAX_DISCOVERY_TOOLS,
} from "./shadcnPilot.js";
import { writeMcpConfig } from "../providers/claudeCodeMcpAdapter.js";
import { PACKAGE_ROOT } from "../core/paths.js";

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

// ── 표준 registry 검사 (단위) ─────────────────────────────────────────────────

function withCwd(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "shadcn-reg-"));
  try {
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("[M3c-0] components.json 없음/없는 registries/빈 객체 → 허용", () => {
  withCwd((cwd) => assert.deepEqual(checkComponentsJson(cwd), { ok: true }));
  withCwd((cwd) => {
    writeFileSync(join(cwd, "components.json"), JSON.stringify({ style: "new-york", tailwind: {} }), "utf8");
    assert.deepEqual(checkComponentsJson(cwd), { ok: true });
  });
  withCwd((cwd) => {
    writeFileSync(join(cwd, "components.json"), JSON.stringify({ registries: {} }), "utf8");
    assert.deepEqual(checkComponentsJson(cwd), { ok: true });
  });
});

test("[M3c-0] custom/private/third-party/배열 registries → custom_registry_forbidden", () => {
  for (const registries of [
    { "@acme": "https://acme.example/r/{name}.json" },
    { "@private": { url: "https://x/", headers: { Authorization: "Bearer TOP_SECRET_VALUE" } } },
    { a: "x", b: "y" },
    ["x"],
  ] as unknown[]) {
    withCwd((cwd) => {
      writeFileSync(join(cwd, "components.json"), JSON.stringify({ registries }), "utf8");
      const r = checkComponentsJson(cwd);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "custom_registry_forbidden");
    });
  }
});

test("[M3c-0] malformed/root 비객체 → malformed (내용 미포함)", () => {
  withCwd((cwd) => {
    writeFileSync(join(cwd, "components.json"), "{ not json", "utf8");
    const r = checkComponentsJson(cwd);
    assert.equal(r.ok === false && r.code, "malformed");
  });
  withCwd((cwd) => {
    writeFileSync(join(cwd, "components.json"), JSON.stringify(["array-root"]), "utf8");
    const r = checkComponentsJson(cwd);
    assert.equal(r.ok === false && r.code, "malformed");
  });
});

test("[M3c-0] symlink components.json → not_regular_file (O_NOFOLLOW, 미추적)", () => {
  withCwd((cwd) => {
    const target = join(cwd, "real.json");
    writeFileSync(target, JSON.stringify({ registries: {} }), "utf8");
    symlinkSync(target, join(cwd, "components.json"));
    const r = checkComponentsJson(cwd);
    assert.equal(r.ok === false && r.code, "not_regular_file");
  });
});

test("[M3c-0] 디렉터리(일반 파일 아님) → not_regular_file", () => {
  withCwd((cwd) => {
    mkdirSync(join(cwd, "components.json"));
    const r = checkComponentsJson(cwd);
    assert.equal(r.ok === false && r.code, "not_regular_file");
  });
});

test("[M3c-0] 64KiB 초과 → too_large", () => {
  withCwd((cwd) => {
    const big = '{"registries":{},"pad":"' + "x".repeat(64 * 1024 + 10) + '"}';
    writeFileSync(join(cwd, "components.json"), big, "utf8");
    const r = checkComponentsJson(cwd);
    assert.equal(r.ok === false && r.code, "too_large");
  });
});

// ── shadcn 파일럿 정책 / package 고정 계약 ────────────────────────────────────

test("[M3c-0] shadcn discovery config = 단일 shadcn 서버 · 정확히 npx --yes shadcn@4.13.1 mcp", () => {
  const dir = mkdtempSync(join(tmpdir(), "shadcn-cfg-"));
  try {
    const written = writeMcpConfig(shadcnDiscoveryProfile(), join(dir, "rt"));
    assert.deepEqual(written.expectedServers, [SHADCN_SERVER]);
    assert.deepEqual(written.expectedTools, [], "discovery는 expected 도구가 없다(발견 대상)");
    const cfg = JSON.parse(readFileSync(written.configPath, "utf8"));
    assert.deepEqual(Object.keys(cfg.mcpServers), [SHADCN_SERVER]);
    assert.equal(cfg.mcpServers.shadcn.command, "npx");
    assert.deepEqual(cfg.mcpServers.shadcn.args, ["--yes", "shadcn@4.13.1", "mcp"]);
    assert.equal(SHADCN_PACKAGE, "shadcn@4.13.1");
    // package 고정: shadcnDiscoveryProfile은 인자를 받지 않는다(다른 package 주입 불가).
    assert.equal(shadcnDiscoveryProfile.length, 0, "shadcnDiscoveryProfile은 매개변수가 없어야 함");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── discovery (fake claude stub) ──────────────────────────────────────────────

function initLine(mcpServers: { name: string; status: string }[], tools: string[]): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: "s", cwd: "/svc", permissionMode: "plan", tools, mcp_servers: mcpServers });
}

interface StubEnv {
  stdout?: string;
  stderr?: string;
  stderrFile?: string; // 대용량 stderr용 파일 경로 (테스트가 미리 씀)
  stdoutRaw?: string; // 개행 없는 대용량 stdout
  exit?: number;
  hang?: boolean;
  envOut?: boolean; // 스텁이 자기 env를 덤프
}

interface DiscoveryOpts {
  componentsJson?: string; // serviceCwd/components.json 내용
  componentsSymlink?: boolean;
  preSeedDiscovery?: boolean; // runtimeDir/mcp-discovery.json 사전 생성 (wx 충돌 유도)
  timeoutMs?: number;
  redactNames?: string[];
  testEnvExtra?: Record<string, string>; // forced env 우회 시도용
}

async function runDiscovery(stub: StubEnv, opts: DiscoveryOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shadcn-disc-"));
  const stubPath = join(dir, "claude-stub.sh");
  writeFileSync(
    stubPath,
    `#!/bin/sh
[ -n "$SC_ENVOUT" ] && env > "$SC_ENVOUT"
cat >/dev/null
[ -n "$SC_STDOUT" ] && cat "$SC_STDOUT"
[ -n "$SC_STDERR" ] && printf '%s\\n' "$SC_STDERR" >&2
[ -n "$SC_STDERR_FILE" ] && cat "$SC_STDERR_FILE" >&2
[ -n "$SC_HANG" ] && sleep 30
exit \${SC_EXIT:-0}
`,
    "utf8",
  );
  chmodSync(stubPath, 0o755);

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
  if (opts.preSeedDiscovery) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(runtimeDir, "mcp-discovery.json"), "PREEXISTING\n", "utf8");
  }

  const stdoutFile = join(dir, "out.ndjson");
  if (stub.stdout !== undefined) writeFileSync(stdoutFile, stub.stdout.endsWith("\n") ? stub.stdout : stub.stdout + "\n", "utf8");
  else if (stub.stdoutRaw !== undefined) writeFileSync(stdoutFile, stub.stdoutRaw, "utf8"); // 개행 없이 그대로
  const envOutFile = join(dir, "childenv.txt");

  const testEnv: Record<string, string> = { ...(opts.testEnvExtra ?? {}) };
  if (stub.stdout !== undefined || stub.stdoutRaw !== undefined) testEnv.SC_STDOUT = stdoutFile;
  if (stub.stderr !== undefined) testEnv.SC_STDERR = stub.stderr;
  if (stub.stderrFile !== undefined) testEnv.SC_STDERR_FILE = stub.stderrFile;
  if (stub.exit !== undefined) testEnv.SC_EXIT = String(stub.exit);
  if (stub.hang) testEnv.SC_HANG = "1";
  if (stub.envOut) testEnv.SC_ENVOUT = envOutFile;

  try {
    const res = await runShadcnDiscovery({
      serviceCwd,
      runtimeDir,
      now: () => "2026-01-01T00:00:00.000Z",
      timeoutMs: opts.timeoutMs ?? 5000,
      claudeBin: stubPath,
      redactNames: opts.redactNames,
      testEnv,
    });
    return { res, dir, runtimeDir, serviceCwd, envOutFile };
  } catch (e) {
    return { err: e as Error, dir, runtimeDir, serviceCwd, envOutFile };
  }
}

test("[M3c-0] discovery 성공(generic fixture) → mode/usableForHandoff·도구명·권한, 반환==저장 deepEqual, raw init 미저장", async () => {
  const out = await runDiscovery({
    stdout: initLine([{ name: "shadcn", status: "connected" }], ["Read", "mcp__shadcn__get_items", "mcp__shadcn__view_item"]),
  });
  try {
    assert.ok(out.res, out.err ? `예상외 오류: ${out.err.message}` : "결과 없음");
    const res = out.res!;
    assert.equal(res.discovery, true);
    assert.equal((res as unknown as { ok?: unknown }).ok, undefined, "PreflightSuccess(ok)와 타입 분리");
    assert.equal(res.snapshot.mode, "discovery");
    assert.equal(res.snapshot.usableForHandoff, false);
    assert.equal(res.snapshot.package, SHADCN_PACKAGE);
    assert.equal(res.snapshot.server, "shadcn");
    assert.equal(res.snapshot.status, "connected");
    assert.deepEqual(res.snapshot.tools, ["mcp__shadcn__get_items", "mcp__shadcn__view_item"]);
    assert.equal(res.snapshot.configHash.length, 64);
    // 산출물 분리 + 권한
    assert.ok(res.snapshotPath.endsWith("mcp-discovery.json"));
    assert.ok(!existsSync(join(out.runtimeDir, "tools-snapshot.json")), "일반 preflight snapshot과 분리");
    assert.equal(mode(res.snapshotPath), 0o600);
    assert.equal(mode(out.runtimeDir), 0o700);
    // 반환 snapshot == 저장 JSON deepEqual
    const saved = JSON.parse(readFileSync(res.snapshotPath, "utf8"));
    assert.deepEqual(saved, res.snapshot, "반환 snapshot == 저장 JSON");
    // raw init 미저장
    const body = readFileSync(res.snapshotPath, "utf8");
    assert.ok(!body.includes("subtype") && !body.includes("permissionMode") && !body.includes("session_id"), "raw init 미저장");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-0][P0-1] custom registry는 핵심 API에서 거부 → registry_*, spawn·config·snapshot 없음", async () => {
  // 유효한 init을 stub에 줘도, registry 검사가 spawn 이전이라 config/snapshot이 생기지 않아야 한다.
  const out = await runDiscovery(
    { stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__x"]) },
    { componentsJson: JSON.stringify({ registries: { "@acme": "https://x/" } }) },
  );
  try {
    assert.ok(out.err instanceof ShadcnDiscoveryError);
    assert.equal((out.err as ShadcnDiscoveryError).code, "registry_custom_registry_forbidden");
    assert.ok(!existsSync(out.runtimeDir), "registry 실패 시 runtimeDir 미생성(config/spawn 없음)");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-0][P0-1] malformed/symlink registry도 핵심 API에서 fail-closed(spawn 없음)", async () => {
  const a = await runDiscovery({ stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__x"]) }, { componentsJson: "{ bad" });
  try {
    assert.equal((a.err as ShadcnDiscoveryError)?.code, "registry_malformed");
    assert.ok(!existsSync(a.runtimeDir));
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  const b = await runDiscovery({ stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__x"]) }, { componentsSymlink: true });
  try {
    assert.equal((b.err as ShadcnDiscoveryError)?.code, "registry_not_regular_file");
    assert.ok(!existsSync(b.runtimeDir));
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("[M3c-0][P0-3] 빈 도구(shadcn connected, tools=0) → no_tools, snapshot 미생성", async () => {
  const out = await runDiscovery({ stdout: initLine([{ name: "shadcn", status: "connected" }], ["Read", "Glob"]) });
  try {
    assert.equal((out.err as ShadcnDiscoveryError)?.code, "no_tools");
    assert.ok(!existsSync(join(out.runtimeDir, "mcp-discovery.json")), "no_tools 시 snapshot 미생성");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-0] extra server / foreign tool / duplicate / empty / too-long / too-many / not-connected 거부", async () => {
  const cases: [StubEnv, string][] = [
    [{ stdout: initLine([{ name: "shadcn", status: "connected" }, { name: "canary", status: "connected" }], ["mcp__shadcn__x", "mcp__canary__leak"]) }, "server_mismatch"],
    [{ stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__ok", "mcp__other__leak"]) }, "foreign_tool"],
    [{ stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__dup", "mcp__shadcn__dup"]) }, "duplicate_tool"],
    [{ stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__"]) }, "empty_tool"],
    [{ stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__" + "x".repeat(256)]) }, "tool_name_too_long"],
    [{ stdout: initLine([{ name: "shadcn", status: "connected" }], Array.from({ length: MAX_DISCOVERY_TOOLS + 1 }, (_v, i) => `mcp__shadcn__t${i}`)) }, "too_many_tools"],
    [{ stdout: initLine([{ name: "shadcn", status: "pending" }], []) }, "server_not_connected"],
  ];
  for (const [stub, code] of cases) {
    const out = await runDiscovery(stub);
    try {
      assert.equal((out.err as ShadcnDiscoveryError)?.code, code, `기대 code=${code}`);
      assert.ok(!existsSync(join(out.runtimeDir, "mcp-discovery.json")), `${code}: snapshot 미생성`);
    } finally {
      rmSync(out.dir, { recursive: true, force: true });
    }
  }
});

test("[M3c-0] no-init / non-zero / timeout / stdout·stderr 상한 거부 + 오류 redaction", async () => {
  const a = await runDiscovery({ stdout: JSON.stringify({ type: "system", subtype: "status", status: "x" }) });
  try {
    assert.equal((a.err as ShadcnDiscoveryError)?.code, "no_init");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
  }
  // non-zero + credential 형태 stderr → 오류에 평문 미노출
  const b = await runDiscovery({ exit: 1, stderr: "boom Authorization: Bearer LEAKED_TOKEN_VALUE token=OTHER_LEAK" });
  try {
    assert.equal((b.err as ShadcnDiscoveryError)?.code, "nonzero_exit");
    assert.ok(!b.err!.message.includes("LEAKED_TOKEN_VALUE") && !b.err!.message.includes("OTHER_LEAK"), "credential 평문 미노출");
  } finally {
    rmSync(b.dir, { recursive: true, force: true });
  }
  const c = await runDiscovery({ hang: true }, { timeoutMs: 300 });
  try {
    assert.equal((c.err as ShadcnDiscoveryError)?.code, "timeout");
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
  // stdout 1MiB 초과(개행 없음) → stdout_too_large
  const d = await runDiscovery({ stdoutRaw: "x".repeat(1024 * 1024 + 16) });
  try {
    assert.equal((d.err as ShadcnDiscoveryError)?.code, "stdout_too_large");
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
  // stderr 64KiB 초과 → stderr_too_large (대용량은 파일로)
  const errDir = mkdtempSync(join(tmpdir(), "shadcn-err-"));
  const bigErr = join(errDir, "err.txt");
  writeFileSync(bigErr, "e".repeat(64 * 1024 + 16), "utf8");
  const e = await runDiscovery({ stderrFile: bigErr, hang: true }, { timeoutMs: 4000 });
  try {
    assert.equal((e.err as ShadcnDiscoveryError)?.code, "stderr_too_large");
  } finally {
    rmSync(e.dir, { recursive: true, force: true });
    rmSync(errDir, { recursive: true, force: true });
  }
});

test("[M3c-0][P0-4] redactNames로 sentinel/credential 평문 부재 (오류·성공 snapshot)", async () => {
  const SENT = "M3C_TEST_SENTINEL";
  const VAL = "supersecret-" + "z".repeat(12);
  const prev = process.env[SENT];
  process.env[SENT] = VAL;
  try {
    // 오류 경로: 중복 도구명에 credential 형태 + duplicate 트리거
    const dup = "mcp__shadcn__token=" + VAL;
    const a = await runDiscovery({ stdout: initLine([{ name: "shadcn", status: "connected" }], [dup, dup]) }, { redactNames: [SENT] });
    try {
      assert.equal((a.err as ShadcnDiscoveryError)?.code, "duplicate_tool");
      assert.ok(!a.err!.message.includes(VAL), "오류에 sentinel 값 평문 없음");
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
    }
    // 성공 snapshot: 도구명에 sentinel 값 → scrub되어 저장·반환
    const toolWithSent = "mcp__shadcn__t_" + VAL;
    const b = await runDiscovery({ stdout: initLine([{ name: "shadcn", status: "connected" }], [toolWithSent]) }, { redactNames: [SENT] });
    try {
      assert.ok(b.res, b.err?.message);
      const body = readFileSync(b.res!.snapshotPath, "utf8");
      assert.ok(!body.includes(VAL), "저장 snapshot에 sentinel 값 없음");
      assert.ok(!JSON.stringify(b.res!.snapshot).includes(VAL), "반환 snapshot에 sentinel 값 없음");
      assert.deepEqual(JSON.parse(body), b.res!.snapshot, "반환==저장");
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env[SENT];
    else process.env[SENT] = prev;
  }
});

test("[M3c-0][P1-7] testEnv는 강제 env(MCP_CONNECTION_NONBLOCKING 등)를 덮어쓸 수 없다", async () => {
  const out = await runDiscovery(
    { stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__x"]), envOut: true },
    { testEnvExtra: { MCP_CONNECTION_NONBLOCKING: "BAD", ENABLE_TOOL_SEARCH: "yes", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } },
  );
  try {
    assert.ok(out.res, out.err?.message);
    const dump = readFileSync(out.envOutFile, "utf8");
    assert.ok(/^MCP_CONNECTION_NONBLOCKING=0$/m.test(dump), "MCP_CONNECTION_NONBLOCKING 강제 0");
    assert.ok(/^ENABLE_TOOL_SEARCH=false$/m.test(dump), "ENABLE_TOOL_SEARCH 강제 false");
    assert.ok(/^CLAUDE_CODE_DISABLE_AUTO_MEMORY=1$/m.test(dump), "auto-memory 강제 1");
    assert.ok(!/MCP_CONNECTION_NONBLOCKING=BAD/.test(dump), "testEnv 우회 불가");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-0][P1-8] mcp-discovery.json wx 충돌 → persist(typed) + 부분 성공 미반환", async () => {
  const out = await runDiscovery(
    { stdout: initLine([{ name: "shadcn", status: "connected" }], ["mcp__shadcn__x"]) },
    { preSeedDiscovery: true },
  );
  try {
    assert.equal((out.err as ShadcnDiscoveryError)?.code, "persist");
    assert.ok(out.res === undefined, "부분 성공 결과 미반환");
    // 기존 파일을 덮어쓰지 않았다.
    assert.equal(readFileSync(join(out.runtimeDir, "mcp-discovery.json"), "utf8"), "PREEXISTING\n");
  } finally {
    rmSync(out.dir, { recursive: true, force: true });
  }
});

test("[M3c-0] 불변: registry/tool_profiles.json에 shadcn profile 미등록", () => {
  const reg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "registry", "tool_profiles.json"), "utf8"));
  assert.ok(!/shadcn/i.test(JSON.stringify(reg)), "registry에 shadcn profile 미등록");
});
