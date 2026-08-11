#!/usr/bin/env node
/**
 * V3 M5 — **deadline·cancellation 자손 정리 acceptance**(유예 대장 `B-24`).
 *
 * `m5d-offline-acceptance.mjs`는 프로세스를 **0회** spawn하므로 "잔존 프로세스 0"을 증명할 수 없다
 * (cleanup 코드를 통째로 지워도 green이다). 이 스크립트는 **실제로 spawn한다**: autopilot → typed
 * `run_process` 집행 → 승인된 controller entrypoint → **손자 프로세스**까지의 end-to-end다.
 *
 * ## 무엇을 증명하는가
 *
 * - 승인 manifest가 digest로 고정한 `node <controllerEntrypoint>`가 **실제로 뜨고 자손(손자)을 낳는다**
 *   — 손자가 자기 pid를 파일로 적고, 이 스크립트가 그 pid를 읽어 관측한다(`stdio:"ignore"`라 stdout은 없다).
 * - **deadline 초과 시 손자가 실제로 죽는다** — `process.kill(pid, 0)`이 `ESRCH`가 될 때까지 폴링(상한 5초,
 *   넘으면 FAIL). 손자는 SIGTERM을 **무시하지 않고 받아 넘기며 계속 산다**(`trap ... TERM`) → 정리는
 *   **SIGKILL 경로까지** 밟아야 성립한다.
 * - **cancellation(`AbortSignal`) 경로도 같다** — 손자 ready 파일을 관측한 **뒤에** abort하므로 경합이 없고,
 *   손자가 TERM을 받았다는 증거 파일(`*.term`)로 **SIGKILL 경로를 실제로 밟았다**는 것까지 확인한다.
 * - **성공 영수증이 없다** — deadline/cancel로 죽은 집행은 `applied`가 아니며 task는 hang 없이 `paused`로
 *   착지하고 미확정 pending을 남기지 않는다.
 * - **잔존 프로세스 0** — 종료 시점에 ⓐ baseline 밖 **직계 자식**이 없고 ⓑ ①②에서 **관측한 손자 pid가
 *   전부 사라졌다**. ⓑ가 핵심이다: 유출된 손자는 부모가 죽는 순간 init으로 reparent되어 직계 자식
 *   목록에서 사라지므로, ⓐ만으로 "자손 0"을 주장하면 과대주장이다(SIGKILL 승격을 지우는 mutation에서
 *   ⓐ만 green으로 남는 것을 실제로 확인했다).
 *
 * ## 무엇을 증명하지 않는가 (정직하게)
 *
 * - **실제 `validate-plan` controller가 아니다** — entrypoint는 이 스크립트가 임시 디렉터리에 만드는
 *   fixture다(자손을 낳고 사는 것이 전부). 증명 대상은 **정리 역학**이지 controller의 의미가 아니다.
 * - **deadline 시나리오의 SIGKILL 경로는 단정하지 않는다** — deadline은 spawn 시각부터 흐르므로 손자의
 *   `trap` 설치와 SIGTERM 도착 사이에 외부 배리어를 걸 수 없다(여유만 크게 준다). 그래서 deadline
 *   시나리오는 **손자가 죽는다**만 단정하고, "TERM을 견디고 KILL로 죽었다"는 배리어가 성립하는
 *   **cancel 시나리오에서만** 단정한다.
 * - 증손자·pgid 밖으로 도망친 자손(`setsid`)은 다루지 않는다 — supervisor의 소유 단위는 pgid 하나다.
 * - live 추론·네트워크·git write는 없다.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// src/*.ts를 직접 소비하므로 tsx 로더가 필요하다 — 로더 없이 들어왔으면 tsx로 정확히 한 번 재실행한다.
if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { createOrchestrationRun, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runAutopilot } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));
const { REQUIRED_BODY_HEADINGS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const RUN_ID = "m5-cleanup";
const MILESTONE = "m5";
/** deadline 시나리오의 프로세스 수명 상한. 손자 기동(fork+exec+trap)보다 세 자릿수 크게 잡는다. */
const DEADLINE_MS = 2_000;
/** cancel 시나리오는 deadline이 아니라 abort로만 끝나야 한다 — 정책 상한과 같게 둔다. */
const CANCEL_TIMEOUT_MS = 600_000;
/** 관측 상한. 넘으면 조용히 통과하지 않고 FAIL이다. */
const OBSERVE_MS = 5_000;

let clockTick = 0;
const clock = () => new Date(Date.UTC(2026, 7, 11, 0, 0, clockTick++));

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 파일이 나타나기를 **폴링으로 관측**한다(고정 sleep 금지 — 배리어다). 상한을 넘으면 false. */
async function awaitFile(path, limitMs = OBSERVE_MS) {
  const until = Date.now() + limitMs;
  for (;;) {
    if (existsSync(path)) return true;
    if (Date.now() >= until) return false;
    await sleep(10);
  }
}

/** pid가 사라지는 것을 폴링으로 관측한다. `ESRCH`만 "죽었다"다. 상한을 넘으면 false. */
async function awaitGone(pid, limitMs = OBSERVE_MS) {
  const until = Date.now() + limitMs;
  for (;;) {
    let alive;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code !== "ESRCH";
    }
    if (!alive) return true;
    if (Date.now() >= until) return false;
    await sleep(10);
  }
}

/** 이 프로세스의 직계 자식 pid 집합(관측 시점의 `ps` 자신도 포함된다). */
function childPids() {
  const out = execFileSync("/bin/ps", ["-Ao", "ppid=,pid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pids = new Set();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m && Number(m[1]) === process.pid) pids.add(Number(m[2]));
  }
  return pids;
}

/**
 * fixture controller entrypoint. 승인이 고를 수 있는 것은 action enum과 `data.planPath`뿐이므로
 * 시나리오 구분은 **planPath의 basename**으로 한다(argv는 `node <entry> <action> <planPath>`로 고정).
 * 손자는 `trap`을 먼저 설치하고 **그 뒤에** pid·ready를 적는다 — ready가 곧 배리어다.
 */
const CONTROLLER_SRC = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";
const tag = basename(process.argv[3] ?? "x", ".json");
// trap이 먼저, ready가 마지막. TERM을 받아도 **죽지 않는다** → 정리는 SIGKILL까지 가야 성립한다.
const script = "trap 'echo 1 > " + tag + ".term' TERM; echo $$ > " + tag + ".pid; echo 1 > " + tag + ".ready; while :; do sleep 0.05; done";
spawn("/bin/sh", ["-c", script], { cwd: process.cwd(), stdio: "ignore" });
setInterval(() => {}, 1000);
`;

function manifest(nodePath, nodeSha, entryPath, entrySha) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["src"],
    ownershipByTask: { deadline: ["src"], cancel: ["src"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: entryPath, sha256: entrySha },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: nodePath, sha256: nodeSha },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 3,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 900_000,
      maxAttemptElapsedMs: 600_000,
      // 유예는 짧게: 손자가 TERM으로 죽지 않으므로 KILL까지 가는 시간이 그대로 acceptance 시간이다.
      cleanupTermGraceMs: 200,
      cleanupKillGraceMs: 2_000,
    },
    operationAuthorityByTask: {
      deadline: [
        { authorityId: "probe", kind: "run_process", action: "validate-plan", data: { planPath: "src/deadline.json" }, timeoutMs: DEADLINE_MS },
      ],
      cancel: [
        { authorityId: "probe", kind: "run_process", action: "validate-plan", data: { planPath: "src/cancel.json" }, timeoutMs: CANCEL_TIMEOUT_MS },
      ],
    },
    maxSessions: 4,
    maxTokens: 10_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}

const body = (type) => REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
const seed = (taskId) => ({
  taskId,
  roleId: "tech-lead",
  title: `${taskId} 제목`,
  scope: `${taskId} bounded scope`,
  ownership: ["src"],
  assignmentMessageId: `asg-${taskId}`,
  assignmentBody: body("task_assignment"),
});

/** ①②에서 실제로 관측한 손자 pid. ③이 **reparent된 유출까지** 보기 위해 모은다. */
const observedGrandchildren = [];
let ws;
let planDir;
let toolDir;
const baselinePids = childPids();
try {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "m5-cleanup-ws-")));
  planDir = realpathSync(mkdtempSync(join(tmpdir(), "m5-cleanup-plans-")));
  toolDir = realpathSync(mkdtempSync(join(tmpdir(), "m5-cleanup-tool-")));
  mkdirSync(join(ws, "src"), { recursive: true });

  // 승인 digest는 **실제 파일에서** 계산한다 — 다르면 spawn 자체가 일어나지 않는다.
  const entryPath = join(toolDir, "controller.mjs");
  writeFileSync(entryPath, CONTROLLER_SRC);
  chmodSync(entryPath, 0o755); // 실행 비트 필수 · group/other 쓰기 금지(executionBoundary 계약)
  chmodSync(toolDir, 0o755);
  const nodePath = realpathSync(process.execPath);

  const kernel = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(nodePath, sha256File(nodePath), entryPath, sha256File(entryPath)),
    clock,
  });

  const plan = { operations: [{ operationId: "op-1", kind: "run_process", authorityId: "probe" }], result: { summary: "프로세스 감독 검증", outputs: [] } };

  // ── ① deadline: 손자가 생기고, 초과 시 자손까지 사라진다 ────────────────────
  console.log("\n① deadline 초과 — 자손까지 정리");
  {
    kernel.createRootTask(seed("deadline"));
    writeFileSync(join(planDir, "deadline.json"), JSON.stringify(plan));

    let grandchild = null;
    const watcher = (async () => {
      if (await awaitFile(join(ws, "deadline.pid"), DEADLINE_MS + OBSERVE_MS)) {
        grandchild = Number(readFileSync(join(ws, "deadline.pid"), "utf8").trim());
      }
    })();

    const report = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock });
    await watcher;

    check("승인된 controller가 실제로 손자를 낳았다(pid 관측)", Number.isInteger(grandchild) && grandchild > 1, String(grandchild));
    if (Number.isInteger(grandchild)) observedGrandchildren.push(grandchild);
    check("deadline 초과 뒤 손자가 실제로 죽었다(ESRCH)", grandchild !== null && (await awaitGone(grandchild)), `pid=${grandchild}`);

    const task = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).getTask("deadline");
    check("hang 없이 paused로 착지한다", task.state === "paused", task.state);
    check("성공 영수증이 없다(applied 0)", task.execution.operationReceipts.every((r) => r.marker !== "applied"),
      task.execution.operationReceipts.map((r) => r.marker).join(","));
    check("미확정 pending이 남지 않았다", task.execution.pendingOperations.length === 0);
    check("marker가 프로세스 실패 계열이다", report.tasks[0]?.marker === "process_failed", String(report.tasks[0]?.marker));
  }

  // ── ② cancellation: 배리어를 관측한 뒤 abort → SIGKILL 경로까지 ─────────────
  console.log("\n② cancellation — 배리어 뒤 abort");
  {
    openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).createRootTask(seed("cancel"));
    writeFileSync(join(planDir, "cancel.json"), JSON.stringify(plan));

    const ac = new AbortController();
    let grandchild = null;
    const watcher = (async () => {
      // **배리어**: ready는 손자가 trap을 설치한 **뒤에** 쓴다. 그것을 본 뒤에만 취소한다.
      if (!(await awaitFile(join(ws, "cancel.ready"), OBSERVE_MS * 2))) return;
      grandchild = Number(readFileSync(join(ws, "cancel.pid"), "utf8").trim());
      ac.abort();
    })();

    const report = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock, signal: ac.signal });
    await watcher;

    check("취소 전에 손자가 살아 있었다(ready 배리어 관측)", Number.isInteger(grandchild) && grandchild > 1, String(grandchild));
    if (Number.isInteger(grandchild)) observedGrandchildren.push(grandchild);
    check("취소 뒤 손자가 실제로 죽었다(ESRCH)", grandchild !== null && (await awaitGone(grandchild)), `pid=${grandchild}`);
    check("손자는 SIGTERM을 받고도 살아 있었다 → SIGKILL 경로를 밟았다", existsSync(join(ws, "cancel.term")));

    const task = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).getTask("cancel");
    check("취소된 task도 hang 없이 paused로 착지한다", task.state === "paused", task.state);
    check("성공 영수증이 없다(applied 0)", task.execution.operationReceipts.every((r) => r.marker !== "applied"),
      task.execution.operationReceipts.map((r) => r.marker).join(","));
    check("미확정 pending이 남지 않았다", task.execution.pendingOperations.length === 0);
    check("run이 취소로 멈췄다", report.stoppedBecause === "cancelled", report.stoppedBecause);
  }

  // ── ③ 잔존 프로세스 0 ────────────────────────────────────────────────────
  console.log("\n③ 잔존 프로세스 0");
  {
    // ①②에서 **실제로 두 번 spawn했다** — 그래서 이 체크는 구조적 green이 아니다.
    const survivors = [...childPids()].filter((pid) => !baselinePids.has(pid));
    // `ps` 자신이 자식으로 잡히므로 한 번 더 걷어낸다(관측 도구는 잔존이 아니다).
    const still = survivors.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code !== "ESRCH";
      }
    });
    // **라벨을 측정값에 맞춘다**: `childPids()`는 `ppid === process.pid`인 **직계 자식**만 센다.
    // 유출된 손자는 부모가 죽는 순간 init으로 reparent되므로 여기에 잡히지 않는다 — 그래서 이 체크
    // 하나로 "자손 0"을 주장하면 과대주장이다(SIGKILL 승격을 제거하는 mutation에서 실제로 이 체크만
    // green으로 남는 것을 확인했다). 진짜 자손 판정은 **관측한 손자 pid를 직접 보는** 아래 체크다.
    check("직계 자식이 남지 않았다", still.length === 0, still.join(","));
    const leaked = observedGrandchildren.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code !== "ESRCH";
      }
    });
    check("관측한 손자 전부가 사라졌다(reparent된 유출까지 본다)", observedGrandchildren.length > 0 && leaked.length === 0,
      `관측=${observedGrandchildren.length} 잔존=${leaked.join(",") || 0}`);
  }
} catch (e) {
  fail += 1;
  console.log(`  FAIL 예외 발생 — ${e && e.stack ? e.stack : String(e)}`);
} finally {
  for (const dir of [ws, planDir, toolDir]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 임시 디렉터리 정리 실패는 판정을 바꾸지 않는다 */
    }
  }
}

console.log("");
console.log("===================================");
console.log(` M5 descendant cleanup acceptance: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
