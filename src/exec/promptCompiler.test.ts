/**
 * PromptCompiler 단위 테스트 (무과금). readFile 주입으로 fs 없이 검증.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePrompt } from "./promptCompiler.js";
import type { SessionSpec } from "./types.js";

const spec: SessionSpec = {
  sessionId: "s1",
  role: "프론트엔드 — 신호등 리포트 화면",
  task: "주소 입력→신호등 요약 화면 구현",
  cwd: "/wt",
  ownership: ["src/app/**"],
  forbidden: ["API_CONTRACT 변경"],
  inputs: ["docs/API_CONTRACT.md", "docs/02_PRD.md", "docs/03_UX.md"],
  dod: ["화면 렌더", "단위 테스트 통과"],
};

const files: Record<string, string> = {
  "/proj/docs/API_CONTRACT.md": "GET /api/report → { grade }",
};
const deps = { projectRoot: "/proj", readFile: (p: string) => files[p] ?? null };

test("API_CONTRACT는 전문 인라인", () => {
  const out = compilePrompt(spec, deps);
  assert.ok(out.includes("GET /api/report → { grade }"), "계약 전문 포함");
  assert.ok(out.includes("API 계약"));
});

test("배경 문서(PRD/UX)는 경로만, 전문 인라인 아님", () => {
  const out = compilePrompt(spec, deps);
  assert.ok(out.includes("docs/02_PRD.md"), "PRD 경로 표시");
  assert.ok(/Read로 열어/.test(out), "Read 지시 존재");
  assert.ok(!out.includes("<<< docs/02_PRD.md >>>"), "PRD 전문 인라인 아님");
});

test("역할·ownership·forbidden·DoD·STATUS 계약 포함", () => {
  const out = compilePrompt(spec, deps);
  assert.ok(out.includes("신호등 리포트 화면"));
  assert.ok(out.includes("src/app/**"));
  assert.ok(out.includes("API_CONTRACT 변경"));
  assert.ok(out.includes("단위 테스트 통과"));
  assert.ok(out.includes("STATUS: RUNNING"));
});

test("task 없으면 role로 대체", () => {
  const out = compilePrompt({ ...spec, task: undefined }, deps);
  assert.ok(out.startsWith("# 태스크\n프론트엔드"));
});

test("계약 파일 못 찾으면 안내 문구", () => {
  const out = compilePrompt(spec, { projectRoot: "/none", readFile: () => null });
  assert.ok(out.includes("찾지 못함"));
});
