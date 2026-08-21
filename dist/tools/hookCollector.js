import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createJsonlWriter } from "./trace.js";
import { collectSecretValues, isValidSecretRef } from "./redact.js";
import { normalizeHook, MAX_STDIN_BYTES } from "./toolTrace.js";
/**
 * [M3b.1] Hook collector. stdin의 Claude Hook payload를 ToolTrace JSONL로 정규화·기록한다.
 *
 * fail-closed 종료 코드:
 *  - PreToolUse / PermissionRequest 의 config/payload/계약/write 실패: exit 2 (실행 차단).
 *  - PreToolUse deny matcher: tool_denied 기록 후 exit 2.
 *  - 그 외 사후 Hook(PostToolUse/Failure/PermissionDenied/SessionEnd) 실패: exit 1 (경고, 원 실행 불변).
 *  - 정상: stdout을 절대 쓰지 않는다.
 * stderr에는 stack/raw payload/env/secret을 출력하지 않는다(짧은 코드만).
 */
const HOOK_KINDS = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "SessionEnd",
];
/** config/payload/계약 실패 시 실행을 차단(exit 2)하는 Hook. */
function isBlocking(hookKind) {
    return hookKind === "PreToolUse" || hookKind === "PermissionRequest";
}
/** argv[2]=hookKind, argv[3]="deny"?. deny는 PreToolUse에서만 허용. 유효하지 않으면 null. */
export function parseArgs(argv) {
    const kind = argv[2];
    if (!kind || !HOOK_KINDS.includes(kind))
        return null;
    const deny = argv[3] === "deny";
    if (argv[3] !== undefined && argv[3] !== "deny")
        return null; // 알 수 없는 3번째 인자
    if (deny && kind !== "PreToolUse")
        return null; // deny는 PreToolUse만
    return { hookKind: kind, deny };
}
/** env(HARNESS_TOOL_*)를 엄격 검증한다. JSON parse fallback 금지 — 잘못된 값은 typed failure. */
export function parseConfig(env) {
    const tracePath = env.HARNESS_TOOL_TRACE_PATH;
    if (!tracePath)
        return { ok: false, reason: "missing_trace_path" };
    const profileId = env.HARNESS_TOOL_PROFILE_ID;
    if (!profileId)
        return { ok: false, reason: "missing_profile_id" };
    let secretRefs = [];
    if (env.HARNESS_TOOL_SECRET_REFS !== undefined) {
        let parsed;
        try {
            parsed = JSON.parse(env.HARNESS_TOOL_SECRET_REFS);
        }
        catch {
            return { ok: false, reason: "secret_refs_not_json" };
        }
        if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string" && isValidSecretRef(x))) {
            return { ok: false, reason: "secret_refs_invalid" };
        }
        secretRefs = parsed;
    }
    let toolMap = {};
    if (env.HARNESS_TOOL_MAP !== undefined) {
        let parsed;
        try {
            parsed = JSON.parse(env.HARNESS_TOOL_MAP);
        }
        catch {
            return { ok: false, reason: "tool_map_not_json" };
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === "string")) {
            return { ok: false, reason: "tool_map_invalid" };
        }
        // 상속 key 오인 방지: null-prototype 맵으로 정규화 (own key만 반영).
        const clean = Object.create(null);
        for (const [k, v] of Object.entries(parsed))
            clean[k] = v;
        toolMap = clean;
    }
    return { ok: true, config: { tracePath, profileId, secretRefs, toolMap } };
}
/** 순수-ish collect: payload 파싱→정규화→JSONL append. */
export function collect(input) {
    const { hookKind, deny, payloadRaw, config, now } = input;
    const failExit = isBlocking(hookKind) ? 2 : 1;
    // stdin 파싱 (malformed / oversized → 실패)
    let payload;
    try {
        if (Buffer.byteLength(payloadRaw, "utf8") > MAX_STDIN_BYTES)
            throw new Error("oversized");
        const parsed = JSON.parse(payloadRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("not_object");
        payload = parsed;
    }
    catch {
        return { exitCode: failExit, record: null, wrote: false, stderr: [`payload 파싱 실패 (${hookKind})`] };
    }
    // 정규화 (계약 위반 시 throw)
    let record;
    try {
        record = normalizeHook(hookKind, deny, payload, config, now);
    }
    catch (e) {
        const code = e.code ?? "normalize_error";
        return { exitCode: failExit, record: null, wrote: false, stderr: [`정규화/계약 실패 (${hookKind}:${code})`] };
    }
    // JSONL 기록 (민감 key + secretRefs 실제 값 + credential 패턴 redaction)
    try {
        createJsonlWriter(config.tracePath, { redact: true, redactValues: collectSecretValues(config.secretRefs) }).append(record);
    }
    catch {
        return { exitCode: failExit, record, wrote: false, stderr: [`기록 실패 (${hookKind}) → ${failExit === 2 ? "차단" : "경고"}`] };
    }
    if (deny)
        return { exitCode: 2, record, wrote: true, stderr: ["PreToolUse deny matcher → tool_denied 기록 후 차단(exit 2)"] };
    return { exitCode: 0, record, wrote: true, stderr: [] };
}
/** args + env(config) 실패까지 포함해 종료코드를 결정한다. */
export function runCollector(input) {
    const parsed = parseArgs(input.argv);
    if (!parsed) {
        return { exitCode: 2, record: null, wrote: false, stderr: ["invalid hook args (deny는 PreToolUse에서만)"] };
    }
    const cfg = parseConfig(input.env);
    if (!cfg.ok) {
        return { exitCode: isBlocking(parsed.hookKind) ? 2 : 1, record: null, wrote: false, stderr: [`config invalid (${cfg.reason})`] };
    }
    return collect({ hookKind: parsed.hookKind, deny: parsed.deny, payloadRaw: input.payloadRaw, config: cfg.config, now: input.now });
}
/** CLI 진입. stdin을 읽어 runCollector를 돌리고 exit code로 종료. stdout에는 아무것도 쓰지 않는다. */
export function main() {
    let payloadRaw = "";
    try {
        payloadRaw = readFileSync(0, "utf8"); // fd 0 = stdin
    }
    catch {
        payloadRaw = "";
    }
    const res = runCollector({ argv: process.argv, env: process.env, payloadRaw, now: new Date().toISOString() });
    for (const line of res.stderr)
        process.stderr.write(line + "\n");
    process.exit(res.exitCode); // stdout 미사용
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
