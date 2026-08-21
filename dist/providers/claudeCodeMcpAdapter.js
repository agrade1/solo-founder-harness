import { writeFileSync, mkdirSync, lstatSync, accessSync, constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TRUSTED_LAUNCHER_IDS } from "../tools/profiles.js";
import { collectSecretValues } from "../tools/redact.js";
import { fromPackage } from "../core/paths.js";
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
    code;
    constructor(code, message) {
        super(message);
        this.name = "McpConfigError";
        this.code = code;
    }
}
// 정확한 고정 버전만 허용: (@scope/)name@X.Y.Z(-prerelease)?(+build)?
const PINNED_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// credential 형태 (key/token/secret/password 등 = 값)
const CREDENTIAL_KV = /(?:api[_-]?key|apikey|access[_-]?token|token|secret|password|credential|pwd)=/i;
/**
 * [M3c-3b] runtime config 생성에서만 허용되는 신뢰된 launcher 식별자.
 * registry에는 launcher 논리 식별자만 있고, 여기서 **고정** node + 절대 proxy 경로로만 변환한다.
 * 실행 경로는 외부 인자·환경변수·profile·test seam으로 변경할 수 없다(원본 `npx shadcn` 직접 실행 없음).
 */
// 신뢰 launcher 목록은 profiles.ts(TRUSTED_LAUNCHER_IDS) 단일 출처를 사용한다(중복 Set 제거).
function isTrustedLauncher(v) {
    return TRUSTED_LAUNCHER_IDS.includes(v);
}
/** shadcn_read_proxy의 고정 스크립트 경로(override 불가). */
function trustedLauncherPath() {
    return fromPackage("dist", "tools", "shadcnReadMcpProxy.js");
}
/**
 * 신뢰된 proxy 스크립트 파일 검증(config 기록 전). **lstat 기반 — symlink 거부**, 일반 파일만, 읽기 가능.
 * 실행 경로 자체는 trustedLauncherPath()로 고정된다. 이 함수는 주어진 경로의 파일 상태만 검증하며,
 * 임의 경로를 generated config에 넣는 공개 API가 아니다(테스트는 이 검증 함수만 임시 경로로 호출).
 */
export function verifyTrustedProxyFile(scriptPath) {
    let st;
    try {
        st = lstatSync(scriptPath); // symlink을 따라가지 않는다
    }
    catch {
        throw new McpConfigError("launcher_proxy_missing", `신뢰된 proxy 파일이 없습니다: ${scriptPath} ('npm run build' 후 다시 시도).`);
    }
    if (st.isSymbolicLink())
        throw new McpConfigError("launcher_proxy_symlink", `신뢰된 proxy 경로가 symlink입니다(거부): ${scriptPath}`);
    if (!st.isFile())
        throw new McpConfigError("launcher_proxy_not_file", `신뢰된 proxy 경로가 일반 파일이 아닙니다(디렉터리/특수): ${scriptPath}`);
    try {
        accessSync(scriptPath, fsConstants.R_OK);
    }
    catch {
        throw new McpConfigError("launcher_proxy_unreadable", `신뢰된 proxy 파일을 읽을 수 없습니다: ${scriptPath}`);
    }
}
/** launcher 서버를 node + **고정** 절대 proxy 경로 stdio 엔트리로 변환한다(경로 override 불가). */
function compileLauncherServer(name, decl, secretValues) {
    // args는 빈 배열이어도 존재 자체를 거부한다(decl.args !== undefined).
    if (decl.command !== undefined || decl.args !== undefined || decl.url !== undefined || decl.transport !== undefined) {
        throw new McpConfigError("mixed_launcher", `서버 '${name}': launcher는 command/args/url/transport와 함께 쓸 수 없습니다.`);
    }
    if (!decl.launcher || !isTrustedLauncher(decl.launcher)) {
        throw new McpConfigError("unknown_launcher", `서버 '${name}': 알 수 없는 launcher '${decl.launcher}' — 신뢰된 launcher만 허용됩니다.`);
    }
    const scriptPath = trustedLauncherPath(); // 고정 경로 — 외부에서 바꿀 수 없음
    verifyTrustedProxyFile(scriptPath);
    const command = process.execPath;
    const args = [scriptPath];
    assertNoSecretValue([command, ...args], name, secretValues);
    // launcher 논리 필드는 생성된 config에 남기지 않는다 — 표준 stdio 엔트리만.
    return { command, args, alwaysLoad: true };
}
function basename(p) {
    return p.split(/[\\/]/).pop() ?? p;
}
function isNpx(command) {
    return basename(command) === "npx";
}
function containsLatest(parts) {
    return parts.some((p) => /@latest\b/.test(p));
}
/** npx args에서 실행 package 토큰을 추출한다 (-p/--package 값 + 첫 실행 대상). */
function npxPackageTokens(args) {
    const pkgs = [];
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
        if (a.startsWith("-"))
            continue; // 불리언 플래그
        if (!runTargetSeen) {
            pkgs.push(a); // 첫 비플래그 = 실행 대상 package. 이후 bare 인자는 프로그램 인자
            runTargetSeen = true;
        }
    }
    return pkgs;
}
/** command/args/url 문자열에 secret 실제 값이 포함되면 거부 (값은 오류에 표시하지 않음). */
function assertNoSecretValue(parts, name, secretValues) {
    for (const v of secretValues) {
        if (v && parts.some((p) => p.includes(v))) {
            throw new McpConfigError("secret_in_config", `서버 '${name}': secret 값이 command/args/url에 포함됨 (값은 표시하지 않음).`);
        }
    }
}
/** 서버 하나를 config 엔트리로 컴파일한다 (launcher / 전송·pin·secret·credential 검증 포함). */
function compileServer(name, decl, secretValues) {
    // [M3c-3b] launcher 선언이면 신뢰된 launcher만 고정 node + 절대 proxy 경로로 변환한다.
    if (decl.launcher !== undefined) {
        return compileLauncherServer(name, decl, secretValues);
    }
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
                throw new McpConfigError("unpinned_npx", `서버 '${name}': npx package는 정확한 고정 버전이어야 합니다 (예: pkg@1.2.3, @scope/pkg@1.2.3).`);
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
function indexServers(servers) {
    const m = new Map();
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
export function buildMcpConfig(profile, secretValues = collectSecretValues(profile.secretRefs)) {
    const serverIndex = indexServers(profile.servers);
    const referenced = new Map();
    const expectedTools = [];
    const toolSet = new Set();
    for (const [cap, binding] of Object.entries(profile.bindings)) {
        if (!binding || binding.kind !== "mcp")
            continue;
        const decl = serverIndex.get(binding.server);
        if (!decl) {
            throw new McpConfigError("unknown_binding_server", `capability '${cap}'의 binding server '${binding.server}'가 servers 선언에 없습니다.`);
        }
        // [M3c-3b 방어 심층화] launcher 서버는 secretRefs를 하나도 선언하면 안 된다 —
        // config·preflight·proxy spawn 이전에 fail-closed. (오류에 secret 값은 미노출.)
        if (decl.launcher !== undefined && profile.secretRefs.length > 0) {
            throw new McpConfigError("launcher_secret_refs_forbidden", `서버 '${binding.server}': launcher 서버는 secretRefs를 선언할 수 없습니다 (${profile.secretRefs.length}개 선언됨).`);
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
    const mcpServers = {};
    for (const name of [...referenced.keys()].sort())
        mcpServers[name] = referenced.get(name);
    return {
        config: { mcpServers },
        expectedServers: [...referenced.keys()].sort(),
        expectedTools: expectedTools.sort(),
    };
}
/** buildMcpConfig 결과를 runtimeDir/mcp-config.json에 기록하고 sha256 해시를 계산한다. */
export function writeMcpConfig(profile, runtimeDir) {
    const built = buildMcpConfig(profile);
    return persistMcpConfig(built, runtimeDir);
}
/**
 * [M3b.2] 명시적 allow-empty 경로: MCP 서버가 하나도 없는 빈 config `{mcpServers:{}}`.
 * profile 기반 buildMcpConfig의 no_mcp_binding 기본 거부와 분리된 별도 경로다
 * (handoff 대화형 세션은 MCP 0개 + `--strict-mcp-config`로 ambient 격리를 실측한다).
 * expected 서버/도구는 모두 빈 배열 — preflight가 ambient 서버/도구를 하나라도 보면 실패한다.
 */
export function buildEmptyMcpConfig() {
    return { config: { mcpServers: {} }, expectedServers: [], expectedTools: [] };
}
/** buildEmptyMcpConfig 결과를 최소 권한(dir 0700 / file 0600)으로 기록한다. */
export function writeEmptyMcpConfig(runtimeDir) {
    return persistMcpConfig(buildEmptyMcpConfig(), runtimeDir);
}
/**
 * McpConfigResult를 runtimeDir/mcp-config.json에 최소 권한으로 기록하고 sha256을 계산한다.
 * exclusive-create(`wx`): 기존 파일·symlink를 조용히 덮어쓰지 않고 EEXIST로 fail-closed한다.
 */
function persistMcpConfig(built, runtimeDir) {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const configPath = join(runtimeDir, "mcp-config.json");
    const bytes = JSON.stringify(built.config, null, 2) + "\n";
    writeFileSync(configPath, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const configHash = createHash("sha256").update(bytes).digest("hex");
    return { ...built, configPath, configHash };
}
