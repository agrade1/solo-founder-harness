/**
 * V3 M5c — **offline plan worker(데이터 전용 backend)** focused 테스트.
 *
 * 실행(파일 단독): `npx tsx --test src/exec/offlinePlanWorker.test.ts`
 * 네트워크·LLM·provider·프로세스 spawn·파일 쓰기 없이 돈다(무과금).
 *
 * 이 파일이 덮는 계약:
 * - 입력은 **닫힌 순수 데이터**다: 미상 key · symbol · 함수/callback · proxy · 이질 prototype 거부.
 * - JSON은 bounded UTF-8로 **정확히 한 번** 파싱되고 같은 닫힌 plan validator를 지나 **동결**된다.
 * - 스트림은 turn마다 **새로** 만들어지고 `started → progress ≥1 → terminal 정확히 1건 → 정상 종료`다.
 * - `claude`·`codex`를 포함한 미상 backend는 **안정 hard reject**다(live 추론 없음).
 * - worker 모듈은 파일 시스템·프로세스·네트워크·provider를 **import조차 하지 않는다**(소스 정적 확인).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, OrchestrationError } from "./orchestrationTypes.js";
import { MAX_WORKER_EVENTS, MAX_PROGRESS_STEP_CHARS, type WorkerEvent } from "./autopilotTypes.js";
import {
  MAX_OFFLINE_PLAN_EVENTS,
  MAX_PLAN_JSON_BYTES,
  OFFLINE_PLAN_BACKEND,
  OFFLINE_WORKER_INPUT_KEYS,
  WORKER_BINDING_KEYS,
  startOfflinePlanTurn,
} from "./offlinePlanWorker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING = { runId: "run-1", taskId: "root", attemptId: "att-1", turnId: "turn-1" };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof OrchestrationError ? e.code : `non-orchestration:${(e as Error).name}`;
  }
  return "no-error";
}

function planJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "1",
    ...BINDING,
    operations: [
      { operationId: "op-1", kind: "write_file", authorityId: "w-doc", path: "docs/out.md", content: "hello", expectedBeforeSha256: null },
      { operationId: "op-2", kind: "run_process", authorityId: "p-node" },
    ],
    result: { summary: "offline turn 결과", outputs: [{ path: "docs/out.md", role: "output" }] },
    ...over,
  });
}

function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { backend: OFFLINE_PLAN_BACKEND, planJson: planJson(), binding: { ...BINDING }, ...over };
}

async function collect(stream: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const out: WorkerEvent[] = [];
  for await (const e of stream) {
    out.push(e);
    assert.ok(out.length <= MAX_WORKER_EVENTS, "이벤트 상한을 넘었다");
  }
  return out;
}

// ── 1. 정상 turn과 프로토콜 ─────────────────────────────────────────────────

test("[M5c] started → progress ≥1 → terminal 정확히 1건 → 정상 종료", async () => {
  const events = await collect(startOfflinePlanTurn(input()));

  assert.equal(events[0].kind, "started");
  assert.equal(events.filter((e) => e.kind === "progress").length >= 1, true, "인정되는 진행 신호가 없다");
  const terminals = events.filter((e) => e.kind === "terminal");
  assert.equal(terminals.length, 1, "종료 이벤트가 정확히 1건이 아니다");
  assert.equal(events[events.length - 1].kind, "terminal", "종료 뒤에 이벤트가 더 있다");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i), "seq가 0부터 연속이 아니다");
  for (const e of events) {
    assert.equal(Object.isFrozen(e), true);
    if (e.kind === "progress") assert.ok(e.step.length <= MAX_PROGRESS_STEP_CHARS);
  }

  const terminal = terminals[0] as Extract<WorkerEvent, { kind: "terminal" }>;
  const plan = terminal.plan as any;
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.operations), true);
  assert.equal(Object.isFrozen(plan.operations[0]), true);
  assert.equal(Object.isFrozen(plan.result), true);
  assert.equal(plan.turnId, BINDING.turnId);
  assert.equal(plan.operations.length, 2);
  assert.deepEqual(terminal.usage, { inputTokens: 0, outputTokens: 0 });
});

test("[M5c] 최종 결과만 있는 스트림(silent_session)은 구조적으로 만들 수 없다", async () => {
  // operation이 0건이어도 진행 신호 1건은 반드시 나온다.
  const events = await collect(
    startOfflinePlanTurn(input({ planJson: planJson({ operations: [], result: { summary: "s", outputs: [] } }) })),
  );
  assert.deepEqual(events.map((e) => e.kind), ["started", "progress", "terminal"]);
  // 상한도 구조적으로 이벤트 상한 안이다.
  assert.equal(MAX_OFFLINE_PLAN_EVENTS, 3 + LIMITS.maxOperationsPerTurn);
  assert.ok(MAX_OFFLINE_PLAN_EVENTS <= MAX_WORKER_EVENTS);
});

test("[M5c] 스트림은 turn마다·소비마다 새로 만들어진다(상태가 새지 않는다)", async () => {
  const a = startOfflinePlanTurn(input());
  const b = startOfflinePlanTurn(input());
  const first = await collect(a);
  const second = await collect(a); // 같은 iterable을 다시 소비해도 처음부터다
  const other = await collect(b);
  assert.deepEqual(first.map((e) => [e.kind, e.seq]), second.map((e) => [e.kind, e.seq]));
  assert.deepEqual(first.map((e) => [e.kind, e.seq]), other.map((e) => [e.kind, e.seq]));
  // 두 turn의 iterator는 서로 독립이다(하나를 앞서 소비해도 다른 하나가 영향받지 않는다).
  const itA = a[Symbol.asyncIterator]();
  const itB = a[Symbol.asyncIterator]();
  assert.equal((await itA.next()).value.kind, "started");
  assert.equal((await itA.next()).value.kind, "progress");
  assert.equal((await itB.next()).value.kind, "started");
});

// ── 2. 입력은 데이터뿐이다 ──────────────────────────────────────────────────

test("[M5c] 입력에 callback·핸들·미상 key·symbol·이질 prototype을 밀반입할 수 없다", () => {
  const hostile: Array<[string, unknown]> = [
    ["accessor가 성공해도 데이터가 아니다", { backend: OFFLINE_PLAN_BACKEND, binding: { ...BINDING }, get planJson() { return planJson(); } }],
    ["binding accessor", input({ binding: { runId: "run-1", taskId: "root", attemptId: "att-1", get turnId() { return "turn-1"; } } })],
    ["Proxy(성공하는 trap)", new Proxy(input(), {})],
    ["binding이 Proxy", input({ binding: new Proxy({ ...BINDING }, {}) })],
    ["callback seam", input({ onEvent: () => undefined })],
    ["파일 시스템 객체", input({ fs: { writeFileSync: () => undefined } })],
    ["프로세스 spawn", input({ spawn: () => undefined })],
    ["provider 핸들", input({ provider: { name: "claude" } })],
    ["환경", input({ env: { PATH: "/tmp" } })],
    ["git", input({ git: "/usr/bin/git" })],
    ["누락 key", { backend: OFFLINE_PLAN_BACKEND, planJson: planJson() }],
    ["binding 여분 key", input({ binding: { ...BINDING, sessionId: "s-1" } })],
    ["binding 누락 key", input({ binding: { runId: "run-1", taskId: "root", attemptId: "att-1" } })],
    ["입력이 배열", [OFFLINE_PLAN_BACKEND, planJson()]],
    ["입력이 함수", () => input()],
    ["입력이 null", null],
    ["planJson이 함수", input({ planJson: () => planJson() })],
    ["planJson이 객체", input({ planJson: JSON.parse(planJson()) })],
  ];
  for (const [label, raw] of hostile) {
    assert.equal(codeOf(() => startOfflinePlanTurn(raw)), "worker_input_invalid", label);
  }

  // symbol key.
  const withSymbol: Record<string | symbol, unknown> = input();
  withSymbol[Symbol("smuggle")] = () => "authority";
  assert.equal(codeOf(() => startOfflinePlanTurn(withSymbol)), "worker_input_invalid");

  // 이질 prototype(클래스 인스턴스).
  class HostileInput {
    backend = OFFLINE_PLAN_BACKEND;
    planJson = planJson();
    binding = { ...BINDING };
    spawn(): void {
      /* 클래스 메서드는 prototype에 있으므로 own key로 보이지 않는다 — 그래서 prototype을 본다 */
    }
  }
  assert.equal(codeOf(() => startOfflinePlanTurn(new HostileInput())), "worker_input_invalid");

  // 모든 접근을 가로채는 proxy(값 대신 권위를 주려 한다).
  const proxy = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "backend") return OFFLINE_PLAN_BACKEND;
        throw new Error("boom");
      },
      ownKeys: () => [...OFFLINE_WORKER_INPUT_KEYS],
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: undefined }),
    },
  );
  assert.equal(codeOf(() => startOfflinePlanTurn(proxy)), "worker_input_invalid");

  // 던지는 getter는 **호출자가 고른 코드**가 아니라 안정 코드로 접힌다.
  assert.equal(
    codeOf(() =>
      startOfflinePlanTurn({
        backend: OFFLINE_PLAN_BACKEND,
        binding: { ...BINDING },
        get planJson(): string {
          throw new OrchestrationError("manifest_expired", "호출자가 고른 코드");
        },
      }),
    ),
    "worker_input_invalid",
  );
});

test("[M5c] 미상 backend와 live claude/codex 선택은 안정 hard reject다", () => {
  for (const backend of ["claude", "codex", "claude-code", "anthropic", "offline", "", "OFFLINE-PLAN", null, 1, {}]) {
    assert.equal(
      codeOf(() => startOfflinePlanTurn(input({ backend }))),
      "worker_backend_unsupported",
      JSON.stringify(backend),
    );
  }
  assert.equal(OFFLINE_PLAN_BACKEND, "offline-plan");
  assert.deepEqual([...OFFLINE_WORKER_INPUT_KEYS], ["backend", "planJson", "binding"]);
  assert.deepEqual([...WORKER_BINDING_KEYS], ["runId", "taskId", "attemptId", "turnId"]);
});

// ── 3. 바이트·UTF-8·파싱 경계 ───────────────────────────────────────────────

test("[M5c] 적대적 바이트 입양: species·iterator·constructor·proxy는 실행되지 않고 상한이 복사보다 먼저다", () => {
  // ⓐ **Proxy로 감싼 Uint8Array**: intrinsic 슬롯이 없으므로 trap이 돌아가기 전에 거부다.
  const proxied = new Proxy(Buffer.from(planJson(), "utf8"), {
    get() {
      throw new Error("trap이 돌았다");
    },
  });
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: proxied }))), "worker_input_invalid");
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: new Proxy(Buffer.from(planJson(), "utf8"), {}) }))), "worker_input_invalid");

  // ⓑ **`Symbol.species`가 호출자 코드인 subclass**: 그 코드가 실행되지 않는다(예전 판은 `slice`가 읽었다).
  let speciesReads = 0;
  class HostileBytes extends Uint8Array {
    static get [Symbol.species](): typeof Uint8Array {
      speciesReads += 1;
      throw new OrchestrationError("manifest_expired", "species-secret");
    }
  }
  const bytes = Buffer.from(planJson(), "utf8");
  const hostile = new HostileBytes(bytes.length);
  hostile.set(bytes);
  // subclass는 intrinsic tag가 `Uint8Array`이므로 **데이터로서는 유효하다** — 계획이 그대로 나온다.
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: hostile }))), "no-error");
  assert.equal(speciesReads, 0, "Symbol.species 호출자 코드가 실행됐다");

  // ⓒ **oversized는 할당·복사보다 먼저** 거부된다(원본 바이트를 만지지 않는다).
  const over = new Uint8Array(MAX_PLAN_JSON_BYTES + 1);
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: over }))), "worker_plan_too_large");
  class OversizedHostile extends Uint8Array {
    static get [Symbol.species](): typeof Uint8Array {
      speciesReads += 1;
      throw new Error("species");
    }
  }
  assert.equal(
    codeOf(() => startOfflinePlanTurn(input({ planJson: new OversizedHostile(MAX_PLAN_JSON_BYTES + 1) }))),
    "worker_plan_too_large",
  );
  assert.equal(speciesReads, 0);

  // ⓓ **잘못된 원소 폭**(Uint16Array 등)과 typed array가 아닌 값은 데이터 입력이 아니다.
  for (const bad of [new Uint16Array(4), new Int8Array(4), new DataView(new ArrayBuffer(4)), new ArrayBuffer(4), { byteLength: 4 }]) {
    assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: bad }))), "worker_input_invalid", String(bad));
  }

  // ⓔ **detached buffer**: intrinsic 길이가 0이고 view 생성이 실패하므로 안정 거부다(바이트를 읽지 않는다).
  const ab = new ArrayBuffer(8);
  const detachedView = new Uint8Array(ab);
  structuredClone(ab, { transfer: [ab] });
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: detachedView }))), "worker_input_invalid");

  // ⓕ **resizable/growable buffer**(런타임이 지원할 때만): 길이를 확정한 뒤 줄어들면 안전하게 거부되고,
  //    안 줄어들면 그 시점 바이트가 정확히 복사된다.
  const resizable = new ArrayBuffer(bytes.length, { maxByteLength: bytes.length * 2 });
  new Uint8Array(resizable).set(bytes);
  const tracking = new Uint8Array(resizable);
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: tracking }))), "no-error");

  // ⓖ **Buffer**(pool view — byteOffset이 0이 아닐 수 있다)도 정확히 그 구간만 읽는다.
  const pooled = Buffer.from(planJson(), "utf8");
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: pooled }))), "no-error");
  const padded = Buffer.concat([Buffer.from("XX"), pooled, Buffer.from("YY")]).subarray(2, 2 + pooled.length);
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: padded }))), "no-error");
});

test("[M5c] SharedArrayBuffer 입력은 복사되므로 이후 caller 변경이 채택된 바이트를 바꾸지 못한다", async () => {
  const json = planJson();
  const source = Buffer.from(json, "utf8");
  const sab = new SharedArrayBuffer(source.length);
  const shared = new Uint8Array(sab);
  shared.set(source);

  const stream = startOfflinePlanTurn(input({ planJson: shared }));
  // 입양이 끝난 뒤 공유 메모리를 **전부 망가뜨린다**. alias를 들고 있었다면 여기서 계획이 깨진다.
  shared.fill(0x41);
  const events = await collect(stream);
  const terminal = events[events.length - 1] as Extract<WorkerEvent, { kind: "terminal" }>;
  assert.equal((terminal.plan as any).result.summary, "offline turn 결과");
  assert.equal((terminal.plan as any).operations.length, 2);
  // 스트림을 **다시** 소비해도 같다(원본을 다시 읽지 않는다 = alias 없음).
  const again = await collect(stream);
  assert.equal((again[again.length - 1] as any).plan.result.summary, "offline turn 결과");
});

test("[M5c] JSON 바이트 상한·UTF-8·파싱 실패는 안정 코드로 거부한다", () => {
  // 상한 초과(문자열·바이트 두 경로 모두).
  const huge = `${" ".repeat(MAX_PLAN_JSON_BYTES)}{}`;
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: huge }))), "worker_plan_too_large");
  assert.equal(
    codeOf(() => startOfflinePlanTurn(input({ planJson: new Uint8Array(MAX_PLAN_JSON_BYTES + 1) }))),
    "worker_plan_too_large",
  );
  // 잘못된 UTF-8은 U+FFFD로 조용히 바뀌지 않는다.
  assert.equal(
    codeOf(() => startOfflinePlanTurn(input({ planJson: Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]) }))),
    "worker_plan_not_utf8",
  );
  // 파싱 실패.
  for (const bad of ["", "{", "not json", "[1,2", '{"a":}']) {
    assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: bad }))), "worker_plan_unparsable", JSON.stringify(bad));
  }
  // 계획 자체가 계약 밖이면 같은 닫힌 validator의 안정 코드가 나온다.
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: JSON.stringify({ schemaVersion: "1" }) }))), "plan_invalid");
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: planJson({ taskId: "other" }) }))), "plan_invalid");
  assert.equal(codeOf(() => startOfflinePlanTurn(input({ planJson: planJson({ schemaVersion: "2" }) }))), "plan_invalid");
});

test("[M5c] UTF-8 바이트 입력도 문자열 입력과 같은 계획을 낸다(복사 후 원본 변경은 무시된다)", async () => {
  const bytes = Buffer.from(planJson(), "utf8");
  const stream = startOfflinePlanTurn(input({ planJson: bytes }));
  bytes.fill(0); // 입양 뒤 원본을 망가뜨려도 이미 파싱된 계획은 그대로다
  const events = await collect(stream);
  const terminal = events[events.length - 1] as Extract<WorkerEvent, { kind: "terminal" }>;
  assert.equal((terminal.plan as any).result.summary, "offline turn 결과");
});

// ── 4. worker에는 실행 권위가 없다(정적 확인) ───────────────────────────────

/** 한 모듈의 `import ... from "..."` 지정자를 모은다(정적 소스 확인 — 실행하지 않는다). */
function importSpecifiers(file: string): string[] {
  const source = readFileSync(join(HERE, file), "utf8");
  const out: string[] = [];
  for (const m of source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";$/gm)) out.push(m[1]);
  assert.equal(/require\(/.test(source), false, `${file}이 require를 쓴다`);
  return out;
}

const FORBIDDEN_IMPORTS = [
  "node:fs",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:worker_threads",
  "node:vm",
  "node:os",
  "node:path",
  "claudeCliProvider",
  "codexCliProvider",
  "sessionRunner",
  "parallelMission",
  "runProcess",
  "worktree",
  "orchestrationStore",
  "orchestrationKernel",
  "typedExecution",
];

test("[M5c] worker의 **transitive** import 그래프에 파일 시스템·프로세스·네트워크·provider가 없다", () => {
  // 이전 판은 `typedExecution`을 지나 `node:fs`와 store 모듈을 transitive하게 끌어왔다(리뷰 C 항목).
  // 지금은 순수 validator 모듈(`typedPlan`)로 갈라졌으므로 **그래프 전체를 닫아서** 확인할 수 있다.
  const seen = new Set<string>();
  const queue = ["offlinePlanWorker.ts"];
  const allowedExternal = new Set(["node:util/types"]);
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecifiers(file)) {
      for (const f of FORBIDDEN_IMPORTS) {
        assert.equal(spec.includes(f), false, `${file}이 ${f}를 import한다`);
      }
      if (spec.startsWith("./")) {
        queue.push(spec.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
        continue;
      }
      // 외부 지정자는 **명시적 허용 목록**만 통과한다(introspection 전용).
      assert.equal(allowedExternal.has(spec), true, `${file}이 허용되지 않은 외부 모듈을 import한다: ${spec}`);
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ["autopilotTypes.ts", "offlinePlanWorker.ts", "orchestrationTypes.ts", "typedPlan.ts"],
    "worker의 transitive 그래프가 바뀌었다",
  );
});
