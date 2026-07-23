/**
 * [M3b.2 offline] handoff 커맨드 래퍼 테스트. 실제 claude/preflight/spawn을 타지 않는 경로만
 * 검증한다(--print, not_completed). yes/spawn 경로는 core 테스트(seam 주입)에서 다룬다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runHandoffCommand } from "./handoff.js";
import { runRun } from "./run.js";
import { runWorkflow } from "../core/runWorkflow.js";
import { projectPaths } from "../core/project.js";
import { mockProvider } from "../providers/mockProvider.js";

function makeIdeaProject(name: string): void {
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트\n", "utf8");
}

const FIXED = "2026-01-01T00:00:00.000Z";

async function completedProject(name: string): Promise<void> {
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트\n", "utf8");
  await runWorkflow({ workflowId: "idea-validation", project: name, provider: mockProvider, now: () => FIXED });
}

test("[M3b.2] 커맨드: --print → printed, exitCode 정상", async () => {
  const name = "_hc_print";
  await completedProject(name);
  const prevExit = process.exitCode;
  try {
    const outcome = await runHandoffCommand({ project: name, cwd: "/svc/repo", print: true });
    assert.equal(outcome.action, "printed");
    assert.notEqual(process.exitCode, 1);
  } finally {
    process.exitCode = prevExit;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] 커맨드: run_state 없음 → not_completed + exitCode 1", async () => {
  const name = "_hc_missing";
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.outputs, { recursive: true });
  mkdirSync(paths.docs, { recursive: true });
  const prevExit = process.exitCode;
  try {
    const outcome = await runHandoffCommand({ project: name, cwd: "/svc/repo", print: false });
    assert.equal(outcome.action, "not_completed");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prevExit;
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("[M3b.2] run --handoff: run이 completed면 handoffRunner 호출(stub)", async () => {
  const name = "_hc_run_ok";
  makeIdeaProject(name);
  const prevExit = process.exitCode;
  let called = 0;
  const spy = async () => {
    called++;
    return {};
  };
  try {
    // runRun(workflow, project, provider, maxRegen, allowSpawn, vault, resume, maxTokens, yes, toolProfile, bare, handoff, handoffCwd, handoffRunner)
    await runRun("idea-validation", name, "mock", 1, false, undefined, false, 0, true, undefined, false, true, "/svc", spy);
    assert.equal(called, 1, "completed run은 handoff 이어붙임");
  } finally {
    process.exitCode = prevExit;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});

test("[M3b.2] run --handoff: run이 failed면 handoffRunner 미호출(stub)", async () => {
  const name = "_hc_run_fail";
  makeIdeaProject(name);
  const prevExit = process.exitCode;
  const prevFail = process.env.HARNESS_FAIL_AT;
  process.env.HARNESS_FAIL_AT = "pm"; // 강제 실패
  let called = 0;
  const spy = async () => {
    called++;
    return {};
  };
  try {
    await runRun("idea-validation", name, "mock", 1, false, undefined, false, 0, true, undefined, false, true, "/svc", spy);
    assert.equal(called, 0, "failed run은 handoff 미실행");
  } finally {
    if (prevFail === undefined) delete process.env.HARNESS_FAIL_AT;
    else process.env.HARNESS_FAIL_AT = prevFail;
    process.exitCode = prevExit;
    rmSync(projectPaths(name).root, { recursive: true, force: true });
  }
});
