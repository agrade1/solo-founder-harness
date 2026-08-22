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
  CONTROLLER_ACTIONS,
  CONTROLLER_ACTION_DATA_KEYS,
  LIMITS,
  type ApprovedDependency,
  type ApprovedExecutable,
  type ApprovedOperation,
  type AutopilotPolicy,
  type ControllerAction,
  type MilestoneApprovalManifest,
  OrchestrationError,
  SHA256_PATTERN,
  SLUG_PATTERN,
  type ValidatePlanData,
  type RunTestsData,
  APPROVED_OPERATION_KINDS,
  GIT_WORKTREE_ACTIONS,
  type GitWorktreeAction,
  assertSlug,
  assertTimestamp,
  codePointLength,
  hasLoneSurrogate,
  isSlug,
  normalizeWorkspacePath,
} from "./orchestrationTypes.js";
import { readOwnArray, readOwnData } from "./typedPlan.js";

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
  // ── V3 M11 (대장 `C-98`) ──
  "reviewRoundtrip",
] as const;

/**
 * manifest 최상위의 **선택** key. 부재는 정규화 결과에 키를 남기지 않으므로 **기존 승인의 canonical
 * digest가 바이트 단위로 그대로**다(`codexHome`과 같은 규율 — 예산 회계·state binding 불변).
 */
export const MANIFEST_OPTIONAL_KEYS = ["reviewRoundtrip"] as const;

/** 리뷰 왕복 선언의 닫힌 key 집합. */
export const REVIEW_ROUNDTRIP_KEYS = ["author", "reviews", "revision", "verify"] as const;
export const REVIEW_ROUNDTRIP_LENS_KEYS = ["code", "security", "test"] as const;

export const DEPENDENCY_KEYS = ["name", "version"] as const;

/**
 * 승인된 실행 권위 key. M5c(v2)에서 `node`·`processObserver`가 필수로 더해졌고 `codex`는 null 허용이다.
 * 더 넣거나 빼면 `invalid_manifest`이고, v1(`codex`+`git`만)은 `manifest_pre_m5c_unsupported`다.
 */
export const EXECUTION_AUTHORITY_KEYS = ["claude", "claudeHome", "codex", "codexHome", "controllerEntrypoint", "git", "node", "processObserver"] as const;
/**
 * 위 집합 중 **필수** key(대장 `B-7ⓐ`). `codexHome`만 선택이다 — 없으면 "live 인증 미승인"이고
 * 격리 홈은 기존 계약대로 완전히 비어 있어야 한다(조용한 fallback이 아니라 인증 없는 fail closed다).
 * 필수로 만들지 않은 이유는 호환이 아니라 **의미**다: 자격증명을 넣어 둔 홈은 사람이 별도로 승인해야
 * 하는 자산이고, 그것이 없는 승인은 codex를 인증 없이 돌리라는 뜻이지 "아무 홈이나 쓰라"는 뜻이 아니다.
 */
export const EXECUTION_AUTHORITY_OPTIONAL_KEYS = ["claude", "claudeHome", "codexHome"] as const;
export const EXECUTION_AUTHORITY_REQUIRED_KEYS = ["codex", "controllerEntrypoint", "git", "node", "processObserver"] as const;
export const APPROVED_EXECUTABLE_KEYS = ["path", "sha256"] as const;
/** 승인된 디렉터리 record의 key 집합. **digest는 없다** — 자격증명 내용은 해싱조차 하지 않는다. */
export const APPROVED_DIRECTORY_KEYS = ["path"] as const;

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
/**
 * `run_process` 권위 key(3A 2차 리비전 B2 · 대장 `B-10`). **`executable`도 `args`도 없다** — 실행 대상은
 * manifest 전체에 하나로 고정된 `executionAuthority.node` + `controllerEntrypoint`이고, 승인 문서가 고르는
 * 것은 닫힌 `action`과 **데이터 전용** `data`뿐이다.
 */
export const RUN_PROCESS_AUTHORITY_KEYS = ["authorityId", "kind", "action", "data", "timeoutMs"] as const;

/**
 * **격리 worktree 조작 승인 1건의 닫힌 key 집합**(V3 M9 T3③). 경로·브랜치·커밋·remote·refspec을 담을
 * 필드가 **하나도 없다** — 전부 kernel이 durable(runId·taskId·`approvedCommit`)에서 파생한다.
 * `timeoutMs`도 없다 — 집행기가 trusted git 질의의 30초 상수를 쓴다. **다만 "작업량이 상수"는
 * 질의에만 참이다**: `worktree add`는 tree 전체 checkout이라 repo 크기에 비례한다(T3③ 적대적 리뷰
 * B-3). 큰 repo에서 deadline kill이 나면 승인 루트 밖에 잔재가 남고 `prune`은 닫힌 집합에 없다 →
 * 대장 `B-31`. 없앴다고 주장하지 않는다.
 */
export const GIT_WORKTREE_AUTHORITY_KEYS = ["authorityId", "kind", "action"] as const;

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

/**
 * **호출자 소유 객체를 한 번에 평범한 데이터로 입양한다**(3A 3차 리비전 `C2`).
 *
 * 이전 판은 원본 객체를 그대로 들고 다니며 같은 property를 **여러 번** 읽었다 → 교대 getter가
 * "검증한 `action`"과 "저장하는 `action`"을 다르게 만들 수 있었고(선언 enum 밖 값 반환), proxy trap이
 * 던진 `OrchestrationError`가 그대로 나가 **호출자가 진단 taxonomy를 고를 수 있었다**.
 *
 * 지금은 `typedPlan.readOwnData`(이미 계획 경계에서 쓰는 정본)를 재사용해 **accessor·`Proxy`·계약 밖
 * prototype·symbol key를 거부**하고 descriptor의 `value`만 한 번 읽는다 → 호출자 코드가 **실행되지 않는다**.
 */
function asObject(v: unknown, what: string): Record<string, unknown> {
  const read = readOwnData(v);
  if (read === null) {
    throw new OrchestrationError("invalid_manifest", `${what}는 accessor·proxy 없는 순수 데이터 객체여야 한다`);
  }
  return read;
}

/** 같은 규칙의 배열 판(여분 property·accessor 인덱스·`Proxy`를 거부하고 항목을 한 번씩 옮긴다). */
function asArray(v: unknown, what: string): unknown[] {
  const read = readOwnArray(v);
  if (read === null) {
    throw new OrchestrationError("invalid_manifest", `${what}는 accessor·proxy 없는 순수 데이터 배열이어야 한다`);
  }
  return read;
}

function closedKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  /** `allowed` 중 **부재가 허용되는** key(대장 `B-7ⓐ`). 기본은 빈 목록 = 전부 필수(기존 계약 그대로). */
  optional: readonly string[] = [],
): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new OrchestrationError("invalid_manifest", `${what}에 허용되지 않은 필드: ${k}`);
  }
  for (const k of allowed) {
    if (!optional.includes(k) && !(k in o)) throw new OrchestrationError("invalid_manifest", `${what}에 필수 필드 없음: ${k}`);
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
  const items = asArray(raw, what);
  if (items.length < minItems) throw new OrchestrationError("invalid_manifest", `${what}는 최소 ${minItems}개가 필요하다`);
  if (items.length > max) throw new OrchestrationError("invalid_manifest", `${what}는 ${max}개 이하여야 한다`);
  const seen = new Set<string>();
  for (const item of items) {
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
/**
 * 승인된 절대경로 1건. 길이는 **코드 포인트**로 센다 — schema `maxLength`와 같은 의미여야 한다(대장 `C-40`).
 * 고립 surrogate는 파일 시스템 경계에서 U+FFFD로 바뀌므로 **승인된 경로의 신원이 깨진다**
 * (V3 M5c 3A 리비전 A4 — workspace 경로와 같은 규칙을 승인된 절대경로에도 적용한다).
 */
function approvedAbsolutePath(path: unknown, what: string): string {
  if (
    typeof path !== "string" ||
    codePointLength(path) > LIMITS.maxPathLength ||
    hasLoneSurrogate(path) ||
    !APPROVED_PATH_RE.test(path)
  ) {
    throw new OrchestrationError("invalid_manifest", `${what}.path는 정규 절대경로여야 한다`);
  }
  return path;
}

/**
 * 승인된 디렉터리 1건(대장 `B-7ⓐ`). 경로 계약만 본다 — 파일 시스템은 만지지 않고 내용 digest도 없다.
 * 신원(dev+ino) · 0700 · 소유자 · 허용된 항목 검증은 spawn 직전 `verifyCodexHome`이 한다.
 */
function validateApprovedDirectory(raw: unknown, what: string): { path: string } {
  const o = asObject(raw, what);
  closedKeys(o, APPROVED_DIRECTORY_KEYS, what);
  return { path: approvedAbsolutePath(o.path, what) };
}

function validateApprovedExecutable(raw: unknown, what: string): ApprovedExecutable {
  const o = asObject(raw, what);
  closedKeys(o, APPROVED_EXECUTABLE_KEYS, what);
  const path = approvedAbsolutePath(o.path, what);
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
  if (!("node" in o) || !("processObserver" in o) || !("controllerEntrypoint" in o)) {
    throw new OrchestrationError(
      "manifest_pre_m5c_unsupported",
      "M5c 이전 승인 manifest다(executionAuthority.node/processObserver/controllerEntrypoint 없음). 마이그레이션하지 않으며 새 승인이 필요하다",
    );
  }
  closedKeys(o, EXECUTION_AUTHORITY_KEYS, "manifest.executionAuthority", EXECUTION_AUTHORITY_OPTIONAL_KEYS);
  // `B-7ⓐ`: 선택 key. **부재와 `null`은 같은 뜻**(live 인증 미승인)이고, 그 경우 정규화 결과에 키 자체가
  // 없으므로 기존 승인의 canonical digest는 **바이트 단위로 그대로**다(예산 회계·state binding 불변).
  // `C-86`: `claudeHome`도 같은 규율이다 — 부재와 `null`이 같은 뜻이고, 부재면 정규화 결과에 키가 없어
  // 기존 승인의 canonical digest가 **바이트 단위로 그대로**다. "claude를 승인했으면 홈도 필요하다"는
  // 짝 강제는 manifest가 아니라 `approvedWorkerExecutable()`이 한다(그 자리가 live 진입점이다).
  const claudeHome =
    o.claudeHome === undefined || o.claudeHome === null
      ? undefined
      : validateApprovedDirectory(o.claudeHome, "manifest.executionAuthority.claudeHome");
  const codexHome =
    o.codexHome === undefined || o.codexHome === null
      ? null
      : validateApprovedDirectory(o.codexHome, "manifest.executionAuthority.codexHome");
  /**
   * **V3 M10 T3 — worker 세션 실행 파일**(선택). 무인 loop가 live worker backend를 쓸 때 **유일하게**
   * 실행할 수 있는 프로그램이며, 없으면(부재·`null`) live worker는 **표현 불가**다(offline backend만 남는다).
   *
   * `codexHome`과 같은 이유로 선택이다: 부재와 `null`이 같은 뜻이고, 그 경우 정규화 결과에 키가 없으므로
   * **기존 승인의 canonical digest가 바이트 단위로 그대로다**(예산 회계·state binding 불변).
   * 필수로 만들지 않은 것은 호환이 아니라 의미다 — live worker를 쓰지 않는 승인에 그 권능을 넣지 않는다.
   */
  const claude =
    o.claude === undefined || o.claude === null
      ? null
      : validateApprovedExecutable(o.claude, "manifest.executionAuthority.claude");
  return {
    ...(claude === null ? {} : { claude }),
    ...(claudeHome === undefined ? {} : { claudeHome }),
    codex: o.codex === null ? null : validateApprovedExecutable(o.codex, "manifest.executionAuthority.codex"),
    ...(codexHome === null ? {} : { codexHome }),
    // **고정 controller entrypoint**(3A 2차 리비전 B2): 모든 typed `run_process`가 실행하는 **유일한**
    // script다. 경로·digest는 여기서만 오고 승인 문서의 다른 어떤 필드도 이것을 바꾸지 못한다.
    controllerEntrypoint: validateApprovedExecutable(o.controllerEntrypoint, "manifest.executionAuthority.controllerEntrypoint"),
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
 * **`run_process`는 실행 대상을 고를 수 없다**(3A 2차 리비전 B2 · 대장 `B-10`). 1차 판은 승인된 Node 경로 +
 * "bounded non-NUL 문자열" argv였다 → `--eval`·`--require`·임의 script 경로가 그대로 통과해 **승인된 Node
 * 하나가 곧 임의 로컬 코드 권위**였다(token 화면으로는 닫히지 않는다 — 그것은 집행이 아니라 흉내다).
 * 지금 승인 문서가 고를 수 있는 것은 **닫힌 `action` enum 하나와 데이터 전용 `data`뿐**이고, 실행 대상은
 * `executionAuthority.node` + `controllerEntrypoint`로 manifest 전체에 하나로 고정된다.
 * `git`도 마찬가지로 typed operation이 아니다(승인된 argv 하나로 `push`/`remote`가 표현되면 레포 hard deny를
 * 승인 문서가 덮는 형태가 된다). git은 `trustedGit.ts`의 고정 메서드로만 지나가고 `processObserver`는
 * 정리 관측 전용이다.
 */
function validateApprovedOperation(
  raw: unknown,
  what: string,
  ctx: { writableRoots: string[]; approvedOwnership: string[] | undefined; maxAttemptElapsedMs: number },
): ApprovedOperation {
  const o = asObject(raw, what);
  const kind = o.kind;
  if (kind !== "write_file" && kind !== "run_process" && kind !== "git_worktree") {
    throw new OrchestrationError("invalid_manifest", `${what}.kind는 ${APPROVED_OPERATION_KINDS.join("|")} 중 하나여야 한다`);
  }
  const authorityId = assertSlug(o.authorityId, `${what}.authorityId`);
  if (kind === "git_worktree") {
    closedKeys(o, GIT_WORKTREE_AUTHORITY_KEYS, what);
    if (typeof o.action !== "string" || !(GIT_WORKTREE_ACTIONS as readonly string[]).includes(o.action)) {
      throw new OrchestrationError(
        "operation_action_not_approved",
        `${what}.action은 ${GIT_WORKTREE_ACTIONS.join("|")} 중 하나여야 한다(경로·브랜치·커밋·remote는 표현할 필드가 없다)`,
      );
    }
    return { authorityId, kind, action: o.action as GitWorktreeAction };
  }
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
  if (typeof o.action !== "string" || !(CONTROLLER_ACTIONS as readonly string[]).includes(o.action)) {
    throw new OrchestrationError(
      "operation_action_not_approved",
      `${what}.action은 ${CONTROLLER_ACTIONS.join("|")} 중 하나여야 한다(임의 명령·script·module 지정자는 표현할 필드가 없다)`,
    );
  }
  const action = o.action as ControllerAction;
  const timeoutMs = boundedInt(o.timeoutMs, `${what}.timeoutMs`, 100, 3_600_000);
  if (timeoutMs > ctx.maxAttemptElapsedMs) {
    throw new OrchestrationError("invalid_manifest", `${what}.timeoutMs는 autopilotPolicy.maxAttemptElapsedMs 이하여야 한다`);
  }
  // action마다 `data` 타입이 다른 **판별 union**이라 여기서 갈라 만든다(공통 객체 하나를 만들어
  // 캐스팅하면 action↔data 짝이 타입에서 풀린다).
  const data = validateActionData(o.data, action, `${what}.data`, ctx);
  if (action === "run-tests") {
    return { authorityId, kind, action, data: data as RunTestsData, timeoutMs };
  }
  return { authorityId, kind, action, data: data as ValidatePlanData, timeoutMs };
}

/**
 * **action별 입력 계약**(3A 3차 리비전 B2 · 대장 `B-10`).
 *
 * 이전 판은 `data: string[]`(0..16 임의 문자열)이었다 → arity·경로 의미·소유권·읽기 범위를 **미래 launcher가
 * 지어내야 했고**, 그래서 그 인터페이스는 과승인이거나 폐기 대상이었다. 지금은 action마다 **정확한 key 집합과
 * 값의 의미**가 있다: `validate-plan`은 정확히 `{ planPath }` 하나이며 그 경로는 정규화된 workspace-relative
 * 경로이고 승인된 `writableRoots` 안 · 그 task의 승인 ownership 안이어야 한다.
 *
 * 별도의 `readableRoots`를 새로 만들지 않았다: 읽기 범위를 **이미 승인된 쓰기 범위 안쪽으로** 좁히는 것이
 * 더 적은 권한이고(fail closed) 승인 문서에 새 축을 열지 않는다.
 *
 * **V3 M9 선결 1**: `run-tests`가 더해졌고 그 입력은 정확히 `{ projectPath }` 하나다. 두 action의 경로
 * 검증은 **같은 계약**이라 `approvedActionPath()` 하나를 공유한다 — action이 늘어도 경로 규칙이 갈라지지
 * 않게 하는 것이 목적이다. 명령·인자·러너를 담는 key는 어느 action에도 없다.
 */
function validateActionData(
  raw: unknown,
  action: ControllerAction,
  what: string,
  ctx: { writableRoots: string[]; approvedOwnership: string[] | undefined },
): ValidatePlanData | RunTestsData {
  const o = asObject(raw, what);
  closedKeys(o, CONTROLLER_ACTION_DATA_KEYS[action], what);
  if (action === "run-tests") {
    return { projectPath: approvedActionPath(o.projectPath, `${what}.projectPath`, ctx) };
  }
  return { planPath: approvedActionPath(o.planPath, `${what}.planPath`, ctx) };
}

/**
 * action data가 담는 **승인된 workspace-relative 경로 1건**. `validate-plan`·`run-tests`가 공유한다.
 */
function approvedActionPath(
  raw: unknown,
  what: string,
  ctx: { writableRoots: string[]; approvedOwnership: string[] | undefined },
): string {
  // 경로는 **정확한 바이트**여야 한다: 고립 surrogate는 파일 시스템·spawn 경계에서 U+FFFD로 바뀌어
  // "승인된 인자와 정확히 같은가"가 흉내가 된다. `normalizeWorkspacePath`가 그것까지 함께 거부한다.
  let normalized: string;
  try {
    normalized = normalizeWorkspacePath(raw, what);
  } catch {
    throw new OrchestrationError("operation_data_not_approved", `${what}는 정규화 가능한 workspace-relative 경로여야 한다`);
  }
  // 승인 문서에는 **이미 정규화된 형태**만 담긴다(같은 파일을 가리키는 두 표기가 승인에 남지 않는다).
  if (raw !== normalized || codePointLength(normalized) > LIMITS.maxPathLength) {
    throw new OrchestrationError("operation_data_not_approved", `${what}는 이미 정규화된 bounded 경로여야 한다`);
  }
  if (!ctx.writableRoots.some((root) => pathWithin(normalized, root))) {
    throw new OrchestrationError("operation_outside_writable_root", `${what}가 승인된 writableRoots 밖이다`);
  }
  if (ctx.approvedOwnership !== undefined && !ctx.approvedOwnership.some((own) => pathWithin(normalized, own))) {
    throw new OrchestrationError("operation_not_owned", `${what}가 그 task의 승인된 ownership 밖이다`);
  }
  return normalized;
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
  closedKeys(o, MANIFEST_KEYS, "manifest", MANIFEST_OPTIONAL_KEYS);
  // `C-98`: 부재와 `null`이 같은 뜻(강제하지 않음)이고, 부재면 정규화 결과에 키가 없어 기존 승인의
  // canonical digest가 바이트 단위로 그대로다.
  const reviewRoundtrip =
    o.reviewRoundtrip === undefined || o.reviewRoundtrip === null ? undefined : validateReviewRoundtrip(o.reviewRoundtrip);

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

  const depsRaw = asArray(o.allowedDependencies, "manifest.allowedDependencies");
  if (depsRaw.length > LIMITS.maxAllowedDependencies) {
    throw new OrchestrationError("invalid_manifest", `manifest.allowedDependencies는 ${LIMITS.maxAllowedDependencies}개 이하여야 한다`);
  }
  const allowedDependencies: ApprovedDependency[] = [];
  for (const d of depsRaw) {
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
    const what = `manifest.operationAuthorityByTask[${taskId}]`;
    const list = asArray(opsRaw[taskId], what);
    if (list.length > LIMITS.maxOperationAuthorities) {
      throw new OrchestrationError("invalid_manifest", `${what}는 ${LIMITS.maxOperationAuthorities}개 이하여야 한다`);
    }
    const ops: ApprovedOperation[] = [];
    for (let i = 0; i < list.length; i++) {
      const op = validateApprovedOperation(list[i], `${what}[${i}]`, {
        writableRoots,
        approvedOwnership: Object.prototype.hasOwnProperty.call(ownershipByTask, taskId) ? ownershipByTask[taskId] : undefined,
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
    ...(reviewRoundtrip === undefined ? {} : { reviewRoundtrip }),
  };
}

/**
 * 리뷰 왕복 선언(`C-98`) — **taskId 여섯 개뿐**이고 전부 slug다. provider·세션·sandbox 필드를 두지
 * 않는 것이 계약이다: 승인 문서가 "리뷰어는 codex였다"고 **주장**할 수 있으면 게이트가 공허해진다.
 * 참가자 성질은 durable(`roleId`·`turnId`)에서만 파생한다.
 *
 * **같은 task를 두 자리에 쓸 수 없다** — 그러면 "저자가 자기를 리뷰"가 승인 문서 수준에서 표현된다
 * (계약 자신도 세션 재사용을 거부하지만, 여기서 먼저 fail closed로 막는다).
 */
function validateReviewRoundtrip(raw: unknown): NonNullable<MilestoneApprovalManifest["reviewRoundtrip"]> {
  const o = asObject(raw, "manifest.reviewRoundtrip");
  closedKeys(o, REVIEW_ROUNDTRIP_KEYS, "manifest.reviewRoundtrip");
  const lenses = asObject(o.reviews, "manifest.reviewRoundtrip.reviews");
  closedKeys(lenses, REVIEW_ROUNDTRIP_LENS_KEYS, "manifest.reviewRoundtrip.reviews");
  const out = {
    author: assertSlug(o.author, "manifest.reviewRoundtrip.author"),
    reviews: {
      code: assertSlug(lenses.code, "manifest.reviewRoundtrip.reviews.code"),
      security: assertSlug(lenses.security, "manifest.reviewRoundtrip.reviews.security"),
      test: assertSlug(lenses.test, "manifest.reviewRoundtrip.reviews.test"),
    },
    revision: assertSlug(o.revision, "manifest.reviewRoundtrip.revision"),
    verify: assertSlug(o.verify, "manifest.reviewRoundtrip.verify"),
  };
  const all = [out.author, out.reviews.code, out.reviews.security, out.reviews.test, out.revision, out.verify];
  if (new Set(all).size !== all.length) {
    throw new OrchestrationError("invalid_manifest", "manifest.reviewRoundtrip의 참가자 task는 서로 달라야 한다");
  }
  return out;
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
