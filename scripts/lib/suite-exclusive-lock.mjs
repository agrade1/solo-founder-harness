/**
 * [V3 M3d.2] ordinary `npm test`와 stress runner가 **함께** 쓰는 단일 배타 lock.
 *
 * 왜 필요한가: 이 레포에는 프로세스/tmp 전역 상태를 관측하는 테스트가 있다(M3d.1 실측).
 * 전체 suite 두 개가 동시에 시작되면 서로의 전역 상태를 보고 거짓 실패한다. 따라서
 * **일반 `npm test`와 stress acceptance는 같은 lock 하나**를 지나야 한다.
 *
 * ─── 여섯 번째 리비전에서 강화된 부분 (Codex Sol xhigh P1/P2) ─────────────────
 *
 * ⓐ **최종 경로가 symlink인 lock/guard는 신원으로 인정하지 않는다(P1).** 예전 `readLockSnapshot`은
 *    `openSync(path, "r")`로 열어 **symlink를 따라갔다**. 그래서 계약 밖 행위자가 원래 lock 파일을
 *    다른 이름으로 옮기고 그 자리에 symlink를 두면, 우리는 "옮겨진 원본"의 record·(dev,ino)를 보고
 *    소유를 인정한 뒤 ⑴ release에서 **symlink만 unlink**하고 해제 성공을 보고하거나
 *    ⑵ quarantine에서 **남의 symlink 엔트리를 rename으로 덮을** 수 있었다. 이제 lock·guard 읽기는
 *    `O_RDONLY|O_NOFOLLOW`로만 열고, symlink(ELOOP/EMLINK)는 `lock_path_symlink`로 **거부**하며
 *    `O_NOFOLLOW` 미지원 플랫폼은 `lock_nofollow_unsupported`로 거부한다(fail closed).
 *    두 경우 모두 그 엔트리와 대상 파일을 **지우거나 덮지 않는다**.
 *
 * ⓑ **성공 상태는 guard 반납이 끝난 뒤에만 공표한다(P2).** 예전 `release()`는 전이 콜백 안에서
 *    `handle.state = "released"`를 먼저 세팅했다. 그 뒤 `releaseTransitionGuard`가 실패하면
 *    `withTransitionGuard`가 `lock_guard_release_failed`를 던지는데도 `state`는 이미 `released`라
 *    소비자(`suite-lock.mjs`·stress runner)가 `lockReleased:true`로 보고했다. 이제 전이 콜백은
 *    **결과만 값으로 돌려주고**, `handle.state`는 `withTransitionGuard`가 정상 반환한 뒤에만 바뀐다.
 *    guard 정리/교체/unlink 실패가 lock unlink **뒤에** 일어나면 결과는 `state="failed"`,
 *    `released=false`, problems 보고이며 guard가 남아 다음 실행을 막는다.
 *    (acquire·reentry는 이미 `withTransitionGuard` 반환 **뒤에** handle/결과를 만들므로 같은 규칙을
 *    이미 지킨다 — 이번 리비전에서 그 계약을 재감사만 했고 구현을 넓히지 않았다.)
 *
 * ─── 다섯 번째 리비전에서 강화된 부분 (Codex Sol xhigh P1-1~P1-4) ─────────────
 *
 * ㉠ **파괴적 조작 직전에 신원을 다시 확인한다.** guard 제거는 "확인 → (동기화 지점) → **재확인**(같은 fd로
 *    record+inode) → 최종 경로 `lstat` → unlink" 순서다. quarantine rename도 "temp write/close → **원본
 *    기본 record+inode 재확인** → rename → 사후 확인"이다. 그 사이 교체된 남의 guard/lock은 지우거나
 *    덮지 않고 **보존**한다. Node 18에는 `unlinkat`·compare-and-unlink 원자 연산이 없어 마지막 확인과
 *    syscall 사이 창을 **0으로 만들 수는 없다** — 창을 syscall 두 개로 줄이고, 사후 실패는 숨기지 않고
 *    mechanism 실패로 올려 guard가 남게 한다(fail closed).
 *
 * ㉡ **guard 이후의 모든 I/O·정리 실패는 성공으로 이어지지 않는다.** 임시 파일 정리는 열자마자 확보한
 *    (dev,ino)와 일치할 때만 하고(남의 파일 blind unlink 금지), 정리 실패·close 실패·guard 반납 실패는
 *    전부 `mechanism`으로 올린다(`lock_publish_cleanup_failed` / `lock_guard_release_failed`).
 *    즉 acquire·reentry가 전이를 완결하지 못했는데 handle을 돌려주고 suite를 시작하는 경로가 없다.
 *
 * ㉢ **재진입 이후 소유권 기준은 tokenHash가 아니다.** 성공한 재진입은 그 시점의 **기본 record + (dev,ino)**
 *    를 `base`로 돌려주고, 이후 격리(`quarantineByToken({ expected })`)까지 그 기준을 명시 전달한다.
 *    같은 tokenHash를 가졌지만 기본 record·inode가 다른 외부 lock은 격리하지 않고 보존한다.
 *
 * ─── 네 번째 리비전에서 강화된 부분 (Codex Sol xhigh P1-1/P1-2) ───────────────
 *
 * A) **발행(publish)은 신원이 확인된 뒤에만 성공이다.** 임시 파일을 열린 fd로 `fstat`해 (dev,ino)를
 *    확보하고, `link` 뒤 최종 경로 `lstat`이 **같은 (dev,ino)** 임을 확인한다. lstat 실패·불일치는
 *    성공이 아니며(`lock_publish_unverifiable` / `lock_publish_identity_mismatch`) 최종 경로를
 *    **지우지 않는다**(우리 파일이라는 증거가 없으므로). 따라서 `published:true`의 dev/ino는
 *    **항상 non-null**이고, 이후 모든 전이가 그 신원을 요구한다 — inode 검증이 생략되는 경로가 없다.
 *    guard 발행이 불확실하면 그 guard 파일이 그대로 남아 새 suite 실행을 막는다(fail closed).
 *
 * B) **전이 실패 분류를 명시한다**(아래 `FAILURE_CLASSES`). guard를 쥔 뒤의 메커니즘 I/O 오류
 *    (temp create/write/close/link, 발행 신원 확인, lock unlink, 격리 write/close/rename)와
 *    예상 밖 예외는 전부 **guard를 남긴다**. 아무 상태도 바꾸지 않은 **계약상 거부만** 자기
 *    nonce+inode를 재확인해 guard를 반납한다. 기본값이 fail closed 쪽이다.
 *
 * ─── 세 번째 리비전 설계 (Codex Sol xhigh P1-1/P1-2/P1-3) ───────────────────────
 *
 * 1) **모든 상태 전이는 crash-persistent transition guard 안에서만 일어난다.**
 *    acquire / release / quarantine / reentry 검증은 예외 없이 `<lock>.guard`를 exclusive 발행한
 *    프로세스만 수행한다. guard가 이미 있으면 bounded 대기 후 **거부**하며 절대 자동 제거하지 않는다.
 *    guard 안에서 lock의 **token + inode 신원을 다시 확인**한 뒤에만 파일을 만들거나 지우거나 덮는다.
 *    → "release가 snapshot 뒤 unlink, quarantine이 snapshot 뒤 rename"으로 서로를 덮어쓰는
 *      TOCTOU(양방향)가 구조적으로 불가능하다. quarantine은 다른 live lock을 덮을 수 없다.
 *
 * 2) **fail closed: 전이 오류·크래시는 guard를 남긴다.**
 *    전이 **메커니즘**이 실패했거나(quarantine write 실패, unlink 실패, 신원 불일치, 예상 밖 예외)
 *    프로세스가 guard를 쥔 채 SIGKILL로 죽으면 guard 파일이 남고, 이후 모든 acquire가 거부된다.
 *    사람이 잔존 프로세스를 확인한 뒤 guard를 지워야 풀린다. guard 제거는 **정상 전이 성공 시**
 *    자기 nonce·inode를 확인한 뒤에만 한다.
 *    계약상 거부(이미 보유 중 / 격리됨 / orphan / 형식 위반 / 동시 suite 감지)는 아무것도 바꾸지 않은
 *    **no-op**이므로 guard를 정상 반납한다 — 그렇지 않으면 두 suite를 한 번 겹쳐 실행한 것만으로
 *    영구 수동 개입이 필요해진다.
 *
 * 3) **stale/orphan 자동 회수 없음.** 격리되지 않은 lock 소유자의 죽음은 "정리가 끝났다"는 증거가 아니다
 *    (SIGKILL·크래시로 죽으면 소유 프로세스 그룹의 잔재가 남아 있을 수 있다). 따라서 소유자가 죽은 lock은
 *    `lock_orphaned`로 **항상 거부**하고 사람이 확인 후 제거한다. 예전의 `.recovery` mutex와 rename 회수
 *    경로는 전부 제거했다(회수 자체가 없으므로 mutex도 필요 없다).
 *
 * 그 밖의 계약:
 *  - lock 파일은 **완성된 뒤에만 최종 이름으로 존재한다**: 비공개 임시 파일에 전부 쓰고 close한 뒤
 *    `link()`로 발행한다(EEXIST = 이미 보유자 있음). 부분 write 실패는 최종 경로에 잔재를 남기지 않는다.
 *  - 소유자 신원은 **pid + `ps lstart`**다. PID 단독 신뢰 금지.
 *  - stress가 띄우는 자기 소유 `npm test` child만 **추측 불가능한 ownership token**으로 재진입한다.
 *    token 원문은 디스크에 남기지 않고 sha256만 lock 파일에 기록한다.
 *  - `ps` 후보 스캔은 lock을 우회해 시작된 suite(예: 직접 실행한 `tsx --test`)를 잡는 **backstop**이며
 *    lock을 만들기 **전에** 본다. `ps` 확인 실패는 거부(fail closed).
 *
 * 이 모듈은 **`process.env`를 읽지 않는다**(Codex Sol xhigh P2-6). lock 경로·`ps` fixture·동기화 지점은
 * 전부 호출자가 넘기는 옵션이며, production 진입점은 override를 넘기지 않는다. 테스트 주입은
 * `--fixture-config` argv 경로(scripts/lib/fixture-config.mjs)로만 들어온다.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** 재진입 ownership token은 부모→자식 handoff라 env로만 전달된다(테스트 seam이 아니다). */
export const LOCK_TOKEN_ENV = "HARNESS_SUITE_LOCK_TOKEN";
/** guard 기반 계약으로 바뀌었으므로 파일 버전을 올린다(옛 형식 lock은 `lock_unverifiable`). */
export const LOCK_FILE_VERSION = 2;
export const DEFAULT_LOCK_NAME = "harness-suite-exclusive.lock";
export const LOCK_KINDS = ["stress", "suite"];
export const GUARD_SUFFIX = ".guard";
export const GUARD_PURPOSES = ["acquire", "release", "quarantine", "reentry"];
/**
 * 동기화 지점(테스트 전용). fixture 설정의 **고정 enum**이며 그 외 값은 거부된다.
 * 지점 이름은 전이 종류까지 포함해 한 실행에서 **정확히 한 전이만** 멈추게 한다
 * (`before_guard_unlink_release`는 release 전이의 guard 제거 직전만 멈춘다).
 */
export const PAUSE_POINTS = [
  "after_guard_acquire",
  "after_guard_release",
  "after_guard_quarantine",
  "before_publish",
  "before_publish_tmp_cleanup",
  "before_unlink",
  "before_quarantine_write",
  "before_quarantine_rename",
  "before_guard_unlink_acquire",
  "before_guard_unlink_release",
  "before_guard_unlink_reentry",
];

/** lstart 형식: "Sat Jul 26 13:48:21 2026" (macOS/procps 공통, 1초 해상도). */
const LSTART_RE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[0-9a-f]{32,64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const QUARANTINE_REASON_RE = /^[a-z0-9_]{1,64}$/;

/** guard 경합 대기 상한 — 정상 전이는 syscall 몇 개다. 넘으면 거부(자동 제거 금지). */
export const GUARD_WAIT_MS = 2_000;
const GUARD_POLL_MS = 25;
const PAUSE_MAX_MS = 20_000; // 테스트 동기화 지점의 firm 상한(매달리지 않는다)

/**
 * suite를 실제로 **실행할 수 있는** 실행 파일만 후보로 본다. argv에 테스트 명령 문자열을 담고 있는
 * 무관한 프로세스(예: 허용 도구 목록을 argv로 받는 agent CLI)를 오판하지 않기 위함(M3d.1 교훈).
 */
export const SUITE_EXECUTABLES = new Set(["node", "npm", "npx", "tsx", "sh", "bash", "zsh", "dash", "make"]);

/**
 * 일반 full suite와 launcher를 모두 잡도록 좁혀 정의한 패턴(실측 `ps` 출력 기준).
 *  - `npm test` / `npm run test:*` / `npm run acceptance*` (npm이 title을 "npm <args>"로 바꾼다)
 *  - `npm exec tsx --test ...`, `node .../tsx --test ...`, tsx가 재실행하는 `node ... --test*`
 *  - `bash scripts/acceptance.sh`, stress runner, 이 lock wrapper
 */
export const SUITE_PATTERNS = [
  /(?:^|[\s/])npm\s+(?:\S+\s+)*?(?:run\s+)?(?:test|test:exec|test:core|test:inner|acceptance)(?::\S+)?(?:\s|$)/,
  /(?:^|[\s/])(?:tsx|node)\b[^\n]*\s--test(?:\b|=)/,
  /scripts\/acceptance\.sh(?:\s|$)/,
  /scripts\/m3d2-stress-acceptance\.mjs(?:\s|$)/,
  /scripts\/suite-lock\.mjs(?:\s|$)/,
];

/**
 * 전이 실패 분류(**명시적** — Codex Sol xhigh P1-2).
 *
 *  - `refusal`   : 계약상 거부이며 **아무 상태도 바꾸지 않았음이 확실**하다(읽기 전용 검사 실패 포함).
 *                  이 경우에만 자기 nonce+inode를 재확인한 뒤 transition guard를 정상 반납한다.
 *                  그렇지 않으면 두 suite를 한 번 겹쳐 실행한 것만으로 영구 수동 개입이 필요해진다.
 *  - `mechanism` : 전이 메커니즘 I/O·신원 오류이거나 **결과가 불확실**하다(temp create/write/close/link,
 *                  발행 직후 신원 확인 실패·불일치, unlink 실패, 격리 기록 실패, 예상 밖 예외).
 *                  guard를 **남겨** 이후 모든 acquire를 거부한다(fail closed).
 *
 * **기본값은 `mechanism`이다** — 분류를 명시하지 않은 새 오류 경로는 자동으로 fail closed 쪽에 선다.
 */
export const FAILURE_CLASSES = ["refusal", "mechanism"];

export class SuiteLockError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "SuiteLockError";
    this.code = code;
    this.failure = opts.failure === "refusal" ? "refusal" : "mechanism";
  }
}

/** 계약상 거부(상태 변경 없음) — guard를 정상 반납한다. */
const refusal = (code, message) => new SuiteLockError(code, message, { failure: "refusal" });
/** 전이 메커니즘 실패·불확실 — guard를 남긴다(fail closed). */
const mechanismFailure = (code, message) => new SuiteLockError(code, message, { failure: "mechanism" });

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** 이 모듈은 동기 경로에서 짧게 기다려야 한다(await 없는 acquire/release/quarantine 계약 유지). */
export function sleepSync(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms; // SharedArrayBuffer 불가 환경 폴백
    while (Date.now() < end) {
      /* busy wait — bounded */
    }
  }
}

function hashEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/** 기본 lock 경로(OS tmpdir). override는 **옵션으로만** 들어온다(env 미참조). */
export function defaultLockPath() {
  return join(tmpdir(), DEFAULT_LOCK_NAME);
}

export function resolveLockPath(lockPath) {
  if (lockPath === undefined || lockPath === null || lockPath === "") return defaultLockPath();
  if (typeof lockPath !== "string" || !isAbsolute(lockPath)) {
    throw refusal("lock_path_relative", "lock 경로 override는 절대경로여야 합니다.");
  }
  return lockPath;
}

function normalizePause(pause) {
  if (!pause) return null;
  const dir = pause.dir;
  const at = pause.at;
  if (typeof dir !== "string" || !isAbsolute(dir)) throw refusal("pause_dir_relative", "pause dir은 절대경로여야 합니다.");
  if (typeof at !== "string" || !PAUSE_POINTS.includes(at)) throw refusal("pause_point_invalid", "pause 지점이 허용 목록에 없습니다.");
  return { dir, at };
}

/**
 * [테스트 seam] 전이 경합을 결정론적으로 재현하기 위한 동기화 지점.
 * 지정된 지점에서만 멈추고, `<dir>/resume`가 생기거나 상한(20s)에 닿으면 반드시 진행한다.
 */
function pauseHook(pause, at) {
  if (!pause || pause.at !== at) return;
  try {
    const fd = openSync(join(pause.dir, "paused"), "w", 0o600);
    try {
      writeSync(fd, `${at}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    return; // 동기화 파일을 못 쓰면 그냥 진행한다(테스트 전용 경로).
  }
  const end = Date.now() + PAUSE_MAX_MS;
  const resume = join(pause.dir, "resume");
  while (Date.now() < end) {
    if (existsSync(resume)) return;
    sleepSync(25);
  }
}

/** `ps` 표 파싱: "pid ppid pgid command". 형식이 맞지 않는 줄은 버린다. */
export function parsePsTable(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    if (!/^\d+$/.test(t[0]) || !/^\d+$/.test(t[1]) || !/^\d+$/.test(t[2])) continue;
    rows.push({ pid: Number(t[0]), ppid: Number(t[1]), pgid: Number(t[2]), command: t.slice(3).join(" ") });
  }
  return rows;
}

/** 전체 프로세스 표. fixture 경로가 주어지면 그것을 쓴다(탐지 로직 테스트용, argv 경유만). */
export function readPsTable(psFixture) {
  if (typeof psFixture === "string" && psFixture.length > 0) {
    if (!isAbsolute(psFixture)) return { ok: false, code: "ps_fixture_relative", rows: [] };
    try {
      return { ok: true, code: null, rows: parsePsTable(readFileSync(psFixture, "utf8")) };
    } catch {
      return { ok: false, code: "ps_fixture_unreadable", rows: [] };
    }
  }
  let r;
  try {
    r = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    return { ok: false, code: "ps_spawn_failed", rows: [] };
  }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return { ok: false, code: "ps_failed", rows: [] };
  const rows = parsePsTable(r.stdout);
  if (rows.length === 0) return { ok: false, code: "ps_empty", rows: [] };
  return { ok: true, code: null, rows };
}

/**
 * 소유한 프로세스 그룹(pgid)에 남아 있는 프로세스 수. **fixture seam을 쓰지 않는다** — 실제 정리 확인용이다.
 *  - { ok: true, count: n } / { ok: false, count: -1 } (확인 불가는 호출자가 fail closed 처리)
 */
export function countOwnedGroupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return { ok: true, count: 0 };
  let r;
  try {
    r = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return { ok: false, count: -1 };
  }
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return { ok: false, count: -1 };
  let count = 0;
  for (const line of r.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    if (Number(m[2]) === pgid) count += 1;
  }
  return { ok: true, count };
}

/**
 * 단일 프로세스 신원(`ps -o lstart= -p <pid>`). PID 단독 신뢰를 막기 위한 신원 값이다.
 *  - { ok: true, identity: "<lstart>" } — 해당 pid 생존
 *  - { ok: true, identity: null }      — 해당 pid 부재
 *  - { ok: false, ... }                — ps 확인 불가(호출자는 fail closed)
 */
export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: true, identity: null };
  let r;
  try {
    r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 15_000 });
  } catch {
    return { ok: false, identity: null };
  }
  if (!r || r.error || typeof r.stdout !== "string") return { ok: false, identity: null };
  const out = r.stdout.trim();
  if (r.status !== 0) return { ok: true, identity: null }; // 존재하지 않는 pid → status 1 + 빈 출력
  if (out.length === 0) return { ok: true, identity: null };
  const first = out.split("\n")[0].trim();
  if (!LSTART_RE.test(first)) return { ok: false, identity: null };
  return { ok: true, identity: first };
}

/** 자기 자신과 조상 체인(npm run/shell 래퍼)은 후보에서 제외한다. */
function ownChainPids(rows, selfPid) {
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
  const chain = new Set([selfPid]);
  for (let p = parentOf.get(selfPid), guard = 0; p && p > 1 && guard < 32; p = parentOf.get(p), guard++) chain.add(p);
  return chain;
}

/** lock을 우회해 시작된 suite 후보 pid 목록. */
export function detectSuiteRows(rows, selfPid) {
  const own = ownChainPids(rows, selfPid);
  const found = [];
  for (const { pid, command } of rows) {
    if (own.has(pid)) continue;
    const exe = (command.split(/\s+/)[0] ?? "").split("/").pop();
    if (!SUITE_EXECUTABLES.has(exe)) continue;
    if (SUITE_PATTERNS.some((re) => re.test(command))) found.push(pid);
  }
  return found;
}

/** lock 파일 record 계약 검증. quarantine 표시는 선택 필드이며 형식이 어긋나면 통째로 거부한다. */
function parseLockRecord(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw refusal("lock_unverifiable", "lock 파일 내용이 손상됨 — 소유자를 확인할 수 없어 거부합니다(fail closed).");
  }
  const base =
    j &&
    typeof j === "object" &&
    !Array.isArray(j) &&
    j.v === LOCK_FILE_VERSION &&
    typeof j.kind === "string" &&
    LOCK_KINDS.includes(j.kind) &&
    Number.isSafeInteger(j.pid) &&
    j.pid > 0 &&
    typeof j.identity === "string" &&
    LSTART_RE.test(j.identity) &&
    typeof j.tokenHash === "string" &&
    TOKEN_HASH_RE.test(j.tokenHash);
  const quarantineOk =
    j && typeof j === "object"
      ? j.quarantined === undefined
        ? j.quarantineReason === undefined
        : j.quarantined === true && typeof j.quarantineReason === "string" && QUARANTINE_REASON_RE.test(j.quarantineReason)
      : false;
  if (!base || !quarantineOk) {
    throw refusal("lock_unverifiable", "lock 파일 형식이 계약과 다릅니다 — 회수하지 않고 거부합니다(fail closed).");
  }
  return j;
}

/**
 * 읽기 전용 open이지만 **최종 경로가 symlink면 열지 않는다**(여섯 번째 리비전 P1).
 *
 * 왜 필요한가: `openSync(path, "r")`는 symlink를 따라간다. 그러면 "우리 lock 파일을 다른 이름으로 옮기고
 * 그 자리에 symlink를 둔" 경로 간섭에서 우리는 **옮겨진 원본**의 record·(dev,ino)를 읽고 소유를 인정한 뒤,
 * 실제로는 경로에 있는 **symlink 엔트리**를 unlink하거나 rename으로 덮게 된다. 즉 신원 검사와
 * 파괴적 조작의 대상이 서로 다른 파일이 된다. `O_NOFOLLOW`는 그 불일치를 열기 단계에서 없앤다.
 *
 * 반환: fd(number) | null(ENOENT = 파일 없음). 그 외 실패는 refusal throw이며 **아무것도 지우거나 덮지 않는다**.
 */
function openReadNoFollow(path, label) {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    // O_NOFOLLOW가 없으면 "최종 엔트리가 symlink가 아니다"를 열기 전에 보장할 수 없다 → fail closed.
    throw refusal(
      "lock_nofollow_unsupported",
      `이 플랫폼은 O_NOFOLLOW를 지원하지 않아 ${label} 최종 경로의 신원을 보장할 수 없습니다 — 거부합니다(fail closed).`,
    );
  }
  try {
    return openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (e) {
    const code = e?.code;
    if (code === "ENOENT") return null;
    // 최종 경로가 symlink면 Linux는 ELOOP, macOS(BSD)는 EMLINK를 준다. 둘 다 "일반 파일 아님"이다.
    if (code === "ELOOP" || code === "EMLINK") {
      throw refusal(
        "lock_path_symlink",
        `${label} 최종 경로가 symlink입니다 — 일반 파일만 신원으로 인정하며 그 엔트리도 대상 파일도 ` +
          `건드리지 않습니다(fail closed). 잔존 프로세스를 확인한 뒤 수동으로 정리하세요: ${path}`,
      );
    }
    throw refusal("lock_unreadable", `${label} 파일을 열 수 없습니다 [${code ?? "unknown"}] — 겹쳐 실행하지 않습니다(fail closed).`);
  }
}

/**
 * 경로를 열어 (dev,ino) 신원과 record를 **한 fd에서 함께** 얻는다. 분류와 파괴적 조작을 같은 inode에 묶기 위함.
 * 최종 엔트리가 symlink면 열지 않고 거부한다(위 `openReadNoFollow`).
 */
function readLockSnapshot(path) {
  const fd = openReadNoFollow(path, "lock");
  if (fd === null) return { gone: true, record: null, dev: null, ino: null };
  let st;
  let raw;
  let closeError = null;
  try {
    st = fstatSync(fd);
    raw = readFileSync(fd, "utf8");
  } catch {
    throw refusal("lock_unreadable", "lock 파일을 읽을 수 없습니다 — 겹쳐 실행하지 않습니다(fail closed).");
  } finally {
    try {
      closeSync(fd);
    } catch (e) {
      closeError = e; // 조용히 넘기지 않는다 — 아래에서 거부로 올린다(읽기 결과를 신뢰하지 않는다)
    }
  }
  if (closeError) {
    throw refusal("lock_unreadable", `lock 파일 fd close 실패 [${closeError?.code ?? "unknown"}] — 겹쳐 실행하지 않습니다(fail closed).`);
  }
  if (!st.isFile()) {
    throw refusal("lock_unverifiable", "lock 경로가 일반 파일이 아닙니다 — 거부합니다(fail closed).");
  }
  return { gone: false, record: parseLockRecord(raw), dev: st.dev, ino: st.ino };
}

/** (dev,ino) 신원 값이 실제로 쓸 수 있는 값인지 — published:true의 non-null 불변식을 지탱한다. */
const usableIdentity = (dev, ino) => Number.isSafeInteger(dev) && Number.isSafeInteger(ino) && ino > 0;

/** 열린 fd의 신원 `{dev,ino}`. 신원을 못 얻으면 null(그 경우 그 파일을 지우지 않는다). */
function fdIdentity(fd) {
  try {
    const st = fstatSync(fd);
    if (st.isFile() && usableIdentity(st.dev, st.ino)) return { dev: st.dev, ino: st.ino };
  } catch {
    /* 신원 없음 */
  }
  return null;
}

/**
 * **우리가 만든 임시 파일만** 지운다: 열자마자 fd에서 확보한 (dev,ino)와 unlink 직전 `lstat` 신원이
 * 같을 때만 unlink한다. 신원이 없거나 다르거나 unlink가 실패하면 **지우지 않고 문제 문자열을 돌려준다** —
 * 조용히 넘기지 않고(호출자가 mechanism 실패로 올린다) 남의 파일을 blind unlink하지도 않는다.
 * 반환: 문제 문자열 또는 null(정상 정리).
 */
function dropOwnTemp(tmp, id, label) {
  if (!id) return `${label} 임시 파일 신원을 확보하지 못해 정리하지 않았습니다(남의 파일 blind unlink 금지): ${tmp}`;
  let st;
  try {
    st = lstatSync(tmp);
  } catch (e) {
    if (e?.code === "ENOENT") return `${label} 임시 파일이 계약 밖에서 사라졌습니다 — 경로 간섭을 감지했습니다: ${tmp}`;
    return `${label} 임시 파일 확인 실패 [${e?.code ?? "unknown"}] — 정리하지 않았습니다: ${tmp}`;
  }
  if (!st.isFile() || st.dev !== id.dev || st.ino !== id.ino) {
    return `${label} 임시 파일이 다른 파일로 교체되어 정리하지 않았습니다 — 남의 파일을 지우지 않습니다: ${tmp}`;
  }
  try {
    unlinkSync(tmp);
  } catch (e) {
    return `${label} 임시 파일 정리 실패 [${e?.code ?? "unknown"}] — 잔재가 남았습니다: ${tmp}`;
  }
  return null;
}

/** 부분 write를 남기지 않는다: 전량을 쓰고, 진전이 없는 short write는 오류로 올린다. */
function writeAllSync(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (!Number.isSafeInteger(n) || n <= 0) {
      throw Object.assign(new Error("short write"), { code: "ESHORTWRITE" });
    }
    off += n;
  }
}

/**
 * 완성된 내용만 최종 이름으로 발행한다: 비공개 임시 파일 → write(전량) → fstat(신원) → close → `link`
 * → **최종 경로 lstat이 우리가 쓴 그 (dev,ino)인지 확인**.
 *
 *  - `{ published: true, dev, ino }` — dev/ino는 **항상 non-null**이다(불변식). 신원을 확인하지 못했거나
 *    최종 경로가 우리 파일이 아니면 **절대 성공을 반환하지 않는다**(Codex Sol xhigh P1-1).
 *  - `{ published: false }` — EEXIST(이미 대상이 있음). 호출자가 경합으로 해석한다.
 *  - 실패는 throw. `role="lock"`이면 **mechanism**(감싼 transition guard를 남긴다),
 *    `role="guard"`면 guard 발행 자체의 실패라 남길 guard가 없다.
 *  - 신원 확인 실패·불일치 시 **최종 경로를 지우지 않는다**: 그 파일이 우리 것이라는 증거가 없으므로
 *    남의 파일을 blind unlink하지 않고 그 자리에 남겨 이후 acquire를 막는다(fail closed).
 *  - write/close/link 실패는 임시 파일만 지우므로 최종 경로에 부분 기록이 남지 않는다.
 *  - **임시 파일 정리도 신원 확인 후에만** 한다(`dropOwnTemp`): 열자마자 fd로 확보한 (dev,ino)와 다르면
 *    지우지 않는다. 정리 실패·교체 감지는 조용히 넘기지 않고 `lock_publish_cleanup_failed`로 올려
 *    **성공 handle로 이어지지 않게** 한다(다섯 번째 리비전, Codex Sol xhigh P1-3).
 */
function publishFileExclusive(path, text, role, pause = null) {
  const failed = (code, message) => (role === "lock" ? mechanismFailure(code, message) : refusal(code, message));
  const label = role === "guard" ? "transition guard" : "lock";
  const tmp = `${path}.new.${randomBytes(8).toString("hex")}`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
  } catch (e) {
    throw failed("lock_create_failed", `${label} 임시 파일 생성 실패 [${e?.code ?? "unknown"}].`);
  }
  // 신원은 **열자마자** 확보한다. 이후 임시 파일 정리는 이 신원과 일치할 때만 한다(교체된 파일 삭제 금지).
  const tmpId = fdIdentity(fd);
  /** 임시 파일 정리 — 실패·신원 불일치를 삼키지 않고 문제 문자열로 돌려준다. */
  const dropTmp = () => dropOwnTemp(tmp, tmpId, label);
  /** 실패 경로: 원인 + (있다면) 임시 파일 정리 문제를 **함께** 보고한다. */
  const failWith = (code, message) => {
    const leftover = dropTmp();
    return failed(code, leftover ? `${message} / ${leftover}` : message);
  };
  let dev = null;
  let ino = null;
  try {
    writeAllSync(fd, text);
    if (!tmpId) throw Object.assign(new Error("temp identity unusable"), { code: "EIDENTITY" });
    dev = tmpId.dev;
    ino = tmpId.ino;
  } catch (e) {
    let closeProblem = "";
    try {
      closeSync(fd);
    } catch (ce) {
      closeProblem = ` / ${label} 임시 파일 close 실패 [${ce?.code ?? "unknown"}]`; // 조용히 넘기지 않는다
    }
    throw failWith(
      "lock_create_failed",
      `${label} 내용 기록 실패 [${e?.code ?? "unknown"}] — 최종 경로에 잔재를 남기지 않았습니다.${closeProblem}`,
    );
  }
  try {
    closeSync(fd);
  } catch (e) {
    throw failWith("lock_create_failed", `${label} 임시 파일 close 실패 [${e?.code ?? "unknown"}].`);
  }
  try {
    linkSync(tmp, path);
  } catch (e) {
    if (e?.code === "EEXIST") {
      // 경합(이미 대상 있음)이라도 임시 파일 정리 실패는 숨기지 않는다 — 정리 못 하면 발행 실패로 올린다.
      const leftover = dropTmp();
      if (leftover) throw failed("lock_publish_cleanup_failed", `${label} 발행 경합 후 정리 실패 — ${leftover}`);
      return { published: false };
    }
    throw failWith("lock_create_failed", `${label} 파일 발행 실패 [${e?.code ?? "unknown"}].`);
  }
  // link는 성공했지만 최종 경로가 **우리가 쓴 inode**인지 확인해야 발행을 성공이라 부를 수 있다.
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    throw failWith(
      "lock_publish_unverifiable",
      `${label} 발행 직후 신원 확인 실패 [${e?.code ?? "unknown"}] — 발행 결과가 불확실하므로 최종 경로를 건드리지 않고 ` +
        `거부합니다(fail closed). 잔존 프로세스를 확인한 뒤 남은 파일을 수동으로 제거하세요: ${path}`,
    );
  }
  if (!st.isFile() || st.dev !== dev || st.ino !== ino) {
    throw failWith(
      "lock_publish_identity_mismatch",
      `${label} 발행 직후 최종 경로가 우리가 쓴 파일이 아닙니다 — 계약 밖 경로 간섭을 감지해 중단합니다(fail closed). ` +
        `남의 파일을 지우지 않으므로 확인 후 수동으로 정리하세요: ${path}`,
    );
  }
  pauseHook(pause, "before_publish_tmp_cleanup");
  // 발행은 끝났지만 **임시 파일 정리 실패도 성공으로 넘기지 않는다**: 신원 확인된 우리 임시 파일을 지우지
  // 못했다면 전이 결과가 깨끗하지 않으므로 mechanism 실패로 올려 guard를 남긴다(fail closed).
  const leftover = dropTmp();
  if (leftover) {
    throw failed(
      "lock_publish_cleanup_failed",
      `${label} 발행 후 임시 파일 정리 실패 — 전이를 성공으로 보지 않습니다(fail closed). ` +
        `잔존 프로세스를 확인한 뒤 남은 파일을 수동으로 제거하세요. ${leftover}`,
    );
  }
  return { published: true, dev, ino };
}

// ── transition guard ─────────────────────────────────────────────────────────

export function guardPathFor(lockPath) {
  return `${lockPath}${GUARD_SUFFIX}`;
}

/**
 * guard record와 (dev,ino) 신원을 **한 fd에서 함께** 얻는다 — 내용 검사와 신원 검사가 같은 inode를
 * 가리키도록 묶기 위함이다(경로를 두 번 해석하지 않는다).
 * lock과 같은 이유로 최종 엔트리가 symlink면 열지 않는다(여섯 번째 리비전 P1): 그렇지 않으면
 * 소유 확인은 옮겨진 원본 guard를 보고 unlink는 symlink 엔트리를 지운다.
 */
function readGuardRecord(guardPath) {
  let fd;
  try {
    fd = openReadNoFollow(guardPath, "transition guard");
  } catch (e) {
    // symlink·O_NOFOLLOW 미지원·열기 실패 — 소유 확인 불가로 보고 제거하지 않는다(fail closed).
    return { gone: false, ok: false, record: null, dev: null, ino: null, openFailed: e instanceof SuiteLockError ? e.code : "unknown" };
  }
  if (fd === null) return { gone: true, ok: false, record: null, dev: null, ino: null };
  let raw;
  let st;
  let closeError = null;
  try {
    st = fstatSync(fd);
    raw = readFileSync(fd, "utf8");
  } catch {
    return { gone: false, ok: false, record: null, dev: null, ino: null };
  } finally {
    try {
      closeSync(fd);
    } catch (e) {
      closeError = e; // 조용히 넘기지 않는다 — 소유 확인 결과를 신뢰하지 않는다(fail closed)
    }
  }
  if (closeError) {
    return { gone: false, ok: false, record: null, dev: null, ino: null, closeFailed: closeError?.code ?? "unknown" };
  }
  if (!st.isFile() || !usableIdentity(st.dev, st.ino)) return { gone: false, ok: false, record: null, dev: null, ino: null };
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { gone: false, ok: false, record: null, dev: st.dev, ino: st.ino };
  }
  const ok =
    j &&
    typeof j === "object" &&
    !Array.isArray(j) &&
    j.v === LOCK_FILE_VERSION &&
    typeof j.purpose === "string" &&
    GUARD_PURPOSES.includes(j.purpose) &&
    Number.isSafeInteger(j.pid) &&
    j.pid > 0 &&
    (j.identity === null || (typeof j.identity === "string" && LSTART_RE.test(j.identity))) &&
    typeof j.nonce === "string" &&
    NONCE_RE.test(j.nonce);
  return { gone: false, ok: Boolean(ok), record: ok ? j : null, dev: st.dev, ino: st.ino };
}

/** guard 보유자 상태를 **진단 문자열**로만 만든다. 자동 제거·자동 인수는 절대 하지 않는다. */
function guardDiagnostic(guardPath) {
  const holder = readGuardRecord(guardPath);
  if (holder.gone) return "guard가 방금 사라짐(경합)";
  if (holder.openFailed) return `guard 열기 실패(${holder.openFailed})`;
  if (!holder.ok) return "guard 내용 확인 불가(손상/버전 불일치)";
  const owner = processIdentity(holder.record.pid);
  if (!owner.ok) return `guard 보유자 확인 불가(purpose=${holder.record.purpose})`;
  if (owner.identity && (holder.record.identity === null || owner.identity === holder.record.identity)) {
    return `guard 보유자 생존(purpose=${holder.record.purpose}) — 다른 전이가 진행 중`;
  }
  return `guard 보유자 사망(purpose=${holder.record.purpose}) — 전이 중 중단된 흔적`;
}

const guardPresentMessage = (guardPath) =>
  `lock 상태 전이 guard가 이미 존재합니다 [${guardDiagnostic(guardPath)}]. ` +
  "겹쳐 실행하지 않기 위해 거부합니다(fail closed). 다른 전이가 진행 중이면 잠시 후 재시도하고, " +
  `계속 남아 있으면 잔존 테스트 프로세스가 없는지 확인한 뒤 guard 파일을 **수동으로** 제거하세요: ${guardPath}`;

function acquireTransitionGuard(lockPath, purpose, identity, waitMs) {
  const guardPath = guardPathFor(lockPath);
  const nonce = randomBytes(16).toString("hex");
  const text = JSON.stringify({ v: LOCK_FILE_VERSION, purpose, pid: process.pid, identity: identity ?? null, nonce }) + "\n";
  const end = Date.now() + Math.max(0, Number.isSafeInteger(waitMs) ? waitMs : GUARD_WAIT_MS);
  for (;;) {
    // 발행 실패는 여기서 그대로 throw된다. 아직 guard를 쥔 적이 없으므로 남길 guard도 없고,
    // 신원이 불확실한 guard 파일은 **지우지 않은 채** 남아 이후 acquire를 막는다(fail closed).
    const r = publishFileExclusive(guardPath, text, "guard");
    if (r.published) return { guardPath, nonce, dev: r.dev, ino: r.ino };
    if (Date.now() >= end) throw refusal("lock_transition_guard_present", guardPresentMessage(guardPath));
    sleepSync(GUARD_POLL_MS);
  }
}

/**
 * 계약상 거부·정상 전이 성공 시에만, 그리고 **자기 nonce + 자기 inode를 확인한 뒤에만** guard를 제거한다.
 * 확인 실패·불일치·unlink 실패는 모두 guard를 **남기고**(fail closed) 문제로 보고한다 — 조용히 넘기지 않는다.
 *
 * 다섯 번째 리비전(Codex Sol xhigh P1-1): 소유 확인과 unlink 사이의 창을 최소화한다.
 *   ① 소유 확인(record+inode, 같은 fd) → ② 동기화 지점 → ③ **같은 fd에서 record+inode 재확인** →
 *   ④ 최종 경로 `lstat` 신원 재확인 → ⑤ unlink.
 * ②~⑤ 사이에 다른 nonce/inode guard로 교체되면 ③·④가 잡아내고 **그 guard를 지우지 않는다**.
 * Node 18에는 `unlinkat`·"compare-and-unlink" 원자 연산이 없어 ④와 ⑤ 사이 창을 **0으로 만들 수는 없다**.
 * 그래서 창을 syscall 두 개로 줄이고, 실패·불일치는 숨기지 않고 mechanism 실패로 올려(호출자가 판단)
 * guard가 남아 다음 실행을 막게 한다.
 *
 * 반환: `{ ok, problem }` — `ok:false`면 호출자가 mechanism 실패로 전파한다.
 */
function releaseTransitionGuard(guard, problems, pause, purpose) {
  /** 소유 확인 한 컷: record(nonce) + inode를 **같은 fd**에서 본다. */
  const verifyOwn = (phase) => {
    const holder = readGuardRecord(guard.guardPath);
    if (holder.gone) return `transition guard가 이미 없음(${phase}) — 계약 밖 제거 흔적`;
    if (holder.openFailed) return `transition guard 열기 실패 [${holder.openFailed}](${phase}) — 소유 확인 불확실, 제거하지 않음`;
    if (holder.closeFailed) return `transition guard fd close 실패 [${holder.closeFailed}](${phase}) — 소유 확인 불확실, 제거하지 않음`;
    if (!holder.ok || holder.record.nonce !== guard.nonce) return "transition guard 소유자 불일치 — 제거하지 않음";
    if (holder.dev !== guard.dev || holder.ino !== guard.ino) return "transition guard 신원(inode) 불일치 — 제거하지 않음";
    return null;
  };
  const fail = (problem) => {
    problems.push(problem);
    return { ok: false, problem };
  };

  let problem = verifyOwn("확인");
  if (problem) return fail(problem);
  // 지점 이름에 전이 종류를 붙여 **한 전이만** 멈춘다.
  pauseHook(pause, `before_guard_unlink_${purpose}`);
  // 동기화 지점(또는 임의의 지연) 사이에 guard가 교체됐을 수 있다 → 같은 방식으로 다시 확인한다.
  problem = verifyOwn("재확인");
  if (problem) return fail(problem);
  // unlink는 경로로 하므로, 최종 경로 신원을 **바로 직전에** 한 번 더 확인한다(창 최소화).
  try {
    const st = lstatSync(guard.guardPath);
    if (!st.isFile() || st.dev !== guard.dev || st.ino !== guard.ino) {
      return fail("transition guard 신원(inode)이 제거 직전에 달라짐 — 제거하지 않음");
    }
  } catch (e) {
    return fail(`transition guard 제거 직전 확인 실패 [${e?.code ?? "unknown"}] — 제거하지 않음`);
  }
  try {
    unlinkSync(guard.guardPath);
  } catch (e) {
    // ENOENT도 문제다: 우리가 신원을 확인한 그 파일이 계약 밖에서 사라졌다는 뜻이다.
    return fail(`transition guard 제거 실패 [${e?.code ?? "unknown"}] — guard가 남아 이후 전이를 막습니다(fail closed)`);
  }
  return { ok: true, problem: null };
}

/**
 * 모든 상태 전이의 공용 직렬화 지점.
 *
 * fn은 `{ value, retainGuard }`를 돌려준다. `retainGuard=true`면 guard를 남긴다.
 * throw 경로의 기준은 **분류**다(FAILURE_CLASSES): 상태를 바꾸지 않은 `refusal`만 guard를 반납하고,
 * `mechanism`·SuiteLockError가 아닌 예상 밖 예외는 전부 guard를 남긴다(fail closed 기본값).
 *
 * 다섯 번째 리비전(Codex Sol xhigh P1-3): **guard 반납 실패를 무시하지 않는다.**
 * 반납에 실패하면 전이가 완결되지 않은 것이므로 `lock_guard_release_failed`(mechanism)로 올린다 —
 * 그래야 acquire/reentry가 "성공 handle"을 돌려주고 suite 실행을 시작하는 일이 없다. guard는 남아
 * 이후 모든 전이를 막는다(fail closed). 원인 문자열은 오류 메시지에 함께 담아 조용히 사라지지 않게 한다.
 */
function withTransitionGuard(ctx, fn) {
  const guard = acquireTransitionGuard(ctx.lockPath, ctx.purpose, ctx.identity, ctx.waitMs);
  const releaseFailure = (rel, originCode) =>
    mechanismFailure(
      "lock_guard_release_failed",
      `lock 상태 전이(${ctx.purpose}) guard 반납이 완결되지 않았습니다 [${rel.problem}]` +
        (originCode ? ` (전이 결과: ${originCode})` : "") +
        `. 전이를 성공으로 보지 않고 guard를 남겨 이후 모든 실행을 거부합니다(fail closed). ` +
        `잔존 테스트 프로세스가 없는지 확인한 뒤 guard 파일을 **수동으로** 제거하세요: ${guard.guardPath}`,
    );
  let out;
  try {
    pauseHook(ctx.pause, `after_guard_${ctx.purpose}`);
    out = fn();
  } catch (e) {
    // 상태를 바꾸지 않은 계약상 거부만 guard를 반납한다. 그 반납마저 실패하면 원인을 함께 담아 올린다.
    if (e instanceof SuiteLockError && e.failure === "refusal") {
      const rel = releaseTransitionGuard(guard, ctx.problems, ctx.pause, ctx.purpose);
      if (!rel.ok) throw releaseFailure(rel, e.code);
    }
    throw e;
  }
  if (out?.retainGuard === true) return out?.value;
  const rel = releaseTransitionGuard(guard, ctx.problems, ctx.pause, ctx.purpose);
  if (!rel.ok) throw releaseFailure(rel, null);
  return out?.value;
}

// ── 거부 메시지 ──────────────────────────────────────────────────────────────

const heldMessage = (kind) =>
  `다른 전체 suite/stress 실행이 lock을 보유 중입니다(kind=${kind}). ` +
  "전역 프로세스/tmp 상태를 관측하는 테스트가 있어 겹쳐 실행하지 않습니다. 종료를 기다린 뒤 재시도하세요.";

const quarantineMessage = (reason, lockPath) =>
  `이전 실행이 소유 프로세스 정리를 확인하지 못해 lock이 격리(quarantine)되었습니다 [${reason}]. ` +
  "잔존 테스트 프로세스가 없는지 확인한 뒤 lock 파일을 **수동으로** 제거하기 전에는 새 suite를 시작하지 않습니다" +
  `(fail closed): ${lockPath}`;

const orphanMessage = (kind, lockPath) =>
  `lock 소유자(kind=${kind}) 프로세스가 이미 사라졌지만 정상 해제 기록이 없습니다 — orphan lock입니다. ` +
  "소유자의 죽음은 정리가 끝났다는 증거가 아니므로 **자동 회수하지 않습니다**(fail closed). " +
  `잔존 테스트 프로세스가 없는지 확인한 뒤 lock 파일을 수동으로 제거하세요: ${lockPath}`;

// ── acquire / release / quarantine ───────────────────────────────────────────

/** lock record의 기본(비격리) 필드 — 격리 rewrite는 이 필드들을 **보존**해야 한다. */
const BASE_RECORD_KEYS = ["v", "kind", "pid", "identity", "tokenHash"];
const sameBaseRecord = (a, b) => Boolean(a) && Boolean(b) && BASE_RECORD_KEYS.every((k) => a[k] === b[k]);
/** 신뢰 기준으로 **보존**할 기본 record만 뽑는다(격리 표시 등 가변 필드는 담지 않는다). */
const baseRecordOf = (record) => Object.fromEntries(BASE_RECORD_KEYS.map((k) => [k, record?.[k]]));

/**
 * guard 안에서 재확인하는 소유 검증: 파일 신원(dev+ino)과 tokenHash가 모두 우리 것이어야 한다.
 *
 * 순서에 의미가 있다(tokenHash → quarantined → inode). **추측 불가능한 tokenHash를 먼저** 본다 —
 * 다른 owner의 lock을 "inode가 달라졌다"로 뭉뚱그리지 않기 위함이다. token이 우리 것이면서 격리 표시가
 * 있는 경우는 정상적으로 일어난다(재진입 child가 우리 lock을 격리한 상태): 격리는 임시 파일 → rename이라
 * **inode가 바뀌므로** inode 검사보다 먼저 판정해야 한다.
 *
 * 다만 "token이 같다"만으로 외부 교체를 허용하지는 않는다: 격리 rewrite는 기본 record
 * (v/kind/pid/identity/tokenHash)를 **그대로 보존**해야 하며, 하나라도 달라지면 계약 밖 교체로 보고
 * 아무것도 하지 않는다(mechanism 실패로 올려 guard를 남긴다).
 */
function verifyOwnership(lockPath, expected, tokenHash) {
  let snap;
  try {
    snap = readLockSnapshot(lockPath);
  } catch (e) {
    return { ok: false, gone: false, problem: `lock 소유 확인 실패 [${e?.code ?? "unknown"}] — 건드리지 않음`, record: null };
  }
  if (snap.gone) return { ok: false, gone: true, problem: "lock 파일이 이미 없음", record: null };
  if (!hashEquals(String(snap.record.tokenHash ?? ""), tokenHash)) {
    return { ok: false, gone: false, problem: "lock 소유자 불일치 — 건드리지 않음", record: null };
  }
  if (expected.record && !sameBaseRecord(snap.record, expected.record)) {
    return { ok: false, gone: false, problem: "lock record가 우리가 발행한 내용과 다름 — 계약 밖 교체이므로 건드리지 않음", record: null };
  }
  if (snap.record.quarantined) {
    return { ok: false, gone: false, quarantined: true, problem: null, record: snap.record, dev: snap.dev, ino: snap.ino };
  }
  if (snap.dev !== expected.dev || snap.ino !== expected.ino) {
    return { ok: false, gone: false, problem: "lock 파일 신원(inode) 불일치 — 건드리지 않음", record: null };
  }
  return { ok: true, gone: false, problem: null, record: snap.record, dev: snap.dev, ino: snap.ino };
}

/**
 * 격리 표시는 원자적으로 교체한다(임시 파일 → write 전량 → fstat → close → **원본 신원 재확인** → rename
 * → 사후 신원 확인). guard 안 + 신원 확인 후에만 호출된다. 어떤 단계든 실패하면 문제를 돌려주고
 * 호출자가 guard를 남긴다.
 *
 * 다섯 번째 리비전(Codex Sol xhigh P1-2): 마지막 원본 신원 확인이 temp write/close **앞**에만 있으면
 * 그 사이(수 밀리초~pause) 외부 행위자가 lock을 교체했을 때 rename이 **남의 파일을 덮는다**. 그래서
 * temp close가 성공한 뒤 **rename 직전에** `readLockSnapshot`으로 기본 record와 (dev,ino)를 다시 확인하고,
 * 하나라도 다르면 rename하지 않고 외부 lock을 **그대로 보존**한다(호출자가 guard를 남긴다).
 * `expected.record`가 없으면 비교 기준이 없으므로 아무것도 덮지 않는다.
 */
function writeQuarantineRecord(path, record, expected, pause = null) {
  if (!expected?.record) {
    return { problems: ["격리 비교 기준(기본 record)이 없어 덮지 않음 — 소유 증거 없이 rename하지 않습니다"], dev: null, ino: null };
  }
  /** 원본이 여전히 "우리가 아는 그 lock"인지 — 기본 record + (dev,ino)를 같은 fd에서 확인한다. */
  const verifyBase = (phase) => {
    let snap;
    try {
      snap = readLockSnapshot(path);
    } catch (e) {
      return `lock 격리 ${phase} 확인 실패 [${e instanceof SuiteLockError ? e.code : (e?.code ?? "unknown")}] — 덮지 않음`;
    }
    if (snap.gone) return `lock 파일이 격리 ${phase}에 사라짐 — 덮지 않음`;
    if (!sameBaseRecord(snap.record, expected.record)) {
      return `lock record가 격리 ${phase}에 우리가 아는 내용과 달라짐 — 계약 밖 교체이므로 덮지 않음`;
    }
    if (snap.dev !== expected.dev || snap.ino !== expected.ino) return `lock 신원(inode)이 격리 ${phase}에 달라짐 — 덮지 않음`;
    return null;
  };

  const before = verifyBase("직전");
  if (before) return { problems: [before], dev: null, ino: null };

  const tmp = `${path}.q.${randomBytes(8).toString("hex")}`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
  } catch (e) {
    return { problems: [`lock 격리 임시 파일 생성 실패 [${e?.code ?? "unknown"}] — lock을 그대로 둡니다`], dev: null, ino: null };
  }
  // 임시 파일 신원을 열자마자 확보한다 — 정리도 이 신원과 일치할 때만 한다(교체된 파일 삭제 금지).
  const tmpId = fdIdentity(fd);
  /** 정리 문제는 삼키지 않고 problems에 함께 담는다. */
  const withDrop = (problem) => {
    const leftover = dropOwnTemp(tmp, tmpId, "lock 격리");
    return { problems: leftover ? [problem, leftover] : [problem], dev: null, ino: null };
  };
  let dev = null;
  let ino = null;
  try {
    writeAllSync(fd, JSON.stringify(record) + "\n"); // short write도 오류다(부분 기록 금지)
    if (!tmpId) throw Object.assign(new Error("quarantine temp identity unusable"), { code: "EIDENTITY" });
    dev = tmpId.dev;
    ino = tmpId.ino;
  } catch (e) {
    let closeProblem = "";
    try {
      closeSync(fd);
    } catch (ce) {
      closeProblem = ` / 격리 임시 파일 close 실패 [${ce?.code ?? "unknown"}]`;
    }
    return withDrop(`lock 격리 기록 실패 [${e?.code ?? "unknown"}] — lock을 그대로 둡니다${closeProblem}`);
  }
  try {
    closeSync(fd);
  } catch (e) {
    // close 실패는 flush 실패일 수 있다 → 조용히 넘기지 않고 격리 실패로 보고한다(rename하지 않는다).
    return withDrop(`lock 격리 임시 파일 close 실패 [${e?.code ?? "unknown"}] — lock을 그대로 둡니다`);
  }
  // temp가 완성된 **뒤**, rename **직전**에 원본 신원을 다시 확인한다(그 사이 교체된 외부 lock 보호).
  pauseHook(pause, "before_quarantine_rename");
  const beforeRename = verifyBase("rename 직전");
  if (beforeRename) return withDrop(beforeRename);
  try {
    renameSync(tmp, path);
  } catch (e) {
    return withDrop(`lock 격리 반영 실패 [${e?.code ?? "unknown"}] — lock을 그대로 둡니다`);
  }
  // rename은 원자적이다 → 직후 최종 경로가 우리가 쓴 inode가 아니면 계약 밖 간섭이다(되돌리지 않고 보고).
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.dev !== dev || st.ino !== ino) {
      return { problems: ["lock 격리 직후 최종 경로가 우리가 쓴 파일이 아님 — 계약 밖 경로 간섭"], dev: null, ino: null };
    }
  } catch (e) {
    return { problems: [`lock 격리 직후 신원 확인 실패 [${e?.code ?? "unknown"}] — 격리 결과가 불확실합니다`], dev: null, ino: null };
  }
  return { problems: [], dev, ino };
}

/**
 * 배타 lock을 획득한다. 실패는 SuiteLockError(throw)이며 호출자는 exit 2로 거부해야 한다.
 *
 * opts: { kind, lockPath?, psFixture?, pause?, token?, skipDetection?, guardWaitMs? }
 *   — 모두 명시 옵션이다. 이 함수는 process.env를 읽지 않는다.
 * 반환: { path, guardPath, kind, token, warnings, state, released, quarantined, release(), quarantine(reason) }
 */
export function acquireSuiteLock(opts = {}) {
  const kind = opts.kind ?? "suite";
  if (!LOCK_KINDS.includes(kind)) throw refusal("lock_kind_invalid", "lock kind가 계약에 없습니다.");
  const lockPath = resolveLockPath(opts.lockPath);
  const pause = normalizePause(opts.pause);
  const waitMs = Number.isSafeInteger(opts.guardWaitMs) ? opts.guardWaitMs : GUARD_WAIT_MS;

  const self = processIdentity(process.pid);
  if (!self.ok || !self.identity) {
    throw refusal("self_identity_unavailable", "자기 프로세스 신원(ps lstart) 확인 실패 — fail closed로 거부합니다.");
  }

  const token = opts.token ?? randomBytes(32).toString("hex");
  if (!TOKEN_RE.test(token)) throw refusal("lock_token_invalid", "ownership token 형식이 올바르지 않습니다.");
  const tokenHash = sha256(token);
  const record = { v: LOCK_FILE_VERSION, kind, pid: process.pid, identity: self.identity, tokenHash };
  const warnings = [];

  const published = withTransitionGuard(
    { lockPath, purpose: "acquire", identity: self.identity, waitMs, pause, problems: warnings },
    () => {
      // (1) guard 안에서 현재 lock 상태를 확인한다. 존재하면 **어떤 경우에도 회수하지 않는다**.
      const existing = readLockSnapshot(lockPath);
      if (!existing.gone) {
        if (existing.record.quarantined) {
          throw refusal("lock_quarantined", quarantineMessage(existing.record.quarantineReason, lockPath));
        }
        const owner = processIdentity(existing.record.pid);
        if (!owner.ok) {
          throw refusal("lock_unverifiable", "기존 lock 소유자 확인(ps) 실패 — 회수하지 않고 거부합니다(fail closed).");
        }
        if (owner.identity && owner.identity === existing.record.identity) {
          throw refusal("lock_held", heldMessage(existing.record.kind));
        }
        throw refusal("lock_orphaned", orphanMessage(existing.record.kind, lockPath));
      }
      // (2) lock을 만들기 **전에** backstop 스캔 — 거부 시 파일을 만들지도, 지우지도 않는다.
      if (!opts.skipDetection) {
        const table = readPsTable(opts.psFixture);
        if (!table.ok) {
          throw refusal(
            "ps_unavailable",
            `\`ps\` 확인 실패 [${table.code}] — 동시 실행 suite 유무를 확인할 수 없어 거부합니다(fail closed).`,
          );
        }
        const found = detectSuiteRows(table.rows, process.pid);
        if (found.length > 0) {
          throw refusal(
            "concurrent_suite",
            `lock 없이 실행 중인 테스트 suite 프로세스 ${found.length}건 감지 — 겹쳐 실행하지 않습니다. ` +
              "(전역 프로세스/tmp 상태를 관측하는 테스트는 격리 실행이 전제입니다.)",
          );
        }
      }
      // (3) 발행. guard를 쥐고 있으므로 EEXIST는 계약 밖 writer를 뜻한다 → fail closed.
      pauseHook(pause, "before_publish");
      const out = publishFileExclusive(lockPath, JSON.stringify(record) + "\n", "lock", pause);
      if (!out.published) {
        throw mechanismFailure(
          "lock_publish_conflict",
          "transition guard를 보유한 상태인데 lock 파일이 이미 생겨 있습니다 — 계약 밖 writer가 있어 거부합니다(fail closed).",
        );
      }
      return { value: out, retainGuard: false };
    },
  );

  /**
   * 전이 결과 공표(여섯 번째 리비전 P2). `withTransitionGuard`가 **정상 반환한 뒤에만** 호출된다 —
   * 즉 guard 반납까지 완결됐을 때만 `released`/`quarantined`가 참이 된다. guard 반납이 실패하면
   * `withTransitionGuard`가 throw하므로 이 함수에 도달하지 않고, 호출부의 catch가 `failed`로 확정한다.
   */
  const publishState = (outcome, problems) => {
    const next = outcome?.state;
    if (next === "released" || next === "quarantined" || next === "failed") {
      handle.state = next;
      return;
    }
    handle.state = "failed";
    problems.push("전이 결과를 확정할 수 없어 실패로 처리합니다(fail closed)");
  };

  const handle = {
    path: lockPath,
    guardPath: guardPathFor(lockPath),
    kind,
    token,
    warnings,
    /** 발행 성공의 불변식: dev/ino는 non-null이며 이후 모든 전이가 이 신원을 요구한다. */
    dev: published.dev,
    ino: published.ino,
    /** 우리가 발행한 기본 record — 격리 rewrite가 이 내용을 보존했는지 확인하는 기준이다. */
    record,
    identity: self.identity,
    /** "held" → "released" | "quarantined" | "failed" */
    state: "held",
    get released() {
      return handle.state === "released";
    },
    get quarantined() {
      return handle.state === "quarantined";
    },

    /**
     * guard 안에서 token+inode를 재확인한 뒤에만 해제한다. 전이 오류는 guard를 남긴다(fail closed).
     *
     * 여섯 번째 리비전 P2: 전이 콜백은 **결과만 값으로 돌려주고 `handle.state`를 직접 바꾸지 않는다.**
     * `handle.state`는 `withTransitionGuard`가 정상 반환(= guard 반납 완결)한 뒤에만 바뀌므로,
     * lock unlink 뒤에 guard 반납이 실패하면 `released`가 참이 되는 경로가 없다.
     */
    release() {
      if (handle.state !== "held") return [];
      const problems = [];
      try {
        const outcome = withTransitionGuard(
          { lockPath, purpose: "release", identity: handle.identity, waitMs, pause, problems },
          () => {
            const owned = verifyOwnership(lockPath, handle, tokenHash);
            if (owned.gone) {
              // 우리가 보유 중인 lock이 계약 밖에서 사라졌다. "해제됨"으로 보면 잔재가 남았는데도 다음 suite가
              // 시작될 수 있으므로, 간섭을 감지한 것으로 보고 guard를 남긴다(fail closed).
              problems.push("보유 중인 lock 파일이 계약 밖에서 사라짐 — transition guard를 남깁니다(fail closed)");
              return { value: { state: "failed" }, retainGuard: true };
            }
            if (owned.quarantined) {
              // 재진입 child 등이 정리 확인 실패로 격리해 둔 lock은 소유자라도 해제하지 않는다(fail closed).
              // 아무것도 바꾸지 않은 no-op이므로 guard는 정상 반납한다 — 격리 표시 자체가 차단 흔적이다.
              problems.push(`lock이 격리 상태[${owned.record.quarantineReason}] — 해제하지 않음`);
              return { value: { state: "quarantined" }, retainGuard: false };
            }
            if (!owned.ok) {
              problems.push(owned.problem);
              return { value: { state: "failed" }, retainGuard: true };
            }
            pauseHook(pause, "before_unlink");
            const recheck = verifyOwnership(lockPath, handle, tokenHash);
            if (recheck.gone) {
              problems.push("보유 중인 lock 파일이 계약 밖에서 사라짐 — transition guard를 남깁니다(fail closed)");
              return { value: { state: "failed" }, retainGuard: true };
            }
            if (recheck.quarantined) {
              problems.push(`lock이 격리 상태[${recheck.record.quarantineReason}] — 해제하지 않음`);
              return { value: { state: "quarantined" }, retainGuard: false };
            }
            if (!recheck.ok) {
              problems.push(recheck.problem);
              return { value: { state: "failed" }, retainGuard: true };
            }
            try {
              unlinkSync(lockPath);
            } catch (e) {
              // ENOENT도 실패다: 신원까지 확인한 그 파일이 우리 unlink 직전에 사라졌다는 뜻이므로
              // 계약 밖 간섭으로 보고 guard를 남긴다(fail closed).
              problems.push(`lock 해제 실패 [${e?.code ?? "unknown"}] — transition guard를 남깁니다(fail closed)`);
              return { value: { state: "failed" }, retainGuard: true };
            }
            // lock 파일은 사라졌지만 아직 **해제 완료가 아니다** — guard 반납이 성공해야 released다.
            return { value: { state: "released" }, retainGuard: false };
          },
        );
        publishState(outcome, problems);
      } catch (e) {
        // guard 반납 실패(`lock_guard_release_failed`)를 포함한 모든 전이 실패는 여기로 온다.
        // 콜백이 상태를 바꾸지 않으므로 lock unlink 후 guard 반납 실패도 released가 아니라 failed다.
        if (handle.state === "held") handle.state = "failed";
        problems.push(`lock 해제 전이 실패 [${e instanceof SuiteLockError ? e.code : "unknown"}]`);
      }
      return problems;
    },

    /**
     * 소유 프로세스 소멸을 확인하지 못한 채 종료해야 할 때 쓴다. lock을 **해제하지 않고** 격리 표시만 남긴다.
     * 격리된 lock은 소유자가 죽어도 회수 대상이 아니므로 다른 suite가 이어받지 못한다(fail closed).
     * 격리 기록 자체가 실패하면 guard를 남겨 새 acquire를 거부한다.
     *
     * release와 같은 완결 규칙을 쓴다(여섯 번째 리비전 P2): 콜백은 결과만 돌려주고, `quarantined`는
     * guard 반납까지 성공한 뒤에만 참이 된다. 격리 기록은 성공했지만 guard 반납이 실패하면 `failed`다
     * (디스크의 격리 표시 + 남은 guard가 함께 다음 실행을 막으므로 노출 위험은 없다).
     */
    quarantine(reason) {
      if (handle.state === "released" || handle.state === "quarantined") return [];
      const code = QUARANTINE_REASON_RE.test(String(reason ?? "")) ? String(reason) : "cleanup_unconfirmed";
      const problems = [];
      try {
        const outcome = withTransitionGuard(
          {
            lockPath,
            purpose: "quarantine",
            identity: handle.identity,
            waitMs: Number.isSafeInteger(opts.quarantineGuardWaitMs) ? opts.quarantineGuardWaitMs : waitMs,
            pause,
            problems,
          },
          () => {
            const owned = verifyOwnership(lockPath, handle, tokenHash);
            if (owned.gone) {
              // 정리를 확인하지 못했는데 lock도 사라졌다 → 표시할 대상이 없다. guard를 남겨 새 suite를 막는다.
              problems.push("lock 파일이 이미 없어 격리하지 못함 — transition guard를 남깁니다(fail closed)");
              return { value: { state: "failed" }, retainGuard: true };
            }
            if (owned.quarantined) {
              // 이미 격리됨(예: 재진입 child가 표시) — 목표 달성. 공표는 guard 반납 뒤에 한다.
              return { value: { state: "quarantined" }, retainGuard: false };
            }
            if (!owned.ok) {
              problems.push(owned.problem);
              return { value: { state: "failed" }, retainGuard: true };
            }
            pauseHook(pause, "before_quarantine_write");
            const w = writeQuarantineRecord(lockPath, { ...owned.record, quarantined: true, quarantineReason: code }, handle, pause);
            if (w.problems.length > 0) {
              problems.push(...w.problems);
              return { value: { state: "failed" }, retainGuard: true };
            }
            return { value: { state: "quarantined", dev: w.dev, ino: w.ino }, retainGuard: false };
          },
        );
        if (outcome?.state === "quarantined" && usableIdentity(outcome.dev, outcome.ino)) {
          handle.dev = outcome.dev;
          handle.ino = outcome.ino;
        }
        publishState(outcome, problems);
      } catch (e) {
        handle.state = "failed";
        problems.push(`lock 격리 전이 실패 [${e instanceof SuiteLockError ? e.code : "unknown"}]`);
      }
      return problems;
    },
  };

  return handle;
}

/**
 * 재진입 child가 자기 그룹 정리를 확인하지 못했을 때, 보유한 ownership token으로 **상위 lock을 격리**한다.
 * token이 일치하지 않으면 아무것도 하지 않는다(남의 lock을 건드리지 않는다).
 *
 * 다섯 번째 리비전(Codex Sol xhigh P1-4): **tokenHash만으로 소유권을 인정하지 않는다.**
 * `expected`는 성공한 재진입 시점의 **신뢰 기준**(기본 record + dev/ino)이며 필수다
 * (`tryReenterSuiteLock`이 돌려주는 `base`를 cleanup까지 명시 전달한다). 재진입 이후 같은 tokenHash를
 * 가졌지만 pid/identity 등 기본 record가 다른 외부 lock으로 교체되면 그 lock을 **보존**하고
 * guard를 남긴다(fail closed) — 새 기준을 받아 남의 lock을 격리하지 않는다.
 *
 * opts: { lockPath?, token, expected: { record, dev, ino }, reason?, pause?, guardWaitMs? }
 */
export function quarantineByToken(opts = {}) {
  const token = opts.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return ["재진입 token이 없어 격리하지 못함"];
  const expected = opts.expected;
  if (!expected?.record || !usableIdentity(expected.dev, expected.ino)) {
    return ["재진입 시점의 신뢰 기준(기본 record + inode)이 없어 격리하지 못함 — tokenHash만으로는 소유권을 인정하지 않습니다"];
  }
  const code = QUARANTINE_REASON_RE.test(String(opts.reason ?? "")) ? String(opts.reason) : "cleanup_unconfirmed";
  let lockPath;
  let pause;
  try {
    lockPath = resolveLockPath(opts.lockPath);
    pause = normalizePause(opts.pause);
  } catch (e) {
    return [`lock 경로 확인 실패 [${e instanceof SuiteLockError ? e.code : "unknown"}] — 격리하지 못함`];
  }
  const self = processIdentity(process.pid);
  const problems = [];
  try {
    withTransitionGuard(
      {
        lockPath,
        purpose: "quarantine",
        identity: self.ok ? self.identity : null,
        waitMs: Number.isSafeInteger(opts.guardWaitMs) ? opts.guardWaitMs : GUARD_WAIT_MS,
        pause,
        problems,
      },
      () => {
        let snap;
        try {
          snap = readLockSnapshot(lockPath);
        } catch (e) {
          problems.push(`lock 소유 확인 실패 [${e instanceof SuiteLockError ? e.code : "unknown"}] — 격리하지 못함`);
          return { retainGuard: true };
        }
        if (snap.gone) {
          problems.push("lock 파일이 이미 없어 격리하지 못함 — transition guard를 남깁니다(fail closed)");
          return { retainGuard: true };
        }
        // 순서는 `verifyOwnership`과 같다: **tokenHash → 기본 record 동일성 → 격리 여부 → inode**.
        // ① 추측 불가능한 tokenHash를 먼저 본다(남의 격리 lock을 우리 성공으로 착각하지 않는다).
        // ② tokenHash가 같아도 기본 record가 재진입 시점과 다르면 계약 밖 교체다 → 건드리지 않는다.
        // ③ 격리 표시는 inode보다 먼저 본다(격리 rewrite는 rename이라 inode가 바뀐다).
        if (!hashEquals(sha256(token), snap.record.tokenHash)) {
          problems.push("재진입 token이 lock 소유권과 달라 격리하지 않음");
          return { retainGuard: false }; // 우리 lock이 아니다 — 아무것도 바꾸지 않았다
        }
        if (!sameBaseRecord(snap.record, expected.record)) {
          problems.push(
            "lock record가 재진입 시점과 다름 — 같은 tokenHash라도 계약 밖 교체이므로 격리하지 않고 " +
              "transition guard를 남깁니다(fail closed)",
          );
          return { retainGuard: true };
        }
        if (snap.record.quarantined) return { retainGuard: false }; // 우리 lock이고 이미 격리됨 — 목표 달성
        if (snap.dev !== expected.dev || snap.ino !== expected.ino) {
          problems.push("lock 파일 신원(inode)이 재진입 시점과 다름 — 격리하지 않고 transition guard를 남깁니다(fail closed)");
          return { retainGuard: true };
        }
        pauseHook(pause, "before_quarantine_write");
        const w = writeQuarantineRecord(
          lockPath,
          { ...snap.record, quarantined: true, quarantineReason: code },
          { record: expected.record, dev: snap.dev, ino: snap.ino },
          pause,
        );
        if (w.problems.length > 0) {
          problems.push(...w.problems);
          return { retainGuard: true };
        }
        return { retainGuard: false };
      },
    );
  } catch (e) {
    problems.push(`lock 격리 전이 실패 [${e instanceof SuiteLockError ? e.code : "unknown"}]`);
  }
  return problems;
}

/**
 * 상위 lock 소유자가 넘겨준 ownership token으로 재진입한다(stress → 자기 소유 `npm test` child).
 * 검증도 transition guard 안에서 한다 — 전이 중간 상태를 읽고 들어가지 않기 위함이다(읽기만 하며 파일을 바꾸지 않는다).
 *  - token 미지정 → null (호출자는 정상 획득 경로로 간다)
 *  - token이 현재 lock 파일의 hash와 일치 → 재진입 허용(lock을 새로 잡지도, 해제하지도 않는다)
 *  - 불일치/파일 부재/격리됨/guard 존재 → fail closed throw
 *
 * 반환의 `base`는 **성공한 재진입 시점의 신뢰 기준**(기본 record + dev/ino)이다. 이후 이 child가
 * 상위 lock을 격리할 때 이 기준을 그대로 넘겨야 하며(`quarantineByToken({ expected })`), 그래야 같은
 * tokenHash를 가진 외부 교체 lock을 새 기준으로 받아들이지 않는다(다섯 번째 리비전 P1-4).
 *
 * opts: { lockPath?, token, guardWaitMs?, pause? }
 */
export function tryReenterSuiteLock(opts = {}) {
  const token = opts.token;
  if (typeof token !== "string" || token.trim().length === 0) return null;
  if (!TOKEN_RE.test(token)) throw refusal("reentry_token_invalid", "재진입 token 형식이 올바르지 않습니다 — 거부합니다(fail closed).");
  const lockPath = resolveLockPath(opts.lockPath);
  const pause = normalizePause(opts.pause);
  const self = processIdentity(process.pid);
  const problems = [];
  const verified = withTransitionGuard(
    {
      lockPath,
      purpose: "reentry",
      identity: self.ok ? self.identity : null,
      waitMs: Number.isSafeInteger(opts.guardWaitMs) ? opts.guardWaitMs : GUARD_WAIT_MS,
      pause,
      problems,
    },
    () => {
      let snap;
      try {
        snap = readLockSnapshot(lockPath);
      } catch (e) {
        if (e instanceof SuiteLockError) {
          throw refusal("reentry_lock_unverifiable", "재진입 대상 lock을 확인할 수 없습니다 — 거부합니다(fail closed).");
        }
        throw e;
      }
      if (snap.gone) {
        throw refusal("reentry_lock_missing", "재진입 token이 있으나 lock 파일이 없습니다 — 거부합니다(fail closed).");
      }
      if (snap.record.quarantined) {
        throw refusal("reentry_lock_quarantined", quarantineMessage(snap.record.quarantineReason, lockPath));
      }
      if (!hashEquals(sha256(token), snap.record.tokenHash)) {
        throw refusal("reentry_token_invalid", "재진입 token이 lock 소유권과 일치하지 않습니다 — 거부합니다(fail closed).");
      }
      if (!usableIdentity(snap.dev, snap.ino)) {
        throw refusal("reentry_lock_unverifiable", "재진입 대상 lock의 신원(inode)을 확보할 수 없습니다 — 거부합니다(fail closed).");
      }
      // 이후 격리까지 들고 갈 신뢰 기준을 여기서 고정한다(가변 필드는 담지 않는다).
      return { value: { record: snap.record, base: { record: baseRecordOf(snap.record), dev: snap.dev, ino: snap.ino } }, retainGuard: false };
    },
  );
  return { path: lockPath, token, kind: verified.record.kind, reentered: true, warnings: problems, base: verified.base };
}
