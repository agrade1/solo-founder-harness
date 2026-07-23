/**
 * [M3b.1] Claude Code settings.json의 hooks 블록과 collector env 계약을 생성한다 (offline).
 *
 * 규칙: 설정/argv에는 secret 이름만 담고 값은 절대 기록하지 않는다. 실제 secret 값은
 * collector가 hook 실행 시점의 process.env에서 조회한다(HARNESS_TOOL_SECRET_REFS의 이름으로).
 * 커맨드는 nodePath/collectorPath를 shell-safe 하게 quote한다(공백·따옴표 경로 안전).
 * 실제 handoff에서의 settings 파일 write·claude 실행은 M3b.2.
 */
export const SUPPORTED_HOOKS = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionDenied",
    "SessionEnd",
];
/** POSIX sh용 single-quote 이스케이프 (공백·작은따옴표 안전). */
export function shellQuote(s) {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
/** 6개 Hook을 정확히 등록한 settings.hooks 블록을 만든다. 값(secret) 미포함. */
export function buildHookSettings(opts) {
    const matcher = opts.matcher ?? "*";
    const prefix = `${shellQuote(opts.nodePath)} ${shellQuote(opts.collectorPath)}`;
    const cmd = (kind, deny = false) => `${prefix} ${kind}${deny ? " deny" : ""}`;
    const hooks = {};
    for (const kind of SUPPORTED_HOOKS) {
        hooks[kind] = [{ matcher, hooks: [{ type: "command", command: cmd(kind) }] }];
    }
    // deny matcher(선택, 중복 제거)는 PreToolUse에 추가.
    const denyMatchers = [...new Set(opts.denyMatchers ?? [])];
    for (const m of denyMatchers) {
        hooks.PreToolUse.push({ matcher: m, hooks: [{ type: "command", command: cmd("PreToolUse", true) }] });
    }
    return { hooks };
}
/**
 * collector가 읽을 env 계약. secret은 "이름"만(HARNESS_TOOL_SECRET_REFS=JSON 이름 배열).
 * 실제 secret 값은 여기에 담지 않는다.
 */
export function buildHookEnv(opts) {
    return {
        HARNESS_TOOL_TRACE_PATH: opts.tracePath,
        HARNESS_TOOL_PROFILE_ID: opts.profileId,
        HARNESS_TOOL_SECRET_REFS: JSON.stringify(opts.secretRefs),
        HARNESS_TOOL_MAP: JSON.stringify(opts.toolMap),
    };
}
