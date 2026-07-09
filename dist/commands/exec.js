import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { WORKSPACE_ROOT } from "../core/paths.js";
import { ClaudeCliProvider } from "../exec/claudeCliProvider.js";
import { runSession } from "../exec/sessionRunner.js";
/** y=approve / d=defer / 그 외=reject. */
function stdinApprover() {
    return (req) => new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const detail = req.detail ? ` [${req.detail}]` : "";
        rl.question(`\n[승인] ${req.message}${detail} (y=병합 / d=보류 / N=거부): `, (ans) => {
            rl.close();
            const a = ans.trim().toLowerCase();
            resolve(a === "y" || a === "yes" ? "approve" : a === "d" ? "defer" : "reject");
        });
    });
}
/** 이벤트를 사람이 보는 마일스톤 줄로 출력 (StatusBoard 최소형 — 일반화는 v4). */
function printEvent(e) {
    if (e.kind === "init")
        console.log(`  ▶ 세션 시작 (model ${e.model})`);
    else if (e.kind === "assistant") {
        const tools = e.toolUses.map((t) => t.name).join(", ");
        console.log(`  · turn${tools ? ` [${tools}]` : ""}${e.text ? `: ${e.text.slice(0, 80)}` : ""}`);
    }
    else if (e.kind === "rateLimit" && e.status !== "allowed") {
        console.log(`  ⚠ rate limit: ${e.status} (${e.rateLimitType}, resetsAt ${e.resetsAt})`);
    }
    else if (e.kind === "result") {
        console.log(`  ✓ 세션 종료 (turns ${e.numTurns}, in ${e.usage.inputTokens}/out ${e.usage.outputTokens})`);
    }
}
/** harness exec --task <t> [--role r] [--base develop] [--session-id id] [--yes] [--keep-worktree] [--no-merge] */
export async function runExec(opts) {
    const sessionId = opts.sessionId ?? randomUUID();
    const runId = `exec-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const spec = {
        sessionId,
        role: opts.role ?? "구현 세션",
        task: opts.task,
        cwd: "", // runSession이 worktree로 설정
        inputs: opts.inputs,
    };
    console.log(`exec 세션: ${sessionId}\n작업: ${opts.task}\n기준 브랜치: ${opts.base ?? "develop"}`);
    const outcome = await runSession({
        repoRoot: WORKSPACE_ROOT,
        runId,
        spec,
        provider: new ClaudeCliProvider(),
        approver: opts.yes ? async () => "approve" : stdinApprover(),
        baseBranch: opts.base,
        merge: opts.merge,
        keepWorktree: opts.keepWorktree,
        onEvent: printEvent,
    });
    console.log("");
    console.log(`상태: ${outcome.status}`);
    console.log(`브랜치: ${outcome.branch}`);
    if (outcome.gate) {
        const g = outcome.gate.checks.map((c) => `${c.name}:${c.ok ? "ok" : "FAIL"}`).join(" ");
        console.log(`게이트: ${outcome.gate.passed ? "통과" : "실패"}${g ? ` (${g})` : " (체크 없음)"}`);
    }
    if (outcome.diff)
        console.log(`변경: ${outcome.diff.files.length}개 파일, 새 파일 ${outcome.diff.untracked.length}개`);
    if (outcome.usage)
        console.log(`토큰: in ${outcome.usage.inputTokens} / out ${outcome.usage.outputTokens}`);
    if (outcome.error)
        console.log(`오류: ${outcome.error}`);
    if (outcome.status === "error" || outcome.status === "gate_failed")
        process.exitCode = 1;
}
