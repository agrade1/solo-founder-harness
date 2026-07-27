/**
 * V3 M5a — CodexCliProvider 테스트.
 * 실제 codex 추론·네트워크·인증은 없다. 두 가지 방식만 쓴다:
 *  ⓐ in-process spawn seam 주입(argv·env·stdin·spawn 횟수 단정)
 *  ⓑ 결정론적 fake CLI(`__fixtures__/fake-codex.mjs`) 실제 spawn — stdio 배선까지 확인
 * 실행: `npx tsx --test src/exec/codexCliProvider.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { runProcess } from "./runProcess.js";
import { CodexCliProvider, compileCodexArgs, compileCodexEnv, resolveCodexOptions, type SpawnFn } from "./codexCliProvider.js";
import { OrchestrationError } from "./orchestrationTypes.js";
import type { SessionEvent, SessionSpec } from "./types.js";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-codex.mjs", import.meta.url));

/**
 * 결정론적 fake CLI를 **실제로 spawn**하는 seam. 실행 비트에 의존하지 않도록 현재 node로 띄우며,
 * provider가 만든 argv·cwd·env·stdin은 그대로 전달된다(자식이 `process.argv.slice(2)`로 기록).
 */
const realFakeSpawn: SpawnFn = (_command, args, options) =>
  nodeSpawn(process.execPath, [FAKE_CLI, ...args], options) as ChildProcess;

// ── 준비물 ────────────────────────────────────────────────────────────────

async function initRepo(): Promise<{ root: string; head: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-codex-")));
  await runProcess("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# t\n");
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return { root: dir, head: (await runProcess("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim() };
}

function manifest(approvedCommit: string) {
  return {
    milestoneId: "m5a",
    approvedCommit,
    writableRoots: ["src"],
    ownershipByTask: { "task-1": ["src"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    maxSessions: 2,
    maxTokens: 1000,
    maxElapsedMs: 60_000,
    localMergeAllowed: false,
    expiresAt: "2099-12-31T00:00:00.000Z",
  };
}

function codexHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "m5a-home-")));
}

function specFor(cwd: string, home: string, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: "s1",
    role: "reviewer",
    cwd,
    model: "gpt-5.6-sol",
    codex: { codexHome: home },
    ...over,
  };
}

interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
}

/** stdout/stderr/close를 테스트가 직접 몰아주는 가짜 child. */
function fakeSpawn(calls: FakeCall[], script: (child: FakeChild) => void): SpawnFn {
  return (command, args, options) => {
    const child = new FakeChild();
    const record: FakeCall = { command, args, cwd: options.cwd, env: options.env, stdin: "" };
    calls.push(record);
    child.stdin.on("data", (d: Buffer | string) => (record.stdin += String(d)));
    setImmediate(() => script(child));
    return child as unknown as ChildProcess;
  };
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed: string | null = null;
  kill(signal: string): boolean {
    this.killed = signal;
    return true;
  }
  finish(lines: string[], code: number | null, signal: string | null = null, stderr = ""): void {
    for (const l of lines) this.stdout.write(`${l}\n`);
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.emit("close", code, signal));
  }
}

async function drain(it: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function codeOf(err: unknown): string {
  assert.ok(err instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(err)}`);
  return (err as OrchestrationError).code;
}

const OK_STREAM = [
  '{"type":"thread.started","thread_id":"th_abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":6}}',
];

// ── argv / env / 설정 계약 (순수 함수) ────────────────────────────────────

test("[M5a] argv: 명시 배열 + stdin 프롬프트 + 리뷰 기본값(read-only·xhigh·ephemeral)", () => {
  const args = compileCodexArgs(specFor("/tmp/wt", "/tmp/home"));
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    "mcp_servers={}",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp/wt",
    "--ephemeral",
    "-",
  ]);
  assert.ok(!args.some((a) => /dangerous|bypass|full-auto|danger-full-access|--last/.test(a)), "bypass 계열 플래그 없음");
});

test("[M5a] argv: resume은 명시 session id만 쓰고 --last는 없다 · output-schema는 요청 시에만", () => {
  const spec = specFor("/tmp/wt", "/tmp/home", {
    codex: { codexHome: "/tmp/home", ephemeral: false, outputSchemaPath: "/tmp/schema.json", sandbox: "workspace-write", reasoningEffort: "high" },
  });
  const fresh = compileCodexArgs(spec);
  assert.deepEqual(fresh.slice(0, 2), ["exec", "--json"]);
  assert.ok(!fresh.includes("--ephemeral"), "ephemeral:false면 붙지 않는다");
  assert.deepEqual(fresh.slice(-3), ["--output-schema", "/tmp/schema.json", "-"]);
  assert.ok(fresh.includes("workspace-write") && fresh.includes('model_reasoning_effort="high"'));

  const resumed = compileCodexArgs(spec, "th_abc");
  assert.deepEqual(resumed.slice(0, 4), ["exec", "resume", "th_abc", "--json"]);
  assert.ok(!resumed.includes("--last"));
});

test("[M5a] env: PATH·CODEX_HOME만 넘긴다(사용자 HOME·자격증명 미상속)", () => {
  const env = compileCodexEnv("/tmp/home");
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "PATH"]);
  assert.equal(env.CODEX_HOME, "/tmp/home");
});

test("[M5a] 설정은 fail closed: codexHome 필수 · sandbox/effort/모델/경로 계약 밖 거부", () => {
  const bad = (spec: SessionSpec): string => {
    try {
      resolveCodexOptions(spec);
      return "(통과)";
    } catch (e) {
      return codeOf(e);
    }
  };
  assert.equal(bad({ sessionId: "s", role: "r", cwd: "/tmp/wt" }), "codex_config_isolation_required");
  assert.equal(bad(specFor("/tmp/wt", "relative-home")), "codex_config_invalid");
  assert.equal(bad(specFor("/tmp/wt", "/tmp/home", { model: "bad model!" })), "codex_config_invalid");
  assert.equal(bad(specFor("relative/wt", "/tmp/home")), "codex_config_invalid");
  assert.equal(
    bad(specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", sandbox: "danger-full-access" as never } })),
    "codex_sandbox_forbidden",
  );
  assert.equal(
    bad(specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", reasoningEffort: "ultra" as never } })),
    "codex_config_invalid",
  );
  assert.equal(
    bad(specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", outputSchemaPath: "schema.json" } })),
    "codex_config_invalid",
  );
});

// ── 실행 경계: 프로세스는 승인 커밋에서만 뜬다 ─────────────────────────────

test("[M5a] approvedCommit 불일치면 spawn 횟수 0", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    const provider = new CodexCliProvider({
      manifest: manifest("b".repeat(40)),
      controllerRepoRoot: repo.root,
      bin: "codex",
      spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
    });
    await assert.rejects(
      () => provider.start(specFor(repo.root, home), "리뷰해라"),
      (e: unknown) => codeOf(e) === "approved_commit_mismatch",
    );
    assert.equal(calls.length, 0, "경계 위반에서는 프로세스를 띄우지 않는다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] manifest 누락·만료·설정 위반·과대 프롬프트도 spawn 전에 거부한다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  const spawn = fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0));
  try {
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "invalid_manifest",
        () =>
          new CodexCliProvider({ manifest: { milestoneId: "m5a" }, controllerRepoRoot: repo.root, spawn }).start(
            specFor(repo.root, home),
            "p",
          ),
      ],
      [
        "manifest_expired",
        () =>
          new CodexCliProvider({
            manifest: manifest(repo.head),
            controllerRepoRoot: repo.root,
            spawn,
            nowMs: () => Date.parse("2099-12-31T00:00:00.000Z"),
          }).start(specFor(repo.root, home), "p"),
      ],
      [
        "codex_config_isolation_required",
        () =>
          new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn }).start(
            { sessionId: "s", role: "r", cwd: repo.root },
            "p",
          ),
      ],
      [
        "codex_prompt_too_long",
        () =>
          new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn }).start(
            specFor(repo.root, home),
            "x".repeat(300_000),
          ),
      ],
      [
        "boundary_path_unresolvable",
        () =>
          new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: join(repo.root, "nope"), spawn }).start(
            specFor(repo.root, home),
            "p",
          ),
      ],
    ];
    for (const [expected, run] of cases) {
      await assert.rejects(run, (e: unknown) => codeOf(e) === expected, `기대 코드 ${expected}`);
    }
    assert.equal(calls.length, 0, "거부 경로 전부에서 spawn 0");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// ── 스트림 매핑 (주입 spawn) ───────────────────────────────────────────────

async function runProvider(
  script: (c: FakeChild) => void,
  over: Partial<SessionSpec> = {},
): Promise<{ events: SessionEvent[]; calls: FakeCall[]; provider: CodexCliProvider; repo: { root: string; head: string }; home: string }> {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  const provider = new CodexCliProvider({
    manifest: manifest(repo.head),
    controllerRepoRoot: repo.root,
    bin: "codex",
    spawn: fakeSpawn(calls, script),
  });
  const handle = await provider.start(specFor(repo.root, home, over), "리뷰해라");
  const events = await drain(provider.events(handle));
  return { events, calls, provider, repo, home };
}

test("[M5a] 성공 스트림: cwd·stdin 프롬프트 전달 + result 1건", async () => {
  const { events, calls, repo, home } = await runProvider((c) => c.finish(OK_STREAM, 0));
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "codex");
    assert.equal(calls[0].cwd, repo.root);
    assert.equal(calls[0].stdin, "리뷰해라", "프롬프트는 argv가 아니라 stdin으로만 간다");
    assert.ok(!calls[0].args.includes("리뷰해라"));
    const results = events.filter((e) => e.kind === "result");
    assert.equal(results.length, 1);
    assert.equal(results[0].kind === "result" && results[0].isError, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 비정상 exit·signal·silent stream은 실패로 닫힌다", async () => {
  for (const [label, script, reason] of [
    ["nonzero", (c: FakeChild) => c.finish([], 3, null, "codex: unknown flag"), "exit_error"],
    ["signal", (c: FakeChild) => c.finish(OK_STREAM, null, "SIGKILL"), "signal"],
    ["silent", (c: FakeChild) => c.finish([], 0), "no_terminal_event"],
  ] as Array<[string, (c: FakeChild) => void, string]>) {
    const { events, repo, home } = await runProvider(script);
    try {
      const results = events.filter((e) => e.kind === "result");
      assert.equal(results.length, 1, `${label}: 종료 결과 1건`);
      assert.ok(results[0].kind === "result" && results[0].isError, `${label}: 실패여야 한다`);
      assert.equal(results[0].kind === "result" && results[0].terminalReason, reason, label);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
});

test("[M5a] spawn 실패(바이너리 없음)는 hang이 아니라 spawn_error 결과다", async () => {
  const { events, repo, home } = await runProvider((c) => c.emit("error", new Error("spawn codex ENOENT")));
  try {
    const r = events.filter((e) => e.kind === "result");
    assert.equal(r.length, 1);
    assert.equal(r[0].kind === "result" && r[0].terminalReason, "spawn_error");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] resume: ephemeral 세션은 거부 · 비ephemeral은 관측된 session id로만 재실행", async () => {
  // ephemeral(기본) → resume 불가
  {
    const { provider, repo, home } = await runProvider((c) => c.finish(OK_STREAM, 0));
    try {
      await assert.rejects(
        () => provider.send({ sessionId: "s1", spec: specFor(repo.root, home) }, "추가 지시"),
        (e: unknown) => codeOf(e) === "codex_resume_unavailable",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
  // ephemeral:false → 관측된 thread id로 resume
  {
    const repo = await initRepo();
    const home = codexHome();
    const calls: FakeCall[] = [];
    try {
      const provider = new CodexCliProvider({
        manifest: manifest(repo.head),
        controllerRepoRoot: repo.root,
        bin: "codex",
        spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
      });
      const spec = specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } });
      const handle = await provider.start(spec, "1차");
      await drain(provider.events(handle));
      await provider.send(handle, "2차");
      await drain(provider.events(handle));
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].args.slice(0, 3), ["exec", "resume", "th_abc"]);
      assert.equal(calls[1].stdin, "2차");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo.root, { recursive: true, force: true });
    }
  }
});

test("[M5a] resume: session id를 관측하지 못했으면 --last로 대체하지 않고 거부", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    const provider = new CodexCliProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      spawn: fakeSpawn(calls, (c) => c.finish(['{"type":"turn.completed","usage":{}}'], 0)),
    });
    const spec = specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } });
    const handle = await provider.start(spec, "1차");
    await drain(provider.events(handle));
    await assert.rejects(() => provider.send(handle, "2차"), (e: unknown) => codeOf(e) === "codex_resume_unavailable");
    assert.equal(calls.length, 1, "resume 거부에서는 두 번째 프로세스가 없다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] MCP 호출이 스트림에 보이면 실패 결과다", async () => {
  const { events, repo, home } = await runProvider((c) =>
    c.finish(
      [
        '{"type":"thread.started","thread_id":"th_abc"}',
        '{"type":"item.completed","item":{"id":"i","item_type":"mcp_tool_call","server":"s","tool":"t"}}',
        '{"type":"turn.completed","usage":{}}',
      ],
      0,
    ),
  );
  try {
    const r = events.filter((e) => e.kind === "result");
    assert.equal(r.length, 1);
    assert.equal(r[0].kind === "result" && r[0].terminalReason, "mcp_call_observed");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 권한 실패는 permission_required로 올라온다(hang 없음)", async () => {
  const { events, repo, home } = await runProvider((c) =>
    c.finish(
      [
        '{"type":"thread.started","thread_id":"th_abc"}',
        '{"type":"turn.failed","error":{"message":"approval required in non-interactive mode"}}',
      ],
      1,
    ),
  );
  try {
    const r = events.find((e) => e.kind === "result");
    assert.ok(r && r.kind === "result");
    assert.equal(r.stopReason, "permission_required");
    assert.equal(r.isError, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// ── 결정론적 fake CLI 실제 spawn ───────────────────────────────────────────

test("[M5a] fake CLI 왕복: argv·cwd·stdin·격리 env가 계약대로 도착한다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    writeFileSync(
      join(home, "scenario.json"),
      JSON.stringify({ lines: OK_STREAM, exitCode: 0 }),
    );
    const provider = new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn: realFakeSpawn });
    const handle = await provider.start(specFor(repo.root, home), "리뷰 프롬프트");
    const events = await drain(provider.events(handle));

    const r = events.find((e) => e.kind === "result");
    assert.ok(r && r.kind === "result" && !r.isError);
    assert.equal(r.text, "done");

    const seen = JSON.parse(readFileSync(join(home, "invocation.json"), "utf8"));
    assert.deepEqual(seen.argv, compileCodexArgs(specFor(repo.root, home)));
    assert.equal(seen.cwd, repo.root);
    assert.equal(seen.stdin, "리뷰 프롬프트");
    // 자식이 보는 env는 우리가 준 PATH·CODEX_HOME뿐이다(플랫폼이 주입하는 __CF_* 제외).
    const injected = seen.envKeys.filter((k: string) => !["CODEX_HOME", "PATH", "__CF_USER_TEXT_ENCODING"].includes(k));
    assert.deepEqual(injected, [], "사용자 env를 상속하지 않는다");
    assert.ok(!seen.envKeys.includes("HOME"), "사용자 HOME 미상속 → ambient ~/.codex 설정·auth를 볼 수 없다");
    assert.ok(seen.envKeys.includes("CODEX_HOME"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 비정상 종료: stderr는 bounded·scrubbed 요약으로만 남는다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    writeFileSync(
      join(home, "scenario.json"),
      JSON.stringify({ lines: [], exitCode: 7, stderr: `codex: token=SUPERSECRET ${"z".repeat(2000)}` }),
    );
    const provider = new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn: realFakeSpawn });
    const handle = await provider.start(specFor(repo.root, home), "p");
    const events = await drain(provider.events(handle));
    const r = events.find((e) => e.kind === "result");
    assert.ok(r && r.kind === "result");
    assert.equal(r.isError, true);
    assert.equal(r.terminalReason, "exit_error");
    assert.ok(!r.text.includes("SUPERSECRET"));
    assert.ok(r.text.length < 600, "stderr 요약은 상한을 넘지 않는다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 중단(signal): 종료 결과 1건 · 실패", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    writeFileSync(join(home, "scenario.json"), JSON.stringify({ lines: OK_STREAM, selfSignal: "SIGKILL" }));
    const provider = new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn: realFakeSpawn });
    const handle = await provider.start(specFor(repo.root, home), "p");
    const events = await drain(provider.events(handle));
    const results = events.filter((e) => e.kind === "result");
    assert.equal(results.length, 1);
    assert.ok(results[0].kind === "result" && results[0].isError);
    assert.equal(results[0].kind === "result" && results[0].terminalReason, "signal");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 구조화 출력: --output-schema 요청 시 argv에 실리고 본문이 result.text다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const schema = join(home, "review.schema.json");
  try {
    mkdirSync(join(home, "unused"), { recursive: true });
    writeFileSync(schema, JSON.stringify({ type: "object" }));
    writeFileSync(
      join(home, "scenario.json"),
      JSON.stringify({
        lines: [
          '{"type":"thread.started","thread_id":"th_abc"}',
          '{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"{\\"verdict\\":\\"pass\\"}"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
        ],
      }),
    );
    const spec = specFor(repo.root, home, { codex: { codexHome: home, outputSchemaPath: schema } });
    const provider = new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn: realFakeSpawn });
    const handle = await provider.start(spec, "p");
    const events = await drain(provider.events(handle));
    const seen = JSON.parse(readFileSync(join(home, "invocation.json"), "utf8"));
    assert.ok(seen.argv.includes("--output-schema") && seen.argv.includes(schema));
    const r = events.find((e) => e.kind === "result");
    assert.ok(r && r.kind === "result");
    assert.deepEqual(JSON.parse(r.text), { verdict: "pass" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 오염 스트림: malformed·과대 줄·unknown이 섞여도 종료 결과는 1건", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    writeFileSync(
      join(home, "scenario.json"),
      JSON.stringify({
        lines: [
          '{"type":"thread.started","thread_id":"th_abc"}',
          "{broken json",
          `{"type":"item.completed","item":{"item_type":"agent_message","text":"${"y".repeat(70_000)}"}}`,
          '{"type":"unheard.of","x":1}',
          '{"type":"turn.completed","usage":{}}',
        ],
      }),
    );
    const provider = new CodexCliProvider({ manifest: manifest(repo.head), controllerRepoRoot: repo.root, spawn: realFakeSpawn });
    const handle = await provider.start(specFor(repo.root, home), "p");
    const events = await drain(provider.events(handle));
    const kinds = events.filter((e) => e.kind === "unknown").map((e) => (e.kind === "unknown" ? e.type : ""));
    assert.ok(kinds.includes("malformed_line") && kinds.includes("oversized_line") && kinds.includes("unheard.of"));
    assert.equal(events.filter((e) => e.kind === "result").length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});
