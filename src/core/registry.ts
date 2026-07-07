import { readFileSync, existsSync } from "node:fs";
import { fromPackage } from "./paths.js";

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

/** Red Team 비평 루프 step: critic이 target의 Critical 리스크를 지적하면 target이 revise → 재검토. */
export interface CritiqueLoopDef {
  target: string; // 비평 반영해 수정할 agent (루프 전에 이미 실행돼 있어야 함)
  critic: string; // 비평하는 agent (예: red_team)
  max_rounds: number; // 라운드 상한 (무한루프 방지)
}

/** CEO 게이트: decider 판정이 on의 키와 맞으면 해당 agent로 되돌아가 재실행. */
export interface GateDef {
  decider: string; // 판정하는 agent (예: founder_ceo, 게이트 전에 이미 실행돼 있어야 함)
  on: Record<string, string>; // 판정 키워드 → 되돌아갈 agent id (예: {"축소":"pm","검증":"research"})
  max_jumps: number; // 되돌림 상한 (무한루프 방지)
}

/** workflow step: agent id 문자열, 비평 루프, 또는 CEO 게이트. */
export type WorkflowStep = string | { critique_loop: CritiqueLoopDef } | { gate: GateDef };

export interface WorkflowDef {
  workflow_id: string;
  description: string;
  steps: WorkflowStep[];
}

/** step이 비평 루프인지 판별 */
export function isCritiqueLoop(step: WorkflowStep): step is { critique_loop: CritiqueLoopDef } {
  return typeof step === "object" && step !== null && "critique_loop" in step;
}

/** step이 CEO 게이트인지 판별 */
export function isGate(step: WorkflowStep): step is { gate: GateDef } {
  return typeof step === "object" && step !== null && "gate" in step;
}

export interface WorkflowsFile {
  workflows: WorkflowDef[];
}

const AGENT_REGISTRY_PATH = "registry/agent_registry.json";
const WORKFLOWS_PATH = "registry/workflows.json";

function readJson<T>(relPath: string): T {
  const abs = fromPackage(relPath);
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
  return existsSync(fromPackage(reg.common_prompt_path));
}

/** agent_id로 agent 정의를 찾는다. 없으면 undefined. */
export function findAgent(reg: AgentRegistry, agentId: string): AgentDef | undefined {
  return reg.agents.find((a) => a.agent_id === agentId);
}

/** workflow_id로 workflow 정의를 찾는다. 없으면 undefined. */
export function findWorkflow(workflows: WorkflowDef[], workflowId: string): WorkflowDef | undefined {
  return workflows.find((w) => w.workflow_id === workflowId);
}
