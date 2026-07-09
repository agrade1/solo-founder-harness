/**
 * L3 리뷰어 세션 (ARCH §4.1). 코더와 대화 이력을 공유하지 않는 **신선 컨텍스트** 세션이
 * diff + SPEC + API_CONTRACT만 보고 Critical 결함을 낸다. critique_loop의 실행 계층 이식.
 *
 * - 리뷰어는 항상 Opus 고정, 읽기 전용(permission plan, 도구 불필요 — 판단 자료는 프롬프트 인라인).
 * - --fork-session 금지: fork는 코더 컨텍스트 복제라 신선 컨텍스트 원칙과 정반대(ARCH §4.1). 매번 새 세션.
 * - 출력 스키마는 사고 계층 red_team과 동일(### Critical) → extractCriticalRisks 재사용.
 */
import { extractCriticalRisks } from "../core/validate.js";
import type { ExecutionProvider, SessionSpec, SessionUsage } from "./types.js";

export interface ReviewInput {
  provider: ExecutionProvider;
  sessionId: string; // 리뷰어 세션 id (라운드마다 새로)
  cwd: string; // 임시 실행 위치(파일 안 만짐)
  model?: string; // 기본 opus 고정
  coder: { role: string; task?: string; dod?: string[]; forbidden?: string[] };
  contract?: string; // API_CONTRACT 전문 (있으면)
  diff: string; // 심사 대상 diff raw
}

export interface ReviewVerdict {
  critical: string[]; // 비어있으면 L3 통과
  raw: string; // 리뷰어 원문
  usage: SessionUsage | null;
}

/** 리뷰어 프롬프트 조립. */
export function buildReviewPrompt(inp: ReviewInput): string {
  const c = inp.coder;
  const parts: string[] = [];
  parts.push(
    "# 역할\n너는 신선한 컨텍스트의 코드 리뷰어다. 코더와 대화한 적 없다. 아래에 주어진 SPEC·계약·diff만 근거로 판단하라. 파일을 열거나 수정하지 말고, 주어진 텍스트만 본다.",
  );
  const specLines = [`- 역할: ${c.role}`];
  if (c.task) specLines.push(`- 작업: ${c.task}`);
  if (c.forbidden?.length) specLines.push(`- 금지: ${c.forbidden.join("; ")}`);
  if (c.dod?.length) specLines.push(`- 완료 기준(DoD): ${c.dod.join("; ")}`);
  parts.push(`# 코더 SPEC\n${specLines.join("\n")}`);
  if (inp.contract) parts.push(`# API 계약 (준수 필수)\n${inp.contract.trim()}`);
  parts.push(`# 변경 diff\n\`\`\`diff\n${inp.diff.trim()}\n\`\`\``);
  parts.push(
    [
      "# 판정 규칙",
      "다음만 Critical로 본다(병합 차단 사유): 정확성 버그, API 계약 불일치, 보안 안티패턴, DoD 미충족, 담당 경계/금지 위반.",
      "스타일·선호·사소한 개선은 Critical이 아니다.",
      "",
      "# 출력 형식 (정확히 이 헤더)",
      "## Risks",
      "### Critical",
      "- (병합을 막아야 하는 결함을 한 줄씩. 없으면 '없음')",
      "### Notes",
      "- (참고 관찰 — 병합 막지 않음)",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

/** 리뷰어 세션 1회 실행 → Critical 목록. */
export async function reviewDiff(inp: ReviewInput): Promise<ReviewVerdict> {
  const spec: SessionSpec = {
    sessionId: inp.sessionId,
    role: "L3 코드 리뷰어 (신선 컨텍스트, 읽기 전용)",
    model: inp.model ?? "opus", // 리뷰어 Opus 고정 (ARCH §1.1)
    cwd: inp.cwd,
    permissionMode: "plan", // 편집 금지
  };
  const handle = await inp.provider.start(spec, buildReviewPrompt(inp));
  let raw = "";
  let usage: SessionUsage | null = null;
  for await (const e of inp.provider.events(handle)) {
    if (e.kind === "result") {
      raw = e.text;
      usage = e.usage;
    }
  }
  return { critical: extractCriticalRisks(raw), raw, usage };
}
