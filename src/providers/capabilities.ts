/**
 * Provider별 도구 실행 능력 선언 (V3 MCP M2, §3.2).
 *
 * profile이 요구하는 binding을 첫 모델 호출 전에 검증하는 fail-fast의 기준.
 * "도구가 없으니 모델 지식으로 추측"하는 폴백은 금지 — run 시작 전 명시 오류를 낸다.
 *
 * 값은 "현재 하네스가 배선한" 능력 기준(§2.2). claude-code CLI는 MCP/내장도구를 지원하나
 * interactiveApproval은 `-p`(headless)에서 비활성이고, toolTrace는 stream-json 파싱(M3) 전까지 false.
 */
export interface ProviderCapabilities {
  toolUse: boolean; // 도구 호출 자체
  builtinTools: boolean; // Claude Code 내장 도구(Read/Glob/Grep 등)
  localMcp: boolean; // 로컬 stdio MCP
  remoteMcp: boolean; // 원격 MCP
  toolAllowlist: boolean; // --allowedTools 등 도구 허용목록
  interactiveApproval: boolean; // 대화형 승인 UX
  streaming: boolean; // stream 출력
  toolTrace: boolean; // tool 이벤트 trace 수신(하네스 배선 기준)
}

const CAPS: Record<string, ProviderCapabilities> = {
  mock: {
    toolUse: false, builtinTools: false, localMcp: false, remoteMcp: false,
    toolAllowlist: false, interactiveApproval: false, streaming: false, toolTrace: false,
  },
  "claude-code": {
    toolUse: true, builtinTools: true, localMcp: true, remoteMcp: true,
    toolAllowlist: true, interactiveApproval: false, streaming: true, toolTrace: false,
  },
  anthropic: {
    // Connector 배선 전까지 도구 경로 전부 미지원 (§2.2)
    toolUse: false, builtinTools: false, localMcp: false, remoteMcp: false,
    toolAllowlist: false, interactiveApproval: false, streaming: false, toolTrace: false,
  },
};

/** provider id의 능력 선언을 반환한다. 미등록이면 전부 false(안전측). */
export function getProviderCapabilities(id: string): ProviderCapabilities {
  return (
    CAPS[id] ?? {
      toolUse: false, builtinTools: false, localMcp: false, remoteMcp: false,
      toolAllowlist: false, interactiveApproval: false, streaming: false, toolTrace: false,
    }
  );
}
