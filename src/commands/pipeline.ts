/**
 * [B-41] `harness pipeline` — 단계 체크포인트 오케스트레이션의 6개 명령.
 *
 * `status` / `next` / `approve` / `reject` / `restart` / `unlock`.
 *
 * ## 전이 precedence (모든 mutating 명령이 이 순서를 지킨다)
 *
 * ① pipeline_state 읽기+검증(unreadable → exit 2 · **무접촉**) → ② `pipeline.lock` O_EXCL 획득
 * (실패 → exit 2 · 무접촉) → ③ pipeline 상태로 사건 허용 판정 → ④ 필요 시 run_state
 * (**killed 화해 먼저**) → ⑤ 원자 쓰기 1회 → ⑥ lock 해제(finally).
 *
 * `status`와 `unlock`은 **lock 없이** 동작한다: 진행 중 owner의 상태를 못 보면 사람은 owner를 죽이는
 * 것 말고 할 수 있는 일이 없고, 죽은 owner의 lock을 회수하는 명령이 그 lock을 기다리는 것은 교착이다.
 *
 * ## 체크포인트용 `--yes`/`--force`가 없는 이유
 *
 * 이 기능의 존재 이유다. `--yes-internal-gates`는 **workflow 내부** approval step(디자인 게이트 등)만
 * 자동 승인하며, **checkpoint 전이 함수에는 approver·boolean 인자가 아예 없다** — 그래서 그 플래그가
 * 체크포인트에 닿으려면 시그니처를 바꿔야 하고, 컴파일이 월경을 먼저 막는다(의도).
 */
import { closeSync, existsSync, openSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PIPELINE,
  PIPELINE_ID,
  PIPELINE_LOCK_REL,
  PIPELINE_STATE_REL,
  lockPipeline,
  approvedDigests,
  buildManifest,
  checkpointIdFor,
  currentStage,
  digestArtifacts,
  driftProblem,
  effectiveDigests,
  newPipelineState,
  pipelineGateStatus,
  pipelineStatePath,
  pipelineWorkflowProblem,
  readLock,
  readPipelineStateAt,
  runStateSources,
  seedFindingsFrom,
  writePipelineState,
  PipelineError,
  type ArtifactEntry,
  type PipelineCheckpoint,
  type PipelinePending,
  type LockedPipeline,
  type PipelineStage,
  type PipelineState,
  type PipelineStateRead,
} from "../core/pipeline.js";
import { projectExists, projectPaths } from "../core/project.js";
import { findWorkflow, hasKillGate, loadWorkflows } from "../core/registry.js";
import {
  ideaGateStatus,
  readRunStateAt,
  readRunState,
  runWorkflow,
  snapshotProjectIdea,
  type RunState,
} from "../core/runWorkflow.js";
import { generateTaskPrompt } from "../core/taskPrompt.js";
import { exportToVault } from "../core/obsidianExport.js";
import { DEFAULT_PROVIDER_ID, getProvider } from "../providers/index.js";
import type { Provider } from "../providers/provider.js";
import type { ProgressReporter } from "../core/progress.js";

/** 명령 결과. exit은 CLI 종료 코드이고 code는 테스트·로그가 읽는 안정 사유다. */
export interface PipelineCommandResult {
  code: string;
  exit: 0 | 1 | 2;
}

const RUN_STATE_REL = "outputs/run_state.json";

function done(code: string, exit: 0 | 1 | 2): PipelineCommandResult {
  if (exit !== 0) process.exitCode = exit;
  return { code, exit };
}

/** 거부는 stderr로, 진행은 stdout으로 — 거부 메시지는 **게이트가 만든 문장을 그대로** 낸다. */
function reject(code: string, message: string, exit: 1 | 2): PipelineCommandResult {
  console.error(`⛔ ${message}`);
  return done(code, exit);
}

function stageLabel(state: PipelineState): string {
  const st = currentStage(state);
  return st ? `${state.current_index + 1}/${DEFAULT_PIPELINE.length} '${st.id}'` : `${DEFAULT_PIPELINE.length}/${DEFAULT_PIPELINE.length} (완료)`;
}

/** dev 단계 이후 사람이 직접 치는 명령을 **인쇄만** 한다 — spawn하지 않는다(자동 통로를 만들지 않는다). */
function printCompletedGuidance(project: string): void {
  console.log("");
  console.log("파이프라인 완료 — 다음은 사람이 직접 실행합니다 (하네스가 자동으로 넘기지 않습니다):");
  console.log(`  harness task-prompt --project ${project}`);
  console.log(`  harness handoff --project ${project} --cwd <serviceRepo>`);
}

/**
 * killed 화해 — run_state가 폐기 판정이면 파이프라인도 terminal killed로 내린다.
 * **재실행·재평가를 시도하지 않는다**: 재평가는 사람이 `harness run <kill 게이트 workflow>`로 직접
 * 돌리는 B-40 경로이고, 그 판정이 '진행'이면 잠금이 풀린 뒤 `pipeline restart`로 다시 세운다.
 *
 * kill 영수증의 artifacts는 **있는 파일만** 담는다(`skipMissing`): 폐기 기록을 남기는 것이 파일 존재
 * 여부보다 중요하고, 이 영수증으로는 아무 소비자도 열리지 않는다(§3.3의 빈 배열 예외가 여기 하나다).
 */
function reconcileKilled(projectRoot: string, state: PipelineState, stage: PipelineStage, rs: RunState, at: string): PipelineState {
  const { artifacts, seeds } = buildManifest(projectRoot, runStateSources(rs), { skipMissing: true });
  const base = {
    stage: stage.id,
    workflow_id: stage.kind === "workflow" ? stage.workflowId : null,
    run_finished_at: rs.finished_at ?? null,
    artifacts,
    seeds,
  };
  const receipt: PipelineCheckpoint = {
    ...base,
    checkpoint_id: checkpointIdFor(base),
    decision: "killed",
    decided_at: at,
    note: `${rs.killed_by?.decider ?? "(게이트)"}가 '${rs.killed_by?.decision ?? "폐기"}' 판정`,
  };
  return { ...state, status: "killed", pending: null, last_failure: null, checkpoints: [...state.checkpoints, receipt], updated_at: at };
}

// ── status (lock 불요 · read-only) ──────────────────────────────

export function statusPipeline(o: { project: string }): PipelineCommandResult {
  const root = projectPaths(o.project).root;
  const read = readPipelineStateAt(pipelineStatePath(root));
  const lock = readLock(root);
  if (read.kind === "unreadable") {
    // 게이트가 만든 같은 문장을 쓴다 (같은 상황 = 같은 안내).
    const gate = pipelineGateStatus(read, root, "run");
    return reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2);
  }
  if (lock) {
    console.log(`lock: pid ${lock.pid} 보유 (획득 ${lock.at}) — mutating 명령은 거부됩니다 (status는 읽힙니다)`);
  }
  if (read.kind === "absent") {
    console.log(`파이프라인 없음 (${o.project}) — 'harness pipeline next --project ${o.project}'로 시작하세요.`);
    console.log(`단계: ${DEFAULT_PIPELINE.map((s) => s.id).join(" → ")}`);
    return done("pipeline_absent", 0);
  }
  const st = read.state;
  console.log(`파이프라인 ${PIPELINE_ID} · 프로젝트 ${st.project} · 상태 ${st.status} · 단계 ${stageLabel(st)}`);
  for (const [i, stage] of DEFAULT_PIPELINE.entries()) {
    const last = [...st.checkpoints].reverse().find((c) => c.stage === stage.id);
    const mark = i < st.current_index ? "✔" : i === st.current_index ? "▶" : "·";
    const note = last ? ` (마지막 판정: ${last.decision} @ ${last.decided_at})` : "";
    console.log(`  ${mark} ${stage.id}${note}`);
  }
  if (st.status === "awaiting_approval" && st.pending) {
    console.log("");
    console.log(`확인 대기: '${st.pending.stage}' · checkpoint ${st.pending.checkpoint_id}`);
    for (const a of st.pending.artifacts) console.log(`  - ${a.path} (${a.size}B · ${a.sha256.slice(0, 12)}…)`);
    console.log(`승인: harness pipeline approve ${st.pending.stage} --checkpoint ${st.pending.checkpoint_id} --project ${st.project}`);
    console.log(`되돌림: harness pipeline reject ${st.pending.stage} --checkpoint ${st.pending.checkpoint_id} --project ${st.project} [--note <이유>]`);
  } else if (st.status === "awaiting_run") {
    if (st.last_failure) {
      console.log(`직전 실패: '${st.last_failure.stage}' @ ${st.last_failure.at} (덮인 파일 ${st.last_failure.written.length}개) — next가 자동 resume합니다`);
    }
    console.log(`다음: harness pipeline next --project ${st.project}`);
  } else if (st.status === "killed") {
    console.log("");
    console.log("폐기 판정으로 종료된 파이프라인입니다 — 지시문·DAG·handoff는 만들지 않습니다.");
    console.log(`재평가: harness run <kill 게이트 workflow> --project ${st.project} (게이트가 '진행'을 내면 잠금이 풀립니다)`);
    console.log(`다시 세우기: harness pipeline restart --project ${st.project} (기존 state는 지우지 않고 rename 보관)`);
  } else {
    // [B-41/결정 2] 완료 상태에서도 **하류가 막혀 있으면 그 사실을 먼저 말한다.** 예전 status는
    // drift가 있어도 "완료 — 직접 실행하세요"만 출력했다(오케스트레이터 스모크에서 실측).
    const gate = pipelineGateStatus(read, root, "handoff");
    if (!gate.ok) {
      console.log("");
      console.log(`⚠ 하류가 막혀 있습니다 — ${gate.message}`);
    } else {
      printCompletedGuidance(st.project);
    }
  }
  // [표시 전용] 화해되지 않은 killed run도 사실대로 적는다 — **여기서 아무것도 쓰지 않는다**(status는 read-only).
  if (st.status !== "killed") {
    const rs = readRunStateAt(join(root, RUN_STATE_REL));
    if (rs.kind === "ok" && rs.state.status === "killed") {
      console.log("");
      console.log("주의: run_state가 폐기(killed) 판정입니다 — 다음 'pipeline next'에서 파이프라인이 killed로 화해됩니다 (지금 아무것도 쓰지 않았습니다).");
    }
  }
  return done("pipeline_status", 0);
}

// ── next ────────────────────────────────────────────────────────

export interface NextPipelineOptions {
  project: string;
  provider?: string;
  maxTokens?: number;
  vault?: string;
  /**
   * workflow **내부** approval step의 응답자. 체크포인트와는 무관하다 —
   * 이 인자는 `runWorkflow.approve`로만 흐르고 checkpoint 전이 함수에는 존재하지 않는다.
   */
  internalApprover?: (message: string, show?: string) => Promise<boolean>;
  reporter?: ProgressReporter;
  // ── test seams (CLI 미노출) ──
  now?: () => string;
  providerOverride?: Provider;
}

export async function nextPipeline(o: NextPipelineOptions): Promise<PipelineCommandResult> {
  const now = o.now ?? (() => new Date().toISOString());
  const project = o.project;
  const root = projectPaths(project).root;
  if (!projectExists(project)) {
    return reject("project_missing", `프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`, 1);
  }

  // ① 읽기 + 검증 (무접촉)
  const read = readPipelineStateAt(pipelineStatePath(root));
  if (read.kind === "unreadable") {
    // 거부 문장은 공용 게이트가 만든 것을 그대로 쓴다 (같은 상황 = 같은 안내).
    const gate = pipelineGateStatus(read, root, "run");
    return reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2);
  }
  // 파이프라인이 가리키는 workflow가 registry에 실제로 있는지 — 첫 모델 호출·state 생성 전에 본다.
  const wfProblem = pipelineWorkflowProblem(loadWorkflows().map((w) => w.workflow_id));
  if (wfProblem) return reject("pipeline_stage_workflow_missing", wfProblem, 2);

  // ② lock (mutating). [A-3] nonce는 이 경계 밖으로 나가지 않는다 — lease는 locked.runStage가 발행한다.
  const lock = lockPipeline(root, now);
  if (!lock.ok) return reject("pipeline_locked", lock.message, 2);
  const locked = lock.locked;
  try {
    // [Codex A-7] lock 획득 **직후 재독·재검증**한 snapshot만 mutation에 쓴다(lockPipeline이 그 read를
    // 들고 온다). ①의 read는 lock 밖에서 찍힌 것이라, 그 사이 다른 프로세스가 전이를 끝냈으면
    // stale snapshot으로 덮어쓴다(승인 하나가 조용히 사라지는 부류다).
    if (locked.read.kind === "unreadable") {
      const gate = pipelineGateStatus(locked.read, root, "run");
      return reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2);
    }
    return await nextLocked(o, { project, root, now, read: locked.read, locked });
  } finally {
    locked.release();
  }
}

async function nextLocked(
  o: NextPipelineOptions,
  // read는 nextPipeline이 unreadable을 이미 걸러낸 뒤의 것이다 (타입으로 그 사실을 들고 온다).
  ctx: { project: string; root: string; now: () => string; read: Exclude<PipelineStateRead, { kind: "unreadable" }>; locked: LockedPipeline },
): Promise<PipelineCommandResult> {
  const { project, root, now, locked } = ctx;
  let state: PipelineState;

  if (ctx.read.kind === "absent") {
    // 파이프라인 시작 전에 **폐기 잠금**(B-40)을 본다: 죽은 아이디어로 파이프라인을 세우지 않는다.
    // 거부면 **아무것도 만들지 않는다**(무생성·무접촉).
    const first = DEFAULT_PIPELINE[0];
    const wf = first.kind === "workflow" ? findWorkflow(loadWorkflows(), first.workflowId) : undefined;
    const ideaGate = ideaGateStatus(readRunState(project), snapshotProjectIdea(project), wf ? hasKillGate(wf) : false);
    if (!ideaGate.ok) return reject(ideaGate.code, ideaGate.message, 2);
    // [Codex A-10] run_state가 이미 폐기 판정이면 **파이프라인을 만들지 않는다.**
    // 예전엔 만들고 나서 곧바로 화해로 죽였고(write 2회), 더 나쁘게 그 kill 영수증은 "현재 단계"를
    // 적어서 **거짓말**을 했다: 파이프라인 밖에서 mvp-planning이 폐기됐는데 영수증은
    // "idea-validation이 폐기됐다"고 증언했다. 폐기를 푸는 것은 사람이 직접 돌리는 재평가 run이므로
    // 여기서 만들 것이 없다.
    const rsBefore = readRunStateAt(join(root, RUN_STATE_REL));
    if (rsBefore.kind === "ok" && rsBefore.state.status === "killed") {
      const k = rsBefore.state.killed_by;
      return reject(
        "run_state_killed",
        `이 프로젝트의 마지막 run이 폐기 판정입니다 (workflow '${rsBefore.state.workflow_id}' · ` +
          `${k?.decider ?? "게이트"}가 '${k?.decision ?? "폐기"}') — 파이프라인을 만들지 않았습니다.\n` +
          `먼저 재평가를 직접 돌려 '진행' 판정을 받으세요: harness run <kill 게이트 workflow> --project ${project}`,
        2,
      );
    }
    state = newPipelineState(project, now());
    writePipelineState(root, state); // 전이: 파이프라인 생성 (원자 쓰기 1회)
    console.log(`파이프라인 시작: ${PIPELINE_ID} · ${DEFAULT_PIPELINE.map((s) => s.id).join(" → ")}`);
  } else {
    state = ctx.read.state;
  }

  // ③ 사건 허용 판정
  if (state.status === "killed") {
    return reject(
      "pipeline_killed",
      `이 파이프라인은 폐기 판정으로 종료됐습니다 — next로 전진하지 않습니다.\n` +
        `재평가: harness run <kill 게이트 workflow> --project ${project} · 다시 세우기: harness pipeline restart --project ${project}`,
      1,
    );
  }
  if (state.status === "completed") {
    console.log(`파이프라인이 이미 완료됐습니다 (${DEFAULT_PIPELINE.length}단계 전부 승인) — 전진할 것이 없습니다.`);
    printCompletedGuidance(project);
    return done("pipeline_completed", 0);
  }
  if (state.status === "awaiting_approval" && state.pending) {
    // **전진 없음**: 확인 대기 중의 next는 안내를 다시 낸다(승인을 대신하지 않는다).
    console.log(`'${state.pending.stage}' 단계 산출물이 확인 대기 중입니다 — 전진하지 않았습니다.`);
    for (const a of state.pending.artifacts) console.log(`  - ${a.path} (${a.size}B · ${a.sha256.slice(0, 12)}…)`);
    console.log(`승인: harness pipeline approve ${state.pending.stage} --checkpoint ${state.pending.checkpoint_id} --project ${project}`);
    console.log(`되돌림: harness pipeline reject ${state.pending.stage} --checkpoint ${state.pending.checkpoint_id} --project ${project} [--note <이유>]`);
    return done("pipeline_checkpoint_pending", 0);
  }

  const stage = currentStage(state);
  if (!stage) return reject("pipeline_stage_out_of_range", `current_index가 단계 범위를 벗어났습니다 (${state.current_index})`, 2);

  // ④ run_state 첫 접점 — killed 화해가 **먼저**다.
  const rsRead = readRunStateAt(join(root, RUN_STATE_REL));
  if (rsRead.kind === "unreadable") {
    return reject(
      "run_state_unreadable",
      `run_state.json이 있지만 읽을 수 없습니다: ${rsRead.path} (${rsRead.detail}).\n폐기 기록이 이 파일에 있을 수 있어 덮어쓰지 않습니다 — 파일을 복원하거나 검토 후 지우세요.`,
      2,
    );
  }
  if (rsRead.kind === "ok" && rsRead.state.status === "killed") {
    // [Codex A-10] **provenance 대조**: 그 폐기가 **이 단계의 workflow**에서 나온 것일 때만
    // 현 단계 영수증으로 기록한다. 다른 workflow가 죽은 것을 현 단계 이름으로 적으면 영수증이
    // 거짓말을 한다(그리고 그 거짓 영수증이 checkpoint 이력의 정본이 된다).
    const rsWf = rsRead.state.workflow_id;
    if (stage.kind !== "workflow" || rsWf !== stage.workflowId) {
      return reject(
        "pipeline_killed_elsewhere",
        `run_state가 폐기 판정인데 그 workflow('${rsWf}')는 현 단계('${stage.id}')가 아닙니다 — ` +
          `현 단계 영수증으로 적으면 거짓 기록이 되므로 아무것도 쓰지 않았습니다.\n` +
          `재평가를 직접 돌려 '진행' 판정을 받은 뒤(harness run <kill 게이트 workflow> --project ${project}) 다시 시도하거나, ` +
          `'harness pipeline restart --project ${project}'로 파이프라인을 다시 세우세요.`,
        1,
      );
    }
    const next = reconcileKilled(root, state, stage, rsRead.state, now());
    writePipelineState(root, next);
    console.log(`⛔ 폐기 판정을 파이프라인에 반영했습니다 (killed) — ${next.checkpoints.at(-1)?.note}. 후속 단계는 실행하지 않았습니다.`);
    console.log(`재평가는 사람이 직접: harness run <kill 게이트 workflow> --project ${project}`);
    return done("pipeline_killed_reconciled", 0);
  }

  // resume 판정 — 영수증(`last_failure`)이 있을 때만이다. 없으면 fresh로 강하한다(§4.3).
  const rs = rsRead.kind === "ok" ? rsRead.state : null;
  const resume =
    stage.kind === "workflow" &&
    rs !== null &&
    rs.status === "failed" &&
    rs.workflow_id === stage.workflowId &&
    state.last_failure !== null &&
    state.last_failure.stage === stage.id;

  // 승인 바이트 사전 검증. **fresh는 예외 없는 전수 검증**이고, resume만 `last_failure.written`
  // digest와 일치하는 경로에 예외를 준다(그 attempt가 정당하게 덮은 것). 어느 쪽도 아니면 손댄 것이다.
  const written = new Map((resume && state.last_failure ? state.last_failure.written : []).map((w) => [w.path, w]));
  for (const approved of approvedDigests(state).values()) {
    const accept: ArtifactEntry[] = [approved];
    const w = written.get(approved.path);
    if (w) accept.push(w);
    if (!accept.some((a) => driftProblem(root, [a]) === null)) {
      return reject(
        "pipeline_artifact_drift",
        `승인된 산출물이 승인 시점 바이트와 다릅니다: ${approved.path}\n` +
          `사람이 확인한 내용이 아니므로 **모델을 호출하지 않고** 멈춥니다 — 파일을 복원하거나 ` +
          `'harness pipeline restart --project ${project}'로 다시 심사하세요.`,
        1,
      );
    }
  }

  // ── dev-handoff: workflow가 아니라 지시문 생성 단계 ──
  //
  // **알려진 한계(구현 중 실측으로 발견 — 다음 사람이 닫힌 것으로 믿지 않게 적는다):**
  // 이 단계의 승인 대상은 `outputs/claude_code_task_prompt.md`인데, 완료 후 `harness task-prompt`나
  // `harness handoff`가 **같은 파일을 다시 생성한다**(본문에 생성 날짜가 박힌다). 그래서 승인한 날과
  // 다른 날에 그 명령을 돌리면 파일 바이트가 바뀌어, 그 다음 `task-prompt`/`handoff`/`plan-dag`가
  // `pipeline_artifact_drift`로 거부된다. 탈출구는 `pipeline restart`(전 단계 재실행)뿐이다.
  // 방향은 fail closed이므로 안전 결함은 아니지만 **사용성 결함이고 아직 닫히지 않았다**.
  // 여기서 재작성 경로를 검증에서 빼는 것은 설계 §9-6이 명시적으로 기각한 방향이라(공유 산출 경로
  // 바꿔치기 사각) 임의로 도입하지 않았다 — 결정이 필요한 항목으로 보고했다.
  if (stage.kind === "task_prompt") {
    let rel: string;
    try {
      rel = generateTaskPrompt(project, now().slice(0, 10));
    } catch (err) {
      return reject("pipeline_task_prompt_failed", `지시문 생성 실패 — 파이프라인 상태는 그대로입니다: ${(err as Error).message}`, 1);
    }
    // seeds는 담지 않는다: 작업 지시문은 판단 문서가 아니고(Main Judgment 절이 없다) 뒤 단계도 없다.
    const base = { stage: stage.id, workflow_id: null, run_finished_at: now(), artifacts: digestArtifacts(root, [rel]), seeds: [] };
    return commitPending(root, state, base, now(), project);
  }

  // ── workflow 단계 ──
  const provider = o.providerOverride ?? getProvider(o.provider ?? DEFAULT_PROVIDER_ID);
  const seeds = seedFindingsFrom(state);
  console.log(
    `단계 실행: ${stageLabel(state)} · workflow '${stage.workflowId}' · provider ${provider.id}` +
      `${resume ? " · resume" : ""}${seeds.length ? ` · 승인 판단 seed ${seeds.length}건` : ""}`,
  );
  let result: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    // [Codex A-3] 실행은 **lock을 쥔 연산의 runStage 안에서만** 일어난다: lease는 그 호출 동안만
    // 발행되고(현 단계 workflow + awaiting_run일 때만) 끝나면 만료된다. 임의 호출자가 nonce를
    // 읽어 lease를 만들 길이 없다 — 그것이 예전 판의 구멍이었다.
    result = await locked.runStage(stage.workflowId, (lease) =>
      runWorkflow({
        workflowId: stage.workflowId,
        project,
        provider,
        resume,
        maxTokens: o.maxTokens ?? 0,
        approve: o.internalApprover,
        reporter: o.reporter,
        now: o.now,
        // seed는 **durable 저장본**에서만 온다 — 여기서 문서 파일을 다시 읽지 않는다(§5).
        seedFindings: seeds.length > 0 ? seeds : undefined,
        pipelineLease: lease,
      }),
    );
  } catch (err) {
    // run_state가 만들어지지 않는 경로(잠금·approver 부재·profile 거부 등) — 파이프라인 상태 불변.
    return reject("pipeline_run_not_started", `단계 '${stage.id}' 실행이 시작되지 않았습니다 (파이프라인 상태 불변): ${(err as Error).message}`, 1);
  }

  // [Codex A-5] vault export는 **아래 전이(pending/killed/failed 기록)가 끝난 뒤**에 한다:
  // 여기서 내보내면 "run completed"만 적힌 노트가 나오고, 그 시점에 파이프라인은 아직 확인 대기
  // 기록을 갖지 못한다 → vault만 보는 사람에게 거짓 완료 영수증이다. try/finally로 모든 종료
  // 경로(정상·거부)에서 한 번만 내보낸다.
  try {
    if (result.state.status === "killed") {
      const next = reconcileKilled(root, state, stage, result.state, now());
      writePipelineState(root, next);
      console.log(`⛔ 폐기 판정 — 파이프라인 종료(killed): ${next.checkpoints.at(-1)?.note}. 후속 단계는 실행하지 않았습니다.`);
      return done("pipeline_killed_reconciled", 0);
    }
    return commitAfterRun(o, { project, root, now, state, stage, result });
  } finally {
    exportVault(o, root, result.state);
  }
}

/** run 결과를 파이프라인 상태에 반영한다 (failed → last_failure · completed → pending). */
function commitAfterRun(
  o: NextPipelineOptions,
  ctx: {
    project: string;
    root: string;
    now: () => string;
    state: PipelineState;
    stage: Extract<PipelineStage, { kind: "workflow" }>;
    result: Awaited<ReturnType<typeof runWorkflow>>;
  },
): PipelineCommandResult {
  const { project, root, now, state, stage, result } = ctx;
  if (result.state.status === "failed") {
    // 실패 attempt가 **정당하게 덮은** 파일의 digest를 영수증에 남긴다 — resume의 예외는 이것에만 결박된다.
    const at = now();
    const next: PipelineState = {
      ...state,
      last_failure: {
        stage: stage.id,
        workflow_id: stage.workflowId,
        at,
        written: digestArtifacts(root, result.savedFiles, { skipMissing: true }),
      },
      updated_at: at,
    };
    writePipelineState(root, next);
    console.error(
      `단계 '${stage.id}' 실행이 중단됐습니다 (${result.state.failed_reason ?? "사유 미기록"}) — 상태는 실행 대기(awaiting_run) 그대로입니다.\n` +
        `고친 뒤 다시: harness pipeline next --project ${project} (같은 workflow를 resume합니다)`,
    );
    return done("pipeline_stage_failed", 1);
  }

  // completed → manifest·seed 재구성 (**같은 read**에서 digest와 seed를 함께 뽑는다)
  let manifest: { artifacts: ArtifactEntry[]; seeds: PipelinePending["seeds"] };
  try {
    manifest = buildManifest(root, runStateSources(result.state));
  } catch (err) {
    const code = err instanceof PipelineError ? err.code : "pipeline_manifest_failed";
    return reject(code, `영수증을 만들 수 없어 확인 대기로 넘기지 않았습니다: ${(err as Error).message}`, 1);
  }
  const base = {
    stage: stage.id,
    workflow_id: stage.workflowId,
    run_finished_at: result.state.finished_at,
    artifacts: manifest.artifacts,
    seeds: manifest.seeds,
  };
  return commitPending(root, state, base, now(), project);
}

/**
 * [Codex A-5] Obsidian export — **파이프라인 사실을 명시 인자로 넘긴다**(방금 쓴 durable state에서
 * 읽는다). vault가 파이프라인 상태를 추측하지 않고, "확인 대기"가 "완료"로 적히지 않는다.
 */
function exportVault(o: NextPipelineOptions, root: string, runState: RunState): void {
  const vaultPath = o.vault ?? process.env.HARNESS_VAULT;
  if (!vaultPath || !vaultPath.trim()) return;
  const read = readPipelineStateAt(pipelineStatePath(root));
  // **손상(`unreadable`)을 부재(`absent`)로 접지 않는다**(Codex 검증 신규 A): 둘 다 `null`로 접으면
  // vault 노트에 run의 `상태: completed`만 남아 **외부 vault에 거짓 완료 영수증**이 생긴다. 이 export는
  // 파이프라인 경로에서만 불리므로 state는 있어야 정상이고, 읽히지 않는다는 것 자체가 적어야 할 사실이다.
  // (`absent`는 파이프라인 밖 run이 아니라 — 그 경로는 이 함수를 부르지 않는다 — 방금 쓴 state가 사라진
  //  경우이므로 그것도 사실로 남긴다.)
  const st = read.kind === "ok" ? read.state : null;
  const pipelineNote =
    st !== null
      ? {
          stage: currentStage(st)?.id ?? "(완료)",
          index: Math.min(st.current_index + 1, DEFAULT_PIPELINE.length),
          total: DEFAULT_PIPELINE.length,
          status: st.status,
          checkpointId: st.pending?.checkpoint_id ?? null,
        }
      : {
          stage: "(파이프라인 상태를 읽을 수 없다)",
          index: 0,
          total: DEFAULT_PIPELINE.length,
          status: read.kind === "unreadable" ? "unreadable — 확인 대기 여부를 알 수 없다" : "absent — 상태 파일이 사라졌다",
          checkpointId: null,
        };
  try {
    const ex = exportToVault({
      vault: vaultPath.trim(),
      state: runState,
      pipeline: pipelineNote,
    });
    console.log(`Obsidian: ${ex.notesWritten}개 노트 → ${ex.folder}`);
  } catch (err) {
    console.warn(`Obsidian export 실패 (실행 결과는 저장됨): ${(err as Error).message}`);
  }
}

/** pending 기록 + awaiting_approval 전이 (원자 쓰기 1회). `last_failure`는 성공 시 null로 내린다. */
function commitPending(
  root: string,
  state: PipelineState,
  base: Omit<PipelinePending, "checkpoint_id">,
  at: string,
  project: string,
): PipelineCommandResult {
  const pending: PipelinePending = { ...base, checkpoint_id: checkpointIdFor(base) };
  writePipelineState(root, { ...state, status: "awaiting_approval", pending, last_failure: null, updated_at: at });
  console.log("");
  console.log(`✅ '${pending.stage}' 단계 완료 — **확인 대기**로 들어갑니다 (다음 단계는 승인 후에 돕니다).`);
  console.log(`checkpoint: ${pending.checkpoint_id}`);
  for (const a of pending.artifacts) console.log(`  - ${a.path} (${a.size}B · ${a.sha256.slice(0, 12)}…)`);
  console.log("문서를 확인한 뒤:");
  console.log(`  승인   harness pipeline approve ${pending.stage} --checkpoint ${pending.checkpoint_id} --project ${project}`);
  console.log(`  되돌림 harness pipeline reject ${pending.stage} --checkpoint ${pending.checkpoint_id} --project ${project} --note "<이유>"`);
  return done("pipeline_awaiting_approval", 0);
}

// ── approve / reject 공통 preamble ──────────────────────────────

type Decided =
  | { ok: false; res: PipelineCommandResult }
  | { ok: true; root: string; state: PipelineState; pending: PipelinePending; stage: PipelineStage; release: () => void };

/**
 * 신원 결박: **stage(의도) + checkpoint_id(바이트 신원)** 가 모두 pending과 일치해야 한다.
 * 하나만 받으면 "다른 단계를 승인" 또는 "바뀐 바이트를 옛 승인으로 통과"가 열린다.
 * 이중 approve는 pending이 이미 null이라 여기서 거부된다(멱등).
 */
function openDecision(o: { project: string; stage: string; checkpointId: string }, verb: string, now: () => string): Decided {
  const root = projectPaths(o.project).root;
  const read = readPipelineStateAt(pipelineStatePath(root));
  if (read.kind === "unreadable") {
    const gate = pipelineGateStatus(read, root, "run");
    return { ok: false, res: reject("pipeline_state_unreadable", gate.ok ? "" : gate.message, 2) };
  }
  if (read.kind === "absent") {
    return { ok: false, res: reject("pipeline_absent", `파이프라인이 없습니다 (${o.project}) — 'harness pipeline next'로 시작하세요.`, 1) };
  }
  const lock = lockPipeline(root, now);
  if (!lock.ok) return { ok: false, res: reject("pipeline_locked", lock.message, 2) };
  const locked = lock.locked;
  const fail = (code: string, message: string, exit: 1 | 2): Decided => {
    locked.release();
    return { ok: false, res: reject(code, message, exit) };
  };
  // [Codex A-7] lock 밖 snapshot으로 판정하면 그 사이 끝난 전이를 덮어쓴다 — 재독·재검증한 것만 쓴다.
  const fresh = locked.read;
  if (fresh.kind !== "ok") {
    const gate = pipelineGateStatus(fresh, root, "run");
    return fail(fresh.kind === "absent" ? "pipeline_absent" : "pipeline_state_unreadable", gate.ok ? "파이프라인이 사라졌습니다" : gate.message, 2);
  }
  const state = fresh.state;
  if (state.status === "killed") {
    return fail("pipeline_killed", `폐기 판정으로 종료된 파이프라인입니다 — ${verb}할 체크포인트가 없습니다.`, 1);
  }
  if (state.status === "completed") {
    return fail("pipeline_completed", `파이프라인이 이미 완료됐습니다 — ${verb}할 체크포인트가 없습니다.`, 1);
  }
  if (state.status !== "awaiting_approval" || !state.pending) {
    return fail(
      "pipeline_no_pending",
      `확인할 산출물이 없습니다 (상태 ${state.status} · 단계 ${stageLabel(state)}) — 먼저 'harness pipeline next --project ${o.project}'로 단계를 실행하세요.`,
      1,
    );
  }
  const pending = state.pending;
  if (pending.stage !== o.stage) {
    return fail("pipeline_stage_mismatch", `확인 대기 중인 단계는 '${pending.stage}'입니다 (요청 '${o.stage}') — 상태를 바꾸지 않았습니다.`, 1);
  }
  if (pending.checkpoint_id !== o.checkpointId) {
    return fail(
      "pipeline_checkpoint_mismatch",
      `checkpoint id가 다릅니다 (대기 ${pending.checkpoint_id} · 요청 ${o.checkpointId}) — 상태를 바꾸지 않았습니다.\n` +
        `'harness pipeline status --project ${o.project}'로 현재 id를 확인하세요.`,
      1,
    );
  }
  const stage = currentStage(state);
  if (!stage) return fail("pipeline_stage_out_of_range", `current_index가 단계 범위를 벗어났습니다 (${state.current_index})`, 2);
  return { ok: true, root, state, pending, stage, release: locked.release };
}

// ── approve ─────────────────────────────────────────────────────

export function approveCheckpoint(o: { project: string; stage: string; checkpointId: string; now?: () => string }): PipelineCommandResult {
  const now = o.now ?? (() => new Date().toISOString());
  const opened = openDecision(o, "승인", now);
  if (!opened.ok) return opened.res;
  const { root, state, pending, stage } = opened;
  try {
    // ② 승인 직전 **전수 재검증**: pending 산출물 + **앞 단계 승인 바이트 전부**(A-6).
    //    pending만 보면 "마지막 체크포인트 대기 중에 앞 단계 문서를 바꾸고 마지막만 승인" →
    //    '전체 완료' 영수증이 나온다. pending이 같은 경로를 다시 담으면 그 경로 기준은 pending이다
    //    (정당한 재작성을 drift로 잡지 않는다 — effectiveDigests가 그 우선순위를 표현한다).
    const problem = driftProblem(root, effectiveDigests(state, pending.artifacts).values());
    if (problem) {
      return reject(
        "pipeline_artifact_drift",
        `${problem}\n확인한 바이트가 아니므로 승인하지 않았습니다 (상태 불변) — 파일을 복원하거나 'harness pipeline reject'로 되돌린 뒤 다시 실행하세요.`,
        1,
      );
    }
    // ③ workflow 단계면 run_state를 다시 읽어 그 단계의 완료를 확인한다. killed면 화해가 먼저다.
    if (stage.kind === "workflow") {
      const rsRead = readRunStateAt(join(root, RUN_STATE_REL));
      if (rsRead.kind === "unreadable") {
        return reject("run_state_unreadable", `run_state.json을 읽을 수 없어 승인하지 않았습니다: ${rsRead.path} (${rsRead.detail})`, 2);
      }
      if (rsRead.kind === "absent") {
        return reject("run_state_absent", `run_state.json이 없어 이 단계의 완료를 확인할 수 없습니다 — 승인하지 않았습니다.`, 1);
      }
      const rs = rsRead.state;
      if (rs.status === "killed") {
        // [A-10] provenance: 이 단계의 workflow가 죽은 것이 아니면 영수증을 만들지 않는다.
        if (rs.workflow_id !== stage.workflowId) {
          return reject(
            "pipeline_killed_elsewhere",
            `run_state가 폐기 판정인데 그 workflow('${rs.workflow_id}')는 이 단계('${stage.id}')가 아닙니다 — 승인하지 않았고 아무것도 쓰지 않았습니다.`,
            1,
          );
        }
        const next = reconcileKilled(root, state, stage, rs, now());
        writePipelineState(root, next);
        return reject("pipeline_killed_reconciled", `run이 폐기(killed) 판정입니다 — 승인하지 않고 파이프라인을 종료했습니다 (${next.checkpoints.at(-1)?.note}).`, 1);
      }
      if (rs.workflow_id !== pending.workflow_id || rs.status !== "completed") {
        return reject(
          "pipeline_run_state_mismatch",
          `run_state가 이 단계의 완료를 증언하지 않습니다 (workflow ${rs.workflow_id} · status ${rs.status}) — 승인하지 않았습니다.`,
          1,
        );
      }
      // **byte binding ≠ run identity**: 같은 바이트를 낸 다른 run이면 id가 같고 승인은 통과한다.
      // 표시용 finished_at 불일치는 경고만 한다(거부 사유가 아니다 — 그렇게 하면 재실행 재현이 막힌다).
      if (rs.finished_at !== pending.run_finished_at) {
        console.warn(`참고: 확인 대기 시점의 run과 현재 run_state의 종료 시각이 다릅니다 (${pending.run_finished_at} → ${rs.finished_at}). 바이트는 동일합니다.`);
      }
    }
    const at = now();
    const receipt: PipelineCheckpoint = { ...pending, decision: "approved", decided_at: at, note: null };
    const nextIndex = state.current_index + 1;
    const finished = nextIndex >= DEFAULT_PIPELINE.length;
    writePipelineState(root, {
      ...state,
      current_index: nextIndex,
      status: finished ? "completed" : "awaiting_run",
      pending: null,
      last_failure: null,
      checkpoints: [...state.checkpoints, receipt],
      updated_at: at,
    });
    console.log(`✅ 승인: '${pending.stage}' (checkpoint ${pending.checkpoint_id} · 산출물 ${pending.artifacts.length}개)`);
    if (finished) {
      printCompletedGuidance(state.project);
    } else {
      console.log(`다음 단계: ${DEFAULT_PIPELINE[nextIndex].id} — harness pipeline next --project ${state.project}`);
    }
    return done("pipeline_approved", 0);
  } finally {
    opened.release();
  }
}

// ── reject ──────────────────────────────────────────────────────

export function rejectCheckpoint(o: { project: string; stage: string; checkpointId: string; note?: string; now?: () => string }): PipelineCommandResult {
  const now = o.now ?? (() => new Date().toISOString());
  const opened = openDecision(o, "되돌림", now);
  if (!opened.ok) return opened.res;
  const { root, state, pending } = opened;
  try {
    const at = now();
    const receipt: PipelineCheckpoint = { ...pending, decision: "rejected", decided_at: at, note: o.note ?? null };
    // 같은 단계의 실행 대기로 되돌린다(index 불변) — 다음 next는 **재실행**한다(old-run 채택 없음).
    writePipelineState(root, {
      ...state,
      status: "awaiting_run",
      pending: null,
      checkpoints: [...state.checkpoints, receipt],
      updated_at: at,
    });
    console.log(`↩ 되돌림: '${pending.stage}' (checkpoint ${pending.checkpoint_id})${o.note ? ` — ${o.note}` : ""}`);
    console.log(`같은 단계를 다시 실행합니다: harness pipeline next --project ${state.project}`);
    return done("pipeline_rejected", 0);
  } finally {
    opened.release();
  }
}

// ── restart ─────────────────────────────────────────────────────

/**
 * killed/completed(그리고 **읽을 수 없는 state**)에서만 새로 시작한다. 기존 파일은 **rename 보관**이고
 * 삭제가 없다 — 영수증은 사라지지 않는다.
 *
 * unreadable을 받는 이유(설계 §4 표의 "전부 exit 2"와의 충돌을 이렇게 해소했다): unreadable의 안내
 * 문구 자체가 "복원 또는 restart"인데 restart가 그 state를 읽어야만 돌면 **탈출구가 없다**.
 * 손상된 파일도 지우지 않고 archive로 옮기므로 잃는 것이 없고, 새 state는 stage 0 awaiting_run이라
 * 승인이 위조되지도 않는다(직접 파일 수정은 §8-2의 알려진 범위 밖 위협이다).
 * awaiting_run/awaiting_approval에서는 **거부**한다 — 체크포인트 회피 통로를 만들지 않는다.
 */
export function restartPipeline(o: { project: string; now?: () => string }): PipelineCommandResult {
  const now = o.now ?? (() => new Date().toISOString());
  const root = projectPaths(o.project).root;
  const abs = pipelineStatePath(root);
  if (readPipelineStateAt(abs).kind === "absent") {
    return reject("pipeline_absent", `파이프라인이 없습니다 (${o.project}) — 'harness pipeline next'로 시작하세요.`, 1);
  }
  const lock = lockPipeline(root, now);
  if (!lock.ok) return reject("pipeline_locked", lock.message, 2);
  const locked = lock.locked;
  try {
    // [Codex A-7] lock 획득 후 재독 — 그 사이 owner가 상태를 바꿨을 수 있다(진행 중 파이프라인을
    // archive해 버리는 것이 이 경로의 최악이다).
    const read = locked.read;
    if (read.kind === "absent") return reject("pipeline_absent", `파이프라인이 사라졌습니다 (${o.project}).`, 1);
    if (read.kind === "ok" && read.state.status !== "killed" && read.state.status !== "completed") {
      return reject(
        "pipeline_active",
        `진행 중인 파이프라인은 다시 시작할 수 없습니다 (상태 ${read.state.status} · 단계 ${stageLabel(read.state)}) — ` +
          `체크포인트를 우회하는 통로를 만들지 않습니다. 확인 대기면 approve/reject로 판정하세요.`,
        1,
      );
    }
    const at = now();
    // [Codex A-11] `renameSync`는 **destination을 교체한다** — 같은 시각 이름이 이미 있으면 앞 archive가
    // 사라지고 "삭제 없음·exact bytes 보존"이 거짓이 된다. 그래서 이름을 **exclusive-create로 예약**
    // (`flag:"wx"`)한 뒤 그 자리에만 rename한다: 우리가 방금 만든 빈 파일만 덮는다.
    const stamp = at.replace(/[-:.]/g, "").replace(/Z$/, "");
    let archive = "";
    for (let n = 1; n <= 100; n++) {
      const cand = join(root, PIPELINE_STATE_REL.replace(/\.json$/, `.${stamp}${n === 1 ? "" : `-${n}`}.json`));
      try {
        closeSync(openSync(cand, "wx")); // 이미 있으면 throw → 다음 이름
        archive = cand;
        break;
      } catch {
        continue;
      }
    }
    if (!archive) return reject("pipeline_archive_name_exhausted", `archive 이름을 예약할 수 없습니다 (${stamp} 계열 100개 사용 중)`, 1);
    renameSync(abs, archive); // **삭제 없음** — 기존 영수증은 예약한 자리로 그대로 보관된다
    const fresh = newPipelineState(o.project, at);
    writePipelineState(root, fresh);
    console.log(`파이프라인을 다시 시작했습니다 — 기존 state는 보관: ${archive.slice(root.length + 1)}`);
    console.log(`단계 ${stageLabel(fresh)}부터: harness pipeline next --project ${o.project}`);
    return done("pipeline_restarted", 0);
  } finally {
    locked.release();
  }
}

// ── unlock (lock 불요 · 죽은 owner만) ───────────────────────────

/**
 * **죽음을 관측했을 때만 회수한다**(`C-4` 보강이 세운 규율). `process.kill(pid, 0)`이 ESRCH를 던지면
 * 그 프로세스는 없다. 살아 있음·EPERM·판별 불가는 전부 거부 — 강제 플래그는 없다(있으면 그것이
 * 곧 "진행 중인 단계를 두 프로세스가 돌리는" 통로다).
 *
 * pipeline_state를 읽지 않는다: lock 회수는 상태 판정이 아니고, 손상된 state + 죽은 owner 조합에서
 * 회수마저 막히면 사람이 손으로 파일을 지우는 것 말고 길이 없어진다.
 */
export function unlockPipeline(o: { project: string }): PipelineCommandResult {
  const root = projectPaths(o.project).root;
  const abs = join(root, PIPELINE_LOCK_REL);
  const lock = readLock(root);
  if (!lock) {
    if (existsSync(abs)) {
      return reject(
        "pipeline_lock_unreadable",
        `lock 파일이 있지만 내용을 읽을 수 없습니다: ${abs} — owner의 죽음을 관측할 수 없어 회수하지 않습니다. 내용을 확인한 뒤 직접 지우세요.`,
        1,
      );
    }
    console.log(`회수할 lock이 없습니다 (${abs}).`);
    return done("pipeline_lock_absent", 0);
  }
  let alive: boolean;
  try {
    process.kill(lock.pid, 0);
    alive = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") alive = false;
    else alive = true; // EPERM 등 = 존재하지만 우리 것이 아니다. 판별 불가는 살아 있는 쪽으로 fail closed.
  }
  if (alive) {
    return reject(
      "pipeline_lock_owner_alive",
      `lock owner(pid ${lock.pid})가 살아 있거나 판별할 수 없습니다 — 회수하지 않았습니다 (획득 ${lock.at}).\n` +
        `그 프로세스가 끝나기를 기다리세요. 강제 회수 플래그는 없습니다 (같은 단계를 두 프로세스가 돌리는 통로가 됩니다).`,
      1,
    );
  }
  try {
    unlinkSync(abs);
  } catch (err) {
    return reject("pipeline_unlock_failed", `lock 회수 실패: ${(err as Error).message}`, 1);
  }
  console.log(`죽은 owner(pid ${lock.pid} · 획득 ${lock.at})의 lock을 회수했습니다: ${abs}`);
  return done("pipeline_unlocked", 0);
}
