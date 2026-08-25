/**
 * V3 M11 — **`harness autopilot-create`** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/commands/autopilotCreate.test.ts`
 * 네트워크·LLM·프로세스 0. 임시 workspace에서만 돈다(무과금).
 *
 * 이 파일이 고정하는 계약:
 * - **승인을 발행하지 않는다** — 계약을 어긴 승인 파일은 **기존 검증기의 코드로** 거부되고, 빠진 필드는
 *   채워지지 않는다. 거부는 durable에 **아무것도** 남기지 않는다(run 디렉터리조차).
 * - **DAG 문서도 fail closed** — 그리고 그 거부 역시 run을 만들지 않는다.
 * - **멱등** — 같은 두 파일로 다시 부르면 task를 하나도 더 만들지 않는다.
 * - **승인 교체 통로가 없다** — 파일의 승인이 run에 bind된 승인과 다르면 거부다(조용한 갈아끼우기 없음).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationError } from "../exec/orchestrationTypes.js";
import { openOrchestrationRun } from "../exec/orchestrationKernel.js";
import { runPaths } from "../exec/orchestrationStore.js";
import { createAutopilotRun } from "./autopilotCreate.js";

const RUN_ID = "m11-create-run";
const MILESTONE = "m11-create";

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
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

/** 계약을 지킨 최소 승인 문서. 실행 파일 record는 형식만 검증되므로 실재하지 않아도 된다. */
function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs", "src"],
    ownershipByTask: { plan: ["docs"], build: ["src"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
      controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
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
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

/** 계약을 지킨 최소 DAG 문서(간선 1개 — 순서가 실제로 물질화되는지 보려면 2개는 있어야 한다). */
function dag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1",
    tasks: [
      {
        taskId: "plan",
        roleId: "tech-lead",
        title: "계획 수립",
        scope: "docs 아래 계획 문서만 만든다",
        ownership: ["docs"],
        dependsOn: [],
        provides: ["docs/plan.md"],
      },
      {
        taskId: "build",
        roleId: "dev-lead",
        title: "구현",
        scope: "src 아래 구현만 한다",
        ownership: ["src"],
        dependsOn: ["plan"],
        consumes: ["docs/plan.md"],
      },
    ],
    ...over,
  };
}

interface Files {
  ws: string;
  approval: string;
  dag: string;
}

function files(manifestDoc: unknown, dagDoc: unknown): Files {
  const d = makeDir("m11-create-files-");
  const approval = join(d, "approval.json");
  const dagFile = join(d, "dag.json");
  writeFileSync(approval, JSON.stringify(manifestDoc));
  writeFileSync(dagFile, JSON.stringify(dagDoc));
  return { ws: makeDir("m11-create-ws-"), approval, dag: dagFile };
}

function create(f: Files, over: Partial<{ run: string; milestone: string }> = {}): ReturnType<typeof createAutopilotRun> {
  return createAutopilotRun({
    workspace: f.ws,
    run: over.run ?? RUN_ID,
    milestone: over.milestone ?? MILESTONE,
    approval: f.approval,
    dag: f.dag,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "(통과)";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `throw:${String(e)}`;
  }
}

test("정상 파일 두 개 → run 생성 + task 물질화(의존 순서)", () => {
  const f = files(manifest(), dag());
  const r = create(f);
  assert.equal(r.created, true);
  assert.equal(r.runId, RUN_ID);
  assert.equal(r.milestoneId, MILESTONE);
  assert.deepEqual(r.createdOrder, ["plan", "build"]);
  assert.equal(r.taskCount, 2);

  // durable에서 다시 읽어 확인한다(이 명령의 자기 선언이 아니다).
  const k = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID });
  assert.deepEqual(
    k.getState().tasks.map((t) => t.taskId).sort(),
    ["build", "plan"],
  );
  assert.deepEqual(k.getTask("build")?.dependsOn, ["plan"]);
  // 승인은 파일에서 온 그대로다 — 이 명령이 만든 필드가 없다.
  assert.equal(k.getManifest().maxSessions, 4);
});

test("다시 불러도 중복 생성이 0이다(멱등)", () => {
  const f = files(manifest(), dag());
  create(f);
  const again = create(f);
  assert.equal(again.created, false);
  assert.deepEqual(again.createdOrder, []);
  assert.equal(again.taskCount, 2);
  const k = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID });
  assert.equal(k.getState().tasks.length, 2);
});

test("승인 파일이 계약을 어기면 기존 코드로 fail closed이고 run을 만들지 않는다", () => {
  for (const [label, doc, expected] of [
    ["approvedCommit 형식 위반", manifest({ approvedCommit: "짧다" }), "invalid_manifest"],
    ["미상 필드", manifest({ 여분: 1 }), "invalid_manifest"],
    // **빠진 필드를 채워 주지 않는다** — 그것이 곧 승인 발행이다.
    ["expiresAt 부재", (() => { const m = manifest(); delete m.expiresAt; return m; })(), "invalid_manifest"],
    ["autopilotPolicy 부재", (() => { const m = manifest(); delete m.autopilotPolicy; return m; })(), "manifest_pre_m5c_unsupported"],
    ["ownership이 writableRoots 밖", manifest({ ownershipByTask: { plan: ["etc"], build: ["src"] } }), "ownership_outside_writable_root"],
    ["만료된 승인", manifest({ expiresAt: "2020-01-01T00:00:00.000Z" }), "manifest_expired"],
  ] as [string, Record<string, unknown>, string][]) {
    const f = files(doc, dag());
    assert.equal(codeOf(() => create(f)), expected, label);
    assert.equal(existsSync(runPaths(f.ws, RUN_ID).stateFile), false, `${label}: run이 남았다`);
  }
});

test("승인 파일이 JSON이 아니거나 없으면 invalid_manifest다(새 코드를 만들지 않는다)", () => {
  const f = files(manifest(), dag());
  writeFileSync(f.approval, "{ 이건 JSON이 아니다");
  assert.equal(codeOf(() => create(f)), "invalid_manifest");
  const missing = { ...f, approval: join(f.ws, "없는-파일.json") };
  assert.equal(codeOf(() => create(missing)), "invalid_manifest");
  assert.equal(existsSync(runPaths(f.ws, RUN_ID).stateFile), false);
});

test("DAG 문서가 계약을 어기면 fail closed이고 run을 만들지 않는다", () => {
  for (const [label, doc, expected] of [
    ["미상 필드", dag({ 여분: 1 }), "invalid_dag_document"],
    ["schemaVersion 부재", (() => { const d = dag(); delete d.schemaVersion; return d; })(), "invalid_dag_document"],
    [
      "순환",
      dag({
        tasks: [
          { taskId: "plan", roleId: "tech-lead", title: "a", scope: "a", ownership: ["docs"], dependsOn: ["build"] },
          { taskId: "build", roleId: "dev-lead", title: "b", scope: "b", ownership: ["src"], dependsOn: ["plan"] },
        ],
      }),
      "dependency_cycle",
    ],
    [
      "동시에 돌 두 task가 같은 경로를 소유",
      dag({
        tasks: [
          { taskId: "plan", roleId: "tech-lead", title: "a", scope: "a", ownership: ["docs"], dependsOn: [] },
          { taskId: "build", roleId: "dev-lead", title: "b", scope: "b", ownership: ["docs"], dependsOn: [] },
        ],
      }),
      "ownership_conflict",
    ],
    ["문서 밖 의존", dag({ tasks: [{ taskId: "plan", roleId: "tech-lead", title: "a", scope: "a", ownership: ["docs"], dependsOn: ["absent-task"] }] }), "unknown_dependency"],
  ] as [string, Record<string, unknown>, string][]) {
    const f = files(manifest(), doc);
    assert.equal(codeOf(() => create(f)), expected, label);
    assert.equal(existsSync(runPaths(f.ws, RUN_ID).stateFile), false, `${label}: run이 남았다`);
  }
});

test("DAG가 유효해도 승인 범위 밖이면 물질화가 거부한다(문서는 승인을 만들지 않는다)", () => {
  // 승인 `ownershipByTask`에 없는 task를 문서가 선언했다 → `dag_materialize_seed_rejected`.
  const f = files(manifest({ ownershipByTask: { plan: ["docs"] } }), dag());
  assert.equal(codeOf(() => create(f)), "dag_materialize_seed_rejected");
});

test("milestone이 승인 파일과 다르면 거부한다(운영자 의도와 문서를 이중 대조한다)", () => {
  const f = files(manifest(), dag());
  assert.equal(codeOf(() => create(f, { milestone: "other-milestone" })), "manifest_milestone_mismatch");
  assert.equal(existsSync(runPaths(f.ws, RUN_ID).stateFile), false);
});

test("기존 run에 다른 승인 파일로 다시 부르면 거부한다(승인 갈아끼우기 통로가 없다)", () => {
  const f = files(manifest(), dag());
  create(f);
  // 같은 milestone, 예산만 키운 승인 — 조용히 적용되면 그것이 곧 승인 우회다.
  writeFileSync(f.approval, JSON.stringify(manifest({ maxTokens: 999_999 })));
  assert.equal(codeOf(() => create(f)), "run_already_exists");
  const k = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID });
  assert.equal(k.getManifest().maxTokens, 100_000);
});

/**
 * **이어받기의 실제 경계를 고정한다**(M11 적대적 리뷰 A-1).
 *
 * 리뷰 전에는 위 테스트 이름이 "다른 DAG 문서로 다시 부르면 거부한다"였고 그것이 **증명보다 강했다** —
 * 그 테스트가 통과하는 이유는 "문서가 달라서"가 아니라 **승인 ownership 밖 task라서**다.
 * 리뷰어가 **승인 안에 있는** superset 문서로 재현했다: 시작 전 run은 **자란다**.
 *
 * 그 성질을 없애지 않는다 — 부분 물질화(`C-76`) 복구가 사는 자리이고, 자라는 task도 **이미 bind된
 * 승인 범위 안**이며 승인 digest 대조를 먼저 지난다. 대신 **정확히 무엇인지 여기서 못 박는다.**
 * 이 테스트가 없으면 그 경계는 아무 데도 단정돼 있지 않다.
 */
test("[A-1] 시작 전 run은 **승인 안의** superset 문서로 자란다(그리고 그것이 경계다)", () => {
  const m = manifest({ ownershipByTask: { plan: ["docs"], build: ["src"], extra: ["src/extra"] } });
  const f = files(m, dag());
  create(f);
  const grown = {
    ...dag(),
    tasks: [
      ...(dag().tasks as unknown[]),
      { taskId: "extra", roleId: "dev-lead", title: "추가", scope: "s", ownership: ["src/extra"], dependsOn: ["build"] },
    ],
  };
  writeFileSync(f.dag, JSON.stringify(grown));
  create(f);
  const tasks = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID }).getState().tasks;
  assert.deepEqual(
    tasks.map((t) => t.taskId).sort(),
    ["build", "extra", "plan"],
    "시작 전 run이 승인 안의 superset으로 자라지 않았다 — 경계가 바뀌었으면 이 테스트와 모듈 주석을 함께 고쳐라",
  );
  // **자란 task도 승인 밖으로는 못 간다**: 위 테스트가 그 반대편을 고정한다.
  assert.ok(
    tasks.every((t) => t.execution.attemptNo === 0),
    "이 경계는 attemptNo가 전부 0일 때만 성립한다(시작된 run은 dag_materialize_run_not_empty)",
  );
});

test("승인 ownership 밖의 task를 더한 DAG 문서는 seed 단계에서 닫힌다", () => {
  const f = files(manifest(), dag());
  create(f);
  writeFileSync(
    f.dag,
    JSON.stringify(
      dag({
        tasks: [
          ...(dag().tasks as unknown[]),
          { taskId: "extra", roleId: "dev-lead", title: "c", scope: "c", ownership: ["src/extra.ts"], dependsOn: ["build"] },
        ],
      }),
    ),
  );
  // 문서 자체는 유효하지만 승인 `ownershipByTask`에 `extra`가 없다 → seed 단계에서 먼저 닫힌다.
  assert.equal(codeOf(() => create(f)), "dag_materialize_seed_rejected");
  assert.equal(openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID }).getState().tasks.length, 2);
});
