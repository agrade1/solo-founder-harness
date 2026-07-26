import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { collectSecretValues, redactSecrets } from "./redact.js";

/**
 * [V3 M3d.2] live acceptance runner의 **성공 전용 redacted evidence** 영속화.
 *
 * 목적: 사용자가 실행한 live runner의 PASS를 저장소에서 사후 재검증할 수 있게 하되,
 * 원문·식별자·비밀은 어떤 형태로도 남기지 않는다.
 *
 * 계약(fail-closed):
 *  - 허용 top-level 필드는 정확히 version/contract/status/timestamp/metrics 5개다.
 *  - metrics는 계약(runner)별로 **정확한 key 집합**이며 값은 0 이상 유한 정수 또는 boolean만이다.
 *  - 모든 객체 레벨에서 unknown key를 거부한다(JSON Schema additionalProperties:false와 동일).
 *  - status는 "pass" 고정 — 실패/스킵/미실행 run은 evidence를 남기지 않는다.
 *  - 금지 필드(raw transcript, tool/MCP 입출력, argv, 명령, 파일 경로, hostname/user, PID,
 *    session/call/request ID, 환경변수·secret 참조/값, config 본문, free-form error/message)는
 *    key 이름 스캔으로 먼저 거부한다. redaction 마커로 치환했다고 허용되지 않는다.
 *  - 영속화 직전 기존 redactSecrets/collectSecretValues로 잔재를 재검사한다(defense in depth).
 *    잔재가 발견되면 **가리고 저장하지 않고 쓰기를 거부**한다.
 *
 * 저장(fail-closed, temp → atomic publish):
 *  - 같은 디렉터리의 **숨김 임시 파일**에 먼저 전부 쓰고 chmod·fsync·close·재검증까지 끝낸 뒤,
 *    **덮어쓰지 않는 원자적 publish**(exclusive hard link)로 최종 파일명을 만든다.
 *    따라서 쓰기 중 크래시가 나도 **성공 산출물 파일명(최종 이름)의 잘린 파일은 존재할 수 없다.**
 *  - 디렉터리 0700 / 파일 0600. symlink·비디렉터리 대상 거부(lstat + bounded 상위 검사).
 *  - 디렉터리·파일 **dev+ino 신원**을 보관해 publish 직전 재확인하고, 정리(unlink)도 신원 확인 후에만 한다
 *    (교체된 파일을 지우지 않기 위함). 잡아낸 정리 실패는 조용히 무시하지 않고 오류로 보고한다.
 *  - 가능한 플랫폼에서는 publish 후 디렉터리 fsync로 durability를 보강한다(미지원은 무해하게 통과).
 *  - 경로는 내부 반환값으로만 쓰고 evidence payload에 담지 않는다. 본문·경로는 콘솔에 출력하지 않는다.
 *
 * 남는 한계(과장하지 않는다): Node 18 API로는 디렉터리 **핸들 상대** 열기(openat/O_NOFOLLOW 상대 경로)가 없어,
 * 경로 기반 open/link 사이의 TOCTOU를 완전히 없앨 수는 없다. 위 신원 비교는 그 창을 좁히고 사후 탐지하는
 * 완화이며 완전 방어가 아니다. evidence 디렉터리는 신뢰 경계 안(레포 소유)이라는 전제를 유지한다.
 *
 * JSON Schema 계약 문서: schemas/live_evidence.schema.json (테스트가 동기 상태를 강제한다).
 */

export const LIVE_EVIDENCE_VERSION = "1";
export const LIVE_EVIDENCE_STATUS = "pass";

/** metrics 정수 상한 (bounded evidence). */
export const MAX_METRIC_INT = 1_000_000;
/** 직렬화 evidence 총 byte 상한 (bounded evidence). */
export const MAX_EVIDENCE_BYTES = 4096;
/** 중첩 스캔 깊이 상한 — 초과 시 거부(무한/과대 구조 차단). */
const MAX_SCAN_DEPTH = 6;

export type MetricKind = "integer" | "boolean";

/** runner별 discriminated 계약. metrics key 집합은 정확 일치를 요구한다. */
export const CONTRACT_SPECS: Record<string, Record<string, MetricKind>> = {
  m3a_live_preflight: {
    expectedServerCount: "integer",
    expectedToolCount: "integer",
    expectedServerConnected: "boolean",
    snapshotWritten: "boolean",
    ambientCanarySpawned: "boolean",
    fixtureExitedWithinLimit: "boolean",
    sentinelLeakAbsent: "boolean",
    sensitivePatternAbsent: "boolean",
  },
  m3b2_live_handoff: {
    hookKindCount: "integer",
    traceRecordCount: "integer",
    distinctSessionCount: "integer",
    toolRequestedCount: "integer",
    toolSucceededCount: "integer",
    toolFailedCount: "integer",
    permissionRequestedCount: "integer",
    sessionEndCount: "integer",
    emptyMcpServerCount: "integer",
    emptyMcpToolCount: "integer",
    ambientMcpCanarySpawned: "boolean",
    ambientHookCanaryExecuted: "boolean",
    rejectMarkerCreated: "boolean",
    permissionBitsExact: "boolean",
    runStateHandoffRecorded: "boolean",
    sentinelLeakAbsent: "boolean",
  },
  m3c3b_live_handoff: {
    allowedToolCount: "integer",
    deniedToolCount: "integer",
    snapshotToolCount: "integer",
    traceRecordCount: "integer",
    distinctSessionCount: "integer",
    mcpToolRequestedCount: "integer",
    mcpToolSucceededCount: "integer",
    unplannedMcpToolRequestedCount: "integer",
    forbiddenToolObservedCount: "integer",
    sessionEndCount: "integer",
    leftoverProcessCount: "integer",
    hashChainMatched: "boolean",
    serviceRepoUnchanged: "boolean",
    ambientMcpCanarySpawned: "boolean",
    ambientHookCanaryExecuted: "boolean",
    permissionBitsExact: "boolean",
    runStateHandoffRecorded: "boolean",
    sentinelLeakAbsent: "boolean",
  },
};

export type LiveEvidenceContract = keyof typeof CONTRACT_SPECS & string;

export const LIVE_EVIDENCE_CONTRACTS: string[] = Object.keys(CONTRACT_SPECS).sort();

/** 허용 top-level key (정확 일치). */
export const TOP_LEVEL_KEYS = ["contract", "metrics", "status", "timestamp", "version"];

/**
 * 금지 필드 이름 조각(소문자 부분 문자열). unknown key 거부와 별개로 **먼저** 검사해
 * "금지 필드"임을 분명히 거부한다(redaction 마커 치환으로 통과 불가).
 */
export const FORBIDDEN_KEY_FRAGMENTS = [
  "transcript", "argv", "command", "cmd", "path", "cwd", "hostname", "host", "username", "user",
  "pid", "sessionid", "callid", "requestid", "runid", "uuid", "env", "secret", "token",
  "apikey", "api_key", "password", "credential", "auth", "config", "raw", "stdout", "stderr",
  "message", "error", "reason", "prompt", "input", "output", "payload", "body", "content",
  "text", "url", "uri",
];

/**
 * UTC ISO-8601 (Z 고정, 밀리초 3자리 선택). 시/분/초·월·일 범위를 정규식 자체에서 제한한다.
 * 연도는 2000..2099로 한정한다 — 이 범위에서 윤년 규칙이 정확히 `year % 4 === 0`이므로
 * JSON Schema pattern(정규식만 쓸 수 있음)과 런타임 validator가 **같은 판정**을 낼 수 있다.
 */
export const TIMESTAMP_RE = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{3})?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * timestamp 판정. 형식(TIMESTAMP_RE) + 달력 실재성(2월 30일·4월 31일·비윤년 2월 29일 거부) +
 * 엔진 파싱과 산술 재구성의 일치까지 본다. schema의 pattern/not/anyOf 조합과 동일한 결정을 내며,
 * 테스트(`liveEvidence.test.ts`)가 두 판정의 동치를 표로 강제한다.
 */
export function isValidEvidenceTimestamp(ts: unknown): boolean {
  if (typeof ts !== "string") return false;
  const m = TIMESTAMP_RE.exec(ts);
  if (!m) return false;
  const year = Number(ts.slice(0, 4));
  const month = Number(m[1]);
  const day = Number(m[2]);
  const leap = year % 4 === 0; // 2000..2099 한정에서 100/400 예외가 없어 정확하다
  const maxDay = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  if (day > maxDay) return false;
  const hour = Number(ts.slice(11, 13));
  const minute = Number(ts.slice(14, 16));
  const second = Number(ts.slice(17, 19));
  const ms = m[4] ? Number(m[4].slice(1)) : 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return Number.isFinite(utc) && Date.parse(ts) === utc;
}

/** 파일명 nonce 형식(경로 조작 차단). */
const NONCE_RE = /^[0-9a-f]{6,32}$/;

/** evidence payload에 나타나면 안 되는 문자(경로/할당/변수 참조 형태 차단). */
const UNEXPECTED_CHAR_RE = /[/\\$=]/;

/** credential 형태 보조 검사(다른 runner와 동일 패턴). */
const CRED_SHAPE_RE = /(?:authorization|api[_-]?key|apikey|access[_-]?token|token|secret|password|credential)\s*[:=]/i;

/** typed 오류. 메시지에는 값이 아니라 key 경로·종류만 담는다. */
export class LiveEvidenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LiveEvidenceError";
    this.code = code;
  }
}

export interface LiveEvidence {
  version: string;
  contract: string;
  status: string;
  timestamp: string;
  metrics: Record<string, number | boolean>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 금지 key 조각을 포함하면 그 조각을 반환. */
function forbiddenFragment(key: string): string | null {
  const lower = key.toLowerCase();
  for (const frag of FORBIDDEN_KEY_FRAGMENTS) if (lower.includes(frag)) return frag;
  return null;
}

/** 모든 중첩 레벨의 key를 스캔해 금지 이름을 거부한다(값은 메시지에 담지 않음). */
function scanForbiddenKeys(value: unknown, path: string, depth: number, errors: string[]): void {
  if (depth > MAX_SCAN_DEPTH) {
    errors.push(`${path}: 중첩 깊이 상한(${MAX_SCAN_DEPTH}) 초과`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbiddenKeys(v, `${path}[${i}]`, depth + 1, errors));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    const frag = forbiddenFragment(key);
    if (frag) errors.push(`${path}.${key}: 금지 필드 이름(조각 '${frag}')`);
    scanForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, errors);
  }
}

/**
 * closed 수동 validator. JSON Schema(schemas/live_evidence.schema.json)와 동일한 판정을 한다.
 * 위반 목록을 반환하며 빈 배열이면 유효하다. 오류 문자열에 값은 담지 않는다.
 */
export function validateLiveEvidence(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) return ["evidence: plain object 여야 함"];

  // 1) 금지 필드 이름 우선 거부 (중첩 포함).
  scanForbiddenKeys(value, "evidence", 0, errors);

  // 2) top-level key 정확 일치 (unknown/누락 모두 거부).
  const keys = Object.getOwnPropertyNames(value).sort();
  const unknown = keys.filter((k) => !TOP_LEVEL_KEYS.includes(k));
  const missing = TOP_LEVEL_KEYS.filter((k) => !keys.includes(k));
  for (const k of unknown) errors.push(`evidence.${k}: unknown field`);
  for (const k of missing) errors.push(`evidence.${k}: 필수 필드 누락`);

  // 3) 고정 필드.
  if (value.version !== LIVE_EVIDENCE_VERSION) errors.push(`evidence.version: '${LIVE_EVIDENCE_VERSION}' 여야 함`);
  if (value.status !== LIVE_EVIDENCE_STATUS) errors.push(`evidence.status: '${LIVE_EVIDENCE_STATUS}' 여야 함(성공 전용)`);
  const contract = value.contract;
  if (typeof contract !== "string" || !Object.hasOwn(CONTRACT_SPECS, contract)) {
    errors.push(`evidence.contract: 알려진 runner 계약이 아님`);
  }
  if (!isValidEvidenceTimestamp(value.timestamp)) {
    errors.push("evidence.timestamp: UTC ISO-8601(Z, 2000..2099, 실재 날짜) 형식이어야 함");
  }

  // 4) metrics — 계약별 정확 key 집합 + 값 타입/범위.
  const metrics = value.metrics;
  if (!isPlainObject(metrics)) {
    errors.push("evidence.metrics: plain object 여야 함");
    return errors;
  }
  if (typeof contract !== "string" || !Object.hasOwn(CONTRACT_SPECS, contract)) return errors;
  const spec = CONTRACT_SPECS[contract];
  const mKeys = Object.getOwnPropertyNames(metrics).sort();
  const specKeys = Object.keys(spec).sort();
  for (const k of mKeys) if (!specKeys.includes(k)) errors.push(`evidence.metrics.${k}: unknown metric`);
  for (const k of specKeys) if (!mKeys.includes(k)) errors.push(`evidence.metrics.${k}: 필수 metric 누락`);
  for (const k of specKeys) {
    if (!mKeys.includes(k)) continue;
    const v = metrics[k];
    if (spec[k] === "boolean") {
      if (typeof v !== "boolean") errors.push(`evidence.metrics.${k}: boolean 이어야 함`);
    } else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > MAX_METRIC_INT) {
      errors.push(`evidence.metrics.${k}: 0..${MAX_METRIC_INT} 범위 정수여야 함`);
    }
  }
  return errors;
}

export interface BuildLiveEvidenceOpts {
  contract: string;
  metrics: Record<string, number | boolean>;
  timestamp: string;
}

/**
 * 계약을 검증한 evidence 객체를 만든다(성공 전용, status="pass" 고정).
 * 위반 시 LiveEvidenceError로 fail-closed — runner는 이 실패를 실패로 처리해야 한다.
 */
export function buildLiveEvidence(opts: BuildLiveEvidenceOpts): LiveEvidence {
  const candidate: LiveEvidence = {
    version: LIVE_EVIDENCE_VERSION,
    contract: opts.contract,
    status: LIVE_EVIDENCE_STATUS,
    timestamp: opts.timestamp,
    metrics: opts.metrics,
  };
  const errors = validateLiveEvidence(candidate);
  if (errors.length > 0) {
    throw new LiveEvidenceError("invalid_evidence", `live evidence 계약 위반: ${errors.join(" | ")}`);
  }
  return candidate;
}

/** 계약 검증을 통과한 evidence를 결정론적(key 정렬) JSON 문자열로 만든다. */
export function serializeLiveEvidence(evidence: LiveEvidence): string {
  const metrics: Record<string, number | boolean> = {};
  for (const k of Object.keys(evidence.metrics).sort()) metrics[k] = evidence.metrics[k];
  const ordered = {
    version: evidence.version,
    contract: evidence.contract,
    status: evidence.status,
    timestamp: evidence.timestamp,
    metrics,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

/**
 * 영속화 직전 backstop: 직렬화 텍스트에 비밀·자격증명 형태·예상 외 문자가 있으면 종류를 반환한다.
 * **가리기(redaction)로 통과시키지 않는다** — 호출자는 반환값이 있으면 쓰기를 거부해야 한다.
 */
export function findSensitiveResidue(text: string, secretValues: string[] = []): string | null {
  for (const v of secretValues) {
    if (v && text.includes(v)) return "secret_value";
  }
  if (redactSecrets(text, secretValues) !== text) return "redactable_residue";
  if (CRED_SHAPE_RE.test(text)) return "credential_shape";
  if (UNEXPECTED_CHAR_RE.test(text)) return "unexpected_character";
  return null;
}

/**
 * evidence 디렉터리 위치(기본 `<repoRoot>/docs/evidence/m3d2`).
 *
 * override는 **명시 인자(`overrideDir`)로만** 받는다 — 환경변수를 읽지 않는다(Codex Sol xhigh P2-6).
 * env는 자손 프로세스에 암묵 상속되므로, 셸에 export된 값이 production live runner의 evidence 기록 위치를
 * 조용히 바꿀 수 있었다. 이제 live runner는 `--fixture-config`(argv, 상속되지 않음)로만 위치를 바꾼다.
 */
export function resolveEvidenceDir(opts: { repoRoot: string; overrideDir?: string }): string {
  const override = opts.overrideDir;
  if (typeof override === "string" && override.trim().length > 0) {
    if (!isAbsolute(override)) throw new LiveEvidenceError("evidence_dir_relative", "evidence 디렉터리 override는 절대경로여야 함");
    return resolve(override);
  }
  return resolve(join(opts.repoRoot, "docs", "evidence", "m3d2"));
}

/**
 * 상위 경로 symlink 검사 단계 수. evidence 디렉터리(docs/evidence/m3d2)와 그 근처 상위만 본다.
 * 파일시스템 최상위 prefix(예: macOS의 /var → /private/var)는 통제 밖이라 검사 대상이 아니다.
 */
const MAX_ANCESTOR_SYMLINK_CHECKS = 4;

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LiveEvidenceError("evidence_dir_stat", "evidence 경로 확인 실패");
  }
}

/** dev+ino 신원. 경로가 아니라 실제 객체를 가리키는지 확인하는 데 쓴다. */
interface FsIdentity {
  dev: number;
  ino: number;
}

/** 0700 디렉터리를 보장하고 그 신원(dev+ino)을 함께 돌려준다. symlink·비디렉터리 대상은 거부(fail-closed). */
function ensureEvidenceDir(dir: string): { path: string; identity: FsIdentity } {
  const target = resolve(dir);

  // 1) target 자체: 존재하면 symlink 금지 + 디렉터리 필수.
  const st = lstatOrNull(target);
  if (st) {
    if (st.isSymbolicLink()) throw new LiveEvidenceError("evidence_dir_symlink", "evidence 디렉터리가 symlink — 거부");
    if (!st.isDirectory()) throw new LiveEvidenceError("evidence_dir_not_directory", "evidence 디렉터리 위치가 디렉터리가 아님 — 거부");
  }

  // 2) 상위 경로 bounded symlink 검사 (미존재 단계는 건너뛴다). symlink 경유 생성·기록 차단.
  let cur = dirname(target);
  for (let i = 0; i < MAX_ANCESTOR_SYMLINK_CHECKS; i++) {
    const ancestor = lstatOrNull(cur);
    if (ancestor?.isSymbolicLink()) throw new LiveEvidenceError("evidence_dir_symlink", "evidence 상위 경로에 symlink — 거부");
    if (ancestor && !ancestor.isDirectory()) throw new LiveEvidenceError("evidence_dir_not_directory", "evidence 상위 경로가 디렉터리가 아님 — 거부");
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  // 3) 생성 + 0700 강제(umask 무관) + 사후 재확인.
  if (!st) mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  if ((statSync(target).mode & 0o777) !== 0o700) throw new LiveEvidenceError("evidence_dir_mode", "evidence 디렉터리 권한이 0700 아님");
  const post = lstatOrNull(target);
  if (!post || post.isSymbolicLink() || !post.isDirectory()) {
    throw new LiveEvidenceError("evidence_dir_not_directory", "evidence 디렉터리 사후 확인 실패 — 거부");
  }
  return { path: target, identity: { dev: post.dev, ino: post.ino } };
}

/**
 * publish 직전 디렉터리 신원 재확인. 준비 시점과 다른 객체(교체된 디렉터리/symlink)라면 거부한다.
 * 경로 기반 API의 TOCTOU를 완전히 없애지는 못하지만 창을 좁히고 교체를 탐지한다.
 */
function assertDirIdentity(dir: string, identity: FsIdentity): void {
  const st = lstatOrNull(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory() || st.dev !== identity.dev || st.ino !== identity.ino) {
    throw new LiveEvidenceError("evidence_dir_replaced", "evidence 디렉터리 신원이 준비 시점과 다름 — 기록 거부");
  }
}

/** 신원(dev+ino)이 일치할 때만 unlink한다. 실패·불일치는 조용히 넘기지 않고 problems에 남긴다. */
function unlinkIfSameObject(
  path: string,
  identity: FsIdentity,
  label: string,
  problems: string[],
  inject?: (p: string) => void,
): void {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // 이미 없음 — 정리 목표 달성
    problems.push(`${label}_stat_${code ?? "unknown"}`);
    return;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.dev !== identity.dev || st.ino !== identity.ino) {
    problems.push(`${label}_identity_mismatch`); // 교체된 파일은 지우지 않는다
    return;
  }
  try {
    if (inject) inject(path);
    else unlinkSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") problems.push(`${label}_unlink_${code ?? "unknown"}`);
  }
}

/** 디렉터리 fsync(지원되는 플랫폼에서만). 파일 본문은 이미 fsync됐으므로 미지원은 무해하다. */
function fsyncDirBestEffort(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* 디렉터리 fsync 미지원 플랫폼 — durability 보강만 생략한다 */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 무해 */
      }
    }
  }
}

export interface WriteLiveEvidenceOpts {
  evidence: unknown;
  /** evidence 디렉터리(절대경로 권장). 없으면 0700으로 생성한다. */
  dir: string;
  /** backstop용 secret 환경변수 **이름**만. 값은 env에서 조회한다. */
  secretRefs?: string[];
  env?: NodeJS.ProcessEnv;
  /** [TEST-ONLY] 파일명 nonce 고정(충돌 테스트용). ^[0-9a-f]{6,32}$ */
  nonce?: string;
  /** [TEST-ONLY] 실패 주입 seam. throw하면 각 단계의 정리·publish 경로를 검증할 수 있다. */
  testHooks?: {
    /** 임시 파일 open 직후 (쓰기 전) */
    afterOpen?: () => void;
    /** 임시 파일 완성·재검증 후, publish(link) 직전 */
    beforePublish?: () => void;
    /** publish(link) 직후, 임시 파일 정리 전 */
    afterPublish?: () => void;
    /** 임시 파일 정리 주입(정리 실패가 보고되는지 검증). 호출되면 실제 unlink는 하지 않는다. */
    unlinkTemp?: (p: string) => void;
  };
}

/** 최종 파일명과 같은 디렉터리의 **숨김** 임시 파일명. 최종 성공 산출물 이름과 절대 겹치지 않는다. */
function tempNameFor(finalName: string): string {
  return `.${finalName}.tmp`;
}

/**
 * 검증·backstop을 통과한 evidence만 임시 파일에 완성한 뒤 원자적으로 1건 publish하고 최종 경로를 반환한다.
 * 경로는 payload에 담지 않으며 호출자도 콘솔에 출력하지 않는다.
 */
export function writeLiveEvidence(opts: WriteLiveEvidenceOpts): string {
  const errors = validateLiveEvidence(opts.evidence);
  if (errors.length > 0) {
    throw new LiveEvidenceError("invalid_evidence", `live evidence 계약 위반: ${errors.join(" | ")}`);
  }
  const evidence = opts.evidence as LiveEvidence;
  const text = serializeLiveEvidence(evidence);
  if (Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new LiveEvidenceError("evidence_too_large", `evidence 크기 상한(${MAX_EVIDENCE_BYTES}B) 초과`);
  }
  const secretValues = collectSecretValues(opts.secretRefs ?? [], opts.env ?? process.env);
  const residue = findSensitiveResidue(text, secretValues);
  if (residue) {
    throw new LiveEvidenceError("sensitive_residue", `evidence에 민감 잔재 감지(${residue}) — 기록 거부(가리고 저장하지 않음)`);
  }

  const nonce = opts.nonce ?? randomBytes(12).toString("hex");
  if (!NONCE_RE.test(nonce)) throw new LiveEvidenceError("invalid_nonce", "nonce 형식 위반");
  const compactTs = evidence.timestamp.replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  const fileName = `${evidence.contract}-${compactTs}-${nonce}.json`;

  const { path: dir, identity: dirIdentity } = ensureEvidenceDir(opts.dir);
  const filePath = join(dir, fileName);
  const tempPath = join(dir, tempNameFor(fileName));
  const buf = Buffer.from(text, "utf8");

  // ── 1) 숨김 임시 파일 exclusive create ──────────────────────────────────────
  let fd: number;
  try {
    fd = openSync(tempPath, "wx", 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new LiveEvidenceError("evidence_temp_exists", "임시 evidence 파일이 이미 존재 — 덮어쓰지 않음");
    }
    throw new LiveEvidenceError("evidence_open", "evidence 임시 파일 생성 실패");
  }

  let tempIdentity: FsIdentity;
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink !== 1) {
      throw new LiveEvidenceError("evidence_not_regular_file", "evidence 임시 대상이 단일 링크 일반 파일이 아님");
    }
    tempIdentity = { dev: fst.dev, ino: fst.ino };
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      /* 무해 */
    }
    try {
      unlinkSync(tempPath);
    } catch {
      /* 신원 확인 전 단계 — 방금 우리가 exclusive create한 경로다 */
    }
    throw e;
  }

  const cleanupProblems: string[] = [];
  const cleanupTemp = (): void =>
    unlinkIfSameObject(tempPath, tempIdentity, "temp", cleanupProblems, opts.testHooks?.unlinkTemp);

  let published = false;
  try {
    // ── 2) 전부 쓰고 권한·fsync·close까지 완료 ────────────────────────────────
    let closeFailed: NodeJS.ErrnoException | null = null;
    try {
      opts.testHooks?.afterOpen?.();
      fchmodSync(fd, 0o600); // umask 무관하게 0600 강제
      let written = 0;
      while (written < buf.length) written += writeSync(fd, buf, written, buf.length - written);
      fsyncSync(fd);
      const post = fstatSync(fd); // 경로가 아니라 fd 기준 사후 확인
      if (post.size !== buf.length) throw new LiveEvidenceError("evidence_size_mismatch", "evidence 임시 파일 크기 불일치");
      if ((post.mode & 0o777) !== 0o600) throw new LiveEvidenceError("evidence_mode", "evidence 임시 파일 권한이 0600 아님");
    } finally {
      try {
        closeSync(fd);
      } catch (e) {
        closeFailed = e as NodeJS.ErrnoException;
      }
    }
    if (closeFailed) throw new LiveEvidenceError("evidence_close", "evidence 임시 파일 close 실패");

    // ── 3) 완성된 임시 파일 재검증(신원 + byte 동일 + 계약) ──────────────────
    let vfd: number;
    try {
      vfd = openSync(tempPath, "r");
    } catch {
      throw new LiveEvidenceError("evidence_verify_open", "evidence 임시 파일 재확인 실패");
    }
    try {
      const vst = fstatSync(vfd);
      if (vst.dev !== tempIdentity.dev || vst.ino !== tempIdentity.ino || !vst.isFile()) {
        throw new LiveEvidenceError("evidence_temp_replaced", "evidence 임시 파일이 교체됨 — 기록 거부");
      }
      if (vst.size !== buf.length) throw new LiveEvidenceError("evidence_size_mismatch", "evidence 임시 파일 크기 불일치");
      const back = Buffer.alloc(buf.length);
      let read = 0;
      while (read < back.length) {
        const n = readSync(vfd, back, read, back.length - read, read);
        if (n <= 0) break;
        read += n;
      }
      if (read !== buf.length || !back.equals(buf)) {
        throw new LiveEvidenceError("evidence_verify_mismatch", "evidence 임시 파일 내용이 기록 대상과 다름");
      }
      const reparsedErrors = validateLiveEvidence(JSON.parse(back.toString("utf8")));
      if (reparsedErrors.length > 0) {
        throw new LiveEvidenceError("evidence_verify_invalid", `기록 직전 재검증 실패: ${reparsedErrors.join(" | ")}`);
      }
    } finally {
      try {
        closeSync(vfd);
      } catch {
        /* 무해 */
      }
    }

    // ── 4) 원자적 publish (덮어쓰기 없음) ────────────────────────────────────
    assertDirIdentity(dir, dirIdentity); // publish 직전 재확인
    opts.testHooks?.beforePublish?.();
    try {
      linkSync(tempPath, filePath); // exclusive: 최종 이름이 이미 있으면 EEXIST
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new LiveEvidenceError("evidence_exists", "동일 evidence 파일명이 이미 존재 — 덮어쓰지 않음");
      throw new LiveEvidenceError("evidence_publish", `evidence publish 실패 [${code ?? "unknown"}]`);
    }
    published = true;
    opts.testHooks?.afterPublish?.();

    // publish 결과가 우리 inode인지 확인(hard link이므로 dev+ino가 임시 파일과 같아야 한다).
    const fin = lstatSync(filePath);
    if (fin.isSymbolicLink() || !fin.isFile() || fin.dev !== tempIdentity.dev || fin.ino !== tempIdentity.ino) {
      // 우리 것이 아니면 지우지 않는다 — 임시 파일만 정리하고 실패로 보고한다.
      throw new LiveEvidenceError("evidence_publish_identity", "publish된 evidence 파일 신원이 다름 — 기록 거부");
    }
    if ((fin.mode & 0o777) !== 0o600) throw new LiveEvidenceError("evidence_mode", "evidence 파일 권한이 0600 아님");
  } catch (e) {
    // 실패 경로: 최종 파일이 우리 것으로 발행된 경우에만 함께 되돌린다(성공 산출물 잔재 금지).
    if (published) unlinkIfSameObject(filePath, tempIdentity, "final", cleanupProblems);
    cleanupTemp();
    if (cleanupProblems.length > 0) {
      const base = e instanceof LiveEvidenceError ? `${e.code}: ${e.message}` : "evidence 기록 실패";
      throw new LiveEvidenceError("evidence_cleanup", `${base} | 정리 실패(${cleanupProblems.join(",")})`);
    }
    throw e;
  }

  // ── 5) 임시 파일 정리(신원 확인 후) + 디렉터리 durability ─────────────────
  cleanupTemp();
  if (cleanupProblems.length > 0) {
    // 정리 실패는 무시하지 않는다. 완결되지 않은 기록이므로 발행분도 되돌리고 실패로 보고한다.
    unlinkIfSameObject(filePath, tempIdentity, "final", cleanupProblems);
    throw new LiveEvidenceError("evidence_cleanup", `evidence 임시 파일 정리 실패(${cleanupProblems.join(",")})`);
  }
  fsyncDirBestEffort(dir);
  return filePath;
}
