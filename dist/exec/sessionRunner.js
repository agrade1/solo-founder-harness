/**
 * 단일 세션 오케스트레이터 (ARCH §9-5·§9-6, v3 = 세션 1개).
 * worktree → 권한 컴파일 → 프롬프트 → 세션 실행 → L1 기계 게이트 → 커밋 →
 * (선택) L3 리뷰어 루프(critique_loop 이식) → diff → 승인 → base 병합.
 *
 * 병렬/미션은 상위(v3.5/v4)에서 이 러너를 조합. 여기서는 1세션 end-to-end.
 * ⚠ 병합 = `git push . <branch>:<base>` (ff) — base가 메인 작업트리에 체크아웃돼 있으면
 *   거부될 수 있음. 견고한 병합 전략은 DESIGN_QUESTIONS Q4.
 */
import { join, basename } from "node:path";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { createWorktree, removeWorktree } from "./worktree.js";
import { compilePermissions, materializeSettings } from "./permissionCompiler.js";
import { compilePrompt } from "./promptCompiler.js";
import { collectDiff, summarizeDiff } from "./diffPreview.js";
import { runMachineGate } from "./machineGate.js";
import { reviewDiff } from "./reviewer.js";
import { runProcess } from "./runProcess.js";
async function git(cwd, args) {
    const r = await runProcess("git", ["-C", cwd, ...args]);
    return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}
/** worktree에서 계약 문서(inputs 중 contract) 전문을 읽는다(리뷰어 입력용). 없으면 undefined. */
function readContract(worktree, spec) {
    const inputs = spec.inputs ?? [];
    const contracts = inputs.filter((p) => (spec.contractPaths?.length ? spec.contractPaths.includes(p) : /API_CONTRACT/i.test(basename(p))));
    for (const c of contracts) {
        const abs = join(worktree, c);
        if (existsSync(abs))
            return readFileSync(abs, "utf8");
    }
    return undefined;
}
export async function runSession(opts) {
    const base = opts.baseBranch ?? "develop";
    const merge = opts.merge ?? true;
    let wt = null;
    const outcome = {
        sessionId: opts.spec.sessionId,
        branch: "",
        worktreePath: "",
        turns: 0,
        events: 0,
        usage: null,
        gate: null,
        diff: null,
        reviews: [],
        decision: null,
        status: "error",
    };
    // 한 turn의 이벤트를 소진하며 카운트/usage 갱신.
    async function consumeTurn(handle) {
        for await (const e of opts.provider.events(handle)) {
            outcome.events++;
            if (e.kind === "assistant")
                outcome.turns++;
            if (e.kind === "result")
                outcome.usage = e.usage;
            opts.onEvent?.(e);
        }
    }
    // 게이트 → 커밋 → diff. gatePassed=false면 즉시 중단 신호.
    async function finalize() {
        outcome.gate = await runMachineGate({ cwd: wt.path });
        if (!outcome.gate.passed)
            return { gatePassed: false, hasChanges: false };
        await git(wt.path, ["add", "-A"]);
        const staged = await git(wt.path, ["diff", "--cached", "--name-only"]);
        if (staged.out)
            await git(wt.path, ["commit", "-q", "-m", `session ${opts.spec.sessionId}: ${opts.spec.task ?? opts.spec.role}`]);
        outcome.diff = await collectDiff({ cwd: wt.path, base });
        return { gatePassed: true, hasChanges: outcome.diff.files.length > 0 || outcome.diff.untracked.length > 0 };
    }
    try {
        // 1) worktree + 전용 브랜치
        wt = await createWorktree({ repoRoot: opts.repoRoot, runId: opts.runId, sessionId: opts.spec.sessionId, baseBranch: base });
        outcome.branch = wt.branch;
        outcome.worktreePath = wt.path;
        // STATUS.md는 세션 내부 통신 파일(ARCH §3.3) — 산출물 아님. 공용 git exclude에 넣어
        // 커밋·병합·diff에서 제외한다(병렬 세션 간 STATUS.md add/add 충돌 방지).
        try {
            const ex = join(opts.repoRoot, ".git", "info", "exclude");
            if (existsSync(ex) && !readFileSync(ex, "utf8").split("\n").includes("STATUS.md"))
                appendFileSync(ex, "STATUS.md\n");
        }
        catch {
            /* best-effort */
        }
        // 2) 권한 컴파일 → settings materialize(worktree 밖, gitignore) + 확정 spec
        const compiled = compilePermissions({ ...opts.spec, cwd: wt.path });
        const settingsPath = materializeSettings(join(opts.repoRoot, ".harness", "sessions", opts.spec.sessionId), compiled);
        const spec = { ...opts.spec, cwd: wt.path, permissionMode: compiled.permissionMode, allowedTools: compiled.allow, disallowedTools: compiled.deny, settingsPath };
        // 3) 착수 프롬프트 (worktree 내용 기준)
        const prompt = compilePrompt(spec, { projectRoot: wt.path });
        // 4) 코더 세션 실행
        opts.onPhase?.("coding");
        const handle = await opts.provider.start(spec, prompt);
        await consumeTurn(handle);
        // 5) L1 게이트 + 커밋 + diff
        opts.onPhase?.("gate");
        let fin = await finalize();
        if (!fin.gatePassed)
            return ((outcome.status = "gate_failed"), outcome);
        if (!fin.hasChanges)
            return ((outcome.status = "no_changes"), outcome);
        // 6) L3 리뷰어 루프 (critique_loop 이식) — 있을 때만
        if (opts.review) {
            opts.onPhase?.("review");
            const maxRounds = Math.max(1, opts.review.maxRounds ?? 2);
            const contract = readContract(wt.path, spec);
            let passed = false;
            for (let round = 1; round <= maxRounds; round++) {
                const verdict = await reviewDiff({
                    provider: opts.review.provider,
                    sessionId: `${spec.sessionId}-review-${round}`,
                    cwd: wt.path,
                    model: opts.review.model,
                    coder: { role: spec.role, task: spec.task, dod: spec.dod, forbidden: spec.forbidden },
                    contract,
                    diff: outcome.diff.raw,
                });
                outcome.reviews.push({ round, critical: verdict.critical });
                if (verdict.critical.length === 0) {
                    passed = true;
                    break;
                }
                if (round >= maxRounds)
                    break; // 라운드 소진 — 미해결
                // turn 예산 소진이면 더 이상 revise하지 않음 (ARCH §3.1.2 — 그레이스 주입은 미션 모드 단순화)
                if (spec.budget?.maxTurns && outcome.turns >= spec.budget.maxTurns)
                    break;
                // Critical을 코더에 되먹여 revise (--resume)
                const revise = `리뷰어가 다음 Critical 이슈를 제기했다:\n` +
                    verdict.critical.map((c, i) => `${i + 1}. ${c}`).join("\n") +
                    `\n이 이슈들을 정면으로 고쳐라. 담당 경로 밖은 건드리지 말고 테스트도 갱신하라. 끝나면 STATUS를 DONE으로.`;
                await opts.provider.send(handle, revise);
                await consumeTurn(handle);
                fin = await finalize();
                if (!fin.gatePassed)
                    return ((outcome.status = "gate_failed"), outcome);
            }
            if (!passed)
                return ((outcome.status = "review_deferred"), outcome); // 보류 목록행 (ARCH §4.1)
        }
        // 7) 사람 승인
        const decision = await opts.approver({
            sessionId: spec.sessionId,
            kind: "diff-merge",
            message: `세션 '${spec.sessionId}' 결과를 ${base}에 병합할까요?`,
            detail: summarizeDiff(outcome.diff),
        });
        outcome.decision = decision;
        if (decision === "reject")
            return ((outcome.status = "rejected"), outcome);
        if (decision === "defer")
            return ((outcome.status = "deferred"), outcome);
        // 8) 병합
        if (merge) {
            opts.onPhase?.("merging");
            const push = await git(opts.repoRoot, ["push", ".", `${wt.branch}:${base}`]);
            if (push.code !== 0) {
                outcome.status = "error";
                outcome.error = `병합 실패(${wt.branch}→${base}): ${push.err || push.out}`;
                return outcome;
            }
        }
        outcome.status = "merged";
        return outcome;
    }
    catch (err) {
        outcome.status = "error";
        outcome.error = err.message;
        return outcome;
    }
    finally {
        opts.onPhase?.("done");
        if (wt && !opts.keepWorktree) {
            try {
                await removeWorktree({ repoRoot: opts.repoRoot, info: wt });
            }
            catch {
                /* 정리 실패 무시 */
            }
        }
    }
}
