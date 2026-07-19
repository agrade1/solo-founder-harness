import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./redact.js";

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
 * record의 모든 문자열 값을 재귀적으로 redaction한 새 구조를 반환한다.
 * 원본 record는 변경하지 않는다. (배열/중첩 객체 포함)
 */
function sanitizeDeep(value: unknown, secretValues: string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, secretValues);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, secretValues));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeDeep(v, secretValues);
    return out;
  }
  return value;
}

/**
 * 주어진 파일 경로에 JSONL을 append하는 writer를 만든다.
 * 상위 디렉터리는 자동 생성한다. 파일이 이미 있으면 이어서 append한다.
 *
 * opts.redact가 true면 append 시 record의 모든 문자열 값을 redaction한다
 * (secret 이름이 없어도 Authorization/token/password 패턴은 적용). 원본 record 객체는 불변.
 * 미지정 시 기존 동작(원문 기록)과 완전 호환.
 */
export function createJsonlWriter(
  filePath: string,
  opts: { redact?: boolean; redactValues?: string[] } = {},
): JsonlWriter {
  mkdirSync(dirname(filePath), { recursive: true });
  let n = 0;
  return {
    path: filePath,
    append(record: unknown): void {
      const rec = opts.redact ? sanitizeDeep(record, opts.redactValues ?? []) : record;
      appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf8");
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
