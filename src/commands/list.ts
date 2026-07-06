import { loadAgentRegistry, loadWorkflows, commonPromptExists } from "../core/registry.js";

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
    console.log(`    steps: ${w.steps.join(" → ")}`);
  }
}
