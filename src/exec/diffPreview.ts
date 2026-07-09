/**
 * 세션 작업물 diff 미리보기 (ARCH §9-5 "diff 승인 후 develop 병합"의 승인 근거).
 * worktree에서 기준(base, 기본 develop) 대비 변경을 수집한다 — 커밋된 것 + 미커밋 + untracked.
 */
import { runProcess } from "./runProcess.js";

export interface FileStat {
  path: string;
  added: number; // 추가 라인 (바이너리면 -1)
  deleted: number;
}

export interface DiffPreview {
  base: string | null; // 비교 기준(없으면 작업트리 미커밋만)
  files: FileStat[]; // numstat
  untracked: string[]; // 아직 add 안 된 새 파일
  stat: string; // git diff --stat 사람용 요약
  raw: string; // 전체 diff 텍스트 (승인 표시용, 길면 호출측이 자름)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runProcess("git", ["-C", cwd, ...args]);
  // diff는 변경 있으면 exit 0, 없어도 0. 실패(비 git 등)만 에러.
  if (r.code !== 0 && r.stderr.trim()) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

function parseNumstat(out: string): FileStat[] {
  const files: FileStat[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.split("\t");
    if (m.length < 3) continue;
    const added = m[0] === "-" ? -1 : Number(m[0]);
    const deleted = m[1] === "-" ? -1 : Number(m[1]);
    files.push({ path: m[2], added, deleted });
  }
  return files;
}

export interface CollectDiffOpts {
  cwd: string; // worktree 경로
  base?: string; // 비교 기준 브랜치/커밋 (예: develop). 없으면 미커밋 변경만(HEAD 대비)
}

/** worktree의 변경을 수집. base 지정 시 base..작업트리 전체, 미지정 시 HEAD 대비 미커밋. */
export async function collectDiff(opts: CollectDiffOpts): Promise<DiffPreview> {
  const { cwd } = opts;
  const ref = opts.base ?? "HEAD";
  const numstat = await git(cwd, ["diff", ref, "--numstat"]);
  const stat = await git(cwd, ["diff", ref, "--stat"]);
  const raw = await git(cwd, ["diff", ref]);
  const untrackedOut = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedOut.split("\n").map((s) => s.trim()).filter(Boolean);
  return { base: opts.base ?? null, files: parseNumstat(numstat), untracked, stat: stat.trim(), raw };
}

/** 승인 프롬프트/로그용 한 줄 요약. */
export function summarizeDiff(d: DiffPreview): string {
  const changed = d.files.length;
  const add = d.files.reduce((s, f) => s + (f.added > 0 ? f.added : 0), 0);
  const del = d.files.reduce((s, f) => s + (f.deleted > 0 ? f.deleted : 0), 0);
  const unt = d.untracked.length;
  return `변경 파일 ${changed}개 (+${add}/-${del})${unt ? `, 새 파일 ${unt}개` : ""}${d.base ? ` [기준 ${d.base}]` : ""}`;
}
