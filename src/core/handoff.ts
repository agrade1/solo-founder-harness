import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, accessSync, constants } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { projectPaths } from "./project.js";
import { PACKAGE_ROOT, fromPackage } from "./paths.js";
import { loadRunState, type HandoffRecord } from "./runWorkflow.js";
import { updateContextSummary } from "./summary.js";
import { generateTaskPrompt } from "./taskPrompt.js";
import { runPreflight, PreflightError, type PreflightSuccess, type RunPreflightOpts } from "../tools/preflight.js";
import { buildHookSettings, buildHookEnv, shellQuote, SUPPORTED_HOOKS } from "../tools/hookSettings.js";
import { isValidSecretRef, collectSecretValues, redactSecrets } from "../tools/redact.js";
import { loadToolProfiles, type ToolProfile } from "../tools/profiles.js";
import { applyBlockingMcpEnv } from "../tools/mcpEnv.js";
import { checkComponentsJson, SHADCN_SERVER, type RegistryCheckCode } from "../tools/shadcnPilot.js";
import { getAllowedTools, getForbiddenTools, nsName, MAX_TOOL_CALLS, PER_CALL_TIMEOUT_MS, RESULT_CHARS_BUDGET } from "../tools/shadcnReadPolicy.js";

/**
 * [M3b.2 offline] 문서 완료 → Claude Code 대화형(TUI) 핸드오프.
 *
 * 안전 경계(설계 F3 + M3 격리):
 *  - **대화형 TUI만** 연다(`claude <initialPrompt>` + `stdio:"inherit"`). `-p`/stream-json/stdout 파싱 금지.
 *    코드 수정 권한은 Claude Code 자체 permission이 그대로 게이트한다 — 하네스는 "여는" 것까지만.
 *  - interactive spawn 전에 fail-closed headless preflight(빈 MCP config, `--strict-mcp-config`)가
 *    반드시 성공해야 한다. ambient MCP 서버/도구가 하나라도 보이면 차단하고 spawn하지 않는다.
 *  - 비-TTY에서는 대화형 세션을 열지 않는다(--yes와 조합돼도 백그라운드 TUI 금지).
 *  - `--print`는 실행·preflight·상태 변경 없이 재진입 명령만 출력한다(실제 실행 시 preflight 재수행).
 *  - run_state.handoff는 **interactive child가 실제 spawn된 경우에만** 기록한다.
 *
 * 실제 Claude/live Hook은 이 모듈에서 실행하지 않는다(테스트는 seam으로 주입). 종료코드는 기록하지 않는다.
 */

export const HANDOFF_PROFILE_ID = "handoff-default";
/** [M3c-3b] 파일럿 단계에서 유일하게 허용되는 MCP handoff profile. 다른 MCP profile은 fail-closed. */
export const PILOT_SHADCN_PROFILE_ID = "handoff-shadcn-readonly";
const DEFAULT_MAX_PROMPT_BYTES = 128 * 1024;
// --setting-sources ""로 서비스 레포 CLAUDE.md/AGENTS.md가 자동 로드되지 않으므로 프롬프트에 명시한다.
const PLAN_FIRST_SUFFIX =
  "\n\n서비스 레포의 AGENTS.md와 CLAUDE.md가 존재하면 먼저 읽고 준수하라. " +
  "위 지시문에 따라 먼저 구현 계획만 제시하고, 승인 전에는 어떤 파일도 수정하지 마라.";
const APPROVE_MESSAGE =
  "판단 문서 생성 완료. 서비스 레포에서 Claude Code 대화형 세션을 여시겠습니까? (이후 파일 수정은 Claude Code 승인 프롬프트에서 진행됩니다)";
// 이름이 secret 형태인 환경변수 → trace redaction 대상(이름만 파생). 값은 collector가 hook 시점에 조회.
const SECRET_NAME_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

/** preflight에 넘길 최소 profile — emptyConfig=true라 id·secretRefs만 실제 사용된다. */
const HANDOFF_PREFLIGHT_PROFILE: ToolProfile = {
  id: HANDOFF_PROFILE_ID,
  capabilities: [],
  bindings: {},
  servers: [],
  preapprovedTools: [],
  deniedTools: ["mcp__*"],
  permissionMode: "approval_write",
  allowedDomains: [],
  limits: { maxCallsPerStep: 0, maxResultChars: 0, maxElapsedMsPerCall: 0 },
  secretRefs: [],
};

/** filtered shadcn read profile의 허용 5개(host)·금지 2개(host) — 정책 상수에서만 파생(단일 출처). */
const SHADCN_ALLOWED_HOST = getAllowedTools().map(nsName).sort();
const SHADCN_DENIED_HOST = getForbiddenTools().map(nsName).sort();

export class HandoffProfileError extends Error {}

/**
 * [M3c-3b] 로드한 profile이 filtered shadcn read 계약과 **정확히** 일치하는지 검증한다.
 * registry 변조로 노출이 넓어지는 것을 막는다(허용/금지/launcher/상한/permission 전부 exact).
 */
function assertShadcnReadonlyContract(profile: ToolProfile): void {
  const bare = getAllowedTools();
  const eq = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const fail = (m: string): never => {
    throw new HandoffProfileError(`profile '${profile.id}' 계약 위반: ${m}`);
  };
  if (profile.id !== PILOT_SHADCN_PROFILE_ID) fail("id");
  if (!eq(profile.capabilities, ["component_registry_read"])) fail("capabilities");
  const b = profile.bindings.component_registry_read;
  if (!b || b.kind !== "mcp") throw new HandoffProfileError(`profile '${profile.id}' 계약 위반: binding kind(mcp) 아님`);
  if (b.server !== SHADCN_SERVER) fail("binding server");
  if (!eq(b.tools, bare)) fail("binding.tools(정확히 읽기 5개)");
  if (profile.servers.length !== 1) fail("servers 개수");
  const srv = profile.servers[0];
  if (srv.name !== SHADCN_SERVER || srv.launcher !== "shadcn_read_proxy") fail("server launcher");
  // server own key는 정확히 name, launcher만 (command/args/url/transport는 존재 자체 거부 — args는 빈 배열이어도 거부).
  if (!eq(Object.keys(srv), ["name", "launcher"])) fail("server key는 정확히 {name, launcher}");
  if (!eq(profile.preapprovedTools, SHADCN_ALLOWED_HOST)) fail("preapprovedTools(정확히 host 5개)");
  if (!eq(profile.deniedTools, SHADCN_DENIED_HOST)) fail("deniedTools(정확히 host 2개)");
  if (profile.permissionMode !== "approval_write") fail("permissionMode");
  if (!eq(profile.secretRefs, [])) fail("secretRefs(정확히 [])");
  if (profile.allowedDomains === null || !eq(profile.allowedDomains, [])) fail("allowedDomains(정확히 [])");
  // 상한은 proxy 정책 상수와 정확히 일치해야 한다(profile ↔ proxy enforcement 단일 출처).
  if (
    profile.limits.maxCallsPerStep !== MAX_TOOL_CALLS ||
    profile.limits.maxResultChars !== RESULT_CHARS_BUDGET ||
    profile.limits.maxElapsedMsPerCall !== PER_CALL_TIMEOUT_MS
  ) {
    fail("limits(=proxy 정책 상한 calls6/resultChars8000/timeout60000)");
  }
  if (profile.source !== "official") fail("source");
}

/** filtered shadcn read profile을 registry에서 로드·정확 계약 검증한다. 실패 시 HandoffProfileError. */
function loadPilotProfile(toolProfilesPath?: string): ToolProfile {
  const profiles = loadToolProfiles(toolProfilesPath);
  const profile = profiles.get(PILOT_SHADCN_PROFILE_ID);
  if (!profile) throw new HandoffProfileError(`registry에 '${PILOT_SHADCN_PROFILE_ID}' profile이 없습니다.`);
  assertShadcnReadonlyContract(profile);
  return profile;
}

/** filtered shadcn read profile의 Hook toolMap: 허용 host 5개 → server "shadcn"(exact). */
function shadcnToolMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of SHADCN_ALLOWED_HOST) m[t] = SHADCN_SERVER;
  return m;
}

export interface HandoffOptions {
  project: string;
  cwd?: string; // 서비스 레포 경로. 기본 process.cwd().
  print?: boolean; // 재진입 명령만 출력(실행·상태 변경 없음)
  yes?: boolean; // 승인 게이트 스킵
  now?: () => string; // 시각 주입(테스트 결정성)
  handoffId?: string; // 산출물 디렉터리 id 주입(테스트 결정성). 미지정 시 now()에서 파생.
  maxPromptBytes?: number; // 128KB 경계 override(테스트). 기본 131072.
  isTTY?: boolean; // TTY 여부 주입. 기본 process.stdout/stdin.isTTY.
  claudeBin?: string; // claude 실행 파일. 기본 HARNESS_CLAUDE_BIN ?? "claude".
  logger?: (line: string) => void;
  approve?: (message: string, preview: string) => Promise<boolean>;
  // [M3c-3b] 지정 시 filtered shadcn read profile 경로. 파일럿 단계에서는 PILOT_SHADCN_PROFILE_ID만 허용.
  //          미지정 시 기존 empty-MCP handoff 경로가 완전히 불변.
  toolProfileId?: string;
  // ── test seams (production 미지정) ──
  collectorPath?: string; // collector 절대경로 override(테스트). 미지정 시 PACKAGE_ROOT/dist/tools/hookCollector.js.
  toolProfilesPath?: string; // registry 경로 override(테스트). 미지정 시 registry/tool_profiles.json.
  resolveBin?: (bin: string) => boolean; // 바이너리 존재 확인
  runPreflightFn?: (opts: RunPreflightOpts) => Promise<PreflightSuccess>; // preflight 대체
  spawnInteractive?: (bin: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => void; // spawn 대체
}

export type HandoffOutcome =
  | { action: "printed"; reentryCommand: string }
  | { action: "not_completed"; reason: string }
  | { action: "missing_binary"; reentryCommand: string }
  | { action: "non_tty"; reentryCommand: string }
  | { action: "rejected" }
  | { action: "setup_failed"; message: string } // collector 부재/파일 준비 실패 등 fail-closed
  | { action: "profile_rejected"; message: string } // [M3c-3b] 허용 외 profile / 계약 위반 fail-closed
  | { action: "registry_rejected"; code: RegistryCheckCode; message: string } // [M3c-3b] custom/private/malformed/symlink registry
  | { action: "preflight_failed"; code: string; message: string }
  | { action: "spawn_failed"; message: string }
  | {
      action: "spawned";
      argv: string[];
      runtimeDir: string;
      tracePath: string;
      settingsPath: string;
      mcpConfigPath: string;
      promptBytes: number;
      handoff: HandoffRecord;
      reentryCommand: string;
    };

/**
 * 배포 가능한 collector 절대경로 — 항상 `PACKAGE_ROOT/dist/tools/hookCollector.js`.
 * (import.meta.url 기반 상대 계산은 dev tsx에서 존재하지 않는 src/*.js를 가리키므로 쓰지 않는다.)
 */
function collectorPath(): string {
  return fromPackage("dist", "tools", "hookCollector.js");
}

/** 이름이 secret 형태이고 값이 비어있지 않은 환경변수 이름만 파생(값 금지). 유효 ref 형식만. */
function deriveSecretRefs(env: NodeJS.ProcessEnv): string[] {
  const refs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length > 0 && SECRET_NAME_RE.test(k) && isValidSecretRef(k)) refs.push(k);
  }
  return [...new Set(refs)].sort();
}

/** shell-safe 재진입 명령. 실제 실행 시 preflight를 다시 거치는 `harness handoff ... --yes`.
 *  [M3c-3b] profile 지정 시 --tool-profile을 보존해 재진입에서도 동일 경로를 탄다. */
function buildReentryCommand(project: string, serviceCwd: string, toolProfileId?: string): string {
  const parts = ["harness", "handoff", "--project", shellQuote(project), "--cwd", shellQuote(serviceCwd)];
  if (toolProfileId) parts.push("--tool-profile", shellQuote(toolProfileId));
  parts.push("--yes");
  return parts.join(" ");
}

/**
 * [P0-1] planning contextRoot ↔ serviceCwd 경로 계약.
 * task prompt의 `Include`는 `docs/*.md` **상대경로**이고, 대화형 Claude의 cwd는 serviceCwd다.
 * 두 경로가 다르면 Claude가 serviceCwd/docs를 찾다 실패하고 serviceCwd에 엉뚱한 docs/WORKLOG.md를 만든다.
 * (Claude Code live 실측 P0.) 따라서 프롬프트에 절대 contextRoot 기준 경로 해석 계약을 명시하고,
 * argv에는 `--add-dir <contextRoot>`로 접근 권한을 준다.
 */
function buildContextContract(contextRoot: string, serviceCwd: string): string {
  return (
    "\n\n[경로 계약 — 반드시 준수]\n" +
    `- 작업 디렉터리(cwd, 서비스 레포): ${serviceCwd}\n` +
    `- planning contextRoot(판단 문서 루트): ${contextRoot}\n` +
    `- 위 지시문 'Include'의 docs/… 상대경로는 **contextRoot 기준**이다. 반드시 contextRoot의 절대경로로 읽어라 (예: ${join(contextRoot, "docs", "00_IDEA.md")}).\n` +
    "- serviceCwd와 planning contextRoot는 서로 다른 디렉터리다. serviceCwd 아래에서 docs/ 를 찾지 마라.\n" +
    `- 작업 기록(WORKLOG) 대상은 ${join(contextRoot, "docs", "WORKLOG.md")} 이다. serviceCwd 아래에 별도의 docs/ 나 docs/WORKLOG.md 를 만들지 마라.\n`
  );
}

/**
 * 대화형 TUI spawn argv. -p/stream-json 없음. MCP는 빈 config + strict + mcp__* deny로 이중 차단.
 *
 * [P0] `--disallowedTools <tools...>`는 가변 인자다. `--` 옵션 종료 구분자 없이 initialPrompt를
 * 뒤에 붙이면 CLI가 프롬프트(및 그 안의 모든 단어)를 deny 규칙으로 소비한다(Claude Code 2.1.215
 * 실측: `Permission deny rule "..." matches no known tool` 경고 폭주 → Hook acceptance 무효).
 * 따라서 `--disallowedTools mcp__*` 뒤에 `--`를 넣어 옵션 파싱을 종료하고 initialPrompt를
 * 순수 positional로 전달한다. 최종 꼬리 = `--disallowedTools`, `mcp__*`, `--`, initialPrompt.
 *
 * [P0-1] planning 문서(docs/*.md)는 contextRoot에 있으므로 `--add-dir <contextRoot>`로 접근 권한을 준다
 * (serviceCwd와 별개 디렉터리). 경로 해석 계약은 initialPrompt(buildContextContract)에 명시된다.
 */
function buildSpawnArgv(
  mcpConfigPath: string,
  settingsPath: string,
  contextRoot: string,
  initialPrompt: string,
  tools: { allowed: string[]; denied: string[] },
): string[] {
  const argv = [
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--settings",
    settingsPath,
    "--setting-sources",
    "",
    "--add-dir",
    contextRoot, // planning contextRoot 접근 허용(cwd=serviceCwd와 별개)
    "--permission-mode",
    "default",
    "--tools",
    "default",
  ];
  // profile 경로: --allowedTools <정확한 host 5개>. 기본 경로: allowed 없음.
  if (tools.allowed.length > 0) argv.push("--allowedTools", tools.allowed.join(","));
  // profile 경로: 금지 host 2개. 기본 경로: mcp__* 전체 deny(단일 값).
  if (tools.denied.length > 0) argv.push("--disallowedTools", tools.denied.join(","));
  // 옵션 파싱 종료: 이후 initialPrompt를 가변 인자(--disallowedTools/--allowedTools) 값으로 소비하지 않도록.
  argv.push("--", initialPrompt);
  return argv;
}

/** bare 명령은 PATH에서, 경로 포함이면 존재 여부로 확인한다 (claude를 실제 실행하지 않는다). */
function defaultResolveBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p && existsSync(join(p, bin)));
}

function defaultSpawnInteractive(bin: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): void {
  const res = spawnSync(bin, argv, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
  if (res.error) throw res.error; // spawn 실패만 오류. 종료코드는 기록하지 않는다.
}

function defaultStdinApprove(message: string, preview: string): Promise<boolean> {
  return new Promise((resolveP) => {
    if (preview) console.log("\n" + preview);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n[승인 필요] ${message} (y/N): `, (ans) => {
      rl.close();
      resolveP(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

/**
 * 승인 화면 preview: task prompt 앞 40줄 + cwd/권한/Hook/trace/MCP/secret/hard deny.
 * task prompt뿐 아니라 serviceCwd·tracePath 등 모든 동적 문자열이 secret 값을 담을 수 있으므로
 * 조립한 **최종 결과 전체**를 scrub한다(승인 화면에 secret 평문이 절대 노출되지 않게 한다).
 */
function buildPreview(o: {
  taskPromptContent: string;
  serviceCwd: string;
  contextRoot: string;
  tracePath: string;
  redactCount: number;
  scrub: (s: string) => string;
  profile?: { id: string; server: string; allowed: string[]; denied: string[]; limits: ToolProfile["limits"] };
}): string {
  const head = o.taskPromptContent.split("\n").slice(0, 40).join("\n");
  const lines = [
    "── task prompt (앞 40줄) ──",
    head,
    "───────────────────────────",
    `serviceCwd (cwd, 서비스 레포): ${o.serviceCwd}`,
    `planning contextRoot (판단 문서 루트, --add-dir): ${o.contextRoot}`,
  ];
  if (o.profile) {
    // filtered shadcn read profile 경로: 노출·금지·상한을 명시(“MCP 없음” 문구 없음).
    lines.push(
      "권한: --permission-mode default · --tools default",
      `tool profile: ${o.profile.id}`,
      `MCP 서버: ${o.profile.server} (신뢰된 로컬 read-only proxy — 원본 npx shadcn 직접 실행 아님)`,
      `허용 도구 (${o.profile.allowed.length}): ${o.profile.allowed.join(", ")}`,
      `금지 도구 (${o.profile.denied.length}): ${o.profile.denied.join(", ")}`,
      `상한: calls ${o.profile.limits.maxCallsPerStep} / resultChars ${o.profile.limits.maxResultChars} / timeout ${o.profile.limits.maxElapsedMsPerCall}ms`,
    );
  } else {
    lines.push(
      "권한: --permission-mode default · --tools default · --disallowedTools mcp__*",
      "MCP 서버/도구: 없음 (--strict-mcp-config + 빈 mcp-config)",
    );
  }
  lines.push(
    `Hook: ${SUPPORTED_HOOKS.join(", ")} (${SUPPORTED_HOOKS.length}개, exec form)`,
    `trace: ${o.tracePath}`,
    `secret: 설정·argv에 값 없음 / trace는 환경 secret 이름 ${o.redactCount}개 값 자동 마스킹 (raw MCP 결과 미저장)`,
    "hard deny(자동화 대상 아님): production deploy · live billing · remote repository write · pull request merge",
  );
  return o.scrub(lines.join("\n"));
}

/** run_state.json을 다시 읽어 handoff 필드만 병합·기록한다. status/completed는 건드리지 않는다. */
function persistHandoffRecord(project: string, record: HandoffRecord): void {
  const p = join(projectPaths(project).root, "outputs/run_state.json");
  const state = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  state.handoff = record;
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function runHandoff(opts: HandoffOptions): Promise<HandoffOutcome> {
  const now = opts.now ?? (() => new Date().toISOString());
  // ambient secret 값 스크러버 — 로그·outcome 메시지에서 값이 새지 않게 한다(이름은 파생, 값은 미출력).
  const redactRefs = deriveSecretRefs(process.env);
  const redactValues = collectSecretValues(redactRefs);
  const scrub = (s: string) => redactSecrets(s, redactValues);
  const log = (l: string) => (opts.logger ?? ((x: string) => console.log(x)))(scrub(l));
  const { project } = opts;
  const serviceCwd = resolve(opts.cwd ?? process.cwd());
  const reentryCommand = buildReentryCommand(project, serviceCwd, opts.toolProfileId);

  // 1) --print: 실행·preflight·상태 변경 없이 재진입 명령만 출력(선택된 profile 보존).
  if (opts.print) {
    log(reentryCommand);
    return { action: "printed", reentryCommand };
  }

  // 2) run_state 완료 확인 (read-only). completed 아니면 handoff 금지.
  const state = loadRunState(project);
  if (!state) {
    return { action: "not_completed", reason: `run_state가 없습니다: ${project} (먼저 'harness run <workflow> --project ${project}' 실행)` };
  }
  if (state.status !== "completed") {
    // [B-40] killed에 --resume을 지시하면 불가능한 안내가 된다(resume은 status=failed만 받는다).
    // 폐기는 "마저 완료"할 수 있는 상태가 아니므로 별도 문구로 갈라 적는다.
    if (state.status === "killed") {
      const k = state.killed_by;
      return {
        action: "not_completed",
        reason:
          `run이 폐기(status=killed)됐습니다 — ${k?.decider ?? "게이트"}가 '${k?.decision ?? "폐기"}' 판정. ` +
          `재개(--resume)는 불가하고 handoff도 하지 않습니다. docs/00_IDEA.md를 고쳐 새 run으로 다시 평가하세요.`,
      };
    }
    return {
      action: "not_completed",
      reason: `run이 완료(completed) 상태가 아닙니다 (status=${state.status}). 'harness run ${state.workflow_id} --project ${project} --resume'로 마저 완료한 뒤 handoff 하세요.`,
    };
  }

  // 2b) [M3c-3b] filtered shadcn read profile 경로. 미지정 시 아래 로직은 전부 no-op이라
  //     기존 empty-MCP handoff 경로가 완전히 불변이다.
  let pilotProfile: ToolProfile | undefined;
  if (opts.toolProfileId !== undefined) {
    // 파일럿 단계: PILOT_SHADCN_PROFILE_ID만 허용. 다른(MCP) profile은 fail-closed.
    if (opts.toolProfileId !== PILOT_SHADCN_PROFILE_ID) {
      const msg = `허용되지 않은 handoff tool profile: '${opts.toolProfileId}' (파일럿 단계는 '${PILOT_SHADCN_PROFILE_ID}'만 허용).`;
      log(msg);
      return { action: "profile_rejected", message: msg };
    }
    // profile 로드 + 정확 계약 검증 (registry 변조로 노출 확대 방지).
    try {
      pilotProfile = loadPilotProfile(opts.toolProfilesPath);
    } catch (e) {
      const msg = scrub(`profile 로드/계약 검증 실패: ${(e as Error).message}`);
      log(msg);
      return { action: "profile_rejected", message: msg };
    }
    // components.json 표준 registry 검사 — custom/private/malformed/symlink이면 Claude·proxy 실행 전 거부.
    const reg = checkComponentsJson(serviceCwd);
    if (!reg.ok) {
      const msg = `components.json 표준 registry 검사 실패 (${reg.code}) — Claude·proxy 실행 전 거부.`;
      log(msg);
      return { action: "registry_rejected", code: reg.code, message: msg };
    }
  }

  // 3) summary + task-prompt 자동 갱신.
  //    [P0-1] contextRoot = planning 문서(docs/*.md)·task prompt의 기준 루트. 대화형 cwd(serviceCwd)와 별개.
  const today = now().slice(0, 10);
  updateContextSummary(project, today);
  const taskPromptRel = generateTaskPrompt(project, today);
  const contextRoot = projectPaths(project).root;
  const taskPromptAbs = join(contextRoot, taskPromptRel);
  const taskPromptContent = readFileSync(taskPromptAbs, "utf8");

  // 4) initialPrompt (128KB 초과 시 절대경로 읽기 지시로 대체). 경로 계약(contextRoot)을 항상 덧붙인다.
  //    128KB fallback도 taskPromptAbs가 contextRoot 아래이고 argv --add-dir로 접근 가능하다.
  const contextContract = buildContextContract(contextRoot, serviceCwd);
  const maxBytes = opts.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
  const full = taskPromptContent + PLAN_FIRST_SUFFIX + contextContract;
  const initialPrompt =
    Buffer.byteLength(full, "utf8") > maxBytes
      ? `작업 지시문이 큽니다. 아래 절대경로 파일을 열어 전체를 읽어라: ${taskPromptAbs}${PLAN_FIRST_SUFFIX}${contextContract}`
      : full;
  const promptBytes = Buffer.byteLength(initialPrompt, "utf8");

  // 하네스 설치 경로로의 handoff는 경고 (패키지 경로 read-only 전제).
  if (serviceCwd === PACKAGE_ROOT) {
    log("경고: cwd가 하네스 설치 경로입니다 — 서비스 레포 경로에서 실행하세요 (--cwd <serviceRepo>).");
  }

  // 5) claude 바이너리 부재 → 설치 안내 + 재진입 명령. spawn/상태 변경 없음.
  const claudeBin = opts.claudeBin ?? process.env.HARNESS_CLAUDE_BIN ?? "claude";
  const resolveBin = opts.resolveBin ?? defaultResolveBin;
  if (!resolveBin(claudeBin)) {
    log(`claude CLI를 찾을 수 없습니다 ('${claudeBin}'). 설치 후 아래 명령으로 handoff 하세요:`);
    log(`  ${reentryCommand}`);
    return { action: "missing_binary", reentryCommand };
  }

  // 6) 비-TTY → interactive spawn 금지.
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!isTTY) {
    log("비대화형(TTY 아님) 환경 — 대화형 Claude Code 세션을 열지 않습니다. 사람이 보는 터미널에서:");
    log(`  ${reentryCommand}`);
    return { action: "non_tty", reentryCommand };
  }

  // 7) collector fail-closed 검증 (spawn/preflight 전). 배포 산출물이 일반 파일이고 읽을 수 있을 때만 통과.
  //    파일 부재·디렉터리·stat/access 오류는 예외를 throw하지 않고 scrub된 setup_failed로 정규화한다
  //    (여기서 preflight/spawn/handoff 기록을 일으키지 않는다).
  const collector = opts.collectorPath ?? collectorPath();
  try {
    const cstat = statSync(collector); // 부재 시 ENOENT throw → catch에서 정규화
    if (!cstat.isFile()) throw new Error("일반 파일이 아닙니다 (디렉터리/특수 파일)");
    accessSync(collector, constants.R_OK); // 읽기 권한 없으면 throw
  } catch (e) {
    const msg = scrub(`collector 산출물을 사용할 수 없습니다 (부재/디렉터리/읽기 불가): ${collector} — 'npm run build' 후 다시 시도하세요. (${(e as Error).message})`);
    log(msg);
    return { action: "setup_failed", message: msg };
  }

  // 기본 handoff id는 randomUUID로 충돌·예측을 방지한다(테스트는 handoffId seam으로 고정).
  const handoffId = opts.handoffId ?? `handoff-${randomUUID()}`;
  const runtimeDir = join(projectPaths(project).outputs, "runtime", handoffId);
  const tracePath = join(projectPaths(project).outputs, "tool-trace", `${handoffId}.jsonl`);

  // 8) 승인 게이트 (--yes면 스킵).
  if (!opts.yes) {
    const approve = opts.approve ?? defaultStdinApprove;
    const preview = buildPreview({
      taskPromptContent,
      serviceCwd,
      contextRoot,
      tracePath,
      redactCount: redactRefs.length,
      scrub,
      profile: pilotProfile
        ? { id: pilotProfile.id, server: SHADCN_SERVER, allowed: SHADCN_ALLOWED_HOST, denied: SHADCN_DENIED_HOST, limits: pilotProfile.limits }
        : undefined,
    });
    const ok = await approve(APPROVE_MESSAGE, preview);
    if (!ok) {
      log("handoff 취소됨 — Claude Code 세션을 열지 않았습니다.");
      return { action: "rejected" };
    }
  }

  // 9) fail-closed preflight. 성공해야만 spawn.
  //    - 기본 경로: 빈 MCP config(ambient 격리 실측).
  //    - profile 경로: proxy config(shadcn 서버 connected + 정확한 5개 도구일 때만 통과). snapshot의 configHash·경로를 기록.
  //    redactNames: ambient secret 이름을 오류 scrub에만 쓰고 child env로는 전달하지 않는다.
  const runPreflightFn = opts.runPreflightFn ?? runPreflight;
  let profileConfigHash: string | undefined;
  let profileSnapshotPath: string | undefined;
  try {
    if (pilotProfile) {
      const pf = await runPreflightFn({ profile: pilotProfile, serviceCwd, runtimeDir, now, redactNames: redactRefs });
      profileConfigHash = pf.snapshot.configHash;
      profileSnapshotPath = pf.snapshotPath;
    } else {
      // snapshot 자체는 사용하지 않는다 — 성공(빈 서버/도구)만이 spawn 조건이다.
      await runPreflightFn({ profile: HANDOFF_PREFLIGHT_PROFILE, serviceCwd, runtimeDir, now, emptyConfig: true, redactNames: redactRefs });
    }
  } catch (e) {
    const code = e instanceof PreflightError ? e.code : "preflight";
    const message = scrub((e as Error).message);
    log(`preflight 실패 (${code}) — ${pilotProfile ? "shadcn proxy 격리/도구" : "ambient MCP 격리"} 미확인. 세션을 열지 않았습니다.`);
    return { action: "preflight_failed", code, message };
  }
  const mcpConfigPath = join(runtimeDir, "mcp-config.json"); // preflight가 config를 기록

  // 10) Hook settings(exec form, secret 값 없음) + trace 파일을 최소 권한·exclusive-create로 준비.
  //     기존 파일·symlink를 조용히 덮어쓰지 않고 fail-closed(wx). trace는 spawn 전에 빈 0600 파일로 생성.
  const settingsPath = join(runtimeDir, "hook-settings.json");
  try {
    const settings = buildHookSettings({ nodePath: process.execPath, collectorPath: collector });
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    mkdirSync(dirname(tracePath), { recursive: true, mode: 0o700 });
    writeFileSync(tracePath, "", { encoding: "utf8", mode: 0o600, flag: "wx" }); // 빈 0600 — collector가 append
  } catch (e) {
    const msg = scrub(`handoff 산출물 준비 실패 (기존 파일/symlink?): ${(e as Error).message}`);
    log(msg);
    return { action: "setup_failed", message: msg };
  }

  // 11) spawn argv + env (HARNESS_TOOL_*: secret 이름만 + auto-memory 격리; secret 값은 미포함).
  //     profile 경로: allowedTools=host 5개·disallowedTools=host 2개(전체 mcp__* deny 없음)·Hook profileId+toolMap.
  //     기본 경로: mcp__* 전체 deny·profileId=handoff-default·toolMap={}.
  const argv = buildSpawnArgv(
    mcpConfigPath,
    settingsPath,
    contextRoot,
    initialPrompt,
    pilotProfile ? { allowed: SHADCN_ALLOWED_HOST, denied: SHADCN_DENIED_HOST } : { allowed: [], denied: ["mcp__*"] },
  );
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...buildHookEnv({
      tracePath,
      profileId: pilotProfile ? PILOT_SHADCN_PROFILE_ID : HANDOFF_PROFILE_ID,
      secretRefs: redactRefs,
      toolMap: pilotProfile ? shadcnToolMap() : {},
    }),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  // [M3c-3b] filtered shadcn read profile 경로에서만 blocking MCP 연결 env를 **마지막에** 강제한다
  //          (cold npx + attestation이 기본 5s handshake를 넘겨 pending 되는 것 방지; ambient override 불가).
  //          기본 handoff(empty MCP, toolProfile 미지정) 경로는 baseEnv 그대로 — 기존 동작 불변.
  const env: NodeJS.ProcessEnv = pilotProfile ? applyBlockingMcpEnv(baseEnv) : baseEnv;

  // 12) spawn. 실패하면 run_state에 기록하지 않는다.
  const launchedAt = now();
  const spawnInteractive = opts.spawnInteractive ?? defaultSpawnInteractive;
  try {
    spawnInteractive(claudeBin, argv, { cwd: serviceCwd, env });
  } catch (e) {
    const message = scrub((e as Error).message);
    log(`Claude Code 세션 spawn 실패: ${message}`);
    return { action: "spawn_failed", message };
  }

  // 13) 실제 spawn된 경우에만 run_state.handoff 기록. status/completed 불변, 종료코드 미기록.
  //     profile 경로에서만 optional 필드(tool_profile_id/config_hash/snapshot_path)를 덧붙인다
  //     (기본 경로 record는 종전과 동일 — optional 키 미포함).
  const record: HandoffRecord = {
    launched_at: launchedAt,
    cwd: serviceCwd,
    prompt_bytes: promptBytes,
    trace_path: tracePath,
    runtime_dir: runtimeDir,
  };
  if (pilotProfile) {
    record.tool_profile_id = PILOT_SHADCN_PROFILE_ID;
    record.config_hash = profileConfigHash;
    record.snapshot_path = profileSnapshotPath;
  }
  persistHandoffRecord(project, record);
  log(`handoff 완료 — tool-trace: ${tracePath}`);
  return { action: "spawned", argv, runtimeDir, tracePath, settingsPath, mcpConfigPath, promptBytes, handoff: record, reentryCommand };
}
