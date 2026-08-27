/**
 * agent 결과의 필수 섹션 헤더 검증 (spec 4.4, AGENT_OUTPUT_SCHEMA §6).
 *
 * 이 함수는 판정만 낸다(누락 헤더 목록). **집행은 호출자**다 — [C-127] 이후 `runWorkflow`의
 * `persistFinalOutcome`이 재생성 상한 후에도 `ok:false`인 산출물의 **채택을 거부한다**
 * (`failed_reason: "required_sections_missing"`). 파일은 검토용으로 남지만 completed로 세지 않는다.
 * (2026-08-27 이전 주석은 "v1은 경고 수준: 저장은 계속한다"였다 — 가드가 선 뒤로 거짓이다.)
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
 * markdown에서 첫 ```json 코드펜스 내용을 추출한다(design 에이전트의 tokens.json 분리용).
 * JSON으로 파싱되면 예쁘게 정렬해 반환, 파싱 실패면 원문, 블록 없으면 null.
 */
export function extractTokensJson(markdown: string): string | null {
  const m = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  const raw = m[1].trim();
  try {
    return JSON.stringify(JSON.parse(raw), null, 2) + "\n";
  } catch {
    return raw + "\n"; // 파싱 실패해도 원문은 남긴다(토큰 린트가 잡음)
  }
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
 * @deprecated [B-40] **게이트 판정에 쓰지 마라.** 산문 부분문자열 매칭이라 표현이 목록에 없으면
 * 조용히 null이 되고(= 호출자가 진행), 그 fail open이 kill 게이트를 무력화했다. 게이트는
 * `extractCeoDecision`(구조화 `## Decision` 절)을 쓴다.
 *
 * **정정**: B-40 첫 커밋 메시지에 "다른 호출부가 있어 보존"이라고 적었는데 **사실이 아니다** —
 * `src/` 안 호출부는 **0건**이다(테스트에도 없다). 실제 보존 이유는 ⓐ 이 함수가 published 패키지의
 * export 표면이고(`package.json.files`에 `dist` 포함) ⓑ `docs/DECISIONS.md`·`docs/WORKLOG.md`의
 * 과거 기록이 이 동작을 설명한다 — 이므로 지우는 대신 deprecated로 못 박았다. 확인 없이 계약을
 * 적은 사례로 남긴다(CLAUDE.md의 같은 교훈).
 *
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
 * [B-40] CEO 정본 판정 토큰 — **이 파서의 allowlist**다.
 *
 * 어휘가 여기 하나에만 있다고 말할 수는 없다(정정): 같은 낱말이 `agents/founder_ceo_agent.md`의
 * 출력 계약과 `registry/workflows.json`의 gate `on`/`kill` 키에 **수기로 중복**된다 — 프롬프트도
 * JSON도 TypeScript 상수를 import할 수 없다. 그래서 이 상수는 "단일 출처"가 아니라
 * **파서 allowlist + registry 회귀 대조의 기준**이고, workflows.json의 키가 이 목록에서 벗어나면
 * 로더 테스트가 red가 된다(프롬프트 쪽 어긋남은 코드로 못 잡는다 — 그것이 남는 위험이다).
 * 등급 순서는 CEO 프롬프트 §8의 A~E와 같다.
 */
export const CEO_DECISION_TOKENS = ["진행", "축소", "검증", "보류", "폐기"] as const;
export type CeoDecisionToken = (typeof CEO_DECISION_TOKENS)[number];

/**
 * 코드펜스(``` / ~~~) 안에 있는 줄에 false를 채운 마스크. 여는 펜스 문자와 무관하게 다음 펜스 줄에서
 * 닫는 **단순 토글**이다.
 *
 * ponytail: 단순 토글 — 여는 펜스보다 긴 닫는 펜스, 서로 다른 펜스 문자의 중첩, 리스트 안 들여쓴
 * 4-space 코드블록은 구분하지 않는다. CommonMark 완전 구현이 필요해지면(예: 산출물이 중첩 펜스를
 * 실제로 쓰기 시작하면) 그때 파서를 올린다. 지금 막는 것은 "펜스 안의 가짜 판정 절"이고, 토글이
 * 틀리는 방향은 펜스 밖을 펜스 안으로 오인하는 쪽 — 즉 절을 못 찾아 absent/ambiguous(fail closed)다.
 */
function fenceMask(lines: string[]): boolean[] {
  let inFence = false;
  return lines.map((l) => {
    if (/^\s{0,3}(```|~~~)/.test(l)) {
      inFence = !inFence;
      return false; // 펜스 줄 자체도 본문이 아니다
    }
    return !inFence;
  });
}

/**
 * [B-40] "## Decision" 절에서 **정본 판정 토큰 하나**를 뽑는다. 산문 판정(Main Judgment)은 읽지 않는다.
 *
 * 왜 산문 부분문자열 매칭(`extractDecision`)을 게이트에서 쓰지 않는가: 오탐("폐기하지 않는다" → kill)은
 * fail closed라 참을 수 있지만 **누락은 fail open**이다 — "중단한다"·"드롭한다"·"더 이상 시간을 쓰지 않는다"
 * (CEO 프롬프트 §8-E의 실제 표현)는 폐기인데 어떤 키워드 목록에도 걸리지 않아 그대로 진행한다.
 * 동의어를 열거해서는 닫히지 않는다(자연어는 무한하다). 그래서 판정을 **구조로** 받는다.
 *
 * 구조를 받는다면 **고를 수 없어야** 한다. 절이 여러 개면 첫 절이 이기고, 본문을 부분문자열로 보면
 * 펜스 안의 예시나 "진행성" 같은 낱말이 판정이 된다 — 판정을 심을 자리가 남는 것이다. 그래서:
 *
 * - 코드펜스 안의 헤더·본문은 전부 무시한다 (예시 블록이 판정을 만들지 못한다).
 * - 펜스 밖 `## Decision` 절이 **정확히 1개**여야 한다 (0 → absent, 2+ → ambiguous).
 * - 그 절 본문의 **비공백 줄이 정확히 1줄**이고, bullet 마커를 떼면 그 줄이 토큰과 **완전 일치**해야
 *   한다 (부분문자열 아님 → "진행성"·"축소 후 진행" 모두 ambiguous).
 *
 * 어긋남은 전부 error다 — 호출자가 조용히 진행하지 않고 멈추는 것이 이 함수의 존재 이유다.
 */
export function extractCeoDecision(markdown: string): { token: CeoDecisionToken } | { error: "absent" | "ambiguous" } {
  const lines = markdown.split("\n");
  const live = fenceMask(lines);
  // top-level 헤더만 본다: 인용(`> ## Decision`)이나 들여쓴 헤더는 `^##`에 걸리지 않는다.
  const heads = lines.map((l, i) => (live[i] && /^##\s+Decision\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (heads.length === 0) return { error: "absent" };
  if (heads.length > 1) return { error: "ambiguous" }; // 판정 절이 둘이면 어느 것도 정본이 아니다

  const body: string[] = [];
  for (let i = heads[0] + 1; i < lines.length; i++) {
    if (live[i] && /^##\s/.test(lines[i])) break; // 다음 top-level 섹션
    if (live[i] && lines[i].trim().length > 0) body.push(lines[i].trim());
  }
  if (body.length !== 1) return { error: "ambiguous" };
  const value = body[0].replace(/^([-*+]|\d+\.)\s+/, "").trim();
  const token = CEO_DECISION_TOKENS.find((t) => t === value);
  return token ? { token } : { error: "ambiguous" };
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
