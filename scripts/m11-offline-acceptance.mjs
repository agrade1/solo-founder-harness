#!/usr/bin/env node
/**
 * V3 M11 — **사용자 결정 4건의 acceptance**(offline · **live LLM 0회 · 무과금**).
 *
 * 2026-08-23에 사용자가 내린 결정 넷 중 **증명할 것이 있는 셋**을 여기서 밟는다
 * (`C-93`은 문서 한정이라 코드로 밟을 것이 없다 — 로드맵 본문이 그 결정의 산출물이다).
 *
 * ## ① `C-80` — "중복 merge 없음"을 아키텍처에 맞게 다시 쓴 조건이 **공허하지 않다**
 *
 * M10 완료 조건은 v2 `mergeCoordinator`(세션 브랜치 → base 직렬 병합)를 전제로 쓰였는데 M9/M10은
 * 그 구조가 아니다. 새 조건은 **"단일 run workspace + 소유권 직렬화 + attempt 신원으로 중복 발행이
 * 표현 불가"** 다. 그 대체가 말뿐이 아니라는 것을 여기서 못 박는다 — 특히 **세션 브랜치가 애초에
 * 생기지 않는다**(`worktree add --detach` · 닫힌 action 집합에 branch/merge/push가 없다)는 다리는
 * 지금까지 어떤 테스트도 잡고 있지 않았다.
 *
 * ## ② `C-86` — worker 세션의 자격증명 신원이 승인 축이다
 *
 * 실행 파일만 승인하고 신원을 비우는 조합이 **표현 불가**가 됐는지 본다.
 *
 * ## ③ `C-98` — 리뷰 왕복을 loop가 강제한다
 *
 * 승인이 `reviewRoundtrip`을 담으면 `verify`는 계약을 통과해야만 완료된다. **대조군**(리뷰어를 저자와
 * 같은 엔진으로)이 실제로 막히는지 함께 본다 — 그것이 없으면 이 절은 공허하다.
 *
 * ## 증명하지 않는 것
 *   - live 왕복(모델 0회). C-98의 live 증명은 `scripts/m10-live-t7.mjs`가 한다.
 *   - `C-86`의 **live** 증명: 승인된 홈에 사람이 1회 로그인해야 하므로 여기서는 계약·짝 강제까지다.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { createOrchestrationRun, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { GIT_WORKTREE_ACTIONS, CONTROLLER_ACTIONS, REQUIRED_BODY_HEADINGS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));
const { validateApprovalManifest } = await import(join(REPO_ROOT, "src/exec/approvalManifest.ts"));
const { runAutopilot, CODEX_REVIEWER_ROLE_FAMILY } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));

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
const dirs = [];
function makeDir(prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 결과를 바꾸지 않는다 */
    }
  }
});
const codeOf = (fn) => {
  try {
    fn();
    return "(통과)";
  } catch (e) {
    return e?.code ?? String(e);
  }
};

const RUN_ID = "m11-acc";
const MILESTONE = "m11-acc";
const T0 = Date.parse("2026-08-23T00:00:00.000Z");
const sha = (c) => c.repeat(64);
const body = () => REQUIRED_BODY_HEADINGS.task_assignment.map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");

function loggedInHome(prefix) {
  const d = makeDir(prefix);
  chmodSync(d, 0o700);
  writeFileSync(join(d, ".credentials.json"), "{}\n", { mode: 0o600 });
  return { path: d };
}

function manifestFor(taskIds, over = {}) {
  const ownershipByTask = {};
  for (const id of taskIds) ownershipByTask[id] = ["docs", "src"];
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask,
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: { path: "/opt/harness/codex", sha256: sha("c") },
      controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: sha("9") },
      git: { path: "/opt/harness/git", sha256: sha("d") },
      node: { path: "/opt/harness/node", sha256: sha("e") },
      processObserver: { path: "/opt/harness/ps", sha256: sha("f") },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 900_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    maxSessions: 8,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

console.log("\nV3 M11 offline acceptance — 사용자 결정 4건 (live LLM 0회 · 무과금)");

// ── ① `C-80` — 중복 merge 조건의 대체가 공허하지 않다 ────────────────────────
console.log("\n[① C-80] 병합 단계가 **존재하지 않는다**는 것이 조건의 근거다");

// 다리 1: 세션 브랜치를 만들 action 자체가 없다. `add`/`remove`뿐이고 `--detach`이므로 브랜치가 생기지
// 않는다 → 병합할 대상이 애초에 없다. 이 집합이 조용히 자라면 여기서 red다.
check(
  "닫힌 worktree action 집합에 branch/merge/push가 없다",
  JSON.stringify([...GIT_WORKTREE_ACTIONS]) === JSON.stringify(["add", "remove"]),
  JSON.stringify([...GIT_WORKTREE_ACTIONS]),
);
check(
  "닫힌 controller action 집합에도 merge/push가 없다",
  ![...CONTROLLER_ACTIONS].some((a) => /merge|push|branch|remote/i.test(a)),
  JSON.stringify([...CONTROLLER_ACTIONS]),
);

// 다리 2: 승인 문서에 브랜치·remote·refspec을 담을 자리가 없다(있으면 원격 쓰기가 표현 가능해진다).
// **거부 코드까지 못 박는다**: 여분 필드는 닫힌 key 집합이(`invalid_manifest`), 없는 action은 닫힌
// action 집합이(`operation_action_not_approved`) 막는다 — 두 방어가 서로 다른 자리라는 것이 계약이다.
// "무엇이든 거부되기만 하면 통과"로 두면 방어가 하나로 줄어도 green이다.
for (const [label, record, expected] of [
  ["branch 필드", { kind: "git_worktree", authorityId: "w1", action: "add", branch: "feat/x" }, "invalid_manifest"],
  ["remote 필드", { kind: "git_worktree", authorityId: "w1", action: "add", remote: "origin" }, "invalid_manifest"],
  ["merge action", { kind: "git_worktree", authorityId: "w1", action: "merge" }, "operation_action_not_approved"],
  ["push action", { kind: "git_worktree", authorityId: "w1", action: "push" }, "operation_action_not_approved"],
]) {
  const got = codeOf(() =>
    validateApprovalManifest(manifestFor(["root"], { operationAuthorityByTask: { root: [record] } })),
  );
  check(`승인 문서가 worktree ${label}를 표현할 수 없다(${expected})`, got === expected, got);
}

// 다리 3: 대조군 — 정상 record는 통과한다(위 셋이 "전부 거부"라서 통과한 것이 아니다).
{
  const got = codeOf(() =>
    validateApprovalManifest(
      manifestFor(["root"], { operationAuthorityByTask: { root: [{ kind: "git_worktree", authorityId: "w1", action: "add" }] } }),
    ),
  );
  check("대조군: 필드 없는 정상 worktree record는 통과한다(검사가 공허하지 않다)", got === "(통과)", got);
}

// ── ② `C-86` — worker 세션의 자격증명 신원이 승인 축이다 ──────────────────────
console.log("\n[② C-86] 실행 파일과 신원은 짝이다");

const workerBin = (() => {
  const d = makeDir("m11-bin-");
  const f = join(d, "worker.mjs");
  writeFileSync(f, `#!${process.execPath}\nprocess.stdout.write("{}");\n`, { mode: 0o700 });
  return f;
})();
const { createHash } = await import("node:crypto");
const { readFileSync } = await import("node:fs");
const binRecord = { path: workerBin, sha256: createHash("sha256").update(readFileSync(workerBin)).digest("hex") };

function bootLive(authorityOver) {
  const ws = makeDir("m11-ws-");
  const base = manifestFor(["root"]);
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: { ...base, executionAuthority: { ...base.executionAuthority, ...authorityOver } },
    clock: () => new Date(T0),
  });
  k.createRootTask({
    taskId: "root",
    roleId: "dev-lead",
    title: "root",
    scope: "bounded",
    ownership: ["docs", "src"],
    assignmentMessageId: "asg-root",
    assignmentBody: body(),
  });
  return { ws, planDir: makeDir("m11-plans-") };
}

async function liveStoppedBecause(authorityOver) {
  const f = bootLive(authorityOver);
  let n = 0;
  const report = await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: f.planDir,
    clock: () => new Date(T0 + 60_000 + n++ * 1000),
    workerBackend: "claude-plan",
  });
  return { report, ws: f.ws };
}

{
  const { report } = await liveStoppedBecause({ claude: binRecord }); // claudeHome 없음
  check(
    "실행 파일만 승인하고 신원을 비우면 live worker는 시작조차 하지 않는다",
    report.blocked === "run_unavailable" && report.stoppedBecause === "worker_backend_unapproved",
    `${report.blocked}/${report.stoppedBecause}`,
  );
}
{
  const empty = makeDir("m11-empty-home-");
  chmodSync(empty, 0o700);
  const { report } = await liveStoppedBecause({ claude: binRecord, claudeHome: { path: empty } });
  check(
    "승인된 신원 디렉터리가 비어 있으면(=로그인 없음) 거부한다",
    report.stoppedBecause === "claude_config_not_logged_in",
    report.stoppedBecause,
  );
}
{
  const real = loggedInHome("m11-real-home-");
  const link = join(makeDir("m11-link-"), "home");
  symlinkSync(real.path, link);
  const { report } = await liveStoppedBecause({ claude: binRecord, claudeHome: { path: link } });
  check("신원 디렉터리 자리의 symlink는 거부한다", report.stoppedBecause === "claude_config_invalid", report.stoppedBecause);
}
{
  // 대조군: 계약을 지킨 신원이면 승인 게이트를 **지난다**(위 거부들이 "무조건 거부"가 아니다).
  // worker 자체는 계획을 내지 못하므로 run은 진행하되 `run_unavailable`은 아니어야 한다.
  const { report } = await liveStoppedBecause({ claude: binRecord, claudeHome: loggedInHome("m11-ok-home-") });
  check(
    "대조군: 계약을 지킨 신원은 승인 게이트를 지난다(무조건 거부가 아니다)",
    report.blocked !== "run_unavailable",
    `${report.blocked}/${report.stoppedBecause}`,
  );
}

// ── ③ `C-98` — 리뷰 왕복을 loop가 강제한다 ───────────────────────────────────
console.log("\n[③ C-98] 승인이 왕복을 요구하면 verify는 계약을 통과해야만 완료된다");

const RT_IDS = ["impl", "rev-code", "rev-sec", "rev-test", "revise", "verify"];
const ROUNDTRIP = {
  author: "impl",
  reviews: { code: "rev-code", security: "rev-sec", test: "rev-test" },
  revision: "revise",
  verify: "verify",
};

/** 승인만 바꿔 **시작 판정**을 본다(turn을 돌리지 않는다 — 거부가 상태를 건드리지 않는지 보려는 것이다). */
async function runRoundtripBoot(roundtrip) {
  const ws = makeDir("m11-rt-boot-ws-");
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(RT_IDS, { reviewRoundtrip: roundtrip }),
    clock: () => new Date(T0),
  });
  k.createRootTask({
    taskId: "impl",
    roleId: "dev-lead",
    title: "impl",
    scope: "bounded",
    ownership: ["docs", "src"],
    assignmentMessageId: "asg-impl",
    assignmentBody: body(),
  });
  return runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir: makeDir("m11-rt-boot-plans-"),
    clock: () => new Date(T0 + 60_000),
    maxIterations: 4,
  });
}

async function runRoundtrip(reviewRoleId, declare) {
  const ws = makeDir("m11-rt-ws-");
  const planDir = makeDir("m11-rt-plans-");
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(RT_IDS, declare ? { reviewRoundtrip: ROUNDTRIP } : {}),
    clock: () => new Date(T0),
  });
  const roleOf = (id) => (id.startsWith("rev-") ? reviewRoleId : id === "verify" ? `${CODEX_REVIEWER_ROLE_FAMILY}.verify` : "dev-lead");
  const seed = (id) => ({
    taskId: id,
    roleId: roleOf(id),
    title: id,
    scope: "bounded",
    ownership: ["docs", "src"],
    assignmentMessageId: `asg-${id}`,
    assignmentBody: body(),
  });
  k.createRootTask(seed("impl"));
  for (const id of RT_IDS.slice(1, 4)) k.createDependentTask({ ...seed(id), dependsOn: ["impl"] });
  k.createDependentTask({ ...seed("revise"), dependsOn: RT_IDS.slice(1, 4) });
  k.createDependentTask({ ...seed("verify"), dependsOn: ["revise"] });
  for (const id of RT_IDS) {
    writeFileSync(join(planDir, `${id}.json`), JSON.stringify({ operations: [], result: { summary: `${id} 완료`, outputs: [] } }));
  }
  let n = 0;
  const events = [];
  await runAutopilot({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    clock: () => new Date(T0 + 60_000 + n++ * 1000),
    maxIterations: 8,
    onEvent: (e) => events.push(e),
  });
  const k2 = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: () => new Date(T0 + 900_000) });
  return { verify: k2.getTask("verify"), events, kernel: k2 };
}

{
  const ok = await runRoundtrip(`${CODEX_REVIEWER_ROLE_FAMILY}.code`, true);
  check("정상 왕복은 완주한다", ok.verify?.state === "completed", ok.verify?.state);

  const bad = await runRoundtrip("dev-lead", true);
  check(
    "대조군: 리뷰어가 저자와 같은 엔진이면 verify가 완료되지 않는다",
    bad.verify?.state === "paused",
    bad.verify?.state,
  );
  const why = bad.events.filter((e) => e.kind === "task_paused" && e.taskId === "verify").map((e) => e.detail);
  check("거부 이유가 원인 코드로 올라온다(marker 하나로 뭉개지 않는다)", why.includes("reviewer_provider"), JSON.stringify(why));
  check(
    "막힌 turn은 결과를 발행하지 않았다",
    bad.kernel.getState().messages.filter((m) => m.type === "result" && m.taskId === "verify").length === 0,
  );

  // 반대 방향: 승인이 요구하지 않으면 같은 DAG가 그대로 완주한다(게이트가 늘 막는 것이 아니다).
  const undeclared = await runRoundtrip("dev-lead", false);
  check(
    "승인이 왕복을 요구하지 않으면 게이트는 돌지 않는다",
    undeclared.verify?.state === "completed",
    undeclared.verify?.state,
  );

  // **게이트가 조용히 사라지는 경로를 막는다**(M11 적대적 리뷰 A-1): 게이트는 `verify`인 turn에서만
  // 도므로 승인이 **존재하지 않는 task**를 verify로 지목하면 한 번도 돌지 않고 run이 완주해버렸다
  // (오타 하나로 강제가 사라진다). 이제 **시작 전에** 여섯 참가자의 실재를 요구한다.
  const typo = await runRoundtripBoot({ ...ROUNDTRIP, verify: "verify-fx" });
  check(
    "승인이 존재하지 않는 참가자를 지목하면 run이 시작조차 하지 않는다",
    typo.blocked === "run_unavailable" && typo.stoppedBecause === "roundtrip_participant_missing",
    `${typo.blocked}/${typo.stoppedBecause}`,
  );
  check("그 거부는 어떤 task도 건드리지 않았다", typo.tasks.length === 0, JSON.stringify(typo.tasks));
}

console.log(
  "\n이 스크립트가 증명하지 않는 것: live 왕복(모델 0회 — C-98의 live 증명은 m10-live-t7.mjs) · " +
    "`C-86`의 live 증명(승인된 홈에 사람이 1회 로그인해야 한다) · " +
    "`C-98` 잔여(앞선 참가자의 개별 결과 발행은 게이트 시점에 이미 끝났다) · " +
    "`C-93`은 문서 한정이라 코드로 밟을 것이 없다",
);
console.log("\n===================================");
console.log(` M11 결정 acceptance 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
