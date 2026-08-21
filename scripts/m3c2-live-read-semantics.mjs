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
 *  - 잔존 프로세스 검사는 **이 runner 소유(process tree 또는 임시 base cwd)** 로만 한정한다(m3c3b ownership 패턴).
 *    같은 command line을 가진 남의 프로세스(병렬 테스트 등)는 잔존으로 보지 않는다. 소유권 미확인은 FAIL(kill 안 함).
 *  - 프로세스 동일성은 pid가 아니라 **pid + ps lstart(시작 시각)** 으로 판정한다(pid 재사용 방지).
 *  - 잔존 보고에는 외부 프로세스의 argv/command line을 **절대 출력하지 않는다** — pid/소유권/run-salt 해시만.
 *
 * 선행: `npm run build`. 실행: HARNESS_LIVE_M3C2_SEMANTICS=1 node scripts/m3c2-live-read-semantics.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
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

// ── 잔존 프로세스 소유권 판정 (m3c3b ownership 패턴: process tree + cwd) ──────
// 같은 command line(`shadcn@4.13.1 ... mcp`)을 가진 프로세스가 병렬로 존재할 수 있으므로,
// **이 runner가 만든 프로세스**만 잔존으로 센다:
//   owned  = ppid 체인이 이 runner(process.pid)에 닿거나, cwd가 임시 base(=serviceCwd 상위) 아래.
//   foreign= cwd가 확인됐고 base 밖 / 다른 uid → 우리 것이 아님 → 무시.
//   unknown= 살아있는데 cwd 확인 실패 또는 관측 중 동일성 변화 → 소유권 미확인 FAIL(kill 안 함).
// pid는 재사용되므로 baseline 비교·재검증은 모두 identity(`pid@lstart`)로 한다.
const OWN_PID = process.pid;
const LSOF_BINS = ["/usr/sbin/lsof", "/usr/bin/lsof"];
const basePrefixes = [...new Set([base, (() => { try { return realpathSync(base); } catch { return base; } })()])];
const underBase = (p) => basePrefixes.some((b) => p === b || p.startsWith(b + "/"));
// 실행마다 바뀌는 salt — 로그의 command line 해시가 역추적/상관분석에 쓰이지 않도록.
const RUN_SALT = randomBytes(16).toString("hex");
const cmdSignature = (cmd) => createHash("sha256").update(RUN_SALT).update("\u0000").update(String(cmd ?? "")).digest("hex").slice(0, 12);

/**
 * /bin/ps 1회로 pid/ppid/lstart/command 스냅샷. 실패 시 ok:false(호출측 fail-closed).
 * lstart는 macOS/Linux ps 공통 키워드이며 `%a %b %e %H:%M:%S %Y` 5토큰이다.
 * identity = `pid@lstart` — pid 재사용을 구분하는 이식 가능한 프로세스 지문.
 */
function psSnapshot() {
  const r = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") {
    const detail = r.error?.message ?? `exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim()}` : ""}`;
    return { ok: false, error: String(detail) };
  }
  const rows = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const start = m[3].replace(/\s+/g, " ");
    rows.set(pid, { ppid, start, cmd: m[4], identity: `${pid}@${start}` });
  }
  if (rows.size === 0) return { ok: false, error: "ps 출력 파싱 실패(lstart 형식 불일치)" };
  return { ok: true, rows };
}

/** shadcn MCP command line에 일치하는 pid → {identity, cmd} (자기 자신 제외). cmd는 내부 판정/해시용이며 출력 금지. */
function matchingShadcnPids() {
  const snap = psSnapshot();
  if (!snap.ok) return { ok: false, error: snap.error };
  const m = new Map();
  for (const [pid, row] of snap.rows) {
    if (pid === OWN_PID) continue;
    if (row.cmd.includes("shadcn@4.13.1") && /(^|\s)mcp(\s|$)/.test(row.cmd)) m.set(pid, { identity: row.identity, cmd: row.cmd });
  }
  return { ok: true, map: m, rows: snap.rows };
}

/** "alive" | "gone" | "other-user"(EPERM → 우리 프로세스가 아님). */
function aliveState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return e?.code === "EPERM" ? "other-user" : "gone";
  }
}

/** pid의 cwd. linux는 /proc, 그 외는 lsof. 확인 불가 시 null. */
function pidCwd(pid) {
  if (process.platform === "linux") {
    try {
      return realpathSync(`/proc/${pid}/cwd`);
    } catch {
      /* lsof로 폴백 */
    }
  }
  for (const bin of LSOF_BINS) {
    if (!existsSync(bin)) continue;
    const r = spawnSync(bin, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0 || typeof r.stdout !== "string") continue;
    const line = r.stdout.split("\n").find((l) => l.startsWith("n"));
    if (line) return line.slice(1).trim();
  }
  return null;
}

/** ppid 체인이 이 runner에 닿는가(cycle/깊이 가드). */
function isDescendantOfRunner(pid, rows) {
  let cur = pid;
  for (let depth = 0; depth < 64; depth++) {
    const row = rows.get(cur);
    if (!row) return false;
    if (row.ppid === OWN_PID) return true;
    if (row.ppid <= 1 || row.ppid === cur) return false;
    cur = row.ppid;
  }
  return false;
}

/**
 * 관측(cwd/ppid)이 끝난 뒤 같은 identity가 여전히 살아있는지 재확인한다.
 * 사라졌으면 "gone"(잔존 아님), identity가 바뀌었으면(pid 재사용) stale 관측이므로 "unknown"(fail-closed).
 */
function revalidate(pid, identity, classification) {
  const snap = psSnapshot();
  if (!snap.ok) return "unknown";
  const row = snap.rows.get(pid);
  if (!row) return "gone";
  if (row.identity !== identity) return "unknown";
  return classification;
}

/** "owned" | "foreign" | "unknown" | "gone" — 분류 결과는 항상 동일 identity로 재검증한다. */
function ownership(pid, identity, rows) {
  if (isDescendantOfRunner(pid, rows)) return revalidate(pid, identity, "owned");
  const alive = aliveState(pid);
  if (alive === "gone") return "gone";
  if (alive === "other-user") return "foreign"; // 다른 uid → 이 runner가 만든 프로세스가 아님
  const cwd = pidCwd(pid);
  return revalidate(pid, identity, cwd === null ? "unknown" : underBase(cwd) ? "owned" : "foreign");
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
  // baseline은 pid가 아니라 identity로 기억한다 — 같은 pid의 다른 incarnation은 새 프로세스다.
  const beforeIdentities = new Map([...before.map].map(([pid, info]) => [pid, info.identity]));

  let res = null;
  try {
    res = await runShadcnReadSemanticsProbe({ serviceCwd, runtimeDir, now: () => new Date().toISOString(), redactNames: [SENT_NAME] });
  } catch (e) {
    const rawMessage = String(e?.message ?? e);
    if (rawMessage.includes(sentinel)) problems.push("probe 오류에 sentinel 평문 노출");
    console.error(`[m3c2-sem] read-semantics 실패 (${e?.code ?? "unknown"}) — ${redact(rawMessage)}`);
    problems.push(`read-semantics 실패: ${e?.code ?? "unknown"}`);
  }

  // 잔존 검사: baseline에 없던 새 pid 중 **이 runner 소유**만 잔존으로 센다.
  // 남의 프로세스(foreign)는 무시하고, 살아있는데 소유권을 확인 못 하면 FAIL로 표면화한다.
  let ownedLeftover = new Map();
  let unverified = new Map();
  for (let waited = 0; waited <= 5000; waited += 500) {
    const cur = matchingShadcnPids();
    if (!cur.ok) {
      problems.push(`polling 중 /bin/ps 실패: ${redact(cur.error)}`);
      break;
    }
    ownedLeftover = new Map();
    unverified = new Map();
    for (const [pid, info] of cur.map) {
      if (beforeIdentities.get(pid) === info.identity) continue; // probe 시작 전부터 있던 **같은** 프로세스
      const own = ownership(pid, info.identity, cur.rows);
      if (own === "owned") ownedLeftover.set(pid, info);
      else if (own === "unknown") unverified.set(pid, info);
      // foreign(임시 base 밖·우리 tree 밖)/gone은 우리 소유 잔존이 아니므로 세지 않는다.
    }
    if (ownedLeftover.size === 0 && unverified.size === 0) break;
    if (waited < 5000) await sleep(500);
  }
  // 외부 프로세스의 argv에는 남의 credential이 있을 수 있다 — command line은 출력하지 않고 run-salt 해시만 남긴다.
  for (const [pid, info] of ownedLeftover) problems.push(`shadcn MCP 프로세스 잔존(자동 kill 안 함): pid=${pid} ownership=owned sig=${cmdSignature(info.cmd)}`);
  for (const [pid, info] of unverified) problems.push(`shadcn MCP 후보 소유권/동일성 확인 실패(잔존 여부 미확인, FAIL, kill 안 함): pid=${pid} ownership=unverified sig=${cmdSignature(info.cmd)}`);

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
