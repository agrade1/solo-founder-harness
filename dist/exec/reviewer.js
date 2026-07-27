/**
 * L3 리뷰어 세션 (ARCH §4.1). 코더와 대화 이력을 공유하지 않는 **신선 컨텍스트** 세션이
 * diff + SPEC + API_CONTRACT만 보고 결함을 낸다. critique_loop의 실행 계층 이식.
 *
 * - 리뷰어는 항상 Opus 고정, 읽기 전용(`permissionMode: "plan"` — 편집 금지).
 * - --fork-session 금지: fork는 코더 컨텍스트 복제라 신선 컨텍스트 원칙과 정반대(ARCH §4.1). 매번 새 세션.
 * - 출력 스키마는 **활성 로드맵 §5.2 `review_result`** 다(이전 판의 `## Risks`/`### Critical`이 아니다).
 *
 * **리뷰 게이트는 fail closed다(V3 M5b · 유예 대장 `B-8`).** 2026-07-27 독립 fresh Codex 리뷰(A5)가
 * 첫 판의 게이트를 다시 열었다: ⓐ 종료 결과를 **덮어썼으므로** 실패 종료 뒤 성공 종료가 오면 통과였고
 * ⓑ 필수 헤더를 `raw.includes(...)` **부분 문자열**로만 봤으므로 ` ```diff ` 코드 펜스 안의 헤더나
 * 프롬프트 인용이 헤더로 통했고 ⓒ 첫 verdict·첫 Critical만 읽었으므로 **모순되는 섹션을 중복**으로 넣어
 * 원하는 판정을 고를 수 있었다. 현행 계약:
 *
 *   ⓐ provider가 던짐 · 스트림 소비 실패 → `reviewer_provider_failed`
 *   ⓑ 종료(result) 이벤트 없음 → `reviewer_no_result`
 *   ⓒ 종료 결과가 2건 이상이거나 종료 뒤 이벤트가 더 옴 → `reviewer_duplicate_terminal`
 *   ⓓ `result.isError` → `reviewer_result_error`
 *   ⓔ 본문이 비었거나 공백뿐 → `reviewer_empty_output`
 *   ⓕ 구조 위반 → `reviewer_malformed_output`: **코드 펜스를 걷어낸** 본문에서 top-level `## ` heading을
 *      뽑아 §5.2 필수 6개(`Reviewed Revision and Hash` · `Findings (P0/P1/P2)` ·
 *      `Reproduction or Evidence` · `Missing Tests` · `Contract Deviations` · `Verdict`)가 **각각 정확히
 *      1회**여야 하고, **미상 heading은 거부**이며, findings 섹션은 `없음` 또는 `P0/P1/P2` 항목 중
 *      **하나만** 말해야 한다(둘 다면 모순 = 거부).
 *   ⓖ 대상 신원 불일치 → `reviewer_subject_mismatch`: `## Reviewed Revision and Hash`가 호출자가
 *      **명시로 준** `subject.revision`·`subject.hash`를 둘 다 담아야 한다(리뷰어의 자기 주장을 신뢰하지 않는다).
 *   ⓗ verdict 위반 → `reviewer_verdict_invalid`: `pass|revise|block` 정확히 1개여야 하고, `pass`는
 *      **P0·P1이 0건일 때만** 성립한다(P2는 pass와 공존한다).
 *
 * 판정을 만들지 못하면 **호출자는 "결함 0건 = 통과"를 얻지 못한다** — 그것이 이 게이트의 요점이다.
 * 세션은 성공·실패 어느 경로에서도 `stop()`으로 닫는다(취소 promise까지 정착 — provider `C-27` 계약).
 */
import { OrchestrationError } from "./orchestrationTypes.js";
import { consumeExactlyOneTerminal } from "./types.js";
/** 리뷰 스트림에서 소비할 이벤트 상한. */
const MAX_REVIEW_EVENTS = 10_000;
/** 리뷰어가 낼 수 있는 판정. §5.2 `review_result`의 `## Verdict: pass | revise | block`과 같은 집합이다. */
export const REVIEW_VERDICTS = ["pass", "revise", "block"];
/** §5.2 `review_result`의 필수 top-level heading. 이 집합은 **closed**다(미상 heading은 거부). */
export const REVIEW_RESULT_HEADINGS = [
    "Reviewed Revision and Hash",
    "Findings (P0/P1/P2)",
    "Reproduction or Evidence",
    "Missing Tests",
    "Contract Deviations",
    "Verdict",
];
/** 리뷰 게이트가 fail closed로 닫힌 이유. 기존 실행 계층 오류 타입을 그대로 쓴다(중복 정의 금지). */
export class ReviewGateError extends OrchestrationError {
    constructor(code, message) {
        super(code, message);
        this.name = "ReviewGateError";
    }
}
/** 리뷰어 프롬프트 조립. §5.2 heading을 **그대로** 요구한다(부분 문자열 관용 없음). */
export function buildReviewPrompt(inp) {
    const c = inp.coder;
    const parts = [];
    parts.push("# 역할\n너는 신선한 컨텍스트의 코드 리뷰어다. 코더와 대화한 적 없다. 아래에 주어진 SPEC·계약·diff만 근거로 판단하라. 파일을 열거나 수정하지 말고, 주어진 텍스트만 본다.");
    const specLines = [`- 역할: ${c.role}`];
    if (c.task)
        specLines.push(`- 작업: ${c.task}`);
    if (c.forbidden?.length)
        specLines.push(`- 금지: ${c.forbidden.join("; ")}`);
    if (c.dod?.length)
        specLines.push(`- 완료 기준(DoD): ${c.dod.join("; ")}`);
    parts.push(`# 코더 SPEC\n${specLines.join("\n")}`);
    parts.push(`# 리뷰 대상\n- revision: ${inp.subject.revision}\n- hash: ${inp.subject.hash}`);
    if (inp.contract)
        parts.push(`# API 계약 (준수 필수)\n${inp.contract.trim()}`);
    parts.push(`# 변경 diff\n\`\`\`diff\n${inp.diff.trim()}\n\`\`\``);
    parts.push([
        "# 판정 규칙",
        "P0/P1만 병합 차단 사유다: 정확성 버그, API 계약 불일치, 보안 안티패턴, DoD 미충족, 담당 경계/금지 위반.",
        "스타일·선호·사소한 개선은 P2다(병합을 막지 않는다).",
        "",
        "# 출력 형식 (아래 heading을 **정확히 이 순서로 각각 한 번만**. 코드 펜스 안에 쓰면 무효다)",
        `## ${REVIEW_RESULT_HEADINGS[0]}`,
        `- revision: ${inp.subject.revision}`,
        `- hash: ${inp.subject.hash}`,
        `## ${REVIEW_RESULT_HEADINGS[1]}`,
        "- P0: (병합을 막아야 하는 치명 결함. 없으면 이 줄을 쓰지 않는다)",
        "- P1: (병합을 막아야 하는 결함)",
        "- P2: (막지 않는 개선)",
        "- 없음  ← P0/P1/P2가 하나도 없을 때만. 다른 항목과 **함께 쓰면 거부된다**",
        `## ${REVIEW_RESULT_HEADINGS[2]}`,
        "- (재현 절차 또는 근거)",
        `## ${REVIEW_RESULT_HEADINGS[3]}`,
        "- (없는 테스트)",
        `## ${REVIEW_RESULT_HEADINGS[4]}`,
        "- (계약 위반)",
        `## ${REVIEW_RESULT_HEADINGS[5]}: pass | revise | block`,
        "(세 값 중 **하나만** 남겨라. P0·P1이 하나도 없으면 pass, 있으면 revise 또는 block이다 —",
        " 둘이 어긋나면 리뷰가 거부된다. 위 heading 외의 `## ` 제목을 추가하면 거부된다.)",
    ].join("\n"));
    return parts.join("\n\n");
}
/**
 * 리뷰어 세션 1회 실행 → findings + 명시 판정.
 * **판정을 돌려주지 못하는 모든 경우는 던진다**(위 ⓐ~ⓗ). 조용한 통과 경로는 없다.
 */
export async function reviewDiff(inp) {
    assertSubject(inp.subject);
    const spec = {
        sessionId: inp.sessionId,
        role: "L3 코드 리뷰어 (신선 컨텍스트, 읽기 전용)",
        model: inp.model ?? "opus", // 리뷰어 Opus 고정 (ARCH §1.1)
        cwd: inp.cwd,
        permissionMode: "plan", // 편집 금지
    };
    let handle;
    try {
        handle = await inp.provider.start(spec, buildReviewPrompt(inp));
    }
    catch (err) {
        throw new ReviewGateError("reviewer_provider_failed", `리뷰어 세션을 시작하지 못했다: ${codeOrName(err)}`);
    }
    let result;
    try {
        // provider 계약: `events(handle)`는 **이 invocation의** bounded 스트림이고 종료 결과는 정확히 1건이다.
        result = await consumeExactlyOneTerminal(inp.provider.events(handle), {
            unbounded: "reviewer_stream_unbounded",
            streamFailed: "reviewer_provider_failed",
            noResult: "reviewer_no_result",
            resultError: "reviewer_result_error",
            duplicate: "reviewer_duplicate_terminal",
        }, MAX_REVIEW_EVENTS, ReviewGateError);
    }
    finally {
        // 판정 여부와 무관하게 세션을 닫는다(실패한 리뷰가 세션을 붙잡은 채 남지 않는다).
        await inp.provider.stop(handle, "review_finished").catch(() => undefined);
    }
    const raw = result.text;
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new ReviewGateError("reviewer_empty_output", "리뷰어 출력이 비어 있다(빈 출력은 통과가 아니다)");
    }
    const parsed = parseReviewResult(raw, inp.subject);
    return { ...parsed, subject: inp.subject, raw, usage: result.usage };
}
function assertSubject(subject) {
    const s = subject;
    if (!s || typeof s.revision !== "string" || s.revision.trim().length === 0 || typeof s.hash !== "string" || s.hash.trim().length === 0) {
        throw new ReviewGateError("reviewer_subject_invalid", "reviewDiff에는 비어 있지 않은 subject.revision·subject.hash가 필요하다");
    }
}
/**
 * **코드 펜스를 걷어낸다.** ` ``` ` 또는 ` ~~~ ` 로 열린 블록의 내용은 heading·verdict 판정에서 제외한다
 * (열린 채 끝나면 그 뒤 전부 제외 — fail closed 방향이다: 헤더가 사라져 `reviewer_malformed_output`이 된다).
 */
function stripFences(raw) {
    const out = [];
    let fence = null;
    for (const line of raw.split("\n")) {
        const open = /^\s{0,3}(```+|~~~+)/.exec(line);
        if (fence === null) {
            if (open) {
                fence = open[1][0].repeat(3);
                continue;
            }
            out.push(line);
            continue;
        }
        if (open && open[1].startsWith(fence))
            fence = null;
    }
    return out;
}
const HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/;
const VERDICT_RE = /^Verdict[ \t]*:[ \t]*(.*)$/i;
const FINDING_RE = /^[-*][ \t]*(P0|P1|P2)\b[ \t]*:?[ \t]*(.*)$/;
const NONE_RE = /^[-*][ \t]*(없음|none)[ \t]*\.?$/i;
/** §5.2 `review_result`의 **closed** 파서. 중복·미상·모순 섹션은 판정을 만들지 않는다. */
function parseReviewResult(raw, subject) {
    const lines = stripFences(raw);
    const sections = new Map();
    const counts = new Map();
    const verdictValues = [];
    let current = null;
    for (const line of lines) {
        const h = HEADING_RE.exec(line);
        if (!h) {
            if (current)
                sections.get(current).push(line);
            continue;
        }
        const title = h[1];
        const v = VERDICT_RE.exec(title);
        const key = v ? "Verdict" : title;
        if (!REVIEW_RESULT_HEADINGS.includes(key)) {
            throw new ReviewGateError("reviewer_malformed_output", `리뷰어 출력에 미상 top-level heading이 있다: ${key}`);
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!sections.has(key))
            sections.set(key, []);
        current = key;
        if (v)
            verdictValues.push(...pickVerdicts(v[1]));
    }
    for (const need of REVIEW_RESULT_HEADINGS) {
        const n = counts.get(need) ?? 0;
        if (n === 0)
            throw new ReviewGateError("reviewer_malformed_output", `리뷰어 출력에 필수 heading이 없다: ## ${need}`);
        if (n > 1)
            throw new ReviewGateError("reviewer_malformed_output", `필수 heading이 ${n}번 나왔다(정확히 1회여야 한다): ## ${need}`);
    }
    // 대상 신원은 **호출자 기대값**에 묶인다(리뷰어의 자기 주장만으로는 통과하지 않는다).
    const subjectText = sections.get("Reviewed Revision and Hash").join("\n");
    if (!subjectText.includes(subject.revision) || !subjectText.includes(subject.hash)) {
        throw new ReviewGateError("reviewer_subject_mismatch", "`## Reviewed Revision and Hash`가 기대한 revision·hash를 담고 있지 않다");
    }
    // findings: `없음`과 P0/P1/P2 항목은 **양립하지 않는다**.
    const findings = [];
    let none = false;
    for (const line of sections.get("Findings (P0/P1/P2)")) {
        const f = FINDING_RE.exec(line.trim());
        if (f) {
            findings.push({ severity: f[1], text: f[2].trim() });
            continue;
        }
        if (NONE_RE.test(line.trim()))
            none = true;
    }
    if (none && findings.length > 0) {
        throw new ReviewGateError("reviewer_malformed_output", "findings 섹션이 `없음`과 P0/P1/P2를 동시에 말한다(모순)");
    }
    if (!none && findings.length === 0) {
        throw new ReviewGateError("reviewer_malformed_output", "findings 섹션이 `없음`도 P0/P1/P2 항목도 말하지 않는다");
    }
    if (verdictValues.length !== 1) {
        throw new ReviewGateError("reviewer_verdict_invalid", `verdict가 정확히 1개여야 한다(발견 ${verdictValues.length}개 — 템플릿 복사·중복·미상 값은 판정이 아니다)`);
    }
    const verdict = verdictValues[0];
    const critical = findings.filter((f) => f.severity !== "P2").map((f) => f.text);
    if ((verdict === "pass") !== (critical.length === 0)) {
        throw new ReviewGateError("reviewer_verdict_invalid", `verdict(${verdict})와 P0/P1 목록(${critical.length}건)이 모순이다 — 어느 쪽도 통과 근거로 쓰지 않는다`);
    }
    return { critical, findings, verdict };
}
/**
 * verdict heading 뒤의 값에서 `pass|revise|block`을 **전부** 뽑는다. 하나가 아니면 위에서 거부되므로
 * 템플릿 그대로(`pass | revise | block`)는 3개로 세어 판정이 되지 않는다.
 */
function pickVerdicts(text) {
    return [...text.toLowerCase().matchAll(/\b(pass|revise|block)\b/g)].map((m) => m[1]);
}
/** 오류 원인을 **코드·이름 수준으로만** 옮긴다(리뷰어 transcript·프롬프트·경로를 싣지 않는다). */
function codeOrName(err) {
    if (err instanceof OrchestrationError)
        return err.code;
    return err instanceof Error ? err.name : "unknown";
}
