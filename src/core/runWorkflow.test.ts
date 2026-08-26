/**
 * [B-40] 아이디어 kill 게이트: CEO '폐기' 판정 → terminal 상태 "killed".
 * 한 기능이 runWorkflow(게이트 분기) · registry(GateDef.kill) · commands/run(종료 코드·안내)에 걸쳐 있어
 * 세 곳을 이 파일에서 함께 검증한다 (기존에 이 모듈들의 .test.ts가 없었다).
 * mock provider만 사용 — 실제 LLM 미호출(무과금). HARNESS_WORKSPACE는 test:core 스크립트가 지정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runWorkflow, loadRunState, type RunState } from "./runWorkflow.js";
import { loadWorkflows, isGate } from "./registry.js";
import { projectPaths } from "./project.js";
import { mockProvider } from "../providers/mockProvider.js";
import { runRun } from "../commands/run.js";
import type { Provider, AgentRunInput, AgentResult } from "../providers/provider.js";
import type { RunEvent } from "./progress.js";

const FIXED = "2026-01-01T00:00:00.000Z";

function makeProject(name: string): void {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트\n", "utf8");
}

/**
 * founder_ceo의 "## Main Judgment"에 판정 문구를 심는 mock 래퍼 (그 외 agent는 mock 원본 그대로).
 * extractDecision은 Main Judgment + Decisions만 보므로 게이트가 실제로 읽는 자리에 넣는다.
 */
function ceoDeciding(judgment: string): Provider {
  return {
    id: "mock",
    async generate(input: AgentRunInput): Promise<AgentResult> {
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== "founder_ceo") return r;
      const markdown = r.markdown.replace("## Main Judgment\n", `## Main Judgment\n\n- ${judgment}\n`);
      assert.notEqual(markdown, r.markdown, "Main Judgment 주입 실패 — mock 출력 형식이 바뀌었다");
      return { ...r, markdown };
    },
  };
}

function collectingReporter(): { events: RunEvent[]; reporter: { emit(e: RunEvent): void } } {
  const events: RunEvent[] = [];
  return { events, reporter: { emit: (e) => void events.push(e) } };
}

function timingsFor(state: RunState, agentId: string): number {
  return state.step_timings.filter((t) => t.agent_id === agentId && t.kind === "agent").length;
}

/** console.log/error를 모아 문자열로 반환한다 (runRun은 직접 console에 쓴다). */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const push = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  const [log, err] = [console.log, console.error];
  console.log = push;
  console.error = push;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return out.join("\n");
}

// ── kill 판정 ────────────────────────────────────────────────
test("[B-40] gate kill 매칭 → status=killed · killed_by 기록 · 후속 step 미실행", async () => {
  const name = "_b40_kill";
  makeProject(name);
  const { events, reporter } = collectingReporter();
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("시장성·사업성 미달 — 폐기한다."),
    now: () => FIXED,
    reporter,
  });
  const s = r.state;

  assert.equal(s.status, "killed", "kill 키워드 매칭 → terminal 상태 killed (failed 아님)");
  assert.deepEqual(s.killed_by, { decider: "founder_ceo", decision: "폐기" }, "killed_by에 누가 무슨 판정으로 죽였는지 기록");
  assert.equal(s.failed_agent, null, "폐기는 agent 실패가 아니다");
  assert.equal(s.failed_reason, null, "kill 사유는 failed_reason에 넣지 않는다");
  assert.equal(s.resume_from, null, "killed는 재개 불가 → resume_from null");
  assert.equal(s.loop_state, null);
  assert.deepEqual(
    s.gate_jumps,
    [{ decider: "founder_ceo", decision: "폐기", jumped_to: null, killed: true }],
    "gate_jumps에 kill 판정도 남는다 (killed 플래그로 '미매칭 진행'과 구별)",
  );
  assert.deepEqual(s.completed_steps, ["chief_of_staff", "research", "pm", "red_team", "founder_ceo"]);
  // 후속 step 미실행: 게이트가 마지막 타이밍이고, 각 agent는 정확히 1회만 돌았다 (되돌림 재실행도 없음).
  assert.equal(s.step_timings.at(-1)?.kind, "gate", "게이트 이후 실행된 step 없음");
  assert.equal(s.step_timings.length, 6, "5 agent + 1 gate — 그 이상 실행되지 않았다");
  for (const a of s.completed_steps) assert.equal(timingsFor(s, a), 1, `${a} 1회만 실행`);
  // 디스크에도 killed로 남는다 (resume/handoff/summary가 읽는 값).
  assert.equal(loadRunState(name)?.status, "killed");
  const end = events.find((e) => e.type === "run_end");
  assert.equal(end?.type === "run_end" ? end.status : null, "killed", "run_end 이벤트도 killed를 전달");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[B-40] kill과 on 키워드가 둘 다 있으면 kill이 이긴다 (되돌림 없음)", async () => {
  const name = "_b40_both";
  makeProject(name);
  const { events, reporter } = collectingReporter();
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("범위 축소로도 회수 불가 — 폐기한다. (축소·검증 안 모두 기각)"),
    now: () => FIXED,
    reporter,
  });
  const s = r.state;

  assert.equal(s.status, "killed", "kill이 jump보다 먼저 판정된다");
  assert.equal(s.killed_by?.decision, "폐기");
  assert.equal(s.gate_jumps.length, 1, "게이트 1회 — 되돌림으로 다시 오지 않았다");
  assert.equal(s.gate_jumps[0].jumped_to, null, "kill이면 되돌림 대상 없음");
  assert.equal(s.gate_jumps[0].killed, true);
  assert.equal(timingsFor(s, "pm"), 1, "pm이 되돌림으로 재실행되지 않았다 (kill 우선)");
  assert.equal(events.some((e) => e.type === "gate_jump"), false, "gate_jump 이벤트 미방출");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[B-40] 회귀: kill 없이 on만 매칭되면 기존 되돌림 동작 그대로", async () => {
  const name = "_b40_jump";
  makeProject(name);
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("범위 축소가 필요하다."),
    now: () => FIXED,
  });
  const s = r.state;

  assert.equal(s.status, "completed", "축소 판정은 되돌림 후 완주 — kill 아님");
  assert.equal(s.killed_by, null);
  assert.equal(s.gate_jumps.length, 2, "1회 되돌림 + 예산 소진 후 진행");
  assert.deepEqual(s.gate_jumps[0], { decider: "founder_ceo", decision: "축소", jumped_to: "pm" });
  assert.deepEqual(s.gate_jumps[1], { decider: "founder_ceo", decision: "축소", jumped_to: null });
  assert.equal(timingsFor(s, "pm"), 2, "pm이 되돌림으로 1회 재실행");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

// ── killed는 재개 불가 ────────────────────────────────────────
test("[B-40] killed run은 --resume 거부 (status !== failed)", async () => {
  const name = "_b40_resume";
  makeProject(name);
  const kill = ceoDeciding("폐기한다.");
  const first = await runWorkflow({ workflowId: "idea-validation", project: name, provider: kill, now: () => FIXED });
  assert.equal(first.state.status, "killed");

  await assert.rejects(
    runWorkflow({ workflowId: "idea-validation", project: name, provider: kill, resume: true, now: () => FIXED }),
    /재개할 실패 상태가 아닙니다 \(status=killed\)/,
    "killed는 실패가 아니므로 재개 대상이 아니다",
  );
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

// ── run 커맨드: 종료 코드·안내 ─────────────────────────────────
test("[B-40] harness run: killed는 exit 0 + 새 run 안내 · handoff 미실행", async () => {
  const name = "_b40_cmd";
  makeProject(name);
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const handoffCalls: unknown[] = [];
  const out = await captureLogs(() =>
    runRun(
      "idea-validation", name, "mock", 1, false, undefined, false, 0, true, undefined, false,
      true, // --handoff 요청했더라도 killed면 넘기지 않는다
      undefined, undefined,
      async (o) => void handoffCalls.push(o),
      ceoDeciding("시장성 미달 — 폐기한다."),
    ),
  );

  assert.ok(!process.exitCode, `killed는 정상 종료 코드(판정 자체는 성공한 작업) — 실제: ${process.exitCode}`);
  process.exitCode = prevExit;
  assert.equal(handoffCalls.length, 0, "폐기된 아이디어를 개발 착수 handoff로 넘기지 않는다");
  assert.match(out, /폐기 판정: founder_ceo가 '폐기' 판정/, "어느 decider가 무슨 판정으로 죽였는지 출력");
  assert.match(out, /아이디어를 고쳐 새 run으로 시작/);
  assert.match(out, /게이트: founder_ceo 판정 '폐기' → 폐기 — run 종료/);
  assert.doesNotMatch(out, /--resume$/m, "killed에 resume 안내를 하지 않는다");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

test("[B-40] harness run --resume: killed는 completed와 동급 — 덮어쓰기 없이 안내", async () => {
  const name = "_b40_cmd_resume";
  makeProject(name);
  await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("폐기한다."), now: () => FIXED });
  const before = JSON.stringify(loadRunState(name));

  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = await captureLogs(() => runRun("idea-validation", name, "mock", 1, false, undefined, true));
  assert.ok(!process.exitCode, `재개 대상 아님 안내는 정상 종료 — 실제: ${process.exitCode}`);
  process.exitCode = prevExit;
  assert.match(out, /재개할 것이 없습니다/);
  assert.match(out, /status=killed/);
  assert.equal(JSON.stringify(loadRunState(name)), before, "run_state를 덮어쓰지 않는다");
  rmSync(projectPaths(name).root, { recursive: true, force: true });
});

// ── registry 로더 ────────────────────────────────────────────
test("[B-40] workflows.json: kill 필드 로드 + 모든 gate의 on 타깃이 같은 workflow의 step에 존재", () => {
  const wfs = loadWorkflows();
  const killGates = new Map<string, string[]>();
  for (const wf of wfs) {
    for (const step of wf.steps) {
      if (!isGate(step)) continue;
      const { decider, on, kill } = step.gate;
      assert.ok(
        wf.steps.includes(decider),
        `${wf.workflow_id}: gate decider '${decider}'가 step 목록에 없다`,
      );
      for (const target of Object.values(on)) {
        assert.ok(
          wf.steps.includes(target),
          `${wf.workflow_id}: gate 되돌림 대상 '${target}'이 이 workflow의 step에 없다 (문서 밖으로 jump 금지)`,
        );
      }
      if (kill) killGates.set(wf.workflow_id, kill);
    }
  }
  assert.deepEqual(
    [...killGates.entries()].sort(),
    [
      ["full-predev", ["폐기"]],
      ["idea-validation", ["폐기"]],
      ["mvp-planning", ["폐기"]],
    ],
    "세 workflow가 kill 게이트를 갖고, 로더가 kill 필드를 통과시킨다",
  );
  // dev-preflight에는 게이트가 없다 — 기존 정의 불변 확인
  assert.equal(wfs.find((w) => w.workflow_id === "dev-preflight")?.steps.some(isGate), false);
});
