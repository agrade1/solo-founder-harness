/**
 * [B-41/2단] 상태기 자체의 계약: checkpoint_id 재계산 · semantic 검증(fail closed) · action별 게이트
 * 판정 표 · lease의 두 결박 · seed 상한.
 *
 * 여기 있는 것은 **파일 바이트와 판정**만 다룬다(모델 호출 0). 명령 흐름(P1~P12)은
 * `src/commands/pipeline.test.ts`에 있다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PIPELINE,
  PIPELINE_ID,
  PIPELINE_SCHEMA,
  PIPELINE_VERSION,
  SEED_MAX_BYTES,
  SEED_MAX_CHARS,
  checkpointIdFor,
  digestArtifacts,
  driftProblem,
  leaseAllowsRun,
  newPipelineState,
  pipelineGateStatus,
  pipelineStatePath,
  pipelineWorkflowProblem,
  readPipelineStateAt,
  seedFindingsFrom,
  writePipelineState,
  type PipelineCheckpoint,
  type PipelineState,
} from "./pipeline.js";
import { loadWorkflows } from "./registry.js";
import { projectPaths } from "./project.js";

const AT = "2026-01-01T00:00:00.000Z";
const A64 = "a".repeat(64);

function makeProject(name: string): string {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.docs, "00_IDEA.md"), "# idea\n", "utf8");
  return p.root;
}

/** 승인 checkpoint 하나를 가진 completed state (게이트·drift 단정용). */
function completedState(project: string, artifacts: Array<{ path: string; size: number; sha256: string }>): PipelineState {
  const base = { stage: "idea-validation", workflow_id: "idea-validation", run_finished_at: AT, artifacts, seeds: [] };
  const cp: PipelineCheckpoint = { ...base, checkpoint_id: checkpointIdFor(base), decision: "approved", decided_at: AT, note: null };
  return { ...newPipelineState(project, AT), current_index: DEFAULT_PIPELINE.length, status: "completed", checkpoints: [cp] };
}

// ── 단계 정의 ──────────────────────────────────────────────────
test("[B-41] 파이프라인 단계가 registry의 실제 workflow를 가리킨다 (없으면 첫 호출 전에 멈춘다)", () => {
  const ids = loadWorkflows().map((w) => w.workflow_id);
  assert.equal(pipelineWorkflowProblem(ids), null, "실제 registry와 정합");
  assert.match(pipelineWorkflowProblem(["idea-validation"]) ?? "", /mvp-planning/, "빠진 workflow를 이름으로 지목한다");
  assert.deepEqual(
    DEFAULT_PIPELINE.map((s) => s.id),
    ["idea-validation", "mvp-planning", "dev-preflight", "dev-handoff"],
    "사용자 요구의 단계 순서",
  );
  assert.equal(DEFAULT_PIPELINE.at(-1)?.kind, "task_prompt", "마지막 단계는 workflow가 아니라 지시문 생성이다");
});

// ── checkpoint_id ──────────────────────────────────────────────
test("[B-41/§3.1] checkpoint_id: 바이트·seed에 결박되고 run_finished_at에는 결박되지 않는다", () => {
  const base = {
    stage: "idea-validation",
    workflow_id: "idea-validation",
    artifacts: [
      { path: "docs/01_RESEARCH.md", size: 10, sha256: A64 },
      { path: "docs/02_PRD.md", size: 20, sha256: "b".repeat(64) },
    ],
    seeds: [{ agent_id: "research", line: "research: 판단" }],
  };
  const id = checkpointIdFor(base);
  assert.match(id, /^[0-9a-f]{12}$/);
  // 순서가 달라도 같은 id (canonical 정렬) — "같은 내용"이 곧 같은 신원이다.
  assert.equal(checkpointIdFor({ ...base, artifacts: [...base.artifacts].reverse() }), id, "artifacts 순서 무관");
  // 한 바이트라도 다르면 다른 id.
  assert.notEqual(checkpointIdFor({ ...base, artifacts: [{ ...base.artifacts[0], size: 11 }, base.artifacts[1]] }), id, "size 변화 → 다른 id");
  assert.notEqual(checkpointIdFor({ ...base, seeds: [{ agent_id: "research", line: "research: 다른 판단" }] }), id, "seed 산문 위조 → 다른 id");
  assert.notEqual(checkpointIdFor({ ...base, stage: "mvp-planning" }), id, "stage 변화 → 다른 id");
  // **run_finished_at은 payload에서 제외된다**: 같은 바이트를 낸 다른 run이 같은 신원을 가져야 한다
  // (§3.2 byte binding ≠ run identity). 넣기 시작하면 이 단정이 red가 된다.
  const withTime = { ...base, run_finished_at: "2030-12-31T23:59:59.000Z" };
  assert.equal(checkpointIdFor(withTime), id, "표시용 종료 시각은 신원에 들어가지 않는다");
});

// ── semantic 검증 (P9) ────────────────────────────────────────
test("[B-41/§3.3] semantic 위반은 전부 unreadable — 위조 id·빈 artifacts·pending 모순·경로 탈출", () => {
  const name = "_b41c_sem";
  const root = makeProject(name);
  const abs = pipelineStatePath(root);
  const okBase = { stage: "idea-validation", workflow_id: "idea-validation", run_finished_at: AT, artifacts: [{ path: "docs/02_PRD.md", size: 3, sha256: A64 }], seeds: [] };
  const okPending = { ...okBase, checkpoint_id: checkpointIdFor(okBase) };
  const good: PipelineState = { ...newPipelineState(name, AT), status: "awaiting_approval", pending: okPending };

  // 대조군: 정상 state는 읽힌다 (아래 거부들이 공허하지 않다).
  writePipelineState(root, good);
  assert.equal(readPipelineStateAt(abs).kind, "ok", "정상 state는 통과");

  const bad: Array<{ label: string; mutate: (s: PipelineState) => unknown; expect: RegExp }> = [
    { label: "가짜 12-hex id", mutate: (s) => ({ ...s, pending: { ...s.pending!, checkpoint_id: "0123456789ab" } }), expect: /checkpoint_id가 내용과 어긋난다/ },
    { label: "artifacts 빈 배열", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } }; // id까지 맞춰도 거부돼야 한다
      }, expect: /artifacts가 비어 있다/ },
    { label: "awaiting_approval + pending null", mutate: (s) => ({ ...s, pending: null }), expect: /awaiting_approval ⟺ pending≠null/ },
    { label: "pending 있는데 awaiting_run", mutate: (s) => ({ ...s, status: "awaiting_run" }), expect: /awaiting_approval ⟺ pending≠null/ },
    { label: "경로 탈출(..)", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [{ path: "../../etc/passwd", size: 1, sha256: A64 }] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /정규 상대경로가 아니다/ },
    { label: "절대경로", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [{ path: "/etc/passwd", size: 1, sha256: A64 }] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /정규 상대경로가 아니다/ },
    { label: "비정규 표기(./)", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [{ path: "./docs/02_PRD.md", size: 1, sha256: A64 }] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /정규 상대경로가 아니다/ },
    { label: "경로 중복", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [okBase.artifacts[0], okBase.artifacts[0]] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /path 중복/ },
    { label: "size 음수", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [{ path: "docs/02_PRD.md", size: -1, sha256: A64 }] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /safe integer가 아니다/ },
    { label: "sha256 64-hex 아님", mutate: (s) => {
        const p = { ...s.pending!, artifacts: [{ path: "docs/02_PRD.md", size: 1, sha256: "deadbeef" }] };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /64-hex가 아니다/ },
    { label: "pending.stage ≠ current_index 단계", mutate: (s) => {
        const p = { ...s.pending!, stage: "dev-preflight" };
        return { ...s, pending: { ...p, checkpoint_id: checkpointIdFor(p) } };
      }, expect: /pending.stage가 current_index의 단계와 다르다/ },
    { label: "pipeline_version 불일치", mutate: (s) => ({ ...s, pipeline_version: PIPELINE_VERSION + 1 }), expect: /pipeline_version 불일치/ },
    { label: "schema 불일치", mutate: (s) => ({ ...s, schema: PIPELINE_SCHEMA + 1 }), expect: /schema가/ },
    { label: "project 이름 불일치(복사된 state)", mutate: (s) => ({ ...s, project: "다른프로젝트" }), expect: /디렉터리 이름과 다르다/ },
    { label: "pipeline_id 불일치", mutate: (s) => ({ ...s, pipeline_id: "other" }), expect: /pipeline_id가/ },
    { label: "current_index 범위 밖", mutate: (s) => ({ ...s, current_index: 99, pending: null, status: "awaiting_run" }), expect: /current_index가/ },
    { label: "status enum 아님", mutate: (s) => ({ ...s, status: "approved_maybe", pending: null }), expect: /status가 enum이 아니다/ },
    { label: "checkpoint decision enum 아님", mutate: (s) => ({ ...s, checkpoints: [{ ...okPending, decision: "yes", decided_at: AT, note: null }] }), expect: /decision이 enum이 아니다/ },
    { label: "checkpoint id 위조", mutate: (s) => ({ ...s, checkpoints: [{ ...okPending, checkpoint_id: "0123456789ab", decision: "approved", decided_at: AT, note: null }] }), expect: /checkpoint_id가 내용과 어긋난다/ },
  ];
  for (const c of bad) {
    const json = JSON.stringify(c.mutate(good), null, 2);
    writeFileSync(abs, json, "utf8");
    const read = readPipelineStateAt(abs);
    assert.equal(read.kind, "unreadable", `${c.label}: unreadable이어야 한다`);
    assert.match(read.kind === "unreadable" ? read.detail : "", c.expect, `${c.label}: 사유`);
    // fail closed의 핵심 — 게이트가 **아무 action도** 열지 않는다.
    for (const action of ["run", "task-prompt", "handoff", "plan-dag"] as const) {
      const g = pipelineGateStatus(read, root, action);
      assert.equal(g.ok, false, `${c.label}: ${action} 거부`);
      assert.equal(g.ok === false ? g.code : "", "pipeline_state_unreadable");
    }
    assert.equal(readFileSync(abs, "utf8"), json, `${c.label}: 판정이 파일을 건드리지 않았다`);
  }

  // 문법 손상도 같다 (부재로 접지 않는다).
  writeFileSync(abs, "{ not json", "utf8");
  assert.equal(readPipelineStateAt(abs).kind, "unreadable");
  rmSync(root, { recursive: true, force: true });
});

// ── 게이트 판정 표 (§2.3) ─────────────────────────────────────
test("[B-41/§2.3] action × 상태 판정 표 전수 — run은 활성에서 전면 거부, killed에서만 재평가용으로 열린다", () => {
  const name = "_b41c_gate";
  const root = makeProject(name);
  writeFileSync(join(root, "docs", "02_PRD.md"), "PRD", "utf8");
  const digest = digestArtifacts(root, ["docs/02_PRD.md"]);
  const withApproved = completedState(name, digest);

  const cases: Array<{ label: string; state: PipelineState | null; want: Record<string, string> }> = [
    { label: "absent", state: null, want: { run: "ok", "task-prompt": "ok", handoff: "ok", "plan-dag": "ok" } },
    {
      label: "awaiting_run(1단계)",
      state: { ...withApproved, current_index: 0, status: "awaiting_run", checkpoints: [] },
      want: { run: "pipeline_run_reserved", "task-prompt": "pipeline_stage_incomplete", handoff: "pipeline_stage_incomplete", "plan-dag": "pipeline_stage_incomplete" },
    },
    {
      label: "awaiting_run(dev-handoff)",
      state: { ...withApproved, current_index: 3, status: "awaiting_run" },
      want: { run: "pipeline_run_reserved", "task-prompt": "ok", handoff: "pipeline_stage_incomplete", "plan-dag": "pipeline_stage_incomplete" },
    },
    {
      label: "awaiting_approval",
      state: (() => {
        const base = { stage: "idea-validation", workflow_id: "idea-validation", run_finished_at: AT, artifacts: digest, seeds: [] };
        return { ...newPipelineState(name, AT), status: "awaiting_approval" as const, pending: { ...base, checkpoint_id: checkpointIdFor(base) } };
      })(),
      want: { run: "pipeline_run_reserved", "task-prompt": "pipeline_checkpoint_pending", handoff: "pipeline_checkpoint_pending", "plan-dag": "pipeline_checkpoint_pending" },
    },
    { label: "completed", state: withApproved, want: { run: "ok", "task-prompt": "ok", handoff: "ok", "plan-dag": "ok" } },
    {
      label: "killed",
      state: { ...withApproved, current_index: 0, status: "killed" },
      // run만 열려 있다 — B-40 재평가 경로 보존(kill 잠금 자체는 ideaGateStatus가 집행한다).
      want: { run: "ok", "task-prompt": "pipeline_killed", handoff: "pipeline_killed", "plan-dag": "pipeline_killed" },
    },
  ];
  for (const c of cases) {
    if (c.state) writePipelineState(root, c.state);
    else rmSync(pipelineStatePath(root), { force: true });
    const read = readPipelineStateAt(pipelineStatePath(root));
    if (c.state) assert.equal(read.kind, "ok", `${c.label}: fixture가 semantic 검증을 통과해야 한다`);
    for (const [action, want] of Object.entries(c.want)) {
      const g = pipelineGateStatus(read, root, action as "run");
      const got = g.ok ? "ok" : g.code;
      assert.equal(got, want, `${c.label} × ${action} → ${want} (실제 ${got})`);
    }
  }

  // completed + 승인 후 바이트 변경 → drift (run은 여전히 ok — run 게이트는 drift를 보지 않는다)
  writePipelineState(root, withApproved);
  writeFileSync(join(root, "docs", "02_PRD.md"), "PRD 변조", "utf8");
  const drifted = readPipelineStateAt(pipelineStatePath(root));
  for (const action of ["task-prompt", "handoff", "plan-dag"] as const) {
    const g = pipelineGateStatus(drifted, root, action);
    assert.equal(g.ok === false ? g.code : "ok", "pipeline_artifact_drift", `${action}: 승인 후 교체 탐지`);
  }
  assert.equal(pipelineGateStatus(drifted, root, "run").ok, true, "run은 drift로 막지 않는다(그 자리는 pipeline next가 본다)");
  // 파일이 사라진 경우도 drift다 (부재를 통과로 접지 않는다).
  rmSync(join(root, "docs", "02_PRD.md"));
  assert.match(driftProblem(root, digest) ?? "", /없어졌습니다/);
  rmSync(root, { recursive: true, force: true });
});

// ── lease (P13) ───────────────────────────────────────────────
test("[B-41/§2.4] lease는 nonce·현 단계 workflow·awaiting_run **세 사실**에 결박된다", () => {
  const name = "_b41c_lease";
  const root = makeProject(name);
  const state: PipelineState = { ...newPipelineState(name, AT), current_index: 1, status: "awaiting_run" };
  writePipelineState(root, state);
  const read = readPipelineStateAt(pipelineStatePath(root));
  const nonce = "0123456789abcdef";
  const lockAbs = join(root, "outputs", "pipeline.lock");

  // lock 파일이 없으면 어떤 nonce도 통하지 않는다.
  assert.equal(leaseAllowsRun(read, root, "mvp-planning", { nonce }), false, "lock 부재 → lease 무효");
  writeFileSync(lockAbs, JSON.stringify({ pid: process.pid, nonce, at: AT }), "utf8");
  assert.equal(leaseAllowsRun(read, root, "mvp-planning", { nonce }), true, "대조군: 유효 lease는 현 단계를 연다");
  assert.equal(leaseAllowsRun(read, root, "mvp-planning", { nonce: "f".repeat(16) }), false, "위조 nonce 거부");
  assert.equal(leaseAllowsRun(read, root, "mvp-planning", undefined), false, "lease 없는 호출자 거부");
  // 같은 lock을 쥐고도 **다른 단계**는 열리지 않는다.
  assert.equal(leaseAllowsRun(read, root, "dev-preflight", { nonce }), false, "타 단계 workflowId 거부");
  assert.equal(leaseAllowsRun(read, root, "idea-validation", { nonce }), false, "지난 단계 workflowId 거부");
  // awaiting_approval이면 lease도 못 연다 (pending 생략 금지).
  const base = { stage: "mvp-planning", workflow_id: "mvp-planning", run_finished_at: AT, artifacts: [{ path: "docs/02_PRD.md", size: 1, sha256: A64 }], seeds: [] };
  writePipelineState(root, { ...state, status: "awaiting_approval", pending: { ...base, checkpoint_id: checkpointIdFor(base) } });
  assert.equal(leaseAllowsRun(readPipelineStateAt(pipelineStatePath(root)), root, "mvp-planning", { nonce }), false, "awaiting_approval에서는 lease 무효");
  // 손상 state에서는 lease가 아무것도 열지 않는다.
  writeFileSync(pipelineStatePath(root), "{ broken", "utf8");
  assert.equal(leaseAllowsRun(readPipelineStateAt(pipelineStatePath(root)), root, "mvp-planning", { nonce }), false, "unreadable에서 lease 무효");
  rmSync(root, { recursive: true, force: true });
});

// ── seed 상한 (§5) ────────────────────────────────────────────
test("[B-41/§5] seed: 승인 영수증에서만 오고, 뒤 단계가 승계하고, 상한 초과는 자르지 않고 경로 참조로 대체한다", () => {
  const name = "_b41c_seed";
  const root = makeProject(name);
  const mk = (stage: string, seeds: Array<{ agent_id: string; line: string }>, decision: PipelineCheckpoint["decision"]): PipelineCheckpoint => {
    const base = { stage, workflow_id: stage, run_finished_at: AT, artifacts: [{ path: `docs/${stage}.md`, size: 1, sha256: A64 }], seeds };
    return { ...base, checkpoint_id: checkpointIdFor(base), decision, decided_at: AT, note: null };
  };
  const state: PipelineState = {
    ...newPipelineState(name, AT),
    current_index: 2,
    status: "awaiting_run",
    checkpoints: [
      mk("idea-validation", [{ agent_id: "research", line: "research: 1단계 판단" }, { agent_id: "pm", line: "pm: 1단계 PRD" }], "approved"),
      mk("mvp-planning", [{ agent_id: "pm", line: "pm: 2단계 PRD(승계)" }], "approved"),
      mk("dev-preflight", [{ agent_id: "tech_lead", line: "tech_lead: 거부된 판단" }], "rejected"),
    ],
  };
  const seeds = seedFindingsFrom(state);
  assert.deepEqual(seeds, ["research: 1단계 판단", "pm: 2단계 PRD(승계)"], "같은 agent는 뒤 단계가 승계 · 거부 영수증은 입력이 아니다");

  // 항목 상한 초과 → **자르지 않고** 통째로 경로 참조로 대체(silent truncation 금지).
  const long = { ...state, checkpoints: [mk("idea-validation", [{ agent_id: "research", line: "research: " + "가".repeat(SEED_MAX_CHARS + 1) }], "approved")] };
  const capped = seedFindingsFrom(long);
  assert.equal(capped.length, 1);
  assert.match(capped[0], /^research: \(요약 상한 초과 — docs\/01_RESEARCH\.md 참조\)$/, "경로 참조로 대체");
  assert.ok(!capped[0].includes("가가가"), "원문 일부를 잘라 넣지 않는다");

  // 총량 상한: 항목 상한 안이지만 합이 16KB를 넘는 다수 → 넘어가는 지점부터 경로 참조.
  const many = {
    ...state,
    checkpoints: [
      mk(
        "idea-validation",
        Array.from({ length: 20 }, (_, i) => ({ agent_id: `agent_${i}`, line: `agent_${i}: ` + "나".repeat(SEED_MAX_CHARS - 20) })),
        "approved",
      ),
    ],
  };
  const bounded = seedFindingsFrom(many);
  assert.equal(bounded.length, 20, "항목을 조용히 버리지 않는다");
  assert.ok(Buffer.byteLength(bounded.join(""), "utf8") <= SEED_MAX_BYTES + 200, `총량 상한 근처로 억제된다 (실측 ${Buffer.byteLength(bounded.join(""), "utf8")}B)`);
  assert.ok(bounded.some((s) => s.includes("요약 상한 초과")), "상한을 넘긴 지점부터 경로 참조로 대체");
  rmSync(root, { recursive: true, force: true });
});

test("[B-41] pipeline_state는 temp+rename으로 쓰인다 (부분 파일을 관측할 창이 없다)", () => {
  const name = "_b41c_write";
  const root = makeProject(name);
  writePipelineState(root, newPipelineState(name, AT));
  const read = readPipelineStateAt(pipelineStatePath(root));
  assert.equal(read.kind, "ok");
  assert.equal(readFileSync(pipelineStatePath(root), "utf8").endsWith("\n"), true, "개행으로 끝난다");
  assert.equal(PIPELINE_ID, "founder-predev");
  rmSync(root, { recursive: true, force: true });
});
