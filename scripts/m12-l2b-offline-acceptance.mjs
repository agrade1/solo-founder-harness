#!/usr/bin/env node
/**
 * V3 M12 **L2b** — **DAG 문서 → 승인 manifest 초안**을 한 줄로 잇되, **그 초안이 그대로는 실행될 수
 * 없다**는 것을 재는 acceptance (offline · **live LLM 0회 · 무과금**).
 *
 * ## 왜 이 스크립트가 필요한가
 *
 * L2a가 남긴 병목이 "실행 승인 작성"이다: live 모델이 낸 12-task DAG를 돌리려면 사람이
 * `ownershipByTask` 12항목 + task별 operation 권위 + 실행 파일 digest를 손으로 써야 한다.
 * `draft-approval`은 그중 **기계적인 부분만** 뽑는다. 이 도구는 trust root에 가장 가까이 있으므로,
 * 여기서 재는 1번 축은 기능이 아니라 **경계**다.
 *
 * ## 증명하는 것
 *
 * ① **sentinel이 든 초안은 검증기를 실제로 못 지난다** — 초안 전체가 거부될 뿐 아니라, 나머지를 전부
 *    채우고 **sentinel 하나만 되돌려도** 그 하나가 혼자서 거부한다(자리마다 개별 확인).
 * ② **대조군** — 사람이 전부 채운 완성본은 `validate-approval`을 지나고 `autopilot-create`까지 간다
 *    (①의 거부가 무조건 거부가 아니다).
 * ③ **12-task DAG에서 ownership·권위가 전부 파생된다**(경로는 DAG의 `provides` 그대로 · 하나도 빠지지 않는다).
 * ④ **PATH 자동 발견이 없다** — `PATH`에 승인 후보 이름을 깔아 두고 플래그 없이 돌려도 그 자리는
 *    sentinel이다. 플래그를 주면(대조군) **그 파일의 실제 digest**가 실린다.
 * ⑤ **불통과 초안을 지우지 않는다** — 판정은 read-only이고, 재실행도 채우던 초안을 덮어쓰지 않는다.
 *
 * ## 증명하지 않는 것 (같은 무게로)
 *
 * - **초안의 값이 옳은 승인인가.** 여기서 재는 것은 "파생이 DAG와 일치하는가"와 "채우기 전에는 못
 *   지나는가"뿐이다. 어떤 경로에 얼마만큼의 쓰기를 승인할지는 사람의 판단이며 어떤 검사도 대신하지 않는다.
 * - **live 왕복.** 모델 호출 0회. 여기 쓰는 DAG는 L2a가 낸 12-task 초안의 **모양**을 본뜬 fixture다.
 * - **채운 승인으로 12-task를 실제로 완주하는 것**(multi-task live)은 여전히 미실측이다.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
const { validateApprovalManifest } = await import(join(REPO_ROOT, "src/exec/approvalManifest.ts"));
const { openOrchestrationRun } = await import(join(REPO_ROOT, "src/exec/orchestrationKernel.ts"));
const { SENTINEL_PREFIX, sentinelPaths } = await import(join(REPO_ROOT, "src/commands/draftApproval.ts"));

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
  // macOS의 `/var/folders/…`는 symlink다 — 실행 파일 경로 계약(집행기)이 정규 경로를 요구한다.
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
function cli(args, env = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1", ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const MILESTONE = "m12-l2b";

/**
 * **L2a가 낸 12-task 초안의 모양**을 본뜬 DAG(research → pm → ux/tech → 기능 4개 병렬 → 통합 점검).
 * `wired`면 각 node가 `draft-approval`이 지을 authorityId를 `operations`로 참조한다 —
 * 사람이 초안의 id를 DAG에 옮겨 적은 상태다.
 */
function dag12(wired) {
  const node = (taskId, roleId, own, provides, dependsOn = [], consumes = []) => ({
    taskId,
    roleId,
    title: taskId,
    scope: `${taskId} 범위`,
    ownership: [own],
    dependsOn,
    provides: [provides],
    ...(consumes.length > 0 ? { consumes } : {}),
    ...(wired ? { operations: [`${taskId}-w1`] } : {}),
  });
  return {
    schemaVersion: "1",
    tasks: [
      node("market-scan", "research", "docs/research", "docs/research/MARKET_SCAN.md"),
      node("prd", "pm", "docs/prd", "docs/prd/PRD.md", ["market-scan"], ["docs/research/MARKET_SCAN.md"]),
      node("ux-flows", "ux", "docs/ux", "docs/ux/FLOWS.md", ["prd"], ["docs/prd/PRD.md"]),
      node("design-direction", "design", "docs/design", "docs/design/DIRECTION.md", ["ux-flows"], ["docs/ux/FLOWS.md"]),
      node("data-model", "tech-lead", "docs/tech", "docs/tech/DATA_MODEL.md", ["prd"], ["docs/prd/PRD.md"]),
      node("privacy-review", "qa-security.privacy", "docs/privacy", "docs/privacy/REVIEW.md", ["data-model"], ["docs/tech/DATA_MODEL.md"]),
      node("app-shell", "dev-lead", "src/shell", "src/shell/App.tsx", ["design-direction", "data-model"], ["docs/design/DIRECTION.md"]),
      node("feat-list", "dev-lead", "src/features/list", "src/features/list/index.ts", ["app-shell"]),
      node("feat-dashboard", "dev-lead", "src/features/dashboard", "src/features/dashboard/index.ts", ["app-shell"]),
      node("feat-reminders", "dev-lead", "src/features/reminders", "src/features/reminders/index.ts", ["app-shell"]),
      node("feat-cancel", "dev-lead", "src/features/cancel", "src/features/cancel/index.ts", ["app-shell"]),
      node(
        "integration-check",
        "qa-security",
        "docs/qa",
        "docs/qa/INTEGRATION.md",
        ["feat-list", "feat-dashboard", "feat-reminders", "feat-cancel", "privacy-review"],
        ["docs/privacy/REVIEW.md"],
      ),
    ],
  };
}

function writeJson(dir, name, value) {
  const f = join(dir, name);
  writeFileSync(f, JSON.stringify(value, null, 2));
  return f;
}

/** **사람이 채운다**를 코드로 흉내낸 것 — sentinel 자리를 전부 유효한 값으로 바꾼다. */
function fillDraft(draft) {
  const filled = JSON.parse(JSON.stringify(draft));
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
  for (const [k, v] of Object.entries(filled.executionAuthority)) {
    if (v !== null && typeof v === "object") filled.executionAuthority[k] = { path: `/opt/harness/${k}`, sha256: "b".repeat(64) };
  }
  for (const ops of Object.values(filled.operationAuthorityByTask)) for (const op of ops) op.maxBytes = 65_536;
  return filled;
}

/** `a.b[0].c` 표기(=`sentinelPaths`가 내는 것)로 값을 읽고 쓴다. */
const steps = (dotted) => dotted.split(".").flatMap((seg) => {
  const [head, ...idx] = seg.split("[");
  return [head, ...idx.map((i) => i.replace("]", ""))];
});
function readAt(root, dotted) {
  let cur = root;
  for (const s of steps(dotted)) cur = cur[s];
  return cur;
}
function setAt(root, dotted, value) {
  const path = steps(dotted);
  let cur = root;
  for (const s of path.slice(0, -1)) cur = cur[s];
  cur[path[path.length - 1]] = value;
}

const files = makeDir("m12-l2b-files-");
const DAG_PLAIN = writeJson(files, "dag.json", dag12(false));
const DAG_WIRED = writeJson(files, "dag-wired.json", dag12(true));
const DRAFT = join(files, "approval-draft.json");

console.log("① draft-approval이 12-task DAG에서 ownership·write 권위를 전부 파생한다");
let draft;
{
  const r = cli(["draft-approval", "--dag", DAG_PLAIN, "--milestone", MILESTONE, "--out", DRAFT]);
  check("draft-approval이 exit 0으로 초안을 쓴다", r.status === 0, r.out);
  check("초안 파일이 생겼다", existsSync(DRAFT));
  draft = JSON.parse(readFileSync(DRAFT, "utf8"));

  const doc = dag12(false);
  const ownershipOk = doc.tasks.every((n) => JSON.stringify(draft.ownershipByTask[n.taskId]) === JSON.stringify(n.ownership));
  check("task 12건의 ownership이 DAG node에서 그대로 파생됐다(하나도 빠지지 않는다)", Object.keys(draft.ownershipByTask).length === 12 && ownershipOk);
  const opsOk = doc.tasks.every((n) => {
    const ops = draft.operationAuthorityByTask[n.taskId];
    return ops?.length === 1 && ops[0].kind === "write_file" && ops[0].path === n.provides[0];
  });
  check("provides 경로마다 write_file 권위 1건이 파생됐다(경로는 DAG가 정한 그대로다)", opsOk);
  check("출력이 검토를 요구한다(그대로 넘기지 말라고 말한다)", r.out.includes("검토 없이 넘기지 마라"), r.out);
  check("출력이 사람이 채울 자리를 이름으로 낸다", r.out.includes("expiresAt") && r.out.includes("autopilotPolicy.maxTaskAttempts"), r.out);
  check("출력이 writableRoots가 덮어야 할 경로를 낸다(값은 사람이 적는다)", r.out.includes("writableRoots는 아래 ownership 경로를"), r.out);
  check(
    "출력이 authorityId → path 짝을 낸다(사람이 확인하고 DAG에 옮겨 적을 재료)",
    r.out.includes("prd-w1 → docs/prd/PRD.md"),
    r.out,
  );
  check(
    "DAG가 operations를 말하지 않으면 '승인만 채워도 아무 파일도 만들지 못한다'고 경고한다",
    r.out.includes("아무 파일도 만들지 못한다"),
    r.out,
  );
  // **초안이 승인을 넓히지 않는다**: 사람이 말한 적 없는 경로·명령·의존·도메인이 들어 있지 않다.
  check(
    "허용 목록은 전부 비어 있고 병합은 꺼져 있다(말하지 않은 것은 승인되지 않는다)",
    draft.allowedCommands.length === 0 &&
      draft.allowedDependencies.length === 0 &&
      draft.allowedNetworkDomains.length === 0 &&
      draft.localMergeAllowed === false,
  );
}

console.log("\n② sentinel이 든 초안은 검증기를 **실제로** 못 지난다 (자리마다 개별 확인)");
{
  const v = cli(["validate-approval", DRAFT]);
  check("validate-approval이 초안을 exit 2로 거부한다", v.status === 2, v.out);
  const remaining = sentinelPaths(draft);
  check(`남은 자리 ${remaining.length}건을 전부 이름으로 낸다`, remaining.length >= 20 && remaining.every((p) => v.out.includes(p)), v.out);

  // **어느 자리가 sentinel이어야 하는가**를 이름으로 고정한다. 이것이 없으면 "sentinel이 든 자리는
  // 거부된다"만 증명되고, 한 자리에 그럴듯한 기본값이 들어와도 아무 검사도 울지 않는다.
  const mustBeSentinel = [
    "approvedCommit",
    "expiresAt",
    "maxTokens",
    "maxSessions",
    "maxElapsedMs",
    "writableRoots[0]",
    ...["maxTaskAttempts", "maxDeliveryAttempts", "retryBackoffMs", "deliveryDeadlineMs", "maxNoProgressMs", "maxAttemptElapsedMs", "cleanupTermGraceMs", "cleanupKillGraceMs"].map((k) => `autopilotPolicy.${k}`),
    ...["claude", "git", "node", "processObserver", "controllerEntrypoint"].flatMap((k) => [`executionAuthority.${k}.path`, `executionAuthority.${k}.sha256`]),
    ...Object.keys(draft.operationAuthorityByTask).map((t) => `operationAuthorityByTask.${t}[0].maxBytes`),
  ];
  const chosen = mustBeSentinel.filter((p) => !remaining.includes(p));
  check(`권위-의미 자리 ${mustBeSentinel.length}건이 전부 sentinel이다(초안이 값을 대신 고르지 않는다)`, chosen.length === 0, JSON.stringify(chosen));

  // **하나만 남겨도 혼자서 막는다.** "어차피 다른 필드가 막는다"로 이 단정이 공허해지는 것을 닫는다.
  const survived = [];
  const codes = new Set();
  for (const p of remaining) {
    const one = fillDraft(draft);
    setAt(one, p, readAt(draft, p));
    try {
      validateApprovalManifest(one);
      survived.push(p);
    } catch (e) {
      codes.add(e?.code ?? "unknown");
    }
  }
  check(`sentinel ${remaining.length}건이 **각각 혼자서** 승인 검증기를 막는다`, survived.length === 0, JSON.stringify(survived));
  check("거부 사유가 승인 계약의 안정 코드다(무작위 예외가 아니다)", [...codes].every((c) => c.startsWith("invalid_") || c.endsWith("_outside_writable_root")), JSON.stringify([...codes]));
}

console.log("\n③ 대조군 — 사람이 채운 완성본은 통과하고 autopilot-create까지 간다");
{
  const filled = writeJson(files, "approval-filled.json", fillDraft(draft));
  const v = cli(["validate-approval", filled]);
  check("채운 승인은 validate-approval을 exit 0으로 지난다", v.status === 0, v.out);
  check("통과 출력이 무엇을 판정했는지 말한다", v.out.includes("통과"), v.out);

  const ws = makeDir("m12-l2b-ws-");
  const c = cli(["autopilot-create", "--workspace", ws, "--run", "l2b-run", "--milestone", MILESTONE, "--approval", filled, "--dag", DAG_WIRED]);
  check("그 승인으로 autopilot-create가 12-task run을 만든다", c.status === 0, c.out);
  check("run에 task 12건이 실재한다", c.out.includes("task 12건"), c.out);

  const kernel = openOrchestrationRun({ workspaceRoot: ws, runId: "l2b-run" });
  check(
    "DAG에 옮겨 적은 authorityId가 지시 축(assignedOperations)으로 굳었다",
    JSON.stringify(kernel.getTask("prd").assignedOperations) === JSON.stringify(["prd-w1"]),
    JSON.stringify(kernel.getTask("prd").assignedOperations),
  );

  // **초안의 id를 존중한다**: 이미 `operations`를 말한 DAG로 초안을 뽑아도 같은 id가 나온다
  // (새 이름을 지으면 그 DAG는 어떤 승인으로도 물질화되지 않는다).
  const wiredDraft = join(files, "wired-draft.json");
  const w = cli(["draft-approval", "--dag", DAG_WIRED, "--milestone", MILESTONE, "--out", wiredDraft]);
  const wd = JSON.parse(readFileSync(wiredDraft, "utf8"));
  check("DAG가 말한 authorityId를 그대로 쓴다(새로 짓지 않는다)", w.status === 0 && wd.operationAuthorityByTask["prd"][0].authorityId === "prd-w1", w.out);
  check("그 경우에는 '아무 파일도 만들지 못한다' 경고가 나오지 않는다(경고가 상수가 아니다)", !w.out.includes("아무 파일도 만들지 못한다"), w.out);
}

console.log("\n④ PATH 자동 발견이 없다 — 플래그가 없으면 sentinel이다 (+ 대조군)");
{
  // `PATH`에 승인 후보 이름을 전부 깔아 둔다. 하네스가 조용히 찾는다면 여기서 잡힌다.
  const binDir = makeDir("m12-l2b-bin-");
  for (const name of ["claude", "git", "node", "ps"]) {
    const p = join(binDir, name);
    writeFileSync(p, `#!/bin/sh\necho ${name}\n`);
    chmodSync(p, 0o755);
  }
  const out = join(files, "path-draft.json");
  const r = cli(["draft-approval", "--dag", DAG_PLAIN, "--milestone", MILESTONE, "--out", out], { PATH: `${binDir}:${process.env.PATH}` });
  const d = JSON.parse(readFileSync(out, "utf8"));
  const auth = d.executionAuthority;
  const allSentinel = ["claude", "git", "node", "processObserver", "controllerEntrypoint"].every(
    (k) => auth[k].path.startsWith(SENTINEL_PREFIX) && auth[k].sha256.startsWith(SENTINEL_PREFIX),
  );
  check("PATH에 후보가 있어도 실행 파일 자리는 전부 sentinel이다(조용히 찾지 않는다)", r.status === 0 && allSentinel, JSON.stringify(auth));
  check("초안 어디에도 그 PATH 디렉터리가 등장하지 않는다", !readFileSync(out, "utf8").includes(binDir));
  check("codex는 null(미승인)이다 — 기본 승인을 만들지 않는다", auth.codex === null);

  // **대조군** — 사람이 명시하면 **그 파일의 실제 digest**가 실린다(= 위 sentinel이 무조건이 아니다).
  const bin = join(binDir, "git");
  const named = join(files, "named-draft.json");
  const g = cli(["draft-approval", "--dag", DAG_PLAIN, "--milestone", MILESTONE, "--out", named, "--git", bin]);
  const nd = JSON.parse(readFileSync(named, "utf8"));
  const wantDigest = createHash("sha256").update(readFileSync(bin)).digest("hex");
  check("대조군: --git을 주면 그 경로가 그대로 실린다", g.status === 0 && nd.executionAuthority.git.path === bin, g.out);
  check("대조군: digest가 그 파일 내용의 sha256이다(지어낸 값이 아니다)", nd.executionAuthority.git.sha256 === wantDigest);
  check("나머지 실행 파일 자리는 여전히 sentinel이다(하나를 준다고 나머지를 찾아 주지 않는다)", nd.executionAuthority.node.path.startsWith(SENTINEL_PREFIX));

  // 집행기가 거부할 경로는 초안도 거부한다 — 돌 수 없는 승인을 지어내지 않는다.
  const link = join(binDir, "git-link");
  symlinkSync(bin, link);
  const s = cli(["draft-approval", "--dag", DAG_PLAIN, "--milestone", MILESTONE, "--out", join(files, "link-draft.json"), "--git", link]);
  check("symlink 경로는 집행기와 같은 이유로 거부된다", s.status === 2 && s.out.includes("draft_executable_untrusted"), s.out);
  check("그 거부는 초안 파일을 만들지 않는다", !existsSync(join(files, "link-draft.json")));
}

console.log("\n⑤ 불통과 초안을 지우지 않는다 — 판정은 read-only이고 재실행도 덮어쓰지 않는다");
{
  const before = readFileSync(DRAFT, "utf8");
  const v = cli(["validate-approval", DRAFT]);
  check("불통과 판정 뒤에도 초안이 바이트 동일하다", v.status === 2 && readFileSync(DRAFT, "utf8") === before);
  check("출력이 파일이 남아 있다고 말한다", v.out.includes("그대로 남아 있다"), v.out);

  // 사람이 절반쯤 채운 상태를 흉내낸다 — 재실행이 그것을 지우면 채운 권위 값이 조용히 사라진다.
  const half = JSON.parse(before);
  half.expiresAt = "2027-01-01T00:00:00.000Z";
  writeFileSync(DRAFT, JSON.stringify(half, null, 2));
  const again = cli(["draft-approval", "--dag", DAG_PLAIN, "--milestone", MILESTONE, "--out", DRAFT]);
  check("재실행은 채우던 초안을 덮어쓰지 않는다", again.status === 2 && again.out.includes("draft_output_exists"), again.out);
  check("사람이 채운 값이 그대로 남아 있다", JSON.parse(readFileSync(DRAFT, "utf8")).expiresAt === "2027-01-01T00:00:00.000Z");

  // 이름이 초안이라고 말하지 않는 파일은 만들지 않는다.
  const misnamed = join(files, "approval.json");
  const m = cli(["draft-approval", "--dag", DAG_PLAIN, "--milestone", MILESTONE, "--out", misnamed]);
  check("출력 이름에 draft가 없으면 거부한다", m.status === 2 && m.out.includes("draft_output_name_not_draft"), m.out);
  check("그 거부도 파일을 만들지 않는다", !existsSync(misnamed));

  // 계약을 어긴 DAG로는 초안 자체가 없다(fail closed).
  const badDag = writeJson(files, "bad-dag.json", {
    schemaVersion: "1",
    tasks: [{ taskId: "impl", roleId: "dev-lead", title: "구현", scope: "s", ownership: ["src"], dependsOn: ["prd"] }],
  });
  const b = cli(["draft-approval", "--dag", badDag, "--milestone", MILESTONE, "--out", join(files, "bad-draft.json")]);
  check("검증되지 않은 DAG로는 초안을 만들지 않는다(fail closed)", b.status === 2 && b.out.includes("unknown_dependency"), b.out);
  check("그 거부도 파일을 만들지 않는다", !existsSync(join(files, "bad-draft.json")));
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
