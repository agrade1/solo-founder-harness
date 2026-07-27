#!/usr/bin/env node
/**
 * V3 M5a — 결정론적 fake Codex CLI (테스트 전용).
 *
 * 실제 codex 추론·네트워크·인증은 전혀 하지 않는다. 하는 일은 두 가지뿐이다.
 *  1) 이번 invocation의 계약(argv · cwd · stdin · 상속된 env key)을 **cwd**의 `.fake-codex-invocation.json`에 기록
 *  2) **cwd**의 `.fake-codex-scenario.json`에 적힌 JSONL 줄들을 stdout에 흘리고 지정 코드로 종료
 *
 * 채널이 `CODEX_HOME`이 아니라 **cwd**인 이유: provider가 spawn 전에 `CODEX_HOME`이
 * **비어 있는 0700 디렉터리**임을 요구하므로(ambient config·auth 0), 거기에 파일을 쓰면 두 번째
 * invocation(resume)이 정당하게 거부된다. cwd는 argv `--cd`로 이미 전달되는 값이고
 * **테스트가 소유한 임시 git 체크아웃**이라 production 경로에서는 도달할 수 없다.
 * 새 env·argv 테스트 seam은 만들지 않는다.
 *
 * scenario: { "runs": [{ "lines": string[], "exitCode"?: number, "stderr"?: string, "selfSignal"?: string }] }
 *           또는 단일 run 객체. 여러 invocation이면 순서대로 소비한다(없으면 마지막 것을 반복).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.CODEX_HOME) {
  process.stderr.write("fake-codex: CODEX_HOME이 없다(격리 실패)\n");
  process.exit(64);
}

const cwd = process.cwd();
const invocationPath = join(cwd, ".fake-codex-invocation.json");

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const prior = existsSync(invocationPath) ? JSON.parse(readFileSync(invocationPath, "utf8")) : { calls: [] };
prior.calls.push({
  argv: process.argv.slice(2),
  cwd,
  stdin,
  envKeys: Object.keys(process.env).sort(),
});
writeFileSync(invocationPath, JSON.stringify(prior, null, 2));

let scenario = { runs: [{ lines: [], exitCode: 0 }] };
try {
  const parsed = JSON.parse(readFileSync(join(cwd, ".fake-codex-scenario.json"), "utf8"));
  scenario = Array.isArray(parsed.runs) ? parsed : { runs: [parsed] };
} catch {
  /* 시나리오가 없으면 조용히 종료 — silent stream 케이스 */
}

const index = Math.min(prior.calls.length - 1, scenario.runs.length - 1);
const run = scenario.runs[index] ?? { lines: [], exitCode: 0 };

for (const line of run.lines ?? []) process.stdout.write(`${line}\n`);
if (run.stderr) process.stderr.write(run.stderr);
if (run.selfSignal) {
  // 큰 write가 pipe에 남아 있을 수 있으므로 flush 뒤에 스스로 죽는다.
  process.stdout.write("", () => process.kill(process.pid, run.selfSignal));
} else {
  // `process.exit()`는 pipe로 가는 비동기 write를 잘라먹는다 — 자연 종료로 flush를 보장한다.
  process.exitCode = run.exitCode ?? 0;
}
