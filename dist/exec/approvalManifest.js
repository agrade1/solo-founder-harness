/**
 * V3 M4c — milestone approval manifest(로드맵 §8)와 7 specialist registry(§6).
 *
 * `schemas/milestone_approval_manifest.schema.json`은 **계약 문서**이고 실제 보안 경계는 이 파일이다
 * (신규 검증 의존성 0 — 기존 `agentMessage.ts`/`liveEvidence.ts`와 같은 수동 closed validator 방식).
 * 두 정의의 동치는 `orchestrationKernel.test.ts`가 강제한다.
 *
 * 이 모듈은 **아무것도 실행하지 않는다.** shell 파싱·패키지 설치·네트워크 접근·git merge·provider
 * 호출은 없다. 여기 있는 것은 ⓐ manifest의 closed 검증 ⓑ role registry ⓒ M5 executor가 쓸
 * **순수 조회(allow/deny) 술어 3개**뿐이다. 조회는 전부 deny-by-default이며 manifest 밖은 거부한다.
 * repo의 hard deny(production deploy · live billing · 원격 쓰기 · PR merge · MCP `@latest`)는
 * manifest가 무엇을 담든 **항상 더 강하다**.
 */
import { LIMITS, OrchestrationError, SLUG_PATTERN, assertSlug, assertTimestamp, isSlug, normalizeWorkspacePath, } from "./orchestrationTypes.js";
/**
 * 로드맵 §6의 기본 상위 specialist 7종 — **이 레포의 유일한 정본 registry**다.
 * 중앙이 들고 있는 서술 metadata이며 agent가 스스로 role·scope·권한·도구를 만드는 통로가 아니다.
 * run마다 7개 task를 요구하지 않는다(선언일 뿐 인스턴스가 아니다). 실제 프로세스도 띄우지 않는다.
 * 모델·provider 라우팅은 여기서 다루지 않는다(기존 `modelPolicy.ts` 계약 — 중복 정의 금지).
 */
export const SPECIALIST_ROLES = [
    { roleId: "research", title: "Research & Venture Strategy" },
    { roleId: "pm", title: "Product / PM" },
    { roleId: "ux", title: "UX Architecture" },
    { roleId: "design", title: "Visual Design & Design System" },
    { roleId: "tech-lead", title: "Tech Lead / Architecture" },
    { roleId: "dev-lead", title: "Development Lead" },
    { roleId: "qa-security", title: "QA / Security / Red Team" },
];
const TOP_LEVEL_ROLE_IDS = SPECIALIST_ROLES.map((r) => r.roleId);
/** 하위 specialist 접미사: 점 없이 1..32자 slug. `<top>.<child>` **한 겹만** 허용한다. */
const CHILD_ROLE_SUFFIX_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/**
 * roleId가 registry에 속하는가. 상위 7종 그 자체이거나 `<상위>.<하위>` 형태(한 겹)만 true다.
 * 상위 부분이 registry 밖이면 false — spawn된 child도 부모 계열 밖의 role을 자칭할 수 없다.
 */
export function isRegistryRoleId(roleId) {
    if (!isSlug(roleId))
        return false;
    if (TOP_LEVEL_ROLE_IDS.includes(roleId))
        return true;
    const dot = roleId.indexOf(".");
    if (dot <= 0)
        return false;
    const top = roleId.slice(0, dot);
    const child = roleId.slice(dot + 1);
    return TOP_LEVEL_ROLE_IDS.includes(top) && CHILD_ROLE_SUFFIX_RE.test(child);
}
export function assertRegistryRoleId(v, what) {
    if (!isRegistryRoleId(v)) {
        throw new OrchestrationError("unknown_role", `${what}는 7 specialist registry의 role이거나 그 하위 role(<상위>.<하위>)이어야 한다: ${String(v)}`);
    }
    return v;
}
// ── manifest 검증 (closed) ──────────────────────────────────────────────────
export const MANIFEST_KEYS = [
    "milestoneId",
    "approvedCommit",
    "writableRoots",
    "ownershipByTask",
    "allowedCommands",
    "allowedDependencies",
    "allowedNetworkDomains",
    "maxSessions",
    "maxTokens",
    "maxElapsedMs",
    "localMergeAllowed",
    "expiresAt",
];
export const DEPENDENCY_KEYS = ["name", "version"];
/** 구체적인 approved commit — 40자 소문자 hex만. 짧은 해시·브랜치·tag는 거부한다. */
export const COMMIT_PATTERN = "^[0-9a-f]{40}$";
const COMMIT_RE = new RegExp(COMMIT_PATTERN);
/** allowedCommands 1건: 앞뒤 공백·연속 공백 없이 bounded ASCII. */
export const COMMAND_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 ._:@/+-]{0,79}$";
const COMMAND_RE = new RegExp(COMMAND_PATTERN);
/** npm package 이름(scope 허용). */
export const DEPENDENCY_NAME_PATTERN = "^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$";
const DEPENDENCY_NAME_RE = new RegExp(DEPENDENCY_NAME_PATTERN);
/**
 * **정확히 pin된** 버전만. `latest`·`^1.2.3`·`~1.2`·`1.x`·`1.2`·`>=1`·dist-tag는 전부 거부한다
 * (repo hard deny: MCP 패키지 `@latest` 금지 — 같은 규칙을 dependency 승인 전반에 적용한다).
 */
export const DEPENDENCY_VERSION_PATTERN = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$";
const DEPENDENCY_VERSION_RE = new RegExp(DEPENDENCY_VERSION_PATTERN);
/** 소문자 도메인만. scheme·port·path·wildcard·trailing dot는 거부한다. */
export const DOMAIN_PATTERN = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$";
const DOMAIN_RE = new RegExp(DOMAIN_PATTERN);
function asObject(v, what) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
        throw new OrchestrationError("invalid_manifest", `${what}는 객체여야 한다`);
    }
    return v;
}
function closedKeys(o, allowed, what) {
    for (const k of Object.keys(o)) {
        if (!allowed.includes(k))
            throw new OrchestrationError("invalid_manifest", `${what}에 허용되지 않은 필드: ${k}`);
    }
    for (const k of allowed) {
        if (!(k in o))
            throw new OrchestrationError("invalid_manifest", `${what}에 필수 필드 없음: ${k}`);
    }
}
function boundedInt(v, what, min, max) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
        throw new OrchestrationError("invalid_manifest", `${what}는 ${min}..${max} 정수여야 한다`);
    }
    return v;
}
function normalizedList(raw, what, max, normalize, minItems = 0) {
    if (!Array.isArray(raw))
        throw new OrchestrationError("invalid_manifest", `${what}는 배열이어야 한다`);
    if (raw.length < minItems)
        throw new OrchestrationError("invalid_manifest", `${what}는 최소 ${minItems}개가 필요하다`);
    if (raw.length > max)
        throw new OrchestrationError("invalid_manifest", `${what}는 ${max}개 이하여야 한다`);
    const seen = new Set();
    for (const item of raw) {
        const n = normalize(item, `${what} 항목`);
        if (seen.has(n))
            throw new OrchestrationError("invalid_manifest", `${what}에 중복이 있다: ${n}`);
        seen.add(n);
    }
    // 사전순 고정 — 같은 승인이 두 가지 바이트로 저장되지 않게 한다(digest 결정성).
    return [...seen].sort();
}
function normalizeCommand(v, what) {
    if (typeof v !== "string" || !COMMAND_RE.test(v) || v.includes("  ") || v.endsWith(" ")) {
        throw new OrchestrationError("invalid_manifest", `${what}는 정규화된 명령 문자열이어야 한다(${COMMAND_PATTERN})`);
    }
    return v;
}
function normalizeDomain(v, what) {
    if (typeof v !== "string" || v.length > LIMITS.maxDomainLength || !DOMAIN_RE.test(v)) {
        throw new OrchestrationError("invalid_manifest", `${what}는 소문자 도메인이어야 한다(scheme·port·path·wildcard 금지)`);
    }
    return v;
}
/** `child`가 `root` 자신이거나 그 하위인가. 두 경로 모두 정규화된 workspace-relative 경로여야 한다. */
export function pathWithin(child, root) {
    return child === root || child.startsWith(`${root}/`);
}
function validateDependency(raw) {
    const o = asObject(raw, "allowedDependencies 항목");
    closedKeys(o, DEPENDENCY_KEYS, "allowedDependencies 항목");
    if (typeof o.name !== "string" || o.name.length > LIMITS.maxIdLength || !DEPENDENCY_NAME_RE.test(o.name)) {
        throw new OrchestrationError("invalid_manifest", `allowedDependencies[].name이 package 이름이 아니다: ${String(o.name)}`);
    }
    if (typeof o.version !== "string" || !DEPENDENCY_VERSION_RE.test(o.version)) {
        throw new OrchestrationError("dependency_not_pinned", `allowedDependencies[].version은 정확히 pin된 버전이어야 한다(latest·범위·tag 금지): ${String(o.version)}`);
    }
    return { name: o.name, version: o.version };
}
/**
 * manifest 전체 검증. 통과하면 **정규화된 사본**을 돌려준다(입력 객체는 건드리지 않는다).
 * run과의 대조(milestone 일치·만료)는 kernel이 한다 — 이 함수는 순수하고 파일을 만들지 않는다.
 */
export function validateApprovalManifest(raw) {
    const o = asObject(raw, "manifest");
    closedKeys(o, MANIFEST_KEYS, "manifest");
    if (typeof o.approvedCommit !== "string" || !COMMIT_RE.test(o.approvedCommit)) {
        throw new OrchestrationError("invalid_manifest", "manifest.approvedCommit은 40자 소문자 hex commit이어야 한다");
    }
    const writableRoots = normalizedList(o.writableRoots, "manifest.writableRoots", LIMITS.maxWritableRoots, (v, w) => normalizeWorkspacePath(v, w), 1);
    const ownershipRaw = asObject(o.ownershipByTask, "manifest.ownershipByTask");
    const taskIds = Object.keys(ownershipRaw);
    if (taskIds.length > LIMITS.maxTasksPerRun) {
        throw new OrchestrationError("invalid_manifest", `manifest.ownershipByTask는 ${LIMITS.maxTasksPerRun}개 이하여야 한다`);
    }
    const ownershipByTask = {};
    for (const taskId of taskIds.sort()) {
        assertSlug(taskId, "manifest.ownershipByTask key");
        const paths = normalizedList(ownershipRaw[taskId], `manifest.ownershipByTask[${taskId}]`, LIMITS.maxOwnershipPaths, (v, w) => normalizeWorkspacePath(v, w), 1);
        for (const p of paths) {
            if (!writableRoots.some((root) => pathWithin(p, root))) {
                throw new OrchestrationError("ownership_outside_writable_root", `manifest.ownershipByTask[${taskId}]의 ${p}가 승인된 writableRoots 밖이다`);
            }
        }
        ownershipByTask[taskId] = paths;
    }
    if (!Array.isArray(o.allowedDependencies)) {
        throw new OrchestrationError("invalid_manifest", "manifest.allowedDependencies는 배열이어야 한다");
    }
    if (o.allowedDependencies.length > LIMITS.maxAllowedDependencies) {
        throw new OrchestrationError("invalid_manifest", `manifest.allowedDependencies는 ${LIMITS.maxAllowedDependencies}개 이하여야 한다`);
    }
    const allowedDependencies = [];
    for (const d of o.allowedDependencies) {
        const dep = validateDependency(d);
        // 같은 이름이 두 버전으로 승인되면 "정확히 pin"이 무의미해진다.
        if (allowedDependencies.some((x) => x.name === dep.name)) {
            throw new OrchestrationError("invalid_manifest", `manifest.allowedDependencies에 중복 package가 있다: ${dep.name}`);
        }
        allowedDependencies.push(dep);
    }
    allowedDependencies.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (typeof o.localMergeAllowed !== "boolean") {
        throw new OrchestrationError("invalid_manifest", "manifest.localMergeAllowed는 boolean이어야 한다");
    }
    return {
        milestoneId: assertSlug(o.milestoneId, "manifest.milestoneId"),
        approvedCommit: o.approvedCommit,
        writableRoots,
        ownershipByTask,
        allowedCommands: normalizedList(o.allowedCommands, "manifest.allowedCommands", LIMITS.maxAllowedCommands, normalizeCommand),
        allowedDependencies,
        allowedNetworkDomains: normalizedList(o.allowedNetworkDomains, "manifest.allowedNetworkDomains", LIMITS.maxAllowedNetworkDomains, normalizeDomain),
        maxSessions: boundedInt(o.maxSessions, "manifest.maxSessions", 1, LIMITS.maxManifestSessions),
        maxTokens: o.maxTokens === null ? null : boundedInt(o.maxTokens, "manifest.maxTokens", 1, LIMITS.maxManifestTokens),
        maxElapsedMs: boundedInt(o.maxElapsedMs, "manifest.maxElapsedMs", 1, LIMITS.maxManifestElapsedMs),
        localMergeAllowed: o.localMergeAllowed,
        expiresAt: assertTimestamp(o.expiresAt, "manifest.expiresAt"),
    };
}
// ── M5 executor용 순수 조회 API (deny-by-default, 실행 없음) ─────────────────
/**
 * **정확히 이 명령**이 승인됐는가. shell을 파싱하지 않고 문자열 동치만 본다 —
 * 파싱을 넣으면 "승인된 명령처럼 보이는 것"을 판정하게 되고 그건 이 계층의 권한이 아니다.
 * 정규화 규칙 밖의 입력(공백 패딩·제어문자 등)은 그냥 거부한다.
 */
export function commandAllowed(manifest, command) {
    if (typeof command !== "string" || !COMMAND_RE.test(command) || command.includes("  ") || command.endsWith(" ")) {
        return false;
    }
    return manifest.allowedCommands.includes(command);
}
/** **정확히 이 이름 + 이 pin된 버전**이 승인됐는가. 범위·`latest`·tag는 언제나 false다. */
export function dependencyAllowed(manifest, name, version) {
    if (typeof name !== "string" || typeof version !== "string")
        return false;
    if (!DEPENDENCY_NAME_RE.test(name) || !DEPENDENCY_VERSION_RE.test(version))
        return false;
    return manifest.allowedDependencies.some((d) => d.name === name && d.version === version);
}
/** **정확히 이 도메인**이 승인됐는가. 하위 도메인은 자동 허용하지 않는다(별도 승인 필요). */
export function networkDomainAllowed(manifest, domain) {
    if (typeof domain !== "string" || domain.length > LIMITS.maxDomainLength || !DOMAIN_RE.test(domain))
        return false;
    return manifest.allowedNetworkDomains.includes(domain);
}
/** slug 규칙을 registry 문서에서도 쓰기 위해 재수출한다(중복 정의 금지). */
export { SLUG_PATTERN };
