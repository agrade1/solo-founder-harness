#!/usr/bin/env node
/**
 * V3 M5a — 결정론적 fake Codex CLI (테스트 전용).
 *
 * 실제 codex 추론·네트워크·인증은 전혀 하지 않는다. 하는 일은 두 가지뿐이다.
 *  1) 이번 invocation의 계약(argv · cwd · stdin · 상속된 env key)을 `$CODEX_HOME/invocation.json`에 기록
 *  2) `$CODEX_HOME/scenario.json`에 적힌 JSONL 줄들을 stdout에 그대로 흘리고 지정 코드로 종료
 *
 * 격리 디렉터리(`CODEX_HOME`)를 채널로 쓰므로 테스트 전용 env·argv seam을 새로 만들지 않는다
 * (provider가 자식에게 넘기는 env는 PATH·CODEX_HOME 둘뿐이다).
 *
 * scenario.json: { "lines": string[], "exitCode"?: number, "stderr"?: string, "selfSignal"?: string }
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
if (!home) {
  process.stderr.write("fake-codex: CODEX_HOME이 없다(격리 실패)\n");
  process.exit(64);
}

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

writeFileSync(
  join(home, "invocation.json"),
  JSON.stringify(
    {
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      stdin,
      envKeys: Object.keys(process.env).sort(),
    },
    null,
    2,
  ),
);

let scenario = { lines: [], exitCode: 0, stderr: "" };
try {
  scenario = JSON.parse(readFileSync(join(home, "scenario.json"), "utf8"));
} catch {
  /* 시나리오가 없으면 조용히 종료 — silent stream 케이스 */
}

for (const line of scenario.lines ?? []) process.stdout.write(`${line}\n`);
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.selfSignal) {
  // 큰 write가 pipe에 남아 있을 수 있으므로 flush 뒤에 스스로 죽는다.
  process.stdout.write("", () => process.kill(process.pid, scenario.selfSignal));
} else {
  // `process.exit()`는 pipe로 가는 비동기 write를 잘라먹는다 — 자연 종료로 flush를 보장한다.
  process.exitCode = scenario.exitCode ?? 0;
}
