/**
 * worktree 수명 테스트. 실제 git을 임시 레포에서 돌린다(로컬·무네트워크·무과금).
 * 실행: `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { createWorktree, removeWorktree, listWorktrees, worktreePath, worktreeBranch } from "./worktree.js";

/** 커밋 1개 있는 임시 git 레포 생성 → repoRoot 반환. */
async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-wt-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# temp\n");
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("경로/브랜치 규칙", () => {
  assert.equal(worktreeBranch("run1", "fe"), "harness/run1/fe");
  assert.ok(worktreePath("/repo", "run1", "fe").endsWith("/.harness/worktrees/run1/fe"));
});

test("createWorktree: worktree + 브랜치 생성, list에 등장", async () => {
  const repo = await initRepo();
  try {
    const info = await createWorktree({ repoRoot: repo, runId: "run1", sessionId: "fe" });
    assert.ok(existsSync(info.path), "worktree 디렉토리 존재");
    assert.equal(info.branch, "harness/run1/fe");
    const list = await listWorktrees(repo);
    assert.ok(list.some((p) => p.includes("run1/fe")), "worktree 목록에 포함");
    // 브랜치가 실제로 생성됐는지
    const br = await runProcess("git", ["-C", repo, "branch", "--list", info.branch]);
    assert.ok(br.stdout.includes("harness/run1/fe"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree: 디렉토리 제거(브랜치는 기본 보존)", async () => {
  const repo = await initRepo();
  try {
    const info = await createWorktree({ repoRoot: repo, runId: "run2", sessionId: "be" });
    await removeWorktree({ repoRoot: repo, info });
    assert.ok(!existsSync(info.path), "worktree 디렉토리 제거됨");
    const br = await runProcess("git", ["-C", repo, "branch", "--list", info.branch]);
    assert.ok(br.stdout.includes("harness/run2/be"), "브랜치는 보존(작업 유실 방지)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree deleteBranch: 브랜치까지 삭제", async () => {
  const repo = await initRepo();
  try {
    const info = await createWorktree({ repoRoot: repo, runId: "run3", sessionId: "x" });
    await removeWorktree({ repoRoot: repo, info, deleteBranch: true });
    const br = await runProcess("git", ["-C", repo, "branch", "--list", info.branch]);
    assert.equal(br.stdout.trim(), "", "브랜치 삭제됨");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
