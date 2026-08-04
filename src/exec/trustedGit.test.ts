/**
 * V3 M5c task 3D — **trusted Git** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/trustedGit.test.ts`
 *
 * 띄우는 프로세스는 전부 **임시 디렉터리 안의 throwaway git 저장소**를 향한다 — 이 저장소도, 사용자
 * 환경도 건드리지 않는다. 네트워크·remote·LLM·provider·설치는 0이다.
 *
 * 덮는 계약:
 * - **닫힌 allow-list**: 호출자가 고를 수 있는 것은 enum 3개뿐이고 그 밖은 `git_query_unsupported`다.
 *   push/fetch/pull/remote/commit/merge/rebase 계열은 **표현할 필드가 없다**(hard deny 구조적 폐쇄).
 * - **argv-only**: 실제로 exec된 argv를 파일로 관측해 동결 상수와 정확히 같음을 단정한다(shell 0 · 보간 0).
 * - **1회 소비**: 권능 identity는 객체 참조이고(전개 사본·수제 객체는 조회에서 죽는다) 재생은
 *   `git_capability_spent`다.
 * - **발급자 신원**: 다른 kernel 인스턴스는 같은 workspace라도 그 권능을 소비하지 못한다.
 * - **durable 재독**: 권능 발급 이후 task가 running을 벗어나거나 attempt가 바뀌면 거부된다.
 * - **A4 mark-then-re-verify**: 소진(mark)이 효과보다 먼저이고, 소진 이후 권위를 다시 전수 확인한 뒤에만
 *   spawn한다 — 그래서 소진 이후 거부는 **spawn 0**이다.
 * - **spawn 직전 바이너리 재검증**: 승인 이후 내용이 바뀐 git은 `git_digest_mismatch`, 신뢰 조건을 잃은
 *   git은 `git_executable_untrusted`이며 둘 다 spawn 0이다.
 * - **저장소 신원**: 승인된 저장소 **루트 그 자체**여야 한다 — 상위 repo의 하위 디렉터리 · symlink 경로 ·
 *   저장소 아닌 디렉터리는 전부 `git_repo_identity_mismatch`다.
 * - **결과를 지어내지 않는다**: 닫힌 판정표 밖의 종료 코드는 `git_result_unknown`이다.
 * - **자손 0**: 모든 spawn 이후 이 프로세스의 자식이 남지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationError, REQUIRED_BODY_HEADINGS, type AgentMessageType } from "./orchestrationTypes.js";
import {
  OrchestrationKernel,
  TRUSTED_GIT_CODES,
  TRUSTED_GIT_QUERIES,
  executeTrustedGitQuery,
  isGenuineTrustedGitCapability,
  type PreflightDecision,
  type TaskSeed,
  type TrustedGitCapability,
} from "./orchestrationKernel.js";

const RUN_ID = "run-1";
const MILESTONE = "m5c";
const T0 = Date.UTC(2026, 6, 30, 0, 0, 0);
const EXPIRES = "2026-12-31T00:00:00.000Z";

/** 이 환경의 진짜 git. fixture "git"은 이것을 exec하는 얇은 wrapper다(해싱·교체가 가능해야 한다). */
const REAL_GIT = realpathSync(execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"]).toString().trim());

/** argv 로그의 블록 구분자. **argv에 나타날 수 없는 토큰**이어야 한다(`--`는 실제 argv 원소다). */
const SEP = "#ARGV-BLOCK-END#";

const tmpRoots: string[] = [];
function makeDir(prefix: string): string {
  // macOS의 `/var/folders/...`는 symlink 뒤에 있다 — 승인 경로는 **정규 경로**여야 한다.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과를 바꾸지 않는다 */
    }
  }
});

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExecutable(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
  return "no-error";
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
  return "no-error";
}

/**
 * **이 프로세스의 살아 있는 자식이 하나도 없는가.** `superviseProcess`가 프로세스 그룹이 빈 것을
 * 관측했을 때만 결과를 돌려주므로 이것은 독립적인 2차 관측이다(고정 sleep 없이 `ps` 한 번).
 */
function liveChildren(): string[] {
  const out = execFileSync("/bin/ps", ["-o", "pid=,ppid=,comm=", "-A"]).toString();
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 3 && Number(c[1]) === process.pid && !/(^|\/)ps$/.test(c[2]!))
    .map((c) => c[0]!);
}
/** spawn 이전 기준선(테스트 러너 자신의 helper 자식). 이 밖에 남는 것이 **우리가 만든 고아**다. */
const BASELINE_CHILDREN = new Set(liveChildren());

function assertNoSurvivors(what: string): void {
  const extra = liveChildren().filter((pid) => !BASELINE_CHILDREN.has(pid));
  assert.deepEqual(extra, [], `${what}: 살아남은 자손 pid ${extra.join(",")}`);
}

function body(type: AgentMessageType): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

let counter = 0;
const nextId = (prefix: string): string => `${prefix}.${++counter}`;

function seed(taskId: string): TaskSeed {
  return {
    taskId,
    roleId: "tech-lead",
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: ["docs"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
  };
}

interface Fixture {
  ws: string;
  gitPath: string;
  argvLog: string;
  kernel: OrchestrationKernel;
  manifest: Record<string, unknown>;
  /** exec된 argv를 순서대로 읽는다(호출 1건 = 한 블록). */
  argv(): string[][];
  /** 저장소에 커밋 하나를 만든다(테스트 fixture 조작 — 집행 경계 밖이다). */
  commit(): void;
  git(...args: string[]): void;
}

function manifestFor(gitPath: string, taskIds: string[]): Record<string, unknown> {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs"],
    ownershipByTask: Object.fromEntries(taskIds.map((id) => [id, ["docs"]])),
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
      git: { path: gitPath, sha256: sha256File(gitPath) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 600_000,
      maxAttemptElapsedMs: 3_000_000,
      cleanupTermGraceMs: 2_000,
      cleanupKillGraceMs: 2_000,
    },
    operationAuthorityByTask: {},
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: EXPIRES,
  };
}

/**
 * 진짜 kernel run 하나 + **실재하는 throwaway git 저장소**(workspaceRoot 그 자체가 저장소 루트다) +
 * 승인된 "git"(argv를 기록하고 진짜 git을 exec하는 wrapper).
 */
function fixture(opts: { wrapperBody?: (real: string, log: string) => string; start?: boolean } = {}): Fixture {
  const ws = makeDir("m5c-tg-ws-");
  mkdirSync(join(ws, "docs"));
  const bin = makeDir("m5c-tg-bin-");
  const argvLog = join(bin, "argv.log");
  writeFileSync(argvLog, "");
  const mkBody = opts.wrapperBody ?? ((real, log) => `#!/bin/sh\nprintf '%s\\n' "$@" >> ${log}\nprintf '%s\\n' '${SEP}' >> ${log}\nexec ${real} "$@"\n`);
  const gitPath = writeExecutable(join(bin, "git"), mkBody(REAL_GIT, argvLog));

  const git = (...args: string[]): void => {
    execFileSync(REAL_GIT, ["-C", ws, ...args], { stdio: "ignore" });
  };
  git("init", "-q");

  const manifest = manifestFor(gitPath, ["root"]);
  let n = 0;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest,
    clock: () => new Date(T0 + n++),
  });
  kernel.createRootTask(seed("root"));
  if (opts.start !== false) {
    const batch = kernel.planRunnableBatch();
    const decisions: PreflightDecision[] = batch.items.map((t) => ({
      taskId: t.taskId,
      outcome: "prepared" as const,
      attemptId: nextId("att"),
    }));
    kernel.commitPreflightBatch({ baseRevision: batch.revision, actionId: nextId("act"), decisions });
    kernel.startPreparedTask({
      taskId: "root",
      actionId: nextId("act"),
      leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
    });
  }

  return {
    ws,
    gitPath,
    argvLog,
    kernel,
    manifest,
    git,
    argv: () =>
      readFileSync(argvLog, "utf8")
        .split(`${SEP}\n`)
        .filter((b) => b.length > 0)
        .map((b) => b.split("\n").filter((l) => l.length > 0)),
    commit: () => {
      writeFileSync(join(ws, "docs", "a.md"), "v1\n");
      git("add", "docs/a.md");
      git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c1");
    },
  };
}

const capFor = (f: Fixture, query: (typeof TRUSTED_GIT_QUERIES)[number], taskId = "root"): TrustedGitCapability =>
  f.kernel.resolveTrustedGitCapability({ taskId, query });

// ── 닫힌 집합 ────────────────────────────────────────────────────────────────

test("[3D] 허용된 git 질의는 정확히 3개이고 그 밖은 발급 단계에서 거부된다(hard deny는 표현 불가다)", () => {
  assert.deepEqual([...TRUSTED_GIT_QUERIES], ["repo_has_head", "worktree_tracked_clean", "index_clean"]);
  const f = fixture();
  // 원격 쓰기·PR/merge·배포 계열은 **이름조차 받아들여지지 않는다**.
  for (const bad of [
    "push",
    "fetch",
    "pull",
    "remote",
    "clone",
    "submodule",
    "merge",
    "rebase",
    "reset",
    "commit",
    "tag",
    "worktree",
    "__proto__",
    "toString",
    "",
  ]) {
    assert.equal(
      codeOf(() => f.kernel.resolveTrustedGitCapability({ taskId: "root", query: bad as never })),
      "git_query_unsupported",
      bad,
    );
  }
  assert.equal(codeOf(() => f.kernel.resolveTrustedGitCapability({ taskId: "root", query: undefined as never })), "git_query_unsupported");
  assert.equal(f.argv().length, 0, "거부는 spawn을 만들지 않는다");
});

test("[3D] 오류 코드 집합이 닫혀 있다", () => {
  assert.equal(new Set(TRUSTED_GIT_CODES).size, TRUSTED_GIT_CODES.length);
  for (const c of TRUSTED_GIT_CODES) assert.ok(c.startsWith("git_"), c);
});

// ── argv-only ────────────────────────────────────────────────────────────────

test("[3D] exec된 argv는 동결 상수 그대로다 — 호출자 문자열도 shell도 보간도 없다", async () => {
  const f = fixture();
  f.commit();
  await executeTrustedGitQuery(capFor(f, "repo_has_head"));
  await executeTrustedGitQuery(capFor(f, "worktree_tracked_clean"));
  await executeTrustedGitQuery(capFor(f, "index_clean"));
  const prefix = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "--no-optional-locks", "--no-pager"];
  assert.deepEqual(f.argv(), [
    [...prefix, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    [...prefix, "diff", "--no-ext-diff", "--no-textconv", "--quiet", "HEAD", "--"],
    [...prefix, "diff", "--no-ext-diff", "--no-textconv", "--quiet", "--cached", "HEAD", "--"],
  ]);
  // 어떤 argv에도 원격·네트워크·변경 계열 토큰이 없다.
  const flat = f.argv().flat();
  // 변경·원격 계열 subcommand는 **argv 원소로** 나타나지 않는다(`HEAD^{commit}`은 revspec이지 subcommand가 아니다).
  for (const deny of ["push", "fetch", "pull", "remote", "clone", "submodule", "merge", "rebase", "reset", "commit", "tag"]) {
    assert.equal(flat.includes(deny), false, deny);
  }
  // URL·원격 이름이 들어갈 자리 자체가 없다.
  for (const deny of ["://", "origin", "@"]) {
    assert.equal(flat.join(" ").includes(deny), false, deny);
  }
  assertNoSurvivors("argv");
});

// ── 판정 ─────────────────────────────────────────────────────────────────────

test("[3D] 닫힌 판정표가 종료 코드를 답으로 바꾼다(unborn HEAD → 커밋 → 변경 → staged)", async () => {
  const f = fixture();
  assert.deepEqual({ ...(await executeTrustedGitQuery(capFor(f, "repo_has_head"))) }, {
    query: "repo_has_head",
    verdict: false,
    exitCode: 1,
  });
  f.commit();
  assert.equal((await executeTrustedGitQuery(capFor(f, "repo_has_head"))).verdict, true);
  assert.equal((await executeTrustedGitQuery(capFor(f, "worktree_tracked_clean"))).verdict, true);
  assert.equal((await executeTrustedGitQuery(capFor(f, "index_clean"))).verdict, true);
  writeFileSync(join(f.ws, "docs", "a.md"), "v2\n");
  assert.equal((await executeTrustedGitQuery(capFor(f, "worktree_tracked_clean"))).verdict, false);
  assert.equal((await executeTrustedGitQuery(capFor(f, "index_clean"))).verdict, true);
  f.git("add", "docs/a.md");
  assert.equal((await executeTrustedGitQuery(capFor(f, "index_clean"))).verdict, false);
  assertNoSurvivors("verdicts");
});

test("[3D] 판정표 밖의 종료 코드는 성공이 아니다(`git_result_unknown`) — 결과를 지어내지 않는다", async () => {
  const f = fixture({ wrapperBody: () => "#!/bin/sh\nexit 42\n" });
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(capFor(f, "repo_has_head"))), "git_result_unknown");
  assertNoSurvivors("unknown-exit");
});

// ── 권능 identity · 1회 소비 · 발급자 ────────────────────────────────────────

test("[3D] 권능은 객체 참조 그 자체이고 정확히 한 번만 소비된다", async () => {
  const f = fixture();
  f.commit();
  const cap = capFor(f, "repo_has_head");
  assert.equal(isGenuineTrustedGitCapability(cap), true);

  // 전개 사본 · 수제 객체 · Proxy · JSON 왕복 — 전부 조회에서 죽는다.
  assert.equal(isGenuineTrustedGitCapability({ ...cap }), false);
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery({ ...cap })), "git_capability_invalid");
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(JSON.parse(JSON.stringify(cap)))), "git_capability_invalid");
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(new Proxy(cap, {}))), "git_capability_invalid");
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(Object.create(cap))), "git_capability_invalid");
  assert.equal(
    await codeOfAsync(() =>
      executeTrustedGitQuery({ runId: RUN_ID, taskId: "root", attemptId: "att.1", query: "repo_has_head" }),
    ),
    "git_capability_invalid",
  );
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(null)), "git_capability_invalid");
  assert.equal(f.argv().length, 0, "위조는 spawn 0이다");

  assert.equal((await executeTrustedGitQuery(cap)).verdict, true);
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_capability_spent");
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_capability_spent");
  assert.equal(f.argv().length, 1, "1 권능 = 최대 1 spawn");
  assertNoSurvivors("single-consumption");
});

test("[3D] 다른 kernel 인스턴스는 같은 workspace라도 남의 권능을 소비하지 못한다", async () => {
  const f = fixture();
  f.commit();
  const cap = capFor(f, "repo_has_head");
  // 같은 durable run을 두 번째 인스턴스로 연다 — durable ID가 같아도 발급자는 남이다.
  let n = 10_000;
  const second = OrchestrationKernel.open({ workspaceRoot: f.ws, runId: RUN_ID, clock: () => new Date(T0 + n++) });
  assert.equal(second.getTask("root")!.state, "running");
  assert.equal(isGenuineTrustedGitCapability(cap), true);
  // 첫 인스턴스에서 소비하면 두 번째에서도 재생되지 않는다(등록부는 발급자별로 갈라져 있다).
  assert.equal((await executeTrustedGitQuery(cap)).verdict, true);
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_capability_spent");
  // 두 번째 인스턴스가 발급한 권능은 자기 것으로만 동작한다.
  const own = second.resolveTrustedGitCapability({ taskId: "root", query: "repo_has_head" });
  assert.equal((await executeTrustedGitQuery(own)).verdict, true);
  assertNoSurvivors("issuer");
});

// ── durable 재독 ─────────────────────────────────────────────────────────────

test("[3D] 권능 발급 이후 durable 상태가 바뀌면 소비되지 않는다(재독 · spawn 0)", async () => {
  const f = fixture();
  f.commit();
  const cap = capFor(f, "repo_has_head");
  const before = f.argv().length;
  // running을 벗어난다(정상 lifecycle: recordTerminal → cleaning).
  f.kernel.recordTerminal({
    taskId: "root",
    actionId: nextId("act"),
    marker: "turn_completed",
    pendingResult: { summary: "ok", outputs: [] },
  });
  assert.notEqual(f.kernel.getTask("root")!.state, "running");
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_task_not_running");
  assert.equal(f.argv().length, before, "거부는 spawn 0이다");
  // 그리고 애초에 발급되지도 않는다.
  assert.equal(codeOf(() => capFor(f, "repo_has_head")), "git_task_not_running");
  assertNoSurvivors("stale-lifecycle");
});

test("[3D] running이 아닌 task와 미상 task는 권능을 받지 못한다", () => {
  const f = fixture({ start: false });
  assert.equal(f.kernel.getTask("root")!.state, "ready");
  assert.equal(codeOf(() => capFor(f, "repo_has_head")), "git_task_not_running");
  assert.equal(codeOf(() => capFor(f, "repo_has_head", "nope")), "unknown_task");
});

// ── spawn 직전 바이너리 재검증 ───────────────────────────────────────────────

test("[3D] 승인 이후 내용이 바뀐 git은 spawn 직전에 멈춘다(`git_digest_mismatch` · spawn 0)", async () => {
  const f = fixture();
  f.commit();
  const cap = capFor(f, "repo_has_head");
  // 권능 발급과 spawn 사이에 **파일 내용만** 바꾼다(durable manifest는 그대로다).
  writeExecutable(f.gitPath, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${f.argvLog}\nprintf '%s\\n' '${SEP}' >> ${f.argvLog}\nexit 0\n`);
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_digest_mismatch");
  assert.equal(f.argv().length, 0, "digest 불일치는 spawn 0이다");
  assertNoSurvivors("digest");
});

test("[3D] 신뢰 조건을 잃은 git은 `git_executable_untrusted`다(부재 · 타인 쓰기 · symlink)", async () => {
  for (const [what, mutate] of [
    ["부재", (f: Fixture) => rmSync(f.gitPath)],
    ["타인 쓰기", (f: Fixture) => chmodSync(f.gitPath, 0o777)],
  ] as const) {
    const f = fixture();
    f.commit();
    const cap = capFor(f, "repo_has_head");
    mutate(f);
    assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_executable_untrusted", what);
    assert.equal(f.argv().length, 0, `${what}: spawn 0`);
  }
  // symlink는 승인 경로가 될 수 없다(정규 경로 요구) — 발급 자체가 거부된다.
  const f = fixture();
  const link = join(makeDir("m5c-tg-link-"), "git");
  symlinkSync(f.gitPath, link);
  const m = manifestFor(f.gitPath, ["root"]) as { executionAuthority: { git: { path: string; sha256: string } } };
  m.executionAuthority.git = { path: link, sha256: sha256File(f.gitPath) };
  let n = 0;
  const ws2 = makeDir("m5c-tg-ws2-");
  execFileSync(REAL_GIT, ["-C", ws2, "init", "-q"]);
  const k = OrchestrationKernel.create({
    workspaceRoot: ws2,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: m as unknown as Record<string, unknown>,
    clock: () => new Date(T0 + n++),
  });
  k.createRootTask(seed("root"));
  const batch = k.planRunnableBatch();
  k.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: nextId("att") })),
  });
  k.startPreparedTask({
    taskId: "root",
    actionId: nextId("act"),
    leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
  });
  const cap = k.resolveTrustedGitCapability({ taskId: "root", query: "repo_has_head" });
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_executable_untrusted");
  assertNoSurvivors("untrusted");
});

// ── 저장소 신원 ──────────────────────────────────────────────────────────────

test("[3D] 대상은 승인된 저장소 **루트 그 자체**여야 한다(상위 repo의 하위 디렉터리 거부)", () => {
  const parent = makeDir("m5c-tg-parent-");
  execFileSync(REAL_GIT, ["-C", parent, "init", "-q"]);
  const child = join(parent, "sub");
  mkdirSync(child);
  const bin = makeDir("m5c-tg-bin2-");
  const gitPath = writeExecutable(join(bin, "git"), `#!/bin/sh\nexec ${REAL_GIT} "$@"\n`);
  let n = 0;
  const k = OrchestrationKernel.create({
    workspaceRoot: child,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(gitPath, ["root"]),
    clock: () => new Date(T0 + n++),
  });
  k.createRootTask(seed("root"));
  const batch = k.planRunnableBatch();
  k.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: nextId("att") })),
  });
  k.startPreparedTask({
    taskId: "root",
    actionId: nextId("act"),
    leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
  });
  // 상위 저장소의 하위 디렉터리 — git이라면 상위 repo를 봤을 것이다. 여기서는 발급이 거부된다.
  assert.equal(
    codeOf(() => k.resolveTrustedGitCapability({ taskId: "root", query: "repo_has_head" })),
    "git_repo_identity_mismatch",
  );
});

test("[3D] 저장소가 아닌 디렉터리와 symlink 경로도 거부된다", () => {
  const bare = makeDir("m5c-tg-bare-");
  const bin = makeDir("m5c-tg-bin3-");
  const gitPath = writeExecutable(join(bin, "git"), `#!/bin/sh\nexec ${REAL_GIT} "$@"\n`);
  const boot = (wsPath: string): OrchestrationKernel => {
    let n = 0;
    const k = OrchestrationKernel.create({
      workspaceRoot: wsPath,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      manifest: manifestFor(gitPath, ["root"]),
      clock: () => new Date(T0 + n++),
    });
    k.createRootTask(seed("root"));
    const batch = k.planRunnableBatch();
    k.commitPreflightBatch({
      baseRevision: batch.revision,
      actionId: nextId("act"),
      decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: nextId("att") })),
    });
    k.startPreparedTask({
      taskId: "root",
      actionId: nextId("act"),
      leaseMarker: `lease.${(++counter).toString(16).padStart(32, "0")}`,
    });
    return k;
  };
  assert.equal(
    codeOf(() => boot(bare).resolveTrustedGitCapability({ taskId: "root", query: "repo_has_head" })),
    "git_repo_identity_mismatch",
  );

  const real = makeDir("m5c-tg-real-");
  execFileSync(REAL_GIT, ["-C", real, "init", "-q"]);
  const link = join(makeDir("m5c-tg-linkws-"), "ws");
  symlinkSync(real, link);
  assert.equal(
    codeOf(() => boot(link).resolveTrustedGitCapability({ taskId: "root", query: "repo_has_head" })),
    "git_repo_identity_mismatch",
  );
});

test("[3D] 저장소 신원은 spawn 직전에 **다시** 확인된다(발급 이후 .git이 사라지면 spawn 0)", async () => {
  const f = fixture();
  f.commit();
  const cap = capFor(f, "repo_has_head");
  rmSync(join(f.ws, ".git"), { recursive: true, force: true });
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_repo_identity_mismatch");
  assert.equal(f.argv().length, 0, "저장소 신원 실패는 spawn 0이다");
  // 소진(mark)은 효과보다 먼저다 — 거부돼도 그 권능은 되살아나지 않는다(A4).
  assert.equal(await codeOfAsync(() => executeTrustedGitQuery(cap)), "git_capability_spent");
  assertNoSurvivors("repo-recheck");
});

// ── 취소 ─────────────────────────────────────────────────────────────────────

test("[3D] 취소는 판정을 만들지 않는다(`git_deadline_exceeded`) — 자손 0", async () => {
  // 관측 배리어: wrapper가 시작을 파일로 알린 뒤에 매달린다(고정 sleep로 경합하지 않는다).
  const f = fixture({
    wrapperBody: (_real, log) => `#!/bin/sh\nprintf 'started\\n%s\\n' '${SEP}' >> ${log}\nwhile :; do sleep 1; done\n`,
  });
  const ac = new AbortController();
  const done = executeTrustedGitQuery(capFor(f, "repo_has_head"), { signal: ac.signal });
  for (;;) {
    if (f.argv().length > 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  ac.abort();
  assert.equal(await codeOfAsync(() => done), "git_deadline_exceeded");
  assertNoSurvivors("cancel");
});
