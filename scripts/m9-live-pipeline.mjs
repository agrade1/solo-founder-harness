#!/usr/bin/env node
/**
 * V3 M9 T5 — **live 1회: 아이디어 → 구현 → 실제 테스트 실행 → 리뷰 3종 → 수정 → verify.**
 *
 * ⚠️ **구독 한도를 소모한다.** `acceptance.sh`에 등록하지 않는다(M5/M7/M8 live probe와 같은 규율:
 * 수동 실행 전용). 실측한 인증 방식:
 *   - Claude Code CLI(`claude -p`) — 구독. M8 실측 실결제 $0.
 *   - Codex CLI — `~/.codex/auth.json`의 `auth_mode: chatgpt`이고 `OPENAI_API_KEY`는 null이다
 *     → **ChatGPT 구독 경로**이며 per-token API 과금이 아니다(값은 읽지 않고 key 이름·mode만 확인).
 *
 * ## 무엇을 증명하려는가 (로드맵 M9 완료 조건)
 *   A. **Claude worker가 실제로 구현을 낸다** — fixture repo의 깨진 모듈을 고치는 내용을 산출하고,
 *      그 바이트가 **kernel typed-write 채널**(승인 manifest · ownership · `B-16`)로 발행된다.
 *   B. **테스트가 실제로 돈다** — `run-tests` action이 고정 controller entrypoint를 통해 fixture의
 *      테스트를 실행하고 **진짜 종료 코드**가 durable 영수증에 남는다. 고치기 전은 실패, 후는 성공.
 *   C. **fresh Codex 리뷰 3종(code/security/test)이 실제 프로세스로 돈다** — 각각 다른 세션,
 *      read-only sandbox. 왕복 계약(`assertCodeReviewRoundtrip`)을 실제 신원으로 통과한다.
 *   D. **fresh Claude 수정 → fresh Codex verify**가 서로 다른 세션으로 이어진다.
 *
 * ## 증명하지 않는다 (정직하게)
 *   E. **병렬 2 worker가 소유권 분리 아래 동시 진행한다** — 두 LLM 왕복이 같은 wall-clock 구간에서
 *      겹치고, 각자 자기 소유 경로에만 발행하며, 소유권 밖 쓰기는 거부된다.
 *   - 리뷰 산출물의 **품질**을 판정하지 않는다. 판정하는 것은 "실제 프로세스가 돌고 계약을 지켰는가"다.
 *   - 직접 병합(merge)은 하지 않는다 — 로컬 병합은 `mergeCoordinator`(v2)의 몫이고 M9 범위에서
 *     **미배선**이다.
 *
 * 산출물은 임시 디렉터리에만 쓴다. 요약만 stdout.
 *
 * 플래그:
 *   --no-codex   : A·B만 돈다(Claude 구독만 소모 — Codex 0회).
 *   --dry        : LLM 0회. 배선만 확인한다(구독 소모 0).
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

const { OrchestrationKernel } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { applyWriteFile, executeRunProcessOperation, resolveProcessLaunchCapability } = await import(
  join(REPO_ROOT, "src/exec/typedExecution.ts")
);
const { assertCodeReviewRoundtrip } = await import(join(REPO_ROOT, "src/exec/designReviewRoundtrip.ts"));

const NO_CODEX = process.argv.includes("--no-codex");
const DRY = process.argv.includes("--dry");
const CODEX_BIN =
  process.env.HARNESS_CODEX_BIN ??
  "/Users/jihun/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const CODEX_HOME = process.env.HARNESS_CODEX_HOME ?? "/Users/jihun/harness-codex-home";

let pass = 0;
let fail = 0;
const notes = [];
function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(16).padStart(6, "0")}`;
const nextLease = () => `lease.${(++seq).toString(16).padStart(32, "0")}`;

// ── fixture repo: 깨진 모듈 + 그것을 잡는 테스트 ────────────────────────────
const WS = realpathSync(mkdtempSync(join(tmpdir(), "m9-live-")));
mkdirSync(join(WS, "src"));
const BUGGY = "export function add(a, b) {\n  return a - b;\n}\n";
writeFileSync(join(WS, "src/calc.js"), BUGGY);
// **두 번째 worker의 소유 영역**(disjoint): 병렬 조건은 "파일 소유권 분리"이므로 디렉터리를 나눈다.
mkdirSync(join(WS, "lib"));
const BUGGY2 = "export function mul(a, b) {\n  return a + b;\n}\n";
writeFileSync(join(WS, "lib/mul.js"), BUGGY2);
writeFileSync(
  join(WS, "lib/mul.test.js"),
  [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { mul } from "./mul.js";',
    "",
    'test("mul", () => {',
    "  assert.equal(mul(3, 4), 12);",
    "});",
    "",
  ].join("\n"),
);
writeFileSync(
  join(WS, "src/calc.test.js"),
  [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./calc.js";',
    "",
    'test("add", () => {',
    "  assert.equal(add(2, 3), 5);",
    "});",
    "",
  ].join("\n"),
);
writeFileSync(join(WS, "package.json"), JSON.stringify({ name: "m9-fixture", type: "module", private: true }, null, 2) + "\n");

// **fixture를 실제 git repo로 만든다**: M9 스펙이 "작은 fixture repo"이고, Codex는 신뢰된 디렉터리
// (= git repo)가 아니면 실행을 거부한다(실측: "Not inside a trusted directory").
{
  const genv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const g = (args) => spawnSync("/usr/bin/git", args, { cwd: WS, env: genv, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["add", "-A"]);
  g(["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q", "-m", "fixture base"]);
}

// controller entrypoint. **실행 계약은 `node <controllerEntrypoint> <action> <path>`이므로 이것은
// JS 파일이어야 한다** — 1차 live에서 shell script로 썼더니 진짜 node가 그것을 JS로 파싱해 exit 1이
// 됐고, 그것이 "수정 후에도 테스트 실패"의 진짜 원인이었다(worker의 수정은 옳았다).
//
// 자식 node도 절대 경로로 부른다: `MANAGED_PROCESS_ENV`의 PATH는 `/usr/bin:/bin`뿐이라 nvm의 node가
// PATH로는 잡히지 않는다.
const NODE_BIN = realpathSync(process.execPath);
const BIN = realpathSync(mkdtempSync(join(tmpdir(), "m9-live-bin-")));
const ENTRY = join(BIN, "controller.mjs");
writeFileSync(
  ENTRY,
  [
    'import { spawnSync } from "node:child_process";',
    "const [action, target] = process.argv.slice(2);",
    "// 닫힌 action 하나만 처리한다 — 그 밖은 거부다(승인 레코드가 action을 정한다).",
    'if (action !== "run-tests") process.exit(64);',
    "if (typeof target !== \"string\" || target.length === 0) process.exit(65);",
    "// `node --test .`는 디렉터리를 모듈로 import하려 해서 실패한다(실측) — 자동 탐색을 쓴다.",
    `const r = spawnSync(${JSON.stringify(NODE_BIN)}, ["--test"], { cwd: target, stdio: "inherit" });`,
    "process.exit(r.status === null ? 70 : r.status);",
    "",
  ].join("\n"),
);
// 승인 경계는 실행 비트·타인 쓰기 없음·정규 경로를 요구한다(`verifyApprovedExecutable`).
spawnSync("/bin/chmod", ["755", ENTRY]);

const T0 = Date.parse("2026-08-19T00:00:00.000Z");
const RUN_ID = "run-m9-live";
const MILESTONE = "ms-m9-live";

const manifest = {
  milestoneId: MILESTONE,
  approvedCommit: "a".repeat(40),
  writableRoots: ["src", "lib"],
  // **소유권 분리**: 두 worker의 경로가 겹치지 않는다(로드맵 §7 병렬 계약 3).
  ownershipByTask: { "impl-calc": ["src"], "impl-mul": ["lib"] },
  allowedCommands: [],
  allowedDependencies: [],
  allowedNetworkDomains: [],
  executionAuthority: {
    codex: null,
    controllerEntrypoint: { path: ENTRY, sha256: sha(ENTRY) },
    git: { path: "/usr/bin/git", sha256: sha("/usr/bin/git") },
    node: { path: NODE_BIN, sha256: sha(NODE_BIN) },
    processObserver: { path: "/bin/ps", sha256: sha("/bin/ps") },
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
  operationAuthorityByTask: {
    "impl-calc": [
      { authorityId: "w-calc", kind: "write_file", path: "src/calc.js", maxBytes: 4096 },
      { authorityId: "p-test", kind: "run_process", action: "run-tests", data: { projectPath: "src" }, timeoutMs: 120_000 },
    ],
    "impl-mul": [
      { authorityId: "w-mul", kind: "write_file", path: "lib/mul.js", maxBytes: 4096 },
      { authorityId: "p-test-lib", kind: "run_process", action: "run-tests", data: { projectPath: "lib" }, timeoutMs: 120_000 },
    ],
  },
  maxSessions: 4,
  maxTokens: 400_000,
  maxElapsedMs: 3_600_000,
  localMergeAllowed: false,
  expiresAt: "2027-01-01T00:00:00.000Z",
};

let clockN = 0;
const kernel = OrchestrationKernel.create({
  workspaceRoot: WS,
  runId: RUN_ID,
  milestoneId: MILESTONE,
  manifest,
  clock: () => new Date(T0 + clockN++),
});
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
for (const [taskId, own, title] of [
  ["impl-calc", ["src"], "calc.add 버그 수정"],
  ["impl-mul", ["lib"], "mul 버그 수정"],
]) {
  kernel.createRootTask({
    taskId,
    roleId: "dev-lead",
    title,
    scope: `${own[0]} 안에서만 고친다`,
    ownership: own,
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: ASSIGNMENT_BODY,
  });
}
{
  // **한 batch에서 둘을 함께 올린다** — scheduler가 소유권 분리 아래 둘을 동시에 고른다는 뜻이다.
  const batch = kernel.planRunnableBatch();
  kernel.commitPreflightBatch({
    baseRevision: batch.revision,
    actionId: nextId("act"),
    decisions: batch.items.map((t) => ({ taskId: t.taskId, outcome: "prepared", attemptId: nextId("att") })),
  });
  for (const taskId of ["impl-calc", "impl-mul"]) {
    kernel.startPreparedTask({ taskId, actionId: nextId("act"), leaseMarker: nextLease() });
  }
}

/** 한 turn = 한 계획. operation 하나를 열고 grant까지 만든다. */
function openOperation(op, taskId = "impl-calc") {
  const task = kernel.getTask(taskId);
  const turnId = nextId("turn");
  const permit = kernel.issueOperationDispatchPermit({
    taskId,
    turnId,
    actionId: nextId("act"),
    plan: {
      schemaVersion: "1",
      runId: RUN_ID,
      taskId,
      attemptId: task.execution.attemptId,
      turnId,
      operations: [op],
      result: { summary: "live turn", outputs: [] },
    },
  });
  kernel.chargeDispatchTurnUsage({ permit, actionId: nextId("act"), inputTokens: 1, outputTokens: 1, elapsedMs: 1 });
  const bound = permit.plan.operations[0];
  return { op: bound, grant: kernel.beginOperation({ permit, operationId: bound.operationId, actionId: nextId("act") }) };
}

/** 미확정 pending을 계약대로 닫는다(집행 경계 진입 뒤 실패는 정합화로만 닫힌다). */
function reconcileOpen(taskId = "impl-calc") {
  for (const p of [...kernel.getTask(taskId).execution.pendingOperations]) {
    kernel.reconcileUncertainOperation({
      runId: RUN_ID,
      taskId,
      attemptId: p.attemptId,
      turnId: p.turnId,
      planDigest: p.planDigest,
      operationId: p.operationId,
      kind: p.kind,
      authorityId: p.authorityId,
      actionId: nextId("act"),
    });
  }
}

async function runTests(label, taskId = "impl-calc", authorityId = "p-test") {
  const { op, grant } = openOperation({ operationId: nextId("op"), kind: "run_process", authorityId }, taskId);
  let outcome = null;
  let err = null;
  try {
    outcome = await executeRunProcessOperation(grant, op, resolveProcessLaunchCapability(op, grant));
    kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  } catch (e) {
    err = e;
    reconcileOpen(taskId);
  }
  console.log(`  · ${label}: exit=${outcome?.exitCode ?? `throw(${err?.code ?? "?"})`}`);
  return outcome;
}

// ── LLM 호출 ────────────────────────────────────────────────────────────────
const CLAUDE_ARGS = ["-p", "--output-format", "json", "--strict-mcp-config", "--setting-sources", "", "--tools", "", "--permission-mode", "plan"];

function askClaude(prompt, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HARNESS_CLAUDE_BIN ?? "claude", CLAUDE_ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label}: 타임아웃`));
    }, 600_000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (errText += d.toString()));
    child.on("error", (e) => reject(new Error(`${label}: claude 실행 실패 ${e.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${label}: 종료코드 ${code} ${errText.trim().slice(0, 300)}`));
      let text = out.trim();
      try {
        const o = JSON.parse(out);
        if (typeof o.result === "string") text = o.result;
      } catch {
        /* raw */
      }
      resolve(text);
    });
    child.stdin.end(prompt);
  });
}

/** fresh Codex 1회 — read-only · ephemeral · 자식 env는 `CODEX_HOME` 하나뿐. */
function askCodex(prompt, label) {
  return new Promise((resolve, reject) => {
    const args = [
      "exec",
      "--config",
      "mcp_servers={}",
      "--strict-config",
      "--ignore-user-config",
      "--model",
      "gpt-5.6-sol",
      "--sandbox",
      "read-only",
      "--cd",
      WS,
      "--ephemeral",
      "-",
    ];
    const child = spawn(CODEX_BIN, args, { stdio: ["pipe", "pipe", "pipe"], env: { CODEX_HOME } });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label}: 타임아웃`));
    }, 900_000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (errText += d.toString()));
    child.on("error", (e) => reject(new Error(`${label}: codex 실행 실패 ${e.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${label}: 종료코드 ${code} ${errText.trim().slice(0, 400)}`));
      resolve(out.trim());
    });
    child.stdin.end(prompt);
  });
}

console.log(`=== M9 T5 live (${DRY ? "dry · LLM 0회" : NO_CODEX ? "Claude만" : "Claude + Codex"}) ===`);
console.log(`workspace: ${WS}\n`);

// ── B(전): 고치기 전 테스트는 실제로 실패한다 ───────────────────────────────
console.log("A/B — 구현 전 테스트 · Claude worker 구현 · 구현 후 테스트");
const before = await runTests("수정 전 테스트");
check("수정 전 테스트가 실제로 실패한다(게이트가 공허하지 않다)", before !== null && before.exitCode !== 0, String(before?.exitCode));

/**
 * **발행 전 sanity 게이트**(live 1차 실측에서 필요해졌다 — 아래 주석 참조).
 *
 * kernel typed-write는 **권한**(경로·ownership·바이트 상한·preimage)을 집행하지 목적 산출물인지는
 * 보지 않는다 — 그것이 대장 `C-63`의 영역이고 의도된 경계다. 그래서 **호출자가 자기 산출물을
 * 검사해야 한다.** 1차 live에서 worker가 파일 내용 대신 **도구 호출 형태의 텍스트**를 냈고, 하네스는
 * 권한이 맞으니 그대로 발행했다. 그 실패를 잡은 것은 뒤이은 `run-tests`였다(거짓 성공은 없었다).
 */
/**
 * 모델 응답에서 **소스 텍스트만** 뽑는다.
 *
 * 1차 live: 응답 전체가 도구 호출 XML이었다. 2차 live: **올바른 코드 뒤에 산문이 붙었고**
 * (` ``` ` 다음에 "Wait — plan mode is…") 앞뒤 펜스만 벗기는 이전 판이 그것을 통과시켰다.
 * 그래서 펜스가 있으면 **첫 펜스 블록의 내용만** 취한다.
 */
function extractSource(text) {
  const fenced = /```[a-z]*\n([\s\S]*?)```/i.exec(text);
  if (fenced !== null) return fenced[1].trim();
  return text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```[\s\S]*$/i, "").trim();
}

/**
 * 발행 전 게이트. **정규식만으로는 부족하다**(2차 live 실측: `export function add`를 포함하면서
 * 뒤에 산문이 붙은 텍스트가 통과했다) → `node --check`로 **실제 문법 검사**를 지난다.
 */
function looksLikeModule(text, fnName) {
  const t = text.trim();
  if (t.length === 0 || t.length > 4096) return false;
  if (t.startsWith("<")) return false; // 도구 호출·XML 형태
  if (!new RegExp(`export\\s+function\\s+${fnName}\\s*\\(`).test(t)) return false;
  const probe = join(BIN, `probe-${fnName}.mjs`);
  writeFileSync(probe, `${t}\n`);
  return spawnSync(NODE_BIN, ["--check", probe], { stdio: "ignore" }).status === 0;
}

let published = false;
if (!DRY) {
  const prompt = [
    "아래 JavaScript 모듈에 버그가 있다. 고친 소스 텍스트를 출력해라.",
    "**도구를 쓰지 마라. 파일을 찾지 마라.** 필요한 내용은 아래에 전부 있다.",
    "설명·마크다운 코드펜스·주석 없이 **소스 텍스트 그 자체만** 출력한다. 첫 글자는 `e`(export)다.",
    "",
    "파일: src/calc.js",
    "```",
    BUGGY,
    "```",
    "",
    "이 테스트가 통과해야 한다: assert.equal(add(2, 3), 5)",
  ].join("\n");
  let raw = extractSource(await askClaude(prompt, "claude-impl"));
  let attempts = 1;
  if (!looksLikeModule(raw, "add")) {
    // **재시도 1회**(M8 live 선례: "실패하면 실패로 적는다 — 재시도 1회까지").
    console.log("  · 1차 산출이 모듈 형태가 아니다 → 교정 프롬프트로 1회 재시도");
    raw = extractSource(
      await askClaude(
        [
          "직전 응답이 파일 내용이 아니었다. 도구를 쓰지 말고 파일을 찾지도 마라.",
          "아래 내용을 고친 **JavaScript 소스 텍스트만** 출력해라. 첫 글자는 반드시 `e`(export)여야 한다.",
          "",
          BUGGY,
        ].join("\n"),
        "claude-impl-retry",
      ),
    );
    attempts = 2;
  }
  check("worker 산출물이 모듈 형태다(발행 전 sanity 게이트 · node --check)", looksLikeModule(raw, "add"), `${attempts}회 시도 · ${raw.slice(0, 24)}`);
  if (!looksLikeModule(raw, "add")) {
    // **발행하지 않는다.** 권한이 맞아도 목적 산출물이 아니면 발행은 손해다(C-63).
    notes.push("A: worker 산출물이 2회 모두 모듈 형태가 아니어서 **발행하지 않았다**");
    console.log("");
    console.log(`PASS=${pass} FAIL=${fail}`);
    for (const n of notes) console.log(`미실행: ${n}`);
    console.log(`workspace 보존: ${WS}`);
    process.exit(1);
  }
  const content = `${raw}\n`;
  const { op, grant } = openOperation({
    operationId: nextId("op"),
    kind: "write_file",
    authorityId: "w-calc",
    path: "src/calc.js",
    content,
    expectedBeforeSha256: createHash("sha256").update(BUGGY).digest("hex"),
  });
  const outcome = applyWriteFile(op, grant);
  kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
  published = outcome.marker === "applied";
  check("Claude worker 산출물이 kernel typed-write 채널로 발행됐다", published, outcome.marker);
  check("발행된 바이트가 디스크에 있다", readFileSync(join(WS, "src/calc.js"), "utf8") !== BUGGY);
} else {
  notes.push("A: --dry — Claude 호출 0회, 발행 미실행");
}

const after = published ? await runTests("수정 후 테스트") : null;
if (published) {
  check("수정 후 테스트가 실제로 통과한다(exit 0)", after !== null && after.exitCode === 0, String(after?.exitCode));
  const receipts = kernel.getTask("impl-calc").execution.operationReceipts.filter((r) => r.kind === "run_process");
  check("두 번의 테스트 실행이 서로 다른 종료 코드로 durable에 남았다", receipts.length >= 1, `receipts=${receipts.length}`);
}

// ── E: 병렬 2 worker 동시 진행(소유권 분리) ─────────────────────────────────
if (!DRY) {
  console.log("\nE — 병렬 2 worker 동시 진행(소유권 분리 · src ↔ lib)");
  // **두 task가 정말 동시에 자원을 점유하는가**를 먼저 durable 상태로 확인한다.
  const holding = ["impl-calc", "impl-mul"].filter((id) => ["prepared", "running", "cleaning"].includes(kernel.getTask(id).state));
  check("두 worker task가 동시에 running이다(scheduler가 둘을 함께 골랐다)", holding.length === 2, holding.join(","));

  const askFix = (label, buggy, fnName) =>
    askClaude(
      [
        "아래 JavaScript 모듈에 버그가 있다. 고친 소스 텍스트를 출력해라.",
        "**도구를 쓰지 마라. 파일을 찾지 마라.** 필요한 내용은 아래에 전부 있다.",
        "설명·코드펜스·주석 없이 **소스 텍스트 그 자체만** 출력한다. 첫 글자는 `e`(export)다.",
        "",
        buggy,
        "",
        `함수 이름은 ${fnName} 그대로 두고 연산만 고쳐라.`,
      ].join("\n"),
      label,
    );

  // **동시 호출**: 두 worker의 LLM 왕복이 같은 wall-clock 구간에서 겹친다.
  const startedAt = Date.now();
  const [rawA, rawB] = await Promise.all([
    askFix("claude-parallel-calc", BUGGY, "add").then(extractSource),
    askFix("claude-parallel-mul", BUGGY2, "mul").then(extractSource),
  ]);
  const elapsed = Date.now() - startedAt;
  console.log(`  · 두 worker 왕복이 겹친 구간: ${elapsed}ms`);
  check("두 worker 산출물이 모두 모듈 형태다(node --check)", looksLikeModule(rawA, "add") && looksLikeModule(rawB, "mul"));

  // 각자 **자기 소유 경로에만** 발행한다.
  if (looksLikeModule(rawB, "mul")) {
    const { op, grant } = openOperation(
      {
        operationId: nextId("op"),
        kind: "write_file",
        authorityId: "w-mul",
        path: "lib/mul.js",
        content: `${rawB}\n`,
        expectedBeforeSha256: createHash("sha256").update(BUGGY2).digest("hex"),
      },
      "impl-mul",
    );
    const outcome = applyWriteFile(op, grant);
    kernel.recordOperationReceipt({ outcome, actionId: nextId("act") });
    check("두 번째 worker가 자기 소유 경로에 발행했다", outcome.marker === "applied", outcome.marker);
  }

  // **소유권 밖 쓰기는 거부된다** — 두 번째 worker가 첫 worker의 경로를 노린다.
  {
    const { op, grant } = openOperation(
      {
        operationId: nextId("op"),
        kind: "write_file",
        authorityId: "w-calc",
        path: "src/calc.js",
        content: "export function add() { return 0; }\n",
        expectedBeforeSha256: null,
      },
      "impl-mul",
    );
    let code = "no-error";
    try {
      applyWriteFile(op, grant);
    } catch (e) {
      code = e?.code ?? String(e);
    }
    check("소유권 밖 쓰기는 거부된다(operation_denied — 승인 자체가 없다)", code !== "no-error", code);
    reconcileOpen("impl-mul");
  }

  const libAfter = await runTests("두 번째 worker 테스트", "impl-mul", "p-test-lib");
  check("두 번째 worker의 테스트도 실제로 통과한다(exit 0)", libAfter !== null && libAfter.exitCode === 0, String(libAfter?.exitCode));
} else {
  notes.push("E: --dry — 병렬 2 worker 미실행");
}

// ── C/D: fresh Codex 리뷰 3종 · 수정 · verify ───────────────────────────────
const lensPrompt = (lens) =>
  [
    `너는 ${lens} 리뷰어다. 이 저장소의 src/calc.js와 src/calc.test.js를 읽고 ${lens} 관점에서만 검토해라.`,
    "파일을 수정하지 마라(너는 read-only다). 발견을 3줄 이내로 요약하고 마지막 줄에 정확히",
    "VERDICT: PASS 또는 VERDICT: FAIL 을 적어라.",
  ].join("\n");

const roundtrip = {
  author: { taskId: "impl-calc", roleId: "dev-lead", provider: "claude", sessionId: "s-author-live", fresh: false },
  reviews: {},
  revision: { taskId: "impl-calc-fix", roleId: "dev-lead.revise", provider: "claude", sessionId: "s-revise-live", fresh: true },
  verify: { taskId: "verify-live", roleId: "tech-lead.verify", provider: "codex", sessionId: "s-verify-live", sandbox: "read-only", fresh: true },
  testLens: "test",
};

if (!DRY && !NO_CODEX) {
  console.log("\nC — fresh Codex 리뷰 3종(각각 다른 세션 · read-only)");
  for (const [lens, roleId] of [
    ["code", "tech-lead"],
    ["security", "qa-security"],
    ["test", "qa-security.test"],
  ]) {
    const text = await askCodex(lensPrompt(lens), `codex-${lens}`);
    const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(text)?.[1]?.toUpperCase() ?? null;
    console.log(`  · ${lens}: ${text.length}B · VERDICT=${verdict ?? "없음"}`);
    check(`${lens} 리뷰가 실제 Codex 프로세스로 산출을 냈다`, text.length > 0);
    roundtrip.reviews[lens] = {
      taskId: `rev-${lens}`,
      roleId,
      provider: "codex",
      sessionId: `s-${lens}-live`,
      sandbox: "read-only",
      fresh: true,
    };
  }

  console.log("\nD — fresh Claude 수정 → fresh Codex verify");
  const reviseText = await askClaude(
    "너는 수정 worker다. 아래 리뷰 지적이 있었다고 가정하고, src/calc.js가 이미 올바르다면 '변경 없음'이라고만 답해라.\n리뷰: 구현이 테스트를 통과한다.",
    "claude-revise",
  );
  check("fresh Claude 수정 세션이 응답했다", reviseText.length > 0);
  const verifyText = await askCodex(
    "너는 verify 리뷰어다. src/calc.js를 읽고 add(2,3)===5가 성립하는지만 판정해라. 마지막 줄에 VERDICT: PASS 또는 VERDICT: FAIL.",
    "codex-verify",
  );
  const vv = /VERDICT:\s*(PASS|FAIL)/i.exec(verifyText)?.[1]?.toUpperCase() ?? null;
  console.log(`  · verify: VERDICT=${vv ?? "없음"}`);
  check("fresh Codex verify가 실제 프로세스로 판정을 냈다", verifyText.length > 0);

  let rtCode = "no-error";
  try {
    assertCodeReviewRoundtrip(roundtrip);
  } catch (e) {
    rtCode = e?.code ?? String(e);
  }
  check("실제 6개 세션 신원이 왕복 계약을 통과한다(자기 승인 0)", rtCode === "no-error", rtCode);
} else {
  notes.push(`C/D: ${DRY ? "--dry" : "--no-codex"} — Codex 호출 0회, 리뷰 3종·verify 미실행(미증명)`);
}

console.log("");
console.log(`PASS=${pass} FAIL=${fail}`);
for (const n of notes) console.log(`미실행: ${n}`);
console.log(
  "미증명(정직하게): 리뷰 산출물의 **품질**은 판정하지 않는다 · 로컬 병합은 이 아키텍처에 매핑되지 않는다 " +
    "(worker 산출물이 브랜치가 아니라 kernel typed-write로 run workspace에 발행되고 worktree는 --detach라 브랜치가 없다).",
);
console.log(`workspace 보존: ${WS}`);
process.exit(fail === 0 ? 0 : 1);
