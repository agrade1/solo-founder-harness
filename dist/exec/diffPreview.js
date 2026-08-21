/**
 * 세션 작업물 diff 미리보기 (ARCH §9-5 "diff 승인 후 develop 병합"의 승인 근거).
 * worktree에서 기준(base, 기본 develop) 대비 변경을 수집한다 — 커밋된 것 + 미커밋 + untracked.
 */
import { runProcess } from "./runProcess.js";
async function git(cwd, args) {
    const r = await runProcess("git", ["-C", cwd, ...args]);
    // diff는 변경 있으면 exit 0, 없어도 0. 실패(비 git 등)만 에러.
    if (r.code !== 0 && r.stderr.trim())
        throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout;
}
function parseNumstat(out) {
    const files = [];
    for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t)
            continue;
        const m = t.split("\t");
        if (m.length < 3)
            continue;
        const added = m[0] === "-" ? -1 : Number(m[0]);
        const deleted = m[1] === "-" ? -1 : Number(m[1]);
        files.push({ path: m[2], added, deleted });
    }
    return files;
}
/** worktree의 변경을 수집. base 지정 시 base..작업트리 전체, 미지정 시 HEAD 대비 미커밋. */
export async function collectDiff(opts) {
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
export function summarizeDiff(d) {
    const changed = d.files.length;
    const add = d.files.reduce((s, f) => s + (f.added > 0 ? f.added : 0), 0);
    const del = d.files.reduce((s, f) => s + (f.deleted > 0 ? f.deleted : 0), 0);
    const unt = d.untracked.length;
    return `변경 파일 ${changed}개 (+${add}/-${del})${unt ? `, 새 파일 ${unt}개` : ""}${d.base ? ` [기준 ${d.base}]` : ""}`;
}
