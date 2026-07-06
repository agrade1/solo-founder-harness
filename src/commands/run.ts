import { runWorkflow } from "../core/runWorkflow.js";
import { getProvider, DEFAULT_PROVIDER_ID } from "../providers/index.js";

/** harness run <workflow> --project <name> [--provider <id>] */
export async function runRun(
  workflowName: string,
  project: string,
  providerId: string = DEFAULT_PROVIDER_ID,
  maxRegenerations = 1,
): Promise<void> {
  const provider = getProvider(providerId);
  console.log(`workflow 실행: ${workflowName} (project: ${project}, provider: ${provider.id})`);

  const { state, savedFiles, runStatePath } = await runWorkflow({
    workflowId: workflowName,
    project,
    provider,
    maxRegenerations,
  });

  console.log("");
  console.log(`완료 단계: ${state.completed_steps.join(" → ") || "(없음)"}`);
  if (state.failed_agent) {
    console.log(`실패 agent: ${state.failed_agent}`);
  }
  for (const c of state.critique_rounds) {
    console.log(`비평 루프: ${c.critic}⟲${c.target} ${c.rounds}라운드 — ${c.resolved ? "Critical 해소" : "미해결(라운드 소진)"}`);
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

  // 실패가 있으면 비정상 종료 코드로 신호
  if (state.failed_agent) process.exitCode = 1;
}
