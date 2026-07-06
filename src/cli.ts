#!/usr/bin/env node
import { Command } from "commander";
import { runList } from "./commands/list.js";
import { runInit } from "./commands/init.js";
import { runRun } from "./commands/run.js";
import { runSummary } from "./commands/summary.js";
import { runTaskPrompt } from "./commands/taskPrompt.js";

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
  .description("workflow를 순서대로 실행하고 결과를 저장한다")
  .action(async (workflowName: string, opts: { project: string; provider: string }) => {
    await runRun(workflowName, opts.project, opts.provider);
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

program.parse();
