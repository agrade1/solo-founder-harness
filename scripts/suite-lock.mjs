#!/usr/bin/env node
/**
 * [V3 M3d.2] 전체 suite 실행을 **공용 배타 lock** 안에서 돌리는 얇은 wrapper.
 *
 * `npm test` = `npm run typecheck && node scripts/suite-lock.mjs run test:inner` 이고, `test:inner`는
 * 기존과 동일하게 `test:exec → test:core → acceptance.sh` 순서를 그대로 실행한다.
 * 이 wrapper는 순서·카운트·exit code를 바꾸지 않고 lock만 추가한다.
 *
 * [C-104] typecheck가 `test:inner` **안**이 아니라 `test` script의 **첫 단계**에 있는 이유:
 * 이 wrapper는 lock을 먼저 획득한 **뒤에** `npm run <script>`를 spawn한다(아래 acquire → spawn 순서).
 * 따라서 `test:inner` 머리에 넣으면 컴파일 실패가 **배타 lock을 잡은 채** 나고, 그 동안 다른 세션의
 * suite는 전부 막힌다. 기각한 대안: ① `test:inner` 맨 앞 — lock 보유 중 실패라 대장이 든 근거
 * ("lock을 잡기 전에 깨지는 편이 싸다")를 만족하지 못한다. ② 양쪽 모두 — 같은 검사를 두 번 돌린다.
 * 현재 `test:inner`를 직접 부르는 자리는 이 wrapper뿐이므로(전수 확인) 우회 경로도 없다.
 * 회귀: src/tools/suiteChainWiring.test.ts
 *
 * ── production 모드 ─────────────────────────────────────────────────────────
 *   run <npm-script>   package.json script 하나를 lock 안에서 실행하고 exit code를 그대로 전달
 *
 * ── 테스트 전용 모드(반드시 `--fixture-config <절대경로 .json>`와 함께여야 실행된다) ──
 *   hold <ms>          lock을 bounded 시간만 잡고 있다가 해제 (경합 테스트용)
 *   probe              획득 → 한 줄 bounded 요약 출력 → 즉시 해제
 *   child <fixture>    run과 **같은 child/shutdown 경로**를 bounded fixture로 실행
 *   quarantine <why>   보유 token으로 **재진입해 신뢰 기준을 확보한 뒤** 상위 lock 격리 시도
 *                      (release↔quarantine 경합 테스트용. 기준 없이 tokenHash만으로는 격리하지 않는다.)
 *
 * fixture 설정이 없으면 위 테스트 모드는 **거부**되며, lock 경로·`ps` fixture·주입 seam은 전부 꺼진다.
 * 이 파일은 테스트 seam을 `process.env`에서 읽지 않는다(Codex Sol xhigh P2-6): env는 자손에 암묵 상속되어
 * production 실행의 lock 경로를 조용히 바꿀 수 있기 때문이다. 주입은 상속되지 않는 argv로만 들어온다.
 * (예외: `HARNESS_SUITE_LOCK_TOKEN`은 테스트 seam이 아니라 **부모→자식 ownership handoff** 메커니즘이다.)
 *
 * 종료: normal close / spawn error / SIGINT / SIGTERM / 반복 시그널 / escalation을
 * **비동기 idempotent bounded shutdown 상태 기계 하나**로 처리한다.
 *   소유 child 종료 → 소멸을 bounded 확인 → **확인된 뒤에만** lock 해제 → exit.
 *   확인 실패·불가는 해제 대신 격리(quarantine)해 다른 suite가 이어받지 못하게 한다(fail closed).
 *   시그널 exit 의미(SIGINT 130 / SIGTERM 143)는 확인 성공 여부와 무관하게 유지한다.
 *
 * child 그룹 계약 (Codex Sol xhigh P1-4):
 *   - **standalone**(우리가 lock 소유자): child를 `detached`로 띄워 **자기 프로세스 그룹**을 만들고,
 *     그룹 TERM→유예→KILL 후 그룹·자손 소멸까지 직접 확인한다(기존 계약 유지).
 *   - **nested**(상위 stress runner의 lock에 token으로 재진입): child를 **detached로 만들지 않는다.**
 *     그래야 모든 자손이 상위 runner가 소유한 pgid에 남아 상위의 그룹 kill·자손 스캔에 전부 잡힌다.
 *     이 모드에서 wrapper는 자기 child만 종료·확인하고(유예는 상위 유예보다 **짧게**), 그룹 정리 확인은
 *     상위 lock 소유자의 책임이다. 자기 child 소멸을 확인하지 못하면 상위 lock을 token으로 격리한다.
 *
 * fixture 계약 범위:
 *   이 wrapper는 **자기가 해석하는 key만** 받는다(아래 FIXTURE_SPEC). 상위 stress runner는 자기 설정
 *   파일을 그대로 넘기지 않고 child에게 필요한 최소 설정만 별도 파일로 만들어 전달한다 —
 *   wrapper가 남의 권한(부하·suite 모드 등)을 대신 해석하는 confused-deputy 표면을 두지 않기 위함이다.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureConfigError, loadFixtureConfig } from "./lib/fixture-config.mjs";
import {
  GUARD_WAIT_MS,
  LOCK_TOKEN_ENV,
  PAUSE_POINTS,
  SuiteLockError,
  acquireSuiteLock,
  countOwnedGroupMembers,
  quarantineByToken,
  tryReenterSuiteLock,
} from "./lib/suite-exclusive-lock.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const NPM_SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const HOLD_MAX_MS = 60_000;
const CHILD_FIXTURES = ["residual", "sleep", "sleep_ignore_term"];
const QUARANTINE_REASON_RE = /^[a-z0-9_]{1,64}$/;

/** standalone: 그룹 SIGTERM → SIGKILL 유예. */
const STANDALONE_STOP_GRACE_MS = 5_000;
/** nested: 상위 runner의 그룹 유예(8s)보다 **반드시 짧다** — 상위가 KILL로 넘어가기 전에 끝난다. */
const NESTED_STOP_GRACE_MS = 1_200;
const NESTED_CONFIRM_MS = 3_000;
/** 격리 시 guard 경합 대기는 짧게 — 종료 경로에서 매달리지 않는다. */
const QUARANTINE_GUARD_WAIT_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`[suite-lock] ${msg}`);
  process.exit(2);
}

function usage() {
  console.error(
    "사용법: node scripts/suite-lock.mjs run <npm-script>\n" +
      "        (테스트 전용, --fixture-config 필수) hold <ms> | probe | child <fixture> | quarantine <reason>",
  );
  process.exit(2);
}

// ── argv + fixture 설정 (lock 획득 **전에** 전부 검증한다) ────────────────────
/**
 * 이 wrapper가 **해석하는 key만** 계약에 넣는다(Codex Sol xhigh 후속 지적: confused deputy 방지).
 * stress runner는 자기 설정 파일을 그대로 물려주지 않고 **child에게 필요한 최소 설정만** 새 파일로
 * 명시 전달하므로, stress 전용 key(workers/testTimeoutMs/deadlineMs/suiteMode/suiteSleepMs)는
 * 여기서 아예 허용하지 않는다 — 그런 key가 담긴 설정으로 이 wrapper를 부르면 `fixture_unknown_key`로 거부된다.
 */
const FIXTURE_SPEC = {
  lockPath: { kind: "absPath" },
  psFixture: { kind: "absPath" },
  pauseDir: { kind: "absPath" },
  pauseAt: { kind: "enum", values: PAUSE_POINTS },
  // 이 wrapper가 해석하는 주입은 "confirm_failure"(정리 확인 불가 재현) 하나뿐이다.
  inject: { kind: "enum", values: ["confirm_failure"] },
  injectDir: { kind: "absPath" },
  childMs: { kind: "int", lo: 100, hi: 120_000 },
  confirmMs: { kind: "int", lo: 200, hi: 60_000 },
  guardWaitMs: { kind: "int", lo: 0, hi: 20_000 },
  acquireToken: { kind: "hex", lo: 32, hi: 64 },
  skipDetection: { kind: "bool" },
};

let fixture = null;
let argv = [];
try {
  const loaded = loadFixtureConfig(process.argv.slice(2), FIXTURE_SPEC);
  fixture = loaded.config;
  argv = loaded.rest;
} catch (e) {
  fail(`fixture 설정 거부 [${e instanceof FixtureConfigError ? e.code : "unknown"}]: ${e?.message ?? ""}`);
}

const mode = argv[0] ?? "";
if (!["run", "hold", "probe", "child", "quarantine"].includes(mode)) usage();
if (mode !== "run" && !fixture) {
  fail(`'${mode}' 모드는 테스트 전용입니다 — --fixture-config <절대경로 .json> 없이는 실행하지 않습니다.`);
}

let script = "";
let holdMs = 0;
let childFixture = "";
let quarantineReason = "";
if (mode === "run") {
  script = argv[1] ?? "";
  if (!NPM_SCRIPT_RE.test(script)) fail("run <npm-script>: script 이름 형식이 올바르지 않습니다.");
} else if (mode === "hold") {
  holdMs = Number(argv[1]);
  if (!Number.isSafeInteger(holdMs) || holdMs < 0 || holdMs > HOLD_MAX_MS) fail(`hold <ms>는 0..${HOLD_MAX_MS} 범위여야 합니다.`);
} else if (mode === "child") {
  childFixture = argv[1] ?? "";
  if (!CHILD_FIXTURES.includes(childFixture)) fail("child <fixture>: 허용된 fixture가 아닙니다.");
  if (!fixture?.injectDir) fail("child 모드에는 fixture 설정의 injectDir(절대경로)가 필요합니다.");
} else if (mode === "quarantine") {
  quarantineReason = argv[1] ?? "";
  if (!QUARANTINE_REASON_RE.test(quarantineReason)) fail("quarantine <reason>: ^[a-z0-9_]{1,64}$ 형식이어야 합니다.");
}

const INJECT = fixture?.inject ?? "";
const INJECT_DIR = fixture?.injectDir ?? "";
const CHILD_MS = fixture?.childMs ?? 60_000;
const LOCK_PATH = fixture?.lockPath;
const PS_FIXTURE = fixture?.psFixture;
const PAUSE = fixture?.pauseDir && fixture?.pauseAt ? { dir: fixture.pauseDir, at: fixture.pauseAt } : null;
const GUARD_WAIT = fixture?.guardWaitMs ?? GUARD_WAIT_MS;

// ── lock 획득 / 재진입 ───────────────────────────────────────────────────────
const ambientToken = process.env[LOCK_TOKEN_ENV];
let lock = null; // 우리가 소유한 lock (재진입이면 null)
let nested = false;
/**
 * 성공한 재진입 시점의 **신뢰 기준**(기본 record + dev/ino). 이후 상위 lock 격리에 그대로 넘긴다 —
 * tokenHash만으로는 소유권을 인정하지 않기 위함이다(Codex Sol xhigh P1-4, 다섯 번째 리비전).
 */
let reentryBase = null;

if (mode === "quarantine") {
  // 테스트 전용: 보유 token으로 상위 lock을 격리해 release↔quarantine 경합을 재현한다.
  // production 재진입 경로와 **같은 순서**를 지킨다: 먼저 token으로 재진입해 신뢰 기준을 확보하고,
  // 그 기준으로만 격리한다(기준 없이 tokenHash만으로 남의 lock을 격리하지 않는다).
  const token = fixture?.acquireToken ?? ambientToken;
  let problems = [];
  let expected = null;
  try {
    const re = tryReenterSuiteLock({ lockPath: LOCK_PATH, token, guardWaitMs: GUARD_WAIT });
    if (!re) problems.push("재진입 token이 없어 격리 기준을 확보하지 못함");
    else expected = re.base;
  } catch (e) {
    problems.push(`격리 기준 확보(재진입) 실패 [${e instanceof SuiteLockError ? e.code : "unknown"}]`);
  }
  if (problems.length === 0) {
    problems = quarantineByToken({
      lockPath: LOCK_PATH,
      token,
      expected,
      reason: quarantineReason,
      pause: PAUSE,
      guardWaitMs: GUARD_WAIT,
    });
  }
  console.log(JSON.stringify({ mode: "quarantine", ok: problems.length === 0, problems }));
  process.exit(problems.length === 0 ? 0 : 1);
}

try {
  const re = tryReenterSuiteLock({ lockPath: LOCK_PATH, token: ambientToken, guardWaitMs: GUARD_WAIT, pause: PAUSE });
  if (re) {
    nested = true;
    reentryBase = re.base;
    for (const w of re.warnings) console.error(`[suite-lock] 경고: ${w}`);
  } else {
    lock = acquireSuiteLock({
      kind: "suite",
      lockPath: LOCK_PATH,
      psFixture: PS_FIXTURE,
      pause: PAUSE,
      token: fixture?.acquireToken,
      skipDetection: fixture?.skipDetection === true,
      guardWaitMs: GUARD_WAIT,
      quarantineGuardWaitMs: QUARANTINE_GUARD_WAIT_MS,
    });
    for (const w of lock.warnings) console.error(`[suite-lock] 경고: ${w}`);
  }
} catch (e) {
  const code = e instanceof SuiteLockError ? e.code : "unknown";
  console.error(`[suite-lock] 거부 [${code}]: ${e?.message ?? "lock 획득 실패"}`);
  process.exit(2);
}

const STOP_GRACE_MS = nested ? NESTED_STOP_GRACE_MS : STANDALONE_STOP_GRACE_MS;
const CONFIRM_MS = fixture?.confirmMs ?? (nested ? NESTED_CONFIRM_MS : 20_000);

// ── 소유 child 상태 ─────────────────────────────────────────────────────────
const problems = [];
let child = null;
let childPgid = null; // standalone에서만 쓴다(자기 그룹)
let childSettled = false; // close 또는 spawn 실패 → 우리 child 프로세스는 존재하지 않는다
let shutdownPromise = null;
let shutdownResult = null;
let signalCount = 0;

const childRunning = () => Boolean(child) && !childSettled && child.exitCode === null && child.signalCode === null;

const groupAlive = () => {
  if (!childPgid) return false;
  try {
    process.kill(-childPgid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // 존재하지만 권한 없음 → 살아있다고 본다
  }
};

/** standalone: 소유 그룹 전체. nested: 자기 child만(그룹은 상위 소유자 책임). */
const ownedAlive = () => (nested ? childRunning() : groupAlive());

function killOwned(signal) {
  if (nested) {
    if (!childRunning()) return;
    try {
      child.kill(signal);
    } catch (e) {
      if (e?.code !== "ESRCH") problems.push(`child 종료 실패 [${e?.code ?? "unknown"}]`);
    }
    return;
  }
  if (!childPgid) return;
  try {
    process.kill(-childPgid, signal);
  } catch (e) {
    if (e?.code === "ESRCH") return; // 이미 종료
    try {
      child?.kill(signal);
    } catch {
      problems.push(`child 프로세스 그룹 종료 실패 [${e?.code ?? "unknown"}]`);
    }
  }
}

/**
 * 정리 확인 한 컷.
 *  - standalone: 그룹 소멸 + 소유 pgid 자손 0 (ps 확인 불가는 fail closed)
 *  - nested: 자기 child 소멸만. 그룹·자손 확인은 상위 lock 소유자가 한다(자손이 상위 pgid에 남기 때문).
 */
function cleanupSnapshot() {
  if (INJECT === "confirm_failure") return { alive: true, descendants: -1, psOk: false };
  const alive = ownedAlive();
  if (nested) return { alive, descendants: 0, psOk: true };
  if (alive) return { alive, descendants: -1, psOk: false };
  const d = countOwnedGroupMembers(childPgid);
  return { alive, descendants: d.count, psOk: d.ok };
}

/** 마지막 안전망: 예기치 못한 동기 종료에서도 소유 child를 남기지 않는다. */
function syncKillOwned() {
  if (nested) {
    if (childRunning()) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 이미 종료 */
      }
    }
    return;
  }
  if (!childPgid) return;
  try {
    process.kill(-childPgid, "SIGKILL");
  } catch {
    /* 이미 종료 */
  }
}

/** 확인 실패 시 lock을 **해제하지 않고** 격리한다(소유 잔재가 있을 수 있는 동안 노출 금지). */
function quarantineLock(reason) {
  if (lock) return lock.quarantine(reason);
  if (nested) {
    // 재진입 시점에 고정한 신뢰 기준(expected)을 그대로 넘긴다 — 같은 tokenHash를 가진 외부 교체 lock을
    // 새 기준으로 받아 격리하지 않는다(그 경우 lock을 보존하고 guard가 남아 다음 실행을 막는다).
    return quarantineByToken({
      lockPath: LOCK_PATH,
      token: ambientToken,
      expected: reentryBase,
      reason,
      guardWaitMs: QUARANTINE_GUARD_WAIT_MS,
    });
  }
  return [];
}

// ── shutdown 상태 기계 (async · idempotent · 전 경로 공용) ───────────────────
function shutdown(reason) {
  if (!shutdownPromise) shutdownPromise = runShutdown(reason);
  return shutdownPromise;
}

async function runShutdown(reason) {
  // 1) 소유 child(standalone은 그룹) 종료: TERM → 유예 → KILL.
  if (ownedAlive()) {
    killOwned("SIGTERM");
    const until = Date.now() + STOP_GRACE_MS;
    while (Date.now() < until && ownedAlive()) await sleep(100);
    if (ownedAlive()) killOwned("SIGKILL");
  }
  // 2) 실제로 사라졌는지 bounded 확인 (SIGKILL 직후에는 reap 전이라 생존으로 보이므로 polling).
  const end = Date.now() + CONFIRM_MS;
  let snap = { alive: true, descendants: -1, psOk: false };
  for (;;) {
    snap = cleanupSnapshot();
    if (!snap.alive && snap.psOk && snap.descendants === 0) break;
    if (Date.now() >= end) break;
    await sleep(150);
  }
  const confirmed = !snap.alive && snap.psOk && snap.descendants === 0;
  if (!confirmed) {
    if (snap.alive) problems.push(`소유 child${nested ? "" : " 프로세스 그룹"}가 정리 후에도 생존(확인 상한 ${CONFIRM_MS}ms)`);
    if (!snap.psOk) problems.push("소유 그룹 자손 정리 확인 불가(ps 실패) — fail closed");
    else if (snap.descendants > 0) problems.push(`소유 프로세스 그룹 자손 ${snap.descendants}건 잔존`);
  }
  // 3) 확인이 끝난 **뒤에만** lock을 해제한다. 확인 실패면 해제 대신 격리한다.
  let released = false;
  let quarantined = false;
  if (confirmed) {
    if (lock) {
      const p = lock.release();
      problems.push(...p);
      released = lock.state === "released";
      quarantined = lock.state === "quarantined";
      if (!released && !quarantined) {
        // 해제 전이가 완결되지 않았다(예: lock unlink 뒤 guard 반납 실패). 절대 해제로 보고하지 않는다 —
        // 남은 guard가 다음 실행을 막고 사람이 확인해야 한다(여섯 번째 리비전 P2).
        problems.push(`lock 해제가 완결되지 않았습니다(state=${lock.state}) — 해제로 보고하지 않습니다(fail closed)`);
      }
    } else {
      released = true; // 재진입: 우리 lock이 아니므로 해제 대상이 없다
    }
  } else {
    const q = quarantineLock("cleanup_unconfirmed");
    problems.push(...q);
    quarantined = q.length === 0;
    if (quarantined) console.error("[suite-lock] 정리 확인 실패 — lock을 해제하지 않고 격리했습니다(fail closed).");
  }
  shutdownResult = { reason, confirmed, released, quarantined, ...snap };
  return shutdownResult;
}

/** 예기치 못한 동기 종료 경로: 소유 child를 정리하고, 미해제 lock은 노출하지 않도록 격리한다. */
process.on("exit", () => {
  syncKillOwned();
  if (lock && lock.state === "held") lock.quarantine("exit_without_confirm");
});

async function finishAndExit(code) {
  await shutdown(code === 0 ? "normal" : "error");
  if (problems.length > 0) {
    console.error("[suite-lock] lock 정리 문제:\n - " + problems.join("\n - "));
    process.exit(code === 0 ? 1 : code);
  }
  process.exit(code);
}

async function onSignal(sig, code) {
  signalCount += 1;
  if (signalCount > 1) {
    // 두 번째 시그널은 즉시 탈출 경로 — 확인을 마칠 수 없으므로 lock을 **해제하지 않고** 격리한다.
    syncKillOwned();
    if (!shutdownResult?.released) {
      const q = quarantineLock("repeated_signal");
      if (q.length === 0) console.error("[suite-lock] 반복 시그널 — 정리 확인 없이 종료하므로 lock을 격리했습니다(fail closed).");
      else console.error("[suite-lock] lock 정리 문제:\n - " + q.join("\n - "));
    }
    process.exit(code);
  }
  await shutdown(`signal_${sig}`);
  if (problems.length > 0) console.error("[suite-lock] lock 정리 문제:\n - " + problems.join("\n - "));
  console.error(`[suite-lock] ${sig} 수신 — 소유 프로세스 정리 확인 후 종료 (exit ${code}).`);
  process.exit(code); // 시그널 exit 의미(130/143)는 확인 결과와 무관하게 유지한다
}
process.on("SIGINT", () => void onSignal("SIGINT", 130));
process.on("SIGTERM", () => void onSignal("SIGTERM", 143));

// ── probe / hold (테스트 전용, bounded) ──────────────────────────────────────
if (mode === "probe") {
  console.log(JSON.stringify({ mode: "probe", reentered: nested }));
  await finishAndExit(0);
} else if (mode === "hold") {
  console.log(JSON.stringify({ mode: "hold", ms: holdMs, reentered: nested }));
  setTimeout(() => void finishAndExit(0), holdMs);
} else {
  // ── run <npm-script> / child <fixture> — 같은 spawn·close·shutdown 경로 ────
  const token = lock?.token ?? ambientToken;
  const childEnv = { ...process.env };
  if (typeof token === "string" && token.length > 0) childEnv[LOCK_TOKEN_ENV] = token;
  const [cmd, args] =
    mode === "run" ? ["npm", ["run", script]] : [process.execPath, ["-e", childFixtureSource(childFixture)]];
  try {
    child = spawn(cmd, args, {
      cwd: REPO,
      stdio: "inherit",
      // standalone: 자기 프로세스 그룹 → 자손까지 소유 단위로 정리·확인.
      // nested: **그룹을 새로 만들지 않는다** → 모든 자손이 상위 runner 소유 pgid에 남는다(P1-4).
      detached: !nested,
      env: childEnv,
    });
  } catch (e) {
    console.error(`[suite-lock] suite 실행 실패 [${e?.code ?? "spawn_throw"}].`);
    await finishAndExit(1);
  }
  childPgid = nested ? null : (child?.pid ?? null);

  child.on("error", (e) => {
    if (child?.pid === undefined) childSettled = true; // spawn 자체 실패 → 프로세스가 없다
    console.error(`[suite-lock] suite 실행 실패 [${e?.code ?? "spawn_failed"}].`);
    void finishAndExit(1);
  });
  child.on("close", (code, sig) => {
    childSettled = true;
    if (sig) {
      console.error(`[suite-lock] suite가 시그널로 종료됨 [${sig}].`);
      void finishAndExit(1);
      return;
    }
    void finishAndExit(code === null ? 1 : code);
  });
}

/**
 * [테스트 전용] child fixture 소스. 손자를 하나 띄워 **같은 프로세스 그룹**에 남긴다 —
 * child가 정상 종료해도 그룹 잔재가 남는 상황을 결정론적으로 재현하기 위함이다.
 * 순수 타이머만 쓰고 저장소·tmp·전역 상태를 관측하거나 변경하지 않는다.
 */
function childFixtureSource(kind) {
  const ignore = kind === "sleep_ignore_term";
  const grandSrc = [
    'require("node:fs").writeFileSync(' + JSON.stringify(join(INJECT_DIR, "grandchild.pid")) + ", String(process.pid));",
    ignore ? 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});' : "",
    `setTimeout(() => {}, ${CHILD_MS});`,
  ].join("\n");
  return [
    'const fs = require("node:fs");',
    'const cp = require("node:child_process");',
    `const g = cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandSrc)}], { stdio: "ignore" });`,
    "g.unref();",
    `fs.writeFileSync(${JSON.stringify(join(INJECT_DIR, "child.pid"))}, String(process.pid));`,
    ignore ? 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});' : "",
    // residual: 손자가 확실히 뜬 것을 확인한 뒤 child만 정상 종료하고 손자를 그룹에 남긴다.
    kind === "residual"
      ? [
          `const gpid = ${JSON.stringify(join(INJECT_DIR, "grandchild.pid"))};`,
          `const deadline = Date.now() + 15000;`,
          "const tick = setInterval(() => {",
          "  if (fs.existsSync(gpid) || Date.now() >= deadline) { clearInterval(tick); process.exit(0); }",
          "}, 25);",
        ].join("\n")
      : `setTimeout(() => {}, ${CHILD_MS});`,
  ].join("\n");
}
