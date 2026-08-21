/**
 * 실행 진행 이벤트 모델 (V3 F2 / MCP M1).
 *
 * runWorkflow는 진행 상황을 console.log로 직접 그리지 않고 RunEvent를 방출한다.
 * 렌더러(commands/progress.ts)가 이벤트를 소비해 TTY 스피너 / 비-TTY 라인 로그로 그린다.
 * 이유: (a) 테스트에서 이벤트 시퀀스를 검증 가능, (b) 비-TTY 자동 강등,
 * (c) step 타이밍 데이터가 부산물로 생겨 run_state.step_timings에 저장된다.
 *
 * 의존성 0. core는 TTY/렌더링을 모른다 — 전부 ProgressReporter 뒤에 격리.
 */

/** 하나의 실행 단위(step) 종류. 모든 실제 workflow step에 부여된다. */
export type StepKind = "agent" | "critic" | "revise" | "spawn" | "gate" | "approval";

export type RunEvent =
  // ── 실행 생명주기 (F2) ──────────────────────────────
  | { type: "run_start"; workflow: string; totalSteps: number; resumeFrom?: number }
  | {
      type: "step_start";
      index: number; // 1-based, workflow top-level step 순번
      total: number; // workflow의 실제 top-level step 수
      agentId: string;
      kind: StepKind;
      round?: number; // critique 라운드 (critic/revise)
      label?: string; // 표시 전용 라벨 (있으면 렌더러가 그대로 사용). semantic 아님.
    }
  | {
      type: "step_end";
      index: number;
      agentId: string;
      kind: StepKind;
      ok: boolean; // 정상 산출 여부. 예외/검증 실패 시 false.
      elapsedMs: number;
      round?: number;
      tokens?: { in: number; out: number };
      savedTo?: string;
    }
  | { type: "gate_jump"; decider: string; decision: string; target: string }
  | { type: "run_end"; status: "completed" | "failed"; elapsedMs: number }
  // ── tool 이벤트 타입 골격 (M1: 타입만 정의, 방출 없음. 실제 배선은 M3+) ──
  | { type: "tool_start"; server: string; tool: string; callId: string }
  | { type: "tool_end"; callId: string; ok: boolean; elapsedMs: number; resultBytes?: number }
  | { type: "tool_denied"; server: string; tool: string; reason: string }
  // ── 자문 라인 패스스루 (기존 reporter.note 대체) ──
  | { type: "note"; level: "info" | "warn"; message: string };

/** core가 진행 이벤트를 방출하는 유일한 창구. 미주입 시 no-op(테스트/프로그램 호출). */
export interface ProgressReporter {
  emit(e: RunEvent): void;
}
