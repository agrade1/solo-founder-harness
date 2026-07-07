import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute, basename } from "node:path";
import { loadAgentRegistry, loadWorkflows, findWorkflow, findAgent, type AgentDef } from "./registry.js";
import { projectPaths, ensureDir } from "./project.js";
import type { RunState } from "./runWorkflow.js";

export interface ObsidianExportResult {
  vaultRoot: string; // 해석된 vault 절대경로
  folder: string; // <vault>/<project> 절대경로
  notesWritten: number;
  indexNote: string; // index note 파일명 (확장자 제외 basename)
}

/** Obsidian 노트 basename으로 안전한 문자열 (링크 해석은 basename 기준). */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
}

/** YAML frontmatter 문자열 값 이스케이프 (항상 큰따옴표로 감싼다). */
function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** vault 경로를 해석한다: 절대경로 그대로, 상대경로는 CWD 기준. */
export function resolveVault(vault: string): string {
  return isAbsolute(vault) ? vault : resolve(process.cwd(), vault);
}

/**
 * workflow 실행 결과를 Obsidian vault로 export 한다.
 * - 각 완료 agent 출력 → <vault>/<project>/<agent_id>.md (frontmatter + 원문 + 연결 wikilink)
 * - 분화된 하위 에이전트 출력도 함께 export
 * - run index note(MOC) → 실행 순서대로 [[wikilink]] 나열 + 메타(usage/루프/게이트)
 * 원본 프로젝트 파일은 건드리지 않는다 (읽기 + vault에 사본 생성).
 */
export function exportToVault(args: { vault: string; state: RunState }): ObsidianExportResult {
  const vaultRoot = resolveVault(args.vault);
  const { state } = args;
  const project = state.project;
  const folder = join(vaultRoot, safeName(project));
  ensureDir(folder);

  const registry = loadAgentRegistry();
  const workflow = findWorkflow(loadWorkflows(), state.workflow_id);
  const projectRoot = projectPaths(project).root;

  // 실행 순서 = completed_steps. 각 항목의 (노트명, 출력 파일 절대경로, 역할)을 구한다.
  interface NoteSrc {
    note: string; // vault 노트 basename (확장자 제외)
    role: string;
    srcAbs: string; // 원본 파일 절대경로
    agentId: string;
  }
  const spawnById = new Map(state.spawned_agents.filter((s) => s.executed && s.output).map((s) => [`spawn_${s.id}`, s]));
  const items: NoteSrc[] = [];
  for (const agentId of state.completed_steps) {
    const def: AgentDef | undefined = findAgent(registry, agentId);
    let srcRel: string | undefined;
    let role = "";
    if (def) {
      srcRel = def.default_output;
      role = def.role;
    } else if (spawnById.has(agentId)) {
      const s = spawnById.get(agentId)!;
      srcRel = s.output ?? undefined;
      role = s.focus;
    }
    if (!srcRel) continue;
    const srcAbs = join(projectRoot, srcRel);
    if (!existsSync(srcAbs)) continue;
    items.push({ note: safeName(agentId), role, srcAbs, agentId });
  }

  const indexNote = safeName(`${state.workflow_id}_run`);
  const tags = ["harness", `workflow/${safeName(state.workflow_id)}`, `project/${safeName(project)}`];
  const tagsYaml = tags.map((t) => `\n  - ${t}`).join("");

  // ── 각 agent 노트 ─────────────────────────────
  let notesWritten = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const body = readFileSync(it.srcAbs, "utf8");
    const links: string[] = [];
    if (i > 0) links.push(`이전: [[${items[i - 1].note}]]`);
    if (i < items.length - 1) links.push(`다음: [[${items[i + 1].note}]]`);
    links.push(`인덱스: [[${indexNote}]]`);

    const fm =
      `---\n` +
      `project: ${yamlStr(project)}\n` +
      `workflow: ${yamlStr(state.workflow_id)}\n` +
      `agent: ${yamlStr(it.agentId)}\n` +
      `role: ${yamlStr(it.role)}\n` +
      `provider: ${yamlStr(state.provider)}\n` +
      `date: ${yamlStr(state.finished_at)}\n` +
      `tags:${tagsYaml}\n` +
      `---\n\n`;
    const footer = `\n\n---\n\n## 연결\n\n${links.join(" · ")}\n`;
    writeFileSync(join(folder, `${it.note}.md`), fm + body.trimEnd() + footer, "utf8");
    notesWritten++;
  }

  // ── run index note (MOC) ──────────────────────
  const order = items.map((it, i) => `${i + 1}. [[${it.note}]]${it.role ? ` — ${it.role}` : ""}`).join("\n");
  const metaLines: string[] = [];
  metaLines.push(`- provider: ${state.provider}`);
  metaLines.push(`- 완료 단계: ${state.completed_steps.length}개`);
  if (state.failed_agent) metaLines.push(`- 실패 agent: ${state.failed_agent}`);
  if (state.usage.input_tokens > 0 || state.usage.output_tokens > 0) {
    metaLines.push(`- 토큰: in ${state.usage.input_tokens} / out ${state.usage.output_tokens}`);
  }
  for (const c of state.critique_rounds) {
    metaLines.push(`- 비평 루프: ${c.critic}⟲${c.target} ${c.rounds}라운드 (${c.resolved ? "해소" : "미해결"})`);
  }
  for (const g of state.gate_jumps) {
    metaLines.push(`- 게이트: ${g.decider} 판정 '${g.decision ?? "미매칭"}' → ${g.jumped_to ? `${g.jumped_to} 되돌림` : "진행"}`);
  }
  for (const s of state.spawned_agents) {
    metaLines.push(`- 분화: ${s.id} (${s.name}) — ${s.executed ? "실행됨" : "계획만"}`);
  }

  const indexFm =
    `---\n` +
    `project: ${yamlStr(project)}\n` +
    `workflow: ${yamlStr(state.workflow_id)}\n` +
    `provider: ${yamlStr(state.provider)}\n` +
    `date: ${yamlStr(state.finished_at)}\n` +
    `tags:${tagsYaml}\n` +
    `  - moc\n` +
    `---\n\n`;
  const desc = workflow?.description ? `\n${workflow.description}\n` : "";
  const indexBody =
    `# ${project} — ${state.workflow_id}\n${desc}\n` +
    `## 실행 순서\n\n${order || "(완료된 단계 없음)"}\n\n` +
    `## 실행 메타\n\n${metaLines.join("\n")}\n`;
  writeFileSync(join(folder, `${indexNote}.md`), indexFm + indexBody, "utf8");
  notesWritten++;

  return { vaultRoot, folder, notesWritten, indexNote };
}

/** 표시용: vault 루트를 홈 기준 짧은 경로로. */
export function shortVault(p: string): string {
  return basename(p);
}
