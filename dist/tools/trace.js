import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
/**
 * 주어진 파일 경로에 JSONL을 append하는 writer를 만든다.
 * 상위 디렉터리는 자동 생성한다. 파일이 이미 있으면 이어서 append한다.
 */
export function createJsonlWriter(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    let n = 0;
    return {
        path: filePath,
        append(record) {
            appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
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
