/**
 * [B-40] 아이디어 kill 게이트: CEO 정본 판정('폐기') → terminal 상태 "killed", 그리고 그 판정이
 * 하류(새 run · 작업 지시문 · DAG · 요약 · vault)에서 뒤집히지 않는지.
 *
 * 한 기능이 runWorkflow(게이트) · validate(파서) · registry(GateDef.kill) · commands/run(종료 코드) ·
 * taskPrompt · planDag · summary · obsidianExport에 걸쳐 있어 한 파일에서 함께 검증한다
 * (이 모듈들 대부분에 기존 .test.ts가 없었다).
 *
 * mock provider만 사용 — 실제 LLM 미호출(무과금). HARNESS_WORKSPACE는 test:core 스크립트가 지정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWorkflow, loadRunState, ideaDigest, IDEA_REL, type RunState } from "./runWorkflow.js";
import { loadWorkflows, isGate, loadAgentRegistry, findAgent, reevaluationWorkflowIds } from "./registry.js";
import { extractCeoDecision, CEO_DECISION_TOKENS, validateAgentOutput } from "./validate.js";
import { buildPromptParts } from "../providers/promptParts.js";
import { buildTaskPrompt } from "./taskPrompt.js";
import { buildSummary } from "./summary.js";
import { exportToVault } from "./obsidianExport.js";
import { projectPaths } from "./project.js";
import { mockProvider } from "../providers/mockProvider.js";
import { runRun } from "../commands/run.js";
import { createPlanDagRun } from "../commands/planDag.js";
import type { Provider, AgentRunInput, AgentResult } from "../providers/provider.js";
import type { RunEvent } from "./progress.js";

const FIXED = "2026-01-01T00:00:00.000Z";
const HERE = dirname(fileURLToPath(import.meta.url));
/** [B-40] gate 뒤에 sentinel step이 있는 격리 workflow (실제 세 게이트는 모두 마지막 step이다). */
const SENTINEL_WF = join(HERE, "..", "..", "tests", "fixtures", "workflows", "kill-sentinel.json");
/** kill-sentinel/kill-overlap의 gate 뒤 step — 호출 0회를 세는 대상. */
const SENTINEL = "chief_of_staff";

function makeProject(name: string, idea = "테스트"): void {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.docs, "00_IDEA.md"), `# idea\n\n## 아이디어 한 줄 정의\n\n- ${idea}\n`, "utf8");
}

function rmProject(name: string): void {
  rmSync(projectPaths(name).root, { recursive: true, force: true });
}

/** 아이디어 문서를 고친다 (digest가 바뀌어야 폐기 잠금이 풀린다). */
function editIdea(name: string, idea: string): void {
  writeFileSync(join(projectPaths(name).root, IDEA_REL), `# idea\n\n## 아이디어 한 줄 정의\n\n- ${idea}\n`, "utf8");
}

/**
 * founder_ceo의 정본 판정 절("## Decision")을 지정 본문으로 바꾸는 mock 래퍼 (그 외 agent는 mock 원본).
 * 게이트는 이 절만 읽는다 — 산문(Main Judgment)에 무엇이 있어도 판정에 쓰이지 않는다.
 * calls: agent_id → generate 호출 횟수 (sentinel 미실행 단정용).
 */
function ceoDeciding(decisionBody: string): Provider & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    id: "mock",
    calls,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      calls.set(input.agent.agent_id, (calls.get(input.agent.agent_id) ?? 0) + 1);
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== "founder_ceo") return r;
      const DEFAULT = "## Decision\n\n- 진행\n";
      assert.ok(r.markdown.includes(DEFAULT), "mock founder_ceo 출력에 정본 판정 절이 없다 — mock 형식이 바뀌었다");
      return { ...r, markdown: r.markdown.replace(DEFAULT, `## Decision\n\n${decisionBody}\n`) };
    },
  };
}

/** founder_ceo 출력에서 "## Decision" 절을 아예 없애는 mock 래퍼 (계약 위반 fixture). */
function ceoWithoutDecision(): Provider & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    id: "mock",
    calls,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      calls.set(input.agent.agent_id, (calls.get(input.agent.agent_id) ?? 0) + 1);
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== "founder_ceo") return r;
      const markdown = r.markdown.replace("## Decision\n\n- 진행\n\n", "");
      assert.notEqual(markdown, r.markdown, "Decision 절 제거 실패 — mock 출력 형식이 바뀌었다");
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

/** killed run 하나를 만든다 (실제 게이트를 지나서). */
async function killedProject(name: string, idea = "테스트"): Promise<RunState> {
  makeProject(name, idea);
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("- 폐기"),
    now: () => FIXED,
  });
  assert.equal(r.state.status, "killed", "fixture 전제: killed run");
  return r.state;
}

// ── A-1: 정본 판정 파서 ───────────────────────────────────────
test("[B-40/A-1] extractCeoDecision: 절 부재·토큰 0/2개는 error, 산문 판정은 읽지 않는다", () => {
  const withSection = (body: string) => `# x\n\n## Decision\n\n${body}\n\n## Main Judgment\n\n- 산문\n`;

  for (const t of CEO_DECISION_TOKENS) {
    assert.deepEqual(extractCeoDecision(withSection(`- ${t}`)), { token: t }, `${t} 토큰 인식`);
  }
  // 절이 없다 — 산문에 '폐기'가 있어도 판정으로 쓰지 않는다 (구조가 정본이다).
  assert.deepEqual(
    extractCeoDecision("# x\n\n## Main Judgment\n\n- 시장성 미달이라 폐기한다.\n"),
    { error: "absent" },
    "절 부재는 absent — 산문 폐기를 승격시키지 않는다",
  );
  assert.deepEqual(extractCeoDecision(withSection("- 축소 후 진행")), { error: "ambiguous" }, "토큰 2개는 ambiguous");
  assert.deepEqual(extractCeoDecision(withSection("- 잘 모르겠다")), { error: "ambiguous" }, "토큰 0개도 ambiguous");
  // "## Decisions"(복수, 기존 스키마 섹션)와 혼동하지 않는다.
  assert.deepEqual(
    extractCeoDecision("# x\n\n## Decisions\n\n- 폐기하기로 했다\n"),
    { error: "absent" },
    "## Decisions는 정본 절이 아니다",
  );
});

test("[B-40/A-2] extractCeoDecision: 판정을 고를 수 없다 (펜스·중복 절·부분문자열·여러 줄)", () => {
  // ① 코드펜스 안의 가짜 판정 절은 무시된다 — 예시 블록으로 판정을 심을 수 없다.
  const fenced =
    "# x\n\n## 형식 예시\n\n```\n## Decision\n\n- 진행\n```\n\n## Decision\n\n- 폐기\n";
  assert.deepEqual(extractCeoDecision(fenced), { token: "폐기" }, "펜스 밖 절이 정본이다 (펜스 안 '진행'이 이기지 않는다)");
  assert.deepEqual(
    extractCeoDecision("# x\n\n~~~\n## Decision\n\n- 진행\n~~~\n\n## Decision\n\n- 폐기\n"),
    { token: "폐기" },
    "~~~ 펜스도 같다",
  );
  // 펜스 안에만 있으면 절이 없는 것과 같다 (fail closed).
  assert.deepEqual(extractCeoDecision("# x\n\n```\n## Decision\n\n- 진행\n```\n"), { error: "absent" });

  // ② 절이 둘이면 어느 것도 정본이 아니다 — 첫 절이 이기는 방식이면 판정을 고를 수 있다.
  assert.deepEqual(
    extractCeoDecision("# x\n\n## Decision\n\n- 진행\n\n## Decision\n\n- 폐기\n"),
    { error: "ambiguous" },
    "중복 절은 ambiguous",
  );

  // ③ 부분문자열이 아니라 완전 일치다.
  assert.deepEqual(extractCeoDecision("# x\n\n## Decision\n\n- 진행성 검토 필요\n"), { error: "ambiguous" }, "'진행성'은 진행이 아니다");
  assert.deepEqual(extractCeoDecision("# x\n\n## Decision\n\n- 폐기 (조건부)\n"), { error: "ambiguous" }, "괄호 주석도 거부");

  // ④ 본문 비공백 줄이 정확히 1줄이어야 한다.
  assert.deepEqual(extractCeoDecision("# x\n\n## Decision\n\n- 폐기\n- 참고: 재검토 가능\n"), { error: "ambiguous" }, "여러 줄 거부");

  // ⑤ 인용된 헤더는 top-level 헤더가 아니다.
  assert.deepEqual(extractCeoDecision("# x\n\n> ## Decision\n>\n> - 진행\n"), { error: "absent" }, "인용 헤더는 절이 아니다");

  // 대조군: bullet 없는 토큰 단독도 받는다.
  assert.deepEqual(extractCeoDecision("# x\n\n## Decision\n\n폐기\n"), { token: "폐기" });
});

test("[B-40/A-1] 정본 판정 절이 없으면 fail closed — 진행하지 않고 멈춘다 · 후속 step 미실행", async () => {
  const name = "_b40_absent";
  makeProject(name);
  const p = ceoWithoutDecision();
  const r = await runWorkflow({
    workflowId: "kill-sentinel",
    workflowsPath: SENTINEL_WF,
    project: name,
    provider: p,
    now: () => FIXED,
  });
  const s = r.state;

  assert.equal(s.status, "failed", "판정을 읽을 수 없으면 조용히 진행하지 않는다");
  assert.equal(s.failed_reason, "ceo_decision_absent");
  assert.equal(s.failed_agent, "founder_ceo");
  assert.equal(s.resume_from, 1, "게이트 step부터 재개 (사람이 Decision 절을 고치면 이어진다)");
  assert.equal(s.killed_by, null, "판정 부재는 폐기가 아니다");
  assert.equal(p.calls.get(SENTINEL) ?? 0, 0, "게이트 뒤 sentinel step 미실행");
  rmProject(name);
});

test("[B-40/A-1] 정본 판정 토큰이 애매하면 fail closed (ceo_decision_ambiguous)", async () => {
  const name = "_b40_ambig";
  makeProject(name);
  const p = ceoDeciding("- 축소 후 진행");
  const r = await runWorkflow({
    workflowId: "kill-sentinel",
    workflowsPath: SENTINEL_WF,
    project: name,
    provider: p,
    now: () => FIXED,
  });
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "ceo_decision_ambiguous");
  assert.equal(p.calls.get(SENTINEL) ?? 0, 0, "게이트 뒤 sentinel step 미실행");
  rmProject(name);
});

// ── kill 판정 ────────────────────────────────────────────────
test("[B-40] gate kill → status=killed · killed_by(+idea digest) · 게이트 뒤 step 호출 0회", async () => {
  const name = "_b40_kill";
  makeProject(name);
  const { events, reporter } = collectingReporter();
  const p = ceoDeciding("- 폐기");
  const r = await runWorkflow({
    workflowId: "kill-sentinel",
    workflowsPath: SENTINEL_WF,
    project: name,
    provider: p,
    now: () => FIXED,
    reporter,
  });
  const s = r.state;

  assert.equal(s.status, "killed", "kill 토큰 → terminal 상태 killed (failed 아님)");
  assert.deepEqual(
    s.killed_by,
    { decider: "founder_ceo", decision: "폐기", idea_sha256: ideaDigest(name) },
    "누가 무슨 판정으로 죽였는지 + 그 시점 아이디어 digest",
  );
  assert.equal(s.failed_agent, null, "폐기는 agent 실패가 아니다");
  assert.equal(s.failed_reason, null, "kill 사유는 failed_reason에 넣지 않는다");
  assert.equal(s.resume_from, null, "killed는 재개 불가 → resume_from null");
  assert.equal(s.loop_state, null);
  assert.deepEqual(s.gate_jumps, [{ decider: "founder_ceo", decision: "폐기", jumped_to: null, killed: true }]);
  // **B-5의 핵심**: 게이트 뒤에 실제로 step이 있는 fixture에서 그 step이 돌지 않았다.
  assert.equal(p.calls.get(SENTINEL) ?? 0, 0, "게이트 뒤 sentinel step의 provider 호출 0회");
  assert.equal(s.completed_steps.includes(SENTINEL), false, "sentinel이 완료 목록에 없다");
  assert.equal(s.step_timings.at(-1)?.kind, "gate", "게이트가 마지막 타이밍");
  assert.equal(loadRunState(name)?.status, "killed", "디스크에도 killed");
  const end = events.find((e) => e.type === "run_end");
  assert.equal(end?.type === "run_end" ? end.status : null, "killed", "run_end 이벤트도 killed를 전달");
  rmProject(name);
});

test("[B-40] 같은 토큰이 on과 kill에 둘 다 있으면 kill이 이긴다 (되돌림·후속 step 없음)", async () => {
  const name = "_b40_overlap";
  makeProject(name);
  const { events, reporter } = collectingReporter();
  const p = ceoDeciding("- 폐기");
  const r = await runWorkflow({
    workflowId: "kill-overlap", // on:{"폐기":"founder_ceo"} + kill:["폐기"], max_jumps=1
    workflowsPath: SENTINEL_WF,
    project: name,
    provider: p,
    now: () => FIXED,
    reporter,
  });
  const s = r.state;

  assert.equal(s.status, "killed", "kill이 jump보다 먼저 판정된다");
  assert.equal(s.gate_jumps.length, 1, "게이트 1회 — 되돌림으로 다시 오지 않았다");
  assert.equal(s.gate_jumps[0].jumped_to, null, "kill이면 되돌림 대상 없음");
  assert.equal(s.gate_jumps[0].killed, true);
  assert.equal(p.calls.get("founder_ceo"), 1, "decider가 되돌림으로 재실행되지 않았다");
  assert.equal(p.calls.get(SENTINEL) ?? 0, 0, "게이트 뒤 sentinel step 미실행");
  assert.equal(events.some((e) => e.type === "gate_jump"), false, "gate_jump 이벤트 미방출");
  rmProject(name);
});

test("[B-40] 대조군: '진행' 토큰이면 게이트를 통과해 뒤 step이 실제로 돈다", async () => {
  const name = "_b40_pass";
  makeProject(name);
  const p = ceoDeciding("- 진행");
  const r = await runWorkflow({
    workflowId: "kill-sentinel",
    workflowsPath: SENTINEL_WF,
    project: name,
    provider: p,
    now: () => FIXED,
  });
  assert.equal(r.state.status, "completed");
  assert.equal(r.state.killed_by, null);
  assert.equal(p.calls.get(SENTINEL), 1, "게이트가 통과도 시킨다 (kill 단정이 공허하지 않다)");
  assert.deepEqual(r.state.gate_jumps, [{ decider: "founder_ceo", decision: "진행", jumped_to: null }]);
  rmProject(name);
});

test("[B-40] '축소'는 되돌림 1회 후 예산 소진 → 진행이 아니라 중단", async () => {
  const name = "_b40_jump";
  makeProject(name);
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("- 축소"),
    now: () => FIXED,
  });
  const s = r.state;

  // [A-1] 예전 계약은 "예산 소진 후 진행 → completed"였다. 같은 비진행 판정이 예산 소진만으로
  // 통과로 바뀌면 상태 전이 우회이고 completed는 거짓 영수증이다. 계약을 강화했다.
  assert.equal(s.status, "failed", "되돌려도 판정이 그대로면 통과시키지 않는다");
  assert.equal(s.failed_reason, "gate_jump_budget_exhausted");
  assert.equal(s.resume_from, 5, "게이트 step부터 재개");
  assert.equal(s.killed_by, null);
  assert.equal(s.cleared_idea_sha256, null, "'진행'이 아니면 해제 증거를 발급하지 않는다");
  assert.equal(s.gate_jumps.length, 2, "되돌림 1회 + 예산 소진 판정 1회");
  assert.deepEqual(s.gate_jumps[0], { decider: "founder_ceo", decision: "축소", jumped_to: "pm" });
  assert.equal(timingsFor(s, "pm"), 2, "pm이 되돌림으로 1회 재실행 (되돌림 자체는 그대로 동작)");
  rmProject(name);
});

test("[B-40/A-1] 게이트 통과는 '진행' 토큰 하나뿐 — 5토큰 × 3 workflow 전수", async () => {
  // kill 게이트가 있는 세 workflow에서 다섯 토큰이 각각 어디로 가는지 전수로 고정한다.
  // (mvp-planning엔 '검증' 매핑이 없다 → unmapped. 예전엔 그것이 조용히 진행했다.)
  const expected: Record<string, Record<string, string>> = {
    "idea-validation": {
      진행: "completed",
      축소: "failed:gate_jump_budget_exhausted",
      검증: "failed:gate_jump_budget_exhausted",
      보류: "failed:ceo_decision_hold",
      폐기: "killed",
    },
    "mvp-planning": {
      진행: "completed",
      축소: "failed:gate_jump_budget_exhausted",
      검증: "failed:ceo_decision_unmapped", // 이 workflow엔 research step이 없어 매핑이 없다
      보류: "failed:ceo_decision_hold",
      폐기: "killed",
    },
    "full-predev": {
      진행: "completed",
      축소: "failed:gate_jump_budget_exhausted",
      검증: "failed:gate_jump_budget_exhausted",
      보류: "failed:ceo_decision_hold",
      폐기: "killed",
    },
  };

  for (const [wf, byToken] of Object.entries(expected)) {
    for (const [token, want] of Object.entries(byToken)) {
      const name = `_b40_m_${wf.replace(/-/g, "")}_${CEO_DECISION_TOKENS.indexOf(token as never)}`;
      makeProject(name);
      const r = await runWorkflow({
        workflowId: wf,
        project: name,
        provider: ceoDeciding(`- ${token}`),
        now: () => FIXED,
        approve: async () => true, // mvp-planning/full-predev의 디자인 승인 게이트
      });
      const got = r.state.status === "failed" ? `failed:${r.state.failed_reason}` : r.state.status;
      assert.equal(got, want, `${wf} × '${token}' → ${want} (실제: ${got})`);
      if (want === "completed") assert.equal(typeof r.state.cleared_idea_sha256, "string", `${wf} × 진행 → 해제 발급`);
      else assert.equal(r.state.cleared_idea_sha256, null, `${wf} × '${token}' → 해제 없음`);
      rmProject(name);
    }
  }
});

// ── killed는 재개 불가 ────────────────────────────────────────
test("[B-40] killed run은 --resume 거부 (status !== failed)", async () => {
  const name = "_b40_resume";
  await killedProject(name);
  await assert.rejects(
    runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 폐기"), resume: true, now: () => FIXED }),
    /재개할 실패 상태가 아닙니다 \(status=killed\)/,
    "killed는 실패가 아니므로 재개 대상이 아니다",
  );
  rmProject(name);
});

// ── A-2/A-3: 폐기 잠금 ────────────────────────────────────────
test("[B-40/A-2] killed 후 kill 게이트 없는 다른 workflow로 새 run → 거부 · run_state 불변", async () => {
  const name = "_b40_lock";
  await killedProject(name);
  const before = readFileSync(join(projectPaths(name).outputs, "run_state.json"), "utf8");

  // dev-preflight에는 kill 게이트가 없다 — 예전엔 이걸로 돌려 completed로 덮어쓸 수 있었다.
  await assert.rejects(
    runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED }),
    /killed_locked/,
    "폐기된 아이디어로는 재평가 아닌 run을 시작할 수 없다",
  );
  assert.equal(readFileSync(join(projectPaths(name).outputs, "run_state.json"), "utf8"), before, "kill 증거 불변");

  // [A-3] **아이디어를 고치는 것만으로는 해제되지 않는다** (이전 판의 결함).
  editIdea(name, "완전히 다른 아이디어");
  await assert.rejects(
    runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED }),
    /killed_locked/,
    "아이디어 변경은 '재평가가 필요하다'는 신호일 뿐 '통과했다'는 증거가 아니다",
  );
  rmProject(name);
});

test("[B-40/A-3] 잠금 해제는 재평가 run의 '진행' 판정뿐 — kill_history는 남는다", async () => {
  const name = "_b40_clear";
  await killedProject(name);
  editIdea(name, "고친 아이디어");

  // 재평가 = kill 게이트가 있는 workflow의 새 run. 이것만 잠금 중에도 허용된다.
  const reeval = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("- 진행"),
    now: () => FIXED,
  });
  assert.equal(reeval.state.status, "completed");
  assert.equal(reeval.state.cleared_idea_sha256, ideaDigest(name), "'진행' 판정이 해제 digest를 발급");
  assert.equal(reeval.state.kill_history.length, 1, "폐기 이력은 지워지지 않는다 (carry forward)");

  // 해제 후에는 잠금 없는 경로가 열린다.
  const after = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED });
  assert.equal(after.state.status, "completed");
  assert.equal(after.state.kill_history.length, 1, "그 뒤 run도 폐기 이력을 이어받는다");
  assert.equal(after.state.cleared_idea_sha256, ideaDigest(name), "해제 증거도 이어받는다");
  assert.match(buildTaskPrompt(name, "2026-01-01"), /## Task/, "해제 후 지시문 생성 가능");

  // 아이디어를 다시 고치면 해제 증거가 현재 digest와 어긋나 → 다시 잠긴다 (재평가 필요).
  editIdea(name, "또 고친 아이디어");
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked/, "해제는 그 digest에만 유효하다");
  rmProject(name);
});

test("[B-40/A-3] 재평가에서 다시 '폐기'면 이력이 쌓이고 해제가 무효화된다", async () => {
  const name = "_b40_rekill";
  await killedProject(name);
  editIdea(name, "고친 아이디어");
  await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 진행"), now: () => FIXED });
  editIdea(name, "또 고친 아이디어");
  const again = await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 폐기"), now: () => FIXED });

  assert.equal(again.state.status, "killed");
  assert.equal(again.state.kill_history.length, 2, "폐기 2건 누적");
  assert.equal(again.state.cleared_idea_sha256, null, "폐기는 이전 해제를 무효화한다");
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked/);
  rmProject(name);
});

test("[B-40/A-2] harness run: 폐기 잠금 거부는 exit 2 (무인 loop 진입점과 같은 코드)", async () => {
  const name = "_b40_lock_cli";
  await killedProject(name);
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = await captureLogs(() => runRun("dev-preflight", name, "mock", 1, false, undefined, false, 0, true));
  assert.equal(process.exitCode, 2, "폐기 잠금 거부 = exit 2");
  process.exitCode = prevExit;
  assert.match(out, /killed_locked/);
  assert.match(out, /재평가를 먼저 돌리고/, "무엇을 해야 하는지 말한다");
  assert.match(out, /harness run <.*idea-validation.*>/, "재평가 workflow 이름을 적는다");
  rmProject(name);
});

// ── A-4: 손상된 run_state는 부재가 아니다 ──────────────────────
test("[B-40/A-4] 손상된 run_state → 새 run·task-prompt·plan-dag 전부 거부 · 파일 바이트 불변", async () => {
  const name = "_b40_corrupt";
  await killedProject(name);
  const statePath = join(projectPaths(name).outputs, "run_state.json");
  const corrupt = '{"workflow_id":"idea-validation","status":"killed","kill_history":[{"decid';
  writeFileSync(statePath, corrupt, "utf8");

  await assert.rejects(
    runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 진행"), now: () => FIXED }),
    /run_state_unreadable/,
    "손상된 state를 '없음'으로 접어 덮어쓰지 않는다 (재평가 workflow조차)",
  );
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /run_state_unreadable/);
  const ideaAbs = join(projectPaths(name).root, IDEA_REL);
  assert.throws(
    () => createPlanDagRun({ run: "r1", milestone: "m1", approval: join(tmpdir(), "nope.json"), idea: ideaAbs }),
    /run_state_unreadable/,
  );
  assert.equal(readFileSync(statePath, "utf8"), corrupt, "거부 경로가 그 파일을 건드리지 않았다");
  rmProject(name);
});

test("[B-40/A-4] harness run: 손상된 run_state 거부는 exit 2", async () => {
  const name = "_b40_corrupt_cli";
  makeProject(name);
  writeFileSync(join(projectPaths(name).outputs, "run_state.json"), "{ not json", "utf8");
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = await captureLogs(() => runRun("idea-validation", name, "mock", 1, false, undefined, false, 0, true));
  assert.equal(process.exitCode, 2);
  process.exitCode = prevExit;
  assert.match(out, /run_state_unreadable/);
  rmProject(name);
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
      ceoDeciding("- 폐기"),
    ),
  );

  assert.ok(!process.exitCode, `killed는 정상 종료 코드(판정 자체는 성공한 작업) — 실제: ${process.exitCode}`);
  process.exitCode = prevExit;
  assert.equal(handoffCalls.length, 0, "폐기된 아이디어를 개발 착수 handoff로 넘기지 않는다");
  assert.match(out, /폐기 판정: founder_ceo가 '폐기' 판정/, "어느 decider가 무슨 판정으로 죽였는지 출력");
  assert.match(out, /아이디어를 고쳐 새 run으로 시작/);
  assert.match(out, /게이트: founder_ceo 판정 '폐기' → 폐기 — run 종료/);
  assert.doesNotMatch(out, /--resume$/m, "killed에 resume 안내를 하지 않는다");
  rmProject(name);
});

test("[B-40] harness run --resume: killed는 completed와 동급 — 덮어쓰기 없이 안내", async () => {
  const name = "_b40_cmd_resume";
  await killedProject(name);
  const before = JSON.stringify(loadRunState(name));

  const prevExit = process.exitCode;
  process.exitCode = 0;
  const out = await captureLogs(() => runRun("idea-validation", name, "mock", 1, false, undefined, true));
  assert.ok(!process.exitCode, `재개 대상 아님 안내는 정상 종료 — 실제: ${process.exitCode}`);
  process.exitCode = prevExit;
  assert.match(out, /재개할 것이 없습니다/);
  assert.match(out, /status=killed/);
  assert.equal(JSON.stringify(loadRunState(name)), before, "run_state를 덮어쓰지 않는다");
  rmProject(name);
});

// ── A-3: 하류 생성 차단 ───────────────────────────────────────
test("[B-40/A-3] task-prompt: killed면 거부 · 아이디어 수정만으로도 계속 거부 (해제는 재평가뿐)", async () => {
  const name = "_b40_tp";
  await killedProject(name);
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked/, "폐기된 아이디어로 구현 지시문을 만들지 않는다");
  // [A-3] 예전 판은 여기서 통과했다 — 공백 하나만 바꿔도 killed 산출물로 지시문을 만들 수 있었다.
  editIdea(name, "고친 아이디어");
  let caught: Error | null = null;
  try {
    buildTaskPrompt(name, "2026-01-01");
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, "아이디어 수정만으로는 해제되지 않는다");
  assert.match(caught!.message, /killed_locked/);
  assert.match(caught!.message, /재평가를 먼저 돌리고/, "무엇을 해야 하는지 말한다");
  rmProject(name);
});

test("[B-40/A-3] plan-dag: killed면 run 생성 전에 거부 (승인 파일을 읽기도 전에)", async () => {
  const name = "_b40_dag";
  await killedProject(name);
  const ideaAbs = join(projectPaths(name).root, IDEA_REL);
  const missingApproval = join(tmpdir(), `b40-no-such-approval-${process.pid}.json`);
  assert.equal(existsSync(missingApproval), false, "전제: 승인 파일이 없다");

  // 승인 파일이 없어도 **폐기 거부가 먼저** 난다 → durable run 생성 경로에 도달하지 않는다.
  assert.throws(
    () => createPlanDagRun({ run: "r1", milestone: "m1", approval: missingApproval, idea: ideaAbs }),
    /폐기된 아이디어입니다/,
    "killed 검사가 승인 읽기·run 생성보다 앞이다",
  );
  // [C 정정] 예전 판은 `assert.throws(..., /(?!폐기된 아이디어)/)`였다 — zero-width lookahead라
  // 거의 모든 문자열에 매칭돼 **거의 항상 통과하는 공허한 단정**이었다. 오류를 잡아서
  // 음성(폐기 아님)과 양성(승인 파일 부재)을 각각 단정한다.
  // 해제는 재평가의 '진행' 판정뿐이므로, 아이디어 수정만으로는 아직 잠겨 있다 → 재평가를 돌린다.
  editIdea(name, "고친 아이디어");
  await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 진행"), now: () => FIXED });
  let caught: Error | null = null;
  try {
    createPlanDagRun({ run: "r1", milestone: "m1", approval: missingApproval, idea: ideaAbs });
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, "여전히 던진다 (승인 파일이 없으니)");
  assert.doesNotMatch(caught!.message, /killed_locked|폐기된 아이디어/, "해제 후에는 폐기 거부가 아니다");
  assert.match(caught!.message, /invalid_manifest|no-such-approval/, "다음 거부는 승인 파일 부재다");
  rmProject(name);
});

// ── A-4: 소비자 영수증 ────────────────────────────────────────
test("[B-40/A-4] summary·vault·handoff가 killed를 완료/진행으로 적지 않는다", async () => {
  const name = "_b40_receipt";
  const state = await killedProject(name);

  const summary = buildSummary(name, "2026-01-01");
  assert.match(summary, /상태: killed/);
  assert.match(summary, /\*\*폐기 판정\*\*/);
  assert.doesNotMatch(summary, /완료 — `harness task-prompt`/, "killed에 '완료 — task-prompt' 안내를 내지 않는다");
  assert.match(summary, /00_IDEA\.md/);

  const vault = join(tmpdir(), `b40-vault-${process.pid}`);
  try {
    const ex = exportToVault({ vault, state });
    const index = readFileSync(join(ex.folder, `${ex.indexNote}.md`), "utf8");
    assert.match(index, /- 상태: killed/);
    assert.match(index, /⛔ 폐기: founder_ceo가 '폐기' 판정/);
    assert.match(index, /게이트: founder_ceo 판정 '폐기' → 폐기 — run 종료/);
    assert.doesNotMatch(index, /판정 '폐기' → 진행/, "killed를 '진행'으로 적지 않는다");
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
  rmProject(name);
});

// ── registry 로더 ────────────────────────────────────────────
test("[B-40] workflows.json: kill 필드 로드 · on 타깃 존재 · on/kill 키가 정본 토큰 어휘", () => {
  const wfs = loadWorkflows();
  const killGates = new Map<string, string[]>();
  for (const wf of wfs) {
    for (const step of wf.steps) {
      if (!isGate(step)) continue;
      const { decider, on, kill } = step.gate;
      assert.ok(wf.steps.includes(decider), `${wf.workflow_id}: gate decider '${decider}'가 step 목록에 없다`);
      for (const [token, target] of Object.entries(on)) {
        assert.ok(
          (CEO_DECISION_TOKENS as readonly string[]).includes(token),
          `${wf.workflow_id}: gate on 키 '${token}'이 정본 판정 토큰이 아니다 — 영원히 매칭되지 않는다`,
        );
        assert.ok(
          wf.steps.includes(target),
          `${wf.workflow_id}: gate 되돌림 대상 '${target}'이 이 workflow의 step에 없다 (문서 밖으로 jump 금지)`,
        );
      }
      for (const token of kill ?? []) {
        assert.ok(
          (CEO_DECISION_TOKENS as readonly string[]).includes(token),
          `${wf.workflow_id}: gate kill 키 '${token}'이 정본 판정 토큰이 아니다 — 영원히 매칭되지 않는다`,
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
  // dev-preflight에는 게이트가 없다 — A-2 테스트가 이 사실에 기댄다.
  assert.equal(wfs.find((w) => w.workflow_id === "dev-preflight")?.steps.some(isGate), false);
  // kill 게이트가 있는 workflow = 잠금 중 허용되는 재평가 대상.
  assert.deepEqual(reevaluationWorkflowIds().sort(), ["full-predev", "idea-validation", "mvp-planning"]);
});

test("[B-40/B] live 경로 최종 출력 계약에 '## Decision'이 실린다 (만족 불가능한 계약 금지)", async () => {
  const registry = loadAgentRegistry();
  const ceo = findAgent(registry, "founder_ceo")!;
  const base = {
    workflowId: "idea-validation",
    project: "p",
    createdAt: FIXED,
    commonPrompt: "COMMON",
    agentPrompt: "ROLE",
    ideaContent: "idea",
    priorFindings: [] as string[],
  };
  const forCeo = buildPromptParts({ ...base, agent: ceo }, "claude-code").user;
  // 모델이 마지막으로 읽는 섹션 목록에 Decision이 있어야 한다 — 없으면 절을 빼고 게이트가 정지한다.
  assert.match(forCeo, /Decision \/ Input Summary/, "최종 섹션 목록에 Decision 포함");
  assert.match(forCeo, /"## Decision" 절은 필수다/);
  for (const t of CEO_DECISION_TOKENS) assert.ok(forCeo.includes(`\`${t}\``), `허용 토큰 ${t} 명시`);

  // decider가 아닌 agent에는 붙지 않는다 (다른 역할의 출력 계약을 바꾸지 않는다).
  const pm = findAgent(registry, "pm")!;
  const forPm = buildPromptParts({ ...base, agent: pm }, "claude-code").user;
  assert.doesNotMatch(forPm, /## Decision/);

  // required_headers로 재생성 피드백이 돌게 했다 (게이트 정지 전에 한 번 더 기회를 준다).
  assert.deepEqual(ceo.required_headers, ["Decision"]);
  // 계약이 실제로 만족 가능한지: mock 출력이 그 검증을 통과한다.
  assert.deepEqual(
    validateAgentOutput(
      (await mockProvider.generate({ ...base, agent: ceo })).markdown,
      ceo.required_headers,
    ).missing,
    [],
  );
});
