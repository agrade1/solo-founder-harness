import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { collect, runCollector, parseArgs, parseConfig, type CollectInput } from "./hookCollector.js";
import type { CollectorConfig, HookKind } from "./toolTrace.js";

const NOW = "2026-01-01T00:00:00.000Z";
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 계약 준수 payload 자동 조립.
 * PermissionRequest 공식 payload에는 correlation ID(tool_use_id)가 없다 → 자동 추가하지 않는다(tool_input만).
 */
function payload(kind: HookKind, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { hook_event_name: kind, session_id: "s" };
  if (kind === "PermissionRequest") {
    base.tool_name = "Read";
    base.tool_input = {};
  } else if (kind !== "SessionEnd") {
    base.tool_name = "Read";
    base.tool_use_id = "c1";
  }
  return { ...base, ...over };
}
function run(over: { hookKind?: HookKind; deny?: boolean; payloadRaw?: string; payload?: Record<string, unknown>; tracePath: string; secretRefs?: string[]; toolMap?: Record<string, string> }) {
  const hookKind = over.hookKind ?? "PreToolUse";
  const config: CollectorConfig = { tracePath: over.tracePath, profileId: "p", secretRefs: over.secretRefs ?? [], toolMap: over.toolMap ?? {} };
  const input: CollectInput = {
    hookKind,
    deny: over.deny ?? false,
    payloadRaw: over.payloadRaw ?? JSON.stringify(over.payload ?? payload(hookKind, over.deny ? { tool_name: "Bash" } : {})),
    config,
    now: NOW,
  };
  return collect(input);
}

test("[M3b.1] parseArgs: deny는 PreToolUse만, 알 수 없는 인자 거부", () => {
  assert.deepEqual(parseArgs(["n", "x", "PreToolUse"]), { hookKind: "PreToolUse", deny: false });
  assert.deepEqual(parseArgs(["n", "x", "PreToolUse", "deny"]), { hookKind: "PreToolUse", deny: true });
  assert.equal(parseArgs(["n", "x", "PostToolUse", "deny"]), null); // deny는 PreToolUse만
  assert.equal(parseArgs(["n", "x", "PreToolUse", "bogus"]), null);
  assert.equal(parseArgs(["n", "x", "Nope"]), null);
});

test("[M3b.1] parseConfig 엄격 검증 (fallback 금지)", () => {
  const ok = parseConfig({ HARNESS_TOOL_TRACE_PATH: "/t", HARNESS_TOOL_PROFILE_ID: "p", HARNESS_TOOL_SECRET_REFS: '["A_KEY"]', HARNESS_TOOL_MAP: '{"m":"s"}' } as NodeJS.ProcessEnv);
  assert.ok(ok.ok && ok.config.secretRefs[0] === "A_KEY");
  assert.equal((parseConfig({} as NodeJS.ProcessEnv) as { ok: false; reason: string }).reason, "missing_trace_path");
  assert.equal((parseConfig({ HARNESS_TOOL_TRACE_PATH: "/t" } as NodeJS.ProcessEnv) as { ok: false; reason: string }).reason, "missing_profile_id");
  const badRefsJson = parseConfig({ HARNESS_TOOL_TRACE_PATH: "/t", HARNESS_TOOL_PROFILE_ID: "p", HARNESS_TOOL_SECRET_REFS: "{}" } as NodeJS.ProcessEnv);
  assert.equal((badRefsJson as { ok: false; reason: string }).reason, "secret_refs_invalid"); // {} 은 배열 아님
  const badRefName = parseConfig({ HARNESS_TOOL_TRACE_PATH: "/t", HARNESS_TOOL_PROFILE_ID: "p", HARNESS_TOOL_SECRET_REFS: '["lower"]' } as NodeJS.ProcessEnv);
  assert.equal((badRefName as { ok: false; reason: string }).reason, "secret_refs_invalid");
  const badMap = parseConfig({ HARNESS_TOOL_TRACE_PATH: "/t", HARNESS_TOOL_PROFILE_ID: "p", HARNESS_TOOL_MAP: '{"m":1}' } as NodeJS.ProcessEnv);
  assert.equal((badMap as { ok: false; reason: string }).reason, "tool_map_invalid");
});

test("[M3b.1] runCollector: malformed SECRET_REFS={} + PreToolUse → exit 2", () => {
  const res = runCollector({
    argv: ["n", "x", "PreToolUse"],
    env: { HARNESS_TOOL_TRACE_PATH: "/t", HARNESS_TOOL_PROFILE_ID: "p", HARNESS_TOOL_SECRET_REFS: "{}" } as NodeJS.ProcessEnv,
    payloadRaw: JSON.stringify(payload("PreToolUse")),
    now: NOW,
  });
  assert.equal(res.exitCode, 2);
  assert.ok(res.stderr.join("").includes("config invalid"));
});

test("[M3b.1] runCollector: config 실패도 사후 Hook은 exit 1", () => {
  const res = runCollector({ argv: ["n", "x", "SessionEnd"], env: {} as NodeJS.ProcessEnv, payloadRaw: "{}", now: NOW });
  assert.equal(res.exitCode, 1);
});

test("[M3b.1] PreToolUse audit 성공 → exit 0, 1줄 tool_requested", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    const r = run({ hookKind: "PreToolUse", tracePath: tp });
    assert.equal(r.exitCode, 0);
    assert.equal(JSON.parse(readFileSync(tp, "utf8").trim()).event, "tool_requested");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] PreToolUse deny → tool_denied 기록 후 exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    const r = run({ hookKind: "PreToolUse", deny: true, tracePath: tp });
    assert.equal(r.exitCode, 2);
    assert.equal(r.record?.event, "tool_denied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] missing/mismatched hook_event_name → PreToolUse exit 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    // hook_event_name 누락
    assert.equal(run({ hookKind: "PreToolUse", tracePath: tp, payload: { session_id: "s", tool_name: "Read", tool_use_id: "c1" } }).exitCode, 2);
    // 불일치
    assert.equal(run({ hookKind: "PreToolUse", tracePath: tp, payload: { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Read", tool_use_id: "c1" } }).exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] 공식 PermissionRequest payload → exit 0, callId=null·pending_permission·관측불가 기록", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    // 공식 payload: tool_use_id 없음, tool_name+tool_input만.
    const r = run({ hookKind: "PermissionRequest", tracePath: tp, payload: { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Read", tool_input: {} } });
    assert.equal(r.exitCode, 0);
    assert.equal(r.wrote, true);
    const rec = JSON.parse(readFileSync(tp, "utf8").trim());
    assert.equal(rec.event, "permission_requested");
    assert.equal(rec.status, "pending_permission");
    assert.equal(rec.callId, null); // synthetic correlation ID 생성 금지
    assert.equal(rec.permissionOutcomeObservable, false); // 수동 승인/거부 관측 불가
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] PermissionRequest tool_input 누락 → blocking failure(exit 2), 미기록", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    // tool_input 누락 → 계약 위반, PermissionRequest는 blocking
    const r = run({ hookKind: "PermissionRequest", tracePath: tp, payload: { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Read" } });
    assert.equal(r.exitCode, 2);
    assert.equal(r.wrote, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] PreToolUse audit 기록 실패 → exit 2, 사후 Hook 실패 → exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const filePath = join(dir, "afile");
    writeFileSync(filePath, "x");
    const tp = join(filePath, "sub", "t.jsonl"); // 부모가 파일 → mkdir 실패
    assert.equal(run({ hookKind: "PreToolUse", tracePath: tp }).exitCode, 2);
    assert.equal(run({ hookKind: "PostToolUse", tracePath: tp, payload: payload("PostToolUse", { tool_response: "ok" }) }).exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] malformed/oversized stdin: PreToolUse exit 2, PostToolUse exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    assert.equal(run({ hookKind: "PreToolUse", payloadRaw: "not json{{{", tracePath: tp }).exitCode, 2);
    assert.equal(run({ hookKind: "PostToolUse", payloadRaw: "not json{{{", tracePath: tp }).exitCode, 1);
    assert.equal(run({ hookKind: "PreToolUse", payloadRaw: "[1,2]", tracePath: tp }).exitCode, 2);
    const huge = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Read", tool_use_id: "c1", tool_input: { blob: "a".repeat(1_100_000) } });
    assert.equal(run({ hookKind: "PreToolUse", payloadRaw: huge, tracePath: tp }).exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] stderr에 stack/secret 없음", () => {
  const prev = process.env.LEAK;
  process.env.LEAK = "sk-secret-XYZ";
  try {
    const dir = mkdtempSync(join(tmpdir(), "hc-"));
    try {
      const tp = join(dir, "t.jsonl");
      const r = run({ hookKind: "PreToolUse", payloadRaw: "bad json", tracePath: tp, secretRefs: ["LEAK"] });
      const s = r.stderr.join("\n");
      assert.ok(!s.includes("sk-secret-XYZ"), "secret 없음");
      assert.ok(!/\bat \/|\.ts:\d+|Error:/.test(s), "stack 흔적 없음");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (prev === undefined) delete process.env.LEAK;
    else process.env.LEAK = prev;
  }
});

test("[M3b.1] SessionEnd는 종료 사실만 기록 (승인/거부 결과·unresolved 추측 안 함)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    run({ hookKind: "PermissionRequest", tracePath: tp, payload: payload("PermissionRequest") });
    const r = run({ hookKind: "SessionEnd", tracePath: tp, payload: { hook_event_name: "SessionEnd", session_id: "s", reason: "clear" } });
    assert.equal(r.exitCode, 0);
    assert.equal(r.record?.event, "session_end");
    assert.equal(r.record?.status, "ended");
    // unresolved 목록·승인 결과를 계산/기록하지 않는다.
    assert.ok(!("unresolvedPermissionCallIds" in (r.record as object)));
    assert.equal(r.record?.callId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] toolMap 상속 key(toString 등) 오인 방지 → server=null 기록", () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  try {
    const tp = join(dir, "t.jsonl");
    const r = run({ hookKind: "PreToolUse", tracePath: tp, toolMap: { mcp__srv__t: "srv" }, payload: payload("PreToolUse", { tool_name: "toString" }) });
    assert.equal(r.exitCode, 0);
    assert.equal(r.record?.server, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M3b.1] 병렬 collector append → 모든 JSONL 라인이 유효", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hc-par-"));
  const tp = join(dir, "trace.jsonl");
  const N = 8;
  const collectorPath = join(HERE, "hookCollector.ts");
  const pl = JSON.stringify(payload("PostToolUse", { tool_response: "ok", duration_ms: 1 }));
  try {
    await Promise.all(
      Array.from({ length: N }, () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn("npx", ["tsx", collectorPath, "PostToolUse"], {
            env: { ...process.env, HARNESS_TOOL_TRACE_PATH: tp, HARNESS_TOOL_PROFILE_ID: "p", HARNESS_TOOL_SECRET_REFS: "[]", HARNESS_TOOL_MAP: "{}" },
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.on("error", reject);
          child.on("close", () => resolve());
          child.stdin.end(pl);
        }),
      ),
    );
    const lines = readFileSync(tp, "utf8").trim().split("\n");
    assert.equal(lines.length, N);
    for (const l of lines) assert.equal(JSON.parse(l).event, "tool_succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
