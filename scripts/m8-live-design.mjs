#!/usr/bin/env node
/**
 * V3 M8 T6 — **live 1회: 실제 모델이 디자인 산출물을 만들고, shadcn registry를 실조회한다.**
 *
 * ⚠️ **구독 한도를 소모한다**(Claude Code CLI `claude -p` 왕복 1~2회). 사용자 승인 없이 실행하지 않는다.
 * shadcn registry는 무료 공개 registry이지만 **네트워크가 나간다**. `acceptance.sh`에 등록하지 않는다
 * (M5/M7 live probe와 같은 규율: 수동 실행 전용).
 *
 * **Codex live는 이 스크립트에 없다**(사용자 결정 2026-08-13 — Codex 인증 방식이 실결제일 수 있어 제외).
 * 따라서 "design review는 fresh Codex"의 **실제 프로세스 왕복은 여전히 미증명**이고, 계약 층
 * (`designReviewRoundtrip.ts`)만 증명된 상태다. 그렇게 보고한다.
 *
 * 무엇을 확인하는가:
 *   A. 실제 모델이 `agents/design_agent.md` 계약(9헤더 + 4 key tokens + a11y 선언)대로 산출하는가.
 *      → `designContract.validateDesignArtifacts`로 판정하고, **실패하면 실패로 적는다**(재시도 1회까지).
 *   B. filtered proxy를 통과한 **실제 registry 응답**으로 inventory ↔ `@shadcn/*` 연결이 되는가.
 *      원문은 evidence 파일에만 남고 중앙에는 발췌만 남는지 실데이터로 확인한다.
 *   C. 위 둘로 handoff 계약이 실제로 만들어지는가(범위·승인 게이트 포함).
 *
 * 산출물은 임시 디렉터리에만 쓴다(외부 원문·모델 산출물을 레포에 커밋하지 않는다). 요약만 stdout.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.HARNESS_ACCEPTANCE_TSX !== "1") {
  const { spawnSync } = await import("node:child_process");
  // argv를 그대로 넘긴다 — 넘기지 않으면 `--registry-only` 같은 플래그가 사라지고 LLM 왕복이 일어난다(실측).
  const relaunch = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, HARNESS_ACCEPTANCE_TSX: "1" },
  });
  process.exit(relaunch.status === null ? 1 : relaunch.status);
}

const dc = await import(join(REPO_ROOT, "src/core/designContract.ts"));
const ri = await import(join(REPO_ROOT, "src/tools/registryInventory.ts"));
const dh = await import(join(REPO_ROOT, "src/exec/designHandoff.ts"));
const { extractTokensJson } = await import(join(REPO_ROOT, "src/core/validate.ts"));
const { renderEvidenceDigest } = await import(join(REPO_ROOT, "src/tools/researchGateway.ts"));
const policy = await import(join(REPO_ROOT, "src/tools/shadcnReadPolicy.ts"));

const OUT_DIR = mkdtempSync(join(tmpdir(), "m8-live-"));
/** `--registry-only`: B(registry 실조회)만 돈다 — **LLM 왕복 0회 = 구독 소모 0**(배선 디버그용). */
const REGISTRY_ONLY = process.argv.includes("--registry-only");
console.log(`=== M8 T6 live (${REGISTRY_ONLY ? "registry만 · LLM 0회" : "구독 한도 소모"} · Codex 제외) ===\n산출물: ${OUT_DIR}\n`);

// ── A. 실제 모델이 DESIGN.md를 산출한다 (도구 없음 · plan 모드) ──────────────
const NO_TOOL_ARGS = ["-p", "--output-format", "json", "--strict-mcp-config", "--setting-sources", "", "--tools", "", "--permission-mode", "plan"];

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
        /* JSON이 아니면 raw */
      }
      resolve({ text, usage });
    });
    child.stdin.end(prompt);
  });
}

// 계약을 프롬프트에 그대로 싣는다 — 생산자 프롬프트(agents/design_agent.md §3·§4)의 요약이며
// **검증기와 같은 계약**이다. 여기서 계약을 느슨하게 적으면 live 통과는 의미가 없다.
const UX_FLOW = "## 화면 목록\n\n- home: 홈 대시보드\n- detail: 상세\n- settings: 설정\n";
const DESIGN_TASK = `너는 design 에이전트다. 아래 UX flow에 대한 \`DESIGN.md\`를 써라. 설명·인사말 없이 문서만 출력하라.

[필수 \`## \` 헤더 — 정확한 이름으로 전부]
${dc.DESIGN_REQUIRED_HEADERS.map((h) => `## ${h}`).join("\n")}

[## 컴포넌트 인벤토리 형식]
각 컴포넌트를 \`- <PascalName>: <variant>, <variant>\` bullet 한 줄로. 5개 이하.

[## 디자인 토큰 — 정확히 하나의 \`\`\`json 코드펜스]
최상위 key는 정확히 primitive / semantic / component / a11y 넷.
**모든 토큰 값은 문자열이다** — CSS에서 unitless인 값도 문자열로: "500", "1.5" (숫자 500·1.5는 거부된다).
- primitive: raw 값만(색은 #rrggbb)
- semantic: \`{primitive.<group>.<name>}\` 참조만
- component: \`{semantic.<group>.<name>}\` 참조만
- 대화형 컴포넌트(Button/Input/Select/Checkbox/Radio/Switch/Textarea/Link/Tab/MenuItem)는
  component.<kebab-name> group에 이름에 focus가 들어간 토큰을 둔다
- a11y: { "contrastPairs": [ { "fg": "semantic.color.<name>", "bg": "semantic.color.<name>", "min": 4.5 } ] }
  모든 semantic.color.text-* 토큰이 어느 쌍의 fg로 등장해야 하고, 대비비는 min 이상이어야 한다(WCAG 2.x).

[UX flow]
${UX_FLOW}`;

let designMd = null;
let tokens = null;
let attempts = 0;
let usageTotal = { inputTokens: 0, outputTokens: 0 };
let lastErrors = [];
let prompt = DESIGN_TASK;

while (!REGISTRY_ONLY && attempts < 2) {
  attempts += 1;
  console.log(`A${attempts}. design worker live 호출`);
  const r = await ask(prompt, `design-${attempts}`);
  usageTotal = { inputTokens: usageTotal.inputTokens + r.usage.inputTokens, outputTokens: usageTotal.outputTokens + r.usage.outputTokens };
  console.log(`   usage in=${r.usage.inputTokens} out=${r.usage.outputTokens} · ${r.text.length} chars`);
  const md = r.text;
  const raw = extractTokensJson(md);
  let parsed = null;
  try {
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const result = parsed === null ? { ok: false, errors: [{ code: "tokens_block_missing", where: "(json fence)", message: "tokens json 블록을 파싱할 수 없다" }] } : dc.validateDesignArtifacts(md, parsed);
  writeFileSync(join(OUT_DIR, `design-attempt-${attempts}.md`), md);
  if (result.ok) {
    designMd = md;
    tokens = parsed;
    console.log(`   계약 검증: PASS`);
    break;
  }
  lastErrors = result.errors;
  console.log(`   계약 검증: FAIL ${result.errors.length}건 — ${result.errors.map((e) => `${e.code}@${e.where}`).slice(0, 8).join(", ")}`);
  // 재시도는 1회만. 위반 코드를 그대로 되돌려준다(사람이 고쳐주지 않는다).
  prompt = `${DESIGN_TASK}\n\n[직전 출력의 계약 위반 — 이것만 고쳐 전체 문서를 다시 출력하라]\n${result.errors.map((e) => `- ${e.code} @ ${e.where}: ${e.message}`).join("\n")}`;
}

if (REGISTRY_ONLY) {
  console.log("A. 건너뜀 (--registry-only · LLM 왕복 0회)");
} else if (designMd === null) {
  console.log(`\nA 결과: **실패** — 실제 모델 산출물이 ${attempts}회 시도에서 계약을 통과하지 못했다.`);
  console.log(`   마지막 위반: ${lastErrors.map((e) => e.code).join(", ")}`);
} else {
  console.log(`\nA 결과: 통과(시도 ${attempts}회)`);
}

// ── B. shadcn registry 실조회 (filtered proxy 경유 · 네트워크) ────────────────
console.log("\nB. shadcn registry 실조회 — filtered proxy 경유");
const { runShadcnReadProxy } = await import(join(REPO_ROOT, "src/tools/shadcnReadMcpProxy.ts"));
const { Readable, Writable } = await import("node:stream");

/** upstream MCP client 역할: proxy에 initialize → tools/call 2건을 보내고 응답 라인을 모은다. */
async function callProxy(calls) {
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: policy.REQUEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "m8-live", version: "1" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    ...calls.map((c, i) => JSON.stringify({ jsonrpc: "2.0", id: 10 + i, method: "tools/call", params: { name: c.name, arguments: c.arguments } })),
  ];
  const input = Readable.from(lines.map((l) => l + "\n"));
  let buf = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  const result = await runShadcnReadProxy({ serviceCwd: OUT_DIR, now: () => new Date().toISOString(), input, output });
  const responses = buf
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { result, responses };
}

let registryRefs = [];
let evidenceItem = null;
try {
  const { result, responses } = await callProxy([
    { name: "list_items_in_registries", arguments: { registries: ["@shadcn"], types: ["ui"], limit: 20, offset: 0 } },
    { name: "view_items_in_registries", arguments: { items: ["@shadcn/button"] } },
    // 예제(코드 포함)를 한 건 더 읽는다 — 원문이 발췌 상한을 넘는 실데이터로 절삭을 실제로 밟기 위해서다.
    { name: "get_item_examples_from_registries", arguments: { registries: ["@shadcn"], query: "button-demo" } },
  ]);
  console.log(`   proxy toolCalls=${result.toolCalls} 거부=${result.rejectedCalls} 금지시도=${result.forbiddenAttempts}`);
  const textOf = (resp) => (resp?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const listText = textOf(responses.find((r) => r.id === 10));
  if (process.env.M8_LIVE_DEBUG === "1") console.log(`   [debug] list 응답 앞 600자:\n${listText.slice(0, 600)}`);
  const viewText = [textOf(responses.find((r) => r.id === 11)), textOf(responses.find((r) => r.id === 12))].filter((t) => t.length > 0).join("\n\n");
  // 실측 응답 형식(2026-08-13): `- <name> (registry:ui) [@shadcn]` — **bare 이름**이다(`@shadcn/x`가 아니다).
  // 이름만 뽑아 우리가 참조를 조립하고, 조립한 것도 `assertOfficialRef`로 다시 좁힌다(외부 문자열을 그대로 신뢰하지 않는다).
  registryRefs = [
    ...new Set(
      (listText.match(/^-\s+([a-z0-9][a-z0-9-]{0,49})\s+\(registry:ui\)\s+\[@shadcn\]/gm) ?? []).map((l) => l.replace(/^-\s+/, "").split(/\s+/)[0]),
    ),
  ]
    .map((n) => {
      try {
        return ri.assertOfficialRef(`@shadcn/${n}`);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  console.log(`   실조회 registry item ${registryRefs.length}건 (예: ${registryRefs.slice(0, 5).join(", ")})`);
  if (viewText.length > 0) {
    evidenceItem = ri.storeRegistryEvidence(OUT_DIR, {
      ref: "@shadcn/button",
      source: "https://ui.shadcn.com/r/button.json",
      raw: viewText,
      retrievedAt: new Date().toISOString(),
    });
    const rawFile = readdirSync(join(OUT_DIR, "raw"))[0];
    const stored = readFileSync(join(OUT_DIR, "raw", rawFile), "utf8");
    const digest = renderEvidenceDigest([evidenceItem]);
    console.log(`   원문 ${stored.length} chars → 파일(sha256 ${evidenceItem.sha256.slice(0, 12)}…) · 중앙 발췌 ${evidenceItem.summary.length} chars`);
    // 계약대로: 원문이 상한(MAX_EXCERPT_CHARS=400) 이하면 발췌=원문이다. 상한을 넘을 때만 절삭된다 —
    // "발췌≠원문"을 무조건 기대하면 짧은 응답에서 거짓 실패로 읽힌다.
    const truncated = stored.length > 400;
    console.log(`   원문 ${truncated ? "상한 초과 → 절삭됨" : "상한 이하 → 발췌=원문(계약대로)"} · 절삭 실제 발생: ${evidenceItem.summary !== stored}`);
    console.log(`   digest가 원문 전체를 담지 않는다: ${truncated ? !digest.includes(stored) : "판정 불가(원문이 상한 이하)"}`);
  }
} catch (e) {
  console.log(`   registry 실조회 실패: ${e?.code ?? ""} ${(e?.message ?? String(e)).slice(0, 200)}`);
}

// ── C. handoff 계약 (A·B 결과로) ─────────────────────────────────────────────
console.log("\nC. handoff 계약");
if (designMd === null) {
  console.log("   건너뜀 — A가 실패해 계약 입력이 없다(mock으로 대체하지 않는다).");
} else {
  const inv = dc.parseInventory(designMd).components;
  const screens = [{ id: "home", components: inv.slice(0, 2).map((c) => c.name) }];
  try {
    const contract = dh.buildDesignHandoff({
      designMd,
      uxFlowMd: UX_FLOW,
      tokens,
      registryRefs,
      screens,
      approval: { decisionId: "live-approval-1", tokensSha256: dh.tokensDigest(tokens) },
    });
    console.log(`   handoff 생성 OK — 화면 ${contract.screens.length} · 컴포넌트 ${contract.components.length} (registry 연결 ${contract.components.filter((c) => c.registryRef).length}건)`);
    console.log(`   범위 red-path 재확인(설계에 없는 화면): ${(() => {
      try {
        dh.buildDesignHandoff({ designMd, uxFlowMd: UX_FLOW, tokens, registryRefs, screens: [{ id: "nope", components: screens[0].components }], approval: { decisionId: "x", tokensSha256: dh.tokensDigest(tokens) } });
        return "거부되지 않았다(문제)";
      } catch (e) {
        return e?.code ?? "unknown";
      }
    })()}`);
  } catch (e) {
    console.log(`   handoff 실패: ${e?.code ?? ""} ${(e?.message ?? String(e)).slice(0, 200)}`);
  }
}

console.log(`\n=== 요약 ===`);
console.log(`design worker live 호출 ${attempts}회 · usage in=${usageTotal.inputTokens} out=${usageTotal.outputTokens}(CLI 보고값 그대로)`);
console.log(`계약 통과: ${designMd !== null} · registry 실조회 item ${registryRefs.length}건 · evidence ${evidenceItem ? 1 : 0}건`);
console.log("미증명(정직하게): fresh Codex design review의 실제 프로세스 왕복(사용자 결정으로 제외) · 표본 1건이므로 일반화하지 않는다.");
console.log(`산출물(레포 밖): ${OUT_DIR}`);
