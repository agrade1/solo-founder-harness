import type { AgentDef } from "../core/registry.js";

/** 한 agent 실행에 필요한 입력 묶음 */
export interface AgentRunInput {
  agent: AgentDef;
  workflowId: string;
  project: string;
  createdAt: string;
  /** 로드된 common prompt 원문 (mock은 존재만 확인, 실제 LLM은 시스템 프롬프트로 사용) */
  commonPrompt: string;
  /** 로드된 agent prompt 원문 */
  agentPrompt: string;
  /** 이전 agent들의 Main Judgment 요약 (handoff 맥락) */
  priorFindings: string[];
  /** 다음 agent id (없으면 workflow 종료) */
  nextAgentId?: string;
}

/** provider 추상화. v1은 mock만, v2에서 실제 LLM provider 추가. */
export interface Provider {
  readonly id: string;
  /** agent 결과 markdown을 생성한다. */
  generate(input: AgentRunInput): string;
}
