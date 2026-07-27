/**
 * V3 M5a — `codex exec --json`의 JSONL을 기존 `SessionEvent`로 정규화한다.
 *
 * 좁게 파싱한다: `thread.started` · `turn.started` · `item.started` · `item.updated`(있으면) ·
 * `item.completed` · `turn.completed` · `turn.failed` · `error`. **형태가 유효한** 모르는 이벤트 타입만
 * bounded unknown으로 남기고(전방 호환), 그마저 성공의 근거로 쓰지 않는다.
 *
 * 계약(2026-07-27 fresh Codex 리뷰 반영):
 * - **비가역 프로토콜 실패**: malformed·과대 줄, 중복/모순 종료 이벤트, MCP 관측, 세션 id 위반,
 *   이벤트 상한 초과는 **되돌릴 수 없는 실패**로 기록된다. 성공 종료 뒤에 실패·error·MCP가 와도 **실패**다.
 * - **종료 결과는 정확히 1개다.** stream 이벤트는 outcome을 기록만 하고 `finish()`가 exit code/signal까지
 *   합쳐 `result` **하나**를 낸다. silent stream · 정상 종료 뒤 비정상 exit · 중복 종료가 모두 실패다.
 * - **세션 신원은 불변의 정규 UUID 하나다.** `thread.started`가 정규 UUID를 정확히 한 번 줘야 하고,
 *   빈 값·형식 위반(`--last` 같은 텍스트 포함)·중복·모순·부재는 전부 프로토콜 실패다.
 *   **의미 있는 첫 이벤트가 신원을 세워야 한다** — 신원 확립 전에 온 어떤 이벤트도(status·assistant·
 *   unknown·error 포함) 내용·도구 payload를 전달하지 않고 `missing_session_id` 비가역 실패가 된다.
 *   한 번 실패한 뒤의 늦은 `thread.started`도 신원을 세우지 못한다.
 *   종료 이벤트 뒤에 오는 이벤트는 세션 신원도 최종 메시지도 **바꾸지 못한다**.
 * - **resume은 기대 신원과 대조한다(`ctx.expectedSessionId`)**: 다른 thread id가 오면 **init을 만들기 전에**
 *   스트림을 **봉인**한다 — 같은 chunk에 뒤따라 오던 assistant·status·도구 이벤트까지 한 건도 방출하지 않고,
 *   bounded `session_identity_conflict` marker와 `finish()`의 결과 1건만 나가며 둘 다 **기대 UUID**를 싣는다
 *   (관측된 다른 id는 어디에도 싣지 않는다).
 * - **raw는 원본 JSON이 아니라 bounded sanitized metadata projection이다.** 추론 원문, 명령 문자열,
 *   stderr/error 본문, secret, 프롬프트, 환경변수, 전체 argv, 모르는 이벤트의 payload는 **어떤 이벤트에도
 *   실리지 않는다**(`raw`에는 길이·상태·exit code 같은 스칼라만 남는다). 반면 **최종 agent message는
 *   의도적으로 전달한다** — 상한을 지난 본문이 `assistant.text`와 `result.text`로 나간다(리뷰 판정
 *   `--output-schema` 본문이 여기로 온다). 이 모듈은 디스크에 아무것도 쓰지 않는다.
 *
 * ⚠ JSONL 필드명은 supervisor가 실측한 `codex exec --help`(0.146.0-alpha.3)의 **플래그**까지만 확정됐고
 * 이벤트 payload 필드명은 provider live 경로로 확인하지 않았다 — 그래서 `thread_id`/`session_id` 같은
 * 별칭을 함께 받는다. live 확정은 M5b 게이트다.
 */
import { redactSecrets } from "../tools/redact.js";
import { OrchestrationError } from "./orchestrationTypes.js";
/** 한 줄 최대 길이(문자). 넘으면 내용을 버리고 프로토콜 실패로 본다. */
export const MAX_LINE_CHARS = 65_536;
/** 한 invocation에서 처리할 최대 JSONL 줄 수. 넘으면 프로토콜 실패다. */
export const MAX_EVENTS = 5_000;
/** 이벤트 텍스트 상한(문자). */
export const MAX_TEXT_CHARS = 8_192;
/** stderr/error 요약 상한(문자). */
export const MAX_ERROR_CHARS = 512;
/** usage 값 상한 — 이 밖의 값은 0으로 본다(계측 오염 방지). */
export const MAX_USAGE = 1_000_000_000_000;
/** file_change 요약에 남기는 최대 변경 수. */
export const MAX_CHANGES = 32;
/** codex thread id = 정규 소문자 UUID. 이 형태가 아니면 세션 신원으로 인정하지 않는다. */
export const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
 * `SessionEvent.raw`에 실리는 **유일한** 형태: 이벤트 종류와 bounded 스칼라 metadata뿐이다.
 * 원본 객체를 넣지 않는다 — 소비자가 그대로 전달·직렬화해도 본문이 새지 않게 하기 위해서다.
 */
function meta(codexType, extra = {}) {
    return { type: "codex_event", codexType: bounded(codexType, 64), ...extra };
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
    /** 첫 프로토콜 실패. 한 번 서면 어떤 이벤트도 이것을 되돌리지 못한다. */
    failure = null;
    /** 성공 종료 이벤트를 봤는가(중복 판정용). */
    success = null;
    lastMessage = "";
    usage = EMPTY_USAGE;
    closed = false;
    session = "";
    terminalSeen = false;
    /**
     * 스트림 봉인. 기대 세션 신원과 다른 thread를 본 순간 서고, 그 뒤에는 **같은 chunk에 남아 있던 줄까지**
     * 한 건도 방출하지 않는다(bounded 실패 marker와 `finish()`의 결과 1건만 나간다).
     */
    sealed = false;
    constructor(ctx) {
        this.ctx = ctx;
        // 기대 신원은 정규 UUID여야 한다 — 검증 안 된 텍스트를 신원 비교의 기준으로 쓰지 않는다.
        if (ctx.expectedSessionId !== undefined && !CODEX_SESSION_ID_RE.test(ctx.expectedSessionId)) {
            throw new OrchestrationError("codex_resume_id_invalid", "expectedSessionId는 정규 codex session UUID여야 한다");
        }
    }
    /** 관측된 codex thread(session) id — 정규 UUID이거나 빈 문자열이다. */
    get sessionId() {
        return this.session;
    }
    /** 프로토콜 실패가 기록됐는가(비가역). */
    get protocolFailed() {
        return this.failure !== null;
    }
    /** 상한 초과·malformed 줄 수(진단용 계측 — 텍스트는 담지 않는다). */
    get malformedLines() {
        return this.malformed;
    }
    /**
     * provider가 스트림 밖에서 발견한 위반(세션 신원 충돌 등)을 같은 비가역 실패로 기록한다.
     * 텍스트는 호출자가 이미 안전하다고 보증한 짧은 사유만 넣는다.
     */
    protocolFail(reason, detail = "") {
        this.fail(reason, summarizeError(detail));
    }
    push(chunk) {
        if (this.closed)
            return [];
        if (this.sealed) {
            this.buf = ""; // 봉인 이후 도착한 chunk는 붙잡지도 파싱하지도 않는다.
            return [];
        }
        this.buf += chunk;
        const out = [];
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            this.consume(line, out);
        }
        if (this.sealed)
            this.buf = ""; // chunk 중간에 봉인됐으면 남은 부분도 버린다.
        // 개행 없이 상한을 넘긴 buffer는 붙잡지 않는다(메모리 상한) — 그리고 그것도 프로토콜 실패다.
        if (!this.sealed && this.buf.length > MAX_LINE_CHARS) {
            this.buf = "";
            this.malformed++;
            out.push(this.marker("oversized_line", { chars: MAX_LINE_CHARS }));
            this.fail("oversized_line", "");
        }
        return out;
    }
    /**
     * 프로세스 종료 처리. 남은 부분 줄을 소진한 뒤 **정확히 하나의** `result`를 낸다.
     * 프로토콜 실패 > 세션 신원 부재 > 종료 이벤트 부재 > 비정상 exit/signal 순으로 실패를 판정하고,
     * 그중 아무것도 없을 때만 성공이다.
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
        let isError = true;
        let reason;
        let text = "";
        let permission = false;
        if (this.failure) {
            reason = this.failure.reason;
            text = this.failure.text || stderr;
            permission = this.failure.permission;
        }
        else if (this.lines > 0 && !this.session) {
            // 이벤트가 흘렀는데 정규 세션 id가 없다 = 프로토콜 위반(resume 근거를 만들 수 없다).
            // 신원 우선 게이트가 보통 먼저 잡는다 — 여기는 같은 사유의 backstop이다.
            reason = "missing_session_id";
            text = stderr;
        }
        else if (!this.success) {
            reason = exit.spawnError ? "spawn_error" : exit.signal ? "signal" : exit.code !== 0 ? "exit_error" : "no_terminal_event";
            text = stderr;
        }
        else if (exit.signal) {
            reason = "signal";
            text = stderr;
        }
        else if (exit.code !== 0) {
            reason = "exit_error";
            text = stderr;
        }
        else {
            isError = false;
            reason = this.success.reason;
            text = this.lastMessage;
        }
        out.push({
            kind: "result",
            sessionId: this.session,
            isError,
            text: bounded(text, MAX_TEXT_CHARS),
            numTurns: this.success ? 1 : 0,
            usage: this.usage,
            totalCostUsd: 0, // codex JSONL은 비용을 주지 않는다 — 추정치를 만들지 않는다.
            stopReason: permission ? "permission_required" : undefined,
            terminalReason: reason,
            permissionDenials: permission ? [{ reason: "permission_required" }] : [],
            raw: meta("codex_result", {
                reason,
                exitCode: exit.code,
                signal: exit.signal === null || exit.signal === undefined ? null : bounded(String(exit.signal), 16),
                lines: this.lines,
                malformedLines: this.malformed,
            }),
        });
        return out;
    }
    /** 첫 실패만 채택한다(비가역). 성공 outcome이 이미 있어도 실패가 이긴다. */
    fail(reason, text, permission = false) {
        if (!this.failure)
            this.failure = { reason, text, permission };
    }
    marker(type, extra = {}) {
        return { kind: "unknown", type, sessionId: this.session, raw: meta(type, extra) };
    }
    consume(line, out) {
        if (this.sealed)
            return; // 봉인된 스트림: 파싱조차 하지 않는다(payload가 나갈 경로 0).
        const t = line.trim();
        if (!t)
            return;
        if (++this.lines > MAX_EVENTS) {
            if (!this.failure) {
                out.push(this.marker("event_limit_exceeded", { limit: MAX_EVENTS }));
                this.fail("event_limit_exceeded", "");
            }
            return;
        }
        if (t.length > MAX_LINE_CHARS) {
            this.malformed++;
            out.push(this.marker("oversized_line", { chars: t.length }));
            this.fail("oversized_line", "");
            return;
        }
        let obj;
        try {
            obj = JSON.parse(t);
        }
        catch {
            this.malformed++;
            out.push(this.marker("malformed_line"));
            this.fail("malformed_line", "");
            return;
        }
        if (!obj || typeof obj !== "object" || Array.isArray(obj) || typeof obj.type !== "string") {
            this.malformed++;
            out.push(this.marker("malformed_line"));
            this.fail("malformed_line", "");
            return;
        }
        this.event(obj, out);
    }
    event(raw, out) {
        // **신원 우선**: 의미 있는 첫 이벤트는 `thread.started`여야 한다. 신원이 서기 전에 온 이벤트는
        // 비가역 실패이고, 내용·도구 payload를 **전달하지 않는다**(status/assistant/unknown/error 전부).
        // 실패가 이미 기록됐으면 뒤늦은 `thread.started`도 신원을 세우지 못한다(되돌릴 수 없다).
        if (!this.session && (raw.type !== "thread.started" || this.failure)) {
            if (!this.failure) {
                out.push(this.marker("missing_session_id", { codexType: bounded(raw.type, 64) }));
                this.fail("missing_session_id", "");
            }
            return;
        }
        // 종료 뒤에 오는 이벤트는 신원·최종 메시지를 바꾸지 못한다(중복 종료는 아래에서 실패로 잡힌다).
        const postTerminal = this.terminalSeen;
        switch (raw.type) {
            case "thread.started": {
                // 필드명 미확정 구간 — 별칭을 모두 받는다. 값은 정규 UUID만 인정한다.
                const id = raw.thread_id ?? raw.session_id ?? raw.id;
                if (postTerminal) {
                    out.push(this.marker("post_terminal_event", { codexType: "thread.started" }));
                    this.fail("post_terminal_event", "");
                    return;
                }
                if (typeof id !== "string" || !CODEX_SESSION_ID_RE.test(id)) {
                    out.push(this.marker("invalid_session_id"));
                    this.fail("invalid_session_id", "");
                    return;
                }
                // resume 기대 신원과 다른 thread다 → **init을 만들기 전에** 봉인한다. marker·result는 기대 UUID에 묶고,
                // 관측된 id는 어떤 이벤트에도 싣지 않는다(다른 thread의 신원조차 흘리지 않는다).
                if (this.ctx.expectedSessionId !== undefined && id !== this.ctx.expectedSessionId) {
                    this.session = this.ctx.expectedSessionId;
                    this.sealed = true;
                    out.push(this.marker("session_identity_conflict"));
                    this.fail("session_identity_conflict", "");
                    return;
                }
                if (this.session && this.session !== id) {
                    out.push(this.marker("conflicting_session_id"));
                    this.fail("conflicting_session_id", "");
                    return;
                }
                if (this.session === id) {
                    out.push(this.marker("duplicate_session_id"));
                    this.fail("duplicate_session_id", "");
                    return;
                }
                this.session = id;
                out.push({
                    kind: "init",
                    sessionId: this.session,
                    model: this.ctx.model,
                    cwd: this.ctx.cwd,
                    permissionMode: this.ctx.sandbox,
                    tools: [],
                    mcpServers: [], // strict empty MCP — 이 provider는 MCP 서버를 붙이지 않는다.
                    raw: meta("thread.started"),
                });
                return;
            }
            case "turn.started":
                out.push({ kind: "status", sessionId: this.session, status: "turn_started", raw: meta("turn.started") });
                return;
            case "item.started":
            case "item.updated": {
                const item = (raw.item ?? {});
                const itemType = bounded(item.item_type ?? item.type, 64) || "unknown";
                if (itemType === "mcp_tool_call")
                    return this.mcpViolation(out);
                // 진행 신호만 낸다(추론 원문·부분 텍스트는 싣지 않는다).
                out.push({
                    kind: "status",
                    sessionId: this.session,
                    status: `${raw.type}:${itemType}`,
                    raw: meta(raw.type, { itemType }),
                });
                return;
            }
            case "item.completed":
                return this.itemCompleted(raw, postTerminal, out);
            case "turn.completed":
                if (!this.success && !this.failure)
                    this.usage = usageOf(raw.usage);
                this.recordTerminal({ reason: "turn_completed", permission: false, text: "" }, false, out);
                return;
            case "turn.failed": {
                const err = (raw.error ?? {});
                const text = summarizeError(err.message ?? raw.message);
                this.recordTerminal({ reason: "turn_failed", permission: looksLikePermissionFailure(text), text }, true, out);
                return;
            }
            case "error": {
                const text = summarizeError(raw.message ?? raw.error?.message);
                this.recordTerminal({ reason: "error", permission: looksLikePermissionFailure(text), text }, true, out);
                return;
            }
            default:
                // 전방 호환: **형태가 유효한** 모르는 타입만 표시로 남긴다. payload는 싣지 않는다.
                out.push({
                    kind: "unknown",
                    type: bounded(raw.type, 64),
                    subtype: undefined,
                    sessionId: this.session,
                    raw: meta(raw.type),
                });
                return;
        }
    }
    itemCompleted(raw, postTerminal, out) {
        const item = (raw.item ?? {});
        const itemType = bounded(item.item_type ?? item.type, 64) || "unknown";
        const id = bounded(item.id, 128);
        if (itemType === "mcp_tool_call")
            return this.mcpViolation(out);
        if (postTerminal) {
            out.push(this.marker("post_terminal_event", { codexType: "item.completed", itemType }));
            this.fail("post_terminal_event", "");
            return;
        }
        switch (itemType) {
            case "agent_message": {
                const text = bounded(item.text ?? item.message, MAX_TEXT_CHARS);
                this.lastMessage = text; // 최종 결과 텍스트(= --output-schema 사용 시 구조화 출력 본문)
                out.push({
                    kind: "assistant",
                    sessionId: this.session,
                    text,
                    toolUses: [],
                    stopReason: null,
                    raw: meta("item.completed", { itemType, textChars: text.length }),
                });
                return;
            }
            case "reasoning":
                // 추론은 진행 신호로만 남긴다 — 원문은 어디에도 싣지 않는다.
                out.push({ kind: "status", sessionId: this.session, status: "reasoning", raw: meta("item.completed", { itemType }) });
                return;
            case "command_execution": {
                const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
                const status = bounded(item.status, 32);
                // 명령 문자열은 넣지 않는다(길이만). 승인·감사에 필요한 것은 상태와 종료 코드다.
                const tool = {
                    id,
                    name: "command_execution",
                    input: { status, exitCode, commandChars: typeof item.command === "string" ? item.command.length : 0 },
                };
                out.push({
                    kind: "assistant",
                    sessionId: this.session,
                    text: "",
                    toolUses: [tool],
                    stopReason: null,
                    raw: meta("item.completed", { itemType, status, exitCode }),
                });
                return;
            }
            case "file_change": {
                const all = Array.isArray(item.changes) ? item.changes : [];
                const changes = all.slice(0, MAX_CHANGES).map((c) => {
                    const o = (c ?? {});
                    return { path: bounded(o.path, 256), kind: bounded(o.kind, 32) };
                });
                const tool = {
                    id,
                    name: "file_change",
                    input: { status: bounded(item.status, 32), changes, truncated: all.length > MAX_CHANGES },
                };
                out.push({
                    kind: "assistant",
                    sessionId: this.session,
                    text: "",
                    toolUses: [tool],
                    stopReason: null,
                    raw: meta("item.completed", { itemType, changeCount: changes.length }),
                });
                return;
            }
            default:
                out.push({
                    kind: "unknown",
                    type: `item.completed:${itemType}`,
                    sessionId: this.session,
                    raw: meta("item.completed", { itemType }),
                });
                return;
        }
    }
    /** MCP 호출 관측 = 비가역 실패. 이후 어떤 성공 이벤트도 이것을 뒤집지 못한다. */
    mcpViolation(out) {
        out.push(this.marker("mcp_call_observed"));
        this.fail("mcp_call_observed", "MCP 호출이 관측됐다(strict empty MCP 위반)");
    }
    /**
     * 종료 이벤트 기록. 첫 성공은 채택하고, **두 번째 종료 이벤트는 종류와 무관하게 프로토콜 실패**다
     * (중복·모순 모두). 실패 종료 이벤트는 언제 와도 비가역 실패다.
     */
    recordTerminal(o, isFailure, out) {
        if (this.terminalSeen) {
            out.push(this.marker("duplicate_terminal", { codexType: o.reason }));
            // 같은 종류가 또 오면 duplicate, 성공↔실패가 엇갈리면 conflicting. 첫 실패가 이미 있으면 그것이 이긴다.
            this.fail(this.success && !isFailure ? "duplicate_terminal" : "conflicting_terminal", o.text, o.permission);
            return;
        }
        this.terminalSeen = true;
        if (isFailure)
            this.fail(o.reason, o.text, o.permission);
        else
            this.success = o;
    }
}
