/**
 * V3 M5a — CodexCliProvider 테스트.
 * 실제 codex 추론·네트워크·인증은 없다. 두 가지 방식만 쓴다:
 *  ⓐ in-process spawn seam 주입(argv·env·stdin·spawn 횟수·수명 단정)
 *  ⓑ 결정론적 fake CLI(`__fixtures__/fake-codex.mjs`) 실제 spawn — stdio 배선까지 확인
 * 실행: `npx tsx --test src/exec/codexCliProvider.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { runProcess } from "./runProcess.js";
import {
  CodexCliProvider,
  assertIsolatedCodexHome,
  assertTrustedExecutable,
  compileCodexArgs,
  compileCodexEnv,
  resolveCodexOptions,
  verifyCodexHome,
  type SpawnFn,
} from "./codexCliProvider.js";
import { OrchestrationError } from "./orchestrationTypes.js";
import type { SessionEvent, SessionSpec } from "./types.js";

const FAKE_CLI = fileURLToPath(new URL("./__fixtures__/fake-codex.mjs", import.meta.url));
const PROVIDER_SRC = fileURLToPath(new URL("./codexCliProvider.ts", import.meta.url));
/** 신뢰된 실행 파일: 현재 node 바이너리(정규 경로·일반 파일·0755). */
const TRUSTED_BIN = realpathSync(process.execPath);

/** 테스트용 신뢰 git 경로(테스트 안에서만 PATH를 훑는다 — production은 호출자가 경로를 준다). */
function findGit(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const real = realpathSync(join(dir, "git"));
      if (lstatSync(real).isFile()) return real;
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error("테스트용 git 실행 파일을 PATH에서 찾지 못했다");
}
const TRUSTED_GIT = findGit();

type ProviderOpts = ConstructorParameters<typeof CodexCliProvider>[0];

/** 모든 생성 지점에 신뢰된 git 경로를 채워 준다(계약은 그대로 — 인자만 채운다). */
function codexProvider(opts: Omit<ProviderOpts, "gitExecutablePath"> & { gitExecutablePath?: string }): CodexCliProvider {
  return new CodexCliProvider({ gitExecutablePath: TRUSTED_GIT, ...opts });
}
const TID = "0199a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
const TID2 = "0199ffff-c3d4-4e5f-8a9b-0c1d2e3f4a5b";

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

/** 비어 있는 0700 격리 홈. */
function codexHome(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "m5a-home-")));
}

function specFor(cwd: string, home: string, over: Partial<SessionSpec> = {}): SessionSpec {
  return { sessionId: "s1", role: "reviewer", cwd, model: "gpt-5.6-sol", codex: { codexHome: home }, ...over };
}

interface FakeCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed: string | null = null;
  private done = false;
  kill(signal: string): boolean {
    this.killed = signal;
    // 실제 SIGTERM처럼 비동기 close로 수렴시킨다.
    setImmediate(() => this.close(null, signal));
    return true;
  }
  close(code: number | null, signal: string | null = null): void {
    if (this.done) return;
    this.done = true;
    this.emit("close", code, signal);
  }
  finish(lines: string[], code: number | null, signal: string | null = null, stderr = ""): void {
    for (const l of lines) this.stdout.write(`${l}\n`);
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.close(code, signal));
  }
  /** 모든 줄을 **한 chunk**로 쓴다 — 파서가 한 번의 `push`로 전부 보는 최악의 경우를 고정한다. */
  finishOneChunk(lines: string[], code: number | null): void {
    this.stdout.write(lines.map((l) => `${l}\n`).join(""));
    setImmediate(() => this.close(code, null));
  }
}

function fakeSpawn(calls: FakeCall[], script: (child: FakeChild, index: number) => void): SpawnFn {
  return (command, args, options) => {
    const child = new FakeChild();
    const record: FakeCall = { command, args, cwd: options.cwd, env: options.env, stdin: "" };
    const index = calls.push(record) - 1;
    child.stdin.on("data", (d: Buffer | string) => (record.stdin += String(d)));
    setImmediate(() => script(child, index));
    return child as unknown as ChildProcess;
  };
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

async function codeOfCall(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
    return "(통과)";
  } catch (e) {
    return codeOf(e);
  }
}

const OK_STREAM = [
  `{"type":"thread.started","thread_id":"${TID}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":6}}',
];

function resultsOf(events: SessionEvent[]) {
  return events.filter((e) => e.kind === "result") as Extract<SessionEvent, { kind: "result" }>[];
}

// ── argv / env / 설정 계약 (순수 함수) ────────────────────────────────────

test("[M5a] argv(fresh): 명시 배열 + stdin 프롬프트 + 격리/read-only 플래그", () => {
  assert.deepEqual(compileCodexArgs(specFor("/tmp/wt", "/tmp/home"), "/tmp/wt"), [
    "exec",
    "--json",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    "mcp_servers={}",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp/wt",
    "--ephemeral",
    "-",
  ]);
});

test("[M5a] argv(resume): --sandbox/--cd는 resume 앞(부모 위치), --ephemeral 없음", () => {
  const spec = specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", ephemeral: false } });
  assert.deepEqual(compileCodexArgs(spec, "/tmp/wt", TID), [
    "exec",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp/wt",
    "resume",
    TID,
    "--json",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    "mcp_servers={}",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "-",
  ]);
});

/**
 * supervisor 실측(codex-cli 0.146.0-alpha.3, parse-only) 기반 파싱 계약.
 * fresh exec는 아래 전부를 받고, `exec resume`는 subcommand-local `--sandbox`/`--cd`/`--ephemeral`을 받지 않는다.
 */
const FRESH_SUPPORTED = new Set([
  "--config",
  "--strict-config",
  "--model",
  "--sandbox",
  "--cd",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--json",
]);
const RESUME_LOCAL_SUPPORTED = new Set([
  "--config",
  "--strict-config",
  "--model",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--json",
]);

test("[M5a] 파싱 계약: 모든 플래그가 설치된 CLI가 받는 위치에만 있다(실측 help 근거)", () => {
  const schema = join(tmpdir(), "m5a-schema.json");
  const spec = specFor("/tmp/wt", "/tmp/home", {
    codex: { codexHome: "/tmp/home", ephemeral: false, outputSchemaPath: schema },
  });

  const fresh = compileCodexArgs(spec, "/tmp/wt");
  assert.equal(fresh[0], "exec");
  assert.ok(!fresh.includes("resume"));
  for (const a of fresh) if (a.startsWith("--")) assert.ok(FRESH_SUPPORTED.has(a), `fresh exec가 받지 않는 플래그: ${a}`);

  const resumed = compileCodexArgs(spec, "/tmp/wt", TID);
  const at = resumed.indexOf("resume");
  assert.ok(at > 0, "resume 하위 명령이 있다");
  assert.equal(resumed[at + 1], TID);
  // 부모 위치(= resume 앞)에는 fresh exec가 받는 것만.
  for (const a of resumed.slice(0, at)) if (a.startsWith("--")) assert.ok(FRESH_SUPPORTED.has(a), `부모 위치 미지원 플래그: ${a}`);
  // resume 뒤에는 subcommand-local 지원 플래그만 — 실측상 --sandbox/--cd/--ephemeral은 여기서 거부된다.
  for (const a of resumed.slice(at + 2)) {
    if (a.startsWith("--")) assert.ok(RESUME_LOCAL_SUPPORTED.has(a), `resume이 받지 않는 플래그: ${a}`);
  }
  for (const forbidden of ["--sandbox", "--cd", "--ephemeral"]) {
    assert.ok(!resumed.slice(at).includes(forbidden), `${forbidden}가 resume 뒤에 있으면 CLI가 거부한다`);
  }
  assert.ok(!resumed.includes("--last") && !fresh.includes("--last"));
  assert.ok(![...fresh, ...resumed].some((a) => /dangerous|bypass|full-auto|danger-full-access/.test(a)));
});

test("[M5a] argv: resume 대상은 정규 UUID만 — 검증 안 된 텍스트로 인자를 만들지 않는다", async () => {
  const spec = specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", ephemeral: false } });
  for (const hostile of ["--last", "", "not-a-uuid", `${TID} --last`, "0199A1B2-C3D4-4E5F-8A9B-0C1D2E3F4A5B"]) {
    assert.equal(await codeOfCall(() => compileCodexArgs(spec, "/tmp/wt", hostile)), "codex_resume_id_invalid", hostile);
  }
});

test("[M5a] env: CODEX_HOME 하나뿐 — PATH조차 상속하지 않는다", () => {
  const env = compileCodexEnv("/tmp/home");
  assert.deepEqual(Object.keys(env), ["CODEX_HOME"]);
  assert.equal(env.CODEX_HOME, "/tmp/home");
});

test("[M5a] provider 소스는 process.env를 읽지 않는다(env 유래 production 동작 0)", () => {
  // 주석은 계약 서술이라 제외하고 **코드**만 본다.
  const code = readFileSync(PROVIDER_SRC, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/process\s*\.\s*env/.test(code), "provider 코드가 process.env를 참조한다");
  assert.ok(!/HARNESS_CODEX_BIN/.test(code), "env 기반 실행 파일 seam이 남아 있다");
});

test("[M5a] 설정은 fail closed: codexHome 필수 · workspace-write hard deny · 모델/경로 계약", async () => {
  const bad = (spec: SessionSpec) => codeOfCall(() => resolveCodexOptions(spec));
  assert.equal(await bad({ sessionId: "s", role: "r", cwd: "/tmp/wt" }), "codex_config_isolation_required");
  assert.equal(await bad(specFor("/tmp/wt", "relative-home")), "codex_config_invalid");
  assert.equal(await bad(specFor("/tmp/wt", "/tmp/home", { model: "bad model!" })), "codex_config_invalid");
  assert.equal(await bad(specFor("relative/wt", "/tmp/home")), "codex_config_invalid");
  for (const sandbox of ["workspace-write", "danger-full-access", "" as unknown]) {
    assert.equal(
      await bad(specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", sandbox: sandbox as never } })),
      "codex_sandbox_forbidden",
      String(sandbox),
    );
  }
  assert.equal(
    await bad(specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", reasoningEffort: "ultra" as never } })),
    "codex_config_invalid",
  );
  assert.equal(
    await bad(specFor("/tmp/wt", "/tmp/home", { codex: { codexHome: "/tmp/home", outputSchemaPath: "schema.json" } })),
    "codex_config_invalid",
  );
});

test("[M5a] 실행 파일 신원: 절대·정규·비-symlink 일반 파일·실행 비트·타인 쓰기 금지", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-bin-")));
  try {
    assert.equal(assertTrustedExecutable(TRUSTED_BIN), TRUSTED_BIN);
    assert.equal(await codeOfCall(() => assertTrustedExecutable("codex")), "codex_config_invalid");
    assert.equal(await codeOfCall(() => assertTrustedExecutable(undefined)), "codex_config_invalid");
    assert.equal(await codeOfCall(() => assertTrustedExecutable(join(dir, "missing"))), "codex_executable_invalid");
    assert.equal(await codeOfCall(() => assertTrustedExecutable(dir)), "codex_executable_invalid", "디렉터리 거부");

    const link = join(dir, "link-to-node");
    symlinkSync(TRUSTED_BIN, link);
    assert.equal(await codeOfCall(() => assertTrustedExecutable(link)), "codex_executable_invalid", "symlink 거부");

    const plain = join(dir, "plain.sh");
    writeFileSync(plain, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    assert.equal(await codeOfCall(() => assertTrustedExecutable(plain)), "codex_executable_invalid", "실행 비트 없음");

    chmodSync(plain, 0o777);
    assert.equal(await codeOfCall(() => assertTrustedExecutable(plain)), "codex_executable_invalid", "타인 쓰기 가능");
    chmodSync(plain, 0o755);
    assert.equal(assertTrustedExecutable(plain), plain);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M5a] 격리 홈 검증: 사용자 홈·비어있지 않음·symlink·느슨한 권한 전부 거부", async () => {
  const home = codexHome();
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "m5a-hp-")));
  try {
    assert.equal(assertIsolatedCodexHome(home), home);
    assert.equal(await codeOfCall(() => assertIsolatedCodexHome(realpathSync(homedir()))), "codex_home_ambient");
    assert.equal(await codeOfCall(() => assertIsolatedCodexHome(join(realpathSync(homedir()), ".codex"))), "codex_home_ambient");

    const link = join(parent, "home-link");
    symlinkSync(home, link, "dir");
    assert.equal(await codeOfCall(() => assertIsolatedCodexHome(link)), "codex_home_invalid", "symlink 홈 거부");

    const permissive = realpathSync(mkdtempSync(join(tmpdir(), "m5a-perm-")));
    chmodSync(permissive, 0o755);
    assert.equal(await codeOfCall(() => assertIsolatedCodexHome(permissive)), "codex_home_permissive");
    rmSync(permissive, { recursive: true, force: true });

    writeFileSync(join(home, "auth.json"), "{}"); // ambient 자격증명 흉내
    const err = await codeOfCall(() => assertIsolatedCodexHome(home));
    assert.equal(err, "codex_home_not_empty");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("[M5a] 격리 홈 수명(단위): 최초는 빈 홈 · 소유 신원이 같을 때만 이후 상태를 허용", async () => {
  const home = codexHome();
  const other = codexHome();
  try {
    const first = verifyCodexHome(home);
    assert.equal(first.path, home);
    const st = lstatSync(home);
    assert.deepEqual(first.id, { dev: st.dev, ino: st.ino }, "신원은 dev+ino다(경로 문자열이 아니다)");

    // codex가 세션 상태를 남긴 상황
    mkdirSync(join(home, "sessions", "2026", "07", "27"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "sessions", "2026", "07", "27", "rollout-x.jsonl"), "{}\n");

    assert.equal(await codeOfCall(() => verifyCodexHome(home)), "codex_home_not_empty", "소유권 없이는 기존 상태를 받지 않는다");
    assert.equal(verifyCodexHome(home, { identity: first.id }).path, home, "소유 신원이 같으면 그 상태를 허용한다");
    assert.equal(
      await codeOfCall(() => verifyCodexHome(other, { identity: first.id })),
      "codex_home_identity_changed",
      "다른 디렉터리는 같은 소유권으로 통과하지 않는다",
    );
    // 첫 invocation의 spawn 직전 재확인: 신원이 같아도 **비어 있음**을 여전히 요구한다.
    assert.equal(
      await codeOfCall(() => verifyCodexHome(home, { identity: first.id, requireEmpty: true })),
      "codex_home_not_empty",
      "requireEmpty는 소유 신원과 독립이다(첫 invocation 두 번째 검증)",
    );
    chmodSync(home, 0o755);
    assert.equal(
      await codeOfCall(() => verifyCodexHome(home, { identity: first.id })),
      "codex_home_permissive",
      "소유 홈도 권한 검사는 그대로다",
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 프로세스는 검증을 다 통과할 때만 뜬다 (spawn 횟수 0 계약) ─────────────

/** 모든 거부 케이스에서 spawn 0을 확인하는 공용 러너. */
async function expectNoSpawn(
  build: (repo: { root: string; head: string }, home: string, calls: FakeCall[]) => Promise<unknown>,
): Promise<string> {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    const code = await codeOfCall(() => build(repo, home, calls));
    assert.equal(calls.length, 0, `거부 경로인데 spawn이 일어났다(${code})`);
    return code;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
}

function providerWith(repo: { head: string }, controllerRoot: string, calls: FakeCall[], over: Record<string, unknown> = {}) {
  return codexProvider({
    manifest: manifest(repo.head),
    controllerRepoRoot: controllerRoot,
    executablePath: TRUSTED_BIN,
    spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
    ...over,
  });
}

test("[M5a] approvedCommit 불일치·만료·경로 위반이면 spawn 횟수 0", async () => {
  assert.equal(
    await expectNoSpawn((repo, home, calls) =>
      codexProvider({
        manifest: manifest("b".repeat(40)),
        controllerRepoRoot: repo.root,
        executablePath: TRUSTED_BIN,
        spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
      }).start(specFor(repo.root, home), "리뷰해라"),
    ),
    "approved_commit_mismatch",
  );
  assert.equal(
    await expectNoSpawn((repo, home, calls) =>
      providerWith(repo, repo.root, calls, { nowMs: () => Date.parse("2099-12-31T00:00:00.000Z") }).start(
        specFor(repo.root, home),
        "p",
      ),
    ),
    "manifest_expired",
  );
  assert.equal(
    await expectNoSpawn((repo, home, calls) => providerWith(repo, join(repo.root, "nope"), calls).start(specFor(repo.root, home), "p")),
    "boundary_path_unresolvable",
  );
  assert.equal(
    await expectNoSpawn((repo, home, calls) =>
      codexProvider({
        manifest: { milestoneId: "m5a" },
        controllerRepoRoot: repo.root,
        executablePath: TRUSTED_BIN,
        spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
      }).start(specFor(repo.root, home), "p"),
    ),
    "invalid_manifest",
  );
});

test("[M5a] workspace-write 요청은 프로세스를 띄우지 않는다(M5a hard deny)", async () => {
  assert.equal(
    await expectNoSpawn((repo, home, calls) =>
      providerWith(repo, repo.root, calls).start(
        specFor(repo.root, home, { codex: { codexHome: home, sandbox: "workspace-write" as never } }),
        "p",
      ),
    ),
    "codex_sandbox_forbidden",
  );
});

test("[M5a] 실행 파일이 신뢰 조건을 어기면 spawn 0 — env로 대체 경로를 고르지도 않는다", async () => {
  // 공격자가 env를 심어도 provider는 명시 경로만 본다(그리고 그 경로가 나쁘면 거부한다).
  const prevBin = process.env.HARNESS_CODEX_BIN;
  const prevEvil = process.env.CODEX_BIN;
  process.env.HARNESS_CODEX_BIN = "/tmp/evil-codex";
  process.env.CODEX_BIN = "/tmp/evil-codex";
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-badbin-")));
  try {
    const nonExec = join(dir, "codex");
    writeFileSync(nonExec, "#!/bin/sh\n", { mode: 0o644 });
    const link = join(dir, "codex-link");
    symlinkSync(TRUSTED_BIN, link);
    for (const bin of [nonExec, link, join(dir, "missing"), "codex", "", undefined]) {
      assert.equal(
        await expectNoSpawn((repo, home, calls) =>
          providerWith(repo, repo.root, calls, { executablePath: bin }).start(specFor(repo.root, home), "p"),
        ),
        bin === "codex" || bin === "" || bin === undefined ? "codex_config_invalid" : "codex_executable_invalid",
        String(bin),
      );
    }
    // 정상 경로에서는 env가 오염돼 있어도 **명시 경로로만** spawn하고 env를 물려주지 않는다.
    const repo = await initRepo();
    const home = codexHome();
    const calls: FakeCall[] = [];
    try {
      const provider = providerWith(repo, repo.root, calls);
      const handle = await provider.start(specFor(repo.root, home), "p");
      await drain(provider.events(handle));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, TRUSTED_BIN, "env가 아니라 명시 경로로 spawn한다");
      assert.deepEqual(Object.keys(calls[0].env), ["CODEX_HOME"]);
      assert.ok(!JSON.stringify(calls[0]).includes("evil-codex"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.HARNESS_CODEX_BIN;
    else process.env.HARNESS_CODEX_BIN = prevBin;
    if (prevEvil === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prevEvil;
  }
});

test("[M5a] 격리 홈이 계약을 어기면 spawn 0", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    writeFileSync(join(home, "config.toml"), "x=1\n");
    const code = await codeOfCall(() => providerWith(repo, repo.root, calls).start(specFor(repo.root, home), "p"));
    assert.equal(code, "codex_home_not_empty");
    assert.equal(calls.length, 0);

    rmSync(join(home, "config.toml"));
    chmodSync(home, 0o755);
    assert.equal(
      await codeOfCall(() => providerWith(repo, repo.root, calls).start(specFor(repo.root, home), "p")),
      "codex_home_permissive",
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 소유하지 않은 기존 세션 상태로는 시작하지 않는다(spawn 0)", async () => {
  assert.equal(
    await expectNoSpawn((repo, home, calls) => {
      // 다른 누군가(또는 이전 실행)가 남긴 codex 세션 상태 = 소유권 없음.
      mkdirSync(join(home, "sessions", "2026", "07", "27"), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, "sessions", "2026", "07", "27", "rollout-old.jsonl"), "{}\n");
      return providerWith(repo, repo.root, calls).start(specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } }), "p");
    }),
    "codex_home_not_empty",
  );
});

test("[M5a] resume: 홈이 교체·symlink화·권한 완화되면 두 번째 프로세스를 띄우지 않는다", async () => {
  // 각 케이스: 1차 invocation 성공(소유 신원 고정) → 홈을 훼손 → send는 spawn 0으로 거부.
  const cases: Array<[string, (home: string, spare: string) => void, string]> = [
    [
      "교체(inode 다름)",
      (home, spare) => {
        // spare는 home이 살아 있는 동안 만들어졌으므로 inode가 반드시 다르다(우연 일치 없음).
        rmSync(home, { recursive: true, force: true });
        renameSync(spare, home);
      },
      "codex_home_identity_changed",
    ],
    [
      "symlink 교체",
      (home, spare) => {
        rmSync(home, { recursive: true, force: true });
        symlinkSync(spare, home, "dir");
      },
      "codex_home_invalid",
    ],
    [
      "권한 완화",
      (home) => chmodSync(home, 0o755),
      "codex_home_permissive",
    ],
  ];
  for (const [label, tamper, expected] of cases) {
    const h = await harness((c) => c.finish(OK_STREAM, 0));
    const spare = codexHome();
    try {
      const spec = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
      const handle = await h.provider.start(spec, "1차");
      await drain(h.provider.events(handle));
      assert.equal(h.calls.length, 1, label);
      tamper(h.home, spare);
      assert.equal(await codeOfCall(() => h.provider.send(handle, "2차")), expected, label);
      assert.equal(h.calls.length, 1, `${label}: 거부 경로인데 두 번째 프로세스가 떴다`);
    } finally {
      rmSync(spare, { recursive: true, force: true });
      h.cleanup();
    }
  }
});

test("[M5a] 프롬프트 계약 위반도 spawn 0", async () => {
  assert.equal(
    await expectNoSpawn((repo, home, calls) => providerWith(repo, repo.root, calls).start(specFor(repo.root, home), "x".repeat(300_000))),
    "codex_prompt_too_long",
  );
  assert.equal(
    await expectNoSpawn((repo, home, calls) => providerWith(repo, repo.root, calls).start(specFor(repo.root, home), "")),
    "codex_prompt_invalid",
  );
});

test("[M5a] spawn 직전 HEAD가 움직이면 프로세스를 띄우지 않는다(TOCTOU 재확인)", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    // 경계 검증 통과 후, revalidateSync 직전에 HEAD를 옮기는 시나리오를 nowMs 훅 시점에 끼워 넣는다.
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
      nowMs: () => {
        // 이 훅은 verifyExecutionBoundary 호출 인자로 평가된다 — 이후 revalidateSync가 변경을 잡아야 한다.
        return Date.now();
      },
    });
    writeFileSync(join(repo.root, "b.txt"), "b\n");
    await runProcess("git", ["-C", repo.root, "add", "."]);
    await runProcess("git", ["-C", repo.root, "commit", "-q", "-m", "moved"]);
    const code = await codeOfCall(() => provider.start(specFor(repo.root, home), "p"));
    assert.equal(code, "approved_commit_mismatch");
    assert.equal(calls.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

/**
 * 비동기 경계 작업 **창 안에서** 훼손을 실행한다. `nowMs`의 **첫 읽기**는 `verifyExecutionBoundary`
 * 진입(= 비동기 git 조회 **전**)이므로, 거기서 훼손하면 spawn 직전 동기 게이트가 반드시 잡아야 한다.
 * 타이머·경합 추측이 아니라 호출 순서에 묶인 결정론적 훅이다.
 */
interface WindowCtx {
  home: string;
  bin: string;
  spare: string;
  repoRoot: string;
  spec: SessionSpec;
}
async function tamperDuringWindow(
  tamper: (ctx: WindowCtx) => void,
  opts: { onSecondInvocation?: boolean } = {},
): Promise<{ code: string; calls: number }> {
  const repo = await initRepo();
  const home = codexHome();
  const spare = codexHome();
  const binDir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-winbin-")));
  const bin = join(binDir, "codex");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 }); // spawn은 주입 seam이라 실행되지 않는다
  const calls: FakeCall[] = [];
  const spec = specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } });
  let armed = !opts.onSecondInvocation;
  let reads = 0;
  try {
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: bin,
      spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
      nowMs: () => {
        if (armed && ++reads === 1) tamper({ home, bin, spare, repoRoot: repo.root, spec });
        return Date.now();
      },
    });
    let code = "(통과)";
    if (opts.onSecondInvocation) {
      const handle = await provider.start(spec, "1차");
      await drain(provider.events(handle));
      armed = true;
      code = await codeOfCall(() => provider.send(handle, "2차"));
    } else {
      code = await codeOfCall(() => provider.start(spec, "p"));
    }
    return { code, calls: calls.length };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(spare, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
}

test("[M5a] 비동기 경계 창에서 홈이 훼손되면 spawn 0(첫 invocation은 여전히 빈 홈을 요구한다)", async () => {
  const cases: Array<[string, (c: WindowCtx) => void, string]> = [
    [
      "교체(inode 다름)",
      ({ home, spare }) => {
        rmSync(home, { recursive: true, force: true });
        renameSync(spare, home);
      },
      "codex_home_identity_changed",
    ],
    [
      "symlink 교체",
      ({ home, spare }) => {
        rmSync(home, { recursive: true, force: true });
        symlinkSync(spare, home, "dir");
      },
      "codex_home_invalid",
    ],
    ["권한 완화", ({ home }) => chmodSync(home, 0o755), "codex_home_permissive"],
    [
      "ambient 상태 주입(비어 있지 않게 됨)",
      ({ home }) => writeFileSync(join(home, "auth.json"), "{}"),
      "codex_home_not_empty",
    ],
  ];
  for (const [label, tamper, expected] of cases) {
    const r = await tamperDuringWindow(tamper);
    assert.equal(r.code, expected, label);
    assert.equal(r.calls, 0, `${label}: 훼손된 홈으로 프로세스가 떴다`);
  }
});

test("[M5a] 비동기 경계 창에서 실행 파일이 교체되면 spawn 0(신원 고정 — 같은 권한도 통과 못 한다)", async () => {
  const cases: Array<[string, (c: WindowCtx) => void, string]> = [
    [
      "같은 mode·다른 inode로 교체",
      ({ bin }) => {
        const other = `${bin}-other`;
        writeFileSync(other, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        renameSync(other, bin); // 경로·권한 동일, 실체만 교체
      },
      "codex_executable_identity_changed",
    ],
    [
      "symlink 교체",
      ({ bin }) => {
        rmSync(bin, { force: true });
        symlinkSync(TRUSTED_BIN, bin);
      },
      "codex_executable_invalid",
    ],
    [
      "권한 완화(타인 쓰기)",
      ({ bin }) => chmodSync(bin, 0o777),
      "codex_executable_invalid",
    ],
    ["삭제", ({ bin }) => rmSync(bin, { force: true }), "codex_executable_invalid"],
  ];
  for (const [label, tamper, expected] of cases) {
    const r = await tamperDuringWindow(tamper);
    assert.equal(r.code, expected, label);
    assert.equal(r.calls, 0, `${label}: 교체된 실행 파일로 프로세스가 떴다`);
  }
});

test("[M5a] resume에서도 창 안 훼손은 두 번째 프로세스를 막는다(소유 홈 신원)", async () => {
  const r = await tamperDuringWindow(
    ({ home, spare }) => {
      rmSync(home, { recursive: true, force: true });
      renameSync(spare, home);
    },
    { onSecondInvocation: true },
  );
  assert.equal(r.code, "codex_home_identity_changed");
  assert.equal(r.calls, 1, "1차만 떴고 resume은 spawn 0이다");
});

test("[M5a] 창 안에서 spec이 변조되면 그 spec으로 인자를 만들지 않고 거부한다(spawn 0)", async () => {
  for (const [label, mutate, expected] of [
    ["model", (spec: SessionSpec) => (spec.model = "evil-model"), "codex_spec_mutated"],
    ["outputSchemaPath", (spec: SessionSpec) => (spec.codex!.outputSchemaPath = "/tmp/evil.json"), "codex_spec_mutated"],
    ["codexHome", (spec: SessionSpec) => (spec.codex!.codexHome = "/tmp"), "codex_spec_mutated"],
    // 계약 자체를 어기는 변조는 스냅샷 비교 전에 재해석 단계에서 걸린다(둘 다 fail closed).
    ["sandbox", (spec: SessionSpec) => (spec.codex!.sandbox = "workspace-write" as never), "codex_sandbox_forbidden"],
  ] as Array<[string, (s: SessionSpec) => void, string]>) {
    const r = await tamperDuringWindow(({ spec }) => mutate(spec));
    assert.equal(r.code, expected, label);
    assert.equal(r.calls, 0, `${label}: 변조된 spec으로 프로세스가 떴다`);
  }
});

test("[M5a] 승인이 경계 검증과 spawn 사이에 만료되면 프로세스를 띄우지 않는다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    // manifest.expiresAt = 2099-12-31. clock을 그 직전 → 그 시각으로 진행시킨다(비동기 git 조회 동안 만료).
    const at = Date.parse("2099-12-31T00:00:00.000Z");
    let reads = 0;
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
      nowMs: () => (++reads === 1 ? at - 1 : at),
    });
    assert.equal(await codeOfCall(() => provider.start(specFor(repo.root, home), "p")), "manifest_expired");
    assert.equal(calls.length, 0, "만료된 승인으로는 spawn하지 않는다");
    assert.equal(reads, 2, "만료는 경계 진입과 spawn 직전 재검증에서 각각 확인된다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// ── 스트림 매핑 · 수명 (주입 spawn) ────────────────────────────────────────

interface Harness {
  provider: CodexCliProvider;
  repo: { root: string; head: string };
  home: string;
  calls: FakeCall[];
  cleanup(): void;
}

async function harness(script: (c: FakeChild, i: number) => void, over: Record<string, unknown> = {}): Promise<Harness> {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  const provider = codexProvider({
    manifest: manifest(repo.head),
    controllerRepoRoot: repo.root,
    executablePath: TRUSTED_BIN,
    spawn: fakeSpawn(calls, script),
    ...over,
  });
  return {
    provider,
    repo,
    home,
    calls,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo.root, { recursive: true, force: true });
    },
  };
}

test("[M5a] 성공 스트림: cwd·stdin 프롬프트 전달 + result 1건", async () => {
  const h = await harness((c) => c.finish(OK_STREAM, 0));
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "리뷰해라");
    const events = await drain(h.provider.events(handle));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].cwd, h.repo.root, "native cwd = 경계가 확인한 targetRoot");
    assert.equal(h.calls[0].args[h.calls[0].args.indexOf("--cd") + 1], h.repo.root, "argv --cd도 같은 값");
    assert.equal(h.calls[0].stdin, "리뷰해라", "프롬프트는 argv가 아니라 stdin으로만 간다");
    assert.ok(!h.calls[0].args.includes("리뷰해라"));
    const r = resultsOf(events);
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, false);
  } finally {
    h.cleanup();
  }
});

test("[M5a] 비정상 exit·signal·silent stream은 실패로 닫힌다", async () => {
  for (const [label, script, reason] of [
    ["nonzero", (c: FakeChild) => c.finish([], 3, null, "codex: unknown flag"), "exit_error"],
    ["signal", (c: FakeChild) => c.finish(OK_STREAM, null, "SIGKILL"), "signal"],
    ["silent", (c: FakeChild) => c.finish([], 0), "no_terminal_event"],
  ] as Array<[string, (c: FakeChild) => void, string]>) {
    const h = await harness(script);
    try {
      const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
      const r = resultsOf(await drain(h.provider.events(handle)));
      assert.equal(r.length, 1, `${label}: 종료 결과 1건`);
      assert.ok(r[0].isError, `${label}: 실패여야 한다`);
      assert.equal(r[0].terminalReason, reason, label);
    } finally {
      h.cleanup();
    }
  }
});

test("[M5a] 수명: error와 close가 겹쳐 와도 종료 결과는 1건", async () => {
  const h = await harness((c) => {
    c.emit("error", new Error("spawn codex ENOENT"));
    c.close(1, null);
  });
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r.length, 1);
    assert.equal(r[0].terminalReason, "spawn_error", "먼저 온 신호가 이긴다");
  } finally {
    h.cleanup();
  }
});

test("[M5a] 수명: 동기 spawn 예외는 던지고, 열린 큐를 남기지 않는다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: () => {
        throw new Error("EMFILE");
      },
    });
    const handle = { sessionId: "s1", spec: specFor(repo.root, home) };
    assert.equal(await codeOfCall(() => provider.start(specFor(repo.root, home), "p")), "codex_spawn_failed");
    // 실패한 start는 세션 상태를 남기지 않는다.
    assert.equal(await codeOfCall(() => provider.events(handle)), "codex_unknown_session");
    assert.equal(await codeOfCall(() => provider.send(handle, "x")), "codex_unknown_session");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 수명: stdin 오류는 unhandled가 아니라 프로토콜 실패로 수렴한다", async () => {
  const h = await harness((c) => {
    c.stdin.emit("error", new Error("EPIPE"));
    c.finish(OK_STREAM, 0);
  });
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, true);
    assert.equal(r[0].terminalReason, "stdin_error");
  } finally {
    h.cleanup();
  }
});

test("[M5a] 수명: 같은 harness 세션 id로 두 번 start하면 거부(기존 세션 보존)", async () => {
  const h = await harness((c) => c.finish(OK_STREAM, 0));
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
    assert.equal(await codeOfCall(() => h.provider.start(specFor(h.repo.root, h.home), "p2")), "codex_session_exists");
    assert.equal(h.calls.length, 1, "중복 start는 프로세스를 띄우지 않는다");
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r.length, 1, "기존 세션의 큐는 오염되지 않는다");
  } finally {
    h.cleanup();
  }
});

test("[M5a] 수명: 실행 중 send는 거부되고 기존 스트림을 교체하지 않는다", async () => {
  const held: { release?: () => void } = {};
  const h = await harness((c) => {
    held.release = () => c.finish(OK_STREAM, 0);
  });
  try {
    const spec = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
    const handle = await h.provider.start(spec, "p");
    assert.equal(await codeOfCall(() => h.provider.send(handle, "겹침")), "codex_send_overlap");
    assert.equal(h.calls.length, 1);
    await new Promise((r) => setImmediate(r)); // spawn 스크립트가 도는 tick을 지난다(FIFO — 타이밍 추측 아님)
    held.release?.();
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r.length, 1);
  } finally {
    h.cleanup();
  }
});

test("[M5a] 수명: stop은 종료 결과가 정착한 뒤에 정리한다", async () => {
  const h = await harness(() => {
    /* 스스로 끝나지 않는다 — stop의 SIGTERM이 close로 수렴시킨다 */
  });
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
    const stream = h.provider.events(handle); // stop 전에 잡아 둔다
    await h.provider.stop(handle, "테스트");
    const r = resultsOf(await drain(stream));
    assert.equal(r.length, 1, "stop 전에 큐를 닫아 종료 결과를 잃지 않는다");
    assert.equal(r[0].isError, true);
    assert.equal(r[0].terminalReason, "signal");
    assert.equal(await codeOfCall(() => h.provider.events(handle)), "codex_unknown_session", "정리 후에는 세션이 없다");
  } finally {
    h.cleanup();
  }
});

test("[M5a] resume: ephemeral 거부 · 관측 UUID로만 재실행 · 두 번째 invocation도 경계를 다시 지난다", async () => {
  const h = await harness((c) => c.finish(OK_STREAM, 0));
  try {
    const eph = await h.provider.start(specFor(h.repo.root, h.home), "1차");
    await drain(h.provider.events(eph));
    assert.equal(await codeOfCall(() => h.provider.send(eph, "2차")), "codex_resume_unavailable");
    assert.equal(h.calls.length, 1);
  } finally {
    h.cleanup();
  }

  const h2 = await harness((c) => c.finish(OK_STREAM, 0));
  try {
    const spec = specFor(h2.repo.root, h2.home, { codex: { codexHome: h2.home, ephemeral: false } });
    const handle = await h2.provider.start(spec, "1차");
    await drain(h2.provider.events(handle));
    await h2.provider.send(handle, "2차");
    await drain(h2.provider.events(handle));
    assert.equal(h2.calls.length, 2);
    assert.deepEqual(h2.calls[1].args.slice(0, 7), ["exec", "--sandbox", "read-only", "--cd", h2.repo.root, "resume", TID]);
    assert.equal(h2.calls[1].stdin, "2차");
  } finally {
    h2.cleanup();
  }
});

test("[M5a] resume: 정규 UUID를 관측하지 못했으면 --last로 대체하지 않고 거부", async () => {
  for (const stream of [['{"type":"turn.completed","usage":{}}'], ['{"type":"thread.started","thread_id":"--last"}']]) {
    const h = await harness((c) => c.finish(stream, 0));
    try {
      const spec = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
      const handle = await h.provider.start(spec, "1차");
      await drain(h.provider.events(handle));
      assert.equal(await codeOfCall(() => h.provider.send(handle, "2차")), "codex_resume_unavailable");
      assert.equal(h.calls.length, 1, "resume 거부에서는 두 번째 프로세스가 없다");
    } finally {
      h.cleanup();
    }
  }
});

test("[M5a] 세션 신원 충돌: resume이 다른 thread id를 내면 세션이 닫힌다", async () => {
  const h = await harness((c, i) => c.finish(i === 0 ? OK_STREAM : [`{"type":"thread.started","thread_id":"${TID2}"}`], 0));
  try {
    const spec = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
    const handle = await h.provider.start(spec, "1차");
    await drain(h.provider.events(handle));
    await h.provider.send(handle, "2차");
    const events = await drain(h.provider.events(handle));
    assert.ok(events.some((e) => e.kind === "unknown" && e.type === "session_identity_conflict"));
    const r = resultsOf(events);
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, true);
    assert.equal(r[0].terminalReason, "session_identity_conflict");
    assert.equal(await codeOfCall(() => h.provider.send(handle, "3차")), "codex_session_identity_conflict");
    assert.equal(h.calls.length, 2);
  } finally {
    h.cleanup();
  }
});

test("[M5a] MCP 호출이 스트림에 보이면 실패 결과다", async () => {
  const h = await harness((c) =>
    c.finish(
      [
        `{"type":"thread.started","thread_id":"${TID}"}`,
        '{"type":"item.completed","item":{"id":"i","item_type":"mcp_tool_call","server":"s","tool":"t"}}',
        '{"type":"turn.completed","usage":{}}',
      ],
      0,
    ),
  );
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r.length, 1);
    assert.equal(r[0].terminalReason, "mcp_call_observed");
  } finally {
    h.cleanup();
  }
});

test("[M5a] 적대적 resume 한 chunk: 다른 thread의 init·본문·도구가 한 건도 새지 않는다", async () => {
  // 2차 invocation이 **한 chunk**로 다른 thread id + 본문 + 도구 + 정상 종료를 몰아 보낸다.
  const HOSTILE = [
    `{"type":"thread.started","thread_id":"${TID2}"}`,
    '{"type":"turn.started"}',
    '{"type":"item.started","item":{"id":"h0","item_type":"reasoning"}}',
    '{"type":"item.completed","item":{"id":"h1","item_type":"agent_message","text":"HIJACK_TEXT_SENTINEL"}}',
    '{"type":"item.completed","item":{"id":"h2","item_type":"command_execution","command":"curl HIJACK_CMD_SENTINEL","status":"completed","exit_code":0}}',
    '{"type":"item.completed","item":{"id":"h3","item_type":"file_change","status":"completed","changes":[{"path":"HIJACK_PATH_SENTINEL","kind":"modify"}]}}',
    '{"type":"turn.completed","usage":{"input_tokens":99,"output_tokens":99}}',
  ];
  const h = await harness((c, i) => (i === 0 ? c.finish(OK_STREAM, 0) : c.finishOneChunk(HOSTILE, 0)));
  try {
    const spec = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
    const handle = await h.provider.start(spec, "1차");
    await drain(h.provider.events(handle));
    await h.provider.send(handle, "2차");
    const events = await drain(h.provider.events(handle));

    // ⓐ 방출된 것: 실패 marker 1건 + 결과 1건. 그 외 kind는 없다.
    assert.deepEqual(
      events.map((e) => e.kind),
      ["unknown", "result"],
      "봉인 이후 어떤 이벤트도 방출되지 않는다",
    );
    const marker = events[0];
    assert.ok(marker.kind === "unknown" && marker.type === "session_identity_conflict");
    assert.equal(marker.sessionId, TID, "marker는 기대 UUID에 묶인다");

    // ⓑ init·assistant·status·도구 payload 0
    assert.equal(events.filter((e) => e.kind === "init").length, 0, "다른 thread의 init이 없다");
    assert.equal(events.filter((e) => e.kind === "assistant" || e.kind === "status").length, 0);
    assert.deepEqual(events.flatMap((e) => (e.kind === "assistant" ? e.toolUses : [])), []);

    // ⓒ sentinel·다른 thread id가 직렬화에 없다
    const blob = JSON.stringify(events);
    for (const bad of ["HIJACK_TEXT_SENTINEL", "HIJACK_CMD_SENTINEL", "HIJACK_PATH_SENTINEL", TID2]) {
      assert.ok(!blob.includes(bad), `'${bad}'가 새어나갔다`);
    }

    // ⓓ 결과는 정확히 1건 · 실패 · 기대 UUID 유지 · 하이재킹된 usage/성공을 채택하지 않는다
    const r = resultsOf(events);
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, true);
    assert.equal(r[0].terminalReason, "session_identity_conflict");
    assert.equal(r[0].sessionId, TID, "결과 세션 신원은 기대 UUID다");
    assert.equal(r[0].numTurns, 0);
    assert.equal(r[0].usage.inputTokens, 0, "다른 thread의 usage를 계측에 넣지 않는다");
    assert.equal(r[0].text, "", "다른 thread의 본문이 결과 텍스트가 되지 않는다");

    // ⓔ 세션은 닫혔다 — 후속 send는 spawn 0
    assert.equal(await codeOfCall(() => h.provider.send(handle, "3차")), "codex_session_identity_conflict");
    assert.equal(h.calls.length, 2, "거부 이후 세 번째 프로세스는 없다");
  } finally {
    h.cleanup();
  }
});

test("[M5a] MCP 위반을 본 세션은 닫힌다 — resume으로 이어갈 수 없다(spawn 추가 0)", async () => {
  const h = await harness((c) =>
    c.finish(
      [
        `{"type":"thread.started","thread_id":"${TID}"}`,
        '{"type":"item.completed","item":{"id":"i","item_type":"mcp_tool_call","server":"s","tool":"t"}}',
        '{"type":"turn.completed","usage":{}}',
      ],
      0,
    ),
  );
  try {
    // ephemeral:false = 원래라면 resume이 가능한 세션. MCP 관측이 그 길을 닫는다.
    const spec = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
    const handle = await h.provider.start(spec, "1차");
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r[0].terminalReason, "mcp_call_observed");
    assert.equal(await codeOfCall(() => h.provider.send(handle, "2차")), "codex_mcp_observed");
    assert.equal(h.calls.length, 1, "오염된 thread를 다시 띄우지 않는다");
  } finally {
    h.cleanup();
  }
});

test("[M5a] 권한 실패는 permission_required로 올라온다(hang 없음)", async () => {
  const h = await harness((c) =>
    c.finish(
      [
        `{"type":"thread.started","thread_id":"${TID}"}`,
        '{"type":"turn.failed","error":{"message":"approval required in non-interactive mode"}}',
      ],
      1,
    ),
  );
  try {
    const handle = await h.provider.start(specFor(h.repo.root, h.home), "p");
    const r = resultsOf(await drain(h.provider.events(handle)));
    assert.equal(r.length, 1);
    assert.equal(r[0].stopReason, "permission_required");
    assert.equal(r[0].isError, true);
  } finally {
    h.cleanup();
  }
});

// ── 결정론적 fake CLI 실제 spawn ───────────────────────────────────────────

function scenario(repoRoot: string, runs: unknown[]): void {
  writeFileSync(join(repoRoot, ".fake-codex-scenario.json"), JSON.stringify({ runs }));
}
function invocations(repoRoot: string): { calls: Array<{ argv: string[]; cwd: string; stdin: string; envKeys: string[] }> } {
  return JSON.parse(readFileSync(join(repoRoot, ".fake-codex-invocation.json"), "utf8"));
}

test("[M5a] fake CLI 왕복: argv·cwd·stdin·격리 env가 계약대로 도착한다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    scenario(repo.root, [{ lines: OK_STREAM, exitCode: 0 }]);
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const handle = await provider.start(specFor(repo.root, home), "리뷰 프롬프트");
    const events = await drain(provider.events(handle));

    const r = resultsOf(events);
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, false);
    assert.equal(r[0].text, "done");

    const seen = invocations(repo.root).calls[0];
    // 실측 help 근거로 손으로 적은 기대 argv(구현을 구현과 비교하지 않는다).
    assert.deepEqual(seen.argv, [
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "--config",
      'model_reasoning_effort="xhigh"',
      "--config",
      "mcp_servers={}",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--cd",
      repo.root,
      "--ephemeral",
      "-",
    ]);
    assert.equal(seen.cwd, repo.root);
    assert.equal(seen.stdin, "리뷰 프롬프트");
    const injected = seen.envKeys.filter((k) => !["CODEX_HOME", "__CF_USER_TEXT_ENCODING"].includes(k));
    assert.deepEqual(injected, [], "CODEX_HOME 외 env는 상속되지 않는다(PATH 포함)");
    assert.ok(!seen.envKeys.includes("HOME") && !seen.envKeys.includes("PATH"));
    // 격리 홈은 여전히 비어 있다 — provider가 auth·설정을 쓰지 않았다.
    assert.ok(!existsSync(join(home, "config.toml")) && !existsSync(join(home, "auth.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 비정상 종료: stderr는 bounded·scrubbed 요약으로만 남는다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    scenario(repo.root, [{ lines: [], exitCode: 7, stderr: `codex: token=SUPERSECRET ${"z".repeat(2000)}` }]);
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const handle = await provider.start(specFor(repo.root, home), "p");
    const r = resultsOf(await drain(provider.events(handle)));
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, true);
    assert.equal(r[0].terminalReason, "exit_error");
    assert.ok(!r[0].text.includes("SUPERSECRET"));
    assert.ok(r[0].text.length < 600, "stderr 요약은 상한을 넘지 않는다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 중단(signal): 종료 결과 1건 · 실패", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    scenario(repo.root, [{ lines: OK_STREAM, selfSignal: "SIGKILL" }]);
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const handle = await provider.start(specFor(repo.root, home), "p");
    const r = resultsOf(await drain(provider.events(handle)));
    assert.equal(r.length, 1);
    assert.ok(r[0].isError);
    assert.equal(r[0].terminalReason, "signal");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 구조화 출력: --output-schema가 argv에 실리고 본문이 result.text다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  const schema = join(repo.root, "review.schema.json");
  try {
    writeFileSync(schema, JSON.stringify({ type: "object" }));
    scenario(repo.root, [
      {
        lines: [
          `{"type":"thread.started","thread_id":"${TID}"}`,
          '{"type":"item.completed","item":{"id":"i","item_type":"agent_message","text":"{\\"verdict\\":\\"pass\\"}"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
        ],
      },
    ]);
    const spec = specFor(repo.root, home, { codex: { codexHome: home, outputSchemaPath: schema } });
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const handle = await provider.start(spec, "p");
    const events = await drain(provider.events(handle));
    const seen = invocations(repo.root).calls[0];
    const at = seen.argv.indexOf("--output-schema");
    assert.ok(at > 0 && seen.argv[at + 1] === schema);
    const r = resultsOf(events);
    assert.deepEqual(JSON.parse(r[0].text), { verdict: "pass" });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 오염 스트림: malformed·과대 줄이 섞이면 프로토콜 실패 1건", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    scenario(repo.root, [
      {
        lines: [
          `{"type":"thread.started","thread_id":"${TID}"}`,
          "{broken json",
          `{"type":"item.completed","item":{"item_type":"agent_message","text":"${"y".repeat(70_000)}"}}`,
          '{"type":"unheard.of","x":1}',
          '{"type":"turn.completed","usage":{}}',
        ],
      },
    ]);
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const handle = await provider.start(specFor(repo.root, home), "p");
    const events = await drain(provider.events(handle));
    const kinds = events.filter((e) => e.kind === "unknown").map((e) => (e.kind === "unknown" ? e.type : ""));
    assert.ok(kinds.includes("malformed_line") && kinds.includes("unheard.of"));
    const r = resultsOf(events);
    assert.equal(r.length, 1);
    assert.equal(r[0].isError, true);
    assert.equal(r[0].terminalReason, "malformed_line", "첫 프로토콜 실패가 종료 사유다");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI 홈 수명: 1차가 홈에 세션 상태를 남기고 resume은 같은 소유 홈으로만 성공한다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    scenario(repo.root, [
      { lines: OK_STREAM },
      { lines: [`{"type":"thread.started","thread_id":"${TID}"}`, '{"type":"turn.completed","usage":{}}'] },
    ]);
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const spec = specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } });

    assert.deepEqual(readdirSync(home), [], "1차 전에는 홈이 비어 있다(ambient config·auth 0)");
    const handle = await provider.start(spec, "1차");
    const first = resultsOf(await drain(provider.events(handle)));
    assert.equal(first.length, 1);
    assert.equal(first[0].isError, false);

    // 실제 codex처럼 세션 상태가 홈 아래에 생겼다 — 이제 홈은 비어 있지 않다.
    assert.ok(readdirSync(home).length > 0, "1차가 홈에 상태를 남긴다");
    assert.ok(existsSync(join(home, "sessions", "2026", "07", "27", `rollout-${TID}.jsonl`)));
    assert.equal(lstatSync(home).mode & 0o077, 0, "홈 권한은 여전히 0700이다");
    assert.equal(
      await codeOfCall(() => assertIsolatedCodexHome(home)),
      "codex_home_not_empty",
      "소유권 없는 검증(=최초 검증)에게는 이 상태가 여전히 거부 대상이다",
    );

    // resume: 같은 소유 홈이므로 통과하고, 두 번째 프로세스가 실제로 뜬다.
    await provider.send(handle, "2차");
    const second = resultsOf(await drain(provider.events(handle)));
    assert.equal(second.length, 1);
    assert.equal(second[0].isError, false);

    const calls = invocations(repo.root).calls;
    assert.equal(calls.length, 2, "resume이 실제 프로세스로 이어졌다");
    assert.deepEqual(calls[1].argv.slice(0, 7), ["exec", "--sandbox", "read-only", "--cd", repo.root, "resume", TID]);
    // resume에서도 strict 격리 플래그는 그대로다(홈에 무엇이 생겨도 ambient 설정·MCP를 상속하지 않는다).
    for (const flag of ["--strict-config", "--ignore-user-config", "--ignore-rules", "--json"]) {
      assert.ok(calls[1].argv.includes(flag), `resume argv에 ${flag}가 없다`);
    }
    const at = calls[1].argv.indexOf("--config");
    assert.ok(calls[1].argv.includes("mcp_servers={}") && at > 0, "resume도 mcp_servers={}를 명시한다");
    assert.deepEqual(
      calls[1].envKeys.filter((k) => !["CODEX_HOME", "__CF_USER_TEXT_ENCODING"].includes(k)),
      [],
      "resume 자식도 CODEX_HOME 외 env를 상속하지 않는다",
    );
    assert.ok(!existsSync(join(home, "auth.json")), "provider는 auth를 쓰지 않는다(live 인증은 B-7)");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] fake CLI resume 왕복: 두 번째 invocation argv가 실측 배치를 따른다", async () => {
  const repo = await initRepo();
  const home = codexHome();
  try {
    scenario(repo.root, [
      { lines: OK_STREAM },
      { lines: [`{"type":"thread.started","thread_id":"${TID}"}`, '{"type":"turn.completed","usage":{}}'] },
    ]);
    const provider = codexProvider({
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      spawn: realFakeSpawn,
    });
    const spec = specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } });
    const handle = await provider.start(spec, "1차");
    await drain(provider.events(handle));
    await provider.send(handle, "2차");
    await drain(provider.events(handle));

    const calls = invocations(repo.root).calls;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].argv.slice(0, 7), ["exec", "--sandbox", "read-only", "--cd", repo.root, "resume", TID]);
    assert.ok(!calls[1].argv.slice(5).includes("--cd"), "resume 뒤에는 --cd가 없다");
    assert.ok(!calls[1].argv.includes("--ephemeral"));
    assert.equal(calls[1].stdin, "2차");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// ── invocation 소유권 · 상태 기계 (4차 리비전 · A/P1) ──────────────────────
//
// 타이밍 추측 없이 "claim 이후 · spawn 이전" 창을 여는 방법: **실행 경계의 비동기 git 조회를
// 결정론적으로 일시 정지**시킨다. 신뢰된 git 래퍼가 `arm` 파일이 있고 `release` 파일이 없는 동안
// 블록한 뒤 실제 git에 위임하므로, 테스트가 창을 원하는 만큼 열어 둘 수 있다.
// (provider에는 테스트 전용 비동기 hook을 **더하지 않았다** — 주입 표면 0.)

interface GateGit {
  path: string;
  arm(): void;
  release(): void;
  cleanup(): void;
}

function gateGit(): GateGit {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-gategit-")));
  const armFile = join(dir, "arm");
  const relFile = join(dir, "release");
  const script = join(dir, "git");
  // 자식은 PATH를 물려받지 않으므로 shebang은 현재 node의 **절대경로**다.
  // 확장자가 없어 CJS로 로드된다(tmpdir에 package.json이 없다).
  writeFileSync(
    script,
    [
      `#!${process.execPath}`,
      'const { existsSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const idle = new Int32Array(new SharedArrayBuffer(4));",
      `while (existsSync(${JSON.stringify(armFile)}) && !existsSync(${JSON.stringify(relFile)})) {`,
      "  Atomics.wait(idle, 0, 0, 5);",
      "}",
      `const r = spawnSync(${JSON.stringify(TRUSTED_GIT)}, process.argv.slice(2), { stdio: "inherit" });`,
      "process.exit(r.status === null || r.status === undefined ? 1 : r.status);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    path: script,
    arm: () => writeFileSync(armFile, ""),
    release: () => writeFileSync(relFile, ""),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 게이트된 git으로 resume 가능한 세션을 준비한다(spawn은 여전히 주입 seam이다). */
async function gatedHarness(): Promise<Harness & { gate: GateGit; spec: SessionSpec }> {
  const gate = gateGit();
  const h = await harness((c) => c.finish(OK_STREAM, 0), { gitExecutablePath: gate.path });
  const cleanup = h.cleanup;
  return {
    ...h,
    gate,
    spec: specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } }),
    cleanup: () => {
      cleanup();
      gate.cleanup();
    },
  };
}

test("[M5a] 겹친 send: 소유권 claim은 동기다 — 둘째는 spawn·큐·child 교체 없이 거부된다", async () => {
  const h = await gatedHarness();
  try {
    const handle = await h.provider.start(h.spec, "1차");
    assert.equal(resultsOf(await drain(h.provider.events(handle))).length, 1);
    assert.equal(h.calls.length, 1);

    h.gate.arm();
    const owner = h.provider.send(handle, "2차"); // 동기 prefix에서 claim → 경계 git에서 정지
    const loser = h.provider.send(handle, "3차"); // 겹침 — 동기로 거부된다
    assert.equal(await codeOfCall(() => loser), "codex_send_overlap");
    assert.equal(h.calls.length, 1, "겹친 send가 프로세스를 띄웠다");

    h.gate.release();
    await owner;
    assert.equal(h.calls.length, 2, "소유자 하나만 spawn한다(중복 resume 없음)");
    assert.equal(h.calls[1].stdin, "2차", "패자의 프롬프트로 spawn했다");
    assert.deepEqual(h.calls[1].args.slice(0, 7), ["exec", "--sandbox", "read-only", "--cd", h.repo.root, "resume", TID]);
    assert.equal(resultsOf(await drain(h.provider.events(handle))).length, 1, "스트림이 교차하거나 결과가 두 번 나왔다");
  } finally {
    h.cleanup();
  }
});

test("[M5a] stop은 child 없는 claim도 취소한다 — release 후에도 spawn 0, 세션 되살아나지 않음", async () => {
  const h = await gatedHarness();
  try {
    const handle = await h.provider.start(h.spec, "1차");
    await drain(h.provider.events(handle));
    assert.equal(h.calls.length, 1);

    h.gate.arm();
    const pending = h.provider.send(handle, "2차"); // claim만 된 상태(child 없음)
    await h.provider.stop(handle, "취소");
    h.gate.release();

    assert.equal(await codeOfCall(() => pending), "codex_invocation_cancelled");
    assert.equal(h.calls.length, 1, "취소된 claim이 프로세스를 띄웠다");
    assert.equal(await codeOfCall(() => h.provider.events(handle)), "codex_unknown_session", "세션이 되살아났다");
    assert.equal(await codeOfCall(() => h.provider.send(handle, "3차")), "codex_unknown_session");
    await h.provider.stop(handle, "멱등"); // 두 번째 stop은 조용히 통과한다
    assert.equal(h.calls.length, 1);
  } finally {
    h.cleanup();
  }
});

test("[M5a] start 진행 중 send는 spawn 없이 거부된다(claim이 첫 await 전에 잡힌다)", async () => {
  const h = await gatedHarness();
  try {
    h.gate.arm();
    const starting = h.provider.start(h.spec, "1차");
    assert.equal(await codeOfCall(() => h.provider.send({ sessionId: "s1", spec: h.spec }, "겹침")), "codex_send_overlap");
    assert.equal(h.calls.length, 0, "start가 아직 spawn 전인데 send가 프로세스를 띄웠다");
    h.gate.release();
    const handle = await starting;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].stdin, "1차");
    assert.equal(resultsOf(await drain(h.provider.events(handle))).length, 1);
  } finally {
    h.cleanup();
  }
});

test("[M5a] stop 뒤 교체 세션: 취소된 invocation의 정리가 교체본을 지우거나 바꾸지 못한다", async () => {
  const h = await gatedHarness();
  try {
    h.gate.arm();
    const stale = h.provider.start(h.spec, "낡은 start"); // claim 후 경계에서 정지
    await h.provider.stop({ sessionId: "s1", spec: h.spec }, "취소");
    // 같은 harness 세션 id로 **새 generation**을 만든다(낡은 것은 아직 살아 있다).
    const fresh = specFor(h.repo.root, h.home, { codex: { codexHome: h.home, ephemeral: false } });
    const replacement = h.provider.start(fresh, "교체 세션");
    h.gate.release();

    assert.equal(await codeOfCall(() => stale), "codex_invocation_cancelled");
    const handle = await replacement;
    assert.equal(h.calls.length, 1, "취소된 start는 spawn 0이고 교체 세션만 뜬다");
    assert.equal(h.calls[0].stdin, "교체 세션");
    assert.equal(resultsOf(await drain(h.provider.events(handle))).length, 1, "교체 세션의 큐가 살아 있다");
    // 교체 세션은 여전히 정상 동작한다(낡은 정리가 상태를 망가뜨리지 않았다).
    await h.provider.send(handle, "교체 세션 2차");
    assert.equal(h.calls.length, 2);
    assert.equal(resultsOf(await drain(h.provider.events(handle))).length, 1);
  } finally {
    h.cleanup();
  }
});

// ── turn 사이 spec/opts 드리프트 (재개된 C-23) ─────────────────────────────

interface DriftOpts {
  executablePath: string;
  gitExecutablePath: string;
}

/**
 * 1차 turn을 완료시킨 뒤 **`send` 전에** spec/opts를 바꾸고, 그 값이 새 baseline이 되지 않음을 본다.
 * `mutate`는 되돌리는 함수를 반환한다 — 되돌리면 다시 정상 동작해야 한다(claim 누수 없음).
 */
async function betweenTurnDrift(
  mutate: (spec: SessionSpec, opts: DriftOpts) => () => void,
): Promise<{ code: string; atFail: number; leaked: number; recovered: number; total: number }> {
  const repo = await initRepo();
  const home = codexHome();
  const calls: FakeCall[] = [];
  try {
    const spec = specFor(repo.root, home, { codex: { codexHome: home, ephemeral: false } });
    // provider가 들고 있는 **바로 그 opts 객체**를 변조 대상으로 쓴다.
    const opts = {
      manifest: manifest(repo.head),
      controllerRepoRoot: repo.root,
      executablePath: TRUSTED_BIN,
      gitExecutablePath: TRUSTED_GIT,
      spawn: fakeSpawn(calls, (c) => c.finish(OK_STREAM, 0)),
    };
    const provider = new CodexCliProvider(opts);
    const handle = await provider.start(spec, "1차");
    assert.equal(resultsOf(await drain(provider.events(handle))).length, 1, "1차 turn이 완료되지 않았다");

    const revert = mutate(spec, opts);
    const code = await codeOfCall(() => provider.send(handle, "2차"));
    const atFail = calls.length;
    // 이전 완료 큐가 교체됐다면 여기서 가짜 종료 결과가 나온다(0이어야 한다).
    const leaked = (await drain(provider.events(handle))).length;

    revert();
    await provider.send(handle, "2차(정상)");
    const recovered = resultsOf(await drain(provider.events(handle))).length;
    return { code, atFail, leaked, recovered, total: calls.length };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
}

test("[M5a] C-23: turn 사이 spec/opts 변조는 새 baseline이 되지 못한다(봉인값 대조)", async () => {
  const cases: Array<[string, (s: SessionSpec, o: DriftOpts) => () => void, string]> = [
    [
      "model",
      (s) => {
        const prev = s.model;
        s.model = "evil-model";
        return () => {
          s.model = prev;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "outputSchema",
      (s) => {
        s.codex!.outputSchemaPath = "/tmp/evil-schema.json";
        return () => {
          delete s.codex!.outputSchemaPath;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "cwd",
      (s) => {
        const prev = s.cwd;
        s.cwd = "/private/tmp";
        return () => {
          s.cwd = prev;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "codexHome",
      (s) => {
        const prev = s.codex!.codexHome;
        s.codex!.codexHome = "/private/tmp";
        return () => {
          s.codex!.codexHome = prev;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "ephemeral",
      (s) => {
        s.codex!.ephemeral = true;
        return () => {
          s.codex!.ephemeral = false;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "sessionId",
      (s) => {
        const prev = s.sessionId;
        s.sessionId = "다른-세션";
        return () => {
          s.sessionId = prev;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "codexBinaryPath",
      (_s, o) => {
        const prev = o.executablePath;
        o.executablePath = "/private/tmp";
        return () => {
          o.executablePath = prev;
        };
      },
      "codex_spec_mutated",
    ],
    [
      "gitExecutablePath",
      (_s, o) => {
        const prev = o.gitExecutablePath;
        o.gitExecutablePath = "/private/tmp";
        return () => {
          o.gitExecutablePath = prev;
        };
      },
      "codex_spec_mutated",
    ],
    // 계약 자체를 어기는 변조는 재해석 단계에서 먼저 걸린다(둘 다 fail closed).
    [
      "sandbox",
      (s) => {
        s.codex!.sandbox = "workspace-write" as never;
        return () => {
          s.codex!.sandbox = "read-only";
        };
      },
      "codex_sandbox_forbidden",
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const r = await betweenTurnDrift(mutate);
    assert.equal(r.code, expected, label);
    assert.equal(r.atFail, 1, `${label}: 변조된 값으로 두 번째 프로세스가 떴다`);
    assert.equal(r.leaked, 0, `${label}: 이전 완료 큐가 교체됐다`);
    assert.equal(r.recovered, 1, `${label}: 되돌린 뒤 정상 turn이 돌지 않았다(claim 누수)`);
    assert.equal(r.total, 2, `${label}: spawn 총계가 1차 + 복구 turn 2건이 아니다`);
  }
});
