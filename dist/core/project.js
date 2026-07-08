import { existsSync, mkdirSync } from "node:fs";
import { fromWorkspace } from "./paths.js";
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
