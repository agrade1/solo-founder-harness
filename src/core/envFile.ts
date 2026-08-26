/**
 * [C-126] `.env` 리더 — **`TAVILY_API_KEY` 한 이름만** 읽는다 (설계 §2·§3).
 *
 * 사용자 요구는 "하네스가 `.env`를 만들어 두고 사용자는 키값만 입력"이다. 그래서 이 모듈이 하는 일은
 * 세 가지뿐이고, **그 밖의 어떤 변수도 읽지 않는다**:
 *
 *  ⓐ 템플릿 생성(0600 · 존재하면 손대지 않는다) — `harness init`과 self fallback 판정 순간.
 *  ⓑ **단일 이름 allowlist** 해석: `process.env[TAVILY_API_KEY] ?? .env`의 그 한 줄. 셸이 이긴다.
 *  ⓒ git 안전 검사: 추적 중이면 **키를 읽지 않고 거부**하고, ignore되지 않으면 managed block을
 *     멱등 append한 뒤 재확인한다.
 *
 * ## 이 모듈이 하지 않는 것 (기각한 대안 — 설계 §9)
 *
 * - **`process.env`를 바꾸지 않는다.** 값은 반환값으로만 흐르고 `createTavilyBackend({apiKey})`까지
 *   인자로 간다. 이 규율이 없으면 claude-code/exec/mission/handoff **자식 프로세스가 부모 env를
 *   상속**하는 순간 키가 모델 세션으로 들어간다(그 자식들은 `{...process.env}`를 그대로 넘긴다).
 *   셸에서 `export`한 키는 예전과 똑같이 상속된다 — **우리가 만든 유출이 아니고** 사용자가 만든
 *   것이지만, 그 사실 자체는 여기 적어 둔다(§10 미확인 항목).
 * - **dotenv를 쓰지 않는다** — 필요한 것은 한 이름의 한 줄이고 그것은 정규식 하나다(새 의존성 0).
 * - **범용 로더가 아니다** — 임의 변수를 읽으면 `.env`에 있는 다른 비밀(DB URL·결제 키)까지
 *   하네스 메모리로 들어온다. 비대상 줄은 **개수만** 센다(이름도 내용도 기록하지 않는다).
 * - **git history를 정리하지 않는다.** 이미 커밋된 키는 이 코드가 되돌릴 수 없다 — 회전(폐기·재발급)
 *   안내만 한다. "정리했다"는 주장은 하지 않는다.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "./paths.js";
import { TAVILY_SECRET_REF } from "../tools/tavilyBackend.js";

/** workspace 루트의 `.env` — **단수다**(per-project `.env`는 기각: 키는 사용자 단위다 · §9-4). */
export const ENV_FILE_NAME = ".env";

/** managed block 경계. 이 두 줄이 있으면 다시 쓰지 않는다(멱등). */
const GITIGNORE_BEGIN = "# --- harness managed (C-126 리서치 키) ---";
const GITIGNORE_END = "# --- end harness managed ---";
const GITIGNORE_ENTRIES = [ENV_FILE_NAME, "projects/*/outputs/research/"];

export function envFilePath(root: string = WORKSPACE_ROOT): string {
  return join(root, ENV_FILE_NAME);
}

/**
 * 템플릿 본문. **키 값을 요구하는 문장을 프롬프트/채팅 쪽으로 유도하지 않는다** — 사용자는 이 파일에만
 * 넣는다. 검색어 전송 고지를 여기 싣는 이유: 키를 넣는 그 순간이 "내 질의가 외부로 나간다"를 알려야
 * 하는 유일한 자리다(설계 §2 · B-2).
 */
function templateBody(): string {
  return [
    "# 하네스 리서치 키 — **이 파일을 커밋하지 마라.**",
    "# 값을 채팅·프롬프트에 붙여넣지 마라. 하네스는 이 파일에서만 읽고,",
    "# 자식 프로세스(claude-code / exec / mission / handoff)의 환경변수에는 싣지 않는다.",
    "#",
    "# 고지: 키가 있으면 **모델이 생성한 검색어가 Tavily(외부 서비스)로 전송된다.**",
    "#       비공개 정보가 검색어에 섞일 수 있다 — 원치 않으면 값을 비워 두면 자체 리서치로 진행한다.",
    "#",
    "# 무료 키 발급: https://tavily.com",
    "#",
    `# 값만 채우면 된다 (빈 값 = 키 없음 = 자체 리서치):`,
    `${TAVILY_SECRET_REF}=`,
    "",
  ].join("\n");
}

export interface EnsureEnvTemplateResult {
  path: string;
  /** 이번 호출이 파일을 만들었는가. 이미 있으면 false이고 **내용을 건드리지 않는다**. */
  created: boolean;
}

/**
 * `.env`가 없으면 0600으로 만든다. **있으면 한 글자도 바꾸지 않는다**(사용자가 채운 값·다른 변수 보호).
 * `flag:"wx"`로 만드는 이유: exists 확인과 쓰기 사이에 다른 프로세스가 만들었으면 그 파일이 정답이다.
 */
export function ensureEnvTemplate(root: string = WORKSPACE_ROOT): EnsureEnvTemplateResult {
  const path = envFilePath(root);
  try {
    writeFileSync(path, templateBody(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { path, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    throw err;
  }
}

// ── git 안전 검사 ───────────────────────────────────────────────

/**
 * [C-126/A-5] git 한 번의 **3-state** 결과. 예전 판은 `boolean`이었고 그래서 "아니다"와 "물어볼 수
 * 없었다"가 같은 값이었다 — git이 없거나 명령이 깨지면 **실제 non-repo와 구분되지 않아 검사를
 * 건너뛰고 키를 읽었다**. 판정 불가는 거부다.
 */
type Probe = "yes" | "no" | "unknown";

function gitProbe(root: string, args: string[]): Probe {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return "yes";
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number | null };
    // git 자신이 "아니다"로 답하는 exit code만 `no`다:
    //  - `rev-parse --is-inside-work-tree`: repo 밖 = 128
    //  - `ls-files --error-unmatch` / `check-ignore -q`: 해당 없음 = 1
    // 그 밖(ENOENT=git 없음 · 신호 종료 · 예상 밖 코드)은 **판정 불가**다.
    if (e.code === "ENOENT") return "unknown";
    if (e.status === 1 || e.status === 128) return "no";
    return "unknown";
  }
}

/**
 * `.env`의 git 상태. **파일이 없어도 물을 수 있다** — `check-ignore`와 `ls-files`는 패턴·index를
 * 보므로 파일 실체가 필요 없다. 그래서 **만들기 전에** 안전을 확인할 수 있다(A-5의 요점).
 */
export type EnvGitState = "no_repo" | "tracked" | "ignored" | "not_ignored" | "unknown";

export function envGitState(root: string): EnvGitState {
  const inRepo = gitProbe(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inRepo === "unknown") return "unknown";
  if (inRepo === "no") return "no_repo"; // repo 밖 — 이 도구 경로에서 커밋될 길이 없다
  // 추적 중이면 그것이 곧 답이다. (실측: `check-ignore`는 **추적 중인 경로를 ignore로 보고하지
  // 않는다** — gitignore가 tracked 파일에 효력이 없기 때문이다. 그래서 순서가 이것이어야 하고,
  // 추적 검사가 벌어주는 것은 ⓐ 정확한 진단 ⓑ 무의미한 `.gitignore` 쓰기 회피다.)
  const tracked = gitProbe(root, ["ls-files", "--error-unmatch", "--", ENV_FILE_NAME]);
  if (tracked === "unknown") return "unknown";
  if (tracked === "yes") return "tracked";
  // `git check-ignore`를 쓰는 이유: `.gitignore`에 `.env`가 있는지 grep하는 것으로는 부정 규칙
  // (`!.env`)·하위 디렉터리 규칙·`core.excludesFile`을 판정할 수 없다. 여기서 묻는 것은 "지금 이
  // 경로가 무시되는가"라는 git 자신의 답이다.
  const ignored = gitProbe(root, ["check-ignore", "-q", "--", ENV_FILE_NAME]);
  if (ignored === "unknown") return "unknown";
  return ignored === "yes" ? "ignored" : "not_ignored";
}

/**
 * `.gitignore` 말미에 managed block을 **멱등** append한다. 경계 주석이 이미 있으면 아무것도 쓰지 않는다.
 *
 * 말미인 것이 요점이다: gitignore는 **뒤 규칙이 이긴다**. 앞쪽에 `!.env`가 있어도 우리 블록이
 * 뒤에 오면 다시 ignore된다. 그래도 하위 디렉터리의 `.gitignore`처럼 우선순위가 더 높은 자리에
 * 부정 규칙이 있으면 이 append로는 못 이긴다 — 그래서 호출자가 **재확인**하고, 여전히 ignore가
 * 아니면 키를 읽지 않는다(fail closed).
 *
 * @returns 이번 호출이 파일을 바꿨는가.
 */
export function ensureGitignoreBlock(root: string): boolean {
  const abs = join(root, ".gitignore");
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  if (existing.includes(GITIGNORE_BEGIN)) return false;
  const block = [GITIGNORE_BEGIN, ...GITIGNORE_ENTRIES, GITIGNORE_END, ""].join("\n");
  appendFileSync(abs, (existing.length > 0 && !existing.endsWith("\n") ? "\n" : "") + block, { encoding: "utf8" });
  return true;
}

// ── 공용 게이트: git 안전 → ignore 보장 → 0600 파일 (A-5) ───────

export type EnvRefusalCode = "env_file_tracked_by_git" | "env_file_not_ignored" | "env_git_probe_failed" | "env_file_permissions";

export type EnvFileReady =
  | { ok: true; path: string; created: boolean; notices: string[] }
  | { ok: false; path: string; code: EnvRefusalCode; notices: string[] };

/** 파일 mode에서 group/other 비트가 있으면 남이 읽을 수 있다 — 키를 두는 파일에서는 거부 사유다. */
function tooPermissive(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * [C-126/A-5] **`.env`를 만들기 전에 안전을 확인하는 단일 게이트.** `init`과 self 판정이 이 함수
 * 하나를 쓴다 — 순서가 두 벌이면 한쪽이 먼저 만들고 나중에 검사한다(예전 판이 정확히 그랬다:
 * 부재면 git 검사 전에 template만 만들었고, **설치된 사용자 workspace에는 `.gitignore`가 패키징되지
 * 않으므로 새 `.env`가 첫 후속 실행까지 unignored**였다).
 *
 * 순서: ⓐ git 3-state(판정 불가 = 거부) → ⓑ 추적 중이면 거부(생성·쓰기 없음) → ⓒ 미ignore면
 * managed block append + **재확인**(그래도 아니면 거부) → ⓓ 0600 regular file 생성/검증.
 */
export function ensureEnvFileReady(root: string = WORKSPACE_ROOT): EnvFileReady {
  const path = envFilePath(root);
  const notices: string[] = [];
  const state = envGitState(root);

  if (state === "unknown") {
    return {
      ok: false,
      path,
      code: "env_git_probe_failed",
      notices: [
        `git 상태를 확인할 수 없어 ${ENV_FILE_NAME}을 만들지도 읽지도 않았습니다 (${root}).`,
        `키 파일이 커밋 대상인지 판정할 수 없으면 그것 자체가 거부 사유입니다 — git이 실행 가능한지 확인하세요: git status`,
        `그때까지는 자체 리서치(self)로 진행합니다.`,
      ],
    };
  }
  if (state === "tracked") {
    // **아무것도 만들지 않고 아무것도 쓰지 않는다.** 추적 파일에 gitignore 규칙을 더해도 효과가 없다.
    return {
      ok: false,
      path,
      code: "env_file_tracked_by_git",
      notices: [
        `${ENV_FILE_NAME}이 git에 **추적 중**입니다 (${path}) — 키를 읽지 않았습니다.`,
        `1) 그 키를 폐기·재발급하세요 (이미 커밋됐다면 값은 되돌릴 수 없습니다 — 이 도구는 git history를 정리하지 않습니다).`,
        `2) 추적에서 빼세요: git rm --cached ${ENV_FILE_NAME}`,
        `3) ${ENV_FILE_NAME}이 ignore되는지 확인한 뒤 새 키를 넣으세요: git check-ignore -v ${ENV_FILE_NAME}`,
        `그때까지는 자체 리서치(self)로 진행합니다.`,
      ],
    };
  }
  if (state === "not_ignored") {
    if (ensureGitignoreBlock(root)) {
      notices.push(`.gitignore에 ${GITIGNORE_ENTRIES.join(" · ")} 규칙을 추가했습니다 (${join(root, ".gitignore")}).`);
    }
    if (envGitState(root) !== "ignored") {
      return {
        ok: false,
        path,
        code: "env_file_not_ignored",
        notices: [
          ...notices,
          `${ENV_FILE_NAME}이 여전히 git에서 무시되지 않습니다 (${path}) — 키 파일을 만들지도 읽지도 않았습니다.`,
          `우선순위가 더 높은 부정 규칙이 있을 수 있습니다: git check-ignore -v ${ENV_FILE_NAME} 로 어느 규칙인지 확인하세요.`,
          `그때까지는 자체 리서치(self)로 진행합니다.`,
        ],
      };
    }
  }

  // 여기부터 안전하다(no_repo 또는 ignored). 이제서야 파일을 만든다.
  const t = ensureEnvTemplate(root);
  const st = statSync(path);
  if (!st.isFile()) {
    return { ok: false, path, code: "env_file_permissions", notices: [...notices, `${path}이 일반 파일이 아닙니다 — 키를 읽지 않았습니다.`] };
  }
  if (tooPermissive(st.mode)) {
    // 우리가 만든 파일은 0600이다. 넓은 권한은 **사람이 만든 파일**이라는 뜻이고, 남이 읽을 수 있는
    // 자리에 키가 있다. 조용히 chmod하지 않는다 — 남의 파일 권한을 몰래 바꾸는 것도 사고다.
    return {
      ok: false,
      path,
      code: "env_file_permissions",
      notices: [
        ...notices,
        `${path}의 권한이 너무 넓습니다 (${(st.mode & 0o777).toString(8)}) — 다른 사용자가 키를 읽을 수 있어 읽지 않았습니다.`,
        `고치세요: chmod 600 ${path}`,
        `그때까지는 자체 리서치(self)로 진행합니다.`,
      ],
    };
  }
  return { ok: true, path, created: t.created, notices };
}

// ── 키 해석 ─────────────────────────────────────────────────────

export type KeySource = "shell" | "env_file" | "absent" | "refused";

export interface KeyResolution {
  envPath: string;
  /** 해석된 키. **없거나 거부됐으면 null**이고, 그 경우 진행 모드는 self다. */
  key: string | null;
  source: KeySource;
  /** 거부 사유 코드 (source==="refused"일 때만). */
  refusedCode?: EnvRefusalCode;
  /** `.env`를 이번 호출이 만들었는가 (게이트를 통과한 뒤에만 true가 될 수 있다). */
  created?: boolean;
  /** 사람이 읽는 안내. **키 값은 절대 담지 않는다.** */
  notices: string[];
  /** `.env`에서 대상 이름이 아니라 건너뛴 줄 수. **이름도 내용도 남기지 않는다** — 개수만. */
  skippedLines: number;
}

/** UTF-8 BOM 한 개를 벗긴다. 에디터가 붙인 BOM 때문에 첫 줄이 안 잡히는 것을 막는다. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** 따옴표 **한 쌍**만 벗긴다(값 안의 따옴표는 값이다). */
function unquoteOnce(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export interface ResolveKeyOptions {
  /** workspace 루트 override (테스트 seam — WORKSPACE_ROOT는 import 시각에 고정된다). */
  root?: string;
  /** env override (테스트 seam). **이 함수는 어느 경로에서도 env를 쓰지 않는다.** */
  env?: NodeJS.ProcessEnv;
}

/**
 * 리서치 키를 해석한다. **`process.env`를 변경하지 않는다** — 반환값이 유일한 출구다.
 *
 * 순서: ⓐ 셸(`process.env`)이 이긴다(기존 사용자 습관 보존 · §9-3) → ⓑ **공용 게이트**
 * `ensureEnvFileReady`(git 3-state · ignore 보장 · 0600 생성/검증 — A-5) → ⓒ 단일 이름 파싱.
 *
 * ⓑ가 **생성까지 담당하는** 것이 A-5의 수정이다: 예전엔 부재면 여기서 `absent`로 빠져나가고 호출자가
 * 나중에 template을 만들었다 — 그 순서에서는 새 `.env`가 git 안전 검사를 한 번도 통과하지 않는다.
 */
export function resolveResearchKey(opts: ResolveKeyOptions = {}): KeyResolution {
  const root = opts.root ?? WORKSPACE_ROOT;
  const env = opts.env ?? process.env;
  const envPath = envFilePath(root);

  const shell = env[TAVILY_SECRET_REF];
  if (typeof shell === "string" && shell.length > 0) {
    // 셸 키는 이미 자식 프로세스로 상속된다(우리가 만든 경로가 아니다 — 위 모듈 주석).
    return { envPath, key: shell, source: "shell", notices: [], skippedLines: 0 };
  }

  const ready = ensureEnvFileReady(root);
  if (!ready.ok) {
    return { envPath, key: null, source: "refused", refusedCode: ready.code, notices: ready.notices, skippedLines: 0 };
  }
  const notices = ready.notices;

  // ── 단일 이름 파싱 ──
  // BOM 제거 · CRLF 허용 · 주석/빈 줄 무시 · 대상 이름만. 마지막 선언이 이긴다(셸 관행).
  const text = stripBom(readFileSync(envPath, "utf8"));
  const re = new RegExp(`^(?:export\\s+)?${TAVILY_SECRET_REF}\\s*=\\s*(.*)$`);
  let raw: string | null = null;
  let skippedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const m = re.exec(t);
    if (!m) {
      skippedLines++; // 이름도 내용도 남기지 않는다 — 다른 비밀이 로그에 실리지 않게
      continue;
    }
    raw = m[1].trim();
  }
  // 값 안의 `#`은 값이다 — 인라인 주석을 벗기지 않는다(키에 `#`이 있으면 그것을 잘라 조용히 틀린
  // 키를 만든다). 대신 따옴표 한 쌍만 벗긴다.
  const key = raw === null ? null : unquoteOnce(raw);
  if (key === null || key.length === 0) {
    return { envPath, key: null, source: "absent", notices, skippedLines, created: ready.created };
  }
  return { envPath, key, source: "env_file", notices, skippedLines, created: ready.created };
}
