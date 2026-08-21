/**
 * mock 실행 provider. 실제 claude 호출 없이 미리 정해진 이벤트 시퀀스를 재생한다.
 * 기존 사고 계층 mockProvider 철학(오프라인·무과금·acceptance 기반)을 실행 계층에도 적용.
 * 오케스트레이터 상태머신/게이트 로직을 토큰 소모 없이 테스트하는 용도.
 */
import type { ExecutionProvider, SessionEvent, SessionHandle, SessionSpec } from "./types.js";
import { AsyncEventQueue } from "./eventQueue.js";

/** sessionId를 채워 넣어 스크립트 이벤트를 만드는 헬퍼(테스트에서 커스텀 시나리오 주입용). */
export type EventScript = (spec: SessionSpec, prompt: string) => SessionEvent[];

/** 기본 스크립트: init → assistant(짧은 응답) → result(성공). */
const defaultScript: EventScript = (spec, prompt) => {
  const sid = spec.sessionId;
  const raw = { type: "mock", session_id: sid } as const;
  return [
    { kind: "init", sessionId: sid, model: spec.model ?? "mock", cwd: spec.cwd, permissionMode: spec.permissionMode ?? "acceptEdits", tools: [], mcpServers: [], raw: { ...raw } },
    { kind: "assistant", sessionId: sid, text: `mock 응답: ${prompt.slice(0, 40)}`, toolUses: [], stopReason: "end_turn", raw: { ...raw } },
    {
      kind: "result",
      sessionId: sid,
      isError: false,
      text: "ok",
      numTurns: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      totalCostUsd: 0,
      stopReason: "end_turn",
      permissionDenials: [],
      raw: { ...raw },
    },
  ];
};

interface MockState {
  queue: AsyncEventQueue<SessionEvent>;
  spec: SessionSpec;
}

export class MockExecProvider implements ExecutionProvider {
  readonly id = "mock-exec";
  private sessions = new Map<string, MockState>();

  constructor(private script: EventScript = defaultScript) {}

  async start(spec: SessionSpec, initialPrompt: string): Promise<SessionHandle> {
    const queue = new AsyncEventQueue<SessionEvent>();
    this.sessions.set(spec.sessionId, { queue, spec });
    this.replay(spec.sessionId, initialPrompt);
    return { sessionId: spec.sessionId, spec };
  }

  async send(handle: SessionHandle, message: string): Promise<void> {
    const st = this.sessions.get(handle.sessionId);
    if (!st) throw new Error(`mock-exec: 없는 세션 ${handle.sessionId}`);
    // 새 invocation용 큐로 교체 (한 invocation = 한 result)
    st.queue = new AsyncEventQueue<SessionEvent>();
    this.replay(handle.sessionId, message);
  }

  events(handle: SessionHandle): AsyncIterable<SessionEvent> {
    const st = this.sessions.get(handle.sessionId);
    if (!st) throw new Error(`mock-exec: 없는 세션 ${handle.sessionId}`);
    return st.queue;
  }

  async stop(handle: SessionHandle): Promise<void> {
    const st = this.sessions.get(handle.sessionId);
    st?.queue.close();
    this.sessions.delete(handle.sessionId);
  }

  private replay(sessionId: string, prompt: string): void {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    const events = this.script(st.spec, prompt);
    for (const e of events) st.queue.push(e);
    st.queue.close();
  }
}
