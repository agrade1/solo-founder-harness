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
 * `GIT_WORK_TREE`/`GIT_*`가 **다른 저장소·커밋을** 증명하게 만들 수 있었다. 이제 ⓐ **신뢰된 절대·정규
 * 비-symlink 일반 실행 파일 경로**(group/other 쓰기 없음)를 **필수 입력**으로 받고 ⓑ 그 경로로만 부르며
 * ⓒ 자식 env는 **최소 결정론적 화이트리스트**다(PATH·HOME·상속 `GIT_*`·자격증명·설정 경로 0,
 * system/global config는 사용자 상태를 읽지 않고 끈다) ⓓ git 실행 파일 **신원(dev+ino)** 을 고정해
 * spawn 직전 동기 게이트에서 다시 확인한다.
 * provider 중립이라 `CodexCliProvider`와 이후 `ClaudeCliProvider`/controller가 같은 함수를 쓴다.
 * 승인 manifest 규칙을 약화하지 않는다: 검증은 기존 `validateApprovalManifest`를 그대로 통과해야 한다.
 *
 * **경로 계약(2026-07-27 리뷰 반영)**: 입력 경로는 **이미 정규(canonical)** 여야 한다. symlink이거나
 * realpath와 다르면 해석해서 통과시키지 않고 **거부**한다 — 검사 대상과 실행 대상이 갈라지는 창을
 * 애초에 만들지 않기 위해서다. provider는 argv `--cd`와 native spawn cwd 모두에 **여기서 확인한
 * `targetRoot`만** 쓴다(호출자가 준 원본 문자열을 다시 쓰지 않는다).
 *
 * **TOCTOU**: `revalidateSync()`가 spawn **직전 동기 게이트**에서 ⓐ 승인 만료(`now >= expiresAt`)
 * ⓑ git 실행 파일 신원 ⓒ 최종 엔트리 신원(dev+ino, 비-symlink 디렉터리) ⓓ HEAD를 동기로 다시 확인한다. 만료를 두 번 보는 이유는
 * 첫 검사와 spawn 사이에 **비동기 git 조회**가 있어 그 사이에 승인이 만료될 수 있기 때문이다
 * (`nowMs`에 함수를 주면 clock으로 취급해 재검증에서 다시 읽는다). Node 18에는 열린 디렉터리 핸들 상대 실행이 없어 창을
 * **0으로 만들 수는 없다** — 창을 syscall 몇 개로 줄이고 어긋나면 fail closed다(활성 설계의 기존 한계 기록과 동일).
 *
 * 오류 문자열에는 argv·환경변수·프롬프트·transcript를 담지 않는다(경로와 커밋만).
 */
import { lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { validateApprovalManifest } from "./approvalManifest.js";
import { OrchestrationError } from "./orchestrationTypes.js";
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
export const GIT_SANITIZED_ENV = Object.freeze({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
});
/**
 * 신뢰된 실행 파일 검증 — **정규 경로 · symlink 아님 · 일반 파일 · 실행 비트 있음 · group/other 쓰기 없음**,
 * 그리고 `pinned`를 주면 **신원(dev+ino)** 까지 같아야 한다.
 *
 * 신원을 보는 이유(2026-07-27 3차 리비전): 경로·mode만 보면 검사와 spawn 사이에 **같은 권한의 다른
 * 실행 파일로 교체**되는 창이 남는다. Node에는 열린 fd 상대 실행(`fexecve`)이 없어 창을 **0으로 만들
 * 수는 없고**, syscall 몇 개로 줄이고 어긋나면 fail closed다.
 */
export function verifyTrustedExecutable(raw, what, codes, pinned) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
        throw new OrchestrationError(codes.path, `${what}는 NUL 없는 절대경로여야 한다`);
    }
    let real;
    try {
        real = realpathSync(raw);
    }
    catch {
        throw new OrchestrationError(codes.invalid, `${what}의 realpath를 확인할 수 없다`);
    }
    if (real !== raw)
        throw new OrchestrationError(codes.invalid, `${what}는 정규 경로여야 한다(symlink 미해석)`);
    let st;
    try {
        st = lstatSync(raw);
    }
    catch {
        throw new OrchestrationError(codes.invalid, `${what}의 상태를 확인할 수 없다`);
    }
    if (st.isSymbolicLink() || !st.isFile()) {
        throw new OrchestrationError(codes.invalid, `${what}는 symlink 아닌 일반 파일이어야 한다`);
    }
    if ((st.mode & 0o111) === 0)
        throw new OrchestrationError(codes.invalid, `${what}에 실행 비트가 없다`);
    if ((st.mode & 0o022) !== 0)
        throw new OrchestrationError(codes.invalid, `${what}가 group/other 쓰기 가능이다`);
    const id = { dev: st.dev, ino: st.ino };
    if (pinned && (pinned.dev !== id.dev || pinned.ino !== id.ino)) {
        throw new OrchestrationError(codes.identity ?? codes.invalid, `${what}의 실행 파일 신원이 검증 이후 바뀌었다`);
    }
    return { path: raw, id };
}
const GIT_CODES = {
    path: "boundary_git_path_invalid",
    invalid: "boundary_git_untrusted",
    identity: "boundary_git_identity_changed",
};
/** 경로가 절대·NUL 없음·**정규**·비-symlink 디렉터리인지 확인하고 신원을 확보한다. */
function resolveCanonicalDir(raw, what) {
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
        throw new OrchestrationError("boundary_path_invalid", `${what}는 NUL 없는 절대경로여야 한다`);
    }
    let real;
    try {
        real = realpathSync(raw);
    }
    catch {
        // symlink 고리·미존재 경로는 판정 불가 = 거부.
        throw new OrchestrationError("boundary_path_unresolvable", `${what}의 realpath를 확인할 수 없다: ${raw}`);
    }
    if (real !== raw) {
        throw new OrchestrationError("boundary_path_not_canonical", `${what}는 정규 경로여야 한다(symlink 미해석 원칙): 주어진 ${raw}, realpath ${real}`);
    }
    return { path: real, id: identityOf(real, what) };
}
/** 최종 엔트리를 **따라가지 않고**(lstat) 신원을 읽는다 — symlink는 디렉터리로 인정하지 않는다. */
function identityOf(path, what) {
    let st;
    try {
        st = lstatSync(path);
    }
    catch {
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
function sameIdentity(a, b) {
    return a.dev === b.dev && a.ino === b.ino;
}
/** 숫자는 고정 시각, 함수는 clock, 미지정은 `Date.now`. */
function clockOf(nowMs) {
    if (typeof nowMs === "function")
        return nowMs;
    if (typeof nowMs === "number")
        return () => nowMs;
    return Date.now;
}
/**
 * 만료 판정(경계 포함 — `now >= expiresAt`면 거부). 읽을 수 없는 시각·만료 시각은 **거부**다(fail closed).
 * 실행 경계는 kernel보다 좁게 잡는다(대장 `C-17`). 경계 진입과 **spawn 직전 재검증에서 각각** 부른다.
 */
function assertNotExpired(manifest, now, when) {
    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
        throw new OrchestrationError("manifest_expired", `승인 manifest가 만료됐다(expiresAt ${manifest.expiresAt}, ${when})`);
    }
}
async function git(gitPath, cwd, args, what) {
    let out;
    try {
        // 신뢰된 절대경로 + 상속 없는 최소 env. 저장소는 `-C cwd`만으로 결정된다.
        out = await runProcess(gitPath, ["-C", cwd, ...args], { timeoutMs: GIT_TIMEOUT_MS, env: { ...GIT_SANITIZED_ENV } });
    }
    catch {
        // spawn 실패·타임아웃 — stderr를 오류에 싣지 않는다(경로·인자 노출 최소화).
        throw new OrchestrationError("boundary_git_failed", `${what}의 git ${args[0]} 조회가 실패했다`);
    }
    if (out.code !== 0) {
        throw new OrchestrationError("boundary_git_failed", `${what}의 git ${args[0]}가 비정상 종료했다(code ${out.code})`);
    }
    return out.stdout.trim();
}
/** 동기 HEAD 조회(재검증 전용). 신뢰된 git 경로 · 상속 없는 env · shell 미경유 인자 배열. */
function headSync(gitPath, root, what) {
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
 */
async function readCheckoutHead(gitPath, root, what) {
    const toplevel = await git(gitPath, root, ["rev-parse", "--show-toplevel"], what);
    let topReal;
    try {
        topReal = realpathSync(toplevel);
    }
    catch {
        throw new OrchestrationError("boundary_path_unresolvable", `${what}의 checkout 루트를 확인할 수 없다`);
    }
    if (topReal !== root) {
        throw new OrchestrationError("boundary_not_checkout_root", `${what}는 checkout 루트 자신이어야 한다(주어진 경로: ${root}, 실제 루트: ${topReal})`);
    }
    const head = await git(gitPath, root, ["rev-parse", "HEAD"], what);
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
export async function verifyExecutionBoundary(input) {
    const manifest = validateApprovalManifest(input.manifest);
    const clock = clockOf(input.nowMs);
    assertNotExpired(manifest, clock(), "경계 진입");
    // 증명 도구부터 신뢰한다: 이름 조회 없이 검증된 절대경로 하나만 쓴다(신원은 아래에서 고정).
    const gitBin = verifyTrustedExecutable(input.gitExecutablePath, "gitExecutablePath", GIT_CODES);
    const controller = resolveCanonicalDir(input.controllerRepoRoot, "controllerRepoRoot");
    const target = resolveCanonicalDir(input.targetWorktree, "targetWorktree");
    const sameCheckout = controller.path === target.path;
    const controllerHead = await readCheckoutHead(gitBin.path, controller.path, "controller checkout");
    if (controllerHead !== manifest.approvedCommit) {
        throw new OrchestrationError("approved_commit_mismatch", `controller checkout HEAD(${controllerHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`);
    }
    if (!sameCheckout) {
        const targetHead = await readCheckoutHead(gitBin.path, target.path, "실행 checkout");
        if (targetHead !== manifest.approvedCommit) {
            throw new OrchestrationError("approved_commit_mismatch", `실행 checkout HEAD(${targetHead})가 승인된 커밋(${manifest.approvedCommit})이 아니다`);
        }
    }
    const revalidateSync = () => {
        // 승인 만료를 **여기서 다시** 본다: 위 만료 검사와 이 지점 사이에 비동기 git 조회가 있어
        // 그 사이에 승인이 만료될 수 있다. 만료된 승인으로는 프로세스를 띄우지 않는다.
        assertNotExpired(manifest, clock(), "spawn 직전 재확인");
        // 증명 도구도 그 사이에 교체될 수 있다 — 신원을 고정해 두고 쓰기 직전에 다시 확인한다.
        verifyTrustedExecutable(gitBin.path, "gitExecutablePath", GIT_CODES, gitBin.id);
        const roots = sameCheckout
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
            const head = headSync(gitBin.path, path, what);
            if (head !== manifest.approvedCommit) {
                throw new OrchestrationError("approved_commit_mismatch", `${what} HEAD(${head})가 승인된 커밋(${manifest.approvedCommit})이 아니다(spawn 직전 재확인)`);
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
