/**
 * 직렬 병합 코디네이터 (ARCH §2 "완료 세션부터 develop에 직렬 병합 → 게이트 재실행").
 * 병행 세션들은 각자 브랜치에 작업을 끝내두고(merge 안 함), 여기서 한 번에 하나씩 base에 병합한다.
 *
 * 세션 브랜치는 옛 base 스냅샷에서 갈렸으므로, 병합 순서상 2번째부터는 base가 앞선 병합으로 이동해 있다.
 * 처리: 브랜치 worktree에서 `git merge <base>`로 앞선 병합을 끌어와(ownership 분리라 보통 무충돌) →
 * L1 게이트 재실행 → `git push . <branch>:<base>`(이제 ff). 충돌/게이트 실패는 그 항목만 보류.
 */
import { runMachineGate } from "./machineGate.js";
import { runProcess } from "./runProcess.js";
import { removeWorktree } from "./worktree.js";
async function git(cwd, args) {
    const r = await runProcess("git", ["-C", cwd, ...args]);
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}
/** items를 순서대로 base에 병합. 각 항목 결과를 반환(부분 성공 허용). */
export async function mergeSerial(opts) {
    const regate = opts.regate !== false;
    const results = [];
    for (const it of opts.items) {
        const base = { taskId: it.taskId, branch: it.branch, status: "error" };
        try {
            // 1) base를 브랜치로 끌어와 앞선 병합 반영
            const m = await git(it.worktreePath, ["merge", "--no-edit", opts.base]);
            if (m.code !== 0) {
                await git(it.worktreePath, ["merge", "--abort"]);
                results.push({ ...base, status: "conflict", error: m.err || m.out });
                continue;
            }
            // 2) 병합 후 게이트 재실행
            if (regate) {
                const gate = await runMachineGate({ cwd: it.worktreePath });
                if (!gate.passed) {
                    results.push({ ...base, status: "gate_failed", gate });
                    continue;
                }
                base.gate = gate;
            }
            // 3) ff 푸시 (브랜치가 base를 포함하므로 fast-forward)
            const push = await git(opts.repoRoot, ["push", ".", `${it.branch}:${opts.base}`]);
            if (push.code !== 0) {
                results.push({ ...base, status: "error", error: push.err || push.out });
                continue;
            }
            results.push({ ...base, status: "merged" });
            if (opts.cleanup !== false) {
                try {
                    await removeWorktree({ repoRoot: opts.repoRoot, info: { runId: "", sessionId: "", path: it.worktreePath, branch: it.branch } });
                }
                catch {
                    /* 정리 실패 무시 */
                }
            }
        }
        catch (err) {
            results.push({ ...base, status: "error", error: err.message });
        }
    }
    return results;
}
