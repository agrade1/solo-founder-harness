#!/usr/bin/env node
/**
 * V3 M5d — **offline self-hosting acceptance**.
 *
 * 네트워크·LLM·provider·TTY·git write·프로세스 spawn 없이 임시 workspace 하나에서만 돈다. 실패 시 exit 1.
 * `src/exec/*`·`src/commands/*`를 직접 소비한다(tracked `dist/`는 M5 handoff의 build 단계에서 갱신된다 —
 * dist를 소비하면 이 acceptance가 낡은 계약을 검사하며 green이 된다).
 *
 * ## 무엇을 증명하는가 (그리고 무엇을 증명하지 않는가 — 정직하게)
 *
 * **증명한다**: 승인 manifest **1건**으로 gate된 durable run에서, 사람이 프롬프트를 **한 번도 복사하지
 * 않고**(stdin 개입 0) autopilot이 fixture repo의 **실제 파일을 고쳐** task DAG를 완주시키고, 무인
 * 승인이 불가능한 turn은 **hang 없이 paused**로 착지해 복구되며, 진행이 관측 가능하고, 재시작이 예산·
 * 상태를 되살리며, 잔존 프로세스가 0이라는 것.
 *
 * **증명하지 않는다(닫힌 게이트라 표현조차 불가능하다)**:
 * - **live 추론 0** — Codex/Claude 호출이 없다(`B-23`·`B-7`/`B-9`가 live를 막는다). plan은 사람이
 *   authoring한 offline 문서이고 worker는 in-memory 데이터 어댑터다.
 * - **테스트 실행 없음** — typed `run_process`의 action enum은 `validate-plan` 하나이고 **읽기 전용**이다.
 *   "test → fresh review → verify"의 *실행* 부분은 이 acceptance의 범위 밖이다.
 * - **신규 파일 발행 없음** — `B-16`은 **부분 개방**이다(승인된 기존 파일 교체만). 신규 생성은 여전히
 *   fail closed이며 시나리오 ⑥이 그것을 단정한다.
 * - reviewer 왕복은 이 스크립트가 **전혀 다루지 않는다** — autopilot loop는 inbox 전달을 하지 않는다
 *   (`B-17` 미소비). 라우팅 계약 자체는 M4c acceptance가 덮는다.
 * - **deadline·cancellation 시 descendant 정리 없음** — 이 loop는 프로세스를 **0회** spawn하므로
 *   시나리오 ⑧의 "생존 자손 0"은 **cleanup의 증명이 아니라 spawn 부재의 확인**이다. M5 완료 조건의
 *   그 항목은 별도 시나리오가 필요하다(대장 `B-24`).
 * - **배타 resource class 동시 실행 0 미증명** — 이 run의 task들은 자원 class를 선언하지 않는다.
 *   M5 완료 조건의 해당 항목은 M4b acceptance가 부분적으로 덮고 여기서는 다루지 않는다(대장 `B-25`).
 * - **토큰 예산 소진 경로 미증명** — offline worker는 usage를 **항상 0으로 신고**한다. 따라서 이
 *   acceptance의 `tokensUsed`는 0이고, 예산 소진·경과 예산 집행은 여기서 검증되지 않는다
 *   (mock 단위 테스트가 덮는다). 시나리오 ⑦이 증명하는 것은 **durable 상태의 재수화**뿐이다.
 *
 * 시나리오:
 *   ① 승인 게이트: milestone이 다르면 durable state를 한 바이트도 바꾸지 않는다 →
 *   ② implement: 승인된 typed write로 fixture repo의 버그 파일이 **실제로** 고쳐지고 산출물이 발행된다 →
 *   ③ DAG 전진: 의존 task가 앞 task 완료 뒤에 같은 실행에서 이어 완주한다(수동 개입 0) →
 *   ④ 관측: 진행 이벤트가 남고 durable에도 기록된다(조용한 세션이 없다) →
 *   ⑤ hang 대신 pause: 승인 밖 operation은 paused로 착지하고 사람이 계획을 고치면 이어진다 →
 *   ⑥ 닫힌 게이트: 신규 파일 발행 · 승인 밖 경로 · 승인 밖 authority는 전부 바이트 0으로 거부된다 →
 *   ⑦ 재시작: kernel을 다시 열면 durable 상태(task·산출물·영수증·예산 deadline)가 그대로 복원된다 →
 *   ⑧ spawn 0회 확인(자손 정리의 증명이 **아니다**).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// src/*.ts를 직접 소비하므로 tsx 로더가 필요하다 — 로더 없이 들어왔으면 tsx로 정확히 한 번 재실행한다.
if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { createOrchestrationRun, openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runAutopilot } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));
const { REQUIRED_BODY_HEADINGS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));

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

const RUN_ID = "m5d-selfhost";
const MILESTONE = "m5d";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// tick은 **프로세스 전역으로 단조**다: 커밋 시각이 durable `updatedAt`보다 이르면 모든 mutation이
// `clock_invalid`이므로 kernel을 다시 열 때 시각이 되돌아가면 안 된다.
let clockTick = 0;
const clock = () => new Date(Date.UTC(2026, 7, 11, 0, 0, clockTick++));

/** fixture repo: 버그 있는 함수 1 + 그 버그를 설명하는 노트 1. **신규 생성이 필요 없게** 미리 존재한다. */
const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";
const NOTE_BEFORE = "# 상태\n\n- add()가 뺄셈을 한다(미수정)\n";
const NOTE_AFTER = "# 상태\n\n- add()를 덧셈으로 고쳤다\n";

function manifest() {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["src", "docs"],
    ownershipByTask: { implement: ["src"], verify: ["docs"], closed: ["src"] },
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
      maxTaskAttempts: 3,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 900_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    // **승인의 정본**: 이 두 레코드가 없으면 어떤 계획도 바이트를 내지 못한다.
    operationAuthorityByTask: {
      implement: [{ authorityId: "fix-add", kind: "write_file", path: "src/calc.js", maxBytes: 256 }],
      verify: [{ authorityId: "note", kind: "write_file", path: "docs/STATUS.md", maxBytes: 256 }],
      // ⑥용: **승인·경로·소유권이 전부 갖춰진** 신규 파일 — 그래도 발행은 막혀야 한다(`B-16` 잔여).
      closed: [{ authorityId: "publish", kind: "write_file", path: "src/new.js", maxBytes: 256 }],
    },
    maxSessions: 4,
    maxTokens: 10_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}

const body = (type) => REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n본문 한 줄.\n`).join("\n");
const seed = (taskId, ownership) => ({
  taskId,
  roleId: "tech-lead",
  title: `${taskId} 제목`,
  scope: `${taskId} bounded scope`,
  ownership,
  assignmentMessageId: `asg-${taskId}`,
  assignmentBody: body("task_assignment"),
});

function writePlan(planDir, taskId, plan) {
  writeFileSync(join(planDir, `${taskId}.json`), JSON.stringify(plan));
}

/** 이 프로세스의 자식 pid 집합(관측 시점의 `ps` 자신도 포함된다). */
function childPids() {
  const out = execFileSync("/bin/ps", ["-Ao", "ppid=,pid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pids = new Set();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m && Number(m[1]) === process.pid) pids.add(Number(m[2]));
  }
  return pids;
}

let ws;
let planDir;
const baselinePids = childPids();
try {
  ws = mkdtempSync(join(tmpdir(), "m5d-selfhost-ws-"));
  planDir = mkdtempSync(join(tmpdir(), "m5d-selfhost-plans-"));

  // ── fixture repo ─────────────────────────────────────────────────────────
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "docs"), { recursive: true });
  writeFileSync(join(ws, "src/calc.js"), BUGGY);
  writeFileSync(join(ws, "docs/STATUS.md"), NOTE_BEFORE);

  const kernel = createOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, manifest: manifest(), clock });
  kernel.createRootTask(seed("implement", ["src"]));
  kernel.createDependentTask({ ...seed("verify", ["docs"]), dependsOn: ["implement"] });

  console.log("\n① 승인 게이트");
  {
    const before = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).getState().revision;
    const report = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: "다른-마일스톤", planDir, clock });
    const after = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).getState().revision;
    check("다른 승인으로는 시작하지 않는다", report.blocked === "approval_milestone_mismatch", report.blocked ?? "");
    check("거부된 run이 durable state를 바꾸지 않는다", before === after, `${before} → ${after}`);
    check("파일도 건드리지 않았다", readFileSync(join(ws, "src/calc.js"), "utf8") === BUGGY);
  }

  console.log("\n⑤ hang 대신 pause (승인 밖 operation)");
  {
    // 승인되지 않은 authorityId를 요구하는 계획 — 무인으로 승인할 수 없다.
    writePlan(planDir, "implement", {
      operations: [
        { operationId: "op-1", kind: "write_file", authorityId: "not-approved", path: "src/calc.js", content: FIXED, expectedBeforeSha256: sha256(BUGGY) },
      ],
      result: { summary: "승인 밖 시도", outputs: [] },
    });
    const report = await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock });
    const task = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).getTask("implement");
    check("승인 밖 operation은 paused로 착지한다(hang 없음)", task.state === "paused", task.state);
    check("pause 사유가 사람 승인이다", task.execution.pauseReason === "approval_required", String(task.execution.pauseReason));
    check("바이트는 나가지 않았다", readFileSync(join(ws, "src/calc.js"), "utf8") === BUGGY);
    check("미확정 operation이 남지 않았다", task.execution.pendingOperations.length === 0);
    check("marker가 안정 코드다", report.tasks[0]?.marker === "operation_denied", String(report.tasks[0]?.marker));
    // 사람이 하는 일은 **계획을 고치는 것 하나**다(승인 문서를 바꾸지 않는다).
    openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).resumeTask({ taskId: "implement", actionId: "act-resume" });
  }

  console.log("\n②③④ implement → DAG 전진 → 관측");
  {
    writePlan(planDir, "implement", {
      operations: [
        { operationId: "op-1", kind: "write_file", authorityId: "fix-add", path: "src/calc.js", content: FIXED, expectedBeforeSha256: sha256(BUGGY) },
      ],
      result: { summary: "add()를 덧셈으로 고쳤다", outputs: [{ path: "src/calc.js", role: "output" }] },
    });
    writePlan(planDir, "verify", {
      operations: [
        { operationId: "op-1", kind: "write_file", authorityId: "note", path: "docs/STATUS.md", content: NOTE_AFTER, expectedBeforeSha256: sha256(NOTE_BEFORE) },
      ],
      result: { summary: "수정 사실을 기록했다", outputs: [{ path: "docs/STATUS.md", role: "output" }] },
    });

    const events = [];
    const report = await runAutopilot({
      workspaceRoot: ws,
      runId: RUN_ID,
      milestoneId: MILESTONE,
      planDir,
      clock,
      onEvent: (e) => events.push(e),
    });

    // ② 실제로 고쳐졌다 — 이것이 "self-hosting"의 implement 단계다.
    check("fixture repo의 버그 파일이 실제로 고쳐졌다", readFileSync(join(ws, "src/calc.js"), "utf8") === FIXED);
    // ③ 의존 task가 같은 실행에서 이어졌다(사람 개입 0).
    check("의존 task도 같은 실행에서 완주했다", readFileSync(join(ws, "docs/STATUS.md"), "utf8") === NOTE_AFTER);
    const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock });
    check("두 task 모두 completed다", k.getTask("implement").state === "completed" && k.getTask("verify").state === "completed",
      `${k.getTask("implement").state}/${k.getTask("verify").state}`);
    check("영수증 marker는 kernel이 만든 applied다",
      k.getTask("implement").execution.operationReceipts.every((r) => r.marker === "applied"));
    // 라벨이 "hash와 함께"라고 적으려면 실제로 hash를 봐야 한다(리뷰 C-1).
    const artifacts = k.getState().artifacts;
    const calc = artifacts.find((a) => a.path === "src/calc.js");
    check("산출물 2건이 발행됐다", artifacts.length >= 2, String(artifacts.length));
    check("발행된 hash가 디스크 내용과 일치한다", calc !== undefined && calc.sha256 === sha256(FIXED),
      calc ? calc.sha256.slice(0, 12) : "없음");
    // ④ 조용한 세션이 없다.
    check("진행 이벤트가 관측된다", events.some((e) => e.kind === "task_progress"));
    check("진행이 durable에도 남는다", k.getTask("implement").execution.progressCount > 0);
    check("stdin 개입 0으로 완주했다", report.blocked === null && report.tasks.every((t) => t.state === "completed"));
  }

  console.log("\n⑥ 닫힌 게이트는 그대로다");
  {
    const k = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock });
    // 두 task가 끝났으므로 새 task 하나로 닫힌 게이트를 확인한다.
    k.createRootTask(seed("closed", ["src"]));
    writePlan(planDir, "closed", {
      operations: [
        { operationId: "op-1", kind: "write_file", authorityId: "publish", path: "src/new.js", content: "x\n", expectedBeforeSha256: null },
      ],
      result: { summary: "신규 발행 시도", outputs: [] },
    });
    await runAutopilot({ workspaceRoot: ws, runId: RUN_ID, milestoneId: MILESTONE, planDir, clock });
    // **승인은 하나도 빠지지 않았다** — authority·경로·소유권·바이트 상한 전부 통과한다. 그럼에도
    // 부재 대상 발행은 막힌다. 이것이 `B-16`이 "부분" 개방인 이유다.
    check("승인이 다 있어도 신규 파일 발행은 fail closed다(B-16 잔여)", existsSync(join(ws, "src/new.js")) === false);
    const t = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock }).getTask("closed");
    check("닫힌 게이트도 hang 없이 paused다", t.state === "paused", t.state);
  }

  console.log("\n⑦ 재시작 — durable 재수화");
  {
    const before = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock });
    const beforeState = before.getState();
    const beforeAcc = before.getAccounting();
    const beforeReceipts = JSON.stringify(before.getTask("implement").execution.operationReceipts);

    // 같은 프로세스에서 다시 여는 것이지만 **디스크에서 rehydrate**한다(in-memory 재사용이 아니다).
    // 별도 프로세스 재시작(시계 되감김 포함)은 이 acceptance가 다루지 않는다(대장 `B-26`).
    const after = openOrchestrationRun({ workspaceRoot: ws, runId: RUN_ID, clock });
    const afterState = after.getState();

    check("완료된 task 상태가 복원된다", after.getTask("implement").state === "completed" && after.getTask("verify").state === "completed");
    check("발행된 산출물이 복원된다", afterState.artifacts.length === beforeState.artifacts.length && afterState.artifacts.length > 0,
      `${beforeState.artifacts.length} → ${afterState.artifacts.length}`);
    check("집행 영수증이 복원된다(marker·operationId 그대로)",
      JSON.stringify(after.getTask("implement").execution.operationReceipts) === beforeReceipts);
    check("revision이 되감기지 않는다", afterState.revision === beforeState.revision, `${beforeState.revision} → ${afterState.revision}`);
    // **경과 예산 deadline은 durable하게 고정된 값**이다 — 다시 열었다고 새로 생기지 않는다.
    check("경과 예산 deadline이 새로 생기지 않는다", after.getAccounting().budgetDeadlineAt === beforeAcc.budgetDeadlineAt,
      `${beforeAcc.budgetDeadlineAt} → ${after.getAccounting().budgetDeadlineAt}`);
    // **정직한 한정**: offline worker는 0 토큰을 신고하므로 토큰 회계는 이 acceptance에서 항상 0이다.
    // 이것을 "예산이 새로 생기지 않는다"의 증명으로 읽으면 안 된다 — 그래서 사실 그대로 단언한다.
    check("토큰 회계는 0이다(offline worker가 0을 신고한다 — 예산 소진 미증명)", after.getAccounting().tokensUsed === 0,
      String(after.getAccounting().tokensUsed));
    check("고친 바이트가 그대로다", readFileSync(join(ws, "src/calc.js"), "utf8") === FIXED);
  }

  console.log("\n⑧ spawn 0회 확인 (자손 정리의 증명이 아니다)");
  {
    // **이 체크는 구조적으로 상시 green이다** — 이 loop는 프로세스를 0회 spawn한다. 그래서 라벨에
    // 한정어를 단다: cleanup 코드를 통째로 지워도 이 체크는 red가 되지 않는다(대장 `B-24`).
    const first = childPids();
    const survivors = [...childPids()].filter((pid) => first.has(pid) && !baselinePids.has(pid));
    check("직계 자식 0 (spawn 0회 — deadline/cancellation 자손 정리 증명 아님)", survivors.length === 0, survivors.join(","));
  }
} catch (e) {
  fail += 1;
  console.log(`  FAIL 예외 발생 — ${e && e.stack ? e.stack : String(e)}`);
} finally {
  for (const dir of [ws, planDir]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 임시 디렉터리 정리 실패는 판정을 바꾸지 않는다 */
    }
  }
}

console.log("");
console.log("===================================");
console.log(` M5d offline self-hosting acceptance: PASS=${pass}  FAIL=${fail}`);
console.log("===================================");
process.exit(fail === 0 ? 0 : 1);
