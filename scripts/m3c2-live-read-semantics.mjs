#!/usr/bin/env node
/**
 * [V3 M3c-2 LIVE READ-SEMANTICS RUNNER — 수동 전용, 실제 shadcn MCP stdio 직접 실행]
 *
 * 목적: M3c-1에서 실측한 7개 도구 중 **읽기 후보 5개**만 고정 인자로 순차 tools/call해
 *       (a) serviceCwd 무변경, (b) CallToolResult 계약, (c) 결과 텍스트 budget(8,000 chars)을 **측정**한다.
 *       금지 도구(get_add_command_for_items, get_audit_checklist)는 호출하지 않는다.
 *       실제 Claude CLI/구독은 사용하지 않는다 — shadcn MCP stdio만 직접 실행한다.
 *
 * 안전장치:
 *  - `HARNESS_LIVE_M3C2_SEMANTICS=1` 없으면 exit 2. Claude/npx 미호출. npm test/CI 비대상.
 *  - **실제 실행 시 `npx --yes shadcn@4.13.1 mcp` package download + standard registry network read(5회)가 발생할 수 있다.**
 *  - production/remote repo/billing/deploy 미접촉. 임시 serviceCwd/home/cache만 사용, cleanup.
 *  - 외부 결과 원문 출력 금지 — metrics(파생 지표)만 출력. signal/finally cleanup·잔존 프로세스 검사.
 *
 * 선행: `npm run build`. 실행: HARNESS_LIVE_M3C2_SEMANTICS=1 node scripts/m3c2-live-read-semantics.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HARNESS_LIVE_M3C2_SEMANTICS !== "1") {
  console.error(
    "거부: 이 runner는 `npx --yes shadcn@4.13.1 mcp`(package download/네트워크)를 stdio로 직접 실행하고,\n" +
      "  standard @shadcn registry를 읽는 5개 read tools/call을 보냅니다(금지 도구 2개는 호출하지 않음).\n" +
      "  - 실제 Claude CLI/구독은 사용하지 않습니다. production/remote/billing/deploy 미접촉(임시 경로만).\n" +
      "실행하려면: npm run build && HARNESS_LIVE_M3C2_SEMANTICS=1 node scripts/m3c2-live-read-semantics.mjs",
  );
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const distProbe = join(HERE, "..", "dist", "tools", "shadcnReadSemanticsProbe.js");
const distPilot = join(HERE, "..", "dist", "tools", "shadcnPilot.js");
if (!existsSync(distProbe) || !existsSync(distPilot)) {
  console.error(`빌드가 필요합니다: ${distProbe} 없음 — 먼저 'npm run build'.`);
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), "m3c2-sem-"));
const serviceCwd = join(base, "svc");
const runtimeDir = join(base, "runtime");
mkdirSync(serviceCwd, { recursive: true });
process.env.HARNESS_WORKSPACE = join(base, "workspace");

const SENT_NAME = "M3C2_SEMANTICS_SENTINEL";
const sentinel = "m3c2sem" + randomBytes(16).toString("hex");
process.env[SENT_NAME] = sentinel;
const redact = (s) => String(s ?? "").split(sentinel).join("***");
const mode = (p) => statSync(p).mode & 0o777;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (cleanupProblems.length) console.error("[m3c2-sem] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
  process.exit(code);
}
process.on("SIGINT", () => onSignal(130));
process.on("SIGTERM", () => onSignal(143));

// mutable export를 import하지 않는다 — clone getter만 사용.
const { runShadcnReadSemanticsProbe, getSemanticsCalls, getForbiddenCallTools } = await import(distProbe);
const { checkComponentsJson } = await import(distPilot);

const problems = [];
let exitCode = 0;

try {
  writeFileSync(join(serviceCwd, "components.json"), JSON.stringify({ style: "new-york", registries: {} }, null, 2) + "\n", "utf8");
  writeFileSync(join(serviceCwd, "fixed.txt"), "fixed content\n", "utf8");
  const reg = checkComponentsJson(serviceCwd);
  if (!reg.ok) {
    console.error(`[m3c2-sem] components.json 표준 registry 검사 실패: ${reg.code} — 중단.`);
    exitCode = 1;
    throw new Error("registry_check_failed");
  }

  console.log("\n========================================================================");
  console.log("[m3c2-sem] M3c-2 shadcn controlled READ SEMANTICS (읽기 후보 5회 측정)");
  console.log("주의: `npx --yes shadcn@4.13.1 mcp` package download + standard @shadcn registry network read(5회) 가능성.");
  console.log("금지 도구(get_add_command_for_items, get_audit_checklist)는 호출하지 않습니다. 결과 원문은 출력하지 않습니다.");
  console.log("========================================================================\n");

  const before = matchingShadcnPids();
  if (!before.ok) {
    console.error(`[m3c2-sem] baseline /bin/ps 실패 — probe 미실행(fail-closed): ${redact(before.error)}`);
    exitCode = 2;
    throw new Error("ps_baseline_failed");
  }
  const beforePids = new Set(before.map.keys());

  let res = null;
  try {
    res = await runShadcnReadSemanticsProbe({ serviceCwd, runtimeDir, now: () => new Date().toISOString(), redactNames: [SENT_NAME] });
  } catch (e) {
    const rawMessage = String(e?.message ?? e);
    if (rawMessage.includes(sentinel)) problems.push("probe 오류에 sentinel 평문 노출");
    console.error(`[m3c2-sem] read-semantics 실패 (${e?.code ?? "unknown"}) — ${redact(rawMessage)}`);
    problems.push(`read-semantics 실패: ${e?.code ?? "unknown"}`);
  }

  let leftover = new Map();
  for (let waited = 0; waited <= 5000; waited += 500) {
    const cur = matchingShadcnPids();
    if (!cur.ok) {
      problems.push(`polling 중 /bin/ps 실패: ${redact(cur.error)}`);
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
    const op = res.operationSummary || {};
    const snap = res.snapshot;

    // operation summary 정직 검증 (clone getter 사용)
    if (res.readSemantics !== true) problems.push("readSemantics flag 아님");
    if (snap.mode !== "read-semantics") problems.push("snapshot.mode≠read-semantics");
    if (snap.usableForHandoff !== false) problems.push("usableForHandoff≠false");
    if (snap.externalDataUntrusted !== true) problems.push("externalDataUntrusted≠true");
    if (!Array.isArray(snap.calls) || snap.calls.length !== 5) problems.push(`calls.length≠5: ${snap.calls?.length}`);
    if (op.toolCalls !== 5) problems.push(`toolCalls≠5: ${op.toolCalls}`);
    if (op.forbiddenToolCalls !== 0) problems.push(`forbiddenToolCalls≠0: ${op.forbiddenToolCalls}`);
    const expectedCalled = getSemanticsCalls().map((c) => "mcp__shadcn__" + c.name);
    if (JSON.stringify(op.calledTools) !== JSON.stringify(expectedCalled)) problems.push(`calledTools 불일치: ${JSON.stringify(op.calledTools)}`);
    for (const f of getForbiddenCallTools()) if ((op.calledTools || []).includes("mcp__shadcn__" + f)) problems.push(`금지 도구 호출됨: ${f}`);
    // 무변경
    for (const c of snap.calls) if (!c.unchanged) problems.push(`serviceCwd 변경 감지: ${c.toolName}`);
    // 생성된 mcp-config = 정확히 npx --yes shadcn@4.13.1 mcp + 권한
    const configPath = join(runtimeDir, "mcp-config.json");
    let cfg = null;
    try {
      cfg = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      problems.push("mcp-config.json 파싱 실패");
    }
    if (cfg && JSON.stringify(cfg.mcpServers?.shadcn?.args) !== JSON.stringify(["--yes", "shadcn@4.13.1", "mcp"])) problems.push(`mcp-config args 불일치: ${JSON.stringify(cfg.mcpServers?.shadcn?.args)}`);
    if (existsSync(configPath) && mode(configPath) !== 0o600) problems.push(`mcp-config 권한 ${mode(configPath).toString(8)}`);
    if (mode(runtimeDir) !== 0o700) problems.push(`runtime dir 권한 ${mode(runtimeDir).toString(8)}`);
    if (existsSync(snapshotPath) && mode(snapshotPath) !== 0o600) problems.push(`snapshot 권한 ${mode(snapshotPath).toString(8)}`);
    // raw payload 미저장: 문자열 정규식 대신 허용 key 구조로 검증
    const ALLOWED_TOP = new Set(["mode", "usableForHandoff", "externalDataUntrusted", "package", "server", "protocolVersion", "serverInfo", "proposedBudgetChars", "calls", "configHash", "timestamp"]);
    const ALLOWED_CALL = new Set(["toolName", "argumentsHash", "elapsedMs", "responseBytes", "textChars", "resultChars", "resultBytes", "contentTypes", "structuredContentPresent", "resultHash", "filesystemBeforeHash", "filesystemAfterHash", "unchanged", "withinProposedBudget"]);
    for (const k of Object.keys(snap)) if (!ALLOWED_TOP.has(k)) problems.push(`snapshot에 허용되지 않은 top-level key: ${k}`);
    for (const c of snap.calls) for (const k of Object.keys(c)) if (!ALLOWED_CALL.has(k)) problems.push(`call에 허용되지 않은 key(raw payload 의심): ${k}`);
    if (snapText.includes(sentinel)) problems.push("snapshot에 sentinel 평문 노출");

    console.log("[m3c2-sem] read semantics OK — 파생 metrics만 (외부 결과 원문 없음):");
    for (const c of snap.calls) {
      console.log(
        `  - ${c.toolName}: elapsedMs=${c.elapsedMs} responseBytes=${c.responseBytes} textChars=${c.textChars} contentTypes=[${c.contentTypes.join(",")}] structured=${c.structuredContentPresent} unchanged=${c.unchanged} withinBudget=${c.withinProposedBudget}`,
      );
    }
    console.log(`[m3c2-sem] operationSummary=${JSON.stringify(op)}`);
  }

  if (problems.length) {
    console.error("\n[m3c2-sem] FAIL:\n - " + problems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  } else if (res) {
    console.log("\n[m3c2-sem] 5개 read 후보 semantics 측정 완료. 권한 분류·profile 등록·handoff·result enforcement는 별도 후속.");
  }
} catch (e) {
  const msg = redact(String(e?.message ?? e));
  if (!["registry_check_failed", "ps_baseline_failed"].includes(msg)) {
    console.error("[m3c2-sem] 예기치 못한 오류:", msg);
    exitCode = exitCode || 1;
  }
} finally {
  cleanup();
  if (cleanupProblems.length) {
    console.error("[m3c2-sem] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  }
  console.log(`[m3c2-sem] 종료 (exit ${exitCode}).`);
  process.exit(exitCode);
}
