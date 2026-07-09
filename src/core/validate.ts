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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 필수 헤더 누락 여부를 검사한다. 비어있는 결과도 실패로 본다.
 * @param extraHeaders 에이전트별 추가 필수 헤더(정확한 "## <이름>" 매칭). 공용 4개에 더해 검사.
 *   (agent_registry.json의 required_headers — PM=PRD, tech_lead=Tech Spec, design=DESIGN.md 헤더)
 */
export function validateAgentOutput(markdown: string, extraHeaders: string[] = []): ValidationResult {
  const missing: string[] = [];
  if (markdown.trim().length === 0) {
    return { ok: false, missing: [...REQUIRED.map((r) => r.label), ...extraHeaders] };
  }
  for (const r of REQUIRED) {
    if (!r.pattern.test(markdown)) missing.push(r.label);
  }
  for (const h of extraHeaders) {
    const pattern = new RegExp(`^##\\s+${escapeRegex(h)}\\s*$`, "m");
    if (!pattern.test(markdown)) missing.push(h);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Risks 아래 "### Critical" 소섹션의 실제 리스크 bullet을 추출한다.
 * "(없음)"/"(none)"/"-" 같은 플레이스홀더는 제외. 다음 소섹션/섹션에서 멈춘다.
 * (Red Team 비평 루프 종료 조건 판정에 사용)
 */
export function extractCriticalRisks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const idx = lines.findIndex((l) => /^###\s+Critical\s*$/.test(l));
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^#{2,4}\s/.test(line)) break; // 다음 소섹션(### High 등) 또는 섹션(## )
    const m = line.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (text && !/^\(?\s*(없음|none|n\/a|-)\s*\)?$/i.test(text)) out.push(text);
  }
  return out;
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

export interface SpawnSpec {
  id: string;
  name: string;
  focus: string;
}

/**
 * planner 출력에서 하위 에이전트 선언을 파싱한다 (동적 분화용).
 * 형식: `SPAWN id=<id> | name=<name> | focus=<한 줄>` (문서 어디에 있어도 됨).
 * "SPAWN none"이거나 없으면 빈 배열. id는 [a-z0-9_-]로 정규화, 중복 제거.
 */
export function extractSpawnDeclarations(markdown: string): SpawnSpec[] {
  const out: SpawnSpec[] = [];
  const seen = new Set<string>();
  for (const raw of markdown.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, ""); // 앞 bullet 허용
    const m = line.match(/^SPAWN\s+id=([^|]+)\|\s*name=([^|]+)\|\s*focus=(.+)$/i);
    if (!m) continue;
    const id = m[1].trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    const name = m[2].trim();
    const focus = m[3].trim();
    if (!id || !name || !focus || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, focus });
  }
  return out;
}

/** 지정 "## 헤더" 섹션의 본문 텍스트를 반환한다 (다음 "## " 전까지). 없으면 빈 문자열. */
function sectionText(markdown: string, headerPattern: RegExp): string {
  const lines = markdown.split("\n");
  const idx = lines.findIndex((l) => headerPattern.test(l));
  if (idx === -1) return "";
  const buf: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    buf.push(lines[i]);
  }
  return buf.join("\n");
}

/**
 * decider 출력에서 판정 키워드를 찾는다 (CEO 게이트 분기용).
 * 판정이 실제로 담기는 Main Judgment + Decisions 섹션만 검색한다.
 * (문서 전체 검색은 Input Summary의 역할 설명 등 boilerplate를 오탐하므로 쓰지 않는다.)
 */
export function extractDecision(markdown: string, keywords: string[]): string | null {
  const haystack =
    sectionText(markdown, /^##\s+Main Judgment\s*$/) + "\n" + sectionText(markdown, /^##\s+Decisions\s*$/);
  for (const kw of keywords) if (haystack.includes(kw)) return kw;
  return null;
}

/**
 * "## Main Judgment" 섹션의 첫 내용 줄을 handoff 요약으로 추출한다.
 * bullet(mock)이든 문단(실제 LLM)이든 첫 비어있지 않은 줄을 반환한다.
 */
export function extractMainJudgment(markdown: string): string {
  const lines = markdown.split("\n");
  const idx = lines.findIndex((l) => /^##\s+Main Judgment\s*$/.test(l));
  if (idx === -1) return "(Main Judgment 없음)";
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break; // 다음 섹션
    if (line.length === 0) continue; // 빈 줄 건너뜀
    return line.replace(/^([-*]|\d+\.)\s+/, "").trim(); // bullet 마커 있으면 제거
  }
  return "(Main Judgment 내용 없음)";
}
