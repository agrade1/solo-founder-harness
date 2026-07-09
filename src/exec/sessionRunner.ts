/**
 * 단일 세션 오케스트레이터 (ARCH §9-5·§9-6, v3 = 세션 1개).
 * worktree → 권한 컴파일 → 프롬프트 → 세션 실행 → L1 기계 게이트 → 커밋 →
 * (선택) L3 리뷰어 루프(critique_loop 이식) → diff → 승인 → base 병합.
 *
 * 병렬/미션은 상위(v3.5/v4)에서 이 러너를 조합. 여기서는 1세션 end-to-end.
 * ⚠ 병합 = `git push . <branch>:<base>` (ff) — base가 메인 작업트리에 체크아웃돼 있으면
 *   거부될 수 있음. 견고한 병합 전략은 DESIGN_QUESTIONS Q4.
 */
import { join, basename } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { createWorktree, removeWorktree, type WorktreeInfo } from "./worktree.js";
import { compilePermissions, materializeSettings } from "./permissionCompiler.js";
import { compilePrompt } from "./promptCompiler.js";
import { collectDiff, summarizeDiff, type DiffPreview } from "./diffPreview.js";
import { runMachineGate, type GateResult } from "./machineGate.js";
import { reviewDiff } from "./reviewer.js";
import { runProcess } from "./runProcess.js";
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec, SessionUsage } from "./types.js";
import type { Approver, Decision } from "./approvalQueue.js";

export interface RunSessionOpts {
  repoRoot: string;
  runId: string;
  spec: SessionSpec; // spec.cwd는 worktree 경로로 대체됨
  provider: ExecutionProvider;
  approver: Approver;
  baseBranch?: string; // 기본 develop
  onEvent?: (e: SessionEvent) => void;
  merge?: boolean; // 승인 시 base 병합 (기본 true)
  keepWorktree?: boolean; // 기본 false (제거, 브랜치 보존)
  review?: { provider: ExecutionProvider; maxRounds?: number; model?: string }; // L3 리뷰어(있으면 실행)
}

export type SessionStatus = "merged" | "rejected" | "deferred" | "gate_failed" | "review_deferred" | "no_changes" | "error";

export interface SessionOutcome {
  sessionId: string;
  branch: string;
  worktreePath: string;
  turns: number;
  events: number;
  usage: SessionUsage | null;
  gate: GateResult | null;
  diff: DiffPreview | null;
  reviews: { round: number; critical: string[] }[];
  decision: Decision | null;
  status: SessionStatus;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const r = await runProcess("git", ["-C", cwd, ...args]);
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** worktree에서 계약 문서(inputs 중 contract) 전문을 읽는다(리뷰어 입력용). 없으면 undefined. */
function readContract(worktree: string, spec: SessionSpec): string | undefined {
  const inputs = spec.inputs ?? [];
  const contracts = inputs.filter((p) => (spec.contractPaths?.length ? spec.contractPaths.includes(p) : /API_CONTRACT/i.test(basename(p))));
  for (const c of contracts) {
    const abs = join(worktree, c);
    if (existsSync(abs)) return readFileSync(abs, "utf8");
  }
  return undefined;
}

export async function runSession(opts: RunSessionOpts): Promise<SessionOutcome> {
  const base = opts.baseBranch ?? "develop";
  const merge = opts.merge ?? true;
  let wt: WorktreeInfo | null = null;

  const outcome: SessionOutcome = {
    sessionId: opts.spec.sessionId,
    branch: "",
    worktreePath: "",
    turns: 0,
    events: 0,
    usage: null,
    gate: null,
    diff: null,
    reviews: [],
    decision: null,
    status: "error",
  };

  // 한 turn의 이벤트를 소진하며 카운트/usage 갱신.
  async function consumeTurn(handle: SessionHandle): Promise<void> {
    for await (const e of opts.provider.events(handle)) {
      outcome.events++;
      if (e.kind === "assistant") outcome.turns++;
      if (e.kind === "result") outcome.usage = e.usage;
      opts.onEvent?.(e);
    }
  }

  // 게이트 → 커밋 → diff. gatePassed=false면 즉시 중단 신호.
  async function finalize(): Promise<{ gatePassed: boolean; hasChanges: boolean }> {
    outcome.gate = await runMachineGate({ cwd: wt!.path });
    if (!outcome.gate.passed) return { gatePassed: false, hasChanges: false };
    await git(wt!.path, ["add", "-A"]);
    const staged = await git(wt!.path, ["diff", "--cached", "--name-only"]);
    if (staged.out) await git(wt!.path, ["commit", "-q", "-m", `session ${opts.spec.sessionId}: ${opts.spec.task ?? opts.spec.role}`]);
    outcome.diff = await collectDiff({ cwd: wt!.path, base });
    return { gatePassed: true, hasChanges: outcome.diff.files.length > 0 || outcome.diff.untracked.length > 0 };
  }

  try {
    // 1) worktree + 전용 브랜치
    wt = await createWorktree({ repoRoot: opts.repoRoot, runId: opts.runId, sessionId: opts.spec.sessionId, baseBranch: base });
    outcome.branch = wt.branch;
    outcome.worktreePath = wt.path;

    // 2) 권한 컴파일 → settings materialize(worktree 밖, gitignore) + 확정 spec
    const compiled = compilePermissions({ ...opts.spec, cwd: wt.path });
    const settingsPath = materializeSettings(join(opts.repoRoot, ".harness", "sessions", opts.spec.sessionId), compiled);
    const spec: SessionSpec = { ...opts.spec, cwd: wt.path, permissionMode: compiled.permissionMode, allowedTools: compiled.allow, disallowedTools: compiled.deny, settingsPath };

    // 3) 착수 프롬프트 (worktree 내용 기준)
    const prompt = compilePrompt(spec, { projectRoot: wt.path });

    // 4) 코더 세션 실행
    const handle = await opts.provider.start(spec, prompt);
    await consumeTurn(handle);

    // 5) L1 게이트 + 커밋 + diff
    let fin = await finalize();
    if (!fin.gatePassed) return ((outcome.status = "gate_failed"), outcome);
    if (!fin.hasChanges) return ((outcome.status = "no_changes"), outcome);

    // 6) L3 리뷰어 루프 (critique_loop 이식) — 있을 때만
    if (opts.review) {
      const maxRounds = Math.max(1, opts.review.maxRounds ?? 2);
      const contract = readContract(wt.path, spec);
      let passed = false;
      for (let round = 1; round <= maxRounds; round++) {
        const verdict = await reviewDiff({
          provider: opts.review.provider,
          sessionId: `${spec.sessionId}-review-${round}`,
          cwd: wt.path,
          model: opts.review.model,
          coder: { role: spec.role, task: spec.task, dod: spec.dod, forbidden: spec.forbidden },
          contract,
          diff: outcome.diff!.raw,
        });
        outcome.reviews.push({ round, critical: verdict.critical });
        if (verdict.critical.length === 0) {
          passed = true;
          break;
        }
        if (round >= maxRounds) break; // 라운드 소진 — 미해결
        // turn 예산 소진이면 더 이상 revise하지 않음 (ARCH §3.1.2 — 그레이스 주입은 미션 모드 단순화)
        if (spec.budget?.maxTurns && outcome.turns >= spec.budget.maxTurns) break;

        // Critical을 코더에 되먹여 revise (--resume)
        const revise =
          `리뷰어가 다음 Critical 이슈를 제기했다:\n` +
          verdict.critical.map((c, i) => `${i + 1}. ${c}`).join("\n") +
          `\n이 이슈들을 정면으로 고쳐라. 담당 경로 밖은 건드리지 말고 테스트도 갱신하라. 끝나면 STATUS를 DONE으로.`;
        await opts.provider.send(handle, revise);
        await consumeTurn(handle);
        fin = await finalize();
        if (!fin.gatePassed) return ((outcome.status = "gate_failed"), outcome);
      }
      if (!passed) return ((outcome.status = "review_deferred"), outcome); // 보류 목록행 (ARCH §4.1)
    }

    // 7) 사람 승인
    const decision = await opts.approver({
      sessionId: spec.sessionId,
      kind: "diff-merge",
      message: `세션 '${spec.sessionId}' 결과를 ${base}에 병합할까요?`,
      detail: summarizeDiff(outcome.diff!),
    });
    outcome.decision = decision;
    if (decision === "reject") return ((outcome.status = "rejected"), outcome);
    if (decision === "defer") return ((outcome.status = "deferred"), outcome);

    // 8) 병합
    if (merge) {
      const push = await git(opts.repoRoot, ["push", ".", `${wt.branch}:${base}`]);
      if (push.code !== 0) {
        outcome.status = "error";
        outcome.error = `병합 실패(${wt.branch}→${base}): ${push.err || push.out}`;
        return outcome;
      }
    }
    outcome.status = "merged";
    return outcome;
  } catch (err) {
    outcome.status = "error";
    outcome.error = (err as Error).message;
    return outcome;
  } finally {
    if (wt && !opts.keepWorktree) {
      try {
        await removeWorktree({ repoRoot: opts.repoRoot, info: wt });
      } catch {
        /* 정리 실패 무시 */
      }
    }
  }
}
