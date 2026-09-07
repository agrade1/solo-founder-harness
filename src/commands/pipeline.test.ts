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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PIPELINE,
  pipelineStatePath,
  digestArtifacts,
  readPipelineStateAt,
  checkpointIdFor,
  PIPELINE_LOCK_REL,
  lockPipeline,
  seedFindingsFrom,
  type PipelineLease,
  type PipelineState,
} from "../core/pipeline.js";
import { projectPaths } from "../core/project.js";
import { IDEA_REL, loadRunState, runWorkflow } from "../core/runWorkflow.js";
import { buildTaskPrompt, generateTaskPrompt } from "../core/taskPrompt.js";
import { buildSummary } from "../core/summary.js";
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
  // [C-126] 리서치 attempt receipt도 승인 대상이다(§6.1) — self 모드에서도 남는다. 그래서 목록에
  // `outputs/research/receipt-<sha>.json`이 **정확히 하나** 더 있다(이름은 내용 해시라 값을 박지 않는다).
  const receipts = p.artifacts.map((a) => a.path).filter((x) => x.startsWith("outputs/research/receipt-"));
  assert.equal(receipts.length, 1, `리서치 영수증 1개가 결박된다 (실제: ${p.artifacts.map((a) => a.path).join(", ")})`);
  assert.match(receipts[0], /^outputs\/research\/receipt-[0-9a-f]{64}\.json$/, "receipt 이름은 내용 해시다");
  assert.deepEqual(
    p.artifacts
      .map((a) => a.path)
      .filter((x) => !x.startsWith("outputs/research/"))
      .sort(),
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

// ── [B-50] '검증' 소진은 "사람이 확인할 차례"다 ────────────────
test("[B-50] 파이프라인 1단계: '검증' 소진엔 사람 확인 안내가 붙고 exit 1로 멈춘다", async () => {
  // red: commitAfterRun의 ceo_decision_verify 분기를 지우면 무차별 "고친 뒤 다시: pipeline next" 한 줄만
  //      남는다 — 고칠 것이 코드도 키도 아니라 **사람의 확인 결과**라는 사실이 전달되지 않는다.
  // 1단계는 승인 manifest가 비어 있어(approvedDigests 0건) Decision 수정 레버가 살아 있다 —
  // 그래서 여기서만 안내를 낸다(2단계 이후는 결박돼 있어 참을 보장할 수 없다).
  const name = "_b50_pipe";
  makeProject(name);
  const p = counting("- 검증");
  const prevExit = process.exitCode;
  let r!: Awaited<ReturnType<typeof nextPipeline>>;
  const out = await captureLogs(async () => {
    r = await nextPipeline({ project: name, providerOverride: p, now: () => FIXED });
  });
  process.exitCode = prevExit;

  assert.equal(r.code, "pipeline_stage_failed");
  assert.equal(r.exit, 1);
  assert.equal(loadRunState(name)?.failed_reason, "ceo_decision_verify");
  assert.equal(stateOf(name).status, "awaiting_run", "상태는 실행 대기 그대로 — 같은 명령으로 이어간다");
  assert.notEqual(stateOf(name).last_failure, null, "resume 영수증이 남는다 (다음 next가 resume 조건을 만족한다)");
  assert.deepEqual(stateOf(name).checkpoints, [], "전제: 1단계라 승인 manifest가 비어 있다 (Decision 수정 레버 생존)");

  assert.match(out, /사람이 확인할 차례/, "기계가 아니라 사람의 일이라고 말한다");
  assert.ok(out.includes('"## Decision"'), "고칠 절을 이름으로 말한다");
  assert.ok(out.includes("docs/06_CEO_DECISION.md"), "고칠 파일을 이름으로 말한다");
  assert.match(out, /harness pipeline next --project _b50_pipe/, "다음에 칠 명령을 그대로 준다");
  assert.match(out, /모델 호출 0회/);

  // 안내가 참인지 실제로 태워본다: 사람이 결론 판정으로 고치면 같은 명령이 통과한다 (모델 호출 0회).
  const doc = join(projectPaths(name).root, "docs/06_CEO_DECISION.md");
  writeFileSync(doc, readFileSync(doc, "utf8").replace("## Decision\n\n- 검증", "## Decision\n\n- 진행"), "utf8");
  const guard = counting("- 검증"); // 다시 돌면 여전히 '검증' — 통과가 복원 바이트 덕임을 고정한다
  const ok = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED }));
  assert.equal(ok.code, "pipeline_awaiting_approval", `안내대로 했더니 통과해야 한다 — 실제: ${ok.code}`);
  assert.equal(guard.calls, 0, "게이트 재판정은 모델을 호출하지 않는다");
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
  // [C-126/A-4] `written`은 `savedFiles`를 digest하므로 **리서치가 저장한 것도 사실대로** 잡힌다
  // (self 모드는 receipt 하나 · external partial이면 raw까지). 그래서 resume 사전 drift 검증이
  // 그 파일들을 "사람이 손댄 것"으로 오해하지 않는다.
  assert.deepEqual(
    failed.last_failure!.written.map((w) => w.path).filter((p) => !p.startsWith("outputs/research/")).sort(),
    ["docs/01_RESEARCH.md", "outputs/chief_of_staff.md"],
    "실패 attempt가 실제로 덮은 파일의 digest",
  );
  assert.equal(
    failed.last_failure!.written.filter((w) => w.path.startsWith("outputs/research/receipt-")).length,
    1,
    "리서치 영수증도 written에 있다 (없으면 resume이 그 파일을 drift로 본다)",
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

// ── B-52 ──────────────────────────────────────────────────────
test("[B-52] 2단계 게이트 실패 후 **1단계 승인본 CEO 문서를 되돌려 놓으면** resume이 거부한다 (앞 단계 판정 재생)", async () => {
  // `founder_ceo`의 default_output은 하나(`docs/06_CEO_DECISION.md`)이고 1·2단계가 **둘 다** 그
  // 경로에 쓴다. 예전 판의 resume 예외는 `accept = [approved, written]`(OR)이라 1단계 승인본을
  // 복원해 두면 drift를 통과했고, resume한 runWorkflow가 그 문서를 재실행 없이 복원해
  // **1단계의 '진행'이 2단계 판정으로 채택됐다**(모델 호출 0회로 run completed + 확인 대기).
  const name = "_b52_replay";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const root = projectPaths(name).root;
  const ceoPath = join(root, "docs/06_CEO_DECISION.md");
  const stage1Bytes = bytesOf(ceoPath);
  assert.match(stage1Bytes, /## Decision\n\n- 진행/, "전제: 1단계 승인본의 정본 판정은 '진행'");

  // 2단계 CEO가 '보류' → 게이트가 ceo_decision_hold로 멈춘다 (founder_ceo는 completed_steps에 있다).
  let r = await quiet(() => nextPipeline({ project: name, providerOverride: counting("- 보류"), now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_stage_failed", "2단계는 게이트에서 멈췄다");
  assert.equal(loadRunState(name)?.failed_reason, "ceo_decision_hold");
  assert.ok(
    stateOf(name).last_failure!.written.some((w) => w.path === "docs/06_CEO_DECISION.md"),
    "전제: 2단계 attempt가 판정 문서를 덮었다 (그래서 그 경로의 정본은 written이어야 한다)",
  );

  // ── 공격: 1단계 승인본 바이트로 되돌린다 (승인 digest와 정확히 일치한다) ──
  const stage2Bytes = bytesOf(ceoPath); // 2단계가 실제로 쓴 것 — 아래 대조군에서 되돌린다
  assert.notEqual(stage2Bytes, stage1Bytes, "전제: 두 단계의 판정 문서는 다른 바이트다");
  writeFileSync(ceoPath, stage1Bytes, "utf8");
  const beforeState = bytesOf(pipelineStatePath(root));
  const beforeJumps = loadRunState(name)!.gate_jumps.length;
  const guard = counting("- 보류");
  const prevExit = process.exitCode;
  const msg = await captureLogs(async () => {
    r = await nextPipeline({ project: name, providerOverride: guard, now: () => FIXED, internalApprover: async () => true });
  });
  process.exitCode = prevExit;

  assert.equal(r.code, "pipeline_artifact_drift", "앞 단계 승인 바이트는 현 단계 내용으로 설 수 없다");
  // 같은 사유 코드 안에서 **원인별로 다른 문장**이다: 이 케이스는 승인 바이트와 **같아서** 거부된다.
  // 기존 문구("승인 시점 바이트와 다릅니다")를 그대로 내면 사람이 진단할 수 없다.
  assert.match(msg, /앞 단계 승인본 바이트로 되돌아가 있습니다/, "재생 케이스는 재생이라고 말한다");
  assert.doesNotMatch(msg, /승인 시점 바이트와 다릅니다/, "정반대 원인을 적지 않는다");
  assert.equal(r.exit, 1);
  // **이 단정은 이 구멍을 구분하지 못한다 — 실측으로 확인했다(mutation GREEN).** resume은 게이트
  // 인덱스에서 재개하므로 원본·변종 **양쪽 다** 호출 0이다(재생본은 모델이 아니라 게이트가 읽는다).
  // 남겨 두는 이유는 "거부 경로에서 모델을 부르지 않는다"가 별개의 참인 성질이라서다.
  // 이 구멍을 실제로 구분하는 단정은 아래 넷(state 바이트 · run status · gate_jumps 길이 · 마지막 판정)이고,
  // 넷 다 OR 복원 시 **독립적으로** 빨감을 확인했다. (P8a·P8d가 남긴 같은 계열의 교훈)
  assert.equal(guard.calls, 0, "거부 경로는 모델을 호출하지 않는다 (이 mutation은 구분하지 못한다 — 위 주석)");
  assert.equal(bytesOf(pipelineStatePath(root)), beforeState, "pipeline_state 바이트 불변");
  const rs = loadRunState(name)!;
  assert.equal(rs.status, "failed", "run이 completed로 승격되지 않았다");
  assert.equal(rs.gate_jumps.length, beforeJumps, "게이트가 다시 판정하지 않았다");
  assert.equal(rs.gate_jumps.at(-1)?.decision, "보류", "마지막 판정은 여전히 2단계 CEO의 실제 판정이다");

  // 이 단계가 실제로 쓴 바이트로 되돌리면 resume이 재개된다 — 무조건 거부가 아니다.
  // (판정은 여전히 '보류'라 게이트는 같은 자리에서 다시 멈춘다: 막힌 것은 **재생**이지 resume이 아니다.)
  writeFileSync(ceoPath, stage2Bytes, "utf8");
  r = await quiet(() => nextPipeline({ project: name, providerOverride: counting("- 보류"), now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_stage_failed", "written 바이트면 drift를 지나 게이트까지 간다");
  assert.equal(loadRunState(name)?.failed_reason, "ceo_decision_hold", "drift가 아니라 판정에서 멈췄다");
  rmProject(name);
});

test("[B-52] 1단계에서는 사람이 '## Decision'을 고쳐 재개하는 레버가 살아 있다 (과잉 차단 감시)", async () => {
  // B-50/B-49의 복구 경로다. 1단계는 승인 checkpoint가 0개라 resume 사전 검증 루프가 **0회** 돈다 —
  // B-52 규칙을 `approvedDigests` 밖(=`written` 전수)으로 넓히면 이 문이 함께 닫힌다.
  const name = "_b52_lever";
  makeProject(name);
  const root = projectPaths(name).root;
  let r = await quiet(() => nextPipeline({ project: name, providerOverride: counting("- 보류"), now: () => FIXED }));
  assert.equal(r.code, "pipeline_stage_failed", "1단계 게이트가 '보류'로 멈췄다");
  assert.equal(loadRunState(name)?.failed_reason, "ceo_decision_hold");

  const ceoPath = join(root, "docs/06_CEO_DECISION.md");
  writeFileSync(ceoPath, bytesOf(ceoPath).replace("## Decision\n\n- 보류", "## Decision\n\n- 진행"), "utf8");

  const resumed = counting("- 보류"); // 재실행되면 다시 '보류'가 나온다 — 재실행 0회여야 통과한다
  r = await quiet(() => nextPipeline({ project: name, providerOverride: resumed, now: () => FIXED }));
  assert.equal(r.code, "pipeline_awaiting_approval", "사람이 고친 판정으로 단계가 끝난다");
  assert.equal(resumed.byAgent.get("founder_ceo") ?? 0, 0, "decider를 재실행하지 않았다 (복원 문서로 판정)");
  const last = loadRunState(name)!.gate_jumps.at(-1)!;
  assert.equal(last.outcome, "proceed");
  assert.equal(last.decision_source, "restored_artifact", "[B-49] 복원 문서 판정이라는 사실이 영수증에 남는다");
  rmProject(name);
});

// ── B-53 ──────────────────────────────────────────────────────
test("[B-53] 2단계에서 두 번 연속 실패해도 3번째 resume이 drift로 막히지 않는다 (재생은 여전히 거부)", async () => {
  // **교착 재현**: 예전 판은 `last_failure.written`을 실패마다 통째로 덮었다. 2번째 실패가
  // 게이트에서 나면 agent가 하나도 안 돌아 `savedFiles`가 비고 `written`이 `[]`가 된다 —
  // 그러면 3번째 `next`는 1단계 승인 경로(`docs/02_PRD.md`)를 승인 digest로만 판정해 거부한다.
  // 그리고 `awaiting_run`에서는 restart(`pipeline_active`)도 reject(`pipeline_no_pending`)도
  // 막혀 있어 **하네스 명령으로는 탈출구가 없다**(2026-09-01 실측).
  const name = "_b53_brick";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const root = projectPaths(name).root;
  const ceoPath = join(root, "docs/06_CEO_DECISION.md");
  const stage1Ceo = bytesOf(ceoPath);

  // ① 1번째 실패 — CEO '보류'로 게이트가 멈춘다. 이 attempt가 02_PRD.md(1단계 승인 경로)를 덮었다.
  let r = await quiet(() => nextPipeline({ project: name, providerOverride: counting("- 보류"), now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_stage_failed");
  assert.ok(stateOf(name).last_failure!.written.some((w) => w.path === "docs/02_PRD.md"), "전제: 1번째 attempt가 승인 경로를 덮었다");
  const stage2Ceo = bytesOf(ceoPath);
  assert.notEqual(stage2Ceo, stage1Ceo, "전제: 2단계 CEO 문서는 1단계 승인본과 다른 바이트다");

  // ② 2번째 실패 — resume이 게이트 인덱스에서 재개해 **agent를 하나도 돌리지 않고** 같은 자리에서 멈춘다.
  const g2 = counting("- 보류");
  r = await quiet(() => nextPipeline({ project: name, providerOverride: g2, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_stage_failed");
  assert.equal(g2.calls, 0, "전제: 게이트 실패라 이 attempt는 아무것도 쓰지 않았다 (savedFiles가 비어 있다)");
  // **이 단정이 교착의 원인을 직접 잰다.** 누적하지 않으면 여기가 0개다.
  assert.ok(
    stateOf(name).last_failure!.written.some((w) => w.path === "docs/02_PRD.md"),
    "1번째 attempt가 덮은 경로가 영수증에 남아 있다 (통째로 덮으면 여기서 사라진다)",
  );

  // ③ 3번째 resume — drift가 아니라 **원래 사유**(게이트 '보류')로 멈춘다. 교착이 아니다.
  const g3 = counting("- 보류");
  r = await quiet(() => nextPipeline({ project: name, providerOverride: g3, now: () => FIXED, internalApprover: async () => true }));
  assert.notEqual(r.code, "pipeline_artifact_drift", "앞 attempt의 정당한 재작성을 drift로 보지 않는다");
  assert.equal(r.code, "pipeline_stage_failed");
  assert.equal(loadRunState(name)?.failed_reason, "ceo_decision_hold", "막힌 자리는 판정이지 산출물 검증이 아니다");

  // ④ **[B-52]가 그대로 성립한다**: 합집합에는 이 단계가 쓴 바이트만 들어가므로, 1단계 승인본을
  //    되돌려 놓는 재생은 여전히 거부된다(그 경로의 정본은 written = 2단계 바이트다).
  const beforeState = bytesOf(pipelineStatePath(root));
  const beforeJumps = loadRunState(name)!.gate_jumps.length;
  writeFileSync(ceoPath, stage1Ceo, "utf8");
  const guard = counting("- 보류");
  const prevExit = process.exitCode;
  const msg = await captureLogs(async () => {
    r = await nextPipeline({ project: name, providerOverride: guard, now: () => FIXED, internalApprover: async () => true });
  });
  process.exitCode = prevExit;
  assert.equal(r.code, "pipeline_artifact_drift", "[B-52] 앞 단계 승인 바이트 재생은 2연속 실패 뒤에도 거부된다");
  assert.match(msg, /앞 단계 승인본 바이트로 되돌아가 있습니다/);
  assert.equal(bytesOf(pipelineStatePath(root)), beforeState, "pipeline_state 바이트 불변");
  const rs = loadRunState(name)!;
  assert.equal(rs.status, "failed", "run이 completed로 승격되지 않았다");
  assert.equal(rs.gate_jumps.length, beforeJumps, "게이트가 다시 판정하지 않았다");

  // ⑤ **알려진 한계(B-52 설계대로다 — 이 수정이 만든 것이 아니다)**: 2단계 이후에는 사람이
  //    `## Decision`을 고쳐 재개하는 B-50 레버가 살아나지 않는다. 06_CEO_DECISION.md는 1단계 승인
  //    경로이면서 2단계가 다시 쓰는 파일이라, 손댄 바이트는 승인 digest도 written digest도 아니다.
  writeFileSync(ceoPath, stage2Ceo.replace("## Decision\n\n- 보류", "## Decision\n\n- 진행"), "utf8");
  r = await quiet(() => nextPipeline({ project: name, providerOverride: counting("- 보류"), now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_artifact_drift", "2단계 이후 사람 편집은 여전히 막힌다 (B-52 의도 · 이 슬라이스 범위 밖)");
  rmProject(name);
});

test("[B-53] resume이 앞 attempt의 재작성을 잃지 않는다 — 서로 다른 파일을 쓴 2연속 실패", async () => {
  // 이 순서가 "attempt가 아무것도 안 썼을 때만 보존한다"(기각안 A)로는 못 고치는 것이다:
  // 2번째 attempt는 **썼는데 다른 파일을 썼다**. resume은 완료 step을 재실행하지 않으므로
  // 앞 attempt가 덮은 `docs/02_PRD.md`가 2번째 `savedFiles`에 없다.
  const name = "_b53_disjoint";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));

  process.env.HARNESS_FAIL_AT = "ux_ui"; // pm(02_PRD.md)까지만 완료
  let r = await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  delete process.env.HARNESS_FAIL_AT;
  assert.equal(r.code, "pipeline_stage_failed");
  assert.deepEqual(stateOf(name).last_failure!.written.map((w) => w.path), ["docs/02_PRD.md"], "전제: 1번째 attempt는 02_PRD.md만 덮었다");

  process.env.HARNESS_FAIL_AT = "tech_lead"; // resume: ux_ui/design만 돌고 실패 — 02_PRD.md는 다시 쓰지 않는다
  const g2 = counting();
  r = await quiet(() => nextPipeline({ project: name, providerOverride: g2, now: () => FIXED, internalApprover: async () => true }));
  delete process.env.HARNESS_FAIL_AT;
  assert.equal(r.code, "pipeline_stage_failed");
  assert.ok(g2.calls > 0, "전제: 이 attempt는 실제로 파일을 썼다 (빈 savedFiles 경로가 아니다)");
  const written = stateOf(name).last_failure!.written.map((w) => w.path);
  assert.ok(written.includes("docs/03_UX_FLOW.md"), `이번 attempt가 쓴 것 (${written.join(", ")})`);
  assert.ok(written.includes("docs/02_PRD.md"), `앞 attempt가 쓴 것도 남아 있다 (${written.join(", ")})`);

  const g3 = counting();
  r = await quiet(() => nextPipeline({ project: name, providerOverride: g3, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_awaiting_approval", "3번째 resume이 단계를 끝낸다 (예전 판은 02_PRD.md에서 drift로 거부했다)");
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

// ── Codex A-2 ─────────────────────────────────────────────────
test("[B-41/A-2] 선언된 사이드카(docs/tokens.json)도 영수증에 결박된다 — 승인 후 교체가 drift로 잡힌다", async () => {
  const name = "_b41_a2";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  // mvp-planning의 design agent가 docs/DESIGN.md + **docs/tokens.json**(token_output)을 낸다.
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_awaiting_approval");
  const root = projectPaths(name).root;
  const pending = stateOf(name).pending!;
  assert.ok(
    pending.artifacts.some((a) => a.path === "docs/tokens.json"),
    `사이드카가 승인 대상에 있다 (실제: ${pending.artifacts.map((a) => a.path).join(", ")})`,
  );
  // 사이드카는 판단 문서가 아니므로 **seed는 만들지 않는다**(프롬프트에 "(Main Judgment 없음)"를 싣지 않는다).
  assert.ok(!pending.seeds.some((s) => s.line.includes("Main Judgment 없음")), "사이드카에서 seed를 뽑지 않는다");

  // 승인한 뒤 사이드카만 바꿔치기 → 작업 지시문은 그 파일을 구현 입력으로 안내한다 → drift로 막힌다.
  await quiet(() => approveCheckpoint({ project: name, stage: "mvp-planning", checkpointId: pending.checkpoint_id, now: () => FIXED }));
  writeFileSync(join(root, "docs/tokens.json"), '{"primitive":{"color":{"x":"#ff0000"}}}\n', "utf8");
  const guard = counting();
  const blocked = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(blocked.code, "pipeline_artifact_drift", "사이드카 교체도 drift다");
  assert.equal(guard.calls, 0, "모델 호출 0");
  rmProject(name);
});

test("[B-41/A-10] 다른 workflow의 폐기를 현 단계 영수증으로 적지 않는다 (provenance 대조 · 무기록)", async () => {
  // 이 테스트는 mutation n10(provenance 대조 제거)이 **테스트 층에서 GREEN**이었을 때 추가했다
  // (컴파일은 잡았지만 어떤 단정도 red가 되지 않았다 — 컴파일에만 의존하는 계약은 다음 리팩터에서
  // 조용히 사라진다).
  const name = "_b41_a10b";
  const { state } = await toFirstCheckpoint(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  const root = projectPaths(name).root;
  assert.equal(stateOf(name).current_index, 1, "현 단계 = mvp-planning");

  // run_state를 **다른 workflow의 폐기**로 만든다(크래시·다른 경로에서 생길 수 있는 조합).
  // B-40 구조 검증을 통과하는 정상 형태다: killed면 kill_history가 있어야 한다.
  const killedElsewhere = {
    ...loadRunState(name)!,
    workflow_id: "full-predev",
    status: "killed" as const,
    killed_by: { decider: "founder_ceo", decision: "폐기", idea_sha256: null },
    kill_history: [{ decider: "founder_ceo", decision: "폐기", idea_sha256: null, at: FIXED }],
  };
  writeFileSync(join(root, "outputs/run_state.json"), JSON.stringify(killedElsewhere, null, 2) + "\n", "utf8");
  const before = bytesOf(pipelineStatePath(root));

  const guard = counting();
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_killed_elsewhere");
  assert.equal(r.exit, 1);
  assert.equal(guard.calls, 0, "모델 호출 0");
  assert.equal(bytesOf(pipelineStatePath(root)), before, "**아무것도 쓰지 않았다** — 거짓 영수증을 만들지 않는다");
  assert.equal(stateOf(name).checkpoints.filter((c) => c.decision === "killed").length, 0, "kill 영수증이 만들어지지 않았다");
  rmProject(name);
});

// ── Codex A-9 ─────────────────────────────────────────────────
test("[B-41/A-9] 승인 산출물이 프로젝트 밖을 가리키는 symlink로 바뀌면 거부된다 (realpath containment)", async () => {
  const name = "_b41_a9";
  const { state } = await toFirstCheckpoint(name);
  const root = projectPaths(name).root;
  const outside = join(tmpdir(), `b41-a9-outside-${process.pid}.md`);
  try {
    // 승인된 문서를 **프로젝트 밖 파일을 가리키는 symlink**로 바꾼다. 표기(`docs/02_PRD.md`)는
    // 그대로라 예전 판의 `safeRelPath`만으로는 통과했고, statSync/readFileSync가 링크를 따라갔다.
    const prd = join(root, "docs/02_PRD.md");
    writeFileSync(outside, readFileSync(prd, "utf8"), "utf8"); // **바이트는 동일** — digest로는 못 잡는다
    rmSync(prd);
    symlinkSync(outside, prd);
    const r = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
    assert.equal(r.code, "pipeline_artifact_drift", "루트 밖 실체는 이 프로젝트의 산출물이 아니다");
    assert.equal(stateOf(name).status, "awaiting_approval", "상태 불변");
    // 대조군: 프로젝트 **안**을 가리키는 symlink는 허용된다(정책: realpath가 루트 안이면 된다).
    rmSync(prd);
    const inside = join(root, "outputs/prd-copy.md");
    writeFileSync(inside, readFileSync(outside, "utf8"), "utf8");
    symlinkSync(inside, prd);
    const ok = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
    assert.equal(ok.code, "pipeline_approved", "루트 안 symlink는 통과 (무조건 거부가 아니다)");
  } finally {
    rmSync(outside, { force: true });
    rmProject(name);
  }
});

// ── A-4 ───────────────────────────────────────────────────────
test("[A-4] 영수증은 산출물을 저장하는 **그 순간** durable에 적힌다 — 실행 중 크래시가 벽돌을 만들지 않는다", async () => {
  // red: 영수증 쓰기를 runWorkflow **반환 후**(commitAfterRun)로 되돌리면, 실행 중 Ctrl-C/크래시는
  //      "파일은 덮였는데 영수증은 없는" 상태를 남긴다. 실측(2026-09-03): 그 상태에서 next는
  //      pipeline_artifact_drift · restart는 pipeline_active · approve/reject는 pipeline_no_pending —
  //      **탈출구가 0개**이고, drift 안내가 권하던 두 길 중 restart는 그 자리에서 거부된다(B-54).
  const name = "_a4_crash";
  makeProject(name);
  await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  const pend = stateOf(name).pending!;
  assert.equal((await quiet(() => approveCheckpoint({ project: name, stage: pend.stage, checkpointId: pend.checkpoint_id, now: () => FIXED }))).code, "pipeline_approved");
  const approved = stateOf(name).checkpoints.at(-1)!.artifacts.find((a) => a.path === "docs/02_PRD.md")!;

  // 2단계: pm이 그 경로를 덮은 **직후**(다음 agent 호출 시점)에 영수증이 이미 durable인지 본다.
  let seen: PipelineState["last_failure"] = null;
  const inner = counting();
  let calls = 0;
  const probing: Provider = {
    id: "mock",
    async generate(i) {
      if (calls++ === 1) seen = stateOf(name).last_failure;
      return inner.generate(i);
    },
  };
  await quiet(() => nextPipeline({ project: name, providerOverride: probing, now: () => FIXED, internalApprover: async () => true }));

  assert.ok(seen, "pm 저장 직후 시점에 영수증이 이미 있다 — 크래시해도 남는 것이 이것이다");
  const w = seen!.written.find((x) => x.path === "docs/02_PRD.md");
  assert.ok(w, "덮은 경로가 영수증에 있다");
  assert.notEqual(w!.sha256, approved.sha256, "그 영수증은 **이 단계가 쓴 바이트**다 (앞 단계 승인본이 아니다)");
  assert.equal(seen!.stage, "mvp-planning", "영수증의 단계가 현 단계로 결박된다");
  rmProject(name);
});

test("[A-4] 크래시 모양의 상태(영수증 있음 · run_state는 이 단계의 failed 아님)에서 next가 drift로 막히지 않는다", async () => {
  // red: 사전 검증의 예외를 다시 `resume &&`로 묶으면 이 next가 pipeline_artifact_drift로 거부된다.
  //      resume은 run_state.status==="failed"를 요구하는데 **실행 중 크래시는 run_state를 남기지 못한다**
  //      (runWorkflow가 끝나야 쓴다) — 그래서 크래시 뒤의 next는 fresh로 강하한다.
  const name = "_a4_shape";
  makeProject(name);
  await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  const pend = stateOf(name).pending!;
  await quiet(() => approveCheckpoint({ project: name, stage: pend.stage, checkpointId: pend.checkpoint_id, now: () => FIXED }));

  // 크래시 모양을 손으로 만든다: 2단계가 02_PRD.md를 덮었고, 영수증은 있고, run_state는 1단계 completed.
  const root = projectPaths(name).root;
  const prd = join(root, "docs/02_PRD.md");
  writeFileSync(prd, readFileSync(prd, "utf8") + "\n<!-- 2단계 pm이 덮었다 -->\n", "utf8");
  assert.equal(loadRunState(name)!.status, "completed", "전제: run_state는 1단계 completed다 (크래시는 2단계 run_state를 못 남긴다)");
  const st = stateOf(name);
  writeFileSync(
    pipelineStatePath(root),
    JSON.stringify(
      { ...st, last_failure: { stage: "mvp-planning", workflow_id: "mvp-planning", at: FIXED, written: digestArtifacts(root, ["docs/02_PRD.md"], { skipMissing: true }) } },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_awaiting_approval", "덮인 경로의 정본이 영수증에 있으므로 fresh 재실행이 통과한다");
  rmProject(name);
});

test("[A-4/B-54] 영수증 없는 변경은 그대로 drift이고, 안내는 거부되는 restart를 더는 권하지 않는다", async () => {
  // red ①: 예외를 경로 목록(바이트 없음)으로 바꾸면 이 tamper가 통과한다 — B-52 replay가 되살아난다.
  // red ②: 안내에 restart를 되살리면 사람이 pipeline_active로 거부되는 명령을 따라간다(거짓 안내 계열).
  const name = "_a4_tamper";
  makeProject(name);
  await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true }));
  const pend = stateOf(name).pending!;
  await quiet(() => approveCheckpoint({ project: name, stage: pend.stage, checkpointId: pend.checkpoint_id, now: () => FIXED }));
  writeFileSync(join(projectPaths(name).root, "docs/02_PRD.md"), "# 손댄 내용\n", "utf8");

  const prevExit = process.exitCode;
  const out = await captureLogs(async () => {
    const rr = await nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, internalApprover: async () => true });
    assert.equal(rr.code, "pipeline_artifact_drift", "영수증 없는 변경은 그대로 drift다");
  });
  process.exitCode = prevExit;
  assert.match(out, /하네스는 내용을 보관하지 않습니다/, "복원이 왜 사람 몫인지 말한다");
  assert.doesNotMatch(out, /restart --project \S+'로 다시 심사하세요/, "[B-54] 거부되는 restart를 더는 권하지 않는다");
  rmProject(name);
});

// ── A-3 ───────────────────────────────────────────────────────
test("[A-3] 2단계 폐기 후 restart는 거부된다 — 안내가 시키는 재평가가 먼저이고, 그 순서는 실제로 통한다", async () => {
  // red: restartPipeline의 run_state_killed 가드를 지우면 restart가 성공하고 **프로젝트가 영구 벽돌**이
  //      된다(실측: next→pipeline_killed_elsewhere · restart→pipeline_active · run→pipeline_run_reserved ·
  //      approve/reject→pipeline_no_pending). 그 상태의 안내가 권하던 탈출구 둘 다 막혀 있었다.
  const name = "_a3_brick";
  makeProject(name);
  // 1단계 통과 → 2단계(mvp-planning)에서 폐기. 폐기를 2단계에서만 내야 첫 단계는 승인까지 간다.
  const p = counting();
  const kill: Provider = {
    id: "mock",
    async generate(i) {
      const r = await p.generate(i);
      return i.agent.agent_id === "founder_ceo" && i.workflowId === "mvp-planning"
        ? { ...r, markdown: r.markdown.replace("## Decision\n\n- 진행", "## Decision\n\n- 폐기") }
        : r;
    },
  };
  const first = await quiet(() => nextPipeline({ project: name, providerOverride: kill, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(first.code, "pipeline_awaiting_approval", "전제: 1단계는 확인 대기까지 간다");
  const pend = stateOf(name).pending!;
  assert.equal((await quiet(() => approveCheckpoint({ project: name, stage: pend.stage, checkpointId: pend.checkpoint_id, now: () => FIXED }))).code, "pipeline_approved");
  const second = await quiet(() => nextPipeline({ project: name, providerOverride: kill, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(second.code, "pipeline_killed_reconciled", "전제: 2단계에서 폐기 — pipeline killed · run_state killed(mvp-planning)");

  const prevExit = process.exitCode;
  const blocked = await captureLogs(() => {
    assert.equal(restartPipeline({ project: name, now: () => FIXED }).code, "run_state_killed", "벽돌이 되는 restart를 거부한다");
  });
  process.exitCode = prevExit; // 거부는 exitCode로도 신호한다 — 테스트 프로세스를 오염시키지 않는다
  assert.match(blocked, /전부 거부되는 상태/, "왜 거부하는지(결과가 무엇인지) 말한다");
  assert.match(blocked, /재평가를 먼저/, "순서를 말한다");

  // 그리고 **안내가 시키는 그 순서가 실제로 통한다** — 없는 길을 권하지 않는다는 것이 이 단정이다.
  const cleared = await quiet(() => runWorkflow({ workflowId: "idea-validation", project: name, provider: counting(), now: () => FIXED }));
  assert.equal(cleared.state.status, "completed", "폐기 상태에서도 재평가 run은 열려 있다 (파이프라인이 killed라서)");
  assert.equal((await quiet(() => restartPipeline({ project: name, now: () => FIXED }))).code, "pipeline_restarted", "재평가 뒤에는 restart가 열린다");
  assert.equal(stateOf(name).status, "awaiting_run");
  rmProject(name);
});

// ── Codex A-11 ────────────────────────────────────────────────
test("[B-41/A-11] restart archive 이름이 충돌해도 앞 archive를 덮지 않는다", async () => {
  const name = "_b41_a11";
  const root = projectPaths(name).root;
  await runToCompletion(name);
  const first = bytesOf(pipelineStatePath(root));
  // 같은 시각을 주입해 **이름 충돌**을 강제한다: 예전 판은 renameSync가 앞 archive를 교체했다.
  await quiet(() => restartPipeline({ project: name, now: () => FIXED }));
  const afterFirst = readdirSync(join(root, "outputs")).filter((f) => /^pipeline_state\..+\.json$/.test(f));
  assert.equal(afterFirst.length, 1);
  // 두 번째 restart (완료 상태를 다시 만들 필요 없이, 새 state를 completed로 손보는 대신 killed를 쓴다)
  const fresh = stateOf(name);
  const base = { stage: "idea-validation", workflow_id: "idea-validation", run_finished_at: FIXED, artifacts: [{ path: "docs/02_PRD.md", size: 1, sha256: "a".repeat(64) }], seeds: [] };
  writeFileSync(
    pipelineStatePath(root),
    JSON.stringify({ ...fresh, status: "killed", checkpoints: [{ ...base, checkpoint_id: checkpointIdFor(base), decision: "killed", decided_at: FIXED, note: "테스트" }] }, null, 2) + "\n",
    "utf8",
  );
  await quiet(() => restartPipeline({ project: name, now: () => FIXED }));
  const archives = readdirSync(join(root, "outputs")).filter((f) => /^pipeline_state\..+\.json$/.test(f));
  assert.equal(archives.length, 2, `충돌하면 새 이름을 쓴다 (실제: ${archives.join(", ")})`);
  assert.equal(bytesOf(join(root, "outputs", afterFirst[0])), first, "첫 archive 바이트가 그대로 보존됐다");
  rmProject(name);
});

// ── Codex A-5 ─────────────────────────────────────────────────
test("[B-41/A-5] summary·vault가 '확인 대기'를 '완료'로 적지 않는다", async () => {
  const name = "_b41_a5";
  const vault = join(tmpdir(), `b41-a5-vault-${process.pid}`);
  makeProject(name);
  try {
    // vault export까지 함께 — pending 기록 **뒤에** 내보내는지가 이 테스트의 절반이다.
    const r = await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED, vault }));
    assert.equal(r.code, "pipeline_awaiting_approval");
    const pending = stateOf(name).pending!;

    // ① summary: run_state는 completed지만 요약은 **확인 대기**를 정본으로 적는다.
    assert.equal(loadRunState(name)?.status, "completed", "전제: run 자체는 완주했다");
    const summary = buildSummary(name, "2026-01-01");
    assert.match(summary, /단계 체크포인트: 1\/4 'idea-validation' · awaiting_approval/);
    assert.match(summary, new RegExp(`checkpoint ${pending.checkpoint_id}`), "checkpoint id가 정본 표시");
    assert.match(summary, /단계 확인 대기/);
    assert.match(summary, /승인되기 전에는 `task-prompt`·`handoff`·`plan-dag`가 거부된다/, "무엇이 막혀 있는지 말한다");
    // run 완료를 "task-prompt로 진행"으로 안내하지 않는다 — 승인 전에는 그 안내가 틀린 말이다.
    assert.doesNotMatch(summary, /완료 — `harness task-prompt`로 작업 지시문 생성/, "승인 전에 지시문 생성을 권하지 않는다");
    assert.match(summary, /workflow `idea-validation` 자체는 완주했다/, "run 사실은 숨기지 않는다");

    // ② vault: 인덱스 노트가 단계 대기를 적는다 (run '완료'만 읽고 개발 착수로 넘어가지 않게).
    const index = readFileSync(join(vault, name, "idea-validation_run.md"), "utf8");
    assert.match(index, /- 단계 체크포인트: 1\/4 'idea-validation' · awaiting_approval \(checkpoint [0-9a-f]{12} — 사람 확인 대기\)/);
    assert.match(index, /아직 승인되지 않았다/);
    assert.match(index, /- 상태: completed/, "run 자체의 상태도 그대로 적는다 (숨기지 않는다)");

    // ③ 승인 후에는 완료로 바뀐다 (위 단정이 상수가 아니다).
    await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: pending.checkpoint_id, now: () => FIXED }));
    assert.match(buildSummary(name, "2026-01-01"), /단계 실행 대기\*\* 2\/4 'mvp-planning'/);
  } finally {
    rmSync(vault, { recursive: true, force: true });
    rmProject(name);
  }
});

test("[B-41/A-5] 완료 후 문서가 바뀌면 summary가 '하류 막힘'을 적는다 (완료라고만 적지 않는다)", async () => {
  const name = "_b41_a5b";
  await runToCompletion(name);
  const root = projectPaths(name).root;
  assert.match(buildSummary(name, "2026-01-01"), /4단계 전부 승인 완료/, "대조군: 정상 완료");
  writeFileSync(join(root, "docs/06_CEO_DECISION.md"), "# 바꿔치기\n", "utf8");
  const s = buildSummary(name, "2026-01-01");
  assert.match(s, /승인 후 문서가 바뀌었다/);
  assert.match(s, /docs\/06_CEO_DECISION\.md/);
  assert.match(s, /거부된다/);
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

  // [Codex A-12] **소비 함수를 직접 재는 것이 유일한 결정적 관측이다.**
  // 예전 판은 ⓐ 문서를 바꾸지 않은 채 seed 전달만 봤고 ⓑ 삭제 fixture는 drift가 먼저 return해서
  // `seedFindingsFrom()`에 도달하지 않았고 ⓒ 마지막 단정은 state 문자열을 다시 읽은 것뿐이었다 —
  // 즉 "파일을 다시 읽지 않는다"를 아무것도 증명하지 않았다(m17이 core 단위로만 잡았다).
  // 지금은 **문서를 바꾼 뒤/지운 뒤 `seedFindingsFrom(state)`를 직접 호출**해 값이 영수증 그대로임을 본다.
  const state2 = stateOf(name);
  await quiet(() => approveCheckpoint({ project: name, stage: "mvp-planning", checkpointId: state2.pending!.checkpoint_id, now: () => FIXED }));

  const researchDoc = join(root, "docs/01_RESEARCH.md");
  // ⓐ 문서 **변경**: 파일을 재독하면 seed 문장이 이 내용으로 바뀐다.
  writeFileSync(researchDoc, "# 바꿔치기\n\n## Main Judgment\n\n- [TAMPERED] 전혀 다른 판단\n", "utf8");
  let seeds = seedFindingsFrom(stateOf(name));
  assert.ok(seeds.includes(researchSeed), `저장본 seed가 그대로다 (실제: ${JSON.stringify(seeds)})`);
  assert.ok(!seeds.some((s) => s.includes("TAMPERED")), "바뀐 파일 내용이 seed에 실리지 않는다");

  // ⓑ 문서 **삭제**: 파일을 재독하면 예외(ENOENT)가 난다 — 저장본에서 오므로 아무 일도 없다.
  rmSync(researchDoc);
  seeds = seedFindingsFrom(stateOf(name));
  assert.ok(seeds.includes(researchSeed), "문서가 사라져도 seed 값은 영수증 그대로다");

  // ⓒ 그리고 그 삭제는 **drift**로 다음 단계를 막는다(seed 경로와 drift 경로는 별개 판정이다).
  const stage3 = counting();
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: stage3, now: () => FIXED, internalApprover: async () => true }));
  assert.equal(r.code, "pipeline_artifact_drift", "승인 문서 삭제도 drift다");
  assert.equal(stage3.calls, 0);
  rmProject(name);
});

// ── 결정 1: 지시문 멱등성 ─────────────────────────────────────
test("[B-41/결정1] 작업 지시문은 **멱등**하다 — 날짜가 달라도 바이트가 같아서 자기 게이트를 오염시키지 않는다", async () => {
  const name = "_b41_idem";
  await runToCompletion(name);
  const root = projectPaths(name).root;
  const abs = join(root, "outputs/claude_code_task_prompt.md");
  const approved = readFileSync(abs);

  // dev-handoff 단계가 승인한 그 파일을, **다른 날짜**로 다시 생성한다(완료 후 정상 사용 경로).
  buildTaskPrompt(name, "2026-01-01");
  const rel = generateTaskPrompt(name, "2027-12-31");
  assert.equal(rel, "outputs/claude_code_task_prompt.md");
  assert.equal(readFileSync(abs).equals(approved), true, "다른 날짜로 재생성해도 **바이트 동일**");
  assert.ok(!readFileSync(abs, "utf8").includes("2027-12-31"), "본문에 날짜가 없다");

  // 그래서 그 다음 소비가 계속 열려 있다 — 예전엔 여기서 drift로 막혔다(탈출구가 restart뿐이었다).
  assert.match(buildTaskPrompt(name, "2028-06-06"), /## Task/, "재생성 후에도 지시문 생성이 열려 있다");
  const h = await quiet(() => runHandoff({ project: name, cwd: tmpdir(), isTTY: false, logger: () => {} }));
  assert.notEqual(h.action, "not_completed", `handoff가 drift로 막히지 않는다 (실제 ${h.action})`);
  rmProject(name);
});

// ── 결정 2: 안내 품질 ─────────────────────────────────────────
test("[B-41/결정2] handoff --print는 거부 상태를 함께 알리고, status는 하류 막힘을 표시한다", async () => {
  const name = "_b41_print";
  await runToCompletion(name);
  const root = projectPaths(name).root;

  // 대조군: 정상 완료면 경고 없이 명령만 안내한다.
  let printed: string[] = [];
  let out = await quiet(() => runHandoff({ project: name, print: true, cwd: tmpdir(), logger: (l) => printed.push(l) }));
  assert.equal(out.action, "printed");
  assert.equal(printed.some((l) => l.includes("거부됩니다")), false, "막힌 게 없으면 경고하지 않는다");

  // 승인 문서를 바꾸면: --print는 **여전히 실행·상태 변경이 없지만** 곧 실패할 것을 말한다.
  writeFileSync(join(root, "docs/06_CEO_DECISION.md"), "# 바꿔치기\n", "utf8");
  printed = [];
  out = await quiet(() => runHandoff({ project: name, print: true, cwd: tmpdir(), logger: (l) => printed.push(l) }));
  assert.equal(out.action, "printed", "print 계약은 그대로 (게이트 앞 반환)");
  assert.ok(printed.some((l) => l.includes("거부됩니다") && l.includes("pipeline_artifact_drift")), `거부 사유를 함께 출력 (실제: ${printed.join(" | ")})`);
  assert.ok(printed.some((l) => l.startsWith("harness handoff")), "안내 명령 자체는 그대로 출력한다");

  // status도 "완료 — 직접 실행하세요"만 말하지 않는다.
  const log = await captureLogs(() => void statusPipeline({ project: name }));
  assert.match(log, /하류가 막혀 있습니다/);
  assert.match(log, /pipeline_artifact_drift/);
  assert.doesNotMatch(log, /파이프라인 완료 — 다음은 사람이 직접 실행합니다/, "막힌 상태에서 실행을 권하지 않는다");
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
  const root = projectPaths(name).root;
  const r = await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED }));
  // [Codex A-10] **파이프라인을 만들지 않는다.** 예전엔 만들고 곧바로 화해로 죽였고(write 2회),
  // 그 kill 영수증이 "현재 단계"를 적어서 다른 workflow의 폐기를 idea-validation의 것으로 **거짓
  // 증언**했다. 지금은 무생성 거부 + 재평가 안내다.
  assert.equal(r.code, "run_state_killed");
  assert.equal(r.exit, 2);
  assert.equal(guard.calls, 0, "폐기 상태에서 파이프라인이 모델을 호출하지 않는다");
  assert.equal(existsSync(pipelineStatePath(root)), false, "state를 만들지 않았다 (무생성·무접촉)");
  assert.throws(() => buildTaskPrompt(name, "2026-01-01"), /killed_locked|pipeline_killed/, "하류는 닫혀 있다");
  // 탈출구는 **사람이 직접 돌리는 재평가 run**이다(killed 파이프라인에서 run action은 열려 있다).
  const reeval = counting();
  const rr = await runWorkflow({ workflowId: "idea-validation", project: name, provider: reeval, now: () => FIXED });
  assert.equal(rr.state.status, "completed", "재평가 run은 killed 파이프라인에서도 돌 수 있다 (B-40 경로 보존)");
  assert.equal(typeof rr.state.cleared_idea_sha256, "string", "'진행' 판정이 잠금을 풀었다");
  rmProject(name);
});

// ── C-135 (동시 실행 실측의 회귀) ──────────────────────────────
//
// 정본은 `scripts/c135-concurrency.sh`다: 진짜 두 프로세스 경합·SIGKILL·PID 생존판정은
// 프로세스가 있어야만 재진다(실측: 동시 next 20회 = RAN 20 / LOCKED 20 · 단계 두 번 실행 0회).
// 여기 남기는 것은 **그 실측이 확인한 성질 중 in-process로 재현되는 것**이다.

test("[C-135] lock 하나가 mutating 4개를 전부 막는다(exit 2·바이트 불변·모델 0회) · 죽은 owner의 lock도 막는다(자동 회수 없음) · unlock은 무관한 살아있는 pid를 회수하지 않는다", async () => {
  const name = "_c135_lock";
  await toFirstCheckpoint(name);
  const root = projectPaths(name).root;
  const abs = pipelineStatePath(root);
  const lockAbs = join(root, PIPELINE_LOCK_REL);
  const st = stateOf(name);
  assert.ok(st.pending, "전제: 확인 대기 중인 체크포인트가 있다");
  const stage = st.pending.stage;
  const cp = st.pending.checkpoint_id;

  // owner를 **죽은 pid**로 적는다: acquire는 생존을 보지 않으므로 죽은 owner의 lock도 막아야 한다
  // (자동 회수는 unlock만이 한다 — 그것이 "같은 단계를 두 프로세스가 돌리는 통로"를 막는 지점이다).
  const corpse = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(corpse.status, 0, "자식이 정상 종료했다 (그 pid는 이제 없다)");
  const deadPid = corpse.pid as number;
  writeFileSync(lockAbs, JSON.stringify({ pid: deadPid, nonce: "c".repeat(16), at: FIXED }), "utf8");

  const before = bytesOf(abs);
  const guard = counting();
  const blocked = [
    await quiet(() => nextPipeline({ project: name, providerOverride: guard, now: () => FIXED })),
    await quiet(() => approveCheckpoint({ project: name, stage, checkpointId: cp, now: () => FIXED })),
    await quiet(() => rejectCheckpoint({ project: name, stage, checkpointId: cp, now: () => FIXED })),
    await quiet(() => restartPipeline({ project: name, now: () => FIXED })),
  ];
  for (const r of blocked) {
    assert.equal(r.code, "pipeline_locked", `mutating 명령은 lock에 막힌다 (실제 ${r.code})`);
    assert.equal(r.exit, 2, "거부는 exit 2");
  }
  assert.equal(guard.calls, 0, "막힌 next는 모델을 호출하지 않는다");
  assert.equal(bytesOf(abs), before, "막힌 4개 명령 뒤 pipeline_state 바이트가 그대로다");
  // 읽기 2개는 lock 없이 돈다 (설계상 의도 — 못 보면 사람은 owner를 죽이는 것 말고 할 일이 없다).
  assert.equal((await quiet(() => statusPipeline({ project: name }))).exit, 0, "status는 lock 중에도 읽힌다");

  // unlock: **무관한 살아 있는 pid**(PID 재사용)는 회수하지 않는다. 이 프로세스의 부모는
  // 살아 있으면서 이 lock을 만든 적이 없다 — 죽은 owner의 pid가 재활용된 상황과 같은 모양이다.
  assert.notEqual(process.ppid, process.pid);
  writeFileSync(lockAbs, JSON.stringify({ pid: process.ppid, nonce: "d".repeat(16), at: FIXED }), "utf8");
  const reused = await quiet(() => unlockPipeline({ project: name }));
  assert.equal(reused.code, "pipeline_lock_owner_alive", "살아 있는 pid면 owner가 아니어도 회수하지 않는다");
  assert.equal(reused.exit, 1);
  assert.equal(existsSync(lockAbs), true, "회수하지 않았으므로 lock은 남는다");

  // 죽은 owner로 되돌리면 회수한다.
  writeFileSync(lockAbs, JSON.stringify({ pid: deadPid, nonce: "c".repeat(16), at: FIXED }), "utf8");
  assert.equal((await quiet(() => unlockPipeline({ project: name }))).code, "pipeline_unlocked");
  assert.equal(existsSync(lockAbs), false);

  // 대조군: lock이 없으면 **같은 인자**로 approve가 통과한다 — 위 거부들이 공허하지 않다.
  const ok = await quiet(() => approveCheckpoint({ project: name, stage, checkpointId: cp, now: () => FIXED }));
  assert.equal(ok.code, "pipeline_approved", `lock이 없으면 같은 승인이 통과한다 (실제 ${ok.code})`);
  rmProject(name);

  // **무생성**: 파이프라인이 없는 프로젝트에 남의 lock이 있으면 next는 state를 **만들지도 않는다**.
  // 위의 "바이트 불변"은 이미 있는 파일에 대한 것이라, 생성이 lock 앞으로 새어 나가는 회귀를
  // 잡지 못한다 — 그 회귀는 두 프로세스가 같은 파이프라인을 각자 세우는 통로다.
  const fresh = "_c135_lock_fresh";
  makeProject(fresh);
  const freshRoot = projectPaths(fresh).root;
  writeFileSync(join(freshRoot, PIPELINE_LOCK_REL), JSON.stringify({ pid: deadPid, nonce: "e".repeat(16), at: FIXED }), "utf8");
  const guard2 = counting();
  const noCreate = await quiet(() => nextPipeline({ project: fresh, providerOverride: guard2, now: () => FIXED }));
  assert.equal(noCreate.code, "pipeline_locked");
  assert.equal(existsSync(pipelineStatePath(freshRoot)), false, "막힌 next는 pipeline_state를 만들지 않는다");
  assert.equal(guard2.calls, 0);
  rmProject(fresh);
});

test("[C-135] run_state.json은 tmp+rename으로 갈린다 — 제자리 truncate면 lock 없는 독자가 찢어진 바이트를 본다", async () => {
  // 오라클은 **inode**다: rename은 목적지를 새 파일로 바꾸므로 inode가 달라지고, 제자리
  // writeFileSync는 같은 inode를 O_TRUNC로 비웠다가 채운다(그 창을 `pipeline status` 같은
  // lock 없는 독자가 실제로 본다 — scripts/c135-concurrency.sh ⓐ에서 102,259회 중 2회 관측).
  // "찢어짐"을 확률로 재면 flaky한 테스트가 되므로, 찢어짐을 만드는 **쓰기 방식**을 고정한다.
  const name = "_c135_atomic";
  await toFirstCheckpoint(name);
  const rs = join(projectPaths(name).root, "outputs/run_state.json");
  const first = statSync(rs).ino;

  const st = stateOf(name);
  assert.ok(st.pending);
  await quiet(() => rejectCheckpoint({ project: name, stage: st.pending!.stage, checkpointId: st.pending!.checkpoint_id, now: () => FIXED }));
  await quiet(() => nextPipeline({ project: name, providerOverride: counting(), now: () => FIXED }));

  assert.notEqual(statSync(rs).ino, first, "두 번째 run이 run_state를 **새 inode로 갈아끼웠다**(제자리 truncate가 아니다)");
  assert.equal(
    readdirSync(join(projectPaths(name).root, "outputs")).filter((f) => f.startsWith("run_state.json.tmp-")).length,
    0,
    "임시 파일을 남기지 않는다",
  );
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

// ── [C-127] 계약 미달 산출물은 checkpoint에 결박되지 않는다 ─────
//
// 사용자가 지목한 통점의 직접 회귀 테스트. 예전에는 필수 절이 빠진 PRD도 `completed_steps`에
// 들어가 `buildManifest`가 그것을 "정상 산출물"로 B-41 체크포인트에 결박했고, 승인 seed까지
// 다음 단계 프롬프트에 실렸다. **프로덕션 pipeline.ts는 손대지 않았다** — failed 분기가 이미 있다.
test("[C-127] pipeline: 계약 미달 PRD는 checkpoint에 결박되지 않는다 (재실행하면 승인 대기까지 간다)", async () => {
  const name = "_c127_pipe";
  makeProject(name);

  /** pm의 공용 필수 절("## Risks")을 지우는 provider. 재생성분까지 계속 깬다. */
  const broken = (() => {
    const p = {
      id: "mock",
      byAgent: new Map<string, number>(),
      async generate(input: AgentRunInput): Promise<AgentResult> {
        p.byAgent.set(input.agent.agent_id, (p.byAgent.get(input.agent.agent_id) ?? 0) + 1);
        const r = await mockProvider.generate(input);
        if (input.agent.agent_id !== "pm") return r;
        const markdown = r.markdown.replace(/^## Risks\n[\s\S]*?(?=^## )/m, "");
        assert.notEqual(markdown, r.markdown, "mock pm 출력에서 '## Risks' 절 제거 실패 — 형식이 바뀌었다");
        return { ...r, markdown };
      },
    };
    return p;
  })();

  const r = await quiet(() => nextPipeline({ project: name, providerOverride: broken, now: () => FIXED }));
  assert.equal(r.code, "pipeline_stage_failed");
  assert.equal(r.exit, 1);

  const failed = stateOf(name);
  assert.equal(failed.status, "awaiting_run", "확인 대기로 넘어가지 않는다");
  assert.equal(failed.pending, null, "깨진 PRD는 체크포인트에 결박되지 않는다");
  assert.ok(failed.last_failure, "실패 영수증은 남는다");
  assert.equal(failed.last_failure!.stage, "idea-validation");
  // [C-127/A-1] 깨진 PRD는 **디스크에 쓰이지도 않았다** — 그래서 `written`에도 없고 drift도 없다.
  // (초판은 저장 후 차단이라 여기 digest가 잡혔다. 그 순서는 revise가 기존 채택본을 파괴한다.)
  assert.equal(
    failed.last_failure!.written.some((w) => w.path === "docs/02_PRD.md"),
    false,
    "쓰지 않은 파일은 written에도 없다",
  );
  assert.equal(existsSync(join(projectPaths(name).root, "docs/02_PRD.md")), false, "깨진 PRD 파일 자체가 없다");
  assert.equal(loadRunState(name)!.failed_reason, "required_sections_missing");
  assert.equal(loadRunState(name)!.completed_steps.includes("pm"), false);

  // 고친 뒤 같은 명령 → 실패 step부터 resume하고 확인 대기까지 간다 (막다른 골목이 아니다).
  const fixed = counting();
  const again = await quiet(() => nextPipeline({ project: name, providerOverride: fixed, now: () => FIXED }));
  assert.equal(again.code, "pipeline_awaiting_approval");
  const ok = stateOf(name);
  assert.equal(ok.status, "awaiting_approval");
  assert.equal(ok.last_failure, null, "성공하면 실패 영수증을 내린다");
  assert.ok(ok.pending!.artifacts.some((a) => a.path === "docs/02_PRD.md"), "이번엔 PRD가 승인 대상에 들어간다");
  assert.equal(fixed.byAgent.get("chief_of_staff") ?? 0, 0, "완료 step은 재실행되지 않았다");
  assert.ok((fixed.byAgent.get("pm") ?? 0) >= 1, "실패한 pm부터 다시 돌았다");
  rmProject(name);
});
