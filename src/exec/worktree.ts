/**
 * 세션 격리용 git worktree 수명 관리 (ARCH §2).
 *
 * 레이아웃:
 *   <repo>/.harness/worktrees/<run_id>/<session_id>/   ← 세션 CWD
 *   작업 브랜치: harness/<run_id>/<session_id>
 *   기준 브랜치: develop (기본) — main은 사람 전용, 여기서 분기하지 않음
 *
 * 병합·푸시는 여기 책임이 아니다(게이트 파이프라인 §9-8). 이 모듈은 생성/제거/조회만.
 */
import { join } from "node:path";
import { runProcess } from "./runProcess.js";

export interface WorktreeInfo {
  runId: string;
  sessionId: string;
  path: string; // 절대경로 (세션 CWD)
  branch: string; // 작업 브랜치명
}

/** worktree 절대경로 규칙. */
export function worktreePath(repoRoot: string, runId: string, sessionId: string): string {
  return join(repoRoot, ".harness", "worktrees", runId, sessionId);
}
/** 작업 브랜치명 규칙. */
export function worktreeBranch(runId: string, sessionId: string): string {
  return `harness/${runId}/${sessionId}`;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const r = await runProcess("git", ["-C", repoRoot, ...args]);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} 실패(code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

export interface CreateWorktreeOpts {
  repoRoot: string;
  runId: string;
  sessionId: string;
  baseBranch?: string; // 기준 커밋-ish (기본 develop). 없으면 현재 HEAD
}

/**
 * 세션용 worktree + 전용 브랜치 생성.
 * `git worktree add -b <branch> <path> [<base>]`.
 */
export async function createWorktree(opts: CreateWorktreeOpts): Promise<WorktreeInfo> {
  const { repoRoot, runId, sessionId } = opts;
  const path = worktreePath(repoRoot, runId, sessionId);
  const branch = worktreeBranch(runId, sessionId);
  const args = ["worktree", "add", "-b", branch, path];
  if (opts.baseBranch) args.push(opts.baseBranch);
  await git(repoRoot, args);
  return { runId, sessionId, path, branch };
}

export interface RemoveWorktreeOpts {
  repoRoot: string;
  info: WorktreeInfo;
  deleteBranch?: boolean; // 작업 브랜치까지 삭제 (기본 false — 작업 보존)
  force?: boolean; // 미커밋 변경 있어도 제거 (기본 true)
}

/** worktree 제거. 기본은 브랜치 보존(작업 유실 방지). */
export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<void> {
  const { repoRoot, info } = opts;
  const args = ["worktree", "remove", info.path];
  if (opts.force !== false) args.push("--force");
  await git(repoRoot, args);
  await git(repoRoot, ["worktree", "prune"]);
  if (opts.deleteBranch) {
    // 병합 안 된 브랜치도 지우려면 -D
    await git(repoRoot, ["branch", "-D", info.branch]);
  }
}

/** 현재 등록된 worktree 경로 목록 (`git worktree list --porcelain`). */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}
