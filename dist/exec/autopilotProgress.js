/**
 * task 하나가 **끝났다**고 볼 수 있는 event 종류(닫힌 집합). `task_spawned`가 여기 있는 이유는
 * 위임으로 착지한 turn도 그 task의 이번 step이 끝난 것이기 때문이다. 순서를 가정하지 않고 열린
 * step이 있을 때만 닫으므로, 같은 task에 두 개가 와도 두 번 닫히지 않는다.
 */
const TERMINAL_KINDS = new Set([
    "task_completed",
    "task_paused",
    "task_aborted",
    "task_cancelled",
    "task_spawned",
]);
/** 표시 문자열 상한 — marker·detail은 안정 코드지만 렌더러 줄을 무한히 늘리지 않는다. */
const MAX_LABEL = 120;
function bounded(s) {
    return s.length <= MAX_LABEL ? s : `${s.slice(0, MAX_LABEL - 1)}…`;
}
/**
 * `runAutopilot({ onEvent })`에 그대로 넣을 수 있는 소비자를 만든다.
 *
 * `clock`은 경과 시간 계산용이며 **durable 시각 권위가 아니다**(표시 전용이라 wall clock으로 충분하다).
 */
export function autopilotProgressBridge(reporter, clock = () => Date.now()) {
    let runStartedAt = clock();
    /** batch_planned가 알려주는 이번 batch의 task 수. 모르면 0이다(렌더러가 `?`로 그린다). */
    let total = 0;
    let index = 0;
    /** 열린 step의 시작 시각. 여기 없는 task를 닫으려는 event는 무시한다. */
    const open = new Map();
    let ok = true;
    const emit = (e) => {
        // **표시가 실행을 죽이지 않는다.** 렌더러가 던지면(닫힌 stdout·EPIPE 등) autopilot이 그 자리에서
        // 실패하는데, 그것은 표시 계층이 실행 판정을 바꾸는 것이다 — 이 방향은 열지 않는다.
        try {
            reporter.emit(e);
        }
        catch {
            /* 표시 실패는 실행 실패가 아니다 */
        }
    };
    return (e) => {
        const taskId = e.taskId ?? "";
        switch (e.kind) {
            case "run_started":
                runStartedAt = clock();
                ok = true;
                emit({ type: "run_start", workflow: bounded(`autopilot ${e.detail ?? ""}`.trim()), totalSteps: 0 });
                return;
            case "batch_planned": {
                // detail은 `taskId,taskId,…`다(autopilot.ts:211). 빈 문자열은 0개다.
                const ids = (e.detail ?? "").split(",").filter((s) => s.length > 0);
                total = ids.length;
                emit({ type: "note", level: "info", message: bounded(`batch ${total}건: ${ids.join(" ")}`) });
                return;
            }
            case "task_started":
                index += 1;
                open.set(taskId, clock());
                emit({ type: "step_start", index, total, agentId: taskId, kind: "agent", label: bounded(taskId) });
                return;
            case "task_progress":
                emit({ type: "note", level: "info", message: bounded(`${taskId}: ${e.detail ?? ""}`) });
                return;
            case "task_deferred":
                // step을 열지 않은 채 밀린 것이다 — 닫을 step이 없으므로 한 줄 알림이 정확한 표현이다.
                emit({ type: "note", level: "info", message: bounded(`${taskId} 유예: ${e.marker ?? ""}`) });
                return;
            case "run_finished":
                emit({ type: "run_end", status: ok ? "completed" : "failed", elapsedMs: clock() - runStartedAt });
                return;
            default:
                break;
        }
        if (!TERMINAL_KINDS.has(e.kind))
            return;
        const startedAt = open.get(taskId);
        // 열린 step이 없으면 무시한다(예: `plan_missing`으로 batch 전에 pause된 task — autopilot.ts:202).
        if (startedAt === undefined) {
            emit({ type: "note", level: e.kind === "task_completed" ? "info" : "warn", message: bounded(`${taskId} ${e.kind}: ${e.marker ?? ""}`) });
            return;
        }
        open.delete(taskId);
        const stepOk = e.kind === "task_completed" || e.kind === "task_spawned";
        if (!stepOk)
            ok = false;
        emit({ type: "step_end", index, agentId: taskId, kind: "agent", ok: stepOk, elapsedMs: clock() - startedAt });
        // marker는 **표시에서 사라지면 안 된다**: 왜 멈췄는지가 사람에게 필요한 정보의 전부다.
        if (!stepOk)
            emit({ type: "note", level: "warn", message: bounded(`${taskId} ${e.kind}: ${e.marker ?? ""}${e.detail ? ` (${e.detail})` : ""}`) });
    };
}
