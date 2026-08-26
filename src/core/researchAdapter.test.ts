/**
 * [C-126] 리서치 어댑터 production 배선 + `.env` 키 UX — 설계 §8 테스트 계획.
 *
 * **전부 fake backend · offline · 무과금**이다. 실제 Tavily 호출은 이 파일에 없다(오케스트레이터가
 * live 1회만 직접 한다). oracle은 셋:
 *  - **fake backend 호출 카운터** — "크레딧을 다시 쓰지 않았다"를 시각이 아니라 호출 수로 잰다.
 *  - **파일 exact bytes** — "결박됐다/손대지 않았다"는 사전·사후 바이트가 같다는 뜻이다.
 *  - **실제 자식 프로세스 spawn** — "자식 env에 키가 없다"를 코드 독해가 아니라 관측으로 잰다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENV_FILE_NAME,
  ensureEnvFileReady,
  ensureEnvTemplate,
  ensureGitignoreBlock,
  envFilePath,
  envGitState,
  resolveResearchKey,
} from "./envFile.js";
import {
  EVIDENCE_DIGEST_MAX_BYTES,
  EVIDENCE_DIGEST_RECIPIENTS,
  RESEARCH_ATTEMPT_LOG_REL,
  RESEARCH_DIR_REL,
  RESEARCH_FIRST_PASS_MAX_BYTES,
  RESEARCH_MAX_EVIDENCE_PER_RUN,
  RESEARCH_MAX_RESULTS_PER_CALL,
  RESEARCH_MAX_URL_CHARS,
  buildEvidenceDigest,
  createSessionBackend,
  parseResearchDeclaration,
  researchModeLines,
  researchOutcomeLines,
  resolveResearchRuntime,
  writeResearchReceipt,
  type ResearchAttempt,
  type ResearchRuntime,
} from "./researchRuntime.js";
import { runWorkflow, loadRunState, IDEA_REL, type RunState } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import { runStateSources, pipelineStatePath, readPipelineStateAt, type PipelineState } from "./pipeline.js";
import { buildSummary } from "./summary.js";
import { runResearch, MAX_BACKEND_CALLS_PER_RUN, type BackendResult, type ResearchBackend } from "../tools/researchGateway.js";
import { storeEvidence, EvidenceError } from "../tools/evidenceStore.js";
import { TAVILY_SECRET_REF, createTavilyBackend } from "../tools/tavilyBackend.js";
import { mockProvider } from "../providers/mockProvider.js";
import { buildPromptParts } from "../providers/promptParts.js";
import { approveCheckpoint, nextPipeline, rejectCheckpoint } from "../commands/pipeline.js";
import { runRun } from "../commands/run.js";
import type { AgentRunInput, AgentResult, Provider } from "../providers/provider.js";

const FIXED = "2026-01-01T00:00:00.000Z";
const HERE = dirname(fileURLToPath(import.meta.url));
const WF = join(HERE, "..", "..", "tests", "fixtures", "workflows", "research-adapter.json");
/** 테스트용 가짜 키. 이 문자열이 저장물·영수증·프롬프트에 남으면 redaction 실패다. */
const FAKE_KEY = "tvly-FAKEKEY-do-not-use-1234567890";

// ── 공용 fixture ─────────────────────────────────────────────────

function makeProject(name: string, idea = "리서치 어댑터 테스트"): string {
  const p = projectPaths(name);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.docs, { recursive: true });
  mkdirSync(p.outputs, { recursive: true });
  writeFileSync(join(p.root, IDEA_REL), `# idea\n\n## 아이디어 한 줄 정의\n\n- ${idea}\n`, "utf8");
  return p.root;
}

function rmProject(name: string): void {
  rmSync(projectPaths(name).root, { recursive: true, force: true });
}

interface FakeBackend extends ResearchBackend {
  calls: string[];
}

/**
 * fake backend. `per`는 query별 결과이고 `throwAfter`는 **n건 반환 후 throw**다
 * (partial 저장을 만드는 유일한 방법 — 저장이 성공한 뒤 다음 항목에서 죽는 형태).
 */
function fakeBackend(results: BackendResult[], opts: { throwOnCall?: number; results2?: BackendResult[] } = {}): FakeBackend {
  const b: FakeBackend = {
    calls: [],
    async search(query: string): Promise<BackendResult[]> {
      b.calls.push(query);
      if (opts.throwOnCall !== undefined && b.calls.length === opts.throwOnCall) {
        throw new Error("fake backend 네트워크 실패");
      }
      return b.calls.length === 2 && opts.results2 ? opts.results2 : results;
    },
    async extract(): Promise<BackendResult> {
      throw new Error("fake backend: extract는 불려서는 안 된다");
    },
  };
  return b;
}

function item(n: number, raw = `저장된 응답 ${n} 본문`): BackendResult {
  return { source: `https://ex${n}.example.com/a`, title: `제목 ${n}`, raw };
}

function externalRuntime(backend: ResearchBackend, key = FAKE_KEY): ResearchRuntime {
  // 실서비스의 `resolveResearchRuntime`과 같은 형태의 scrub — 해석된 키 값 정확 치환.
  return { kind: "external", backend, scrub: (s) => s.split(key).join("***") };
}

/**
 * mock을 감싼 test provider. 리서치 **1차**(revisionRequest에 1차 전문이 없는 호출)에서만
 * 선언 줄을 붙인다. `decl: null`이면 선언 자체를 붙이지 않는다(무선언 = missing 재는 fixture).
 */
function tap(
  opts: {
    decl?: string | null;
    secondFails?: boolean;
    firstPassPadBytes?: number;
    decisions?: string[]; // founder_ceo 판정 순서 (없으면 mock 기본 '진행')
  } = {},
): Provider & { inputs: AgentRunInput[]; byAgent: Map<string, number> } {
  const inputs: AgentRunInput[] = [];
  const byAgent = new Map<string, number>();
  let ceo = 0;
  const p = {
    id: "mock",
    inputs,
    byAgent,
    async generate(input: AgentRunInput): Promise<AgentResult> {
      inputs.push(input);
      byAgent.set(input.agent.agent_id, (byAgent.get(input.agent.agent_id) ?? 0) + 1);
      const r = await mockProvider.generate(input);
      let md = r.markdown;
      const isSecond = (input.revisionRequest ?? "").includes("1차 판단 전문 시작");
      if (input.agent.agent_id === "research" && !isSecond) {
        // **선언은 이 tap이 온전히 통제한다.** mock이 종결자(`RESEARCH_REQUEST none`)를 기본으로 내게
        // 된 뒤로는 먼저 **지우고** 나서 주입해야 한다 — 안 지우면 ⓐ `decl: null`이 "무선언"이 아니라
        // "명시적 none"을 시험하게 되고(무선언 vs none을 가르는 계약이 공허해진다) ⓑ 다른 fixture는
        // 선언이 **두 개**가 되어 파서가 보는 것이 의도와 달라진다.
        md = md.replace(/\nRESEARCH_REQUEST none\n/g, "\n");
        if (opts.decl !== null) md += `\n${opts.decl ?? 'RESEARCH_REQUEST query="시장 규모" | type=search'}\n`;
        if (opts.firstPassPadBytes) md += "\n" + "가".repeat(Math.ceil(opts.firstPassPadBytes / 3));
      }
      if (input.agent.agent_id === "research" && isSecond && opts.secondFails) {
        throw new Error("2차 provider 실패(주입)");
      }
      if (opts.decisions && input.agent.agent_id === "founder_ceo") {
        const d = opts.decisions[Math.min(ceo++, opts.decisions.length - 1)];
        md = md.replace("## Decision\n\n- 진행\n", `## Decision\n\n- ${d}\n`);
      }
      return { ...r, markdown: md };
    },
  };
  return p;
}

/**
 * console을 모아 문자열로 돌려준다. `process.exitCode`도 복원한다 — 명령들은 거부를 exitCode로도
 * 신호하고, 그것을 남기면 **테스트 전체가 실패한 것처럼** 보인다(개별 단정은 다 통과하는데
 * 파일 단위로 'test failed'가 뜬다 — 실제로 이 파일에서 그렇게 관측됐다).
 */
async function captureLogs(fn: () => Promise<unknown> | unknown): Promise<string> {
  const out: string[] = [];
  const push = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  const [log, err, warn] = [console.log, console.error, console.warn];
  const prevExit = process.exitCode;
  console.log = push;
  console.error = push;
  console.warn = push;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = err;
    console.warn = warn;
    process.exitCode = prevExit;
  }
  return out.join("\n");
}

/**
 * 사유 **코드**로 단정한다. 이 레포의 오류 클래스(`ResearchError`·`EvidenceError`·`TavilyError`)는
 * 코드를 `message`에 넣지 않으므로 정규식 단정은 산문을 재게 되고, 문구를 다듬는 순간 조용히 통과한다.
 */
async function rejectsCode(fn: () => Promise<unknown>, code: string, msg?: string): Promise<void> {
  await assert.rejects(fn, (e: unknown) => (e as { code?: string }).code === code, msg ?? `code=${code}를 기대했다`);
}
function throwsCode(fn: () => unknown, code: string, msg?: string): void {
  assert.throws(fn, (e: unknown) => (e as { code?: string }).code === code, msg ?? `code=${code}를 기대했다`);
}

async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.exitCode;
  let r!: T;
  await captureLogs(async () => {
    r = await fn();
  });
  process.exitCode = prev;
  return r;
}

/**
 * `.env`를 **하네스가 만드는 것과 같은 0600**으로 쓴다. 기본 mode(0644)로 쓰면 A-5의 권한 게이트가
 * 거부하는 것이 맞고(그것은 전용 테스트가 잰다), 다른 테스트의 fixture는 정상 파일이어야 한다.
 */
function writeEnv(root: string, body: string): void {
  writeFileSync(join(root, ENV_FILE_NAME), body, { encoding: "utf8", mode: 0o600 });
}

/** git repo 하나를 임시로 만든다 (추적/부정 규칙 판정은 실제 git에 물어야 한다). */
function tmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "c126-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function attemptsOf(state: RunState | null): ResearchAttempt[] {
  return state?.research?.attempts ?? [];
}

function receiptFiles(root: string): string[] {
  const dir = join(root, RESEARCH_DIR_REL);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("receipt-")) : [];
}

// ══ 1. `.env` 리더 · 템플릿 · git 안전 검사 ═══════════════════════

test("[C-126/E1] 템플릿은 0600으로 만들어지고, 이미 있으면 **한 글자도** 바꾸지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "c126-env-"));
  const first = ensureEnvTemplate(dir);
  assert.equal(first.created, true);
  assert.equal(first.path, join(dir, ENV_FILE_NAME));
  assert.equal(statSync(first.path).mode & 0o777, 0o600, ".env는 0600이다 (다른 사용자가 읽지 못한다)");
  const body = readFileSync(first.path, "utf8");
  assert.match(body, /TAVILY_API_KEY=$/m, "값이 빈 줄이 있어 사용자가 값만 채우면 된다");
  assert.match(body, /커밋하지 마라/);
  assert.match(body, /Tavily\(외부 서비스\)로 전송된다/, "검색어 외부 전송 고지가 있다 (B-2)");
  assert.match(body, /붙여넣지 마라/, "채팅에 값을 붙여넣지 말라는 경고가 있다");

  writeFileSync(first.path, "TAVILY_API_KEY=사용자가채운값\nOTHER=x\n", "utf8");
  const again = ensureEnvTemplate(dir);
  assert.equal(again.created, false);
  assert.equal(readFileSync(first.path, "utf8"), "TAVILY_API_KEY=사용자가채운값\nOTHER=x\n", "기존 내용 불변");
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E2] 리더는 **TAVILY_API_KEY 한 이름만** 읽는다 — 임의 변수는 값도 이름도 읽지 않고 개수만 센다", () => {
  const dir = tmpGitRepo();
  writeFileSync(join(dir, ".gitignore"), ".env\n", "utf8");
  writeEnv(
    dir,
    ["# 주석", "", "DATABASE_URL=postgres://user:pw@host/db", "STRIPE_SECRET_KEY=sk_live_XXXX", "TAVILY_API_KEY=k1", "TAVILY_API_KEY_OLD=k-old"].join("\n"),
  );
  const r = resolveResearchKey({ root: dir, env: {} });
  assert.equal(r.key, "k1", "대상 이름 하나만 읽는다");
  assert.equal(r.source, "env_file");
  assert.equal(r.skippedLines, 3, "비대상 3줄(DATABASE_URL·STRIPE·TAVILY_API_KEY_OLD)은 개수만 남는다");
  // 결과 객체 어디에도 다른 비밀의 값·이름이 없다 (직렬화 전수 검사).
  const dump = JSON.stringify(r);
  for (const leak of ["postgres://", "sk_live_XXXX", "DATABASE_URL", "STRIPE_SECRET_KEY", "k-old"]) {
    assert.ok(!dump.includes(leak), `리더 결과에 '${leak}'이 실렸다`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E3] BOM · 따옴표 한 쌍 · export 접두사 · 마지막 선언 우선 · 빈 값=키 없음", () => {
  const dir = tmpGitRepo();
  writeFileSync(join(dir, ".gitignore"), ".env\n", "utf8");
  const p = join(dir, ENV_FILE_NAME);
  const cases: Array<[string, string | null]> = [
    ["﻿TAVILY_API_KEY=k-bom\n", "k-bom"],
    ['TAVILY_API_KEY="k-quoted"\n', "k-quoted"],
    ["TAVILY_API_KEY='k-single'\n", "k-single"],
    ['TAVILY_API_KEY=""k-double""\n', '"k-double"'],
    ["export TAVILY_API_KEY=k-exported\n", "k-exported"],
    ["TAVILY_API_KEY=first\nTAVILY_API_KEY=last\n", "last"],
    ["TAVILY_API_KEY=\n", null],
    ["TAVILY_API_KEY=   \n", null],
    ["# TAVILY_API_KEY=commented\n", null],
    ["TAVILY_API_KEY=k#hash\n", "k#hash"], // 인라인 주석을 벗기지 않는다 — `#`은 값이다
  ];
  for (const [body, want] of cases) {
    writeEnv(dir, body);
    assert.equal(resolveResearchKey({ root: dir, env: {} }).key, want, `입력 ${JSON.stringify(body)}`);
  }
  void p;
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E4] 셸이 이긴다 · `process.env`를 **변경하지 않는다**", () => {
  const dir = tmpGitRepo();
  writeFileSync(join(dir, ".gitignore"), ".env\n", "utf8");
  writeEnv(dir, "TAVILY_API_KEY=from-file\n");
  const r = resolveResearchKey({ root: dir, env: { [TAVILY_SECRET_REF]: "from-shell" } });
  assert.equal(r.key, "from-shell");
  assert.equal(r.source, "shell");

  const before = process.env[TAVILY_SECRET_REF];
  resolveResearchKey({ root: dir, env: {} });
  resolveResearchRuntime({ root: dir, env: {} });
  assert.equal(process.env[TAVILY_SECRET_REF], before, "리더/런타임 판정이 process.env를 건드렸다");
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E5] **추적 중인 `.env`면 키를 읽지 않는다** — 회전·git rm --cached 안내 · history 정리 무주장", () => {
  const dir = tmpGitRepo();
  // 실측(mutation n2에서 발견): `git check-ignore`는 **추적 중인 경로를 ignore로 보고하지 않는다** —
  // gitignore가 tracked 파일에 효력이 없기 때문이다. 그래서 미ignore 검사만으로도 **거부 자체는**
  // 일어난다. 추적 검사가 하는 일은 두 가지이고 그것이 여기서 재는 것이다:
  //   ⓐ **진단이 맞다** (회전 + `git rm --cached` vs "gitignore 규칙을 확인하라" — 후자는 오답이다)
  //   ⓑ **쓸데없이 `.gitignore`를 건드리지 않는다** (추적 파일에 규칙을 더해도 아무 효과가 없다)
  writeFileSync(join(dir, ".gitignore"), "*.local\n", "utf8");
  const giBefore = readFileSync(join(dir, ".gitignore"), "utf8");
  writeEnv(dir, `TAVILY_API_KEY=${FAKE_KEY}\n`);
  execFileSync("git", ["add", "-f", ENV_FILE_NAME], { cwd: dir, stdio: "ignore" });

  const r = resolveResearchKey({ root: dir, env: {} });
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), giBefore, "추적 중인 .env에는 gitignore 규칙을 더하지 않는다 (효과가 없다)");
  assert.equal(r.key, null, "추적 중이면 키를 읽지 않는다");
  assert.equal(r.source, "refused");
  assert.equal(r.refusedCode, "env_file_tracked_by_git");
  const msg = r.notices.join("\n");
  assert.ok(!msg.includes(FAKE_KEY), "거부 안내에 키 값이 실렸다");
  assert.match(msg, /git rm --cached/);
  assert.match(msg, /폐기·재발급/);
  assert.match(msg, /git history를 정리하지 않습니다/, "history 정리를 주장하지 않는다");
  // runtime은 self로 강하하고 안내를 그대로 나른다.
  const rt = resolveResearchRuntime({ root: dir, env: {} });
  assert.equal(rt.kind, "self");
  assert.match(researchModeLines(rt).join("\n"), /추적 중/);
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E6] 부정 규칙(`!.env`) — managed block을 말미에 append해 다시 ignore되면 읽고, 그래도 아니면 거부", () => {
  // ⓐ 앞쪽 `!.env`: 말미 append가 이긴다(뒤 규칙 우선) → 재확인 통과 → 키를 읽는다.
  const a = tmpGitRepo();
  writeFileSync(join(a, ".gitignore"), "*.local\n!.env\n", "utf8");
  writeEnv(a, "TAVILY_API_KEY=k-neg\n");
  const ra = resolveResearchKey({ root: a, env: {} });
  assert.equal(ra.key, "k-neg", "말미 규칙이 앞쪽 부정 규칙을 이긴다");
  assert.match(readFileSync(join(a, ".gitignore"), "utf8"), /harness managed/, "managed block이 append됐다");
  assert.match(ra.notices.join("\n"), /\.gitignore에/);
  // 멱등: 다시 불러도 블록이 하나뿐이다.
  resolveResearchKey({ root: a, env: {} });
  const gi = readFileSync(join(a, ".gitignore"), "utf8");
  assert.equal(gi.match(/--- harness managed/g)?.length, 1, "managed block이 중복 append됐다");
  assert.equal(ensureGitignoreBlock(a), false, "이미 있으면 아무것도 쓰지 않는다");
  rmSync(a, { recursive: true, force: true });

  // ⓑ 우선순위가 더 높은 자리(하위 .gitignore는 없으니 `.git/info/exclude`보다 강한 하위 경로 규칙 대신
  //    같은 파일 **말미**에 부정 규칙)에 `!.env`가 있으면 append로도 못 이긴다 → **거부**(fail closed).
  const b = tmpGitRepo();
  writeEnv(b, "TAVILY_API_KEY=k-still\n");
  writeFileSync(join(b, ".gitignore"), ".env\n", "utf8");
  // managed block을 미리 넣고 그 **뒤에** 부정 규칙을 둔다 = append 지점보다 뒤 → 우선.
  ensureGitignoreBlock(b);
  appendFileSync(join(b, ".gitignore"), "!.env\n", "utf8");
  const rb = resolveResearchKey({ root: b, env: {} });
  assert.equal(rb.key, null, "여전히 ignore가 아니면 키를 읽지 않는다");
  assert.equal(rb.refusedCode, "env_file_not_ignored");
  assert.match(rb.notices.join("\n"), /git check-ignore -v/, "어느 규칙인지 확인하는 방법을 알려준다");
  rmSync(b, { recursive: true, force: true });
});

test("[C-126/E7] git repo가 아니면 검사를 건너뛰고 읽는다 (커밋 위험 자체가 없다)", () => {
  const dir = mkdtempSync(join(tmpdir(), "c126-nogit-"));
  writeEnv(dir, "TAVILY_API_KEY=k-nogit\n");
  assert.equal(resolveResearchKey({ root: dir, env: {} }).key, "k-nogit");
  assert.equal(existsSync(join(dir, ".gitignore")), false, "repo가 아니면 .gitignore를 만들지 않는다");
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E8] **자식 프로세스 env에 키가 없다** — 실제 spawn으로 관측한다", () => {
  const dir = tmpGitRepo();
  writeFileSync(join(dir, ".gitignore"), ".env\n", "utf8");
  writeEnv(dir, `TAVILY_API_KEY=${FAKE_KEY}\n`);
  const rt = resolveResearchRuntime({ root: dir, env: {} });
  assert.equal(rt.kind, "external", "키가 있으면 external이다");

  // claude-code/exec/mission/handoff 자식은 `{...process.env}`를 상속한다 — 그 관측을 그대로 한다.
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.env.TAVILY_API_KEY))"], {
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(child.status, 0);
  assert.ok(!child.stdout.includes(FAKE_KEY), `자식 env에 키가 실렸다: ${child.stdout}`);
  assert.equal(process.env[TAVILY_SECRET_REF] ?? "", "", "부모 env도 그대로다 (test:core가 빈 값으로 고정한다)");
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/E9] `createTavilyBackend`는 키를 **인자로** 받는다 (env 없이도 만들어진다)", () => {
  const saved = process.env[TAVILY_SECRET_REF];
  delete process.env[TAVILY_SECRET_REF];
  try {
    assert.ok(createTavilyBackend({ apiKey: FAKE_KEY }), "인자 키로 backend가 만들어진다");
    throwsCode(() => createTavilyBackend(), "secret_missing", "키가 아무 데도 없으면 호출 전에 fail closed");
  } finally {
    if (saved !== undefined) process.env[TAVILY_SECRET_REF] = saved;
  }
});

// ══ 2. 선언 파서 (종결자·malformed·extract 봉인) ═════════════════

test("[C-126/D1] `none` 종결자 · 무선언 · malformed · extract · 2건 초과가 **서로 다른 판정**이다", () => {
  assert.deepEqual(parseResearchDeclaration("본문\nRESEARCH_REQUEST none\n"), { kind: "none" });
  assert.deepEqual(parseResearchDeclaration("선언이 없는 문서"), { kind: "missing" });

  const q = (s: string) => `RESEARCH_REQUEST query="${s}" | type=search`;
  const ok = parseResearchDeclaration(`x\n${q("a")}\n${q("b")}\n`);
  assert.equal(ok.kind, "requests");
  assert.equal(ok.kind === "requests" ? ok.requests.length : 0, 2);

  assert.equal(parseResearchDeclaration(`${q("a")}\n${q("b")}\n${q("c")}\n`).kind, "invalid", "3건은 상한 초과");
  assert.equal(parseResearchDeclaration('RESEARCH_REQUEST query="a" | type=extract | urls=https://x.example.com/1').kind, "invalid", "extract는 봉인");
  assert.equal(parseResearchDeclaration("RESEARCH_REQUEST 아무말").kind, "invalid", "malformed");
  assert.equal(parseResearchDeclaration('RESEARCH_REQUEST query=a | type=search').kind, "invalid", "따옴표 없는 query");
  assert.equal(parseResearchDeclaration(`RESEARCH_REQUEST none\n${q("a")}`).kind, "invalid", "none과 선언 동시 = 판정 불가");

  const inv = parseResearchDeclaration('RESEARCH_REQUEST query="a" | type=extract | urls=https://x.example.com/1');
  assert.match(inv.kind === "invalid" ? inv.detail : "", /extract는 허용되지 않는다/, "사유가 도메인 문제로 적히지 않는다");
});

// ══ 3. sessionBackend — run 수명 예산 · memo · 상한 · redaction ══

test("[C-126/S1] run 누적 호출 상한은 **runResearch 1회가 아니라 run 전체**를 센다", async () => {
  const inner = fakeBackend([item(1)]);
  const s = createSessionBackend(inner, (x) => x);
  for (let i = 0; i < MAX_BACKEND_CALLS_PER_RUN; i++) await s.search(`q${i}`);
  assert.equal(s.calls, MAX_BACKEND_CALLS_PER_RUN);
  await rejectsCode(() => s.search("one-more"), "research_budget_exceeded");
  assert.equal(inner.calls.length, MAX_BACKEND_CALLS_PER_RUN, "상한 뒤에는 backend를 부르지 않았다 (크레딧 0)");
});

test("[C-126/S2] attempt 간 memo — 같은 질의는 backend를 다시 부르지 않는다 (재진입 무과금)", async () => {
  const inner = fakeBackend([item(1)]);
  const s = createSessionBackend(inner, (x) => x);
  await s.search("같은 질의");
  await s.search("같은 질의");
  assert.equal(inner.calls.length, 1, "두 번째는 memo 적중");
  assert.equal(s.memoHits, 1);
});

test("[C-126/S3] resume은 앞 attempt의 호출 수를 이어받는다 (예산이 리셋되지 않는다)", async () => {
  const inner = fakeBackend([item(1)]);
  const s = createSessionBackend(inner, (x) => x, { priorCalls: MAX_BACKEND_CALLS_PER_RUN });
  await rejectsCode(() => s.search("q"), "research_budget_exceeded");
  assert.equal(inner.calls.length, 0);
});

test("[C-126/S4] **backend가 키를 되돌려줘도 저장 전에 지워진다** (source·title·raw 전부)", async () => {
  const leaky = fakeBackend([
    { source: `https://ex.example.com/?key=${FAKE_KEY}`, title: `제목 ${FAKE_KEY}`, raw: `요청 echo: authorization Bearer ${FAKE_KEY}` },
  ]);
  const rt = externalRuntime(leaky);
  const s = createSessionBackend(leaky, rt.kind === "external" ? rt.scrub : (x) => x);
  const out = await s.search("q");
  const dump = JSON.stringify(out);
  assert.ok(!dump.includes(FAKE_KEY), `scrub 전 값이 남았다: ${dump}`);

  // 저장까지 통과시켜 **파일 바이트**에도 없는지 본다 (여기가 진짜 결박 지점이다).
  const dir = mkdtempSync(join(tmpdir(), "c126-ev-"));
  const res = await runResearch([{ type: "search", query: "q2" }], {
    backend: s,
    evidenceDir: dir,
    now: () => FIXED,
    allowedDomains: null,
  });
  for (const it of res.items) {
    assert.ok(!readFileSync(join(dir, it.rawPath), "utf8").includes(FAKE_KEY), "저장 파일에 키가 남았다");
  }
  assert.ok(!readFileSync(join(dir, "evidence.jsonl"), "utf8").includes(FAKE_KEY), "evidence 인덱스에 키가 남았다");
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/S5] 상한 fail closed — 긴 URL · 과다 결과 · run 총 evidence", async () => {
  const longUrl = fakeBackend([{ source: `https://x.example.com/${"a".repeat(RESEARCH_MAX_URL_CHARS)}`, title: "t", raw: "r" }]);
  await rejectsCode(() => createSessionBackend(longUrl, (x) => x).search("q"), "research_cap_exceeded", "긴 URL");

  const many = fakeBackend(Array.from({ length: RESEARCH_MAX_RESULTS_PER_CALL + 1 }, (_, i) => item(i)));
  await rejectsCode(() => createSessionBackend(many, (x) => x).search("q"), "research_cap_exceeded", "과다 결과");

  const s = createSessionBackend(fakeBackend(Array.from({ length: 5 }, (_, i) => item(i))), (x) => x);
  await s.search("a");
  await s.search("b");
  assert.equal(s.results, 10);
  await rejectsCode(() => s.search("c"), "research_cap_exceeded", `run 총 evidence 상한 ${RESEARCH_MAX_EVIDENCE_PER_RUN}건`);
});

test("[C-126/S6] extract는 sessionBackend에서도 봉인이다 (도달 불가 경로도 열어두지 않는다)", async () => {
  const s = createSessionBackend(fakeBackend([item(1)]), (x) => x);
  await assert.rejects(() => s.extract("https://x.example.com/1"), /extract는 봉인/);
});

// ══ 4. gateway `onStored` · evidenceStore EEXIST ════════════════

test("[C-126/G1] `onStored` 미지정이면 gateway 결과가 **바이트 동일**이고, 지정하면 저장마다 1회 관찰된다", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "c126-gwA-"));
  const dirB = mkdtempSync(join(tmpdir(), "c126-gwB-"));
  const req = [{ type: "search" as const, query: "q" }];
  const a = await runResearch(req, { backend: fakeBackend([item(1), item(2)]), evidenceDir: dirA, now: () => FIXED, allowedDomains: null });
  const seen: Array<[string, string]> = [];
  const b = await runResearch(req, {
    backend: fakeBackend([item(1), item(2)]),
    evidenceDir: dirB,
    now: () => FIXED,
    allowedDomains: null,
    onStored: (it, rel) => void seen.push([it.sha256, rel]),
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "onStored 유무가 결과를 바꾸지 않는다");
  assert.equal(readFileSync(join(dirA, "evidence.jsonl"), "utf8"), readFileSync(join(dirB, "evidence.jsonl"), "utf8"));
  assert.equal(seen.length, 2, "저장 2건 = 관찰 2건");
  assert.deepEqual(
    seen.map(([, rel]) => rel),
    b.items.map((i) => i.rawPath),
    "relPath는 evidenceDir 기준 상대경로(= item.rawPath)다",
  );
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("[C-126/G2] **중간 partial 실패**: 1건 저장 후 throw → 그 1건은 collector에 남는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c126-gwP-"));
  // 첫 호출은 성공(1건 저장), 두 번째 호출에서 throw → 두 선언 중 앞의 것만 저장돼 있다.
  const backend = fakeBackend([item(1)], { throwOnCall: 2 });
  const seen: string[] = [];
  await assert.rejects(
    () =>
      runResearch(
        [
          { type: "search", query: "q1" },
          { type: "search", query: "q2" },
        ],
        { backend, evidenceDir: dir, now: () => FIXED, allowedDomains: null, onStored: (_i, rel) => void seen.push(rel) },
      ),
    /네트워크 실패/,
  );
  assert.equal(seen.length, 1, "저장에 성공한 1건은 collector에 남는다 (지역 변수와 함께 사라지지 않는다)");
  assert.ok(existsSync(join(dir, seen[0])), "그 파일은 실물로 있다");
  rmSync(dir, { recursive: true, force: true });
});

test("[C-126/G3] content-addressed 경로에 **다른 바이트**가 있으면 저장을 거부한다 (EEXIST 재검증)", () => {
  const dir = mkdtempSync(join(tmpdir(), "c126-ee-"));
  const input = { source: "https://x.example.com/a", retrievedAt: FIXED, raw: "원래 바이트", title: "t", summary: "s" };
  const first = storeEvidence(dir, input);
  // 같은 입력 재저장은 통과한다 (내용이 곧 신원 — 정상 경로).
  assert.equal(storeEvidence(dir, input).sha256, first.sha256);
  // 그 자리를 남의 바이트로 바꾸면 거부다.
  writeFileSync(join(dir, first.rawPath), "남의 바이트", "utf8");
  assert.throws(() => storeEvidence(dir, input), (e: unknown) => e instanceof EvidenceError && e.code === "evidence_hash_mismatch");
  rmSync(dir, { recursive: true, force: true });
});

// ══ 5. 예산 (§6.3 · byte 단위) ═══════════════════════════════════

test("[C-126/B1] digest 예산은 **byte**로 집행되고 초과는 자르지 않고 실패다 (다국어 fixture)", () => {
  const mk = (n: number) => ({
    source: "https://x.example.com/a",
    sha256: "0".repeat(64),
    retrievedAt: FIXED,
    bytes: n,
    rawPath: "raw/0.txt",
    title: "제목",
    summary: "가".repeat(n), // UTF-8 3byte 문자 — chars로 재면 상한을 통과해 버린다
  });
  const under = buildEvidenceDigest([mk(1000)]);
  assert.equal(under.ok, true);
  assert.ok(under.ok && under.bytes <= EVIDENCE_DIGEST_MAX_BYTES);

  // 3byte 문자 6000개 = 18,000B > 16,384B 이지만 **코드포인트로는 6000**이다 (chars 기준이면 통과한다).
  const over = buildEvidenceDigest([mk(6000)]);
  assert.equal(over.ok, false, "byte 기준으로 초과를 잡아야 한다");
  assert.ok(!over.ok && over.bytes > EVIDENCE_DIGEST_MAX_BYTES && over.limit === EVIDENCE_DIGEST_MAX_BYTES);
});

test("[C-126/B2] 1차 전문 32,768B 초과는 `research_first_pass_too_large`로 fail closed (절단 없음)", async () => {
  const name = "_c126_b2";
  makeProject(name);
  const backend = fakeBackend([item(1)]);
  const p = tap({ firstPassPadBytes: RESEARCH_FIRST_PASS_MAX_BYTES + 3_000 });
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: name, provider: p, workflowsPath: WF, now: () => FIXED, research: externalRuntime(backend) }),
  );
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "research_first_pass_too_large");
  assert.equal(r.state.failed_agent, "research");
  assert.equal(p.byAgent.get("research"), 1, "2차는 호출되지 않았다 (예산 초과는 호출 전에 판정)");
  assert.equal(existsSync(join(projectPaths(name).root, "docs/01_RESEARCH.md")), false, "실패면 문서를 저장하지 않는다");
  const at = attemptsOf(r.state).at(-1)!;
  assert.equal(at.mode, null);
  assert.equal(at.error_code, "research_first_pass_too_large");
  assert.ok(at.evidence.length >= 1, "검색은 이미 됐고 그 사실은 영수증에 남는다");
  rmProject(name);
});

test("[C-126/B3] digest 예산 초과는 `research_budget_exceeded` — 조용히 자르지 않는다", async () => {
  const name = "_c126_b3";
  makeProject(name);
  // 3byte 문자로 채운 큰 응답 2건 → digest 총량이 16,384B를 넘는다.
  const big = "가".repeat(8_000);
  const backend = fakeBackend([item(1, big), item(2, big)]);
  const p = tap();
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: name, provider: p, workflowsPath: WF, now: () => FIXED, research: externalRuntime(backend) }),
  );
  // MAX_SUMMARY_CHARS/MAX_EXCERPT_CHARS가 항목을 이미 줄이므로, 이 fixture가 실제로 예산을 넘는지
  // **먼저 확인**한다 — 넘지 않으면 이 테스트는 아무것도 재지 않는다(그런 테스트는 함정이다).
  const at = attemptsOf(r.state).at(-1)!;
  const d = buildEvidenceDigest(at.evidence);
  if (d.ok) {
    assert.equal(r.state.status, "completed", "예산 안이면 정상 완주가 맞다");
  } else {
    assert.equal(r.state.failed_reason, "research_budget_exceeded");
    assert.equal(p.byAgent.get("research"), 1, "2차 호출 없음");
  }
  rmProject(name);
});

// ══ 6. 모드 4종 · 영수증 · receipt ══════════════════════════════

test("[C-126/M1] 모드 4종이 갈린다: self · external_declined · external_empty · external", async () => {
  // ⓐ self — 키 부재(research 인자 미지정): 외부 호출 0회 · LLM 1회
  const a = "_c126_m1a";
  makeProject(a);
  const pa = tap({ decl: null });
  const ra = await quiet(() => runWorkflow({ workflowId: "research-only", project: a, provider: pa, workflowsPath: WF, now: () => FIXED }));
  assert.equal(ra.state.status, "completed");
  assert.equal(pa.byAgent.get("research"), 1, "self는 LLM 1회");
  assert.equal(attemptsOf(ra.state).at(-1)!.mode, "self");
  assert.ok(!pa.inputs.some((i) => i.researchRequest), "키가 없으면 선언 지시를 프롬프트에 넣지 않는다");
  rmProject(a);

  // ⓑ external_declined — 모델이 `none` 선언
  const b = "_c126_m1b";
  makeProject(b);
  const bk = fakeBackend([item(1)]);
  const pb = tap({ decl: "RESEARCH_REQUEST none" });
  const rb = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: b, provider: pb, workflowsPath: WF, now: () => FIXED, research: externalRuntime(bk) }),
  );
  assert.equal(rb.state.status, "completed");
  assert.equal(attemptsOf(rb.state).at(-1)!.mode, "external_declined");
  assert.equal(bk.calls.length, 0, "declined면 backend를 부르지 않는다 (크레딧 0)");
  assert.equal(pb.byAgent.get("research"), 1, "1차가 곧 최종본");
  assert.ok(pb.inputs.some((i) => i.researchRequest?.includes("RESEARCH_REQUEST none")), "1차에 종결자 지시가 실렸다");
  rmProject(b);

  // ⓒ external_empty — API 정상 · 결과 0
  const c = "_c126_m1c";
  makeProject(c);
  const ck = fakeBackend([]);
  const pc = tap();
  const rc = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: c, provider: pc, workflowsPath: WF, now: () => FIXED, research: externalRuntime(ck) }),
  );
  assert.equal(rc.state.status, "completed");
  assert.equal(attemptsOf(rc.state).at(-1)!.mode, "external_empty");
  assert.equal(ck.calls.length, 1, "불렀고 결과가 0이었다");
  assert.equal(pc.byAgent.get("research"), 1, "결과 0이면 2차를 태우지 않는다");
  rmProject(c);

  // ⓓ external — evidence ≥1 · 2차 완료
  const d = "_c126_m1d";
  makeProject(d);
  const dk = fakeBackend([item(1), item(2)]);
  const pd = tap();
  const rd = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: d, provider: pd, workflowsPath: WF, now: () => FIXED, research: externalRuntime(dk) }),
  );
  assert.equal(rd.state.status, "completed");
  const at = attemptsOf(rd.state).at(-1)!;
  assert.equal(at.mode, "external");
  assert.equal(at.evidence.length, 2);
  assert.equal(at.backend_calls, 1);
  assert.equal(pd.byAgent.get("research"), 2, "external은 LLM 정확히 2회");
  const second = pd.inputs.filter((i) => i.agent.agent_id === "research").at(-1)!;
  assert.ok(second.evidenceDigest?.includes("EVIDENCE_DATA"), "2차에 fence digest가 실렸다");
  assert.ok(second.revisionRequest?.includes("1차 판단 전문 시작"), "2차에 1차 전문이 실렸다");
  assert.ok(second.revisionRequest?.includes(at.first_pass_sha256!), "2차에 1차 sha256이 실렸다");
  rmProject(d);
});

test("[C-126/M2] receipt는 **write-once·content-addressed**이고 attempt와 raw를 함께 적는다", async () => {
  const name = "_c126_m2";
  const root = makeProject(name);
  const dk = fakeBackend([item(1)]);
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: name, provider: tap(), workflowsPath: WF, now: () => FIXED, research: externalRuntime(dk) }),
  );
  const at = attemptsOf(r.state).at(-1)!;
  assert.match(at.receipt_path, /^outputs\/research\/receipt-[0-9a-f]{64}\.json$/);
  const body = JSON.parse(readFileSync(join(root, at.receipt_path), "utf8")) as ResearchAttempt;
  assert.equal(body.mode, "external");
  assert.equal(body.evidence.length, 1);
  assert.deepEqual(body.raw_paths, at.raw_paths);
  assert.ok(at.raw_paths.every((p) => existsSync(join(root, p))), "결박 대상 raw가 실물로 있다");
  assert.equal(receiptFiles(root).length, 1);

  // 같은 내용을 다시 쓰면 같은 경로가 나오고 파일이 늘지 않는다(멱등). 남의 바이트면 거부다.
  assert.equal(writeResearchReceipt(root, body), at.receipt_path);
  assert.equal(receiptFiles(root).length, 1);
  writeFileSync(join(root, at.receipt_path), "남의 바이트", "utf8");
  throwsCode(() => writeResearchReceipt(root, body), "research_receipt_hash_mismatch");
  rmProject(name);
});

test("[C-126/M3] 영수증 query는 redact 후 상한까지만 남는다 (키가 검색어에 섞여도 파일에 남지 않는다)", async () => {
  const name = "_c126_m3";
  makeProject(name);
  const dk = fakeBackend([item(1)]);
  const p = tap({ decl: `RESEARCH_REQUEST query="비밀 ${FAKE_KEY} 시장" | type=search` });
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: name, provider: p, workflowsPath: WF, now: () => FIXED, research: externalRuntime(dk) }),
  );
  const at = attemptsOf(r.state).at(-1)!;
  assert.equal(at.requests.length, 1);
  assert.ok(!at.requests[0].redacted_query.includes(FAKE_KEY), "영수증 query에 키가 남았다");
  assert.match(at.requests[0].redacted_query, /\*\*\*/);
  const receipt = readFileSync(join(projectPaths(name).root, at.receipt_path), "utf8");
  assert.ok(!receipt.includes(FAKE_KEY), "receipt 파일에 키가 남았다");
  rmProject(name);
});

test("[C-126/M4] 실패 사유 코드가 원인별로 갈린다 (missing · invalid · backend_error)", async () => {
  const cases: Array<[string, ReturnType<typeof tap> | null, string]> = [
    ["_c126_m4a", tap({ decl: null }), "research_declaration_missing"],
    ["_c126_m4b", tap({ decl: "RESEARCH_REQUEST 엉터리" }), "research_declaration_invalid"],
  ];
  for (const [name, p, want] of cases) {
    makeProject(name);
    const r = await quiet(() =>
      runWorkflow({
        workflowId: "research-only",
        project: name,
        provider: p!,
        workflowsPath: WF,
        now: () => FIXED,
        research: externalRuntime(fakeBackend([item(1)])),
      }),
    );
    assert.equal(r.state.status, "failed", name);
    assert.equal(r.state.failed_reason, want, name);
    assert.equal(r.state.resume_from, 0, "resumable failed다 (재개 지점이 있다)");
    assert.equal(attemptsOf(r.state).at(-1)!.error_code, want);
    assert.equal(existsSync(join(projectPaths(name).root, "docs/01_RESEARCH.md")), false, "미저장");
    rmProject(name);
  }

  // backend 실패 = resumable failed. **self로 조용히 강하하지 않는다**(설계 §10 미결정 항목).
  const name = "_c126_m4c";
  makeProject(name);
  const r = await quiet(() =>
    runWorkflow({
      workflowId: "research-only",
      project: name,
      provider: tap(),
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(fakeBackend([item(1)], { throwOnCall: 1 })),
    }),
  );
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "research_backend_error");
  assert.notEqual(attemptsOf(r.state).at(-1)!.mode, "self", "외부 실패를 self로 접지 않는다");
  rmProject(name);
});

// ══ 7. A-2 telemetry — 1차 비용이 사라지지 않는다 ═══════════════

test("[C-126/A2] 2차가 죽어도 **1차 usage가 run_state에 남는다** (비용 영수증)", async () => {
  const name = "_c126_a2";
  makeProject(name);
  // usage를 실제로 채우는 provider (mock은 usage를 내지 않는다 — 비용 단정을 재려면 필요하다).
  const base = tap({ secondFails: true });
  const metered: Provider = {
    id: "mock",
    async generate(input) {
      const r = await base.generate(input);
      return { ...r, usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  const r = await quiet(() =>
    runWorkflow({
      workflowId: "research-only",
      project: name,
      provider: metered,
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.usage.input_tokens, 100, "1차 input 비용이 남았다");
  assert.equal(r.state.usage.output_tokens, 20, "1차 output 비용이 남았다");
  assert.deepEqual(r.state.usage.per_agent.map((u) => u.agent_id), ["research"]);
  assert.equal(existsSync(join(projectPaths(name).root, "docs/01_RESEARCH.md")), false, "미저장(2차가 죽었다)");
  assert.equal(attemptsOf(r.state).at(-1)!.error_code, "research_second_pass_failed", "2차 실패도 영수증에 남는다");
  rmProject(name);
});

test("[C-126/A2b] `--max-tokens`가 1차 비용을 센다 (미저장 호출도 예산에 잡힌다)", async () => {
  const name = "_c126_a2b";
  makeProject(name);
  const base = tap();
  const metered: Provider = {
    id: "mock",
    async generate(input) {
      const r = await base.generate(input);
      return { ...r, usage: { inputTokens: 500, outputTokens: 500 } };
    },
  };
  // research(1차 1000 + 2차 1000) 뒤 pm 앞에서 예산이 끊긴다 — 1차를 세지 않으면 pm이 돌아버린다.
  const r = await quiet(() =>
    runWorkflow({
      workflowId: "research-then-pm",
      project: name,
      provider: metered,
      workflowsPath: WF,
      now: () => FIXED,
      maxTokens: 1500,
      research: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "token_budget_exceeded");
  assert.equal(base.byAgent.get("pm") ?? 0, 0, "1차 비용이 예산에 잡혀 다음 step이 돌지 않았다");
  assert.equal(r.state.usage.input_tokens + r.state.usage.output_tokens, 2000, "1차+2차 둘 다 계상");
  rmProject(name);
});

// ══ 8. digest 수신자 allowlist · 소거 · critic 미주입 ════════════

test("[C-126/R1] digest는 수신자 allowlist에만 실린다 (비수신자·critic 제외)", async () => {
  const name = "_c126_r1";
  makeProject(name);
  const p = tap();
  await quiet(() =>
    runWorkflow({
      workflowId: "research-then-pm",
      project: name,
      provider: p,
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  const calls = (id: string) => p.inputs.filter((i) => i.agent.agent_id === id).length;
  const got = (id: string) => p.inputs.filter((i) => i.agent.agent_id === id && i.evidenceDigest).length;
  assert.ok(EVIDENCE_DIGEST_RECIPIENTS.includes("pm"));
  assert.ok(calls("pm") >= 1 && got("pm") === calls("pm"), `수신자(pm)의 **모든** 호출에 digest가 갔다 (호출 ${calls("pm")} · digest ${got("pm")})`);
  assert.ok(calls("ux_ui") >= 1, "비수신자도 실제로 돌았다 (0회면 아무것도 재지 않는다)");
  assert.equal(got("ux_ui"), 0, "비수신자(ux_ui)에게는 가지 않았다");
  rmProject(name);
});

test("[C-126/R2] critic(conclusion_only)에는 digest를 주지 않는다 — 편향 분리가 깨지지 않는다", async () => {
  const name = "_c126_r2";
  makeProject(name);
  const p = tap();
  await quiet(() =>
    runWorkflow({
      workflowId: "research-critic",
      project: name,
      provider: p,
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  const critic = p.inputs.filter((i) => i.agent.agent_id === "red_team");
  assert.ok(critic.length >= 1, "critic이 실제로 돌았다");
  assert.ok(EVIDENCE_DIGEST_RECIPIENTS.includes("red_team"), "red_team은 allowlist에 있다 (그래도 critic 자리에서는 제외)");
  assert.ok(critic.every((i) => i.contextMode === "conclusion_only" && !i.evidenceDigest), "critic에 digest가 실렸다");
  rmProject(name);
});

test("[C-126/R3] 게이트 재진입: 새 attempt가 시작되면 앞 digest가 **소거**되고 memo로 크레딧을 다시 쓰지 않는다", async () => {
  const name = "_c126_r3";
  makeProject(name);
  const bk = fakeBackend([item(1)]);
  const p = tap({ decisions: ["검증", "진행"] });
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-gate", project: name, provider: p, workflowsPath: WF, now: () => FIXED, research: externalRuntime(bk) }),
  );
  assert.equal(r.state.status, "completed");
  assert.equal(attemptsOf(r.state).length, 2, "리서치가 두 번 돌았다 (게이트 되돌림)");
  assert.equal(bk.calls.length, 1, "같은 질의는 memo 적중 — backend를 다시 부르지 않았다");
  assert.equal(attemptsOf(r.state)[1].cache_hits, 1);
  assert.equal(attemptsOf(r.state)[1].backend_calls, 0);
  // 두 attempt 모두 evidence를 갖고, 두 번째 1차 프롬프트에는 digest가 없다(소거 확인).
  const researchInputs = p.inputs.filter((i) => i.agent.agent_id === "research");
  assert.ok(researchInputs.length >= 4, `1차·2차 × 2회 = 4회 이상 (실제 ${researchInputs.length})`);
  assert.ok(!researchInputs[2].evidenceDigest, "재진입 1차에 앞 attempt의 digest가 남아 있었다");
  rmProject(name);
});

// ══ 9. A-4 partial · resume exact binding ═══════════════════════

test("[C-126/A4] partial 저장이 attempt·savedFiles에 사실대로 남는다", async () => {
  const name = "_c126_a4";
  const root = makeProject(name);
  const bk = fakeBackend([item(1)], { throwOnCall: 2 });
  const p = tap({ decl: 'RESEARCH_REQUEST query="q1" | type=search\nRESEARCH_REQUEST query="q2" | type=search' });
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: name, provider: p, workflowsPath: WF, now: () => FIXED, research: externalRuntime(bk) }),
  );
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "research_backend_error");
  const at = attemptsOf(r.state).at(-1)!;
  assert.equal(at.evidence.length, 1, "첫 질의의 저장 1건이 남았다 (partial 사실 계수)");
  assert.equal(at.backend_calls, 2, "두 번 불렀고 두 번째가 죽었다");
  // savedFiles에 raw + receipt가 있다 → last_failure.written에 잡힌다(A-4의 요점).
  assert.ok(r.savedFiles.includes(at.raw_paths[0]), `savedFiles에 raw가 없다: ${r.savedFiles.join(", ")}`);
  assert.ok(r.savedFiles.includes(at.receipt_path), "savedFiles에 receipt가 없다");
  assert.ok(existsSync(join(root, at.raw_paths[0])) && existsSync(join(root, at.receipt_path)));
  rmProject(name);
});

test("[C-126/A9] resume digest는 **마지막 성공 attempt의 evidence snapshot**에서만 온다 (시각 창 아님)", async () => {
  const name = "_c126_a9";
  makeProject(name);
  // 1) external 성공 → completed. 2) 그 run_state를 failed로 바꿔 resume 진입점을 만든다.
  const bk = fakeBackend([item(1)]);
  await quiet(() =>
    runWorkflow({
      workflowId: "research-then-pm",
      project: name,
      provider: tap(),
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(bk),
    }),
  );
  const root = projectPaths(name).root;
  const st = JSON.parse(readFileSync(join(root, "outputs/run_state.json"), "utf8")) as RunState;
  assert.equal(attemptsOf(st).at(-1)!.mode, "external");
  const okAttempt = attemptsOf(st).at(-1)!;
  // pm 앞에서 죽은 것처럼 만든다 (research는 완료 · resume_from=1).
  st.status = "failed";
  st.resume_from = 1;
  st.completed_steps = ["research"];
  // **판별용 오염 두 개.** 복원이 attempt에 결박돼 있지 않으면 아래 둘 중 하나가 반드시 섞인다:
  //  ⓐ `evidence.jsonl`에 붙은 남의 줄 — 시각 창/인덱스 병합 복원이면 이것을 먹는다(jsonl은 비권위다).
  //  ⓑ **실패 attempt의 partial evidence** — "마지막 성공"이 아니라 "마지막"을 고르면 이것을 먹는다.
  const FOREIGN = "f".repeat(64);
  const partial = {
    source: "https://foreign.example.com/x",
    sha256: FOREIGN,
    retrievedAt: FIXED,
    bytes: 1,
    rawPath: `raw/${FOREIGN}.txt`,
    title: "실패 attempt의 partial",
    summary: "이 근거는 채택된 적이 없다",
  };
  appendFileSync(join(root, RESEARCH_DIR_REL, "evidence.jsonl"), JSON.stringify(partial) + "\n", "utf8");
  st.research!.attempts.push({
    started_at: FIXED,
    mode: null,
    error_code: "research_backend_error",
    requests: [],
    backend_calls: 1,
    cache_hits: 0,
    dropped_by_domain: 0,
    first_pass_sha256: null,
    evidence: [partial],
    receipt_path: "outputs/research/receipt-failed.json",
    raw_paths: [],
  });
  writeFileSync(join(root, "outputs/run_state.json"), JSON.stringify(st, null, 2) + "\n", "utf8");

  // resume: research는 재실행되지 않고, pm은 **저장된 attempt의 evidence**로 만든 digest를 받는다.
  const p2 = tap();
  const r2 = await quiet(() =>
    runWorkflow({
      workflowId: "research-then-pm",
      project: name,
      provider: p2,
      workflowsPath: WF,
      now: () => FIXED,
      resume: true,
      research: externalRuntime(fakeBackend([item(99, "다른 응답")])),
    }),
  );
  assert.equal(r2.state.status, "completed");
  assert.equal(p2.byAgent.get("research") ?? 0, 0, "완료 step은 재실행되지 않았다");
  const pmInput = p2.inputs.find((i) => i.agent.agent_id === "pm")!;
  assert.ok(pmInput.evidenceDigest, "resume 후에도 pm이 근거를 받았다");
  assert.ok(pmInput.evidenceDigest!.includes(okAttempt.evidence[0].sha256), "복원된 digest는 저장된 attempt의 sha256을 담는다");
  assert.ok(!pmInput.evidenceDigest!.includes("다른 응답"), "새 backend 응답이 섞이지 않았다 (재검색 없음)");
  assert.ok(!pmInput.evidenceDigest!.includes(FOREIGN), "비권위 인덱스(evidence.jsonl)나 **실패 attempt의 partial**이 섞였다");
  // attempts는 carry-forward된다 (앞 run의 영수증이 지워지지 않는다).
  assert.ok(attemptsOf(r2.state).some((a) => a.receipt_path === okAttempt.receipt_path), "앞 attempt가 carry-forward됐다");
  rmProject(name);
});

// ══ 10. A-1 두 경로 동등 · A-3 checkpoint 결박 (파이프라인) ══════

/** 파이프라인 1단계를 external runtime으로 확인 대기까지 진행한다. */
async function pipelineToCheckpoint(name: string, bk: FakeBackend): Promise<PipelineState> {
  makeProject(name);
  const r = await quiet(() =>
    nextPipeline({
      project: name,
      providerOverride: tap(),
      now: () => FIXED,
      researchRuntimeOverride: externalRuntime(bk),
    }),
  );
  assert.equal(r.code, "pipeline_awaiting_approval", `1단계가 확인 대기로 가야 한다 (실제 ${r.code})`);
  const read = readPipelineStateAt(pipelineStatePath(projectPaths(name).root));
  assert.equal(read.kind, "ok");
  return (read as { kind: "ok"; state: PipelineState }).state;
}

test("[C-126/A1] **`pipeline next`에서도 backend가 실제로 주입된다** — 1단계가 self로 떨어지지 않는다", async () => {
  const name = "_c126_a1";
  const bk = fakeBackend([item(1)]);
  const state = await pipelineToCheckpoint(name, bk);
  const rs = loadRunState(name)!;
  const at = attemptsOf(rs).at(-1)!;
  assert.equal(at.mode, "external", "파이프라인 경로에서 external로 완주했다 (self가 아니다)");
  assert.equal(bk.calls.length, 1, "파이프라인 경로에서 backend가 실제로 불렸다");

  // checkpoint artifacts에 receipt + raw가 들어 있다 (A-3 결박).
  const paths = state.pending!.artifacts.map((a) => a.path);
  assert.ok(paths.includes(at.receipt_path), `pending에 receipt가 없다: ${paths.join(", ")}`);
  for (const raw of at.raw_paths) assert.ok(paths.includes(raw), `pending에 raw가 없다: ${raw}`);
  assert.ok(!paths.some((p) => p.endsWith("evidence.jsonl")), "evidence.jsonl은 결박하지 않는다 (append가 drift가 되지 않게)");
  // seed에는 research 문서 판단만 들어간다 — receipt/raw는 판단 문서가 아니다.
  assert.ok(!state.pending!.seeds.some((s) => s.line.includes("receipt-")), "receipt가 seed로 실렸다");
  rmProject(name);
});

test("[C-126/A1b] 같은 fixture를 `runWorkflow` 직접 호출로 돌리면 **attempt 기록이 동등**하다", async () => {
  const viaPipe = "_c126_a1b_p";
  const bk1 = fakeBackend([item(1)]);
  await pipelineToCheckpoint(viaPipe, bk1);
  const a = attemptsOf(loadRunState(viaPipe)!).at(-1)!;

  const viaDirect = "_c126_a1b_d";
  makeProject(viaDirect);
  const bk2 = fakeBackend([item(1)]);
  const r = await quiet(() =>
    runWorkflow({ workflowId: "idea-validation", project: viaDirect, provider: tap(), now: () => FIXED, research: externalRuntime(bk2) }),
  );
  const b = attemptsOf(r.state).at(-1)!;
  // 1차 문서에는 **프로젝트 이름**이 박히므로(mock의 Metadata 절) `first_pass_sha256`과 그것에서
  // 파생되는 `receipt_path`는 두 경로에서 반드시 다르다 — 그 두 필드만 빼고 나머지가 같아야 한다.
  const norm = (x: ResearchAttempt) => ({ ...x, evidence: x.evidence.map((e) => e.sha256), first_pass_sha256: null, receipt_path: "" });
  assert.deepEqual(norm(a), norm(b), "두 경로의 attempt 기록이 다르다");
  for (const x of [a, b]) {
    assert.match(x.first_pass_sha256 ?? "", /^[0-9a-f]{64}$/, "양쪽 모두 1차 전문 digest를 남긴다");
    assert.match(x.receipt_path, /^outputs\/research\/receipt-[0-9a-f]{64}\.json$/, "양쪽 모두 content-addressed receipt다");
  }
  rmProject(viaPipe);
  rmProject(viaDirect);
});

test("[C-126/A3] 승인 후 raw 1바이트 변조 → drift / `evidence.jsonl` append → drift 아님 / reject 후 재실행 정상", async () => {
  const name = "_c126_a3";
  const bk = fakeBackend([item(1)]);
  const state = await pipelineToCheckpoint(name, bk);
  const root = projectPaths(name).root;
  const at = attemptsOf(loadRunState(name)!).at(-1)!;
  const rawAbs = join(root, at.raw_paths[0]);
  const rawBytes = readFileSync(rawAbs);

  // ⓐ 승인 **전** 변조 → approve가 거부한다 (pending digest 대조).
  writeFileSync(rawAbs, Buffer.concat([rawBytes, Buffer.from("x")]));
  let out = await captureLogs(() =>
    approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }),
  );
  assert.match(out, /pipeline_artifact_drift|승인된 바이트와 현재 파일이 다릅니다/);
  assert.equal(readPipelineStateAt(pipelineStatePath(root)).kind, "ok");
  assert.equal((readPipelineStateAt(pipelineStatePath(root)) as { state: PipelineState }).state.status, "awaiting_approval", "거부는 상태를 바꾸지 않는다");

  // 복원 후 승인은 통과한다.
  writeFileSync(rawAbs, rawBytes);
  const ap = await quiet(() => approveCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, now: () => FIXED }));
  assert.equal(ap.code, "pipeline_approved");

  // ⓑ 승인 **후** 변조 → 다음 단계 게이트가 막는다.
  writeFileSync(rawAbs, Buffer.concat([rawBytes, Buffer.from("y")]));
  const nx = await quiet(() =>
    nextPipeline({ project: name, providerOverride: tap(), now: () => FIXED, researchRuntimeOverride: externalRuntime(fakeBackend([item(1)])) }),
  );
  assert.equal(nx.code, "pipeline_artifact_drift", "승인 후 근거 바이트 변경은 drift다");
  writeFileSync(rawAbs, rawBytes);

  // ⓒ `evidence.jsonl` append는 drift가 **아니다**(비권위 인덱스 · checkpoint 제외).
  appendFileSync(join(root, RESEARCH_DIR_REL, "evidence.jsonl"), JSON.stringify({ note: "나중에 붙은 줄" }) + "\n", "utf8");
  const nx2 = await quiet(() =>
    nextPipeline({ project: name, providerOverride: tap(), now: () => FIXED, researchRuntimeOverride: externalRuntime(fakeBackend([item(1)])) }),
  );
  assert.notEqual(nx2.code, "pipeline_artifact_drift", `jsonl append가 drift로 잡혔다 (${nx2.code})`);
  rmProject(name);
});

test("[C-126/A3b] reject 후 재실행 → **새 attempt·새 receipt**가 새 pending에 결박된다 (승인 전 재실행은 drift가 아니다)", async () => {
  const name = "_c126_a3b";
  const state = await pipelineToCheckpoint(name, fakeBackend([item(1)]));
  const first = attemptsOf(loadRunState(name)!).at(-1)!;
  await quiet(() => rejectCheckpoint({ project: name, stage: "idea-validation", checkpointId: state.pending!.checkpoint_id, note: "근거 부족", now: () => FIXED }));

  // 다른 응답을 주는 backend로 재실행 → 새 raw·새 receipt.
  const r = await quiet(() =>
    nextPipeline({
      project: name,
      providerOverride: tap(),
      now: () => FIXED,
      researchRuntimeOverride: externalRuntime(fakeBackend([item(7, "다시 검색한 응답")])),
    }),
  );
  assert.equal(r.code, "pipeline_awaiting_approval", "승인 전 재실행은 정상이다 (drift가 아니다)");
  const second = attemptsOf(loadRunState(name)!).at(-1)!;
  assert.notEqual(second.receipt_path, first.receipt_path, "사실이 달라졌으므로 receipt도 다르다");
  const st2 = readPipelineStateAt(pipelineStatePath(projectPaths(name).root)) as { state: PipelineState };
  const paths = st2.state.pending!.artifacts.map((a) => a.path);
  assert.ok(paths.includes(second.receipt_path), "새 pending은 새 receipt를 결박한다");
  assert.ok(!paths.includes(first.receipt_path), "옛 attempt의 receipt는 새 pending에 없다");
  rmProject(name);
});

test("[C-126/A3c] self attempt의 receipt도 결박된다 (승인자가 리서치 모드를 승인 바이트 안에서 본다)", () => {
  const state: RunState = {
    workflow_id: "idea-validation",
    project: "x",
    provider: "mock",
    status: "completed",
    completed_steps: [],
    failed_agent: null,
    failed_reason: null,
    killed_by: null,
    kill_history: [],
    cleared_idea_sha256: null,
    resume_from: null,
    loop_state: null,
    warnings: [],
    regenerations: [],
    critique_rounds: [],
    gate_jumps: [],
    spawned_agents: [],
    design_gate: null,
    step_timings: [],
    usage: { input_tokens: 0, output_tokens: 0, per_agent: [] },
    started_at: FIXED,
    finished_at: FIXED,
    research: {
      attempts: [
        { started_at: FIXED, mode: "self", requests: [], backend_calls: 0, cache_hits: 0, dropped_by_domain: 0, first_pass_sha256: null, evidence: [], receipt_path: "outputs/research/receipt-self.json", raw_paths: [] },
      ],
    },
  };
  const srcs = runStateSources(state);
  assert.deepEqual(srcs, [{ agent_id: "research", path: "outputs/research/receipt-self.json", seed: false }]);

  // 실패로 끝난(mode:null) attempt만 있으면 결박하지 않는다 — 채택된 근거가 아니다.
  const failedOnly: RunState = { ...state, research: { attempts: [{ ...state.research!.attempts[0], mode: null }] } };
  assert.deepEqual(runStateSources(failedOnly), []);
});

// ══ 11. A-5 안내 정합 ═══════════════════════════════════════════

test("[C-126/A5] 파이프라인 소유 상태의 failed run에서 summary가 `--resume`을 안내하지 않는다", async () => {
  const name = "_c126_a5";
  makeProject(name);
  process.env.HARNESS_FAIL_AT = "pm";
  const r = await quiet(() =>
    nextPipeline({ project: name, providerOverride: tap(), now: () => FIXED, researchRuntimeOverride: externalRuntime(fakeBackend([item(1)])) }),
  );
  delete process.env.HARNESS_FAIL_AT;
  assert.equal(r.code, "pipeline_stage_failed");
  assert.equal(loadRunState(name)!.status, "failed");

  const summary = buildSummary(name, "2026-01-01");
  assert.ok(!summary.includes("--resume"), `파이프라인 소유 상태에서 --resume을 안내했다:\n${summary}`);
  assert.match(summary, /harness pipeline next --project _c126_a5/);
  rmProject(name);
});

test("[C-126/A5b] 리서치 실패 출력에 복구 경로 ⓐⓑ가 있고, 실패 attempt를 지우지 않는다", async () => {
  const name = "_c126_a5b";
  makeProject(name);
  const out = await captureLogs(() =>
    nextPipeline({
      project: name,
      providerOverride: tap({ decl: null }),
      now: () => FIXED,
      researchRuntimeOverride: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  assert.match(out, /research_declaration_missing/);
  assert.match(out, /ⓐ 원인/);
  assert.match(out, /ⓑ 외부 검색 없이 진행/);
  assert.match(out, /삭제하지 않고/);
  assert.ok(!out.includes("--resume"), "파이프라인 실패 출력에 --resume 안내가 있다");

  const failedAttempt = attemptsOf(loadRunState(name)!).at(-1)!;
  assert.equal(failedAttempt.mode, null);

  // 복구 ⓑ: 키를 없앤다(runtime 미지정 = self) → self attempt가 **append**되고 실패 attempt는 남는다.
  const r2 = await quiet(() => nextPipeline({ project: name, providerOverride: tap({ decl: null }), now: () => FIXED }));
  assert.equal(r2.code, "pipeline_awaiting_approval", "키 부재 = 승인된 self fallback으로 완주한다");
  const after = attemptsOf(loadRunState(name)!);
  assert.ok(after.some((a) => a.mode === null && a.error_code === "research_declaration_missing"), "실패 attempt가 지워졌다");
  assert.ok(after.some((a) => a.mode === "self"), "self attempt가 append되지 않았다");
  rmProject(name);
});

// ══ 12. additive 회귀 (프롬프트 바이트 · run_state 필드) ═════════

test("[C-126/P0] 리서치 인자가 없으면 프롬프트 바이트가 **완전히 동일**하다", () => {
  const base: AgentRunInput = {
    agent: { agent_id: "pm", name: "PM", role: "r", prompt_path: "p", default_output: "docs/02_PRD.md" },
    workflowId: "w",
    project: "p",
    createdAt: FIXED,
    commonPrompt: "common",
    agentPrompt: "agent",
    ideaContent: "아이디어",
    priorFindings: ["a: b"],
  };
  const without = buildPromptParts(base, "mock");
  assert.equal(buildPromptParts({ ...base, researchRequest: undefined, evidenceDigest: undefined }, "mock").user, without.user);
  const withDigest = buildPromptParts({ ...base, evidenceDigest: "<<<EVIDENCE_DATA>>>본문<<<END_EVIDENCE_DATA>>>" }, "mock");
  assert.notEqual(withDigest.user, without.user);
  assert.ok(withDigest.user.includes("수집된 근거"));
  // 지시(출력 형식)가 데이터 **뒤에** 온다 — 모델이 마지막으로 읽는 것이 지시여야 한다.
  assert.ok(withDigest.user.indexOf("EVIDENCE_DATA") < withDigest.user.indexOf("# 출력 형식"), "digest가 출력 형식 지시 뒤에 있다");
});

test("[C-126/P0b] 리서치 attempt가 없는 run_state에는 `research` 필드가 아예 없다 (구버전 바이트 보존)", async () => {
  const name = "_c126_p0b";
  makeProject(name);
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-then-pm", project: name, provider: tap({ decl: null }), workflowsPath: WF, now: () => FIXED }),
  );
  // research agent가 있는 workflow는 self attempt를 남긴다 (§6.1) — 그것이 설계다.
  assert.ok(r.state.research, "research agent가 도는 workflow는 attempt를 남긴다");
  const raw = readFileSync(join(projectPaths(name).root, "outputs/run_state.json"), "utf8");
  assert.ok(raw.includes('"research"'));
  rmProject(name);

  // research agent가 없는 workflow(dev-preflight)는 필드 자체가 없다.
  const name2 = "_c126_p0c";
  makeProject(name2);
  const r2 = await quiet(() =>
    runWorkflow({ workflowId: "dev-preflight", project: name2, provider: tap(), now: () => FIXED, approve: async () => true }),
  );
  assert.equal(r2.state.research, undefined, "리서치 step이 없으면 research 필드를 만들지 않는다");
  assert.ok(!readFileSync(join(projectPaths(name2).root, "outputs/run_state.json"), "utf8").includes('"research"'));
  rmProject(name2);
});

test("[C-126/P0d] `.env`가 없으면 self이고, 그 안내는 **경로를 그대로** 알려준다 (키 값 없음)", () => {
  const dir = mkdtempSync(join(tmpdir(), "c126-self-"));
  const rt = resolveResearchRuntime({ root: dir, env: {} });
  assert.equal(rt.kind, "self");
  assert.equal(rt.kind === "self" ? rt.envPath : "", envFilePath(dir));
  assert.equal(existsSync(join(dir, ENV_FILE_NAME)), true, "판정 순간에 템플릿을 만들어 둔다 (안내가 실행 가능해야 한다)");
  const lines = researchModeLines(rt).join("\n");
  assert.match(lines, /자체\(self\)/);
  assert.ok(lines.includes(join(dir, ENV_FILE_NAME)), "어디에 넣으라는지 경로를 그대로 준다");
  rmSync(dir, { recursive: true, force: true });
});

// ══ 13. Codex 리뷰 A급 7건 · B 3건 · C 1건 ══════════════════════

test("[C-126/A-1] resume 근거는 **receipt+raw와 대조한 뒤에만** 재주입된다 (run_state 변조 → fail closed)", async () => {
  const name = "_c126_rA1";
  makeProject(name);
  await quiet(() =>
    runWorkflow({
      workflowId: "research-then-pm",
      project: name,
      provider: tap(),
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  const root = projectPaths(name).root;
  const statePath = join(root, "outputs/run_state.json");
  const clean = readFileSync(statePath, "utf8");
  /** research는 완료 · pm 앞에서 죽은 것으로 만든다 (resume 진입점). */
  const asFailed = (mutate: (s: RunState) => void): void => {
    const s = JSON.parse(clean) as RunState;
    s.status = "failed";
    s.resume_from = 1;
    s.completed_steps = ["research"];
    mutate(s);
    writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n", "utf8");
  };
  const resumeOnce = () =>
    runWorkflow({
      workflowId: "research-then-pm",
      project: name,
      provider: tap(),
      workflowsPath: WF,
      now: () => FIXED,
      resume: true,
      research: externalRuntime(fakeBackend([item(1)])),
    });

  // ⓐ 손대지 않은 run_state는 통과한다 (대조가 정상 경로를 막지 않는다).
  asFailed(() => {});
  const okRun = await quiet(resumeOnce);
  assert.equal(okRun.state.status, "completed");

  // ⓑ **run_state의 evidence만** 바꾼다 — receipt/raw는 손대지 않는다. 예전 코드는 이 변조된
  //    summary를 그대로 digest로 만들어 모델에 먹였고, checkpoint는 옛 receipt를 결박했다.
  asFailed((s) => {
    s.research!.attempts.at(-1)!.evidence[0].summary = "조작된 근거 — 이 문장은 저장 응답에 없다";
  });
  await assert.rejects(resumeOnce, /research_receipt_unverified/, "run_state 변조가 통과했다");

  // ⓒ sha256만 바꿔도 잡힌다 (exact-equal 대조).
  asFailed((s) => {
    s.research!.attempts.at(-1)!.evidence[0].sha256 = "0".repeat(64);
  });
  await assert.rejects(resumeOnce, /research_receipt_unverified/);

  // ⓓ **raw 파일 1바이트 변조**도 잡힌다 (재해시 대조).
  asFailed(() => {});
  const rawRel = (JSON.parse(clean) as RunState).research!.attempts.at(-1)!.raw_paths[0];
  const rawBytes = readFileSync(join(root, rawRel));
  writeFileSync(join(root, rawRel), Buffer.concat([rawBytes, Buffer.from("x")]));
  await assert.rejects(resumeOnce, /research_receipt_unverified/, "raw 변조가 통과했다");
  writeFileSync(join(root, rawRel), rawBytes);

  // ⓔ receipt 파일 삭제도 잡힌다 (저장본이 정본이므로 없으면 근거가 없다).
  asFailed(() => {});
  const receiptRel = (JSON.parse(clean) as RunState).research!.attempts.at(-1)!.receipt_path;
  const receiptBytes = readFileSync(join(root, receiptRel));
  rmSync(join(root, receiptRel));
  await assert.rejects(resumeOnce, /research_receipt_unverified/);
  writeFileSync(join(root, receiptRel), receiptBytes);
  rmProject(name);
});

test("[C-126/A-2] receipt 실패는 **fail closed**이고, seal은 모든 경로에서 정확히 한 번이다", async () => {
  // ⓐ receipt를 못 쓰는 상태(디렉터리 자리에 파일)를 만들면 성공으로 판정하지 않는다.
  const name = "_c126_rA2";
  const root = makeProject(name);
  // `outputs/research`가 **파일**이면 mkdir이 실패해 receipt를 쓸 수 없다.
  writeFileSync(join(root, RESEARCH_DIR_REL), "이 자리는 디렉터리여야 한다", "utf8");
  const r = await quiet(() => runWorkflow({ workflowId: "research-only", project: name, provider: tap(), workflowsPath: WF, now: () => FIXED }));
  assert.equal(r.state.status, "failed", "영수증을 못 쓰면 그 단계는 성공이 아니다");
  assert.equal(r.state.failed_agent, "research");
  assert.equal(r.state.completed_steps.includes("research"), true, "문서는 저장됐다 — 그 사실은 숨기지 않는다");
  assert.equal(r.state.research, undefined, "봉인되지 않은 attempt는 영수증에 실리지 않는다");
  rmProject(name);

  // ⓑ **1차 provider throw**도 attempt를 봉인한다 (예전엔 seal 밖이어서 영수증이 없었다).
  const name2 = "_c126_rA2b";
  makeProject(name2);
  const throwing: Provider = {
    id: "mock",
    async generate(input) {
      if (input.agent.agent_id === "research") throw new Error("1차 provider 실패(주입)");
      return mockProvider.generate(input);
    },
  };
  const r2 = await quiet(() =>
    runWorkflow({
      workflowId: "research-only",
      project: name2,
      provider: throwing,
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  assert.equal(r2.state.status, "failed");
  const at2 = attemptsOf(r2.state).at(-1);
  assert.ok(at2, "1차가 죽어도 attempt가 봉인된다");
  assert.equal(at2!.mode, null);
  assert.equal(at2!.error_code, "research_step_failed");
  assert.ok(existsSync(join(projectPaths(name2).root, at2!.receipt_path)), "영수증 파일이 실물로 있다");
  assert.equal(attemptsOf(r2.state).length, 1, "seal은 정확히 한 번이다 (catch와 정상 경로가 겹쳐도 중복 없음)");
  rmProject(name2);
});

test("[C-126/A-3] resume을 4회 넘게 반복해도 run-wide 상한이 다시 열리지 않는다", async () => {
  const name = "_c126_rA3";
  makeProject(name);
  const backend = fakeBackend([item(1)]);
  const reasons: string[] = [];
  for (let i = 0; i < MAX_BACKEND_CALLS_PER_RUN + 1; i++) {
    // 매번 **다른 질의**라 memo가 적중하지 않는다 → attempt당 backend 1회.
    // 2차를 죽여 status=failed·resume_from=0으로 만들어 다음 resume이 research를 재실행하게 한다.
    const p = tap({ decl: `RESEARCH_REQUEST query="질의 ${i}" | type=search`, secondFails: true });
    const r = await quiet(() =>
      runWorkflow({
        workflowId: "research-only",
        project: name,
        provider: p,
        workflowsPath: WF,
        now: () => FIXED,
        resume: i > 0,
        research: externalRuntime(backend),
      }),
    );
    reasons.push(r.state.failed_reason ?? "(없음)");
    // 표시용 attempts는 상한 4로 잘리지만 **totals는 잘리지 않는다** — 그것이 집행 근거다.
    assert.ok(attemptsOf(r.state).length <= 4, "표시용 attempts는 4개로 잘린다");
    assert.equal(r.state.research!.totals!.backend_calls, Math.min(i + 1, MAX_BACKEND_CALLS_PER_RUN), `누적 호출 (i=${i})`);
  }
  assert.equal(backend.calls.length, MAX_BACKEND_CALLS_PER_RUN, `backend는 상한 ${MAX_BACKEND_CALLS_PER_RUN}회까지만 불렸다 (실제 ${backend.calls.length})`);
  assert.equal(reasons.at(-1), "research_budget_exceeded", `마지막 resume은 예산 초과로 거부된다 (실제 ${reasons.at(-1)})`);
  assert.deepEqual(new Set(reasons.slice(0, -1)), new Set(["research_second_pass_failed"]), "그 전까지는 2차 실패였다");
  rmProject(name);
});

test("[C-126/A-4] malformed Tavily 항목은 조용히 버려지지 않는다 (빈 배열만 empty)", async () => {
  const saved = process.env[TAVILY_SECRET_REF];
  delete process.env[TAVILY_SECRET_REF];
  const realFetch = globalThis.fetch;
  const reply = (body: unknown) => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
  };
  try {
    const backend = createTavilyBackend({ apiKey: FAKE_KEY });
    // ⓐ 빈 배열 = 정상 empty (실패가 아니다)
    reply({ results: [] });
    assert.deepEqual(await backend.search("q"), []);
    // ⓑ 전부 malformed → 실패 (예전엔 empty로 둔갑했다)
    reply({ results: [{ nope: 1 }, { url: 123 }] });
    await rejectsCode(() => backend.search("q"), "backend_malformed", "전부 malformed");
    // ⓒ 혼합 → 실패 (예전엔 partial 성공으로 둔갑했다)
    reply({ results: [{ url: "https://a.example.com/1", content: "본문" }, { url: "https://b.example.com/1" }] });
    await rejectsCode(() => backend.search("q"), "backend_malformed", "혼합");
    // ⓓ 전부 정상 → 그대로 통과
    reply({ results: [{ url: "https://a.example.com/1", content: "본문", title: "t" }] });
    assert.equal((await backend.search("q")).length, 1);
  } finally {
    globalThis.fetch = realFetch;
    if (saved !== undefined) process.env[TAVILY_SECRET_REF] = saved;
  }
});

test("[C-126/A-5] `.env`는 **git 안전을 통과한 뒤에만** 만들어진다 · git 판정 불가는 거부 · 0644는 거부", () => {
  // ⓐ `.gitignore`가 없는 repo(설치된 사용자 workspace의 모양): 파일을 **만들기 전에** 규칙을 넣고,
  //    그래서 생성된 `.env`가 처음부터 ignored다. 예전엔 template을 먼저 만들어 unignored 창이 있었다.
  const a = tmpGitRepo();
  const readyA = ensureEnvFileReady(a);
  assert.equal(readyA.ok, true, `게이트를 통과해야 한다: ${readyA.ok ? "" : readyA.code}`);
  assert.equal(readyA.ok && readyA.created, true, "이번 호출이 만들었다");
  assert.match(readFileSync(join(a, ".gitignore"), "utf8"), /--- harness managed/, "생성 **전에** 규칙이 들어갔다");
  assert.equal(envGitState(a), "ignored", "만들어진 .env는 처음부터 ignored다");
  assert.equal(statSync(join(a, ENV_FILE_NAME)).mode & 0o777, 0o600);
  rmSync(a, { recursive: true, force: true });

  // ⓑ git 판정 불가(PATH에 git이 없다) → **거부**. 예전엔 모든 오류가 "repo 아님"으로 접혀 검사를 건너뛰었다.
  const b = tmpGitRepo();
  writeEnv(b, "TAVILY_API_KEY=k-unknown\n");
  const savedPath = process.env.PATH;
  process.env.PATH = join(b, "no-such-bin");
  try {
    assert.equal(envGitState(b), "unknown", "git을 실행할 수 없으면 판정 불가다 (non-repo가 아니다)");
    const r = resolveResearchKey({ root: b, env: {} });
    assert.equal(r.key, null, "판정 불가에서 키를 읽었다");
    assert.equal(r.refusedCode, "env_git_probe_failed");
    assert.match(r.notices.join("\n"), /git status/);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(resolveResearchKey({ root: b, env: {} }).key, "k-unknown", "git이 돌아오면 정상 판정된다");
  rmSync(b, { recursive: true, force: true });

  // ⓒ 사람이 만든 0644 `.env` → 남이 읽을 수 있으므로 **거부**(조용히 chmod하지 않는다).
  const c = tmpGitRepo();
  writeFileSync(join(c, ".gitignore"), ".env\n", "utf8");
  writeFileSync(join(c, ENV_FILE_NAME), "TAVILY_API_KEY=k-loose\n", { encoding: "utf8", mode: 0o644 });
  const rc = resolveResearchKey({ root: c, env: {} });
  assert.equal(rc.key, null, "넓은 권한 파일에서 키를 읽었다");
  assert.equal(rc.refusedCode, "env_file_permissions");
  assert.match(rc.notices.join("\n"), /chmod 600/);
  assert.equal(statSync(join(c, ENV_FILE_NAME)).mode & 0o777, 0o644, "권한을 몰래 바꾸지 않았다");
  rmSync(c, { recursive: true, force: true });
});

test("[C-126/A-6] 실행 **전** 문구는 '사용 가능(설정됨)'이고, 실제 mode는 실행 **후** 영수증이 말한다", async () => {
  const rt = externalRuntime(fakeBackend([item(1)]));
  const pre = researchModeLines(rt).join("\n");
  assert.match(pre, /사용 \*\*가능\*\* \(키 설정됨\)/, "설정 상태를 mode로 과대 렌더하지 않는다");
  assert.ok(!/외부 검색\(Tavily\) 사용 —/.test(pre), "예전의 단정 문구가 남아 있다");

  // attempt가 없으면(리서치 step 없는 workflow) 리서치 이야기를 아예 하지 않는다.
  assert.deepEqual(researchOutcomeLines(undefined), []);
  assert.deepEqual(researchOutcomeLines([]), []);

  // 4종 + 실패가 서로 다른 문장으로 나온다.
  const base = {
    started_at: FIXED,
    requests: [],
    backend_calls: 0,
    cache_hits: 0,
    dropped_by_domain: 0,
    first_pass_sha256: null,
    evidence: [],
    receipt_path: "outputs/research/receipt-x.json",
    raw_paths: [],
  };
  const line = (a: Partial<ResearchAttempt>) => researchOutcomeLines([{ ...base, mode: "self", ...a } as ResearchAttempt])[0];
  assert.match(line({ mode: "self" }), /자체\(self\)/);
  assert.match(line({ mode: "external_declined" }), /검색 불필요/);
  assert.match(line({ mode: "external_empty" }), /결과 0건/);
  assert.match(line({ mode: "external", evidence: [], backend_calls: 2, cache_hits: 1 }), /근거 0건 \(backend 2회 · 캐시 1회\)/);
  assert.match(line({ mode: null, error_code: "research_backend_error" }), /중단 \(research_backend_error\)/);

  // CLI가 실제로 그 줄을 낸다: `none`을 낸 실행은 "declined"라고 적힌다 (사전 문구와 다르다).
  const name = "_c126_rA6";
  makeProject(name);
  const out = await captureLogs(() =>
    runRun("research-only", name, "mock", 1, false, undefined, false, 0, true, undefined, false, false, undefined, undefined, undefined, undefined, WF, rt),
  );
  assert.match(out, /사용 \*\*가능\*\*/, "사전 문구");
  assert.match(out, /리서치 결과: 모델이 '검색 불필요'를 선언/, "실행 후 실제 mode 영수증");
  rmProject(name);
});

test("[C-126/A-7] 저장·gateway 소스에 '원문'을 **단정하는** 문구가 남아 있지 않다 (전수 grep)", () => {
  for (const rel of ["src/tools/evidenceStore.ts", "src/tools/researchGateway.ts"]) {
    const src = readFileSync(join(HERE, "..", "..", rel), "utf8");
    for (const [n, l] of src.split("\n").entries()) {
      if (!l.includes("원문")) continue;
      // 남아 있어도 되는 것은 **강등 문구**(대조)뿐이다: "원문이 아니다" · "원문 검증으로 읽히면 과대주장".
      assert.ok(
        /원문이 아니다|원문의 것이 아니다|원문의 해시가 아니다|"원문"이라고 부르지 않는다|"원문 검증"/.test(l),
        `${rel}:${n + 1} 에 저장물을 원문이라 **단정하는** 문구가 남았다: ${l.trim()}`,
      );
    }
  }
});

test("[C-126/B-1] `attempts.jsonl`이 같은 사실의 **발생 횟수**를 보존한다 (content-addressed receipt는 못 한다)", async () => {
  const name = "_c126_rB1";
  const root = makeProject(name);
  const bk = fakeBackend([item(1)]);
  // 게이트가 research로 되돌려 **같은 사실**의 attempt가 두 번 일어난다(고정 시각 + memo 적중).
  const r = await quiet(() =>
    runWorkflow({
      workflowId: "research-gate",
      project: name,
      provider: tap({ decisions: ["검증", "진행"] }),
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(bk),
    }),
  );
  assert.equal(r.state.status, "completed");
  assert.equal(attemptsOf(r.state).length, 2, "attempt는 두 번 일어났다");
  const log = readFileSync(join(root, RESEARCH_ATTEMPT_LOG_REL), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  // **seal 1회 = 로그 1줄**이 불변식이다 (receipt 파일이 새로 생겼는지와 무관하다).
  assert.equal(log.length, 2, `발생 2건이 로그에 남는다 (실제 ${log.length})`);
  assert.ok(log.every((l) => typeof l.receipt_path === "string" && typeof l.receipt_created === "boolean"));

  // ── 여기가 B-1이 지목한 자리다: **사실이 완전히 같은 두 attempt** ──
  // 위 두 attempt는 `cache_hits`가 달라(0 vs 1) receipt가 갈렸다. 사실까지 같으면 receipt는
  // **하나를 공유**하고, 그때 다중성을 아는 유일한 방법이 이 로그다.
  const same = attemptsOf(r.state)[0];
  const before = receiptFiles(root).length;
  const rel = writeResearchReceipt(root, same);
  assert.equal(rel, same.receipt_path, "같은 사실 → 같은 content-addressed 경로");
  assert.equal(receiptFiles(root).length, before, "파일은 늘지 않는다 (내용이 곧 이름이다)");
  const log2 = readFileSync(join(root, RESEARCH_ATTEMPT_LOG_REL), "utf8").trim().split("\n");
  assert.equal(log2.length, log.length + 1, "그래도 발생은 한 건 더 기록된다 — 이것이 다중성 보존이다");
  assert.equal(JSON.parse(log2.at(-1)!).receipt_created, false, "재사용이었다는 사실까지 적힌다");
  rmProject(name);
});

test("[C-126/B-2] 2차 실패가 **안정 사유 코드**로 durable하게 남고 복구 안내가 그것을 본다", async () => {
  const name = "_c126_rB2";
  makeProject(name);
  const out = await captureLogs(() =>
    nextPipeline({
      project: name,
      providerOverride: tap({ secondFails: true }),
      now: () => FIXED,
      researchRuntimeOverride: externalRuntime(fakeBackend([item(1)])),
    }),
  );
  const st = loadRunState(name)!;
  assert.equal(st.failed_reason, "research_second_pass_failed", "failed_reason이 예외 메시지로 덮이지 않았다");
  assert.equal(attemptsOf(st).at(-1)!.error_code, "research_second_pass_failed");
  assert.match(out, /ⓐ 원인/, "복구 안내가 이 실패를 본다 (research_ 접두사)");
  assert.match(out, /ⓑ 외부 검색 없이 진행/);
  rmProject(name);
});

test("[C-126/B-3] 같은 질의 두 줄이면 `cache_hits`가 gateway 적중까지 센다", async () => {
  const name = "_c126_rB3";
  makeProject(name);
  const bk = fakeBackend([item(1)]);
  const r = await quiet(() =>
    runWorkflow({
      workflowId: "research-only",
      project: name,
      provider: tap({ decl: 'RESEARCH_REQUEST query="같은 질의" | type=search\nRESEARCH_REQUEST query="같은 질의" | type=search' }),
      workflowsPath: WF,
      now: () => FIXED,
      research: externalRuntime(bk),
    }),
  );
  assert.equal(r.state.status, "completed");
  assert.equal(bk.calls.length, 1, "backend는 한 번만 불렸다");
  const at = attemptsOf(r.state).at(-1)!;
  assert.equal(at.backend_calls, 1);
  assert.equal(at.cache_hits, 1, `gateway 적중이 영수증에 남는다 (실제 ${at.cache_hits})`);
  // 영수증 파일도 같은 값을 증언한다 (run_state만의 사실이 아니다).
  assert.equal((JSON.parse(readFileSync(join(projectPaths(name).root, at.receipt_path), "utf8")) as ResearchAttempt).cache_hits, 1);
  rmProject(name);
});

test("[C-126/C-1] digest 예산 초과 workflow는 **조건부가 아니라** 반드시 실패한다 (LLM 1회)", async () => {
  const name = "_c126_rC1";
  makeProject(name);
  // 3-byte 문자로 title·summary를 상한까지 채운 항목 12건(run 상한) → digest 총량이 16,384B를 넘는다.
  // 항목당 대략: title 200자×3B + summary 400자×3B + 고정 필드 ≈ 2,000B → 12건 ≈ 24,000B.
  const big = (n: number): BackendResult => ({ source: `https://ex${n}.example.com/a`, title: "제".repeat(200), raw: "가".repeat(500) });
  const bk = fakeBackend([0, 1, 2, 3, 4, 5].map(big), { results2: [6, 7, 8, 9, 10, 11].map(big) });
  const p = tap({ decl: 'RESEARCH_REQUEST query="q1" | type=search\nRESEARCH_REQUEST query="q2" | type=search' });
  const r = await quiet(() =>
    runWorkflow({ workflowId: "research-only", project: name, provider: p, workflowsPath: WF, now: () => FIXED, research: externalRuntime(bk) }),
  );
  // **선행 단정**: 조건 분기 없이 실패여야 한다 (fixture가 예산 아래면 여기서 red).
  assert.equal(r.state.status, "failed");
  assert.equal(r.state.failed_reason, "research_budget_exceeded");
  assert.equal(p.byAgent.get("research"), 1, "2차를 태우지 않았다 (예산은 호출 전에 판정)");
  const at = attemptsOf(r.state).at(-1)!;
  assert.equal(at.evidence.length, 12, "run 상한까지 저장됐다");
  const d = buildEvidenceDigest(at.evidence);
  assert.equal(d.ok, false, "저장된 근거의 digest가 실제로 예산을 넘는다");
  assert.ok(!d.ok && d.bytes > EVIDENCE_DIGEST_MAX_BYTES);
  assert.equal(existsSync(join(projectPaths(name).root, "docs/01_RESEARCH.md")), false, "실패면 미저장");
  rmProject(name);
});
