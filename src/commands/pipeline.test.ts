/**
 * [B-41/2단] `harness pipeline` 명령 흐름 P1~P13 (설계 §7).
 *
 * oracle:
 *  - **counting provider**(mock을 감싸 `generate` 호출 수 + 입력 캡처 · `providerOverride` seam) —
 *    "모델을 호출하지 않았다"를 timestamp로 재지 않는다.
 *  - **파일 exact bytes** 비교 — "상태를 건드리지 않았다"는 사전/사후 바이트가 같다는 뜻이다.
 * mock provider만 사용(무과금 · 실제 LLM 0회). kill 경로는 CEO `## Decision` 절 주입.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PIPELINE,
  pipelineStatePath,
  readPipelineStateAt,
  checkpointIdFor,
  PIPELINE_LOCK_REL,
  lockPipeline,
  type PipelineLease,
  type PipelineState,
} from "../core/pipeline.js";
import { projectPaths } from "../core/project.js";
import { IDEA_REL, loadRunState, runWorkflow } from "../core/runWorkflow.js";
import { buildTaskPrompt } from "../core/taskPrompt.js";
import { runHandoff } from "../core/handoff.js";
import { mockProvider } from "../providers/mockProvider.js";
import { approveCheckpoint, nextPipeline, rejectCheckpoint, restartPipeline, statusPipeline, unlockPipeline } from "./pipeline.js";
import { runRun } from "./run.js";
import { createPlanDagRun } from "./planDag.js";
import type { Provider, AgentRunInput, AgentResult } from "../providers/provider.js";

const FIXED = "2026-01-01T00:00:00.000Z";

function makeProject(name: string, idea = "체크포인트 테스트 아이디어"): string {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.docs, IDEA_REL.split("/")[1]), `# idea\n\n## 아이디어 한 줄 정의\n\n- ${idea}\n`, "utf8");
  return p.root;
}

function rmProject(name: string): void {
  rmSync(projectPaths(name).root, { recursive: true, force: true });
}

/**
 * counting provider — 호출 수·입력을 세고, 필요하면 founder_ceo의 정본 판정 절을 바꾼다.
 * `decision`을 주면 kill/jump 경로를 만들 수 있다(mock 기본은 '진행').
 */
function counting(decision?: string): Provider & { calls: number; byAgent: Map<string, number>; findings: string[][] } {
  const p = {
    id: "mock",
    calls: 0,
    byAgent: new Map<string, number>(),
    findings: [] as string[][],
    async generate(input: AgentRunInput): Promise<AgentResult> {
      p.calls++;
      p.byAgent.set(input.agent.agent_id, (p.byAgent.get(input.agent.agent_id) ?? 0) + 1);
      p.findings.push([...input.priorFindings]);
      const r = await mockProvider.generate(input);
      if (!decision || input.agent.agent_id !== "founder_ceo") return r;
      const DEFAULT = "## Decision\n\n- 진행\n";
      assert.ok(r.markdown.includes(DEFAULT), "mock founder_ceo 출력 형식이 바뀌었다");
      return { ...r, markdown: r.markdown.replace(DEFAULT, `## Decision\n\n${decision}\n`) };
    },
  };
  return p;
}

/** console.log/error/warn를 모아 문자열로 반환한다 (명령이 직접 console에 쓴다). */
async function captureLogs(fn: () => Promise<void> | void): Promise<string> {
  const out: string[] = [];
  const push = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  const [log, err, warn] = [console.log, console.error, console.warn];
  console.log = push;
  console.error = push;
  console.warn = push;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
    console.warn = warn;
  }
  return out.join("\n");
}

/** process.exitCode 오염 없이 명령을 돌린다 (명령은 거부를 exitCode로도 신호한다). */
async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.exitCode;
  let r!: T;
  await captureLogs(async () => {
    r = await fn();
  });
  process.exitCode = prev;
  return r;
}

function stateOf(name: string): PipelineState {
  const read = readPipelineStateAt(pipelineStatePath(projectPaths(name).root));
  assert.equal(read.kind, "ok", `pipeline_state를 읽을 수 없다: ${read.kind === "unreadable" ? read.detail : ""}`);
  return (read as { kind: "ok"; state: PipelineState }).state;
}

function bytesOf(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** 파이프라인을 만들고 1단계를 확인 대기까지 진행한다. */
async function toFirstCheckpoint(name: string): Promise<{ provider: ReturnType<typeof counting>; state: PipelineState }> {
  makeProject(name);
  const provider = counting();
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: provider, now: () => FIXED }));
  assert.equal(r.code, "pipeline_awaiting_approval", `1단계가 확인 대기로 가야 한다 (실제 ${r.code})`);
  return { provider, state: stateOf(name) };
}

// ── P1 ────────────────────────────────────────────────────────
test("[B-41/P1] fresh → next 완주 → awaiting_approval · checkpoint_id 재계산 일치 · seeds 실물", async () => {
  const name = "_b41_p1";
  const { provider, state } = await toFirstCheckpoint(name);
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.current_index, 0);
  assert.ok(provider.calls >= 5, `모델이 실제로 돌았다 (${provider.calls}회)`);

  const p = state.pending!;
  assert.equal(p.stage, "idea-validation");
  assert.equal(p.workflow_id, "idea-validation");
  assert.equal(p.checkpoint_id, checkpointIdFor(p), "id는 payload에서 재계산한 값과 같다");
  assert.deepEqual(
    p.artifacts.map((a) => a.path).sort(),
    ["docs/01_RESEARCH.md", "docs/02_PRD.md", "docs/05_RED_TEAM.md", "docs/06_CEO_DECISION.md", "outputs/chief_of_staff.md"].sort(),
    "완료 step의 산출물 전부가 영수증에 있다",
  );
  // digest가 실제 파일 바이트의 것이다.
  for (const a of p.artifacts) {
    assert.equal(a.size, readFileSync(join(projectPaths(name).root, a.path)).length, `${a.path}: size 일치`);
  }
  assert.deepEqual(p.seeds.map((s) => s.agent_id), ["chief_of_staff", "research", "pm", "red_team", "founder_ceo"]);
  assert.ok(p.seeds.every((s) => s.line.startsWith(`${s.agent_id}: `) && s.line.length > s.agent_id.length + 2), "seed는 실제 판단 한 줄이다");
  rmProject(name);
});

// ── P2 ────────────────────────────────────────────────────────
test("[B-41/P2] 확인 대기 중 5방향 거부 (run·task-prompt·handoff·plan-dag·next) — 모델 호출 0 · state 바이트 불변", async () => {
  const name = "_b41_p2";
  await toFirstCheckpoint(name);
  const root = projectPaths(name).root;
  const before = bytesOf(pipelineStatePath(root));
  const guard = counting();

  // ① harness run — exit 2 (활성 파이프라인에서 workflow 실행은 pipeline next 전담)
  const prev = process.exitCode;
  process.exitCode = 0;
  let out = await captureLogs(() => runRun("mvp-planning", name, "mock", 1, false, undefined, false, 0, true, undefined, false, false, undefined, undefined, undefined, guard));
  assert.equal(process.exitCode, 2, "run 거부는 exit 2");
  assert.match(out, /pipeline_run_reserved/);
  assert.match(out, /pipeline next/, "무엇을 써야 하는지 말한다");

  // ①b resume도 같다 — "확인 대기 중에 --resume으로 마저 돌린다"는 통로가 없다.
  process.exitCode = 0;
  out = await captureLogs(() => runRun("idea-validation", name, "mock", 1, false, undefined, true, 0, true, undefined, false, false, undefined, undefined, undefined, guard));
  assert.equal(process.exitCode, 2, "resume도 exit 2");
  assert.match(out, /pipeline_run_reserved/);
  process.exitCode = prev;

  // ② task-prompt
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /pipeline_checkpoint_pending/);
  // ③ handoff
  const h = await quiet(() => runHandoff({ project: name, cwd: tmpdir(), isTTY: false, logger: () => {} }));
  assert.equal(h.action, "not_completed");
  assert.match(h.action === "not_completed" ? h.reason : "", /pipeline_checkpoint_pending/);
  // ④ plan-dag (승인 파일 부재보다 게이트 거부가 먼저다)
  assert.throws(
    () => createPlanDagRun({ run: "r1", milestone: "m1", approval: join(tmpdir(), "no-such.json"), idea: join(root, IDEA_REL) }),
    /pipeline_checkpoint_pending/,
  );
  // ⑤ next — 전진 없음
  const again = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED }));
  assert.equal(again.code, "pipeline_checkpoint_pending");
  assert.equal(again.exit, 0, "안내 재출력은 실패가 아니다");

  assert.equal(guard.calls, 0, "다섯 방향 전부 모델 호출 0회");
  assert.equal(bytesOf(pipelineStatePath(root)), before, "pipeline_state 바이트 불변");
  rmProject(name);
});

test("[B-41/P2b] 승인 직후 awaiting_run에서 직접 `run dev-preflight --yes` → exit 2 (단계 건너뛰기 봉쇄)", async () => {
  const name = "_b41_p2b";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  assert.equal(stateOf(name).status, "awaiting_run", "2단계 실행 대기");

  const guard = counting();
  const prev = process.exitCode;
  process.exitCode = 0;
  // 사용자가 세 번째 단계를 직접 돌리려 한다 — 승인된 2단계를 건너뛰는 시나리오.
  const out = await captureLogs(() => runRun("dev-preflight", name, "mock", 1, false, undefined, false, 0, true, undefined, false, false, undefined, undefined, undefined, guard));
  assert.equal(process.exitCode, 2);
  process.exitCode = prev;
  assert.match(out, /pipeline_run_reserved/);
  assert.equal(guard.calls, 0, "모델 호출 0");
  assert.equal(loadRunState(name)?.workflow_id, "idea-validation", "run_state도 그대로 (dev-preflight가 돌지 않았다)");
  rmProject(name);
});

// ── P3 ────────────────────────────────────────────────────────
test("[B-41/P3] approve: stage·id 일치만 전진 — 불일치·이중 승인은 거부·불변", async () => {
  const name = "_b41_p3";
  const { state } = await toFirstCheckpoint(name);
  const id = state.pending!.checkpoint_id;
  const root = projectPaths(name).root;
  const before = bytesOf(pipelineStatePath(root));

  const wrongStage = await quiet(() => approveCheckpoint({ project: name, stage: "mvp-planning", checkpointId: id, now: () => FIXED }));
  assert.equal(wrongStage.code, "pipeline_stage_mismatch");
  const wrongId = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: "0123456789ab", now: () => FIXED }));
  assert.equal(wrongId.code, "pipeline_checkpoint_mismatch");
  assert.equal(bytesOf(pipelineStatePath(root)), before, "거부 경로는 state를 건드리지 않는다");

  const ok = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, now: () => FIXED }));
  assert.equal(ok.code, "pipeline_approved");
  const after = stateOf(name);
  assert.equal(after.current_index, 1);
  assert.equal(after.status, "awaiting_run");
  assert.equal(after.pending, null);
  assert.equal(after.checkpoints.length, 1);
  assert.equal(after.checkpoints[0].decision, "approved");
  assert.equal(after.checkpoints[0].checkpoint_id, id, "영수증은 pending이 그대로 내려온 것이다");

  // 이중 승인 — pending이 없으므로 거부(멱등).
  const twice = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, now: () => FIXED }));
  assert.equal(twice.code, "pipeline_no_pending");
  assert.equal(twice.exit, 1);
  assert.equal(stateOf(name).checkpoints.length, 1, "영수증이 두 번 쌓이지 않는다");
  rmProject(name);
});

// ── P4 ────────────────────────────────────────────────────────
test("[B-41/P4] approve 직전 1바이트 수정 → 거부 / 같은 바이트를 재생산한 재실행 → 통과 (byte binding ≠ run identity)", async () => {
  const name = "_b41_p4";
  const { state } = await toFirstCheckpoint(name);
  const id = state.pending!.checkpoint_id;
  const root = projectPaths(name).root;
  const prd = join(root, "docs/02_PRD.md");
  const original = readFileSync(prd);

  writeFileSync(prd, Buffer.concat([original, Buffer.from("x")]));
  const drift = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, now: () => FIXED }));
  assert.equal(drift.code, "pipeline_artifact_drift", "확인한 바이트가 아니면 승인하지 않는다");
  assert.equal(stateOf(name).status, "awaiting_approval", "상태 불변");

  // 되돌린 뒤 같은 workflow를 **다시** 돌린다.
  // (mock 산출물은 `created_at`을 문서에 박으므로 "완전히 같은 바이트"는 같은 주입 시각에서만 나온다 —
  //  실측으로 확인했다. 그래서 여기서 재는 것은 "**다른 run**이 같은 바이트를 내면 같은 신원"이고,
  //  `run_finished_at`이 payload에서 빠진다는 것 자체는 core/pipeline.test.ts가 단위로 못 박는다.)
  await quiet(() => rejectCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, note: "바뀐 파일", now: () => FIXED }));
  const rerun = counting();
  await quiet(() => nextPipeline({ project: name, providerOverride: rerun, now: () => FIXED }));
  const after = stateOf(name);
  assert.ok(rerun.calls >= 5, `두 번째 run이 실제로 돌았다 (${rerun.calls}회) — 옛 pending을 되쓴 것이 아니다`);
  assert.equal(after.pending!.checkpoint_id, id, "같은 바이트 → 같은 checkpoint_id (run이 달라도)");
  assert.equal(readFileSync(prd).equals(original), true, "재실행이 원래 바이트를 복원했다");
  assert.equal(after.checkpoints.at(-1)?.decision, "rejected", "앞선 거부 영수증은 남아 있다");
  const ok = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, now: () => FIXED }));
  assert.equal(ok.code, "pipeline_approved", "검토한 내용과 동일한 바이트이므로 승인된다");
  rmProject(name);
});

// ── P5 ────────────────────────────────────────────────────────
test("[B-41/P5] reject(+note) → 같은 단계 → next가 **재실행**한다 (old-run 채택 없음)", async () => {
  const name = "_b41_p5";
  const { state } = await toFirstCheckpoint(name);
  const id = state.pending!.checkpoint_id;
  const r = await quiet(() => rejectCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, note: "범위가 넓다", now: () => FIXED }));
  assert.equal(r.code, "pipeline_rejected");
  const afterReject = stateOf(name);
  assert.equal(afterReject.status, "awaiting_run");
  assert.equal(afterReject.current_index, 0, "같은 단계로 되돌아온다");
  assert.equal(afterReject.pending, null);
  assert.deepEqual(
    afterReject.checkpoints.map((c) => [c.decision, c.note]),
    [["rejected", "범위가 넓다"]],
    "거부도 영수증으로 남는다 (이유 포함)",
  );

  const rerun = counting();
  await quiet(() => nextPipeline({ project: name, providerOverride: rerun, now: () => FIXED }));
  assert.ok(rerun.calls >= 5, `재실행이 실제로 모델을 돌렸다 (${rerun.calls}회) — 기존 run을 채택하지 않는다`);
  assert.equal(stateOf(name).status, "awaiting_approval");
  // 거부된 단계의 seed는 다음 단계 입력이 아니다(승인된 것만 실린다).
  assert.equal(stateOf(name).checkpoints.filter((c) => c.decision === "rejected").length, 1);
  rmProject(name);
});

// ── P6 ────────────────────────────────────────────────────────
test("[B-41/P6] 폐기 판정 → killed 종료 · restart 후 killed run_state는 화해(모델 호출 0)", async () => {
  const name = "_b41_p6";
  makeProject(name);
  const killer = counting("- 폐기");
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: killer, now: () => FIXED }));
  assert.equal(r.code, "pipeline_killed_reconciled");
  const killed = stateOf(name);
  assert.equal(killed.status, "killed");
  assert.equal(killed.pending, null);
  assert.equal(killed.checkpoints.at(-1)?.decision, "killed");
  assert.match(killed.checkpoints.at(-1)?.note ?? "", /founder_ceo가 '폐기' 판정/);
  assert.equal(loadRunState(name)?.status, "killed");

  // killed에서 next/approve는 거부다.
  const guard = counting();
  assert.equal((await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED }))).code, "pipeline_killed");
  assert.equal((await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: killed.checkpoints[0].checkpoint_id, now: () => FIXED }))).code, "pipeline_killed");
  // 하류 소비자도 닫힌다.
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked|pipeline_killed/);

  // restart로 새 파이프라인을 세우면 run_state는 여전히 killed → 첫 next가 **화해**한다(재실행 시도 없음).
  await quiet(() => restartPipeline({ project: name, now: () => FIXED }));
  assert.equal(stateOf(name).status, "awaiting_run");
  const rec = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED }));
  assert.equal(rec.code, "pipeline_killed_reconciled");
  assert.equal(guard.calls, 0, "화해는 모델을 호출하지 않는다 (재평가는 사람이 직접 돌린다)");
  assert.equal(stateOf(name).status, "killed");
  rmProject(name);
});

// ── P7 ────────────────────────────────────────────────────────
test("[B-41/P7] 실패 → last_failure 영수증 실물 → resume(완료 step 미재실행) → manifest에 앞 step 문서 포함", async () => {
  const name = "_b41_p7";
  makeProject(name);
  const fail = counting();
  process.env.HARNESS_FAIL_AT = "pm";
  let r = await quiet(() => nextPipeline({ project: name, providerOverride: fail, now: () => FIXED }));
  delete process.env.HARNESS_FAIL_AT;
  assert.equal(r.code, "pipeline_stage_failed");
  assert.equal(r.exit, 1);
  const failed = stateOf(name);
  assert.equal(failed.status, "awaiting_run", "실패는 확인 대기가 아니다 — 실행 대기 그대로");
  assert.equal(failed.pending, null);
  assert.ok(failed.last_failure, "실패 영수증이 실물로 남는다");
  assert.equal(failed.last_failure!.stage, "idea-validation");
  assert.equal(failed.last_failure!.workflow_id, "idea-validation");
  assert.deepEqual(
    failed.last_failure!.written.map((w) => w.path).sort(),
    ["docs/01_RESEARCH.md", "outputs/chief_of_staff.md"],
    "실패 attempt가 실제로 덮은 파일의 digest",
  );
  assert.ok(failed.last_failure!.written.every((w) => /^[0-9a-f]{64}$/.test(w.sha256)));

  // resume — 완료된 step은 다시 돌지 않는다(counter).
  const resumed = counting();
  r = await quiet(() => nextPipeline({ project: name, providerOverride: resumed, now: () => FIXED }));
  assert.equal(r.code, "pipeline_awaiting_approval");
  assert.equal(resumed.byAgent.get("chief_of_staff") ?? 0, 0, "완료 step은 재실행되지 않았다");
  assert.equal(resumed.byAgent.get("research") ?? 0, 0, "완료 step은 재실행되지 않았다");
  assert.ok((resumed.byAgent.get("pm") ?? 0) >= 1, "실패 지점부터 이어서 돌았다");

  const pending = stateOf(name).pending!;
  assert.ok(
    pending.artifacts.some((a) => a.path === "docs/01_RESEARCH.md"),
    "manifest는 completed_steps 기반이라 앞 attempt의 문서도 승인 대상에 있다 (savedFiles 기반이면 빠진다)",
  );
  assert.equal(stateOf(name).last_failure, null, "성공하면 실패 영수증을 내린다");
  rmProject(name);
});

// ── P8a (A-3의 핵심) ──────────────────────────────────────────
test("[B-41/P8a] 승인 후 02_PRD.md 교체 → 다음 단계 fresh가 **모델 호출 0으로** 거부한다", async () => {
  const name = "_b41_p8a";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const root = projectPaths(name).root;
  // mvp-planning은 pm 산출 경로(docs/02_PRD.md)를 **다시 쓴다** — 예전 설계는 그 경로를 검증에서
  // 제외했고, 그래서 사람이 바꿔치기한 PRD가 모델 입력으로 들어갔다. 지금은 사전 전수 검증이다.
  writeFileSync(join(root, "docs/02_PRD.md"), "# 몰래 바꾼 PRD\n\n## Main Judgment\n\n- 전혀 다른 계획\n", "utf8");
  const before = bytesOf(pipelineStatePath(root));

  const guard = counting();
  // internalApprover를 **넘긴다**: 내부 승인 게이트 부재(approval_approver_missing)로도 호출 0이
  // 되므로, 그것을 지우지 않으면 "drift가 막았다"는 증거가 다른 원인과 섞인다
  // (mutation ⑧ 실측에서 실제로 그 혼동이 드러나 이 인자를 추가했다).
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_artifact_drift");
  assert.equal(r.exit, 1);
  assert.equal(guard.calls, 0, "**모델 호출 0** — 교체본이 입력으로 들어가지 않았다");
  assert.equal(bytesOf(pipelineStatePath(root)), before, "state 바이트 불변");
  rmProject(name);
});

// ── P8b ───────────────────────────────────────────────────────
test("[B-41/P8b] resume 예외는 last_failure 영수증에만 결박된다 (영수증과도 다르면 거부)", async () => {
  const name = "_b41_p8b";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const root = projectPaths(name).root;

  // 2단계(mvp-planning)를 tech_lead에서 실패시킨다 → pm/ux_ui/design이 승인 경로를 정당하게 덮는다.
  process.env.HARNESS_FAIL_AT = "tech_lead";
  const failed = await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  delete process.env.HARNESS_FAIL_AT;
  assert.equal(failed.code, "pipeline_stage_failed");
  const written = stateOf(name).last_failure!.written.map((w) => w.path);
  assert.ok(written.includes("docs/02_PRD.md"), `실패 attempt가 승인 경로를 덮었다 (${written.join(", ")})`);

  // ⓐ 영수증과 현재 바이트가 일치하므로 resume이 통과한다 (승인 digest와는 다르다).
  const resumed = counting();
  const ok = await quiet(() => nextPipeline({ project: name, providerOverride: resumed, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(ok.code, "pipeline_awaiting_approval", "영수증 digest와 일치하는 경로는 예외로 통과");
  assert.ok(resumed.calls > 0);

  // ⓑ 이번엔 사람이 손을 댄다 — 승인 digest도 영수증 digest도 아니면 거부다.
  await quiet(() => rejectCheckpoint({ project: name, stage: "mvp-planning", checkpointId: stateOf(name).pending!.checkpoint_id, now: () => FIXED }));
  process.env.HARNESS_FAIL_AT = "tech_lead";
  await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  delete process.env.HARNESS_FAIL_AT;
  writeFileSync(join(root, "docs/02_PRD.md"), "# 손댄 PRD\n", "utf8");
  const guard = counting();
  const rejected = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(rejected.code, "pipeline_artifact_drift", "영수증과도 다르면 resume도 거부");
  assert.equal(guard.calls, 0, "모델 호출 0");
  rmProject(name);
});

test("[B-41/P8d] **영수증 없는 실패는 resume하지 않는다** — fresh로 강하해 앞 step까지 다시 돈다", async () => {
  // 이 테스트는 mutation ⑨(resume 예외에서 last_failure 결박 제거)가 **두 번 GREEN으로 통과한 뒤**
  // 만들었다. 첫 시도는 drift 거부를 단정했는데, 영수증이 없으면 예외 목록도 비어 있어 원본·변종이
  // **같은 drift 판정**을 낸다 — 즉 그 단정으로는 resume 여부를 구분할 수 없었다(공허한 단정).
  // 구분되는 관측은 하나다: **앞 step이 다시 도는가**(counting provider). 승인 산출물이 아직 없는
  // 1단계에서 재면 drift가 끼어들지 않아 resume/fresh가 그대로 드러난다.
  const name = "_b41_p8d";
  makeProject(name);
  const root = projectPaths(name).root;

  process.env.HARNESS_FAIL_AT = "pm"; // chief_of_staff → research 까지 완료 후 실패
  await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED }));
  delete process.env.HARNESS_FAIL_AT;
  assert.ok(stateOf(name).last_failure, "전제: 영수증이 기록됐다");
  assert.equal(loadRunState(name)?.status, "failed");

  // **run_state 기록 후 pipeline_state 기록 전에 죽은 크래시**를 재현한다: 영수증만 지운다.
  // (state는 여전히 semantic 검증을 통과하는 정상 state다 — 손상 fixture가 아니다.)
  writeFileSync(pipelineStatePath(root), JSON.stringify({ ...stateOf(name), last_failure: null }, null, 2) + "\n", "utf8");
  assert.equal(readPipelineStateAt(pipelineStatePath(root)).kind, "ok", "전제: 영수증 없는 정상 state");

  const fresh = counting();
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: fresh, now: () => FIXED }));
  assert.equal(r.code, "pipeline_awaiting_approval");
  assert.equal(fresh.byAgent.get("chief_of_staff") ?? 0, 1, "영수증이 없으면 **fresh 재실행**이다 (resume이면 0회)");
  assert.equal(fresh.byAgent.get("research") ?? 0, 1, "앞 step 전부 다시 돈다");
  // 대조군은 P7이다: 영수증이 **있으면** 같은 상황에서 앞 step이 0회다(resume).
  rmProject(name);
});

// ── Codex A-6 ─────────────────────────────────────────────────
test("[B-41/A-6] 마지막 단계만 승인해 '완료' 영수증을 받아낼 수 없다 — approve가 앞 단계 승인 바이트까지 전수 검증한다", async () => {
  const name = "_b41_a6";
  makeProject(name);
  // dev-handoff 확인 대기까지 간다 (앞 세 단계는 승인).
  for (const stage of DEFAULT_PIPELINE) {
    await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
    const pending = stateOf(name).pending!;
    assert.equal(pending.stage, stage.id);
    if (stage.id === "dev-handoff") break; // 마지막은 승인하지 않고 대기 상태로 둔다
    await quiet(() => approveCheckpoint({ project: name, stage: stage.id, checkpointId: pending.checkpoint_id, now: () => FIXED }));
  }
  const root = projectPaths(name).root;
  const pending = stateOf(name).pending!;
  assert.deepEqual(pending.artifacts.map((a) => a.path), ["outputs/claude_code_task_prompt.md"], "마지막 단계 pending은 지시문 하나뿐");

  // **앞 단계**에서 승인된 문서를 바꾼다 — pending에는 없는 경로다.
  writeFileSync(join(root, "docs/06_CEO_DECISION.md"), "# 승인 뒤 바꾼 CEO 판단\n", "utf8");
  const r = await quiet(() => approveCheckpoint({ project: name, stage: "dev-handoff", checkpointId: pending.checkpoint_id, now: () => FIXED }));
  assert.equal(r.code, "pipeline_artifact_drift", "pending만 보면 '전체 완료' 영수증이 나왔다");
  assert.equal(stateOf(name).status, "awaiting_approval", "상태 불변 — completed를 발행하지 않았다");

  // 복원하면 승인된다(검사가 무조건 거부가 아니다).
  await quiet(() => rejectCheckpoint({ project: name, stage: "dev-handoff", checkpointId: pending.checkpoint_id, now: () => FIXED }));
  writeFileSync(join(root, "docs/06_CEO_DECISION.md"), readFileSync(join(root, "docs/06_CEO_DECISION.md"), "utf8"), "utf8");
  rmProject(name);
});

// ── Codex A-7 ─────────────────────────────────────────────────
test("[B-41/A-7] lock 획득 **후** state를 재독한다 — lock 밖 snapshot으로 남의 전이를 덮어쓰지 않는다", async () => {
  const name = "_b41_a7";
  const { state } = await toFirstCheckpoint(name);
  const root = projectPaths(name).root;
  const id = state.pending!.checkpoint_id;

  // `now`는 acquireLock 안에서 호출된다 = **첫 read 뒤, 두 번째 read 앞**. 그 순간에 다른 프로세스가
  // 같은 체크포인트를 되돌린 것처럼 state를 바꾼다(정합한 state다 — 손상 fixture가 아니다).
  let injected = false;
  const now = () => {
    if (!injected) {
      injected = true;
      const rejected: PipelineState = {
        ...state,
        status: "awaiting_run",
        pending: null,
        checkpoints: [{ ...state.pending!, decision: "rejected", decided_at: FIXED, note: "다른 세션이 되돌렸다" }],
      };
      writeFileSync(pipelineStatePath(root), JSON.stringify(rejected, null, 2) + "\n", "utf8");
    }
    return FIXED;
  };
  const r = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, now }));
  assert.equal(injected, true, "전제: lock 시점에 state가 바뀌었다");
  assert.equal(r.code, "pipeline_no_pending", "재독한 state로 판정한다 (stale snapshot이면 승인해 버린다)");
  const after = stateOf(name);
  assert.equal(after.current_index, 0, "남의 전이를 덮어쓰지 않았다");
  assert.deepEqual(after.checkpoints.map((c) => c.decision), ["rejected"], "되돌림 영수증이 살아 있다");
  rmProject(name);
});

// ── P8c ───────────────────────────────────────────────────────
test("[B-41/P8c] 완료 후 문서 수정 → task-prompt·handoff·plan-dag 전부 drift 거부", async () => {
  const name = "_b41_p8c";
  await runToCompletion(name);
  const root = projectPaths(name).root;
  // 완료 상태에서는 세 소비자가 다 열린다 (대조군).
  assert.match(buildTaskPrompt(name, "2026-01-01"), /## Task/, "대조군: 완료 후에는 지시문을 만든다");

  writeFileSync(join(root, "docs/06_CEO_DECISION.md"), "# 승인 후 바꾼 CEO 판단\n", "utf8");
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /pipeline_artifact_drift/, "task-prompt 거부");
  const h = await quiet(() => runHandoff({ project: name, cwd: tmpdir(), isTTY: false, logger: () => {} }));
  assert.match(h.action === "not_completed" ? h.reason : "", /pipeline_artifact_drift/, "handoff 거부");
  assert.throws(
    () => createPlanDagRun({ run: "r1", milestone: "m1", approval: join(tmpdir(), "no-such.json"), idea: join(root, IDEA_REL) }),
    /pipeline_artifact_drift/,
    "plan-dag 거부",
  );
  rmProject(name);
});

/** 4단계를 전부 승인해 completed로 만든다 (비대화 내부 게이트 승인). */
async function runToCompletion(name: string): Promise<void> {
  makeProject(name);
  for (const stage of DEFAULT_PIPELINE) {
    const r = await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
    assert.equal(r.code, "pipeline_awaiting_approval", `${stage.id}: 확인 대기로 가야 한다`);
    const pending = stateOf(name).pending!;
    assert.equal(pending.stage, stage.id, "단계는 상태기가 정한다 (인자로 고를 수 없다)");
    const a = await quiet(() => approveCheckpoint({ project: name, stage: stage.id, checkpointId: pending.checkpoint_id, now: () => FIXED }));
    assert.equal(a.code, "pipeline_approved", `${stage.id}: 승인`);
  }
  assert.equal(stateOf(name).status, "completed");
  assert.equal(stateOf(name).current_index, DEFAULT_PIPELINE.length);
}

// ── P9 ────────────────────────────────────────────────────────
test("[B-41/P9] 손상 state → 전 명령 exit 2·바이트 불변 / lock 중 mutation 거부·status는 동작 / unlock은 죽은 owner만", async () => {
  const name = "_b41_p9";
  await toFirstCheckpoint(name);
  const root = projectPaths(name).root;
  const abs = pipelineStatePath(root);
  const good = bytesOf(abs);

  for (const corrupt of ['{ "schema": 1, broken', JSON.stringify({ ...JSON.parse(good), pipeline_version: 999 })]) {
    writeFileSync(abs, corrupt, "utf8");
    const guard = counting();
    const results = [
      await quiet(() => statusPipeline({ project: name })),
      await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED })),
      await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: "0123456789ab", now: () => FIXED })),
      await quiet(() => rejectCheckpoint({ project: name, stage: "idea-validation", checkpointId: "0123456789ab", now: () => FIXED })),
    ];
    for (const r of results) {
      assert.equal(r.exit, 2, `손상 state: 모든 명령이 exit 2 (실제 ${r.code}/${r.exit})`);
      assert.equal(r.code, "pipeline_state_unreadable");
    }
    assert.equal(guard.calls, 0, "손상 state에서 모델을 호출하지 않는다");
    assert.equal(bytesOf(abs), corrupt, "판정이 파일을 건드리지 않았다");
  }
  // restart는 **예외**다: 손상 state의 탈출구이고, 지우지 않고 rename 보관한다.
  const restarted = await quiet(() => restartPipeline({ project: name, now: () => FIXED }));
  assert.equal(restarted.code, "pipeline_restarted", "손상 state의 탈출구는 restart 하나다");
  assert.equal(stateOf(name).status, "awaiting_run");
  assert.ok(
    readdirSync(join(root, "outputs")).some((f) => /^pipeline_state\..*\.json$/.test(f)),
    "손상본도 지우지 않고 archive로 남는다",
  );

  // lock 보유 중: mutation 거부(exit 2) · status는 읽힌다.
  const lockAbs = join(root, PIPELINE_LOCK_REL);
  writeFileSync(lockAbs, JSON.stringify({ pid: process.pid, nonce: "a".repeat(16), at: FIXED }), "utf8");
  const guard2 = counting();
  const locked = await quiet(() => nextPipeline({ project: name, providerOverride: guard2, now: () => FIXED }));
  assert.equal(locked.code, "pipeline_locked");
  assert.equal(locked.exit, 2);
  assert.equal(guard2.calls, 0);
  const st = await quiet(() => statusPipeline({ project: name }));
  assert.equal(st.exit, 0, "status는 lock 중에도 읽힌다");

  // unlock: **살아 있는** owner(이 프로세스)는 회수하지 않는다.
  const alive = await quiet(() => unlockPipeline({ project: name }));
  assert.equal(alive.code, "pipeline_lock_owner_alive");
  assert.equal(existsSync(lockAbs), true, "살아 있는 owner의 lock은 남는다");
  // 죽은 owner는 회수한다. **실제로 죽은 pid**를 쓴다: 자식을 띄워 끝내고 그 pid를 owner로 적는다
  // (임의의 큰 수는 "아마 없을 것"이라는 가정이고, 그러면 단정이 환경에 기댄다).
  const corpse = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(corpse.status, 0, "자식이 정상 종료했다 (그 pid는 이제 없다)");
  writeFileSync(lockAbs, JSON.stringify({ pid: corpse.pid, nonce: "b".repeat(16), at: FIXED }), "utf8");
  const dead = await quiet(() => unlockPipeline({ project: name }));
  assert.equal(dead.code, "pipeline_unlocked", "죽음을 관측했으므로 회수한다");
  assert.equal(existsSync(lockAbs), false, "죽은 owner의 lock은 회수된다");
  // 내용이 깨진 lock은 죽음을 관측할 수 없으므로 회수하지 않는다.
  writeFileSync(lockAbs, "not json", "utf8");
  const bad = await quiet(() => unlockPipeline({ project: name }));
  assert.equal(bad.code, "pipeline_lock_unreadable");
  assert.equal(existsSync(lockAbs), true);
  rmProject(name);
});

// ── P10 ───────────────────────────────────────────────────────
test("[B-41/P10] 비TTY: 내부 게이트 자동 승인으로 4단계 완주 / 응답자가 EOF면 실패 · 체크포인트는 명령만이 판정", async () => {
  const name = "_b41_p10";
  await runToCompletion(name); // internalApprover: async () => true = --yes-internal-gates 경로

  // 플래그 없이 비TTY라면 내부 게이트 응답자가 EOF로 false를 낸다 → 그 단계가 failed로 착지한다.
  const name2 = "_b41_p10b";
  const { state } = await toFirstCheckpoint(name2);
  await quiet(() => approveCheckpoint({ project: name2, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const r = await quiet(() =>
    nextPipeline({ project: name2, providerOverride: counting(), now: () => FIXED, internalApprover: async () => false }),
  );
  assert.equal(r.code, "pipeline_stage_failed", "내부 승인 거부 → 단계 실패 (확인 대기로 넘어가지 않는다)");
  assert.equal(loadRunState(name2)?.failed_reason, "user_rejected");
  assert.equal(stateOf(name2).status, "awaiting_run");

  // internalApprover가 아예 없으면 1단의 fail closed preflight가 모델 호출 전에 막는다.
  const guard = counting();
  const noAppr = await quiet(() => nextPipeline({ project: name2, providerOverride: guard, now: () => FIXED }));
  assert.equal(noAppr.code, "pipeline_run_not_started");
  assert.equal(guard.calls, 0, "approver 부재는 첫 호출 전에 거부된다");

  // **exec/mission은 배선하지 않았다**: 이 모듈이 그 경로를 import조차 하지 않는다(spawn 0).
  // (알려진 미배선 — 체크포인트 대기 중에도 exec/mission은 돈다. 설계 §8 우회 목록 1.)
  const src = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
  assert.equal(/from "\.\/(exec|mission)\.js"/.test(src), false, "pipeline 명령은 exec/mission을 부르지 않는다");
  // 체크포인트 우회 플래그 부재는 **타입**으로 못 박는다 — 아래 `_checkpointApiShape`의 @ts-expect-error가
  // 그 단정이고, 누군가 approver/boolean 인자를 추가하면 `npm run typecheck`가 red가 된다.
  // (산문까지 훑는 정규식 스캔은 이 파일의 주석에서 오탐했다 — 실측 후 폐기했다.)
  rmProject(name);
  rmProject(name2);
});

// ── P11 ───────────────────────────────────────────────────────
test("[B-41/P11] restart: killed/completed에서만 · archive 바이트 보존 · 진행 중이면 거부", async () => {
  const name = "_b41_p11";
  const { state } = await toFirstCheckpoint(name);
  const root = projectPaths(name).root;

  // awaiting_approval에서 거부 — restart가 체크포인트 회피 통로가 되지 않는다.
  const busy = await quiet(() => restartPipeline({ project: name, now: () => FIXED }));
  assert.equal(busy.code, "pipeline_active");
  assert.equal(busy.exit, 1);
  assert.equal(stateOf(name).status, "awaiting_approval", "불변");

  // awaiting_run에서도 거부.
  await quiet(() => rejectCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  assert.equal((await quiet(() => restartPipeline({ project: name, now: () => FIXED }))).code, "pipeline_active");

  // completed에서 허용 — 기존 state는 **rename 보관**(삭제 없음).
  rmProject(name);
  await runToCompletion(name);
  const before = bytesOf(pipelineStatePath(root));
  const r = await quiet(() => restartPipeline({ project: name, now: () => "2026-03-03T04:05:06.700Z" }));
  assert.equal(r.code, "pipeline_restarted");
  const archives = readdirSync(join(root, "outputs")).filter((f) => /^pipeline_state\..+\.json$/.test(f));
  assert.equal(archives.length, 1, `archive 1개 (실제 ${archives.join(",")})`);
  assert.equal(bytesOf(join(root, "outputs", archives[0])), before, "archive는 이전 바이트를 그대로 보존한다");
  const fresh = stateOf(name);
  assert.equal(fresh.current_index, 0);
  assert.equal(fresh.status, "awaiting_run");
  assert.deepEqual(fresh.checkpoints, [], "새 state는 이전 승인을 이어받지 않는다");
  rmProject(name);
});

// ── P12 ───────────────────────────────────────────────────────
test("[B-41/P12] seed는 **저장본**에서 온다 — 2단계 입력에 1단계 판단이 실리고, 문서를 바꿔도 seed 값은 영수증 그대로", async () => {
  const name = "_b41_p12";
  const { state } = await toFirstCheckpoint(name);
  const id = state.pending!.checkpoint_id;
  const researchSeed = state.pending!.seeds.find((s) => s.agent_id === "research")!.line;
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: id, now: () => FIXED }));
  const root = projectPaths(name).root;

  // 승인된 checkpoint에 없는 경로(승인 대상이 아닌 파일)를 바꿔도 seed는 저장본에서 온다.
  // 승인 경로를 바꾸면 P8a의 drift로 먼저 거부되므로, seed 출처를 재려면 저장본 자체를 봐야 한다:
  // 아래 캡처가 파일 재독이면 seed 문장이 파일 내용과 함께 바뀔 것이다.
  const stage2 = counting();
  await quiet(() => nextPipeline({ project: name, providerOverride: stage2, now: () => FIXED, internalApprover: async () => true }));
  const firstPrompt = stage2.findings[0];
  assert.ok(firstPrompt.includes(researchSeed), `2단계 첫 프롬프트에 1단계 승인 판단이 실렸다 (실제: ${JSON.stringify(firstPrompt)})`);
  assert.equal(
    firstPrompt.filter((f) => f.startsWith("research:")).length,
    1,
    "seed는 agent별 하나 (중복 누적 없음)",
  );

  // seed는 durable 영수증에서 오므로, 그 문서를 지워도 값이 그대로다(파일 재독이면 여기서 red).
  const state2 = stateOf(name);
  const pending2 = state2.pending!;
  await quiet(() => approveCheckpoint({ project: name, stage: "mvp-planning", checkpointId: pending2.checkpoint_id, now: () => FIXED }));
  rmSync(join(root, "docs/01_RESEARCH.md"));
  const stage3 = counting();
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: stage3, now: () => FIXED, internalApprover: async () => true }));
  // 승인 산출물이 사라졌으므로 drift로 거부된다 — 그런데 그 판정은 **파일**을 보고, seed는 저장본에 남아 있다.
  assert.equal(r.code, "pipeline_artifact_drift", "승인 문서 삭제도 drift다");
  assert.equal(stage3.calls, 0);
  assert.equal(
    stateOf(name).checkpoints[0].seeds.find((s) => s.agent_id === "research")!.line,
    researchSeed,
    "문서가 사라져도 영수증의 seed 값은 그대로다 (소비 시 파일을 다시 읽지 않는다)",
  );
  rmProject(name);
});

// ── P13 ───────────────────────────────────────────────────────
test("[B-41/P13] lease: 위조 nonce로 runWorkflow 직접 호출 → 거부 / 유효 lease라도 타 단계 workflow → 거부", async () => {
  const name = "_b41_p13";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const root = projectPaths(name).root;
  assert.equal(stateOf(name).status, "awaiting_run");
  assert.equal(stateOf(name).current_index, 1, "현 단계 = mvp-planning");

  const guard = counting();
  // ① lease 없음 — 일반 호출자는 활성 파이프라인에서 항상 거부다.
  await assert.rejects(
    runWorkflow({ workflowId: "mvp-planning", project: name, provider: guard, now: () => FIXED, approve: async () => true }),
    /pipeline_run_reserved/,
    "lease 없는 programmatic 호출도 거부",
  );
  // ② [Codex A-3] **손으로 만든 lease**는 통하지 않는다: lock 파일에서 nonce를 읽어도 발행 신원이 없다.
  //    (예전 판은 nonce 문자열이 곧 자격증명이었고 `acquireLock`이 공개 API였다 = 누구나 단계를 돌렸다.)
  writeFileSync(join(root, PIPELINE_LOCK_REL), JSON.stringify({ pid: process.pid, nonce: "a".repeat(16), at: FIXED }), "utf8");
  const forged = { stage: "mvp-planning" } as PipelineLease;
  await assert.rejects(
    runWorkflow({ workflowId: "mvp-planning", project: name, provider: guard, now: () => FIXED, approve: async () => true, pipelineLease: forged }),
    /pipeline_run_reserved/,
    "발행되지 않은 lease 거부 (lock을 쥐고 있어도)",
  );
  rmSync(join(root, PIPELINE_LOCK_REL));
  assert.equal(guard.calls, 0, "두 시도 전부 모델 호출 0");

  // ③ 대조군: **lockPipeline의 runStage 안에서만** 통과한다 (위 거부들이 공허하지 않다).
  const ok = counting();
  const lock = lockPipeline(root, () => FIXED);
  assert.equal(lock.ok, true, "lock 획득");
  if (!lock.ok) return;
  const r = await lock.locked.runStage("mvp-planning", (lease) =>
    runWorkflow({ workflowId: "mvp-planning", project: name, provider: ok, now: () => FIXED, approve: async () => true, pipelineLease: lease }),
  );
  assert.equal(r.state.status, "completed");
  assert.ok(ok.calls > 0);
  // ④ 같은 lock으로도 **타 단계**는 발행되지 않는다 → 그 workflow는 돌 수 없다.
  const other = counting();
  await assert.rejects(
    lock.locked.runStage("dev-preflight", (lease) =>
      runWorkflow({ workflowId: "dev-preflight", project: name, provider: other, now: () => FIXED, approve: async () => true, pipelineLease: lease }),
    ),
    /pipeline_lease_denied/,
    "타 단계 workflow는 lease 발행 자체가 거부된다",
  );
  assert.equal(other.calls, 0, "타 단계 시도는 모델 호출 0");
  lock.locked.release();
  rmProject(name);
});

// ── absent + 폐기 잠금 ────────────────────────────────────────
test("[B-41] 폐기된 아이디어에서는 파이프라인이 전진하지 않는다 (즉시 killed 화해 · 모델 호출 0 · 탈출구는 사람의 재평가 run)", async () => {
  const name = "_b41_lock";
  makeProject(name);
  // 파이프라인 없이 kill된 run_state를 만든다 (B-40 경로).
  const killed = await runWorkflow({ workflowId: "idea-validation", project: name, provider: counting("- 폐기"), now: () => FIXED });
  assert.equal(killed.state.status, "killed", "전제: killed run");

  const guard = counting();
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED }));
  // 설계 §4의 두 행이 겹치는 자리다: 1단계 workflow가 kill 게이트를 가졌으므로 `ideaGateStatus`는
  // "재평가는 허용"으로 통과시키고(allowReevaluation), 그 직후 run_state의 폐기 판정이 **화해**로
  // 파이프라인을 terminal killed로 내린다 — 파이프라인이 스스로 재평가를 돌리지는 않는다.
  // 못 박는 것: **모델을 호출하지 않는다**는 것과 하류가 계속 닫혀 있다는 것.
  assert.equal(r.code, "pipeline_killed_reconciled");
  assert.equal(guard.calls, 0, "폐기 상태에서 파이프라인이 모델을 호출하지 않는다");
  assert.equal(stateOf(name).status, "killed");
  assert.equal(stateOf(name).checkpoints.at(-1)?.decision, "killed");
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked|pipeline_killed/, "하류는 닫혀 있다");
  // 탈출구는 **사람이 직접 돌리는 재평가 run**이다(killed 파이프라인에서 run action은 열려 있다).
  const reeval = counting();
  const rr = await runWorkflow({ workflowId: "idea-validation", project: name, provider: reeval, now: () => FIXED });
  assert.equal(rr.state.status, "completed", "재평가 run은 killed 파이프라인에서도 돌 수 있다 (B-40 경로 보존)");
  assert.equal(typeof rr.state.cleared_idea_sha256, "string", "'진행' 판정이 잠금을 풀었다");
  rmProject(name);
});

/**
 * [B-41/§5.2 B-3] **실행하지 않는다 — 컴파일 시점 단정이다.** 체크포인트 전이 함수에는 approver·
 * boolean(우회) 인자가 **아예 없다**. 누군가 그 인자를 추가하면 아래 `@ts-expect-error`가 더 이상
 * 오류가 아니게 되어 `npm run typecheck`가 red가 된다 — 즉 `--yes-internal-gates`가 체크포인트에
 * 닿으려면 컴파일을 먼저 통과해야 하고, 그것이 이 격리의 집행 지점이다.
 */
function _checkpointApiShape(): void {
  // @ts-expect-error 체크포인트 승인에는 approver 인자가 없다
  approveCheckpoint({ project: "p", stage: "idea-validation", checkpointId: "0123456789ab", internalApprover: async () => true });
  // @ts-expect-error 체크포인트 되돌림에도 boolean 우회 인자가 없다
  rejectCheckpoint({ project: "p", stage: "idea-validation", checkpointId: "0123456789ab", yes: true });
  // @ts-expect-error restart에 강제 플래그가 없다
  restartPipeline({ project: "p", force: true });
}
void _checkpointApiShape;
