/**
 * V3 M5c — **관리 프로세스 supervisor**(대장 `B-F1`의 프로세스 역학 면).
 *
 * 이 모듈은 **권위를 하나도 다루지 않는다.** 승인·permit·grant·capability·digest 재검증·spawn 상한은
 * 전부 `orchestrationKernel.executeRunProcessOperation()` 안에 있고, 여기 있는 것은 그 게이트를 전부
 * 지난 뒤의 **역학**뿐이다: 자기 프로세스 그룹으로 띄우고 · deadline/취소에 죽이고 · **자손까지 사라진
 * 것을 확인**하고 · 확인하지 못하면 그 사실을 그대로 돌려준다.
 *
 * 그래서 이 모듈을 직접 import해도 새 권위가 생기지 않는다(A3가 없앤 `writeFileEffect.ts`와 다른 점이다):
 * 여기서는 canonical marker도 영수증도 만들지 않고, `child_process.spawn`을 직접 부르는 것과 같은 일만
 * 한다 — 그 능력은 이미 ambient다. 영수증으로 바꾸는 코드는 kernel 사설 경로 하나뿐이다.
 *
 * **자손 정리는 프로세스 그룹으로 한다**(PID 트리 탐색이 아니다). `detached: true`로 띄우면 자식이
 * **새 프로세스 그룹의 leader**가 되고 그 자손은 전부 같은 pgid에 남으므로, `kill(-pgid, …)` 한 번이
 * 우리가 실제로 소유한 자손 **전부**를 덮는다. 같은 접근을 `scripts/m3d2-stress-acceptance.mjs`가
 * 이미 쓰고 있다(그 파일의 pgid 소유 규칙 그대로다 — 두 번째 방식을 만들지 않는다).
 *
 * **정리 미확인은 성공이 아니다**(B1 계약): 그룹이 비었다는 것을 `kill(-pgid, 0)`의 `ESRCH`로 **관측**하지
 * 못하면 `cleanupConfirmed: false`로 돌려주고, 호출자(kernel)는 그것을 1차 오류보다 **먼저** 보고한다.
 *
 * 내용은 담지 않는다: stdout/stderr는 아예 받지 않고(`stdio: "ignore"`) 오류 메시지에 argv·경로·환경을
 * 넣지 않는다.
 */
import { spawn } from "node:child_process";
import { OrchestrationError } from "./orchestrationTypes.js";
/**
 * 관리 프로세스에 주는 **환경 전부**. 부모 환경은 상속하지 않는다(secret·`NODE_OPTIONS`·proxy 유입 차단).
 * `PATH`가 비어 있어도 kernel은 **승인된 절대 경로**로만 exec하므로 조회가 필요 없다.
 */
export const MANAGED_PROCESS_ENV = Object.freeze({
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    /**
     * **partial clone의 lazy fetch를 끈다**(V3 M9 T3③ 적대적 리뷰 B-1 실측).
     *
     * `git worktree add`는 읽기 질의와 달리 object를 물리적으로 요구하므로, `--filter=blob:none` clone
     * 에서는 argv에 `fetch`가 없어도 git이 **내부에서 원격에 닿는다**. argv 계약만으로는 "네트워크 0"이
     * 성립하지 않는다는 뜻이라, 그 축을 여기서 끈다.
     *
     * **호출자별 env 오버라이드 표면을 열지 않았다**: 그것은 임의 env 주입 통로가 되고, 이 상수가 닫혀
     * 있다는 성질 자체가 secret·`NODE_OPTIONS`·proxy 유입을 막는 근거다. git 아닌 프로세스에는 무해한
     * 미상 변수 하나일 뿐이다.
     */
    GIT_NO_LAZY_FETCH: "1",
});
/** 그룹 상태를 관측하는 주기. 짧은 fixture에서도 결정적이고, 유예 안에서만 돈다. */
const POLL_MS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function launchFailed(what) {
    return new OrchestrationError("process_launch_failed", `관리 프로세스를 시작할 수 없다: ${what}`);
}
/**
 * 그룹에 살아 있는 프로세스가 있는가. `EPERM`은 **살아 있지만 신호를 보낼 수 없다**는 뜻이므로
 * "죽었다"로 접지 않는다(fail closed — 미확인이 성공이 되지 않는다).
 */
function groupAlive(pgid) {
    try {
        process.kill(-pgid, 0);
        return true;
    }
    catch (e) {
        return e.code !== "ESRCH";
    }
}
function signalGroup(pgid, signal) {
    try {
        process.kill(-pgid, signal);
    }
    catch {
        // ESRCH(이미 비었다) · EPERM(권한 없음) — 판정은 아래 `groupAlive` 관측이 한다.
    }
}
/** 유예 안에서 그룹이 비는 것을 **관측**한다. 관측하지 못하면 false(= 정리 미확인)다. */
async function drained(pgid, graceMs) {
    const until = Date.now() + Math.max(0, graceMs);
    for (;;) {
        if (!groupAlive(pgid))
            return true;
        if (Date.now() >= until)
            return false;
        await sleep(POLL_MS);
    }
}
/** SIGTERM → 유예 → SIGKILL → 유예. 마지막까지 그룹이 남아 있으면 **미확인**이다. */
async function reapGroup(pgid, termGraceMs, killGraceMs) {
    if (!groupAlive(pgid))
        return true;
    signalGroup(pgid, "SIGTERM");
    if (await drained(pgid, termGraceMs))
        return true;
    signalGroup(pgid, "SIGKILL");
    return drained(pgid, killGraceMs);
}
/**
 * **관리 프로세스 1건을 끝까지 감독한다.** 돌아올 때는 언제나 정리 시도가 끝나 있다:
 * 정상 종료든 deadline이든 취소든 마지막에 그룹을 거두고 **비었음을 관측**한 뒤에만
 * `cleanupConfirmed: true`다.
 *
 * ponytail: 프로세스 그룹 하나 = 감독 단위 하나. `ps` 트리 탐색을 다시 만들지 않는다 — 우리가 소유한
 * 것은 우리가 만든 pgid뿐이고 그 밖을 건드릴 이유가 없다.
 */
export async function superviseProcess(launch) {
    // 프로세스 그룹 정리를 보장할 수 없는 플랫폼에서는 **띄우지 않는다**(자손을 남길 수 있다).
    if (process.platform === "win32") {
        throw launchFailed("이 플랫폼에는 프로세스 그룹 정리 보장이 없다");
    }
    const child = spawn(launch.executable, [...launch.args], {
        cwd: launch.cwd,
        env: { ...MANAGED_PROCESS_ENV },
        // 자기 프로세스 그룹의 leader가 된다 → 이 프로세스의 **모든 자손**이 이 pgid에 남는다.
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
    });
    const pid = child.pid;
    let launchError = null;
    let exitCode = null;
    let exitSignal = null;
    let terminatedBy = "exit";
    const settled = new Promise((resolve) => {
        child.once("error", (e) => {
            launchError = e;
            resolve();
        });
        child.once("exit", (code, sig) => {
            exitCode = code;
            exitSignal = sig;
            resolve();
        });
    });
    // pgid로 쓸 수 있는 값인가. `<= 1`은 init/자기 그룹을 향할 수 있으므로 **절대 신호를 보내지 않는다**.
    const pgid = typeof pid === "number" && pid > 1 ? pid : null;
    let escalation = null;
    const stop = (reason) => {
        if (terminatedBy === "exit")
            terminatedBy = reason;
        if (pgid === null)
            return;
        signalGroup(pgid, "SIGTERM");
        if (escalation === null) {
            escalation = setTimeout(() => signalGroup(pgid, "SIGKILL"), Math.max(0, launch.termGraceMs));
        }
    };
    const deadline = setTimeout(() => stop("deadline"), Math.max(0, launch.timeoutMs));
    const onAbort = () => stop("cancel");
    if (launch.signal !== undefined) {
        if (launch.signal.aborted)
            stop("cancel");
        else
            launch.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
        await settled;
    }
    finally {
        clearTimeout(deadline);
        if (escalation !== null)
            clearTimeout(escalation);
        launch.signal?.removeEventListener("abort", onAbort);
    }
    if (pgid === null || launchError !== null) {
        // 그룹이 만들어졌을 수도 있으므로 거두는 것을 건너뛰지 않는다.
        if (pgid !== null)
            await reapGroup(pgid, launch.termGraceMs, launch.killGraceMs);
        throw launchFailed("spawn이 실패했다");
    }
    // **정상 종료도 그룹을 거둔다**: leader가 끝나도 자손은 남을 수 있다(고아 방지의 핵심).
    const cleanupConfirmed = await reapGroup(pgid, launch.termGraceMs, launch.killGraceMs);
    return Object.freeze({ exitCode, signal: exitSignal, terminatedBy, cleanupConfirmed });
}
