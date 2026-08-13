/**
 * [V3 M8 T3/T5] handoff 계약 · 범위 · 사람 승인 red-path 테스트 (무의존, node:test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesignHandoff, DesignHandoffError, parseScreens, tokensDigest } from "./designHandoff.js";
import { DESIGN_REQUIRED_HEADERS } from "../core/designContract.js";

const TOKENS = {
  primitive: { color: { "gray-900": "#111827", white: "#FFFFFF", "blue-500": "#3B82F6" }, spacing: { "4": "16px" } },
  semantic: {
    color: {
      "text-primary": "{primitive.color.gray-900}",
      "surface-default": "{primitive.color.white}",
      "action-primary": "{primitive.color.blue-500}",
    },
    spacing: { "component-padding": "{primitive.spacing.4}" },
  },
  component: {
    button: { "bg-primary": "{semantic.color.action-primary}", "focus-ring": "{semantic.color.action-primary}" },
    input: { "focus-ring": "{semantic.color.action-primary}" },
  },
  a11y: { contrastPairs: [{ fg: "semantic.color.text-primary", bg: "semantic.color.surface-default", min: 4.5 }] },
};

const DESIGN_MD = DESIGN_REQUIRED_HEADERS.map((h) =>
  h === "컴포넌트 인벤토리" ? `## ${h}\n\n- Button: primary, ghost\n- Input: default\n- Card: default\n` : `## ${h}\n\n내용\n`,
).join("\n");

const UX_FLOW = "## 화면 목록\n\n- home: 홈\n- settings: 설정\n";

function input(over: Partial<Parameters<typeof buildDesignHandoff>[0]> = {}) {
  return {
    designMd: DESIGN_MD,
    uxFlowMd: UX_FLOW,
    tokens: TOKENS,
    registryRefs: ["@shadcn/button", "@shadcn/input"],
    screens: [{ id: "home", components: ["Button", "Input"] }],
    approval: { decisionId: "msg-1", tokensSha256: tokensDigest(TOKENS) },
    ...over,
  };
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof DesignHandoffError ? e.code : `unexpected:${(e as Error).name}`;
  }
  return "(통과했다)";
};

test("정상: 닫힌 형태 계약이 만들어지고 원문을 담지 않는다", () => {
  const c = buildDesignHandoff(input());
  assert.deepEqual(Object.keys(c).sort(), ["approvalDecisionId", "components", "designSha256", "screens", "tokensSha256"]);
  assert.equal(c.tokensSha256, tokensDigest(TOKENS));
  assert.equal(c.approvalDecisionId, "msg-1");
  // 화면에 쓰인 컴포넌트만 실린다(Card는 인벤토리에 있어도 handoff엔 없다).
  assert.deepEqual(c.components.map((x) => [x.name, x.registryRef]), [["Button", "@shadcn/button"], ["Input", "@shadcn/input"]]);
  // 원문(DESIGN.md/tokens 본문)은 계약에 없다 — digest만.
  assert.ok(!JSON.stringify(c).includes("## 디자인 방향"));
  assert.ok(!JSON.stringify(c).includes("#111827"));
});

test("계약 위반(tokens a11y 누락 / 헤더 누락)이면 handoff 없음", () => {
  const noA11y = JSON.parse(JSON.stringify(TOKENS));
  delete noA11y.a11y;
  assert.equal(codeOf(() => buildDesignHandoff(input({ tokens: noA11y, approval: { decisionId: "m", tokensSha256: tokensDigest(noA11y) } }))), "design_contract_violation");
  const cut = DESIGN_MD.split("\n").filter((l) => l !== "## 접근성 기준").join("\n");
  assert.equal(codeOf(() => buildDesignHandoff(input({ designMd: cut }))), "design_contract_violation");
});

test("범위: 설계에 없는 화면·컴포넌트는 red", () => {
  assert.equal(codeOf(() => buildDesignHandoff(input({ screens: [{ id: "admin", components: ["Button"] }] }))), "scope_violation");
  assert.equal(codeOf(() => buildDesignHandoff(input({ screens: [{ id: "home", components: ["Wizard"] }] }))), "scope_violation");
  assert.equal(codeOf(() => buildDesignHandoff(input({ screens: [] }))), "scope_violation");
  assert.equal(codeOf(() => buildDesignHandoff(input({ screens: [{ id: "home", components: [] }] }))), "scope_violation");
  assert.equal(
    codeOf(() => buildDesignHandoff(input({ screens: [{ id: "home", components: ["Button"] }, { id: "home", components: ["Input"] }] }))),
    "scope_violation",
  );
  // UX flow에 화면 목록 섹션이 없으면 어떤 화면도 선언되지 않은 것 → fail-closed
  assert.equal(codeOf(() => buildDesignHandoff(input({ uxFlowMd: "## 다른 섹션\n- home: 홈\n" }))), "scope_violation");
});

test("사람 승인: 없거나 승인 후 토큰이 바뀌면 red (승인 재사용 금지)", () => {
  assert.equal(codeOf(() => buildDesignHandoff(input({ approval: undefined as never }))), "approval_missing");
  assert.equal(codeOf(() => buildDesignHandoff(input({ approval: { decisionId: "", tokensSha256: tokensDigest(TOKENS) } }))), "approval_missing");
  assert.equal(codeOf(() => buildDesignHandoff(input({ approval: { decisionId: "m", tokensSha256: "0".repeat(64) } }))), "approval_stale");
  // 승인 후 토큰만 살짝 바꿔 재사용 시도
  const changed = JSON.parse(JSON.stringify(TOKENS));
  changed.primitive.color["gray-900"] = "#000000";
  assert.equal(codeOf(() => buildDesignHandoff(input({ tokens: changed }))), "approval_stale");
});

test("registry: 비공식 ref가 섞이면 handoff 자체가 red", () => {
  assert.equal(codeOf(() => buildDesignHandoff(input({ registryRefs: ["@shadcn/button", "@acme/input"] }))), "unexpected:RegistryInventoryError");
});

test("tokensDigest: key 순서에 흔들리지 않고 값 변경은 잡는다", () => {
  const reordered = { a11y: TOKENS.a11y, component: TOKENS.component, semantic: TOKENS.semantic, primitive: TOKENS.primitive };
  assert.equal(tokensDigest(reordered), tokensDigest(TOKENS));
  const changed = JSON.parse(JSON.stringify(TOKENS));
  changed.semantic.spacing["component-padding"] = "{primitive.spacing.4} ";
  assert.notEqual(tokensDigest(changed), tokensDigest(TOKENS));
});

test("parseScreens: 화면 목록 파싱 + 중복 제거", () => {
  assert.deepEqual(parseScreens(UX_FLOW), [{ id: "home", name: "홈" }, { id: "settings", name: "설정" }]);
  assert.deepEqual(parseScreens("## 화면 목록\n- home: 홈\n- home: 중복\n"), [{ id: "home", name: "홈" }]);
  assert.deepEqual(parseScreens("본문만 있음"), []);
});
