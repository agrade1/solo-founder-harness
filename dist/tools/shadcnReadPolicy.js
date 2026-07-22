import { SHADCN_SERVER } from "./shadcnPilot.js";
/**
 * [V3 M3c-3a] shadcn read-only 프록시 정책 상수 + 입력 검증 (offline).
 *
 * 원본 shadcn MCP는 7개 도구를 모두 노출한다. 이 정책은 **읽기 후보 5개만** upstream에 노출하고,
 * 금지 2개는 tools/list 미노출 + tools/call fail-closed, 각 도구 인자를 좁게 강제한다.
 * annotations/description·downstream schema는 신뢰하지 않고 로컬 제한 schema만 노출한다.
 * 모든 상수는 non-exported 내부 + deep-freeze, 외부는 clone getter만 본다.
 */
function deepFreeze(o) {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o))
            deepFreeze(o[k]);
    }
    return o;
}
export const REQUEST_PROTOCOL_VERSION = "2025-11-25";
const ALLOWED_PROTOCOL_VERSIONS = deepFreeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
/** upstream에 노출하는 읽기 후보 5개(bare). */
const ALLOWED_TOOLS = deepFreeze(["get_project_registries", "list_items_in_registries", "search_items_in_registries", "view_items_in_registries", "get_item_examples_from_registries"]);
/** 노출·호출 금지 2개(bare). tools/call도 fail-closed. */
const FORBIDDEN_TOOLS = deepFreeze(["get_add_command_for_items", "get_audit_checklist"]);
/** downstream 실측 7개(bare, 정렬). startup에서 정확 일치 요구. */
const EXPECTED_BARE_7 = deepFreeze([...ALLOWED_TOOLS, ...FORBIDDEN_TOOLS].sort());
// 실행 상한.
export const MAX_TOOL_CALLS = 6;
export const PER_CALL_TIMEOUT_MS = 60_000;
export const SINGLE_RESPONSE_CAP = 256 * 1024;
export const DS_STDOUT_CAP = 2 * 1024 * 1024;
export const DS_STDERR_CAP = 64 * 1024;
export const UPSTREAM_LINE_CAP = 256 * 1024;
export const RESULT_CHARS_BUDGET = 8_000;
export const MAX_TOOLSLIST_PAGES = 8;
// 제어문자(0x00–0x1F, 0x7F) 금지.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export function getAllowedProtocolVersions() {
    return new Set(ALLOWED_PROTOCOL_VERSIONS);
}
export function getAllowedTools() {
    return [...ALLOWED_TOOLS];
}
export function getForbiddenTools() {
    return [...FORBIDDEN_TOOLS];
}
export function getExpectedBare7() {
    return [...EXPECTED_BARE_7];
}
export function isAllowedTool(bare) {
    return ALLOWED_TOOLS.includes(bare);
}
export function isForbiddenTool(bare) {
    return FORBIDDEN_TOOLS.includes(bare);
}
export function nsName(bare) {
    return `mcp__${SHADCN_SERVER}__${bare}`;
}
export function isAllowedProtocolVersion(v) {
    return typeof v === "string" && ALLOWED_PROTOCOL_VERSIONS.includes(v);
}
/** 정책 위반(typed). 메시지에 원문/secret을 담지 않는다. */
export class ShadcnPolicyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ShadcnPolicyError";
        this.code = code;
    }
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assertOnlyKeys(obj, allowed) {
    for (const k of Object.keys(obj))
        if (!allowed.includes(k))
            throw new ShadcnPolicyError("extra_key", "허용되지 않은 인자 key");
}
function assertExactStrArray(v, expected, label) {
    if (!Array.isArray(v) || v.length !== expected.length || v.some((x, i) => x !== expected[i]))
        throw new ShadcnPolicyError("bad_arg", `${label}가 정확히 [${expected.join(",")}] 아님`);
}
function assertIntRange(v, min, max, label) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
        throw new ShadcnPolicyError("bad_arg", `${label}가 정수 ${min}~${max} 범위 아님`);
}
function assertQuery(v) {
    if (typeof v !== "string" || v.length < 1 || v.length > 200)
        throw new ShadcnPolicyError("bad_arg", "query가 1~200자 문자열 아님");
    if (CONTROL_RE.test(v))
        throw new ShadcnPolicyError("bad_arg", "query에 제어문자 포함");
}
/**
 * upstream tools/call 인자를 정책에 따라 검증한다. 위반 시 ShadcnPolicyError(child 호출 전 차단).
 * downstream으로 전달할 정규화된 arguments(입력 그대로, 검증만)를 반환한다.
 */
export function validateToolArgs(bare, args) {
    if (isForbiddenTool(bare))
        throw new ShadcnPolicyError("forbidden_tool", "금지 도구");
    if (!isAllowedTool(bare))
        throw new ShadcnPolicyError("unknown_tool", "미확정 도구");
    if (!isPlainObject(args))
        throw new ShadcnPolicyError("bad_arg", "arguments가 객체 아님");
    switch (bare) {
        case "get_project_registries":
            if (Object.keys(args).length !== 0)
                throw new ShadcnPolicyError("extra_key", "get_project_registries는 빈 객체만 허용");
            return {};
        case "list_items_in_registries":
            assertOnlyKeys(args, ["registries", "types", "limit", "offset"]);
            assertExactStrArray(args.registries, ["@shadcn"], "registries");
            assertExactStrArray(args.types, ["ui"], "types");
            if ("limit" in args)
                assertIntRange(args.limit, 1, 20, "limit");
            if ("offset" in args)
                assertIntRange(args.offset, 0, 1000, "offset");
            return { ...args };
        case "search_items_in_registries":
            assertOnlyKeys(args, ["registries", "types", "limit", "offset", "query"]);
            assertExactStrArray(args.registries, ["@shadcn"], "registries");
            assertExactStrArray(args.types, ["ui"], "types");
            assertQuery(args.query);
            if ("limit" in args)
                assertIntRange(args.limit, 1, 20, "limit");
            if ("offset" in args)
                assertIntRange(args.offset, 0, 1000, "offset");
            return { ...args };
        case "view_items_in_registries": {
            assertOnlyKeys(args, ["items"]);
            const items = args.items;
            if (!Array.isArray(items) || items.length < 1 || items.length > 10)
                throw new ShadcnPolicyError("bad_arg", "items가 1~10개 배열 아님");
            for (const it of items) {
                if (typeof it !== "string" || it.length < 1 || it.length > 200)
                    throw new ShadcnPolicyError("bad_arg", "item이 1~200자 문자열 아님");
                if (!it.startsWith("@shadcn/"))
                    throw new ShadcnPolicyError("bad_arg", "item이 @shadcn/ prefix 아님");
                if (it.includes(".."))
                    throw new ShadcnPolicyError("bad_arg", "item에 traversal(..) 포함");
                if (it.includes("://"))
                    throw new ShadcnPolicyError("bad_arg", "item에 URL 포함");
                if (CONTROL_RE.test(it))
                    throw new ShadcnPolicyError("bad_arg", "item에 제어문자 포함");
            }
            return { items: [...items] };
        }
        case "get_item_examples_from_registries":
            assertOnlyKeys(args, ["registries", "query"]);
            assertExactStrArray(args.registries, ["@shadcn"], "registries");
            assertQuery(args.query);
            return { ...args };
        default:
            throw new ShadcnPolicyError("unknown_tool", "미확정 도구");
    }
}
/**
 * upstream tools/list에 노출할 **로컬 제한 schema**(downstream schema 미사용). 매 호출 새 객체.
 * MCP 서버로서 Tool.name은 **bare 이름**만 반환한다 — `mcp__<server>__` prefix는 Claude host가
 * server name으로 생성하는 이름이며 MCP 서버가 반환하면 안 된다.
 */
export function restrictedToolList() {
    const registriesSchema = { type: "array", items: { const: "@shadcn" }, minItems: 1, maxItems: 1 };
    const typesSchema = { type: "array", items: { const: "ui" }, minItems: 1, maxItems: 1 };
    const limitSchema = { type: "integer", minimum: 1, maximum: 20 };
    const offsetSchema = { type: "integer", minimum: 0, maximum: 1000 };
    const querySchema = { type: "string", minLength: 1, maxLength: 200 };
    const obj = (properties, required) => ({ type: "object", additionalProperties: false, properties, required });
    return [
        { name: "get_project_registries", description: "List configured shadcn registries (read-only).", inputSchema: obj({}, []) },
        { name: "list_items_in_registries", description: "List @shadcn ui items (read-only).", inputSchema: obj({ registries: registriesSchema, types: typesSchema, limit: limitSchema, offset: offsetSchema }, ["registries", "types"]) },
        { name: "search_items_in_registries", description: "Search @shadcn ui items (read-only).", inputSchema: obj({ registries: registriesSchema, types: typesSchema, query: querySchema, limit: limitSchema, offset: offsetSchema }, ["registries", "types", "query"]) },
        { name: "view_items_in_registries", description: "View specific @shadcn items (read-only).", inputSchema: obj({ items: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", pattern: "^@shadcn/" } } }, ["items"]) },
        { name: "get_item_examples_from_registries", description: "Get @shadcn item examples (read-only).", inputSchema: obj({ registries: registriesSchema, query: querySchema }, ["registries", "query"]) },
    ];
}
