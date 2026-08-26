import { runWorkflow, loadRunState, readRunState, ideaGateStatus, snapshotProjectIdea, gateOutcomeLabel } from "../core/runWorkflow.js";
import { loadWorkflows, findWorkflow, hasKillGate } from "../core/registry.js";
import { projectPipelineGate } from "../core/pipeline.js";
import { exportToVault } from "../core/obsidianExport.js";
import { getProvider, DEFAULT_PROVIDER_ID } from "../providers/index.js";
import { createProgressReporter } from "./progress.js";
import { runHandoffCommand } from "./handoff.js";
// [B-41/1단] 승인자는 공유 모듈 하나다 — pipeline next도 같은 함수를 쓴다(EOF/close/error에서
// 정확히 한 번 false). 여기 지역 사본이 있으면 두 진입점의 비TTY 동작이 갈린다.
import { stdinApprover } from "./approver.js";
import type { Provider } from "../providers/provider.js";

/** harness run <workflow> --project <name> [--provider <id>] [--vault <path>] [--resume] */
export async function runRun(
  workflowName: string,
  project: string,
  providerId: string = DEFAULT_PROVIDER_ID,
  maxRegenerations = 1,
  allowSpawn = false,
  vault?: string,
  resume = false,
  maxTokens = 0,
  yes = false,
  toolProfileId?: string,
  bare = false,
  handoff = false,
  handoffCwd?: string,
  handoffToolProfileId?: string, // [M3c-3b] --handoff-tool-profile (workflow용 --tool-profile과 분리)
  handoffRunner: (o: { project: string; cwd?: string; yes?: boolean; toolProfileId?: string }) => Promise<unknown> = runHandoffCommand, // [M3b.2] 테스트 주입 seam
  providerOverride?: Provider, // [B-40] 테스트 주입 seam — 등록된 provider id로는 만들 수 없는 판정 출력(예: CEO '폐기')이 필요할 때만. cli는 넘기지 않는다.
  workflowsPath?: string, // [B-40] 테스트 주입 seam — 실제 registry엔 없는 게이트 형태(대상 부재 등)의 CLI 렌더를 재려면 필요. cli는 넘기지 않는다.
): Promise<void> {
  const provider = providerOverride ?? getProvider(providerId);
  const approve = yes ? async () => true : stdinApprover;

  // [B-41/2단] 활성 파이프라인에서 일반 run은 **전면 거부**다(resume 포함) — 현 단계 실행 권한은
  // `pipeline next` 단독이다. 상태별로 허용하면 "승인 직후 awaiting_run에서 다음 단계를 직접 run"이
  // 열려 단계 건너뛰기가 성립한다. runWorkflow도 같은 게이트를 던지지만, CLI는 거부를 exit 2로 낸다
  // (무인 loop 진입점과 같은 코드). 거부 문장은 게이트가 만든 것을 그대로 출력한다.
  const pipeGate = projectPipelineGate(project, "run");
  if (!pipeGate.ok) {
    console.error(`⛔ ${pipeGate.message}`);
    process.exitCode = 2;
    return;
  }

  if (resume) {
    // 재개 전 안전 점검: 완료된 실행을 덮어쓰지 않는다 (FAILURE_RECOVERY).
    const prior = loadRunState(project);
    if (!prior) {
      console.error(`재개할 run_state가 없습니다: ${project} (먼저 'harness run ${workflowName} --project ${project}' 실행)`);
      process.exitCode = 1;
      return;
    }
    // killed는 completed와 동급 terminal — 재개 대상이 아니고, **재평가 run**(kill 게이트가 있는
    // workflow)으로 새로 시작한다. 아이디어 수정은 권장이지만 잠금 해제 조건이 아니다(같은 바이트로도
    // 재평가에서 '진행'이 나오면 해제된다 — `ideaGateStatus` 계약 · DECISIONS 2026-08-26 항목).
    if (prior.status === "completed" || prior.status === "killed") {
      console.log(`이미 종료된 실행입니다 (${prior.workflow_id}, status=${prior.status}) — 재개할 것이 없습니다. 덮어쓰기 방지.`);
      return;
    }
    console.log(`workflow 재개: ${workflowName} (project: ${project}, provider: ${provider.id}, step ${prior.resume_from}부터)`);
  } else {
    // [B-40] 폐기 잠금: kill 게이트가 없는 다른 workflow로 새로 돌려 kill 증거를 completed로 덮어쓰는 길을
    // 막는다. 잠금 중 허용은 재평가 run(kill 게이트가 있는 workflow) 하나뿐.
    // runWorkflow도 같은 함수로 던지지만, CLI는 거부를 exit 2(무인 loop 진입점과 같은 코드)로 낸다.
    const wf = findWorkflow(loadWorkflows(workflowsPath), workflowName);
    const gate = ideaGateStatus(readRunState(project), snapshotProjectIdea(project), wf ? hasKillGate(wf) : false);
    if (!gate.ok) {
      console.error(`⛔ ${gate.code}: ${gate.message}`);
      process.exitCode = 2;
      return;
    }
    console.log(`workflow 실행: ${workflowName} (project: ${project}, provider: ${provider.id})`);
  }

  const { state, savedFiles, runStatePath } = await runWorkflow({
    workflowId: workflowName,
    project,
    provider,
    maxRegenerations,
    allowSpawn,
    resume,
    maxTokens,
    approve,
    reporter: createProgressReporter(),
    toolProfileId,
    bare,
    workflowsPath,
  });

  console.log("");
  console.log(`완료 단계: ${state.completed_steps.join(" → ") || "(없음)"}`);
  if (state.failed_agent) {
    console.log(`실패 agent: ${state.failed_agent}`);
  }
  if (state.status === "failed") {
    // [B-40/A-2] failed_agent가 있으면 사유를 숨기던 조건을 없앴다 — 게이트 실패는 failed_agent(decider)가
    // 있으면서 사유 코드가 유일한 정보다("보류라서 멈췄나 예산이 떨어졌나"). agent 실패에도 해롭지 않다.
    if (state.failed_reason) {
      console.log(`중단 사유: ${state.failed_reason}`);
    }
    console.log(`재개: harness run ${state.workflow_id} --project ${project} --resume`);
  }
  for (const c of state.critique_rounds) {
    console.log(`비평 루프: ${c.critic}⟲${c.target} ${c.rounds}라운드 — ${c.resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
  }
  if (state.design_gate) {
    console.log(`디자인 게이트: ${state.design_gate.status}${state.design_gate.tokens_hash ? ` (tokens ${state.design_gate.tokens_hash.slice(0, 12)}…)` : ""}`);
  }
  for (const g of state.gate_jumps) {
    console.log(`게이트: ${g.decider} 판정 '${g.decision ?? "미매칭"}' → ${gateOutcomeLabel(g)}`);
  }
  if (state.spawned_agents.length > 0) {
    const executed = state.spawned_agents.filter((s) => s.executed).length;
    const ids = state.spawned_agents.map((s) => s.id).join(", ");
    console.log(
      executed > 0
        ? `분화: ${state.spawned_agents.length}개 하위 에이전트 실행 (${ids})`
        : `분화: ${state.spawned_agents.length}개 선언됨 (${ids}) — 계획만, 실행하려면 --allow-spawn`,
    );
  }
  if (state.regenerations.length > 0) {
    const total = state.regenerations.reduce((s, r) => s + r.attempts, 0);
    const unresolved = state.regenerations.filter((r) => !r.resolved).length;
    console.log(`재생성: ${total}회 (${state.regenerations.length}개 agent${unresolved > 0 ? `, ${unresolved}개 미해결` : ", 전부 해결"})`);
  }
  if (state.warnings.length > 0) {
    console.log(`경고: ${state.warnings.length}건 (재생성 후에도 필수 섹션 누락)`);
  }
  console.log(`저장 파일: ${savedFiles.length}개`);
  if (state.usage.input_tokens > 0 || state.usage.output_tokens > 0) {
    console.log(
      `토큰: in ${state.usage.input_tokens} / out ${state.usage.output_tokens}`,
    );
  }
  console.log(`run_state: ${runStatePath}`);

  // Obsidian vault export (옵션). --vault 또는 HARNESS_VAULT 환경변수.
  // [B-40] killed 분기보다 **먼저** 두는 것은 의도다: 폐기도 기록으로 남아야 한다(vault만 보는 사람이
  // 이 아이디어가 왜 멈췄는지 알아야 한다). 예전 문제는 순서가 아니라 export 내용이 killed를
  // "진행"으로 적던 것이었고, 그건 obsidianExport에서 고쳤다(상태 줄 + 게이트 결과 줄).
  const vaultPath = vault ?? process.env.HARNESS_VAULT;
  if (vaultPath && vaultPath.trim()) {
    try {
      const ex = exportToVault({ vault: vaultPath.trim(), state });
      console.log(`Obsidian: ${ex.notesWritten}개 노트 → ${ex.folder} (인덱스: [[${ex.indexNote}]])`);
    } catch (err) {
      console.warn(`Obsidian export 실패 (실행 결과는 저장됨): ${(err as Error).message}`);
    }
  }

  // kill 게이트 폐기 판정: 종료 코드 0. 게이트가 제 일을 했으므로 실행은 성공이다 —
  // 비정상 종료 코드는 agent 실패·예산 초과·승인 거부(재개 가능한 중단)에만 쓴다.
  // handoff로 이어붙이지 않는다: 죽은 아이디어를 개발 착수로 넘기지 않는 것이 이 게이트의 목적.
  if (state.status === "killed") {
    const k = state.killed_by;
    console.log("");
    console.log(`⛔ 폐기 판정: ${k?.decider ?? "(게이트)"}가 '${k?.decision ?? "폐기"}' 판정 — 후속 단계는 실행되지 않았습니다.`);
    // **잠금 해제 조건을 정확히 적는다**: 해제하는 것은 아이디어 수정이 아니라 **재평가 run의 '진행'
    // 판정**이다(같은 바이트로도 해제된다 — `ideaGateStatus`). 수정은 권장이지 조건이 아니다.
    console.log(`재개(--resume)는 불가합니다. 아이디어를 검토·수정한 뒤 **재평가 run**으로 다시 판정받으세요: harness run ${state.workflow_id} --project ${project}`);
    console.log("  (잠금을 푸는 것은 재평가 게이트의 '진행' 판정입니다 — 아이디어를 고치지 않아도 재평가는 돌 수 있고, 고치지 않은 채 통과하면 그 판정이 영수증에 남습니다.)");
    return;
  }

  // 중단(agent 실패 또는 예산 초과)이면 비정상 종료 코드로 신호
  if (state.status === "failed") {
    process.exitCode = 1;
    return;
  }

  // [M3b.2] --handoff: run이 completed일 때만 대화형 Claude Code 핸드오프로 이어붙인다.
  // (failed면 위에서 return — 핸드오프하지 않고 resume 안내만 남는다.)
  if (handoff) {
    console.log("");
    // [M3c-3b] --handoff-tool-profile은 handoff 경로 전용. workflow용 --tool-profile(toolProfileId)과 혼용하지 않는다.
    await handoffRunner({ project, cwd: handoffCwd, yes, toolProfileId: handoffToolProfileId });
  }
}
