/**
 * 브리프 생성기 테스트 (무과금). parseTasks 순수 검증 + mock provider generateBrief.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTasks, generateBrief } from "./briefGenerator.js";
import { MockExecProvider, type EventScript } from "./mockExecProvider.js";
import type { SessionEvent } from "./types.js";

test("parseTasks: json 코드펜스에서 태스크 추출", () => {
  const raw = "설명...\n```json\n[{\"id\":\"a\",\"role\":\"FE\",\"task\":\"화면\",\"dod\":[\"렌더\"],\"difficulty\":\"simple\"}]\n```\n끝";
  const tasks = parseTasks(raw);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "a");
  assert.equal(tasks[0].difficulty, "simple");
  assert.deepEqual(tasks[0].dod, ["렌더"]);
});

test("parseTasks: 펜스 없이 배열만 있어도 추출", () => {
  const tasks = parseTasks('[{"id":"x","role":"r","task":"t"}]');
  assert.equal(tasks[0].id, "x");
});

test("parseTasks: 필수 필드 누락 시 throw", () => {
  assert.throws(() => parseTasks('[{"role":"r","task":"t"}]'), /필수 필드/);
});

test("parseTasks: 깨진 JSON이면 throw", () => {
  assert.throws(() => parseTasks("not json at all"), /파싱 실패/);
});

test("generateBrief: mock 플래너 → 브리프", async () => {
  const script: EventScript = (spec): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    const md = '```json\n[{"id":"t1","role":"BE","task":"API","dod":["테스트"]},{"id":"t2","role":"FE","task":"화면","deps":["t1"]}]\n```';
    return [
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: md, numTurns: 1, usage: { inputTokens: 7, outputTokens: 4, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  const g = await generateBrief({ goal: "앱 만들기", provider: new MockExecProvider(script), sessionId: "plan1", cwd: "/tmp" });
  assert.equal(g.brief.goal, "앱 만들기");
  assert.equal(g.brief.tasks.length, 2);
  assert.deepEqual(g.brief.tasks[1].deps, ["t1"]);
  assert.equal(g.usage?.inputTokens, 7);
});

test("generateBrief: maxTasks로 잘림", async () => {
  const script: EventScript = (spec): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    const many = Array.from({ length: 5 }, (_, i) => `{"id":"t${i}","role":"r","task":"x"}`).join(",");
    return [
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: `[${many}]`, numTurns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  const g = await generateBrief({ goal: "g", provider: new MockExecProvider(script), sessionId: "p", cwd: "/tmp", maxTasks: 3 });
  assert.equal(g.brief.tasks.length, 3);
});
