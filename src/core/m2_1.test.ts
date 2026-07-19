/**
 * [M2.1] ToolProfile 정책 실제 전달 + MCP fail-closed(run-level) 테스트.
 * HARNESS_WORKSPACE는 test:core 스크립트가 지정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWorkflow, loadRunState } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import { mockProvider } from "../providers/mockProvider.js";
import type { Provider, AgentRunInput, AgentResult, ProviderExecContext } from "../providers/provider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) => join(HERE, "..", "..", "tests", "fixtures", "tool-profiles", n);
const FIXED = "2026-01-01T00:00:00.000Z";

function makeProject(name: string): void {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트\n", "utf8");
}

/** execContext를 기록하면서 markdown은 mock에 위임하는 provider. */
function recording(id: string): { provider: Provider; seen: (ProviderExecContext | undefined)[] } {
  const seen: (ProviderExecContext | undefined)[] = [];
  const provider: Provider = {
    id,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      seen.push(input.execContext);
      return mockProvider.generate(input);
    },
  };
  return { provider, seen };
}

test("[M2.1] --tool-profile 지정 시 compile된 argv가 execContext로 provider에 전달", async () => {
  makeProject("_t_m21_wire");
  const rec = recording("claude-code"); // builtin 지원 → fail-fast 통과
  await runWorkflow({
    workflowId: "idea-validation",
    project: "_t_m21_wire",
    provider: rec.provider,
    toolProfileId: "planning-local-readonly",
    bare: true,
    now: () => FIXED,
  });
  assert.ok(rec.seen.length > 0, "provider.generate 호출됨");
  const ctx = rec.seen[0];
  assert.ok(ctx, "execContext 전달됨");
  const a = ctx!.claudeArgs;
  assert.ok(a.includes("--strict-mcp-config"), "--strict-mcp-config 포함");
  const ti = a.indexOf("--tools");
  assert.equal(a[ti + 1], "Read,Glob,Grep");
  const pi = a.indexOf("--permission-mode");
  assert.equal(a[pi + 1], "plan");
  // 모든 step에 동일 execContext 전달
  assert.ok(rec.seen.every((c) => c && c.claudeArgs.includes("--tools")));
});

test("[M2.1] --tool-profile 미지정 시 execContext 없음 (기존 실행 경로 불변)", async () => {
  makeProject("_t_m21_none");
  const rec = recording("mock");
  const r = await runWorkflow({
    workflowId: "idea-validation",
    project: "_t_m21_none",
    provider: rec.provider,
    now: () => FIXED,
  });
  assert.equal(r.state.status, "completed");
  assert.ok(rec.seen.length > 0);
  assert.ok(rec.seen.every((c) => c === undefined), "모든 step에 execContext undefined");
});

test("[M2.1] MCP binding profile은 run_start/run_state 이전에 거부 (loader/compile 아님)", async () => {
  makeProject("_t_m21_mcp");
  await assert.rejects(
    runWorkflow({
      workflowId: "idea-validation",
      project: "_t_m21_mcp",
      provider: mockProvider,
      toolProfileId: "dev-shadcn-readonly",
      toolProfilesPath: FIX("valid-mcp.json"),
      now: () => FIXED,
    }),
    /MCP binding|M3/,
  );
  assert.equal(loadRunState("_t_m21_mcp"), null, "run_state가 생성되지 않음");
});
