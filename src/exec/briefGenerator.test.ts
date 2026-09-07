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

test("[C-155] 스칼라 deps는 조용히 '의존성 없음'이 되지 않는다", () => {
  // red: `asStrings`가 배열이 아니면 undefined를 반환하면 `deps: "t1"`이 **의존성 없음**이 되고
  //      스케줄러 둘(mission.ts의 `task.deps?.some` · parallelMission.ts의 `(t.deps ?? []).every`)이
  //      **선행 완료 전에 실행**한다. 병렬 모드에선 자동 병합까지 간다.
  assert.throws(() => parseTasks('[{"id":"a","role":"r","task":"t"},{"id":"b","role":"r","task":"t","deps":"a"}]'), /deps/);
});

test("[C-155] 배열 안의 비-문자열 원소도 조용히 버리지 않는다", () => {
  // 원소 하나가 사라지면 그 선행이 없어진 것과 같다 — 형태 오류를 무음으로 처리하지 않는다.
  assert.throws(() => parseTasks('[{"id":"a","role":"r","task":"t"},{"id":"b","role":"r","task":"t","deps":["a",7]}]'), /deps/);
  assert.throws(() => parseTasks('[{"id":"a","role":"r","task":"t","ownership":["src",null]}]'), /ownership/);
});

test("[C-155] 없는 id를 가리키는 deps는 파싱에서 막는다 — 전부 dep_unmet으로 조용히 미루지 않는다", () => {
  // 스케줄러는 이미 fail closed다(미지 id는 영원히 미충족 → dep_unmet). 그래서 **일찍 실행되지는**
  // 않지만, 오타 하나가 mission 전체를 말없이 보류로 만든다. 파싱에서 이름을 대고 멈춘다.
  assert.throws(() => parseTasks('[{"id":"a","role":"r","task":"t","deps":["없는것"]}]'), /없는것/);
});

test("[C-155] 정상 deps·ownership·dod는 그대로 통과한다 (과차단 없음)", () => {
  const tasks = parseTasks('[{"id":"a","role":"r","task":"t","ownership":["src"],"dod":["ok"]},{"id":"b","role":"r","task":"t","deps":["a"]}]');
  assert.deepEqual(tasks[1].deps, ["a"]);
  assert.deepEqual(tasks[0].ownership, ["src"]);
  assert.equal(tasks[1].ownership, undefined, "없는 필드는 여전히 undefined다");
});

test("parseTasks: 깨진 JSON이면 throw", () => {
  assert.throws(() => parseTasks("not json at all"), /파싱 실패/);
});

test("generateBrief: mock 플래너 → 브리프", async () => {
  const script: EventScript = (spec): SessionEvent[] => {
    const raw = { type: "mock", session_id: spec.sessionId };
    const md = '```json\n[{"id":"t1","role":"BE","task":"API","dod":["테스트"]},{"id":"t2","role":"FE","task":"화면","deps":["t1"]}]\n```';
    return [
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], mcpServers: [], raw },
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
      { kind: "init", sessionId: spec.sessionId, model: "opus", cwd: spec.cwd, permissionMode: "plan", tools: [], mcpServers: [], raw },
      { kind: "result", sessionId: spec.sessionId, isError: false, text: `[${many}]`, numTurns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, totalCostUsd: 0, permissionDenials: [], raw },
    ];
  };
  const g = await generateBrief({ goal: "g", provider: new MockExecProvider(script), sessionId: "p", cwd: "/tmp", maxTasks: 3 });
  assert.equal(g.brief.tasks.length, 3);
});
