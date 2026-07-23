import { createInterface } from "node:readline";
import { runHandoff } from "../core/handoff.js";
/** stdin y/N 승인 + preview 출력 (대화형 승인 게이트). */
function stdinApprove(message, preview) {
    return new Promise((resolve) => {
        if (preview)
            console.log("\n" + preview);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\n[승인 필요] ${message} (y/N): `, (ans) => {
            rl.close();
            resolve(/^y(es)?$/i.test(ans.trim()));
        });
    });
}
/** harness handoff --project <p> [--cwd <serviceRepo>] [--print] [--yes] */
export async function runHandoffCommand(opts) {
    const outcome = await runHandoff({
        project: opts.project,
        cwd: opts.cwd,
        print: opts.print,
        yes: opts.yes,
        approve: stdinApprove,
    });
    // 실패성 결과만 비정상 종료코드로 신호한다.
    if (outcome.action === "not_completed") {
        console.error(outcome.reason);
        process.exitCode = 1;
    }
    else if (outcome.action === "setup_failed" || outcome.action === "preflight_failed" || outcome.action === "spawn_failed") {
        process.exitCode = 1;
    }
    return outcome;
}
