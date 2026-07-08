import { updateContextSummary } from "../core/summary.js";
/** harness summary --project <name> */
export function runSummary(project) {
    const today = new Date().toISOString().slice(0, 10);
    const rel = updateContextSummary(project, today);
    console.log(`CONTEXT_SUMMARY 갱신: projects/${project}/${rel}`);
}
