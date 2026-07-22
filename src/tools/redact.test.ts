import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSecretRef, assertValidSecretRefs, redactSecrets, collectSecretValues } from "./redact.js";

test("isValidSecretRef: 환경변수 이름만 허용", () => {
  assert.ok(isValidSecretRef("TAVILY_API_KEY"));
  assert.ok(isValidSecretRef("X"));
  assert.ok(!isValidSecretRef("sk-live-abc"));
  assert.ok(!isValidSecretRef("lower_case"));
  assert.ok(!isValidSecretRef("has space"));
});

test("assertValidSecretRefs: 값 형태 항목은 throw", () => {
  assert.doesNotThrow(() => assertValidSecretRefs(["A_KEY", "B_TOKEN"], "p"));
  assert.throws(() => assertValidSecretRefs(["sk-live-xxxx"], "p"), /secretRefs/);
});

test("[M2.1] invalid secretRef 오류에 입력값 미포함 (index만)", () => {
  const sentinel = "sk-live-SENTINEL-9999";
  try {
    assertValidSecretRefs(["OK_KEY", sentinel, "also bad"], "p");
    assert.fail("throw 했어야 함");
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(!msg.includes(sentinel), "secret 값이 오류 메시지에 없어야 함");
    assert.ok(!msg.includes("also bad"), "다른 위반 값도 없어야 함");
    assert.match(msg, /index: \[1, 2\]/, "위반 index만 알림");
  }
});

test("redactSecrets: 값·자격증명 패턴을 가린다", () => {
  const secret = "supersecretvalue123";
  const text = `token=${secret} and Authorization: Bearer ${secret} and api_key=${secret}`;
  const out = redactSecrets(text, [secret]);
  assert.ok(!out.includes(secret), "원문 secret 값 부재");
  assert.match(out, /token=\*\*\*/);
  assert.match(out, /Authorization: Bearer \*\*\*/i);
});

test("[M2.1] 짧은 secret(1~3자)도 반드시 치환, 빈 값만 무시", () => {
  assert.equal(redactSecrets("a-b-a", ["a"]), "***-b-***", "1자");
  assert.equal(redactSecrets("xxYYxx", ["YY"]), "xx***xx", "2자");
  assert.equal(redactSecrets("pre-abc-post", ["abc"]), "pre-***-post", "3자");
  // 빈 문자열은 무시 (전체가 ***로 뭉개지지 않음)
  assert.equal(redactSecrets("hello", [""]), "hello");
});

test("collectSecretValues: env에서 값 수집", () => {
  const env = { FOO_KEY: "abcd1234", BAR_KEY: undefined } as NodeJS.ProcessEnv;
  assert.deepEqual(collectSecretValues(["FOO_KEY", "BAR_KEY"], env), ["abcd1234"]);
});
