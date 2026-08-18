/**
 * V3 M9 선결 4(F2) — autopilot 진행 가시성. 검증하는 것은 **변환의 정확성**뿐이다:
 * 렌더링 자체는 v1 `progress.test.ts`가 이미 덮는다(재사용이라 다시 테스트하지 않는다).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "../core/progress.js";
import type { AutopilotEvent } from "../commands/autopilot.js";
import { autopilotProgressBridge } from "./autopilotProgress.js";

/** 수집 reporter + 1ms씩 전진하는 결정론적 시계. */
function harness(): { feed: (e: AutopilotEvent) => void; events: RunEvent[] } {
  const events: RunEvent[] = [];
  let n = 0;
  return { feed: autopilotProgressBridge({ emit: (e) => events.push(e) }, () => 1000 + n++), events };
}

test("[M9] F2: autopilot event가 v1 RunEvent로 옮겨진다(run→batch→step→end)", () => {
  const h = harness();
  h.feed({ kind: "run_started", detail: "run-1@ms-1" });
  h.feed({ kind: "batch_planned", detail: "alpha,beta" });
  h.feed({ kind: "task_started", taskId: "alpha", marker: "turn-1" });
  h.feed({ kind: "task_progress", taskId: "alpha", detail: "구현 중" });
  h.feed({ kind: "task_completed", taskId: "alpha", marker: "turn_completed" });
  h.feed({ kind: "run_finished", marker: "batch_empty" });

  assert.deepEqual(
    h.events.map((e) => e.type),
    ["run_start", "note", "step_start", "note", "step_end", "run_end"],
  );
  const start = h.events[2];
  assert.equal(start.type, "step_start");
  if (start.type === "step_start") {
    // **batch 크기가 total로 넘어간다** — 사람이 "1/2"를 본다.
    assert.deepEqual([start.index, start.total, start.agentId, start.kind], [1, 2, "alpha", "agent"]);
  }
  const end = h.events[4];
  assert.equal(end.type, "step_end");
  if (end.type === "step_end") {
    assert.equal(end.ok, true);
    assert.ok(end.elapsedMs >= 0, "경과 시간이 계산되지 않았다");
  }
  const fin = h.events[5];
  assert.equal(fin.type, "run_end");
  if (fin.type === "run_end") assert.equal(fin.status, "completed");
});

test("[M9] F2: 멈춘 이유(marker)는 표시에서 사라지지 않고 run은 failed로 끝난다", () => {
  // 진행 표시가 실패를 조용히 성공처럼 그리면 그것이 곧 거짓 영수증의 표시면이다.
  const h = harness();
  h.feed({ kind: "run_started" });
  h.feed({ kind: "batch_planned", detail: "alpha" });
  h.feed({ kind: "task_started", taskId: "alpha" });
  h.feed({ kind: "task_paused", taskId: "alpha", marker: "budget_tokens_exhausted", detail: "usage_unaccounted" });
  h.feed({ kind: "run_finished", marker: "paused" });

  const end = h.events.find((e) => e.type === "step_end");
  assert.ok(end && end.type === "step_end" && end.ok === false, "pause가 성공 step으로 그려졌다");
  const warn = h.events.find((e) => e.type === "note" && e.level === "warn");
  assert.ok(warn && warn.type === "note", "멈춘 이유가 표시되지 않았다");
  assert.match(warn.message, /budget_tokens_exhausted/, "marker가 표시에서 사라졌다");
  assert.match(warn.message, /usage_unaccounted/, "detail이 표시에서 사라졌다");
  const fin = h.events.find((e) => e.type === "run_end");
  assert.ok(fin && fin.type === "run_end" && fin.status === "failed", "실패한 run이 completed로 그려졌다");
});

test("[M9] F2: 열린 step이 없는 종결·중복 종결은 step_end를 만들지 않는다", () => {
  // autopilot은 batch 전에 pause하는 경로(`plan_missing`)와 위임 착지(`task_spawned`)를 갖는다 —
  // 순서를 가정하지 않는다는 것이 이 테스트의 내용이다.
  const h = harness();
  h.feed({ kind: "run_started" });
  h.feed({ kind: "task_paused", taskId: "ghost", marker: "plan_missing" }); // step_start 없음
  h.feed({ kind: "task_started", taskId: "alpha" });
  h.feed({ kind: "task_spawned", taskId: "alpha", marker: "waiting_children", detail: "child-1" });
  h.feed({ kind: "task_completed", taskId: "alpha", marker: "turn_completed" }); // 두 번째 종결

  const ends = h.events.filter((e) => e.type === "step_end");
  assert.equal(ends.length, 1, "열린 step 하나에 step_end가 하나가 아니다");
  assert.equal(h.events.filter((e) => e.type === "step_start").length, 1);
  // 열린 step 없는 종결은 경고 note로 남는다(조용히 버리지 않는다).
  assert.ok(
    h.events.some((e) => e.type === "note" && e.message.includes("ghost") && e.message.includes("plan_missing")),
    "열린 step 없는 pause가 표시에서 사라졌다",
  );
});

test("[M9] F2: 표시 실패는 실행 실패가 아니다(reporter가 던져도 전파되지 않는다)", () => {
  // 표시 계층이 실행 판정을 바꾸는 방향은 열지 않는다(닫힌 stdout·EPIPE).
  const feed = autopilotProgressBridge({
    emit: () => {
      throw new Error("EPIPE");
    },
  });
  for (const e of [
    { kind: "run_started" },
    { kind: "batch_planned", detail: "a" },
    { kind: "task_started", taskId: "a" },
    { kind: "task_progress", taskId: "a", detail: "x" },
    { kind: "task_paused", taskId: "a", marker: "m" },
    { kind: "run_finished", marker: "done" },
  ] as AutopilotEvent[]) {
    feed(e); // 던지면 이 테스트가 실패한다
  }
});

test("[M9] F2: 표시 문자열은 bounded다(marker·detail이 렌더러 줄을 무한히 늘리지 않는다)", () => {
  const h = harness();
  h.feed({ kind: "run_started" });
  h.feed({ kind: "task_started", taskId: "alpha" });
  h.feed({ kind: "task_paused", taskId: "alpha", marker: "x".repeat(5_000), detail: "y".repeat(5_000) });
  for (const e of h.events) {
    if (e.type === "note") assert.ok(e.message.length <= 120, `note가 bounded가 아니다: ${e.message.length}`);
    if (e.type === "step_start" && e.label !== undefined) assert.ok(e.label.length <= 120);
    if (e.type === "run_start") assert.ok(e.workflow.length <= 120);
  }
});
