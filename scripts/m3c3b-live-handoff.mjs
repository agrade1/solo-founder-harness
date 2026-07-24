#!/usr/bin/env node
/**
 * [M3c-3b LIVE ACCEPTANCE RUNNER — 수동 live acceptance 전용, 실제 Claude 구독 + npx shadcn 호출]
 *
 * 목적: filtered shadcn read profile(handoff-shadcn-readonly) handoff 경로를 실제 Claude로 1회 실측한다.
 *   production `runHandoff({ toolProfileId: "handoff-shadcn-readonly" })` 경로를 seam 없이 실행:
 *   승인 preview → 사용자 y 승인 → **profile headless preflight**(신뢰 proxy config로 shadcn connected +
 *   정확한 host 5개일 때만 통과) → 대화형 TUI(`stdio:"inherit"`). preflight 실패 시 TUI 미실행·미기록.
 *
 * 실측 대상(PASS 조건):
 *  - preflight snapshot: server 정확히 shadcn/connected, tools 정확히 host 5개(원본 7·금지 2·ambient canary 부재).
 *  - generated mcp-config: command=node, args=[PACKAGE_ROOT/dist/tools/shadcnReadMcpProxy.js], launcher/npx 필드 없음.
 *  - interactive argv: allowedTools 정확히 5개·disallowedTools 정확히 금지 2개·mcp__* 전체 deny 없음·`-- <prompt>`·(-p/stream-json 없음).
 *  - ToolTrace: profileId=handoff-shadcn-readonly, 호출된 MCP 도구 server=shadcn, tool_requested/tool_succeeded correlation,
 *    session_end 정확히 1개, raw MCP 결과·transcript_path·secret 평문 없음. 금지 2개 미관측.
 *  - serviceCwd 파일 무변경, run_state completed 불변, handoff record(tool_profile_id/config_hash/snapshot_path).
 *  - runtime/tool-trace dir 0700, config/snapshot/settings/trace 0600. ambient MCP/Hook canary 미기동.
 *  - proxy·shadcn@4.13.1·canary 잔존 프로세스 없음, 임시 디렉터리 cleanup 완료.
 *
 * 안전장치:
 *  - `HARNESS_LIVE_M3C3B=1` 없으면 거부(exit 2). npm test/CI에서 자동 실행되지 않는다(standalone).
 *  - TTY 아니면 거부(exit 2) — 대화형 세션 전용.
 *  - `claude --version` 확인(status 0 + semver) 실패 시 preflight/TUI 미실행(exit 2).
 *  - **실행 시 headless preflight + interactive Claude 구독 사용량 + `npx --yes shadcn@4.13.1 mcp`(네트워크) 발생.**
 *  - production / remote repository / billing / deploy 미접촉(임시 workspace·service repo만, `$TMPDIR/m3c3b-live-*`).
 *  - cleanup은 idempotent + signal(SIGINT/SIGTERM) 안전. canary/proxy PID는 **command-line ownership(lsof cwd) 확인 후에만** kill.
 *  - 실제 MCP 결과 원문은 출력·저장하지 않고 파생 지표만 출력.
 *
 * 선행: `npm run build`. 실행: npm run build && HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── 안전장치 1: 명시적 opt-in ──────────────────────────────────────────────
if (process.env.HARNESS_LIVE_M3C3B !== "1") {
  console.error(
    "거부: 이 runner는 실제 Claude 구독을 호출하고, filtered proxy가 `npx --yes shadcn@4.13.1 mcp`(네트워크)를 실행합니다.\n" +
      "  - headless preflight + interactive Claude 세션 + shadcn MCP로 구독 사용량·네트워크가 발생할 수 있습니다.\n" +
      "  - production / remote repo / billing / deploy 에는 접촉하지 않습니다(임시 경로만 사용).\n" +
      "실행하려면: npm run build && HARNESS_LIVE_M3C3B=1 node scripts/m3c3b-live-handoff.mjs",
  );
  process.exit(2);
}

// ── 안전장치 2: TTY 필수 (대화형 승인·TUI) ──────────────────────────────────
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("거부: 대화형 승인·TUI가 필요합니다. 사람이 보는 터미널(TTY)에서 직접 실행하세요.");
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const SERVER = join(HERE, "fixtures", "m3a", "minimal-stdio-mcp.mjs"); // ambient MCP canary fixture 재사용
const PROXY = join(HERE, "..", "dist", "tools", "shadcnReadMcpProxy.js"); // 신뢰 proxy(고정 경로) — 실존 필수

const distHandoff = join(HERE, "..", "dist", "core", "handoff.js");
for (const [p, why] of [
  [distHandoff, "dist/core/handoff.js"],
  [PROXY, "dist/tools/shadcnReadMcpProxy.js (신뢰 proxy)"],
  [SERVER, "ambient MCP canary fixture"],
]) {
  if (!existsSync(p)) {
    console.error(`필요 파일 없음(${why}): ${p} — 먼저 'npm run build'.`);
    process.exit(2);
  }
}

// ── 임시 환경: HARNESS_WORKSPACE를 dist import 이전에 설정해야 한다 ─────────────
const base = mkdtempSync(join(tmpdir(), "m3c3b-live-"));
const workspace = join(base, "workspace");
const serviceCwd = join(base, "svc");
mkdirSync(workspace, { recursive: true });
mkdirSync(serviceCwd, { recursive: true });
process.env.HARNESS_WORKSPACE = workspace;

// 외부에 절대 출력하지 않는 고유 fake sentinel. 이름이 *_TOKEN → deriveSecretRefs가 자동 파생·마스킹.
const sentinel = "m3c3bsentinel" + randomBytes(16).toString("hex");
process.env.M3C3B_LIVE_TOKEN = sentinel;
const redact = (s) => String(s ?? "").split(sentinel).join("***");

// ── canary 경로 ─────────────────────────────────────────────────────────────
const canaryMcpPidFile = join(base, "canary-mcp.pid");
const canaryHookSessionMarker = join(base, "canary-hook-sessionstart.marker");
const canaryHookPreMarker = join(base, "canary-hook-pretooluse.marker");

// ── PID 유틸 (오인 kill 방지: lsof cwd ownership 확인) ─────────────────────────
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
/** lsof로 pid의 cwd를 읽는다(ownership 확인용). 실패 시 null. */
const pidCwd = (pid) => {
  try {
    const r = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    const line = (r.stdout || "").split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1).trim() : null;
  } catch {
    return null;
  }
};
const isCanaryProcess = (pid) => {
  const cmd = psCommand(pid);
  if (!cmd) return false;
  return cmd.includes(SERVER) && cmd.includes("canary") && cmd.includes(canaryMcpPidFile);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 구조적 deep equality (key 순서 무관). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// claude --version에 넘길 명시적 env allowlist (TOKEN/KEY/SECRET/PASSWORD/AUTH·임의 LC_* 금지).
const VERSION_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "LC_ALL", "LC_CTYPE", "LC_NUMERIC", "LC_TIME", "LC_COLLATE", "LC_MONETARY",
  "LC_MESSAGES", "LC_PAPER", "LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION",
];
function versionEnv() {
  const env = {};
  for (const k of VERSION_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/** ps -A로 proxy/shadcn 후보 PID를 수집한다. ps 실패 시 ok:false(호출측이 fail-closed 처리). */
function candidatePids() {
  let r;
  try {
    r = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return { ok: false, pids: [] };
  }
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return { ok: false, pids: [] };
  const pids = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    if (m[2].includes(PROXY) || /shadcn@4\.13\.1/.test(m[2])) pids.push(pid);
  }
  return { ok: true, pids };
}

/** pid cwd 소유권: "owned"(임시 base 아래) | "foreign"(다른 곳) | "unknown"(lsof 실패). */
function ownershipUnderBase(pid) {
  const cwd = pidCwd(pid);
  if (cwd === null) return "unknown";
  return cwd === base || cwd.startsWith(base + "/") ? "owned" : "foreign";
}

/**
 * TUI 종료 후 잔존 proxy/shadcn 검사 (fail-closed). baseline에 없던 새 후보만 대상.
 *  - 최대 5초 grace polling으로 self-terminate를 기다린다.
 *  - ps 실패 → 확인 불가 FAIL(kill 안 함).
 *  - 잔존 시 lsof cwd ownership 확인: unknown/foreign → FAIL(kill 안 함), owned만 kill + 실제 사망 확인.
 */
async function checkLeftoverAfterTui(baselineSet) {
  let newPids = [];
  const start = Date.now();
  while (true) {
    const cur = candidatePids();
    if (!cur.ok) {
      problems.push("잔존 프로세스 검사 ps 실패 — 확인 불가(FAIL, kill 안 함)");
      return;
    }
    newPids = cur.pids.filter((p) => !baselineSet.has(p) && isAlive(p));
    if (newPids.length === 0) return; // self-terminate 확인됨
    if (Date.now() - start >= 5000) break;
    await sleep(500);
  }
  for (const pid of newPids) {
    if (!isAlive(pid)) continue;
    const own = ownershipUnderBase(pid);
    if (own === "unknown") {
      problems.push(`잔존 프로세스 pid ${pid} — lsof cwd 확인 실패(ownership 미확인) → kill 안 함(FAIL)`);
      continue;
    }
    if (own === "foreign") {
      problems.push(`잔존 후보 pid ${pid} — cwd가 임시 base 밖(ownership 미확인) → kill 안 함(FAIL)`);
      continue;
    }
    killPid(pid);
    await sleep(200);
    if (isAlive(pid)) problems.push(`잔존 proxy/shadcn pid ${pid}(base 소유) kill 후에도 생존(FAIL)`);
    else problems.push(`잔존 proxy/shadcn pid ${pid}(base 소유) 발견 → 종료함(FAIL: TUI 종료 후 self-terminate 실패)`);
  }
}

/** cleanup 백스톱: base 소유 잔존만 종료·기록. ps/lsof 실패도 숨기지 않고 cleanupProblems에 남긴다. */
function sweepOwnedLeftoversBackstop() {
  const cur = candidatePids();
  if (!cur.ok) {
    cleanupProblems.push("cleanup: 잔존 프로세스 검사 ps 실패(확인 불가)");
    return;
  }
  for (const pid of cur.pids) {
    if (!isAlive(pid)) continue;
    const own = ownershipUnderBase(pid);
    if (own === "owned") {
      killPid(pid);
      cleanupProblems.push(isAlive(pid) ? `cleanup: base 소유 잔존 pid ${pid} kill 후 생존` : `cleanup: base 소유 잔존 pid ${pid} 종료함(잔존이 있었음)`);
    } else if (own === "unknown") {
      cleanupProblems.push(`cleanup: 잔존 후보 pid ${pid} lsof 확인 실패(ownership 미확인, kill 안 함)`);
    }
    // foreign(임시 base 밖)은 우리 소유가 아니므로 건드리지 않는다.
  }
}

function safeCleanCanaryMcp() {
  if (!existsSync(canaryMcpPidFile)) return null;
  let raw = "";
  try {
    raw = readFileSync(canaryMcpPidFile, "utf8").trim();
  } catch {
    /* ignore */
  }
  const pid = readPid(canaryMcpPidFile);
  if (!pid) return `canary MCP pid-file 값이 비정상/빈 값('${raw}') — ownership 미확인(FAIL)`;
  if (!isAlive(pid)) return null;
  if (!isCanaryProcess(pid)) return `canary MCP pid ${pid}가 살아있으나 command 불일치 — ownership 미확인, kill 안 함(FAIL)`;
  if (!killPid(pid)) return `canary MCP pid ${pid} kill 실패 — ownership 확인됐으나 종료 실패(FAIL)`;
  return null;
}

// ── serviceCwd 파일 스냅샷(무변경 검증) ──────────────────────────────────────
function hashTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      const rel = relative(root, full);
      if (st.isSymbolicLink()) {
        entries.push(`${rel}:symlink`);
      } else if (st.isDirectory()) {
        entries.push(`${rel}/`);
        walk(full);
      } else if (st.isFile()) {
        entries.push(`${rel}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      } else {
        entries.push(`${rel}:special`);
      }
    }
  };
  walk(root);
  return entries.join("\n");
}

// ── cleanup: idempotent + signal 안전 ────────────────────────────────────────
const cleanupProblems = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const p = safeCleanCanaryMcp();
  if (p) cleanupProblems.push(p);
  sweepOwnedLeftoversBackstop(); // base 소유 잔존만 종료·기록(ps/lsof 실패도 숨기지 않음).
  try {
    rmSync(base, { recursive: true, force: true });
    if (existsSync(base)) cleanupProblems.push(`임시 디렉터리 잔존: ${base}`);
  } catch (e) {
    cleanupProblems.push(`임시 디렉터리 정리 실패: ${redact(e?.message ?? e)}`);
  }
}
function onSignal(code) {
  cleanup();
  if (cleanupProblems.length) console.error("[m3c3b-live] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
  process.exit(code);
}
process.on("SIGINT", () => onSignal(130));
process.on("SIGTERM", () => onSignal(143));

// dist 모듈 dynamic import (HARNESS_WORKSPACE 설정 이후).
const { runHandoff } = await import(distHandoff);
const { runWorkflow, loadRunState } = await import(join(HERE, "..", "dist", "core", "runWorkflow.js"));
const { projectPaths } = await import(join(HERE, "..", "dist", "core", "project.js"));
const { mockProvider } = await import(join(HERE, "..", "dist", "providers", "mockProvider.js"));
const { getAllowedTools, getForbiddenTools, nsName } = await import(join(HERE, "..", "dist", "tools", "shadcnReadPolicy.js"));
const { SHADCN_SERVER } = await import(join(HERE, "..", "dist", "tools", "shadcnPilot.js"));
const { BLOCKING_MCP_ENV } = await import(join(HERE, "..", "dist", "tools", "mcpEnv.js"));

// blocking MCP env 계약 값 사후 확인(단일 출처 상수). preflight/interactive에 강제되는 세 값이
// 기대와 다르면 실행 전 중단(exit 2). pending을 retry/성공 처리하는 로직은 추가하지 않는다.
const EXPECT_MCP_ENV = { MCP_CONNECTION_NONBLOCKING: "0", MCP_CONNECT_TIMEOUT_MS: "45000", MCP_TIMEOUT: "45000" };
for (const [k, v] of Object.entries(EXPECT_MCP_ENV)) {
  if (BLOCKING_MCP_ENV[k] !== v) {
    console.error(`[m3c3b-live] blocking MCP env 계약 값 불일치: ${k}=${redact(String(BLOCKING_MCP_ENV[k]))} (기대 ${v}) — 중단.`);
    cleanup();
    process.exit(2);
  }
}
console.log(`[m3c3b-live] blocking MCP env 계약: NONBLOCKING=0 · CONNECT_TIMEOUT_MS=45000 · MCP_TIMEOUT=45000 (proxy 30s < handshake 45s < preflight 60s).`);

const ALLOWED_HOST = getAllowedTools().map(nsName).sort();
const DENIED_HOST = getForbiddenTools().map(nsName).sort();
const CRED = /(?:authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|credential)\s*[:=]/i;
const mode = (p) => statSync(p).mode & 0o777;

const project = "m3c3b-live-project";
const projPaths = projectPaths(project);
const contextRoot = projPaths.root;
const serviceWorklog = join(serviceCwd, "docs", "WORKLOG.md");

const problems = [];
let exitCode = 0;
let spawnedVerified = false;

function checkCanaries() {
  if (existsSync(canaryMcpPidFile)) problems.push("ambient MCP canary 기동됨(pid-file 존재) — strict MCP 격리 실패");
  const mcpProblem = safeCleanCanaryMcp();
  if (mcpProblem) problems.push(mcpProblem);
  if (existsSync(canaryHookSessionMarker)) problems.push('ambient Hook canary(SessionStart) 실행됨 — --setting-sources "" 격리 실패');
  if (existsSync(canaryHookPreMarker)) problems.push('ambient Hook canary(PreToolUse) 실행됨 — --setting-sources "" 격리 실패');
}

try {
  // ── completed harness project (mock provider, 무과금) ──────────────────────
  const paths = projectPaths(project);
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- M3c-3b live acceptance(shadcn read) 테스트 아이디어\n", "utf8");
  const wf = await runWorkflow({ workflowId: "idea-validation", project, provider: mockProvider, now: () => new Date().toISOString() });
  if (wf.state.status !== "completed") {
    console.error(`[m3c3b-live] harness project가 completed 아님: ${wf.state.status} — 중단.`);
    exitCode = 1;
    throw new Error("project_not_completed");
  }

  // ── TUI 지시 안정화: 06_CEO_DECISION.md를 shadcn read acceptance 절차로 덮어쓴다. ──
  writeFileSync(
    join(paths.docs, "06_CEO_DECISION.md"),
    [
      "# 06 CEO Decision — M3c-3b LIVE ACCEPTANCE OVERRIDE (shadcn read)",
      "",
      "## Main Judgment",
      "- 이 세션은 filtered shadcn read profile live acceptance 검증 전용이다. 신규 MVP 기능·파일 수정은 하지 않는다.",
      "",
      "## Recommended Next Actions",
      '- 먼저 계획만 제시하고, 사용자가 "계획 승인, live acceptance 절차만 진행"이라고 답할 때까지 어떤 파일도 수정하지 않는다.',
      "- 승인 후, `mcp__shadcn__get_project_registries` 도구를 인자 없이 호출한다.",
      '- `mcp__shadcn__search_items_in_registries` 를 registries ["@shadcn"], types ["ui"], query "button", limit 1, offset 0 으로 호출한다.',
      '- `mcp__shadcn__view_items_in_registries` 를 items ["@shadcn/button"] 으로 호출한다.',
      "- `mcp__shadcn__get_add_command_for_items` 와 `mcp__shadcn__get_audit_checklist` 는 **호출하지 않는다**.",
      "- 어떤 파일도 생성·수정하지 않는다(특히 serviceCwd 아래 docs/). 결과 요약도 짧게만. 절차가 끝나면 `/exit` 로 종료한다.",
      "",
    ].join("\n"),
    "utf8",
  );

  // ── service repo: 통제된 AGENTS.md / CLAUDE.md. custom registry 없음(components.json 미생성 → 표준). ──
  writeFileSync(join(serviceCwd, "AGENTS.md"), "# AGENTS.md (m3c3b live fixture)\n\n임시 레포. 파일 수정 전 사용자 승인. shadcn read acceptance 절차만.\n", "utf8");
  writeFileSync(join(serviceCwd, "CLAUDE.md"), "# CLAUDE.md (m3c3b live fixture)\n\n먼저 계획만 제시. 06_CEO_DECISION.md의 shadcn read 절차만 수행. 파일 수정 금지.\n", "utf8");

  // ── ambient MCP canary: service repo .mcp.json (strict 격리 시 미기동) ──────
  writeFileSync(
    join(serviceCwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { canary: { command: NODE, args: [SERVER, "canary", "canary_tool", canaryMcpPidFile] } } }, null, 2) + "\n",
    "utf8",
  );

  // ── ambient Hook canary: project .claude/settings.json (--setting-sources ""로 미실행) ──
  const claudeDir = join(serviceCwd, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const canaryHook = join(claudeDir, "canary-hook.mjs");
  writeFileSync(canaryHook, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "AMBIENT CANARY HOOK EXECUTED\\n");\n`, "utf8");
  const canaryCmd = (marker) => ({ type: "command", command: NODE, args: [canaryHook, marker] });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [canaryCmd(canaryHookSessionMarker)] }], PreToolUse: [{ matcher: "*", hooks: [canaryCmd(canaryHookPreMarker)] }] } }, null, 2) + "\n",
    "utf8",
  );

  // ── 안전장치 3: claude --version (명시적 env allowlist·timeout·maxBuffer, redaction) ──
  const claudeBin = process.env.HARNESS_CLAUDE_BIN ?? "claude";
  const ver = spawnSync(claudeBin, ["--version"], { encoding: "utf8", env: versionEnv(), timeout: 10_000, maxBuffer: 64 * 1024 });
  const verOut = (ver.stdout || "").trim();
  const SEMVER = /\b\d+\.\d+\.\d+\b/;
  if (ver.error || ver.status !== 0 || !verOut || !SEMVER.test(verOut)) {
    console.error(`[m3c3b-live] '${redact(claudeBin)} --version' 확인 실패 — preflight/TUI 미실행(fail-closed).`);
    console.error("  stdout:", redact(verOut) || "(빈 출력)");
    console.error("  stderr:", redact((ver.stderr || "").trim()) || "(없음)");
    if (ver.error) console.error("  error:", redact(ver.error.message ?? String(ver.error)));
    if (ver.signal) console.error("  signal:", redact(ver.signal)); // timeout 등
    exitCode = 2;
    throw new Error("version_check_failed");
  }
  console.log(`[m3c3b-live] claude 버전: ${redact(verOut)} (bin='${redact(claudeBin)}')`);

  // ── 실행 전 안내 (사용량·네트워크 가능성 명시) ──────────────────────────────
  console.log("\n========================================================================");
  console.log("[m3c3b-live] M3c-3b filtered shadcn read profile LIVE ACCEPTANCE");
  console.log("주의: 실제 Claude 구독(headless preflight + 대화형 세션) + filtered proxy가 `npx --yes shadcn@4.13.1 mcp`(네트워크)를 실행합니다.");
  console.log("      → 구독 사용량·네트워크 트래픽이 발생할 수 있습니다. production/remote/billing/deploy 미접촉(임시 경로 전용).");
  console.log("------------------------------------------------------------------------");
  console.log("승인 프롬프트에서 y 를 입력하면 profile headless preflight(shadcn 5개 도구 확인) 후 대화형 세션이 열립니다.");
  console.log("세션에서 아래 절차만 수행하세요:");
  console.log('  0) [계획 승인] Claude가 계획을 제시하면 "계획 승인, live acceptance 절차만 진행" 이라고 입력.');
  console.log("  1) mcp__shadcn__get_project_registries (인자 없음) 호출");
  console.log('  2) mcp__shadcn__search_items_in_registries { registries:["@shadcn"], types:["ui"], query:"button", limit:1, offset:0 }');
  console.log('  3) mcp__shadcn__view_items_in_registries { items:["@shadcn/button"] }');
  console.log("  4) 파일 수정 없이 /exit  (get_add_command_for_items·get_audit_checklist 는 호출 금지)");
  console.log("  ※ 5개 도구는 preapproved라 권한 프롬프트 없이 실행됩니다. 결과 원문은 이 runner가 저장/출력하지 않습니다.");
  console.log("========================================================================\n");

  // ── 잔존 프로세스 baseline (spawn 전). ps 실패 시 실행 시작 전 중단(fail-closed). ──
  const baseline0 = candidatePids();
  if (!baseline0.ok) {
    console.error("[m3c3b-live] 잔존 프로세스 baseline 수집(ps) 실패 — 실행 시작 전 중단(fail-closed, preflight/TUI 미실행).");
    exitCode = 2;
    throw new Error("ps_baseline_failed");
  }
  const baselineSet = new Set(baseline0.pids);

  // serviceCwd 스냅샷 (spawn 직전). runHandoff는 outputs(contextRoot)만 건드리므로 serviceCwd는 불변이어야 한다.
  const svcBefore = hashTree(serviceCwd);

  // ── runHandoff production 경로 (profile 지정, seam 없음) ─────────────────────
  const outcome = await runHandoff({ project, cwd: serviceCwd, toolProfileId: "handoff-shadcn-readonly" });
  if (JSON.stringify(outcome).includes(sentinel)) problems.push("outcome에 sentinel 평문 노출");

  if (outcome.action !== "spawned") {
    if (outcome.action === "preflight_failed") {
      // scrub된 outcome.message(status 포함)만 출력 — raw init/stderr/result는 출력하지 않는다.
      console.error(`[m3c3b-live] preflight 실패(${outcome.code}) — TUI 미실행(fail-closed).`);
      console.error("  message:", redact(outcome.message) || "(없음)");
      const st = loadRunState(project);
      if (st && st.handoff) problems.push("preflight 실패인데 run_state.handoff 기록됨(fail-closed 위반)");
    } else if (outcome.action === "profile_rejected" || outcome.action === "registry_rejected") {
      console.error(`[m3c3b-live] ${outcome.action} — 세션 미실행(fail-closed).`);
    } else if (outcome.action === "rejected") {
      console.log("[m3c3b-live] 승인 거부됨 — 세션 미실행(정상). acceptance 미완료.");
    } else {
      console.error(`[m3c3b-live] 세션 미실행 outcome: ${outcome.action}.`);
    }
    checkCanaries();
    exitCode = exitCode || 1;
    throw new Error("not_spawned");
  }

  // ── 사후 검증 ────────────────────────────────────────────────────────────
  const { argv, runtimeDir, tracePath, settingsPath, mcpConfigPath, handoff } = outcome;
  const snapshotPath = join(runtimeDir, "tools-snapshot.json");

  // (a) interactive argv.
  for (const banned of ["-p", "stream-json", "--output-format"]) if (argv.includes(banned)) problems.push(`interactive argv에 금지 인자 '${banned}'`);
  for (const need of ["--strict-mcp-config", "--mcp-config", "--settings", "--setting-sources", "--add-dir", "--allowedTools", "--disallowedTools"]) {
    if (!argv.includes(need)) problems.push(`interactive argv에 필요한 인자 '${need}' 누락`);
  }
  if (argv[argv.indexOf("--allowedTools") + 1] !== ALLOWED_HOST.join(",")) problems.push("--allowedTools 값이 정확한 host 5개 아님");
  if (argv[argv.indexOf("--disallowedTools") + 1] !== DENIED_HOST.join(",")) problems.push("--disallowedTools 값이 정확한 금지 2개 아님");
  if (argv.includes("mcp__*")) problems.push("profile 경로에 mcp__* 전체 deny 토큰 존재(금지)");
  if (argv[argv.indexOf("--setting-sources") + 1] !== "") problems.push('--setting-sources 값이 빈 문자열 아님');
  if (argv[argv.indexOf("--add-dir") + 1] !== contextRoot) problems.push("--add-dir 값이 contextRoot 아님");
  if (argv.at(-2) !== "--") problems.push('interactive argv 끝에서 두 번째가 "--" 아님');
  if (argv.filter((a) => a === "--").length !== 1) problems.push('"--" 구분자가 정확히 1개 아님');
  const lastArg = String(argv.at(-1) ?? "");
  if (!/live acceptance/i.test(lastArg)) problems.push("마지막 인자(initialPrompt)에 live acceptance 지시 없음");

  // (b) generated mcp-config: node + 고정 proxy exact deepEqual, launcher/npx 필드 없음.
  const cfgText = existsSync(mcpConfigPath) ? readFileSync(mcpConfigPath, "utf8") : "";
  let cfg = null;
  try {
    cfg = JSON.parse(cfgText);
  } catch {
    problems.push("mcp-config.json 파싱 실패");
  }
  const expectedCfg = { mcpServers: { [SHADCN_SERVER]: { command: NODE, args: [PROXY], alwaysLoad: true } } };
  if (cfg && !deepEqual(cfg, expectedCfg)) problems.push(`mcp-config가 기대 config와 정확히 일치하지 않음: ${JSON.stringify(cfg)}`);
  if (/\blauncher\b/.test(cfgText)) problems.push("mcp-config에 launcher 논리 필드 존재(금지)");
  if (/\bnpx\b/.test(cfgText)) problems.push("mcp-config에 npx 직접 실행 필드 존재(금지)");
  // config 파일 바이트 sha256 — snapshot/outcome/run_state의 config_hash와 모두 동일해야 한다(아래 (i)에서 대조).
  const cfgHash = existsSync(mcpConfigPath) ? createHash("sha256").update(readFileSync(mcpConfigPath)).digest("hex") : "";

  // (c) preflight snapshot: shadcn/connected + 정확한 host 5개, 원본7·금지2·canary 부재.
  const snapText = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
  let snap = null;
  try {
    snap = JSON.parse(snapText);
  } catch {
    problems.push("tools-snapshot.json 파싱 실패");
  }
  if (snap) {
    const servers = snap.servers ?? [];
    if (servers.length !== 1 || servers[0]?.name !== SHADCN_SERVER) problems.push(`snapshot server가 정확히 [${SHADCN_SERVER}] 아님: ${JSON.stringify(servers.map((s) => s.name))}`);
    else if (servers[0].status !== "connected") problems.push(`snapshot shadcn status가 정확히 "connected" 아님: ${servers[0].status}`);
    const tools = [...(snap.tools ?? [])].sort();
    if (JSON.stringify(tools) !== JSON.stringify(ALLOWED_HOST)) problems.push(`snapshot tools가 정확한 host 5개 아님: ${JSON.stringify(tools)}`);
    for (const d of DENIED_HOST) if (tools.includes(d)) problems.push(`snapshot에 금지 도구 노출: ${d}`);
    if (tools.some((t) => t.includes("canary"))) problems.push("snapshot에 ambient canary 도구 노출");
  }

  // (d) trace.
  const traceText = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  const lines = traceText.split("\n").filter((l) => l.trim().length > 0);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      problems.push(`trace ${i + 1}번째 줄 JSON 무효`);
    }
    if (/\btranscript_path\b/.test(lines[i])) problems.push(`trace ${i + 1}번째 줄에 transcript_path 저장(금지)`);
    if (/"tool_response"\s*:/.test(lines[i])) problems.push(`trace ${i + 1}번째 줄에 raw tool_response 저장(금지)`);
  }
  if (records.length === 0) problems.push("trace가 비어 있음 — Hook 미관측");
  if (records.some((r) => r.profileId !== "handoff-shadcn-readonly")) problems.push("일부 record profileId≠handoff-shadcn-readonly");
  const sids = new Set(records.map((r) => r.sessionId));
  if (records.length && sids.size !== 1) problems.push(`sessionId 종류 ${sids.size}개(정확히 1 기대)`);

  const reqsOf = (toolName) => records.filter((r) => r.event === "tool_requested" && r.toolName === toolName);
  const byCallId = (event, callId) => records.filter((r) => r.event === event && r.callId === callId);
  const inp = (r) => (r && r.sanitizedInput && typeof r.sanitizedInput === "object" ? r.sanitizedInput : {});

  // preapproved 실측: 계획된 3개는 각각 정확히 1개 tool_requested + 동일 callId tool_succeeded,
  // 해당 callId에 tool_failed/tool_denied 없음, sanitizedInput이 지시 인자와 정확 일치.
  const PLAN = [
    ["get_project_registries", {}],
    ["search_items_in_registries", { registries: ["@shadcn"], types: ["ui"], query: "button", limit: 1, offset: 0 }],
    ["view_items_in_registries", { items: ["@shadcn/button"] }],
  ];
  const plannedHosts = new Set(PLAN.map(([b]) => nsName(b)));
  for (const [bare, expectedArgs] of PLAN) {
    const host = nsName(bare);
    const reqs = reqsOf(host);
    if (reqs.length !== 1) {
      problems.push(`preapproved 실측: ${host} tool_requested가 정확히 1개 아님(${reqs.length}개)`);
      continue;
    }
    const req = reqs[0];
    if (req.server !== SHADCN_SERVER) problems.push(`${host} tool_requested server≠shadcn: ${req.server}`);
    if (!req.callId) {
      problems.push(`${host} tool_requested callId가 null`);
      continue;
    }
    if (!deepEqual(inp(req), expectedArgs)) problems.push(`${host} sanitizedInput이 지시 인자와 불일치: ${redact(JSON.stringify(inp(req)))}`);
    const succ = byCallId("tool_succeeded", req.callId).filter((r) => r.toolName === host);
    if (succ.length !== 1) problems.push(`${host} 동일 callId의 tool_succeeded가 정확히 1개 아님(${succ.length}개)`);
    else if (succ[0].server !== SHADCN_SERVER) problems.push(`${host} tool_succeeded server≠shadcn`);
    if (byCallId("tool_failed", req.callId).length) problems.push(`${host} callId에 tool_failed 존재 — preapproved 실패 은폐 위험(FAIL)`);
    if (byCallId("tool_denied", req.callId).length) problems.push(`${host} callId에 tool_denied 존재(FAIL)`);
  }
  // preapproved 3개에 PermissionRequest가 한 건이라도 있으면 FAIL(수동 승인이 --allowedTools 실패를 가릴 수 있음).
  for (const r of records.filter((x) => x.event === "permission_requested")) {
    if (plannedHosts.has(r.toolName)) problems.push(`preapproved 도구 ${r.toolName}에 permission_requested 발생 — --allowedTools 실패가 수동 승인으로 가려짐(FAIL)`);
  }
  // 계획된 3개 외 MCP tool_requested가 있으면 FAIL(금지 2개 포함, 그 외 mcp__* 전부).
  for (const r of records.filter((x) => x.event === "tool_requested" && String(x.toolName).startsWith("mcp__"))) {
    if (!plannedHosts.has(r.toolName)) problems.push(`계획 외 MCP tool_requested: ${r.toolName}(FAIL)`);
  }
  // 금지 2개는 trace 어디에도 없어야 한다(명시적 재확인).
  for (const d of DENIED_HOST) if (records.some((r) => r.toolName === d)) problems.push(`금지 도구가 trace에 관측됨: ${d}`);
  // session_end 정확히 1개.
  const ends = records.filter((r) => r.event === "session_end");
  if (ends.length !== 1) problems.push(`session_end가 정확히 1개 아님: ${ends.length}개`);

  // (e) ambient canary 미기동(strict + --setting-sources ""), interactive 동안 포함.
  checkCanaries();

  // (e2) 잔존 proxy/shadcn 프로세스 검사 (baseline 대비 새 후보만, 5초 grace, ownership 확인 후에만 kill).
  await checkLeftoverAfterTui(baselineSet);

  // (f) serviceCwd 파일 무변경.
  const svcAfter = hashTree(serviceCwd);
  if (svcAfter !== svcBefore) problems.push("serviceCwd 파일이 변경됨(무변경 위반) — 세션이 파일을 수정함");
  if (existsSync(serviceWorklog)) problems.push(`serviceCwd에 docs/WORKLOG.md 생성됨(${serviceWorklog})`);

  // (g) sentinel/credential 평문 부재.
  for (const [name, txt] of [["settings", existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : ""], ["mcp-config", cfgText], ["snapshot", snapText], ["trace", traceText]]) {
    if (txt.includes(sentinel)) problems.push(`${name}에 sentinel 평문 노출`);
  }
  for (const [name, txt] of [["mcp-config", cfgText], ["snapshot", snapText]]) {
    if (txt && CRED.test(txt)) problems.push(`${name}에 credential 형태 평문(보조 검사)`);
  }

  // (h) 파일·디렉터리 최소 권한.
  const modeChecks = [
    [runtimeDir, 0o700, "runtime dir"],
    [dirname(tracePath), 0o700, "tool-trace dir"],
    [settingsPath, 0o600, "hook-settings"],
    [tracePath, 0o600, "trace"],
    [mcpConfigPath, 0o600, "mcp-config"],
    [snapshotPath, 0o600, "tools-snapshot"],
  ];
  for (const [p, want, label] of modeChecks) {
    if (!existsSync(p)) {
      problems.push(`${label} 파일 부재: ${p}`);
      continue;
    }
    const m = mode(p);
    if (m !== want) problems.push(`${label} 권한 ${m.toString(8)} (기대 ${want.toString(8)})`);
  }

  // (i) run_state.handoff 기록 + completed 불변 + profile 필드 + artifact 연결(config_hash 체인·snapshot_path).
  const st = loadRunState(project);
  if (!st) problems.push("run_state 로드 실패");
  else {
    if (st.status !== "completed") problems.push(`completed 상태 변경됨: ${st.status}`);
    if (!st.handoff) problems.push("run_state.handoff 미기록(spawn됐는데)");
    else {
      if (st.handoff.tool_profile_id !== "handoff-shadcn-readonly") problems.push("handoff.tool_profile_id 불일치");
      // config_hash 체인: mcp-config 파일 sha256 == snapshot.configHash == outcome.handoff.config_hash == run_state.handoff.config_hash.
      if (!cfgHash || cfgHash.length !== 64) problems.push("mcp-config 파일 sha256 계산 실패");
      else {
        for (const [label, v] of [
          ["snapshot.configHash", snap?.configHash],
          ["outcome.handoff.config_hash", handoff?.config_hash],
          ["run_state.handoff.config_hash", st.handoff.config_hash],
        ]) {
          if (v !== cfgHash) problems.push(`config_hash 불일치: ${label}=${String(v).slice(0, 12)}… ≠ 파일 sha256 ${cfgHash.slice(0, 12)}…`);
        }
      }
      // snapshot_path: outcome.handoff와 run_state.handoff가 동일하고 실제 snapshotPath와 일치.
      if (handoff?.snapshot_path !== snapshotPath) problems.push("outcome.handoff.snapshot_path ≠ 실제 snapshotPath");
      if (st.handoff.snapshot_path !== snapshotPath) problems.push("run_state.handoff.snapshot_path ≠ 실제 snapshotPath");
      if (handoff?.snapshot_path !== st.handoff.snapshot_path) problems.push("outcome/run_state handoff.snapshot_path 불일치");
    }
  }

  // 파생 지표만 출력(원문 없음).
  console.log(`[m3c3b-live] 파생 지표: trace records=${records.length}, MCP tool_requested=${records.filter((r) => r.event === "tool_requested" && String(r.toolName).startsWith("mcp__")).length}, session_end=${ends.length}, snapshot tools=${(snap?.tools ?? []).length}`);

  spawnedVerified = true;
} catch (e) {
  const msg = redact(String(e?.message ?? e));
  if (!["not_spawned", "project_not_completed", "version_check_failed", "ps_baseline_failed"].includes(msg)) {
    console.error("[m3c3b-live] 예기치 못한 오류:", msg);
    exitCode = exitCode || 1;
  }
} finally {
  cleanup();
  const allProblems = [...problems, ...cleanupProblems];
  if (spawnedVerified) {
    if (allProblems.length) {
      console.error("\n[m3c3b-live] FAIL:\n - " + allProblems.map(redact).join("\n - "));
      exitCode = 1;
    } else {
      console.log(
        "\n[m3c3b-live] PASS — preflight(shadcn status==='connected' + host 5개 exact, 원본7·금지2·canary 부재) · " +
          "mcp-config deepEqual(node + 고정 proxy, launcher/npx 없음) · config_hash 체인(파일 sha256==snapshot==outcome==run_state) · snapshot_path 일치 · " +
          "interactive argv(allowed 5·denied 2·mcp__* 없음·-- 꼬리·-p/stream-json 없음) · " +
          "preapproved 실측(3개 각 tool_requested 1 + 동일 callId succeeded, failed/denied/permission 없음, sanitizedInput 정확 일치, 계획 외 mcp__* 없음) · " +
          "ToolTrace(profileId·server=shadcn·session_end 1·원문/transcript/secret 없음) · serviceCwd 무변경 · run_state completed 불변 · 권한(dir700/file600) · " +
          "ambient MCP/Hook canary 미기동 · 잔존 proxy/shadcn/canary 없음(baseline+grace, ownership 확인 후 kill) · cleanup 완료.",
      );
    }
  } else if (allProblems.length) {
    console.error("\n[m3c3b-live] 문제 발견:\n - " + allProblems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  }
  console.log(`[m3c3b-live] 종료 (exit ${exitCode}).`);
  process.exit(exitCode);
}
