#!/usr/bin/env node
/**
 * V3 M5 — **첫 live probe**(대장 `B-23` 마감 확인 + `B-9` live 재확인).
 *
 * **실제 Codex 추론이 1회 일어난다 = 실제 사용량을 쓴다.** 그래서 이 스크립트는
 * `scripts/acceptance.sh`에 등록하지 않는다(수동 실행 전용).
 *
 * 목적: ① 승인된 **native 바이너리**를 직접 띄웠을 때 codex가 정상 동작하는가(wrapper 없이)
 * ② 실측된 홈 구조(`auth.json`+`log/`+`tmp/`)로 첫 invocation이 통과하는가
 * ③ JSONL 이벤트 필드명·usage가 파서 계약과 맞는가(`B-9` live 확인).
 *
 * 예산: 프롬프트는 한 문장이고 turn 1회다. 관측된 usage를 그대로 출력한다.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(r.status === null ? 1 : r.status);
}

const { CodexCliProvider } = await import(join(REPO_ROOT, "src/exec/codexCliProvider.ts"));

const CODEX_BIN =
  process.env.HARNESS_CODEX_BIN ??
  "/Users/jihun/.nvm/versions/node/v24.18.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
const CODEX_HOME = process.env.HARNESS_CODEX_HOME ?? "/Users/jihun/harness-codex-home";
const GIT_BIN = "/usr/bin/git";

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

let ws;
try {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "m5-live-")));
  execFileSync(GIT_BIN, ["init", "-q"], { cwd: ws });
  execFileSync(GIT_BIN, ["-c", "user.email=a@b.c", "-c", "user.name=probe", "commit", "-q", "--allow-empty", "-m", "probe"], { cwd: ws });
  const head = execFileSync(GIT_BIN, ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();

  const manifest = {
    milestoneId: "m5-live",
    approvedCommit: head,
    writableRoots: ["src"],
    ownershipByTask: { probe: ["src"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      // **native 바이너리를 직접 승인한다** — `which codex`가 가리키는 Node wrapper를 승인하면
      // 실제 추론 바이너리가 digest로 고정되지 않는다(2026-08-11 실측에서 확인).
      codex: { path: CODEX_BIN, sha256: sha(CODEX_BIN) },
      codexHome: { path: CODEX_HOME },
      controllerEntrypoint: { path: join(REPO_ROOT, "package.json"), sha256: sha(join(REPO_ROOT, "package.json")) },
      git: { path: GIT_BIN, sha256: sha(GIT_BIN) },
      node: { path: process.execPath, sha256: sha(process.execPath) },
      processObserver: { path: "/bin/ps", sha256: sha("/bin/ps") },
    },
    autopilotPolicy: {
      maxTaskAttempts: 1,
      maxDeliveryAttempts: 1,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 900_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    maxSessions: 1,
    maxTokens: 30_000, // **하드 상한** — 넘으면 하네스가 스스로 멈춘다.
    maxElapsedMs: 600_000,
    localMergeAllowed: false,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };

  console.log(`codex   : ${CODEX_BIN}`);
  console.log(`sha256  : ${manifest.executionAuthority.codex.sha256}`);
  console.log(`home    : ${CODEX_HOME}`);
  console.log(`cwd     : ${ws}\n`);

  const provider = new CodexCliProvider({ manifest, controllerRepoRoot: ws });
  const spec = {
    sessionId: "probe-1",
    role: "reviewer",
    cwd: ws,
    codex: { codexHome: CODEX_HOME, sandbox: "read-only", reasoningEffort: "low" },
  };

  const handle = await provider.start(spec, "Reply with exactly: OK");
  console.log("session started · JSONL 이벤트:");
  const seen = [];
  for await (const ev of provider.events(handle)) {
    seen.push(ev.type ?? ev.kind ?? "?");
    if (ev.type === "usage" || ev.usage) console.log("  usage:", JSON.stringify(ev.usage ?? ev));
    else console.log("  ", JSON.stringify(ev).slice(0, 200));
  }
  console.log("\n관측된 이벤트 종류:", [...new Set(seen)].join(", "));
  await provider.stop(handle);
  console.log("\nLIVE PROBE 완료");
} catch (e) {
  console.log(`\nFAIL — ${e?.code ?? ""} ${e?.message ?? String(e)}`);
  process.exitCode = 1;
} finally {
  if (ws) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 판정을 바꾸지 않는다 */
    }
  }
}
