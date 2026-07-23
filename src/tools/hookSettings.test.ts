import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookSettings, buildHookEnv, shellQuote, SUPPORTED_HOOKS } from "./hookSettings.js";

const NODE = "/usr/bin/node";
const COLLECTOR = "/abs/dist/tools/hookCollector.js";

test("[M3b.2] settings에 6개 Hook 정확 등록 (공식 exec form: command=node, args=[collector, kind])", () => {
  const s = buildHookSettings({ nodePath: NODE, collectorPath: COLLECTOR });
  assert.deepEqual(Object.keys(s.hooks).sort(), [...SUPPORTED_HOOKS].sort());
  assert.equal(SUPPORTED_HOOKS.length, 6);
  for (const k of SUPPORTED_HOOKS) {
    assert.equal(s.hooks[k].length, 1);
    const hc = s.hooks[k][0].hooks[0];
    assert.equal(hc.type, "command");
    assert.equal(hc.command, NODE); // shell 문자열 조합 없이 node 실행 파일 그대로
    assert.deepEqual(hc.args, [COLLECTOR, k]); // argv[2]=hookKind → collector parseArgs와 정합
  }
});

test("[M3b.2] exec form: 공백·따옴표 경로도 그대로(이스케이프 불필요), shellQuote는 별도 유지", () => {
  // exec form은 shell 미경유라 경로를 원문 그대로 담는다.
  const s = buildHookSettings({ nodePath: "/no de/node", collectorPath: "/a'b/hook.js" });
  const hc = s.hooks.PreToolUse[0].hooks[0];
  assert.equal(hc.command, "/no de/node");
  assert.deepEqual(hc.args, ["/a'b/hook.js", "PreToolUse"]);
  // shellQuote는 재진입 명령 등 shell 문자열 조립용으로 계속 유효.
  assert.equal(shellQuote("/a b/c"), "'/a b/c'");
  assert.equal(shellQuote("/x/o'brien/c"), "'/x/o'\\''brien/c'");
});

test("[M3b.2] denyMatchers[] — PreToolUse에 추가 + 중복 제거 (args 마지막 'deny')", () => {
  const s = buildHookSettings({ nodePath: NODE, collectorPath: COLLECTOR, denyMatchers: ["Bash", "Bash", "Write"] });
  // 기본 1 + deny 2(중복 제거)
  assert.equal(s.hooks.PreToolUse.length, 3);
  const denyEntries = s.hooks.PreToolUse.filter((m) => m.hooks[0].args[m.hooks[0].args.length - 1] === "deny");
  assert.deepEqual(denyEntries.map((m) => m.matcher).sort(), ["Bash", "Write"]);
  for (const e of denyEntries) assert.deepEqual(e.hooks[0].args, [COLLECTOR, "PreToolUse", "deny"]);
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
