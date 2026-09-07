/**
 * [V3 M8 T1] 디자인 산출물 계약 — `DESIGN.md` · `tokens.json` · component inventory (offline · fail-closed).
 *
 * v1(`validate.ts`)의 필수 헤더 검증은 **경고 수준**이다(누락해도 저장 진행). M8 산출물은 구현 handoff의
 * 입력이 되므로 여기서 **fail-closed**로 올린다 — 위반이면 `DesignContractError` 목록을 반환하고,
 * 호출자(파이프라인·acceptance)는 통과 없이는 handoff를 만들지 않는다.
 *
 * 계약 정본은 `agents/design_agent.md` §3(필수 헤더)·§4(3계층 토큰 + `a11y`)다.
 *
 * **접근성 검증 범위(M8에서 정의 · 정직하게 좁게)**:
 *  - 검증한다: `a11y.contrastPairs`로 **선언된** 전경/배경 쌍의 WCAG 2.x 대비비(해석된 hex에서 계산) ·
 *    모든 `text-*` semantic 색이 최소 한 쌍에 포함되는지(선언 누락으로 검사를 비우는 것 방지) ·
 *    대화형 컴포넌트의 **focus 표시 토큰** 존재.
 *  - 검증하지 않는다(범위 밖 · 명시): 실제 렌더링 결과 · 이미지/그라디언트 위 텍스트 · 폰트 크기별
 *    large-text 예외 판정 · 스크린리더·키보드 실동작 · 시각 diff. 이것들은 렌더링이 필요하며
 *    M8에서 "통과"로 주장하지 않는다.
 */
/** 3계층 토큰 key. 최상위는 이 셋 + `a11y`가 **정확히** 있어야 한다. */
const LAYERS = ["primitive", "semantic", "component"];
/** 접근성 선언 블록 key. */
const A11Y_KEY = "a11y";
/** 대비비 최소값으로 허용되는 값 — WCAG AA 본문 4.5 · 큰 텍스트/비텍스트 3. 임의 값(1 등)은 거부. */
const ALLOWED_MIN_RATIOS = [3, 4.5];
/** focus 표시 토큰을 요구하는 대화형 컴포넌트(닫힌 목록). inventory 이름 기준. */
const INTERACTIVE_COMPONENTS = ["Button", "Input", "Select", "Checkbox", "Radio", "Switch", "Textarea", "Link", "Tab", "MenuItem"];
/** 참조 형식 `{primitive.color.blue-500}`. */
const REF_RE = /^\{([a-z]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\}$/;
/** 각 계층이 참조해도 되는 상위 계층(primitive는 참조 금지 = raw 값만). */
const ALLOWED_REF_LAYER = {
    primitive: null,
    semantic: "primitive",
    component: "semantic",
};
/** DESIGN.md 필수 `## ` 헤더 — agents/design_agent.md §3 원문 순서. */
export const DESIGN_REQUIRED_HEADERS = [
    "디자인 방향",
    "디자인 토큰 개요",
    "컴포넌트 인벤토리",
    "레이아웃 규칙",
    "인터랙션 원칙",
    "접근성 기준",
    "비시각 가이드",
    "시안 검증 절차",
    "디자인 토큰",
];
function err(errors, code, where, message) {
    errors.push({ code, where, message });
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
// ── tokens.json ────────────────────────────────────────────────
/**
 * tokens.json의 **닫힌 형태**를 검증한다.
 *  - 최상위 key는 정확히 primitive/semantic/component (추가 key·누락 모두 위반)
 *  - 각 계층은 `{ group: { name: value } }` 2단 객체, value는 문자열
 *  - primitive는 raw 값만(참조 금지) · semantic은 `{primitive.*}`만 · component는 `{semantic.*}`만
 *  - 모든 참조는 실제로 **해석돼야** 한다(dangling 참조는 위반)
 *  - 빈 계층·빈 group은 위반(형식만 갖춘 공허한 통과 방지)
 */
export function validateTokens(raw) {
    const errors = [];
    if (!isPlainObject(raw)) {
        return { ok: false, errors: [{ code: "tokens_not_object", where: "(root)", message: "tokens.json이 객체가 아니다" }] };
    }
    const keys = Object.keys(raw).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...LAYERS, A11Y_KEY].sort())) {
        err(errors, "tokens_layers", "(root)", `최상위 key는 정확히 ${[...LAYERS, A11Y_KEY].join("/")} 여야 한다`);
        return { ok: false, errors }; // 계층 자체가 틀리면 이하 검증은 의미 없다
    }
    // 계층별 평탄화: "primitive.color.blue-500" → 값
    const flat = new Map();
    for (const layer of LAYERS) {
        const groups = raw[layer];
        if (!isPlainObject(groups) || Object.keys(groups).length === 0) {
            err(errors, "tokens_layer_shape", layer, "계층이 비어있지 않은 객체가 아니다");
            continue;
        }
        for (const [group, entries] of Object.entries(groups)) {
            if (!isPlainObject(entries) || Object.keys(entries).length === 0) {
                err(errors, "tokens_group_shape", `${layer}.${group}`, "group이 비어있지 않은 객체가 아니다");
                continue;
            }
            for (const [name, value] of Object.entries(entries)) {
                const path = `${layer}.${group}.${name}`;
                if (typeof value !== "string" || value.trim().length === 0) {
                    err(errors, "tokens_value_type", path, "토큰 값이 비어있지 않은 문자열이 아니다");
                    continue;
                }
                flat.set(path, value);
            }
        }
    }
    // 참조 계층 규칙 + 해석 가능성.
    for (const [path, value] of flat) {
        const layer = path.split(".")[0];
        const isRef = value.startsWith("{");
        const allowed = ALLOWED_REF_LAYER[layer];
        if (!isRef) {
            // primitive만 raw 허용. semantic/component의 raw 값은 계층 건너뛰기다.
            if (allowed !== null)
                err(errors, "tokens_raw_value", path, `${layer}는 ${allowed} 참조만 허용한다(raw 값 금지)`);
            continue;
        }
        if (allowed === null) {
            err(errors, "tokens_primitive_ref", path, "primitive는 raw 값만 허용한다(참조 금지)");
            continue;
        }
        const m = value.match(REF_RE);
        if (!m) {
            err(errors, "tokens_ref_format", path, "참조 형식이 {layer.group.name} 아니다");
            continue;
        }
        if (m[1] !== allowed) {
            err(errors, "tokens_ref_layer", path, `${layer}는 ${allowed} 계층만 참조할 수 있다`);
            continue;
        }
        if (!flat.has(`${m[1]}.${m[2]}.${m[3]}`)) {
            err(errors, "tokens_ref_dangling", path, "참조 대상 토큰이 존재하지 않는다");
        }
    }
    return { ok: errors.length === 0, errors };
}
/** 참조를 primitive raw 값까지 해석한다. 해석 불가면 null. (접근성 체크·handoff에서 사용) */
export function resolveToken(tokens, path) {
    let cur = path;
    for (let hop = 0; hop < 3; hop++) {
        const parts = cur.split(".");
        if (parts.length !== 3 || !isPlainObject(tokens))
            return null;
        const layer = tokens[parts[0]];
        if (!isPlainObject(layer))
            return null;
        const group = layer[parts[1]];
        if (!isPlainObject(group))
            return null;
        const value = group[parts[2]];
        if (typeof value !== "string")
            return null;
        if (!value.startsWith("{"))
            return value;
        const m = value.match(REF_RE);
        if (!m)
            return null;
        cur = `${m[1]}.${m[2]}.${m[3]}`;
    }
    return null; // 3홉(component→semantic→primitive)을 넘으면 순환/과다 참조
}
/** `## 컴포넌트 인벤토리` 섹션의 bullet 형식: `- <Name>: <variant>, <variant>` */
const INVENTORY_LINE_RE = /^[-*]\s+([A-Z][A-Za-z0-9]*)\s*:\s*(.+)$/;
/**
 * DESIGN.md의 `## 컴포넌트 인벤토리` 섹션을 파싱·검증한다.
 * 섹션 부재·bullet 0개·형식 위반·중복 이름·빈 variant는 fail-closed.
 */
export function parseInventory(designMd) {
    const errors = [];
    const lines = designMd.split("\n");
    const idx = lines.findIndex((l) => /^##\s+컴포넌트 인벤토리\s*$/.test(l));
    if (idx === -1) {
        return { result: { ok: false, errors: [{ code: "inventory_missing", where: "컴포넌트 인벤토리", message: "섹션이 없다" }] }, components: [] };
    }
    const components = [];
    const seen = new Set();
    for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^##\s/.test(line))
            break;
        if (line.length === 0)
            continue;
        if (!/^[-*]\s/.test(line))
            continue; // 산문 설명은 허용(계약은 bullet에만 걸린다)
        const m = line.match(INVENTORY_LINE_RE);
        if (!m) {
            err(errors, "inventory_line_format", line.slice(0, 40), "bullet 형식이 `- <Name>: <variant>, …` 아니다");
            continue;
        }
        const name = m[1];
        const variants = m[2].split(",").map((v) => v.trim()).filter((v) => v.length > 0);
        if (variants.length === 0) {
            err(errors, "inventory_no_variant", name, "variant가 최소 1개 필요하다");
            continue;
        }
        if (seen.has(name)) {
            err(errors, "inventory_duplicate", name, "컴포넌트 이름이 중복이다");
            continue;
        }
        seen.add(name);
        components.push({ name, variants });
    }
    if (components.length === 0)
        err(errors, "inventory_empty", "컴포넌트 인벤토리", "유효한 컴포넌트 bullet이 0개다");
    return { result: { ok: errors.length === 0, errors }, components };
}
// ── DESIGN.md ──────────────────────────────────────────────────
/** DESIGN.md 필수 헤더 fail-closed 검증(v1 경고 검증과 별개 — 여기서는 누락이 곧 실패다). */
export function validateDesignHeaders(designMd) {
    const errors = [];
    for (const h of DESIGN_REQUIRED_HEADERS) {
        if (!new RegExp(`^##\\s+${h}\\s*$`, "m").test(designMd)) {
            err(errors, "design_header_missing", h, "필수 `## ` 헤더가 없다");
        }
    }
    return { ok: errors.length === 0, errors };
}
// ── 접근성 (tokens 수준에서만 · 범위는 파일 헤더에 명시) ─────────
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** #rgb/#rrggbb → 0~255 3채널. 형식 위반은 null. */
function parseHex(v) {
    if (!HEX_RE.test(v))
        return null;
    const h = v.slice(1);
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
/** WCAG 2.x 상대 휘도. */
function luminance(rgb) {
    const [r, g, b] = rgb.map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 2.x 대비비 (1~21). */
export function contrastRatio(fgHex, bgHex) {
    const fg = parseHex(fgHex);
    const bg = parseHex(bgHex);
    if (!fg || !bg)
        return null;
    const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
}
const PAIR_KEYS = ["fg", "bg", "min"];
/**
 * `a11y.contrastPairs` 선언을 검증한다.
 *  - 형식: `{fg, bg, min}` 정확히 3 key · fg/bg는 semantic/component의 해석 가능한 색 토큰 경로 ·
 *    min은 3 또는 4.5
 *  - 계산: 해석된 hex로 WCAG 대비비를 계산해 `min` 미만이면 위반(선언만 하고 미달인 것을 통과시키지 않는다)
 *  - 공허함 방지: 모든 `semantic.color.text-*` 토큰이 최소 한 쌍의 `fg`로 등장해야 한다
 */
export function validateA11y(tokens) {
    const errors = [];
    if (!isPlainObject(tokens) || !isPlainObject(tokens[A11Y_KEY])) {
        return { ok: false, errors: [{ code: "a11y_missing", where: A11Y_KEY, message: "a11y 블록이 없다" }] };
    }
    const a11y = tokens[A11Y_KEY];
    if (JSON.stringify(Object.keys(a11y)) !== JSON.stringify(["contrastPairs"])) {
        err(errors, "a11y_keys", A11Y_KEY, "a11y의 key는 정확히 contrastPairs 하나다");
        return { ok: false, errors };
    }
    const pairs = a11y.contrastPairs;
    if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > 50) {
        err(errors, "a11y_pairs_shape", "a11y.contrastPairs", "1~50개 배열이 아니다");
        return { ok: false, errors };
    }
    const declaredFg = new Set();
    pairs.forEach((p, i) => {
        const where = `a11y.contrastPairs[${i}]`;
        if (!isPlainObject(p) || JSON.stringify(Object.keys(p).sort()) !== JSON.stringify([...PAIR_KEYS].sort())) {
            err(errors, "a11y_pair_keys", where, "key는 정확히 fg/bg/min 이다");
            return;
        }
        const { fg, bg, min } = p;
        if (typeof min !== "number" || !ALLOWED_MIN_RATIOS.includes(min)) {
            err(errors, "a11y_min_ratio", where, `min은 ${ALLOWED_MIN_RATIOS.join(" 또는 ")} 여야 한다`);
            return;
        }
        for (const [label, path] of [["fg", fg], ["bg", bg]]) {
            if (typeof path !== "string" || !/^(semantic|component)\./.test(path)) {
                err(errors, "a11y_pair_path", `${where}.${label}`, "semantic/component 색 토큰 경로가 아니다");
                return;
            }
        }
        const fgHex = resolveToken(tokens, fg);
        const bgHex = resolveToken(tokens, bg);
        if (fgHex === null || bgHex === null) {
            err(errors, "a11y_pair_unresolved", where, "토큰 경로가 primitive 값까지 해석되지 않는다");
            return;
        }
        const ratio = contrastRatio(fgHex, bgHex);
        if (ratio === null) {
            err(errors, "a11y_pair_not_color", where, "해석된 값이 #rgb/#rrggbb 색이 아니다");
            return;
        }
        declaredFg.add(fg);
        if (ratio + 1e-9 < min) {
            err(errors, "a11y_contrast_below_min", where, `대비비 ${ratio.toFixed(2)} < ${min}`);
        }
    });
    // 공허함 방지: text-* semantic 색은 전부 선언 대상이어야 한다.
    //
    // [C-157] **semantic의 모든 하위 group을 훑는다.** 예전엔 `semantic.color` 하나만 봤는데, 같은
    // 프롬프트(`agents/design_agent.md:77`)가 다크 모드를 **`semantic.light`/`semantic.dark`로 분기**하라고
    // 지시한다. 그 지시를 따르면 `semantic.color`가 없어 이 루프가 **0회 돌고**, AA 미달 텍스트 토큰이
    // `ok:true`로 통과했다(실측: 동일 토큰이 `semantic.color`면 걸리고 `semantic.light`면 0건 · 대비 2.9).
    // **계약이 지시하는 모양이 검사를 무력화하고 있었다** — group 이름을 고정하는 대신 전부 훑는다.
    const semantic = isPlainObject(tokens.semantic) ? tokens.semantic : {};
    for (const [group, members] of Object.entries(semantic)) {
        if (!isPlainObject(members))
            continue;
        for (const name of Object.keys(members)) {
            if (!name.startsWith("text-"))
                continue;
            const path = `semantic.${group}.${name}`;
            if (!declaredFg.has(path)) {
                err(errors, "a11y_text_uncovered", path, "text-* 토큰이 contrastPairs의 fg로 선언되지 않았다");
            }
        }
    }
    return { ok: errors.length === 0, errors };
}
/**
 * 대화형 컴포넌트는 **focus 표시 토큰**을 가져야 한다(키보드 사용자에게 보이는 초점).
 * 판정 근거는 렌더링이 아니라 토큰 존재이며, 그 한계를 그대로 인정한다 — 토큰이 있어도 실제로
 * 보이는지는 이 계층에서 증명되지 않는다.
 */
export function validateFocusTokens(components, tokens) {
    const errors = [];
    const groups = isPlainObject(tokens) && isPlainObject(tokens.component) ? tokens.component : {};
    for (const c of components) {
        if (!INTERACTIVE_COMPONENTS.includes(c.name))
            continue;
        const key = c.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        const g = groups[key];
        if (!isPlainObject(g)) {
            err(errors, "focus_group_missing", `component.${key}`, "대화형 컴포넌트의 토큰 group이 없다");
            continue;
        }
        if (!Object.keys(g).some((n) => /focus/i.test(n))) {
            err(errors, "focus_token_missing", `component.${key}`, "focus 표시 토큰이 없다");
        }
    }
    return { ok: errors.length === 0, errors };
}
/**
 * DESIGN.md + tokens.json 전체 계약. 세 검증(헤더·인벤토리·토큰)의 오류를 합쳐 fail-closed로 반환한다.
 * tokens는 **이미 추출된 객체**를 받는다(추출은 `validate.ts:extractTokensJson`가 단일 출처).
 */
export function validateDesignArtifacts(designMd, tokens) {
    const inv = parseInventory(designMd);
    const errors = [
        ...validateDesignHeaders(designMd).errors,
        ...inv.result.errors,
        ...validateTokens(tokens).errors,
        ...validateA11y(tokens).errors,
        ...validateFocusTokens(inv.components, tokens).errors,
    ];
    return { ok: errors.length === 0, errors };
}
