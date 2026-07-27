/**
 * V3 M5a — 실행 경계(대장 `B-5`) 테스트. 실제 git을 임시 레포에서 돌린다(로컬·무네트워크·무과금).
 * 실행: `npx tsx --test src/exec/executionBoundary.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { verifyExecutionBoundary } from "./executionBoundary.js";
import { OrchestrationError } from "./orchestrationTypes.js";

const FUTURE = "2099-12-31T00:00:00.000Z";

function manifest(over: Record<string, unknown> = {}) {
  return {
    milestoneId: "m5a",
    approvedCommit: "a".repeat(40),
    writableRoots: ["src"],
    ownershipByTask: { "task-1": ["src"] },
    allowedCommands: ["npm run build"],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    maxSessions: 2,
    maxTokens: 1000,
    maxElapsedMs: 60_000,
    localMergeAllowed: false,
    expiresAt: FUTURE,
    ...over,
  };
}

/** 커밋 1개 있는 임시 git 레포 → { root(realpath), head }. */
async function initRepo(prefix = "m5a-boundary-", marker = "a"): Promise<{ root: string; head: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  await runProcess("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  // marker로 내용을 갈라 둔다 — 같은 초에 만든 동일 내용 커밋은 해시까지 같아진다.
  writeFileSync(join(dir, "src", "a.txt"), `${marker}\n`);
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  const head = (await runProcess("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  return { root: dir, head };
}

/** 두 번째 커밋을 만들어 HEAD를 움직인다. */
async function advance(root: string): Promise<string> {
  writeFileSync(join(root, "src", "b.txt"), "b\n");
  await runProcess("git", ["-C", root, "add", "."]);
  await runProcess("git", ["-C", root, "commit", "-q", "-m", "next"]);
  return (await runProcess("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

async function code(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
    return "(통과)";
  } catch (err) {
    assert.ok(err instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(err)}`);
    return (err as OrchestrationError).code;
  }
}

test("[M5a] controller = 실행 checkout이고 HEAD가 승인 커밋이면 통과(대조 1회)", async () => {
  const repo = await initRepo();
  try {
    const v = await verifyExecutionBoundary({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    assert.equal(v.sameCheckout, true);
    assert.equal(v.approvedCommit, repo.head);
    assert.equal(v.controllerRoot, repo.root);
    assert.equal(v.targetRoot, repo.root);
    v.revalidateSync(); // spawn 직전 재확인도 통과해야 한다
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] HEAD가 승인 커밋이 아니면 approved_commit_mismatch", async () => {
  const repo = await initRepo();
  try {
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({ manifest: manifest(), controllerRepoRoot: repo.root, targetWorktree: repo.root }),
      ),
      "approved_commit_mismatch",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] controller와 실행 worktree가 다르면 양쪽 HEAD를 모두 대조한다", async () => {
  const repo = await initRepo();
  const wt = join(repo.root, "..", `m5a-wt-${process.pid}`);
  try {
    await runProcess("git", ["-C", repo.root, "worktree", "add", "-q", "-b", "work/m5a-test", wt]);
    const wtReal = realpathSync(wt);

    const ok = await verifyExecutionBoundary({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: wtReal,
    });
    assert.equal(ok.sameCheckout, false);
    assert.equal(ok.targetRoot, wtReal);
    ok.revalidateSync();

    await advance(wtReal); // 실행 worktree만 앞서 나가면 거부
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: wtReal,
        }),
      ),
      "approved_commit_mismatch",
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] manifest 누락·형태 위반은 승인 규칙 그대로 거부한다", async () => {
  const repo = await initRepo();
  try {
    const call = (m: unknown) =>
      verifyExecutionBoundary({ manifest: m, controllerRepoRoot: repo.root, targetWorktree: repo.root });
    assert.equal(await code(() => call(undefined)), "invalid_manifest");
    assert.equal(await code(() => call({})), "invalid_manifest");
    assert.equal(await code(() => call(manifest({ approvedCommit: repo.head.slice(0, 7) }))), "invalid_manifest");
    assert.equal(await code(() => call(manifest({ approvedCommit: "main" }))), "invalid_manifest");
    assert.equal(await code(() => call(manifest({ extra: 1 }))), "invalid_manifest");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 만료된 manifest는 실행 경계에서 거부(경계 시각 포함)", async () => {
  const repo = await initRepo();
  try {
    const m = manifest({ approvedCommit: repo.head, expiresAt: "2026-07-27T00:00:00.000Z" });
    const at = Date.parse("2026-07-27T00:00:00.000Z");
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({ manifest: m, controllerRepoRoot: repo.root, targetWorktree: repo.root, nowMs: at }),
      ),
      "manifest_expired",
      "expiresAt과 정확히 같은 시각도 거부한다",
    );
    const before = await verifyExecutionBoundary({
      manifest: m,
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
      nowMs: at - 1,
    });
    assert.equal(before.approvedCommit, repo.head);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 경로 입력이 계약 밖이면 git을 부르기 전에 거부", async () => {
  const repo = await initRepo();
  try {
    const call = (controller: unknown, target: unknown) =>
      verifyExecutionBoundary({
        manifest: manifest({ approvedCommit: repo.head }),
        controllerRepoRoot: controller as string,
        targetWorktree: target as string,
      });
    assert.equal(await code(() => call("relative/path", repo.root)), "boundary_path_invalid");
    assert.equal(await code(() => call("", repo.root)), "boundary_path_invalid");
    assert.equal(await code(() => call(repo.root, "/abs/with\0nul")), "boundary_path_invalid");
    assert.equal(await code(() => call(repo.root, undefined)), "boundary_path_invalid");
    assert.equal(await code(() => call(join(repo.root, "does-not-exist"), repo.root)), "boundary_path_unresolvable");
    assert.equal(await code(() => call(join(repo.root, "src", "a.txt"), repo.root)), "boundary_path_not_directory");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 비정규(symlink) 입력 경로는 해석하지 않고 거부한다", async () => {
  const repo = await initRepo();
  const other = await initRepo("m5a-other-", "other");
  const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-link-")));
  const link = join(linkDir, "repo-link");
  try {
    symlinkSync(other.root, link, "dir");
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: link,
        }),
      ),
      "boundary_path_not_canonical",
      "symlink를 realpath로 눙쳐서 통과시키지 않는다(검사 대상 = 실행 대상)",
    );
    // 자기 자신을 가리키는 정상 대상이어도 마찬가지다 — 정규 경로가 아니면 거부.
    const selfLink = join(linkDir, "self-link");
    symlinkSync(repo.root, selfLink, "dir");
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: selfLink,
          targetWorktree: repo.root,
        }),
      ),
      "boundary_path_not_canonical",
    );
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] checkout 루트가 아니면(하위 디렉터리) 거부", async () => {
  const repo = await initRepo();
  try {
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: join(repo.root, "src"),
        }),
      ),
      "boundary_not_checkout_root",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] git이 아닌 디렉터리는 boundary_git_failed", async () => {
  const repo = await initRepo();
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "m5a-plain-")));
  try {
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: plain,
          targetWorktree: plain,
        }),
      ),
      "boundary_git_failed",
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 검증 이후 HEAD가 움직이면 spawn 직전에 거부", async () => {
  const repo = await initRepo();
  try {
    const v = await verifyExecutionBoundary({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    v.revalidateSync();
    await advance(repo.root); // 검사와 사용 사이의 변경
    assert.equal(await code(() => v.revalidateSync()), "approved_commit_mismatch");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 디렉터리가 다른 실체로 바뀌면 신원 불일치로 거부", async () => {
  const repo = await initRepo();
  const decoy = await initRepo("m5a-decoy-", "decoy");
  const parked = `${repo.root}-parked`;
  try {
    const v = await verifyExecutionBoundary({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    // 같은 경로에 다른 디렉터리를 끼워 넣는다(inode 교체).
    renameSync(repo.root, parked);
    renameSync(decoy.root, repo.root);
    assert.equal(await code(() => v.revalidateSync()), "boundary_identity_changed");
  } finally {
    rmSync(parked, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(decoy.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 경로가 symlink로 교체되면 거부", async () => {
  const repo = await initRepo();
  const other = await initRepo("m5a-other2-", "other2");
  const parked = `${repo.root}-parked2`;
  try {
    const v = await verifyExecutionBoundary({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    renameSync(repo.root, parked);
    symlinkSync(other.root, repo.root, "dir");
    assert.equal(await code(() => v.revalidateSync()), "boundary_path_not_canonical");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(parked, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
});
