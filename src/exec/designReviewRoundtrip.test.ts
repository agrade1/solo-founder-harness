/**
 * [V3 M8 T4] design review 왕복 red-path 테스트 (무의존, node:test).
 * 같은 세션 재사용·같은 task·잘못된 provider/sandbox/role이 각각 거부되는지 고정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_REVIEW_LENSES,
  DesignRoundtripError,
  assertCodeReviewRoundtrip,
  assertDesignReviewRoundtrip,
  type CodeReviewRoundtrip,
  type DesignRoundtrip,
} from "./designReviewRoundtrip.js";

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

// ── [V3 M9 T4] code/security/test 리뷰 왕복 ──────────────────────────────────

const OK9: CodeReviewRoundtrip = {
  author: { taskId: "impl-a", roleId: "dev-lead", provider: "claude", sessionId: "s-author", fresh: false },
  reviews: {
    code: { taskId: "rev-code", roleId: "tech-lead", provider: "codex", sessionId: "s-code", sandbox: "read-only", fresh: true },
    security: { taskId: "rev-sec", roleId: "qa-security", provider: "codex", sessionId: "s-sec", sandbox: "read-only", fresh: true },
    test: { taskId: "rev-test", roleId: "qa-security.test", provider: "codex", sessionId: "s-test", sandbox: "read-only", fresh: true },
  },
  revision: { taskId: "impl-a-fix", roleId: "dev-lead.revise", provider: "claude", sessionId: "s-revise", fresh: true },
  verify: { taskId: "verify-1", roleId: "tech-lead.verify", provider: "codex", sessionId: "s-verify", sandbox: "read-only", fresh: true },
  testLens: "test",
};

function rt9(f: (r: CodeReviewRoundtrip) => void): CodeReviewRoundtrip {
  const r = JSON.parse(JSON.stringify(OK9)) as CodeReviewRoundtrip;
  f(r);
  return r;
}
function code9(r: CodeReviewRoundtrip): string {
  try {
    assertCodeReviewRoundtrip(r);
    return "no-error";
  } catch (e) {
    return e instanceof DesignRoundtripError ? e.code : `non-roundtrip:${String(e)}`;
  }
}

test("[M9] T4: 정상 왕복(저자 → 리뷰 3종 → 수정 → verify)은 통과한다", () => {
  assertCodeReviewRoundtrip(OK9);
});

test("[M9] T4: 리뷰 렌즈 집합은 닫혀 있다(3종 정확히)", () => {
  // 하나의 세션이 여러 렌즈를 겸하거나 렌즈가 빠지면 "3종 리뷰"가 이름뿐이다.
  assert.equal(code9(rt9((r) => delete (r.reviews as Record<string, unknown>).security)), "review_lens_set");
  assert.equal(code9(rt9((r) => ((r.reviews as Record<string, unknown>).perf = { ...r.reviews.code, taskId: "rev-perf", sessionId: "s-perf" }))), "review_lens_set");
  assert.deepEqual([...CODE_REVIEW_LENSES], ["code", "security", "test"], "렌즈 목록이 승인 없이 늘었다");
});

test("[M9] T4: 여섯 참가자의 task·세션이 하나라도 겹치면 거부다(자기 승인 금지)", () => {
  // 저자가 자기 코드를 리뷰한다.
  assert.equal(code9(rt9((r) => (r.reviews.code.taskId = "impl-a"))), "participant_task_reused");
  // 수정자가 저자와 같은 task다.
  assert.equal(code9(rt9((r) => (r.revision.taskId = "impl-a"))), "participant_task_reused");
  // verify가 앞선 리뷰어와 같은 task다 — 자기 리뷰 결과를 자기가 확인한다.
  assert.equal(code9(rt9((r) => (r.verify.taskId = "rev-code"))), "participant_task_reused");
  // 세 리뷰어가 **하나의 Codex 세션**을 공유한다.
  assert.equal(code9(rt9((r) => (r.reviews.security.sessionId = "s-code"))), "participant_session_reused");
  // verify가 리뷰어 세션을 재사용한다.
  assert.equal(code9(rt9((r) => (r.verify.sessionId = "s-test"))), "participant_session_reused");
  assert.equal(code9(rt9((r) => (r.verify.sessionId = ""))), "participant_session_missing");
});

test("[M9] T4: 리뷰어·verify는 fresh Codex read-only여야 한다", () => {
  for (const lens of CODE_REVIEW_LENSES) {
    assert.equal(code9(rt9((r) => (r.reviews[lens].provider = "claude"))), "reviewer_provider", lens);
    assert.equal(code9(rt9((r) => (r.reviews[lens].sandbox = "workspace-write"))), "reviewer_sandbox", lens);
    assert.equal(code9(rt9((r) => (r.reviews[lens].fresh = false))), "reviewer_not_fresh", lens);
  }
  // **verify도 같은 규칙을 지난다** — 여기가 느슨하면 왕복의 마지막 칸이 비어 있는 것이다.
  assert.equal(code9(rt9((r) => (r.verify.provider = "claude"))), "reviewer_provider");
  assert.equal(code9(rt9((r) => (r.verify.sandbox = "workspace-write"))), "reviewer_sandbox");
  assert.equal(code9(rt9((r) => (r.verify.fresh = false))), "reviewer_not_fresh");
});

test("[M9] T4: 구현 역할이 자기 산출물을 검토할 수 없다", () => {
  assert.equal(code9(rt9((r) => (r.reviews.code.roleId = "dev-lead"))), "reviewer_role");
  assert.equal(code9(rt9((r) => (r.reviews.test.roleId = "dev-lead.qa"))), "reviewer_role");
  assert.equal(code9(rt9((r) => (r.verify.roleId = "dev-lead"))), "reviewer_role");
  // 저자·수정자는 구현 계열이어야 한다(리뷰어가 수정하는 배선 금지).
  assert.equal(code9(rt9((r) => (r.revision.roleId = "qa-security"))), "worker_role");
  assert.equal(code9(rt9((r) => (r.author.roleId = "design"))), "worker_role");
  assert.equal(code9(rt9((r) => (r.revision.provider = "codex"))), "worker_provider");
});

test("[M9] T4: 테스트 실행 책임은 test 렌즈에 못 박힌다", () => {
  assert.equal(code9(rt9((r) => (r.testLens = "code"))), "test_lens_invalid");
  assert.equal(code9(rt9((r) => ((r as { testLens: string }).testLens = "perf"))), "test_lens_invalid");
});

test("[M9] T4: M8 design 왕복 계약은 그대로다(같은 구현을 공유해도 규칙이 섞이지 않는다)", () => {
  // 일반화하면서 M8이 느슨해지지 않았는지 — design 리뷰어에 dev-lead role은 여전히 허용이고
  // (design 계열이 아니므로) design role 리뷰어는 여전히 거부다.
  assertDesignReviewRoundtrip(rt((r) => (r.reviewer.roleId = "dev-lead")));
  assert.throws(
    () => assertDesignReviewRoundtrip(rt((r) => (r.reviewer.roleId = "design.audit"))),
    (e: unknown) => e instanceof DesignRoundtripError && e.code === "reviewer_role",
  );
  // 반대로 M9에서는 dev-lead 리뷰어가 거부다 — 계열이 진입점마다 다르다는 것이 지켜진다.
  assert.equal(code9(rt9((r) => (r.reviews.code.roleId = "dev-lead"))), "reviewer_role");
});
