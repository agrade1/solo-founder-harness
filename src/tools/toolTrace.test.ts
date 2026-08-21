import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeHook,
  toRunEvent,
  validatePayload,
  HookPayloadError,
  TOOL_TRACE_VERSION,
  MAX_INPUT_BYTES,
  MAX_ERROR_BYTES,
  type CollectorConfig,
  type HookKind,
} from "./toolTrace.js";

const NOW = "2026-01-01T00:00:00.000Z";
function cfg(over: Partial<CollectorConfig> = {}): CollectorConfig {
  return { tracePath: "/tmp/x.jsonl", profileId: "p1", secretRefs: [], toolMap: {}, ...over };
}
/**
 * 계약 준수 payload를 자동 조립(hook_event_name/session_id/tool 필드). over로 덮어쓴다.
 * PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없다 → 넣지 않는다(tool_input만).
 */
function norm(kind: HookKind, over: Record<string, unknown> = {}, c = cfg(), deny = false) {
  const base: Record<string, unknown> = { hook_event_name: kind, session_id: "s" };
  if (kind === "PermissionRequest") {
    base.tool_name = "Read";
    base.tool_input = {};
  } else if (kind !== "SessionEnd") {
    base.tool_name = "Read";
    base.tool_use_id = "c1";
  }
  return normalizeHook(kind, deny, { ...base, ...over }, c, NOW);
}

test("[M3b.1] PreToolUse → tool_requested, 공통 필드", () => {
  const r = norm("PreToolUse", { tool_name: "mcp__srv__t", tool_use_id: "c1", tool_input: { a: 1 } }, cfg({ toolMap: { mcp__srv__t: "srv" } }));
  assert.equal(r.event, "tool_requested");
  assert.equal(r.version, TOOL_TRACE_VERSION);
  assert.equal(r.source, "claude-code-hook");
  assert.equal(r.callId, "c1");
  assert.equal(r.server, "srv");
  assert.deepEqual(r.sanitizedInput, { a: 1 });
});

test("[M3b.1] server는 exact tool map으로만 판정 (이름 추측 금지)", () => {
  const c = cfg({ toolMap: { mcp__srv__t: "srv" } });
  assert.equal(norm("PreToolUse", { tool_name: "mcp__other__x" }, c).server, null);
  assert.equal(norm("PreToolUse", { tool_name: "Read" }, c).server, null);
});

test("[M3b.1] toolMap 상속 key(toString/constructor 등) 오인 방지 → server=null", () => {
  const c = cfg({ toolMap: { mcp__srv__t: "srv" } });
  for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    assert.equal(norm("PreToolUse", { tool_name: inherited }, c).server, null, `${inherited}는 own key 아님`);
  }
});

test("[M3b.1] transcript_path·raw tool_response 미저장, byte 수만", () => {
  const r = norm("PostToolUse", { transcript_path: "/secret/t.md", tool_input: { path: "x" }, tool_response: { content: "0123456789" } });
  const s = JSON.stringify(r);
  assert.ok(!s.includes("transcript"));
  assert.ok(!s.includes("0123456789"));
  assert.ok((r.resultBytes ?? 0) > 0);
});

test("[M3b.1] 민감 key 재귀 마스킹 + URL query + 중첩 배열", () => {
  const r = norm("PreToolUse", {
    tool_input: { authorization: "Bearer abc", nested: { token: "t", normal: "keep" }, cookie: "c", url: "https://x?token=abc&api_key=def", list: [{ secret: "s" }, "password=pw"] },
  });
  const si = r.sanitizedInput as Record<string, unknown>;
  assert.equal(si.authorization, "***");
  assert.equal(si.cookie, "***");
  assert.equal((si.nested as Record<string, unknown>).token, "***");
  assert.equal((si.nested as Record<string, unknown>).normal, "keep");
  assert.match(si.url as string, /token=\*\*\*/);
  assert.match(si.url as string, /api_key=\*\*\*/);
  assert.equal(((si.list as Record<string, unknown>[])[0]).secret, "***");
  assert.match((si.list as string[])[1], /password=\*\*\*/);
});

test("[M3b.1] secretRefs 실제 환경값도 redaction", () => {
  const prev = process.env.M3B_SECRET;
  process.env.M3B_SECRET = "supersecretvalue";
  try {
    const r = norm("PreToolUse", { tool_input: { note: "x supersecretvalue y" } }, cfg({ secretRefs: ["M3B_SECRET"] }));
    assert.ok(!JSON.stringify(r).includes("supersecretvalue"));
  } finally {
    if (prev === undefined) delete process.env.M3B_SECRET;
    else process.env.M3B_SECRET = prev;
  }
});

test("[M3b.1] UTF-8 byte 상한 (한글/emoji) — 입력·오류 모두 byte 기준", () => {
  const hangul = "가".repeat(2000); // 3 bytes each = 6000B
  const r1 = norm("PreToolUse", { tool_input: { blob: hangul } });
  assert.equal(r1.inputTruncated, true);
  assert.ok(Buffer.byteLength(r1.sanitizedInput as string, "utf8") <= MAX_INPUT_BYTES, "입력 byte 상한 준수");

  const emoji = "😀".repeat(1000); // 4 bytes each
  const r2 = norm("PostToolUseFailure", { error: emoji });
  assert.ok(Buffer.byteLength(r2.error as string, "utf8") <= MAX_ERROR_BYTES, "오류 byte 상한 준수");
  assert.ok((r2.error as string).endsWith("…[truncated]"));
  // 멀티바이트 경계 보존 → 유효 UTF-8 (replacement char 없음)
  assert.ok(!(r2.error as string).includes("�"));
});

test("[M3b.1] 재귀 depth 상한 (stack overflow 방지)", () => {
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 5000; i++) deep = { n: deep };
  assert.doesNotThrow(() => norm("PreToolUse", { tool_input: deep }));
  const r = norm("PreToolUse", { tool_input: deep });
  assert.ok(JSON.stringify(r).includes("[max-depth]"), "depth 상한에서 절단");
});

test("[M3b.1] 승인 의미: 공식 PermissionRequest payload는 요청만, callId=null, 결과 미유추", () => {
  // 공식 payload에는 correlation ID가 없다: tool_name + tool_input만.
  const r = normalizeHook("PermissionRequest", false, { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Read", tool_input: {} }, cfg(), NOW);
  assert.equal(r.event, "permission_requested");
  assert.equal(r.status, "pending_permission");
  assert.equal(r.callId, null); // synthetic correlation ID 생성 금지
  assert.equal(r.permissionOutcomeObservable, false); // Hook으로 수동 승인/거부 관측 불가
  assert.equal(r.reason, null);
  assert.equal(r.denialMode, null);
});

test("[M3b.1] PermissionDenied=auto, PreToolUse deny=정책", () => {
  assert.equal(norm("PermissionDenied", { tool_name: "Bash", reason: "auto" }).denialMode, "auto");
  const policy = norm("PreToolUse", { tool_name: "Bash" }, cfg(), true);
  assert.equal(policy.event, "tool_denied");
  assert.equal(policy.denialMode, null);
  assert.match(policy.reason as string, /policy_denied/);
});

// ── 계약 검증 ─────────────────────────────────────────────────
test("[M3b.1] payload 계약: hook_event_name 누락·불일치 → throw", () => {
  const c = cfg();
  assert.throws(() => normalizeHook("PreToolUse", false, { session_id: "s", tool_name: "Read", tool_use_id: "c1" }, c, NOW), (e: HookPayloadError) => e.code === "hook_event_mismatch");
  assert.throws(() => normalizeHook("PreToolUse", false, { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Read", tool_use_id: "c1" }, c, NOW), (e: HookPayloadError) => e.code === "hook_event_mismatch");
});

test("[M3b.1] payload 계약: session_id 필수, PermissionRequest=tool_name+tool_input, tool hook=tool_use_id", () => {
  const c = cfg();
  assert.throws(() => normalizeHook("PreToolUse", false, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "c1" }, c, NOW), (e: HookPayloadError) => e.code === "missing_session_id");
  // PermissionRequest: tool_name 필수, tool_input 필수. tool_use_id는 요구하지 않음(공식 payload에 부재).
  assert.throws(() => normalizeHook("PermissionRequest", false, { hook_event_name: "PermissionRequest", session_id: "s", tool_input: {} }, c, NOW), (e: HookPayloadError) => e.code === "missing_tool_name");
  assert.throws(() => normalizeHook("PermissionRequest", false, { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Read" }, c, NOW), (e: HookPayloadError) => e.code === "missing_tool_input");
  assert.doesNotThrow(() => normalizeHook("PermissionRequest", false, { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Read", tool_input: {} }, c, NOW));
  // tool hook(PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied)만 tool_use_id 필수.
  assert.throws(() => normalizeHook("PostToolUse", false, { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Read" }, c, NOW), (e: HookPayloadError) => e.code === "missing_tool_use_id");
  // SessionEnd는 tool 필드 불요
  assert.doesNotThrow(() => normalizeHook("SessionEnd", false, { hook_event_name: "SessionEnd", session_id: "s" }, c, NOW));
});

test("[M3b.1] deny는 PreToolUse에서만 허용", () => {
  assert.throws(() => normalizeHook("PostToolUse", true, { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Read", tool_use_id: "c1" }, cfg(), NOW), (e: HookPayloadError) => e.code === "deny_only_pretooluse");
});

test("[M3b.1] validatePayload 단독", () => {
  assert.doesNotThrow(() => validatePayload("SessionEnd", { hook_event_name: "SessionEnd", session_id: "s" }));
  assert.throws(() => validatePayload("SessionEnd", { hook_event_name: "SessionEnd" }));
});

// ── SessionEnd: 종료 사실만, 승인/거부 추측 금지 ────────────────
test("[M3b.1] SessionEnd는 종료 사실만 기록 (unresolved 계산·denied 추측 없음)", () => {
  const r = normalizeHook("SessionEnd", false, { hook_event_name: "SessionEnd", session_id: "s", reason: "clear" }, cfg(), NOW);
  assert.equal(r.event, "session_end");
  assert.equal(r.status, "ended");
  assert.equal(r.sessionEndReason, "clear");
  assert.equal(r.callId, null);
  assert.equal(r.toolName, null);
  // unresolvedPermissionCallIds 필드 자체가 존재하지 않는다 (승인 결과 추측 금지).
  assert.ok(!("unresolvedPermissionCallIds" in r));
  assert.equal(r.permissionOutcomeObservable, null);
});

// ── RunEvent 매핑 (테스트/ post-session 전용) ──────────────────
test("[M3b.1] toRunEvent 매핑", () => {
  const c = cfg({ toolMap: { mcp__srv__t: "srv" } });
  const over = { tool_name: "mcp__srv__t", tool_use_id: "c1" };
  assert.deepEqual(toRunEvent(norm("PreToolUse", over, c)), { type: "tool_start", server: "srv", tool: "mcp__srv__t", callId: "c1" });
  assert.deepEqual(toRunEvent(norm("PostToolUse", { ...over, duration_ms: 12, tool_response: "ok" }, c)), { type: "tool_end", callId: "c1", ok: true, elapsedMs: 12, resultBytes: 2 });
  const failEv = toRunEvent(norm("PostToolUseFailure", { ...over, error: "boom" }, c));
  assert.equal(failEv?.type, "tool_end");
  if (failEv && failEv.type === "tool_end") assert.equal(failEv.ok, false);
  assert.deepEqual(toRunEvent(norm("PermissionDenied", over, c)), { type: "tool_denied", server: "srv", tool: "mcp__srv__t", reason: "" });
  assert.equal(toRunEvent(norm("PermissionRequest", over, c)), null);
  assert.equal(toRunEvent(norm("SessionEnd", {}, c)), null);
});
