import { readFileSync, existsSync } from "node:fs";
import { fromPackage } from "./paths.js";
/** step이 비평 루프인지 판별 */
export function isCritiqueLoop(step) {
    return typeof step === "object" && step !== null && "critique_loop" in step;
}
/** step이 CEO 게이트인지 판별 */
export function isGate(step) {
    return typeof step === "object" && step !== null && "gate" in step;
}
/** step이 동적 분화인지 판별 */
export function isFanout(step) {
    return typeof step === "object" && step !== null && "fanout" in step;
}
/** step이 승인 게이트인지 판별 */
export function isApproval(step) {
    return typeof step === "object" && step !== null && "approval" in step;
}
const AGENT_REGISTRY_PATH = "registry/agent_registry.json";
const WORKFLOWS_PATH = "registry/workflows.json";
function readJson(relPath, absOverride) {
    const abs = absOverride ?? fromPackage(relPath);
    if (!existsSync(abs)) {
        throw new Error(`registry 파일을 찾을 수 없습니다: ${relPath}`);
    }
    try {
        return JSON.parse(readFileSync(abs, "utf8"));
    }
    catch (err) {
        throw new Error(`registry 파일 파싱 실패 (${relPath}): ${err.message}`);
    }
}
/** registry/agent_registry.json 로드 */
export function loadAgentRegistry() {
    return readJson(AGENT_REGISTRY_PATH);
}
/** registry/workflows.json 로드. absPath를 주면 그 파일에서 읽는다(테스트 fixture용 — loadToolProfiles와 같은 seam). */
export function loadWorkflows(absPath) {
    return readJson(WORKFLOWS_PATH, absPath).workflows;
}
/** common prompt 파일이 실제로 존재하는지 확인 */
export function commonPromptExists(reg) {
    return existsSync(fromPackage(reg.common_prompt_path));
}
/** agent_id로 agent 정의를 찾는다. 없으면 undefined. */
export function findAgent(reg, agentId) {
    return reg.agents.find((a) => a.agent_id === agentId);
}
/**
 * [B-40] 이 workflow가 kill 게이트를 가졌는가 = **폐기 재평가를 돌릴 수 있는 workflow**인가.
 * 폐기 잠금 상태에서 유일하게 허용되는 실행이 이것이라, run 커맨드와 runWorkflow가 같은 판정을 써야 한다.
 */
export function hasKillGate(wf) {
    return wf.steps.some((s) => isGate(s) && (s.gate.kill ?? []).length > 0);
}
/**
 * [A-1] 모든 workflow의 gate decider agent_id (중복 제거). 개발 표면 잠금이 "누구의 판정 문서를
 * 볼 것인가"를 **레지스트리에서 파생**하기 위한 것이다 — 손으로 적은 `founder_ceo` 사본을 두면
 * workflow가 decider를 바꿀 때 잠금만 조용히 빈 곳을 보게 된다.
 */
export function gateDeciderIds(absPath) {
    return [...new Set(loadWorkflows(absPath).flatMap((w) => w.steps.filter(isGate).map((s) => s.gate.decider)))];
}
/** [B-40] kill 게이트를 가진 workflow id 목록 (거부 메시지에 "무엇을 돌려라"를 적기 위해). */
export function reevaluationWorkflowIds(absPath) {
    return loadWorkflows(absPath).filter(hasKillGate).map((w) => w.workflow_id);
}
/** workflow_id로 workflow 정의를 찾는다. 없으면 undefined. */
export function findWorkflow(workflows, workflowId) {
    return workflows.find((w) => w.workflow_id === workflowId);
}
