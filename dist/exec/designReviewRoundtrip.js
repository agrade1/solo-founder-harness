/**
 * [V3 M8 T4] design review(fresh Codex) → 수정(fresh design worker) 왕복 계약 (offline · 순수 검증).
 *
 * 로드맵 M8 절: "design review는 fresh Codex, 수정은 fresh design worker." 여기서 고정하는 것은
 * **자기 산출물을 자기가 승인하지 않는다**는 성질이다. 세 참가자(저자 · 리뷰어 · 수정자)의 신원이
 * 하나라도 겹치면 왕복이 아니라 자기 승인이므로 거부한다.
 *
 * kernel이 이미 하는 것을 다시 하지 않는다 — task 상태의 fresh 여부(`assertFresh`)·리뷰 선행
 * (`requestRevision`의 `review_result_missing`)·대상 의존은 `orchestrationKernel.ts` 게이트가 집행한다.
 * 이 모듈은 kernel이 모르는 **provider/세션 층**만 본다: 리뷰어가 다른 엔진(codex)의 read-only fresh
 * 세션인지, 그리고 세 참가자가 세션을 재사용하지 않는지.
 */
export class DesignRoundtripError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "DesignRoundtripError";
        this.code = code;
    }
}
const DESIGN_ROLE_PREFIX = "design"; // registry 상위 role `design`(+ 하위 한 겹 `design.*`)
function isDesignRole(roleId) {
    return roleId === DESIGN_ROLE_PREFIX || roleId.startsWith(`${DESIGN_ROLE_PREFIX}.`);
}
/**
 * 왕복 계약을 검증한다. 위반이면 `DesignRoundtripError`(통과 값 없음 — 부분 통과가 없다).
 */
export function assertDesignReviewRoundtrip(rt) {
    const { author, reviewer, revision } = rt;
    const fail = (code, msg) => {
        throw new DesignRoundtripError(code, msg);
    };
    // 1) 세 참가자의 task·세션 신원이 전부 달라야 한다(같으면 자기 승인이다).
    const taskIds = [author.taskId, reviewer.taskId, revision.taskId];
    if (new Set(taskIds).size !== 3)
        fail("participant_task_reused", "저자·리뷰어·수정자의 taskId가 겹친다 — 자기 산출물을 자기가 승인할 수 없다");
    const sessionIds = [author.sessionId, reviewer.sessionId, revision.sessionId];
    if (sessionIds.some((s) => typeof s !== "string" || s.length === 0))
        fail("participant_session_missing", "참가자 sessionId가 비어 있다");
    if (new Set(sessionIds).size !== 3)
        fail("participant_session_reused", "세션이 재사용됐다 — 같은 세션의 재사용은 fresh가 아니다");
    // 2) 리뷰어·수정자는 fresh 세션이어야 한다(저자는 이미 산출물을 냈으므로 요구하지 않는다).
    if (!reviewer.fresh)
        fail("reviewer_not_fresh", "리뷰어가 fresh 세션이 아니다");
    if (!revision.fresh)
        fail("revision_not_fresh", "수정자가 fresh 세션이 아니다");
    // 3) provider 분업: 리뷰는 다른 엔진(codex), 저자·수정은 claude.
    if (reviewer.provider !== "codex")
        fail("reviewer_provider", "design review는 fresh Codex여야 한다");
    if (author.provider !== "claude" || revision.provider !== "claude")
        fail("worker_provider", "design worker(저자·수정)는 claude여야 한다");
    if (reviewer.sandbox !== "read-only")
        fail("reviewer_sandbox", "리뷰어 sandbox는 read-only여야 한다");
    // 4) role: 저자·수정자는 design role, 리뷰어는 design role이 아니다(같은 역할의 자기 검토 금지).
    if (!isDesignRole(author.roleId) || !isDesignRole(revision.roleId))
        fail("worker_role", "저자·수정자는 design role이어야 한다");
    if (isDesignRole(reviewer.roleId))
        fail("reviewer_role", "리뷰어가 design role이다 — 산출 역할이 자기 산출물을 검토할 수 없다");
}
