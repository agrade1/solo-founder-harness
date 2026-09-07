import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, projectExists } from "./project.js";
import { extractMainJudgment } from "./validate.js";
import { readRunStateAt, type RunState } from "./runWorkflow.js";
import { DEFAULT_PIPELINE, approvedDigests, currentStage, driftProblem, pipelineStatePath, readPipelineStateAt } from "./pipeline.js";

/**
 * [B-62] **손상을 부재로 접지 않는다.** 예전 지역 리더는 `catch { return null }`이라 찢어진
 * `run_state.json`을 "아직 workflow 미실행"으로 적었다 — `B-40/A-4`가 `taskPrompt`에서 지운 바로
 * 그 리더가 여기 남아 있었다.
 *
 * 실측(2026-09-04): 40바이트로 잘린 state에서 summary가 durable 문서 `docs/CONTEXT_SUMMARY.md`에
 * *"아직 workflow 미실행 — `harness run <workflow> --project <name>` 실행"* 을 적었고, **그 명령은
 * `run_state_unreadable`로 거부된다**(실행 확인). 폐기 기록이 그 파일에 있을 수 있는데도 요약은
 * "실행한 적 없음"이라고 말한 것이다. 같은 파일의 pipeline_state는 이미 fail-closed로 다룬다.
 */
function readRunStateForSummary(project: string): { kind: "ok"; state: RunState } | { kind: "absent" } | { kind: "unreadable"; detail: string } {
  const read = readRunStateAt(join(projectPaths(project).outputs, "run_state.json"));
  return read.kind === "ok" ? { kind: "ok", state: read.state } : read.kind === "absent" ? { kind: "absent" } : { kind: "unreadable", detail: read.detail };
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

/**
 * [Codex A-5] **단계 체크포인트가 있으면 그것이 정본이다.**
 *
 * run_state가 `completed`라는 것은 "그 workflow가 끝났다"는 뜻일 뿐인데, 파이프라인이 그 산출물을
 * **확인 대기**로 잡고 있으면 "완료 — task-prompt로 진행"은 거짓 영수증이다(B-40이 killed에서
 * A급으로 잡은 것과 같은 부류: 같은 사실이 CLI에서는 대기, 요약에서는 완료로 적혔다).
 * 그래서 파이프라인 상태를 **먼저** 적고, 그것이 하류를 막고 있으면 그 사실을 말한다.
 */
function pipelineActions(project: string, root: string): string[] | null {
  const read = readPipelineStateAt(pipelineStatePath(root));
  if (read.kind === "absent") return null; // 파이프라인 미사용 — 기존 문구 그대로
  if (read.kind === "unreadable") {
    return [`**pipeline_state를 읽을 수 없다** (${read.detail}) — 복구하거나 \`harness pipeline restart --project ${project}\` 전까지 단계 진행이 막힌다.`];
  }
  const st = read.state;
  const stage = currentStage(st);
  const label = `${st.current_index + 1}/${DEFAULT_PIPELINE.length} '${stage?.id ?? "(완료)"}'`;
  switch (st.status) {
    case "awaiting_approval":
      return [
        `**단계 확인 대기** ${label} — 산출물을 확인하고 승인해야 다음 단계가 돈다 (checkpoint \`${st.pending?.checkpoint_id ?? "?"}\`).`,
        `승인: \`harness pipeline approve ${st.pending?.stage} --checkpoint ${st.pending?.checkpoint_id} --project ${project}\` · 되돌림: 같은 인자로 \`reject\`.`,
        "이 단계가 승인되기 전에는 `task-prompt`·`handoff`·`plan-dag`가 거부된다 (작업 지시문을 만들지 않는다).",
      ];
    case "awaiting_run":
      return [
        `**단계 실행 대기** ${label} — \`harness pipeline next --project ${project}\`.` +
          (st.last_failure ? ` (직전 실패 ${st.last_failure.stage} @ ${st.last_failure.at} — next가 이어서 돈다: run_state가 이 workflow의 failed면 resume, 아니면 fresh)` : ""),
      ];
    case "killed":
      return [
        `**파이프라인 폐기** — 지시문·DAG·handoff를 만들 수 없다.`,
        `[A-3] **순서가 있다**: 먼저 재평가 \`harness run <kill 게이트 workflow> --project ${project}\`로 '진행' 판정을 받고, ` +
          `**그다음** \`harness pipeline restart --project ${project}\`. 순서를 바꾸면 restart가 \`run_state_killed\`로 거부된다(2단계 이상 폐기일 때).`,
      ];
    case "completed": {
      const problem = driftProblem(root, approvedDigests(st).values());
      if (problem) {
        return [
          `**승인 후 문서가 바뀌었다** — ${problem}. 사람이 확인한 내용이 아니므로 \`task-prompt\`·\`handoff\`·\`plan-dag\`가 거부된다.`,
          `[B-54] 복구는 **그 파일의 승인 시점 바이트를 되돌리는 것 하나**다 — 하네스는 내용을 보관하지 않으므로(영수증은 path·size·sha256뿐) ` +
            `git·백업 등 바깥에서 되돌려야 한다. \`pipeline restart\`는 완료 상태에서만 열린다.`,
        ];
      }
      return [
        `파이프라인 4단계 전부 승인 완료 — \`harness task-prompt --project ${project}\` 또는 ` +
          `\`harness handoff --project ${project} --cwd <서비스 레포>\`로 개발 착수.`,
      ];
    }
  }
}

/**
 * 다음 작업을 run_state로부터 도출한다.
 * @param pipelineOwns 파이프라인이 다음 단계를 정하는 상태다 → run 완료를 "task-prompt로 진행"으로
 *   안내하지 않는다(그 안내는 승인 전에는 틀린 말이다 — Codex A-5).
 */
function nextActions(state: RunState | null, project: string, pipelineOwns = false): string[] {
  if (!state) {
    return ["아직 workflow 미실행 — `harness run <workflow> --project <name>` 실행."];
  }
  const actions: string[] = [];
  // status로 분기한다 (failed_agent 유무가 아니라): killed는 failed_agent가 없어서 예전 분기로는
  // "완료 — task-prompt로 진행"이 나왔다. 같은 run이 CLI에서는 폐기, 여기서는 완료가 되는 거짓 영수증이었다.
  // switch + never로 닫아 다음에 상태가 늘면 컴파일이 잡는다.
  switch (state.status) {
    case "killed": {
      const k = state.killed_by;
      actions.push(
        `**폐기 판정** — ${k?.decider ?? "게이트"}가 '${k?.decision ?? "폐기"}' 판정으로 ` +
          `\`${state.workflow_id}\`를 종료했다. 이 아이디어로는 작업 지시문·DAG를 만들 수 없다.`,
      );
      actions.push("`docs/00_IDEA.md`를 고쳐 다시 평가하거나, 다른 아이디어로 넘어간다 (재개(--resume)는 불가).");
      break;
    }
    case "failed":
      // [C-126/A-5] 파이프라인이 소유한 상태에서는 **`--resume`을 안내하지 않는다.** 활성 파이프라인의
      // 직접 run/resume은 `pipeline_run_reserved`로 전면 거부되므로(B-41), 그 안내는 반드시 실패하는
      // 명령을 사람에게 시키는 것이었다. 탈출구는 같은 workflow를 자동 resume하는 `pipeline next`다.
      actions.push(
        `\`${state.failed_agent ?? "(알 수 없음)"}\`에서 중단됨${state.failed_reason ? ` (${state.failed_reason})` : ""} — 원인 확인 후 ` +
          (pipelineOwns
            ? `\`harness pipeline next --project ${project}\`로 같은 단계를 resume (직접 run/resume은 거부된다).`
            : `\`harness run ${state.workflow_id} --project ${project} --resume\`로 재개.`),
      );
      break;
    case "completed":
      actions.push(
        pipelineOwns
          ? `workflow \`${state.workflow_id}\` 자체는 완주했다 — 다음 행동은 위 단계 체크포인트가 정한다(승인 전에는 지시문을 만들지 않는다).`
          : `workflow \`${state.workflow_id}\` 완료 — \`harness task-prompt --project ${project}\`로 작업 지시문 생성 또는 다음 workflow 실행.`,
      );
      break;
    default: {
      // status가 없는 옛 run_state(필드 도입 전)는 failed_agent로 판단한다 — 기존 동작 보존.
      const legacy: never = state.status;
      void legacy;
      actions.push(
        state.failed_agent
          ? `\`${state.failed_agent}\`에서 중단됨 — \`harness run ${state.workflow_id} --project ${project} --resume\`로 재개.`
          : `workflow \`${state.workflow_id}\` 완료 — \`harness task-prompt --project ${project}\`로 작업 지시문 생성 또는 다음 workflow 실행.`,
      );
    }
  }
  if (state.warnings.length > 0) {
    actions.push(`필수 섹션 누락 경고 ${state.warnings.length}건 — 해당 결과 문서 보완 권장.`);
  }
  return actions;
}

/** CONTEXT_SUMMARY.md에 쓸 짧은 요약 markdown을 생성한다. */
export function buildSummary(project: string, today: string): string {
  const paths = projectPaths(project);
  const runRead = readRunStateForSummary(project);
  const state = runRead.kind === "ok" ? runRead.state : null;
  const docs = listMarkdown(paths.docs);
  const outputs = listMarkdown(paths.outputs);

  const lines: string[] = [];
  lines.push(`# CONTEXT_SUMMARY.md — ${project}`, "");
  lines.push(`최종 갱신: ${today}`, "");

  lines.push("## 현재 상태");
  if (state) {
    lines.push(`- 마지막 workflow: \`${state.workflow_id}\``);
    lines.push(`- 상태: ${state.status ?? (state.failed_agent ? "failed" : "completed")}`);
    lines.push(`- 완료 단계: ${state.completed_steps.join(" → ") || "(없음)"}`);
    lines.push(`- 실패 agent: ${state.failed_agent ?? "없음"}`);
    lines.push(`- 경고: ${state.warnings.length}건`);
  } else {
    lines.push("- workflow 미실행 (run_state 없음)");
  }
  const pipeRead = readPipelineStateAt(pipelineStatePath(paths.root));
  if (pipeRead.kind === "ok") {
    const st = pipeRead.state;
    lines.push(
      `- 단계 체크포인트: ${st.current_index + 1}/${DEFAULT_PIPELINE.length} '${currentStage(st)?.id ?? "(완료)"}' · ${st.status}` +
        (st.pending ? ` (checkpoint ${st.pending.checkpoint_id})` : ""),
    );
  } else if (pipeRead.kind === "unreadable") {
    lines.push("- 단계 체크포인트: **pipeline_state 손상 — 판정 불가(fail closed)**");
  }
  lines.push("");

  // CEO 판단이 있으면 핵심 한 줄 노출
  const ceoPath = join(paths.docs, "06_CEO_DECISION.md");
  if (existsSync(ceoPath)) {
    const judgment = extractMainJudgment(readFileSync(ceoPath, "utf8"));
    lines.push("## CEO 핵심 판단", `- ${judgment}`, "");
  }

  lines.push("## 생성된 문서");
  lines.push(`- docs/: ${docs.join(", ") || "(없음)"}`);
  lines.push(`- outputs/: ${outputs.join(", ") || "(없음)"}`);
  lines.push("");

  lines.push("## 다음 작업");
  if (runRead.kind === "unreadable") {
    // [B-62] 손상은 손상이라고 적는다. "미실행"으로 접으면 폐기 기록이 그 안에 있어도 사람이 모르고,
    // 그 상태에서 권하던 `harness run`은 `run_state_unreadable`로 거부된다(실행 확인).
    lines.push(
      `- **run_state.json을 읽을 수 없다** (${runRead.detail}) — "미실행"이 아니다. ` +
        `폐기 기록이 이 파일에 있을 수 있어 하네스는 덮어쓰지 않는다.`,
      `- 이 상태에서는 \`run\`·\`task-prompt\`·\`plan-dag\`가 전부 \`run_state_unreadable\`로 거부된다. ` +
        `파일을 복원하거나(백업) 내용을 검토한 뒤 지워야 다시 열린다.`,
    );
  }
  // [Codex A-5] 파이프라인이 있으면 **그 상태가 먼저**다 (확인 대기를 완료로 적지 않는다).
  const pipe = pipelineActions(project, paths.root);
  if (pipe) for (const a of pipe) lines.push(`- ${a}`);
  // [B-65] `pipelineOwns`에 **drift 검사를 넣는다.** 예전엔 `completed`만 배제해서, 완료 + drift 상태가
  // 바로 위 파이프라인 안내(*"task-prompt·handoff·plan-dag가 **거부된다**"*)와 아래 기존 문구
  // (*"`harness task-prompt --project X`로 작업 지시문 **생성**"*)를 **연달아** 적었다.
  // 실측: 그 명령은 `exit 2`다. 사람이 두 줄을 같은 화면에서 본다.
  const pipeCompletedClean =
    pipeRead.kind === "ok" && pipeRead.state.status === "completed" && driftProblem(paths.root, approvedDigests(pipeRead.state).values()) === null;
  const pipelineOwns = pipe !== null && !pipeCompletedClean;
  if (runRead.kind !== "unreadable") for (const a of nextActions(state, project, pipelineOwns)) lines.push(`- ${a}`);
  lines.push("");

  return lines.join("\n");
}

/** CONTEXT_SUMMARY.md를 갱신하고 저장 경로(프로젝트 상대)를 반환한다. */
export function updateContextSummary(project: string, today: string): string {
  if (!projectExists(project)) {
    throw new Error(`프로젝트가 없습니다: ${project} (먼저 'harness init ${project}' 실행)`);
  }
  const content = buildSummary(project, today);
  const rel = "docs/CONTEXT_SUMMARY.md";
  writeFileSync(join(projectPaths(project).root, rel), content, "utf8");
  return rel;
}
