#!/usr/bin/env node
/**
 * V3 M10 T3 — **live 1회: 무인 loop가 실제 모델 세션으로 기획→디자인→개발을 한 번에 돈다.**
 *
 * ⚠️ **Claude Code 구독 한도를 소모한다.** `acceptance.sh`에 등록하지 않는다(M5/M7/M8/M9 live probe와
 * 같은 규율: 수동 실행 전용). 실측한 인증: `claude` CLI는 구독 경로이며 M8·M9에서 실결제 $0이었다.
 * **Codex는 부르지 않는다**(이 스크립트에 리뷰 단계가 없다).
 *
 * ## M9 live와 무엇이 다른가 (이 스크립트의 존재 이유)
 *
 * M9 live는 **스크립트가 단계를 불렀다**(`askClaude()` → 발행 → 다음 단계). 그래서 M9 판정은
 * "end-to-end가 `runAutopilot` 무인 loop가 아니다 — **부분**"이었다. 여기서는 스크립트가 하는 일이
 * ⓐ fixture workspace와 승인 manifest를 만들고 ⓑ DAG task 3개를 만들고 ⓒ **`runAutopilot`을 한 번
 * 부르는 것**뿐이다. 프롬프트 조립·모델 호출·계획 검증·operation 집행·결과 발행·의존 순서는 전부
 * loop 안에서 일어난다.
 *
 * ## 증명하려는 것
 *   A. 무인 loop가 **한 번의 실행**으로 세 단계를 의존 순서대로 완주한다(계획 파일 0개).
 *   B. 각 단계가 **자기 지시와 문맥**을 프롬프트로 받아 서로 다른 계획을 낸다.
 *   C. 개발 단계의 typed operation이 **승인 경계를 지나** 영수증으로 닫힌다.
 *   D. 실제 사용량이 **durable 회계**에 누적된다(예산 게이트가 공허하지 않다).
 *
 * ## 증명하지 않는다 (정직하게)
 *   - **리뷰 왕복 없음**(fresh Codex 3종은 M9가 증명했다 — 여기서는 부르지 않는다).
 *   - **산출물 품질**을 판정하지 않는다. 판정하는 것은 "계약을 지켰는가"다.
 *   - 모델이 파일을 직접 쓰지 않는다(도구가 끊겨 있다). 쓰기는 kernel typed-write 채널뿐이다.
 *   - 표본 1회다. 재현률을 주장하지 않는다.
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

const RUN_ID = "m10-live";
const MILESTONE = "m10-live";
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

// ── fixture: 실제 파일이 있는 workspace + 3단계 DAG ─────────────────────────
const ws = realpathSync(mkdtempSync(join(tmpdir(), "m10-live-ws-")));
mkdirSync(join(ws, "docs"), { recursive: true });
mkdirSync(join(ws, "src"), { recursive: true });
// 모델은 도구가 끊겨 파일을 쓰지 못한다 → 산출물은 미리 두고, 개발 단계만 **승인된 typed write**로
// 같은 내용을 멱등 발행한다(`already_applied`). 이 스크립트가 보는 것은 계약이지 쓰기 성능이 아니다.
writeFileSync(join(ws, "docs/PLAN.md"), "# 기획 초안\n\n- 할 일: 계산기 모듈\n");
writeFileSync(join(ws, "docs/DESIGN.md"), "# 디자인 초안\n\n- 토큰: spacing/color\n");
writeFileSync(join(ws, "src/calc.ts"), "export const add = (a: number, b: number): number => a + b;\n");
const calcSha = createHash("sha256").update(readFileSync(join(ws, "src/calc.ts"))).digest("hex");

const claudeReal = realpathSync(process.env.HARNESS_CLAUDE_BIN ?? "/Users/jihun/.nvm/versions/node/v24.18.0/bin/claude");
const claudeSha = createHash("sha256").update(readFileSync(claudeReal)).digest("hex");
console.log(`\nV3 M10 T3 live — 무인 loop end-to-end${DRY ? " (--dry: LLM 0회)" : ""}`);
console.log(`  worker 실행 파일: ${claudeReal}`);
console.log(`  digest: ${claudeSha.slice(0, 16)}…  (승인 manifest에 이 값으로 박는다)`);
console.log(`  workspace: ${ws}`);

const manifest = {
  milestoneId: MILESTONE,
  approvedCommit: "a".repeat(40),
  writableRoots: ["docs", "src"],
  ownershipByTask: { "plan-pm": ["docs"], "design-ui": ["docs"], "dev-impl": ["src"] },
  allowedCommands: [],
  allowedDependencies: [],
  allowedNetworkDomains: [],
  executionAuthority: {
    // **live worker 실행 파일**(V3 M10 T3). 이 키가 없으면 live backend는 표현 불가다.
    claude: DRY ? null : { path: claudeReal, sha256: claudeSha },
    codex: null,
    controllerEntrypoint: { path: "/opt/harness/controller.js", sha256: "b".repeat(64) },
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
    "dev-impl": [{ authorityId: "auth-calc", kind: "write_file", path: "src/calc.ts", maxBytes: 512 }],
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
  taskId: "design-ui",
  roleId: "design",
  title: "계산기 UI 디자인",
  scope: "docs 안에서만 작업한다",
  ownership: ["docs"],
  dependsOn: ["plan-pm"],
  assignmentMessageId: "asg-design-ui",
  assignmentBody: ASSIGNMENT("이미 있는 `docs/DESIGN.md`를 이 task의 산출물로 선언하는 계획을 낸다.", "docs/DESIGN.md"),
});
kernel.createDependentTask({
  taskId: "dev-impl",
  roleId: "dev-lead",
  title: "계산기 구현",
  scope: "src 안에서만 작업한다",
  ownership: ["src"],
  dependsOn: ["design-ui"],
  assignmentMessageId: "asg-dev-impl",
  assignmentBody: ASSIGNMENT(
    "`src/calc.ts`를 승인된 typed operation으로 발행하고 산출물로 선언하는 계획을 낸다.",
    "src/calc.ts",
    `계획의 \`operations\`에 **아래 객체를 그대로** 넣어라(승인된 유일한 operation이다):\n\n` +
      `- \`{"operationId": "op-calc", "kind": "write_file", "authorityId": "auth-calc", "path": "src/calc.ts", "content": "export const add = (a: number, b: number): number => a + b;\\n", "expectedBeforeSha256": "${calcSha}"}\`\n`,
  ),
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
  check("A. 한 번의 실행이 세 단계를 의존 순서대로 완주한다", landed === "plan-pm:completed → design-ui:completed → dev-impl:completed", landed);
  check("A. 계획 파일 0개로 돌았다(계획을 모델이 만들었다)", report.blocked === null, String(report.blocked));
  check("B. 세 단계가 각각 다른 결과를 발행했다", new Set(results.map((m) => m.summary)).size === results.length && results.length === 3, results.map((m) => `${m.taskId}:${m.summary.slice(0, 28)}`).join(" | "));
  // marker까지 본다(리뷰 C4): 거부 영수증도 "닫혔다"로 세면 문구가 코드보다 강해진다.
  check(
    "C. 개발 단계 operation이 승인 경계를 지나 **적용된** 영수증으로 닫혔다",
    k.getTask("dev-impl")?.execution.operationReceipts.some((r) => r.kind === "write_file" && (r.marker === "applied" || r.marker === "already_applied")),
    JSON.stringify(k.getTask("dev-impl")?.execution.operationReceipts.map((r) => `${r.kind}:${r.marker}`) ?? []),
  );
  check("C. 산출물이 검증된 포인터로 등록됐다", k.getState().artifacts.length === 3, String(k.getState().artifacts.length));
  check("D. 실제 사용량이 durable 회계에 누적됐다", k.getAccounting().tokensUsed > 0, JSON.stringify(k.getAccounting()));
  check("사람 개입 0건(pause 없음)", !events.some((e) => e.kind === "task_paused"), JSON.stringify(events.filter((e) => e.kind === "task_paused").map((e) => `${e.taskId}:${e.marker}`)));
  check("controller lease를 끝나고 놓았다(실행 중 보유는 관측하지 않는다)", !existsSyncSafe(runPaths(ws, RUN_ID).controllerLeaseFile) && report.leaseReleaseFailed === undefined);
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
console.log("증명하지 않는 것: 리뷰 왕복(M9가 증명) · 산출물 품질 · 모델의 직접 파일 쓰기(도구 차단) · 표본 1회");
console.log("===================================");
console.log(` M10 T3 live 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
