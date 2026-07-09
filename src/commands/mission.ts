import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "../core/paths.js";
import { ClaudeCliProvider } from "../exec/claudeCliProvider.js";
import { generateBrief } from "../exec/briefGenerator.js";
import { runMission, renderMissionReport } from "../exec/mission.js";

function askYes(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n${message} (y/N): `, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

/** harness mission --goal <g> [--base develop] [--yes] [--max-tasks n] [--review-rounds n] */
export async function runMissionCommand(opts: { goal: string; base?: string; yes?: boolean; maxTasks?: number; reviewRounds?: number }): Promise<void> {
  console.log(`미션: ${opts.goal}\n브리프 생성 중 (플래너 Opus)...`);
  const { brief } = await generateBrief({
    goal: opts.goal,
    provider: new ClaudeCliProvider(),
    sessionId: randomUUID(),
    cwd: WORKSPACE_ROOT,
    maxTasks: opts.maxTasks,
  });

  console.log(`\n=== 미션 브리프 (${brief.tasks.length} 태스크) ===`);
  for (const t of brief.tasks) {
    console.log(`- [${t.id}] (${t.role}) ${t.task}${t.deps?.length ? ` · deps: ${t.deps.join(",")}` : ""}${t.difficulty ? ` · ${t.difficulty}` : ""}`);
  }

  if (!opts.yes) {
    const ok = await askYes("이 브리프로 자율 실행할까요? (승인 후엔 develop 자동 병합, 사람 개입 없음)");
    if (!ok) {
      console.log("취소됨 — 실행하지 않음.");
      return;
    }
  }

  console.log("\n자율 실행 시작 (사람 개입 없음, 게이트 통과 시 develop 자동 병합)...\n");
  const report = await runMission({
    repoRoot: WORKSPACE_ROOT,
    brief,
    coderProvider: new ClaudeCliProvider(),
    reviewProvider: new ClaudeCliProvider(),
    baseBranch: opts.base,
    reviewRounds: opts.reviewRounds,
    onEvent: (id, e) => {
      if (e.kind === "init") console.log(`  [${id}] 시작 (${e.model})`);
      else if (e.kind === "result") console.log(`  [${id}] 종료 turns=${e.numTurns} in=${e.usage.inputTokens}/out=${e.usage.outputTokens}`);
      else if (e.kind === "rateLimit" && e.status !== "allowed") console.log(`  [${id}] ⚠ rate limit ${e.status} (resetsAt ${e.resetsAt})`);
    },
  });

  const md = renderMissionReport(report);
  const outDir = join(WORKSPACE_ROOT, "outputs");
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "MISSION_REPORT.md");
  writeFileSync(path, md, "utf8");

  console.log(`\n${md}`);
  console.log(`MISSION_REPORT: ${path}`);
}
