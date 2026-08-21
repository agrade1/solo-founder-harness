/**
 * 하네스 내부 어댑터 레지스트리 골격 (V3 MCP M2).
 *
 * internal_adapter binding(선언-실행 backend, 예: 검색 어댑터)이 참조하는 어댑터가
 * 실제로 하네스에 등록/구현돼 있는지 fail-fast로 검증하기 위한 목록.
 *
 * M2에는 등록된 실행기가 없다 — Research Adapter(Tavily backend 등)는 M4에서 추가된다.
 * 따라서 지금 internal_adapter binding을 요구하는 profile은 fail-fast로 거부된다
 * (아직 없는 어댑터 사용 방지). 등록 시 이 Set에 이름을 추가한다.
 */
export const KNOWN_ADAPTERS = new Set([
    // [M7] research — 선언(`RESEARCH_REQUEST`)을 하네스가 직접 실행하는 어댑터.
    // 모델에 도구로 노출되지 않는다(internal_adapter). secret도 자식 프로세스로 가지 않는다:
    // 검색 호출은 **부모(하네스)** 안에서 일어나고 자식에는 래핑된 EvidenceItem 발췌만 들어간다.
    "research",
]);
/** 주어진 어댑터가 하네스에 등록돼 있는지. */
export function adapterAvailable(name, registry = KNOWN_ADAPTERS) {
    return registry.has(name);
}
