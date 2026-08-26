/**
 * V3 M7 T2 — research `EvidenceItem` + 저장 계약.
 *
 * **원문은 파일, 중앙은 포인터**(로드맵 §3.2). 외부에서 들여온 원문은 content-addressed 파일로만 남고,
 * kernel state·프롬프트에 실리는 것은 `EvidenceItem`(포인터 + bounded 요약)뿐이다.
 *
 * 새 SoR을 만들지 않는다 — JSONL은 사람이 읽는 인덱스이고 권위는 파일 내용(sha256)에 있다.
 * `liveEvidence.ts`와 다른 것이다: 그쪽은 live acceptance의 **metrics 전용**이고 경로·원문을 담지 않는다.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** 원문 1건의 byte 상한. 넘으면 저장하지 않고 거부한다(조용한 절삭이 아니다). */
export const MAX_RAW_BYTES = 512 * 1024;
/** 모델에 전달되는 요약의 코드 포인트 상한. 넘으면 절삭한다. */
export const MAX_SUMMARY_CHARS = 1200;
/** 요약 1건의 제목 상한. */
export const MAX_TITLE_CHARS = 200;
export class EvidenceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "EvidenceError";
        this.code = code;
    }
}
function bounded(v, what, max) {
    if (typeof v !== "string")
        throw new EvidenceError("invalid_evidence", `${what}는 문자열이어야 한다`);
    return [...v].slice(0, max).join("");
}
/**
 * 원문을 content-addressed 파일로 저장하고 포인터를 돌려준다.
 * 같은 입력 → 같은 바이트 · 같은 경로(결정성). 이미 있는 원문은 다시 쓰지 않는다.
 */
export function storeEvidence(dir, input) {
    if (typeof input.source !== "string" || !/^https:\/\/[^\s]+$/.test(input.source)) {
        throw new EvidenceError("invalid_source", `evidence.source는 https URL이어야 한다: ${String(input.source)}`);
    }
    if (typeof input.raw !== "string")
        throw new EvidenceError("invalid_evidence", "evidence.raw는 문자열이어야 한다");
    const bytes = Buffer.byteLength(input.raw, "utf8");
    if (bytes > MAX_RAW_BYTES) {
        throw new EvidenceError("raw_too_large", `원문이 상한 ${MAX_RAW_BYTES} bytes를 넘는다: ${bytes}`);
    }
    const sha256 = createHash("sha256").update(input.raw, "utf8").digest("hex");
    const rawPath = join("raw", `${sha256}.txt`);
    mkdirSync(join(dir, "raw"), { recursive: true, mode: 0o700 });
    // 이미 같은 내용이 있으면 그 파일이 정답이다 — 덮어쓰지 않는다(내용이 곧 신원).
    try {
        writeFileSync(join(dir, rawPath), input.raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
        // [C-126/A-8] EEXIST를 **무조건 정답으로 접지 않는다.** 파일 이름이 내용의 sha256이라는 것은
        // 우리가 쓴 경우에만 성립하고, 누군가 그 자리에 다른 바이트를 두면(또는 부분 쓰기가 남으면)
        // 그 뒤의 모든 인용 대조가 "hash는 맞는데 파일은 다른" 거짓이 된다. 실제 바이트를 다시 해시해
        // 신원을 확인하고, 어긋나면 저장을 거부한다(조용히 덮어쓰지도 않는다 — 남의 바이트다).
        let onDisk;
        try {
            onDisk = readFileSync(join(dir, rawPath));
        }
        catch (re) {
            throw new EvidenceError("evidence_raw_unreadable", `기존 원문 파일을 읽을 수 없다: ${rawPath} (${re.message})`);
        }
        const actual = createHash("sha256").update(onDisk).digest("hex");
        if (actual !== sha256) {
            throw new EvidenceError("evidence_hash_mismatch", `content-addressed 경로에 다른 바이트가 있다: ${rawPath} (기대 ${sha256} · 실제 ${actual}) — 덮어쓰지 않고 거부한다`);
        }
    }
    const item = {
        source: input.source,
        sha256,
        retrievedAt: input.retrievedAt,
        bytes,
        rawPath,
        title: bounded(input.title, "evidence.title", MAX_TITLE_CHARS),
        summary: bounded(input.summary, "evidence.summary", MAX_SUMMARY_CHARS),
    };
    appendFileSync(join(dir, "evidence.jsonl"), JSON.stringify(item) + "\n", { encoding: "utf8", mode: 0o600 });
    return item;
}
