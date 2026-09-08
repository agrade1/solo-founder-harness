/**
 * [C-164] **사람이 읽는 확인 요청서.**
 *
 * 문제: 체크포인트 하나에서 사람이 읽어야 할 원문이 **66KB(한글 약 2만 자)** 다(실측:
 * `01_RESEARCH` 18.7KB + `02_PRD` 19.3KB + `05_RED_TEAM` 13.1KB + `06_CEO_DECISION` 14.0KB).
 * 그것이 4번 반복된다. 승인 게이트가 이 하네스의 존재 이유인데 **읽을 수 없는 승인은 승인이 아니다.**
 *
 * 새로 만드는 것은 **조립과 서식뿐**이다 — 재료는 전부 이미 있다:
 *   · `seeds` = 문서별 `## Main Judgment` 한 줄 (checkpoint manifest가 이미 뽑는다)
 *   · `## Decision` 토큰 (게이트가 읽는 그 자리)
 *   · `### Critical` (비평 루프 종료 조건이 읽는 그 자리)
 * **새 추출 규칙을 만들지 않는다** — 만들면 "보고서가 말하는 것"과 "게이트가 판정하는 것"이 갈린다.
 *
 * 이 문서는 **증거가 아니라 뷰**다. 그래서 checkpoint manifest에 결박하지 않는다(결박하면 이 파일을
 * 만드는 행위 자체가 drift가 된다). 대신 머리에 checkpoint id를 적어 **낡은 보고서를 알아볼 수 있게** 한다.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CEO_DECISION_TOKENS, extractCriticalRisks, extractSectionBullets } from "./validate.js";

/** 보고서 파일의 프로젝트 상대경로. */
export const CHECKPOINT_REPORT_REL = "outputs/CHECKPOINT_REPORT.md";

export interface CheckpointReportInput {
  project: string;
  stage: string;
  stageNo: number;
  stageTotal: number;
  checkpointId: string;
  at: string;
  artifacts: readonly { path: string; size: number }[];
  seeds: readonly { agent_id: string; line: string }[];
}

/** `## Decision`의 판정 토큰 하나. 없거나 알 수 없으면 null. */
function decisionToken(root: string, artifacts: readonly { path: string }[]): string | null {
  const doc = artifacts.find((a) => a.path.endsWith("06_CEO_DECISION.md"));
  if (!doc) return null;
  const abs = join(root, doc.path);
  if (!existsSync(abs)) return null;
  const bullets = extractSectionBullets(readFileSync(abs, "utf8"), /^##\s+Decision\s*$/);
  // 게이트와 **같은 어휘**로 판정한다 — 여기서 따로 파싱하면 보고서만 다른 말을 한다.
  for (const b of bullets) {
    const hit = CEO_DECISION_TOKENS.find((t) => b.includes(t));
    if (hit) return hit;
  }
  return null;
}

/** red_team 문서의 미해소 Critical 목록. */
function criticalRisks(root: string, artifacts: readonly { path: string }[]): string[] {
  const doc = artifacts.find((a) => a.path.endsWith("05_RED_TEAM.md"));
  if (!doc) return [];
  const abs = join(root, doc.path);
  if (!existsSync(abs)) return [];
  return extractCriticalRisks(readFileSync(abs, "utf8"));
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * 확인 요청서 본문을 만든다. **읽는 순서가 판단 순서다**:
 * 판정 한 줄 → 내가 지금 결정할 것 → 그렇게 판단한 근거 → 걸린 위험 → (필요할 때만) 원문.
 */
export function buildCheckpointReport(root: string, i: CheckpointReportInput): string {
  const decision = decisionToken(root, i.artifacts);
  const risks = criticalRisks(root, i.artifacts);
  const L: string[] = [];

  L.push(`# 확인 요청 — ${i.stageNo}/${i.stageTotal}단계 '${i.stage}'`);
  L.push("");
  L.push(`프로젝트 \`${i.project}\` · checkpoint \`${i.checkpointId}\` · ${i.at}`);
  L.push("");
  L.push(
    `> 이 문서는 **읽기 편하라고 만든 요약**이고 승인 대상 자체가 아니다. 승인은 아래 원문 바이트에 걸린다.`,
  );
  L.push(`> checkpoint id가 위와 다르면 낡은 보고서다 — \`harness pipeline status\`로 확인하라.`);
  L.push("");

  L.push("## 판정 한 줄");
  L.push("");
  if (decision) L.push(`- CEO 판정: **${decision}**`);
  else L.push("- CEO 판정: (이 단계에는 판정 문서가 없다)");
  L.push(`- 미해소 Critical 리스크: **${risks.length}건**`);
  L.push("");

  L.push("## 지금 결정할 것");
  L.push("");
  L.push(`- [ ] **승인** — 다음 단계로 넘긴다`);
  L.push(`      \`harness pipeline approve ${i.stage} --checkpoint ${i.checkpointId} --project ${i.project}\``);
  L.push(`- [ ] **되돌림** — 같은 단계를 다시 실행한다 (기존 결과를 채택하지 않는다)`);
  L.push(
    `      \`harness pipeline reject ${i.stage} --checkpoint ${i.checkpointId} --project ${i.project} --note "<이유>"\``,
  );
  L.push("");
  L.push(`승인하지 않으면 아무것도 진행되지 않는다. 우회 플래그는 없다.`);
  L.push("");

  L.push("## 각 담당이 내린 핵심 판단");
  L.push("");
  if (i.seeds.length === 0) L.push("- (판단 요약이 없다 — 이 단계는 판단 문서를 내지 않았다)");
  for (const s of i.seeds) L.push(`- ${s.line}`);
  L.push("");

  L.push("## 걸린 위험 (Critical만)");
  L.push("");
  if (risks.length === 0) L.push("- (없음 — red_team이 Critical을 남기지 않았다)");
  risks.forEach((r, n) => L.push(`${n + 1}. ${r}`));
  L.push("");

  L.push("## 원문 (필요할 때만)");
  L.push("");
  let total = 0;
  for (const a of i.artifacts) {
    total += a.size;
    L.push(`- \`${a.path}\` (${kb(a.size)})`);
  }
  L.push("");
  L.push(`전체 ${kb(total)} — 위 요약으로 판단이 서면 원문을 다 읽지 않아도 된다.`);
  L.push("");
  return L.join("\n");
}

/** 보고서를 쓸 절대경로. */
export function checkpointReportPath(root: string): string {
  return join(root, CHECKPOINT_REPORT_REL);
}

/** 파일 크기(없으면 0) — 호출자가 안내에 쓴다. */
export function fileSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}
