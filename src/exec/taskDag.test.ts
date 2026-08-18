/**
 * V3 M9 T2 — Tech Lead task DAG 문서 검증. 로드맵 M9 완료 조건:
 * "DAG·ownership·contract가 닫힌 형태로 생성되고 kernel이 검증(순환·미상 의존·소유권 충돌 →
 *  fail-closed). 각 검증 제거 mutation → red"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OrchestrationError } from "./orchestrationTypes.js";
import { DAG_NODE_KEYS, TASK_DAG_CODES, TASK_DAG_SCHEMA_VERSION, validateTaskDag } from "./taskDag.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "no-error";
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${String(e)}`;
  }
}

function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: "impl-a",
    roleId: "dev-lead",
    title: "모듈 A 구현",
    scope: "src/a 안에서만 작업한다",
    ownership: ["src/a"],
    dependsOn: [],
    ...over,
  };
}

function doc(tasks: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: TASK_DAG_SCHEMA_VERSION, tasks };
}

/** 병렬 2 worker + 직렬 통합 — M9가 실제로 돌릴 모양. */
function pipelineDoc(): Record<string, unknown> {
  return doc([
    node({ taskId: "impl-a", ownership: ["src/a"], provides: ["src/a/index.ts"] }),
    node({ taskId: "impl-b", ownership: ["src/b"], provides: ["src/b/index.ts"] }),
    node({
      taskId: "integrate",
      roleId: "tech-lead",
      ownership: ["src/app"],
      dependsOn: ["impl-a", "impl-b"],
      consumes: ["src/a/index.ts", "src/b/index.ts"],
      provides: ["src/app/main.ts"],
    }),
  ]);
}

test("[M9] T2: 정상 DAG는 통과하고 정규화되어 돌아온다(병렬 2 + 직렬 통합)", () => {
  const out = validateTaskDag(pipelineDoc());
  // taskId 오름차순으로 굳는다 — 같은 문서면 항상 같은 결과다.
  assert.deepEqual(out.tasks.map((t) => t.taskId), ["impl-a", "impl-b", "integrate"]);
  assert.equal(out.schemaVersion, TASK_DAG_SCHEMA_VERSION);
  // 생략한 선택 필드는 빈 목록으로 굳는다(생략과 빈 배열이 같다).
  assert.deepEqual(out.tasks[0].consumes, []);
  assert.deepEqual(out.tasks[0].resourceClasses, []);
  assert.deepEqual(out.tasks[2].consumes, ["src/a/index.ts", "src/b/index.ts"]);
});

test("[M9] T2: 순환은 거부된다(문서는 여러 task를 한꺼번에 선언하므로 순환이 표현 가능하다)", () => {
  // 2-cycle
  assert.equal(
    codeOf(() =>
      validateTaskDag(
        doc([
          node({ taskId: "a", ownership: ["src/a"], dependsOn: ["b"] }),
          node({ taskId: "b", ownership: ["src/b"], dependsOn: ["a"] }),
        ]),
      ),
    ),
    "dependency_cycle",
  );
  // 3-cycle(간접) — 직접 간선만 보는 구현은 여기서 통과해 버린다.
  assert.equal(
    codeOf(() =>
      validateTaskDag(
        doc([
          node({ taskId: "a", ownership: ["src/a"], dependsOn: ["c"] }),
          node({ taskId: "b", ownership: ["src/b"], dependsOn: ["a"] }),
          node({ taskId: "c", ownership: ["src/c"], dependsOn: ["b"] }),
        ]),
      ),
    ),
    "dependency_cycle",
  );
  // 순환에 걸리지 않은 task가 함께 있어도 문서 전체가 거부된다(부분 통과 없음).
  assert.equal(
    codeOf(() =>
      validateTaskDag(
        doc([
          node({ taskId: "clean", ownership: ["src/z"] }),
          node({ taskId: "a", ownership: ["src/a"], dependsOn: ["b"] }),
          node({ taskId: "b", ownership: ["src/b"], dependsOn: ["a"] }),
        ]),
      ),
    ),
    "dependency_cycle",
  );
  assert.equal(codeOf(() => validateTaskDag(doc([node({ taskId: "a", dependsOn: ["a"] })]))), "self_dependency");
});

test("[M9] T2: 미상 의존은 거부된다(문서는 순서가 없으므로 전부 읽은 뒤에 본다)", () => {
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src/a"], dependsOn: ["ghost"] })]))),
    "unknown_dependency",
  );
  // **뒤에 선언된 task에 의존하는 것은 정상이다** — 이 대조군이 없으면 "전부 읽은 뒤에 본다"가
  // 공허해진다(선언 순서를 강요하는 구현도 위 단정만으로는 통과한다).
  const out = validateTaskDag(
    doc([
      node({ taskId: "later", ownership: ["src/l"], dependsOn: ["earlier"] }),
      node({ taskId: "earlier", ownership: ["src/e"] }),
    ]),
  );
  assert.deepEqual(out.tasks.map((t) => t.taskId), ["earlier", "later"]);
  assert.equal(codeOf(() => validateTaskDag(doc([node({ taskId: "a" }), node({ taskId: "a" })]))), "duplicate_task_id");
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src/a"], dependsOn: ["b", "b"] }), node({ taskId: "b", ownership: ["src/b"] })]))),
    "depends_on_duplicate",
  );
});

test("[M9] T2: 순서가 강제되지 않는 두 task의 소유권 겹침은 거부된다(조용한 덮어쓰기 예방)", () => {
  // 같은 경로.
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src/x"] }), node({ taskId: "b", ownership: ["src/x"] })]))),
    "ownership_conflict",
  );
  // 한쪽이 다른 쪽의 **하위 경로**여도 겹친다(정확히 같은 문자열만 보는 구현은 여기서 샌다).
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src"] }), node({ taskId: "b", ownership: ["src/x/y"] })]))),
    "ownership_conflict",
  );
  // 반대 방향도 같다(비교가 한 방향만이면 여기서 샌다).
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src/x/y"] }), node({ taskId: "b", ownership: ["src"] })]))),
    "ownership_conflict",
  );

  // **의존 사슬로 묶이면 충돌이 아니다**: 구현 → 수정이 같은 파일을 만지는 것은 정상이고, 이것을
  // 막으면 M9 파이프라인 자체가 성립하지 않는다.
  validateTaskDag(
    doc([
      node({ taskId: "impl", ownership: ["src/x"], provides: ["src/x/a.ts"] }),
      node({ taskId: "revise", ownership: ["src/x"], dependsOn: ["impl"], consumes: ["src/x/a.ts"] }),
    ]),
  );
  // **이행적** 의존도 순서를 강제한다(직접 간선만 보는 구현은 여기서 거부해 버린다).
  validateTaskDag(
    doc([
      node({ taskId: "impl", ownership: ["src/x"] }),
      node({ taskId: "review", roleId: "qa-security", ownership: ["src/r"], dependsOn: ["impl"] }),
      node({ taskId: "revise", ownership: ["src/x"], dependsOn: ["review"] }),
    ]),
  );
  // 배타 자원 class를 공유하면 kernel scheduler가 동시 실행을 막으므로 충돌이 아니다.
  validateTaskDag(
    doc([
      node({ taskId: "a", ownership: ["src/x"], resourceClasses: ["db"] }),
      node({ taskId: "b", ownership: ["src/x"], resourceClasses: ["db"] }),
    ]),
  );
});

test("[M9] T2: API contract — consumes는 이행적 의존이 provides한 것이어야 한다", () => {
  // 아무도 만들어 주지 않는 입력.
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src/a"], consumes: ["src/ghost.ts"] })]))),
    "consumes_unprovided",
  );
  // 만들어 주는 task가 있어도 **의존이 아니면** 순서가 없다 → 여전히 거부다.
  assert.equal(
    codeOf(() =>
      validateTaskDag(
        doc([
          node({ taskId: "maker", ownership: ["src/m"], provides: ["src/m/out.ts"] }),
          node({ taskId: "user", ownership: ["src/u"], consumes: ["src/m/out.ts"] }),
        ]),
      ),
    ),
    "consumes_unprovided",
  );
  // 이행적 의존이 만들어 주면 통과한다(대조군 — 위 규칙이 공허하지 않다).
  validateTaskDag(
    doc([
      node({ taskId: "maker", ownership: ["src/m"], provides: ["src/m/out.ts"] }),
      node({ taskId: "mid", roleId: "tech-lead", ownership: ["src/mid"], dependsOn: ["maker"] }),
      node({ taskId: "user", ownership: ["src/u"], dependsOn: ["mid"], consumes: ["src/m/out.ts"] }),
    ]),
  );
  // 디렉터리 단위 provides는 그 아래를 덮는다.
  validateTaskDag(
    doc([
      node({ taskId: "maker", ownership: ["src/m"], provides: ["src/m"] }),
      node({ taskId: "user", ownership: ["src/u"], dependsOn: ["maker"], consumes: ["src/m/deep/out.ts"] }),
    ]),
  );
  // **만들 수 없는 것을 만들겠다고 선언할 수 없다.**
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ taskId: "a", ownership: ["src/a"], provides: ["src/b/out.ts"] })]))),
    "provides_not_owned",
  );
});

test("[M9] T2: 문서는 닫힌 형태다 — 권한·명령·경로 형식을 문서가 고를 수 없다", () => {
  // 실행 권한을 문서가 만들 수 있으면 승인 manifest를 우회하는 두 번째 권위가 생긴다.
  for (const key of ["writableRoots", "operationAuthority", "allowedCommands", "executionAuthority", "command", "argv", "maxTokens", "expiresAt"]) {
    assert.equal(DAG_NODE_KEYS.includes(key as never), false, key);
    assert.equal(codeOf(() => validateTaskDag(doc([node({ [key]: "x" })]))), "invalid_dag_document", key);
  }
  // 최상위도 닫혀 있다.
  assert.equal(codeOf(() => validateTaskDag({ ...doc([node()]), extra: 1 })), "invalid_dag_document");
  assert.equal(codeOf(() => validateTaskDag(doc([node()]).tasks)), "invalid_dag_document");
  assert.equal(codeOf(() => validateTaskDag({ schemaVersion: "2", tasks: [node()] })), "invalid_dag_document");
  assert.equal(codeOf(() => validateTaskDag(doc([]))), "invalid_dag_document", "빈 DAG가 통과했다");
  // 필수 필드 부재.
  for (const key of ["taskId", "roleId", "title", "scope", "ownership", "dependsOn"]) {
    const n = node();
    delete n[key];
    assert.equal(codeOf(() => validateTaskDag(doc([n]))), "invalid_dag_document", key);
  }
  // role은 registry 안에서만 고른다(self-grant 경로 없음).
  assert.equal(codeOf(() => validateTaskDag(doc([node({ roleId: "god-mode" })]))), "unknown_role");
  // 소유 없는 task는 계획이 아니다 — kernel과 **같은 코드**로 거부된다(규칙을 두 곳에 두지 않는다).
  assert.equal(codeOf(() => validateTaskDag(doc([node({ ownership: [] })]))), "invalid_ownership");
});

test("[M9] T2: 경로는 정확한 바이트여야 한다(미정규화·traversal·절대경로·surrogate 거부)", () => {
  // ownership은 kernel과 같은 계약(`normalizeOwnership`)을 쓰되 **이미 정규화된 형태**만 받는다 —
  // `src/./a`는 kernel이라면 조용히 고치지만 계약 문서에서는 거부다(같은 경로의 두 표기 금지).
  for (const bad of ["/etc/passwd", "../evil", "src/./a", "src//a", "a\0b", "src/\ud800"]) {
    assert.notEqual(codeOf(() => validateTaskDag(doc([node({ ownership: [bad] })]))), "no-error", bad);
  }
  for (const bad of ["/etc/passwd", "../evil", "src/a/./x", "x\0y"]) {
    assert.equal(codeOf(() => validateTaskDag(doc([node({ provides: [bad] })]))), "invalid_dag_document", bad);
  }
  assert.equal(codeOf(() => validateTaskDag(doc([node({ provides: ["src/a/x", "src/a/x"] })]))), "invalid_dag_document");
});

test("[M9] T2: resourceClasses는 kernel과 같은 계약이다(중복은 문서 단계에서 죽고 정렬돼 돌아온다)", () => {
  // T2 적대적 리뷰 C-1(fail-late): 이전 판은 자체 목록 검증이라 중복이 문서를 통과하고 물질화에서
  // 늦게 터졌다. "통과하면 정규화된 문서"라는 주장과 어긋난다.
  assert.equal(
    codeOf(() => validateTaskDag(doc([node({ resourceClasses: ["db", "db"] })]))),
    "resource_class_duplicate",
  );
  const out = validateTaskDag(doc([node({ resourceClasses: ["zeta", "alpha"] })]));
  assert.deepEqual(out.tasks[0].resourceClasses, ["alpha", "zeta"], "사전순으로 굳지 않았다");
});

test("[M9] T2: 오류 코드는 닫힌 목록이다", () => {
  const seen = new Set<string>();
  const cases: Record<string, unknown>[][] = [
    [node({ taskId: "a" }), node({ taskId: "a" })],
    [node({ dependsOn: ["ghost"] })],
    [node({ dependsOn: ["impl-a"] })],
    [node({ taskId: "a", ownership: ["src/a"], dependsOn: ["b"] }), node({ taskId: "b", ownership: ["src/b"], dependsOn: ["a"] })],
    [node({ taskId: "a", ownership: ["src/x"] }), node({ taskId: "b", ownership: ["src/x"] })],
    [node({ provides: ["src/other/x"] })],
    [node({ consumes: ["src/ghost"] })],
    [node({ dependsOn: ["b", "b"] }), node({ taskId: "b", ownership: ["src/b"] })],
    [node({ nope: 1 })],
  ];
  for (const tasks of cases) seen.add(codeOf(() => validateTaskDag(doc(tasks))));
  seen.delete("no-error");
  for (const c of seen) {
    assert.ok((TASK_DAG_CODES as readonly string[]).includes(c), `닫힌 목록 밖 코드: ${c}`);
  }
  assert.ok(seen.size >= 8, `코드 커버리지가 얕다: ${[...seen].join(",")}`);
});
