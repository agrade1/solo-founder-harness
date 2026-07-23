import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ToolProfile, McpServerDecl } from "../tools/profiles.js";
import { collectSecretValues } from "../tools/redact.js";

/**
 * [M3a] profile의 MCP binding·servers 선언을 검증해 실행별 mcp-config를 생성한다.
 *  - 선언된(그리고 binding이 참조하는) 서버만 포함.
 *  - transport는 stdio/http만. stdio=command(+args), http=HTTPS url. 혼합 금지.
 *  - npx 실행은 정확히 고정된 버전(pkg@1.2.3)만 허용 (@latest/@next/범위/무버전 거부).
 *  - secret 실제 값이 command/args/url에 있으면 기록 전 거부. credential 형태 인자/쿼리 거부.
 *  - 같은 mcp__server__tool이 중복 파생되면 거부(조용한 dedupe 금지).
 *  - 각 서버 preflight용 alwaysLoad:true. secret 값은 config에 기록하지 않는다.
 *
 * 실제 claude 실행·격리 강제는 preflight(runPreflight)가 담당. 여기선 config 산출만.
 */

export class McpConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "McpConfigError";
    this.code = code;
  }
}

interface StdioEntry {
  command: string;
  args: string[];
  alwaysLoad: true;
}
interface HttpEntry {
  type: "http";
  url: string;
  alwaysLoad: true;
}
type ServerEntry = StdioEntry | HttpEntry;

export interface McpConfigResult {
  config: { mcpServers: Record<string, ServerEntry> };
  expectedServers: string[]; // 정렬
  expectedTools: string[]; // 정렬, mcp__server__tool
}

// 정확한 고정 버전만 허용: (@scope/)name@X.Y.Z(-prerelease)?(+build)?
const PINNED_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// credential 형태 (key/token/secret/password 등 = 값)
const CREDENTIAL_KV = /(?:api[_-]?key|apikey|access[_-]?token|token|secret|password|credential|pwd)=/i;

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
function isNpx(command: string): boolean {
  return basename(command) === "npx";
}
function containsLatest(parts: string[]): boolean {
  return parts.some((p) => /@latest\b/.test(p));
}

/** npx args에서 실행 package 토큰을 추출한다 (-p/--package 값 + 첫 실행 대상). */
function npxPackageTokens(args: string[]): string[] {
  const pkgs: string[] = [];
  let runTargetSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--package=")) {
      pkgs.push(a.slice("--package=".length));
      continue;
    }
    if (a === "-p" || a === "--package") {
      if (i + 1 < args.length) {
        pkgs.push(args[i + 1]);
        i++;
      }
      continue;
    }
    if (a.startsWith("-")) continue; // 불리언 플래그
    if (!runTargetSeen) {
      pkgs.push(a); // 첫 비플래그 = 실행 대상 package. 이후 bare 인자는 프로그램 인자
      runTargetSeen = true;
    }
  }
  return pkgs;
}

/** command/args/url 문자열에 secret 실제 값이 포함되면 거부 (값은 오류에 표시하지 않음). */
function assertNoSecretValue(parts: string[], name: string, secretValues: string[]): void {
  for (const v of secretValues) {
    if (v && parts.some((p) => p.includes(v))) {
      throw new McpConfigError("secret_in_config", `서버 '${name}': secret 값이 command/args/url에 포함됨 (값은 표시하지 않음).`);
    }
  }
}

/** 서버 하나를 config 엔트리로 컴파일한다 (전송·pin·secret·credential 검증 포함). */
function compileServer(name: string, decl: McpServerDecl, secretValues: string[]): ServerEntry {
  const transport = decl.transport ?? (decl.url ? "http" : "stdio");
  if (transport !== "stdio" && transport !== "http") {
    throw new McpConfigError("bad_transport", `서버 '${name}': transport는 stdio|http만 허용됩니다.`);
  }

  if (transport === "http") {
    if (decl.command || (decl.args && decl.args.length > 0)) {
      throw new McpConfigError("mixed_transport", `서버 '${name}': http 서버에 command/args를 둘 수 없습니다.`);
    }
    const url = decl.url ?? "";
    if (!/^https:\/\//.test(url)) {
      throw new McpConfigError("bad_url", `서버 '${name}': http 전송은 HTTPS url이 필요합니다.`);
    }
    if (CREDENTIAL_KV.test(url)) {
      throw new McpConfigError("credential_in_config", `서버 '${name}': url query에 credential 형태(key/token/...=) 금지.`);
    }
    assertNoSecretValue([url], name, secretValues);
    return { type: "http", url, alwaysLoad: true };
  }

  // stdio
  if (decl.url) {
    throw new McpConfigError("mixed_transport", `서버 '${name}': stdio 서버에 url을 둘 수 없습니다.`);
  }
  const command = decl.command ?? "";
  const args = decl.args ?? [];
  if (!command) {
    throw new McpConfigError("bad_command", `서버 '${name}': stdio 전송은 command가 필요합니다.`);
  }
  if (containsLatest([command, ...args])) {
    throw new McpConfigError("latest_forbidden", `서버 '${name}': @latest 금지 — 버전을 pin 하세요.`);
  }
  // npx는 정확한 고정 버전 package만 허용 (일반 node/local executable엔 미적용).
  if (isNpx(command)) {
    const pkgs = npxPackageTokens(args);
    if (pkgs.length === 0) {
      throw new McpConfigError("npx_no_package", `서버 '${name}': npx로 실행할 package가 없습니다.`);
    }
    for (const p of pkgs) {
      if (!PINNED_SPEC.test(p)) {
        throw new McpConfigError(
          "unpinned_npx",
          `서버 '${name}': npx package는 정확한 고정 버전이어야 합니다 (예: pkg@1.2.3, @scope/pkg@1.2.3).`,
        );
      }
    }
  }
  if (args.some((a) => CREDENTIAL_KV.test(a))) {
    throw new McpConfigError("credential_in_config", `서버 '${name}': args에 credential 형태(key/token/...=) 금지.`);
  }
  assertNoSecretValue([command, ...args], name, secretValues);
  return { command, args, alwaysLoad: true };
}

/** profile.servers → name으로 색인. 중복 이름은 거부. */
function indexServers(servers: McpServerDecl[]): Map<string, McpServerDecl> {
  const m = new Map<string, McpServerDecl>();
  for (const s of servers) {
    if (!s || typeof s.name !== "string" || !s.name) {
      throw new McpConfigError("bad_server", "servers 선언에 name이 없습니다.");
    }
    if (m.has(s.name)) {
      throw new McpConfigError("duplicate_server", `servers에 중복된 서버 이름: '${s.name}'`);
    }
    m.set(s.name, s);
  }
  return m;
}

/**
 * profile에서 mcp-config와 기대 서버/도구 목록을 산출한다 (순수, 파일 미기록).
 * binding.server가 servers에 없으면 거부. 중복 파생 도구는 거부(조용한 dedupe 금지).
 * secretValues 미지정 시 profile.secretRefs로부터 process.env에서 조회.
 */
export function buildMcpConfig(
  profile: ToolProfile,
  secretValues: string[] = collectSecretValues(profile.secretRefs),
): McpConfigResult {
  const serverIndex = indexServers(profile.servers);
  const referenced = new Map<string, ServerEntry>();
  const expectedTools: string[] = [];
  const toolSet = new Set<string>();

  for (const [cap, binding] of Object.entries(profile.bindings)) {
    if (!binding || binding.kind !== "mcp") continue;
    const decl = serverIndex.get(binding.server);
    if (!decl) {
      throw new McpConfigError(
        "unknown_binding_server",
        `capability '${cap}'의 binding server '${binding.server}'가 servers 선언에 없습니다.`,
      );
    }
    if (!referenced.has(binding.server)) {
      referenced.set(binding.server, compileServer(binding.server, decl, secretValues));
    }
    for (const t of binding.tools) {
      const full = `mcp__${binding.server}__${t}`;
      if (toolSet.has(full)) {
        throw new McpConfigError("duplicate_tool", `중복 파생 도구: '${full}' (조용한 dedupe 금지).`);
      }
      toolSet.add(full);
      expectedTools.push(full);
    }
  }

  if (referenced.size === 0) {
    throw new McpConfigError("no_mcp_binding", "profile에 mcp binding이 없어 preflight 대상이 아닙니다.");
  }

  const mcpServers: Record<string, ServerEntry> = {};
  for (const name of [...referenced.keys()].sort()) mcpServers[name] = referenced.get(name)!;

  return {
    config: { mcpServers },
    expectedServers: [...referenced.keys()].sort(),
    expectedTools: expectedTools.sort(),
  };
}

export interface WrittenMcpConfig extends McpConfigResult {
  configPath: string;
  configHash: string; // sha256(파일 바이트)
}

/** buildMcpConfig 결과를 runtimeDir/mcp-config.json에 기록하고 sha256 해시를 계산한다. */
export function writeMcpConfig(profile: ToolProfile, runtimeDir: string): WrittenMcpConfig {
  const built = buildMcpConfig(profile);
  mkdirSync(runtimeDir, { recursive: true });
  const configPath = join(runtimeDir, "mcp-config.json");
  const bytes = JSON.stringify(built.config, null, 2) + "\n";
  writeFileSync(configPath, bytes, "utf8");
  const configHash = createHash("sha256").update(bytes).digest("hex");
  return { ...built, configPath, configHash };
}
