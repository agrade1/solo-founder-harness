import { loadAgentRegistry, loadWorkflows, commonPromptExists, isCritiqueLoop, type WorkflowStep } from "../core/registry.js";

/** step을 사람이 읽을 문자열로 렌더링한다 (비평 루프는 critic⟲target×N 형태). */
function renderStep(step: WorkflowStep): string {
  if (isCritiqueLoop(step)) {
    const { critic, target, max_rounds } = step.critique_loop;
    return `↻[${critic}⟲${target}×${max_rounds}]`;
  }
  return step;
}

/** harness list: core agents, common prompt 존재 여부, workflows를 출력한다. */
export function runList(): void {
  const reg = loadAgentRegistry();
  const workflows = loadWorkflows();

  console.log(`Core Agents (${reg.agents.length}):`);
  for (const a of reg.agents) {
    console.log(`  - ${a.agent_id.padEnd(14)} ${a.name}`);
    console.log(`    ${a.role}`);
  }

  console.log("");
  const commonOk = commonPromptExists(reg);
  console.log(`Common Prompt: ${reg.common_prompt_path} ${commonOk ? "(존재)" : "(없음 ⚠)"}`);

  console.log("");
  console.log(`Workflows (${workflows.length}):`);
  for (const w of workflows) {
    console.log(`  - ${w.workflow_id.padEnd(14)} ${w.description}`);
    console.log(`    steps: ${w.steps.map(renderStep).join(" → ")}`);
  }
}
