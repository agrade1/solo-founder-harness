/**
 * [M3a] Headless preflight offline acceptance. fake claude executable + NDJSON fixture만 사용.
 * 실제 claude를 실행하지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight, PreflightError } from "./preflight.js";
import type { ToolProfile } from "./profiles.js";

function validProfile(over: Partial<ToolProfile> = {}): ToolProfile {
  return {
    id: "pf",
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "srva", tools: ["opa", "opb"] } },
    servers: [{ name: "srva", command: "node", args: ["srva-stub@1.0.0"] }],
    preapprovedTools: ["mcp__srva__opa", "mcp__srva__opb"],
    deniedTools: [],
    permissionMode: "read_only",
    allowedDomains: null,
    limits: { maxCallsPerStep: 6, maxResultChars: 8000, maxElapsedMsPerCall: 60000 },
    secretRefs: [],
    ...over,
  };
}

function initLine(mcpServers: { name: string; status: string }[], tools: string[]): string {
  return JSON.stringify({ type: "system", subtype: "init", session_id: "s", cwd: "/svc", permissionMode: "plan", tools, mcp_servers: mcpServers });
}

const GOOD_INIT = initLine(
  [{ name: "srva", status: "connected" }],
  ["Read", "Glob", "mcp__srva__opa", "mcp__srva__opb"],
);

interface CaseEnv {
  stdout?: string; // NDJSON을 stdout으로 방출
  stderr?: string;
  exit?: number;
  hang?: boolean; // init 방출 후(또는 미방출로) 지연 → preflight kill/timeout 경로
  argvOut?: boolean;
  envOut?: boolean; // 스텁이 자기 환경을 덤프 (env 격리 검증)
}

/** 스텁 claude를 만들고 preflight를 실행한다. dir/자원 정리는 호출측 finally. */
async function runCase(
  env: CaseEnv,
  opts: { profile?: ToolProfile; serviceCwd?: string; timeoutMs?: number; extraEnv?: Record<string, string> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "harness-pf-"));
  const stub = join(dir, "claude-stub.sh");
  writeFileSync(
    stub,
    `#!/bin/sh
[ -n "$ARGV_OUT" ] && printf '%s\\n' "$@" > "$ARGV_OUT"
[ -n "$ENV_OUT" ] && env > "$ENV_OUT"
cat >/dev/null
[ -n "$PF_STDOUT" ] && cat "$PF_STDOUT"
[ -n "$PF_STDERR" ] && printf '%s\\n' "$PF_STDERR" >&2
[ -n "$PF_HANG" ] && sleep 30
exit \${PF_EXIT:-0}
`,
    "utf8",
  );
  chmodSync(stub, 0o755);

  const stdoutFile = join(dir, "out.ndjson");
  // NDJSON은 개행으로 끝나야 스트림 파서가 즉시 완결 처리한다 (hang 케이스에서 flush 대기 방지).
  if (env.stdout !== undefined) writeFileSync(stdoutFile, env.stdout.endsWith("\n") ? env.stdout : env.stdout + "\n", "utf8");
  const argvOut = join(dir, "argv.txt");
  const envOut = join(dir, "childenv.txt");
  const runtimeDir = join(dir, "runtime");

  // 스텁 통신용 변수(PF_*/ARGV_OUT/ENV_OUT)는 production allowlist와 분리된 명시적 test seam으로만 전달.
  const testEnv: Record<string, string> = {};
  if (env.stdout !== undefined) testEnv.PF_STDOUT = stdoutFile;
  if (env.stderr !== undefined) testEnv.PF_STDERR = env.stderr;
  if (env.exit !== undefined) testEnv.PF_EXIT = String(env.exit);
  if (env.hang) testEnv.PF_HANG = "1";
  if (env.argvOut) testEnv.ARGV_OUT = argvOut;
  if (env.envOut) testEnv.ENV_OUT = envOut;

  // process.env에는 실행 파일 위치와 (선언 secret/누출 검증용) 변수만 둔다.
  const setEnv: Record<string, string | undefined> = { HARNESS_CLAUDE_BIN: stub, ...(opts.extraEnv ?? {}) };
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(setEnv)) {
    prev[k] = process.env[k];
    if (setEnv[k] === undefined) delete process.env[k];
    else process.env[k] = setEnv[k]!;
  }

  const cleanup = () => {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    argvOut,
    envOut,
    runtimeDir,
    cleanup,
    run: () =>
      runPreflight({
        profile: opts.profile ?? validProfile(),
        serviceCwd: opts.serviceCwd ?? dir,
        runtimeDir,
        now: () => "2026-01-01T00:00:00.000Z",
        timeoutMs: opts.timeoutMs ?? 1500,
        testEnv,
      }),
  };
}

test("[M3a] exact snapshot 성공 + argv에 strict/config/tools-empty/plan 포함", async () => {
  const c = await runCase({ stdout: GOOD_INIT, hang: true, argvOut: true });
  try {
    const res = await c.run();
    assert.equal(res.ok, true);
    assert.deepEqual(res.snapshot.servers, [{ name: "srva", status: "connected" }]);
    assert.deepEqual(res.snapshot.tools, ["mcp__srva__opa", "mcp__srva__opb"]);
    assert.equal(res.snapshot.profileId, "pf");
    assert.ok(res.snapshot.configHash.length === 64);
    // snapshot은 raw init을 담지 않는다
    assert.deepEqual(Object.keys(res.snapshot).sort(), ["configHash", "cwd", "profileId", "servers", "timestamp", "tools"]);

    const argv = readFileSync(c.argvOut, "utf8").split("\n");
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.ok(argv.includes("--output-format") && argv.includes("stream-json"));
    assert.ok(argv.includes("--no-session-persistence"));
    const ti = argv.indexOf("--tools");
    assert.equal(argv[ti + 1], "", "--tools 다음은 빈 문자열");
    const pi = argv.indexOf("--permission-mode");
    assert.equal(argv[pi + 1], "plan");
    const mi = argv.indexOf("--mcp-config");
    assert.match(argv[mi + 1], /mcp-config\.json$/);
  } finally {
    c.cleanup();
  }
});

test("[M3a] extra canary server 실패", async () => {
  const init = initLine(
    [{ name: "srva", status: "connected" }, { name: "canary", status: "connected" }],
    ["mcp__srva__opa", "mcp__srva__opb"],
  );
  const c = await runCase({ stdout: init, hang: true });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "server_mismatch");
  } finally {
    c.cleanup();
  }
});

test("[M3a] extra canary tool 실패", async () => {
  const init = initLine(
    [{ name: "srva", status: "connected" }],
    ["mcp__srva__opa", "mcp__srva__opb", "mcp__srva__evil"],
  );
  const c = await runCase({ stdout: init, hang: true });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "tool_mismatch");
  } finally {
    c.cleanup();
  }
});

test("[M3a] missing tool 실패", async () => {
  const init = initLine([{ name: "srva", status: "connected" }], ["mcp__srva__opa"]);
  const c = await runCase({ stdout: init, hang: true });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "tool_mismatch");
  } finally {
    c.cleanup();
  }
});

test("[M3a] duplicate tool 실패", async () => {
  const init = initLine(
    [{ name: "srva", status: "connected" }],
    ["mcp__srva__opa", "mcp__srva__opa", "mcp__srva__opb"],
  );
  const c = await runCase({ stdout: init, hang: true });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "duplicate_tool");
  } finally {
    c.cleanup();
  }
});

for (const status of ["pending", "failed", "needs-auth"]) {
  test(`[M3a] ${status} server 실패`, async () => {
    const init = initLine([{ name: "srva", status }], ["mcp__srva__opa", "mcp__srva__opb"]);
    const c = await runCase({ stdout: init, hang: true });
    try {
      await assert.rejects(c.run(), (e: PreflightError) => e.code === "server_not_connected");
    } finally {
      c.cleanup();
    }
  });
}

test("[M3a] no init 이벤트로 종료하면 실패", async () => {
  const nonInit = JSON.stringify({ type: "result", subtype: "success", result: "ok", is_error: false });
  const c = await runCase({ stdout: nonInit, exit: 0 });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "no_init");
  } finally {
    c.cleanup();
  }
});

test("[M3a] malformed stdout(비 JSON)도 실패", async () => {
  const c = await runCase({ stdout: "garbage{{{not json\n", exit: 0 });
  try {
    await assert.rejects(c.run(), PreflightError);
  } finally {
    c.cleanup();
  }
});

test("[M3a] non-zero 종료 실패 + stderr secret redaction", async () => {
  const c = await runCase(
    { stderr: "boom sk-live-SENTINEL", exit: 1 },
    { profile: validProfile({ secretRefs: ["MY_SECRET"] }), extraEnv: { MY_SECRET: "sk-live-SENTINEL" } },
  );
  try {
    await assert.rejects(c.run(), (e: PreflightError) => {
      assert.equal(e.code, "nonzero_exit");
      assert.ok(!e.message.includes("sk-live-SENTINEL"), "오류에 secret 없음");
      return true;
    });
  } finally {
    c.cleanup();
  }
});

test("[M3a] hard timeout 실패 (init 미수신)", async () => {
  const c = await runCase({ hang: true }, { timeoutMs: 700 });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "timeout");
  } finally {
    c.cleanup();
  }
});

test("[M3a] @latest server는 preflight config 단계에서 fail-closed", async () => {
  const p = validProfile({ servers: [{ name: "srva", command: "npx", args: ["some-mcp@latest"] }] });
  const c = await runCase({ stdout: GOOD_INIT, hang: true }, { profile: p });
  try {
    await assert.rejects(c.run(), (e: PreflightError) => e.code === "config_latest_forbidden");
  } finally {
    c.cleanup();
  }
});

test("[M3a] snapshot redaction: 반환 객체와 저장 파일이 동일·redacted (cwd secret 부재)", async () => {
  const secret = "sk-live-SENTINEL";
  // cwd 경로에 secret을 심어 snapshot redaction을 검증. spawn cwd는 실제 존재해야 하므로 생성.
  const base = mkdtempSync(join(tmpdir(), "harness-pf-cwd-"));
  const serviceCwd = join(base, secret, "svc");
  mkdirSync(serviceCwd, { recursive: true });
  const c = await runCase(
    { stdout: GOOD_INIT, hang: true },
    { profile: validProfile({ secretRefs: ["MY_SECRET"] }), serviceCwd, extraEnv: { MY_SECRET: secret } },
  );
  try {
    const res = await c.run();
    const snapText = readFileSync(res.snapshotPath, "utf8");
    assert.ok(!snapText.includes(secret), "저장 snapshot에 secret 없음");
    assert.ok(!JSON.stringify(res.snapshot).includes(secret), "반환 snapshot에도 secret 없음");
    assert.match(res.snapshot.cwd, /\*\*\*/, "cwd redacted");
    // 반환 == 저장 (동일 redacted 객체)
    assert.deepEqual(res.snapshot, JSON.parse(snapText));
  } finally {
    c.cleanup();
    rmSync(base, { recursive: true, force: true });
  }
});

test("[M3a] 실패 시 tools-snapshot.json이 생성되지 않는다", async () => {
  const init = initLine([{ name: "srva", status: "connected" }, { name: "canary", status: "connected" }], ["mcp__srva__opa", "mcp__srva__opb"]);
  const c = await runCase({ stdout: init, hang: true });
  try {
    await assert.rejects(c.run(), PreflightError);
    assert.ok(!existsSync(join(c.runtimeDir, "tools-snapshot.json")), "실패 시 snapshot 미생성");
  } finally {
    c.cleanup();
  }
});

test("[M3a] env 격리: 미선언 secret 형태 변수는 child에 전달되지 않음, 강제 변수·선언 secret만", async () => {
  const c = await runCase(
    { stdout: GOOD_INIT, hang: true, envOut: true },
    {
      profile: validProfile({ secretRefs: ["MY_SECRET"] }),
      extraEnv: { MY_SECRET: "declared-secret", LEAK_TOKEN: "sk-leak-1", SECRET_PASSWORD: "leak-2", AWS_ACCESS_KEY_ID: "leak-3" },
    },
  );
  try {
    await c.run();
    const childEnv = readFileSync(c.envOut, "utf8");
    // 미선언 secret 형태 변수 부재
    assert.ok(!/^LEAK_TOKEN=/m.test(childEnv), "LEAK_TOKEN 미전달");
    assert.ok(!childEnv.includes("sk-leak-1"));
    assert.ok(!/^SECRET_PASSWORD=/m.test(childEnv), "SECRET_PASSWORD 미전달");
    assert.ok(!/^AWS_ACCESS_KEY_ID=/m.test(childEnv), "AWS_ACCESS_KEY_ID 미전달");
    // 강제 변수 + 선언 secret은 전달
    assert.match(childEnv, /^MCP_CONNECTION_NONBLOCKING=0$/m);
    assert.match(childEnv, /^ENABLE_TOOL_SEARCH=false$/m);
    assert.match(childEnv, /^MY_SECRET=declared-secret$/m, "선언된 secret은 전달");
  } finally {
    c.cleanup();
  }
});
