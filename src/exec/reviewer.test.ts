/**
 * L3 리뷰어 테스트 (무과금). mock provider가 리뷰 마크다운을 재생 → Critical 추출 검증.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockExecProvider, type EventScript } from "./mockExecProvider.js";
import { reviewDiff, buildReviewPrompt } from "./reviewer.js";
import type { SessionEvent } from "./types.js";

/** 주어진 리뷰 마크다운을 result.text로 재생하는 mock provider. */
function reviewerWith(markdown: string): MockExecProvider {
  const script: EventScript = (spec): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    return [
      { kind: "init", sessionId: spec.sessionId, model: spec.model ?? "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: markdown, numTurns: 1, usage: { inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  return new MockExecProvider(script);
}

const baseInput = {
  sessionId: "rev1",
  cwd: "/tmp",
  coder: { role: "구현", task: "화면", dod: ["렌더"] },
  diff: "diff --git a/x b/x\n+bug",
};

test("Critical 있으면 목록 추출", async () => {
  const md = "## Risks\n### Critical\n- API 계약 불일치\n- 인증 우회\n### Notes\n- 사소";
  const v = await reviewDiff({ provider: reviewerWith(md), ...baseInput });
  assert.deepEqual(v.critical, ["API 계약 불일치", "인증 우회"]);
  assert.equal(v.usage?.inputTokens, 5);
});

test("Critical 없음(없음 표기) → 빈 목록 = 통과", async () => {
  const md = "## Risks\n### Critical\n- 없음\n### Notes\n- lgtm";
  const v = await reviewDiff({ provider: reviewerWith(md), ...baseInput });
  assert.deepEqual(v.critical, []);
});

test("buildReviewPrompt: diff·계약·DoD 포함 + 신선 컨텍스트 명시", () => {
  const p = buildReviewPrompt({ provider: reviewerWith(""), ...baseInput, contract: "GET /x" });
  assert.ok(p.includes("신선한 컨텍스트"));
  assert.ok(p.includes("GET /x"));
  assert.ok(p.includes("+bug"));
  assert.ok(p.includes("### Critical"));
});
