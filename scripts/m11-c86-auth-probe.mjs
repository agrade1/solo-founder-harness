#!/usr/bin/env node
/**
 * V3 M11 — **`C-86` 실측 probe: `CLAUDE_CONFIG_DIR`이 auth 해석 경로를 가르는가?**
 *
 * ⚠️ **live claude 2회**(구독 한도 · 실결제 $0). `acceptance.sh`에 등록하지 않는다(수동 전용).
 * 실행: `HARNESS_ACCEPTANCE_TSX=1 node --import tsx scripts/m11-c86-auth-probe.mjs`
 *
 * ## 왜 이 스크립트가 레포에 있나
 *
 * `C-86`(worker 세션의 자격증명 신원이 승인 축 밖) 결정문이 "**되면** 승인 축 추가"였다. 그 갈림길을
 * 판정한 것이 이 probe이고, **재현할 수 없는 실측은 이 레포의 증거 규율에 못 미친다**(M11 적대적 리뷰
 * B-1). 그래서 판정 근거를 스크립트로 남긴다.
 *
 * ## 판정 규칙
 *   - A(빈 config dir) 실패 + B(현행) 성공 → 이 env가 auth를 가른다 → **승인 축으로 표현 가능**
 *   - A·B 둘 다 성공 → auth는 Keychain(`USER`)에서 온다 → 이 축은 신원을 고정하지 못한다
 *   - B가 실패 → 환경 문제. 결론 낼 수 없다
 *
 * ## 2026-08-23 실측 결과
 *   A: **exit 1** · `"Not logged in · Please run /login"` · B: **exit 0** → 축을 열었다.
 *
 * ## 이 probe가 판정하지 **않는** 것 (적대적 리뷰 B-1)
 *
 * **비어 있지 않은 config dir + `USER` 공존 시 어느 자격증명이 이기는지**는 재지 않았다. 그것을 재려면
 * 서로 다른 계정 둘이 필요하다(승인된 홈에 계정 A 로그인 + Keychain에 계정 B). 그래서 지금 참인 명제는
 * **"이 env가 로그인 상태 해석을 가른다"** 이지 **"이 env가 계정을 고른다"** 가 아니다 → 대장 `B-35`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 레포 루트는 **이 파일 위치에서** 파생한다(하드코딩된 사용자 경로를 남기지 않는다).
const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LIVE_WORKER_ARGS, LIVE_WORKER_ENV } = await import(R + "/src/exec/livePlanWorker.ts");
// wrapper가 아니라 **실제 실행 파일**이다(대장 `B-27` · 감사 R6이 지목하는 함정).
const BIN =
  process.env.HARNESS_CLAUDE_BIN ??
  "/Users/jihun/.nvm/versions/node/v24.18.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";

async function run(label, extraEnv) {
  const env = { ...LIVE_WORKER_ENV, ...extraEnv };
  const child = spawn(BIN, [...LIVE_WORKER_ARGS], { env, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => (out += c));
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
  child.stdin.end("Reply with exactly: PROBE_OK");
  const code = await new Promise((r) => { child.once("close", r); child.once("error", () => r(-1)); });
  console.log(`\n[${label}] exit=${code}`);
  console.log(`  env keys: ${Object.keys(env).sort().join(",")}`);
  console.log(`  stdout(300): ${out.slice(0, 300).replace(/\n/g, " ")}`);
  console.log(`  stderr(300): ${err.slice(0, 300).replace(/\n/g, " ")}`);
  return { code, out, err };
}
const empty = mkdtempSync(join(tmpdir(), "c86-emptyconfig-"));
console.log(`빈 config dir: ${empty}`);
const a = await run("A. CLAUDE_CONFIG_DIR=빈 디렉터리", { CLAUDE_CONFIG_DIR: empty });
const b = await run("B. 대조군 — CLAUDE_CONFIG_DIR 없음(현행)", {});
console.log("\n=== 판정 ===");
if (a.code === 0 && b.code === 0) console.log("빈 config dir으로도 인증됐다 → auth는 Keychain(USER)에서 온다. CLAUDE_CONFIG_DIR은 신원을 고정하지 못한다.");
else if (a.code !== 0 && b.code === 0) console.log("빈 config dir이면 인증 실패 → CLAUDE_CONFIG_DIR이 auth 경로를 가른다. 승인 축으로 표현 가능하다.");
else console.log("대조군도 실패 — 결론 낼 수 없다(환경 문제).");
