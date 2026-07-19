import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookSettings, buildHookEnv, shellQuote, SUPPORTED_HOOKS } from "./hookSettings.js";

const NODE = "/usr/bin/node";
const COLLECTOR = "/abs/dist/tools/hookCollector.js";

test("[M3b.1] settings에 6개 Hook 정확 등록", () => {
  const s = buildHookSettings({ nodePath: NODE, collectorPath: COLLECTOR });
  assert.deepEqual(Object.keys(s.hooks).sort(), [...SUPPORTED_HOOKS].sort());
  assert.equal(SUPPORTED_HOOKS.length, 6);
  for (const k of SUPPORTED_HOOKS) {
    assert.equal(s.hooks[k].length, 1);
    assert.equal(s.hooks[k][0].hooks[0].command, `'/usr/bin/node' '/abs/dist/tools/hookCollector.js' ${k}`);
  }
});

test("[M3b.1] shellQuote: 공백·작은따옴표 경로 안전", () => {
  assert.equal(shellQuote("/a b/c"), "'/a b/c'");
  assert.equal(shellQuote("/x/o'brien/c"), "'/x/o'\\''brien/c'");
  const s = buildHookSettings({ nodePath: "/no de/node", collectorPath: "/a'b/hook.js" });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.ok(cmd.startsWith("'/no de/node' '/a'\\''b/hook.js' PreToolUse"));
});

test("[M3b.1] denyMatchers[] — PreToolUse에 추가 + 중복 제거", () => {
  const s = buildHookSettings({ nodePath: NODE, collectorPath: COLLECTOR, denyMatchers: ["Bash", "Bash", "Write"] });
  // 기본 1 + deny 2(중복 제거)
  assert.equal(s.hooks.PreToolUse.length, 3);
  const denyMatchers = s.hooks.PreToolUse.filter((m) => m.hooks[0].command.endsWith("PreToolUse deny")).map((m) => m.matcher);
  assert.deepEqual(denyMatchers.sort(), ["Bash", "Write"]);
});

test("[M3b.1] settings/env에 secret 값 없음, secretRefs는 이름만", () => {
  const secret = "sk-live-SENTINEL";
  const prev = process.env.MY_SECRET;
  process.env.MY_SECRET = secret;
  try {
    const s = buildHookSettings({ nodePath: NODE, collectorPath: COLLECTOR });
    const env = buildHookEnv({ tracePath: "/t.jsonl", profileId: "p", secretRefs: ["MY_SECRET"], toolMap: { mcp__s__t: "s" } });
    const blob = JSON.stringify(s) + JSON.stringify(env);
    assert.ok(!blob.includes(secret), "secret 값 평문 부재");
    assert.equal(env.HARNESS_TOOL_SECRET_REFS, '["MY_SECRET"]', "이름만");
    assert.equal(env.HARNESS_TOOL_PROFILE_ID, "p");
  } finally {
    if (prev === undefined) delete process.env.MY_SECRET;
    else process.env.MY_SECRET = prev;
  }
});
