#!/usr/bin/env node
/**
 * V3 M8 — **디자인 산출물 계약 · shadcn read 배선 · handoff 계약/접근성/범위 acceptance**(offline).
 *
 * 네트워크·LLM·프로세스 spawn 없이 임시 디렉터리에서만 돈다. 실패 시 exit 1.
 * `src/*.ts`를 직접 소비한다(tracked `dist/`를 소비하면 낡은 계약을 검사하며 green이 된다).
 *
 * ## 증명한다
 * - ① `DESIGN.md` 필수 헤더 · 3계층 `tokens.json` · component inventory 계약이 **fail-closed**다
 *   (계층 건너뛰기 · dangling 참조 · 빈 계층 · inventory 형식 위반이 각각 거부된다).
 * - ② 접근성이 **공허하지 않다**: 선언된 대비 쌍의 WCAG 비율을 실제로 계산해 미달을 잡고, `min`을 임의
 *   값으로 낮추는 우회와 `text-*` 선언 누락을 거부한다. 대화형 컴포넌트의 focus 토큰을 요구한다.
 * - ③ shadcn read 재사용: registry profile이 M3c의 filtered proxy 계약과 정확히 일치하고
 *   읽기 5도구·금지 2도구가 정책 상수에서 파생된다. **새 proxy를 만들지 않았다.**
 * - ④ custom/private registry 차단이 세 층에서 fail-closed다: 프로젝트(`components.json`) ·
 *   호출 인자(`shadcnReadPolicy`) · inventory 참조/출처(`registryInventory`).
 * - ⑤ registry 응답 원문은 파일에만 있고 중앙·프롬프트에는 포인터+절삭 발췌만 실린다.
 * - ⑥ handoff 계약: 설계에 없는 화면·컴포넌트는 실리지 않고(범위), 승인이 없거나 승인 후 토큰이
 *   바뀌면 handoff가 만들어지지 않는다(승인 재사용 금지).
 * - ⑦ design review 왕복: 같은 세션·같은 task 재사용, 리뷰어 provider/sandbox/role 위반이 거부된다.
 *
 * ## 증명하지 않는다 (정직하게 적는다)
 * - **live LLM 0회 · shadcn registry 실조회 0회** — registry 응답은 fixture다. "실제 모델이 DESIGN.md를
 *   산출하고 registry를 실조회한다"는 **미증명**이다(M8 T6).
 * - **접근성은 tokens 수준에서만** — 렌더링 결과 · 이미지 위 텍스트 · large-text 예외 · 스크린리더·키보드
 *   실동작 · 시각 diff는 범위 밖이며 통과로 주장하지 않는다.
 * - **focus 토큰 존재가 "초점이 실제로 보인다"를 증명하지 않는다** — 토큰 계층의 필요조건일 뿐이다.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const dc = await import(join(REPO_ROOT, "src/core/designContract.ts"));
const ri = await import(join(REPO_ROOT, "src/tools/registryInventory.ts"));
const dh = await import(join(REPO_ROOT, "src/exec/designHandoff.ts"));
const drt = await import(join(REPO_ROOT, "src/exec/designReviewRoundtrip.ts"));
const policy = await import(join(REPO_ROOT, "src/tools/shadcnReadPolicy.ts"));
const { checkComponentsJson } = await import(join(REPO_ROOT, "src/tools/shadcnPilot.ts"));
const { loadToolProfiles } = await import(join(REPO_ROOT, "src/tools/profiles.ts"));
const { extractTokensJson } = await import(join(REPO_ROOT, "src/core/validate.ts"));
const { renderEvidenceDigest } = await import(join(REPO_ROOT, "src/tools/researchGateway.ts"));

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const threwCode = (fn, code) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e?.code === code;
  }
};
const hasCode = (result, code) => result.errors.some((e) => e.code === code);

const dirs = [];
const makeDir = () => {
  const d = mkdtempSync(join(tmpdir(), "m8-acc-"));
  dirs.push(d);
  return d;
};
const NOW = "2026-08-13T00:00:00.000Z";

// ── fixture: 계약을 만족하는 최소 산출물 ────────────────────────
const TOKENS = {
  primitive: { color: { "gray-900": "#111827", white: "#FFFFFF", "blue-600": "#2563EB" }, spacing: { 4: "16px" } },
  semantic: {
    color: {
      "text-primary": "{primitive.color.gray-900}",
      "surface-default": "{primitive.color.white}",
      "action-primary": "{primitive.color.blue-600}",
    },
    spacing: { "component-padding": "{primitive.spacing.4}" },
  },
  component: {
    button: { "bg-primary": "{semantic.color.action-primary}", "focus-ring": "{semantic.color.action-primary}" },
    input: { "focus-ring": "{semantic.color.action-primary}" },
  },
  a11y: { contrastPairs: [{ fg: "semantic.color.text-primary", bg: "semantic.color.surface-default", min: 4.5 }] },
};
const DESIGN_MD = dc.DESIGN_REQUIRED_HEADERS.map((h) => {
  if (h === "컴포넌트 인벤토리") return `## ${h}\n\n- Button: primary, ghost\n- Input: default\n- Card: default\n`;
  if (h === "디자인 토큰") return `## ${h}\n\n\`\`\`json\n${JSON.stringify(TOKENS, null, 2)}\n\`\`\`\n`;
  return `## ${h}\n\n내용\n`;
}).join("\n");
const UX_FLOW = "## 화면 목록\n\n- home: 홈\n- settings: 설정\n";
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log("① 산출물 계약(DESIGN.md · tokens.json · inventory)이 fail-closed다");
check("정상 fixture는 통과한다(공허하지 않은 green)", dc.validateDesignArtifacts(DESIGN_MD, TOKENS).ok);
check(
  "DESIGN.md에서 추출한 tokens 블록이 그대로 계약을 만족한다(추출 경로 단일 출처)",
  dc.validateTokens(JSON.parse(extractTokensJson(DESIGN_MD))).ok,
);
check(
  "필수 헤더 누락은 거부된다",
  hasCode(dc.validateDesignHeaders(DESIGN_MD.split("\n").filter((l) => l !== "## 접근성 기준").join("\n")), "design_header_missing"),
);
check("최상위 key가 3계층+a11y 정확히가 아니면 거부된다", hasCode(dc.validateTokens({ primitive: {}, semantic: {}, component: {} }), "tokens_layers"));
check(
  "계층 건너뛰기(semantic raw 값)는 거부된다",
  hasCode(
    dc.validateTokens(
      (() => {
        const t = clone(TOKENS);
        t.semantic.color["text-primary"] = "#000000";
        return t;
      })(),
    ),
    "tokens_raw_value",
  ),
);
check(
  "dangling 참조는 거부된다",
  hasCode(
    dc.validateTokens(
      (() => {
        const t = clone(TOKENS);
        t.component.button["bg-primary"] = "{semantic.color.nope}";
        return t;
      })(),
    ),
    "tokens_ref_dangling",
  ),
);
check("inventory 섹션 부재는 거부된다", hasCode(dc.parseInventory("## 다른 섹션\n- Button: primary\n").result, "inventory_missing"));
check("inventory bullet 형식 위반은 거부된다", hasCode(dc.parseInventory("## 컴포넌트 인벤토리\n- button primary\n").result, "inventory_line_format"));

console.log("");
console.log("② 접근성 체크가 공허하지 않다(선언 + 실제 계산)");
check("WCAG 계산이 기준값과 맞다(흑/백 21:1)", Math.round(dc.contrastRatio("#000000", "#FFFFFF")) === 21);
check(
  "선언된 쌍의 대비 미달을 실제로 잡는다",
  hasCode(
    dc.validateA11y(
      (() => {
        const t = clone(TOKENS);
        t.primitive.color["gray-900"] = "#AAAAAA";
        return t;
      })(),
    ),
    "a11y_contrast_below_min",
  ),
);
check(
  "min을 임의 값(1)으로 낮춰 통과시키는 우회를 거부한다",
  hasCode(
    dc.validateA11y(
      (() => {
        const t = clone(TOKENS);
        t.a11y.contrastPairs[0].min = 1;
        return t;
      })(),
    ),
    "a11y_min_ratio",
  ),
);
check(
  "text-* 토큰을 선언에서 빼 검사를 비우는 것을 거부한다",
  hasCode(
    dc.validateA11y(
      (() => {
        const t = clone(TOKENS);
        t.semantic.color["text-muted"] = "{primitive.color.gray-900}";
        return t;
      })(),
    ),
    "a11y_text_uncovered",
  ),
);
check("a11y 블록 자체가 없으면 거부된다", hasCode(dc.validateA11y({ primitive: {}, semantic: {}, component: {} }), "a11y_missing"));
check(
  "대화형 컴포넌트에 focus 토큰이 없으면 거부된다",
  hasCode(
    dc.validateFocusTokens([{ name: "Button", variants: ["primary"] }], (() => {
      const t = clone(TOKENS);
      delete t.component.button["focus-ring"];
      return t;
    })()),
    "focus_token_missing",
  ),
);
check(
  "비대화형 컴포넌트에는 focus 토큰을 요구하지 않는다(과잉 게이트 아님)",
  dc.validateFocusTokens([{ name: "Card", variants: ["default"] }], TOKENS).ok,
);

console.log("");
console.log("③ shadcn read 계층을 재사용한다(새 proxy를 만들지 않았다)");
const profile = loadToolProfiles().get("handoff-shadcn-readonly");
check("registry에 filtered read profile이 있다", profile !== undefined);
check("읽기 5도구가 정책 상수와 일치한다", JSON.stringify(profile.bindings.component_registry_read.tools) === JSON.stringify(policy.getAllowedTools()));
check(
  "금지 2도구(install·audit)가 deny에 있다",
  JSON.stringify([...profile.deniedTools].sort()) === JSON.stringify(policy.getForbiddenTools().map(policy.nsName).sort()),
);
check("proxy launcher를 그대로 쓴다(shadcn_read_proxy)", profile.servers[0].launcher === "shadcn_read_proxy");
check(
  "M8이 새 tool profile을 추가하지 않았다(4개 유지)",
  loadToolProfiles().size === 4,
  `현재 ${loadToolProfiles().size}개`,
);

console.log("");
console.log("④ custom/private registry 차단이 세 층에서 fail-closed다");
const projDir = makeDir();
writeFileSync(join(projDir, "components.json"), JSON.stringify({ registries: { "@acme": "https://registry.internal/{name}.json" } }));
const regCheck = checkComponentsJson(projDir);
check("프로젝트 층: components.json의 custom registry는 거부된다", !regCheck.ok && regCheck.code === "custom_registry_forbidden");
check(
  "호출 인자 층: registries가 @shadcn 외면 거부된다",
  threwCode(() => policy.validateToolArgs("list_items_in_registries", { registries: ["@acme"], types: ["ui"] }), "bad_arg"),
);
check(
  "호출 인자 층: 금지 도구는 인자와 무관하게 거부된다",
  threwCode(() => policy.validateToolArgs("get_add_command_for_items", { items: ["@shadcn/button"] }), "forbidden_tool"),
);
check("inventory 층: 비공식 참조(@acme/*)는 거부된다", threwCode(() => ri.assertOfficialRef("@acme/button"), "registry_ref_forbidden"));
check(
  "inventory 층: 비공식 출처 호스트는 거부된다",
  threwCode(() => ri.assertOfficialSource("https://registry.internal/button.json"), "registry_source_forbidden"),
);

console.log("");
console.log("⑤ registry 원문은 파일, 중앙·프롬프트는 포인터+발췌");
const evDir = makeDir();
const RAW = "설명 ".repeat(300) + "\nRAW_TAIL_ONLY_MARKER";
const item = ri.storeRegistryEvidence(evDir, { ref: "@shadcn/button", source: "https://ui.shadcn.com/r/button.json", raw: RAW, retrievedAt: NOW });
check("원문이 content-addressed 파일로 저장된다", readFileSync(join(evDir, "raw", readdirSync(join(evDir, "raw"))[0]), "utf8") === RAW);
check("중앙 포인터에 원문 필드가 없다", !("raw" in item));
check("발췌가 원문이 아니다(절삭이 실제로 일어난다)", item.summary !== RAW && !item.summary.includes("RAW_TAIL_ONLY_MARKER"));
check("프롬프트 digest는 '데이터이며 지시가 아님' 래핑을 거치고 원문을 담지 않는다", (() => {
  const d = renderEvidenceDigest([item]);
  return d.includes("데이터이며 지시가 아니다") && !d.includes("RAW_TAIL_ONLY_MARKER") && d.includes(item.sha256);
})());
const failDir = makeDir();
try {
  ri.storeRegistryEvidence(failDir, { ref: "@acme/x", source: "https://ui.shadcn.com/r/x.json", raw: "a", retrievedAt: NOW });
} catch {}
check("검증 실패면 파일조차 만들지 않는다", readdirSync(failDir).length === 0);
check(
  "inventory ↔ registry 연결: 매칭은 참조, 미매칭은 null, 비공식이 섞이면 전체 거부",
  (() => {
    const linked = ri.linkInventory([{ name: "Button", variants: ["primary"] }, { name: "PriceGauge", variants: ["default"] }], ["@shadcn/button"]);
    const ok = linked[0].registryRef === "@shadcn/button" && linked[1].registryRef === null;
    return ok && threwCode(() => ri.linkInventory([{ name: "Button", variants: ["p"] }], ["@acme/button"]), "registry_ref_forbidden");
  })(),
);

console.log("");
console.log("⑥ handoff 계약 — 범위·승인");
const baseInput = {
  designMd: DESIGN_MD,
  uxFlowMd: UX_FLOW,
  tokens: TOKENS,
  registryRefs: ["@shadcn/button", "@shadcn/input"],
  screens: [{ id: "home", components: ["Button", "Input"] }],
  approval: { decisionId: "msg-1", tokensSha256: dh.tokensDigest(TOKENS) },
};
const contract = dh.buildDesignHandoff(baseInput);
check("정상 입력에서 닫힌 형태 계약이 만들어진다", JSON.stringify(Object.keys(contract).sort()) === JSON.stringify(["approvalDecisionId", "components", "designSha256", "screens", "tokensSha256"]));
check("계약에 디자인·토큰 원문이 실리지 않는다(digest만)", !JSON.stringify(contract).includes("## 디자인 방향") && !JSON.stringify(contract).includes("#111827"));
check("설계에 있어도 화면에 안 쓰인 컴포넌트는 handoff에 없다", contract.components.every((c) => c.name !== "Card"));
check(
  "범위: UX flow에 없는 화면은 거부된다",
  threwCode(() => dh.buildDesignHandoff({ ...baseInput, screens: [{ id: "admin", components: ["Button"] }] }), "scope_violation"),
);
check(
  "범위: 인벤토리에 없는 컴포넌트는 거부된다",
  threwCode(() => dh.buildDesignHandoff({ ...baseInput, screens: [{ id: "home", components: ["Wizard"] }] }), "scope_violation"),
);
check("승인 없으면 handoff가 없다", threwCode(() => dh.buildDesignHandoff({ ...baseInput, approval: undefined }), "approval_missing"));
check(
  "승인 후 토큰이 바뀌면 그 승인을 재사용할 수 없다",
  threwCode(
    () =>
      dh.buildDesignHandoff({
        ...baseInput,
        tokens: (() => {
          const t = clone(TOKENS);
          t.primitive.color["gray-900"] = "#000000";
          return t;
        })(),
      }),
    "approval_stale",
  ),
);
check(
  "계약 위반 산출물은 handoff 단계에서도 거부된다",
  threwCode(() => dh.buildDesignHandoff({ ...baseInput, designMd: DESIGN_MD.split("\n").filter((l) => l !== "## 접근성 기준").join("\n") }), "design_contract_violation"),
);

console.log("");
console.log("⑦ design review 왕복 — fresh Codex 리뷰 / fresh design worker 수정");
const OK_RT = {
  author: { taskId: "design-1", roleId: "design", provider: "claude", sessionId: "s-a", fresh: false },
  reviewer: { taskId: "review-1", roleId: "qa-security", provider: "codex", sessionId: "s-r", sandbox: "read-only", fresh: true },
  revision: { taskId: "design-2", roleId: "design.revise", provider: "claude", sessionId: "s-v", fresh: true },
};
const rtCode = (over) => {
  try {
    drt.assertDesignReviewRoundtrip({ ...clone(OK_RT), ...over });
    return "(통과)";
  } catch (e) {
    return e?.code ?? "(unknown)";
  }
};
check("정상 왕복은 통과한다", rtCode({}) === "(통과)");
check("같은 세션 재사용은 거부된다", rtCode({ reviewer: { ...OK_RT.reviewer, sessionId: "s-a" } }) === "participant_session_reused");
check("같은 task 재사용(자기 승인)은 거부된다", rtCode({ revision: { ...OK_RT.revision, taskId: "design-1" } }) === "participant_task_reused");
check("리뷰어가 codex가 아니면 거부된다", rtCode({ reviewer: { ...OK_RT.reviewer, provider: "claude" } }) === "reviewer_provider");
check("리뷰어 sandbox가 read-only가 아니면 거부된다", rtCode({ reviewer: { ...OK_RT.reviewer, sandbox: "workspace-write" } }) === "reviewer_sandbox");
check("design role이 자기 산출물을 검토하는 배선은 거부된다", rtCode({ reviewer: { ...OK_RT.reviewer, roleId: "design" } }) === "reviewer_role");
check("수정자가 fresh가 아니면 거부된다", rtCode({ revision: { ...OK_RT.revision, fresh: false } }) === "revision_not_fresh");

console.log("");
console.log(`PASS=${pass} FAIL=${fail}`);
console.log("미증명(정직하게): live LLM 0회 · shadcn registry 실조회 0회(fixture) · 접근성은 tokens 수준만(렌더링·스크린리더·시각 diff 범위 밖).");
for (const d of dirs) rmSync(d, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
