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
import { createHash } from "node:crypto";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
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
  onPhase?: (phase: SessionPhase) => void; // StatusBoard용 단계 전이 훅
  merge?: boolean; // 승인 시 base 병합 (기본 true)
  keepWorktree?: boolean; // 기본 false (제거, 브랜치 보존)
  review?: { provider: ExecutionProvider; maxRounds?: number; model?: string }; // L3 리뷰어(있으면 실행)
}

export type SessionStatus =
  | "merged"
  | "rejected"
  | "deferred"
  | "gate_failed"
  | "review_deferred"
  | "no_changes"
  /**
   * [B-56] **코더 세션 자체가 실패로 끝났다** (프로세스 non-zero 종료 또는 `result.isError`).
   * 예전엔 이 신호가 이벤트 스트림에서 **세어지기만 하고 버려졌다.** 그래서 중간에 죽은 세션이
   * 게이트로 넘어갔고, 대상 레포에 npm 스크립트가 하나도 없으면 그 게이트가 빈 채로 통과해
   * **부분 산출물이 develop에 병합됐다**(실측 재현: 두 실패 모드 모두 `merged`).
   */
  | "coder_failed"
  /**
   * [B-59] **담당 경로(`spec.ownership`) 밖의 파일을 고쳤다.**
   *
   * 예전엔 이 경계가 **어디서도 집행되지 않았다**: `permissionCompiler`가 `ownership`을 컴파일해
   * `CompiledPermissions.ownership`에 담지만 그것을 읽는 비-테스트 코드가 하나도 없고(grep 확정),
   * `settings.json`의 `allow`/`ask`/`deny` 어디에도 그 경로가 등장하지 않는다(실측). 정책의
   * `T1_bounded`가 `Edit`/`Write`/`MultiEdit`를 **경로 제약 없이** allow에 넣고 `permissionMode`는
   * `acceptEdits`다. 그런데도 task 문서는 "소유(쓰기 허용) 경로"라고 적어 **강제성을 주장했다.**
   * worktree는 관례적 격리이지 파일시스템 봉쇄가 아니다.
   *
   * (v3 커널 경로는 무관하다 — 거기선 `stableController`가 durable ownership을 실제로 집행한다.)
   */
  | "ownership_violation"
  | "error";
export type SessionPhase = "coding" | "gate" | "review" | "merging" | "done";

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

  /**
   * 한 turn의 이벤트를 소진하며 카운트/usage 갱신.
   *
   * [B-56] **실패 신호를 여기서 잡는다.** provider는 실패를 이벤트로만 말한다 — 프로세스가
   * non-zero로 죽으면 `unknown/exit_error`(`claudeCliProvider.ts`), 세션이 오류로 끝나면
   * `result.isError`다. 예전엔 둘 다 `outcome.events++`로만 세고 버려서, 죽은 세션이 그대로
   * 게이트·승인·병합으로 넘어갔다. 반환값이 실패 사유이고, 호출자가 **게이트 전에** 멈춘다.
   */
  async function consumeTurn(handle: SessionHandle): Promise<string | null> {
    let failure: string | null = null;
    for await (const e of opts.provider.events(handle)) {
      outcome.events++;
      if (e.kind === "assistant") outcome.turns++;
      if (e.kind === "result") {
        outcome.usage = e.usage;
        // 마지막 result가 이긴다: revise 루프에서 앞 turn이 실패했어도 뒤 turn이 성공하면 진행한다.
        failure = e.isError ? `코더 세션이 오류로 끝났습니다: ${e.text.slice(0, 200)}` : null;
      }
      if (e.kind === "unknown" && e.type === "exit_error") {
        const code = (e.raw as { code?: unknown }).code;
        const stderr = String((e.raw as { stderr?: unknown }).stderr ?? "").slice(0, 200);
        failure = `코더 프로세스가 비정상 종료했습니다 (exit ${String(code)})${stderr ? `: ${stderr}` : ""}`;
      }
      opts.onEvent?.(e);
    }
    return failure;
  }

  /**
   * [B-59] 담당 경로 밖 변경을 찾는다. `spec.ownership`이 비어 있으면 **아무것도 막지 않는다** —
   * 선언되지 않은 경계를 지어내면 기존 세션이 전부 깨진다(경계가 없는 것과 "밖이 없는 것"은 다르다).
   *
   * ponytail: glob 전체가 아니라 **접두 매칭**이다 — 계약이 쓰는 모양(`src/api/**`·정확한 경로)을
   * 덮는다. `src/*.ts`처럼 중간 와일드카드가 필요해지면 그때 matcher를 넣는다(지금은 없는 요구다).
   */
  const ownershipViolations = (): string[] => {
    const own = (opts.spec.ownership ?? []).map((o) => o.replace(/\/\*\*$/, "").replace(/\/\*$/, "").replace(/\/$/, ""));
    if (own.length === 0 || !outcome.diff) return [];
    const changed = [...outcome.diff.files.map((f) => f.path), ...outcome.diff.untracked];
    return changed.filter((p) => !own.some((o) => p === o || p.startsWith(`${o}/`)));
  };

  /** [B-56] 코더 실패는 게이트·승인·병합 **앞에서** 끝난다 — 부분 산출물을 병합하지 않는다. */
  const coderFailed = (why: string): SessionOutcome => {
    outcome.status = "coder_failed";
    outcome.error = `${why} — 산출물이 불완전할 수 있어 게이트·병합으로 넘기지 않았습니다 (브랜치 ${outcome.branch}는 남습니다).`;
    return outcome;
  };

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

    // STATUS.md는 세션 내부 통신 파일(ARCH §3.3) — 산출물 아님. 공용 git exclude에 넣어
    // 커밋·병합·diff에서 제외한다(병렬 세션 간 STATUS.md add/add 충돌 방지).
    try {
      const ex = join(opts.repoRoot, ".git", "info", "exclude");
      if (existsSync(ex) && !readFileSync(ex, "utf8").split("\n").includes("STATUS.md")) appendFileSync(ex, "STATUS.md\n");
    } catch {
      /* best-effort */
    }

    // 2) 권한 컴파일 → settings materialize(worktree 밖, gitignore) + 확정 spec
    const compiled = compilePermissions({ ...opts.spec, cwd: wt.path });
    const settingsPath = materializeSettings(join(opts.repoRoot, ".harness", "sessions", opts.spec.sessionId), compiled);
    const spec: SessionSpec = { ...opts.spec, cwd: wt.path, permissionMode: compiled.permissionMode, allowedTools: compiled.allow, disallowedTools: compiled.deny, settingsPath };

    // 3) 착수 프롬프트 (worktree 내용 기준)
    const prompt = compilePrompt(spec, { projectRoot: wt.path });

    // 4) 코더 세션 실행
    opts.onPhase?.("coding");
    const handle = await opts.provider.start(spec, prompt);
    const coderFailure = await consumeTurn(handle);
    if (coderFailure) return coderFailed(coderFailure);

    // 5) L1 게이트 + 커밋 + diff
    opts.onPhase?.("gate");
    let fin = await finalize();
    if (!fin.gatePassed) return ((outcome.status = "gate_failed"), outcome);
    if (!fin.hasChanges) return ((outcome.status = "no_changes"), outcome);

    // [B-59] 담당 경계는 **리뷰·승인·병합 앞에서** 본다. 부분 병합은 하지 않는다 —
    // 담당 밖을 건드린 세션은 그 변경만 떼어내도 나머지가 그것을 전제로 쓰였을 수 있다.
    const outside = ownershipViolations();
    if (outside.length > 0) {
      outcome.status = "ownership_violation";
      outcome.error =
        `담당 경로(ownership) 밖 변경 ${outside.length}건: ${outside.slice(0, 10).join(", ")}${outside.length > 10 ? " …" : ""} — ` +
        `선언된 담당은 ${(opts.spec.ownership ?? []).join(", ")}입니다. 병합하지 않았습니다 (브랜치 ${outcome.branch}는 남습니다).`;
      return outcome;
    }

    // 6) L3 리뷰어 루프 (critique_loop 이식) — 있을 때만
    if (opts.review) {
      opts.onPhase?.("review");
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
          // 리뷰어가 "무엇을 봤는지"를 호출자 기대값에 묶는다(M5b A5 — 본문 자기 주장만으로는 통과 없음).
          subject: { revision: wt.branch, hash: createHash("sha256").update(outcome.diff!.raw).digest("hex") },
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
        const reviseFailure = await consumeTurn(handle);
        if (reviseFailure) return coderFailed(reviseFailure); // revise 중 죽어도 같다
        fin = await finalize();
        if (!fin.gatePassed) return ((outcome.status = "gate_failed"), outcome);
        // [B-59] **revise도 담당 밖으로 새어 나갈 수 있다.** 첫 turn만 검사하면 리뷰 되먹임이
        // 경계를 우회하는 통로가 된다 — 같은 말을 하는 자리를 놓치지 않는다(B-58의 교훈).
        const reviseOutside = ownershipViolations();
        if (reviseOutside.length > 0) {
          outcome.status = "ownership_violation";
          outcome.error =
            `revise 후 담당 경로 밖 변경 ${reviseOutside.length}건: ${reviseOutside.slice(0, 10).join(", ")} — ` +
            `선언된 담당은 ${(opts.spec.ownership ?? []).join(", ")}입니다. 병합하지 않았습니다.`;
          return outcome;
        }
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
      opts.onPhase?.("merging");
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
    opts.onPhase?.("done");
    if (wt && !opts.keepWorktree) {
      try {
        await removeWorktree({ repoRoot: opts.repoRoot, info: wt });
      } catch {
        /* 정리 실패 무시 */
      }
    }
  }
}
