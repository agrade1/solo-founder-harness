/**
 * V3 M5a — 프로세스 실행 경계 (유예 대장 `B-5`를 닫는다).
 *
 * M4까지 `manifest.approvedCommit`은 **40자 형태만** 검증됐고 실제 checkout HEAD에 묶이지 않았다.
 * M5는 실제 프로세스를 띄우므로, **모든 provider 프로세스 시작 직전에** 승인된 base와 실제 실행
 * checkout이 같은 커밋인지 확인한다. 어긋나면 `spawn`을 하지 않는다(fail closed).
 *
 * 이 모듈은 **아무것도 실행하지 않는다** — `git rev-parse` 조회만 한다(쓰기·fetch·checkout 없음).
 * git 호출은 항상 인자 배열이며 shell을 경유하지 않는다(명령 주입 표면 없음).
 * provider 중립이라 `CodexCliProvider`와 이후 `ClaudeCliProvider`/controller가 같은 함수를 쓴다.
 * 승인 manifest 규칙을 약화하지 않는다: 검증은 기존 `validateApprovalManifest`를 그대로 통과해야 한다.
 *
 * **경로 계약(2026-07-27 리뷰 반영)**: 입력 경로는 **이미 정규(canonical)** 여야 한다. symlink이거나
 * realpath와 다르면 해석해서 통과시키지 않고 **거부**한다 — 검사 대상과 실행 대상이 갈라지는 창을
 * 애초에 만들지 않기 위해서다. provider는 argv `--cd`와 native spawn cwd 모두에 **여기서 확인한
 * `targetRoot`만** 쓴다(호출자가 준 원본 문자열을 다시 쓰지 않는다).
 *
 * **TOCTOU**: `revalidateSync()`가 spawn **직전 마지막 연산**으로 ⓐ 최종 엔트리 신원(dev+ino, 비-symlink
 * 디렉터리) ⓑ HEAD를 동기로 다시 확인한다. Node 18에는 열린 디렉터리 핸들 상대 실행이 없어 창을
 * **0으로 만들 수는 없다** — 창을 syscall 몇 개로 줄이고 어긋나면 fail closed다(활성 설계의 기존 한계 기록과 동일).
 *
 * 오류 문자열에는 argv·환경변수·프롬프트·transcript를 담지 않는다(경로와 커밋만).
 */
import { lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { validateApprovalManifest } from "./approvalManifest.js";
import { OrchestrationError, type MilestoneApprovalManifest } from "./orchestrationTypes.js";
import { runProcess } from "./runProcess.js";

/** git 조회 상한 — 실행 경계가 프로세스 시작 경로를 무한정 붙잡지 않게 한다. */
const GIT_TIMEOUT_MS = 10_000;

const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface ExecutionBoundaryInput {
  /** 승인 manifest(원본 그대로도 되고 정규화된 것도 된다 — 여기서 다시 closed 검증한다). */
  manifest: unknown;
  /** 판정 계약을 들고 있는 controller checkout 절대·정규 경로. */
  controllerRepoRoot: string;
  /** provider 프로세스의 cwd가 될 실행 checkout 절대·정규 경로. */
  targetWorktree: string;
  /** 만료 판정용 시각(ms). 미지정 시 `Date.now()`. */
  nowMs?: number;
}

/** 최종 엔트리 신원 — 경로 문자열이 아니라 이것으로 "같은 디렉터리인가"를 판정한다. */
interface DirIdentity {
  dev: number;
  ino: number;
}

export interface VerifiedExecutionBoundary {
  manifest: MilestoneApprovalManifest;
  /** 확인된 controller checkout 루트(정규 경로). */
  controllerRoot: string;
  /** 확인된 실행 checkout 루트(정규 경로) — **provider는 이 값만 cwd로 쓴다**. */
  targetRoot: string;
  /** 둘이 같은 checkout이면 true(HEAD 대조를 1회만 한 경우). */
  sameCheckout: boolean;
  approvedCommit: string;
  /**
   * **spawn 직전 마지막 연산**으로 부른다. 신원(dev+ino)과 HEAD를 동기로 재확인하고
   * 어긋나면 던진다 → 호출자는 프로세스를 띄우지 않는다.
   */
  revalidateSync(): void;
}

/** 경로가 절대·NUL 없음·**정규**·비-symlink 디렉터리인지 확인하고 신원을 확보한다. */
function resolveCanonicalDir(raw: unknown, what: string): { path: string; id: DirIdentity } {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
    throw new OrchestrationError("boundary_path_invalid", `${what}는 NUL 없는 절대경로여야 한다`);
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    // symlink 고리·미존재 경로는 판정 불가 = 거부.
    throw new OrchestrationError("boundary_path_unresolvable", `${what}의 realpath를 확인할 수 없다: ${raw}`);
  }
  if (real !== raw) {
    throw new OrchestrationError(
      "boundary_path_not_canonical",
      `${what}는 정규 경로여야 한다(symlink 미해석 원칙): 주어진 ${raw}, realpath ${real}`,
    );
  }
  return { path: real, id: identityOf(real, what) };
}

/** 최종 엔트리를 **따라가지 않고**(lstat) 신원을 읽는다 — symlink는 디렉터리로 인정하지 않는다. */
function identityOf(path: string, what: string): DirIdentity {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new OrchestrationError("boundary_path_unresolvable", `${what}의 상태를 확인할 수 없다: ${path}`);
  }
  if (st.isSymbolicLink()) {
    throw new OrchestrationError("boundary_path_not_canonical", `${what}의 최종 엔트리가 symlink다: ${path}`);
  }
  if (!st.isDirectory()) {
    throw new OrchestrationError("boundary_path_not_directory", `${what}는 디렉터리여야 한다: ${path}`);
  }
  return { dev: st.dev, ino: st.ino };
}

function sameIdentity(a: DirIdentity, b: DirIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function git(cwd: string, args: string[], what: string): Promise<string> {
  let out: { code: number | null; stdout: string };
  try {
    out = await runProcess("git", ["-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  } catch {
    // spawn 실패·타임아웃 — stderr를 오류에 싣지 않는다(경로·인자 노출 최소화).
    throw new OrchestrationError("boundary_git_failed", `${what}의 git ${args[0]} 조회가 실패했다`);
  }
  if (out.code !== 0) {
    throw new OrchestrationError("boundary_git_failed", `${what}의 git ${args[0]}가 비정상 종료했다(code ${out.code})`);
  }
  return out.stdout.trim();
}

/** 동기 HEAD 조회(재검증 전용). shell 미경유 인자 배열. */
function headSync(root: string, what: string): string {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") {
    throw new OrchestrationError("boundary_git_failed", `${what}의 HEAD 재확인이 실패했다`);
  }
  const head = r.stdout.trim();
  if (!COMMIT_RE.test(head)) {
    throw new OrchestrationError("boundary_head_unreadable", `${what}의 HEAD가 40자 커밋이 아니다`);
  }
  return head;
}

/**
 * checkout 루트 신원 + HEAD를 읽는다.
 * `--show-toplevel`을 대조해 ⓐ 하위 디렉터리를 루트로 넘긴 경우 ⓑ 다른 저장소를 가리킨 경우를 거부한다
 * (검사 대상과 실행 대상이 같은 디렉터리여야 한다).
 */
async function readCheckoutHead(root: string, what: string): Promise<string> {
  const toplevel = await git(root, ["rev-parse", "--show-toplevel"], what);
  let topReal: string;
  try {
    topReal = realpathSync(toplevel);
  } catch {
    throw new OrchestrationError("boundary_path_unresolvable", `${what}의 checkout 루트를 확인할 수 없다`);
  }
  if (topReal !== root) {
    throw new OrchestrationError(
      "boundary_not_checkout_root",
      `${what}는 checkout 루트 자신이어야 한다(주어진 경로: ${root}, 실제 루트: ${topReal})`,
    );
  }
  const head = await git(root, ["rev-parse", "HEAD"], what);
  if (!COMMIT_RE.test(head)) {
    throw new OrchestrationError("boundary_head_unreadable", `${what}의 HEAD가 40자 커밋이 아니다`);
  }
  return head;
}

/**
 * **provider 프로세스를 띄우기 직전에 호출한다.** manifest가 유효하고 만료되지 않았으며,
 * controller checkout과 실행 checkout의 HEAD가 **정확히** `approvedCommit`일 때만 통과한다.
 * 둘이 같은 checkout이면 대조 1회로 충분하고, 다르면 양쪽 다 맞아야 한다.
 * 반환된 `revalidateSync()`를 **spawn 직전 마지막으로** 부르는 것까지가 이 계약이다.
 */
export async function verifyExecutionBoundary(input: ExecutionBoundaryInput): Promise<VerifiedExecutionBoundary> {
  const manifest = validateApprovalManifest(input.manifest);

  // 만료 경계는 포함이다(`now >= expiresAt`이면 거부) — 실행 경계는 kernel보다 좁게 잡는다(대장 `C-17`).
  const now = input.nowMs ?? Date.now();
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
    throw new OrchestrationError("manifest_expired", `승인 manifest가 만료됐다(expiresAt ${manifest.expiresAt})`);
  }

  const controller = resolveCanonicalDir(input.controllerRepoRoot, "controllerRepoRoot");
  const target = resolveCanonicalDir(input.targetWorktree, "targetWorktree");
  const sameCheckout = controller.path === target.path;

  const controllerHead = await readCheckoutHead(controller.path, "controller checkout");
  if (controllerHead !== manifest.approvedCommit) {
    throw new OrchestrationError(
      "approved_commit_mismatch",
      `controller checkout HEAD(${controllerHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`,
    );
  }
  if (!sameCheckout) {
    const targetHead = await readCheckoutHead(target.path, "실행 checkout");
    if (targetHead !== manifest.approvedCommit) {
      throw new OrchestrationError(
        "approved_commit_mismatch",
        `실행 checkout HEAD(${targetHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`,
      );
    }
  }

  const revalidateSync = (): void => {
    const roots: Array<[string, DirIdentity, string]> = sameCheckout
      ? [[controller.path, controller.id, "실행 checkout"]]
      : [
          [controller.path, controller.id, "controller checkout"],
          [target.path, target.id, "실행 checkout"],
        ];
    for (const [path, id, what] of roots) {
      const now2 = identityOf(path, what); // symlink로 바뀌었으면 여기서 거부된다
      if (!sameIdentity(now2, id)) {
        throw new OrchestrationError("boundary_identity_changed", `${what}의 디렉터리 신원이 검증 이후 바뀌었다: ${path}`);
      }
      const head = headSync(path, what);
      if (head !== manifest.approvedCommit) {
        throw new OrchestrationError(
          "approved_commit_mismatch",
          `${what} HEAD(${head})가 승인된 커밋(${manifest.approvedCommit})이 아니다(spawn 직전 재확인)`,
        );
      }
    }
  };

  return {
    manifest,
    controllerRoot: controller.path,
    targetRoot: target.path,
    sameCheckout,
    approvedCommit: manifest.approvedCommit,
    revalidateSync,
  };
}
