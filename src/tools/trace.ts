import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 범용 JSONL(라인 구분 JSON) append writer 골격 (V3 MCP M1).
 *
 * M1에서는 특정 ToolTrace 스키마에 고정하지 않는다 — 임의 레코드를 한 줄씩 append하는
 * 최소 writer만 제공한다. 실제 MCP/API/CLI 공통 ToolTrace 스키마 정의와 runWorkflow
 * 배선(tool 이벤트 → trace 기록)은 M3 이후로 남긴다.
 *
 * 의존성 0. 각 레코드는 `JSON.stringify(record) + "\n"`으로 직렬화되어 append된다.
 */
export interface JsonlWriter {
  /** 이 writer가 기록하는 파일의 절대/상대 경로. */
  readonly path: string;
  /** 레코드 1건을 JSON 한 줄로 append한다. */
  append(record: unknown): void;
  /** 지금까지 append된 레코드 수. */
  count(): number;
  /** 리소스 정리 훅 (현재 append는 즉시 flush라 no-op — 인터페이스 안정성용). */
  close(): void;
}

/**
 * 주어진 파일 경로에 JSONL을 append하는 writer를 만든다.
 * 상위 디렉터리는 자동 생성한다. 파일이 이미 있으면 이어서 append한다.
 */
export function createJsonlWriter(filePath: string): JsonlWriter {
  mkdirSync(dirname(filePath), { recursive: true });
  let n = 0;
  return {
    path: filePath,
    append(record: unknown): void {
      appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
      n++;
    },
    count(): number {
      return n;
    },
    close(): void {
      /* append가 즉시 flush라 정리할 자원 없음. M3+ 실제 배선 시 확장 여지. */
    },
  };
}
