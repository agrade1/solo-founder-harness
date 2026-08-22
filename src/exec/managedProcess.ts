/**
 * V3 M5c — **관리 프로세스 supervisor**(대장 `B-F1`의 프로세스 역학 면).
 *
 * 이 모듈은 **권위를 하나도 다루지 않는다.** 승인·permit·grant·capability·digest 재검증·spawn 상한은
 * 전부 `orchestrationKernel.executeRunProcessOperation()` 안에 있고, 여기 있는 것은 그 게이트를 전부
 * 지난 뒤의 **역학**뿐이다: 자기 프로세스 그룹으로 띄우고 · deadline/취소에 죽이고 · **그 프로세스 그룹이
 * 비었음을 확인**하고 · 확인하지 못하면 그 사실을 그대로 돌려준다.
 *
 * 그래서 이 모듈을 직접 import해도 새 권위가 생기지 않는다(A3가 없앤 `writeFileEffect.ts`와 다른 점이다):
 * 여기서는 canonical marker도 영수증도 만들지 않고, `child_process.spawn`을 직접 부르는 것과 같은 일만
 * 한다 — 그 능력은 이미 ambient다. 영수증으로 바꾸는 코드는 kernel 사설 경로 하나뿐이다.
 *
 * **자손 정리는 프로세스 그룹으로 한다**(PID 트리 탐색이 아니다). `detached: true`로 띄우면 자식이
 * **새 프로세스 그룹의 leader**가 되고 그 자손은 **자기도 `setsid`하지 않는 한** 같은 pgid에 남으므로,
 * `kill(-pgid, …)` 한 번이 그 그룹을 덮는다. 같은 접근을 `scripts/m3d2-stress-acceptance.mjs`가
 * 이미 쓰고 있다(그 파일의 pgid 소유 규칙 그대로다 — 두 번째 방식을 만들지 않는다).
 *
 * **범위를 정확히 적는다(대장 `B-18` · V3 M10 T6)**: 관측 단위는 **프로세스 그룹**이다. 자손이 스스로
 * `setsid`(Node의 `detached: true`)하면 새 session/group으로 나가므로 `kill(-pgid, 0)`이 그것을 보지
 * 못한다 → 그때 `cleanupConfirmed: true`는 "**승인된 프로세스 그룹이** 비었다"는 뜻이고 "이 turn이 만든
 * 프로세스가 하나도 남지 않았다"가 **아니다**. 이전 머리말은 "자손 전부"라고 적어 그 범위를 넘겼다.
 * 그룹 밖까지 묶으려면 cgroup·jail 같은 커널 개념이 필요하고 darwin에는 없다 — 없는 보장을 적지 않는다.
 * 한계는 `managedProcess.test.ts`의 `[M10 T6/B-18]` 테스트가 실제 탈출 프로세스로 고정한다.
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
export const MANAGED_PROCESS_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
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
  /**
   * **system/global config를 사용자 상태 없이 끈다**(대장 `B-20` · V3 M10 T6).
   *
   * `TRUSTED_GIT_PREFIX`의 `-c`는 **아는 키만** 끈다(fsmonitor·hooksPath). `/etc/gitconfig`는 여전히
   * 파싱됐고, 그 파일에 미래 git이 추가할 "프로그램을 실행하게 만드는 키"가 들어오면 prefix는 그것을
   * 모른다. B-20 리뷰가 실측으로 확인한 것은 "**오늘** 도달 가능한 코드 실행 경로 0"이었고, 그 트리거는
   * M9 T3③이 이 상수를 건드릴 때 발화했는데 함께 닫히지 않았다 — 여기서 닫는다.
   *
   * `GIT_CONFIG_GLOBAL=/dev/null`은 `HOME` 부재와 **중복**이지만 명시한다: 이 상수에 나중에 `HOME`이
   * 더해지더라도 global config가 조용히 되살아나지 않게 하는 것이 목적이다(env 위생이 아니라 경계다).
   * `executionBoundary.GIT_SANITIZED_ENV`가 이미 같은 두 값을 쓴다 — **같은 규칙을 두 번 쓰지 않고
   * 같은 값을 쓴다**(두 경로의 판정이 갈라지지 않게).
   */
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

export interface SupervisedLaunch {
  /** 승인·digest 재검증을 이미 통과한 실행 파일의 절대 경로. */
  executable: string;
  args: readonly string[];
  cwd: string;
  /** 이 시간이 지나면 그룹을 종료한다(경계 포함 — 타이머 발화 = deadline). */
  timeoutMs: number;
  /** SIGTERM 뒤 SIGKILL까지 주는 유예. */
  termGraceMs: number;
  /** SIGKILL 뒤 그룹이 비는 것을 기다리는 유예. */
  killGraceMs: number;
  /** 외부 취소(옵션). deadline과 같은 정리 경로를 탄다. */
  signal?: AbortSignal;
}

export interface SupervisedOutcome {
  /** 정상 종료의 종료 코드. 신호로 죽었으면 null. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly terminatedBy: "exit" | "deadline" | "cancel";
  /**
   * **승인된 프로세스 그룹이 비었다는 것을 관측했는가.** false면 자손이 남았을 수 있다 = 성공이 아니다.
   * true는 **그룹 범위의 주장**이다 — `setsid`로 그룹을 탈출한 자손은 이 관측의 밖이다(대장 `B-18`).
   */
  readonly cleanupConfirmed: boolean;
}

/** 그룹 상태를 관측하는 주기. 짧은 fixture에서도 결정적이고, 유예 안에서만 돈다. */
const POLL_MS = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function launchFailed(what: string): OrchestrationError {
  return new OrchestrationError("process_launch_failed", `관리 프로세스를 시작할 수 없다: ${what}`);
}

/**
 * 그룹에 살아 있는 프로세스가 있는가. `EPERM`은 **살아 있지만 신호를 보낼 수 없다**는 뜻이므로
 * "죽었다"로 접지 않는다(fail closed — 미확인이 성공이 되지 않는다).
 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH(이미 비었다) · EPERM(권한 없음) — 판정은 아래 `groupAlive` 관측이 한다.
  }
}

/** 유예 안에서 그룹이 비는 것을 **관측**한다. 관측하지 못하면 false(= 정리 미확인)다. */
async function drained(pgid: number, graceMs: number): Promise<boolean> {
  const until = Date.now() + Math.max(0, graceMs);
  for (;;) {
    if (!groupAlive(pgid)) return true;
    if (Date.now() >= until) return false;
    await sleep(POLL_MS);
  }
}

/** SIGTERM → 유예 → SIGKILL → 유예. 마지막까지 그룹이 남아 있으면 **미확인**이다. */
async function reapGroup(pgid: number, termGraceMs: number, killGraceMs: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  signalGroup(pgid, "SIGTERM");
  if (await drained(pgid, termGraceMs)) return true;
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
export async function superviseProcess(launch: SupervisedLaunch): Promise<SupervisedOutcome> {
  // 프로세스 그룹 정리를 보장할 수 없는 플랫폼에서는 **띄우지 않는다**(자손을 남길 수 있다).
  if (process.platform === "win32") {
    throw launchFailed("이 플랫폼에는 프로세스 그룹 정리 보장이 없다");
  }

  const child = spawn(launch.executable, [...launch.args], {
    cwd: launch.cwd,
    env: { ...MANAGED_PROCESS_ENV },
    // 자기 프로세스 그룹의 leader가 된다 → 이 프로세스의 자손은 **자기도 `setsid`하지 않는 한** 이 pgid에
    // 남는다(머리말의 범위 기술과 같은 문장이다 — 탈출 자손은 관측 범위 밖이다 · 대장 `B-18`).
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  const pid = child.pid;

  let launchError: Error | null = null;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let terminatedBy: SupervisedOutcome["terminatedBy"] = "exit";

  const settled = new Promise<void>((resolve) => {
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
  let escalation: NodeJS.Timeout | null = null;
  const stop = (reason: SupervisedOutcome["terminatedBy"]): void => {
    if (terminatedBy === "exit") terminatedBy = reason;
    if (pgid === null) return;
    signalGroup(pgid, "SIGTERM");
    if (escalation === null) {
      escalation = setTimeout(() => signalGroup(pgid, "SIGKILL"), Math.max(0, launch.termGraceMs));
    }
  };

  const deadline = setTimeout(() => stop("deadline"), Math.max(0, launch.timeoutMs));
  const onAbort = (): void => stop("cancel");
  if (launch.signal !== undefined) {
    if (launch.signal.aborted) stop("cancel");
    else launch.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    await settled;
  } finally {
    clearTimeout(deadline);
    if (escalation !== null) clearTimeout(escalation);
    launch.signal?.removeEventListener("abort", onAbort);
  }

  if (pgid === null || launchError !== null) {
    // 그룹이 만들어졌을 수도 있으므로 거두는 것을 건너뛰지 않는다.
    if (pgid !== null) await reapGroup(pgid, launch.termGraceMs, launch.killGraceMs);
    throw launchFailed("spawn이 실패했다");
  }

  // **정상 종료도 그룹을 거둔다**: leader가 끝나도 자손은 남을 수 있다(고아 방지의 핵심).
  const cleanupConfirmed = await reapGroup(pgid, launch.termGraceMs, launch.killGraceMs);

  return Object.freeze({ exitCode, signal: exitSignal, terminatedBy, cleanupConfirmed });
}
