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
  return arr.map((t, i) => {
    const o = t as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.role !== "string" || typeof o.task !== "string") {
      throw new Error(`태스크[${i}] 필수 필드(id/role/task) 누락`);
    }
    const asStrings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
    return {
      id: o.id,
      role: o.role,
      task: o.task,
      ownership: asStrings(o.ownership),
      dod: asStrings(o.dod),
      deps: asStrings(o.deps),
      difficulty: o.difficulty === "simple" ? "simple" : o.difficulty === "hard" ? "hard" : undefined,
    } as MissionTask;
  });
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
