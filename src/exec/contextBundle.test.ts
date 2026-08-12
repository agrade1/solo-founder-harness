/**
 * V3 M6 T3 — **context bundle** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/contextBundle.test.ts`
 * 네트워크·LLM·provider·프로세스 0.
 *
 * 고정하는 계약:
 * - **결정성**: 같은 revision에서 두 번 만들면 byte-identical이고, **프로세스를 바꿔 다시 열어도** 같다
 *   (이것이 coordinator rotation의 근거다 — M6 ③).
 * - **durable state만이 입력이다**: 시각·프로세스 메모리가 섞이면 위 등식이 깨진다.
 * - **bounded만 옮긴다**: 검증된 포인터(sha256)와 요약뿐이고 artifact 본문은 담기지 않는다.
 * - 의존 결과 · child 진행 · **미확인 inbox**가 빠지지 않는다(빠지면 교체된 coordinator가 전달을 놓친다).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATION_SCHEMA_VERSION, ORCHESTRATOR_ID, REQUIRED_BODY_HEADINGS, formatTimestamp } from "./orchestrationTypes.js";
import type { AgentMessageType, TaskState } from "./orchestrationTypes.js";
import { createOrchestrationRun, openOrchestrationRun } from "./orchestrationKernel.js";
import type { OrchestrationKernel, TaskSeed } from "./orchestrationKernel.js";
import { buildContextBundle, computeSnapshotDigest as digestOf } from "./contextBundle.js";

const RUN_ID = "m6-ctx-run";
const MILESTONE = "m6";
const T0 = Date.UTC(2026, 7, 12, 0, 0, 0);

const dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "m6-ctx-"));
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

function clockFrom(startMs: number): () => Date {
  let n = 0;
  return () => new Date(startMs + n++ * 1000);
}

function body(type: AgentMessageType): string {
  return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
}

function seed(taskId: string, roleId = "tech-lead", dependsOn: string[] = []): TaskSeed & { dependsOn: string[] } {
  return {
    taskId,
    roleId,
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: ["docs"],
    dependsOn,
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
  };
}

function manifest(taskIds: string[]): Record<string, unknown> {
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
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    maxSessions: 8,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}

function envelope(k: OrchestrationKernel, taskId: string, type: AgentMessageType, messageId: string): Record<string, unknown> {
  const state = k.getState();
  const task = k.getTask(taskId)!;
  const central = type === "task_assignment" || type === "review_request" || type === "revision_request" || type === "decision";
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    messageId,
    runId: state.runId,
    milestoneId: state.milestoneId,
    taskId,
    parentTaskId: task.parentTaskId,
    sender: central ? ORCHESTRATOR_ID : task.roleId,
    recipient: central ? task.roleId : ORCHESTRATOR_ID,
    type,
    createdAt: formatTimestamp(new Date(T0)),
    dependsOn: [],
    artifactRefs: [],
    supersedes: null,
  };
}

let n = 0;
const id = (p: string): string => `${p}.${++n}`;

/** running까지 올린다(preflight → prepared → running). */
function start(k: OrchestrationKernel, taskId: string): void {
  const batch = k.planRunnableBatch();
  if (batch.items.some((t) => t.taskId === taskId)) {
    k.commitPreflightBatch({
      baseRevision: batch.revision,
      actionId: id("pf"),
      decisions: batch.items.map((t) =>
        t.taskId === taskId ? ({ taskId: t.taskId, outcome: "prepared", attemptId: id("att") } as const) : ({ taskId: t.taskId, outcome: "deferred" } as const),
      ),
    });
  }
  k.startPreparedTask({ taskId, actionId: id("start"), leaseMarker: `lease.${(++n).toString(16).padStart(32, "0")}` });
}

/** running task를 결과와 함께 완료시킨다(정리 확인 → result 수락). */
function complete(k: OrchestrationKernel, taskId: string, summary: string, outputs: Array<{ path: string; role: string }> = []): void {
  const lease = k.getTask(taskId)!.execution.processLeaseMarker!;
  k.recordTerminal({ taskId, actionId: id("term"), marker: "turn_completed", pendingResult: { summary, outputs: outputs as never } });
  k.confirmCleanup({ taskId, actionId: id("clean"), leaseMarker: lease });
  k.completeTaskWithArtifacts({
    envelope: envelope(k, taskId, "result", `res-${taskId}`),
    body: body("result"),
    summary,
    outputs: outputs as never,
  });
}

interface Scene {
  ws: string;
  kernel: OrchestrationKernel;
}

/**
 * root(waiting_children) ← child(completed, artifact 1건) 구조 + sibling 전달 1건.
 * bundle이 담아야 하는 다섯 가지(스펙·의존 결과·child 진행·포인터·미확인 inbox)가 전부 나타난다.
 */
function scene(): Scene {
  const ws = makeDir();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs/child.md"), "# child 산출물\n");
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(["root", "dep"]),
    clock: clockFrom(T0),
  });
  k.createRootTask(seed("dep"));
  k.createDependentTask({ ...seed("root", "tech-lead", ["dep"]) });

  // dep을 완료시켜 root의 의존 결과를 만든다.
  start(k, "dep");
  complete(k, "dep", "dep 결과 요약");

  // root가 child 둘을 요청한다(같은 parent = 전달 가능한 관계).
  start(k, "root");
  k.requestSpawn({
    envelope: envelope(k, "root", "spawn_request", "spawn-c1"),
    body: body("spawn_request"),
    child: seed("c1", "qa-security"),
  });
  k.requestSpawn({
    envelope: envelope(k, "root", "spawn_request", "spawn-c2"),
    body: body("spawn_request"),
    child: seed("c2", "dev-lead"),
  });

  // c2 → 중앙 → c1 전달(수령하지 않은 채 둔다 — 미확인 inbox 표본).
  // 전달이 먼저인 이유: kernel은 **종료된 task를 수신자로 받지 않는다**(`recipient_unavailable`).
  start(k, "c1");
  start(k, "c2");
  k.submitStatusUpdate({
    envelope: envelope(k, "c2", "status_update", "stat-c2"),
    body: body("status_update"),
    summary: "c2 진행 공유",
    deliverTo: "c1",
  });

  // c1이 산출물을 내고 완료 → 그 result가 parent(root) inbox로 route된다.
  complete(k, "c1", "c1 결과 요약", [{ path: "docs/child.md", role: "output" }]);
  return { ws, kernel: k };
}

// ── 결정성 ──────────────────────────────────────────────────────────────────

test("[M6-T3] 같은 revision에서 두 번 만들면 byte-identical이다", () => {
  const { kernel } = scene();
  const state = kernel.getState();
  const a = buildContextBundle(state, "root");
  const b = buildContextBundle(kernel.getState(), "root");
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test("[M6-T3] 프로세스를 바꿔 다시 연 state에서도 같은 바이트다(rotation 근거)", () => {
  const { ws, kernel } = scene();
  const before = kernel.contextBundle("root");
  const revision = kernel.getState().revision;

  // **다른 clock으로** 다시 연다 — 시각이 섞였다면 여기서 갈라진다.
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 9_999_999) });
  assert.equal(reopened.getState().revision, revision, "재개가 revision을 바꿨다");
  assert.equal(reopened.contextBundle("root"), before);
});

test("[M6-T3] bundle 생성은 state·revision을 바꾸지 않는다(파생물)", () => {
  const { kernel } = scene();
  const before = kernel.getState();
  kernel.contextBundle("root");
  kernel.contextBundle("c1");
  const after = kernel.getState();
  assert.equal(after.revision, before.revision);
  assert.equal(after.lastEventId, before.lastEventId);
});

// ── 내용 ────────────────────────────────────────────────────────────────────

test("[M6-T3] 의존 결과·child 진행·포인터·미확인 inbox가 전부 들어간다", () => {
  const { kernel } = scene();
  const root = kernel.contextBundle("root");

  // task 스펙
  assert.match(root, /- taskId: root/);
  assert.match(root, /- role: tech-lead/);
  assert.match(root, /- state: waiting_children/);

  // 의존 결과 — bounded summary만
  assert.match(root, /- dep \[completed\] dep 결과 요약/);

  // child 진행 — 완료된 것과 진행 중인 것이 갈린다
  assert.match(root, /- c1 \[completed\] c1 결과 요약/);
  assert.match(root, /- c2 \[running\] \(no result yet\)/);

  // 미확인 inbox — c1의 result가 parent(root)에게 route돼 있고 아직 수령되지 않았다
  assert.match(root, /- res-c1 type=result from=c1\/qa-security summary=c1 결과 요약/);

  // c1의 bundle에는 c2가 보낸 전달이 미확인으로 들어간다
  const c1 = kernel.contextBundle("c1");
  assert.match(c1, /- stat-c2 type=status_update from=c2\/dev-lead summary=c2 진행 공유/);
});

test("[M6-T3] artifact는 검증된 포인터만 담고 본문은 담지 않는다", () => {
  const { kernel } = scene();
  const c1 = kernel.contextBundle("c1");
  const record = kernel.getState().artifacts[0]!;
  assert.match(c1, new RegExp(`- docs/child\\.md@${record.revision} \\(output\\) producer=c1 sha256=${record.sha256}`));
  assert.equal(c1.includes("# child 산출물"), false, "artifact 본문이 bundle에 실렸다");
});

test("[M6-T3] 위임한 parent의 bundle에 child 산출물 포인터가 들어간다", () => {
  const { kernel } = scene();
  const record = kernel.getState().artifacts[0]!;
  // child가 낸 산출물은 **위임한 parent가 다음 attempt에서 통합해야 하는 입력**이다. 빠지면 parent가
  // 자기 child의 결과물을 못 본 채 재개한다(M6 acceptance ⑥에서 실측으로 발견한 누락).
  assert.match(kernel.contextBundle("root"), new RegExp(`- ${record.path}@${record.revision} \\(output\\) producer=c1`));
});

test("[M6-T3] 미상 task는 fail-closed다", () => {
  const { kernel } = scene();
  // slug 형태이지만 존재하지 않는 id → `unknown_task`. slug가 아닌 입력은 그 전에 `invalid_id`로 막힌다.
  assert.throws(() => kernel.contextBundle("nope"), /unknown_task/);
  assert.throws(() => kernel.contextBundle("없는-task"), /invalid_id/);
});

test("[M6-T3] 시각·예산처럼 turn마다 변하는 값은 담지 않는다", () => {
  const { kernel } = scene();
  const root = kernel.contextBundle("root");
  // ISO 시각이 한 글자도 없어야 한다 — 있으면 교체 전후 등가성이 성립할 수 없다.
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(root), false, "bundle에 시각이 들어갔다");
  for (const forbidden of ["tokensUsed", "elapsedMsUsed", "budgetDeadlineAt"]) {
    assert.equal(root.includes(forbidden), false, `bundle에 turn마다 변하는 값이 들어갔다: ${forbidden}`);
  }
});

test("[M6-T3] 순서는 삽입 순서가 아니라 id 오름차순으로 고정된다", () => {
  const { kernel } = scene();
  const state = kernel.getState();
  // child를 역순으로 뒤집은 state 사본으로도 같은 바이트가 나와야 한다(정렬이 없으면 red).
  const shuffled = JSON.parse(JSON.stringify(state)) as typeof state;
  const root = shuffled.tasks.find((t) => t.taskId === "root")!;
  root.childTaskIds.reverse();
  shuffled.messages.reverse();
  shuffled.tasks.reverse();
  assert.equal(buildContextBundle(shuffled, "root"), buildContextBundle(state, "root"));
});

test("[M6-T3] 상태가 다르면 bundle도 다르다(공허한 결정성이 아니다)", () => {
  const { kernel } = scene();
  const state = kernel.getState();
  const mutated = JSON.parse(JSON.stringify(state)) as typeof state;
  mutated.tasks.find((t) => t.taskId === "c1")!.state = "blocked" as TaskState;
  assert.notEqual(buildContextBundle(mutated, "root"), buildContextBundle(state, "root"));
});

// ── V3 M6 T4 — coordinator 교체 등가성 (완료 조건 ③) ────────────────────────
//
// "coordinator를 교체해도 같다"를 사람 눈이 아니라 세 해시로 판정한다. rotation 자체에 새 코드는 거의
// 없다 — **기존 durable 재개가 이미 그것**이고, 이 절이 하는 일은 그것을 **증명**하는 것이다.

test("[M6-T4] 프로세스를 종료하고 다시 연 coordinator의 다이제스트가 교체 전과 일치한다", () => {
  const { ws, kernel } = scene();
  const before = kernel.snapshotDigest();

  // 교체: 이 kernel 인스턴스를 버리고(=coordinator 종료) **다른 clock으로** 새로 연다.
  const rotated = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 9_999_999) });
  assert.deepEqual(rotated.snapshotDigest(), before);

  // 다이제스트가 **비어 있지 않다**는 것도 함께 고정한다(빈 run의 상수 해시를 비교하는 공허한 체크 방지).
  assert.notEqual(before.graphHash, before.decisionHash);
  assert.notEqual(before.decisionHash, before.artifactHash);
  for (const h of Object.values(before)) assert.match(h, /^[0-9a-f]{64}$/);
});

test("[M6-T4] 다이제스트는 read-only다 — 계산해도 state·revision이 움직이지 않는다", () => {
  const { kernel } = scene();
  const before = kernel.getState();
  kernel.snapshotDigest();
  kernel.snapshotDigest();
  const after = kernel.getState();
  assert.equal(after.revision, before.revision);
  assert.equal(after.lastEventId, before.lastEventId);
});

test("[M6-T4] 교체 후 task 하나를 위조하면 graphHash가 갈린다", () => {
  const { ws, kernel } = scene();
  const before = kernel.snapshotDigest();
  const rotated = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 1_000) });

  // durable 파일을 고칠 수는 없다(hash chain이 막는다) — 대신 **다이제스트 입력이 실제로 그 필드에
  // 반응하는지**를 순수 계산으로 확인한다. 반응하지 않으면 위 일치 테스트는 공허하다.
  const s = rotated.getState();
  const forge = (mutate: (draft: typeof s) => void): { graphHash: string; decisionHash: string; artifactHash: string } => {
    const draft = JSON.parse(JSON.stringify(s)) as typeof s;
    mutate(draft);
    return digestOf(draft);
  };
  assert.notEqual(forge((d) => (d.tasks.find((t) => t.taskId === "c1")!.state = "blocked" as TaskState)).graphHash, before.graphHash);
  assert.notEqual(forge((d) => d.tasks.find((t) => t.taskId === "root")!.dependsOn.push("c2")).graphHash, before.graphHash);
  assert.notEqual(forge((d) => (d.messages.find((m) => m.messageId === "res-c1")!.summary = "위조")).decisionHash, before.decisionHash);
  assert.notEqual(forge((d) => (d.artifacts[0]!.sha256 = "0".repeat(64))).artifactHash, before.artifactHash);
});

test("[M6-T4] 시각·revision은 다이제스트에 들어가지 않는다(교체 전후가 같을 수 있는 이유)", () => {
  const { kernel } = scene();
  const s = kernel.getState();
  const base = digestOf(s);
  const touched = JSON.parse(JSON.stringify(s)) as typeof s;
  touched.updatedAt = "2099-01-01T00:00:00.000Z";
  touched.revision += 7;
  touched.lastEventId += 7;
  for (const t of touched.tasks) {
    t.updatedAt = "2099-01-01T00:00:00.000Z";
    t.createdAt = "2099-01-01T00:00:00.000Z";
  }
  assert.deepEqual(digestOf(touched), base, "시각·revision이 다이제스트에 섞였다");
});

test("[M6-T4] 다이제스트는 배열의 저장 순서에 의존하지 않는다(정렬이 실제로 일한다)", () => {
  const { kernel } = scene();
  const s = kernel.getState();
  const base = digestOf(s);
  // 같은 내용, 다른 저장 순서. 정렬이 없으면 다른 해시가 나온다 — 그러면 교체 전후 일치가
  // "durable 순서가 우연히 같았다"에 기대는 셈이라 등가성 주장이 약해진다.
  const shuffled = JSON.parse(JSON.stringify(s)) as typeof s;
  shuffled.tasks.reverse();
  shuffled.messages.reverse();
  shuffled.artifacts.reverse();
  for (const t of shuffled.tasks) t.dependsOn.reverse();
  assert.deepEqual(digestOf(shuffled), base);
  // 표본이 1건뿐이면 reverse가 아무것도 안 바꾼다 — 뒤집을 것이 실제로 있었는지 확인한다.
  assert.ok(s.tasks.length > 1 && s.messages.length > 1, "순서 테스트 표본이 부족하다(공허한 체크)");
});

// ── V3 M6 T5 — fresh-session 강제 (attempt 신원 · coordinator 교체) ──────────

test("[M6-T5] 새 attempt는 직전 attempt의 attemptId를 재사용할 수 없다", () => {
  const { kernel } = scene();
  // c2는 running이다 — 정리하고 attempt를 떠나 retry_wait으로 보낸 뒤 다음 preflight를 연다.
  const lease = kernel.getTask("c2")!.execution.processLeaseMarker!;
  const used = kernel.getTask("c2")!.execution.attemptId!;
  kernel.recordTerminal({ taskId: "c2", actionId: id("term"), marker: "worker_failed" });
  kernel.confirmCleanup({ taskId: "c2", actionId: id("clean"), leaseMarker: lease });
  kernel.settleCleanedAttempt({ taskId: "c2", actionId: id("settle") });
  assert.equal(kernel.getTask("c2")!.state, "retry_wait");

  const batch = kernel.planRunnableBatch();
  const decide = (attemptId: string) => (): unknown =>
    kernel.commitPreflightBatch({
      baseRevision: kernel.planRunnableBatch().revision,
      actionId: id("pf"),
      decisions: batch.items.map((t) =>
        t.taskId === "c2" ? ({ taskId: t.taskId, outcome: "prepared", attemptId } as const) : ({ taskId: t.taskId, outcome: "deferred" } as const),
      ),
    });

  // 직전 attempt와 같은 신원 → 거부. 전이 0이다.
  assert.throws(decide(used), /attempt_id_reused/);
  assert.equal(kernel.getTask("c2")!.state, "retry_wait", "거부된 preflight가 상태를 바꿨다");
  // 새 신원이면 통과한다(위 거부가 "그냥 다 막는다"가 아님을 고정).
  decide(id("att"))();
  assert.equal(kernel.getTask("c2")!.state, "prepared");
});

test("[M6-T5] 교체된 coordinator는 이전 프로세스의 in-memory 권위를 이어받지 못한다", () => {
  const ws = makeDir();
  mkdirSync(join(ws, "docs"), { recursive: true });
  const a = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifest(["root"]),
    clock: clockFrom(T0),
  });
  a.createRootTask(seed("root"));
  start(a, "root");

  // 교체: 같은 durable run을 새 인스턴스로 연다.
  const b = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: clockFrom(T0 + 5_000) });
  // durable 진실은 그대로 이어진다.
  assert.equal(b.getTask("root")!.state, "running");
  assert.deepEqual(b.snapshotDigest(), a.snapshotDigest());

  // 그러나 **in-memory 권위는 이어지지 않는다**: 새 인스턴스는 이전 프로세스의 진행 채널을 받지 못하고,
  // durable 값(`processLeaseMarker`)을 베껴 채널을 되만드는 공개 통로도 없다.
  const durableLease = b.getTask("root")!.execution.processLeaseMarker!;
  const forged = Object.freeze({ runId: RUN_ID, taskId: "root", attemptId: b.getTask("root")!.execution.attemptId! });
  assert.throws(
    () => b.recordProgress({ channel: forged as never, actionId: id("prog"), event: { kind: "progress", seq: 1, step: "x" } }),
    /invalid_progress_channel/,
    "durable 값만으로 진행 채널을 되만들 수 있다",
  );
  assert.match(durableLease, /^lease\./); // lease는 durable하지만 그 자체가 권위가 아니다
});
