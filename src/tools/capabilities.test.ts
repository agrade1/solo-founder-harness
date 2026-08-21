import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityTier, ACTIVE_CAPS, RESERVED_CAPS, DENY_CAPS } from "./capabilities.js";

test("capabilityTier: 3계층 분류", () => {
  assert.equal(capabilityTier("repo_read"), "active");
  assert.equal(capabilityTier("web_search"), "active");
  assert.equal(capabilityTier("database_read"), "reserved");
  assert.equal(capabilityTier("local_workspace_write"), "reserved");
  assert.equal(capabilityTier("pull_request_create"), "reserved");
  assert.equal(capabilityTier("production_deploy"), "deny");
  assert.equal(capabilityTier("remote_repository_write"), "deny");
  assert.equal(capabilityTier("pull_request_merge"), "deny");
  assert.equal(capabilityTier("design_write"), "deny");
});

test("repo_write_direct는 제거됨 → unknown", () => {
  assert.equal(capabilityTier("repo_write_direct"), "unknown");
  assert.ok(!DENY_CAPS.has("repo_write_direct" as never));
});

test("계층 Set은 서로 겹치지 않는다", () => {
  for (const c of ACTIVE_CAPS) assert.ok(!RESERVED_CAPS.has(c) && !DENY_CAPS.has(c));
  for (const c of RESERVED_CAPS) assert.ok(!ACTIVE_CAPS.has(c) && !DENY_CAPS.has(c));
});
