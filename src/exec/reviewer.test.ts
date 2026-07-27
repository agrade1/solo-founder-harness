/**
 * L3 리뷰어 테스트 (무과금). mock provider가 리뷰 마크다운을 재생 → Critical 추출 + **fail closed 게이트** 검증.
 * V3 M5b: 유예 대장 `B-8`(리뷰 결과 무비판 수용)을 닫는 회귀가 여기 있다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockExecProvider, type EventScript } from "./mockExecProvider.js";
import { reviewDiff, buildReviewPrompt } from "./reviewer.js";
import { OrchestrationError } from "./orchestrationTypes.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";

const USAGE = { inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** 주어진 리뷰 마크다운을 result.text로 재생하는 mock provider. */
function reviewerWith(markdown: string, over: Partial<Extract<SessionEvent, { kind: "result" }>> = {}): MockExecProvider {
  const script: EventScript = (spec): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    return [
      { kind: "init", sessionId: spec.sessionId, model: spec.model ?? "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], mcpServers: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: markdown, numTurns: 1, usage: USAGE, totalCostUsd: 0, permissionDenials: [], raw, ...over },
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

async function gateCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "(통과)";
  } catch (e) {
    assert.ok(e instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(e)}`);
    return e.code;
  }
}

test("Critical 있으면 목록 추출", async () => {
  const md = "## Risks\n### Critical\n- API 계약 불일치\n- 인증 우회\n### Notes\n- 사소\n## Verdict: block";
  const v = await reviewDiff({ provider: reviewerWith(md), ...baseInput });
  assert.deepEqual(v.critical, ["API 계약 불일치", "인증 우회"]);
  assert.equal(v.verdict, "block");
  assert.equal(v.usage?.inputTokens, 5);
});

test("Critical 없음(없음 표기) → 빈 목록 = 통과", async () => {
  const md = "## Risks\n### Critical\n- 없음\n### Notes\n- lgtm\n## Verdict: pass";
  const v = await reviewDiff({ provider: reviewerWith(md), ...baseInput });
  assert.deepEqual(v.critical, []);
  assert.equal(v.verdict, "pass");
});

test("buildReviewPrompt: diff·계약·DoD 포함 + 신선 컨텍스트·필수 헤더 명시", () => {
  const p = buildReviewPrompt({ provider: reviewerWith(""), ...baseInput, contract: "GET /x" });
  assert.ok(p.includes("신선한 컨텍스트"));
  assert.ok(p.includes("GET /x"));
  assert.ok(p.includes("+bug"));
  assert.ok(p.includes("### Critical"));
  assert.ok(p.includes("## Verdict:"), "verdict를 요구하지 않으면 게이트가 항상 fail closed가 된다");
});

// ── B-8: 리뷰 게이트는 fail closed다 ────────────────────────────────────────
//
// 이전 판은 아래 모든 경우에 `extractCriticalRisks("")` = **Critical 0건**을 돌려줬다 → 리뷰어가
// 실패하거나 침묵해도 "통과"였다. 이제 전부 판정 없이 던진다(안정 코드 1개씩).

test("[M5b] B-8: 리뷰어 실패·침묵·무구조 출력은 통과가 되지 않는다", async () => {
  const cases: Array<[string, MockExecProvider, string]> = [
    ["isError", reviewerWith("## Risks\n### Critical\n- 없음\n## Verdict: pass", { isError: true, terminalReason: "exit_error" }), "reviewer_result_error"],
    ["빈 출력", reviewerWith(""), "reviewer_empty_output"],
    ["공백뿐", reviewerWith("   \n\t\n "), "reviewer_empty_output"],
    ["헤더 없음", reviewerWith("리뷰 못 했습니다. 다시 요청해 주세요."), "reviewer_malformed_output"],
    ["Risks 헤더만", reviewerWith("## Risks\n- 대충 괜찮음\n## Verdict: pass"), "reviewer_malformed_output"],
    ["verdict 없음", reviewerWith("## Risks\n### Critical\n- 없음\n### Notes\n- lgtm"), "reviewer_verdict_invalid"],
    ["verdict 미상 값", reviewerWith("## Risks\n### Critical\n- 없음\n## Verdict: 아마도"), "reviewer_verdict_invalid"],
    // 템플릿을 그대로 복사한 출력도 판정이 아니다(세 값 중 하나를 고르지 않았다).
    ["템플릿 그대로", reviewerWith("## Risks\n### Critical\n- 없음\n## Verdict: pass | revise | block"), "reviewer_verdict_invalid"],
    ["pass인데 Critical 있음", reviewerWith("## Risks\n### Critical\n- 인증 우회\n## Verdict: pass"), "reviewer_verdict_invalid"],
    ["block인데 Critical 없음", reviewerWith("## Risks\n### Critical\n- 없음\n## Verdict: block"), "reviewer_verdict_invalid"],
  ];
  for (const [label, provider, code] of cases) {
    assert.equal(await gateCode(() => reviewDiff({ provider, ...baseInput })), code, label);
  }
});

test("[M5b] B-8: 종료 결과가 아예 없으면 통과가 아니다", async () => {
  // init만 내고 result 없이 스트림이 닫히는 리뷰어(세션이 죽었거나 아무 말도 못 한 경우).
  const script: EventScript = (spec) => [
    { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], mcpServers: [], raw: { type: "mock" } },
  ];
  const provider = new MockExecProvider(script);
  assert.equal(await gateCode(() => reviewDiff({ provider, ...baseInput })), "reviewer_no_result");
});

test("[M5b] B-8: provider가 던지거나 스트림이 터지면 통과가 아니다", async () => {
  const failStart: ExecutionProvider = {
    id: "fail-start",
    start: async () => {
      throw new OrchestrationError("codex_spawn_failed", "spawn 실패");
    },
    send: async () => undefined,
    events: () => {
      throw new Error("도달 불가");
    },
    stop: async () => undefined,
  };
  assert.equal(await gateCode(() => reviewDiff({ provider: failStart, ...baseInput })), "reviewer_provider_failed");

  let stopped = 0;
  const failStream: ExecutionProvider = {
    id: "fail-stream",
    start: async (spec: SessionSpec): Promise<SessionHandle> => ({ sessionId: spec.sessionId, spec }),
    send: async () => undefined,
    events: () =>
      (async function* () {
        yield { kind: "status", sessionId: "rev1", status: "working", raw: { type: "mock" } } as SessionEvent;
        throw new Error("스트림 붕괴");
      })(),
    stop: async () => {
      stopped++;
    },
  };
  assert.equal(await gateCode(() => reviewDiff({ provider: failStream, ...baseInput })), "reviewer_provider_failed");
  assert.equal(stopped, 1, "실패한 리뷰도 세션을 닫아야 한다");
});
