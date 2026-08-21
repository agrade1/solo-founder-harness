#!/usr/bin/env node
/**
 * V3 M10 T5 — **도그푸딩 승인 manifest 정적 감사**(`C-67` 릴리스 게이트). read-only.
 *
 * 대상 2개(사용자 승인): ⓐ 이 harness 레포 ⓑ `~/Desktop/구독컷`(env `HARNESS_DOGFOOD_PROJECT`로 덮는다).
 * 로드맵은 "2~3개"라고 적었으므로 **2개는 하한**이다 — 판정에 그렇게 적는다.
 *
 * 하는 일은 넷이다: ⓐ 두 프로젝트의 디렉터리 구조를 **읽고** ⓑ "내가 그 프로젝트에서 마일스톤을
 * 승인한다면"의 `MilestoneApprovalManifest`를 써서 ⓒ `validateApprovalManifest` →
 * `auditApprovalManifest`(M7의 R1~R5 **다섯 규칙 그대로** — 새 규칙을 만들지 않는다)를 돌리고
 * ⓓ 결과를 **있는 그대로** 출력한다.
 *
 * ## 증명하지 않는다 (정직하게 적는다)
 * - **LLM 0회 · 네트워크 0 · 쓰기 0.** 뜨는 프로세스는 **read-only `git rev-parse` 조회 여러 개**
 *   (manifest의 `approvedCommit` 2 · NFD 정규형 측정 1 · probe 3·4의 경계 조회)와 **tsx 재기동 1개**다.
 * - **acceptance에 등록하지 않는다**: 대상 경로가 이 레포 밖(사용자 홈)이라 다른 기계에서 재현되지
 *   않는다. `scripts/acceptance.sh`에 넣으면 남의 기계에서 **거짓 red**가 된다.
 * - **"감사 finding 0 = 그 프로젝트에서 orchestration이 돈다"가 아니다.** probe 3·4가 그 반례다:
 *   R1~R5는 manifest **내부의 모순·과승인**만 보고, 실행 가능성(checkout 신원·승인 커밋)은 보지 않는다.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = process.env.HARNESS_DOGFOOD_PROJECT ?? "/Users/jihun/Desktop/구독컷";

if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { auditApprovalManifest } = await import(join(REPO_ROOT, "src/exec/manifestAudit.ts"));
const { validateApprovalManifest } = await import(join(REPO_ROOT, "src/exec/approvalManifest.ts"));
const { verifyExecutionBoundary } = await import(join(REPO_ROOT, "src/exec/executionBoundary.ts"));

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const head = (repo) => execFileSync("/usr/bin/git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const NOW = new Date();
const EXPIRES = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000).toISOString();

// 승인된 실행 권위 — **실제 경로 + 실제 digest**다(가짜 경로를 쓰면 R5가 내 fixture를 감사하게 된다).
// `controllerEntrypoint`만 예외이고, 그 이유 자체가 아래 finding 하나다.
const CLAUDE_BIN = process.env.HARNESS_CLAUDE_BIN ?? "/Users/jihun/.nvm/versions/node/v24.18.0/bin/claude";
const claudeReal = existsSync(CLAUDE_BIN) ? realpathSync(CLAUDE_BIN) : null;
const CONTROLLER_ENTRY = join(REPO_ROOT, "dist/exec/controllerEntrypoint.js"); // 레포가 아직 배송하지 않는다

const authority = () => ({
  ...(claudeReal ? { claude: { path: claudeReal, sha256: sha(claudeReal) } } : {}),
  codex: null,
  // 실제 승인이라면 여기가 `node <entry> validate-plan <path>`로 실행되는 스크립트다. 레포에 없으므로
  // digest도 없다 — 존재하지 않는 파일의 digest를 지어낼 수는 없어 40자 규약만 채운다(R5가 이것을 잡는다).
  controllerEntrypoint: { path: CONTROLLER_ENTRY, sha256: "0".repeat(64) },
  git: { path: "/usr/bin/git", sha256: sha("/usr/bin/git") },
  node: { path: process.execPath, sha256: sha(process.execPath) },
  processObserver: { path: "/bin/ps", sha256: sha("/bin/ps") },
});

const POLICY = {
  maxTaskAttempts: 2,
  maxDeliveryAttempts: 2,
  retryBackoffMs: 1_000,
  deliveryDeadlineMs: 600_000,
  maxNoProgressMs: 600_000,
  maxAttemptElapsedMs: 900_000,
  cleanupTermGraceMs: 2_000,
  cleanupKillGraceMs: 2_000,
};

// ── 대상 ⓐ: 이 harness 레포에서 다음 마일스톤을 승인한다면 ────────────────────
const harnessManifest = {
  milestoneId: "v3-m11",
  approvedCommit: head(REPO_ROOT),
  writableRoots: ["dist", "docs", "src"],
  ownershipByTask: {
    "build-dist": ["dist"],
    "docs-judgment": ["docs/backlog", "docs/CONTEXT_SUMMARY.md"],
    "impl-exec": ["src/exec"],
  },
  allowedCommands: [],
  allowedDependencies: [],
  allowedNetworkDomains: [],
  executionAuthority: authority(),
  autopilotPolicy: POLICY,
  operationAuthorityByTask: {
    "impl-exec": [
      { authorityId: "impl-write", kind: "write_file", path: "src/exec/releaseGate.ts", maxBytes: 40_000 },
      // 실제로 돌리고 싶은 것은 레포 루트의 `npm test`다. 그것은 표현되지 않는다 → probe 2.
      { authorityId: "impl-tests", kind: "run_process", action: "run-tests", data: { projectPath: "src/exec" }, timeoutMs: 600_000 },
    ],
    "docs-judgment": [
      { authorityId: "docs-write", kind: "write_file", path: "docs/CONTEXT_SUMMARY.md", maxBytes: 300_000 },
    ],
  },
  maxSessions: 4,
  maxTokens: 2_000_000,
  maxElapsedMs: 4 * 3_600_000,
  localMergeAllowed: false,
  expiresAt: EXPIRES,
};

// ── 대상 ⓑ: 구독컷. **checkout 루트는 프로젝트 루트가 아니라 `app/`이다.** ────
const APP = join(PROJECT, "app");
const gudokcutManifest = {
  milestoneId: "gudokcut-m1",
  approvedCommit: head(APP),
  writableRoots: ["app", "src"], // checkout(`app/`) 기준: expo-router 화면 + 컴포넌트
  ownershipByTask: {
    "ds-components": ["src/design-system"],
    screens: ["app"],
  },
  allowedCommands: [],
  allowedDependencies: [],
  allowedNetworkDomains: [],
  executionAuthority: authority(),
  autopilotPolicy: POLICY,
  operationAuthorityByTask: {
    "ds-components": [
      { authorityId: "ds-write", kind: "write_file", path: "src/design-system/Badge.tsx", maxBytes: 8_192 },
      { authorityId: "ds-tests", kind: "run_process", action: "run-tests", data: { projectPath: "src/design-system" }, timeoutMs: 300_000 },
    ],
    screens: [{ authorityId: "screen-write", kind: "write_file", path: "app/index.tsx", maxBytes: 16_384 }],
  },
  maxSessions: 2,
  maxTokens: 1_000_000,
  maxElapsedMs: 2 * 3_600_000,
  localMergeAllowed: false,
  expiresAt: EXPIRES,
};

let fail = 0;
function report(label, manifest) {
  console.log(`\n── ${label} ─────────────────────────────`);
  let validated;
  try {
    validated = validateApprovalManifest(manifest);
  } catch (e) {
    fail += 1;
    console.log(`  manifest가 유효하지 않다: ${e.code ?? "?"} — ${e.message}`);
    return;
  }
  console.log(`  approvedCommit ${validated.approvedCommit.slice(0, 12)}… · writableRoots ${JSON.stringify(validated.writableRoots)}`);
  const findings = auditApprovalManifest(validated, { now: NOW.toISOString() });
  if (findings.length === 0) {
    console.log("  finding 0 — R1~R5로는 아무것도 걸리지 않았다");
    return;
  }
  for (const f of findings) console.log(`  [${f.severity}] ${f.rule} · ${f.subject}\n         ${f.message}`);
}

console.log(`V3 M10 T5 — 도그푸딩 승인 감사 (read-only · LLM 0회)`);
console.log(`  기준 시각 ${NOW.toISOString()} · 승인 창 3일`);
console.log(`  대상 ⓐ ${REPO_ROOT}`);
console.log(`  대상 ⓑ ${PROJECT}  (checkout 루트: ${APP})`);
console.log(`  claude 실행 파일: ${claudeReal ?? "부재 — claude 권위 없이 감사한다"}`);

report("ⓐ harness 레포 · milestone v3-m11", harnessManifest);
report("ⓑ 구독컷 · milestone gudokcut-m1", gudokcutManifest);

// ── probe 1: 구독컷의 설계·명세 산출물은 checkout 밖이라 승인에 담기지 않는다 ──
console.log(`\n── probe 1: checkout 밖 경로는 승인에 담기지 않는다 ────────`);
const outside = ["design-system", "spec", "docs"].filter((d) => existsSync(join(PROJECT, d)));
console.log(`  프로젝트 루트에는 있고 checkout(app/)에는 없는 디렉터리: ${JSON.stringify(outside)}`);
try {
  validateApprovalManifest({ ...gudokcutManifest, writableRoots: ["../design-system", "app", "src"] });
  fail += 1;
  console.log("  FAIL — `../design-system`이 승인을 통과했다(경계가 없다는 뜻이다)");
} catch (e) {
  console.log(`  OK   '../design-system'은 표현 불가: ${e.code}`);
}

// ── probe 2: 레포 루트 전체 테스트는 typed run-tests로 표현되지 않는다 ────────
console.log(`\n── probe 2: 레포 루트 'npm test'는 typed run-tests로 표현되지 않는다 ────────`);
for (const projectPath of [".", ""]) {
  try {
    validateApprovalManifest({
      ...harnessManifest,
      operationAuthorityByTask: {
        ...harnessManifest.operationAuthorityByTask,
        "impl-exec": [{ authorityId: "root-tests", kind: "run_process", action: "run-tests", data: { projectPath }, timeoutMs: 600_000 }],
      },
    });
    fail += 1;
    console.log(`  FAIL — projectPath ${JSON.stringify(projectPath)}가 승인을 통과했다`);
  } catch (e) {
    console.log(`  OK   projectPath ${JSON.stringify(projectPath)} → ${e.code}`);
  }
}
// 루트를 쓰기 승인해서 우회하는 길도 없다 — "레포 전체"는 승인 어휘에 존재하지 않는 범위다.
for (const roots of [["."], [""], ["/"], ["docs", ".."]]) {
  try {
    validateApprovalManifest({ ...harnessManifest, writableRoots: roots, ownershipByTask: { "t-1": roots }, operationAuthorityByTask: {} });
    fail += 1;
    console.log(`  FAIL writableRoots ${JSON.stringify(roots)}가 승인을 통과했다`);
  } catch (e) {
    console.log(`  OK   writableRoots ${JSON.stringify(roots)} → ${e.code}`);
  }
}

// ── probe 3·4: 감사를 통과한 승인도 **다른 레포에서는 실행되지 않는다** ────────
// 여기서만 프로세스가 뜬다(`git rev-parse` 조회 · 쓰기 없음).
console.log(`\n── probe 3·4: 실행 경계 — controller checkout ≠ 대상 checkout ────────`);
async function boundary(label, target, manifest, expected) {
  try {
    await verifyExecutionBoundary({ manifest, controllerRepoRoot: realpathSync(REPO_ROOT), targetWorktree: realpathSync(target) });
    fail += 1;
    console.log(`  FAIL ${label} — 경계가 통과했다(기대: ${expected})`);
  } catch (e) {
    const ok = e.code === expected;
    if (!ok) fail += 1;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label} → ${e.code}${ok ? "" : ` (기대 ${expected})`}`);
  }
}
// harness 레포에서 승인한 manifest(approvedCommit = harness HEAD)로 구독컷을 돌리려는 시도.
//
// 3a는 **경로 문자열의 유니코드 정규형** 때문에 HEAD 대조에 도달조차 하지 못한다: git은
// `--show-toplevel`을 **NFD**(Hangul Jamo 분해)로 내놓고 `realpath`는 받은 형태를 보존하므로,
// 한글 경로를 NFC로 넘기면 `topReal !== root`가 되어 checkout 신원이 거부된다(fail closed).
const appNfd = execFileSync("/usr/bin/git", ["-C", APP, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const cps = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join(" ");
if (appNfd !== APP) {
  console.log(`  경로 정규형 불일치 — git: ${cps([...appNfd].slice(19, 22).join(""))} vs 호출자: ${cps([...APP].slice(19, 22).join(""))}`);
}
await boundary("3a 대상 = 구독컷 checkout(app/) · 호출자 경로 NFC", APP, harnessManifest, "boundary_not_checkout_root");
// 3b는 git이 내놓은 형태를 그대로 넘긴다 → 신원 검사를 지나 **승인 커밋 대조**에서 막힌다.
await boundary("3b 대상 = 같은 checkout · git이 준 NFD 경로", appNfd, harnessManifest, "approved_commit_mismatch");
await boundary("4  대상 = 구독컷 프로젝트 루트(git repo 아님)", PROJECT, harnessManifest, "boundary_git_failed");

console.log(fail === 0 ? `\n감사·probe 전부 기대대로 (FAIL 0)` : `\nFAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
