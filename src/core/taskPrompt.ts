import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, projectExists } from "./project.js";
import { extractMainJudgment, extractSectionBullets } from "./validate.js";
import type { RunState } from "./runWorkflow.js";

const NEXT_ACTIONS_RE = /^##\s+.*Next Actions\s*$/;

function readIfExists(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

function readRunState(project: string): RunState | null {
  const p = join(projectPaths(project).outputs, "run_state.json");
  const raw = readIfExists(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

// Claude Code 작업 지시문에 항상 포함하는 규칙 (PERMISSION_POLICY §6)
const RULES: string[] = [
  "작업 전 구현 계획을 먼저 제시하고, 사용자 승인 전에는 파일을 수정하지 않는다.",
  "관련 없는 파일은 열지 않고, 한 번에 하나의 기능만 구현한다.",
  "패키지 설치가 필요하면 이유와 대체안을 먼저 제시한다. 승인 없이 설치하지 않는다.",
  "배포, DB migration/변경, git push는 실행하지 않는다.",
  ".env, secrets 파일은 읽거나 출력하지 않는다.",
  "수정 후 변경 파일, 실행한 명령어, 남은 TODO를 요약한다.",
  "작업 결과는 docs/WORKLOG.md에 남긴다.",
];

/** Claude Code 작업 지시문 markdown을 생성한다. */
export function buildTaskPrompt(project: string, today: string): string {
  const paths = projectPaths(project);
  const state = readRunState(project);

  const ceo = readIfExists(join(paths.docs, "06_CEO_DECISION.md"));
  const prd = readIfExists(join(paths.docs, "02_PRD.md"));
  const idea = readIfExists(join(paths.docs, "00_IDEA.md"));

  // Task / Done Criteria 후보: CEO → PRD 순서로 Next Actions를 찾는다.
  let nextActions: string[] = [];
  if (ceo) nextActions = extractSectionBullets(ceo, NEXT_ACTIONS_RE);
  if (nextActions.length === 0 && prd) nextActions = extractSectionBullets(prd, NEXT_ACTIONS_RE);
  if (nextActions.length === 0) {
    nextActions = ["판단 문서를 근거로 MVP의 첫 기능 하나를 구현한다."];
  }

  const ceoJudgment = ceo ? extractMainJudgment(ceo) : "(CEO 판단 문서 없음)";

  // Include: 실제 존재하는 핵심 문서만
  const includeCandidates = [
    "docs/00_IDEA.md",
    "docs/01_RESEARCH.md",
    "docs/02_PRD.md",
    "docs/03_UX_FLOW.md",
    "docs/04_TECH_PLAN.md",
    "docs/05_RED_TEAM.md",
    "docs/06_CEO_DECISION.md",
    "docs/API_CONTRACT.md",
  ].filter((rel) => existsSync(join(paths.root, rel)));

  const lines: string[] = [];
  lines.push(`# Claude Code 작업 지시문 — ${project}`, "");
  lines.push(`생성: ${today} (harness task-prompt, provider: mock)`, "");

  lines.push("## Context");
  lines.push(`- 프로젝트: ${project}`);
  if (state) {
    lines.push(`- 마지막 workflow: \`${state.workflow_id}\` (완료: ${state.completed_steps.join(" → ") || "없음"})`);
    if (state.failed_agent) lines.push(`- 주의: \`${state.failed_agent}\`에서 중단됨`);
  } else {
    lines.push("- workflow 미실행 상태");
  }
  lines.push(`- CEO 핵심 판단: ${ceoJudgment}`);
  if (idea) {
    const oneLine = extractSectionBullets(idea, /^##\s+아이디어 한 줄 정의\s*$/)[0];
    if (oneLine) lines.push(`- 아이디어: ${oneLine}`);
  }
  lines.push("");

  lines.push("## Task");
  lines.push("아래 판단 문서를 근거로 다음을 수행한다 (우선순위 순):");
  nextActions.slice(0, 5).forEach((a, i) => lines.push(`${i + 1}. ${a}`));
  lines.push("");

  // 동적 분화(fanout)가 있었으면 병렬 subagent 실행 스펙을 추가한다 (B-③).
  const spawned = state?.spawned_agents ?? [];
  if (spawned.length > 0) {
    lines.push("## 병렬 실행 (Claude Code subagents)");
    lines.push(
      `\`${spawned[0].parent}\`가 아래 ${spawned.length}개 전문 영역으로 분화했다. ` +
        "Claude Code에서 각 영역을 **병렬 subagent**로 띄워 진행하고, 전부 완료된 뒤 통합·교차검증한다.",
    );
    lines.push("⚠️ 각 subagent 작업 전 구현 계획을 먼저 제시하고 사용자 승인을 받는다 (자동 실행 금지).");
    lines.push("");
    for (const s of spawned) {
      lines.push(`### ${s.id} — ${s.name}`);
      lines.push(`- 담당 범위: ${s.focus}`);
      if (s.output) lines.push(`- 계획 문서: ${s.output}`);
      else lines.push(`- (계획 문서 미생성 — \`harness run ... --allow-spawn\`으로 생성 가능)`);
      lines.push(`- 산출: 담당 범위의 코드/변경만. 다른 영역 파일은 건드리지 않는다.`);
      lines.push("");
    }
    lines.push("### 통합");
    lines.push("- `docs/API_CONTRACT.md`의 인터페이스 계약을 기준으로 각 영역을 통합한다.");
    lines.push("- 각 subagent 완료 후 계약 일치·빌드·테스트로 교차 검증한다.");
    lines.push("");
  }

  lines.push("## Include (읽을 것)");
  for (const rel of includeCandidates) lines.push(`- ${rel}`);
  for (const s of spawned) if (s.output) lines.push(`- ${s.output}`);
  lines.push("");

  lines.push("## Exclude (건드리지 말 것)");
  lines.push("- 위 Include에 없는 무관한 파일");
  lines.push("- .env 및 secrets 파일");
  lines.push("- 하네스 자체 소스(src/, registry/, agents/)");
  lines.push("");

  lines.push("## Rules");
  for (const r of RULES) lines.push(`- ${r}`);
  lines.push("");

  lines.push("## Done Criteria");
  lines.push("- Task 항목이 구현되고 로컬에서 동작 확인됨");
  lines.push("- 변경 파일/실행 명령/남은 TODO가 요약됨");
  lines.push("- docs/WORKLOG.md에 결과 기록됨");
  lines.push("- 승인 없는 패키지 설치/배포/DB 변경이 없음");
  lines.push("");

  return lines.join("\n");
}

/** 작업 지시문을 outputs/claude_code_task_prompt.md로 저장하고 상대경로를 반환한다. */
export function generateTaskPrompt(project: string, today: string): string {
  if (!projectExists(project)) {
    throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
  }
  const content = buildTaskPrompt(project, today);
  const rel = "outputs/claude_code_task_prompt.md";
  writeFileSync(join(projectPaths(project).root, rel), content, "utf8");
  return rel;
}
