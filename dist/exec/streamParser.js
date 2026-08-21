function num(v, d = 0) {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function str(v, d = "") {
    return typeof v === "string" ? v : d;
}
/** result.usage 또는 assistant.message.usage → SessionUsage. */
function toUsage(u) {
    const o = (u ?? {});
    return {
        inputTokens: num(o.input_tokens),
        outputTokens: num(o.output_tokens),
        cacheCreationInputTokens: num(o.cache_creation_input_tokens),
        cacheReadInputTokens: num(o.cache_read_input_tokens),
    };
}
/** system/init의 mcp_servers 배열을 정규화한다. connected는 status==="connected"에서만 true. */
function toMcpServers(v) {
    if (!Array.isArray(v))
        return [];
    const out = [];
    for (const item of v) {
        const o = (item ?? {});
        const name = str(o.name);
        if (!name)
            continue;
        const status = str(o.status);
        out.push({ name, status, connected: status === "connected" });
    }
    return out;
}
/** assistant.message.content 배열에서 text 이어붙이기 + tool_use 추출. */
function readContent(message) {
    const m = (message ?? {});
    const content = Array.isArray(m.content) ? m.content : [];
    let text = "";
    const toolUses = [];
    for (const block of content) {
        if (block.type === "text")
            text += str(block.text);
        else if (block.type === "tool_use") {
            toolUses.push({ id: str(block.id), name: str(block.name), input: block.input });
        }
    }
    const stop = m.stop_reason;
    return { text, toolUses, stopReason: typeof stop === "string" ? stop : null };
}
/** 이미 파싱된 원본 객체 → 정규화 이벤트. 알 수 없는 타입은 kind:"unknown". */
export function normalize(raw) {
    const sessionId = str(raw.session_id);
    switch (raw.type) {
        case "system": {
            if (raw.subtype === "init") {
                return {
                    kind: "init",
                    sessionId,
                    model: str(raw.model),
                    cwd: str(raw.cwd),
                    permissionMode: str(raw.permissionMode),
                    tools: Array.isArray(raw.tools) ? raw.tools.map((t) => str(t)) : [],
                    mcpServers: toMcpServers(raw.mcp_servers),
                    raw,
                };
            }
            if (raw.subtype === "status") {
                return { kind: "status", sessionId, status: str(raw.status), raw };
            }
            if (raw.subtype === "hook_started" || raw.subtype === "hook_progress" || raw.subtype === "hook_response") {
                const phase = raw.subtype === "hook_started" ? "started" : raw.subtype === "hook_progress" ? "progress" : "response";
                return {
                    kind: "hook",
                    sessionId,
                    phase,
                    hookName: raw.hook_name ? str(raw.hook_name) : undefined,
                    outcome: raw.outcome ? str(raw.outcome) : undefined,
                    exitCode: typeof raw.exit_code === "number" ? raw.exit_code : undefined,
                    raw,
                };
            }
            return { kind: "unknown", type: raw.type, subtype: raw.subtype, sessionId, raw };
        }
        case "assistant": {
            const { text, toolUses, stopReason } = readContent(raw.message);
            return { kind: "assistant", sessionId, text, toolUses, stopReason, raw };
        }
        case "stream_event": {
            return { kind: "delta", sessionId, event: raw.event, raw };
        }
        case "rate_limit_event": {
            const info = (raw.rate_limit_info ?? {});
            return {
                kind: "rateLimit",
                sessionId,
                status: str(info.status),
                rateLimitType: str(info.rateLimitType),
                resetsAt: num(info.resetsAt),
                overageStatus: info.overageStatus ? str(info.overageStatus) : undefined,
                isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
                raw,
            };
        }
        case "result": {
            return {
                kind: "result",
                sessionId,
                isError: raw.is_error === true,
                text: str(raw.result),
                numTurns: num(raw.num_turns),
                usage: toUsage(raw.usage),
                totalCostUsd: num(raw.total_cost_usd),
                stopReason: raw.stop_reason ? str(raw.stop_reason) : undefined,
                terminalReason: raw.terminal_reason ? str(raw.terminal_reason) : undefined,
                permissionDenials: Array.isArray(raw.permission_denials) ? raw.permission_denials : [],
                raw,
            };
        }
        default:
            return { kind: "unknown", type: raw.type, subtype: raw.subtype, sessionId, raw };
    }
}
/** NDJSON 한 줄 → 이벤트. 빈 줄이나 파싱 실패는 null. */
export function parseLine(line) {
    const t = line.trim();
    if (!t)
        return null;
    let obj;
    try {
        obj = JSON.parse(t);
    }
    catch {
        return null;
    }
    if (!obj || typeof obj !== "object" || typeof obj.type !== "string")
        return null;
    return normalize(obj);
}
/** 여러 줄(완결된 텍스트) → 이벤트 배열. */
export function parseAll(text) {
    const out = [];
    for (const line of text.split("\n")) {
        const e = parseLine(line);
        if (e)
            out.push(e);
    }
    return out;
}
/**
 * 스트리밍 청크 파서. stdout 청크는 줄 경계에서 잘리지 않으므로 개행 전까지 버퍼링.
 * push()로 청크를 넣고 완결된 이벤트를 즉시 반환, 스트림 끝에 flush().
 */
export class NdjsonParser {
    buf = "";
    /** 청크를 받아 이번에 완결된 이벤트들을 반환. */
    push(chunk) {
        this.buf += chunk;
        const out = [];
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            const e = parseLine(line);
            if (e)
                out.push(e);
        }
        return out;
    }
    /** 스트림 종료 시 버퍼에 남은 마지막 줄(개행 없이 끝난 경우) 처리. */
    flush() {
        const rest = this.buf;
        this.buf = "";
        const e = parseLine(rest);
        return e ? [e] : [];
    }
}
