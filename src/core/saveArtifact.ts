import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectPaths, ensureDir } from "./project.js";

/**
 * agent 결과를 프로젝트 하위 상대경로(default_output, 예: "docs/01_RESEARCH.md")에 저장한다.
 * 저장한 파일의 프로젝트 상대경로를 반환한다.
 */
export function saveArtifact(project: string, relOutputPath: string, markdown: string): string {
  const root = projectPaths(project).root;
  const target = join(root, relOutputPath);
  ensureDir(dirname(target));
  writeFileSync(target, markdown, "utf8");
  return relOutputPath;
}
