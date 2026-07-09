/**
 * 단일 세션 오케스트레이터 (ARCH §9-5, v3 = 세션 1개).
 * worktree 생성 → 권한 컴파일 → 프롬프트 조립 → 세션 실행(이벤트 관측) →
 * L1 기계 게이트 → 자기 브랜치 커밋 → diff 미리보기 → 승인 → base 병합.
 *
 * 병렬/미션/리뷰어(L3)는 상위(v3.5/v4)에서 이 러너를 조합. 여기서는 1세션 end-to-end.
 * ⚠ 병합 = `git push . <branch>:<base>` (ff) — base가 메인 작업트리에 체크아웃돼 있으면
 *   거부될 수 있음(운영 시 base는 세션 브랜치가 아니어야). 견고한 병합 전략은 DESIGN_QUESTIONS Q4.
 */
import { join } from "node:path";
import { createWorktree, removeWorktree, type WorktreeInfo } from "./worktree.js";
import { compilePermissions, materializeSettings } from "./permissionCompiler.js";
import { compilePrompt } from "./promptCompiler.js";
import { collectDiff, summarizeDiff, type DiffPreview } from "./diffPreview.js";
import { runMachineGate, type GateResult } from "./machineGate.js";
import { runProcess } from "./runProcess.js";
import type { ExecutionProvider, SessionEvent, SessionSpec, SessionUsage } from "./types.js";
import type { Approver, Decision } from "./approvalQueue.js";

export interface RunSessionOpts {
  repoRoot: string;
  runId: string;
  spec: SessionSpec; // spec.cwd는 worktree 경로로 대체됨
  provider: ExecutionProvider;
  approver: Approver;
  baseBranch?: string; // 기본 develop
  onEvent?: (e: SessionEvent) => void; // StatusBoard/진행표시 훅
  merge?: boolean; // 승인 시 base 병합 (기본 true)
  keepWorktree?: boolean; // 기본 false (제거, 브랜치는 보존)
}

export type SessionStatus = "merged" | "rejected" | "deferred" | "gate_failed" | "no_changes" | "error";

export interface SessionOutcome {
  sessionId: string;
  branch: string;
  worktreePath: string;
  turns: number;
  events: number;
  usage: SessionUsage | null;
  gate: GateResult | null;
  diff: DiffPreview | null;
  decision: Decision | null;
  status: SessionStatus;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const r = await runProcess("git", ["-C", cwd, ...args]);
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
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
    decision: null,
    status: "error",
  };

  try {
    // 1) worktree + 전용 브랜치
    wt = await createWorktree({ repoRoot: opts.repoRoot, runId: opts.runId, sessionId: opts.spec.sessionId, baseBranch: base });
    outcome.branch = wt.branch;
    outcome.worktreePath = wt.path;

    // 2) 권한 컴파일 → settings materialize + 확정 spec
    //    settings는 worktree 밖(repoRoot/.harness — gitignore됨)에 써서 세션 diff를 오염시키지 않는다.
    const compiled = compilePermissions({ ...opts.spec, cwd: wt.path });
    const settingsPath = materializeSettings(join(opts.repoRoot, ".harness", "sessions", opts.spec.sessionId), compiled);
    const spec: SessionSpec = {
      ...opts.spec,
      cwd: wt.path,
      permissionMode: compiled.permissionMode,
      allowedTools: compiled.allow,
      disallowedTools: compiled.deny,
      settingsPath,
    };

    // 3) 착수 프롬프트 (worktree 내용 기준으로 inputs 해석)
    const prompt = compilePrompt(spec, { projectRoot: wt.path });

    // 4) 세션 실행 + 이벤트 관측
    const handle = await opts.provider.start(spec, prompt);
    for await (const e of opts.provider.events(handle)) {
      outcome.events++;
      if (e.kind === "assistant") outcome.turns++;
      if (e.kind === "result") outcome.usage = e.usage;
      opts.onEvent?.(e);
    }

    // 5) L1 기계 게이트
    outcome.gate = await runMachineGate({ cwd: wt.path });
    if (!outcome.gate.passed) {
      outcome.status = "gate_failed";
      return outcome;
    }

    // 6) 자기 브랜치에 커밋 (세션이 안 했으면 오케스트레이터가)
    await git(wt.path, ["add", "-A"]);
    const staged = await git(wt.path, ["diff", "--cached", "--name-only"]);
    if (staged.out) {
      await git(wt.path, ["commit", "-q", "-m", `session ${spec.sessionId}: ${spec.task ?? spec.role}`]);
    }

    // 7) diff 미리보기 (base 대비)
    outcome.diff = await collectDiff({ cwd: wt.path, base });
    if (outcome.diff.files.length === 0 && outcome.diff.untracked.length === 0) {
      outcome.status = "no_changes";
      return outcome;
    }

    // 8) 승인
    const decision = await opts.approver({
      sessionId: spec.sessionId,
      kind: "diff-merge",
      message: `세션 '${spec.sessionId}' 결과를 ${base}에 병합할까요?`,
      detail: summarizeDiff(outcome.diff),
    });
    outcome.decision = decision;
    if (decision === "reject") {
      outcome.status = "rejected";
      return outcome;
    }
    if (decision === "defer") {
      outcome.status = "deferred";
      return outcome;
    }

    // 9) 병합 (approve)
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
        /* 정리 실패는 무시 (worktree prune은 다음 실행에서) */
      }
    }
  }
}
