import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_SPECS,
  FORBIDDEN_KEY_FRAGMENTS,
  LIVE_EVIDENCE_CONTRACTS,
  LIVE_EVIDENCE_VERSION,
  LiveEvidenceError,
  MAX_METRIC_INT,
  TOP_LEVEL_KEYS,
  buildLiveEvidence,
  findSensitiveResidue,
  isValidEvidenceTimestamp,
  resolveEvidenceDir,
  serializeLiveEvidence,
  validateLiveEvidence,
  writeLiveEvidence,
} from "./liveEvidence.js";

const TS = "2026-07-26T13:48:21.000Z";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCHEMA_PATH = fileURLToPath(new URL("../../schemas/live_evidence.schema.json", import.meta.url));

/** 계약별 유효 metrics(정수=1, boolean=true). */
function metricsFor(contract: string): Record<string, number | boolean> {
  const spec = CONTRACT_SPECS[contract];
  const out: Record<string, number | boolean> = {};
  for (const [k, kind] of Object.entries(spec)) out[k] = kind === "integer" ? 1 : true;
  return out;
}
function validEvidence(contract: string): Record<string, unknown> {
  return { version: LIVE_EVIDENCE_VERSION, contract, status: "pass", timestamp: TS, metrics: metricsFor(contract) };
}
function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "m3d2-ev-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const filesIn = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const mode = (p: string) => statSync(p).mode & 0o777;

/** 최종 성공 산출물 이름 규칙. 임시/부분 산출물이 이 이름을 가질 수 없음을 검증하는 데 쓴다. */
const FINAL_NAME_RE = /^(?:m3a_live_preflight|m3b2_live_handoff|m3c3b_live_handoff)-\d{8}T\d{6}Z-[0-9a-f]{6,32}\.json$/;
const finalFilesIn = (dir: string) => filesIn(dir).filter((f) => FINAL_NAME_RE.test(f));

// ── 1) 계약별 valid evidence ─────────────────────────────────────────────────

test("[M3d.2] 세 runner 계약 모두 valid evidence 통과 + 기록 (0700 dir / 0600 file / 파싱 가능)", () => {
  assert.deepEqual(LIVE_EVIDENCE_CONTRACTS, ["m3a_live_preflight", "m3b2_live_handoff", "m3c3b_live_handoff"]);
  for (const contract of LIVE_EVIDENCE_CONTRACTS) {
    withTemp((root) => {
      const dir = join(root, "docs", "evidence", "m3d2"); // 미존재 경로도 0700으로 생성
      const evidence = buildLiveEvidence({ contract, metrics: metricsFor(contract), timestamp: TS });
      const p = writeLiveEvidence({ evidence, dir });
      assert.equal(mode(dir), 0o700, "evidence 디렉터리 0700");
      assert.equal(mode(p), 0o600, "evidence 파일 0600");
      assert.equal(filesIn(dir).length, 1, "성공 1건당 파일 1개");
      assert.match(filesIn(dir)[0], new RegExp(`^${contract}-20260726T134821Z-[0-9a-f]{6,32}\\.json$`));
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      assert.deepEqual(validateLiveEvidence(parsed), [], "기록된 JSON도 schema 계약 통과");
      assert.deepEqual(Object.keys(parsed).sort(), TOP_LEVEL_KEYS, "top-level 필드는 정확히 5개");
      assert.equal(parsed.status, "pass");
      // 경로는 payload에 담지 않는다.
      assert.ok(!JSON.stringify(parsed).includes(dir), "evidence 본문에 경로 없음");
    });
  }
});

test("[M3d.2] 계약별 metrics 값은 정수/불리언만 (contract별 exact key 집합)", () => {
  for (const contract of LIVE_EVIDENCE_CONTRACTS) {
    for (const [k, kind] of Object.entries(CONTRACT_SPECS[contract])) {
      assert.ok(kind === "integer" || kind === "boolean", `${contract}.${k} 지표 종류`);
      assert.equal(FORBIDDEN_KEY_FRAGMENTS.some((f) => k.toLowerCase().includes(f)), false, `${contract}.${k}는 금지 이름 조각을 포함하지 않아야 함`);
    }
  }
  // 다른 계약의 metrics를 넣으면 거부(discriminated contract).
  const wrong = { ...validEvidence("m3a_live_preflight"), metrics: metricsFor("m3b2_live_handoff") };
  assert.ok(validateLiveEvidence(wrong).length > 0, "계약 간 metrics 교차는 거부");
});

// ── 2) unknown/missing/wrong-type/nested extra 거부 ───────────────────────────

test("[M3d.2] unknown / 누락 / wrong-type / nested extra 필드 거부", () => {
  const base = validEvidence("m3a_live_preflight");
  const cases: Array<[string, Record<string, unknown>]> = [
    ["top-level unknown", { ...base, extra: 1 }],
    ["top-level 누락(metrics)", { version: "1", contract: "m3a_live_preflight", status: "pass", timestamp: TS }],
    ["version 불일치", { ...base, version: "2" }],
    ["status가 pass 아님", { ...base, status: "fail" }],
    ["contract 미지정 값", { ...base, contract: "m3z_unknown_runner" }],
    ["timestamp 형식 위반", { ...base, timestamp: "2026-07-26 13:48:21" }],
    ["timestamp 로컬 오프셋", { ...base, timestamp: "2026-07-26T13:48:21+09:00" }],
    ["metrics unknown key", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), extraCount: 1 } }],
    ["metrics 누락", { ...base, metrics: { expectedServerCount: 1 } }],
    ["metric 문자열", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: "1" } }],
    ["metric 음수", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: -1 } }],
    ["metric 소수", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: 1.5 } }],
    ["metric 상한 초과", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: MAX_METRIC_INT + 1 } }],
    ["boolean 자리에 정수", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), snapshotWritten: 1 } }],
    ["nested extra(metric 값이 객체)", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: { n: 1, extra: 2 } } }],
    ["nested extra(metrics 안의 하위 객체)", { ...base, metrics: { ...metricsFor("m3a_live_preflight"), nestedBlock: { innerCount: 1 } } }],
    ["metrics가 배열", { ...base, metrics: [] as unknown as Record<string, unknown> }],
  ];
  for (const [label, candidate] of cases) {
    assert.ok(validateLiveEvidence(candidate).length > 0, `거부해야 함: ${label}`);
    withTemp((dir) => {
      assert.throws(() => writeLiveEvidence({ evidence: candidate, dir }), LiveEvidenceError, `write 거부: ${label}`);
      assert.deepEqual(filesIn(dir), [], `기록 없음: ${label}`);
    });
  }
  // evidence 자체가 object가 아닌 경우.
  for (const bad of [null, undefined, 1, "x", [], () => 1]) {
    assert.ok(validateLiveEvidence(bad).length > 0);
  }
  // JSON.parse로 만들어지는 __proto__ own key도 unknown으로 거부.
  const polluted = JSON.parse('{"__proto__":{"x":1},"version":"1","contract":"m3a_live_preflight","status":"pass","timestamp":"2026-07-26T13:48:21.000Z","metrics":{}}');
  assert.ok(validateLiveEvidence(polluted).length > 0, "__proto__ own key 거부");
});

// ── 3) 금지 raw/transcript/argv/path/secret/ID/free-form 필드 거부 ────────────

test("[M3d.2] 금지 필드(raw/transcript/argv/경로/secret/ID/free-form)는 거부되고 기록되지 않음", () => {
  const forbiddenFields: Record<string, unknown>[] = [
    { transcriptPath: "/tmp/t.jsonl" },
    { rawTranscript: "assistant: ..." },
    { toolInput: { file_path: "/tmp/x" } },
    { toolOutput: "result body" },
    { mcpResult: "raw", rawResponse: "x" },
    { argv: ["claude", "-p"] },
    { commandLine: "npx shadcn mcp" },
    { snapshotPath: "/tmp/tools-snapshot.json" },
    { serviceCwd: "/tmp/svc" },
    { hostname: "mac" },
    { userName: "jihun" },
    { pid: 1234 },
    { sessionId: "abc" },
    { callId: "toolu_1" },
    { requestId: "req_1" },
    { envVars: { A: "1" } },
    { secretRefs: ["M3A_SENTINEL_SECRET"] },
    { apiKey: "***" },
    { configBody: "{}" },
    { errorMessage: "boom" },
    { failureReason: "***" },
    { promptText: "..." },
  ];
  for (const extra of forbiddenFields) {
    const label = Object.keys(extra).join(",");
    // top-level에 붙인 경우
    const top = { ...validEvidence("m3a_live_preflight"), ...extra };
    const topErrors = validateLiveEvidence(top);
    assert.ok(topErrors.some((e) => e.includes("금지 필드 이름")), `금지 필드로 거부: ${label} (${topErrors.join(" | ")})`);
    // metrics 안(중첩)에 붙인 경우
    const nested = { ...validEvidence("m3a_live_preflight"), metrics: { ...metricsFor("m3a_live_preflight"), ...extra } };
    assert.ok(validateLiveEvidence(nested).some((e) => e.includes("금지 필드 이름")), `중첩 금지 필드로 거부: ${label}`);
    withTemp((dir) => {
      assert.throws(() => writeLiveEvidence({ evidence: top, dir }), LiveEvidenceError);
      assert.throws(() => writeLiveEvidence({ evidence: nested, dir }), LiveEvidenceError);
      assert.deepEqual(filesIn(dir), [], `금지 필드는 기록되지 않음: ${label}`);
    });
  }
});

test("[M3d.2] redaction 마커로 치환해도 금지 필드는 허용되지 않음", () => {
  const masked = { ...validEvidence("m3a_live_preflight"), transcriptPath: "***", apiKey: "***", errorMessage: "***" };
  const errors = validateLiveEvidence(masked);
  assert.ok(errors.filter((e) => e.includes("금지 필드 이름")).length >= 3, "마커 치환과 무관하게 금지 필드 거부");
  withTemp((dir) => {
    assert.throws(() => writeLiveEvidence({ evidence: masked, dir }), LiveEvidenceError);
    assert.deepEqual(filesIn(dir), []);
  });
});

// ── 4) secret 값 / credential 형태 문자열은 영속화 불가 ───────────────────────

test("[M3d.2] 명시적 secret 값이 payload에 나타나면 backstop이 기록을 거부", () => {
  // 실제 runner 계약에는 문자열 metric이 없으므로, secret 값이 payload 텍스트와 겹치는 상황을 강제한다.
  const env = { M3D2_TEST_SENTINEL: "m3a_live_preflight" } as NodeJS.ProcessEnv;
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    try {
      writeLiveEvidence({ evidence, dir, secretRefs: ["M3D2_TEST_SENTINEL"], env });
      assert.fail("secret 값 잔재는 기록 거부여야 함");
    } catch (e) {
      assert.ok(e instanceof LiveEvidenceError);
      assert.equal((e as LiveEvidenceError).code, "sensitive_residue");
    }
    assert.deepEqual(filesIn(dir), [], "잔재 감지 시 파일 없음");
    // 동일 evidence는 겹치는 secret 없이 정상 기록된다(backstop이 정상 경로를 막지 않음).
    const p = writeLiveEvidence({ evidence, dir, secretRefs: ["M3D2_TEST_SENTINEL"], env: {} as NodeJS.ProcessEnv });
    assert.equal(mode(p), 0o600);
  });
});

test("[M3d.2] findSensitiveResidue: credential 형태·secret 값·예상 외 문자 감지", () => {
  const clean = serializeLiveEvidence(buildLiveEvidence({ contract: "m3b2_live_handoff", metrics: metricsFor("m3b2_live_handoff"), timestamp: TS }));
  assert.equal(findSensitiveResidue(clean, []), null, "정상 evidence는 잔재 없음");
  assert.equal(findSensitiveResidue('{"x":"sk-live-abc"}', ["sk-live-abc"]), "secret_value");
  assert.ok(["redactable_residue", "credential_shape"].includes(String(findSensitiveResidue('{"api_key":"abc"}', []))));
  assert.ok(["redactable_residue", "credential_shape"].includes(String(findSensitiveResidue('{"Authorization":"Bearer abc"}', []))));
  assert.ok(["redactable_residue", "credential_shape"].includes(String(findSensitiveResidue('{"token":"abc"}', []))));
  assert.equal(findSensitiveResidue('{"p":"/Users/x/tmp"}', []), "unexpected_character", "경로 형태 문자 거부");
  assert.equal(findSensitiveResidue('{"e":"A=1"}', []), "unexpected_character", "환경변수 할당 형태 거부");
});

// ── 5~7) 파일 생성 계약: 충돌 / symlink / 비디렉터리 ─────────────────────────

test("[M3d.2] exclusive-create: 동일 파일명 충돌 시 덮어쓰지 않고 실패", () => {
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    const p1 = writeLiveEvidence({ evidence, dir, nonce: "abcdef123456" });
    const before = readFileSync(p1, "utf8");
    const other = buildLiveEvidence({
      contract: "m3a_live_preflight",
      metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: 999 },
      timestamp: TS,
    });
    try {
      writeLiveEvidence({ evidence: other, dir, nonce: "abcdef123456" });
      assert.fail("충돌 시 실패해야 함");
    } catch (e) {
      assert.equal((e as LiveEvidenceError).code, "evidence_exists");
    }
    assert.equal(readFileSync(p1, "utf8"), before, "기존 evidence 불변");
    assert.equal(filesIn(dir).length, 1);
    // 서로 다른 성공은 nonce로 충돌 없이 공존한다.
    writeLiveEvidence({ evidence, dir });
    assert.equal(filesIn(dir).length, 2);
  });
  // 잘못된 nonce 형식은 거부(경로 조작 차단).
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    assert.throws(() => writeLiveEvidence({ evidence, dir, nonce: "../../etc" }), /nonce/);
    assert.deepEqual(filesIn(dir), []);
  });
});

test("[M3d.2] symlink / 비디렉터리 evidence 대상 거부", () => {
  withTemp((root) => {
    const real = join(root, "real");
    mkdirSync(real, { recursive: true, mode: 0o700 });
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });

    // (a) evidence 디렉터리 자체가 symlink
    const linkDir = join(root, "link");
    symlinkSync(real, linkDir);
    assert.throws(() => writeLiveEvidence({ evidence, dir: linkDir }), /symlink/);
    assert.deepEqual(filesIn(real), [], "symlink 경유 기록 없음");

    // (b) 상위 경로가 symlink
    const nestedViaLink = join(linkDir, "m3d2");
    assert.throws(() => writeLiveEvidence({ evidence, dir: nestedViaLink }), /symlink/);

    // (c) 대상이 일반 파일
    const asFile = join(root, "as-file");
    writeFileSync(asFile, "x", "utf8");
    assert.throws(() => writeLiveEvidence({ evidence, dir: asFile }), /디렉터리/);

    // (d) 파일 자리에 symlink가 미리 놓인 경우 — exclusive create가 거부
    const dir = join(root, "evi");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const decoy = join(root, "decoy.json");
    writeFileSync(decoy, "old", "utf8");
    symlinkSync(decoy, join(dir, "m3a_live_preflight-20260726T134821Z-abcdef123456.json"));
    assert.throws(() => writeLiveEvidence({ evidence, dir, nonce: "abcdef123456" }), LiveEvidenceError);
    assert.equal(readFileSync(decoy, "utf8"), "old", "symlink 대상 파일 불변");
  });
});

test("[M3d.2] 쓰기 실패 시 부분 산출물이 남지 않음", () => {
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    assert.throws(
      () => writeLiveEvidence({ evidence, dir, nonce: "beefbeefbeef", testHooks: { afterOpen: () => { throw new Error("주입 실패"); } } }),
      /주입 실패/,
    );
    assert.deepEqual(filesIn(dir), [], "부분 파일 잔재 없음(숨김 임시 파일 포함)");
    assert.deepEqual(finalFilesIn(dir), [], "최종 성공 산출물 이름의 파일 없음");
    // 실패 후에도 동일 파일명으로 정상 기록 가능(잔재가 없었음을 확인).
    const p = writeLiveEvidence({ evidence, dir, nonce: "beefbeefbeef" });
    assert.equal(mode(p), 0o600);
  });
});

// ── 7b) temp → atomic publish 프로토콜 (P1-4 / P2-5) ─────────────────────────

test("[M3d.2] 정상 publish: 최종 파일 1건 + 숨김 임시 잔재 0 + 내용/권한 완결", () => {
  withTemp((root) => {
    const dir = join(root, "evi");
    const evidence = buildLiveEvidence({ contract: "m3b2_live_handoff", metrics: metricsFor("m3b2_live_handoff"), timestamp: TS });
    const p = writeLiveEvidence({ evidence, dir, nonce: "0123456789ab" });
    const entries = filesIn(dir);
    assert.deepEqual(entries, ["m3b2_live_handoff-20260726T134821Z-0123456789ab.json"], "최종 1건, temp 잔재 없음");
    assert.equal(entries.filter((f) => f.startsWith(".")).length, 0, "숨김 임시 파일 없음");
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(p), 0o600);
    assert.equal(readFileSync(p, "utf8"), serializeLiveEvidence(evidence), "byte 동일하게 완결 기록");
  });
});

test("[M3d.2] publish 충돌: 최종 이름이 이미 있으면 덮어쓰지 않고 임시 파일도 남기지 않음", () => {
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    const p1 = writeLiveEvidence({ evidence, dir, nonce: "aaaabbbbcccc" });
    const before = readFileSync(p1, "utf8");
    const other = buildLiveEvidence({
      contract: "m3a_live_preflight",
      metrics: { ...metricsFor("m3a_live_preflight"), expectedServerCount: 42 },
      timestamp: TS,
    });
    try {
      writeLiveEvidence({ evidence: other, dir, nonce: "aaaabbbbcccc" });
      assert.fail("publish 충돌은 실패여야 함");
    } catch (e) {
      assert.equal((e as LiveEvidenceError).code, "evidence_exists");
    }
    assert.equal(readFileSync(p1, "utf8"), before, "기존 evidence 불변");
    assert.equal(filesIn(dir).length, 1, "충돌 실패 후 임시 파일 잔재 없음");
  });
});

test("[M3d.2] publish 직전/직후 주입 실패: 최종 이름 파일이 남지 않고 임시도 정리됨", () => {
  const evidenceOf = () => buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
  // (a) publish 직전 실패 → 최종 파일 자체가 만들어지지 않는다.
  withTemp((dir) => {
    assert.throws(
      () => writeLiveEvidence({ evidence: evidenceOf(), dir, nonce: "111122223333", testHooks: { beforePublish: () => { throw new Error("publish 직전 실패"); } } }),
      /publish 직전 실패/,
    );
    assert.deepEqual(filesIn(dir), [], "잔재 없음");
  });
  // (b) publish 직후 실패 → 발행분까지 되돌린다(성공 산출물 잔재 금지).
  withTemp((dir) => {
    assert.throws(
      () => writeLiveEvidence({ evidence: evidenceOf(), dir, nonce: "444455556666", testHooks: { afterPublish: () => { throw new Error("publish 직후 실패"); } } }),
      /publish 직후 실패/,
    );
    assert.deepEqual(finalFilesIn(dir), [], "최종 이름 파일 없음");
    assert.deepEqual(filesIn(dir), [], "임시 파일도 정리됨");
  });
});

test("[M3d.2] 임시 파일 정리 실패는 조용히 무시되지 않고 실패로 보고된다", () => {
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    try {
      writeLiveEvidence({
        evidence,
        dir,
        nonce: "777788889999",
        testHooks: {
          unlinkTemp: () => {
            const err = new Error("EPERM 주입") as NodeJS.ErrnoException;
            err.code = "EPERM";
            throw err;
          },
        },
      });
      assert.fail("정리 실패는 오류여야 함");
    } catch (e) {
      assert.ok(e instanceof LiveEvidenceError);
      assert.equal((e as LiveEvidenceError).code, "evidence_cleanup");
      assert.match((e as LiveEvidenceError).message, /temp_unlink_EPERM/);
    }
    // 완결되지 않은 기록이므로 최종 산출물은 남기지 않는다. 남는 것은 숨김 임시 파일뿐이다.
    assert.deepEqual(finalFilesIn(dir), [], "최종 이름 파일 없음");
    const leftovers = filesIn(dir);
    assert.equal(leftovers.length, 1);
    assert.ok(leftovers[0].startsWith(".") && leftovers[0].endsWith(".tmp"), `숨김 임시 파일만 잔존: ${leftovers[0]}`);
  });
});

test("[M3d.2] 정리는 dev+ino 신원을 확인해 교체된 파일을 지우지 않는다", () => {
  withTemp((dir) => {
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    const nonce = "abcabcabcabc";
    const tempName = `.m3a_live_preflight-20260726T134821Z-${nonce}.json.tmp`;
    try {
      writeLiveEvidence({
        evidence,
        dir,
        nonce,
        testHooks: {
          // publish 직후 임시 경로를 **다른 파일**로 교체한다 → 정리가 그 파일을 지우면 안 된다.
          afterPublish: () => {
            rmSync(join(dir, tempName), { force: true });
            writeFileSync(join(dir, tempName), "replacement-must-survive", "utf8");
          },
        },
      });
      assert.fail("신원 불일치 정리는 실패로 보고돼야 함");
    } catch (e) {
      assert.equal((e as LiveEvidenceError).code, "evidence_cleanup");
      assert.match((e as LiveEvidenceError).message, /temp_identity_mismatch/);
    }
    assert.equal(readFileSync(join(dir, tempName), "utf8"), "replacement-must-survive", "교체된 파일은 삭제되지 않음");
    assert.deepEqual(finalFilesIn(dir), [], "최종 이름 파일은 되돌려짐");
  });
});

test("[M3d.2] 쓰기 중 프로세스 크래시: 최종 성공 산출물 이름의 잘린 파일이 생기지 않는다", () => {
  const distEvidence = join(REPO_ROOT, "dist", "tools", "liveEvidence.js");
  if (!existsSync(distEvidence)) return; // dist 미빌드 환경에서는 건너뜀
  withTemp((root) => {
    const dir = join(root, "evi");
    const nonce = "cafecafecafe";
    const finalName = `m3a_live_preflight-20260726T134821Z-${nonce}.json`;
    const crasher = join(root, "crash.mjs");
    writeFileSync(
      crasher,
      [
        `import { CONTRACT_SPECS, buildLiveEvidence, writeLiveEvidence } from ${JSON.stringify(distEvidence)};`,
        'const spec = CONTRACT_SPECS["m3a_live_preflight"];',
        "const metrics = {};",
        'for (const [k, kind] of Object.entries(spec)) metrics[k] = kind === "integer" ? 1 : true;',
        `const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics, timestamp: ${JSON.stringify(TS)} });`,
        "writeLiveEvidence({",
        `  evidence, dir: ${JSON.stringify(dir)}, nonce: ${JSON.stringify(nonce)},`,
        '  testHooks: { afterOpen: () => process.kill(process.pid, "SIGKILL") },', // 정리 없는 하드 크래시
        "});",
      ].join("\n"),
      "utf8",
    );
    const r = spawnSync(process.execPath, [crasher], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.signal, "SIGKILL", `크래시 재현 (stderr: ${String(r.stderr).slice(0, 300)})`);
    assert.deepEqual(finalFilesIn(dir), [], "최종 이름의 잘린 파일 없음");
    const leftovers = filesIn(dir);
    assert.deepEqual(leftovers, [`.${finalName}.tmp`], "잔재는 숨김 임시 파일뿐");

    // 같은 nonce는 임시 파일 충돌로 거부되고(덮어쓰기 없음), 다른 nonce는 정상 발행된다.
    const evidence = buildLiveEvidence({ contract: "m3a_live_preflight", metrics: metricsFor("m3a_live_preflight"), timestamp: TS });
    try {
      writeLiveEvidence({ evidence, dir, nonce });
      assert.fail("잔존 임시 파일과 같은 이름은 거부돼야 함");
    } catch (e) {
      assert.equal((e as LiveEvidenceError).code, "evidence_temp_exists");
    }
    const p = writeLiveEvidence({ evidence, dir, nonce: "ddddeeeeffff" });
    assert.equal(mode(p), 0o600);
    assert.deepEqual(finalFilesIn(dir), ["m3a_live_preflight-20260726T134821Z-ddddeeeeffff.json"]);
  });
});

// ── 8) JSON Schema ↔ 런타임 validator 동기 ───────────────────────────────────

test("[M3d.2] schemas/live_evidence.schema.json이 런타임 validator와 정확히 동기", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const defs = schema.definitions;
  assert.deepEqual(
    schema.oneOf.map((r: { $ref: string }) => r.$ref.replace("#/definitions/", "")).sort(),
    LIVE_EVIDENCE_CONTRACTS,
    "schema oneOf 계약 목록 == CONTRACT_SPECS",
  );
  for (const contract of LIVE_EVIDENCE_CONTRACTS) {
    const def = defs[contract];
    assert.equal(def.additionalProperties, false, `${contract}: additionalProperties false`);
    assert.deepEqual(Object.keys(def.properties).sort(), TOP_LEVEL_KEYS, `${contract}: top-level 필드 동일`);
    assert.deepEqual([...def.required].sort(), TOP_LEVEL_KEYS, `${contract}: required 동일`);
    assert.equal(def.properties.contract.const, contract, `${contract}: discriminant const`);
    const m = def.properties.metrics;
    assert.equal(m.additionalProperties, false, `${contract}.metrics: additionalProperties false`);
    const specKeys = Object.keys(CONTRACT_SPECS[contract]).sort();
    assert.deepEqual(Object.keys(m.properties).sort(), specKeys, `${contract}.metrics: key 집합 동일`);
    assert.deepEqual([...m.required].sort(), specKeys, `${contract}.metrics: required 동일`);
    for (const [k, kind] of Object.entries(CONTRACT_SPECS[contract])) {
      const ref = m.properties[k].$ref.replace("#/definitions/", "");
      assert.equal(ref, kind === "integer" ? "metricInteger" : "metricBoolean", `${contract}.metrics.${k}: 타입 동일`);
    }
  }
  assert.equal(defs.metricInteger.type, "integer");
  assert.equal(defs.metricInteger.minimum, 0);
  assert.equal(defs.metricInteger.maximum, MAX_METRIC_INT);
  assert.equal(defs.status.const, "pass");
  assert.equal(defs.version.const, LIVE_EVIDENCE_VERSION);
});

// ── 8b) timestamp: schema 판정 == 런타임 판정 (P2-6) ─────────────────────────

/** schema의 timestamp 정의를 그대로 평가하는 최소 evaluator (pattern/allOf/anyOf/not/type만). */
function schemaAccepts(node: Record<string, unknown>, value: string): boolean {
  if (node.type === "string" && typeof value !== "string") return false;
  if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) return false;
  if (Array.isArray(node.allOf) && !node.allOf.every((n) => schemaAccepts(n as Record<string, unknown>, value))) return false;
  if (Array.isArray(node.anyOf) && !node.anyOf.some((n) => schemaAccepts(n as Record<string, unknown>, value))) return false;
  if (node.not !== undefined && schemaAccepts(node.not as Record<string, unknown>, value)) return false;
  return true;
}

test("[M3d.2] timestamp: JSON Schema 판정과 런타임 validator 판정이 동일(시/날짜/오프셋/소수)", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const tsDef = schema.definitions.timestamp as Record<string, unknown>;
  // evaluator가 모르는 keyword가 schema에 추가되면 동치 검증이 무의미해지므로 키 집합을 고정한다.
  const allowedKeywords = new Set(["description", "type", "pattern", "allOf", "anyOf", "not"]);
  const collectKeywords = (node: Record<string, unknown>): string[] => {
    const out = Object.keys(node);
    for (const k of ["allOf", "anyOf"]) {
      const arr = node[k];
      if (Array.isArray(arr)) for (const n of arr) out.push(...collectKeywords(n as Record<string, unknown>));
    }
    if (node.not !== undefined) out.push(...collectKeywords(node.not as Record<string, unknown>));
    return out;
  };
  for (const k of collectKeywords(tsDef)) assert.ok(allowedKeywords.has(k), `schema timestamp에 미지원 keyword: ${k}`);

  const accepted = [
    "2026-07-26T13:48:21Z",
    "2026-07-26T13:48:21.000Z",
    "2026-01-01T00:00:00Z",
    "2026-12-31T23:59:59.999Z",
    "2028-02-29T12:00:00Z", // 윤년 2월 29일
    "2000-02-29T00:00:00Z", // 2000년(400의 배수) — 2000..2099 범위에서 %4로 정확히 판정
  ];
  const rejected = [
    // 시/분/초 범위
    "2026-07-26T24:00:00Z",
    "2026-07-26T25:00:00Z",
    "2026-07-26T13:60:00Z",
    "2026-07-26T13:48:60Z",
    // 달력 실재성
    "2026-02-30T00:00:00Z",
    "2026-02-31T00:00:00Z",
    "2027-02-29T00:00:00Z", // 비윤년
    "2026-04-31T00:00:00Z",
    "2026-06-31T00:00:00Z",
    "2026-09-31T00:00:00Z",
    "2026-11-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-07-32T00:00:00Z",
    "2026-07-00T00:00:00Z",
    // 오프셋·타임존
    "2026-07-26T13:48:21+09:00",
    "2026-07-26T13:48:21-00:00",
    "2026-07-26T13:48:21",
    "2026-07-26T13:48:21z",
    "2026-07-26 13:48:21Z",
    "2026-07-26t13:48:21Z",
    // 소수 자리
    "2026-07-26T13:48:21.1Z",
    "2026-07-26T13:48:21.12Z",
    "2026-07-26T13:48:21.1234Z",
    "2026-07-26T13:48:21.Z",
    // 연도 범위/공백
    "1999-07-26T13:48:21Z",
    "2100-07-26T13:48:21Z",
    " 2026-07-26T13:48:21Z",
    "2026-07-26T13:48:21Z ",
  ];
  for (const ts of accepted) {
    assert.equal(isValidEvidenceTimestamp(ts), true, `런타임 accept: ${ts}`);
    assert.equal(schemaAccepts(tsDef, ts), true, `schema accept: ${ts}`);
    assert.deepEqual(validateLiveEvidence({ ...validEvidence("m3a_live_preflight"), timestamp: ts }), [], `evidence accept: ${ts}`);
  }
  for (const ts of rejected) {
    assert.equal(isValidEvidenceTimestamp(ts), false, `런타임 reject: ${ts}`);
    assert.equal(schemaAccepts(tsDef, ts), false, `schema reject: ${ts}`);
    assert.ok(
      validateLiveEvidence({ ...validEvidence("m3a_live_preflight"), timestamp: ts }).some((e) => e.startsWith("evidence.timestamp:")),
      `evidence reject: ${ts}`,
    );
  }
  // 비문자열도 양쪽 모두 거부.
  for (const bad of [null, 1, {}, []]) {
    assert.equal(isValidEvidenceTimestamp(bad), false);
    assert.equal(schemaAccepts(tsDef, bad as unknown as string), false);
  }
});

test("[M3d.2] resolveEvidenceDir: 기본 docs/evidence/m3d2 + 명시 인자 override만 허용(env 미참조)", () => {
  assert.equal(resolveEvidenceDir({ repoRoot: "/repo" }), "/repo/docs/evidence/m3d2");
  assert.equal(resolveEvidenceDir({ repoRoot: "/repo", overrideDir: "" }), "/repo/docs/evidence/m3d2");
  assert.equal(resolveEvidenceDir({ repoRoot: "/repo", overrideDir: "/tmp/evi" }), "/tmp/evi");
  assert.throws(() => resolveEvidenceDir({ repoRoot: "/repo", overrideDir: "relative/evi" }), /절대경로/);
  // 시그니처에 env 입력이 없다 — 옛 seam을 넘겨도 기본 경로가 나온다(해석되지 않는다).
  assert.equal(
    resolveEvidenceDir({ repoRoot: "/repo", ...({ env: { HARNESS_LIVE_EVIDENCE_DIR: "/tmp/evi" } } as object) }),
    "/repo/docs/evidence/m3d2",
  );
});

// ── 9) runner offline 회귀: 실패는 evidence를 남기지 않고, 성공 payload는 안전하다 ──

const RUNNERS: Array<[string, string, string]> = [
  ["m3a", "scripts/m3a-live-preflight.mjs", "HARNESS_LIVE_M3A"],
  ["m3b2", "scripts/m3b2-live-handoff.mjs", "HARNESS_LIVE_M3B2"],
  ["m3c3b", "scripts/m3c3b-live-handoff.mjs", "HARNESS_LIVE_M3C3B"],
];

/** evidence 위치 override는 argv `--fixture-config <절대경로 .json>`로만 들어간다(env seam 없음). */
function evidenceFixture(dir: string, config: Record<string, unknown>, name = "fixture.json"): string[] {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(config) + "\n", { encoding: "utf8", mode: 0o600 });
  return ["--fixture-config", p];
}

test("[M3d.2] runner offline smoke: opt-in 없으면 거부(exit 2)하고 evidence를 남기지 않음", () => {
  for (const [label, rel, guard] of RUNNERS) {
    withTemp((root) => {
      const dir = join(root, "evi");
      const r = spawnSync(process.execPath, [join(REPO_ROOT, rel), ...evidenceFixture(root, { evidenceDir: dir })], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, [guard]: "" },
      });
      assert.equal(r.status, 2, `${label}: opt-in 없으면 exit 2 (stderr: ${String(r.stderr).slice(0, 200)})`);
      assert.equal(existsSync(dir), false, `${label}: 미실행 run은 evidence 디렉터리조차 만들지 않음`);
    });
  }
});

test("[M3d.2] runner fixture 설정: 상대경로·unknown key·비파일은 lock 획득/실행 전에 거부(exit 2)", () => {
  for (const [label, rel, guard] of RUNNERS) {
    withTemp((root) => {
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["상대경로", { evidenceDir: "relative/evi" }, /fixture_value_invalid/],
        ["unknown key", { evidenceDir: join(root, "evi"), lockPath: join(root, "x.lock") }, /fixture_unknown_key/],
      ];
      for (const [caseLabel, config, code] of cases) {
        const r = spawnSync(
          process.execPath,
          [join(REPO_ROOT, rel), ...evidenceFixture(root, config, `${caseLabel === "상대경로" ? "rel" : "unknown"}.json`)],
          // opt-in은 끈 채로 확인한다(실제 live 실행 금지). fixture 검증은 opt-in 검사보다 먼저 끝나야 한다.
          { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, [guard]: "" } },
        );
        assert.equal(r.status, 2, `${label}/${caseLabel}: 거부 (stderr: ${String(r.stderr).slice(0, 200)})`);
        assert.match(String(r.stderr), code, `${label}/${caseLabel}: 거부 코드`);
      }
      // 존재하지 않는 fixture 파일도 거부한다.
      const missing = spawnSync(
        process.execPath,
        [join(REPO_ROOT, rel), "--fixture-config", join(root, "no-such-fixture.json")],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, [guard]: "" } },
      );
      assert.equal(missing.status, 2, `${label}: 없는 fixture 파일 거부`);
      assert.match(String(missing.stderr), /fixture_unreadable/);
    });
  }
});

test("[M3d.2] m3a runner: preflight 실패(offline fake claude)는 evidence를 남기지 않음", () => {
  if (!existsSync(join(REPO_ROOT, "dist", "tools", "preflight.js"))) {
    // dist 미빌드 환경: runner는 exit 2로 거부하며 이 경우도 evidence는 없어야 한다.
    withTemp((root) => {
      const dir = join(root, "evi");
      const r = spawnSync(
        process.execPath,
        [join(REPO_ROOT, "scripts", "m3a-live-preflight.mjs"), ...evidenceFixture(root, { evidenceDir: dir })],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, env: { ...process.env, HARNESS_LIVE_M3A: "1" } },
      );
      assert.notEqual(r.status, 0);
      assert.equal(existsSync(dir), false);
    });
    return;
  }
  withTemp((root) => {
    // live Claude/MCP/네트워크를 호출하지 않는 fake bin: 즉시 실패한다.
    const fakeBin = join(root, "fake-claude.sh");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n", { encoding: "utf8", mode: 0o755 });
    const dir = join(root, "evi");
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "m3a-live-preflight.mjs"), ...evidenceFixture(root, { evidenceDir: dir })],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, HARNESS_LIVE_M3A: "1", HARNESS_CLAUDE_BIN: fakeBin },
      },
    );
    assert.notEqual(r.status, 0, `실패 경로는 nonzero exit (stdout: ${String(r.stdout).slice(-300)})`);
    assert.deepEqual(existsSync(dir) ? filesIn(dir) : [], [], "실패한 run은 evidence를 남기지 않음");
  });
});

test("[M3d.2] m3a runner: offline fake claude로 PASS 시 안전한 evidence 정확히 1건 기록", () => {
  if (!existsSync(join(REPO_ROOT, "dist", "tools", "preflight.js"))) return; // dist 미빌드 환경에서는 건너뜀
  withTemp((root) => {
    // live Claude/MCP/네트워크를 호출하지 않는 fake bin: strict mcp-config의 서버만 띄우고 init 스냅샷을 흉내낸다.
    const fakeBin = join(root, "fake-claude.mjs");
    writeFileSync(
      fakeBin,
      [
        "#!/usr/bin/env node",
        'import { readFileSync, existsSync } from "node:fs";',
        'import { spawn } from "node:child_process";',
        "const argv = process.argv.slice(2);",
        'const cfg = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));',
        "const servers = [], tools = [], pidFiles = [];",
        "for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {",
        '  spawn(s.command, s.args ?? [], { stdio: ["pipe", "pipe", "ignore"] });',
        '  servers.push({ name, status: "connected" });',
        "  tools.push(`mcp__${name}__${(s.args ?? [])[2]}`);",
        "  if ((s.args ?? [])[3]) pidFiles.push(s.args[3]);",
        "}",
        "let waited = 0;",
        "const tick = setInterval(() => {",
        "  waited += 100;",
        "  if (pidFiles.every((f) => existsSync(f)) || waited >= 3000) {",
        "    clearInterval(tick);",
        '    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "offline-fake", model: "offline-fake", permissionMode: "plan", tools, mcp_servers: servers }) + "\\n");',
        "  }",
        "}, 100);",
        "setTimeout(() => process.exit(0), 20000).unref?.();",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    const dir = join(root, "evi");
    // 옛 env seam을 **다른 경로**로 심어 둔다. production이 env를 읽는다면 이쪽에 기록될 것이다.
    const envDecoy = join(root, "env-decoy");
    const r = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "m3a-live-preflight.mjs"), ...evidenceFixture(root, { evidenceDir: dir })],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 180_000,
        env: {
          ...process.env,
          HARNESS_LIVE_M3A: "1",
          HARNESS_CLAUDE_BIN: fakeBin,
          HARNESS_LIVE_EVIDENCE_DIR: envDecoy,
        },
      },
    );
    assert.equal(r.status, 0, `fake claude PASS 경로 (stdout tail: ${String(r.stdout).slice(-500)} / stderr: ${String(r.stderr).slice(-500)})`);
    assert.equal(existsSync(envDecoy), false, "production은 env seam을 해석하지 않는다(env 경로에 아무것도 쓰지 않음)");
    // 기록 경로는 콘솔에 노출되지 않는다(임시 경로·fixture 경로 모두).
    const consoleText = String(r.stdout) + String(r.stderr);
    assert.equal(consoleText.includes(root), false, "evidence·fixture 경로를 출력하지 않는다");
    const files = filesIn(dir);
    assert.equal(files.length, 1, "성공 1회당 evidence 1건");
    assert.match(files[0], /^m3a_live_preflight-\d{8}T\d{6}Z-[0-9a-f]{6,32}\.json$/);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(join(dir, files[0])), 0o600);
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.deepEqual(validateLiveEvidence(parsed), [], "runner가 기록한 evidence도 계약 통과");
    assert.deepEqual(Object.keys(parsed).sort(), TOP_LEVEL_KEYS);
    assert.equal(parsed.contract, "m3a_live_preflight");
    assert.equal(parsed.metrics.expectedServerCount, 1);
    assert.equal(parsed.metrics.expectedToolCount, 1);
    assert.equal(parsed.metrics.expectedServerConnected, true);
    assert.equal(parsed.metrics.ambientCanarySpawned, false);
    assert.equal(parsed.metrics.snapshotWritten, true);
    assert.equal(parsed.metrics.fixtureExitedWithinLimit, true);
    // 저장물에 경로·식별자·원문이 없음.
    const text = readFileSync(join(dir, files[0]), "utf8");
    assert.ok(!/[/\\]/.test(text), "경로 문자 없음");
    assert.ok(!text.includes("offline-fake"), "session/model 식별자 없음");
  });
});

test("[M3d.2] runner별 성공 evidence(offline 재현): 안전 지표만 기록", () => {
  // 각 runner가 PASS 시 조립하는 지표 형태를 그대로 통과시켜, 저장물이 안전한지 확인한다.
  const successMetrics: Record<string, Record<string, number | boolean>> = {
    m3a_live_preflight: {
      expectedServerCount: 1,
      expectedToolCount: 1,
      expectedServerConnected: true,
      snapshotWritten: true,
      ambientCanarySpawned: false,
      fixtureExitedWithinLimit: true,
      sentinelLeakAbsent: true,
      sensitivePatternAbsent: true,
    },
    m3b2_live_handoff: {
      hookKindCount: 6,
      traceRecordCount: 14,
      distinctSessionCount: 1,
      toolRequestedCount: 6,
      toolSucceededCount: 4,
      toolFailedCount: 1,
      permissionRequestedCount: 2,
      sessionEndCount: 1,
      emptyMcpServerCount: 0,
      emptyMcpToolCount: 0,
      ambientMcpCanarySpawned: false,
      ambientHookCanaryExecuted: false,
      rejectMarkerCreated: false,
      permissionBitsExact: true,
      runStateHandoffRecorded: true,
      sentinelLeakAbsent: true,
    },
    m3c3b_live_handoff: {
      allowedToolCount: 5,
      deniedToolCount: 2,
      snapshotToolCount: 5,
      traceRecordCount: 7,
      distinctSessionCount: 1,
      mcpToolRequestedCount: 3,
      mcpToolSucceededCount: 3,
      unplannedMcpToolRequestedCount: 0,
      forbiddenToolObservedCount: 0,
      sessionEndCount: 1,
      leftoverProcessCount: 0,
      hashChainMatched: true,
      serviceRepoUnchanged: true,
      ambientMcpCanarySpawned: false,
      ambientHookCanaryExecuted: false,
      permissionBitsExact: true,
      runStateHandoffRecorded: true,
      sentinelLeakAbsent: true,
    },
  };
  const sentinel = "m3d2sentinel0123456789abcdef";
  const env = { M3D2_FAKE_TOKEN: sentinel } as NodeJS.ProcessEnv;
  withTemp((dir) => {
    for (const [contract, metrics] of Object.entries(successMetrics)) {
      const evidence = buildLiveEvidence({ contract, metrics, timestamp: TS });
      const p = writeLiveEvidence({ evidence, dir, secretRefs: ["M3D2_FAKE_TOKEN"], env });
      const text = readFileSync(p, "utf8");
      assert.ok(!text.includes(sentinel), "secret 평문 없음");
      assert.ok(!/[/\\]/.test(text), "경로 문자 없음");
      assert.deepEqual(validateLiveEvidence(JSON.parse(text)), []);
    }
    assert.equal(filesIn(dir).length, 3, "runner별 1건");
  });
});
