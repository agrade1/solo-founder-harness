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
  /** 프로젝트 docs/00_IDEA.md 원문 (없으면 빈 문자열). mock은 미사용, 실제 LLM은 검토 대상 아이디어. */
  ideaContent: string;
  /** 이전 agent들의 Main Judgment 요약 (handoff 맥락) */
  priorFindings: string[];
  /** 다음 agent id (없으면 workflow 종료) */
  nextAgentId?: string;
  /** 재생성 시도일 때, 직전 출력에서 무엇이 잘못됐는지 교정 지시 (스키마 재생성 루프). mock은 미사용. */
  retryFeedback?: string;
  /** 비평 루프에서 critic의 Critical 리스크를 반영해 판단을 수정하라는 지시. mock은 미사용. */
  revisionRequest?: string;
}

/** token 사용량. 실제 API provider만 채운다 (mock=0, claude-code=계측 불가 시 생략). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** provider 한 번 실행의 결과. */
export interface AgentResult {
  markdown: string;
  usage?: TokenUsage;
}

/**
 * provider 추상화. v2에서 mock/claude-code/anthropic 3종을 이 인터페이스로 교체.
 * (상세: docs/reference/PROVIDER_ARCHITECTURE_V2.md)
 */
export interface Provider {
  readonly id: string;
  /** agent 결과 markdown을 생성한다. 실제 LLM은 비동기라 Promise 반환. */
  generate(input: AgentRunInput): Promise<AgentResult>;
}
