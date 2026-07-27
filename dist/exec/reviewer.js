/**
 * L3 리뷰어 세션 (ARCH §4.1). 코더와 대화 이력을 공유하지 않는 **신선 컨텍스트** 세션이
 * diff + SPEC + API_CONTRACT만 보고 Critical 결함을 낸다. critique_loop의 실행 계층 이식.
 *
 * - 리뷰어는 항상 Opus 고정, 읽기 전용(permission plan, 도구 불필요 — 판단 자료는 프롬프트 인라인).
 * - --fork-session 금지: fork는 코더 컨텍스트 복제라 신선 컨텍스트 원칙과 정반대(ARCH §4.1). 매번 새 세션.
 * - 출력 스키마는 사고 계층 red_team과 동일(### Critical) → extractCriticalRisks 재사용.
 *
 * **리뷰 게이트는 fail closed다(V3 M5b · 유예 대장 `B-8`).** 이전 판은 `result.isError`를 보지 않았고,
 * 비어 있거나 구조화되지 않은 출력도 `extractCriticalRisks`가 **Critical 0건**으로 읽어 그대로 "통과"가
 * 됐다 — 즉 리뷰어 세션이 실패하거나 아무 말도 못 하면 게이트가 조용히 열렸다. 현행: 아래 중 하나라도
 * 걸리면 **판정을 만들지 않고 던진다**(`ReviewGateError`, 안정 코드 1개씩).
 *   ⓐ provider가 던짐 · 스트림 소비 중 오류 → `reviewer_provider_failed`
 *   ⓑ 종료(result) 이벤트 없음 → `reviewer_no_result`
 *   ⓒ `result.isError` → `reviewer_result_error`
 *   ⓓ 본문이 비었거나 공백뿐 → `reviewer_empty_output`
 *   ⓔ 필수 헤더(`## Risks` · `### Critical`) 부재 → `reviewer_malformed_output`
 *   ⓕ `## Verdict:` 부재·미상 값, 또는 verdict와 Critical 목록이 **서로 모순**(pass인데 Critical이 있고,
 *      revise/block인데 Critical이 없다) → `reviewer_verdict_invalid`
 * 판정을 만들지 못하면 **호출자는 "Critical 0건 = 통과"를 얻지 못한다** — 그것이 이 게이트의 요점이다.
 * 세션은 성공·실패 어느 경로에서도 `stop()`으로 닫는다(취소 promise까지 정착 — provider `C-27` 계약).
 */
import { extractCriticalRisks } from "../core/validate.js";
import { OrchestrationError } from "./orchestrationTypes.js";
/** 리뷰어가 낼 수 있는 판정. §5.2 `review_result`의 `## Verdict: pass | revise | block`과 같은 집합이다. */
export const REVIEW_VERDICTS = ["pass", "revise", "block"];
/** 리뷰 게이트가 fail closed로 닫힌 이유. 기존 실행 계층 오류 타입을 그대로 쓴다(중복 정의 금지). */
export class ReviewGateError extends OrchestrationError {
    constructor(code, message) {
        super(code, message);
        this.name = "ReviewGateError";
    }
}
const RISKS_HEADER = "## Risks";
const CRITICAL_HEADER = "### Critical";
const VERDICT_RE = /^##[ \t]+Verdict:[ \t]*(pass|revise|block)[ \t]*$/im;
/** 리뷰어 프롬프트 조립. */
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
    if (inp.contract)
        parts.push(`# API 계약 (준수 필수)\n${inp.contract.trim()}`);
    parts.push(`# 변경 diff\n\`\`\`diff\n${inp.diff.trim()}\n\`\`\``);
    parts.push([
        "# 판정 규칙",
        "다음만 Critical로 본다(병합 차단 사유): 정확성 버그, API 계약 불일치, 보안 안티패턴, DoD 미충족, 담당 경계/금지 위반.",
        "스타일·선호·사소한 개선은 Critical이 아니다.",
        "",
        "# 출력 형식 (정확히 이 헤더 — 하나라도 빠지면 리뷰가 거부된다)",
        RISKS_HEADER,
        CRITICAL_HEADER,
        "- (병합을 막아야 하는 결함을 한 줄씩. 없으면 '없음')",
        "### Notes",
        "- (참고 관찰 — 병합 막지 않음)",
        "## Verdict: pass | revise | block",
        "(위 세 값 중 **하나만** 남겨라. Critical이 하나도 없으면 pass, 있으면 revise 또는 block이다 —",
        " 둘이 어긋나면 리뷰가 거부된다.)",
    ].join("\n"));
    return parts.join("\n\n");
}
/**
 * 리뷰어 세션 1회 실행 → Critical 목록 + 명시 판정.
 * **판정을 돌려주지 못하는 모든 경우는 던진다**(위 ⓐ~ⓕ). 조용한 통과 경로는 없다.
 */
export async function reviewDiff(inp) {
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
    let result = null;
    try {
        // provider 계약: `events(handle)`는 **이 invocation의** bounded 스트림이고 result에서 닫힌다.
        for await (const e of inp.provider.events(handle)) {
            if (e.kind === "result")
                result = e;
        }
    }
    catch (err) {
        throw new ReviewGateError("reviewer_provider_failed", `리뷰 스트림 소비가 실패했다: ${codeOrName(err)}`);
    }
    finally {
        // 판정 여부와 무관하게 세션을 닫는다(실패한 리뷰가 세션을 붙잡은 채 남지 않는다).
        await inp.provider.stop(handle, "review_finished").catch(() => undefined);
    }
    if (!result)
        throw new ReviewGateError("reviewer_no_result", "리뷰어 스트림에 종료 결과가 없다");
    if (result.isError) {
        throw new ReviewGateError("reviewer_result_error", `리뷰어 세션이 실패로 끝났다(${result.terminalReason ?? "unknown"})`);
    }
    const raw = result.text;
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new ReviewGateError("reviewer_empty_output", "리뷰어 출력이 비어 있다(빈 출력은 통과가 아니다)");
    }
    if (!raw.includes(RISKS_HEADER) || !raw.includes(CRITICAL_HEADER)) {
        throw new ReviewGateError("reviewer_malformed_output", `리뷰어 출력에 필수 헤더(${RISKS_HEADER} · ${CRITICAL_HEADER})가 없다`);
    }
    const m = VERDICT_RE.exec(raw);
    if (!m)
        throw new ReviewGateError("reviewer_verdict_invalid", "리뷰어 출력에 `## Verdict: pass|revise|block`이 없다");
    const verdict = m[1].toLowerCase();
    const critical = extractCriticalRisks(raw);
    if ((verdict === "pass") !== (critical.length === 0)) {
        throw new ReviewGateError("reviewer_verdict_invalid", `verdict(${verdict})와 Critical 목록(${critical.length}건)이 모순이다 — 어느 쪽도 통과 근거로 쓰지 않는다`);
    }
    return { critical, verdict, raw, usage: result.usage };
}
/** 오류 원인을 **코드·이름 수준으로만** 옮긴다(리뷰어 transcript·프롬프트·경로를 싣지 않는다). */
function codeOrName(err) {
    if (err instanceof OrchestrationError)
        return err.code;
    return err instanceof Error ? err.name : "unknown";
}
