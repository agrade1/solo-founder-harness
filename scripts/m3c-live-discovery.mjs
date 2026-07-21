#!/usr/bin/env node
/**
 * [V3 M3c-0 LIVE DISCOVERY RUNNER — 수동 전용, 실제 Claude/npx 호출]
 *
 * 목적: shadcn MCP의 **실제 도구명**을 headless `claude -p` + `system/init`으로 **발견**만 한다.
 *       (도구 호출·interactive TUI·profile 활성화·handoff 연결은 하지 않는다.)
 *
 * 안전장치:
 *  - `HARNESS_LIVE_M3C_DISCOVERY=1` 없으면 exit 2. Claude/npx 미호출. npm test/CI 자동 실행 대상 아님.
 *  - **실제 실행 시 `npx --yes shadcn@4.13.1 mcp` package download·네트워크·Claude 구독 사용량이 발생할 수 있다.**
 *  - `claude --version`을 먼저 검증하고 기록(실패 시 discovery 미실행).
 *  - production/remote repo/billing/deploy 미접촉. 임시 serviceCwd만 사용.
 *  - components.json은 registries:{}(표준). ambient `.mcp.json` canary로 strict 격리 확인.
 *  - generated mcp-config가 정확히 서버 1개(shadcn)·npx --yes shadcn@4.13.1 mcp인지, 권한·snapshot 계약 검사.
 *  - random sentinel은 parent env에만 — config/snapshot/result/error 평문 부재, child 미전달.
 *  - signal/finally cleanup(idempotent) + canary PID ownership 확인 후에만 kill.
 *
 * 선행: `npm run build`. 실행: HARNESS_LIVE_M3C_DISCOVERY=1 node scripts/m3c-live-discovery.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 안전장치: 명시적 opt-in ──────────────────────────────────────────────────
if (process.env.HARNESS_LIVE_M3C_DISCOVERY !== "1") {
  console.error(
    "거부: 이 runner는 실제 Claude 구독 + `npx --yes shadcn@4.13.1 mcp`(package download/네트워크)를 호출합니다.\n" +
      "  - discovery(system/init 도구명 발견)만 수행하며 도구 호출/interactive TUI는 하지 않습니다.\n" +
      "  - production / remote repo / billing / deploy 에는 접촉하지 않습니다(임시 경로만).\n" +
      "실행하려면: npm run build && HARNESS_LIVE_M3C_DISCOVERY=1 node scripts/m3c-live-discovery.mjs",
  );
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const SERVER = join(HERE, "fixtures", "m3a", "minimal-stdio-mcp.mjs"); // ambient MCP canary fixture 재사용

const distDiscovery = join(HERE, "..", "dist", "tools", "shadcnPilot.js");
if (!existsSync(distDiscovery)) {
  console.error(`빌드가 필요합니다: ${distDiscovery} 없음 — 먼저 'npm run build'.`);
  process.exit(2);
}
if (!existsSync(SERVER)) {
  console.error(`ambient MCP canary fixture 없음: ${SERVER}`);
  process.exit(2);
}

// ── 임시 환경 ────────────────────────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "m3c-disc-"));
const serviceCwd = join(base, "svc");
const runtimeDir = join(base, "runtime");
mkdirSync(serviceCwd, { recursive: true });
process.env.HARNESS_WORKSPACE = join(base, "workspace");

const canaryMcpPidFile = join(base, "canary-mcp.pid");

// 외부에 출력하지 않는 sentinel — parent env에만 둔다. child에는 전달되지 않아야 한다(allowlist 밖).
const SENT_NAME = "M3C_DISCOVERY_SENTINEL";
const sentinel = "m3csentinel" + randomBytes(16).toString("hex");
process.env[SENT_NAME] = sentinel;
const redact = (s) => String(s ?? "").split(sentinel).join("***");
const mode = (p) => statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// claude --version 전용 최소 env allowlist — ambient sentinel/TOKEN/KEY/SECRET/PASSWORD/AUTH 미전달.
// locale은 표준 POSIX LC 카테고리 이름만 명시(와일드카드 금지 — LC_SECRET_TOKEN 등 유출 방지).
const VERSION_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  "LC_MONETARY",
];
function versionEnv() {
  const env = {};
  for (const k of VERSION_ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * 실행 중인 `shadcn@4.13.1 ... mcp` 프로세스 {pid → command}. ps 실패는 fail-closed:
 * { ok:true, map } 또는 { ok:false, error }를 반환한다(빈 Map으로 조용히 성공 처리하지 않음).
 */
function matchingShadcnPids() {
  const r = spawnSync("/bin/ps", ["-Ao", "pid=,command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const detail = r.error?.message ?? `exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim()}` : ""}`;
    return { ok: false, error: String(detail) };
  }
  const m = new Map();
  for (const line of (r.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(" ");
    if (sp <= 0) continue;
    const pid = Number(t.slice(0, sp));
    const cmd = t.slice(sp + 1);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (cmd.includes("shadcn@4.13.1") && /(^|\s)mcp(\s|$)/.test(cmd)) m.set(pid, cmd);
  }
  return { ok: true, map: m };
}

// ── PID ownership 안전 정리 (오인 kill 방지) ─────────────────────────────────
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killPid = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (e) {
    return Boolean(e && e.code === "ESRCH");
  }
};
const readPid = (f) => {
  try {
    const raw = readFileSync(f, "utf8").trim();
    if (!/^[1-9]\d*$/.test(raw)) return 0;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : 0;
  } catch {
    return 0;
  }
};
const psCommand = (pid) => {
  try {
    const r = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    const out = (r.stdout || "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};
const isCanaryProcess = (pid) => {
  const cmd = psCommand(pid);
  if (!cmd) return false;
  return cmd.includes(SERVER) && cmd.includes("canary") && cmd.includes(canaryMcpPidFile);
};
function safeCleanCanaryMcp() {
  if (!existsSync(canaryMcpPidFile)) return null;
  let raw = "";
  try {
    raw = readFileSync(canaryMcpPidFile, "utf8").trim();
  } catch {
    /* ignore */
  }
  const pid = readPid(canaryMcpPidFile);
  if (!pid) return `canary MCP pid-file 값 비정상/빈 값('${raw}') — ownership 미확인(FAIL)`;
  if (!isAlive(pid)) return null;
  if (!isCanaryProcess(pid)) return `canary MCP pid ${pid} 생존하나 command 불일치 — stale/reused PID 또는 ownership 미확인, kill 안 함(FAIL)`;
  if (!killPid(pid)) return `canary MCP pid ${pid} kill 실패(권한 등)(FAIL)`;
  return null;
}

const cleanupProblems = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const p = safeCleanCanaryMcp();
  if (p) cleanupProblems.push(p);
  try {
    rmSync(base, { recursive: true, force: true });
  } catch (e) {
    cleanupProblems.push(`임시 디렉터리 정리 실패: ${redact(e?.message ?? e)}`);
  }
}
function onSignal(code) {
  cleanup();
  if (cleanupProblems.length) console.error("[m3c-disc] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
  process.exit(code);
}
process.on("SIGINT", () => onSignal(130));
process.on("SIGTERM", () => onSignal(143));

const { runShadcnDiscovery, checkComponentsJson, SHADCN_PACKAGE } = await import(distDiscovery);

const problems = [];
let exitCode = 0;

try {
  // service repo: 표준 registry만 — components.json은 registries:{}(허용).
  writeFileSync(join(serviceCwd, "components.json"), JSON.stringify({ style: "new-york", registries: {} }, null, 2) + "\n", "utf8");
  // ambient MCP canary: strict 격리 시 미기동(pid-file 부재).
  writeFileSync(
    join(serviceCwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { canary: { command: NODE, args: [SERVER, "canary", "canary_tool", canaryMcpPidFile] } } }, null, 2) + "\n",
    "utf8",
  );

  // 보조 사전 검사(핵심 API가 다시 강제한다).
  const reg = checkComponentsJson(serviceCwd);
  if (!reg.ok) {
    console.error(`[m3c-disc] components.json 표준 registry 검사 실패: ${reg.code} — 중단.`);
    exitCode = 1;
    throw new Error("registry_check_failed");
  }

  // 버전 검증 (실패/timeout/maxBuffer 초과 시 discovery 미실행). env는 allowlist만(sentinel/secret 미전달).
  const claudeBin = process.env.HARNESS_CLAUDE_BIN ?? "claude";
  const ver = spawnSync(claudeBin, ["--version"], { encoding: "utf8", env: versionEnv(), timeout: 10_000, maxBuffer: 64 * 1024 });
  const verOut = (ver.stdout || "").trim();
  const SEMVER = /\b\d+\.\d+\.\d+\b/;
  if (ver.error || ver.status !== 0 || !verOut || !SEMVER.test(verOut)) {
    console.error(`[m3c-disc] '${redact(claudeBin)} --version' 확인 실패(오류/타임아웃/maxBuffer 초과) — discovery 미실행(fail-closed).`);
    if (ver.error) console.error("  error:", redact(ver.error.message ?? String(ver.error)));
    console.error("  stdout:", redact(verOut) || "(빈 출력)");
    console.error("  stderr:", redact((ver.stderr || "").trim()) || "(없음)");
    exitCode = 2;
    throw new Error("version_check_failed");
  }
  console.log(`[m3c-disc] claude 버전: ${redact(verOut)} (bin='${redact(claudeBin)}')`);

  console.log("\n========================================================================");
  console.log("[m3c-disc] M3c-0 shadcn MCP DISCOVERY (도구명 발견 전용)");
  console.log(`주의: 실제 Claude 구독 + '${SHADCN_PACKAGE}' npx download/네트워크 사용량이 발생할 수 있습니다.`);
  console.log("도구 호출·interactive TUI는 실행하지 않습니다. system/init 도구명만 수집합니다.");
  console.log("========================================================================\n");

  // discovery 전 실행 중인 shadcn MCP 프로세스 스냅샷(잔존 판정 기준선). ps 실패는 fail-closed(exit 2).
  const before = matchingShadcnPids();
  if (!before.ok) {
    console.error(`[m3c-disc] baseline /bin/ps 실패 — discovery 미실행(fail-closed): ${redact(before.error)}`);
    exitCode = 2;
    throw new Error("ps_baseline_failed");
  }
  const beforePids = new Set(before.map.keys());

  let res = null;
  try {
    // sentinel은 redactNames로만 전달(값 아님) — child env로는 전달되지 않는다.
    res = await runShadcnDiscovery({ serviceCwd, runtimeDir, now: () => new Date().toISOString(), timeoutMs: 60_000, redactNames: [SENT_NAME] });
  } catch (e) {
    // rawMessage로 sentinel 평문 노출 여부를 먼저 검사(검사 후에만 redact 출력).
    const rawMessage = String(e?.message ?? e);
    if (rawMessage.includes(sentinel)) problems.push("discovery 오류에 sentinel 평문 노출");
    console.error(`[m3c-disc] discovery 실패 (${e?.code ?? "unknown"}) — ${redact(rawMessage)}`);
    problems.push(`discovery 실패: ${e?.code ?? "unknown"}`);
  }

  // discovery가 남긴 shadcn MCP 프로세스 잔존 감지(최대 5초 polling). ownership 불확실 → 자동 kill 안 함.
  // polling 중 ps 실패도 fail-closed(problems 기록). 오류는 redact.
  let leftover = new Map();
  for (let waited = 0; waited <= 5000; waited += 500) {
    const cur = matchingShadcnPids();
    if (!cur.ok) {
      problems.push(`polling 중 /bin/ps 실패 — 잔존 프로세스 판정 불가(fail-closed): ${redact(cur.error)}`);
      break;
    }
    leftover = new Map([...cur.map].filter(([pid]) => !beforePids.has(pid)));
    if (leftover.size === 0) break;
    if (waited < 5000) await sleep(500);
  }
  if (leftover.size > 0) {
    for (const [pid, cmd] of leftover) {
      problems.push(`shadcn MCP 프로세스 잔존(자동 kill 안 함, ownership 불확실): pid=${redact(String(pid))} cmd=${redact(cmd)}`);
    }
  }

  // ambient MCP canary는 strict 격리로 기동되지 않아야 한다(성공/실패 무관).
  const canaryProblem = safeCleanCanaryMcp();
  if (existsSync(canaryMcpPidFile)) problems.push("ambient MCP canary 기동됨(pid-file 존재) — strict 격리 실패");
  if (canaryProblem) problems.push(canaryProblem);

  if (res) {
    const configPath = join(runtimeDir, "mcp-config.json");
    const snapshotPath = res.snapshotPath;
    const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const snapText = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";

    // generated mcp-config = 정확히 서버 1개(shadcn), npx --yes shadcn@4.13.1 mcp
    let cfg = null;
    try {
      cfg = JSON.parse(configText);
    } catch {
      problems.push("mcp-config.json 파싱 실패");
    }
    if (cfg) {
      const keys = Object.keys(cfg.mcpServers ?? {});
      if (JSON.stringify(keys) !== JSON.stringify(["shadcn"])) problems.push(`mcp-config 서버가 [shadcn] 아님: [${keys.join(", ")}]`);
      const s = cfg.mcpServers?.shadcn ?? {};
      if (s.command !== "npx") problems.push("mcp-config shadcn.command≠npx");
      if (JSON.stringify(s.args) !== JSON.stringify(["--yes", "shadcn@4.13.1", "mcp"])) problems.push(`mcp-config shadcn.args 불일치: ${JSON.stringify(s.args)}`);
    }
    // canary가 config/snapshot에 없음
    if (/canary/.test(configText)) problems.push("mcp-config에 ambient canary 노출");
    if (/canary/.test(snapText)) problems.push("snapshot에 ambient canary 노출");
    // 권한
    if (existsSync(runtimeDir) && mode(runtimeDir) !== 0o700) problems.push(`runtime dir 권한 ${mode(runtimeDir).toString(8)} (기대 700)`);
    if (existsSync(configPath) && mode(configPath) !== 0o600) problems.push(`mcp-config 권한 ${mode(configPath).toString(8)} (기대 600)`);
    if (existsSync(snapshotPath) && mode(snapshotPath) !== 0o600) problems.push(`snapshot 권한 ${mode(snapshotPath).toString(8)} (기대 600)`);
    // snapshot 계약
    const snap = res.snapshot;
    if (snap.mode !== "discovery") problems.push("snapshot.mode≠discovery");
    if (snap.usableForHandoff !== false) problems.push("snapshot.usableForHandoff≠false");
    if (!Array.isArray(snap.tools) || snap.tools.length === 0) problems.push("snapshot.tools가 비어 있음(runner 독립 검증)");
    // raw init 필드 부재
    if (/\b(subtype|permissionMode|session_id|mcp_servers)\b/.test(snapText)) problems.push("snapshot에 raw init 필드 노출");
    // sentinel 평문 부재 (config/snapshot/result)
    for (const [name, txt] of [["config", configText], ["snapshot", snapText], ["result", JSON.stringify(res)]]) {
      if (txt.includes(sentinel)) problems.push(`${name}에 sentinel 평문 노출`);
    }

    console.log("[m3c-disc] 발견된 실제 MCP 도구명 (scrub된 snapshot 값):");
    for (const t of snap.tools) console.log(`  - ${t}`); // snapshot.tools는 이미 scrub됨
    console.log(`[m3c-disc] snapshot: ${snapshotPath} (mode=${snap.mode}, usableForHandoff=${snap.usableForHandoff}, tools=${snap.tools.length})`);
  }

  if (problems.length) {
    console.error("\n[m3c-disc] FAIL:\n - " + problems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  } else if (res) {
    console.log("\n[m3c-disc] discovery OK — 위 도구명은 실측 결과다. profile 활성화·handoff 연결은 별도 후속 작업.");
  }
} catch (e) {
  const msg = redact(String(e?.message ?? e));
  if (!["registry_check_failed", "version_check_failed", "ps_baseline_failed"].includes(msg)) {
    console.error("[m3c-disc] 예기치 못한 오류:", msg);
    exitCode = exitCode || 1;
  }
} finally {
  cleanup();
  if (cleanupProblems.length) {
    console.error("[m3c-disc] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  }
  console.log(`[m3c-disc] 종료 (exit ${exitCode}).`);
  process.exit(exitCode);
}
