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

/**
 * [V3 M10 T6 · 대장 `B-27`] R6 — **직접 exec되는 승인 실행 파일이 interpreter script면 wrapper 함정이다.**
 * digest는 script 바이트만 고정하고 script가 런타임에 찾아 exec하는 실제 프로그램은 고정하지 않는다
 * (`@openai/codex/bin/codex.js`가 실례다 — 그 wrapper가 `findCodexExecutable`로 바이너리를 고른다).
 */
test("R6 — exec 대상이 `#!` script면 high (wrapper 함정)", () => {
  const f = auditApprovalManifest(
    validateApprovalManifest(
      raw({
        executionAuthority: {
          ...(raw().executionAuthority as Record<string, unknown>),
          codex: { path: "/opt/harness/codex-wrapper", sha256: "c".repeat(64) },
        },
      }),
    ),
    { now: NOW, exists: ALL_PRESENT, readMagic: (p) => (p === "/opt/harness/codex-wrapper" ? "#!" : "\x7fE") },
  );
  const hit = f.filter((x) => x.rule === "approved_executable_is_script");
  assert.equal(hit.length, 1);
  assert.equal(hit[0].subject, "executionAuthority.codex");
  assert.equal(hit[0].severity, "high");
});

test("R6 — controllerEntrypoint는 대상이 아니다(node의 인자이지 exec 대상이 아니다)", () => {
  // 전부 `#!`로 읽히게 해도 entrypoint에는 finding이 없다 — 여기서 걸면 정상 승인이 매번 high를 낸다.
  const f = auditApprovalManifest(validateApprovalManifest(raw()), {
    now: NOW,
    exists: ALL_PRESENT,
    readMagic: () => "#!",
  });
  const subjects = f.filter((x) => x.rule === "approved_executable_is_script").map((x) => x.subject);
  assert.equal(subjects.includes("executionAuthority.controllerEntrypoint"), false);
  // 나머지 exec 대상 셋(git·node·processObserver)은 전부 걸린다 — 규칙이 공허하지 않다는 대조군.
  assert.deepEqual(subjects, ["executionAuthority.git", "executionAuthority.node", "executionAuthority.processObserver"]);
});

test("R6 — 부재 경로는 R6이 아니라 R5만 보고한다(같은 사실을 두 번 세지 않는다)", () => {
  const f = auditApprovalManifest(validateApprovalManifest(raw()), {
    now: NOW,
    exists: () => false,
    readMagic: () => "#!",
  });
  assert.equal(f.some((x) => x.rule === "approved_executable_is_script"), false);
  assert.ok(f.every((x) => x.rule === "approved_path_missing"));
});
