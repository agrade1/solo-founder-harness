import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { NdjsonParser } from "../exec/streamParser.js";
import type { SessionEvent, McpServerStatus } from "../exec/types.js";
import { writeMcpConfig, McpConfigError } from "../providers/claudeCodeMcpAdapter.js";
import { redactSecrets, collectSecretValues } from "./redact.js";
import type { ToolProfile } from "./profiles.js";

/**
 * [M3a] Headless MCP preflight.
 * profile로 mcp-config를 생성하고 `claude -p --output-format stream-json`을 헤드리스로 띄워
 * system/init 스냅샷을 수집한 뒤, 기대 서버/도구와 정확 비교한다.
 *
 * - interactive TUI를 실행하지 않는다.
 * - init 수집 즉시 프로세스를 의도적으로 종료하며, 이 종료를 실패로 오판하지 않는다.
 * - 검증 실패 시 성공 result를 반환하지 않고 typed PreflightError로 fail-closed 한다.
 * - 실제 claude 격리 강제 여부는 이 결과(snapshot)로만 판정한다 ("플래그 존재=격리" 금지).
 */

export class PreflightError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

/** 성공 시에만 기록하는 스냅샷. raw init payload는 저장하지 않는다. */
export interface ToolsSnapshot {
  profileId: string;
  cwd: string;
  timestamp: string;
  configHash: string;
  servers: { name: string; status: string }[]; // 정렬
  tools: string[]; // 정렬, mcp__server__tool
}

export interface PreflightSuccess {
  ok: true;
  snapshotPath: string;
  snapshot: ToolsSnapshot;
}

export interface RunPreflightOpts {
  profile: ToolProfile;
  serviceCwd: string; // 서비스 레포 경로 (claude cwd)
  runtimeDir: string; // mcp-config.json / tools-snapshot.json 기록 위치 (projects/*/outputs/runtime/*)
  now: () => string; // 타임스탬프 주입 (테스트 결정성)
  timeoutMs?: number; // hard timeout (기본 60s)
  /**
   * [TEST-ONLY] child에 강제 주입할 추가 환경변수. production allowlist와 분리된 명시적 seam.
   * production 호출은 지정하지 않는다 (undeclared 환경변수는 child로 새지 않음).
   */
  testEnv?: Record<string, string>;
}

/**
 * child에 넘길 최소 안전 환경을 구성한다.
 *  - process.env 전체를 넘기지 않는다 (토큰/키 등 미선언 secret 유출 방지).
 *  - 실행에 필요한 안전 변수(allowlist)만 통과.
 *  - profile.secretRefs에 선언된 변수만 추가.
 *  - MCP_CONNECTION_NONBLOCKING=0 / ENABLE_TOOL_SEARCH=false 강제.
 *  - testEnv는 명시적 test seam으로만 병합.
 */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

function buildChildEnv(profile: ToolProfile, testEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  for (const name of profile.secretRefs) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v; // 선언된 secret만 통과
  }
  env.MCP_CONNECTION_NONBLOCKING = "0";
  env.ENABLE_TOOL_SEARCH = "false";
  if (testEnv) for (const [k, v] of Object.entries(testEnv)) env[k] = v;
  return env;
}

/** snapshot의 모든 문자열 필드를 redaction한 새 객체를 만든다 (반환/저장 동일 보장). */
function redactSnapshot(s: ToolsSnapshot, scrub: (v: string) => string): ToolsSnapshot {
  return {
    profileId: s.profileId,
    cwd: scrub(s.cwd),
    timestamp: s.timestamp,
    configHash: s.configHash,
    servers: s.servers.map((x) => ({ name: scrub(x.name), status: scrub(x.status) })),
    tools: s.tools.map((t) => scrub(t)),
  };
}

const PREFLIGHT_ARGS_BASE = [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
];

/** init.mcpServers를 name 기준 정렬 + 중복 검출. */
function collectServers(mcp: McpServerStatus[]): { names: string[]; byName: Map<string, McpServerStatus> } {
  const byName = new Map<string, McpServerStatus>();
  for (const s of mcp) {
    if (byName.has(s.name)) throw new PreflightError("duplicate_server", `중복 서버: '${s.name}'`);
    byName.set(s.name, s);
  }
  return { names: [...byName.keys()].sort(), byName };
}

/** init.tools에서 mcp__* 만 추린 뒤 정렬 + 중복 검출. */
function collectMcpTools(tools: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tools) {
    if (!t.startsWith("mcp__")) continue;
    if (seen.has(t)) throw new PreflightError("duplicate_tool", `중복 도구: '${t}'`);
    seen.add(t);
    out.push(t);
  }
  return out.sort();
}

/** 기대치와 실제 init을 정확 비교. 불일치 시 PreflightError. */
function verifySnapshot(
  init: Extract<SessionEvent, { kind: "init" }>,
  expectedServers: string[],
  expectedTools: string[],
): { servers: { name: string; status: string }[]; tools: string[] } {
  const { names: actualServers, byName } = collectServers(init.mcpServers);

  // 서버 이름 정확 일치 (누락·추가(canary)·중복 실패)
  if (JSON.stringify(actualServers) !== JSON.stringify(expectedServers)) {
    throw new PreflightError(
      "server_mismatch",
      `서버 불일치 — 기대: [${expectedServers.join(", ")}], 실제: [${actualServers.join(", ")}]`,
    );
  }
  // 모든 기대 서버가 connected
  for (const name of expectedServers) {
    const s = byName.get(name)!;
    if (!s.connected) {
      throw new PreflightError("server_not_connected", `서버 '${name}' 미연결 (status=${s.status})`);
    }
  }
  // mcp 도구 정확 일치 (누락·추가(canary)·중복 실패)
  const actualTools = collectMcpTools(init.tools);
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new PreflightError(
      "tool_mismatch",
      `MCP 도구 불일치 — 기대: [${expectedTools.join(", ")}], 실제: [${actualTools.join(", ")}]`,
    );
  }
  return {
    servers: expectedServers.map((name) => ({ name, status: byName.get(name)!.status })),
    tools: actualTools,
  };
}

export async function runPreflight(opts: RunPreflightOpts): Promise<PreflightSuccess> {
  const { profile, serviceCwd, runtimeDir, now } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const secretValues = collectSecretValues(profile.secretRefs);
  const scrub = (s: string) => redactSecrets(s, secretValues);

  // 1) mcp-config 생성 (검증 포함). config 오류도 fail-closed.
  let written;
  try {
    written = writeMcpConfig(profile, runtimeDir);
  } catch (e) {
    if (e instanceof McpConfigError) throw new PreflightError(`config_${e.code}`, scrub(e.message));
    throw new PreflightError("config", scrub((e as Error).message));
  }

  const bin = process.env.HARNESS_CLAUDE_BIN ?? "claude"; // 호출 시점에 읽는다
  const argv = [...PREFLIGHT_ARGS_BASE, "--mcp-config", written.configPath, "--tools", "", "--permission-mode", "plan"];

  const snapshot = await new Promise<ToolsSnapshot>((resolve, reject) => {
    const parser = new NdjsonParser();
    let settled = false;
    let intentionalKill = false;
    let stderr = "";

    const child = spawn(bin, argv, {
      cwd: serviceCwd,
      env: buildChildEnv(profile, opts.testEnv),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finishOk = (init: Extract<SessionEvent, { kind: "init" }>) => {
      if (settled) return;
      try {
        const verified = verifySnapshot(init, written.expectedServers, written.expectedTools);
        settled = true;
        clearTimeout(timer);
        intentionalKill = true;
        child.kill("SIGKILL"); // init 수집 완료 → 의도적 종료
        resolve({
          profileId: profile.id,
          cwd: serviceCwd,
          timestamp: now(),
          configHash: written.configHash,
          servers: verified.servers,
          tools: verified.tools,
        });
      } catch (e) {
        settled = true;
        clearTimeout(timer);
        intentionalKill = true;
        child.kill("SIGKILL");
        reject(e);
      }
    };
    const fail = (code: string, msg: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PreflightError(code, scrub(msg)));
    };

    const timer = setTimeout(() => {
      intentionalKill = true;
      child.kill("SIGKILL");
      fail("timeout", `preflight 타임아웃 (${timeoutMs}ms) — system/init 미수신`);
    }, timeoutMs);

    const handle = (events: SessionEvent[]) => {
      for (const e of events) if (e.kind === "init") return finishOk(e);
    };

    child.stdout.on("data", (d) => handle(parser.push(d.toString())));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => fail("spawn", `claude 실행 실패: ${(e as Error).message}`));
    child.on("close", (code) => {
      if (settled) return; // init 수집 후 의도적 종료 — 실패로 보지 않음
      // 종료 전 남은 버퍼 처리
      handle(parser.flush());
      if (settled) return;
      if (code !== 0) fail("nonzero_exit", `claude 비정상 종료 (code ${code}): ${stderr.trim() || "(stderr 없음)"}`);
      else fail("no_init", `system/init 이벤트 없이 종료 (code ${code})`);
    });

    // -p는 stdin 프롬프트를 요구할 수 있으므로 최소 입력 후 닫는다 (init은 프롬프트 처리 전 방출됨).
    child.stdin.end("preflight");
    void intentionalKill; // close 핸들러 가독성용 플래그
  });

  // 2) 성공 시에만 snapshot 기록. 반환 객체와 저장 파일 모두 redacted·동일해야 한다.
  const redacted = redactSnapshot(snapshot, scrub);
  mkdirSync(dirname(join(runtimeDir, "tools-snapshot.json")), { recursive: true });
  const snapshotPath = join(runtimeDir, "tools-snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify(redacted, null, 2) + "\n", "utf8");

  return { ok: true, snapshotPath, snapshot: redacted };
}
