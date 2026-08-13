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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 원문 1건의 byte 상한. 넘으면 저장하지 않고 거부한다(조용한 절삭이 아니다). */
export const MAX_RAW_BYTES = 512 * 1024;
/** 모델에 전달되는 요약의 코드 포인트 상한. 넘으면 절삭한다. */
export const MAX_SUMMARY_CHARS = 1200;
/** 요약 1건의 제목 상한. */
export const MAX_TITLE_CHARS = 200;

export class EvidenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvidenceError";
    this.code = code;
  }
}

/** 중앙·프롬프트가 운반하는 유일한 형태. **원문 필드가 없다.** */
export interface EvidenceItem {
  source: string; // 원문 URL
  sha256: string; // 원문 내용 digest = 파일 신원
  retrievedAt: string; // ISO
  bytes: number; // 원문 byte 수
  rawPath: string; // 저장소 상대 경로 (포인터)
  title: string;
  summary: string; // bounded — 모델에 전달되는 축약본
}

export interface StoreEvidenceInput {
  source: string;
  retrievedAt: string;
  raw: string;
  title: string;
  summary: string;
}

function bounded(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") throw new EvidenceError("invalid_evidence", `${what}는 문자열이어야 한다`);
  return [...v].slice(0, max).join("");
}

/**
 * 원문을 content-addressed 파일로 저장하고 포인터를 돌려준다.
 * 같은 입력 → 같은 바이트 · 같은 경로(결정성). 이미 있는 원문은 다시 쓰지 않는다.
 */
export function storeEvidence(dir: string, input: StoreEvidenceInput): EvidenceItem {
  if (typeof input.source !== "string" || !/^https:\/\/[^\s]+$/.test(input.source)) {
    throw new EvidenceError("invalid_source", `evidence.source는 https URL이어야 한다: ${String(input.source)}`);
  }
  if (typeof input.raw !== "string") throw new EvidenceError("invalid_evidence", "evidence.raw는 문자열이어야 한다");
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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }

  const item: EvidenceItem = {
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
