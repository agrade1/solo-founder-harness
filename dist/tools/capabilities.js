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
export const ACTIVE_CAPS = new Set([
    "web_search", "page_extract", "source_verify",
    "repo_read", "design_read", "component_registry_read", "framework_docs",
]);
export const RESERVED_CAPS = new Set([
    "site_crawl", "runtime_diagnostics", "browser_explore", "browser_test",
    "database_read", "database_migration_draft", "database_apply",
    "preview_deploy", "error_monitoring_read", "billing_sandbox", "workspace_export",
    "local_workspace_write", "pull_request_create",
]);
export const DENY_CAPS = new Set([
    "remote_repository_write", "pull_request_merge", "production_deploy", "billing_live", "design_write",
]);
/** capability 문자열이 어느 계층인지 판정한다. */
export function capabilityTier(c) {
    if (ACTIVE_CAPS.has(c))
        return "active";
    if (RESERVED_CAPS.has(c))
        return "reserved";
    if (DENY_CAPS.has(c))
        return "deny";
    return "unknown";
}
