/**
 * V3 M5a — 실행 경계(대장 `B-5`) 테스트. 실제 git을 임시 레포에서 돌린다(로컬·무네트워크·무과금).
 * 실행: `npx tsx --test src/exec/executionBoundary.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
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

async function code(fn: () => Promise<unknown>): Promise<string> {
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

    // 같은 커밋 → 통과
    const ok = await verifyExecutionBoundary({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: wtReal,
    });
    assert.equal(ok.sameCheckout, false);
    assert.equal(ok.targetRoot, wtReal);

    // 실행 worktree만 앞서 나가면 거부
    writeFileSync(join(wtReal, "src", "b.txt"), "b\n");
    await runProcess("git", ["-C", wtReal, "add", "."]);
    await runProcess("git", ["-C", wtReal, "commit", "-q", "-m", "ahead"]);
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

test("[M5a] checkout 루트가 아니면(하위 디렉터리·symlink 탈출) 거부", async () => {
  const repo = await initRepo();
  const other = await initRepo("m5a-other-", "other");
  const link = join(realpathSync(mkdtempSync(join(tmpdir(), "m5a-link-"))), "repo-link");
  try {
    // 하위 디렉터리를 루트로 넘긴 경우
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
    // symlink가 다른 저장소를 가리키는 경우: realpath로 정규화되어 그 저장소의 HEAD를 본다
    symlinkSync(other.root, link, "dir");
    assert.equal(
      await code(() =>
        verifyExecutionBoundary({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: link,
        }),
      ),
      "approved_commit_mismatch",
      "symlink는 realpath 대상의 HEAD로 판정된다(승인 커밋이 아니면 거부)",
    );
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
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
