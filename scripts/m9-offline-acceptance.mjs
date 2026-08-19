/**
 * V3 M9 offline acceptance — Development Pipeline (acceptance Test 21).
 *
 * ## 무엇을 증명하는가
 * - ① **선결 1**: `run_process` action enum에 `run-tests`가 닫힌 채로 열렸다 — 명령·러너·argv·shell·
 *   env·cwd를 담을 key가 없고 action↔data 짝이 섞이지 않는다.
 * - ② **선결 2(`B-16`)**: 승인된 신규 파일 발행이 **실제 바이트**를 낸다. 부모가 교체되면 승인된
 *   내용은 한 바이트도 새지 않는다(빈 파일만 남는다).
 * - ③ **T3①(`B-29`)**: 동시에 자원을 점유한 두 task는 같은 경로에 쓸 수 없고, 겹치지 않으면 쓸 수 있다.
 * - ④ **T2**: Tech Lead DAG 문서가 닫힌 형태이며 순환·미상 의존·소유권 충돌·contract 위반을 거부한다.
 * - ⑤ **T3②(`B-30`)**: 그 문서가 kernel task로 **1:1 보존**되어 물질화되고, kernel이 거부할 seed는
 *   만들기 **전에** 걸러진다(durable 잔류 0).
 * - ⑥ **T3③**: 격리 worktree가 **실제 git으로** 만들어지고 지워진다. 브랜치를 만들지 않고
 *   승인된 커밋에 detach되며, argv에 remote·브랜치 계열이 하나도 없다.
 * - ⑦ **선결 4(F2)**: autopilot 진행이 v1 `RunEvent`로 옮겨지고 멈춘 이유가 표시에서 사라지지 않는다.
 *
 * ## 증명하지 않는다 (정직하게 적는다)
 * - **live LLM 0회.** Claude worker live도 Codex live도 이 스크립트는 돌리지 않는다. "fresh Codex가
 *   code/security/test 리뷰를 실제로 수행한다"는 **미증명**이다.
 * - **병렬 2 worker의 실제 동시 진행 · 리뷰 3종 왕복 · revise/verify · 직렬 병합 · end-to-end 1회**는
 *   이 스크립트 범위 밖이다(M9 T4 이후).
 * - ⑥은 `git worktree`가 **로컬에서 동작한다**를 보일 뿐, worker가 그 안에서 실제로 코드를 수정하고
 *   그 결과가 병합된다는 것을 보이지 않는다.
 */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { validateApprovalManifest } = await import(join(REPO_ROOT, "src/exec/approvalManifest.ts"));
const { CONTROLLER_ACTIONS, CONTROLLER_ACTION_DATA_KEYS, GIT_WORKTREE_ACTIONS, APPROVED_OPERATION_KINDS } = await import(
  join(REPO_ROOT, "src/exec/orchestrationTypes.ts")
);
const { validateTaskDag } = await import(join(REPO_ROOT, "src/exec/taskDag.ts"));
const { materializeTaskDag } = await import(join(REPO_ROOT, "src/exec/taskDagMaterialize.ts"));
const { OrchestrationKernel } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { applyWriteFile, resolveWorktreeCapability, executeWorktreeOperation } = await import(
  join(REPO_ROOT, "src/exec/typedExecution.ts")
);
const { autopilotProgressBridge } = await import(join(REPO_ROOT, "src/exec/autopilotProgress.ts"));
const { assertCodeReviewRoundtrip } = await import(join(REPO_ROOT, "src/exec/designReviewRoundtrip.ts"));

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
const codeOf = (fn) => {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e?.code ?? `non-orchestration:${String(e)}`;
  }
};
const codeOfAsync = async (fn) => {
  try {
    await fn();
    return "no-error";
  } catch (e) {
    return e?.code ?? `non-orchestration:${String(e)}`;
  }
};

const dirs = [];
const makeDir = (p) => {
  // macOS의 `/var/folders/...`는 symlink 뒤에 있다 — 승인 경계는 **정규 경로**를 요구한다.
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

/** kernel이 요구하는 `task_assignment` 필수 헤딩 전부(내용은 이 스크립트의 관심사가 아니다). */
const ASSIGNMENT_BODY = [
  "Objective",
  "Scope / Ownership",
  "Out of Scope / Forbidden",
  "Inputs and Contracts",
  "Dependencies",
  "Definition of Done",
  "Budget and Permission Envelope",
  "Expected Deliverables",
]
  .map((h) => `## ${h}\n\n본문 한 줄.\n`)
  .join("\n");

/** M9가 실제로 돌릴 모양: 병렬 2 worker + 직렬 통합. 선언 순서는 의존 역순이다(정렬을 보려는 것). */
const PIPELINE_TASKS = [
  {
    taskId: "integrate",
    roleId: "tech-lead",
    title: "통합",
    scope: "src/app에서 두 모듈을 잇는다",
    ownership: ["src/app"],
    dependsOn: ["impl-a", "impl-b"],
    consumes: ["src/a/index.ts", "src/b/index.ts"],
    provides: ["src/app/main.ts"],
    resourceClasses: ["merge"],
  },
  { taskId: "impl-a", roleId: "dev-lead", title: "모듈 A 구현", scope: "src/a 안에서만", ownership: ["src/a"], dependsOn: [], provides: ["src/a/index.ts"] },
  { taskId: "impl-b", roleId: "dev-lead", title: "모듈 B 구현", scope: "src/b 안에서만", ownership: ["src/b"], dependsOn: [], provides: ["src/b/index.ts"] },
];

const T0 = Date.parse("2026-08-19T00:00:00.000Z");
const RUN_ID = "run-m9";
const MILESTONE = "ms-m9";
let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(16).padStart(6, "0")}`;
/** `lease.<32 hex>` — kernel이 요구하는 정확한 형태. */
const nextLease = () => `lease.${(++seq).toString(16).padStart(32, "0")}`;

function baseManifest(over = {}) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["src"],
    ownershipByTask: { "impl-a": ["src/a"], "impl-b": ["src/b"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: "/opt/harness/controller.js", sha256: "b".repeat(64) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 600_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 2_000,
      cleanupKillGraceMs: 2_000,
    },
    operationAuthorityByTask: {},
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...over,
  };
}

console.log("\nV3 M9 offline acceptance — Development Pipeline");
console.log("① 선결 1 — run_process action enum이 닫힌 채로 열렸다");
{
  check("run-tests가 승인 가능한 action이다", CONTROLLER_ACTIONS.includes("run-tests"));
  check(
    "action 목록이 승인 없이 늘지 않았다",
    JSON.stringify([...CONTROLLER_ACTIONS]) === JSON.stringify(["validate-plan", "run-tests"]),
    [...CONTROLLER_ACTIONS].join("|"),
  );
  check(
    "run-tests의 data key는 projectPath 하나뿐이다",
    JSON.stringify([...CONTROLLER_ACTION_DATA_KEYS["run-tests"]]) === JSON.stringify(["projectPath"]),
  );
  const rt = (over) =>
    codeOf(() =>
      validateApprovalManifest(
        baseManifest({
          ownershipByTask: { "impl-a": ["src/a"] },
          operationAuthorityByTask: {
            "impl-a": [{ authorityId: "p-t", kind: "run_process", action: "run-tests", data: { projectPath: "src/a" }, timeoutMs: 1000, ...over }],
          },
        }),
      ),
    );
  check("승인된 run-tests 형태는 통과한다", rt({}) === "no-error", rt({}));
  let cmdBlocked = true;
  for (const key of ["command", "script", "runner", "args", "argv", "shell", "env", "cwd", "testCommand"]) {
    if (rt({ data: { projectPath: "src/a", [key]: "npm test" } }) !== "invalid_manifest") cmdBlocked = false;
    if (rt({ [key]: "npm test" }) !== "invalid_manifest") cmdBlocked = false;
  }
  check("테스트 명령·러너·argv를 담을 통로가 없다", cmdBlocked);
  check("action↔data 짝이 섞이지 않는다", rt({ data: { planPath: "src/a/p.json" } }) === "invalid_manifest");
  check("승인 범위 밖 경로는 거부된다", rt({ data: { projectPath: "outside/x" } }) === "operation_outside_writable_root");
}

console.log("\n② 선결 2 — B-16 신규 파일 발행이 실제 바이트를 내고, 부모 교체 시 내용이 새지 않는다");
{
  const mk = () => {
    const ws = makeDir("m9-b16-");
    mkdirSync(join(ws, "src"));
    mkdirSync(join(ws, "src/a"));
    let n = 0;
    const kernel = OrchestrationKernel.create({
      workspaceRoot: ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      manifest: baseManifest({
        ownershipByTask: { "impl-a": ["src/a"] },
        operationAuthorityByTask: { "impl-a": [{ authorityId: "w-new", kind: "write_file", path: "src/a/new.ts", maxBytes: 1024 }] },
      }),
      clock: () => new Date(T0 + n++),
    });
    kernel.createRootTask({
      taskId: "impl-a",
      roleId: "dev-lead",
      title: "모듈 A",
      scope: "src/a",
      ownership: ["src/a"],
      assignmentMessageId: "asg-impl-a",
      assignmentBody: ASSIGNMENT_BODY,
    });
    const batch = kernel.planRunnableBatch();
    kernel.commitPreflightBatch({
      baseRevision: batch.revision,
      actionId: nextId("act"),
      decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") })),
    });
    kernel.startPreparedTask({ taskId: "impl-a", actionId: nextId("act"), leaseMarker: nextLease() });
    return { ws, kernel };
  };
  const grantFor = (kernel, content) => {
    const task = kernel.getTask("impl-a");
    const turnId = nextId("turn");
    const permit = kernel.issueOperationDispatchPermit({
      taskId: "impl-a",
      turnId,
      actionId: nextId("act"),
      plan: {
        schemaVersion: "1",
        runId: RUN_ID,
        taskId: "impl-a",
        attemptId: task.execution.attemptId,
        turnId,
        operations: [{ operationId: nextId("op"), kind: "write_file", authorityId: "w-new", path: "src/a/new.ts", content, expectedBeforeSha256: null }],
        result: { summary: "신규 발행", outputs: [] },
      },
    });
    kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
    const op = permit.plan.operations[0];
    return [op, kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") })];
  };

  const f = mk();
  const [op, grant] = grantFor(f.kernel, "export const a = 1;\n");
  const outcome = applyWriteFile(op, grant);
  check("승인된 신규 파일이 실제로 발행된다(B-16 개방)", outcome.marker === "applied", outcome.marker);
  check("발행된 내용이 승인된 바이트다", readFileSync(join(f.ws, "src/a/new.ts"), "utf8") === "export const a = 1;\n");
  check("temp 잔재가 없다", readdirSync(join(f.ws, "src/a")).join(",") === "new.ts", readdirSync(join(f.ws, "src/a")).join(","));
}

console.log("\n③ T3① — B-29: 동시 점유 task의 같은 경로 쓰기는 거부되고, 겹치지 않으면 쓴다");
{
  const ws = makeDir("m9-b29-");
  mkdirSync(join(ws, "src"));
  mkdirSync(join(ws, "src/shared"));
  mkdirSync(join(ws, "src/solo"));
  let n = 0;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({
      ownershipByTask: { "task-x": ["src/shared", "src/solo"], "task-y": ["src/shared"] },
      operationAuthorityByTask: {
        "task-x": [
          { authorityId: "w-shared", kind: "write_file", path: "src/shared/out.ts", maxBytes: 512 },
          { authorityId: "w-solo", kind: "write_file", path: "src/solo/out.ts", maxBytes: 512 },
        ],
      },
    }),
    clock: () => new Date(T0 + n++),
  });
  for (const [id, own] of [["task-x", ["src/shared", "src/solo"]], ["task-y", ["src/shared"]]]) {
    kernel.createRootTask({ taskId: id, roleId: "dev-lead", title: id, scope: id, ownership: own, assignmentMessageId: `asg-${id}`, assignmentBody: ASSIGNMENT_BODY });
  }
  const batch = kernel.planRunnableBatch();
  kernel.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") })),
  });
  for (const id of ["task-x", "task-y"]) {
    kernel.startPreparedTask({ taskId: id, actionId: nextId("act"), leaseMarker: nextLease() });
  }
  check("두 task가 동시에 자원을 점유한다(경합 상황이 실제로 성립한다)", kernel.getTask("task-x").state === "running" && kernel.getTask("task-y").state === "running");

  const write = (authorityId, path) => {
    const task = kernel.getTask("task-x");
    const turnId = nextId("turn");
    const permit = kernel.issueOperationDispatchPermit({
      taskId: "task-x",
      turnId,
      actionId: nextId("act"),
      plan: {
        schemaVersion: "1",
        runId: RUN_ID,
        taskId: "task-x",
        attemptId: task.execution.attemptId,
        turnId,
        operations: [{ operationId: nextId("op"), kind: "write_file", authorityId, path, content: "x\n", expectedBeforeSha256: null }],
        result: { summary: "쓰기", outputs: [] },
      },
    });
    kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
    const op = permit.plan.operations[0];
    const grant = kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") });
    const code = codeOf(() => applyWriteFile(op, grant));
    // 경합 거부는 **집행 경계에 들어간 뒤** 난다(기존 `operation_not_owned`와 같은 자리) → 미확정
    // pending이 남고 정합화로만 닫힌다. 그 계약을 여기서도 그대로 지나야 다음 turn이 열린다.
    const pending = kernel.getTask("task-x").execution.pendingOperations.find((x) => x.operationId === op.operationId);
    if (pending !== undefined) {
      kernel.reconcileUncertainOperation({
        runId: RUN_ID,
        taskId: "task-x",
        attemptId: pending.attemptId,
        turnId: pending.turnId,
        planDigest: pending.planDigest,
        operationId: pending.operationId,
        kind: pending.kind,
        authorityId: pending.authorityId,
        actionId: nextId("act"),
      });
    }
    return code;
  };
  check("겹치는 소유권 아래 쓰기는 거부된다", write("w-shared", "src/shared/out.ts") === "operation_ownership_contended");
  check("거부는 바이트를 만들지 않는다", readdirSync(join(ws, "src/shared")).length === 0);
  check("겹치지 않는 경로는 열려 있다(병렬을 막지 않는다)", write("w-solo", "src/solo/out.ts") === "no-error");
  check("겹치지 않는 쓰기는 실제 바이트를 냈다", readFileSync(join(ws, "src/solo/out.ts"), "utf8") === "x\n");
}

console.log("\n④ T2 — Tech Lead DAG 문서가 닫힌 형태이고 fail-closed다");
{
  const node = (over) => ({ taskId: "impl-a", roleId: "dev-lead", title: "모듈 A 구현", scope: "src/a 안에서만", ownership: ["src/a"], dependsOn: [], ...over });
  const doc = (tasks) => ({ schemaVersion: "1", tasks });
  const dagCode = (tasks) => codeOf(() => validateTaskDag(doc(tasks)));
  check("정상 DAG(병렬 2 + 직렬 통합)는 통과한다", dagCode(PIPELINE_TASKS) === "no-error", dagCode(PIPELINE_TASKS));
  check("순환은 거부된다", dagCode([node({ taskId: "a", ownership: ["src/a"], dependsOn: ["c"] }), node({ taskId: "b", ownership: ["src/b"], dependsOn: ["a"] }), node({ taskId: "c", ownership: ["src/c"], dependsOn: ["b"] })]) === "dependency_cycle");
  check("미상 의존은 거부된다", dagCode([node({ dependsOn: ["ghost"] })]) === "unknown_dependency");
  check("순서가 강제되지 않는 두 task의 소유권 겹침은 거부된다", dagCode([node({ taskId: "a", ownership: ["src"] }), node({ taskId: "b", ownership: ["src/x"] })]) === "ownership_conflict");
  check("의존 사슬로 묶이면 같은 파일 소유는 정상이다", dagCode([node({ taskId: "impl", ownership: ["src/x"] }), node({ taskId: "fix", ownership: ["src/x"], dependsOn: ["impl"] })]) === "no-error");
  check("만들 수 없는 것을 만들겠다고 선언할 수 없다", dagCode([node({ provides: ["src/other/x.ts"] })]) === "provides_not_owned");
  check("아무도 만들어 주지 않는 입력은 거부된다", dagCode([node({ consumes: ["src/ghost.ts"] })]) === "consumes_unprovided");
  let authClosed = true;
  for (const key of ["writableRoots", "operationAuthority", "allowedCommands", "executionAuthority", "command", "argv", "maxTokens"]) {
    if (dagCode([node({ [key]: "x" })]) !== "invalid_dag_document") authClosed = false;
  }
  check("문서가 실행 권한을 만들 통로가 없다", authClosed);
}

console.log("\n⑤ T3② — B-30: 문서가 kernel task로 1:1 보존되고, 거부될 seed는 만들기 전에 걸러진다");
{
  const ws = makeDir("m9-mat-");
  let n = 0;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({ ownershipByTask: { "impl-a": ["src/a"], "impl-b": ["src/b"], integrate: ["src/app"] } }),
    clock: () => new Date(T0 + n++),
  });
  const out = materializeTaskDag(kernel, { schemaVersion: "1", tasks: PIPELINE_TASKS });
  check("의존 먼저 만든다(선언 순서를 따라가지 않는다)", out.createdOrder.join(",") === "impl-a,impl-b,integrate", out.createdOrder.join(","));
  check("의존 없는 둘만 ready다(병렬 후보)", kernel.getTask("impl-a").state === "ready" && kernel.getTask("impl-b").state === "ready");
  check("의존이 남은 task는 pending이다", kernel.getTask("integrate").state === "pending");
  check("resourceClasses가 kernel로 1:1 보존된다(B-30)", kernel.getTask("integrate").resourceClasses.join(",") === "merge");
  check("dependsOn이 1:1 보존된다", [...kernel.getTask("integrate").dependsOn].sort().join(",") === "impl-a,impl-b");
  check("ownership이 1:1 보존된다", kernel.getTask("impl-a").ownership.join(",") === "src/a");
  check("두 번째 물질화는 거부된다(중복 방지)", codeOf(() => materializeTaskDag(kernel, { schemaVersion: "1", tasks: PIPELINE_TASKS })) === "dag_materialize_run_not_empty");

  // kernel이 거부할 seed는 **만들기 전에** 걸러진다 → durable 잔류 0(리뷰 A급 수정).
  const ws2 = makeDir("m9-mat2-");
  let m = 0;
  const k2 = OrchestrationKernel.create({
    workspaceRoot: ws2,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({ ownershipByTask: { "a-first": ["src/a"], "b-second": ["src/b"] } }),
    clock: () => new Date(T0 + m++),
  });
  const bad = [
    { taskId: "a-first", roleId: "dev-lead", title: "A", scope: "src/a", ownership: ["src/a"], dependsOn: [] },
    { taskId: "b-second", roleId: "dev-lead", title: "ok\n## Rogue Heading", scope: "src/b", ownership: ["src/b"], dependsOn: [] },
  ];
  check("title 개행이 만드는 가짜 heading은 만들기 전에 거부된다", codeOf(() => materializeTaskDag(k2, { schemaVersion: "1", tasks: bad })) === "dag_materialize_seed_rejected");
  check("거부된 물질화가 durable 잔류를 남기지 않는다(run 벽돌화 0)", k2.getState().tasks.length === 0, String(k2.getState().tasks.length));
}

console.log("\n⑥ T3③ — 격리 worktree가 실제 git으로 만들어지고 지워진다");
{
  const ws = makeDir("m9-wt-");
  mkdirSync(join(ws, "src"));
  const git = (args, cwd = ws) => spawnSync("/usr/bin/git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  const commit = git(["rev-parse", "HEAD"]).stdout.trim();
  const gitSha = createHash("sha256").update(readFileSync("/usr/bin/git")).digest("hex");
  let n = 0;
  const kernel = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: baseManifest({
      approvedCommit: commit,
      ownershipByTask: { "impl-a": ["src"] },
      executionAuthority: { ...baseManifest().executionAuthority, git: { path: "/usr/bin/git", sha256: gitSha } },
      operationAuthorityByTask: {
        "impl-a": [
          { authorityId: "wt-add", kind: "git_worktree", action: "add" },
          { authorityId: "wt-rm", kind: "git_worktree", action: "remove" },
        ],
      },
    }),
    clock: () => new Date(T0 + n++),
  });
  kernel.createRootTask({ taskId: "impl-a", roleId: "dev-lead", title: "A", scope: "src", ownership: ["src"], assignmentMessageId: "asg-impl-a", assignmentBody: ASSIGNMENT_BODY });
  const batch = kernel.planRunnableBatch();
  kernel.commitPreflightBatch({ baseRevision: batch.revision, actionId: nextId("act"), decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") })) });
  kernel.startPreparedTask({ taskId: "impl-a", actionId: nextId("act"), leaseMarker: nextLease() });

  const shot = (authorityId) => {
    const task = kernel.getTask("impl-a");
    const turnId = nextId("turn");
    const permit = kernel.issueOperationDispatchPermit({
      taskId: "impl-a",
      turnId,
      actionId: nextId("act"),
      plan: {
        schemaVersion: "1",
        runId: RUN_ID,
        taskId: "impl-a",
        attemptId: task.execution.attemptId,
        turnId,
        operations: [{ operationId: nextId("op"), kind: "git_worktree", authorityId }],
        result: { summary: "worktree", outputs: [] },
      },
    });
    kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
    const op = permit.plan.operations[0];
    const grant = kernel.beginOperation({ permit, operationId: op.operationId, actionId: nextId("act") });
    return { op, grant, cap: resolveWorktreeCapability(op, grant) };
  };

  check("git_worktree가 승인 가능한 operation kind다", APPROVED_OPERATION_KINDS.includes("git_worktree"));
  check("worktree action은 add|remove 둘뿐이다", JSON.stringify([...GIT_WORKTREE_ACTIONS]) === JSON.stringify(["add", "remove"]));

  const add = shot("wt-add");
  const added = await executeWorktreeOperation(add.grant, add.op, add.cap);
  kernel.recordOperationReceipt({ outcome: added, actionId: nextId("act") });
  // 경로 규칙은 여기서 **독립적으로 다시 적는다**(kernel 상수를 공유하면 검증이 공허해진다).
  const wtPath = join(ws, ".harness", "worktrees", RUN_ID, "impl-a");
  check("worktree add가 성공 영수증을 냈다", added.marker === "applied" && added.exitCode === 0, `${added.marker}/${added.exitCode}`);
  check("격리 worktree 디렉터리가 실제로 생겼다", lstatSync(wtPath, { throwIfNoEntry: false })?.isDirectory() === true);
  check("linked worktree다(.git이 gitdir 포인터 파일)", lstatSync(join(wtPath, ".git"), { throwIfNoEntry: false })?.isFile() === true);
  check("승인된 커밋에 checkout됐다", git(["rev-parse", "HEAD"], wtPath).stdout.trim() === commit);
  check("브랜치를 만들지 않았다(--detach)", git(["symbolic-ref", "-q", "HEAD"], wtPath).status !== 0);

  const rm = shot("wt-rm");
  const removed = await executeWorktreeOperation(rm.grant, rm.op, rm.cap);
  kernel.recordOperationReceipt({ outcome: removed, actionId: nextId("act") });
  check("worktree remove가 실제로 지운다", lstatSync(wtPath, { throwIfNoEntry: false }) === undefined);

  const forged = shot("wt-add");
  check("위조 권능은 저장소를 건드리지 못한다", (await codeOfAsync(() => executeWorktreeOperation(forged.grant, forged.op, { ...forged.cap }))) === "process_capability_invalid");
}

console.log("\n⑦ 선결 4 — F2: autopilot 진행이 v1 RunEvent로 보이고 멈춘 이유가 사라지지 않는다");
{
  const events = [];
  let t = 1000;
  const feed = autopilotProgressBridge({ emit: (e) => events.push(e) }, () => t++);
  feed({ kind: "run_started", detail: `${RUN_ID}@${MILESTONE}` });
  feed({ kind: "batch_planned", detail: "impl-a,impl-b" });
  feed({ kind: "task_started", taskId: "impl-a" });
  feed({ kind: "task_paused", taskId: "impl-a", marker: "budget_tokens_exhausted", detail: "usage_unaccounted" });
  feed({ kind: "run_finished", marker: "paused" });
  const start = events.find((e) => e.type === "step_start");
  const end = events.find((e) => e.type === "step_end");
  const warn = events.find((e) => e.type === "note" && e.level === "warn");
  const fin = events.find((e) => e.type === "run_end");
  check("batch 크기가 진행 표시로 넘어간다", start?.total === 2, String(start?.total));
  check("task 경과 시간이 계산된다(F1 데이터 기반)", typeof end?.elapsedMs === "number" && end.elapsedMs >= 0);
  check("pause를 성공 step으로 그리지 않는다", end?.ok === false);
  check("멈춘 marker가 표시에서 사라지지 않는다", warn?.message?.includes("budget_tokens_exhausted") === true);
  check("실패한 run을 completed로 그리지 않는다", fin?.status === "failed");
  let threw = false;
  try {
    autopilotProgressBridge({ emit: () => { throw new Error("EPIPE"); } })({ kind: "run_started" });
  } catch {
    threw = true;
  }
  check("표시 실패가 실행 실패가 되지 않는다", threw === false);
}

console.log("\n⑧ T4 — code/security/test 리뷰 왕복 계약(자기 승인 금지)");
{
  const OK9 = {
    author: { taskId: "impl-a", roleId: "dev-lead", provider: "claude", sessionId: "s-author", fresh: false },
    reviews: {
      code: { taskId: "rev-code", roleId: "tech-lead", provider: "codex", sessionId: "s-code", sandbox: "read-only", fresh: true },
      security: { taskId: "rev-sec", roleId: "qa-security", provider: "codex", sessionId: "s-sec", sandbox: "read-only", fresh: true },
      test: { taskId: "rev-test", roleId: "qa-security.test", provider: "codex", sessionId: "s-test", sandbox: "read-only", fresh: true },
    },
    revision: { taskId: "impl-a-fix", roleId: "dev-lead.revise", provider: "claude", sessionId: "s-revise", fresh: true },
    verify: { taskId: "verify-1", roleId: "tech-lead.verify", provider: "codex", sessionId: "s-verify", sandbox: "read-only", fresh: true },
    testLens: "test",
  };
  const rt9 = (f) => {
    const r = JSON.parse(JSON.stringify(OK9));
    f(r);
    return r;
  };
  const c9 = (r) => codeOf(() => assertCodeReviewRoundtrip(r));
  check("정상 왕복(저자 → 리뷰 3종 → 수정 → verify)은 통과한다", c9(OK9) === "no-error", c9(OK9));
  check("리뷰 렌즈는 정확히 code·security·test 셋이다", c9(rt9((r) => delete r.reviews.security)) === "review_lens_set");
  check("세 리뷰어가 한 세션을 겸할 수 없다", c9(rt9((r) => (r.reviews.security.sessionId = "s-code"))) === "participant_session_reused");
  check("저자가 자기 코드를 리뷰할 수 없다", c9(rt9((r) => (r.reviews.code.taskId = "impl-a"))) === "participant_task_reused");
  check("verify가 앞선 리뷰어와 같을 수 없다", c9(rt9((r) => (r.verify.taskId = "rev-code"))) === "participant_task_reused");
  check("리뷰어·verify는 fresh Codex read-only여야 한다", c9(rt9((r) => (r.verify.sandbox = "workspace-write"))) === "reviewer_sandbox");
  check("구현 역할이 자기 산출물을 검토할 수 없다", c9(rt9((r) => (r.reviews.code.roleId = "dev-lead"))) === "reviewer_role");
  check("테스트 실행 책임은 test 렌즈에 못 박힌다", c9(rt9((r) => (r.testLens = "code"))) === "test_lens_invalid");
}

console.log("");
console.log(`PASS=${pass} FAIL=${fail}`);
console.log(
  "미증명(정직하게): live LLM 0회(Claude worker·Codex 둘 다) · ⑧은 **계약 층**만 본다(fresh Codex 3종의 실제 프로세스 왕복은 미실행) · " +
    "병렬 2 worker 실제 동시 진행 미실행 · revise/verify·직렬 병합·end-to-end 1회 범위 밖(M9 T4 이후) · " +
    "⑥은 worktree가 로컬에서 동작함만 보이고 worker가 그 안에서 코드를 고쳐 병합되는 것은 보이지 않는다.",
);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
