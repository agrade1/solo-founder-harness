/**
 * L1 기계 게이트 (ARCH §4.1) — typecheck / lint / test / build 를 실행해 객관적 통과 여부를 낸다.
 * "협상 불가 바닥": 하나라도 실패면 게이트 실패 → develop 병합 차단.
 *
 * 존재하지 않는 스크립트는 skip(실패 아님) — 프로젝트마다 lint 등이 없을 수 있으므로.
 * 게이트 자체는 실행만; 실패 시 revise 주입/보류 판단은 오케스트레이터(§9-6~7).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "./runProcess.js";

export interface GateCheck {
  name: string;
  command: string;
  args: string[];
}

export interface GateCheckResult {
  name: string;
  command: string;
  ok: boolean;
  skipped: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string; // stdout+stderr 꼬리 (진단용)
}

export interface GateResult {
  passed: boolean;
  checks: GateCheckResult[];
}

/** L1 표준 순서. package.json scripts에 존재하는 것만 대상(없으면 skip). */
const STANDARD = [
  { name: "typecheck", script: "typecheck" },
  { name: "lint", script: "lint" },
  { name: "test", script: "test" },
  { name: "build", script: "build" },
] as const;

/** package.json scripts를 읽어 표준 체크를 npm-run 명령으로 구성. */
export function defaultChecks(cwd: string): GateCheck[] {
  const pkgPath = join(cwd, "package.json");
  let scripts: Record<string, string> = {};
  if (existsSync(pkgPath)) {
    try {
      scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
    } catch {
      scripts = {};
    }
  }
  const checks: GateCheck[] = [];
  for (const s of STANDARD) {
    if (scripts[s.script]) {
      checks.push({ name: s.name, command: "npm", args: ["run", s.script, "--silent"] });
    }
  }
  return checks;
}

/** 출력 꼬리 일부만 보관(로그 폭주 방지). */
function tail(s: string, n = 2000): string {
  return s.length > n ? s.slice(-n) : s;
}

export interface RunGateOpts {
  cwd: string;
  checks?: GateCheck[]; // 미지정 시 defaultChecks(cwd)
  timeoutMs?: number; // 체크당 상한
  env?: NodeJS.ProcessEnv;
}

/**
 * 게이트 실행. 각 체크를 순서대로 돌리고 하나라도 실패면 passed=false.
 * 대상 스크립트가 하나도 없으면 checks=[] 이며 passed=true(막을 근거 없음) — skipped로 드러난다.
 */
export async function runMachineGate(opts: RunGateOpts): Promise<GateResult> {
  const checks = opts.checks ?? defaultChecks(opts.cwd);
  const results: GateCheckResult[] = [];
  for (const c of checks) {
    try {
      const r = await runProcess(c.command, c.args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: opts.env });
      results.push({
        name: c.name,
        command: `${c.command} ${c.args.join(" ")}`,
        ok: r.code === 0,
        skipped: false,
        exitCode: r.code,
        durationMs: r.durationMs,
        output: tail(r.stdout + r.stderr),
      });
    } catch (err) {
      // spawn 실패/타임아웃 = 실패로 처리
      results.push({
        name: c.name,
        command: `${c.command} ${c.args.join(" ")}`,
        ok: false,
        skipped: false,
        exitCode: null,
        durationMs: 0,
        output: (err as Error).message,
      });
    }
  }
  const passed = results.every((r) => r.ok || r.skipped);
  return { passed, checks: results };
}
