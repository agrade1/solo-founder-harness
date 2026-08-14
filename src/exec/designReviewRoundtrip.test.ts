/**
 * [V3 M8 T4] design review 왕복 red-path 테스트 (무의존, node:test).
 * 같은 세션 재사용·같은 task·잘못된 provider/sandbox/role이 각각 거부되는지 고정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDesignReviewRoundtrip, DesignRoundtripError, type DesignRoundtrip } from "./designReviewRoundtrip.js";

const OK: DesignRoundtrip = {
  author: { taskId: "design-1", roleId: "design", provider: "claude", sessionId: "s-author", fresh: false },
  reviewer: { taskId: "review-1", roleId: "qa-security", provider: "codex", sessionId: "s-review", sandbox: "read-only", fresh: true },
  revision: { taskId: "design-2", roleId: "design.revise", provider: "claude", sessionId: "s-revise", fresh: true },
};

/** 깊은 복제 + 부분 변형. */
function rt(f: (r: DesignRoundtrip) => void): DesignRoundtrip {
  const r = JSON.parse(JSON.stringify(OK)) as DesignRoundtrip;
  f(r);
  return r;
}

const codeOf = (r: DesignRoundtrip): string => {
  try {
    assertDesignReviewRoundtrip(r);
  } catch (e) {
    return e instanceof DesignRoundtripError ? e.code : `unexpected:${(e as Error).name}`;
  }
  return "(통과했다)";
};

test("정상 왕복은 통과한다", () => {
  assert.equal(codeOf(OK), "(통과했다)");
});

test("같은 세션 재사용은 red (저자↔리뷰어 · 리뷰어↔수정자)", () => {
  assert.equal(codeOf(rt((r) => (r.reviewer.sessionId = "s-author"))), "participant_session_reused");
  assert.equal(codeOf(rt((r) => (r.revision.sessionId = "s-review"))), "participant_session_reused");
  assert.equal(codeOf(rt((r) => (r.revision.sessionId = "s-author"))), "participant_session_reused");
  assert.equal(codeOf(rt((r) => (r.reviewer.sessionId = ""))), "participant_session_missing");
});

test("같은 task 재사용(자기 승인)은 red", () => {
  assert.equal(codeOf(rt((r) => (r.reviewer.taskId = "design-1"))), "participant_task_reused");
  assert.equal(codeOf(rt((r) => (r.revision.taskId = "design-1"))), "participant_task_reused");
});

test("fresh 아님은 red (리뷰어·수정자)", () => {
  assert.equal(codeOf(rt((r) => (r.reviewer.fresh = false))), "reviewer_not_fresh");
  assert.equal(codeOf(rt((r) => (r.revision.fresh = false))), "revision_not_fresh");
});

test("provider 분업 위반은 red", () => {
  assert.equal(codeOf(rt((r) => (r.reviewer.provider = "claude"))), "reviewer_provider");
  assert.equal(codeOf(rt((r) => (r.revision.provider = "codex"))), "worker_provider");
  assert.equal(codeOf(rt((r) => (r.author.provider = "codex"))), "worker_provider");
  assert.equal(codeOf(rt((r) => (r.reviewer.sandbox = "workspace-write"))), "reviewer_sandbox");
  assert.equal(codeOf(rt((r) => delete r.reviewer.sandbox)), "reviewer_sandbox");
});

test("role 위반은 red (design role이 자기 산출물 검토 / 수정자가 design 아님)", () => {
  assert.equal(codeOf(rt((r) => (r.reviewer.roleId = "design"))), "reviewer_role");
  assert.equal(codeOf(rt((r) => (r.reviewer.roleId = "design.review"))), "reviewer_role");
  assert.equal(codeOf(rt((r) => (r.revision.roleId = "tech-lead"))), "worker_role");
  assert.equal(codeOf(rt((r) => (r.author.roleId = "pm"))), "worker_role");
});
