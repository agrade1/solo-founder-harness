/**
 * V3 M12 L2a — **`harness plan-dag` / `harness validate-dag`** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/commands/planDag.test.ts`
 * 네트워크·LLM·프로세스 0. 임시 workspace에서만 돈다(무과금).
 *
 * 이 파일이 고정하는 계약:
 * - **아이디어 원문이 지시 본문 안에 실린다**(파일 읽기 통로를 여는 대신). 상한 초과는 **fail closed이며
 *   잘리지 않는다** — 그리고 그 거부는 durable에 아무것도 남기지 않는다.
 * - **승인을 발행하지 않는다**: node의 ownership·operations·provides는 전부 사람이 쓴 승인에서 파생되고,
 *   승인에 없으면 seed를 만들 수 없다.
 * - **문서 계약이 상수에서 파생된다**: `DAG_NODE_KEYS`를 늘리면 지시 산문도 같이 움직인다(M8 함정).
 * - `validate-dag`는 **읽기 전용**이며 불통과 초안을 지우지 않는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, OrchestrationError } from "../exec/orchestrationTypes.js";
import { openOrchestrationRun } from "../exec/orchestrationKernel.js";
import { runPaths } from "../exec/orchestrationStore.js";
import { DAG_NODE_KEYS, TASK_DAG_SCHEMA_VERSION, validateTaskDag } from "../exec/taskDag.js";
import { PLAN_DAG_TASK_ID, createPlanDagRun, dagContractBriefing, runValidateDagCommand } from "./planDag.js";

const RUN_ID = "m12-plan-run";
const MILESTONE = "m12-plan";
const DRAFT_PATH = "docs/dag-draft.json";

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
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

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
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
      maxNoProgressMs: 900_000,
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

interface Files {
  ws: string;
  approval: string;
  idea: string;
}

/** 실제 아이디어 문서처럼 **h2 heading과 코드 fence를 둘 다** 담는다(본문을 깨뜨릴 두 모양이다). */
const IDEA_TEXT = [
  "# 구독컷",
  "",
  "## 문제",
  "",
  "구독이 새는데 아무도 모른다.",
  "",
  "```json",
  '{ "예시": "fence 안의 JSON" }',
  "```",
  "",
  "## 목표",
  "",
  "3주 안에 MVP.",
].join("\n");

function files(manifestDoc: unknown, ideaText = IDEA_TEXT): Files {
  const d = makeDir("m12-plan-files-");
  const approval = join(d, "approval.json");
  const idea = join(d, "00_IDEA.md");
  writeFileSync(approval, JSON.stringify(manifestDoc));
  writeFileSync(idea, ideaText);
  return { ws: makeDir("m12-plan-ws-"), approval, idea };
}

function plan(f: Files, over: Partial<{ run: string; milestone: string }> = {}): ReturnType<typeof createPlanDagRun> {
  return createPlanDagRun({
    workspace: f.ws,
    run: over.run ?? RUN_ID,
    milestone: over.milestone ?? MILESTONE,
    approval: f.approval,
    idea: f.idea,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "(통과)";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `throw:${String(e)}`;
  }
}

function assignmentBody(f: Files): string {
  const k = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID });
  return k.messageBody(`asg-${PLAN_DAG_TASK_ID}`);
}

test("[M12/L2a] 아이디어 원문이 **지시 본문 안에** 실린다(파일 읽기 통로 없이)", () => {
  const f = files(manifest());
  const result = plan(f);
  assert.deepEqual(result.createdOrder, [PLAN_DAG_TASK_ID]);
  assert.deepEqual(result.draftPaths, [DRAFT_PATH]);

  const body = assignmentBody(f);
  // 원문의 **모든 줄**이 그대로(인용 접두사만 붙어) 들어 있어야 한다 — 요약도 발췌도 아니다.
  for (const line of IDEA_TEXT.split("\n")) {
    assert.ok(body.includes(`> ${line}`), `아이디어 줄이 지시에서 사라졌다: ${JSON.stringify(line)}`);
  }
  // 그리고 그 본문은 kernel의 body 검증을 실제로 지났다(가짜 heading·fence 짝 깨짐이 없다).
  assert.ok(body.includes("## Inputs and Contracts"));
  assert.ok(!/^## 문제$/m.test(body), "아이디어의 h2가 지시 본문의 진짜 heading이 됐다");
});

test("[M12/L2a] 승인된 write 권위가 operation 객체로 지시에 실린다(모델이 복사할 대상이 실재한다)", () => {
  const f = files(manifest());
  plan(f);
  const objects = [...assignmentBody(f).matchAll(/^\{"operationId".*\}$/gm)].map(
    (m) => JSON.parse(m[0]) as Record<string, unknown>,
  );
  assert.equal(objects.length, 1);
  assert.equal(objects[0].authorityId, "auth-draft");
  assert.equal(objects[0].path, DRAFT_PATH);
  // durable 지시 축도 같은 것을 가리킨다(kernel bind의 입력).
  const k = openOrchestrationRun({ workspaceRoot: f.ws, runId: RUN_ID });
  assert.deepEqual(k.getTask(PLAN_DAG_TASK_ID)!.assignedOperations, ["auth-draft"]);
});

test("[M12/L2a] 문서 계약이 **상수에서 파생**된다 — key 하나라도 빠지면 산출물이 매번 거부된다(M8 함정)", () => {
  // **key 목록 줄 자체**를 본다: 규칙 산문이 같은 이름을 다시 쓰므로 "본문 어딘가에 있다"는 공허하다
  // (mutation으로 실측했다 — 손으로 옮긴 낡은 목록이 그 검사를 통과했다).
  const keyLine = dagContractBriefing().split("\n").find((l) => l.includes("node의 key는 정확히 이것뿐이다")) ?? "";
  for (const k of DAG_NODE_KEYS) {
    assert.ok(keyLine.includes(`\`${k}\``), `node key가 지시 계약의 key 목록에서 빠졌다: ${k} — ${keyLine}`);
  }
  const briefing = dagContractBriefing();
  assert.ok(briefing.includes(`"${TASK_DAG_SCHEMA_VERSION}"`), "schemaVersion이 파생되지 않았다");
  const f = files(manifest());
  plan(f);
  assert.ok(assignmentBody(f).includes(`> - node의 key는 정확히 이것뿐이다`), "계약이 지시 본문에 실리지 않았다");
});

test("[M12/L2a] 아이디어가 상한을 넘으면 **fail closed** — 자르지 않고 run도 만들지 않는다", () => {
  const f = files(manifest(), "가".repeat(LIMITS.maxBodyBytes)); // UTF-8 3바이트 × 16384 = 48KB
  assert.equal(codeOf(() => plan(f)), "text_too_long");
  assert.ok(!existsSync(runPaths(f.ws, RUN_ID).dir), "거부됐는데 run 디렉터리가 남았다");

  // **상한 바로 아래도 거부될 수 있다**: 아이디어가 바이트 상한을 지나도 계약 산문과 합쳐진 본문은
  // 여전히 `maxBodyBytes`를 넘는다 → 그때도 run은 만들어지지 않아야 한다(부분 잔재 0).
  const g = files(manifest(), "a".repeat(LIMITS.maxBodyBytes - 1));
  assert.equal(codeOf(() => plan(g)), "text_too_long");
  assert.ok(!existsSync(runPaths(g.ws, RUN_ID).dir), "본문 상한 거부가 빈 run을 남겼다");
});

test("[M12/L2a] 아이디어 문서가 없거나 비었거나 UTF-8이 아니면 거부한다", () => {
  const f = files(manifest());
  assert.equal(
    codeOf(() => createPlanDagRun({ workspace: f.ws, run: RUN_ID, milestone: MILESTONE, approval: f.approval, idea: join(f.ws, "없다.md") })),
    "invalid_text",
  );
  assert.equal(codeOf(() => plan(files(manifest(), "   \n\n"))), "invalid_text");
  const d = makeDir("m12-plan-bin-");
  const bin = join(d, "idea.md");
  writeFileSync(bin, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  assert.equal(
    codeOf(() => createPlanDagRun({ workspace: makeDir("m12-plan-ws-"), run: RUN_ID, milestone: MILESTONE, approval: f.approval, idea: bin })),
    "invalid_text",
  );
});

test("[M12/L2a] **승인을 발행하지 않는다** — 승인에 없는 것은 파생할 수 없다", () => {
  // ⓐ ownershipByTask에 planner task가 없다.
  assert.equal(codeOf(() => plan(files(manifest({ ownershipByTask: { other: ["docs"] } })))), "dag_materialize_seed_rejected");
  // ⓑ write 권위가 없다(빈 승인).
  assert.equal(codeOf(() => plan(files(manifest({ operationAuthorityByTask: {} })))), "dag_materialize_seed_rejected");
  // ⓒ write가 아닌 권위만 있다 → 초안을 쓸 곳이 없다.
  const noWrite = manifest({
    allowedCommands: ["npm test"],
    operationAuthorityByTask: {
      [PLAN_DAG_TASK_ID]: [{ authorityId: "auth-wt", kind: "git_worktree", action: "add" }],
    },
  });
  assert.equal(codeOf(() => plan(files(noWrite))), "dag_materialize_seed_rejected");
  // ⓓ **대조군** — 같은 명령이 승인 안에서는 그대로 돈다(위 거부가 무조건 거부가 아니다).
  assert.deepEqual(plan(files(manifest())).createdOrder, [PLAN_DAG_TASK_ID]);
});

test("[M12/L2a] 승인이 정한 경로 밖으로는 초안을 낼 수 없다", () => {
  // planner task의 ownership 밖에 write 권위를 둔 승인. **승인 층이 먼저 잡는다**(`operation_not_owned`) —
  // `provides_not_owned`(문서 층)까지 가지도 않는다. 여기서 고정하는 것은 "그 조합이 통과하지 않는다"이며,
  // 어느 층이 잡는지는 승인 검증기가 정한다(이 명령이 두 번째 규칙을 만들지 않는다는 뜻이다).
  const crossed = manifest({
    writableRoots: ["docs", "src"],
    ownershipByTask: { [PLAN_DAG_TASK_ID]: ["docs"] },
    operationAuthorityByTask: {
      [PLAN_DAG_TASK_ID]: [{ authorityId: "auth-draft", kind: "write_file", path: "src/draft.json", maxBytes: 4096 }],
    },
  });
  assert.equal(codeOf(() => plan(files(crossed))), "operation_not_owned");
});

test("[M12/L2a] 같은 입력으로 다시 부르면 멱등이다(초안 run이 중복되지 않는다)", () => {
  const f = files(manifest());
  assert.deepEqual(plan(f).createdOrder, [PLAN_DAG_TASK_ID]);
  const again = plan(f);
  assert.equal(again.created, false);
  assert.deepEqual(again.createdOrder, [], "재호출이 task를 더 만들었다");
});

test("[M12/L2a] 초안이 바뀌면 이어받기가 거부된다 — 아이디어를 갈아끼우는 통로가 없다", () => {
  const f = files(manifest());
  plan(f);
  writeFileSync(f.idea, `${IDEA_TEXT}\n\n다른 아이디어를 덧붙였다.`);
  assert.equal(codeOf(() => plan(f)), "dag_materialize_run_not_empty");
});

test("[M12/L2a] validate-dag는 통과/불통과를 정직하게 판정하고 **초안을 지우지 않는다**", () => {
  const d = makeDir("m12-validate-");
  const ok = join(d, "ok.json");
  const bad = join(d, "bad.json");
  const okDoc = {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [{ taskId: "a", roleId: "pm", title: "t", scope: "s", ownership: ["docs"], dependsOn: [] }],
  };
  // 불통과 초안: 문서 안에 없는 task에 의존한다(모델이 실제로 내는 부류의 오류다).
  const badDoc = {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    tasks: [{ taskId: "a", roleId: "pm", title: "t", scope: "s", ownership: ["docs"], dependsOn: ["ghost"] }],
  };
  writeFileSync(ok, JSON.stringify(okDoc));
  writeFileSync(bad, JSON.stringify(badDoc));

  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    process.exitCode = 0;
    runValidateDagCommand({ file: ok });
    assert.equal(process.exitCode, 0);
    assert.ok(out.join("").includes("통과: task 1건"));

    out.length = 0;
    runValidateDagCommand({ file: bad });
    assert.equal(process.exitCode, 2, "불통과인데 exit 0이다");
    assert.ok(out.join("").includes("unknown_dependency"), out.join(""));
  } finally {
    process.stdout.write = orig;
    process.exitCode = 0;
  }

  // **불통과 초안이 지워지지 않는다** — 사람이 읽고 고칠 재료다.
  assert.ok(existsSync(bad));
  assert.equal(readFileSync(bad, "utf8"), JSON.stringify(badDoc));
  // 그리고 이 검사가 공허하지 않다: 같은 문서를 검증기에 직접 먹여도 같은 판정이다.
  assert.equal(codeOf(() => validateTaskDag(badDoc)), "unknown_dependency");
});
