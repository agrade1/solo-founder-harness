import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, rmSync, existsSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { writeMcpConfig, McpConfigError } from "../providers/claudeCodeMcpAdapter.js";
import { redactSecrets, collectSecretValues } from "./redact.js";
import { checkComponentsJson, shadcnDiscoveryProfile, SHADCN_PACKAGE, SHADCN_SERVER } from "./shadcnPilot.js";

/**
 * [V3 M3c-2] shadcn MCP **controlled read semantics probe** (offline scaffold).
 *
 * M3c-1에서 이름·schema를 확정한 7개 중 **읽기 후보 5개**만 고정 인자로 순차 tools/call해
 * (a) serviceCwd 무변경, (b) CallToolResult 계약, (c) 전체 결과 크기 budget(8,000 chars)을 **측정**한다.
 *
 * 경계:
 *  - 호출 계획·금지 목록·protocol allowlist는 **non-exported 내부 상수 + deep-freeze**다. 외부는 매번
 *    deep clone을 돌려주는 getter만 볼 수 있어 실행 계획을 변조할 수 없다. 시작 시 exact contract와 비교한다.
 *  - 금지 도구 2개(get_add_command_for_items, get_audit_checklist)는 tools/call 생성 경로가 없다.
 *  - 외부 결과는 untrusted data다 — 원문을 저장/출력/실행하지 않고 파생 지표만 남긴다.
 *  - profile 등록·handoff 연결·result-size enforcement를 하지 않는다(측정만).
 */

// ── deep-freeze 내부 상수 (외부 import 변조 불가) ─────────────────────────────
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o as Record<string, unknown>)) deepFreeze((o as Record<string, unknown>)[k]);
  }
  return o;
}

interface FixedCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 실행에 사용하는 고정 호출 계획(내부·frozen). 외부는 getSemanticsCalls() clone만 본다. */
const CALL_PLAN: readonly FixedCall[] = deepFreeze([
  { name: "get_project_registries", arguments: {} },
  { name: "list_items_in_registries", arguments: { registries: ["@shadcn"], types: ["ui"], limit: 1, offset: 0 } },
  { name: "search_items_in_registries", arguments: { registries: ["@shadcn"], query: "button", types: ["ui"], limit: 1, offset: 0 } },
  { name: "view_items_in_registries", arguments: { items: ["@shadcn/button"] } },
  { name: "get_item_examples_from_registries", arguments: { registries: ["@shadcn"], query: "button-demo" } },
] as FixedCall[]);

/** 호출·노출 후보 제외(내부·frozen). tools/call 생성 경로 없음. */
const FORBIDDEN_TOOLS: readonly string[] = deepFreeze(["get_add_command_for_items", "get_audit_checklist"]);
/** MCP protocol negotiation allowlist(내부·frozen). */
const ALLOWED_PROTOCOL_VERSIONS: readonly string[] = deepFreeze(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const REQUEST_PROTOCOL_VERSION = "2025-11-25";

/** 실측 확정 7개(namespaced, 내부·frozen). M3c-1의 가변 export에 의존하지 않는다. */
const EXPECTED_NS_TOOLS: readonly string[] = deepFreeze(
  ["get_add_command_for_items", "get_audit_checklist", "get_item_examples_from_registries", "get_project_registries", "list_items_in_registries", "search_items_in_registries", "view_items_in_registries"].map((n) => `mcp__${SHADCN_SERVER}__${n}`).sort(),
);

// 독립 리터럴 contract(시작 시 CALL_PLAN 자기검증용 — 소스 변조 방지 defense-in-depth).
const CONTRACT_NAMES: readonly string[] = ["get_project_registries", "list_items_in_registries", "search_items_in_registries", "view_items_in_registries", "get_item_examples_from_registries"];
const CONTRACT_ARGS: readonly Record<string, unknown>[] = [
  {},
  { registries: ["@shadcn"], types: ["ui"], limit: 1, offset: 0 },
  { registries: ["@shadcn"], query: "button", types: ["ui"], limit: 1, offset: 0 },
  { items: ["@shadcn/button"] },
  { registries: ["@shadcn"], query: "button-demo" },
];

// ── 공개 getter (매 호출 deep clone — 변조해도 내부 불변) ──────────────────────
export function getSemanticsCalls(): FixedCall[] {
  return CALL_PLAN.map((c) => ({ name: c.name, arguments: structuredClone(c.arguments) }));
}
export function getForbiddenCallTools(): Set<string> {
  return new Set(FORBIDDEN_TOOLS);
}
export function getAllowedProtocolVersions(): Set<string> {
  return new Set(ALLOWED_PROTOCOL_VERSIONS);
}

// 상한.
const PER_CALL_TIMEOUT_MS = 60_000;
const OVERALL_TIMEOUT_MS = 5 * 60_000;
const SINGLE_RESPONSE_CAP = 256 * 1024;
const STDOUT_CAP = 2 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;
const PROPOSED_BUDGET_CHARS = 8_000; // 측정만 — 초과해도 자르지 않고 withinProposedBudget:false
const MAX_PAGES = 8;
const MAX_TOOLS = 64;
const MAX_FS_ENTRIES = 10_000;
const MAX_FILE_BYTES = 1024 * 1024; // 파일별 read 상한
const MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024; // 전체 read 상한
const CLOSE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;

const ENV_ALLOWLIST = ["PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"]; // HOME/cache는 임시 경로 override

export class ShadcnReadSemanticsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShadcnReadSemanticsError";
    this.code = code;
  }
}

export interface ReadSemanticsCall {
  toolName: string;
  argumentsHash: string;
  elapsedMs: number;
  responseBytes: number; // JSON-RPC envelope 포함 raw line bytes
  textChars: number; // text block text.length 합 (관측 지표)
  resultChars: number; // CallToolResult 전체 canonical serialization char 수 (budget 판정 기준)
  resultBytes: number; // 위 canonical의 UTF-8 byte 수
  contentTypes: string[];
  structuredContentPresent: boolean;
  resultHash: string;
  filesystemBeforeHash: string;
  filesystemAfterHash: string;
  unchanged: boolean;
  withinProposedBudget: boolean; // resultChars <= 8000
}

export interface ReadSemanticsSnapshot {
  mode: "read-semantics";
  usableForHandoff: false;
  externalDataUntrusted: true;
  package: string;
  server: string;
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  proposedBudgetChars: number;
  calls: ReadSemanticsCall[];
  configHash: string;
  timestamp: string;
}

export interface ReadSemanticsOperationSummary {
  initialize: number;
  initialized: number;
  toolsListPages: number;
  toolCalls: number;
  calledTools: string[];
  forbiddenToolCalls: number;
}

export interface ShadcnReadSemanticsResult {
  readSemantics: true;
  snapshotPath: string;
  snapshot: ReadSemanticsSnapshot;
  operationSummary: ReadSemanticsOperationSummary;
}

export interface RunShadcnReadSemanticsOpts {
  serviceCwd: string;
  runtimeDir: string;
  now: () => string;
  overallTimeoutMs?: number;
  perCallTimeoutMs?: number;
  redactNames?: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (isPlainObject(v)) return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v) ?? "null";
}

/** 시작 시 고정 호출 계획을 독립 contract와 exact 비교(이름·순서·arguments canonical·중복 부재·금지 제외). */
function assertCallPlanContract(): void {
  if (CALL_PLAN.length !== 5 || CONTRACT_NAMES.length !== 5) throw new ShadcnReadSemanticsError("bad_calls", "고정 호출은 정확히 5개여야 함");
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const c = CALL_PLAN[i];
    if (c.name !== CONTRACT_NAMES[i]) throw new ShadcnReadSemanticsError("contract_mismatch", "호출 이름/순서가 contract와 불일치");
    if (seen.has(c.name)) throw new ShadcnReadSemanticsError("duplicate_call", "중복 호출");
    seen.add(c.name);
    if (FORBIDDEN_TOOLS.includes(c.name)) throw new ShadcnReadSemanticsError("forbidden_call", "금지 도구 호출 시도");
    if (!EXPECTED_NS_TOOLS.includes(`mcp__${SHADCN_SERVER}__${c.name}`)) throw new ShadcnReadSemanticsError("unknown_call", "미확정 도구 호출 시도");
    if (sha256(canonicalJson(c.arguments)) !== sha256(canonicalJson(CONTRACT_ARGS[i]))) throw new ShadcnReadSemanticsError("contract_mismatch", "arguments canonical hash가 contract와 불일치");
  }
}

/**
 * serviceCwd 전체를 재귀 snapshot → {hash, hasSymlink}. root 자체 type/mode 포함.
 * 파일은 O_NOFOLLOW fd로 열어 같은 fd로 fstat/read(snapshot 중 symlink 교체 방지). 파일별/전체 read 상한.
 */
function fsSnapshot(root: string): { hash: string; hasSymlink: boolean } {
  const entries: string[] = [];
  let totalRead = 0;
  let hasSymlink = false;

  const rootSt = lstatSync(root);
  if (rootSt.isSymbolicLink()) {
    hasSymlink = true;
    entries.push(`.|symlink|-|-|-`);
  } else {
    entries.push(`.|${rootSt.isDirectory() ? "dir" : "other"}|${(rootSt.mode & 0o777).toString(8)}|-|-`);
  }

  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      throw new ShadcnReadSemanticsError("fs_walk_error", "serviceCwd 순회 실패");
    }
    for (const name of names) {
      if (entries.length >= MAX_FS_ENTRIES) throw new ShadcnReadSemanticsError("fs_too_many", `serviceCwd 항목 ${MAX_FS_ENTRIES} 초과`);
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join("/");
      const lst = lstatSync(abs);
      const m = (lst.mode & 0o777).toString(8);
      if (lst.isSymbolicLink()) {
        hasSymlink = true;
        entries.push(`${rel}|symlink|${m}|-|-`);
        continue;
      }
      if (lst.isDirectory()) {
        entries.push(`${rel}|dir|${m}|-|-`);
        walk(abs);
        continue;
      }
      if (lst.isFile()) {
        if (lst.size > MAX_FILE_BYTES) throw new ShadcnReadSemanticsError("fs_file_too_large", `파일이 ${MAX_FILE_BYTES} byte 초과`);
        let fd: number;
        try {
          fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ELOOP") {
            hasSymlink = true;
            entries.push(`${rel}|symlink|${m}|-|-`);
            continue;
          }
          throw new ShadcnReadSemanticsError("fs_open_error", "파일 열기 실패");
        }
        try {
          const fst = fstatSync(fd);
          if (!fst.isFile()) {
            entries.push(`${rel}|other|${(fst.mode & 0o777).toString(8)}|-|-`);
            continue;
          }
          if (fst.size > MAX_FILE_BYTES) throw new ShadcnReadSemanticsError("fs_file_too_large", `파일이 ${MAX_FILE_BYTES} byte 초과`);
          totalRead += fst.size;
          if (totalRead > MAX_TOTAL_READ_BYTES) throw new ShadcnReadSemanticsError("fs_read_too_large", `전체 read가 ${MAX_TOTAL_READ_BYTES} byte 초과`);
          const buf = Buffer.allocUnsafe(fst.size);
          let off = 0;
          while (off < fst.size) {
            const n = readSync(fd, buf, off, fst.size - off, off);
            if (n === 0) break;
            off += n;
          }
          entries.push(`${rel}|file|${(fst.mode & 0o777).toString(8)}|${fst.size}|${sha256(buf.subarray(0, off))}`);
        } finally {
          closeSync(fd);
        }
        continue;
      }
      entries.push(`${rel}|other|${m}|-|-`);
    }
  };
  if (!rootSt.isSymbolicLink() && rootSt.isDirectory()) walk(root);
  return { hash: sha256(entries.join("\n")), hasSymlink };
}

/** CallToolResult 계약 검증 + 전체 크기·파생 지표 추출(원문 미보존). isError/빈/malformed 실패. */
function analyzeResult(result: unknown): {
  textChars: number;
  resultChars: number;
  resultBytes: number;
  contentTypes: string[];
  structuredContentPresent: boolean;
  resultHash: string;
  withinProposedBudget: boolean;
} {
  if (!isPlainObject(result)) throw new ShadcnReadSemanticsError("bad_result", "CallToolResult가 객체 아님");
  const content = result.content;
  if (!Array.isArray(content)) throw new ShadcnReadSemanticsError("bad_result", "content가 배열 아님");
  if (content.length === 0) throw new ShadcnReadSemanticsError("empty_result", "content가 비어 있음");
  if (result.isError === true) throw new ShadcnReadSemanticsError("tool_is_error", "CallToolResult.isError=true");
  if (result.isError !== undefined && typeof result.isError !== "boolean") throw new ShadcnReadSemanticsError("bad_result", "isError가 boolean 아님");
  let textChars = 0;
  const types = new Set<string>();
  for (const block of content) {
    if (!isPlainObject(block) || typeof block.type !== "string") throw new ShadcnReadSemanticsError("bad_result", "content block 계약 위반");
    types.add(block.type);
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new ShadcnReadSemanticsError("bad_result", "text block에 text 문자열 없음");
      textChars += block.text.length;
    }
  }
  const structuredContentPresent = result.structuredContent !== undefined;
  if (structuredContentPresent && !isPlainObject(result.structuredContent)) throw new ShadcnReadSemanticsError("bad_result", "structuredContent가 객체 아님");
  // 전체 결과 canonical serialization으로 budget/크기 판정 (text만이 아니라 structuredContent/image/resource 포함).
  const canonical = canonicalJson({ content: result.content, structuredContent: result.structuredContent ?? null, isError: result.isError ?? false });
  const resultChars = canonical.length;
  const resultBytes = Buffer.byteLength(canonical, "utf8");
  return { textChars, resultChars, resultBytes, contentTypes: [...types].sort(), structuredContentPresent, resultHash: sha256(canonical), withinProposedBudget: resultChars <= PROPOSED_BUDGET_CHARS };
}

function childEnv(home: string, npmCache: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = home;
  env.npm_config_cache = npmCache;
  env.npm_config_update_notifier = "false";
  env.NO_UPDATE_NOTIFIER = "1";
  env.CI = "1";
  return env;
}
function clock(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export async function runShadcnReadSemanticsProbe(opts: RunShadcnReadSemanticsOpts): Promise<ShadcnReadSemanticsResult> {
  const { serviceCwd, runtimeDir, now } = opts;
  const overallTimeoutMs = opts.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS;
  const secretValues = collectSecretValues(opts.redactNames ?? []);
  const scrub = (s: string) => redactSecrets(s, secretValues);
  const norm = (code: string, message: string) => new ShadcnReadSemanticsError(code, scrub(message));

  // 시작 전: 고정 호출 계획 self-check(변조/소스 divergence 감지).
  try {
    assertCallPlanContract();
  } catch (e) {
    throw e instanceof ShadcnReadSemanticsError ? new ShadcnReadSemanticsError(e.code, scrub(e.message)) : norm("contract", (e as Error).message);
  }

  // 0) 표준 registry 검사 — config/spawn/call 이전.
  const reg = checkComponentsJson(serviceCwd);
  if (!reg.ok) throw norm(`registry_${reg.code}`, `components.json 표준 registry 검사 실패 (${reg.code})`);

  // baseline fs snapshot — symlink 있으면 spawn 전 fail-closed. (root/파일 상한도 여기서 걸린다.)
  let baselineHash: string;
  try {
    const baseline = fsSnapshot(serviceCwd);
    if (baseline.hasSymlink) throw norm("baseline_symlink", "serviceCwd baseline에 symlink 존재 — spawn 전 차단");
    baselineHash = baseline.hash;
  } catch (e) {
    throw e instanceof ShadcnReadSemanticsError ? new ShadcnReadSemanticsError(e.code, scrub(e.message)) : norm("fs_walk_error", (e as Error).message);
  }
  void baselineHash;

  // 1) 단일 shadcn strict config(pin 강제).
  let configHash: string;
  let command: string;
  let args: string[];
  try {
    const written = writeMcpConfig(shadcnDiscoveryProfile(), runtimeDir);
    const entry = written.config.mcpServers[SHADCN_SERVER];
    if (!entry || !("command" in entry)) throw norm("config_server", "shadcn stdio 서버 엔트리 없음");
    command = entry.command;
    args = entry.args;
    if (command !== "npx" || JSON.stringify(args) !== JSON.stringify(["--yes", SHADCN_PACKAGE, "mcp"])) throw norm("config_command", "실행 명령이 정확히 npx --yes shadcn@4.13.1 mcp 아님");
    configHash = written.configHash;
  } catch (e) {
    if (e instanceof ShadcnReadSemanticsError) throw new ShadcnReadSemanticsError(e.code, scrub(e.message));
    if (e instanceof McpConfigError) throw norm(`config_${e.code}`, e.message);
    throw norm("config", (e as Error).message);
  }

  // runtime/cache/home을 serviceCwd 밖 임시 경로로 분리.
  const childHome = mkdtempSync(join(tmpdir(), "m3c2-home-"));
  const npmCache = join(childHome, "npm-cache");
  mkdirSync(npmCache, { recursive: true });

  let probeErr: unknown = null;
  let collected: { protocolVersion: string; serverInfo: { name: string; version: string }; toolsListPages: number; calls: ReadSemanticsCall[]; calledTools: string[] } | null = null;
  try {
    collected = await new Promise((resolveP, reject) => {
      let settled = false;
      let intentionalKill = false;
      const decoder = new StringDecoder("utf8");
      let stdoutBuf = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stderr = "";
      let lastCode: number | null = null;

      let phase: "init" | "tools" | "calls" = "init";
      let nextId = 1;
      let pendingId = 1;
      let toolsListPagesSent = 0;
      const cursorsSeen = new Set<string>();
      const names = new Set<string>();
      let protocolVersion = "";
      let serverInfo = { name: "", version: "" };

      let callIdx = -1;
      let callStartedAt = 0;
      let curBeforeHash = "";
      let curArgsHash = "";
      let perCallTimer: NodeJS.Timeout | undefined;
      const calls: ReadSemanticsCall[] = [];
      const calledTools: string[] = [];

      let pending: { kind: "ok"; data: NonNullable<typeof collected> } | { kind: "err"; err: ShadcnReadSemanticsError } | null = null;
      let mainTimer: NodeJS.Timeout;
      let closeTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const clearAll = () => {
        clearTimeout(mainTimer);
        if (perCallTimer) clearTimeout(perCallTimer);
        if (closeTimer) clearTimeout(closeTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      const child = spawn(command, args, { cwd: serviceCwd, env: childEnv(childHome, npmCache), stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      const send = (msg: Record<string, unknown>) => {
        if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + "\n");
      };

      // 모든 실패/성공 경로: 결과를 pending에 두고 kill→bounded close 확인 후 settle.
      const settle = (outcome: NonNullable<typeof pending>) => {
        if (pending) return;
        pending = outcome;
        clearTimeout(mainTimer);
        if (perCallTimer) clearTimeout(perCallTimer);
        intentionalKill = true;
        try {
          if (outcome.kind === "ok") child.stdin.end();
        } catch {
          /* ignore */
        }
        const graceThenKill = outcome.kind === "ok" ? CLOSE_GRACE_MS : 0;
        closeTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          killTimer = setTimeout(finalizeNoClose, KILL_GRACE_MS);
        }, graceThenKill);
      };
      const finalizeNoClose = () => {
        if (settled) return;
        settled = true;
        clearAll();
        reject(norm("child_did_not_close", "child가 grace 내 종료되지 않음(잔존 가능)"));
      };
      const fail = (code: string, msg: string) => settle({ kind: "err", err: norm(code, msg) });

      const sendInitialize = () => send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: REQUEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "harness-shadcn-read-semantics", version: "0" } } });
      const sendInitialized = () => send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const sendToolsList = (cursor?: string) => {
        pendingId = ++nextId;
        toolsListPagesSent++;
        send(cursor === undefined ? { jsonrpc: "2.0", id: pendingId, method: "tools/list", params: {} } : { jsonrpc: "2.0", id: pendingId, method: "tools/list", params: { cursor } });
      };
      const sendNextCall = () => {
        callIdx++;
        const c = CALL_PLAN[callIdx]; // 내부 frozen 계획에서만
        try {
          curBeforeHash = fsSnapshot(serviceCwd).hash;
        } catch (e) {
          return fail((e as ShadcnReadSemanticsError).code ?? "fs_walk_error", (e as Error).message);
        }
        curArgsHash = sha256(canonicalJson(c.arguments));
        callStartedAt = clock();
        pendingId = ++nextId;
        if (perCallTimer) clearTimeout(perCallTimer);
        perCallTimer = setTimeout(() => fail("call_timeout", `tools/call 타임아웃 (${perCallTimeoutMs}ms) @ ${c.name}`), perCallTimeoutMs);
        send({ jsonrpc: "2.0", id: pendingId, method: "tools/call", params: { name: c.name, arguments: c.arguments } });
      };

      const handleMessage = (msg: Record<string, unknown>, lineBytes: number) => {
        if (msg.jsonrpc !== "2.0") throw new ShadcnReadSemanticsError("jsonrpc_version", "jsonrpc가 '2.0' 아님");
        if (!("id" in msg) || msg.id === undefined) return; // 서버 notification 무시
        if (msg.id !== pendingId) throw new ShadcnReadSemanticsError("jsonrpc_id_mismatch", "응답 id 불일치");

        if (phase === "init") {
          if (msg.error !== undefined) throw new ShadcnReadSemanticsError("init_error", "init error 응답");
          const r = msg.result;
          if (!isPlainObject(r)) throw new ShadcnReadSemanticsError("init_error", "init result 누락");
          const pv = r.protocolVersion;
          if (typeof pv !== "string" || !ALLOWED_PROTOCOL_VERSIONS.includes(pv)) throw new ShadcnReadSemanticsError("protocol_version", "protocolVersion 미허용");
          if (!isPlainObject(r.capabilities) || !isPlainObject(r.capabilities.tools)) throw new ShadcnReadSemanticsError("capabilities", "capabilities.tools plain object 아님");
          const si = r.serverInfo;
          if (!isPlainObject(si) || typeof si.name !== "string" || !si.name || typeof si.version !== "string" || !si.version) throw new ShadcnReadSemanticsError("server_info", "serverInfo name/version 누락");
          protocolVersion = pv;
          serverInfo = { name: si.name, version: si.version };
          phase = "tools";
          sendInitialized();
          sendToolsList();
          return;
        }

        if (phase === "tools") {
          if (msg.error !== undefined) throw new ShadcnReadSemanticsError("tools_error", "tools/list error 응답");
          const r = msg.result;
          if (!isPlainObject(r) || !Array.isArray(r.tools)) throw new ShadcnReadSemanticsError("tools_error", "tools/list result.tools 배열 아님");
          for (const raw of r.tools) {
            if (!isPlainObject(raw) || typeof raw.name !== "string" || !raw.name) throw new ShadcnReadSemanticsError("tools_error", "tool.name 누락");
            const full = `mcp__${SHADCN_SERVER}__${raw.name}`;
            if (names.has(full)) throw new ShadcnReadSemanticsError("duplicate_tool", "중복 도구");
            names.add(full);
            if (names.size > MAX_TOOLS) throw new ShadcnReadSemanticsError("too_many_tools", "도구 수 초과");
          }
          const nc = r.nextCursor;
          if (nc !== undefined && nc !== null) {
            if (typeof nc !== "string" || !nc) throw new ShadcnReadSemanticsError("tools_error", "nextCursor 유효하지 않음");
            if (cursorsSeen.has(nc)) throw new ShadcnReadSemanticsError("repeat_cursor", "반복 cursor");
            cursorsSeen.add(nc);
            if (toolsListPagesSent >= MAX_PAGES) throw new ShadcnReadSemanticsError("too_many_pages", "페이지 초과");
            sendToolsList(nc);
            return;
          }
          if (JSON.stringify([...names].sort()) !== JSON.stringify(EXPECTED_NS_TOOLS)) throw new ShadcnReadSemanticsError("tool_name_mismatch", "도구 집합 불일치");
          phase = "calls";
          sendNextCall();
          return;
        }

        // phase === "calls"
        if (perCallTimer) clearTimeout(perCallTimer);
        if (msg.error !== undefined) throw new ShadcnReadSemanticsError("tool_call_error", "tools/call error 응답");
        const analysis = analyzeResult(msg.result);
        const elapsedMs = clock() - callStartedAt;
        const afterHash = fsSnapshot(serviceCwd).hash;
        if (afterHash !== curBeforeHash) throw new ShadcnReadSemanticsError("filesystem_changed", `호출이 serviceCwd를 변경함 @ ${CALL_PLAN[callIdx].name}`);
        const full = `mcp__${SHADCN_SERVER}__${CALL_PLAN[callIdx].name}`;
        calls.push({
          toolName: full,
          argumentsHash: curArgsHash,
          elapsedMs,
          responseBytes: lineBytes,
          textChars: analysis.textChars,
          resultChars: analysis.resultChars,
          resultBytes: analysis.resultBytes,
          contentTypes: analysis.contentTypes,
          structuredContentPresent: analysis.structuredContentPresent,
          resultHash: analysis.resultHash,
          filesystemBeforeHash: curBeforeHash,
          filesystemAfterHash: afterHash,
          unchanged: true,
          withinProposedBudget: analysis.withinProposedBudget,
        });
        calledTools.push(full);
        if (callIdx + 1 < CALL_PLAN.length) {
          sendNextCall();
          return;
        }
        settle({ kind: "ok", data: { protocolVersion, serverInfo, toolsListPages: toolsListPagesSent, calls, calledTools } });
      };

      const onLine = (line: string) => {
        const t = line.trim();
        if (t.length === 0) return;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > SINGLE_RESPONSE_CAP) throw new ShadcnReadSemanticsError("response_too_large", `단일 응답 ${SINGLE_RESPONSE_CAP} byte 초과`);
        let msg: unknown;
        try {
          msg = JSON.parse(t);
        } catch {
          throw new ShadcnReadSemanticsError("malformed_line", "stdout에 유효하지 않은 JSON 라인");
        }
        if (!isPlainObject(msg)) throw new ShadcnReadSemanticsError("malformed_line", "JSON-RPC 메시지가 객체 아님");
        handleMessage(msg, lineBytes);
      };

      mainTimer = setTimeout(() => fail("overall_timeout", `전체 타임아웃 (${overallTimeoutMs}ms)`), overallTimeoutMs);

      child.stdout.on("data", (d: Buffer) => {
        if (pending) return;
        stdoutBytes += d.length;
        if (stdoutBytes > STDOUT_CAP) return fail("stdout_too_large", `stdout ${STDOUT_CAP} byte 초과`);
        stdoutBuf += decoder.write(d);
        try {
          let idx: number;
          while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, idx);
            stdoutBuf = stdoutBuf.slice(idx + 1);
            if (pending) return;
            onLine(line);
            if (pending) return;
          }
        } catch (e) {
          fail((e as ShadcnReadSemanticsError).code ?? "verify", (e as Error).message);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        if (pending) return;
        stderrBytes += d.length;
        if (stderrBytes > STDERR_CAP) return fail("stderr_too_large", `stderr ${STDERR_CAP} byte 초과`);
        stderr += d.toString();
      });
      child.on("error", (e) => fail("spawn", `MCP 서버 실행 실패: ${(e as Error).message}`));
      child.on("close", (code) => {
        lastCode = code;
        if (settled) return;
        clearAll();
        settled = true;
        if (pending) {
          if (pending.kind === "ok") resolveP(pending.data);
          else reject(pending.err);
          return;
        }
        // 예상치 못한 조기 종료(settle 전 close).
        if (code !== 0) reject(norm("nonzero_exit", `MCP 서버 비정상 종료 (code ${code}): ${stderr.trim() || "(stderr 없음)"}`));
        else reject(norm(phase === "init" ? "no_init" : phase === "tools" ? "no_tools" : "calls_incomplete", `완료 전 종료 (code ${code})`));
      });

      void intentionalKill;
      void lastCode;
      sendInitialize();
    });
  } catch (e) {
    probeErr = e;
  }

  // child close 확인 후에만 임시 HOME/cache 정리. 실패는 typed cleanup_failed로 표면화.
  let cleanupErr: ShadcnReadSemanticsError | null = null;
  try {
    rmSync(childHome, { recursive: true, force: true });
    if (existsSync(childHome)) cleanupErr = norm("cleanup_failed", "임시 HOME/cache가 정리되지 않음(잔존)");
  } catch (e) {
    cleanupErr = norm("cleanup_failed", `임시 HOME/cache 정리 실패: ${(e as Error).message}`);
  }
  if (cleanupErr) {
    if (probeErr) cleanupErr = norm("cleanup_failed", `probe 실패(${(probeErr as ShadcnReadSemanticsError).code ?? "unknown"}) 후 임시 HOME 정리도 실패`);
    throw cleanupErr;
  }
  if (probeErr) throw probeErr instanceof ShadcnReadSemanticsError ? probeErr : norm("probe", (probeErr as Error).message);
  const data = collected!;

  // artifact — 원문 없음, 파생 지표만. 외부 유래 짧은 문자열(contentTypes 등)도 scrub.
  const snapshot: ReadSemanticsSnapshot = {
    mode: "read-semantics",
    usableForHandoff: false,
    externalDataUntrusted: true,
    package: scrub(SHADCN_PACKAGE),
    server: scrub(SHADCN_SERVER),
    protocolVersion: scrub(data.protocolVersion),
    serverInfo: { name: scrub(data.serverInfo.name), version: scrub(data.serverInfo.version) },
    proposedBudgetChars: PROPOSED_BUDGET_CHARS,
    calls: data.calls.map((c) => ({ ...c, toolName: scrub(c.toolName), contentTypes: c.contentTypes.map((t) => scrub(t)) })),
    configHash,
    timestamp: scrub(now()),
  };
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";
  const snapshotPath = join(runtimeDir, "mcp-read-semantics.json");
  try {
    mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    writeFileSync(snapshotPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (e) {
    throw norm("persist", `read-semantics snapshot 기록 실패 (기존 파일/symlink?): ${(e as Error).message}`);
  }

  const operationSummary: ReadSemanticsOperationSummary = { initialize: 1, initialized: 1, toolsListPages: data.toolsListPages, toolCalls: data.calledTools.length, calledTools: data.calledTools, forbiddenToolCalls: 0 };
  return { readSemantics: true, snapshotPath, snapshot, operationSummary };
}
