/**
 * 미션 브리프 생성기 (ARCH §6.1). 자유 목표를 오케스트레이터(Opus)가 개발 태스크로 분해한다.
 * 사람은 이 브리프를 승인(시작 전 유일한 게이트)하고, runMission이 자율 실행한다.
 *
 * 태스크 파싱은 순수(parseTasks) — 단위 테스트는 mock provider로 무과금 검증.
 */
import type { ExecutionProvider, SessionSpec, SessionUsage } from "./types.js";
import type { MissionBrief, MissionTask } from "./mission.js";

const MAX_TASKS_DEFAULT = 8; // ARCH §6.3 미션 크기 가드

export function buildBriefPrompt(goal: string, maxTasks: number): string {
  return [
    "# 역할\n너는 솔로 창업자의 미션 오케스트레이터다. 아래 목표를 develop에 병합 가능한 개발 태스크로 분해하라.",
    `# 목표\n${goal}`,
    [
      "# 규칙",
      `- 태스크는 최대 ${maxTasks}개. 하나의 목표가 하룻밤에 끝날 크기로.`,
      "- 각 태스크는 독립 세션이 자기 worktree/브랜치에서 구현한다. 담당 경로(ownership)로 충돌을 예방하라.",
      "- 의존이 있으면 deps에 선행 태스크 id를 넣어라.",
      "- 각 태스크에 테스트 포함 DoD를 명시하라.",
      "- difficulty는 hard|simple (단순 구현은 simple — 모델 강등 시 Sonnet 라우팅됨).",
    ].join("\n"),
    [
      "# 출력 형식",
      "설명 없이 아래 JSON 배열만 ```json 코드펜스 안에 출력하라. 각 원소:",
      '{ "id": "kebab-id", "role": "짧은 역할", "task": "구체 작업", "ownership": ["src/..."], "dod": ["...", "테스트 통과"], "difficulty": "hard|simple", "deps": ["선행 id"] }',
    ].join("\n"),
  ].join("\n\n");
}

/** 결과 텍스트에서 JSON 배열을 뽑아 MissionTask[]로 파싱. */
export function parseTasks(raw: string): MissionTask[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) text = fence[1].trim();
  else {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error(`브리프 JSON 파싱 실패. 원문 앞부분: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(arr)) throw new Error("브리프가 배열이 아님");
  /**
   * [C-155] **형태 오류를 조용히 버리지 않는다.** 예전 판은 배열이 아니면 `undefined`,
   * 배열이면 비-문자열 원소를 걸러 냈다. `deps`에서 그것은 **의미가 바뀌는** 처리다:
   * `deps: "task-a"`(스칼라)가 `undefined`가 되고 스케줄러 둘(`mission.ts`의 `task.deps?.some` ·
   * `parallelMission.ts`의 `(t.deps ?? []).every`)이 **의존성 없음**으로 읽어 선행 완료 전에
   * 실행한다 — 병렬 모드에선 자동 병합까지 간다. 원소 하나가 사라지는 것도 같은 사고다.
   *
   * `id`/`role`/`task`가 이미 타입 오류에서 throw하므로 이쪽만 무음이던 것이 비대칭이었다.
   */
  const asStrings = (v: unknown, i: number, field: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) throw new Error(`태스크[${i}] ${field}는 문자열 배열이어야 합니다 (받은 값: ${JSON.stringify(v)})`);
    for (const x of v) {
      if (typeof x !== "string") throw new Error(`태스크[${i}] ${field}에 문자열이 아닌 원소가 있습니다: ${JSON.stringify(x)}`);
    }
    return v as string[];
  };

  const tasks = arr.map((t, i) => {
    const o = t as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.role !== "string" || typeof o.task !== "string") {
      throw new Error(`태스크[${i}] 필수 필드(id/role/task) 누락`);
    }
    return {
      id: o.id,
      role: o.role,
      task: o.task,
      ownership: asStrings(o.ownership, i, "ownership"),
      dod: asStrings(o.dod, i, "dod"),
      deps: asStrings(o.deps, i, "deps"),
      difficulty: o.difficulty === "simple" ? "simple" : o.difficulty === "hard" ? "hard" : undefined,
    } as MissionTask;
  });

  // [C-155] 없는 id를 가리키는 deps는 여기서 이름을 대고 멈춘다. 스케줄러는 이미 fail closed라
  // (미지 id는 영원히 미충족 → dep_unmet) **일찍 실행되지는 않지만**, 오타 하나가 mission 전체를
  // 말없이 보류로 만든다. 순환은 검사하지 않는다 — 같은 이유로 스케줄러가 dep_unmet으로 닫고,
  // 검사를 더해도 막는 사고가 없다(YAGNI).
  const ids = new Set(tasks.map((t) => t.id));
  for (const [i, t] of tasks.entries()) {
    for (const d of t.deps ?? []) {
      if (!ids.has(d)) throw new Error(`태스크[${i}] '${t.id}'의 deps가 없는 태스크를 가리킵니다: ${d}`);
    }
  }
  return tasks;
}

export interface GenerateBriefOpts {
  goal: string;
  provider: ExecutionProvider;
  sessionId: string;
  cwd: string;
  maxTasks?: number;
  model?: string; // 기본 opus (계획은 Opus 고정)
}

export interface GeneratedBrief {
  brief: MissionBrief;
  raw: string;
  usage: SessionUsage | null;
}

/** 목표 → 브리프. 플래너 세션 1회 실행 후 파싱. */
export async function generateBrief(opts: GenerateBriefOpts): Promise<GeneratedBrief> {
  const maxTasks = opts.maxTasks ?? MAX_TASKS_DEFAULT;
  const spec: SessionSpec = {
    sessionId: opts.sessionId,
    role: "미션 플래너 (목표 분해)",
    model: opts.model ?? "opus",
    cwd: opts.cwd,
    permissionMode: "plan",
  };
  const handle = await opts.provider.start(spec, buildBriefPrompt(opts.goal, maxTasks));
  let raw = "";
  let usage: SessionUsage | null = null;
  for await (const e of opts.provider.events(handle)) {
    if (e.kind === "result") {
      raw = e.text;
      usage = e.usage;
    }
  }
  const tasks = parseTasks(raw).slice(0, maxTasks);
  return { brief: { goal: opts.goal, tasks, degradeOnLimit: "auto" }, raw, usage };
}
