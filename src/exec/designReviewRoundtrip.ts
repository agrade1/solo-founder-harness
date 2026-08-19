/**
 * 리뷰 왕복 계약 (offline · 순수 검증).
 *
 * - [V3 M8 T4] design review(fresh Codex) → 수정(fresh design worker).
 * - [V3 M9 T4] code/security/test review 3종(fresh Codex) → 수정(fresh Claude) → verify(fresh Codex).
 *
 * 여기서 고정하는 것은 하나다: **자기 산출물을 자기가 승인하지 않는다.** 참가자의 신원이 하나라도
 * 겹치면 왕복이 아니라 자기 승인이므로 거부한다.
 *
 * **두 번째 패턴을 만들지 않았다**(M9 KICKOFF §4.4): M9는 참가자가 6명(저자 · 리뷰 3 · 수정 · verify)
 * 으로 늘고 role 계열이 다를 뿐 규칙은 M8과 같다. 그래서 `assertRoundtrip()` **하나**를 두고 M8·M9
 * 진입점이 그것을 부른다 — 규칙이 두 곳에 살면 한쪽만 고쳐지는 날이 온다.
 *
 * kernel이 이미 하는 것을 다시 하지 않는다 — task 상태의 fresh 여부(`assertFresh`) · 리뷰 선행
 * (`requestRevision`의 `review_result_missing`) · 대상 의존은 `orchestrationKernel.ts` 게이트가 집행한다.
 * 이 모듈은 kernel이 모르는 **provider/세션 층**만 본다.
 */

/** 왕복 참가자 1명의 신원. */
export interface RoundtripParticipant {
  taskId: string;
  roleId: string;
  /** 실행 provider. 리뷰어·verify만 `codex`이고 저자·수정자는 `claude`다. */
  provider: "claude" | "codex";
  /** provider 세션 신원. 참가자 사이에 재사용이 없어야 한다. */
  sessionId: string;
  /** codex 참가자에만 의미 있는 sandbox 값. `read-only`만 허용(M5a hard deny 계약과 동일). */
  sandbox?: string;
  /** fresh 세션인가(이 세션으로 앞서 산출물을 낸 적이 없다). */
  fresh: boolean;
}

export interface DesignRoundtrip {
  /** DESIGN.md/tokens.json을 만든 design worker. */
  author: RoundtripParticipant;
  /** 리뷰어 — fresh Codex read-only. */
  reviewer: RoundtripParticipant;
  /** 수정자 — 저자와 다른 fresh design worker. */
  revision: RoundtripParticipant;
}

/**
 * **V3 M9 리뷰 3종의 닫힌 렌즈 집합**(로드맵 M9 절 "fresh Codex code/security/test review").
 * 여기 없는 렌즈는 표현할 수 없고, 목록에 항목을 더하는 것 자체가 사람의 승인 대상이다.
 */
export const CODE_REVIEW_LENSES = ["code", "security", "test"] as const;
export type CodeReviewLens = (typeof CODE_REVIEW_LENSES)[number];

/**
 * **M9 개발 파이프라인의 리뷰 왕복**: 저자 → 리뷰 3종 → 수정 → verify.
 *
 * `test` 렌즈만 `runsTests`가 참이어야 한다. **이 모듈이 증명하는 것은 "누가 테스트 실행 책임을
 * 지는가"가 계약에 못 박혔다는 것뿐**이다 — 테스트가 실제로 돌았다는 것은 kernel의 `run_process`
 * (`run-tests` action) 영수증이 증명한다. 둘을 섞지 않는다.
 */
export interface CodeReviewRoundtrip {
  /** 구현한 worker(claude). */
  author: RoundtripParticipant;
  /** 렌즈별 리뷰어 — 각각 **서로 다른** fresh Codex read-only 세션. */
  reviews: Record<CodeReviewLens, RoundtripParticipant>;
  /** 수정자 — 저자와 다른 fresh Claude. */
  revision: RoundtripParticipant;
  /** 수정 결과를 다시 보는 fresh Codex — 앞선 세 리뷰어와도 다르다. */
  verify: RoundtripParticipant;
  /** 테스트 실행 책임을 지는 렌즈(닫힌 값 — `test`만 허용). */
  testLens: CodeReviewLens;
}

export class DesignRoundtripError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DesignRoundtripError";
    this.code = code;
  }
}

/** role 계열 판정 — 상위 role 그 자체이거나 하위 한 겹(`design.*`). */
function inRoleFamily(roleId: string, family: string): boolean {
  return roleId === family || roleId.startsWith(`${family}.`);
}

function fail(code: string, msg: string): never {
  throw new DesignRoundtripError(code, msg);
}

/**
 * **왕복 계약의 유일한 구현.** M8·M9 진입점이 전부 이것을 부른다.
 *
 * @param authorRoleFamily 저자·수정자가 속해야 하는 role 계열. 리뷰어·verify는 **이 계열 밖**이어야
 *   한다(같은 역할이 자기 산출물을 검토하면 왕복이 아니다).
 */
function assertRoundtrip(spec: {
  author: RoundtripParticipant;
  /** 1명 이상. 전부 fresh Codex read-only여야 한다(verify도 여기 포함해서 넘긴다). */
  reviewers: readonly RoundtripParticipant[];
  revision: RoundtripParticipant;
  authorRoleFamily: string;
}): void {
  const { author, reviewers, revision, authorRoleFamily } = spec;
  const all = [author, ...reviewers, revision];

  // 1) 참가자의 task·세션 신원이 **전부** 달라야 한다(같으면 자기 승인이다).
  const taskIds = all.map((p) => p.taskId);
  if (new Set(taskIds).size !== all.length) {
    fail("participant_task_reused", "참가자의 taskId가 겹친다 — 자기 산출물을 자기가 승인할 수 없다");
  }
  const sessionIds = all.map((p) => p.sessionId);
  if (sessionIds.some((s) => typeof s !== "string" || s.length === 0)) {
    fail("participant_session_missing", "참가자 sessionId가 비어 있다");
  }
  if (new Set(sessionIds).size !== all.length) {
    fail("participant_session_reused", "세션이 재사용됐다 — 같은 세션의 재사용은 fresh가 아니다");
  }

  // 2) 리뷰어·수정자는 fresh 세션이어야 한다(저자는 이미 산출물을 냈으므로 요구하지 않는다).
  for (const r of reviewers) if (!r.fresh) fail("reviewer_not_fresh", "리뷰어가 fresh 세션이 아니다");
  if (!revision.fresh) fail("revision_not_fresh", "수정자가 fresh 세션이 아니다");

  // 3) provider 분업: 리뷰는 다른 엔진(codex), 저자·수정은 claude. 리뷰어 sandbox는 read-only뿐이다.
  for (const r of reviewers) {
    if (r.provider !== "codex") fail("reviewer_provider", "review는 fresh Codex여야 한다");
    if (r.sandbox !== "read-only") fail("reviewer_sandbox", "리뷰어 sandbox는 read-only여야 한다");
  }
  if (author.provider !== "claude" || revision.provider !== "claude") {
    fail("worker_provider", "worker(저자·수정)는 claude여야 한다");
  }

  // 4) role: 저자·수정자는 같은 계열, 리뷰어는 그 계열 밖(같은 역할의 자기 검토 금지).
  if (!inRoleFamily(author.roleId, authorRoleFamily) || !inRoleFamily(revision.roleId, authorRoleFamily)) {
    fail("worker_role", `저자·수정자는 ${authorRoleFamily} role이어야 한다`);
  }
  for (const r of reviewers) {
    if (inRoleFamily(r.roleId, authorRoleFamily)) {
      fail("reviewer_role", `리뷰어가 ${authorRoleFamily} role이다 — 산출 역할이 자기 산출물을 검토할 수 없다`);
    }
  }
}

/**
 * [M8] design 왕복을 검증한다. 위반이면 `DesignRoundtripError`(통과 값 없음 — 부분 통과가 없다).
 */
export function assertDesignReviewRoundtrip(rt: DesignRoundtrip): void {
  assertRoundtrip({
    author: rt.author,
    reviewers: [rt.reviewer],
    revision: rt.revision,
    authorRoleFamily: "design",
  });
}

/**
 * [M9] code/security/test 왕복을 검증한다. 위반이면 `DesignRoundtripError`.
 *
 * M8 규칙 전부에 더해 M9 고유 두 가지를 본다:
 * - **렌즈 집합이 닫혀 있다**: 정확히 `code`·`security`·`test` 셋이고 각각 다른 세션이다(하나의 Codex
 *   세션이 세 렌즈를 겸하면 "3종 리뷰"가 이름뿐이다).
 * - **테스트 실행 책임이 `test` 렌즈에 못 박힌다.** 실제로 돌았는지는 kernel 영수증이 증명한다.
 */
export function assertCodeReviewRoundtrip(rt: CodeReviewRoundtrip): void {
  const lenses = Object.keys(rt.reviews ?? {});
  const expected = [...CODE_REVIEW_LENSES];
  if (lenses.length !== expected.length || !expected.every((l) => lenses.includes(l))) {
    fail("review_lens_set", `리뷰 렌즈는 정확히 ${expected.join("·")} 셋이어야 한다`);
  }
  if (rt.testLens !== "test") {
    fail("test_lens_invalid", "테스트 실행 책임은 test 렌즈가 진다(다른 렌즈로 옮길 수 없다)");
  }
  // verify도 **리뷰어와 같은 규칙**을 지난다: fresh Codex read-only이고 저자 계열 밖이며 세션이 다르다.
  assertRoundtrip({
    author: rt.author,
    reviewers: [...expected.map((l) => rt.reviews[l]), rt.verify],
    revision: rt.revision,
    authorRoleFamily: "dev-lead",
  });
}
