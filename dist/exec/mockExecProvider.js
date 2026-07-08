import { AsyncEventQueue } from "./eventQueue.js";
/** 기본 스크립트: init → assistant(짧은 응답) → result(성공). */
const defaultScript = (spec, prompt) => {
    const sid = spec.sessionId;
    const raw = { type: "mock", session_id: sid };
    return [
        { kind: "init", sessionId: sid, model: spec.model ?? "mock", cwd: spec.cwd, permissionMode: spec.permissionMode ?? "acceptEdits", tools: [], raw: { ...raw } },
        { kind: "assistant", sessionId: sid, text: `mock 응답: ${prompt.slice(0, 40)}`, toolUses: [], stopReason: "end_turn", raw: { ...raw } },
        {
            kind: "result",
            sessionId: sid,
            isError: false,
            text: "ok",
            numTurns: 1,
            usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            totalCostUsd: 0,
            stopReason: "end_turn",
            permissionDenials: [],
            raw: { ...raw },
        },
    ];
};
export class MockExecProvider {
    script;
    id = "mock-exec";
    sessions = new Map();
    constructor(script = defaultScript) {
        this.script = script;
    }
    async start(spec, initialPrompt) {
        const queue = new AsyncEventQueue();
        this.sessions.set(spec.sessionId, { queue, spec });
        this.replay(spec.sessionId, initialPrompt);
        return { sessionId: spec.sessionId, spec };
    }
    async send(handle, message) {
        const st = this.sessions.get(handle.sessionId);
        if (!st)
            throw new Error(`mock-exec: 없는 세션 ${handle.sessionId}`);
        // 새 invocation용 큐로 교체 (한 invocation = 한 result)
        st.queue = new AsyncEventQueue();
        this.replay(handle.sessionId, message);
    }
    events(handle) {
        const st = this.sessions.get(handle.sessionId);
        if (!st)
            throw new Error(`mock-exec: 없는 세션 ${handle.sessionId}`);
        return st.queue;
    }
    async stop(handle) {
        const st = this.sessions.get(handle.sessionId);
        st?.queue.close();
        this.sessions.delete(handle.sessionId);
    }
    replay(sessionId, prompt) {
        const st = this.sessions.get(sessionId);
        if (!st)
            return;
        const events = this.script(st.spec, prompt);
        for (const e of events)
            st.queue.push(e);
        st.queue.close();
    }
}
