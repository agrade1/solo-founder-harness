/**
 * V3 M12 **L2b** — **`harness draft-approval`**(검증된 DAG 문서 → 승인 manifest **초안**) +
 * **`harness validate-approval`**(초안을 채워 가며 반복해서 재는 read-only 판정기).
 *
 * L2a가 남긴 병목이 이것이다: live 모델이 12-task DAG 초안을 냈지만, 그것을 **돌리려면** 사람이
 * `ownershipByTask` 12항목 + task별 operation 권위 + 실행 파일 digest들을 손으로 써야 한다.
 * 이 모듈은 그중 **기계적으로 파생되는 부분만** 초안으로 뽑는다.
 *
 * ## 헌법 — 이 명령은 승인을 **발행(mint)하지 않는다**, 그것을 구조로 만든다
 *
 * ① **산출된 초안은 그대로는 실행될 수 없다.** 권위-의미 필드(만료·예산·커밋·정책 시간값·실행 파일
 *    digest·쓰기 상한)에는 **검증기가 확실히 거부하는 sentinel**이 들어간다. 그리고 그것은 관행이
 *    아니라 **집행**이다: `buildApprovalDraft`가 자기 산출물을 `validateApprovalManifest`에 먹여 보고
 *    **통과하면 파일을 쓰지 않고 던진다**(`draft_would_be_executable`). 즉 이 명령이 실행 가능한 승인을
 *    내보내는 경로는 코드에 존재하지 않는다 — 사람이 파일을 열어 고쳐야만 돈다.
 *
 * ② **PATH 조회·자동 발견이 없다.** 실행 파일 digest는 **사람이 플래그로 명시한 경로**에서만 계산한다.
 *    플래그가 없으면 그 항목도 sentinel이다. 이 모듈에는 `which`도 `process.env.PATH` 참조도 없다 —
 *    ambient 발견은 곧 승인 우회 통로이기 때문이다(`executionBoundary`가 env를 상속하지 않는 것과 같은 규율).
 *    명시된 경로도 **집행기와 같은 함수**(`verifyApprovedExecutable`)를 지나야 초안에 실린다: 상대경로·
 *    symlink·비실행·group 쓰기 가능 파일은 여기서 거부된다(그것들은 spawn 시점에 어차피 거부되므로,
 *    통과하지 못할 승인을 초안이 지어내지 않는다).
 *
 * ③ **기계적 파생만 한다.** `ownershipByTask` ← DAG node의 `ownership` · `operationAuthorityByTask` ←
 *    각 node의 `provides` 경로당 `write_file` 권위 1개. 그 밖의 값은 sentinel이거나 **deny 기본값**이다
 *    (`allowedCommands`/`allowedDependencies`/`allowedNetworkDomains`는 빈 목록 = 아무것도 허용 안 함,
 *    `localMergeAllowed`는 `false`, `codex`는 `null` = 미승인). deny 기본값은 조용한 fallback이 아니다 —
 *    "말하지 않은 것은 승인되지 않았다"를 그대로 적은 값이다.
 *
 * ## `writableRoots`를 파생하지 않는 이유 (기각한 대안)
 *
 * ⓐ **ownership 경로를 그대로 writableRoots로 쓴다**: 가장 좁고 정확하지만 `LIMITS.maxWritableRoots`가
 *    8이라 **12-task DAG(서로소 ownership 12건)에서 곧바로 표현 불가**다 — 정확히 이 slice가 겨냥한
 *    입력에서 도구가 죽는다.
 * ⓑ **공통 접두사로 압축한다**(`docs/prd`+`docs/ux` → `docs`): 상한 문제는 풀리지만 **사람이 승인한 적
 *    없는 더 넓은 루트를 하네스가 짓는다.** 유효 권한은 task ownership이 더 좁게 막더라도(kernel은 둘 다
 *    본다) *승인 문서가 말하는 범위*가 넓어진다 — 이 slice가 막으려는 mint에 가장 가까운 동작이다.
 *
 * 그래서 `writableRoots`는 **sentinel**이다(= 사람이 쓴다). 대신 stdout이 "이 경로들을 전부 덮어야
 * 한다"며 파생된 ownership 경로 전부를 출력한다 — 판단 재료는 주되 값은 사람이 적는다.
 *
 * ## `authorityId`를 어떻게 짓는가
 *
 * DAG node에 이미 `operations`(authorityId 참조 목록)가 있으면 **그 id를 그대로 존중한다** — 새로 짓지
 * 않는다. 이유는 취향이 아니라 계약이다: `materializeTaskDag`가 node의 `operations`를 승인의
 * `operationAuthorityByTask`와 대조하므로, 다른 이름을 지으면 그 DAG는 **어떤 승인으로도 물질화되지 않는다**.
 * node가 `operations`를 말하지 않으면 `<taskId>-w<n>`으로 짓고, stdout이 "이 id들을 DAG node의
 * `operations`에 적어야 그 task가 실제로 파일을 쓸 수 있다"고 말한다(`assignedOperations`는 node의
 * `operations`에서만 오므로, 승인만 채우고 DAG를 그대로 두면 **아무 task도 아무것도 쓰지 못한다**).
 *
 * `operations`가 있는데 개수가 `provides`와 다르면 **fail closed**다: 경로의 유일한 기계적 출처는
 * `provides`이므로 어느 권위가 어느 경로인지 지어낼 수 없다. (개수가 같으면 둘 다 사전순으로 고정돼
 * 있으므로 index로 짝짓는다 — 짝은 **이름표**일 뿐이고 권능은 경로가 정한다. 그래서 stdout이
 * `authorityId → path` 표를 그대로 출력해 사람이 확인하게 한다.)
 *
 * ## 이 모듈이 하지 않는 것
 *
 * 실행하지 않는다 · 네트워크·PATH를 보지 않는다 · 기존 파일을 덮어쓰지 않는다(`wx` — 사람이 채우던
 * 초안을 재실행이 지우는 것이 이 도구의 가장 큰 실질 위험이다) · 초안을 `autopilot-create`에 자동으로
 * 넘기지 않는다(그런 import 자체가 없다).
 */
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { LIMITS, OrchestrationError, assertSlug } from "../exec/orchestrationTypes.js";
import { validateApprovalManifest } from "../exec/approvalManifest.js";
import { verifyApprovedExecutable } from "../exec/executionBoundary.js";
import { validateTaskDag, type TaskDagNode } from "../exec/taskDag.js";
import { readJsonDocument } from "./autopilotCreate.js";

/**
 * **사람이 채워야 하는 자리의 표식.** 문자열 자리는 이 접두사, 수 자리는 `-1`이다.
 *
 * `-1`을 쓰는 이유: manifest의 수 필드는 전부 하한이 0 이상이라(`boundedInt`) **-1은 어느 자리에서도
 * 유효하지 않다** → "남은 sentinel 찾기"가 값 하나로 닫힌다. 별도의 문자열 표식을 수 자리에 넣는
 * 대안은 기각했다: 타입이 달라지면 "형식 오류"와 "미기입"이 사람 눈에 구분되지 않는다.
 */
export const SENTINEL_PREFIX = "REPLACE_ME_";
export const SENTINEL_NUMBER = -1;

const sentinel = (field: string): string => `${SENTINEL_PREFIX}${field}`;

/** 승인 초안 파일 이름이 **초안임을 말해야 한다**는 계약(아래 `assertDraftFileName`). */
export const DRAFT_NAME_MARKER = "draft";
export const DEFAULT_DRAFT_FILE = "approval-draft.json";

export interface DraftApprovalCliOptions {
  /** 검증된 task DAG 문서 경로. `validateTaskDag`를 통과하지 못하면 fail closed다. */
  dag: string;
  /** 승인 milestone id(slug). */
  milestone: string;
  /** 출력 경로(기본 `approval-draft.json`). 이름에 "draft"가 없으면 거부한다. */
  out?: string;
  // ── 실행 파일 경로: **사람이 명시할 때만** digest를 계산한다(자동 발견 없음) ──
  claude?: string;
  git?: string;
  node?: string;
  processObserver?: string;
  controllerEntrypoint?: string;
}

/** 초안 안의 승인 record 1건 — 값이 sentinel일 수 있으므로 `ApprovedExecutable` 타입을 쓰지 않는다. */
interface DraftExecutable {
  path: string;
  sha256: string;
}

/**
 * **명시된 경로 하나를 승인 record로 만든다.** 없으면 sentinel이고, 있으면 **집행기와 같은 함수**로
 * 검증한 뒤에만 실린다.
 *
 * ponytail: digest는 `readFileSync` 한 번(= 최대 파일 크기만큼의 peak memory)으로 계산한다.
 * `executionBoundary`는 64KiB chunk로 읽지만 그 헬퍼는 export돼 있지 않고, 여기서 두 번째 사본을
 * 만들 만큼의 이득이 없다(실행 파일 100MB대). 정말 큰 실행 파일을 승인해야 하면 chunk 읽기로 바꾼다.
 */
function draftExecutable(flagValue: string | undefined, field: string): DraftExecutable {
  if (flagValue === undefined) {
    return { path: sentinel(`executionAuthority.${field}.path`), sha256: sentinel(`executionAuthority.${field}.sha256`) };
  }
  let sha256: string;
  try {
    sha256 = createHash("sha256").update(readFileSync(flagValue)).digest("hex");
  } catch {
    throw new OrchestrationError("draft_executable_unreadable", `--${field} 경로를 읽을 수 없다: ${flagValue}`);
  }
  // **집행 시점과 같은 판정**(절대·정규·비symlink·일반 파일·실행 비트·group/other 쓰기 없음 + 내용 일치).
  // 여기서 통과하지 못하는 경로는 spawn 직전에도 거부되므로, 돌 수 없는 승인을 초안이 지어내지 않는다.
  // 경로를 우리가 realpath로 고쳐 적지 않는다: 그러면 사람이 승인한 대상과 문서에 적힌 대상이 조용히
  // 갈린다. symlink는 거부하고 사람에게 정규 경로를 요구한다(집행기의 계약 그대로다).
  verifyApprovedExecutable({ path: flagValue, sha256 }, `--${field} 실행 파일`, {
    path: "draft_executable_path_invalid",
    invalid: "draft_executable_untrusted",
  });
  return { path: flagValue, sha256 };
}

/** 승인 초안 1건이 담는 task별 write 권위 — `maxBytes`는 sentinel이다. */
interface DraftWriteAuthority {
  authorityId: string;
  kind: "write_file";
  path: string;
  maxBytes: number;
}

/**
 * DAG node 1건 → 그 task의 write 권위 목록. `provides` 경로당 하나이며, 경로는 node가 선언한 것
 * 그대로다(우리가 경로를 짓지 않는다 — 그것이 곧 권능을 짓는 것이다).
 *
 * `maxBytes`는 **sentinel**이다. 기본값(예: `LIMITS.maxWriteBytes`)을 넣는 대안을 기각했다: 그 상수는
 * 검증기가 허용하는 **최댓값**이라 "가장 넓은 쓰기 권한"을 하네스가 조용히 고르는 것이 되고, 그렇다고
 * 임의의 작은 수를 넣으면 근거 없는 권위 값을 지어내는 것이다. 사람이 파일당 상한을 적는다.
 */
function draftAuthorities(node: TaskDagNode): DraftWriteAuthority[] {
  if (node.operations.length > 0 && node.operations.length !== node.provides.length) {
    throw new OrchestrationError(
      "draft_authority_underivable",
      `${node.taskId}: operations ${node.operations.length}건과 provides ${node.provides.length}건의 개수가 달라 ` +
        `어느 authorityId가 어느 경로인지 파생할 수 없다 — DAG의 operations를 지우거나 provides와 개수를 맞춰라`,
    );
  }
  // 둘 다 검증기가 사전순으로 고정한 목록이라 index 짝은 결정론적이다.
  return node.provides.map((path, i) => ({
    authorityId:
      node.operations.length > 0
        ? node.operations[i]
        : assertSlug(`${node.taskId}-w${i + 1}`, `${node.taskId}의 파생 authorityId`),
    kind: "write_file" as const,
    path,
    maxBytes: SENTINEL_NUMBER,
  }));
}

export interface ApprovalDraft {
  draft: Record<string, unknown>;
  /** 사람이 채워야 하는 자리(dotted path) — 초안 자신에서 스캔한 것이다(손으로 적은 목록이 아니다). */
  sentinels: string[];
  /** `authorityId → path` 표(사람이 짝을 확인하고 DAG `operations`에 옮겨 적을 재료). */
  authorityMap: { taskId: string; authorityId: string; path: string }[];
  /** `writableRoots`가 덮어야 하는 경로 전부(중복 제거·사전순). */
  ownedPaths: string[];
  /** DAG가 `operations`를 말하지 않아 **그대로는 아무것도 쓰지 못하는** task들. */
  tasksWithoutOperations: string[];
}

/**
 * **검증된 DAG 문서 → 승인 manifest 초안.** 통과하지 못하는 DAG는 `validateTaskDag`의 코드로 fail closed다.
 *
 * 마지막에 자기 산출물을 `validateApprovalManifest`에 먹인다 — **통과하면 던진다.** 이 한 줄이
 * "초안은 그대로 실행될 수 없다"를 관행이 아니라 집행으로 만든다.
 */
export function buildApprovalDraft(opts: DraftApprovalCliOptions): ApprovalDraft {
  const document = validateTaskDag(readJsonDocument(opts.dag, "invalid_dag_document"));
  const milestoneId = assertSlug(opts.milestone, "--milestone");

  const ownershipByTask: Record<string, string[]> = {};
  const operationAuthorityByTask: Record<string, DraftWriteAuthority[]> = {};
  const authorityMap: ApprovalDraft["authorityMap"] = [];
  const tasksWithoutOperations: string[] = [];
  for (const node of document.tasks) {
    ownershipByTask[node.taskId] = [...node.ownership];
    const authorities = draftAuthorities(node);
    // 권위가 없는 task도 **빈 목록으로 적는다**(생략하지 않는다): "이 task는 아무것도 쓰지 못한다"가
    // 사람 눈에 보여야 한다. 부재와 빈 목록은 집행에서 같은 뜻이지만 검토에서는 다르다.
    operationAuthorityByTask[node.taskId] = authorities;
    for (const a of authorities) authorityMap.push({ taskId: node.taskId, authorityId: a.authorityId, path: a.path });
    if (authorities.length > 0 && node.operations.length === 0) tasksWithoutOperations.push(node.taskId);
  }

  const draft: Record<string, unknown> = {
    milestoneId,
    approvedCommit: sentinel("approvedCommit"),
    // 사람이 쓴다(모듈 docstring의 기각 대안 ⓐⓑ 참조). ownership 경로 전부를 덮어야 한다.
    writableRoots: [sentinel("writableRoots")],
    ownershipByTask,
    // deny 기본값 — "말하지 않은 것은 승인되지 않았다"를 그대로 적은 값이다(조용한 fallback이 아니다).
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      claude: draftExecutable(opts.claude, "claude"),
      // `codex`는 필수 key이면서 `null` 허용이고, `null`이 곧 "이 승인은 codex를 승인하지 않는다"다.
      // 플래그를 만들지 않았다: 이 slice가 겨냥한 경로(plan-dag → claude worker)에 codex가 없고,
      // 필요한 사람은 초안을 열어 record를 적으면 된다(어차피 열어야 하는 파일이다).
      codex: null,
      controllerEntrypoint: draftExecutable(opts.controllerEntrypoint, "controllerEntrypoint"),
      git: draftExecutable(opts.git, "git"),
      node: draftExecutable(opts.node, "node"),
      processObserver: draftExecutable(opts.processObserver, "processObserver"),
    },
    // 시간·횟수는 전부 사람이 정한다(헌법 ①).
    autopilotPolicy: {
      maxTaskAttempts: SENTINEL_NUMBER,
      maxDeliveryAttempts: SENTINEL_NUMBER,
      retryBackoffMs: SENTINEL_NUMBER,
      deliveryDeadlineMs: SENTINEL_NUMBER,
      maxNoProgressMs: SENTINEL_NUMBER,
      maxAttemptElapsedMs: SENTINEL_NUMBER,
      cleanupTermGraceMs: SENTINEL_NUMBER,
      cleanupKillGraceMs: SENTINEL_NUMBER,
    },
    operationAuthorityByTask,
    maxSessions: SENTINEL_NUMBER,
    maxTokens: SENTINEL_NUMBER,
    maxElapsedMs: SENTINEL_NUMBER,
    localMergeAllowed: false,
    expiresAt: sentinel("expiresAt"),
  };

  // **mint 방지 경계 — 관행이 아니라 집행이다.** 초안이 그대로 유효하면 그것은 이 명령이 승인을
  // 발행한 것이므로, 파일을 쓰지 않고 던진다. (sentinel 하나를 지우는 mutation이 여기서 red가 된다.)
  let executable = false;
  try {
    validateApprovalManifest(draft);
    executable = true;
  } catch {
    /* 거부가 정상이다 — 초안은 그대로 실행될 수 없어야 한다. */
  }
  if (executable) {
    throw new OrchestrationError(
      "draft_would_be_executable",
      "산출한 초안이 승인 검증기를 그대로 통과한다 — 이 명령은 실행 가능한 승인을 발행하지 않는다(버그다)",
    );
  }

  const ownedPaths = [...new Set(Object.values(ownershipByTask).flat())].sort();
  return { draft, sentinels: sentinelPaths(draft), authorityMap, ownedPaths, tasksWithoutOperations };
}

/**
 * 값 전체를 훑어 **남은 sentinel의 위치**를 dotted path로 모은다. 손으로 적은 목록이 아니라 파일에서
 * 스캔한 것이라, 초안 모양이 바뀌어도 안내가 따라온다.
 */
export function sentinelPaths(value: unknown, at = ""): string[] {
  if (typeof value === "string") return value.startsWith(SENTINEL_PREFIX) ? [at] : [];
  if (typeof value === "number") return value === SENTINEL_NUMBER ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => sentinelPaths(v, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => sentinelPaths(v, at === "" ? k : `${at}.${k}`));
  }
  return [];
}

/** 출력 파일 이름은 **초안임을 말해야 한다**(헌법 ④) — 이름이 거짓말하는 파일을 만들지 않는다. */
function assertDraftFileName(path: string): string {
  if (!basename(path).toLowerCase().includes(DRAFT_NAME_MARKER)) {
    throw new OrchestrationError(
      "draft_output_name_not_draft",
      `출력 파일 이름에 "${DRAFT_NAME_MARKER}"가 없다: ${basename(path)} — 초안 파일은 이름으로 초안이라고 말해야 한다`,
    );
  }
  return path;
}

/** `harness draft-approval` 명령 본체. 거부는 다른 진입점과 같은 exit 2다. */
export function runDraftApprovalCommand(opts: DraftApprovalCliOptions): void {
  let built: ApprovalDraft;
  let outPath: string;
  try {
    outPath = assertDraftFileName(resolve(opts.out ?? DEFAULT_DRAFT_FILE));
    built = buildApprovalDraft(opts);
    // `wx` — **기존 파일을 덮어쓰지 않는다.** 사람이 sentinel을 채우던 초안을 재실행이 지우는 것이
    // 이 도구의 가장 큰 실질 위험이다(채운 권위 값이 조용히 사라진다).
    // EEXIST는 **예상한 거부**이므로 안정 코드로 바꿔 던진다 — `*_internal_error`(= 버그)로 보이면
    // 정상 거부와 버그가 같은 영수증을 갖게 된다.
    try {
      writeFileSync(outPath, `${JSON.stringify(built.draft, null, 2)}\n`, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      throw new OrchestrationError(
        "draft_output_exists",
        `출력 파일이 이미 있다: ${outPath} — 채우던 초안을 덮어쓰지 않는다. 다른 --out을 쓰거나 그 파일을 직접 치워라`,
      );
    }
  } catch (err) {
    const code = err instanceof OrchestrationError ? err.code : "draft_approval_internal_error";
    process.stdout.write(`[draft-approval] 거부: ${code} — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  const w = (s: string): void => void process.stdout.write(s);
  w(`[draft-approval] 초안을 썼다: ${outPath} · task ${Object.keys(built.draft.ownershipByTask as object).length}건 · ` +
    `write 권위 ${built.authorityMap.length}건\n`);
  w("[draft-approval] **이 파일은 그대로 실행되지 않는다 — 검토 없이 넘기지 마라.** " +
    "아래 자리는 승인의 의미를 정하는 값이라 사람이 채운다:\n");
  for (const p of built.sentinels) w(`  - ${p}\n`);
  w(`[draft-approval] writableRoots는 아래 ownership 경로를 전부 덮어야 한다(최대 ${LIMITS.maxWritableRoots}개):\n`);
  for (const p of built.ownedPaths) w(`  - ${p}\n`);
  w("[draft-approval] 승인한 write 권위(authorityId → path) — 짝이 네 의도와 맞는지 확인해라:\n");
  for (const a of built.authorityMap) w(`  - ${a.taskId}: ${a.authorityId} → ${a.path}\n`);
  if (built.tasksWithoutOperations.length > 0) {
    // 승인만 채워도 돌지 않는 진짜 이유를 여기서 말한다: 지시 축(`assignedOperations`)은 DAG node의
    // `operations`에서만 온다(`materializeTaskDag`). 승인에 권위가 있어도 DAG가 참조하지 않으면
    // 그 task는 아무것도 쓰지 못한다.
    w("[draft-approval] 주의: 아래 task는 DAG node에 `operations`가 없다 — 승인을 채워도 지시에 operation이 " +
      "실리지 않아 **아무 파일도 만들지 못한다.** 위 authorityId를 그 node의 `operations`에 적어라:\n");
    for (const t of built.tasksWithoutOperations) w(`  - ${t}\n`);
  }
  w(`[draft-approval] 다음: 초안을 채운 뒤 harness validate-approval ${outPath} 로 재고, 통과하면 autopilot-create에 넘겨라\n`);
}

/**
 * `harness validate-approval <file>` — 초안이 `validateApprovalManifest`를 지나는지 **읽기 전용**으로
 * 판정한다(`validate-dag`와 대칭). 채워 가며 반복 실행하는 도구다.
 *
 * **남은 sentinel이 있으면 통과시키지 않는다.** 검증기 자체가 우리가 심은 sentinel을 전부 거부하지만,
 * 사람이 sentinel 문자열을 검증기가 허용하는 자리(예: `allowedCommands`)에 옮겨 붙이는 경우까지
 * 닫으려면 스캔이 필요하다 — "REPLACE_ME가 남은 채 통과"는 이 도구가 낼 수 있는 가장 나쁜 영수증이다.
 *
 * **이 명령은 파일을 쓰지 않는다**(import에 쓰기 API가 없다).
 */
export function runValidateApprovalCommand(opts: { file: string }): void {
  const path = resolve(opts.file);
  let raw: unknown;
  try {
    raw = readJsonDocument(opts.file, "invalid_manifest");
  } catch (err) {
    process.stdout.write(`[validate-approval] 불통과: ${err instanceof OrchestrationError ? err.code : "invalid_manifest"} — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  const remaining = sentinelPaths(raw);
  let rejected: string | null = null;
  try {
    validateApprovalManifest(raw);
  } catch (err) {
    rejected = `${err instanceof OrchestrationError ? err.code : "invalid_manifest"} — ${err instanceof Error ? err.message : String(err)}`;
  }
  if (rejected === null && remaining.length === 0) {
    process.stdout.write(`[validate-approval] 통과: ${path}\n`);
    process.stdout.write("[validate-approval] 이것은 승인 문서 계약 판정이다 — DAG와의 대조(ownership·operations)는 autopilot-create에서 한다\n");
    return;
  }
  // 검증기가 먼저 던지면 **하나만** 보이므로, 남은 자리 전부를 함께 낸다(반복 실행의 비용을 줄인다).
  if (rejected !== null) process.stdout.write(`[validate-approval] 불통과: ${rejected}\n`);
  else process.stdout.write("[validate-approval] 불통과: 승인 검증기는 통과했으나 채우지 않은 자리가 남아 있다\n");
  if (remaining.length > 0) {
    process.stdout.write(`[validate-approval] 아직 사람이 채우지 않은 자리 ${remaining.length}건:\n`);
    for (const p of remaining) process.stdout.write(`  - ${p}\n`);
  } else {
    process.stdout.write("[validate-approval] 남은 sentinel은 없다 — 위 사유는 채운 값 자체가 계약을 어긴 것이다\n");
  }
  process.stdout.write(`[validate-approval] 파일은 그대로 남아 있다: ${path}\n`);
  process.exitCode = 2;
}
