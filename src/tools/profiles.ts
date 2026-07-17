import { readFileSync } from "node:fs";
import { fromPackage } from "../core/paths.js";
import {
  capabilityTier,
  type ToolBinding,
  type ToolCapability,
} from "./capabilities.js";
import { assertValidSecretRefs } from "./redact.js";
import { adapterAvailable } from "./adapters.js";
import type { ProviderCapabilities } from "../providers/capabilities.js";

/**
 * ToolProfile: capability 기반 도구 정책 (V3 MCP M2, §3.3).
 *
 * exposedTools는 입력이 아니라 bindings에서 compile이 자동 파생한다:
 *   - builtin binding의 tools → 그대로 노출 (모델이 보는 내장 도구)
 *   - mcp binding의 tools → `mcp__<server>__<tool>` 형태로 노출
 *   - internal_adapter / cli binding → 모델에 직접 노출되는 도구가 아님 (하네스/레포 측 실행)
 *
 * preapprovedTools = 노출 도구 중 승인 없이 자동 실행할 도구 (⊆ exposed).
 * deniedTools      = 명시 차단 도구.
 *
 * JSON schema 검증은 신규 런타임 의존성 없이 수동 validator로 한다.
 * schemas/tool_profile.schema.json은 계약 문서 + 향후 정식 validator용으로만 유지(실행 안 함).
 */

export type PermissionMode = "read_only" | "dev_write" | "approval_write";

export interface McpServerDecl {
  name: string;
  // M3에서 command/args/url/transport/env 확장. planning plane은 servers:[]라 M2엔 미사용.
  command?: string;
  args?: string[];
  url?: string;
  transport?: "stdio" | "http";
}

export interface ToolProfile {
  id: string;
  capabilities: ToolCapability[];
  bindings: Partial<Record<ToolCapability, ToolBinding>>;
  servers: McpServerDecl[];
  preapprovedTools: string[];
  deniedTools: string[];
  permissionMode: PermissionMode;
  allowedDomains: string[] | null;
  limits: { maxCallsPerStep: number; maxResultChars: number; maxElapsedMsPerCall: number };
  secretRefs: string[];
  source?: "official" | "vendor" | "community";
}

/** 인자 조건부 deny 규칙 (PreToolUse Hook로 컴파일 — M2는 산출만, 실행 M3+). */
export interface HookRule {
  tool: string;
  denyWhen: string;
}

export interface CompiledToolPolicy {
  profileId: string;
  exposedTools: string[]; // bindings에서 파생 (builtin ∪ mcp)
  builtinTools: string[]; // → claude --tools
  allowTools: string[]; // preapproved → --allowedTools / permissions allow
  denyTools: string[]; // deniedTools → --disallowedTools / permissions deny
  hookRules: HookRule[]; // 인자 조건부 deny (PreToolUse) — 산출만
  mcpConfig: { mcpServers: Record<string, unknown> } | null; // servers → 생성될 config (write·전달 M3)
  claudeArgs: string[]; // profile → claude CLI 플래그
  adapterPolicy: { allowedDomains: string[] | null; limits: ToolProfile["limits"] };
  redactNames: string[];
  bindings: Partial<Record<ToolCapability, ToolBinding>>;
  permissionMode: PermissionMode;
}

export class ToolProfileError extends Error {}

// ── 수동 구조 validator ──────────────────────────────────────────
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateBinding(cap: string, b: unknown, id: string): ToolBinding {
  if (!b || typeof b !== "object") throw new ToolProfileError(`profile '${id}': binding '${cap}'이 객체가 아님`);
  const kind = (b as { kind?: unknown }).kind;
  switch (kind) {
    case "builtin":
      if (!isStrArray((b as { tools?: unknown }).tools)) throw new ToolProfileError(`profile '${id}': builtin binding '${cap}'에 tools[] 필요`);
      return b as ToolBinding;
    case "mcp": {
      const mb = b as { server?: unknown; tools?: unknown };
      if (typeof mb.server !== "string" || !isStrArray(mb.tools))
        throw new ToolProfileError(`profile '${id}': mcp binding '${cap}'에 server, tools[] 필요`);
      return b as ToolBinding;
    }
    case "internal_adapter": {
      const ab = b as { adapter?: unknown; operations?: unknown };
      if (typeof ab.adapter !== "string" || !isStrArray(ab.operations))
        throw new ToolProfileError(`profile '${id}': internal_adapter binding '${cap}'에 adapter, operations[] 필요`);
      return b as ToolBinding;
    }
    case "cli": {
      const cb = b as { command?: unknown; operations?: unknown };
      if (typeof cb.command !== "string" || (cb.operations !== undefined && !isStrArray(cb.operations)))
        throw new ToolProfileError(`profile '${id}': cli binding '${cap}'에 command(문자열) 필요`);
      return b as ToolBinding;
    }
    default:
      throw new ToolProfileError(`profile '${id}': binding '${cap}'의 kind가 유효하지 않음: ${String(kind)}`);
  }
}

function validateStructure(raw: unknown): ToolProfile {
  if (!raw || typeof raw !== "object") throw new ToolProfileError("profile이 객체가 아님");
  const p = raw as Record<string, unknown>;
  const id = p.id;
  if (typeof id !== "string" || !id) throw new ToolProfileError("profile.id(문자열) 필요");
  if (!isStrArray(p.capabilities)) throw new ToolProfileError(`profile '${id}': capabilities[] 필요`);
  if (!p.bindings || typeof p.bindings !== "object") throw new ToolProfileError(`profile '${id}': bindings 객체 필요`);
  if (!Array.isArray(p.servers)) throw new ToolProfileError(`profile '${id}': servers[] 필요`);
  if (!isStrArray(p.preapprovedTools)) throw new ToolProfileError(`profile '${id}': preapprovedTools[] 필요`);
  if (!isStrArray(p.deniedTools)) throw new ToolProfileError(`profile '${id}': deniedTools[] 필요`);
  if (!["read_only", "dev_write", "approval_write"].includes(p.permissionMode as string))
    throw new ToolProfileError(`profile '${id}': permissionMode는 read_only|dev_write|approval_write`);
  if (p.allowedDomains !== null && !isStrArray(p.allowedDomains))
    throw new ToolProfileError(`profile '${id}': allowedDomains는 null 또는 string[]`);
  const lim = p.limits as Record<string, unknown> | undefined;
  if (!lim || typeof lim.maxCallsPerStep !== "number" || typeof lim.maxResultChars !== "number" || typeof lim.maxElapsedMsPerCall !== "number")
    throw new ToolProfileError(`profile '${id}': limits(maxCallsPerStep/maxResultChars/maxElapsedMsPerCall 숫자) 필요`);
  if (!isStrArray(p.secretRefs)) throw new ToolProfileError(`profile '${id}': secretRefs[] 필요`);

  const bindings: Partial<Record<ToolCapability, ToolBinding>> = {};
  for (const [cap, b] of Object.entries(p.bindings as Record<string, unknown>)) {
    bindings[cap as ToolCapability] = validateBinding(cap, b, id);
  }
  return {
    id,
    capabilities: p.capabilities as ToolCapability[],
    bindings,
    servers: p.servers as McpServerDecl[],
    preapprovedTools: p.preapprovedTools,
    deniedTools: p.deniedTools,
    permissionMode: p.permissionMode as PermissionMode,
    allowedDomains: (p.allowedDomains as string[] | null) ?? null,
    limits: p.limits as ToolProfile["limits"],
    secretRefs: p.secretRefs,
    source: p.source as ToolProfile["source"],
  };
}

/** binding들에서 모델에 노출될 도구 목록을 파생한다 (builtin ∪ mcp). */
export function deriveExposedTools(bindings: Partial<Record<ToolCapability, ToolBinding>>): {
  exposed: string[];
  builtin: string[];
} {
  const builtin: string[] = [];
  const exposed: string[] = [];
  for (const b of Object.values(bindings)) {
    if (!b) continue;
    if (b.kind === "builtin") {
      for (const t of b.tools) {
        builtin.push(t);
        exposed.push(t);
      }
    } else if (b.kind === "mcp") {
      for (const t of b.tools) exposed.push(`mcp__${b.server}__${t}`);
    }
    // internal_adapter / cli는 모델 도구로 노출되지 않음
  }
  return { exposed: [...new Set(exposed)], builtin: [...new Set(builtin)] };
}

// ── 시맨틱 validator ─────────────────────────────────────────────
function validateSemantics(p: ToolProfile): void {
  // 1) capability 3계층: deny/reserved/unknown 거부
  for (const c of p.capabilities) {
    const tier = capabilityTier(c);
    if (tier === "deny") throw new ToolProfileError(`profile '${p.id}': deny capability '${c}' 금지 — 로드 거부`);
    if (tier === "reserved") throw new ToolProfileError(`profile '${p.id}': reserved capability '${c}'는 활성 마일스톤 전 사용 불가`);
    if (tier === "unknown") throw new ToolProfileError(`profile '${p.id}': 알 수 없는 capability '${c}'`);
  }
  // 2) 선언된 각 capability는 binding을 가져야 하고, 반대로 orphan binding 금지
  for (const c of p.capabilities) {
    if (!p.bindings[c]) throw new ToolProfileError(`profile '${p.id}': capability '${c}'의 binding 누락`);
  }
  for (const c of Object.keys(p.bindings)) {
    if (!p.capabilities.includes(c as ToolCapability))
      throw new ToolProfileError(`profile '${p.id}': binding '${c}'에 대응하는 capability 선언 없음`);
  }
  // 3) secretRef 형식 (redact의 Error를 로더 일관 타입으로 감싼다)
  try {
    assertValidSecretRefs(p.secretRefs, p.id);
  } catch (e) {
    throw new ToolProfileError((e as Error).message);
  }
  // 4) 집합 관계 (exposed는 binding에서 파생)
  const { exposed } = deriveExposedTools(p.bindings);
  const exposedSet = new Set(exposed);
  for (const t of p.preapprovedTools) {
    if (!exposedSet.has(t)) throw new ToolProfileError(`profile '${p.id}': preapprovedTool '${t}'가 노출 도구(exposed)에 없음`);
  }
  for (const d of p.deniedTools) {
    if (exposedSet.has(d)) throw new ToolProfileError(`profile '${p.id}': deniedTool '${d}'가 노출 도구와 충돌`);
  }
}

/** 원시 JSON({profiles:[...]}) 또는 배열을 검증된 ToolProfile[]로 파싱한다. 위반 시 throw. */
export function parseToolProfiles(raw: unknown): ToolProfile[] {
  const list = Array.isArray(raw) ? raw : (raw as { profiles?: unknown })?.profiles;
  if (!Array.isArray(list)) throw new ToolProfileError("tool_profiles: { profiles: [...] } 형태 필요");
  const out: ToolProfile[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const p = validateStructure(item);
    validateSemantics(p);
    if (seen.has(p.id)) throw new ToolProfileError(`중복 profile id: ${p.id}`);
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

const DEFAULT_PROFILES_PATH = () => fromPackage("registry", "tool_profiles.json");

/** 파일에서 profile을 로드·검증해 Map<id, ToolProfile>로 반환한다. */
export function loadToolProfiles(path: string = DEFAULT_PROFILES_PATH()): Map<string, ToolProfile> {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const profiles = parseToolProfiles(raw);
  return new Map(profiles.map((p) => [p.id, p]));
}

// ── compile: profile → 실행 정책 ────────────────────────────────
function permissionModeFlag(mode: PermissionMode): string {
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
export function compileToolProfile(
  profile: ToolProfile,
  opts: { bare?: boolean; mcpConfigPath?: string } = {},
): CompiledToolPolicy {
  const { exposed, builtin } = deriveExposedTools(profile.bindings);
  const allowTools = [...profile.preapprovedTools];
  const denyTools = [...profile.deniedTools];

  const mcpConfig =
    profile.servers.length > 0
      ? { mcpServers: Object.fromEntries(profile.servers.map((s) => [s.name, {}])) }
      : opts.mcpConfigPath
        ? { mcpServers: {} } // strict empty profile fallback
        : null;

  const claudeArgs: string[] = [];
  if (opts.bare || opts.mcpConfigPath) claudeArgs.push("--strict-mcp-config");
  if (opts.mcpConfigPath) claudeArgs.push("--mcp-config", opts.mcpConfigPath);
  // 내장 도구 노출 제한 (--tools). bare 문서 agent는 "" (내장 없음).
  claudeArgs.push("--tools", builtin.join(","));
  claudeArgs.push("--permission-mode", permissionModeFlag(profile.permissionMode));
  if (allowTools.length) claudeArgs.push("--allowedTools", allowTools.join(","));
  if (denyTools.length) claudeArgs.push("--disallowedTools", denyTools.join(","));

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

// ── binding 기반 fail-fast ───────────────────────────────────────
export interface PolicyExecContext {
  provider: ProviderCapabilities;
  adapters?: ReadonlySet<string>; // 미지정 시 KNOWN_ADAPTERS
  commandAvailable?: (command: string) => boolean; // cli binding 검사
}

/**
 * compiled policy의 binding을 실행 주체별로 검증한다 (첫 모델 호출 전).
 *  - builtin          → provider가 내장 도구 지원?
 *  - mcp              → provider가 MCP(local/remote) 지원?
 *  - internal_adapter → 하네스 Adapter Registry에 등록?
 *  - cli              → 실행 환경에 command 존재?
 * 미충족 시 throw (근거 없는 모델 지식 폴백 방지).
 */
export function assertPolicyExecutable(policy: CompiledToolPolicy, ctx: PolicyExecContext): void {
  const commandAvailable = ctx.commandAvailable ?? (() => false);
  for (const [cap, b] of Object.entries(policy.bindings)) {
    if (!b) continue;
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
