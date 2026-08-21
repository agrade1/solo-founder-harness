import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./redact.js";
/** 민감 key 이름(값 전체를 마스킹). 대소문자 무시, 부분 일치. */
const SENSITIVE_KEY = /(authorization|cookie|token|key|secret|password|credential)/i;
/** 재귀 깊이 상한 (stack overflow 방지). 초과 시 "[max-depth]"로 대체. */
export const MAX_SANITIZE_DEPTH = 64;
/**
 * 값을 재귀적으로 sanitize한 새 구조를 반환한다 (원본 불변).
 *  - 민감 key(authorization/cookie/token/key/secret/password/credential)의 값은 통째로 "***".
 *  - 문자열은 secret 실제 값 + Authorization/`key=`/`token=` 등 credential 패턴(URL query 포함)을 redaction.
 *  - 배열/중첩 객체 재귀. depth 상한 초과 시 "[max-depth]" (stack overflow 방지).
 */
export function sanitizeValue(value, opts = {}, depth = 0) {
    const secretValues = opts.secretValues ?? [];
    const maxDepth = opts.maxDepth ?? MAX_SANITIZE_DEPTH;
    if (depth > maxDepth)
        return "[max-depth]";
    if (typeof value === "string")
        return redactSecrets(value, secretValues);
    if (Array.isArray(value))
        return value.map((v) => sanitizeValue(v, opts, depth + 1));
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SENSITIVE_KEY.test(k) ? "***" : sanitizeValue(v, opts, depth + 1);
        }
        return out;
    }
    return value;
}
/**
 * 주어진 파일 경로에 JSONL을 append하는 writer를 만든다.
 * 상위 디렉터리는 자동 생성한다. 파일이 이미 있으면 이어서 append한다.
 *
 * opts.redact가 true면 append 시 record를 sanitizeValue로 재귀 redaction한다
 * (민감 key 마스킹 + secret 값/credential 패턴). 원본 record 객체는 불변.
 * 미지정 시 기존 동작(원문 기록)과 완전 호환.
 *
 * append는 `appendFileSync`로 라인 전체(개행 포함)를 단일 호출 기록한다. 병렬 collector가
 * 같은 파일에 append해도 각 라인이 온전하려면 라인이 충분히 작아야 한다(호출측이 크기 상한 적용).
 */
export function createJsonlWriter(filePath, opts = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    let n = 0;
    return {
        path: filePath,
        append(record) {
            const rec = opts.redact ? sanitizeValue(record, { secretValues: opts.redactValues ?? [] }) : record;
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
