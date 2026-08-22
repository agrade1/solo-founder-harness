/**
 * V3 M5a — 프로세스 실행 경계 (유예 대장 `B-5`를 닫는다).
 *
 * M4까지 `manifest.approvedCommit`은 **40자 형태만** 검증됐고 실제 checkout HEAD에 묶이지 않았다.
 * M5는 실제 프로세스를 띄우므로, **모든 provider 프로세스 시작 직전에** 승인된 base와 실제 실행
 * checkout이 같은 커밋인지 확인한다. 어긋나면 `spawn`을 하지 않는다(fail closed).
 *
 * 이 모듈은 **아무것도 실행하지 않는다** — `git rev-parse` 조회만 한다(쓰기·fetch·checkout 없음).
 * git 호출은 항상 인자 배열이며 shell을 경유하지 않는다(명령 주입 표면 없음).
 *
 * **git 자체가 신뢰 대상이다(2026-07-27 3차 리비전 · 독립 리뷰 A/P1)**: 이전 판은 `git`을 **이름으로**
 * 부르고 `runProcess`가 `process.env`를 상속했다 → 적대적 `PATH`가 다른 실행 파일을, `GIT_DIR`/
 * `GIT_WORK_TREE`/`GIT_*`가 **다른 저장소·커밋을** 증명하게 만들 수 있었다. 이제 ⓐ **승인 manifest가
 * 지정한** 절대·정규 비-symlink 일반 실행 파일(group/other 쓰기 없음)만 열고 ⓑ 그 경로로만 부르며
 * ⓒ 자식 env는 **최소 결정론적 화이트리스트**다(PATH·HOME·상속 `GIT_*`·자격증명·설정 경로 0,
 * system/global config는 사용자 상태를 읽지 않고 끈다) ⓓ git 실행 파일 **신원(dev+ino)과 승인된
 * 내용 digest**를 고정해 spawn 직전 동기 게이트에서 다시 확인한다.
 *
 * **실행 권위는 호출자가 고르지 않는다(V3 M5b 6차 독립 리뷰 A1).** 이전 판은 `gitExecutablePath`를
 * 호출자 입력으로 받았고 신원이 path/dev/ino뿐이었다 → ⓐ provider와 controller에 **같은 임의 경로**를
 * 주면 양쪽이 같은 값을 관측해 "권위 일치"가 됐고 ⓑ 같은 inode를 **제자리에서 덮어쓰면** 검증을
 * 그대로 통과했다. 지금 git 경로·내용 digest는 **승인 manifest(`executionAuthority.git`)** 에서만
 * 오고(`ExecutionBoundaryInput`에 경로 필드가 없다) **git 프로세스 하나하나가** 자기 spawn 직전에
 * 내용 digest를 다시 대조한다.
 * provider 중립이라 `CodexCliProvider`와 이후 `ClaudeCliProvider`/controller가 같은 함수를 쓴다.
 * 승인 manifest 규칙을 약화하지 않는다: 검증은 기존 `validateApprovalManifest`를 그대로 통과해야 한다.
 *
 * **검증은 프로세스 1회가 아니라 spawn 1회 단위다(V3 M5b 7차 독립 리뷰 A1).** 이전 판은 경계 진입에서
 * 한 번 해싱하고 `readCheckoutHead()`가 `--show-toplevel`·`rev-parse HEAD` **두 자식 프로세스**를 각각
 * await했다 → 첫 프로세스를 기다리는 동안 owner-writable 승인 파일이 **같은 inode를 제자리에서
 * 덮어쓰면** 두 번째 프로세스가 승인되지 않은 바이트를 실행했다(기대 HEAD를 출력하고 원 바이트를
 * 되돌릴 수 있으므로 뒤 검사도 통과한다). `revalidateSync()`의 checkout 루프도 같았다. 지금은 **모든
 * git spawn이 자기 `runProcess`/`spawnSync` 직전에** `gitGate()`(같은 fd 신원 + 승인 digest)를 지나고
 * 그 사이에 **`await`가 없다** — 남는 창은 아래 TOCTOU 절의 syscall 몇 개짜리 fd→exec 창뿐이다.
 *
 * **경로 계약(2026-07-27 리뷰 반영)**: 입력 경로는 **이미 정규(canonical)** 여야 한다. symlink이거나
 * realpath와 다르면 해석해서 통과시키지 않고 **거부**한다 — 검사 대상과 실행 대상이 갈라지는 창을
 * 애초에 만들지 않기 위해서다. provider는 argv `--cd`와 native spawn cwd 모두에 **여기서 확인한
 * `targetRoot`만** 쓴다(호출자가 준 원본 문자열을 다시 쓰지 않는다).
 *
 * **TOCTOU**: `revalidateSync()`가 spawn **직전 동기 게이트**에서 ⓐ 승인 만료(`now >= expiresAt`)
 * ⓑ 최종 엔트리 신원(dev+ino, 비-symlink 디렉터리) ⓒ git 실행 파일 신원·승인 digest ⓓ HEAD를 동기로 다시 확인한다. 만료를 두 번 보는 이유는
 * 첫 검사와 spawn 사이에 **비동기 git 조회**가 있어 그 사이에 승인이 만료될 수 있기 때문이다
 * (`nowMs`에 함수를 주면 clock으로 취급해 재검증에서 다시 읽는다). Node 18에는 열린 디렉터리 핸들 상대 실행이 없어 창을
 * **0으로 만들 수는 없다** — 창을 syscall 몇 개로 줄이고 어긋나면 fail closed다(활성 설계의 기존 한계 기록과 동일).
 * 남는 창의 **정확한 크기**: 실행 파일을 해싱한 fd를 닫고 `spawn`/`spawnSync`를 부르기까지의 syscall
 * 몇 개다(Node에 `fexecve`가 없어 "해싱한 fd를 그대로 exec"할 수 없다 — 대장 `C-5`와 같은 종류). 7차
 * 리뷰 A1이 지적한 **자식 프로세스 하나의 수명만큼 넓은 창**은 spawn별 게이트로 제거했다.
 *
 * 오류 문자열에는 argv·환경변수·프롬프트·transcript를 담지 않는다(경로와 커밋만).
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { validateApprovalManifest } from "./approvalManifest.js";
import { OrchestrationError, type ApprovedExecutable, type MilestoneApprovalManifest } from "./orchestrationTypes.js";
import { runProcess } from "./runProcess.js";

/** git 조회 상한 — 실행 경계가 프로세스 시작 경로를 무한정 붙잡지 않게 한다. */
const GIT_TIMEOUT_MS = 10_000;

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * git 자식에게 주는 **전부**. 상속하지 않는다 — `PATH`·`HOME`·`GIT_DIR`·`GIT_WORK_TREE`·`GIT_*`·
 * 자격증명·프록시·설정 경로가 이 경계의 판정에 끼어들 통로가 없다.
 * `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL`은 **사용자 상태를 읽지 않고** system/global config를 끈다.
 * (`GIT_CONFIG_GLOBAL=/dev/null`은 git ≥ 2.32. 그 아래에서는 `HOME` 부재가 같은 역할을 한다.)
 */
export const GIT_SANITIZED_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});

/** 실행 파일·디렉터리 공통 신원 — 경로 문자열이 아니라 이것으로 "같은 실체인가"를 판정한다. */
export interface FileIdentity {
  dev: number;
  ino: number;
}

/** 검증된 신뢰 실행 파일: 정규 경로 + 그때 확보한 신원. */
export interface TrustedExecutable {
  path: string;
  id: FileIdentity;
}

/** 오류 코드 집합 — 같은 검증을 provider(codex)와 경계(git)가 각자의 코드로 보고한다. */
export interface ExecutableCodes {
  /** 경로 계약 위반(절대·NUL 없음). */
  path: string;
  /** 신뢰 조건 위반(정규·비symlink·일반 파일·실행 비트·타인 쓰기 금지). */
  invalid: string;
  /** 고정된 신원과 달라짐(교체). 미지정이면 `invalid`를 쓴다. */
  identity?: string;
  /** 승인된 내용 digest와 다름(같은 inode 제자리 덮어쓰기 포함). 미지정이면 `invalid`를 쓴다. */
  digest?: string;
}

/** 내용 digest 계산용 chunk(고정 64KiB — 큰 실행 파일도 메모리 상한 안에서 읽는다). */
const HASH_CHUNK_BYTES = 65_536;
/** 실행 파일 크기 상한. 이보다 큰 파일은 승인 대조 대상으로 읽지 않는다(fail closed). */
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

const O_NOFOLLOW_SUPPORTED = typeof fsConstants.O_NOFOLLOW === "number";

/**
 * **승인된 실행 파일 검증**(V3 M5b 6차 독립 리뷰 A1). 승인 record(`manifest.executionAuthority.*`)의
 * 경로를 **한 번만 열고**(`O_RDONLY|O_NOFOLLOW`) 같은 fd에서 신원·권한·내용을 전부 판정한다:
 * 정규 경로 · symlink 아님 · 일반 파일 · 실행 비트 · group/other 쓰기 없음 · `pinned` 신원(dev+ino) ·
 * 그리고 **승인된 내용 SHA-256과 정확히 일치**.
 *
 * 내용까지 보는 이유: path/dev/ino는 **같은 inode를 제자리에서 덮어쓰는** 교체를 잡지 못한다
 * (6차 리뷰 A1 — 그 창으로 승인된 이름 뒤에 다른 프로그램을 넣을 수 있었다). digest는 그 창을 닫는다.
 * 검사–사용 경합을 줄이기 위해 **경로를 한 번만 열고**(검사와 읽기가 같은 fd) spawn 직전에 다시 부른다.
 *
 * ponytail: spawn마다 실행 파일 전체를 해싱한다(파일 크기에 비례하는 고정 비용). Node에 `fexecve`가
 * 없어 "해싱한 fd를 그대로 exec"할 수 없으므로 창이 0이라고 주장하지 않는다 — 상향 경로는 열린 fd 상대
 * 실행을 지원하는 런타임이며 별도 승인 범위다(대장 `C-5`와 같은 종류의 한계).
 */
export function verifyApprovedExecutable(
  approved: ApprovedExecutable,
  what: string,
  codes: ExecutableCodes,
  pinned?: FileIdentity,
): TrustedExecutable {
  const raw = approved?.path;
  const wantDigest = approved?.sha256;
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
    throw new OrchestrationError(codes.path, `${what}는 NUL 없는 절대경로여야 한다`);
  }
  if (typeof wantDigest !== "string" || !/^[0-9a-f]{64}$/.test(wantDigest)) {
    throw new OrchestrationError(codes.path, `${what}의 승인된 내용 digest가 없다`);
  }
  if (!O_NOFOLLOW_SUPPORTED) {
    throw new OrchestrationError(codes.invalid, `${what}: 이 플랫폼은 O_NOFOLLOW를 지원하지 않는다`);
  }
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new OrchestrationError(codes.invalid, `${what}의 realpath를 확인할 수 없다`);
  }
  if (real !== raw) throw new OrchestrationError(codes.invalid, `${what}는 정규 경로여야 한다(symlink 미해석)`);

  let fd: number;
  try {
    fd = openSync(raw, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new OrchestrationError(codes.invalid, `${what}를 열 수 없다(symlink·부재·권한)`);
  }
  let id: FileIdentity;
  let digest: string;
  try {
    let st: ReturnType<typeof fstatSync>;
    try {
      st = fstatSync(fd);
    } catch {
      throw new OrchestrationError(codes.invalid, `${what}의 상태를 확인할 수 없다`);
    }
    if (!st.isFile()) throw new OrchestrationError(codes.invalid, `${what}는 symlink 아닌 일반 파일이어야 한다`);
    if ((st.mode & 0o111) === 0) throw new OrchestrationError(codes.invalid, `${what}에 실행 비트가 없다`);
    if ((st.mode & 0o022) !== 0) throw new OrchestrationError(codes.invalid, `${what}가 group/other 쓰기 가능이다`);
    if (st.size > MAX_EXECUTABLE_BYTES) throw new OrchestrationError(codes.invalid, `${what}가 상한보다 크다`);
    id = { dev: st.dev, ino: st.ino };
    if (pinned && (pinned.dev !== id.dev || pinned.ino !== id.ino)) {
      throw new OrchestrationError(codes.identity ?? codes.invalid, `${what}의 실행 파일 신원이 검증 이후 바뀌었다`);
    }
    digest = digestOfFd(fd, what, codes);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 정리 실패도 실패다(활성 계약 ⑥) — 원 오류가 있으면 그것이 우선한다.
      throw new OrchestrationError(codes.invalid, `${what}의 fd를 닫을 수 없다`);
    }
  }
  if (digest !== wantDigest) {
    throw new OrchestrationError(codes.digest ?? codes.invalid, `${what}의 내용이 승인된 digest와 다르다`);
  }
  return { path: raw, id };
}

/** 열린 fd에서 내용 digest를 읽는다(고정 chunk — 파일 전체를 메모리에 담지 않는다). */
function digestOfFd(fd: number, what: string, codes: ExecutableCodes): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let offset = 0;
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buf, 0, buf.length, offset);
    } catch {
      throw new OrchestrationError(codes.invalid, `${what}의 내용을 읽을 수 없다`);
    }
    if (read <= 0) break;
    hash.update(buf.subarray(0, read));
    offset += read;
    if (offset > MAX_EXECUTABLE_BYTES) throw new OrchestrationError(codes.invalid, `${what}가 상한보다 크다`);
  }
  return hash.digest("hex");
}

const GIT_CODES: ExecutableCodes = {
  path: "boundary_git_path_invalid",
  invalid: "boundary_git_untrusted",
  identity: "boundary_git_identity_changed",
  digest: "boundary_git_digest_mismatch",
};

export interface ExecutionBoundaryInput {
  /** 승인 manifest(원본 그대로도 되고 정규화된 것도 된다 — 여기서 다시 closed 검증한다). */
  manifest: unknown;
  /** 판정 계약을 들고 있는 controller checkout 절대·정규 경로. */
  controllerRepoRoot: string;
  /** provider 프로세스의 cwd가 될 실행 checkout 절대·정규 경로. */
  targetWorktree: string;
  /**
   * **호출자가 더 이른 시점에 고정한 git 실행 파일 신원(dev+ino)**. 주면 경계 진입에서부터 그 신원과
   * 같은지 확인한다(V3 M5b 5차 리뷰 A1) — 증명·생성 시점 이후 같은 경로가 다른 실행 파일로 교체되면
   * 승인 커밋을 증명하지 못한다. 미지정이면 경계가 진입 시점 신원을 자기 기준으로 고정한다.
   *
   * **git 실행 파일 자체는 호출자가 고르지 않는다(6차 리뷰 A1)**: 경로·내용 digest는
   * `manifest.executionAuthority.git`에서만 온다.
   */
  gitIdentity?: FileIdentity;
  /**
   * 만료 판정용 시각. **함수를 주면 clock으로 취급해 재검증에서 다시 읽는다**(비동기 git 조회 중에
   * 승인이 만료되는 창을 닫는다). 숫자를 주면 그 시각으로 고정하고, 미지정이면 `Date.now`다.
   */
  nowMs?: number | (() => number);
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
   * **spawn 직전 동기 게이트의 일부**로 부른다(호출자는 여기에 자기 신뢰 자산 재확인을 이어 붙인다).
   * 승인 만료 · checkout 디렉터리 신원(dev+ino) · **HEAD 조회 spawn마다** git 실행 파일 신원·승인
   * 내용 digest · HEAD를 **동기로** 재확인하고 어긋나면 던진다 → 호출자는 프로세스를 띄우지 않는다.
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

/** 숫자는 고정 시각, 함수는 clock, 미지정은 `Date.now`. */
function clockOf(nowMs: ExecutionBoundaryInput["nowMs"]): () => number {
  if (typeof nowMs === "function") return nowMs;
  if (typeof nowMs === "number") return () => nowMs;
  return Date.now;
}

/**
 * 만료 판정(경계 포함 — `now >= expiresAt`면 거부). 읽을 수 없는 시각·만료 시각은 **거부**다(fail closed).
 * 실행 경계는 kernel보다 좁게 잡는다(대장 `C-17`). 경계 진입과 **spawn 직전 재검증에서 각각** 부른다.
 */
function assertNotExpired(manifest: MilestoneApprovalManifest, now: number, when: string): void {
  const expiresAtMs = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
    throw new OrchestrationError("manifest_expired", `승인 manifest가 만료됐다(expiresAt ${manifest.expiresAt}, ${when})`);
  }
}

/**
 * **spawn 직전 동기 게이트**(7차 리뷰 A1). 부르면 승인 record를 같은 fd로 다시 열어 신원(dev+ino)과
 * 승인된 내용 SHA-256을 증명하고 실행할 경로를 돌려준다. 반환과 `spawn` 사이에 **`await`를 두지 않는
 * 것**이 이 타입의 계약이다 — 그래야 창이 자식 프로세스 수명이 아니라 fd→exec syscall 몇 개로 남는다.
 */
type GitGate = () => string;

async function git(gate: GitGate, cwd: string, args: string[], what: string): Promise<string> {
  // 이 spawn의 바이트를 이 spawn 직전에 증명한다(아래 `runProcess`까지 `await` 없음 — `runProcess`는
  // Promise executor 안에서 동기로 `spawn`한다). 게이트 실패는 `boundary_git_failed`로 접지 않는다.
  const gitPath = gate();
  let out: { code: number | null; stdout: string };
  try {
    // 신뢰된 절대경로 + 상속 없는 최소 env. 저장소는 `-C cwd`만으로 결정된다.
    out = await runProcess(gitPath, ["-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS, env: { ...GIT_SANITIZED_ENV } });
  } catch {
    // spawn 실패·타임아웃 — stderr를 오류에 싣지 않는다(경로·인자 노출 최소화).
    throw new OrchestrationError("boundary_git_failed", `${what}의 git ${args[0]} 조회가 실패했다`);
  }
  if (out.code !== 0) {
    throw new OrchestrationError("boundary_git_failed", `${what}의 git ${args[0]}가 비정상 종료했다(code ${out.code})`);
  }
  return out.stdout.trim();
}

/** 동기 HEAD 조회(재검증 전용). **spawn 직전 게이트** · 상속 없는 env · shell 미경유 인자 배열. */
function headSync(gate: GitGate, root: string, what: string): string {
  // checkout 루프의 **매 회차**가 자기 spawn 직전에 증명한다(7차 리뷰 A1) — 루프 앞 1회로는 앞 회차의
  // 자식 프로세스가 도는 동안의 제자리 덮어쓰기를 막을 수 없다.
  const gitPath = gate();
  const r = spawnSync(gitPath, ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...GIT_SANITIZED_ENV },
  });
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
 *
 * **대조는 경로 문자열이 아니라 디렉터리 신원(dev+ino)이다**(대장 `B-33` · V3 M10 T6).
 * 이전 판은 `realpathSync(toplevel) !== root`를 문자열로 봤는데, macOS에서 git은 `--show-toplevel`을
 * **NFD**(Hangul Jamo 분해)로 내놓고 `realpath`는 받은 형태를 보존한다 → 한글 경로를 NFC로 넘기면
 * **같은 디렉터리인데도** `boundary_not_checkout_root`가 됐다(비-ASCII 경로 프로젝트에서 v3가 시작조차
 * 못 했다 — M10 T5 도그푸딩 실측). 정규형을 통일하는 방향은 **택하지 않았다**: 어느 정규형이 "정본"인지
 * 는 파일 시스템마다 다르고(APFS는 정규형 무관, 다른 fs는 바이트 보존) 그 판단을 여기서 하면 승인된
 * 경로의 바이트 규율(`C-40`·고립 surrogate 계약)과 두 개의 진실이 생긴다. **dev+ino는 커널이 답하는
 * 하나의 진실**이고, `revalidateSync()`가 이미 같은 기계로 재검증한다(두 번째 방식을 만들지 않는다).
 *
 * 보안 성질은 그대로다: 하위 디렉터리·다른 저장소·다른 실체로 바뀐 디렉터리는 ino가 다르므로 여전히
 * 거부되고, `identityOf`가 최종 엔트리 symlink·비디렉터리를 함께 거부한다.
 */
async function readCheckoutHead(gate: GitGate, root: { path: string; id: DirIdentity }, what: string): Promise<string> {
  const toplevel = await git(gate, root.path, ["rev-parse", "--show-toplevel"], what);
  let topReal: string;
  try {
    topReal = realpathSync(toplevel);
  } catch {
    throw new OrchestrationError("boundary_path_unresolvable", `${what}의 checkout 루트를 확인할 수 없다`);
  }
  if (!sameIdentity(identityOf(topReal, `${what}의 checkout 루트`), root.id)) {
    throw new OrchestrationError(
      "boundary_not_checkout_root",
      `${what}는 checkout 루트 자신이어야 한다(주어진 경로: ${root.path}, 실제 루트: ${topReal} — 디렉터리 신원 불일치)`,
    );
  }
  // 두 번째 프로세스도 **자기** 게이트를 지난다: 위 `await` 동안 승인 파일이 제자리에서 바뀔 수 있다.
  const head = await git(gate, root.path, ["rev-parse", "HEAD"], what);
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

  const clock = clockOf(input.nowMs);
  assertNotExpired(manifest, clock(), "경계 진입");

  // 증명 도구부터 신뢰한다: **승인 manifest가 지정한** 경로 하나를 열고 내용 digest까지 대조한다
  // (이름 조회·호출자 경로 없음 — 6차 리뷰 A1). 신원은 호출자가 더 이른 시점에 고정했다면 그 값과
  // 대조하고(교체 거부) 아니면 여기서 고정한다.
  const gitBin = verifyApprovedExecutable(manifest.executionAuthority.git, "승인된 git 실행 파일", GIT_CODES, input.gitIdentity);
  // **모든** git spawn이 자기 프로세스를 시작하기 직전에 이 게이트를 지난다(7차 리뷰 A1).
  const gitGate: GitGate = () =>
    verifyApprovedExecutable(manifest.executionAuthority.git, "승인된 git 실행 파일", GIT_CODES, gitBin.id).path;

  const controller = resolveCanonicalDir(input.controllerRepoRoot, "controllerRepoRoot");
  const target = resolveCanonicalDir(input.targetWorktree, "targetWorktree");
  const sameCheckout = controller.path === target.path;

  const controllerHead = await readCheckoutHead(gitGate, controller, "controller checkout");
  if (controllerHead !== manifest.approvedCommit) {
    throw new OrchestrationError(
      "approved_commit_mismatch",
      `controller checkout HEAD(${controllerHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`,
    );
  }
  if (!sameCheckout) {
    const targetHead = await readCheckoutHead(gitGate, target, "실행 checkout");
    if (targetHead !== manifest.approvedCommit) {
      throw new OrchestrationError(
        "approved_commit_mismatch",
        `실행 checkout HEAD(${targetHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`,
      );
    }
  }

  const revalidateSync = (): void => {
    // 승인 만료를 **여기서 다시** 본다: 위 만료 검사와 이 지점 사이에 비동기 git 조회가 있어
    // 그 사이에 승인이 만료될 수 있다. 만료된 승인으로는 프로세스를 띄우지 않는다.
    assertNotExpired(manifest, clock(), "spawn 직전 재확인");
    // 증명 도구 검증은 **루프 앞 1회가 아니라** 아래 `headSync`의 spawn별 게이트가 한다(7차 리뷰 A1):
    // 앞 회차의 `spawnSync`가 도는 동안에도 승인 파일이 제자리에서 바뀔 수 있으므로, 회차마다
    // 자기 spawn 직전에 신원 + **승인된 내용 digest**를 다시 증명해야 한다.
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
      const head = headSync(gitGate, path, what);
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
