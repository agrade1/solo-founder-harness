/**
 * V3 M5a — `codex exec --json`의 JSONL을 기존 `SessionEvent`로 정규화한다.
 *
 * 좁게 파싱한다: `thread.started` · `turn.started` · `item.started` · `item.updated`(있으면) ·
 * `item.completed` · `turn.completed` · `turn.failed` · `error`. 그 밖의 타입과 그 밖의 item 종류는
 * **bounded unknown 이벤트**로만 남기고 **성공으로 취급하지 않는다**(전방 호환 ≠ 낙관적 성공).
 *
 * 계약:
 * - **종료 결과는 정확히 1개다.** stream의 `turn.completed`/`turn.failed`/`error`는 outcome을 기록만 하고,
 *   `finish()`가 exit code/signal까지 합쳐 `result` 이벤트 **하나**를 낸다. 그래서
 *   ⓐ 종료 이벤트가 없는 silent stream ⓑ 정상 종료 이벤트 뒤의 비정상 exit ⓒ 중복 종료 이벤트가
 *   모두 조용한 성공이 되지 않는다.
 * - **MCP 호출 이벤트가 관측되면 실패다**(strict empty MCP — provider가 config를 격리해도 스트림에서 한 번 더 막는다).
 * - **durable 상태로 나가는 문자열에는 raw prompt·transcript·secret·환경변수·전체 argv가 없다.**
 *   error/stderr 요약은 상한을 넘기지 않고 `redactSecrets`를 통과한 뒤에만 실린다. 호환용 raw 객체는
 *   in-memory `SessionEvent.raw`에만 있고 이 모듈은 아무것도 디스크에 쓰지 않는다.
 *
 * ⚠ 이벤트 필드명은 로컬 `codex exec` help·JSONL 실측으로 확정해야 한다(M5a에서는 help 실행이
 * 승인되지 않아 미확정 — 그래서 `thread_id`/`session_id`, `item_type`/`type` 같은 별칭을 모두 받는다).
 * live 확정은 M5b 게이트다.
 */
import { redactSecrets } from "../tools/redact.js";
/** 한 줄 최대 길이(문자). 넘으면 내용을 버리고 malformed로 센다. */
export const MAX_LINE_CHARS = 65_536;
/** 한 invocation에서 처리할 최대 JSONL 줄 수. 넘으면 종료 결과가 실패다. */
export const MAX_EVENTS = 5_000;
/** 이벤트 텍스트 상한(문자). */
export const MAX_TEXT_CHARS = 8_192;
/** stderr/error 요약 상한(문자). */
export const MAX_ERROR_CHARS = 512;
/** usage 값 상한 — 이 밖의 값은 0으로 본다(계측 오염 방지). */
export const MAX_USAGE = 1_000_000_000_000;
/** file_change 요약에 남기는 최대 변경 수. */
export const MAX_CHANGES = 32;
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
function clampInt(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        return 0;
    const n = Math.floor(v);
    return n > MAX_USAGE ? MAX_USAGE : n;
}
function bounded(v, max) {
    if (typeof v !== "string" || v.length === 0)
        return "";
    return v.length > max ? `${v.slice(0, max)}…[truncated]` : v;
}
/** 사람이 읽을 오류 요약: 상한 → redaction. 여기 통과한 문자열만 밖으로 나간다. */
export function summarizeError(v) {
    const raw = typeof v === "string" ? v : "";
    return redactSecrets(bounded(raw.replace(/\s+/g, " ").trim(), MAX_ERROR_CHARS));
}
function usageOf(v) {
    const o = (v ?? {});
    return {
        inputTokens: clampInt(o.input_tokens ?? o.inputTokens),
        outputTokens: clampInt(o.output_tokens ?? o.outputTokens),
        cacheCreationInputTokens: clampInt(o.cache_creation_input_tokens),
        cacheReadInputTokens: clampInt(o.cached_input_tokens ?? o.cache_read_input_tokens),
    };
}
/** 권한/비대화 승인 불가로 읽히는 실패인가. hang 대신 paused로 복구하려면 이 구분이 필요하다. */
function looksLikePermissionFailure(text) {
    return /approval|permission|not permitted|denied|sandbox|read-?only/i.test(text);
}
/**
 * 스트리밍 JSONL 파서. `push()`로 청크를 넣고, 프로세스 종료 시 `finish()`로 **정확히 하나의**
 * `result` 이벤트를 받는다. 순수 in-memory이며 파일을 쓰지 않는다.
 */
export class CodexJsonlParser {
    ctx;
    buf = "";
    lines = 0;
    malformed = 0;
    outcome = null;
    lastMessage = "";
    usage = EMPTY_USAGE;
    closed = false;
    session = "";
    limitHit = false;
    constructor(ctx) {
        this.ctx = ctx;
    }
    /** 관측된 codex thread(session) id. `codex exec resume <id>`는 이 값만 쓴다. */
    get sessionId() {
        return this.session;
    }
    /** 상한 초과·malformed 줄 수(진단용 계측 — 텍스트는 담지 않는다). */
    get malformedLines() {
        return this.malformed;
    }
    push(chunk) {
        if (this.closed)
            return [];
        this.buf += chunk;
        const out = [];
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            this.consume(line, out);
        }
        // 개행 없이 상한을 넘긴 buffer는 붙잡지 않는다(메모리 상한).
        if (this.buf.length > MAX_LINE_CHARS) {
            this.buf = "";
            this.malformed++;
            out.push(this.unknown("oversized_line", { chars: MAX_LINE_CHARS }));
        }
        return out;
    }
    /**
     * 프로세스 종료 처리. 남은 부분 줄을 소진한 뒤 **정확히 하나의** `result`를 낸다.
     * 스트림 outcome이 성공이어도 exit code/signal이 비정상이면 실패다(조용한 성공 금지).
     */
    finish(exit) {
        const out = [];
        if (!this.closed) {
            const rest = this.buf;
            this.buf = "";
            if (rest.trim())
                this.consume(rest, out);
        }
        if (this.closed)
            return out; // 이미 result를 냈다 — 두 번 내지 않는다.
        this.closed = true;
        const stderr = summarizeError(exit.stderr);
        let isError;
        let reason;
        let text = "";
        let permission = false;
        if (this.limitHit) {
            isError = true;
            reason = "event_limit_exceeded";
        }
        else if (!this.outcome) {
            isError = true;
            reason = exit.spawnError ? "spawn_error" : exit.signal ? "signal" : exit.code !== 0 ? "exit_error" : "no_terminal_event";
            text = stderr;
        }
        else if (this.outcome.isError) {
            isError = true;
            reason = this.outcome.reason;
            text = this.outcome.text || stderr;
            permission = this.outcome.permission;
        }
        else if (exit.signal) {
            isError = true;
            reason = "signal";
            text = stderr;
        }
        else if (exit.code !== 0) {
            isError = true;
            reason = "exit_error";
            text = stderr;
        }
        else {
            isError = false;
            reason = this.outcome.reason;
            text = this.lastMessage;
        }
        const raw = {
            type: "codex_result",
            reason,
            exit_code: exit.code,
            signal: exit.signal ?? null,
            lines: this.lines,
            malformed_lines: this.malformed,
        };
        out.push({
            kind: "result",
            sessionId: this.session,
            isError,
            text: bounded(text, MAX_TEXT_CHARS),
            numTurns: this.outcome ? 1 : 0,
            usage: this.usage,
            totalCostUsd: 0, // codex JSONL은 비용을 주지 않는다 — 추정치를 만들지 않는다.
            stopReason: permission ? "permission_required" : undefined,
            terminalReason: reason,
            permissionDenials: permission ? [{ reason: "permission_required" }] : [],
            raw,
        });
        return out;
    }
    unknown(type, extra = {}) {
        return { kind: "unknown", type, sessionId: this.session, raw: { type, ...extra } };
    }
    consume(line, out) {
        const t = line.trim();
        if (!t)
            return;
        if (++this.lines > MAX_EVENTS) {
            if (!this.limitHit) {
                this.limitHit = true;
                out.push(this.unknown("event_limit_exceeded", { limit: MAX_EVENTS }));
            }
            return;
        }
        if (t.length > MAX_LINE_CHARS) {
            this.malformed++;
            out.push(this.unknown("oversized_line", { chars: t.length }));
            return;
        }
        let obj;
        try {
            obj = JSON.parse(t);
        }
        catch {
            this.malformed++;
            out.push(this.unknown("malformed_line"));
            return;
        }
        if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.type !== "string") {
            this.malformed++;
            out.push(this.unknown("malformed_line"));
            return;
        }
        this.event(obj, out);
    }
    event(raw, out) {
        switch (raw.type) {
            case "thread.started": {
                // 필드명 미확정 구간 — 별칭을 모두 받는다(§상단 주석).
                const id = raw.thread_id ?? raw.session_id ?? raw.id;
                this.session = bounded(id, 128);
                out.push({
                    kind: "init",
                    sessionId: this.session,
                    model: this.ctx.model,
                    cwd: this.ctx.cwd,
                    permissionMode: this.ctx.sandbox,
                    tools: [],
                    mcpServers: [], // strict empty MCP — 이 provider는 MCP 서버를 붙이지 않는다.
                    raw,
                });
                return;
            }
            case "turn.started":
                out.push({ kind: "status", sessionId: this.session, status: "turn_started", raw });
                return;
            case "item.started":
            case "item.updated": {
                const item = (raw.item ?? {});
                const itemType = bounded(item.item_type ?? item.type, 64) || "unknown";
                if (itemType === "mcp_tool_call")
                    return this.mcpViolation(raw, out);
                // 진행 신호만 낸다(추론 원문·부분 텍스트는 싣지 않는다).
                out.push({ kind: "status", sessionId: this.session, status: `${raw.type}:${itemType}`, raw });
                return;
            }
            case "item.completed":
                return this.itemCompleted(raw, out);
            case "turn.completed":
                if (!this.outcome)
                    this.usage = usageOf(raw.usage); // 채택된 outcome의 usage만 남긴다
                this.record({ isError: false, reason: "turn_completed", text: "", permission: false }, raw, out);
                return;
            case "turn.failed": {
                const err = (raw.error ?? {});
                const text = summarizeError(err.message ?? raw.message);
                this.record({ isError: true, reason: "turn_failed", text, permission: looksLikePermissionFailure(text) }, raw, out);
                return;
            }
            case "error": {
                const text = summarizeError(raw.message ?? raw.error?.message);
                this.record({ isError: true, reason: "error", text, permission: looksLikePermissionFailure(text) }, raw, out);
                return;
            }
            default:
                // 전방 호환: 모르는 타입은 남기되 성공의 근거로 쓰지 않는다.
                out.push({ kind: "unknown", type: bounded(raw.type, 64), subtype: undefined, sessionId: this.session, raw });
                return;
        }
    }
    itemCompleted(raw, out) {
        const item = (raw.item ?? {});
        const itemType = bounded(item.item_type ?? item.type, 64) || "unknown";
        const id = bounded(item.id, 128);
        switch (itemType) {
            case "agent_message": {
                const text = bounded(item.text ?? item.message, MAX_TEXT_CHARS);
                this.lastMessage = text; // 최종 결과 텍스트(= --output-schema 사용 시 구조화 출력 본문)
                out.push({ kind: "assistant", sessionId: this.session, text, toolUses: [], stopReason: null, raw });
                return;
            }
            case "reasoning":
                out.push({ kind: "status", sessionId: this.session, status: "reasoning", raw });
                return;
            case "command_execution": {
                const tool = {
                    id,
                    name: "command_execution",
                    input: {
                        command: bounded(item.command, 1_024),
                        status: bounded(item.status, 32),
                        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
                    },
                };
                out.push({ kind: "assistant", sessionId: this.session, text: "", toolUses: [tool], stopReason: null, raw });
                return;
            }
            case "file_change": {
                const changes = Array.isArray(item.changes) ? item.changes.slice(0, MAX_CHANGES) : [];
                const tool = {
                    id,
                    name: "file_change",
                    input: {
                        status: bounded(item.status, 32),
                        changes: changes.map((c) => {
                            const o = (c ?? {});
                            return { path: bounded(o.path, 256), kind: bounded(o.kind, 32) };
                        }),
                        truncated: Array.isArray(item.changes) && item.changes.length > MAX_CHANGES,
                    },
                };
                out.push({ kind: "assistant", sessionId: this.session, text: "", toolUses: [tool], stopReason: null, raw });
                return;
            }
            case "mcp_tool_call":
                return this.mcpViolation(raw, out);
            default:
                out.push({ kind: "unknown", type: `item.completed:${itemType}`, sessionId: this.session, raw });
                return;
        }
    }
    /** MCP 호출 관측 = 즉시 실패 outcome. 이후 성공 종료 이벤트가 와도 뒤집지 않는다. */
    mcpViolation(raw, out) {
        out.push(this.unknown("mcp_call_observed"));
        this.record({ isError: true, reason: "mcp_call_observed", text: "MCP 호출이 관측됐다(strict empty MCP 위반)", permission: false }, raw, out);
    }
    /** 첫 종료 outcome만 채택한다. 두 번째는 중복 표시만 남긴다(정확히 1개 종료 계약). */
    record(o, raw, out) {
        if (this.outcome) {
            out.push(this.unknown("duplicate_terminal", { type: bounded(raw.type, 64) }));
            return;
        }
        this.outcome = o;
    }
}
