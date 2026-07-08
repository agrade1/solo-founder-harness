import { generateTaskPrompt } from "../core/taskPrompt.js";
/** harness task-prompt --project <name> */
export function runTaskPrompt(project) {
    const today = new Date().toISOString().slice(0, 10);
    const rel = generateTaskPrompt(project, today);
    console.log(`작업 지시문 생성: projects/${project}/${rel}`);
}
