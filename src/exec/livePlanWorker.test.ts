/**
 * V3 M10 T3 — **live plan worker** focused 테스트.
 *
 * 실행: `npx tsx --test src/exec/livePlanWorker.test.ts`
 * **LLM 0회.** 승인 경계가 실행할 프로그램 자리에 우리가 쓴 스크립트를 두므로 실제 프로세스는 뜨지만
 * 추론은 없다(무과금). 여기서 고정하는 것은 **모듈 자신의 계약**이다:
 * 세션 상한 · 종료코드 · 계획 추출 · 사용량 파싱 · 계약 밖 출력의 거부.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationError } from "./orchestrationTypes.js";
import { extractPlanJson, LIVE_WORKER_ARGS, LIVE_WORKER_ENV, readReportedUsage, startLivePlanTurn } from "./livePlanWorker.js";
import { isApprovedModelString } from "./approvalManifest.js";

const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 결과를 바꾸지 않는다 */
    }
  }
});

function bin(body: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "m10-lpw-")));
  dirs.push(dir);
  const file = join(dir, "worker.mjs");
  writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return file;
}

const BINDING = { runId: "run-1", taskId: "task-1", attemptId: "att-1", turnId: "turn-1" } as const;

/** 부모 env 상속 여부를 재는 canary. 이 프로세스에만 두고 자식에서 보이면 계약 위반이다. */
const CANARY = "HARNESS_M11_ENV_CANARY";
process.env[CANARY] = "leaked";

/** 승인된 격리 `CLAUDE_CONFIG_DIR` 자리(V3 M11 · `C-86`). 계약 검증은 kernel이 하고 worker는 값만 받는다. */
function configDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "m11-claude-cfg-")));
  dirs.push(d);
  return d;
}

/** 지금 그 디렉터리의 dev+ino. kernel이 turn 검증에서 확보하는 값과 같은 것이다. */
function identityOf(dir: string): { dev: number; ino: number } {
  const st = statSync(dir);
  return { dev: st.dev, ino: st.ino };
}

async function drain(executable: string, timeoutMs = 30_000): Promise<string> {
  try {
    const cfg = configDir();
    const stream = startLivePlanTurn({ executable, configDir: cfg, configDirIdentity: identityOf(cfg), model: null, prompt: "x", binding: { ...BINDING }, timeoutMs });
    let kinds = "";
    for await (const ev of stream) kinds += `${ev.kind},`;
    return kinds;
  } catch (e) {
    return e instanceof OrchestrationError ? `!${e.code}` : `!non-orchestration:${String(e)}`;
  }
}

const EMIT = (result: string, usage = "null"): string =>
  `import { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nprocess.stdout.write(JSON.stringify({ result: ${JSON.stringify(result)}, usage: ${usage} }));\n`;

test("[M10-T3] 계획을 낸 세션은 started → progress → terminal 계약으로 흐른다", async () => {
  const ok = bin(EMIT('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  assert.equal(await drain(ok), "started,progress,progress,terminal,");
});

test("[M10-T3] 세션 상한을 넘기면 죽이고 worker_deadline_exceeded다 (실시간 · 주입 시계 아님)", async () => {
  const hang = bin('import { readFileSync } from "node:fs";\nreadFileSync(0, "utf8");\nsetInterval(() => {}, 1000);\n');
  const startedAt = process.hrtime.bigint();
  const got = await drain(hang, 1_000);
  const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
  assert.equal(got, "!worker_deadline_exceeded");
  // 상한을 무시하면(호출자 상수·`0`) 이 단정이 red다 — "죽였다"를 시간으로 확인한다.
  assert.ok(elapsedMs < 10_000, `세션 상한이 집행되지 않았다(경과 ${elapsedMs}ms)`);
});

test("[M10-T3] 비정상 종료·계약 밖 출력은 각각 닫힌 코드로 거부된다", async () => {
  assert.equal(await drain(bin('process.exit(3);\n')), "!worker_exit_nonzero");
  assert.equal(await drain(bin(EMIT("계획 없이 설명만 적는다."))), "!worker_plan_absent");
  // `result` key가 있는 JSON처럼 보이지만 계약 밖이면 검증기가 거부한다(offline backend와 같은 함수).
  assert.equal(await drain(bin(EMIT('{"result": {"summary": "", "outputs": []}}'))), "!plan_invalid");
  // 실행 형식이 아닌 파일은 동기 `ENOEXEC`다 — 예외로 새어 나가지 않고 닫힌 코드가 된다.
  const notExec = bin("");
  writeFileSync(notExec, "not an executable\n", { mode: 0o700 });
  assert.equal(await drain(notExec), "!worker_spawn_failed");
});

test("[M10-T3] extractPlanJson: 중첩·본문 중괄호·여러 후보 중 마지막을 고른다", () => {
  assert.equal(extractPlanJson('앞말 {"result": {"a": 1}} 뒷말'), '{"result": {"a": 1}}');
  // 문자열 안의 `}`가 블록을 자르지 않는다.
  assert.equal(extractPlanJson('{"result": {"summary": "닫는 괄호 } 포함"}}'), '{"result": {"summary": "닫는 괄호 } 포함"}}');
  // 예시를 먼저 적고 실제 계획을 나중에 적는 경우 → 마지막을 쓴다.
  assert.equal(extractPlanJson('{"result": {"n": 1}} 그리고 {"result": {"n": 2}}'), '{"result": {"n": 2}}');
  // `result`가 없는 객체는 계획 후보가 아니다.
  assert.equal(extractPlanJson('{"operations": []}'), null);
  assert.equal(extractPlanJson("계획이 없다"), null);
});

test("[M10-T3] readReportedUsage: cache 필드를 합산하고 형태 밖 값은 0이다", () => {
  assert.deepEqual(readReportedUsage({ input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2, output_tokens: 11 }), {
    inputTokens: 14,
    outputTokens: 11,
  });
  assert.deepEqual(readReportedUsage({ input_tokens: -3, output_tokens: "많음" }), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(readReportedUsage(null), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(readReportedUsage([1, 2]), { inputTokens: 0, outputTokens: 0 });
});

test("[M11/C-86] 자식 env는 LIVE_WORKER_ENV + 승인된 CLAUDE_CONFIG_DIR 하나뿐이다", async () => {
  // **이 축이 실제로 자식에게 도착하는지**를 못 박는다. 없으면 세션이 ambient 자격증명으로 돌고
  // `C-86`이 조용히 재발한다 — 타입만으로는 못 잡는다(`tsconfig`가 `*.test.ts`를 제외한다).
  const out = join(realpathSync(mkdtempSync(join(tmpdir(), "m11-env-"))), "env.json");
  dirs.push(join(out, ".."));
  const echo = bin(
    `import { readFileSync, writeFileSync } from "node:fs";\nreadFileSync(0, "utf8");\n` +
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n` +
      `process.stdout.write(JSON.stringify({ result: ${JSON.stringify('{"operations": [], "result": {"summary": "ok", "outputs": []}}')}, usage: null }));\n`,
  );
  const cfg = configDir();
  const stream = startLivePlanTurn({ executable: echo, configDir: cfg, configDirIdentity: identityOf(cfg), model: null, prompt: "x", binding: { ...BINDING }, timeoutMs: 30_000 });
  for await (const _ of stream) { /* 소진 */ }
  const env = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
  assert.equal(env.CLAUDE_CONFIG_DIR, cfg, "승인된 신원이 자식에게 도착하지 않았다");
  for (const [k, v] of Object.entries(LIVE_WORKER_ENV)) assert.equal(env[k], v, `${k}가 계약과 다르다`);
  // **키 집합 동등으로 단정하지 않는다**(V3 M11 실측): macOS/Node가 `__CF_USER_TEXT_ENCODING`을
  // 스스로 넣는다 — 우리가 준 값이 아니다. 그것을 "우리 env"로 세면 거짓이고, 동등 단정으로 두면
  // 플랫폼이 하나 더 넣는 날 무관한 red가 난다. 그래서 **우리가 정한 것 + 새어들면 안 되는 것**을
  // 각각 못 박는다(이 방향이 이 테스트가 지키려는 성질이다).
  const ours = new Set([...Object.keys(LIVE_WORKER_ENV), "CLAUDE_CONFIG_DIR"]);
  const PLATFORM_INJECTED = new Set(["__CF_USER_TEXT_ENCODING"]);
  assert.deepEqual(
    Object.keys(env).filter((k) => !ours.has(k) && !PLATFORM_INJECTED.has(k)),
    [],
    `계약 밖 변수가 자식에게 도착했다: ${JSON.stringify(env)}`,
  );
  // 부모 env가 상속되지 않는다는 것을 **canary로** 단정한다(위 필터가 공허하지 않다는 대조군).
  assert.equal(env[CANARY], undefined, "부모 env가 자식으로 새어 들어갔다");
  for (const secret of ["HOME", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "http_proxy", "NODE_OPTIONS"]) {
    assert.equal(env[secret], undefined, `${secret}가 자식에게 도착했다`);
  }
});

test("[M11/C-86] configDir 없이 부르면 프로세스를 띄우지 않는다(경계의 런타임 가드)", async () => {
  const ok = bin(EMIT('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  for (const bad of [undefined, "", "relative/path", 7]) {
    const code = await (async () => {
      try {
        const stream = startLivePlanTurn({ executable: ok, configDir: bad as string, configDirIdentity: { dev: 1, ino: 1 }, model: null, prompt: "x", binding: { ...BINDING }, timeoutMs: 30_000 });
        for await (const _ of stream) { /* 소진 */ }
        return "(통과)";
      } catch (e) {
        return e instanceof OrchestrationError ? e.code : String(e);
      }
    })();
    assert.equal(code, "worker_spawn_failed", `${String(bad)}가 통과했다`);
  }
});

test("[M11/C-86] 검증과 spawn 사이에 신원이 바뀌면 프로세스를 띄우지 않는다(TOCTOU 창 좁히기)", async () => {
  // **적대적 리뷰 B-2**: 이전 판은 kernel이 확보한 dev+ino를 버려서 `claude_config_identity_changed`가
  // 도달 불가한 죽은 코드였고, 골격 주석의 "spawn 직전 재확인"이 claude 갈래에서 거짓이었다.
  // 창을 0으로 만들지는 못하지만(`C-5`) **비동기 경계 중 교체**는 여기서 막힌다.
  const ok = bin(EMIT('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  const cfg = configDir();
  const stale = { dev: identityOf(cfg).dev, ino: identityOf(cfg).ino + 1 }; // 교체된 디렉터리와 등가
  const code = await (async () => {
    try {
      const stream = startLivePlanTurn({ executable: ok, configDir: cfg, configDirIdentity: stale, model: null, prompt: "x", binding: { ...BINDING }, timeoutMs: 30_000 });
      for await (const _ of stream) { /* 소진 */ }
      return "(통과)";
    } catch (e) {
      return e instanceof OrchestrationError ? e.code : String(e);
    }
  })();
  assert.equal(code, "claude_config_identity_changed", code);
  // 대조군: 같은 신원이면 지난다(검사가 무조건 거부가 아니다).
  assert.equal(await drain(ok), "started,progress,progress,terminal,");
});

// ── V3 M11 모델 축 — `--model`은 승인이 말할 때만 실린다 ────────────────────────

/** 자식이 받은 argv를 파일로 적고 고정 계획을 낸다. **argv를 재는 것이 이 절의 전부**다. */
function argvBin(out: string): string {
  return bin(
    `import { readFileSync, writeFileSync } from "node:fs";\nreadFileSync(0, "utf8");\n` +
      `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(JSON.stringify({ result: ${JSON.stringify('{"operations": [], "result": {"summary": "ok", "outputs": []}}')}, usage: null }));\n`,
  );
}

async function argvOf(model: string | null): Promise<string[]> {
  const out = join(realpathSync(mkdtempSync(join(tmpdir(), "m11-argv-"))), "argv.json");
  dirs.push(join(out, ".."));
  const cfg = configDir();
  const stream = startLivePlanTurn({
    executable: argvBin(out),
    configDir: cfg,
    configDirIdentity: identityOf(cfg),
    model,
    prompt: "x",
    binding: { ...BINDING },
    timeoutMs: 30_000,
  });
  for await (const _ of stream) { /* 소진 */ }
  return JSON.parse(readFileSync(out, "utf8")) as string[];
}

test("[M11/모델축] 승인이 모델을 말하면 그 값이 --model로 자식 argv에 도착한다", async () => {
  // **argv를 직접 잰다**: 타입·주석이 아니라 자식이 받은 인자가 이 축의 유일한 증거다.
  const argv = await argvOf("claude-opus-5[1m]");
  assert.deepEqual(argv.slice(-2), ["--model", "claude-opus-5[1m]"], JSON.stringify(argv));
  // 기존 인자는 **하나도 바뀌지 않는다**(각각 실측 근거가 있는 상수다 — 모델 축이 그것을 건드리지 않는다).
  assert.deepEqual(argv.slice(0, LIVE_WORKER_ARGS.length), [...LIVE_WORKER_ARGS], JSON.stringify(argv));
  assert.equal(argv.length, LIVE_WORKER_ARGS.length + 2);
});

test("[M11/모델축] 승인이 모델을 말하지 않으면 --model이 **아예 실리지 않는다**", async () => {
  // 조용한 기본값 주입 금지: 여기서 하네스가 모델을 골라 넣으면 영수증의 `cli_default`가 거짓이 된다.
  const argv = await argvOf(null);
  assert.deepEqual(argv, [...LIVE_WORKER_ARGS], JSON.stringify(argv));
  assert.equal(argv.includes("--model"), false, "승인이 말하지 않은 모델이 argv에 실렸다");
});

test("[M11/모델축] 형태 밖 모델 값은 프로세스를 띄우지 않는다(argv 경계 가드)", async () => {
  const ok = bin(EMIT('{"operations": [], "result": {"summary": "ok", "outputs": []}}'));
  const cfg = configDir();
  // `undefined`(배선 누락) · 빈 문자열 · flag처럼 읽히는 값 · 공백 포함 · 상한 초과 · 대문자 · 비문자열.
  for (const bad of [undefined, "", "--dangerously-skip-permissions", "-opus", "opus 5", "a".repeat(65), "Opus-5", 7]) {
    const code = await (async () => {
      try {
        const stream = startLivePlanTurn({
          executable: ok,
          configDir: cfg,
          configDirIdentity: identityOf(cfg),
          model: bad as string,
          prompt: "x",
          binding: { ...BINDING },
          timeoutMs: 30_000,
        });
        for await (const _ of stream) { /* 소진 */ }
        return "(통과)";
      } catch (e) {
        return e instanceof OrchestrationError ? e.code : String(e);
      }
    })();
    assert.equal(code, "worker_spawn_failed", `${String(bad)}가 통과했다`);
  }
  // 대조군: 형태를 만족하는 값은 지난다(가드가 무조건 거부가 아니다).
  assert.deepEqual((await argvOf("sonnet")).slice(-2), ["--model", "sonnet"]);
});

test("[M11/모델축] 형태 술어는 실제 모델 문자열을 받아들이고 주입 후보를 거부한다", () => {
  // 닫힌 enum을 **기각한** 대가로 이 표가 계약이다(근거는 `CLAUDE_MODEL_PATTERN` 주석).
  for (const good of ["opus", "sonnet", "haiku", "claude-opus-5", "claude-opus-5[1m]", "claude-sonnet-4-5-20250929", "anthropic.claude-opus-5"]) {
    assert.equal(isApprovedModelString(good), true, good);
  }
  for (const bad of ["", "-opus", "--model", "opus 5", "opus\n--tools", "OPUS", "opus;rm -rf /", "a".repeat(65), "opus[1m][2m]", null, 5]) {
    assert.equal(isApprovedModelString(bad), false, String(bad));
  }
});
