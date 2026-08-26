import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, ensureDir } from "../core/project.js";
import { ensureEnvTemplate } from "../core/envFile.js";
import { TAVILY_SECRET_REF } from "../tools/tavilyBackend.js";
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
- 00_IDEA.md 작성 후 harness run으로 workflow 실행.
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
    // [C-126] 리서치 키는 **사용자 단위**라 workspace 루트에 하나만 둔다(프로젝트별이 아니다).
    // 여기서 만들어 두는 이유: "키를 달라"는 안내가 실행 가능해야 한다 — 넣을 파일이 이미 있어야 한다.
    // 이미 있으면 한 글자도 건드리지 않는다.
    const env = ensureEnvTemplate();
    console.log(env.created
        ? `  ${env.path} 생성 — 외부 검색을 쓰려면 ${TAVILY_SECRET_REF}= 뒤에 **값만** 채우세요 (비워 두면 자체 리서치로 진행 · 커밋 금지)`
        : `  ${env.path} 이미 존재 — 유지 (내용을 건드리지 않았습니다)`);
}
