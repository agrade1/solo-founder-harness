#!/usr/bin/env node
/**
 * V3 M7 T7 — **live benchmark: 도구 없는 baseline vs research gateway**.
 *
 * ⚠️ **과금이 발생한다** — 검색 API 호출 + LLM 왕복. 사용자 승인 없이 실행하지 않는다.
 * `acceptance.sh`에 등록하지 않는다(M5 live probe와 같은 규율: 수동 실행 전용).
 *
 * 무엇을 비교하는가:
 *   A. baseline — 도구 **없이** 한 번 물어본다(`--tools "" --permission-mode plan --strict-mcp-config`).
 *   B. research — 1차(도구 없음, `RESEARCH_REQUEST` 선언만) → 하네스가 Tavily 호출 → `EvidenceItem`
 *      → 래핑 digest 주입 → 2차.
 *
 * 무엇을 세는가(정직하게 — 문서 품질을 채점하지 않는다):
 *   - 문서가 인용한 URL 수, 그중 **우리가 실제로 가져와 해싱한 원문에 대응하는** 것 수(=검증 가능한 근거).
 *   - baseline이 인용한 URL은 정의상 검증 불가다(수집한 원문이 없다) — 그것을 그대로 적는다.
 *   - 각 실행의 usage(input/output 토큰)와 backend 호출 수.
 *
 * 산출물은 임시 디렉터리에만 쓴다(외부 원문을 레포에 커밋하지 않는다). 요약만 stdout으로 낸다.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const { parseResearchRequests, runResearch, renderEvidenceDigest } = await import(
  join(REPO_ROOT, "src/tools/researchGateway.ts")
);
const { createTavilyBackend } = await import(join(REPO_ROOT, "src/tools/tavilyBackend.ts"));

const IDEA =
  "1인 창업자용 AI 에이전트 오케스트레이션 하네스 — 승인 게이트와 durable state 위에서 " +
  "research/PM/개발 specialist를 계층으로 돌리고, 사람 승인 없이는 코드 수정·배포가 일어나지 않는 CLI 도구.";

/** 도구를 **실제로** 끊는 argv. 플래그 존재가 아니라 이 조합이 baseline의 정직함을 만든다. */
const NO_TOOL_ARGS = [
  "-p",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--tools",
  "",
  "--permission-mode",
  "plan",
];

function ask(prompt, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HARNESS_CLAUDE_BIN ?? "claude", NO_TOOL_ARGS, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label}: 타임아웃`));
    }, 600_000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`${label}: claude 실행 실패 ${e.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${label}: 종료코드 ${code} ${err.trim().slice(0, 300)}`));
      let text = out.trim();
      let usage = { inputTokens: 0, outputTokens: 0 };
      try {
        const o = JSON.parse(out);
        if (typeof o.result === "string") text = o.result;
        if (o.usage) usage = { inputTokens: o.usage.input_tokens ?? 0, outputTokens: o.usage.output_tokens ?? 0 };
      } catch {
        /* JSON이 아니면 raw를 그대로 쓴다 */
      }
      resolve({ text, usage });
    });
    child.stdin.end(prompt);
  });
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};
const urlsIn = (text) => [...new Set((text.match(/https?:\/\/[^\s)\]"'`,]+/g) ?? []).map((u) => u.replace(/[.,]$/, "")))];

// **양쪽에 정확히 같은 지시를 준다** — 인용 형식이 달라서 생기는 차이를 지표로 착각하지 않기 위해서다.
const PRD_TASK = `아래 아이디어에 대해 간결한 검토 문서를 써라. 필수 섹션: ## 시장 근거 / ## 경쟁 / ## 판정.
사실 주장을 할 때마다 문장 끝에 \`[출처: <전체 URL>]\` 을 붙여라. 출처를 모르면 \`[출처: 없음]\` 이라고 적어라.
지어낸 URL은 쓰지 마라. 800자 이내.

아이디어: ${IDEA}`;

console.log("=== M7 T7 live benchmark (과금 발생) ===\n");

// ── A. baseline (도구 없음) ────────────────────────────────────────────────
console.log("A. baseline — 도구 없이 1회");
const baseline = await ask(PRD_TASK, "baseline");
const baselineUrls = urlsIn(baseline.text);
console.log(`   usage in=${baseline.usage.inputTokens} out=${baseline.usage.outputTokens} · 인용 URL ${baselineUrls.length}건`);

// ── B. research 1차 — 선언만 ──────────────────────────────────────────────
console.log("\nB1. research 1차 — 도구 없이 검색 요청만 선언");
const first = await ask(
  `아래 아이디어를 검토하려 한다. **아직 문서를 쓰지 마라.** 대신 필요한 웹 검색을 아래 형식으로 최대 2줄 선언하고 그것만 출력하라.

RESEARCH_REQUEST query="검색어" | type=search

아이디어: ${IDEA}`,
  "research-1차",
);
const requests = parseResearchRequests(first.text);
console.log(`   usage in=${first.usage.inputTokens} out=${first.usage.outputTokens} · 선언 ${requests.length}건`);
for (const r of requests) console.log(`   - ${r.type}: ${r.query}`);
if (requests.length === 0) {
  console.log("   선언이 없다 — 검색 없이 끝난다(이 사실을 그대로 적는다).");
}

// ── 하네스가 검색한다 ─────────────────────────────────────────────────────
const evidenceDir = mkdtempSync(join(tmpdir(), "m7-bench-"));
const research = await runResearch(requests, {
  backend: createTavilyBackend(),
  evidenceDir,
  now: () => new Date().toISOString(),
  allowedDomains: null, // search 후보는 좁히지 않는다(질의 전에 도메인을 알 수 없다)
});
console.log(
  `\n   하네스 검색: backend 호출 ${research.backendCalls}회 · EvidenceItem ${research.items.length}건 · 원문 ${research.items.reduce((n, i) => n + i.bytes, 0)} bytes → ${evidenceDir}`,
);

// ── B2. research 2차 — 래핑된 digest 주입 ─────────────────────────────────
console.log("\nB2. research 2차 — 래핑된 evidence digest 주입");
const second = await ask(`${PRD_TASK}\n\n다음은 하네스가 수집한 근거다. 인용할 때 source URL을 함께 적어라.\n\n${renderEvidenceDigest(research.items)}`, "research-2차");
const researchUrls = urlsIn(second.text);
const evidenceSources = new Set(research.items.map((i) => i.source));
const evidenceHosts = new Set([...evidenceSources].map(hostOf).filter(Boolean));
// **검증 가능**: 인용된 URL이 우리가 실제로 가져와 해싱한 원문 URL과 같거나(정확) 그 호스트에 속한다.
const verifiable = researchUrls.filter((u) => evidenceSources.has(u) || evidenceHosts.has(hostOf(u)));
const baselineVerifiable = baselineUrls.filter((u) => evidenceSources.has(u));
writeFileSync(join(evidenceDir, "baseline.md"), baseline.text, { mode: 0o600 });
writeFileSync(join(evidenceDir, "research.md"), second.text, { mode: 0o600 });
console.log(`   usage in=${second.usage.inputTokens} out=${second.usage.outputTokens} · 인용 URL ${researchUrls.length}건`);

// ── 결과 ──────────────────────────────────────────────────────────────────
const totalIn = baseline.usage.inputTokens + first.usage.inputTokens + second.usage.inputTokens;
const totalOut = baseline.usage.outputTokens + first.usage.outputTokens + second.usage.outputTokens;
console.log("\n=== 결과 ===");
console.log(`baseline : 인용 URL ${baselineUrls.length}건 · **검증 가능 ${baselineVerifiable.length}건**(수집한 원문이 없으므로 정의상 0이 정상이다)`);
console.log(`research : 인용 URL ${researchUrls.length}건 · 그중 수집·해싱된 원문에 대응 ${verifiable.length}건`);
console.log(`토큰 합계: input ${totalIn} / output ${totalOut} · 검색 backend 호출 ${research.backendCalls}회`);

const report = {
  idea: IDEA,
  baseline: { usage: baseline.usage, citedUrls: baselineUrls, verifiable: baselineVerifiable.length, text: baseline.text },
  research: {
    firstUsage: first.usage,
    secondUsage: second.usage,
    requests,
    backendCalls: research.backendCalls,
    evidence: research.items.map((i) => ({ source: i.source, sha256: i.sha256, bytes: i.bytes })),
    citedUrls: researchUrls,
    verifiableUrls: verifiable,
    text: second.text,
  },
  totals: { inputTokens: totalIn, outputTokens: totalOut },
};
const reportPath = join(evidenceDir, "benchmark.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`\n보고서: ${reportPath}`);
console.log("주의: 이 벤치마크는 **근거의 검증 가능성**만 비교한다 — 문서 품질을 채점하지 않는다.");
