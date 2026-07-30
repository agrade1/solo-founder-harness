/**
 * V3 M4a — durable orchestration kernel focused 테스트. 실행: `npm run test:exec`.
 * 네트워크·LLM·provider·TTY 없이 임시 workspace에서만 돈다(무과금).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_MESSAGE_TYPES,
  APPROVED_OPERATION_KINDS,
  ARTIFACT_ROLES,
  AUTOPILOT_MARKERS,
  CENTRAL_MESSAGE_TYPES,
  CLEANUP_STATUSES,
  DELIVERY_MARKERS,
  EVENT_TYPES,
  LIMITS,
  PAUSE_REASONS,
  RESOURCE_HOLDING_STATES,
  RUN_STATE_SCHEMA_VERSION,
  SAFETY_ONLY_EVENT_TYPES,
  SAFETY_ONLY_REASONS,
  SUMMARY_REQUIRED,
  ORCHESTRATION_SCHEMA_VERSION,
  ORCHESTRATOR_ID,
  OrchestrationError,
  REQUIRED_BODY_HEADINGS,
  SHA256_PATTERN,
  SLUG_PATTERN,
  TASK_STATES,
  TIMESTAMP_PATTERN,
  TRANSITION_REASONS,
  type AgentMessageType,
  type AutopilotMarker,
  type MessageIndexEntry,
  type OrchestrationTask,
  emptyMessageDelivery,
  emptyTaskExecution,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { ARTIFACT_POINTER_KEYS, ENVELOPE_KEYS, validateEnvelope, validateMessageBody } from "./agentMessage.js";
import {
  AUTOPILOT_POLICY_KEYS,
  COMMAND_PATTERN,
  COMMIT_PATTERN,
  DEPENDENCY_KEYS,
  RUN_PROCESS_AUTHORITY_KEYS,
  WRITE_FILE_AUTHORITY_KEYS,
  DEPENDENCY_NAME_PATTERN,
  DEPENDENCY_VERSION_PATTERN,
  DOMAIN_PATTERN,
  MANIFEST_KEYS,
  SPECIALIST_ROLES,
  commandAllowed,
  dependencyAllowed,
  isRegistryRoleId,
  networkDomainAllowed,
  validateApprovalManifest,
  APPROVED_EXECUTABLE_KEYS,
  APPROVED_PATH_PATTERN,
  EXECUTION_AUTHORITY_KEYS,
} from "./approvalManifest.js";
import {
  ACCOUNTING_KEYS,
  ARTIFACT_RECORD_KEYS,
  COMMIT_STAGES,
  type CommitStage,
  DELIVERY_KEYS,
  EVENT_KEYS,
  EVENT_MARKERS,
  MESSAGE_KEYS,
  manifestDigest,
  OPERATION_RECEIPT_KEYS,
  OPERATION_RECEIPT_MARKERS,
  PENDING_RESULT_KEYS,
  STATE_KEYS,
  TASK_EXECUTION_KEYS,
  TASK_KEYS,
  acquireRunWriterLock,
  assertExclusiveResourceClaims,
  assertNoDependencyCycle,
  commitRun,
  releaseRunWriterLock,
  runPaths,
  setCommitFaultHook,
  stateContentDigest,
  validateRunState,
} from "./orchestrationStore.js";
import {
  OrchestrationKernel,
  attestOrchestrationKernel,
  createOrchestrationRun,
  openOrchestrationRun,
} from "./orchestrationKernel.js";
import * as kernelModule from "./orchestrationKernel.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_ID = "m4a-run";
const MILESTONE = "m4a";

const workspaces: string[] = [];
function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "m4a-kernel-"));
  workspaces.push(ws);
  return ws;
}
process.on("exit", () => {
  for (const ws of workspaces) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과를 바꾸지 않는다 */
    }
  }
});

/** 결정론적 clock — 호출마다 1초씩 전진. */
function fixedClock(): () => Date {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 27, 0, 0, n++));
}

function body(type: AgentMessageType, extra = ""): string {
  return `${REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n")}${extra}`;
}

interface EnvOverrides {
  [k: string]: unknown;
}

function envelope(type: AgentMessageType, taskId: string, roleId: string, over: EnvOverrides = {}): EnvOverrides {
  const agentSent = !(CENTRAL_MESSAGE_TYPES as readonly string[]).includes(type);
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    messageId: `msg-${taskId}-${type}`,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    taskId,
    parentTaskId: null,
    sender: agentSent ? roleId : ORCHESTRATOR_ID,
    recipient: agentSent ? ORCHESTRATOR_ID : roleId,
    type,
    createdAt: "2026-07-27T00:00:00.000Z",
    dependsOn: [],
    artifactRefs: [],
    supersedes: null,
    ...over,
  };
}

function seed(taskId: string, roleId: string, over: Record<string, unknown> = {}) {
  return {
    taskId,
    roleId,
    title: `${taskId} 제목`,
    scope: `${taskId} bounded scope`,
    ownership: [`src/${taskId}/`.replace(/\/$/, "")],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: body("task_assignment"),
    ...over,
  };
}

const APPROVED_COMMIT = "a".repeat(40);

/**
 * 승인된 실행 권위(6차 리뷰 A1). kernel 테스트는 프로세스를 띄우지 않으므로 **형태만** 필요하다
 * (파일 내용 검증은 실행 경계·provider·controller 테스트가 실제 파일로 한다).
 */
const EXECUTION_AUTHORITY = {
  codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
  git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
  // M5c(v2) — managed process supervisor용 node와 자손 관측용 실행 파일도 승인 대상이다.
  node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
  processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
};

/** M5c autopilot 정책 기본 fixture(전부 필수 — manifest에 없으면 `manifest_pre_m5c_unsupported`다). */
const AUTOPILOT_POLICY = {
  maxTaskAttempts: 4,
  maxDeliveryAttempts: 4,
  retryBackoffMs: 0,
  deliveryDeadlineMs: 600_000,
  maxNoProgressMs: 60_000,
  maxAttemptElapsedMs: 600_000,
  cleanupTermGraceMs: 500,
  cleanupKillGraceMs: 500,
};

/**
 * §8 승인 manifest. **root/dependent task는 여기에 명시된 것만** 만들 수 있고
 * child는 parent ownership 위임으로 검사된다. 테스트가 만들 root/dependent id를 넘긴다.
 */
function manifestFor(taskIds: string[], over: Record<string, unknown> = {}) {
  const ownershipByTask: Record<string, string[]> = {};
  for (const id of taskIds) ownershipByTask[id] = ["docs", "src"];
  return {
    milestoneId: MILESTONE,
    approvedCommit: APPROVED_COMMIT,
    writableRoots: ["docs", "src"],
    ownershipByTask,
    allowedCommands: ["npm run build", "npm test"],
    allowedDependencies: [{ name: "typescript", version: "5.7.2" }],
    allowedNetworkDomains: ["registry.npmjs.org"],
    executionAuthority: EXECUTION_AUTHORITY,
    autopilotPolicy: AUTOPILOT_POLICY,
    operationAuthorityByTask: {},
    maxSessions: 8,
    maxTokens: 200000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...over,
  };
}

/** run 디렉터리 전체의 파일별 hash — "전이 0" 단정용. */
function dirFingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return out.join("\n");
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(e)}`);
    return (e as OrchestrationError).code;
  }
  throw new Error("거부될 것으로 기대했지만 통과했다");
}

// ── M5c lifecycle 프로토콜 헬퍼 ──────────────────────────────────────────────
//
// M5c부터 시작은 `planRunnableBatch` → `commitPreflightBatch`(원자적) → `startPreparedTask`뿐이고
// 완료·차단은 `recordTerminal` → `confirmCleanup` 뒤에만 수락된다(대장 `B-11`/`B-13`).
// 아래 헬퍼는 **그 진짜 경로를 그대로** 지난다 — 프로토콜을 우회하거나 흉내내지 않는다.

let counter = 0;
const nextAction = (): string => `act.${++counter}`;
const nextAttempt = (): string => `att.${++counter}`;
const nextLease = (): string => `lease.${(++counter).toString(16).padStart(32, "0")}`;

/**
 * taskId → 그 attempt의 lease marker. `startVia`가 기록하고 `cleanVia`가 읽는다 —
 * 35개 호출부에 lease를 손으로 꿰지 않기 위한 테스트 국소 장부다(계약이 아니다).
 */
const leaseOf = new Map<string, string>();

/**
 * **진짜 시작 경로**: batch 전체에 결정을 주되 `taskId`만 `prepared`로 올리고(나머지는 `deferred` —
 * 상태·attempt·자원을 건드리지 않는다) 곧바로 `startPreparedTask`로 `running`까지 간다.
 * batch에 없는 task를 넣으면 `preflight_batch_mismatch`가 나므로 이 헬퍼도 scheduler를 우회하지 못한다.
 */
function startVia(k: OrchestrationKernel, taskId: string): OrchestrationTask {
  startBatchVia(k, [taskId]);
  return k.getTask(taskId)!;
}

/**
 * batch 전체에 결정을 **한 커밋으로** 주고(`wanted`만 `prepared`, 나머지는 `deferred`) 그 다음
 * `wanted`를 하나씩 `running`으로 올린다. M5b의 `startScheduledBatch()`가 하던 일을 M5c 계약으로 다시
 * 쓴 것이다: **batch의 원자성은 preflight에 있고 실제 시작은 task 하나씩**이므로, 어떤 batch 실패도
 * 남은 task를 running으로 흘리지 않는다(대장 `B-11`).
 */
function startBatchVia(k: OrchestrationKernel, wanted: string[]): void {
  const batch = k.planRunnableBatch();
  k.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextAction(),
    decisions: batch.items.map((t) =>
      wanted.includes(t.taskId)
        ? { taskId: t.taskId, outcome: "prepared" as const, attemptId: nextAttempt() }
        : { taskId: t.taskId, outcome: "deferred" as const },
    ),
  });
  for (const taskId of wanted) {
    const leaseMarker = nextLease();
    leaseOf.set(taskId, leaseMarker);
    k.startPreparedTask({ taskId, actionId: nextAction(), leaseMarker });
  }
}

/**
 * **완료·차단 수락 자격을 만드는 진짜 경로**: `running` → `cleaning`(종료 관측) → zero-survivor 확인.
 * `marker`가 `turn_completed`면 미확정 결과를 봉인한다(성공 turn 계약).
 */
function cleanVia(k: OrchestrationKernel, taskId: string, marker: AutopilotMarker = "turn_completed"): void {
  k.recordTerminal({
    taskId,
    actionId: nextAction(),
    marker,
    pendingResult: marker === "turn_completed" ? { summary: "ok", outputs: [] } : null,
  });
  const leaseMarker = leaseOf.get(taskId);
  assert.ok(leaseMarker !== undefined, `startVia로 시작하지 않은 task다: ${taskId}`);
  k.confirmCleanup({ taskId, actionId: nextAction(), leaseMarker });
}

/** root 하나를 running까지 올린 kernel. `extra`는 그 run이 추가로 만들 root/dependent task id다. */
function bootRoot(extra: string[] = [], ws = makeWorkspace()): { ws: string; k: OrchestrationKernel } {
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root", ...extra]),
    clock: fixedClock(),
  });
  // `docs`도 소유한다 — 아래 artifact 테스트가 `docs/a.md`를 이 task의 산출물로 등록하고,
  // M5b부터 `registerArtifact`가 **소유권을 집행**하므로 픽스처가 정직해야 한다(`artifact_not_owned`).
  k.createRootTask(seed("root", "tech-lead", { ownership: ["docs", "src/root"] }));
  startVia(k, "root");
  return { ws, k };
}

/**
 * root를 **결과 수락 자격**까지 올린 kernel. M5c부터 `completed`/`blocked`는 확인된 zero-survivor 정리
 * 뒤에만 가능하므로(대장 `B-13`), 완료 트랜잭션을 검사하는 테스트는 여기서 시작한다.
 */
function ackVia(k: OrchestrationKernel, taskId: string, messageId: string): MessageIndexEntry {
  k.beginDeliveryAttempt({ taskId, messageId, actionId: nextAction(), attemptId: nextAttempt() });
  return k.acknowledgeDelivery({ taskId, messageId, actionId: nextAction() });
}

function bootCleanedRoot(extra: string[] = [], ws = makeWorkspace()): { ws: string; k: OrchestrationKernel } {
  const booted = bootRoot(extra, ws);
  cleanVia(booted.k, "root");
  return booted;
}

// ── envelope / body 계약 ────────────────────────────────────────────────────

test("[M4a] 유효 envelope는 정규화 사본으로 통과한다", () => {
  const e = validateEnvelope(envelope("result", "root", "tech-lead"));
  assert.equal(e.type, "result");
  assert.equal(e.schemaVersion, "1");
  assert.deepEqual(e.artifactRefs, []);
});

test("[M4a] envelope: 미구현 타입·필드 누락·미지 필드·잘못된 값 거부", () => {
  // M4c: §5.1의 10종은 전부 유효하고, union 밖 타입은 여전히 거부한다(계약이 열린 적은 없다).
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { type: "roadmap_change_proposal" }))), "unsupported_message_type");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { type: "Result" }))), "unsupported_message_type");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { type: null }))), "unsupported_message_type");
  const missing = envelope("result", "root", "pm");
  delete missing.supersedes;
  assert.equal(codeOf(() => validateEnvelope(missing)), "invalid_envelope");
  assert.equal(codeOf(() => validateEnvelope({ ...envelope("result", "root", "pm"), extra: 1 })), "invalid_envelope");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { schemaVersion: "2" }))), "invalid_envelope");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { createdAt: "2026-07-27T00:00:00Z" }))), "invalid_timestamp");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { messageId: "Bad Id" }))), "invalid_id");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { dependsOn: ["a", "a"] }))), "depends_on_duplicate");
  assert.equal(codeOf(() => validateEnvelope("nope")), "invalid_envelope");
});

test("[M4a] envelope artifactRefs: closed key · role enum · revision 범위 · sha 형식", () => {
  const ref = { path: "docs/a.md", sha256: "a".repeat(64), revision: 1, producerTaskId: "root", role: "output" };
  assert.equal(validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [ref] })).artifactRefs[0].path, "docs/a.md");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [{ ...ref, role: "raw" }] }))), "invalid_artifact_ref");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [{ ...ref, revision: 0 }] }))), "invalid_artifact_ref");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [{ ...ref, sha256: "XY" }] }))), "invalid_sha256");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [{ ...ref, extra: 1 }] }))), "invalid_artifact_ref");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [ref, ref] }))), "artifact_ref_duplicate");
  assert.equal(codeOf(() => validateEnvelope(envelope("result", "root", "pm", { artifactRefs: [{ ...ref, path: "/etc/passwd" }] }))), "path_absolute");
});

test("[M4a] 타입별 필수 Markdown heading: 유효 body 통과 · 누락 · 미지 heading · 중복", () => {
  for (const type of AGENT_MESSAGE_TYPES) {
    assert.equal(validateMessageBody(type, body(type)), body(type));

    const required = REQUIRED_BODY_HEADINGS[type];
    for (const drop of required) {
      const partial = required.filter((h) => h !== drop).map((h) => `## ${h}\n\nx\n`).join("\n");
      assert.equal(codeOf(() => validateMessageBody(type, partial)), "body_missing_heading", `${type}/${drop}`);
    }
    assert.equal(codeOf(() => validateMessageBody(type, `${body(type)}\n## Extra Section\n\nx\n`)), "body_unknown_heading");
    assert.equal(codeOf(() => validateMessageBody(type, `${body(type)}\n## ${required[0]}\n\nx\n`)), "body_duplicate_heading");
  }
});

test("[M4a] body 크기 상한과 빈 body 거부, 코드펜스 안의 ##은 heading이 아니다", () => {
  const big = body("blocker") + "x".repeat(LIMITS.maxBodyBytes);
  assert.equal(codeOf(() => validateMessageBody("blocker", big)), "body_too_large");
  assert.equal(codeOf(() => validateMessageBody("blocker", "   ")), "invalid_body");
  assert.equal(codeOf(() => validateMessageBody("blocker", 5)), "invalid_body");
  const fenced = `${body("blocker")}\n\`\`\`\n## Not A Heading\n\`\`\`\n`;
  assert.equal(validateMessageBody("blocker", fenced), fenced);
});

// ── ownership / path 정규화 ─────────────────────────────────────────────────

test("[M4a] path 정규화: '.'만 접고 absolute/'..'/빈 segment/backslash/NUL은 거부", () => {
  assert.equal(normalizeWorkspacePath("./src/./a.ts", "p"), "src/a.ts");
  assert.equal(normalizeWorkspacePath("src/a.ts", "p"), "src/a.ts");
  assert.equal(codeOf(() => normalizeWorkspacePath("/etc/passwd", "p")), "path_absolute");
  assert.equal(codeOf(() => normalizeWorkspacePath("C:/x", "p")), "path_absolute");
  assert.equal(codeOf(() => normalizeWorkspacePath("../outside", "p")), "path_parent_segment");
  assert.equal(codeOf(() => normalizeWorkspacePath("src/../../outside", "p")), "path_parent_segment");
  assert.equal(codeOf(() => normalizeWorkspacePath("src//a", "p")), "path_empty_segment");
  assert.equal(codeOf(() => normalizeWorkspacePath("src/a/", "p")), "path_empty_segment");
  assert.equal(codeOf(() => normalizeWorkspacePath("", "p")), "path_empty");
  assert.equal(codeOf(() => normalizeWorkspacePath("src\\a", "p")), "path_backslash");
  assert.equal(codeOf(() => normalizeWorkspacePath("src/\0a", "p")), "path_nul");
  assert.equal(codeOf(() => normalizeWorkspacePath("x".repeat(LIMITS.maxPathLength + 1), "p")), "path_too_long");
});

test("[M4a] task ownership: 정규화·정렬·중복 거부 · workspace 탈출 거부", () => {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root"]),
    clock: fixedClock(),
  });
  const t = k.createRootTask(seed("root", "tech-lead", { ownership: ["./src/b.ts", "src/a.ts"] }));
  assert.deepEqual(t.ownership, ["src/a.ts", "src/b.ts"]);

  assert.equal(codeOf(() => k.createRootTask(seed("t1", "pm", { ownership: ["../escape"] }))), "path_parent_segment");
  assert.equal(codeOf(() => k.createRootTask(seed("t2", "pm", { ownership: ["/abs"] }))), "path_absolute");
  assert.equal(codeOf(() => k.createRootTask(seed("t3", "pm", { ownership: [] }))), "invalid_ownership");
  assert.equal(codeOf(() => k.createRootTask(seed("t4", "pm", { ownership: ["a.ts", "./a.ts"] }))), "ownership_duplicate");
});

// ── id / 의존성 계약 ────────────────────────────────────────────────────────

test("[M4a] duplicate task id · duplicate message id · unknown dependency · 자기 의존", () => {
  const { k } = bootRoot();
  assert.equal(codeOf(() => k.createRootTask(seed("root", "pm"))), "duplicate_task_id");
  assert.equal(codeOf(() => k.createRootTask(seed("other", "pm", { assignmentMessageId: "asg-root" }))), "duplicate_message_id");
  assert.equal(codeOf(() => k.createDependentTask({ ...seed("dep", "pm"), dependsOn: ["nope"] })), "unknown_dependency");
  assert.equal(codeOf(() => k.createDependentTask({ ...seed("dep", "pm"), dependsOn: ["dep"] })), "self_dependency");
});

test("[M4a] dependency cycle 검사(반복 DFS)", () => {
  const base = {
    roleId: "pm",
    title: "t",
    scope: "s",
    ownership: ["a"],
    resourceClasses: [],
    parentTaskId: null,
    childTaskIds: [],
    state: "pending" as const,
    depth: 0,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    resultSummary: null,
    blockerSummary: null,
    artifactRefs: [],
    // M5c(v2) — `task.execution`은 durable 계약이므로 손으로 만드는 fixture도 갖고 있어야 한다.
    execution: emptyTaskExecution(),
  };
  const acyclic = [
    { ...base, taskId: "a", dependsOn: [] },
    { ...base, taskId: "b", dependsOn: ["a"] },
    { ...base, taskId: "c", dependsOn: ["a", "b"] },
  ];
  assert.doesNotThrow(() => assertNoDependencyCycle(acyclic));

  const cyclic = [
    { ...base, taskId: "a", dependsOn: ["c"] },
    { ...base, taskId: "b", dependsOn: ["a"] },
    { ...base, taskId: "c", dependsOn: ["b"] },
  ];
  assert.equal(codeOf(() => assertNoDependencyCycle(cyclic)), "dependency_cycle");
  assert.equal(codeOf(() => assertNoDependencyCycle([{ ...base, taskId: "a", dependsOn: ["a"] }])), "dependency_cycle");
});

// ── spawn 상한 / nested child ───────────────────────────────────────────────

test("[M4a] spawn: task당 child 4개 상한", () => {
  const { k } = bootRoot();
  for (let i = 1; i <= LIMITS.maxChildrenPerTask; i++) {
    k.requestSpawn({
      envelope: envelope("spawn_request", "root", "tech-lead", { messageId: `spawn-${i}` }),
      body: body("spawn_request"),
      child: seed(`child${i}`, "dev-lead", { ownership: ["src/root"] }),
    });
  }
  assert.equal(k.getTask("root")!.childTaskIds.length, 4);
  assert.equal(
    codeOf(() =>
      k.requestSpawn({
        envelope: envelope("spawn_request", "root", "tech-lead", { messageId: "spawn-5" }),
        body: body("spawn_request"),
        child: seed("child5", "dev-lead"),
      }),
    ),
    "child_limit_exceeded",
  );
});

test("[M4a] nested child spawn과 최대 depth 3 상한", () => {
  const { k } = bootRoot();
  let parent = "root";
  let role = "tech-lead";
  for (let depth = 1; depth <= LIMITS.maxDepth; depth++) {
    const child = `d${depth}`;
    k.requestSpawn({
      envelope: envelope("spawn_request", parent, role, { messageId: `spawn-${depth}`, parentTaskId: k.getTask(parent)!.parentTaskId }),
      body: body("spawn_request"),
      // child는 parent가 가진 ownership 안에서만 위임받는다(여기선 parent 범위 그대로).
      child: seed(child, `dev-lead.d${depth}`, { ownership: ["src/root"] }),
    });
    assert.equal(k.getTask(child)!.depth, depth);
    assert.equal(k.getTask(parent)!.state, "waiting_children");
    assert.equal(k.getTask(child)!.state, "ready");
    startVia(k, child);
    parent = child;
    role = `dev-lead.d${depth}`;
  }
  assert.equal(
    codeOf(() =>
      k.requestSpawn({
        envelope: envelope("spawn_request", parent, role, { messageId: "spawn-too-deep", parentTaskId: k.getTask(parent)!.parentTaskId }),
        body: body("spawn_request"),
        child: seed("too-deep", "dev-lead.d4"),
      }),
    ),
    "depth_limit_exceeded",
  );
});

test("[M4a] run 전체 task 32개 상한", () => {
  const ws = makeWorkspace();
  const ids = Array.from({ length: LIMITS.maxTasksPerRun }, (_, i) => `t${i}`);
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(ids),
    clock: fixedClock(),
  });
  for (const id of ids) k.createRootTask(seed(id, "pm"));
  assert.equal(k.getState().tasks.length, LIMITS.maxTasksPerRun);
  assert.equal(codeOf(() => k.createRootTask(seed("overflow", "pm"))), "task_limit_exceeded");
});

// ── 상태 전이 / 전파 ────────────────────────────────────────────────────────

test("[M4a] result: child completed → parent ready · dependent ready", () => {
  const { k } = bootRoot(["dependent"]);
  k.requestSpawn({
    envelope: envelope("spawn_request", "root", "tech-lead", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    child: seed("child", "dev-lead", { ownership: ["src/root"] }),
  });
  k.createDependentTask({ ...seed("dependent", "qa-security"), dependsOn: ["child"] });

  assert.equal(k.getTask("root")!.state, "waiting_children");
  assert.equal(k.getTask("child")!.state, "ready");
  assert.equal(k.getTask("dependent")!.state, "pending");
  assert.deepEqual(k.listReady().map((t) => t.taskId), ["child"]);

  startVia(k, "child");
  cleanVia(k, "child");
  k.submitResult({
    envelope: envelope("result", "child", "dev-lead", { messageId: "res-child", parentTaskId: "root" }),
    body: body("result"),
    summary: "child 완료 요약",
  });

  assert.equal(k.getTask("child")!.state, "completed");
  assert.equal(k.getTask("root")!.state, "ready");
  assert.equal(k.getTask("dependent")!.state, "ready");
  assert.deepEqual(k.listReady().map((t) => t.taskId), ["dependent", "root"]);
});

test("[M4a] blocker: child blocked → parent blocked · dependent blocked (조상까지 전파)", () => {
  const { k } = bootRoot(["dependent"]);
  k.requestSpawn({
    envelope: envelope("spawn_request", "root", "tech-lead", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    child: seed("child", "dev-lead", { ownership: ["src/root"] }),
  });
  startVia(k, "child");
  k.requestSpawn({
    envelope: envelope("spawn_request", "child", "dev-lead", { messageId: "spawn-2", parentTaskId: "root" }),
    body: body("spawn_request"),
    child: seed("grandchild", "dev-lead.sub", { ownership: ["src/root"] }),
  });
  k.createDependentTask({ ...seed("dependent", "qa-security"), dependsOn: ["grandchild"] });
  startVia(k, "grandchild");
  // `blocked`도 자원을 놓는 종료 상태이므로 확인된 정리 뒤에만 수락된다(대장 `B-13`).
  cleanVia(k, "grandchild", "worker_failed");

  k.submitBlocker({
    envelope: envelope("blocker", "grandchild", "dev-lead.sub", { messageId: "blk-1", parentTaskId: "child" }),
    body: body("blocker"),
    summary: "외부 승인 필요",
  });

  assert.equal(k.getTask("grandchild")!.state, "blocked");
  assert.equal(k.getTask("child")!.state, "blocked");
  assert.equal(k.getTask("root")!.state, "blocked");
  assert.equal(k.getTask("dependent")!.state, "blocked");
  assert.deepEqual(k.listReady(), []);
  assert.equal(k.getTask("grandchild")!.blockerSummary, "외부 승인 필요");
});

test("[M4a] 완료된 task는 blocked로 되돌아가지 않는다", () => {
  const { k } = bootRoot();
  k.requestSpawn({
    envelope: envelope("spawn_request", "root", "tech-lead", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    child: seed("c1", "dev-lead", { ownership: ["src/root"] }),
  });
  k.requestSpawn({
    envelope: envelope("spawn_request", "root", "tech-lead", { messageId: "spawn-2" }),
    body: body("spawn_request"),
    child: seed("c2", "dev-lead", { ownership: ["src/root"] }),
  });
  startVia(k, "c1");
  cleanVia(k, "c1");
  k.submitResult({
    envelope: envelope("result", "c1", "dev-lead", { messageId: "res-c1", parentTaskId: "root" }),
    body: body("result"),
    summary: "c1 완료",
  });
  startVia(k, "c2");
  cleanVia(k, "c2", "worker_failed");
  k.submitBlocker({
    envelope: envelope("blocker", "c2", "dev-lead", { messageId: "blk-c2", parentTaskId: "root" }),
    body: body("blocker"),
    summary: "c2 막힘",
  });
  assert.equal(k.getTask("c1")!.state, "completed");
  assert.equal(k.getTask("c2")!.state, "blocked");
  assert.equal(k.getTask("root")!.state, "blocked");
});

test("[M4a] 잘못된 상태 전이 거부", () => {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["a", "b"]),
    clock: fixedClock(),
  });
  k.createDependentTask({ ...seed("a", "pm"), dependsOn: [] });
  k.createDependentTask({ ...seed("b", "pm"), dependsOn: ["a"] });
  // ⓐ pending task는 scheduler가 고르지 않으므로 preflight 결정에 끼워 넣을 수도 없다
  //   (M5c에서 "pending을 시작할 수 없다"는 이 경로로 증명된다 — 우회 진입점이 없다).
  const pendingBatch = k.planRunnableBatch();
  assert.deepEqual(pendingBatch.items.map((t) => t.taskId), ["a"], "pending b는 batch에 없다");
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: pendingBatch.revision,
        actionId: nextAction(),
        decisions: [
          { taskId: "a", outcome: "deferred" },
          { taskId: "b", outcome: "prepared", attemptId: nextAttempt() },
        ],
      }),
    ),
    "preflight_batch_mismatch",
  );
  // ⓑ legacy ready→running 진입점 둘은 상태와 무관하게 닫혀 있다(대장 `B-11`).
  assert.equal(codeOf(() => k.startTask("b")), "preflight_required");
  assert.equal(codeOf(() => k.startScheduledBatch()), "preflight_required");
  startVia(k, "a");
  // ⓒ 이미 running인 task는 다시 시작되지 않는다.
  assert.equal(
    codeOf(() => k.startPreparedTask({ taskId: "a", actionId: nextAction(), leaseMarker: nextLease() })),
    "preflight_required",
  );
  assert.equal(
    codeOf(() => k.startPreparedTask({ taskId: "nope", actionId: nextAction(), leaseMarker: nextLease() })),
    "unknown_task",
  );
  assert.equal(
    codeOf(() =>
      k.submitResult({
        envelope: envelope("result", "b", "pm", { messageId: "res-b" }),
        body: body("result"),
        summary: "요약",
      }),
    ),
    "invalid_transition",
  );
});

test("[M4a] 메시지 타입·방향·run/milestone/parent 대조", () => {
  // envelope↔state 대조는 결과 수락 경로에서 본다 → 확인된 정리 뒤 상태에서 시험한다(대장 `B-13`).
  const { k } = bootCleanedRoot();
  const bad = (over: EnvOverrides, type: AgentMessageType = "result"): string =>
    codeOf(() =>
      k.submitResult({ envelope: envelope(type, "root", "tech-lead", over), body: body(type), summary: "요약" }),
    );

  assert.equal(bad({}, "blocker"), "message_type_mismatch");
  assert.equal(bad({ sender: ORCHESTRATOR_ID }), "invalid_direction");
  assert.equal(bad({ recipient: "someone-else" }), "invalid_direction");
  assert.equal(bad({ runId: "other-run" }), "run_id_mismatch");
  assert.equal(bad({ milestoneId: "other" }), "milestone_mismatch");
  assert.equal(bad({ parentTaskId: "root" }), "parent_mismatch");
  assert.equal(bad({ taskId: "ghost" }), "unknown_task");
  assert.equal(bad({ dependsOn: ["ghost"] }), "unknown_dependency");
  assert.equal(bad({ supersedes: "ghost" }), "unknown_message");
});

// ── artifact 계약 ───────────────────────────────────────────────────────────

test("[M4a] artifact 등록: revision/supersedes · 포인터 필드 · missing/symlink/디렉터리 거부", () => {
  const { ws, k } = bootRoot();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");

  const p1 = k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" });
  assert.equal(p1.revision, 1);
  assert.equal(p1.producerTaskId, "root");
  assert.equal(p1.sha256, createHash("sha256").update("v1\n").digest("hex"));
  assert.equal(k.getArtifact("docs/a.md@1")!.supersedes, null);

  writeFileSync(join(ws, "docs", "a.md"), "v2\n");
  const p2 = k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" });
  assert.equal(p2.revision, 2);
  assert.equal(k.getArtifact("docs/a.md@2")!.supersedes, "docs/a.md@1");
  assert.equal(k.getArtifact("docs/a.md@1")!.sha256, createHash("sha256").update("v1\n").digest("hex"));

  assert.equal(codeOf(() => k.registerArtifact({ taskId: "root", path: "docs/none.md", role: "output" })), "artifact_missing");
  symlinkSync(join(ws, "docs", "a.md"), join(ws, "docs", "link.md"));
  assert.equal(codeOf(() => k.registerArtifact({ taskId: "root", path: "docs/link.md", role: "output" })), "artifact_symlink");
  assert.equal(codeOf(() => k.registerArtifact({ taskId: "root", path: "docs", role: "output" })), "artifact_not_regular_file");
  assert.equal(codeOf(() => k.registerArtifact({ taskId: "root", path: "../outside.md", role: "output" })), "path_parent_segment");
});

// ── M5b: artifact 등록은 소유권을 집행한다(독립 리뷰 A2) ──────────────────────
//
// 이전 판은 "running task + 파일이 workspace 안에 있다"만 봤다 → task A가 **task B의 소유 경로**나
// 승인 밖 경로를 자기 산출물로 등록할 수 있었다. controller가 아니라 **권위 계층**에서 막는다.

test("[M5b] artifact 등록: 남의 소유 경로·승인 밖 경로는 거부다(교차 task 오염 차단)", () => {
  const { ws, k } = bootRoot(["other"]);
  k.createRootTask(seed("other", "qa-security")); // ownership = ["src/other"]
  startVia(k, "other");
  mkdirSync(join(ws, "src", "other"), { recursive: true });
  mkdirSync(join(ws, "src", "root"), { recursive: true });
  writeFileSync(join(ws, "src", "other", "x.md"), "남의 것\n");
  writeFileSync(join(ws, "src", "root", "mine.md"), "내 것\n");

  // ⓐ root는 other의 경로를 등록할 수 없다(그 반대도 마찬가지).
  assert.equal(codeOf(() => k.registerArtifact({ taskId: "root", path: "src/other/x.md", role: "output" })), "artifact_not_owned");
  assert.equal(codeOf(() => k.registerArtifact({ taskId: "other", path: "src/root/mine.md", role: "output" })), "artifact_not_owned");
  // ⓑ 자기 소유 경로는 그대로 통과한다(게이트가 공허하지 않다는 증거).
  assert.equal(k.registerArtifact({ taskId: "root", path: "src/root/mine.md", role: "output" }).revision, 1);
  assert.equal(k.registerArtifact({ taskId: "other", path: "src/other/x.md", role: "output" }).revision, 1);
  // ⓒ 거부는 state를 바꾸지 않는다(등록 2건 그대로).
  assert.equal(k.getState().artifacts.length, 2);
});

test("[M5b] artifact 등록: 승인된 writableRoots 밖은 거부다", () => {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    // 소유권은 `infra`까지 주지만 승인된 writable root는 `src`뿐인 state는 만들 수 없으므로,
    // ownership ⊆ writableRoots 불변식을 지키면서 **manifest가 더 좁은** 경우를 만든다.
    manifest: manifestFor(["root"], { writableRoots: ["src"], ownershipByTask: { root: ["src"] } }),
    clock: fixedClock(),
  });
  k.createRootTask(seed("root", "tech-lead", { ownership: ["src"] }));
  startVia(k, "root");
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  // `docs/a.md`는 소유 경로(`src`) 밖이므로 소유권 게이트가 먼저 잡는다.
  assert.equal(codeOf(() => k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" })), "artifact_not_owned");
  assert.equal(k.getState().artifacts.length, 0);
});

// ── M5b A3: 산출물 등록 + result 수락 + 완료는 **한 커밋**이다 ────────────────

/** `docs/`·`src/root/` 아래에 파일을 쓰고 workspace-relative 경로를 돌려준다. */
function put(ws: string, rel: string, content: string): string {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), content);
  return rel;
}

/** 완료 트랜잭션 입력(포인터는 kernel이 채우므로 envelope.artifactRefs는 비어 있다). */
function completeInput(outputs: Array<{ path: string; role: string }>, over: Record<string, unknown> = {}) {
  return {
    envelope: envelope("result", "root", "tech-lead", { messageId: "r-atomic", ...over }),
    body: body("result"),
    summary: "원자적 완료",
    outputs: outputs as Array<{ path: string; role: "output" }>,
    ...(over.bodyOverride ? { body: over.bodyOverride as string } : {}),
  };
}

test("[M5b] A3: 성공 multi-output — 등록 순서·포인터·단일 완료가 정확하다", () => {
  const { ws, k } = bootCleanedRoot();
  const paths = [put(ws, "docs/a.md", "a\n"), put(ws, "src/root/b.md", "b\n"), put(ws, "docs/c.md", "c\n")];
  const before = k.getState().revision;
  const done = k.completeTaskWithArtifacts(completeInput(paths.map((p) => ({ path: p, role: "output" }))));

  assert.deepEqual(done.artifacts.map((a) => `${a.path}@${a.revision}`), paths.map((p) => `${p}@1`), "등록 순서가 다르다");
  assert.deepEqual(done.task.artifactRefs.map((r) => r.path), paths);
  assert.equal(done.task.state, "completed");
  assert.equal(k.getTask("root")!.state, "completed");
  assert.equal(k.getState().revision, before + 1, "한 커밋이어야 한다(산출물마다 커밋하지 않는다)");
  assert.equal(k.getState().artifacts.length, 3);
  // 완료는 정확히 1건이다 — 같은 task를 다시 완료할 수 없다.
  assert.equal(
    codeOf(() => k.completeTaskWithArtifacts(completeInput([], { messageId: "r-again" }))),
    "invalid_transition",
  );
});

test("[M5b] A3: 어느 단계가 실패해도 artifacts·events·messages·revision·task 상태가 진입 전과 같다", () => {
  const cases: Array<[string, string, (ws: string) => ReturnType<typeof completeInput>]> = [
    [
      "두 번째 산출물이 없다",
      "artifact_missing",
      (ws) =>
        completeInput([
          { path: put(ws, "docs/a.md", "a\n"), role: "output" },
          { path: "docs/gone.md", role: "output" },
        ]),
    ],
    [
      "두 번째 산출물이 소유 밖이다",
      "artifact_not_owned",
      (ws) =>
        completeInput([
          { path: put(ws, "docs/a.md", "a\n"), role: "output" },
          { path: put(ws, "src/other/x.md", "x\n"), role: "output" },
        ]),
    ],
    [
      "경로 중복",
      "artifact_path_duplicate",
      (ws) => {
        const p = put(ws, "docs/a.md", "a\n");
        return completeInput([
          { path: p, role: "output" },
          { path: p, role: "evidence" },
        ]);
      },
    ],
    [
      "role이 계약 밖이다",
      "invalid_artifact_ref",
      (ws) =>
        completeInput([
          { path: put(ws, "docs/a.md", "a\n"), role: "output" },
          { path: put(ws, "docs/b.md", "b\n"), role: "made-up" },
        ]),
    ],
    [
      `산출물 ${LIMITS.maxArtifactRefs + 1}건(상한 초과)`,
      "artifact_refs_too_many",
      (ws) =>
        completeInput(
          Array.from({ length: LIMITS.maxArtifactRefs + 1 }, (_, i) => ({
            path: put(ws, `docs/n${i}.md`, `${i}\n`),
            role: "output",
          })),
        ),
    ],
    [
      "envelope가 포인터를 미리 주장한다",
      "artifact_ref_unexpected",
      (ws) =>
        completeInput([{ path: put(ws, "docs/a.md", "a\n"), role: "output" }], {
          artifactRefs: [{ path: "docs/a.md", sha256: "0".repeat(64), revision: 1, producerTaskId: "root", role: "output" }],
        }),
    ],
    [
      "envelope 타입이 result가 아니다",
      "message_type_mismatch",
      (ws) => ({ ...completeInput([{ path: put(ws, "docs/a.md", "a\n"), role: "output" }]), envelope: envelope("blocker", "root", "tech-lead") }),
    ],
    [
      "body가 §5.2 heading을 못 채운다",
      "body_unknown_heading",
      (ws) => ({ ...completeInput([{ path: put(ws, "docs/a.md", "a\n"), role: "output" }]), body: "## 아무 제목\n\n본문\n" }),
    ],
    [
      "summary가 상한을 넘는다",
      "text_too_long",
      (ws) => ({ ...completeInput([{ path: put(ws, "docs/a.md", "a\n"), role: "output" }]), summary: "x".repeat(LIMITS.maxSummaryLength + 1) }),
    ],
  ];

  for (const [label, want, build] of cases) {
    const { ws, k } = bootCleanedRoot();
    const input = build(ws);
    const runDir = dirname(runPaths(ws, RUN_ID).stateFile);
    const before = { fp: dirFingerprint(runDir), rev: k.getState().revision, state: k.getTask("root")!.state };
    assert.equal(codeOf(() => k.completeTaskWithArtifacts(input)), want, label);
    assert.equal(dirFingerprint(runDir), before.fp, `${label}: durable 파일이 바뀌었다(부분 적용)`);
    assert.equal(k.getState().revision, before.rev, `${label}: revision이 올랐다`);
    assert.equal(k.getTask("root")!.state, before.state, `${label}: task 상태가 바뀌었다`);
    assert.deepEqual(k.getState().artifacts, [], `${label}: 앞선 artifact가 durable에 남았다`);
    assert.equal(k.getMessage("r-atomic"), null, `${label}: result 메시지가 남았다`);
  }
});

test("[M5b] A3: 실패 후 재시도는 revision 찌꺼기를 만들지 않는다", () => {
  const { ws, k } = bootCleanedRoot();
  const good = put(ws, "docs/a.md", "a\n");
  const attempt = () =>
    k.completeTaskWithArtifacts(
      completeInput([
        { path: good, role: "output" },
        { path: "docs/gone.md", role: "output" },
      ]),
    );
  // 세 번 실패해도 `docs/a.md`는 한 번도 등록되지 않는다(이전 판은 매 시도마다 revision을 올렸다).
  for (let i = 0; i < 3; i++) assert.equal(codeOf(attempt), "artifact_missing");
  assert.deepEqual(k.getState().artifacts, []);

  // 원인을 고치고 다시 하면 **revision 1**로 등록된다.
  put(ws, "docs/gone.md", "이제 있다\n");
  const done = k.completeTaskWithArtifacts(
    completeInput([
      { path: good, role: "output" },
      { path: "docs/gone.md", role: "output" },
    ]),
  );
  assert.deepEqual(done.artifacts.map((a) => a.revision), [1, 1], "실패한 시도가 revision을 태웠다");
});

// ── M5b 4차 리뷰 A3: 발행은 복구 가능한 트랜잭션이다 ──────────────────────────

/**
 * 각 발행 경계에 fault를 넣었을 때 **복구 뒤에 관찰돼야 하는 상태**.
 * `before` = 가시적 전이 0(roll back) · `after` = 이미 목표 state 바이트가 쓰인 뒤라 복구가 마무리만 한다.
 *
 * **6차 리뷰 A3 이후 전이는 `state:rename` 성공에서만 durable해진다**: 그 앞의 모든 실패는 roll back이고
 * (복구가 후속 state를 발행하는 권한이 없다) `after`는 body 발행·journal 정리 두 자리뿐이다.
 */
const STAGE_OUTCOME: Record<CommitStage, "before" | "after"> = {
  "body:write": "before",
  "body:rename": "before",
  "journal:write": "before",
  "journal:rename": "before",
  "events:append": "before",
  "snapshot:write": "before",
  "snapshot:rename": "before",
  "state:write": "before",
  "state:rename": "before",
  "body:publish": "after",
  "journal:cleanup": "after",
};

/** 이 stage에서 정확히 한 번 던지는 hook을 걸고 fn을 돌린다(끝나면 반드시 해제한다). */
function withCommitFault(stage: CommitStage, fn: () => void): boolean {
  let fired = 0;
  setCommitFaultHook((s) => {
    if (s === stage && fired++ === 0) throw new Error(`주입 실패: ${s}`);
  });
  try {
    fn();
    return false;
  } catch {
    return true;
  } finally {
    setCommitFaultHook(null);
  }
}

test("[M5b] A3: 발행 경계마다 fault를 넣어도 관찰 결과는 전/후 상태 하나이고 전진이 가능하다", () => {
  for (const stage of COMMIT_STAGES) {
    const { ws, k } = bootCleanedRoot(["second"]);
    const p = put(ws, "docs/a.md", "a\n");
    const paths = runPaths(ws, RUN_ID);
    const before = {
      state: readFileSync(paths.stateFile, "utf8"),
      events: readFileSync(paths.eventsFile, "utf8"),
      messages: readdirSync(paths.messagesDir).sort(),
    };

    const threw = withCommitFault(stage, () => {
      k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]));
    });
    assert.equal(threw, true, `${stage}: fault를 넣었는데 커밋이 성공했다(회귀가 공허하다)`);

    if (STAGE_OUTCOME[stage] === "before") {
      // **가시적 전이 0**: 실패 직후 state 바이트가 그대로다(event append는 물리적 중간 산물이며
      // 아래 복구가 기준 길이로 되돌린다 — 6차 리뷰 A3 이후 그 규칙이 `state:rename` 앞 전부에 적용된다).
      assert.equal(readFileSync(paths.stateFile, "utf8"), before.state, `${stage}: state가 바뀌었다`);
    }
    // **journal 발행 전 실패는 이 invocation의 staging까지 스스로 지운다**(5차 리뷰 A3 — 이전 판은
    // journal 전에 **최종** 이름을 만들었고 테스트는 그 orphan을 "무해"로 적었다). 발행 뒤라면
    // 정리 주체는 결정론적 복구이므로 그때는 journal이 남아 있다.
    if (!existsSync(paths.journalFile)) {
      assert.deepEqual(readdirSync(paths.messagesDir).sort(), before.messages, `${stage}: messages/에 잔재가 남았다`);
    }

    // reopen이 결정론적으로 복구한다(loadRun이 schema·event chain·binding·body·artifact hash를 다 본다).
    const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
    assert.equal(existsSync(paths.journalFile), false, `${stage}: 복구 뒤에도 journal이 남았다`);
    if (STAGE_OUTCOME[stage] === "before") {
      // roll back은 state·event 바이트를 **둘 다** 기준으로 되돌린다(완전한 append도 포함).
      assert.equal(readFileSync(paths.stateFile, "utf8"), before.state, `${stage}: 복구가 state를 바꿨다`);
      assert.equal(readFileSync(paths.eventsFile, "utf8"), before.events, `${stage}: 복구가 event tail을 남겼다`);
    }
    // 복구 뒤 `messages/` 열거는 **색인과 정확히 일치**한다: staged 잔재도, 색인되지 않은 최종 body도 없다.
    assert.deepEqual(
      readdirSync(paths.messagesDir).sort(),
      reopened.getState().messages.map((m) => m.bodyPath.replace("messages/", "")).sort(),
      `${stage}: 복구 뒤 messages/ 열거가 색인과 다르다`,
    );
    // roll back이면 완료 커밋 진입 전 상태, 즉 **정리가 확인된 `cleaning`** 이 그대로 보인다(M5c `B-13`).
    const taskState = reopened.getTask("root")!.state;
    assert.equal(taskState, STAGE_OUTCOME[stage] === "before" ? "cleaning" : "completed", `${stage}: 관찰 상태가 규칙과 다르다`);

    // event·revision 중복 없음: 줄 수가 lastEventId와 같고 artifact revision은 1건뿐이다.
    const s = reopened.getState();
    assert.equal(readFileSync(paths.eventsFile, "utf8").split("\n").filter((l) => l.length > 0).length, s.lastEventId, `${stage}: event 중복`);
    assert.deepEqual(s.artifacts.map((a) => `${a.path}@${a.revision}`), taskState === "completed" ? [`${p}@1`] : [], `${stage}: artifact 중복`);

    // 전진 가능: 되돌려졌으면 같은 커밋을 그대로 재시도해 완료되고, 이미 완료됐으면 다음 커밋이 된다.
    if (taskState === "cleaning") {
      const done = reopened.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]));
      assert.equal(done.task.state, "completed", `${stage}: 재시도가 실패했다`);
      assert.deepEqual(done.artifacts.map((a) => a.revision), [1], `${stage}: 실패한 시도가 revision을 태웠다`);
    } else {
      reopened.createRootTask(seed("second", "tech-lead", { ownership: ["docs"] }));
      assert.equal(reopened.getTask("second")!.state, "ready", `${stage}: 마무리 복구 뒤 다음 커밋이 막혔다`);
    }
    // 어느 경로든 다시 열린다(반쪽 상태가 남지 않았다).
    assert.equal(openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }).getState().revision, reopened.getState().revision);
  }
});

/**
 * 지정한 발행 경계에서 실패한 **미완 커밋**을 만든다. `base`는 실패 **이전** 바이트이므로
 * "가시적 전이 0"과 "남의 바이트 보존"을 그것과 대조할 수 있다.
 * `events:append`에서 실패하면 journal + staged body + **빈 tail**, `state:write`면 journal +
 * 완전한 append + **기준 state**(= roll back 대상), `body:publish`면 journal + 완전한 append +
 * **목표 state 바이트** + staged body(= 마무리 대상)다.
 */
function pendingAt(
  stage: CommitStage,
  extra: string[] = [],
): {
  ws: string;
  k: OrchestrationKernel;
  p: string;
  paths: ReturnType<typeof runPaths>;
  base: { state: string; events: string; snapshot: string; messages: string[] };
  journal: string;
} {
  const { ws, k } = bootCleanedRoot(extra);
  const p = put(ws, "docs/a.md", "a\n");
  const paths = runPaths(ws, RUN_ID);
  const base = {
    state: readFileSync(paths.stateFile, "utf8"),
    events: readFileSync(paths.eventsFile, "utf8"),
    snapshot: readFileSync(paths.snapshotFile, "utf8"),
    messages: readdirSync(paths.messagesDir).sort(),
  };
  assert.equal(
    withCommitFault(stage, () => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
    true,
    `${stage}: fault를 넣었는데 커밋이 성공했다(회귀가 공허하다)`,
  );
  assert.equal(existsSync(paths.journalFile), true, `${stage}: journal이 남지 않아 복구 규칙을 시험할 수 없다`);
  return { ws, k, p, paths, base, journal: readFileSync(paths.journalFile, "utf8") };
}

/** journal의 append 바이트를 직접 이어 붙인다(찢어진 write 재현 — 접두만 남는다). */
function appendJournalPrefix(paths: ReturnType<typeof runPaths>, journal: string, bytes: number): void {
  const events = Buffer.from((JSON.parse(journal) as { events: string }).events, "utf8");
  assert.ok(events.length > bytes, "append가 너무 짧아 부분 접두를 만들 수 없다");
  appendFileSync(paths.eventsFile, events.subarray(0, bytes));
}

test("[M5b] A3: 찢어진(부분 접두) event append는 기준 길이로 되돌리고 같은 커밋을 재시도할 수 있다", () => {
  // 실제 찢어진 write는 **완전한 append의 접두**를 남긴다(뒤에 여분 바이트가 붙지 않는다).
  const { ws, p, paths, base, journal } = pendingAt("events:append");
  appendJournalPrefix(paths, journal, 12);

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false, "복구 뒤에도 journal이 남았다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), base.state, "찢어진 append가 state를 바꿨다");
  assert.equal(readFileSync(paths.eventsFile, "utf8"), base.events, "event tail이 기준 길이로 되돌려지지 않았다");
  assert.deepEqual(readdirSync(paths.messagesDir).sort(), base.messages, "roll back이 staged/최종 body를 남겼다");
  assert.equal(reopened.getTask("root")!.state, "cleaning");
  assert.equal(reopened.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }])).task.state, "completed");
});

test("[M5b] A3: 빈 tail(append 0바이트)도 roll back이고 재시도가 성공한다", () => {
  const { ws, p, paths, base } = pendingAt("events:append"); // 접두 중 가장 짧은 경우
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false);
  assert.equal(readFileSync(paths.stateFile, "utf8"), base.state);
  assert.equal(readFileSync(paths.eventsFile, "utf8"), base.events);
  assert.deepEqual(readdirSync(paths.messagesDir).sort(), base.messages, "roll back이 staged body를 남겼다");
  assert.equal(reopened.getTask("root")!.state, "cleaning");
  assert.equal(reopened.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }])).task.state, "completed");
});

test("[M5b] A3(6차): 기준 state + **완전한** append도 roll back이다 — 복구는 후속을 발행하지 않는다", () => {
  // 이전 판은 이 자리에서 journal이 적은 target state를 **발행**했다(roll forward) → 해시를 전부 다시
  // 계산한 위조 후속이 유효 state를 덮어쓸 수 있었다. 지금은 되돌리고, 호출자가 받은 실패가 진실이다.
  const { ws, p, paths, base } = pendingAt("state:write");
  const fullEvents = readFileSync(paths.eventsFile, "utf8");
  assert.notEqual(fullEvents, base.events, "완전한 append가 남지 않아 이 규칙을 시험할 수 없다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), base.state, "state가 이미 바뀌어 회귀가 공허하다");

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false, "복구 뒤에도 journal이 남았다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), base.state, "복구가 target state를 발행했다");
  assert.equal(readFileSync(paths.eventsFile, "utf8"), base.events, "완전한 append를 기준 길이로 되돌리지 않았다");
  assert.deepEqual(readdirSync(paths.messagesDir).sort(), base.messages, "roll back이 staged/최종 body를 남겼다");
  assert.equal(reopened.getTask("root")!.state, "cleaning");
  // 재시도는 그대로 성공한다(같은 커밋을 다시 올린다 — revision 찌꺼기 0).
  const done = reopened.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]));
  assert.equal(done.task.state, "completed");
  assert.deepEqual(done.artifacts.map((a) => a.revision), [1]);
});

test("[M5b] A3(6차): 목표 state 바이트가 이미 쓰였으면 복구는 body 발행·정리만 마무리한다", () => {
  const { ws, paths, base } = pendingAt("body:publish", ["second"]);
  const fullEvents = readFileSync(paths.eventsFile, "utf8");
  const target = readFileSync(paths.stateFile, "utf8");
  assert.notEqual(target, base.state, "state가 아직 기준이라 마무리 규칙을 시험할 수 없다");
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false);
  assert.equal(readFileSync(paths.eventsFile, "utf8"), fullEvents, "마무리가 커밋된 event를 잘랐다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), target, "마무리가 state를 바꿨다");
  assert.equal(reopened.getTask("root")!.state, "completed");
  // 최종 body는 마무리가 발행한다(state가 참조하는 body가 실제로 있다 — load가 hash까지 본다).
  assert.deepEqual(readdirSync(paths.messagesDir).sort(), [...base.messages, "r-atomic.md"].sort(), "body 발행 결과가 색인과 다르다");
});

/**
 * **남의(foreign) event 바이트는 파괴하지 않는다**(5차 리뷰 A3). 아래 세 tail은 전부 "정확한 접두도
 * 완전한 append도 아닌" 경우이며, 복구는 fail closed이고 journal·state·events·snapshot·body가
 * **바이트 그대로** 남아야 한다.
 */
test("[M5b] A3: 접두도 완전 append도 아닌 tail은 fail closed이고 바이트를 하나도 바꾸지 않는다", () => {
  const cases: Array<[string, (paths: ReturnType<typeof runPaths>, baseBytes: number, full: Buffer) => void]> = [
    [
      "완전한 append 뒤에 여분 바이트가 붙었다",
      (paths) => appendFileSync(paths.eventsFile, '{"eventId":99,"partial', { encoding: "utf8" }),
    ],
    [
      "같은 길이의 남의 바이트다",
      (paths, baseBytes, full) => {
        const foreign = Buffer.alloc(full.length - baseBytes, 0x78); // 'x' — 길이는 같고 내용이 다르다
        writeFileSync(paths.eventsFile, Buffer.concat([full.subarray(0, baseBytes), foreign]));
      },
    ],
    [
      "짧지만 접두가 아닌 바이트다",
      (paths, baseBytes, full) => {
        const foreign = Buffer.alloc(8, 0x79); // 'y'
        writeFileSync(paths.eventsFile, Buffer.concat([full.subarray(0, baseBytes), foreign]));
      },
    ],
  ];
  for (const [label, tamper] of cases) {
    // 디스크 state가 **기준**인 지점에서 시험한다(6차 리뷰 A3 이후 `state:write`가 그 자리다).
    const { ws, paths, base, journal } = pendingAt("state:write");
    const baseBytes = Buffer.byteLength(base.events, "utf8");
    tamper(paths, baseBytes, readFileSync(paths.eventsFile));
    // 복구 **직전** 바이트가 기준이다(이 지점에서 snapshot은 이미 앞서 있을 수 있다 — 파생물이다).
    const after = {
      events: readFileSync(paths.eventsFile),
      snapshot: readFileSync(paths.snapshotFile, "utf8"),
      messages: readdirSync(paths.messagesDir).sort(),
    };

    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_foreign", label);
    assert.deepEqual(readFileSync(paths.eventsFile), after.events, `${label}: 남의 event 바이트를 지웠다`);
    assert.equal(readFileSync(paths.stateFile, "utf8"), base.state, `${label}: state가 바뀌었다`);
    assert.equal(readFileSync(paths.snapshotFile, "utf8"), after.snapshot, `${label}: snapshot이 바뀌었다`);
    assert.equal(readFileSync(paths.journalFile, "utf8"), journal, `${label}: journal이 사라졌다`);
    assert.deepEqual(readdirSync(paths.messagesDir).sort(), after.messages, `${label}: body가 바뀌었다`);
    assert.equal(existsSync(join(paths.messagesDir, "r-atomic.md")), false, `${label}: 최종 body가 생겼다`);
  }
});

/** journal 원문을 손대는 회귀 표. `j`는 파싱된 유효 journal이고 반환값이 새 파일 내용이다. */
type JournalTamper = (j: Record<string, unknown>, valid: string) => string;

/**
 * **정합적으로 위조한 journal**: 가짜 state digest를 journal과 **마지막 event 줄에 함께** 심고,
 * 그 때문에 달라진 event hash를 embedded state·journal `lastEventHash`·`stateSha256`까지 전부 맞춘다.
 * 남는 불일치는 **"발행할 state의 실제 내용 digest"** 하나뿐이므로, 그 묶기(binding)만 없으면 이 journal이
 * 통과한다(mutation 실측으로 확인한 자리 — 다른 검사들은 이 경로에서 중복 방어다).
 */
function coherentDigestSwap(j: Record<string, unknown>): string {
  const fake = "0".repeat(64);
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const lines = (j.events as string).split("\n").filter((l) => l.length > 0);
  const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  lines[lines.length - 1] = JSON.stringify({ ...last, stateDigest: fake });
  const lastEventHash = sha(lines[lines.length - 1]);
  const state = JSON.parse(j.state as string) as Record<string, unknown>;
  state.lastEventHash = lastEventHash; // chain 필드는 `stateContentDigest`에 들어가지 않는다
  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  return JSON.stringify({
    ...j,
    events: `${lines.join("\n")}\n`,
    lastEventHash,
    stateDigest: fake,
    state: stateText,
    stateSha256: sha(stateText),
  });
}

/** 유효 journal의 event 줄 하나를 바꿔 다시 조립한다(줄 수·개행은 유지). */
function withEventLine(j: Record<string, unknown>, edit: (ev: Record<string, unknown>) => Record<string, unknown>): string {
  const lines = (j.events as string).split("\n").filter((l) => l.length > 0);
  const next = lines.map((l, i) => (i === 0 ? JSON.stringify(edit(JSON.parse(l) as Record<string, unknown>)) : l));
  return JSON.stringify({ ...j, events: `${next.join("\n")}\n` });
}

test("[M5b] A3: 손댄 journal은 조용히 넘기지 않고 fail closed다", () => {
  const cases: Array<[string, JournalTamper, string]> = [
    ["JSON이 아니다", () => "{ not json", "journal_unparsable"],
    ["다른 run의 journal이다", (j) => JSON.stringify({ ...j, runId: "다른-run" }), "journal_foreign"],
    ["필드 타입이 계약과 다르다", (j) => JSON.stringify({ ...j, baseEventBytes: "0" }), "journal_invalid"],
    ["미상 필드가 있다", (j) => JSON.stringify({ ...j, extra: 1 }), "journal_invalid"],
    [
      "필수 필드가 없다",
      (j) => {
        const { stateDigest: _drop, ...rest } = j;
        return JSON.stringify(rest);
      },
      "journal_invalid",
    ],
    ["schema 표기가 다르다", (j) => JSON.stringify({ ...j, schema: "m5b-commit-journal-2" }), "journal_invalid"],
    ["txnId가 정규 형태가 아니다", (j) => JSON.stringify({ ...j, txnId: "not-hex" }), "journal_invalid"],
    ["baseEventBytes가 음수다", (j) => JSON.stringify({ ...j, baseEventBytes: -1 }), "journal_invalid"],
    ["baseEventBytes가 정수가 아니다", (j) => JSON.stringify({ ...j, baseEventBytes: 1.5 }), "journal_invalid"],
    ["baseEventBytes가 범위 밖이다", (j) => JSON.stringify({ ...j, baseEventBytes: 2 ** 40 }), "journal_invalid"],
    ["eventCount가 실제 줄 수와 다르다", (j) => JSON.stringify({ ...j, eventCount: (j.eventCount as number) + 1 }), "journal_invalid"],
    [
      "revision 간격이 벌어졌다(후속이 아니다)",
      (j) => {
        const b = j.base as Record<string, unknown>;
        return JSON.stringify({ ...j, base: { ...b, revision: (b.revision as number) + 7 } });
      },
      "journal_invalid",
    ],
    [
      "기준 state 원본 digest가 디스크와 다르다",
      (j) => {
        const b = j.base as Record<string, unknown>;
        return JSON.stringify({ ...j, base: { ...b, stateSha256: "0".repeat(64) } });
      },
      "journal_unrecognized",
    ],
    [
      "기준 event chain 신원이 디스크와 다르다",
      (j) => {
        const b = j.base as Record<string, unknown>;
        return JSON.stringify({ ...j, base: { ...b, lastEventId: (b.lastEventId as number) + 1 } });
      },
      "journal_invalid",
    ],
    [
      // digest까지 맞춰 준 뒤에도 **경로 runId 묶기**가 잡아야 한다(형태만으로는 통과하는 위조다).
      "embedded state가 다른 run의 것이다",
      (j) => {
        const state = (j.state as string).replaceAll(`"${RUN_ID}"`, '"other-run"');
        return JSON.stringify({ ...j, state, stateSha256: createHash("sha256").update(state).digest("hex") });
      },
      "journal_foreign",
    ],
    ["embedded state의 milestone이 journal과 다르다", (j) => JSON.stringify({ ...j, milestoneId: "other-milestone" }), "journal_foreign"],
    ["승인 manifest 신원이 state와 다르다", (j) => JSON.stringify({ ...j, manifestDigest: "{}" }), "journal_foreign"],
    ["state 바이트 digest가 다르다", (j) => JSON.stringify({ ...j, stateSha256: "0".repeat(64) }), "journal_invalid"],
    ["state 내용 digest가 다르다", (j) => JSON.stringify({ ...j, stateDigest: "0".repeat(64) }), "journal_invalid"],
    // 나머지 검사를 **전부 맞춰 온** 위조: 남은 불일치는 "발행할 state의 실제 내용 digest"뿐이다.
    ["정합적으로 위조한 state digest", coherentDigestSwap, "journal_invalid"],
    ["목표 revision이 state와 다르다", (j) => JSON.stringify({ ...j, targetRevision: (j.targetRevision as number) + 1 }), "journal_invalid"],
    ["최종 event 신원이 state와 다르다", (j) => JSON.stringify({ ...j, lastEventHash: "0".repeat(64) }), "journal_invalid"],
    ["event eventId가 기준과 이어지지 않는다", (j) => withEventLine(j, (ev) => ({ ...ev, eventId: 99 })), "journal_invalid"],
    ["event prevHash가 체인과 다르다", (j) => withEventLine(j, (ev) => ({ ...ev, prevHash: "0".repeat(64) })), "journal_invalid"],
    ["event revision이 목표와 다르다", (j) => withEventLine(j, (ev) => ({ ...ev, revision: 99 })), "journal_invalid"],
    ["event가 계약 밖 필드를 가졌다", (j) => withEventLine(j, (ev) => ({ ...ev, sneak: 1 })), "journal_invalid"],
    [
      "마지막 event의 stateDigest가 없다",
      (j) => {
        const lines = (j.events as string).split("\n").filter((l) => l.length > 0);
        const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
        lines[lines.length - 1] = JSON.stringify({ ...last, stateDigest: null });
        return JSON.stringify({ ...j, events: `${lines.join("\n")}\n` });
      },
      "journal_invalid",
    ],
    [
      "body digest가 state와 다르다",
      (j) => {
        const bodies = (j.bodies as Array<Record<string, unknown>>).map((b) => ({ ...b, sha256: "0".repeat(64) }));
        return JSON.stringify({ ...j, bodies });
      },
      "journal_invalid",
    ],
    [
      "body 목록이 state에 없는 메시지를 담았다",
      (j) => JSON.stringify({ ...j, bodies: [...(j.bodies as unknown[]), { messageId: "없는-메시지", sha256: "0".repeat(64), bytes: 1, dev: 1, ino: 1 }] }),
      "journal_invalid",
    ],
    // ── 6차 리뷰 A3: 기준 신원·body 소유권 필드 ──────────────────────────
    [
      "기준 신원 필드가 없다",
      (j) => {
        const { milestoneId: _drop, ...rest } = j.base as Record<string, unknown>;
        return JSON.stringify({ ...j, base: rest });
      },
      "journal_invalid",
    ],
    [
      "기준 milestone이 journal과 다르다",
      (j) => JSON.stringify({ ...j, base: { ...(j.base as Record<string, unknown>), milestoneId: "other-milestone" } }),
      "journal_foreign",
    ],
    [
      "기준 승인 manifest가 목표와 다르다",
      (j) => JSON.stringify({ ...j, base: { ...(j.base as Record<string, unknown>), manifestDigest: "{}" } }),
      "journal_foreign",
    ],
    [
      "기준 생성 시각이 목표와 다르다",
      (j) => JSON.stringify({ ...j, base: { ...(j.base as Record<string, unknown>), createdAt: "2020-01-01T00:00:00.000Z" } }),
      "journal_foreign",
    ],
    [
      "기준 내용 digest가 디스크와 다르다",
      (j) => JSON.stringify({ ...j, base: { ...(j.base as Record<string, unknown>), contentDigest: "0".repeat(64) } }),
      "journal_unrecognized",
    ],
    [
      "기준 메시지 수가 디스크와 다르다",
      (j) => {
        const b = j.base as Record<string, unknown>;
        return JSON.stringify({ ...j, base: { ...b, messageCount: (b.messageCount as number) + 1 } });
      },
      "journal_invalid",
    ],
    [
      // `baseEventBytes`를 줄여 **남의 감사 바이트를 자기 append로 주장**하는 경우(자르기 유도).
      "기준 event 접두가 기준 신원과 맞지 않는다",
      (j) => JSON.stringify({ ...j, baseEventBytes: 0 }),
      "journal_unrecognized",
    ],
    [
      "body 바이트 수가 계약 밖이다",
      (j) => JSON.stringify({ ...j, bodies: (j.bodies as Array<Record<string, unknown>>).map((b) => ({ ...b, bytes: 0 })) }),
      "journal_invalid",
    ],
    [
      "body staging 신원이 없다",
      (j) =>
        JSON.stringify({
          ...j,
          bodies: (j.bodies as Array<Record<string, unknown>>).map((b) => {
            const { ino: _drop, ...rest } = b;
            return rest;
          }),
        }),
      "journal_invalid",
    ],
  ];
  for (const [label, tamper, want] of cases) {
    const { ws, k } = bootCleanedRoot();
    const p = put(ws, "docs/a.md", "a\n");
    const paths = runPaths(ws, RUN_ID);
    assert.equal(
      withCommitFault("events:append", () => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
      true,
    );
    const valid = readFileSync(paths.journalFile, "utf8");
    const before = {
      state: readFileSync(paths.stateFile, "utf8"),
      events: readFileSync(paths.eventsFile, "utf8"),
      snapshot: readFileSync(paths.snapshotFile, "utf8"),
      messages: readdirSync(paths.messagesDir).sort(),
    };
    const tampered = tamper(JSON.parse(valid) as Record<string, unknown>, valid);
    assert.notEqual(tampered, valid, `${label}: 변조가 실제로 아무것도 바꾸지 않았다(회귀가 공허하다)`);
    writeFileSync(paths.journalFile, tampered);

    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), want, label);
    // 커밋 경로도 같은 규칙이다(복구를 우회해 그 위에 쓰지 않는다).
    assert.equal(
      codeOf(() => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
      want,
      `${label}(커밋 경로)`,
    );
    // **무효 journal은 아무것도 바꾸지 않는다**: journal·state·events·snapshot·body가 바이트 그대로다.
    assert.equal(readFileSync(paths.journalFile, "utf8"), tampered, `${label}: 무효 journal이 사라졌다`);
    assert.equal(readFileSync(paths.stateFile, "utf8"), before.state, `${label}: state가 바뀌었다`);
    assert.equal(readFileSync(paths.eventsFile, "utf8"), before.events, `${label}: events가 바뀌었다`);
    assert.equal(readFileSync(paths.snapshotFile, "utf8"), before.snapshot, `${label}: snapshot이 바뀌었다`);
    assert.deepEqual(readdirSync(paths.messagesDir).sort(), before.messages, `${label}: body가 바뀌었다`);
  }
});

test("[M5b] A3: staged body가 없거나 변조·교체되면 최종 body를 만들지 않는다(fail closed)", () => {
  // journal + 완전한 append + **목표 state**가 남은 상태에서 staged body를 없애거나 내용을 바꾸거나
  // **같은 내용의 다른 inode로 교체**한다 → 발행은 소유 신원까지 보므로 어느 경우도 최종 body를 만들지 않는다.
  for (const how of ["missing", "tampered", "reinode"] as const) {
    const { ws, paths, journal } = pendingAt("body:publish");
    const target = readFileSync(paths.stateFile, "utf8");
    const staged = readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-"));
    assert.equal(staged.length, 1, "staged body가 없다(회귀가 공허하다)");
    const stagedFile = join(paths.messagesDir, staged[0]);
    if (how === "missing") rmSync(stagedFile);
    else if (how === "tampered") writeFileSync(stagedFile, "# 변조된 body\n");
    else {
      // 내용은 그대로지만 **inode가 다른** 파일로 갈아끼운다(digest만 보는 발행은 이것을 통과한다).
      const bytes = readFileSync(stagedFile);
      rmSync(stagedFile);
      writeFileSync(stagedFile, bytes);
    }

    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_missing", how);
    assert.equal(readFileSync(paths.stateFile, "utf8"), target, `${how}: state가 바뀌었다`);
    assert.equal(readFileSync(paths.journalFile, "utf8"), journal, `${how}: journal이 사라졌다`);
    assert.equal(existsSync(join(paths.messagesDir, "r-atomic.md")), false, `${how}: 최종 body를 만들었다`);
  }
});

test("[M5b] A3: 최종 body는 journal이 durable해진 뒤에만 생긴다(같은/다른 id 재시도 · 열거)", () => {
  const { ws, k } = bootCleanedRoot(["second"]);
  const p = put(ws, "docs/a.md", "a\n");
  const paths = runPaths(ws, RUN_ID);
  const listing = (): string[] => readdirSync(paths.messagesDir).sort();
  const baseline = listing();

  // ⓐ journal 발행 **전** 실패(다중 body 경계 전수): 최종 body도 staged 잔재도 남지 않는다.
  for (const stage of ["body:write", "body:rename", "journal:write", "journal:rename"] as const) {
    assert.equal(
      withCommitFault(stage, () => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
      true,
      `${stage}: fault를 넣었는데 커밋이 성공했다`,
    );
    assert.deepEqual(listing(), baseline, `${stage}: messages/에 잔재가 남았다`);
    assert.equal(existsSync(paths.journalFile), false, `${stage}: journal이 남았다`);
  }

  // ⓑ **다른 messageId로** 재시도해도 앞선 실패의 body가 남아 있지 않다(이전 판은 영구 orphan이었다).
  assert.equal(
    withCommitFault("journal:write", () =>
      k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }], { messageId: "r-other" })),
    ),
    true,
  );
  assert.deepEqual(listing(), baseline, "다른 id 재시도가 orphan body를 남겼다");

  // ⓒ 같은 id로 정상 커밋하면 최종 body 하나만 생기고 색인이 그것을 참조한다.
  const done = k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]));
  assert.equal(done.task.state, "completed");
  assert.deepEqual(listing(), [...baseline, "r-atomic.md"].sort(), "최종 body 목록이 색인과 다르다");
  assert.equal(listing().filter((f) => f.startsWith(".staged-")).length, 0, "staged 파일이 남았다");

  // ⓓ reopen이 성공한다(색인된 body hash가 전부 맞다).
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(reopened.getTask("root")!.state, "completed");
  assert.equal(reopened.getMessage("r-atomic")!.bodyPath, "messages/r-atomic.md");
});

/**
 * **body 2건을 한 트랜잭션으로** 발행하는 커밋. kernel의 좁은 API는 커밋당 메시지 1건이므로 다중 body
 * 경로는 store 계층(`commitRun`)에 직접 대고 고정한다 — 검증·참조 무결성은 store가 그대로 적용한다.
 */
function twoBodyCommit(
  ws: string,
  k: OrchestrationKernel,
): { input: Parameters<typeof commitRun>[1]; ids: string[]; paths: ReturnType<typeof runPaths> } {
  const s = k.getState();
  const draft = structuredClone(s) as typeof s;
  draft.revision += 1;
  const ids = ["m-one", "m-two"];
  const bodies = ids.map((id) => ({ messageId: id, body: body("task_assignment", `\n<!-- ${id} -->\n`) }));
  for (const b of bodies) {
    draft.messages.push({
      messageId: b.messageId,
      type: "task_assignment",
      taskId: "root",
      parentTaskId: null,
      sender: ORCHESTRATOR_ID,
      recipient: "tech-lead",
      createdAt: "2026-07-27T00:01:00.000Z",
      dependsOn: [],
      artifactRefs: [],
      supersedes: null,
      bodyPath: `messages/${b.messageId}.md`,
      bodySha256: createHash("sha256").update(b.body).digest("hex"),
      summary: null,
      routeToTaskId: null,
      acknowledgedAt: null,
      // M5c(v2) — 전달 재시도 메타데이터도 durable 계약이다(전달 대상이 없으면 초기값).
      delivery: emptyMessageDelivery(),
    });
  }
  draft.messages.sort((a, b) => (a.messageId < b.messageId ? -1 : 1));
  const events = ids.map((id) => ({
    at: "2026-07-27T00:01:00.000Z",
    type: "message_accepted" as const,
    revision: draft.revision,
    taskId: "root",
    messageId: id,
    fromState: null,
    toState: null,
    reason: null,
    artifactId: null,
    // M5c(v2) — 닫힌 감사 필드(자유 payload 없음). 이 이벤트는 전부 null이다.
    actionId: null,
    attemptId: null,
    turnId: null,
    operationId: null,
    marker: null,
    tokenDelta: null,
    elapsedMs: null,
  }));
  return {
    input: {
      state: draft,
      events,
      bodies,
      base: { revision: s.revision, lastEventId: s.lastEventId, lastEventHash: s.lastEventHash },
    },
    ids,
    paths: runPaths(ws, RUN_ID),
  };
}

test("[M5b] A3: 다중 body도 journal 전에는 staging뿐이고, 발행 뒤 복구가 전부 발행한다", () => {
  // ⓐ journal 발행 **전** 경계 전수: 최종 body 0 · staging 잔재 0 · journal 0.
  for (const stage of ["body:write", "body:rename", "journal:write", "journal:rename"] as const) {
    const { ws, k } = bootRoot();
    const { input, paths } = twoBodyCommit(ws, k);
    const baseline = readdirSync(paths.messagesDir).sort();
    assert.equal(withCommitFault(stage, () => void commitRun(paths, input)), true, `${stage}: 커밋이 성공했다`);
    assert.deepEqual(readdirSync(paths.messagesDir).sort(), baseline, `${stage}: messages/에 잔재가 남았다`);
    assert.equal(existsSync(paths.journalFile), false, `${stage}: journal이 남았다`);
  }

  // ⓑ 발행 뒤(`body:publish` 도중) 실패: 복구가 **두 body 모두** 최종 이름으로 발행한다.
  const { ws, k } = bootRoot();
  const { input, ids, paths } = twoBodyCommit(ws, k);
  const baseline = readdirSync(paths.messagesDir).sort();
  assert.equal(withCommitFault("body:publish", () => void commitRun(paths, input)), true);
  assert.equal(readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length, 2, "staged body 2건이 아니다");
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false, "복구 뒤에도 journal이 남았다");
  assert.deepEqual(
    readdirSync(paths.messagesDir).sort(),
    [...baseline, ...ids.map((i) => `${i}.md`)].sort(),
    "복구가 두 body를 모두 발행하지 않았다",
  );
  for (const id of ids) assert.ok(reopened.getMessage(id), `${id}가 색인에 없다`);

  // ⓒ 정상 커밋도 같은 결과다(최종 body 2건 · staging 0).
  const clean = bootRoot();
  const two = twoBodyCommit(clean.ws, clean.k);
  const cleanBaseline = readdirSync(two.paths.messagesDir).sort();
  commitRun(two.paths, two.input);
  assert.deepEqual(readdirSync(two.paths.messagesDir).sort(), [...cleanBaseline, ...two.ids.map((i) => `${i}.md`)].sort());
  assert.equal(existsSync(two.paths.journalFile), false);
});

test("[M5b] A3: roll back은 기존 body를 절대 지우지 않는다(자기 트랜잭션 파일만)", () => {
  // root를 먼저 완료해 `r-atomic.md`를 durable 색인 안에 남긴다.
  const { ws, k } = bootCleanedRoot(["second"]);
  const p = put(ws, "docs/a.md", "a\n");
  assert.equal(k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }])).task.state, "completed");
  const paths = runPaths(ws, RUN_ID);
  const committedBody = readFileSync(join(paths.messagesDir, "r-atomic.md"), "utf8");

  // 다음 커밋(다른 task의 assignment body)이 journal 뒤에 실패하고 event tail이 찢어지게 만든다.
  const baseEvents = readFileSync(paths.eventsFile, "utf8");
  assert.equal(
    withCommitFault("snapshot:write", () => k.createRootTask(seed("second", "tech-lead", { ownership: ["docs"] }))),
    true,
  );
  truncateSync(paths.eventsFile, Buffer.byteLength(baseEvents, "utf8") + 6); // 부분 접두 → roll back

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false);
  assert.equal(readFileSync(join(paths.messagesDir, "r-atomic.md"), "utf8"), committedBody, "roll back이 기존 body를 건드렸다");
  assert.equal(reopened.getTask("second"), null, "roll back인데 task가 남았다");
  assert.equal(readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length, 0, "staged 파일이 남았다");
});

// ── M5b 6차 리뷰 A3: journal은 정확한 전이·body 소유권에 묶인다 ────────────────

/**
 * **유효 journal을 부품에서 다시 조립한다** — event 줄 목록과 state 변형을 받아 해시 체인 · 최종
 * event 신원 · state 바이트 · 모든 digest를 **전부 다시 계산**한다. 즉 "내부적으로 완전히 일관된"
 * journal을 만드는 도구이며, 그래서 이 도구로 만든 위조가 거부되면 그 거부는 **자기 일관성 검사가
 * 아니라 전이 권위 묶기**가 낸 것이다(6차 리뷰 A3의 정확한 실패 경로).
 */
function rebuildJournal(
  j: Record<string, unknown>,
  opts: { editLines?: (lines: string[]) => string[]; editState?: (s: any) => void; bodies?: unknown } = {},
): string {
  const state = JSON.parse(j.state as string) as any;
  if (opts.editState) opts.editState(state);
  // durable 회계는 그 승인에 묶여 있다(`accounting.approvalDigest`). 위조자도 이 값을 맞출 수 있으므로
  // 이 도구는 **내부적으로 완전히 일관된** journal을 만들기 위해 함께 다시 계산한다 — 그래야 아래의
  // 거부가 자기 일관성 검사가 아니라 **전이 권위 묶기**에서 나온 것임이 증명된다(6차 리뷰 A3).
  state.accounting.approvalDigest = manifestDigest(validateApprovalManifest(state.manifest));
  const contentDigest = stateContentDigest(validateRunState({ ...state, lastEventId: 0, lastEventHash: "0".repeat(64) }));
  let lines = (j.events as string).split("\n").filter((l) => l.length > 0);
  if (opts.editLines) lines = opts.editLines(lines);
  const base = j.base as Record<string, unknown> | null;
  let prevHash = base === null ? "0".repeat(64) : (base.lastEventHash as string);
  const rebuilt: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]) as Record<string, unknown>;
    ev.prevHash = prevHash;
    ev.revision = state.revision;
    ev.stateDigest = i === lines.length - 1 ? contentDigest : null;
    const line = JSON.stringify(ev);
    rebuilt.push(line);
    prevHash = createHash("sha256").update(line).digest("hex");
  }
  state.lastEventId = (base === null ? 0 : (base.lastEventId as number)) + rebuilt.length;
  state.lastEventHash = prevHash;
  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  return JSON.stringify({
    ...j,
    milestoneId: state.milestoneId,
    targetRevision: state.revision,
    eventCount: rebuilt.length,
    events: `${rebuilt.join("\n")}\n`,
    state: stateText,
    stateSha256: createHash("sha256").update(stateText).digest("hex"),
    stateDigest: contentDigest,
    lastEventId: state.lastEventId,
    lastEventHash: prevHash,
    manifestDigest: JSON.stringify(state.manifest),
    ...(opts.bodies === undefined ? {} : { bodies: opts.bodies }),
  });
}

/** journal을 그 append 바이트와 함께 디스크에 심는다(=위조가 실제로 디스크에 도달한 상태). */
function plantJournal(paths: ReturnType<typeof runPaths>, journalText: string, baseEvents: string): void {
  writeFileSync(paths.journalFile, journalText);
  writeFileSync(paths.eventsFile, baseEvents + (JSON.parse(journalText) as { events: string }).events);
}

test("[M5b] A3(6차): 해시를 전부 다시 계산한 위조 후속도 milestone·승인·task state를 바꾸지 못한다", () => {
  // 위조자는 journal을 쓸 수 있고 events.jsonl에 자기 append도 남길 수 있다(같은 uid). 이전 판은
  // 이 상태를 **roll forward**해서 위조 state를 발행했다. 지금은 어떤 경우에도 발행하지 않는다.
  const cases: Array<[string, (s: any) => void, string]> = [
    [
      // 위조는 **그 자체로는 유효한 v2 state**여야 한다(그래야 거부가 "전이 권위 묶기"에서 나온다):
      // `completed`는 미확정 결과를 들고 있을 수 없으므로 봉인된 pendingResult도 함께 비운다.
      "task state를 바꾼다(불변 권위는 그대로)",
      (st) => {
        st.tasks[0].state = "completed";
        st.tasks[0].execution.pendingResult = null;
      },
      "rolled_back",
    ],
    [
      // state와 manifest를 **함께** 바꿔 내부 정합성까지 맞춘 위조(그렇지 않으면 자기 일관성 검사에서 걸린다).
      "milestone을 바꾼다",
      (st) => {
        st.milestoneId = "other-milestone";
        st.manifest.milestoneId = "other-milestone";
      },
      "rejected",
    ],
    [
      "승인 manifest를 넓힌다",
      (st) => {
        st.manifest.writableRoots = ["docs", "infra", "src"];
        st.manifest.ownershipByTask.root = ["docs", "infra", "src"];
      },
      "rejected",
    ],
    ["생성 신원(createdAt)을 바꾼다", (st) => (st.createdAt = "2020-01-01T00:00:00.000Z"), "rejected"],
  ];
  for (const [label, editState, want] of cases) {
    const { ws, k } = bootCleanedRoot();
    const p = put(ws, "docs/a.md", "a\n");
    const paths = runPaths(ws, RUN_ID);
    // 유효 journal 하나를 얻는다(발행 전 실패 → journal + staged body).
    assert.equal(
      withCommitFault("events:append", () => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
      true,
    );
    const valid = JSON.parse(readFileSync(paths.journalFile, "utf8")) as Record<string, unknown>;
    const baseState = readFileSync(paths.stateFile, "utf8");
    const baseEvents = readFileSync(paths.eventsFile, "utf8");
    const forged = rebuildJournal(valid, { editState });
    plantJournal(paths, forged, baseEvents);

    if (want === "rejected") {
      assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_foreign", label);
      assert.equal(readFileSync(paths.journalFile, "utf8"), forged, `${label}: 무효 journal이 사라졌다`);
      assert.equal(readFileSync(paths.eventsFile, "utf8"), baseEvents + (JSON.parse(forged) as { events: string }).events, `${label}: 남의 바이트를 지웠다`);
    } else {
      // 완전히 일관된 위조라도 **되돌린다**(복구는 후속을 만들 권한이 없다).
      const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
      assert.equal(existsSync(paths.journalFile), false, `${label}: journal이 남았다`);
      assert.equal(readFileSync(paths.eventsFile, "utf8"), baseEvents, `${label}: 위조 append가 남았다`);
      assert.equal(reopened.getTask("root")!.state, "cleaning", `${label}: 위조 state가 승격됐다`);
    }
    assert.equal(readFileSync(paths.stateFile, "utf8"), baseState, `${label}: state 바이트가 바뀌었다`);
  }
});

test("[M5b] A3(6차): key 순서를 바꾼 event 줄은 정규형이 아니다", () => {
  const { ws, k } = bootCleanedRoot();
  const p = put(ws, "docs/a.md", "a\n");
  const paths = runPaths(ws, RUN_ID);
  assert.equal(
    withCommitFault("events:append", () => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
    true,
  );
  const valid = JSON.parse(readFileSync(paths.journalFile, "utf8")) as Record<string, unknown>;
  const baseState = readFileSync(paths.stateFile, "utf8");
  const baseEvents = readFileSync(paths.eventsFile, "utf8");
  // 첫 줄의 key 순서만 뒤집는다(값은 그대로) — 체인·digest는 rebuild가 전부 맞춰 준다.
  const reordered = rebuildJournal(valid, {
    editLines: (lines) =>
      lines.map((l, i) => {
        if (i !== 0) return l;
        const ev = JSON.parse(l) as Record<string, unknown>;
        return JSON.stringify(Object.fromEntries(Object.entries(ev).reverse()));
      }),
  });
  assert.notEqual(reordered, JSON.stringify(valid), "변조가 아무것도 바꾸지 않았다(회귀가 공허하다)");
  plantJournal(paths, reordered, baseEvents);

  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_invalid");
  assert.equal(readFileSync(paths.stateFile, "utf8"), baseState, "state가 바뀌었다");
  assert.equal(readFileSync(paths.journalFile, "utf8"), reordered, "무효 journal이 사라졌다");
});

test("[M5b] A3(6차): journal body 목록은 base→target 새 메시지 delta와 정확히 같아야 한다", () => {
  const cases: Array<[string, (bodies: any[], j: Record<string, unknown>) => unknown]> = [
    ["delta를 누락했다", () => []],
    ["없는 delta를 추가했다", (bodies) => [...bodies, { ...bodies[0], messageId: "extra-body" }]],
    [
      "기준에 이미 있는 메시지를 delta라고 주장한다",
      (bodies, j) => {
        const st = JSON.parse(j.state as string) as any;
        const old = st.messages.find((m: any) => m.messageId === "asg-root");
        return [{ ...bodies[0], messageId: old.messageId, sha256: old.bodySha256 }];
      },
    ],
  ];
  for (const [label, editBodies] of cases) {
    const { ws, k } = bootCleanedRoot();
    const p = put(ws, "docs/a.md", "a\n");
    const paths = runPaths(ws, RUN_ID);
    assert.equal(
      withCommitFault("events:append", () => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))),
      true,
    );
    const valid = JSON.parse(readFileSync(paths.journalFile, "utf8")) as Record<string, unknown>;
    const baseState = readFileSync(paths.stateFile, "utf8");
    const baseEvents = readFileSync(paths.eventsFile, "utf8");
    const tampered = rebuildJournal(valid, { bodies: editBodies(valid.bodies as any[], valid) });
    plantJournal(paths, tampered, baseEvents);

    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_invalid", label);
    assert.equal(readFileSync(paths.stateFile, "utf8"), baseState, `${label}: state가 바뀌었다`);
    assert.equal(readFileSync(paths.journalFile, "utf8"), tampered, `${label}: 무효 journal이 사라졌다`);
  }
});

test("[M5b] A3(6차): 남의 최종 body는 digest가 같아도 채택·덮어쓰기하지 않는다", () => {
  for (const how of ["same-digest", "different-digest"] as const) {
    // state는 이미 durable하고 최종 body만 남은 지점에서, **다른 inode**의 최종 파일을 심는다.
    const { ws, paths, journal } = pendingAt("body:publish");
    const staged = readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-"));
    const foreignText = how === "same-digest" ? readFileSync(join(paths.messagesDir, staged[0]), "utf8") : "# 남의 body\n";
    const finalFile = join(paths.messagesDir, "r-atomic.md");
    writeFileSync(finalFile, foreignText);
    const target = readFileSync(paths.stateFile, "utf8");

    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_foreign", how);
    assert.equal(readFileSync(finalFile, "utf8"), foreignText, `${how}: 남의 최종 body를 덮거나 지웠다`);
    assert.equal(readFileSync(paths.stateFile, "utf8"), target, `${how}: state가 바뀌었다`);
    assert.equal(readFileSync(paths.journalFile, "utf8"), journal, `${how}: journal이 사라졌다`);
    assert.equal(readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length, 1, `${how}: staging을 지웠다`);
  }
});

test("[M5b] A3(6차): 계획과 발행 사이에 최종 파일이 생기면 덮지 않고 fail closed다", () => {
  const { ws, paths, journal } = pendingAt("body:publish");
  const finalFile = join(paths.messagesDir, "r-atomic.md");
  const target = readFileSync(paths.stateFile, "utf8");
  // 복구의 발행 경계에서 **던지지 않고** 남의 최종 파일을 만든다 → link(2)가 EEXIST를 받는다.
  let planted = false;
  setCommitFaultHook(() => {
    if (planted) return;
    planted = true;
    writeFileSync(finalFile, "# 경합으로 끼어든 남의 body\n");
  });
  try {
    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_foreign");
  } finally {
    setCommitFaultHook(null);
  }
  assert.equal(planted, true, "발행 경계 hook이 불리지 않았다(회귀가 공허하다)");
  assert.equal(readFileSync(finalFile, "utf8"), "# 경합으로 끼어든 남의 body\n", "남의 파일을 덮었다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), target, "state가 바뀌었다");
  assert.equal(readFileSync(paths.journalFile, "utf8"), journal, "journal이 사라졌다");
});

test("[M5b] A3(6차): roll back은 같은 digest의 남의 최종 body도 지우지 않는다", () => {
  // 디스크가 아직 기준인 지점(roll back 대상)에서 staged body와 **내용이 같은** 최종 파일을 심는다.
  const { ws, paths, base } = pendingAt("state:write");
  const staged = readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-"));
  assert.equal(staged.length, 1, "staged body가 없다(회귀가 공허하다)");
  const sameDigest = readFileSync(join(paths.messagesDir, staged[0]), "utf8");
  const finalFile = join(paths.messagesDir, "r-atomic.md");
  writeFileSync(finalFile, sameDigest);

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false, "복구 뒤에도 journal이 남았다");
  assert.equal(readFileSync(finalFile, "utf8"), sameDigest, "roll back이 같은 digest의 남의 body를 지웠다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), base.state, "roll back이 state를 바꿨다");
  assert.equal(readFileSync(paths.eventsFile, "utf8"), base.events, "roll back이 event를 되돌리지 않았다");
  assert.equal(readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length, 0, "자기 staging을 남겼다");
  assert.equal(reopened.getTask("root")!.state, "cleaning");
});

test("[M5b] A3(6차): 다중 body 부분 발행·복구 I/O 실패는 재시도로 멱등하게 완결된다", () => {
  const { ws, k } = bootCleanedRoot();
  const { input, ids, paths } = twoBodyCommit(ws, k);
  const baseline = readdirSync(paths.messagesDir).sort();
  // state까지 durable하게 만든 뒤 body 발행 도중 실패시킨다(첫 body만 발행된다).
  assert.equal(withCommitFault("body:publish", () => void commitRun(paths, input)), true);
  const target = readFileSync(paths.stateFile, "utf8");
  assert.equal(readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length, 2, "staged body 2건이 아니다");

  // 복구 중 **두 번째** body에서 I/O 실패 → 첫 body만 발행되고 journal이 남는다.
  let calls = 0;
  setCommitFaultHook(() => {
    if (++calls === 2) throw new Error("주입 실패: 복구 중 body 발행");
  });
  try {
    assert.throws(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
  } finally {
    setCommitFaultHook(null);
  }
  assert.equal(existsSync(paths.journalFile), true, "부분 발행 뒤 journal이 사라졌다");
  assert.equal(existsSync(join(paths.messagesDir, `${ids[0]}.md`)), true, "첫 body가 발행되지 않았다");
  assert.equal(existsSync(join(paths.messagesDir, `${ids[1]}.md`)), false, "실패한 두 번째 body가 발행됐다");
  assert.equal(readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length, 1, "남은 staging이 1건이 아니다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), target, "복구 실패가 state를 바꿨다");

  // 재시도는 남은 body를 발행하고 정리까지 끝낸다(멱등).
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false, "재시도 뒤에도 journal이 남았다");
  assert.deepEqual(readdirSync(paths.messagesDir).sort(), [...baseline, ...ids.map((i) => `${i}.md`)].sort());
  for (const id of ids) assert.ok(reopened.getMessage(id), `${id}가 색인에 없다`);
});

test("[M5b] A3(6차): 목표 state 바이트인데 append가 불완전하면 마무리하지 않는다", () => {
  const { ws, paths, journal } = pendingAt("body:publish");
  const target = readFileSync(paths.stateFile, "utf8");
  const events = readFileSync(paths.eventsFile);
  truncateSync(paths.eventsFile, events.length - 5); // 목표 state + 찢어진 append
  const after = readFileSync(paths.eventsFile);

  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_unrecognized");
  assert.deepEqual(readFileSync(paths.eventsFile), after, "event 바이트를 바꿨다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), target, "state가 바뀌었다");
  assert.equal(readFileSync(paths.journalFile, "utf8"), journal, "journal이 사라졌다");
  assert.equal(existsSync(join(paths.messagesDir, "r-atomic.md")), false, "최종 body를 만들었다");
});

// ── M5b 7차 리뷰 A2: 발행은 link 직전·직후·journal 삭제 직전에 다시 증명한다 ────

/**
 * 지정 stage에서 **던지지 않고** 정확히 한 번 부수효과를 내는 hook(발행 경합 재현 도구).
 * `fired()`는 **부수효과가 실제로 실행된 횟수**다(stage 방문 횟수가 아니다 — 다중 body는 여러 번 방문한다).
 */
function withSideEffectAt(stage: CommitStage, effect: () => void): { fired: () => number; reset: () => void } {
  let visits = 0;
  let ran = 0;
  setCommitFaultHook((s) => {
    if (s !== stage || visits++ > 0) return;
    ran += 1;
    effect();
  });
  return { fired: () => ran, reset: () => setCommitFaultHook(null) };
}

test("[M5b] A2(7차): 발행 hook이 staging을 갈아끼워도 link되지 않고 복구 기록이 남는다", () => {
  // 이전 판은 **전수 preflight → hook → 경로 이름 그대로 linkSync**였으므로, hook(또는 같은 UID의 동시
  // writer)이 preflight 이후 staging을 교체하면 그 교체본이 최종 body로 link되고 journal까지 지워졌다.
  for (const how of ["same-digest", "different-digest"] as const) {
    const { ws, paths, journal } = pendingAt("body:publish");
    const target = readFileSync(paths.stateFile, "utf8");
    const staged = readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-"));
    assert.equal(staged.length, 1, "staged body가 없다(회귀가 공허하다)");
    const stagedFile = join(paths.messagesDir, staged[0]);
    const finalFile = join(paths.messagesDir, "r-atomic.md");
    // 내용은 같지만 **inode가 다른** 파일 / 아예 다른 내용 — 어느 쪽도 발행 대상이 아니다.
    const swapped = how === "same-digest" ? readFileSync(stagedFile) : Buffer.from("# 갈아끼운 body\n");
    const hook = withSideEffectAt("body:publish", () => {
      rmSync(stagedFile);
      writeFileSync(stagedFile, swapped);
    });
    try {
      assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_missing", how);
    } finally {
      hook.reset();
    }
    assert.equal(hook.fired(), 1, `${how}: 발행 hook이 불리지 않았다(회귀가 공허하다)`);
    assert.equal(existsSync(finalFile), false, `${how}: 교체본을 최종 body로 발행했다`);
    assert.equal(readFileSync(paths.journalFile, "utf8"), journal, `${how}: 복구 기록(journal)이 사라졌다`);
    assert.equal(readFileSync(paths.stateFile, "utf8"), target, `${how}: state가 바뀌었다`);
    assert.deepEqual(readFileSync(stagedFile), swapped, `${how}: 남의 파일을 지우거나 덮었다`);
    // 재시도도 같은 판정이다(결정론적 · journal 보존 · 최종 body 0).
    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_missing", how);
    assert.equal(readFileSync(paths.journalFile, "utf8"), journal, `${how}: 재시도가 journal을 지웠다`);
  }
});

test("[M5b] A2(7차): link 직후 증명이 경합으로 끼어든 최종 파일을 잡고 복구 증거(staging)를 남긴다", () => {
  // `link(2)`는 **경로 이름**을 받으므로 "증명한 fd를 그대로 link"할 수는 없다 → 증명과 link 사이 창은
  // 0이 아니다. 대신 **link 직후** 재증명이 결과를 판정하므로, 경합으로 남의 최종 파일이 먼저 생기면
  // EEXIST를 삼키고 staging을 지우는 대신 **그 자리에서** fail closed다(body 바이트의 유일한 사본 보존).
  const { ws, paths, journal } = pendingAt("body:publish");
  const finalFile = join(paths.messagesDir, "r-atomic.md");
  const target = readFileSync(paths.stateFile, "utf8");
  const foreign = "# 발행 직전에 끼어든 남의 body\n";
  const hook = withSideEffectAt("body:publish", () => writeFileSync(finalFile, foreign));
  try {
    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_foreign");
  } finally {
    hook.reset();
  }
  assert.equal(hook.fired(), 1, "발행 hook이 불리지 않았다(회귀가 공허하다)");
  assert.equal(readFileSync(finalFile, "utf8"), foreign, "남의 최종 파일을 덮거나 지웠다");
  assert.equal(readFileSync(paths.journalFile, "utf8"), journal, "복구 기록(journal)이 사라졌다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), target, "state가 바뀌었다");
  assert.equal(
    readdirSync(paths.messagesDir).filter((f) => f.startsWith(".staged-")).length,
    1,
    "link 직후 증명 없이 EEXIST를 삼켜 복구 증거(staging)를 지웠다",
  );
});

test("[M5b] A2(7차): 다중 body 부분 발행 중 앞선 staging·최종 body를 손대면 fail closed다", () => {
  // ⓐ 첫 body 발행 hook에서 **두 번째** staging을 다른 inode로 교체한다 → 두 번째는 link되지 않는다.
  {
    const { ws, k } = bootRoot();
    const { input, ids, paths } = twoBodyCommit(ws, k);
    const swapTo = Buffer.from("# 두 번째 staging 교체\n");
    let swapped = "";
    const hook = withSideEffectAt("body:publish", () => {
      const f = readdirSync(paths.messagesDir).filter((x) => x.startsWith(".staged-") && x.includes(ids[1]));
      assert.equal(f.length, 1, "두 번째 staging을 찾지 못했다(회귀가 공허하다)");
      swapped = join(paths.messagesDir, f[0]);
      rmSync(swapped);
      writeFileSync(swapped, swapTo);
    });
    try {
      assert.equal(codeOf(() => commitRun(paths, input)), "journal_body_missing");
    } finally {
      hook.reset();
    }
    assert.equal(hook.fired(), 1, "발행 hook이 불리지 않았다(회귀가 공허하다)");
    assert.equal(existsSync(join(paths.messagesDir, `${ids[0]}.md`)), true, "첫 body가 발행되지 않았다");
    assert.equal(existsSync(join(paths.messagesDir, `${ids[1]}.md`)), false, "교체본을 최종 body로 발행했다");
    assert.equal(existsSync(paths.journalFile), true, "복구 기록(journal)이 사라졌다");
    assert.deepEqual(readFileSync(swapped), swapTo, "남의 staging을 지우거나 덮었다");
    // reopen도 완료로 만들지 않는다(같은 판정 · journal 보존).
    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_missing");
    assert.equal(existsSync(paths.journalFile), true, "reopen이 journal을 지웠다");
  }

  // ⓑ 두 번째 body 발행 hook에서 **이미 link된 첫 최종 body**를 같은 inode·같은 크기로 제자리 변경한다
  //    → 두 번째 link 자체는 성공하지만 journal 삭제 직전 전수 sweep이 잡는다.
  {
    const { ws, k } = bootRoot();
    const { input, ids, paths } = twoBodyCommit(ws, k);
    const firstFinal = join(paths.messagesDir, `${ids[0]}.md`);
    let mutated = Buffer.alloc(0);
    let calls = 0;
    setCommitFaultHook((s) => {
      if (s !== "body:publish" || ++calls !== 2) return;
      const bytes = readFileSync(firstFinal);
      bytes[0] = bytes[0] === 0x23 ? 0x2a : 0x23; // 크기는 그대로, 내용만 다르게
      writeFileSync(firstFinal, bytes);
      mutated = bytes;
    });
    try {
      assert.equal(codeOf(() => commitRun(paths, input)), "journal_body_foreign");
    } finally {
      setCommitFaultHook(null);
    }
    assert.equal(calls, 2, "두 번째 발행 경계가 불리지 않았다(회귀가 공허하다)");
    assert.deepEqual(readFileSync(firstFinal), mutated, "변경된 최종 body를 덮거나 지웠다");
    assert.equal(existsSync(join(paths.messagesDir, `${ids[1]}.md`)), true, "두 번째 body는 발행됐어야 한다");
    assert.equal(existsSync(paths.journalFile), true, "복구 기록(journal)이 사라졌다");
    assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_foreign");
    assert.equal(existsSync(paths.journalFile), true, "reopen이 journal을 지웠다");
  }
});

test("[M5b] A2(7차): journal 삭제 직전 전수 재검증 — 같은 inode·같은 크기 내용 변경도 막고 증거를 남긴다", () => {
  // 이전 판은 최종 body 소유를 dev/ino/**size**로만 봤고 journal 삭제 전 재검증이 아예 없었다 →
  // 발행된 body를 제자리에서 고친 뒤 `commit.journal`이 지워져 안전한 재시도 증거가 사라졌다.
  const { ws, k } = bootRoot();
  const { input, ids, paths } = twoBodyCommit(ws, k);
  const finals = ids.map((i) => join(paths.messagesDir, `${i}.md`));
  const before = readdirSync(paths.messagesDir).sort();
  let mutated = Buffer.alloc(0);
  const hook = withSideEffectAt("journal:cleanup", () => {
    const bytes = readFileSync(finals[0]);
    bytes[0] = bytes[0] === 0x23 ? 0x2a : 0x23;
    writeFileSync(finals[0], bytes);
    mutated = bytes;
  });
  try {
    assert.equal(codeOf(() => commitRun(paths, input)), "journal_body_foreign");
  } finally {
    hook.reset();
  }
  assert.equal(hook.fired(), 1, "journal:cleanup hook이 불리지 않았다(회귀가 공허하다)");
  assert.equal(existsSync(paths.journalFile), true, "복구 기록(journal)이 사라졌다");
  assert.deepEqual(readFileSync(finals[0]), mutated, "변경된 최종 body를 덮거나 지웠다");
  assert.deepEqual(
    readdirSync(paths.messagesDir).sort(),
    [...before, ...ids.map((i) => `${i}.md`)].sort(),
    "발행 결과 디렉터리 엔트리가 계약과 다르다(staging 잔재·삭제)",
  );
  // reopen은 완료된 run으로 보고하지 않는다 — 같은 판정으로 fail closed이고 journal이 남는다.
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "journal_body_foreign");
  assert.equal(existsSync(paths.journalFile), true, "reopen이 journal을 지웠다");
});

test("[M5b] A2(7차): 이미 발행된 최종 body는 재시도의 전수 재검증을 통과하고 정리까지 멱등하게 끝난다", () => {
  // 양성 대조군: `journal:cleanup`에서 **던지기만** 하면 두 body 모두 발행된 채 journal이 남고,
  // 다음 열기가 (발행 0건 + 전수 재검증 통과 →) journal만 지우고 완결한다.
  const { ws, k } = bootRoot();
  const { input, ids, paths } = twoBodyCommit(ws, k);
  const before = readdirSync(paths.messagesDir).sort();
  assert.equal(withCommitFault("journal:cleanup", () => void commitRun(paths, input)), true);
  assert.equal(existsSync(paths.journalFile), true, "정리 실패인데 journal이 사라졌다");
  const published = ids.map((i) => readFileSync(join(paths.messagesDir, `${i}.md`)));
  const target = readFileSync(paths.stateFile, "utf8");

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(existsSync(paths.journalFile), false, "재시도가 journal을 지우지 못했다");
  assert.equal(readFileSync(paths.stateFile, "utf8"), target, "재시도가 state를 바꿨다");
  assert.deepEqual(
    readdirSync(paths.messagesDir).sort(),
    [...before, ...ids.map((i) => `${i}.md`)].sort(),
    "재시도 뒤 messages/ 열거가 색인과 다르다",
  );
  for (let i = 0; i < ids.length; i++) {
    assert.deepEqual(readFileSync(join(paths.messagesDir, `${ids[i]}.md`)), published[i], `${ids[i]} 바이트가 바뀌었다`);
    assert.ok(reopened.getMessage(ids[i]), `${ids[i]}가 색인에 없다`);
  }
  // 한 번 더 열어도 같다(멱등).
  assert.equal(openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }).getState().revision, reopened.getState().revision);
});

// ── M5b 4차 리뷰 A4: 호출자 소유 산출물은 한 번만 읽어 입양한다 ────────────────

/** 읽을 때마다 다른 값을 주는 property를 가진 산출물(교대 getter). */
function alternatingOutput(first: unknown, then: unknown, key: "role" | "path", other: Record<string, unknown>): unknown {
  let reads = 0;
  return Object.defineProperty({ ...other }, key, {
    get: () => (++reads === 1 ? first : then),
    enumerable: true,
    configurable: true,
  });
}

test("[M5b] A4: 교대 getter는 **첫 읽기 값**으로만 굳는다(두 번째 읽기 값은 durable에 못 들어간다)", () => {
  // 이전 판은 검증한 뒤 `out.role`을 **다시 읽어** 기록했으므로, 첫 읽기 `"output"` · 두 번째 읽기
  // 계약 밖 role인 교대 getter가 record와 result 포인터를 함께 오염시켰다(커밋 성공 · reopen 실패).
  const { ws, k } = bootCleanedRoot();
  const good = put(ws, "docs/a.md", "a\n");
  put(ws, "src/other/steal.md", "남의 것\n");
  const outputs = [
    alternatingOutput("output", "탈취된-role", "role", { path: good }),
    alternatingOutput(put(ws, "docs/b.md", "b\n"), "src/other/steal.md", "path", { role: "evidence" }),
  ] as Array<{ path: string; role: "output" }>;

  const done = k.completeTaskWithArtifacts(completeInput(outputs));
  assert.deepEqual(
    done.artifacts.map((a) => [a.path, a.role]),
    [
      [good, "output"],
      ["docs/b.md", "evidence"],
    ],
    "두 번째 읽기 값이 등록됐다(재읽기 창이 남아 있다)",
  );
  assert.deepEqual(
    k.getState().artifacts.map((a) => [a.path, a.role]),
    [
      [good, "output"],
      ["docs/b.md", "evidence"],
    ],
  );
  assert.deepEqual(k.getTask("root")!.artifactRefs.map((r) => r.role), ["output", "evidence"]);
  // durable state가 실제로 다시 열린다 — "커밋은 되고 reopen만 실패하는" 오염이 없다.
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(reopened.getTask("root")!.state, "completed");
  assert.deepEqual(reopened.getState().artifacts.map((a) => a.role), ["output", "evidence"]);
});

test("[M5b] A4: throwing getter·proxy·미상 key·cyclic·깊은 payload는 durable 변화 0으로 거부된다", () => {
  // 세 번째 항목은 **기대 코드**다. 전부 안정·bounded 코드이며(값·경로를 싣지 않는다), 경로 타입 위반은
  // 신뢰된 정규화기(`normalizeWorkspacePath`)의 닫힌 코드로 나온다.
  const cases: Array<[string, (ws: string) => unknown, string]> = [
    [
      "role getter가 던진다",
      (ws) =>
        Object.defineProperty({ path: put(ws, "docs/a.md", "a\n") }, "role", {
          get: () => {
            throw new Error("탈취");
          },
          enumerable: true,
        }),
      "invalid_artifact_ref",
    ],
    [
      "proxy가 읽을 때 던진다",
      (ws) =>
        new Proxy(
          { path: put(ws, "docs/a.md", "a\n"), role: "output" },
          {
            get: () => {
              throw new Error("탈취");
            },
          },
        ),
      "invalid_artifact_ref",
    ],
    [
      "proxy ownKeys가 던진다",
      (ws) =>
        new Proxy(
          { path: put(ws, "docs/a.md", "a\n"), role: "output" },
          {
            ownKeys: () => {
              throw new Error("탈취");
            },
          },
        ),
      "invalid_artifact_ref",
    ],
    ["미상 key", (ws) => ({ path: put(ws, "docs/a.md", "a\n"), role: "output", extra: 1 }), "invalid_artifact_ref"],
    [
      "symbol key",
      (ws) => {
        const out: Record<string | symbol, unknown> = { path: put(ws, "docs/a.md", "a\n"), role: "output" };
        out[Symbol("숨은-필드")] = 1;
        return out;
      },
      "invalid_artifact_ref",
    ],
    [
      "cyclic payload를 role로 준다",
      (ws) => {
        const cyclic: Record<string, unknown> = { path: put(ws, "docs/a.md", "a\n") };
        cyclic.role = cyclic;
        return cyclic;
      },
      "invalid_artifact_ref",
    ],
    ["깊게 중첩된 객체를 path로 준다", () => ({ path: { a: { b: { c: { d: "docs/a.md" } } } }, role: "output" }), "path_empty"],
    ["path가 숫자다", () => ({ path: 1, role: "output" }), "path_empty"],
  ];

  // 두 등록 경로는 M5c에서 요구 상태가 다르다(완료 트랜잭션은 확인된 `cleaning`, 단건 등록은 `running`)
  // → 경로마다 그 상태의 run에서 같은 적대적 입력을 시험한다. 어느 쪽도 완화하지 않는다.
  for (const [label, build, want] of cases) {
    {
      const { ws, k } = bootCleanedRoot();
      const runDir = dirname(runPaths(ws, RUN_ID).stateFile);
      const before = { fp: dirFingerprint(runDir), rev: k.getState().revision };
      const outputs = [build(ws)] as Array<{ path: string; role: "output" }>;
      assert.equal(codeOf(() => k.completeTaskWithArtifacts(completeInput(outputs))), want, label);
      assert.equal(dirFingerprint(runDir), before.fp, `${label}: durable 파일이 바뀌었다`);
      assert.equal(k.getState().revision, before.rev, `${label}: revision이 올랐다`);
      assert.deepEqual(k.getState().artifacts, [], `${label}: artifact가 durable에 남았다`);
      assert.equal(k.getTask("root")!.state, "cleaning", `${label}: task 상태가 바뀌었다`);
    }
    // 단건 등록 경로도 같은 규칙이다(불변식이 함수 하나에 있다). 입력 객체 **그대로** 넘긴다 —
    // spread로 미리 평탄화하면 적대적 getter가 사라져 회귀가 공허해진다.
    {
      const { ws, k } = bootRoot();
      const runDir = dirname(runPaths(ws, RUN_ID).stateFile);
      const before = { fp: dirFingerprint(runDir), rev: k.getState().revision };
      const single = build(ws) as Record<string, unknown>;
      Object.defineProperty(single, "taskId", { value: "root", enumerable: true, configurable: true });
      assert.equal(
        codeOf(() => k.registerArtifact(single as unknown as { taskId: string; path: string; role: "output" })),
        want,
        `${label}(단건)`,
      );
      assert.equal(dirFingerprint(runDir), before.fp, `${label}(단건): durable 파일이 바뀌었다`);
      assert.equal(k.getState().revision, before.rev, `${label}(단건): revision이 올랐다`);
      assert.deepEqual(k.getState().artifacts, [], `${label}(단건): artifact가 durable에 남았다`);
      assert.equal(k.getTask("root")!.state, "running", `${label}(단건): task 상태가 바뀌었다`);
    }
  }
});

test("[M5b] A4: 이미 입양한 항목을 나중에 변조해도 등록값은 안 바뀐다", () => {
  const { ws, k } = bootCleanedRoot();
  const first: Record<string, unknown> = { path: put(ws, "docs/a.md", "a\n"), role: "output" };
  put(ws, "src/other/steal.md", "남의 것\n");
  // 두 번째 항목의 `role` getter가 **이미 입양된 첫 항목**을 오염시킨다(입양 이후 mutation).
  const second = Object.defineProperty({ path: put(ws, "docs/b.md", "b\n") }, "role", {
    get: () => {
      first.role = "made-up";
      first.path = "src/other/steal.md";
      return "evidence";
    },
    enumerable: true,
  });
  const done = k.completeTaskWithArtifacts(completeInput([first, second] as Array<{ path: string; role: "output" }>));
  assert.deepEqual(
    done.artifacts.map((a) => [a.path, a.role]),
    [
      ["docs/a.md", "output"],
      ["docs/b.md", "evidence"],
    ],
    "입양 뒤 원본 변조가 등록값에 반영됐다",
  );
  assert.equal(first.role, "made-up", "이 회귀가 공허하다 — 변조 자체가 일어나지 않았다");
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(reopened.getTask("root")!.state, "completed");
  assert.deepEqual(reopened.getTask("root")!.artifactRefs.map((r) => r.role), ["output", "evidence"]);
});

test("[M5b] A3: 커밋 단계 실패(stale_writer)도 전이 0이다", () => {
  const { ws, k } = bootCleanedRoot(["second"]);
  const p = put(ws, "docs/a.md", "a\n");
  // 같은 run을 두 번째 kernel로 열어 **먼저** 커밋한다 → 이쪽 base가 낡는다.
  const other = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  other.createRootTask(seed("second", "tech-lead", { ownership: ["docs"] }));
  const runDir = dirname(runPaths(ws, RUN_ID).stateFile);
  const fp = dirFingerprint(runDir);
  assert.equal(codeOf(() => k.completeTaskWithArtifacts(completeInput([{ path: p, role: "output" }]))), "stale_writer");
  assert.equal(dirFingerprint(runDir), fp, "거부된 커밋이 파일을 바꿨다");
  assert.equal(other.getTask("root")!.state, "cleaning", "남의 결과가 덮였다");
});

test("[M4a] 상위 디렉터리 symlink로 workspace를 벗어나는 artifact 거부", () => {
  const { ws, k } = bootRoot();
  const outside = mkdtempSync(join(tmpdir(), "m4a-outside-"));
  workspaces.push(outside);
  writeFileSync(join(outside, "secret.md"), "outside\n");
  symlinkSync(outside, join(ws, "linkdir"));
  assert.equal(
    codeOf(() => k.registerArtifact({ taskId: "root", path: "linkdir/secret.md", role: "output" })),
    "artifact_outside_workspace",
  );
});

test("[M4a] result 수락 직전 artifact 재검증: tamper/미등록/포인터 불일치 fail-closed", () => {
  const { ws, k } = bootRoot();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  const p = k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" });
  // 등록은 running turn에서, 결과 수락은 확인된 정리 뒤에 일어난다(대장 `B-13`).
  cleanVia(k, "root");

  // 미등록 포인터
  assert.equal(
    codeOf(() =>
      k.submitResult({
        envelope: envelope("result", "root", "tech-lead", { messageId: "r1", artifactRefs: [{ ...p, revision: 9 }] }),
        body: body("result"),
        summary: "요약",
      }),
    ),
    "unknown_artifact",
  );
  // 등록 내용과 다른 포인터
  assert.equal(
    codeOf(() =>
      k.submitResult({
        envelope: envelope("result", "root", "tech-lead", { messageId: "r2", artifactRefs: [{ ...p, role: "test" }] }),
        body: body("result"),
        summary: "요약",
      }),
    ),
    "artifact_ref_mismatch",
  );
  // 등록 이후 파일 변조
  writeFileSync(join(ws, "docs", "a.md"), "tampered\n");
  assert.equal(
    codeOf(() =>
      k.submitResult({
        envelope: envelope("result", "root", "tech-lead", { messageId: "r3", artifactRefs: [p] }),
        body: body("result"),
        summary: "요약",
      }),
    ),
    "artifact_hash_mismatch",
  );
  // 원상 복구 후에는 수락된다
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  const done = k.submitResult({
    envelope: envelope("result", "root", "tech-lead", { messageId: "r4", artifactRefs: [p] }),
    body: body("result"),
    summary: "요약",
  });
  assert.equal(done.state, "completed");
  assert.deepEqual(done.artifactRefs, [p]);
});

// ── 전이 0 ─────────────────────────────────────────────────────────────────

test("[M4a] 유효하지 않은 입력은 state revision과 영속 파일에 전이 0", () => {
  const { ws, k } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const beforeRevision = k.getState().revision;
  const beforeFiles = dirFingerprint(paths.dir);

  const attempts: Array<() => unknown> = [
    () => k.createRootTask(seed("root", "pm")),
    () => k.createRootTask(seed("bad-own", "pm", { ownership: ["../x"] })),
    () => k.createDependentTask({ ...seed("d", "pm"), dependsOn: ["ghost"] }),
    () => k.startTask("root"),
    () => k.registerArtifact({ taskId: "root", path: "docs/none.md", role: "output" }),
    () => k.submitResult({ envelope: envelope("result", "root", "tech-lead", { runId: "x" }), body: body("result"), summary: "s" }),
    () => k.submitResult({ envelope: envelope("result", "root", "tech-lead"), body: "## Nope\n", summary: "s" }),
    () => k.submitBlocker({ envelope: envelope("blocker", "root", "tech-lead"), body: body("blocker"), summary: "" }),
    () =>
      k.requestSpawn({
        envelope: envelope("spawn_request", "root", "tech-lead"),
        body: body("spawn_request"),
        child: seed("c", "pm", { ownership: ["/abs"] }),
      }),
  ];
  for (const a of attempts) assert.throws(a, OrchestrationError);

  assert.equal(k.getState().revision, beforeRevision);
  assert.equal(dirFingerprint(paths.dir), beforeFiles);
});

// ── 재시작 / 결정성 ─────────────────────────────────────────────────────────

test("[M4a] 재시작: 같은 run을 새 인스턴스로 열면 ready 목록·revision·snapshot이 동일하다", () => {
  const { ws, k } = bootRoot(["dependent"]);
  k.requestSpawn({
    envelope: envelope("spawn_request", "root", "tech-lead", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    // child가 `docs/a.md`를 등록하므로 parent가 가진 `docs` 범위를 위임받는다(권한 확대 아님).
    child: seed("child", "dev-lead", { ownership: ["docs"] }),
  });
  k.createDependentTask({ ...seed("dependent", "qa-security"), dependsOn: ["child"] });
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  startVia(k, "child");
  k.registerArtifact({ taskId: "child", path: "docs/a.md", role: "output" });
  const before = k.getState();
  const readyBefore = k.listReady().map((t) => t.taskId);
  const snapBefore = k.rebuildSnapshot();

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.deepEqual(reopened.getState(), before);
  // create 경로와 open 경로가 같은 직렬화 바이트를 내야 한다(key 순서 포함).
  assert.equal(JSON.stringify(reopened.getState()), JSON.stringify(before));
  assert.deepEqual(reopened.listReady().map((t) => t.taskId), readyBefore);
  assert.equal(reopened.rebuildSnapshot(), snapBefore);
  assert.equal(readFileSync(runPaths(ws, RUN_ID).snapshotFile, "utf8"), snapBefore);
});

test("[M4a] snapshot은 state에서만 만들어지고 raw artifact 본문·transcript를 담지 않는다", () => {
  const { ws, k } = bootRoot();
  const marker = "RAW-ARTIFACT-BODY-MUST-NOT-BE-COPIED-8fd1";
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), `# 산출물\n${marker}\n`);
  const p = k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" });
  cleanVia(k, "root");
  k.submitResult({
    envelope: envelope("result", "root", "tech-lead", { messageId: "r1", artifactRefs: [p] }),
    body: body("result"),
    summary: "요약만 중앙으로 옮긴다",
  });

  const paths = runPaths(ws, RUN_ID);
  const stateText = readFileSync(paths.stateFile, "utf8");
  const snapText = readFileSync(paths.snapshotFile, "utf8");
  assert.ok(!stateText.includes(marker), "run_state.json에 raw artifact 본문이 있다");
  assert.ok(!snapText.includes(marker), "snapshot.md에 raw artifact 본문이 있다");
  assert.ok(snapText.includes(`docs/a.md@1`), "snapshot에 artifact 포인터가 없다");
  assert.ok(snapText.includes("요약만 중앙으로 옮긴다"), "snapshot에 bounded summary가 없다");
  assert.ok(!/transcript/i.test(stateText), "state에 transcript 필드가 있다");

  // message index는 hash와 bounded summary만 들고 body 전문은 파일에만 있다.
  const entry = k.getMessage("r1")!;
  assert.equal(entry.bodyPath, "messages/r1.md");
  assert.equal(entry.summary, "요약만 중앙으로 옮긴다");
  assert.ok(!JSON.stringify(entry).includes("## Work Performed"));
  assert.ok(readFileSync(join(paths.dir, entry.bodyPath), "utf8").includes("## Work Performed"));
});

test("[M4a] 읽기 API는 깊은 사본을 준다 — 반환값 수정으로 state가 바뀌지 않는다", () => {
  const { k } = bootRoot();
  const t = k.getTask("root")!;
  t.state = "completed";
  t.ownership.push("hack");
  const s = k.getState();
  s.tasks[0].state = "blocked";
  assert.equal(k.getTask("root")!.state, "running");
  assert.deepEqual(k.getTask("root")!.ownership, ["docs", "src/root"]);
});

test("[M4a] kernel 공개 API는 좁은 목록뿐 — agent가 상태를 직접 바꿀 진입점이 없다", () => {
  const actual = Object.getOwnPropertyNames(OrchestrationKernel.prototype).sort();
  // M5c가 더한 것은 **durable lifecycle reducer와 단일 scheduler 진입점**뿐이다. 각각 좁은 전이 하나만
  // 하고, 남의 task 상태·의존성·완료를 직접 바꾸는 API는 여전히 없다(`startTask`/`startScheduledBatch`는
  // `preflight_required` stub으로만 남아 있다 — 대장 `B-11`).
  assert.deepEqual(actual, [
    "acknowledgeDelivery",
    "beginDeliveryAttempt",
    "chargeTurnUsage",
    "commitPreflightBatch",
    "completeTaskWithArtifacts",
    "confirmCleanup",
    "constructor",
    "createDependentTask",
    "createRootTask",
    "failCleanup",
    "failDeliveryAttempt",
    "getAccounting",
    "getArtifact",
    "getManifest",
    "getMessage",
    "getState",
    "getTask",
    "hasCommittedAction",
    // M5c 3A 리비전 A2: **봉인 dispatch permit 발급**(순수 판정 — state를 바꾸지 않는다).
    "issueOperationDispatchPermit",
    "listPendingInbox",
    "listReady",
    "nextPendingDelivery",
    // M5b 4차 리뷰 A2: `paths`는 own field가 아니라 **prototype getter**다(freeze된 값만 돌려준다).
    "paths",
    "pauseTask",
    "planRunnableBatch",
    "rebuildSnapshot",
    "recordDecision",
    "recordOperationReceipt",
    "recordProgress",
    "recordTerminal",
    "registerArtifact",
    "remainingBudget",
    "requestCancel",
    "requestReview",
    "requestRevision",
    "requestSpawn",
    "resumeTask",
    "scheduleReady",
    "settleCleanedAttempt",
    "startPreparedTask",
    "startScheduledBatch",
    "startTask",
    "submitBlocker",
    "submitDecisionRequest",
    "submitResult",
    "submitReviewResult",
    "submitStatusUpdate",
  ]);
});

// ── M5b 4차 리뷰 A2: 진짜 kernel 발급 증명 ────────────────────────────────────

test("[M5b] A2: kernel 인스턴스는 own property 0 · freeze · 토큰 없는 직접 생성 거부", () => {
  const { ws, k } = bootRoot();
  // ⓐ 상태·경로·시계가 public own property로 새어 있지 않다(대입·defineProperty 통로 0).
  assert.deepEqual(Object.getOwnPropertyNames(k), [], "kernel 권위가 own property로 노출됐다");
  assert.deepEqual(Object.getOwnPropertySymbols(k), []);
  assert.equal(Object.isFrozen(k), true, "kernel 인스턴스가 얼지 않았다");
  assert.equal(Object.isFrozen(OrchestrationKernel.prototype), true, "kernel prototype이 얼지 않았다");
  assert.equal(Object.isFrozen(k.paths), true, "paths가 freeze되지 않은 값으로 나갔다");

  // ⓑ 권위 후보에 대입·defineProperty가 전부 실패하고 상태도 바뀌지 않는다.
  for (const name of ["paths", "getState", "completeTaskWithArtifacts", "registerArtifact", "startScheduledBatch"]) {
    assert.throws(
      () => {
        (k as unknown as Record<string, unknown>)[name] = () => undefined;
      },
      TypeError,
      `${name} 대입이 통과했다`,
    );
    assert.throws(
      () => Object.defineProperty(k, name, { value: () => undefined, configurable: true }),
      TypeError,
      `${name} defineProperty가 통과했다`,
    );
  }
  assert.equal(attestOrchestrationKernel(k, ["getState"])!.workspaceRoot, ws, "정상 kernel이 증명을 못 받았다");

  // ⓒ 모듈 사설 토큰 없이 생성자를 직접 부르면 인스턴스가 만들어지지 않는다(TS private은 검사일 뿐이다).
  const Ctor = OrchestrationKernel as unknown as new (...a: unknown[]) => OrchestrationKernel;
  assert.equal(codeOf(() => new Ctor(Symbol("위조"), k.paths, k.getState(), () => new Date())), "kernel_issuer_required");
  assert.equal(codeOf(() => Reflect.construct(Ctor, [undefined, k.paths, k.getState(), () => new Date()])), "kernel_issuer_required");
});

test("[M5b] A2: 구조적으로 같은 위조 kernel은 증명을 받지 못한다(delegate·proxy·subclass·override)", () => {
  const { k } = bootRoot();
  const M = ["getState", "getManifest", "getTask", "completeTaskWithArtifacts"];
  const proto = Object.getPrototypeOf(k) as Record<string, unknown>;

  // ⓐ 평범한 구조적 객체(메서드 모양과 paths.workspaceRoot만 맞춘 것).
  assert.equal(
    attestOrchestrationKernel(
      {
        paths: k.paths,
        getState: () => k.getState(),
        getManifest: () => k.getManifest(),
        getTask: (id: string) => k.getTask(id),
        completeTaskWithArtifacts: () => ({ task: k.getTask("root"), artifacts: [] }),
      },
      M,
    ),
    null,
    "구조적 객체가 증명됐다",
  );

  // ⓑ 진짜 kernel prototype을 쓰지만 완료만 위조하는 delegate.
  //    (`paths`가 prototype getter라 `Object.assign`으로는 못 얹는다 — 그래서 defineProperty로 만든다.)
  const delegate = Object.create(proto) as object;
  const own: Record<string, unknown> = {
    paths: k.paths,
    getState: () => k.getState(),
    getManifest: () => k.getManifest(),
    getTask: (id: string) => k.getTask(id),
    completeTaskWithArtifacts: () => ({ task: k.getTask("root"), artifacts: [] }),
  };
  for (const [name, value] of Object.entries(own)) {
    Object.defineProperty(delegate, name, { value, enumerable: true, configurable: true });
  }
  assert.equal(attestOrchestrationKernel(delegate, M), null, "delegate가 증명됐다");

  // ⓒ 진짜 kernel을 감싼 Proxy(신원만 빌린다).
  assert.equal(attestOrchestrationKernel(new Proxy(k, {}), M), null, "Proxy wrapper가 증명됐다");

  // ⓓ 메서드 함수만 복사한 객체.
  const copied: Record<string, unknown> = { paths: k.paths };
  for (const m of M) copied[m] = proto[m];
  assert.equal(attestOrchestrationKernel(copied, M), null, "메서드 복사본이 증명됐다");

  // ⓔ prototype 위조.
  const spoofed = Object.create(proto) as object;
  assert.equal(attestOrchestrationKernel(spoofed, M), null, "prototype 위조가 증명됐다");

  // ⓕ 원시값·null·함수.
  for (const v of [null, undefined, "kernel", 1, () => undefined]) {
    assert.equal(attestOrchestrationKernel(v, M), null, `${String(v)}가 증명됐다`);
  }

  // ⓖ 발급기·토큰·factory는 export되어 있지 않다 — 나가는 것은 판정 함수 하나뿐이다.
  assert.deepEqual(
    Object.keys(kernelModule).filter((key) => /attest|issue|token|genuine|brand/i.test(key)),
    ["attestOrchestrationKernel"],
    "임의 객체를 진짜 kernel로 만들어 줄 표면이 늘었다",
  );
});

test("[M4a] 같은 runId로 create를 다시 부르면 거부한다(조용한 덮어쓰기 금지)", () => {
  const { ws } = bootRoot();
  assert.equal(
    codeOf(() =>
      createOrchestrationRun({
        workspaceRoot: ws,
        runId: RUN_ID,
        milestoneId: MILESTONE,
        manifest: manifestFor(["root"]),
        clock: fixedClock(),
      }),
    ),
    "run_already_exists",
  );
});

// ── load fail-closed ────────────────────────────────────────────────────────

test("[M4a] load fail-closed: 없는 run · 깨진 JSON · 미지 필드 · runId 불일치", () => {
  const ws = makeWorkspace();
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: "ghost-run" })), "run_not_found");

  const { ws: ws2 } = bootRoot();
  const paths = runPaths(ws2, RUN_ID);
  const original = readFileSync(paths.stateFile, "utf8");

  writeFileSync(paths.stateFile, "{ not json");
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID, clock: fixedClock() })), "state_unparsable");

  writeFileSync(paths.stateFile, JSON.stringify({ ...JSON.parse(original), sneaky: true }));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID, clock: fixedClock() })), "invalid_state");

  writeFileSync(paths.stateFile, JSON.stringify({ ...JSON.parse(original), runId: "other-run" }));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID, clock: fixedClock() })), "run_id_mismatch");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4a] load fail-closed: event 개수·체인·미지 필드 변조", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const originalEvents = readFileSync(paths.eventsFile, "utf8");
  const lines = originalEvents.split("\n").filter((l) => l.length > 0);

  writeFileSync(paths.eventsFile, `${lines.slice(0, -1).join("\n")}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "event_count_mismatch");

  const tampered = JSON.parse(lines[lines.length - 1]);
  tampered.reason = "created";
  writeFileSync(paths.eventsFile, `${[...lines.slice(0, -1), JSON.stringify(tampered)].join("\n")}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "event_chain_broken");

  const midTampered = JSON.parse(lines[0]);
  midTampered.at = "2030-01-01T00:00:00.000Z";
  writeFileSync(paths.eventsFile, `${[JSON.stringify(midTampered), ...lines.slice(1)].join("\n")}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "event_chain_broken");

  writeFileSync(paths.eventsFile, `${lines.join("\n")}\nnot-json\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "event_count_mismatch");

  writeFileSync(paths.eventsFile, originalEvents);
  appendFileSync(paths.eventsFile, "");
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4a] load fail-closed: message body 변조·삭제·symlink", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const bodyFile = join(paths.messagesDir, "asg-root.md");
  const originalBody = readFileSync(bodyFile, "utf8");

  writeFileSync(bodyFile, `${originalBody}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "message_body_hash_mismatch");

  rmSync(bodyFile);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "message_body_missing");

  const decoy = join(paths.dir, "decoy.md");
  writeFileSync(decoy, originalBody);
  symlinkSync(decoy, bodyFile);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "message_body_not_regular_file");

  rmSync(bodyFile);
  writeFileSync(bodyFile, originalBody);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4a] load fail-closed: 등록된 artifact가 사라지거나 변조되면 열리지 않는다", () => {
  const { ws, k } = bootRoot();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" });
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));

  writeFileSync(join(ws, "docs", "a.md"), "tampered\n");
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "artifact_hash_mismatch");

  rmSync(join(ws, "docs", "a.md"));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "artifact_missing");

  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4a][P0-1] 문법적으로 유효한 state 편집은 kernel 우회에 실패한다(state↔event binding)", () => {
  const { ws, k } = bootCleanedRoot();
  const paths = runPaths(ws, RUN_ID);
  const original = readFileSync(paths.stateFile, "utf8");
  assert.equal(k.getTask("root")!.state, "cleaning");

  // Codex 재현 시나리오: run_state.json만 고쳐 완료를 위조한다. 위조는 **그 자체로는 유효한 v2**여야
  // 한다(완료된 task는 미확정 결과를 들고 있을 수 없다) → 남는 위반이 "전이 권위" 하나뿐이 된다.
  const forged = JSON.parse(original);
  forged.tasks[0].state = "completed";
  forged.tasks[0].execution.pendingResult = null;
  forged.tasks[0].resultSummary = "forged";
  writeFileSync(paths.stateFile, JSON.stringify(forged, null, 2));
  assert.equal(
    codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })),
    "state_event_binding_mismatch",
  );

  // 개별 허용 필드 하나만 건드려도 동일하게 거부된다.
  for (const mutate of [
    (s: any) => {
      s.tasks[0].state = "completed";
      s.tasks[0].execution.pendingResult = null;
    },
    (s: any) => (s.tasks[0].resultSummary = "forged"),
    (s: any) => (s.tasks[0].ownership = ["src/hijacked"]),
    (s: any) => (s.revision += 1),
    (s: any) => (s.milestoneId = "other"),
    (s: any) => (s.messages[0].summary = "forged"),
    // M4c: 승인 범위 확대도 같은 binding에 걸린다(digest에 manifest가 들어 있다).
    (s: any) => s.manifest.writableRoots.push("infra"),
    (s: any) => (s.manifest.maxSessions = 16),
    (s: any) => (s.manifest.localMergeAllowed = true),
    (s: any) => (s.manifest.ownershipByTask.root = ["docs", "src", "infra"]),
    (s: any) => (s.manifest.expiresAt = "2027-12-31T00:00:00.000Z"),
    (s: any) => s.manifest.allowedCommands.push("rm -rf"),
  ].entries()) {
    const s = JSON.parse(original);
    mutate[1](s);
    writeFileSync(paths.stateFile, JSON.stringify(s, null, 2));
    const code = codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
    assert.ok(
      // 전부 fail-closed 거부다. task_assignment에 summary를 끼워 넣는 위조는 M4c의 summary 계약
      // (invalid_state)에, milestone·승인 범위 위조는 manifest 검사와 **M5c의 회계↔승인 묶기**
      // (accounting_approval_mismatch — 승인이 바뀌면 예산 이력을 이어 쓰지 않는다)에 binding보다
      // **먼저** 걸린다.
      [
        "state_event_binding_mismatch",
        "run_id_mismatch",
        "manifest_milestone_mismatch",
        "ownership_outside_writable_root",
        "accounting_approval_mismatch",
        "invalid_state",
      ].includes(code),
      `허용 필드 변조 #${mutate[0]}가 통과했다 (code=${code})`,
    );
  }

  // 마지막 이벤트의 stateDigest를 지우는 것도 fail-closed다.
  writeFileSync(paths.stateFile, original);
  const lines = readFileSync(paths.eventsFile, "utf8").split("\n").filter((l) => l.length > 0);
  const lastEvent = JSON.parse(lines[lines.length - 1]);
  assert.ok(/^[0-9a-f]{64}$/.test(lastEvent.stateDigest), "마지막 이벤트에 stateDigest가 없다");
  assert.equal(JSON.parse(lines[0]).stateDigest !== null, true, "run_created도 커밋 마지막 이벤트다");

  // 원상 복구하면 다시 열린다.
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
  assert.equal(openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }).getTask("root")!.state, "cleaning");
});

test("[M4a][P0-1] stateDigest는 chain 필드를 제외해 순환하지 않고 커밋 마지막 이벤트에만 붙는다", () => {
  const { ws, k } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const state = k.getState();

  // digest는 lastEventId/lastEventHash와 무관하다(순환 없음).
  const base = stateContentDigest(state);
  assert.equal(stateContentDigest({ ...state, lastEventId: 999, lastEventHash: "f".repeat(64) }), base);
  assert.notEqual(stateContentDigest({ ...state, revision: state.revision + 1 }), base);

  const events = readFileSync(paths.eventsFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  assert.equal(events[events.length - 1].stateDigest, base);
  // createRootTask 커밋은 이벤트 여러 건이고, 그중 마지막만 digest를 든다.
  const withDigest = events.filter((e) => e.stateDigest !== null).length;
  assert.ok(withDigest < events.length, "모든 이벤트가 digest를 들고 있다 — 커밋 경계가 사라졌다");
  // M5c 시작 경로는 커밋 두 개다(preflight → startPreparedTask) → run_created/createRootTask와 함께 4건.
  assert.equal(withDigest, 4, "커밋 4건(run_created/createRootTask/preflight/startPreparedTask)만 digest를 남겨야 한다");
});

test("[M4a][P0-1] 이벤트 없는 커밋은 거부한다(binding을 남길 곳이 없다)", () => {
  const { ws, k } = bootRoot();
  const s = k.getState();
  assert.equal(
    codeOf(() =>
      commitRun(runPaths(ws, RUN_ID), {
        state: s,
        events: [],
        bodies: [],
        base: { revision: s.revision, lastEventId: s.lastEventId, lastEventHash: s.lastEventHash },
      }),
    ),
    "commit_without_event",
  );
});

test("[M4a] validateRunState는 참조 무결성 위반을 거부한다", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const base = JSON.parse(readFileSync(paths.stateFile, "utf8"));

  const orphanDep = structuredClone(base);
  orphanDep.tasks[0].dependsOn = ["ghost"];
  assert.equal(codeOf(() => validateRunState(orphanDep)), "unknown_dependency");

  const orphanParent = structuredClone(base);
  orphanParent.tasks[0].parentTaskId = "ghost";
  assert.equal(codeOf(() => validateRunState(orphanParent)), "unknown_parent");

  const selfDep = structuredClone(base);
  selfDep.tasks[0].dependsOn = [selfDep.tasks[0].taskId];
  assert.equal(codeOf(() => validateRunState(selfDep)), "self_dependency");

  const badState = structuredClone(base);
  badState.tasks[0].state = "paused";
  assert.equal(codeOf(() => validateRunState(badState)), "invalid_state");

  const badArtifactRef = structuredClone(base);
  badArtifactRef.tasks[0].artifactRefs = [
    { path: "docs/a.md", sha256: "a".repeat(64), revision: 1, producerTaskId: "root", role: "output" },
  ];
  assert.equal(codeOf(() => validateRunState(badArtifactRef)), "unknown_artifact");

  const unsorted = structuredClone(base);
  unsorted.tasks = [
    { ...base.tasks[0], taskId: "zz", parentTaskId: null, childTaskIds: [] },
    { ...base.tasks[0], taskId: "aa", parentTaskId: null, childTaskIds: [] },
  ];
  assert.equal(codeOf(() => validateRunState(unsorted)), "invalid_state");
});

// ── schema ↔ runtime 동치 ───────────────────────────────────────────────────

function readSchema(name: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, "schemas", name), "utf8"));
}

test("[M4a] agent_message.schema.json이 runtime 계약과 동치다", () => {
  const s = readSchema("agent_message.schema.json");
  assert.deepEqual(s.properties.type.enum, [...AGENT_MESSAGE_TYPES]);
  assert.deepEqual(s.required, [...ENVELOPE_KEYS]);
  assert.deepEqual(Object.keys(s.properties).sort(), [...ENVELOPE_KEYS].sort());
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.schemaVersion.const, ORCHESTRATION_SCHEMA_VERSION);

  const ap = s.definitions.artifactPointer;
  assert.deepEqual(ap.required, [...ARTIFACT_POINTER_KEYS]);
  assert.equal(ap.additionalProperties, false);
  assert.deepEqual(ap.properties.role.enum, [...ARTIFACT_ROLES]);

  assert.equal(s.definitions.slug.pattern, SLUG_PATTERN);
  assert.equal(s.definitions.slug.maxLength, LIMITS.maxIdLength);
  assert.equal(s.definitions.timestamp.pattern, TIMESTAMP_PATTERN);
  assert.equal(s.definitions.sha256.pattern, SHA256_PATTERN);
  assert.equal(s.definitions.workspacePath.maxLength, LIMITS.maxPathLength);
  assert.equal(s.properties.dependsOn.maxItems, LIMITS.maxDependsOn);
  assert.equal(s.properties.artifactRefs.maxItems, LIMITS.maxArtifactRefs);

  const bh = s.definitions.messageBodyHeadings.properties;
  assert.equal(bh.maxBodyBytes.const, LIMITS.maxBodyBytes);
  for (const type of AGENT_MESSAGE_TYPES) {
    assert.deepEqual(bh[type].const, [...REQUIRED_BODY_HEADINGS[type]], type);
  }
});

test("[M4a] orchestration_run_state.schema.json이 runtime 계약과 동치다", () => {
  const s = readSchema("orchestration_run_state.schema.json");
  assert.deepEqual(s.required, [...STATE_KEYS]);
  assert.deepEqual(Object.keys(s.properties).sort(), [...STATE_KEYS].sort());
  assert.equal(s.additionalProperties, false);
  // M5c — state 계약 버전은 envelope와 분리되어 **"2"** 다(v1 바이트는 마이그레이션 없이 거부된다).
  assert.equal(s.properties.schemaVersion.const, RUN_STATE_SCHEMA_VERSION);
  assert.equal(s.properties.schemaVersion.const, "2");

  const d = s.definitions;
  assert.deepEqual(d.taskState.enum, [...TASK_STATES]);
  assert.deepEqual(d.messageType.enum, [...AGENT_MESSAGE_TYPES]);
  assert.deepEqual(d.artifactRole.enum, [...ARTIFACT_ROLES]);
  assert.deepEqual(d.event.properties.type.enum, [...EVENT_TYPES]);
  assert.deepEqual(d.event.properties.reason.oneOf[0].enum, [...TRANSITION_REASONS]);

  assert.deepEqual(d.task.required, [...TASK_KEYS]);
  assert.deepEqual(d.message.required, [...MESSAGE_KEYS]);
  assert.deepEqual(d.artifactRecord.required, [...ARTIFACT_RECORD_KEYS]);
  assert.deepEqual(d.event.required, [...EVENT_KEYS]);
  for (const def of ["task", "message", "artifactRecord", "event", "artifactPointer"]) {
    assert.equal(d[def].additionalProperties, false, def);
  }

  assert.equal(s.properties.tasks.maxItems, LIMITS.maxTasksPerRun);
  assert.equal(d.task.properties.childTaskIds.maxItems, LIMITS.maxChildrenPerTask);
  assert.equal(d.task.properties.depth.maximum, LIMITS.maxDepth);
  assert.equal(d.task.properties.ownership.maxItems, LIMITS.maxOwnershipPaths);
  assert.equal(d.task.properties.dependsOn.maxItems, LIMITS.maxDependsOn);
  assert.equal(d.task.properties.artifactRefs.maxItems, LIMITS.maxArtifactRefs);
  assert.equal(d.task.properties.resourceClasses.maxItems, LIMITS.maxResourceClasses);
  assert.equal(d.task.properties.resourceClasses.items.$ref, "#/definitions/slug");
  assert.equal(d.task.properties.resourceClasses.uniqueItems, true);
  assert.equal(d.boundedText.maxLength, LIMITS.maxTextLength);
  assert.equal(d.boundedSummary.maxLength, LIMITS.maxSummaryLength);
  assert.equal(d.slug.maxLength, LIMITS.maxIdLength);
  assert.equal(d.slug.pattern, SLUG_PATTERN);
  assert.equal(d.timestamp.pattern, TIMESTAMP_PATTERN);
  assert.equal(d.sha256.pattern, SHA256_PATTERN);

  // ── M5c v2: 새 닫힌 key 집합 · enum · required · bounds가 **정확히** 같아야 한다 ──

  // ⓐ durable 회계(대장 B-12)
  assert.deepEqual(d.accounting.required, [...ACCOUNTING_KEYS]);
  assert.deepEqual(Object.keys(d.accounting.properties).sort(), [...ACCOUNTING_KEYS].sort());
  assert.equal(d.accounting.additionalProperties, false);
  assert.equal(d.accounting.properties.approvalDigest.$ref, "#/definitions/sha256");
  assert.equal(d.accounting.properties.tokensUsed.maximum, LIMITS.maxAccountedTokens);
  assert.equal(d.accounting.properties.tokensUsed.minimum, 0);
  assert.equal(d.accounting.properties.elapsedMsUsed.maximum, LIMITS.maxAccountedElapsedMs);
  assert.equal(d.accounting.properties.elapsedMsUsed.minimum, 0);
  assert.equal(d.accounting.properties.chargedTurnIds.maxItems, LIMITS.maxChargedTurnIds);
  assert.equal(d.accounting.properties.chargedTurnIds.uniqueItems, true);
  assert.equal(s.properties.accounting.$ref, "#/definitions/accounting");

  // ⓑ task 실행 lifecycle(대장 B-11/B-13/C-18)
  assert.deepEqual(d.taskExecution.required, [...TASK_EXECUTION_KEYS]);
  assert.deepEqual(Object.keys(d.taskExecution.properties).sort(), [...TASK_EXECUTION_KEYS].sort());
  assert.equal(d.taskExecution.additionalProperties, false);
  assert.equal(d.task.properties.execution.$ref, "#/definitions/taskExecution");
  const te = d.taskExecution.properties;
  assert.equal(te.attemptNo.maximum, LIMITS.maxTaskAttempts);
  assert.equal(te.attemptNo.minimum, 0);
  assert.equal(te.progressCount.maximum, LIMITS.maxProgressEvents);
  assert.equal(te.cleanupAttempts.maximum, LIMITS.maxCleanupAttempts);
  assert.equal(te.operationReceipts.maxItems, LIMITS.maxOperationReceipts);
  assert.equal(te.cleanupStatus.$ref, "#/definitions/cleanupStatus");
  assert.equal(te.terminalMarker.oneOf[0].$ref, "#/definitions/autopilotMarker");
  assert.equal(te.pauseReason.oneOf[0].$ref, "#/definitions/pauseReason");
  assert.equal(te.processLeaseMarker.oneOf[0].$ref, "#/definitions/leaseMarker");
  assert.equal(te.preflightDigest.oneOf[0].$ref, "#/definitions/sha256");
  // lease marker는 PID·argv가 아니라 `lease.<32 hex>` 하나뿐이다(runtime과 같은 형태).
  assert.equal(d.leaseMarker.pattern, "^lease\\.[0-9a-f]{32}$");
  assert.equal(new RegExp(d.leaseMarker.pattern).test("lease.0123456789abcdef0123456789abcdef"), true);
  assert.equal(new RegExp(d.leaseMarker.pattern).test("12345"), false);

  // ⓒ 미확정 결과 · operation 영수증
  assert.deepEqual(d.pendingResult.required, [...PENDING_RESULT_KEYS]);
  assert.equal(d.pendingResult.additionalProperties, false);
  assert.equal(d.pendingResult.properties.outputs.maxItems, LIMITS.maxArtifactRefs);
  assert.deepEqual(d.operationReceipt.required, [...OPERATION_RECEIPT_KEYS]);
  assert.deepEqual(Object.keys(d.operationReceipt.properties).sort(), [...OPERATION_RECEIPT_KEYS].sort());
  assert.equal(d.operationReceipt.additionalProperties, false);
  assert.deepEqual(d.operationReceiptMarker.enum, [...OPERATION_RECEIPT_MARKERS]);
  assert.deepEqual(d.operationKind.enum, [...APPROVED_OPERATION_KINDS]);
  assert.equal(d.operationReceipt.properties.exitCode.oneOf[0].minimum, -255);
  assert.equal(d.operationReceipt.properties.exitCode.oneOf[0].maximum, 255);

  // ⓓ 전달 재시도(대장 C-12→B)
  assert.deepEqual(d.messageDelivery.required, [...DELIVERY_KEYS]);
  assert.deepEqual(Object.keys(d.messageDelivery.properties).sort(), [...DELIVERY_KEYS].sort());
  assert.equal(d.messageDelivery.additionalProperties, false);
  assert.equal(d.messageDelivery.properties.attempts.maximum, LIMITS.maxDeliveryAttempts);
  assert.deepEqual(d.deliveryMarker.enum, [...DELIVERY_MARKERS]);
  assert.equal(d.message.properties.delivery.$ref, "#/definitions/messageDelivery");

  // ⓔ 닫힌 enum 전수
  assert.deepEqual(d.autopilotMarker.enum, [...AUTOPILOT_MARKERS]);
  assert.deepEqual(d.pauseReason.enum, [...PAUSE_REASONS]);
  assert.deepEqual(d.cleanupStatus.enum, [...CLEANUP_STATUSES]);
  assert.deepEqual(d.resourceHoldingState.const, [...RESOURCE_HOLDING_STATES]);
  assert.deepEqual(d.safetyOnlyReasons.const, [...SAFETY_ONLY_REASONS]);
  assert.deepEqual(d.safetyOnlyEventTypes.const, [...SAFETY_ONLY_EVENT_TYPES]);
  // event marker는 여러 목록의 합집합이므로 **집합**으로 비교하고 schema 쪽 중복은 금지한다.
  assert.deepEqual(
    [...d.eventMarker.enum].sort(),
    [...new Set(EVENT_MARKERS as readonly string[])].sort(),
    "event marker 합집합이 runtime과 다르다",
  );
  assert.equal(new Set(d.eventMarker.enum).size, d.eventMarker.enum.length, "schema event marker에 중복이 있다");
  assert.equal(d.event.properties.marker.oneOf[0].$ref, "#/definitions/eventMarker");
  assert.equal(d.event.properties.tokenDelta.oneOf[0].maximum, LIMITS.maxAccountedTokens);
  assert.equal(d.event.properties.elapsedMs.oneOf[0].maximum, LIMITS.maxAccountedElapsedMs);

  // ⓕ 새 정의도 전부 미상 key를 거부한다(닫힌 계약).
  for (const def of ["accounting", "taskExecution", "operationReceipt", "pendingResult", "messageDelivery"]) {
    assert.equal(d[def].additionalProperties, false, def);
  }
});

test("[M4a] 실제로 생성된 state가 schema의 required/enum 범위 안에 있다", () => {
  const { ws, k } = bootRoot();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  const p = k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "evidence" });
  cleanVia(k, "root");
  k.submitResult({
    envelope: envelope("result", "root", "tech-lead", { messageId: "r1", artifactRefs: [p] }),
    body: body("result"),
    summary: "요약",
  });

  const s = readSchema("orchestration_run_state.schema.json");
  const state = JSON.parse(readFileSync(runPaths(ws, RUN_ID).stateFile, "utf8"));
  assert.deepEqual(Object.keys(state).sort(), [...s.required].sort());
  assert.deepEqual(Object.keys(state.tasks[0]).sort(), [...s.definitions.task.required].sort());
  assert.deepEqual(Object.keys(state.messages[0]).sort(), [...s.definitions.message.required].sort());
  assert.deepEqual(Object.keys(state.artifacts[0]).sort(), [...s.definitions.artifactRecord.required].sort());

  const events = readFileSync(runPaths(ws, RUN_ID).eventsFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), [...s.definitions.event.required].sort());
    assert.ok((EVENT_TYPES as readonly string[]).includes(e.type));
  }
});

// ── M4b: 배타 자원 class · 결정론적 scheduler · run writer lock ─────────────

/** 같은 배타 class를 요구하는 ready task 둘 + 자원을 요구하지 않는 ready task 하나. */
function bootResourceRun(): { ws: string; k: OrchestrationKernel } {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["a-stress", "b-live", "c-docs"]),
    clock: fixedClock(),
  });
  k.createRootTask(seed("a-stress", "qa-security", { resourceClasses: ["suite-lock"] }));
  k.createRootTask(seed("b-live", "qa-security", { resourceClasses: ["suite-lock"] }));
  k.createRootTask(seed("c-docs", "pm"));
  return { ws, k };
}

test("[M4b] resourceClasses: 기본값 [] · 정렬 · 중복/비-slug/상한 거부 · durable 왕복", () => {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["plain", "sorted"]),
    clock: fixedClock(),
  });

  assert.deepEqual(k.createRootTask(seed("plain", "pm")).resourceClasses, []);
  assert.deepEqual(k.createRootTask(seed("sorted", "pm", { resourceClasses: ["zz-tmp", "aa-lock"] })).resourceClasses, [
    "aa-lock",
    "zz-tmp",
  ]);

  assert.equal(codeOf(() => k.createRootTask(seed("dup", "pm", { resourceClasses: ["x", "x"] }))), "resource_class_duplicate");
  assert.equal(codeOf(() => k.createRootTask(seed("bad", "pm", { resourceClasses: ["Not Slug"] }))), "invalid_resource_class");
  assert.equal(codeOf(() => k.createRootTask(seed("bad2", "pm", { resourceClasses: "x" }))), "invalid_resource_class");
  assert.equal(
    codeOf(() => k.createRootTask(seed("many", "pm", { resourceClasses: ["a", "b", "c", "d", "e"] }))),
    "resource_class_too_many",
  );

  // durable 왕복 — 재시작해도 선언이 같은 바이트로 남는다.
  const paths = runPaths(ws, RUN_ID);
  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.deepEqual(reopened.getTask("sorted")!.resourceClasses, ["aa-lock", "zz-tmp"]);
  assert.equal(JSON.stringify(reopened.getState()), JSON.stringify(k.getState()));
  assert.ok(readFileSync(paths.stateFile, "utf8").includes('"resourceClasses"'), "state 파일에 resourceClasses가 없다");
  assert.ok(
    readFileSync(paths.snapshotFile, "utf8").includes("- resourceClasses: aa-lock, zz-tmp"),
    "snapshot에 자원 선언이 없다",
  );
});

test("[M4b] scheduler: 같은 class 두 ready 중 하나만 · 자원 없는 task는 같은 batch에서 함께", () => {
  const { k } = bootResourceRun();
  assert.deepEqual(k.listReady().map((t) => t.taskId), ["a-stress", "b-live", "c-docs"]);

  // 결정론: taskId 오름차순이라 a-stress가 이기고 b-live는 유예된다.
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["a-stress", "c-docs"]);
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["a-stress", "c-docs"], "scheduleReady가 결정론적이지 않다");

  startBatchVia(k, ["a-stress", "c-docs"]);
  assert.equal(k.getTask("a-stress")!.state, "running");
  assert.equal(k.getTask("c-docs")!.state, "running");
  assert.equal(k.getTask("b-live")!.state, "ready", "같은 class 두 task가 동시에 running이 됐다");
  // class가 점유된 동안에는 더 고를 것이 없다.
  assert.deepEqual(k.scheduleReady(), []);
  assert.deepEqual(k.planRunnableBatch().items, []);
  // batch를 바로 running으로 올리는 legacy 진입점은 닫혀 있다(대장 `B-11`).
  assert.equal(codeOf(() => k.startScheduledBatch()), "preflight_required");
});

test("[M4b] batch는 커밋 1회다 · limit 검증 · limit는 앞에서부터 자른다", () => {
  const { k } = bootResourceRun();
  const before = k.getState().revision;
  // M5c에서 batch의 **원자적 단위는 preflight 커밋**이다: 두 task가 한 커밋으로 prepared가 된다.
  const batch = k.planRunnableBatch();
  assert.equal(batch.items.length, 2);
  k.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextAction(),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: nextAttempt() })),
  });
  assert.equal(k.getState().revision, before + 1, "batch preflight가 커밋을 여러 번 했다");
  assert.deepEqual(
    k.getState().tasks.filter((t) => t.state === "prepared").map((t) => t.taskId),
    ["a-stress", "c-docs"],
  );

  assert.equal(codeOf(() => k.scheduleReady(0)), "invalid_batch_limit");
  assert.equal(codeOf(() => k.scheduleReady(LIMITS.maxScheduleBatch + 1)), "invalid_batch_limit");
  assert.equal(codeOf(() => k.scheduleReady(1.5)), "invalid_batch_limit");
  assert.equal(codeOf(() => k.planRunnableBatch(0)), "invalid_batch_limit");
  // legacy batch 진입점은 limit가 무엇이든 닫혀 있다(우회 경로 0).
  assert.equal(codeOf(() => k.startScheduledBatch(0)), "preflight_required");

  const { k: k2 } = bootResourceRun();
  assert.deepEqual(k2.scheduleReady(1).map((t) => t.taskId), ["a-stress"]);
  startBatchVia(k2, ["a-stress"]);
  assert.equal(k2.getTask("a-stress")!.state, "running");
  assert.deepEqual(k2.scheduleReady().map((t) => t.taskId), ["c-docs"]);
});

test("[M4b] scheduler를 우회하는 시작 경로가 없다 — 충돌 task는 결정 자체를 받지 못하고 전이 0", () => {
  const { ws, k } = bootResourceRun();
  const paths = runPaths(ws, RUN_ID);
  startBatchVia(k, ["a-stress"]);

  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  // ⓐ 점유된 class를 요구하는 b-live는 scheduler가 아예 고르지 않는다.
  const batch = k.planRunnableBatch();
  assert.deepEqual(batch.items.map((t) => t.taskId), ["c-docs"], "점유된 class의 task를 골랐다");
  // ⓑ 그래서 b-live를 prepared로 만드는 결정은 batch와 어긋난다 → 커밋 자체가 거부된다.
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: [
          { taskId: "c-docs", outcome: "deferred" },
          { taskId: "b-live", outcome: "prepared", attemptId: nextAttempt() },
        ],
      }),
    ),
    "preflight_batch_mismatch",
  );
  // ⓒ legacy 직접 진입점도 닫혀 있다.
  assert.equal(codeOf(() => k.startTask("b-live")), "preflight_required");
  assert.equal(k.getState().revision, revBefore, "거부된 start가 revision을 올렸다");
  assert.equal(dirFingerprint(paths.dir), filesBefore, "거부된 start가 파일을 바꿨다");
  assert.equal(k.getTask("b-live")!.state, "ready");

  // 자원을 요구하지 않는 task는 영향받지 않는다.
  startBatchVia(k, ["c-docs"]);
  assert.equal(k.getTask("c-docs")!.state, "running");
});

test("[M4b] 점유는 running 동안만 — waiting_children은 자원을 들고 있지 않는다", () => {
  const { k } = bootResourceRun();
  startBatchVia(k, ["a-stress"]);
  k.requestSpawn({
    envelope: envelope("spawn_request", "a-stress", "qa-security", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    child: seed("child", "dev-lead", { ownership: ["src/a-stress"] }),
  });
  assert.equal(k.getTask("a-stress")!.state, "waiting_children");
  // 중단된 parent는 점유하지 않으므로 같은 class의 b-live를 고를 수 있다.
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["b-live", "c-docs", "child"]);
  startBatchVia(k, ["b-live"]);
  assert.equal(k.getTask("b-live")!.state, "running");
});

test("[M4b] holder가 완료되면 class가 풀리고 대기 task가 schedulable해진다", () => {
  const { k } = bootResourceRun();
  startBatchVia(k, ["a-stress"]); // a-stress만 시작
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["c-docs"]);

  cleanVia(k, "a-stress");
  k.submitResult({
    envelope: envelope("result", "a-stress", "qa-security", { messageId: "res-a" }),
    body: body("result"),
    summary: "a-stress 완료 — suite-lock 해제",
  });
  assert.equal(k.getTask("a-stress")!.state, "completed");
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["b-live", "c-docs"]);
  startBatchVia(k, ["b-live", "c-docs"]);
  assert.deepEqual(
    k.getState().tasks.filter((t) => t.state === "running").map((t) => t.taskId),
    ["b-live", "c-docs"],
  );
});

test("[M4b] 재시작: durable state만으로 같은 점유·같은 schedule 결정", () => {
  const { ws, k } = bootResourceRun();
  startBatchVia(k, ["a-stress"]);
  const scheduleBefore = k.scheduleReady().map((t) => t.taskId);

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(reopened.getTask("a-stress")!.state, "running");
  assert.deepEqual(reopened.getTask("a-stress")!.resourceClasses, ["suite-lock"]);
  assert.deepEqual(reopened.scheduleReady().map((t) => t.taskId), scheduleBefore);
  // 재시작 뒤에도 점유된 class의 task는 batch에 없다(그래서 시작할 결정이 존재하지 않는다).
  assert.equal(reopened.planRunnableBatch().items.some((t) => t.taskId === "b-live"), false);
  assert.equal(codeOf(() => reopened.startTask("b-live")), "preflight_required");
});

test("[M4b] state 위조: resourceClasses 편집은 state↔event binding으로 거부된다", () => {
  const { ws, k } = bootResourceRun();
  const paths = runPaths(ws, RUN_ID);
  startBatchVia(k, ["a-stress"]);
  const original = readFileSync(paths.stateFile, "utf8");

  const forged = JSON.parse(original);
  forged.tasks.find((t: { taskId: string }) => t.taskId === "b-live").resourceClasses = [];
  writeFileSync(paths.stateFile, JSON.stringify(forged, null, 2));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "state_event_binding_mismatch");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4b] M4a state(resourceClasses 없음)는 마이그레이션 없이 거부한다", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const original = readFileSync(paths.stateFile, "utf8");
  const pre = JSON.parse(original);
  for (const t of pre.tasks) delete t.resourceClasses;
  writeFileSync(paths.stateFile, JSON.stringify(pre, null, 2));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "state_pre_m4b_unsupported");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4b] running 둘이 같은 class를 든 state는 커밋·load 양쪽에서 거부된다", () => {
  const { ws, k } = bootResourceRun();
  startBatchVia(k, ["a-stress"]);
  const onDisk = JSON.parse(readFileSync(runPaths(ws, RUN_ID).stateFile, "utf8"));
  const forgedRunning = onDisk.tasks.find((t: { taskId: string }) => t.taskId === "b-live");
  forgedRunning.state = "running";
  // 위조를 **그 자체로는 유효한 v2**로 만든다(running은 attempt를 배정받은 상태다) → 남는 위반이
  // "같은 배타 자원 class를 둘이 점유한다" 하나뿐이 된다.
  forgedRunning.execution.attemptNo = 1;
  forgedRunning.execution.attemptId = "att.forged";
  assert.equal(codeOf(() => validateRunState(onDisk)), "resource_conflict");

  const valid = validateRunState(JSON.parse(readFileSync(runPaths(ws, RUN_ID).stateFile, "utf8")));
  assert.doesNotThrow(() => assertExclusiveResourceClaims(valid.tasks));
  assert.equal(
    codeOf(() => assertExclusiveResourceClaims(valid.tasks.map((t) => ({ ...t, state: "running" as const })))),
    "resource_conflict",
  );
});

test("[M4b] stale writer: 같은 revision에서 열린 두 kernel 중 늦은 쪽 커밋은 거부된다", () => {
  const { ws, k } = bootRoot(["first", "second", "third"]);
  const paths = runPaths(ws, RUN_ID);
  const stale = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(stale.getState().revision, k.getState().revision);

  k.createRootTask(seed("first", "pm")); // 첫 writer 성공
  const afterFirst = dirFingerprint(paths.dir);

  // 두 번째 kernel은 낡은 기준을 들고 있다 → 덮어쓰지 못하고 전이 0으로 거부된다.
  assert.equal(codeOf(() => stale.createRootTask(seed("second", "pm"))), "stale_writer");
  assert.equal(dirFingerprint(paths.dir), afterFirst, "stale writer가 파일을 바꿨다");

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.ok(reopened.getTask("first"), "첫 writer의 결과가 사라졌다");
  assert.equal(reopened.getTask("second"), null);
  assert.equal(reopened.getState().revision, k.getState().revision);
  // 다시 열면 최신 기준을 갖고 정상 커밋한다.
  assert.doesNotThrow(() => reopened.createRootTask(seed("third", "pm")));
});

test("[M4b] writer lock: 다른 writer가 쥐고 있으면 대기 없이 거부하고 전이 0", () => {
  const { ws, k } = bootRoot(["blocked", "after-release"]);
  const paths = runPaths(ws, RUN_ID);
  const held = acquireRunWriterLock(paths);

  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  assert.equal(codeOf(() => k.createRootTask(seed("blocked", "pm"))), "run_lock_held");
  assert.equal(k.getState().revision, revBefore);
  assert.equal(dirFingerprint(paths.dir), filesBefore, "lock 거부가 파일을 바꿨다");
  assert.equal(k.getTask("blocked"), null);

  releaseRunWriterLock(paths, held);
  assert.ok(!existsSync(paths.lockFile), "release 후에도 lock 파일이 남아 있다");
  assert.doesNotThrow(() => k.createRootTask(seed("after-release", "pm")));
  assert.ok(!existsSync(paths.lockFile), "정상 커밋 후 lock 파일이 남아 있다");
});

test("[M4b] writer lock 정리는 자기 acquire만 지운다 — 남의 lock은 보존", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const mine = acquireRunWriterLock(paths);
  assert.equal(codeOf(() => acquireRunWriterLock(paths)), "run_lock_held");
  assert.equal(
    codeOf(() => releaseRunWriterLock(paths, { file: paths.lockFile, nonce: "f".repeat(32) })),
    "run_lock_owner_mismatch",
  );
  assert.ok(existsSync(paths.lockFile), "남의 lock을 지웠다");
  releaseRunWriterLock(paths, mine);
  assert.ok(!existsSync(paths.lockFile));
});

// ── M4c: 메시지 10종 · 중앙 경유 라우팅 · 승인 manifest · specialist registry ──

/**
 * 라우팅 검증용 토폴로지:
 * `parent`(root) → child `kid-a`/`kid-b`(같은 parent = sibling, 둘 다 roleId `dev-lead`),
 * `lonely`(무관한 root), `reviewer`/`fixer`(둘 다 `kid-a`에 의존하는 dependent).
 */
function bootRouting(): { ws: string; k: OrchestrationKernel } {
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["parent", "lonely", "reviewer", "fixer"]),
    clock: fixedClock(),
  });
  k.createRootTask(seed("parent", "tech-lead", { ownership: ["src"] }));
  k.createRootTask(seed("lonely", "research"));
  startVia(k, "parent");
  for (const kid of ["kid-a", "kid-b"]) {
    k.requestSpawn({
      envelope: envelope("spawn_request", "parent", "tech-lead", { messageId: `spawn-${kid}` }),
      body: body("spawn_request"),
      child: seed(kid, "dev-lead", { ownership: [`src/${kid}`] }),
    });
  }
  k.createDependentTask({ ...seed("reviewer", "qa-security"), dependsOn: ["kid-a"] });
  k.createDependentTask({ ...seed("fixer", "dev-lead.fix"), dependsOn: ["kid-a"] });
  startVia(k, "kid-a");
  startVia(k, "kid-b");
  return { ws, k };
}

/** child task가 중앙에 내는 envelope(parentTaskId는 state와 일치해야 한다). */
function kidEnvelope(type: AgentMessageType, taskId: string, roleId: string, over: EnvOverrides = {}): EnvOverrides {
  return envelope(type, taskId, roleId, { parentTaskId: "parent", ...over });
}

/** kid-a를 완료시켜 reviewer/fixer를 ready로 만든다(확인된 정리 뒤에만 수락된다 — 대장 `B-13`). */
function completeKidA(k: OrchestrationKernel): void {
  cleanVia(k, "kid-a");
  k.submitResult({
    envelope: kidEnvelope("result", "kid-a", "dev-lead", { messageId: "res-kid-a" }),
    body: body("result"),
    summary: "kid-a 완료",
  });
}

test("[M4c] §5.1 메시지 10종이 runtime·body·summary 계약과 정렬돼 있다", () => {
  assert.equal(AGENT_MESSAGE_TYPES.length, 10);
  for (const type of AGENT_MESSAGE_TYPES) {
    assert.equal(validateEnvelope(envelope(type, "root", "pm")).type, type);
    const headings = REQUIRED_BODY_HEADINGS[type];
    assert.ok(headings.length >= 3, `${type} heading 집합이 비었다`);
    assert.equal(validateMessageBody(type, body(type)), body(type));
    assert.equal(codeOf(() => validateMessageBody(type, `${body(type)}\n## Extra\n`)), "body_unknown_heading");
    const missingFirst = headings
      .slice(1)
      .map((h) => `## ${h}\n\n본문.\n`)
      .join("\n");
    assert.equal(codeOf(() => validateMessageBody(type, missingFirst)), "body_missing_heading");
    assert.equal(typeof SUMMARY_REQUIRED[type], "boolean");
  }
  // 로드맵 §5.2가 지정한 heading은 그대로다(review_result · blocker/decision_request 공유).
  assert.deepEqual(REQUIRED_BODY_HEADINGS.review_result, [
    "Reviewed Revision and Hash",
    "Findings (P0/P1/P2)",
    "Reproduction or Evidence",
    "Missing Tests",
    "Contract Deviations",
    "Verdict: pass | revise | block",
  ]);
  assert.deepEqual(REQUIRED_BODY_HEADINGS.decision_request, [...REQUIRED_BODY_HEADINGS.blocker]);
  assert.deepEqual([...CENTRAL_MESSAGE_TYPES], ["task_assignment", "review_request", "revision_request", "decision"]);
});

test("[M4c] manifest 검증: closed key · 정확한 pin · 도메인 · commit · 상한", () => {
  const ok = validateApprovalManifest(manifestFor(["root"]));
  assert.equal(ok.milestoneId, MILESTONE);
  assert.deepEqual(ok.writableRoots, ["docs", "src"]);

  const bad = (over: Record<string, unknown>): string => codeOf(() => validateApprovalManifest(manifestFor(["root"], over)));
  assert.equal(bad({ extra: 1 }), "invalid_manifest");
  assert.equal(bad({ approvedCommit: "abc123" }), "invalid_manifest");
  assert.equal(bad({ approvedCommit: "main" }), "invalid_manifest");
  assert.equal(bad({ writableRoots: [] }), "invalid_manifest");
  assert.equal(bad({ writableRoots: ["../escape"] }), "path_parent_segment");
  assert.equal(bad({ writableRoots: ["/abs"] }), "path_absolute");
  assert.equal(bad({ maxSessions: 0 }), "invalid_manifest");
  assert.equal(bad({ maxSessions: LIMITS.maxManifestSessions + 1 }), "invalid_manifest");
  assert.equal(bad({ maxElapsedMs: 0 }), "invalid_manifest");
  assert.equal(bad({ maxTokens: 0 }), "invalid_manifest");
  assert.equal(bad({ localMergeAllowed: "yes" }), "invalid_manifest");
  assert.equal(bad({ expiresAt: "2026-12-31" }), "invalid_timestamp");
  assert.equal(bad({ ownershipByTask: { root: ["infra/deploy.sh"] } }), "ownership_outside_writable_root");
  assert.equal(bad({ ownershipByTask: { root: [] } }), "invalid_manifest");

  // 정확히 pin되지 않은 dependency는 전부 거부한다(레포 hard deny의 @latest 금지와 같은 규칙).
  for (const version of ["latest", "^5.7.2", "~5.7", "5.x", "5.7", ">=5.0.0", "next", ""]) {
    assert.equal(bad({ allowedDependencies: [{ name: "typescript", version }] }), "dependency_not_pinned", version);
  }
  assert.equal(bad({ allowedDependencies: [{ name: "typescript", version: "5.7.2", extra: 1 }] }), "invalid_manifest");
  assert.equal(bad({ allowedDependencies: [{ name: "TypeScript", version: "5.7.2" }] }), "invalid_manifest");
  assert.equal(
    bad({
      allowedDependencies: [
        { name: "typescript", version: "5.7.2" },
        { name: "typescript", version: "5.7.3" },
      ],
    }),
    "invalid_manifest",
  );
  assert.doesNotThrow(() =>
    validateApprovalManifest(manifestFor(["root"], { allowedDependencies: [{ name: "@scope/pkg", version: "1.0.0-rc.1" }] })),
  );

  for (const domain of [
    "https://registry.npmjs.org",
    "*.npmjs.org",
    "registry.npmjs.org:443",
    "REGISTRY.NPMJS.ORG",
    "localhost",
    "registry.npmjs.org/x",
  ]) {
    assert.equal(bad({ allowedNetworkDomains: [domain] }), "invalid_manifest", domain);
  }
  for (const command of ["  npm test", "npm  test", "npm test ", "npm\ttest"]) {
    assert.equal(bad({ allowedCommands: [command] }), "invalid_manifest", JSON.stringify(command));
  }
  // 정규화: 같은 승인이 두 바이트로 저장되지 않는다(사전순 고정).
  assert.deepEqual(validateApprovalManifest(manifestFor(["root"], { writableRoots: ["src", "docs"] })).writableRoots, [
    "docs",
    "src",
  ]);
});

test("[M4c] M5용 조회 API는 순수하고 deny-by-default다 — 실행하지 않는다", () => {
  const m = validateApprovalManifest(manifestFor(["root"]));
  assert.equal(commandAllowed(m, "npm test"), true);
  assert.equal(commandAllowed(m, "npm run build"), true);
  assert.equal(commandAllowed(m, "npm run build --force"), false);
  assert.equal(commandAllowed(m, "rm -rf /"), false);
  assert.equal(commandAllowed(m, " npm test"), false);
  assert.equal(commandAllowed(m, ""), false);
  assert.equal(commandAllowed(m, undefined), false);

  assert.equal(dependencyAllowed(m, "typescript", "5.7.2"), true);
  assert.equal(dependencyAllowed(m, "typescript", "5.7.3"), false);
  assert.equal(dependencyAllowed(m, "typescript", "latest"), false);
  assert.equal(dependencyAllowed(m, "typescript", "^5.7.2"), false);
  assert.equal(dependencyAllowed(m, "tsx", "5.7.2"), false);

  assert.equal(networkDomainAllowed(m, "registry.npmjs.org"), true);
  assert.equal(networkDomainAllowed(m, "evil.registry.npmjs.org"), false, "하위 도메인 자동 허용 금지");
  assert.equal(networkDomainAllowed(m, "npmjs.org"), false);
  assert.equal(networkDomainAllowed(m, "https://registry.npmjs.org"), false);

  // 조회 API는 manifest를 바꾸지 않는다(순수 함수).
  assert.deepEqual(m, validateApprovalManifest(manifestFor(["root"])));
});

test("[M4c] manifest는 run에 bind되고 durable·재시작 안정적이다 · milestone 불일치·만료 거부", () => {
  const ws = makeWorkspace();
  assert.equal(
    codeOf(() =>
      createOrchestrationRun({
        workspaceRoot: ws,
        runId: RUN_ID,
        milestoneId: MILESTONE,
        manifest: manifestFor(["root"], { milestoneId: "other-milestone" }),
        clock: fixedClock(),
      }),
    ),
    "manifest_milestone_mismatch",
  );
  assert.equal(
    codeOf(() =>
      createOrchestrationRun({
        workspaceRoot: ws,
        runId: RUN_ID,
        milestoneId: MILESTONE,
        manifest: manifestFor(["root"], { expiresAt: "2020-01-01T00:00:00.000Z" }),
        clock: fixedClock(),
      }),
    ),
    "manifest_expired",
  );
  assert.equal(
    codeOf(() =>
      createOrchestrationRun({
        workspaceRoot: ws,
        runId: RUN_ID,
        milestoneId: MILESTONE,
        manifest: undefined,
        clock: fixedClock(),
      }),
    ),
    "invalid_manifest",
  );

  const { ws: ws2, k } = bootRoot();
  const paths = runPaths(ws2, RUN_ID);
  assert.equal(k.getManifest().approvedCommit, APPROVED_COMMIT);
  assert.ok(readFileSync(paths.stateFile, "utf8").includes(APPROVED_COMMIT), "state에 manifest가 없다");

  const snap = readFileSync(paths.snapshotFile, "utf8");
  assert.ok(snap.includes("## Milestone Approval"), "snapshot에 승인 요약이 없다");
  assert.ok(snap.includes("## Specialist Registry"), "snapshot에 registry가 없다");
  for (const r of SPECIALIST_ROLES) assert.ok(snap.includes(`- ${r.roleId} — ${r.title}`), r.roleId);

  const reopened = openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID, clock: fixedClock() });
  assert.deepEqual(reopened.getManifest(), k.getManifest());
  assert.equal(reopened.rebuildSnapshot(), snap, "재시작 후 snapshot 바이트가 다르다");

  // 읽기 API는 깊은 사본이다.
  const copy = k.getManifest();
  copy.writableRoots.push("infra");
  assert.deepEqual(k.getManifest().writableRoots, ["docs", "src"]);
});

test("[M4c] pre-M4c state(manifest 없음)는 자동 승인하지 않고 거부한다", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const original = readFileSync(paths.stateFile, "utf8");
  const pre = JSON.parse(original);
  delete pre.manifest;
  writeFileSync(paths.stateFile, JSON.stringify(pre, null, 2));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() })), "state_pre_m4c_unsupported");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() }));
});

test("[M4c] ownership 게이트: 미승인 root · writableRoots 밖 · child 권한 확대는 전이 0으로 거부", () => {
  const ws = makeWorkspace();
  const paths = runPaths(ws, RUN_ID);
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["approved"], { ownershipByTask: { approved: ["src/approved"] } }),
    clock: fixedClock(),
  });
  k.createRootTask(seed("approved", "tech-lead"));
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);

  assert.equal(codeOf(() => k.createRootTask(seed("unapproved", "pm"))), "ownership_not_approved");
  assert.equal(
    codeOf(() => k.createRootTask(seed("approved2", "pm", { ownership: ["src/elsewhere"] }))),
    "ownership_not_approved",
  );
  assert.equal(
    codeOf(() => k.createRootTask(seed("infra", "pm", { ownership: ["infra/deploy.sh"] }))),
    "ownership_outside_writable_root",
  );
  assert.equal(k.getState().revision, revBefore, "거부가 revision을 올렸다");
  assert.equal(dirFingerprint(paths.dir), filesBefore, "거부가 파일을 바꿨다");

  // child는 parent 범위의 **부분집합**만 위임받는다.
  startVia(k, "approved");
  assert.doesNotThrow(() =>
    k.requestSpawn({
      envelope: envelope("spawn_request", "approved", "tech-lead", { messageId: "spawn-ok" }),
      body: body("spawn_request"),
      child: seed("kid-ok", "dev-lead", { ownership: ["src/approved/sub"] }),
    }),
  );
  assert.equal(
    codeOf(() =>
      k.requestSpawn({
        envelope: envelope("spawn_request", "approved", "tech-lead", { messageId: "spawn-wide" }),
        body: body("spawn_request"),
        child: seed("kid-wide", "dev-lead", { ownership: ["src"] }),
      }),
    ),
    "ownership_not_delegated",
  );
  assert.equal(k.getTask("kid-wide"), null);
});

test("[M4c] maxSessions: 승인된 동시 세션을 넘는 시작은 거부되고 scheduler도 그 예산을 지킨다", () => {
  const ws = makeWorkspace();
  const paths = runPaths(ws, RUN_ID);
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["s1", "s2"], { maxSessions: 1 }),
    clock: fixedClock(),
  });
  k.createRootTask(seed("s1", "dev-lead"));
  k.createRootTask(seed("s2", "dev-lead"));
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["s1"], "scheduler가 승인 세션 예산을 넘었다");

  startBatchVia(k, ["s1"]);
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  // 승인 세션 예산이 다 찼으므로 scheduler는 s2를 고르지 않고, s2를 prepared로 만드는 결정은
  // batch와 어긋난다 → 커밋 거부(전이 0). 예산 초과 상태 자체를 만들 진입점이 없다.
  const batch = k.planRunnableBatch();
  assert.deepEqual(batch.items.map((t) => t.taskId), []);
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: [{ taskId: "s2", outcome: "prepared", attemptId: nextAttempt() }],
      }),
    ),
    "preflight_batch_mismatch",
  );
  assert.equal(codeOf(() => k.startTask("s2")), "preflight_required");
  assert.equal(k.getState().revision, revBefore);
  assert.equal(dirFingerprint(paths.dir), filesBefore);
  assert.deepEqual(k.scheduleReady(), []);

  // 손으로 running 둘을 만든 state도 load에서 거부된다(같은 불변식).
  const forged = JSON.parse(readFileSync(paths.stateFile, "utf8"));
  const forgedRunning = forged.tasks.find((t: { taskId: string }) => t.taskId === "s2");
  forgedRunning.state = "running";
  // 위조를 그 자체로는 유효한 v2로 만든다 → 남는 위반이 승인 세션 예산 초과 하나뿐이다.
  forgedRunning.execution.attemptNo = 1;
  forgedRunning.execution.attemptId = "att.forged";
  assert.equal(codeOf(() => validateRunState(forged)), "max_sessions_exceeded");
});

test("[M4c] 만료된 manifest는 모든 변경을 전이 0으로 거부한다(읽기는 가능)", () => {
  const ws = makeWorkspace();
  const paths = runPaths(ws, RUN_ID);
  let tick = 0;
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root", "later"], { expiresAt: "2026-07-27T00:00:05.000Z" }),
    clock: () => new Date(Date.UTC(2026, 6, 27, 0, 0, tick++)),
  });
  k.createRootTask(seed("root", "tech-lead"));
  tick = 60; // 만료 이후로 시계를 옮긴다
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  assert.equal(codeOf(() => k.createRootTask(seed("later", "pm"))), "manifest_expired");
  // 전진 작업은 전부 닫힌다: 단일 시작 경로의 preflight 커밋도 만료에서 거부된다(DECISIONS 2026-07-30).
  const batch = k.planRunnableBatch();
  assert.equal(
    codeOf(() =>
      k.commitPreflightBatch({
        baseRevision: batch.revision,
        actionId: nextAction(),
        decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared" as const, attemptId: nextAttempt() })),
      }),
    ),
    "manifest_expired",
  );
  assert.equal(codeOf(() => k.startTask("root")), "preflight_required");
  assert.equal(k.getState().revision, revBefore);
  assert.equal(dirFingerprint(paths.dir), filesBefore);
  // 읽기는 계속 된다.
  assert.equal(k.getTask("root")!.state, "ready");
  assert.equal(k.getManifest().expiresAt, "2026-07-27T00:00:05.000Z");
});

test("[M4c] 7 specialist registry: 상위 7종 + 하위 role 한 겹만, 그 밖은 unknown_role", () => {
  assert.deepEqual(
    SPECIALIST_ROLES.map((r) => r.roleId),
    ["research", "pm", "ux", "design", "tech-lead", "dev-lead", "qa-security"],
  );
  for (const r of SPECIALIST_ROLES) assert.equal(isRegistryRoleId(r.roleId), true, r.roleId);
  assert.equal(isRegistryRoleId("qa-security.fuzzing"), true);
  assert.equal(isRegistryRoleId("qa-security.a.b"), false, "하위 role은 한 겹뿐이다");
  assert.equal(isRegistryRoleId("marketing"), false);
  assert.equal(isRegistryRoleId("unknown.pm"), false);
  assert.equal(isRegistryRoleId("QA-SECURITY"), false);
  assert.equal(isRegistryRoleId(".pm"), false);
  assert.equal(isRegistryRoleId("pm."), false);

  const { k } = bootRoot(["sub", "bad-role"]);
  assert.equal(k.createRootTask(seed("sub", "qa-security.redteam")).roleId, "qa-security.redteam");
  assert.equal(codeOf(() => k.createRootTask(seed("bad-role", "marketing"))), "unknown_role");
  assert.equal(k.getTask("bad-role"), null);
});

test("[M4c] sibling 전달: 중앙이 관계를 검증하고 bounded summary + artifact 포인터만 옮긴다", () => {
  const { ws, k } = bootRouting();
  const marker = "RAW-SIBLING-BODY-MUST-NOT-BE-COPIED-91af";
  mkdirSync(join(ws, "src", "kid-a"), { recursive: true });
  writeFileSync(join(ws, "src", "kid-a", "out.md"), `# 산출물\n${marker}\n`);
  const pointer = k.registerArtifact({ taskId: "kid-a", path: "src/kid-a/out.md", role: "output" });

  const entry = k.submitStatusUpdate({
    envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "su-1", artifactRefs: [pointer] }),
    body: body("status_update"),
    summary: "kid-a 중간 산출물 공유",
    deliverTo: "kid-b",
  });
  assert.equal(entry.routeToTaskId, "kid-b");
  assert.equal(entry.acknowledgedAt, null);
  assert.equal(entry.sender, "dev-lead");
  assert.equal(entry.recipient, ORCHESTRATOR_ID, "sibling 전달도 중앙을 지나야 한다");
  assert.deepEqual(entry.artifactRefs, [pointer]);
  assert.deepEqual(k.listPendingInbox("kid-b").map((m) => m.messageId), ["su-1"]);
  assert.deepEqual(k.listPendingInbox("kid-a"), [], "발신자 inbox에 남지 않는다");
  assert.equal(k.getTask("kid-b")!.state, "running", "전달이 수신자 상태를 바꿨다");

  const paths = runPaths(ws, RUN_ID);
  const stateText = readFileSync(paths.stateFile, "utf8");
  const snapText = readFileSync(paths.snapshotFile, "utf8");
  assert.ok(!stateText.includes(marker), "state에 raw artifact 본문이 있다");
  assert.ok(!snapText.includes(marker), "snapshot에 raw artifact 본문이 있다");
  assert.ok(!stateText.includes("## Progress Since Last Update"), "state에 body 전문이 있다");
  assert.ok(snapText.includes("routedTo: kid-b ack=(pending)"), "snapshot에 route가 없다");
  assert.ok(snapText.includes("kid-a 중간 산출물 공유"), "snapshot에 bounded summary가 없다");
});

test("[M4c] 전달 거부: 무관·자기 자신·미상·모호·orchestrator·종료된 수신자 — 전이 0", () => {
  const { ws, k } = bootRouting();
  const paths = runPaths(ws, RUN_ID);
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);

  const deliver = (deliverTo: string, messageId = "su-x"): string =>
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId }),
        body: body("status_update"),
        summary: "전달 시도",
        deliverTo,
      }),
    );

  assert.equal(deliver("lonely"), "route_not_related", "무관한 task로 전달됐다");
  assert.equal(deliver("kid-a"), "route_self");
  assert.equal(deliver("ghost"), "unknown_recipient");
  assert.equal(deliver(ORCHESTRATOR_ID), "invalid_recipient");
  assert.equal(deliver("dev-lead"), "ambiguous_recipient", "같은 roleId 둘을 모호하게 받아들였다");
  assert.equal(deliver("Bad Id"), "invalid_id");
  assert.equal(k.getState().revision, revBefore, "거부가 revision을 올렸다");
  assert.equal(dirFingerprint(paths.dir), filesBefore, "거부가 파일을 바꿨다");

  // 유일한 roleId는 전달 대상으로 인정한다(reviewer는 kid-a에 의존 = 관계 있음).
  assert.equal(
    k.submitStatusUpdate({
      envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "su-role" }),
      body: body("status_update"),
      summary: "role로 지정한 유일 수신자",
      deliverTo: "qa-security",
    }).routeToTaskId,
    "reviewer",
  );

  // 종료된 task는 수신자가 될 수 없다.
  completeKidA(k);
  assert.equal(
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("status_update", "kid-b", "dev-lead", { messageId: "su-dead" }),
        body: body("status_update"),
        summary: "완료된 sibling에게",
        deliverTo: "kid-a",
      }),
    ),
    "recipient_unavailable",
  );
});

test("[M5b] C-16: taskId ↔ roleId 교차 namespace는 taskId를 조용히 고르지 않고 거부한다", () => {
  // 함정 배치: sibling child의 **taskId**가 "pm"이고, 무관한 root task의 **roleId**도 "pm"이다.
  // 이전 판은 taskId를 먼저 골라 **성공적으로 route를 남겼다**(kid-a와 sibling이므로 관계 검사도 통과).
  // 실제 inbox 소비가 생긴 M5b에서는 그 한 번의 추측이 bounded summary·artifact 포인터를 엉뚱한
  // 관련 task로 보내므로, 해석이 갈리면 거부한다.
  const ws = makeWorkspace();
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["parent", "helper", "qa-security"]),
    clock: fixedClock(),
  });
  k.createRootTask(seed("parent", "tech-lead", { ownership: ["src"] }));
  k.createRootTask(seed("helper", "pm")); // roleId = "pm"
  startVia(k, "parent");
  for (const kid of ["kid-a", "pm", "pm-x"]) {
    k.requestSpawn({
      envelope: envelope("spawn_request", "parent", "tech-lead", { messageId: `spawn-${kid}` }),
      body: body("spawn_request"),
      child: seed(kid, "dev-lead", { ownership: [`src/${kid}`] }), // taskId = "pm"
    });
  }
  startVia(k, "kid-a");
  const paths = runPaths(ws, RUN_ID);
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  const eventsBefore = readFileSync(paths.eventsFile, "utf8");

  assert.equal(
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "su-cross" }),
        body: body("status_update"),
        summary: "교차 namespace 전달 시도",
        deliverTo: "pm",
      }),
    ),
    "ambiguous_recipient",
  );
  assert.equal(k.getState().revision, revBefore, "실패한 라우팅이 revision을 올렸다");
  assert.equal(dirFingerprint(paths.dir), filesBefore, "실패한 라우팅이 파일(body 포함)을 바꿨다");
  assert.equal(readFileSync(paths.eventsFile, "utf8"), eventsBefore, "실패한 라우팅이 이벤트를 남겼다");
  assert.deepEqual(k.listPendingInbox("pm"), [], "거부됐는데 inbox에 남았다");
  assert.deepEqual(k.listPendingInbox("helper"), []);

  // 교차 충돌이 없는 taskId 지정은 그대로 동작한다(과잉 차단이 아니다).
  assert.equal(
    k.submitStatusUpdate({
      envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "su-ok" }),
      body: body("status_update"),
      summary: "충돌 없는 sibling 지정",
      deliverTo: "pm-x",
    }).routeToTaskId,
    "pm-x",
  );
  // 자기 taskId와 roleId가 같은 **한 task**는 해석이 하나라 충돌이 아니다.
  k.createDependentTask({ ...seed("qa-security", "qa-security"), dependsOn: ["kid-a"] });
  assert.equal(
    k.submitStatusUpdate({
      envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "su-self-named" }),
      body: body("status_update"),
      summary: "taskId와 roleId가 같은 단일 task",
      deliverTo: "qa-security",
    }).routeToTaskId,
    "qa-security",
  );
});

test("[M4c] pending inbox는 결정론적이고 재시작 후 같은 다음 전달을 준다 · ack는 좁은 전이", () => {
  const { ws, k } = bootRouting();
  for (const id of ["su-2", "su-1"]) {
    k.submitStatusUpdate({
      envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: id }),
      body: body("status_update"),
      summary: `${id} 요약`,
      deliverTo: "kid-b",
    });
  }
  const order = k.listPendingInbox("kid-b").map((m) => m.messageId);
  assert.equal(order.length, 2);
  assert.equal(k.nextPendingDelivery()!.messageId, order[0]);

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.deepEqual(reopened.listPendingInbox("kid-b").map((m) => m.messageId), order, "재시작 후 inbox 순서가 다르다");
  assert.equal(reopened.nextPendingDelivery()!.messageId, order[0], "재시작 후 다음 전달이 다르다");

  // ack: 수령한 것만 목록에서 빠지고 durable event가 남는다.
  const acked = ackVia(reopened, "kid-b", order[0]);
  assert.equal(acked.acknowledgedAt !== null, true);
  assert.deepEqual(reopened.listPendingInbox("kid-b").map((m) => m.messageId), order.slice(1));
  const events = readFileSync(runPaths(ws, RUN_ID).eventsFile, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  assert.equal(events[events.length - 1].type, "delivery_acknowledged");
  assert.equal(events[events.length - 1].messageId, order[0]);
  assert.equal(reopened.getTask("kid-b")!.state, "running", "ack가 task 상태를 바꿨다");

  assert.equal(
    codeOf(() => reopened.acknowledgeDelivery({ taskId: "kid-b", messageId: order[0] })),
    "delivery_already_acknowledged",
  );
  assert.equal(codeOf(() => reopened.acknowledgeDelivery({ taskId: "kid-a", messageId: order[1] })), "delivery_not_addressed");
  assert.equal(codeOf(() => reopened.acknowledgeDelivery({ taskId: "kid-b", messageId: "ghost" })), "unknown_message");

  // 재시작해도 수령 상태가 유지된다.
  const again = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.deepEqual(again.listPendingInbox("kid-b").map((m) => m.messageId), order.slice(1));
});

test("[M4c] reviewer 왕복: review_request → review_result → revision_request", () => {
  const { k } = bootRouting();
  completeKidA(k);
  assert.equal(k.getTask("reviewer")!.state, "ready");

  const req = k.requestReview({
    envelope: envelope("review_request", "reviewer", "qa-security", { messageId: "rev-req", dependsOn: ["kid-a"] }),
    body: body("review_request"),
    summary: "kid-a 산출물 검토 요청",
    subjectTaskId: "kid-a",
  });
  assert.equal(req.sender, ORCHESTRATOR_ID);
  assert.equal(req.recipient, "qa-security");
  assert.equal(req.routeToTaskId, "reviewer");
  assert.deepEqual(k.listPendingInbox("reviewer").map((m) => m.messageId), ["rev-req"]);

  // 전달 시도·수령은 **running turn 안에서** 일어난다(M5c 전달 계약).
  startVia(k, "reviewer");
  ackVia(k, "reviewer", "rev-req");
  const res = k.submitReviewResult({
    envelope: envelope("review_result", "reviewer", "qa-security", { messageId: "rev-res" }),
    body: body("review_result"),
    summary: "P1 1건 — revise",
  });
  assert.equal(res.routeToTaskId, null, "review_result는 중앙에서 끝난다");
  assert.equal(res.recipient, ORCHESTRATOR_ID);
  assert.equal(k.getTask("reviewer")!.state, "running", "review_result가 상태를 바꿨다");

  const fix = k.requestRevision({
    envelope: envelope("revision_request", "fixer", "dev-lead.fix", { messageId: "fix-req", dependsOn: ["kid-a"] }),
    body: body("revision_request"),
    summary: "P1 1건 수정",
    subjectTaskId: "kid-a",
  });
  assert.equal(fix.routeToTaskId, "fixer");
  assert.deepEqual(k.listPendingInbox("fixer").map((m) => m.messageId), ["fix-req"]);
});

test("[M4c] reviewer 게이트: fresh 아님 · 무관 · 미완료 대상 · 리뷰 없는 수정 지시 거부", () => {
  const { ws, k } = bootRouting();
  const paths = runPaths(ws, RUN_ID);

  const review = (over: EnvOverrides, subjectTaskId: string): string =>
    codeOf(() =>
      k.requestReview({
        envelope: envelope("review_request", "reviewer", "qa-security", { messageId: "rr", dependsOn: ["kid-a"], ...over }),
        body: body("review_request"),
        summary: "검토 요청",
        subjectTaskId,
      }),
    );

  // kid-a가 아직 completed가 아니다.
  assert.equal(review({}, "kid-a"), "subject_not_completed");
  completeKidA(k);
  // 의존 관계가 없는 대상에는 지시하지 않는다(kid-b도 완료시켜 "미완료" 사유를 배제한 뒤 확인).
  cleanVia(k, "kid-b");
  k.submitResult({
    envelope: kidEnvelope("result", "kid-b", "dev-lead", { messageId: "res-kid-b" }),
    body: body("result"),
    summary: "kid-b 완료",
  });
  assert.equal(review({ messageId: "rr2" }, "kid-b"), "route_not_related");
  assert.equal(review({ messageId: "rr3" }, "reviewer"), "route_self");
  assert.equal(review({ messageId: "rr4" }, "ghost"), "unknown_task");

  // review_request 없이 review_result를 낼 수 없다.
  startVia(k, "reviewer");
  assert.equal(
    codeOf(() =>
      k.submitReviewResult({
        envelope: envelope("review_result", "reviewer", "qa-security", { messageId: "rr-res" }),
        body: body("review_result"),
        summary: "무단 리뷰 결과",
      }),
    ),
    "review_request_missing",
  );
  // 이미 시작된(= fresh 아님) reviewer에게는 새 review_request를 보내지 않는다.
  assert.equal(review({ messageId: "rr5" }, "kid-a"), "task_not_fresh");

  // review_result 없이 revision_request를 낼 수 없다.
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  assert.equal(
    codeOf(() =>
      k.requestRevision({
        envelope: envelope("revision_request", "fixer", "dev-lead.fix", { messageId: "fr", dependsOn: ["kid-a"] }),
        body: body("revision_request"),
        summary: "리뷰 없는 수정 지시",
        subjectTaskId: "kid-a",
      }),
    ),
    "review_result_missing",
  );
  assert.equal(k.getState().revision, revBefore);
  assert.equal(dirFingerprint(paths.dir), filesBefore);
});

test("[M4c] decision 왕복: decision_request → 중앙 → decision, 요청 없는 결정은 거부", () => {
  const { k } = bootRouting();
  assert.equal(
    codeOf(() =>
      k.recordDecision({
        envelope: kidEnvelope("decision", "kid-a", "dev-lead", { messageId: "dec-0" }),
        body: body("decision"),
        summary: "요청 없는 결정",
      }),
    ),
    "decision_request_missing",
  );

  const req = k.submitDecisionRequest({
    envelope: kidEnvelope("decision_request", "kid-a", "dev-lead", { messageId: "dreq-1" }),
    body: body("decision_request"),
    summary: "계약 변경 여부 결정 필요",
  });
  assert.equal(req.routeToTaskId, null);
  assert.equal(req.recipient, ORCHESTRATOR_ID);
  assert.equal(k.getTask("kid-a")!.state, "running", "decision_request가 상태를 바꿨다");

  const dec = k.recordDecision({
    envelope: kidEnvelope("decision", "kid-a", "dev-lead", { messageId: "dec-1" }),
    body: body("decision"),
    summary: "현행 계약 유지",
  });
  assert.equal(dec.sender, ORCHESTRATOR_ID);
  assert.equal(dec.recipient, "dev-lead");
  assert.equal(dec.routeToTaskId, "kid-a");
  assert.deepEqual(k.listPendingInbox("kid-a").map((m) => m.messageId), ["dec-1"]);

  // 두 번째 결정은 새 요청 없이는 못 낸다.
  assert.equal(
    codeOf(() =>
      k.recordDecision({
        envelope: kidEnvelope("decision", "kid-a", "dev-lead", { messageId: "dec-2" }),
        body: body("decision"),
        summary: "중복 결정",
      }),
    ),
    "decision_request_missing",
  );
});

test("[M4c] 라우팅 진입점은 타입·방향·summary 계약을 강제한다", () => {
  const { k } = bootRouting();
  completeKidA(k); // review 게이트를 통과시켜 **방향** 계약만 남긴다
  assert.equal(
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("blocker", "kid-a", "dev-lead", { messageId: "x1" }),
        body: body("blocker"),
        summary: "s",
      }),
    ),
    "message_type_mismatch",
  );
  // 중앙 타입을 agent 방향으로 위조할 수 없다.
  assert.equal(
    codeOf(() =>
      k.requestReview({
        envelope: envelope("review_request", "reviewer", "qa-security", {
          messageId: "x2",
          sender: "qa-security",
          recipient: ORCHESTRATOR_ID,
        }),
        body: body("review_request"),
        summary: "s",
        subjectTaskId: "kid-a",
      }),
    ),
    "invalid_direction",
  );
  // agent 타입을 중앙 방향으로 위조할 수 없다.
  assert.equal(
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("status_update", "kid-b", "dev-lead", { messageId: "x3", sender: ORCHESTRATOR_ID }),
        body: body("status_update"),
        summary: "s",
      }),
    ),
    "invalid_direction",
  );
  // summary는 bounded이고 비어 있을 수 없다.
  assert.equal(
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "x4" }),
        body: body("status_update"),
        summary: "",
      }),
    ),
    "invalid_text",
  );
  assert.equal(
    codeOf(() =>
      k.submitStatusUpdate({
        envelope: kidEnvelope("status_update", "kid-a", "dev-lead", { messageId: "x5" }),
        body: body("status_update"),
        summary: "x".repeat(LIMITS.maxSummaryLength + 1),
      }),
    ),
    "text_too_long",
  );
  // task_assignment는 summary를 갖지 않는다(load 쪽 대칭 검사와 같은 계약).
  assert.equal(k.getState().messages.find((m) => m.type === "task_assignment")!.summary, null);
});

test("[M4c] milestone_approval_manifest.schema.json이 runtime 계약과 동치다", () => {
  const s = readSchema("milestone_approval_manifest.schema.json");
  assert.deepEqual(s.required, [...MANIFEST_KEYS]);
  assert.deepEqual(Object.keys(s.properties).sort(), [...MANIFEST_KEYS].sort());
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.approvedCommit.pattern, COMMIT_PATTERN);
  assert.equal(s.properties.writableRoots.maxItems, LIMITS.maxWritableRoots);
  assert.equal(s.properties.allowedCommands.maxItems, LIMITS.maxAllowedCommands);
  assert.equal(s.properties.allowedCommands.items.pattern, COMMAND_PATTERN);
  assert.equal(s.properties.allowedCommands.items.maxLength, LIMITS.maxCommandLength);
  assert.equal(s.properties.allowedDependencies.maxItems, LIMITS.maxAllowedDependencies);
  assert.deepEqual(s.properties.allowedDependencies.items.required, [...DEPENDENCY_KEYS]);
  assert.equal(s.properties.allowedDependencies.items.additionalProperties, false);
  assert.equal(s.properties.allowedDependencies.items.properties.name.pattern, DEPENDENCY_NAME_PATTERN);
  assert.equal(s.properties.allowedDependencies.items.properties.version.pattern, DEPENDENCY_VERSION_PATTERN);
  // 6차 리뷰 A1 — 승인된 실행 권위도 계약 문서와 런타임 validator가 같은 집합이어야 한다.
  assert.deepEqual(s.properties.executionAuthority.required, [...EXECUTION_AUTHORITY_KEYS]);
  assert.equal(s.properties.executionAuthority.additionalProperties, false);
  assert.deepEqual(Object.keys(s.properties.executionAuthority.properties).sort(), [...EXECUTION_AUTHORITY_KEYS].sort());
  // M5c — `codex`만 nullable이고 git·node·processObserver는 승인된 실행 파일이어야 한다(양쪽 동치).
  assert.deepEqual(
    s.properties.executionAuthority.properties.codex.oneOf.map((x: any) => x.$ref ?? x.type),
    ["#/definitions/approvedExecutable", "null"],
  );
  for (const key of ["git", "node", "processObserver"]) {
    assert.equal(s.properties.executionAuthority.properties[key].$ref, "#/definitions/approvedExecutable", key);
  }
  assert.equal(
    validateApprovalManifest(manifestFor(["root"], { executionAuthority: { ...EXECUTION_AUTHORITY, codex: null } })).executionAuthority.codex,
    null,
    "offline manifest는 codex를 null로 승인할 수 있어야 한다",
  );
  for (const key of ["git", "node", "processObserver"] as const) {
    assert.equal(
      codeOf(() =>
        validateApprovalManifest(manifestFor(["root"], { executionAuthority: { ...EXECUTION_AUTHORITY, [key]: null } })),
      ),
      "invalid_manifest",
      `${key}는 null이 될 수 없다`,
    );
  }
  assert.deepEqual(s.definitions.approvedExecutable.required, [...APPROVED_EXECUTABLE_KEYS]);
  assert.equal(s.definitions.approvedExecutable.additionalProperties, false);
  assert.equal(s.definitions.approvedExecutable.properties.sha256.pattern, SHA256_PATTERN);
  assert.equal(s.definitions.approvedExecutable.properties.path.maxLength, LIMITS.maxPathLength);
  // 7차 리뷰 C-40 — 경로 정규형은 **정본 하나**를 공유한다(이전 schema regex는 `/a//b`·`/a/./b`·
  // `/a/../b`를 통과시켰다). 형태 동치를 pattern 항등 + **양/음성 표 전수**로 증명한다.
  assert.equal(s.definitions.approvedExecutable.properties.path.pattern, APPROVED_PATH_PATTERN);
  const pathRe = new RegExp(s.definitions.approvedExecutable.properties.path.pattern);
  const manifestWithGitPath = (p: string) =>
    manifestFor(["root"], { executionAuthority: { ...EXECUTION_AUTHORITY, git: { path: p, sha256: "d".repeat(64) } } });
  const NUL = String.fromCharCode(0);
  const good = ["/usr/bin/git", "/opt/harness/codex", "/a", "/a/b/c", "/a.b/..c/d...", "/a b/c-d_e", "/.a/b"];
  const bad = [
    "", "/", "//", "///", "a", "a/b", "./a", "../a", "/a/", "/.", "/..", "/./", "/../",
    "/a//b", "/a/./b", "/a/../b", "/a/b/", `/a${NUL}b`, NUL, "/a/b/..", "/a/b/.",
  ];
  for (const p of good) {
    assert.equal(pathRe.test(p), true, `schema가 정규 경로를 거부한다: ${JSON.stringify(p)}`);
    assert.equal(
      validateApprovalManifest(manifestWithGitPath(p)).executionAuthority.git.path,
      p,
      `runtime이 정규 경로를 거부한다: ${JSON.stringify(p)}`,
    );
  }
  for (const p of bad) {
    assert.equal(pathRe.test(p), false, `schema가 비정규 경로를 통과시킨다: ${JSON.stringify(p)}`);
    assert.equal(
      codeOf(() => validateApprovalManifest(manifestWithGitPath(p))),
      "invalid_manifest",
      `runtime이 비정규 경로를 통과시킨다: ${JSON.stringify(p)}`,
    );
  }
  // 길이 상한도 양쪽이 같은 자리에서 자른다(regex는 길이를 보지 않는다 — schema maxLength / runtime LIMITS).
  const tooLong = `/${"a".repeat(LIMITS.maxPathLength)}`;
  assert.equal(pathRe.test(tooLong), true, "길이 판정은 regex가 아니라 maxLength 몫이다");
  assert.equal(tooLong.length > LIMITS.maxPathLength, true);
  assert.equal(codeOf(() => validateApprovalManifest(manifestWithGitPath(tooLong))), "invalid_manifest");
  assert.equal(s.properties.allowedNetworkDomains.maxItems, LIMITS.maxAllowedNetworkDomains);
  assert.equal(s.properties.allowedNetworkDomains.items.pattern, DOMAIN_PATTERN);
  assert.equal(s.properties.allowedNetworkDomains.items.maxLength, LIMITS.maxDomainLength);
  assert.equal(s.properties.maxSessions.maximum, LIMITS.maxManifestSessions);
  assert.equal(s.properties.maxTokens.oneOf[0].maximum, LIMITS.maxManifestTokens);
  assert.equal(s.properties.maxElapsedMs.maximum, LIMITS.maxManifestElapsedMs);
  assert.equal(s.properties.ownershipByTask.maxProperties, LIMITS.maxTasksPerRun);
  assert.equal(s.properties.ownershipByTask.additionalProperties.maxItems, LIMITS.maxOwnershipPaths);
  assert.equal(s.definitions.slug.pattern, SLUG_PATTERN);
  assert.equal(s.definitions.timestamp.pattern, TIMESTAMP_PATTERN);
  assert.deepEqual(s.definitions.specialistRegistry.const, SPECIALIST_ROLES.map((r) => r.roleId));

  // ── M5c v2: autopilot 정책과 typed operation 권위도 **정확히** 같아야 한다 ──

  const ap2 = s.properties.autopilotPolicy;
  assert.deepEqual(ap2.required, [...AUTOPILOT_POLICY_KEYS]);
  assert.deepEqual(Object.keys(ap2.properties).sort(), [...AUTOPILOT_POLICY_KEYS].sort());
  assert.equal(ap2.additionalProperties, false);
  // 상한·하한은 runtime validator(validateAutopilotPolicy)와 같은 값이어야 한다.
  const policyBounds: Record<string, [number, number]> = {
    maxTaskAttempts: [1, LIMITS.maxTaskAttempts],
    maxDeliveryAttempts: [1, LIMITS.maxDeliveryAttempts],
    retryBackoffMs: [0, 60_000],
    deliveryDeadlineMs: [1_000, 3_600_000],
    maxNoProgressMs: [1_000, 900_000],
    maxAttemptElapsedMs: [1_000, 3_600_000],
    cleanupTermGraceMs: [100, 30_000],
    cleanupKillGraceMs: [100, 30_000],
  };
  for (const [key, [min, max]] of Object.entries(policyBounds)) {
    assert.equal(ap2.properties[key].minimum, min, `${key} 하한`);
    assert.equal(ap2.properties[key].maximum, max, `${key} 상한`);
    assert.equal(ap2.properties[key].type, "integer", `${key} 타입`);
    // 경계 밖 값은 runtime도 거부한다(공허하지 않다는 증거).
    for (const bad of [min - 1, max + 1]) {
      assert.equal(
        codeOf(() =>
          validateApprovalManifest(manifestFor(["root"], { autopilotPolicy: { ...AUTOPILOT_POLICY, [key]: bad } })),
        ),
        "invalid_manifest",
        `${key}=${bad}가 통과했다`,
      );
    }
  }
  // maxAttemptElapsedMs <= maxElapsedMs 교차 규칙(schema로는 표현하지 않고 runtime이 강제한다).
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], { maxElapsedMs: 60_000, autopilotPolicy: { ...AUTOPILOT_POLICY, maxAttemptElapsedMs: 600_000 } }),
      ),
    ),
    "invalid_manifest",
  );

  const oa = s.properties.operationAuthorityByTask;
  assert.equal(oa.maxProperties, LIMITS.maxTasksPerRun);
  assert.equal(oa.additionalProperties.maxItems, LIMITS.maxOperationAuthorities);
  assert.equal(oa.additionalProperties.items.$ref, "#/definitions/approvedOperation");
  const [wf, rp] = s.definitions.approvedOperation.oneOf.map((x: any) => s.definitions[x.$ref.split("/").pop()]);
  assert.deepEqual(wf.required, [...WRITE_FILE_AUTHORITY_KEYS]);
  assert.deepEqual(Object.keys(wf.properties).sort(), [...WRITE_FILE_AUTHORITY_KEYS].sort());
  assert.equal(wf.additionalProperties, false);
  assert.equal(wf.properties.kind.const, "write_file");
  assert.equal(wf.properties.maxBytes.maximum, LIMITS.maxWriteBytes);
  assert.equal(wf.properties.maxBytes.minimum, 1);
  assert.deepEqual(rp.required, [...RUN_PROCESS_AUTHORITY_KEYS]);
  assert.deepEqual(Object.keys(rp.properties).sort(), [...RUN_PROCESS_AUTHORITY_KEYS].sort());
  assert.equal(rp.additionalProperties, false);
  assert.equal(rp.properties.kind.const, "run_process");
  assert.equal(rp.properties.args.maxItems, LIMITS.maxOperationArgs);
  assert.equal(rp.properties.args.items.maxLength, LIMITS.maxOperationArgLength);
  assert.equal(rp.properties.timeoutMs.minimum, 100);
  assert.equal(rp.properties.timeoutMs.maximum, 3_600_000);
  // shell·network 같은 계약 밖 변종은 **표현할 타입이 없다**: 양쪽이 같은 자리에서 거부한다.
  assert.deepEqual(s.definitions.approvedOperation.oneOf.length, 2, "typed operation union이 열렸다");
  assert.equal(
    codeOf(() =>
      validateApprovalManifest(
        manifestFor(["root"], {
          operationAuthorityByTask: { root: [{ authorityId: "x", kind: "network_fetch", url: "https://example.com" }] },
        }),
      ),
    ),
    "invalid_manifest",
  );

  // 미상 최상위 key는 계약 문서·runtime 둘 다 거부한다(닫힌 key 집합).
  assert.equal(codeOf(() => validateApprovalManifest(manifestFor(["root"], { extraField: 1 }))), "invalid_manifest");
  // v1 manifest는 마이그레이션·기본값 없이 안정 코드로 닫힌다.
  const v1 = manifestFor(["root"]) as Record<string, unknown>;
  delete v1.autopilotPolicy;
  assert.equal(codeOf(() => validateApprovalManifest(v1)), "manifest_pre_m5c_unsupported");
  const v1Authority = manifestFor(["root"], {
    executionAuthority: { codex: EXECUTION_AUTHORITY.codex, git: EXECUTION_AUTHORITY.git },
  });
  assert.equal(codeOf(() => validateApprovalManifest(v1Authority)), "manifest_pre_m5c_unsupported");

  // run state schema도 M4c 계약과 맞물려 있어야 한다.
  const rs = readSchema("orchestration_run_state.schema.json");
  assert.ok(rs.required.includes("manifest"));
  assert.equal(rs.properties.manifest.$ref, s.$id);
  assert.deepEqual(rs.definitions.messageType.enum, [...AGENT_MESSAGE_TYPES]);
  assert.deepEqual(rs.definitions.event.properties.type.enum, [...EVENT_TYPES]);
  assert.equal(rs.definitions.task.properties.roleId.$ref, "#/definitions/specialistRoleId");
  for (const roleId of [...SPECIALIST_ROLES.map((r) => r.roleId), "qa-security.fuzzing"]) {
    assert.ok(new RegExp(rs.definitions.specialistRoleId.pattern).test(roleId), roleId);
  }
  for (const bad of ["marketing", "qa-security.a.b", "unknown.pm"]) {
    assert.equal(new RegExp(rs.definitions.specialistRoleId.pattern).test(bad), false, bad);
  }
});
