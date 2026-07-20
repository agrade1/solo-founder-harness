#!/usr/bin/env node
/**
 * [M3b.2 LIVE ACCEPTANCE RUNNER — 수동 live acceptance 전용, 실제 Claude 구독 호출]
 *
 * 목적: M3b.2 interactive handoff의 **empty MCP headless preflight + 대화형(TUI) Hook 경로**를
 *       실제 Claude로 1회 실측한다. (M3a는 non-empty MCP strict 격리를 이미 실측 통과했다 —
 *       이 runner는 그와 별개로 아직 live 미검증인 empty MCP/settings/Hook 대화형 경로를 검증한다.)
 *
 * 실측 대상:
 *  - `runHandoff` production 경로 그대로: 승인 preview → 사용자 y 승인 → empty MCP headless preflight →
 *    interactive TUI(`stdio:"inherit"`). `-p`/stream-json/`--output-format`은 대화형 argv에 쓰지 않는다.
 *  - preflight 실패 시 fail-closed: TUI 미실행, run_state.handoff 미기록.
 *  - empty MCP preflight snapshot(servers=[]/tools=[]) + mcp-config(mcpServers={}) 정확 확인.
 *  - ambient MCP canary(.mcp.json, minimal-stdio-mcp fixture): strict 격리로 미기동(pid-file 부재).
 *  - ambient Hook canary(.claude/settings.json, exec form, SessionStart+PreToolUse): --setting-sources ""로 미실행(marker 부재).
 *  - 시나리오별 trace 조합 + callId correlation(Read 성공/실패, Bash 승인, Write 수동 거부, SessionEnd)과 trace 공통 계약.
 *  - sentinel/credential 평문 부재, 파일 권한, 원문 미저장, run_state.handoff 기록·completed 불변, 리소스 정리.
 *
 * 안전장치:
 *  - `HARNESS_LIVE_M3B2=1` 없으면 실행 거부(exit 2). npm test/CI에서는 호출되지 않는다(standalone).
 *  - TTY가 아니면 거부(exit 2) — 대화형 세션 전용.
 *  - `claude --version` 확인(status 0 + 비어있지 않음 + semver X.Y.Z 포함) 실패 시 preflight/TUI 미실행(exit 2).
 *  - **실제 실행 시 headless preflight + interactive Claude 구독 사용량이 발생할 수 있다.**
 *  - production / remote repository / billing / deploy 에는 절대 접촉하지 않는다(임시 workspace·service repo만 사용).
 *  - cleanup은 idempotent하며 exit/SIGINT/SIGTERM에서도 임시 디렉터리·canary PID를 정리한다.
 *  - canary PID는 command line ownership 확인 후에만 kill한다(오인 kill 방지). 확인 실패는 FAIL.
 *
 * 선행: `npm run build` (dist 사용). 수동 실행 전용.
 * 실행: npm run build && HARNESS_LIVE_M3B2=1 node scripts/m3b2-live-handoff.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 안전장치 1: 명시적 opt-in ──────────────────────────────────────────────
if (process.env.HARNESS_LIVE_M3B2 !== "1") {
  console.error(
    "거부: 이 runner는 실제 Claude 구독을 호출하고 대화형 TUI를 엽니다.\n" +
      "  - headless preflight + interactive Claude 세션으로 구독 사용량이 발생할 수 있습니다.\n" +
      "  - production / remote repo / billing / deploy 에는 접촉하지 않습니다(임시 경로만 사용).\n" +
      "실행하려면: npm run build && HARNESS_LIVE_M3B2=1 node scripts/m3b2-live-handoff.mjs",
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

const distHandoff = join(HERE, "..", "dist", "core", "handoff.js");
if (!existsSync(distHandoff)) {
  console.error(`빌드가 필요합니다: ${distHandoff} 없음 — 먼저 'npm run build'.`);
  process.exit(2);
}
if (!existsSync(SERVER)) {
  console.error(`ambient MCP canary fixture 없음: ${SERVER}`);
  process.exit(2);
}

// ── 임시 환경: HARNESS_WORKSPACE를 dist import 이전에 설정해야 한다 ─────────────
// (paths.ts의 WORKSPACE_ROOT는 모듈 로드 시점에 한 번 계산된다.)
const base = mkdtempSync(join(tmpdir(), "m3b2-live-"));
const workspace = join(base, "workspace");
const serviceCwd = join(base, "svc");
mkdirSync(workspace, { recursive: true });
mkdirSync(serviceCwd, { recursive: true });
process.env.HARNESS_WORKSPACE = workspace;

// 외부에 절대 출력하지 않는 고유 fake sentinel. 이름이 *_TOKEN → deriveSecretRefs가 자동 파생·마스킹.
const sentinel = "m3b2sentinel" + randomBytes(16).toString("hex");
process.env.M3B2_LIVE_TOKEN = sentinel;
const redact = (s) => String(s ?? "").split(sentinel).join("***");

// ── canary 경로 ─────────────────────────────────────────────────────────────
const canaryMcpPidFile = join(base, "canary-mcp.pid"); // ambient MCP canary 기동 시 pid 기록
const canaryHookSessionMarker = join(base, "canary-hook-sessionstart.marker"); // ambient Hook(SessionStart) 실행 시 생성
const canaryHookPreMarker = join(base, "canary-hook-pretooluse.marker"); // ambient Hook(PreToolUse) 실행 시 생성

// ── PID 유틸 (오인 kill 방지) ────────────────────────────────────────────────
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** SIGKILL. 성공/이미종료(ESRCH)면 true, 권한 등 실패면 false. */
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
    if (!/^[1-9]\d*$/.test(raw)) return 0; // 양의 정수만 (선행0/음수/비정수 거부)
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : 0;
  } catch {
    return 0;
  }
};
/** `/bin/ps`로 실제 command line을 읽는다. 실패 시 null. */
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
/** command line이 우리 canary MCP(fixture 경로 + canary 라벨 + 고유 pid-file 경로)를 모두 포함하는지. */
const isCanaryProcess = (pid) => {
  const cmd = psCommand(pid);
  if (!cmd) return false;
  return cmd.includes(SERVER) && cmd.includes("canary") && cmd.includes(canaryMcpPidFile);
};

/**
 * canary MCP pid-file을 안전하게 처리한다 (checkCanaries·cleanup 공용).
 * ownership이 확인된 살아있는 프로세스만 kill한다. 반환 problem(문자열)이 있으면 FAIL로 기록해야 한다.
 *  - pid-file 부재: null (정상, 미기동)
 *  - 비정상/빈 PID 값: FAIL
 *  - 살아있으나 command 불일치: stale/reused PID 또는 ownership 미확인 → kill 안 함, FAIL
 *  - kill 실패(EPERM 등): FAIL
 */
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
  if (!isAlive(pid)) return null; // 이미 종료 (기동 사실 자체는 checkCanaries가 격리 실패로 별도 기록)
  if (!isCanaryProcess(pid)) return `canary MCP pid ${pid}가 살아있으나 command 불일치 — stale/reused PID 또는 ownership 미확인, kill 안 함(FAIL)`;
  if (!killPid(pid)) return `canary MCP pid ${pid} kill 실패(권한 등) — ownership 확인됐으나 종료 실패(FAIL)`;
  return null;
}

// ── cleanup: idempotent + signal 안전. kill/정리 실패를 숨기지 않고 별도 기록. ──
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
  if (cleanupProblems.length) console.error("[m3b2-live] cleanup 문제:\n - " + cleanupProblems.map(redact).join("\n - "));
  process.exit(code);
}
process.on("SIGINT", () => onSignal(130));
process.on("SIGTERM", () => onSignal(143));

// dist 모듈 dynamic import (HARNESS_WORKSPACE 설정 이후).
const { runHandoff } = await import(distHandoff);
const { runWorkflow, loadRunState } = await import(join(HERE, "..", "dist", "core", "runWorkflow.js"));
const { projectPaths } = await import(join(HERE, "..", "dist", "core", "project.js"));
const { mockProvider } = await import(join(HERE, "..", "dist", "providers", "mockProvider.js"));
const { SUPPORTED_HOOKS } = await import(join(HERE, "..", "dist", "tools", "hookSettings.js"));

// credential 형태 보조 검사(config/settings/snapshot 전용 — trace는 정당한 tool-input 텍스트가 있어 제외).
const CRED = /(?:authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|credential)\s*[:=]/i;
const mode = (p) => statSync(p).mode & 0o777;

const project = "m3b2-live-project";
const projPaths = projectPaths(project);
const contextRoot = projPaths.root; // planning contextRoot (--add-dir 대상). serviceCwd와 별개.
const ideaDoc = join(projPaths.docs, "00_IDEA.md"); // planning 문서 (contextRoot 기준 절대경로)
const ceoDoc = join(projPaths.docs, "06_CEO_DECISION.md"); // planning 문서
const readOk = join(serviceCwd, "read-me.txt");
const readMissing = join(serviceCwd, "does-not-exist.txt");
const rejectMarker = join(serviceCwd, "REJECT_MARKER.txt");
const serviceWorklog = join(serviceCwd, "docs", "WORKLOG.md"); // 생성되면 P0-1 경로 단절 재현(FAIL)

const problems = [];
let exitCode = 0;
let spawnedVerified = false; // spawned 사후 검증까지 도달했는지 (finally에서 PASS 판정 조건)

/** ambient MCP/Hook canary가 기동/실행됐으면 FAIL. spawned·non-spawned 양쪽에서 호출한다. */
function checkCanaries() {
  if (existsSync(canaryMcpPidFile)) problems.push("ambient MCP canary 기동됨(pid-file 존재) — strict MCP 격리 실패");
  const mcpProblem = safeCleanCanaryMcp(); // checkCanaries·cleanup 공용 안전 검증
  if (mcpProblem) problems.push(mcpProblem);
  if (existsSync(canaryHookSessionMarker)) problems.push('ambient Hook canary(SessionStart) 실행됨 — --setting-sources "" 격리 실패');
  if (existsSync(canaryHookPreMarker)) problems.push('ambient Hook canary(PreToolUse) 실행됨 — --setting-sources "" 격리 실패');
}

try {
  // ── completed harness project (mock provider, 무과금) ──────────────────────
  const paths = projectPaths(project);
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- M3b.2 live acceptance 테스트 아이디어\n", "utf8");
  const wf = await runWorkflow({ workflowId: "idea-validation", project, provider: mockProvider, now: () => new Date().toISOString() });
  if (wf.state.status !== "completed") {
    console.error(`[m3b2-live] harness project가 completed 아님: ${wf.state.status} — 중단.`);
    exitCode = 1;
    throw new Error("project_not_completed");
  }

  // ── TUI 지시 안정화: 06_CEO_DECISION.md의 Recommended Next Actions를 live acceptance 전용으로 덮어쓴다. ──
  //    initialPrompt(task prompt)는 이 섹션의 bullet을 "작업"으로 삼으므로, 다른 MVP 작업을 지시하지 않게 된다.
  writeFileSync(
    join(paths.docs, "06_CEO_DECISION.md"),
    [
      "# 06 CEO Decision — M3b.2 LIVE ACCEPTANCE OVERRIDE",
      "",
      "## Main Judgment",
      "- 이 세션은 M3b.2 live acceptance 검증 전용이다. 신규 MVP 기능이나 다른 작업은 수행하지 않는다.",
      "",
      "## Recommended Next Actions",
      '- 먼저 계획만 제시하고, 사용자가 "계획 승인, live acceptance 절차만 진행"이라고 답할 때까지 어떤 파일도 수정하지 않는다.',
      `- 승인 후, Read 도구로 planning 문서 절대경로 \`${ideaDoc}\` 를 읽는다(성공해야 함).`,
      `- Read 도구로 planning 문서 절대경로 \`${ceoDoc}\` 를 읽는다(성공해야 함).`,
      `- Read 도구로 서비스 레포 파일 \`${readOk}\` 를 읽는다(성공해야 함).`,
      `- Read 도구로 존재하지 않는 파일 \`${readMissing}\` 를 읽어 실패를 확인한다.`,
      "- Bash 도구로 `node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'` 실행을 요청하고, 권한 승인을 받아 실행한다. 이 명령은 값을 **출력하지 않고** 존재만 확인한다 — sentinel 값을 절대 출력·기록하지 마라.",
      `- Write 도구로 \`${rejectMarker}\` 에 아무 내용이나 쓰기를 요청한다(사용자가 거부할 것이다 — 거부되면 그대로 둔다).`,
      "- 위 절차 외의 파일은 수정하지 않는다. 특히 serviceCwd 아래에 docs/ 나 docs/WORKLOG.md 를 만들지 않는다. 절차가 끝나면 사용자에게 /exit 로 종료하라고 안내한다.",
      "",
    ].join("\n"),
    "utf8",
  );

  // ── service repo: 통제된 AGENTS.md / CLAUDE.md + read 성공 fixture ──────────
  writeFileSync(
    join(serviceCwd, "AGENTS.md"),
    "# AGENTS.md (m3b2 live fixture)\n\n이 저장소는 live acceptance 테스트용 임시 레포다. 파일 수정 전 반드시 사용자 승인을 받는다.\n",
    "utf8",
  );
  writeFileSync(
    join(serviceCwd, "CLAUDE.md"),
    "# CLAUDE.md (m3b2 live fixture)\n\n먼저 계획만 제시하고 승인 전에는 어떤 파일도 수정하지 않는다. 06_CEO_DECISION.md의 live acceptance 절차만 수행한다.\n",
    "utf8",
  );
  writeFileSync(join(serviceCwd, "read-me.txt"), "m3b2 read-success fixture: 이 줄이 보이면 Read 성공.\n", "utf8");

  // ── ambient MCP canary: service repo .mcp.json (strict 격리 시 미기동) ──────
  writeFileSync(
    join(serviceCwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { canary: { command: NODE, args: [SERVER, "canary", "canary_tool", canaryMcpPidFile] } } }, null, 2) + "\n",
    "utf8",
  );

  // ── ambient Hook canary: project .claude/settings.json (exec form, SessionStart+PreToolUse) ──
  //    `--setting-sources ""`가 project settings를 로드하지 않으면 canary는 실행되지 않는다(marker 부재).
  const claudeDir = join(serviceCwd, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const canaryHook = join(claudeDir, "canary-hook.mjs");
  writeFileSync(canaryHook, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "AMBIENT CANARY HOOK EXECUTED\\n");\n`, "utf8");
  const canaryCmd = (marker) => ({ type: "command", command: NODE, args: [canaryHook, marker] }); // 공식 exec form
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ matcher: "startup", hooks: [canaryCmd(canaryHookSessionMarker)] }],
          PreToolUse: [{ matcher: "*", hooks: [canaryCmd(canaryHookPreMarker)] }],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // ── 안전장치 3: claude --version 확인 (status 0 + 비어있지 않음 + semver) ──
  const claudeBin = process.env.HARNESS_CLAUDE_BIN ?? "claude";
  const ver = spawnSync(claudeBin, ["--version"], { encoding: "utf8" });
  const verOut = (ver.stdout || "").trim();
  const verErr = (ver.stderr || "").trim();
  const SEMVER = /\b\d+\.\d+\.\d+\b/;
  if (ver.error || ver.status !== 0 || !verOut || !SEMVER.test(verOut)) {
    console.error(`[m3b2-live] '${claudeBin} --version' 확인 실패 — preflight/TUI 미실행(fail-closed).`);
    console.error("  stdout:", redact(verOut) || "(빈 출력)");
    console.error("  stderr:", redact(verErr) || "(없음)");
    if (ver.error) console.error("  error:", redact(ver.error.message ?? String(ver.error)));
    exitCode = 2;
    throw new Error("version_check_failed");
  }
  const claudeVersion = redact(verOut);
  console.log(`[m3b2-live] claude 버전: ${claudeVersion} (bin='${claudeBin}')`);

  // ── 실행 전 수동 TUI 절차 안내 (sentinel 값 없이) ──────────────────────────
  console.log("\n========================================================================");
  console.log("[m3b2-live] M3b.2 actual Claude Hook LIVE ACCEPTANCE");
  console.log("주의: 실제 Claude 구독을 사용합니다(headless preflight + 대화형 세션). 비용/사용량이 발생할 수 있습니다.");
  console.log("production / remote repo / billing / deploy 에는 접촉하지 않습니다(임시 경로 전용).");
  console.log("------------------------------------------------------------------------");
  console.log("승인 프롬프트에서 y 를 입력하면 empty MCP headless preflight 후 대화형 세션이 열립니다.");
  console.log("세션이 열리면 아래 절차를 순서대로 수행하세요 (sentinel 값을 직접 타이핑하지 마세요):");
  console.log("");
  console.log('  0) [계획 승인]     Claude가 먼저 계획을 제시하면,  "계획 승인, live acceptance 절차만 진행"  이라고 입력하세요.');
  console.log("  1) [planning Read] 판단 문서 절대경로 2개를 읽어달라고 요청:");
  console.log(`                     - ${ideaDoc}`);
  console.log(`                     - ${ceoDoc}`);
  console.log(`                     (cwd는 serviceCwd지만 planning 문서는 contextRoot=${contextRoot} 아래 절대경로) → 각각 tool_requested + tool_succeeded`);
  console.log(`  2) [Read 성공]     서비스 레포 파일 읽기 요청:  ${readOk}  → tool_requested + tool_succeeded(동일 callId)`);
  console.log(`  3) [Read 실패]     존재하지 않는 파일 읽기 요청: ${readMissing}  → tool_requested + tool_failed(동일 callId)`);
  console.log("  4) [권한 승인]     Bash로  node -e 'if (!process.env.M3B2_LIVE_TOKEN) process.exit(1)'  실행을 요청하고, 권한 프롬프트에서 **승인(허용)**");
  console.log("                     (값을 출력하지 않고 존재만 확인 — sentinel 값을 직접 입력·출력하지 마세요) → permission_requested(Bash) + Bash tool_requested/succeeded(동일 callId)");
  console.log(`  5) [수동 거부]     **Write 도구**로  ${rejectMarker}  에 쓰기 요청 → 권한 프롬프트에서 **거부**`);
  console.log("                     ⚠ 권한 프롬프트 기본값이 Yes다: **Enter를 누르지 말고 방향키로 No(거부)를 선택**하라. 잘못 승인해도 재시도하지 말 것.");
  console.log("                     (Bash가 아니라 반드시 Write 도구로 요청. 거부하면 marker 파일이 생성되지 않아야 함)");
  console.log("  6) [정상 종료]     /exit 입력 → SessionEnd (session_end)");
  console.log("========================================================================\n");

  // ── runHandoff production 경로 (승인·preflight·spawn 모두 실제) ─────────────
  //    approve/preflight/spawn seam을 주입하지 않는다 → 기본 stdin 승인 + 실제 preflight + 실제 TUI.
  const outcome = await runHandoff({ project, cwd: serviceCwd });

  // outcome 어디에도 sentinel 평문이 없어야 한다.
  if (JSON.stringify(outcome).includes(sentinel)) problems.push("outcome에 sentinel 평문 노출");

  if (outcome.action !== "spawned") {
    // fail-closed 경로들: 세션 미실행. 안전 동작이지만 acceptance는 미완료로 처리한다.
    if (outcome.action === "rejected") {
      console.log("[m3b2-live] 승인 거부됨 — 세션을 열지 않았습니다(정상 fail-closed). acceptance 미완료.");
    } else if (outcome.action === "preflight_failed") {
      console.error(`[m3b2-live] preflight 실패(${outcome.code}) — TUI 미실행(fail-closed). 메시지 redacted.`);
      const st = loadRunState(project);
      if (st && st.handoff) problems.push("preflight 실패인데 run_state.handoff가 기록됨(fail-closed 위반)");
    } else if (outcome.action === "missing_binary") {
      console.error("[m3b2-live] claude CLI 미발견 — 설치 후 재시도.");
    } else {
      console.error(`[m3b2-live] 세션 미실행 outcome: ${outcome.action} (메시지 redacted).`);
    }
    // 세션이 열리지 않아도 ambient canary는 기동/실행되지 않았어야 한다(canary/cleanup 검증 유지).
    checkCanaries();
    exitCode = exitCode || 1; // 세션 미실행 = acceptance 미완료
    throw new Error("not_spawned");
  }

  // ── 사후 검증 (세션 종료 후) ────────────────────────────────────────────────
  const { argv, runtimeDir, tracePath, settingsPath, mcpConfigPath } = outcome;
  const snapshotPath = join(runtimeDir, "tools-snapshot.json");

  // (a) interactive argv: -p / stream-json / output-format 없음, 격리 인자 존재.
  for (const banned of ["-p", "stream-json", "--output-format"]) {
    if (argv.includes(banned)) problems.push(`interactive argv에 금지 인자 '${banned}' 포함`);
  }
  for (const need of ["--strict-mcp-config", "--mcp-config", "--settings", "--setting-sources", "--add-dir", "--disallowedTools"]) {
    if (!argv.includes(need)) problems.push(`interactive argv에 필요한 인자 '${need}' 누락`);
  }
  if (argv[argv.indexOf("--disallowedTools") + 1] !== "mcp__*") problems.push("--disallowedTools 값이 mcp__* 아님");
  if (argv[argv.indexOf("--setting-sources") + 1] !== "") problems.push('--setting-sources 값이 빈 문자열 아님');
  // [P0-1] --add-dir 값이 실제 planning contextRoot(projectPaths(project).root)여야 한다.
  if (argv[argv.indexOf("--add-dir") + 1] !== contextRoot) problems.push(`--add-dir 값이 contextRoot(${contextRoot}) 아님: ${argv[argv.indexOf("--add-dir") + 1]}`);
  // [P0] 옵션 종료 구분자 -- 로 initialPrompt가 --disallowedTools(가변 인자) 값으로 소비되지 않아야 한다.
  const di = argv.indexOf("--disallowedTools");
  if (argv[di + 2] !== "--") problems.push('--disallowedTools mcp__* 뒤 옵션 종료 구분자 "--" 누락 (prompt가 deny 값으로 소비될 위험 — P0)');
  if (argv.at(-2) !== "--") problems.push('interactive argv 끝에서 두 번째가 "--" 아님');
  const lastArg = argv.at(-1);
  // prompt는 --disallowedTools 값 영역에 들어가지 않는 구조: `--disallowedTools mcp__* -- <prompt>` 이고 -- 직후 단일 positional.
  if (!(argv[di + 1] === "mcp__*" && argv[di + 2] === "--" && di + 3 === argv.length - 1)) {
    problems.push("prompt가 --disallowedTools 값 영역에 포함될 수 있는 구조 (--disallowedTools mcp__* -- <prompt> 아님)");
  }
  // 마지막 인자 = task prompt이며 이번 실행 고유의 live acceptance 지시(06 CEO override)를 포함해야 한다.
  // readOk 경로(이번 실행 고유)와 "live acceptance" 문구를 **모두** 요구한다(둘 중 하나만으로는 불충분).
  if (!String(lastArg ?? "").includes(readOk) || !/live acceptance/i.test(String(lastArg ?? ""))) {
    problems.push("마지막 인자가 이번 실행 고유의 live acceptance 지시(readOk 경로 + 'live acceptance' 문구)를 모두 포함하지 않음");
  }

  // (b) hook-settings exact 계약: hooks 키 집합 == SUPPORTED_HOOKS, 각 Hook은 matcher 1·handler 1·exec form·args 정확 2개.
  const settingsText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
  let settings = null;
  try {
    settings = JSON.parse(settingsText);
  } catch {
    problems.push("hook-settings.json 파싱 실패");
  }
  if (settings) {
    const hookKeys = Object.keys(settings.hooks ?? {}).sort();
    const expectedKeys = [...SUPPORTED_HOOKS].sort();
    if (JSON.stringify(hookKeys) !== JSON.stringify(expectedKeys)) {
      problems.push(`hooks 키 집합 불일치: ${JSON.stringify(hookKeys)} (기대 ${JSON.stringify(expectedKeys)}) — extra/누락 Hook`);
    }
    for (const kind of SUPPORTED_HOOKS) {
      const arr = settings.hooks?.[kind];
      if (!Array.isArray(arr) || arr.length !== 1) {
        problems.push(`${kind} matcher 항목이 정확히 1개 아님 (extra matcher?)`);
        continue;
      }
      const m = arr[0];
      if (m.matcher !== "*") problems.push(`${kind} matcher가 "*" 아님`);
      if (!Array.isArray(m.hooks) || m.hooks.length !== 1) {
        problems.push(`${kind} handler가 정확히 1개 아님 (extra handler?)`);
        continue;
      }
      const hc = m.hooks[0];
      if (hc.type !== "command") problems.push(`${kind} type이 command 아님`);
      if (hc.command !== NODE) problems.push(`${kind} command가 node 실행 파일 아님`);
      if (!Array.isArray(hc.args) || hc.args.length !== 2) problems.push(`${kind} args가 정확히 2개[collector, hookKind] 아님`);
      else {
        if (!hc.args[0].endsWith("hookCollector.js")) problems.push(`${kind} args[0]가 collector 아님`);
        if (hc.args[1] !== kind) problems.push(`${kind} args[1]가 hookKind와 불일치`);
      }
    }
  }

  // (c) empty MCP preflight snapshot(servers=[]/tools=[]) + mcp-config(mcpServers={}).
  const cfgText = existsSync(mcpConfigPath) ? readFileSync(mcpConfigPath, "utf8") : "";
  const snapText = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8") : "";
  let cfg = null;
  try {
    cfg = JSON.parse(cfgText);
  } catch {
    problems.push("mcp-config.json 파싱 실패");
  }
  if (cfg && (!cfg.mcpServers || typeof cfg.mcpServers !== "object" || Array.isArray(cfg.mcpServers) || Object.keys(cfg.mcpServers).length !== 0)) {
    problems.push(`mcp-config mcpServers가 {} 아님: ${JSON.stringify(cfg.mcpServers)}`);
  }
  let snap = null;
  try {
    snap = JSON.parse(snapText);
  } catch {
    problems.push("tools-snapshot.json 파싱 실패");
  }
  if (snap) {
    if (!Array.isArray(snap.servers) || snap.servers.length !== 0) problems.push(`preflight snapshot servers가 [] 아님: ${JSON.stringify(snap.servers)}`);
    if (!Array.isArray(snap.tools) || snap.tools.length !== 0) problems.push(`preflight snapshot tools가 [] 아님: ${JSON.stringify(snap.tools)}`);
  }

  // (d) trace 로드: 모든 줄 JSON 유효 + 원문 미저장 검증.
  const traceText = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  const lines = traceText.split("\n").filter((l) => l.trim().length > 0);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      problems.push(`trace ${i + 1}번째 줄 JSON 무효`);
    }
    if (/\btranscript_path\b/.test(lines[i])) problems.push(`trace ${i + 1}번째 줄에 transcript_path 저장됨(금지)`);
    if (/"tool_response"\s*:/.test(lines[i])) problems.push(`trace ${i + 1}번째 줄에 raw tool_response 저장됨(금지)`);
  }
  if (records.length === 0) problems.push("trace가 비어 있음 — Hook이 하나도 관측되지 않음");

  const inp = (r) => (r && r.sanitizedInput && typeof r.sanitizedInput === "object" ? r.sanitizedInput : {});

  // (e) trace 공통 계약.
  if (records.some((r) => r.version !== "1")) problems.push("일부 record version≠'1'");
  if (records.some((r) => r.source !== "claude-code-hook")) problems.push("일부 record source≠'claude-code-hook'");
  if (records.some((r) => r.profileId !== "handoff-default")) problems.push("일부 record profileId≠'handoff-default'");
  if (records.some((r) => !r.sessionId)) problems.push("sessionId가 빈 record 존재");
  const sids = new Set(records.map((r) => r.sessionId));
  if (sids.size !== 1) problems.push(`sessionId 종류가 ${sids.size}개 (정확히 1 기대)`);

  // (f) 시나리오별 tool call correlation (tool_requested의 non-null callId ↔ 종료 이벤트 callId 동일).
  const reqOf = (toolName, pred) => records.find((r) => r.event === "tool_requested" && r.toolName === toolName && pred(r));
  const byCallId = (event, callId) => records.find((r) => r.event === event && r.callId === callId);

  // [P0-1] planning contextRoot 접근 성공: 최소 00_IDEA.md·06_CEO_DECISION.md를 contextRoot 절대경로로 Read 성공.
  for (const [label, doc] of [
    ["00_IDEA.md", ideaDoc],
    ["06_CEO_DECISION.md", ceoDoc],
  ]) {
    const req = reqOf("Read", (r) => inp(r).file_path === doc);
    if (!req) problems.push(`planning Read: tool_requested(Read, file_path=${label} 절대경로) 미관측 — contextRoot 접근 실패?`);
    else if (!req.callId) problems.push(`planning Read(${label}): tool_requested callId가 null`);
    else {
      const succ = byCallId("tool_succeeded", req.callId);
      if (!succ) problems.push(`planning Read(${label}): 동일 callId의 tool_succeeded 미관측(읽기 실패)`);
      else if (succ.toolName !== "Read") problems.push(`planning Read(${label}): 종료 이벤트 toolName≠Read`);
    }
  }
  // serviceCwd 아래 planning docs/WORKLOG가 생성되면 P0-1 경로 단절 재현 → FAIL.
  if (existsSync(serviceWorklog)) problems.push(`serviceCwd에 docs/WORKLOG.md가 생성됨(${serviceWorklog}) — planning contextRoot 경로 계약 위반(P0-1)`);
  if (existsSync(join(serviceCwd, "docs"))) problems.push(`serviceCwd에 docs/ 디렉터리가 생성됨 — planning 문서를 serviceCwd에서 찾음(P0-1)`);

  // Read 성공: requested ↔ succeeded 동일 callId
  {
    const req = reqOf("Read", (r) => inp(r).file_path === readOk);
    if (!req) problems.push("Read 성공: tool_requested(Read, file_path=readOk) 미관측");
    else if (!req.callId) problems.push("Read 성공: tool_requested callId가 null");
    else {
      const succ = byCallId("tool_succeeded", req.callId);
      if (!succ) problems.push("Read 성공: 동일 callId의 tool_succeeded 미관측");
      else if (succ.toolName !== "Read") problems.push("Read 성공: 종료 이벤트 toolName≠Read");
    }
  }
  // Read 실패: requested ↔ failed 동일 callId
  {
    const req = reqOf("Read", (r) => inp(r).file_path === readMissing);
    if (!req) problems.push("Read 실패: tool_requested(Read, file_path=readMissing) 미관측");
    else if (!req.callId) problems.push("Read 실패: tool_requested callId가 null");
    else {
      const fail = byCallId("tool_failed", req.callId);
      if (!fail) problems.push("Read 실패: 동일 callId의 tool_failed 미관측");
      else if (fail.toolName !== "Read") problems.push("Read 실패: 종료 이벤트 toolName≠Read");
    }
  }
  // Bash 승인: requested ↔ succeeded 동일 callId + permission_requested 별도(callId=null)
  {
    const req = reqOf("Bash", (r) => String(inp(r).command ?? "").includes("M3B2_LIVE_TOKEN"));
    if (!req) problems.push("Bash 승인: tool_requested(Bash, command에 M3B2_LIVE_TOKEN 이름) 미관측");
    else if (!req.callId) problems.push("Bash 승인: tool_requested callId가 null");
    else {
      const succ = byCallId("tool_succeeded", req.callId);
      if (!succ) problems.push("Bash 승인: 동일 callId의 tool_succeeded 미관측");
      else if (succ.toolName !== "Bash") problems.push("Bash 승인: 종료 이벤트 toolName≠Bash");
    }
    const perm = records.find((r) => r.event === "permission_requested" && r.toolName === "Bash" && String(inp(r).command ?? "").includes("M3B2_LIVE_TOKEN"));
    if (!perm) problems.push("Bash 승인: permission_requested(Bash) 미관측");
    else if (perm.callId !== null) problems.push("Bash permission_requested callId가 null 아님 — 결과 연결 주장 금지");
  }
  // 수동 거부(Write): tool_requested + permission_requested 존재. tool_denied 합성/연결하지 않음.
  {
    const req = reqOf("Write", (r) => String(inp(r).file_path ?? "") === rejectMarker);
    const perm = records.find((r) => r.event === "permission_requested" && r.toolName === "Write" && String(inp(r).file_path ?? "") === rejectMarker);
    if (!req) problems.push("수동 거부: tool_requested(Write, file_path=rejectMarker) 미관측");
    if (!perm) problems.push("수동 거부: permission_requested(Write, file_path=rejectMarker) 미관측");
    if (existsSync(rejectMarker)) problems.push("수동 거부: rejectMarker 파일이 생성됨(거부가 쓰기를 막지 못함)");
    if (records.some((r) => r.event === "tool_succeeded" && inp(r).file_path === rejectMarker)) problems.push("수동 거부: rejectMarker 경로의 tool_succeeded 존재(거부 안 됨)");
  }
  // SessionEnd: 정확히 1개, callId/toolName=null
  {
    const ends = records.filter((r) => r.event === "session_end");
    if (ends.length !== 1) problems.push(`session_end가 정확히 1개 아님: ${ends.length}개`);
    for (const e of ends) {
      if (e.callId !== null) problems.push("session_end callId가 null 아님");
      if (e.toolName !== null) problems.push("session_end toolName이 null 아님");
    }
  }

  // permission_requested 공통: 결과 관측 불가 명시(수동 승인/거부 유추 금지).
  for (const r of records.filter((x) => x.event === "permission_requested")) {
    if (r.permissionOutcomeObservable !== false) problems.push("permission_requested의 permissionOutcomeObservable가 false 아님");
    if (r.callId !== null) problems.push("permission_requested에 callId가 붙음(synthetic correlation 금지)");
  }

  // (g) PermissionDenied는 조건부: 실제 관측된 tool_denied만 shape 검증(denialMode=auto). 없으면 통과.
  const deniedRecs = records.filter((r) => r.event === "tool_denied");
  if (deniedRecs.length === 0) {
    console.log("[m3b2-live] 정보: tool_denied 미관측 — 수동 거부는 Hook으로 관측 불가(정상). marker 부재로만 검증.");
  } else {
    for (const d of deniedRecs) {
      if (d.denialMode !== "auto") problems.push(`tool_denied인데 denialMode≠auto (${String(d.denialMode)}) — 수동 거부를 denied로 추측 금지`);
    }
    console.log(`[m3b2-live] 정보: auto-mode tool_denied ${deniedRecs.length}건 관측(denialMode=auto 검증).`);
  }

  // (h) ambient MCP/Hook canary 미기동/미실행 (strict MCP + --setting-sources "" 격리, interactive 동안 포함).
  checkCanaries();

  // (i) sentinel/credential 평문 부재.
  for (const [name, txt] of [
    ["settings", settingsText],
    ["mcp-config", cfgText],
    ["snapshot", snapText],
    ["trace", traceText],
  ]) {
    if (txt.includes(sentinel)) problems.push(`${name}에 sentinel 평문 노출`);
  }
  for (const [name, txt] of [
    ["settings", settingsText],
    ["mcp-config", cfgText],
    ["snapshot", snapText],
  ]) {
    if (txt && CRED.test(txt)) problems.push(`${name}에 credential 형태 평문(보조 검사)`);
  }

  // (j) 파일·디렉터리 최소 권한.
  const modeChecks = [
    [runtimeDir, 0o700, "runtime dir"],
    [dirname(tracePath), 0o700, "tool-trace dir"],
    [settingsPath, 0o600, "hook-settings"],
    [tracePath, 0o600, "trace"],
  ];
  if (existsSync(mcpConfigPath)) modeChecks.push([mcpConfigPath, 0o600, "mcp-config"]);
  if (existsSync(snapshotPath)) modeChecks.push([snapshotPath, 0o600, "tools-snapshot"]);
  for (const [p, want, label] of modeChecks) {
    if (!existsSync(p)) {
      problems.push(`${label} 파일 부재: ${p}`);
      continue;
    }
    const m = mode(p);
    if (m !== want) problems.push(`${label} 권한 ${m.toString(8)} (기대 ${want.toString(8)})`);
  }

  // (k) run_state.handoff 기록 + completed 불변.
  const st = loadRunState(project);
  if (!st) problems.push("run_state 로드 실패");
  else {
    if (st.status !== "completed") problems.push(`completed 상태 변경됨: ${st.status}`);
    if (!st.handoff) problems.push("run_state.handoff 미기록(spawn됐는데)");
    else if (st.handoff.trace_path !== tracePath) problems.push("run_state.handoff.trace_path 불일치");
  }

  spawnedVerified = true; // 사후 검증 완주 — finally에서 PASS/FAIL 판정
} catch (e) {
  const msg = redact(String(e?.message ?? e));
  if (!["not_spawned", "project_not_completed", "version_check_failed"].includes(msg)) {
    console.error("[m3b2-live] 예기치 못한 오류:", msg);
    exitCode = exitCode || 1;
  }
} finally {
  cleanup(); // idempotent. kill/정리 실패는 cleanupProblems로 별도 기록(숨기지 않음).
  const allProblems = [...problems, ...cleanupProblems];
  if (spawnedVerified) {
    if (allProblems.length) {
      console.error("\n[m3b2-live] FAIL:\n - " + allProblems.map(redact).join("\n - "));
      exitCode = 1;
    } else {
      console.log(
        "\n[m3b2-live] PASS — 6 Hook exact 계약 · empty MCP snapshot(servers=[]/tools=[])·mcp-config({}) · " +
          "planning contextRoot 접근(--add-dir=contextRoot, 00_IDEA/06_CEO_DECISION Read 성공, serviceCwd docs/WORKLOG 미생성) · " +
          "callId correlation(planning Read·Read 성공/실패·Bash 승인) + permission_requested 별도(callId=null) · " +
          "Bash 비출력 존재확인(node -e, sentinel 값 미출력) · Write 수동 거부(requested+permission·marker 부재) · " +
          "session_end 정확1(callId/toolName=null) · trace 공통 계약 · 대화형 argv에 -p/stream-json 없음(-- 꼬리) · ambient MCP/Hook canary 미기동 · " +
          "sentinel/credential 평문 부재 · 원문 미저장 · 권한(dir700/file600) · run_state.handoff 기록·completed 불변.",
      );
    }
  } else if (allProblems.length) {
    // non-spawned/에러 경로: canary/cleanup 문제도 숨기지 않고 표면화.
    console.error("\n[m3b2-live] 문제 발견:\n - " + allProblems.map(redact).join("\n - "));
    exitCode = exitCode || 1;
  }
  console.log(`[m3b2-live] 종료 (exit ${exitCode}).`);
  process.exit(exitCode);
}
