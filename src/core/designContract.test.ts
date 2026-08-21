/**
 * [V3 M8 T1] 디자인 산출물 계약 fail-closed 테스트 (무의존, node:test).
 * 각 규칙마다 "정상 fixture는 green" + "규칙 위반 fixture는 그 코드로 red"를 쌍으로 고정한다
 * (규칙을 지우는 mutation은 위반 fixture가 green이 되면서 red 난다).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  DESIGN_REQUIRED_HEADERS,
  parseInventory,
  validateA11y,
  validateFocusTokens,
  resolveToken,
  validateDesignArtifacts,
  validateDesignHeaders,
  validateTokens,
} from "./designContract.js";

const GOOD_TOKENS = {
  primitive: {
    color: { "blue-500": "#3B82F6", "gray-900": "#111827", white: "#FFFFFF" },
    spacing: { "4": "16px" },
  },
  semantic: {
    color: {
      "text-primary": "{primitive.color.gray-900}",
      "action-primary": "{primitive.color.blue-500}",
      "surface-default": "{primitive.color.white}",
    },
    spacing: { "component-padding": "{primitive.spacing.4}" },
  },
  component: {
    button: {
      "bg-primary": "{semantic.color.action-primary}",
      "padding-x": "{semantic.spacing.component-padding}",
      "focus-ring": "{semantic.color.action-primary}",
    },
    input: { "focus-ring": "{semantic.color.action-primary}" },
  },
  a11y: {
    contrastPairs: [{ fg: "semantic.color.text-primary", bg: "semantic.color.surface-default", min: 4.5 }],
  },
};

/** 깊은 복제 후 mutate 헬퍼 — fixture 오염 방지. */
function mut(f: (t: typeof GOOD_TOKENS) => void): unknown {
  const t = JSON.parse(JSON.stringify(GOOD_TOKENS));
  f(t);
  return t;
}

const GOOD_DESIGN = [
  ...DESIGN_REQUIRED_HEADERS.map((h) =>
    h === "컴포넌트 인벤토리"
      ? `## ${h}\n\nMVP 컴포넌트:\n- Button: primary, secondary, ghost\n- Input: default, error\n`
      : `## ${h}\n\n내용\n`,
  ),
].join("\n");

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code).sort();

test("정상 fixture: 헤더·인벤토리·토큰 전부 통과", () => {
  const r = validateDesignArtifacts(GOOD_DESIGN, GOOD_TOKENS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test("tokens: 최상위 key가 3계층+a11y 정확히가 아니면 red", () => {
  assert.deepEqual(codes(validateTokens({ primitive: {}, semantic: {} })), ["tokens_layers"]);
  // a11y 누락(3계층만) → red. 접근성 선언을 빼고 통과하는 길이 없다.
  assert.deepEqual(codes(validateTokens(mut((t) => delete (t as Record<string, unknown>).a11y))), ["tokens_layers"]);
  assert.deepEqual(codes(validateTokens(mut((t) => ((t as Record<string, unknown>).extra = { a: { b: "1px" } })))), ["tokens_layers"]);
  assert.deepEqual(codes(validateTokens("nope")), ["tokens_not_object"]);
});

test("tokens: 빈 계층/빈 group은 red (형식만 갖춘 공허한 통과 방지)", () => {
  assert.ok(codes(validateTokens(mut((t) => (t.primitive = {} as never)))).includes("tokens_layer_shape"));
  assert.ok(codes(validateTokens(mut((t) => (t.primitive.color = {} as never)))).includes("tokens_group_shape"));
});

test("tokens: 계층 건너뛰기 — semantic raw 값 / component→primitive 참조는 red", () => {
  assert.ok(codes(validateTokens(mut((t) => (t.semantic.color["text-primary"] = "#000000")))).includes("tokens_raw_value"));
  assert.ok(
    codes(validateTokens(mut((t) => (t.component.button["bg-primary"] = "{primitive.color.blue-500}")))).includes("tokens_ref_layer"),
  );
  assert.ok(codes(validateTokens(mut((t) => (t.primitive.color["blue-500"] = "{semantic.color.text-primary}")))).includes("tokens_primitive_ref"));
});

test("tokens: dangling 참조·형식 위반·비문자열 값은 red", () => {
  assert.ok(codes(validateTokens(mut((t) => (t.semantic.color["text-primary"] = "{primitive.color.nope}")))).includes("tokens_ref_dangling"));
  assert.ok(codes(validateTokens(mut((t) => (t.semantic.color["text-primary"] = "{primitive.color}")))).includes("tokens_ref_format"));
  assert.ok(codes(validateTokens(mut((t) => ((t.primitive.color as Record<string, unknown>)["blue-500"] = 500)))).includes("tokens_value_type"));
});

test("resolveToken: component→semantic→primitive를 raw까지 해석, 미상 경로는 null", () => {
  assert.equal(resolveToken(GOOD_TOKENS, "component.button.bg-primary"), "#3B82F6");
  assert.equal(resolveToken(GOOD_TOKENS, "semantic.spacing.component-padding"), "16px");
  assert.equal(resolveToken(GOOD_TOKENS, "primitive.color.gray-900"), "#111827");
  assert.equal(resolveToken(GOOD_TOKENS, "semantic.color.nope"), null);
  // 순환 참조는 무한 루프가 아니라 null (3홉 상한).
  const cyclic = mut((t) => {
    t.semantic.color["text-primary"] = "{primitive.color.gray-900}";
    t.primitive.color["gray-900"] = "{semantic.color.text-primary}" as never;
  });
  assert.equal(resolveToken(cyclic, "component.button.bg-primary"), "#3B82F6"); // 무관 경로는 정상
  assert.equal(resolveToken(cyclic, "semantic.color.text-primary"), null);
});

test("inventory: 정상 파싱 + 섹션 부재/빈 목록/형식 위반/중복은 red", () => {
  const ok = parseInventory(GOOD_DESIGN);
  assert.deepEqual(ok.result.errors, []);
  assert.deepEqual(ok.components, [
    { name: "Button", variants: ["primary", "secondary", "ghost"] },
    { name: "Input", variants: ["default", "error"] },
  ]);

  assert.deepEqual(codes(parseInventory("## 다른 섹션\n- Button: primary\n").result), ["inventory_missing"]);
  assert.deepEqual(codes(parseInventory("## 컴포넌트 인벤토리\n\n아직 없음\n").result), ["inventory_empty"]);
  assert.ok(codes(parseInventory("## 컴포넌트 인벤토리\n- button primary\n").result).includes("inventory_line_format"));
  assert.ok(codes(parseInventory("## 컴포넌트 인벤토리\n- Button: \n").result).includes("inventory_line_format"));
  assert.ok(
    codes(parseInventory("## 컴포넌트 인벤토리\n- Button: primary\n- Button: ghost\n").result).includes("inventory_duplicate"),
  );
});

test("a11y: 선언 형식·계산·공허함 방지 3층이 각각 red", () => {
  assert.deepEqual(validateA11y(GOOD_TOKENS).errors, []);
  // 형식
  assert.ok(codes(validateA11y(mut((t) => (t.a11y = { pairs: [] } as never)))).includes("a11y_keys"));
  assert.ok(codes(validateA11y(mut((t) => (t.a11y.contrastPairs = [] as never)))).includes("a11y_pairs_shape"));
  assert.ok(codes(validateA11y(mut((t) => (t.a11y.contrastPairs[0] = { fg: "semantic.color.text-primary", bg: "semantic.color.surface-default" } as never)))).includes("a11y_pair_keys"));
  // min을 1로 낮춰 무조건 통과시키는 우회 → red
  assert.ok(codes(validateA11y(mut((t) => (t.a11y.contrastPairs[0].min = 1 as never)))).includes("a11y_min_ratio"));
  // primitive 직접 참조·미해석 경로
  assert.ok(codes(validateA11y(mut((t) => (t.a11y.contrastPairs[0].fg = "primitive.color.gray-900")))).includes("a11y_pair_path"));
  assert.ok(codes(validateA11y(mut((t) => (t.a11y.contrastPairs[0].fg = "semantic.color.nope")))).includes("a11y_pair_unresolved"));
  // 색이 아닌 값(spacing)을 쌍으로 선언 → red
  assert.ok(codes(validateA11y(mut((t) => (t.a11y.contrastPairs[0].fg = "semantic.spacing.component-padding")))).includes("a11y_pair_not_color"));
  // 계산: 실제 대비 미달(회색 텍스트 on 흰 배경)
  assert.ok(
    codes(
      validateA11y(
        mut((t) => {
          t.primitive.color["gray-900"] = "#AAAAAA";
        }),
      ),
    ).includes("a11y_contrast_below_min"),
  );
  // 공허함 방지: text-* 토큰을 추가하고 쌍에 넣지 않으면 red
  assert.ok(
    codes(
      validateA11y(mut((t) => ((t.semantic.color as Record<string, string>)["text-muted"] = "{primitive.color.gray-900}"))),
    ).includes("a11y_text_uncovered"),
  );
});

test("contrastRatio: WCAG 기준값 검증(흑/백 21:1, 동일색 1:1, 잘못된 형식 null)", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF")!), 21);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  assert.ok(Math.abs(contrastRatio("#777777", "#FFFFFF")! - 4.48) < 0.05); // AA 4.5 바로 아래
  assert.equal(contrastRatio("16px", "#FFFFFF"), null);
  assert.equal(contrastRatio("#FFF", "#000"), 21); // #rgb 축약형
});

test("focus 토큰: 대화형 컴포넌트에 focus 토큰이 없으면 red, 비대화형은 요구하지 않음", () => {
  const inv = [
    { name: "Button", variants: ["primary"] },
    { name: "Card", variants: ["default"] }, // 비대화형 — group 없어도 통과
  ];
  assert.deepEqual(validateFocusTokens(inv, GOOD_TOKENS).errors, []);
  assert.ok(codes(validateFocusTokens(inv, mut((t) => delete (t.component.button as Record<string, unknown>)["focus-ring"]))).includes("focus_token_missing"));
  assert.ok(codes(validateFocusTokens(inv, mut((t) => delete (t.component as Record<string, unknown>).button))).includes("focus_group_missing"));
  // 인벤토리에 있는 대화형 컴포넌트는 이름 kebab 변환으로 찾는다(MenuItem → menu-item).
  assert.ok(codes(validateFocusTokens([{ name: "MenuItem", variants: ["default"] }], GOOD_TOKENS)).includes("focus_group_missing"));
});

test("DESIGN.md: 필수 헤더 하나만 빠져도 red (v1 경고와 달리 fail-closed)", () => {
  for (const h of DESIGN_REQUIRED_HEADERS) {
    const missing = GOOD_DESIGN.split("\n").filter((l) => l !== `## ${h}`).join("\n");
    const r = validateDesignHeaders(missing);
    assert.equal(r.ok, false, `${h} 누락이 통과했다`);
    assert.deepEqual(r.errors.map((e) => e.where), [h]);
  }
  assert.equal(validateDesignHeaders(GOOD_DESIGN).ok, true);
});
