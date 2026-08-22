#!/usr/bin/env node
/**
 * V3 M10 T7 — **live: 무인 loop 안에서 리뷰 왕복이 돈다**(대장 `C-97`).
 *
 * ⚠️ Claude Code **구독** + Codex **구독**을 함께 소모한다. `acceptance.sh`에 등록하지 않는다(수동 전용).
 *
 * ## 무엇이 달라졌나
 *
 * M10까지 autopilot이 아는 live backend는 `claude-plan` 하나였고, 왕복 계약이 요구하는 **fresh Codex
 * read-only 리뷰어**를 loop가 만들 통로가 없었다(`C-97` — "표현 불가"). 이제 `qa-security` role family의
 * task는 **codex 리뷰어 세션**으로 돈다(`codexPlanWorker`). 이 스크립트는 그것을 한 번의 `runAutopilot`
 * 으로 밟고, 참가자 신원을 **durable에서 파생해** `assertCodeReviewRoundtrip`에 넣는다.
 *
 * ## 증명하려는 것
 *   A. 한 번의 실행이 저자(claude) → 리뷰 3종(codex) → 수정(claude) → verify(codex)를 완주한다.
 *   B. 리뷰어 turn이 **실제 codex 세션**이었다(모델·엔진 분업이 role에서 나온다).
 *   C. 그 참가자 집합이 **왕복 계약을 통과한다**(자기 승인 없음 · fresh 세션 · provider 분업 · read-only).
 *   D. 사람 개입 0건 · 실제 사용량이 durable 회계에 누적된다.
 *
 * ## 증명하지 않는다 (정직하게)
 *   - **개별 결과 발행까지 막지는 않는다**(V3 M11에서 좁혀진 `C-98` 잔여). 이제 승인이 `reviewRoundtrip`을
 *     담으면 **loop가** 왕복 계약을 강제한다(`verify`는 통과해야만 완료된다) — 그러나 앞선 참가자의
 *     결과는 그 시점에 이미 발행된 뒤다. 발행 자체를 kernel이 거부하려면 참가자 신원을 durable schema에
 *     넣어야 하고 그것은 state 마이그레이션이 딸린 별도 승인 범위다.
 *   - **freshness 축은 이 배선에서 동어반복이다**: worker가 turn마다 새 프로세스를 띄우고 resume하지
 *     않으므로 `fresh`는 늘 참이다. 실제로 판정되는 것은 provider 분업·sandbox·세션 재사용 없음·렌즈 집합이다.
 *   - **세션 신원은 `turnId`로 표현한다**: worker가 turn마다 새 프로세스를 띄우고 resume하지 않으므로
 *     1 turn = 1 fresh 세션이다(provider 세션 UUID를 durable에 넣는 것은 schema 변경이라 하지 않았다).
 *   - 리뷰 **내용**의 품질은 판정하지 않는다. 판정하는 것은 계약이다. 표본 1회.
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
const { runAutopilot, CODEX_REVIEWER_ROLE_FAMILY } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));
const { assertCodeReviewRoundtrip } = await import(join(REPO_ROOT, "src/exec/designReviewRoundtrip.ts"));

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

// ── fixture: 실제 파일이 있는 workspace + 3단계 DAG ─────────────────────────
const ws = realpathSync(mkdtempSync(join(tmpdir(), "m10-live-t7-ws-")));
mkdirSync(join(ws, "docs"), { recursive: true });
mkdirSync(join(ws, "src"), { recursive: true });
writeFileSync(join(ws, "src/calc.mjs"), "export const add = (a, b) => a + b;\n");
writeFileSync(join(ws, "docs/REVIEW.md"), "# 리뷰 노트\n\n- 렌즈별 소견\n");
writeFileSync(join(ws, "docs/VERIFY.md"), "# verify 노트\n\n- 수정 확인\n");
// **codex는 신뢰된 디렉터리를 요구한다**(실측: git repo가 아니면 거부하고 우리는 `--skip-git-repo-check`를
// 붙이지 않는다). v3 workspace는 어차피 승인된 checkout이므로 fixture도 같은 형태로 만든다.
for (const args of [
  ["init", "-q", "-b", "main"],
  ["-c", "user.email=t@t.io", "-c", "user.name=t", "add", "."],
  ["-c", "user.email=t@t.io", "-c", "user.name=t", "commit", "-qm", "fixture"],
]) {
  const r = spawnSync("/usr/bin/git", ["-C", ws, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture git 실패: ${args[0]} ${r.stderr ?? ""}`);
}

const claudeReal = realpathSync(process.env.HARNESS_CLAUDE_BIN ?? "/Users/jihun/.nvm/versions/node/v24.18.0/bin/claude");
const claudeSha = createHash("sha256").update(readFileSync(claudeReal)).digest("hex");
// **승인된 격리 `CLAUDE_CONFIG_DIR`**(V3 M11 · `C-86`). 사람이 1회 로그인해 둔 디렉터리다.
const CLAUDE_HOME = process.env.HARNESS_CLAUDE_HOME ?? "/Users/jihun/harness-claude-home";
// **wrapper가 아니라 실제 실행 파일을 승인한다**(대장 `B-27` · 감사 R6이 지목하는 바로 그 함정).
// `~/.nvm/.../bin/codex`는 `#!/usr/bin/env node` wrapper라 digest가 실제 추론 바이너리를 고정하지 못하고,
// 게다가 이 harness의 닫힌 env(자식에게 `CODEX_HOME` 하나)에서는 `env: node: No such file`로 **아예 뜨지
// 않는다**(V3 M10 T7 실측 — fail closed). 그래서 vendor 플랫폼 바이너리를 직접 승인한다.
const CODEX_DEFAULT_BIN =
  "/Users/jihun/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const codexReal = realpathSync(process.env.HARNESS_CODEX_BIN ?? CODEX_DEFAULT_BIN);
const codexSha = createHash("sha256").update(readFileSync(codexReal)).digest("hex");
const CODEX_HOME = process.env.HARNESS_CODEX_HOME ?? "/Users/jihun/harness-codex-home";
console.log(`\nV3 M10 T7 live — 무인 loop 안의 리뷰 왕복(claude 저자 + codex 리뷰어)${DRY ? " (--dry: LLM 0회)" : ""}`);
console.log(`  저자 worker : ${claudeReal}`);
console.log(`  리뷰어 worker: ${codexReal}`);
console.log(`  격리 홈      : ${CODEX_HOME}`);
console.log(`  workspace   : ${ws}`);

const manifest = {
  milestoneId: MILESTONE,
  approvedCommit: "a".repeat(40),
  writableRoots: ["docs", "src"],
  ownershipByTask: { "impl-author": ["src"], "review-code": ["docs"], "review-security": ["docs"], "review-test": ["docs"], "revise-impl": ["src"], "verify-fix": ["docs"] },
  allowedCommands: [],
  allowedDependencies: [],
  allowedNetworkDomains: [],
  executionAuthority: {
    // **live worker 실행 파일**(V3 M10 T3). 이 키가 없으면 live backend는 표현 불가다.
    claude: DRY ? null : { path: claudeReal, sha256: claudeSha },
    // **worker 세션의 자격증명 신원**(V3 M11 · 대장 `C-86`). 실행 파일만 승인하고 신원을 비우는 조합은
    // 이제 표현 불가다 — `approvedWorkerExecutable()`이 짝을 강제한다. 사람이 **1회**
    // `CLAUDE_CONFIG_DIR=<이 경로> claude`로 로그인해 둬야 하고 harness는 그 로그인을 대행하지 않는다.
    ...(DRY ? {} : { claudeHome: { path: CLAUDE_HOME } }),
    // 이 slice는 typed operation을 쓰지 않는다(리뷰 왕복만 본다) → entrypoint는 형태만 채운다.
    controllerEntrypoint: { path: "/opt/harness/controller.js", sha256: "b".repeat(64) },
    // **리뷰어 권위**(C-97): 승인에 이 두 키가 없으면 codex backend는 표현 불가다.
    codex: DRY ? null : { path: codexReal, sha256: codexSha },
    ...(DRY ? {} : { codexHome: { path: CODEX_HOME } }),
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
  operationAuthorityByTask: {},
  maxSessions: 4,
  maxTokens: 2_000_000,
  maxElapsedMs: 3_600_000,
  // **리뷰 왕복을 loop의 하드 게이트로 요구한다**(V3 M11 · 대장 `C-98`). 이 key가 있으면 `verify`는
  // 계약을 통과해야만 완료된다 — 즉 아래 check C는 이제 **스크립트의 사후 검사가 아니라 loop가 이미
  // 강제한 것의 재확인**이다(그 차이가 `C-98`이 말하던 전부였다).
  reviewRoundtrip: {
    author: "impl-author",
    reviews: { code: "review-code", security: "review-security", test: "review-test" },
    revision: "revise-impl",
    verify: "verify-fix",
  },
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
const ASSIGN = (objective, deliverable) => ASSIGNMENT(objective, deliverable);
kernel.createRootTask({
  taskId: "impl-author",
  roleId: "dev-lead",
  title: "구현(저자)",
  scope: "src 안에서만 작업한다",
  ownership: ["src"],
  assignmentMessageId: "asg-impl-author",
  assignmentBody: ASSIGN("이미 있는 `src/calc.mjs`를 이 task의 산출물로 선언하는 계획을 낸다.", "src/calc.mjs"),
});
for (const [taskId, lens] of [
  ["review-code", "코드 정확성"],
  ["review-security", "보안"],
  ["review-test", "테스트 관점"],
]) {
  kernel.createDependentTask({
    taskId,
    // **리뷰어 role family가 backend를 고른다**(C-97): `qa-security.*`는 codex 세션으로 돈다.
    roleId: `qa-security.${taskId.replace("review-", "")}`,
    title: `리뷰 — ${lens}`,
    scope: "읽기만 한다 — 산출물은 docs 안이다",
    ownership: ["docs"],
    dependsOn: ["impl-author"],
    assignmentMessageId: `asg-${taskId}`,
    assignmentBody: ASSIGN(`\`src/calc.mjs\`를 **${lens}** 렌즈로 검토하고, 이미 있는 \`docs/REVIEW.md\`를 산출물로 선언하는 계획을 낸다.`, "docs/REVIEW.md"),
  });
}
kernel.createDependentTask({
  taskId: "revise-impl",
  roleId: "dev-lead",
  title: "수정(저자와 다른 세션)",
  scope: "src 안에서만 작업한다",
  ownership: ["src"],
  dependsOn: ["review-code", "review-security", "review-test"],
  assignmentMessageId: "asg-revise-impl",
  assignmentBody: ASSIGN("리뷰 결과를 반영했다고 보고, 이미 있는 `src/calc.mjs`를 산출물로 선언하는 계획을 낸다.", "src/calc.mjs"),
});
kernel.createDependentTask({
  taskId: "verify-fix",
  roleId: "qa-security.verify",
  title: "verify(수정 확인)",
  scope: "읽기만 한다 — 산출물은 docs 안이다",
  ownership: ["docs"],
  dependsOn: ["revise-impl"],
  assignmentMessageId: "asg-verify-fix",
  assignmentBody: ASSIGN("수정 결과를 확인하고 이미 있는 `docs/VERIFY.md`를 산출물로 선언하는 계획을 낸다.", "docs/VERIFY.md"),
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
  const order = ["impl-author", "review-code", "review-security", "review-test", "revise-impl", "verify-fix"];
  check(
    "A. 한 번의 실행이 저자 → 리뷰 3종 → 수정 → verify를 완주한다",
    order.every((id) => k.getTask(id)?.state === "completed"),
    landed,
  );
  check("A. 계획 파일 0개로 돌았다(계획을 모델이 만들었다)", report.blocked === null, String(report.blocked));

  // **참가자 신원은 durable에서 파생한다**: role이 provider를, turnId가 세션을 표현한다
  // (worker가 turn마다 새 프로세스를 띄우고 resume하지 않으므로 1 turn = 1 fresh 세션이다).
  const participant = (taskId) => {
    const t = k.getTask(taskId);
    const codex = t.roleId.split(".")[0] === CODEX_REVIEWER_ROLE_FAMILY;
    return {
      taskId,
      roleId: t.roleId,
      provider: codex ? "codex" : "claude",
      sessionId: t.execution.turnId ?? "",
      ...(codex ? { sandbox: "read-only" } : {}),
      fresh: true,
    };
  };
  const roundtrip = {
    author: participant("impl-author"),
    reviews: { code: participant("review-code"), security: participant("review-security"), test: participant("review-test") },
    revision: participant("revise-impl"),
    verify: participant("verify-fix"),
    testLens: "test",
  };
  check(
    "B. 리뷰어 세 명 + verify가 codex로 돌았다(엔진 분업이 role에서 나온다)",
    [roundtrip.reviews.code, roundtrip.reviews.security, roundtrip.reviews.test, roundtrip.verify].every((p) => p.provider === "codex") &&
      roundtrip.author.provider === "claude" &&
      roundtrip.revision.provider === "claude",
    JSON.stringify(order.map((id) => `${id}:${participant(id).provider}`)),
  );
  check(
    "B. 세션 신원이 참가자마다 다르다(자기 승인·세션 재사용 없음)",
    new Set(order.map((id) => participant(id).sessionId)).size === order.length &&
      order.every((id) => participant(id).sessionId.length > 0),
    JSON.stringify(order.map((id) => participant(id).sessionId)),
  );
  let roundtripCode = "(통과)";
  try {
    assertCodeReviewRoundtrip(roundtrip);
  } catch (e) {
    roundtripCode = e?.code ?? String(e);
  }
  check("C. **왕복 계약을 통과한다**(assertCodeReviewRoundtrip)", roundtripCode === "(통과)", roundtripCode);
  // **loop가 이미 강제했다**(V3 M11 · `C-98`): 승인이 `reviewRoundtrip`을 담았으므로 `verify-fix`가
  // completed라는 사실 자체가 게이트를 통과했다는 뜻이다. 위 C는 그 재확인이고, 이 절이 **강제 여부**를
  // 직접 단정한다(둘을 나눠 적지 않으면 "스크립트가 검사했다"와 구별되지 않는다).
  check(
    "C. **loop가 강제했다** — 승인의 reviewRoundtrip 아래 verify가 완료됐다",
    k.getManifest().reviewRoundtrip !== undefined && k.getTask("verify-fix")?.state === "completed",
    JSON.stringify({ declared: k.getManifest().reviewRoundtrip !== undefined, verify: k.getTask("verify-fix")?.state }),
  );
  // 공허하지 않다는 대조군: 리뷰어를 저자와 같은 엔진으로 바꾸면 계약이 거부해야 한다.
  let negative = "(통과)";
  try {
    assertCodeReviewRoundtrip({ ...roundtrip, reviews: { ...roundtrip.reviews, code: { ...roundtrip.reviews.code, provider: "claude" } } });
  } catch (e) {
    negative = e?.code ?? String(e);
  }
  check("C. 대조군: 리뷰어를 claude로 바꾸면 계약이 거부한다(검사가 공허하지 않다)", negative !== "(통과)", negative);
  check("D. 실제 사용량이 durable 회계에 누적됐다", k.getAccounting().tokensUsed > 0, JSON.stringify(k.getAccounting()));
  check("D. 사람 개입 0건(pause 없음)", !events.some((e) => e.kind === "task_paused"), JSON.stringify(events.filter((e) => e.kind === "task_paused").map((e) => `${e.taskId}:${e.marker}`)));
  console.log("");
  console.log(`  경과: ${elapsedSec}s · 모델 왕복: ${events.filter((e) => e.kind === "task_started").length}회 · durable 토큰: ${k.getAccounting().tokensUsed}`);
  // **영수증은 실제로 뜬 세션을 센다**(T7 적대적 리뷰 A-2): 이 절은 T6에서 복사돼 "Codex 0회"라고
  // 적혀 있었는데 이 run은 codex 리뷰어를 실제로 띄운다. 세는 값은 durable role에서 파생한다.
  const codexTurns = order.filter((id) => participant(id).provider === "codex").length;
  console.log(`  과금: Claude Code 구독 ${order.length - codexTurns}회 + **Codex 구독 ${codexTurns}회**(M8·M9 실측 실결제 $0)`);
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
console.log("증명하지 않는 것: **개별 결과 발행까지는 막지 않는다**(loop가 왕복을 강제하지만 앞선 참가자 결과는 이미 발행된 뒤다 — C-98 잔여) · 세션 신원을 turnId로 표현한다(provider UUID는 durable에 없다) · 리뷰 내용의 품질 · 표본 1회");
console.log("===================================");
console.log(` M10 T7 live 결과: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
