/**
 * [V3 M8 T3/T5] 핵심 화면 설계 → 토큰 기반 구현 handoff 계약 (offline · fail-closed).
 *
 * 구현 세션이 받는 입력의 **닫힌 형태**를 여기서 만든다. 세 가지를 통과하지 못하면 handoff가 없다:
 *  1. **산출물 계약**(`designContract.ts`) — DESIGN.md 헤더 · 3계층 tokens · inventory · 접근성 선언.
 *  2. **범위**(scope) — handoff에 실리는 화면·컴포넌트는 설계(UX flow · inventory)에 **있는 것만**이다.
 *     설계에 없는 것이 구현 지시로 새는 통로를 닫는다.
 *  3. **사람 승인** — 승인 레코드의 tokens digest가 현재 tokens와 **일치**해야 한다. 승인 후 토큰이
 *     바뀌면 그 승인은 다른 물건에 대한 것이므로 거부한다(승인 재사용 금지).
 *
 * 여기서 kernel 상태를 바꾸지 않는다 — kernel의 사람 gate(M7 `decision_pending`)와 별개의 층이며,
 * 그것을 대체하지 않는다. 이 모듈은 **입력 계약 검증기**다.
 */
import { createHash } from "node:crypto";
import { parseInventory, validateDesignArtifacts, } from "../core/designContract.js";
import { linkInventory } from "../tools/registryInventory.js";
export class DesignHandoffError extends Error {
    code;
    errors;
    constructor(code, message, errors = []) {
        super(message);
        this.name = "DesignHandoffError";
        this.code = code;
        this.errors = errors;
    }
}
/** UX flow 문서에서 선언된 화면(`- <id>: <name>` bullet). 설계의 화면 집합 = 범위 상한. */
const SCREEN_LINE_RE = /^[-*]\s+([a-z][a-z0-9-]{0,49})\s*:\s*(.+)$/;
/** `## 화면 목록` 섹션에서 화면 id를 파싱한다. 섹션이 없으면 빈 배열(→ 범위 검증에서 fail-closed). */
export function parseScreens(uxFlowMd) {
    const lines = uxFlowMd.split("\n");
    const idx = lines.findIndex((l) => /^##\s+화면 목록\s*$/.test(l));
    if (idx === -1)
        return [];
    const out = [];
    const seen = new Set();
    for (let i = idx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^##\s/.test(line))
            break;
        const m = line.match(SCREEN_LINE_RE);
        if (!m || seen.has(m[1]))
            continue;
        seen.add(m[1]);
        out.push({ id: m[1], name: m[2].trim() });
    }
    return out;
}
/** tokens 객체의 정규화 digest — 키 순서에 흔들리지 않게 정렬 직렬화한다. */
export function tokensDigest(tokens) {
    const norm = (v) => {
        if (Array.isArray(v))
            return v.map(norm);
        if (v && typeof v === "object") {
            return Object.fromEntries(Object.keys(v)
                .sort()
                .map((k) => [k, norm(v[k])]));
        }
        return v;
    };
    return createHash("sha256").update(JSON.stringify(norm(tokens)), "utf8").digest("hex");
}
/**
 * handoff 계약을 만든다. 계약·범위·승인 중 하나라도 위반이면 `DesignHandoffError`(생성물 없음).
 */
export function buildDesignHandoff(input) {
    // 1) 산출물 계약 (fail-closed).
    const contract = validateDesignArtifacts(input.designMd, input.tokens);
    if (!contract.ok) {
        throw new DesignHandoffError("design_contract_violation", `디자인 산출물 계약 위반 ${contract.errors.length}건`, contract.errors);
    }
    const inventory = parseInventory(input.designMd).components;
    // 2) 범위: handoff의 화면·컴포넌트는 설계에 있는 것만.
    const declaredScreens = new Set(parseScreens(input.uxFlowMd).map((s) => s.id));
    const inventoryNames = new Set(inventory.map((c) => c.name));
    const scopeErrors = [];
    const seenScreens = new Set();
    for (const s of input.screens) {
        if (seenScreens.has(s.id)) {
            scopeErrors.push({ code: "scope_screen_duplicate", where: s.id, message: "handoff에 같은 화면이 두 번 있다" });
            continue;
        }
        seenScreens.add(s.id);
        if (!declaredScreens.has(s.id)) {
            scopeErrors.push({ code: "scope_screen_undeclared", where: s.id, message: "UX flow에 선언되지 않은 화면이다" });
        }
        if (s.components.length === 0) {
            scopeErrors.push({ code: "scope_screen_empty", where: s.id, message: "화면에 컴포넌트가 없다" });
        }
        for (const c of s.components) {
            if (!inventoryNames.has(c)) {
                scopeErrors.push({ code: "scope_component_undeclared", where: `${s.id}/${c}`, message: "컴포넌트 인벤토리에 없다" });
            }
        }
    }
    if (input.screens.length === 0) {
        scopeErrors.push({ code: "scope_no_screen", where: "(screens)", message: "handoff에 화면이 하나도 없다" });
    }
    if (scopeErrors.length > 0) {
        throw new DesignHandoffError("scope_violation", `handoff 범위 위반 ${scopeErrors.length}건`, scopeErrors);
    }
    // 3) 사람 승인: 무엇을 승인했는지가 현재 물건과 같아야 한다.
    const digest = tokensDigest(input.tokens);
    const approval = input.approval;
    if (!approval || typeof approval.decisionId !== "string" || approval.decisionId.length === 0) {
        throw new DesignHandoffError("approval_missing", "사람 승인 레코드가 없다 — handoff를 만들지 않는다");
    }
    if (approval.tokensSha256 !== digest) {
        throw new DesignHandoffError("approval_stale", "승인 시점 tokens digest가 현재와 다르다 — 승인 재사용을 거부한다");
    }
    // 4) registry 연결(비공식 ref는 linkInventory가 던진다).
    const components = linkInventory(inventory, input.registryRefs ?? []);
    // handoff에 실제로 쓰이는 컴포넌트만 싣는다(설계에 있어도 화면에 안 쓰이면 구현 지시가 아니다).
    const used = new Set(input.screens.flatMap((s) => s.components));
    return {
        tokensSha256: digest,
        designSha256: createHash("sha256").update(input.designMd, "utf8").digest("hex"),
        approvalDecisionId: approval.decisionId,
        screens: input.screens.map((s) => ({ id: s.id, components: [...s.components] })),
        components: components.filter((c) => used.has(c.name)),
    };
}
