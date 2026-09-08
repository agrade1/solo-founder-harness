import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDEA_REL, projectPaths, ensureDir } from "../core/project.js";
import { fromWorkspace } from "../core/paths.js";
import { ensureEnvFileReady } from "../core/envFile.js";
import { TAVILY_SECRET_REF } from "../tools/tavilyBackend.js";
/**
 * 작업 폴더에서 **이미 쓴 아이디어 문서**를 찾는 순서. 먼저 맞는 것 하나만 쓴다.
 *
 * 왜: 예전엔 `init`이 템플릿만 만들었고 사람이 자기 문서를 `projects/<name>/docs/00_IDEA.md`로
 * **직접 복사**해야 했다. "작업 폴더에 아이디어 문서 두고 설치해서 실행"이라는 사용 모양에서
 * 그 복사 한 번이 유일한 수작업이었다.
 *
 * `docs/00_IDEA.md`가 맨 앞인 이유: 프로젝트 내부 배치와 같은 모양이라 옮겨 담을 때 헷갈리지 않는다.
 */
// 소문자 형태를 대문자보다 앞에 둔다: macOS처럼 **대소문자를 무시하는 파일시스템**에서는 어느
// 후보로도 같은 파일이 잡히는데, 그때 우리가 인쇄하는 이름이 사람이 실제로 만든 이름과 달라진다
// (`idea.md`를 만들었는데 "IDEA.md를 찾았습니다"라고 말한다 — 이 레포가 반복해 다친 거짓 안내 계열).
const IDEA_CANDIDATES = ["docs/00_IDEA.md", "00_IDEA.md", "docs/idea.md", "idea.md", "docs/IDEA.md", "IDEA.md"];
/** 워크스페이스 루트에서 아이디어 문서를 찾는다. 없으면 null. */
export function findWorkspaceIdea() {
    for (const rel of IDEA_CANDIDATES) {
        const abs = fromWorkspace(rel);
        let st;
        try {
            st = statSync(abs);
        }
        catch {
            continue;
        }
        // 일반 파일만 — 디렉터리·symlink 대상 없음 등은 후보가 아니다.
        if (!st.isFile())
            continue;
        const content = readFileSync(abs, "utf8");
        if (content.trim().length === 0)
            continue; // 빈 파일은 템플릿보다 나을 것이 없다
        return { rel, abs, content };
    }
    return null;
}
/** init이 생성하는 필수 docs 6개 (spec 4.1 = acceptance Test 1) */
function docTemplates(name, today) {
    return {
        "00_IDEA.md": `# 00_IDEA.md — ${name}

## 아이디어 한 줄 정의
(여기에 아이디어를 한 문장으로 적는다)

## 문제
-

## 대상 사용자
-

## 왜 지금 / 왜 이걸
-
`,
        "TASKS.md": `# TASKS.md — ${name}

## 진행 중
- [ ]

## 다음
- [ ]

## 완료
-
`,
        "DECISIONS.md": `# DECISIONS.md — ${name}

## ${today}
- 프로젝트 초기화
`,
        "CONTEXT_SUMMARY.md": `# CONTEXT_SUMMARY.md — ${name}

최종 갱신: ${today}

## 현재 상태
- 프로젝트 초기화됨. 아직 workflow 미실행.

## 다음 작업
- 00_IDEA.md를 실제 아이디어로 채운 뒤(이 템플릿 문장은 그대로 두면 안 된다) 4단계 파이프라인 실행:
  \`harness pipeline next --project ${name} --provider <mock|claude-code|anthropic>\`
  단계마다 확인 대기에서 멈춘다 — 승인해야 다음 단계가 돈다.
  (workflow 하나만 돌리려면 \`harness run <workflow> --project ${name}\`.)
`,
        "WORKLOG.md": `# WORKLOG.md — ${name}

## ${today}
- 프로젝트 초기화 (harness init)
`,
        "API_CONTRACT.md": `# API_CONTRACT.md — ${name}

## 개요
(외부/내부 API 계약을 여기에 정의한다. 아직 없으면 비워둔다.)

## 엔드포인트
-
`,
    };
}
/**
 * harness init <name>: projects/<name>/docs (필수 6개) + outputs 폴더 생성.
 * 이미 있는 파일은 덮어쓰지 않고 건너뛴다 (사용자 내용 보호).
 */
export function runInit(name) {
    const paths = projectPaths(name);
    const today = new Date().toISOString().slice(0, 10);
    ensureDir(paths.docs);
    ensureDir(paths.outputs);
    const templates = docTemplates(name, today);
    const created = [];
    const skipped = [];
    // 작업 폴더에 이미 아이디어 문서가 있으면 **템플릿 대신 그 내용으로** 만든다.
    // **옮기지 않고 복사한다**: 원본을 지우면 되돌릴 수 없고, `init`은 되돌릴 수 없는 일을 하지 않는다.
    // 대신 정본이 어디인지 아래에서 말한다 — 사본이 둘이면 사람이 엉뚱한 쪽을 고친다.
    const ideaFile = IDEA_REL.split("/").pop();
    const found = findWorkspaceIdea();
    const adoptedFrom = found && !existsSync(join(paths.docs, ideaFile)) ? found : null;
    if (adoptedFrom)
        templates[ideaFile] = adoptedFrom.content;
    for (const [file, content] of Object.entries(templates)) {
        const target = join(paths.docs, file);
        if (existsSync(target)) {
            skipped.push(file);
            continue;
        }
        writeFileSync(target, content, "utf8");
        created.push(file);
    }
    console.log(`프로젝트 생성: projects/${name}`);
    console.log(`  docs/    (${created.length}개 생성${skipped.length ? `, ${skipped.length}개 기존 유지` : ""})`);
    for (const f of created)
        console.log(`    + ${f}`);
    for (const f of skipped)
        console.log(`    = ${f} (이미 존재, 유지)`);
    console.log(`  outputs/ 준비 완료`);
    if (adoptedFrom) {
        console.log("");
        console.log(`아이디어 문서를 찾아 담았습니다: ${adoptedFrom.rel} → projects/${name}/${IDEA_REL}`);
        console.log(`  원본은 그대로 둡니다(복사입니다). **이제부터 정본은 projects/${name}/${IDEA_REL}입니다** —`);
        console.log(`  ${adoptedFrom.rel}를 고쳐도 파이프라인은 보지 않습니다.`);
    }
    else if (found) {
        // 조용히 무시하지 않는다: 사람은 자기 문서가 쓰였다고 믿고 있을 수 있다.
        const same = readFileSync(join(paths.docs, ideaFile), "utf8") === found.content;
        console.log("");
        console.log(`알림: ${found.rel}를 찾았지만 담지 않았습니다 — projects/${name}/${IDEA_REL}가 이미 있습니다(덮어쓰지 않습니다).`);
        console.log(`  두 파일의 내용은 ${same ? "같습니다" : "**다릅니다** — 파이프라인이 보는 것은 projects 쪽입니다"}.`);
    }
    // [C-126] 리서치 키는 **사용자 단위**라 workspace 루트에 하나만 둔다(프로젝트별이 아니다).
    // 여기서 만들어 두는 이유: "키를 달라"는 안내가 실행 가능해야 한다 — 넣을 파일이 이미 있어야 한다.
    // 이미 있으면 한 글자도 건드리지 않는다.
    // **게이트를 거쳐야 한다**(오케스트레이터 CLI 실측 · A-5 잔여): 예전 판은 여기서
    // `ensureEnvTemplate()`을 직접 불러 **git 안전 검사 없이** `.env`를 만들었다 — git repo에
    // `.gitignore`가 없으면 키 파일이 **unignored로 생성**됐다(실측: `git check-ignore .env` 불일치).
    // `ensureEnvFileReady`는 git 3-state → 추적 중 거부 → ignore 보장·재확인 → 그 다음 0600 생성이다.
    // 거부는 `init` 자체를 실패시키지 않는다: 프로젝트 골격 생성은 리서치 키와 무관한 일이고,
    // 거부 사유를 그대로 출력해 사람이 고칠 수 있게 한다(조용한 실패가 아니다).
    const env = ensureEnvFileReady();
    if (env.ok) {
        console.log(env.created
            ? `  ${env.path} 생성 — 외부 검색을 쓰려면 ${TAVILY_SECRET_REF}= 뒤에 **값만** 채우세요 (비워 두면 자체 리서치로 진행 · 커밋 금지)`
            : `  ${env.path} 이미 존재 — 유지 (내용을 건드리지 않았습니다)`);
    }
    else {
        console.log(`  ${TAVILY_SECRET_REF} 파일 준비를 건너뜀 (${env.code}) — 외부 검색 없이 자체 리서치로 진행됩니다`);
    }
    for (const n of env.notices)
        console.log(`    ${n}`);
    // [C-154ⓐ] 다음 걸음을 **콘솔에서도** 말한다. 예전엔 4단계 파이프라인으로 가는 길이 생성된
    // `CONTEXT_SUMMARY.md` 안에만 있어서, `init`을 돌린 사람은 그 파일을 열기 전까지 아무 안내도 못 받았다.
    // 문구는 그 템플릿과 **같은 명령**이다 — 두 벌이면 한쪽만 정직해진다(함정 27).
    console.log("");
    // 아이디어를 이미 담았으면 "채우세요"는 **거짓 지시**다 — 사람이 다 된 일을 다시 하러 간다.
    // 분기 하나를 더 두는 대신 이 줄만 갈아 끼운다(뒤 두 줄은 두 경우에 똑같이 참이다).
    console.log(adoptedFrom
        ? `다음: projects/${name}/${IDEA_REL}를 한 번 확인하세요 (${adoptedFrom.rel}에서 담은 내용 그대로입니다).`
        : `다음: docs/00_IDEA.md를 실제 아이디어로 채우세요 (템플릿 문장을 그대로 두면 안 됩니다).`);
    console.log(`  그다음 4단계 파이프라인: harness pipeline next --project ${name} --provider <mock|claude-code|anthropic>`);
    console.log(`  단계마다 확인 대기에서 멈춥니다 — 승인해야 다음 단계가 돕니다 (승인 우회 플래그는 없습니다).`);
}
