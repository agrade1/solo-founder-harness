/**
 * V3 M5a — 프로세스 실행 경계 (유예 대장 `B-5`를 닫는다).
 *
 * M4까지 `manifest.approvedCommit`은 **40자 형태만** 검증됐고 실제 checkout HEAD에 묶이지 않았다.
 * M5는 실제 프로세스를 띄우므로, **모든 provider 프로세스 시작 직전에** 승인된 base와 실제 실행
 * checkout이 같은 커밋인지 확인한다. 어긋나면 `spawn`을 하지 않는다(fail closed).
 *
 * 이 모듈은 **아무것도 실행하지 않는다** — `git rev-parse` 조회만 한다(쓰기·fetch·checkout 없음).
 * provider 중립이라 `CodexCliProvider`와 이후 `ClaudeCliProvider`/controller가 같은 함수를 쓴다.
 * 승인 manifest 규칙을 약화하지 않는다: 검증은 기존 `validateApprovalManifest`를 그대로 통과해야 한다.
 *
 * 오류 문자열에는 argv·환경변수·프롬프트·transcript를 담지 않는다(경로와 커밋만).
 */
import { realpathSync, statSync } from "node:fs";
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
  /** 판정 계약을 들고 있는 controller checkout 절대경로. */
  controllerRepoRoot: string;
  /** provider 프로세스의 cwd가 될 실행 checkout 절대경로. */
  targetWorktree: string;
  /** 만료 판정용 시각(ms). 미지정 시 `Date.now()`. */
  nowMs?: number;
}

export interface VerifiedExecutionBoundary {
  manifest: MilestoneApprovalManifest;
  /** realpath로 정규화된 controller checkout 루트. */
  controllerRoot: string;
  /** realpath로 정규화된 실행 checkout 루트(= provider cwd). */
  targetRoot: string;
  /** 둘이 같은 checkout이면 true(HEAD 대조를 1회만 한 경우). */
  sameCheckout: boolean;
  approvedCommit: string;
}

/** 경로를 realpath로 정규화하고 그 자리가 git checkout **루트**임을 확인한다. */
function resolveCheckoutRoot(raw: unknown, what: string): string {
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
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    throw new OrchestrationError("boundary_path_unresolvable", `${what}의 상태를 확인할 수 없다: ${raw}`);
  }
  if (!isDir) throw new OrchestrationError("boundary_path_not_directory", `${what}는 디렉터리여야 한다: ${raw}`);
  return real;
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

/**
 * checkout 루트 신원 + HEAD를 읽는다.
 * `--show-toplevel`을 realpath로 대조해 ⓐ 하위 디렉터리를 루트로 넘긴 경우 ⓑ symlink로 다른
 * 저장소를 가리킨 경우를 모두 거부한다(검사 대상과 실행 대상이 같은 디렉터리여야 한다).
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
 */
export async function verifyExecutionBoundary(input: ExecutionBoundaryInput): Promise<VerifiedExecutionBoundary> {
  const manifest = validateApprovalManifest(input.manifest);

  // 만료 경계는 포함이다(`now >= expiresAt`이면 거부) — 실행 경계는 kernel보다 좁게 잡는다(대장 `C-17`).
  const now = input.nowMs ?? Date.now();
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
    throw new OrchestrationError("manifest_expired", `승인 manifest가 만료됐다(expiresAt ${manifest.expiresAt})`);
  }

  const controllerRoot = resolveCheckoutRoot(input.controllerRepoRoot, "controllerRepoRoot");
  const targetRoot = resolveCheckoutRoot(input.targetWorktree, "targetWorktree");
  const sameCheckout = controllerRoot === targetRoot;

  const controllerHead = await readCheckoutHead(controllerRoot, "controller checkout");
  if (controllerHead !== manifest.approvedCommit) {
    throw new OrchestrationError(
      "approved_commit_mismatch",
      `controller checkout HEAD(${controllerHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`,
    );
  }
  if (!sameCheckout) {
    const targetHead = await readCheckoutHead(targetRoot, "실행 checkout");
    if (targetHead !== manifest.approvedCommit) {
      throw new OrchestrationError(
        "approved_commit_mismatch",
        `실행 checkout HEAD(${targetHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`,
      );
    }
  }

  return { manifest, controllerRoot, targetRoot, sameCheckout, approvedCommit: manifest.approvedCommit };
}
