/**
 * 착수 프롬프트 컴파일러 (ARCH §3.1.1, DESIGN_QUESTIONS Q2 = 하이브리드).
 * SessionSpec → start(spec, initialPrompt)의 initialPrompt 문자열.
 *
 * 하이브리드 규칙:
 *  - 태스크/역할/ownership/forbidden/dod, STATUS 계약 = 인라인 (짧고 오독 불가)
 *  - API_CONTRACT 전문 = 인라인 (계약 오독이 최대 실패원)
 *  - 나머지 배경 문서(PRD/UX 등) = 경로 목록 + "필요 시 Read" (토큰 절약, 세션이 선별)
 *
 * 파일 읽기는 주입 가능(deps.readFile) — 단위 테스트는 fs 없이 검증.
 */
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";
const STATUS_CONTRACT = [
    "매 turn 종료 시 작업 루트의 STATUS.md를 아래 한 줄 상태로 갱신하라:",
    "  STATUS: RUNNING | BLOCKED | QUESTION | SPLIT | DONE",
    "- BLOCKED/QUESTION이면 사유를 다음 줄에 한 줄로. 다른 세션·사람과 직접 대화하지 말고 STATUS로만 신호하라.",
    "- 완료(DoD 충족 + 테스트 통과)면 DONE.",
].join("\n");
function defaultRead(abs) {
    try {
        return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    }
    catch {
        return null;
    }
}
function isContract(path, spec) {
    if (spec.contractPaths?.length)
        return spec.contractPaths.includes(path);
    return /API_CONTRACT/i.test(basename(path));
}
/** SessionSpec → 착수 프롬프트. */
export function compilePrompt(spec, deps) {
    const read = deps.readFile ?? defaultRead;
    const resolve = (p) => (isAbsolute(p) ? p : join(deps.projectRoot, p));
    const inputs = spec.inputs ?? [];
    const contracts = inputs.filter((p) => isContract(p, spec));
    const background = inputs.filter((p) => !isContract(p, spec));
    const parts = [];
    // ① 태스크
    parts.push(`# 태스크\n${spec.task ?? spec.role}`);
    // ② SPEC 요약
    const specLines = [`- 역할: ${spec.role}`];
    if (spec.ownership?.length)
        specLines.push(`- 담당 경로(ownership, 이 밖은 수정 금지): ${spec.ownership.join(", ")}`);
    if (spec.forbidden?.length)
        specLines.push(`- 금지: ${spec.forbidden.join("; ")}`);
    parts.push(`# 담당 범위\n${specLines.join("\n")}`);
    // ③ API_CONTRACT 전문 인라인
    for (const c of contracts) {
        const content = read(resolve(c));
        if (content !== null)
            parts.push(`# API 계약 (반드시 준수 — 전문)\n<<< ${c} >>>\n${content.trim()}\n<<< 끝 >>>`);
        else
            parts.push(`# API 계약\n(경로 ${c} 를 찾지 못함 — 있으면 먼저 Read하라)`);
    }
    // ④ 배경 문서 = 경로 + Read 지시
    if (background.length) {
        parts.push(`# 배경 문서 (전부 읽지 말고 필요한 부분만 Read로 열어 참고)\n` +
            background.map((p) => `- ${p}`).join("\n"));
    }
    // ⑤ STATUS 계약
    parts.push(`# 상태 보고 계약\n${STATUS_CONTRACT}`);
    // ⑥ DoD + 금지 재확인
    if (spec.dod?.length) {
        parts.push(`# 완료 기준 (DoD — 전부 충족해야 함)\n${spec.dod.map((d) => `- ${d}`).join("\n")}`);
    }
    parts.push(`# 작업 규칙\n- 담당 경로 밖은 건드리지 마라.\n- 한 번에 한 가지씩, 테스트를 함께 작성하라.\n- 새 의존성 설치·계약 변경이 필요하면 STATUS를 BLOCKED로 두고 사유를 남겨라(임의 진행 금지).`);
    return parts.join("\n\n");
}
