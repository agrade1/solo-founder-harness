#!/usr/bin/env node
/**
 * V3 M10 T6 — **live 1회: 무인 loop 안에서 in-loop 테스트 실행과 최종 report까지 돈다.**
 *
 * ⚠️ **Claude Code 구독 한도를 소모한다.** `acceptance.sh`에 등록하지 않는다(수동 전용).
 * **Codex는 부르지 않는다** — 이 스크립트에 리뷰 왕복이 없다(그 이유는 아래 "증명하지 않는다"에 적었다).
 *
 * ## T3 live와 무엇이 다른가 (이 스크립트의 존재 이유)
 *
 * T3 live는 기획→디자인→개발까지였고 판정 절에 **"리뷰 왕복·in-loop 테스트 실행·최종 report는 이 live
 * 범위 밖"**이라고 적었다. 이 스크립트는 그중 **둘**을 loop 안으로 넣는다:
 *   - **in-loop 테스트 실행**: 승인된 `controllerEntrypoint`(`dist/exec/controllerEntrypoint.js`)를
 *     typed `run_process`(action `run-tests`)로 띄운다 → `node --test`가 workspace의 실제 테스트를 돌린다.
 *   - **최종 report**: 마지막 task가 report 문서를 산출물로 선언하고 완주한다.
 *
 * ## 증명하려는 것
 *   A. 한 번의 `runAutopilot`이 기획→구현→**테스트**→**최종 report** 4단계를 의존 순서대로 완주한다.
 *   B. 테스트 단계가 **실제 자식 프로세스**를 띄우고 `exitCode 0` 영수증으로 닫힌다.
 *   C. 실제 사용량이 durable 회계에 누적된다.
 *   D. 사람 개입 0건.
 *
 * ## 증명하지 않는다 (정직하게)
 *   - **in-loop 리뷰 왕복은 표현 불가다.** 왕복 계약(`assertCodeReviewRoundtrip`)은 리뷰어가
 *     **fresh Codex read-only**여야 한다고 요구하는데, autopilot의 live worker backend는 `claude-plan`
 *     하나다(`worker_backend_unapproved`). 그래서 이 축은 M9가 증명한 **스크립트 형태**에 남아 있고,
 *     그 간극은 대장 `C-97`이다. 여기서 흉내내지 않는다.
 *   - **red 테스트가 loop를 멈추는 것**은 offline acceptance(Test 22 ⑨)가 증명한다 — live 왕복을
 *     실패 경로에 태우지 않는다(구독 소모 대비 증거 가치가 낮다).
 *   - 산출물 품질·재현률(표본 1회)·모델의 직접 파일 쓰기(도구 차단)는 여전히 범위 밖이다.
 *
 * 플래그: `--dry` (LLM 0회 · 배선만 확인).
 */
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

const { OrchestrationKernel, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runPaths } = await import(join(REPO_ROOT, "src/exec/orchestrationStore.ts"));
const { REQUIRED_BODY_HEADINGS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));
const { runAutopilot } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));

const DRY = process.argv.includes("--dry");
const PROBE_TOOLS = process.argv.includes("--probe-tools");
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

const RUN_ID = "m10-live-t6";
const MILESTONE = "m10-live-t6";
const T0 = Date.now();
/**
 * 본문 heading 집합은 **닫혀 있다**(`body_unknown_heading`) → 승인된 operation 원문도 계약 안 절
 * (`Inputs and Contracts`)에 넣는다. 이 fixture가 그것을 지키는 것 자체가 계약의 실측이다.
 */
const ASSIGNMENT = (objective, deliverable, contracts = "- (없음)") =>
  REQUIRED_BODY_HEADINGS.task_assignment
    .map((h) => {
      if (h === "Objective") return `## ${h}\n\n${objective}\n`;
      if (h === "Expected Deliverables") return `## ${h}\n\n- \`${deliverable}\`\n`;
      if (h === "Definition of Done") return `## ${h}\n\n- \`${deliverable}\`를 산출물로 선언한 계획을 낸다.\n`;
      if (h === "Inputs and Contracts") return `## ${h}\n\n${contracts}\n`;
      return `## ${h}\n\n- (이 fixture에서는 추가 제약이 없다)\n`;
    })
    .join("\n");

// ── `--probe-tools`: 대장 `C-87` — `--tools ""` + `--permission-mode default`의 도구 차단 실측 ──
//
// 근거 실측이 지금까지 `--permission-mode plan` 조합 표본뿐이었다(M8 live의 가짜 tool-use). 여기서
// **default 조합**을 직접 시험한다: 파일 하나에 유일한 토큰을 넣고 세션에게 그 파일을 읽어 토큰을
// 그대로 출력하라고 지시한다. 도구가 실제로 끊겼다면 세션은 그 토큰을 **알 수 없다**.
if (PROBE_TOOLS) {
  const { LIVE_WORKER_ARGS, LIVE_WORKER_ENV } = await import(join(REPO_ROOT, "src/exec/livePlanWorker.ts"));
  const probeDir = realpathSync(mkdtempSync(join(tmpdir(), "m10-c87-")));
  const secret = `C87-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 20)}`;
  const secretFile = join(probeDir, "secret.txt");
  writeFileSync(secretFile, `TOKEN=${secret}\n`);
  const bin = realpathSync(process.env.HARNESS_CLAUDE_BIN ?? "/Users/jihun/.nvm/versions/node/v24.18.0/bin/claude");
  const prompt =
    `아래 경로의 파일을 읽고 그 안의 TOKEN= 뒤 값만 한 줄로 출력하라. 읽을 수 없으면 정확히 ` +
    `NO_TOOLS 라고만 출력하라.\n\n경로: ${secretFile}\n`;
  console.log(`\nV3 M10 T6 — C-87 probe (\`--tools ""\` + \`--permission-mode default\`)`);
  console.log(`  세션에게 읽으라고 지시한 파일: ${secretFile}`);
  const r = spawnSync(bin, [...LIVE_WORKER_ARGS, prompt], {
    cwd: probeDir,
    env: { ...LIVE_WORKER_ENV },
    encoding: "utf8",
    timeout: 180_000,
  });
  const out = `${r.stdout ?? ""}`;
  check("세션이 응답했다(probe가 실행됐다)", r.status === 0 && out.length > 0, `status=${r.status} stderr=${(r.stderr ?? "").slice(0, 200)}`);
  check("**도구가 차단됐다**: 응답에 파일 내용(토큰)이 없다", !out.includes(secret), out.slice(0, 300));
  console.log(`  응답 발췌: ${out.replace(/\s+/g, " ").slice(0, 220)}`);
  console.log(`\n  과금: claude -p 왕복 1회(구독 한도) · Codex 0회`);
  console.log("===================================");
  console.log(` M10 T6 C-87 probe: PASS=${pass}  FAIL=${fail}`);
  console.log("===================================");
  process.exit(fail === 0 ? 0 : 1);
}

// ── fixture: 실제 파일이 있는 workspace + 3단계 DAG ─────────────────────────
const ws = realpathSync(mkdtempSync(join(tmpdir(), "m10-live-t6-ws-")));
mkdirSync(join(ws, "docs"), { recursive: true });
mkdirSync(join(ws, "src"), { recursive: true });
// 모델은 도구가 끊겨 파일을 쓰지 못한다 → 산출물은 미리 두고, 개발 단계만 **승인된 typed write**로
// 같은 내용을 멱등 발행한다(`already_applied`). 이 스크립트가 보는 것은 계약이지 쓰기 성능이 아니다.
writeFileSync(join(ws, "docs/PLAN.md"), "# 기획 초안\n\n- 할 일: 계산기 모듈\n");
writeFileSync(join(ws, "docs/REPORT.md"), "# 최종 report\n\n- 구현·테스트 결과 요약\n");
writeFileSync(join(ws, "src/calc.mjs"), "export const add = (a, b) => a + b;\n");
// **테스트 단계가 실제로 돌릴 테스트**다. `node --test`가 이 파일을 찾는다(도구 없는 모델이 아니라
// 이 fixture가 만든다 — 증명 대상은 "loop가 테스트를 돌렸다"이고 "모델이 테스트를 썼다"가 아니다).
writeFileSync(
  join(ws, "src/calc.test.mjs"),
  'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./calc.mjs";\ntest("add", () => assert.equal(add(1, 2), 3));\n',
);
const calcSha = createHash("sha256").update(readFileSync(join(ws, "src/calc.mjs"))).digest("hex");
// 승인된 controller entrypoint — **배송되는 dist 파일**이다(대장 `C-90`). `npm run build`가 실행 비트를 준다.
const entrypoint = join(REPO_ROOT, "dist/exec/controllerEntrypoint.js");
const entrypointSha = createHash("sha256").update(readFileSync(entrypoint)).digest("hex");

const claudeReal = realpathSync(process.env.HARNESS_CLAUDE_BIN ?? "/Users/jihun/.nvm/versions/node/v24.18.0/bin/claude");
const claudeSha = createHash("sha256").update(readFileSync(claudeReal)).digest("hex");
console.log(`\nV3 M10 T6 live — 무인 loop에서 in-loop 테스트 + 최종 report${DRY ? " (--dry: LLM 0회)" : ""}`);
console.log(`  worker 실행 파일: ${claudeReal}`);
console.log(`  digest: ${claudeSha.slice(0, 16)}…  (승인 manifest에 이 값으로 박는다)`);
console.log(`  workspace: ${ws}`);

const manifest = {
  milestoneId: MILESTONE,
  approvedCommit: "a".repeat(40),
  writableRoots: ["docs", "src"],
  ownershipByTask: { "plan-pm": ["docs"], "dev-impl": ["src"], "test-run": ["src"], "report-pm": ["docs"] },
  allowedCommands: [],
  allowedDependencies: [],
  allowedNetworkDomains: [],
  executionAuthority: {
    // **live worker 실행 파일**(V3 M10 T3). 이 키가 없으면 live backend는 표현 불가다.
    claude: DRY ? null : { path: claudeReal, sha256: claudeSha },
    codex: null,
    controllerEntrypoint: { path: entrypoint, sha256: entrypointSha },
    git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
    node: { path: process.execPath, sha256: createHash("sha256").update(readFileSync(process.execPath)).digest("hex") },
    processObserver: { path: "/bin/ps", sha256: createHash("sha256").update(readFileSync("/bin/ps")).digest("hex") },
  },
  autopilotPolicy: {
    maxTaskAttempts: 2,
    maxDeliveryAttempts: 2,
    retryBackoffMs: 0,
    deliveryDeadlineMs: 600_000,
    // 모델 왕복은 수십 초가 걸린다 — 승인된 attempt 상한이 곧 세션 상한이다.
    maxNoProgressMs: 600_000,
    maxAttemptElapsedMs: 600_000,
    cleanupTermGraceMs: 2_000,
    cleanupKillGraceMs: 2_000,
  },
  operationAuthorityByTask: {
    "dev-impl": [{ authorityId: "auth-calc", kind: "write_file", path: "src/calc.mjs", maxBytes: 512 }],
    // **in-loop 테스트**: 승인된 entrypoint를 `node <entry> run-tests src`로 띄운다. 러너·argv·경로를
    // 모델이 고를 통로는 없다(승인 레코드가 정한다).
    "test-run": [
      { authorityId: "auth-tests", kind: "run_process", action: "run-tests", data: { projectPath: "src" }, timeoutMs: 300_000 },
    ],
  },
  maxSessions: 4,
  maxTokens: 2_000_000,
  maxElapsedMs: 3_600_000,
  localMergeAllowed: false,
  expiresAt: new Date(T0 + 6 * 3_600_000).toISOString(),
};

let n = 0;
const kernel = OrchestrationKernel.create({
  workspaceRoot: ws,
  runId: RUN_ID,
  milestoneId: MILESTONE,
  manifest,
  clock: () => new Date(T0 + n++),
});
kernel.createRootTask({
  taskId: "plan-pm",
  roleId: "pm",
  title: "계산기 모듈 기획",
  scope: "docs 안에서만 작업한다",
  ownership: ["docs"],
  assignmentMessageId: "asg-plan-pm",
  assignmentBody: ASSIGNMENT("이미 있는 `docs/PLAN.md`를 이 task의 산출물로 선언하는 계획을 낸다.", "docs/PLAN.md"),
});
kernel.createDependentTask({
  taskId: "dev-impl",
  roleId: "dev-lead",
  title: "계산기 구현",
  scope: "src 안에서만 작업한다",
  ownership: ["src"],
  dependsOn: ["plan-pm"],
  assignmentMessageId: "asg-dev-impl",
  assignmentBody: ASSIGNMENT(
    "`src/calc.mjs`를 승인된 typed operation으로 발행하고 산출물로 선언하는 계획을 낸다.",
    "src/calc.mjs",
    `계획의 \`operations\`에 **아래 객체를 그대로** 넣어라(승인된 유일한 operation이다):\n\n` +
      `- \`{"operationId": "op-calc", "kind": "write_file", "authorityId": "auth-calc", "path": "src/calc.mjs", "content": "export const add = (a, b) => a + b;\\n", "expectedBeforeSha256": "${calcSha}"}\`\n`,
  ),
});
kernel.createDependentTask({
  taskId: "test-run",
  roleId: "qa-security",
  title: "테스트 실행",
  scope: "src 안에서만 작업한다 — 테스트를 직접 실행하는 것은 승인된 operation이다",
  ownership: ["src"],
  dependsOn: ["dev-impl"],
  assignmentMessageId: "asg-test-run",
  assignmentBody: ASSIGNMENT(
    "승인된 `run_process` operation으로 `src`의 테스트를 실행하고, 그 결과를 산출물로 선언하는 계획을 낸다.",
    "src/calc.test.mjs",
    `계획의 \`operations\`에 **아래 객체를 그대로** 넣어라(승인된 유일한 operation이다):\n\n` +
      `- \`{"operationId": "op-tests", "kind": "run_process", "authorityId": "auth-tests"}\`\n`,
  ),
});
kernel.createDependentTask({
  taskId: "report-pm",
  roleId: "pm",
  title: "최종 report",
  scope: "docs 안에서만 작업한다",
  ownership: ["docs"],
  dependsOn: ["test-run"],
  assignmentMessageId: "asg-report-pm",
  assignmentBody: ASSIGNMENT("이미 있는 `docs/REPORT.md`를 최종 report 산출물로 선언하는 계획을 낸다.", "docs/REPORT.md"),
});

// ── 무인 loop **한 번** ──────────────────────────────────────────────────────
const events = [];
const startedAt = Date.now();
const report = await runAutopilot({
  workspaceRoot: ws,
  runId: RUN_ID,
  milestoneId: MILESTONE,
  planDir: mkdtempSync(join(tmpdir(), "m10-live-plans-")), // **비어 있다**
  workerBackend: "claude-plan",
  onEvent: (e) => {
    events.push(e);
    if (e.kind === "task_started" || e.kind === "task_completed" || e.kind === "task_paused" || e.kind === "task_aborted") {
      console.log(`  · ${e.kind} ${e.taskId ?? ""} ${e.marker ?? ""} ${e.detail ?? ""}`);
    }
  },
});
const elapsedSec = Math.round((Date.now() - startedAt) / 100) / 10;

console.log("");
if (DRY) {
  check("--dry: 승인에 worker 실행 파일이 없으면 시작조차 하지 않는다", report.blocked === "run_unavailable" && report.stoppedBecause === "worker_backend_unapproved", `${report.blocked}/${report.stoppedBecause}`);
} else {
  const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock: () => new Date(Date.now()) });
  const landed = report.tasks.map((t) => `${t.taskId}:${t.state}`).join(" → ");
  const results = k.getState().messages.filter((m) => m.type === "result");
  check(
    "A. 한 번의 실행이 기획→구현→테스트→최종 report를 의존 순서대로 완주한다",
    landed === "plan-pm:completed → dev-impl:completed → test-run:completed → report-pm:completed",
    landed,
  );
  check("A. 계획 파일 0개로 돌았다(계획을 모델이 만들었다)", report.blocked === null, String(report.blocked));
  check("A. 네 단계가 각각 다른 결과를 발행했다", new Set(results.map((m) => m.summary)).size === results.length && results.length === 4, results.map((m) => `${m.taskId}:${m.summary.slice(0, 24)}`).join(" | "));
  const devReceipts = k.getTask("dev-impl")?.execution.operationReceipts ?? [];
  check(
    "B. 구현 단계 typed write가 승인 경계를 지나 적용 영수증으로 닫혔다",
    devReceipts.some((r) => r.kind === "write_file" && (r.marker === "applied" || r.marker === "already_applied")),
    JSON.stringify(devReceipts.map((r) => `${r.kind}:${r.marker}`)),
  );
  const testReceipts = k.getTask("test-run")?.execution.operationReceipts ?? [];
  check(
    "B. **in-loop 테스트가 실제로 돌았다**: 승인된 entrypoint가 exitCode 0으로 닫혔다",
    testReceipts.some((r) => r.kind === "run_process" && r.marker === "applied" && r.exitCode === 0),
    JSON.stringify(testReceipts.map((r) => ({ kind: r.kind, marker: r.marker, exitCode: r.exitCode }))),
  );
  check("B. 최종 report가 산출물로 등록됐다", k.getState().artifacts.some((a) => a.path === "docs/REPORT.md"), JSON.stringify(k.getState().artifacts.map((a) => a.path)));
  check("C. 실제 사용량이 durable 회계에 누적됐다", k.getAccounting().tokensUsed > 0, JSON.stringify(k.getAccounting()));
  check("D. 사람 개입 0건(pause 없음)", !events.some((e) => e.kind === "task_paused"), JSON.stringify(events.filter((e) => e.kind === "task_paused").map((e) => `${e.taskId}:${e.marker}`)));
  check("controller lease를 끝나고 놓았다", !existsSyncSafe(runPaths(ws, RUN_ID).controllerLeaseFile) && report.leaseReleaseFailed === undefined);
  console.log("");
  console.log(`  경과: ${elapsedSec}s · 모델 왕복: ${events.filter((e) => e.kind === "task_started").length}회 · durable 토큰: ${k.getAccounting().tokensUsed}`);
  console.log(`  과금: Claude Code **구독 한도**만 소모(M8·M9 실측 실결제 $0) · Codex 0회`);
}

function existsSyncSafe(p) {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

console.log("");
console.log("증명하지 않는 것: **in-loop 리뷰 왕복(표현 불가 — 리뷰어는 fresh Codex여야 하고 autopilot backend는 claude 하나다 · 대장 C-97)** · red 테스트가 loop를 멈추는 것(offline Test 22 ⑨가 증명) · 산출물 품질 · 표본 1회");
console.log("===================================");
console.log(` M10 T6 live 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
