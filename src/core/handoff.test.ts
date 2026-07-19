/**
 * [M3b.2 offline] handoff 코어 테스트. 실제 Claude/TUI/live Hook은 실행하지 않는다
 * (preflight·spawn은 seam으로 주입, "실제 spawn" 검증만 무해한 sh 스텁 사용).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandoff, type HandoffOptions } from "./handoff.js";
import { runWorkflow, loadRunState } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import { PACKAGE_ROOT } from "./paths.js";
import { mockProvider } from "../providers/mockProvider.js";
import { collect } from "../tools/hookCollector.js";
import { PreflightError, type PreflightSuccess, type RunPreflightOpts } from "../tools/preflight.js";

const FIXED = "2026-01-01T00:00:00.000Z";
const SENTINEL = "sk-live-SENTINEL-9f3a";
const SENTINEL_ENV = "HANDOFF_TEST_TOKEN"; // 이름에 TOKEN 포함 → deriveSecretRefs 대상

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

/** 성공 preflight 스텁 (실제 claude 미실행). */
function okPreflight(): (o: RunPreflightOpts) => Promise<PreflightSuccess> {
  return async (o) => ({
    ok: true,
    snapshotPath: join(o.runtimeDir, "tools-snapshot.json"),
    snapshot: { profileId: o.profile.id, cwd: o.serviceCwd, timestamp: FIXED, configHash: "x".repeat(64), servers: [], tools: [] },
  });
}

function captureSpawn() {
  const calls: { bin: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const fn = (bin: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    calls.push({ bin, argv, cwd: opts.cwd, env: opts.env });
  };
  return { calls, fn };
}

/** spawn까지 도달하는 기본 옵션(모두 seam 주입). */
function baseOpts(name: string, over: Partial<HandoffOptions> = {}): HandoffOptions {
  return {
    project: name,
    cwd: "/svc/repo",
    now: () => FIXED,
    handoffId: "hx",
    isTTY: true,
    yes: true,
    claudeBin: "claude",
    resolveBin: () => true,
    runPreflightFn: okPreflight(),
    logger: () => {},
    ...over,
  };
}

test("[M3b.2] standalone handoff 성공 → spawned + argv 계약 + collector dist 경로 + AGENTS/CLAUDE 지시 + 최소 권한", async () => {
  const name = "_h_ok";
  await completedProject(name);
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { spawnInteractive: sp.fn }));

  assert.equal(res.action, "spawned");
  if (res.action !== "spawned") return;
  assert.equal(sp.calls.length, 1);
  const { argv, env, cwd } = sp.calls[0];

  // 대화형 TUI: -p / stream-json / output-format 없음
  assert.ok(!argv.includes("-p"));
  assert.ok(!argv.includes("stream-json"));
  assert.ok(!argv.includes("--output-format"));

  // 격리 인자 정확
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.equal(argv[argv.indexOf("--mcp-config") + 1], res.mcpConfigPath);
  assert.equal(argv[argv.indexOf("--settings") + 1], res.settingsPath);
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default");
  assert.equal(argv[argv.indexOf("--tools") + 1], "default");
  assert.equal(argv[argv.indexOf("--disallowedTools") + 1], "mcp__*");
  // initialPrompt(마지막): plan-first + AGENTS.md/CLAUDE.md 준수 지시
  const prompt = argv[argv.length - 1];
  assert.match(prompt, /먼저 구현 계획만 제시/);
  assert.match(prompt, /AGENTS\.md와 CLAUDE\.md/);

  // collector는 배포 산출물 절대경로 dist/tools/hookCollector.js (실존)
  const settings = JSON.parse(readFileSync(res.settingsPath, "utf8"));
  const collectorArg = settings.hooks.PreToolUse[0].hooks[0].args[0];
  assert.ok(collectorArg.endsWith("/dist/tools/hookCollector.js"), "collector dist 절대경로");
  assert.equal(collectorArg, join(PACKAGE_ROOT, "dist", "tools", "hookCollector.js"));
  assert.ok(existsSync(collectorArg), "collector 파일 실존");

  // env 계약
  assert.equal(cwd, "/svc/repo");
  assert.equal(env.HARNESS_TOOL_PROFILE_ID, "handoff-default");
  assert.equal(env.HARNESS_TOOL_MAP, "{}");
  assert.ok(Array.isArray(JSON.parse(env.HARNESS_TOOL_SECRET_REFS!)), "secretRefs는 이름 배열");
  assert.ok(env.HARNESS_TOOL_TRACE_PATH!.endsWith("hx.jsonl"));
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

  // 최소 권한: 파일 0600, 디렉터리 0700
  assert.equal(mode(res.settingsPath), 0o600, "hook-settings 0600");
  assert.equal(mode(res.tracePath), 0o600, "trace 0600 (pre-created)");
  assert.equal(mode(res.runtimeDir), 0o700, "runtime dir 0700");
  assert.equal(mode(join(projectPaths(name).outputs, "tool-trace")), 0o700, "tool-trace dir 0700");

  // run_state.handoff는 spawn된 경우에만. status/completed 불변.
  const st = loadRunState(name)!;
  assert.equal(st.status, "completed");
  assert.deepEqual(st.handoff, { launched_at: FIXED, cwd: "/svc/repo", prompt_bytes: res.promptBytes, trace_path: res.tracePath, runtime_dir: res.runtimeDir });

  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] hook-settings exec form(command=node, args=[collector,kind]) + secret 평문 없음(settings·generated env)", async () => {
  const name = "_h_settings";
  await completedProject(name);
  const prev = process.env[SENTINEL_ENV];
  process.env[SENTINEL_ENV] = SENTINEL;
  const sp = captureSpawn();
  try {
    const res = await runHandoff(baseOpts(name, { spawnInteractive: sp.fn }));
    assert.equal(res.action, "spawned");
    if (res.action !== "spawned") return;
    const settings = JSON.parse(readFileSync(res.settingsPath, "utf8"));
    for (const kind of Object.keys(settings.hooks)) {
      const hc = settings.hooks[kind][0].hooks[0];
      assert.equal(hc.type, "command");
      assert.equal(hc.command, process.execPath);
      assert.ok(hc.args[0].endsWith("tools/hookCollector.js"));
      assert.equal(hc.args[1], kind);
    }
    // 하네스 생성 산출물(settings + HARNESS_TOOL_* 계약)에 sentinel 값 평문 부재.
    const env = sp.calls[0].env;
    const contract = [env.HARNESS_TOOL_TRACE_PATH, env.HARNESS_TOOL_PROFILE_ID, env.HARNESS_TOOL_SECRET_REFS, env.HARNESS_TOOL_MAP].join("|");
    assert.ok(!readFileSync(res.settingsPath, "utf8").includes(SENTINEL), "settings에 secret 값 없음");
    assert.ok(!contract.includes(SENTINEL), "HARNESS_TOOL_* 계약에 secret 값 없음");
    // secret 이름(값 아님)은 refs에 파생돼 collector가 값을 마스킹하게 한다.
    assert.ok(JSON.parse(env.HARNESS_TOOL_SECRET_REFS!).includes(SENTINEL_ENV), "secret 이름은 refs에 포함");
  } finally {
    if (prev === undefined) delete process.env[SENTINEL_ENV];
    else process.env[SENTINEL_ENV] = prev;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] --print: preflight/spawn/state 변경 없음, 재진입 명령만", async () => {
  const name = "_h_print";
  await completedProject(name);
  const sp = captureSpawn();
  let preflightCalled = false;
  const logs: string[] = [];
  const res = await runHandoff(
    baseOpts(name, {
      print: true,
      spawnInteractive: sp.fn,
      runPreflightFn: async (o) => {
        preflightCalled = true;
        return okPreflight()(o);
      },
      logger: (l) => logs.push(l),
    }),
  );
  assert.equal(res.action, "printed");
  if (res.action !== "printed") return;
  assert.equal(sp.calls.length, 0, "spawn 없음");
  assert.equal(preflightCalled, false, "preflight 없음");
  assert.equal(res.reentryCommand, "harness handoff --project '_h_print' --cwd '/svc/repo' --yes");
  assert.ok(logs.includes(res.reentryCommand));
  assert.equal(loadRunState(name)!.handoff, undefined);
  assert.ok(!existsSync(join(projectPaths(name).outputs, "runtime")), "runtime 디렉터리 미생성");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] 승인 거부 → rejected, spawn 없음, handoff 미기록", async () => {
  const name = "_h_reject";
  await completedProject(name);
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { yes: false, approve: async () => false, spawnInteractive: sp.fn }));
  assert.equal(res.action, "rejected");
  assert.equal(sp.calls.length, 0);
  assert.equal(loadRunState(name)!.handoff, undefined);
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] 승인 preview 전체 scrub — cwd에 secret sentinel 있어도 preview 평문 없음, 거부 시 기록 없음", async () => {
  const name = "_h_preview_scrub";
  await completedProject(name);
  const prev = process.env[SENTINEL_ENV];
  process.env[SENTINEL_ENV] = SENTINEL;
  const sp = captureSpawn();
  let preflightCalled = false;
  let capturedPreview = "";
  try {
    // serviceCwd 동적 문자열에 secret sentinel을 심어 preview(cwd/trace 포함) 전체 scrub을 검증한다.
    const res = await runHandoff(
      baseOpts(name, {
        cwd: `/svc/${SENTINEL}/repo`,
        yes: false,
        approve: async (_m, preview) => {
          capturedPreview = preview;
          return false; // 거부
        },
        spawnInteractive: sp.fn,
        runPreflightFn: async (o) => {
          preflightCalled = true;
          return okPreflight()(o);
        },
      }),
    );
    assert.equal(res.action, "rejected");
    assert.ok(capturedPreview.length > 0, "approve callback에 preview 전달됨");
    assert.ok(capturedPreview.includes("/svc/"), "preview에 cwd 라인 포함");
    assert.ok(!capturedPreview.includes(SENTINEL), "preview 전체에 secret 평문 없음 (cwd 등 동적 문자열 포함)");
    // 거부는 preflight/spawn/handoff/runtime 어느 것도 남기지 않는다.
    assert.equal(preflightCalled, false, "거부 시 preflight 없음");
    assert.equal(sp.calls.length, 0, "거부 시 spawn 없음");
    assert.equal(loadRunState(name)!.handoff, undefined, "거부 시 handoff 미기록");
    assert.ok(!existsSync(join(projectPaths(name).outputs, "runtime")), "거부 시 runtime 디렉터리 미생성");
  } finally {
    if (prev === undefined) delete process.env[SENTINEL_ENV];
    else process.env[SENTINEL_ENV] = prev;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] 비-TTY → non_tty, spawn 없음 (--yes와 조합돼도)", async () => {
  const name = "_h_nontty";
  await completedProject(name);
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { isTTY: false, yes: true, spawnInteractive: sp.fn }));
  assert.equal(res.action, "non_tty");
  assert.equal(sp.calls.length, 0);
  assert.equal(loadRunState(name)!.handoff, undefined);
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] claude 바이너리 부재 → missing_binary fallback, spawn 없음", async () => {
  const name = "_h_nobin";
  await completedProject(name);
  const sp = captureSpawn();
  const logs: string[] = [];
  const res = await runHandoff(baseOpts(name, { resolveBin: () => false, spawnInteractive: sp.fn, logger: (l) => logs.push(l) }));
  assert.equal(res.action, "missing_binary");
  if (res.action !== "missing_binary") return;
  assert.equal(sp.calls.length, 0);
  assert.ok(logs.some((l) => l.includes(res.reentryCommand)));
  assert.equal(loadRunState(name)!.handoff, undefined);
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] preflight 실패 → preflight_failed, spawn 없음, 오류 secret scrub", async () => {
  const name = "_h_pf";
  await completedProject(name);
  const prev = process.env[SENTINEL_ENV];
  process.env[SENTINEL_ENV] = SENTINEL;
  const sp = captureSpawn();
  try {
    const res = await runHandoff(
      baseOpts(name, {
        spawnInteractive: sp.fn,
        runPreflightFn: async () => {
          throw new PreflightError("server_mismatch", `ambient canary 감지 leak=${SENTINEL}`);
        },
      }),
    );
    assert.equal(res.action, "preflight_failed");
    if (res.action !== "preflight_failed") return;
    assert.equal(res.code, "server_mismatch");
    assert.ok(!res.message.includes(SENTINEL), "preflight 오류에 secret 평문 없음");
    assert.equal(sp.calls.length, 0, "preflight 성공 전 spawn 없음");
    assert.equal(loadRunState(name)!.handoff, undefined);
  } finally {
    if (prev === undefined) delete process.env[SENTINEL_ENV];
    else process.env[SENTINEL_ENV] = prev;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] spawn 실패 → spawn_failed, handoff 미기록, 오류 secret scrub", async () => {
  const name = "_h_spawnfail";
  await completedProject(name);
  const prev = process.env[SENTINEL_ENV];
  process.env[SENTINEL_ENV] = SENTINEL;
  try {
    const res = await runHandoff(
      baseOpts(name, {
        spawnInteractive: () => {
          throw new Error(`spawn boom token=${SENTINEL}`);
        },
      }),
    );
    assert.equal(res.action, "spawn_failed");
    if (res.action !== "spawn_failed") return;
    assert.ok(!res.message.includes(SENTINEL), "spawn 오류에 secret 평문 없음");
    assert.equal(loadRunState(name)!.handoff, undefined, "spawn 실패 → 미기록");
  } finally {
    if (prev === undefined) delete process.env[SENTINEL_ENV];
    else process.env[SENTINEL_ENV] = prev;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] trace 파일 exclusive-create(wx) 충돌 시 setup_failed + spawn 없음, 기존 파일 보존", async () => {
  const name = "_h_setup";
  await completedProject(name);
  // tracePath를 미리 만들어 두면 spawn 직전 trace 사전생성이 exclusive-create(wx) EEXIST로 fail-closed 되어야 한다.
  const traceDir = join(projectPaths(name).outputs, "tool-trace");
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(join(traceDir, "hx.jsonl"), "PREEXISTING\n", "utf8");
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { spawnInteractive: sp.fn }));
  assert.equal(res.action, "setup_failed");
  assert.equal(sp.calls.length, 0, "spawn 없음");
  assert.equal(loadRunState(name)!.handoff, undefined);
  // 기존 파일을 덮어쓰지 않았다.
  assert.equal(readFileSync(join(traceDir, "hx.jsonl"), "utf8"), "PREEXISTING\n");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] collector 경로 부재 → setup_failed, preflight/spawn/handoff 기록 없음", async () => {
  const name = "_h_collector_missing";
  await completedProject(name);
  const sp = captureSpawn();
  let preflightCalled = false;
  const missing = join(tmpdir(), `no-such-collector-${process.pid}.js`);
  const res = await runHandoff(
    baseOpts(name, {
      collectorPath: missing,
      spawnInteractive: sp.fn,
      runPreflightFn: async (o) => {
        preflightCalled = true;
        return okPreflight()(o);
      },
    }),
  );
  assert.equal(res.action, "setup_failed");
  assert.equal(preflightCalled, false, "collector 검증은 preflight 이전 — preflight 없음");
  assert.equal(sp.calls.length, 0, "spawn 없음");
  assert.equal(loadRunState(name)!.handoff, undefined, "handoff 미기록");
  assert.ok(!existsSync(join(projectPaths(name).outputs, "runtime")), "runtime 디렉터리 미생성");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] collector가 디렉터리(일반 파일 아님) → setup_failed, preflight/spawn/handoff 기록 없음", async () => {
  const name = "_h_collector_dir";
  await completedProject(name);
  const dir = join(tmpdir(), `collector-as-dir-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const sp = captureSpawn();
  let preflightCalled = false;
  try {
    const res = await runHandoff(
      baseOpts(name, {
        collectorPath: dir,
        spawnInteractive: sp.fn,
        runPreflightFn: async (o) => {
          preflightCalled = true;
          return okPreflight()(o);
        },
      }),
    );
    assert.equal(res.action, "setup_failed");
    assert.equal(preflightCalled, false, "collector 검증은 preflight 이전 — preflight 없음");
    assert.equal(sp.calls.length, 0, "spawn 없음");
    assert.equal(loadRunState(name)!.handoff, undefined, "handoff 미기록");
    assert.ok(!existsSync(join(projectPaths(name).outputs, "runtime")), "runtime 디렉터리 미생성");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] run이 completed 아니면 handoff 거부(not_completed), spawn 없음", async () => {
  const name = "_h_failed";
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.outputs, { recursive: true });
  mkdirSync(paths.docs, { recursive: true });
  const failedState = { workflow_id: "idea-validation", project: name, provider: "mock", status: "failed", resume_from: 1 };
  writeFileSync(join(paths.outputs, "run_state.json"), JSON.stringify(failedState, null, 2) + "\n", "utf8");
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { spawnInteractive: sp.fn }));
  assert.equal(res.action, "not_completed");
  assert.equal(sp.calls.length, 0);
  rmSync(paths.root, { recursive: true, force: true });
});

test("[M3b.2] prompt 128KB 경계 초과 → 절대경로 읽기 지시로 대체", async () => {
  const name = "_h_128k";
  await completedProject(name);
  const sp = captureSpawn();
  const res = await runHandoff(baseOpts(name, { maxPromptBytes: 10, spawnInteractive: sp.fn }));
  assert.equal(res.action, "spawned");
  if (res.action !== "spawned") return;
  const prompt = sp.calls[0].argv[sp.calls[0].argv.length - 1];
  assert.match(prompt, /절대경로 파일을 열어 전체를 읽어라/);
  assert.match(prompt, /claude_code_task_prompt\.md/);
  assert.match(prompt, /AGENTS\.md와 CLAUDE\.md/);
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[M3b.2] 실제 spawn 경로(sh 스텁) → stdio inherit, argv 전달, handoff 기록", async () => {
  const name = "_h_realspawn";
  await completedProject(name);
  const dir = join(tmpdir(), `h-spawn-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "claude-stub.sh");
  const argvOut = join(dir, "argv.txt");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvOut}"\nexit 0\n`, "utf8");
  chmodSync(stub, 0o755);
  try {
    // spawnInteractive 미주입 → 기본 defaultSpawnInteractive(spawnSync + stdio inherit). cwd는 실존 필요.
    const res = await runHandoff(baseOpts(name, { cwd: dir, claudeBin: stub, resolveBin: () => true }));
    assert.equal(res.action, "spawned");
    if (res.action !== "spawned") return;
    const writtenArgv = readFileSync(argvOut, "utf8").split("\n");
    assert.ok(writtenArgv.includes("--strict-mcp-config"));
    assert.ok(!writtenArgv.includes("-p"));
    assert.ok(loadRunState(name)!.handoff, "실제 spawn 후 handoff 기록");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] collector append 후에도 trace 0600 유지 + JSONL에 secret 평문 없음", async () => {
  const name = "_h_append";
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.outputs, { recursive: true });
  const tracePath = join(paths.outputs, "tool-trace", "append.jsonl");
  mkdirSync(join(paths.outputs, "tool-trace"), { recursive: true, mode: 0o700 });
  // handoff와 동일하게 spawn 전 빈 0600 파일로 사전 생성.
  writeFileSync(tracePath, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  const prev = process.env[SENTINEL_ENV];
  process.env[SENTINEL_ENV] = SENTINEL;
  try {
    const r = collect({
      hookKind: "PreToolUse",
      deny: false,
      payloadRaw: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Read", tool_use_id: "c1", tool_input: { note: `leak ${SENTINEL} end` } }),
      config: { tracePath, profileId: "handoff-default", secretRefs: [SENTINEL_ENV], toolMap: {} },
      now: FIXED,
    });
    assert.equal(r.exitCode, 0);
    const body = readFileSync(tracePath, "utf8");
    assert.ok(!body.includes(SENTINEL), "collector append JSONL에 secret 평문 없음");
    assert.equal(mode(tracePath), 0o600, "collector append 후에도 0600 유지");
  } finally {
    if (prev === undefined) delete process.env[SENTINEL_ENV];
    else process.env[SENTINEL_ENV] = prev;
    rmSync(paths.root, { recursive: true, force: true });
  }
});
