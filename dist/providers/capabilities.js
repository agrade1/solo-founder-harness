const CAPS = {
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
export function getProviderCapabilities(id) {
    return (CAPS[id] ?? {
        toolUse: false, builtinTools: false, localMcp: false, remoteMcp: false,
        toolAllowlist: false, interactiveApproval: false, streaming: false, toolTrace: false,
    });
}
