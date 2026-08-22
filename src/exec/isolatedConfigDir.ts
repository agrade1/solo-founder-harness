/**
 * **격리 설정 디렉터리 계약 — provider 공용 골격**(V3 M11 · 대장 `C-86`).
 *
 * codex는 `executionAuthority.codexHome`으로, claude는 `executionAuthority.claudeHome`으로 각각
 * "이 worker 세션이 **어느 자격증명**으로 도는가"를 승인 문서에 못 박는다. 두 계약의 **경로·권한·
 * 소유권·신원 축은 글자 그대로 같으므로** 여기 한 번만 쓴다 — `B-7ⓐ`가 "두 번째 홈 계약을 만들지
 * 않는다"고 정한 그 규율이다. provider마다 다른 것은 **디렉터리 안에 무엇이 허용되는가**뿐이고
 * 그것은 각 provider 모듈이 이 골격 위에 얹는다.
 *
 * 오류 코드를 인자로 받는 이유: 두 계약의 안정 코드는 이미 각자의 이름(`codex_home_*` ·
 * `claude_config_*`)으로 테스트·문서에 고정돼 있다. 골격을 공유하려고 코드를 통일하면 **관측 가능한
 * 계약이 바뀐다**. `verifyApprovedExecutable`가 이미 쓰는 것과 같은 형태다(코드 map 주입).
 *
 * ## 이 골격이 막는 것 / 막지 못하는 것
 *
 * 막는 것: **경로 교체**(승인된 경로가 아니면 거부 · symlink 금지 · realpath 동등) · **권한 완화**
 * (0700이 아니면 거부) · **다른 uid가 만든 디렉터리를 승인 자리에 갖다 놓기** · **ambient 디렉터리
 * 재사용**(사용자 홈 자신과 `~/<ambientDirName>`) · **검증 이후의 신원 교체**(dev+ino 대조).
 *
 * 막지 못하는 것: **같은 uid로 동작하는 공격자**. 소유자 자신은 언제든 자기 디렉터리를 쓸 수 있다.
 * 그리고 lstat과 실제 사용 사이의 TOCTOU 창을 0으로 만들지 않는다(`C-5`와 같은 한계 — Node 18에
 * 디렉터리 상대 열기가 없다). 창을 **좁히는** 것은 호출자 몫이다: `identity`를 주고 **spawn 직전에**
 * 다시 부르면 그 사이의 교체가 `identityChanged`로 막힌다. 두 provider 모두 그렇게 한다
 * (codex는 봉인 spec의 동기 게이트에서, claude는 `startLivePlanTurn` 진입에서 — M11 적대적 리뷰 B-2
 * 이전에는 claude 갈래가 이 재확인을 하지 않아 이 문단이 거짓이었다).
 *
 * **자격증명을 읽지 않는다.** 이 모듈은 디렉터리 하나에 `lstat`·`realpath`·(호출자가 원하면)
 * `readdir`만 한다 — 내용을 열거나 해싱하면 그 순간 digest·로그가 자격증명 유출 경로가 된다.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OrchestrationError } from "./orchestrationTypes.js";

/** 디렉터리의 불투명 신원. 경로 문자열이 아니라 **inode**가 신원이다(경로는 교체될 수 있다). */
export interface IsolatedDirIdentity {
  dev: number;
  ino: number;
}

/**
 * 이 골격이 낼 수 있는 안정 코드 전부 — **호출자가 자기 이름으로 준다**. 값을 오류 문자열에 싣지
 * 않는다는 규율은 여기서도 같다(경로·uid·파일 이름은 메시지에 넣지 않는다).
 */
export interface IsolatedDirCodes {
  /** 절대경로가 아니거나 NUL이 섞였다. */
  notAbsolute: string;
  /** realpath 불가 · symlink · 디렉터리 아님 · 읽기 불가. */
  invalid: string;
  /** 승인 manifest가 고정한 디렉터리가 아니다. */
  notApproved: string;
  /** 0700이 아니다(group/other 비트가 있다). */
  permissive: string;
  /** 이 프로세스 소유가 아니다. */
  notOwned: string;
  /** 사용자 홈 자신 또는 ambient 설정 디렉터리다. */
  ambient: string;
  /** 검증 이후 디렉터리 신원(dev+ino)이 바뀌었다. */
  identityChanged: string;
}

export interface IsolatedDirExpectation {
  /** 오류 문구에 쓰는 **라벨**(경로 값이 아니다). */
  what: string;
  codes: IsolatedDirCodes;
  /** 이 디렉터리를 쓰면 안 되는 ambient 이름(`.codex` · `.claude`). 사용자 홈 아래의 그 이름을 막는다. */
  ambientDirName: string;
  /**
   * 승인 manifest가 고정한 디렉터리. 주면 ⓐ 경로가 **정확히 같아야** 하고 ⓑ **이 프로세스 소유**여야
   * 한다. 주지 않으면(= 승인이 이 축을 담지 않았다) 경로·권한 계약만 본다.
   */
  approved?: { path: string } | null;
  /** 이미 확보한 신원. 주면 **같아야** 한다(비동기 경계 작업 중 교체를 막는 spawn 직전 게이트). */
  identity?: IsolatedDirIdentity;
}

/**
 * 경로·권한·소유권·신원 축을 본다. **내용은 보지 않는다** — 무엇이 허용되는지는 provider마다 다르므로
 * 호출자가 이 함수 뒤에 얹는다.
 */
export function verifyIsolatedDir(path: unknown, expect: IsolatedDirExpectation): { path: string; id: IsolatedDirIdentity } {
  const { what, codes, ambientDirName } = expect;
  const approved = expect.approved ?? null;

  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path)) {
    fail(codes.notAbsolute, `${what}는 NUL 없는 절대경로여야 한다`);
  }
  const p = path;

  // 승인이 디렉터리를 고정했으면 **그 경로 하나뿐**이다 — 다른 디렉터리로의 fallback이 없다
  // (경로만 대조하고 값은 오류에 싣지 않는다).
  if (approved && p !== approved.path) {
    fail(codes.notApproved, `${what}가 승인 manifest가 고정한 격리 디렉터리가 아니다`);
  }

  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    fail(codes.invalid, `${what}의 realpath를 확인할 수 없다`);
  }
  if (real !== p) fail(codes.invalid, `${what}는 정규 경로여야 한다(symlink 금지)`);

  let userHome = "";
  try {
    userHome = realpathSync(homedir());
  } catch {
    userHome = "";
  }
  if (userHome && (p === userHome || p === join(userHome, ambientDirName))) {
    fail(codes.ambient, `${what}로 사용자 홈(또는 ~/${ambientDirName})을 쓸 수 없다`);
  }

  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    fail(codes.invalid, `${what}의 상태를 확인할 수 없다`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail(codes.invalid, `${what}는 symlink 아닌 디렉터리여야 한다`);
  if ((st.mode & 0o077) !== 0) fail(codes.permissive, `${what}는 0700(소유자 전용)이어야 한다`);
  // 승인된(= 자격증명이 들어 있는) 디렉터리는 **이 프로세스 소유**여야 한다. 다른 uid가 만든 디렉터리를
  // 승인 경로에 갖다 놓는 형태의 hijack을 막는다.
  if (approved) assertOwnedByThisUser(st.uid, what, codes);

  const id: IsolatedDirIdentity = { dev: st.dev, ino: st.ino };
  const owned = expect.identity;
  if (owned && (id.dev !== owned.dev || id.ino !== owned.ino)) {
    fail(codes.identityChanged, `${what}의 디렉터리 신원이 검증 이후 바뀌었다`);
  }
  return { path: p, id };
}

/** 최상위 항목 이름만 읽는다(내용을 열지 않는다). 읽을 수 없으면 `invalid`. */
export function readTopLevelNames(dir: string, what: string, codes: IsolatedDirCodes): string[] {
  try {
    return readdirSync(dir);
  } catch {
    fail(codes.invalid, `${what}를 읽을 수 없다`);
  }
}

/** 현재 프로세스 uid 소유가 아니면 거부. **uid를 노출하지 않는다**(대상 라벨만 알린다). */
export function assertOwnedByThisUser(uid: number, what: string, codes: Pick<IsolatedDirCodes, "notOwned">): void {
  const self = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (self === undefined || uid !== self) fail(codes.notOwned, `${what}은 이 프로세스 소유여야 한다`);
}

function fail(code: string, message: string): never {
  throw new OrchestrationError(code, message);
}
