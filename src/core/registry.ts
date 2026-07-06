import { readFileSync, existsSync } from "node:fs";
import { fromRoot } from "./paths.js";

export interface AgentDef {
  agent_id: string;
  name: string;
  role: string;
  prompt_path: string;
  default_output: string;
}

export interface AgentRegistry {
  common_prompt_path: string;
  agents: AgentDef[];
}

export interface WorkflowDef {
  workflow_id: string;
  description: string;
  steps: string[];
}

export interface WorkflowsFile {
  workflows: WorkflowDef[];
}

const AGENT_REGISTRY_PATH = "registry/agent_registry.json";
const WORKFLOWS_PATH = "registry/workflows.json";

function readJson<T>(relPath: string): T {
  const abs = fromRoot(relPath);
  if (!existsSync(abs)) {
    throw new Error(`registry 파일을 찾을 수 없습니다: ${relPath}`);
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T;
  } catch (err) {
    throw new Error(`registry 파일 파싱 실패 (${relPath}): ${(err as Error).message}`);
  }
}

/** registry/agent_registry.json 로드 */
export function loadAgentRegistry(): AgentRegistry {
  return readJson<AgentRegistry>(AGENT_REGISTRY_PATH);
}

/** registry/workflows.json 로드 */
export function loadWorkflows(): WorkflowDef[] {
  return readJson<WorkflowsFile>(WORKFLOWS_PATH).workflows;
}

/** common prompt 파일이 실제로 존재하는지 확인 */
export function commonPromptExists(reg: AgentRegistry): boolean {
  return existsSync(fromRoot(reg.common_prompt_path));
}

/** agent_id로 agent 정의를 찾는다. 없으면 undefined. */
export function findAgent(reg: AgentRegistry, agentId: string): AgentDef | undefined {
  return reg.agents.find((a) => a.agent_id === agentId);
}

/** workflow_id로 workflow 정의를 찾는다. 없으면 undefined. */
export function findWorkflow(workflows: WorkflowDef[], workflowId: string): WorkflowDef | undefined {
  return workflows.find((w) => w.workflow_id === workflowId);
}
