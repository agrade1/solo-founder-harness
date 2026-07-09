/**
 * diff 미리보기 테스트. 실제 git 임시레포(무과금·무네트워크).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { collectDiff, summarizeDiff } from "./diffPreview.js";

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "harness-diff-"));
  await runProcess("git", ["-C", dir, "init", "-q"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("미커밋 변경(HEAD 대비) 수집 + 요약", async () => {
  const repo = await initRepo();
  try {
    writeFileSync(join(repo, "a.txt"), "line1\nline2\nline3\n"); // 1줄 추가
    writeFileSync(join(repo, "b.txt"), "new\n"); // untracked
    const d = await collectDiff({ cwd: repo });
    const a = d.files.find((f) => f.path === "a.txt");
    assert.ok(a, "a.txt 변경 감지");
    assert.equal(a!.added, 1);
    assert.ok(d.untracked.includes("b.txt"), "b.txt untracked 감지");
    assert.match(summarizeDiff(d), /변경 파일 1개/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("base 브랜치 대비: 커밋된 변경도 포함", async () => {
  const repo = await initRepo();
  try {
    // develop(=현재) 저장, 새 브랜치에서 커밋
    await runProcess("git", ["-C", repo, "branch", "-m", "develop"]);
    await runProcess("git", ["-C", repo, "checkout", "-q", "-b", "feat"]);
    writeFileSync(join(repo, "a.txt"), "line1\nline2\nX\n");
    await runProcess("git", ["-C", repo, "commit", "-q", "-am", "edit"]);
    const d = await collectDiff({ cwd: repo, base: "develop" });
    assert.equal(d.base, "develop");
    assert.ok(d.files.some((f) => f.path === "a.txt"), "커밋된 변경이 base 대비로 잡힘");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("변경 없으면 빈 목록", async () => {
  const repo = await initRepo();
  try {
    const d = await collectDiff({ cwd: repo });
    assert.deepEqual(d.files, []);
    assert.deepEqual(d.untracked, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
