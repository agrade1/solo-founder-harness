/** V3 M7 T2 — EvidenceItem 저장 계약 테스트. 저장 응답은 파일, 중앙은 포인터. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceError, MAX_RAW_BYTES, MAX_SUMMARY_CHARS, storeEvidence } from "./evidenceStore.js";

const RAW = "외부에서 들여온 원문 본문 — SECRET_MARKER_ORIGINAL_TEXT";
const INPUT = {
  source: "https://example.com/a",
  retrievedAt: "2026-08-12T00:00:00.000Z",
  raw: RAW,
  title: "제목",
  summary: "모델에 전달되는 축약본",
};

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("원문은 content-addressed 파일로만 남고 item은 포인터만 운반한다", () => {
  withDir((dir) => {
    const item = storeEvidence(dir, INPUT);
    assert.equal(readFileSync(join(dir, item.rawPath), "utf8"), RAW);
    // 중앙·프롬프트가 운반하는 형태에 원문이 실리면 red.
    assert.ok(!JSON.stringify(item).includes("SECRET_MARKER_ORIGINAL_TEXT"));
    assert.ok(!readFileSync(join(dir, "evidence.jsonl"), "utf8").includes("SECRET_MARKER_ORIGINAL_TEXT"));
    assert.equal(item.rawPath, join("raw", `${item.sha256}.txt`));
    assert.equal(item.bytes, Buffer.byteLength(RAW, "utf8"));
  });
});

test("같은 입력 → 같은 바이트(결정성) · 원문은 덮어쓰지 않는다", () => {
  withDir((dir) => {
    const a = storeEvidence(dir, INPUT);
    const before = statSync(join(dir, a.rawPath)).ino;
    const b = storeEvidence(dir, INPUT);
    assert.deepEqual(a, b);
    assert.equal(statSync(join(dir, b.rawPath)).ino, before);
  });
});

test("요약은 상한에서 절삭되고 원문 상한 초과는 fail-closed", () => {
  withDir((dir) => {
    const item = storeEvidence(dir, { ...INPUT, summary: "가".repeat(MAX_SUMMARY_CHARS + 50) });
    assert.equal([...item.summary].length, MAX_SUMMARY_CHARS);
    assert.throws(
      () => storeEvidence(dir, { ...INPUT, raw: "x".repeat(MAX_RAW_BYTES + 1) }),
      (e: EvidenceError) => e.code === "raw_too_large",
    );
  });
});

test("https 아닌 source는 거부한다", () => {
  withDir((dir) => {
    for (const source of ["http://example.com/a", "file:///etc/passwd", "not a url"]) {
      assert.throws(
        () => storeEvidence(dir, { ...INPUT, source }),
        (e: EvidenceError) => e.code === "invalid_source",
      );
    }
  });
});
