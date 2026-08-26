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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "./paths.js";
import { TAVILY_SECRET_REF } from "../tools/tavilyBackend.js";
/** workspace 루트의 `.env` — **단수다**(per-project `.env`는 기각: 키는 사용자 단위다 · §9-4). */
export const ENV_FILE_NAME = ".env";
/** managed block 경계. 이 두 줄이 있으면 다시 쓰지 않는다(멱등). */
const GITIGNORE_BEGIN = "# --- harness managed (C-126 리서치 키) ---";
const GITIGNORE_END = "# --- end harness managed ---";
const GITIGNORE_ENTRIES = [ENV_FILE_NAME, "projects/*/outputs/research/"];
export function envFilePath(root = WORKSPACE_ROOT) {
    return join(root, ENV_FILE_NAME);
}
/**
 * 템플릿 본문. **키 값을 요구하는 문장을 프롬프트/채팅 쪽으로 유도하지 않는다** — 사용자는 이 파일에만
 * 넣는다. 검색어 전송 고지를 여기 싣는 이유: 키를 넣는 그 순간이 "내 질의가 외부로 나간다"를 알려야
 * 하는 유일한 자리다(설계 §2 · B-2).
 */
function templateBody() {
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
/**
 * `.env`가 없으면 0600으로 만든다. **있으면 한 글자도 바꾸지 않는다**(사용자가 채운 값·다른 변수 보호).
 * `flag:"wx"`로 만드는 이유: exists 확인과 쓰기 사이에 다른 프로세스가 만들었으면 그 파일이 정답이다.
 */
export function ensureEnvTemplate(root = WORKSPACE_ROOT) {
    const path = envFilePath(root);
    try {
        writeFileSync(path, templateBody(), { encoding: "utf8", mode: 0o600, flag: "wx" });
        return { path, created: true };
    }
    catch (err) {
        if (err.code === "EEXIST")
            return { path, created: false };
        throw err;
    }
}
// ── git 안전 검사 ───────────────────────────────────────────────
/** git 하나를 조용히 돌린다. exit 0이면 ok. git이 없거나 repo가 아니면 ok:false. */
function git(root, args) {
    try {
        execFileSync("git", args, { cwd: root, stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
/** workspace가 git work tree 안인가. 아니면 커밋 위험 자체가 없어 이후 검사를 건너뛴다. */
function insideWorkTree(root) {
    return git(root, ["rev-parse", "--is-inside-work-tree"]);
}
/** `.env`가 이미 **추적 중**인가 (index에 있으면 다음 커밋에 실린다). */
function trackedByGit(root) {
    return git(root, ["ls-files", "--error-unmatch", "--", ENV_FILE_NAME]);
}
/**
 * `.env`가 **최종적으로** ignore되는가. `git check-ignore`를 쓰는 이유: `.gitignore`에 `.env`가
 * 있는지 grep하는 것으로는 부정 규칙(`!.env`)·하위 디렉터리 규칙·`core.excludesFile`을 판정할 수
 * 없다. 여기서 묻는 것은 "지금 이 파일이 무시되는가"라는 git 자신의 답이다.
 */
function ignoredByGit(root) {
    return git(root, ["check-ignore", "-q", "--", ENV_FILE_NAME]);
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
export function ensureGitignoreBlock(root) {
    const abs = join(root, ".gitignore");
    const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    if (existing.includes(GITIGNORE_BEGIN))
        return false;
    const block = [GITIGNORE_BEGIN, ...GITIGNORE_ENTRIES, GITIGNORE_END, ""].join("\n");
    appendFileSync(abs, (existing.length > 0 && !existing.endsWith("\n") ? "\n" : "") + block, { encoding: "utf8" });
    return true;
}
/** UTF-8 BOM 한 개를 벗긴다. 에디터가 붙인 BOM 때문에 첫 줄이 안 잡히는 것을 막는다. */
function stripBom(s) {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
/** 따옴표 **한 쌍**만 벗긴다(값 안의 따옴표는 값이다). */
function unquoteOnce(v) {
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        return v.slice(1, -1);
    }
    return v;
}
/**
 * 리서치 키를 해석한다. **`process.env`를 변경하지 않는다** — 반환값이 유일한 출구다.
 *
 * 순서: ⓐ 셸(`process.env`)이 이긴다(기존 사용자 습관 보존 · §9-3) → ⓑ `.env` 부재면 absent →
 * ⓒ git 안전 검사(추적 중 = 거부 · 미ignore면 append 후 재확인, 그래도 아니면 거부) → ⓓ 단일 이름 파싱.
 */
export function resolveResearchKey(opts = {}) {
    const root = opts.root ?? WORKSPACE_ROOT;
    const env = opts.env ?? process.env;
    const envPath = envFilePath(root);
    const notices = [];
    const shell = env[TAVILY_SECRET_REF];
    if (typeof shell === "string" && shell.length > 0) {
        // 셸 키는 이미 자식 프로세스로 상속된다(우리가 만든 경로가 아니다 — 위 모듈 주석).
        return { envPath, key: shell, source: "shell", notices, skippedLines: 0 };
    }
    if (!existsSync(envPath)) {
        return { envPath, key: null, source: "absent", notices, skippedLines: 0 };
    }
    if (insideWorkTree(root)) {
        if (trackedByGit(root)) {
            // **키를 읽지 않는다.** 추적 중인 파일에 있는 값은 이미 유출 경로에 올라가 있고, 그것을 읽어
            // 쓰는 것은 "괜찮다"는 신호가 된다. history 정리는 주장하지 않는다 — 회전만이 실제 대응이다.
            return {
                envPath,
                key: null,
                source: "refused",
                refusedCode: "env_file_tracked_by_git",
                notices: [
                    `${ENV_FILE_NAME}이 git에 **추적 중**입니다 (${envPath}) — 키를 읽지 않았습니다.`,
                    `1) 그 키를 폐기·재발급하세요 (이미 커밋됐다면 값은 되돌릴 수 없습니다 — 이 도구는 git history를 정리하지 않습니다).`,
                    `2) 추적에서 빼세요: git rm --cached ${ENV_FILE_NAME}`,
                    `3) ${ENV_FILE_NAME}이 ignore되는지 확인한 뒤 새 키를 넣으세요: git check-ignore -v ${ENV_FILE_NAME}`,
                    `그때까지는 자체 리서치(self)로 진행합니다.`,
                ],
                skippedLines: 0,
            };
        }
        if (!ignoredByGit(root)) {
            const changed = ensureGitignoreBlock(root);
            if (changed)
                notices.push(`.gitignore에 ${GITIGNORE_ENTRIES.join(" · ")} 규칙을 추가했습니다 (${join(root, ".gitignore")}).`);
            if (!ignoredByGit(root)) {
                return {
                    envPath,
                    key: null,
                    source: "refused",
                    refusedCode: "env_file_not_ignored",
                    notices: [
                        ...notices,
                        `${ENV_FILE_NAME}이 여전히 git에서 무시되지 않습니다 (${envPath}) — 키를 읽지 않았습니다.`,
                        `우선순위가 더 높은 부정 규칙이 있을 수 있습니다: git check-ignore -v ${ENV_FILE_NAME} 로 어느 규칙인지 확인하세요.`,
                        `그때까지는 자체 리서치(self)로 진행합니다.`,
                    ],
                    skippedLines: 0,
                };
            }
        }
    }
    // ── 단일 이름 파싱 ──
    // BOM 제거 · CRLF 허용 · 주석/빈 줄 무시 · 대상 이름만. 마지막 선언이 이긴다(셸 관행).
    const text = stripBom(readFileSync(envPath, "utf8"));
    const re = new RegExp(`^(?:export\\s+)?${TAVILY_SECRET_REF}\\s*=\\s*(.*)$`);
    let raw = null;
    let skippedLines = 0;
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t.length === 0 || t.startsWith("#"))
            continue;
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
        return { envPath, key: null, source: "absent", notices, skippedLines };
    }
    return { envPath, key, source: "env_file", notices, skippedLines };
}
