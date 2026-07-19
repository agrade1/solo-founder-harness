import type { HookKind } from "./toolTrace.js";

/**
 * [M3b.1] Claude Code settings.json의 hooks 블록과 collector env 계약을 생성한다 (offline).
 *
 * 규칙: 설정/argv에는 secret 이름만 담고 값은 절대 기록하지 않는다. 실제 secret 값은
 * collector가 hook 실행 시점의 process.env에서 조회한다(HARNESS_TOOL_SECRET_REFS의 이름으로).
 * 커맨드는 shell 문자열 조합 대신 **공식 exec form**(command=node 실행 파일, args=[collectorPath, hookKind])을
 * 쓴다 — shell 파싱/이스케이프 경유가 없어 공백·따옴표 경로가 안전하고, argv가 collector의
 * parseArgs(argv[2]=hookKind, argv[3]="deny"?)와 정확히 일치한다.
 */

export const SUPPORTED_HOOKS: HookKind[] = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "SessionEnd",
];

/** Claude Code hook 커맨드 — 공식 exec form. shell 조합 없이 command + args로 직접 전달. */
interface HookCommand {
  type: "command";
  command: string; // node 실행 파일 절대경로
  args: string[]; // [collectorPath, hookKind] (+ deny matcher면 "deny")
}
interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}

export interface HookSettings {
  hooks: Record<string, HookMatcher[]>;
}

export interface BuildHookSettingsOpts {
  /** node 실행 파일 경로 (exec form command). */
  nodePath: string;
  /** collector 스크립트 절대경로 (exec form args[0]). */
  collectorPath: string;
  matcher?: string; // 기본 "*"
  /** 지정 시 각 matcher에 대해 PreToolUse deny 등록. 중복 제거. */
  denyMatchers?: string[];
}

/** POSIX sh용 single-quote 이스케이프 (공백·작은따옴표 안전). handoff 재진입 명령 조립 등에 사용. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** 6개 Hook을 정확히 exec form으로 등록한 settings.hooks 블록을 만든다. 값(secret) 미포함. */
export function buildHookSettings(opts: BuildHookSettingsOpts): HookSettings {
  const matcher = opts.matcher ?? "*";
  const cmd = (kind: HookKind, deny = false): HookCommand => ({
    type: "command",
    command: opts.nodePath,
    args: [opts.collectorPath, kind, ...(deny ? ["deny"] : [])],
  });

  const hooks: Record<string, HookMatcher[]> = {};
  for (const kind of SUPPORTED_HOOKS) {
    hooks[kind] = [{ matcher, hooks: [cmd(kind)] }];
  }
  // deny matcher(선택, 중복 제거)는 PreToolUse에 추가.
  const denyMatchers = [...new Set(opts.denyMatchers ?? [])];
  for (const m of denyMatchers) {
    hooks.PreToolUse.push({ matcher: m, hooks: [cmd("PreToolUse", true)] });
  }
  return { hooks };
}

export interface BuildHookEnvOpts {
  tracePath: string;
  profileId: string;
  secretRefs: string[]; // 이름만
  toolMap: Record<string, string>; // toolName → server (exact)
}

/**
 * collector가 읽을 env 계약. secret은 "이름"만(HARNESS_TOOL_SECRET_REFS=JSON 이름 배열).
 * 실제 secret 값은 여기에 담지 않는다.
 */
export function buildHookEnv(opts: BuildHookEnvOpts): Record<string, string> {
  return {
    HARNESS_TOOL_TRACE_PATH: opts.tracePath,
    HARNESS_TOOL_PROFILE_ID: opts.profileId,
    HARNESS_TOOL_SECRET_REFS: JSON.stringify(opts.secretRefs),
    HARNESS_TOOL_MAP: JSON.stringify(opts.toolMap),
  };
}
