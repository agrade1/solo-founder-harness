import { existsSync, mkdirSync } from "node:fs";
import { fromWorkspace } from "./paths.js";
/**
 * 검토 대상 아이디어 문서의 프로젝트 상대경로 — kill 잠금과 checkpoint 결박의 기준 파일.
 *
 * [C-154ⓒ] 여기(leaf)에 둔다: `core/pipeline.ts`가 이 경로를 manifest에 담아야 하는데
 * 원래 자리인 `core/runWorkflow.ts`는 **`core/pipeline.ts`를 import한다**. 값을 그쪽에서 가져오면
 * 런타임 순환이 생기므로(지금은 `import type`이라 순환이 없다) 둘 다 이미 의존하는 이 모듈로 옮겼다.
 * `runWorkflow.ts`가 그대로 re-export하므로 기존 import는 하나도 바뀌지 않는다.
 */
export const IDEA_REL = "docs/00_IDEA.md";
/** projects/<name> 하위 경로 묶음을 계산한다. (생성은 하지 않음) */
export function projectPaths(name) {
    const root = fromWorkspace("projects", name);
    return {
        name,
        root,
        docs: fromWorkspace("projects", name, "docs"),
        outputs: fromWorkspace("projects", name, "outputs"),
    };
}
/** 디렉토리를 재귀 생성한다. 이미 있으면 무시. */
export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}
/** 프로젝트가 이미 존재하는지 (docs 폴더 기준) */
export function projectExists(name) {
    return existsSync(projectPaths(name).docs);
}
