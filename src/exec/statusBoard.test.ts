/**
 * StatusBoard 테스트 (무과금). 테스트 환경은 비TTY → update가 전이 줄을 출력.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StatusBoard } from "./statusBoard.js";

/** console.log 캡처 */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test("비TTY: 단계 전이를 한 줄씩 출력(라벨 포함)", () => {
  const out = capture(() => {
    const b = new StatusBoard();
    b.update("t1", "coding");
    b.update("t1", "gate");
    b.update("t1", "merged");
  });
  assert.equal(out.length, 3);
  assert.ok(out[0].includes("t1") && out[0].includes("코딩"));
  assert.ok(out[1].includes("게이트"));
  assert.ok(out[2].includes("완료"));
});

test("여러 세션 독립 갱신", () => {
  const out = capture(() => {
    const b = new StatusBoard(["a", "b"]);
    b.update("a", "coding");
    b.update("b", "review");
    b.update("a", "deferred");
  });
  assert.ok(out.some((l) => l.includes("a") && l.includes("보류")));
  assert.ok(out.some((l) => l.includes("b") && l.includes("리뷰")));
});

test("note는 비TTY에서 그대로 출력", () => {
  const out = capture(() => new StatusBoard().note("경고: 무언가"));
  assert.deepEqual(out, ["경고: 무언가"]);
});
