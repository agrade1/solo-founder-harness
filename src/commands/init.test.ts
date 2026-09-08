/**
 * `harness init`의 **아이디어 문서 인수** 검증 (무과금 · 파일 시스템만).
 *
 * 왜 이 테스트가 생겼나: 예전 `init`은 템플릿만 만들었고, 자기 아이디어를 쓰려면 사람이
 * `projects/<name>/docs/00_IDEA.md`로 **직접 복사**해야 했다. "작업 폴더에 문서 두고 설치해서
 * 실행"이라는 사용 모양에서 그 복사가 유일한 수작업이었다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInit } from "./init.js";
import { IDEA_REL, projectPaths } from "../core/project.js";
import { WORKSPACE_ROOT } from "../core/paths.js";

const CANDIDATES = ["docs/00_IDEA.md", "00_IDEA.md", "docs/idea.md", "idea.md", "docs/IDEA.md", "IDEA.md"];

/** 이 레포 루트에 후보 파일을 잠깐 만들었다 지운다 — 원래 있던 것은 건드리지 않는다. */
function withWorkspaceIdea<T>(rel: string, content: string, fn: () => T): T {
  const abs = join(WORKSPACE_ROOT, rel);
  assert.equal(existsSync(abs), false, `전제: ${rel}이 원래 없다 (있으면 이 테스트가 남의 파일을 지운다)`);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  try {
    return fn();
  } finally {
    rmSync(abs, { force: true });
  }
}

function quiet<T>(fn: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
}

function rmProject(name: string): void {
  rmSync(projectPaths(name).root, { recursive: true, force: true });
}

test("[C-162] 작업 폴더의 아이디어 문서를 templates 대신 담는다 — 후보 6종 전부", () => {
  for (const rel of CANDIDATES) {
    const name = "_init_adopt";
    rmProject(name);
    const body = `# idea\n\n## 아이디어 한 줄 정의\n\n- ${rel}에서 온 아이디어\n`;
    withWorkspaceIdea(rel, body, () => quiet(() => runInit(name)));
    const got = readFileSync(join(projectPaths(name).root, IDEA_REL), "utf8");
    assert.equal(got, body, `${rel}를 담지 않았다`);
    rmProject(name);
  }
});

test("[C-162] 원본을 옮기지 않고 복사한다 — init은 되돌릴 수 없는 일을 하지 않는다", () => {
  const name = "_init_copy";
  rmProject(name);
  const rel = "idea.md";
  const body = "# idea\n\n## 아이디어 한 줄 정의\n\n- 원본 보존 확인\n";
  withWorkspaceIdea(rel, body, () => {
    quiet(() => runInit(name));
    assert.equal(readFileSync(join(WORKSPACE_ROOT, rel), "utf8"), body, "원본이 사라지거나 바뀌었다");
  });
  rmProject(name);
});

test("[C-162] 이미 있는 프로젝트 아이디어를 덮어쓰지 않고, 무시했다는 사실을 말한다", () => {
  const name = "_init_nooverwrite";
  rmProject(name);
  quiet(() => runInit(name)); // 템플릿으로 먼저 만든다
  const before = readFileSync(join(projectPaths(name).root, IDEA_REL), "utf8");

  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    withWorkspaceIdea("idea.md", "# 완전히 다른 아이디어\n", () => runInit(name));
  } finally {
    console.log = log;
  }
  assert.equal(readFileSync(join(projectPaths(name).root, IDEA_REL), "utf8"), before, "기존 문서를 덮어썼다");
  const printed = out.join("\n");
  assert.match(printed, /담지 않았습니다/, "무시한 사실을 말하지 않았다 (조용한 무시 금지)");
  assert.match(printed, /\*\*다릅니다\*\*/, "내용이 다르다는 사실을 말하지 않았다");
  rmProject(name);
});

test("[C-162] 담았으면 '아이디어를 채우세요'라고 말하지 않는다 (함정 27)", () => {
  // red: 안내 분기를 빼면 문서를 이미 담아 놓고도 "채우세요"라고 지시한다 —
  //      사람이 다 된 일을 다시 하러 간다. 실제로 첫 구현이 그랬고 실물 실행에서 잡았다.
  const name = "_init_guidance";
  rmProject(name);
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    withWorkspaceIdea("idea.md", "# idea\n\n## 아이디어 한 줄 정의\n\n- 담긴다\n", () => runInit(name));
  } finally {
    console.log = log;
  }
  const printed = out.join("\n");
  assert.doesNotMatch(printed, /실제 아이디어로 채우세요/, "이미 담았는데 채우라고 지시했다");
  assert.match(printed, /한 번 확인하세요/, "확인하라고 말하지 않았다");
  assert.match(printed, /idea\.md에서 담은 내용 그대로/, "어디서 온 것인지 말하지 않았다");
  rmProject(name);
});

test("[C-162] 빈 파일은 후보가 아니다 — 템플릿보다 나을 것이 없다", () => {
  const name = "_init_empty";
  rmProject(name);
  withWorkspaceIdea("idea.md", "   \n\n", () => quiet(() => runInit(name)));
  const got = readFileSync(join(projectPaths(name).root, IDEA_REL), "utf8");
  assert.match(got, /여기에 아이디어를 한 문장으로 적는다/, "빈 파일을 담았다");
  rmProject(name);
});

test("[C-162] 아이디어 문서가 없으면 예전과 똑같이 템플릿을 만든다 (회귀 없음)", () => {
  const name = "_init_none";
  rmProject(name);
  quiet(() => runInit(name));
  const got = readFileSync(join(projectPaths(name).root, IDEA_REL), "utf8");
  assert.match(got, /^# 00_IDEA\.md — _init_none/, "템플릿이 아니다");
  rmProject(name);
});
