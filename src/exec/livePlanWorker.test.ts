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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestrationError } from "./orchestrationTypes.js";
import { extractPlanJson, readReportedUsage, startLivePlanTurn } from "./livePlanWorker.js";

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

async function drain(executable: string, timeoutMs = 30_000): Promise<string> {
  try {
    const stream = startLivePlanTurn({ executable, prompt: "x", binding: { ...BINDING }, timeoutMs });
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
