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

/**
 * [B-46] usage 파싱 회귀 감시. 이 provider의 usage 파싱을 단정하는 테스트가 **하나도 없었고**,
 * 그래서 캐시 입력 누락이 live 3 run 동안 보이지 않았다(input 16·26·36 vs output 61k~133k).
 * 아래 stub의 숫자는 2026-08-27 실제 `claude -p --output-format json` 응답 형태 그대로다.
 */
test("[B-46] usage는 캐시 입력 두 필드를 포함해 합산한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  try {
    const stub = join(dir, "claude-usage.sh");
    const payload = JSON.stringify({
      result: "ok",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 33178,
        cache_read_input_tokens: 1200,
        output_tokens: 3,
      },
    });
    writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${payload}\nJSON\n`, "utf8");
    chmodSync(stub, 0o755);

    await withEnv({ HARNESS_CLAUDE_BIN: stub, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      const res = await claudeCodeProvider.generate(baseInput());
      // red 조건: 합산에서 cache_creation/cache_read 중 하나라도 빠지면 2 또는 3202 또는 33180이 된다.
      assert.equal(res.usage?.inputTokens, 34380, "input + cache_creation + cache_read");
      assert.equal(res.usage?.outputTokens, 3);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[B-46] 캐시 필드가 없는 응답은 예전과 같이 input_tokens만 센다 (하위 호환)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  try {
    const stub = join(dir, "claude-usage-old.sh");
    const payload = JSON.stringify({ result: "ok", usage: { input_tokens: 40, output_tokens: 7 } });
    writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${payload}\nJSON\n`, "utf8");
    chmodSync(stub, 0o755);

    await withEnv({ HARNESS_CLAUDE_BIN: stub, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      const res = await claudeCodeProvider.generate(baseInput());
      assert.equal(res.usage?.inputTokens, 40);
      assert.equal(res.usage?.outputTokens, 7);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * [B-46] **whole-tree 회계.** 최상위 `usage`는 서브에이전트 토큰을 빼고 낸다 —
 * 2026-08-27 실측: 같은 호출에서 `usage` 입력 합 69,297 vs `modelUsage` 입력 합 91,036.
 * 아래 stub은 그 실측 응답의 형태·수치 그대로다.
 */
test("[B-46] modelUsage가 있으면 whole-tree 합계를 쓴다 (서브에이전트 토큰 포함)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  try {
    const stub = join(dir, "claude-modelusage.sh");
    const payload = JSON.stringify({
      result: "ok",
      usage: { input_tokens: 4, cache_creation_input_tokens: 12201, cache_read_input_tokens: 57092, output_tokens: 265 },
      modelUsage: {
        "claude-opus-5[1m]": { inputTokens: 6, cacheCreationInputTokens: 33938, cacheReadInputTokens: 57092, outputTokens: 269 },
      },
    });
    writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${payload}\nJSON\n`, "utf8");
    chmodSync(stub, 0o755);

    await withEnv({ HARNESS_CLAUDE_BIN: stub, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      const res = await claudeCodeProvider.generate(baseInput());
      // red 조건: usage로 강하하면 69,297이 나온다 — 서브에이전트 21,739 토큰이 예산에서 사라진다.
      assert.equal(res.usage?.inputTokens, 91036, "modelUsage 합(6+33938+57092)");
      assert.equal(res.usage?.outputTokens, 269);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[B-46] modelUsage에 모델이 여럿이면 전부 더한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-usage-"));
  try {
    const stub = join(dir, "claude-multimodel.sh");
    const payload = JSON.stringify({
      result: "ok",
      modelUsage: {
        "claude-opus-5[1m]": { inputTokens: 10, cacheReadInputTokens: 90, outputTokens: 5 },
        "claude-haiku-4-5": { inputTokens: 1, cacheCreationInputTokens: 9, outputTokens: 2 },
      },
    });
    writeFileSync(stub, `#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n${payload}\nJSON\n`, "utf8");
    chmodSync(stub, 0o755);

    await withEnv({ HARNESS_CLAUDE_BIN: stub, HARNESS_CLAUDE_MODEL: undefined }, async () => {
      const res = await claudeCodeProvider.generate(baseInput());
      // red 조건: 첫 모델만 읽으면 100/5가 된다.
      assert.equal(res.usage?.inputTokens, 110);
      assert.equal(res.usage?.outputTokens, 7);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
