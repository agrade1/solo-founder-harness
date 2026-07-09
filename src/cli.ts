#!/usr/bin/env node
import { Command } from "commander";
import { runList } from "./commands/list.js";
import { runInit } from "./commands/init.js";
import { runRun } from "./commands/run.js";
import { runSummary } from "./commands/summary.js";
import { runTaskPrompt } from "./commands/taskPrompt.js";
import { runExec } from "./commands/exec.js";
import { runMissionCommand } from "./commands/mission.js";

const program = new Command();

program
  .name("harness")
  .description("Solo Founder AI Harness v1 (mock provider CLI)")
  .version("0.1.0");

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
  .description("workflow를 순서대로 실행하고 결과를 저장한다")
  .action(async (workflowName: string, opts: { project: string; provider: string; maxRegen: string; allowSpawn: boolean; vault?: string; resume: boolean; maxTokens?: string; yes: boolean }) => {
    const maxTokens = Number(opts.maxTokens ?? process.env.HARNESS_MAX_TOKENS ?? 0) || 0;
    await runRun(workflowName, opts.project, opts.provider, Number(opts.maxRegen), opts.allowSpawn, opts.vault, opts.resume, maxTokens, opts.yes);
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

program.parse();
