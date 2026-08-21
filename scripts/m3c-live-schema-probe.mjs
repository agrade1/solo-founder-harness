#!/usr/bin/env node
/**
 * [V3 M3c-1 LIVE SCHEMA PROBE RUNNER — 수동 전용, 실제 shadcn MCP stdio 직접 실행]
 *
 * 목적: shadcn MCP의 7개 도구 **schema·description·annotations**를 `initialize → notifications/initialized
 *       → tools/list`까지만 대화해 수집한다. **tools/call은 전송하지 않는다**(코드 경로 없음).
 *       실제 Claude CLI/구독은 사용하지 않는다 — 이 runner는 `npx --yes shadcn@4.13.1 mcp` stdio만 직접 실행한다.
 *
 * 안전장치:
 *  - `HARNESS_LIVE_M3C_SCHEMA=1` 없으면 exit 2. Claude/npx 미호출. npm test/CI 자동 실행 대상 아님.
 *  - **실제 실행 시 `npx --yes shadcn@4.13.1 mcp` package download·네트워크가 발생할 수 있다.**
 *  - production/remote repo/billing/deploy 미접촉. 임시 standard-registry service cwd만 사용.
 *  - signal/finally cleanup(idempotent) + 잔존 프로세스(ownership 확인 후에만 kill) 검사.
 *  - tools/call을 절대 전송하지 않았음을 결과 operationSummary(toolCalls:0)로 검증(코드 경로 부재).
 *
 * 선행: `npm run build`. 실행: HARNESS_LIVE_M3C_SCHEMA=1 node scripts/m3c-live-schema-probe.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HARNESS_LIVE_M3C_SCHEMA !== "1") {
  console.error(
    "거부: 이 runner는 `npx --yes shadcn@4.13.1 mcp`(package download/네트워크)를 stdio로 직접 실행합니다.\n" +
      "  - initialize/tools/list schema 수집만 하며 tools/call·interactive TUI는 하지 않습니다.\n" +
      "  - production / remote repo / billing / deploy 에는 접촉하지 않습니다(임시 경로만).\n" +
      "실행하려면: npm run build && HARNESS_LIVE_M3C_SCHEMA=1 node scripts/m3c-live-schema-probe.mjs",
  );
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const distProbe = join(HERE, "..", "dist", "tools", "shadcnSchemaProbe.js");
const distPilot = join(HERE, "..", "dist", "tools", "shadcnPilot.js");
if (!existsSync(distProbe) || !existsSync(distPilot)) {
  console.error(`빌드가 필요합니다: ${distProbe} 없음 — 먼저 'npm run build'.`);
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), "m3c-schema-"));
const serviceCwd = join(base, "svc");
const runtimeDir = join(base, "runtime");
mkdirSync(serviceCwd, { recursive: true });
process.env.HARNESS_WORKSPACE = join(base, "workspace");

const SENT_NAME = "M3C_SCHEMA_SENTINEL";
const sentinel = "m3cschema" + randomBytes(16).toString("hex");
process.env[SENT_NAME] = sentinel;
const redact = (s) => String(s ?? "").split(sentinel).join("***");
const mode = (p) => statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `shadcn@4.13.1 ... mcp` 프로세스 {pid → command}. ps 실패는 fail-closed.
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

let cleaned = false;
const cleanupProblems = [];
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    rmSync(base, { recursive: true, force: true });
  } catch (e) {
    cleanupProblems.push(`임시 디렉터리 정리 실패: ${redact(e?.message ?? e)}`);
  }
}
function onSignal(code) {
  cleanup();
  if (cleanupProblems.length) console.error("[m3c-schema] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
  process.exit(code);
}
process.on("SIGINT", () => onSignal(130));
process.on("SIGTERM", () => onSignal(143));

// checkComponentsJson은 shadcnPilot.js에서 export된다(shadcnSchemaProbe.js는 re-export하지 않음).
const { runShadcnSchemaProbe, EXPECTED_SHADCN_TOOLS } = await import(distProbe);
const { checkComponentsJson } = await import(distPilot);

const problems = [];
let exitCode = 0;

try {
  writeFileSync(join(serviceCwd, "components.json"), JSON.stringify({ style: "new-york", registries: {} }, null, 2) + "\n", "utf8");
  const reg = checkComponentsJson(serviceCwd);
  if (!reg.ok) {
    console.error(`[m3c-schema] components.json 표준 registry 검사 실패: ${reg.code} — 중단.`);
    exitCode = 1;
    throw new Error("registry_check_failed");
  }

  console.log("\n========================================================================");
  console.log("[m3c-schema] M3c-1 shadcn MCP tools/list SCHEMA DISCOVERY (schema 수집 전용)");
  console.log("주의: 실제 `npx --yes shadcn@4.13.1 mcp` package download/네트워크 사용량이 발생할 수 있습니다.");
  console.log("initialize/tools/list만 대화하며 tools/call·interactive TUI는 실행하지 않습니다.");
  console.log("========================================================================\n");

  const before = matchingShadcnPids();
  if (!before.ok) {
    console.error(`[m3c-schema] baseline /bin/ps 실패 — probe 미실행(fail-closed): ${redact(before.error)}`);
    exitCode = 2;
    throw new Error("ps_baseline_failed");
  }
  const beforePids = new Set(before.map.keys());

  let res = null;
  try {
    res = await runShadcnSchemaProbe({ serviceCwd, runtimeDir, now: () => new Date().toISOString(), timeoutMs: 60_000, redactNames: [SENT_NAME] });
  } catch (e) {
    const rawMessage = String(e?.message ?? e);
    if (rawMessage.includes(sentinel)) problems.push("probe 오류에 sentinel 평문 노출");
    console.error(`[m3c-schema] schema probe 실패 (${e?.code ?? "unknown"}) — ${redact(rawMessage)}`);
    problems.push(`schema probe 실패: ${e?.code ?? "unknown"}`);
  }

  // 잔존 shadcn MCP 프로세스(최대 5초 polling). ownership 불확실 → 자동 kill 안 함.
  let leftover = new Map();
  for (let waited = 0; waited <= 5000; waited += 500) {
    const cur = matchingShadcnPids();
    if (!cur.ok) {
      problems.push(`polling 중 /bin/ps 실패 — 잔존 판정 불가(fail-closed): ${redact(cur.error)}`);
      break;
    }
    leftover = new Map([...cur.map].filter(([pid]) => !beforePids.has(pid)));
    if (leftover.size === 0) break;
    if (waited < 5000) await sleep(500);
  }
  for (const [pid, cmd] of leftover) problems.push(`shadcn MCP 프로세스 잔존(자동 kill 안 함): pid=${redact(String(pid))} cmd=${redact(cmd)}`);

  if (res) {
    const snapshotPath = res.snapshotPath;
    const snapText = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
    const configPath = join(runtimeDir, "mcp-config.json");
    const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    const snap = res.snapshot;

    // config 고정 검사
    let cfg = null;
    try {
      cfg = JSON.parse(configText);
    } catch {
      problems.push("mcp-config.json 파싱 실패");
    }
    if (cfg && JSON.stringify(cfg.mcpServers?.shadcn?.args) !== JSON.stringify(["--yes", "shadcn@4.13.1", "mcp"])) {
      problems.push(`mcp-config args 불일치: ${JSON.stringify(cfg.mcpServers?.shadcn?.args)}`);
    }
    // snapshot 계약
    if (snap.mode !== "schema-discovery") problems.push("snapshot.mode≠schema-discovery");
    if (snap.usableForHandoff !== false) problems.push("snapshot.usableForHandoff≠false");
    const names = snap.tools.map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_SHADCN_TOOLS].sort())) problems.push(`도구 이름 집합 불일치: ${names.join(", ")}`);
    // operation summary — tools/call 미전송을 고정 요약으로 정직하게 검증(로그 추측 아님)
    const op = res.operationSummary || {};
    if (op.toolCalls !== 0) problems.push(`operationSummary.toolCalls≠0: ${op.toolCalls}`);
    if (op.initialize !== 1) problems.push(`operationSummary.initialize≠1: ${op.initialize}`);
    if (op.initialized !== 1) problems.push(`operationSummary.initialized≠1: ${op.initialized}`);
    if (!(op.toolsListPages >= 1)) problems.push(`operationSummary.toolsListPages<1: ${op.toolsListPages}`);
    // raw protocol payload 부재
    if (/"jsonrpc"|"method"\s*:/.test(snapText)) problems.push("snapshot에 raw protocol payload 노출");
    // 권한
    if (mode(runtimeDir) !== 0o700) problems.push(`runtime dir 권한 ${mode(runtimeDir).toString(8)}`);
    if (existsSync(configPath) && mode(configPath) !== 0o600) problems.push(`mcp-config 권한 ${mode(configPath).toString(8)}`);
    if (existsSync(snapshotPath) && mode(snapshotPath) !== 0o600) problems.push(`snapshot 권한 ${mode(snapshotPath).toString(8)}`);
    // sentinel 평문 부재
    for (const [name, txt] of [["config", configText], ["snapshot", snapText], ["result", JSON.stringify(res)]]) {
      if (txt.includes(sentinel)) problems.push(`${name}에 sentinel 평문 노출`);
    }

    console.log("[m3c-schema] 수집된 도구 schema (scrub된 snapshot):");
    for (const t of snap.tools) {
      const keys = t.inputSchema && typeof t.inputSchema === "object" ? Object.keys(t.inputSchema.properties ?? {}) : [];
      console.log(`  - ${t.name}  (inputSchema.properties: [${keys.join(", ")}]${t.annotations ? ", +annotations" : ""}${t.outputSchema ? ", +outputSchema" : ""})`);
    }
    console.log(`[m3c-schema] protocolVersion=${redact(snap.protocolVersion)} serverInfo=${redact(snap.serverInfo?.name)} snapshot=${snapshotPath}`);
    console.log(JSON.stringify(snap, null, 2));
  }

  if (problems.length) {
    console.error("\n[m3c-schema] FAIL:\n - " + problems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  } else if (res) {
    console.log("\n[m3c-schema] schema discovery OK — schema는 실측 결과다. 권한 분류·profile 등록·handoff 연결은 별도 후속(M3c-2+).");
  }
} catch (e) {
  const msg = redact(String(e?.message ?? e));
  if (!["registry_check_failed", "ps_baseline_failed"].includes(msg)) {
    console.error("[m3c-schema] 예기치 못한 오류:", msg);
    exitCode = exitCode || 1;
  }
} finally {
  cleanup();
  if (cleanupProblems.length) {
    console.error("[m3c-schema] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  }
  console.log(`[m3c-schema] 종료 (exit ${exitCode}).`);
  process.exit(exitCode);
}
