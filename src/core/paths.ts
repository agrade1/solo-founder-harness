import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 이 모듈 위치: src/core/paths.ts (tsx) 또는 dist/core/paths.js (build).
// 두 경우 모두 두 단계 위가 repo root다.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");

/** repo root 기준 상대경로를 절대경로로 만든다. */
export function fromRoot(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}
