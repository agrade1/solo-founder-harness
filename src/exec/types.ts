/**
 * 실행 계층 타입 (EXECUTION_LAYER_ARCH §1·§3, EXECUTION_CLI_RECON §3 기반).
 * SessionEvent는 claude -p stream-json 이벤트를 오케스트레이터가 쓰는 형태로 정규화한 것.
 * 파서·provider·오케스트레이터가 공유한다.
 */

/** stream-json 한 줄을 파싱한 원본 객체 (정규화 전). 알 수 없는 필드 보존용. */
export interface RawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  [k: string]: unknown;
}

/** 토큰 사용량 (result.usage 기준). 기존 Provider.TokenUsage와 정합. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** assistant 메시지 안의 도구 호출 1건. */
export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

/**
 * 정규화된 세션 이벤트. RECON §3 이벤트 타입을 오케스트레이터 관심사로 매핑.
 * 모든 변형은 원본 접근용 `raw`를 들고 있다.
 */
export type SessionEvent =
  | { kind: "init"; sessionId: string; model: string; cwd: string; permissionMode: string; tools: string[]; raw: RawEvent }
  | { kind: "assistant"; sessionId: string; text: string; toolUses: ToolUse[]; stopReason: string | null; raw: RawEvent }
  | { kind: "delta"; sessionId: string; event: unknown; raw: RawEvent } // stream_event (Anthropic SSE 델타)
  | { kind: "status"; sessionId: string; status: string; raw: RawEvent }
  | { kind: "hook"; sessionId: string; phase: "started" | "progress" | "response"; hookName?: string; outcome?: string; exitCode?: number; raw: RawEvent }
  | { kind: "rateLimit"; sessionId: string; status: string; rateLimitType: string; resetsAt: number; overageStatus?: string; isUsingOverage?: boolean; raw: RawEvent }
  | { kind: "result"; sessionId: string; isError: boolean; text: string; numTurns: number; usage: SessionUsage; totalCostUsd: number; stopReason?: string; terminalReason?: string; permissionDenials: unknown[]; raw: RawEvent }
  | { kind: "unknown"; type: string; subtype?: string; sessionId?: string; raw: RawEvent };

/** result 이벤트인지 (= 한 invocation의 종료 신호). */
export function isTerminal(e: SessionEvent): e is Extract<SessionEvent, { kind: "result" }> {
  return e.kind === "result";
}

/**
 * 세션 실행 명세. ARCH §3.1 SessionSpec + provider 실행에 필요한 런타임 필드.
 * (오케스트레이터가 task-prompt/SPAWN에서 산출 → provider가 CLI 인자로 컴파일)
 */
export interface SessionSpec {
  sessionId: string; // 사전 할당 UUID (--session-id). 미지정 시 provider가 init에서 취득
  role: string; // 역할 설명 → --append-system-prompt
  model?: string; // --model (기본 정책 B: opus). 미지정 시 provider 기본
  fallbackModel?: string; // --fallback-model (강등 사다리 CLI 자동 폴백)
  cwd: string; // 세션 작업 디렉토리 (worktree). 절대경로
  allowedTools?: string[]; // --allowedTools 화이트리스트 (권한 컴파일러 산출)
  disallowedTools?: string[]; // --disallowedTools
  addDirs?: string[]; // --add-dir (worktree 밖 읽기 허용 경로)
  permissionMode?: string; // --permission-mode (기본 acceptEdits)
  budget?: { maxTurns?: number }; // max_turns = 오케스트레이터가 assistant 이벤트로 강제 (CLI 플래그 아님, RECON §2.1)
}

/** provider가 반환하는 세션 핸들. provider별 내부 상태는 provider가 따로 보관. */
export interface SessionHandle {
  readonly sessionId: string;
  readonly spec: SessionSpec;
}

/**
 * 실행 provider 추상화 (ARCH §1). claude CLI 헤드리스가 기본 구현,
 * mockExecProvider가 테스트/오프라인 대체. (사고 계층 Provider와 별개 — 이쪽은 파일을 실제 편집)
 */
export interface ExecutionProvider {
  readonly id: string;
  /** 세션 생성 + 초기 지시 실행. */
  start(spec: SessionSpec, initialPrompt: string): Promise<SessionHandle>;
  /** 후속 지시 주입 (resume). */
  send(handle: SessionHandle, message: string): Promise<void>;
  /** 현재 invocation의 이벤트 스트림. result에서 종료. */
  events(handle: SessionHandle): AsyncIterable<SessionEvent>;
  /** 세션 강제 종료. */
  stop(handle: SessionHandle, reason: string): Promise<void>;
}
