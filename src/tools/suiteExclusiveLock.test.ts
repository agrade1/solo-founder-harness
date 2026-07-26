import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript"; // devDependency — **테스트에서만** 쓴다(production 의존성 아님)

/**
 * [V3 M3d.2] 공용 배타 lock(scripts/lib/suite-exclusive-lock.mjs) + lock wrapper
 * (scripts/suite-lock.mjs) + stress runner(scripts/m3d2-stress-acceptance.mjs)의 **offline 회귀 테스트**.
 *
 * 격리 원칙: 이 테스트는 실제 lock 파일(tmpdir 공용 경로)이나 실제 `ps` 후보 스캔을 건드리지 않는다.
 * 주입은 **argv `--fixture-config <절대경로 .json>`로만** 한다(env seam 없음 — env는 자손에 암묵 상속되어
 * production 실행의 lock 경로를 조용히 바꿀 수 있다). 예외적으로 `HARNESS_SUITE_LOCK_TOKEN`은
 * 부모→자식 ownership handoff 메커니즘이므로 상위 suite의 token만 ""로 지워 재진입을 막는다.
 *
 * 실제 서비스·live runner·실제 `npm test`는 실행하지 않는다. 만드는 프로세스는 전부 bounded다.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOCK_CLI = join(REPO_ROOT, "scripts", "suite-lock.mjs");
const STRESS = join(REPO_ROOT, "scripts", "m3d2-stress-acceptance.mjs");
const LOCK_LIB = join(REPO_ROOT, "scripts", "lib", "suite-exclusive-lock.mjs");

/** lock 파일 record 버전(guard 기반 계약). 옛 v1 record는 `lock_unverifiable`이다. */
const LOCK_V = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "m3d2-lock-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** async 본문 전용 — 정리를 await 이후로 미룬다(동기 withTemp는 promise를 기다리지 않는다). */
async function withTempAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "m3d2-lock-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 동시 실행 suite가 **없는** 상태를 나타내는 `ps` fixture (오탐 후보만 담는다). */
const CLEAN_PS_ROWS = [
  "4100 1 4100 /Applications/Agent.app/Contents/MacOS/agent --allowedTools tsx --test",
  "4101 1 4101 node dist/index.js",
  "4102 1 4102 npx tsx src/cli.ts list",
  "4103 1 4103 node /repo/node_modules/.bin/vitest run",
  "4104 1 4104 /usr/bin/ruby /repo/bin/lint --testing",
];

/** lock을 우회해 이미 돌고 있는 suite 후보 (모두 감지돼야 한다). */
const SUITE_PS_ROWS = [
  "4001 1 4001 npm test",
  "4002 1 4002 npm run test:core",
  "4003 1 4003 npm run test:inner",
  "4004 1 4004 /Users/x/.nvm/versions/node/v24.18.0/bin/node /repo/node_modules/.bin/tsx --test src/core/a.test.ts",
  "4005 1 4005 /bin/bash scripts/acceptance.sh",
  "4006 1 4006 node scripts/m3d2-stress-acceptance.mjs",
  "4007 1 4007 npm exec tsx --test /tmp/x.test.mjs",
];

function psFixture(dir: string, rows: string[], name = "ps.txt"): string {
  const p = join(dir, name);
  writeFileSync(p, rows.join("\n") + "\n", "utf8");
  return p;
}

/** 상위 suite lock 재진입만 막고 나머지는 그대로 물려주는 env(테스트 seam env는 존재하지 않는다). */
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HARNESS_SUITE_LOCK_TOKEN = "";
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

/** fixture 설정 파일을 쓰고 절대경로를 돌려준다(주입은 argv로만 들어간다). */
function fixtureFile(dir: string, config: Record<string, unknown>, name = "fixture.json"): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(config) + "\n", { encoding: "utf8", mode: 0o600 });
  return p;
}

/** 기본 lock fixture 설정: 테스트 전용 lock 경로 + 오탐 없는 ps fixture. */
function lockConfig(dir: string, extra: Record<string, unknown> = {}, psRows: string[] = CLEAN_PS_ROWS): Record<string, unknown> {
  return { lockPath: join(dir, "suite.lock"), psFixture: psFixture(dir, psRows), ...extra };
}

const lockPathOf = (config: Record<string, unknown>): string => String(config.lockPath);
const guardPathOf = (config: Record<string, unknown>): string => `${String(config.lockPath)}.guard`;

/** stress runner fixture 설정 — 부하 1 worker, bounded 상한, 주입 seam 경로 포함. */
function stressConfig(dir: string, extra: Record<string, unknown> = {}, psRows: string[] = CLEAN_PS_ROWS): Record<string, unknown> {
  return lockConfig(
    dir,
    { workers: 1, testTimeoutMs: 60_000, deadlineMs: 70_000, injectDir: dir, ...extra },
    psRows,
  );
}

const runLockCli = (args: string[], config: Record<string, unknown>, dir: string, name = "fixture.json") =>
  spawnSync(process.execPath, [LOCK_CLI, ...args, "--fixture-config", fixtureFile(dir, config, name)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: isolatedEnv(),
  });

const runStress = (
  config: Record<string, unknown>,
  dir: string,
  timeoutMs = 90_000,
  name = "stress-fixture.json",
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [STRESS, "--fixture-config", fixtureFile(dir, config, name)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    env: isolatedEnv(),
  });

/** stress runner의 bounded summary JSON을 뽑는다. */
function stressSummary(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").find((l) => l.includes("[m3d2-stress] 요약: "));
  assert.ok(line, `요약 줄 필요 (stdout tail: ${stdout.slice(-400)})`);
  return JSON.parse(String(line).slice(String(line).indexOf("{")));
}

/** pid 파일이 생길 때까지 bounded 대기. */
async function waitForPidFile(path: string, limitMs = 20_000): Promise<number> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    }
    await sleep(50);
  }
  assert.fail(`pid 파일이 생기지 않음: ${path.split("/").pop()}`);
}

/** 기록된 pid 파일들의 프로세스가 모두 사라졌는지 bounded 확인. */
async function assertPidFilesDead(dir: string, names: string[], limitMs = 10_000): Promise<void> {
  const end = Date.now() + limitMs;
  const pids = names
    .map((n) => join(dir, n))
    .filter((p) => existsSync(p))
    .map((p) => Number(readFileSync(p, "utf8").trim()))
    .filter((p) => Number.isSafeInteger(p) && p > 0);
  for (;;) {
    const alive = pids.filter(isAlive);
    if (alive.length === 0) return;
    if (Date.now() >= end) assert.fail(`정리되지 않은 프로세스 ${alive.length}건 (${names.join(",")})`);
    await sleep(100);
  }
}

/** 테스트가 만든 fixture 프로세스 그룹을 확실히 치운다(자기 fixture pid만 다룬다). */
function killPidFileGroup(dir: string, name: string): void {
  const p = join(dir, name);
  if (!existsSync(p)) return;
  const pid = Number(readFileSync(p, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* 이미 종료 */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 이미 종료 */
  }
}

/** 죽은 pid 하나를 확보한다(짧은 child를 띄우고 종료를 기다린다). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 30_000 });
  const pid = Number(String(r.stdout).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "죽은 pid 확보");
  return pid;
}

function writeLockFile(path: string, record: unknown): void {
  writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

/** `ps -o lstart=`로 현재 프로세스의 실제 신원 문자열을 얻는다(lock 위조 테스트용). */
function selfIdentity(): string {
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", timeout: 15_000 });
  return String(r.stdout).trim().split("\n")[0].trim();
}

/** 파일이 생길 때까지 bounded 대기(동기화 marker용). */
async function waitForFile(path: string, limitMs = 20_000): Promise<void> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (existsSync(path)) return;
    await sleep(25);
  }
  assert.fail(`파일이 생기지 않음: ${path.split("/").pop()}`);
}

/** 조건이 참이 될 때까지 bounded 대기. */
async function waitUntil(fn: () => boolean, label: string, limitMs = 20_000): Promise<void> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  assert.fail(`조건 미충족: ${label}`);
}

/** lock 계약과 무관한 **제3의 프로세스**. 정리 로직이 남의 프로세스를 죽이지 않는지 확인하는 데 쓴다. */
function spawnBystander(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  assert.ok(child.pid, "무관 프로세스 spawn");
  return {
    pid: child.pid as number,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 이미 종료 */
      }
    },
  };
}

/** lock 파일을 읽어 record를 돌려준다(격리 표시 확인용). */
function readLockRecord(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * lock 디렉터리에 임시/전이 잔재가 없는지 확인한다.
 * transition guard(`<lock>.guard`)와 그 임시 파일, 격리 임시 파일, 옛 회수 잔재까지 모두 본다.
 */
function assertNoLockResidue(dir: string, opts: { lockName?: string; allowGuard?: boolean } = {}): void {
  const lockName = opts.lockName ?? "suite.lock";
  const leftovers = readdirSync(dir).filter((n) => {
    if (n === lockName) return false;
    if (opts.allowGuard && n === `${lockName}.guard`) return false;
    return (
      n.startsWith(`${lockName}.new.`) ||
      n.startsWith(`${lockName}.q.`) ||
      n.startsWith(`${lockName}.stale.`) ||
      n.startsWith(`${lockName}.recovery`) ||
      n === `${lockName}.guard` ||
      n.startsWith(`${lockName}.guard.`)
    );
  });
  assert.deepEqual(leftovers, [], `lock 임시/guard 잔재 없음: ${leftovers.join(",")}`);
}

/** wrapper child fixture 실행용 기본 설정. */
function wrapperConfig(dir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return lockConfig(dir, { injectDir: dir, childMs: 60_000, confirmMs: 10_000, ...extra });
}

/** 주석(블록/라인)을 제거한 소스. "설명에 이름이 나온다"와 "코드가 읽는다"를 구분하기 위함이다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** 재진입 token과 짝이 맞는 lock record(tokenHash = sha256(token)). 소유자는 살아있는 이 프로세스다. */
function ownedLockRecord(token: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: LOCK_V,
    kind: "stress",
    pid: process.pid,
    identity: selfIdentity(),
    tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
    ...extra,
  };
}

/** guard record(전이 중 흔적)를 직접 만든다. */
function writeGuardFile(path: string, record: unknown): void {
  writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

/** fixture 설정 파일 경로를 **그대로** 넘겨 lock CLI를 돌린다(로더 자체 계약 검증용). */
const runLockCliWithFixturePath = (args: string[], fixturePath: string): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [LOCK_CLI, ...args, "--fixture-config", fixturePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: isolatedEnv(),
  });

/** 정확한 바이트 수를 만들기 위해 raw 텍스트로 fixture 파일을 쓴다. */
function writeRawFixture(path: string, text: string): string {
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** in-process로 관측해야 하는 계약(handle 상태·신원 판정)을 위해 lock 라이브러리를 그대로 import한다. */
type LockHandle = {
  path: string;
  guardPath: string;
  token: string;
  state: string;
  released: boolean;
  quarantined: boolean;
  release: () => string[];
  quarantine: (reason: string) => string[];
};
type LockLib = {
  acquireSuiteLock: (opts: Record<string, unknown>) => LockHandle;
  quarantineByToken: (opts: Record<string, unknown>) => string[];
  tryReenterSuiteLock: (
    opts: Record<string, unknown>,
  ) => { base: { record: Record<string, unknown>; dev: number; ino: number } } | null;
};
const importLockLib = async (): Promise<LockLib> => (await import(pathToFileURL(LOCK_LIB).href)) as unknown as LockLib;

// ── production 로더 호출부 감사(구문 인식 · 재귀 · scope 인식) ─────────────────
//
// 일곱 번째 리비전(Codex Sol xhigh P2): 예전 감사는 `scripts` 루트와 `scripts/lib` **한 겹만** 훑고
// `loadFixtureConfig(` 문자열이 있는지로 호출부를 찾았다. 그래서 ⓐ 더 깊은 하위 디렉터리의 호출부,
// ⓑ 식별자와 `(` 사이에 공백·주석이 낀 호출, ⓒ `as`로 이름을 바꾼 import가 **감사를 통과**했다.
// 그래서 `scripts` 아래 일반 `.mjs`를 **재귀 열거**하고, TypeScript AST로 **로더 모듈에서 온 바인딩**을
// 추적해 그 바인딩을 통한 호출만 계약(인자 2개 · 첫 인자 `process.argv.slice(2)`)으로 검사하게 바꿨다.
//
// 여덟 번째 리비전(여덟 번째 Codex Sol xhigh REQUEST_CHANGES: P2 2건 · P3 1건): 그 AST 감사에도
// **유효한 ESM 우회로**가 남아 있었다.
//   ⓐ 지정자에 **query/fragment**(`"./lib/fixture-config.mjs?v=1"`, `"#seam"`)가 붙으면 상대 경로 해석이
//      문자열 비교에서 어긋나 로더로 인식되지 않았다. **percent 인코딩**(`fixture%2Dconfig.mjs`)도 같다 —
//      Node ESM은 file URL을 디코드해 같은 파일로 해석한다.
//   ⓑ `import()` 인자가 문자열 리터럴이 아니면(연결·const 바인딩·완전 계산) **아예 보지 않았다**.
//   ⓒ import 후 `export { loadFixtureConfig }`(import-then-export)는 ExportSpecifier를 참조 대상에서
//      제외했기 때문에 **아무 문제도 보고되지 않았다** — 다른 모듈이 그 재수출로 감사 밖에서 세 번째 인자를
//      넘길 수 있다. 직접 `export ... from`만 잡고 있었다.
//   ⓓ 바인딩 판정이 **식별자 텍스트**만 봤다: 지역 `process` shadow가 첫 인자 정규형 검사를 통과하고,
//      shadow된 식별자가 import 사용으로 계산되고, namespace import에는 미사용 검사가 아예 없었다.
// 이제 감사는 (1) URL 규칙대로 지정자를 정규화하고 판정 불가는 fail closed, (2) 동적 지정자를 bounded
// 규칙으로 접거나 도달 가능한 literal로 판정, (3) import/노출을 **두 패스**로 모아 소스 순서와 무관하게
// 재수출을 검출, (4) 선언 sweep으로 shadow 가능성을 전부 실패 처리, (5) 구문 오류 소스를 "안전"으로
// 보지 않는다. 감사는 여전히 **테스트 전용**이고 production 코드·의존성은 건드리지 않는다.

/** 감사 대상 소스 한 건(`rel`은 repo 기준 posix 상대경로). */
type MjsSource = { rel: string; text: string };
/** 로더 호출 한 건. */
type LoaderCall = { binding: string; line: number; args: string[]; argCount: number; canonicalFirstArg: boolean };
/** 파일 하나의 감사 결과. `issues`가 비어 있어야 계약을 지킨 것이다. */
type LoaderCallerAudit = { rel: string; bindings: string[]; calls: LoaderCall[]; issues: string[] };

const LOADER_REL = "scripts/lib/fixture-config.mjs";
const LOADER_EXPORT = "loadFixtureConfig";
/** 로더 파일을 식별하는 basename token(확장자 제외). 동적 지정자의 bounded 판정에 쓴다. */
const LOADER_TOKEN = "fixture-config";
/** 동적 지정자 folding·literal 수집의 재귀 상한(무한 전개 방지). */
const SPEC_FOLD_DEPTH = 8;

/**
 * 디렉터리 아래 **모든** 일반 `.mjs` 파일을 재귀 열거한다.
 * symlink(파일·디렉터리)는 production 소스로 **신뢰하지 않고 따라가지도 않으며**, 건너뛴 목록으로 보고한다
 * (경로 밖 파일을 "감사한 production 소스"로 세면 감사 자체가 거짓이 된다).
 */
function collectMjsSources(root: string, subdir: string): { files: MjsSource[]; symlinks: string[] } {
  const files: MjsSource[] = [];
  const symlinks: string[] = [];
  const walk = (relDir: string): void => {
    const entries = readdirSync(join(root, relDir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      files.push({ rel, text: readFileSync(join(root, rel), "utf8") });
    }
  };
  walk(subdir);
  return { files, symlinks };
}

/** import 지정자를 repo 기준 상대경로로 푼다(상대 지정자만 해석하고, 그 밖은 null). */
function resolveModuleRel(fromRel: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const segs = fromRel.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return segs.join("/");
}

/**
 * 지정자를 **URL 규칙대로** 자르고 percent 인코딩을 푼다.
 * 순서는 URL 문법 그대로다: 첫 `#` 뒤는 전부 fragment이고(그 안의 `?`는 query가 아니다),
 * 그 앞의 첫 `?` 뒤가 query다. 남은 path는 `decodeURIComponent`로 디코드한다 —
 * Node ESM은 file URL을 디코드해 경로로 바꾸므로 `fixture%2Dconfig.mjs`는 `fixture-config.mjs`와 **같은 파일**이다.
 * 디코드 불가(`%zz`)나 인코딩된 경로 구분자(`%2F` — `fileURLToPath`가 거부한다)는 **판정 불가**로 올려 fail closed 한다.
 */
type CanonicalSpecifier = { path: string; suffix: string } | { unresolvable: string };
function canonicalizeSpecifier(spec: string): CanonicalSpecifier {
  const hash = spec.indexOf("#");
  const beforeFragment = hash === -1 ? spec : spec.slice(0, hash);
  const fragment = hash === -1 ? "" : spec.slice(hash);
  const q = beforeFragment.indexOf("?");
  const rawPath = q === -1 ? beforeFragment : beforeFragment.slice(0, q);
  const query = q === -1 ? "" : beforeFragment.slice(q);
  if (/%2f/i.test(rawPath)) return { unresolvable: `인코딩된 경로 구분자(%2F)를 포함한다: ${spec}` };
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return { unresolvable: `percent 인코딩을 해석할 수 없다: ${spec}` };
  }
  return { path, suffix: `${query}${fragment}` };
}

/**
 * 이 지정자가 로더 모듈을 가리키는가.
 * 상대 지정자는 정규화한 path로 해석해 비교하고(query/fragment/percent는 파일 판정에 영향이 없다),
 * 상대경로가 아니면(절대경로·`file:` URL·bare) 파일명으로 **fail closed** 판정한다.
 * 정규화 자체가 불가능하면 `unresolvable` — 호출자는 이것도 문제로 보고한다(안전하다고 넘기지 않는다).
 */
type SpecifierVerdict = { kind: "loader" } | { kind: "other" } | { kind: "unresolvable"; reason: string };
function classifySpecifier(fromRel: string, spec: string): SpecifierVerdict {
  const canon = canonicalizeSpecifier(spec);
  if ("unresolvable" in canon) return { kind: "unresolvable", reason: canon.unresolvable };
  const resolved = resolveModuleRel(fromRel, canon.path);
  if (resolved !== null) return resolved === LOADER_REL ? { kind: "loader" } : { kind: "other" };
  return canon.path.includes(`${LOADER_TOKEN}.mjs`) ? { kind: "loader" } : { kind: "other" };
}

/** import 선언이 로더 모듈에서 오는가(선언 sweep에서 "로더 import 바인딩"을 구분하는 데 쓴다). */
function isLoaderImportDecl(fromRel: string, decl: ts.ImportDeclaration): boolean {
  return ts.isStringLiteralLike(decl.moduleSpecifier) && classifySpecifier(fromRel, decl.moduleSpecifier.text).kind === "loader";
}

/**
 * 지정자 식을 **정적으로 접는다**: 문자열 리터럴 · 치환 없는 template · `+` 연결 ·
 * 그리고 파일 안에서 **정확히 한 번 `const`로 선언되고 초기화식이 있는** 이름(그 초기화식도 접힐 때).
 * 접히지 않으면 `null`.
 */
function foldSpecifier(node: ts.Expression, constOf: (name: string) => ts.Expression | null, depth = 0): string | null {
  if (depth > SPEC_FOLD_DEPTH) return null;
  if (ts.isStringLiteralLike(node)) return node.text; // StringLiteral + NoSubstitutionTemplateLiteral
  if (ts.isParenthesizedExpression(node)) return foldSpecifier(node.expression, constOf, depth + 1);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldSpecifier(node.left, constOf, depth + 1);
    if (left === null) return null;
    const right = foldSpecifier(node.right, constOf, depth + 1);
    return right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = foldSpecifier(span.expression, constOf, depth + 1);
      if (value === null) return null;
      out += value + span.literal.text;
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    const init = constOf(node.text);
    return init === null ? null : foldSpecifier(init, constOf, depth + 1);
  }
  return null;
}

/**
 * 접히지 않는 식에서 **도달 가능한 문자열 조각**을 bounded하게 모은다(const 바인딩을 따라간다).
 * 이것은 whole-program 증명이 아니라 **과대 근사(over-approximation)** 다 — 아래 bounded 규칙의 재료다.
 */
function reachableSpecifierLiterals(
  node: ts.Node,
  constOf: (name: string) => ts.Expression | null,
  depth = 0,
  out: Set<string> = new Set(),
  seen: Set<string> = new Set(),
): Set<string> {
  if (depth > SPEC_FOLD_DEPTH) return out;
  if (ts.isStringLiteralLike(node)) {
    out.add(node.text);
    return out;
  }
  if (ts.isTemplateExpression(node)) {
    out.add(node.head.text);
    for (const span of node.templateSpans) {
      out.add(span.literal.text);
      reachableSpecifierLiterals(span.expression, constOf, depth + 1, out, seen);
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return out;
    seen.add(node.text);
    const init = constOf(node.text);
    if (init !== null) reachableSpecifierLiterals(init, constOf, depth + 1, out, seen);
    return out;
  }
  ts.forEachChild(node, (child) => {
    reachableSpecifierLiterals(child, constOf, depth + 1, out, seen);
  });
  return out;
}

/**
 * 동적 로딩(`import()`/`require()`)의 지정자 판정 — **bounded fail-closed 규칙**이다.
 * (전체 프로그램 증명은 불가능하다. 아래가 이 감사가 주장하는 전부다.)
 *
 *  ① 식이 접히면(리터럴·치환 없는 template·`+` 연결·불변 const 문자열 바인딩) 그 결과를 지정자로 판정한다.
 *     로더면 `loader`, 아니면 `safe`, 정규화 불가면 `unproven`.
 *  ② 접히지 않으면 **도달 가능한 문자열 조각**을 모은다.
 *     · 조각이 **하나도 없으면**(예: 파라미터·재할당 `let`으로 온 값) 로더를 배제할 근거가 없다 → `unproven`.
 *     · 조각 중 하나라도 로더 token(`fixture-config`)을 포함하거나 정규화 불가면 → `loader`(가리킬 수 있음).
 *     · 그 밖에는 `safe`로 본다. 이것은 **증명이 아니라 bounded 규칙**이며, 이렇게 두는 이유는
 *       live runner 3종의 정상 동적 import(`await import(join(HERE, "..", "dist", ...))` 같은 빌드 산출물 로딩)를
 *       깨뜨리지 않기 위해서다. `unproven`·`loader`는 둘 다 **문제로 보고**되므로 조용히 통과하는 경로는 없다.
 */
type DynamicVerdict = { kind: "loader"; how: string } | { kind: "safe" } | { kind: "unproven"; reason: string };
function classifyDynamicSpecifier(fromRel: string, expr: ts.Expression, constOf: (name: string) => ts.Expression | null): DynamicVerdict {
  const folded = foldSpecifier(expr, constOf);
  if (folded !== null) {
    const verdict = classifySpecifier(fromRel, folded);
    if (verdict.kind === "loader") return { kind: "loader", how: `정적으로 접힌 지정자 "${folded}"` };
    if (verdict.kind === "unresolvable") return { kind: "unproven", reason: verdict.reason };
    return { kind: "safe" };
  }
  const literals = [...reachableSpecifierLiterals(expr, constOf)].filter((s) => s.length > 0);
  if (literals.length === 0) return { kind: "unproven", reason: "지정자에서 관측 가능한 문자열 조각이 없다" };
  for (const literal of literals) {
    const canon = canonicalizeSpecifier(literal);
    if ("unresolvable" in canon) return { kind: "loader", how: `계산된 지정자 조각 "${literal}"를 정규화할 수 없다` };
    if (canon.path.includes(LOADER_TOKEN)) return { kind: "loader", how: `계산된 지정자 조각 "${literal}"가 로더를 가리킬 수 있다` };
  }
  return { kind: "safe" };
}

/** 첫 인자가 **정확히** `process.argv.slice(2)`인지 구조로 본다(문자열 비교가 아니라 AST 모양). */
function isProcessArgvSlice2(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || node.questionDotToken || node.arguments.length !== 1) return false;
  const two = node.arguments[0];
  if (!ts.isNumericLiteral(two) || two.text !== "2") return false;
  const slice = node.expression;
  if (!ts.isPropertyAccessExpression(slice) || slice.questionDotToken || slice.name.text !== "slice") return false;
  const argv = slice.expression;
  if (!ts.isPropertyAccessExpression(argv) || argv.questionDotToken || argv.name.text !== "argv") return false;
  return ts.isIdentifier(argv.expression) && argv.expression.text === "process";
}

/** import 선언 자체의 이름 자리(참조가 아니다). export 이름 자리는 전용 노출 패스가 따로 본다. */
function isImportBindingSite(node: ts.Identifier): boolean {
  const p = node.parent;
  return !!p && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p));
}

/** 선언 한 건(shadow 판정 + 불변 const 문자열 folding 재료). */
type DeclInfo = { name: string; line: number; what: string; loaderImport: boolean; constInit: ts.Expression | null };

/**
 * 파일 안의 **모든 바인딩 선언**을 모은다: `var`/`let`/`const`(구조 분해 포함) · 함수 파라미터 ·
 * function/class 이름 · import 바인딩 · `catch` 변수.
 *
 * scope 트리를 만들어 "이 참조가 어느 선언을 가리키는가"를 정확히 계산하는 대신,
 * **"이 파일에 그 이름의 선언이 있는가"만 보고 있으면 감사를 실패시킨다**(conservative fail closed).
 * 감사는 "식별자 텍스트가 곧 import된 바인딩/전역"이라는 전제 위에서만 성립하므로,
 * 그 전제를 깨뜨릴 수 있는 선언이 하나라도 있으면 판정을 신뢰하지 않는 것이 옳다.
 * (한계: 여기 열거한 선언 형태만 본다 — 그래서 새 형태가 생기면 "가려지지 않았다"고 잘못 볼 수 있고,
 *  그 경우에도 호출 형태 검사·노출 검사·동적 로딩 검사는 그대로 동작한다.)
 */
function collectDeclarations(sf: ts.SourceFile, rel: string): DeclInfo[] {
  const out: DeclInfo[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const addName = (name: ts.BindingName, what: string, opts: { loaderImport?: boolean; constInit?: ts.Expression | null } = {}): void => {
    if (ts.isIdentifier(name)) {
      out.push({
        name: name.text,
        line: lineOf(name),
        what,
        loaderImport: opts.loaderImport === true,
        constInit: opts.constInit ?? null,
      });
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) addName(el.name, `${what}(구조 분해)`);
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      addName(node.name, isConst ? "const 선언" : "var/let/catch 선언", { constInit: isConst ? (node.initializer ?? null) : null });
    } else if (ts.isParameter(node)) {
      addName(node.name, "함수 파라미터");
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name
    ) {
      addName(node.name, "function/class 이름");
    } else if (ts.isImportSpecifier(node)) {
      const decl = node.parent.parent.parent;
      addName(node.name, "named import", { loaderImport: ts.isImportDeclaration(decl) && isLoaderImportDecl(rel, decl) });
    } else if (ts.isNamespaceImport(node)) {
      const decl = node.parent.parent;
      addName(node.name, "namespace import", { loaderImport: ts.isImportDeclaration(decl) && isLoaderImportDecl(rel, decl) });
    } else if (ts.isImportClause(node) && node.name) {
      addName(node.name, "default import", { loaderImport: ts.isImportDeclaration(node.parent) && isLoaderImportDecl(rel, node.parent) });
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(sf, walk);
  return out;
}

/**
 * 로더 모듈을 불러오는 **모든** 파일을 찾아 호출 계약을 감사한다(AST 기반, 다중 패스).
 *
 * 패스 순서(소스 순서에 의존하지 않는다):
 *  (0) 파싱 진단 — 구문 오류가 있으면 "부분 파싱된 소스"이므로 안전하다고 보지 않는다.
 *  (1) 선언 sweep — shadow 판정 + 불변 const 문자열 folding 재료.
 *  (2) import / `export … from` / 동적 로딩 수집(지정자는 URL 정규화 후 판정).
 *  (3) shadow 검사 — 전역 `process`나 추적 중인 바인딩을 가리는 선언이 하나라도 있으면 실패.
 *  (4) 노출 검사 — `export { X }`·`export { X as Y }`·`export default X`(namespace 포함) 재노출.
 *  (5) 참조 walk — 그 바인딩을 통한 호출만 계약(인자 2개 · 첫 인자 `process.argv.slice(2)`)으로 검사.
 *  (6) 미사용 바인딩/namespace · 다중 호출 검사.
 *
 * 별칭(`as`), namespace import(`ns.loadFixtureConfig`), 식별자와 `(` 사이의 공백·주석, 중첩 경로,
 * query/fragment/percent 지정자, 계산된 동적 로딩, import-then-export를 모두 다룬다.
 * 문자열·주석 안의 이름은 구문상 호출이 아니므로 오탐하지 않는다.
 */
function auditFixtureLoaderCalls(sources: MjsSource[]): LoaderCallerAudit[] {
  const audits: LoaderCallerAudit[] = [];

  for (const src of sources) {
    if (src.rel === LOADER_REL) continue; // 로더 자신은 호출부가 아니다
    const sf = ts.createSourceFile(src.rel, src.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const issues: string[] = [];

    // (0) 파싱 진단: 부분 파싱된 소스를 "로더를 부르지 않는다"의 근거로 쓰지 않는다(fail closed).
    const parseDiagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    const parseFailed = parseDiagnostics.length > 0;
    if (parseFailed) {
      const first = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, " ");
      issues.push(`${src.rel} 구문 오류 ${parseDiagnostics.length}건 — 부분 파싱된 소스를 안전하다고 볼 수 없다(fail closed): ${first}`);
    }

    // (1) 선언 sweep.
    const decls = collectDeclarations(sf, src.rel);
    const declsByName = new Map<string, DeclInfo[]>();
    for (const decl of decls) {
      const list = declsByName.get(decl.name) ?? [];
      list.push(decl);
      declsByName.set(decl.name, list);
    }
    /** 이름이 **정확히 한 번** `const`로 선언되고 초기화식이 있을 때만 folding에 쓴다(중복·재할당 가능 이름은 신뢰 불가). */
    const constOf = (name: string): ts.Expression | null => {
      const list = declsByName.get(name);
      return list && list.length === 1 ? list[0].constInit : null;
    };

    // (2) import / export-from / 동적 로딩 수집.
    const direct = new Set<string>(); // 로더 export를 가리키는 로컬 바인딩(별칭 포함)
    const namespaces = new Set<string>(); // import * as ns
    let importsLoader = false;

    const collectImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const verdict = classifySpecifier(src.rel, node.moduleSpecifier.text);
        if (verdict.kind === "unresolvable") {
          importsLoader = true;
          issues.push(`${src.rel}:${lineOf(node)} import 지정자를 정규화할 수 없어 로더 여부를 판정할 수 없다(fail closed): ${verdict.reason}`);
        } else if (verdict.kind === "loader") {
          importsLoader = true;
          const clause = node.importClause;
          if (!clause) issues.push(`${src.rel}:${lineOf(node)} 로더를 바인딩 없이 side-effect import 한다`);
          else {
            if (clause.name) issues.push(`${src.rel}:${lineOf(node)} 로더 default import(${clause.name.text}) — 계약에 없는 형태`);
            const nb = clause.namedBindings;
            if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
            else if (nb && ts.isNamedImports(nb)) {
              for (const el of nb.elements) {
                if ((el.propertyName ?? el.name).text === LOADER_EXPORT) direct.add(el.name.text);
              }
            }
          }
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const verdict = classifySpecifier(src.rel, node.moduleSpecifier.text);
        if (verdict.kind === "unresolvable") {
          importsLoader = true;
          issues.push(`${src.rel}:${lineOf(node)} export 지정자를 정규화할 수 없어 로더 여부를 판정할 수 없다(fail closed): ${verdict.reason}`);
        } else if (verdict.kind === "loader") {
          importsLoader = true;
          issues.push(`${src.rel}:${lineOf(node)} 로더를 재수출한다(직접 export-from) — 감사되지 않는 우회 경로가 생긴다`);
        }
      } else if (ts.isCallExpression(node)) {
        const dynamic =
          node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require");
        const arg0 = node.arguments[0];
        if (dynamic && arg0) {
          const verdict = classifyDynamicSpecifier(src.rel, arg0, constOf);
          if (verdict.kind === "loader") {
            importsLoader = true;
            issues.push(`${src.rel}:${lineOf(node)} 로더를 동적으로 불러온다 — 정적 감사를 우회한다(${verdict.how})`);
          } else if (verdict.kind === "unproven") {
            importsLoader = true;
            issues.push(
              `${src.rel}:${lineOf(node)} 동적 지정자를 정적으로 확정할 수 없어 로더가 아님을 증명할 수 없다(fail closed): ${verdict.reason}`,
            );
          }
        }
      }
      ts.forEachChild(node, collectImports);
    };
    ts.forEachChild(sf, collectImports);
    if (!importsLoader && !parseFailed) continue;

    // (3) shadow 검사 — 정확한 scope 계산 대신 "가릴 수 있는 선언이 있으면 실패"(fail closed).
    const shadowed = new Set<string>();
    const processDecls = declsByName.get("process") ?? [];
    const processShadowed = processDecls.length > 0;
    for (const decl of processDecls) {
      issues.push(`${src.rel}:${decl.line} 전역 process를 ${decl.what}으로 가린다 — 첫 인자 정규형을 신뢰할 수 없다(fail closed)`);
    }
    for (const name of [...direct, ...namespaces].sort()) {
      const list = declsByName.get(name) ?? [];
      const foreign = list.filter((d) => !d.loaderImport);
      const loaderDecls = list.filter((d) => d.loaderImport);
      for (const decl of foreign) {
        shadowed.add(name);
        issues.push(
          `${src.rel}:${decl.line} 로더 바인딩 ${name}을(를) ${decl.what}으로 가린다 — 같은 이름이 로더를 가리킨다고 볼 수 없다(fail closed)`,
        );
      }
      if (loaderDecls.length > 1) {
        shadowed.add(name);
        issues.push(`${src.rel} 로더 바인딩 ${name}이 ${loaderDecls.length}번 선언된다 — 유효 선언을 정적으로 확정할 수 없다(fail closed)`);
      }
    }

    // (4) 노출 검사 — import 순서와 무관하다(패스 2에서 바인딩을 이미 다 모았다).
    const exposeName = (local: string, node: ts.Node, how: string): void => {
      if (!direct.has(local) && !namespaces.has(local)) return;
      issues.push(
        `${src.rel}:${lineOf(node)} 로더 ${direct.has(local) ? "바인딩" : "namespace"} ${local}을(를) ${how}으로 재노출한다 — ` +
          `다른 모듈이 감사 밖에서 세 번째 인자를 넘길 수 있다`,
      );
    };
    const collectExposure = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          exposeName(local, el, el.propertyName ? `export { ${local} as ${el.name.text} }` : `export { ${local} }`);
        }
      } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
        exposeName(node.expression.text, node, "export default");
      }
      ts.forEachChild(node, collectExposure);
    };
    ts.forEachChild(sf, collectExposure);

    // (5) 참조 walk.
    const calls: LoaderCall[] = [];
    const usedLocal = new Set<string>();
    const inspectCall = (local: string, binding: string, call: ts.CallExpression): void => {
      usedLocal.add(local);
      const args = call.arguments.map((a) => a.getText(sf));
      // 지역 process shadow가 있으면 구조가 맞아도 "실제 argv"라고 볼 수 없다 → 정규형 아님.
      const canonicalFirstArg = !processShadowed && call.arguments.length > 0 && isProcessArgvSlice2(call.arguments[0]);
      const line = lineOf(call);
      if (args.length !== 2) {
        issues.push(`${src.rel}:${line} 로더 호출 인자 ${args.length}개 — argv+spec 2개만 허용(in-process io seam 전달 금지): ${args.join(" | ")}`);
      }
      if (!canonicalFirstArg) {
        const why = processShadowed ? "(지역 process shadow로 정규형을 신뢰할 수 없다)" : "";
        issues.push(`${src.rel}:${line} 로더 첫 인자가 process.argv.slice(2)가 아니다${why}: ${args[0] ?? "(없음)"}`);
      }
      calls.push({ binding, line, args, argCount: args.length, canonicalFirstArg });
    };

    const walkRefs = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isImportBindingSite(node)) {
        const parent = node.parent;
        // shadow된 이름은 **import 사용으로 인정하지 않는다**(어느 선언인지 확정할 수 없다). 이미 (3)에서 보고됐다.
        if (direct.has(node.text) && !shadowed.has(node.text)) {
          if (parent && ts.isCallExpression(parent) && parent.expression === node) inspectCall(node.text, node.text, parent);
          else if (!(parent && ts.isPropertyAccessExpression(parent) && parent.name === node)) {
            issues.push(`${src.rel}:${lineOf(node)} 로더 바인딩 ${node.text}을(를) 호출이 아닌 위치에서 참조한다 — 우회 표면`);
          }
        } else if (namespaces.has(node.text) && !shadowed.has(node.text)) {
          const pa = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent : null;
          if (pa && pa.name.text === LOADER_EXPORT) {
            if (pa.parent && ts.isCallExpression(pa.parent) && pa.parent.expression === pa) {
              inspectCall(node.text, `${node.text}.${LOADER_EXPORT}`, pa.parent);
            } else issues.push(`${src.rel}:${lineOf(node)} 로더를 호출이 아닌 위치에서 참조한다 — 우회 표면`);
          } else if (parent && ts.isElementAccessExpression(parent) && parent.expression === node) {
            issues.push(`${src.rel}:${lineOf(node)} 로더 네임스페이스를 계산된 key로 참조한다 — 정적 감사를 우회한다`);
          } else if (!pa) {
            issues.push(`${src.rel}:${lineOf(node)} 로더 네임스페이스 ${node.text}을(를) 값으로 참조한다 — 우회 표면`);
          }
        }
      }
      ts.forEachChild(node, walkRefs);
    };
    ts.forEachChild(sf, walkRefs);

    // (6) 미사용 바인딩/namespace · 다중 호출.
    for (const name of [...direct].sort()) {
      if (!usedLocal.has(name)) issues.push(`${src.rel} 로더 바인딩 ${name}을(를) import하고 호출하지 않는다 — 사용처를 확인하라`);
    }
    for (const name of [...namespaces].sort()) {
      if (!usedLocal.has(name)) issues.push(`${src.rel} 로더 네임스페이스 ${name}을(를) import하고 호출하지 않는다 — 사용처를 확인하라`);
    }
    if (calls.length > 1) issues.push(`${src.rel} 로더 호출이 ${calls.length}번이다 — production 진입점은 1회 호출 계약이다`);

    audits.push({ rel: src.rel, bindings: [...direct, ...[...namespaces].map((n) => `${n}.*`)].sort(), calls, issues });
  }

  return audits.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * pause 지점에서 멈춘 wrapper를 대상으로 "① 멈춤 확인 → ② 파일시스템 조작 → ③ resume → ④ 종료 대기"를
 * 한 번에 돌린다. 조작 후 권한 복구를 반드시 수행한다(임시 디렉터리 정리 실패 방지).
 */
async function pauseThen(
  opts: {
    dir: string;
    pauseDir: string;
    args: string[];
    config: Record<string, unknown>;
    name: string;
    mutateDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [LOCK_CLI, ...opts.args, "--fixture-config", fixtureFile(opts.dir, opts.config, opts.name)], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    env: opts.env ?? isolatedEnv(),
  });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
  child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code: number | null) => resolve(code)));
  let restored = true;
  try {
    await waitForFile(join(opts.pauseDir, "paused"), 30_000);
    if (opts.mutateDir) {
      chmodSync(opts.mutateDir, 0o555); // 이 지점 이후의 파일 조작만 실패하게 만든다
      restored = false;
    }
    writeFileSync(join(opts.pauseDir, "resume"), "go", "utf8");
    const code = await exited;
    if (opts.mutateDir) {
      chmodSync(opts.mutateDir, 0o755);
      restored = true;
    }
    return { code, stderr, stdout };
  } finally {
    if (opts.mutateDir && !restored) chmodSync(opts.mutateDir, 0o755);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

// ── 1) lock 기본 계약: 획득·해제 ─────────────────────────────────────────────

test("[M3d.2] suite lock: 획득 후 해제되고 lock·guard 파일이 남지 않는다", () => {
  withTemp((dir) => {
    const cfg = lockConfig(dir);
    const r = runLockCli(["probe"], cfg, dir);
    assert.equal(r.status, 0, `probe PASS (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stdout), /"reentered":false/);
    assert.equal(existsSync(lockPathOf(cfg)), false, "lock 파일 해제됨");
    assert.equal(existsSync(guardPathOf(cfg)), false, "정상 전이 후 transition guard 제거됨");
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] suite lock: 상대경로 lock 경로 override는 fixture 검증에서 거부(fail closed)", () => {
  withTemp((dir) => {
    const r = runLockCli(["probe"], { ...lockConfig(dir), lockPath: "relative/suite.lock" }, dir);
    assert.equal(r.status, 2);
    assert.match(String(r.stderr), /fixture_value_invalid/);
  });
});

// ── 2) production 경로는 테스트 override를 해석하지 않는다 (P2-6) ─────────────

test("[M3d.2] production 진입점: fixture 설정 없이는 테스트 모드를 거부하고 env seam도 무시한다", () => {
  withTemp((dir) => {
    const envLockPath = join(dir, "env-suite.lock");
    // 옛 seam env를 모두 심어도 production 경로는 이를 해석하지 않는다.
    const env = isolatedEnv({
      HARNESS_SUITE_LOCK_PATH: envLockPath,
      HARNESS_SUITE_PS_FIXTURE: psFixture(dir, SUITE_PS_ROWS, "ps-suite.txt"),
      HARNESS_SUITE_LOCK_PAUSE_DIR: dir,
      HARNESS_SUITE_LOCK_PAUSE_AT: "before_unlink",
      HARNESS_SUITE_LOCK_INJECT: "confirm_failure",
      HARNESS_SUITE_LOCK_INJECT_DIR: dir,
      HARNESS_STRESS_SUITE_MODE: "noop_pass",
      HARNESS_STRESS_INJECT: "cleanup_confirm_failure",
      HARNESS_LIVE_EVIDENCE_DIR: dir,
    });
    for (const args of [["probe"], ["hold", "100"], ["child", "residual"], ["quarantine", "cleanup_unconfirmed"]]) {
      const r = spawnSync(process.execPath, [LOCK_CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env });
      assert.equal(r.status, 2, `테스트 모드는 fixture 없이 거부: ${args[0]} (stderr: ${String(r.stderr).slice(0, 200)})`);
      assert.match(String(r.stderr), /테스트 전용/, `거부 이유 명시: ${args[0]}`);
    }
    assert.equal(existsSync(envLockPath), false, "env로 준 경로에 아무것도 만들지 않는다");
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.includes("env-suite.lock")),
      [],
      "env seam은 lock 파일·guard를 만들지 않는다",
    );
  });
});

test("[M3d.2] production 소스에는 제거된 env seam 참조가 없고 lock 라이브러리는 process.env를 읽지 않는다", () => {
  const removed = [
    "HARNESS_SUITE_LOCK_PATH",
    "HARNESS_SUITE_PS_FIXTURE",
    "HARNESS_SUITE_LOCK_PAUSE_DIR",
    "HARNESS_SUITE_LOCK_PAUSE_AT",
    "HARNESS_SUITE_LOCK_INJECT",
    "HARNESS_SUITE_LOCK_INJECT_DIR",
    "HARNESS_SUITE_LOCK_CHILD_MS",
    "HARNESS_SUITE_LOCK_CONFIRM_MS",
    "HARNESS_STRESS_INJECT",
    "HARNESS_STRESS_SUITE_MODE",
    "HARNESS_STRESS_INJECT_DIR",
    "HARNESS_STRESS_SUITE_SLEEP_MS",
    "HARNESS_STRESS_CONFIRM_MS",
    "HARNESS_LIVE_EVIDENCE_DIR",
  ];
  const productionFiles = [
    LOCK_LIB,
    LOCK_CLI,
    STRESS,
    join(REPO_ROOT, "scripts", "lib", "fixture-config.mjs"),
    join(REPO_ROOT, "src", "tools", "liveEvidence.ts"),
    join(REPO_ROOT, "scripts", "m3a-live-preflight.mjs"),
    join(REPO_ROOT, "scripts", "m3b2-live-handoff.mjs"),
    join(REPO_ROOT, "scripts", "m3c3b-live-handoff.mjs"),
  ];
  for (const file of productionFiles) {
    const src = readFileSync(file, "utf8");
    for (const name of removed) {
      assert.equal(src.includes(name), false, `${file.split("/").pop()}에 제거된 seam ${name} 참조가 남아 있다`);
    }
  }
  // 주석에 적힌 설명(“env를 읽지 않는다”)이 아니라 **실행되는 코드**에 접근이 없는지 본다.
  const envRefs = stripComments(readFileSync(LOCK_LIB, "utf8")).match(/process\s*\.\s*env/g) ?? [];
  assert.deepEqual(envRefs, [], "lock 라이브러리는 process.env를 읽지 않는다(모든 입력은 명시 옵션)");
});

// ── 3) 경합: 일반 suite와 stress는 같은 lock 하나를 지난다 ────────────────────

test("[M3d.2] lock 경합: 보유 중이면 두 번째 suite와 stress 모두 거부(exit 2)", async () => {
  await withTempAsync(async (dir) => {
    const cfg = lockConfig(dir);
    const lockPath = lockPathOf(cfg);
    const holder = spawn(process.execPath, [LOCK_CLI, "hold", "8000", "--fixture-config", fixtureFile(dir, cfg, "holder.json")], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      env: isolatedEnv(),
    });
    try {
      await waitUntil(() => existsSync(lockPath), "holder가 lock을 잡는다");

      const second = runLockCli(["probe"], cfg, dir, "second.json");
      assert.equal(second.status, 2, "두 번째 일반 suite 거부");
      assert.match(String(second.stderr), /lock_held/);

      const stress = runStress(stressConfig(dir, { suiteMode: "noop_pass" }), dir, 60_000);
      assert.equal(stress.status, 2, `stress도 거부 (stderr: ${String(stress.stderr).slice(0, 300)})`);
      assert.match(String(stress.stderr), /lock_held/);
      assert.ok(existsSync(lockPath), "거부된 쪽이 남의 lock을 지우지 않는다");
      assert.equal(existsSync(guardPathOf(cfg)), false, "계약상 거부는 guard를 남기지 않는다");
    } finally {
      holder.kill("SIGTERM");
      await waitUntil(() => !existsSync(lockPath), "holder 종료 후 lock 해제", 20_000).catch(() => undefined);
    }
    assert.equal(existsSync(lockPath), false, "holder 종료 시 lock 해제");
    assertNoLockResidue(dir);
  });
});

// ── 4) orphan lock: 자동 회수 없음 (Codex Sol xhigh P1-2) ────────────────────

test("[M3d.2] orphan lock: 소유자가 죽었어도 자동 회수하지 않고 거부한다(수동 확인 전까지 fail closed)", () => {
  withTemp((dir) => {
    const cfg = lockConfig(dir);
    const lockPath = lockPathOf(cfg);
    const identity = selfIdentity();
    assert.ok(identity.length > 0, "self identity 확보");

    // (a) 소유자 pid가 존재하지 않음 → 회수 금지, 거부.
    writeLockFile(lockPath, { v: LOCK_V, kind: "suite", pid: deadPid(), identity, tokenHash: "0".repeat(64) });
    const inoA = lstatSync(lockPath).ino;
    const a = runLockCli(["probe"], cfg, dir, "a.json");
    assert.equal(a.status, 2, `죽은 소유자 lock은 거부 (stderr: ${String(a.stderr).slice(0, 300)})`);
    assert.match(String(a.stderr), /lock_orphaned/);
    assert.equal(lstatSync(lockPath).ino, inoA, "orphan lock을 건드리지 않는다");

    // (b) pid는 살아있지만 lstart가 다름(pid 재사용) → 역시 orphan으로 거부.
    writeLockFile(lockPath, { v: LOCK_V, kind: "stress", pid: process.pid, identity: "Sat Jan  1 00:00:00 2000", tokenHash: "1".repeat(64) });
    const inoB = lstatSync(lockPath).ino;
    const b = runLockCli(["probe"], cfg, dir, "b.json");
    assert.equal(b.status, 2, "pid 재사용 lock도 거부");
    assert.match(String(b.stderr), /lock_orphaned/);
    assert.equal(lstatSync(lockPath).ino, inoB, "건드리지 않는다");

    // (c) 소유자 pid+lstart가 실제로 살아있음 → lock_held.
    writeLockFile(lockPath, { v: LOCK_V, kind: "suite", pid: process.pid, identity, tokenHash: "2".repeat(64) });
    const c = runLockCli(["probe"], cfg, dir, "c.json");
    assert.equal(c.status, 2, "살아있는 소유자 lock은 회수하지 않는다");
    assert.match(String(c.stderr), /lock_held/);
    assert.ok(existsSync(lockPath), "남의 lock 보존");
    assertNoLockResidue(dir);
    rmSync(lockPath, { force: true });
  });
});

test("[M3d.2] stress runner도 orphan lock을 회수하지 않고 거부한다", () => {
  withTemp((dir) => {
    const cfg = stressConfig(dir, { suiteMode: "noop_pass" });
    const lockPath = lockPathOf(cfg);
    writeLockFile(lockPath, { v: LOCK_V, kind: "suite", pid: deadPid(), identity: selfIdentity(), tokenHash: "0".repeat(64) });
    const ino = lstatSync(lockPath).ino;
    const r = runStress(cfg, dir, 60_000);
    assert.equal(r.status, 2, `거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stderr), /lock_orphaned/);
    assert.equal(lstatSync(lockPath).ino, ino, "orphan lock 보존");
  });
});

test("[M3d.2] 확인 불가한 lock은 회수하지 않고 거부한다(fail closed)", () => {
  const identity = selfIdentity();
  const cases: Array<[string, unknown]> = [
    ["손상 JSON", "{not-json"],
    ["버전 불일치", { v: 99, kind: "suite", pid: process.pid, identity, tokenHash: "0".repeat(64) }],
    ["옛 v1 record", { v: 1, kind: "suite", pid: process.pid, identity, tokenHash: "0".repeat(64) }],
    ["kind 미지정", { v: LOCK_V, kind: "unknown", pid: process.pid, identity, tokenHash: "0".repeat(64) }],
    ["pid 없음", { v: LOCK_V, kind: "suite", identity, tokenHash: "0".repeat(64) }],
    ["identity 형식 위반", { v: LOCK_V, kind: "suite", pid: process.pid, identity: "yesterday", tokenHash: "0".repeat(64) }],
    ["tokenHash 형식 위반", { v: LOCK_V, kind: "suite", pid: process.pid, identity, tokenHash: "short" }],
    ["격리 표시 형식 위반", { v: LOCK_V, kind: "suite", pid: process.pid, identity, tokenHash: "0".repeat(64), quarantined: "yes" }],
  ];
  for (const [label, record] of cases) {
    withTemp((dir) => {
      const cfg = lockConfig(dir);
      const lockPath = lockPathOf(cfg);
      writeLockFile(lockPath, record);
      const r = runLockCli(["probe"], cfg, dir);
      assert.equal(r.status, 2, `거부: ${label} (stderr: ${String(r.stderr).slice(0, 200)})`);
      assert.match(String(r.stderr), /lock_unverifiable/, `fail closed 코드: ${label}`);
      assert.ok(existsSync(lockPath), `회수하지 않음: ${label}`);
      assertNoLockResidue(dir);
    });
  }
});

test("[M3d.2] SIGKILL로 죽은 소유자의 lock은 orphan으로 남아 다음 suite를 막는다", async () => {
  await withTempAsync(async (dir) => {
    const cfg = wrapperConfig(dir, { childMs: 30_000 });
    const lockPath = lockPathOf(cfg);
    const w = spawn(process.execPath, [LOCK_CLI, "child", "sleep", "--fixture-config", fixtureFile(dir, cfg, "killed.json")], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      env: isolatedEnv(),
    });
    try {
      await waitForPidFile(join(dir, "grandchild.pid"));
      assert.ok(existsSync(lockPath), "lock 보유 중");
      w.kill("SIGKILL"); // 정리·해제 경로를 실행할 기회 없이 사망
      await waitUntil(() => w.exitCode !== null || w.signalCode !== null, "wrapper 사망");

      assert.ok(existsSync(lockPath), "SIGKILL 후 lock 파일이 남는다");
      assert.equal(readLockRecord(lockPath).quarantined, undefined, "격리 표시는 없다(표시할 기회가 없었다)");
      assert.equal(existsSync(guardPathOf(cfg)), false, "전이 중이 아니었으므로 guard는 없다");

      // 소유자의 죽음은 정리 완료 증거가 아니다 → 자동 회수 없이 거부한다.
      const blocked = runLockCli(["probe"], cfg, dir, "after-kill.json");
      assert.equal(blocked.status, 2, `orphan lock은 거부 (stderr: ${String(blocked.stderr).slice(0, 300)})`);
      assert.match(String(blocked.stderr), /lock_orphaned/);
      assert.ok(existsSync(lockPath), "거부가 orphan lock을 지우지 않는다");
    } finally {
      // 이 테스트가 만든 fixture 프로세스(고아가 된 detached 그룹)만 정리한다.
      killPidFileGroup(dir, "child.pid");
      killPidFileGroup(dir, "grandchild.pid");
      if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
    }
    await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
  });
});

// ── 5) 재진입 token: 위조·유령 token은 거부 ──────────────────────────────────

test("[M3d.2] 재진입 token 위조·lock 부재는 거부(PID 신뢰 아님)", async () => {
  await withTempAsync(async (dir) => {
    const cfg = lockConfig(dir);
    const lockPath = lockPathOf(cfg);
    // (a) lock 파일이 없는데 token만 있는 경우
    const missing = spawnSync(
      process.execPath,
      [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfg, "missing.json")],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env: isolatedEnv({ HARNESS_SUITE_LOCK_TOKEN: "a".repeat(64) }) },
    );
    assert.equal(missing.status, 2);
    assert.match(String(missing.stderr), /reentry_lock_missing/);
    assert.equal(existsSync(guardPathOf(cfg)), false, "거부는 guard를 남기지 않는다");

    // (b) 실제 lock이 있으나 token이 다른 경우
    const holder = spawn(process.execPath, [LOCK_CLI, "hold", "6000", "--fixture-config", fixtureFile(dir, cfg, "holder2.json")], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      env: isolatedEnv(),
    });
    try {
      await waitUntil(() => existsSync(lockPath), "holder가 lock을 잡는다");
      const wrong = spawnSync(
        process.execPath,
        [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfg, "wrong.json")],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env: isolatedEnv({ HARNESS_SUITE_LOCK_TOKEN: "b".repeat(64) }) },
      );
      assert.equal(wrong.status, 2);
      assert.match(String(wrong.stderr), /reentry_token_invalid/);
      assert.ok(existsSync(lockPath), "거부가 남의 lock을 지우지 않는다");
    } finally {
      holder.kill("SIGTERM");
      await waitUntil(() => !existsSync(lockPath), "holder 종료 후 해제", 20_000).catch(() => undefined);
    }
    assertNoLockResidue(dir);
  });
});

// ── 6) `ps` backstop: 일반 npm test / tsx launcher 탐지 ──────────────────────

test("[M3d.2] ps backstop: lock 없이 실행 중인 suite/launcher는 감지하고 무관 프로세스는 무시한다", () => {
  // (a) 무관 프로세스만 있으면 통과한다(오탐 없음).
  withTemp((dir) => {
    const r = runLockCli(["probe"], lockConfig(dir, {}, CLEAN_PS_ROWS), dir);
    assert.equal(r.status, 0, `오탐 없음 (stderr: ${String(r.stderr).slice(0, 300)})`);
  });
  // (b) suite 후보가 한 줄이라도 있으면 거부한다.
  for (const row of SUITE_PS_ROWS) {
    withTemp((dir) => {
      const cfg = lockConfig(dir, {}, [...CLEAN_PS_ROWS, row]);
      const r = runLockCli(["probe"], cfg, dir);
      assert.equal(r.status, 2, `감지 실패: ${row}`);
      assert.match(String(r.stderr), /concurrent_suite/);
      assert.equal(existsSync(lockPathOf(cfg)), false, "거부 시 lock 파일을 만들지 않는다");
      assertNoLockResidue(dir);
    });
  }
  // (c) `ps` 확인 자체가 불가하면 거부한다(fail closed).
  withTemp((dir) => {
    const cfg = { ...lockConfig(dir), psFixture: join(dir, "missing-ps.txt") };
    const r = runLockCli(["probe"], cfg, dir);
    assert.equal(r.status, 2);
    assert.match(String(r.stderr), /ps_unavailable/);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

// ── 7) transition guard: 모든 전이의 공용 직렬화 지점 (P1-1/P1-2/P1-3) ────────

test("[M3d.2] transition guard가 남아 있으면 lock 파일이 없어도 acquire를 거부한다(자동 제거 금지)", () => {
  const identity = selfIdentity();
  const cases: Array<[string, unknown]> = [
    ["죽은 전이자", { v: LOCK_V, purpose: "release", pid: deadPid(), identity, nonce: "a".repeat(32) }],
    ["살아있는 전이자", { v: LOCK_V, purpose: "acquire", pid: process.pid, identity, nonce: "b".repeat(32) }],
    ["손상 guard", "{not-json"],
  ];
  for (const [label, record] of cases) {
    withTemp((dir) => {
      const cfg = lockConfig(dir, { guardWaitMs: 100 });
      const guardPath = guardPathOf(cfg);
      writeGuardFile(guardPath, record);
      const ino = lstatSync(guardPath).ino;

      const r = runLockCli(["probe"], cfg, dir);
      assert.equal(r.status, 2, `거부: ${label} (stderr: ${String(r.stderr).slice(0, 300)})`);
      assert.match(String(r.stderr), /lock_transition_guard_present/, label);
      assert.match(String(r.stderr), /수동으로/, `수동 제거 안내: ${label}`);
      assert.equal(lstatSync(guardPath).ino, ino, `guard를 자동 제거하지 않는다: ${label}`);
      assert.equal(existsSync(lockPathOf(cfg)), false, `guard가 있으면 lock을 만들지 않는다: ${label}`);

      // stress runner도 같은 guard를 존중한다.
      const s = runStress({ ...stressConfig(dir, { suiteMode: "noop_pass", guardWaitMs: 100 }) }, dir, 60_000);
      assert.equal(s.status, 2, `stress도 거부: ${label}`);
      assert.match(String(s.stderr), /lock_transition_guard_present/);
      assert.ok(existsSync(guardPath), `stress 거부도 guard를 지우지 않는다: ${label}`);
    });
  }
});

test("[M3d.2] transition guard는 acquire 전이를 직렬화한다(경합 시 bounded 대기 후 거부)", async () => {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfgA = lockConfig(dir, { pauseDir, pauseAt: "after_guard_acquire" });
    const lockPath = lockPathOf(cfgA);
    const a = spawn(process.execPath, [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfgA, "a.json")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let aErr = "";
    a.stderr.on("data", (d: Buffer) => (aErr += String(d)));
    const aExit = new Promise<number | null>((resolve) => a.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused"));
      assert.ok(existsSync(guardPathOf(cfgA)), "A가 guard를 보유 중");
      assert.equal(existsSync(lockPath), false, "A는 아직 lock을 만들지 않았다");

      // B: guard 경합 → bounded 대기 후 거부. lock을 만들지 않는다.
      const b = runLockCli(["probe"], lockConfig(dir, { guardWaitMs: 200 }), dir, "b.json");
      assert.equal(b.status, 2, `B 거부 (stderr: ${String(b.stderr).slice(0, 300)})`);
      assert.match(String(b.stderr), /lock_transition_guard_present/);
      assert.equal(existsSync(lockPath), false, "경합에서 lock이 두 개 생기지 않는다");

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      assert.equal(await aExit, 0, `A는 정상 완료 (stderr: ${aErr.slice(0, 300)})`);
      assert.equal(existsSync(lockPath), false, "A가 정상 해제");
      assertNoLockResidue(dir);
    } finally {
      if (a.exitCode === null && a.signalCode === null) a.kill("SIGKILL");
    }
  });
});

test("[M3d.2] 격리 기록이 실패하면 lock을 노출하지 않고 guard를 남긴다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const cfg = wrapperConfig(dir, {
      lockPath: join(lockDir, "suite.lock"),
      inject: "confirm_failure",
      confirmMs: 600,
      childMs: 2_000,
      pauseDir,
      pauseAt: "before_quarantine_write",
      guardWaitMs: 200,
    });
    const lockPath = lockPathOf(cfg);
    const w = spawn(process.execPath, [LOCK_CLI, "child", "residual", "--fixture-config", fixtureFile(dir, cfg, "q.json")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stderr = "";
    w.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => w.on("close", (code: number | null) => resolve(code)));
    let restored = false;
    try {
      await waitForFile(join(pauseDir, "paused"), 30_000); // 격리 write 직전에서 멈춤
      chmodSync(lockDir, 0o555); // 격리 임시 파일조차 만들 수 없게 한다
      writeFileSync(join(pauseDir, "resume"), "go", "utf8");

      const code = await exited;
      chmodSync(lockDir, 0o755);
      restored = true;
      assert.equal(code, 1, `격리 실패는 실패로 보고 (stderr: ${stderr.slice(0, 500)})`);
      assert.match(stderr, /lock 격리 임시 파일 생성 실패/, "격리 실패를 조용히 넘기지 않는다");
      assert.ok(existsSync(lockPath), "lock을 해제하지 않는다");
      assert.equal(readLockRecord(lockPath).quarantined, undefined, "격리 표시는 기록되지 않았다");
      assert.ok(existsSync(guardPathOf(cfg)), "전이 오류는 transition guard를 남긴다(fail closed)");

      // guard가 남아 있으니 다음 suite·stress는 시작할 수 없다.
      const blocked = runLockCli(["probe"], { ...cfg, guardWaitMs: 100 }, dir, "blocked.json");
      assert.equal(blocked.status, 2, "guard가 남아 있으면 새 suite 거부");
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
      await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
    } finally {
      if (!restored) chmodSync(lockDir, 0o755);
      if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
      killPidFileGroup(dir, "child.pid");
      killPidFileGroup(dir, "grandchild.pid");
    }
  });
});

test("[M3d.2] release↔quarantine 경합(A): release가 전이 중이면 동시 격리는 실패하고 lock을 바꾸지 않는다", async () => {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const token = "c".repeat(64);
    const holderCfg = lockConfig(dir, { acquireToken: token, pauseDir, pauseAt: "before_unlink" });
    const lockPath = lockPathOf(holderCfg);
    const holder = spawn(
      process.execPath,
      [LOCK_CLI, "hold", "300", "--fixture-config", fixtureFile(dir, holderCfg, "holder.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let hErr = "";
    holder.stderr.on("data", (d: Buffer) => (hErr += String(d)));
    const hExit = new Promise<number | null>((resolve) => holder.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused")); // release가 guard를 쥔 채 unlink 직전
      const recordBefore = readLockRecord(lockPath);

      // 같은 lock을 token으로 격리 시도 → guard 경합으로 실패해야 하고 lock을 바꾸지 않아야 한다.
      const q = runLockCli(
        ["quarantine", "cleanup_unconfirmed"],
        lockConfig(dir, { acquireToken: token, guardWaitMs: 200 }),
        dir,
        "q.json",
      );
      assert.equal(q.status, 1, `격리 시도는 실패 (stdout: ${String(q.stdout).slice(0, 300)})`);
      assert.match(String(q.stdout), /lock_transition_guard_present/, "guard 경합으로 실패했음을 보고");
      assert.deepEqual(readLockRecord(lockPath), recordBefore, "경합 실패는 lock 내용을 바꾸지 않는다");

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      assert.equal(await hExit, 0, `holder 정상 종료 (stderr: ${hErr.slice(0, 300)})`);
      assert.equal(existsSync(lockPath), false, "release가 정상 완료");
      assertNoLockResidue(dir);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });
});

test("[M3d.2] release↔quarantine 경합(B): 먼저 기록된 격리를 소유자의 release가 지우지 않는다", async () => {
  await withTempAsync(async (dir) => {
    const token = "d".repeat(64);
    const holderCfg = lockConfig(dir, { acquireToken: token });
    const lockPath = lockPathOf(holderCfg);
    const holder = spawn(
      process.execPath,
      [LOCK_CLI, "hold", "2500", "--fixture-config", fixtureFile(dir, holderCfg, "holder.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let hErr = "";
    holder.stderr.on("data", (d: Buffer) => (hErr += String(d)));
    const hExit = new Promise<number | null>((resolve) => holder.on("close", (code: number | null) => resolve(code)));
    try {
      await waitUntil(() => existsSync(lockPath), "holder가 lock을 잡는다");

      // 재진입 child가 정리 확인 실패로 상위 lock을 격리한 상황.
      const q = runLockCli(["quarantine", "repeated_signal"], lockConfig(dir, { acquireToken: token }), dir, "q.json");
      assert.equal(q.status, 0, `격리 성공 (stdout: ${String(q.stdout).slice(0, 300)})`);
      assert.equal(readLockRecord(lockPath).quarantined, true, "격리 표시");

      // 이후 소유자의 release는 격리를 **지우지 않고** 문제로 보고해야 한다.
      const code = await hExit;
      assert.equal(code, 1, `해제 실패로 보고 (stderr: ${hErr.slice(0, 400)})`);
      assert.match(hErr, /격리 상태/);
      assert.ok(existsSync(lockPath), "격리된 lock이 살아 있다");
      assert.equal(readLockRecord(lockPath).quarantined, true);
      assert.equal(readLockRecord(lockPath).quarantineReason, "repeated_signal", "격리 이유가 덮이지 않았다");
      assertNoLockResidue(dir);

      const blocked = runLockCli(["probe"], lockConfig(dir), dir, "blocked.json");
      assert.equal(blocked.status, 2, "격리된 동안 새 suite 거부");
      assert.match(String(blocked.stderr), /lock_quarantined/);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });
});

/**
 * "release가 소유 확인 후 blind unlink" TOCTOU 회귀.
 * unlink 직전에서 멈춘 releaser가, 그 사이 교체된 파일을 **지우지 않고** guard를 남기는지 본다.
 * (재확인을 제거하면 두 케이스 모두 교체된 파일이 사라져 실패한다.)
 */
async function assertReleaseDoesNotDeleteReplacement(
  label: string,
  makeReplacement: (dir: string, original: Record<string, unknown>) => Record<string, unknown>,
  expectedProblem: RegExp,
): Promise<void> {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfg = lockConfig(dir, { acquireToken: "a1".repeat(16), pauseDir, pauseAt: "before_unlink" });
    const lockPath = lockPathOf(cfg);
    const holder = spawn(
      process.execPath,
      [LOCK_CLI, "hold", "300", "--fixture-config", fixtureFile(dir, cfg, "holder.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let hErr = "";
    holder.stderr.on("data", (d: Buffer) => (hErr += String(d)));
    const hExit = new Promise<number | null>((resolve) => holder.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused")); // release가 guard를 쥔 채 unlink 직전에서 멈춰 있다

      // 계약 밖 행위자가 그 사이에 경로를 **다른 파일**로 교체한 상황(원자적 rename).
      const swap = join(dir, "replacement.json");
      const replacement = makeReplacement(dir, readLockRecord(lockPath));
      writeLockFile(swap, replacement);
      renameSync(swap, lockPath);
      const newIno = lstatSync(lockPath).ino;

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      const code = await hExit;
      assert.equal(code, 1, `${label}: 해제 실패로 보고 (stderr: ${hErr.slice(0, 500)})`);
      assert.match(hErr, expectedProblem, `${label}: 재확인으로 교체를 잡아낸다`);
      assert.ok(existsSync(lockPath), `${label}: 교체된 lock을 지우지 않는다`);
      assert.equal(lstatSync(lockPath).ino, newIno, `${label}: 같은 파일이 그대로 남아 있다`);
      assert.deepEqual(readLockRecord(lockPath), replacement, `${label}: 내용도 그대로`);
      assert.ok(existsSync(guardPathOf(cfg)), `${label}: 전이 오류는 transition guard를 남긴다(fail closed)`);

      const blocked = runLockCli(["probe"], { ...lockConfig(dir), guardWaitMs: 100 }, dir, "blocked.json");
      assert.equal(blocked.status, 2, `${label}: guard가 남아 있으면 새 suite는 시작하지 못한다`);
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });
}

test("[M3d.2] release↔새 lock: 전이 중 lock이 교체되면 새 lock을 지우지 않고 guard를 남긴다(fail closed)", async () => {
  // (a) 다른 소유자의 새 lock — 추측 불가능한 tokenHash가 다르다.
  await assertReleaseDoesNotDeleteReplacement(
    "다른 소유자",
    () => ({ v: LOCK_V, kind: "stress", pid: process.pid, identity: selfIdentity(), tokenHash: "9".repeat(64) }),
    /lock 소유자 불일치 — 건드리지 않음/,
  );
  // (b) 내용은 같지만 **파일이 교체된** 경우 — inode CAS가 잡는다.
  await assertReleaseDoesNotDeleteReplacement(
    "동일 내용·다른 inode",
    (_dir, original) => original,
    /lock 파일 신원\(inode\) 불일치 — 건드리지 않음/,
  );
});

test("[M3d.2] 전이 중 SIGKILL: lock과 guard가 모두 남아 이후 suite/stress를 막는다(자동 회수 없음)", async () => {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfg = lockConfig(dir, { pauseDir, pauseAt: "before_unlink" });
    const lockPath = lockPathOf(cfg);
    const guardPath = guardPathOf(cfg);
    const holder = spawn(
      process.execPath,
      [LOCK_CLI, "hold", "300", "--fixture-config", fixtureFile(dir, cfg, "holder.json")],
      { cwd: REPO_ROOT, stdio: "ignore", env: isolatedEnv() },
    );
    const hExit = new Promise<void>((resolve) => holder.on("close", () => resolve()));
    try {
      await waitForFile(join(pauseDir, "paused")); // guard 보유 + lock 존재 상태
      assert.ok(existsSync(guardPath), "전이 중에는 guard가 존재한다");
      assert.ok(existsSync(lockPath), "아직 해제 전이다");
      holder.kill("SIGKILL"); // 전이 한복판에서 강제 종료 — 정리 코드를 실행할 기회가 없다
      await hExit;

      assert.ok(existsSync(lockPath), "lock이 남는다");
      assert.ok(existsSync(guardPath), "crash-persistent guard가 남는다");
      const guardIno = lstatSync(guardPath).ino;

      for (const [label, r] of [
        ["suite", runLockCli(["probe"], { ...lockConfig(dir), guardWaitMs: 100 }, dir, "after-kill.json")],
        ["stress", runStress(stressConfig(dir, { suiteMode: "noop_pass", guardWaitMs: 100 }), dir, 60_000)],
      ] as Array<[string, SpawnSyncReturns<string>]>) {
        assert.equal(r.status, 2, `${label}: 거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
        assert.match(String(r.stderr), /lock_transition_guard_present/, label);
        assert.match(String(r.stderr), /사망/, `${label}: 죽은 전이자를 진단으로 알린다`);
        assert.match(String(r.stderr), /수동으로/, `${label}: 수동 제거 안내`);
      }
      assert.equal(lstatSync(guardPath).ino, guardIno, "guard를 자동 제거·인수하지 않는다");
      assert.ok(existsSync(lockPath), "lock도 자동 회수하지 않는다");
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });
});

test("[M3d.2] guard 소유권: 자기 nonce·inode가 아닌 guard는 제거하지 않는다", async () => {
  // (a) nonce 불일치 — 내용이 다른 guard는 남의 것이므로 건드리지 않는다.
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfg = lockConfig(dir, { pauseDir, pauseAt: "after_guard_release" });
    const guardPath = guardPathOf(cfg);
    const p = spawn(process.execPath, [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfg, "a.json")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += String(d)));
    const exited = new Promise<number | null>((resolve) => p.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused")); // release용 guard를 막 발행한 상태
      const foreign = { v: LOCK_V, purpose: "quarantine", pid: process.pid, identity: selfIdentity(), nonce: "f".repeat(32) };
      writeGuardFile(guardPath, foreign); // 같은 inode, 다른 소유자
      writeFileSync(join(pauseDir, "resume"), "go", "utf8");

      const code = await exited;
      assert.equal(code, 1, `문제로 보고 (stderr: ${err.slice(0, 400)})`);
      assert.match(err, /transition guard 소유자 불일치 — 제거하지 않음/);
      assert.ok(existsSync(guardPath), "남의 guard를 지우지 않는다");
      assert.deepEqual(JSON.parse(readFileSync(guardPath, "utf8")), foreign, "내용도 그대로");
    } finally {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }
  });

  // (b) inode 불일치 — nonce가 같아도 파일이 교체됐으면 우리 guard가 아니다.
  //     acquire 전이에서 일어나면 guard 반납이 완결되지 않았으므로 **성공 handle을 돌려주지 않는다**
  //     (다섯 번째 리비전: exit 2 거부. 옛 구현은 경고만 찍고 probe를 성공으로 진행했다).
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfg = lockConfig(dir, { pauseDir, pauseAt: "after_guard_acquire" });
    const guardPath = guardPathOf(cfg);
    const lockPath = lockPathOf(cfg);
    const p = spawn(process.execPath, [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfg, "b.json")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let err = "";
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += String(d)));
    p.stderr.on("data", (d: Buffer) => (err += String(d)));
    const exited = new Promise<number | null>((resolve) => p.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused"));
      const original = JSON.parse(readFileSync(guardPath, "utf8")) as Record<string, unknown>;
      const swap = join(dir, "swap.json");
      writeGuardFile(swap, original); // 내용(=nonce)은 같고 inode만 다른 파일로 교체
      renameSync(swap, guardPath);
      const swappedIno = lstatSync(guardPath).ino;
      writeFileSync(join(pauseDir, "resume"), "go", "utf8");

      const code = await exited;
      assert.equal(code, 2, `전이 미완결은 거부 (stderr: ${err.slice(0, 400)})`);
      assert.match(err, /lock_guard_release_failed/, "guard 반납 실패를 mechanism 실패로 올린다");
      assert.match(err, /transition guard 신원\(inode\) 불일치 — 제거하지 않음/);
      assert.equal(out.includes('"mode":"probe"'), false, "전이가 완결되지 않았으면 성공 handle로 진행하지 않는다");
      assert.ok(existsSync(guardPath), "교체된 guard를 지우지 않는다");
      assert.equal(lstatSync(guardPath).ino, swappedIno);
      assert.ok(existsSync(lockPath), "발행된 lock은 남아 있다(fail closed — 수동 정리 대상)");

      const blocked = runLockCli(["probe"], lockConfig(dir, { guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, "남은 guard가 새 suite를 막는다");
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }
  });
});

/**
 * P1-1 회귀(다섯 번째 리비전): guard 소유 확인과 `unlink` 사이에 **다른 guard로 교체**되면
 * 그 guard를 지우지 않아야 한다. 확인은 pause 지점 **앞**에서 이미 통과했으므로, 이 테스트가 잡는 것은
 * 오직 pause 이후의 **재확인**(같은 fd로 record+inode)과 unlink 직전 최종 경로 신원 확인이다.
 * 재확인을 제거하면 두 케이스 모두 남의 guard가 사라져 실패한다.
 */
async function assertGuardUnlinkPreservesForeign(
  label: string,
  mutate: (guardPath: string, dir: string, original: Record<string, unknown>) => void,
  expectedProblem: RegExp,
): Promise<void> {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfg = lockConfig(dir, { pauseDir, pauseAt: "before_guard_unlink_release" });
    const lockPath = lockPathOf(cfg);
    const guardPath = guardPathOf(cfg);
    const holder = spawn(
      process.execPath,
      [LOCK_CLI, "hold", "200", "--fixture-config", fixtureFile(dir, cfg, "holder.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let hErr = "";
    holder.stderr.on("data", (d: Buffer) => (hErr += String(d)));
    const hExit = new Promise<number | null>((resolve) => holder.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused")); // lock unlink는 끝났고 guard 제거 직전이다
      assert.equal(existsSync(lockPath), false, `${label}: lock 자체는 이미 해제됐다`);
      const original = JSON.parse(readFileSync(guardPath, "utf8")) as Record<string, unknown>;
      mutate(guardPath, dir, original);
      const foreignText = readFileSync(guardPath, "utf8");
      const foreignIno = lstatSync(guardPath).ino;

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      const code = await hExit;
      assert.equal(code, 1, `${label}: 문제로 보고 (stderr: ${hErr.slice(0, 500)})`);
      assert.match(hErr, expectedProblem, `${label}: 재확인이 교체를 잡아낸다`);
      assert.match(hErr, /lock_guard_release_failed/, `${label}: guard 반납 실패를 mechanism 실패로 올린다`);
      assert.ok(existsSync(guardPath), `${label}: 남의 guard를 지우지 않는다`);
      assert.equal(lstatSync(guardPath).ino, foreignIno, `${label}: 같은 파일이 그대로 있다`);
      assert.equal(readFileSync(guardPath, "utf8"), foreignText, `${label}: 내용도 그대로`);

      const blocked = runLockCli(["probe"], lockConfig(dir, { guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, `${label}: 남은 guard가 다음 실행을 막는다`);
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });
}

test("[M3d.2] guard 제거 직전 재확인: 그 사이 교체된 다른 guard는 지우지 않는다(fail closed)", async () => {
  // (a) 같은 경로·같은 inode인데 **nonce가 다른** guard로 덮인 경우(다른 전이자가 이어받은 흔적).
  await assertGuardUnlinkPreservesForeign(
    "다른 nonce",
    (guardPath, _dir, original) => writeGuardFile(guardPath, { ...original, purpose: "quarantine", nonce: "c".repeat(32) }),
    /transition guard 소유자 불일치 — 제거하지 않음/,
  );
  // (b) nonce는 같지만 **파일이 교체된** 경우 — inode 재확인이 잡는다.
  await assertGuardUnlinkPreservesForeign(
    "동일 nonce·다른 inode",
    (guardPath, dir, original) => {
      const swap = join(dir, "guard-swap.json");
      writeGuardFile(swap, original);
      renameSync(swap, guardPath);
    },
    /transition guard 신원\(inode\) 불일치 — 제거하지 않음/,
  );
});

test("[M3d.2] acquire 전이의 guard 제거가 실패하면 성공 handle을 돌려주지 않는다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    const cfg = lockConfig(dir, { lockPath, pauseDir, pauseAt: "before_guard_unlink_acquire", guardWaitMs: 200 });

    const r = await pauseThen({ dir, pauseDir, args: ["probe"], config: cfg, name: "acq-guard.json", mutateDir: lockDir });
    assert.equal(r.code, 2, `전이 미완결은 거부 (stderr: ${r.stderr.slice(0, 500)})`);
    assert.match(r.stderr, /lock_guard_release_failed/, "guard 반납 실패를 삼키지 않는다");
    assert.match(r.stderr, /transition guard 제거 실패 \[EACCES\]/, "원인을 함께 보고한다");
    assert.equal(r.stdout.includes('"mode":"probe"'), false, "acquire가 완결되지 않았으면 suite 실행을 시작하지 않는다");
    assert.ok(existsSync(lockPath), "발행된 lock은 남는다(fail closed — 수동 정리 대상)");
    assert.ok(existsSync(guardPath), "제거하지 못한 guard가 남는다");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "남은 guard가 새 suite를 막는다");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    rmSync(guardPath, { force: true });
    rmSync(lockPath, { force: true });
  });
});

test("[M3d.2] reentry 전이의 guard 제거가 실패하면 재진입을 성공으로 보지 않는다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    const token = "5a".repeat(32);
    const planted = ownedLockRecord(token);
    writeLockFile(lockPath, planted); // 상위 suite가 보유 중인 lock(우리 token과 짝이 맞는다)
    const beforeIno = lstatSync(lockPath).ino;
    const cfg = lockConfig(dir, { lockPath, pauseDir, pauseAt: "before_guard_unlink_reentry", guardWaitMs: 200 });

    const r = await pauseThen({
      dir,
      pauseDir,
      args: ["probe"],
      config: cfg,
      name: "reentry-guard.json",
      mutateDir: lockDir,
      env: isolatedEnv({ HARNESS_SUITE_LOCK_TOKEN: token }),
    });
    assert.equal(r.code, 2, `재진입 전이 미완결은 거부 (stderr: ${r.stderr.slice(0, 500)})`);
    assert.match(r.stderr, /lock_guard_release_failed/);
    assert.match(r.stderr, /transition guard 제거 실패 \[EACCES\]/);
    assert.equal(r.stdout.includes('"reentered":true'), false, "재진입 handle로 진행하지 않는다");
    assert.deepEqual(readLockRecord(lockPath), planted, "상위 lock을 건드리지 않는다");
    assert.equal(lstatSync(lockPath).ino, beforeIno, "같은 파일이 그대로 있다");
    assert.ok(existsSync(guardPath), "제거하지 못한 guard가 남는다");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "남은 guard가 새 실행을 막는다");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    rmSync(guardPath, { force: true });
    rmSync(lockPath, { force: true });
  });
});

test("[M3d.2] 발행 후 임시 파일 정리 실패도 성공 handle이 되지 않는다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    // link까지 끝난 뒤(=발행 성공) 임시 파일 정리 직전에서 멈추고, 그때 디렉터리를 쓸 수 없게 만든다.
    const cfg = lockConfig(dir, { lockPath, pauseDir, pauseAt: "before_publish_tmp_cleanup", guardWaitMs: 200 });

    const r = await pauseThen({ dir, pauseDir, args: ["probe"], config: cfg, name: "tmp-cleanup.json", mutateDir: lockDir });
    assert.equal(r.code, 2, `정리 실패는 거부 (stderr: ${r.stderr.slice(0, 500)})`);
    assert.match(r.stderr, /lock_publish_cleanup_failed/, "임시 파일 정리 실패를 삼키지 않는다");
    assert.match(r.stderr, /임시 파일 정리 실패 \[EACCES\]/);
    assert.equal(r.stdout.includes('"mode":"probe"'), false, "정리가 끝나지 않았으면 suite 실행을 시작하지 않는다");
    assert.ok(existsSync(lockPath), "발행된 lock은 남는다(fail closed)");
    assert.ok(existsSync(guardPath), "guard도 남아 다음 실행을 막는다");
    const leftovers = readdirSync(lockDir).filter((n) => n.startsWith("suite.lock.new."));
    assert.equal(leftovers.length, 1, "지우지 못한 임시 파일은 보고만 하고 남긴다(조용히 사라지지 않는다)");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "남은 guard가 새 suite를 막는다");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    rmSync(lockDir, { recursive: true, force: true });
  });
});

/**
 * P1-2 회귀(다섯 번째 리비전): 격리는 "temp write → close → **원본 재확인** → rename" 순서여야 한다.
 * 마지막 확인이 temp write 앞에만 있으면, 그 사이 교체된 외부 lock을 rename이 덮어쓴다.
 * 아래는 temp가 완성된 **뒤**(rename 직전)에 경로를 교체하고, 그 파일이 살아남는지 본다.
 */
async function assertQuarantineRenamePreservesForeign(
  label: string,
  makeForeign: (dir: string, original: Record<string, unknown>) => Record<string, unknown>,
  expectedProblem: RegExp,
): Promise<void> {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const token = "7b".repeat(32);
    const lockPath = join(dir, "suite.lock");
    writeLockFile(lockPath, ownedLockRecord(token));
    const cfg = lockConfig(dir, {
      lockPath,
      acquireToken: token,
      pauseDir,
      pauseAt: "before_quarantine_rename",
      guardWaitMs: 200,
    });
    const guardPath = guardPathOf(cfg);
    const child = spawn(
      process.execPath,
      [LOCK_CLI, "quarantine", "cleanup_unconfirmed", "--fixture-config", fixtureFile(dir, cfg, "q.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused"), 30_000); // 격리 임시 파일 완성 + rename 직전
      const foreign = makeForeign(dir, readLockRecord(lockPath));
      const swap = join(dir, "foreign.json");
      writeLockFile(swap, foreign);
      renameSync(swap, lockPath); // 계약 밖 행위자가 경로를 다른 파일로 교체
      const foreignIno = lstatSync(lockPath).ino;

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      const code = await exited;
      assert.equal(code, 1, `${label}: 격리 실패로 보고 (stdout: ${stdout.slice(0, 500)})`);
      assert.match(stdout, expectedProblem, `${label}: rename 직전 재확인이 교체를 잡아낸다`);
      assert.deepEqual(readLockRecord(lockPath), foreign, `${label}: 교체된 lock을 덮지 않는다`);
      assert.equal(lstatSync(lockPath).ino, foreignIno, `${label}: 같은 파일이 그대로 있다`);
      assert.ok(existsSync(guardPath), `${label}: 격리 실패는 guard를 남긴다(fail closed)`);
      assertNoLockResidue(dir, { allowGuard: true }); // 격리 임시 파일은 신원 확인 후 정리됐다

      const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, `${label}: 남은 guard가 새 suite를 막는다`);
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
}

test("[M3d.2] 격리 rename 직전에 교체된 외부 lock은 덮지 않는다(fail closed)", async () => {
  // (a) 같은 token이지만 **다른 소유자(pid)** record로 교체 — 기본 record 재확인이 잡는다.
  await assertQuarantineRenamePreservesForeign(
    "다른 소유자",
    (_dir, original) => ({ ...original, pid: deadPid() }),
    /lock record가 격리 rename 직전에 우리가 아는 내용과 달라짐/,
  );
  // (b) 내용은 같고 **파일만 교체** — inode 재확인이 잡는다.
  await assertQuarantineRenamePreservesForeign(
    "동일 내용·다른 inode",
    (_dir, original) => original,
    /lock 신원\(inode\)이 격리 rename 직전에 달라짐/,
  );
});

test("[M3d.2] token 격리는 재진입 시점 기준을 요구한다 — 같은 tokenHash 외부 교체 lock을 보존한다", async () => {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const token = "9c".repeat(32);
    const lockPath = join(dir, "suite.lock");
    writeLockFile(lockPath, ownedLockRecord(token)); // 재진입 대상 = 우리 token과 짝이 맞는 상위 lock
    // 재진입은 pause 없이 끝나고, 격리 guard를 잡은 직후에 멈춘다 → 그 사이 lock을 교체한다.
    const cfg = lockConfig(dir, {
      lockPath,
      acquireToken: token,
      pauseDir,
      pauseAt: "after_guard_quarantine",
      guardWaitMs: 200,
    });
    const guardPath = guardPathOf(cfg);
    const child = spawn(
      process.execPath,
      [LOCK_CLI, "quarantine", "cleanup_unconfirmed", "--fixture-config", fixtureFile(dir, cfg, "q.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused"), 30_000);
      // tokenHash는 그대로지만 pid·identity가 다른 **남의 lock**으로 교체된 상황.
      const foreign = { ...ownedLockRecord(token), kind: "suite", pid: deadPid() };
      const swap = join(dir, "foreign.json");
      writeLockFile(swap, foreign);
      renameSync(swap, lockPath);
      const foreignIno = lstatSync(lockPath).ino;

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      const code = await exited;
      assert.equal(code, 1, `격리하지 않고 실패로 보고 (stdout: ${stdout.slice(0, 500)})`);
      assert.match(stdout, /lock record가 재진입 시점과 다름/, "tokenHash만으로 소유권을 인정하지 않는다");
      assert.deepEqual(readLockRecord(lockPath), foreign, "남의 lock에 격리 표시를 쓰지 않는다");
      assert.equal(readLockRecord(lockPath).quarantined, undefined, "격리 표시가 기록되지 않았다");
      assert.equal(lstatSync(lockPath).ino, foreignIno, "같은 파일이 그대로 있다");
      assert.ok(existsSync(guardPath), "기준 불일치는 guard를 남긴다(fail closed)");
      assertNoLockResidue(dir, { allowGuard: true });

      const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, "남은 guard가 새 suite를 막는다");
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

test("[M3d.2] 격리된 lock은 소유자가 죽어도 회수 대상이 아니고 재진입도 거부한다", () => {
  withTemp((dir) => {
    const cfg = lockConfig(dir);
    const lockPath = lockPathOf(cfg);
    writeLockFile(lockPath, {
      v: LOCK_V,
      kind: "stress",
      pid: deadPid(), // 소유자는 이미 죽었다 — 그래도 회수하지 않는다
      identity: selfIdentity(),
      tokenHash: "0".repeat(64),
      quarantined: true,
      quarantineReason: "cleanup_unconfirmed",
    });
    const ino = lstatSync(lockPath).ino;
    const r = runLockCli(["probe"], cfg, dir, "a.json");
    assert.equal(r.status, 2, `격리 lock은 거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stderr), /lock_quarantined/);
    assert.equal(lstatSync(lockPath).ino, ino, "격리 lock을 회수하지 않는다");
    // 재진입 token이 있어도 격리된 lock에는 들어갈 수 없다.
    const re = spawnSync(process.execPath, [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfg, "re.json")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: isolatedEnv({ HARNESS_SUITE_LOCK_TOKEN: "e".repeat(64) }),
    });
    assert.equal(re.status, 2);
    assert.match(String(re.stderr), /reentry_lock_quarantined/);
    assert.ok(existsSync(lockPath));
    assertNoLockResidue(dir);
  });
});

/**
 * P1-1/P1-2 회귀: **guard를 쥔 뒤** 실패한 전이 메커니즘은 예외 없이 guard를 남겨야 한다.
 * 세 지점(lock 발행 / lock unlink / guard unlink) 모두 실제 syscall 실패로 재현한다 —
 * 주입은 기존 argv fixture의 고정 pause enum뿐이고, 실패 자체는 디렉터리 권한으로 만든다.
 */
test("[M3d.2] guard 취득 뒤 lock 발행이 실패하면 lock을 만들지 않고 guard를 남긴다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    const cfg = lockConfig(dir, { lockPath, pauseDir, pauseAt: "before_publish", guardWaitMs: 200 });
    const guardPath = `${lockPath}.guard`;

    const r = await pauseThen({ dir, pauseDir, args: ["probe"], config: cfg, name: "publish-fail.json", mutateDir: lockDir });
    assert.equal(r.code, 2, `발행 실패는 거부 (stderr: ${r.stderr.slice(0, 400)})`);
    assert.match(r.stderr, /lock_create_failed/, "임시 파일 생성 실패를 보고");
    assert.equal(existsSync(lockPath), false, "lock 파일을 만들지 않았다");
    assert.ok(existsSync(guardPath), "guard 취득 뒤의 I/O 실패는 guard를 남긴다(fail closed)");
    assert.deepEqual(readdirSync(lockDir), ["suite.lock.guard"], "임시 잔재 없음(guard만 남는다)");

    // 남은 guard 때문에 다음 suite·stress는 시작할 수 없다.
    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "guard가 남아 있으면 새 suite 거부");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    rmSync(guardPath, { force: true });
  });
});

/**
 * 위 테스트는 "쓸 수 없는 디렉터리"로 실패를 만들기 때문에 guard 제거도 함께 막힌다.
 * 그래서 **디렉터리는 그대로 쓸 수 있는 상태**에서 발행만 충돌시키는 경우를 따로 고정한다:
 * 이 경우 guard를 남기는 것은 오직 **실패 분류(mechanism)** 때문이다(계약상 거부로 분류하면 반납된다).
 */
test("[M3d.2] guard를 쥔 채 계약 밖 writer와 발행 충돌이 나면 분류상 guard를 남긴다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const cfg = lockConfig(dir, { pauseDir, pauseAt: "before_publish", guardWaitMs: 200 });
    const lockPath = lockPathOf(cfg);
    const guardPath = guardPathOf(cfg);
    const child = spawn(process.execPath, [LOCK_CLI, "probe", "--fixture-config", fixtureFile(dir, cfg, "conflict.json")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused"), 30_000);
      assert.ok(existsSync(guardPath), "guard 보유 중");
      // 계약 밖 writer가 guard를 무시하고 최종 경로를 먼저 만든 상황(link → EEXIST).
      const planted = { v: LOCK_V, kind: "suite", pid: process.pid, identity: selfIdentity(), tokenHash: "7".repeat(64) };
      writeLockFile(lockPath, planted);
      writeFileSync(join(pauseDir, "resume"), "go", "utf8");

      const code = await exited;
      assert.equal(code, 2, `발행 충돌은 거부 (stderr: ${stderr.slice(0, 400)})`);
      assert.match(stderr, /lock_publish_conflict/);
      assert.deepEqual(readLockRecord(lockPath), planted, "남의 파일을 지우거나 덮지 않는다");
      assert.ok(existsSync(guardPath), "발행 충돌은 mechanism 실패이므로 guard를 남긴다(fail closed)");
      assertNoLockResidue(dir, { allowGuard: true });

      const blocked = runLockCli(["probe"], lockConfig(dir, { guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, "남은 guard가 새 suite를 막는다");
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

test("[M3d.2] lock unlink syscall이 실패하면 해제로 보지 않고 guard를 남긴다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    const cfg = lockConfig(dir, { lockPath, pauseDir, pauseAt: "before_unlink", guardWaitMs: 200 });
    const guardPath = `${lockPath}.guard`;

    const r = await pauseThen({ dir, pauseDir, args: ["hold", "200"], config: cfg, name: "unlink-fail.json", mutateDir: lockDir });
    assert.equal(r.code, 1, `해제 실패는 실패로 보고 (stderr: ${r.stderr.slice(0, 500)})`);
    assert.match(r.stderr, /lock 해제 실패 \[EACCES\]/, "unlink 실패를 조용히 넘기지 않는다");
    assert.ok(existsSync(lockPath), "지우지 못한 lock은 그대로 남는다");
    assert.ok(existsSync(guardPath), "unlink 실패는 guard를 남긴다(fail closed)");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "guard가 남아 있으면 새 suite 거부");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    rmSync(guardPath, { force: true });
    rmSync(lockPath, { force: true });
  });
});

test("[M3d.2] guard 제거(unlink) 실패도 조용히 넘기지 않고 guard를 남긴다(fail closed)", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    // lock unlink는 성공한 **뒤** guard 제거만 실패하는 지점에서 멈춘다.
    const cfg = lockConfig(dir, { lockPath, pauseDir, pauseAt: "before_guard_unlink_release", guardWaitMs: 200 });
    const guardPath = `${lockPath}.guard`;

    const r = await pauseThen({ dir, pauseDir, args: ["hold", "200"], config: cfg, name: "guard-unlink-fail.json", mutateDir: lockDir });
    assert.equal(r.code, 1, `guard 제거 실패도 실패로 보고 (stderr: ${r.stderr.slice(0, 500)})`);
    assert.match(r.stderr, /transition guard 제거 실패 \[EACCES\]/, "guard 제거 실패를 보고한다");
    assert.match(r.stderr, /lock_guard_release_failed/, "guard 반납 실패를 mechanism 실패로 올린다");
    // 여섯 번째 리비전 P2: lock unlink 뒤에 실패했더라도 wrapper는 **해제로 보고하지 않는다**.
    assert.match(
      r.stderr,
      /lock 해제가 완결되지 않았습니다\(state=failed\)/,
      "consumer(wrapper)가 released로 보고하지 않는다",
    );
    assert.equal(existsSync(lockPath), false, "lock 파일 unlink 자체는 성공했다(실패 지점은 그 뒤다)");
    assert.ok(existsSync(guardPath), "제거하지 못한 guard가 남아 이후 전이를 막는다(fail closed)");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "남은 guard는 새 suite를 막는다");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    rmSync(guardPath, { force: true });
  });
});

/**
 * P1 회귀(여섯 번째 리비전): lock·guard 읽기가 **최종 경로의 symlink를 따라가면** 신원 검사 대상과
 * 파괴적 조작 대상이 서로 달라진다. "원본을 옮기고 그 자리에 symlink"를 심으면 예전 구현은
 * ⑴ release에서 원본 record·inode를 확인하고 **symlink만 unlink**한 뒤 해제 성공을 보고했고,
 * ⑵ quarantine에서 남의 symlink 엔트리를 **rename으로 덮었다**. 두 경우 모두 계약(우리가 신원을 확인한
 * 그 파일만 지운다 / 교체된 남의 파일은 보존한다)을 위반한다.
 */
test("[M3d.2] 최종 경로 symlink: release는 symlink 엔트리와 대상 원본을 모두 보존하고 해제로 보고하지 않는다", async () => {
  const lib = await importLockLib();
  await withTempAsync(async (dir) => {
    const lockPath = join(dir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    const lock = lib.acquireSuiteLock({ kind: "suite", lockPath, skipDetection: true, guardWaitMs: 200 });
    const originalIno = lstatSync(lockPath).ino;
    const originalText = readFileSync(lockPath, "utf8");
    // 계약 밖 행위자: 우리 lock 파일을 **그대로 옮기고**(inode·내용 유지) 그 자리에 symlink를 둔다.
    const moved = join(dir, "moved-original.lock");
    renameSync(lockPath, moved);
    symlinkSync(moved, lockPath);

    const problems = lock.release();
    assert.equal(lock.state, "failed", `symlink 엔트리는 우리 lock으로 인정하지 않는다 (problems: ${problems.join(" / ")})`);
    assert.equal(lock.released, false, "consumer가 해제로 볼 수 없다");
    assert.match(problems.join("\n"), /lock_path_symlink/, "symlink 거부를 코드로 보고한다");
    assert.ok(lstatSync(lockPath).isSymbolicLink(), "symlink 엔트리를 지우지 않는다");
    assert.equal(lstatSync(moved).ino, originalIno, "대상 원본 파일이 그대로 있다");
    assert.equal(readFileSync(moved, "utf8"), originalText, "대상 내용도 그대로");
    assert.ok(existsSync(guardPath), "전이 실패는 guard를 남긴다(fail closed)");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "남은 guard가 다음 실행을 막는다");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
  });
});

test("[M3d.2] 최종 경로 symlink: token 격리는 symlink 엔트리를 덮지 않고 대상 원본도 바꾸지 않는다", async () => {
  const lib = await importLockLib();
  await withTempAsync(async (dir) => {
    const token = "3d".repeat(16);
    const lockPath = join(dir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    writeLockFile(lockPath, ownedLockRecord(token));
    // production과 같은 순서: 먼저 재진입해 신뢰 기준(base)을 확보한다.
    const re = lib.tryReenterSuiteLock({ lockPath, token, guardWaitMs: 200 });
    assert.ok(re?.base, "재진입 기준 확보");
    const originalIno = lstatSync(lockPath).ino;
    const originalText = readFileSync(lockPath, "utf8");
    const moved = join(dir, "moved-original.lock");
    renameSync(lockPath, moved);
    symlinkSync(moved, lockPath);

    const problems = lib.quarantineByToken({
      lockPath,
      token,
      expected: re?.base,
      reason: "cleanup_unconfirmed",
      guardWaitMs: 200,
    });
    assert.ok(problems.length > 0, `격리하지 못했다고 보고한다 (problems: ${problems.join(" / ")})`);
    assert.match(problems.join("\n"), /lock_path_symlink/);
    assert.ok(lstatSync(lockPath).isSymbolicLink(), "남의 symlink 엔트리를 rename으로 덮지 않는다");
    assert.equal(lstatSync(moved).ino, originalIno, "대상 원본 파일이 그대로 있다");
    assert.equal(readFileSync(moved, "utf8"), originalText, "대상에 격리 표시를 하지 않았다");
    assert.ok(existsSync(guardPath), "격리 실패는 guard를 남긴다(fail closed)");
    assertNoLockResidue(dir, { allowGuard: true }); // 격리 임시 파일은 신원 확인 후 정리됐다
  });
});

test("[M3d.2] 최종 경로 symlink: acquire도 symlink lock 경로를 신원으로 인정하지 않고 거부한다", () => {
  withTemp((dir) => {
    const cfg = lockConfig(dir);
    const lockPath = lockPathOf(cfg);
    const target = join(dir, "planted.lock");
    writeLockFile(target, ownedLockRecord("aa".repeat(16))); // 내용은 유효한 live lock record다
    symlinkSync(target, lockPath);
    const r = runLockCli(["probe"], cfg, dir, "symlink-acq.json");
    assert.equal(r.status, 2, `symlink lock 경로는 거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stderr), /lock_path_symlink/, "symlink를 따라가 record를 해석하지 않는다");
    assert.ok(lstatSync(lockPath).isSymbolicLink(), "symlink 엔트리를 지우지 않는다");
    assert.ok(existsSync(target), "대상 파일도 지우지 않는다");
    assert.equal(existsSync(guardPathOf(cfg)), false, "상태를 바꾸지 않은 거부는 guard를 정상 반납한다");

    // 계약 고정: lock 라이브러리의 읽기 open은 O_NOFOLLOW 경로뿐이다(따라가는 읽기 open 재도입 금지).
    const libSrc = stripComments(readFileSync(LOCK_LIB, "utf8"));
    assert.match(libSrc, /O_NOFOLLOW/, "읽기 open은 O_NOFOLLOW를 쓴다");
    assert.equal(/openSync\([^)\n]*,\s*"r"\s*\)/.test(libSrc), false, "symlink를 따라가는 읽기 open이 없다");
  });
});

/**
 * P2 회귀(여섯 번째 리비전): lock unlink는 성공했지만 **guard 반납이 실패**하면 전이는 완결되지 않았다.
 * 예전 구현은 전이 콜백 안에서 `state="released"`를 먼저 세팅했기 때문에, 그 뒤 guard 반납이 실패해
 * `lock_guard_release_failed`가 나도 handle은 released로 남고 소비자가 `lockReleased:true`로 보고했다.
 * 여기서는 guard 파일을 **같은 내용·다른 inode**로 교체해 lock unlink **이후** 지점에서만 실패시킨다.
 */
test("[M3d.2] lock unlink 뒤 guard 반납 실패는 released가 아니라 failed다(완결 규칙)", async () => {
  const lib = await importLockLib();
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(dir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    // guard는 전이 중에만 존재하므로 교체도 전이 중에 해야 한다. release가 guard 제거 직전
    // (= lock unlink **이후**)에서 멈춘 사이, 별도 프로세스가 guard를 같은 내용·**다른 inode**로 바꾼다.
    const swapInfo = join(dir, "swap-info.json");
    const mutatorSrc = [
      'const fs = require("node:fs");',
      `const guard = ${JSON.stringify(guardPath)};`,
      `const pausedFile = ${JSON.stringify(join(pauseDir, "paused"))};`,
      `const resumeFile = ${JSON.stringify(join(pauseDir, "resume"))};`,
      `const swap = ${JSON.stringify(join(dir, "guard-swap.json"))};`,
      `const out = ${JSON.stringify(swapInfo)};`,
      "const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
      "const end = Date.now() + 30000;",
      "while (Date.now() < end && !fs.existsSync(pausedFile)) wait(20);",
      "if (!fs.existsSync(pausedFile)) { fs.writeFileSync(out, JSON.stringify({ ok: false })); process.exit(1); }",
      "const beforeIno = fs.lstatSync(guard).ino;",
      'const text = fs.readFileSync(guard, "utf8");',
      "fs.writeFileSync(swap, text, { mode: 0o600 });",
      "fs.renameSync(swap, guard);",
      "const afterIno = fs.lstatSync(guard).ino;",
      "fs.writeFileSync(out, JSON.stringify({ ok: true, beforeIno, afterIno, text }));",
      'fs.writeFileSync(resumeFile, "go");',
    ].join("\n");

    const lock = lib.acquireSuiteLock({
      kind: "suite",
      lockPath,
      skipDetection: true,
      guardWaitMs: 200,
      pause: { dir: pauseDir, at: "before_guard_unlink_release" },
    });
    const mutator = spawn(process.execPath, ["-e", mutatorSrc], { stdio: "ignore" });
    const mutatorExit = new Promise<number | null>((resolve) => mutator.on("close", (c: number | null) => resolve(c)));

    const problems = lock.release(); // guard 제거 직전에서 멈췄다가 교체된 guard를 만난다
    assert.equal(await mutatorExit, 0, "교체 프로세스가 정상 종료");
    const swapped = JSON.parse(readFileSync(swapInfo, "utf8")) as { ok: boolean; beforeIno: number; afterIno: number; text: string };
    assert.equal(swapped.ok, true, "pause 지점에서 실제로 교체했다");
    assert.notEqual(swapped.beforeIno, swapped.afterIno, "inode가 실제로 바뀌었다");
    const foreignIno = swapped.afterIno;
    const foreignText = swapped.text;

    assert.equal(existsSync(lockPath), false, "lock 파일 unlink는 이미 성공했다(실패 지점은 그 뒤다)");
    assert.equal(lock.state, "failed", `guard 반납 실패는 released가 아니다 (problems: ${problems.join(" / ")})`);
    assert.equal(lock.released, false, "consumer가 lockReleased=true로 볼 수 없다");
    assert.equal(lock.quarantined, false, "격리도 아니다");
    assert.match(problems.join("\n"), /transition guard 신원\(inode\) 불일치 — 제거하지 않음/);
    assert.match(problems.join("\n"), /lock_guard_release_failed/, "guard 반납 실패를 mechanism 실패로 올린다");
    assert.ok(existsSync(guardPath), "남의 guard를 지우지 않는다");
    assert.equal(lstatSync(guardPath).ino, foreignIno, "같은 파일이 그대로 있다");
    assert.equal(readFileSync(guardPath, "utf8"), foreignText, "내용도 그대로");
    assert.deepEqual(lock.release(), [], "failed 상태에서 재시도하지 않는다");
    assert.equal(lock.state, "failed", "이후에도 released로 승격되지 않는다");

    const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
    assert.equal(blocked.status, 2, "남은 guard가 다음 실행을 막는다");
    assert.match(String(blocked.stderr), /lock_transition_guard_present/);
  });
});

test("[M3d.2] 같은 token만으로는 외부 교체를 격리로 인정하지 않는다(기본 record 보존 요구)", async () => {
  await withTempAsync(async (dir) => {
    const pauseDir = join(dir, "pause");
    mkdirSync(pauseDir, { recursive: true });
    const token = "ab".repeat(16);
    const cfg = lockConfig(dir, { acquireToken: token, pauseDir, pauseAt: "before_unlink" });
    const lockPath = lockPathOf(cfg);
    const holder = spawn(
      process.execPath,
      [LOCK_CLI, "hold", "200", "--fixture-config", fixtureFile(dir, cfg, "holder.json")],
      { cwd: REPO_ROOT, stdio: "pipe", env: isolatedEnv() },
    );
    let hErr = "";
    holder.stderr.on("data", (d: Buffer) => (hErr += String(d)));
    const hExit = new Promise<number | null>((resolve) => holder.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForFile(join(pauseDir, "paused"));
      // tokenHash는 그대로지만 **다른 소유자(pid)** record를 격리 표시와 함께 심는다.
      const original = readLockRecord(lockPath);
      const planted = { ...original, pid: deadPid(), quarantined: true, quarantineReason: "cleanup_unconfirmed" };
      const swap = join(dir, "planted.json");
      writeLockFile(swap, planted);
      renameSync(swap, lockPath);

      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      const code = await hExit;
      assert.equal(code, 1, `교체를 감지해 실패로 보고 (stderr: ${hErr.slice(0, 500)})`);
      assert.match(hErr, /lock record가 우리가 발행한 내용과 다름/, "token만 같은 격리 record를 인정하지 않는다");
      assert.deepEqual(readLockRecord(lockPath), planted, "심어진 파일을 지우거나 덮지 않는다");
      assert.ok(existsSync(guardPathOf(cfg)), "계약 밖 교체 감지는 guard를 남긴다(fail closed)");

      const blocked = runLockCli(["probe"], lockConfig(dir, { guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, "새 suite는 시작하지 못한다");
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    }
  });
});

test("[M3d.2] lock 기록 실패는 최종 경로에 부분 기록을 남기지 않는다", () => {
  withTemp((dir) => {
    const roDir = join(dir, "readonly");
    mkdirSync(roDir, { recursive: true });
    const cfg = lockConfig(dir, { lockPath: join(roDir, "suite.lock") });
    chmodSync(roDir, 0o555); // 임시 파일조차 만들 수 없다
    try {
      const r = runLockCli(["probe"], cfg, dir);
      assert.equal(r.status, 2, `기록 실패는 거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
      assert.match(String(r.stderr), /lock_create_failed/);
      assert.deepEqual(readdirSync(roDir), [], "최종 경로·임시 파일·guard 모두 남지 않는다");
    } finally {
      chmodSync(roDir, 0o755);
    }
  });
});

// ── 8) stress runner: 부하 조건 없이는 PASS하지 않는다 ───────────────────────

test("[M3d.2] stress: 부하 deadline이 npm test 상한보다 크지 않으면 거부(exit 2)", () => {
  withTemp((dir) => {
    for (const [deadline, timeout] of [
      [60_000, 60_000],
      [30_000, 60_000],
    ]) {
      const cfg = stressConfig(dir, { deadlineMs: deadline, testTimeoutMs: timeout });
      const r = runStress(cfg, dir, 60_000);
      assert.equal(r.status, 2, `거부해야 함: deadline=${deadline} timeout=${timeout}`);
      assert.match(String(r.stderr), /부하 deadline/);
      assert.equal(existsSync(lockPathOf(cfg)), false, "거부 시 lock을 잡지 않는다");
      assertNoLockResidue(dir);
    }
  });
});

test("[M3d.2] stress: 정상 경로는 PASS하고 소유 프로세스·lock을 남기지 않는다", async () => {
  await withTempAsync(async (dir) => {
    const cfg = stressConfig(dir, { suiteMode: "noop_pass" });
    const r = runStress(cfg, dir);
    assert.equal(r.status, 0, `PASS (stderr: ${String(r.stderr).slice(0, 400)})`);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.loadWorkers, 1);
    assert.equal(s.workersSpawned, 1, "설정된 worker 전부 spawn");
    assert.equal(s.workersExitedBeforeCleanup, 0, "정리 전 worker 종료 없음");
    assert.equal(s.workersAliveAtSuiteClose, 1, "npm test 종료 시점까지 worker 생존");
    assert.equal(s.npmTestExitCode, 0);
    assert.equal(s.cleanupConfirmed, true, "정리 확인 완료");
    assert.equal(s.cleanupProblems, 0);
    assert.equal(s.lockReleased, true, "확인 후 lock 해제");
    assert.equal(s.lockQuarantined, false);
    assert.equal(s.shutdownReason, "normal");
    await assertPidFilesDead(dir, ["worker-0.pid"]);
    assert.equal(existsSync(lockPathOf(cfg)), false, "lock 파일 없음");
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] stress: worker spawn 실패는 FAIL (부하 없는 PASS 금지)", async () => {
  await withTempAsync(async (dir) => {
    const cfg = stressConfig(dir, { inject: "worker_spawn_failure", suiteMode: "noop_pass" });
    const r = runStress(cfg, dir);
    assert.equal(r.status, 1, `FAIL (stdout tail: ${String(r.stdout).slice(-300)})`);
    assert.match(String(r.stderr), /부하 worker 1\/1건 spawn 실패/);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.workersSpawned, 0);
    assert.equal(s.npmTestExitCode, null, "부하가 없으면 npm test를 아예 실행하지 않는다");
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.lockReleased, true);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] stress: worker가 정리 전에 종료되면 FAIL (부하 지속 요구)", async () => {
  await withTempAsync(async (dir) => {
    const cfg = stressConfig(dir, {
      inject: "worker_early_exit",
      suiteMode: "sleep_descendant",
      suiteSleepMs: 3_000,
    });
    const r = runStress(cfg, dir);
    assert.equal(r.status, 1, `FAIL (stderr: ${String(r.stderr).slice(0, 400)})`);
    assert.match(String(r.stderr), /정리 전에 종료/);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.workersSpawned, 1, "spawn 자체는 성공");
    assert.equal(s.workersExitedBeforeCleanup, 1, "조기 종료 감지");
    assert.equal(s.npmTestExitCode, 0, "suite 자체는 정상 종료했어도 FAIL이다");
    assert.equal(s.cleanupConfirmed, true);
    await assertPidFilesDead(dir, ["worker-0.pid", "suite.pid", "descendant.pid"]);
  });
});

test("[M3d.2] stress: suite spawn 실패 / 비정상 exit는 FAIL", async () => {
  await withTempAsync(async (dir) => {
    const spawnFail = runStress(stressConfig(dir, { suiteMode: "spawn_failure" }), dir);
    assert.equal(spawnFail.status, 1);
    assert.match(String(spawnFail.stderr), /npm test 실행 실패/);
    assert.equal(stressSummary(String(spawnFail.stdout)).cleanupConfirmed, true);
  });
  await withTempAsync(async (dir) => {
    const nonzero = runStress(stressConfig(dir, { suiteMode: "noop_fail" }), dir);
    assert.equal(nonzero.status, 1);
    const s = stressSummary(String(nonzero.stdout));
    assert.equal(s.npmTestExitCode, 3);
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.lockReleased, true);
  });
});

test("[M3d.2] stress: wall-clock 상한 초과는 FAIL이고 소유 그룹 자손까지 정리된다", async () => {
  await withTempAsync(async (dir) => {
    const cfg = stressConfig(dir, {
      testTimeoutMs: 1_500,
      deadlineMs: 60_000,
      suiteMode: "sleep_descendant",
      suiteSleepMs: 60_000,
    });
    const r = runStress(cfg, dir);
    assert.equal(r.status, 1, `timeout은 FAIL (stderr: ${String(r.stderr).slice(0, 400)})`);
    assert.match(String(r.stderr), /wall-clock 상한/);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.npmTestTimedOut, true);
    assert.equal(s.ownedDescendantsAfterCleanup, 0, "소유 프로세스 그룹 자손 0");
    assert.equal(s.npmGroupAliveAfterCleanup, false);
    assert.equal(s.workersAliveAfterCleanup, 0);
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.lockReleased, true);
    await assertPidFilesDead(dir, ["worker-0.pid", "suite.pid", "descendant.pid"]);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

for (const [sig, expected] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as Array<[NodeJS.Signals, number]>) {
  test(`[M3d.2] stress: ${sig} 경로도 같은 shutdown 기계로 정리·확인 후 종료(exit ${expected})`, async () => {
    await withTempAsync(async (dir) => {
      const cfg = stressConfig(dir, { suiteMode: "sleep_descendant", suiteSleepMs: 60_000 });
      const child = spawn(process.execPath, [STRESS, "--fixture-config", fixtureFile(dir, cfg)], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        env: isolatedEnv(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
      child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
      });
      try {
        await waitForPidFile(join(dir, "descendant.pid")); // 부하·suite·자손이 모두 뜬 뒤에 시그널
        await waitForPidFile(join(dir, "worker-0.pid"));
        child.kill(sig);
        const r = await exited;
        assert.equal(r.signal, null, `시그널 핸들러가 직접 종료 (stderr: ${stderr.slice(0, 300)})`);
        assert.equal(r.code, expected, `exit ${expected}`);
        assert.match(stderr, new RegExp(`${sig} 수신 — 소유 프로세스 정리 확인 후 종료`));
        assert.equal(stdout.includes("[m3d2-stress] 요약: "), false, "시그널 경로는 요약 대신 정리 보고로 끝난다");
        await assertPidFilesDead(dir, ["worker-0.pid", "suite.pid", "descendant.pid"]);
        assert.equal(existsSync(lockPathOf(cfg)), false, "확인 후 lock 해제");
        assertNoLockResidue(dir);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    });
  });
}

test("[M3d.2] stress: 이미 lock을 보유한 suite 안에서는 중첩 실행을 거부한다", () => {
  withTemp((dir) => {
    const r = spawnSync(process.execPath, [STRESS, "--fixture-config", fixtureFile(dir, stressConfig(dir, { suiteMode: "noop_pass" }))], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: isolatedEnv({ HARNESS_SUITE_LOCK_TOKEN: "f".repeat(64) }), // 상위 suite가 lock을 보유한 상황
    });
    assert.equal(r.status, 2);
    assert.match(String(r.stderr), /중첩 실행하지 않습니다/);
  });
});

test("[M3d.2] stress: 자기 소유 suite child만 ownership token으로 lock에 재진입한다", async () => {
  await withTempAsync(async (dir) => {
    // suite child로 lock wrapper를 실행한다 → 재진입에 성공해야 deadlock 없이 PASS한다.
    const cfg = stressConfig(dir, { suiteMode: "lock_probe" });
    const r = runStress(cfg, dir);
    assert.equal(r.status, 0, `재진입 PASS (stderr: ${String(r.stderr).slice(0, 400)})`);
    assert.match(String(r.stdout), /"reentered":true/, "child가 재진입으로 실행됨");
    const s = stressSummary(String(r.stdout));
    assert.equal(s.npmTestExitCode, 0);
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.lockReleased, true);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] stress: 정리 확인 실패 시 lock을 해제하지 않고 격리한다(다른 suite 획득 불가·무관 프로세스 무사)", async () => {
  await withTempAsync(async (dir) => {
    const bystander = spawnBystander();
    try {
      const cfg = stressConfig(dir, {
        inject: "cleanup_confirm_failure",
        suiteMode: "noop_pass",
        confirmMs: 600,
      });
      const lockPath = lockPathOf(cfg);
      const r = runStress(cfg, dir);
      assert.equal(r.status, 1, `정리 확인 실패는 FAIL (stderr: ${String(r.stderr).slice(0, 400)})`);
      const s = stressSummary(String(r.stdout));
      assert.equal(s.cleanupConfirmed, false, "정리 확인 실패");
      assert.equal(s.lockReleased, false, "확인 못 했으면 해제하지 않는다");
      assert.equal(s.lockQuarantined, true, "해제 대신 격리한다");
      assert.ok(Number(s.cleanupProblems) > 0, "정리 문제를 보고한다");

      // 격리된 lock은 파일로 남아 있고, 다른 suite/stress는 소유권이 확인되지 않는 동안 획득할 수 없다.
      assert.ok(existsSync(lockPath), "lock 파일이 남아 있다(노출 금지)");
      assert.equal(readLockRecord(lockPath).quarantined, true, "격리 표시");
      assert.equal(existsSync(guardPathOf(cfg)), false, "정상 격리 전이는 guard를 남기지 않는다");
      const second = runLockCli(["probe"], lockConfig(dir), dir, "second.json");
      assert.equal(second.status, 2, "격리된 lock으로는 일반 suite가 시작되지 않는다");
      assert.match(String(second.stderr), /lock_quarantined/);
      const secondStress = runStress(stressConfig(dir, { suiteMode: "noop_pass" }), dir, 60_000, "stress2.json");
      assert.equal(secondStress.status, 2, "격리된 lock으로는 stress도 시작되지 않는다");
      assert.match(String(secondStress.stderr), /lock_quarantined/);
      assert.equal(readLockRecord(lockPath).quarantined, true, "거부된 쪽이 격리를 풀지 않는다");

      // 소유 worker는 정리되고, 무관한 제3의 프로세스는 건드리지 않는다.
      await assertPidFilesDead(dir, ["worker-0.pid"]);
      assert.equal(isAlive(bystander.pid), true, "무관 프로세스를 죽이지 않는다");
    } finally {
      bystander.stop();
    }
  });
});

/**
 * P2 회귀(여섯 번째 리비전) — **소비자 관점**: 정리 확인까지 성공했더라도 lock unlink **뒤** guard 반납이
 * 실패하면 stress runner의 요약이 `lockReleased:true`가 되어서는 안 된다. 예전 구현은 handle이
 * released로 남아 요약도 `lockReleased:true`였다(= 다음 실행이 안전하다는 잘못된 신호).
 */
test("[M3d.2] stress: lock unlink 뒤 guard 반납이 실패하면 lockReleased=true로 보고하지 않는다", async () => {
  await withTempAsync(async (dir) => {
    const lockDir = join(dir, "lockdir");
    const pauseDir = join(dir, "pause");
    mkdirSync(lockDir, { recursive: true });
    mkdirSync(pauseDir, { recursive: true });
    const lockPath = join(lockDir, "suite.lock");
    const guardPath = `${lockPath}.guard`;
    const cfg = stressConfig(dir, {
      lockPath,
      suiteMode: "noop_pass",
      pauseDir,
      pauseAt: "before_guard_unlink_release", // lock unlink는 끝났고 guard 제거 직전
      guardWaitMs: 200,
      confirmMs: 5_000,
      testTimeoutMs: 30_000,
      deadlineMs: 40_000,
    });
    const child = spawn(process.execPath, [STRESS, "--fixture-config", fixtureFile(dir, cfg, "stress-guard.json")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => child.on("close", (code: number | null) => resolve(code)));
    let restored = true;
    try {
      await waitForFile(join(pauseDir, "paused"), 60_000);
      assert.equal(existsSync(lockPath), false, "lock 파일 unlink는 이미 성공했다");
      chmodSync(lockDir, 0o555); // 이 지점 이후의 guard unlink만 실패시킨다
      restored = false;
      writeFileSync(join(pauseDir, "resume"), "go", "utf8");
      const code = await exited;
      chmodSync(lockDir, 0o755);
      restored = true;

      assert.equal(code, 1, `guard 반납 실패는 FAIL (stderr tail: ${stderr.slice(-400)})`);
      const s = stressSummary(stdout);
      assert.equal(s.cleanupConfirmed, true, "정리 확인 자체는 성공했다(실패는 lock 전이 완결 쪽이다)");
      assert.equal(s.lockReleased, false, "해제 미완결을 해제로 보고하지 않는다");
      assert.equal(s.lockQuarantined, false, "격리도 아니다");
      assert.ok(Number(s.cleanupProblems) > 0, "문제 건수를 보고한다");
      assert.match(stderr, /lock_guard_release_failed/, "guard 반납 실패를 보고한다");
      assert.match(stderr, /lock 해제가 완결되지 않았습니다\(state=failed\)/, "완결되지 않았음을 명시한다");
      assert.ok(existsSync(guardPath), "제거하지 못한 guard가 남아 다음 실행을 막는다");
      await assertPidFilesDead(dir, ["worker-0.pid"]);

      const blocked = runLockCli(["probe"], lockConfig(dir, { lockPath, guardWaitMs: 100 }), dir, "blocked.json");
      assert.equal(blocked.status, 2, "남은 guard가 새 suite를 막는다");
      assert.match(String(blocked.stderr), /lock_transition_guard_present/);
    } finally {
      if (!restored) chmodSync(lockDir, 0o755);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

// ── 9) wrapper shutdown 상태 기계 ───────────────────────────────────────────

test("[M3d.2] wrapper: 정상 종료라도 소유 그룹 잔재를 정리·확인한 뒤에 lock을 해제한다", async () => {
  await withTempAsync(async (dir) => {
    // child는 손자를 같은 그룹에 남기고 정상 종료(exit 0)한다 → close만 보고 해제하면 잔재가 남는다.
    const cfg = wrapperConfig(dir);
    const r = runLockCli(["child", "residual"], cfg, dir);
    assert.equal(r.status, 0, `정상 종료 exit 0 (stderr: ${String(r.stderr).slice(0, 400)})`);
    assert.equal(String(r.stderr).includes("lock 정리 문제"), false, "정리 문제 없음");
    await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
    assert.equal(existsSync(lockPathOf(cfg)), false, "확인 후 lock 해제");
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] wrapper: spawn 실패도 같은 shutdown 기계로 처리하고 lock을 남기지 않는다", async () => {
  await withTempAsync(async (dir) => {
    const cfgPath = fixtureFile(dir, wrapperConfig(dir));
    const env = isolatedEnv({ PATH: join(dir, "no-such-bin") }); // npm을 찾을 수 없게 만든다 → spawn ENOENT
    const r = spawnSync(process.execPath, [LOCK_CLI, "run", "test:inner", "--fixture-config", cfgPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
    assert.equal(r.status, 1, `spawn 실패는 exit 1 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stderr), /suite 실행 실패/);
    assert.equal(existsSync(join(dir, "suite.lock")), false, "lock 해제됨");
    assertNoLockResidue(dir);
  });
});

for (const [sig, expected] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as Array<[NodeJS.Signals, number]>) {
  test(`[M3d.2] wrapper: ${sig}도 같은 shutdown 기계로 그룹·자손 소멸 확인 후 해제(exit ${expected})`, async () => {
    await withTempAsync(async (dir) => {
      const cfg = wrapperConfig(dir);
      const w = spawn(process.execPath, [LOCK_CLI, "child", "sleep", "--fixture-config", fixtureFile(dir, cfg)], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        env: isolatedEnv(),
      });
      let stderr = "";
      w.stderr.on("data", (d: Buffer) => (stderr += String(d)));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        w.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
      });
      try {
        await waitForPidFile(join(dir, "grandchild.pid"));
        w.kill(sig);
        const r = await exited;
        assert.equal(r.signal, null, `핸들러가 직접 종료 (stderr: ${stderr.slice(0, 300)})`);
        assert.equal(r.code, expected, `exit ${expected}`);
        assert.match(stderr, new RegExp(`${sig} 수신 — 소유 프로세스 정리 확인 후 종료`));
        assert.equal(stderr.includes("lock 정리 문제"), false, "정리 문제 없음");
        await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
        assert.equal(existsSync(lockPathOf(cfg)), false, "확인 후 lock 해제");
        assertNoLockResidue(dir);
      } finally {
        if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
      }
    });
  });
}

test("[M3d.2] wrapper: SIGTERM을 무시하는 자손도 유예 후 escalation으로 정리하고 확인 뒤 해제한다", async () => {
  await withTempAsync(async (dir) => {
    const cfg = wrapperConfig(dir);
    const w = spawn(process.execPath, [LOCK_CLI, "child", "sleep_ignore_term", "--fixture-config", fixtureFile(dir, cfg)], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stderr = "";
    w.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => w.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForPidFile(join(dir, "grandchild.pid"));
      w.kill("SIGTERM");
      const code = await exited;
      assert.equal(code, 143, `escalation 후에도 exit 143 (stderr: ${stderr.slice(0, 300)})`);
      await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
      assert.equal(existsSync(lockPathOf(cfg)), false, "확인 후 lock 해제");
      assertNoLockResidue(dir);
    } finally {
      if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
    }
  });
});

test("[M3d.2] wrapper: 반복 시그널은 확인 없이 나가므로 lock을 해제하지 않고 격리한다(exit 143 유지)", async () => {
  await withTempAsync(async (dir) => {
    const cfg = wrapperConfig(dir);
    const lockPath = lockPathOf(cfg);
    const w = spawn(process.execPath, [LOCK_CLI, "child", "sleep_ignore_term", "--fixture-config", fixtureFile(dir, cfg)], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stderr = "";
    w.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      w.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
    });
    try {
      await waitForPidFile(join(dir, "grandchild.pid"));
      w.kill("SIGTERM"); // 1회차: shutdown 진입 → TERM은 무시되어 유예 중
      await sleep(1_200);
      w.kill("SIGTERM"); // 2회차: 확인을 마칠 수 없는 탈출 경로
      const r = await exited;
      assert.equal(r.signal, null, `핸들러가 직접 종료 (stderr: ${stderr.slice(0, 400)})`);
      assert.equal(r.code, 143, "시그널 exit 의미 유지");
      assert.match(stderr, /반복 시그널/);
      assert.ok(existsSync(lockPath), "lock을 노출하지 않는다(해제 금지)");
      assert.equal(readLockRecord(lockPath).quarantined, true, "격리 표시");
      assert.equal(existsSync(guardPathOf(cfg)), false, "정상 격리 전이는 guard를 남기지 않는다");
      const blocked = runLockCli(["probe"], lockConfig(dir), dir, "blocked.json");
      assert.equal(blocked.status, 2, "격리된 동안 다른 suite는 시작할 수 없다");
      assert.match(String(blocked.stderr), /lock_quarantined/);
      await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
    } finally {
      if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
    }
  });
});

test("[M3d.2] wrapper: 정리 확인 불가는 lock을 격리하고 무관 프로세스는 건드리지 않는다", async () => {
  await withTempAsync(async (dir) => {
    const bystander = spawnBystander();
    try {
      const cfg = wrapperConfig(dir, { inject: "confirm_failure", confirmMs: 600 });
      const lockPath = lockPathOf(cfg);
      const r = runLockCli(["child", "residual"], cfg, dir);
      assert.equal(r.status, 1, `확인 불가는 실패 (stderr: ${String(r.stderr).slice(0, 400)})`);
      assert.match(String(r.stderr), /정리 확인 실패 — lock을 해제하지 않고 격리/);
      assert.ok(existsSync(lockPath), "lock을 노출하지 않는다");
      assert.equal(readLockRecord(lockPath).quarantined, true);
      const blocked = runLockCli(["probe"], lockConfig(dir), dir, "blocked.json");
      assert.equal(blocked.status, 2);
      assert.match(String(blocked.stderr), /lock_quarantined/);
      await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
      assert.equal(isAlive(bystander.pid), true, "무관 프로세스를 죽이지 않는다");
    } finally {
      bystander.stop();
    }
  });
});

test("[M3d.2] wrapper: 확인 불가 + 시그널이면 exit 143을 유지한 채 lock을 격리한다", async () => {
  await withTempAsync(async (dir) => {
    const cfg = wrapperConfig(dir, { inject: "confirm_failure", confirmMs: 600 });
    const lockPath = lockPathOf(cfg);
    const w = spawn(process.execPath, [LOCK_CLI, "child", "sleep", "--fixture-config", fixtureFile(dir, cfg)], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stderr = "";
    w.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<number | null>((resolve) => w.on("close", (code: number | null) => resolve(code)));
    try {
      await waitForPidFile(join(dir, "grandchild.pid"));
      w.kill("SIGTERM");
      const code = await exited;
      assert.equal(code, 143, `시그널 exit 의미 유지 (stderr: ${stderr.slice(0, 400)})`);
      assert.match(stderr, /정리 확인 실패 — lock을 해제하지 않고 격리/);
      assert.ok(existsSync(lockPath), "확인 불가면 lock을 노출하지 않는다");
      assert.equal(readLockRecord(lockPath).quarantined, true);
      await assertPidFilesDead(dir, ["child.pid", "grandchild.pid"]);
    } finally {
      if (w.exitCode === null && w.signalCode === null) w.kill("SIGKILL");
    }
  });
});

// ── 10) 중첩(재진입) 정리 계약 (Codex Sol xhigh P1-4) ───────────────────────

test("[M3d.2] 중첩: 재진입 wrapper의 자손은 상위 소유 pgid에 남아 상위 정리에서 사라진다", async () => {
  await withTempAsync(async (dir) => {
    // 재진입 wrapper의 child가 손자를 남기고 정상 종료한다 → 손자는 상위(stress) 소유 그룹에 있어야 한다.
    const cfg = stressConfig(dir, { suiteMode: "nested_residual", childMs: 30_000, confirmMs: 10_000 });
    const r = runStress(cfg, dir, 120_000);
    assert.equal(r.status, 0, `PASS (stderr: ${String(r.stderr).slice(0, 500)})`);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.npmTestExitCode, 0, "재진입 wrapper는 정상 종료");
    assert.equal(s.ownedDescendantsAfterCleanup, 0, "상위 pgid 자손 0");
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.cleanupProblems, 0);
    assert.equal(s.lockReleased, true);
    // 중첩 child·손자가 실제로 사라졌다(상위 그룹 정리가 전 자손을 덮는다).
    await assertPidFilesDead(dir, ["child.pid", "grandchild.pid", "worker-0.pid"]);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] 중첩: 상위 timeout SIGKILL이 재진입 child·손자까지 모두 덮는다", async () => {
  await withTempAsync(async (dir) => {
    // 재진입 wrapper의 child가 오래 사는 동안 상위가 wall-clock 상한으로 그룹 SIGKILL한다.
    const cfg = stressConfig(dir, {
      suiteMode: "nested_sleep",
      childMs: 60_000,
      testTimeoutMs: 2_500,
      deadlineMs: 60_000,
      confirmMs: 10_000,
    });
    const r = runStress(cfg, dir, 120_000);
    assert.equal(r.status, 1, `timeout은 FAIL (stderr: ${String(r.stderr).slice(0, 500)})`);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.npmTestTimedOut, true);
    // timeout도 **TERM 먼저** 보내고 유예를 준다 → 재진입 wrapper가 자기 shutdown을 끝낼 수 있다.
    // (상위가 곧바로 SIGKILL하면 이 줄이 나오지 않는다.)
    assert.match(String(r.stderr), /\[suite-lock\] SIGTERM 수신 — 소유 프로세스 정리 확인 후 종료/, "하위 wrapper가 자기 정리를 마쳤다");
    assert.equal(s.ownedDescendantsAfterCleanup, 0, "중첩 자손까지 상위 pgid에서 사라졌다");
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.lockReleased, true);
    // 핵심 회귀: 중첩 child를 별도 그룹으로 분리하면 이 확인이 실패한다.
    await assertPidFilesDead(dir, ["child.pid", "grandchild.pid", "worker-0.pid"]);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] 중첩: TERM을 무시하는 재진입 child·손자도 상위 유예 후 KILL로 전부 사라진다", async () => {
  await withTempAsync(async (dir) => {
    // 재진입 wrapper의 child와 손자가 **SIGTERM을 무시**한다. 상위 stress는 wall-clock 상한에서
    // TERM → 유예(8s) → 생존 확인 → KILL로 escalate해야 하고, 그 결과 전 자손이 사라져야 한다.
    const cfg = stressConfig(dir, {
      suiteMode: "nested_ignore_term",
      childMs: 60_000,
      testTimeoutMs: 2_500,
      deadlineMs: 60_000,
      confirmMs: 15_000,
    });
    const r = runStress(cfg, dir, 180_000);
    assert.equal(r.status, 1, `timeout은 FAIL (stderr: ${String(r.stderr).slice(0, 600)})`);
    const s = stressSummary(String(r.stdout));
    assert.equal(s.npmTestTimedOut, true);
    // 상위가 곧바로 KILL하지 않고 TERM+유예를 줬다는 증거(하위 wrapper가 자기 shutdown을 끝냈다).
    assert.match(
      String(r.stderr),
      /\[suite-lock\] SIGTERM 수신 — 소유 프로세스 정리 확인 후 종료/,
      "하위 wrapper가 유예 안에서 자기 정리를 마쳤다",
    );
    assert.equal(s.ownedDescendantsAfterCleanup, 0, "TERM을 무시한 자손까지 escalation으로 사라졌다");
    assert.equal(s.npmGroupAliveAfterCleanup, false);
    assert.equal(s.cleanupConfirmed, true);
    assert.equal(s.lockReleased, true, "확인 후에만 해제");
    await assertPidFilesDead(dir, ["child.pid", "grandchild.pid", "worker-0.pid"]);
    assert.equal(existsSync(lockPathOf(cfg)), false);
    assertNoLockResidue(dir);
  });
});

test("[M3d.2] 중첩: 상위 SIGINT 유예 안에서 하위가 자기 확인을 끝내고 상위가 lock을 해제한다(exit 130)", async () => {
  await withTempAsync(async (dir) => {
    const cfg = stressConfig(dir, { suiteMode: "nested_sleep", childMs: 60_000, confirmMs: 10_000 });
    const child = spawn(process.execPath, [STRESS, "--fixture-config", fixtureFile(dir, cfg)], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: isolatedEnv(),
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
    });
    try {
      await waitForPidFile(join(dir, "grandchild.pid"), 60_000);
      await waitForPidFile(join(dir, "worker-0.pid"));
      child.kill("SIGINT");
      const r = await exited;
      assert.equal(r.signal, null, `핸들러가 직접 종료 (stderr: ${stderr.slice(0, 400)})`);
      assert.equal(r.code, 130, "exit 130 유지");
      assert.equal(stderr.includes("cleanup 문제"), false, `정리 문제 없음 (stderr: ${stderr.slice(0, 400)})`);
      await assertPidFilesDead(dir, ["child.pid", "grandchild.pid", "worker-0.pid"]);
      assert.equal(existsSync(lockPathOf(cfg)), false, "확인 후 상위가 lock 해제");
      assertNoLockResidue(dir);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

// ── 11) fixture 로더 계약: 검사–사용 경합 제거 (Codex Sol xhigh P1-3) ─────────
//
// 로더는 경로를 **정확히 한 번** 열고(O_NOFOLLOW), 검사(fstat: 일반 파일)와 내용 읽기를 그 fd 하나에서
// 끝낸다. 아래 테스트는 그 계약의 관찰 가능한 결과를 고정한다: 최종 symlink 거부 / 실제 읽은 바이트 기준
// 상한 / 일반 파일이 아닌 경로 거부 / 경로가 교체돼도 교체된 설정을 절대 해석하지 않음.

test("[M3d.2] fixture 로더: 최종 경로가 symlink면 대상이 정상 설정이어도 거부한다", () => {
  withTemp((dir) => {
    const real = fixtureFile(dir, lockConfig(dir), "real.json");
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    assert.ok(lstatSync(link).isSymbolicLink(), "symlink 준비");

    const r = runLockCliWithFixturePath(["probe"], link);
    assert.equal(r.status, 2, `symlink는 거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stderr), /fixture_not_file/);
    // 정상 파일을 직접 주면 통과한다(거부가 경로 형태 때문임을 확인).
    const ok = runLockCliWithFixturePath(["probe"], real);
    assert.equal(ok.status, 0, `일반 파일은 통과 (stderr: ${String(ok.stderr).slice(0, 300)})`);
  });
});

test("[M3d.2] fixture 로더: 상한은 실제 읽은 바이트로 판정한다(8192 통과 / 8193 거부)", () => {
  withTemp((dir) => {
    const base = JSON.stringify(lockConfig(dir));
    // JSON 뒤 공백은 유효한 JSON이라 바이트 수만 정확히 늘릴 수 있다.
    const atLimit = writeRawFixture(join(dir, "at-limit.json"), base + " ".repeat(8192 - Buffer.byteLength(base, "utf8")));
    assert.equal(lstatSync(atLimit).size, 8192, "정확히 상한 크기");
    const ok = runLockCliWithFixturePath(["probe"], atLimit);
    assert.equal(ok.status, 0, `상한과 같은 크기는 통과 (stderr: ${String(ok.stderr).slice(0, 300)})`);

    const overLimit = writeRawFixture(join(dir, "over-limit.json"), base + " ".repeat(8193 - Buffer.byteLength(base, "utf8")));
    assert.equal(lstatSync(overLimit).size, 8193, "상한 +1 바이트");
    const over = runLockCliWithFixturePath(["probe"], overLimit);
    assert.equal(over.status, 2, "상한을 1바이트 넘기면 거부");
    assert.match(String(over.stderr), /fixture_too_large/);
  });
});

test("[M3d.2] fixture 로더: 일반 파일이 아닌 경로(디렉터리)는 거부한다", () => {
  withTemp((dir) => {
    const asDir = join(dir, "config-dir.json");
    mkdirSync(asDir, { recursive: true });
    const r = runLockCliWithFixturePath(["probe"], asDir);
    assert.equal(r.status, 2, `디렉터리는 거부 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.match(String(r.stderr), /fixture_not_file|fixture_unreadable/);
  });
});

test("[M3d.2] fixture 로더: 경로가 계속 교체돼도 교체된 설정을 해석하지 않는다(검사==사용)", async () => {
  // 로더를 **in-process로 직접** 호출한다: 경합 창(검사→사용)을 초당 수천 번 지나가므로
  // "검사한 inode == 읽은 inode" 위반이 있으면 실제로 관측된다(CLI spawn은 시도 횟수가 너무 적다).
  const loader = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "lib", "fixture-config.mjs")).href)) as {
    loadFixtureConfig: (argv: string[], spec: Record<string, unknown>) => { config: Record<string, unknown> | null };
  };
  const SPEC = { lockPath: { kind: "absPath" }, psFixture: { kind: "absPath" } };

  await withTempAsync(async (dir) => {
    // legit: 오탐 없는 ps fixture. evil: **suite 후보가 담긴** ps fixture + 8KiB 초과 크기.
    // 두 결함(최종 symlink / 상한 초과)을 한 번에 갖고 있으므로 어떤 정상 경로로도 통과할 수 없다.
    const legitCfg = lockConfig(dir);
    const legitPath = fixtureFile(dir, legitCfg, "legit.json");
    const evilCfg = { lockPath: join(dir, "evil.lock"), psFixture: psFixture(dir, SUITE_PS_ROWS, "ps-suite.txt") };
    const evilBase = JSON.stringify(evilCfg);
    const evilPath = writeRawFixture(join(dir, "evil.json"), evilBase + " ".repeat(9_000));
    const target = join(dir, "swap-target.json");
    writeFileSync(target, readFileSync(legitPath, "utf8"), { encoding: "utf8", mode: 0o600 });

    // target을 "legit 하드링크" ↔ "evil symlink" 사이에서 계속 바꾸는 bounded swapper.
    const swapSrc = [
      'const fs = require("node:fs");',
      `const target = ${JSON.stringify(target)};`,
      `const legit = ${JSON.stringify(legitPath)};`,
      `const evil = ${JSON.stringify(evilPath)};`,
      "const deadline = Date.now() + 60000;",
      "const ppid0 = process.ppid;",
      "while (Date.now() < deadline && process.ppid === ppid0) {",
      '  try { fs.unlinkSync(target); } catch {}',
      "  try { fs.symlinkSync(evil, target); } catch {}",
      '  try { fs.unlinkSync(target); } catch {}',
      "  try { fs.linkSync(legit, target); } catch {}",
      "}",
    ].join("\n");
    const swapper = spawn(process.execPath, ["-e", swapSrc], { stdio: "ignore" });
    const swapperExit = new Promise<void>((resolve) => swapper.on("close", () => resolve()));
    let loaded = 0;
    let refused = 0;
    try {
      const end = Date.now() + 4_000;
      while (Date.now() < end) {
        try {
          const { config } = loader.loadFixtureConfig(["--fixture-config", target], SPEC);
          assert.ok(config, "성공했다면 설정이 있어야 한다");
          // 허용되는 성공은 **검사를 통과한 그 파일**(legit)뿐이다. 교체된 설정을 돌려주면 실패다.
          assert.equal(config.lockPath, legitCfg.lockPath, "교체된 lock 경로를 해석했다(검사≠사용)");
          assert.equal(config.psFixture, legitCfg.psFixture, "교체된 ps fixture를 해석했다(검사≠사용)");
          loaded += 1;
        } catch (e) {
          if (e instanceof assert.AssertionError) throw e;
          assert.equal((e as Error).name, "FixtureConfigError", `허용되지 않은 예외: ${String(e)}`);
          refused += 1;
        }
      }
      assert.ok(loaded + refused > 200, `경합 창을 충분히 많이 지나갔다 (loaded=${loaded}, refused=${refused})`);
      // 거부가 0이면 경합 자체가 일어나지 않은 것이므로 이 테스트는 공허하다 — 실제 경합을 요구한다.
      assert.ok(refused > 0, `실제 경합이 발생했다 (loaded=${loaded}, refused=${refused})`);
    } finally {
      // swapper가 완전히 멈춘 뒤에 임시 디렉터리를 정리한다(정리 중 파일 재생성 방지).
      swapper.kill("SIGKILL");
      await swapperExit;
    }
  });
});

/**
 * P2-5 회귀(다섯 번째 리비전): 읽기 전용 fd라도 `closeSync` 실패를 무시하고 설정을 돌려주지 않는다.
 * 이 경로는 실제 close를 실패시켜야 관측되므로 **in-process io seam**(loadFixtureConfig 세 번째 인자)로만
 * 주입한다 — production 진입점은 인자 2개로만 호출하므로 argv·env·설정 파일로는 도달할 수 없고,
 * "외부 주입은 argv 하나뿐"이라는 계약도 그대로다(아래 호출부 검증 테스트가 이를 고정한다).
 */
test("[M3d.2] fixture 로더: fd close 실패를 무시하지 않고 명시 오류로 거부한다", async () => {
  const loader = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "lib", "fixture-config.mjs")).href)) as {
    loadFixtureConfig: (
      argv: string[],
      spec: Record<string, unknown>,
      io?: Record<string, unknown>,
    ) => { config: Record<string, unknown> | null };
  };
  const SPEC = { lockPath: { kind: "absPath" } };
  const codeOf = (e: unknown) => (e as { code?: string }).code;
  withTemp((dir) => {
    const cfgPath = fixtureFile(dir, { lockPath: join(dir, "suite.lock") }, "close.json");
    const argv = ["--fixture-config", cfgPath];

    // (a) production 경로(io 미지정)는 그대로 통과한다.
    assert.equal(loader.loadFixtureConfig(argv, SPEC).config?.lockPath, join(dir, "suite.lock"), "기본 io는 정상 동작");

    // (b) close가 실제로 실패하면 설정을 돌려주지 않는다. fd는 테스트가 직접 닫아 누수를 만들지 않는다.
    let closed = 0;
    assert.throws(
      () =>
        loader.loadFixtureConfig(argv, SPEC, {
          closeSync: (fd: number) => {
            closeSync(fd);
            closed += 1;
            throw Object.assign(new Error("close failed"), { code: "EIO" });
          },
        }),
      (e: unknown) => (e as { name?: string }).name === "FixtureConfigError" && codeOf(e) === "fixture_close_failed",
      "close 실패는 fixture_close_failed로 거부한다",
    );
    assert.equal(closed, 1, "fd는 실제로 닫혀 누수가 없다");

    // (c) seam 자체가 좁다: 허용 key 밖 / 함수가 아닌 값 / 객체가 아닌 값은 모두 거부.
    for (const bad of [{ nope: () => undefined }, { closeSync: 1 }, [] as unknown] as unknown[]) {
      assert.throws(
        () => loader.loadFixtureConfig(argv, SPEC, bad as Record<string, unknown>),
        (e: unknown) => codeOf(e) === "fixture_io_invalid",
        `좁은 seam 계약: ${JSON.stringify(bad)}`,
      );
    }
  });
});

/**
 * 이 계약은 **현재 production 호출부 전부**에 걸린다(일곱 번째 리비전에서 구문 인식·재귀로 확대):
 * lock wrapper·stress runner뿐 아니라 live runner 3종도 `loadFixtureConfig`를 import한다.
 * 호출부는 `scripts` 아래 일반 `.mjs`를 **재귀 열거**해 AST로 발견하므로, 하위 디렉터리·공백/주석 호출·
 * 별칭 import로도 감사를 빠져나갈 수 없다. 새 호출부가 생기면 이 테스트가 먼저 깨져
 * 계약(외부 주입은 argv 하나뿐 · in-process io seam은 production에서 쓰지 않는다)을 다시 확인하게 된다.
 */
test("[M3d.2] fixture 로더: production 전 호출부(scripts 재귀·AST)가 io seam을 넘기지 않는다(외부 주입은 argv 하나뿐)", () => {
  const EXPECTED_CALLERS = [
    "scripts/m3a-live-preflight.mjs",
    "scripts/m3b2-live-handoff.mjs",
    "scripts/m3c3b-live-handoff.mjs",
    "scripts/m3d2-stress-acceptance.mjs",
    "scripts/suite-lock.mjs",
  ];
  const { files, symlinks } = collectMjsSources(REPO_ROOT, "scripts");
  // symlink는 production 소스로 신뢰하지 않는다 — 하나라도 있으면 사람이 확인해야 한다.
  assert.deepEqual(symlinks, [], "scripts 아래 symlink 엔트리는 감사 대상이 아니다(발견 시 수동 확인)");
  // 열거가 실제로 재귀한다: 루트·lib뿐 아니라 더 깊은 fixture 디렉터리 파일도 포함된다.
  const rels = files.map((f) => f.rel);
  assert.ok(rels.includes(LOADER_REL), "로더 모듈 자체도 열거된다");
  assert.ok(rels.includes("scripts/fixtures/m3a/minimal-stdio-mcp.mjs"), "중첩 디렉터리(scripts/fixtures/m3a)까지 재귀한다");
  assert.ok(files.length >= 10, `scripts 아래 .mjs를 모두 열거한다 (${files.length}건)`);
  // 여덟 번째 리비전: 동적 지정자 규칙이 **정상** 동적 import(빌드 산출물 로딩)를 깨뜨리지 않는 실증 대조군.
  // 이 세 파일은 `await import(<const 경로>)`를 쓰지만 로더를 부르지 않으므로 호출부 목록에 없어야 한다.
  for (const legitDynamic of [
    "scripts/m3c-live-discovery.mjs",
    "scripts/m3c-live-schema-probe.mjs",
    "scripts/m3c2-live-read-semantics.mjs",
  ]) {
    assert.ok(rels.includes(legitDynamic), `${legitDynamic}이 열거된다(감사 대상에 실제로 들어간다)`);
  }

  const audits = auditFixtureLoaderCalls(files);
  assert.deepEqual(
    audits.map((a) => a.rel),
    [...EXPECTED_CALLERS].sort(),
    "production 로더 호출부 목록이 바뀌었다 — 새 호출부의 주입 계약을 확인하고 이 목록을 갱신하라",
  );

  for (const audit of audits) {
    assert.deepEqual(audit.issues, [], `${audit.rel}: 호출 계약 위반 — ${audit.issues.join(" / ")}`);
    assert.deepEqual(audit.bindings, [LOADER_EXPORT], `${audit.rel}: 별칭·namespace 없이 이름 그대로 import한다`);
    assert.equal(audit.calls.length, 1, `${audit.rel}: 로더 호출은 한 번뿐`);
    assert.equal(audit.calls[0].argCount, 2, `${audit.rel}: argv+spec 2개 인자만 넘긴다 — ${audit.calls[0].args.join(" | ")}`);
    assert.equal(audit.calls[0].canonicalFirstArg, true, `${audit.rel}: 첫 인자는 process.argv.slice(2)`);
    assert.equal(audit.calls[0].args[0], "process.argv.slice(2)", `${audit.rel}: 첫 인자 원문도 동일`);
  }
});

/**
 * 열거 계약의 비공허성: 감사는 **재귀**하고 symlink는 신뢰하지 않는다.
 * 실제 파일시스템(임시 디렉터리)에서 확인한다 — production 파일은 건드리지 않는다.
 */
test("[M3d.2] 호출부 열거: scripts 아래를 재귀 열거하고 symlink 파일·디렉터리는 따라가지 않는다", () => {
  withTemp((dir) => {
    mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
    mkdirSync(join(dir, "scripts", "a", "b"), { recursive: true });
    mkdirSync(join(dir, "outside"), { recursive: true });
    writeFileSync(join(dir, "scripts", "top.mjs"), "export const a = 1;\n", "utf8");
    writeFileSync(join(dir, "scripts", "a", "b", "deep.mjs"), "export const b = 2;\n", "utf8");
    writeFileSync(join(dir, "scripts", "a", "note.md"), "not source\n", "utf8");
    writeFileSync(join(dir, "scripts", "lib", "helper.mjs"), "export const c = 3;\n", "utf8");
    writeFileSync(join(dir, "outside", "sneaky.mjs"), "export const d = 4;\n", "utf8");
    symlinkSync(join(dir, "scripts", "top.mjs"), join(dir, "scripts", "link.mjs")); // symlink 파일
    symlinkSync(join(dir, "outside"), join(dir, "scripts", "linkdir")); // symlink 디렉터리

    const { files, symlinks } = collectMjsSources(dir, "scripts");
    assert.deepEqual(
      files.map((f) => f.rel),
      ["scripts/a/b/deep.mjs", "scripts/lib/helper.mjs", "scripts/top.mjs"],
      "중첩 디렉터리까지 열거하고 .mjs가 아닌 파일·symlink는 제외한다",
    );
    assert.deepEqual(symlinks.sort(), ["scripts/link.mjs", "scripts/linkdir"], "건너뛴 symlink를 보고한다");
    assert.equal(
      files.some((f) => f.rel.includes("sneaky")),
      false,
      "symlink 디렉터리를 따라가 경로 밖 파일을 production 소스로 세지 않는다",
    );
  });
});

/** 합성 소스 감사 헬퍼 — 임시 파일·production 수정 없이 감사 함수 자체를 돌린다. */
const auditSynthetic = (sources: MjsSource[]): LoaderCallerAudit[] => auditFixtureLoaderCalls(sources);
const CANONICAL_CALLER: MjsSource = {
  rel: "scripts/synthetic-ok.mjs",
  text: [
    'import { FixtureConfigError, loadFixtureConfig } from "./lib/fixture-config.mjs";',
    "const SPEC = { evidenceDir: { kind: \"absPath\" } };",
    "const loaded = loadFixtureConfig(process.argv.slice(2), SPEC);",
    "export { loaded, FixtureConfigError };",
  ].join("\n"),
};

/**
 * P2 회귀(일곱 번째 리비전) — **비공허성**: 예전 감사(루트+lib 한 겹 · `loadFixtureConfig(` 문자열 일치)를
 * 빠져나가던 세 가지 우회를 합성 소스로 재현한다. 셋 다 ⓐ 호출부로 **발견**되고 ⓑ 세 번째 인자(io seam)로
 * **거부**되어야 한다. 합성 소스라 파일을 남기지 않고 production을 임시로 훼손하지도 않는다.
 */
test("[M3d.2] 호출부 감사: 중첩 경로·공백/주석 호출·별칭 import 우회를 모두 발견하고 거부한다", () => {
  const IO_ARG = "{ closeSync: () => undefined }";
  const cases: Array<{ label: string; source: MjsSource; binding: string }> = [
    {
      // ⓐ 중첩 하위 디렉터리(예전 스캔은 한 겹만 봤다) + 세 번째 인자
      label: "중첩 디렉터리 호출부",
      binding: LOADER_EXPORT,
      source: {
        rel: "scripts/nested/deep/hidden-runner.mjs",
        text: [
          'import { loadFixtureConfig } from "../../lib/fixture-config.mjs";',
          `const loaded = loadFixtureConfig(process.argv.slice(2), {}, ${IO_ARG});`,
        ].join("\n"),
      },
    },
    {
      // ⓑ 식별자와 `(` 사이에 공백·줄바꿈·주석(문자열 일치로는 못 찾는다) + 세 번째 인자
      label: "공백·주석 분리 호출",
      binding: LOADER_EXPORT,
      source: {
        rel: "scripts/whitespace-runner.mjs",
        text: [
          'import { loadFixtureConfig } from "./lib/fixture-config.mjs";',
          "const loaded = loadFixtureConfig /* 주석 */",
          `  (process.argv.slice(2), {}, ${IO_ARG});`,
        ].join("\n"),
      },
    },
    {
      // ⓒ 별칭 import — `loadFixtureConfig(` 문자열이 아예 나오지 않는다 + 세 번째 인자
      label: "별칭 import 호출",
      binding: "loadCfg",
      source: {
        rel: "scripts/alias-runner.mjs",
        text: [
          'import { loadFixtureConfig as loadCfg } from "./lib/fixture-config.mjs";',
          `const loaded = loadCfg(process.argv.slice(2), {}, ${IO_ARG});`,
        ].join("\n"),
      },
    },
    {
      // ⓓ namespace import 경유 호출 + 세 번째 인자
      label: "namespace import 호출",
      binding: `fixtureConfig.${LOADER_EXPORT}`,
      source: {
        rel: "scripts/ns/namespace-runner.mjs",
        text: [
          'import * as fixtureConfig from "../lib/fixture-config.mjs";',
          `const loaded = fixtureConfig.loadFixtureConfig(process.argv.slice(2), {}, ${IO_ARG});`,
        ].join("\n"),
      },
    },
  ];

  for (const { label, source, binding } of cases) {
    const audits = auditSynthetic([CANONICAL_CALLER, source]);
    assert.deepEqual(
      audits.map((a) => a.rel).sort(),
      [CANONICAL_CALLER.rel, source.rel].sort(),
      `${label}: 호출부로 발견된다(목록 비교가 먼저 깨진다)`,
    );
    const audit = audits.find((a) => a.rel === source.rel);
    assert.ok(audit, `${label}: 감사 결과 존재`);
    assert.equal(audit.calls.length, 1, `${label}: 호출을 정확히 하나 찾는다`);
    assert.equal(audit.calls[0].binding, binding, `${label}: 어떤 바인딩을 통한 호출인지 식별한다`);
    assert.equal(audit.calls[0].argCount, 3, `${label}: 세 번째 인자를 실제로 센다`);
    assert.equal(audit.issues.length > 0, true, `${label}: 계약 위반으로 보고한다`);
    assert.match(audit.issues.join("\n"), /로더 호출 인자 3개/, `${label}: io seam 전달을 거부한다`);
    // 같은 실행에서 정상 호출부는 통과한다(감사가 무조건 실패하는 게 아니다).
    const ok = audits.find((a) => a.rel === CANONICAL_CALLER.rel);
    assert.deepEqual(ok?.issues, [], `${label}: 정상 호출부는 통과한다`);
  }
});

/**
 * 감사의 나머지 계약: 첫 인자 정규형 · import했지만 호출 안 함 · 다중 호출 · 정적 감사 우회 형태.
 * 그리고 **오탐 금지**: 문자열·주석 안의 `loadFixtureConfig(`는 호출이 아니다.
 */
test("[M3d.2] 호출부 감사: 첫 인자 정규형·미사용·다중 호출·동적 로딩을 잡고 문자열/주석은 오탐하지 않는다", () => {
  const mk = (rel: string, lines: string[]): MjsSource => ({ rel, text: lines.join("\n") });
  const auditOne = (source: MjsSource): LoaderCallerAudit | undefined => auditSynthetic([source]).find((a) => a.rel === source.rel);

  // (a) 첫 인자가 정규형이 아니면 인자 수가 2개여도 거부한다.
  const notCanonical = auditOne(
    mk("scripts/first-arg.mjs", [
      'import { loadFixtureConfig } from "./lib/fixture-config.mjs";',
      "const argv = process.argv.slice(1);",
      "const loaded = loadFixtureConfig(argv, {});",
    ]),
  );
  assert.equal(notCanonical?.calls[0].argCount, 2, "인자 수 자체는 2개");
  assert.equal(notCanonical?.calls[0].canonicalFirstArg, false, "첫 인자는 정규형이 아니다");
  assert.match(String(notCanonical?.issues.join("\n")), /첫 인자가 process\.argv\.slice\(2\)가 아니다/);

  // (b) import만 하고 호출하지 않는 바인딩도 조용히 넘기지 않는다.
  const unused = auditOne(
    mk("scripts/unused.mjs", ['import { loadFixtureConfig } from "./lib/fixture-config.mjs";', "export const noop = 1;"]),
  );
  assert.deepEqual(unused?.calls, [], "호출이 없다");
  assert.match(String(unused?.issues.join("\n")), /import하고 호출하지 않는다/);

  // (c) 호출이 두 번이면 보고한다(하나만 검사하고 나머지를 흘리지 않는다).
  const twice = auditOne(
    mk("scripts/twice.mjs", [
      'import { loadFixtureConfig } from "./lib/fixture-config.mjs";',
      "const a = loadFixtureConfig(process.argv.slice(2), {});",
      "const b = loadFixtureConfig(process.argv.slice(2), {}, { closeSync: () => undefined });",
    ]),
  );
  assert.equal(twice?.calls.length, 2, "두 호출을 모두 찾는다");
  assert.match(String(twice?.issues.join("\n")), /로더 호출이 2번이다/);
  assert.match(String(twice?.issues.join("\n")), /로더 호출 인자 3개/, "두 번째 호출의 io seam도 잡는다");

  // (d) 정적 감사를 우회하는 형태(동적 로딩·재수출·비호출 참조)도 문제로 남는다.
  const dynamic = auditOne(
    mk("scripts/dynamic.mjs", [
      'const mod = await import("./lib/fixture-config.mjs");',
      "export const loaded = mod.loadFixtureConfig(process.argv.slice(2), {});",
    ]),
  );
  assert.match(String(dynamic?.issues.join("\n")), /동적으로 불러온다/);
  const reexport = auditOne(mk("scripts/reexport.mjs", ['export { loadFixtureConfig } from "./lib/fixture-config.mjs";']));
  assert.match(String(reexport?.issues.join("\n")), /재수출한다/);
  const indirect = auditOne(
    mk("scripts/indirect.mjs", [
      'import { loadFixtureConfig } from "./lib/fixture-config.mjs";',
      "const alias = loadFixtureConfig;",
      "export const loaded = alias(process.argv.slice(2), {}, { closeSync: () => undefined });",
    ]),
  );
  assert.match(String(indirect?.issues.join("\n")), /호출이 아닌 위치에서 참조한다/);

  // (e) 오탐 금지: import가 없고 문자열·주석에만 이름이 나오는 파일은 호출부가 아니다.
  const noise = auditSynthetic([
    mk("scripts/noise.mjs", [
      "// loadFixtureConfig(process.argv.slice(2), spec, io) 는 여기서 호출하지 않는다",
      'const doc = "loadFixtureConfig(argv, spec, io)";',
      "export const help = doc;",
    ]),
    CANONICAL_CALLER,
  ]);
  assert.deepEqual(noise.map((a) => a.rel), [CANONICAL_CALLER.rel], "문자열·주석은 호출부로 세지 않는다");
  assert.deepEqual(noise[0].issues, [], "정상 합성 호출부는 통과한다(positive control)");
});

/** 합성 소스 한 건을 만드는 축약. */
const mkSource = (rel: string, lines: string[]): MjsSource => ({ rel, text: lines.join("\n") });
/** 감사에서 이 파일의 결과만 꺼낸다(정상 호출부를 positive control로 함께 넣는다). */
function auditWithControl(source: MjsSource): { audit: LoaderCallerAudit | undefined; audits: LoaderCallerAudit[] } {
  const audits = auditSynthetic([CANONICAL_CALLER, source]);
  const ok = audits.find((a) => a.rel === CANONICAL_CALLER.rel);
  assert.deepEqual(ok?.issues, [], `${source.rel}: 같은 실행에서 정상 호출부는 통과한다(감사가 무조건 실패하는 게 아니다)`);
  return { audit: audits.find((a) => a.rel === source.rel), audits };
}
/** io seam(세 번째 인자)을 넘기는 우회의 표식. */
const IO_SEAM_ARG = "{ closeSync: () => undefined }";

/**
 * P2 회귀(여덟 번째 리비전) — **지정자 정규화**: query·fragment·percent 인코딩이 붙은 상대 지정자도
 * 로더로 인식해야 한다(Node ESM은 같은 파일로 해석한다). 정규화 자체가 불가능한 지정자는 fail closed다.
 * 로더가 아닌 모듈의 query 지정자는 호출부로 세지 않는다(오탐 금지).
 */
test("[M3d.2] 호출부 감사: query·fragment·percent 지정자도 로더로 인식하고 정규화 불가는 fail closed다", () => {
  const bypasses: Array<{ label: string; rel: string; spec: string }> = [
    { label: "query 지정자", rel: "scripts/spec-query.mjs", spec: "./lib/fixture-config.mjs?v=2" },
    { label: "fragment 지정자", rel: "scripts/spec-fragment.mjs", spec: "./lib/fixture-config.mjs#seam" },
    { label: "query+fragment 지정자", rel: "scripts/spec-both.mjs", spec: "./lib/fixture-config.mjs?a=1#b?c" },
    { label: "percent 인코딩 지정자", rel: "scripts/spec-percent.mjs", spec: "./lib/fixture%2Dconfig.mjs" },
    { label: "중첩 경로 + query", rel: "scripts/deep/nest/spec-nested.mjs", spec: "../../lib/fixture-config.mjs?x=1" },
    { label: "percent + query", rel: "scripts/spec-percent-query.mjs", spec: "./%6Cib/fixture-config.mjs?v=3" },
  ];
  for (const { label, rel, spec } of bypasses) {
    const { audit } = auditWithControl(
      mkSource(rel, [`import { loadFixtureConfig } from "${spec}";`, `const loaded = loadFixtureConfig(process.argv.slice(2), {}, ${IO_SEAM_ARG});`]),
    );
    assert.ok(audit, `${label}: 호출부로 발견된다`);
    assert.equal(audit.calls.length, 1, `${label}: 호출을 하나 찾는다`);
    assert.equal(audit.calls[0].argCount, 3, `${label}: 세 번째 인자를 센다`);
    assert.match(audit.issues.join("\n"), /로더 호출 인자 3개/, `${label}: io seam 전달을 거부한다`);
  }

  // 정규화 불가(`%2F` = 인코딩된 경로 구분자 / 깨진 percent 시퀀스)는 "로더가 아니다"로 넘기지 않는다.
  for (const { label, rel, spec } of [
    { label: "인코딩된 경로 구분자", rel: "scripts/spec-slash.mjs", spec: "./lib%2Ffixture-config.mjs" },
    { label: "깨진 percent 시퀀스", rel: "scripts/spec-broken-pct.mjs", spec: "./lib/%zzfixture.mjs" },
  ]) {
    const { audit } = auditWithControl(mkSource(rel, [`import * as anything from "${spec}";`, "export const x = anything;"]));
    assert.ok(audit, `${label}: 판정 불가도 감사 대상으로 남는다`);
    assert.match(audit.issues.join("\n"), /정규화할 수 없어 로더 여부를 판정할 수 없다\(fail closed\)/, `${label}: fail closed로 보고한다`);
  }

  // 오탐 금지: 로더가 아닌 모듈의 query 지정자는 호출부가 아니다.
  const unrelated = auditSynthetic([
    CANONICAL_CALLER,
    mkSource("scripts/spec-other.mjs", ['import { other } from "./lib/other-config.mjs?v=1";', "export const x = other;"]),
  ]);
  assert.deepEqual(unrelated.map((a) => a.rel), [CANONICAL_CALLER.rel], "로더가 아닌 query 지정자는 호출부로 세지 않는다");
});

/**
 * P2 회귀(여덟 번째 리비전) — **계산된 동적 로딩**: `import()` 인자가 리터럴이 아니어도 정적으로 접히면
 * 로더로 확정하고, 접히지 않고 로더를 배제할 근거도 없으면 fail closed로 보고한다.
 * 반대로 live runner의 정상 동적 import 형태(빌드 산출물 경로)는 **문제로 보고하지 않는다** — 그래야 규칙이
 * 쓸 수 있는 규칙이다(실제 repo 대조군은 위 production 호출부 테스트가 함께 단정한다).
 */
test("[M3d.2] 호출부 감사: 계산된 동적 import도 로더로 확정하거나 fail closed로 거부한다", () => {
  // (a) 정적으로 접히는 형태 = 로더로 확정한다.
  const folded: Array<{ label: string; rel: string; lines: string[] }> = [
    { label: "문자열 연결", rel: "scripts/dyn-concat.mjs", lines: ['const mod = await import("./lib/" + "fixture-config.mjs");', "export const m = mod;"] },
    {
      label: "불변 const 문자열 바인딩",
      rel: "scripts/dyn-const.mjs",
      lines: ['const LOADER_PATH = "./lib/fixture-config.mjs";', "const mod = await import(LOADER_PATH);", "export const m = mod;"],
    },
    {
      label: "const + 연결",
      rel: "scripts/dyn-const-concat.mjs",
      lines: ['const DIR = "./lib/";', 'const mod = await import(DIR + "fixture-config.mjs");', "export const m = mod;"],
    },
    {
      label: "치환 template",
      rel: "scripts/dyn-template.mjs",
      lines: ['const NAME = "fixture-config.mjs";', "const mod = await import(`./lib/${NAME}`);", "export const m = mod;"],
    },
    {
      label: "접힌 지정자 + query",
      rel: "scripts/dyn-query.mjs",
      lines: ['const mod = await import("./lib/" + "fixture-config.mjs?v=1");', "export const m = mod;"],
    },
    { label: "require 연결", rel: "scripts/dyn-require.mjs", lines: ['const mod = require("./lib/" + "fixture-config.mjs");', "export const m = mod;"] },
  ];
  for (const { label, rel, lines } of folded) {
    const { audit } = auditWithControl(mkSource(rel, lines));
    assert.ok(audit, `${label}: 호출부로 발견된다`);
    assert.match(audit.issues.join("\n"), /동적으로 불러온다/, `${label}: 로더 동적 로딩으로 보고한다`);
  }

  // (b) 접히지 않고 로더를 배제할 근거도 없는 형태 = fail closed(bounded 규칙, 증명 주장 아님).
  const unproven: Array<{ label: string; rel: string; lines: string[] }> = [
    { label: "완전 계산(파라미터)", rel: "scripts/dyn-param.mjs", lines: ["export async function load(spec) {", "  return import(spec);", "}"] },
    {
      label: "재할당 가능한 let",
      rel: "scripts/dyn-let.mjs",
      lines: ['let target = "./lib/other.mjs";', 'target = "./lib/fixture-config.mjs";', "const mod = await import(target);", "export const m = mod;"],
    },
    {
      // 같은 이름이 두 번 선언되면 어떤 선언이 유효한지 확정할 수 없으므로 folding에 쓰지 않는다.
      label: "같은 이름 중복 선언",
      rel: "scripts/dyn-dup.mjs",
      lines: [
        'const spec = "./lib/harmless.mjs";',
        'function alt() { const spec = "./lib/fixture-config.mjs"; return spec; }',
        "const mod = await import(spec);",
        "export const m = [mod, alt];",
      ],
    },
  ];
  for (const { label, rel, lines } of unproven) {
    const { audit } = auditWithControl(mkSource(rel, lines));
    assert.ok(audit, `${label}: 감사 대상으로 남는다`);
    assert.match(audit.issues.join("\n"), /동적 지정자를 정적으로 확정할 수 없어/, `${label}: fail closed로 보고한다`);
  }

  // (c) 정상 동적 import(빌드 산출물)는 문제로 보고하지 않는다 — live runner 3종과 같은 형태다.
  const legit = auditSynthetic([
    CANONICAL_CALLER,
    mkSource("scripts/dyn-legit.mjs", [
      'import { join, dirname } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const HERE = dirname(fileURLToPath(import.meta.url));",
      'const distMod = join(HERE, "..", "dist", "core", "runWorkflow.js");',
      "const { runWorkflow } = await import(distMod);",
      'const { projectPaths } = await import(join(HERE, "..", "dist", "core", "project.js"));',
      "export const api = { runWorkflow, projectPaths };",
    ]),
  ]);
  assert.deepEqual(legit.map((a) => a.rel), [CANONICAL_CALLER.rel], "빌드 산출물 동적 import는 호출부로 세지 않는다(규칙이 정상 코드를 깨지 않는다)");
});

/**
 * P2 회귀(여덟 번째 리비전) — **재노출**: 직접 `export … from`만 잡던 것을 import-then-export까지 넓혔다.
 * 재수출이 있으면 감사된 호출부라도 다른 모듈에 로더 seam을 넘겨줄 수 있다.
 * 소스 순서(import 먼저 / export 먼저)와 무관해야 한다 — 수집이 두 패스이기 때문이다.
 */
test("[M3d.2] 호출부 감사: import 후 재수출·별칭·namespace 재노출을 순서와 무관하게 잡는다", () => {
  const CALL = "const loaded = loadFixtureConfig(process.argv.slice(2), {});";
  const IMPORT = 'import { loadFixtureConfig } from "./lib/fixture-config.mjs";';

  // (a) import → 정상 호출 → export: 옛 감사는 **아무 문제도 보고하지 않았다**.
  const after = auditWithControl(mkSource("scripts/expose-after.mjs", [IMPORT, CALL, "export { loadFixtureConfig };", "export { loaded };"])).audit;
  assert.ok(after, "재노출 파일도 호출부다");
  assert.equal(after.calls.length, 1, "정상 호출 자체는 하나로 인식한다");
  assert.equal(after.calls[0].argCount, 2, "호출 인자는 2개다(문제는 호출이 아니라 재노출이다)");
  assert.equal(after.calls[0].canonicalFirstArg, true, "첫 인자는 정규형이다");
  assert.match(after.issues.join("\n"), /export \{ loadFixtureConfig \}으로 재노출한다/, "import-then-export를 재노출로 보고한다");

  // (b) export가 import보다 **먼저** 나와도 같다(ESM hoisting — 두 패스라 순서로 우회할 수 없다).
  const before = auditWithControl(mkSource("scripts/expose-before.mjs", ["export { loadFixtureConfig };", IMPORT, CALL, "export { loaded };"])).audit;
  assert.match(String(before?.issues.join("\n")), /export \{ loadFixtureConfig \}으로 재노출한다/, "export-before-import도 잡는다");

  // (c) 별칭 재노출 / default 재노출.
  const alias = auditWithControl(mkSource("scripts/expose-alias.mjs", [IMPORT, CALL, "export { loadFixtureConfig as loader };", "export { loaded };"])).audit;
  assert.match(String(alias?.issues.join("\n")), /export \{ loadFixtureConfig as loader \}으로 재노출한다/, "별칭 재노출도 잡는다");
  const dflt = auditWithControl(mkSource("scripts/expose-default.mjs", [IMPORT, CALL, "export default loadFixtureConfig;"])).audit;
  assert.match(String(dflt?.issues.join("\n")), /export default으로 재노출한다/, "default 재노출도 잡는다");

  // (d) namespace 파생 노출: namespace 자체를 export하는 것도 로더 도달 경로다.
  const ns = auditWithControl(
    mkSource("scripts/expose-ns.mjs", [
      'import * as fixtureConfig from "./lib/fixture-config.mjs";',
      "const loaded = fixtureConfig.loadFixtureConfig(process.argv.slice(2), {});",
      "export { fixtureConfig, loaded };",
    ]),
  ).audit;
  assert.match(String(ns?.issues.join("\n")), /로더 namespace fixtureConfig을\(를\) export \{ fixtureConfig \}으로 재노출한다/, "namespace 재노출을 잡는다");

  // (e) `export * as ns from` 도 직접 재수출이다.
  const starAs = auditWithControl(mkSource("scripts/expose-star.mjs", ['export * as loaderNs from "./lib/fixture-config.mjs";'])).audit;
  assert.match(String(starAs?.issues.join("\n")), /재수출한다\(직접 export-from\)/, "export * as 도 재수출로 잡는다");
});

/**
 * P2 회귀(여덟 번째 리비전) — **scope 인식**: 바인딩 판정이 식별자 텍스트만 보면
 * ⓐ 지역 `process` shadow가 "첫 인자 = 실제 argv"라는 단정을 통과하고,
 * ⓑ shadow된 이름이 import 사용으로 계산되어 미사용 검사가 무력해지고,
 * ⓒ namespace import에는 미사용 검사가 아예 없었다.
 * 정확한 scope 계산 대신 **가릴 수 있는 선언이 있으면 실패**(conservative fail closed)로 고정한다.
 */
test("[M3d.2] 호출부 감사: process·바인딩·namespace shadow와 미사용 namespace를 fail closed로 잡는다", () => {
  const IMPORT = 'import { loadFixtureConfig } from "./lib/fixture-config.mjs";';

  // (a) 지역 const `process` shadow — 인자 2개 + 첫 인자 원문이 `process.argv.slice(2)`라 옛 감사는 통과했다.
  const shadowConst = auditWithControl(
    mkSource("scripts/shadow-process-const.mjs", [
      IMPORT,
      'const process = { argv: ["node", "x", "--fixture-config", "/tmp/attacker.json"] };',
      "const loaded = loadFixtureConfig(process.argv.slice(2), {});",
      "export { loaded };",
    ]),
  ).audit;
  assert.ok(shadowConst, "shadow 파일도 호출부다");
  assert.equal(shadowConst.calls.length, 1, "호출은 하나다");
  assert.equal(shadowConst.calls[0].argCount, 2, "인자 수는 2개(구조만으로는 정상처럼 보인다)");
  assert.equal(shadowConst.calls[0].args[0], "process.argv.slice(2)", "첫 인자 원문도 정규형과 같다");
  assert.equal(shadowConst.calls[0].canonicalFirstArg, false, "그럼에도 정규형으로 인정하지 않는다(fail closed)");
  assert.match(shadowConst.issues.join("\n"), /전역 process를 const 선언으로 가린다/, "process shadow를 보고한다");

  // (b) 파라미터로 가리는 경우도 같다.
  const shadowParam = auditWithControl(
    mkSource("scripts/shadow-process-param.mjs", [
      IMPORT,
      "function main(process) {",
      "  return loadFixtureConfig(process.argv.slice(2), {});",
      "}",
      "export const loaded = main(globalThis.process);",
    ]),
  ).audit;
  assert.equal(shadowParam?.calls[0].canonicalFirstArg, false, "파라미터 shadow도 정규형이 아니다");
  assert.match(String(shadowParam?.issues.join("\n")), /전역 process를 함수 파라미터으로 가린다/, "파라미터 shadow를 보고한다");

  // (c) 로더 바인딩 이름 shadow — 그 호출은 로더 호출로 **인정하지 않고**, import는 미사용으로 남는다.
  const shadowDirect = auditWithControl(
    mkSource("scripts/shadow-direct.mjs", [
      IMPORT,
      "function run(loadFixtureConfig) {",
      `  return loadFixtureConfig(process.argv.slice(2), {}, ${IO_SEAM_ARG});`,
      "}",
      "export { run };",
    ]),
  ).audit;
  assert.deepEqual(shadowDirect?.calls, [], "shadow된 이름의 호출을 로더 호출로 세지 않는다");
  assert.match(String(shadowDirect?.issues.join("\n")), /로더 바인딩 loadFixtureConfig을\(를\) 함수 파라미터으로 가린다/, "바인딩 shadow를 보고한다");
  assert.match(String(shadowDirect?.issues.join("\n")), /import하고 호출하지 않는다/, "shadow된 식별자를 import 사용으로 인정하지 않는다");

  // (d) namespace shadow도 같은 규칙이다.
  const shadowNs = auditWithControl(
    mkSource("scripts/shadow-ns.mjs", [
      'import * as fixtureConfig from "./lib/fixture-config.mjs";',
      "function run(fixtureConfig) {",
      `  return fixtureConfig.loadFixtureConfig(process.argv.slice(2), {}, ${IO_SEAM_ARG});`,
      "}",
      "export { run };",
    ]),
  ).audit;
  assert.deepEqual(shadowNs?.calls, [], "shadow된 namespace 호출도 세지 않는다");
  assert.match(String(shadowNs?.issues.join("\n")), /로더 바인딩 fixtureConfig을\(를\) 함수 파라미터으로 가린다/, "namespace shadow를 보고한다");
  assert.match(String(shadowNs?.issues.join("\n")), /네임스페이스 fixtureConfig을\(를\) import하고 호출하지 않는다/, "namespace도 미사용 검사를 받는다");

  // (e) 미사용 namespace(shadow 없음)도 조용히 넘기지 않는다 — 옛 감사에는 이 검사가 없었다.
  const unusedNs = auditWithControl(
    mkSource("scripts/unused-ns.mjs", ['import * as fixtureConfig from "./lib/fixture-config.mjs";', "export const noop = 1;"]),
  ).audit;
  assert.deepEqual(unusedNs?.calls, [], "호출이 없다");
  assert.deepEqual(unusedNs?.bindings, ["fixtureConfig.*"], "namespace 바인딩으로 보고한다");
  assert.match(String(unusedNs?.issues.join("\n")), /네임스페이스 fixtureConfig을\(를\) import하고 호출하지 않는다/, "미사용 namespace를 보고한다");

  // (f) namespace를 값으로 넘기는 것도 우회 표면이다.
  const nsValue = auditWithControl(
    mkSource("scripts/ns-value.mjs", [
      'import * as fixtureConfig from "./lib/fixture-config.mjs";',
      "const loaded = fixtureConfig.loadFixtureConfig(process.argv.slice(2), {});",
      "export const handoff = [fixtureConfig, loaded];",
    ]),
  ).audit;
  assert.match(String(nsValue?.issues.join("\n")), /네임스페이스 fixtureConfig을\(를\) 값으로 참조한다/, "namespace 값 전달을 보고한다");
});

/**
 * P3 회귀(여덟 번째 리비전): 구문 오류가 있는 소스는 **부분 파싱**된다. 그 상태의 "import를 못 찾았다"를
 * "로더를 부르지 않는다"의 근거로 쓰면 감사가 조용히 공허해진다 → 파싱 진단이 있으면 fail closed로 보고한다.
 */
test("[M3d.2] 호출부 감사: 구문 오류 소스를 안전하다고 보지 않는다(파싱 진단 fail closed)", () => {
  const brokenCaller = auditWithControl(
    mkSource("scripts/broken-caller.mjs", [
      'import { loadFixtureConfig } from "./lib/fixture-config.mjs";',
      `const loaded = loadFixtureConfig(process.argv.slice(2), {}, ${IO_SEAM_ARG});`,
      "const oops = (;",
    ]),
  ).audit;
  assert.ok(brokenCaller, "구문 오류가 있어도 호출부로 남는다");
  assert.match(brokenCaller.issues.join("\n"), /구문 오류 \d+건 — 부분 파싱된 소스를 안전하다고 볼 수 없다\(fail closed\)/, "파싱 진단을 보고한다");

  // 로더 이름이 아예 없는 파일도, 부분 파싱이면 "감사했다"고 주장하지 않는다.
  const brokenPlain = auditWithControl(mkSource("scripts/broken-plain.mjs", ["export const a = 1;", "function ("])).audit;
  assert.ok(brokenPlain, "로더를 언급하지 않아도 부분 파싱 파일은 감사 결과로 남는다");
  assert.match(brokenPlain.issues.join("\n"), /구문 오류 \d+건/, "파싱 진단만으로도 문제로 보고한다");
});

test("[M3d.2] fixture 계약: wrapper는 stress 전용 key를 해석하지 않고 거부한다(confused deputy 금지)", () => {
  withTemp((dir) => {
    for (const extra of [{ workers: 2 }, { suiteMode: "noop_pass" }, { testTimeoutMs: 5_000 }, { deadlineMs: 9_000 }] as Array<
      Record<string, unknown>
    >) {
      const r = runLockCli(["probe"], { ...lockConfig(dir), ...extra }, dir, "stress-key.json");
      assert.equal(r.status, 2, `stress 전용 key 거부: ${Object.keys(extra)[0]}`);
      assert.match(String(r.stderr), /fixture_unknown_key/, `허용 목록 밖 key: ${Object.keys(extra)[0]}`);
    }
    // stress runner도 wrapper 전용 주입 값을 받지 않는다(양방향으로 좁다).
    const s = runStress(stressConfig(dir, { inject: "confirm_failure", suiteMode: "noop_pass" }), dir, 60_000);
    assert.equal(s.status, 2, "stress는 wrapper 전용 inject 값을 거부");
    assert.match(String(s.stderr), /fixture_value_invalid/);
  });
});
