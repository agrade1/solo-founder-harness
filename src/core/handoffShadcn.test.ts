/**
 * [M3c-3b offline] filtered shadcn read profile handoff 배선 테스트.
 * 실제 Claude/npx/TUI/network는 실행하지 않는다:
 *  - preflight exact-5 계약은 fake claude 스텁(NDJSON init)으로만 검증.
 *  - handoff 통합 경로는 preflight/spawn seam 주입.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoff, PILOT_SHADCN_PROFILE_ID, type HandoffOptions } from "./handoff.js";
import { runWorkflow, loadRunState } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import { fromPackage } from "./paths.js";
import { mockProvider } from "../providers/mockProvider.js";
import { loadToolProfiles } from "../tools/profiles.js";
import { runPreflight, PreflightError, type PreflightSuccess, type RunPreflightOpts } from "../tools/preflight.js";
import { getAllowedTools, getForbiddenTools, nsName } from "../tools/shadcnReadPolicy.js";

const FIXED = "2026-01-01T00:00:00.000Z";
const ALLOWED_HOST = getAllowedTools().map(nsName).sort();
const DENIED_HOST = getForbiddenTools().map(nsName).sort();

function mode(p: string): number {
  return statSync(p).mode & 0o777;
}

async function completedProject(name: string): Promise<void> {
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트 아이디어\n", "utf8");
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider: mockProvider, now: () => FIXED });
  assert.equal(r.state.status, "completed");
}

/** profile 경로 성공 preflight 스텁: shadcn 서버 + 정확한 host 5개 snapshot 반환. */
function okShadcnPreflight(): (o: RunPreflightOpts) => Promise<PreflightSuccess> {
  return async (o) => ({
    ok: true,
    snapshotPath: join(o.runtimeDir, "tools-snapshot.json"),
    snapshot: {
      profileId: o.profile.id,
      cwd: o.serviceCwd,
      timestamp: FIXED,
      configHash: "c".repeat(64),
      servers: [{ name: "shadcn", status: "connected" }],
      tools: [...ALLOWED_HOST],
    },
  });
}

function captureSpawn() {
  const calls: { bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  return { calls, fn: (bin: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => { calls.push({ bin, argv, cwd: opts.cwd, env: opts.env }); } };
}

function baseOpts(name: string, over: Partial<HandoffOptions> = {}): HandoffOptions {
  return {
    project: name,
    cwd: "/svc/repo", // 실존 안 함 → components.json ENOENT → registry ok
    now: () => FIXED,
    handoffId: "hx",
    isTTY: true,
    yes: true,
    claudeBin: "claude",
    resolveBin: () => true,
    runPreflightFn: okShadcnPreflight(),
    logger: () => {},
    ...over,
  };
}

// ── handoff 통합 (profile 경로, seam 주입) ─────────────────────────────────────

test("[M3c-3b] profile handoff → spawned: allowed 5 / denied 2 / -- 꼬리 / mcp__* deny 부재 / --add-dir", async () => {
  const name = "_hs_ok";
  await completedProject(name);
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { toolProfileId: PILOT_SHADCN_PROFILE_ID, spawnInteractive: sp.fn }));
  try {
    assert.equal(res.action, "spawned");
    if (res.action !== "spawned") return;
    const { argv, env } = sp.calls[0];

    // 대화형 계약 유지
    assert.ok(!argv.includes("-p") && !argv.includes("stream-json") && !argv.includes("--output-format"));
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.equal(argv[argv.indexOf("--tools") + 1], "default");
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default");
    assert.equal(argv[argv.indexOf("--add-dir") + 1], projectPaths(name).root);

    // allowed = 정확한 host 5개, denied = 금지 host 2개 (콤마 결합 단일 값)
    assert.equal(argv[argv.indexOf("--allowedTools") + 1], ALLOWED_HOST.join(","));
    assert.equal(argv[argv.indexOf("--disallowedTools") + 1], DENIED_HOST.join(","));

    // profile 경로에는 전체 mcp__* deny 토큰이 없어야 한다
    assert.ok(!argv.includes("mcp__*"), "profile 경로에 mcp__* 전체 deny 없음");

    // -- 꼬리: 정확히 1개, 마지막이 initialPrompt
    assert.equal(argv.filter((a) => a === "--").length, 1);
    assert.equal(argv.at(-2), "--");
    assert.equal(argv.at(-1), argv[argv.length - 1]);

    // Hook env: profileId + exact toolMap (허용 5개 → shadcn)
    assert.equal(env.HARNESS_TOOL_PROFILE_ID, PILOT_SHADCN_PROFILE_ID);
    const toolMap = JSON.parse(env.HARNESS_TOOL_MAP!) as Record<string, string>;
    assert.deepEqual(Object.keys(toolMap).sort(), [...ALLOWED_HOST].sort());
    assert.ok(Object.values(toolMap).every((v) => v === "shadcn"));
    // 금지 2개는 toolMap에 없음
    for (const d of DENIED_HOST) assert.ok(!(d in toolMap), `${d} toolMap 미포함`);

    // run_state.handoff에 profile 필드 기록 (status/completed 불변)
    const st = loadRunState(name)!;
    assert.equal(st.status, "completed");
    assert.equal(st.handoff!.tool_profile_id, PILOT_SHADCN_PROFILE_ID);
    assert.equal(st.handoff!.config_hash, "c".repeat(64));
    assert.ok(st.handoff!.snapshot_path!.endsWith("tools-snapshot.json"));

    // 최소 권한
    assert.equal(mode(res.settingsPath), 0o600);
    assert.equal(mode(res.runtimeDir), 0o700);
  } finally {
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] profile 승인 preview: profileId·server·허용5·금지2·상한 표시, 'MCP 없음' 문구 부재", async () => {
  const name = "_hs_preview";
  await completedProject(name);
  const sp = captureSpawn();
  let preview = "";
  const res = await runHandoff(
    baseOpts(name, {
      toolProfileId: PILOT_SHADCN_PROFILE_ID,
      yes: false,
      approve: async (_m, p) => { preview = p; return false; },
      spawnInteractive: sp.fn,
    }),
  );
  try {
    assert.equal(res.action, "rejected");
    assert.match(preview, /handoff-shadcn-readonly/);
    assert.match(preview, /MCP 서버: shadcn/);
    for (const a of ALLOWED_HOST) assert.ok(preview.includes(a), `preview에 허용 ${a}`);
    for (const d of DENIED_HOST) assert.ok(preview.includes(d), `preview에 금지 ${d}`);
    assert.match(preview, /calls 6 \/ resultChars 8000 \/ timeout 60000ms/);
    assert.ok(!preview.includes("MCP 서버/도구: 없음"), "'MCP 없음' 문구 제거");
    assert.equal(sp.calls.length, 0);
  } finally {
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] 허용 외 profile id → profile_rejected, spawn/preflight 없음", async () => {
  const name = "_hs_badid";
  await completedProject(name);
  const sp = captureSpawn();
  let preflightCalled = false;
  const res = await runHandoff(
    baseOpts(name, {
      toolProfileId: "planning-local-readonly",
      spawnInteractive: sp.fn,
      runPreflightFn: async (o) => { preflightCalled = true; return okShadcnPreflight()(o); },
    }),
  );
  try {
    assert.equal(res.action, "profile_rejected");
    assert.equal(preflightCalled, false);
    assert.equal(sp.calls.length, 0);
    assert.equal(loadRunState(name)!.handoff, undefined);
  } finally {
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] 변조된 registry(계약 위반) → profile_rejected", async () => {
  const name = "_hs_tampered";
  await completedProject(name);
  // 구조는 유효하지만 계약 위반(source community, permission read_only)인 profile.
  const reg = {
    profiles: [
      {
        id: PILOT_SHADCN_PROFILE_ID,
        capabilities: ["component_registry_read"],
        bindings: { component_registry_read: { kind: "mcp", server: "shadcn", tools: getAllowedTools() } },
        servers: [{ name: "shadcn", launcher: "shadcn_read_proxy" }],
        preapprovedTools: ALLOWED_HOST,
        deniedTools: DENIED_HOST,
        permissionMode: "read_only", // 위반 (approval_write여야 함)
        allowedDomains: [],
        limits: { maxCallsPerStep: 6, maxResultChars: 8000, maxElapsedMsPerCall: 60000 },
        secretRefs: [],
        source: "community", // 위반 (official이어야 함)
      },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "hs-reg-"));
  const regPath = join(dir, "tool_profiles.json");
  writeFileSync(regPath, JSON.stringify(reg), "utf8");
  const sp = captureSpawn();
  try {
    const res = await runHandoff(baseOpts(name, { toolProfileId: PILOT_SHADCN_PROFILE_ID, toolProfilesPath: regPath, spawnInteractive: sp.fn }));
    assert.equal(res.action, "profile_rejected");
    assert.equal(sp.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] custom registry components.json → registry_rejected (Claude/proxy 실행 전, spawn/preflight 없음)", async () => {
  const name = "_hs_customreg";
  await completedProject(name);
  const svc = mkdtempSync(join(tmpdir(), "hs-svc-"));
  writeFileSync(join(svc, "components.json"), JSON.stringify({ registries: { "@acme": "https://acme/{name}.json" } }), "utf8");
  const sp = captureSpawn();
  let preflightCalled = false;
  try {
    const res = await runHandoff(
      baseOpts(name, {
        cwd: svc,
        toolProfileId: PILOT_SHADCN_PROFILE_ID,
        spawnInteractive: sp.fn,
        runPreflightFn: async (o) => { preflightCalled = true; return okShadcnPreflight()(o); },
      }),
    );
    assert.equal(res.action, "registry_rejected");
    if (res.action !== "registry_rejected") return;
    assert.equal(res.code, "custom_registry_forbidden");
    assert.equal(preflightCalled, false, "registry 거부는 preflight 이전");
    assert.equal(sp.calls.length, 0);
    assert.equal(loadRunState(name)!.handoff, undefined);
  } finally {
    rmSync(svc, { recursive: true, force: true });
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] profile preflight 실패(도구 불일치) → preflight_failed, spawn 없음", async () => {
  const name = "_hs_pf";
  await completedProject(name);
  const sp = captureSpawn();
  const res = await runHandoff(
    baseOpts(name, {
      toolProfileId: PILOT_SHADCN_PROFILE_ID,
      spawnInteractive: sp.fn,
      runPreflightFn: async () => { throw new PreflightError("tool_mismatch", "도구 불일치"); },
    }),
  );
  try {
    assert.equal(res.action, "preflight_failed");
    if (res.action !== "preflight_failed") return;
    assert.equal(res.code, "tool_mismatch");
    assert.equal(sp.calls.length, 0);
    assert.equal(loadRunState(name)!.handoff, undefined);
  } finally {
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] --print: 재진입 명령에 --tool-profile 보존, 실행/상태변경 없음", async () => {
  const name = "_hs_print";
  await completedProject(name);
  const res = await runHandoff(baseOpts(name, { toolProfileId: PILOT_SHADCN_PROFILE_ID, print: true }));
  try {
    assert.equal(res.action, "printed");
    if (res.action !== "printed") return;
    assert.match(res.reentryCommand, /--tool-profile 'handoff-shadcn-readonly'/);
    assert.equal(loadRunState(name)!.handoff, undefined);
  } finally {
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

// ── 실제 runPreflight + fake claude 스텁 (exact-5 계약) ──────────────────────

function initLine(tools: string[]): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: "s", cwd: "/svc", permissionMode: "plan", tools, mcp_servers: [{ name: "shadcn", status: "connected" }] });
}

/** fake claude 스텁을 만들고 shadcn profile로 runPreflight를 실행한다(실제 npx/proxy 미실행). */
async function runShadcnPreflight(emittedTools: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "hs-pf-"));
  const stub = join(dir, "claude-stub.sh");
  const stdoutFile = join(dir, "out.ndjson");
  // proxy 실행 경로는 고정(PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js, build 산출물 실존) — override 없음.
  // claude 스텁은 config를 무시하고 canned init만 방출하므로 proxy는 실제 실행되지 않는다.
  writeFileSync(stdoutFile, initLine(emittedTools) + "\n", "utf8");
  writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat "${stdoutFile}"\nexit 0\n`, "utf8");
  chmodSync(stub, 0o755);
  const runtimeDir = join(dir, "runtime");
  const profile = loadToolProfiles().get(PILOT_SHADCN_PROFILE_ID)!;
  const prevBin = process.env.HARNESS_CLAUDE_BIN;
  process.env.HARNESS_CLAUDE_BIN = stub;
  try {
    return await runPreflight({ profile, serviceCwd: dir, runtimeDir, now: () => FIXED, timeoutMs: 8000 });
  } finally {
    if (prevBin === undefined) delete process.env.HARNESS_CLAUDE_BIN;
    else process.env.HARNESS_CLAUDE_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("[M3c-3b] preflight exact 5 → 성공(shadcn connected + 정확한 5개 도구)", async () => {
  const r = await runShadcnPreflight([...ALLOWED_HOST]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.snapshot.servers, [{ name: "shadcn", status: "connected" }]);
  assert.deepEqual([...r.snapshot.tools].sort(), [...ALLOWED_HOST].sort());
});

test("[M3c-3b] preflight: 도구 누락(4개) → tool_mismatch 거부", async () => {
  await assert.rejects(
    runShadcnPreflight(ALLOWED_HOST.slice(0, 4)),
    (e: unknown) => e instanceof PreflightError && e.code === "tool_mismatch",
  );
});

test("[M3c-3b] preflight: 초과 도구(canary 6번째) → tool_mismatch 거부", async () => {
  await assert.rejects(
    runShadcnPreflight([...ALLOWED_HOST, "mcp__shadcn__extra_canary"]),
    (e: unknown) => e instanceof PreflightError && e.code === "tool_mismatch",
  );
});

test("[M3c-3b] preflight: 금지 도구 노출(add_command) → tool_mismatch 거부", async () => {
  await assert.rejects(
    runShadcnPreflight([...ALLOWED_HOST, nsName("get_add_command_for_items")]),
    (e: unknown) => e instanceof PreflightError && e.code === "tool_mismatch",
  );
});

test("[M3c-3b] preflight: 생성된 mcp-config = node + 고정 절대 proxy 경로(launcher 필드 없음)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-cfg-"));
  const stub = join(dir, "claude-stub.sh");
  const stdoutFile = join(dir, "out.ndjson");
  writeFileSync(stdoutFile, initLine([...ALLOWED_HOST]) + "\n", "utf8");
  writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat "${stdoutFile}"\nexit 0\n`, "utf8");
  chmodSync(stub, 0o755);
  const runtimeDir = join(dir, "runtime");
  const profile = loadToolProfiles().get(PILOT_SHADCN_PROFILE_ID)!;
  const fixedProxy = fromPackage("dist", "tools", "shadcnReadMcpProxy.js");
  const prevBin = process.env.HARNESS_CLAUDE_BIN;
  process.env.HARNESS_CLAUDE_BIN = stub;
  try {
    await runPreflight({ profile, serviceCwd: dir, runtimeDir, now: () => FIXED, timeoutMs: 8000 });
    const cfg = JSON.parse(readFileSync(join(runtimeDir, "mcp-config.json"), "utf8"));
    assert.deepEqual(cfg.mcpServers.shadcn, { command: process.execPath, args: [fixedProxy], alwaysLoad: true });
    assert.equal(cfg.mcpServers.shadcn.args[0], fixedProxy, "args[0]는 항상 PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js");
    assert.ok(!JSON.stringify(cfg).includes("launcher"), "config에 launcher 필드 없음");
    assert.ok(!JSON.stringify(cfg).includes("npx"), "npx 직접 실행 아님");
    assert.equal(mode(join(runtimeDir, "mcp-config.json")), 0o600, "mcp-config 0600");
    assert.equal(existsSync(join(runtimeDir, "tools-snapshot.json")), true);
    assert.equal(mode(join(runtimeDir, "tools-snapshot.json")), 0o600, "snapshot 0600");
  } finally {
    if (prevBin === undefined) delete process.env.HARNESS_CLAUDE_BIN;
    else process.env.HARNESS_CLAUDE_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3c-3b] workflow용 --tool-profile로 handoff-shadcn-readonly 지정 시 기존 MCP fail-closed 거부 유지", async () => {
  const name = "_hs_wf_reject";
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- x\n", "utf8");
  try {
    // runWorkflow의 MCP fail-closed 가드는 변경되지 않았다 — MCP binding profile은 run_start 이전에 거부.
    await assert.rejects(
      runWorkflow({ workflowId: "idea-validation", project: name, provider: mockProvider, now: () => FIXED, toolProfileId: PILOT_SHADCN_PROFILE_ID }),
      /MCP binding/,
    );
    // 거부되었으므로 run_state가 생성되지 않는다(run 시작 안 함).
    assert.equal(loadRunState(name), null);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("[M3c-3b][P0-2] handoff-shadcn-readonly에 secretRefs 선언(변조) → profile_rejected, sentinel 평문 0·runtime 생성 0", async () => {
  const name = "_hs_secretref";
  await completedProject(name);
  const SENTINEL_ENV = "M3C3B_SENTINEL_TOKEN";
  const SENTINEL = "sk-live-M3C3B-SENTINEL";
  const reg = {
    profiles: [
      {
        id: PILOT_SHADCN_PROFILE_ID,
        capabilities: ["component_registry_read"],
        bindings: { component_registry_read: { kind: "mcp", server: "shadcn", tools: getAllowedTools() } },
        servers: [{ name: "shadcn", launcher: "shadcn_read_proxy" }],
        preapprovedTools: ALLOWED_HOST,
        deniedTools: DENIED_HOST,
        permissionMode: "approval_write",
        allowedDomains: [],
        limits: { maxCallsPerStep: 6, maxResultChars: 8000, maxElapsedMsPerCall: 60000 },
        secretRefs: [SENTINEL_ENV], // 변조: launcher profile은 secretRefs 금지
        source: "official",
      },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "hs-secref-"));
  const regPath = join(dir, "tool_profiles.json");
  writeFileSync(regPath, JSON.stringify(reg), "utf8");
  const prev = process.env[SENTINEL_ENV];
  process.env[SENTINEL_ENV] = SENTINEL;
  const sp = captureSpawn();
  let preflightCalled = false;
  const logs: string[] = [];
  try {
    const res = await runHandoff(
      baseOpts(name, {
        toolProfileId: PILOT_SHADCN_PROFILE_ID,
        toolProfilesPath: regPath,
        spawnInteractive: sp.fn,
        logger: (l) => logs.push(l),
        runPreflightFn: async (o) => { preflightCalled = true; return okShadcnPreflight()(o); },
      }),
    );
    // 계약 검증(secretRefs≠[])이 먼저 잡거나(profile_rejected) 방어 심층화(config_launcher_secret_refs_forbidden).
    assert.ok(res.action === "profile_rejected" || res.action === "preflight_failed", `action=${res.action}`);
    assert.equal(preflightCalled, false, "spawn/preflight 이전 거부");
    assert.equal(sp.calls.length, 0);
    assert.equal(loadRunState(name)!.handoff, undefined);
    assert.ok(!existsSync(join(projectPaths(name).outputs, "runtime")), "runtime 생성 없음");
    // 로그·오류 메시지에 sentinel 평문 부재.
    const blob = logs.join("\n") + JSON.stringify(res);
    assert.ok(!blob.includes(SENTINEL), "로그·오류에 sentinel 평문 없음");
  } finally {
    if (prev === undefined) delete process.env[SENTINEL_ENV];
    else process.env[SENTINEL_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3c-3b] profile handoff spawn env: blocking MCP 세 값 정확 + ambient override 불가", async () => {
  const name = "_hs_mcpenv";
  await completedProject(name);
  // ambient가 잘못된 값을 갖고 있어도 안전값이 마지막에 이겨야 한다.
  const prev = { a: process.env.MCP_CONNECT_TIMEOUT_MS, b: process.env.MCP_TIMEOUT, c: process.env.MCP_CONNECTION_NONBLOCKING };
  process.env.MCP_CONNECT_TIMEOUT_MS = "1";
  process.env.MCP_TIMEOUT = "1";
  process.env.MCP_CONNECTION_NONBLOCKING = "1";
  const sp = captureSpawn();
  try {
    const res = await runHandoff(baseOpts(name, { toolProfileId: PILOT_SHADCN_PROFILE_ID, spawnInteractive: sp.fn }));
    assert.equal(res.action, "spawned");
    if (res.action !== "spawned") return;
    const { env } = sp.calls[0];
    assert.equal(env.MCP_CONNECTION_NONBLOCKING, "0", "NONBLOCKING=0 강제");
    assert.equal(env.MCP_CONNECT_TIMEOUT_MS, "45000", "CONNECT_TIMEOUT=45000 강제(ambient 1 무시)");
    assert.equal(env.MCP_TIMEOUT, "45000", "MCP_TIMEOUT=45000 강제(ambient 1 무시)");
  } finally {
    for (const [k, v] of [["MCP_CONNECT_TIMEOUT_MS", prev.a], ["MCP_TIMEOUT", prev.b], ["MCP_CONNECTION_NONBLOCKING", prev.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});
