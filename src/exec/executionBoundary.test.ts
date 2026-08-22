/**
 * V3 M5a — 실행 경계(대장 `B-5`) 테스트. 실제 git을 임시 레포에서 돌린다(로컬·무네트워크·무과금).
 * 실행: `npx tsx --test src/exec/executionBoundary.test.ts` 또는 `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";
import { GIT_SANITIZED_ENV, verifyExecutionBoundary, type ExecutionBoundaryInput } from "./executionBoundary.js";
import { OrchestrationError } from "./orchestrationTypes.js";

const FUTURE = "2099-12-31T00:00:00.000Z";

/**
 * 테스트용 신뢰 git 경로. **테스트 안에서만** `PATH`를 훑어 찾고, 찾은 뒤 realpath로 정규화한다
 * (production 코드는 여전히 이름 조회를 하지 않는다 — 경로는 호출자가 준다).
 */
function findGit(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      const real = realpathSync(join(dir, "git"));
      if (lstatSync(real).isFile()) return real;
    } catch {
      /* 다음 후보 */
    }
  }
  throw new Error("테스트용 git 실행 파일을 PATH에서 찾지 못했다");
}
const GIT = findGit();

/** 파일 내용 digest — 승인 record에 적을 값이다(6차 리뷰 A1). */
function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
const GIT_SHA = digestOf(GIT);

/** 경계는 이제 git 경로를 **승인 manifest에서만** 읽는다 — 호출자 옵션이 없다. */
function verify(input: ExecutionBoundaryInput) {
  return verifyExecutionBoundary(input);
}

/**
 * 승인된 실행 권위(6차 리뷰 A1). git은 실제로 실행되므로 실측 경로·digest이고, codex는 이 경계가
 * 열지 않으므로 형태만 있으면 된다.
 */
function authority(over: { path?: string; sha256?: string } = {}) {
  return {
    codex: { path: "/opt/harness/codex", sha256: "c".repeat(64) },
    // M5c(v2) + 3A 2차 리비전: node·processObserver·controllerEntrypoint도 승인 대상이다. 이 경계는
    // git만 실제로 열므로 나머지는 형태만 있으면 된다(경로가 존재하지 않아도 되는 이유 = spawn 0).
    controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
    git: { path: over.path ?? GIT, sha256: over.sha256 ?? GIT_SHA },
    node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
    processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
  };
}

/** git만 바꾼 승인 권위(나머지 셋은 v2 필수 필드이므로 그대로 유지한다). */
function authorityWithGit(git: { path: string; sha256: string }) {
  return { ...authority(), git };
}

/** M5c(v2) autopilot 정책 — 없으면 manifest_pre_m5c_unsupported다(조용한 기본값이 없다). */
const AUTOPILOT_POLICY = {
  maxTaskAttempts: 2,
  maxDeliveryAttempts: 2,
  retryBackoffMs: 0,
  deliveryDeadlineMs: 30_000,
  maxNoProgressMs: 30_000,
  maxAttemptElapsedMs: 30_000,
  cleanupTermGraceMs: 500,
  cleanupKillGraceMs: 500,
};

function manifest(over: Record<string, unknown> = {}) {
  return {
    milestoneId: "m5a",
    approvedCommit: "a".repeat(40),
    writableRoots: ["src"],
    ownershipByTask: { "task-1": ["src"] },
    allowedCommands: ["npm run build"],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: authority(),
    autopilotPolicy: AUTOPILOT_POLICY,
    operationAuthorityByTask: {},
    maxSessions: 2,
    maxTokens: 1000,
    maxElapsedMs: 60_000,
    localMergeAllowed: false,
    expiresAt: FUTURE,
    ...over,
  };
}

/** 커밋 1개 있는 임시 git 레포 → { root(realpath), head }. */
async function initRepo(prefix = "m5a-boundary-", marker = "a"): Promise<{ root: string; head: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  await runProcess("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await runProcess("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await runProcess("git", ["-C", dir, "config", "user.name", "t"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  // marker로 내용을 갈라 둔다 — 같은 초에 만든 동일 내용 커밋은 해시까지 같아진다.
  writeFileSync(join(dir, "src", "a.txt"), `${marker}\n`);
  await runProcess("git", ["-C", dir, "add", "."]);
  await runProcess("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  const head = (await runProcess("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  return { root: dir, head };
}

/** 두 번째 커밋을 만들어 HEAD를 움직인다. */
async function advance(root: string): Promise<string> {
  writeFileSync(join(root, "src", "b.txt"), "b\n");
  await runProcess("git", ["-C", root, "add", "."]);
  await runProcess("git", ["-C", root, "commit", "-q", "-m", "next"]);
  return (await runProcess("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

async function code(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
    return "(통과)";
  } catch (err) {
    assert.ok(err instanceof OrchestrationError, `OrchestrationError가 아니다: ${String(err)}`);
    return (err as OrchestrationError).code;
  }
}

test("[M5a] controller = 실행 checkout이고 HEAD가 승인 커밋이면 통과(대조 1회)", async () => {
  const repo = await initRepo();
  try {
    const v = await verify({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    assert.equal(v.sameCheckout, true);
    assert.equal(v.approvedCommit, repo.head);
    assert.equal(v.controllerRoot, repo.root);
    assert.equal(v.targetRoot, repo.root);
    v.revalidateSync(); // spawn 직전 재확인도 통과해야 한다
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] HEAD가 승인 커밋이 아니면 approved_commit_mismatch", async () => {
  const repo = await initRepo();
  try {
    assert.equal(
      await code(() =>
        verify({ manifest: manifest(), controllerRepoRoot: repo.root, targetWorktree: repo.root }),
      ),
      "approved_commit_mismatch",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] controller와 실행 worktree가 다르면 양쪽 HEAD를 모두 대조한다", async () => {
  const repo = await initRepo();
  const wt = join(repo.root, "..", `m5a-wt-${process.pid}`);
  try {
    await runProcess("git", ["-C", repo.root, "worktree", "add", "-q", "-b", "work/m5a-test", wt]);
    const wtReal = realpathSync(wt);

    const ok = await verify({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: wtReal,
    });
    assert.equal(ok.sameCheckout, false);
    assert.equal(ok.targetRoot, wtReal);
    ok.revalidateSync();

    await advance(wtReal); // 실행 worktree만 앞서 나가면 거부
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: wtReal,
        }),
      ),
      "approved_commit_mismatch",
    );
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] manifest 누락·형태 위반은 승인 규칙 그대로 거부한다", async () => {
  const repo = await initRepo();
  try {
    const call = (m: unknown) =>
      verify({ manifest: m, controllerRepoRoot: repo.root, targetWorktree: repo.root });
    assert.equal(await code(() => call(undefined)), "invalid_manifest");
    // 빈 객체는 **v2 필수 절이 없는 manifest**이므로 M5c 전용 fail-closed 코드로 거부된다
    // (마이그레이션·기본값 채우기는 곧 조용한 자동 승인이므로 하지 않는다).
    assert.equal(await code(() => call({})), "manifest_pre_m5c_unsupported");
    assert.equal(await code(() => call(manifest({ approvedCommit: repo.head.slice(0, 7) }))), "invalid_manifest");
    assert.equal(await code(() => call(manifest({ approvedCommit: "main" }))), "invalid_manifest");
    assert.equal(await code(() => call(manifest({ extra: 1 }))), "invalid_manifest");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 만료된 manifest는 실행 경계에서 거부(경계 시각 포함)", async () => {
  const repo = await initRepo();
  try {
    const m = manifest({ approvedCommit: repo.head, expiresAt: "2026-07-27T00:00:00.000Z" });
    const at = Date.parse("2026-07-27T00:00:00.000Z");
    assert.equal(
      await code(() =>
        verify({ manifest: m, controllerRepoRoot: repo.root, targetWorktree: repo.root, nowMs: at }),
      ),
      "manifest_expired",
      "expiresAt과 정확히 같은 시각도 거부한다",
    );
    const before = await verify({
      manifest: m,
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
      nowMs: at - 1,
    });
    assert.equal(before.approvedCommit, repo.head);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 비동기 git 조회 중에 승인이 만료되면 spawn 직전에 거부", async () => {
  const repo = await initRepo();
  try {
    const expiresAt = "2026-07-27T00:00:00.000Z";
    const at = Date.parse(expiresAt);
    // clock 함수: 첫 호출(경계 진입)은 만료 전, 두 번째 호출(spawn 직전 재확인)은 만료 시각.
    const reads: number[] = [];
    const clock = () => {
      const t = reads.length === 0 ? at - 1 : at;
      reads.push(t);
      return t;
    };
    const v = await verify({
      manifest: manifest({ approvedCommit: repo.head, expiresAt }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
      nowMs: clock,
    });
    assert.equal(reads.length, 1, "경계 진입에서 clock을 한 번 읽는다");
    assert.equal(await code(() => v.revalidateSync()), "manifest_expired", "만료 경계는 재검증에서도 포함이다");
    assert.equal(reads.length, 2, "재검증이 clock을 다시 읽는다(고정 값 재사용 아님)");

    // 만료 전에 머무르는 clock이면 재검증도 통과한다(게이트가 항상 던지는 게 아니다).
    const ok = await verify({
      manifest: manifest({ approvedCommit: repo.head, expiresAt }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
      nowMs: () => at - 1,
    });
    ok.revalidateSync();

    // 읽을 수 없는 시각은 fail closed다.
    const nan = await verify({
      manifest: manifest({ approvedCommit: repo.head, expiresAt }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
      nowMs: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return at - 1;
          }
          return Number.NaN;
        };
      })(),
    });
    assert.equal(await code(() => nan.revalidateSync()), "manifest_expired");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] git 실행 파일은 신뢰된 절대·정규 경로여야 한다(이름 조회·symlink·비실행 거부)", async () => {
  const repo = await initRepo();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-gitbin-")));
  try {
    // 경로·digest는 **승인 manifest**에서만 온다(호출자 옵션 없음 — 6차 리뷰 A1).
    const call = (path: unknown, sha256?: string) =>
      verify({
        manifest: manifest({
          approvedCommit: repo.head,
          executionAuthority: authorityWithGit({ path: path as string, sha256: sha256 ?? GIT_SHA }),
        }),
        controllerRepoRoot: repo.root,
        targetWorktree: repo.root,
      });
    // manifest validator가 먼저 경로 계약을 닫는다(상대 경로·빈 값·비문자열).
    assert.equal(await code(() => call("git")), "invalid_manifest", "이름으로는 부르지 않는다");
    assert.equal(await code(() => call(undefined)), "invalid_manifest");
    assert.equal(await code(() => call("")), "invalid_manifest");
    assert.equal(await code(() => call(join(dir, "missing"))), "boundary_git_untrusted");
    assert.equal(await code(() => call(dir)), "boundary_git_untrusted", "디렉터리 거부");

    const link = join(dir, "git-link");
    symlinkSync(GIT, link);
    assert.equal(await code(() => call(link)), "boundary_git_untrusted", "symlink 거부");

    const fake = join(dir, "git");
    writeFileSync(fake, "#!/bin/sh\necho 0000000000000000000000000000000000000000\n", { mode: 0o644 });
    assert.equal(await code(() => call(fake, digestOf(fake))), "boundary_git_untrusted", "실행 비트 없음");
    chmodSync(fake, 0o777);
    assert.equal(await code(() => call(fake, digestOf(fake))), "boundary_git_untrusted", "타인 쓰기 가능");
    // **승인된 내용과 다르면** 신뢰 조건을 다 만족해도 거부다(6차 리뷰 A1).
    chmodSync(fake, 0o755);
    assert.equal(await code(() => call(fake, "0".repeat(64))), "boundary_git_digest_mismatch", "승인 digest 불일치");
    // 같은 inode를 **제자리에서 덮어써도** 거부다 — path/dev/ino만 보던 이전 판의 구멍이다.
    const approved = digestOf(fake);
    writeFileSync(fake, "#!/bin/sh\nexec /usr/bin/true\n", { mode: 0o755 });
    assert.equal(await code(() => call(fake, approved)), "boundary_git_digest_mismatch", "같은 inode 제자리 교체");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 적대적 PATH·GIT_DIR·GIT_WORK_TREE는 경계 판정에 끼어들지 못한다", async () => {
  const repo = await initRepo();
  const decoy = await initRepo("m5a-decoy-env-", "decoy-env");
  const evilDir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-evilpath-")));
  const saved = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    // PATH에는 승인 커밋을 위조하는 가짜 git만 둔다.
    const evilGit = join(evilDir, "git");
    writeFileSync(evilGit, `#!/bin/sh\necho ${"c".repeat(40)}\n`, { mode: 0o755 });
    process.env.PATH = evilDir;
    // ambient git 변수는 **다른 저장소**를 가리킨다(상속되면 decoy HEAD가 증명된다).
    process.env.GIT_DIR = join(decoy.root, ".git");
    process.env.GIT_WORK_TREE = decoy.root;

    const ok = await verify({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    assert.equal(ok.approvedCommit, repo.head, "승인된 checkout이 그대로 검증된다");
    ok.revalidateSync(); // 동기 재확인도 ambient env를 쓰지 않는다

    // decoy를 승인 커밋으로 주면 여전히 거부다(위조 git·ambient GIT_DIR로 통과하지 않는다).
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: decoy.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: repo.root,
        }),
      ),
      "approved_commit_mismatch",
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(evilDir, { recursive: true, force: true });
    rmSync(decoy.root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] git 자식 env는 최소 화이트리스트다(PATH·HOME·상속 GIT_* 없음)", () => {
  assert.deepEqual(Object.keys(GIT_SANITIZED_ENV).sort(), [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_OPTIONAL_LOCKS",
    "GIT_TERMINAL_PROMPT",
    "LC_ALL",
  ]);
  for (const forbidden of ["PATH", "HOME", "GIT_DIR", "GIT_WORK_TREE", "GIT_ASKPASS", "GIT_SSH", "GIT_CONFIG"]) {
    assert.ok(!(forbidden in GIT_SANITIZED_ENV), `${forbidden}가 git 자식 env에 있다`);
  }
  assert.equal(GIT_SANITIZED_ENV.GIT_CONFIG_NOSYSTEM, "1", "system config를 끈다");
  assert.equal(GIT_SANITIZED_ENV.GIT_CONFIG_GLOBAL, "/dev/null", "global config를 사용자 상태 없이 끈다");
});

test("[M5a] revalidateSync: git 실행 파일이 교체되면 spawn 직전에 거부", async () => {
  const repo = await initRepo();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-gitpin-")));
  const pinned = join(dir, "git");
  try {
    // 신뢰된 git으로 exec하는 wrapper를 만들어 그것으로 경계를 통과시킨다(절대경로 exec — PATH 불필요).
    const wrapper = `#!/bin/sh\nexec ${GIT} "$@"\n`;
    writeFileSync(pinned, wrapper, { mode: 0o755 });
    const pinnedManifest = manifest({
      approvedCommit: repo.head,
      executionAuthority: authorityWithGit({ path: pinned, sha256: digestOf(pinned) }),
    });
    const v = await verify({ manifest: pinnedManifest, controllerRepoRoot: repo.root, targetWorktree: repo.root });
    v.revalidateSync();

    // 같은 경로·같은 권한·같은 내용, **다른 inode**로 교체(rename) → 신원 불일치로 거부.
    const other = join(dir, "git-other");
    writeFileSync(other, wrapper, { mode: 0o755 });
    renameSync(other, pinned);
    assert.equal(await code(() => v.revalidateSync()), "boundary_git_identity_changed");

    // 같은 inode를 **제자리에서 덮어쓰면** 내용 digest가 spawn 직전에 거부한다(6차 리뷰 A1).
    const v2 = await verify({
      manifest: manifest({
        approvedCommit: repo.head,
        executionAuthority: authorityWithGit({ path: pinned, sha256: digestOf(pinned) }),
      }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    v2.revalidateSync();
    writeFileSync(pinned, `#!/bin/sh\nexec ${GIT} "$@" # 뒤에 붙은 한 줄\n`, { mode: 0o755 });
    assert.equal(await code(() => v2.revalidateSync()), "boundary_git_digest_mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 경로 입력이 계약 밖이면 git을 부르기 전에 거부", async () => {
  const repo = await initRepo();
  try {
    const call = (controller: unknown, target: unknown) =>
      verify({
        manifest: manifest({ approvedCommit: repo.head }),
        controllerRepoRoot: controller as string,
        targetWorktree: target as string,
      });
    assert.equal(await code(() => call("relative/path", repo.root)), "boundary_path_invalid");
    assert.equal(await code(() => call("", repo.root)), "boundary_path_invalid");
    assert.equal(await code(() => call(repo.root, "/abs/with\0nul")), "boundary_path_invalid");
    assert.equal(await code(() => call(repo.root, undefined)), "boundary_path_invalid");
    assert.equal(await code(() => call(join(repo.root, "does-not-exist"), repo.root)), "boundary_path_unresolvable");
    assert.equal(await code(() => call(join(repo.root, "src", "a.txt"), repo.root)), "boundary_path_not_directory");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] 비정규(symlink) 입력 경로는 해석하지 않고 거부한다", async () => {
  const repo = await initRepo();
  const other = await initRepo("m5a-other-", "other");
  const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "m5a-link-")));
  const link = join(linkDir, "repo-link");
  try {
    symlinkSync(other.root, link, "dir");
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: link,
        }),
      ),
      "boundary_path_not_canonical",
      "symlink를 realpath로 눙쳐서 통과시키지 않는다(검사 대상 = 실행 대상)",
    );
    // 자기 자신을 가리키는 정상 대상이어도 마찬가지다 — 정규 경로가 아니면 거부.
    const selfLink = join(linkDir, "self-link");
    symlinkSync(repo.root, selfLink, "dir");
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: selfLink,
          targetWorktree: repo.root,
        }),
      ),
      "boundary_path_not_canonical",
    );
  } finally {
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] checkout 루트가 아니면(하위 디렉터리) 거부", async () => {
  const repo = await initRepo();
  try {
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: repo.root,
          targetWorktree: join(repo.root, "src"),
        }),
      ),
      "boundary_not_checkout_root",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] git이 아닌 디렉터리는 boundary_git_failed", async () => {
  const repo = await initRepo();
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "m5a-plain-")));
  try {
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: repo.head }),
          controllerRepoRoot: plain,
          targetWorktree: plain,
        }),
      ),
      "boundary_git_failed",
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 검증 이후 HEAD가 움직이면 spawn 직전에 거부", async () => {
  const repo = await initRepo();
  try {
    const v = await verify({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    v.revalidateSync();
    await advance(repo.root); // 검사와 사용 사이의 변경
    assert.equal(await code(() => v.revalidateSync()), "approved_commit_mismatch");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 디렉터리가 다른 실체로 바뀌면 신원 불일치로 거부", async () => {
  const repo = await initRepo();
  const decoy = await initRepo("m5a-decoy-", "decoy");
  const parked = `${repo.root}-parked`;
  try {
    const v = await verify({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    // 같은 경로에 다른 디렉터리를 끼워 넣는다(inode 교체).
    renameSync(repo.root, parked);
    renameSync(decoy.root, repo.root);
    assert.equal(await code(() => v.revalidateSync()), "boundary_identity_changed");
  } finally {
    rmSync(parked, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(decoy.root, { recursive: true, force: true });
  }
});

test("[M5a] revalidateSync: 경로가 symlink로 교체되면 거부", async () => {
  const repo = await initRepo();
  const other = await initRepo("m5a-other2-", "other2");
  const parked = `${repo.root}-parked2`;
  try {
    const v = await verify({
      manifest: manifest({ approvedCommit: repo.head }),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    renameSync(repo.root, parked);
    symlinkSync(other.root, repo.root, "dir");
    assert.equal(await code(() => v.revalidateSync()), "boundary_path_not_canonical");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(parked, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
});

// ── M5b 7차 리뷰 A1: 검증은 프로세스 1회가 아니라 **spawn 1회** 단위다 ──────────

/**
 * **자기 inode를 제자리에서 덮어쓰는 승인 wrapper**(7차 리뷰 A1 회귀 도구). `trigger`(POSIX `sh` 조건식)가
 * 참인 invocation에서 자신을 sentinel payload로 갈아치우고, **그 호출 자체는** 진짜 git으로 exec한다 →
 * "이 spawn은 승인된 바이트, 다음 spawn은 승인되지 않은 바이트"라는 경합을 결정론적으로 만든다.
 *
 * 본문을 `{ }`로 묶는 이유: `sh`는 compound command를 **끝까지 파싱한 뒤** 실행하므로, 자기 파일을
 * 자르는 순간에도 남은 줄을 다시 읽지 않는다. 자식 env는 경계가 `PATH` 없이 주므로 script는 shell
 * builtin(`printf`·`[`·`exec`)과 **절대경로**만 쓴다.
 *
 * `sentinelRan()`이 true면 **승인되지 않은 바이트가 실제로 실행됐다**는 뜻이다(회귀의 비공허성 증거 —
 * 0이어야 한다). `spawns()`는 실제 git 프로세스 수다(정확한 개수로 게이트 위치를 고정한다).
 * `trigger` 안의 `$MARKER`는 이 wrapper의 marker 경로로 치환된다(테스트가 교체 시점을 정한다).
 */
function selfRewritingGit(trigger: string): {
  dir: string;
  path: string;
  sha256: string;
  marker: string;
  spawns: () => number;
  sentinelRan: () => boolean;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m5b-a1-rewrite-")));
  const self = join(dir, "git");
  const count = join(dir, "spawns");
  const sentinel = join(dir, "sentinel");
  const marker = join(dir, "marker");
  const payload = ["#!/bin/sh", `printf RAN >> "${sentinel}"`, `exec "${GIT}" "$@"`];
  writeFileSync(
    self,
    [
      "#!/bin/sh",
      "{",
      `printf x >> "${count}"`,
      `if ${trigger.split("$MARKER").join(marker)}; then printf '%s\\n' ${payload.map((l) => `'${l}'`).join(" ")} > "${self}"; fi`,
      `exec "${GIT}" "$@"`,
      "}",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    dir,
    path: self,
    sha256: digestOf(self),
    marker,
    spawns: () => (existsSync(count) ? readFileSync(count).length : 0),
    sentinelRan: () => existsSync(sentinel),
  };
}

/** 이 wrapper를 승인 권위로 지정한 manifest. */
function wrapperManifest(w: { path: string; sha256: string }, approvedCommit: string) {
  return manifest({
    approvedCommit,
    executionAuthority: authorityWithGit({ path: w.path, sha256: w.sha256 }),
  });
}

test("[M5b] A1(7차): readCheckoutHead의 두 spawn은 각자 승인 digest를 다시 본다(제자리 교체)", async () => {
  const repo = await initRepo("m5b-a1-same-");
  // ⓐ 양성 대조군: 덮어쓰지 않는 승인 wrapper는 통과하고 **spawn 수가 정확히** 2(진입) + 1(재검증)이다.
  const ok = selfRewritingGit("false");
  // ⓑ `--show-toplevel` invocation이 자기 inode를 sentinel로 갈아치운다 → 다음 `rev-parse HEAD`가 막힌다.
  const bad = selfRewritingGit(`[ "$4" = --show-toplevel ]`);
  try {
    const v = await verify({
      manifest: wrapperManifest(ok, repo.head),
      controllerRepoRoot: repo.root,
      targetWorktree: repo.root,
    });
    assert.equal(ok.spawns(), 2, "같은 checkout 진입 조회가 2 프로세스가 아니다(회귀 기준이 어긋났다)");
    v.revalidateSync();
    assert.equal(ok.spawns(), 3, "재검증이 HEAD spawn 1건이 아니다");
    assert.equal(ok.sentinelRan(), false);

    assert.equal(
      await code(() =>
        verify({ manifest: wrapperManifest(bad, repo.head), controllerRepoRoot: repo.root, targetWorktree: repo.root }),
      ),
      "boundary_git_digest_mismatch",
      "첫 조회 뒤 제자리 교체가 두 번째 spawn 직전에 거부되지 않았다",
    );
    assert.equal(bad.spawns(), 1, "승인되지 않은 바이트로 두 번째 git 프로세스가 떴다");
    assert.equal(bad.sentinelRan(), false, "승인되지 않은 payload가 실행됐다");
  } finally {
    rmSync(ok.dir, { recursive: true, force: true });
    rmSync(bad.dir, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5b] A1(7차): controller·target checkout이 다르면 뒤 checkout 조회도 자기 게이트를 지난다", async () => {
  const repo = await initRepo("m5b-a1-two-");
  const wt = join(repo.root, "..", `m5b-a1-wt-${process.pid}`);
  // controller HEAD 조회(2번째 spawn)에서 갈아치운다 → target `--show-toplevel`(3번째)이 막혀야 한다.
  const w = selfRewritingGit(`[ "$2" = "${repo.root}" ] && [ "$4" = HEAD ]`);
  try {
    await runProcess("git", ["-C", repo.root, "worktree", "add", "-q", "-b", "work/m5b-a1", wt]);
    const wtReal = realpathSync(wt);
    assert.equal(
      await code(() =>
        verify({ manifest: wrapperManifest(w, repo.head), controllerRepoRoot: repo.root, targetWorktree: wtReal }),
      ),
      "boundary_git_digest_mismatch",
    );
    assert.equal(w.spawns(), 2, "target checkout 조회가 승인되지 않은 바이트로 떴다");
    assert.equal(w.sentinelRan(), false, "승인되지 않은 payload가 실행됐다");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(w.dir, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("[M5b] A1(7차): revalidateSync의 checkout 루프도 회차마다 승인 digest를 다시 본다", async () => {
  const repo = await initRepo("m5b-a1-loop-");
  const wt = join(repo.root, "..", `m5b-a1-loopwt-${process.pid}`);
  // marker가 있을 때만 갈아치운다 → 진입 검증(4 spawn)과 첫 재검증(2 spawn)은 승인 바이트로 통과하고,
  // marker를 만든 뒤 재검증의 **첫 회차**가 갈아치우므로 **두 번째 회차**가 막혀야 한다.
  const w = selfRewritingGit(`[ -f "$MARKER" ]`);
  try {
    await runProcess("git", ["-C", repo.root, "worktree", "add", "-q", "-b", "work/m5b-a1-loop", wt]);
    const wtReal = realpathSync(wt);
    const v = await verify({
      manifest: wrapperManifest(w, repo.head),
      controllerRepoRoot: repo.root,
      targetWorktree: wtReal,
    });
    assert.equal(w.spawns(), 4, "다른 checkout 진입 조회가 4 프로세스가 아니다(회귀 기준이 어긋났다)");
    v.revalidateSync(); // 양성 대조군: 루프 2회차 전부 통과
    assert.equal(w.spawns(), 6, "재검증 루프가 root마다 1 spawn이 아니다");

    writeFileSync(w.marker, "");
    assert.equal(await code(() => v.revalidateSync()), "boundary_git_digest_mismatch");
    assert.equal(w.spawns(), 7, "루프 두 번째 회차가 승인되지 않은 바이트로 떴다");
    assert.equal(w.sentinelRan(), false, "승인되지 않은 payload가 실행됐다");
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(w.dir, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
});

/**
 * [V3 M10 T6 · 대장 `B-33`] **비-ASCII 경로에서 checkout 신원 대조가 유니코드 정규형 때문에 깨졌다.**
 *
 * macOS APFS는 파일 이름의 정규형을 **보존**하므로, 디렉터리를 NFD(Hangul Jamo 분해)로 만들어 두고
 * 호출자가 NFC 경로를 주면 ⓐ `realpath(주어진 경로) === 주어진 경로`(정규 경로 게이트 통과)이면서
 * ⓑ `git rev-parse --show-toplevel`은 **NFD**를 돌려준다 → 이전 판의 **문자열 대조**는 같은
 * 디렉터리를 다른 것으로 보고 `boundary_not_checkout_root`를 냈다(M10 T5 도그푸딩 실측 —
 * `~/Desktop/구독컷`에서 v3가 시작조차 못 했다).
 *
 * 이 테스트는 **그 두 형태가 실제로 다른 문자열임을 먼저 단정**한다 — 정규형을 통일하는 파일 시스템에서는
 * 전제가 성립하지 않으므로, 조용히 통과하는 공허한 테스트가 되지 않게 전제 자체를 red로 만든다.
 */
test("[M10 T6/B-33] 비-ASCII 경로: git이 NFD로 답해도 같은 디렉터리면 통과한다(dev+ino 대조)", async () => {
  const base = realpathSync(tmpdir());
  const nfdRoot = join(base, `m10-b33-${"구독컷".normalize("NFD")}-${process.pid}`);
  rmSync(nfdRoot, { recursive: true, force: true });
  mkdirSync(nfdRoot);
  try {
    await runProcess("git", ["-C", nfdRoot, "init", "-q", "-b", "main"]);
    await runProcess("git", ["-C", nfdRoot, "config", "user.email", "t@t.io"]);
    await runProcess("git", ["-C", nfdRoot, "config", "user.name", "t"]);
    mkdirSync(join(nfdRoot, "src"), { recursive: true });
    writeFileSync(join(nfdRoot, "src", "a.txt"), "a\n");
    await runProcess("git", ["-C", nfdRoot, "add", "."]);
    await runProcess("git", ["-C", nfdRoot, "commit", "-q", "-m", "init"]);
    const head = (await runProcess("git", ["-C", nfdRoot, "rev-parse", "HEAD"])).stdout.trim();

    const nfcRoot = nfdRoot.normalize("NFC");
    const toplevel = (await runProcess("git", ["-C", nfcRoot, "rev-parse", "--show-toplevel"])).stdout.trim();
    // 전제: 두 형태는 **다른 문자열**이고 그런데도 같은 디렉터리다. 하나라도 깨지면 이 테스트는 공허하다.
    assert.notEqual(nfcRoot, toplevel, "이 파일 시스템은 정규형을 통일한다 — B-33 전제가 성립하지 않는다");
    assert.equal(realpathSync(nfcRoot), nfcRoot, "정규 경로 게이트 전제가 깨졌다");
    const a = lstatSync(nfcRoot);
    const b = lstatSync(realpathSync(toplevel));
    assert.ok(a.dev === b.dev && a.ino === b.ino, "두 형태가 같은 디렉터리를 가리키지 않는다");

    // 본 판정: NFC 경로로도 경계를 지난다(문자열 대조였다면 boundary_not_checkout_root였다).
    const v = await verify({
      manifest: manifest({ approvedCommit: head }),
      controllerRepoRoot: nfcRoot,
      targetWorktree: nfcRoot,
    });
    assert.equal(v.approvedCommit, head);
    assert.equal(v.sameCheckout, true);
    v.revalidateSync(); // 동기 재검증도 같은 기계(dev+ino)로 통과한다
  } finally {
    rmSync(nfdRoot, { recursive: true, force: true });
  }
});

/**
 * [V3 M10 T6 · `B-33`] 신원 대조로 바꿔도 **거부해야 할 것은 그대로 거부한다**:
 * 하위 디렉터리(위 M5a 테스트) 외에 **다른 저장소**를 대상으로 준 경우를 신원 축에서 다시 고정한다.
 */
test("[M10 T6/B-33] 신원 대조가 다른 저장소를 통과시키지 않는다", async () => {
  const a = await initRepo("m10-b33-a-", "a");
  const b = await initRepo("m10-b33-b-", "b");
  try {
    assert.notEqual(a.head, b.head);
    assert.equal(
      await code(() =>
        verify({ manifest: manifest({ approvedCommit: a.head }), controllerRepoRoot: a.root, targetWorktree: b.root }),
      ),
      "approved_commit_mismatch",
    );
    // 대상이 대상 저장소의 **하위 디렉터리**면 신원 자체가 다르다.
    assert.equal(
      await code(() =>
        verify({
          manifest: manifest({ approvedCommit: a.head }),
          controllerRepoRoot: a.root,
          targetWorktree: join(b.root, "src"),
        }),
      ),
      "boundary_not_checkout_root",
    );
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});
