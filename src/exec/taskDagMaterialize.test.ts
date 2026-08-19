/**
 * V3 M9 T3② — DAG 문서 → kernel task 물질화. 대장 `B-30`("문서 필드가 kernel로 1:1 보존된다는 보장이
 * 없다")을 **코드 집행**으로 닫았는지 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationKernel } from "./orchestrationKernel.js";
import { OrchestrationError, REQUIRED_BODY_HEADINGS } from "./orchestrationTypes.js";
import { TASK_DAG_MATERIALIZE_CODES, assignmentBodyFor, materializeTaskDag } from "./taskDagMaterialize.js";
import { TASK_DAG_SCHEMA_VERSION, validateTaskDag } from "./taskDag.js";

const RUN_ID = "run-dag";
const MILESTONE = "ms-dag";
const T0 = Date.parse("2026-08-18T00:00:00.000Z");
const workspaces: string[] = [];

process.on("exit", () => {
  for (const w of workspaces) rmSync(w, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${String(e)}`;
  }
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["src"],
    ownershipByTask: { "impl-a": ["src/a"], "impl-b": ["src/b"], integrate: ["src/app"] },
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

function kernelFor(over: Record<string, unknown> = {}): OrchestrationKernel {
  const ws = mkdtempSync(join(tmpdir(), "m9-dagmat-"));
  workspaces.push(ws);
  let n = 0;
  return OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(over),
    clock: () => new Date(T0 + n++),
  });
}

function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "impl-a",
    roleId: "dev-lead",
    title: "모듈 A 구현",
    scope: "src/a 안에서만 작업한다",
    ownership: ["src/a"],
    dependsOn: [],
    ...over,
  };
}

/** 병렬 2 + 직렬 통합 — M9가 실제로 돌릴 모양. */
function pipeline(): Record<string, unknown> {
  return {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [
      // 선언 순서를 **의존 역순**으로 둔다: 물질화가 순서를 스스로 정하는지 보려는 것이다.
      node({
        taskId: "integrate",
        roleId: "tech-lead",
        ownership: ["src/app"],
        dependsOn: ["impl-a", "impl-b"],
        consumes: ["src/a/index.ts", "src/b/index.ts"],
        provides: ["src/app/main.ts"],
        resourceClasses: ["merge"],
      }),
      node({ taskId: "impl-a", ownership: ["src/a"], provides: ["src/a/index.ts"] }),
      node({ taskId: "impl-b", ownership: ["src/b"], provides: ["src/b/index.ts"] }),
    ],
  };
}

test("[M9] T3②: 문서가 kernel task로 물질화되고 의존 순서가 상태에 반영된다", () => {
  const k = kernelFor();
  const out = materializeTaskDag(k, pipeline());

  // 의존 먼저 만든다 — kernel이 `unknown_dependency`로 거부하므로 순서가 곧 계약이다.
  assert.deepEqual(out.createdOrder, ["impl-a", "impl-b", "integrate"], "선언 순서를 그대로 따라갔다");
  assert.equal(out.tasks.length, 3);
  // **의존 없는 둘만 ready**다(병렬 후보). 통합은 의존이 남아 pending이다.
  assert.equal(k.getTask("impl-a")!.state, "ready");
  assert.equal(k.getTask("impl-b")!.state, "ready");
  assert.equal(k.getTask("integrate")!.state, "pending");
  // 전부 depth 0 · parent 없음(DAG는 트리가 아니다).
  for (const t of out.tasks) {
    assert.equal(t.depth, 0);
    assert.equal(t.parentTaskId, null);
  }
});

test("[M9] T3②: 의존 순서는 taskId 사전순이 아니다(정렬이 순서 결함을 가리지 않는다)", () => {
  // 위 fixture는 사전순이 **우연히** 의존 순서와 같아서, 순서 로직을 지워도 통과한다(mutation으로 실측).
  // 여기서는 사전순이 의존 순서를 **거스른다**: `aaa`가 `zzz`에 의존한다 → `zzz`를 먼저 만들어야 한다.
  const k = kernelFor({ ownershipByTask: { aaa: ["src/a"], zzz: ["src/z"] } });
  const out = materializeTaskDag(k, {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [
      node({ taskId: "aaa", ownership: ["src/a"], dependsOn: ["zzz"], consumes: ["src/z/out.ts"] }),
      node({ taskId: "zzz", ownership: ["src/z"], provides: ["src/z/out.ts"] }),
    ],
  });
  assert.deepEqual(out.createdOrder, ["zzz", "aaa"], "사전순으로 만들어 의존이 미상이 됐거나 순서가 뒤집혔다");
  assert.equal(k.getTask("zzz")!.state, "ready");
  assert.equal(k.getTask("aaa")!.state, "pending");
  // 결정론: 같은 문서면 같은 순서다.
  const k2 = kernelFor({ ownershipByTask: { aaa: ["src/a"], zzz: ["src/z"] } });
  const out2 = materializeTaskDag(k2, {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [
      node({ taskId: "aaa", ownership: ["src/a"], dependsOn: ["zzz"], consumes: ["src/z/out.ts"] }),
      node({ taskId: "zzz", ownership: ["src/z"], provides: ["src/z/out.ts"] }),
    ],
  });
  assert.deepEqual(out2.createdOrder, out.createdOrder);
});

test("[M9] T3②(B-30): resourceClasses·dependsOn·ownership이 kernel로 1:1 보존된다", () => {
  const k = kernelFor();
  materializeTaskDag(k, pipeline());
  const integrate = k.getTask("integrate")!;
  // `taskDag.ts`의 소유권 충돌 면제 근거가 **정확히 이 등호**다(면제는 scheduler가 막는다는 전제 위에 있다).
  assert.deepEqual(integrate.resourceClasses, ["merge"], "resourceClasses가 kernel로 넘어가지 않았다");
  assert.deepEqual([...integrate.dependsOn].sort(), ["impl-a", "impl-b"]);
  assert.deepEqual(k.getTask("impl-a")!.ownership, ["src/a"]);
  assert.deepEqual(k.getTask("impl-b")!.ownership, ["src/b"]);
  assert.equal(k.getTask("impl-a")!.roleId, "dev-lead");
  assert.equal(integrate.roleId, "tech-lead");
  assert.equal(integrate.title, "모듈 A 구현");
  assert.equal(k.getTask("impl-a")!.scope, "src/a 안에서만 작업한다");
});

test("[M9] T3② 리뷰 A: 유효 문서라도 kernel이 거부할 seed는 **만들기 전에** 걸러진다(durable 잔류 0)", () => {
  // 적대적 리뷰가 실측한 4종. 전부 `validateTaskDag`를 통과하지만 kernel 생성 단계에서 거부되던
  // 입력이고, 이전 판은 앞선 task를 durable에 남긴 채 죽어 재시도가 영구 차단됐다(run 벽돌화).
  const cases: Array<[string, Record<string, unknown>[], Record<string, unknown>]> = [
    // ⓐ title 개행 → 본문 안에서 가짜 h2 heading이 된다(`assertText`는 개행을 허용한다).
    [
      "title 개행",
      [node({ taskId: "a-first", ownership: ["src/a"] }), node({ taskId: "b-second", ownership: ["src/b"], title: "ok\n## Rogue Heading" })],
      { "a-first": ["src/a"], "b-second": ["src/b"] },
    ],
    // ⓑ 61자 이상 taskId → `asg-<taskId>`가 slug 상한(64)을 넘는다.
    [
      "긴 taskId",
      [node({ taskId: "a-first", ownership: ["src/a"] }), node({ taskId: "b".repeat(62), ownership: ["src/b"] })],
      { "a-first": ["src/a"], ["b".repeat(62)]: ["src/b"] },
    ],
    // ⓒ 승인 manifest의 ownershipByTask에 없는 task(문서는 manifest를 보지 않는다).
    [
      "manifest 미승인",
      [node({ taskId: "a-first", ownership: ["src/a"] }), node({ taskId: "b-second", ownership: ["src/b"] })],
      { "a-first": ["src/a"] },
    ],
    // ⓓ provides가 길어 본문이 maxBodyBytes를 넘는다(provides는 본문에 **두 번** 실린다).
    [
      "본문 상한 초과",
      [
        node({ taskId: "a-first", ownership: ["src/a"] }),
        node({
          taskId: "b-second",
          ownership: ["src/b"],
          provides: Array.from({ length: 16 }, (_, i) => `src/b/${"p".repeat(500)}${i}`),
        }),
      ],
      { "a-first": ["src/a"], "b-second": ["src/b"] },
    ],
  ];
  for (const [label, tasks, ownershipByTask] of cases) {
    const k = kernelFor({ writableRoots: ["src"], ownershipByTask });
    assert.equal(
      codeOf(() => materializeTaskDag(k, { schemaVersion: TASK_DAG_SCHEMA_VERSION, tasks })),
      "dag_materialize_seed_rejected",
      label,
    );
    // **핵심**: 앞선 task가 durable에 남지 않는다 → 재시도가 막히지 않는다(run 벽돌화 0).
    assert.equal(k.getState().tasks.length, 0, `${label}: durable 잔류가 생겼다`);
  }
});

test("[M9] T3②: 검증에 걸리는 문서는 task를 하나도 만들지 않는다(부분 물질화 없음)", () => {
  // 호출자가 "이미 검증했다"고 주장해도 이 모듈은 다시 검증한다(deny-by-default).
  const k = kernelFor();
  const bad = {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [
      node({ taskId: "good", ownership: ["src/g"] }),
      node({ taskId: "a", ownership: ["src/x"], dependsOn: ["b"] }),
      node({ taskId: "b", ownership: ["src/y"], dependsOn: ["a"] }),
    ],
  };
  assert.equal(codeOf(() => materializeTaskDag(k, bad)), "dependency_cycle");
  assert.equal(k.getState().tasks.length, 0, "거부된 문서가 task를 남겼다");
  // 소유권 충돌도 같다 — 물질화 전에 죽는다.
  const k2 = kernelFor();
  assert.equal(
    codeOf(() =>
      materializeTaskDag(k2, {
        schemaVersion: TASK_DAG_SCHEMA_VERSION,
        tasks: [node({ taskId: "a", ownership: ["src/x"] }), node({ taskId: "b", ownership: ["src/x"] })],
      }),
    ),
    "ownership_conflict",
  );
  assert.equal(k2.getState().tasks.length, 0);
});

test("[M9] T3②: 이미 task가 있는 run에는 물질화하지 않는다(중복·충돌 판정 범위 밖)", () => {
  const k = kernelFor();
  materializeTaskDag(k, pipeline());
  assert.equal(k.getState().tasks.length, 3);
  assert.equal(codeOf(() => materializeTaskDag(k, pipeline())), "dag_materialize_run_not_empty");
  assert.equal(k.getState().tasks.length, 3, "두 번째 물질화가 task를 더 만들었다");
});

test("[M9] T3②: task_assignment 본문은 필수 헤딩 전부를 담고 API contract를 그 안에 적는다", () => {
  const n = validateTaskDag(pipeline()).tasks.find((t) => t.taskId === "integrate")!;
  const body = assignmentBodyFor(n);
  for (const h of REQUIRED_BODY_HEADINGS.task_assignment) {
    assert.ok(body.includes(`## ${h}`), `필수 헤딩 누락: ${h}`);
  }
  // `provides`/`consumes`는 kernel state 축이 아니므로 **worker가 읽는 본문**에 있어야 한다.
  assert.match(body, /src\/a\/index\.ts/, "consumes가 본문에서 사라졌다");
  assert.match(body, /src\/app\/main\.ts/, "provides가 본문에서 사라졌다");
  assert.match(body, /src\/app/, "ownership이 본문에서 사라졌다");
  assert.match(body, /impl-a/, "dependsOn이 본문에서 사라졌다");
  // **결정론적**: 같은 문서면 같은 바이트다(시각·예산 실측값을 담지 않는다).
  assert.equal(assignmentBodyFor(n), body);
});

test("[M9] T3②: 오류 코드는 닫힌 목록이다", () => {
  const k = kernelFor();
  materializeTaskDag(k, pipeline());
  assert.equal(codeOf(() => materializeTaskDag(k, pipeline())), "dag_materialize_run_not_empty");
  assert.ok((TASK_DAG_MATERIALIZE_CODES as readonly string[]).includes("dag_materialize_drift"));
  // T3② 적대적 리뷰에서 `dag_materialize_seed_rejected`가 **사람 판단 아래** 더해졌다(크기 초과를
  // drift로 보고하던 코드 오용도 함께 정정). 잠금은 그대로다 — 여기 없는 항목이 늘면 red다.
  assert.deepEqual(
    [...TASK_DAG_MATERIALIZE_CODES],
    ["dag_materialize_drift", "dag_materialize_run_not_empty", "dag_materialize_seed_rejected"],
    "닫힌 목록이 승인 없이 늘었다",
  );
});
