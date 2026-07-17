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
export const KNOWN_ADAPTERS: ReadonlySet<string> = new Set<string>([
  // M4: "research" 등 추가 예정
]);

/** 주어진 어댑터가 하네스에 등록돼 있는지. */
export function adapterAvailable(name: string, registry: ReadonlySet<string> = KNOWN_ADAPTERS): boolean {
  return registry.has(name);
}
