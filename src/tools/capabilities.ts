/**
 * Capability 3계층 + ToolBinding (V3 MCP M2).
 *
 * 에이전트/registry는 vendor 이름이 아니라 capability만 요구하고, 실제 도구는 ToolBinding이
 * 결정한다. capability는 3계층으로 나뉜다:
 *  - active   : M2~M4에서 실제 배선하는 capability
 *  - reserved : 타입만 존재. 활성 마일스톤 전 profile에 쓰면 로더가 거부
 *  - deny     : profile에 등장하는 순간 로드 자체 실패 (§7.6 — "잘못 쓴 profile은 로드되지 않음")
 *
 * deny를 타입에서 지우지 않는 이유(§3.1): 지우면 "profile에 없으니 괜찮다"는 암묵 허용이 된다.
 * 남겨 두고 로더가 명시적으로 거부한다.
 */

export type ActiveCapability =
  | "web_search"
  | "page_extract"
  | "source_verify"
  | "repo_read"
  | "design_read"
  | "component_registry_read"
  | "framework_docs";

export type ReservedCapability =
  | "site_crawl"
  | "runtime_diagnostics"
  | "browser_explore"
  | "browser_test"
  | "database_read"
  | "database_migration_draft"
  | "database_apply"
  | "preview_deploy"
  | "error_monitoring_read"
  | "billing_sandbox"
  | "workspace_export"
  | "local_workspace_write" // 로컬 워크스페이스 쓰기 — 승인 하에 향후 허용 가능
  | "pull_request_create"; // PR 생성(머지 아님) — 향후 허용 가능

export type DenyCapability =
  | "remote_repository_write" // 원격 저장소 직접 쓰기
  | "pull_request_merge" // PR 머지
  | "production_deploy"
  | "billing_live"
  | "design_write";

export type ToolCapability = ActiveCapability | ReservedCapability | DenyCapability;

export const ACTIVE_CAPS: ReadonlySet<ToolCapability> = new Set<ToolCapability>([
  "web_search", "page_extract", "source_verify",
  "repo_read", "design_read", "component_registry_read", "framework_docs",
]);

export const RESERVED_CAPS: ReadonlySet<ToolCapability> = new Set<ToolCapability>([
  "site_crawl", "runtime_diagnostics", "browser_explore", "browser_test",
  "database_read", "database_migration_draft", "database_apply",
  "preview_deploy", "error_monitoring_read", "billing_sandbox", "workspace_export",
  "local_workspace_write", "pull_request_create",
]);

export const DENY_CAPS: ReadonlySet<ToolCapability> = new Set<ToolCapability>([
  "remote_repository_write", "pull_request_merge", "production_deploy", "billing_live", "design_write",
]);

export type CapabilityTier = "active" | "reserved" | "deny" | "unknown";

/** capability 문자열이 어느 계층인지 판정한다. */
export function capabilityTier(c: string): CapabilityTier {
  if (ACTIVE_CAPS.has(c as ToolCapability)) return "active";
  if (RESERVED_CAPS.has(c as ToolCapability)) return "reserved";
  if (DENY_CAPS.has(c as ToolCapability)) return "deny";
  return "unknown";
}

/**
 * Capability가 실제로 무엇으로 실행되는지 (실행 주체 4형태).
 *  - builtin          : Claude Code 내장 도구 (Read/Glob/Grep 등) — 모델에 직접 노출
 *  - internal_adapter : 하네스 내부 어댑터 (선언-실행 backend, 예: 검색). Adapter Registry로 검증
 *  - mcp              : MCP 서버 도구. Provider MCP 지원으로 검증
 *  - cli              : 서비스 레포 CLI. 실행 환경(명령 존재)으로 검증
 */
export type ToolBinding =
  | { kind: "builtin"; tools: string[] }
  | { kind: "internal_adapter"; adapter: string; operations: string[] }
  | { kind: "mcp"; server: string; tools: string[] }
  | { kind: "cli"; command: string; operations?: string[] };
