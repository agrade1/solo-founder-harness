#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { runList } from "./commands/list.js";
import { runInit } from "./commands/init.js";
import { runRun } from "./commands/run.js";
import { runSummary } from "./commands/summary.js";
import { runTaskPrompt } from "./commands/taskPrompt.js";
import { runExec } from "./commands/exec.js";
import { runMissionCommand } from "./commands/mission.js";
import { runHandoffCommand } from "./commands/handoff.js";
import { approveCheckpoint, nextPipeline, rejectCheckpoint, restartPipeline, statusPipeline, unlockPipeline } from "./commands/pipeline.js";
import { stdinApprover } from "./commands/approver.js";
import { createProgressReporter } from "./commands/progress.js";
import { DEFAULT_PIPELINE } from "./core/pipeline.js";
import { AUTOPILOT_WORKER_BACKENDS, runAutopilotCommand } from "./commands/autopilot.js";
import { runAutopilotCreateCommand } from "./commands/autopilotCreate.js";
import { PLAN_DAG_TASK_ID, runPlanDagCommand, runValidateDagCommand } from "./commands/planDag.js";
import { DEFAULT_DRAFT_FILE, runDraftApprovalCommand, runValidateApprovalCommand } from "./commands/draftApproval.js";

// 버전 단일 원본: package.json. dev(tsx src/cli.ts)·dist(dist/cli.js) 모두
// import.meta.url 기준 ../package.json = 레포 루트로 해석되어 드리프트가 구조상 불가능.
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };

const program = new Command();

/** 도움말에 싣는 단계 id 목록 — 상수에서 파생한다(손으로 옮겨 적은 사본을 만들지 않는다). */
const PIPELINE_STAGE_IDS = DEFAULT_PIPELINE.map((s) => s.id);

program
  .name("harness")
  .description("Solo Founder AI Harness (문서 자동화 + 실행 계층 exec/mission)")
  .version(pkg.version);

program
  .command("list")
  .description("core agents와 workflows 목록을 출력한다")
  .action(() => {
    runList();
  });

program
  .command("init")
  .argument("<projectName>", "생성할 프로젝트 이름")
  .description("프로젝트 폴더와 필수 docs/outputs를 생성한다")
  .action((projectName: string) => {
    runInit(projectName);
  });

program
  .command("run")
  .argument("<workflowName>", "실행할 workflow id")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .option("--provider <id>", "LLM provider (mock | claude-code | anthropic)", "mock")
  .option("--max-regen <n>", "스키마 실패 시 재생성 상한 (기본 1)", "1")
  .option("--allow-spawn", "동적 분화된 하위 에이전트를 실제 실행 (기본: 계획만)", false)
  .option("--vault <path>", "실행 결과를 Obsidian vault로 export (frontmatter + wikilink). 미지정 시 HARNESS_VAULT 환경변수 사용")
  .option("--resume", "이전 실패 지점부터 재개 (outputs/run_state.json status=failed일 때)", false)
  .option("--max-tokens <n>", "누적 토큰(input+output) 상한. 초과 시 step 경계에서 중단(--resume 재개 가능). 미지정 시 HARNESS_MAX_TOKENS, 기본 무제한")
  .option("--yes", "승인 게이트를 비대화로 전부 승인 (CI/스크립트)", false)
  .option("--tool-profile <id>", "[v3-M2] 활성 도구 profile (registry/tool_profiles.json). 지정 시 run 시작 전 fail-fast 검증")
  .option("--bare", "[v3-M2] planning 격리(--strict-mcp-config + 내장도구 제한) 정책으로 컴파일", false)
  .option("--handoff", "[v3-M3b.2] run 완료(completed) 후 서비스 레포에서 Claude Code 대화형 세션을 연다 (승인 게이트·headless preflight 통과 후)", false)
  .option("--cwd <serviceRepo>", "[v3-M3b.2] --handoff 대상 서비스 레포 경로 (기본: 현재 디렉터리)")
  .option("--handoff-tool-profile <id>", "[v3-M3c.3b] --handoff 세션에 적용할 MCP tool profile (파일럿: handoff-shadcn-readonly). workflow용 --tool-profile과 별개")
  .description("workflow를 순서대로 실행하고 결과를 저장한다")
  .action(async (workflowName: string, opts: { project: string; provider: string; maxRegen: string; allowSpawn: boolean; vault?: string; resume: boolean; maxTokens?: string; yes: boolean; toolProfile?: string; bare: boolean; handoff: boolean; cwd?: string; handoffToolProfile?: string }) => {
    const maxTokens = Number(opts.maxTokens ?? process.env.HARNESS_MAX_TOKENS ?? 0) || 0;
    await runRun(workflowName, opts.project, opts.provider, Number(opts.maxRegen), opts.allowSpawn, opts.vault, opts.resume, maxTokens, opts.yes, opts.toolProfile, opts.bare, opts.handoff, opts.cwd, opts.handoffToolProfile);
  });

// [B-41] **단계 체크포인트 오케스트레이션.** 각 단계가 끝나면 사람이 문서를 확인하고 승인해야
// 다음 단계가 돈다 — 활성 파이프라인에서 workflow 실행은 lock을 쥔 `pipeline next` 안에서만 일어나고(일반 `run`은
// `pipeline_run_reserved`로 거부), 체크포인트에는 `--yes`/`--force`가 **없다**(그것이 이 기능의 존재 이유다).
const pipeline = program
  .command("pipeline")
  .description(
    `[B-41] 고정 파이프라인(${PIPELINE_STAGE_IDS.join(" → ")})을 단계별로 전진시킨다 — 단계마다 사람이 산출물을 확인·승인해야 다음이 돈다 (승인 우회 플래그 없음)`,
  );

pipeline
  .command("status")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .description("현재 단계·확인 대기 체크포인트·영수증을 출력한다 (읽기 전용 · lock 중에도 읽힌다)")
  .action((opts: { project: string }) => {
    statusPipeline({ project: opts.project });
  });

pipeline
  .command("next")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .option("--provider <id>", "LLM provider (mock | claude-code | anthropic)", "mock")
  .option("--max-tokens <n>", "누적 토큰(input+output) 상한. 미지정 시 HARNESS_MAX_TOKENS, 기본 무제한")
  .option("--vault <path>", "실행 결과를 Obsidian vault로 export. 미지정 시 HARNESS_VAULT")
  .option(
    "--yes-internal-gates",
    "workflow **내부** 승인 step(디자인 게이트 등)만 비대화로 승인한다 (CI용). 단계 체크포인트는 이 플래그로 통과되지 않는다 — approve 명령만이 판정한다",
    false,
  )
  .description("현 단계를 실행하고 **확인 대기**로 들어간다 (이미 대기 중이면 전진하지 않고 안내만 낸다)")
  .action(async (opts: { project: string; provider: string; maxTokens?: string; vault?: string; yesInternalGates: boolean }) => {
    const maxTokens = Number(opts.maxTokens ?? process.env.HARNESS_MAX_TOKENS ?? 0) || 0;
    await nextPipeline({
      project: opts.project,
      provider: opts.provider,
      maxTokens,
      vault: opts.vault,
      // 플래그는 여기서 **workflow 내부 approver로만** 변환된다. 체크포인트 전이 함수에는
      // approver·boolean 인자가 아예 없으므로 이 값이 그쪽에 닿으려면 컴파일이 먼저 깨진다.
      internalApprover: opts.yesInternalGates ? async () => true : stdinApprover,
      reporter: createProgressReporter(),
    });
  });

pipeline
  .command("approve")
  .argument("<stage>", `승인할 단계 id (${PIPELINE_STAGE_IDS.join(" | ")})`)
  .requiredOption("--checkpoint <id>", "확인한 산출물의 checkpoint id (status가 출력한 12-hex — 바이트 신원)")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .description("확인 대기 중인 단계를 승인하고 다음 단계로 넘긴다 (stage와 checkpoint id가 모두 일치해야 한다)")
  .action((stage: string, opts: { checkpoint: string; project: string }) => {
    approveCheckpoint({ project: opts.project, stage, checkpointId: opts.checkpoint });
  });

pipeline
  .command("reject")
  .argument("<stage>", `되돌릴 단계 id (${PIPELINE_STAGE_IDS.join(" | ")})`)
  .requiredOption("--checkpoint <id>", "되돌릴 산출물의 checkpoint id")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .option("--note <text>", "되돌리는 이유 (영수증에 남는다)")
  .description("확인 대기 중인 단계를 되돌린다 — 같은 단계를 다시 실행한다 (기존 run을 채택하지 않는다)")
  .action((stage: string, opts: { checkpoint: string; project: string; note?: string }) => {
    rejectCheckpoint({ project: opts.project, stage, checkpointId: opts.checkpoint, note: opts.note });
  });

pipeline
  .command("restart")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .description("종료된(killed/completed) 파이프라인을 처음부터 다시 세운다 — 기존 state는 지우지 않고 rename 보관. 진행 중이면 거부")
  .action((opts: { project: string }) => {
    restartPipeline({ project: opts.project });
  });

pipeline
  .command("unlock")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .description("죽은 owner의 pipeline lock만 회수한다 (살아 있음·판별 불가는 거부 · 강제 플래그 없음)")
  .action((opts: { project: string }) => {
    unlockPipeline({ project: opts.project });
  });

program
  .command("handoff")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .option("--cwd <serviceRepo>", "핸드오프할 서비스 레포 경로 (기본: 현재 디렉터리)")
  .option("--print", "실행·preflight·상태 변경 없이 셸 재진입 명령만 출력 (원격/tmux 탈출구)", false)
  .option("--yes", "승인 게이트를 스킵하고 바로 세션을 연다", false)
  .option("--tool-profile <id>", "[v3-M3c.3b] MCP tool profile (파일럿: handoff-shadcn-readonly). 미지정 시 기존 empty-MCP 경로")
  .description("[v3-M3b.2] 완료된 판단 문서를 근거로 Claude Code 대화형 세션을 연다 (headless preflight 통과 후)")
  .action(async (opts: { project: string; cwd?: string; print: boolean; yes: boolean; toolProfile?: string }) => {
    await runHandoffCommand({ project: opts.project, cwd: opts.cwd, print: opts.print, yes: opts.yes, toolProfileId: opts.toolProfile });
  });

program
  .command("summary")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .description("CONTEXT_SUMMARY.md를 갱신한다")
  .action((opts: { project: string }) => {
    runSummary(opts.project);
  });

program
  .command("task-prompt")
  .requiredOption("--project <projectName>", "대상 프로젝트 이름")
  .description("Claude Code 작업 지시문을 생성한다")
  .action((opts: { project: string }) => {
    runTaskPrompt(opts.project);
  });

program
  .command("exec")
  .description("[v3] 실행 세션 1개를 worktree에서 돌려 게이트·승인 후 base에 병합한다 (실제 claude 구독 토큰 사용)")
  .requiredOption("--task <task>", "세션이 완수할 작업")
  .option("--role <role>", "세션 역할 설명")
  .option("--base <branch>", "병합 기준 브랜치", "develop")
  .option("--session-id <uuid>", "세션 ID 사전 지정 (기본 자동 생성)")
  .option("--input <path...>", "참고 문서 경로 (API_CONTRACT는 인라인)")
  .option("--yes", "모든 승인 자동 통과 (비대화)", false)
  .option("--keep-worktree", "종료 후 worktree 보존", false)
  .option("--no-merge", "승인해도 병합하지 않음 (diff까지만)")
  .option("--review", "L3 Opus 리뷰어 세션 실행 (Critical 시 revise 루프)", false)
  .option("--review-rounds <n>", "리뷰 최대 라운드 (기본 2)", (v) => parseInt(v, 10))
  .action(async (opts: { task: string; role?: string; base: string; sessionId?: string; input?: string[]; yes: boolean; keepWorktree: boolean; merge: boolean; review: boolean; reviewRounds?: number }) => {
    await runExec({
      task: opts.task,
      role: opts.role,
      base: opts.base,
      sessionId: opts.sessionId,
      inputs: opts.input,
      yes: opts.yes,
      keepWorktree: opts.keepWorktree,
      merge: opts.merge,
      review: opts.review,
      reviewRounds: opts.reviewRounds,
    });
  });

program
  .command("mission")
  .description("[v3.5] 목표를 태스크로 분해→승인→자율 완주(게이트·리뷰·develop 자동 병합)→MISSION_REPORT")
  .requiredOption("--goal <goal>", "미션 목표")
  .option("--base <branch>", "병합 기준 브랜치", "develop")
  .option("--yes", "브리프 자동 승인 (비대화)", false)
  .option("--max-tasks <n>", "브리프 태스크 상한", (v) => parseInt(v, 10))
  .option("--review-rounds <n>", "태스크당 L3 리뷰 최대 라운드", (v) => parseInt(v, 10))
  .option("--parallel", "[v4] 의존 없는 태스크를 병렬 세션으로 동시 실행 (직렬 병합)", false)
  .option("--concurrency <n>", "병렬 모드 동시 세션 상한 (기본 3)", (v) => parseInt(v, 10))
  .action(async (opts: { goal: string; base: string; yes: boolean; maxTasks?: number; reviewRounds?: number; parallel: boolean; concurrency?: number }) => {
    await runMissionCommand({ goal: opts.goal, base: opts.base, yes: opts.yes, maxTasks: opts.maxTasks, reviewRounds: opts.reviewRounds, parallel: opts.parallel, concurrency: opts.concurrency });
  });

// **무인 loop의 진입점 두 개.** `autopilot-create`가 승인·DAG 문서를 run으로 만들고,
// `autopilot`이 그 run을 전진시킨다. 승인은 사람이 파일로 쓰고 harness는 검증·구속만 한다.
program
  .command("autopilot-create")
  .description("[v3-M11] 사람이 authoring한 승인 manifest + task DAG 문서로 orchestration run을 만든다 (승인을 발행하지 않는다 — 계약 위반은 fail closed)")
  .requiredOption("--run <runId>", "만들 orchestration run id")
  .requiredOption("--milestone <id>", "승인 milestone (승인 파일의 milestoneId와 같아야 한다)")
  .requiredOption("--approval <path>", "승인 manifest JSON 파일 (schemas/milestone_approval_manifest.schema.json)")
  .requiredOption("--dag <path>", "task DAG 문서 JSON 파일")
  .option("--workspace <path>", "orchestration workspace 루트 (기본: 현재 디렉터리)")
  .action((opts: { run: string; milestone: string; approval: string; dag: string; workspace?: string }) => {
    runAutopilotCreateCommand(opts);
  });

// **아이디어 → DAG 문서 초안**(L2a). `autopilot-create`가 사람이 쓴 DAG 파일을 받는 자리에서,
// 이 명령은 그 DAG 문서 자체를 **하네스가 만들게 하는 run**을 세운다. 승인은 여전히 사람이 쓴다.
program
  .command("plan-dag")
  .description(
    `[v3-M12] 아이디어 문서 + 승인 manifest로 "DAG 문서 초안을 쓰는" 단일 task run을 만든다 (승인을 발행하지 않는다 · 초안을 자동 실행하지 않는다 · 승인의 ownershipByTask["${PLAN_DAG_TASK_ID}"]와 write_file 권위가 필요하다)`,
  )
  .requiredOption("--run <runId>", "만들 orchestration run id")
  .requiredOption("--milestone <id>", "승인 milestone (승인 파일의 milestoneId와 같아야 한다)")
  .requiredOption("--approval <path>", "승인 manifest JSON 파일 (사람이 쓴다)")
  .requiredOption("--idea <path>", "아이디어 문서 (내용이 지시 본문에 그대로 실린다 — 상한 초과는 fail closed, 자르지 않는다)")
  .option("--workspace <path>", "orchestration workspace 루트 (기본: 현재 디렉터리)")
  .action((opts: { run: string; milestone: string; approval: string; idea: string; workspace?: string }) => {
    runPlanDagCommand(opts);
  });

program
  .command("validate-dag")
  .description("[v3-M12] task DAG 문서(초안 포함)가 문서 계약을 지키는지 판정한다 — 읽기 전용이며 파일을 고치거나 지우지 않는다")
  .argument("<file>", "판정할 DAG 문서 JSON 파일")
  .action((file: string) => {
    runValidateDagCommand({ file });
  });

// **DAG → 승인 초안**(L2b). `plan-dag`가 DAG 문서를 만들게 했다면, 이쪽은 그 DAG를 돌리는 데 필요한
// 승인 manifest의 **기계적으로 파생되는 부분만** 초안으로 뽑는다. 권위-의미 필드는 sentinel이고
// 그것을 사람이 채우기 전에는 `validateApprovalManifest`를 지나지 못한다(= 이 명령은 승인을 발행하지 않는다).
program
  .command("draft-approval")
  .description(
    "[v3-M12] 검증된 task DAG 문서에서 승인 manifest **초안**을 만든다 (승인을 발행하지 않는다 — 만료·예산·커밋·정책 시간값·실행 파일 digest·쓰기 상한은 sentinel이라 사람이 채우기 전에는 검증기를 통과하지 못한다 · PATH 자동 발견 없음)",
  )
  .requiredOption("--dag <path>", "task DAG 문서 JSON 파일 (validateTaskDag를 통과해야 한다)")
  .requiredOption("--milestone <id>", "승인 milestone id")
  .option("--out <path>", `초안 출력 경로 (기본 ${DEFAULT_DRAFT_FILE} · 이름에 "draft"가 있어야 하고 기존 파일을 덮어쓰지 않는다)`)
  // 실행 파일은 **명시한 경로에서만** digest를 계산한다. 플래그가 없으면 그 자리도 sentinel이다 —
  // 시스템에서 찾아 주지 않는다(ambient 발견이 곧 승인 우회 통로다).
  .option("--claude <path>", "승인할 claude 실행 파일의 정규 절대경로 (미지정 시 sentinel)")
  .option("--git <path>", "승인할 git 실행 파일의 정규 절대경로 (미지정 시 sentinel)")
  .option("--node <path>", "승인할 node 실행 파일의 정규 절대경로 (미지정 시 sentinel)")
  .option("--process-observer <path>", "승인할 프로세스 관측 실행 파일(ps)의 정규 절대경로 (미지정 시 sentinel)")
  .option("--controller-entrypoint <path>", "승인할 controller entrypoint script의 정규 절대경로 (미지정 시 sentinel)")
  .action((opts: { dag: string; milestone: string; out?: string; claude?: string; git?: string; node?: string; processObserver?: string; controllerEntrypoint?: string }) => {
    runDraftApprovalCommand(opts);
  });

program
  .command("validate-approval")
  .description("[v3-M12] 승인 manifest(초안 포함)가 계약을 지키고 채우지 않은 자리가 없는지 판정한다 — 읽기 전용이며 파일을 고치거나 지우지 않는다")
  .argument("<file>", "판정할 승인 manifest JSON 파일")
  .action((file: string) => {
    runValidateApprovalCommand({ file });
  });

program
  .command("autopilot")
  .description("[v3-M5c] 승인 manifest 하나로 gate된 durable run을 worker backend로 전진시킨다")
  .requiredOption("--run <runId>", "대상 orchestration run id")
  .requiredOption("--milestone <id>", "이 실행이 근거로 삼는 승인 milestone (durable run과 다르면 시작하지 않는다)")
  .option("--plan-dir <path>", `task별 offline 계획 JSON 디렉터리 (<planDir>/<taskId>.json). --worker-backend ${AUTOPILOT_WORKER_BACKENDS[0]}에서 필수이고 그 밖에서는 읽히지 않는다`)
  // 문구는 증명한 것까지만 적는다: `claude-plan`이 실제 모델 세션을 돌린다는 것과, 승인이 없으면
  // 시작하지 않는다는 것. 그 세션이 무엇을 할 수 있는지는 여기서 주장하지 않는다.
  .option(
    "--worker-backend <id>",
    `worker backend (${AUTOPILOT_WORKER_BACKENDS.join(" | ")}). 기본 ${AUTOPILOT_WORKER_BACKENDS[0]}. ${AUTOPILOT_WORKER_BACKENDS[1]}은 실제 모델 세션을 돌리며(구독 한도 소모) 승인 manifest의 executionAuthority.claude가 없으면 시작하지 않는다`,
  )
  .option("--workspace <path>", "orchestration workspace 루트 (기본: 현재 디렉터리)")
  .option("--max-iterations <n>", `loop 상한 (기본·최대 ${16})`)
  .option("--json", "진행 이벤트를 NDJSON으로 출력", false)
  .action(async (opts: { run: string; milestone: string; planDir?: string; workerBackend?: string; workspace?: string; maxIterations?: string; json: boolean }) => {
    await runAutopilotCommand(opts);
  });

program.parse();
