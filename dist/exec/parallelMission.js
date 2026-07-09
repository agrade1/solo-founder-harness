/**
 * 병행 오케스트레이션 (ARCH §7 v4). 브리프 태스크를 **동시에** 실행한다.
 *
 * 모델: 의존 없는 태스크들을 웨이브로 묶어 concurrency 한도 내 병렬 실행(각자 worktree/ownership 격리,
 * merge 안 하고 브랜치에 커밋만) → 웨이브 끝나면 mergeCoordinator가 **직렬**로 base에 병합(ARCH §2) →
 * 병합된 태스크에 의존하던 다음 웨이브 실행. 사람 승인은 사전승인(autoApprove) — 미션 게이트만.
 *
 * 순차 runMission과 결과 타입(MissionReport) 공유. StatusBoard/Mailbox/SPLIT은 후속 v4 항목.
 */
import { randomUUID } from "node:crypto";
import { runSession } from "./sessionRunner.js";
import { autoApprove } from "./approvalQueue.js";
import { mergeSerial } from "./mergeCoordinator.js";
import { pickModel, nextStage, shouldDegrade } from "./modelPolicy.js";
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 동시 실행 상한을 지키며 items를 fn으로 처리. 결과는 입력 순서 보존. */
async function runPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                break;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}
export async function runParallelMission(opts) {
    const base = opts.baseBranch ?? "develop";
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? realSleep;
    const sessionIdFor = opts.sessionIdFor ?? (() => randomUUID());
    const concurrency = Math.max(1, opts.concurrency ?? 3);
    const degradeOnLimit = opts.brief.degradeOnLimit ?? "auto";
    let stage = opts.startStage ?? "B";
    const waits = { count: 0, totalMs: 0 };
    const degradeHistory = [];
    const results = new Map();
    const mergedIds = new Set();
    const all = opts.brief.tasks;
    const remaining = new Map(all.map((t) => [t.id, t]));
    while (remaining.size > 0) {
        // 이번 웨이브 = 남은 것 중 deps가 전부 병합된 태스크
        const wave = [...remaining.values()].filter((t) => (t.deps ?? []).every((d) => mergedIds.has(d)));
        if (wave.length === 0) {
            // 진행 불가(선행 실패) — 남은 전부 dep_unmet 보류
            for (const t of remaining.values()) {
                results.set(t.id, { taskId: t.id, status: "dep_unmet", turns: 0, usage: null, reviews: [] });
                opts.onPhase?.(t.id, "deferred");
            }
            break;
        }
        for (const t of wave)
            remaining.delete(t.id);
        let waveWaitMs = 0;
        // 웨이브 병렬 실행 (merge 안 함, worktree 보존 → 병합 코디네이터가 처리)
        const outcomes = await runPool(wave, concurrency, async (task) => {
            const model = pickModel(stage, "impl", task.difficulty);
            const outcome = await runSession({
                repoRoot: opts.repoRoot,
                runId: `pmission-${task.id}`,
                baseBranch: base,
                spec: { sessionId: sessionIdFor(task.id), role: task.role, task: task.task, cwd: "", model, ownership: task.ownership, forbidden: task.forbidden, inputs: task.inputs, dod: task.dod, budget: task.budget },
                provider: opts.coderProvider,
                approver: autoApprove,
                merge: false, // 병합은 코디네이터가 직렬로
                keepWorktree: true, // 병합까지 worktree 유지
                review: { provider: opts.reviewProvider, maxRounds: opts.reviewRounds, model: "opus" },
                onPhase: (p) => {
                    if (p === "coding" || p === "gate" || p === "review")
                        opts.onPhase?.(task.id, p);
                },
                onEvent: (e) => {
                    if (e.kind === "rateLimit" && e.status !== "allowed") {
                        const w = Math.max(0, e.resetsAt * 1000 - now());
                        waits.count++;
                        waits.totalMs += w;
                        waveWaitMs = Math.max(waveWaitMs, w);
                    }
                    opts.onEvent?.(task.id, e);
                },
            });
            return { task, outcome };
        });
        // 게이트·리뷰 통과(status "merged" = 병합 준비됨)만 직렬 병합 대상
        const ready = [];
        for (const { task, outcome } of outcomes) {
            results.set(task.id, { taskId: task.id, status: outcome.status, branch: outcome.branch, turns: outcome.turns, usage: outcome.usage, reviews: outcome.reviews, error: outcome.error });
            if (outcome.status === "merged") {
                ready.push({ taskId: task.id, branch: outcome.branch, worktreePath: outcome.worktreePath });
                opts.onPhase?.(task.id, "merging");
            }
            else {
                opts.onPhase?.(task.id, outcome.status === "error" ? "failed" : "deferred");
            }
        }
        const merges = await mergeSerial({ repoRoot: opts.repoRoot, base, items: ready });
        for (const m of merges) {
            const prev = results.get(m.taskId);
            if (m.status === "merged") {
                mergedIds.add(m.taskId);
                results.set(m.taskId, { ...prev, status: "merged" });
                opts.onPhase?.(m.taskId, "merged");
            }
            else {
                // 병합 단계 실패 → 보류로 표기
                results.set(m.taskId, { ...prev, status: m.status === "conflict" ? "merge_conflict" : m.status === "gate_failed" ? "gate_failed" : "error", error: m.error });
                opts.onPhase?.(m.taskId, m.status === "error" ? "failed" : "deferred");
            }
        }
        // 자동 강등
        if (degradeOnLimit === "auto" && stage !== "A" && shouldDegrade(waits, opts.threshold)) {
            const to = nextStage(stage);
            degradeHistory.push({ from: stage, to, afterTask: wave.map((t) => t.id).join("+") });
            stage = to;
        }
        // 다음 웨이브 전 rate limit 대기
        if (waveWaitMs > 0 && remaining.size > 0)
            await sleep(waveWaitMs);
    }
    const tasks = all.map((t) => results.get(t.id)).filter(Boolean);
    const merged = tasks.filter((t) => t.status === "merged").map((t) => t.taskId);
    const deferred = tasks.filter((t) => t.status !== "merged").map((t) => t.taskId);
    const totalUsage = tasks.reduce((a, t) => ({ inputTokens: a.inputTokens + (t.usage?.inputTokens ?? 0), outputTokens: a.outputTokens + (t.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
    return { goal: opts.brief.goal, startedStage: opts.startStage ?? "B", endedStage: stage, degradeHistory, tasks, merged, deferred, rateLimitWaits: waits, totalUsage };
}
