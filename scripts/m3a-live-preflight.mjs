#!/usr/bin/env node
/**
 * [M3a LIVE ACCEPTANCE RUNNER — 수동 live acceptance 전용, 실제 Claude 구독 호출]
 *
 * headless preflight를 실제 claude로 1회 돌려 격리를 실측한다:
 *  - expected fixture 서버(read-only 도구 1개)만 strict config에 포함.
 *  - 임시 service cwd의 .mcp.json에 별도 canary 서버/도구를 등록(전역 상속 오염 모사).
 *  - system/init 스냅샷에 expected server connected + expected tool 정확 일치,
 *    ambient canary server/tool 부재, tools-snapshot.json 생성 검증.
 *  - 실제 sentinel secret(외부 미출력)을 secretRefs + cwd 경로에 심어, 반환/저장 snapshot·config·
 *    오류 메시지 어디에도 평문이 없는지 검증. credential 형태 regex는 보조 검사로 유지.
 *  - fixture pid-file로 실제 기동·격리·종료를 검증하고, 잔여 프로세스는 finally에서 정리+실패 처리.
 *  - 실패 시 fail-closed(성공 result 미반환) — interactive 세션은 절대 실행하지 않는다.
 *
 * 안전장치: HARNESS_LIVE_M3A=1 이 없으면 실행을 거부한다. npm test에서는 호출되지 않는다.
 * 선행: `npm run build` (dist 사용). 수동 실행 전용이며 CI/자동 파이프라인에서 돌리지 않는다.
 *
 * 비용 주의: preflight는 모델 요청 전(system/init 직후)에 종료하는 것을 목표로 하나,
 * API/구독 사용량 0을 보장하지 않는다(세션 수립 자체가 계측될 수 있음).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.HARNESS_LIVE_M3A !== "1") {
  console.error(
    "거부: 이 runner는 실제 Claude 구독을 호출합니다.\n" +
      "실행하려면: npm run build && HARNESS_LIVE_M3A=1 node scripts/m3a-live-preflight.mjs",
  );
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const SERVER = join(HERE, "fixtures", "m3a", "minimal-stdio-mcp.mjs");

const preflightMod = join(HERE, "..", "dist", "tools", "preflight.js");
if (!existsSync(preflightMod)) {
  console.error(`빌드가 필요합니다: ${preflightMod} 없음 — 먼저 'npm run build'.`);
  process.exit(2);
}
const { runPreflight } = await import(preflightMod); // PreflightError는 code 필드로 판별

const CRED = /(?:authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|credential)\s*[:=]/i;

// 외부에 절대 출력하지 않는 고유 sentinel. 전용 env + cwd 경로에 심는다.
const sentinel = "m3asentinel" + randomBytes(16).toString("hex");
process.env.M3A_SENTINEL_SECRET = sentinel;

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
  } catch {
    /* 이미 종료 */
  }
};
const readPid = (f) => {
  try {
    const raw = readFileSync(f, "utf8").trim();
    // 파일 전체가 양의 정수여야 한다 ("123abc" 등 거부). 0/음수/선행0 불가.
    if (!/^[1-9]\d*$/.test(raw)) return 0;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : 0;
  } catch {
    return 0;
  }
};

const base = mkdtempSync(join(tmpdir(), "m3a-live-"));
const serviceCwd = join(base, `svc-${sentinel}`); // cwd 경로에 sentinel 포함 → snapshot redaction 실검증
const runtimeDir = join(base, "runtime");
const expectedPidFile = join(base, "expected.pid");
const canaryPidFile = join(base, "canary.pid");
mkdirSync(serviceCwd, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });

let exitCode = 0;
const problems = [];

try {
  // ambient .mcp.json — canary 서버(strict가 제외해야 함). 기동 시 canary pid-file 생성.
  writeFileSync(
    join(serviceCwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { canary: { command: NODE, args: [SERVER, "canary", "canary_tool", canaryPidFile] } } }, null, 2) + "\n",
    "utf8",
  );

  // expected profile — read-only 도구 1개. 기동 시 expected pid-file 생성. sentinel을 secretRefs로 선언.
  const profile = {
    id: "m3a-live",
    capabilities: ["component_registry_read"],
    bindings: { component_registry_read: { kind: "mcp", server: "expected", tools: ["read_thing"] } },
    servers: [{ name: "expected", command: NODE, args: [SERVER, "expected", "read_thing", expectedPidFile] }],
    preapprovedTools: ["mcp__expected__read_thing"],
    deniedTools: [],
    permissionMode: "read_only",
    allowedDomains: null,
    limits: { maxCallsPerStep: 6, maxResultChars: 8000, maxElapsedMsPerCall: 60000 },
    secretRefs: ["M3A_SENTINEL_SECRET"],
  };

  console.log("[m3a-live] headless preflight 실행 (실제 claude, interactive 아님)...");
  console.log("[m3a-live] 주의: 모델 요청 전 종료를 목표로 하나 API/구독 사용량 0을 보장하지 않음.");

  let res = null;
  let err = null;
  try {
    res = await runPreflight({ profile, serviceCwd, runtimeDir, now: () => new Date().toISOString(), timeoutMs: 120_000 });
  } catch (e) {
    err = e;
  }

  if (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes(sentinel)) problems.push("오류 메시지에 sentinel 평문");
    console.error(`[m3a-live] preflight fail-closed (interactive 미실행): [${err?.code ?? "unknown"}] (메시지 redacted)`);
    exitCode = 1;
  } else {
    const s = res.snapshot;
    if (!(s.servers.length === 1 && s.servers[0].name === "expected" && s.servers[0].status === "connected")) {
      problems.push(`expected server가 connected 아님: ${JSON.stringify(s.servers)}`);
    }
    if (JSON.stringify(s.tools) !== JSON.stringify(["mcp__expected__read_thing"])) {
      problems.push(`expected tool 불일치: ${JSON.stringify(s.tools)}`);
    }
    if (!existsSync(res.snapshotPath)) problems.push("tools-snapshot.json 미생성");

    const snapText = existsSync(res.snapshotPath) ? readFileSync(res.snapshotPath, "utf8") : "";
    const cfgPath = join(runtimeDir, "mcp-config.json");
    const cfgText = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
    const retText = JSON.stringify(s);
    for (const [name, txt] of [["반환 snapshot", retText], ["저장 snapshot", snapText], ["config", cfgText]]) {
      if (txt.includes(sentinel)) problems.push(`${name}에 sentinel 평문`);
      if (CRED.test(txt)) problems.push(`${name}에 credential 형태 평문(보조 검사)`);
    }
    if (/canary/.test(snapText) || /canary/.test(retText)) problems.push("ambient canary가 snapshot에 노출됨");
  }

  // ── MCP 프로세스 격리·정리 검증 (성공/실패 무관) ──
  if (existsSync(canaryPidFile)) {
    problems.push("ambient canary가 기동됨(pid-file 존재) — strict 격리 실패");
    const p = readPid(canaryPidFile);
    if (p && isAlive(p)) killPid(p);
  }
  // expected 기동·종료 fail-closed: pid-file 부재/비정상 값이면 실패. 기동+5초 내 종료 모두 확인해야 통과.
  if (!existsSync(expectedPidFile)) {
    problems.push("expected fixture pid-file 부재 — 실제 기동 미확인");
  } else {
    const p = readPid(expectedPidFile);
    if (!Number.isInteger(p) || p <= 0) {
      problems.push("expected fixture pid-file 값이 비정상(양의 정수 아님)");
    } else {
      const limitMs = 5000;
      let waited = 0;
      while (isAlive(p) && waited < limitMs) {
        await sleep(200);
        waited += 200;
      }
      if (isAlive(p)) {
        problems.push(`expected fixture(pid ${p})가 ${limitMs}ms 내 종료되지 않음`);
        killPid(p);
      }
    }
  }

  if (problems.length) {
    console.error("[m3a-live] FAIL:\n - " + problems.join("\n - "));
    exitCode = 1;
  } else if (!err) {
    console.log("[m3a-live] PASS — expected connected · tool 일치 · canary 부재 · snapshot 생성 · sentinel/credential 평문 부재 · fixture 정상 종료.");
    console.log(JSON.stringify(res.snapshot, null, 2)); // cwd는 redacted(***), sentinel 없음
  }
} catch (e) {
  const msg = String(e?.message ?? e);
  console.error("[m3a-live] 예기치 못한 오류:", msg.includes(sentinel) ? "(redacted)" : msg);
  exitCode = 1;
} finally {
  // runner가 유발한 fixture 프로세스가 남았으면 정리하고 실패 처리.
  let leftover = false;
  for (const f of [expectedPidFile, canaryPidFile]) {
    if (existsSync(f)) {
      const p = readPid(f);
      if (p && isAlive(p)) {
        killPid(p);
        leftover = true;
      }
    }
  }
  if (leftover) {
    console.error("[m3a-live] finally: 잔여 fixture 프로세스를 정리함 → 실패 처리.");
    exitCode = 1;
  }
  rmSync(base, { recursive: true, force: true });
  console.log(`[m3a-live] 종료 (exit ${exitCode}).`);
  process.exit(exitCode);
}
