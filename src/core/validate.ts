/**
 * agent 결과의 필수 섹션 헤더 검증 (spec 4.4, AGENT_OUTPUT_SCHEMA §6).
 * v1은 경고 수준: 누락 헤더 목록을 반환하고 저장은 계속한다.
 */

export interface RequiredHeaderCheck {
  label: string;
  pattern: RegExp;
}

// 필수 4개: Metadata / Main Judgment / Risks / Next Actions(= Recommended Next Actions)
const REQUIRED: RequiredHeaderCheck[] = [
  { label: "Metadata", pattern: /^##\s+Metadata\s*$/m },
  { label: "Main Judgment", pattern: /^##\s+Main Judgment\s*$/m },
  { label: "Risks", pattern: /^##\s+Risks\s*$/m },
  { label: "Next Actions", pattern: /^##\s+.*Next Actions\s*$/m },
];

export interface ValidationResult {
  ok: boolean;
  missing: string[];
}

/** 필수 헤더 누락 여부를 검사한다. 비어있는 결과도 실패로 본다. */
export function validateAgentOutput(markdown: string): ValidationResult {
  const missing: string[] = [];
  if (markdown.trim().length === 0) {
    return { ok: false, missing: REQUIRED.map((r) => r.label) };
  }
  for (const r of REQUIRED) {
    if (!r.pattern.test(markdown)) missing.push(r.label);
  }
  return { ok: missing.length === 0, missing };
}

/** 지정한 "## 헤더" 섹션의 bullet 목록을 추출한다. 없으면 빈 배열. */
export function extractSectionBullets(markdown: string, headerPattern: RegExp): string[] {
  const lines = markdown.split("\n");
  const idx = lines.findIndex((l) => headerPattern.test(l));
  if (idx === -1) return [];
  const bullets: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ") || line.startsWith("* ") || /^\d+\.\s/.test(line)) {
      bullets.push(line.replace(/^([-*]|\d+\.)\s+/, "").trim());
    }
  }
  return bullets.filter((b) => b.length > 0);
}

/** "## Main Judgment" 섹션의 첫 bullet을 handoff 요약으로 추출한다. */
export function extractMainJudgment(markdown: string): string {
  const lines = markdown.split("\n");
  const idx = lines.findIndex((l) => /^##\s+Main Judgment\s*$/.test(l));
  if (idx === -1) return "(Main Judgment 없음)";
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break; // 다음 섹션
    if (line.startsWith("- ") || line.startsWith("* ")) {
      return line.replace(/^[-*]\s+/, "").trim();
    }
  }
  return "(Main Judgment 내용 없음)";
}
