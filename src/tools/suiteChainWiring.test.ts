import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * [C-104] `npm test` 체인 **배선** 회귀 — `npm run typecheck`가 사람 기억이 아니라 script에
 * 걸려 있는지, 그리고 **배타 lock을 잡기 전에** 걸려 있는지를 관측한다.
 *
 * 왜 문자열을 보나: 이 계약은 코드가 아니라 package.json script 체인이 전부다. 실제로 체인을
 * 돌려서 관측하려면 배타 lock을 잡고 전체 suite를 돌려야 하는데, 그건 이 테스트 자신이
 * 그 lock 안에서 도는 것과 충돌한다(재귀). 그래서 **선언을 본다** — 단, 존재만이 아니라
 * `&&` 순차 단계의 **순서**까지 단정한다. 존재만 보는 검사는 typecheck를 lock 뒤로 옮겨도
 * 초록이라 이 대장 항목이 이름한 사고를 못 잡는다.
 *
 * 실행 비용 0: 파일 하나 읽고 문자열만 본다. 프로세스를 만들지 않는다.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts: Record<string, string> = pkg.scripts ?? {};

/**
 * `&&`로 이어진 순차 단계로 쪼갠다. **`&&`만** 단계 구분자로 인정한다 — `;`나 `||`는 앞 단계의
 * 실패를 삼키므로 게이트가 아니다.
 *
 * **`;`는 이 split만으로 잡히지만 `||`는 잡히지 않는다**(M11③ 적대적 리뷰 C2가 직접 재현했다:
 * `"npm run typecheck || true && node scripts/suite-lock.mjs run test:inner"`가 **green이었다** —
 * `&&` split 뒤 `|| true`가 단계 **안**에 남아 게이트만 조용히 죽는다). 그래서 아래 테스트가
 * typecheck 단계에 실패 삼킴 연산자가 **없다는 것**을 따로 단정한다. 주석이 증명보다 강했던
 * 자리이므로 주석도 함께 정정한다.
 */
function steps(script: string): string[] {
  return script
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

test("[C-104] npm test는 배타 lock을 잡기 전에 typecheck를 통과해야 한다", () => {
  const chain = steps(scripts.test ?? "");
  assert.ok(chain.length > 0, "package.json에 test script가 없다");

  const typecheckAt = chain.findIndex((s) => /(?:^|\s)npm run typecheck(?:\s|$)/.test(s));
  const lockAt = chain.findIndex((s) => s.includes("scripts/suite-lock.mjs"));

  assert.notEqual(typecheckAt, -1, `npm test 체인에 'npm run typecheck' 단계가 없다: ${scripts.test}`);
  assert.notEqual(lockAt, -1, `npm test 체인에 suite-lock wrapper 단계가 없다: ${scripts.test}`);
  assert.ok(
    typecheckAt < lockAt,
    "typecheck는 suite-lock wrapper보다 **앞** 단계여야 한다 — wrapper는 lock을 획득한 뒤 suite를 " +
      `spawn하므로, 뒤로 가면 컴파일 실패가 배타 lock을 잡은 채 난다. 실제: ${scripts.test}`,
  );

  // 게이트가 **존재하고 앞에 있어도** 그 단계 안에서 실패가 삼켜지면 배선은 공허하다.
  // (`|| true`·`; true` — 리뷰 C2가 재현한 우회)
  assert.doesNotMatch(
    chain[typecheckAt] ?? "",
    /\|\||;/,
    "typecheck 단계가 실패를 삼키는 연산자(`||`·`;`)를 품고 있다 — 게이트가 조용히 죽는다: " +
      `${scripts.test}`,
  );

  // 앞에 있기만 하고 정작 뒤에서 도는 것이 진짜 suite가 아니면 배선이 공허해진다.
  assert.match(
    chain[lockAt] ?? "",
    /scripts\/suite-lock\.mjs\s+run\s+test:inner(?:\s|$)/,
    `suite-lock wrapper가 test:inner를 실행하지 않는다: ${scripts.test}`,
  );
});

test("[C-104] test:inner는 exec → core → acceptance 순서를 유지한다", () => {
  const inner = steps(scripts["test:inner"] ?? "");
  assert.deepEqual(
    inner,
    ["npm run test:exec", "npm run test:core", "bash scripts/acceptance.sh"],
    `test:inner 체인이 바뀌었다: ${scripts["test:inner"]}`,
  );
});

test("[C-101] typecheck는 production·test 두 tsconfig를 모두 검사한다", () => {
  // C-104의 배선은 C-101이 만든 검사가 그대로일 때만 의미가 있다. typecheck가 조용히
  // 약해지면(예: tsconfig.test.json 누락) 배선은 초록인 채로 테스트 타입 오류가 다시 쌓인다.
  const tc = steps(scripts.typecheck ?? "");
  assert.deepEqual(
    tc,
    ["tsc --noEmit -p tsconfig.json", "tsc --noEmit -p tsconfig.test.json"],
    `typecheck script가 두 tsconfig를 모두 검사하지 않는다: ${scripts.typecheck}`,
  );
});
