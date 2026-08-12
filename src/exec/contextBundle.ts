/**
 * V3 M6 T3·T4 — **durable state의 순수 파생물**(부수 효과 0): task 하나의 context bundle과
 * coordinator 교체 등가성 다이제스트. 둘 다 state를 읽기만 하고 어디에도 저장하지 않는다.
 *
 * coordinator를 교체해도 작업이 이어지려면, 새 coordinator가 "이 task가 무엇을 알아야 하는가"를
 * **durable state만 보고** 되만들 수 있어야 한다. 이 모듈이 그 함수다.
 *
 * 계약:
 * - **입력은 durable state뿐이다.** 프로세스 메모리·시계·환경·파일 시스템을 읽지 않는다 → 같은 revision
 *   이면 **언제 어느 프로세스에서 부르든 같은 바이트**다(결정성 테스트가 이것을 고정한다).
 * - **새 저장 포맷을 만들지 않는다.** 파생물은 SoR이 아니다 — 이 문자열은 어디에도 durable하게 쓰이지
 *   않고, state를 바꾸지도 않는다(`rebuildSnapshot`과 같은 지위다).
 * - **bounded summary와 검증된 포인터만 옮긴다**(로드맵 §3.2). raw artifact 본문·raw transcript·
 *   메시지 원문·토큰 계측값은 담지 않는다. 담는 것은 state에 이미 bounded로 들어 있는 값뿐이다.
 * - **정렬은 고정이다.** 배열은 전부 state의 durable 순서 또는 id 오름차순으로 낸다 — 삽입 순서가
 *   바이트를 흔들면 등가성 증명(M6 ③)이 공허해진다.
 */
import { createHash } from "node:crypto";
import { OrchestrationError } from "./orchestrationTypes.js";
import type { MessageIndexEntry, OrchestrationRunState, OrchestrationTask } from "./orchestrationTypes.js";

/** taskId 오름차순 비교(문자열 사전순 — locale에 의존하지 않는다). */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireTask(state: OrchestrationRunState, taskId: string): OrchestrationTask {
  const t = state.tasks.find((x) => x.taskId === taskId);
  if (!t) throw new OrchestrationError("unknown_task", `미상 task: ${taskId}`);
  return t;
}

/** artifact 포인터 한 줄 — 경로·revision·role·producer·sha256. **본문은 담지 않는다**. */
function pointerLine(p: { path: string; revision: number; role: string; producerTaskId: string; sha256: string }): string {
  return `- ${p.path}@${p.revision} (${p.role}) producer=${p.producerTaskId} sha256=${p.sha256}`;
}

/** 미확인 inbox 항목 한 줄. summary가 없는 타입(§5.2)은 `(no summary)`로 정직하게 적는다. */
function inboxLine(m: MessageIndexEntry): string {
  return `- ${m.messageId} type=${m.type} from=${m.taskId}/${m.sender} summary=${m.summary ?? "(no summary)"}`;
}

/**
 * **durable state에서 task 하나의 실행 맥락을 재구성한다.**
 *
 * 담는 것: task 스펙 · `dependsOn` 각 task의 상태와 `resultSummary` · artifact 포인터(sha256) ·
 * 미확인 inbox route · child 진행 상황. 이 다섯은 전부 "다음에 무엇을 해야 하는가"를 정하는 입력이고,
 * 전부 state에 bounded로 이미 들어 있다.
 *
 * 담지 않는 것: 승인 manifest 전문(그건 `rebuildSnapshot`이 내는 run 수준 파생물이다) · 예산 잔량
 * (turn마다 변해서 bundle을 시간 의존으로 만든다) · 시각 필드 · 어떤 종류의 raw 본문.
 */
export function buildContextBundle(state: OrchestrationRunState, taskId: string): string {
  const task = requireTask(state, taskId);
  const lines: string[] = [];

  lines.push(`# Context Bundle — ${task.taskId}`);
  lines.push("");
  lines.push("> durable state에서 결정론적으로 재구성한 파생물이다. 저장되지 않으며 state를 바꾸지 않는다.");
  lines.push("");
  lines.push(`- run: ${state.runId}`);
  lines.push(`- milestone: ${state.milestoneId}`);
  lines.push(`- revision: ${state.revision}`);
  lines.push("");

  lines.push("## Task");
  lines.push(`- taskId: ${task.taskId}`);
  lines.push(`- role: ${task.roleId}`);
  lines.push(`- state: ${task.state}`);
  lines.push(`- depth: ${task.depth}`);
  lines.push(`- parent: ${task.parentTaskId ?? "(none)"}`);
  lines.push(`- title: ${task.title}`);
  lines.push(`- scope: ${task.scope}`);
  lines.push(`- ownership: ${task.ownership.length > 0 ? [...task.ownership].sort(byId).join(", ") : "(none)"}`);
  lines.push(
    `- resourceClasses: ${task.resourceClasses.length > 0 ? [...task.resourceClasses].sort(byId).join(", ") : "(none — 병렬 안전)"}`,
  );
  lines.push(`- attempt: ${task.execution.attemptNo}/${state.manifest.autopilotPolicy.maxTaskAttempts}`);
  lines.push(`- resultSummary: ${task.resultSummary ?? "(none)"}`);
  lines.push(`- blockerSummary: ${task.blockerSummary ?? "(none)"}`);
  lines.push("");

  // 의존 결과 — **이 task가 이어받아야 하는 것**이다. 원문이 아니라 bounded summary만 옮긴다.
  lines.push("## Dependencies");
  const deps = [...task.dependsOn].sort(byId);
  if (deps.length === 0) lines.push("- (none)");
  for (const d of deps) {
    const dep = state.tasks.find((t) => t.taskId === d);
    if (!dep) {
      // state가 참조 무결성을 보장하므로 도달하지 않는다 — 그래도 조용히 빠뜨리지 않는다.
      lines.push(`- ${d}: (unknown task)`);
      continue;
    }
    lines.push(`- ${dep.taskId} [${dep.state}] ${dep.resultSummary ?? "(no result yet)"}`);
  }
  lines.push("");

  // child 진행 — 위임한 task가 "지금 무엇을 기다리는가"를 안다.
  lines.push("## Children");
  const children = [...task.childTaskIds].sort(byId);
  if (children.length === 0) lines.push("- (none)");
  for (const c of children) {
    const child = state.tasks.find((t) => t.taskId === c);
    lines.push(child ? `- ${child.taskId} [${child.state}] ${child.resultSummary ?? "(no result yet)"}` : `- ${c}: (unknown task)`);
  }
  lines.push("");

  // 검증된 포인터만 — 본문은 workspace에 있고 kernel이 등록 시점 hash로 재확인한다.
  lines.push("## Artifacts");
  const refs = [...task.artifactRefs, ...deps.flatMap((d) => state.tasks.find((t) => t.taskId === d)?.artifactRefs ?? [])];
  const seen = new Set<string>();
  const pointers = refs
    .filter((r) => {
      const key = `${r.path}@${r.revision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => byId(`${a.path}@${a.revision}`, `${b.path}@${b.revision}`));
  if (pointers.length === 0) lines.push("- (none)");
  for (const p of pointers) lines.push(pointerLine(p));
  lines.push("");

  // 미확인 inbox — **아직 수령하지 않은 전달**이다. 교체된 coordinator가 이것을 놓치면 전달이 유실된다.
  lines.push("## Pending Inbox");
  const inbox = state.messages
    .filter((m) => m.routeToTaskId === task.taskId && m.acknowledgedAt === null)
    .sort((a, b) => byId(a.messageId, b.messageId));
  if (inbox.length === 0) lines.push("- (none)");
  for (const m of inbox) lines.push(inboxLine(m));
  lines.push("");

  return lines.join("\n");
}

// ── coordinator 교체 등가성 다이제스트 (M6 T4 — 완료 조건 ③) ────────────────

/** 교체 전후를 비교하는 세 해시. 시각·revision은 **들어가지 않는다**(아래 이유 참조). */
export interface SnapshotDigest {
  /** task 그래프의 모양: `[taskId, state, dependsOn, depth, parentTaskId]` taskId 오름차순. */
  graphHash: string;
  /** 중앙이 내린 결정: `[messageId, type, taskId, routeToTaskId, summary, bodySha256]` messageId 오름차순. */
  decisionHash: string;
  /** 검증된 산출물 포인터: `[path, revision, sha256]` artifactId 오름차순. */
  artifactHash: string;
}

function sha256(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

/**
 * **"coordinator를 교체해도 같다"를 사람 눈이 아니라 세 해시로 판정한다.**
 *
 * **시각 필드를 한 개도 넣지 않는다.** 넣으면 교체 전후가 구조적으로 절대 같을 수 없어 이 다이제스트가
 * 곧 공허한 체크가 된다(M5에서 그 부류로 A급을 세 번 맞았다). 같은 이유로 `revision`·`lastEventId`도
 * 넣지 않는다 — 그 둘은 "어떻게 여기 왔는가"이지 "지금 무엇인가"가 아니다. 진행 여부가 필요하면
 * 호출자가 revision을 따로 본다.
 *
 * 반대로 **상태·의존·경로·요약·본문 hash는 전부 들어간다** — 그래야 "같다"가 내용을 가진 주장이 된다.
 */
export function computeSnapshotDigest(state: OrchestrationRunState): SnapshotDigest {
  const graph = [...state.tasks]
    .sort((a, b) => byId(a.taskId, b.taskId))
    .map((t) => [t.taskId, t.state, [...t.dependsOn].sort(byId), t.depth, t.parentTaskId]);
  const decisions = [...state.messages]
    .sort((a, b) => byId(a.messageId, b.messageId))
    .map((m) => [m.messageId, m.type, m.taskId, m.routeToTaskId, m.summary, m.bodySha256]);
  const artifacts = [...state.artifacts]
    .sort((a, b) => byId(a.artifactId, b.artifactId))
    .map((a) => [a.path, a.revision, a.sha256]);
  return Object.freeze({
    graphHash: sha256(graph),
    decisionHash: sha256(decisions),
    artifactHash: sha256(artifacts),
  });
}
