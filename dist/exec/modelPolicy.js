/** 단계·역할·난이도 → --model 값. */
export function pickModel(stage, role, difficulty = "hard") {
    if (role === "plan" || role === "review")
        return "opus"; // 항상 Opus (품질 방어 마지막 층)
    // impl
    if (stage === "B")
        return "opus";
    if (stage === "C")
        return difficulty === "hard" ? "opus" : "sonnet";
    return "sonnet"; // A: 구현 전부 Sonnet
}
/** 다음 강등 단계 (A가 바닥). */
export function nextStage(s) {
    return s === "B" ? "C" : "A";
}
export const DEFAULT_THRESHOLD = { count: 2, totalMs: 60 * 60 * 1000 };
/** 누적 rate limit 대기가 임계 초과면 강등 필요. (ARCH §1.1 C단계 조건) */
export function shouldDegrade(waits, t = DEFAULT_THRESHOLD) {
    return waits.count >= t.count || waits.totalMs >= t.totalMs;
}
