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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWorkflow, loadRunState, snapshotProjectIdea, gateOutcomeLabel, IDEA_REL, type RunState } from "./runWorkflow.js";
import { loadWorkflows, isGate, loadAgentRegistry, findAgent, reevaluationWorkflowIds, type AgentDef } from "./registry.js";
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
/** [C-127/A-1] target이 루프 **전에** 채택되는 최소 비평 workflow (revise가 채택본을 덮는 경로). */
const CRITIQUE_WF = join(HERE, "..", "..", "tests", "fixtures", "workflows", "critique-revise.json");
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

/**
 * founder_ceo의 "## Decision" 절을 **코드펜스 안으로** 넣는 mock 래퍼.
 *
 * [C-127] 왜 이 모양인가: 절을 통째로 지우면 이제 `required_sections_missing`으로 **게이트 도달 전에**
 * 멈춘다(founder_ceo의 `required_headers`가 `["Decision"]`이다). 그러면 "게이트가 판정 부재를 fail closed로
 * 잡는다"는 B-40/A-1의 방어선이 테스트에서 도달 불가능해진다 — 단정을 약화시키는 대신 fixture를 바꾼다.
 * 펜스 안 헤더는 `validateAgentOutput`이 마스킹하지 않아 통과하고(`validate.ts`의 정규식은 라인 단위),
 * `extractCeoDecision`은 fenceMask로 걸러 `absent`를 낸다 — 게이트 방어선만 정확히 겨눈다.
 */
function ceoDecisionFencedOnly(): Provider & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  return {
    id: "mock",
    calls,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      calls.set(input.agent.agent_id, (calls.get(input.agent.agent_id) ?? 0) + 1);
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== "founder_ceo") return r;
      const markdown = r.markdown.replace("## Decision\n\n- 진행\n\n", "```text\n## Decision\n\n- 진행\n```\n\n");
      assert.notEqual(markdown, r.markdown, "Decision 절 펜스화 실패 — mock 출력 형식이 바뀌었다");
      assert.equal(validateAgentOutput(markdown, ["Decision"]).ok, true, "fixture 전제: 필수 섹션 검증은 통과한다");
      return { ...r, markdown };
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
  const p = ceoDecisionFencedOnly(); // [C-127] fixture만 교체 — 아래 단정은 한 글자도 바꾸지 않았다

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
    { decider: "founder_ceo", decision: "폐기", idea_sha256: snapshotProjectIdea(name).sha256 },
    "누가 무슨 판정으로 죽였는지 + 그 시점 아이디어 digest",
  );
  assert.equal(s.failed_agent, null, "폐기는 agent 실패가 아니다");
  assert.equal(s.failed_reason, null, "kill 사유는 failed_reason에 넣지 않는다");
  assert.equal(s.resume_from, null, "killed는 재개 불가 → resume_from null");
  assert.equal(s.loop_state, null);
  assert.deepEqual(s.gate_jumps, [{ decider: "founder_ceo", decision: "폐기", jumped_to: null, outcome: "kill" }]);
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
  assert.equal(s.gate_jumps[0].outcome, "kill");
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
  assert.deepEqual(r.state.gate_jumps, [{ decider: "founder_ceo", decision: "진행", jumped_to: null, outcome: "proceed" }]);
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
  assert.deepEqual(s.gate_jumps[0], { decider: "founder_ceo", decision: "축소", jumped_to: "pm", outcome: "jump" });
  assert.equal(timingsFor(s, "pm"), 2, "pm이 되돌림으로 1회 재실행 (되돌림 자체는 그대로 동작)");
  rmProject(name);
});

// ── [B-49] 되돌림 예산의 durable화 ─────────────────────────────
// 예산은 지역 Map이 아니라 gate_jumps 영수증에서 파생한다. 아래 네 테스트가 재는 것은 하나다:
// **소진된 예산이 resume으로 되살아나지 않는다** (=live run#3에서 replay lap이 무한히 반복되던 경로).

const totalCalls = (p: { calls: Map<string, number> }): number => [...p.calls.values()].reduce((a, b) => a + b, 0);
const CEO_DOC = findAgent(loadAgentRegistry(), "founder_ceo")!.default_output;

/**
 * [B-49] idea-validation을 '축소' 판정으로 예산 소진(failed)까지 돌린다 — resume 테스트들의 공통 전제.
 *
 * [B-50] 예전엔 '검증'으로 몰았는데, 이제 '검증'의 소진은 `ceo_decision_verify`(사람 차례)로 갈린다 —
 * `gate_jump_budget_exhausted` 자체를 재려면 그 사유가 나오는 판정으로 몰아야 한다. **약화가 아니다**:
 * '축소'도 idea-validation에서 되돌림(→pm) 1회 뒤 같은 자리에서 소진되므로 재는 대상(소진된 예산이
 * resume으로 부활하지 않는다)은 바이트 하나 다르지 않게 유지된다. '검증' 쪽 계약은 아래 [B-50] 테스트들이 잰다.
 */
async function exhaustedProject(name: string): Promise<void> {
  makeProject(name);
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 축소"), now: () => FIXED });
  assert.equal(r.state.failed_reason, "gate_jump_budget_exhausted", "전제: 되돌림 1회 후 예산 소진으로 실패");
  assert.equal(r.state.gate_jumps.length, 2, "전제: jump 1 + failed 1");
}

test("[B-49] 예산 소진 실패에서 resume해도 되돌림이 부활하지 않는다 (모델 호출 0회)", async () => {
  // red: 파생(remainingJumps)을 지역 gateBudget Map으로 되돌리면 resume이 remaining=1을 새로 받아
  // research부터 한 lap을 통째로 재실행한다 → 모델 호출 > 0, gate_jumps가 +2(jump+failed).
  const name = "_b49_resume";
  await exhaustedProject(name);

  const p = ceoDeciding("- 축소");
  const s = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, resume: true, now: () => FIXED })).state;

  assert.equal(totalCalls(p), 0, "게이트만 재판정한다 — 모델 호출 0회");
  assert.equal(s.status, "failed");
  assert.equal(s.failed_reason, "gate_jump_budget_exhausted", "같은 자리에서 다시 막힌다");
  assert.equal(s.gate_jumps.length, 3, "실패 영수증 한 줄만 늘었다 (재점프 없음)");
  assert.equal(s.gate_jumps.filter((g) => g.outcome === "jump").length, 1, "되돌림은 여전히 1회뿐");
  assert.equal(s.gate_jumps.at(-1)?.decision_source, "restored_artifact", "복원 바이트로 판정했다는 사실이 남는다");
  rmProject(name);
});

test("[B-49] 사람이 Decision을 고치면 resume이 모델 호출 0회로 종결하고 판정 출처가 영수증에 남는다", async () => {
  // red: 게이트 push의 `...src`(decision_source 기록)를 지우면 마지막 entry 단정이 빨감 —
  //      사람이 고친 문서로 발급된 해제가 모델 판정과 구분되지 않는 현행 상태로 회귀한다.
  const name = "_b49_human";
  await exhaustedProject(name);

  // 사람의 레버: decider 산출 문서의 정본 판정 절을 종결 판정으로 고친다 (ceo_decision_absent 복구 경로와 같은 레버).
  const doc = join(projectPaths(name).root, CEO_DOC);
  const before = readFileSync(doc, "utf8");
  const after = before.replace("## Decision\n\n- 축소", "## Decision\n\n- 진행");
  assert.notEqual(after, before, "전제: 저장된 decider 문서에 '축소' 판정 절이 있다");
  writeFileSync(doc, after, "utf8");

  const p = ceoDeciding("- 축소"); // 모델이 다시 돌면 여전히 '축소'를 낸다 — 종결이 복원 바이트 덕임을 고정한다
  const s = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, resume: true, now: () => FIXED })).state;

  assert.equal(totalCalls(p), 0, "복원 문서를 읽어 판정한다 — 모델 호출 0회");
  assert.equal(s.status, "completed");
  assert.deepEqual(s.gate_jumps.at(-1), {
    decider: "founder_ceo",
    decision: "진행",
    jumped_to: null,
    outcome: "proceed",
    decision_source: "restored_artifact",
  });
  assert.equal(s.cleared_idea_sha256, snapshotProjectIdea(name).sha256, "'진행'이면 해제 증거를 발급한다 (레버를 막지 않는다)");
  assert.equal(s.gate_jumps[0].decision_source, undefined, "[additive] 이번 invocation에서 실행된 decider의 판정엔 필드가 없다");
  assert.match(gateOutcomeLabel(s.gate_jumps.at(-1)!), /판정 출처: 복원 문서/, "CLI·vault가 쓰는 단일 렌더에도 나온다");
  rmProject(name);
});

test("[B-49/R1-C] outcome 필드가 없는 레거시 jump 영수증도 소진으로 센다", async () => {
  // red: isJump에서 레거시 항(outcome === undefined && jumped_to !== null)을 빼면 spent=0으로 읽혀
  //      비싼 lap 하나가 조용히 다시 열린다 → 모델 호출 > 0.
  // 타입상 outcome은 필수지만 **타입은 런타임 검증이 아니다** — 그 필드가 생기기 전에 쓰인
  // 디스크 바이트를 resume하는 경로가 실재하고, lockFieldsProblem도 gate_jumps를 보지 않는다.
  const name = "_b49_legacy";
  await exhaustedProject(name);

  const sp = join(projectPaths(name).root, "outputs/run_state.json");
  const raw = JSON.parse(readFileSync(sp, "utf8")) as { gate_jumps: Record<string, unknown>[] };
  for (const g of raw.gate_jumps) delete g.outcome; // outcome 도입 이전 형태를 재현
  writeFileSync(sp, JSON.stringify(raw, null, 2), "utf8");
  assert.equal(loadRunState(name)?.gate_jumps[0].jumped_to, "pm", "전제: 레거시 entry도 읽히고 jumped_to만 남았다");

  const p = ceoDeciding("- 축소");
  const s = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, resume: true, now: () => FIXED })).state;

  assert.equal(totalCalls(p), 0, "레거시 영수증도 되돌림 1회로 세어 예산이 소진된 채로 남는다");
  assert.equal(s.failed_reason, "gate_jump_budget_exhausted");
  rmProject(name);
});

test("[B-49] 같은 decider의 게이트가 2개인 workflow는 실행 전에 거부한다 (run_start 방출 전 · 모델 호출 0회)", async () => {
  // red: guard를 지우면 두 게이트가 서로의 jump를 자기 예산에서 차감해(파생이 decider 단위) 조용히
  //      과소 예산으로 돌고, 원인이 보이지 않는 gate_jump_budget_exhausted로 멈춘다.
  const name = "_b49_dup";
  makeProject(name);
  const { events, reporter } = collectingReporter();
  const p = ceoDeciding("- 축소");

  await assert.rejects(
    runWorkflow({ workflowId: "gate-dup-decider", workflowsPath: SENTINEL_WF, project: name, provider: p, now: () => FIXED, reporter }),
    /gate_duplicate_decider/,
  );
  assert.equal(totalCalls(p), 0, "과금 전에 거부한다");
  assert.deepEqual(events, [], "run_start 이전에 던진다 — progress renderer의 spinner/stderr가 새지 않는다");
  assert.equal(loadRunState(name), null, "run_state를 만들지 않는다");
  rmProject(name);
});

test("[B-49] harness run: 예산 소진 실패엔 사유별 안내가 붙는다 (무차별 재개 안내가 아니다)", async () => {
  // red: run.ts의 gate_jump_budget_exhausted 분기를 지우면 "재개: ... --resume" 한 줄만 남아,
  //      아무것도 고치지 않은 resume이 진행할 것처럼 읽힌다(거짓 안내).
  const name = "_b49_cli";
  makeProject(name);
  const prevExit = process.exitCode;
  const out = await captureLogs(() =>
    runRun(
      "idea-validation", name, "mock", 1, false, undefined, false, 0, true, undefined, false,
      false, undefined, undefined, undefined,
      ceoDeciding("- 축소"),
    ),
  );
  process.exitCode = prevExit; // failed는 exit 1 — 테스트 프로세스의 종료 코드를 오염시키지 않는다

  assert.match(out, /중단 사유: gate_jump_budget_exhausted/);
  assert.match(out, /되살아나지 않습니다/, "예산이 resume으로 부활하지 않는다는 사실을 말한다");
  assert.match(out, /모델 호출 없이 같은 자리에서 다시 막히고/, "무편집 resume의 실제 결과를 말한다");
  assert.ok(out.includes(`${CEO_DOC}의 "## Decision"`), "고칠 파일을 이름으로 말한다");
  rmProject(name);
});

// ── [B-50] 소진된 뒤의 '검증'은 "사람이 확인할 차례"다 ─────────
// **예산이 기계와 사람의 경계다**: 예산이 남아 있을 때의 '검증'은 research 되돌림(기계가 할 수 있는 일)이고,
// 다 쓰고도 같은 '검증'이면 검색으로 안 나오는 것이 필요하다는 뜻이다.

/** [B-50] idea-validation을 '검증' 판정으로 되돌림 1회 + 사람 대기(failed)까지 돌린다. */
async function verifyStalledProject(name: string): Promise<void> {
  makeProject(name);
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 검증"), now: () => FIXED });
  assert.equal(r.state.failed_reason, "ceo_decision_verify", "전제: 되돌림 1회 후 사람 확인 대기로 중단");
}

test("[B-50] 되돌림을 다 쓰고도 '검증'이면 ceo_decision_verify — 되돌림 자체는 그대로 돈다", async () => {
  // red ①: 사유 ternary의 `decision === "검증"` case를 되돌리면 gate_jump_budget_exhausted가 나온다.
  // red ②: '검증'을 on 조회 전에 가로채는(=되돌림을 없애는) 설계로 바꾸면 research 2회·jump entry가 사라진다 —
  //         2차 research는 live 실측에서 결정적 증거를 냈으므로 그 되돌림은 계약이다.
  const name = "_b50_verify";
  makeProject(name);
  const p = ceoDeciding("- 검증");
  const s = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, now: () => FIXED })).state;

  assert.equal(s.status, "failed");
  assert.equal(s.failed_reason, "ceo_decision_verify");
  assert.equal(s.failed_agent, "founder_ceo");
  assert.equal(p.calls.get("research"), 2, "예산이 남아 있던 첫 '검증'은 research로 되돌아간다 (기계가 할 수 있는 일)");
  assert.deepEqual(s.gate_jumps, [
    { decider: "founder_ceo", decision: "검증", jumped_to: "research", outcome: "jump" },
    { decider: "founder_ceo", decision: "검증", jumped_to: null, outcome: "failed", reason: "ceo_decision_verify" },
  ]);
  assert.equal(s.cleared_idea_sha256, null, "사람 대기는 폐기 잠금 해제를 발급하지 않는다");
  assert.equal(typeof s.resume_from, "number", "게이트 인덱스부터 재개 가능한 중단이다 (terminal 아님)");
  rmProject(name);
});

test("[B-50] 같은 자리의 '축소' 소진은 그대로 gate_jump_budget_exhausted다 (사유가 갈린다)", async () => {
  // red: `decision === "검증"` 조건을 지우고 무조건 ceo_decision_verify를 내면 이 테스트가 빨감 —
  //      "기계가 좁히기를 두 번 시도했다"와 "사람 차례다"는 다른 사실이고 사유 코드가 그것을 나른다.
  const name = "_b50_shrink";
  makeProject(name);
  const p = ceoDeciding("- 축소");
  const s = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, now: () => FIXED })).state;

  assert.equal(s.failed_reason, "gate_jump_budget_exhausted");
  assert.equal(s.gate_jumps[0].jumped_to, "pm", "'축소'는 pm으로 되돌아간다 (research 아님)");
  assert.equal(s.gate_jumps.at(-1)?.reason, "gate_jump_budget_exhausted");
  rmProject(name);
});

test("[B-50/R1-H] 레거시 '검증' 영수증 두 형태가 섞여도 소진으로 세고 resume이 verify 사유를 덧붙인다 (모델 호출 0회)", async () => {
  // 디스크에는 `outcome` 도입 **전후**의 entry가 섞여 있을 수 있다(교착된 live 프로젝트의 run_state가 그렇다).
  // red: 사유 ternary의 '검증' case를 되돌리면 이 레거시 state의 resume이 gate_jump_budget_exhausted로 떨어진다 —
  //      즉 넷이 사람 확인 경로를 얻지 못하고 오늘의 교착에 그대로 남는다.
  const name = "_b50_legacy";
  await verifyStalledProject(name);

  const sp = join(projectPaths(name).root, "outputs/run_state.json");
  const raw = JSON.parse(readFileSync(sp, "utf8")) as { gate_jumps: Record<string, unknown>[] };
  const jump = raw.gate_jumps[0];
  const legacy = { ...jump };
  delete legacy.outcome; // outcome 도입 이전 형태 (같은 사실, 다른 바이트)
  assert.deepEqual({ ...jump }, { decider: "founder_ceo", decision: "검증", jumped_to: "research", outcome: "jump" }, "전제: 현행 형태의 '검증' jump 영수증");
  raw.gate_jumps = [jump, legacy];
  writeFileSync(sp, JSON.stringify(raw, null, 2), "utf8");
  assert.equal(loadRunState(name)?.gate_jumps[1].outcome, undefined, "전제: 두 형태가 한 state에 섞여 있다");

  const p = ceoDeciding("- 검증");
  const s = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, resume: true, now: () => FIXED })).state;

  assert.equal(totalCalls(p), 0, "복원 문서만 다시 읽는다 — 모델 호출 0회");
  assert.equal(s.failed_reason, "ceo_decision_verify", "두 형태 모두 되돌림으로 세어 소진 상태이고, 그 소진의 '검증'은 사람 차례다");
  assert.equal(s.gate_jumps.length, 3, "실패 영수증 한 줄만 늘었다 (재점프 없음)");
  assert.equal(s.gate_jumps.filter((g) => g.outcome === "jump").length, 1, "새 jump는 없다");
  assert.deepEqual(s.gate_jumps.at(-1), {
    decider: "founder_ceo",
    decision: "검증",
    jumped_to: null,
    outcome: "failed",
    reason: "ceo_decision_verify",
    decision_source: "restored_artifact",
  });
  rmProject(name);
});

test("[B-50/R1-I] '검증'이 on과 kill에 둘 다 있으면 kill이 이긴다 (kill은 어떤 '검증' 처리보다도 먼저)", async () => {
  // red: '검증' 처리를 kill 분기 **앞으로** 옮기면(예: on 조회 전 가로채기·조기 중단) killed가 아니라
  //      failed가 되고 sentinel 계약이 무너진다. kill-overlap('폐기')과 같은 잠금을 '검증'에도 건다.
  const name = "_b50_overlap";
  makeProject(name);
  const p = ceoDeciding("- 검증");
  const s = (await runWorkflow({ workflowId: "kill-overlap-verify", workflowsPath: SENTINEL_WF, project: name, provider: p, now: () => FIXED })).state;

  assert.equal(s.status, "killed", "kill 목록에 있는 토큰은 되돌림·사람 대기보다 먼저 판정된다");
  assert.equal(s.failed_reason, null, "폐기는 실패가 아니다");
  assert.equal(s.gate_jumps.at(-1)?.outcome, "kill");
  assert.equal(p.calls.get(SENTINEL), undefined, "게이트 뒤 step은 실행되지 않는다");
  assert.equal(s.kill_history.length, 1);
  rmProject(name);
});

test("[B-50] '검증' 대기 중에는 개발 표면이 열리지 않는다 — task-prompt·plan-dag 거부", async () => {
  // red: taskPrompt.ts / planDag.ts의 ceoVerifyGateStatus 가드를 지우면 둘 다 통과한다 —
  //      게이트가 "아직 개발하지 마라"로 멈춘 상태에서 개발 착수 문서가 나오는 상태 전이 우회다.
  const name = "_b50_surfaces";
  await verifyStalledProject(name);

  let caught: Error | null = null;
  try {
    buildTaskPrompt(name, "2026-01-01");
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, "'검증' 대기 상태에서 지시문을 만들지 않는다");
  assert.match(caught!.message, /ceo_decision_verify/);
  assert.match(caught!.message, /사람이 확인할 차례/, "무엇을 해야 하는지 말한다");
  assert.ok(caught!.message.includes(`${CEO_DOC}의 산문`), "고칠 파일을 이름으로 말한다");

  const ideaAbs = join(projectPaths(name).root, IDEA_REL);
  const missingApproval = join(tmpdir(), `b50-no-such-approval-${process.pid}.json`);
  assert.equal(existsSync(missingApproval), false, "전제: 승인 파일이 없다");
  assert.throws(
    () => createPlanDagRun({ run: "r1", milestone: "m1", approval: missingApproval, idea: ideaAbs }),
    /ceo_decision_verify/,
    "'검증' 검사가 승인 읽기·run 생성보다 앞이다",
  );

  // 그리고 이 거부는 사람이 판정을 바꾸면 풀린다 — 막힌 채로 끝나는 상태가 아니다.
  const doc = join(projectPaths(name).root, CEO_DOC);
  writeFileSync(doc, readFileSync(doc, "utf8").replace("## Decision\n\n- 검증", "## Decision\n\n- 진행"), "utf8");
  const after = (await runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 검증"), resume: true, now: () => FIXED })).state;
  assert.equal(after.status, "completed", "전제: 사람이 결론 판정으로 고치면 resume이 종결한다");
  assert.match(buildTaskPrompt(name, "2026-01-01"), /## Task/, "확인이 끝나면 개발 표면이 다시 열린다");
  rmProject(name);
});

test("[B-50] harness run: '검증' 소진엔 '사람이 확인할 차례' 안내가 붙는다 (예산 소진 안내와 다르다)", async () => {
  // red: run.ts의 ceo_decision_verify 분기를 지우면 무차별 "재개: ... --resume" 한 줄만 남아,
  //      기계가 이어서 할 일이 있는 것처럼 읽힌다(거짓 안내).
  const name = "_b50_cli";
  makeProject(name);
  const prevExit = process.exitCode;
  const out = await captureLogs(() =>
    runRun(
      "idea-validation", name, "mock", 1, false, undefined, false, 0, true, undefined, false,
      false, undefined, undefined, undefined,
      ceoDeciding("- 검증"),
    ),
  );
  process.exitCode = prevExit; // failed는 exit 1 — 테스트 프로세스의 종료 코드를 오염시키지 않는다

  assert.match(out, /중단 사유: ceo_decision_verify/);
  assert.match(out, /사람이 확인할 차례/, "기계가 아니라 사람의 일이라고 말한다");
  assert.ok(out.includes(`${CEO_DOC}의 산문`), "고칠 파일을 이름으로 말한다");
  assert.ok(out.includes('"## Decision"'), "고칠 절을 이름으로 말한다");
  assert.match(out, /모델 호출 0회/, "재판정 비용을 말한다");
  assert.doesNotMatch(out, /되돌림 예산이 소진됐습니다 —/, "예산 소진 안내(다른 사유)가 섞이지 않는다");
  rmProject(name);
});

test("[B-40/A-1] 게이트 통과는 '진행' 토큰 하나뿐 — 5토큰 × 3 workflow 전수", async () => {
  // kill 게이트가 있는 세 workflow에서 다섯 토큰이 각각 어디로 가는지 전수로 고정한다.
  // (mvp-planning엔 '검증' 매핑이 없다 → unmapped. 예전엔 그것이 조용히 진행했다.)
  // [B-50] 되돌림 대상이 **있는** workflow에서 '검증'이 소진되면 ceo_decision_verify(사람 차례)이고,
  // 같은 자리의 '축소'는 그대로 gate_jump_budget_exhausted다 — 두 사유가 갈리는 것을 여기서 전수로 고정한다.
  const expected: Record<string, Record<string, string>> = {
    "idea-validation": {
      진행: "completed",
      축소: "failed:gate_jump_budget_exhausted",
      검증: "failed:ceo_decision_verify", // [B-50] 되돌림 1회 후에도 '검증'이면 사람 차례 — 같은 소진, 다른 뜻
      보류: "failed:ceo_decision_hold",
      폐기: "killed",
    },
    "mvp-planning": {
      진행: "completed",
      축소: "failed:gate_jump_budget_exhausted",
      // [B-50/live] 매핑이 없어도 '검증'은 **사람 차례**다(정의 오류가 아니다). 2026-09-01 live 2단계가
      // 이것을 드러냈다 — `ceo_decision_unmapped`로 떨어져 복구 안내가 안 나갔다.
      검증: "failed:ceo_decision_verify",
      보류: "failed:ceo_decision_hold",
      폐기: "killed",
    },
    "full-predev": {
      진행: "completed",
      축소: "failed:gate_jump_budget_exhausted",
      검증: "failed:ceo_decision_verify", // [B-50]
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

test("[B-40/A-3] 해제 증거는 kill 게이트만 발급한다 — 게이트 없는 workflow의 완주는 발급 안 함", async () => {
  // 해제를 게이트 밖에서 적으면 그 경로가 곧 우회 통로다. dev-preflight엔 게이트가 아예 없으므로
  // 완주해도 cleared_idea_sha256은 null이어야 한다.
  const name = "_b40_noclear";
  makeProject(name);
  // [B-41/1단] dev-preflight에는 내부 승인 게이트가 있다 → 응답자를 **명시**해야 시작한다
  // (예전엔 미지정이 자동 승인이었다). 단정을 약화한 것이 아니라 계약이 강해졌다.
  const r = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED, approve: async () => true });
  assert.equal(r.state.status, "completed", "전제: 완주한다");
  assert.equal(r.state.cleared_idea_sha256, null, "kill 게이트 없는 workflow의 완주는 해제 증거가 아니다");
  assert.deepEqual(r.state.kill_history, []);

  // kill-sentinel fixture의 게이트는 kill을 가졌다 → '진행'이면 발급한다 (대조군).
  const withGate = await runWorkflow({
    workflowId: "kill-sentinel",
    workflowsPath: SENTINEL_WF,
    project: name,
    provider: ceoDeciding("- 진행"),
    now: () => FIXED,
  });
  assert.equal(withGate.state.cleared_idea_sha256, snapshotProjectIdea(name).sha256, "kill 게이트 '진행' → 발급");
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
  assert.equal(reeval.state.cleared_idea_sha256, snapshotProjectIdea(name).sha256, "'진행' 판정이 해제 digest를 발급");
  assert.equal(reeval.state.kill_history.length, 1, "폐기 이력은 지워지지 않는다 (carry forward)");

  // 해제 후에는 잠금 없는 경로가 열린다.
  const after = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED, approve: async () => true });
  assert.equal(after.state.status, "completed");
  assert.equal(after.state.kill_history.length, 1, "그 뒤 run도 폐기 이력을 이어받는다");
  assert.equal(after.state.cleared_idea_sha256, snapshotProjectIdea(name).sha256, "해제 증거도 이어받는다");
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
  // **안내 문구가 해제 조건을 정확히 말해야 한다**(Codex 4차 검증 A-4 부분 지적): 잠금을 푸는 것은
  // 아이디어 수정이 아니라 **재평가 run의 '진행' 판정**이다(`ideaGateStatus` — 같은 바이트로도 해제된다).
  // 이전 단정은 "아이디어를 고쳐 새 run으로 시작"이라는 **틀린 계약을 고정**하고 있었다.
  assert.match(out, /재평가 run/, "해제 조건(재평가 판정)을 안내한다");
  assert.match(out, /아이디어를 고치지 않아도 재평가는 돌 수 있고/, "수정이 조건이 아니라는 사실까지 말한다");
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

// ── A-1: 심사한 바이트와 기록한 digest의 결박 (TOCTOU) ─────────
test("[B-40/A-1] 해제 digest는 CEO가 실제로 본 바이트의 것이다 (판정 후 파일이 바뀌어도)", async () => {
  const name = "_b40_toctou";
  // 잠금이 살아 있는 상태에서 재평가한다 — 그래야 "무엇이 해제됐나"가 하류에서 관측된다.
  await killedProject(name, "심사 대상 아이디어");
  const seenIdeas: string[] = [];
  const beforeDigest = snapshotProjectIdea(name).sha256;

  // founder_ceo가 판정을 낸 **직후** 아이디어 파일을 바꾼다 (게이트가 파일을 다시 읽으면 이것이 해제된다).
  const provider: Provider = {
    id: "mock",
    async generate(input: AgentRunInput): Promise<AgentResult> {
      seenIdeas.push(input.ideaContent);
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== "founder_ceo") return r;
      editIdea(name, "게이트 뒤에 몰래 바뀐 아이디어");
      return { ...r, markdown: r.markdown.replace("## Decision\n\n- 진행\n", "## Decision\n\n- 진행\n") };
    },
  };
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider, now: () => FIXED });

  assert.equal(r.state.status, "completed");
  assert.equal(r.state.cleared_idea_sha256, beforeDigest, "CEO가 심사한 바이트가 해제된다");
  assert.notEqual(r.state.cleared_idea_sha256, snapshotProjectIdea(name).sha256, "바뀐 파일은 해제되지 않았다");
  // run 안의 모든 agent가 같은 snapshot을 봤다 (agent마다 파일을 다시 읽지 않는다).
  assert.ok(seenIdeas.length >= 5, `agent 호출 ${seenIdeas.length}건`);
  assert.equal(new Set(seenIdeas).size, 1, "run 안의 모든 프롬프트가 같은 아이디어 바이트를 봤다");
  assert.match(seenIdeas[0], /심사 대상 아이디어/);

  // ⓑ 그 결과 **현재 파일**(심사받지 않은 바이트)은 해제되지 않았다 → 하류가 거부한다.
  //   게이트가 나중에 파일을 다시 읽었다면 여기서 통과해버린다.
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked/, "심사되지 않은 바이트로는 지시문을 만들 수 없다");
  rmProject(name);
});

test("[B-40/A-1] kill digest도 CEO가 본 바이트의 것이다", async () => {
  const name = "_b40_toctou_kill";
  makeProject(name, "죽을 아이디어");
  const beforeDigest = snapshotProjectIdea(name).sha256;
  const provider: Provider = {
    id: "mock",
    async generate(input: AgentRunInput): Promise<AgentResult> {
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== "founder_ceo") return r;
      const markdown = r.markdown.replace("## Decision\n\n- 진행\n", "## Decision\n\n- 폐기\n");
      editIdea(name, "판정 뒤 바뀐 아이디어");
      return { ...r, markdown };
    },
  };
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider, now: () => FIXED });
  assert.equal(r.state.status, "killed");
  assert.equal(r.state.killed_by?.idea_sha256, beforeDigest, "폐기된 것은 CEO가 본 바이트다");
  assert.equal(r.state.kill_history[0].idea_sha256, beforeDigest);
  rmProject(name);
});

// ── A-2: 게이트 결과가 CLI·vault에서 정직하게 렌더된다 ──────────
test("[B-40/A-2] 게이트 실패 4종이 CLI·vault에서 '진행'이 아니라 '중단(코드)'로 기록된다", async () => {
  // 5개 실패 코드 × 2개 소비자(CLI · vault) = 10건. 예전엔 전부 "→ 진행"이었다(durable은 failed인데).
  const cases: Array<{ wf: string; token: string; code: string; wfPath?: string }> = [
    { wf: "idea-validation", token: "보류", code: "ceo_decision_hold" },
    // [B-50/live] unmapped 대표를 `kill-overlap`+'축소'로 옮긴다 — 그 fixture는 on={"폐기"}뿐이라
    // '축소'가 매핑 없음이다. mvp-planning+'검증'은 이제 verify로 갈리므로 **커버리지를 잃지 않으려고**
    // 대표를 바꾸고 verify 사례를 하나 **추가**했다(4종 → 5종).
    { wf: "kill-overlap", token: "축소", code: "ceo_decision_unmapped", wfPath: SENTINEL_WF },
    { wf: "mvp-planning", token: "검증", code: "ceo_decision_verify" },
    { wf: "idea-validation", token: "축소", code: "gate_jump_budget_exhausted" },
    { wf: "kill-badtarget", token: "축소", code: "gate_jump_target_missing", wfPath: SENTINEL_WF },
  ];
  for (const c of cases) {
    const name = `_b40_render_${c.code}`;
    makeProject(name);
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const vault = join(tmpdir(), `b40-v-${process.pid}-${c.code}`);
    const out = await captureLogs(() =>
      runRun(c.wf, name, "mock", 1, false, vault, false, 0, true, undefined, false, false, undefined, undefined, undefined, ceoDeciding(`- ${c.token}`), c.wfPath),
    );
    assert.equal(process.exitCode, 1, `${c.code}: agent 실패류는 exit 1`);
    process.exitCode = prevExit;

    const s = loadRunState(name)!;
    assert.equal(s.failed_reason, c.code, `${c.code}: durable 사유`);
    assert.equal(s.gate_jumps.at(-1)?.outcome, "failed", `${c.code}: outcome=failed`);
    assert.equal(s.gate_jumps.at(-1)?.reason, c.code, `${c.code}: gate_jumps에도 사유`);
    // CLI
    assert.match(out, new RegExp(`게이트: founder_ceo 판정 '${c.token}' → 중단\\(${c.code}\\)`), `${c.code}: CLI 렌더`);
    assert.doesNotMatch(out, new RegExp(`판정 '${c.token}' → 진행`), `${c.code}: CLI가 '진행'이라 적지 않는다`);
    assert.match(out, new RegExp(`중단 사유: ${c.code}`), `${c.code}: CLI가 사유 코드를 출력한다`);
    // vault
    const index = readFileSync(join(vault, name, `${c.wf}_run.md`), "utf8");
    assert.match(index, new RegExp(`게이트: founder_ceo 판정 '${c.token}' → 중단\\(${c.code}\\)`), `${c.code}: vault 렌더`);
    assert.doesNotMatch(index, new RegExp(`판정 '${c.token}' → 진행`), `${c.code}: vault가 '진행'이라 적지 않는다`);
    rmSync(vault, { recursive: true, force: true });
    rmProject(name);
  }
});

// ── A-3: 구조 손상 state도 잠금을 지우지 못한다 ─────────────────
test("[B-40/A-3] JSON은 되지만 구조가 손상된 state → 거부 · 파일 바이트 불변", async () => {
  const shapes: Array<{ label: string; json: string }> = [
    {
      label: "killed인데 kill_history 없음",
      json: JSON.stringify({ workflow_id: "idea-validation", status: "killed", killed_by: { decider: "founder_ceo", decision: "폐기" } }),
    },
    {
      label: "kill_history가 배열이 아님",
      json: JSON.stringify({ workflow_id: "idea-validation", status: "completed", kill_history: { decider: "x" } }),
    },
    {
      label: "kill_history 원소에 idea_sha256 없음",
      json: JSON.stringify({ workflow_id: "idea-validation", status: "killed", kill_history: [{ decider: "founder_ceo", decision: "폐기" }] }),
    },
    {
      label: "cleared_idea_sha256 타입 오류",
      json: JSON.stringify({ workflow_id: "idea-validation", status: "completed", kill_history: [], cleared_idea_sha256: 42 }),
    },
  ];
  for (const shape of shapes) {
    const name = "_b40_shape";
    makeProject(name);
    const statePath = join(projectPaths(name).outputs, "run_state.json");
    writeFileSync(statePath, shape.json, "utf8");

    await assert.rejects(
      runWorkflow({ workflowId: "idea-validation", project: name, provider: ceoDeciding("- 진행"), now: () => FIXED }),
      /run_state_unreadable/,
      `${shape.label}: 새 run 거부`,
    );
    assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /run_state_unreadable/, `${shape.label}: task-prompt 거부`);
    assert.equal(readFileSync(statePath, "utf8"), shape.json, `${shape.label}: 파일 바이트 불변`);
    rmProject(name);
  }
});

test("[B-40/A-3] 정상 구버전 state(새 필드 없음)는 그대로 통과한다 — 하위 호환", async () => {
  const name = "_b40_legacy";
  makeProject(name);
  // B-40 이전 형태: kill_history·cleared_idea_sha256가 아예 없는 completed state.
  writeFileSync(
    join(projectPaths(name).outputs, "run_state.json"),
    JSON.stringify({ workflow_id: "idea-validation", project: name, status: "completed", completed_steps: ["founder_ceo"] }),
    "utf8",
  );
  const r = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: mockProvider, now: () => FIXED, approve: async () => true });
  assert.equal(r.state.status, "completed", "구버전 state는 잠금 없음");
  assert.deepEqual(r.state.kill_history, []);
  assert.match(buildTaskPrompt(name, "2026-01-01"), /## Task/);
  rmProject(name);
});

// ── C: target 부재는 예산과 무관하게 자기 코드를 갖는다 ─────────
test("[B-40/C] gate 되돌림 대상 부재는 예산이 0이든 1이든 gate_jump_target_missing", async () => {
  for (const wf of ["kill-badtarget", "kill-badtarget-nobudget"]) {
    const name = `_b40_c_${wf}`;
    makeProject(name);
    const r = await runWorkflow({
      workflowId: wf,
      workflowsPath: SENTINEL_WF,
      project: name,
      provider: ceoDeciding("- 축소"),
      now: () => FIXED,
    });
    assert.equal(r.state.status, "failed", `${wf}: 진행하지 않는다`);
    assert.equal(r.state.failed_reason, "gate_jump_target_missing", `${wf}: 원인에 맞는 코드 (예산 소진이 아니다)`);
    rmProject(name);
  }
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

// ── [C-127] 필수 섹션 미충족 = 채택 거부 ───────────────────────
//
// 구멍: 재생성 상한을 소진하고도 필수 절이 없는 문서가 `completed_steps`에 등재되고 findings로
// 하류에 실렸다(status는 completed). `persistFinalOutcome`의 가드가 그 채택을 막는다.

/** 지정 agent의 출력에서 `## <header>` 절 하나를 지우는 mock 래퍼. 그 외 agent는 mock 원본. */
function breakSection(
  agentId: string,
  header: string,
  opts: { healAfter?: number } = {},
): Provider & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  let broken = 0;
  return {
    id: "mock",
    calls,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      calls.set(input.agent.agent_id, (calls.get(input.agent.agent_id) ?? 0) + 1);
      const r = await mockProvider.generate(input);
      if (input.agent.agent_id !== agentId) return r;
      // healAfter: n회 깨뜨린 뒤부터는 정상 출력. resume이 실제로 완주 가능한지 재는 데 쓴다
      // (1회차 run은 최초 호출 + 재생성 1회 = 2회를 쓴다).
      if (opts.healAfter !== undefined && broken >= opts.healAfter) return r;
      broken++;
      const re = new RegExp(`^## ${header}\\n[\\s\\S]*?(?=^## )`, "m");
      const markdown = r.markdown.replace(re, "");
      assert.notEqual(markdown, r.markdown, `${agentId}의 "## ${header}" 절 제거 실패 — mock 출력 형식이 바뀌었다`);
      return { ...r, markdown };
    },
  };
}

test("[C-127] 재생성 상한 후 필수 섹션 미충족 → failed(required_sections_missing) · 채택 없음 · 후속 step 0회", async () => {
  const name = "_c127_block";
  makeProject(name);
  const p = breakSection("pm", "Risks");
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, now: () => FIXED });
  const s = r.state;

  assert.equal(s.status, "failed", "깨진 산출물이 completed로 채택되지 않는다");
  assert.equal(s.failed_reason, "required_sections_missing");
  assert.equal(s.failed_agent, "pm");
  assert.equal(s.resume_from, 2, "pm step(index 2)부터 재개 — 고치면 이어진다");
  assert.equal(s.completed_steps.includes("pm"), false, "완료로 세지 않는다");
  assert.deepEqual(s.completed_steps, ["chief_of_staff", "research"], "앞 step만 완료");
  assert.equal(p.calls.get("pm"), 2, "재생성 상한(기본 1)까지 쓰고 나서 멈췄다");
  assert.equal(p.calls.get("red_team") ?? 0, 0, "후속 step 미실행");
  assert.equal(p.calls.get("founder_ceo") ?? 0, 0, "게이트 decider도 미실행");
  assert.deepEqual(s.warnings, [{ agent_id: "pm", missing: ["Risks"] }], "누락 헤더는 durable하게 남는다");
  // [C-127/A-1] 계약 미충족이면 **디스크를 건드리지 않는다**. 운영자에게 필요한 정보(누락 헤더
  // 이름)는 위 warnings에 이미 있다. 저장 후 차단은 revise가 기존 채택본을 파괴한다(A-1 테스트 참조).
  assert.equal(existsSync(join(projectPaths(name).root, "docs/02_PRD.md")), false, "깨진 산출물을 쓰지 않는다");
  rmProject(name);
});

test("[C-127] resume은 실패 step부터 재실행하고 계약 충족 시 완주한다", async () => {
  const name = "_c127_resume";
  makeProject(name);
  const p = breakSection("pm", "Risks", { healAfter: 2 });
  const first = await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, now: () => FIXED });
  assert.equal(first.state.status, "failed", "전제: 1회차는 계약 미달로 멈춘다");
  assert.equal(first.state.failed_reason, "required_sections_missing", "전제: 다른 이유로 멈춘 것이 아니다");
  assert.equal(first.state.resume_from, 2);

  const again = await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, resume: true, now: () => FIXED });
  const s = again.state;
  assert.equal(s.status, "completed", "계약을 만족하면 완주한다 (막다른 골목이 아니다)");
  assert.equal(s.failed_reason, null);
  assert.equal(s.resume_from, null);
  assert.deepEqual(s.completed_steps, ["chief_of_staff", "research", "pm", "red_team", "founder_ceo"]);
  assert.equal(p.calls.get("chief_of_staff"), 1, "완료 step은 재실행하지 않는다 (LLM 재호출 없음)");
  assert.equal(p.calls.get("pm"), 3, "실패한 pm만 다시 돈다 (1회차 2번 + resume 1번)");
  rmProject(name);
});

test("[C-127] Decision 절이 아예 없으면 게이트 전에 required_sections_missing으로 멈춘다", async () => {
  const name = "_c127_ceo";
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
  // founder_ceo의 required_headers가 ["Decision"]이라 **게이트에 닿기 전** 채택 단계에서 걸린다.
  // 게이트의 ceo_decision_absent는 여전히 살아 있다 — 그 방어선은 위 [B-40/A-1] 테스트가 잰다.
  assert.equal(s.status, "failed");
  assert.equal(s.failed_reason, "required_sections_missing");
  assert.equal(s.failed_agent, "founder_ceo");
  assert.equal(s.completed_steps.includes("founder_ceo"), false, "판정 절 없는 문서는 완료로 세지 않는다");
  assert.equal(p.calls.get(SENTINEL) ?? 0, 0, "게이트 뒤 sentinel step 미실행");
  rmProject(name);
});

// ── [C-127] required_headers를 공용 출력 지시에서도 재강조한다 ──
//
// **무엇이 빠져 있었나**: 헤더 이름은 역할 프롬프트에 이미 있었다(`agents/pm_product_strategy_agent.md`
// §21 등). 없던 것은 **모델이 마지막으로 읽는 공용 출력 지시에서의 재강조**이고, `promptParts`에는
// founder_ceo의 `["Decision"]`만 문자열로 하드코딩돼 있었다.
// 근거: live 실측(claude-code · 표본 3 · 전부 수정 전 코드) pm 1차 준수율 **1/3** — 역할 프롬프트만으로는
// 일관되지 않았다. 그리고 B-40이 `Decision` 하나에 대해 같은 교훈을 이미 남겼다.
// (수정 후 준수율은 미측정 — 개선을 주장하지 않는다.)

/** required_headers가 없는 agent가 받는 최종 섹션 목록 줄 — C-127 이전 바이트 그대로 동결한다. */
const NO_REQUIRED_HEADER_LINE = "Input Summary / Main Judgment / Key Findings / Decisions / Assumptions /";

function promptFor(agent: AgentDef): string {
  return buildPromptParts(
    {
      agent,
      workflowId: "w",
      project: "p",
      createdAt: FIXED,
      commonPrompt: "COMMON",
      agentPrompt: "ROLE",
      ideaContent: "idea",
      priorFindings: [],
    },
    "claude-code",
  ).user;
}

/** 최종 출력 지시의 "## 섹션" 목록 첫 줄. */
function sectionListLine(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.includes("Input Summary / Main Judgment"));
  assert.ok(line, "최종 섹션 목록 줄을 찾지 못했다 — 프롬프트 구조가 바뀌었다");
  return line!;
}

test("[C-127] required_headers가 프롬프트에 실린다 — 검증기와 같은 출처", () => {
  const registry = loadAgentRegistry();
  for (const id of ["pm", "design", "tech_lead"]) {
    const agent = findAgent(registry, id)!;
    const headers = agent.required_headers ?? [];
    assert.ok(headers.length > 0, `fixture 전제: ${id}는 required_headers를 갖는다`);
    const prompt = promptFor(agent);
    // 문자열 리터럴이 아니라 **레지스트리 배열을 그대로 순회**한다 — 수기 복제면 여기서 갈린다.
    for (const h of headers) {
      assert.ok(prompt.includes(`\n## ${h}`) || sectionListLine(prompt).includes(h), `${id} 프롬프트에 "${h}"가 실린다`);
    }
    // 검증기가 보는 것과 지시하는 것이 같은 배열인지: 하나라도 빠지면 만족 불가능한 계약이다.
    assert.equal(
      validateAgentOutput(`# x\n\n## Metadata\n\n## Main Judgment\n\n## Risks\n\n## Recommended Next Actions\n` + headers.map((h) => `\n## ${h}\n`).join(""), headers).ok,
      true,
      `${id}: 프롬프트가 지시하는 헤더 집합만으로 검증을 통과할 수 있어야 한다`,
    );
  }

  // **출처 판별**: 레지스트리에 없는 임의 헤더도 실려야 한다. 하드코딩 복제본이면 실리지 않는다.
  const synthetic: AgentDef = {
    agent_id: "_synthetic",
    name: "S",
    role: "r",
    prompt_path: "p",
    default_output: "docs/x.md",
    required_headers: ["ZZ 임의 헤더 하나", "ZZ 임의 헤더 둘"],
  };
  const line = sectionListLine(promptFor(synthetic));
  assert.ok(line.startsWith("ZZ 임의 헤더 하나 / ZZ 임의 헤더 둘 / Input Summary"), `임의 헤더가 그대로 실린다: ${line}`);
});

test("[C-127] required_headers가 없는 agent의 프롬프트는 바이트 불변", () => {
  const registry = loadAgentRegistry();
  for (const id of ["chief_of_staff", "research", "ux_ui", "red_team"]) {
    const agent = findAgent(registry, id)!;
    assert.equal(agent.required_headers, undefined, `fixture 전제: ${id}는 required_headers가 없다`);
    const prompt = promptFor(agent);
    // ① 섹션 목록 줄이 C-127 이전 바이트와 정확히 같다 (동결된 리터럴).
    assert.equal(sectionListLine(prompt), NO_REQUIRED_HEADER_LINE, `${id}: 섹션 목록 줄 불변`);
    // ② 새 코드 경로가 이들에게는 완전한 no-op이다 — 필드를 지운 사본과 바이트가 같다.
    assert.equal(prompt, promptFor({ ...agent, required_headers: undefined }), `${id}: 프롬프트 전체 바이트 불변`);
  }
});

test("[C-127] founder_ceo의 Decision 지시가 하드코딩 제거 후에도 사라지지 않는다", () => {
  const ceo = findAgent(loadAgentRegistry(), "founder_ceo")!;
  const prompt = promptFor(ceo);
  // 하드코딩 삼항("founder_ceo면 'Decision / '")을 required_headers 일반 주입으로 바꿨다.
  // 그 결과 이 줄의 바이트는 **이전과 동일**해야 한다 — 게이트 계약이 프롬프트에서 사라지면
  // live 모델이 절을 빼고 ceo_decision_absent로 멈춘다(만족 불가능한 계약).
  assert.deepEqual(ceo.required_headers, ["Decision"], "fixture 전제");
  assert.equal(sectionListLine(prompt), `Decision / ${NO_REQUIRED_HEADER_LINE}`, "Decision이 목록 맨 앞에 그대로 있다");
  assert.match(prompt, /"## Decision" 절은 필수다/, "판정 절 전용 지시도 그대로다");
});

// ── [C-127/A-1] 차단이 기존 채택본을 파괴하지 않는다 ────────────
//
// C-127 초판은 `saveArtifact` **뒤에서** 차단했다. 최초 채택이면 무해하지만, 비평 루프의 revise는
// `completed_steps`에 **이미 있는** agent의 문서를 덮는다 — 계약 미달 revise가 정상 바이트를
// 파괴하고, completed_steps에서는 제거되지 않으므로 resume이 그 깨진 파일을 완료 산출물로
// 복원하고 최종 manifest가 그것을 결박한다. C-127이 닫으려던 부류를 C-127이 새로 만드는 모양.

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

test("[C-127/A-1] revise 실패는 이미 채택된 산출물을 덮지 않는다", async () => {
  const name = "_c127_revise";
  makeProject(name);
  const TECH_PLAN = join(projectPaths(name).root, "docs/04_TECH_PLAN.md");

  let adopted = ""; // tech_lead 최초 채택본(정상)
  let brokenRevises = 0;
  const calls = new Map<string, number>();
  const provider: Provider = {
    id: "mock",
    async generate(input: AgentRunInput): Promise<AgentResult> {
      calls.set(input.agent.agent_id, (calls.get(input.agent.agent_id) ?? 0) + 1);
      const r = await mockProvider.generate(input);
      // critic은 Critical을 낸다 — 안 그러면 루프가 즉시 resolved로 끝나 revise 자체가 안 돈다.
      if (input.agent.agent_id === "red_team") {
        const md = r.markdown.replace("### Critical\n\n- (없음)\n", "### Critical\n\n- [MOCK] 치명 리스크\n");
        assert.notEqual(md, r.markdown, "Critical 주입 실패 — mock 출력 형식이 바뀌었다");
        return { ...r, markdown: md };
      }
      if (input.agent.agent_id !== "tech_lead") return r;
      if (!input.revisionRequest) {
        adopted = r.markdown; // 최초 채택본
        return r;
      }
      // revise: 처음 2회(최초 시도 + 재생성 1회)만 계약을 깬다. 그 뒤(resume)는 정상.
      if (brokenRevises >= 2) return r;
      brokenRevises++;
      const md = r.markdown.replace(/^## Risks\n[\s\S]*?(?=^## )/m, "");
      assert.notEqual(md, r.markdown, "'## Risks' 절 제거 실패 — mock 출력 형식이 바뀌었다");
      return { ...r, markdown: md };
    },
  };

  const first = await runWorkflow({
    workflowId: "critique-revise",
    workflowsPath: CRITIQUE_WF,
    project: name,
    provider,
    now: () => FIXED,
  });
  assert.equal(first.state.status, "failed", "전제: revise가 계약 미달이라 멈춘다");
  assert.equal(first.state.failed_reason, "required_sections_missing");
  assert.equal(first.state.failed_agent, "tech_lead");
  assert.equal(brokenRevises, 2, "전제: revise가 재생성까지 쓰고 실패했다");
  assert.ok(adopted.length > 0, "전제: 최초 채택본을 캡처했다");
  assert.equal(first.state.completed_steps.includes("tech_lead"), true, "최초 채택은 유효하다 — 취소되지 않는다");

  // ── 핵심 단정: 디스크 바이트가 revise 전과 **동일**하다 ──
  assert.equal(sha256(readFileSync(TECH_PLAN, "utf8")), sha256(adopted), "revise 실패가 채택본을 덮지 않았다");
  assert.equal(validateAgentOutput(readFileSync(TECH_PLAN, "utf8"), ["리스크와 완화책"]).ok, true, "디스크 문서는 여전히 계약을 만족한다");

  // ── resume: 완주하고 최종 문서도 정상 바이트다 (깨진 파일이 결박되지 않는다) ──
  const again = await runWorkflow({
    workflowId: "critique-revise",
    workflowsPath: CRITIQUE_WF,
    project: name,
    provider,
    resume: true,
    now: () => FIXED,
  });
  assert.equal(again.state.status, "completed");
  const finalMd = readFileSync(TECH_PLAN, "utf8");
  const techLead = findAgent(loadAgentRegistry(), "tech_lead")!;
  assert.equal(validateAgentOutput(finalMd, techLead.required_headers ?? []).ok, true, "최종 채택본이 계약을 만족한다");
  assert.equal(again.state.completed_steps.includes("tech_lead"), true);
  rmProject(name);
});

// ── [C-125] 아이디어 비평→개정 루프 · 라운드 예산 durable화 ────────────
//
// idea-validation의 평문 `red_team`이 pm을 겨눈 critique_loop으로 교체됐다. 비평이 보고서로만 남지 않고
// **아이디어의 하네스 해석본(docs/02_PRD.md)을 실제로 고친다.** 원본 `00_IDEA.md`는 여전히 사람 소유다 —
// 하네스에 그 파일을 쓰는 경로가 없다는 것을 이 테스트가 바이트로 못박는다(B-40).
//
// 관측 수단은 **critic 호출 수**다: `critique_rounds.rounds`는 재개 여부와 무관하게 2로 같아서
// "예산이 다시 열렸나"를 구분하지 못한다.

/** [C-125] fixture workflow: pm 채택 → red_team 루프(±되돌림 게이트). */
const CRITIQUE_RESUME_WF = join(HERE, "..", "..", "tests", "fixtures", "workflows", "critique-resume.json");

/**
 * [C-125] red_team이 **항상** Critical을 내는 mock 래퍼 — 안 그러면 루프가 R1에서 조기 종료해
 * revise도 라운드 예산도 관측되지 않는다. revise 산출물에는 마커를 심어 "채택된 바이트가 개정본인가"를
 * 파일에서 직접 읽는다.
 *
 * - `throwOnCriticCall`: n번째 critic 호출에서 throw (루프 **중간** 실패를 만드는 유일한 수단 —
 *   max_rounds=2에서는 R2 revise가 없으므로 R2 critic이 그 자리다).
 * - `ceoDecisions`: founder_ceo 호출 순서대로 정본 판정을 갈아끼운다 (게이트 되돌림 유도).
 */
function critiqueProvider(opts: { throwOnCriticCall?: number; ceoDecisions?: string[] } = {}): Provider & {
  calls: Map<string, number>;
  criticCalls: () => number;
  reviseCalls: () => number;
} {
  const calls = new Map<string, number>();
  let criticCalls = 0;
  let reviseCalls = 0;
  let ceoCalls = 0;
  return {
    id: "mock",
    calls,
    criticCalls: () => criticCalls,
    reviseCalls: () => reviseCalls,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      const id = input.agent.agent_id;
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === "red_team") {
        criticCalls++;
        if (opts.throwOnCriticCall === criticCalls) throw new Error(`강제 실패(critic R${criticCalls})`);
      }
      if (input.revisionRequest) reviseCalls++;
      const r = await mockProvider.generate(input);
      if (id === "red_team") {
        const md = r.markdown.replace("### Critical\n\n- (없음)\n", "### Critical\n\n- [MOCK] 치명 리스크\n");
        assert.notEqual(md, r.markdown, "Critical 주입 실패 — mock 출력 형식이 바뀌었다");
        return { ...r, markdown: md };
      }
      if (id === "founder_ceo" && opts.ceoDecisions) {
        const decision = opts.ceoDecisions[Math.min(ceoCalls, opts.ceoDecisions.length - 1)];
        ceoCalls++;
        const DEFAULT = "## Decision\n\n- 진행\n";
        assert.ok(r.markdown.includes(DEFAULT), "mock founder_ceo 출력에 정본 판정 절이 없다 — mock 형식이 바뀌었다");
        return { ...r, markdown: r.markdown.replace(DEFAULT, `## Decision\n\n- ${decision}\n`) };
      }
      if (input.revisionRequest) {
        const md = r.markdown.replace("## Main Judgment\n", "## Main Judgment\n\n- [C125-REVISED] 비평 반영본\n");
        assert.notEqual(md, r.markdown, "revise 마커 주입 실패 — mock 출력 형식이 바뀌었다");
        return { ...r, markdown: md };
      }
      return r;
    },
  };
}

test("[C-125] idea-validation: red_team Critical → pm 문서 revise · 00_IDEA.md 바이트 불변", async () => {
  const name = "_c125_idea";
  makeProject(name);
  const ideaPath = join(projectPaths(name).root, IDEA_REL);
  const ideaBefore = sha256(readFileSync(ideaPath, "utf8"));

  const p = critiqueProvider();
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider: p, now: () => FIXED });
  assert.equal(r.state.status, "completed");

  // ── 비평이 문서를 고쳤다 (보고서로만 남지 않는다) ──
  const prd = readFileSync(join(projectPaths(name).root, "docs/02_PRD.md"), "utf8");
  assert.match(prd, /\[C125-REVISED\]/, "채택된 PRD가 비평 반영본이다");
  assert.equal(p.reviseCalls(), 1, "R1에서 정확히 한 번 revise (R2는 라운드 소진이라 revise 없음)");
  assert.deepEqual(r.state.critique_rounds, [{ target: "pm", critic: "red_team", rounds: 2, resolved: false }]);

  // ── [B-40] 원본 아이디어는 하네스가 쓰지 않는다 ──
  assert.equal(sha256(readFileSync(ideaPath, "utf8")), ideaBefore, "00_IDEA.md 바이트 불변");
  assert.equal(r.state.cleared_idea_sha256, ideaBefore, "해제 digest는 run 시작 snapshot의 digest 그대로");

  // ── 완료 집합·순서는 평문 red_team 때와 동일 (checkpoint artifacts/seeds 집합 불변) ──
  assert.deepEqual(r.state.completed_steps, ["chief_of_staff", "research", "pm", "red_team", "founder_ceo"]);
  rmProject(name);
});

test("[C-125] 라운드 예산 durable: 루프 중 실패 → critique_round 기록 · resume은 남은 라운드만 돈다", async () => {
  const name = "_c125_resume";
  makeProject(name);
  const wf = { workflowId: "critique-resume", workflowsPath: CRITIQUE_RESUME_WF, project: name, now: () => FIXED };

  // run 1: R1 critic→revise 뒤 R2 critic에서 실패
  const p1 = critiqueProvider({ throwOnCriticCall: 2 });
  const first = await runWorkflow({ ...wf, provider: p1 });
  assert.equal(first.state.status, "failed");
  assert.equal(first.state.failed_agent, "red_team");
  assert.equal(p1.criticCalls(), 2, "전제: R2 critic 자리에서 죽었다");
  assert.deepEqual(first.state.loop_state, { step_index: 1, critique_round: 2 }, "실패한 라운드가 durable로 남는다");
  assert.deepEqual(first.state.critique_rounds, [], "루프 미완주 — 영수증 없음(기존 계약)");

  // run 2: resume — 예산이 0부터 다시 열리지 않는다
  const p2 = critiqueProvider();
  const again = await runWorkflow({ ...wf, provider: p2, resume: true });
  assert.equal(again.state.status, "completed");
  assert.equal(p2.criticCalls(), 1, "실패한 R2 하나만 재시도 (R1 재개방 없음)");
  assert.equal(p2.reviseCalls(), 0, "R2는 라운드 소진이라 revise가 없다");
  assert.deepEqual(again.state.critique_rounds, [{ target: "pm", critic: "red_team", rounds: 2, resolved: false }]);
  assert.equal(again.state.loop_state, null, "완주하면 힌트는 남지 않는다");
  rmProject(name);
});

test("[C-125] 루프 밖 실패에서는 critique_round가 없다 (additive · 구버전 run_state와 바이트 동일)", async () => {
  const name = "_c125_plain";
  makeProject(name);
  const provider: Provider = {
    id: "mock",
    async generate(input: AgentRunInput): Promise<AgentResult> {
      if (input.agent.agent_id === "pm") throw new Error("강제 실패(pm)");
      return mockProvider.generate(input);
    },
  };
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider, now: () => FIXED });
  assert.equal(r.state.status, "failed");
  assert.deepEqual(r.state.loop_state, { step_index: 2 }, "평문 step 실패 — 라운드 필드 자체가 없다");
  assert.equal("critique_round" in (r.state.loop_state as object), false);
  const raw = readFileSync(join(projectPaths(name).root, "outputs/run_state.json"), "utf8");
  assert.equal(raw.includes('"critique_round"'), false, "디스크 바이트에도 새 키가 없다 (복수형 critique_rounds와 구분)");
  rmProject(name);
});

test("[C-125/R1-A] 게이트 재진입은 resume 힌트를 재사용하지 않는다", async () => {
  const name = "_c125_gate";
  makeProject(name);
  const wf = { workflowId: "critique-resume-gate", workflowsPath: CRITIQUE_RESUME_WF, project: name, now: () => FIXED };

  // run 1: R2 critic 실패 → 힌트 critique_round=2가 durable로 남는다
  const first = await runWorkflow({ ...wf, provider: critiqueProvider({ throwOnCriticCall: 2 }) });
  assert.equal(first.state.status, "failed");
  assert.deepEqual(first.state.loop_state, { step_index: 1, critique_round: 2 }, "전제: 철 지난 힌트가 존재한다");

  // run 2: resume → 루프 완주(R2만) → CEO '축소' → pm 되돌림 → **같은 루프 인덱스 재진입**
  const rounds: number[] = [];
  const reporter = {
    emit(e: RunEvent): void {
      if (e.type === "step_start" && e.kind === "critic") rounds.push(e.round ?? 0);
    },
  };
  const again = await runWorkflow({
    ...wf,
    provider: critiqueProvider({ ceoDecisions: ["축소", "진행"] }),
    resume: true,
    reporter,
  });
  assert.equal(again.state.status, "completed");
  assert.deepEqual(again.state.gate_jumps.map((g) => g.outcome), ["jump", "proceed"], "전제: 게이트가 실제로 되돌렸다");
  // 힌트를 소비하지 않으면 재진입 pass가 옛 실패 라운드를 이어받아 [2, 2]가 된다 — R1이 사라진다.
  assert.deepEqual(rounds, [2, 1, 2], "resume pass는 남은 R2만, 재진입 pass는 R1부터");
  assert.deepEqual(again.state.critique_rounds.map((c) => c.rounds), [2, 2], "pass마다 영수증 한 건");
  rmProject(name);
});

/**
 * [B-50/live] **'검증' 매핑이 아예 없는 게이트에서도 사람 차례로 끝난다.**
 * 2026-09-01 live 2단계(`mvp-planning`)가 이 구멍을 드러냈다 — 그 게이트의 on은 `{"축소":"pm"}`뿐이라
 * CEO의 '검증'이 `ceo_decision_unmapped`(정의 오류)로 떨어졌고 **복구 안내가 하나도 안 나갔다.**
 * B-50 초판이 "매핑은 있는데 예산 소진" 가지만 덮은 것이 원인이다.
 * red 조건: `decision === "검증"` 가지를 ternary에서 빼면 다시 `ceo_decision_unmapped`가 된다.
 */
test("[B-50/live] '검증' 되돌림 대상이 없는 게이트도 ceo_decision_verify로 끝난다 (unmapped 아님)", async () => {
  const name = "_b50_unmapped";
  makeProject(name);
  const r = await runWorkflow({
    workflowId: "mvp-planning",
    project: name,
    provider: ceoDeciding("- 검증"),
    now: () => FIXED,
    approve: async () => true, // 내부 디자인 게이트 (이 테스트의 관심사가 아니다)
  });
  const s = r.state;
  assert.equal(s.status, "failed");
  assert.equal(s.failed_reason, "ceo_decision_verify", "매핑 부재도 '사람 차례'다 — 정의 오류가 아니다");
  assert.equal(s.failed_agent, "founder_ceo");
  const last = s.gate_jumps.at(-1);
  assert.equal(last?.outcome, "failed");
  assert.equal(last?.reason, "ceo_decision_verify");
  rmProject(name);
});
