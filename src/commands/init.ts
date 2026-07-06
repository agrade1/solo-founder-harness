import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectPaths, ensureDir } from "../core/project.js";

/** init이 생성하는 필수 docs 6개 (spec 4.1 = acceptance Test 1) */
function docTemplates(name: string, today: string): Record<string, string> {
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
export function runInit(name: string): void {
  const paths = projectPaths(name);
  const today = new Date().toISOString().slice(0, 10);

  ensureDir(paths.docs);
  ensureDir(paths.outputs);

  const templates = docTemplates(name, today);
  const created: string[] = [];
  const skipped: string[] = [];

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
  for (const f of created) console.log(`    + ${f}`);
  for (const f of skipped) console.log(`    = ${f} (이미 존재, 유지)`);
  console.log(`  outputs/ 준비 완료`);
}
