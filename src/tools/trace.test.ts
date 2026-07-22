/**
 * 범용 JSONL writer 골격 테스트 (무의존, node:test).
 * M1: tool_start/tool_end/tool_denied "형태"의 레코드를 write→read 왕복 검증.
 * (실제 ToolTrace 스키마 고정·runWorkflow 배선은 M3 이후 — 여기선 임의 레코드로만 확인.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlWriter } from "./trace.js";

test("createJsonlWriter: 레코드를 JSONL 한 줄씩 append하고 왕복 파싱된다", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-trace-"));
  try {
    const path = join(dir, "nested", "run-1.jsonl"); // 상위 디렉터리 자동 생성 확인
    const w = createJsonlWriter(path);

    const records = [
      { type: "tool_start", server: "s1", tool: "search", callId: "c1" },
      { type: "tool_end", callId: "c1", ok: true, elapsedMs: 12, resultBytes: 345 },
      { type: "tool_denied", server: "s1", tool: "write", reason: "read_only profile" },
    ];
    for (const r of records) w.append(r);
    w.close();

    assert.equal(w.count(), 3);
    assert.ok(existsSync(path), "파일 생성됨");

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 3, "3줄");
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed, records, "왕복 파싱이 원본과 동일");
    // 각 줄이 독립적으로 유효한 JSON (JSONL 계약)
    assert.equal(parsed[0].type, "tool_start");
    assert.equal(parsed[1].callId, "c1");
    assert.equal(parsed[2].reason, "read_only profile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createJsonlWriter: 같은 파일에 이어서 append하면 누적된다", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-trace-"));
  try {
    const path = join(dir, "run.jsonl");
    const w1 = createJsonlWriter(path);
    w1.append({ n: 1 });
    w1.close();
    const w2 = createJsonlWriter(path); // 기존 파일에 이어쓰기
    w2.append({ n: 2 });
    w2.close();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.deepEqual(
      lines.map((l) => JSON.parse(l)),
      [{ n: 1 }, { n: 2 }],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
