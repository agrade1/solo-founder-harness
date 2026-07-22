/**
 * [M2.1] claude-code provider가 execContext.claudeArgs를 실제 spawn argv에 포함하고,
 * 오류 출력의 secret/credential을 redaction하는지 검증한다.
 * HARNESS_CLAUDE_BIN 스텁으로 실제 spawn 경로를 구동한다(실제 claude 미실행).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeProvider } from "./claudeCodeProvider.js";
import type { AgentRunInput, ProviderExecContext } from "./provider.js";

function baseInput(execContext?: ProviderExecContext): AgentRunInput {
  return {
    agent: { agent_id: "t", name: "T", role: "tester", prompt_path: "", default_output: "outputs/t.md" },
    workflowId: "w",
    project: "p",
    createdAt: "2026-01-01",
    commonPrompt: "common",
    agentPrompt: "agent",
    ideaContent: "",
    priorFindings: [],
    execContext,
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test("[M2.1] execContext.claudeArgs가 실제 spawn argv에 포함된다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-spawn-"));
  try {
    const argvOut = join(dir, "argv.txt");
    const stub = join(dir, "claude-stub.sh");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${argvOut}"\ncat >/dev/null\necho '{"result":"ok"}'\nexit 0\n`, "utf8");
    chmodSync(stub, 0o755);

    const claudeArgs = ["--strict-mcp-config", "--tools", "Read,Glob,Grep", "--permission-mode", "plan"];
    await withEnv({ HARNESS_CLAUDE_BIN: stub, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      const res = await claudeCodeProvider.generate(baseInput({ claudeArgs, redactNames: [] }));
      assert.equal(res.markdown, "ok");
    });

    const recorded = readFileSync(argvOut, "utf8");
    assert.match(recorded, /-p --output-format json/, "base argv 유지");
    assert.match(recorded, /--strict-mcp-config/);
    assert.match(recorded, /--tools Read,Glob,Grep/);
    assert.match(recorded, /--permission-mode plan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M2.1] execContext 없으면 base argv만 (회귀 없음)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-spawn-"));
  try {
    const argvOut = join(dir, "argv.txt");
    const stub = join(dir, "claude-stub.sh");
    writeFileSync(stub, `#!/bin/sh\necho "$@" > "${argvOut}"\ncat >/dev/null\necho '{"result":"ok"}'\nexit 0\n`, "utf8");
    chmodSync(stub, 0o755);

    await withEnv({ HARNESS_CLAUDE_BIN: stub, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      await claudeCodeProvider.generate(baseInput());
    });
    const recorded = readFileSync(argvOut, "utf8").trim();
    assert.equal(recorded, "-p --output-format json", "정책 인자 없음");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M2.1] stderr 비고 stdout에 secret인 non-zero 종료도 redaction (짧은 secret 포함)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-spawn-"));
  try {
    const stub = join(dir, "claude-stdout-fail.sh");
    // stderr는 비우고 stdout으로만 secret + token= 패턴 유출
    writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\necho "leak $MY_SECRET token=abcd1234efgh"\nexit 1\n`, "utf8");
    chmodSync(stub, 0o755);

    const secret = "Q7x"; // 3자 짧은 secret
    await withEnv({ HARNESS_CLAUDE_BIN: stub, MY_SECRET: secret, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      await assert.rejects(
        claudeCodeProvider.generate(baseInput({ claudeArgs: [], redactNames: ["MY_SECRET"] })),
        (e: Error) => {
          assert.ok(!e.message.includes(secret), "3자 secret 값이 오류에 없어야 함");
          assert.ok(!e.message.includes("abcd1234efgh"), "token= 값 redaction");
          assert.match(e.message, /종료코드 1/);
          return true;
        },
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[M2.1] spawn 자체 실패 error.message의 secret도 redaction", async () => {
  const secret = "SENTINELPATH";
  // 존재하지 않는 실행 파일 경로에 secret이 포함 → spawn ENOENT error.message에 노출
  const badBin = `/nonexistent-${secret}-dir/claude`;
  await withEnv({ HARNESS_CLAUDE_BIN: badBin, MY_SECRET: secret, HARNESS_CLAUDE_MODEL: undefined }, async () => {
    await assert.rejects(
      claudeCodeProvider.generate(baseInput({ claudeArgs: [], redactNames: ["MY_SECRET"] })),
      (e: Error) => {
        assert.ok(!e.message.includes(secret), "spawn 오류 경로의 secret이 없어야 함");
        assert.match(e.message, /claude 실행 실패/);
        return true;
      },
    );
  });
});

test("[M2.1] non-zero 종료 오류에서 secret 값·credential 패턴 redaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-spawn-"));
  try {
    const stub = join(dir, "claude-fail.sh");
    // stderr에 secret 값 + token= 패턴을 흘린다
    writeFileSync(
      stub,
      `#!/bin/sh\ncat >/dev/null\necho "boom $MY_SECRET and token=abcd1234efgh" >&2\nexit 1\n`,
      "utf8",
    );
    chmodSync(stub, 0o755);

    const secret = "sk-live-SENTINEL-XYZ";
    await withEnv({ HARNESS_CLAUDE_BIN: stub, MY_SECRET: secret, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      await assert.rejects(
        claudeCodeProvider.generate(baseInput({ claudeArgs: [], redactNames: ["MY_SECRET"] })),
        (e: Error) => {
          assert.ok(!e.message.includes(secret), "secret 값이 오류에 없어야 함");
          assert.ok(!e.message.includes("abcd1234efgh"), "token= 값이 redaction되어야 함");
          assert.match(e.message, /종료코드 1/);
          return true;
        },
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
