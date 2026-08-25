/**
 * V3 M9 T3② — DAG 문서 → kernel task 물질화. 대장 `B-30`("문서 필드가 kernel로 1:1 보존된다는 보장이
 * 없다")을 **코드 집행**으로 닫았는지 확인한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationKernel } from "./orchestrationKernel.js";
import { OrchestrationError, REQUIRED_BODY_HEADINGS, TYPED_EXECUTION_PLAN_SCHEMA_VERSION } from "./orchestrationTypes.js";
import { TASK_DAG_MATERIALIZE_CODES, assignmentBodyFor, materializeTaskDag } from "./taskDagMaterialize.js";
import { TASK_DAG_SCHEMA_VERSION, validateTaskDag } from "./taskDag.js";
import { validateTypedExecutionPlan } from "./typedPlan.js";

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
  // **V3 M10 T1에서 이 계약의 범위가 좁아졌다**(대장 `C-76`): 같은 문서를 다시 부르는 것은 **멱등**이
  // 됐다(부분 물질화를 이어받기 위해서다 — 아래 M10 절). 여전히 거부되는 것은 **다른 문서**를 얹는
  // 경우이고, 그것이 이 테스트가 지키던 성질이다(taskId 충돌·소유권 겹침 판정이 문서 범위를 벗어난다).
  assert.deepEqual(materializeTaskDag(k, pipeline()).createdOrder, [], "멱등 재호출이 task를 더 만들었다");
  assert.equal(k.getState().tasks.length, 3, "두 번째 물질화가 task를 더 만들었다");
  const foreign = JSON.parse(JSON.stringify(pipeline())) as { tasks: Array<Record<string, unknown>> };
  for (const t of foreign.tasks) if (t.taskId === "impl-a") t.title = "다른 계획의 제목";
  assert.equal(codeOf(() => materializeTaskDag(k, foreign)), "dag_materialize_run_not_empty");
  assert.equal(k.getState().tasks.length, 3, "거부된 물질화가 task를 더 만들었다");
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
  const foreign = JSON.parse(JSON.stringify(pipeline())) as { tasks: Array<Record<string, unknown>> };
  for (const t of foreign.tasks) if (t.taskId === "impl-a") t.title = "다른 계획의 제목";
  assert.equal(codeOf(() => materializeTaskDag(k, foreign)), "dag_materialize_run_not_empty");
  assert.ok((TASK_DAG_MATERIALIZE_CODES as readonly string[]).includes("dag_materialize_drift"));
  // T3② 적대적 리뷰에서 `dag_materialize_seed_rejected`가 **사람 판단 아래** 더해졌다(크기 초과를
  // drift로 보고하던 코드 오용도 함께 정정). 잠금은 그대로다 — 여기 없는 항목이 늘면 red다.
  assert.deepEqual(
    [...TASK_DAG_MATERIALIZE_CODES],
    ["dag_materialize_drift", "dag_materialize_run_not_empty", "dag_materialize_seed_rejected"],
    "닫힌 목록이 승인 없이 늘었다",
  );
});

// ── V3 M10 T1: 부분 물질화 이어받기 (대장 `C-76`) ────────────────────────────

/**
 * **부분 물질화를 실제로 만든다**: task 하나를 만든 뒤 시계를 되돌리면 다음 `createDependentTask`가
 * `clock_invalid`로 거부된다(사전 검증으로는 닫을 수 없는 부류 — 시간·동시성·IO가 그것이다).
 * 그 결과가 durable에 남은 **일부 task**이며, 이전 판은 그 run을 벽돌로 만들었다.
 */
function partiallyMaterialized(): { k: OrchestrationKernel; doc: Record<string, unknown> } {
  const ws = mkdtempSync(join(tmpdir(), "m10-dagmat-"));
  workspaces.push(ws);
  let n = 0;
  let ref: OrchestrationKernel | null = null;
  let frozen = false;
  // **durable 상태를 보고** 되돌린다(호출 횟수 세기가 아니다 — 커밋당 시계 호출 수는 계약이 아니다).
  const clock = (): Date => (!frozen && ref !== null && ref.getState().tasks.length >= 1 ? new Date(T0 - 3_600_000) : new Date(T0 + n++));
  const k = OrchestrationKernel.create({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(),
    clock,
  });
  ref = k;
  const doc = pipeline();
  assert.equal(codeOf(() => materializeTaskDag(k, doc)), "clock_invalid", "부분 물질화 전제가 성립하지 않았다");
  frozen = true; // 이제부터 시계는 정상이다(재시작한 프로세스와 같다).
  assert.deepEqual(
    k.getState().tasks.map((t) => t.taskId),
    ["impl-a"],
    "이 전제는 task 1건만 남기는 것이다",
  );
  return { k, doc };
}

test("[M10-T1] C-76: 부분 물질화된 run은 같은 문서로 이어받아 완성된다(벽돌이 아니다)", () => {
  const { k, doc } = partiallyMaterialized();

  const out = materializeTaskDag(k, doc);

  // ⓐ 남은 것만 만든다 — 이미 있는 task를 "만들었다"고 적지 않는다.
  assert.deepEqual(out.createdOrder, ["impl-b", "integrate"], "이어받기가 이미 만든 task를 다시 셌다");
  // ⓑ 결과는 처음부터 한 번에 만든 것과 같다(문서 3건 전부 · 의존·소유권 보존).
  assert.deepEqual(
    k.getState().tasks.map((t) => t.taskId).sort(),
    ["impl-a", "impl-b", "integrate"],
  );
  assert.deepEqual(out.tasks.find((t) => t.taskId === "integrate")!.dependsOn.sort(), ["impl-a", "impl-b"]);
  // ⓒ 멱등: 완성된 뒤 또 불러도 아무것도 만들지 않는다.
  assert.deepEqual(materializeTaskDag(k, doc).createdOrder, []);
});

test("[M10-T1] C-76: 문서와 다른 run에는 이어받지 않는다 — 문서 밖 task·필드 불일치·시작된 task 전부 거부", () => {
  // ⓐ 문서 밖 task가 있는 run(다른 문서로 만든 run).
  const other = partiallyMaterialized();
  other.k.createRootTask({
    taskId: "impl-b",
    roleId: "dev-lead",
    title: "다른 계획의 B",
    scope: "src/b 안에서만 작업한다",
    ownership: ["src/b"],
    assignmentMessageId: "asg-impl-b",
    assignmentBody: REQUIRED_BODY_HEADINGS.task_assignment.map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n"),
  });
  assert.equal(codeOf(() => materializeTaskDag(other.k, other.doc)), "dag_materialize_run_not_empty");

  // ⓑ 기존 task가 문서 node와 다르다(문서를 고쳐 들고 왔다) — 이어받으면 문서와 durable이 갈린다.
  const drifted = partiallyMaterialized();
  const changed = JSON.parse(JSON.stringify(drifted.doc)) as { tasks: Array<Record<string, unknown>> };
  for (const t of changed.tasks) if (t.taskId === "impl-a") t.title = "제목을 바꿨다";
  assert.equal(codeOf(() => materializeTaskDag(drifted.k, changed)), "dag_materialize_run_not_empty");

  // ⓑ2 **state 축 밖 필드**(provides = API contract)만 바꿔 들고 와도 거부한다 — kernel state에는
  //     그 축이 없어서 필드 등호만으로는 통과한다(T1 적대적 리뷰 B1). assignment 본문 digest가 잡는다.
  const contractDrift = partiallyMaterialized();
  const changedContract = JSON.parse(JSON.stringify(contractDrift.doc)) as { tasks: Array<Record<string, unknown>> };
  for (const t of changedContract.tasks) if (t.taskId === "impl-a") t.provides = ["src/a/index.ts", "src/a/extra.ts"];
  assert.equal(codeOf(() => materializeTaskDag(contractDrift.k, changedContract)), "dag_materialize_run_not_empty");

  // ⓒ 이미 시작된 task가 있는 run — 복구가 아니라 "진행 중 DAG 키우기"이므로 열지 않는다.
  const started = partiallyMaterialized();
  const batch = started.k.planRunnableBatch();
  started.k.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: "act.pf",
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: `att.${t.taskId}` })),
  });
  assert.equal(codeOf(() => materializeTaskDag(started.k, started.doc)), "dag_materialize_run_not_empty");
});

// ── V3 M11 — 지시가 operation을 싣는다 (대장 `B-38` + `C-111`) ─────────────────

/**
 * `write_file` 권위 1건을 승인한 manifest override. 경로는 그 task의 승인 ownership 안이어야 한다 —
 * 아니면 manifest 검증이 `operation_not_owned`로 먼저 죽는다(승인 층이 이미 그것을 본다).
 */
function withWriteAuthority(taskId = "impl-a", authorityId = "auth-a", path = "src/a/index.ts"): Record<string, unknown> {
  return {
    operationAuthorityByTask: {
      [taskId]: [{ authorityId, kind: "write_file", path, maxBytes: 4096 }],
    },
  };
}

test("[M11/B-38] operations 없는 DAG 문서의 assignment 본문은 이전과 **바이트 동일**하다", () => {
  // 이 세 sha256은 **이 slice 이전 코드**(`HEAD`의 `assignmentBodyFor`)를 그대로 돌려 얻은 값이다.
  // 이어받기 판정이 `assignment.bodySha256`을 대조하므로 한 바이트만 달라져도 **기존 run이 전부 깨진다**.
  const golden: Array<[Record<string, unknown>, string]> = [
    [
      { taskId: "plan-doc", roleId: "pm", title: "기획 문서", scope: "docs 안에서만", ownership: ["docs"], dependsOn: [], provides: ["docs/PLAN.md"], consumes: [], resourceClasses: [], operations: [] },
      "55f5b87d14e06c5a27461351cc22f3ef8175b986d04ed0c3495426ca8d0602f3",
    ],
    [
      { taskId: "dev-impl", roleId: "dev-lead", title: "구현", scope: "src 안에서만", ownership: ["src"], dependsOn: ["plan-doc"], provides: ["src/a.ts"], consumes: ["docs/PLAN.md"], resourceClasses: ["repo"], operations: [] },
      "4a0218f464ff53ae6251dc2251004efe2caa2ab81be43808a593eabdb8d08864",
    ],
    [
      { taskId: "empty", roleId: "qa", title: "검증", scope: "docs 안에서만", ownership: ["docs"], dependsOn: [], provides: [], consumes: [], resourceClasses: [], operations: [] },
      "6218cda48c0dcb6769fa8338e74005a5ed5d10880ac494376041b4f0988a87b1",
    ],
  ];
  for (const [n, want] of golden) {
    const got = createHash("sha256")
      .update(assignmentBodyFor(n as unknown as Parameters<typeof assignmentBodyFor>[0]), "utf8")
      .digest("hex");
    assert.equal(got, want, `${String(n.taskId)}의 본문 바이트가 B-38 이전과 달라졌다`);
  }
});

test("[M11/B-38] 선언한 operation이 지시 본문에 **계획이 받아들이는 객체 그대로** 실린다", () => {
  const k = kernelFor(withWriteAuthority());
  const doc = {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [node({ provides: ["src/a/index.ts"], operations: ["auth-a"] })],
  };
  materializeTaskDag(k, doc);
  const body = k.messageBody("asg-impl-a");

  // ⓐ 본문에 **JSON 객체**가 들어 있다(목록 서술이 아니다).
  const found = body.match(/^\{"operationId".*\}$/m);
  assert.ok(found !== null, `지시 본문에 operation 객체가 없다:\n${body}`);

  // ⓑ 그 객체는 **계획 검증기가 그대로 받는다** — 모델이 복사만 하면 통과한다는 뜻이다.
  //    형태의 정본을 두 곳에 두지 않는다: 여기서 도는 것이 소비자 자신이다.
  const binding = { runId: RUN_ID, taskId: "impl-a", attemptId: "att-1", turnId: "turn-1" };
  const plan = validateTypedExecutionPlan(
    {
      schemaVersion: TYPED_EXECUTION_PLAN_SCHEMA_VERSION,
      ...binding,
      operations: [JSON.parse(found[0]) as unknown],
      result: { summary: "복사한 계획", outputs: [] },
    },
    binding,
  );
  assert.equal(plan.operations[0].kind, "write_file");
  assert.equal(plan.operations[0].authorityId, "auth-a");
  assert.equal((plan.operations[0] as { path: string }).path, "src/a/index.ts");

  // ⓒ durable task에 지시 축이 굳었다(kernel bind의 입력 — `C-111`).
  assert.deepEqual(k.getTask("impl-a")!.assignedOperations, ["auth-a"]);
});

test("[M11/B-38] 닫힌 union 세 갈래 전부가 지시에 실린다 — run_process·git_worktree는 **완전히 그대로**다", () => {
  // `write_file`만 되고 나머지가 계약 밖 객체를 내면 그 DAG는 물질화 시점에 죽는다(자기검증이 던진다).
  // 두 갈래는 `{operationId, kind, authorityId}`뿐이라 모델이 채울 자리가 아예 없다.
  const n = {
    taskId: "impl-a",
    roleId: "dev-lead",
    title: "t",
    scope: "s",
    ownership: ["src/a"],
    dependsOn: [],
    provides: [],
    consumes: [],
    resourceClasses: [],
    operations: [],
  } as unknown as Parameters<typeof assignmentBodyFor>[0];
  const body = assignmentBodyFor(n, [
    { authorityId: "auth-tests", kind: "run_process", action: "run-tests", data: { projectPath: "src/a" }, timeoutMs: 1_000 },
    { authorityId: "auth-wt", kind: "git_worktree", action: "add" },
  ]);
  const objects = [...body.matchAll(/^\{"operationId".*\}$/gm)].map((m) => JSON.parse(m[0]) as Record<string, unknown>);
  assert.equal(objects.length, 2, body);
  for (const o of objects) assert.deepEqual(Object.keys(o).sort(), ["authorityId", "kind", "operationId"]);
  assert.deepEqual(
    objects.map((o) => o.kind),
    ["run_process", "git_worktree"],
  );
});

test("[M11/B-38] 승인 밖 operation을 실은 DAG는 물질화에서 거부되고 durable에 아무것도 남지 않는다", () => {
  const doc = {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [node({ provides: ["src/a/index.ts"], operations: ["auth-a"] })],
  };

  // ⓐ 그 task에 아무 권위도 승인되지 않았다.
  const none = kernelFor();
  assert.equal(codeOf(() => materializeTaskDag(none, doc)), "dag_materialize_seed_rejected");
  assert.equal(none.getState().tasks.length, 0, "거부됐는데 task가 남았다");

  // ⓑ **다른 task**에 승인된 권위를 빌려 쓰려 했다(권위는 task별이다).
  const borrowed = kernelFor(withWriteAuthority("impl-b", "auth-b", "src/b/index.ts"));
  assert.equal(
    codeOf(() =>
      materializeTaskDag(borrowed, {
        schemaVersion: TASK_DAG_SCHEMA_VERSION,
        tasks: [node({ provides: ["src/a/index.ts"], operations: ["auth-b"] })],
      }),
    ),
    "dag_materialize_seed_rejected",
  );
  assert.equal(borrowed.getState().tasks.length, 0);

  // ⓒ **정상 대조군**: 같은 문서라도 그 task에 승인된 id면 통과한다(위 거부가 공허하지 않다).
  const ok = kernelFor(withWriteAuthority());
  assert.deepEqual(materializeTaskDag(ok, doc).createdOrder, ["impl-a"]);
});

test("[M11/C-111] 이어받기 대조는 operations 축까지 본다 — id만 바꾼 문서는 거부된다", () => {
  const k = kernelFor({
    operationAuthorityByTask: {
      "impl-a": [
        { authorityId: "auth-a", kind: "write_file", path: "src/a/index.ts", maxBytes: 4096 },
        { authorityId: "auth-a2", kind: "write_file", path: "src/a/other.ts", maxBytes: 4096 },
      ],
    },
  });
  const doc = {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [node({ provides: ["src/a/index.ts"], operations: ["auth-a"] })],
  };
  materializeTaskDag(k, doc);
  assert.deepEqual(materializeTaskDag(k, doc).createdOrder, [], "같은 문서는 멱등이어야 한다");

  // 같은 경로·같은 필드지만 **지시가 연 operation 집합이 다르다** — 본문 digest가 잡는다.
  const swapped = JSON.parse(JSON.stringify(doc)) as { tasks: Array<Record<string, unknown>> };
  swapped.tasks[0].operations = ["auth-a2"];
  assert.equal(codeOf(() => materializeTaskDag(k, swapped)), "dag_materialize_run_not_empty");
});
