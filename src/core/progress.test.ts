/**
 * 진행 이벤트(RunEvent) 시퀀스 + 렌더러 계약 테스트 (무의존, node:test).
 *
 * HARNESS_WORKSPACE는 npm script(test:core)가 .tmp-test-workspace로 지정한다 —
 * 모듈 로드 시점에 읽히므로(paths.ts) 스크립트 레벨에서 설정해야 정적 import가 안전하다.
 *
 * 동작별로 fixture(workflow)를 분리한다:
 *  - 기본 순차: idea-validation
 *  - critique/revise: mvp-planning (red_team이 Critical 방출)
 *  - 실제 gate jump: full-predev (founder_ceo가 '축소' 판정)
 *  - 실패 Provider / resume: idea-validation + 예외 provider
 *  - TTY/non-TTY 렌더러: createProgressReporter 직접 구동
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runWorkflow } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import type { RunEvent } from "./progress.js";
import type { Provider, AgentRunInput, AgentResult } from "../providers/provider.js";
import { createProgressReporter } from "../commands/progress.js";

// ── fixture provider ────────────────────────────────────────────
// 모든 agent의 필수 헤더를 포함하는 superset markdown → 검증 통과(재생성 잡음 없음).
const EXTRA_HEADERS = [
  // pm
  "문제 정의", "목표와 성공 지표", "사용자와 시나리오", "기능 요구사항",
  "비범위 (Out of Scope)", "제약과 가정", "오픈 퀘스천",
  // design
  "디자인 방향", "디자인 토큰 개요", "컴포넌트 인벤토리", "레이아웃 규칙", "인터랙션 원칙",
  "접근성 기준", "비시각 가이드", "시안 검증 절차", "디자인 토큰",
  // tech_lead
  "아키텍처 개요", "기술 스택과 선정 근거", "데이터 모델", "API 계약", "구현 순서",
  "리스크와 완화책", "비기능 요구사항",
];

function doc(input: AgentRunInput, o: { critical?: boolean; decision?: string }): string {
  const criticalBlock = o.critical ? "- [scripted] 치명적 리스크" : "- (없음)";
  const judgment = o.decision
    ? `- [scripted] 판정: 이 방향은 '${o.decision}'(으)로 처리한다.`
    : `- [scripted] ${input.agent.name} 판단`;
  const extra = EXTRA_HEADERS.map((h) => `## ${h}\n\n- [scripted] ${h}\n`).join("\n");
  return `# Agent Output

## Metadata

- agent_id: ${input.agent.agent_id}

## Input Summary

- scripted

## Main Judgment

${judgment}

## Decisions

- [scripted] 결정

## Risks

### Critical

${criticalBlock}

### High

- [scripted] high

## Recommended Next Actions

1. [scripted] 다음 작업

## Next Agent

- ${input.nextAgentId ?? "(없음)"}

${extra}
`;
}

function makeProvider(
  opts: { failOn?: Set<string>; decisionFor?: Record<string, string>; criticalFor?: Set<string> } = {},
): Provider {
  return {
    id: "scripted",
    async generate(input: AgentRunInput): Promise<AgentResult> {
      const id = input.agent.agent_id;
      if (opts.failOn?.has(id)) throw new Error(`scripted fail: ${id}`);
      return {
        markdown: doc(input, { critical: opts.criticalFor?.has(id), decision: opts.decisionFor?.[id] }),
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

function makeProject(name: string): void {
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트 아이디어\n", "utf8");
}

function recorder(): { events: RunEvent[]; reporter: { emit(e: RunEvent): void } } {
  const events: RunEvent[] = [];
  return { events, reporter: { emit: (e) => events.push(e) } };
}

const starts = (evs: RunEvent[]) => evs.filter((e): e is Extract<RunEvent, { type: "step_start" }> => e.type === "step_start");
const ends = (evs: RunEvent[]) => evs.filter((e): e is Extract<RunEvent, { type: "step_end" }> => e.type === "step_end");

// ── 1. 기본 순차 workflow ───────────────────────────────────────
test("이벤트 순서: 순차 workflow는 run_start → (step_start/end)×N → run_end", async () => {
  makeProject("_t_seq");
  const { events, reporter } = recorder();
  const r = await runWorkflow({ workflowId: "idea-validation", project: "_t_seq", provider: makeProvider(), reporter });

  assert.equal(events[0].type, "run_start");
  assert.equal(events[events.length - 1].type, "run_end");
  const first = events[0] as Extract<RunEvent, { type: "run_start" }>;
  assert.equal(first.workflow, "idea-validation");
  assert.equal(first.totalSteps, 5);
  assert.equal(first.resumeFrom, undefined, "fresh run은 resumeFrom 없음");

  const last = events[events.length - 1] as Extract<RunEvent, { type: "run_end" }>;
  assert.equal(last.status, "completed");

  const order = starts(events).map((e) => e.agentId);
  assert.deepEqual(order, ["chief_of_staff", "research", "pm", "red_team", "founder_ceo"]);
  assert.ok(starts(events).every((e) => e.kind === "agent"), "모두 agent kind");
  // index는 1-based, total 고정
  assert.deepEqual(starts(events).map((e) => e.index), [1, 2, 3, 4, 5]);
  assert.ok(starts(events).every((e) => e.total === 5));
  // 각 step_start 뒤에 같은 agent의 step_end(ok)
  assert.equal(ends(events).length, 5);
  assert.ok(ends(events).every((e) => e.ok === true));

  // step_timings 저장 (agent_id/kind/started_at/elapsed_ms/ok)
  assert.equal(r.state.step_timings.length, 5);
  for (const t of r.state.step_timings) {
    assert.equal(t.kind, "agent");
    assert.equal(t.ok, true);
    assert.equal(typeof t.started_at, "string");
    assert.equal(typeof t.elapsed_ms, "number");
  }
});

// ── 2. critique / revise workflow ──────────────────────────────
test("이벤트: critique_loop은 critic/revise kind와 round를 구분한다", async () => {
  makeProject("_t_crit");
  const { events, reporter } = recorder();
  const r = await runWorkflow({
    workflowId: "mvp-planning",
    project: "_t_crit",
    provider: makeProvider({ criticalFor: new Set(["red_team"]) }), // 항상 Critical → revise 발동
    reporter,
    approve: async () => true, // 디자인 승인 게이트 자동 통과
  });

  const critics = starts(events).filter((e) => e.kind === "critic");
  const revises = starts(events).filter((e) => e.kind === "revise");
  // max_rounds=2, 항상 Critical: R1 critic→revise, R2 critic(라운드 소진)
  assert.deepEqual(critics.map((e) => e.round), [1, 2], "critic 라운드 1,2");
  assert.deepEqual(revises.map((e) => e.round), [1], "revise 라운드 1");
  assert.ok(critics.every((e) => e.agentId === "red_team"));
  assert.ok(revises.every((e) => e.agentId === "tech_lead"));

  // approval step 이벤트 존재
  assert.ok(starts(events).some((e) => e.kind === "approval"), "approval step_start");
  assert.ok(ends(events).some((e) => e.kind === "approval"), "approval step_end");
  // gate_jump 없음 (mvp-planning엔 gate 없음)
  assert.ok(!events.some((e) => e.type === "gate_jump"));
  assert.equal((events[events.length - 1] as Extract<RunEvent, { type: "run_end" }>).status, "completed");

  // step_timings에 critic/revise/approval kind가 모두 남음
  const kinds = new Set(r.state.step_timings.map((t) => t.kind));
  for (const k of ["agent", "critic", "revise", "approval"]) assert.ok(kinds.has(k), `${k} 타이밍 존재`);
});

// ── 3. 실제 gate jump workflow ─────────────────────────────────
test("이벤트: 실제 jump가 발생할 때만 gate_jump를 방출한다", async () => {
  makeProject("_t_gate");
  const { events, reporter } = recorder();
  const r = await runWorkflow({
    workflowId: "full-predev",
    project: "_t_gate",
    provider: makeProvider({ decisionFor: { founder_ceo: "축소" } }), // CEO가 '축소' → pm으로 되돌림
    reporter,
    approve: async () => true,
  });

  const jumps = events.filter((e): e is Extract<RunEvent, { type: "gate_jump" }> => e.type === "gate_jump");
  assert.equal(jumps.length, 1, "max_jumps=1 → 정확히 1회");
  assert.deepEqual(jumps[0], { type: "gate_jump", decider: "founder_ceo", decision: "축소", target: "pm" });

  // gate step도 step_start/end를 가진다 (kind gate)
  assert.ok(starts(events).some((e) => e.kind === "gate"), "gate step_start");
  assert.ok(ends(events).some((e) => e.kind === "gate"), "gate step_end");
  assert.equal((events[events.length - 1] as Extract<RunEvent, { type: "run_end" }>).status, "completed");
  assert.ok(r.state.step_timings.some((t) => t.kind === "gate"));
});

// ── 4. 실패 Provider + 5. resume ───────────────────────────────
test("이벤트: provider 예외 → step_end{ok:false} + run_end{failed}, resume는 resumeFrom을 담는다", async () => {
  makeProject("_t_fail");

  // run 1: pm에서 예외
  const { events: e1, reporter: r1 } = recorder();
  const run1 = await runWorkflow({
    workflowId: "idea-validation",
    project: "_t_fail",
    provider: makeProvider({ failOn: new Set(["pm"]) }),
    reporter: r1,
  });

  const pmEnd = ends(e1).find((e) => e.agentId === "pm");
  assert.ok(pmEnd, "pm step_end 방출됨(예외에도)");
  assert.equal(pmEnd!.ok, false, "예외 step은 ok:false");
  assert.ok(ends(e1).find((e) => e.agentId === "research")?.ok === true, "이전 step은 ok:true");
  const end1 = e1[e1.length - 1] as Extract<RunEvent, { type: "run_end" }>;
  assert.equal(end1.type, "run_end");
  assert.equal(end1.status, "failed");
  assert.equal(run1.state.status, "failed");
  assert.equal(run1.state.failed_agent, "pm");
  assert.equal(run1.state.resume_from, 2, "pm은 idea-validation index 2");
  assert.ok(run1.state.step_timings.some((t) => t.agent_id === "pm" && t.ok === false));
  // founder_ceo는 실행 안 됨
  assert.ok(!starts(e1).some((e) => e.agentId === "founder_ceo"));

  // run 2: resume (정상 provider)
  const { events: e2, reporter: r2 } = recorder();
  const run2 = await runWorkflow({
    workflowId: "idea-validation",
    project: "_t_fail",
    provider: makeProvider(),
    reporter: r2,
    resume: true,
  });
  const start2 = e2[0] as Extract<RunEvent, { type: "run_start" }>;
  assert.equal(start2.type, "run_start");
  assert.equal(start2.resumeFrom, 2, "run_start.resumeFrom = 재개 위치");
  assert.equal((e2[e2.length - 1] as Extract<RunEvent, { type: "run_end" }>).status, "completed");
  assert.equal(run2.state.status, "completed");
  // 재개는 완료 step(chief/research)을 재실행하지 않는다
  const rerun = starts(e2).map((e) => e.agentId);
  assert.ok(!rerun.includes("chief_of_staff") && !rerun.includes("research"), "완료 step 재실행 없음");
  assert.deepEqual(rerun, ["pm", "red_team", "founder_ceo"]);
  // 완료 step 타이밍이 보존되고 중복 기록되지 않음 (chief/research 각 1회)
  assert.equal(run2.state.step_timings.filter((t) => t.agent_id === "chief_of_staff").length, 1);
  assert.equal(run2.state.step_timings.filter((t) => t.agent_id === "research").length, 1);
});

// ── 6. TTY / non-TTY 렌더러 계약 ───────────────────────────────
function capture(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = (s: unknown) => {
    writes.push(String(s));
    return true;
  };
  return { writes, restore: () => ((process.stdout as unknown as { write: unknown }).write = orig) };
}
function withTTY<T>(v: boolean, fn: () => T): T {
  const orig = (process.stdout as unknown as { isTTY: unknown }).isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: orig, configurable: true });
  }
}

test("렌더러(non-TTY): agent step만 시작 라인, gate/approval은 스피너 없음, note 출력", () => {
  withTTY(false, () => {
    const cap = capture();
    try {
      const rep = createProgressReporter();
      rep.emit({ type: "run_start", workflow: "w", totalSteps: 2 });
      rep.emit({ type: "step_start", index: 1, total: 2, agentId: "a", kind: "agent" });
      rep.emit({ type: "note", level: "warn", message: "  ↻ 재생성 경고" });
      rep.emit({ type: "step_end", index: 1, agentId: "a", kind: "agent", ok: true, elapsedMs: 5 });
      rep.emit({ type: "step_start", index: 2, total: 2, agentId: "g", kind: "gate" });
      rep.emit({ type: "step_end", index: 2, agentId: "g", kind: "gate", ok: true, elapsedMs: 1 });
      rep.emit({ type: "run_end", status: "completed", elapsedMs: 10 });
      const out = cap.writes.join("");
      assert.match(out, /▶ \[1\/2\] a 실행 중…/, "agent 시작 라인");
      assert.match(out, /↻ 재생성 경고/, "note 출력");
      assert.doesNotMatch(out, /g 실행 중…/, "gate는 스피너/시작 라인 없음");
    } finally {
      cap.restore();
    }
  });
});

test("렌더러(TTY): agent step은 스피너를 그리고 gate는 그리지 않는다", () => {
  withTTY(true, () => {
    const cap = capture();
    try {
      const rep = createProgressReporter();
      rep.emit({ type: "step_start", index: 1, total: 3, agentId: "a", kind: "agent" });
      rep.emit({ type: "step_end", index: 1, agentId: "a", kind: "agent", ok: true, elapsedMs: 5 });
      rep.emit({ type: "step_start", index: 2, total: 3, agentId: "g", kind: "gate" });
      rep.emit({ type: "step_end", index: 2, agentId: "g", kind: "gate", ok: true, elapsedMs: 1 });
      rep.emit({ type: "run_end", status: "completed", elapsedMs: 10 }); // interval 정리 안전망
      const out = cap.writes.join("");
      assert.match(out, /a 실행 중…/, "agent 스피너 draw");
      assert.doesNotMatch(out, /g 실행 중…/, "gate는 그리지 않음");
      assert.match(out, /\x1b\[2K/, "step_end에서 줄 지움(clear)");
    } finally {
      cap.restore();
    }
  });
});
