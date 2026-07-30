/**
 * V3 M4c — milestone approval manifest(로드맵 §8)와 7 specialist registry(§6).
 *
 * `schemas/milestone_approval_manifest.schema.json`은 **계약 문서**이고 실제 보안 경계는 이 파일이다
 * (신규 검증 의존성 0 — 기존 `agentMessage.ts`/`liveEvidence.ts`와 같은 수동 closed validator 방식).
 * 두 정의의 동치는 `orchestrationKernel.test.ts`가 강제한다.
 *
 * 이 모듈은 **아무것도 실행하지 않는다.** shell 파싱·패키지 설치·네트워크 접근·git merge·provider
 * 호출은 없다. 여기 있는 것은 ⓐ manifest의 closed 검증 ⓑ role registry ⓒ M5 executor가 쓸
 * **순수 조회(allow/deny) 술어 3개**뿐이다.
 *
 * **M5b 6차 리뷰 A1 — `executionAuthority`가 실행 권위의 trust root다.** manifest는 승인된 codex·git
 * 실행 파일의 **정규 절대경로 + 내용 SHA-256**을 담고, provider·controller·실행 경계는 그것만 쓴다
 * (호출자가 경로를 고르는 옵션은 없다). 여기서는 **형태만** 검증하고 파일 시스템은 만지지 않는다 —
 * 내용·신원 검증은 spawn 직전 `executionBoundary.verifyApprovedExecutable`이 한다. 조회는 전부 deny-by-default이며 manifest 밖은 거부한다.
 * repo의 hard deny(production deploy · live billing · 원격 쓰기 · PR merge · MCP `@latest`)는
 * manifest가 무엇을 담든 **항상 더 강하다**.
 */
import {
  LIMITS,
  type ApprovedDependency,
  type ApprovedExecutable,
  type ApprovedOperation,
  type AutopilotPolicy,
  type MilestoneApprovalManifest,
  OrchestrationError,
  SHA256_PATTERN,
  SLUG_PATTERN,
  assertSlug,
  assertTimestamp,
  codePointLength,
  hasLoneSurrogate,
  isSlug,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";

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
] as const;

export type SpecialistRoleId = (typeof SPECIALIST_ROLES)[number]["roleId"];

const TOP_LEVEL_ROLE_IDS: readonly string[] = SPECIALIST_ROLES.map((r) => r.roleId);

/** 하위 specialist 접미사: 점 없이 1..32자 slug. `<top>.<child>` **한 겹만** 허용한다. */
const CHILD_ROLE_SUFFIX_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * roleId가 registry에 속하는가. 상위 7종 그 자체이거나 `<상위>.<하위>` 형태(한 겹)만 true다.
 * 상위 부분이 registry 밖이면 false — spawn된 child도 부모 계열 밖의 role을 자칭할 수 없다.
 */
export function isRegistryRoleId(roleId: unknown): roleId is string {
  if (!isSlug(roleId)) return false;
  if (TOP_LEVEL_ROLE_IDS.includes(roleId)) return true;
  const dot = roleId.indexOf(".");
  if (dot <= 0) return false;
  const top = roleId.slice(0, dot);
  const child = roleId.slice(dot + 1);
  return TOP_LEVEL_ROLE_IDS.includes(top) && CHILD_ROLE_SUFFIX_RE.test(child);
}

export function assertRegistryRoleId(v: unknown, what: string): string {
  if (!isRegistryRoleId(v)) {
    throw new OrchestrationError(
      "unknown_role",
      `${what}는 7 specialist registry의 role이거나 그 하위 role(<상위>.<하위>)이어야 한다: ${String(v)}`,
    );
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
  "executionAuthority",
  // ── M5c (v2) ──
  "autopilotPolicy",
  "operationAuthorityByTask",
  "maxSessions",
  "maxTokens",
  "maxElapsedMs",
  "localMergeAllowed",
  "expiresAt",
] as const;

export const DEPENDENCY_KEYS = ["name", "version"] as const;

/**
 * 승인된 실행 권위 key. M5c(v2)에서 `node`·`processObserver`가 필수로 더해졌고 `codex`는 null 허용이다.
 * 더 넣거나 빼면 `invalid_manifest`이고, v1(`codex`+`git`만)은 `manifest_pre_m5c_unsupported`다.
 */
export const EXECUTION_AUTHORITY_KEYS = ["codex", "git", "node", "processObserver"] as const;
export const APPROVED_EXECUTABLE_KEYS = ["path", "sha256"] as const;

/** M5c autopilot 정책 key(전부 필수 — 조용한 기본값이 없다). */
export const AUTOPILOT_POLICY_KEYS = [
  "maxTaskAttempts",
  "maxDeliveryAttempts",
  "retryBackoffMs",
  "deliveryDeadlineMs",
  "maxNoProgressMs",
  "maxAttemptElapsedMs",
  "cleanupTermGraceMs",
  "cleanupKillGraceMs",
] as const;

/** typed operation 권위 항목의 key 집합(kind별로 닫혀 있다). */
export const WRITE_FILE_AUTHORITY_KEYS = ["authorityId", "kind", "path", "maxBytes"] as const;
export const RUN_PROCESS_AUTHORITY_KEYS = ["authorityId", "kind", "executable", "args", "timeoutMs"] as const;

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

/**
 * 승인된 실행 파일 경로의 **정규형**(V3 M5b 7차 독립 리뷰 C-40): NUL 없는 절대경로이며 segment가
 * 비어 있지도(`/a//b`) `.`(`/a/./b`)도 `..`(`/a/../b`)도 아니고 후행 `/`가 없다. 각 segment는
 * `/` 뒤에 비어 있지 않은 non-NUL 문자열이고, 앞의 negative lookahead가 `.`/`..` segment를 막는다.
 *
 * 이 **하나가** runtime validator와 `schemas/milestone_approval_manifest.schema.json`의 공통 정본이다 —
 * 이전에는 runtime이 명령형으로 거부하고 schema regex는 `/a//b`·`/a/./b`·`/a/../b`를 통과시켰다.
 * (길이 상한은 `LIMITS.maxPathLength`로 따로 본다.)
 */
export const APPROVED_PATH_PATTERN = "^(?:/(?!\\.\\.?(?:/|$))[^/\\0]+)+$";
const APPROVED_PATH_RE = new RegExp(APPROVED_PATH_PATTERN);

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new OrchestrationError("invalid_manifest", `${what}는 객체여야 한다`);
  }
  return v as Record<string, unknown>;
}

function closedKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new OrchestrationError("invalid_manifest", `${what}에 허용되지 않은 필드: ${k}`);
  }
  for (const k of allowed) {
    if (!(k in o)) throw new OrchestrationError("invalid_manifest", `${what}에 필수 필드 없음: ${k}`);
  }
}

function boundedInt(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new OrchestrationError("invalid_manifest", `${what}는 ${min}..${max} 정수여야 한다`);
  }
  return v;
}

function normalizedList(
  raw: unknown,
  what: string,
  max: number,
  normalize: (item: unknown, what: string) => string,
  minItems = 0,
): string[] {
  if (!Array.isArray(raw)) throw new OrchestrationError("invalid_manifest", `${what}는 배열이어야 한다`);
  if (raw.length < minItems) throw new OrchestrationError("invalid_manifest", `${what}는 최소 ${minItems}개가 필요하다`);
  if (raw.length > max) throw new OrchestrationError("invalid_manifest", `${what}는 ${max}개 이하여야 한다`);
  const seen = new Set<string>();
  for (const item of raw) {
    const n = normalize(item, `${what} 항목`);
    if (seen.has(n)) throw new OrchestrationError("invalid_manifest", `${what}에 중복이 있다: ${n}`);
    seen.add(n);
  }
  // 사전순 고정 — 같은 승인이 두 가지 바이트로 저장되지 않게 한다(digest 결정성).
  return [...seen].sort();
}

function normalizeCommand(v: unknown, what: string): string {
  if (typeof v !== "string" || !COMMAND_RE.test(v) || v.includes("  ") || v.endsWith(" ")) {
    throw new OrchestrationError("invalid_manifest", `${what}는 정규화된 명령 문자열이어야 한다(${COMMAND_PATTERN})`);
  }
  return v;
}

function normalizeDomain(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > LIMITS.maxDomainLength || !DOMAIN_RE.test(v)) {
    throw new OrchestrationError(
      "invalid_manifest",
      `${what}는 소문자 도메인이어야 한다(scheme·port·path·wildcard 금지)`,
    );
  }
  return v;
}

/** `child`가 `root` 자신이거나 그 하위인가. 두 경로 모두 정규화된 workspace-relative 경로여야 한다. */
export function pathWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(`${root}/`);
}

/**
 * 승인된 실행 파일 1건. **경로 계약과 digest 형태만** 본다 — 파일 시스템은 만지지 않는다
 * (내용·신원 검증은 실행 직전에 `executionBoundary.verifyApprovedExecutable`이 한다).
 * 경로는 NUL 없는 절대경로이고 `.`/`..` segment·중복 `/`·후행 `/`가 없어야 한다(정규형).
 * 정규형 판정은 **schema와 공유하는** `APPROVED_PATH_PATTERN` 하나로 한다(7차 리뷰 C-40).
 */
function validateApprovedExecutable(raw: unknown, what: string): ApprovedExecutable {
  const o = asObject(raw, what);
  closedKeys(o, APPROVED_EXECUTABLE_KEYS, what);
  const path = o.path;
  // 길이는 **코드 포인트**로 센다 — schema `maxLength`와 같은 의미여야 한다(대장 `C-40`).
  // 고립 surrogate는 파일 시스템 경계에서 U+FFFD로 바뀌므로 **승인된 실행 파일 경로의 신원이 깨진다**
  // (V3 M5c 3A 리비전 A4 — workspace 경로와 같은 규칙을 승인된 절대경로에도 적용한다).
  if (
    typeof path !== "string" ||
    codePointLength(path) > LIMITS.maxPathLength ||
    hasLoneSurrogate(path) ||
    !APPROVED_PATH_RE.test(path)
  ) {
    throw new OrchestrationError("invalid_manifest", `${what}.path는 정규 절대경로여야 한다`);
  }
  if (typeof o.sha256 !== "string" || !new RegExp(SHA256_PATTERN).test(o.sha256)) {
    throw new OrchestrationError("invalid_manifest", `${what}.sha256은 64자 소문자 hex digest여야 한다`);
  }
  return { path, sha256: o.sha256 };
}

/**
 * 승인된 실행 권위 전체. 누락·미상 key는 거부한다 — 조용한 기본값이 없다.
 * `codex`는 **null 허용**이다(M5c offline manifest는 live 추론을 승인하지 않는다). 나머지 셋은 필수다.
 */
function validateExecutionAuthority(raw: unknown): MilestoneApprovalManifest["executionAuthority"] {
  const o = asObject(raw, "manifest.executionAuthority");
  // v1 manifest(`codex`+`git`만)는 **마이그레이션하지 않고** 거부한다 — 기본값을 채우면 그것이 곧
  // "승인되지 않은 실행 파일을 승인된 것으로 취급"이다.
  if (!("node" in o) || !("processObserver" in o)) {
    throw new OrchestrationError(
      "manifest_pre_m5c_unsupported",
      "M5c 이전 승인 manifest다(executionAuthority.node/processObserver 없음). 마이그레이션하지 않으며 새 승인이 필요하다",
    );
  }
  closedKeys(o, EXECUTION_AUTHORITY_KEYS, "manifest.executionAuthority");
  return {
    codex: o.codex === null ? null : validateApprovedExecutable(o.codex, "manifest.executionAuthority.codex"),
    git: validateApprovedExecutable(o.git, "manifest.executionAuthority.git"),
    node: validateApprovedExecutable(o.node, "manifest.executionAuthority.node"),
    processObserver: validateApprovedExecutable(o.processObserver, "manifest.executionAuthority.processObserver"),
  };
}

/** M5c autopilot 정책. 전부 bounded 정수이고 `maxAttemptElapsedMs <= maxElapsedMs`를 함께 본다. */
function validateAutopilotPolicy(raw: unknown, maxElapsedMs: number): AutopilotPolicy {
  const o = asObject(raw, "manifest.autopilotPolicy");
  closedKeys(o, AUTOPILOT_POLICY_KEYS, "manifest.autopilotPolicy");
  const policy: AutopilotPolicy = {
    maxTaskAttempts: boundedInt(o.maxTaskAttempts, "autopilotPolicy.maxTaskAttempts", 1, LIMITS.maxTaskAttempts),
    maxDeliveryAttempts: boundedInt(o.maxDeliveryAttempts, "autopilotPolicy.maxDeliveryAttempts", 1, LIMITS.maxDeliveryAttempts),
    retryBackoffMs: boundedInt(o.retryBackoffMs, "autopilotPolicy.retryBackoffMs", 0, 60_000),
    deliveryDeadlineMs: boundedInt(o.deliveryDeadlineMs, "autopilotPolicy.deliveryDeadlineMs", 1_000, 3_600_000),
    maxNoProgressMs: boundedInt(o.maxNoProgressMs, "autopilotPolicy.maxNoProgressMs", 1_000, 900_000),
    maxAttemptElapsedMs: boundedInt(o.maxAttemptElapsedMs, "autopilotPolicy.maxAttemptElapsedMs", 1_000, 3_600_000),
    cleanupTermGraceMs: boundedInt(o.cleanupTermGraceMs, "autopilotPolicy.cleanupTermGraceMs", 100, 30_000),
    cleanupKillGraceMs: boundedInt(o.cleanupKillGraceMs, "autopilotPolicy.cleanupKillGraceMs", 100, 30_000),
  };
  if (policy.maxAttemptElapsedMs > maxElapsedMs) {
    throw new OrchestrationError(
      "invalid_manifest",
      `autopilotPolicy.maxAttemptElapsedMs는 manifest.maxElapsedMs(${maxElapsedMs}) 이하여야 한다`,
    );
  }
  return policy;
}

/**
 * **승인된 typed operation 1건**(대장 `B-10`). kind별로 key 집합이 닫혀 있고 shell 문자열·wildcard·
 * 런타임 실행 파일 선택은 표현할 수 없다.
 *
 * `run_process.executable`은 **승인된 Node 실행 파일과 정확히 같아야 한다**(의도적으로 계획보다 좁다).
 * 이유: `git`을 typed operation으로 열면 승인된 argv 배열 하나만으로 `push`/`remote`가 표현 가능해지고
 * 그것은 레포 hard deny(원격 저장소 직접 쓰기)를 **승인 문서가 덮는 형태**가 된다. git은 controller가
 * 소유한 `trustedGit.ts`의 고정 메서드로만 지나가고, `processObserver`는 정리 관측 전용이며 typed
 * operation이 아니다. argv "screen"은 만들지 않는다 — 그것은 집행이 아니라 흉내이기 때문이다.
 */
function validateApprovedOperation(
  raw: unknown,
  what: string,
  ctx: { writableRoots: string[]; approvedOwnership: string[] | undefined; nodePath: string; maxAttemptElapsedMs: number },
): ApprovedOperation {
  const o = asObject(raw, what);
  const kind = o.kind;
  if (kind !== "write_file" && kind !== "run_process") {
    throw new OrchestrationError("invalid_manifest", `${what}.kind는 write_file|run_process여야 한다`);
  }
  const authorityId = assertSlug(o.authorityId, `${what}.authorityId`);
  if (kind === "write_file") {
    closedKeys(o, WRITE_FILE_AUTHORITY_KEYS, what);
    const path = normalizeWorkspacePath(o.path, `${what}.path`);
    if (!ctx.writableRoots.some((root) => pathWithin(path, root))) {
      throw new OrchestrationError("operation_outside_writable_root", `${what}.path가 승인된 writableRoots 밖이다: ${path}`);
    }
    // 이 task의 ownership이 manifest에 명시돼 있으면 그 범위도 함께 본다(child는 durable ownership으로
    // dispatch 시점에 검사된다 — manifest는 child ownership을 알 수 없다).
    if (ctx.approvedOwnership !== undefined && !ctx.approvedOwnership.some((own) => pathWithin(path, own))) {
      throw new OrchestrationError("operation_not_owned", `${what}.path가 그 task의 승인된 ownership 밖이다: ${path}`);
    }
    return { authorityId, kind, path, maxBytes: boundedInt(o.maxBytes, `${what}.maxBytes`, 1, LIMITS.maxWriteBytes) };
  }
  closedKeys(o, RUN_PROCESS_AUTHORITY_KEYS, what);
  if (typeof o.executable !== "string" || o.executable !== ctx.nodePath) {
    throw new OrchestrationError(
      "operation_executable_not_approved",
      `${what}.executable은 승인된 executionAuthority.node.path와 정확히 같아야 한다(git·codex·임의 경로는 typed operation이 아니다)`,
    );
  }
  if (!Array.isArray(o.args)) throw new OrchestrationError("invalid_manifest", `${what}.args는 배열이어야 한다`);
  if (o.args.length > LIMITS.maxOperationArgs) {
    throw new OrchestrationError("invalid_manifest", `${what}.args는 ${LIMITS.maxOperationArgs}개 이하여야 한다`);
  }
  const args: string[] = [];
  for (const a of o.args) {
    // argv도 **정확한 바이트**로 전달돼야 한다: 고립 surrogate는 spawn 경계에서 U+FFFD로 바뀌어
    // "승인된 인자와 정확히 같은가"가 흉내가 된다(대장 `B-10`은 이것과 별개로 **여전히 열린 게이트**다).
    if (
      typeof a !== "string" ||
      a.length === 0 ||
      a.includes("\0") ||
      hasLoneSurrogate(a) ||
      codePointLength(a) > LIMITS.maxOperationArgLength
    ) {
      throw new OrchestrationError("invalid_manifest", `${what}.args 항목은 NUL 없는 bounded 문자열이어야 한다`);
    }
    args.push(a);
  }
  const timeoutMs = boundedInt(o.timeoutMs, `${what}.timeoutMs`, 100, 3_600_000);
  if (timeoutMs > ctx.maxAttemptElapsedMs) {
    throw new OrchestrationError("invalid_manifest", `${what}.timeoutMs는 autopilotPolicy.maxAttemptElapsedMs 이하여야 한다`);
  }
  return { authorityId, kind, executable: o.executable, args, timeoutMs };
}

function validateDependency(raw: unknown): ApprovedDependency {
  const o = asObject(raw, "allowedDependencies 항목");
  closedKeys(o, DEPENDENCY_KEYS, "allowedDependencies 항목");
  if (typeof o.name !== "string" || o.name.length > LIMITS.maxIdLength || !DEPENDENCY_NAME_RE.test(o.name)) {
    throw new OrchestrationError("invalid_manifest", `allowedDependencies[].name이 package 이름이 아니다: ${String(o.name)}`);
  }
  if (typeof o.version !== "string" || !DEPENDENCY_VERSION_RE.test(o.version)) {
    throw new OrchestrationError(
      "dependency_not_pinned",
      `allowedDependencies[].version은 정확히 pin된 버전이어야 한다(latest·범위·tag 금지): ${String(o.version)}`,
    );
  }
  return { name: o.name, version: o.version };
}

/**
 * manifest 전체 검증. 통과하면 **정규화된 사본**을 돌려준다(입력 객체는 건드리지 않는다).
 * run과의 대조(milestone 일치·만료)는 kernel이 한다 — 이 함수는 순수하고 파일을 만들지 않는다.
 */
export function validateApprovalManifest(raw: unknown): MilestoneApprovalManifest {
  const o = asObject(raw, "manifest");
  // **M5c(v2) 판정은 마이그레이션 없이 fail closed다.** 없는 정책·권위를 기본값으로 채우면 그것이 곧
  // 조용한 자동 승인이므로, v1 manifest는 안정 코드로 거부하고 새 승인을 요구한다.
  if (!("autopilotPolicy" in o) || !("operationAuthorityByTask" in o)) {
    throw new OrchestrationError(
      "manifest_pre_m5c_unsupported",
      "M5c 이전 승인 manifest다(autopilotPolicy/operationAuthorityByTask 없음). 마이그레이션하지 않으며 새 승인이 필요하다",
    );
  }
  closedKeys(o, MANIFEST_KEYS, "manifest");

  if (typeof o.approvedCommit !== "string" || !COMMIT_RE.test(o.approvedCommit)) {
    throw new OrchestrationError("invalid_manifest", "manifest.approvedCommit은 40자 소문자 hex commit이어야 한다");
  }
  const writableRoots = normalizedList(
    o.writableRoots,
    "manifest.writableRoots",
    LIMITS.maxWritableRoots,
    (v, w) => normalizeWorkspacePath(v, w),
    1,
  );

  const ownershipRaw = asObject(o.ownershipByTask, "manifest.ownershipByTask");
  const taskIds = Object.keys(ownershipRaw);
  if (taskIds.length > LIMITS.maxTasksPerRun) {
    throw new OrchestrationError("invalid_manifest", `manifest.ownershipByTask는 ${LIMITS.maxTasksPerRun}개 이하여야 한다`);
  }
  const ownershipByTask: Record<string, string[]> = {};
  for (const taskId of taskIds.sort()) {
    assertSlug(taskId, "manifest.ownershipByTask key");
    const paths = normalizedList(
      ownershipRaw[taskId],
      `manifest.ownershipByTask[${taskId}]`,
      LIMITS.maxOwnershipPaths,
      (v, w) => normalizeWorkspacePath(v, w),
      1,
    );
    for (const p of paths) {
      if (!writableRoots.some((root) => pathWithin(p, root))) {
        throw new OrchestrationError(
          "ownership_outside_writable_root",
          `manifest.ownershipByTask[${taskId}]의 ${p}가 승인된 writableRoots 밖이다`,
        );
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
  const allowedDependencies: ApprovedDependency[] = [];
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

  const executionAuthority = validateExecutionAuthority(o.executionAuthority);
  const maxElapsedMs = boundedInt(o.maxElapsedMs, "manifest.maxElapsedMs", 1, LIMITS.maxManifestElapsedMs);
  const autopilotPolicy = validateAutopilotPolicy(o.autopilotPolicy, maxElapsedMs);

  // typed operation 권위 — taskId 사전순, task 안에서 authorityId 유일, 전부 승인 범위 안.
  const opsRaw = asObject(o.operationAuthorityByTask, "manifest.operationAuthorityByTask");
  const opTaskIds = Object.keys(opsRaw);
  if (opTaskIds.length > LIMITS.maxTasksPerRun) {
    throw new OrchestrationError("invalid_manifest", `manifest.operationAuthorityByTask는 ${LIMITS.maxTasksPerRun}개 이하여야 한다`);
  }
  const operationAuthorityByTask: Record<string, ApprovedOperation[]> = {};
  for (const taskId of opTaskIds.sort()) {
    assertSlug(taskId, "manifest.operationAuthorityByTask key");
    const list = opsRaw[taskId];
    const what = `manifest.operationAuthorityByTask[${taskId}]`;
    if (!Array.isArray(list)) throw new OrchestrationError("invalid_manifest", `${what}는 배열이어야 한다`);
    if (list.length > LIMITS.maxOperationAuthorities) {
      throw new OrchestrationError("invalid_manifest", `${what}는 ${LIMITS.maxOperationAuthorities}개 이하여야 한다`);
    }
    const ops: ApprovedOperation[] = [];
    for (let i = 0; i < list.length; i++) {
      const op = validateApprovedOperation(list[i], `${what}[${i}]`, {
        writableRoots,
        approvedOwnership: Object.prototype.hasOwnProperty.call(ownershipByTask, taskId) ? ownershipByTask[taskId] : undefined,
        nodePath: executionAuthority.node.path,
        maxAttemptElapsedMs: autopilotPolicy.maxAttemptElapsedMs,
      });
      if (ops.some((x) => x.authorityId === op.authorityId)) {
        throw new OrchestrationError("invalid_manifest", `${what}에 중복 authorityId가 있다: ${op.authorityId}`);
      }
      ops.push(op);
    }
    // authorityId 사전순 고정 — 같은 승인이 두 바이트로 저장되지 않게 한다(digest 결정성).
    ops.sort((a, b) => (a.authorityId < b.authorityId ? -1 : a.authorityId > b.authorityId ? 1 : 0));
    operationAuthorityByTask[taskId] = ops;
  }

  return {
    milestoneId: assertSlug(o.milestoneId, "manifest.milestoneId"),
    approvedCommit: o.approvedCommit,
    writableRoots,
    ownershipByTask,
    allowedCommands: normalizedList(o.allowedCommands, "manifest.allowedCommands", LIMITS.maxAllowedCommands, normalizeCommand),
    allowedDependencies,
    allowedNetworkDomains: normalizedList(
      o.allowedNetworkDomains,
      "manifest.allowedNetworkDomains",
      LIMITS.maxAllowedNetworkDomains,
      normalizeDomain,
    ),
    executionAuthority,
    autopilotPolicy,
    operationAuthorityByTask,
    maxSessions: boundedInt(o.maxSessions, "manifest.maxSessions", 1, LIMITS.maxManifestSessions),
    maxTokens: o.maxTokens === null ? null : boundedInt(o.maxTokens, "manifest.maxTokens", 1, LIMITS.maxManifestTokens),
    maxElapsedMs,
    localMergeAllowed: o.localMergeAllowed,
    expiresAt: assertTimestamp(o.expiresAt, "manifest.expiresAt"),
  };
}

/**
 * **정확히 이 task의 이 authorityId가 승인됐는가**(deny-by-default). 없으면 `null`이고 호출자는
 * hard deny한다 — "부재"가 곧 허용이 되는 경로는 없다.
 */
export function approvedOperationFor(
  manifest: MilestoneApprovalManifest,
  taskId: unknown,
  authorityId: unknown,
): ApprovedOperation | null {
  if (typeof taskId !== "string" || typeof authorityId !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(manifest.operationAuthorityByTask, taskId)) return null;
  return manifest.operationAuthorityByTask[taskId].find((op) => op.authorityId === authorityId) ?? null;
}

// ── M5 executor용 순수 조회 API (deny-by-default, 실행 없음) ─────────────────

/**
 * **정확히 이 명령**이 승인됐는가. shell을 파싱하지 않고 문자열 동치만 본다 —
 * 파싱을 넣으면 "승인된 명령처럼 보이는 것"을 판정하게 되고 그건 이 계층의 권한이 아니다.
 * 정규화 규칙 밖의 입력(공백 패딩·제어문자 등)은 그냥 거부한다.
 */
export function commandAllowed(manifest: MilestoneApprovalManifest, command: unknown): boolean {
  if (typeof command !== "string" || !COMMAND_RE.test(command) || command.includes("  ") || command.endsWith(" ")) {
    return false;
  }
  return manifest.allowedCommands.includes(command);
}

/** **정확히 이 이름 + 이 pin된 버전**이 승인됐는가. 범위·`latest`·tag는 언제나 false다. */
export function dependencyAllowed(manifest: MilestoneApprovalManifest, name: unknown, version: unknown): boolean {
  if (typeof name !== "string" || typeof version !== "string") return false;
  if (!DEPENDENCY_NAME_RE.test(name) || !DEPENDENCY_VERSION_RE.test(version)) return false;
  return manifest.allowedDependencies.some((d) => d.name === name && d.version === version);
}

/** **정확히 이 도메인**이 승인됐는가. 하위 도메인은 자동 허용하지 않는다(별도 승인 필요). */
export function networkDomainAllowed(manifest: MilestoneApprovalManifest, domain: unknown): boolean {
  if (typeof domain !== "string" || domain.length > LIMITS.maxDomainLength || !DOMAIN_RE.test(domain)) return false;
  return manifest.allowedNetworkDomains.includes(domain);
}

/** slug·digest 규칙을 registry 문서에서도 쓰기 위해 재수출한다(중복 정의 금지). */
export { SHA256_PATTERN, SLUG_PATTERN };
