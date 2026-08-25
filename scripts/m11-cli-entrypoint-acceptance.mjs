#!/usr/bin/env node
/**
 * V3 M11 — **무인 loop CLI 진입점 acceptance**(offline · **live LLM 0회 · 무과금**).
 *
 * 이 slice가 고친 관문은 "조각은 다 있는데 CLI에서 닿을 수 없다"였다:
 * `createOrchestrationRun`·`materializeTaskDag`의 CLI 호출부가 0건, `runAutopilot`의 `workerBackend`가
 * 노출 안 됨, `--plan-dir`이 live에서 읽히지도 않으면서 `requiredOption`. 그래서 이 스크립트는
 * **실제 argv로 `src/cli.ts`를 띄운다** — 함수를 직접 부르면 배선 자체(옵션 등록·arity·exit code)를
 * 밟지 못하고, 그 배선이 정확히 이 slice가 고친 것이다.
 *
 * **왜 새 스크립트인가**: `scripts/m11-offline-acceptance.mjs`는 "2026-08-23 사용자 결정 4건"의 증거
 * 문서이고 전부 in-process 함수 호출이다. 주제(운영자 진입점)와 방법(subprocess argv)이 둘 다 다르므로
 * 그 파일에 얹으면 두 증거가 섞인다. 대신 `AUTOPILOT_WORKER_BACKENDS` 같은 계약 상수는 그쪽과 같은
 * 모듈에서 읽는다(사본을 만들지 않는다).
 *
 * ## 증명하지 않는 것 (같은 무게로 적는다)
 *
 * - **live 경로가 실제로 도는지는 여기서 증명되지 않는다.** `claude-plan`은 승인 게이트에서 거부되는
 *   것까지만 밟는다(모델 0회 · 프로세스 0). "승인이 있으면 세션이 실제로 돌아 계획을 낸다"는 live
 *   실행으로만 닫힌다(`scripts/m10-live-autopilot.mjs` 계열).
 * - `--worker-backend claude-plan`이 승인을 지난 뒤의 행동(프롬프트·모델 argv·리뷰어 라우팅)도
 *   여기 범위 밖이다 — 그 축들은 M10/M11의 기존 스크립트가 담당한다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const CLI = join(REPO_ROOT, "src/cli.ts");
const { openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runPaths } = await import(join(REPO_ROOT, "src/exec/orchestrationStore.ts"));
const { AUTOPILOT_WORKER_BACKENDS } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));

const [OFFLINE, LIVE] = AUTOPILOT_WORKER_BACKENDS;

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

/** 실제 CLI를 argv로 띄운다. 반환은 exit code + 합친 출력뿐이다(사람이 보는 것과 같은 표면). */
function cli(...args) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const RUN_ID = "m11-cli";
const MILESTONE = "m11-cli";
const sha = (c) => c.repeat(64);

function manifestDoc(over = {}) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask: { plan: ["docs"], build: ["src"] },
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
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2027-12-31T00:00:00.000Z",
    ...over,
  };
}

function dagDoc(over = {}) {
  return {
    schemaVersion: "1",
    tasks: [
      { taskId: "plan", roleId: "tech-lead", title: "계획 수립", scope: "docs 아래 계획 문서만 만든다", ownership: ["docs"], dependsOn: [], provides: ["docs/plan.md"] },
      { taskId: "build", roleId: "dev-lead", title: "구현", scope: "src 아래 구현만 한다", ownership: ["src"], dependsOn: ["plan"], consumes: ["docs/plan.md"] },
    ],
    ...over,
  };
}

/** 파일 두 개 + 빈 workspace. 계획 파일은 필요한 테스트만 넣는다. */
function docs(manifest = manifestDoc(), dag = dagDoc()) {
  const d = makeDir("m11-cli-docs-");
  const approval = join(d, "approval.json");
  const dagFile = join(d, "dag.json");
  writeFileSync(approval, JSON.stringify(manifest, null, 2));
  writeFileSync(dagFile, JSON.stringify(dag, null, 2));
  return { ws: makeDir("m11-cli-ws-"), approval, dag: dagFile };
}

const createArgs = (f) => ["autopilot-create", "--workspace", f.ws, "--run", RUN_ID, "--milestone", MILESTONE, "--approval", f.approval, "--dag", f.dag];
const runArgs = (f, ...extra) => ["autopilot", "--workspace", f.ws, "--run", RUN_ID, "--milestone", MILESTONE, ...extra];

console.log("\nV3 M11 — 무인 loop CLI 진입점 acceptance (live LLM 0회 · 무과금)");

// ── ① autopilot-create: 계약을 어긴 문서는 fail closed다 ─────────────────────
console.log("\n[①] 승인·DAG 문서가 계약을 어기면 그대로 fail closed (기존 코드로)");

for (const [label, manifest, expected] of [
  ["approvedCommit 형식 위반", manifestDoc({ approvedCommit: "짧다" }), "invalid_manifest"],
  ["미상 필드", manifestDoc({ 여분: true }), "invalid_manifest"],
  // 빠진 필드를 **채워 주지 않는다** — 채우면 그것이 곧 harness가 승인을 발행하는 것이다.
  ["expiresAt 부재", (() => { const m = manifestDoc(); delete m.expiresAt; return m; })(), "invalid_manifest"],
  ["M5c 이전 승인", (() => { const m = manifestDoc(); delete m.autopilotPolicy; return m; })(), "manifest_pre_m5c_unsupported"],
  ["JSON이 아니다", null, "invalid_manifest"],
]) {
  const f = docs(manifest ?? manifestDoc());
  if (manifest === null) writeFileSync(f.approval, "{ JSON 아님");
  const r = cli(...createArgs(f));
  check(`승인 파일 ${label} → exit 2 · ${expected}`, r.status === 2 && r.out.includes(expected), `${r.status} ${r.out.trim()}`);
  check(`  그 거부는 run을 만들지 않았다(${label})`, !existsSync(runPaths(f.ws, RUN_ID).stateFile));
}

for (const [label, dag, expected] of [
  ["미상 필드", dagDoc({ 여분: true }), "invalid_dag_document"],
  [
    "순환",
    dagDoc({
      tasks: [
        { taskId: "plan", roleId: "tech-lead", title: "a", scope: "a", ownership: ["docs"], dependsOn: ["build"] },
        { taskId: "build", roleId: "dev-lead", title: "b", scope: "b", ownership: ["src"], dependsOn: ["plan"] },
      ],
    }),
    "dependency_cycle",
  ],
  [
    "동시에 돌 두 task가 같은 경로를 소유",
    dagDoc({
      tasks: [
        { taskId: "plan", roleId: "tech-lead", title: "a", scope: "a", ownership: ["docs"], dependsOn: [] },
        { taskId: "build", roleId: "dev-lead", title: "b", scope: "b", ownership: ["docs"], dependsOn: [] },
      ],
    }),
    "ownership_conflict",
  ],
]) {
  const f = docs(manifestDoc(), dag);
  const r = cli(...createArgs(f));
  check(`DAG 문서 ${label} → exit 2 · ${expected}`, r.status === 2 && r.out.includes(expected), `${r.status} ${r.out.trim()}`);
  // **run 생성보다 문서 검증이 먼저다**: 아니면 계약을 어긴 문서가 task 0개인 run을 남기고
  // 그 뒤 재시도는 "기존 run 이어받기"로 보인다.
  check(`  그 거부는 run을 만들지 않았다(${label})`, !existsSync(runPaths(f.ws, RUN_ID).stateFile));
}

// ── ② autopilot-create: 정상 파일 → run + 물질화 · 재호출은 중복 0 ───────────
console.log("\n[②] 정상 문서 → run 생성 + task 물질화 · 다시 불러도 중복 생성 0");

const okDocs = docs();
{
  const first = cli(...createArgs(okDocs));
  check("정상 문서로 run이 생성된다", first.status === 0 && first.out.includes("run 생성"), `${first.status} ${first.out.trim()}`);
  const k = openOrchestrationRun({ workspaceRoot: okDocs.ws, runId: RUN_ID });
  const ids = k.getState().tasks.map((t) => t.taskId).sort();
  check("문서의 task 두 개가 durable에 실재한다", JSON.stringify(ids) === JSON.stringify(["build", "plan"]), JSON.stringify(ids));
  check("의존 간선이 문서 그대로다", JSON.stringify(k.getTask("build")?.dependsOn) === JSON.stringify(["plan"]));
  // 승인은 **파일에서 온 그대로**다 — 이 명령이 만든 필드가 없다.
  check("승인이 파일 그대로 bind됐다", k.getManifest().maxSessions === 4 && k.getManifest().maxTokens === 100_000);

  const again = cli(...createArgs(okDocs));
  const after = openOrchestrationRun({ workspaceRoot: okDocs.ws, runId: RUN_ID }).getState().tasks.length;
  check(
    "같은 문서로 다시 불러도 중복 생성이 0이다",
    again.status === 0 && again.out.includes("이번에 만든 task 0건") && after === 2,
    `${again.status} · tasks=${after} · ${again.out.trim()}`,
  );

  // 승인을 갈아끼운 파일로 다시 부르면 거부다(조용한 교체 통로가 없다).
  const swapped = docs(manifestDoc({ maxTokens: 999_999 }));
  const swap = cli("autopilot-create", "--workspace", okDocs.ws, "--run", RUN_ID, "--milestone", MILESTONE, "--approval", swapped.approval, "--dag", okDocs.dag);
  check("바뀐 승인 파일로 재호출하면 거부한다", swap.status === 2 && swap.out.includes("run_already_exists"), `${swap.status} ${swap.out.trim()}`);
  check(
    "그리고 durable 승인은 그대로다",
    openOrchestrationRun({ workspaceRoot: okDocs.ws, runId: RUN_ID }).getManifest().maxTokens === 100_000,
  );
}

// ── ③ --worker-backend: 닫힌 집합 · 기본값 · 승인 게이트 ─────────────────────
console.log("\n[③] --worker-backend는 닫힌 집합이고 기본값은 offline이다");

{
  const bogus = cli(...runArgs(okDocs, "--worker-backend", "gpt-plan", "--plan-dir", makeDir("m11-cli-plans-")));
  // **거부가 backend를 지목해야 한다.** exit code만 보면 검사를 지워도 green이다 —
  // 그때는 `runAutopilot`이 run을 열고 lease를 잡은 뒤 `run_unavailable`로 접기 때문이다.
  check(
    "집합 밖 backend는 거부되고 그 이유가 --worker-backend를 지목한다",
    bogus.status === 2 && bogus.out.includes("--worker-backend") && bogus.out.includes(LIVE),
    `${bogus.status} ${bogus.out.trim()}`,
  );
}

// 기본값 축: 승인에 `executionAuthority.claude`가 **없는** run이다 → 기본이 live면 시작조차 못 한다.
// 그래서 "완주했다"가 곧 "기본이 offline이다"의 증거다.
{
  const planDir = makeDir("m11-cli-plans-");
  for (const id of ["plan", "build"]) {
    writeFileSync(join(planDir, `${id}.json`), JSON.stringify({ operations: [], result: { summary: `${id} 완료`, outputs: [] } }));
  }
  const r = cli(...runArgs(okDocs, "--plan-dir", planDir));
  const k = openOrchestrationRun({ workspaceRoot: okDocs.ws, runId: RUN_ID });
  const states = k.getState().tasks.map((t) => `${t.taskId}=${t.state}`).sort();
  check(
    `--worker-backend 미지정은 ${OFFLINE}이다(승인에 claude가 없는데 완주했다)`,
    r.status === 0 && JSON.stringify(states) === JSON.stringify(["build=completed", "plan=completed"]),
    `${r.status} · ${JSON.stringify(states)} · ${r.out.trim()}`,
  );
  // **durable 영수증이 어느 backend로 돌았는지 말한다**(M11 — 이전 판은 `offline-plan`을 하드코딩해서
  // live turn의 결과 본문까지 "offline"이라고 주장했다).
  // 본문이 없으면(위가 완주하지 못했으면) FAIL이다 — 파일이 없다고 스크립트가 죽으면 나머지 축이
  // 조용히 실행되지 않는다(mutation 실행에서 실제로 그랬다).
  const bodyFile = join(runPaths(okDocs.ws, RUN_ID).messagesDir, "res.plan.md");
  const body = existsSync(bodyFile) ? readFileSync(bodyFile, "utf8") : "";
  check(`결과 본문이 backend를 ${OFFLINE}로 적었다`, body.includes(`- backend: ${OFFLINE}`), body.split("\n").slice(0, 4).join(" / ") || "본문 없음");
}

// live backend는 **승인 없으면 시작하지 않는다**. 모델 0회 · 프로세스 0.
{
  const f = docs();
  cli(...createArgs(f));
  const before = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID }).getState();
  const r = cli(...runArgs(f, "--worker-backend", LIVE, "--json"));
  check(
    `${LIVE}인데 승인에 executionAuthority.claude가 없으면 worker_backend_unapproved로 거부한다`,
    r.status === 2 && r.out.includes("worker_backend_unapproved"),
    `${r.status} ${r.out.trim()}`,
  );
  const after = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID }).getState();
  // 이 harness가 worker 프로세스를 띄우는 자리는 turn 하나뿐이고, 그 앞에서 닫혔다는 증거는
  // **attempt가 하나도 열리지 않았다**는 것이다(attempt 없이는 세션이 없다).
  check(
    "  거부는 attempt를 하나도 열지 않았다(= worker 세션에 도달하지 않았다)",
    after.tasks.every((t) => t.execution.attemptNo === 0) && after.revision === before.revision,
    `revision ${before.revision}→${after.revision}`,
  );
}

// ── ④ --plan-dir arity는 backend가 정한다 ────────────────────────────────────
console.log("\n[④] --plan-dir은 offline에서 필수이고 live에서는 받지 않는다");

{
  const missing = cli(...runArgs(okDocs));
  check(
    `${OFFLINE}인데 --plan-dir이 없으면 거부한다(빈 디렉터리로 취급하지 않는다)`,
    missing.status === 2 && missing.out.includes("--plan-dir"),
    `${missing.status} ${missing.out.trim()}`,
  );
  const both = cli(...runArgs(okDocs, "--worker-backend", LIVE, "--plan-dir", makeDir("m11-cli-plans-")));
  check(
    `${LIVE}에 --plan-dir을 주면 거부한다(읽지 않는 인자를 조용히 받지 않는다)`,
    both.status === 2 && both.out.includes("--plan-dir"),
    `${both.status} ${both.out.trim()}`,
  );
  // 대조군: 같은 명령에서 --plan-dir을 주면 통과한다(위 두 거부가 "무조건 거부"가 아니다).
  const ok = cli(...runArgs(okDocs, "--plan-dir", makeDir("m11-cli-plans-")));
  check("대조군: offline + --plan-dir은 거부되지 않는다", ok.status === 0, `${ok.status} ${ok.out.trim()}`);
}

console.log(
  "\n이 스크립트가 증명하지 않는 것: **live 경로가 실제로 도는 것**(모델 0회 — `claude-plan`은 승인 게이트 " +
    "거부까지만 밟는다) · 승인된 live 세션의 프롬프트·모델 argv·리뷰어 라우팅(M10/M11 기존 스크립트 담당) · " +
    "`autopilot-create`가 만든 run을 live로 완주시키는 것",
);
console.log("\n===================================");
console.log(` M11 CLI 진입점 acceptance 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
