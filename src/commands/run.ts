import { createInterface } from "node:readline";
import { runWorkflow, loadRunState } from "../core/runWorkflow.js";
import { exportToVault } from "../core/obsidianExport.js";
import { getProvider, DEFAULT_PROVIDER_ID } from "../providers/index.js";

/** stdin으로 y/N 승인을 묻는다 (승인 게이트용). y/yes만 승인. */
function stdinApprover(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n[승인 필요] ${message} (y/N): `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

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
): Promise<void> {
  const provider = getProvider(providerId);
  const approve = yes ? async () => true : stdinApprover;

  if (resume) {
    // 재개 전 안전 점검: 완료된 실행을 덮어쓰지 않는다 (FAILURE_RECOVERY).
    const prior = loadRunState(project);
    if (!prior) {
      console.error(`재개할 run_state가 없습니다: ${project} (먼저 'harness run ${workflowName} --project ${project}' 실행)`);
      process.exitCode = 1;
      return;
    }
    if (prior.status === "completed") {
      console.log(`이미 완료된 실행입니다 (${prior.workflow_id}) — 재개할 것이 없습니다. 덮어쓰기 방지.`);
      return;
    }
    console.log(`workflow 재개: ${workflowName} (project: ${project}, provider: ${provider.id}, step ${prior.resume_from}부터)`);
  } else {
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
  });

  console.log("");
  console.log(`완료 단계: ${state.completed_steps.join(" → ") || "(없음)"}`);
  if (state.failed_agent) {
    console.log(`실패 agent: ${state.failed_agent}`);
  }
  if (state.status === "failed") {
    if (!state.failed_agent && state.failed_reason) {
      console.log(`중단 사유: ${state.failed_reason}`);
    }
    console.log(`재개: harness run ${state.workflow_id} --project ${project} --resume`);
  }
  for (const c of state.critique_rounds) {
    console.log(`비평 루프: ${c.critic}⟲${c.target} ${c.rounds}라운드 — ${c.resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
  }
  for (const g of state.gate_jumps) {
    console.log(`게이트: ${g.decider} 판정 '${g.decision ?? "미매칭"}' → ${g.jumped_to ? `${g.jumped_to} 되돌림` : "진행"}`);
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
  const vaultPath = vault ?? process.env.HARNESS_VAULT;
  if (vaultPath && vaultPath.trim()) {
    try {
      const ex = exportToVault({ vault: vaultPath.trim(), state });
      console.log(`Obsidian: ${ex.notesWritten}개 노트 → ${ex.folder} (인덱스: [[${ex.indexNote}]])`);
    } catch (err) {
      console.warn(`Obsidian export 실패 (실행 결과는 저장됨): ${(err as Error).message}`);
    }
  }

  // 중단(agent 실패 또는 예산 초과)이면 비정상 종료 코드로 신호
  if (state.status === "failed") process.exitCode = 1;
}
