/**
 * [B-58] **사용자에게 인쇄하는 명령 문자열은 그대로 실행 가능해야 한다.**
 *
 * 이 레포는 거짓 복구 안내를 반복해서 냈다(`C-138`·`B-49`·`B-50`·`B-54` 그리고 M15에서 6건 더).
 * 그중 가장 값싼 부류가 **필수 옵션 누락**과 **없는 스크립트 경로**다 — 사람이 문장을 그대로
 * 복사해 붙이면 즉시 실패하는데, 코드를 읽어서는 눈에 띄지 않는다.
 *
 * 개별 문자열을 하나씩 고치는 것으로는 닫히지 않는다(M15가 실제로 한 자리만 고치고 형제 5곳을
 * 놓쳤다). 그래서 **소스를 훑어 전수로 잰다.** 새 안내 문장이 생겨도 같이 걸린다.
 *
 * 필수 옵션 목록은 `src/cli.ts`에서 **파생한다** — 손으로 적은 사본을 두면 CLI가 바뀔 때
 * 검사만 조용히 낡는다(이 레포가 반복해 잡은 부류).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `--project`를 **필수**로 선언한 CLI 명령 이름 (cli.ts에서 파생). */
function projectRequiringCommands(): string[] {
  const cli = readFileSync(join(REPO, "src", "cli.ts"), "utf8");
  const out: string[] = [];
  // `.command("name")` 부터 다음 `.command(` 전까지가 그 명령의 선언 블록이다.
  const heads = [...cli.matchAll(/\.command\("([a-z][a-z-]*)"/g)];
  for (const [i, m] of heads.entries()) {
    const start = m.index!;
    const end = i + 1 < heads.length ? heads[i + 1].index! : cli.length;
    if (/requiredOption\(\s*"--project/.test(cli.slice(start, end))) out.push(m[1]);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** 주석 줄은 사용법 개요(synopsis)라 검사 대상이 아니다 — 실행하라고 인쇄하는 문장만 잰다. */
const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

/**
 * 면제: **실행 지시가 아니라 명령을 인용·설명**하는 산문(예: "그 명령은 거부된다").
 * 바로 앞 줄에 `// guidance-exempt: <사유>`를 적어야 한다 — **사유 없는 면제는 받지 않는다**
 * (면제가 값싸면 검사가 조용히 비어 간다).
 */
const EXEMPT = /\/\/\s*guidance-exempt:\s*\S/;

test("[B-58] 인쇄하는 `harness <cmd>` 문장에 필수 --project가 빠지지 않는다 (전수)", () => {
  const commands = projectRequiringCommands();
  assert.ok(commands.length >= 5, `cli.ts에서 --project 필수 명령을 못 찾았다 (파생 실패): ${commands.join(",")}`);
  assert.ok(commands.includes("task-prompt") && commands.includes("handoff"), `대표 명령이 빠졌다: ${commands.join(",")}`);

  const offenders: string[] = [];
  for (const file of sourceFiles(join(REPO, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [n, line] of lines.entries()) {
      if (isComment(line)) continue;
      if (n > 0 && EXEMPT.test(lines[n - 1])) continue;
      for (const cmd of commands) {
        // `harness pipeline next` 처럼 하위명령이 붙는 경우까지 한 정규식으로 잡는다.
        const re = new RegExp(`harness ${cmd}\\b`);
        if (!re.test(line)) continue;
        // 템플릿 리터럴이 줄바꿈으로 이어지므로 뒤 2줄까지 같은 문장으로 본다.
        const window = lines.slice(n, n + 3).join("\n");
        if (!/--project/.test(window)) offenders.push(`${file.slice(REPO.length + 1)}:${n + 1}  ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `--project 없이 인쇄되는 명령 문장:\n${offenders.join("\n")}`);
});

test("[B-58] 인쇄하는 `scripts/…` 경로가 실제로 존재한다", () => {
  // M15 실측: `scripts/token-lint`를 실행하라고 지시했는데 실제 파일은 `scripts/token-lint.mjs`였다.
  const offenders: string[] = [];
  for (const file of sourceFiles(join(REPO, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [n, line] of lines.entries()) {
      if (isComment(line)) continue;
      for (const m of line.matchAll(/scripts\/([A-Za-z0-9._-]+)/g)) {
        const rel = `scripts/${m[1]}`;
        if (!existsSync(join(REPO, rel))) offenders.push(`${file.slice(REPO.length + 1)}:${n + 1}  ${rel}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `존재하지 않는 스크립트 경로를 인쇄한다:\n${offenders.join("\n")}`);
});

// ── B-63 ──────────────────────────────────────────────────────
test("[B-63] run_state.json에 쓰는 모든 자리가 tmp+rename(원자)을 쓴다 (전수)", () => {
  // red: 어느 writer든 plain writeFileSync로 되돌리면 걸린다.
  //      `C-135`가 세 writer를 원자 쓰기로 바꿀 때 `handoff.ts`의 형제 writer가 **빠졌다** —
  //      개별 자리를 고치는 것만으로는 다음 누락을 막지 못해서 전수로 잰다.
  //      run_state.json은 `pipeline status`가 설계상 lock 없이 읽고, 폐기 잠금의 유일한 근거이며,
  //      하류 명령이 fail-closed다. 찢어진 write 한 번 = 모든 명령 거부 + 손 복구.
  const offenders: string[] = [];
  for (const file of sourceFiles(join(REPO, "src"))) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const [n, line] of lines.entries()) {
      if (isComment(line)) continue;
      if (!/writeFileSync\(/.test(line)) continue;
      // 이 write가 run_state.json을 향하는가: 같은 함수 안(앞 15줄)에 그 경로가 있는가.
      const before = lines.slice(Math.max(0, n - 15), n + 1).join("\n");
      if (!/run_state\.json|RUN_STATE_REL/.test(before)) continue;
      // 원자 쓰기인가: tmp에 쓰고 rename 하는가 (뒤 4줄 안에 renameSync).
      const after = lines.slice(n, n + 5).join("\n");
      if (!/tmp/i.test(line) || !/renameSync\(/.test(after)) {
        offenders.push(`${file.slice(REPO.length + 1)}:${n + 1}  ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `run_state.json을 비원자적으로 쓴다:\n${offenders.join("\n")}`);
});
