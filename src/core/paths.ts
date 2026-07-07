import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

/**
 * 경로는 두 종류로 분리한다 (라이브러리 모델):
 *  - PACKAGE_ROOT: 하네스 패키지 자산(agents/, registry/, prompts/). 모듈 위치 기준.
 *      개발(tsx): src/core/paths.ts → 두 단계 위 = repo root
 *      빌드/설치(dist): dist/core/paths.js → 두 단계 위 = 패키지 루트(node_modules/solo-founder-harness)
 *  - WORKSPACE_ROOT: 사용자 데이터(projects/, docs, outputs). 실행한 레포(CWD) 기준.
 *      → 다른 프로젝트 레포에서 설치해 쓰면 그 레포에 projects/가 생긴다.
 *      HARNESS_WORKSPACE 로 명시 오버라이드 가능.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, "..", "..");

export const WORKSPACE_ROOT = (() => {
  const override = process.env.HARNESS_WORKSPACE;
  if (override && override.trim()) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }
  return process.cwd();
})();

/** 패키지 자산(agents/registry 등) 상대경로를 절대경로로. */
export function fromPackage(...segments: string[]): string {
  return resolve(PACKAGE_ROOT, ...segments);
}

/** 사용자 데이터(projects 등) 상대경로를 절대경로로 (CWD 기준). */
export function fromWorkspace(...segments: string[]): string {
  return resolve(WORKSPACE_ROOT, ...segments);
}
