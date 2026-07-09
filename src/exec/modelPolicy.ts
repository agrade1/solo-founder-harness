/**
 * 모델 정책 다이얼 (ARCH §1.1). 한도 소진 속도 대 품질의 사다리.
 *   B(기본): 전 역할 Opus / C: 어려운 구현만 Opus, 단순은 Sonnet / A: 구현 전부 Sonnet.
 * 어느 단계든 계획·리뷰는 Opus 고정.
 */
export type DegradeStage = "B" | "C" | "A";
export type Role = "plan" | "impl" | "review";
export type Difficulty = "hard" | "simple";

/** 단계·역할·난이도 → --model 값. */
export function pickModel(stage: DegradeStage, role: Role, difficulty: Difficulty = "hard"): string {
  if (role === "plan" || role === "review") return "opus"; // 항상 Opus (품질 방어 마지막 층)
  // impl
  if (stage === "B") return "opus";
  if (stage === "C") return difficulty === "hard" ? "opus" : "sonnet";
  return "sonnet"; // A: 구현 전부 Sonnet
}

/** 다음 강등 단계 (A가 바닥). */
export function nextStage(s: DegradeStage): DegradeStage {
  return s === "B" ? "C" : "A";
}

export interface RateWaitStats {
  count: number; // rate limit 대기 횟수
  totalMs: number; // 누적 대기 ms
}

export interface DegradeThreshold {
  count: number; // 이 횟수 초과 시 강등 (기본 2)
  totalMs: number; // 이 누적 대기 초과 시 강등 (기본 1h)
}

export const DEFAULT_THRESHOLD: DegradeThreshold = { count: 2, totalMs: 60 * 60 * 1000 };

/** 누적 rate limit 대기가 임계 초과면 강등 필요. (ARCH §1.1 C단계 조건) */
export function shouldDegrade(waits: RateWaitStats, t: DegradeThreshold = DEFAULT_THRESHOLD): boolean {
  return waits.count >= t.count || waits.totalMs >= t.totalMs;
}
