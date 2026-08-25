#!/usr/bin/env node
/**
 * V3 M12 **L2a** — **아이디어 문서 → task DAG 문서 초안**을 한 줄로 잇는다
 * (offline · **live LLM 0회 · 무과금**).
 *
 * ## 왜 이 스크립트가 필요한가
 *
 * `B-38`이 만든 통로(지시에 operation 객체 → 모델이 복사 → typed write가 파일 생성)를 **하네스 자신에게**
 * 먹인다: 지금까지 `dag.json`은 사람이 손으로 썼다. 여기서는 그 문서를 **planner task가 산출물로 내고**,
 * 그 초안을 운영자가 `harness validate-dag`로 잰다.
 *
 * ## 증명하는 것
 *
 * ① `harness plan-dag`가 아이디어 문서 **원문 전부**를 지시 본문에 싣는다(줄 하나도 잃지 않는다) —
 *    그리고 h2·코드 fence가 든 실제 마크다운에서도 지시 본문 검증을 지난다
 * ② 문서 계약이 **상수에서 파생**돼 지시에 실린다(`DAG_NODE_KEYS`를 늘리면 지시도 같이 움직인다)
 * ③ 아이디어가 본문 상한을 넘으면 **fail closed** — 자르지 않고, run 디렉터리조차 남기지 않는다
 * ④ offline plan이 **지시에서 그대로 복사한** operation으로 `docs/dag-draft.json`을 **실제로 만들고**
 *    task가 `completed`로 착지한다 → 그 초안이 `validate-dag`를 **통과**한다(exit 0)
 * ⑤ 같은 통로로 나온 **불통과 초안**은 `validate-dag`가 exit 2로 정직하게 거부하되 **파일은 그대로 남는다**
 *    (typed write가 내용을 검증하지 않기 때문이다 — 사람이 읽고 고칠 재료를 지우지 않는다)
 * ⑥ **승인이 정본이다**: 승인에 planner task의 write 권위가 없으면 명령 자체가 fail closed다(+ 대조군)
 *
 * ## 증명하지 않는 것 (같은 무게로)
 *
 * - **실제 모델이 좋은 DAG를 내는가.** 여기서 "모델"은 지시 본문에서 operation 객체를 꺼내 `content`에
 *   미리 준비한 문서를 넣는 offline 대역이다. live 왕복(구독 소모)은 오케스트레이터가 닫는다.
 * - **초안의 품질**(task 분해가 타당한가)은 어떤 offline 검사로도 닫히지 않는다. 여기서 재는 것은
 *   **문서 계약 통과 여부**뿐이고, 그것이 곧 좋은 계획이라고 주장하지 않는다.
 * - live worker · 네트워크 · 실제 추론 0회. backend는 `offline-plan` 하나다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const CLI = join(REPO_ROOT, "src/cli.ts");
const { openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { runPaths } = await import(join(REPO_ROOT, "src/exec/orchestrationStore.ts"));
const { LIMITS } = await import(join(REPO_ROOT, "src/exec/orchestrationTypes.ts"));
const { DAG_DOCUMENT_KEYS, DAG_NODE_KEYS, TASK_DAG_SCHEMA_VERSION } = await import(join(REPO_ROOT, "src/exec/taskDag.ts"));
const { PLAN_DAG_TASK_ID } = await import(join(REPO_ROOT, "src/commands/planDag.ts"));
const { runAutopilot } = await import(join(REPO_ROOT, "src/commands/autopilot.ts"));

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
const dirs = [];
function makeDir(prefix) {
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

/** 실제 CLI를 argv로 띄운다(사람이 보는 것과 같은 표면 — exit code + 출력). */
function cli(...args) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const RUN_ID = "m12-l2a";
const MILESTONE = "m12-l2a";
const DRAFT_PATH = "docs/dag-draft.json";

// **주입 clock을 쓰지 않는다**: run을 만드는 것은 실제 CLI 서브프로세스(= 실제 시계)이므로, 뒤이은
// loop에 과거 시각을 주입하면 kernel이 `clock_invalid`로 거부한다. 이 스크립트는 시각 계약이 아니라
// 명령 배선을 재므로 실제 시계 그대로 돈다.

/** 실제 아이디어 문서의 모양 — **h2 heading과 코드 fence를 둘 다** 담는다(지시 본문을 깨뜨릴 두 모양이다). */
// **fixture는 실전 크기여야 한다**(M12 오케스트레이터 비평). 처음엔 236바이트였고, 그러면
// "모든 줄이 실렸다" 단정이 조용한 자르기 mutation(slice(0,2000) 등)을 잡지 못한다 —
// 2000자 미만 문서에서 그 mutation은 no-op이다. 아래 tail 반복이 문서를 ~6KB로 만들어
// (maxBodyBytes 16384 안) 자르기가 어디서 일어나든 뒤쪽 줄이 사라져 red가 된다.
const IDEA_LONG_TAIL = Array.from({ length: 60 }, (_, i) => `- 세부 요구사항 ${String(i + 1).padStart(2, "0")}: 구독 항목의 결제 주기·통화·해지 링크를 추적하고 월별 리포트에 합산한다`);
const IDEA_TEXT = [
  "# 구독컷 — 새는 구독을 잡는다",
  "",
  "## 문제",
  "",
  "사람들은 자기가 무엇을 구독 중인지 모른다.",
  "",
  "## 참고 데이터 모양",
  "",
  "```json",
  '{ "subscription": "netflix", "krw": 17000 }',
  "```",
  "",
  "## 목표",
  "",
  "3주 안에 MVP 하나.",
  "",
  "## 세부 요구사항",
  "",
  ...IDEA_LONG_TAIL,
].join("\n");

function manifest(over = {}) {
  return {
    milestoneId: MILESTONE,
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs"],
    ownershipByTask: { [PLAN_DAG_TASK_ID]: ["docs"] },
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
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {
      [PLAN_DAG_TASK_ID]: [{ authorityId: "auth-draft", kind: "write_file", path: DRAFT_PATH, maxBytes: 65_536 }],
    },
    maxSessions: 4,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2027-01-01T00:00:00.000Z",
    ...over,
  };
}

/** 운영자 파일 두 개(승인 + 아이디어)와 workspace를 깐다. */
function operatorFiles(manifestOver = {}, ideaText = IDEA_TEXT) {
  const d = makeDir("m12-l2a-files-");
  const approval = join(d, "approval.json");
  const idea = join(d, "00_IDEA.md");
  writeFileSync(approval, JSON.stringify(manifest(manifestOver), null, 2));
  writeFileSync(idea, ideaText);
  const ws = makeDir("m12-l2a-ws-");
  // typed write는 파일을 만들지만 **부모 디렉터리를 만들지 않는다**(승인은 경로 하나를 정할 뿐이다).
  mkdirSync(join(ws, "docs"), { recursive: true });
  return { ws, approval, idea };
}

const planDagArgs = (f) => ["plan-dag", "--workspace", f.ws, "--run", RUN_ID, "--milestone", MILESTONE, "--approval", f.approval, "--idea", f.idea];

/**
 * **모델이 하는 일의 offline 대역**: 지시 본문에서 operation 객체를 **그대로** 꺼내 `content`만 채운다.
 * 스크립트가 객체를 직접 지어내면 "복사만 하면 통과한다"는 주장이 공허해진다(B-38 스크립트와 같은 규율).
 */
function copyOperationsFromAssignment(body, content) {
  const found = [...body.matchAll(/^\{"operationId".*\}$/gm)].map((m) => JSON.parse(m[0]));
  return found.map((op) => (op.kind === "write_file" ? { ...op, content } : op));
}

/** 모델이 냈다고 치는 **통과하는** DAG 초안(계약을 지킨 2 task 파이프라인). */
const GOOD_DRAFT = JSON.stringify(
  {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [
      { taskId: "prd", roleId: "pm", title: "PRD 작성", scope: "docs 아래 PRD만", ownership: ["docs/prd"], dependsOn: [], provides: ["docs/prd/PRD.md"] },
      { taskId: "impl", roleId: "dev-lead", title: "구현", scope: "src 아래 구현만", ownership: ["src/app"], dependsOn: ["prd"], consumes: ["docs/prd/PRD.md"] },
    ],
  },
  null,
  2,
);

/** 모델이 냈다고 치는 **불통과** 초안 — 문서에 없는 task에 의존한다(실제로 잘 나오는 부류다). */
const BAD_DRAFT = JSON.stringify(
  {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [{ taskId: "impl", roleId: "dev-lead", title: "구현", scope: "src만", ownership: ["src/app"], dependsOn: ["prd"] }],
  },
  null,
  2,
);

/** plan-dag로 run을 세우고 → offline plan으로 초안을 발행시키고 → 초안 경로를 돌려준다. */
async function draftOnce(content) {
  const f = operatorFiles();
  const created = cli(...planDagArgs(f));
  if (created.status !== 0) throw new Error(`plan-dag가 실패했다: ${created.out}`);

  const kernel = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID });
  const body = kernel.messageBody(`asg-${PLAN_DAG_TASK_ID}`);
  const planDir = makeDir("m12-l2a-plans-");
  writeFileSync(
    join(planDir, `${PLAN_DAG_TASK_ID}.json`),
    JSON.stringify({
      operations: copyOperationsFromAssignment(body, content),
      result: { summary: "DAG 문서 초안을 발행했다", outputs: [{ path: DRAFT_PATH, role: "output" }] },
    }),
  );

  const file = join(f.ws, DRAFT_PATH);
  const before = existsSync(file);
  await runAutopilot({
    workspaceRoot: f.ws,
    runId: RUN_ID,
    milestoneId: MILESTONE,
    planDir,
    maxIterations: 4,
  });
  return { f, file, before, body, kernel: openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID }) };
}

console.log("① plan-dag가 아이디어 원문 전부를 지시 본문에 싣는다 (읽기 통로를 열지 않는다)");
{
  const f = operatorFiles();
  const r = cli(...planDagArgs(f));
  check("plan-dag가 exit 0으로 run을 만든다", r.status === 0, r.out);
  check("출력이 planner task와 초안 경로를 말한다", r.out.includes(DRAFT_PATH) && r.out.includes("planner task 1건"), r.out);

  const body = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID }).messageBody(`asg-${PLAN_DAG_TASK_ID}`);
  const missing = IDEA_TEXT.split("\n").filter((line) => !body.includes(`> ${line}`));
  check("아이디어 문서의 **모든 줄**이 지시에 실렸다(요약도 발췌도 아니다)", missing.length === 0, JSON.stringify(missing));
  check(
    "h2·코드 fence가 든 마크다운인데도 지시 본문이 계약을 지킨다(인용 접두사가 가짜 heading을 막는다)",
    body.includes("## Inputs and Contracts") && !/^## 문제$/m.test(body),
  );
  check(
    "그리고 그 본문은 kernel durable에 실재한다(주장이 아니라 저장된 바이트다)",
    existsSync(runPaths(f.ws, RUN_ID).dir),
  );

  console.log("\n② 문서 계약이 **상수에서 파생**된다 (M8 함정 — 생산자와 검증기가 갈리면 매번 거부된다)");
  // **key 목록 줄 자체**를 본다. "본문 어딘가에 그 단어가 있다"는 공허하다 — 규칙 산문이 같은 이름을
  // 다시 쓰므로 손으로 옮긴 낡은 목록도 통과한다(이 검사를 만들 때 mutation이 실제로 그것을 보여줬다).
  const keyLine = body.split("\n").find((l) => l.includes("node의 key는 정확히 이것뿐이다")) ?? "";
  const docLine = body.split("\n").find((l) => l.includes("문서 최상위 key는 정확히 이것뿐이다")) ?? "";
  const absent = DAG_NODE_KEYS.filter((k) => !keyLine.includes(`\`${k}\``));
  check("지시가 DAG node key 전부를 이름으로 싣는다", keyLine !== "" && absent.length === 0, `${JSON.stringify(absent)} / ${keyLine}`);
  const docAbsent = DAG_DOCUMENT_KEYS.filter((k) => !docLine.includes(`\`${k}\``));
  check("지시가 문서 최상위 key 전부를 싣는다", docLine !== "" && docAbsent.length === 0, `${JSON.stringify(docAbsent)} / ${docLine}`);
  check(`지시가 schemaVersion "${TASK_DAG_SCHEMA_VERSION}"을 상수에서 싣는다`, body.includes(`"${TASK_DAG_SCHEMA_VERSION}"`));
}

console.log("\n③ 아이디어가 본문 상한을 넘으면 fail closed — 자르지 않고 run도 남기지 않는다");
{
  const big = operatorFiles({}, "가".repeat(LIMITS.maxBodyBytes)); // UTF-8 3바이트 × 16384
  const r = cli(...planDagArgs(big));
  check("상한 초과 아이디어는 exit 2로 거부된다", r.status === 2, r.out);
  check("거부 사유가 상한임을 말한다(조용한 자르기가 아니다)", r.out.includes("text_too_long"), r.out);
  check("자르지 않는다는 것을 출력이 명시한다", r.out.includes("자르지 않는다"), r.out);
  check("거부는 run 디렉터리조차 만들지 않는다", !existsSync(runPaths(big.ws, RUN_ID).dir));
}

console.log("\n④ offline plan이 지시에서 복사한 operation으로 초안을 실제로 만든다 → validate-dag 통과");
{
  const { f, file, before, kernel } = await draftOnce(GOOD_DRAFT);
  check("집행 전에는 초안 파일이 없다(fixture를 깔지 않았다)", !before);
  check("typed write가 **디스크에 없던 초안 파일을 만들었다**", existsSync(file) && readFileSync(file, "utf8") === GOOD_DRAFT);
  check("planner task가 completed로 착지했다", kernel.getTask(PLAN_DAG_TASK_ID).state === "completed", kernel.getTask(PLAN_DAG_TASK_ID).state);
  check("초안이 검증된 artifact 포인터로 등록됐다", kernel.getState().artifacts.some((a) => a.path === DRAFT_PATH));

  const v = cli("validate-dag", file);
  check("validate-dag가 통과 초안을 exit 0으로 판정한다", v.status === 0, v.out);
  check("판정이 무엇을 봤는지 말한다(task 목록)", v.out.includes("통과: task 2건") && v.out.includes("prd"), v.out);
  check("그리고 이 명령은 초안을 그대로 둔다", readFileSync(file, "utf8") === GOOD_DRAFT);
  check("workspace 밖으로 새어나간 파일이 없다(승인 경로 하나만 생겼다)", existsSync(join(f.ws, "docs")) && !existsSync(join(f.ws, "src")));
}

console.log("\n⑤ 불통과 초안도 **산출물로 남는다** — 정직하게 거부하되 지우지 않는다");
{
  const { file } = await draftOnce(BAD_DRAFT);
  check("typed write는 내용을 판정하지 않는다 — 불통과 초안도 디스크에 만들어진다", existsSync(file));
  const v = cli("validate-dag", file);
  check("validate-dag가 불통과를 exit 2로 말한다", v.status === 2, v.out);
  check("거부 코드가 그대로 드러난다(사람이 고칠 수 있게)", v.out.includes("unknown_dependency"), v.out);
  check("**불통과 초안이 지워지지 않았다**", existsSync(file) && readFileSync(file, "utf8") === BAD_DRAFT);
  check("출력이 파일이 남아 있다고 말한다", v.out.includes("그대로 남아 있다"), v.out);
}

console.log("\n⑥ 승인이 정본이다 — 승인에 없는 권위는 이 명령이 만들지 못한다 (+ 대조군)");
{
  const noWrite = operatorFiles({ operationAuthorityByTask: {} });
  const a = cli(...planDagArgs(noWrite));
  check("planner task의 write 권위가 승인에 없으면 exit 2다", a.status === 2, a.out);
  check("거부 사유가 seed 거부다", a.out.includes("dag_materialize_seed_rejected"), a.out);
  check("거부는 run 디렉터리를 만들지 않는다", !existsSync(runPaths(noWrite.ws, RUN_ID).dir));

  const noOwner = operatorFiles({ ownershipByTask: { other: ["docs"] } });
  const b = cli(...planDagArgs(noOwner));
  check("ownershipByTask에 planner task가 없어도 exit 2다", b.status === 2, b.out);

  // **대조군** — 같은 명령이 승인 안에서는 그대로 돈다(위 거부가 무조건 거부가 아니다).
  const ok = operatorFiles();
  check("대조군: 승인이 갖춰지면 같은 명령이 run을 만든다", cli(...planDagArgs(ok)).status === 0);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
