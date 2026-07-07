import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, projectExists } from "./project.js";
import { extractMainJudgment } from "./validate.js";
import type { RunState } from "./runWorkflow.js";

function readRunState(project: string): RunState | null {
  const p = join(projectPaths(project).outputs, "run_state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RunState;
  } catch {
    return null;
  }
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/** 다음 작업을 상태로부터 도출한다. */
function nextActions(state: RunState | null, project: string): string[] {
  if (!state) {
    return ["아직 workflow 미실행 — `harness run <workflow> --project <name>` 실행."];
  }
  const actions: string[] = [];
  if (state.failed_agent) {
    const reason = state.failed_reason ? ` (${state.failed_reason})` : "";
    actions.push(
      `\`${state.failed_agent}\`에서 중단됨${reason} — 원인 확인 후 ` +
        `\`harness run ${state.workflow_id} --project ${project} --resume\`로 재개.`,
    );
  } else {
    actions.push(`workflow \`${state.workflow_id}\` 완료 — \`harness task-prompt\`로 작업 지시문 생성 또는 다음 workflow 실행.`);
  }
  if (state.warnings.length > 0) {
    actions.push(`필수 섹션 누락 경고 ${state.warnings.length}건 — 해당 결과 문서 보완 권장.`);
  }
  return actions;
}

/** CONTEXT_SUMMARY.md에 쓸 짧은 요약 markdown을 생성한다. */
export function buildSummary(project: string, today: string): string {
  const paths = projectPaths(project);
  const state = readRunState(project);
  const docs = listMarkdown(paths.docs);
  const outputs = listMarkdown(paths.outputs);

  const lines: string[] = [];
  lines.push(`# CONTEXT_SUMMARY.md — ${project}`, "");
  lines.push(`최종 갱신: ${today}`, "");

  lines.push("## 현재 상태");
  if (state) {
    lines.push(`- 마지막 workflow: \`${state.workflow_id}\``);
    lines.push(`- 상태: ${state.status ?? (state.failed_agent ? "failed" : "completed")}`);
    lines.push(`- 완료 단계: ${state.completed_steps.join(" → ") || "(없음)"}`);
    lines.push(`- 실패 agent: ${state.failed_agent ?? "없음"}`);
    lines.push(`- 경고: ${state.warnings.length}건`);
  } else {
    lines.push("- workflow 미실행 (run_state 없음)");
  }
  lines.push("");

  // CEO 판단이 있으면 핵심 한 줄 노출
  const ceoPath = join(paths.docs, "06_CEO_DECISION.md");
  if (existsSync(ceoPath)) {
    const judgment = extractMainJudgment(readFileSync(ceoPath, "utf8"));
    lines.push("## CEO 핵심 판단", `- ${judgment}`, "");
  }

  lines.push("## 생성된 문서");
  lines.push(`- docs/: ${docs.join(", ") || "(없음)"}`);
  lines.push(`- outputs/: ${outputs.join(", ") || "(없음)"}`);
  lines.push("");

  lines.push("## 다음 작업");
  for (const a of nextActions(state, project)) lines.push(`- ${a}`);
  lines.push("");

  return lines.join("\n");
}

/** CONTEXT_SUMMARY.md를 갱신하고 저장 경로(프로젝트 상대)를 반환한다. */
export function updateContextSummary(project: string, today: string): string {
  if (!projectExists(project)) {
    throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
  }
  const content = buildSummary(project, today);
  const rel = "docs/CONTEXT_SUMMARY.md";
  writeFileSync(join(projectPaths(project).root, rel), content, "utf8");
  return rel;
}
