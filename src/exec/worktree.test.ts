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

/**
 * **대장 `B-31` — deadline kill 잔재를 닫힌 action 집합으로 되돌릴 수 있는가.**
 *
 * 아래 둘은 기능이 아니라 **결정을 붙잡는다**: `GIT_WORKTREE_ACTIONS`에 `prune`을 더하지 않기로 한 근거가
 * git의 실제 semantics이므로(`orchestrationTypes.ts`의 그 주석), semantics가 바뀌면 여기서 red가 나고
 * 결정을 다시 봐야 한다. kernel 경로(`executeWorktreeOperation`)가 아니라 **git 자체**를 재는 이유는
 * 재는 대상이 git의 회복 가능성이기 때문이다 — kernel은 이 argv를 그대로 넘길 뿐이다.
 */
async function git(repo: string, ...args: string[]): Promise<number | null> {
  return (await runProcess("git", ["-C", repo, ...args])).code;
}

test("[B-31] 등록만 남은 잔재: 재시도 add를 막지만 이미 있는 remove --force가 되돌린다", async () => {
  const repo = await initRepo();
  try {
    const wt = join(repo, ".harness", "worktrees", "run1", "t");
    const head = (await runProcess("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    assert.equal(await git(repo, "worktree", "add", "--detach", wt, head), 0);

    // kill 잔재 모양 ⓐ: 작업 디렉터리는 사라졌고 `.git/worktrees/<name>` 등록만 남았다.
    rmSync(wt, { recursive: true, force: true });
    // B-31이 말한 그 exit 128 — 등록이 남아 있으면 같은 경로의 재시도 add가 막힌다.
    assert.equal(await git(repo, "worktree", "add", "--detach", wt, head), 128, "등록 잔재가 재시도를 막지 않는다");

    // **닫힌 집합에 이미 있는** remove가 그 잔재를 되돌린다 → prune이 필요한 모양이 아니다.
    assert.equal(await git(repo, "worktree", "remove", "--force", wt), 0, "remove가 등록 잔재를 못 지운다");
    assert.equal(await git(repo, "worktree", "add", "--detach", wt, head), 0, "정리 뒤에도 재시도가 막힌다");
    assert.ok(existsSync(join(wt, ".git")), "재시도 add가 linked worktree를 만들지 못했다");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("[B-31] 파일이 남은 잔재: prune으로도 remove로도 되돌아가지 않는다(닫힌 집합의 남는 구멍)", async () => {
  const repo = await initRepo();
  try {
    const wt = join(repo, ".harness", "worktrees", "run1", "t");
    const head = (await runProcess("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    assert.equal(await git(repo, "worktree", "add", "--detach", wt, head), 0);

    // kill 잔재 모양 ⓑ — **실제 SIGTERM/SIGKILL이 남기는 모양이다**: git 자신의 junk 핸들러가 metadata를
    // 먼저 지우고 작업 트리를 지우다 끊기므로 "파일이 든 디렉터리 + 등록 없음"이 남는다. 여기서는 그
    // 상태를 결정적으로 만든다(등록 포인터 제거 → prune이 등록을 회수).
    rmSync(join(wt, ".git"));
    assert.equal(await git(repo, "worktree", "prune"), 0);

    // prune은 **작업 파일을 절대 지우지 않는다** → 잔재 디렉터리가 그대로 남는다.
    assert.ok(existsSync(join(wt, "README.md")), "prune이 작업 파일을 지웠다(전제가 바뀌었다)");
    assert.equal(await git(repo, "worktree", "add", "--detach", wt, head), 128, "prune이 재시도를 되살렸다");
    // remove도 못 한다 — 등록이 없으니 git에게 이것은 worktree가 아니다.
    assert.equal(await git(repo, "worktree", "remove", "--force", wt), 128, "등록 없는 디렉터리를 remove가 지웠다");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
