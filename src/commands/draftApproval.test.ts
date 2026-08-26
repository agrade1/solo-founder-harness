/**
 * V3 M12 L2b — **`harness draft-approval` / `harness validate-approval`** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/commands/draftApproval.test.ts`
 * 네트워크·LLM·프로세스 0. 임시 디렉터리에서만 돈다(무과금).
 *
 * 이 파일이 고정하는 계약:
 * - **초안은 그대로 실행될 수 없다**: sentinel 하나하나가 `validateApprovalManifest`에서 **개별적으로**
 *   거부된다(나머지를 전부 채워도 그 하나 때문에 못 지난다). 그리고 그 성질은 코드가 자기 산출물을
 *   검증기에 먹여 **집행**한다.
 * - **대조군**: 사람이 전부 채우면 같은 문서가 통과하고 `autopilot-create`(=`createRunFromDocuments`)까지 간다.
 * - **PATH 자동 발견이 없다**: 플래그가 없으면 실행 파일 자리는 sentinel이다(시스템에서 찾지 않는다).
 * - **기계적 파생**: `ownershipByTask` ← node.ownership, `operationAuthorityByTask` ← node.provides.
 * - **DAG의 `operations` id를 존중한다**(새로 짓지 않는다). 개수가 어긋나면 fail closed.
 * - `validate-approval`은 읽기 전용이며 남은 sentinel을 전부 이름으로 낸다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationError } from "../exec/orchestrationTypes.js";
import { validateApprovalManifest } from "../exec/approvalManifest.js";
import { TASK_DAG_SCHEMA_VERSION } from "../exec/taskDag.js";
import { createRunFromDocuments } from "./autopilotCreate.js";
import {
  DEFAULT_DRAFT_FILE,
  SENTINEL_NUMBER,
  SENTINEL_PREFIX,
  buildApprovalDraft,
  runDraftApprovalCommand,
  runValidateApprovalCommand,
  sentinelPaths,
} from "./draftApproval.js";

const MILESTONE = "m12-l2b";

const dirs: string[] = [];
/**
 * `realpathSync`로 정규화한다 — macOS의 `/var/folders/…`는 `/private/var/…`의 symlink라서, 그대로
 * 쓰면 실행 파일 경로가 **집행기의 정규 경로 계약**에 걸린다(그것은 이 slice의 성질이 아니라
 * `verifyApprovedExecutable`의 기존 계약이다).
 */
function makeDir(prefix: string): string {
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

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `unexpected:${String(e)}`;
  }
  return "no-throw";
}

/** 2 task DAG — 계약을 지킨 최소 문서(서로 의존해 ownership 충돌이 없다). */
function dagDoc(over: Record<string, unknown>[] | null = null): Record<string, unknown> {
  return {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: over ?? [
      { taskId: "prd", roleId: "pm", title: "PRD", scope: "PRD만", ownership: ["docs/prd"], dependsOn: [], provides: ["docs/prd/PRD.md"] },
      {
        taskId: "impl",
        roleId: "dev-lead",
        title: "구현",
        scope: "src만",
        ownership: ["src/app"],
        dependsOn: ["prd"],
        provides: ["src/app/index.ts"],
        consumes: ["docs/prd/PRD.md"],
      },
    ],
  };
}

function dagFile(doc: unknown = dagDoc()): string {
  const f = join(makeDir("m12-l2b-dag-"), "dag.json");
  writeFileSync(f, JSON.stringify(doc, null, 2));
  return f;
}

/** **사람이 채운다**를 코드로 흉내낸 것 — 모든 sentinel을 유효한 값으로 바꾼다. */
function fillDraft(draft: Record<string, unknown>): Record<string, unknown> {
  const filled = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
  filled.approvedCommit = "a".repeat(40);
  filled.writableRoots = ["docs", "src"];
  filled.expiresAt = "2027-01-01T00:00:00.000Z";
  filled.maxSessions = 4;
  filled.maxTokens = 100_000;
  filled.maxElapsedMs = 3_600_000;
  filled.autopilotPolicy = {
    maxTaskAttempts: 2,
    maxDeliveryAttempts: 2,
    retryBackoffMs: 0,
    deliveryDeadlineMs: 600_000,
    maxNoProgressMs: 600_000,
    maxAttemptElapsedMs: 600_000,
    cleanupTermGraceMs: 500,
    cleanupKillGraceMs: 500,
  };
  const auth = filled.executionAuthority as Record<string, unknown>;
  for (const [k, v] of Object.entries(auth)) {
    if (v !== null && typeof v === "object") auth[k] = { path: `/opt/harness/${k}`, sha256: "b".repeat(64) };
  }
  for (const ops of Object.values(filled.operationAuthorityByTask as Record<string, Record<string, unknown>[]>)) {
    for (const op of ops) op.maxBytes = 65_536;
  }
  return filled;
}

/** 값 하나를 dotted path 자리에 되돌린다(`a.b[0].c` 형식 — `sentinelPaths`가 내는 것과 같은 표기). */
function setAt(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const steps = dotted.split(".").flatMap((seg) => {
    const [head, ...idx] = seg.split("[");
    return [head, ...idx.map((i) => i.replace("]", ""))];
  });
  let cur: Record<string, unknown> = root;
  for (const s of steps.slice(0, -1)) cur = (cur as Record<string, unknown>)[s] as Record<string, unknown>;
  cur[steps[steps.length - 1]] = value;
}

test("초안은 그대로 검증기를 지나지 못하고, sentinel **하나하나가** 개별적으로 거부한다", () => {
  const built = buildApprovalDraft({ dag: dagFile(), milestone: MILESTONE });

  // ① 초안 그대로 — 거부.
  assert.notEqual(codeOf(() => validateApprovalManifest(built.draft)), "no-throw", "초안이 그대로 유효하다(= 승인 발행)");

  // ② 대조군 — 사람이 전부 채우면 **통과한다**(위 거부가 무조건 거부가 아니다).
  const filled = fillDraft(built.draft);
  assert.equal(codeOf(() => validateApprovalManifest(filled)), "no-throw");
  assert.equal(sentinelPaths(filled).length, 0, "채운 문서에 sentinel이 남아 있다");

  // ③ **어느 자리가 sentinel이어야 하는가**를 이름으로 고정한다. ②/④만 있으면 "sentinel이 든 자리는
  //    거부된다"만 증명되고, 나중에 누가 한 자리에 그럴듯한 기본값을 넣어도 아무 테스트도 울지 않는다
  //    (초안이 조용히 만료·예산·상한을 골라 준다). 목록은 이 slice의 헌법이 이름으로 지목한 자리다.
  for (const field of [
    "approvedCommit",
    "expiresAt",
    "maxTokens",
    "maxSessions",
    "maxElapsedMs",
    "writableRoots[0]",
    "autopilotPolicy.maxTaskAttempts",
    "autopilotPolicy.maxDeliveryAttempts",
    "autopilotPolicy.retryBackoffMs",
    "autopilotPolicy.deliveryDeadlineMs",
    "autopilotPolicy.maxNoProgressMs",
    "autopilotPolicy.maxAttemptElapsedMs",
    "autopilotPolicy.cleanupTermGraceMs",
    "autopilotPolicy.cleanupKillGraceMs",
    "executionAuthority.claude.path",
    "executionAuthority.claude.sha256",
    "executionAuthority.git.path",
    "executionAuthority.git.sha256",
    "executionAuthority.node.path",
    "executionAuthority.node.sha256",
    "executionAuthority.processObserver.path",
    "executionAuthority.processObserver.sha256",
    "executionAuthority.controllerEntrypoint.path",
    "executionAuthority.controllerEntrypoint.sha256",
  ]) {
    assert.ok(built.sentinels.includes(field), `${field}가 sentinel이 아니다 — 초안이 이 값을 대신 골랐다`);
  }

  // ④ **각 sentinel이 혼자서도 검증기를 막는다.** 나머지를 전부 채우고 하나만 되돌린다 —
  //    "어차피 다른 필드가 막는다"로 공허해지는 것을 여기서 닫는다.
  assert.ok(built.sentinels.length >= 20, `sentinel이 너무 적다: ${built.sentinels.length}`);
  const reasons = new Map<string, string>();
  for (const p of built.sentinels) {
    const one = fillDraft(built.draft);
    const original = built.sentinels.includes(p) ? readAt(built.draft, p) : undefined;
    setAt(one, p, original);
    const code = codeOf(() => validateApprovalManifest(one));
    assert.notEqual(code, "no-throw", `sentinel ${p}만 남았는데 검증기가 통과시켰다`);
    reasons.set(p, code);
  }
  // 거부 사유가 전부 승인 계약의 안정 코드다(무작위 예외가 아니다).
  for (const [p, code] of reasons) {
    assert.ok(
      ["invalid_manifest", "invalid_timestamp", "invalid_id", "ownership_outside_writable_root", "operation_outside_writable_root"].includes(code),
      `${p} → 예상 밖 코드 ${code}`,
    );
  }
});

/** dotted path에서 값을 읽는다(`setAt`의 역). */
function readAt(root: unknown, dotted: string): unknown {
  const steps = dotted.split(".").flatMap((seg) => {
    const [head, ...idx] = seg.split("[");
    return [head, ...idx.map((i) => i.replace("]", ""))];
  });
  let cur: unknown = root;
  for (const s of steps) cur = (cur as Record<string, unknown>)[s];
  return cur;
}

test("채운 초안은 autopilot-create까지 간다 (초안 → 실행의 대조군)", () => {
  const doc = dagDoc([
    { taskId: "prd", roleId: "pm", title: "PRD", scope: "PRD만", ownership: ["docs/prd"], dependsOn: [], provides: ["docs/prd/PRD.md"], operations: ["prd-w1"] },
  ]);
  const built = buildApprovalDraft({ dag: dagFile(doc), milestone: MILESTONE });
  const filled = fillDraft(built.draft);
  const result = createRunFromDocuments({
    workspaceRoot: makeDir("m12-l2b-ws-"),
    runId: "l2b-run",
    milestoneId: MILESTONE,
    rawManifest: filled,
    rawDag: doc,
  });
  assert.equal(result.taskCount, 1);
  assert.deepEqual(result.createdOrder, ["prd"]);
});

test("기계적 파생 — 12-task DAG의 ownership과 write 권위가 전부 나온다", () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    taskId: `t${i + 1}`,
    roleId: "dev-lead",
    title: `t${i + 1}`,
    scope: "scope",
    ownership: [`src/f${i + 1}`],
    dependsOn: [],
    provides: [`src/f${i + 1}/index.ts`],
  }));
  const built = buildApprovalDraft({ dag: dagFile(dagDoc(tasks)), milestone: MILESTONE });
  const ownership = built.draft.ownershipByTask as Record<string, string[]>;
  const ops = built.draft.operationAuthorityByTask as Record<string, Record<string, unknown>[]>;
  assert.equal(Object.keys(ownership).length, 12);
  assert.equal(Object.keys(ops).length, 12);
  for (const t of tasks) {
    assert.deepEqual(ownership[t.taskId], t.ownership, `${t.taskId}의 ownership이 DAG와 다르다`);
    assert.equal(ops[t.taskId].length, 1);
    assert.equal(ops[t.taskId][0].kind, "write_file");
    assert.equal(ops[t.taskId][0].path, t.provides[0], "권위 경로를 DAG의 provides에서 파생하지 않았다");
    assert.equal(ops[t.taskId][0].maxBytes, SENTINEL_NUMBER, "maxBytes에 기본값을 조용히 넣었다");
  }
  assert.equal(built.authorityMap.length, 12);
  // `operations`를 말하지 않은 node는 승인만으로는 아무것도 쓰지 못한다 — 그 사실을 보고한다.
  assert.equal(built.tasksWithoutOperations.length, 12);
});

test("DAG가 말한 authorityId를 존중한다 — 새로 짓지 않고, 개수가 어긋나면 fail closed", () => {
  const withOps = dagDoc([
    {
      taskId: "prd",
      roleId: "pm",
      title: "PRD",
      scope: "PRD만",
      ownership: ["docs/prd"],
      dependsOn: [],
      provides: ["docs/prd/PRD.md"],
      operations: ["auth-prd-doc"],
    },
  ]);
  const built = buildApprovalDraft({ dag: dagFile(withOps), milestone: MILESTONE });
  assert.deepEqual(built.authorityMap, [{ taskId: "prd", authorityId: "auth-prd-doc", path: "docs/prd/PRD.md" }]);
  assert.equal(built.tasksWithoutOperations.length, 0);

  // 개수가 어긋나면 짝을 지어낼 수 없다 → 거부(잘못된 짝을 조용히 만들지 않는다).
  const mismatch = dagDoc([
    {
      taskId: "prd",
      roleId: "pm",
      title: "PRD",
      scope: "PRD만",
      ownership: ["docs/prd"],
      dependsOn: [],
      provides: ["docs/prd/PRD.md"],
      operations: ["auth-a", "auth-b"],
    },
  ]);
  assert.equal(codeOf(() => buildApprovalDraft({ dag: dagFile(mismatch), milestone: MILESTONE })), "draft_authority_underivable");
});

test("PATH 자동 발견이 없다 — 플래그가 없으면 실행 파일 자리는 전부 sentinel이다", () => {
  const built = buildApprovalDraft({ dag: dagFile(), milestone: MILESTONE });
  const auth = built.draft.executionAuthority as Record<string, { path: string; sha256: string } | null>;
  assert.equal(auth.codex, null, "codex는 미승인(null)이어야 한다");
  for (const field of ["claude", "git", "node", "processObserver", "controllerEntrypoint"]) {
    const rec = auth[field]!;
    assert.ok(rec.path.startsWith(SENTINEL_PREFIX), `${field}.path가 sentinel이 아니다: ${rec.path}`);
    assert.ok(rec.sha256.startsWith(SENTINEL_PREFIX), `${field}.sha256이 sentinel이 아니다`);
  }
  // 그리고 그 sentinel들은 검증기가 거부한다(= 자동 발견 없이는 실행 승인이 성립하지 않는다).
  const filled = fillDraft(built.draft);
  setAt(filled, "executionAuthority.git.path", auth.git!.path);
  assert.equal(codeOf(() => validateApprovalManifest(filled)), "invalid_manifest");
});

test("명시한 실행 파일만 digest가 실린다 — 그리고 집행기가 거부할 경로는 초안도 거부한다", () => {
  const d = makeDir("m12-l2b-bin-");
  const bin = join(d, "fake-git");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);

  const built = buildApprovalDraft({ dag: dagFile(), milestone: MILESTONE, git: bin });
  const git = (built.draft.executionAuthority as Record<string, { path: string; sha256: string }>).git;
  assert.equal(git.path, bin, "사람이 준 경로를 그대로 적지 않았다");
  assert.equal(git.sha256, createHash("sha256").update(readFileSync(bin)).digest("hex"), "digest가 실제 파일 내용이 아니다");
  assert.ok(!built.sentinels.includes("executionAuthority.git.path"));

  // symlink는 집행기(`verifyApprovedExecutable`)와 **같은 이유로** 거부한다 —
  // 통과하지 못할 승인을 초안이 지어내지 않는다.
  const link = join(d, "git-link");
  symlinkSync(bin, link);
  assert.equal(codeOf(() => buildApprovalDraft({ dag: dagFile(), milestone: MILESTONE, git: link })), "draft_executable_untrusted");

  // 실행 비트가 없는 파일도 마찬가지다.
  const plain = join(d, "not-exec-draft");
  writeFileSync(plain, "x");
  chmodSync(plain, 0o644);
  assert.equal(codeOf(() => buildApprovalDraft({ dag: dagFile(), milestone: MILESTONE, node: plain })), "draft_executable_untrusted");

  // 상대경로는 경로 계약 위반이다(우리가 resolve해서 조용히 고치지 않는다).
  assert.equal(codeOf(() => buildApprovalDraft({ dag: dagFile(), milestone: MILESTONE, node: "fake-git" })), "draft_executable_unreadable");
});

test("DAG가 계약을 어기면 초안을 만들지 않는다 (fail closed · 파일을 남기지 않는다)", () => {
  const bad = dagFile({ schemaVersion: TASK_DAG_SCHEMA_VERSION, tasks: [{ taskId: "impl", roleId: "dev-lead", title: "구현", scope: "s", ownership: ["src"], dependsOn: ["prd"] }] });
  assert.equal(codeOf(() => buildApprovalDraft({ dag: bad, milestone: MILESTONE })), "unknown_dependency");

  const out = join(makeDir("m12-l2b-out-"), DEFAULT_DRAFT_FILE);
  withStdout(() => {
    process.exitCode = 0;
    runDraftApprovalCommand({ dag: bad, milestone: MILESTONE, out });
  });
  assert.equal(process.exitCode, 2);
  process.exitCode = 0;
  assert.ok(!existsSync(out), "거부인데 초안 파일이 생겼다");
});

test("출력 이름이 초안임을 말해야 하고, 채우던 초안을 덮어쓰지 않는다", () => {
  const d = makeDir("m12-l2b-out-");
  const dag = dagFile();

  const named = join(d, "approval.json");
  let out = withStdout(() => {
    process.exitCode = 0;
    runDraftApprovalCommand({ dag, milestone: MILESTONE, out: named });
  });
  assert.equal(process.exitCode, 2);
  assert.ok(out.includes("draft_output_name_not_draft"), out);
  assert.ok(!existsSync(named));

  const ok = join(d, DEFAULT_DRAFT_FILE);
  out = withStdout(() => {
    process.exitCode = 0;
    runDraftApprovalCommand({ dag, milestone: MILESTONE, out: ok });
  });
  assert.equal(process.exitCode, 0, out);
  assert.ok(out.includes("검토 없이 넘기지 마라"), out);
  // 사람이 채우던 상태를 흉내낸 뒤 재실행 — 조용히 지워지면 채운 권위 값이 사라진다.
  const filled = JSON.stringify(fillDraft(JSON.parse(readFileSync(ok, "utf8")) as Record<string, unknown>), null, 2);
  writeFileSync(ok, filled);
  out = withStdout(() => {
    process.exitCode = 0;
    runDraftApprovalCommand({ dag, milestone: MILESTONE, out: ok });
  });
  assert.equal(process.exitCode, 2);
  assert.ok(out.includes("draft_output_exists"), out);
  assert.equal(readFileSync(ok, "utf8"), filled, "재실행이 채운 초안을 덮어썼다");
  process.exitCode = 0;
});

test("validate-approval — 남은 자리를 전부 이름으로 내고, 채우면 통과한다(읽기 전용)", () => {
  const d = makeDir("m12-l2b-va-");
  const draftFile = join(d, DEFAULT_DRAFT_FILE);
  withStdout(() => {
    process.exitCode = 0;
    runDraftApprovalCommand({ dag: dagFile(), milestone: MILESTONE, out: draftFile });
  });
  const raw = readFileSync(draftFile, "utf8");

  let out = withStdout(() => {
    process.exitCode = 0;
    runValidateApprovalCommand({ file: draftFile });
  });
  assert.equal(process.exitCode, 2);
  for (const p of sentinelPaths(JSON.parse(raw) as unknown)) assert.ok(out.includes(p), `${p}가 안내에 없다`);
  assert.equal(readFileSync(draftFile, "utf8"), raw, "read-only여야 하는데 파일이 바뀌었다");

  const filledFile = join(d, "filled-draft.json");
  writeFileSync(filledFile, JSON.stringify(fillDraft(JSON.parse(raw) as Record<string, unknown>), null, 2));
  out = withStdout(() => {
    process.exitCode = 0;
    runValidateApprovalCommand({ file: filledFile });
  });
  assert.equal(process.exitCode, 0, out);
  assert.ok(out.includes("통과"), out);

  // **검증기를 통과해도 sentinel이 남아 있으면 통과시키지 않는다**(검증기가 허용하는 자리에 옮겨 붙인 경우).
  const sneaky = fillDraft(JSON.parse(raw) as Record<string, unknown>);
  sneaky.allowedCommands = [`${SENTINEL_PREFIX}allowedCommands`];
  assert.equal(codeOf(() => validateApprovalManifest(sneaky)), "no-throw", "이 자리는 검증기가 허용한다(전제)");
  const sneakyFile = join(d, "sneaky-draft.json");
  writeFileSync(sneakyFile, JSON.stringify(sneaky, null, 2));
  out = withStdout(() => {
    process.exitCode = 0;
    runValidateApprovalCommand({ file: sneakyFile });
  });
  assert.equal(process.exitCode, 2, out);
  assert.ok(out.includes("allowedCommands[0]"), out);
  process.exitCode = 0;
});

/** stdout을 가로채 문자열로 모은다(명령 본체는 stdout으로만 말한다). */
function withStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}
