/**
 * V3 M7 — Tavily backend 계약 테스트. **네트워크를 타지 않는다**(키 없음 경로와 registry 정합만 본다).
 * live 호출은 `scripts/m7-live-benchmark.mjs`(수동 전용)의 몫이다.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  TAVILY_SECRET_REF,
  TAVILY_SETUP_HINT,
  TavilyError,
  createTavilyBackend,
  researchSecretAvailable,
} from "./tavilyBackend.js";
import { loadToolProfiles } from "./profiles.js";
import { KNOWN_ADAPTERS, adapterAvailable } from "./adapters.js";

function withoutSecret<T>(fn: () => T): T {
  const saved = process.env[TAVILY_SECRET_REF];
  delete process.env[TAVILY_SECRET_REF];
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env[TAVILY_SECRET_REF] = saved;
  }
}

test("키가 없으면 호출 전에 fail-closed다(조용한 빈 결과가 없다)", () => {
  withoutSecret(() => {
    assert.equal(researchSecretAvailable(), false);
    assert.throws(() => createTavilyBackend(), (e: TavilyError) => e.code === "secret_missing");
  });
});

test("안내는 값을 요구하지 않고 셸에서 설정하라고 말한다", () => {
  assert.ok(TAVILY_SETUP_HINT.includes("붙여넣지 마라"));
  assert.ok(TAVILY_SETUP_HINT.includes(`export ${TAVILY_SECRET_REF}=`));
  // 안내 자체에 키 값처럼 보이는 것이 들어 있으면 안 된다.
  assert.ok(!/tvly-[A-Za-z0-9_-]{10,}/.test(TAVILY_SETUP_HINT));
});

test("registry profile이 어댑터·secret 이름을 정본과 같게 선언한다", () => {
  assert.ok(adapterAvailable("research", KNOWN_ADAPTERS));
  const p = loadToolProfiles().get("research-tavily");
  assert.ok(p !== undefined, "research-tavily profile이 registry에 없다");
  assert.deepEqual(p.secretRefs, [TAVILY_SECRET_REF]);
  // internal_adapter는 **모델에 도구로 노출되지 않는다** — 노출되면 secret 경계가 바뀐다.
  for (const b of Object.values(p.bindings)) assert.equal(b?.kind, "internal_adapter");
  assert.deepEqual(p.preapprovedTools, []);
  assert.equal(p.permissionMode, "read_only");
  // registry에 값이 들어가면 안 된다(이름만).
  assert.ok(!JSON.stringify(p).includes("tvly-"));
});
