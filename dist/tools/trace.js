import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./redact.js";
/**
 * record의 모든 문자열 값을 재귀적으로 redaction한 새 구조를 반환한다.
 * 원본 record는 변경하지 않는다. (배열/중첩 객체 포함)
 */
function sanitizeDeep(value, secretValues) {
    if (typeof value === "string")
        return redactSecrets(value, secretValues);
    if (Array.isArray(value))
        return value.map((v) => sanitizeDeep(v, secretValues));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value))
            out[k] = sanitizeDeep(v, secretValues);
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
export function createJsonlWriter(filePath, opts = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    let n = 0;
    return {
        path: filePath,
        append(record) {
            const rec = opts.redact ? sanitizeDeep(record, opts.redactValues ?? []) : record;
            appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf8");
            n++;
        },
        count() {
            return n;
        },
        close() {
            /* append가 즉시 flush라 정리할 자원 없음. M3+ 실제 배선 시 확장 여지. */
        },
    };
}
