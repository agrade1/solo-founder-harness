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
function readJson(relPath) {
    const abs = fromPackage(relPath);
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
/** registry/workflows.json 로드 */
export function loadWorkflows() {
    return readJson(WORKFLOWS_PATH).workflows;
}
/** common prompt 파일이 실제로 존재하는지 확인 */
export function commonPromptExists(reg) {
    return existsSync(fromPackage(reg.common_prompt_path));
}
/** agent_id로 agent 정의를 찾는다. 없으면 undefined. */
export function findAgent(reg, agentId) {
    return reg.agents.find((a) => a.agent_id === agentId);
}
/** workflow_id로 workflow 정의를 찾는다. 없으면 undefined. */
export function findWorkflow(workflows, workflowId) {
    return workflows.find((w) => w.workflow_id === workflowId);
}
