/**
 * ToolProfile ↔ run 통합 (fail-fast) + mock 회귀(golden snapshot) 테스트.
 * HARNESS_WORKSPACE는 test:core 스크립트가 .tmp-test-workspace로 지정한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runWorkflow, loadRunState, type RunState } from "./runWorkflow.js";
import { projectPaths } from "./project.js";
import { mockProvider } from "../providers/mockProvider.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "..", "..", "tests", "fixtures", "golden", "idea-validation.run_state.json");
const FIXED = "2026-01-01T00:00:00.000Z";

function makeProject(name: string): void {
  const paths = projectPaths(name);
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.docs, { recursive: true });
  mkdirSync(paths.outputs, { recursive: true });
  writeFileSync(join(paths.docs, "00_IDEA.md"), "# idea\n\n## 아이디어 한 줄 정의\n\n- 테스트\n", "utf8");
}

/** 가변 메타데이터(프로젝트명·타임스탬프·경과시간) 제거 → 결정적 비교용. */
function normalize(s: RunState): RunState {
  return {
    ...s,
    project: "PROJECT",
    started_at: FIXED,
    finished_at: FIXED,
    step_timings: s.step_timings.map((t) => ({ ...t, started_at: FIXED, elapsed_ms: 0 })),
  };
}

// ── run 통합 fail-fast ─────────────────────────────────────────
test("run fail-fast: planning-local-readonly + mock → 시작 전 오류, run_state 미생성", async () => {
  makeProject("_t_tp_ro");
  await assert.rejects(
    runWorkflow({ workflowId: "idea-validation", project: "_t_tp_ro", provider: mockProvider, toolProfileId: "planning-local-readonly", now: () => FIXED }),
    /내장 도구|미지원/,
  );
  assert.equal(loadRunState("_t_tp_ro"), null, "fail-fast는 run_state를 만들지 않는다");
});

test("run: planning-none + mock → binding 없음, 정상 완주", async () => {
  makeProject("_t_tp_none");
  const r = await runWorkflow({ workflowId: "idea-validation", project: "_t_tp_none", provider: mockProvider, toolProfileId: "planning-none", now: () => FIXED });
  assert.equal(r.state.status, "completed");
});

test("run: 알 수 없는 tool profile → 오류", async () => {
  makeProject("_t_tp_bad");
  await assert.rejects(
    runWorkflow({ workflowId: "idea-validation", project: "_t_tp_bad", provider: mockProvider, toolProfileId: "no-such-profile", now: () => FIXED }),
    /tool profile/,
  );
});

// ── mock 회귀 (golden snapshot + 시맨틱) ────────────────────────
test("회귀: mock idea-validation run_state가 golden과 일치 (가변 메타 제거)", async () => {
  makeProject("_t_tp_golden");
  const r = await runWorkflow({ workflowId: "idea-validation", project: "_t_tp_golden", provider: mockProvider, now: () => FIXED });
  const actual = normalize(r.state);

  // 시맨틱 assertion
  assert.equal(actual.status, "completed");
  assert.deepEqual(actual.completed_steps, ["chief_of_staff", "research", "pm", "red_team", "founder_ceo"]);
  assert.equal(actual.provider, "mock");

  assert.ok(existsSync(GOLDEN), `golden 스냅샷이 없습니다: ${GOLDEN} (생성 후 커밋 필요)`);
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as RunState;
  assert.deepEqual(actual, golden, "정규화된 run_state가 golden과 동일 (M2 변경이 mock 출력을 바꾸지 않음)");
});
