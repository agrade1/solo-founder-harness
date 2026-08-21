import { sanitizeValue, MAX_SANITIZE_DEPTH } from "./trace.js";
import { collectSecretValues, redactSecrets } from "./redact.js";
import type { RunEvent } from "../core/progress.js";

/**
 * [M3b.1] Claude Code Hook payload → 공통 ToolTrace 이벤트(JSONL) 정규화 (offline 기반).
 *
 * 실제 TUI/handoff는 여기서 다루지 않는다. 이 모듈은 순수 정규화·redaction·매핑만 한다.
 *
 * 승인 의미의 한계(중요):
 *  - PermissionRequest payload에는 correlation ID(tool_use_id)가 없다 → callId=null.
 *    permission_requested만 pending_permission으로 기록하고 승인/거부 결과를 유추하지 않는다.
 *    Hook으로 수동 승인/거부 결과를 관측할 수 없음을 permissionOutcomeObservable:false로 명시.
 *  - PermissionDenied는 auto-mode denial(denialMode:"auto")로만 기록한다.
 *  - PostToolUse 발생은 "실행됐다"는 사실일 뿐, 특정 PermissionRequest와 정확히 연결됐다고 주장하지 않는다.
 *  - 수동 거부를 denied로 추측하지 않는다. SessionEnd는 수동 승인/거부 결과를 계산하지 않는다.
 */

export const TOOL_TRACE_VERSION = "1";
export const TOOL_TRACE_SOURCE = "claude-code-hook";

// 크기 상한 (UTF-8 byte 기준). 병렬 append 라인이 작게 유지되도록.
export const MAX_INPUT_BYTES = 2048;
export const MAX_ERROR_BYTES = 1024;
export const MAX_STDIN_BYTES = 1_000_000;
export const MAX_INPUT_DEPTH = MAX_SANITIZE_DEPTH;

export type ToolTraceEventType =
  | "tool_requested"
  | "permission_requested"
  | "tool_succeeded"
  | "tool_failed"
  | "tool_denied"
  | "session_end";

export type ToolTraceStatus = "requested" | "pending_permission" | "succeeded" | "failed" | "denied" | "ended";

/** 지원하는 Hook 종류. (실제 Claude Hook 이름과의 대응·가용성은 M3b.2에서 실측) */
export type HookKind =
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionDenied"
  | "SessionEnd";

/** tool_use_id(correlation ID)를 반드시 갖는 Hook. PermissionRequest·SessionEnd는 제외. */
export const TOOL_USE_ID_HOOKS: HookKind[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"];

/** 공통 ToolTrace 레코드. 이벤트별로 해당 없는 필드는 null. raw tool_response·transcript_path는 담지 않는다. */
export interface ToolTraceRecord {
  version: string;
  timestamp: string;
  source: typeof TOOL_TRACE_SOURCE;
  profileId: string;
  sessionId: string;
  callId: string | null; // correlation ID(tool_use_id). PermissionRequest/SessionEnd는 null (synthetic 생성 금지).
  event: ToolTraceEventType;
  status: ToolTraceStatus;
  toolName: string | null;
  server: string | null; // 전달된 exact tool map으로만 판정(Object.hasOwn). 미매핑이면 null (추측 금지).
  durationMs: number | null;
  resultBytes: number | null; // tool_response는 byte 수만.
  sanitizedInput: unknown | null;
  inputTruncated: boolean;
  error: string | null; // redacted + 상한
  reason: string | null; // redacted (denied)
  denialMode: "auto" | null; // PermissionDenied만 "auto"
  sessionEndReason: string | null; // redacted (session_end)
  // permission_requested만 false: Hook으로 수동 승인/거부 결과를 관측할 수 없음을 명시. 그 외 null.
  permissionOutcomeObservable: false | null;
}

export interface CollectorConfig {
  tracePath: string;
  profileId: string;
  secretRefs: string[]; // 이름만. 값은 process.env에서 조회.
  toolMap: Record<string, string>; // toolName → server (exact).
}

/** payload 계약 위반 (typed). 메시지에 payload/secret 내용을 담지 않는다. */
export class HookPayloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HookPayloadError";
    this.code = code;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const TRUNC = "…[truncated]";
const TRUNC_BYTES = Buffer.byteLength(TRUNC, "utf8");

/** UTF-8 byte 기준으로 안전 절삭 (멀티바이트 경계 보존, 마커 포함 총합 ≤ maxBytes). */
function truncateUtf8(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return { value: s, truncated: false };
  const budget = Math.max(0, maxBytes - TRUNC_BYTES);
  const buf = Buffer.from(s, "utf8");
  let end = Math.min(budget, buf.length);
  // 멀티바이트 시퀀스 중간이면(연속 바이트 0b10xxxxxx) 경계까지 back-up.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { value: buf.subarray(0, end).toString("utf8") + TRUNC, truncated: true };
}

/** 문자열 redaction + UTF-8 byte 상한. */
function redactAndCap(v: unknown, secretValues: string[], maxBytes: number): string | null {
  const s = str(v);
  if (s === null) return null;
  return truncateUtf8(redactSecrets(s, secretValues), maxBytes).value;
}

/** sanitizedInput: depth 상한 재귀 sanitize 후 byte 상한 초과 시 절삭 문자열로 대체. */
function sanitizeInput(raw: unknown, secretValues: string[]): { value: unknown; truncated: boolean } {
  if (raw === undefined || raw === null) return { value: null, truncated: false };
  const clean = sanitizeValue(raw, { secretValues, maxDepth: MAX_INPUT_DEPTH });
  const serialized = JSON.stringify(clean) ?? "null";
  if (Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) {
    return { value: truncateUtf8(serialized, MAX_INPUT_BYTES).value, truncated: true };
  }
  return { value: clean, truncated: false };
}

function byteLen(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return Buffer.byteLength(s, "utf8");
}

/**
 * payload 계약 검증. 위반 시 HookPayloadError throw.
 *  - hook_event_name이 기대 HookKind와 정확 일치, session_id 필수(전 Hook).
 *  - PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied: tool_name, tool_use_id 필수.
 *  - PermissionRequest: tool_name, tool_input 필수 (tool_use_id 없음 — 공식 payload에 correlation ID 부재).
 *  - SessionEnd: tool 필드 불요.
 */
export function validatePayload(hookKind: HookKind, payload: Record<string, unknown>): void {
  if (payload.hook_event_name !== hookKind) {
    throw new HookPayloadError("hook_event_mismatch", "hook_event_name이 기대 HookKind와 일치하지 않음");
  }
  if (!str(payload.session_id)) {
    throw new HookPayloadError("missing_session_id", "session_id 필수");
  }
  if (hookKind === "PermissionRequest") {
    if (!str(payload.tool_name)) throw new HookPayloadError("missing_tool_name", "tool_name 필수");
    if (payload.tool_input === undefined || payload.tool_input === null || typeof payload.tool_input !== "object") {
      throw new HookPayloadError("missing_tool_input", "tool_input 필수(PermissionRequest)");
    }
    return; // tool_use_id 요구하지 않음
  }
  if (TOOL_USE_ID_HOOKS.includes(hookKind)) {
    if (!str(payload.tool_name)) throw new HookPayloadError("missing_tool_name", "tool_name 필수(tool hook)");
    if (!str(payload.tool_use_id)) throw new HookPayloadError("missing_tool_use_id", "tool_use_id 필수(tool hook)");
  }
}

/**
 * Hook payload를 ToolTraceRecord로 정규화한다. deny=true면 PreToolUse deny matcher(tool_denied).
 * 계약 위반 시 HookPayloadError throw. transcript_path·raw tool_response는 읽지 않는다(byte 수만).
 */
export function normalizeHook(
  hookKind: HookKind,
  deny: boolean,
  payload: Record<string, unknown>,
  config: CollectorConfig,
  now: string,
): ToolTraceRecord {
  if (deny && hookKind !== "PreToolUse") {
    throw new HookPayloadError("deny_only_pretooluse", "deny는 PreToolUse에서만 허용");
  }
  validatePayload(hookKind, payload);

  const secretValues = collectSecretValues(config.secretRefs);
  const sessionId = str(payload.session_id) as string;
  const toolName = str(payload.tool_name);
  // exact tool map: 상속 key(toString/constructor 등) 배제 (Object.hasOwn + string 값만).
  const server =
    toolName && Object.hasOwn(config.toolMap, toolName) && typeof config.toolMap[toolName] === "string"
      ? config.toolMap[toolName]
      : null;
  const callId = str(payload.tool_use_id) ?? null; // synthetic 생성 금지 — PermissionRequest/SessionEnd는 null

  const base: Omit<ToolTraceRecord, "event" | "status"> = {
    version: TOOL_TRACE_VERSION,
    timestamp: now,
    source: TOOL_TRACE_SOURCE,
    profileId: config.profileId,
    sessionId,
    callId,
    toolName,
    server,
    durationMs: null,
    resultBytes: null,
    sanitizedInput: null,
    inputTruncated: false,
    error: null,
    reason: null,
    denialMode: null,
    sessionEndReason: null,
    permissionOutcomeObservable: null,
  };

  const withInput = () => {
    const { value, truncated } = sanitizeInput(payload.tool_input, secretValues);
    return { sanitizedInput: value, inputTruncated: truncated };
  };

  switch (hookKind) {
    case "PreToolUse":
      return deny
        ? { ...base, ...withInput(), event: "tool_denied", status: "denied", reason: "policy_denied (PreToolUse deny matcher)" }
        : { ...base, ...withInput(), event: "tool_requested", status: "requested" };
    case "PermissionRequest":
      // callId=null(correlation ID 없음), 결과 관측 불가 명시. 승인/거부 유추 금지.
      return { ...base, ...withInput(), event: "permission_requested", status: "pending_permission", permissionOutcomeObservable: false };
    case "PostToolUse":
      return { ...base, ...withInput(), event: "tool_succeeded", status: "succeeded", durationMs: num(payload.duration_ms), resultBytes: byteLen(payload.tool_response) };
    case "PostToolUseFailure":
      return {
        ...base,
        ...withInput(),
        event: "tool_failed",
        status: "failed",
        durationMs: num(payload.duration_ms),
        resultBytes: byteLen(payload.tool_response),
        error: redactAndCap(payload.error ?? payload.message, secretValues, MAX_ERROR_BYTES),
      };
    case "PermissionDenied":
      return { ...base, ...withInput(), event: "tool_denied", status: "denied", reason: redactAndCap(payload.reason ?? payload.message, secretValues, MAX_ERROR_BYTES), denialMode: "auto" };
    case "SessionEnd":
      // 수동 승인/거부 결과를 계산하지 않는다 — session 종료 사실만.
      return {
        ...base,
        event: "session_end",
        status: "ended",
        toolName: null,
        callId: null,
        sessionEndReason: redactAndCap(payload.reason ?? payload.message, secretValues, MAX_ERROR_BYTES),
      };
  }
}

/**
 * ToolTrace → RunEvent 매핑. **M3b.1은 매핑 정의만** — post-session/테스트용이며 TUI 중 실시간 emit하지 않는다.
 *  tool_requested → tool_start / tool_succeeded·tool_failed → tool_end / tool_denied → tool_denied
 *  permission_requested·session_end → RunEvent 없음(null).
 */
export function toRunEvent(rec: ToolTraceRecord): RunEvent | null {
  switch (rec.event) {
    case "tool_requested":
      return { type: "tool_start", server: rec.server ?? "builtin", tool: rec.toolName ?? "", callId: rec.callId ?? "" };
    case "tool_succeeded":
      return { type: "tool_end", callId: rec.callId ?? "", ok: true, elapsedMs: rec.durationMs ?? 0, resultBytes: rec.resultBytes ?? undefined };
    case "tool_failed":
      return { type: "tool_end", callId: rec.callId ?? "", ok: false, elapsedMs: rec.durationMs ?? 0, resultBytes: rec.resultBytes ?? undefined };
    case "tool_denied":
      return { type: "tool_denied", server: rec.server ?? "builtin", tool: rec.toolName ?? "", reason: rec.reason ?? "" };
    case "permission_requested":
    case "session_end":
      return null;
  }
}
