/**
 * [B-41] **단계 체크포인트 오케스트레이션** — durable 상태기 + action별 집행 게이트.
 *
 * 사용자 요구: "완전 자동은 좀 그렇고, 기획문서를 다 뽑았을 때 다음 작업 전 사용자에게 문서 확인을
 * 요청하고 다음 작업 승인 대기로 들어가기". 그래서 고정 파이프라인
 * `idea-validation → mvp-planning → dev-preflight → dev-handoff`의 각 단계 끝에 **사람 승인**이
 * 있고, 승인은 "그 단계가 만든 **바이트**"에 결박된다(checkpoint_id + sha256 재검증).
 *
 * ## 이 모듈이 지키는 불변식
 *
 * 1. **fail closed**: 상태 파일을 읽을 수 없거나(문법·semantic·버전·id 재계산) 판단이 애매하면
 *    **아무것도 하지 않는다** — 파일 바이트 불변 + exit 2. 손상을 "파이프라인 없음"으로 접으면
 *    그 순간이 곧 우회 통로다(B-40이 run_state에서 같은 결함을 잡았다).
 * 2. **게이트는 action별**: 활성 파이프라인에서 일반 `run`은 거부(`pipeline_run_reserved`)다 —
 *    현 단계 실행은 **lock을 쥔 파이프라인 연산 안에서만** 일어난다: lease는 `lockPipeline(...)`이
 *    `runStage` 호출 동안만 발행하는 **불투명 객체**이고(문자열 위조 불가 · 끝나면 만료), 그것이
 *    여는 것은 '현 단계 workflow 하나'뿐이다(§2.4 · Codex A-3).
 * 3. **승인은 바이트 결박이고 run 신원 결박이 아니다**: 같은 workflow를 다시 돌려 **완전히 같은
 *    바이트**가 나오면 checkpoint_id도 같고 approve는 통과한다(검토한 내용과 동일하므로 수용).
 *    "어느 run이었나"는 결박하지 않는다.
 * 4. **seed는 durable 저장본에서만**: 승인 문서의 한 줄 요약은 영수증에 저장되고, 다음 단계는
 *    **파일을 다시 읽지 않는다** — 검증한 바이트와 소비한 바이트가 갈리는 창을 구조적으로 없앤다.
 *
 * ## 닫힌 범위 (정확히 이것뿐 — 종결 주장 금지)
 *
 * 이 파이프라인이 게이트하는 것은 **프로젝트 스코프 v1 경로 4개**다: `run` · `task-prompt` ·
 * `handoff` · `plan-dag`. `exec` · `mission` · `autopilot` · `autopilot-create`는 **게이트하지
 * 않는다** — 그 층의 durable run에는 project 신원이 없어서(`C-132`) 이 상태기가 붙을 자리가 아직
 * 없다. 체크포인트 대기 중에도 그 명령들은 그대로 돈다. 별도 슬라이스 몫이다.
 *
 * ## 정직한 한계 (닫지 않은 것 — 다음 사람이 닫힌 것으로 믿지 않게)
 *
 * - `exec`/`mission`/`autopilot*`은 **배선하지 않았다**(위 "닫힌 범위" 참조).
 * - state·lock·문서 파일의 **직접 수정/삭제**는 막지 못한다(로컬 fs 권한 밖 · 서명/actor 신원 없음 —
 *   `C-7`·`C-131` 부류). lease nonce도 로컬 코드가 lock 파일에서 읽으면 위조할 수 있다. lease가
 *   실제로 집행하는 불변식은 "단일 writer(lock 보유자)와 현 단계 실행의 결합"이다.
 * - `task-prompt`/`handoff`는 게이트의 digest 검증 **후** 자기 로직이 문서를 다시 읽는다 — 그 사이
 *   창은 남는다(단일 사용자 CLI의 race이지 안정 경로가 아니다). seed 경로만 이번에 닫았다.
 * - 직접 `run`과의 경합에서 주장하는 것은 "**오염된 상태로 승인이 나가지 않는다**"까지다.
 *   산출물 파일 자체는 섞일 수 있다(같은 docs/·run_state.json의 두 writer는 직렬화되지 않는다).
 */
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, unlinkSync, realpathSync, renameSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { findAgent, loadAgentRegistry } from "./registry.js";
import { extractMainJudgment } from "./validate.js";
import { projectPaths } from "./project.js";
import type { RunState } from "./runWorkflow.js";

export const PIPELINE_ID = "founder-predev";
/** `DEFAULT_PIPELINE`의 판. 불일치 = 모든 명령 거부 + restart 안내(단계 수·순서가 바뀐 state는 못 읽는다). */
export const PIPELINE_VERSION = 1;
export const PIPELINE_SCHEMA = 1;
export const PIPELINE_STATE_REL = "outputs/pipeline_state.json";
export const PIPELINE_LOCK_REL = "outputs/pipeline.lock";

/**
 * 단계 정의는 **판별 union**이다: workflow를 돌리는 단계와 지시문을 만드는 단계는 하는 일이 다르고,
 * `workflowId`가 optional string이면 "그 단계가 workflow인가"를 매 자리에서 다시 추측하게 된다.
 *
 * `registry/pipelines.json`을 만들지 않은 이유: 값 하나짜리 설정 파일 + 어휘 수기 중복(`C-130` 부류).
 * 파이프라인이 실제로 여러 벌 필요해지면 그때 파일로 올린다.
 */
export type PipelineStage =
  | { id: string; kind: "workflow"; workflowId: string }
  | { id: "dev-handoff"; kind: "task_prompt" };

export const DEFAULT_PIPELINE: readonly PipelineStage[] = [
  { id: "idea-validation", kind: "workflow", workflowId: "idea-validation" },
  { id: "mvp-planning", kind: "workflow", workflowId: "mvp-planning" },
  { id: "dev-preflight", kind: "workflow", workflowId: "dev-preflight" },
  { id: "dev-handoff", kind: "task_prompt" },
];

export type PipelineStatus = "awaiting_run" | "awaiting_approval" | "completed" | "killed";
export type PipelineDecision = "approved" | "rejected" | "killed";

export interface ArtifactEntry {
  path: string; // 프로젝트 루트 기준 정규 상대경로
  size: number;
  sha256: string;
}

/** 승인 문서에서 뽑은 한 줄 요약. digest와 **같은 read**에서 나온다(§4.4). */
export interface SeedEntry {
  agent_id: string;
  line: string;
}

export interface PipelinePending {
  stage: string;
  checkpoint_id: string;
  workflow_id: string | null; // dev-handoff는 null
  /** **표시 전용** — canonical payload에서 제외한다(같은 바이트를 낸 다른 run도 같은 id여야 한다). */
  run_finished_at: string | null;
  artifacts: ArtifactEntry[];
  seeds: SeedEntry[];
}

export interface PipelineCheckpoint extends PipelinePending {
  decision: PipelineDecision;
  decided_at: string;
  note: string | null;
}

/** 직전 실패 attempt의 흔적. resume의 digest 예외는 **이 영수증에만** 결박된다(§4.3). */
export interface PipelineFailure {
  stage: string;
  workflow_id: string | null;
  at: string;
  written: ArtifactEntry[];
}

export interface PipelineState {
  schema: number;
  pipeline_version: number;
  pipeline_id: string;
  project: string;
  /**
   * [B-57] **이 파이프라인이 쓰는 provider.** 없으면(옛 state) 호출자 기본값으로 강하한다.
   *
   * 왜 durable인가: 예전엔 매 `next`가 독립적으로 provider를 해석했고 기본값이 `mock`이었다.
   * 그런데 도구가 인쇄하는 다음 단계 안내 **6곳 전부**에 `--provider`가 없어서, 1단계를
   * `claude-code`로 돌린 사람이 **안내를 그대로 따르면 2단계가 mock으로 떨어졌다.** 오류가 아니라
   * `[MOCK]` 딱지가 붙은 그럴듯한 문서가 나와 승인 대기로 갔다 — 이 레포 거짓 안내 계열 중 처음으로
   * "막히는" 것이 아니라 **"가짜를 만드는"** 쪽이었다.
   *
   * `--provider`를 명시하면 그것이 이기고 이 값이 갱신된다(전환은 정당하다 — 조용한 전환만 막는다).
   */
  provider?: string;
  current_index: number;
  status: PipelineStatus;
  pending: PipelinePending | null;
  last_failure: PipelineFailure | null;
  checkpoints: PipelineCheckpoint[];
  started_at: string;
  updated_at: string;
}

export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

// ── 경로·형식 술어 ──────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const HEX12 = /^[0-9a-f]{12}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/**
 * 영수증에 실릴 수 있는 **표기**: 프로젝트 루트 기준 정규 상대경로뿐이다(절대경로·`..`·backslash·
 * `./x`·`a//b` 거부).
 *
 * [Codex A-9 정정] 이것은 **표기 검증이고 containment 보장이 아니다** — 예전 주석은 "구조적으로
 * 성립한다"고 적었는데 거짓이었다: `docs/x.md`가 프로젝트 밖을 가리키는 symlink면 `readFileSync`·
 * `statSync`가 그것을 따라간다. 실제 containment는 사용 시점에 `containmentProblem()`이 **realpath로**
 * 확인한다. symlink 정책: 허용하되 **realpath가 프로젝트 루트 안**이어야 한다.
 */
function safeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (isAbsolute(p) || p.includes("\\") || p.includes("\0")) return false;
  if (normalize(p) !== p) return false;
  return p !== ".." && !p.startsWith(`..${sep}`);
}

function isSafeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * [Codex A-9] 사용 시점 containment: realpath가 프로젝트 루트 **안**의 **정규 파일**이어야 한다.
 *
 * symlink는 금지하지 않는다(정상적인 작업 방식일 수 있다) — 대신 **가리키는 실체가 루트 안**임을
 * 요구한다. 루트 밖을 가리키면 그 바이트는 이 프로젝트의 산출물이 아니므로 승인 대상이 될 수 없다.
 * 정직한 한계: 이 확인과 뒤이은 read 사이의 창은 남는다(§8의 race — TOCTOU를 없애려면 fd 기반
 * 열기·재확인이 필요하고 그것은 별도 슬라이스다).
 *
 * @returns 문제가 있으면 사람이 읽는 이유, 없으면 null.
 */
function containmentProblem(projectRoot: string, rel: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    return `프로젝트 루트를 해석할 수 없습니다: ${projectRoot}`;
  }
  let real: string;
  try {
    real = realpathSync(join(projectRoot, rel));
  } catch {
    return null; // 부재는 호출자가 별도 코드로 다룬다 (여기서는 경로 위치만 본다)
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return `프로젝트 루트 밖을 가리킵니다 (symlink?): ${rel} → ${real}`;
  }
  return null;
}

// ── checkpoint_id ───────────────────────────────────────────────

/**
 * canonical payload = `{ stage, workflow_id, artifacts(경로 정렬), seeds(agent_id 정렬) }`의 JSON.
 *
 * `run_finished_at`은 **제외**한다: 표시 전용이고, 넣으면 "같은 바이트를 낸 재실행"이 다른 id가 된다
 * (§3.2의 byte binding 의미론이 깨진다). seeds를 **넣는** 이유는 반대다: artifacts digest는 문서
 * 바이트를 결박하지만 저장된 seed 산문은 별개 필드라, 빼면 "digest는 맞는데 seed가 거짓말하는" 위조가
 * 남는다.
 */
function canonicalPayload(p: { stage: string; workflow_id: string | null; artifacts: ArtifactEntry[]; seeds: SeedEntry[] }): string {
  return JSON.stringify({
    stage: p.stage,
    workflow_id: p.workflow_id,
    artifacts: [...p.artifacts]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((a) => ({ path: a.path, size: a.size, sha256: a.sha256 })),
    seeds: [...p.seeds]
      .sort((a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0))
      .map((s) => ({ agent_id: s.agent_id, line: s.line })),
  });
}

/** payload의 sha256 앞 12 hex. **validator가 이것을 재계산해 대조**하므로 임의 id 위조는 죽는다. */
export function checkpointIdFor(p: { stage: string; workflow_id: string | null; artifacts: ArtifactEntry[]; seeds: SeedEntry[] }): string {
  return createHash("sha256").update(canonicalPayload(p)).digest("hex").slice(0, 12);
}

// ── 읽기 + semantic 검증 ────────────────────────────────────────

export type PipelineStateRead =
  | { kind: "absent" }
  | { kind: "unreadable"; path: string; detail: string }
  | { kind: "ok"; state: PipelineState };

function artifactsProblem(label: string, v: unknown, opts: { allowEmpty: boolean }): string | null {
  if (!Array.isArray(v)) return `${label}.artifacts가 배열이 아니다`;
  if (v.length === 0 && !opts.allowEmpty) return `${label}.artifacts가 비어 있다 (승인할 산출물 없는 영수증 금지)`;
  const seen = new Set<string>();
  for (const [i, a] of v.entries()) {
    if (typeof a !== "object" || a === null) return `${label}.artifacts[${i}]가 객체가 아니다`;
    const e = a as Record<string, unknown>;
    if (!safeRelPath(e.path)) return `${label}.artifacts[${i}].path가 정규 상대경로가 아니다`;
    if (seen.has(e.path as string)) return `${label}.artifacts[${i}].path 중복: ${String(e.path)}`;
    seen.add(e.path as string);
    if (!isSafeInt(e.size)) return `${label}.artifacts[${i}].size가 음수 아닌 safe integer가 아니다`;
    if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) return `${label}.artifacts[${i}].sha256이 64-hex가 아니다`;
  }
  return null;
}

function seedsProblem(label: string, v: unknown): string | null {
  if (!Array.isArray(v)) return `${label}.seeds가 배열이 아니다`;
  for (const [i, s] of v.entries()) {
    if (typeof s !== "object" || s === null) return `${label}.seeds[${i}]가 객체가 아니다`;
    const e = s as Record<string, unknown>;
    if (typeof e.agent_id !== "string" || e.agent_id.length === 0) return `${label}.seeds[${i}].agent_id가 문자열이 아니다`;
    if (typeof e.line !== "string") return `${label}.seeds[${i}].line이 문자열이 아니다`;
  }
  return null;
}

/**
 * pending/checkpoint 공통 축 + **checkpoint_id 재계산 대조**.
 * @param allowEmptyArtifacts kill 영수증에만 true — 폐기는 산출물을 승인하지 않는 terminal 기록이고
 *   (죽은 run이 파일을 하나도 남기지 않았을 수 있다), 그 영수증으로는 아무 소비자도 열리지 않는다.
 *   승인·거부 영수증과 pending에서는 빈 artifacts가 곧 "무엇도 검증하지 않는 승인"이라 계속 금지한다.
 */
function receiptProblem(label: string, v: unknown, allowEmptyArtifacts: boolean): string | null {
  if (typeof v !== "object" || v === null) return `${label}가 객체가 아니다`;
  const e = v as Record<string, unknown>;
  if (typeof e.stage !== "string" || !DEFAULT_PIPELINE.some((s) => s.id === e.stage)) return `${label}.stage가 파이프라인 단계가 아니다`;
  if (!(typeof e.workflow_id === "string" || e.workflow_id === null)) return `${label}.workflow_id가 문자열도 null도 아니다`;
  if (!(typeof e.run_finished_at === "string" || e.run_finished_at === null)) return `${label}.run_finished_at 형태 오류`;
  const ap = artifactsProblem(label, e.artifacts, { allowEmpty: allowEmptyArtifacts });
  if (ap) return ap;
  const sp = seedsProblem(label, e.seeds);
  if (sp) return sp;
  if (typeof e.checkpoint_id !== "string" || !HEX12.test(e.checkpoint_id)) return `${label}.checkpoint_id가 12-hex가 아니다`;
  const recomputed = checkpointIdFor({
    stage: e.stage,
    workflow_id: e.workflow_id as string | null,
    artifacts: e.artifacts as ArtifactEntry[],
    seeds: e.seeds as SeedEntry[],
  });
  if (recomputed !== e.checkpoint_id) {
    return `${label}.checkpoint_id가 내용과 어긋난다 (기록 ${String(e.checkpoint_id)} · 재계산 ${recomputed})`;
  }
  return null;
}

/**
 * [Codex A-1] **승인 이력 replay.** `current_index`를 "범위 안"으로만 검사하면
 * `current_index:3` + 1단계 승인 하나뿐인 state가 정상으로 통과하고 dev-handoff의 `task-prompt`가
 * 열린다 — 승인 두 개를 건너뛴 파이프라인이 정상 영수증을 갖는 것이다. index는 **영수증이 만든
 * 것**이어야 하므로 처음부터 다시 세워 대조한다(형식 검증만으로는 위조 index를 잡을 수 없다).
 *
 * 함께 못 박는 관계: 영수증의 stage 순서 · 각 영수증의 workflow_id ↔ 단계 종류 · killed의 terminal성
 * (kill 영수증 뒤에 영수증이 없고, kill 영수증 ⟺ status killed) · pending/last_failure의 stage 결박.
 */
function replayProblem(s: PipelineState): string | null {
  let idx = 0;
  let killedAt = -1;
  for (const [i, c] of s.checkpoints.entries()) {
    if (killedAt >= 0) return `checkpoints[${i}]: kill 영수증(#${killedAt}) 뒤에 영수증이 더 있다 (폐기는 terminal이다)`;
    const stage = DEFAULT_PIPELINE[idx];
    if (!stage) return `checkpoints[${i}]: 승인이 파이프라인 단계 수(${DEFAULT_PIPELINE.length})보다 많다`;
    if (c.stage !== stage.id) return `checkpoints[${i}].stage가 '${c.stage}'인데 승인 순서상 '${stage.id}' 차례다`;
    const wantWf = stage.kind === "workflow" ? stage.workflowId : null;
    if (c.workflow_id !== wantWf) {
      return `checkpoints[${i}].workflow_id가 '${String(c.workflow_id)}'인데 단계 '${stage.id}'는 ${wantWf === null ? "workflow 단계가 아니다" : `'${wantWf}'다`}`;
    }
    if (c.decision === "approved") idx++;
    else if (c.decision === "killed") killedAt = i;
  }
  if (killedAt >= 0 && s.status !== "killed") return `kill 영수증이 있는데 status가 '${s.status}'다`;
  if (s.status === "killed" && killedAt < 0) return "status가 killed인데 kill 영수증이 없다 (폐기 근거 소실)";
  if (idx !== s.current_index) return `current_index(${s.current_index})가 승인 이력 replay 결과(${idx})와 다르다`;
  const stage = DEFAULT_PIPELINE[s.current_index];
  const wantWf = stage === undefined ? undefined : stage.kind === "workflow" ? stage.workflowId : null;
  if (s.pending && s.pending.workflow_id !== wantWf) {
    return `pending.workflow_id가 '${String(s.pending.workflow_id)}'인데 현 단계는 ${wantWf === null ? "workflow 단계가 아니다" : `'${String(wantWf)}'다`}`;
  }
  if (s.last_failure) {
    if (s.last_failure.stage !== stage?.id) return `last_failure.stage가 '${s.last_failure.stage}'인데 현 단계는 '${stage?.id ?? "(범위 밖)"}'다`;
    if (s.last_failure.workflow_id !== wantWf) return `last_failure.workflow_id가 현 단계와 다르다`;
  }
  return null;
}

/**
 * semantic 검증 — parse 성공 후의 위반은 **전부 unreadable**이다(바이트 불변 · exit 2).
 * 여기 있는 규칙 하나하나가 "그 모양의 state가 관측됐을 때 무엇을 못 하게 하는가"다:
 * `awaiting_approval`+`pending:null`은 승인 없이 전진, 가짜 12-hex는 위조 승인, `artifacts:[]`는
 * 아무것도 검증하지 않는 승인, 경로 `..`는 프로젝트 밖 파일 결박.
 */
function stateProblem(raw: unknown, expectProject: string): string | null {
  if (typeof raw !== "object" || raw === null) return "최상위가 객체가 아니다";
  const s = raw as Record<string, unknown>;
  if (s.schema !== PIPELINE_SCHEMA) return `schema가 ${PIPELINE_SCHEMA}가 아니다 (${String(s.schema)})`;
  if (s.pipeline_version !== PIPELINE_VERSION) {
    return `pipeline_version 불일치 (기록 ${String(s.pipeline_version)} · 현재 ${PIPELINE_VERSION}) — 'harness pipeline restart --project <name>'으로 새로 시작하거나 이 파일을 복원하라`;
  }
  if (s.pipeline_id !== PIPELINE_ID) return `pipeline_id가 '${PIPELINE_ID}'가 아니다 (${String(s.pipeline_id)})`;
  if (s.project !== expectProject) return `project가 디렉터리 이름과 다르다 (기록 ${String(s.project)} · 경로 ${expectProject}) — 복사·오배치된 state`;
  if (!isSafeInt(s.current_index) || (s.current_index as number) > DEFAULT_PIPELINE.length) {
    return `current_index가 [0,${DEFAULT_PIPELINE.length}] 범위의 정수가 아니다 (${String(s.current_index)})`;
  }
  const statuses: PipelineStatus[] = ["awaiting_run", "awaiting_approval", "completed", "killed"];
  if (!statuses.includes(s.status as PipelineStatus)) return `status가 enum이 아니다 (${String(s.status)})`;
  if (typeof s.started_at !== "string" || typeof s.updated_at !== "string") return "started_at/updated_at이 문자열이 아니다";
  // [B-57] provider는 선택 필드다 — 옛 state(필드 없음)를 거부하지 않는다(하위 호환).
  if (s.provider !== undefined && typeof s.provider !== "string") return "provider가 문자열이 아니다";

  // awaiting_approval ⟺ pending≠null (**양방향**). 한쪽만 보면 "대기인데 확인할 것이 없다"거나
  // "확인 대기가 아닌데 승인 가능한 pending이 있다"가 둘 다 통과한다.
  const hasPending = s.pending !== null && s.pending !== undefined;
  if ((s.status === "awaiting_approval") !== hasPending) {
    return `awaiting_approval ⟺ pending≠null 위반 (status=${String(s.status)} · pending=${hasPending ? "있음" : "null"})`;
  }
  if (hasPending) {
    const p = receiptProblem("pending", s.pending, false);
    if (p) return p;
    const stage = DEFAULT_PIPELINE[s.current_index as number];
    if (!stage || (s.pending as PipelinePending).stage !== stage.id) {
      return `pending.stage가 current_index의 단계와 다르다 (${String((s.pending as PipelinePending).stage)} ≠ ${stage?.id ?? "(범위 밖)"})`;
    }
  }
  if (s.status === "completed" && s.current_index !== DEFAULT_PIPELINE.length) {
    return `completed인데 current_index가 마지막을 넘지 않았다 (${String(s.current_index)})`;
  }
  if (s.status !== "completed" && s.current_index === DEFAULT_PIPELINE.length) {
    return `current_index가 끝인데 status가 completed가 아니다 (${String(s.status)})`;
  }
  if (s.last_failure !== null && s.last_failure !== undefined) {
    if (typeof s.last_failure !== "object") return "last_failure가 객체도 null도 아니다";
    const f = s.last_failure as Record<string, unknown>;
    if (typeof f.stage !== "string" || !DEFAULT_PIPELINE.some((x) => x.id === f.stage)) return "last_failure.stage가 단계가 아니다";
    if (!(typeof f.workflow_id === "string" || f.workflow_id === null)) return "last_failure.workflow_id 형태 오류";
    if (typeof f.at !== "string") return "last_failure.at이 문자열이 아니다";
    const ap = artifactsProblem("last_failure(written)", f.written, { allowEmpty: true });
    if (ap) return ap;
  }
  if (!Array.isArray(s.checkpoints)) return "checkpoints가 배열이 아니다";
  const decisions: PipelineDecision[] = ["approved", "rejected", "killed"];
  for (const [i, c] of (s.checkpoints as unknown[]).entries()) {
    const label = `checkpoints[${i}]`;
    const e = c as Record<string, unknown>;
    if (typeof e !== "object" || e === null) return `${label}가 객체가 아니다`;
    if (!decisions.includes(e.decision as PipelineDecision)) return `${label}.decision이 enum이 아니다 (${String(e.decision)})`;
    if (typeof e.decided_at !== "string") return `${label}.decided_at이 문자열이 아니다`;
    if (!(typeof e.note === "string" || e.note === null)) return `${label}.note 형태 오류`;
    const p = receiptProblem(label, c, e.decision === "killed");
    if (p) return p;
  }
  // 형식이 다 맞은 뒤에 **의미**를 본다: index는 영수증이 만든 것이어야 한다(A-1).
  return replayProblem(raw as PipelineState);
}

/** 지정 절대경로의 pipeline_state.json을 읽는다 (부재/손상/정상 구분). 손상은 침묵이 아니라 fail closed다. */
export function readPipelineStateAt(abs: string): PipelineStateRead {
  if (!existsSync(abs)) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return { kind: "unreadable", path: abs, detail: (err as Error).message };
  }
  // 경로 계약: <projectRoot>/outputs/pipeline_state.json → 프로젝트 이름은 경로가 말한다.
  const expectProject = basename(dirname(dirname(abs)));
  const problem = stateProblem(raw, expectProject);
  if (problem) return { kind: "unreadable", path: abs, detail: problem };
  return { kind: "ok", state: raw as PipelineState };
}

/** `<projectRoot>` 절대경로 → state 파일 절대경로. */
export function pipelineStatePath(projectRoot: string): string {
  return join(projectRoot, PIPELINE_STATE_REL);
}

/** workspace의 projects/<P> 기준으로 읽는다. */
export function readPipelineState(project: string): PipelineStateRead {
  return readPipelineStateAt(pipelineStatePath(projectPaths(project).root));
}

// ── 단계 조회 ───────────────────────────────────────────────────

export function stageAt(index: number): PipelineStage | undefined {
  return DEFAULT_PIPELINE[index];
}

export function currentStage(state: PipelineState): PipelineStage | undefined {
  return DEFAULT_PIPELINE[state.current_index];
}

/**
 * 파이프라인이 가리키는 workflow가 registry에 실제로 있는지(§3.5 — 로드 시 대조).
 * 어긋나면 첫 모델 호출 전에 멈춘다: registry에서 workflow 이름이 바뀌면 파이프라인은 그 순간
 * "존재하지 않는 단계를 돌리려는" 상태가 되고, 그것을 런타임 throw로 발견하면 이미 state를 만든 뒤다.
 */
export function pipelineWorkflowProblem(workflowIds: string[]): string | null {
  for (const st of DEFAULT_PIPELINE) {
    if (st.kind === "workflow" && !workflowIds.includes(st.workflowId)) {
      return `파이프라인 단계 '${st.id}'의 workflow '${st.workflowId}'가 registry에 없다 ('harness list'로 확인)`;
    }
  }
  return null;
}

// ── 원자 쓰기 ───────────────────────────────────────────────────

/** temp+rename 원자 쓰기. mutation당 **1회**만 부른다(부분 상태를 관측할 창을 만들지 않는다). */
export function writePipelineState(projectRoot: string, state: PipelineState): void {
  const abs = pipelineStatePath(projectRoot);
  const tmp = `${abs}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, abs);
}

export function newPipelineState(project: string, at: string, provider?: string): PipelineState {
  return {
    schema: PIPELINE_SCHEMA,
    pipeline_version: PIPELINE_VERSION,
    pipeline_id: PIPELINE_ID,
    project,
    ...(provider === undefined ? {} : { provider }),
    current_index: 0,
    status: "awaiting_run",
    pending: null,
    last_failure: null,
    checkpoints: [],
    started_at: at,
    updated_at: at,
  };
}

// ── lock (O_EXCL) + lease ───────────────────────────────────────

export interface LockInfo {
  pid: number;
  nonce: string;
  at: string;
}

/** lock 파일 내용. 없거나 형태가 깨졌으면 null (형태 오류를 "내 lock"으로 오인하지 않는다). */
export function readLock(projectRoot: string): LockInfo | null {
  const abs = join(projectRoot, PIPELINE_LOCK_REL);
  if (!existsSync(abs)) return null;
  try {
    const v = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    if (!isSafeInt(v.pid) || typeof v.nonce !== "string" || !HEX16.test(v.nonce) || typeof v.at !== "string") return null;
    return { pid: v.pid as number, nonce: v.nonce, at: v.at };
  } catch {
    return null;
  }
}

/**
 * O_EXCL(`flag:"wx"`)로 lock을 만든다 — 이미 있으면 실패다. **비공개다**(Codex A-3):
 * export하면 임의 호출자가 nonce를 받아 lease를 만들 수 있고, 그러면 "실행은 파이프라인 연산
 * 안에서만"이라는 문장이 거짓이 된다. 밖에서 쓰는 것은 `lockPipeline` 하나다.
 */
function acquireLockRaw(projectRoot: string, now: () => string): { ok: true; nonce: string; release: () => void } | { ok: false; message: string } {
  const abs = join(projectRoot, PIPELINE_LOCK_REL);
  const nonce = randomBytes(8).toString("hex"); // 16-hex
  try {
    writeFileSync(abs, JSON.stringify({ pid: process.pid, nonce, at: now() }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  } catch {
    const held = readLock(projectRoot);
    return {
      ok: false,
      message:
        `pipeline_locked: 다른 pipeline 명령이 이 프로젝트를 쥐고 있습니다 (${abs})` +
        (held ? ` — owner pid ${held.pid} · 획득 ${held.at}` : " — lock 내용을 읽을 수 없습니다") +
        `\nowner가 끝나기를 기다리거나, 죽은 owner면 'harness pipeline unlock'으로 회수하세요 (살아 있는 owner의 lock은 회수하지 않습니다).`,
    };
  }
  return {
    ok: true,
    nonce,
    release: () => {
      // **내 lock만** 지운다: unlock이 회수한 뒤 새 owner가 생겼다면 그 lock을 지워선 안 된다.
      if (readLock(projectRoot)?.nonce !== nonce) return;
      try {
        unlinkSync(abs);
      } catch {
        /* 이미 없어졌다 — 회수 목적은 달성됐다 */
      }
    },
  };
}

/**
 * **불투명 lease.** 값이 아니라 **신원**이다: 아래 `LEASE_NONCE`에 등록된 객체만 통과한다.
 * 그래서 lock 파일에서 nonce 문자열을 읽어도 lease를 만들 수 없다(예전 판의 구멍 — Codex A-3).
 * `stage`는 표시·디버깅용이며 그것만으로는 아무 권한도 없다.
 */
export interface PipelineLease {
  readonly stage: string;
}

/**
 * lease → 그것을 발행한 lock의 nonce. **이 모듈만** 넣는다(발행 기록 그 자체).
 * `runStage` 호출이 끝나면 삭제하므로, 빼돌린 lease를 나중에 다시 쓸 수 없다.
 */
const LEASE_NONCE = new WeakMap<PipelineLease, string>();

/**
 * lease 검증 — **세 가지를 함께** 결박한다(§2.4 + A-3):
 *  ⓐ 이 모듈이 **발행했고 아직 유효한** lease 객체다(WeakMap 신원 — 문자열 위조 불가),
 *  ⓑ 그 lease를 낸 lock을 지금도 쥐고 있다(lock 파일 nonce 일치 — 중간에 회수됐으면 무효),
 *  ⓒ 상태가 `awaiting_run`이고 그 단계의 workflow가 **바로 이 workflowId**다.
 *
 * 정직한 한계: 같은 프로세스의 코드는 `lockPipeline(...).runStage(...)`를 직접 부를 수 있다 —
 * 그러나 그것이 곧 "lock을 쥐고 현 단계 하나를 돌리는" 그 연산이다. 열리는 것은 그 연산뿐이고
 * pending 생략·타 단계·drift 생략은 lease로도 열리지 않는다.
 */
export function leaseAllowsRun(read: PipelineStateRead, projectRoot: string, workflowId: string, lease?: PipelineLease): boolean {
  if (!lease) return false;
  const nonce = LEASE_NONCE.get(lease);
  if (nonce === undefined) return false; // 발행되지 않았거나 이미 만료된 lease
  if (read.kind !== "ok") return false; // 손상·부재 state에서는 lease가 아무것도 열지 않는다
  const st = read.state;
  if (st.status !== "awaiting_run") return false;
  const stage = currentStage(st);
  if (!stage || stage.kind !== "workflow" || stage.workflowId !== workflowId) return false;
  return readLock(projectRoot)?.nonce === nonce;
}

/** lock을 쥔 동안의 파이프라인 조작면. `read`는 **lock 획득 후 재독**한 것이다(A-7). */
export interface LockedPipeline {
  read: PipelineStateRead;
  /**
   * **현 단계 workflow 하나**를 lease 아래에서 돌린다. lease는 이 호출 동안만 살아 있고,
   * 발행 조건(현 단계 workflow · awaiting_run)을 스스로 확인한다 — 조건이 아니면 발행하지 않는다.
   */
  runStage<R>(workflowId: string, run: (lease: PipelineLease) => Promise<R>): Promise<R>;
  release(): void;
}

/**
 * [Codex A-3] mutating 파이프라인 연산의 **유일한 진입점**: lock 획득 → (재독) → 현 단계 실행 →
 * 해제. nonce는 이 함수 밖으로 나가지 않고, lease는 `runStage` 콜백 안에서만 유효하다.
 *
 * `status`·`unlock`은 이것을 쓰지 않는다(lock 없이 동작한다 — 진행 중 owner의 상태를 못 보면 사람은
 * owner를 죽이는 것 말고 할 수 있는 일이 없고, 죽은 lock 회수가 그 lock을 기다리는 것은 교착이다).
 */
export function lockPipeline(projectRoot: string, now: () => string): { ok: true; locked: LockedPipeline } | { ok: false; message: string } {
  const lock = acquireLockRaw(projectRoot, now);
  if (!lock.ok) return { ok: false, message: lock.message };
  const read = readPipelineStateAt(pipelineStatePath(projectRoot));
  return {
    ok: true,
    locked: {
      read,
      release: lock.release,
      async runStage<R>(workflowId: string, run: (lease: PipelineLease) => Promise<R>): Promise<R> {
        // 발행 조건은 **최신 state**로 본다: runStage 호출 전에 이 연산이 state를 썼을 수 있다
        // (파이프라인 생성 직후가 그 경우다).
        const cur = readPipelineStateAt(pipelineStatePath(projectRoot));
        if (cur.kind !== "ok") throw new PipelineError("pipeline_lease_denied", "pipeline_state를 읽을 수 없어 단계를 실행하지 않습니다");
        const stage = currentStage(cur.state);
        if (cur.state.status !== "awaiting_run" || !stage || stage.kind !== "workflow" || stage.workflowId !== workflowId) {
          throw new PipelineError(
            "pipeline_lease_denied",
            `현 단계가 '${stage?.id ?? "(범위 밖)"}'(${cur.state.status})이라 workflow '${workflowId}' 실행을 허가하지 않습니다`,
          );
        }
        const lease: PipelineLease = { stage: stage.id };
        LEASE_NONCE.set(lease, lock.nonce);
        try {
          return await run(lease);
        } finally {
          LEASE_NONCE.delete(lease); // 빼돌린 lease를 나중에 재사용할 수 없다
        }
      },
    },
  };
}

// ── manifest · seed (§4.4 · §5) ─────────────────────────────────

export interface ManifestSource {
  agent_id: string;
  path: string; // 프로젝트 상대경로
  /**
   * 이 산출물에서 seed 한 줄을 뽑을지. 기본 true.
   * 사이드카(`docs/tokens.json` 같은 비-판단 파일)는 false — 판단 문서가 아니므로 요약할 것이 없고,
   * 억지로 넣으면 "(Main Judgment 없음)"이 다음 단계 프롬프트에 실린다.
   */
  seed?: boolean;
}

/**
 * 각 산출물을 **한 번 읽은 buffer**에서 size·sha256·seed 한 줄을 함께 뽑는다 — 검증한 바이트와
 * seed가 갈라질 창이 없다(A-4). 파일 부재는 fail closed(`pipeline_artifact_missing`): 유령 경로
 * 영수증을 만들면 그 뒤의 모든 digest 대조가 무의미해진다.
 *
 * @param skipMissing kill 영수증 전용 — 폐기 기록을 남기는 것이 파일 존재보다 중요하고, 그 영수증은
 *   아무 소비자도 열지 않는다. 승인 경로에서는 쓰지 않는다.
 */
export function buildManifest(
  projectRoot: string,
  sources: ManifestSource[],
  opts: { skipMissing?: boolean } = {},
): { artifacts: ArtifactEntry[]; seeds: SeedEntry[] } {
  const artifacts: ArtifactEntry[] = [];
  const seeds: SeedEntry[] = [];
  const seenPath = new Set<string>();
  for (const src of sources) {
    if (!safeRelPath(src.path)) throw new PipelineError("pipeline_artifact_path_rejected", `영수증에 담을 수 없는 경로: ${src.path}`);
    if (seenPath.has(src.path)) continue; // 같은 경로는 한 번만 (path 유일 semantic 규칙)
    // [A-9] 표기가 맞아도 **실체가 루트 밖**이면 담지 않는다 (symlink는 realpath로 판정).
    const contain = containmentProblem(projectRoot, src.path);
    if (contain) throw new PipelineError("pipeline_artifact_path_rejected", contain);
    const abs = join(projectRoot, src.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      if (opts.skipMissing) continue;
      throw new PipelineError("pipeline_artifact_missing", `산출물이 없습니다: ${src.path} (유령 경로로 영수증을 만들지 않습니다)`);
    }
    if (!st.isFile()) {
      if (opts.skipMissing) continue;
      throw new PipelineError("pipeline_artifact_missing", `산출물이 일반 파일이 아닙니다: ${src.path}`);
    }
    const bytes = readFileSync(abs);
    seenPath.add(src.path);
    artifacts.push({ path: src.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    if (src.seed !== false) seeds.push({ agent_id: src.agent_id, line: `${src.agent_id}: ${extractMainJudgment(bytes.toString("utf8"))}` });
  }
  return { artifacts, seeds };
}

/**
 * 경로만 필요한 자리(실패 attempt의 `written` 영수증)에서 digest를 낸다. seed는 쓰지 않으므로
 * agent_id를 빈 문자열로 둔다 — `written`은 승인 대상이 아니라 "무엇이 덮였나"의 기록이다.
 */
export function digestArtifacts(projectRoot: string, relPaths: string[], opts: { skipMissing?: boolean } = {}): ArtifactEntry[] {
  return buildManifest(
    projectRoot,
    relPaths.map((path) => ({ agent_id: "", path, seed: false })),
    opts,
  ).artifacts;
}

/**
 * 완료된 run의 산출물 목록 — **최종 `completed_steps` 기반**이다(savedFiles 아님).
 * resume한 run의 savedFiles에는 앞 attempt에서 이미 쓴 문서가 빠져 있어, 그것으로 manifest를 만들면
 * 승인 대상에서 앞 단계 문서가 조용히 사라진다.
 */
export function runStateSources(state: RunState): ManifestSource[] {
  const registry = loadAgentRegistry();
  const out: ManifestSource[] = [];
  for (const id of state.completed_steps ?? []) {
    const agent = findAgent(registry, id);
    if (agent) {
      out.push({ agent_id: id, path: agent.default_output });
      // [Codex A-2] **선언된 사이드카 산출물도 결박한다**(design agent의 `docs/tokens.json`).
      // 예전엔 `default_output`만 모아서, 작업 지시문이 "구현은 tokens.json을 따르라"고 안내하는
      // 그 파일이 어떤 checkpoint에도 없었다 = 승인 후 교체가 탐지되지 않았다.
      // 부재는 fail closed다(`buildManifest`) — 사이드카를 못 낸 단계는 승인 대기로 넘어가지 않는다.
      if (agent.token_output) out.push({ agent_id: id, path: agent.token_output, seed: false });
      continue;
    }
    // 동적 분화된 하위 에이전트(spawn_<id>)는 registry에 없다 — run 기록에서 경로를 찾는다.
    const sp = (state.spawned_agents ?? []).find((s) => `spawn_${s.id}` === id && s.output);
    if (sp?.output) out.push({ agent_id: id, path: sp.output });
  }
  // [C-126/A-3] **리서치 영수증 결박.** 승인 대상은 "어떤 근거에서 나온 문서인가"까지다 —
  // 문서 바이트만 결박하면 승인 후 근거 파일을 바꿔치기해도 탐지되지 않는다.
  //
  // 담는 것: **마지막 성공 attempt의 receipt**(write-once)와 그것이 참조한 **content-addressed raw**.
  // 담지 않는 것: `outputs/research/evidence.jsonl`. append-only 인덱스라 결박하면 승인 후 정당한
  // append 하나가 전수 검증(approve의 effectiveDigests · completed/fresh-run 게이트)에서 **전부
  // drift**가 된다 — 권위는 receipt+raw에 있고 jsonl은 사람용 비권위 인덱스다(§9-15 기각 대안).
  //
  // seed:false인 이유: 판단 문서가 아니므로 요약할 것이 없다(억지로 넣으면 "(Main Judgment 없음)"이
  // 다음 단계 프롬프트에 실린다 — design의 tokens.json 사이드카와 같은 규율).
  const lastResearch = [...(state.research?.attempts ?? [])].reverse().find((a) => a.mode !== null && a.receipt_path);
  if (lastResearch) {
    out.push({ agent_id: "research", path: lastResearch.receipt_path, seed: false });
    for (const raw of lastResearch.raw_paths ?? []) out.push({ agent_id: "research", path: raw, seed: false });
  }
  return out;
}

/** 항목당 상한(초과 시 자르지 않고 통째로 경로 참조로 대체 — silent truncation 금지). */
export const SEED_MAX_CHARS = 1_200;
/** 방어 개수 상한. */
export const SEED_MAX_ITEMS = 24;
/** 총 byteLength 상한. 이 자릿수는 v1이 이미 싣는 아이디어 전문과 같다. */
export const SEED_MAX_BYTES = 16_384;

function seedRef(agentId: string): string {
  const path = findAgent(loadAgentRegistry(), agentId)?.default_output ?? "승인 영수증(pipeline_state.json)";
  return `${agentId}: (요약 상한 초과 — ${path} 참조)`;
}

/**
 * **승인된 checkpoint에 저장된 seeds만** 모아 다음 단계 입력으로 만든다 — 문서 파일을 다시 읽지 않는다.
 * durable이라 크래시에도 남고, "검증한 바이트 ≠ 소비한 바이트"라는 창이 구조적으로 없다.
 * 같은 agent_id는 뒤 단계가 승계(최신 판단), 자리는 처음 등장 순서를 유지한다.
 */
export function seedFindingsFrom(state: PipelineState): string[] {
  const byAgent = new Map<string, string>();
  for (const c of state.checkpoints) {
    if (c.decision !== "approved") continue; // 거부·폐기 영수증은 입력이 아니다
    for (const s of c.seeds) byAgent.set(s.agent_id, s.line);
  }
  // [Codex A-8] 상한을 **코드가 실제로 지킨다.** 예전 판은 24개 이후에도 항목(경로 참조)을 계속
  // 밀어넣고, 총량 초과 후 대체한 참조의 크기를 다시 재지 않았다 — 그래서 "≤24개 · ≤16KB"는
  // 검증되지 않은 문장이었다(테스트도 `+200` 여유를 허용해 그 사실을 덮고 있었다).
  // 지금 규칙: 들어갈 수 있는 만큼만 넣고, 남은 것은 **bounded marker 한 줄**로 합친다
  // (조용히 버리지 않는다 — 몇 건이 어디에 있는지 말한다).
  const entries = [...byAgent.entries()];
  const out: string[] = [];
  let bytes = 0;
  const fits = (s: string): boolean => out.length + 1 <= SEED_MAX_ITEMS && bytes + Buffer.byteLength(s, "utf8") + 1 <= SEED_MAX_BYTES;
  for (let i = 0; i < entries.length; i++) {
    const [agentId, line] = entries[i];
    // 항목 상한 초과는 **자르지 않고** 통째로 경로 참조로 대체한다(silent truncation 금지).
    const item = line.length > SEED_MAX_CHARS ? seedRef(agentId) : line;
    if (fits(item)) {
      out.push(item);
      bytes += Buffer.byteLength(item, "utf8") + 1;
      continue;
    }
    // 못 들어간다 → 남은 전부를 marker 하나로. marker 자리가 없으면 마지막 항목을 비운다.
    // 건수는 **자리를 비운 뒤** 다시 센다: out에 실린 것이 곧 표현된 항목이므로
    // `entries.length - out.length`가 정확한 잔여 수다(pop 전에 세면 그만큼 어긋난다).
    const mk = (n: number): string => `(seed 상한 — 남은 ${n}건은 승인 영수증 ${PIPELINE_STATE_REL}에서 확인하라)`;
    let marker = mk(entries.length - out.length);
    while (out.length > 0 && !fits(marker)) {
      bytes -= Buffer.byteLength(out.pop() as string, "utf8") + 1;
      marker = mk(entries.length - out.length);
    }
    if (fits(marker)) out.push(marker);
    break;
  }
  return out;
}

// ── drift (승인 바이트 결박) ────────────────────────────────────

/** 경로별 **최신 승인 checkpoint**의 digest. 뒤 단계가 같은 경로를 다시 승인하면 그것이 기준이다. */
export function approvedDigests(state: PipelineState): Map<string, ArtifactEntry> {
  const m = new Map<string, ArtifactEntry>();
  for (const c of state.checkpoints) {
    if (c.decision !== "approved") continue;
    for (const a of c.artifacts) m.set(a.path, a);
  }
  return m;
}

/**
 * [Codex A-6] 승인 digest에 **이번에 승인하려는 pending의 것을 얹은** 최종 기대치.
 *
 * pending이 같은 경로를 다시 담고 있으면(mvp-planning이 `docs/02_PRD.md`를 다시 쓰는 것처럼)
 * 그 경로의 기준은 pending 쪽이다 — 그러지 않으면 정당한 재작성이 전부 drift로 잡힌다.
 * 나머지 경로는 앞 단계 승인 바이트 그대로여야 한다: 그래서 "마지막 단계만 승인해 완료 영수증을
 * 받아내고 앞 단계 문서는 바꿔치기"가 막힌다.
 */
export function effectiveDigests(state: PipelineState, latest: readonly ArtifactEntry[] = []): Map<string, ArtifactEntry> {
  const m = approvedDigests(state);
  for (const a of latest) m.set(a.path, a);
  return m;
}

/**
 * 기대 digest와 현재 바이트를 대조한다. 첫 불일치의 사람이 읽는 이유를 반환(일치하면 null).
 * **이 함수에 제외 규칙은 없다** — 제외는 resume 전용이고 호출자가 목록에서 빼서 넘긴다(§4.3).
 */
export function driftProblem(projectRoot: string, expected: Iterable<ArtifactEntry>): string | null {
  for (const a of expected) {
    // [A-9] 승인된 파일이 프로젝트 밖을 가리키게 바뀌었으면 그것은 **다른 파일**이다 — drift다.
    const contain = containmentProblem(projectRoot, a.path);
    if (contain) return contain;
    const abs = join(projectRoot, a.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return `승인된 산출물이 없어졌습니다: ${a.path}`;
    }
    if (!st.isFile()) return `승인된 산출물이 일반 파일이 아닙니다: ${a.path}`;
    const bytes = readFileSync(abs);
    if (bytes.length !== a.size || createHash("sha256").update(bytes).digest("hex") !== a.sha256) {
      return `승인된 바이트와 현재 파일이 다릅니다: ${a.path}`;
    }
  }
  return null;
}

// ── action별 집행 게이트 (§2.3) ─────────────────────────────────

export type PipelineAction = "run" | "task-prompt" | "handoff" | "plan-dag";

export type PipelineGateCode =
  | "pipeline_state_unreadable" // 문법/semantic/버전/id 재계산 실패 — fail closed
  | "pipeline_run_reserved" // 활성 파이프라인: workflow 실행은 pipeline next 전담
  | "pipeline_checkpoint_pending" // 체크포인트 대기 — approve|reject 먼저
  | "pipeline_stage_incomplete" // 아직 앞 단계 — 이 명령은 파이프라인 완료(또는 dev-handoff) 후
  | "pipeline_killed" // terminal killed — restart 또는 재평가 경로 안내
  | "pipeline_artifact_drift"; // 승인본과 현재 바이트 불일치

export type PipelineGateStatus = { ok: true } | { ok: false; code: PipelineGateCode; message: string };

/**
 * **소비자 5곳이 전부 이 함수 하나를 쓴다**(`run`·`runWorkflow` fresh 게이트·`task-prompt`·`handoff`·
 * `plan-dag`). 규칙이 다섯 벌이면 한쪽만 정직해진다 — 거부 메시지도 여기서 만들어 각 명령이 그대로
 * 출력한다(같은 상황 = 같은 안내).
 *
 * `run`이 활성 파이프라인에서 **전면 거부**인 것이 이 설계의 핵심이다: 상태별 허용을 두면
 * "승인 직후 awaiting_run에서 다음 단계를 직접 run"이 열려 단계 건너뛰기가 성립한다.
 * killed에서 `run`을 허용하는 것은 B-40 재평가 경로 보존이고(kill 잠금은 `ideaGateStatus`가 그대로
 * 집행한다), 나머지 action은 killed에서 전부 닫는다 — 그것이 두 잠금의 이음새다.
 *
 * @param projectRoot 프로젝트 루트 **절대경로**(drift 대조가 실제 파일을 읽는다). 설계 §2.3의
 *   시그니처는 `project: string`이지만, `plan-dag`은 아이디어 경로에서 되짚은 루트를 쓰고 그것이
 *   workspace 아래라는 보장이 없다 — 이름 대신 루트를 받는 것이 같은 판정을 더 정확히 표현한다
 *   (프로젝트 이름 대조는 `readPipelineStateAt`이 경로에서 파생해 이미 한다).
 */
export function pipelineGateStatus(read: PipelineStateRead, projectRoot: string, action: PipelineAction): PipelineGateStatus {
  if (read.kind === "unreadable") {
    return {
      ok: false,
      code: "pipeline_state_unreadable",
      message:
        `pipeline_state.json이 있지만 읽을 수 없습니다: ${read.path} (${read.detail}).\n` +
        `단계 승인 기록이 이 파일에 있어 덮어쓰지 않습니다 — 파일을 복원하거나, 검토 후 'harness pipeline restart --project <name>'으로 새로 시작하세요.`,
    };
  }
  if (read.kind === "absent") return { ok: true }; // 파이프라인 미사용 — 기존 사용법 무영향
  const st = read.state;
  const stage = currentStage(st);
  const active = st.status === "awaiting_run" || st.status === "awaiting_approval";

  if (action === "run") {
    // killed는 **열어둔다**: B-40 재평가 경로(kill 게이트가 있는 workflow의 새 run)가 잠금을 푸는
    // 유일한 통로이고, 그 잠금 자체는 `ideaGateStatus`가 집행한다.
    if (st.status === "killed") return { ok: true };
    if (!active) {
      // [Codex A-6] completed에서도 **승인 바이트가 그대로일 때만** 연다. 예전엔 무조건 ok였고,
      // 그래서 "승인 문서를 바꾼 뒤 새 run으로 그 위에 계속 쌓기"가 게이트 없이 가능했다
      // (하류 소비자만 막혀 있었다). 탈출구는 문서 복원 또는 restart다.
      const p = driftProblem(projectRoot, approvedDigests(st).values());
      return p === null ? { ok: true } : { ok: false, code: "pipeline_artifact_drift", message: driftMessage(p, st.project) };
    }
    return {
      ok: false,
      code: "pipeline_run_reserved",
      message:
        `pipeline_run_reserved: 이 프로젝트는 단계 체크포인트 파이프라인이 진행 중입니다 ` +
        `(단계 ${st.current_index + 1}/${DEFAULT_PIPELINE.length} '${stage?.id ?? "?"}' · ${st.status}).\n` +
        `workflow 실행은 'harness pipeline next --project ${st.project}'로 하세요 — 직접 run으로 단계를 건너뛸 수 없습니다.\n` +
        `상태 확인: harness pipeline status --project ${st.project}`,
    };
  }

  if (st.status === "killed") {
    return {
      ok: false,
      code: "pipeline_killed",
      message:
        `pipeline_killed: 이 파이프라인은 폐기 판정으로 종료됐습니다 — 폐기된 아이디어로 지시문·DAG·handoff를 만들지 않습니다.\n` +
        `[A-3] **순서가 있습니다**: 먼저 재평가를 직접 돌려 '진행' 판정을 받으세요 — 'harness run <kill 게이트 workflow> --project ${st.project}'.\n` +
        `그다음에 'harness pipeline restart --project ${st.project}'입니다. 순서를 바꾸면 restart가 'run_state_killed'로 거부됩니다(2단계 이상 폐기일 때).`,
    };
  }
  if (st.status === "awaiting_approval") {
    return {
      ok: false,
      code: "pipeline_checkpoint_pending",
      message:
        `pipeline_checkpoint_pending: '${st.pending?.stage}' 단계 산출물이 확인 대기 중입니다 ` +
        `(checkpoint ${st.pending?.checkpoint_id}).\n` +
        `문서를 확인한 뒤 승인하거나 되돌리세요: harness pipeline approve ${st.pending?.stage} --checkpoint ${st.pending?.checkpoint_id} --project ${st.project}`,
    };
  }
  // awaiting_run: 마지막 단계(dev-handoff)의 실행 대기만 예외적으로 task-prompt를 허용한다 —
  // 그 단계가 하는 일 자체가 지시문 생성이고, 그 산출물이 다음 checkpoint가 된다.
  if (st.status === "awaiting_run" && !(action === "task-prompt" && stage?.id === "dev-handoff")) {
    return {
      ok: false,
      code: "pipeline_stage_incomplete",
      message:
        `pipeline_stage_incomplete: 아직 '${stage?.id ?? "?"}' 단계(${st.current_index + 1}/${DEFAULT_PIPELINE.length})입니다 — ` +
        `이 명령은 파이프라인 완료 후에 씁니다.\n다음: harness pipeline next --project ${st.project}`,
    };
  }

  // completed(또는 dev-handoff 실행 대기) — 승인 바이트가 그대로인지 **전수** 대조한다.
  const problem = driftProblem(projectRoot, approvedDigests(st).values());
  if (problem) return { ok: false, code: "pipeline_artifact_drift", message: driftMessage(problem, st.project) };
  return { ok: true };
}

/** drift 거부 문장은 한 곳에서 만든다 (같은 상황 = 같은 안내). */
function driftMessage(problem: string, project: string): string {
  return (
    `pipeline_artifact_drift: ${problem}\n` +
    `승인 후 문서가 바뀌었습니다 — 사람이 확인한 내용이 아니므로 진행하지 않습니다.\n` +
    `  ⓐ 그 파일을 승인 시점 내용으로 되돌리면 이어집니다 — **하네스는 내용을 보관하지 않습니다**(영수증은 path·size·sha256뿐). ` +
    `git·백업 등 바깥에서 되돌려야 합니다.\n` +
    `  ⓑ [B-54] 'harness pipeline restart --project ${project}'는 **진행 중 파이프라인에서 거부됩니다**(pipeline_active) — ` +
    `완료·폐기 상태에서만 열립니다. 실행해 확인했고, 그래서 더는 무조건 권하지 않습니다.`
  );
}

/** 프로젝트 이름으로 게이트를 묻는 편의 함수 (workspace의 projects/<P> 기준). */
export function projectPipelineGate(project: string, action: PipelineAction): PipelineGateStatus {
  const root = projectPaths(project).root;
  return pipelineGateStatus(readPipelineStateAt(pipelineStatePath(root)), root, action);
}
