/**
 * L1 기계 게이트 테스트. true/false 명령으로 통과·실패를 흉내(무과금·빠름).
 * 실행: `npm run test:exec`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachineGate, defaultChecks } from "./machineGate.js";

const OK = { name: "ok", command: "true", args: [] as string[] };
const FAIL = { name: "fail", command: "false", args: [] as string[] };

test("모든 체크 통과 → passed", async () => {
  const r = await runMachineGate({ cwd: process.cwd(), checks: [OK, { ...OK, name: "ok2" }] });
  assert.equal(r.passed, true);
  assert.equal(r.checks.length, 2);
  assert.ok(r.checks.every((c) => c.ok && !c.skipped));
});

test("하나라도 실패 → passed=false, 해당 체크 ok=false", async () => {
  const r = await runMachineGate({ cwd: process.cwd(), checks: [OK, FAIL] });
  assert.equal(r.passed, false);
  const fail = r.checks.find((c) => c.name === "fail");
  assert.equal(fail!.ok, false);
  assert.equal(fail!.exitCode, 1);
});

test("체크 없음 → passed=true (막을 근거 없음)", async () => {
  const r = await runMachineGate({ cwd: process.cwd(), checks: [] });
  assert.equal(r.passed, true);
  assert.deepEqual(r.checks, []);
});

test("spawn 실패(없는 명령) → 실패 처리(throw 아님)", async () => {
  const r = await runMachineGate({ cwd: process.cwd(), checks: [{ name: "nope", command: "definitely-not-a-real-bin-xyz", args: [] }] });
  assert.equal(r.passed, false);
  assert.equal(r.checks[0].ok, false);
});

test("defaultChecks: package.json scripts에 있는 표준 체크만 구성", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-gate-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "tsc", other: "x" } }));
    const checks = defaultChecks(dir);
    const names = checks.map((c) => c.name);
    assert.deepEqual(names, ["typecheck", "build"]); // lint/test 없음 → 제외, other는 표준 아님
    assert.deepEqual(checks[0].args, ["run", "typecheck", "--silent"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultChecks: package.json 없으면 빈 배열", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-gate-"));
  try {
    assert.deepEqual(defaultChecks(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
