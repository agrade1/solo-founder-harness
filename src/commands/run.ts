import { runWorkflow } from "../core/runWorkflow.js";
import { mockProvider } from "../providers/mockProvider.js";

/** harness run <workflow> --project <name> */
export function runRun(workflowName: string, project: string): void {
  console.log(`workflow 실행: ${workflowName} (project: ${project}, provider: mock)`);

  const { state, savedFiles, runStatePath } = runWorkflow({
    workflowId: workflowName,
    project,
    provider: mockProvider,
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
  console.log(`run_state: ${runStatePath}`);

  // 실패가 있으면 비정상 종료 코드로 신호
  if (state.failed_agent) process.exitCode = 1;
}
