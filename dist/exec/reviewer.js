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
 *      1회 · 정확히 그 순서**여야 하고, **미상 heading은 거부**이며, findings 섹션은 `없음` 또는
 *      `P0/P1/P2` 항목 중 **하나만** 말해야 하고(둘 다면 모순 = 거부) **형식을 벗어난 비공백 줄은
 *      무시하지 않고 거부**하며 각 항목 본문은 비어 있지 않고 `MAX_FINDING_CHARS` 이하여야 한다.
 *   ⓖ 대상 신원 불일치 → `reviewer_subject_mismatch`: `## Reviewed Revision and Hash`의 비공백 줄이
 *      **정확히** `- revision: …` 1개와 `- hash: …` 1개여야 하고 두 값이 호출자가 **명시로 준**
 *      `subject.revision`·`subject.hash`와 **완전 일치**여야 한다(라벨 뒤바뀜 · 접두/접미 · 부분 포함 ·
 *      중복 라벨 · 미상 줄은 전부 거부 — 리뷰어의 자기 주장을 신뢰하지 않는다).
 *
 * **모든 경계 밖 오류는 위 코드로 접힌다(2026-07-28 2차 리뷰 A5b).** provider가 `code`를 달고 던지는
 * 것만으로 게이트 결과 코드를 고를 수 없다 — `start`·`events()`·스트림 소비·`stop`의 어떤 예외도
 * 이 목록 밖의 코드가 되지 않는다.
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
        // `events()` 호출 자체가 던져도 provider가 게이트 결과 코드를 고르지 못한다(2차 리뷰 A5b).
        let stream;
        try {
            stream = inp.provider.events(handle);
        }
        catch {
            throw new ReviewGateError("reviewer_provider_failed", "리뷰어 이벤트 스트림을 열지 못했다");
        }
        result = await consumeExactlyOneTerminal(stream, {
            unbounded: "reviewer_stream_unbounded",
            streamFailed: "reviewer_provider_failed",
            noResult: "reviewer_no_result",
            resultError: "reviewer_result_error",
            duplicate: "reviewer_duplicate_terminal",
        }, MAX_REVIEW_EVENTS, ReviewGateError);
    }
    finally {
        // 판정 여부와 무관하게 세션을 닫는다(실패한 리뷰가 세션을 붙잡은 채 남지 않는다).
        // 동기 throw까지 삼킨다 — `finally`에서 새어 나가면 게이트 판정을 덮어쓴다.
        await Promise.resolve()
            .then(() => inp.provider.stop(handle, "review_finished"))
            .catch(() => undefined);
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
 * **코드 펜스를 걷어낸다**(2026-07-28 2차 리뷰 A5a 정정).
 *
 * 이전 판은 여는 펜스의 **길이를 잊고** `fence = char.repeat(3)`으로 정규화한 뒤 `startsWith`로 닫았다.
 * 그래서 ` ````` ` 로 연 블록을 그 **안에 있는 ` ``` ` 줄**이 닫아 버렸고, 이어지는 블록 내용이 본문으로
 * 새어 나와 가짜 `## Verdict: pass`를 심을 수 있었다. CommonMark대로 ⓐ **문자와 여는 길이를 기억**하고
 * ⓑ **같은 문자 · 여는 길이 이상 · 뒤에 공백만** 있는 줄로만 닫는다. ` ``` `와 ` ~~~ `를 동등하게 다룬다.
 * (열린 채 끝나면 그 뒤 전부 제외 — fail closed 방향이다: 헤더가 사라져 `reviewer_malformed_output`이 된다.)
 */
function stripFences(raw) {
    const out = [];
    let fence = null;
    for (const line of raw.split("\n")) {
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence === null) {
            if (m) {
                fence = { char: m[1][0], len: m[1].length };
                continue;
            }
            out.push(line);
            continue;
        }
        // 닫는 펜스: 같은 문자 · 여는 길이 이상 · 뒤에는 공백만(정보 문자열이 붙으면 닫는 펜스가 아니다).
        if (m && m[1][0] === fence.char && m[1].length >= fence.len && m[2].trim() === "")
            fence = null;
    }
    return out;
}
const HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/;
const VERDICT_RE = /^Verdict[ \t]*:[ \t]*(.*)$/i;
const FINDING_RE = /^[-*][ \t]+(P0|P1|P2)[ \t]*:?[ \t]*(.*)$/;
const NONE_RE = /^[-*][ \t]+(없음|none)[ \t]*\.?$/i;
/** `- revision: <값>` / `- hash: <값>` — **한 줄 · 정확한 라벨 · 값 하나**. */
const SUBJECT_LABEL_RE = /^[-*][ \t]+(revision|hash)[ \t]*:[ \t]*(\S.*?)[ \t]*$/;
/** finding 한 줄의 상한(문자). 리뷰어 본문이 무한정 길어져도 판정 경로는 bounded다. */
export const MAX_FINDING_CHARS = 1_000;
/** §5.2 `review_result`의 **closed** 파서. 중복·미상·모순·순서 위반 섹션은 판정을 만들지 않는다. */
function parseReviewResult(raw, subject) {
    const lines = stripFences(raw);
    const sections = new Map();
    const counts = new Map();
    const order = [];
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
        order.push(key);
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
    // **순서까지 계약이다**(A5a): 프롬프트가 "정확히 이 순서로"를 요구하므로 재배열은 형식 위반이다.
    if (order.join("\n") !== REVIEW_RESULT_HEADINGS.join("\n")) {
        throw new ReviewGateError("reviewer_malformed_output", "필수 heading의 순서가 §5.2 계약과 다르다");
    }
    assertSubjectSection(sections.get("Reviewed Revision and Hash"), subject);
    // findings: `없음`과 P0/P1/P2 항목은 **양립하지 않는다**. 그리고 **미상 비공백 줄은 전부 거부**다
    // (이전 판은 조용히 무시했으므로 `- 없음` + 불릿 없는 `P1: 승인 우회`가 통과했다 — A5a).
    const findings = [];
    let none = false;
    for (const line of sections.get("Findings (P0/P1/P2)")) {
        const t = line.trim();
        if (t.length === 0)
            continue;
        const f = FINDING_RE.exec(t);
        if (f) {
            const text = f[2].trim();
            if (text.length === 0) {
                throw new ReviewGateError("reviewer_malformed_output", `findings 항목 ${f[1]}의 본문이 비었다`);
            }
            if (text.length > MAX_FINDING_CHARS) {
                throw new ReviewGateError("reviewer_malformed_output", `findings 항목이 ${MAX_FINDING_CHARS}자 상한을 넘었다`);
            }
            findings.push({ severity: f[1], text });
            continue;
        }
        if (NONE_RE.test(t)) {
            none = true;
            continue;
        }
        throw new ReviewGateError("reviewer_malformed_output", "findings 섹션에 형식을 벗어난 줄이 있다(미상 줄은 무시하지 않는다)");
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
 * **대상 신원 섹션은 정확히 두 줄이다**(2026-07-28 2차 리뷰 A5a 정정).
 *
 * 이전 판은 섹션 전체를 한 문자열로 이어 붙여 `includes(revision) && includes(hash)`로 봤다. 그래서
 * ⓐ 라벨이 뒤바뀌어도(`- revision: <hash>` · `- hash: <revision>`) ⓑ 값에 접두·접미가 붙어도
 * (`- hash: <hash>-dirty`) ⓒ 다른 revision을 리뷰하고 기대값을 **아무 줄에나 한 번 언급**하기만 해도
 * 통과했다. 지금은 비공백 줄이 **정확히** `- revision: …` 1개와 `- hash: …` 1개여야 하고, 값은
 * 기대값과 **문자열 완전 일치**여야 하며, 그 외 비공백 줄이 하나라도 있으면 거부다.
 */
function assertSubjectSection(lines, subject) {
    const seen = new Map();
    for (const line of lines) {
        const t = line.trim();
        if (t.length === 0)
            continue;
        const m = SUBJECT_LABEL_RE.exec(t);
        if (!m) {
            throw new ReviewGateError("reviewer_subject_mismatch", "`## Reviewed Revision and Hash`에 형식을 벗어난 줄이 있다");
        }
        if (seen.has(m[1])) {
            throw new ReviewGateError("reviewer_subject_mismatch", `대상 라벨 ${m[1]}이 두 번 나왔다(각각 정확히 1회여야 한다)`);
        }
        seen.set(m[1], m[2]);
    }
    if (seen.size !== 2 || seen.get("revision") !== subject.revision || seen.get("hash") !== subject.hash) {
        throw new ReviewGateError("reviewer_subject_mismatch", "`## Reviewed Revision and Hash`가 기대한 revision·hash와 정확히 일치하지 않는다");
    }
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
