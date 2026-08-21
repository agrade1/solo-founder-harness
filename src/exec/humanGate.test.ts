/**
 * V3 M7 T6 — research→PM→CEO 배선과 **사람 gate**의 red-path 고정.
 *
 * 고정하는 계약 셋:
 *  ① agent 요청 union에 `decision`을 만드는 갈래가 없다(요청만 있고 답은 없다).
 *  ② 답 없는 `decision_request`를 남긴 task는 완료할 수 없다(`decision_pending`).
 *  ③ 사람이 `recordDecision`으로 답한 뒤에야 완료가 열린다.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateTypedExecutionPlan } from "./typedPlan.js";
import { OrchestrationError } from "./orchestrationTypes.js";

const BINDING = { runId: "run-1", taskId: "t-1", attemptId: "att-1", turnId: "turn-1" };

function plan(requests: unknown[]): unknown {
  return {
    schemaVersion: "1",
    runId: BINDING.runId,
    taskId: BINDING.taskId,
    attemptId: BINDING.attemptId,
    turnId: BINDING.turnId,
    operations: [],
    requests,
    result: { summary: "요약", outputs: [] },
  };
}

test("① request_decision은 계획에서 입양된다(사람에게 묻는 통로가 존재한다)", () => {
  const p = validateTypedExecutionPlan(
    plan([{ kind: "request_decision", question: "이 근거로 진행해도 되는가", safeDefault: "진행하지 않고 대기한다" }]),
    BINDING,
  );
  assert.deepEqual(p.requests, [
    { kind: "request_decision", question: "이 근거로 진행해도 되는가", safeDefault: "진행하지 않고 대기한다" },
  ]);
});

test("① 답(decision)을 만드는 요청 갈래는 존재하지 않는다 — 계획에서 거부된다", () => {
  for (const forged of [
    { kind: "decision", question: "q", safeDefault: "s" },
    { kind: "record_decision", decision: "승인" },
    { kind: "request_decision", question: "q", safeDefault: "s", decision: "승인" },
    { kind: "request_decision", question: "q" },
  ]) {
    assert.throws(() => validateTypedExecutionPlan(plan([forged]), BINDING), OrchestrationError);
  }
});
