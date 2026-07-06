import { runWorkflow } from "../core/runWorkflow.js";
import { getProvider, DEFAULT_PROVIDER_ID } from "../providers/index.js";

/** harness run <workflow> --project <name> [--provider <id>] */
export async function runRun(
  workflowName: string,
  project: string,
  providerId: string = DEFAULT_PROVIDER_ID,
): Promise<void> {
  const provider = getProvider(providerId);
  console.log(`workflow 실행: ${workflowName} (project: ${project}, provider: ${provider.id})`);

  const { state, savedFiles, runStatePath } = await runWorkflow({
    workflowId: workflowName,
    project,
    provider,
  });

  console.log("");
  console.log(`완료 단계: ${state.completed_steps.join(" → ") || "(없음)"}`);
  if (state.failed_agent) {
    console.log(`실패 agent: ${state.failed_agent}`);
  }
  if (state.warnings.length > 0) {
    console.log(`경고: ${state.warnings.length}건 (필수 섹션 누락)`);
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
