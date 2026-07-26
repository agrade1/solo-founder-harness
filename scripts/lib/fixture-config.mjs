/**
 * [V3 M3d.2] 테스트 fixture 설정 로더 — **argv 전용** 주입 경로.
 *
 * 왜 env가 아니라 argv인가 (Codex Sol xhigh P2-6):
 *   환경변수는 자손 프로세스에 **암묵적으로 상속**된다. lock 경로·`ps` fixture·주입 seam을 env로 받으면
 *   ① 개발자 셸에 export 한 값이 production 실행(`npm test`, live runner)의 동작을 조용히 바꾸고,
 *   ② 상위 suite가 잡은 lock과 자손이 서로 **다른 lock 파일**을 보게 되어 배타성이 깨질 수 있다.
 *   argv는 상속되지 않고 실행 1회에만 적용되므로 production 경로가 테스트 override를 "해석"할 여지가 없다.
 *
 * 계약:
 *   - 주입은 `--fixture-config <절대경로 .json>` 하나뿐이다. 이 flag가 없으면 **모든 seam은 꺼진 상태**이며,
 *     테스트 전용 모드(probe/hold/child, stress suite fixture 등)는 아예 거부된다.
 *   - 설정 파일은 bounded(8KiB) plain JSON 객체이고, 소비자가 선언한 **allowlist key만** 허용한다.
 *     unknown key·타입 위반·범위 위반·상대경로는 전부 거부(fail closed)한다.
 *   - 이 모듈은 `process.env`를 읽지 않으며 임의 명령 실행 경로를 만들지 않는다.
 *
 * 검사–사용 경합 제거 (Codex Sol xhigh P1-3):
 *   예전 구현은 `lstatSync(path)`로 검사한 뒤 `readFileSync(path)`로 **경로를 다시 해석**했다.
 *   그 사이에 경로가 symlink·거대 파일로 교체되면 검사(일반 파일·8KiB)와 실제로 읽은 바이트가
 *   서로 다른 대상이 된다. 이제 경로는 **정확히 한 번** 열고(`O_NOFOLLOW`), 검사는 그 **열린 fd의
 *   `fstat`** 으로 하고, 내용도 **같은 fd**에서 최대 `MAX_FIXTURE_BYTES + 1` 바이트만 읽는다.
 *   즉 "검사한 inode == 읽은 inode"가 syscall 수준에서 보장되고, 교체된 경로는 다시 열지 않는다.
 *
 * fd close 실패 처리 (Codex Sol xhigh P2-5, 다섯 번째 리비전):
 *   `closeSync` 실패를 무시하고 설정을 돌려주지 않는다 — `fixture_close_failed`로 거부한다.
 *   이 경로를 결정론적으로 검증하려면 close를 실패시킬 수 있어야 하므로, 주입은 `loadFixtureConfig`의
 *   **세 번째 인자(in-process io seam)** 로만 열어 둔다. production 진입점은 인자 2개로만 호출하므로
 *   argv·env·설정 파일 내용으로는 도달할 수 없고, "외부 주입은 argv 하나뿐"이라는 계약은 그대로다.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

export const FIXTURE_FLAG = "--fixture-config";
/** 설정 파일 크기 상한 — 주입 표면을 작게 유지한다. */
export const MAX_FIXTURE_BYTES = 8192;

export class FixtureConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FixtureConfigError";
    this.code = code;
  }
}

/**
 * 파일 I/O 기본 구현. `loadFixtureConfig(argv, spec)`는 **항상 이것만** 쓴다.
 *
 * 다섯 번째 리비전(Codex Sol xhigh P2-5): fd `closeSync` 실패를 무시하지 않으려면 그 경로를
 * 결정론적으로 검증할 수 있어야 한다. 그래서 주입은 **함수의 세 번째 인자**(같은 프로세스에서 이 모듈을
 * import한 코드만 줄 수 있는 값)로만 열어 둔다:
 *   - production 진입점(`scripts/suite-lock.mjs`, `scripts/m3d2-stress-acceptance.mjs`)은 인자 2개로만
 *     호출하므로 **argv·env·설정 파일 내용으로는 도달할 수 없다**. 즉 "외부 주입은 argv 하나뿐"이라는
 *     활성 문서의 계약은 그대로다 — 이 seam은 외부 입력이 아니라 in-process 함수 인자다.
 *   - 표면은 fs 함수 4개로 최소이며, 명령 실행·경로 재해석·env 참조를 만들지 않는다.
 *   - 값이 함수가 아니면 즉시 거부한다(부분 주입은 기본 구현으로 채운다).
 */
const DEFAULT_IO = Object.freeze({ openSync, fstatSync, readSync, closeSync });

function resolveIo(io) {
  if (io === undefined || io === null) return DEFAULT_IO;
  if (typeof io !== "object" || Array.isArray(io)) throw new FixtureConfigError("fixture_io_invalid", "io seam은 객체여야 합니다.");
  const merged = { ...DEFAULT_IO, ...io };
  for (const key of Object.keys(merged)) {
    if (!Object.hasOwn(DEFAULT_IO, key)) throw new FixtureConfigError("fixture_io_invalid", `io seam에 허용되지 않은 key: ${key}`);
    if (typeof merged[key] !== "function") throw new FixtureConfigError("fixture_io_invalid", `io seam의 ${key}는 함수여야 합니다.`);
  }
  return merged;
}

/** argv에서 fixture flag를 떼어낸다. flag가 없으면 path=null. */
export function extractFixtureFlag(argv) {
  const rest = [];
  let path = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== FIXTURE_FLAG) {
      rest.push(argv[i]);
      continue;
    }
    if (path !== null) throw new FixtureConfigError("fixture_flag_repeated", `${FIXTURE_FLAG}는 한 번만 지정합니다.`);
    const value = argv[i + 1];
    if (typeof value !== "string" || value.length === 0) {
      throw new FixtureConfigError("fixture_path_missing", `${FIXTURE_FLAG} <절대경로 .json> 인자가 필요합니다.`);
    }
    path = value;
    i += 1;
  }
  return { path, rest };
}

/**
 * 열린 fd에서 최대 `limit + 1` 바이트만 읽는다. `limit + 1`을 다 채웠다면 상한 초과다.
 * 상한 판정은 **실제로 읽은 바이트 수**로 한다(경로를 다시 stat하지 않는다).
 */
function readBounded(fd, limit, io) {
  const buf = Buffer.alloc(limit + 1);
  let total = 0;
  while (total < buf.length) {
    let n;
    try {
      n = io.readSync(fd, buf, total, buf.length - total, null);
    } catch (e) {
      throw new FixtureConfigError("fixture_unreadable", `fixture 설정 파일을 읽을 수 없습니다 [${e?.code ?? "unknown"}].`);
    }
    if (n === 0) break; // EOF
    total += n;
  }
  if (total > limit) throw new FixtureConfigError("fixture_too_large", `fixture 설정 크기 상한(${limit}B) 초과.`);
  return buf.subarray(0, total).toString("utf8");
}

function readConfigFile(path, io) {
  if (!isAbsolute(path)) throw new FixtureConfigError("fixture_path_relative", `${FIXTURE_FLAG}는 절대경로여야 합니다.`);
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    // O_NOFOLLOW가 없으면 최종 symlink를 열기 전에 막을 수 없다 → 주입 자체를 거부한다(fail closed).
    throw new FixtureConfigError("fixture_nofollow_unsupported", "이 플랫폼은 O_NOFOLLOW를 지원하지 않아 fixture 주입을 거부합니다.");
  }
  let fd;
  try {
    fd = io.openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (e) {
    const code = e?.code;
    // 최종 경로가 symlink면 Linux는 ELOOP, macOS(BSD)는 EMLINK를 준다. 둘 다 "일반 파일 아님"이다.
    if (code === "ELOOP" || code === "EMLINK") {
      throw new FixtureConfigError("fixture_not_file", "fixture 설정 경로가 symlink입니다 — 일반 파일만 허용합니다.");
    }
    throw new FixtureConfigError("fixture_unreadable", `fixture 설정 파일을 열 수 없습니다 [${code ?? "unknown"}].`);
  }
  let raw;
  let closeError = null;
  try {
    // 검사도 내용도 **이 fd 하나**에서 한다. 경로가 그 사이 교체돼도 우리가 읽는 대상은 바뀌지 않는다.
    let st;
    try {
      st = io.fstatSync(fd);
    } catch (e) {
      throw new FixtureConfigError("fixture_unreadable", `fixture 설정 파일을 확인할 수 없습니다 [${e?.code ?? "unknown"}].`);
    }
    if (!st.isFile()) throw new FixtureConfigError("fixture_not_file", "fixture 설정은 일반 파일이어야 합니다.");
    raw = readBounded(fd, MAX_FIXTURE_BYTES, io);
  } finally {
    // close 실패를 무시하지 않는다(다섯 번째 리비전 P2-5): 읽기 전용 fd라도 close가 실패했다면
    // 그 fd 상태에 대한 우리 가정이 깨진 것이므로 설정을 신뢰하지 않고 **명시적 fixture 오류**로 올린다.
    // 단, 이미 다른 오류가 진행 중이면 그 원인을 덮지 않는다(아래 throw는 정상 읽기 뒤에만 도달한다).
    try {
      io.closeSync(fd);
    } catch (e) {
      closeError = e;
    }
  }
  if (closeError) {
    throw new FixtureConfigError(
      "fixture_close_failed",
      `fixture 설정 파일 fd close 실패 [${closeError?.code ?? "unknown"}] — 설정을 신뢰하지 않고 거부합니다(fail closed).`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FixtureConfigError("fixture_invalid_json", "fixture 설정이 JSON이 아닙니다.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FixtureConfigError("fixture_not_object", "fixture 설정은 JSON 객체여야 합니다.");
  }
  return parsed;
}

/**
 * spec 기반 좁은 검증. spec 예:
 *   { lockPath: { kind: "absPath" }, workers: { kind: "int", lo: 1, hi: 8 },
 *     suiteMode: { kind: "enum", values: [...] }, token: { kind: "hex", lo: 32, hi: 64 } }
 */
export function validateFixtureConfig(config, spec) {
  const out = {};
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(spec, key)) throw new FixtureConfigError("fixture_unknown_key", `fixture 설정에 허용되지 않은 key: ${key}`);
  }
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.hasOwn(config, key)) continue;
    const value = config[key];
    if (rule.kind === "absPath") {
      if (typeof value !== "string" || !isAbsolute(value)) {
        throw new FixtureConfigError("fixture_value_invalid", `fixture 설정 ${key}는 절대경로 문자열이어야 합니다.`);
      }
      out[key] = value;
    } else if (rule.kind === "int") {
      if (!Number.isSafeInteger(value) || value < rule.lo || value > rule.hi) {
        throw new FixtureConfigError("fixture_value_invalid", `fixture 설정 ${key}는 ${rule.lo}..${rule.hi} 정수여야 합니다.`);
      }
      out[key] = value;
    } else if (rule.kind === "enum") {
      if (typeof value !== "string" || !rule.values.includes(value)) {
        throw new FixtureConfigError("fixture_value_invalid", `fixture 설정 ${key} 값이 허용 목록에 없습니다.`);
      }
      out[key] = value;
    } else if (rule.kind === "hex") {
      if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${rule.lo},${rule.hi}}$`).test(value)) {
        throw new FixtureConfigError("fixture_value_invalid", `fixture 설정 ${key}는 소문자 hex(${rule.lo}..${rule.hi}자)여야 합니다.`);
      }
      out[key] = value;
    } else if (rule.kind === "bool") {
      if (typeof value !== "boolean") throw new FixtureConfigError("fixture_value_invalid", `fixture 설정 ${key}는 boolean이어야 합니다.`);
      out[key] = value;
    } else {
      throw new FixtureConfigError("fixture_spec_invalid", `알 수 없는 fixture spec kind: ${String(rule.kind)}`);
    }
  }
  return out;
}

/**
 * argv에서 fixture 설정을 읽어 검증한다.
 * 반환 { config, rest } — flag가 없으면 config는 null(= 모든 seam 비활성, production 경로).
 *
 * `io`는 **테스트 전용 in-process seam**이며 production 호출부는 인자 2개로만 호출한다(위 DEFAULT_IO 주석).
 */
export function loadFixtureConfig(argv, spec, io) {
  const resolved = resolveIo(io);
  const { path, rest } = extractFixtureFlag(argv);
  if (path === null) return { config: null, rest };
  return { config: validateFixtureConfig(readConfigFile(path, resolved), spec), rest, path };
}
