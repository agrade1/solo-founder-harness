/**
 * 미션 모드 런타임 (ARCH §6·§9-7·§9-8). 단일 목표를 태스크로 분해한 브리프를 받아
 * 사람 개입 없이(사전승인) 태스크 루프를 자율 완주하고 MISSION_REPORT를 만든다.
 *
 * 자율 경계(ARCH §4.3): develop 병합·푸시까지 자율(L1~L3 게이트 통과 조건), main은 사람 전용.
 * 미션은 이미 승인된 브리프를 실행할 뿐 — 사람 승인 게이트는 브리프 승인(시작 전 1회)뿐이다.
 *
 * 단순화(문서화): rate limit 대기는 태스크 경계에서 sleep(주입 가능)로 처리(Model A라 대기 중 프로세스 없음).
 * turn 예산 그레이스 주입은 SessionRunner에서 "revise 중단"으로 단순화. 브리프 생성기는 briefGenerator.ts.
 */
import { randomUUID } from "node:crypto";
import { runSession } from "./sessionRunner.js";
import { autoApprove } from "./approvalQueue.js";
import { pickModel, nextStage, shouldDegrade } from "./modelPolicy.js";
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 미션 브리프를 자율 실행 → MISSION_REPORT. */
export async function runMission(opts) {
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? realSleep;
    // --session-id는 UUID여야 함(CLI 요건, RECON). taskId는 runId·TaskResult로 별도 추적.
    const sessionIdFor = opts.sessionIdFor ?? (() => randomUUID());
    const degradeOnLimit = opts.brief.degradeOnLimit ?? "auto";
    let stage = opts.startStage ?? "B";
    const waits = { count: 0, totalMs: 0 };
    const degradeHistory = [];
    const tasks = [];
    const mergedIds = new Set();
    let carriedWaitMs = 0; // 직전 태스크에서 감지된 rate limit 대기 — 다음 태스크 착수 직전에만 소비
    for (const task of opts.brief.tasks) {
        // 선행 태스크 미충족이면 보류
        if (task.deps?.some((d) => !mergedIds.has(d))) {
            tasks.push({ taskId: task.id, status: "dep_unmet", turns: 0, usage: null, reviews: [] });
            continue;
        }
        // rate limit 체크포인트: 직전 태스크가 한도에 걸렸다면 resetsAt까지 대기 후 재개
        // (다음 태스크 직전에만 — 마지막 태스크 뒤엔 대기하지 않음. Model A라 대기 중 프로세스 없음)
        if (carriedWaitMs > 0) {
            await sleep(carriedWaitMs);
            carriedWaitMs = 0;
        }
        const model = pickModel(stage, "impl", task.difficulty);
        let pendingWaitMs = 0;
        const outcome = await runSession({
            repoRoot: opts.repoRoot,
            runId: `mission-${task.id}`,
            baseBranch: opts.baseBranch,
            spec: {
                sessionId: sessionIdFor(task.id),
                role: task.role,
                task: task.task,
                cwd: "",
                model,
                ownership: task.ownership,
                forbidden: task.forbidden,
                inputs: task.inputs,
                dod: task.dod,
                budget: task.budget,
            },
            provider: opts.coderProvider,
            approver: autoApprove, // 사전승인 — 미션 중 사람 개입 없음
            merge: true, // 게이트·리뷰 통과 시 develop 자동 병합 (ARCH §4.3)
            review: { provider: opts.reviewProvider, maxRounds: opts.reviewRounds, model: "opus" },
            onEvent: (e) => {
                // rate limit 신호 수집 (강등·체크포인트 근거, RECON §4)
                if (e.kind === "rateLimit" && e.status !== "allowed") {
                    const waitMs = Math.max(0, e.resetsAt * 1000 - now());
                    waits.count++;
                    waits.totalMs += waitMs;
                    pendingWaitMs = Math.max(pendingWaitMs, waitMs);
                }
                opts.onEvent?.(task.id, e);
            },
        });
        tasks.push({
            taskId: task.id,
            status: outcome.status,
            branch: outcome.branch,
            turns: outcome.turns,
            usage: outcome.usage,
            reviews: outcome.reviews,
            error: outcome.error,
        });
        if (outcome.status === "merged")
            mergedIds.add(task.id);
        // 자동 강등 판단 (auto일 때만, A가 바닥)
        if (degradeOnLimit === "auto" && stage !== "A" && shouldDegrade(waits, opts.threshold)) {
            const to = nextStage(stage);
            degradeHistory.push({ from: stage, to, afterTask: task.id });
            stage = to;
        }
        // 이번 태스크에서 감지한 대기를 다음 태스크 착수 직전으로 이월 (마지막 태스크 뒤엔 대기 없음)
        carriedWaitMs = pendingWaitMs;
    }
    const merged = tasks.filter((t) => t.status === "merged").map((t) => t.taskId);
    const deferred = tasks.filter((t) => t.status !== "merged").map((t) => t.taskId);
    const totalUsage = tasks.reduce((acc, t) => ({ inputTokens: acc.inputTokens + (t.usage?.inputTokens ?? 0), outputTokens: acc.outputTokens + (t.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
    return {
        goal: opts.brief.goal,
        startedStage: opts.startStage ?? "B",
        endedStage: stage,
        degradeHistory,
        tasks,
        merged,
        deferred,
        rateLimitWaits: waits,
        totalUsage,
    };
}
/** MISSION_REPORT.md 렌더 (사람이 아침에 검토 → 보류 결정 → main 병합). */
export function renderMissionReport(r) {
    const L = [];
    L.push(`# MISSION_REPORT`, ``, `## 목표`, r.goal, ``);
    L.push(`## 요약`);
    L.push(`- 병합(develop): ${r.merged.length}개 — ${r.merged.join(", ") || "(없음)"}`);
    L.push(`- 보류/미완: ${r.deferred.length}개 — ${r.deferred.join(", ") || "(없음)"}`);
    L.push(`- 모델 단계: ${r.startedStage} → ${r.endedStage}${r.degradeHistory.length ? ` (강등 ${r.degradeHistory.length}회)` : ""}`);
    L.push(`- rate limit 대기: ${r.rateLimitWaits.count}회 / ${Math.round(r.rateLimitWaits.totalMs / 1000)}s`);
    L.push(`- 토큰: in ${r.totalUsage.inputTokens} / out ${r.totalUsage.outputTokens}`, ``);
    if (r.degradeHistory.length) {
        L.push(`## 모델 강등 이력`);
        for (const d of r.degradeHistory)
            L.push(`- ${d.from} → ${d.to} (태스크 ${d.afterTask} 이후)`);
        L.push(``);
    }
    L.push(`## 태스크`);
    for (const t of r.tasks) {
        const rv = t.reviews.length ? ` / 리뷰 ${t.reviews.length}R(마지막 Critical ${t.reviews[t.reviews.length - 1].critical.length})` : "";
        L.push(`- **${t.taskId}**: ${t.status}${t.branch ? ` [${t.branch}]` : ""}${rv}${t.error ? ` — ${t.error}` : ""}`);
    }
    L.push(``, `## 다음 (사람)`, `- 보류 항목 결정(예산 증액/분할/폐기)`, `- MISSION_REPORT 검토 후 main 병합·푸시`, ``);
    return L.join("\n");
}
