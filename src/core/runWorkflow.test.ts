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
import { loadWorkflows, isGate } from "./registry.js";
import { extractCeoDecision, CEO_DECISION_TOKENS } from "./validate.js";
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

test("[B-40] 회귀: '축소' 토큰이면 기존 되돌림 동작 그대로", async () => {
  const name = "_b40_jump";
  makeProject(name);
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: name,
    provider: ceoDeciding("- 축소"),
    now: () => FIXED,
  });
  const s = r.state;

  assert.equal(s.status, "completed", "축소 판정은 되돌림 후 완주 — kill 아님");
  assert.equal(s.killed_by, null);
  assert.equal(s.gate_jumps.length, 2, "1회 되돌림 + 예산 소진 후 진행");
  assert.deepEqual(s.gate_jumps[0], { decider: "founder_ceo", decision: "축소", jumped_to: "pm" });
  assert.deepEqual(s.gate_jumps[1], { decider: "founder_ceo", decision: "축소", jumped_to: null });
  assert.equal(timingsFor(s, "pm"), 2, "pm이 되돌림으로 1회 재실행");
  rmProject(name);
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

// ── A-2: 폐기 잠금 (새 run으로 덮어쓰기 금지) ──────────────────
test("[B-40/A-2] killed 후 kill 게이트 없는 다른 workflow로 새 run → 거부 · run_state 불변", async () => {
  const name = "_b40_lock";
  await killedProject(name);
  const before = readFileSync(join(projectPaths(name).outputs, "run_state.json"), "utf8");

  // dev-preflight에는 kill 게이트가 없다 — 예전엔 이걸로 돌려 completed로 덮어쓸 수 있었다.
  await assert.rejects(
    runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED }),
    /폐기된 아이디어입니다/,
    "폐기된 아이디어로는 새 run을 시작할 수 없다",
  );
  assert.equal(readFileSync(join(projectPaths(name).outputs, "run_state.json"), "utf8"), before, "kill 증거 불변");

  // 사람이 아이디어를 고치면(digest 변경) 통과한다 — 새 플래그가 아니라 실제 수정이 열쇠다.
  editIdea(name, "완전히 다른 아이디어");
  const again = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED });
  assert.equal(again.state.status, "completed", "아이디어를 고치면 다시 시작할 수 있다");
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
  assert.match(out, /폐기된 아이디어입니다/);
  assert.match(out, /00_IDEA\.md를 고친 뒤 다시 시작/);
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
test("[B-40/A-3] task-prompt: killed면 지시문 생성 거부 · 아이디어를 고치면 통과", async () => {
  const name = "_b40_tp";
  await killedProject(name);
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /폐기된 아이디어입니다/, "폐기된 아이디어로 구현 지시문을 만들지 않는다");
  editIdea(name, "고친 아이디어");
  assert.match(buildTaskPrompt(name, "2026-01-01"), /## Task/, "아이디어를 고치면 생성된다");
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
  editIdea(name, "고친 아이디어");
  assert.throws(
    () => createPlanDagRun({ run: "r1", milestone: "m1", approval: missingApproval, idea: ideaAbs }),
    /(?!폐기된 아이디어)/,
    "아이디어를 고치면 폐기 거부는 사라진다 (그 다음 거부는 승인 파일 부재)",
  );
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
});
