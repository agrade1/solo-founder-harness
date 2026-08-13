import { readFileSync } from "node:fs";
import { fromPackage } from "../core/paths.js";
import { capabilityTier, } from "./capabilities.js";
import { assertValidSecretRefs } from "./redact.js";
import { adapterAvailable } from "./adapters.js";
/** [M3c-3b] 신뢰된 launcher 식별자 목록(runtime loader·adapter 공용). */
export const TRUSTED_LAUNCHER_IDS = ["shadcn_read_proxy"];
export class ToolProfileError extends Error {
}
// ── 수동 구조 validator ──────────────────────────────────────────
function isStrArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function validateBinding(cap, b, id) {
    if (!b || typeof b !== "object")
        throw new ToolProfileError(`profile '${id}': binding '${cap}'이 객체가 아님`);
    const kind = b.kind;
    switch (kind) {
        case "builtin":
            if (!isStrArray(b.tools))
                throw new ToolProfileError(`profile '${id}': builtin binding '${cap}'에 tools[] 필요`);
            return b;
        case "mcp": {
            const mb = b;
            if (typeof mb.server !== "string" || !isStrArray(mb.tools))
                throw new ToolProfileError(`profile '${id}': mcp binding '${cap}'에 server, tools[] 필요`);
            return b;
        }
        case "internal_adapter": {
            const ab = b;
            if (typeof ab.adapter !== "string" || !isStrArray(ab.operations))
                throw new ToolProfileError(`profile '${id}': internal_adapter binding '${cap}'에 adapter, operations[] 필요`);
            return b;
        }
        case "cli": {
            const cb = b;
            if (typeof cb.command !== "string" || (cb.operations !== undefined && !isStrArray(cb.operations)))
                throw new ToolProfileError(`profile '${id}': cli binding '${cap}'에 command(문자열) 필요`);
            return b;
        }
        default:
            throw new ToolProfileError(`profile '${id}': binding '${cap}'의 kind가 유효하지 않음: ${String(kind)}`);
    }
}
/**
 * [M3c-3b] 서버 선언 1개를 런타임 검증한다(단순 cast 금지). 위반 시 ToolProfileError(로드 단계 거부).
 * 분류: launcher / http(url 또는 transport:http) / stdio(command 또는 transport:stdio) / bare(name만, M2 호환).
 * unknown key·unknown launcher·mixed transport를 각 분류에서 거부한다.
 */
function validateServer(raw, id) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new ToolProfileError(`profile '${id}': server가 객체가 아님`);
    const s = raw;
    if (typeof s.name !== "string" || !s.name)
        throw new ToolProfileError(`profile '${id}': server.name(비어있지 않은 문자열) 필요`);
    const keys = Object.keys(s);
    const onlyKeys = (allowed) => {
        for (const k of keys)
            if (!allowed.includes(k))
                throw new ToolProfileError(`profile '${id}': server '${s.name}'에 허용되지 않은 key '${k}'`);
    };
    if ("transport" in s && s.transport !== "stdio" && s.transport !== "http") {
        throw new ToolProfileError(`profile '${id}': server '${s.name}'의 transport는 stdio|http만`);
    }
    // launcher 서버
    if ("launcher" in s) {
        if (!TRUSTED_LAUNCHER_IDS.includes(s.launcher)) {
            throw new ToolProfileError(`profile '${id}': server '${s.name}'의 알 수 없는 launcher '${String(s.launcher)}'`);
        }
        onlyKeys(["name", "launcher"]); // command/args/url/transport 존재 자체 금지
        return s;
    }
    // http 서버
    if ("url" in s || s.transport === "http") {
        if (typeof s.url !== "string" || !/^https:\/\//.test(s.url))
            throw new ToolProfileError(`profile '${id}': server '${s.name}' http는 HTTPS url 필요`);
        if ("command" in s || "args" in s || "launcher" in s)
            throw new ToolProfileError(`profile '${id}': server '${s.name}' http에 command/args/launcher 금지`);
        onlyKeys(["name", "url", "transport"]);
        return s;
    }
    // stdio 서버
    if ("command" in s || s.transport === "stdio") {
        if (typeof s.command !== "string" || !s.command)
            throw new ToolProfileError(`profile '${id}': server '${s.name}' stdio는 command(비어있지 않은 문자열) 필요`);
        if ("args" in s && !isStrArray(s.args))
            throw new ToolProfileError(`profile '${id}': server '${s.name}' args는 string[]`);
        if ("launcher" in s || "url" in s)
            throw new ToolProfileError(`profile '${id}': server '${s.name}' stdio에 launcher/url 금지`);
        onlyKeys(["name", "command", "args", "transport"]);
        return s;
    }
    // bare 선언(name만) — M2 planning-plane 최소 선언 호환. execution 필드 없음.
    onlyKeys(["name"]);
    return s;
}
function validateStructure(raw) {
    if (!raw || typeof raw !== "object")
        throw new ToolProfileError("profile이 객체가 아님");
    const p = raw;
    const id = p.id;
    if (typeof id !== "string" || !id)
        throw new ToolProfileError("profile.id(문자열) 필요");
    if (!isStrArray(p.capabilities))
        throw new ToolProfileError(`profile '${id}': capabilities[] 필요`);
    if (!p.bindings || typeof p.bindings !== "object")
        throw new ToolProfileError(`profile '${id}': bindings 객체 필요`);
    if (!Array.isArray(p.servers))
        throw new ToolProfileError(`profile '${id}': servers[] 필요`);
    if (!isStrArray(p.preapprovedTools))
        throw new ToolProfileError(`profile '${id}': preapprovedTools[] 필요`);
    if (!isStrArray(p.deniedTools))
        throw new ToolProfileError(`profile '${id}': deniedTools[] 필요`);
    if (!["read_only", "dev_write", "approval_write"].includes(p.permissionMode))
        throw new ToolProfileError(`profile '${id}': permissionMode는 read_only|dev_write|approval_write`);
    if (p.allowedDomains !== null && !isStrArray(p.allowedDomains))
        throw new ToolProfileError(`profile '${id}': allowedDomains는 null 또는 string[]`);
    const lim = p.limits;
    if (!lim || typeof lim.maxCallsPerStep !== "number" || typeof lim.maxResultChars !== "number" || typeof lim.maxElapsedMsPerCall !== "number")
        throw new ToolProfileError(`profile '${id}': limits(maxCallsPerStep/maxResultChars/maxElapsedMsPerCall 숫자) 필요`);
    if (!isStrArray(p.secretRefs))
        throw new ToolProfileError(`profile '${id}': secretRefs[] 필요`);
    const bindings = {};
    for (const [cap, b] of Object.entries(p.bindings)) {
        bindings[cap] = validateBinding(cap, b, id);
    }
    const servers = p.servers.map((s) => validateServer(s, id));
    return {
        id,
        capabilities: p.capabilities,
        bindings,
        servers,
        preapprovedTools: p.preapprovedTools,
        deniedTools: p.deniedTools,
        permissionMode: p.permissionMode,
        allowedDomains: p.allowedDomains ?? null,
        limits: p.limits,
        secretRefs: p.secretRefs,
        source: p.source,
    };
}
/** binding들에서 모델에 노출될 도구 목록을 파생한다 (builtin ∪ mcp). */
export function deriveExposedTools(bindings) {
    const builtin = [];
    const exposed = [];
    for (const b of Object.values(bindings)) {
        if (!b)
            continue;
        if (b.kind === "builtin") {
            for (const t of b.tools) {
                builtin.push(t);
                exposed.push(t);
            }
        }
        else if (b.kind === "mcp") {
            for (const t of b.tools)
                exposed.push(`mcp__${b.server}__${t}`);
        }
        // internal_adapter / cli는 모델 도구로 노출되지 않음
    }
    return { exposed: [...new Set(exposed)], builtin: [...new Set(builtin)] };
}
/**
 * [V3 M7 T5] **도구 예산 상한.** tool/MCP는 등록만으로 컨텍스트를 상시 소모한다 — 관례가 아니라
 * 코드 상수 + fail-closed로 막는다.
 *
 * 근거는 **우리 profile 실측**이다(외부 문서 수치를 그대로 쓰지 않는다). 2026-08-12 `registry/tool_profiles.json`
 * 측정: `planning-none` 0서버/0도구 · `planning-local-readonly` 0서버/3도구 · `handoff-shadcn-readonly`
 * **1서버/5도구**(선언 855 bytes). 즉 현재 최대는 1서버·5도구이고 상한은 그 위 여유분이다.
 *
 * **정직한 한계**: 도구 1개가 실제로 먹는 **토큰** 비용은 upstream 서버가 소유한 inputSchema에 달려 있어
 * offline에서 측정하지 못했다(측정하려면 실제 MCP 서버 기동이 필요하다). 그래서 상한의 단위는
 * "우리가 선언한 개수"이며, 토큰 단위 재측정은 live 실행이 있는 slice에서 한다.
 */
export const MAX_MCP_SERVERS_PER_PROFILE = 3;
export const MAX_EXPOSED_TOOLS_PER_PROFILE = 16;
// ── 시맨틱 validator ─────────────────────────────────────────────
function validateSemantics(p) {
    // 1) capability 3계층: deny/reserved/unknown 거부
    for (const c of p.capabilities) {
        const tier = capabilityTier(c);
        if (tier === "deny")
            throw new ToolProfileError(`profile '${p.id}': deny capability '${c}' 금지 — 로드 거부`);
        if (tier === "reserved")
            throw new ToolProfileError(`profile '${p.id}': reserved capability '${c}'는 활성 마일스톤 전 사용 불가`);
        if (tier === "unknown")
            throw new ToolProfileError(`profile '${p.id}': 알 수 없는 capability '${c}'`);
    }
    // 2) 선언된 각 capability는 binding을 가져야 하고, 반대로 orphan binding 금지
    for (const c of p.capabilities) {
        if (!p.bindings[c])
            throw new ToolProfileError(`profile '${p.id}': capability '${c}'의 binding 누락`);
    }
    for (const c of Object.keys(p.bindings)) {
        if (!p.capabilities.includes(c))
            throw new ToolProfileError(`profile '${p.id}': binding '${c}'에 대응하는 capability 선언 없음`);
    }
    // 3) secretRef 형식 (redact의 Error를 로더 일관 타입으로 감싼다)
    try {
        assertValidSecretRefs(p.secretRefs, p.id);
    }
    catch (e) {
        throw new ToolProfileError(e.message);
    }
    // 4) 집합 관계 (exposed는 binding에서 파생)
    const { exposed } = deriveExposedTools(p.bindings);
    // 4-1) [M7 T5] 도구 예산 상한 — 초과 등록은 로드 자체가 실패한다(fail-closed).
    if (p.servers.length > MAX_MCP_SERVERS_PER_PROFILE) {
        throw new ToolProfileError(`profile '${p.id}': MCP 서버 ${p.servers.length}개는 예산 상한 ${MAX_MCP_SERVERS_PER_PROFILE}개를 넘는다`);
    }
    if (exposed.length > MAX_EXPOSED_TOOLS_PER_PROFILE) {
        throw new ToolProfileError(`profile '${p.id}': 노출 도구 ${exposed.length}개는 예산 상한 ${MAX_EXPOSED_TOOLS_PER_PROFILE}개를 넘는다`);
    }
    const exposedSet = new Set(exposed);
    for (const t of p.preapprovedTools) {
        if (!exposedSet.has(t))
            throw new ToolProfileError(`profile '${p.id}': preapprovedTool '${t}'가 노출 도구(exposed)에 없음`);
    }
    for (const d of p.deniedTools) {
        if (exposedSet.has(d))
            throw new ToolProfileError(`profile '${p.id}': deniedTool '${d}'가 노출 도구와 충돌`);
    }
}
/** 원시 JSON({profiles:[...]}) 또는 배열을 검증된 ToolProfile[]로 파싱한다. 위반 시 throw. */
export function parseToolProfiles(raw) {
    const list = Array.isArray(raw) ? raw : raw?.profiles;
    if (!Array.isArray(list))
        throw new ToolProfileError("tool_profiles: { profiles: [...] } 형태 필요");
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const p = validateStructure(item);
        validateSemantics(p);
        if (seen.has(p.id))
            throw new ToolProfileError(`중복 profile id: ${p.id}`);
        seen.add(p.id);
        out.push(p);
    }
    return out;
}
/**
 * profile이 MCP binding을 포함하는지. (loader/compile은 MCP를 거부하지 않는다 — M3가 로드해야 함.
 * 단 현재 runWorkflow 실행 경로는 MCP per-tool 강제가 없어 이 술어로 fail-closed 한다.)
 */
export function hasMcpBinding(profile) {
    return Object.values(profile.bindings).some((b) => b?.kind === "mcp");
}
const DEFAULT_PROFILES_PATH = () => fromPackage("registry", "tool_profiles.json");
/** 파일에서 profile을 로드·검증해 Map<id, ToolProfile>로 반환한다. */
export function loadToolProfiles(path = DEFAULT_PROFILES_PATH()) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const profiles = parseToolProfiles(raw);
    return new Map(profiles.map((p) => [p.id, p]));
}
// ── compile: profile → 실행 정책 ────────────────────────────────
function permissionModeFlag(mode) {
    switch (mode) {
        case "read_only": return "plan";
        case "dev_write": return "acceptEdits";
        case "approval_write": return "default";
    }
}
/**
 * ToolProfile을 실행 정책(CompiledToolPolicy)으로 변환한다.
 *  - exposedTools/builtinTools는 bindings에서 파생
 *  - opts.bare      : planning 격리(--strict-mcp-config + 내장도구 제한)
 *  - opts.mcpConfigPath: 지정 시 strict empty profile fallback argv(--mcp-config <path>)
 */
export function compileToolProfile(profile, opts = {}) {
    const { exposed, builtin } = deriveExposedTools(profile.bindings);
    const allowTools = [...profile.preapprovedTools];
    const denyTools = [...profile.deniedTools];
    const mcpConfig = profile.servers.length > 0
        ? { mcpServers: Object.fromEntries(profile.servers.map((s) => [s.name, {}])) }
        : opts.mcpConfigPath
            ? { mcpServers: {} } // strict empty profile fallback
            : null;
    const claudeArgs = [];
    if (opts.bare || opts.mcpConfigPath)
        claudeArgs.push("--strict-mcp-config");
    if (opts.mcpConfigPath)
        claudeArgs.push("--mcp-config", opts.mcpConfigPath);
    // 내장 도구 노출 제한 (--tools). bare 문서 agent는 "" (내장 없음).
    claudeArgs.push("--tools", builtin.join(","));
    claudeArgs.push("--permission-mode", permissionModeFlag(profile.permissionMode));
    if (allowTools.length)
        claudeArgs.push("--allowedTools", allowTools.join(","));
    if (denyTools.length)
        claudeArgs.push("--disallowedTools", denyTools.join(","));
    return {
        profileId: profile.id,
        exposedTools: exposed,
        builtinTools: builtin,
        allowTools,
        denyTools,
        hookRules: [], // 인자 조건부 deny는 M3+에서 채움
        mcpConfig,
        claudeArgs,
        adapterPolicy: { allowedDomains: profile.allowedDomains, limits: profile.limits },
        redactNames: [...profile.secretRefs],
        bindings: profile.bindings,
        permissionMode: profile.permissionMode,
    };
}
/**
 * compiled policy의 binding을 실행 주체별로 검증한다 (첫 모델 호출 전).
 *  - builtin          → provider가 내장 도구 지원?
 *  - mcp              → provider가 MCP(local/remote) 지원?
 *  - internal_adapter → 하네스 Adapter Registry에 등록?
 *  - cli              → 실행 환경에 command 존재?
 * 미충족 시 throw (근거 없는 모델 지식 폴백 방지).
 */
export function assertPolicyExecutable(policy, ctx) {
    const commandAvailable = ctx.commandAvailable ?? (() => false);
    for (const [cap, b] of Object.entries(policy.bindings)) {
        if (!b)
            continue;
        switch (b.kind) {
            case "builtin":
                if (!ctx.provider.builtinTools)
                    throw new ToolProfileError(`fail-fast: capability '${cap}'는 내장 도구를 쓰지만 provider가 미지원`);
                break;
            case "mcp":
                if (!(ctx.provider.localMcp || ctx.provider.remoteMcp))
                    throw new ToolProfileError(`fail-fast: capability '${cap}'는 MCP를 쓰지만 provider가 미지원`);
                break;
            case "internal_adapter":
                if (!adapterAvailable(b.adapter, ctx.adapters))
                    throw new ToolProfileError(`fail-fast: capability '${cap}'의 내부 어댑터 '${b.adapter}'가 미등록`);
                break;
            case "cli":
                if (!commandAvailable(b.command))
                    throw new ToolProfileError(`fail-fast: capability '${cap}'의 CLI '${b.command}'를 실행 환경에서 찾을 수 없음`);
                break;
        }
    }
}
