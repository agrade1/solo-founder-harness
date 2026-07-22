import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeArgs } from "./claudeCodeProvider.js";
import { loadToolProfiles, compileToolProfile } from "../tools/profiles.js";

test("buildClaudeArgs: policy 미지정 시 기존 base 동작 (회귀 없음)", () => {
  assert.deepEqual(buildClaudeArgs([], undefined), ["-p", "--output-format", "json"]);
  assert.deepEqual(buildClaudeArgs([], "opus"), ["-p", "--output-format", "json", "--model", "opus"]);
});

test("buildClaudeArgs: compiled policy argv를 base 뒤에 병합", () => {
  const p = loadToolProfiles().get("planning-local-readonly")!;
  const c = compileToolProfile(p, { bare: true });
  const argv = buildClaudeArgs(c.claudeArgs, undefined);
  assert.deepEqual(argv.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.ok(argv.includes("--strict-mcp-config"));
  const ti = argv.indexOf("--tools");
  assert.equal(argv[ti + 1], "Read,Glob,Grep");
});
