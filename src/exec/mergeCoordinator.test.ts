/**
 * 직렬 병합 코디네이터 테스트 (실 git, 무과금). 분리된 변경은 순차 병합, 겹치면 충돌 보류.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { createWorktree } from "./worktree.js";
import { mergeSerial, type MergeItem } from "./mergeCoordinator.js";

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-merge-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  await runProcess("git", ["-C", dir, "branch", "-m", "develop"]);
  await runProcess("git", ["-C", dir, "checkout", "-q", "-b", "scratch"]);
  return dir;
}

async function sessionBranch(repo: string, sid: string, file: string, content: string): Promise<MergeItem> {
  const wt = await createWorktree({ repoRoot: repo, runId: "r", sessionId: sid, baseBranch: "develop" });
  writeFileSync(join(wt.path, file), content);
  await runProcess("git", ["-C", wt.path, "add", "-A"]);
  await runProcess("git", ["-C", wt.path, "commit", "-q", "-m", `work ${sid}`]);
  return { taskId: sid, branch: wt.branch, worktreePath: wt.path };
}

test("분리된 두 브랜치 순차 병합 → develop에 둘 다 반영", async () => {
  const repo = await initRepo();
  try {
    const a = await sessionBranch(repo, "s1", "a.txt", "A\n");
    const b = await sessionBranch(repo, "s2", "b.txt", "B\n");
    const res = await mergeSerial({ repoRoot: repo, base: "develop", items: [a, b], regate: false, cleanup: false });
    assert.deepEqual(res.map((r) => r.status), ["merged", "merged"]);
    assert.equal((await runProcess("git", ["-C", repo, "show", "develop:a.txt"])).stdout, "A\n");
    assert.equal((await runProcess("git", ["-C", repo, "show", "develop:b.txt"])).stdout, "B\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("같은 파일 충돌 → 두 번째는 conflict 보류(첫째는 병합)", async () => {
  const repo = await initRepo();
  try {
    const a = await sessionBranch(repo, "s1", "README.md", "from-s1\n");
    const b = await sessionBranch(repo, "s2", "README.md", "from-s2\n");
    const res = await mergeSerial({ repoRoot: repo, base: "develop", items: [a, b], regate: false, cleanup: false });
    assert.equal(res[0].status, "merged");
    assert.equal(res[1].status, "conflict");
    assert.equal((await runProcess("git", ["-C", repo, "show", "develop:README.md"])).stdout, "from-s1\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
