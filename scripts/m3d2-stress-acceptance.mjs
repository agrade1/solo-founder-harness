#!/usr/bin/env node
/**
 * [M3d.2 STRESS ACCEPTANCE RUNNER — 부하 조건 하 `npm test` 1회 직렬 실행]
 *
 * 목적: M3d 완료 기준의 "known CPU 부하 조건 포함 별도 stress 결과 기록"을 재현 가능하게 만든다.
 *   - 설정된 부하 worker **전부**가 실제로 spawn되고 `npm test`가 닫힐 때까지 **살아 있어야** 한다.
 *     spawn 실패·정리 전 조기 종료·정리 전 error는 모두 실패다(부하 없는 PASS 금지).
 *   - 부하 firm deadline은 `npm test` wall-clock 상한보다 **반드시 크다**(부하가 suite 전 구간을 덮는다).
 *   - 종료는 **비동기 idempotent shutdown 상태 기계** 하나로만 한다: 소유한 npm 프로세스 그룹과 부하
 *     worker만 종료 → 사라진 것을 bounded 확인 → 그 **뒤에** lock 해제 → exit.
 *     normal / timeout / error / SIGINT / SIGTERM 전 경로에 같은 기계를 쓴다. 확인 실패는 실패다.
 *   - **정리 확인에 실패하면 lock을 해제하지 않는다**(Codex Sol xhigh P1-1). 소유 worker·그룹·자손이 남아
 *     있을 수 있는 상태에서 lock을 노출하면 다음 suite가 그 잔재를 관측해 거짓 실패한다. 해제 대신 lock을
 *     **격리(quarantine)** 표시해 다른 suite가 이어받지 못하게 하고(fail closed) 즉시 종료한다.
 *
 * 동시성 계약(M3d.1 실측 반영):
 *   - 전역 프로세스/tmp 상태를 관측하는 테스트가 있으므로 **다른 full suite와 절대 동시 실행하지 않는다.**
 *   - 일반 `npm test`와 이 runner는 **같은 배타 lock 하나**(scripts/lib/suite-exclusive-lock.mjs)를 지난다.
 *     이 runner가 띄우는 자기 소유 `npm test` child만 추측 불가능한 ownership token으로 재진입한다.
 *   - 재진입한 wrapper는 자기 child를 **새 프로세스 그룹으로 분리하지 않으므로**(P1-4) suite의 모든 자손이
 *     이 runner가 소유한 pgid에 남는다 → 아래 그룹 kill과 자손 스캔이 전 자손을 덮는다.
 *   - 소유 그룹 유예(SUITE_STOP_GRACE_MS)는 재진입 wrapper의 bounded shutdown 예산보다 **길다**.
 *     상위가 KILL로 넘어가기 전에 하위가 자기 확인을 끝낼 수 있어야 두 계층이 충돌하지 않는다.
 *   - `ps` 후보 스캔은 lock을 우회한 suite를 잡는 backstop이며 확인 실패는 거부(fail-closed)다.
 *   - 부하 worker는 순수 CPU 루프이며 저장소·tmp·전역 상태를 관측하거나 변경하지 않는다.
 *
 * 실행: npm run acceptance:stress:m3d2
 *   - 이 runner는 `npm test`에 연결되어 있지 않다(수동 실행 전용). live runner도 실행하지 않는다.
 *   - 정상 3회 반복(`npm test` 연속 3회)은 이 runner와 별개로 직렬 실행한다.
 *
 * 설정(production, 모두 bounded, 미지정 시 기본값):
 *   HARNESS_STRESS_WORKERS         부하 worker 수 (기본 min(4, max(1, floor(cpus/2))), 1..8)
 *   HARNESS_STRESS_TEST_TIMEOUT_MS `npm test` wall-clock 상한 (기본 1800000, 1000..3600000)
 *   HARNESS_STRESS_DEADLINE_MS     부하 firm deadline (기본 상한+600000, 2000..7200000, **상한보다 커야 함**)
 *
 * 출력은 bounded summary 지표뿐이다(경로·환경·원문·pid 없음). 종료 코드: 0 PASS / 1 FAIL / 2 거부.
 *
 * 테스트 주입은 **argv `--fixture-config <절대경로 .json>`만**으로 들어온다(Codex Sol xhigh P2-6):
 * env는 자손에 암묵 상속되어 production 실행의 lock 경로·주입 상태를 조용히 바꿀 수 있기 때문이다.
 * fixture 설정이 없으면 모든 주입 seam이 꺼진 상태이며 실제 `npm test`를 돌린다.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureConfigError, loadFixtureConfig } from "./lib/fixture-config.mjs";
import {
  GUARD_WAIT_MS,
  LOCK_TOKEN_ENV,
  PAUSE_POINTS,
  SuiteLockError,
  acquireSuiteLock,
  countOwnedGroupMembers,
} from "./lib/suite-exclusive-lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reject(msg) {
  console.error(`거부: ${msg}`);
  process.exit(2);
}

// ── fixture 설정(테스트 전용, argv) ─────────────────────────────────────────
const FIXTURE_SPEC = {
  lockPath: { kind: "absPath" },
  psFixture: { kind: "absPath" },
  pauseDir: { kind: "absPath" },
  pauseAt: { kind: "enum", values: PAUSE_POINTS },
  inject: { kind: "enum", values: ["worker_spawn_failure", "worker_early_exit", "cleanup_confirm_failure"] },
  injectDir: { kind: "absPath" },
  suiteMode: {
    kind: "enum",
    values: [
      "noop_pass",
      "noop_fail",
      "spawn_failure",
      "sleep_descendant",
      "lock_probe",
      "nested_residual",
      "nested_sleep",
      "nested_ignore_term",
    ],
  },
  suiteSleepMs: { kind: "int", lo: 1, hi: 120_000 },
  confirmMs: { kind: "int", lo: 200, hi: 60_000 },
  workers: { kind: "int", lo: 1, hi: 8 },
  testTimeoutMs: { kind: "int", lo: 1_000, hi: 3_600_000 },
  deadlineMs: { kind: "int", lo: 2_000, hi: 7_200_000 },
  guardWaitMs: { kind: "int", lo: 0, hi: 20_000 },
  // 재진입 fixture child(=lock wrapper)에게 **명시 전달**할 최소 설정 값들. 이 runner가 직접 읽어
  // child 전용 설정 파일을 만든다(자기 설정 파일을 그대로 물려주지 않는다 — confused deputy 방지).
  childMs: { kind: "int", lo: 100, hi: 120_000 },
  acquireToken: { kind: "hex", lo: 32, hi: 64 },
  skipDetection: { kind: "bool" },
};

let FIXTURE = null;
let FIXTURE_PATH = "";
try {
  const loaded = loadFixtureConfig(process.argv.slice(2), FIXTURE_SPEC);
  FIXTURE = loaded.config;
  FIXTURE_PATH = loaded.path ?? "";
  if (loaded.rest.length > 0) reject("알 수 없는 인자입니다 — 이 runner는 --fixture-config 외 인자를 받지 않습니다.");
} catch (e) {
  reject(`fixture 설정 [${e instanceof FixtureConfigError ? e.code : "unknown"}]: ${e?.message ?? ""}`);
}

// ── bounded production 설정 ─────────────────────────────────────────────────
function envInt(name, def, lo, hi) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  if (!/^[1-9]\d*$/.test(raw)) reject(`${name} 값이 양의 정수가 아닙니다.`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) reject(`${name}는 ${lo}..${hi} 범위여야 합니다.`);
  return n;
}

const DEFAULT_WORKERS = Math.min(4, Math.max(1, Math.floor((cpus().length || 2) / 2)));
const WORKERS = FIXTURE?.workers ?? envInt("HARNESS_STRESS_WORKERS", DEFAULT_WORKERS, 1, 8);
const TEST_TIMEOUT_MS = FIXTURE?.testTimeoutMs ?? envInt("HARNESS_STRESS_TEST_TIMEOUT_MS", 1_800_000, 1_000, 3_600_000);
const DEADLINE_MS =
  FIXTURE?.deadlineMs ??
  envInt("HARNESS_STRESS_DEADLINE_MS", Math.min(TEST_TIMEOUT_MS + 600_000, 7_200_000), 2_000, 7_200_000);
// 부하가 suite 전 구간을 덮게 강제한다. deadline이 상한 이하면 부하 없는 PASS가 가능해진다.
if (DEADLINE_MS <= TEST_TIMEOUT_MS) {
  reject(
    `부하 deadline(${DEADLINE_MS}ms)은 npm test 상한(${TEST_TIMEOUT_MS}ms)보다 커야 합니다 — ` +
      "그렇지 않으면 suite 후반이 부하 없이 실행됩니다.",
  );
}

const INJECT = FIXTURE?.inject ?? "";
const SUITE_MODE = FIXTURE?.suiteMode ?? "";
const INJECT_DIR = FIXTURE?.injectDir ?? "";
if ((INJECT === "worker_spawn_failure" || SUITE_MODE === "spawn_failure" || SUITE_MODE === "sleep_descendant") && !INJECT_DIR) {
  reject("이 주입 모드에는 fixture 설정의 injectDir(절대경로)가 필요합니다.");
}
if ((SUITE_MODE === "lock_probe" || SUITE_MODE.startsWith("nested_")) && (!FIXTURE_PATH || !INJECT_DIR)) {
  reject("재진입 fixture 모드에는 fixture 설정 파일과 injectDir(절대경로)가 필요합니다.");
}
const SUITE_SLEEP_MS = FIXTURE?.suiteSleepMs ?? 15_000;

const SPAWN_CONFIRM_MS = 15_000; // worker spawn 확인 상한
/**
 * 소유 npm 그룹 SIGTERM → SIGKILL 유예. 재진입 wrapper의 bounded shutdown 예산
 * (nested 유예 1.2s + 확인 3s)보다 넉넉히 크게 잡아 두 계층의 유예가 충돌하지 않게 한다.
 */
const SUITE_STOP_GRACE_MS = 8_000;
const TIMEOUT_GRACE_MS = 2_000; // timeout 시 kill 성공 여부와 무관한 확정 유예
const SHUTDOWN_CONFIRM_MS = FIXTURE?.confirmMs ?? 20_000; // 종료 확인 wall-clock 상한

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // 존재하지만 권한 없음 → 살아있다고 본다
  }
};

// ── 배타 lock (일반 npm test와 공용) ─────────────────────────────────────────
if (process.env[LOCK_TOKEN_ENV]) {
  reject("이미 lock을 보유한 suite 안에서 실행 중입니다 — stress를 중첩 실행하지 않습니다.");
}
let lock;
try {
  lock = acquireSuiteLock({
    kind: "stress",
    lockPath: FIXTURE?.lockPath,
    psFixture: FIXTURE?.psFixture,
    pause: FIXTURE?.pauseDir && FIXTURE?.pauseAt ? { dir: FIXTURE.pauseDir, at: FIXTURE.pauseAt } : null,
    token: FIXTURE?.acquireToken,
    skipDetection: FIXTURE?.skipDetection === true,
    guardWaitMs: FIXTURE?.guardWaitMs ?? GUARD_WAIT_MS,
    quarantineGuardWaitMs: 500,
  });
} catch (e) {
  const code = e instanceof SuiteLockError ? e.code : "unknown";
  reject(`[${code}] ${e?.message ?? "lock 획득 실패"}`);
}
for (const w of lock.warnings) console.error(`[m3d2-stress] 경고: ${w}`);

// ── 상태 ────────────────────────────────────────────────────────────────────
const cleanupProblems = [];
const workers = []; // { child, pid, exitedBeforeShutdown, exited, spawnFailed }
let workersSpawned = 0;
let suiteChild = null;
let suitePgid = null;
let shutdownStarted = false;
let shutdownPromise = null;
let shutdownResult = null;
let lockReleased = false;
let lockQuarantined = false;
let signalCount = 0;

// ── 부하 worker (순수 CPU 루프 + firm deadline + 부모 소멸 시 자동 종료) ──────
function workerSource(index) {
  const pidFile = INJECT_DIR ? join(INJECT_DIR, `worker-${index}.pid`) : "";
  const earlyExitMs = INJECT === "worker_early_exit" ? 400 : 0;
  return [
    'const fs = require("node:fs");',
    `const pidFile = ${JSON.stringify(pidFile)};`,
    "if (pidFile) fs.writeFileSync(pidFile, String(process.pid));",
    "const ppid0 = process.ppid;",
    `const deadline = Date.now() + ${DEADLINE_MS};`,
    `const earlyExitAt = ${earlyExitMs} > 0 ? Date.now() + ${earlyExitMs} : 0;`,
    "let acc = 0;",
    "while (Date.now() < deadline) {",
    "  if (process.ppid !== ppid0) break;", // 부모가 사라지면 고아로 남지 않는다
    "  if (earlyExitAt && Date.now() >= earlyExitAt) break;",
    "  for (let i = 0; i < 200000; i++) acc = (acc + i * 7) % 2147483647;",
    "}",
    "if (acc === -1) process.exitCode = 1; // acc 최적화 제거 방지용 (도달하지 않음)",
  ].join("\n");
}

function spawnWorker(index) {
  const exec = INJECT === "worker_spawn_failure" ? join(INJECT_DIR, `missing-worker-exec-${index}`) : process.execPath;
  const entry = { child: null, pid: null, exited: false, exitedBeforeShutdown: false };
  workers.push(entry);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(exec, ["-e", workerSource(index)], { cwd: REPO, stdio: "ignore" });
    } catch (e) {
      done({ ok: false, code: e?.code ?? "spawn_throw" });
      return;
    }
    entry.child = child;
    const timer = setTimeout(() => done({ ok: false, code: "spawn_timeout" }), SPAWN_CONFIRM_MS);
    child.on("spawn", () => {
      entry.pid = child.pid ?? null;
      done({ ok: true, code: null });
    });
    child.on("error", (e) => {
      entry.exited = true;
      if (!shutdownStarted) entry.exitedBeforeShutdown = true;
      done({ ok: false, code: e?.code ?? "spawn_failed" });
    });
    child.on("exit", () => {
      entry.exited = true;
      if (!shutdownStarted) entry.exitedBeforeShutdown = true;
    });
  });
}

/** 설정된 worker 전부가 spawn되어야 부하 조건이 성립한다. 하나라도 실패면 실패로 확정한다. */
async function startLoad() {
  const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => spawnWorker(i)));
  const failures = results.filter((r) => !r.ok);
  workersSpawned = results.length - failures.length;
  if (failures.length > 0) {
    const codes = [...new Set(failures.map((f) => f.code))].sort().join(",");
    return { ok: false, detail: `부하 worker ${failures.length}/${WORKERS}건 spawn 실패 [${codes}]` };
  }
  return { ok: true, detail: null };
}

const workerAliveCount = () => workers.filter((w) => !w.exited && w.pid && isAlive(w.pid)).length;
const workersExitedBeforeCleanup = () => workers.filter((w) => w.exitedBeforeShutdown).length;

// ── suite child (기본: 실제 `npm test`) ─────────────────────────────────────
/**
 * 재진입 fixture child(=lock wrapper)에게 넘길 **최소 설정**만 담은 별도 파일을 만든다.
 * 이 runner의 설정 파일을 그대로 물려주면 wrapper가 자기 권한 밖 key(부하·suite 모드 등)까지
 * 계약에 넣어야 하고, 그건 confused-deputy 표면이 된다. 그래서 child가 실제로 해석하는 key만 준다.
 */
function writeChildFixture() {
  const child = {};
  if (FIXTURE?.lockPath) child.lockPath = FIXTURE.lockPath;
  if (INJECT_DIR) child.injectDir = INJECT_DIR;
  if (Number.isSafeInteger(FIXTURE?.childMs)) child.childMs = FIXTURE.childMs;
  if (Number.isSafeInteger(FIXTURE?.confirmMs)) child.confirmMs = FIXTURE.confirmMs;
  if (Number.isSafeInteger(FIXTURE?.guardWaitMs)) child.guardWaitMs = FIXTURE.guardWaitMs;
  const p = join(INJECT_DIR, "child-fixture.json");
  writeFileSync(p, JSON.stringify(child) + "\n", { encoding: "utf8", mode: 0o600 });
  return p;
}

function suiteCommand() {
  const lockCli = join(HERE, "suite-lock.mjs");
  if (SUITE_MODE === "noop_pass") return [process.execPath, ["-e", "process.exit(0)"]];
  if (SUITE_MODE === "noop_fail") return [process.execPath, ["-e", "process.exit(3)"]];
  if (SUITE_MODE === "spawn_failure") return [join(INJECT_DIR, "missing-suite-exec"), []];
  // 자기 소유 child가 ownership token으로 lock에 재진입하는 경로를 검증하는 fixture.
  if (SUITE_MODE === "lock_probe") return [process.execPath, [lockCli, "probe", "--fixture-config", writeChildFixture()]];
  // 재진입 wrapper가 자손을 **상위 소유 pgid에 남기는지** 검증하는 fixture(P1-4 회귀).
  if (SUITE_MODE === "nested_residual") {
    return [process.execPath, [lockCli, "child", "residual", "--fixture-config", writeChildFixture()]];
  }
  if (SUITE_MODE === "nested_sleep") {
    return [process.execPath, [lockCli, "child", "sleep", "--fixture-config", writeChildFixture()]];
  }
  // TERM을 무시하는 중첩 child·손자 — 상위 유예 후 KILL escalation이 전 자손을 덮는지 검증한다.
  if (SUITE_MODE === "nested_ignore_term") {
    return [process.execPath, [lockCli, "child", "sleep_ignore_term", "--fixture-config", writeChildFixture()]];
  }
  if (SUITE_MODE === "sleep_descendant") {
    // suite child가 손자(자손)를 하나 더 띄운다 → 그룹 정리로 자손까지 사라지는지 검증하는 fixture.
    const grandSrc =
      `require("node:fs").writeFileSync(${JSON.stringify(join(INJECT_DIR, "descendant.pid"))}, String(process.pid)); ` +
      `setTimeout(() => {}, ${SUITE_SLEEP_MS});`;
    const src = [
      'const fs = require("node:fs");',
      'const cp = require("node:child_process");',
      `cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandSrc)}], { stdio: "ignore" });`,
      `fs.writeFileSync(${JSON.stringify(join(INJECT_DIR, "suite.pid"))}, String(process.pid));`,
      `setTimeout(() => {}, ${SUITE_SLEEP_MS});`,
    ].join("\n");
    return [process.execPath, ["-e", src]];
  }
  const execPath = process.env.npm_execpath;
  if (execPath && execPath.endsWith(".js") && existsSync(execPath)) return [process.execPath, [execPath, "test"]];
  return ["npm", ["test"]];
}

function killSuiteGroup(signal) {
  if (!suitePgid) return;
  try {
    process.kill(-suitePgid, signal);
  } catch (e) {
    if (e?.code === "ESRCH") return; // 이미 종료
    try {
      suiteChild?.kill(signal);
    } catch {
      cleanupProblems.push(`npm 프로세스 그룹 종료 실패 [${e?.code ?? "unknown"}]`);
    }
  }
}

const suiteGroupAlive = () => {
  if (!suitePgid) return false;
  try {
    process.kill(-suitePgid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
};

/**
 * 소유한 npm 그룹(pgid)에 남은 자손 수. ps 확인 불가는 확인 실패로 보고한다(`ps` fixture seam 사용 안 함).
 * 주입 seam은 "확인 불가"를 결정론적으로 재현할 때만 쓰며, 다른 프로세스에 신호를 보내지 않는다.
 */
function ownedDescendants() {
  if (INJECT === "cleanup_confirm_failure") return { ok: false, count: -1 };
  return countOwnedGroupMembers(suitePgid);
}

/** `npm test` 1회. timeout은 kill 성공 여부와 무관한 **실제 wall-clock 상한**으로 확정된다. */
function runSuite() {
  const [cmd, args] = suiteCommand();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    try {
      suiteChild = spawn(cmd, args, {
        cwd: REPO,
        stdio: "inherit",
        detached: true, // 자기 프로세스 그룹 → 재진입 wrapper의 전 자손이 이 그룹에 남는다
        env: { ...process.env, [LOCK_TOKEN_ENV]: lock.token }, // 자기 소유 child만 lock 재진입
      });
    } catch (e) {
      finish({ code: null, signal: null, spawnError: e?.code ?? "spawn_throw", timedOut: false });
      return;
    }
    suitePgid = suiteChild.pid ?? null;
    timer = setTimeout(() => {
      timedOut = true;
      // timeout도 **즉시 SIGKILL하지 않는다**(Codex Sol xhigh P1-4): 재진입 wrapper가 자기 child 정리와
      // 상위 lock 격리를 끝낼 시간을 준다. TERM → 그룹 유예(하위 shutdown 예산보다 길다) → 소멸 확인 → KILL.
      void (async () => {
        killSuiteGroup("SIGTERM");
        const until = Date.now() + SUITE_STOP_GRACE_MS;
        while (Date.now() < until && suiteGroupAlive()) await sleep(100);
        if (suiteGroupAlive()) killSuiteGroup("SIGKILL");
        // kill이 실패해도 상한을 넘겨 매달리지 않는다 — 유예 후 확정하고 leftover는 정리 확인에서 실패로 잡힌다.
        await sleep(TIMEOUT_GRACE_MS);
        finish({ code: null, signal: null, spawnError: null, timedOut: true });
      })();
    }, TEST_TIMEOUT_MS);
    suiteChild.on("error", (e) => finish({ code: null, signal: null, spawnError: e?.code ?? "spawn_failed", timedOut }));
    suiteChild.on("close", (code, signal) => finish({ code, signal, spawnError: null, timedOut }));
  });
}

// ── shutdown 상태 기계 (async · idempotent · 전 경로 공용) ───────────────────
function shutdown(reason) {
  if (!shutdownPromise) {
    shutdownStarted = true;
    shutdownPromise = runShutdown(reason);
  }
  return shutdownPromise;
}

async function runShutdown(reason) {
  // 1) 소유한 npm 프로세스 그룹만 종료(TERM → 유예 → KILL). 유예는 재진입 wrapper의 shutdown 예산보다 크다.
  if (suitePgid && suiteGroupAlive()) {
    killSuiteGroup("SIGTERM");
    const until = Date.now() + SUITE_STOP_GRACE_MS;
    while (Date.now() < until && suiteGroupAlive()) await sleep(100);
    if (suiteGroupAlive()) killSuiteGroup("SIGKILL");
  }
  // 2) 자신이 만든 부하 worker만 종료.
  for (const w of workers) {
    if (w.exited || !w.pid) continue;
    try {
      w.child?.kill("SIGKILL");
    } catch (e) {
      if (e?.code !== "ESRCH") cleanupProblems.push(`부하 worker 종료 실패 [${e?.code ?? "unknown"}]`);
    }
  }
  // 3) 실제로 사라졌는지 bounded 확인 (SIGKILL 직후에는 reap 전이라 생존으로 보인다).
  const end = Date.now() + SHUTDOWN_CONFIRM_MS;
  let snap = { workersAlive: workers.length, groupAlive: Boolean(suitePgid), descendants: -1, psOk: false };
  for (;;) {
    const workersAlive = workerAliveCount();
    const groupAlive = suiteGroupAlive();
    let descendants = -1;
    let psOk = false;
    if (workersAlive === 0 && !groupAlive) {
      const d = ownedDescendants();
      psOk = d.ok;
      descendants = d.count;
      if (d.ok && d.count === 0) {
        snap = { workersAlive, groupAlive, descendants, psOk };
        break;
      }
    }
    snap = { workersAlive, groupAlive, descendants, psOk };
    if (Date.now() >= end) break;
    await sleep(150);
  }
  const confirmed = snap.workersAlive === 0 && !snap.groupAlive && snap.psOk && snap.descendants === 0;
  if (!confirmed) {
    if (snap.workersAlive > 0) cleanupProblems.push(`부하 worker ${snap.workersAlive}건이 정리 후에도 생존(확인 상한 ${SHUTDOWN_CONFIRM_MS}ms)`);
    if (snap.groupAlive) cleanupProblems.push(`npm 프로세스 그룹이 정리 후에도 생존(확인 상한 ${SHUTDOWN_CONFIRM_MS}ms)`);
    if (!snap.psOk) cleanupProblems.push("자손 정리 확인 불가(ps 실패) — fail closed");
    else if (snap.descendants > 0) cleanupProblems.push(`소유 프로세스 그룹 자손 ${snap.descendants}건 잔존`);
  }
  // 4) 확인이 끝난 **뒤에만** lock을 해제한다. 확인하지 못했다면 **해제하지 않고 격리**한다(fail closed):
  //    소유 worker·그룹·자손이 남아 있을 수 있는 동안 다른 suite가 lock을 이어받으면 안 된다.
  if (confirmed) {
    const lockProblems = lock.release();
    cleanupProblems.push(...lockProblems);
    // 해제 성공은 lock 파일 unlink만이 아니라 **transition guard 반납까지 완결**된 상태다(여섯 번째 리비전 P2).
    lockReleased = lock.state === "released";
    lockQuarantined = lock.state === "quarantined";
    if (!lockReleased && !lockQuarantined) {
      cleanupProblems.push(`lock 해제가 완결되지 않았습니다(state=${lock.state}) — 해제로 보고하지 않습니다(fail closed)`);
    }
  } else {
    const q = lock.quarantine("cleanup_unconfirmed");
    cleanupProblems.push(...q);
    lockReleased = false;
    lockQuarantined = lock.state === "quarantined";
    if (lockQuarantined) {
      console.error("[m3d2-stress] 정리 확인 실패 — lock을 해제하지 않고 격리했습니다(fail closed). 잔존 프로세스 확인 후 수동 제거하세요.");
    }
  }
  shutdownResult = { reason, confirmed, ...snap };
  return shutdownResult;
}

/** 마지막 안전망: 예기치 못한 동기 종료에서도 자기 child를 남기지 않는다(확인·lock 해제는 하지 않는다). */
function syncKillOwned() {
  if (suitePgid) {
    try {
      process.kill(-suitePgid, "SIGKILL");
    } catch {
      /* 이미 종료 */
    }
  }
  for (const w of workers) {
    if (w.exited || !w.pid) continue;
    try {
      w.child?.kill("SIGKILL");
    } catch {
      /* 이미 종료 */
    }
  }
}
process.on("exit", () => {
  syncKillOwned();
  // 정리 확인을 마치지 못한 채 빠져나가는 경로에서도 lock을 노출하지 않는다(fail closed).
  if (lock && lock.state === "held") lock.quarantine("exit_without_confirm");
});

async function onSignal(sig, code) {
  signalCount += 1;
  if (signalCount > 1) {
    // 두 번째 시그널은 즉시 탈출 경로 — 확인을 마칠 수 없으므로 lock을 해제하지 않고 격리한다.
    syncKillOwned();
    if (lock.state === "held") {
      const q = lock.quarantine("repeated_signal");
      if (q.length === 0) console.error("[m3d2-stress] 반복 시그널 — 정리 확인 없이 종료하므로 lock을 격리했습니다(fail closed).");
      else console.error("[m3d2-stress] cleanup 문제:\n - " + q.join("\n - "));
    }
    process.exit(code);
  }
  await shutdown(`signal_${sig}`);
  if (cleanupProblems.length > 0) console.error("[m3d2-stress] cleanup 문제:\n - " + cleanupProblems.join("\n - "));
  console.error(`[m3d2-stress] ${sig} 수신 — 소유 프로세스 정리 확인 후 종료 (exit ${code}).`);
  process.exit(code);
}
process.on("SIGINT", () => void onSignal("SIGINT", 130));
process.on("SIGTERM", () => void onSignal("SIGTERM", 143));

// ── 실행 ────────────────────────────────────────────────────────────────────
console.log(
  `[m3d2-stress] 시작 — 부하 worker ${WORKERS}개(cpus=${cpus().length || "unknown"}), ` +
    `부하 deadline ${DEADLINE_MS}ms > npm test 상한 ${TEST_TIMEOUT_MS}ms. 공용 배타 lock 보유(다른 suite와 동시 실행하지 않음).`,
);

const startedAt = Date.now();
let exitCode = 0;
const failures = [];
let suiteResult = { code: null, signal: null, spawnError: null, timedOut: false };
let workersAliveAtSuiteClose = 0;

try {
  const load = await startLoad();
  if (!load.ok) {
    failures.push(load.detail);
  } else {
    suiteResult = await runSuite();
    workersAliveAtSuiteClose = workerAliveCount();
    if (workersExitedBeforeCleanup() > 0) {
      failures.push(`부하 worker ${workersExitedBeforeCleanup()}건이 정리 전에 종료 — 부하 조건 미충족`);
    } else if (workersAliveAtSuiteClose !== WORKERS) {
      failures.push(`npm test 종료 시점 생존 worker ${workersAliveAtSuiteClose}/${WORKERS} — 부하 조건 미충족`);
    }
    if (suiteResult.spawnError) failures.push(`npm test 실행 실패 [${suiteResult.spawnError}]`);
    else if (suiteResult.timedOut) failures.push(`npm test가 wall-clock 상한(${TEST_TIMEOUT_MS}ms) 초과`);
    else if (suiteResult.code !== 0) failures.push(`npm test exit ${suiteResult.code}`);
  }
} catch (e) {
  failures.push(`runner 예외 [${e?.code ?? e?.name ?? "unknown"}]`);
}

const elapsedMs = Date.now() - startedAt;
await shutdown(failures.length > 0 ? "error" : "normal");

if (failures.length > 0) {
  console.error("[m3d2-stress] 실패:\n - " + failures.join("\n - "));
  exitCode = 1;
}
if (cleanupProblems.length > 0) {
  console.error("[m3d2-stress] cleanup 문제:\n - " + cleanupProblems.join("\n - "));
  exitCode = 1;
}

// bounded summary 지표만 출력(경로·pid·환경 없음).
console.log(
  "[m3d2-stress] 요약: " +
    JSON.stringify({
      loadWorkers: WORKERS,
      loadDeadlineMs: DEADLINE_MS,
      testTimeoutMs: TEST_TIMEOUT_MS,
      elapsedMs,
      workersSpawned,
      workersExitedBeforeCleanup: workersExitedBeforeCleanup(),
      workersAliveAtSuiteClose,
      npmTestExitCode: suiteResult.code,
      npmTestSignal: suiteResult.signal,
      npmTestTimedOut: suiteResult.timedOut,
      npmTestSpawnError: suiteResult.spawnError,
      workersAliveAfterCleanup: shutdownResult?.workersAlive ?? -1,
      npmGroupAliveAfterCleanup: Boolean(shutdownResult?.groupAlive),
      ownedDescendantsAfterCleanup: shutdownResult?.descendants ?? -1,
      cleanupConfirmed: Boolean(shutdownResult?.confirmed),
      cleanupProblems: cleanupProblems.length,
      lockReleased,
      lockQuarantined,
      shutdownReason: shutdownResult?.reason ?? "unknown",
    }),
);
console.log(`[m3d2-stress] ${exitCode === 0 ? "PASS" : "FAIL"} (exit ${exitCode}).`);
process.exit(exitCode);
