/**
 * V3 M7 T1 — 승인 manifest 정적 감사(`C-67`) 테스트.
 * 각 규칙은 **그 규칙 하나만 제거하면 red**가 되도록 독립적으로 고정한다.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateApprovalManifest } from "./approvalManifest.js";
import { auditApprovalManifest, MAX_APPROVAL_WINDOW_MS } from "./manifestAudit.js";

const NOW = "2026-08-12T00:00:00.000Z";
const ALL_PRESENT = () => true;

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    milestoneId: "v3-m7",
    approvedCommit: "a".repeat(40),
    writableRoots: ["docs"],
    ownershipByTask: { "t-1": ["docs"] },
    allowedCommands: [],
    allowedDependencies: [],
    allowedNetworkDomains: [],
    executionAuthority: {
      codex: null,
      controllerEntrypoint: { path: "/opt/harness/controller.mjs", sha256: "9".repeat(64) },
      git: { path: "/opt/harness/git", sha256: "d".repeat(64) },
      node: { path: "/opt/harness/node", sha256: "e".repeat(64) },
      processObserver: { path: "/opt/harness/ps", sha256: "f".repeat(64) },
    },
    autopilotPolicy: {
      maxTaskAttempts: 2,
      maxDeliveryAttempts: 2,
      retryBackoffMs: 0,
      deliveryDeadlineMs: 600_000,
      maxNoProgressMs: 600_000,
      maxAttemptElapsedMs: 600_000,
      cleanupTermGraceMs: 500,
      cleanupKillGraceMs: 500,
    },
    operationAuthorityByTask: {},
    maxSessions: 8,
    maxTokens: 100_000,
    maxElapsedMs: 3_600_000,
    localMergeAllowed: false,
    expiresAt: "2026-08-13T00:00:00.000Z",
    ...over,
  };
}

const audit = (over: Record<string, unknown> = {}, exists: (p: string) => boolean = ALL_PRESENT) =>
  auditApprovalManifest(validateApprovalManifest(raw(over)), { now: NOW, exists });

const rules = (over?: Record<string, unknown>, exists?: (p: string) => boolean) =>
  audit(over, exists).map((f) => f.rule);

test("깨끗한 manifest는 finding이 없다 (감사가 항상 무언가 찾는 공허한 체크가 아님)", () => {
  assert.deepEqual(audit(), []);
});

test("R1 — writableRoot가 다른 root를 통째로 덮으면 high", () => {
  const f = audit({ writableRoots: ["docs", "docs/spec"], ownershipByTask: { "t-1": ["docs/spec"] } });
  const hit = f.filter((x) => x.rule === "writable_root_covers_another");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].subject, "docs");
  assert.equal(hit[0].severity, "high");
});

test("R2 — 어떤 ownership도 쓰지 않는 writableRoot는 medium", () => {
  const f = audit({ writableRoots: ["docs", "src"], ownershipByTask: { "t-1": ["docs"] } });
  const hit = f.filter((x) => x.rule === "writable_root_unowned");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].subject, "src");
  assert.equal(hit[0].severity, "medium");
});

test("R3 — ownership 없는 task에 operation 권위만 있으면 high", () => {
  const f = audit({
    ownershipByTask: { "t-1": ["docs"] },
    operationAuthorityByTask: {
      "t-1": [{ authorityId: "w1", kind: "write_file", path: "docs/a.md", maxBytes: 1000 }],
      "t-2": [{ authorityId: "w2", kind: "write_file", path: "docs/b.md", maxBytes: 1000 }],
    },
  });
  const hit = f.filter((x) => x.rule === "authority_without_ownership");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].subject, "t-2");
});

test("R4 — 승인 창이 상한을 넘으면 high, 상한 이내면 조용하다", () => {
  const far = new Date(Date.parse(NOW) + MAX_APPROVAL_WINDOW_MS + 3_600_000).toISOString();
  assert.ok(rules({ expiresAt: far }).includes("expiry_too_far"));
  const edge = new Date(Date.parse(NOW) + MAX_APPROVAL_WINDOW_MS).toISOString();
  assert.ok(!rules({ expiresAt: edge }).includes("expiry_too_far"));
});

test("R5 — 승인된 경로가 부재하면 high (선택 key 포함 · 존재하면 조용)", () => {
  const missing = audit({}, (p) => p !== "/opt/harness/git");
  const hit = missing.filter((x) => x.rule === "approved_path_missing");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].subject, "executionAuthority.git");

  const withHome = audit(
    {
      executionAuthority: {
        ...(raw().executionAuthority as Record<string, unknown>),
        codexHome: { path: "/opt/harness/codex-home" },
      },
    },
    (p) => p !== "/opt/harness/codex-home",
  );
  assert.deepEqual(
    withHome.map((x) => x.subject),
    ["executionAuthority.codexHome"],
  );
});

test("보고는 결정적으로 정렬된다", () => {
  const f = audit({ writableRoots: ["src", "docs", "docs/spec"], ownershipByTask: { "t-1": ["docs/spec"] } });
  const keys = f.map((x) => x.rule + x.subject);
  assert.deepEqual(keys, [...keys].sort());
});
