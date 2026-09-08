/**
 * [C-164] 확인 요청서 — 사람이 읽는 요약이 **판정과 어긋나지 않는지**를 잰다.
 *
 * 이 문서의 위험은 "안 예쁜 것"이 아니라 **요약이 원문과 다른 말을 하는 것**이다.
 * 그래서 판정 토큰·Critical 개수는 게이트/비평 루프가 쓰는 **같은 추출기**로만 만든다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCheckpointReport } from "./checkpointReport.js";

function fixture(): string {
  const root = join(tmpdir(), `c164-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(root, "docs"), { recursive: true });
  return root;
}

const BASE = {
  project: "p",
  stage: "idea-validation",
  stageNo: 1,
  stageTotal: 4,
  checkpointId: "abc123",
  at: "2026-01-01T00:00:00.000Z",
  seeds: [{ agent_id: "pm", line: "pm: 범위를 둘로 줄였다" }],
};

test("[C-164] 판정 토큰을 게이트와 **같은 어휘**로 읽는다", () => {
  const root = fixture();
  writeFileSync(join(root, "docs/06_CEO_DECISION.md"), "# x\n\n## Decision\n\n- 검증\n", "utf8");
  const md = buildCheckpointReport(root, {
    ...BASE,
    artifacts: [{ path: "docs/06_CEO_DECISION.md", size: 30 }],
  });
  assert.match(md, /CEO 판정: \*\*검증\*\*/);
  rmSync(root, { recursive: true, force: true });
});

test("[C-164] Critical 개수가 비평 루프가 세는 것과 같다", () => {
  const root = fixture();
  writeFileSync(
    join(root, "docs/05_RED_TEAM.md"),
    "# x\n\n## Risks\n\n### Critical\n\n- 하나\n- 둘\n\n### High\n\n- 셋\n",
    "utf8",
  );
  const md = buildCheckpointReport(root, { ...BASE, artifacts: [{ path: "docs/05_RED_TEAM.md", size: 50 }] });
  assert.match(md, /Critical 리스크: \*\*2건\*\*/, "High를 Critical로 세면 안 된다");
  assert.match(md, /^1\. 하나$/m);
  assert.match(md, /^2\. 둘$/m);
  assert.doesNotMatch(md, /셋/, "High가 목록에 섞였다");
  rmSync(root, { recursive: true, force: true });
});

test("[C-164] 판정 문서가 없는 단계에서도 거짓말하지 않는다", () => {
  const root = fixture();
  const md = buildCheckpointReport(root, { ...BASE, stage: "dev-handoff", artifacts: [] });
  assert.match(md, /판정 문서가 없다/, "없는 판정을 지어내면 안 된다");
  assert.match(md, /Critical 리스크: \*\*0건\*\*/);
  rmSync(root, { recursive: true, force: true });
});

test("[C-164] 승인·되돌림 명령을 **그대로 실행 가능하게** 적는다 (id·프로젝트 포함)", () => {
  const root = fixture();
  const md = buildCheckpointReport(root, { ...BASE, artifacts: [] });
  assert.match(md, /harness pipeline approve idea-validation --checkpoint abc123 --project p/);
  assert.match(md, /harness pipeline reject idea-validation --checkpoint abc123 --project p --note/);
  rmSync(root, { recursive: true, force: true });
});

test("[C-164] 요약임을 명시하고 checkpoint id를 박는다 — 낡은 보고서를 알아볼 수 있어야 한다", () => {
  const root = fixture();
  const md = buildCheckpointReport(root, { ...BASE, artifacts: [] });
  assert.match(md, /승인 대상 자체가 아니다/, "요약을 승인 대상으로 오해하게 두면 안 된다");
  assert.match(md, /checkpoint `abc123`/);
  rmSync(root, { recursive: true, force: true });
});

test("[C-164] 담당별 판단을 **자르지 않는다** — 조용한 절단은 이 레포의 금지 사항이다", () => {
  const root = fixture();
  const long = "가".repeat(3000);
  const md = buildCheckpointReport(root, {
    ...BASE,
    seeds: [{ agent_id: "pm", line: `pm: ${long}` }],
    artifacts: [],
  });
  assert.ok(md.includes(long), "판단이 잘렸다");
  rmSync(root, { recursive: true, force: true });
});
