#!/usr/bin/env node
/**
 * V3 M11 — **승인된 모델 축(`executionAuthority.claudeModel`) live probe.**
 *
 * ⚠️ **live claude 최대 3회**(구독 한도 · 실결제 $0). `acceptance.sh`에 등록하지 않는다(수동 전용).
  * 실행: `node --import tsx scripts/m12-model-axis-probe.mjs`
 *
 * ## 왜 이 스크립트가 레포에 있나
 *
 * 구현 세션은 **argv까지만** 증명했다(승인 → kernel → 자식 `process.argv`). 남은 셋은 live만 답한다.
 * `m11-c86-auth-probe.mjs`와 같은 지위다 — **재현할 수 없는 실측은 이 레포의 증거 규율에 못 미친다.**
 *
 * ## 무엇을 판정하나
 *
 *   A. 승인된 모델 id를 실으면 **성공하는가**(exit 0).
 *   B. **오타 모델 id를 CLI가 fail closed로 거부하는가, 조용히 기본값으로 떨어지는가.**
 *      → 후자면 `report.workerModel.marker === "approved"`가 **과대주장**이 된다. 이것이 이 probe의 핵심.
 *   C. `--output-format json` 봉투가 **실제로 돈 모델**을 보고하는 필드를 갖는가.
 *      → 가지면 영수증을 "요청했다"에서 "무엇으로 돌았다"로 강화할 수 있다.
 *
 * ## 2026-08-23 실측 결과 (claude CLI 1회 · 이 기계)
 *
 *   A0 대조군(`--model` 없음): **exit 0** · `modelUsage` 키 = `claude-opus-5[1m]`
 *      → **이 기계의 CLI 기본값이 Opus 5 1M이다.** harness는 그 값을 모르고, 알 수 있다고 적지 않는다.
 *   A  `--model claude-opus-5`: **exit 0** · `modelUsage` 키 = `claude-opus-5`
 *      → **인자가 실제로 모델을 바꾼다**(대조군과 키가 다르다). argv 배선이 공허하지 않다.
 *   B  `--model claude-opus-5-typo-does-not-exist`: **exit 1** · `is_error` ·
 *      `result` = "There's an issue with the selected model (…). It may not exist or you may not
 *      have access to it." → **fail closed다. 조용한 기본값 대체가 없다.**
 *
 *      **B가 증명하는 것을 정확히 적는다**(M11 적대적 리뷰 C-1이 이 문장을 고쳤다): B는 "**틀린 id가
 *      조용히 기본값으로 떨어지는** 실패 모드"를 제거할 뿐이고, "승인된 id로 실제 추론이 돌았다"를
 *      증명하지는 않는다. 그 둘은 다른 명제다. 후자를 증명하는 것은 **A**다(대조군과 `modelUsage`
 *      키가 실제로 달라졌다). 그리고 `marker === "approved"`가 과대주장이 아닌 **진짜 이유**는
 *      영수증의 주장 범위를 **"요청했다"까지로 잘라 뒀기 때문**이며 그 한정은
 *      `autopilot.ts`의 `workerModel` 주석에 있다.
 *   C  봉투에 **`modelUsage.<model-id>.canonicalModel`** 이 있다 → "무엇으로 돌았는가"의 진짜 영수증이다.
 *      **단 한정**: 매 실행에 `claude-haiku-4-5-20251001`이 **함께** 들어 있다(CLI 내부 용도).
 *      즉 "무엇으로 돌았나"의 답은 **값 하나가 아니라 집합**이고, 영수증이 무엇을 단정해야 하는지는
 *      설계 판단이 남는다 → 그래서 이 slice는 영수증을 **"요청했다"까지만** 주장한다(대장에 등록).
 *
 * ## 이 probe가 판정하지 **않는** 것
 *
 * 모델 **품질**·응답 내용·토큰 회계는 범위 밖이다. 표본은 **각 1회**이고, CLI 버전 하나에 대한 실측이다.
 * `modelUsage`의 haiku 항목이 **무엇에 쓰이는지**도 재지 않았다(있다는 사실만 관측했다).
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const R = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LIVE_WORKER_ARGS, LIVE_WORKER_ENV } = await import(R + "/src/exec/livePlanWorker.ts");
const BIN =
  process.env.HARNESS_CLAUDE_BIN ??
  "/Users/jihun/.nvm/versions/node/v24.18.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";

async function run(label, extraArgs) {
  const args = [...LIVE_WORKER_ARGS, ...extraArgs];
  const child = spawn(BIN, args, { env: { ...LIVE_WORKER_ENV }, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let out = "", err = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (c) => (out += c));
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => (err += c));
  child.stdin.end("Reply with exactly: PROBE_OK");
  const code = await new Promise((r) => { child.once("close", r); child.once("error", () => r(-1)); });
  console.log(`\n[${label}] exit=${code}  args(tail)=${JSON.stringify(extraArgs)}`);
  console.log(`  stderr(300): ${err.slice(0, 300).replace(/\n/g, " ")}`);
  let parsed = null;
  try { parsed = JSON.parse(out); } catch { /* 비-JSON이면 원문 일부만 */ }
  if (parsed && typeof parsed === "object") {
    console.log(`  json top-level keys: ${Object.keys(parsed).sort().join(",")}`);
    // C: 모델을 보고하는 필드가 있나 — 이름을 짐작하지 않고 **전수로** 찾는다.
    const hits = [];
    const walk = (v, path) => {
      if (v === null || typeof v !== "object") {
        if (typeof v === "string" && /claude|opus|sonnet|haiku|fable/i.test(v)) hits.push(`${path} = ${v}`);
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(parsed, "$");
    console.log(`  모델 이름처럼 보이는 값: ${hits.length === 0 ? "(없음)" : ""}`);
    for (const h of hits.slice(0, 12)) console.log(`    ${h}`);
  } else {
    console.log(`  stdout(300): ${out.slice(0, 300).replace(/\n/g, " ")}`);
  }
  return { code, out, err, parsed };
}

const base = await run("A0. 대조군 — --model 없음(현행)", []);
const ok = await run("A. 승인된 모델 id", ["--model", "claude-opus-5"]);
const bad = await run("B. 오타 모델 id", ["--model", "claude-opus-5-typo-does-not-exist"]);

console.log("\n=== 판정 ===");
console.log(`A(승인 id): exit ${ok.code}`);
if (bad.code === 0) {
  console.log("B: ❌ **오타 id로도 exit 0** → CLI가 fail closed가 아니다.");
  console.log("   → report.workerModel.marker==='approved'는 '요청했다'까지만 참이고,");
  console.log("      '그 모델로 돌았다'로 읽히면 과대주장이다. 영수증 서술을 좁혀야 한다.");
} else {
  console.log(`B: ✅ 오타 id는 exit ${bad.code}로 거부됐다 → 승인 축이 fail closed다.`);
}
