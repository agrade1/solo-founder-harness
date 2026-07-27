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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_MESSAGE_TYPES,
  ARTIFACT_ROLES,
  CENTRAL_MESSAGE_TYPES,
  EVENT_TYPES,
  LIMITS,
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
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { ARTIFACT_POINTER_KEYS, ENVELOPE_KEYS, validateEnvelope, validateMessageBody } from "./agentMessage.js";
import {
  COMMAND_PATTERN,
  COMMIT_PATTERN,
  DEPENDENCY_KEYS,
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
} from "./approvalManifest.js";
import {
  ARTIFACT_RECORD_KEYS,
  EVENT_KEYS,
  MESSAGE_KEYS,
  STATE_KEYS,
  TASK_KEYS,
  acquireRunWriterLock,
  assertExclusiveResourceClaims,
  assertNoDependencyCycle,
  commitRun,
  releaseRunWriterLock,
  runPaths,
  stateContentDigest,
  validateRunState,
} from "./orchestrationStore.js";
import { OrchestrationKernel, createOrchestrationRun, openOrchestrationRun } from "./orchestrationKernel.js";

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

/** root 하나를 running까지 올린 kernel. `extra`는 그 run이 추가로 만들 root/dependent task id다. */
function bootRoot(extra: string[] = [], ws = makeWorkspace()): { ws: string; k: OrchestrationKernel } {
  const k = createOrchestrationRun({
    workspaceRoot: ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    manifest: manifestFor(["root", ...extra]),
    clock: fixedClock(),
  });
  k.createRootTask(seed("root", "tech-lead"));
  k.startTask("root");
  return { ws, k };
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
    k.startTask(child);
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

  k.startTask("child");
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
  k.startTask("child");
  k.requestSpawn({
    envelope: envelope("spawn_request", "child", "dev-lead", { messageId: "spawn-2", parentTaskId: "root" }),
    body: body("spawn_request"),
    child: seed("grandchild", "dev-lead.sub", { ownership: ["src/root"] }),
  });
  k.createDependentTask({ ...seed("dependent", "qa-security"), dependsOn: ["grandchild"] });
  k.startTask("grandchild");

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
  k.startTask("c1");
  k.submitResult({
    envelope: envelope("result", "c1", "dev-lead", { messageId: "res-c1", parentTaskId: "root" }),
    body: body("result"),
    summary: "c1 완료",
  });
  k.startTask("c2");
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
  assert.equal(codeOf(() => k.startTask("b")), "invalid_transition"); // pending
  k.startTask("a");
  assert.equal(codeOf(() => k.startTask("a")), "invalid_transition"); // running
  assert.equal(codeOf(() => k.startTask("nope")), "unknown_task");
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
  const { k } = bootRoot();
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
    child: seed("child", "dev-lead", { ownership: ["src/root"] }),
  });
  k.createDependentTask({ ...seed("dependent", "qa-security"), dependsOn: ["child"] });
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  k.startTask("child");
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
  assert.deepEqual(k.getTask("root")!.ownership, ["src/root"]);
});

test("[M4a] kernel 공개 API는 좁은 목록뿐 — agent가 상태를 직접 바꿀 진입점이 없다", () => {
  const actual = Object.getOwnPropertyNames(OrchestrationKernel.prototype).sort();
  assert.deepEqual(actual, [
    "acknowledgeDelivery",
    "constructor",
    "createDependentTask",
    "createRootTask",
    "getArtifact",
    "getManifest",
    "getMessage",
    "getState",
    "getTask",
    "listPendingInbox",
    "listReady",
    "nextPendingDelivery",
    "rebuildSnapshot",
    "recordDecision",
    "registerArtifact",
    "requestReview",
    "requestRevision",
    "requestSpawn",
    "scheduleReady",
    "startScheduledBatch",
    "startTask",
    "submitBlocker",
    "submitDecisionRequest",
    "submitResult",
    "submitReviewResult",
    "submitStatusUpdate",
  ]);
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
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID })), "state_unparsable");

  writeFileSync(paths.stateFile, JSON.stringify({ ...JSON.parse(original), sneaky: true }));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID })), "invalid_state");

  writeFileSync(paths.stateFile, JSON.stringify({ ...JSON.parse(original), runId: "other-run" }));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID })), "run_id_mismatch");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws2, runId: RUN_ID }));
});

test("[M4a] load fail-closed: event 개수·체인·미지 필드 변조", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const originalEvents = readFileSync(paths.eventsFile, "utf8");
  const lines = originalEvents.split("\n").filter((l) => l.length > 0);

  writeFileSync(paths.eventsFile, `${lines.slice(0, -1).join("\n")}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "event_count_mismatch");

  const tampered = JSON.parse(lines[lines.length - 1]);
  tampered.reason = "created";
  writeFileSync(paths.eventsFile, `${[...lines.slice(0, -1), JSON.stringify(tampered)].join("\n")}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "event_chain_broken");

  const midTampered = JSON.parse(lines[0]);
  midTampered.at = "2030-01-01T00:00:00.000Z";
  writeFileSync(paths.eventsFile, `${[JSON.stringify(midTampered), ...lines.slice(1)].join("\n")}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "event_chain_broken");

  writeFileSync(paths.eventsFile, `${lines.join("\n")}\nnot-json\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "event_count_mismatch");

  writeFileSync(paths.eventsFile, originalEvents);
  appendFileSync(paths.eventsFile, "");
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
});

test("[M4a] load fail-closed: message body 변조·삭제·symlink", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const bodyFile = join(paths.messagesDir, "asg-root.md");
  const originalBody = readFileSync(bodyFile, "utf8");

  writeFileSync(bodyFile, `${originalBody}\n`);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "message_body_hash_mismatch");

  rmSync(bodyFile);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "message_body_missing");

  const decoy = join(paths.dir, "decoy.md");
  writeFileSync(decoy, originalBody);
  symlinkSync(decoy, bodyFile);
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "message_body_not_regular_file");

  rmSync(bodyFile);
  writeFileSync(bodyFile, originalBody);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
});

test("[M4a] load fail-closed: 등록된 artifact가 사라지거나 변조되면 열리지 않는다", () => {
  const { ws, k } = bootRoot();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "output" });
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));

  writeFileSync(join(ws, "docs", "a.md"), "tampered\n");
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "artifact_hash_mismatch");

  rmSync(join(ws, "docs", "a.md"));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "artifact_missing");

  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
});

test("[M4a][P0-1] 문법적으로 유효한 state 편집은 kernel 우회에 실패한다(state↔event binding)", () => {
  const { ws, k } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const original = readFileSync(paths.stateFile, "utf8");
  assert.equal(k.getTask("root")!.state, "running");

  // Codex 재현 시나리오: run_state.json만 고쳐 완료를 위조한다.
  const forged = JSON.parse(original);
  forged.tasks[0].state = "completed";
  forged.tasks[0].resultSummary = "forged";
  writeFileSync(paths.stateFile, JSON.stringify(forged, null, 2));
  assert.equal(
    codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })),
    "state_event_binding_mismatch",
  );

  // 개별 허용 필드 하나만 건드려도 동일하게 거부된다.
  for (const mutate of [
    (s: any) => (s.tasks[0].state = "completed"),
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
    const code = codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
    assert.ok(
      // 전부 fail-closed 거부다. milestone·승인 범위 위조는 binding보다 **먼저** manifest 검사에 걸린다.
      // 전부 거부 코드다. task_assignment에 summary를 끼워 넣는 위조는 M4c의 summary 계약(invalid_state)에,
      // milestone·승인 범위 위조는 manifest 검사에 **binding보다 먼저** 걸린다.
      [
        "state_event_binding_mismatch",
        "run_id_mismatch",
        "manifest_milestone_mismatch",
        "ownership_outside_writable_root",
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
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
  assert.equal(openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }).getTask("root")!.state, "running");
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
  assert.equal(withDigest, 3, "커밋 3건(run_created/createRootTask/startTask)만 digest를 남겨야 한다");
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
});

test("[M4a] 실제로 생성된 state가 schema의 required/enum 범위 안에 있다", () => {
  const { ws, k } = bootRoot();
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "docs", "a.md"), "v1\n");
  const p = k.registerArtifact({ taskId: "root", path: "docs/a.md", role: "evidence" });
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

  assert.deepEqual(k.startScheduledBatch().map((t) => t.taskId), ["a-stress", "c-docs"]);
  assert.equal(k.getTask("a-stress")!.state, "running");
  assert.equal(k.getTask("c-docs")!.state, "running");
  assert.equal(k.getTask("b-live")!.state, "ready", "같은 class 두 task가 동시에 running이 됐다");
  // class가 점유된 동안에는 더 고를 것이 없다.
  assert.deepEqual(k.scheduleReady(), []);
  assert.deepEqual(k.startScheduledBatch(), []);
});

test("[M4b] batch는 커밋 1회다 · limit 검증 · limit는 앞에서부터 자른다", () => {
  const { k } = bootResourceRun();
  const before = k.getState().revision;
  assert.equal(k.startScheduledBatch().length, 2);
  assert.equal(k.getState().revision, before + 1, "batch가 커밋을 여러 번 했다");

  assert.equal(codeOf(() => k.scheduleReady(0)), "invalid_batch_limit");
  assert.equal(codeOf(() => k.scheduleReady(LIMITS.maxScheduleBatch + 1)), "invalid_batch_limit");
  assert.equal(codeOf(() => k.scheduleReady(1.5)), "invalid_batch_limit");
  assert.equal(codeOf(() => k.startScheduledBatch(0)), "invalid_batch_limit");

  const { k: k2 } = bootResourceRun();
  assert.deepEqual(k2.scheduleReady(1).map((t) => t.taskId), ["a-stress"]);
  assert.deepEqual(k2.startScheduledBatch(1).map((t) => t.taskId), ["a-stress"]);
  assert.deepEqual(k2.scheduleReady().map((t) => t.taskId), ["c-docs"]);
});

test("[M4b] 직접 startTask도 같은 충돌 규칙을 받는다 — scheduler 우회 불가, 전이 0", () => {
  const { ws, k } = bootResourceRun();
  const paths = runPaths(ws, RUN_ID);
  k.startTask("a-stress");

  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  assert.equal(codeOf(() => k.startTask("b-live")), "resource_conflict");
  assert.equal(k.getState().revision, revBefore, "거부된 start가 revision을 올렸다");
  assert.equal(dirFingerprint(paths.dir), filesBefore, "거부된 start가 파일을 바꿨다");
  assert.equal(k.getTask("b-live")!.state, "ready");

  // 자원을 요구하지 않는 task는 영향받지 않는다.
  k.startTask("c-docs");
  assert.equal(k.getTask("c-docs")!.state, "running");
});

test("[M4b] 점유는 running 동안만 — waiting_children은 자원을 들고 있지 않는다", () => {
  const { k } = bootResourceRun();
  k.startTask("a-stress");
  k.requestSpawn({
    envelope: envelope("spawn_request", "a-stress", "qa-security", { messageId: "spawn-1" }),
    body: body("spawn_request"),
    child: seed("child", "dev-lead", { ownership: ["src/a-stress"] }),
  });
  assert.equal(k.getTask("a-stress")!.state, "waiting_children");
  // 중단된 parent는 점유하지 않으므로 같은 class의 b-live를 고를 수 있다.
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["b-live", "c-docs", "child"]);
  k.startTask("b-live");
  assert.equal(k.getTask("b-live")!.state, "running");
});

test("[M4b] holder가 완료되면 class가 풀리고 대기 task가 schedulable해진다", () => {
  const { k } = bootResourceRun();
  k.startScheduledBatch(1); // a-stress만 시작
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["c-docs"]);

  k.submitResult({
    envelope: envelope("result", "a-stress", "qa-security", { messageId: "res-a" }),
    body: body("result"),
    summary: "a-stress 완료 — suite-lock 해제",
  });
  assert.equal(k.getTask("a-stress")!.state, "completed");
  assert.deepEqual(k.scheduleReady().map((t) => t.taskId), ["b-live", "c-docs"]);
  assert.deepEqual(k.startScheduledBatch().map((t) => t.taskId), ["b-live", "c-docs"]);
});

test("[M4b] 재시작: durable state만으로 같은 점유·같은 schedule 결정", () => {
  const { ws, k } = bootResourceRun();
  k.startTask("a-stress");
  const scheduleBefore = k.scheduleReady().map((t) => t.taskId);

  const reopened = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: fixedClock() });
  assert.equal(reopened.getTask("a-stress")!.state, "running");
  assert.deepEqual(reopened.getTask("a-stress")!.resourceClasses, ["suite-lock"]);
  assert.deepEqual(reopened.scheduleReady().map((t) => t.taskId), scheduleBefore);
  assert.equal(codeOf(() => reopened.startTask("b-live")), "resource_conflict");
});

test("[M4b] state 위조: resourceClasses 편집은 state↔event binding으로 거부된다", () => {
  const { ws, k } = bootResourceRun();
  const paths = runPaths(ws, RUN_ID);
  k.startTask("a-stress");
  const original = readFileSync(paths.stateFile, "utf8");

  const forged = JSON.parse(original);
  forged.tasks.find((t: { taskId: string }) => t.taskId === "b-live").resourceClasses = [];
  writeFileSync(paths.stateFile, JSON.stringify(forged, null, 2));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "state_event_binding_mismatch");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
});

test("[M4b] M4a state(resourceClasses 없음)는 마이그레이션 없이 거부한다", () => {
  const { ws } = bootRoot();
  const paths = runPaths(ws, RUN_ID);
  const original = readFileSync(paths.stateFile, "utf8");
  const pre = JSON.parse(original);
  for (const t of pre.tasks) delete t.resourceClasses;
  writeFileSync(paths.stateFile, JSON.stringify(pre, null, 2));
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "state_pre_m4b_unsupported");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
});

test("[M4b] running 둘이 같은 class를 든 state는 커밋·load 양쪽에서 거부된다", () => {
  const { ws, k } = bootResourceRun();
  k.startTask("a-stress");
  const onDisk = JSON.parse(readFileSync(runPaths(ws, RUN_ID).stateFile, "utf8"));
  onDisk.tasks.find((t: { taskId: string }) => t.taskId === "b-live").state = "running";
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
  k.startTask("parent");
  for (const kid of ["kid-a", "kid-b"]) {
    k.requestSpawn({
      envelope: envelope("spawn_request", "parent", "tech-lead", { messageId: `spawn-${kid}` }),
      body: body("spawn_request"),
      child: seed(kid, "dev-lead", { ownership: [`src/${kid}`] }),
    });
  }
  k.createDependentTask({ ...seed("reviewer", "qa-security"), dependsOn: ["kid-a"] });
  k.createDependentTask({ ...seed("fixer", "dev-lead.fix"), dependsOn: ["kid-a"] });
  k.startTask("kid-a");
  k.startTask("kid-b");
  return { ws, k };
}

/** child task가 중앙에 내는 envelope(parentTaskId는 state와 일치해야 한다). */
function kidEnvelope(type: AgentMessageType, taskId: string, roleId: string, over: EnvOverrides = {}): EnvOverrides {
  return envelope(type, taskId, roleId, { parentTaskId: "parent", ...over });
}

/** kid-a를 완료시켜 reviewer/fixer를 ready로 만든다. */
function completeKidA(k: OrchestrationKernel): void {
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
  assert.equal(codeOf(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID })), "state_pre_m4c_unsupported");

  writeFileSync(paths.stateFile, original);
  assert.doesNotThrow(() => openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID }));
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
  k.startTask("approved");
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

  k.startTask("s1");
  const revBefore = k.getState().revision;
  const filesBefore = dirFingerprint(paths.dir);
  assert.equal(codeOf(() => k.startTask("s2")), "max_sessions_exceeded");
  assert.equal(k.getState().revision, revBefore);
  assert.equal(dirFingerprint(paths.dir), filesBefore);
  assert.deepEqual(k.scheduleReady(), []);
  assert.deepEqual(k.startScheduledBatch(), []);

  // 손으로 running 둘을 만든 state도 load에서 거부된다(같은 불변식).
  const forged = JSON.parse(readFileSync(paths.stateFile, "utf8"));
  forged.tasks.find((t: { taskId: string }) => t.taskId === "s2").state = "running";
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
  assert.equal(codeOf(() => k.startTask("root")), "manifest_expired");
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
  const acked = reopened.acknowledgeDelivery({ taskId: "kid-b", messageId: order[0] });
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

  k.acknowledgeDelivery({ taskId: "reviewer", messageId: "rev-req" });
  k.startTask("reviewer");
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
  k.submitResult({
    envelope: kidEnvelope("result", "kid-b", "dev-lead", { messageId: "res-kid-b" }),
    body: body("result"),
    summary: "kid-b 완료",
  });
  assert.equal(review({ messageId: "rr2" }, "kid-b"), "route_not_related");
  assert.equal(review({ messageId: "rr3" }, "reviewer"), "route_self");
  assert.equal(review({ messageId: "rr4" }, "ghost"), "unknown_task");

  // review_request 없이 review_result를 낼 수 없다.
  k.startTask("reviewer");
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
