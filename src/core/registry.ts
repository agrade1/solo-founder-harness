import { readFileSync, existsSync } from "node:fs";
import { fromPackage } from "./paths.js";

export interface AgentDef {
  agent_id: string;
  name: string;
  role: string;
  prompt_path: string;
  default_output: string;
  /** 에이전트별 추가 필수 헤더(공용 4개 외). 스키마 검증 재생성 루프가 검사. 미지정 시 공용 4개만. */
  required_headers?: string[];
  /** 산출 markdown 안의 ```json 블록을 이 경로로 추출·저장(예: docs/tokens.json). design 에이전트용. */
  token_output?: string;
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

/** 동적 분화: planner가 선언한 하위 전문 에이전트를 (승인 시) 런타임 생성·실행. */
export interface FanoutDef {
  planner: string; // 하위 에이전트를 선언하는 agent (fanout 직전 step, 예: tech_lead)
  max_agents: number; // 생성 상한 (폭주 방지)
}

/** 승인 게이트: 진행 전 사람 확인(y/n). 거부 시 중단(--resume 재개), --yes로 비대화 승인. */
export interface ApprovalDef {
  message: string; // 사용자에게 물을 문구
  show?: string; // 승인 전 보여줄 산출물 상대경로 (예: "outputs/chief_of_staff.md")
  tokens_path?: string; // 지정 시 디자인 게이트 — 승인 시 이 파일 해시를 run_state.design_gate에 기록
}

/** workflow step: agent id 문자열, 비평 루프, CEO 게이트, 동적 분화, 또는 승인 게이트. */
export type WorkflowStep =
  | string
  | { critique_loop: CritiqueLoopDef }
  | { gate: GateDef }
  | { fanout: FanoutDef }
  | { approval: ApprovalDef };

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

/** step이 동적 분화인지 판별 */
export function isFanout(step: WorkflowStep): step is { fanout: FanoutDef } {
  return typeof step === "object" && step !== null && "fanout" in step;
}

/** step이 승인 게이트인지 판별 */
export function isApproval(step: WorkflowStep): step is { approval: ApprovalDef } {
  return typeof step === "object" && step !== null && "approval" in step;
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
