/**
 * V3 M6 T2 — **agent 출력의 오케스트레이션 요청을 kernel API로 배선한다**.
 *
 * M5c까지 kernel에는 `requestSpawn`·`submitStatusUpdate`가 이미 있었지만 **아무도 부르지 않았다**:
 * autopilot은 계획의 operation만 집행했고, 그래서 계층은 코드로만 존재하고 실행되지 않았다. 이 모듈이
 * 그 한 칸을 잇는다 — 그리고 **여기에는 권위가 하나도 없다**:
 *
 * - child는 `AgentRequest`로 **요청만** 한다(`autopilotTypes.AgentRequest` — spawn·전달 두 갈래뿐이고
 *   state를 직접 바꾸는 갈래가 없다).
 * - 승인·생성·전달은 kernel이 한다: depth/child/task/프로세스 상한 · registry role · 미상 dependsOn ·
 *   중복 taskId · 전달 관계(`route_not_related`) · 모호한 수신자 · 종료된 수신자는 전부 kernel 게이트다.
 * - 이 모듈이 만드는 것은 envelope 신원과 §5.2 필수 heading을 채운 body뿐이며, 그 값도 **durable state와
 *   요청의 bounded 필드에서만** 나온다(호출자가 sender·recipient·방향을 고르는 통로가 없다).
 *
 * 실패는 삼키지 않는다: 첫 거부에서 멈추고 안정 코드를 돌려준다. 부분 적용은 durable하게 남는다
 * (spawn 하나가 성공하고 다음이 거부되면 첫 child는 실재한다) — 그래서 호출자는 이 결과를 turn marker로
 * 접어 사람이 보게 한다. **거부를 성공으로 접는 경로는 없다.**
 */
import { AGENT_MESSAGE_SCHEMA_VERSION, ORCHESTRATOR_ID, OrchestrationError, REQUIRED_BODY_HEADINGS, formatTimestamp, } from "./orchestrationTypes.js";
/**
 * 요청을 **계획 순서대로** kernel에 넘긴다. 첫 거부에서 멈춘다(뒤 요청은 시도하지 않는다).
 *
 * spawn과 전달은 kernel이 요구하는 task 상태가 다르므로 호출 시점이 다르다 — 그 순서는 호출자가 정한다:
 * `deliver_status`는 sender가 `running`/`waiting_children`일 때만 수락되고(`assertActive`),
 * `spawn_child`는 `running`/`waiting_children` 또는 **정리 확인된 `cleaning`** 을 받는다.
 * 그래서 autopilot은 전달을 turn 안에서, spawn을 정리 확인 뒤에 부른다.
 */
export function applyAgentRequests(input) {
    const outcomes = [];
    for (const req of input.requests) {
        const outcome = applyOne(input, req);
        outcomes.push(outcome);
        if (outcome.code !== null)
            break;
    }
    return outcomes;
}
/** 이 kind만 골라 적용한다(호출 시점이 kernel 상태 계약에 묶여 있으므로 호출자가 나눠 부른다). */
export function requestsOfKind(requests, kind) {
    return requests.filter((r) => r.kind === kind);
}
/** 감사 라벨 — 요청 갈래별 대상 표기. */
function requestTarget(req) {
    return req.kind === "spawn_child" ? req.childTaskId : req.kind === "deliver_status" ? req.deliverTo : ORCHESTRATOR_ID;
}
function applyOne(input, req) {
    const { kernel, taskId } = input;
    const task = kernel.getTask(taskId);
    if (task === null) {
        return { kind: req.kind, target: requestTarget(req), code: "unknown_task" };
    }
    try {
        if (req.kind === "spawn_child") {
            kernel.requestSpawn({
                envelope: envelopeFor(kernel, task, "spawn_request", input.nextId("spawn"), input.clock),
                body: spawnBody(req),
                child: {
                    taskId: req.childTaskId,
                    roleId: req.roleId,
                    title: req.title,
                    scope: req.scope,
                    // **ownership을 요청에서 받지 않는다** — parent가 이미 승인받은 경로를 **그대로 위임**한다.
                    // 요청이 경로를 고르게 하면 child가 요청 한 줄로 자기 쓰기 범위를 넓힐 수 있다. 위임은 넓힐 수
                    // 없고(부모 집합과 동일) `writableRoots`·`ownershipByTask` 게이트는 kernel 안에 그대로 있다.
                    // 더 좁은 위임이 필요하면 승인 문서를 고친다 — agent가 정하는 값이 아니다.
                    ownership: [...task.ownership],
                    dependsOn: [...req.dependsOn],
                    assignmentMessageId: input.nextId("asg"),
                    assignmentBody: assignmentBody(req),
                },
            });
            return { kind: req.kind, target: req.childTaskId, code: null };
        }
        if (req.kind === "request_decision") {
            // **요청만 만든다.** 답(`decision`)은 사람이 중앙 API로만 넣는다 — 여기에 그 갈래는 없다.
            kernel.submitDecisionRequest({
                envelope: envelopeFor(kernel, task, "decision_request", input.nextId("dec"), input.clock),
                body: decisionRequestBody(req, task.taskId),
                summary: req.question,
            });
            return { kind: req.kind, target: ORCHESTRATOR_ID, code: null };
        }
        kernel.submitStatusUpdate({
            envelope: envelopeFor(kernel, task, "status_update", input.nextId("stat"), input.clock),
            body: statusBody(req, task.taskId),
            summary: req.note,
            deliverTo: req.deliverTo,
        });
        return { kind: req.kind, target: req.deliverTo, code: null };
    }
    catch (err) {
        return {
            kind: req.kind,
            target: requestTarget(req),
            code: err instanceof OrchestrationError ? err.code : "routing_internal_error",
        };
    }
}
/**
 * envelope 신원은 **durable state와 task에서만** 나온다: run/milestone/parent는 state, sender는 task의
 * registry role, recipient는 항상 중앙이다. agent가 "누구로서 누구에게" 보내는지 고를 수 없다(§5.3).
 */
function envelopeFor(kernel, task, type, messageId, clock) {
    const state = kernel.getState();
    return {
        schemaVersion: AGENT_MESSAGE_SCHEMA_VERSION,
        messageId,
        runId: state.runId,
        milestoneId: state.milestoneId,
        taskId: task.taskId,
        parentTaskId: task.parentTaskId,
        sender: task.roleId,
        recipient: ORCHESTRATOR_ID,
        type,
        createdAt: formatTimestamp(clock()),
        dependsOn: [],
        artifactRefs: [],
        supersedes: null,
    };
}
/** §5.2 필수 heading을 **상수에서 파생**해 채운다(하드코딩 사본을 만들지 않는다). */
function renderBody(type, filled) {
    return REQUIRED_BODY_HEADINGS[type].map((h) => `## ${h}\n\n${filled[h] ?? "- (없음)"}`).join("\n\n");
}
function spawnBody(req) {
    return renderBody("spawn_request", {
        "Why Split Is Needed": `- ${req.reason}`,
        "Requested Specialty": `- ${req.roleId}`,
        "Child Scope": `- ${req.scope}`,
        "Required Inputs": req.dependsOn.length === 0 ? "- (없음)" : req.dependsOn.map((d) => `- ${d}`).join("\n"),
        "Expected Deliverables": `- ${req.title}`,
        "Dependency and Budget Impact": `- dependsOn ${req.dependsOn.length}건 · 예산은 승인 manifest 안에서 공유한다.`,
    });
}
function assignmentBody(req) {
    return renderBody("task_assignment", {
        Objective: `- ${req.title}`,
        "Scope / Ownership": `- ${req.scope}`,
        "Out of Scope / Forbidden": "- 승인 manifest 밖의 경로·operation·spawn은 전부 금지다.",
        "Inputs and Contracts": req.dependsOn.length === 0 ? "- (없음)" : req.dependsOn.map((d) => `- ${d}`).join("\n"),
        Dependencies: req.dependsOn.length === 0 ? "- (없음)" : req.dependsOn.map((d) => `- ${d}`).join("\n"),
        "Definition of Done": "- 승인 경계 안에서 result를 발행한다.",
        "Budget and Permission Envelope": "- 승인 manifest의 예산·권능만 쓴다(이 body가 권한을 주지 않는다).",
        "Expected Deliverables": `- ${req.title}`,
    });
}
function decisionRequestBody(req, senderTaskId) {
    return renderBody("decision_request", {
        "Blocking Condition": `- ${req.question}`,
        Evidence: `- ${senderTaskId}의 durable 산출물과 전달 기록을 근거로 한다(원문은 싣지 않는다).`,
        "Options and Trade-offs": "- 사람이 판단한다. 이 요청은 선택지를 대신 고르지 않는다.",
        "Required Authority": "- 사람(Founder) 결정. 모델 출력은 조언이며 사람 권한을 대체하지 않는다.",
        "Safe Default While Waiting": `- ${req.safeDefault}`,
    });
}
function statusBody(req, senderTaskId) {
    return renderBody("status_update", {
        "Current Status": `- ${req.note}`,
        "Progress Since Last Update": `- ${senderTaskId}가 turn 하나를 진행했다.`,
        "Next Step": `- ${req.deliverTo}가 이 전달을 수령한 뒤 이어서 진행한다.`,
    });
}
