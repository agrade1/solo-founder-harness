import { generateTaskPrompt } from "../core/taskPrompt.js";

/** harness task-prompt --project <name> */
export function runTaskPrompt(project: string): void {
  const today = new Date().toISOString().slice(0, 10);
  let rel: string;
  try {
    rel = generateTaskPrompt(project, today);
  } catch (err) {
    // [B-41/2단] 게이트 거부(폐기 잠금 · 단계 체크포인트 · drift)는 **설계된 거부**다 — 스택 트레이스로
    // 토하지 않고 게이트가 만든 문장을 그대로 출력하고 exit 2로 신호한다(다른 게이트 진입점과 같은 코드).
    // 그 전에는 B-40의 `killed_locked`조차 uncaught 예외로 나갔다("각 명령은 그대로 출력" 계약 위반).
    console.error(`⛔ ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  console.log(`작업 지시문 생성: projects/${project}/${rel}`);
}
