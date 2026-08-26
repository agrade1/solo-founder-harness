/**
 * [B-41/1단] v1 안전 계약 3건:
 *  ① 내부 approval step이 있는 workflow는 **응답자 없이 시작하지 않는다**(`approval_approver_missing`,
 *     모델 호출 0회 · run_state 미생성).
 *  ② `stdinApprover`는 EOF/close/error에서 **정확히 한 번 false**로 끝난다(매달리지 않고, 나중 이벤트가
 *     이미 정해진 값을 뒤집지 않는다).
 *  ③ `seedFindings`는 **additive**다: 미지정이면 provider 입력이 **바이트 동일**(exact bytes 비교),
 *     지정하면 첫 프롬프트부터 실리고, 같은 agent가 실행되면 run 결과가 seed를 대체한다.
 *
 * oracle은 provider **호출 수 + 캡처한 입력 바이트**다(timestamp 아님 — `now`를 고정해 프롬프트를
 * 결정론으로 만든다). mock provider만 사용 — 실제 LLM 미호출(무과금).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { runWorkflow, loadRunState } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import { mockProvider } from "../providers/mockProvider.js";
import { buildPromptParts } from "../providers/promptParts.js";
import { stdinApprover } from "../commands/approver.js";
import type { Provider, AgentRunInput, AgentResult } from "../providers/provider.js";

const FIXED = "2026-01-01T00:00:00.000Z";

function makeProject(name: string, idea = "테스트"): void {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.docs, "00_IDEA.md"), `# idea\n\n## 아이디어 한 줄 정의\n\n- ${idea}\n`, "utf8");
}

function rmProject(name: string): void {
  rmSync(projectPaths(name).root, { recursive: true, force: true });
}

/**
 * counting provider — mock을 감싸 `generate` **호출 수**와 **입력 바이트**를 캡처한다.
 * prompts는 provider가 실제로 보게 되는 최종 user 프롬프트(buildPromptParts)의 바이트다:
 * priorFindings만 비교하면 "seed가 프롬프트에 실렸나"를 재지 못한다.
 */
function counting(): Provider & { calls: number; byAgent: Map<string, number>; prompts: string[]; findings: string[][] } {
  const p = {
    id: "mock",
    calls: 0,
    byAgent: new Map<string, number>(),
    prompts: [] as string[],
    findings: [] as string[][],
    async generate(input: AgentRunInput): Promise<AgentResult> {
      p.calls++;
      p.byAgent.set(input.agent.agent_id, (p.byAgent.get(input.agent.agent_id) ?? 0) + 1);
      p.prompts.push(buildPromptParts(input, "mock").user);
      p.findings.push([...input.priorFindings]);
      return mockProvider.generate(input);
    },
  };
  return p;
}

// ── ① approval fail closed ────────────────────────────────────
test("[B-41/1단] approval step이 있는 workflow는 approver 없이 시작하지 않는다 (모델 호출 0 · run_state 미생성)", async () => {
  const name = "_b41_apprmiss";
  makeProject(name);
  const p = counting();
  await assert.rejects(
    runWorkflow({ workflowId: "dev-preflight", project: name, provider: p, now: () => FIXED }),
    /approval_approver_missing/,
    "응답자 부재는 자동 승인이 아니다",
  );
  assert.equal(p.calls, 0, "첫 모델 호출 **전에** 거부한다 (과금 후 발견하지 않는다)");
  assert.equal(loadRunState(name), null, "run_state를 만들지 않는다");
  assert.equal(existsSync(join(projectPaths(name).outputs, "run_state.json")), false);

  // 대조군: 응답자를 넘기면 같은 workflow가 완주한다 (거부가 무조건이 아니다).
  const ok = counting();
  const r = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: ok, now: () => FIXED, approve: async () => true });
  assert.equal(r.state.status, "completed");
  assert.ok(ok.calls > 0, "대조군은 실제로 모델을 호출한다");
  rmProject(name);
});

test("[B-41/1단] approval step이 없는 workflow는 approver 없이도 그대로 돈다 (기존 계약 불변)", async () => {
  const name = "_b41_noappr";
  makeProject(name);
  const r = await runWorkflow({ workflowId: "idea-validation", project: name, provider: counting(), now: () => FIXED });
  assert.equal(r.state.status, "completed", "preflight가 승인 게이트 없는 workflow를 막지 않는다");
  rmProject(name);
});

test("[B-41/1단] 승인 거부는 여전히 user_rejected로 중단된다 (approver 계약 자체는 그대로)", async () => {
  const name = "_b41_reject";
  makeProject(name);
  const r = await runWorkflow({ workflowId: "dev-preflight", project: name, provider: counting(), now: () => FIXED, approve: async () => false });
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "user_rejected");
  rmProject(name);
});

// ── ② stdinApprover: 정확히 한 번 false ───────────────────────
/** 프롬프트 출력을 모으는 writable (프롬프트가 두 번 찍히지 않는지도 본다). */
function collector(): { out: Writable; chunks: string[] } {
  const chunks: string[] = [];
  return {
    chunks,
    out: new Writable({
      write(c, _e, cb) {
        chunks.push(String(c));
        cb();
      },
    }),
  };
}

test("[B-41/1단] stdinApprover: EOF(입력 없음)는 정확히 한 번 false — 매달리지 않는다", async () => {
  const c = collector();
  const answer = await stdinApprover("승인?", undefined, { input: Readable.from([]), output: c.out });
  assert.equal(answer, false, "EOF는 승인이 아니다");
  assert.equal(c.chunks.filter((s) => s.includes("[승인 필요]")).length, 1, "프롬프트는 한 번만 출력된다");
});

test("[B-41/1단] stdinApprover: 답을 받은 뒤 close가 와도 값이 뒤집히지 않는다 (첫 settle이 정본)", async () => {
  // "y" 다음에 stream이 닫힌다 → close 핸들러의 false가 이미 정해진 true를 덮어쓰면 이 단정이 red가 된다.
  assert.equal(await stdinApprover("승인?", undefined, { input: Readable.from(["y\n"]), output: collector().out }), true);
  assert.equal(await stdinApprover("승인?", undefined, { input: Readable.from(["yes\n"]), output: collector().out }), true);
  // y/yes만 승인 — 그 밖의 입력은 거부.
  for (const ans of ["n\n", "\n", "Y E S\n", "예\n"]) {
    assert.equal(await stdinApprover("승인?", undefined, { input: Readable.from([ans]), output: collector().out }), false, `'${ans.trim()}'는 승인이 아니다`);
  }
});

test("[B-41/1단] stdinApprover: stream error도 false로 끝난다 (예외로 새지 않는다)", async () => {
  const bad = new Readable({
    read() {
      this.destroy(new Error("boom"));
    },
  });
  assert.equal(await stdinApprover("승인?", undefined, { input: bad, output: collector().out }), false);
});

// ── ③ seedFindings additive ───────────────────────────────────
test("[B-41/1단] seedFindings 미지정 = provider 입력 바이트 동일 (exact bytes)", async () => {
  const a = "_b41_seed_base";
  const b = "_b41_seed_empty";
  makeProject(a, "같은 아이디어");
  makeProject(b, "같은 아이디어");
  const pa = counting();
  const pb = counting();
  await runWorkflow({ workflowId: "idea-validation", project: a, provider: pa, now: () => FIXED });
  // seedFindings 자리에 undefined를 **명시**해도 경로가 갈리지 않아야 한다.
  await runWorkflow({ workflowId: "idea-validation", project: b, provider: pb, now: () => FIXED, seedFindings: undefined });

  assert.equal(pa.calls, pb.calls, "호출 수 동일");
  // project 이름만 다르므로 그 토큰만 정규화해 바이트를 비교한다(그 외 한 글자도 달라지면 red).
  const norm = (s: string, name: string) => s.split(name).join("<P>");
  assert.deepEqual(
    pb.prompts.map((s) => norm(s, b)),
    pa.prompts.map((s) => norm(s, a)),
    "seed 미지정 실행 경로의 프롬프트가 바이트 동일하다",
  );
  assert.deepEqual(pb.findings, pa.findings, "priorFindings 체인도 동일");
  rmProject(a);
  rmProject(b);
});

test("[B-41/1단] seedFindings 지정 = 첫 프롬프트부터 실린다 · 같은 agent 실행 결과가 seed를 대체한다", async () => {
  const name = "_b41_seed_on";
  makeProject(name);
  const p = counting();
  const seed = "research: [SEED] 앞 단계에서 승인된 판단 한 줄";
  const r = await runWorkflow({
    workflowId: "idea-validation", // chief_of_staff → research → pm → red_team → founder_ceo
    project: name,
    provider: p,
    now: () => FIXED,
    seedFindings: [seed],
  });
  assert.equal(r.state.status, "completed");

  // 첫 step(chief_of_staff)은 이전 판단이 없던 자리인데 seed가 실린다.
  assert.deepEqual(p.findings[0], [seed], "첫 프롬프트의 priorFindings가 seed 하나");
  assert.ok(p.prompts[0].includes("[SEED] 앞 단계에서 승인된 판단 한 줄"), "프롬프트 본문에 실린다");
  assert.ok(!p.prompts[0].includes("첫 단계 — 이전 agent 판단 없음"), "seed가 있으면 '이전 판단 없음' 블록이 아니다");

  // research가 이 run에서 실행된 **뒤**의 프롬프트에는 seed 문장이 없다 — 최신 판단이 대체했다.
  const afterResearch = p.findings.at(-1)!;
  assert.equal(afterResearch.filter((f) => f.startsWith("research:")).length, 1, "research 항목은 하나뿐 (중복 누적 없음)");
  assert.ok(!afterResearch.some((f) => f.includes("[SEED]")), "run 결과가 seed를 대체한다 (최신 판단 규칙)");
  rmProject(name);
});
