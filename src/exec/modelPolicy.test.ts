import { test } from "node:test";
import assert from "node:assert/strict";
import { pickModel, nextStage, shouldDegrade } from "./modelPolicy.js";

test("pickModel: 계획·리뷰는 항상 Opus", () => {
  for (const s of ["B", "C", "A"] as const) {
    assert.equal(pickModel(s, "plan"), "opus");
    assert.equal(pickModel(s, "review"), "opus");
  }
});

test("pickModel: 구현은 단계별 — B전부opus / C난이도라우팅 / A전부sonnet", () => {
  assert.equal(pickModel("B", "impl", "simple"), "opus");
  assert.equal(pickModel("C", "impl", "hard"), "opus");
  assert.equal(pickModel("C", "impl", "simple"), "sonnet");
  assert.equal(pickModel("A", "impl", "hard"), "sonnet");
});

test("nextStage: B→C→A(바닥)", () => {
  assert.equal(nextStage("B"), "C");
  assert.equal(nextStage("C"), "A");
  assert.equal(nextStage("A"), "A");
});

test("shouldDegrade: 횟수 또는 누적 대기 임계 초과", () => {
  assert.equal(shouldDegrade({ count: 0, totalMs: 0 }), false);
  assert.equal(shouldDegrade({ count: 2, totalMs: 0 }), true);
  assert.equal(shouldDegrade({ count: 0, totalMs: 3_600_000 }), true);
  assert.equal(shouldDegrade({ count: 1, totalMs: 0 }, { count: 1, totalMs: 9e9 }), true);
});
